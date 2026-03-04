'use strict';
/**
 * @file controllers/patientController.js
 * @description Patient self-service portal — registration, profile, prescription history,
 * delivery tracking, and refill requests.
 *
 * ─── Privacy ─────────────────────────────────────────────────────────────────
 *  PIPEDA s.4.3 — patients may only access their own records.
 *  All PHI access is logged to audit_log (PIPEDA / PHIPA requirement).
 *  Health card numbers are stored encrypted (pgcrypto) — never returned in API.
 *  Marketing consent is captured explicitly (CASL compliance).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool   = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');
const { signToken } = require('../middleware/auth');
const {
  notifyPrescriptionReceived,
} = require('../services/notificationService');

// ── Validation rules ──────────────────────────────────────────────────────────

const registerValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 12 }).withMessage('Password must be at least 12 characters'),
  body('first_name').isString().trim().notEmpty(),
  body('last_name').isString().trim().notEmpty(),
  body('date_of_birth').isISO8601().toDate(),
  body('phone').optional().isMobilePhone(),
  body('address_street').isString().trim().notEmpty(),
  body('address_city').isString().trim().notEmpty(),
  body('address_postal').isString().trim().isLength({ min: 6, max: 7 }),
  body('address_province').isString().isLength({ min: 2, max: 2 }),
  body('marketing_consent').optional().isBoolean(),
  body('consent_controlled_delivery').optional().isBoolean(),
];

const updateProfileValidation = [
  body('phone').optional().isMobilePhone(),
  body('address_street').optional().isString().trim().notEmpty(),
  body('address_city').optional().isString().trim().notEmpty(),
  body('address_postal').optional().isString().trim().isLength({ min: 6, max: 7 }),
  body('address_province').optional().isString().isLength({ min: 2, max: 2 }),
  body('marketing_consent').optional().isBoolean(),
];

const refillValidation = [
  body('prescription_id').isUUID(),
  body('pharmacy_id').isUUID(),
  body('delivery_address_street').optional().isString(),
  body('delivery_address_city').optional().isString(),
  body('delivery_address_postal').optional().isString(),
  body('delivery_address_province').optional().isString().isLength({ min: 2, max: 2 }),
];

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /patients/register
 * Patient self-registration. Creates a user account + patient record.
 * Open route — no authentication required.
 */
