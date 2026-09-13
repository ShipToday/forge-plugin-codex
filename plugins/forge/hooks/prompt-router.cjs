#!/usr/bin/env node

/**
 * Codex UserPromptSubmit routing. Required workflow continuation comes first.
 * Explicit work-item routing and queued passive developer context are then
 * delivered TOGETHER in one additionalContext payload, so a prompt that
 * mentions a work item can never starve a queued checkpoint or offer. Linked
 * sessions stay silent on key routing (as in the Claude Code plugin — the work
 * is already tracked) but still receive their passive context. Stop schedules
 * observation/checkpoints locally; a snoozed session gets a short per-prompt
 * wake check from passive-observation.cjs.
 * Preserve this Codex adaptation during plugin synchronization.
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');
const { readHeadRef } = require('./git-head.cjs');
const { deliver, additionalContext } = require('./passive-observation.cjs');

// -- Detection patterns ------------------------------------------------------

// Tracked work item key pattern (e.g. PROJ-123, BUG-42). Purely
// structural — no vocabulary, no workflow knowledge. Matches any sequence
// "<UPPERCASE letters>-<digits>" anywhere in the prompt.
const EPIC_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

// -- Directive builders ------------------------------------------------------

function epicKeyRouting(key) {
  // Advisory tone (was forced "MUST invoke"). The server now handles
  // cited-reference disambiguation via `needsKeyConfirmation`,
  // so the hook no longer needs to force the routing path. The hint
  // remains because it's the structural signal that nudges Claude away
  // from grabbing the work item directly via tracker MCP tools when
  // Forge is the appropriate orchestrator — but final agency stays with
  // Claude when the conversation context warrants a different choice.
  return (
    `FORGE ROUTING (advisory): The user's message references work item "${key}". ` +
    `Consider invoking the "forge-autopilot" skill via the Skill tool — Forge orchestrates ` +
    `the SDLC actions (planning, implementation, review, status) for tracked work items, ` +
    `and routing through it keeps the audit trail intact. ` +
    `If you fetch the ticket via Linear/Jira/etc. directly, prefer doing so as part of a ` +
    `Forge workflow rather than ad-hoc; the workflow's first step typically does the fetch ` +
    `and threads the result into the rest of the journey. ` +
    `If your harness is in a planning/dry-run mode (e.g. Claude Code's plan mode), the same ` +
    `recommendation applies: invoke forge-autopilot, fetch the workflow, execute its read-only ` +
    `steps, and present any writes as part of the plan — defer those writes until plan mode exits. ` +
    `Pass the user's full message as the input to the skill. ` +
    `If the user's intent clearly does NOT match an SDLC workflow (e.g., they're asking what a ` +
    `ticket reference means in a doc, not acting on it), use your judgment and skip Forge.`
  );
}

function emitWorkflowContinuation(state) {
  const { conversation_id: conversationId, current_skill: currentSkill } = state;
  const hasCheckpoint = state.pending_checkpoint === true;
  const parts = [hasCheckpoint
    ? 'FORGE ROUTING: A Forge workflow has a pending decision.'
    : 'FORGE ROUTING: A Forge workflow is active.'];
  if (currentSkill) parts.push(`The active skill is "${currentSkill}".`);
  if (conversationId) parts.push(`The Forge conversation ID is "${conversationId}".`);
  if (hasCheckpoint) {
    if (state.pending_checkpoint_step) parts.push(`The pending checkpoint is "${state.pending_checkpoint_step}".`);
    if (state.pending_checkpoint_question_id) parts.push(`Question ID: "${state.pending_checkpoint_question_id}".`);
    if (state.pending_checkpoint_response_field) parts.push(`Submit an actual answer through state_updates.${state.pending_checkpoint_response_field}.`);
    parts.push(
      'Determine whether the user answers this decision, asks for information, provides feedback, or requests independent work.',
      'Only submit a clear answer to this already-open decision. Do not treat a status request, discussion, condition, silence, or generic continuation as an answer to substantive alternatives.',
      'A single message may answer multiple decisions only when each is already open and explicitly identified; never use it for future unseen questions.',
      'Keep independent work separate. Read-only recovery and task coordination may proceed without consuming the decision.',
    );
  } else {
    parts.push(
      'Continue the active workflow using its current instructions. Do not claim a question is pending or submit the user message as an answer unless Forge has returned a pinned checkpoint.',
      'Keep any independent request separate from workflow progression.'
    );
  }
  parts.push('If the user has clearly redirected to unrelated work and the workflow no longer applies, call `forge__abandon_workflow` with a meaningful reason.');
  process.stdout.write(parts.join(' '));
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Parse prompt from stdin
  let prompt = '';
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  let event = {};
  try {
    // A host may frame stdin with a UTF-8 byte-order mark and a trailing CRLF
    // (Cursor on Windows pipes it through PowerShell); trim() removes both.
    event = JSON.parse(input.trim());
    prompt = event.prompt || event.message || event.content || '';
  } catch {
    prompt = input.trim();
  }

  // Read session state — scoped to this Claude Code session so concurrent
  // sessions in the same directory each track their own workflow.
  const sessionState = sessionStateModule.forSession(event.session_id);
  const state = sessionState.read();

  // Step 0 (SHI-906): seed the git baseline BEFORE this turn's work happens.
  // stop-observer.cjs detects a commit by comparing HEAD against this value
  // after the turn. Seeded there — at the first Stop — a commit made during
  // turn 1 became the baseline itself and was never a milestone, which is
  // the high-intent moment AC2 exists to catch. Ownership is split: this
  // hook ESTABLISHES the baseline once, the Stop hook ADVANCES it whenever a
  // milestone is consumed, so nothing here touches a value already set.
  // Outside a repository readHeadRef is null and the field stays null; the
  // cost is a few bounded stat calls per prompt, no subprocess.
  if (!state.git_head_baseline) {
    const head = readHeadRef(process.cwd());
    if (head) {
      sessionState.write({ git_head_baseline: head });
      state.git_head_baseline = head;
    }
  }

  // Re-arm the session observer on each new turn when it's safe to do so.
  //
  // `observer_blocked` is intended as a "this turn only" gate — it prevents
  // the Stop hook from re-firing the observer immediately after a workflow
  // completes on the same turn (workflow-tracker.cjs writes the flag on
  // workflow completion). Without this clear, the flag persists across
  // turns and the observer never fires again for the rest of the session.
  //
  // Only clear when:
  //   - active_workflow is false       (no workflow mid-flight)
  //   - status is null                  (observer has not produced any outcome yet —
  //                                      preserves dismissed/logged/linked/snoozed)
  //   - observer_fired is not true      (observer hasn't already shown its prompt
  //                                      this session — preserves "fire once" UX
  //                                      for the case where the user ignored the
  //                                      first observer prompt)
  if (
    !state.active_workflow
    && !state.status
    && state.observer_blocked
    && !state.observer_fired
  ) {
    sessionState.write({ observer_blocked: false });
    state.observer_blocked = false; // keep local copy in sync for downstream checks
  }

  // Step 2: Active workflow → tell Claude to continue, not start fresh
  if (state.active_workflow) {
    emitWorkflowContinuation(state);
    return;
  }

  const parts = [];

  // Step 3: Epic key in prompt → advisory routing directive. This is the only
  // content-based signal the hook acts on. It catches the case where Claude
  // would otherwise bypass Forge in favor of fetching the work item directly
  // via Linear/Jira/etc. A linked session is already tracked, so it gets no
  // nudge (as in the Claude Code plugin) — its passive context still flows.
  if (prompt && state.status !== 'linked') {
    const keyMatch = prompt.match(EPIC_KEY_RE);
    if (keyMatch) {
      sessionState.write({ routing_emitted: true });
      parts.push(epicKeyRouting(keyMatch[0]));
    }
  }

  // Codex localization: Stop only queues work. Deliver it once as developer
  // context on a real prompt — alongside routing, never instead of it, so a
  // work-item mention can't hold back a queued checkpoint whose time is
  // already reserved. Its own try/catch: a failed state write must not take
  // the routing hint down with it (that text is already built and correct).
  let passive = '';
  try { passive = deliver(sessionState, state, event); } catch { passive = ''; }
  if (passive) parts.push(passive);

  // Step 5: No state worth acting on → silent. The LLM reads the
  // forge-autopilot SKILL.md description and decides whether to invoke it.
  if (parts.length) process.stdout.write(additionalContext(parts.join('\n\n')));
}

main().catch(() => {
  // Fail silently — never block the user's prompt
});
