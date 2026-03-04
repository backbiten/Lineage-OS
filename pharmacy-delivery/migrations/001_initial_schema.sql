-- ============================================================
-- PHARMACY DELIVERY PLATFORM — DATABASE SCHEMA
-- Regulatory Basis:
--   • Controlled Drugs and Substances Act (CDSA), S.C. 1996, c. 19
--   • Food and Drugs Act (FDA), R.S.C. 1985, c. F-27
--   • Health Canada — Policy on Pharmacy Operations (2023)
--   • NAPRA Model Standards for Pharmacy Compounding (2022)
--   • PIPEDA (federal) / PHIPA (Ontario) — patient data privacy
--   • Single Convention on Narcotic Drugs (1961), UN
--   • Convention on Psychotropic Substances (1971), UN
--   • Provincial Pharmacy Acts (ON, BC, AB, QC …)
--   • Municipal business licensing bylaws
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMERATIONS
-- ============================================================

CREATE TYPE user_role AS ENUM (
  'PATIENT',
  'PHARMACY_TECHNICIAN',   -- RPhT — Registered Pharmacy Technician
  'PHARMACIST',            -- RPh  — Licensed Pharmacist
  'DELIVERY_DRIVER',
  'PHARMACY_MANAGER',
  'SYSTEM_ADMIN',
  'REGULATORY_AUDITOR'     -- read-only, Health Canada / College inspectors
);

CREATE TYPE license_status AS ENUM (
  'ACTIVE',
  'SUSPENDED',
  'REVOKED',
  'EXPIRED',
  'PENDING_RENEWAL'
);

-- CDSA Schedule classification
CREATE TYPE cdsa_schedule AS ENUM (
  'NOT_CONTROLLED',
  'SCHEDULE_I',    -- narcotics (opioids, cocaine, cannabis)
  'SCHEDULE_II',   -- restricted drugs
  'SCHEDULE_III',  -- precursors
  'SCHEDULE_IV',   -- benzodiazepines, anabolic steroids
  'SCHEDULE_V',    -- precursor chemicals
  'SCHEDULE_VI',   -- precursor chemicals (class A/B)
  'SCHEDULE_VII',  -- cannabis (≤30g)
  'SCHEDULE_VIII', -- cannabis resin (≤1g)
  'TARGETED_SUBSTANCE'  -- former Benzodiazepines & Other Targeted Substances Regs
);

-- Canada Food and Drugs Act schedule
CREATE TYPE fda_schedule AS ENUM (
  'OTC',            -- Over the counter
  'BEHIND_COUNTER', -- Schedule II/III (pharmacist/technician guidance)
  'PRESCRIPTION',   -- Schedule I / Prescription Drug List
  'NARCOTIC',       -- Narcotic Control Regulations
  'VETERINARY'
);

CREATE TYPE prescription_status AS ENUM (
  'RECEIVED',
  'TECHNICIAN_REVIEW',    -- RPhT intake and data entry
  'PHARMACIST_VERIFICATION', -- RPh clinical review (mandatory)
  'APPROVED',
  'PARTIALLY_FILLED',
  'FILLED',
  'DISPENSED',
  'READY_FOR_DELIVERY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'RETURNED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED'
);

CREATE TYPE order_status AS ENUM (
  'CREATED',
  'PENDING_VERIFICATION',
  'TECHNICIAN_PROCESSING',
  'PHARMACIST_APPROVED',
  'PACKING',
  'AWAITING_DRIVER',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURNED_TO_PHARMACY',
  'CANCELLED'
);

CREATE TYPE delivery_attempt_result AS ENUM (
  'SUCCESS',
  'NO_ANSWER',
  'WRONG_ADDRESS',
  'REFUSED',
  'ID_VERIFICATION_FAILED',   -- mandatory for controlled substances
  'SIGNATURE_REFUSED',
  'RETURNED_TO_PHARMACY'
);

