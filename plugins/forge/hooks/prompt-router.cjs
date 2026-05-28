#!/usr/bin/env node

/**
 * prompt-router.js — UserPromptSubmit hook for the ShipToday Forge plugin.
 *
 * Mostly stateful routing — content-based pattern matching for SDLC
 * vocabulary (PRD, story breakdown, tech handoff, etc.) has been removed.
 * The LLM decides whether to invoke `forge-autopilot` for those cases
 * via its SKILL.md description.
 *
 * The hook fires for two things the LLM cannot reliably decide on its own:
 *
 *   1. **Epic key references** (e.g. "explore architecture of SHI-615").
 *      Skill discovery is a soft signal and Claude can choose to bypass
 *      Forge when it has alternative tools (Linear MCP, Read, Grep) that
 *      look usable. A regex match on a tracked work item id is a strong
 *      structural signal and gets an ADVISORY routing directive — a hint
 *      that surfaces the key and recommends Forge, but yields agency to
 *      Claude when the conversation context warrants a different route
 *      (SHI-678). The regex is purely structural — it knows nothing
 *      about workflows or skills, so adding new ones requires no changes
 *      here.
 *
 *   2. **Stateful routing** for things stored on disk by other hooks:
 *      - active workflow continuation (workflow-tracker writes this)
 *      - snoozed wake check (session_observer writes this)
 *
 * Execution order (first match wins):
 *   1. Linked → silent (already tracked, no directive needed)
 *   2. Active workflow → emit continuation directive
 *   3. Epic key in prompt → emit epic-key routing directive
 *   4. Snoozed → emit wake check
 *   5. Otherwise → silent (let the LLM decide via SKILL.md description)
 *
 * @see plugin/hooks/session-state.cjs for state management
 * @see plugin/hooks/stop-observer.cjs for passive observation
 * @see plugin/skills/forge-autopilot/SKILL.md for routing logic
 * @see src/skills/intake/session-observer.js for the Forge MCP skill
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');

// -- Detection patterns ------------------------------------------------------

// Tracked work item key pattern (e.g. SHI-448, PROJ-123, BUG-42). Purely
// structural — no vocabulary, no workflow knowledge. Matches any sequence
// "<UPPERCASE letters>-<digits>" anywhere in the prompt.
const EPIC_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

// -- Directive builders ------------------------------------------------------

function emitWakeConditionCheck(wakeCondition) {
  process.stdout.write(
    `FORGE ROUTING: This session is snoozed. ` +
    `Wake condition: "${wakeCondition}". ` +
    `Evaluate if the user's current message signals readiness. ` +
    `If yes, you MUST invoke the "forge-autopilot" skill via the Skill tool BEFORE responding ` +
    `with the input: "observe session — start the observe_session workflow for passive tracking". ` +
    `If no, continue normally and do NOT mention this check to the user.`
  );
}

function emitEpicKeyRouting(key) {
  // SHI-678: advisory tone (was forced "MUST invoke"). The orchestrator
  // now handles cited-reference disambiguation via `needsKeyConfirmation`,
  // so the hook no longer needs to force the routing path. The hint
  // remains because it's the structural signal that nudges Claude away
  // from grabbing the work item directly via tracker MCP tools when
  // Forge is the appropriate orchestrator — but final agency stays with
  // Claude when the conversation context warrants a different choice.
  process.stdout.write(
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

function emitWorkflowContinuation(conversationId, currentSkill) {
  const parts = ['FORGE ROUTING: A Forge workflow is active and waiting for user input.'];
  if (currentSkill) parts.push(`The active skill is "${currentSkill}".`);
  if (conversationId) parts.push(`The Forge conversation ID is "${conversationId}".`);
  parts.push(
    'The user\'s message is a response to the workflow\'s last question.',
    'You MUST continue the active Forge workflow — do NOT start a new workflow or treat this as a fresh request.',
    'Pass the user\'s full message as the answer to the pending checkpoint.',
    'If the user has clearly redirected to unrelated work and the workflow no longer applies,',
    'call `forge__abandon_workflow` with a meaningful reason to cleanly close the conversation.',
    'Do NOT silently bypass the workflow — silent bypass leaves the audit trail blind.'
  );
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
    event = JSON.parse(input);
    prompt = event.prompt || event.message || event.content || '';
  } catch {
    prompt = input.trim();
  }

  // Read session state — scoped to this Claude Code session so concurrent
  // sessions in the same directory each track their own workflow.
  const sessionState = sessionStateModule.forSession(event.session_id);
  const state = sessionState.read();

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

  // Step 1: Linked sessions need no directives — already tracked
  if (state.status === 'linked') return;

  // Step 2: Active workflow → tell Claude to continue, not start fresh
  if (state.active_workflow) {
    emitWorkflowContinuation(state.conversation_id, state.current_skill);
    return;
  }

  // Step 3: Epic key in prompt → forced routing directive (wins over
  // snoozed/dismissed because the user is explicitly referencing tracked work).
  // This is the only content-based signal the hook acts on. It catches the
  // case where Claude would otherwise bypass Forge in favor of fetching the
  // work item directly via Linear/Jira/etc.
  if (prompt) {
    const keyMatch = prompt.match(EPIC_KEY_RE);
    if (keyMatch) {
      sessionState.write({ routing_emitted: true });
      emitEpicKeyRouting(keyMatch[0]);
      return;
    }
  }

  // Step 4: Snoozed → ask Claude to re-evaluate against the wake condition
  if (state.status === 'snoozed') {
    const wake = state.wake_condition || 'user signals readiness to move forward';
    emitWakeConditionCheck(wake);
    return;
  }

  // Step 5: No state worth acting on → silent. The LLM reads the
  // forge-autopilot SKILL.md description and decides whether to invoke
  // it. stop-observer.cjs handles passive observation after the response.
}

main().catch(() => {
  // Fail silently — never block the user's prompt
});
