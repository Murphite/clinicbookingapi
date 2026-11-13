# Clinic Booking API

A clinic appointment booking API, plus a small web page that uses it. The API follows the
[assessment spec](https://koyaacademy.com/assessment-api) (OpenAPI 3.0).

Stack: Node.js 20+, Express 5, PostgreSQL. It runs as a normal server, or as a Vercel serverless function.

## Endpoints

Every endpoint requires the `X-API-Key` header. Every error looks like `{"error": "..."}`.

| Method | Path | What it does |
|---|---|---|
| POST | `/reset` | Deletes every booking and replaces all slots. Body: `{"slots": [...]}` |
| GET | `/slots?provider=` | Lists all slots, earliest first, each with an `available` flag |
| POST | `/bookings` | Books a slot. Body: `{slot_id, name, email}`. Accepts an optional `Idempotency-Key` header |
| GET | `/bookings?email=&limit=&cursor=` | Lists one person's bookings, oldest first, with cursor pagination |
| GET | `/bookings/{id}` | Gets one booking |
| DELETE | `/bookings/{id}` | Cancels a booking (200), or returns 409 if it's already cancelled |

The web page is served at `/`. `/health` needs no key.

## How each level is handled

- **Level 2, validation.** The service trims `name` and `email` and lowercases `email`. It returns 400 for a missing, empty, or non-string field, or an invalid email. It returns 404 for an unknown slot, and 400 if the slot has already started.
- **Level 3, no double booking.** A partial unique index `ON bookings(slot_id) WHERE status = 'confirmed'` lets the database guarantee at most one confirmed booking per slot. The insert uses `ON CONFLICT ... DO NOTHING`, so when two requests arrive at the same instant, one gets 201 and the other 409. This holds across any number of server instances. Cancelling flips `status` to `cancelled` in one conditional `UPDATE`, which frees the slot.
- **Level 4, idempotency.** The service stores each key with a SHA-256 hash of the canonical JSON body, along with the response it returned. The key is claimed in the same transaction that creates the booking. Concurrent retries with the same key wait on the key's row lock, then replay the stored response: same status, same booking `id`. Reusing a key with a different body returns 422. Responses with status 429 or 5xx aren't stored, so the client can retry them.
- **Level 4, pagination.** The cursor is an opaque, base64url-encoded value of an increasing sequence column, so pages stay stable while new bookings arrive. `limit` must be an integer from 1 to 50; anything else returns 400. The last page has `next_cursor: null`.
- **Level 5, rate limiting.** A sliding window allows 5 attempts per email (case-insensitive) per 60 seconds. Failed attempts count. A per-email advisory lock serialises the count, so a burst can't slip past the limit. The 6th attempt gets 429, with a `Retry-After` header giving the whole seconds until the oldest attempt leaves the window. Replays of an idempotent request don't count as new attempts.

## Run locally

```bash
npm install
cp .env.example .env    # then set DATABASE_URL and API_KEY in .env
node --env-file=.env src/server.js
BASE_URL=http://localhost:3000 API_KEY=... node scripts/seed.js   # add sample slots
```

## Tests

```bash
# In-process, against a scratch database:
DATABASE_URL=... API_KEY=... npm test
# Against a deployed instance (warning: calls /reset, which wipes all data):
BASE_URL=https://your-app.vercel.app API_KEY=... npm test
```

## Deploy (Vercel + Neon, both free)

1. In Neon, create a project and copy the **pooled** connection string.
2. Push this repo to GitHub, then import it in Vercel. Leave the framework preset as "Other".
3. In the Vercel project settings, add two environment variables: `DATABASE_URL` (the Neon pooled string) and `API_KEY` (a long random string).
4. Deploy. The tables are created automatically on the first request.
5. Seed the slots: `BASE_URL=https://<app>.vercel.app API_KEY=... node scripts/seed.js`.
6. Open `https://<app>.vercel.app/?key=<API_KEY>`. The page saves the key in your browser, then removes it from the address bar.