CREATE TYPE drug_storage_condition AS ENUM (
  'ROOM_TEMPERATURE',   -- 15–25°C
  'COOL',               -- 8–15°C
  'REFRIGERATED',       -- 2–8°C  (cold chain)
  'FROZEN',             -- −20°C
  'PROTECT_FROM_LIGHT',
  'HAZARDOUS'
);

-- ============================================================
-- REGULATORY BODIES & PROVINCES
-- ============================================================

CREATE TABLE provinces (
  code          CHAR(2)     PRIMARY KEY,  -- ON, BC, AB, QC, etc.
  name          VARCHAR(60) NOT NULL,
  pharmacy_act  TEXT,       -- citation of provincial pharmacy act
  college_name  TEXT,       -- e.g. "Ontario College of Pharmacists"
  college_url   TEXT
);

INSERT INTO provinces (code, name, pharmacy_act, college_name) VALUES
  ('ON', 'Ontario',             'Drug and Pharmacies Regulation Act, R.S.O. 1990, c. H.4', 'Ontario College of Pharmacists', 'https://www.ocpinfo.com'),
  ('BC', 'British Columbia',    'Pharmacy Operations and Drug Scheduling Act, RSBC 1996', 'College of Pharmacists of BC', 'https://www.bcpharmacists.org'),
  ('AB', 'Alberta',             'Pharmacy and Drug Act, RSA 2000, c. P-13', 'Alberta College of Pharmacy', 'https://abpharmacy.ca'),
  ('QC', 'Quebec',              'Pharmacy Act, CQLR c. P-10', 'Ordre des pharmaciens du Québec', 'https://www.opq.org'),
  ('SK', 'Saskatchewan',        'Pharmacy Act, 1996, SS 1996, c. P-9.1', 'Saskatchewan College of Pharmacy Professionals', 'https://www.scpp.sk.ca'),
  ('MB', 'Manitoba',            'Pharmaceutical Act, C.C.S.M. c. P60', 'College of Pharmacists of Manitoba', 'https://cphm.ca'),
  ('NS', 'Nova Scotia',         'Pharmacy Act, S.N.S. 2011, c. 11', 'Nova Scotia College of Pharmacists', 'https://nspharmacists.ca'),
  ('NB', 'New Brunswick',       'New Brunswick Pharmacy Act, SNB 2014, c. 31', 'New Brunswick College of Pharmacists', 'https://nbcp.ca'),
  ('NL', 'Newfoundland',        'Pharmacy Act, 2012, SNL 2012, c. P-12.02', 'Newfoundland and Labrador Pharmacy Board', 'https://nlpb.ca'),
  ('PE', 'Prince Edward Island','Pharmacy Act, RSPEI 1988, c. P-6', 'PEI Pharmacy Board', 'https://peipharmacyboard.ca'),
  ('YT', 'Yukon',               'Pharmacy and Pharmacists Act, RSY 2002, c. 171', 'Yukon Pharmacy Board', NULL),
  ('NT', 'Northwest Territories','Pharmacy Act, RSNWT 1988, c. P-6', 'Registrar of Pharmacists NWT', NULL),
  ('NU', 'Nunavut',             'Pharmacy Act, RSNWT(Nu) 1988, c. P-6', 'Registrar of Pharmacists Nunavut', NULL);

-- ============================================================
-- PHARMACIES
-- ============================================================

