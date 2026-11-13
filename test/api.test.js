'use strict';

// End-to-end checks against the spec. Runs against BASE_URL if set (e.g. the deployed app),
// otherwise starts the app in-process (needs DATABASE_URL and API_KEY).
//   API_KEY=... BASE_URL=https://your-app.vercel.app npm test
// NOTE: calls POST /reset, which wipes all data.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const KEY = process.env.API_KEY;
let BASE = process.env.BASE_URL;
let server;

before(async () => {
  if (!BASE) {
    const app = require('../src/app');
    await require('../src/db').migrate();
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    BASE = `http://127.0.0.1:${server.address().port}`;
  }
});

after(async () => {
  if (server) {
    server.close();
    await require('../src/db').pool.end();
  }
});

async function call(method, path, { body, headers = {}, key = KEY } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (key !== null) h['X-API-Key'] = key;
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().replace('.000', '');
const HOUR = 3_600_000;
const uniq = () => `${crypto.randomUUID().slice(0, 8)}@example.com`;

async function reset(extra = []) {
  const slots = [
    { id: 's2', provider: 'Dr Ade', start: iso(2 * HOUR), end: iso(2.5 * HOUR) },
    { id: 's1', provider: 'Dr Ade', start: iso(1 * HOUR), end: iso(1.5 * HOUR) },
    { id: 's3', provider: 'Dr Bola', start: iso(3 * HOUR), end: iso(3.5 * HOUR) },
    { id: 'past', provider: 'Dr Bola', start: iso(-2 * HOUR), end: iso(-1.5 * HOUR) },
    ...extra,
  ];
  const r = await call('POST', '/reset', { body: { slots } });
  assert.equal(r.status, 200);
  return slots;
}

test('level 1: reset, list slots, book, look up', async () => {
  const slots = await reset();
  const list = await call('GET', '/slots');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.slots.map((s) => s.id), ['past', 's1', 's2', 's3']);
  const s1 = list.body.slots.find((s) => s.id === 's1');
  assert.deepEqual(s1, { ...slots.find((s) => s.id === 's1'), available: true });

  const filtered = await call('GET', '/slots?provider=Dr%20Bola');
  assert.deepEqual(filtered.body.slots.map((s) => s.id), ['past', 's3']);

  const email = uniq();
  const b = await call('POST', '/bookings', { body: { slot_id: 's1', name: '  Ada Obi ', email: `  ${email.toUpperCase()} ` } });
  assert.equal(b.status, 201);
  assert.equal(b.body.status, 'confirmed');
  assert.equal(b.body.name, 'Ada Obi');
  assert.equal(b.body.email, email);
  assert.equal(b.body.slot_id, 's1');
  assert.ok(b.body.id);
  assert.ok(!Number.isNaN(Date.parse(b.body.created_at)));

  const got = await call('GET', `/bookings/${b.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, b.body);

  const after = await call('GET', '/slots');
  assert.equal(after.body.slots.find((s) => s.id === 's1').available, false);

  assert.equal((await call('GET', '/bookings/nope')).status, 404);
});

test('level 2: API key and validation', async () => {
  await reset();
  assert.equal((await call('GET', '/slots', { key: null })).status, 401);
  assert.equal((await call('GET', '/slots', { key: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/bookings', { key: 'wrong', body: {} })).status, 401);
  assert.equal((await call('POST', '/reset', { key: null, body: { slots: [] } })).status, 401);

  const bad = [
    { name: 'A', email: uniq() },
    { slot_id: '', name: 'A', email: uniq() },
    { slot_id: 's1', email: uniq() },
    { slot_id: 's1', name: '   ', email: uniq() },
    { slot_id: 's1', name: 'A' },
    { slot_id: 's1', name: 'A', email: 'not-an-email' },
    { slot_id: 's1', name: 'A', email: 'a@b' },
    { slot_id: 's1', name: 123, email: uniq() },
  ];
  for (const body of bad) {
    const r = await call('POST', '/bookings', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 'zzz', name: 'A', email: uniq() } })).status, 404);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 'past', name: 'A', email: uniq() } })).status, 400);
});

test('level 3: concurrent bookings of one slot -> exactly one wins; cancel frees it', async () => {
  await reset();
  const results = await Promise.all(
    Array.from({ length: 25 }, () => call('POST', '/bookings', { body: { slot_id: 's2', name: 'Racer', email: uniq() } }))
  );
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1, codes.join(','));
  assert.equal(codes.filter((c) => c === 409).length, 24, codes.join(','));

  const winner = results.find((r) => r.status === 201).body;
  const cancelled = await call('DELETE', `/bookings/${winner.id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.id, winner.id);
  assert.equal((await call('DELETE', `/bookings/${winner.id}`)).status, 409);
  assert.equal((await call('DELETE', '/bookings/nope')).status, 404);
  assert.equal((await call('GET', `/bookings/${winner.id}`)).body.status, 'cancelled');

  const slots = await call('GET', '/slots');
  assert.equal(slots.body.slots.find((s) => s.id === 's2').available, true);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Again', email: uniq() } })).status, 201);
});

test('level 4: idempotency', async () => {
  await reset();
  const key = crypto.randomUUID();
  const body = { slot_id: 's3', name: 'Idem', email: uniq() };

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => call('POST', '/bookings', { body, headers: { 'Idempotency-Key': key } }))
  );
  for (const r of concurrent) {
    assert.equal(r.status, 201);
    assert.equal(r.body.id, concurrent[0].body.id);
  }
  const again = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': key } });
  assert.equal(again.status, 201);
  assert.equal(again.body.id, concurrent[0].body.id);

  const mine = await call('GET', `/bookings?email=${encodeURIComponent(body.email)}`);
  assert.equal(mine.body.bookings.length, 1);

  const diff = await call('POST', '/bookings', { body: { ...body, name: 'Other' }, headers: { 'Idempotency-Key': key } });
  assert.equal(diff.status, 422);

  // A failure is replayed too.
  const k2 = crypto.randomUUID();
  const b2 = { slot_id: 's3', name: 'Late', email: uniq() };
  assert.equal((await call('POST', '/bookings', { body: b2, headers: { 'Idempotency-Key': k2 } })).status, 409);
  assert.equal((await call('POST', '/bookings', { body: b2, headers: { 'Idempotency-Key': k2 } })).status, 409);
});

