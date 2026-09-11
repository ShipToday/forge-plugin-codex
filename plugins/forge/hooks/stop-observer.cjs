#!/usr/bin/env node
'use strict';

// Codex localization: passive Stop work is saved locally, never returned as a
// blocking reason (Codex turns that reason into a synthetic user message).
// Preserve this file during plugin sync. Claude's Stop behavior is unchanged.
const sessionStateModule = require('./session-state.cjs');
const { resolveSessionRecords, captureTokenUsageFromResolved } = require('./token-usage.cjs');
const { activeMsFromResolved } = require('./active-time.cjs');
const { readHeadRef } = require('./git-head.cjs');
const { randomUUID } = require('crypto');
const { CHECKPOINT_INTERVAL } = require('./passive-observation.cjs');

const FLUSH_INTERVAL = 3;
const TIME_FLOOR_MS = 10 * 60 * 1000;
// SHI-906: eligibility floor for the FIRST offer of a session — turns OR
// active time OR a git milestone. Its placement below is load-bearing: it runs
// BEFORE anything latches the fire-once flags, so an ineligible Stop never
// spends the session's one offer without the user ever seeing it.
const TURN_FLOOR = 4;
const ACTIVE_FLOOR_MS = 5 * 60 * 1000;

// The only blocking Stop response left on Codex, worded as in the Claude Code
// plugin: it names the step to send as completed_step and says the call is
// mandatory before the turn may end. Fires at most once per stall —
// event.stop_hook_active guards a second block — so it can never loop.
function skillContinuation(state) {
  const convo = state.conversation_id || '<conversation_id>';
  const step = state.current_step_skill || state.current_skill || 'the current step';
  return JSON.stringify({
    decision: 'block',
    reason:
      `FORGE WORKFLOW — do not stop yet. A local skill ran while the Forge step "${step}" is ` +
      `still in progress, and the turn ended WITHOUT calling forge__update_state. A skill ` +
      `instruction like "reply with only your output / nothing else" governs that skill's ` +
      `OUTPUT FORMAT only — it does NOT end the workflow step. Briefly relay the skill's key ` +
      `findings, then call forge__update_state (conversation_id: ${convo}, completed_step: ` +
      `${step}, …) to complete the step. Calling forge__update_state is mandatory before this ` +
      `turn may end.`,
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (event.stop_hook_active) return;
  const session = sessionStateModule.forSession(event.session_id);
  const state = session.read();
  if (event.turn_id && state.last_stop_turn_id === event.turn_id) return;
  const now = Date.now();
  const at = new Date(now).toISOString();
  // Writes are batched: every write() is a read, a temp file and a rename, and
  // on Windows each extra rename is another chance to collide with a hook that
  // still has the file open (see session-state.cjs). The Stop turn identity
  // rides along with whichever write happens first.
  const seen = event.turn_id ? { last_stop_turn_id: event.turn_id } : {};
  if (state.active_workflow && state.pending_skill_continuation && !state.pending_checkpoint) {
    session.write({ ...seen, pending_skill_continuation: false });
    process.stdout.write(skillContinuation(state));
    return;
  }
  state.turn_count = (state.turn_count || 0) + 1;
  session.write({ ...seen, turn_count: state.turn_count });
  if (state.active_workflow || state.pending_checkpoint) return;

  if (state.status === 'linked' || state.status === 'logged' || state.forge_observation_enabled === false) {
    if (!state.last_observer_conversation_id) return;
    const since = Date.parse(state.last_checkpoint_at || state.session_start);
    if (!Number.isFinite(since)) return;
    const skills = state.skill_invocations || [];
    const reserved = state.skills_reserved_through ?? state.skills_flushed_at_turn ?? 0;
    const interval = skills.length > reserved ? FLUSH_INTERVAL : CHECKPOINT_INTERVAL;
    if (state.turn_count - (state.last_checkpoint_turn || 0) < interval && now - since < TIME_FLOOR_MS) return;
    const old = state.passive_checkpoint_due;
    // One bounded aggregate. Never overwrite another conversation's payload.
    if (old && (old.conversation_id !== state.last_observer_conversation_id ||
      old.state_updates.sdlc_stage !== (state.sdlc_stage || 'other') ||
      old.state_updates.work_item_key !== (state.work_item_key || null))) return;
    const resolved = resolveSessionRecords(event);
    const active = activeMsFromResolved(resolved, since, now);
    const delta = Math.max(0, Number.isFinite(active) ? active : now - since);
    const checkpointId = old?.id || randomUUID();
    const updates = {
      codex_checkpoint_id: checkpointId,
      outcome: 'checkpoint', event_type: 'observation_outcome',
      duration_ms: (old?.state_updates.duration_ms || 0) + delta,
      work_item_key: state.work_item_key || null, sdlc_stage: state.sdlc_stage || 'other',
      ...(event.session_id ? { client_session_id: event.session_id } : {}),
    };
    const names = [...(old?.state_updates.skill_invocations || []), ...skills.slice(reserved).map(s => s.name)];
    if (names.length) updates.skill_invocations = [...new Set(names)].slice(-64);
    // Snapshot taken at queue time is the FALLBACK for a Codex build that
    // cannot rewrite tool input; where it can, workflow-guard.cjs replaces it
    // with a capture taken when the call is actually made (cumulative, so the
    // server keeps whichever is larger).
    const tokens = captureTokenUsageFromResolved(resolved);
    if (tokens) updates.token_usage = (tokens.byModel?.length ? tokens.byModel : [tokens]).map(m => ({
      input: m.input, cache_read: m.cacheRead, cache_creation_5m: m.cacheCreation5m,
      cache_creation_1h: m.cacheCreation1h, cache_creation_flat: m.cacheCreationFlat,
      output: m.output, model_name: m.modelName,
    }));
    else if (old?.state_updates.token_usage) updates.token_usage = old.state_updates.token_usage;
    // Reserve interval and payload together; this is NOT a remote receipt.
    // Ambiguous calls aren't retried: the server adds deltas without dedup.
    session.write({
      passive_checkpoint_due: { id: checkpointId, queued_at: old?.queued_at || at,
        through: at, skills_through: skills.length, conversation_id: state.last_observer_conversation_id,
        completed_step: 'session_observer', state_updates: updates },
      last_checkpoint_at: at, last_checkpoint_turn: state.turn_count, skills_reserved_through: skills.length,
    });
    return;
  }
  if (state.status === 'dismissed' || state.observation_due) return;
  const turnsSince = state.turn_count - (state.last_observer_turn || 0);
  if (state.status === 'snoozed') {
    // SHI-907: `declined_once` is deliberately NOT cleared on the re-offer —
    // it is what lets the returning offer acknowledge the earlier "no".
    if (turnsSince < CHECKPOINT_INTERVAL) return;
    session.write({ observation_due: { id: randomUUID(), reason: 'wake', queued_at: at,
      turn_count: state.turn_count, wake_condition: state.wake_condition,
      declined_once: !!state.declined_once } });
    return;
  }
  if (state.status || state.observer_blocked || state.observer_fired) return;
  // A deferred offer (passive-observation.cjs `defer`) re-arms the fire-once
  // flags but comes back only after a cooldown, never on the very next Stop.
  if (state.last_observer_turn != null && turnsSince < CHECKPOINT_INTERVAL) return;
  const active = activeMsFromResolved(resolveSessionRecords(event), Date.parse(state.session_start), now);
  const head = readHeadRef(process.cwd());
  const milestone = !!head && !!state.git_head_baseline && head !== state.git_head_baseline;
  // Seed the baseline on first sight; advance it whenever a milestone is consumed.
  const baseline = head && (!state.git_head_baseline || milestone) ? { git_head_baseline: head } : {};
  if (state.turn_count < TURN_FLOOR && !(Number.isFinite(active) && active >= ACTIVE_FLOOR_MS) && !milestone) {
    if (head && !state.git_head_baseline) session.write(baseline);
    return;
  }
  session.write({
    observation_due: { id: randomUUID(), reason: 'initial', queued_at: at,
      turn_count: state.turn_count, active_ms: active, declined_once: !!state.declined_once },
    ...baseline,
  });
}

main().catch(() => { /* Passive capture must never interfere with the answer. */ });
