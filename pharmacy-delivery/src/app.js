'use strict';
/**
 * @file app.js
 * @description Main Express application entry point for the Pharmacy Delivery API.
 *
 * This file wires together every middleware layer, applies security hardening,
 * mounts the API router, and starts the HTTP server.  It is intentionally kept
 * thin — all business logic lives in services/, all HTTP handling lives in
 * controllers/, and all route definitions live in routes/.
 *
 * ─── Regulatory compliance declared here ────────────────────────────────────
 *  • Controlled Drugs and Substances Act (CDSA), S.C. 1996, c. 19
 *  • Food and Drugs Act (FDA), R.S.C. 1985, c. F-27
 *  • Narcotic Control Regulations (NCR), SOR/2012-230
 *  • Benzodiazepines and Other Targeted Substances Regulations, SOR/2000-217
 *  • Health Canada — Guidance: Selling Drugs and NHPs Online (2023)
 *  • NAPRA Model Standards of Practice (2022)
 *  • PIPEDA, S.C. 2000, c. 5 (federal privacy)
 *  • Provincial PHIPA equivalents (ON, BC, AB, QC …)
 *  • Single Convention on Narcotic Drugs (UN, 1961) — Canada ratified
 *  • Convention on Psychotropic Substances (UN, 1971) — Canada ratified
 *  • United Nations Convention Against Illicit Traffic (1988)
 *  • Provincial pharmacy acts — all 13 provinces/territories
 *  • Municipal business licensing bylaws
 * ────────────────────────────────────────────────────────────────────────────
 */

// Load .env into process.env before anything else touches environment variables
require('dotenv').config();

// Patch Express router to forward async errors to the global error handler
// without requiring try/catch in every async route function
require('express-async-errors');

const express      = require('express');
const helmet       = require('helmet');     // Sets secure HTTP response headers (OWASP)
const cors         = require('cors');        // Cross-Origin Resource Sharing policy
const compression  = require('compression'); // Gzip responses to reduce bandwidth
const morgan       = require('morgan');      // HTTP request/response logging
const rateLimit    = require('express-rate-limit'); // Brute-force / DDoS protection

const routes       = require('./routes');              // All API route definitions
const errorHandler = require('./middleware/errorHandler'); // Centralised error responses
const logger       = require('./utils/logger');           // Winston structured logger

const app = express();

// ── 1. Security headers ───────────────────────────────────────────────────────
// helmet() sets a collection of security-relevant HTTP headers recommended by
// OWASP.  Each option below is explicitly configured rather than left at
// defaults so future maintainers understand exactly what is in effect.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],        // Only load resources from same origin
      scriptSrc:  ["'self'"],        // No inline scripts, no CDNs
      styleSrc:   ["'self'"],        // No inline styles
      imgSrc:     ["'self'", 'data:'], // Allow data-URIs for signature images
    },
  },
  // HTTP Strict Transport Security — browsers must use HTTPS for 1 year
  // preload: eligible for browser HSTS preload list
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ── 2. CORS policy ────────────────────────────────────────────────────────────
// Only allow requests from explicitly whitelisted pharmacy-owned origins.
// The CORS_ORIGINS environment variable must be a comma-separated list of
// full origins, e.g. "https://app.pharmacy.ca,https://admin.pharmacy.ca".
// An empty/missing list means only same-origin requests succeed.
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no Origin header (e.g. server-to-server, Postman in dev)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Origin not permitted by CORS policy'));
  },
  credentials: true, // Allow cookies/auth headers across origins
}));

// ── 3. Body parsing & compression ────────────────────────────────────────────
app.use(compression());                      // Compress responses before sending
app.use(express.json({ limit: '1mb' }));     // Parse JSON bodies; cap size to prevent payload attacks

// ── 4. HTTP request logging ───────────────────────────────────────────────────
// Logs every inbound request in Apache "combined" format (method, path, status,
// response time, user-agent).  Health-check probes are skipped to reduce noise.
// Output is piped through Winston so log files are rotated and retained for the
// 2-year minimum required by the CDSA / provincial regulations.
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
  skip:   (req) => req.path === '/health', // suppress health-check noise
}));

// ── 5. Rate limiting ──────────────────────────────────────────────────────────
// Two tiers of rate limiting:
//   a) Login endpoint — strict limit to prevent credential stuffing
//   b) All other API calls — generous limit to stop scripted abuse

// 5a. Login: maximum 10 attempts per 15-minute window per IP address.
//     After 5 failed attempts the account is also locked in the DB (see authController).
app.use('/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      10,              // 10 requests per window
  message:  { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,     // Include RateLimit-* headers in response
  legacyHeaders:   false,    // Suppress deprecated X-RateLimit-* headers
}));

// 5b. General API: 300 requests per minute per IP.
//     This accommodates normal pharmacy workflows while blocking scripts.
app.use('/api/', rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
}));

// ── 6. Proxy trust ────────────────────────────────────────────────────────────
// Tell Express to trust the first hop's X-Forwarded-For header (our load balancer).
// Required for req.ip to return the real client IP rather than the LB's IP,
// which is critical for audit logging and rate limiting accuracy.
app.set('trust proxy', 1);

// ── 7. API routes ─────────────────────────────────────────────────────────────
// All endpoints are versioned under /api/v1 to allow future non-breaking additions.
// The router itself enforces authentication, role-based access, and license checks.
app.use('/api/v1', routes);

// ── 8. 404 handler ────────────────────────────────────────────────────────────
// Any request that falls through all route handlers returns a clean JSON 404
// instead of Express's default HTML error page (which leaks framework info).
app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }));

// ── 9. Global error handler ───────────────────────────────────────────────────
// Must be registered AFTER all routes.  Four-parameter signature is required
// by Express to recognise this as an error-handling middleware.
// Strips stack traces in production to prevent information disclosure.
app.use(errorHandler);

// ── 10. Start listening ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info('Pharmacy Delivery API started', {
    port: PORT,
    env:  process.env.NODE_ENV || 'development',
    node: process.version,
  });
});

// Export app for Jest supertest integration tests
module.exports = app;
