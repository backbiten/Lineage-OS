'use strict';
/**
 * @file config/database.js
 * @description Shared PostgreSQL connection pool (singleton).
 *
 * A single pg.Pool instance is created here and exported.  Every module that
 * needs DB access imports this file rather than creating its own connections,
 * keeping the total open-connection count bounded by `max` (20 by default).
 *
 * All connection parameters come from environment variables so that no
 * credentials are ever hard-coded in source (PIPEDA Principle 7 / OWASP A02).
 *
 * SSL:
 *   Set DB_SSL=true in production.  rejectUnauthorized: true ensures the
 *   Postgres server certificate is validated, protecting PHI in transit.
 */

const { Pool } = require('pg');

// pg.Pool maintains a warm pool of TCP connections to Postgres.
// It checks out an idle connection per query and returns it when done
// (or when client.release() is called after a manual transaction).
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'pharmacy_delivery',
  user:     process.env.DB_USER     || 'pharmacy_app',
  password: process.env.DB_PASSWORD,           // No default — must be set in env

  // Validate server TLS certificate; prevents MITM on the PHI-carrying
  // connection (required by PIPEDA Principle 7 — Safeguards)
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,

  max:                    20,    // Max simultaneous Postgres connections
  idleTimeoutMillis:   30000,    // Release connections idle for > 30 s
  connectionTimeoutMillis: 5000, // Fail fast if pool exhausted (5 s)
});

// Surface pool-level errors to stderr rather than crashing the process.
// A pool error usually indicates a transient network blip; the pool will
// attempt to reconnect automatically on the next query.
pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err);
});

module.exports = pool;
