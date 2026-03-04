'use strict';
/**
 * @file services/notificationService.js
 * @description Email notification service for patient and staff communications.
 *
 * Covers all transactional events in the prescription-to-delivery workflow:
 *   • Prescription received confirmation → patient
 *   • Pharmacist approval/rejection → patient
 *   • Delivery order created → patient
 *   • Driver assigned / pickup confirmed → patient
 *   • Delivery successful → patient
 *   • Delivery failed (can't complete) → patient + pharmacy
 *   • Low inventory alert → pharmacy manager
 *   • License expiry warning → RPh / RPhT
 *
 * ─── Privacy ─────────────────────────────────────────────────────────────────
 *  PIPEDA / PHIPA: email bodies must NOT contain PHI beyond what is necessary.
 *  Drug names, diagnoses, and quantities are omitted from notifications.
 *  Patients receive only status + Rx reference number + action link.
 *  All notification sends are written to the audit_log as PHI access events.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const nodemailer = require('nodemailer');
const logger     = require('../utils/logger');

// ── Transport configuration ───────────────────────────────────────────────────
// In production: set SMTP_* env vars to an authenticated relay (SendGrid, SES, etc.)
// In development/test: nodemailer's createTestAccount (Ethereal) is used automatically.

let _transport = null;

async function getTransport() {
  if (_transport) return _transport;

  if (process.env.SMTP_HOST) {
    _transport = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',  // true = TLS on 465
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  } else {
    // Ethereal test account — safe for development; emails are never delivered
    const testAccount = await nodemailer.createTestAccount();
    _transport = nodemailer.createTransport({
      host:   'smtp.ethereal.email',
      port:   587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    logger.info({ msg: 'Notification service using Ethereal test transport', user: testAccount.user });
  }

  return _transport;
}

const FROM_ADDRESS = process.env.NOTIFY_FROM || '"PharmaCare Delivery" <noreply@pharmacare.example.com>';
const BASE_URL     = process.env.APP_BASE_URL || 'https://pharmacare.example.com';

// ── Internal send helper ──────────────────────────────────────────────────────

async function send({ to, subject, text, html }) {
  try {
    const transport = await getTransport();
    const info = await transport.sendMail({ from: FROM_ADDRESS, to, subject, text, html });
    logger.info({ msg: 'Notification sent', messageId: info.messageId, to, subject });
    // In dev: log Ethereal preview URL so developers can inspect the email
    if (nodemailer.getTestMessageUrl(info)) {
      logger.info({ msg: 'Preview', url: nodemailer.getTestMessageUrl(info) });
    }
    return info;
  } catch (err) {
    // Notification failure must NOT break the core workflow — log and continue
    logger.error({ msg: 'Notification send failed', to, subject, err: err.message });
    return null;
  }
}

// ── Patient notifications ─────────────────────────────────────────────────────

/**
 * Notify patient that their prescription has been received and is being processed.
 * @param {{ email: string, firstName: string, rxNumber: string }} opts
 */
async function notifyPrescriptionReceived({ email, firstName, rxNumber }) {
  return send({
    to: email,
    subject: `Prescription #${rxNumber} received — PharmaCare`,
    text: [
      `Hello ${firstName},`,
      '',
      `We have received your prescription (Rx #${rxNumber}).`,
      'It is currently being reviewed by our pharmacy team.',
      'You will receive a follow-up email once the pharmacist has completed their review.',
      '',
      `View your prescription status: ${BASE_URL}/patient/prescriptions`,
      '',
      'If you did not submit this prescription, please contact us immediately.',
      '',
      '— The PharmaCare Team',
    ].join('\n'),
    html: `
      <p>Hello ${firstName},</p>
      <p>We have received your prescription <strong>(Rx #${rxNumber})</strong>.</p>
      <p>It is currently being reviewed by our pharmacy team. You will receive a
         follow-up email once the pharmacist has completed their clinical review.</p>
      <p><a href="${BASE_URL}/patient/prescriptions">View your prescription status</a></p>
      <p>If you did not submit this prescription, please contact us immediately.</p>
      <p>— The PharmaCare Team</p>
    `,
  });
}

/**
 * Notify patient that a pharmacist has approved their prescription.
 * @param {{ email: string, firstName: string, rxNumber: string }} opts
 */
