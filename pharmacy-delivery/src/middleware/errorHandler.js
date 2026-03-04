'use strict';
/**
 * @file middleware/errorHandler.js
 * @description Centralised Express error-handling middleware.
 *
 * Registered in app.js as the LAST middleware in the chain.  Express routes
 * any error passed to next(err) — or any unhandled exception caught by the
 * express-async-errors patch — here.
 *
 * Responsibilities:
 *  1. Log the full error (including stack trace) to Winston for ops/audit
 *  2. Return a clean JSON error body to the API client
 *  3. NEVER leak stack traces or internal details to clients in production
 *     (information disclosure prevention — OWASP A05)
 *
 * Errors thrown from services carry an optional `.status` (HTTP code) and
 * `.details` (validation array) to give clients actionable information
 * without exposing implementation internals.
 */

const logger = require('../utils/logger');

/**
 * Four-parameter signature is required by Express to recognise this function
 * as an error handler rather than a regular middleware.
 * eslint-disable comment suppresses the "next is defined but never used" warning.
 *
 * @param {Error}   err  - error thrown or passed to next(err)
 * @param {object}  req  - Express request
 * @param {object}  res  - Express response
 * @param {Function} next - unused but required by Express convention
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Use err.status if the throwing code set it (422, 403, 404 …),
  // otherwise default to 500 Internal Server Error
  const status  = err.status || 500;
  const message = err.message || 'Internal server error';

  // Log full detail server-side; include userId for regulatory traceability
  logger.error('Unhandled error', {
    status,
    message,
    stack:  err.stack,
    path:   req.path,
    method: req.method,
    userId: req.user?.id,
  });

  res.status(status).json({
    error: message,
    // Include structured validation details if the service provided them
    // (e.g., prescription validation errors — safe to expose to client)
    ...(err.details ? { details: err.details } : {}),
    // Stack trace ONLY in non-production environments (development / test)
    ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
}

module.exports = errorHandler;
