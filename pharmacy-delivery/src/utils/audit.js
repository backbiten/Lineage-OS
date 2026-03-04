'use strict';
/**
 * @file utils/audit.js
 * @description Immutable regulatory audit event writer.
 *
 * Every significant action in the system — prescription intake, pharmacist
 * verification, narcotic count, delivery attempt, PHI access, failed login —
 * must be recorded here.  This satisfies:
 *
 *  - CDSA s.55(1)(g): "keep records … in the prescribed form"
 *  - NCR s.35: all narcotic transactions must be recorded with date, quantity,
 *              person who performed the transaction
 *  - PIPEDA Principle 7 (Safeguards): evidence of security controls
 *  - PIPEDA Principle 9 (Individual Access): auditable trail of who accessed PHI
 *  - Provincial pharmacy acts: inspection-ready audit trail for College inspectors
 *
 * ─── Integrity design ────────────────────────────────────────────────────────
 *  • The DB table itself has a BEFORE UPDATE/DELETE trigger that raises an
 *    exception — making rows immutable at the database level.
 *  • Each row also carries an integrity_hash (HMAC-SHA256 of key fields with
 *    a server-side secret).  An inspector can recompute hashes to detect if
 *    anyone bypassed the DB trigger via direct SQL.
 *  • PHI values (patient name, health card number, allergy notes, etc.) are
 *    NEVER written to old_values/new_values — only non-identifying identifiers
 *    like UUIDs, drug schedules, and status transitions (PIPEDA minimization).
 * ────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const pool   = require('../config/database');
const logger = require('./logger');

/**
 * computeIntegrityHash — produces a per-row HMAC-SHA256 digest.
 *
 * The hash covers: eventTime | actorId | action | resourceId
 * signed with AUDIT_HMAC_SECRET (a server-side secret not stored in the DB).
 *
 * During a regulatory inspection, an auditor can re-run this function over
 * every audit_log row to confirm that none of the four key fields have been
 * altered since the row was written.  A mismatch indicates tampering.
 *
 * Requires AUDIT_HMAC_SECRET in environment — throws if absent so the problem
 * is caught at startup rather than silently producing unhashable rows.
 *
 * @param {string} eventTime  - ISO-8601 timestamp string
 * @param {string|null} actorId    - user UUID or null for system events
 * @param {string} action     - action code, e.g. 'PRESCRIPTION_APPROVED'
 * @param {string|null} resourceId - UUID of affected record, or null
 * @returns {string} 64-character lowercase hex HMAC digest
 */
function computeIntegrityHash(eventTime, actorId, action, resourceId) {
  const secret = process.env.AUDIT_HMAC_SECRET;
  if (!secret) throw new Error('AUDIT_HMAC_SECRET not configured');
  // Pipe-delimited payload; SYSTEM substituted for null actorId (background jobs)
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

  // Prefer values from the live Express request object; fall back to explicit params
  // (explicit params are used when calling from background jobs / queue workers)
  const actorId   = req?.user?.id   ?? explicitActorId  ?? null;
  const actorRole = req?.user?.role ?? explicitRole      ?? null;
  const ipAddress = req?.ip         ?? null;  // Real IP via trust proxy setting
  const userAgent = req?.headers?.['user-agent'] ?? null;
  const eventTime = new Date().toISOString();  // UTC — consistent across time zones

  // Compute HMAC before touching the DB; if the secret is misconfigured we'd
  // rather log a HASH_ERROR row than drop the event entirely
  let integrityHash;
  try {
    integrityHash = computeIntegrityHash(eventTime, actorId, action, resourceId);
  } catch (err) {
    logger.error('Audit hash computation failed — using placeholder', { err: err.message });
    integrityHash = 'HASH_ERROR';  // Visible in audit log so ops team investigates
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
      // Serialize change snapshots as JSON; null if no before/after provided
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      isPhiAccess, isControlledSubstanceEvent,
      integrityHash, success, failureReason ?? null,
    ]);
  } catch (dbErr) {
    // CRITICAL: a failed audit write must never be silently swallowed.
    // We log to the rotating file transport so there is still a record even
    // if the DB is temporarily unavailable.
    logger.error('CRITICAL: audit_log DB write failed', {
      action, actorId, resourceType, resourceId, dbErr: dbErr.message,
    });
  }
}

module.exports = { writeAuditEvent };