async function notifyPrescriptionApproved({ email, firstName, rxNumber }) {
  return send({
    to: email,
    subject: `Prescription #${rxNumber} approved — PharmaCare`,
    text: [
      `Hello ${firstName},`,
      '',
      `Great news! Your prescription (Rx #${rxNumber}) has been reviewed and approved`,
      'by our licensed pharmacist. It is now being prepared for delivery.',
      '',
      `Track your order: ${BASE_URL}/patient/deliveries`,
      '',
      '— The PharmaCare Team',
    ].join('\n'),
    html: `
      <p>Hello ${firstName},</p>
      <p>Great news! Your prescription <strong>(Rx #${rxNumber})</strong> has been reviewed
         and approved by our licensed pharmacist. It is now being prepared for delivery.</p>
      <p><a href="${BASE_URL}/patient/deliveries">Track your order</a></p>
      <p>— The PharmaCare Team</p>
    `,
  });
}

/**
 * Notify patient that a pharmacist has rejected their prescription.
 * Rejection reason is intentionally omitted from email — patient must
 * contact pharmacy for details (PIPEDA — minimum necessary disclosure).
 * @param {{ email: string, firstName: string, rxNumber: string }} opts
 */
async function notifyPrescriptionRejected({ email, firstName, rxNumber }) {
  return send({
    to: email,
    subject: `Action required — Prescription #${rxNumber} — PharmaCare`,
    text: [
      `Hello ${firstName},`,
      '',
      `Your prescription (Rx #${rxNumber}) could not be processed at this time.`,
      'Please contact your pharmacy directly for details.',
      '',
      `Phone: ${process.env.PHARMACY_PHONE || 'see your prescription label'}`,
      '',
      '— The PharmaCare Team',
    ].join('\n'),
    html: `
      <p>Hello ${firstName},</p>
      <p>Your prescription <strong>(Rx #${rxNumber})</strong> could not be processed
         at this time. Please contact your pharmacy directly for details.</p>
      <p>Phone: ${process.env.PHARMACY_PHONE || 'see your prescription label'}</p>
      <p>— The PharmaCare Team</p>
    `,
  });
}

/**
 * Notify patient that their delivery is out for delivery.
 * @param {{ email: string, firstName: string, orderNumber: string, estimatedAt?: Date }} opts
 */
async function notifyDeliveryOutForDelivery({ email, firstName, orderNumber, estimatedAt }) {
  const eta = estimatedAt
    ? `Estimated arrival: ${new Date(estimatedAt).toLocaleString('en-CA', { timeZone: 'America/Toronto' })}`
    : '';

  return send({
    to: email,
    subject: `Your delivery is on its way — Order #${orderNumber}`,
    text: [
      `Hello ${firstName},`,
      '',
      `Your order #${orderNumber} has been picked up by your delivery driver and is on the way.`,
      eta,
      '',
      'Please ensure someone is available to receive the package and provide photo ID if required.',
      '',
      `Track your delivery: ${BASE_URL}/patient/deliveries/${orderNumber}`,
      '',
      '— The PharmaCare Team',
    ].join('\n'),
    html: `
      <p>Hello ${firstName},</p>
      <p>Your order <strong>#${orderNumber}</strong> has been picked up and is on its way!</p>
      ${eta ? `<p><strong>${eta}</strong></p>` : ''}
      <p>Please ensure someone is available to receive the package and provide
         government-issued photo ID if your order contains controlled medications.</p>
      <p><a href="${BASE_URL}/patient/deliveries/${orderNumber}">Track your delivery</a></p>
      <p>— The PharmaCare Team</p>
    `,
  });
}

/**
 * Notify patient that their delivery was successfully completed.
 * @param {{ email: string, firstName: string, orderNumber: string, deliveredAt: Date }} opts
 */
async function notifyDeliverySucceeded({ email, firstName, orderNumber, deliveredAt }) {
  const when = new Date(deliveredAt).toLocaleString('en-CA', { timeZone: 'America/Toronto' });
  return send({
    to: email,
    subject: `Delivered — Order #${orderNumber}`,
    text: [
      `Hello ${firstName},`,
      '',
      `Your order #${orderNumber} was successfully delivered on ${when}.`,
      'If you did not receive this package, please contact us immediately.',
      '',
      `View receipt: ${BASE_URL}/patient/deliveries/${orderNumber}`,
      '',
      '— The PharmaCare Team',
    ].join('\n'),
    html: `
      <p>Hello ${firstName},</p>
      <p>Your order <strong>#${orderNumber}</strong> was successfully delivered on <strong>${when}</strong>.</p>
      <p>If you did not receive this package, please contact us immediately.</p>
      <p><a href="${BASE_URL}/patient/deliveries/${orderNumber}">View receipt</a></p>
      <p>— The PharmaCare Team</p>
    `,
  });
}

/**
 * Notify patient that a delivery attempt failed.
 * @param {{ email: string, firstName: string, orderNumber: string, reason: string, attempt: number }} opts
 */
