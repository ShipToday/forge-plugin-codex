#!/usr/bin/env node

/**
 * workflow-tracker.cjs — PostToolUse hook for Forge workflow state tracking.
 *
 * Fires after every tool call. Silently exits for non-Forge tools.
 * For Forge MCP tools, updates the session state file so that other hooks
 * (stop-observer, prompt-router) know whether a workflow is active.
 *
 * Handles three transitions:
 *   1. Workflow start: forge__start_workflow succeeds
 *      → writes { active_workflow: true }
 *   2. Observer outcome: forge__update_state with observation_outcome event
 *      → writes { status } so stop-observer checkpoint logic can fire
 *   3. Workflow completion: forge__update_state returns a completed workflow
 *      → writes { active_workflow: false, observer_blocked: true }
 *
 * This replaces the previous approach of asking Claude to write the state
 * file via SKILL.md instructions — Claude consistently forgot because the
 * MCP response's large instruction block captured its attention.
 *
 * @see plugin/hooks/session-state.cjs for state management
 * @see plugin/hooks/stop-observer.cjs for the Stop hook that reads this state
 * @see plugin/skills/forge-autopilot/SKILL.md for the routing skill
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');

// -- Tool name patterns (MCP names include dynamic server UUIDs) --------------

const WORKFLOW_START_PATTERNS = [
  'forge__start_workflow',
];

const WORKFLOW_STATE_PATTERN = 'forge__update_state';
const WORKFLOW_ABANDON_PATTERN = 'forge__abandon_workflow';

// -- Helpers ------------------------------------------------------------------

/**
 * Extract the human-readable text from a PostToolUse `tool_response`.
 *
 * MCP tool responses arrive as a structured payload — not a string —
 * in one of two shapes depending on the client:
 *   - Wrapped envelope: `{ content: [{ type: "text", text: "…" }] }`
 *   - Bare content array: `[{ type: "text", text: "…" }]` (Claude Code)
 *
 * `JSON.stringify`-ing either shape escapes every real newline into a
 * literal `\n` sequence, which breaks any regex that relies on `[^\n]`
 * line boundaries or matches quoted/comma'd content. This helper pulls
 * the actual text payload so the extractors below operate on the
 * response as the orchestrator rendered it.
 */
function responseText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  // Bare content array (Claude Code's PostToolUse shape for MCP tools).
  if (Array.isArray(response)) {
    return response
      .map((c) => (c && typeof c.text === 'string') ? c.text : '')
      .join('\n');
  }
  // Wrapped envelope.
  if (Array.isArray(response.content)) {
    return response.content
      .map((c) => (c && typeof c.text === 'string') ? c.text : '')
      .join('\n');
  }
  return JSON.stringify(response);
}

/**
 * Check if a tool_response looks like a valid Forge workflow response.
 * Forge responses contain a "Conversation ID" line on success.
 */
function isValidWorkflowResponse(response) {
  if (!response) return false;
  const text = responseText(response);
  return text.includes('Conversation ID');
}

/**
 * Check if a forge__update_state response indicates workflow completion.
 * Completion responses contain patterns like "(3/3)" where both numbers match,
 * or "Skill ... completed" for standalone skills.
 */
function isWorkflowComplete(response) {
  if (!response) return false;
  const text = responseText(response);

  // Pattern: "(N/N)" where both numbers are equal — all steps done
  const stepMatch = text.match(/\((\d+)\/(\d+)\)/);
  if (stepMatch && stepMatch[1] === stepMatch[2]) return true;

  // Pattern: "Skill **name** completed." — standalone skill finished
  if (/Skill \*\*\w+\*\* completed\./.test(text)) return true;

  return false;
}

/**
 * Check if a forge__abandon_workflow response indicates a successful abandon.
 * Successful abandon responses begin with "**Workflow abandoned**" — the
 * fixed marker rendered by src/tools/abandon-workflow.js.
 */
function isWorkflowAbandoned(response) {
  if (!response) return false;
  const text = responseText(response);
  return /\*\*Workflow abandoned\*\*/.test(text);
}

/**
 * Check if a forge__update_state response indicates a CHECKPOINT — the
 * same step is still running and is awaiting some form of user input.
 * Two variants share this marker:
 *   - Relayed-question CHECKPOINT (`"<step>" awaiting user input`): the
 *     skill emitted needs_input and is waiting for the AI to relay it.
 *   - Post-step confirmation-gate CHECKPOINT
 *     (`"<step>" paused at confirmation gate`): the orchestrator paused
 *     after the step completed, waiting for the user to confirm advance.
 *
 * Both are rendered by src/tools/update-state.js and both should keep
 * the workflow-guard locked to ask_user / forge__update_state /
 * forge__abandon_workflow until the AI resolves the gate.
 *
 * Returns the step name that's pinned, or null if the response does
 * not carry a CHECKPOINT marker.
 */
