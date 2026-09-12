'use strict';

const fs = require('fs');
const { isDeepStrictEqual } = require('util');
const { UUID_RE } = require('./hook-input.cjs');

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

// Exclusive creation is the cross-process claim, and it is the ONLY record of
// one: two PreToolUse processes can both read an unattempted receipt, but only
// one can create the file. A mismatch never creates it, so the exact delivered
// payload stays submittable — say so, because the skill otherwise tells the
// model never to retry a denied attempt and the interval would be lost.
function claim(session, call, state = session.read()) {
  if (!matches(state, call)) {
    return 'This does not match the checkpoint currently delivered in this session. ' +
      'Submit the delivered_checkpoint payload exactly as it appears in the session state — ' +
      'conversation_id, completed_step and state_updates unchanged — or submit nothing. ' +
      'Do not reconstruct, edit or replay a payload.';
  }
  if (state.checkpoint_delivery.processed_at) {
    return 'This passive checkpoint was already recorded. Do not submit it again.';
  }
  const id = call.state_updates.codex_checkpoint_id;
  try {
    fs.writeFileSync(attemptPath(session, id), new Date().toISOString(),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return null;
  } catch (error) {
    return error.code === 'EEXIST'
      ? 'This passive checkpoint was already attempted. Do not retry an ambiguous submission.'
      : 'Could not persist the passive checkpoint claim. Submission is blocked to prevent duplicate recording.';
  }
}

// The claim file is the proof: a processing receipt is only written for a
// submission that actually passed through the guard.
function attempted(session, state, call) {
  return matches(state, call) &&
    fs.existsSync(attemptPath(session, call.state_updates.codex_checkpoint_id));
}

module.exports = { claim, attempted };
