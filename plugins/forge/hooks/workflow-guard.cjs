#!/usr/bin/env node

/**
 * workflow-guard.cjs — PreToolUse hook for Forge workflow enforcement.
 *
 * Fires before every tool call. Reads session state and decides whether the
 * tool may proceed. Two layers of enforcement:
 *
 *   1. CHECKPOINT enforcement (V1, #518): when the orchestrator has emitted
 *      a relayed-question CHECKPOINT and the workflow-tracker hook has set
 *      `pending_checkpoint: true`, only AskUserQuestion / forge__update_state
 *      / forge__abandon_workflow / read-only inspection may proceed.
 *
 *   2. Per-step tool_permissions enforcement (V2, this PR): when a workflow
 *      is active but no checkpoint is pending, the orchestrator publishes a
 *      `**Tool Permissions**: cat1, cat2, …` line on every step transition.
 *      The workflow-tracker hook mirrors that into `current_step_tools`.
 *      We deny tools whose category is not in the allowlist for the active
 *      step. Universal tools (Forge orchestration, Read/Grep/Glob,
 *      AskUserQuestion, TodoWrite, web inspection) are always allowed
 *      regardless of step.
 *
 * Defensive defaults:
 *   - If no workflow is active, allow.
 *   - If `current_step_tools` is null (e.g., older orchestrator that does
 *     not publish the line), fail open — only CHECKPOINT enforcement runs.
 *   - If the tool name does not map to any known category, allow. Unknown
 *     tools (custom MCP connectors, future built-ins) should not be blocked
 *     by a closed-world allowlist.
 *
 * Hook contract: PreToolUse hooks may emit a JSON payload on stdout with
 * `{decision: "deny", reason: "..."}` to refuse the tool. Anything else
 * (silence, exit code 0) allows the call to proceed.
 *
 * @see plugin/hooks/workflow-tracker.cjs for the state writes this hook reads
 * @see plugin/hooks/session-state.cjs for state management
 * @see src/skills/permissions.js for the server-side category source of truth
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');

// -- Universal allowlist ----------------------------------------------------
// Always-allowed tools regardless of active step. Forge orchestration,
// Claude Code primitives that cannot mutate state, and the user-question
// relay path.

const ALWAYS_ALLOWED_BARE_NAMES = new Set([
  // Forge orchestration — model needs these to advance / exit / recover
  'forge__update_state',
  'forge__abandon_workflow',
  'forge__start_workflow',
  'forge__get_workflow_state', // Read-only recovery channel; safe to call mid-CHECKPOINT
  // Question relay — the only way for the model to talk to the user mid-step
  'AskUserQuestion',
  // Claude Code primitives — read-only or local-only, cannot mutate external state
  'Read',
  'Grep',
  'Glob',
  'TodoWrite',
  'mark_chapter',
  // Internal session tooling
  'spawn_task',
]);

// Read-only MCP tool name prefixes (always-allowed during workflow time).
const READONLY_PREFIXES = ['list_', 'get_', 'search_', 'query_', 'fetch_', 'read_', 'notion-search', 'notion-fetch', 'notion-get-'];

// -- Category → tool patterns ----------------------------------------------
// Maps the abstract categories the orchestrator publishes into concrete
// tool name regexes. Each entry is checked against the bare tool name
// (after stripping `mcp__<uuid>__`).
//
// The categories are deliberately coarse — the goal is to catch silent
// bypass (e.g., Edit during readiness_check), not to micromanage every
// connector. A skill that declares `tracker_write` gets every common
// tracker-write tool; if a connector ships a new write verb, it slots in
// without a registry update.

const CATEGORY_PATTERNS = {
  read_code:    [/^Read$/, /^Grep$/, /^Glob$/],
  ask_user:     [/^AskUserQuestion$/],
  web:          [/^WebFetch$/, /^WebSearch$/],

  tracker_read: [
    /^list_issues$/, /^get_issue$/, /^get_issue_status$/, /^list_issue_statuses$/,
    /^list_issue_labels$/, /^list_project_labels$/, /^list_comments$/,
    /^list_projects$/, /^get_project$/, /^list_milestones$/, /^get_milestone$/,
    /^list_documents$/, /^get_document$/, /^search_documentation$/,
    /^list_users$/, /^get_user$/, /^list_teams$/, /^get_team$/,
    /^list_cycles$/, /^get_attachment$/, /^extract_images$/,
    /^searchJiraIssuesUsingJql$/, /^getJiraIssue$/,
    /^searchConfluenceUsingCql$/, /^getConfluencePage$/,
    /^search_threads$/, /^get_thread$/, /^list_drafts$/, /^list_labels$/,
  ],
  tracker_write: [
    /^save_issue$/, /^create_issue$/, /^update_issue$/,
    /^save_comment$/, /^create_comment$/, /^delete_comment$/,
    /^save_milestone$/, /^save_project$/, /^save_document$/,
    /^create_attachment$/, /^delete_attachment$/, /^upload_attachments$/,
    /^create_issue_label$/,
    /^createJiraIssue$/, /^updateJiraIssue$/,
    /^create_label$/, /^create_draft$/,
  ],

  docs_read:    [
    /^notion-search$/, /^notion-fetch$/, /^notion-get-comments$/,
    /^notion-get-teams$/, /^notion-get-users$/,
  ],
  docs_write:   [
    /^notion-create-/, /^notion-update-/, /^notion-move-/, /^notion-duplicate-/,
  ],

  messaging:    [/^slack_/, /^send_message$/],
  calendar:     [
    /^list_calendars$/, /^list_events$/, /^get_event$/, /^create_event$/,
    /^update_event$/, /^delete_event$/, /^respond_to_event$/, /^suggest_time$/,
  ],
  design:       [
    /^get_design_context$/, /^get_screenshot$/, /^get_metadata$/, /^get_figjam$/,
    /^get_libraries$/, /^get_variable_defs$/, /^use_figma$/,
    /^add_code_connect_map$/, /^get_code_connect_map$/, /^get_code_connect_suggestions$/,
    /^get_context_for_code_connect$/, /^send_code_connect_mappings$/,
    /^create_design_system_rules$/, /^search_design_system$/,
    /^upload_assets$/, /^create_new_file$/, /^generate_diagram$/, /^whoami$/,
  ],
  meetings:     [
    /^search_meetings$/, /^get_meeting_transcript$/, /^get_meetings$/,
    /^list_meetings$/, /^list_meeting_folders$/, /^query_granola_meetings$/,
    /^get_account_info$/,
  ],

  code_edit:    [/^Edit$/, /^Write$/, /^NotebookEdit$/],
  shell:        [/^Bash$/, /^PowerShell$/],
};

// -- Helpers ----------------------------------------------------------------

/**
 * Strip the `mcp__<uuid>__` prefix from an MCP tool name, returning the
 * bare tool name. Non-MCP tool names are returned as-is.
 */