async function register(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const {
    email, password, first_name, last_name, date_of_birth,
    phone, address_street, address_city, address_postal, address_province,
    marketing_consent = false,
    consent_controlled_delivery = false,
  } = req.body;

  // Check for duplicate email
  const { rows: [existing] } = await pool.query(
    'SELECT id FROM users WHERE email = $1', [email]
  );
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  // bcrypt cost 12 — OWASP recommendation for 2024+
  const passwordHash = await bcrypt.hash(password, 12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create user account
    const { rows: [user] } = await client.query(`
      INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
      VALUES ($1, $2, 'PATIENT', $3, $4, $5)
      RETURNING id, email, role, first_name, last_name
    `, [email, passwordHash, first_name, last_name, phone || null]);

    // Create patient record
    const { rows: [patient] } = await client.query(`
      INSERT INTO patients (
        user_id, date_of_birth, phone,
        address_street, address_city, address_postal, address_province,
        marketing_consent,
        consent_controlled_delivery,
        consent_signed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      user.id, date_of_birth, phone || null,
      address_street, address_city, address_postal, address_province,
      marketing_consent,
      consent_controlled_delivery,
      consent_controlled_delivery ? new Date() : null,
    ]);

    await client.query('COMMIT');

    await writeAuditEvent({
      action: 'PATIENT_REGISTERED',
      req,
      resourceType: 'patient',
      resourceId: patient.id,
      isPhiAccess: true,
      actorId: user.id,
      actorRole: 'PATIENT',
    });

    const token = signToken(user);
    res.status(201).json({
      message: 'Account created successfully',
      token,
      patient_id: patient.id,
      user: { id: user.id, email: user.email, first_name, last_name, role: 'PATIENT' },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * GET /patients/me
 * Return the authenticated patient's profile (own data only).
 */
async function getProfile(req, res) {
  const { rows: [row] } = await pool.query(`
    SELECT
      u.id AS user_id, u.email, u.first_name, u.last_name, u.phone,
      u.created_at AS account_created_at,
      p.id AS patient_id, p.date_of_birth, p.gender,
      p.address_street, p.address_city, p.address_postal, p.address_province,
      p.allergy_notes, p.marketing_consent,
      p.consent_controlled_delivery, p.consent_signed_at,
      p.health_card_province
      -- health_card_number intentionally omitted — decryption only on demand
    FROM users u
    JOIN patients p ON p.user_id = u.id
    WHERE u.id = $1
  `, [req.user.id]);

  if (!row) return res.status(404).json({ error: 'Patient profile not found' });

  await writeAuditEvent({
    action: 'PATIENT_PROFILE_VIEW', req,
    resourceType: 'patient', resourceId: row.patient_id, isPhiAccess: true,
  });

  res.json(row);
}

/**
 * PATCH /patients/me
 * Update patient profile fields (address, phone, consent).
 * Does not allow changing email or password via this endpoint.
 */
async function updateProfile(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { rows: [patient] } = await pool.query(
    'SELECT id FROM patients WHERE user_id = $1', [req.user.id]
  );
  if (!patient) return res.status(404).json({ error: 'Patient profile not found' });

  const allowed = ['phone', 'address_street', 'address_city', 'address_postal', 'address_province', 'marketing_consent'];
  const updates = [];
  const params  = [];
  let idx = 1;

  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${idx++}`);
      params.push(req.body[field]);
    }
  }

  // consent_controlled_delivery requires capturing timestamp
  if (req.body.consent_controlled_delivery !== undefined) {
    updates.push(`consent_controlled_delivery = $${idx++}`);
    params.push(req.body.consent_controlled_delivery);
    if (req.body.consent_controlled_delivery) {
      updates.push(`consent_signed_at = $${idx++}`);
      params.push(new Date());
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  params.push(patient.id);
  const { rows: [updated] } = await pool.query(`
    UPDATE patients SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, updated_at
  `, params);

  await writeAuditEvent({
    action: 'PATIENT_PROFILE_UPDATED', req,
    resourceType: 'patient', resourceId: patient.id, isPhiAccess: true,
  });

  res.json({ message: 'Profile updated', patient_id: updated.id, updated_at: updated.updated_at });
}

/**
 * GET /patients/me/prescriptions
 * Authenticated patient's prescription history. PHI access logged.
 */
async function myPrescriptions(req, res) {
  const { rows: [patient] } = await pool.query(
    'SELECT id FROM patients WHERE user_id = $1', [req.user.id]
  );
  if (!patient) return res.status(404).json({ error: 'Patient profile not found' });

  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  const { rows } = await pool.query(`
    SELECT
      p.id, p.rx_number, p.status, p.written_date, p.expiry_date,
      p.quantity_prescribed, p.quantity_unit, p.directions,
      p.refills_authorized, p.refills_remaining, p.is_controlled,
      p.cdsa_schedule, p.pharmacist_verified_at,
      p.created_at,
      d.brand_name, d.generic_name, d.dosage_form, d.strength,
      ph.name AS pharmacy_name, ph.phone AS pharmacy_phone
    FROM prescriptions p
    JOIN drugs      d  ON d.id  = p.drug_id
    JOIN pharmacies ph ON ph.id = p.pharmacy_id
    WHERE p.patient_id = $1
    ORDER BY p.created_at DESC
    LIMIT $2 OFFSET $3
  `, [patient.id, parseInt(limit, 10), offset]);

  await writeAuditEvent({
    action: 'PATIENT_PRESCRIPTIONS_LIST', req,
    resourceType: 'patient', resourceId: patient.id, isPhiAccess: true,
  });

  res.json({ prescriptions: rows, page: parseInt(page, 10), limit: parseInt(limit, 10) });
}

/**
 * GET /patients/me/deliveries
 * Authenticated patient's delivery order history.
 */
async function myDeliveries(req, res) {
  const { rows: [patient] } = await pool.query(
    'SELECT id FROM patients WHERE user_id = $1', [req.user.id]
  );
  if (!patient) return res.status(404).json({ error: 'Patient profile not found' });

  const { rows } = await pool.query(`
    SELECT
      do.id, do.order_number, do.status,
      do.delivery_address_street, do.delivery_address_city,
      do.delivery_address_postal, do.delivery_address_province,
      do.contains_controlled, do.id_verification_required,
      do.estimated_delivery_at, do.actual_delivery_at,
      do.created_at,
      u.first_name || ' ' || u.last_name AS driver_name
    FROM delivery_orders do
    LEFT JOIN delivery_drivers dd ON dd.id = do.driver_id
    LEFT JOIN users u ON u.id = dd.user_id
    WHERE do.patient_id = $1
    ORDER BY do.created_at DESC
    LIMIT 50
  `, [patient.id]);

  await writeAuditEvent({
    action: 'PATIENT_DELIVERIES_LIST', req,
    resourceType: 'patient', resourceId: patient.id, isPhiAccess: true,
  });

  res.json({ deliveries: rows });
}

/**
 * POST /patients/me/refill-requests
 * Patient requests a refill on an existing prescription.
 * Validates: patient owns the Rx, refills remain, Rx not expired.
 */
async function requestRefill(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { rows: [patient] } = await pool.query(
    'SELECT id FROM patients WHERE user_id = $1', [req.user.id]
  );
  if (!patient) return res.status(404).json({ error: 'Patient profile not found' });

  const { rows: [rx] } = await pool.query(`
    SELECT p.*, d.brand_name, d.generic_name, d.is_narcotic
    FROM prescriptions p
    JOIN drugs d ON d.id = p.drug_id
    WHERE p.id = $1 AND p.patient_id = $2
  `, [req.body.prescription_id, patient.id]);

  if (!rx) return res.status(404).json({ error: 'Prescription not found or does not belong to you' });

  // Narcotics cannot be refilled (NCR s.31 — new Rx required each time)
  if (rx.is_narcotic) {
    return res.status(403).json({
      error: 'Narcotics cannot be refilled online. A new prescription from your prescriber is required.',
      reference: 'Narcotic Control Regulations, s.31',
    });
  }

  if (rx.refills_remaining <= 0) {
    return res.status(409).json({
      error: 'No refills remaining on this prescription. Please contact your prescriber.',
    });
  }

  if (new Date(rx.expiry_date) < new Date()) {
    return res.status(409).json({
      error: 'This prescription has expired. Please obtain a new prescription from your prescriber.',
    });
  }

  if (!['DELIVERED', 'DISPENSED', 'FILLED'].includes(rx.status)) {
    return res.status(409).json({ error: 'This prescription is not eligible for a refill at this time' });
  }

  // Decrement refills and reset status to RECEIVED for pharmacist review
  const { rows: [updated] } = await pool.query(`
    UPDATE prescriptions
    SET refills_remaining = refills_remaining - 1,
        status = 'RECEIVED',
        pharmacist_verified_at = NULL,
        reviewed_by_rph_id = NULL
    WHERE id = $1
    RETURNING id, rx_number, refills_remaining, status
  `, [rx.id]);

  await writeAuditEvent({
    action: 'REFILL_REQUESTED', req,
    resourceType: 'prescription', resourceId: rx.id, isPhiAccess: true,
    isControlledSubstanceEvent: rx.is_controlled,
  });

  // Notify patient acknowledgement
  await notifyPrescriptionReceived({
    email: req.user.email,
    firstName: req.user.first_name,
    rxNumber: rx.rx_number,
  });

  res.json({
    message: 'Refill request received. Your pharmacist will review the request.',
    prescription_id: updated.id,
    rx_number: updated.rx_number,
    refills_remaining: updated.refills_remaining,
    status: updated.status,
  });
}

module.exports = {
  register,
  registerValidation,
  getProfile,
  updateProfile,
  updateProfileValidation,
  myPrescriptions,
  myDeliveries,
  requestRefill,
  refillValidation,
};