test('level 4: pagination of a person\'s bookings', async () => {
  const extra = Array.from({ length: 12 }, (_, i) => ({
    id: `p${i}`, provider: 'Dr Page', start: iso((10 + i) * HOUR), end: iso((10.5 + i) * HOUR),
  }));
  await reset(extra);
  const email = uniq();
  const ids = [];
  // The rate limit allows 5 attempts per email per minute, so page through 5 bookings
  // (one of them cancelled — cancelled bookings are still listed).
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/bookings', { body: { slot_id: `p${i}`, name: 'Pager', email } });
    assert.equal(r.status, 201);
    ids.push(r.body.id);
  }
  await call('DELETE', `/bookings/${ids[1]}`);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ email: email.toUpperCase(), limit: '2' });
    if (cursor) qs.set('cursor', cursor);
    const r = await call('GET', `/bookings?${qs}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.bookings.length <= 2);
    assert.ok('next_cursor' in r.body);
    seen.push(...r.body.bookings.map((b) => b.id));
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids);
  assert.equal(pages, 3);

  const all = await call('GET', `/bookings?email=${encodeURIComponent(email)}`);
  assert.equal(all.body.bookings.length, 5);
  assert.equal(all.body.next_cursor, null);

  for (const limit of ['0', '51', 'abc', '-1', '2.5', '']) {
    const r = await call('GET', `/bookings?email=${encodeURIComponent(email)}&limit=${limit}`);
    assert.equal(r.status, 400, `limit=${limit}`);
  }
  assert.equal((await call('GET', `/bookings?email=${encodeURIComponent(email)}&limit=50`)).status, 200);
  assert.equal((await call('GET', `/bookings?email=${encodeURIComponent(email)}&limit=1`)).status, 200);
});

test('level 5: rate limit per email', async () => {
  await reset();
  const email = uniq();
  const codes = [];
  for (let i = 0; i < 6; i++) {
    // Mix of failures (bad slot) and one success — all count.
    const r = await call('POST', '/bookings', { body: { slot_id: i === 0 ? 's1' : 'missing', name: 'Spam', email } });
    codes.push(r.status);
    if (i === 5) {
      assert.equal(r.status, 429);
      const ra = r.headers.get('retry-after');
      assert.match(ra, /^\d+$/);
      assert.ok(Number(ra) >= 1 && Number(ra) <= 60);
    }
  }
  assert.deepEqual(codes, [201, 404, 404, 404, 404, 429]);
  // Same email in different case is the same person.
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Spam', email: email.toUpperCase() } })).status, 429);
  // Other emails unaffected.
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Other', email: uniq() } })).status, 201);
});

test('level 5: concurrent burst from one email allows at most 5', async () => {
  await reset();
  const email = uniq();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => call('POST', '/bookings', { body: { slot_id: 'missing', name: 'Burst', email } }))
  );
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 429).length, 7, codes.join(','));
});
