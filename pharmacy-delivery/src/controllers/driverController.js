'use strict';
/**
 * @file controllers/driverController.js
 * @description Driver management — registration, background check recording,
 * CDSA authorization, availability, and vehicle management.
 *
 * ─── Regulatory basis ────────────────────────────────────────────────────────
 *  NCR s.5 — Carriers:
 *    A carrier (delivery driver) employed by a licensed pharmacy is authorized
 *    to possess controlled substances during delivery under the pharmacy's dealer's
 *    license. However, the pharmacy must ensure the carrier is a "fit person":
 *    • Criminal record check (mandatory for controlled substance delivery)
 *    • Vulnerable sector check (required if serving vulnerable populations)
 *    • CDSA controlled delivery training completion
 *    The `can_deliver_controlled` flag is only set by a PHARMACIST or
 *    PHARMACY_MANAGER after verifying all requirements.
 *
 *  Driver's License:
 *    Provincial highway traffic acts require a valid driver's license.
 *    We record license number, province, and expiry.
 *
 *  Vehicle insurance:
 *    Commercial insurance is required for delivery vehicles.
 *    Cold-chain capable vehicles required for refrigerated medications.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool   = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');

// ── Validation rules ──────────────────────────────────────────────────────────

const registerDriverValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 12 }),
  body('first_name').isString().trim().notEmpty(),
  body('last_name').isString().trim().notEmpty(),
  body('phone').optional().isMobilePhone(),
  body('pharmacy_id').isUUID(),
  body('drivers_license').isString().trim().notEmpty(),
  body('license_province').isString().isLength({ min: 2, max: 2 }),
  body('license_expiry').isISO8601().toDate(),
  body('vehicle_plate').optional().isString().trim(),
  body('vehicle_province').optional().isString().isLength({ min: 2, max: 2 }),
  body('vehicle_insured').optional().isBoolean(),
  body('cold_chain_capable').optional().isBoolean(),
];

const backgroundCheckValidation = [
  body('criminal_record_check_date').isISO8601().toDate(),
  body('criminal_record_check_clear').isBoolean(),
  body('vulnerable_sector_check_date').optional().isISO8601().toDate(),
  body('vulnerable_sector_clear').optional().isBoolean(),
];

const cdsaAuthValidation = [
  body('authorized').isBoolean(),
  body('training_date').isISO8601().toDate(),
];

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /drivers/register
 * Register a new delivery driver. Called by PHARMACY_MANAGER or SYSTEM_ADMIN.
 * Creates a user + delivery_drivers record in a transaction.
 */
