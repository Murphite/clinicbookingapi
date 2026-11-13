'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { pool, migrate, withTransaction } = require('./db');

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error('API_KEY is not set');
}

const RATE_LIMIT_MAX = 5; // attempts
const RATE_LIMIT_WINDOW_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ---------- CORS (lets the page, or any browser tool, call the API) ----------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Idempotency-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---------- Public: the web page and a health check ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- API key (level 2) ----------
function keyMatches(given) {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(API_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  if (!keyMatches(req.get('X-API-Key'))) {
    return res.status(401).json({ error: 'missing or invalid API key' });
  }
  next();
});

// Parse JSON regardless of Content-Type so a missing header doesn't silently drop the body.
app.use(express.json({ type: () => true, limit: '1mb' }));

// Make sure the schema exists before touching the DB.
app.use(async (req, res, next) => {
  try {
    await migrate();
    next();
  } catch (err) {
    next(err);
  }
});

// ---------- Helpers ----------
function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toSlot(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: row.start_raw,
    end: row.end_raw,
    available: row.available,
  };
}

/** Deterministic JSON (sorted keys) so the same body always hashes the same. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function singleQueryValue(value) {
  if (Array.isArray(value)) return undefined;
  return typeof value === 'string' ? value : undefined;
}

function normaliseEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function encodeCursor(seq) {
  return Buffer.from(`b:${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^b:(\d{1,18})$/.exec(text);
  if (!m) throw new HttpError(400, 'invalid cursor');
  return m[1];
}

// ---------- POST /reset (level 1) ----------
app.post('/reset', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.slots)) {
    throw new HttpError(400, 'slots must be an array');
  }

  const seen = new Set();
  const slots = body.slots.map((s, i) => {
    if (!s || typeof s !== 'object') throw new HttpError(400, `slots[${i}] must be an object`);
    for (const field of ['id', 'provider', 'start', 'end']) {
      if (typeof s[field] !== 'string' || s[field].trim() === '') {
        throw new HttpError(400, `slots[${i}].${field} is required`);
      }
    }
    const startMs = Date.parse(s.start);
    const endMs = Date.parse(s.end);
    if (Number.isNaN(startMs)) throw new HttpError(400, `slots[${i}].start is not a valid date-time`);
    if (Number.isNaN(endMs)) throw new HttpError(400, `slots[${i}].end is not a valid date-time`);
    if (seen.has(s.id)) throw new HttpError(400, `duplicate slot id: ${s.id}`);
    seen.add(s.id);
    return {
      id: s.id,
      provider: s.provider,
      start_raw: s.start,
      end_raw: s.end,
      start_at: new Date(startMs).toISOString(),
      end_at: new Date(endMs).toISOString(),
    };
  });

  await withTransaction(async (client) => {
    // Lock out concurrent writers for the duration of the reset.
    await client.query(
      'LOCK TABLE slots, bookings, idempotency_keys, booking_attempts IN ACCESS EXCLUSIVE MODE'
    );
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM idempotency_keys');
    await client.query('DELETE FROM booking_attempts');
    await client.query('DELETE FROM slots');
    if (slots.length) {
      await client.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])`,
        [
          slots.map((s) => s.id),
          slots.map((s) => s.provider),
          slots.map((s) => s.start_raw),
          slots.map((s) => s.end_raw),
          slots.map((s) => s.start_at),
          slots.map((s) => s.end_at),
        ]
      );
    }
  });

  res.status(200).json({ ok: true, slots: slots.length });
});

// ---------- GET /slots (level 1) ----------
app.get('/slots', async (req, res) => {
  const provider = singleQueryValue(req.query.provider);
  const params = [];
  let where = '';
  if (provider !== undefined) {
    params.push(provider);
    where = 'WHERE s.provider = $1';
  }
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_raw, s.end_raw,
            NOT EXISTS (
              SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
            ) AS available
       FROM slots s
       ${where}
      ORDER BY s.start_at, s.id`,
    params
  );
  res.json({ slots: rows.map(toSlot) });
});

// ---------- POST /bookings (levels 1-5) ----------

/** Validate and create a booking inside `client`'s transaction. Returns { status, body }. */
async function createBooking(client, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'request body must be a JSON object' } };
  }
  const fields = {};
  for (const field of ['slot_id', 'name', 'email']) {
    const v = body[field];
    if (typeof v !== 'string' || v.trim() === '') {
      return { status: 400, body: { error: `${field} is required` } };
    }
    fields[field] = v.trim();
  }
  const slotId = fields.slot_id;
  const name = fields.name;
  const email = fields.email.toLowerCase();

  if (name.length > 200) return { status: 400, body: { error: 'name is too long' } };
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return { status: 400, body: { error: 'email is invalid' } };
  }

  const slot = await client.query(
    'SELECT id, start_at <= clock_timestamp() AS started FROM slots WHERE id = $1',
    [slotId]
  );
  if (slot.rowCount === 0) return { status: 404, body: { error: 'slot not found' } };
  if (slot.rows[0].started) return { status: 400, body: { error: 'slot has already started' } };

  // If another confirmed booking exists (or is being inserted concurrently), the partial
  // unique index makes this a no-op instead of a second booking.
  const inserted = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), slotId, name, email]
  );
  if (inserted.rowCount === 0) return { status: 409, body: { error: 'slot is already booked' } };
  return { status: 201, body: toBooking(inserted.rows[0]) };
}