function extractPendingCheckpointStep(response) {
  if (!response) return null;
  const text = responseText(response);
  const match = text.match(/\*\*CHECKPOINT\*\*\s+—\s+"([^"]+)"\s+(?:awaiting user input|paused at confirmation gate)/);
  return match ? match[1] : null;
}

/**
 * Check if a forge__update_state response indicates a relayed-question
 * RE-ENTRY — the user's answer has flowed back through the parent and the
 * skill is resuming. Marker is rendered by src/tools/update-state.js:
 * `**RE-ENTRY** — "<step>" resumed with user answer`.
 */
function isRelayedQuestionReentry(response) {
  if (!response) return false;
  const text = responseText(response);
  return /\*\*RE-ENTRY\*\*\s+—\s+"[^"]+"\s+resumed with user answer/.test(text);
}

/**
 * Extract the per-step tool-permission allowlist the orchestrator
 * publishes inline as `**Tool Permissions**: cat1, cat2, cat3`.
 *
 * Returns an array of category strings (e.g. ["read_code", "ask_user",
 * "tracker_read"]), or null if no line is present (defensive: the
 * workflow-guard hook fails open when categories are absent so unknown
 * skills or older orchestrators don't brick non-checkpoint tool calls).
 */
function extractToolPermissions(response) {
  if (!response) return null;
  const text = responseText(response);
  const match = text.match(/\*\*Tool Permissions\*\*:\s*([^\n]+)/);
  if (!match) return null;
  return match[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract the active step's bare skill_id from an update_state response.
 * Tries the NEXT STEP, RE-ENTRY, and CHECKPOINT markers in that order.
 * Returns null if none match.
 */
function extractCurrentStepSkill(response) {
  if (!response) return null;
  const text = responseText(response);
  const next = text.match(/\*\*NEXT STEP\*\*:\s*"([^"]+)"/);
  if (next) return next[1];
  const reentry = text.match(/\*\*RE-ENTRY\*\*\s+—\s+"([^"]+)"/);
  if (reentry) return reentry[1];
  const checkpoint = text.match(/\*\*CHECKPOINT\*\*\s+—\s+"([^"]+)"/);
  if (checkpoint) return checkpoint[1];
  return null;
}

// Maps session_observer outcome values to local session status. These are
// the outcomes carried on a normal `event_type: "observation_outcome"`
// payload — the user engaged with the nudge. "linked" is handled separately
// (observer launches a workflow → active_workflow: true).
//
// The org-disabled gate is deliberately NOT in this map. It arrives as
// outcome "observation_disabled" with event_type "observation_skipped" (so
// the orchestrator suppresses the audit row — see src/orchestrator.js and
// src/skills/intake/session-observer.js → buildObservationGatedCompletion)
// and is handled separately by extractObservationGate below. It must NOT map
// to a tracking status like "logged": a disabled org is not tracked, and a
// "logged" status would make stop-observer.cjs fire periodic engineering-time
// checkpoints for it. The only thing the gate writes is the per-session +
// cross-session `forge_observation_enabled: false` cache flag.
const OUTCOME_TO_STATUS = {
  ad_hoc: 'logged',
  snoozed: 'snoozed',
  dismissed: 'dismissed',
};

/**
 * Extract observer event metadata from a forge__update_state tool input.
 * Returns `{ status, outcome }` if this is a recognised observation_outcome
 * event, or null otherwise. `status` is the mapped local session status;
 * `outcome` is the raw outcome string the caller can branch on for
 * outcome-specific side effects (e.g. the SHI-759 cache-flag pin).
 */
function extractObserverEvent(event) {
  let input = event.tool_input || {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return null; }
  }
  const updates = input.state_updates;
  if (!updates || updates.event_type !== 'observation_outcome') return null;
  const status = OUTCOME_TO_STATUS[updates.outcome] || null;
  if (!status) return null;
  return { status, outcome: updates.outcome };
}

/**
 * Detect the org-disabled gate completion from a forge__update_state input.
 *
 * The session_observer gated-completion payload
 * (src/skills/intake/session-observer.js → buildObservationGatedCompletion)
 * carries `outcome: "observation_disabled"` — currently with
 * `event_type: "observation_skipped"` so the orchestrator suppresses the
 * audit row. We key off the OUTCOME (not the event_type) so detection stays
 * robust if that audit-suppression event_type is ever renamed. This is
 * separate from extractObserverEvent because the gate maps to no tracking
 * status (a disabled org is not tracked); its only effect is pinning the
 * per-session + cross-session `forge_observation_enabled: false` cache so
 * stop-observer.cjs short-circuits subsequent Stops (and subsequent
 * sessions) without re-firing the directive.
 *
 * Returns true for the gate, false otherwise.
 */
