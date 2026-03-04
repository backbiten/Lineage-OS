'use strict';
/**
 * @file tests/notificationService.test.js
 * Unit tests for the notification service.
 * Uses nodemailer's createTestAccount so no real emails are sent.
 */

const notificationService = require('../src/services/notificationService');

// All notification functions should resolve without throwing
// and return a nodemailer info object (or null on deliberate failure).

describe('notificationService', () => {
  const BASE = {
    email: 'patient@example.com',
    firstName: 'Jane',
    rxNumber: 'RX-0001',
  };

  test('notifyPrescriptionReceived resolves', async () => {
    await expect(notificationService.notifyPrescriptionReceived(BASE)).resolves.not.toThrow();
  });

  test('notifyPrescriptionApproved resolves', async () => {
    await expect(notificationService.notifyPrescriptionApproved(BASE)).resolves.not.toThrow();
  });

  test('notifyPrescriptionRejected resolves', async () => {
    await expect(notificationService.notifyPrescriptionRejected(BASE)).resolves.not.toThrow();
  });

  test('notifyDeliveryOutForDelivery resolves', async () => {
    await expect(notificationService.notifyDeliveryOutForDelivery({
      email: BASE.email,
      firstName: BASE.firstName,
      orderNumber: 'DO-0001',
      estimatedAt: new Date(),
    })).resolves.not.toThrow();
  });

  test('notifyDeliverySucceeded resolves', async () => {
    await expect(notificationService.notifyDeliverySucceeded({
      email: BASE.email,
      firstName: BASE.firstName,
      orderNumber: 'DO-0001',
      deliveredAt: new Date(),
    })).resolves.not.toThrow();
  });

  test('notifyDeliveryFailed resolves with known reason code', async () => {
    await expect(notificationService.notifyDeliveryFailed({
      email: BASE.email,
      firstName: BASE.firstName,
      orderNumber: 'DO-0001',
      reason: 'NO_ANSWER',
      attempt: 1,
    })).resolves.not.toThrow();
  });

  test('notifyDeliveryFailed resolves with unknown reason code', async () => {
    await expect(notificationService.notifyDeliveryFailed({
      email: BASE.email,
      firstName: BASE.firstName,
      orderNumber: 'DO-0001',
      reason: 'UNEXPECTED_REASON',
      attempt: 2,
    })).resolves.not.toThrow();
  });

  test('notifyLowInventory resolves', async () => {
    await expect(notificationService.notifyLowInventory({
      email: 'manager@pharmacy.example.com',
      drugName: 'Morphine 10mg',
      quantityOnHand: 3,
      unit: 'tablets',
      pharmacyName: 'Main Street Pharmacy',
    })).resolves.not.toThrow();
  });

  test('notifyLicenseExpiringSoon resolves', async () => {
    await expect(notificationService.notifyLicenseExpiringSoon({
      email: 'rph@pharmacy.example.com',
      firstName: 'Dr. Smith',
      licenseType: 'RPh',
      expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      daysUntilExpiry: 30,
    })).resolves.not.toThrow();
  });
});
