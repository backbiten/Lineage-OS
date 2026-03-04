'use strict';
/**
 * @file tests/driverController.test.js
 * Unit tests for driver management business rules.
 * Tests CDSA authorization eligibility without a live database.
 */

// ── CDSA controlled delivery authorization rules ──────────────────────────────
// Mirrors the guard in driverController.setCdsaAuthorization

function canAuthorizeCdsaDelivery(driver) {
  if (!driver.criminal_record_check_clear) {
    return { ok: false, reason: 'CRIMINAL_RECORD_CHECK_NOT_CLEARED' };
  }
  return { ok: true };
}

describe('Driver CDSA authorization eligibility (NCR s.5)', () => {
  test('driver with cleared criminal record check can be authorized', () => {
    const driver = { criminal_record_check_clear: true };
    expect(canAuthorizeCdsaDelivery(driver).ok).toBe(true);
  });

  test('driver with failed criminal record check cannot be authorized', () => {
    const driver = { criminal_record_check_clear: false };
    expect(canAuthorizeCdsaDelivery(driver)).toEqual({
      ok: false, reason: 'CRIMINAL_RECORD_CHECK_NOT_CLEARED',
    });
  });

  test('driver with null criminal record check cannot be authorized', () => {
    const driver = { criminal_record_check_clear: null };
    // null is falsy — should be treated as not cleared
    expect(canAuthorizeCdsaDelivery(driver).ok).toBe(false);
  });
});

// ── Driver license expiry check ───────────────────────────────────────────────

function isDriverLicenseValid(licenseExpiry) {
  return new Date(licenseExpiry) > new Date();
}

describe('Driver license validity', () => {
  test('future expiry date is valid', () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    expect(isDriverLicenseValid(future)).toBe(true);
  });

  test('past expiry date is invalid', () => {
    const past = new Date(Date.now() - 1000);
    expect(isDriverLicenseValid(past)).toBe(false);
  });
});