/**
 * Sliding-window limit: at most RATE_LIMIT_MAX attempts per email per window. Runs inside the
 * booking transaction; a per-email advisory lock (held until commit) serialises concurrent
 * attempts so a burst can't slip past the count. Records the attempt when allowed.
 */
async function checkRateLimit(client, email) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rl:' || $1, 0))", [email]);
  const { rows } = await client.query(
    `SELECT count(*)::int AS n,
            ceil(extract(epoch FROM (min(attempted_at) + make_interval(secs => $2)) - clock_timestamp()))::int AS retry
       FROM booking_attempts
      WHERE email = $1 AND attempted_at > clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_LIMIT_WINDOW_SECONDS]
  );
  if (rows[0].n >= RATE_LIMIT_MAX) {
    return { limited: true, retryAfter: Math.max(1, rows[0].retry || 1) };
  }
  // Insert the attempt, occasionally pruning old ones in the same round trip.
  await client.query(
    `WITH pruned AS (
       DELETE FROM booking_attempts
        WHERE $2 AND attempted_at < clock_timestamp() - interval '1 hour'
     )
     INSERT INTO booking_attempts (email) VALUES ($1)`,
    [email, Math.random() < 0.05]
  );
  return { limited: false };
}

class RateLimited extends Error {
  constructor(retryAfter) {
    super('rate limited');
    this.retryAfter = retryAfter;
  }
}

async function findIdempotent(key) {
  const { rows } = await pool.query(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
    [key]
  );
  return rows[0];
}

function replay(res, stored, requestHash) {
  if (stored.request_hash !== requestHash) {
    return res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
  }
  res.set('Idempotent-Replayed', 'true');
  return res.status(stored.status_code).json(stored.response);
}

app.post('/bookings', async (req, res) => {
  const body = req.body;
  const rawKey = req.get('Idempotency-Key');
  const key = rawKey && rawKey.trim() !== '' ? rawKey : null;
  if (key && key.length > 255) throw new HttpError(400, 'Idempotency-Key is too long');
  const requestHash = key ? sha256(canonicalJson(body ?? null)) : null;

  // 1. A retry of a completed request: replay it (doesn't count as a new attempt).
  if (key) {
    const stored = await findIdempotent(key);
    if (stored) return replay(res, stored, requestHash);
  }

  // 2. One transaction: claim the key (concurrent retries with the same key wait here and then
  //    replay this result), apply the per-email rate limit (failed attempts count too), book.
  //    A 429 rolls everything back, so it is neither stored nor counted.
  const email = body && typeof body === 'object' ? normaliseEmail(body.email) : '';
  let raced = false;
  let result;
  try {
    result = await withTransaction(async (client) => {
      if (key) {
        const claim = await client.query(
          `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
           ON CONFLICT (key) DO NOTHING RETURNING key`,
          [key, requestHash]
        );
        if (claim.rowCount === 0) {
          raced = true;
          return null;
        }
      }
      if (email) {
        const rl = await checkRateLimit(client, email);
        if (rl.limited) throw new RateLimited(rl.retryAfter);
      }
      const outcome = await createBooking(client, body);
      if (key) {
        await client.query(
          'UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1',
          [key, outcome.status, JSON.stringify(outcome.body)]
        );
      }
      return outcome;
    });
  } catch (err) {
    if (!(err instanceof RateLimited)) throw err;
    res.set('Retry-After', String(err.retryAfter));
    return res.status(429).json({ error: 'too many booking attempts for this email, try again later' });
  }

  if (raced) {
    const stored = await findIdempotent(key);
    if (stored && stored.status_code) return replay(res, stored, requestHash);
    throw new HttpError(409, 'a request with this Idempotency-Key is still in progress');
  }
  return res.status(result.status).json(result.body);
});

// ---------- GET /bookings?email= (level 4) ----------
app.get('/bookings', async (req, res) => {
  const email = normaliseEmail(singleQueryValue(req.query.email));
  if (!email) throw new HttpError(400, 'email is required');

  let limit = 10;
  if (req.query.limit !== undefined) {
    const raw = singleQueryValue(req.query.limit);
    if (raw === undefined || !/^\d+$/.test(raw.trim())) throw new HttpError(400, 'limit must be an integer from 1 to 50');
    limit = Number(raw.trim());
    if (limit < 1 || limit > 50) throw new HttpError(400, 'limit must be an integer from 1 to 50');
  }

  let afterSeq = '0';
  if (req.query.cursor !== undefined) {
    const cursor = singleQueryValue(req.query.cursor);
    if (!cursor) throw new HttpError(400, 'invalid cursor');
    afterSeq = decodeCursor(cursor);
  }

  const { rows } = await pool.query(
    `SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [email, afterSeq, limit + 1]
  );
  const page = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null;
  res.json({ bookings: page.map(toBooking), next_cursor });
});

// ---------- GET /bookings/:id (level 1) ----------
app.get('/bookings/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!rows.length) throw new HttpError(404, 'booking not found');
  res.json(toBooking(rows[0]));
});

// ---------- DELETE /bookings/:id (level 3) ----------
app.delete('/bookings/:id', async (req, res) => {
  const updated = await pool.query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE id = $1 AND status = 'confirmed'
      RETURNING *`,
    [req.params.id]
  );
  if (updated.rowCount) return res.json(toBooking(updated.rows[0]));

  const existing = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) throw new HttpError(404, 'booking not found');
  throw new HttpError(409, 'booking is already cancelled');
});

// ---------- Fallbacks ----------
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    if (err.headers) res.set(err.headers);
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'request body is not valid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body is too large' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

module.exports = app;
