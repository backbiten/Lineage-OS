'use strict';

const pool     = require('../config/database');
const { technicianIntake, technicianPackAndCreateDelivery } = require('../services/technicianWorkflow');
const { pharmacistVerify, recordNarcoticDoubleCount }       = require('../services/pharmacistVerification');
const { writeAuditEvent } = require('../utils/audit');
const { body, validationResult } = require('express-validator');

// ── Input validation rules ────────────────────────────────────────────────────

const intakeValidation = [
  body('drug_id').isUUID(),
  body('patient_id').isUUID(),
  body('prescriber_id').isUUID(),
  body('pharmacy_id').isUUID(),
  body('written_date').isISO8601().toDate(),
  body('expiry_date').isISO8601().toDate(),
  body('quantity_prescribed').isFloat({ gt: 0 }),
  body('quantity_unit').isString().notEmpty(),
  body('directions').isString().notEmpty().isLength({ max: 2000 }),
  body('refills_authorized').optional().isInt({ min: 0, max: 12 }),
];

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /prescriptions/intake
 * RPhT (pharmacy technician) performs prescription intake — FIRST STEP.
 */
async function intake(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  // Load related records
  const [drugRes, patientRes, prescriberRes, pharmacyRes] = await Promise.all([
    pool.query('SELECT * FROM drugs WHERE id = $1', [req.body.drug_id]),
    pool.query('SELECT * FROM patients WHERE id = $1', [req.body.patient_id]),
    pool.query('SELECT * FROM prescribers WHERE id = $1', [req.body.prescriber_id]),
    pool.query('SELECT * FROM pharmacies WHERE id = $1', [req.body.pharmacy_id]),
  ]);

  if (!drugRes.rows[0])      return res.status(404).json({ error: 'Drug not found' });
  if (!patientRes.rows[0])   return res.status(404).json({ error: 'Patient not found' });
  if (!prescriberRes.rows[0]) return res.status(404).json({ error: 'Prescriber not found' });
  if (!pharmacyRes.rows[0])  return res.status(404).json({ error: 'Pharmacy not found' });

  const pharmacy = pharmacyRes.rows[0];
  const drug     = drugRes.rows[0];

  // Verify pharmacy is licensed to dispense controlled substances if applicable
  if (drug.is_narcotic && !pharmacy.narcotic_license) {
    return res.status(403).json({
      error: 'Pharmacy does not hold a Narcotic Control Regulations dealer\'s license',
      reference: 'Narcotic Control Regulations (SOR/2012-230), Part 1',
    });
  }

  const result = await technicianIntake({
    rx:         req.body,
    drug:       drug,
    patient:    patientRes.rows[0],
    prescriber: prescriberRes.rows[0],
    pharmacy,
    req,
  });

  res.status(201).json({
    message: 'Prescription received and queued for pharmacist verification',
    prescription_id: result.prescription.id,
    rx_number:       result.prescription.rx_number,
    status:          result.prescription.status,
    warnings:        result.validation.warnings,
    regulatory_note: 'This prescription has been routed to a licensed pharmacist for mandatory clinical verification.',
  });
}

/**
 * POST /prescriptions/:id/verify
 * RPh (pharmacist) performs clinical verification — MANDATORY before any dispensing.
 */
async function verify(req, res) {
  const result = await pharmacistVerify({
    prescriptionId: req.params.id,
    decision:       req.body,
    req,
  });

  res.json({
    message: result.status === 'APPROVED'
      ? 'Prescription approved by pharmacist. Ready for dispensing.'
      : 'Prescription rejected by pharmacist.',
    ...result,
  });
}

/**
 * POST /prescriptions/:id/narcotic-count
 * Record narcotic double-count (CDSA requirement — two staff witnesses).
 */
async function narcoticCount(req, res) {
  const result = await recordNarcoticDoubleCount({
    prescriptionId: req.params.id,
    countedQty:     req.body.counted_qty,
    witness2Id:     req.body.witness2_id,
    req,
  });
  res.json(result);
}

