#!/usr/bin/env node

/**
 * stop-observer.js — Stop hook for passive session observation.
 *
 * Fires after Claude finishes responding. If the session is untracked,
 * blocks Claude's exit and provides a continuation turn where Claude can
 * evaluate the session and invoke session_observer for passive tracking.
 *
 * This replaces the old two-step handoff (AssistantResponse sets flag →
 * UserPromptSubmit emits nudge). The Stop hook lets Claude answer the
 * user's question FIRST, then evaluate for tracking — no interruption.
 *
 * Execution:
 *   1. Exit if stop_hook_active (prevent infinite loop)
 *   2. Increment turn_count (tracks conversation progress)
 *   3. For linked/logged: checkpoint when EITHER CHECKPOINT_INTERVAL turns
 *      have passed OR TIME_FLOOR_MS of wall-clock has elapsed since the last
 *      checkpoint — whichever comes first (FLUSH_INTERVAL turns when skill
 *      invocations are pending). The time floor is the load-bearing part:
 *      turns are a poor proxy for engineering time, so a pure turn count can
 *      leave large un-banked gaps on long-turn sessions. The silent audit
 *      event captures elapsed engineering time as a DELTA since the last
 *      checkpoint; the dashboard SUMs deltas, so firing more often only
 *      changes granularity, not the aggregate total. Runs regardless of
 *      forge_observation_enabled because the gate is about the observation
 *      NUDGE, not about engineering-time tracking for already-tracked
 *      sessions.
 *   3b. Exit silently if the per-session cache says the org
 *      admin has disabled observation (forge_observation_enabled =
 *      false). Steady-state zero-roundtrip — no MCP call until the
 *      next Claude Code session starts (which begins with a fresh
 *      cache). Field is written into the cache by the session_observer
 *      gated path when it first detects the admin opt-out.
 *   4. For snoozed: re-fire observer every CHECKPOINT_INTERVAL turns
 *      (re-prompts user to track)
 *   5. Exit if dismissed (terminal — never re-fires)
 *   5b. Exit if status is set (observer already ran — defensive guard)
 *   6. Exit if active_workflow (workflow tracks its own time)
 *   7. Exit if observer_blocked (already evaluated this session)
 *   8. Set observer_blocked = true in session state
 *   9. Block with reason directing Claude to evaluate and invoke session_observer
 *
 * Design principles:
 *   - Fires after Claude responds — user gets their answer first.
 *   - Blocks only once per session for initial observation (observer_blocked flag).
 *   - Re-fires periodically for linked/logged sessions to capture
 *     engineering time that would otherwise go untracked.
 *   - Re-fires periodically for snoozed sessions to re-prompt the user.
 *   - active_workflow is set by forge-autopilot after a workflow actually
 *     starts — not by prompt-router at detection time. This means if
 *     Claude ignores a routing directive, active_workflow stays false
 *     and this hook will still fire for passive observation.
 *   - Checkpoint baseline (last_checkpoint_at) advances when the directive is
 *     EMITTED, not when the AI confirms the forge__update_state write. This is
 *     deliberate: the delta is baked into the directive at emit time, so the
 *     baseline must advance by exactly that delta to keep consecutive deltas
 *     non-overlapping. If it only advanced on a confirmed write, a re-emit
 *     (the time floor tripping again before a slow/ignored write lands) would
 *     re-measure the same interval and, if both writes land, DOUBLE-COUNT —
 *     inflating customer-facing engineering-time/ROI totals. Over-counting is
 *     worse than under-counting, and the loss from one ignored checkpoint is
 *     now bounded by TIME_FLOOR_MS (it was effectively unbounded before the
 *     time floor — a single 92.8-min delta was observed in the wild).
 *   - No end-of-session flush. The SessionEnd hook event is observability-only:
 *     it cannot block or drive a model tool call (verified against the Claude
 *     Code hook docs), and Codex/Cursor expose no model-driving session-end
 *     event either — so a final checkpoint cannot be forced at exit. The
 *     residual un-banked tail on a clean exit is therefore bounded by
 *     TIME_FLOOR_MS (plus the final turn's duration); the time floor IS the
 *     portable end-of-session safety net.
 *   - The reason text tells Claude to invoke forge-autopilot for tracking.
 *
 * @see plugin/hooks/prompt-router.cjs for active PDLC/epic detection
 * @see plugin/hooks/session-state.cjs for state management
 * @see plugin/skills/forge-autopilot/SKILL.md for routing logic
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');
const { resolveSessionRecords, captureTokenUsageFromResolved } = require('./token-usage.cjs');
const { activeMsFromResolved } = require('./active-time.cjs');

// -- Constants ----------------------------------------------------------------

const CHECKPOINT_INTERVAL = 8; // turns between checkpoint audit events
const FLUSH_INTERVAL = 3;      // turns between checkpoints when skill invocations are pending

// Wall-clock cap between checkpoints, independent of turn cadence. Turns are a
// poor proxy for engineering time: long research/implementation turns can run
// ~10 min each, so a pure turn count of CHECKPOINT_INTERVAL could leave a
// ~90-min gap (an unbroken 92.8-min delta was observed in the wild). A
// checkpoint fires when EITHER the turn interval OR this time floor is reached,
// so a handful of very long turns can't leave a large un-banked gap. Tunable:
// smaller = better crash resilience / tighter granularity, larger = fewer
// silent forced-continuation turns (lower token overhead).
const TIME_FLOOR_MS = 10 * 60 * 1000; // 10 minutes

// -- Directives ---------------------------------------------------------------

/**
 * Build a silent checkpoint directive. Tells Claude to call forge__update_state
 * with the engineering-time delta — no user interaction, no visible output.
 * `durationMs` is the ACTIVE time since the last checkpoint (idle excluded, see
 * active-time.cjs) when a session log is available, else wall-clock elapsed.
 *
 * The directive embeds `last_observer_conversation_id` — the conversation
 * the observe_session run completed on. Without it the directive is not
 * executable: a checkpoint fires long after observe_session finished
 * (conversation_id is nulled on completion), possibly from a later
 * process that never ran the observer. Returns '' when that id is absent
 * (state file predates the field) so no un-executable directive is sent.
 */
