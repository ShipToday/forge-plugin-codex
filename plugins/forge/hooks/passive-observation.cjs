#!/usr/bin/env node
'use strict';

// Codex-only delivery helpers. No network, no model turn, no implicit consent.
const path = require('path');
const sessionStateModule = require('./session-state.cjs');
const CHECKPOINT_INTERVAL = 8;
const DISPOSITIONS = ['observe', 'skip', 'defer', 'sleep'];
// Queued ids are always randomUUID() from stop-observer.cjs; anything else is
// dropped, never delivered.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Arguments that reach the acknowledge command are validated first.
const SAFE_ARG_RE = /^[A-Za-z0-9._-]{1,128}$/;

function additionalContext(text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}

function oneLine(text, max = 200) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// The complete receipt command, built here from validated values so the model
// never assembles it from file contents. Only the final token is for the model.
function acknowledgeCommand(sessionId, id) {
  if (!SAFE_ARG_RE.test(String(sessionId || '')) || !UUID_RE.test(String(id || ''))) return null;
  return `node "${path.join(__dirname, 'passive-observation.cjs')}" acknowledge ${sessionId} ${id} <${DISPOSITIONS.join('|')}>`;
}

// Returns developer-context TEXT for this prompt, or ''. prompt-router.cjs
// joins it with any routing text and wraps the result once, so routing and
// passive delivery never compete for the same prompt.
function deliver(session, state, event) {
  const at = new Date().toISOString();
  if (state.active_workflow || state.pending_checkpoint) return '';
  if (event.turn_id && state.last_passive_prompt_turn === event.turn_id) return '';
  // A Forge clarification (start_workflow returned without a conversation) is
  // being answered on the very next prompt. workflow-tracker.cjs stamps the
  // turn; the window is one prompt wide by construction, so nothing has to
  // clear it. (observer_blocked cannot carry this: prompt-router re-arms it
  // before delivery runs.)
  if (state.clarification_at_turn != null && (state.turn_count || 0) - state.clarification_at_turn <= 1) return '';
  if (state.passive_checkpoint_due) {
    const pending = state.passive_checkpoint_due;
    if (!UUID_RE.test(String(pending.id || ''))) { session.write({ passive_checkpoint_due: null }); return ''; }
    // Upgrade an undelivered legacy queue safely; already-delivered id-less
    // payloads are rejected by the guard because they cannot prove identity.
    pending.state_updates = { ...pending.state_updates, codex_checkpoint_id: pending.id };
    session.write({ passive_checkpoint_due: null, delivered_checkpoint: pending,
      last_passive_prompt_turn: event.turn_id || null,
      skills_flushed_at_turn: pending.skills_through,
      checkpoint_delivery: { id: pending.id, at, attempted_at: null, processed_at: null } });
    return `FORGE PASSIVE CHECKPOINT: Read the existing forge-autopilot skill's ` +
      `Codex passive delivery instructions. Session state: ${JSON.stringify(session.stateFilePath)}. ` +
      `Process delivered_checkpoint ${pending.id} once in this active turn; preserve the user's substantive final answer.`;
  }
  if (state.status === 'dismissed' || state.status === 'linked' || state.status === 'logged' || state.forge_observation_enabled === false) {
    if (state.observation_due) session.write({ observation_due: null });
    return '';
  }
  const due = state.observation_due;
  // A snoozed session is checked against its wake condition on every prompt
  // (as in the Claude Code plugin); the eight-turn re-offer queued by stop-observer.cjs
  // takes precedence on the prompt it lands on.
  if (state.status === 'snoozed' && !due && state.wake_condition) {
    return `FORGE ROUTING: The tracking offer in this session is snoozed. Wake condition: ` +
      `"${oneLine(state.wake_condition)}". If the user's current message clearly satisfies it, invoke the ` +
      `"forge-autopilot" skill via the Skill tool with the input "observe session — start the observe_session ` +
      `workflow for passive tracking" after completing the user's request. Otherwise continue normally and ` +
      `do NOT mention this check to the user.`;
  }
  if (!due) return '';
  if (!UUID_RE.test(String(due.id || ''))) { session.write({ observation_due: null }); return ''; }
  session.write({ observation_due: null, delivered_observation: due,
    observer_fired: true, observer_blocked: true, last_observer_turn: state.turn_count,
    last_passive_prompt_turn: event.turn_id || null,
    observation_delivery: { id: due.id, at, processed_at: null, disposition: null } });
  const command = acknowledgeCommand(event.session_id || state.session_id, due.id);
  return `FORGE PASSIVE OBSERVATION: Read the existing forge-autopilot skill's ` +
    `Codex passive delivery instructions. Session state: ${JSON.stringify(session.stateFilePath)}. ` +
    `Evaluate delivered_observation ${due.id} once in this active turn; preserve the user's substantive final answer. ` +
    (command
      ? `Record your evaluation by running exactly this command, replacing only the final token: ${command}`
      : `No receipt command is available for this session; do not construct one.`);
}

// A local evaluation receipt distinguishes delivered context from context the
// model actually processed. It neither logs work remotely nor grants consent.
function acknowledge(sessionId, id, disposition) {
  if (!SAFE_ARG_RE.test(String(sessionId || '')) || !UUID_RE.test(String(id || '')) ||
      !DISPOSITIONS.includes(disposition)) return false;
  const session = sessionStateModule.forSession(sessionId);
  const state = session.read();
  if (state.observation_delivery?.id !== id || state.observation_delivery.processed_at) return false;
  const updates = { observation_delivery: { ...state.observation_delivery,
    processed_at: new Date().toISOString(), disposition } };
  // `defer` means "not now, but this session still wants the offer": re-arm the
  // fire-once latch so stop-observer.cjs can queue it again after its cooldown.
  // `skip` and `observe` keep the latch (asked and answered); `sleep` leaves a
  // snoozed session on its own wake schedule.
  if (disposition === 'defer') Object.assign(updates, { observer_fired: false, observer_blocked: false });
  session.write(updates);
  return true;
}

if (require.main === module) {
  if (process.argv[2] !== 'acknowledge' || !acknowledge(...process.argv.slice(3))) process.exitCode = 1;
}
module.exports = { CHECKPOINT_INTERVAL, additionalContext, deliver, acknowledge, acknowledgeCommand };
