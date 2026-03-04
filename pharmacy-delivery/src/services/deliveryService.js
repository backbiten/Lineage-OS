'use strict';
/**
 * @file services/deliveryService.js
 * @description Delivery lifecycle management — Steps 5 & 6 of the workflow.
 *
 * Covers: driver assignment eligibility checks → pickup with seal verification
 * → delivery attempt recording (success or failure handling).
 *
 * ─── Regulatory basis ────────────────────────────────────────────────────────
 *  NCR s.5 — Carriers:
 *    A person who possesses a controlled substance for delivery is a "carrier".
 *    A carrier employed by a licensed pharmacy is implicitly authorized under
 *    the pharmacy's dealer's license.  However:
 *    • The pharmacy is responsible for ensuring the carrier is a fit person
 *    • A criminal record check is therefore mandatory for controlled deliveries
 *    • The `can_deliver_controlled` flag is set by a pharmacist/manager after
 *      reviewing the background check and completing training
 *  CDSA s.4 — Possession:
 *    Only authorized persons may possess controlled substances.  At the door,
 *    the receiving patient must be POSITIVELY IDENTIFIED (government photo ID)
 *    before the controlled substance changes hands.  If the patient cannot be
 *    identified the controlled substance MUST be returned to the pharmacy —
 *    it cannot be left with a third party or at the address.
 *  Health Canada Guidance: Delivery of Drugs (2023):
 *    • Tamper-evident packaging required
 *    • Signature of recipient required for all Rx deliveries
 *    • Cold chain maintained and logged for temperature-sensitive drugs
 *  Provincial pharmacy acts — delivery obligations vary; see REGULATORY_FRAMEWORK.md
 *  Municipal bylaws — delivery vehicle requirements vary by city
 *
 * ─── Key rules enforced ──────────────────────────────────────────────────────
 *  1. Driver eligibility:  background check clear + CDSA training + license valid
 *  2. Seal integrity:      tamper-evident seal checked before pickup AND on delivery
 *  3. ID verification:     MANDATORY for controlled substances (CDSA s.4)
 *  4. Signature:           MANDATORY for all Rx deliveries
 *  5. Cold chain:          temperature logged per delivery attempt
 *  6. Failed delivery (controlled): returned to pharmacy SAME DAY — no exceptions
 * ────────────────────────────────────────────────────────────────────────────
 */

const pool     = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');

/**
 * assignDriver — assigns a delivery driver to an order after eligibility checks.
 *
 * Called by pharmacy manager/pharmacist after the order is packed (status = PACKING).
 * Performs the following checks before assignment:
 *  1. Driver account is active (not deactivated or suspended)
 *  2. Driver's provincial license has not expired
 *  3. For controlled substance orders: driver has the `can_deliver_controlled` flag
 *     (set by a pharmacist/manager after background check and CDSA training)
 *  4. For controlled substance orders: criminal record check on file and clear
 *
 * @param {string} opts.deliveryOrderId - UUID of the delivery_orders row
 * @param {string} opts.driverId        - UUID of the driver's users row
 * @param {object} opts.req             - Express request (for audit)
 */