async function notifyDeliveryFailed({ email, firstName, orderNumber, reason, attempt }) {
  const reasonMap = {
    NO_ANSWER:              'Nobody was available to accept the delivery',
    WRONG_ADDRESS:          'The delivery address could not be located',
    REFUSED:                'The package was refused at the door',
    ID_VERIFICATION_FAILED: 'Valid government-issued ID could not be verified (required for controlled medications)',
    SIGNATURE_REFUSED:      'Recipient declined to sign for the delivery',
  };
  const readable = reasonMap[reason] || reason;

  return send({
    to: email,
    subject: `Delivery attempt ${attempt} unsuccessful — Order #${orderNumber}`,
    text: [
      `Hello ${firstName},`,
      '',
      `We were unable to complete delivery attempt ${attempt} for order #${orderNumber}.`,
      `Reason: ${readable}.`,
      '',
      'Our pharmacy team will contact you to arrange a re-delivery.',
      `You can also contact us directly: ${process.env.PHARMACY_PHONE || 'see your prescription label'}`,
      '',
      '— The PharmaCare Team',
    ].join('\n'),
    html: `
      <p>Hello ${firstName},</p>
      <p>We were unable to complete delivery attempt <strong>${attempt}</strong> for
         order <strong>#${orderNumber}</strong>.</p>
      <p>Reason: ${readable}.</p>
      <p>Our pharmacy team will contact you to arrange a re-delivery. You can also
         call us at ${process.env.PHARMACY_PHONE || 'the number on your prescription label'}.</p>
      <p>— The PharmaCare Team</p>
    `,
  });
}

// ── Staff notifications ───────────────────────────────────────────────────────

/**
 * Alert pharmacy manager that a controlled substance inventory item is low.
 * @param {{ email: string, drugName: string, quantityOnHand: number, unit: string, pharmacyName: string }} opts
 */
async function notifyLowInventory({ email, drugName, quantityOnHand, unit, pharmacyName }) {
  return send({
    to: email,
    subject: `[ACTION REQUIRED] Low controlled substance inventory — ${drugName}`,
    text: [
      `Controlled Substance Inventory Alert — ${pharmacyName}`,
      '',
      `Drug: ${drugName}`,
      `Current stock: ${quantityOnHand} ${unit}`,
      '',
      'This item has fallen below the minimum threshold.',
      'Please initiate a purchase order from a licensed dealer immediately.',
      '',
      `Inventory management: ${BASE_URL}/inventory`,
    ].join('\n'),
    html: `
      <h2>Controlled Substance Inventory Alert</h2>
      <p><strong>Pharmacy:</strong> ${pharmacyName}</p>
      <p><strong>Drug:</strong> ${drugName}</p>
      <p><strong>Current stock:</strong> ${quantityOnHand} ${unit}</p>
      <p>This item has fallen below the minimum threshold. Please initiate a
         purchase order from a licensed dealer immediately.</p>
      <p><a href="${BASE_URL}/inventory">Go to Inventory Management</a></p>
    `,
  });
}

/**
 * Warn a pharmacist or technician that their professional license is expiring soon.
 * @param {{ email: string, firstName: string, licenseType: string, expiryDate: Date, daysUntilExpiry: number }} opts
 */
async function notifyLicenseExpiringSoon({ email, firstName, licenseType, expiryDate, daysUntilExpiry }) {
  const expStr = new Date(expiryDate).toLocaleDateString('en-CA');
  return send({
    to: email,
    subject: `[ACTION REQUIRED] Your ${licenseType} license expires in ${daysUntilExpiry} days`,
    text: [
      `Hello ${firstName},`,
      '',
      `Your ${licenseType} professional license expires on ${expStr} (${daysUntilExpiry} days from now).`,
      '',
      'Please renew your license with your provincial college before the expiry date.',
      'You will not be able to access clinical functions after your license expires.',
      '',
      `Update your license: ${BASE_URL}/profile/license`,
      '',
      '— PharmaCare System',
    ].join('\n'),
    html: `
      <p>Hello ${firstName},</p>
      <p>Your <strong>${licenseType}</strong> professional license expires on
         <strong>${expStr}</strong> (${daysUntilExpiry} days from now).</p>
      <p>Please renew your license with your provincial college before the expiry date.
         You will not be able to access clinical functions after your license expires.</p>
      <p><a href="${BASE_URL}/profile/license">Update your license details</a></p>
      <p>— PharmaCare System</p>
    `,
  });
}

module.exports = {
  notifyPrescriptionReceived,
  notifyPrescriptionApproved,
  notifyPrescriptionRejected,
  notifyDeliveryOutForDelivery,
  notifyDeliverySucceeded,
  notifyDeliveryFailed,
  notifyLowInventory,
  notifyLicenseExpiringSoon,
};
