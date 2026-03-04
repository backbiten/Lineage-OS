# Regulatory & Legal Framework

## Pharmacy Delivery Platform — Canada

This document outlines the complete regulatory framework governing the design,
operation, and compliance requirements of this pharmacy delivery platform.

---

## 1. Federal Laws (Canada)

### 1.1 Controlled Drugs and Substances Act (CDSA)
**Citation:** S.C. 1996, c. 19
**Regulator:** Health Canada — Drug and Health Products Regulatory Directorate

Key obligations implemented:
- **s.4** — Possession: controlled substances may only be in possession of authorized persons (pharmacists, registered patients). Delivery drivers are carriers under NCR s.5.
- **s.31** — Pharmacist responsibility: final sign-off on all Rx dispensing.
- **s.53** — Authorization: all staff handling controlled substances must be named/authorized.
- **s.55** — Regulations authority: compliance with all subordinate regulations below.

**Schedules enforced in DB schema:**
| Schedule | Examples | Restrictions |
|----------|----------|--------------|
| I | Opioids, cocaine, methamphetamine | Original written Rx only; no refills; double-count |
| II | Methaqualone | As Schedule I |
| III | Amphetamines (precursors) | Written Rx |
| IV | Benzodiazepines, anabolic steroids | Written Rx; targeted substance regs |
| V | Precursor chemicals | Reporting |
| VI | Class A/B precursors | Permits required |
| VII | Cannabis (≤30g) | Under Cannabis Act |
| VIII | Cannabis resin (≤1g) | Under Cannabis Act |

### 1.2 Narcotic Control Regulations (NCR)
**Citation:** SOR/2012-230
**Regulator:** Health Canada

Key s.31 requirements enforced:
- **s.31(1)** — Prescription must contain: patient name + address, drug + strength, quantity (words or figures), directions, prescriber name + address + handwritten signature, date written.
- **s.31(2)** — Verbal, fax, and electronic prescriptions for narcotics are **PROHIBITED**.
- **s.31(3)** — Narcotics **cannot be refilled** — new prescription required each time.
- **s.35** — Perpetual inventory mandatory; all transactions recorded.
- **s.5** — Carriers: pharmacist-employed delivery drivers are authorized carriers.

### 1.3 Benzodiazepines and Other Targeted Substances Regulations
**Citation:** SOR/2000-217

- Targeted substances (benzodiazepines, anabolic steroids) require written Rx.
- PMP reporting required.

### 1.4 Food and Drugs Act (FDA)
**Citation:** R.S.C. 1985, c. F-27
**Regulator:** Health Canada

- **s.9.1** — Prescription Drug List: Schedule I drugs require Rx.
- **s.29.1** — Patient counselling by pharmacist mandatory.
- **s.C.01.041** — Drug Identification Numbers (DIN) tracked for all dispensed drugs.

### 1.5 Personal Information Protection and Electronic Documents Act (PIPEDA)
**Citation:** S.C. 2000, c. 5
**Regulator:** Office of the Privacy Commissioner of Canada

Implemented:
- Principle 4 (Limiting Collection): only PHI necessary for care collected.
- Principle 7 (Safeguards): encryption at rest (health card numbers, allergy notes, clinical notes, signatures), TLS in transit.
- Principle 9 (Individual Access): patients can access their own records via authenticated API.
- Audit log for all PHI access.

---

## 2. International Law

### 2.1 Single Convention on Narcotic Drugs (1961)
**UN Treaty Series No. 520**
Canada ratified 1961. Requires: national control system, export/import controls, statistical reporting to INCB.

### 2.2 Convention on Psychotropic Substances (1971)
**UN Treaty Series No. 14956**
Canada ratified 1988. Schedule I–IV psychotropics require Rx, perpetual inventory.

### 2.3 UN Convention Against Illicit Traffic (1988)
**Requires:** precursor chemical controls (implemented via CDSA Schedule V/VI).

### 2.4 International Health Regulations (IHR 2005)
**WHO.** Governs pandemic/emergency pharmacy operations.

---

## 3. Provincial Legislation

