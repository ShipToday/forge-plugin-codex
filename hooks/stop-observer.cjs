#!/usr/bin/env node

/**
 * stop-observer.js — Stop hook for passive session observation.
 *
 * Fires after Codex finishes responding. If the session is untracked,
 * blocks Codex's exit and provides a continuation turn where Codex can
 * evaluate the session and invoke session_observer for passive tracking.
 *
 * This replaces the old two-step handoff (AssistantResponse sets flag →
 * UserPromptSubmit emits nudge). The Stop hook lets Codex answer the
 * user's question FIRST, then evaluate for tracking — no interruption.
 *
 * Execution:
 *   1. Exit if stop_hook_active (prevent infinite loop)
 *   2. Increment turn_count (tracks conversation progress)
 *   3. For linked/logged: checkpoint every CHECKPOINT_INTERVAL turns
 *      (silent audit event capturing elapsed engineering time)
 *   4. For snoozed: re-fire observer every CHECKPOINT_INTERVAL turns
 *      (re-prompts user to track)
 *   5. Exit if dismissed (terminal — never re-fires)
 *   5b. Exit if status is set (observer already ran — defensive guard)
 *   6. Exit if active_workflow (workflow tracks its own time)
 *   7. Exit if observer_blocked (already evaluated this session)
 *   8. Set observer_blocked = true in session state
 *   9. Block with reason directing Codex to evaluate and invoke session_observer
 *
 * Design principles:
 *   - Fires after Codex responds — user gets their answer first.
 *   - Blocks only once per session for initial observation (observer_blocked flag).
 *   - Re-fires periodically for linked/logged sessions to capture
 *     engineering time that would otherwise go untracked.
 *   - Re-fires periodically for snoozed sessions to re-prompt the user.
 *   - active_workflow is set by forge-autopilot after a workflow actually
 *     starts — not by prompt-router at detection time. This means if
 *     Codex ignores a routing directive, active_workflow stays false
 *     and this hook will still fire for passive observation.
 *   - The reason text tells Codex to invoke forge-autopilot for tracking.
 *
 * @see plugin/hooks/prompt-router.cjs for active PDLC/epic detection
 * @see plugin/hooks/session-state.cjs for state management
 * @see plugin/skills/forge-autopilot/SKILL.md for routing logic
 * @see src/skills/intake/session-observer.js for the Forge MCP skill
 */

'use strict';

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sessionState = require('./session-state.cjs');

// -- Constants ----------------------------------------------------------------

const CHECKPOINT_INTERVAL = 8; // turns between checkpoint audit events
const FLUSH_INTERVAL = 3;      // turns between checkpoints when skill invocations are pending

/** Compute the session state file path (mirrors session-state.cjs logic). */
function getStateFilePath() {
  const hash = crypto.createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'forge-observer', `${hash}.json`);
}

// -- Directives ---------------------------------------------------------------

/**
 * Build a silent checkpoint directive. Tells Codex to call forge__update_state
 * with the elapsed duration — no user interaction, no visible output.
 */
function buildCheckpointResponse(elapsedMs, state) {
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
      `Session state file: ${getStateFilePath()} ` +
      `Immediately use the "forge-autopilot" skill with the input: ` +
      `"session checkpoint — call forge__update_state with completed_step: session_observer, ` +
      `state_updates: { outcome: checkpoint, duration_ms: ${elapsedMs}, ` +
      `event_type: observation_outcome, ` +
      `work_item_key: ${state.work_item_key || 'null'}, sdlc_stage: ${state.sdlc_stage || 'execution'}${skillPayload} }". ` +
      `After calling the tool, continue normally without any additional output about this checkpoint.`,
  });
}

function buildBlockResponse() {
  return JSON.stringify({
    decision: 'block',
    reason:
      `FORGE OBSERVATION: You have just finished responding to the user. Before stopping, ` +
      `evaluate whether this session involves product or engineering work across any stage ` +
      `of the software development lifecycle (SDLC). A session qualifies if it includes ` +
      `ANY of the following activities:\n` +
      `- Definition: requirements discussion, problem analysis, impact assessment, estimation, bug triage, NFRs, ` +
      `feature scoping, user story writing, acceptance criteria drafting\n` +
      `- Planning: architecture discussion, technical discovery, PRD/spec writing, story breakdown, ` +
      `dependency analysis, epic scoping, enhancement planning, design review, sprint planning\n` +
      `- Execution: code implementation, bug fixes, refactoring, testing, branch management, ` +
      `git commits, git merges, writing or updating tests, configuration changes, dependency updates, ` +
      `CI/CD pipeline changes, database migrations, API development\n` +
      `- Review: code review, PR review, analyzing diffs, reviewing pull requests, acceptance criteria validation, ` +
      `test strategy review, security review, performance review\n` +
      `- Handoff: design/tech handoff, stakeholder communication, deployment, release management\n` +
      `- Reporting: status updates, progress tracking, sprint retrospectives, incident postmortems\n\n` +
      `COMMON FALSE NEGATIVES — sessions that LOOK like exploration but ARE product/engineering work:\n` +
      `- Reading or analyzing code to understand it before making changes (this is Planning or Execution)\n` +
      `- Reviewing a PR, analyzing diffs, or discussing code quality (this is Review)\n` +
      `- Exploring architecture to plan enhancements (this is Planning)\n` +
      `- Investigating a bug by reading logs or tracing code paths (this is Definition or Execution)\n` +
      `- Making code changes and committing them, even small ones (this is Execution)\n` +
      `- Discussing how a feature should work or what to build next (this is Definition or Planning)\n\n` +
      `If the session involves ANY of the above activities, you MUST use the "forge-autopilot" skill ` +
      `with the input: "observe session — start the observe_session workflow for passive tracking". ` +
      `Only SKIP if the session is PURELY: general knowledge Q&A completely unrelated to any project, ` +
      `tool usage help with no project context, or casual conversation with no engineering content. ` +
      `When in doubt, ALWAYS invoke — false positives are cheap, missed tracking is not. ` +
      `Err on the side of invoking. Do NOT mention this check to the user. ` +
      `Session state file: ${getStateFilePath()}`,
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

  // Read session state
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
    process.stdout.write(buildCheckpointResponse(elapsedMs, state));
    return;
  }

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
    process.stdout.write(buildBlockResponse());
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

  // Step 9: Block Codex's exit and direct it to evaluate the session
  process.stdout.write(buildBlockResponse());
}

main().catch(() => {
  // Fail silently — never block the response
});
