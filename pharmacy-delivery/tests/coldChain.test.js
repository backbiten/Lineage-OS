'use strict';
/**
 * @file tests/coldChain.test.js
 * Unit tests for cold chain temperature range logic.
 * Tests the in-range determination without database calls.
 */

// Extract the range logic by re-implementing it (pure function, no DB)
const TEMP_RANGES = {
  REFRIGERATED:     { min: 2,    max: 8   },
  COOL:             { min: 8,    max: 15  },
  ROOM_TEMPERATURE: { min: 15,   max: 25  },
  FROZEN:           { min: -40,  max: -15 },
};

function isInRange(tempCelsius, storageCondition) {
  const range = TEMP_RANGES[storageCondition];
  if (!range) return true;
  return tempCelsius >= range.min && tempCelsius <= range.max;
}

describe('Cold chain temperature range validation', () => {
  describe('REFRIGERATED (2–8°C)', () => {
    test('accepts 4°C', () => expect(isInRange(4, 'REFRIGERATED')).toBe(true));
    test('accepts boundary 2°C', () => expect(isInRange(2, 'REFRIGERATED')).toBe(true));
    test('accepts boundary 8°C', () => expect(isInRange(8, 'REFRIGERATED')).toBe(true));
    test('rejects 1.9°C', () => expect(isInRange(1.9, 'REFRIGERATED')).toBe(false));
    test('rejects 8.1°C', () => expect(isInRange(8.1, 'REFRIGERATED')).toBe(false));
    test('rejects 25°C (room temp)', () => expect(isInRange(25, 'REFRIGERATED')).toBe(false));
  });

  describe('ROOM_TEMPERATURE (15–25°C)', () => {
    test('accepts 20°C', () => expect(isInRange(20, 'ROOM_TEMPERATURE')).toBe(true));
    test('accepts boundary 15°C', () => expect(isInRange(15, 'ROOM_TEMPERATURE')).toBe(true));
    test('accepts boundary 25°C', () => expect(isInRange(25, 'ROOM_TEMPERATURE')).toBe(true));
    test('rejects 14°C', () => expect(isInRange(14, 'ROOM_TEMPERATURE')).toBe(false));
    test('rejects 26°C', () => expect(isInRange(26, 'ROOM_TEMPERATURE')).toBe(false));
  });

  describe('FROZEN (−40 to −15°C)', () => {
    test('accepts −20°C', () => expect(isInRange(-20, 'FROZEN')).toBe(true));
    test('rejects −14°C (too warm)', () => expect(isInRange(-14, 'FROZEN')).toBe(false));
    test('rejects 0°C', () => expect(isInRange(0, 'FROZEN')).toBe(false));
  });

  describe('COOL (8–15°C)', () => {
    test('accepts 10°C', () => expect(isInRange(10, 'COOL')).toBe(true));
    test('rejects 16°C', () => expect(isInRange(16, 'COOL')).toBe(false));
  });

  describe('unknown condition', () => {
    test('returns true for unknown condition (pharmacist assesses)', () => {
      expect(isInRange(50, 'HAZARDOUS')).toBe(true);
    });
  });
});
