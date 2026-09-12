'use strict';

const fs = require('fs');
const { isDeepStrictEqual } = require('util');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function matches(state, call) {
  const sent = state.delivered_checkpoint;
  const id = call.state_updates.codex_checkpoint_id;
  if (!UUID_RE.test(String(id || '')) || id !== sent?.id ||
      id !== state.checkpoint_delivery?.id ||
      call.conversation_id !== sent.conversation_id ||
      call.completed_step !== sent.completed_step) return false;
  // The guard may refresh cumulative tokens; all other frozen fields must match.
  const { token_usage: incomingTokens, ...incoming } = call.state_updates;
  const { token_usage: queuedTokens, ...queued } = sent.state_updates;
  return isDeepStrictEqual(incoming, queued);
}

function attemptPath(session, id) {
  return `${session.stateFilePath}.${id}.attempt`;
}

// Exclusive creation is the cross-process claim. Atomic state replacement alone
// is not a lock: two PreToolUse processes could both read an unattempted receipt.
function claim(session, call) {
  const state = session.read();
  if (!matches(state, call)) return 'Unknown, stale, or modified passive checkpoint. Use only the current delivered payload; do not reconstruct or replay it.';
  if (state.checkpoint_delivery.attempted_at || state.checkpoint_delivery.processed_at) {
    return 'This passive checkpoint was already attempted or recorded. Do not retry it, even if the previous result is unknown.';
  }
  const id = call.state_updates.codex_checkpoint_id;
  const at = new Date().toISOString();
  try {
    fs.writeFileSync(attemptPath(session, id), at, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const current = session.read();
    if (!matches(current, call)) return 'The delivered checkpoint changed before submission. Do not retry this stale payload.';
    session.write({ checkpoint_delivery: { ...current.checkpoint_delivery, attempted_at: at } });
    return null;
  } catch (error) {
    return error.code === 'EEXIST'
      ? 'This passive checkpoint was already attempted. Do not retry an ambiguous submission.'
      : 'Could not persist the passive checkpoint claim. Submission is blocked to prevent duplicate recording.';
  }
}

function attempted(session, state, call) {
  return matches(state, call) && !!state.checkpoint_delivery.attempted_at &&
    fs.existsSync(attemptPath(session, call.state_updates.codex_checkpoint_id));
}

module.exports = { claim, attempted };