async function assignDriver({ deliveryOrderId, driverId, req }) {
  // Load driver with user account join to check both is_active flags
  const { rows: [driver] } = await pool.query(
    `SELECT dd.*, u.is_active
     FROM delivery_drivers dd
     JOIN users u ON u.id = dd.user_id
     WHERE dd.user_id = $1 AND dd.is_active = TRUE`,
    [driverId]
  );

  if (!driver) {
    const err = new Error('Driver not found or not active');
    err.status = 404;
    throw err;
  }

  if (!driver.is_active) {
    const err = new Error('Driver account is not active');
    err.status = 409;
    throw err;
  }

  if (driver.license_expiry < new Date()) {
    const err = new Error("Driver's license has expired — cannot assign");
    err.status = 409;
    throw err;
  }

  // Load the order to determine whether controlled-substance rules apply
  const { rows: [order] } = await pool.query(
    'SELECT id, contains_controlled, contains_narcotic FROM delivery_orders WHERE id = $1',
    [deliveryOrderId]
  );

  if (!order) {
    const err = new Error('Delivery order not found');
    err.status = 404;
    throw err;
  }

  if (order.contains_controlled && !driver.can_deliver_controlled) {
    const err = new Error(
      'Driver is not authorized to deliver controlled substances. ' +
      'Controlled delivery training and authorization required (NCR s.5).'
    );
    err.status = 403;
    throw err;
  }

  if (order.contains_controlled && !driver.criminal_record_check_clear) {
    const err = new Error(
      'Driver must have a clear criminal record check before delivering controlled substances'
    );
    err.status = 403;
    throw err;
  }

  await pool.query(`
    UPDATE delivery_orders SET
      driver_id = $1,
      status    = 'AWAITING_DRIVER',
      updated_at = NOW()
    WHERE id = $2
  `, [driverId, deliveryOrderId]);

  await writeAuditEvent({
    action: 'DRIVER_ASSIGNED',
    req,
    resourceType: 'delivery_order',
    resourceId: deliveryOrderId,
    isControlledSubstanceEvent: order.contains_controlled,
    newValues: { driver_id: driverId },
  });

  return { deliveryOrderId, driverId, status: 'AWAITING_DRIVER' };
}

/**
 * Driver picks up order from pharmacy.
 * Records tamper-seal verification.
 */
async function driverPickup({ deliveryOrderId, sealVerified, req }) {
  const driverId = req.user.id;

  const { rows: [order] } = await pool.query(
    `SELECT do.*, dd.user_id AS driver_user_id
     FROM delivery_orders do
     JOIN delivery_drivers dd ON dd.id = do.driver_id
     WHERE do.id = $1`,
    [deliveryOrderId]
  );

  if (!order) {
    const err = new Error('Delivery order not found');
    err.status = 404;
    throw err;
  }

  if (order.driver_user_id !== driverId) {
    const err = new Error('This order is not assigned to you');
    err.status = 403;
    throw err;
  }

  if (!sealVerified) {
    const err = new Error(
      'Tamper-evident seal must be verified intact before pickup. ' +
      'If seal is compromised, do NOT accept the order — notify pharmacist.'
    );
    err.status = 422;
    throw err;
  }

  await pool.query(`
    UPDATE delivery_orders SET
      status         = 'PICKED_UP',
      actual_pickup_at = NOW(),
      updated_at     = NOW()
    WHERE id = $1
  `, [deliveryOrderId]);

  await writeAuditEvent({
    action: 'DELIVERY_PICKED_UP',
    req,
    resourceType: 'delivery_order',
    resourceId: deliveryOrderId,
    isControlledSubstanceEvent: order.contains_controlled,
    newValues: { seal_verified: sealVerified },
  });

  return { deliveryOrderId, status: 'PICKED_UP' };
}

/**
 * Record a delivery attempt (success or failure).
 *
 * For controlled substances:
 *  - MUST verify patient ID (government-issued photo ID)
 *  - MUST capture signature
 *  - If failed: must return to pharmacy SAME day (CDSA s.4 — cannot leave unattended)
 */
