#!/usr/bin/env node

/**
 * Codex UserPromptSubmit routing. Required workflow continuation comes first.
 * Queued passive developer context is then delivered in one additionalContext
 * payload, and a snoozed session gets a short per-prompt wake check from
 * passive-observation.cjs. Linked sessions still receive their passive
 * context. Stop schedules observation/checkpoints locally.
 *
 * Forge starts only when the user asks for it by name, and whether
 * they did is the model's judgment — made against the rule in the
 * forge-autopilot skill and the server's instructions. This hook reads nothing
 * in the message to decide it: no Forge name, no SDLC vocabulary, no work item
 * key. (A key used to earn an advisory routing hint; that is gone.)
 * Preserve this Codex adaptation during plugin synchronization.
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');
const { readHeadRef } = require('./git-head.cjs');
const { deliver, additionalContext } = require('./passive-observation.cjs');

// -- Directive builders ------------------------------------------------------

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

// A state write can throw: session-state gives up on a lock another hook holds
// after LOCK_MAX_WAIT_MS, and refuses to overwrite a file it cannot parse. A
// throw here used to reject main(), whose catch swallowed the directive this
// turn was about to emit — a pending decision's continuation included. No
// write here is worth that, so a failed one is dropped and routing goes on;
// callers update the in-memory state themselves, so this turn still routes on
// what it saw.
function persist(sessionState, updates) {
  try { sessionState.write(updates); } catch { /* keep routing */ }
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Parse the event from stdin. Only its session and turn ids are used — the
  // prompt text itself is never read (see the file header).
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  let event = {};
  try {
    // A host may frame stdin with a UTF-8 byte-order mark and a trailing CRLF
    // (Cursor on Windows pipes it through PowerShell); trim() removes both.
    event = JSON.parse(input.trim());
  } catch {
    // Not JSON: no session id, so state falls back to the cwd key.
  }

  // Read session state — scoped to this Claude Code session so concurrent
  // sessions in the same directory each track their own workflow.
  const sessionState = sessionStateModule.forSession(event.session_id);
  const state = sessionState.read();

  // Approval authenticity: a prompt arriving while a question is
  // pinned is the user's turn on it — a numbered reply, or a plain answer
  // where no native question tool exists. workflow-guard accepts an answer
  // posted after this stamp; without it (or a question-tool call) the model
  // is answering on the user's behalf, and the guard refuses.
  if (state.active_workflow && state.pending_checkpoint) {
    const at = new Date().toISOString();
    persist(sessionState, { pending_checkpoint_user_turn_at: at });
    state.pending_checkpoint_user_turn_at = at;
  }

  // Step 0: seed the git baseline BEFORE this turn's work happens.
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
      persist(sessionState, { git_head_baseline: head });
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
    persist(sessionState, { observer_blocked: false });
    state.observer_blocked = false; // keep local copy in sync for downstream checks
  }

  // Step 2: Active workflow → tell Claude to continue, not start fresh
  if (state.active_workflow) {
    emitWorkflowContinuation(state);
    return;
  }

  // Codex localization: Stop only queues work. Deliver it once as developer
  // context on a real prompt (the snoozed-session wake check travels the same
  // way). Its own try/catch: a failed state write must not take this hook
  // down.
  let passive = '';
  try { passive = deliver(sessionState, state, event); } catch { passive = ''; }

  // Otherwise silent. The model answers, and starts Forge only if the user
  // asked for it (the forge-autopilot skill's trigger rule).
  if (passive) process.stdout.write(additionalContext(passive));
}

main().catch(() => {
  // Fail silently — never block the user's prompt
});
