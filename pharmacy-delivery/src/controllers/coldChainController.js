'use strict';
/**
 * @file controllers/coldChainController.js
 * @description Cold chain monitoring — IoT sensor temperature readings and excursion alerts.
 *
 * ─── Regulatory basis ────────────────────────────────────────────────────────
 *  Health Canada Drug Regulations (C.01.027 to C.01.042):
 *    Cold chain drugs (vaccines, biologics, insulins) must be stored and
 *    transported within validated temperature ranges. Any excursion must be
 *    documented and the drug assessed for continued use or disposal.
 *
 *  USP <1> / ICH Q1A(R2):
 *    Temperature excursions invalidate stability data.  A pharmacist must
 *    review any excursion before the drug is dispensed.
 *
 *  Acceptable ranges enforced:
 *    • REFRIGERATED:     2–8°C
 *    • COOL:             8–15°C
 *    • ROOM_TEMPERATURE: 15–25°C
 *    • FROZEN:           ≤ −15°C
 *
 *  Excursion = reading outside accepted range → alert sent to pharmacy manager.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { body, validationResult } = require('express-validator');
const pool   = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');
const { notifyLowInventory } = require('../services/notificationService');
const logger = require('../utils/logger');

// Temperature ranges (°C) per storage condition
const TEMP_RANGES = {
  REFRIGERATED:     { min: 2,    max: 8   },
  COOL:             { min: 8,    max: 15  },
  ROOM_TEMPERATURE: { min: 15,   max: 25  },
  FROZEN:           { min: -40,  max: -15 },
};

// ── Validation ────────────────────────────────────────────────────────────────

const logTempValidation = [
  body('delivery_order_id').isUUID(),
  body('temp_celsius').isFloat({ min: -80, max: 60 }),
  body('humidity_pct').optional().isFloat({ min: 0, max: 100 }),
  body('device_id').optional().isString().trim(),
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isInRange(tempCelsius, storageCondition) {
  const range = TEMP_RANGES[storageCondition];
  if (!range) return true;  // unknown condition — let pharmacist assess
  return tempCelsius >= range.min && tempCelsius <= range.max;
}

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /cold-chain/log
 * IoT sensor or driver posts a temperature reading for an in-transit order.
 * Records the reading; flags excursions and sends an alert to pharmacy manager.
 */
async function logTemperature(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { delivery_order_id, temp_celsius, humidity_pct, device_id } = req.body;

  // Load the delivery order and determine the drugs' storage requirements
  const { rows: [order] } = await pool.query(`
    SELECT do.id, do.pharmacy_id, do.status,
           ph.name AS pharmacy_name, ph.email AS pharmacy_email
    FROM delivery_orders do
    JOIN pharmacies ph ON ph.id = do.pharmacy_id
    WHERE do.id = $1
  `, [delivery_order_id]);

  if (!order) return res.status(404).json({ error: 'Delivery order not found' });

  // Determine required storage condition from the drugs in this order
  const { rows: drugs } = await pool.query(`
    SELECT DISTINCT d.storage_condition
    FROM delivery_order_prescriptions dop
    JOIN prescriptions p ON p.id = dop.prescription_id
    JOIN drugs d ON d.id = p.drug_id
    WHERE dop.delivery_order_id = $1
      AND d.requires_cold_chain = TRUE
  `, [delivery_order_id]);

  // Most restrictive storage condition determines the required range
  // Priority: FROZEN > REFRIGERATED > COOL > ROOM_TEMPERATURE
  const conditionPriority = ['FROZEN', 'REFRIGERATED', 'COOL', 'ROOM_TEMPERATURE'];
  const requiredCondition = drugs.length > 0
    ? conditionPriority.find(c => drugs.some(d => d.storage_condition === c))
    : null;

  const inRange = requiredCondition ? isInRange(temp_celsius, requiredCondition) : true;
  const excursionAlert = !inRange;

  // Write to cold_chain_logs
  const { rows: [log] } = await pool.query(`
    INSERT INTO cold_chain_logs
      (delivery_order_id, temp_celsius, humidity_pct, device_id, in_range, excursion_alert)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, recorded_at
  `, [delivery_order_id, temp_celsius, humidity_pct || null, device_id || null, inRange, excursionAlert]);

  // Update the delivery order's current temp
  await pool.query(`
    UPDATE delivery_orders SET delivery_temp_celsius = $1 WHERE id = $2
  `, [temp_celsius, delivery_order_id]);

  // Log excursions to audit trail and notify pharmacy manager
  if (excursionAlert) {
    const range = TEMP_RANGES[requiredCondition];

    await writeAuditEvent({
      action: 'COLD_CHAIN_EXCURSION',
      req,
      resourceType: 'delivery_order',
      resourceId: delivery_order_id,
      isControlledSubstanceEvent: false,
      newValues: {
        temp_celsius,
        required_condition: requiredCondition,
        allowed_min: range.min,
        allowed_max: range.max,
      },
    });

    // Notify pharmacy manager — drug may need assessment
    if (order.pharmacy_email) {
      await notifyLowInventory({
        email: order.pharmacy_email,
        drugName: `Cold chain drugs in order #${delivery_order_id.slice(-8)}`,
        quantityOnHand: 0,
        unit: `°C (current: ${temp_celsius}°C, required: ${range.min}–${range.max}°C)`,
        pharmacyName: order.pharmacy_name,
      }).catch(err => logger.error({ msg: 'Cold chain alert email failed', err: err.message }));
    }

    logger.warn({
      msg: 'Cold chain excursion detected',
      delivery_order_id,
      temp_celsius,
      required_condition: requiredCondition,
      range,
    });
  }

  res.status(201).json({
    log_id: log.id,
    recorded_at: log.recorded_at,
    temp_celsius,
    in_range: inRange,
    excursion_alert: excursionAlert,
    required_condition: requiredCondition,
    allowed_range: requiredCondition ? TEMP_RANGES[requiredCondition] : null,
    message: excursionAlert
      ? `EXCURSION ALERT: Temperature ${temp_celsius}°C is outside the required range for ${requiredCondition}. Pharmacy manager has been notified.`
      : 'Temperature reading recorded. Within acceptable range.',
  });
}

/**
 * GET /cold-chain/:delivery_order_id/log
 * Retrieve temperature log for a delivery order. Staff only.
 */
async function getTempLog(req, res) {
  const { delivery_order_id } = req.params;

  const { rows } = await pool.query(`
    SELECT id, recorded_at, temp_celsius, humidity_pct, device_id, in_range, excursion_alert
    FROM cold_chain_logs
    WHERE delivery_order_id = $1
    ORDER BY recorded_at ASC
  `, [delivery_order_id]);

  const excursions = rows.filter(r => r.excursion_alert).length;

  res.json({
    delivery_order_id,
    readings: rows,
    total_readings: rows.length,
    excursion_count: excursions,
    cold_chain_maintained: excursions === 0,
  });
}

module.exports = {
  logTemperature,
  logTempValidation,
  getTempLog,
};
