'use strict';

// Base URLs given with a trailing slash ("https://host/") lead to paths like "//slots".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const KEY = process.env.API_KEY;
let BASE = process.env.BASE_URL;
let server;

before(async () => {
  if (!BASE) {
    const app = require('../src/app');
    await require('../src/db').migrate();
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    BASE = `http://127.0.0.1:${server.address().port}`;
  }
});

after(async () => {
  if (server) {
    server.close();
    await require('../src/db').pool.end();
  }
});

test('double slashes in the path are tolerated', async () => {
  const res = await fetch(`${BASE.replace(/\/$/, '')}//slots?provider=x`, { headers: { 'X-API-Key': KEY } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).slots));
  const missing = await fetch(`${BASE.replace(/\/$/, '')}//bookings//does-not-exist`, { headers: { 'X-API-Key': KEY } });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'booking not found');
});