async function registerDriver(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const {
    email, password, first_name, last_name, phone,
    pharmacy_id,
    drivers_license, license_province, license_expiry,
    vehicle_plate, vehicle_province, vehicle_insured = false,
    cold_chain_capable = false,
  } = req.body;

  // Verify pharmacy exists and is active
  const { rows: [pharmacy] } = await pool.query(
    'SELECT id, name FROM pharmacies WHERE id = $1 AND is_active = TRUE', [pharmacy_id]
  );
  if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found or inactive' });

  // Duplicate email check
  const { rows: [existing] } = await pool.query(
    'SELECT id FROM users WHERE email = $1', [email]
  );
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = await bcrypt.hash(password, 12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [user] } = await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
      VALUES ($1, $2, 'DELIVERY_DRIVER', $3, $4, $5)
      RETURNING id, email, first_name, last_name
    `, [email, passwordHash, first_name, last_name, phone || null]);

    const { rows: [driver] } = await client.query(`
      INSERT INTO delivery_drivers (
        user_id, pharmacy_id,
        drivers_license, license_province, license_expiry,
        vehicle_plate, vehicle_province, vehicle_insured,
        cold_chain_capable
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      user.id, pharmacy_id,
      drivers_license, license_province, license_expiry,
      vehicle_plate || null, vehicle_province || null, vehicle_insured,
      cold_chain_capable,
    ]);

    await client.query('COMMIT');

    await writeAuditEvent({
      action: 'DRIVER_REGISTERED', req,
      resourceType: 'delivery_driver', resourceId: driver.id,
    });

    res.status(201).json({
      message: 'Driver registered successfully. Background checks required before controlled substance deliveries.',
      driver_id: driver.id,
      user_id: user.id,
      can_deliver_controlled: false,
      regulatory_note: 'NCR s.5 — criminal record check and CDSA training must be completed before driver may carry controlled substances.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /drivers/:id/background-check
 * Record the result of a criminal record / vulnerable sector check.
 * Only PHARMACIST or PHARMACY_MANAGER may record this.
 */
async function recordBackgroundCheck(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { rows: [driver] } = await pool.query(
    'SELECT id, pharmacy_id FROM delivery_drivers WHERE id = $1', [req.params.id]
  );
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const {
    criminal_record_check_date,
    criminal_record_check_clear,
    vulnerable_sector_check_date,
    vulnerable_sector_clear,
  } = req.body;

  const { rows: [updated] } = await pool.query(`
    UPDATE delivery_drivers
    SET criminal_record_check_date  = $1,
        criminal_record_check_clear = $2,
        vulnerable_sector_check_date = $3,
        vulnerable_sector_clear      = $4
    WHERE id = $5
    RETURNING id, criminal_record_check_clear, vulnerable_sector_clear, can_deliver_controlled
  `, [
    criminal_record_check_date,
    criminal_record_check_clear,
    vulnerable_sector_check_date || null,
    vulnerable_sector_clear ?? null,
    driver.id,
  ]);

  await writeAuditEvent({
    action: 'DRIVER_BACKGROUND_CHECK_RECORDED', req,
    resourceType: 'delivery_driver', resourceId: driver.id,
    isControlledSubstanceEvent: true,
  });

  res.json({
    message: 'Background check recorded',
    driver_id: updated.id,
    criminal_record_check_clear: updated.criminal_record_check_clear,
    can_deliver_controlled: updated.can_deliver_controlled,
    note: updated.criminal_record_check_clear
      ? 'Criminal record check clear. Complete CDSA training and use /drivers/:id/cdsa-authorization to authorize controlled deliveries.'
      : 'Criminal record check failed. Driver may NOT carry controlled substances (NCR s.5).',
  });
}

/**
 * POST /drivers/:id/cdsa-authorization
 * Pharmacist/manager authorizes (or revokes) driver to carry controlled substances.
 * Requires: criminal record check clear + training date.
 */
async function setCdsaAuthorization(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { rows: [driver] } = await pool.query(
    'SELECT * FROM delivery_drivers WHERE id = $1', [req.params.id]
  );
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  const { authorized, training_date } = req.body;

  // Cannot authorize without cleared background check
  if (authorized && !driver.criminal_record_check_clear) {
    return res.status(422).json({
      error: 'Cannot authorize controlled substance delivery — criminal record check has not been cleared.',
      reference: 'Narcotic Control Regulations, s.5',
    });
  }

  await pool.query(`
    UPDATE delivery_drivers
    SET can_deliver_controlled             = $1,
        controlled_delivery_training_date  = $2
    WHERE id = $3
  `, [authorized, training_date, driver.id]);

  await writeAuditEvent({
    action: authorized ? 'DRIVER_CDSA_AUTHORIZED' : 'DRIVER_CDSA_AUTHORIZATION_REVOKED',
    req,
    resourceType: 'delivery_driver',
    resourceId: driver.id,
    isControlledSubstanceEvent: true,
  });

  res.json({
    message: authorized
      ? 'Driver authorized for controlled substance delivery'
      : 'Controlled substance delivery authorization revoked',
    driver_id: driver.id,
    can_deliver_controlled: authorized,
    reference: 'Narcotic Control Regulations (SOR/2012-230), s.5 — Carrier authorization',
  });
}

/**
 * GET /drivers
 * List all drivers for a pharmacy. Manager/Admin only.
 */
async function listDrivers(req, res) {
  const { pharmacy_id } = req.query;
  if (!pharmacy_id) return res.status(400).json({ error: 'pharmacy_id required' });

  const { rows } = await pool.query(`
    SELECT
      dd.id, dd.is_active,
      dd.drivers_license, dd.license_province, dd.license_expiry,
      dd.criminal_record_check_clear, dd.vulnerable_sector_clear,
      dd.can_deliver_controlled, dd.controlled_delivery_training_date,
      dd.cold_chain_capable, dd.vehicle_plate, dd.vehicle_insured,
      u.first_name, u.last_name, u.email, u.phone
    FROM delivery_drivers dd
    JOIN users u ON u.id = dd.user_id
    WHERE dd.pharmacy_id = $1
    ORDER BY dd.is_active DESC, u.last_name, u.first_name
  `, [pharmacy_id]);

  res.json({ drivers: rows, count: rows.length });
}

/**
 * GET /drivers/:id
 * Get a single driver's details.
 */
async function getDriver(req, res) {
  const { rows: [driver] } = await pool.query(`
    SELECT
      dd.*,
      u.first_name, u.last_name, u.email, u.phone,
      ph.name AS pharmacy_name
    FROM delivery_drivers dd
    JOIN users u ON u.id = dd.user_id
    JOIN pharmacies ph ON ph.id = dd.pharmacy_id
    WHERE dd.id = $1
  `, [req.params.id]);

  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  res.json(driver);
}

/**
 * PATCH /drivers/:id/status
 * Activate or deactivate a driver. Manager/Admin only.
 */
async function setDriverStatus(req, res) {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active (boolean) required' });
  }

  const { rows: [driver] } = await pool.query(`
    UPDATE delivery_drivers SET is_active = $1 WHERE id = $2
    RETURNING id, is_active
  `, [is_active, req.params.id]);

  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  await writeAuditEvent({
    action: is_active ? 'DRIVER_ACTIVATED' : 'DRIVER_DEACTIVATED',
    req, resourceType: 'delivery_driver', resourceId: driver.id,
  });

  res.json({ driver_id: driver.id, is_active: driver.is_active });
}

module.exports = {
  registerDriver,
  registerDriverValidation,
  recordBackgroundCheck,
  backgroundCheckValidation,
  setCdsaAuthorization,
  cdsaAuthValidation,
  listDrivers,
  getDriver,
  setDriverStatus,
};
