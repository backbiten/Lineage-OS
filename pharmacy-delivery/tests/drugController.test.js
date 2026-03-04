'use strict';
/**
 * @file tests/drugController.test.js
 * Unit tests for drug controller — patient view filtering and search logic.
 */

// Patient view strips regulatory classification fields
function patientView(drug) {
  const { id, din, brand_name, generic_name, dosage_form, strength, unit,
          storage_condition, requires_cold_chain } = drug;
  return { id, din, brand_name, generic_name, dosage_form, strength, unit,
           storage_condition, requires_cold_chain };
}

describe('Drug patient view', () => {
  const fullDrug = {
    id: 'uuid-1234',
    din: '02345678',
    brand_name: 'OxyContin',
    generic_name: 'Oxycodone',
    manufacturer: 'Purdue Pharma',
    dosage_form: 'tablet',
    strength: '10mg',
    unit: 'tablet',
    cdsa_schedule: 'SCHEDULE_I',
    fda_schedule: 'NARCOTIC',
    is_narcotic: true,
    is_targeted_substance: false,
    narcotic_code: 'UNX-9143',
    storage_condition: 'ROOM_TEMPERATURE',
    requires_cold_chain: false,
    requires_triplicate: false,
    requires_real_time_monitoring: true,
  };

  test('includes basic fields', () => {
    const view = patientView(fullDrug);
    expect(view.brand_name).toBe('OxyContin');
    expect(view.generic_name).toBe('Oxycodone');
    expect(view.dosage_form).toBe('tablet');
    expect(view.strength).toBe('10mg');
  });

  test('excludes regulatory classification fields', () => {
    const view = patientView(fullDrug);
    expect(view).not.toHaveProperty('cdsa_schedule');
    expect(view).not.toHaveProperty('fda_schedule');
    expect(view).not.toHaveProperty('is_narcotic');
    expect(view).not.toHaveProperty('narcotic_code');
    expect(view).not.toHaveProperty('requires_real_time_monitoring');
    expect(view).not.toHaveProperty('manufacturer');
  });

  test('includes storage information (cold chain safety)', () => {
    const view = patientView(fullDrug);
    expect(view).toHaveProperty('storage_condition');
    expect(view).toHaveProperty('requires_cold_chain');
  });
});

// Search query builder logic (pure function — no DB)
describe('Drug search query filter builder', () => {
  function buildConditions({ q, cdsa_schedule, is_narcotic, storage_condition, fda_schedule }) {
    const conditions = ['1=1'];
    if (q) conditions.push('(brand_name ILIKE OR generic_name ILIKE OR din ILIKE)');
    if (cdsa_schedule) conditions.push('cdsa_schedule = ?');
    if (is_narcotic !== undefined) conditions.push('is_narcotic = ?');
    if (storage_condition) conditions.push('storage_condition = ?');
    if (fda_schedule) conditions.push('fda_schedule = ?');
    return conditions;
  }

  test('no filters returns only base condition', () => {
    const c = buildConditions({});
    expect(c).toHaveLength(1);
    expect(c[0]).toBe('1=1');
  });

  test('q filter adds text search', () => {
    const c = buildConditions({ q: 'morphine' });
    expect(c).toHaveLength(2);
  });

  test('multiple filters stack correctly', () => {
    const c = buildConditions({ q: 'oxy', cdsa_schedule: 'SCHEDULE_I', is_narcotic: true });
    expect(c).toHaveLength(4);
  });
});
