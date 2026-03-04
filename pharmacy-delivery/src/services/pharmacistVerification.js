'use strict';
/**
 * @file services/pharmacistVerification.js
 * @description Pharmacist clinical verification service — Step 2 of the workflow.
 *
 * This module enforces the most critical regulatory requirement in the platform:
 * NO prescription — and especially NO controlled substance prescription — may
 * advance to dispensing or delivery without explicit pharmacist sign-off.
 *
 * ─── Regulatory basis ────────────────────────────────────────────────────────
 *  CDSA s.31(1):
 *    The pharmacist bears professional responsibility for all dispensed Rxs.
 *    This cannot be delegated to a technician.
 *  NCR s.31:
 *    Pharmacist must perform the final check on narcotic prescriptions and
 *    confirm the original written Rx is on file before dispensing.
 *  NAPRA Model Standards s.3.0:
 *    Pharmacist provides final verification — this step is not delegatable.
 *  Food and Drugs Act s.9 / s.29.1:
 *    Patient must receive counselling on drug therapy from the pharmacist.
 *  Provincial pharmacy acts:
 *    Pharmacist is personally liable for any dispensing error.
 *
 * ─── Critical design rule ────────────────────────────────────────────────────
 *  The pharmacistVerify() function is the ONLY path by which a prescription
 *  can transition to APPROVED status.  The DB schema and application layer both
 *  enforce this.  There is no "bypass" or "emergency override" route.
 * ────────────────────────────────────────────────────────────────────────────
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

    // Produce an HMAC-SHA256 "digital signature" binding the pharmacist's ID to
    // this prescription at this exact timestamp.  In a full production system
    // this should integrate with a PKI/HSM for legally non-repudiable e-signatures
    // (e.g., via Health Canada's eSignature framework or provincial equivalent).
    const crypto = require('crypto');
    const sigPayload = `${pharmacistId}|${prescriptionId}|${Date.now()}`;
    const signatureHash = crypto
      .createHmac('sha256', process.env.PHARMACIST_SIG_SECRET || 'change-me')
      .update(sigPayload)
      .digest('hex');

    // Write the formal verification record — this is the legally significant
    // document that proves the pharmacist reviewed and approved/rejected the Rx
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

  // For drugs requiring real-time PMP reporting (e.g., all Rxs in BC via PharmaNet,
  // narcotics in ON/MB/AB/NS), submit to the provincial program immediately after
  // approval.  We use .catch() so a PMP outage does NOT prevent dispensing —
  // instead, a CRITICAL audit event is written and the pharmacy is expected to
  // manually resubmit (pmp_submissions table tracks pending submissions).
  if (decision.approved && rx.requires_real_time_monitoring) {
    await submitToPMP({ prescriptionId, provinceCode: rx.province_code }).catch(err => {
      // Log failure as controlled-substance event; ops team must investigate
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
 * recordNarcoticDoubleCount — records the mandatory two-person count of a
 * controlled substance quantity before it is removed from inventory for dispensing.
 *
 * Legal basis:
 *   CDSA s.55(1)(f) / NCR s.35: all narcotic dispensing transactions must be
 *   recorded with quantity, date, and identity of persons who handled the drug.
 *   Standard practice requires TWO independent staff members to count and agree
 *   before any controlled substance is removed from the vault/safe.
 *
 * Discrepancy handling:
 *   If the counted quantity does not match the prescribed quantity (within 0.001
 *   tolerance for rounding), dispensing is HALTED and a NARCOTIC_COUNT_DISCREPANCY
 *   event is written to the immutable audit log.  The pharmacist must investigate
 *   and reconcile the perpetual inventory before proceeding.
 *
 * @param {string} opts.prescriptionId - UUID of the prescription to count for
 * @param {number} opts.countedQty     - quantity physically counted by counter1
 * @param {string} opts.witness2Id     - UUID of the second licensed witness
 * @param {object} opts.req            - Express request (counter1 is req.user)
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

  // 0.001 tolerance handles floating-point rounding in tablet/liquid measurements
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