function extractObservationGate(event) {
  let input = event.tool_input || {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return false; }
  }
  const updates = input.state_updates;
  return !!updates && updates.outcome === 'observation_disabled';
}

/**
 * Extract the Forge conversation ID from a workflow response.
 * Handles both plain text and markdown-bold variants.
 */
function extractConversationId(response) {
  if (!response) return null;
  const text = responseText(response);
  const match = text.match(/\*?\*?Conversation ID\*?\*?:\s*`?([a-f0-9-]+)`?/i);
  return match ? match[1] : null;
}

/**
 * Extract the workflow id from the tool input.
 */
function extractSkillContext(event) {
  let input = event.tool_input || {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  return input.workflow || null;
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Parse PostToolUse event from stdin
  let event = {};
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  try {
    event = JSON.parse(input);
  } catch {
    return; // Malformed input — exit silently
  }

  // Scope state to this Claude Code session so concurrent sessions in the
  // same directory each track their own workflow.
  const sessionState = sessionStateModule.forSession(event.session_id);

  const toolName = event.tool_name || '';
  const toolResponse = event.tool_response || '';

  // Track local skill invocations via the Skill tool (Claude Code).
  // The PostToolUse hook fires for ALL tool calls — including the built-in
  // Skill tool. We record which local skills the AI invoked so the
  // stop-observer checkpoint can flush them to the Forge audit trail.
  if (toolName === 'Skill') {
    let toolInput = event.tool_input || {};
    if (typeof toolInput === 'string') {
      try { toolInput = JSON.parse(toolInput); } catch { toolInput = {}; }
    }
    const skillName = toolInput.skill || null;
    // Ignore forge-autopilot — that's our own routing skill, not a local skill
    if (skillName && skillName !== 'forge-autopilot') {
      const state = sessionState.read();
      const invocations = state.skill_invocations || [];
      invocations.push({ name: skillName, at: new Date().toISOString() });
      sessionState.write({ skill_invocations: invocations });
    }
    return;
  }

  // Fast path: check if this is a Forge tool at all
  const isWorkflowStart = WORKFLOW_START_PATTERNS.some((p) => toolName.includes(p));
  const isStateUpdate = toolName.includes(WORKFLOW_STATE_PATTERN);
  const isAbandon = toolName.includes(WORKFLOW_ABANDON_PATTERN);

  if (!isWorkflowStart && !isStateUpdate && !isAbandon) return; // Not a Forge tool — exit silently

  // Workflow abandoned: clear local session state immediately. Mirrors the
  // workflow-completion handler below — same flag flips, same observer-block
  // semantics — so the UserPromptSubmit hook stops emitting "workflow active"
  // reminders on the next turn.
  if (isAbandon && isWorkflowAbandoned(toolResponse)) {
    sessionState.write({
      active_workflow: false,
      observer_blocked: true,
      conversation_id: null,
      current_skill: null,
      pending_checkpoint: false,
      pending_checkpoint_step: null,
      pending_checkpoint_at: null,
      current_step_tools: null,
      current_step_skill: null,
    });
    return;
  }

  // Workflow start: mark session as active and capture context
  if (isWorkflowStart && isValidWorkflowResponse(toolResponse)) {
    const conversationId = extractConversationId(toolResponse);
    const currentSkill = extractSkillContext(event);
    const toolPermissions = extractToolPermissions(toolResponse);
    const currentStepSkill = extractCurrentStepSkill(toolResponse);
    const updates = {
      active_workflow: true,
      conversation_id: conversationId,
      current_skill: currentSkill,
      // Per-step allowlist (V2 enforcement). null when the orchestrator did
      // not publish a Tool Permissions line — workflow-guard fails open.
      current_step_tools: toolPermissions,
      current_step_skill: currentStepSkill,
    };
    // Pin the observe_session conversation id separately so the periodic
    // Stop-hook checkpoint can target it after the workflow completes —
    // conversation_id above is nulled on completion. Captured here (not
    // on completion) so it always reflects the observer run and is never
    // overwritten by a chained follow-up workflow.
    if (currentSkill === 'observe_session') {
      updates.last_observer_conversation_id = conversationId;
    }
    sessionState.write(updates);
    return;
  }

  // Observer outcome: when session_observer completes via forge__update_state,
  // persist the status to the local session state file so stop-observer can
  // use it for checkpoint logic. Claude is instructed to write this itself,
  // but it inconsistently forgets — this hook makes it reliable.
  if (isStateUpdate) {
    // Org-disabled gate backstop (SHI-758/759). The session_observer gated
    // completion tells the AI parent to write forge_observation_enabled: false
    // into the per-session state file, but the parent "consistently forgets
    // because the MCP response's large instruction block captures its
    // attention" (file header) — confirmed on disk: disabled-org sessions that
    // completed the full observe_session round-trip still ended with
    // forge_observation_enabled: null. This hook makes the write reliable so
    // the rest of THIS session short-circuits (Step 3b in stop-observer.cjs)
    // without re-invoking Forge. The flag is per-session by design: each new
    // session re-checks, so an admin re-enabling the observer is picked up at
    // the next session start. No tracking status is set — a disabled org is
    // not tracked. Keyed off outcome (not event_type), so it fires for the
    // current `observation_skipped` payload and survives an event_type rename.
    if (extractObservationGate(event)) {
      sessionState.write({ forge_observation_enabled: false });
      // Don't return — a single-step gated workflow also reports completion
      // below, which clears active_workflow / sets observer_blocked.
    }

    const observerEvent = extractObserverEvent(event);
    if (observerEvent) {
      const { status: observerStatus } = observerEvent;
      const statusUpdates = {
        status: observerStatus,
        last_checkpoint_at: new Date().toISOString(),
      };
      // For dismissed/no_observation, also block re-observation
      if (observerStatus === 'dismissed') {
        statusUpdates.observer_blocked = true;
      }
      sessionState.write(statusUpdates);
      // Don't return — still check for workflow completion below
    }

    // Relayed-question pending_checkpoint pin/clear.
    //
    // When the orchestrator emits **CHECKPOINT** (relayed-question skill is
    // awaiting user input via the parent's AskUserQuestion), record the pin
    // so the future workflow-guard PreToolUse hook can deny tool calls other
    // than AskUserQuestion / forge__update_state until the user has answered.
    // The pin clears on **RE-ENTRY** (the user's answer flowed back), or
    // implicitly on workflow completion / abandonment below.
    const pendingStep = extractPendingCheckpointStep(toolResponse);
    if (pendingStep) {
      sessionState.write({
        pending_checkpoint: true,
        pending_checkpoint_step: pendingStep,
        pending_checkpoint_at: new Date().toISOString(),
      });
    } else if (isRelayedQuestionReentry(toolResponse)) {
      sessionState.write({
        pending_checkpoint: false,
        pending_checkpoint_step: null,
        pending_checkpoint_at: null,
      });
    } else if (!isWorkflowComplete(toolResponse)) {
      // Normal step advance ("NEXT STEP") — clear any stale pin. Workflow
      // completion is handled by the dedicated branch below which also
      // clears the pin via active_workflow: false semantics.
      const state = sessionState.read();
      if (state.pending_checkpoint) {
        sessionState.write({
          pending_checkpoint: false,
          pending_checkpoint_step: null,
          pending_checkpoint_at: null,
        });
      }
    }

    // Per-step tool-permission allowlist refresh (V2 enforcement). Each
    // step transition publishes a fresh `**Tool Permissions**: …` line;
    // we mirror it into session state so workflow-guard can enforce the
    // correct allowlist for the active step. Cleared on workflow
    // completion / abandonment via the dedicated branches.
    if (!isWorkflowComplete(toolResponse)) {
      const toolPermissions = extractToolPermissions(toolResponse);
      const currentStepSkill = extractCurrentStepSkill(toolResponse);
      if (toolPermissions || currentStepSkill) {
        sessionState.write({
          current_step_tools: toolPermissions,
          current_step_skill: currentStepSkill,
        });
      }
    }
  }

  // Workflow completion: deactivate workflow but keep observer blocked.
  // Setting observer_blocked: true prevents the stop-observer from
  // immediately re-firing the session observer on the same turn.
  // The prompt-router still routes new explicit requests (epic keys,
  // PDLC phrases) because it checks active_workflow, not observer_blocked.
  if (isStateUpdate && isWorkflowComplete(toolResponse)) {
    sessionState.write({
      active_workflow: false,
      observer_blocked: true,
      conversation_id: null,
      current_skill: null,
      pending_checkpoint: false,
      pending_checkpoint_step: null,
      pending_checkpoint_at: null,
      current_step_tools: null,
      current_step_skill: null,
    });
    return;
  }
}

main().catch(() => {
  // Fail silently — never interfere with Claude's response
});
