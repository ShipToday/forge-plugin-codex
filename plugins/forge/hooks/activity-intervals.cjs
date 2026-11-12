'use strict';

const { createHash } = require('node:crypto');
const { activeMsFromEvent } = require('./active-time.cjs');

// Local measurements only. They leave the machine after a tracking decision;
// a server receipt, rather than advancing the clock, retires them.
const MAX_INTERVALS = 64;
function captureBeforeWorkflow(state, event, now = Date.now()) {
  if (state.active_workflow || (state.parked_runs || []).length) return {};
  const requested = Date.parse(state.workflow_request_at);
  if (Number.isFinite(requested)) now = Math.min(now, requested);
  const start = Date.parse(state.last_checkpoint_at || state.session_start);
  if (!Number.isFinite(start) || start >= now) return {};
  const duration = activeMsFromEvent(event, start, now);
  if (!Number.isFinite(duration) || duration <= 0) return {};
  const pending = Array.isArray(state.unrecorded_activity) ? state.unrecorded_activity : [];
  // Never discard an unacknowledged measurement to make room for another.
  if (pending.length >= MAX_INTERVALS) return {};
  const interval = { id: createHash('sha256').update(`${event.session_id}:${start}:${now}`).digest('hex'),
    start: new Date(start).toISOString(), end: new Date(now).toISOString(),
    duration_ms: Math.min(Math.round(duration), now - start), source: 'transcript_idle_capped' };
  return { unrecorded_activity: [...pending, interval], last_checkpoint_at: interval.end };
}

function activityForUpdate(state, updates) {
  if (updates?.status === 'needs_input' || updates?.event_type !== 'observation_outcome'
    || !['created', 'linked', 'ad_hoc', 'checkpoint'].includes(updates.outcome)) return null;
  const intervals = state.unrecorded_activity;
  return Array.isArray(intervals) && intervals.length ? intervals.slice(0, MAX_INTERVALS) : null;
}

function receiptFrom(response, depth = 0) {
  if (!response || depth > 6) return [];
  if (typeof response === 'string') {
    if (response.length > 256000) return [];
    try { return receiptFrom(JSON.parse(response), depth + 1); } catch { return []; }
  }
  const receipt = response.structuredContent?.activity_receipt;
  if (Array.isArray(receipt)) return receipt.filter(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(0, MAX_INTERVALS);
  if (Array.isArray(response)) return response.flatMap(item => receiptFrom(item, depth + 1));
  if (typeof response === 'object') return ['content', 'text', 'output'].flatMap(key => receiptFrom(response[key], depth + 1));
  return [];
}

function acknowledgeActivity(state, response, input) {
  let updates = input?.state_updates;
  if (typeof updates === 'string') { try { updates = JSON.parse(updates); } catch { updates = null; } }
  if (updates?.event_type === 'observation_outcome'
    && ['declined_for_now', 'dismissed', 'snoozed', 'no_observation'].includes(updates.outcome)) {
    return { unrecorded_activity: [] };
  }
  const ids = new Set(receiptFrom(response));
  if (!ids.size) return {};
  const pending = Array.isArray(state.unrecorded_activity) ? state.unrecorded_activity : [];
  return { unrecorded_activity: pending.filter(interval => !ids.has(interval.id)) };
}

module.exports = { captureBeforeWorkflow, activityForUpdate, acknowledgeActivity };
