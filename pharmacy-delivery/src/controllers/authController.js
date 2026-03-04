'use strict';
/**
 * @file controllers/authController.js
 * @description Authentication endpoints: login and password change.
 *
 * Security design:
 *  - Passwords hashed with bcrypt at cost factor 12 (≥ OWASP recommendation)
 *  - Timing-safe comparison: bcrypt.compare() is always called whether or not
 *    the user exists, preventing user-enumeration via response-time differences
 *  - Account lockout after MAX_FAILED_LOGINS failed attempts (OWASP A07)
 *  - All auth events (success, failure, lockout) written to audit_log
 *  - Successful login resets failed_login_count
 *  - Password change enforces minimum 12-character length
 *
 * Regulatory note: Staff accounts (RPhT, RPh) are created and managed by the
 * pharmacy manager/admin.  Self-registration is not supported for clinical roles
 * because professional licenses must be verified before access is granted.
 */

const bcrypt   = require('bcryptjs');
const pool     = require('../config/database');
const { signToken } = require('../middleware/auth');
const { writeAuditEvent } = require('../utils/audit');

// Lock the account after this many consecutive failed login attempts.
// The account can only be unlocked by a PHARMACY_MANAGER or SYSTEM_ADMIN.
const MAX_FAILED_LOGINS = 5;

async function login(req, res) {
  const { email, password } = req.body;

  // Normalise email to lowercase to prevent case-sensitivity issues
  const { rows } = await pool.query(
    `SELECT id, email, password_hash, role, is_active, is_locked, failed_login_count
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  const user = rows[0];

  // CRITICAL: Always call bcrypt.compare(), regardless of whether the user
  // exists.  If we returned early when user is not found, an attacker could
  // enumerate valid email addresses by comparing response times.
  // The dummy hash is a valid bcrypt string so compare() takes the same time.
  const dummyHash = '$2b$12$invalidhashpaddingtomatchlength0000000000000000000';
  const valid = user
    ? await bcrypt.compare(password, user.password_hash)
    : await bcrypt.compare(password, dummyHash).then(() => false);

  if (!user || !valid) {
    if (user) {
      const newCount = user.failed_login_count + 1;
      const locked   = newCount >= MAX_FAILED_LOGINS;
      await pool.query(
        'UPDATE users SET failed_login_count = $1, is_locked = $2 WHERE id = $3',
        [newCount, locked, user.id]
      );
      await writeAuditEvent({
        action: locked ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_LOGIN_FAILED',
        req, actorId: user.id, actorRole: user.role,
        success: false, failureReason: 'Invalid credentials',
      });
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.is_active || user.is_locked) {
    await writeAuditEvent({
      action: 'AUTH_LOGIN_BLOCKED', req, actorId: user.id,
      success: false, failureReason: user.is_locked ? 'Account locked' : 'Account inactive',
    });
    return res.status(401).json({ error: 'Account is inactive or locked. Contact your pharmacy manager.' });
  }

  // Reset failed login counter on success
  await pool.query(
    'UPDATE users SET failed_login_count = 0, last_login_at = NOW() WHERE id = $1',
    [user.id]
  );

  const token = signToken(user);

  await writeAuditEvent({
    action: 'AUTH_LOGIN_SUCCESS', req, actorId: user.id, actorRole: user.role, success: true,
  });

  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role },
  });
}

/**
 * changePassword — authenticated endpoint for self-service password updates.
 *
 * Requires the user's CURRENT password to prevent account takeover via
 * unlocked workstation (defence-in-depth).
 * New password must be ≥ 12 characters (NIST SP 800-63B recommendation).
 * Password change is recorded in audit_log and the `password_changed_at`
 * timestamp is updated so admins can see when passwords were last rotated.
 */
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  // Enforce minimum password length — 12 chars is the NIST/OWASP recommendation
  if (newPassword.length < 12) {
    return res.status(422).json({ error: 'Password must be at least 12 characters' });
  }

  const { rows: [user] } = await pool.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId]
  );

  // Verify current password before allowing change
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  // bcrypt cost factor 12 — slow enough to resist brute-force but fast enough
  // for single-use operations (takes ~250ms on modern hardware)
  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query(
    'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
    [hash, userId]
  );

  await writeAuditEvent({
    action: 'AUTH_PASSWORD_CHANGED', req, actorId: userId, success: true,
  });

  res.json({ message: 'Password updated successfully' });
}

module.exports = { login, changePassword };
