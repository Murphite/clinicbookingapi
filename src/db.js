'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // An idle client errored (e.g. the DB closed the connection). Log and carry on;
  // the pool will create a fresh client on the next query.
  console.error('pg pool error', err.message);
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_raw TEXT NOT NULL,          -- exactly as sent to /reset, echoed back unchanged
  end_raw   TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,   -- parsed, used for ordering and "already started"
  end_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL UNIQUE,      -- stable insertion order, used for cursors
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- The double-booking guard: at most one confirmed booking per slot, enforced by the DB.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq_idx ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code  INT,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS booking_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_time_idx
  ON booking_attempts (email, attempted_at);
`;

let migrated = null;

/** Create tables once per process. Serialised with an advisory lock so concurrent cold starts don't race. */
function migrate() {
  if (!migrated) {
    migrated = withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(724001)');
      await client.query(SCHEMA);
    }).catch((err) => {
      migrated = null; // allow a retry on the next request
      throw err;
    });
  }
  return migrated;
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, withTransaction };
