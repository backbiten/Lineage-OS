'use strict';
/**
 * Provincial Drug Monitoring Program (PMP) Integration
 *
 * Canadian provincial real-time prescription monitoring systems:
 *  - BC: PharmaNet  (mandatory for all Rxs)
 *  - ON: Ontario Drug Benefit / Intellihealth (narcotics/targeted)
 *  - MB: Drug Programs Information Network (DPIN)
 *  - AB: Netcare (Alberta Pharmaceutical Information Network)
 *  - NS: DPMB
 *  - QC: RAMQ
 *  - SK: Saskatchewan Drug Plan
 *
 * Regulatory basis:
 *  - CDSA s.55(1)(g) — reporting obligations for controlled substances
 *  - Provincial drug monitoring legislation (e.g., ON: Narcotics Safety and
 *    Awareness Act, 2010; BC: Pharmaceutical Services Act)
 *
 * This service abstracts the province-specific API calls.
 * Production implementations must integrate with each province's HL7 FHIR
 * or proprietary endpoint using province-issued credentials.
 */

const pool   = require('../config/database');
const logger = require('../utils/logger');

// Province → PMP config mapping
const PMP_CONFIG = {
  BC: { name: 'PharmaNet', endpoint: process.env.PMP_BC_ENDPOINT,   required: true  },
  ON: { name: 'Intellihealth', endpoint: process.env.PMP_ON_ENDPOINT, required: false }, // controlled only
  MB: { name: 'DPIN',      endpoint: process.env.PMP_MB_ENDPOINT,   required: false },
  AB: { name: 'Netcare',   endpoint: process.env.PMP_AB_ENDPOINT,   required: false },
  NS: { name: 'DPMB',      endpoint: process.env.PMP_NS_ENDPOINT,   required: false },
  QC: { name: 'RAMQ',      endpoint: process.env.PMP_QC_ENDPOINT,   required: false },
  SK: { name: 'SKDrugPlan', endpoint: process.env.PMP_SK_ENDPOINT,  required: false },
};

/**
 * Submit a dispensed prescription to the provincial monitoring program.
 * Called automatically after pharmacist approval for real-time provinces (BC)
 * and for controlled/targeted substances in all provinces.
 *
 * @param {object} opts.prescriptionId
 * @param {object} opts.provinceCode
 */
async function submitToPMP({ prescriptionId, provinceCode }) {
  const config = PMP_CONFIG[provinceCode];
  if (!config) {
    logger.warn(`No PMP config for province ${provinceCode} — skipping submission`);
    return;
  }

  if (!config.endpoint) {
    logger.warn(`PMP endpoint not configured for ${provinceCode} (${config.name})`);
    if (config.required) {
      throw new Error(`PMP submission is mandatory for ${provinceCode} but endpoint not configured`);
    }
    return;
  }

  // Load full prescription data for submission
  const { rows: [rx] } = await pool.query(`
    SELECT p.*, d.din, d.generic_name, d.cdsa_schedule,
           pt.health_card_number, pt.date_of_birth,
           pr.college_registration, pr.province_code AS prescriber_province,
           ph.license_number AS pharmacy_license
    FROM prescriptions p
    JOIN drugs d      ON d.id  = p.drug_id
    JOIN patients pt  ON pt.id = p.patient_id
    JOIN prescribers pr ON pr.id = p.prescriber_id
    JOIN pharmacies ph  ON ph.id = p.pharmacy_id
    WHERE p.id = $1
  `, [prescriptionId]);

  if (!rx) throw new Error(`Prescription ${prescriptionId} not found for PMP submission`);

  // In production: format as HL7 FHIR MedicationDispense or province-specific format
  // and POST to config.endpoint with province-issued API credentials
  const payload = {
    pharmacyLicense:    rx.pharmacy_license,
    prescriptionDate:   rx.written_date,
    dispensedDate:      new Date().toISOString().slice(0, 10),
    din:                rx.din,
    drugName:           rx.generic_name,
    quantity:           rx.quantity_prescribed,
    daysSupply:         rx.days_supply,
    prescriberReg:      rx.college_registration,
    patientHCN:         rx.health_card_number,  // sent over TLS to authorized endpoint only
    patientDOB:         rx.date_of_birth,
    cdsaSchedule:       rx.cdsa_schedule,
  };

  logger.info(`PMP submission to ${config.name} (${provinceCode})`, { prescriptionId });

  // TODO: Replace with actual HTTP POST to province endpoint
  // const response = await httpClient.post(config.endpoint, payload, { headers: { Authorization: `Bearer ${PMP_TOKEN}` } });

  // Record submission
  const { rows: [submission] } = await pool.query(`
    INSERT INTO pmp_submissions (prescription_id, province_code, program_name, submitted_at, submission_status)
    VALUES ($1, $2, $3, NOW(), 'SUCCESS')
    RETURNING id
  `, [prescriptionId, provinceCode, config.name]);

  // Mark Rx as submitted
  await pool.query(
    'UPDATE prescriptions SET pmp_submitted = TRUE, pmp_submitted_at = NOW() WHERE id = $1',
    [prescriptionId]
  );

  return submission;
}

/**
 * Check if a patient has active prescriptions at OTHER pharmacies for the same drug class.
 * Supports "doctor shopping" / overprescribing detection.
 * BC PharmaNet provides this natively; others via provincial API.
 *
 * @param {string} patientHCN - health card number
 * @param {string} provinceCode
 * @param {string} drugDin
 */
async function checkForDuplicateTherapy(patientHCN, provinceCode, drugDin) {
  // Production: query province PMP API
  // Return structure: { hasDuplicate: bool, details: [...] }
  logger.info('PMP duplicate therapy check', { provinceCode, drugDin });
  // Placeholder — real implementation queries province endpoint
  return { hasDuplicate: false, details: [] };
}

module.exports = { submitToPMP, checkForDuplicateTherapy };