function buildCheckpointResponse(durationMs, state, stateFilePath, event, resolved) {
  const conversationId = state.last_observer_conversation_id;
  if (!conversationId) return '';

  // Collect skill invocations that haven't been flushed yet
  const flushedAt = state.skills_flushed_at_turn || 0;
  const allInvocations = state.skill_invocations || [];
  const unreported = allInvocations.filter((_, i) => i >= flushedAt);
  const skillPayload = unreported.length > 0
    ? `, skill_invocations: ${JSON.stringify(unreported.map(inv => inv.name))}`
    : '';

  // Piggyback per-session token capture on the SAME checkpoint
  // directive — no new hook, no extra round-trip. The caller resolved the
  // session log ONCE (main + sub-agent files; review #10) and the same parsed
  // records fed the active-time delta above — here they yield the CUMULATIVE
  // raw token components, which the orchestrator writes to a separate
  // `event_type: token_usage` row. The snapshot is cumulative, so the read
  // side's latest-per-session dedup makes a re-emitted or skipped checkpoint
  // safe. Capture failures return '' worth of payload — token capture must
  // never perturb the engineering-time checkpoint (NFR: error handling).
  let tokenPayload = '';
  // The Claude coding-session id, carried on the SAME directive so the read side
  // collapses this session's snapshots across all its conversations (on the
  // server). Set UNCONDITIONALLY — the checkpoint also writes a non-token
  // observation_outcome row (the engineering-time bank) that must carry
  // client_session_id so the Overview "Total Sessions" count keys on the coding
  // session. The token branch below adds it to the token_usage row too; this
  // line ensures it lands even when capture returns nothing. The workflow-guard
  // hook can't add it here — the directive already carries this payload, so the
  // guard's non-clobber check skips this checkpoint.
  let clientSessionPayload = event.session_id
    ? `, client_session_id: "${event.session_id}"`
    : '';
  try {
    const tokens = captureTokenUsageFromResolved(resolved);
    if (tokens) {
      // Emit one component bag PER model (tokens.byModel) so
      // the orchestrator writes a per-model token_usage row — a delegated
      // session (Opus main + Sonnet sub-agent) is then weighted per model at
      // read. Fall back to the combined single bag if an adapter lacks byModel.
      const models = Array.isArray(tokens.byModel) && tokens.byModel.length
        ? tokens.byModel
        : [tokens];
      const tu = models.map((m) => ({
        input: m.input,
        cache_read: m.cacheRead,
        cache_creation_5m: m.cacheCreation5m,
        cache_creation_1h: m.cacheCreation1h,
        cache_creation_flat: m.cacheCreationFlat,
        output: m.output,
        model_name: m.modelName,
      }));
      tokenPayload = `, token_usage: ${JSON.stringify(tu)}`;
    }
  } catch {
    tokenPayload = '';
  }

  return JSON.stringify({
    decision: 'block',
    reason:
      `FORGE CHECKPOINT: This is an automatic, silent checkpoint to record engineering time. ` +
      `Do NOT mention this to the user. Do NOT ask any questions. ` +
      `Session state file: ${stateFilePath} ` +
      `Immediately invoke the "forge-autopilot" skill via the Skill tool with the input: ` +
      `"session checkpoint — call forge__update_state with ` +
      `conversation_id: ${conversationId}, completed_step: session_observer, ` +
      `state_updates: { outcome: checkpoint, duration_ms: ${durationMs}, ` +
      `event_type: observation_outcome, ` +
      `work_item_key: ${state.work_item_key || 'null'}, sdlc_stage: ${state.sdlc_stage || 'other'}${skillPayload}${tokenPayload}${clientSessionPayload} }". ` +
      `After calling the tool, continue normally without any additional output about this checkpoint.`,
  });
}

