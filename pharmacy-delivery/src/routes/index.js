'use strict';
/**
 * @file routes/index.js
 * @description API route definitions — maps HTTP methods+paths to controller
 * functions and composes the middleware chain for each endpoint.
 *
 * Every protected route follows this pattern:
 *   authenticate → [role guard] → [license check] → [CDSA check] → controller
 *
 * The middleware ordering is intentional and must not be changed:
 *  1. authenticate:              verify JWT, load user from DB
 *  2. role guard (isX):          check user.role is permitted
 *  3. requireActiveLicense:      verify college license is current (RPh/RPhT only)
 *  4. requireCDSAAuthorization:  verify cdsa_authorised flag (controlled Rxs only)
 *  5. input validation:          express-validator rules (where applicable)
 *  6. controller function:       business logic
 *
 * ─── Workflow route summary ──────────────────────────────────────────────────
 *  POST /prescriptions/intake          RPhT+ — Step 1: technician intake
 *  POST /prescriptions/:id/verify      RPh   — Step 2: pharmacist verification
 *  POST /prescriptions/:id/narcotic-count  RPhT+CDSA — Step 3: double-count
 *  POST /delivery/orders               RPhT+ — Step 4: pack & create delivery order
 *  POST /delivery/orders/:id/assign-driver  RPh — assign eligible driver
 *  POST /delivery/orders/:id/pickup    Driver — Step 5: pickup confirmation
 *  POST /delivery/orders/:id/attempt   Driver — Step 6: delivery attempt
 *  GET  /audit/log                     RPh/Auditor — regulatory inspection
 *  GET  /inventory/transactions        RPhT+ — perpetual inventory view
 * ────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require('express');
const router     = Router();

const {
  authenticate,
  isTechOrAbove,
  isPharmacist,
  isDriver,
  isAdmin,
  canReadAudit,
  requireActiveLicense,
  requireCDSAAuthorization,
} = require('../middleware/auth');

const authCtrl         = require('../controllers/authController');
const prescriptionCtrl = require('../controllers/prescriptionController');
const deliveryCtrl     = require('../controllers/deliveryController');
const pool             = require('../config/database');
const { writeAuditEvent } = require('../utils/audit');

// ── Health check ──────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'pharmacy-delivery-api' }));

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/login',           authCtrl.login);
router.post('/auth/change-password', authenticate, authCtrl.changePassword);

// ── Prescriptions (Technician-first workflow) ─────────────────────────────────

// 1. Technician intake — FIRST touchpoint for all Rxs
router.post(
  '/prescriptions/intake',
  authenticate,
  isTechOrAbove,
  requireActiveLicense,
  ...prescriptionCtrl.intakeValidation,
  prescriptionCtrl.intake
);

// 2. Pharmacist clinical verification — MANDATORY for ALL Rxs
router.post(
  '/prescriptions/:id/verify',
  authenticate,
  isPharmacist,
  requireActiveLicense,
  prescriptionCtrl.verify
);

// 3. Narcotic double-count — CDSA requirement
router.post(
  '/prescriptions/:id/narcotic-count',
  authenticate,
  isTechOrAbove,
  requireActiveLicense,
  requireCDSAAuthorization,
  prescriptionCtrl.narcoticCount
);

// Queues
router.get(
  '/prescriptions/queue/technician',
  authenticate,
  isTechOrAbove,
  prescriptionCtrl.technicianQueue
);
router.get(
  '/prescriptions/queue/pharmacist',
  authenticate,
  isPharmacist,
  prescriptionCtrl.pharmacistQueue
);

// Prescription detail
router.get(
  '/prescriptions/:id',
  authenticate,
  prescriptionCtrl.getById
);

// ── Delivery ──────────────────────────────────────────────────────────────────

// Technician creates delivery order (after pharmacist approval)
router.post(
  '/delivery/orders',
  authenticate,
  isTechOrAbove,
  requireActiveLicense,
  deliveryCtrl.createDeliveryOrder
);

// Pharmacy manager assigns driver
router.post(
  '/delivery/orders/:id/assign-driver',
  authenticate,
  isPharmacist,
  deliveryCtrl.assignDriverToOrder
);

// Driver pickup
router.post(
  '/delivery/orders/:id/pickup',
  authenticate,
  isDriver,
  deliveryCtrl.confirmPickup
);

// Driver records attempt
router.post(
  '/delivery/orders/:id/attempt',
  authenticate,
  isDriver,
  deliveryCtrl.recordAttempt
);

// Driver active orders
router.get(
  '/delivery/driver/active',
  authenticate,
  isDriver,
  deliveryCtrl.driverActiveOrders
);

// Order detail
router.get(
  '/delivery/orders/:id',
  authenticate,
  deliveryCtrl.getOrder
);

// ── Audit log (regulatory inspectors / managers) ──────────────────────────────
// Accessible by: PHARMACIST, PHARMACY_MANAGER, SYSTEM_ADMIN, REGULATORY_AUDITOR
// Supports filtering by resource, actor, date range, and controlled-substance flag.
// The act of reading the audit log is itself logged (meta-audit) for accountability.
// Results capped at 500 rows per request; use pagination for larger exports.
router.get('/audit/log', authenticate, canReadAudit, async (req, res) => {
  const { resource_type, resource_id, from, to, actor_id, controlled_only } = req.query;

  // Build parameterised WHERE clause dynamically from optional query params
  const conditions = ['1=1']; // always-true base keeps concat logic simple
  const params     = [];
  let   idx        = 1;       // $1, $2, … placeholder counter

  if (resource_type) { conditions.push(`resource_type = $${idx++}`); params.push(resource_type); }
  if (resource_id)   { conditions.push(`resource_id   = $${idx++}`); params.push(resource_id);   }
  if (actor_id)      { conditions.push(`actor_id      = $${idx++}`); params.push(actor_id);      }
  if (from)          { conditions.push(`event_time   >= $${idx++}`); params.push(from);          }
  if (to)            { conditions.push(`event_time   <= $${idx++}`); params.push(to);            }
  // Shortcut for Health Canada / College inspectors reviewing controlled substance events only
  if (controlled_only === 'true') { conditions.push('is_controlled_substance_event = TRUE');     }

  const { rows } = await pool.query(
    `SELECT id, event_time, actor_id, actor_role, ip_address, action,
            resource_type, resource_id, is_phi_access, is_controlled_substance_event,
            success, failure_reason
     FROM audit_log
     WHERE ${conditions.join(' AND ')}
     ORDER BY event_time DESC
     LIMIT 500`,
    params
  );

  await writeAuditEvent({
    action: 'AUDIT_LOG_ACCESSED', req, isPhiAccess: true,
  });

  res.json({ log: rows, count: rows.length });
});

// ── Inventory (controlled substance perpetual inventory) ──────────────────────
// NCR s.35 requires that every narcotic transaction be recorded and available
// for inspection.  This endpoint exposes the inventory_transactions table
// for a given pharmacy, with optional drug and date-range filters.
// Accessing this data is itself logged as a controlled-substance audit event.
router.get('/inventory/transactions', authenticate, isTechOrAbove, async (req, res) => {
  const { pharmacy_id, drug_id, from, to } = req.query;
  const { rows } = await pool.query(`
    SELECT it.*, d.generic_name, d.cdsa_schedule, d.din
    FROM inventory_transactions it
    JOIN inventory i ON i.id = it.inventory_id
    JOIN drugs d     ON d.id = i.drug_id
    WHERE i.pharmacy_id = $1
      AND ($2::uuid IS NULL OR i.drug_id = $2)
      AND ($3::timestamptz IS NULL OR it.transaction_at >= $3)
      AND ($4::timestamptz IS NULL OR it.transaction_at <= $4)
    ORDER BY it.transaction_at DESC
    LIMIT 200
  `, [pharmacy_id, drug_id || null, from || null, to || null]);

  await writeAuditEvent({
    action: 'INVENTORY_TRANSACTIONS_VIEW', req,
    isControlledSubstanceEvent: true,
  });

  res.json({ transactions: rows });
});

module.exports = router;
