'use strict';
/**
 * Audit Logger
 *
 * Regulatory basis:
 *  - CDSA s.55(1)(g): "keep records … in the prescribed form"
 *  - Narcotic Control Regulations s.35: all narcotic transactions recorded
 *  - PIPEDA Principle 7 (Safeguards) & Principle 9 (Individual Access)
 *  - Provincial pharmacy acts — inspection-ready audit trail
 *
 * Design:
 *  - Every write to audit_log is append-only (DB trigger prevents UPDATE/DELETE)
 *  - Each row carries an integrity_hash (SHA-256) to detect tampering
 *  - PHI fields are noted but NOT stored in old_values/new_values (PIPEDA minimization)
 */

const crypto = require('crypto');
const pool   = require('../config/database');
const logger = require('./logger');

/**
 * Compute integrity hash for an audit event.
 * HMAC-SHA256 with server-side secret so only the app can generate valid hashes.
 */
function computeIntegrityHash(eventTime, actorId, action, resourceId) {
  const secret = process.env.AUDIT_HMAC_SECRET;
  if (!secret) throw new Error('AUDIT_HMAC_SECRET not configured');
  const payload = `${eventTime}|${actorId ?? 'SYSTEM'}|${action}|${resourceId ?? ''}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Write an audit event. Never throws — failures are logged to file instead
 * so that a DB hiccup doesn't silently drop a regulated event.
 *
 * @param {object} opts
 * @param {string}  opts.action           - e.g. 'PRESCRIPTION_DISPENSE'
 * @param {object}  [opts.req]            - Express request (for actor/IP)
 * @param {string}  [opts.actorId]        - UUID of user (if no req)
 * @param {string}  [opts.actorRole]      - role enum value
 * @param {string}  [opts.resourceType]   - 'prescription' | 'delivery_order' | …
 * @param {string}  [opts.resourceId]     - UUID
 * @param {object}  [opts.oldValues]      - sanitized before-state (no PHI)
 * @param {object}  [opts.newValues]      - sanitized after-state  (no PHI)
 * @param {boolean} [opts.isPhiAccess]
 * @param {boolean} [opts.isControlledSubstanceEvent]
 * @param {boolean} [opts.success]
 * @param {string}  [opts.failureReason]
 */
async function writeAuditEvent(opts) {
  const {
    action,
    req,
    actorId:       explicitActorId,
    actorRole:     explicitRole,
    resourceType,
    resourceId,
    oldValues,
    newValues,
    isPhiAccess                = false,
    isControlledSubstanceEvent = false,
    success                    = true,
    failureReason,
  } = opts;

  const actorId   = req?.user?.id   ?? explicitActorId  ?? null;
  const actorRole = req?.user?.role ?? explicitRole      ?? null;
  const ipAddress = req?.ip         ?? null;
  const userAgent = req?.headers?.['user-agent'] ?? null;
  const eventTime = new Date().toISOString();

  let integrityHash;
  try {
    integrityHash = computeIntegrityHash(eventTime, actorId, action, resourceId);
  } catch (err) {
    logger.error('Audit hash computation failed — using placeholder', { err: err.message });
    integrityHash = 'HASH_ERROR';
  }

  const sql = `
    INSERT INTO audit_log
      (event_time, actor_id, actor_role, ip_address, user_agent,
       action, resource_type, resource_id,
       old_values, new_values,
       is_phi_access, is_controlled_substance_event,
       integrity_hash, success, failure_reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `;

  try {
    await pool.query(sql, [
      eventTime, actorId, actorRole, ipAddress, userAgent,
      action, resourceType ?? null, resourceId ?? null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      isPhiAccess, isControlledSubstanceEvent,
      integrityHash, success, failureReason ?? null,
    ]);
  } catch (dbErr) {
    // Log to file — this must NEVER silently disappear
    logger.error('CRITICAL: audit_log DB write failed', {
      action, actorId, resourceType, resourceId, dbErr: dbErr.message,
    });
  }
}

module.exports = { writeAuditEvent };