CREATE TABLE pharmacies (
  id                    UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  name                  VARCHAR(120) NOT NULL,
  license_number        VARCHAR(50) NOT NULL UNIQUE,  -- provincial pharmacy license
  napra_id              VARCHAR(50),                  -- NAPRA accreditation
  din_site              VARCHAR(50),                  -- Health Canada Drug Establishment License (if compounding)
  province_code         CHAR(2)     NOT NULL REFERENCES provinces(code),
  address_street        TEXT        NOT NULL,
  address_city          VARCHAR(80) NOT NULL,
  address_postal        VARCHAR(7)  NOT NULL,
  address_province      CHAR(2)     NOT NULL,
  phone                 VARCHAR(15) NOT NULL,
  fax                   VARCHAR(15),
  email                 VARCHAR(120),
  -- Authorizations
  controlled_substance_auth BOOLEAN DEFAULT FALSE,  -- CDSA s.56 exemption or standard dealer's license
  narcotic_license      VARCHAR(50),  -- Narcotic Control Regulations dealer's license
  narcotic_license_expiry DATE,
  compounding_permitted BOOLEAN DEFAULT FALSE,
  delivery_permitted    BOOLEAN DEFAULT TRUE,
  -- Operational
  is_active             BOOLEAN DEFAULT TRUE,
  municipality          VARCHAR(80),    -- for municipal bylaw compliance
  municipal_license     VARCHAR(50),    -- municipal business license number
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USERS (all roles)
-- ============================================================

CREATE TABLE users (
  id                  UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  email               VARCHAR(120) NOT NULL UNIQUE,
  password_hash       TEXT        NOT NULL,          -- bcrypt, min cost 12
  role                user_role   NOT NULL,
  first_name          VARCHAR(60) NOT NULL,
  last_name           VARCHAR(60) NOT NULL,
  phone               VARCHAR(15),
  is_active           BOOLEAN     DEFAULT TRUE,
  is_locked           BOOLEAN     DEFAULT FALSE,
  failed_login_count  SMALLINT    DEFAULT 0,
  last_login_at       TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ DEFAULT NOW(),
  mfa_secret          TEXT,                          -- TOTP secret (encrypted)
  mfa_enabled         BOOLEAN     DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROFESSIONAL LICENSES — Technicians & Pharmacists
-- ============================================================

CREATE TABLE professional_licenses (
  id                UUID         DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id           UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  province_code     CHAR(2)      NOT NULL REFERENCES provinces(code),
  license_type      VARCHAR(30)  NOT NULL,  -- 'RPhT', 'RPh', 'PharmD', etc.
  license_number    VARCHAR(60)  NOT NULL,
  issuing_college   TEXT         NOT NULL,
  issue_date        DATE         NOT NULL,
  expiry_date       DATE         NOT NULL,
  status            license_status NOT NULL DEFAULT 'ACTIVE',
  -- Controlled substances authorisation (CDSA s.53 — pharmacist/technician named)
  cdsa_authorised   BOOLEAN      DEFAULT FALSE,
  -- Scope of practice restrictions if any
  scope_notes       TEXT,
  verified_at       TIMESTAMPTZ, -- when system last confirmed with college registry
  created_at        TIMESTAMPTZ  DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (province_code, license_number)
);

-- ============================================================
-- PATIENTS
-- ============================================================

CREATE TABLE patients (
  id                UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id           UUID        REFERENCES users(id) ON DELETE RESTRICT,  -- may be NULL for walk-in
  health_card_number TEXT,      -- stored encrypted — PHIPA / PIPEDA
  health_card_province CHAR(2)  REFERENCES provinces(code),
  date_of_birth     DATE        NOT NULL,
  gender            VARCHAR(20),
  phone             VARCHAR(15),
  -- Delivery address
  address_street    TEXT        NOT NULL,
  address_city      VARCHAR(80) NOT NULL,
  address_postal    VARCHAR(7)  NOT NULL,
  address_province  CHAR(2)     NOT NULL REFERENCES provinces(code),
  -- Allergies / clinical flags (encrypted at rest)
  allergy_notes     TEXT,       -- encrypted
  clinical_notes    TEXT,       -- encrypted
  -- Consent for delivery of controlled substances (CDSA)
  consent_controlled_delivery BOOLEAN DEFAULT FALSE,
  consent_signed_at TIMESTAMPTZ,
  -- Privacy
  marketing_consent BOOLEAN     DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PRESCRIBERS
-- ============================================================

CREATE TABLE prescribers (
  id                    UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  first_name            VARCHAR(60) NOT NULL,
  last_name             VARCHAR(60) NOT NULL,
  designation           VARCHAR(30) NOT NULL,  -- MD, NP, DDS, DVM, etc.
  -- College registration
  college_registration  VARCHAR(60) NOT NULL,  -- e.g. CPSO registration number
  province_code         CHAR(2)     NOT NULL REFERENCES provinces(code),
  -- DEA equivalent: CDSA prescriber authorization
  -- Under Narcotic Control Regulations, prescribers don't hold "DEA numbers"
  -- They are authorized by their provincial college to prescribe narcotics
  controlled_sub_authorised BOOLEAN DEFAULT FALSE,
  -- Office contact
  address_street        TEXT,
  address_city          VARCHAR(80),
  address_postal        VARCHAR(7),
  phone                 VARCHAR(15),
  fax                   VARCHAR(15),
  is_active             BOOLEAN     DEFAULT TRUE,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DRUGS / MEDICATIONS
-- ============================================================

CREATE TABLE drugs (
  id                    UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  din                   VARCHAR(10) UNIQUE,   -- Health Canada Drug Identification Number
  brand_name            VARCHAR(120) NOT NULL,
  generic_name          VARCHAR(120) NOT NULL,
  manufacturer          VARCHAR(100),
  dosage_form           VARCHAR(60),   -- tablet, capsule, liquid, etc.
  strength              VARCHAR(30),   -- e.g. "5mg", "10mg/5mL"
  unit                  VARCHAR(20),   -- tablet, mL, g, etc.
  -- Regulatory classification
  cdsa_schedule         cdsa_schedule  NOT NULL DEFAULT 'NOT_CONTROLLED',
  fda_schedule          fda_schedule   NOT NULL DEFAULT 'PRESCRIPTION',
  -- CDSA specific fields
  is_narcotic           BOOLEAN       DEFAULT FALSE,
  is_targeted_substance BOOLEAN       DEFAULT FALSE,  -- benzodiazepines etc.
  narcotic_code         VARCHAR(20),   -- UN Narcotic Code (Single Convention)
  -- Storage
  storage_condition     drug_storage_condition DEFAULT 'ROOM_TEMPERATURE',
  requires_cold_chain   BOOLEAN       DEFAULT FALSE,
  -- Reporting
  requires_triplicate   BOOLEAN       DEFAULT FALSE,  -- some provinces still use
  requires_real_time_monitoring BOOLEAN DEFAULT FALSE, -- provincial PMP (DPIN etc.)
  created_at            TIMESTAMPTZ   DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   DEFAULT NOW()
);

-- ============================================================
-- PRESCRIPTIONS
-- ============================================================

CREATE TABLE prescriptions (
  id                    UUID             DEFAULT uuid_generate_v4() PRIMARY KEY,
  rx_number             VARCHAR(30)      NOT NULL UNIQUE,  -- pharmacy Rx number
  patient_id            UUID             NOT NULL REFERENCES patients(id),
  prescriber_id         UUID             NOT NULL REFERENCES prescribers(id),
  pharmacy_id           UUID             NOT NULL REFERENCES pharmacies(id),
  drug_id               UUID             NOT NULL REFERENCES drugs(id),
  -- Prescription details
  written_date          DATE             NOT NULL,
  received_date         DATE             NOT NULL DEFAULT CURRENT_DATE,
  expiry_date           DATE             NOT NULL,  -- ON: 1yr; narcotics: as written
  -- Dosage
  quantity_prescribed   NUMERIC(10,3)    NOT NULL,
  quantity_unit         VARCHAR(20)      NOT NULL,
  days_supply           SMALLINT,
  directions            TEXT             NOT NULL,  -- sig / signatura
  refills_authorized    SMALLINT         DEFAULT 0,
  refills_remaining     SMALLINT         DEFAULT 0,
  -- Controlled substance fields (CDSA / Narcotic Control Regs)
  is_controlled         BOOLEAN          DEFAULT FALSE,
  cdsa_schedule         cdsa_schedule    DEFAULT 'NOT_CONTROLLED',
  -- Narcotic Control Regulations s.31: written Rx required, NO verbal/fax for narcotics
  rx_original_received  BOOLEAN          DEFAULT FALSE, -- original paper Rx on file?
  rx_paper_id           VARCHAR(60),     -- document tracking number for original
  -- Status workflow
  status                prescription_status NOT NULL DEFAULT 'RECEIVED',
  -- Professional accountability chain
  received_by_tech_id   UUID             REFERENCES users(id),   -- RPhT
  reviewed_by_rph_id    UUID             REFERENCES users(id),   -- RPh — mandatory
  pharmacist_verified_at TIMESTAMPTZ,
  pharmacist_notes      TEXT,
  -- Double-count for narcotics (CDSA requirement)
  narcotic_count_tech1_id UUID           REFERENCES users(id),
  narcotic_count_tech2_id UUID           REFERENCES users(id),  -- second witness
  narcotic_count_at     TIMESTAMPTZ,
  narcotic_count_qty    NUMERIC(10,3),
  -- Provincial drug monitoring program submission
  pmp_submitted         BOOLEAN          DEFAULT FALSE,
  pmp_submitted_at      TIMESTAMPTZ,
  -- Metadata
  cancellation_reason   TEXT,
  created_at            TIMESTAMPTZ      DEFAULT NOW(),
  updated_at            TIMESTAMPTZ      DEFAULT NOW()
);

-- ============================================================
-- PHARMACY TECHNICIAN INTAKE LOG
-- (Required by NAPRA Standards — technician is first touchpoint)
-- ============================================================

CREATE TABLE technician_intake_log (
  id                    UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  prescription_id       UUID        NOT NULL REFERENCES prescriptions(id),
  technician_id         UUID        NOT NULL REFERENCES users(id),
  -- Intake checklist (NAPRA Model Standards, s. 3.0)
  patient_identity_confirmed  BOOLEAN NOT NULL DEFAULT FALSE,
  allergy_check_performed     BOOLEAN NOT NULL DEFAULT FALSE,
  drug_interaction_check      BOOLEAN NOT NULL DEFAULT FALSE,
  prescriber_valid            BOOLEAN NOT NULL DEFAULT FALSE,
  rx_not_expired              BOOLEAN NOT NULL DEFAULT FALSE,
  rx_not_forged_flags         TEXT,    -- any forgery indicators noted
  controlled_substance_flags  TEXT,    -- early warning flags for RPh
  double_count_required       BOOLEAN NOT NULL DEFAULT FALSE,
  original_rx_obtained        BOOLEAN NOT NULL DEFAULT FALSE,  -- narcotics: MANDATORY
  notes                       TEXT,
  intake_completed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Technician may NEVER approve controlled substance Rxs independently
  -- Must route to pharmacist — enforced at application layer AND here
  requires_pharmacist_review  BOOLEAN NOT NULL DEFAULT TRUE,
  routed_to_pharmacist_at     TIMESTAMPTZ,
  routed_to_pharmacist_id     UUID    REFERENCES users(id)
);

-- ============================================================
-- PHARMACIST VERIFICATION LOG
-- CDSA s.31(1) — pharmacist responsible for final verification
-- ============================================================

CREATE TABLE pharmacist_verification_log (
  id                      UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  prescription_id         UUID        NOT NULL REFERENCES prescriptions(id),
  pharmacist_id           UUID        NOT NULL REFERENCES users(id),
  -- Clinical checks
  clinical_appropriateness_verified  BOOLEAN NOT NULL,
  dose_within_range                  BOOLEAN NOT NULL,
  no_contraindications               BOOLEAN NOT NULL,
  patient_counselling_provided       BOOLEAN NOT NULL,  -- FDA s.9 — patient info
  -- Controlled substance specific
  rx_authentic                       BOOLEAN,  -- for narcotics: mandatory
  prescriber_authority_confirmed     BOOLEAN,
  triplicate_completed               BOOLEAN DEFAULT FALSE,  -- if province requires
  -- Decision
  approved                           BOOLEAN NOT NULL,
  rejection_reason                   TEXT,
  pharmacist_signature_hash          TEXT,    -- hash of pharmacist's digital signature
  verified_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INVENTORY — CONTROLLED SUBSTANCE PERPETUAL INVENTORY
-- CDSA / Narcotic Control Regulations: perpetual inventory mandatory
-- ============================================================

CREATE TABLE inventory (
  id              UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  pharmacy_id     UUID        NOT NULL REFERENCES pharmacies(id),
  drug_id         UUID        NOT NULL REFERENCES drugs(id),
  lot_number      VARCHAR(40) NOT NULL,
  expiry_date     DATE        NOT NULL,
  quantity_on_hand NUMERIC(12,3) NOT NULL DEFAULT 0,
  unit            VARCHAR(20) NOT NULL,
  storage_location VARCHAR(60),  -- vault, fridge, safe
  -- Cold chain
  current_temp_celsius NUMERIC(4,1),
  last_temp_check_at   TIMESTAMPTZ,
  -- Receiving
  received_date        DATE,
  received_from        VARCHAR(120), -- licensed dealer / wholesaler
  supplier_license     VARCHAR(60),  -- CDSA dealer's license of supplier
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(pharmacy_id, drug_id, lot_number)
);

-- Narcotic / controlled substance transaction log (perpetual inventory)
CREATE TABLE inventory_transactions (
  id              UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  inventory_id    UUID        NOT NULL REFERENCES inventory(id),
  prescription_id UUID        REFERENCES prescriptions(id),
  transaction_type VARCHAR(30) NOT NULL, -- 'DISPENSE','RETURN','DESTROY','ADJUST','RECEIVE'
  quantity_change  NUMERIC(12,3) NOT NULL,  -- negative for dispense/destroy
  quantity_after   NUMERIC(12,3) NOT NULL,
  -- CDSA: destruction of narcotics must be witnessed
  witness_user_id  UUID       REFERENCES users(id),
  destruction_method TEXT,    -- if DESTROY
  -- Who performed / authorized
  performed_by_id  UUID       NOT NULL REFERENCES users(id),
  authorized_by_rph_id UUID   REFERENCES users(id),  -- pharmacist sign-off
  notes            TEXT,
  transaction_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DELIVERY DRIVERS
-- ============================================================

CREATE TABLE delivery_drivers (
  id                  UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id             UUID        NOT NULL REFERENCES users(id) UNIQUE,
  pharmacy_id         UUID        NOT NULL REFERENCES pharmacies(id),
  -- Licensing
  drivers_license     VARCHAR(30) NOT NULL,
  license_province    CHAR(2)     NOT NULL REFERENCES provinces(code),
  license_expiry      DATE        NOT NULL,
  -- Background check — mandatory for controlled substance delivery
  criminal_record_check_date DATE,
  criminal_record_check_clear BOOLEAN DEFAULT FALSE,
  vulnerable_sector_check_date DATE,
  vulnerable_sector_clear BOOLEAN DEFAULT FALSE,
  -- CDSA: carrier authorization for controlled substances
  -- NCR s.5 — carrier must be authorized (employment by licensed pharmacy = authorization)
  can_deliver_controlled BOOLEAN DEFAULT FALSE,  -- set by pharmacist/manager
  controlled_delivery_training_date DATE,
  -- Vehicle
  vehicle_plate       VARCHAR(15),
  vehicle_province    CHAR(2)     REFERENCES provinces(code),
  vehicle_insured     BOOLEAN     DEFAULT FALSE,
  cold_chain_capable  BOOLEAN     DEFAULT FALSE,
  is_active           BOOLEAN     DEFAULT TRUE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DELIVERY ORDERS
-- ============================================================

CREATE TABLE delivery_orders (
  id                      UUID          DEFAULT uuid_generate_v4() PRIMARY KEY,
  order_number            VARCHAR(30)   NOT NULL UNIQUE,
  pharmacy_id             UUID          NOT NULL REFERENCES pharmacies(id),
  patient_id              UUID          NOT NULL REFERENCES patients(id),
  driver_id               UUID          REFERENCES delivery_drivers(id),
  -- Prescriptions in this delivery (many-to-one)
  -- Separate join table below handles multiple Rxs per delivery
  status                  order_status  NOT NULL DEFAULT 'CREATED',
  -- Delivery address (captured at order time, not live from patient record)
  delivery_address_street TEXT          NOT NULL,
  delivery_address_city   VARCHAR(80)   NOT NULL,
  delivery_address_postal VARCHAR(7)    NOT NULL,
  delivery_address_province CHAR(2)     NOT NULL,
  delivery_notes          TEXT,
  -- Scheduling
  requested_delivery_date DATE,
  scheduled_pickup_at     TIMESTAMPTZ,
  actual_pickup_at        TIMESTAMPTZ,
  estimated_delivery_at   TIMESTAMPTZ,
  actual_delivery_at      TIMESTAMPTZ,
  -- Controlled substance delivery requirements (CDSA / NCR)
  contains_controlled     BOOLEAN       DEFAULT FALSE,
  contains_narcotic       BOOLEAN       DEFAULT FALSE,
  -- ID verification required if controlled substance (CDSA s.4)
  id_verification_required BOOLEAN      DEFAULT FALSE,
  id_verified_at          TIMESTAMPTZ,
  id_verified_by_driver   UUID          REFERENCES users(id),
  id_type_presented       VARCHAR(50),  -- "BC DL", "Passport", etc.
  -- Signature
  signature_required      BOOLEAN       DEFAULT TRUE,
  signature_captured      BOOLEAN       DEFAULT FALSE,
  signature_data          TEXT,         -- base64 PNG of signature
  -- Temperature log for cold-chain
  delivery_temp_celsius   NUMERIC(4,1),
  -- Packaging tamper-evidence
  tamper_evident_seal     VARCHAR(60),  -- seal/bag ID number
  seal_intact_on_delivery BOOLEAN,
  -- Financial
  delivery_fee_cents      INTEGER       DEFAULT 0,
  -- Pharmacist who authorized release for delivery
  released_by_rph_id      UUID          NOT NULL REFERENCES users(id),
  released_at             TIMESTAMPTZ,
  -- Pack verified by technician before dispatch
  packed_by_tech_id       UUID          REFERENCES users(id),
  packed_at               TIMESTAMPTZ,
  created_at              TIMESTAMPTZ   DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   DEFAULT NOW()
);

-- Many prescriptions per delivery order
CREATE TABLE delivery_order_prescriptions (
  delivery_order_id UUID NOT NULL REFERENCES delivery_orders(id),
  prescription_id   UUID NOT NULL REFERENCES prescriptions(id),
  PRIMARY KEY (delivery_order_id, prescription_id)
);

-- Delivery attempt log (NCR requires record of failed attempts)
CREATE TABLE delivery_attempts (
  id                UUID           DEFAULT uuid_generate_v4() PRIMARY KEY,
  delivery_order_id UUID           NOT NULL REFERENCES delivery_orders(id),
  driver_id         UUID           NOT NULL REFERENCES users(id),
  attempt_number    SMALLINT       NOT NULL,
  attempted_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  result            delivery_attempt_result NOT NULL,
  gps_latitude      NUMERIC(10,7),
  gps_longitude     NUMERIC(10,7),
  notes             TEXT,
  -- Photo proof of delivery location (stored as reference to object storage)
  photo_reference   TEXT
);

-- ============================================================
-- AUDIT LOG — IMMUTABLE
-- Required: CDSA, PIPEDA, provincial pharmacy acts
-- All access to PHI and all controlled substance events must be logged
-- ============================================================

CREATE TABLE audit_log (
  id            BIGSERIAL    PRIMARY KEY,
  event_time    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actor_id      UUID         REFERENCES users(id),
  actor_role    user_role,
  ip_address    INET,
  user_agent    TEXT,
  action        VARCHAR(80)  NOT NULL,   -- e.g. 'PRESCRIPTION_VIEW', 'DISPENSE_NARCOTIC'
  resource_type VARCHAR(60),             -- 'prescription', 'delivery_order', etc.
  resource_id   UUID,
  -- Before/after values for changes (JSON, PHI fields redacted)
  old_values    JSONB,
  new_values    JSONB,
  -- Regulatory flags
  is_phi_access BOOLEAN      DEFAULT FALSE,  -- PIPEDA/PHIPA logging
  is_controlled_substance_event BOOLEAN DEFAULT FALSE,  -- CDSA mandatory logging
  -- Integrity: hash of (event_time || actor_id || action || resource_id)
  -- Prevents log tampering
  integrity_hash TEXT         NOT NULL,
  success       BOOLEAN       NOT NULL DEFAULT TRUE,
  failure_reason TEXT
);

-- Audit log is append-only; prevent UPDATE/DELETE at DB level via RLS or trigger
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable — modification not permitted (regulatory requirement)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- ============================================================
-- PROVINCIAL DRUG MONITORING PROGRAM SUBMISSIONS
-- (DPIN-MB, DPMB-NS, PharmaNet-BC, Ontario DxCG, etc.)
-- CDSA and provincial regs require real-time reporting for narcotics/targeted substances
-- ============================================================

CREATE TABLE pmp_submissions (
  id                UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  prescription_id   UUID        NOT NULL REFERENCES prescriptions(id),
  province_code     CHAR(2)     NOT NULL REFERENCES provinces(code),
  program_name      VARCHAR(60),  -- "PharmaNet", "DPIN", etc.
  submitted_at      TIMESTAMPTZ,
  submission_status VARCHAR(20) DEFAULT 'PENDING',  -- PENDING, SUCCESS, FAILED
  submission_ref    VARCHAR(80),  -- reference number returned by program
  error_message     TEXT,
  retry_count       SMALLINT    DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- COLD CHAIN MONITORING
-- Health Canada Drug Regulations — storage requirements for biologics, vaccines
-- ============================================================

CREATE TABLE cold_chain_logs (
  id              BIGSERIAL   PRIMARY KEY,
  delivery_order_id UUID      NOT NULL REFERENCES delivery_orders(id),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  temp_celsius    NUMERIC(4,1) NOT NULL,
  humidity_pct    NUMERIC(5,2),
  device_id       VARCHAR(60),   -- IoT sensor / data logger ID
  in_range        BOOLEAN     NOT NULL,  -- within required range?
  excursion_alert BOOLEAN     DEFAULT FALSE
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_prescriptions_patient    ON prescriptions(patient_id);
CREATE INDEX idx_prescriptions_status     ON prescriptions(status);
CREATE INDEX idx_prescriptions_rx_number  ON prescriptions(rx_number);
CREATE INDEX idx_prescriptions_controlled ON prescriptions(is_controlled) WHERE is_controlled = TRUE;
CREATE INDEX idx_delivery_orders_patient  ON delivery_orders(patient_id);
CREATE INDEX idx_delivery_orders_driver   ON delivery_orders(driver_id);
CREATE INDEX idx_delivery_orders_status   ON delivery_orders(status);
CREATE INDEX idx_audit_log_actor          ON audit_log(actor_id);
CREATE INDEX idx_audit_log_time           ON audit_log(event_time);
CREATE INDEX idx_audit_log_resource       ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_controlled     ON audit_log(is_controlled_substance_event) WHERE is_controlled_substance_event = TRUE;
CREATE INDEX idx_inventory_pharmacy_drug  ON inventory(pharmacy_id, drug_id);
CREATE INDEX idx_pmp_submissions_pending  ON pmp_submissions(submission_status) WHERE submission_status = 'PENDING';

-- ============================================================
-- updated_at auto-update trigger
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacies','users','professional_licenses','patients',
    'prescribers','drugs','prescriptions','inventory','delivery_orders','delivery_drivers'] LOOP
    EXECUTE format('CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END;
$$;
