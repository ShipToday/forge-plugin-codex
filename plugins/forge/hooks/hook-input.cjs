'use strict';

// Normalize once before inspection or enrichment. Invalid input stays invalid;
// it must never be spread into character-indexed state or treated as completion.
function record(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stateCall(input) {
  const call = record(input);
  if (!call) return null;
  const updates = call.state_updates === undefined ? {} : record(call.state_updates);
  return updates ? { ...call, state_updates: updates } : null;
}

module.exports = { record, stateCall };
