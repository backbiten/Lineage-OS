'use strict';
/**
 * @file utils/logger.js
 * @description Winston structured logger shared across the entire application.
 *
 * All log output is JSON-formatted so that it can be ingested by log aggregators
 * (Splunk, Datadog, CloudWatch, etc.) for operational monitoring.
 *
 * ─── Retention policy ────────────────────────────────────────────────────────
 *   maxFiles: '730d' (2 years) satisfies the MINIMUM retention requirements of:
 *    - NCR s.35(2): narcotic records kept ≥ 2 years
 *    - CDSA / provincial pharmacy acts: records available for inspection
 *   NOTE: Prescription and patient records have longer statutory retention
 *         (up to 10 years in Ontario — PHIPA s.13).  Those records live in the
 *         PostgreSQL database and are NOT deleted; the DB is the system of record.
 *         These log files are the operational trail, not the regulatory record.
 * ────────────────────────────────────────────────────────────────────────────
 */

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file'); // Adds DailyRotateFile transport to Winston

const logger = createLogger({
  // LOG_LEVEL env controls verbosity: 'debug' in dev, 'info' or 'warn' in prod
  level: process.env.LOG_LEVEL || 'info',

  format: format.combine(
    format.timestamp(),               // Adds "timestamp" field to every log entry
    format.errors({ stack: true }),   // Includes stack traces for Error objects
    format.json()                     // Emit structured JSON (ingestion-friendly)
  ),

  transports: [
    // ── General application log ───────────────────────────────────────────
    // All levels at or above `level` are written here.
    // Files rotate daily; old files are gzip-compressed to save disk space.
    new transports.DailyRotateFile({
      filename:      'logs/app-%DATE%.log',
      datePattern:   'YYYY-MM-DD',
      maxFiles:      '730d',   // 2-year retention (CDSA / NCR minimum)
      zippedArchive: true,
    }),

    // ── Error-only log ────────────────────────────────────────────────────
    // Errors are also written to a separate file so ops can quickly filter
    // for critical issues without scanning the full app log.
    new transports.DailyRotateFile({
      filename:      'logs/error-%DATE%.log',
      datePattern:   'YYYY-MM-DD',
      level:         'error',
      maxFiles:      '730d',
      zippedArchive: true,
    }),

    // ── Console transport (development / test only) ───────────────────────
    // Colourised, human-readable output during local development.
    // Excluded from production builds to avoid polluting systemd/container logs.
    ...(process.env.NODE_ENV !== 'production'
      ? [new transports.Console({ format: format.combine(format.colorize(), format.simple()) })]
      : []),
  ],
});

module.exports = logger;
