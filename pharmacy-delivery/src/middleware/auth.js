'use strict';
/**
 * @file middleware/auth.js
 * @description JWT authentication and role-based access control (RBAC) middleware.
 *
 * Every API request that touches patient data or pharmacy operations must pass
 * through `authenticate` first.  Role guards (`authorize`, `isPharmacist`, …)
 * are then composed on individual routes to enforce scope of practice.
 *
 * ─── User roles (mirrors DB enum `user_role`) ───────────────────────────────
 *   PATIENT              — registered patient; can view own Rxs and delivery orders
 *   PHARMACY_TECHNICIAN  — RPhT; performs intake, packing, double-count
 *   PHARMACIST           — RPh; mandatory final verification of all Rxs
 *   DELIVERY_DRIVER      — picks up and delivers orders; no clinical access
 *   PHARMACY_MANAGER     — RPh + administrative; assigns drivers, manages staff
 *   SYSTEM_ADMIN         — technical admin; full access
 *   REGULATORY_AUDITOR   — read-only; Health Canada / College inspector
 *
 * ─── Key regulatory principles enforced here ────────────────────────────────
 *   • RPhT (PHARMACY_TECHNICIAN) CANNOT make final clinical decisions —
 *     all Rxs are routed to a pharmacist (NAPRA Model Standards s.3.0)
 *   • RPh (PHARMACIST) must verify/approve EVERY Rx before dispensing
 *     (CDSA s.31(1); NCR s.31; Food and Drugs Act s.9.1)
 *   • REGULATORY_AUDITOR role is strictly read-only — no write routes
 *   • All authorization failures are written to the immutable audit_log
 * ────────────────────────────────────────────────────────────────────────────
 */

const jwt            = require('jsonwebtoken');
const pool           = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');
const logger         = require('../utils/logger');

const JWT_SECRET  = process.env.JWT_SECRET;
// 8 h covers the longest pharmacy shift; tokens are short-lived by design
// to limit the blast radius of a stolen token
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

// Fail loudly at startup rather than silently issuing unsigned tokens
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

// ── Token generation ──────────────────────────────────────────────────────────

/**
 * Issue a signed JWT for an authenticated user.
 * The payload contains only non-sensitive identifiers; PHI is never embedded.
 * The `issuer` claim lets token verification reject tokens issued by other services.
 *
 * @param {object} user - row from the `users` table
 * @returns {string} signed JWT
 */
function signToken(user) {
  return jwt.sign(
    {
      id:    user.id,    // UUID — used to reload the user on each request
      role:  user.role,  // Stored so routes can do quick role checks without a DB round-trip
      email: user.email, // Included for client-side display only
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES, issuer: 'pharmacy-delivery-api' }
  );
}

// ── Verify JWT & attach user to req ──────────────────────────────────────────

/**
 * authenticate — Express middleware applied to every protected route.
 *
 * Steps:
 *  1. Extract Bearer token from Authorization header
 *  2. Verify token signature, expiry, and issuer claim
 *  3. Load fresh user row from DB to catch post-issue revocations
 *     (account lock, deactivation by admin)
 *  4. Attach user to req.user for downstream middleware and controllers
 *
 * All failures are written to the audit_log so that invalid token attempts
 * and locked-account access attempts are visible to compliance reviewers.
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7); // Remove "Bearer " prefix
  let decoded;
  try {
    // Throws if signature invalid, token expired, or issuer mismatch
    decoded = jwt.verify(token, JWT_SECRET, { issuer: 'pharmacy-delivery-api' });
  } catch (err) {
    // Log every token failure — suspicious patterns are detectable via audit_log
    await writeAuditEvent({
      action: 'AUTH_TOKEN_INVALID', req,
      success: false, failureReason: err.message,
    });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Re-query the DB on every request so that if an account is locked or
  // deactivated AFTER a token was issued, access is immediately blocked.
  // (JWTs are not revocable by default — this compensates for that.)
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

  // Attach full user record so controllers don't need their own DB queries for basics
  req.user = rows[0];
  next();
}

// ── Role guards ───────────────────────────────────────────────────────────────

/**
 * authorize(...roles) — factory that returns an Express middleware enforcing
 * that the authenticated user holds one of the listed roles.
 *
 * Usage in routes:
 *   router.post('/prescriptions/:id/verify', authenticate, authorize('PHARMACIST'), handler)
 *
 * Every denial is written to audit_log with the actor's actual role and the
 * required roles, making it straightforward to investigate privilege escalation
 * attempts during a regulatory inspection.
 *
 * @param {...string} roles - one or more user_role enum values
 * @returns {Function} Express middleware
 */
