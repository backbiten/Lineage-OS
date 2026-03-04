'use strict';
/**
 * Pharmacy Delivery API — Main Application Entry Point
 *
 * Regulatory compliance framework:
 *  - Controlled Drugs and Substances Act (CDSA), S.C. 1996, c. 19
 *  - Food and Drugs Act (FDA), R.S.C. 1985, c. F-27
 *  - Narcotic Control Regulations (NCR), SOR/2012-230
 *  - Benzodiazepines and Other Targeted Substances Regulations, SOR/2000-217
 *  - Health Canada — Guidance: Selling Drugs and Natural Health Products Online (2023)
 *  - NAPRA Model Standards of Practice (2022)
 *  - Personal Information Protection and Electronic Documents Act (PIPEDA)
 *  - Provincial Health Information Protection Acts (PHIPA-ON, etc.)
 *  - Single Convention on Narcotic Drugs (UN, 1961) — Canada ratified
 *  - Convention on Psychotropic Substances (UN, 1971) — Canada ratified
 *  - United Nations Convention Against Illicit Traffic in Narcotic Drugs (1988)
 *  - Provincial pharmacy acts — all 13 provinces/territories
 *  - Municipal business licensing bylaws (pharmacy-specific)
 */

require('dotenv').config();
require('express-async-errors');

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const compression  = require('compression');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

const routes       = require('./routes');
const errorHandler = require('./middleware/errorHandler');
const logger       = require('./utils/logger');

const app = express();

// ── Security headers (OWASP) ──────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'"],
      imgSrc:     ["'self'", 'data:'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// ── CORS — restrict to registered pharmacy origins only ───────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Origin not permitted by CORS policy'));
  },
  credentials: true,
}));

app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ── HTTP request logging ──────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
  skip:   (req) => req.path === '/health',
}));

// ── Rate limiting — protect against brute-force and abuse ─────────────────────
app.use('/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max:      10,
  message:  { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,  // 1 min
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
}));

// Trust X-Forwarded-For from load balancer only
app.set('trust proxy', 1);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Endpoint not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Pharmacy Delivery API started`, {
    port: PORT,
    env:  process.env.NODE_ENV || 'development',
    node: process.version,
  });
});

module.exports = app;  // for testing