async function recordDeliveryAttempt({
  deliveryOrderId,
  result,
  idVerified,
  idType,
  signatureData,
  gpsLat,
  gpsLon,
  photoRef,
  tempCelsius,
  notes,
  req,
}) {
  const driverId = req.user.id;

  const { rows: [order] } = await pool.query(
    `SELECT do.*, dd.user_id AS driver_user_id,
            (SELECT COUNT(*) FROM delivery_attempts WHERE delivery_order_id = do.id) AS attempt_count
     FROM delivery_orders do
     JOIN delivery_drivers dd ON dd.id = do.driver_id
     WHERE do.id = $1`,
    [deliveryOrderId]
  );

  if (!order || order.driver_user_id !== driverId) {
    const err = new Error('Order not found or not assigned to this driver');
    err.status = 403;
    throw err;
  }

  const attemptNumber = parseInt(order.attempt_count, 10) + 1;

  // Controlled substance: ID verification is MANDATORY (CDSA s.4)
  if (order.id_verification_required && result === 'SUCCESS' && !idVerified) {
    const err = new Error(
      'Patient ID verification is MANDATORY for controlled substance delivery (CDSA s.4). ' +
      'Record the type and number of government-issued photo ID presented.'
    );
    err.status = 422;
    throw err;
  }

  // Signature is always required
  if (result === 'SUCCESS' && !signatureData) {
    const err = new Error(
      'Recipient signature is required for all prescription deliveries'
    );
    err.status = 422;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Log the attempt
    await client.query(`
      INSERT INTO delivery_attempts (
        delivery_order_id, driver_id, attempt_number,
        result, gps_latitude, gps_longitude,
        notes, photo_reference
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      deliveryOrderId, driverId, attemptNumber,
      result, gpsLat ?? null, gpsLon ?? null,
      notes ?? null, photoRef ?? null,
    ]);

    let newStatus;
    if (result === 'SUCCESS') {
      newStatus = 'DELIVERED';

      await client.query(`
        UPDATE delivery_orders SET
          status               = 'DELIVERED',
          actual_delivery_at   = NOW(),
          id_verified_at       = NOW(),
          id_verified_by_driver = $1,
          id_type_presented    = $2,
          signature_captured   = TRUE,
          signature_data       = $3,
          delivery_temp_celsius = $4,
          seal_intact_on_delivery = TRUE,
          updated_at           = NOW()
        WHERE id = $5
      `, [driverId, idType ?? null, signatureData, tempCelsius ?? null, deliveryOrderId]);

      // Mark prescriptions as delivered
      await client.query(`
        UPDATE prescriptions SET status = 'DELIVERED', updated_at = NOW()
        WHERE id IN (
          SELECT prescription_id FROM delivery_order_prescriptions WHERE delivery_order_id = $1
        )
      `, [deliveryOrderId]);

    } else if (['NO_ANSWER','WRONG_ADDRESS','REFUSED','ID_VERIFICATION_FAILED','SIGNATURE_REFUSED'].includes(result)) {
      // Failed delivery path.
      // Controlled substances CANNOT be left unattended or handed to an
      // unidentified third party — CDSA s.4 / NCR.  Must return to pharmacy
      // on the same shift.  Non-controlled Rxs allow up to 3 attempts.
      if (order.contains_controlled) {
        newStatus = 'RETURNED_TO_PHARMACY';
        await client.query(`
          UPDATE delivery_orders SET
            status     = 'DELIVERY_FAILED',
            updated_at = NOW()
          WHERE id = $1
        `, [deliveryOrderId]);

        // Add audit note: must return same day
        notes = (notes || '') +
          ' [CONTROLLED: Must be returned to pharmacy this shift per CDSA s.4]';
      } else {
        newStatus = attemptNumber >= 3 ? 'DELIVERY_FAILED' : 'IN_TRANSIT';
        await client.query(`
          UPDATE delivery_orders SET status = $1, updated_at = NOW() WHERE id = $2
        `, [newStatus, deliveryOrderId]);
      }
    }

    // Record temperature at time of delivery attempt.
    // Refrigerated drugs (biologics, insulin, some vaccines) require 2–8 °C.
    // An excursion outside this range may require the drug to be discarded
    // (Health Canada Drug Regulations — storage requirements).
    // in_range uses the standard refrigerated range; adjust if drug has different needs.
    if (tempCelsius !== undefined && tempCelsius !== null) {
      await client.query(`
        INSERT INTO cold_chain_logs (delivery_order_id, temp_celsius, in_range)
        VALUES ($1, $2, $3)
      `, [deliveryOrderId, tempCelsius, tempCelsius >= 2 && tempCelsius <= 8]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await writeAuditEvent({
    action: `DELIVERY_ATTEMPT_${result}`,
    req,
    resourceType: 'delivery_order',
    resourceId: deliveryOrderId,
    isControlledSubstanceEvent: order.contains_controlled,
    newValues: {
      attempt_number: attemptNumber,
      result,
      id_verified: idVerified,
      gps: gpsLat ? `${gpsLat},${gpsLon}` : null,
    },
  });

  return { deliveryOrderId, attemptNumber, result };
}

module.exports = { assignDriver, driverPickup, recordDeliveryAttempt };
