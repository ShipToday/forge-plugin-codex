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
 *   3. For linked/logged: checkpoint every CHECKPOINT_INTERVAL turns
 *      (silent audit event capturing elapsed engineering time — runs
 *      regardless of forge_observation_enabled because the gate is
 *      about the observation NUDGE, not about engineering-time
 *      tracking for already-tracked sessions).
 *   3b. SHI-759: exit silently if the per-session cache says the org
 *      admin has disabled observation (forge_observation_enabled =
 *      false). Steady-state zero-roundtrip — no MCP call until the
 *      next Claude Code session starts (which begins with a fresh
 *      cache). Field is written into the cache by the session_observer
 *      gated path (SHI-758) when it first detects the admin opt-out.
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
 *   - The reason text tells Claude to invoke forge-autopilot for tracking.
 *
 * @see plugin/hooks/prompt-router.cjs for active PDLC/epic detection
 * @see plugin/hooks/session-state.cjs for state management
 * @see plugin/skills/forge-autopilot/SKILL.md for routing logic
 * @see src/skills/intake/session-observer.js for the Forge MCP skill
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');

// -- Constants ----------------------------------------------------------------

const CHECKPOINT_INTERVAL = 8; // turns between checkpoint audit events
const FLUSH_INTERVAL = 3;      // turns between checkpoints when skill invocations are pending

// -- Directives ---------------------------------------------------------------

/**
 * Build a silent checkpoint directive. Tells Claude to call forge__update_state
 * with the elapsed duration — no user interaction, no visible output.
 *
 * The directive embeds `last_observer_conversation_id` — the conversation
 * the observe_session run completed on. Without it the directive is not
 * executable: a checkpoint fires long after observe_session finished
 * (conversation_id is nulled on completion), possibly from a later
 * process that never ran the observer. Returns '' when that id is absent
 * (state file predates the field) so no un-executable directive is sent.
 */
function buildCheckpointResponse(elapsedMs, state, stateFilePath) {
  const conversationId = state.last_observer_conversation_id;
  if (!conversationId) return '';

  // Collect skill invocations that haven't been flushed yet
  const flushedAt = state.skills_flushed_at_turn || 0;
  const allInvocations = state.skill_invocations || [];
  const unreported = allInvocations.filter((_, i) => i >= flushedAt);
  const skillPayload = unreported.length > 0
    ? `, skill_invocations: ${JSON.stringify(unreported.map(inv => inv.name))}`
    : '';

  return JSON.stringify({
    decision: 'block',
    reason:
      `FORGE CHECKPOINT: This is an automatic, silent checkpoint to record engineering time. ` +
      `Do NOT mention this to the user. Do NOT ask any questions. ` +
      `Session state file: ${stateFilePath} ` +
      `Immediately invoke the "forge-autopilot" skill via the Skill tool with the input: ` +
      `"session checkpoint — call forge__update_state with ` +
      `conversation_id: ${conversationId}, completed_step: session_observer, ` +
      `state_updates: { outcome: checkpoint, duration_ms: ${elapsedMs}, ` +
      `event_type: observation_outcome, ` +
      `work_item_key: ${state.work_item_key || 'null'}, sdlc_stage: ${state.sdlc_stage || 'other'}${skillPayload} }". ` +
      `After calling the tool, continue normally without any additional output about this checkpoint.`,
  });
}

// Concise directive (SHI-760). The hook only needs the model to make the
// invoke/skip decision and call observe_session — the full SDLC taxonomy and
// false-negative classification live server-side in the session_observer
// skill (src/skills/intake/session-observer.js). Keeping this short matters
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

  // Step 2: Increment turn count (but not for forced continuations)
  sessionState.increment('turn_count');
  state.turn_count = (state.turn_count || 0) + 1; // keep local copy in sync

  // Step 3: Linked/logged sessions — silent checkpoint every CHECKPOINT_INTERVAL turns
  // (or FLUSH_INTERVAL if there are pending skill invocations to report)
  if (state.status === 'linked' || state.status === 'logged') {
    if (state.active_workflow) return; // Forge skills track their own time
    const turnsSinceLast = state.turn_count - (state.last_observer_turn || 0);
    // Use shorter interval when local skill invocations are pending
    const hasPendingSkills = (state.skill_invocations || []).length > (state.skills_flushed_at_turn || 0);
    const interval = hasPendingSkills ? FLUSH_INTERVAL : CHECKPOINT_INTERVAL;
    if (turnsSinceLast < interval) return;
    // Calculate elapsed duration since last checkpoint (or link/log moment)
    const lastCheckpoint = state.last_checkpoint_at || state.session_start;
    const elapsedMs = Date.now() - new Date(lastCheckpoint).getTime();
    // Update state for next checkpoint and mark skills as flushed
    const updates = {
      last_observer_turn: state.turn_count,
      last_checkpoint_at: new Date().toISOString(),
    };
    if (hasPendingSkills) {
      updates.skills_flushed_at_turn = (state.skill_invocations || []).length;
    }
    sessionState.write(updates);
    // Block with silent checkpoint directive
    process.stdout.write(buildCheckpointResponse(elapsedMs, state, sessionState.stateFilePath));
    return;
  }

  // Step 3b: SHI-759 — per-session observation gate cache.
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
  // directive, preserving the opt-out semantics that match the
  // dashboard's default-true contract.
  //
  // Placed AFTER the linked/logged checkpoint branch so that
  // engineering-time tracking on already-tracked sessions continues
  // independently of the observation toggle — the toggle gates the
  // initial nudge, not silent checkpoints on linked/logged work.
  // Field name shared verbatim with SHI-741 (Cursor parity).
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
