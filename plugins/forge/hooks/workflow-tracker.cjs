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
 * This replaces the previous approach of asking Codex to write the state
 * file via SKILL.md instructions — Codex can miss this because the
 * MCP response's large instruction block captured its attention.
 *
 * @see plugin/hooks/session-state.cjs for state management
 * @see plugin/hooks/stop-observer.cjs for the Stop hook that reads this state
 * @see plugin/skills/forge-autopilot/SKILL.md for the routing skill
 */

'use strict';

const sessionState = require('./session-state.cjs');

// -- Tool name patterns (MCP names include dynamic server UUIDs) --------------

const WORKFLOW_START_PATTERNS = [
  'forge__start_workflow',
];

const WORKFLOW_STATE_PATTERN = 'forge__update_state';
const WORKFLOW_ABANDON_PATTERN = 'forge__abandon_workflow';

// -- Helpers ------------------------------------------------------------------

/**
 * Coerce a PostToolUse `tool_response` into plain text.
 *
 * MCP tool responses arrive as a structured object (commonly
 * `{ content: [{ type: "text", text: "..." }] }`), not a string.
 * JSON.stringify-ing such an object escapes every real newline into a
 * literal `\n` sequence, which breaks line-anchored regexes like the
 * `[^\n]+` capture in extractToolPermissions. Pull the real text out
 * instead so newlines stay intact.
 */
function responseText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  const content = Array.isArray(response) ? response : response.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof response.text === 'string') return response.text;
  if (typeof response.output === 'string') return response.output;
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

// Maps session_observer outcome values to local session status.
// "linked" is handled separately (observer launches a workflow → active_workflow: true).
const OUTCOME_TO_STATUS = {
  ad_hoc: 'logged',
  snoozed: 'snoozed',
  dismissed: 'dismissed',
};

/**
 * Extract observer outcome from a forge__update_state tool input.
 * Returns the local status string if this is an observation_outcome event,
 * or null otherwise.
 */
function extractObserverStatus(event) {
  let input = event.tool_input || {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return null; }
  }
  const updates = input.state_updates;
  if (!updates || updates.event_type !== 'observation_outcome') return null;
  return OUTCOME_TO_STATUS[updates.outcome] || null;
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

  const toolName = event.tool_name || '';
  const toolResponse = event.tool_response || '';

  // Track local skill invocations from the model runtime.
  // The PostToolUse hook fires for ALL tool calls. We record which local
  // skills the AI invoked so the
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
    sessionState.write({
      active_workflow: true,
      conversation_id: conversationId,
      current_skill: currentSkill,
      // Per-step allowlist (V2 enforcement). null when the orchestrator did
      // not publish a Tool Permissions line — workflow-guard fails open.
      current_step_tools: toolPermissions,
      current_step_skill: currentStepSkill,
    });
    return;
  }

  // Observer outcome: when session_observer completes via forge__update_state,
  // persist the status to the local session state file so stop-observer can
  // use it for checkpoint logic. Codex is instructed to write this itself,
  // but it inconsistently forgets — this hook makes it reliable.
  if (isStateUpdate) {
    const observerStatus = extractObserverStatus(event);
    if (observerStatus) {
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
    // awaiting user input via the parent's user-question relay), record the pin
    // so the future workflow-guard PreToolUse hook can deny tool calls other
    // than user-question relay / forge__update_state until the user has answered.
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
  // Fail silently — never interfere with Codex's response
});
