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

// A state_updates that is not a usable object is still a valid call. The server
// coerces absent, null, a bare scalar, an array OR a string that will not parse
// into an object, and completes the step on `{ ...that }` — which is {} in every
// one of those cases. The hooks must read it the same way; treating any of them
// as malformed skips the bookkeeping for a step the server finished and strands
// the session on a stale active_workflow that keeps denying writes. An
// unparseable string is no exception: it was meant to carry fields, but the
// server does not reject it either. Only a malformed TOP-LEVEL input yields null.
function stateCall(input) {
  const call = record(input);
  if (!call) return null;
  return { ...call, state_updates: record(call.state_updates) || {} };
}

module.exports = { record, stateCall, UUID_RE };
