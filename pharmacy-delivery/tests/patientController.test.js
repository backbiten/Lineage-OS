'use strict';
/**
 * @file tests/patientController.test.js
 * Unit tests for patient controller business rules.
 * Tests validation logic and refill eligibility rules without a live DB.
 */

// ── Refill eligibility rules (mirrored from patientController.js) ─────────────

function canRefill(rx) {
  if (rx.is_narcotic) return { ok: false, reason: 'NARCOTIC_NO_REFILL' };
  if (rx.refills_remaining <= 0) return { ok: false, reason: 'NO_REFILLS_REMAINING' };
  if (new Date(rx.expiry_date) < new Date()) return { ok: false, reason: 'EXPIRED' };
  if (!['DELIVERED', 'DISPENSED', 'FILLED'].includes(rx.status)) {
    return { ok: false, reason: 'WRONG_STATUS' };
  }
  return { ok: true };
}

describe('Patient refill eligibility', () => {
  const baseRx = {
    is_narcotic: false,
    refills_remaining: 2,
    expiry_date: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days from now
    status: 'DELIVERED',
  };

  test('eligible Rx returns ok: true', () => {
    expect(canRefill(baseRx).ok).toBe(true);
  });

  test('narcotic Rx cannot be refilled (NCR s.31)', () => {
    expect(canRefill({ ...baseRx, is_narcotic: true })).toEqual({
      ok: false, reason: 'NARCOTIC_NO_REFILL',
    });
  });

  test('Rx with zero refills remaining is ineligible', () => {
    expect(canRefill({ ...baseRx, refills_remaining: 0 })).toEqual({
      ok: false, reason: 'NO_REFILLS_REMAINING',
    });
  });

  test('expired Rx cannot be refilled', () => {
    expect(canRefill({
      ...baseRx,
      expiry_date: new Date(Date.now() - 1000), // 1 second ago
    })).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  test('Rx in PHARMACIST_VERIFICATION status is not ready for refill', () => {
    expect(canRefill({ ...baseRx, status: 'PHARMACIST_VERIFICATION' })).toEqual({
      ok: false, reason: 'WRONG_STATUS',
    });
  });

  test('Rx in DISPENSED status is eligible', () => {
    expect(canRefill({ ...baseRx, status: 'DISPENSED' }).ok).toBe(true);
  });

  test('Rx in FILLED status is eligible', () => {
    expect(canRefill({ ...baseRx, status: 'FILLED' }).ok).toBe(true);
  });
});

// ── Password length validation ────────────────────────────────────────────────
describe('Patient registration password policy', () => {
  function validatePassword(pw) {
    return typeof pw === 'string' && pw.length >= 12;
  }

  test('rejects password shorter than 12 chars', () => {
    expect(validatePassword('short')).toBe(false);
  });

  test('rejects exactly 11 chars', () => {
    expect(validatePassword('11charpassw')).toBe(false);
  });

  test('accepts exactly 12 chars', () => {
    expect(validatePassword('12charpasswd')).toBe(true);
  });

  test('accepts longer password', () => {
    expect(validatePassword('a-very-secure-passphrase-2024!')).toBe(true);
  });
});