// Concise directive. The hook only needs the model to make the
// invoke/skip decision and call observe_session — the full SDLC taxonomy and
// false-negative classification live server-side in the session_observer
// skill. Keeping this short matters
// because some clients (Codex, Cursor) surface the Stop-hook block reason to
// the user verbatim, where the old ~30-line block read as noise.
function buildBlockResponse(stateFilePath) {
  return JSON.stringify({
    decision: 'block',
    reason:
      `FORGE OBSERVATION: Before stopping, decide whether this session involved any product ` +
      `or engineering work across the software development lifecycle (SDLC) — defining, planning, ` +
      `building, testing, reviewing, or discussing code or features (reading or analyzing code to ` +
      `understand it counts). If it did, you MUST invoke the "forge-autopilot" skill via the Skill ` +
      `tool with the input: "observe session — start the observe_session workflow for passive tracking". ` +
      `Skip ONLY if the session was purely general-knowledge Q&A, tool help, or casual chat with no ` +
      `project context; when in doubt, invoke. Do NOT mention this check to the user. ` +
      `Session state file: ${stateFilePath}`,
  });
}

/**
 * Continuation directive for the required-skill stall.
 *
 * Fired when a Forge workflow step is mid-flight, the model invoked a local
 * skill (e.g. a required security-review whose prompt says "reply with only
 * its output"), and then ended its turn WITHOUT calling forge__update_state.
 * Blocks the stop and tells the model that a skill's "nothing else"
 * instruction governs the skill's OUTPUT FORMAT — not the turn boundary — and
 * that forge__update_state is mandatory before the turn may end. Fires at most
 * once per stall (event.stop_hook_active guards a second block), so it can
 * never loop. Concise on purpose — some clients surface the block reason to
 * the user verbatim.
 */
