'use strict';
/**
 * @file controllers/deliveryController.js
 * @description HTTP handlers for the delivery workflow (Steps 4–6).
 *
 * Route → Service mapping:
 *   POST /orders                    → technicianPackAndCreateDelivery() (Step 4 — RPhT)
 *   POST /orders/:id/assign-driver  → assignDriver()                   (RPh/Manager)
 *   POST /orders/:id/pickup         → driverPickup()                   (Step 5 — Driver)
 *   POST /orders/:id/attempt        → recordDeliveryAttempt()          (Step 6 — Driver)
 *
 * Patient data access:
 *   Patients may only view their OWN delivery orders.  A sub-query confirms
 *   the requesting patient's UUID matches the order's patient_id before
 *   returning any data (access control enforced at controller level, not just role).
 */

const { assignDriver, driverPickup, recordDeliveryAttempt } = require('../services/deliveryService');
const { technicianPackAndCreateDelivery } = require('../services/technicianWorkflow');
const pool = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');

/**
 * POST /delivery/orders
 * Technician creates a delivery order after pharmacist approval.
 */
async function createDeliveryOrder(req, res) {
  const order = await technicianPackAndCreateDelivery({
    prescriptionIds: req.body.prescription_ids,
    deliveryDetails: {
      pharmacyId:      req.body.pharmacy_id,
      patientId:       req.body.patient_id,
      street:          req.body.delivery_address_street,
      city:            req.body.delivery_address_city,
      postal:          req.body.delivery_address_postal,
      province:        req.body.delivery_address_province,
      notes:           req.body.delivery_notes,
      sealNumber:      req.body.tamper_evident_seal,
      releasedByRphId: req.body.released_by_rph_id,
    },
    req,
  });

  res.status(201).json({
    message: 'Delivery order created',
    order_id:     order.id,
    order_number: order.order_number,
    status:       order.status,
    contains_controlled: order.contains_controlled,
    regulatory_note: order.contains_controlled
      ? 'This order contains controlled substances. ID verification and signature are mandatory at delivery (CDSA s.4).'
      : undefined,
  });
}

/**
 * POST /delivery/orders/:id/assign-driver
 * Pharmacy manager assigns a driver. Validates driver eligibility.
 */
async function assignDriverToOrder(req, res) {
  const result = await assignDriver({
    deliveryOrderId: req.params.id,
    driverId:        req.body.driver_id,
    req,
  });
  res.json(result);
}

/**
 * POST /delivery/orders/:id/pickup
 * Driver confirms pickup and seal integrity check.
 */
async function confirmPickup(req, res) {
  const result = await driverPickup({
    deliveryOrderId: req.params.id,
    sealVerified:    req.body.seal_verified,
    req,
  });
  res.json(result);
}

/**
 * POST /delivery/orders/:id/attempt
 * Driver records a delivery attempt (success or failure).
 */
async function recordAttempt(req, res) {
  const result = await recordDeliveryAttempt({
    deliveryOrderId: req.params.id,
    result:          req.body.result,
    idVerified:      req.body.id_verified,
    idType:          req.body.id_type,
    signatureData:   req.body.signature_data,
    gpsLat:          req.body.gps_lat,
    gpsLon:          req.body.gps_lon,
    photoRef:        req.body.photo_reference,
    tempCelsius:     req.body.temp_celsius,
    notes:           req.body.notes,
    req,
  });
  res.json(result);
}

/**
 * GET /delivery/orders/:id
 * Get delivery order details. Patients can only see their own orders.
 */
async function getOrder(req, res) {
  const { rows: [order] } = await pool.query(`
    SELECT do.*,
           p.first_name || ' ' || p.last_name AS patient_name,
           ph.name AS pharmacy_name,
           u.first_name || ' ' || u.last_name AS driver_name
    FROM delivery_orders do
    JOIN patients pat ON pat.id = do.patient_id
    JOIN users p      ON p.id   = pat.user_id
    JOIN pharmacies ph ON ph.id = do.pharmacy_id
    LEFT JOIN delivery_drivers dd ON dd.id = do.driver_id
    LEFT JOIN users u ON u.id = dd.user_id
    WHERE do.id = $1
  `, [req.params.id]);

  if (!order) return res.status(404).json({ error: 'Delivery order not found' });

  if (req.user.role === 'PATIENT') {
    const { rows: [pat] } = await pool.query(
      'SELECT id FROM patients WHERE user_id = $1', [req.user.id]
    );
    if (!pat || order.patient_id !== pat.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  await writeAuditEvent({
    action: 'DELIVERY_ORDER_VIEW', req,
    resourceType: 'delivery_order', resourceId: order.id,
    isPhiAccess: true,
    isControlledSubstanceEvent: order.contains_controlled,
  });

  // Strip signature data from non-authorized roles
  if (!['PHARMACIST','PHARMACY_MANAGER','SYSTEM_ADMIN'].includes(req.user.role)) {
    delete order.signature_data;
  }

  res.json(order);
}

/**
 * GET /delivery/orders/driver/active
 * Driver's current active deliveries.
 */
async function driverActiveOrders(req, res) {
  const driverId = req.user.id;

  const { rows } = await pool.query(`
    SELECT do.id, do.order_number, do.status,
           do.delivery_address_street, do.delivery_address_city, do.delivery_address_postal,
           do.contains_controlled, do.id_verification_required, do.signature_required,
           do.estimated_delivery_at,
           pat.first_name || ' ' || pat.last_name AS patient_name,
           pat.phone AS patient_phone
    FROM delivery_orders do
    JOIN delivery_drivers dd ON dd.id = do.driver_id
    JOIN patients pat ON pat.id = do.patient_id
    WHERE dd.user_id = $1
      AND do.status IN ('AWAITING_DRIVER','PICKED_UP','IN_TRANSIT')
    ORDER BY do.estimated_delivery_at ASC NULLS LAST
  `, [driverId]);

  res.json({ orders: rows });
}

module.exports = {
  createDeliveryOrder,
  assignDriverToOrder,
  confirmPickup,
  recordAttempt,
  getOrder,
  driverActiveOrders,
};
