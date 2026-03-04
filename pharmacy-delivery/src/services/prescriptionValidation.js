'use strict';
/**
 * Prescription Validation Engine
 *
 * Regulatory basis:
 *  - Narcotic Control Regulations (NCR), SOR/2012-230, s.31
 *  - Food and Drugs Act, R.S.C. 1985, c. F-27, s.29.1
 *  - NAPRA Model Standards of Practice (2022)
 *  - Provincial pharmacy acts (ON: DPRA; BC: PODSA; AB: Pharmacy and Drug Act)
 *  - Health Canada — Guidance on Controlled Substances (2023)
 *
 * Validates a raw prescription object before it enters the workflow.
 * Returns { valid: bool, errors: string[], warnings: string[] }
 */

const pool = require('../config/database');

// Narcotic Control Regulations s.31 — mandatory fields for narcotic prescriptions
const NCR_REQUIRED_FIELDS = [
  'patient_name',
  'patient_address',       // NCR s.31(1)(b)
  'drug_name',
  'drug_strength',
  'quantity_prescribed',   // NCR s.31(1)(d) — must be in words OR figures
  'directions',
  'prescriber_name',
  'prescriber_address',    // NCR s.31(1)(f)
  'prescriber_signature',  // NCR s.31(1)(g) — MUST be handwritten original
  'written_date',
];

// Maximum legal supply (days) per drug class — Health Canada guidelines
const MAX_SUPPLY_DAYS = {
  NOT_CONTROLLED:    365,
  SCHEDULE_I:         30,  // narcotics — NCR limits
  SCHEDULE_II:        30,
  SCHEDULE_III:       90,
  SCHEDULE_IV:        30,  // benzodiazepines — targeted substances
  TARGETED_SUBSTANCE: 30,
};

/**
 * Validate a prescription before technician intake.
 *
 * @param {object} rx - raw prescription data from request body
 * @param {object} drug - drug record from DB
 * @param {object} prescriber - prescriber record from DB
 * @param {object} patient - patient record from DB
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
async function validatePrescription(rx, drug, prescriber, patient) {
  const errors   = [];
  const warnings = [];

  // ── 1. Patient age verification ──────────────────────────────────────────
  if (patient.date_of_birth) {
    const ageYears = (Date.now() - new Date(patient.date_of_birth)) / (365.25 * 24 * 3600 * 1000);
    if (ageYears < 0 || ageYears > 130) {
      errors.push('Patient date of birth is invalid');
    }
  } else {
    errors.push('Patient date of birth is required');
  }

  // ── 2. Prescriber authorization ──────────────────────────────────────────
  if (!prescriber.is_active) {
    errors.push(`Prescriber ${prescriber.last_name} is not active in system`);
  }
  if (drug.is_narcotic && !prescriber.controlled_sub_authorised) {
    errors.push(
      `Prescriber is not authorized to prescribe narcotics under the ` +
      `Narcotic Control Regulations (SOR/2012-230). ` +
      `Verify with ${prescriber.province_code} college before dispensing.`
    );
  }

  // ── 3. Prescription date validity ────────────────────────────────────────
  const writtenDate = new Date(rx.written_date);
  const today       = new Date();
  const expiryDate  = new Date(rx.expiry_date);

  if (isNaN(writtenDate.getTime())) {
    errors.push('Prescription written date is invalid');
  } else if (writtenDate > today) {
    errors.push('Prescription written date is in the future');
  } else {
    const ageDays = (today - writtenDate) / (24 * 3600 * 1000);
    // Narcotic Rxs: generally honoured as written, but warn if old
    if (drug.is_narcotic && ageDays > 30) {
      warnings.push(`Narcotic prescription is ${Math.floor(ageDays)} days old — verify with pharmacist`);
    }
    // Non-narcotic: typical 1-year expiry under most provincial acts
    if (!drug.is_narcotic && ageDays > 365) {
      errors.push('Prescription is older than 1 year and has expired under provincial pharmacy act');
    }
  }

  if (expiryDate < today) {
    errors.push('Prescription has expired');
  }

  // ── 4. Quantity limits ───────────────────────────────────────────────────
  const maxDays = MAX_SUPPLY_DAYS[drug.cdsa_schedule] ?? MAX_SUPPLY_DAYS.NOT_CONTROLLED;
  if (rx.days_supply && rx.days_supply > maxDays) {
    errors.push(
      `Days supply (${rx.days_supply}) exceeds maximum allowed (${maxDays} days) ` +
      `for ${drug.cdsa_schedule} under Health Canada guidelines`
    );
  }

  // Narcotic quantity: NCR s.31 — quantity in words or figures
  if (drug.is_narcotic) {
    if (!rx.quantity_prescribed || rx.quantity_prescribed <= 0) {
      errors.push('Narcotic prescription must specify a positive quantity (NCR s.31(1)(d))');
    }
    if (rx.quantity_prescribed > 1000) {
      warnings.push('Narcotic quantity appears unusually high — flag for pharmacist review');
    }
  }

  // ── 5. NCR mandatory fields check for narcotics ─────────────────────────
  if (drug.is_narcotic || drug.cdsa_schedule === 'SCHEDULE_I') {
    for (const field of NCR_REQUIRED_FIELDS) {
      if (!rx[field] && !patient[field] && !prescriber[field]) {
        // We check across rx + related records
        if (!rx[field]) {
          errors.push(`Narcotic Rx missing required field: ${field} (NCR s.31)`);
        }
      }
    }
    // NCR s.31(2): verbal/fax/electronic Rxs for narcotics PROHIBITED
    if (rx.rx_type === 'VERBAL' || rx.rx_type === 'FAX' || rx.rx_type === 'ELECTRONIC') {
      errors.push(
        `Narcotic prescriptions MUST be presented as original written documents. ` +
        `Verbal, fax, and electronic prescriptions are prohibited under ` +
        `Narcotic Control Regulations s.31(2).`
      );
    }
    if (!rx.rx_original_received) {
      errors.push('Original written prescription must be on file for narcotics (NCR s.31)');
    }
  }

  // ── 6. Refill rules ──────────────────────────────────────────────────────
  if (drug.is_narcotic && (rx.refills_authorized ?? 0) > 0) {
    errors.push(
      'Narcotic prescriptions CANNOT be refilled — ' +
      'a new prescription is required each time (NCR s.31(3))'
    );
  }

  if (drug.is_targeted_substance && (rx.refills_authorized ?? 0) > 5) {
    warnings.push('Benzodiazepine/targeted substance refill count exceeds typical provincial limits');
  }

  // ── 7. Drug-specific warnings ────────────────────────────────────────────
  if (drug.requires_real_time_monitoring) {
    warnings.push(
      `This drug requires real-time submission to the Provincial Drug ` +
      `Monitoring Program (PMP) before dispensing`
    );
  }

  // ── 8. Duplicate Rx check ────────────────────────────────────────────────
  const { rows: duplicates } = await pool.query(
    `SELECT id FROM prescriptions
     WHERE patient_id = $1
       AND drug_id    = $2
       AND written_date = $3
       AND status NOT IN ('CANCELLED','REJECTED','EXPIRED')
     LIMIT 1`,
    [patient.id, drug.id, rx.written_date]
  );
  if (duplicates.length) {
    warnings.push(
      `A prescription for this drug with the same written date already exists ` +
      `(ID: ${duplicates[0].id}). Verify this is not a duplicate submission.`
    );
  }

  return {
    valid:    errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = { validatePrescription };
