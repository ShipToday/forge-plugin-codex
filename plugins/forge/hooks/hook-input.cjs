'use strict';

// Identity of a queued passive checkpoint. Shared so the producer, the delivery
// path and the claim all agree on what a usable id looks like.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Normalize once before inspection or enrichment. Invalid input stays invalid;
// it must never be spread into character-indexed state or treated as completion.
function record(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// A call whose state_updates is absent, null or some other non-object is still
// a valid call: the server coerces that to {} and completes the step, so the
// hooks must see it the same way or they skip the completion bookkeeping. Only
// a malformed TOP-LEVEL input (or an unparseable state_updates string, which
// was meant to carry fields) yields null.
function stateCall(input) {
  const call = record(input);
  if (!call) return null;
  if (typeof call.state_updates === 'string') {
    const parsed = record(call.state_updates);
    return parsed ? { ...call, state_updates: parsed } : null;
  }
  return { ...call, state_updates: record(call.state_updates) || {} };
}

module.exports = { record, stateCall, UUID_RE };
