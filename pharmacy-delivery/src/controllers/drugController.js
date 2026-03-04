'use strict';
/**
 * @file controllers/drugController.js
 * @description Drug/medication search and lookup endpoints.
 *
 * Supports:
 *   • Full-text search by brand name, generic name, or DIN
 *   • Filter by CDSA schedule (controlled substance classification)
 *   • Filter by storage condition (cold chain, refrigerated, etc.)
 *   • Detail view by UUID or DIN
 *   • Controlled substance flag (narcotics, targeted substances)
 *
 * ─── Access control ───────────────────────────────────────────────────────────
 *  Drug lookup is accessible to all authenticated roles.
 *  CDSA schedule and narcotic flag data is visible to all pharmacy staff.
 *  Patients receive a simplified view (no regulatory classifications).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { query: queryValidator, validationResult } = require('express-validator');
const pool = require('../config/database');

// ── Validation ────────────────────────────────────────────────────────────────

const searchValidation = [
  queryValidator('q').optional().isString().trim().isLength({ min: 2, max: 120 }),
  queryValidator('cdsa_schedule').optional().isString(),
  queryValidator('is_narcotic').optional().isBoolean(),
  queryValidator('storage_condition').optional().isString(),
  queryValidator('fda_schedule').optional().isString(),
  queryValidator('limit').optional().isInt({ min: 1, max: 100 }),
  queryValidator('page').optional().isInt({ min: 1 }),
];

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /drugs
 * Search drugs by name or DIN. Supports multiple filters.
 */
async function searchDrugs(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const {
    q,
    cdsa_schedule,
    is_narcotic,
    storage_condition,
    fda_schedule,
    limit = 25,
    page  = 1,
  } = req.query;

  const conditions = ['1=1'];
  const params     = [];
  let   idx        = 1;

  if (q) {
    // Full-text search across brand name, generic name, and DIN
    conditions.push(`(
      brand_name   ILIKE $${idx}   OR
      generic_name ILIKE $${idx}   OR
      din          ILIKE $${idx}
    )`);
    params.push(`%${q}%`);
    idx++;
  }

  if (cdsa_schedule) {
    conditions.push(`cdsa_schedule = $${idx++}`);
    params.push(cdsa_schedule);
  }

  if (is_narcotic !== undefined) {
    conditions.push(`is_narcotic = $${idx++}`);
    params.push(is_narcotic === 'true');
  }

  if (storage_condition) {
    conditions.push(`storage_condition = $${idx++}`);
    params.push(storage_condition);
  }

  if (fda_schedule) {
    conditions.push(`fda_schedule = $${idx++}`);
    params.push(fda_schedule);
  }

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

  // Patients get a simplified view without regulatory classification details
  const isPatient = req.user.role === 'PATIENT';

  const selectCols = isPatient
    ? 'id, din, brand_name, generic_name, dosage_form, strength, unit, storage_condition, requires_cold_chain'
    : `id, din, brand_name, generic_name, manufacturer, dosage_form, strength, unit,
       cdsa_schedule, fda_schedule, is_narcotic, is_targeted_substance, narcotic_code,
       storage_condition, requires_cold_chain, requires_triplicate, requires_real_time_monitoring,
       created_at`;

  const { rows } = await pool.query(`
    SELECT ${selectCols}
    FROM drugs
    WHERE ${conditions.join(' AND ')}
    ORDER BY generic_name, brand_name
    LIMIT $${idx++} OFFSET $${idx++}
  `, [...params, parseInt(limit, 10), offset]);

  const { rows: [{ count }] } = await pool.query(
    `SELECT COUNT(*) FROM drugs WHERE ${conditions.join(' AND ')}`,
    params
  );

  res.json({
    drugs: rows,
    total: parseInt(count, 10),
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
  });
}

/**
 * GET /drugs/:id
 * Drug detail by UUID.
 */
async function getDrugById(req, res) {
  const { rows: [drug] } = await pool.query(
    'SELECT * FROM drugs WHERE id = $1', [req.params.id]
  );
  if (!drug) return res.status(404).json({ error: 'Drug not found' });

  // Strip regulatory details from patient view
  if (req.user.role === 'PATIENT') {
    const { id, din, brand_name, generic_name, dosage_form, strength, unit,
            storage_condition, requires_cold_chain } = drug;
    return res.json({ id, din, brand_name, generic_name, dosage_form, strength, unit,
                      storage_condition, requires_cold_chain });
  }

  res.json(drug);
}

/**
 * GET /drugs/din/:din
 * Drug detail by Health Canada DIN. Used during prescription intake.
 */
async function getDrugByDin(req, res) {
  const { rows: [drug] } = await pool.query(
    'SELECT * FROM drugs WHERE din = $1', [req.params.din]
  );
  if (!drug) return res.status(404).json({ error: 'Drug not found for DIN' });

  res.json(drug);
}

/**
 * GET /drugs/:id/inventory
 * Check inventory levels for a drug across pharmacy locations.
 * Restricted to pharmacy staff.
 */
async function getDrugInventory(req, res) {
  const { pharmacy_id } = req.query;

  const conditions = ['i.drug_id = $1'];
  const params     = [req.params.id];
  let idx = 2;

  if (pharmacy_id) {
    conditions.push(`i.pharmacy_id = $${idx++}`);
    params.push(pharmacy_id);
  }

  const { rows } = await pool.query(`
    SELECT
      i.id AS inventory_id,
      i.lot_number, i.expiry_date, i.quantity_on_hand, i.unit,
      i.storage_location, i.current_temp_celsius, i.last_temp_check_at,
      i.received_date, i.received_from,
      ph.name AS pharmacy_name, ph.address_city
    FROM inventory i
    JOIN pharmacies ph ON ph.id = i.pharmacy_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY i.expiry_date ASC
  `, params);

  res.json({ inventory: rows });
}

module.exports = {
  searchDrugs,
  searchValidation,
  getDrugById,
  getDrugByDin,
  getDrugInventory,
};