function authorize(...roles) {
  return async (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      // Record the authorization denial in the immutable audit log
      await writeAuditEvent({
        action: 'AUTHZ_DENIED', req,
        resourceType: 'route', resourceId: null,
        success: false,
        failureReason: `Role ${req.user?.role} not in [${roles.join(',')}]`,
      });
      return res.status(403).json({
        error:    'Insufficient privileges for this action',
        required: roles,
      });
    }
    next();
  };
}

// ── Pre-composed role guards (used directly in routes/index.js) ───────────────
//
// isPharmacist:  gates routes that require final clinical judgment (Rx verification,
//                driver assignment, narcotic destruction) — NAPRA / CDSA
// isTechOrAbove: gates routes any licensed pharmacy professional can perform
//                (intake, packing, double-count)
// isDriver:      gates delivery-side routes (pickup, attempt recording)
// isPatient:     gates patient self-service routes (view own Rxs, delivery status)
// isAdmin:       gates system administration routes (user management, config)
// canReadAudit:  allows Health Canada / College inspectors read-only audit access
const isPharmacist  = authorize('PHARMACIST', 'PHARMACY_MANAGER', 'SYSTEM_ADMIN');
const isTechOrAbove = authorize('PHARMACY_TECHNICIAN', 'PHARMACIST', 'PHARMACY_MANAGER', 'SYSTEM_ADMIN');
const isDriver      = authorize('DELIVERY_DRIVER');
const isPatient     = authorize('PATIENT');
const isAdmin       = authorize('SYSTEM_ADMIN');
const canReadAudit  = authorize('PHARMACIST', 'PHARMACY_MANAGER', 'SYSTEM_ADMIN', 'REGULATORY_AUDITOR');

/**
 * requireActiveLicense — verifies that an RPhT or RPh holds a current, active
 * provincial license before they can perform any clinical pharmacy action.
 *
 * Why this matters:
 *   Provincial pharmacy acts require that only currently licensed professionals
 *   perform regulated activities.  A suspended or expired license means the
 *   person is not legally authorized to practice — any actions they take could
 *   expose the pharmacy to regulatory sanction.
 *
 * Implementation:
 *   Queries professional_licenses for a row matching the user, province
 *   (taken from the X-Pharmacy-Province request header, defaulting to ON),
 *   status = ACTIVE, and expiry_date >= today.
 *   If no valid row exists, the request is blocked and the failure is logged.
 *   On success, the license row is attached to req.userLicense for downstream
 *   use (e.g., requireCDSAAuthorization reads cdsa_authorised from it).
 *
 * Non-clinical roles (drivers, patients, admins) pass through without a check.
 */
async function requireActiveLicense(req, res, next) {
  const role = req.user.role;
  // Only clinical pharmacy staff need license verification
  if (!['PHARMACY_TECHNICIAN', 'PHARMACIST'].includes(role)) return next();

  const { rows } = await pool.query(
    `SELECT status, expiry_date, cdsa_authorised
     FROM professional_licenses
     WHERE user_id      = $1
       AND province_code = $2
       AND status        = 'ACTIVE'
       AND expiry_date  >= CURRENT_DATE
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

  // Attach for use by requireCDSAAuthorization without an extra DB query
  req.userLicense = rows[0];
  next();
}

/**
 * requireCDSAAuthorization — additional guard for routes that directly touch
 * controlled substances (narcotic double-count, inventory adjustment, etc.).
 *
 * Legal basis — CDSA s.53:
 *   "No person shall … possess, produce, sell, import, export or transport a
 *   controlled substance … unless authorized under the regulations."
 *   For pharmacy staff, authorization is granted by the provincial college to
 *   licensed pharmacists, and may be extended to registered pharmacy technicians
 *   by the pharmacy's CDSA dealer's license.  This is tracked by the
 *   `cdsa_authorised` boolean on the professional_licenses row.
 *
 * Must be used AFTER requireActiveLicense (depends on req.userLicense).
 * Every denial is flagged as a controlled-substance event in audit_log so that
 * Health Canada inspectors can identify unauthorized access attempts.
 */
async function requireCDSAAuthorization(req, res, next) {
  // Programmer error guard — middleware ordering mistake
  if (!req.userLicense) {
    return res.status(403).json({ error: 'License check must precede CDSA authorization check' });
  }
  if (!req.userLicense.cdsa_authorised) {
    // Controlled substance authorization denial — always logged (CDSA s.55)
    await writeAuditEvent({
      action: 'CDSA_AUTH_DENIED', req,
      isControlledSubstanceEvent: true,
      success: false,
      failureReason: 'User not CDSA-authorized for controlled substance handling',
    });
    return res.status(403).json({
      error:     'CDSA authorization required for this controlled substance operation',
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
