'use strict';

const bcrypt   = require('bcryptjs');
const pool     = require('../config/database');
const { signToken } = require('../middleware/auth');
const { writeAuditEvent } = require('../utils/audit');

const MAX_FAILED_LOGINS = 5;  // account locked after 5 failures

async function login(req, res) {
  const { email, password } = req.body;

  const { rows } = await pool.query(
    `SELECT id, email, password_hash, role, is_active, is_locked, failed_login_count
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  const user = rows[0];

  // Timing-safe: always run bcrypt compare to prevent user enumeration
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

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  if (newPassword.length < 12) {
    return res.status(422).json({ error: 'Password must be at least 12 characters' });
  }

  const { rows: [user] } = await pool.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId]
  );

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

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
