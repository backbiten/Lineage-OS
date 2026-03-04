'use strict';
/**
 * Pharmacy Technician Workflow Service
 *
 * The pharmacy technician (RPhT) is the FIRST and PRIMARY touchpoint for all
 * prescription intake in this platform. No prescription enters the dispensing
 * queue without technician intake first.
 *
 * Regulatory basis:
 *  - NAPRA Model Standards of Practice for Canadian Pharmacists & Technicians (2022)
 *  - Health Canada: "Standards for the Practice of Pharmacy" (2023)
 *  - Provincial pharmacy acts — scope of practice for RPhTs
 *  - CDSA: technicians may ASSIST with controlled substances but pharmacist
 *    must provide FINAL verification for ALL controlled substance Rxs
 *
 * Technician scope of practice (national, per NAPRA):
 *  ✓ Receive and interpret prescriptions
 *  ✓ Data entry and prescription processing
 *  ✓ Drug preparation and compounding (under RPh supervision)
 *  ✓ Labelling
 *  ✓ Patient identity confirmation
 *  ✓ Allergy and drug interaction checks (alert generation — RPh reviews)
 *  ✗ Clinical judgment / therapeutic decisions
 *  ✗ Final verification of controlled substances (RPh mandatory)
 *  ✗ Patient counselling on drug therapy (RPh role)
 */

const pool       = require('../config/database');
const { validatePrescription } = require('./prescriptionValidation');
const { writeAuditEvent }      = require('../utils/audit');
const { v4: uuid }             = require('uuid');

/**
 * Step 1 — Technician Intake
 * Creates the prescription record and technician_intake_log entry.
 * Routes to pharmacist queue automatically for all controlled substances.
 *
 * @param {object} opts.rx         - raw prescription fields from request
 * @param {object} opts.drug       - drug record
 * @param {object} opts.patient    - patient record
 * @param {object} opts.prescriber - prescriber record
 * @param {object} opts.pharmacy   - pharmacy record
 * @param {object} opts.req        - Express request (for audit actor)
 * @returns {object} created prescription record
 */
