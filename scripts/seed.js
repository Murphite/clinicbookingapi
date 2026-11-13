'use strict';

// Fills the deployed (or local) API with sample slots over the next two weeks via POST /reset.
// WARNING: /reset deletes every booking.
//   BASE_URL=https://your-app.vercel.app API_KEY=... node scripts/seed.js

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const KEY = process.env.API_KEY;
if (!KEY) {
  console.error('Set API_KEY');
  process.exit(1);
}

const providers = ['Dr Ade', 'Dr Bola', 'Dr Chidi'];
const slots = [];
const day0 = new Date();
day0.setUTCHours(0, 0, 0, 0);
let n = 1;
for (let d = 1; d <= 14; d++) {
  const day = new Date(day0.getTime() + d * 86_400_000);
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue; // weekdays only
  for (const [i, provider] of providers.entries()) {
    for (const hour of [9, 10, 11, 14, 15]) {
      const start = new Date(day);
      start.setUTCHours(hour, i * 10, 0, 0);
      const end = new Date(start.getTime() + 30 * 60_000);
      slots.push({
        id: `s${n++}`,
        provider,
        start: start.toISOString().replace('.000Z', 'Z'),
        end: end.toISOString().replace('.000Z', 'Z'),
      });
    }
  }
}

fetch(`${BASE}/reset`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
  body: JSON.stringify({ slots }),
})
  .then(async (res) => {
    console.log(res.status, await res.text());
    if (!res.ok) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