/**
 * GET /prescriptions/:id
 * Retrieve a prescription. PHI access logged.
 */
async function getById(req, res) {
  const { rows: [rx] } = await pool.query(`
    SELECT p.*, d.brand_name, d.generic_name, d.cdsa_schedule, d.is_narcotic,
           d.din, d.dosage_form, d.strength,
           pat.first_name || ' ' || pat.last_name AS patient_name,
           pr.first_name || ' ' || pr.last_name || ', ' || pr.designation AS prescriber_name,
           ph.name AS pharmacy_name
    FROM prescriptions p
    JOIN drugs       d   ON d.id  = p.drug_id
    JOIN patients    pat ON pat.id = p.patient_id
    JOIN prescribers pr  ON pr.id = p.prescriber_id
    JOIN pharmacies  ph  ON ph.id = p.pharmacy_id
    WHERE p.id = $1
  `, [req.params.id]);

  if (!rx) return res.status(404).json({ error: 'Prescription not found' });

  // Patients can only see their own prescriptions
  if (req.user.role === 'PATIENT') {
    const { rows: [pat] } = await pool.query(
      'SELECT id FROM patients WHERE user_id = $1', [req.user.id]
    );
    if (!pat || rx.patient_id !== pat.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  await writeAuditEvent({
    action: 'PRESCRIPTION_VIEW',
    req,
    resourceType: 'prescription',
    resourceId: rx.id,
    isPhiAccess: true,
    isControlledSubstanceEvent: rx.is_narcotic,
  });

  res.json(rx);
}

/**
 * GET /prescriptions/queue/technician
 * Technician's work queue — prescriptions pending intake or labelling.
 */
async function technicianQueue(req, res) {
  const { rows } = await pool.query(`
    SELECT p.id, p.rx_number, p.status, p.is_controlled, p.cdsa_schedule,
           p.created_at,
           d.brand_name, d.generic_name,
           pat.first_name || ' ' || pat.last_name AS patient_name
    FROM prescriptions p
    JOIN drugs       d   ON d.id  = p.drug_id
    JOIN patients    pat ON pat.id = p.patient_id
    JOIN pharmacies  ph  ON ph.id = p.pharmacy_id
    WHERE ph.id = $1
      AND p.status IN ('RECEIVED','TECHNICIAN_REVIEW','APPROVED','FILLED')
    ORDER BY p.is_controlled DESC, p.created_at ASC
    LIMIT 50
  `, [req.query.pharmacy_id]);

  res.json({ queue: rows, count: rows.length });
}

/**
 * GET /prescriptions/queue/pharmacist
 * Pharmacist's verification queue.
 */
async function pharmacistQueue(req, res) {
  const { rows } = await pool.query(`
    SELECT p.id, p.rx_number, p.status, p.is_controlled, p.cdsa_schedule,
           p.created_at,
           d.brand_name, d.generic_name, d.is_narcotic,
           pat.first_name || ' ' || pat.last_name AS patient_name,
           til.controlled_substance_flags, til.rx_not_forged_flags
    FROM prescriptions p
    JOIN drugs d ON d.id = p.drug_id
    JOIN patients pat ON pat.id = p.patient_id
    JOIN pharmacies ph ON ph.id = p.pharmacy_id
    LEFT JOIN technician_intake_log til ON til.prescription_id = p.id
    WHERE ph.id = $1
      AND p.status IN ('TECHNICIAN_REVIEW','PHARMACIST_VERIFICATION')
    ORDER BY p.is_controlled DESC, d.is_narcotic DESC, p.created_at ASC
    LIMIT 50
  `, [req.query.pharmacy_id]);

  res.json({ queue: rows, count: rows.length });
}

module.exports = {
  intake,
  intakeValidation,
  verify,
  narcoticCount,
  getById,
  technicianQueue,
  pharmacistQueue,
};
