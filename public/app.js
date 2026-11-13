'use strict';

const $ = (id) => document.getElementById(id);

// The API key comes from ?key=... (handy for a shareable demo link) or what was saved before.
const params = new URLSearchParams(location.search);
if (params.get('key')) {
  localStorage.setItem('apiKey', params.get('key'));
  params.delete('key');
  history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
}
let apiKey = localStorage.getItem('apiKey') || '';
$('key-card').hidden = Boolean(apiKey);

let slotsById = new Map();
let selectedSlot = null;
let pendingIdempotencyKey = null; // reused if the same booking is retried
let mineEmail = null;
let mineCursor = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    $('key-card').hidden = false;
  }
  if (!res.ok) {
    let msg = data.error || `Request failed (${res.status})`;
    if (res.status === 429) msg += ` — wait ${res.headers.get('Retry-After') || 'a few'} seconds.`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
function slotLabel(slot) {
  const s = new Date(slot.start);
  const e = new Date(slot.end);
  return `${fmtDate.format(s)}, ${fmtTime.format(s)}–${fmtTime.format(e)} with ${slot.provider}`;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------- Slots ----------
async function loadSlots() {
  if (!apiKey) {
    $('slots-status').textContent = 'Enter the API key to see slots.';
    return;
  }
  $('slots-status').textContent = 'Loading…';
  try {
    const provider = $('provider-filter').value;
    const qs = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    const { slots } = await api(`/slots${qs}`);
    slotsById = new Map(slots.map((s) => [s.id, s]));
    if (!provider) refreshProviders(slots);

    const now = Date.now();
    const open = slots.filter((s) => s.available && new Date(s.start).getTime() > now);
    $('slots').replaceChildren(
      ...open.map((slot) =>
        el('li', {},
          el('span', { textContent: slotLabel(slot) }),
          el('button', { type: 'button', textContent: 'Book', onclick: () => chooseSlot(slot) })
        )
      )
    );
    $('slots-status').textContent = open.length ? '' : 'No open slots right now.';
  } catch (err) {
    $('slots-status').textContent = err.message;
  }
}

function refreshProviders(slots) {
  const select = $('provider-filter');
  const current = select.value;
  const providers = [...new Set(slots.map((s) => s.provider))].sort();
  select.replaceChildren(
    el('option', { value: '', textContent: 'All providers' }),
    ...providers.map((p) => el('option', { value: p, textContent: p }))
  );
  select.value = current;
}

function chooseSlot(slot) {
  selectedSlot = slot;
  pendingIdempotencyKey = crypto.randomUUID();
  $('book-slot-label').textContent = slotLabel(slot);
  $('book-error').textContent = '';
  $('confirm-card').hidden = true;
  $('book-card').hidden = false;
  $('name').focus();
}

// ---------- Booking ----------
$('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedSlot) return;
  const btn = $('book-btn');
  btn.disabled = true;
  $('book-error').textContent = '';
  try {
    const booking = await api('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': pendingIdempotencyKey },
      body: JSON.stringify({ slot_id: selectedSlot.id, name: $('name').value, email: $('email').value }),
    });
    showConfirmation(booking);
    $('book-card').hidden = true;
    $('book-form').reset();
    selectedSlot = null;
    loadSlots();
  } catch (err) {
    $('book-error').textContent = err.message;
    // A different submission (e.g. corrected details) needs a fresh key.
    pendingIdempotencyKey = crypto.randomUUID();
    if (err.status === 409) loadSlots();
  } finally {
    btn.disabled = false;
  }
});

$('book-cancel').addEventListener('click', () => {
  $('book-card').hidden = true;
  selectedSlot = null;
});

function bookingDetails(booking) {
  const slot = slotsById.get(booking.slot_id);
  const rows = [
    ['Reference', booking.id],
    ['Status', booking.status],
    ['Appointment', slot ? slotLabel(slot) : booking.slot_id],
    ['Name', booking.name],
    ['Email', booking.email],
    ['Booked at', new Date(booking.created_at).toLocaleString()],
  ];
  return el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
}

function showConfirmation(booking) {
  $('confirm-details').replaceWith(Object.assign(bookingDetails(booking), { id: 'confirm-details' }));
  $('confirm-card').hidden = false;
  $('confirm-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- Lookup ----------
function renderLookup(booking) {
  const children = [bookingDetails(booking)];
  if (booking.status === 'confirmed') {
    children.push(el('button', {
      type: 'button', className: 'secondary', textContent: 'Cancel this booking',
      onclick: async (ev) => {
        if (!confirm('Cancel this booking?')) return;
        ev.target.disabled = true;
        try {
          renderLookup(await api(`/bookings/${encodeURIComponent(booking.id)}`, { method: 'DELETE' }));
          loadSlots();
        } catch (err) {
          $('lookup-error').textContent = err.message;
          ev.target.disabled = false;
        }
      },
    }));
  }
  $('lookup-result').replaceChildren(...children);
}

$('lookup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lookup-error').textContent = '';
  $('lookup-result').replaceChildren();
  try {
    renderLookup(await api(`/bookings/${encodeURIComponent($('lookup-id').value.trim())}`));
  } catch (err) {
    $('lookup-error').textContent = err.message;
  }
});

// ---------- My bookings (cursor pagination) ----------
async function loadMine(append) {
  $('mine-error').textContent = '';
  try {
    const qs = new URLSearchParams({ email: mineEmail, limit: '5' });
    if (append && mineCursor) qs.set('cursor', mineCursor);
    const { bookings, next_cursor } = await api(`/bookings?${qs}`);
    const items = bookings.map((b) => {
      const slot = slotsById.get(b.slot_id);
      return el('li', {},
        el('span', { textContent: `${slot ? slotLabel(slot) : b.slot_id} · ref ${b.id.slice(0, 8)}…` }),
        el('span', { className: `tag ${b.status}`, textContent: b.status })
      );
    });
    if (append) $('mine').append(...items);
    else $('mine').replaceChildren(...items);
    if (!append && !bookings.length) $('mine-error').textContent = 'No bookings for that email.';
    mineCursor = next_cursor;
    $('mine-more').hidden = !next_cursor;
  } catch (err) {
    $('mine-error').textContent = err.message;
  }
}

$('mine-form').addEventListener('submit', (e) => {
  e.preventDefault();
  mineEmail = $('mine-email').value.trim();
  mineCursor = null;
  loadMine(false);
});
$('mine-more').addEventListener('click', () => loadMine(true));

// ---------- Key + boot ----------
$('key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  apiKey = $('api-key').value.trim();
  localStorage.setItem('apiKey', apiKey);
  $('key-card').hidden = true;
  loadSlots();
});
$('refresh').addEventListener('click', loadSlots);
$('provider-filter').addEventListener('change', loadSlots);

loadSlots();
