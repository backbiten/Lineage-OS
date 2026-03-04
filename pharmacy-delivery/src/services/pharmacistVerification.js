'use strict';
/**
 * Pharmacist Verification Service
 *
 * Regulatory basis:
 *  - CDSA s.31(1): pharmacist bears professional responsibility for all dispensed Rxs
 *  - Narcotic Control Regulations s.31: pharmacist final check mandatory for narcotics
 *  - NAPRA Standards — pharmacist provides final verification (cannot be delegated)
 *  - Food and Drugs Act s.9: patient counselling obligation
 *  - Provincial pharmacy acts — professional liability
 *
 * CRITICAL DESIGN RULE:
 *   No controlled substance Rx may proceed to dispensing/delivery without
 *   pharmacist sign-off. This is enforced at both service and DB level.
 */

const pool     = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');
const { submitToPMP }     = require('./provincialMonitoring');

/**
 * Pharmacist reviews and verifies (or rejects) a prescription.
 *
 * @param {object} opts.prescriptionId
 * @param {object} opts.decision - { approved, clinicalNotes, dose_within_range,
 *                                    no_contraindications, patient_counselled,
 *                                    rx_authentic, prescriber_authority_confirmed,
 *                                    rejection_reason }
 * @param {object} opts.req
 */
async function pharmacistVerify({ prescriptionId, decision, req }) {
  const pharmacistId = req.user.id;

  // Confirm acting user IS a licensed pharmacist
  if (!['PHARMACIST', 'PHARMACY_MANAGER'].includes(req.user.role)) {
    const err = new Error('Only a licensed pharmacist may perform final prescription verification');
    err.status = 403;
    throw err;
  }

  // Load prescription
  const { rows: [rx] } = await pool.query(
    `SELECT p.*, d.is_narcotic, d.cdsa_schedule, d.requires_real_time_monitoring,
            d.din, ph.province_code
     FROM prescriptions p
     JOIN drugs d ON d.id = p.drug_id
     JOIN pharmacies ph ON ph.id = p.pharmacy_id
     WHERE p.id = $1`,
    [prescriptionId]
  );

  if (!rx) {
    const err = new Error('Prescription not found');
    err.status = 404;
    throw err;
  }

  if (rx.status !== 'PHARMACIST_VERIFICATION' && rx.status !== 'TECHNICIAN_REVIEW') {
    const err = new Error(`Prescription status '${rx.status}' does not allow pharmacist verification`);
    err.status = 409;
    throw err;
  }

  // Narcotic: pharmacist must confirm original Rx on file (NCR s.31)
  if (rx.is_narcotic && !rx.rx_original_received) {
    const err = new Error(
      'Original written narcotic prescription must be on file before pharmacist verification ' +
      '(Narcotic Control Regulations s.31)'
    );
    err.status = 422;
    throw err;
  }

  const newStatus = decision.approved ? 'APPROVED' : 'REJECTED';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Compute a simple signature hash (in production: integrate with PKI/e-signature)
    const crypto = require('crypto');
    const sigPayload = `${pharmacistId}|${prescriptionId}|${Date.now()}`;
    const signatureHash = crypto
      .createHmac('sha256', process.env.PHARMACIST_SIG_SECRET || 'change-me')
      .update(sigPayload)
      .digest('hex');

    // Record pharmacist verification
    await client.query(`
      INSERT INTO pharmacist_verification_log (
        prescription_id, pharmacist_id,
        clinical_appropriateness_verified,
        dose_within_range,
        no_contraindications,
        patient_counselling_provided,
        rx_authentic,
        prescriber_authority_confirmed,
        approved,
        rejection_reason,
        pharmacist_signature_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      prescriptionId, pharmacistId,
      decision.clinical_appropriateness_verified ?? true,
      decision.dose_within_range      ?? true,
      decision.no_contraindications   ?? true,
      decision.patient_counselled     ?? false,
      decision.rx_authentic           ?? (rx.is_narcotic ? false : null),
      decision.prescriber_authority_confirmed ?? null,
      decision.approved,
      decision.rejection_reason || null,
      signatureHash,
    ]);

    // Update prescription status
    await client.query(`
      UPDATE prescriptions SET
        status                 = $1,
        reviewed_by_rph_id     = $2,
        pharmacist_verified_at = NOW(),
        pharmacist_notes       = $3,
        updated_at             = NOW()
      WHERE id = $4
    `, [newStatus, pharmacistId, decision.clinicalNotes || null, prescriptionId]);

    // Update technician intake log — route timestamp
    await client.query(`
      UPDATE technician_intake_log SET
        routed_to_pharmacist_at = COALESCE(routed_to_pharmacist_at, NOW()),
        routed_to_pharmacist_id = COALESCE(routed_to_pharmacist_id, $1)
      WHERE prescription_id = $2
    `, [pharmacistId, prescriptionId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Provincial Drug Monitoring Program — submit BEFORE dispensing (real-time provinces)
  if (decision.approved && rx.requires_real_time_monitoring) {
    await submitToPMP({ prescriptionId, provinceCode: rx.province_code }).catch(err => {
      // Log but don't block — pharmacist must be alerted
      writeAuditEvent({
        action: 'PMP_SUBMISSION_FAILED',
        req,
        resourceType: 'prescription',
        resourceId: prescriptionId,
        isControlledSubstanceEvent: true,
        success: false,
        failureReason: err.message,
      });
    });
  }

  await writeAuditEvent({
    action: decision.approved ? 'PRESCRIPTION_APPROVED' : 'PRESCRIPTION_REJECTED',
    req,
    resourceType: 'prescription',
    resourceId: prescriptionId,
    isControlledSubstanceEvent: rx.cdsa_schedule !== 'NOT_CONTROLLED',
    isPhiAccess: true,
    newValues: {
      status:           newStatus,
      is_narcotic:      rx.is_narcotic,
      cdsa_schedule:    rx.cdsa_schedule,
      rejection_reason: decision.rejection_reason || null,
    },
  });

  return { prescriptionId, status: newStatus };
}

/**
 * Narcotic double-count verification.
 * CDSA / NCR — two licensed staff must verify count of controlled substance
 * removed from inventory before dispensing.
 *
 * @param {object} opts.prescriptionId
 * @param {object} opts.countedQty
 * @param {object} opts.witness2Id - second licensed staff UUID
 * @param {object} opts.req
 */
async function recordNarcoticDoubleCount({ prescriptionId, countedQty, witness2Id, req }) {
  const counter1Id = req.user.id;

  const { rows: [rx] } = await pool.query(
    'SELECT id, quantity_prescribed, is_controlled FROM prescriptions WHERE id = $1',
    [prescriptionId]
  );

  if (!rx?.is_controlled) {
    const err = new Error('Double-count is only required for controlled substances');
    err.status = 400;
    throw err;
  }

  if (Math.abs(countedQty - rx.quantity_prescribed) > 0.001) {
    await writeAuditEvent({
      action: 'NARCOTIC_COUNT_DISCREPANCY',
      req,
      resourceType: 'prescription',
      resourceId: prescriptionId,
      isControlledSubstanceEvent: true,
      success: false,
      failureReason: `Counted ${countedQty} vs prescribed ${rx.quantity_prescribed}`,
    });
    const err = new Error(
      `Narcotic count discrepancy: counted ${countedQty}, prescribed ${rx.quantity_prescribed}. ` +
      `Pharmacist must investigate immediately. Do NOT dispense.`
    );
    err.status = 422;
    throw err;
  }

  await pool.query(`
    UPDATE prescriptions SET
      narcotic_count_tech1_id = $1,
      narcotic_count_tech2_id = $2,
      narcotic_count_at       = NOW(),
      narcotic_count_qty      = $3,
      updated_at              = NOW()
    WHERE id = $4
  `, [counter1Id, witness2Id, countedQty, prescriptionId]);

  await writeAuditEvent({
    action: 'NARCOTIC_DOUBLE_COUNT_RECORDED',
    req,
    resourceType: 'prescription',
    resourceId: prescriptionId,
    isControlledSubstanceEvent: true,
    newValues: { counted_qty: countedQty, witness2_id: witness2Id },
  });

  return { verified: true, countedQty };
}

module.exports = { pharmacistVerify, recordNarcoticDoubleCount };
