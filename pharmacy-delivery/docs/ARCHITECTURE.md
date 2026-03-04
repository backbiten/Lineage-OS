# Pharmacy Delivery Platform — Backend Architecture

## Workflow Overview

```
                    ┌─────────────────────────────────────────────────┐
                    │             PRESCRIPTION WORKFLOW                 │
                    │          (Regulatory: CDSA / NAPRA / NCR)        │
                    └─────────────────────────────────────────────────┘

  Patient / Prescriber
         │
         │  Sends prescription (written original for narcotics — NCR s.31)
         ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  STEP 1: PHARMACY TECHNICIAN (RPhT) — FIRST TOUCHPOINT (MANDATORY) │
  │                                                                     │
  │  • Receive and interpret prescription                               │
  │  • Verify patient identity                                          │
  │  • Data entry into system                                           │
  │  • Allergy & drug interaction checks (alert generation)             │
  │  • Confirm prescriber is authorized                                 │
  │  • Verify narcotic Rx: original on file (NCR s.31)                  │
  │  • Flag controlled substance concerns for pharmacist                │
  │  • Route ALL Rxs to pharmacist queue (mandatory)                    │
  │                                          technician_intake_log ◄───│
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │
                                 │ (all Rxs — no exceptions)
                                 ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  STEP 2: PHARMACIST (RPh) — MANDATORY FINAL VERIFICATION            │
  │                                                                     │
  │  • Clinical appropriateness review                                  │
  │  • Dose range verification                                          │
  │  • Contraindication check                                           │
  │  • Authenticate narcotic Rx (NCR s.31)                              │
  │  • Verify prescriber CDSA authorization (for narcotics)             │
  │  • Patient counselling (FDA s.29.1)                                 │
  │  • Digital signature on approval                                    │
  │  • PMP submission triggered (real-time provinces)                   │
  │                                   pharmacist_verification_log ◄───│
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │
                         APPROVED / REJECTED
                                 │
                    ┌────────────┘ (if approved)
                    ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  STEP 3: NARCOTIC DOUBLE-COUNT (controlled substances only)         │
  │                    [CDSA / NCR s.35]                                │
  │                                                                     │
  │  • Two licensed staff members independently count quantity          │
  │  • Quantity vs. perpetual inventory reconciled                      │
  │  • Discrepancy → HALT + pharmacist investigation                    │
  │                                   inventory_transactions ◄─────────│
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  STEP 4: TECHNICIAN PACKS & CREATES DELIVERY ORDER                 │
  │                                                                     │
  │  • Pharmacist authorizes release for delivery (CDSA s.4)           │
  │  • Technician labels (per NAPRA / FDA drug labelling regs)         │
  │  • Tamper-evident seal applied + seal number recorded               │
  │  • Cold-chain packaging for refrigerated drugs                      │
  │  • Delivery order created with all compliance flags                 │
  │                                          delivery_orders ◄─────────│
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  STEP 5: DRIVER ASSIGNMENT & PICKUP                                 │
  │                                                                     │
  │  • Manager assigns background-checked driver                        │
  │  • Controlled substance delivery: criminal record check required    │
  │  • Driver verifies seal intact before accepting                     │
  │  • GPS tracking active during transit                               │
  │  • Cold-chain temperature logging (IoT sensor)                      │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  STEP 6: DELIVERY TO PATIENT                                        │
  │                                                                     │
  │  For controlled substances (CDSA s.4):                              │
  │  • Government-issued photo ID verification MANDATORY                │
  │  • Patient signature MANDATORY                                      │
  │  • Seal intact verification                                         │
  │  • Temperature log recorded                                         │
  │  • GPS + photo proof of delivery                                    │
  │                                                                     │
  │  If delivery fails (controlled):                                    │
  │  • CANNOT leave unattended — return to pharmacy SAME DAY            │
  │  • Pharmacist notified                                              │
  └──────────────────────────────┬──────────────────────────────────────┘
                                 │
                                 ▼
                        AUDIT TRAIL (immutable)
                        ──────────────────────
                        Every step logged to audit_log with:
                        • Actor, role, timestamp, IP
                        • Action type
                        • HMAC-SHA256 integrity hash
                        • PHI access flag
                        • Controlled substance event flag

```

## Data Model (key entities)

```
users ──────────── professional_licenses
  │
  ├── patients ─── prescriptions ─── drugs (DIN/cdsa_schedule)
  │                    │                │
  │                    ├── technician_intake_log
  │                    ├── pharmacist_verification_log
  │                    ├── pmp_submissions
  │                    └── inventory_transactions ─── inventory
  │
  └── delivery_drivers ─── delivery_orders ──── delivery_order_prescriptions
                               │
                               ├── delivery_attempts
                               └── cold_chain_logs

audit_log (append-only, HMAC-integrity)
```

## API Endpoints Summary

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| POST | /api/v1/auth/login | All | Authenticate |
| POST | /api/v1/prescriptions/intake | RPhT+ | **Step 1: Technician intake** |
| POST | /api/v1/prescriptions/:id/verify | RPh | **Step 2: Pharmacist verify** |
| POST | /api/v1/prescriptions/:id/narcotic-count | RPhT+CDSA | Step 3: Double-count |
| GET  | /api/v1/prescriptions/queue/technician | RPhT+ | Technician work queue |
| GET  | /api/v1/prescriptions/queue/pharmacist | RPh | Pharmacist queue |
| POST | /api/v1/delivery/orders | RPhT+ | Step 4: Create delivery order |
| POST | /api/v1/delivery/orders/:id/assign-driver | RPh/Mgr | Assign driver |
| POST | /api/v1/delivery/orders/:id/pickup | Driver | Step 5: Pickup confirmation |
| POST | /api/v1/delivery/orders/:id/attempt | Driver | Step 6: Record delivery |
| GET  | /api/v1/audit/log | RPh/Auditor | Regulatory audit access |
| GET  | /api/v1/inventory/transactions | RPhT+ | Perpetual inventory view |
