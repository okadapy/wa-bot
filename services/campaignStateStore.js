// services/campaignStateStore.js
const state = new Map(); // customerId -> snapshot

function setOnStart({ customerId, campaignId, timezone, message, total }) {
  const snap = {
    campaignId,
    status: "running",
    timezone,
    message,
    total: Number(total) || 0,
    sent: 0,
    failed: 0,
    remaining: Math.max(0, Number(total) || 0),
    updatedAt: new Date().toISOString(),
  };
  state.set(customerId, snap);
}

function bumpProgress({ customerId, ok }) {
  const snap = state.get(customerId);
  if (!snap) return;
  if (ok) snap.sent += 1; else snap.failed += 1;
  snap.remaining = Math.max(0, (snap.total || 0) - (snap.sent || 0));
  snap.updatedAt = new Date().toISOString();
  state.set(customerId, snap);
}

function setStatus({ customerId, status }) {
  const snap = state.get(customerId);
  if (!snap) return;
  snap.status = status;
  snap.updatedAt = new Date().toISOString();
  state.set(customerId, snap);
}

function getStateForCustomer(customerId) {
  return state.get(customerId) || null;
}

module.exports = { setOnStart, bumpProgress, setStatus, getStateForCustomer };