function buildSkillContinuationResponse(state) {
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

// -- Main --------------------------------------------------------------------

async function main() {
  // Parse Stop hook event from stdin
  let event = {};
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  try {
    event = JSON.parse(input);
  } catch {
    // Malformed input — exit silently
    return;
  }

  // Step 1: Prevent infinite loop — already in a forced-continuation state
  if (event.stop_hook_active) return;

  // Read session state — scoped to this Claude Code session.
  const sessionState = sessionStateModule.forSession(event.session_id);
  const state = sessionState.read();

  // Step 1b: required-skill continuation backstop.
  // A workflow is active and the model invoked a local skill mid-step (e.g. a
  // required security-review), then ended its turn WITHOUT calling
  // forge__update_state — and we are NOT at a relayed-question / confirmation
  // checkpoint (those are legitimate pauses for user input). The step stalled.
  // Block ONCE and direct the model to relay the findings and call
  // forge__update_state. event.stop_hook_active (checked above) guarantees a
  // second consecutive stop is NOT re-blocked, so this can never loop: one
  // nudge, then if the model still stops the workflow simply pauses and the
  // user can resume by saying "continue". Disarm the flag so the single nudge
  // is not repeated for the same stall.
  if (state.active_workflow && state.pending_skill_continuation && !state.pending_checkpoint) {
    sessionState.write({ pending_skill_continuation: false });
    process.stdout.write(buildSkillContinuationResponse(state));
    return;
  }

  // Step 2: Increment turn count (but not for forced continuations)
  sessionState.increment('turn_count');
  state.turn_count = (state.turn_count || 0) + 1; // keep local copy in sync

  // Step 3: Linked/logged sessions — silent checkpoint every CHECKPOINT_INTERVAL
  // turns (or FLUSH_INTERVAL if there are pending skill invocations to report),
  // OR every TIME_FLOOR_MS of wall-clock — whichever comes first.
  if (state.status === 'linked' || state.status === 'logged') {
    if (state.active_workflow) return; // Forge skills track their own time
    const turnsSinceLast = state.turn_count - (state.last_observer_turn || 0);
    // Use shorter interval when local skill invocations are pending
    const hasPendingSkills = (state.skill_invocations || []).length > (state.skills_flushed_at_turn || 0);
    const interval = hasPendingSkills ? FLUSH_INTERVAL : CHECKPOINT_INTERVAL;
    // Elapsed duration since last checkpoint (or link/log moment). Computed
    // BEFORE the early-return so it can gate the return alongside the turn
    // count: fire on turn cadence OR when the wall-clock floor is exceeded.
    const lastCheckpoint = state.last_checkpoint_at || state.session_start;
    const lastCheckpointMs = new Date(lastCheckpoint).getTime();
    const elapsedMs = Date.now() - lastCheckpointMs;
    if (turnsSinceLast < interval && elapsedMs < TIME_FLOOR_MS) return;
    // R1: bank ACTIVE engineering time (idle excluded) as the checkpoint delta,
    // not wall-clock. The firing gate ABOVE deliberately still uses wall-clock
    // `elapsedMs` — we want periodic checkpoints on a wall-clock cadence — but
    // the recorded duration is the active time since the last checkpoint, so a
    // long idle gap between turns (e.g. 3h away, then one quick prompt) is not
    // banked as engineering time. Falls back to `elapsedMs` when no session log
    // is available (Cursor / unreadable transcript) or when the log was
    // tail-truncated past the window start (review #8). A pure-idle window
    // legitimately yields ~0, which sums harmlessly.
    //
    // The session log is resolved ONCE here and shared with the token capture
    // inside buildCheckpointResponse (review #10 — no double read/parse).
    const resolved = resolveSessionRecords(event);
    const activeMs = activeMsFromResolved(resolved, lastCheckpointMs);
    const durationMs = Number.isFinite(activeMs) ? activeMs : elapsedMs;
    // Build the directive first. It returns '' when last_observer_conversation_id
    // is absent (a state file predating that field). In that case emit nothing
    // AND leave the baseline untouched, so the accumulated time is captured the
    // moment a conversation id becomes available rather than being dropped here.
    const directive = buildCheckpointResponse(durationMs, state, sessionState.stateFilePath, event, resolved);
    if (!directive) return;
    // Update state for next checkpoint and mark skills as flushed. The baseline
    // (last_checkpoint_at) advances at emit time by design — see the
    // "Checkpoint baseline" design principle in the file header.
    const updates = {
      last_observer_turn: state.turn_count,
      last_checkpoint_at: new Date().toISOString(),
    };
    if (hasPendingSkills) {
      updates.skills_flushed_at_turn = (state.skill_invocations || []).length;
    }
    sessionState.write(updates);
    // Block with silent checkpoint directive
    process.stdout.write(directive);
    return;
  }

  // Step 3b: per-session observation gate cache.
  //
  // When the MCP-side session_observer skill runs and detects that the
  // org admin has disabled observation (Clerk publicMetadata.
  // forgeObservationEnabled = false, surfaced by the orchestrator's
  // org-settings hydrator), its gated payload tells the parent to
  // write forge_observation_enabled: false into this session's state
  // file. On every subsequent Stop in the same Claude Code session,
  // this check short-circuits silently so the hook does NOT re-invoke
  // session_observer — saving one MCP round-trip per turn for the
  // steady state. Strict `=== false` so cache misses (null /
  // undefined / true / non-boolean) fall through to the normal
  // directive — the hook never pre-suppresses: it fires once and lets the
  // server-side gate make the authoritative opt-in decision (the org default
  // is now `false`, resolved on the server).
  //
  // Placed AFTER the linked/logged checkpoint branch so that
  // engineering-time tracking on already-tracked sessions continues
  // independently of the observation toggle — the toggle gates the
  // initial nudge, not silent checkpoints on linked/logged work.
  // Field name shared verbatim with the Cursor parity.
  //
  // This cache is intentionally per-session (not cross-session): each new
  // Claude Code / Codex / Cursor session starts with a fresh state file, so
  // an admin toggling observation on/off in the dashboard is picked up on
  // the very next session start. The directive fires once on the first Stop
  // of each session; the gate then writes this flag (via workflow-tracker.cjs)
  // so the rest of THAT session stays silent.
  if (state.forge_observation_enabled === false) return;

  // Step 4: Snoozed sessions — re-fire observer every CHECKPOINT_INTERVAL turns
  if (state.status === 'snoozed') {
    const turnsSinceLast = state.turn_count - (state.last_observer_turn || 0);
    if (turnsSinceLast < CHECKPOINT_INTERVAL) return;
    // Reset state so observer can re-prompt the user. Also reset
    // observer_fired so the per-session "fire once" counter restarts —
    // the user explicitly asked to be re-prompted by snoozing.
    sessionState.write({
      observer_blocked: false,
      observer_fired: false,
      status: null,
      last_observer_turn: state.turn_count,
    });
    // Block with the standard observer directive
    process.stdout.write(buildBlockResponse(sessionState.stateFilePath));
    return;
  }

  // Step 5: Dismissed sessions — terminal, never re-fire
  if (state.status === 'dismissed') return;

  // Step 5b: Defensive guard — if session has ANY known status, the observer
  // already ran. Don't re-fire the initial observation. This catches edge cases
  // where status was set (by workflow-tracker) but observer_blocked was reset.
  if (state.status) return;

  // Step 6: Workflow actually started (set by forge-autopilot, not prompt-router)
  if (state.active_workflow) return;

  // Step 7: Already blocked once this session — don't re-block
  if (state.observer_blocked) return;

  // Step 8: Mark as blocked so we don't fire again on the same turn, AND
  // mark observer_fired so prompt-router.cjs preserves the "fire once" UX
  // on subsequent turns (the workflow-completion clear path keys off
  // !observer_fired so it only re-arms in the genuine "workflow ran but
  // observer never fired" case, not the "observer fired, user ignored it" case).
  sessionState.write({ observer_blocked: true, observer_fired: true });

  // Step 9: Block Claude's exit and direct it to evaluate the session
  process.stdout.write(buildBlockResponse(sessionState.stateFilePath));
}

main().catch(() => {
  // Fail silently — never block the response
});