function bareName(toolName) {
  if (!toolName) return '';
  const m = toolName.match(/^mcp__[^_]+(?:-[^_]+)*__(.+)$/);
  return m ? m[1] : toolName;
}

function isUniversallyAllowed(bare) {
  if (ALWAYS_ALLOWED_BARE_NAMES.has(bare)) return true;
  for (const prefix of READONLY_PREFIXES) {
    if (bare.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Does the bare tool name match any pattern in the allowed categories?
 * Returns the matching category or null. If null, the tool either belongs
 * to a category not in the allowlist (deny) or to no known category (allow,
 * fail-open).
 */
function categoryFor(bare) {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(bare)) return category;
    }
  }
  return null;
}

function isAllowedByStepPermissions(bare, allowedCategories) {
  const category = categoryFor(bare);
  if (!category) return true; // Unknown tool — fail open
  return allowedCategories.includes(category);
}

function buildCheckpointDenyReason(state, toolName) {
  const lines = [
    `Forge workflow is at a CHECKPOINT awaiting user input (skill="${state.pending_checkpoint_step || 'unknown'}").`,
    `Tool "${toolName}" cannot proceed until the user has answered.`,
    ``,
    'You have three options:',
    '  1. Call AskUserQuestion to relay the pending question to the user.',
    '  2. Call forge__update_state with the user\'s answer (set state_updates.user_answer).',
    '  3. Call forge__abandon_workflow with a meaningful reason if the workflow no longer applies.',
    ``,
    'Do NOT silently bypass the workflow. The audit trail is how the team learns when workflows misroute.',
  ];
  return lines.join('\n');
}

function buildStepPermissionDenyReason(state, toolName, category) {
  const skill = state.current_step_skill || state.current_skill || 'the active step';
  const allowed = (state.current_step_tools || []).join(', ') || '(none)';
  const lines = [
    `Forge workflow step "${skill}" does not allow tool category "${category}".`,
    `Tool "${toolName}" is in category "${category}". This step's allowed categories: ${allowed}.`,
    ``,
    'Likely you are trying to do work that belongs to a later step. Options:',
    '  1. Continue the current step and call forge__update_state to advance — the next step may allow this tool.',
    '  2. Call AskUserQuestion if the user needs to make a decision before this step can complete.',
    '  3. Call forge__abandon_workflow with a meaningful reason if the workflow no longer applies.',
    ``,
    'Do NOT silently bypass the workflow. The audit trail is how the team learns when workflows misroute.',
  ];
  return lines.join('\n');
}

// -- Main -------------------------------------------------------------------

async function main() {
  let event = {};
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  try {
    event = JSON.parse(input);
  } catch {
    return; // Malformed input — fail open
  }

  const toolName = event.tool_name || '';
  if (!toolName) return; // Nothing to gate

  // Scope state to this Claude Code session.
  const sessionState = sessionStateModule.forSession(event.session_id);
  const state = sessionState.read();
  if (!state.active_workflow) return; // No workflow active — allow

  const bare = bareName(toolName);

  // Universals always pass — Forge orchestration, AskUserQuestion, read-only.
  if (isUniversallyAllowed(bare)) return;

  // Layer 1: CHECKPOINT enforcement.
  if (state.pending_checkpoint) {
    process.stdout.write(JSON.stringify({
      decision: 'deny',
      reason: buildCheckpointDenyReason(state, bare),
    }));
    return;
  }

  // Layer 2: per-step tool_permissions enforcement.
  if (Array.isArray(state.current_step_tools) && state.current_step_tools.length > 0) {
    const category = categoryFor(bare);
    if (category && !state.current_step_tools.includes(category)) {
      process.stdout.write(JSON.stringify({
        decision: 'deny',
        reason: buildStepPermissionDenyReason(state, bare, category),
      }));
      return;
    }
  }

  // Otherwise allow — no checkpoint pin, no per-step allowlist (or tool is
  // not in any known category, or its category is allowed).
}

main().catch(() => {
  // Fail open — never block the user's tool call due to a hook error.
  // The rest of the enforcement (workflow-tracker logging, audit trail)
  // continues to operate even if this hook is partially broken.
});