async function technicianIntake({ rx, drug, patient, prescriber, pharmacy, req }) {
  const technicianId = req.user.id;

  // Validate prescription before touching DB
  const validation = await validatePrescription(rx, drug, prescriber, patient);

  if (!validation.valid) {
    await writeAuditEvent({
      action: 'PRESCRIPTION_INTAKE_REJECTED',
      req,
      resourceType: 'prescription',
      isControlledSubstanceEvent: drug.is_narcotic,
      success: false,
      failureReason: validation.errors.join('; '),
      newValues: { rx_number: rx.rx_number, drug_din: drug.din, errors: validation.errors },
    });
    const err = new Error('Prescription failed validation');
    err.status = 422;
    err.details = validation;
    throw err;
  }

  // Use a provided Rx number (e.g., from paper Rx) or generate one locally
  const rxNumber     = rx.rx_number || generateRxNumber(pharmacy.id);
  const isControlled = drug.cdsa_schedule !== 'NOT_CONTROLLED';
  const isNarcotic   = drug.is_narcotic;

  // Use a manual transaction so that the prescription row and the intake log
  // row are always created together — or neither is (atomicity).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create the prescription record (status = TECHNICIAN_REVIEW so it lands
    // in both the technician queue and, after routing, the pharmacist queue)
    const { rows: [prescription] } = await client.query(`
      INSERT INTO prescriptions (
        rx_number, patient_id, prescriber_id, pharmacy_id, drug_id,
        written_date, received_date, expiry_date,
        quantity_prescribed, quantity_unit, days_supply, directions,
        refills_authorized, refills_remaining,
        is_controlled, cdsa_schedule,
        rx_original_received, rx_paper_id,
        status, received_by_tech_id
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6, CURRENT_DATE, $7,
        $8,$9,$10,$11,
        $12,$12,
        $13,$14,
        $15,$16,
        'TECHNICIAN_REVIEW',$17
      ) RETURNING *
    `, [
      rxNumber, patient.id, prescriber.id, pharmacy.id, drug.id,
      rx.written_date, rx.expiry_date,
      rx.quantity_prescribed, rx.quantity_unit, rx.days_supply || null, rx.directions,
      rx.refills_authorized || 0,
      isControlled, drug.cdsa_schedule,
      rx.rx_original_received ?? false, rx.rx_paper_id || null,
      technicianId,
    ]);

    // Record the technician's intake checklist (NAPRA s.3.0).
    // This is the formal record that the RPhT completed each required step.
    // requires_pharmacist_review is ALWAYS true — there are no exceptions.
    await client.query(`
      INSERT INTO technician_intake_log (
        prescription_id, technician_id,
        patient_identity_confirmed,
        allergy_check_performed,
        drug_interaction_check,
        prescriber_valid,
        rx_not_expired,
        rx_not_forged_flags,
        controlled_substance_flags,
        double_count_required,
        original_rx_obtained,
        notes,
        requires_pharmacist_review
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      prescription.id, technicianId,
      rx.intake?.patient_identity_confirmed ?? false,
      rx.intake?.allergy_check_performed    ?? false,
      rx.intake?.drug_interaction_check     ?? false,
      true,  // prescriber validated by validatePrescription above
      true,  // expiry validated above
      rx.intake?.rx_not_forged_flags  || null,
      validation.warnings.join('; ')  || null,
      isNarcotic,   // double-count always required for narcotics
      rx.rx_original_received ?? false,
      rx.intake?.notes || null,
      true,  // ALWAYS requires pharmacist review — NAPRA standard
    ]);

    await client.query('COMMIT');

    await writeAuditEvent({
      action: 'PRESCRIPTION_INTAKE_COMPLETED',
      req,
      resourceType: 'prescription',
      resourceId: prescription.id,
      isControlledSubstanceEvent: isControlled,
      newValues: {
        rx_number:    rxNumber,
        drug_schedule: drug.cdsa_schedule,
        is_narcotic:  isNarcotic,
        warnings:     validation.warnings,
      },
    });

    return { prescription, validation };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Step 2 — Technician labels and packs order for delivery.
 * Can only be called AFTER pharmacist has approved (status = 'APPROVED' or 'FILLED').
 * Technician creates the delivery order and records tamper-evident seal number.
 *
 * @param {object} opts.prescriptionIds - array of UUIDs
 * @param {object} opts.deliveryDetails - { address, patientId, pharmacyId, sealNumber, … }
 * @param {object} opts.req
 */
async function technicianPackAndCreateDelivery({ prescriptionIds, deliveryDetails, req }) {
  const technicianId = req.user.id;

  // Verify all prescriptions are pharmacist-approved
  const { rows: rxRows } = await pool.query(
    `SELECT id, status, is_controlled, contains_narcotic
     FROM prescriptions
     WHERE id = ANY($1::uuid[])`,
    [prescriptionIds]
  );

  const notApproved = rxRows.filter(r =>
    !['APPROVED', 'FILLED', 'PARTIALLY_FILLED'].includes(r.status)
  );
  if (notApproved.length) {
    const err = new Error(
      `Prescriptions must be pharmacist-approved before packing: ` +
      notApproved.map(r => r.id).join(', ')
    );
    err.status = 409;
    throw err;
  }

  const containsControlled = rxRows.some(r => r.is_controlled);
  const containsNarcotic   = rxRows.some(r => r.contains_narcotic);

  // Pharmacist must release controlled substances for delivery — enforce that
  // the pharmacy_id-level released_by_rph_id is set before packing
  if (containsControlled && !deliveryDetails.releasedByRphId) {
    const err = new Error(
      'A licensed pharmacist must authorize release of controlled substances for delivery ' +
      'before technician can pack (CDSA / Narcotic Control Regulations)'
    );
    err.status = 403;
    throw err;
  }

  const orderNumber = `DEL-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [order] } = await client.query(`
      INSERT INTO delivery_orders (
        order_number, pharmacy_id, patient_id,
        status,
        delivery_address_street, delivery_address_city,
        delivery_address_postal, delivery_address_province,
        delivery_notes,
        contains_controlled, contains_narcotic,
        id_verification_required,
        signature_required,
        tamper_evident_seal,
        released_by_rph_id, released_at,
        packed_by_tech_id, packed_at
      ) VALUES (
        $1,$2,$3,
        'PACKING',
        $4,$5,$6,$7,$8,
        $9,$10,
        $11,
        TRUE,
        $12,
        $13, NOW(),
        $14, NOW()
      ) RETURNING *
    `, [
      orderNumber, deliveryDetails.pharmacyId, deliveryDetails.patientId,
      deliveryDetails.street, deliveryDetails.city,
      deliveryDetails.postal, deliveryDetails.province,
      deliveryDetails.notes || null,
      containsControlled, containsNarcotic,
      containsControlled,  // ID verification required for controlled substances
      deliveryDetails.sealNumber || null,
      deliveryDetails.releasedByRphId || null,
      technicianId,
    ]);

    // Link prescriptions to delivery order
    for (const rxId of prescriptionIds) {
      await client.query(
        'INSERT INTO delivery_order_prescriptions (delivery_order_id, prescription_id) VALUES ($1,$2)',
        [order.id, rxId]
      );
      // Update prescription status
      await client.query(
        `UPDATE prescriptions SET status = 'READY_FOR_DELIVERY', updated_at = NOW() WHERE id = $1`,
        [rxId]
      );
    }

    await client.query('COMMIT');

    await writeAuditEvent({
      action: 'DELIVERY_ORDER_PACKED',
      req,
      resourceType: 'delivery_order',
      resourceId: order.id,
      isControlledSubstanceEvent: containsControlled,
      newValues: {
        order_number:      orderNumber,
        prescription_ids:  prescriptionIds,
        contains_narcotic: containsNarcotic,
        seal_number:       deliveryDetails.sealNumber,
      },
    });

    return order;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * generateRxNumber — creates a unique Rx tracking number for internally
 * originated prescriptions (e.g., electronic transfer cases where no paper
 * Rx number exists).
 *
 * Format: {4-char pharmacy UUID prefix}-{YYYYMMDD}-{5-digit sequence}
 * Example: A3F2-20260304-04721
 *
 * NOTE: For narcotics the original paper Rx number should be used wherever
 * possible and stored in rx_paper_id for traceability.
 */
function generateRxNumber(pharmacyId) {
  const prefix = pharmacyId.slice(0, 4).toUpperCase();  // e.g. "A3F2"
  const date   = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // "20260304"
  const seq    = Math.floor(Math.random() * 99999).toString().padStart(5, '0');
  return `${prefix}-${date}-${seq}`;
}

module.exports = { technicianIntake, technicianPackAndCreateDelivery };
