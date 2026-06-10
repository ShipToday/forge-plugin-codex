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
 * Token stamping (SHI-724): for forge__update_state in any TRACKED session
 * (an active workflow, or a logged/linked observer session) this hook ALSO
 * rewrites the tool input via `updatedInput`, stamping a cumulative token
 * snapshot onto state_updates.token_usage. This is the client-side analog of
 * the server-side duration_ms stamp — the Forge server makes no Anthropic
 * calls so it cannot measure token usage, and a PreToolUse rewrite lands the
 * tokens on the SAME call that already records duration. The orchestrator
 * persists them as a separate token_usage row (src/orchestrator.js). It
 * replaces the fragile legacy path where the model had to RELAY the Stop-hook
 * directive's token_usage by hand (which it silently dropped — leaving null
 * token columns on ad_hoc/checkpoint rows).
 *
 * Hook contract: PreToolUse hooks may emit a JSON payload on stdout —
 * `{decision: "deny", reason: "..."}` to refuse the tool, or
 * `{hookSpecificOutput: {permissionDecision: "allow", updatedInput: {…}}}`
 * to rewrite the tool input (Claude Code >= 2.0.10). Anything else (silence,
 * exit code 0) allows the call to proceed unchanged.
 *
 * ── Codex build localization ──
 * Codex honors `updatedInput` rewrites from rust-v0.131.0 (PR #20527) — and
 * unlike Claude Code < 2.0.10, OLDER Codex builds do NOT silently ignore the
 * field: they log a hook-failed error and run the original call. Both
 * rewrite sites below are therefore gated by codexSupportsUpdatedInput(), a
 * cached `codex --version` probe. All other logic is identical to the
 * Claude Code source — keep it that way on every plugin sync
 * (/shiptoday-plugin).
 *
 * @see plugin/hooks/token-usage.cjs for the transcript-parsing capture adapters
 * @see plugin/hooks/workflow-tracker.cjs for the state writes this hook reads
 * @see plugin/hooks/session-state.cjs for state management
 * @see src/skills/permissions.js for the server-side category source of truth
 */

'use strict';

const sessionStateModule = require('./session-state.cjs');
const { resolveSessionRecords, captureTokenUsageFromResolved } = require('./token-usage.cjs');
const { activeMsFromEvent, activeMsFromResolved } = require('./active-time.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// -- Codex updatedInput version gate -----------------------------------------
// Codex supports PreToolUse `hookSpecificOutput.updatedInput` rewrites from
// rust-v0.131.0. Older builds treat the payload as a hook failure — a noisy
// per-call error — so the stamp sites below bail out unless the installed
// Codex clears the floor. The hook stdin carries no version field, so the
// verdict comes from a `codex --version` probe cached on disk for 24h:
// PreToolUse fires on every tool call and a per-call spawn is unacceptable.
// Probe failure caches `false` (quiet no-capture) — fail toward silence,
// never toward per-call hook errors; an upgrade is picked up at the next
// cache expiry. With the rewrite gated off, token capture degrades to the
// best-effort Stop-hook checkpoint relay (stop-observer.cjs), which works on
// every Codex version.

const CODEX_UPDATED_INPUT_FLOOR = [0, 131, 0]; // rust-v0.131.0 (2026-05-18)
const CODEX_VERSION_CACHE = path.join(os.tmpdir(), 'forge-observer', 'codex-version.json');
const CODEX_VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function codexSupportsUpdatedInput() {
  try {
    const cached = JSON.parse(fs.readFileSync(CODEX_VERSION_CACHE, 'utf8'));
    if (cached && typeof cached.supported === 'boolean'
        && Number.isFinite(cached.probed_at)
        && Date.now() - cached.probed_at < CODEX_VERSION_CACHE_TTL_MS) {
      return cached.supported;
    }
  } catch {
    // Cache miss / corrupt — re-probe below.
  }
  let supported = false;
  let version = null;
  try {
    // shell:true on Windows so the `codex.cmd` npm shim resolves; the
    // arguments are a fixed literal, so there is no injection surface.
    const out = String(execFileSync('codex', ['--version'], {
      timeout: 2000,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (m) {
      version = `${m[1]}.${m[2]}.${m[3]}`;
      const v = [Number(m[1]), Number(m[2]), Number(m[3])];
      const f = CODEX_UPDATED_INPUT_FLOOR;
      supported = v[0] !== f[0] ? v[0] > f[0] : v[1] !== f[1] ? v[1] > f[1] : v[2] >= f[2];
    }
  } catch {
    supported = false; // probe failed (codex not on PATH / timeout)
  }
  try {
    fs.mkdirSync(path.dirname(CODEX_VERSION_CACHE), { recursive: true });
    fs.writeFileSync(
      CODEX_VERSION_CACHE,
      JSON.stringify({ supported, version, probed_at: Date.now() }),
      'utf8'
    );
  } catch {
    // Best-effort cache — worst case the next call probes again.
  }
  return supported;
}

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
  // Non-greedy server segment so server names containing UNDERSCORES are
  // stripped too — not just hyphenated connector UUIDs. The Forge plugin
  // exposes tools under `mcp__plugin_forge_forge__forge__update_state` (and
  // Linear under `mcp__plugin_linear_linear__…`); the old
  // `mcp__[^_]+(?:-[^_]+)*__` pattern stopped at the first underscore and
  // failed to strip the prefix, so `bare` stayed the full name → forge tools
  // were neither token-stamped nor recognized as universally-allowed (they
  // would be DENIED mid-checkpoint). The first `__` after `mcp__` is the
  // server/tool delimiter; the tool itself may contain `__`
  // (e.g. `forge__update_state`), which the greedy trailing group preserves.
  const m = toolName.match(/^mcp__.+?__(.+)$/);
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
  const bare = bareName(toolName);

  // SHI-724: stamp cumulative token usage onto Forge's own
  // forge__update_state call — the deterministic analog of the server-side
  // duration_ms stamp. Fires for ANY tracked session: an active workflow
  // (per-step capture) OR a logged/linked observer session (its ad_hoc and
  // periodic-checkpoint update_state calls). Runs BEFORE the active_workflow
  // guard below, because observer-checkpoint calls happen with
  // active_workflow=false (the observe_session workflow has already
  // completed), and the legacy #657 path — which relies on the MODEL relaying
  // the Stop-hook directive's token_usage — drops them (observed: an ad_hoc
  // session whose model never relayed, leaving null token columns). The
  // updatedInput rewrite makes capture independent of the model.
  //
  // captureTokenUsage parses the local transcript (main + sub-agent files)
  // into a CUMULATIVE raw-component snapshot; the orchestrator writes it to a
  // separate `event_type: token_usage` row keyed by the Forge conversation
  // (the workflow conversation, or the observe_session conversation for
  // observer sessions) with work_item_key nullable — linked AND unlinked both
  // captured. The snapshot is cumulative and the read side takes
  // latest-per-session, so re-stamping never double-counts and a skipped call
  // never under-counts.
  //
  // updatedInput requires Claude Code >= 2.0.10; older clients ignore it
  // (graceful no-capture, no breakage). Fail-soft: any parse/IO error leaves
  // the call unchanged — token capture must never block forge__update_state.
  const trackedSession = state.active_workflow
    || state.status === 'logged' || state.status === 'linked';
  if (bare === 'forge__update_state' && trackedSession) {
    // Codex build: the stamp is delivered via updatedInput, which Codex only
    // honors from rust-v0.131.0 — bail BEFORE any capture work (rollout
    // parsing is wasted when the rewrite can't be delivered). See the gate's
    // comment block above.
    if (!codexSupportsUpdatedInput()) return;
    try {
      let toolInput = event.tool_input || {};
      if (typeof toolInput === 'string') toolInput = JSON.parse(toolInput);
      const stateUpdates = { ...(toolInput.state_updates || {}) };
      // Resolve the session log ONCE per invocation — token capture and the
      // active-time stamp below consume the same parsed records instead of
      // each re-reading multi-MiB transcript files (review #10).
      const resolved = resolveSessionRecords(event);
      const tokens = captureTokenUsageFromResolved(resolved);
      // Track whether we enriched state_updates at all. Three independent stamps
      // can fire on the SAME tracked update_state, and the rewrite must be
      // emitted if ANY did:
      //   - token_usage (only when capture succeeds),
      //   - client_session_id (the Claude coding-session id, stamped on EVERY
      //     tracked update_state so the read side can collapse this session's
      //     rows across all its Forge conversations — this workflow + the
      //     observer — instead of counting one per conversation), and
      //   - duration_ms (R1 idle-excluded active time; active-workflow steps only).
      let changed = false;
      // Never clobber a token_usage the caller already set (defensive — the
      // model does not set it today, but a future client might).
      if (tokens && !stateUpdates.token_usage) {
        // SHI-724 Issue 2: stamp one component bag PER model so the orchestrator
        // writes a per-model token_usage row — a delegated session (Opus main +
        // Sonnet sub-agent) is then weighted per model at read. Fall back to the
        // combined single bag if an adapter lacks byModel.
        const models = Array.isArray(tokens.byModel) && tokens.byModel.length
          ? tokens.byModel
          : [tokens];
        stateUpdates.token_usage = models.map((m) => ({
          input: m.input,
          cache_read: m.cacheRead,
          cache_creation_5m: m.cacheCreation5m,
          cache_creation_1h: m.cacheCreation1h,
          cache_creation_flat: m.cacheCreationFlat,
          output: m.output,
          model_name: m.modelName,
        }));
        changed = true;
      }
      // Stamp the Claude coding-session id on every tracked update_state. Don't
      // clobber an existing one (a future client might set it itself).
      if (!stateUpdates.client_session_id && event.session_id) {
        stateUpdates.client_session_id = event.session_id;
        changed = true;
      }

      // R1 active-time: stamp duration_ms with idle-excluded ACTIVE time for an
      // active-workflow step (window = [step_active_since, now]). The server
      // prefers state_updates.duration_ms over its wall-clock fallback
      // (src/orchestrator.js), so this replaces wall-clock with active time on
      // the SAME call that already carries the tokens — the client-side analog
      // of the server's duration stamp. Scoped to active workflows: observer
      // (logged/linked) checkpoint duration is owned by the stop-observer
      // directive, so we don't double-source it here. `== null` guards both
      // null and undefined so a caller-set value (incl. 0) is never clobbered;
      // activeMsFromEvent returns null when no session log is available (Cursor
      // / unreadable transcript) → we leave the server's wall-clock fallback.
      if (state.active_workflow && state.step_active_since && stateUpdates.duration_ms == null) {
        const activeMs = activeMsFromResolved(resolved, Date.parse(state.step_active_since));
        if (Number.isFinite(activeMs)) {
          stateUpdates.duration_ms = activeMs;
          changed = true;
        }
      }

      // updatedInput REPLACES the tool input (Claude Code does not merge), so
      // echo the complete object back with the enriched state_updates — but only
      // when we added something (token_usage, client_session_id, and/or duration_ms).
      if (changed) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { ...toolInput, state_updates: stateUpdates },
          },
        }));
        return;
      }
    } catch {
      // Fall through — allow the call unchanged.
    }
    return; // forge__update_state is universally allowed regardless.
  }

  // R1 active-time on the ABANDON exit. forge__abandon_workflow carries no
  // state_updates, so without a stamp the server's __abandoned__ audit row
  // falls back to wall-clock (now − stepStartedAt) — and abandon is the exit
  // most correlated with walking away (start a step, pause 3h, come back and
  // abandon → 3h of idle banked as engineering time, the exact inflation R1
  // removes on update_state). Stamp the idle-excluded active time of the
  // in-flight step as a top-level `duration_ms` input field; the tool handler
  // threads it into the audit row (src/tools/abandon-workflow.js). Same
  // guards as the update_state stamp: never clobber a caller-set value, and
  // a null capture (Cursor / unreadable transcript) leaves the call unchanged
  // so the server keeps its wall-clock fallback.
  if (bare === 'forge__abandon_workflow' && state.active_workflow && state.step_active_since) {
    if (!codexSupportsUpdatedInput()) return; // version-gated — see gate above
    try {
      let toolInput = event.tool_input || {};
      if (typeof toolInput === 'string') toolInput = JSON.parse(toolInput);
      if (toolInput.duration_ms == null) {
        const activeMs = activeMsFromEvent(event, Date.parse(state.step_active_since));
        if (Number.isFinite(activeMs)) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: { ...toolInput, duration_ms: activeMs },
            },
          }));
          return;
        }
      }
    } catch {
      // Fall through — allow the call unchanged.
    }
    return; // abandon_workflow is universally allowed regardless.
  }

  // Beyond token stamping (above), the guard layers below apply only while a
  // workflow is active. A logged/linked observer session that reaches here on
  // a non-update_state tool has no per-step allowlist to enforce.
  if (!state.active_workflow) return; // No active workflow — allow.

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