### Ontario
- **Drug and Pharmacies Regulation Act, R.S.O. 1990, c. H.4** — pharmacy licensing
- **Regulated Health Professions Act, 1991, S.O. 1991, c. 18** — scope of practice
- **Ontario Drug Benefit Act, R.S.O. 1990, c. O.10** — ODB claims
- **Narcotics Safety and Awareness Act, 2010, S.O. 2010, c. 22** — PMP (Intellihealth)
- **Personal Health Information Protection Act, 2004 (PHIPA)** — ON privacy law

### British Columbia
- **Pharmacy Operations and Drug Scheduling Act, RSBC 1996, c. 363** — pharmacy ops
- **Pharmaceutical Services Act, S.B.C. 2012, c. 22** — PharmaNet (mandatory for ALL Rxs)
- **Health Professions Act, RSBC 1996, c. 183** — RPh/RPhT scope

### Alberta
- **Pharmacy and Drug Act, RSA 2000, c. P-13** — licensing
- **Health Information Act, RSA 2000, c. H-5** — patient data (equivalent to PHIPA)

### Quebec
- **Pharmacy Act, CQLR c. P-10** — professional practice
- **Act Respecting Health Services and Social Services** — patient rights

*(All other provinces have equivalent legislation — see `provinces` table.)*

---

## 4. Municipal Bylaws

Municipal business licensing requirements vary. The platform tracks:
- `pharmacies.municipal_license` — municipality-issued business license number
- `pharmacies.municipality` — city/town name for bylaw lookup

Pharmacy operators **must** obtain and maintain valid municipal business licenses.
Common bylaw requirements include:
- Operating hours
- Signage
- Delivery vehicle markings (some municipalities)
- Noise/traffic restrictions for delivery operations

---

## 5. Pharmacy Technician (RPhT) Regulatory Position

Registered Pharmacy Technicians are regulated health professionals in all Canadian
provinces/territories. Their scope of practice and the mandatory pharmacist oversight
requirement are the cornerstone of this application's workflow design.

| Action | RPhT | RPh Required? |
|--------|------|---------------|
| Receive prescription | ✓ | No |
| Data entry / intake | ✓ | No |
| Patient ID confirmation | ✓ | No |
| Allergy/interaction check | ✓ (alert generation) | Pharmacist reviews |
| Drug preparation | ✓ (under supervision) | Supervision |
| Labelling | ✓ | No |
| Final Rx verification | ✗ | **MANDATORY** |
| Controlled substance final approval | ✗ | **MANDATORY** |
| Patient drug counselling | ✗ | **MANDATORY** |
| Narcotic double-count | ✓ (first counter) | ✓ (witness or second counter) |
| Release for delivery | ✗ | **MANDATORY** |

**Reference:** NAPRA Model Standards of Practice (2022), s.3.0; provincial pharmacy acts.

---

## 6. Data Retention Requirements

| Record Type | Minimum Retention | Authority |
|------------|------------------|-----------|
| Prescription records | 10 years (ON) / 5 years (other provinces) | Provincial pharmacy acts |
| Narcotic Rx records | 2 years minimum | NCR s.35(2) |
| Controlled substance inventory | 2 years | NCR s.35 |
| Audit logs | 2 years minimum | CDSA / provincial |
| Patient PHI | 10 years after last contact | PHIPA s.13 (ON) |
| PMP submissions | 2 years | Provincial |

**Implementation:** Winston daily-rotate-file logs retained 730 days (2 years).
Database records are NOT deleted — soft-delete only.

---

## 7. Security Requirements

- All PHI encrypted at rest (AES-256 minimum)
- All API traffic over TLS 1.2+ (TLS 1.3 recommended)
- Audit log tamper detection via HMAC-SHA256 integrity hashes
- Pharmacist actions require digital signature (HMAC of pharmacist ID + Rx ID + timestamp)
- Multi-factor authentication available for all clinical staff
- Account lockout after 5 failed login attempts
- Passwords: bcrypt cost ≥ 12

---

*Last updated: 2026-03-04*
*This document must be reviewed by a regulated pharmacist and healthcare lawyer before production deployment.*
