'use strict';
/**
 * Authentication & Role-Based Access Control Middleware
 *
 * Roles (mirroring DB enum user_role):
 *   PATIENT | PHARMACY_TECHNICIAN | PHARMACIST | DELIVERY_DRIVER
 *   PHARMACY_MANAGER | SYSTEM_ADMIN | REGULATORY_AUDITOR
 *
 * Key regulatory principle enforced here:
 *   - Pharmacy Technicians (RPhT) CANNOT make final clinical decisions
 *   - Pharmacists (RPh) must verify/approve any controlled substance Rx
 *   - Regulatory auditors are READ-ONLY
 */

const jwt            = require('jsonwebtoken');
const pool           = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');
const logger         = require('../utils/logger');

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h'; // max shift length

if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

// ── Token generation ──────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    {
      id:   user.id,
      role: user.role,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES, issuer: 'pharmacy-delivery-api' }
  );
}

// ── Verify JWT & attach user to req ──────────────────────────────────────────

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { issuer: 'pharmacy-delivery-api' });
  } catch (err) {
    await writeAuditEvent({
      action: 'AUTH_TOKEN_INVALID', req,
      success: false, failureReason: err.message,
    });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Confirm user is still active and not locked
  const { rows } = await pool.query(
    'SELECT id, role, email, is_active, is_locked, failed_login_count FROM users WHERE id = $1',
    [decoded.id]
  );
  if (!rows.length || !rows[0].is_active || rows[0].is_locked) {
    await writeAuditEvent({
      action: 'AUTH_ACCOUNT_INACTIVE', req, actorId: decoded.id,
      success: false, failureReason: 'Account inactive or locked',
    });
    return res.status(401).json({ error: 'Account inactive or locked' });
  }

  req.user = rows[0];
  next();
}

// ── Role guards ───────────────────────────────────────────────────────────────

/**
 * Require one of the supplied roles.
 * Usage: authorize('PHARMACIST', 'PHARMACY_MANAGER')
 */
function authorize(...roles) {
  return async (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      await writeAuditEvent({
        action: 'AUTHZ_DENIED', req,
        resourceType: 'route', resourceId: null,
        success: false,
        failureReason: `Role ${req.user?.role} not in [${roles.join(',')}]`,
      });
      return res.status(403).json({
        error: 'Insufficient privileges for this action',
        required: roles,
      });
    }
    next();
  };
}

// Convenience role checks
const isPharmacist     = authorize('PHARMACIST', 'PHARMACY_MANAGER', 'SYSTEM_ADMIN');
const isTechOrAbove    = authorize('PHARMACY_TECHNICIAN', 'PHARMACIST', 'PHARMACY_MANAGER', 'SYSTEM_ADMIN');
const isDriver         = authorize('DELIVERY_DRIVER');
const isPatient        = authorize('PATIENT');
const isAdmin          = authorize('SYSTEM_ADMIN');
const canReadAudit     = authorize('PHARMACIST', 'PHARMACY_MANAGER', 'SYSTEM_ADMIN', 'REGULATORY_AUDITOR');

/**
 * Ensure pharmacy technician license is ACTIVE before any clinical action.
 * Queries professional_licenses table.
 */
async function requireActiveLicense(req, res, next) {
  const role = req.user.role;
  if (!['PHARMACY_TECHNICIAN', 'PHARMACIST'].includes(role)) return next();

  const { rows } = await pool.query(
    `SELECT status, expiry_date, cdsa_authorised
     FROM professional_licenses
     WHERE user_id = $1
       AND province_code = $2
       AND status = 'ACTIVE'
       AND expiry_date >= CURRENT_DATE
     LIMIT 1`,
    [req.user.id, req.headers['x-pharmacy-province'] || 'ON']
  );

  if (!rows.length) {
    await writeAuditEvent({
      action: 'LICENSE_VERIFICATION_FAILED', req,
      success: false, failureReason: 'No active license found',
    });
    return res.status(403).json({
      error: 'Active professional license required. License may be expired, suspended, or not registered.',
    });
  }

  req.userLicense = rows[0];
  next();
}

/**
 * Guard specifically for controlled substance operations.
 * CDSA s.53: only persons authorized under the CDSA may handle controlled substances.
 * For pharmacy staff this means: licensed pharmacist or technician with cdsa_authorised flag.
 */
async function requireCDSAAuthorization(req, res, next) {
  if (!req.userLicense) {
    return res.status(403).json({ error: 'License check must precede CDSA authorization check' });
  }
  if (!req.userLicense.cdsa_authorised) {
    await writeAuditEvent({
      action: 'CDSA_AUTH_DENIED', req,
      isControlledSubstanceEvent: true,
      success: false,
      failureReason: 'User not CDSA-authorized for controlled substance handling',
    });
    return res.status(403).json({
      error: 'CDSA authorization required for this controlled substance operation',
      reference: 'Controlled Drugs and Substances Act (S.C. 1996, c. 19), s. 53',
    });
  }
  next();
}

module.exports = {
  signToken,
  authenticate,
  authorize,
  isPharmacist,
  isTechOrAbove,
  isDriver,
  isPatient,
  isAdmin,
  canReadAudit,
  requireActiveLicense,
  requireCDSAAuthorization,
};
