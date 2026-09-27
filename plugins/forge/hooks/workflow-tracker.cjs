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
const { stateCall } = require('./hook-input.cjs');
const { attempted } = require('./checkpoint-claim.cjs');
const { normalizeToolEvent, wrappedForgeCall } = require('./tool-event.cjs');

// -- Tool name patterns (MCP names include dynamic server UUIDs) --------------

const WORKFLOW_START_PATTERNS = [
  'forge__start_workflow',
];

const WORKFLOW_STATE_PATTERN = 'forge__update_state';
const WORKFLOW_ABANDON_PATTERN = 'forge__abandon_workflow';
const WORKFLOW_STATE_READ_PATTERN = 'forge__get_workflow_state';
// The host question tools whose PostToolUse proves a pinned question reached
// the user: Claude Code's AskUserQuestion, Codex's request_user_input.
const QUESTION_TOOL_RE = /(?:^|__|\.)(?:AskUserQuestion|request_user_input(?:_async)?)$/;

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
 *
 * Unlike must-display.cjs, this does NOT follow a bare file path to a reply
 * the host saved to disk. must-display only turns a file into a one-line
 * breadcrumb; here the text becomes authorization state (allowlist, write
 * lock, CHECKPOINT pin), and a path is honoured wherever it points — nothing
 * confines it to the host's own tool-results directory, whose location and
 * hook-payload shape are not verified. A replaced reply is instead handled by
 * the server keeping replies under REPLY_BUDGET_BYTES and by the
 * get_workflow_state re-sync below.
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
 * Check if a forge__abandon_workflow response indicates a successful abandon.
 * Successful abandon responses begin with "**Workflow abandoned**" — the
 * fixed marker rendered by the server.
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
 *   - Legacy post-step confirmation-gate CHECKPOINT, from older servers
 *     that still had the gate (`"<step>" paused at confirmation gate`):
 *     kept so this plugin still pins against an older server. The orchestrator paused
 *     after the step completed, waiting for the user to confirm advance.
 *
 * Both are rendered by the server and both should keep
 * the workflow-guard locked to ask_user / forge__update_state /
 * forge__abandon_workflow until the AI resolves the gate.
 *
 * Returns the step name that's pinned, or null if the response does
 * not carry a CHECKPOINT marker.
 *
 * Callers pass the reply's own marker line, never the whole reply: its body can
 * quote this marker (see parseReplyHeader).
 */
function extractPendingCheckpointStep(response) {
  if (!response) return null;
  const text = responseText(response);
  const match = text.match(/\*\*CHECKPOINT\*\*\s+—\s+"([^"]+)"\s+(?:awaiting user input|question unresolved|report complete; optional follow-up|paused at confirmation gate)/);
  return match ? match[1] : null;
}

// Server question ids are `q_<uuid>`.
const QUESTION_ID = 'q_[A-Za-z0-9-]{1,80}';
const POSTBACK_RE = new RegExp(`"question_id":"(${QUESTION_ID})","step_token":"[^"\\n]{0,200}","(gate_answer|user_answer)":`, 'g');
const BOLD_QUESTION_RE = new RegExp(`\\*\\*Question ID\\*\\*:\\s*\`?(${QUESTION_ID})\`?`, 'gi');
const PLAIN_QUESTION_RE = new RegExp(`(?:^|\\n)Question ID:\\s*(${QUESTION_ID})`, 'g');
const RESPONSE_FIELD_RE = /\*\*Response Field\*\*:\s*`?(gate_answer|user_answer|question_response)`?/gi;

function lastMatch(text, re) {
  let last = null;
  for (const match of text.matchAll(re)) last = match;
  return last;
}

function extractPendingCheckpointMetadata(response) {
  const text = responseText(response);
  // The server's own answer line is the reliable source. Every
  // question CHECKPOINT ends with `state_updates: {"question_id":…,
  // "step_token":…,"<field>":…}`, while the bold `**Question ID**` /
  // `**Response Field**` pair only appears on the PR-revision path. Reading
  // just the bold pair left both fields null on every relayed question, and
  // the guard's advice fell back to `gate_answer` — the wrong field.
  // The id is repeated into guard denials and prompt context, so it must look
  // like a server id, and the LAST match wins: the server's own lines come
  // after any findings or quoted text a reply carries.
  const postback = lastMatch(text, POSTBACK_RE);
  const boldQuestion = lastMatch(text, BOLD_QUESTION_RE);
  const plainQuestion = lastMatch(text, PLAIN_QUESTION_RE);
  const field = lastMatch(text, RESPONSE_FIELD_RE);
  return {
    questionId: postback?.[1] || boldQuestion?.[1] || plainQuestion?.[1] || null,
    responseField: postback?.[2] || field?.[1] || null,
  };
}

/**
 * Re-sync the CHECKPOINT pin from a forge__get_workflow_state reply.
 *
 * The pin is otherwise released only when an update_state reply carries a
 * RE-ENTRY / NEXT STEP marker. When the host replaced that reply (an oversized
 * result saved to a file), the marker never arrived and the guard stayed
 * locked. get_workflow_state is the designed recovery channel, the guard
 * always allows it, and its header is the server's own view of the run: a
 * CHECKPOINT header means a question or gate is still pending (keep or set the
 * pin), a NEXT STEP header means none is (release it and load the step's
 * tool permissions), and a RUN ENDED header means the run is over — completed,
 * stopped or abandoned — so everything its lost final reply would have
 * released is released. Anything else — an error, another conversation —
 * changes nothing, so state can only be released by a positive server signal.
 */
// The status line of a recovery snapshot for a run that is over.
const RUN_ENDED_LINE = /^\*\*RUN ENDED\*\*\s+—/;

// get_workflow_state names the step by its composite id (`skill__N`); the rest
// of the plugin keeps the bare skill id that update_state's headers carry, and
// stop-observer replays it as `completed_step`. Mirrors how the
// server splits a composite id.
function bareStepId(stepId) {
  const index = stepId.lastIndexOf('__');
  return index === -1 ? stepId : stepId.slice(0, index);
}

function expiryMetadata(text) {
  const match = text.match(/^\*\*Workflow Expiry\*\*: (.+)$/m);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    if (Number.isInteger(value.days) && value.days >= 1 && value.days <= 7
      && ['setting', 'default', 'fallback'].includes(value.source)) return { days: value.days, source: value.source };
  } catch { /* malformed metadata is not recovery authority */ }
  return false;
}

function startHeader(response) {
  const lines = trustedText(response).split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('**Conversation ID**:'));
  if (start < 0) return '';
  let end = start;
  while (end < lines.length && lines[end].trim()) end++;
  return lines.slice(start, end).join('\n');
}

function resyncFromStateRead(sessionState, toolResponse, toolInput) {
  const state = sessionState.read();
  if (toolResponse?.isError || toolResponse?.is_error) return;
  if (typeof toolInput === 'string') { try { toolInput = JSON.parse(toolInput); } catch { return; } }
  const requested = toolInput?.conversation_id;
  const lines = responseText(toolResponse).split('\n');
  const start = lines.findIndex((line) => line.startsWith('Workflow state for conversation `'));
  const conversation = start === -1 ? null : lines[start].match(/^Workflow state for conversation `([^`]+)`/);
  if (!conversation || (requested && conversation[1] !== requested)) return;
  if (state.active_workflow && conversation[1] !== state.conversation_id && !state.workflow_binding_pending) return;
  if ((!state.active_workflow || state.workflow_binding_pending) && conversation[1] !== requested) return;

  // Read the status only from the reply's own header block — the status line
  // and its metadata lines, up to the first blank line. The recovered findings
  // and the step body follow it and can quote a CHECKPOINT header; matching
  // those would re-pin a step the server just reported as free.
  let index = start + 1;
  while (index < lines.length && !lines[index].trim()) index++;
  const header = [];
  while (index < lines.length && lines[index].trim()) header.push(lines[index++]);
  const statusLine = header[0] || '';
  const headerText = header.join('\n');
  const expiry = expiryMetadata(headerText);
  const token = headerText.match(/^\*\*Step Token\*\*: `([^`]+)`/m)?.[1];
  if (expiry === false) return;

  // The run is over, and its final reply (or the stop or abandon reply) never
  // arrived here: the recovery hold it left would otherwise wait forever on a
  // step that no longer exists. Release the run exactly as the completion
  // branch in main() would have.
  if (RUN_ENDED_LINE.test(statusLine)) {
    sessionState.write({
      // Codex: the turn-cadence baseline moves with the time baseline below.
      last_checkpoint_turn: state.turn_count || 0,
      active_workflow: false,
      observer_blocked: true,
      conversation_id: null,
      current_skill: null,
      pending_checkpoint: false,
      pending_checkpoint_step: null,
      pending_checkpoint_at: null,
      pending_checkpoint_question_id: null,
      pending_checkpoint_response_field: null,
      pending_checkpoint_asked_at: null,
      pending_checkpoint_user_turn_at: null,
      current_step_tools: null,
      write_lock: null,
      current_step_skill: null,
      step_resync_required: false,
      workflow_recovery_required: false,
      workflow_binding_pending: false,
      workflow_expiry: null,
      current_step_token: null,
      last_checkpoint_at: new Date().toISOString(),
    });
    return;
  }

  const pendingStep = extractPendingCheckpointStep(statusLine);
  // New bindings and modern snapshots need a complete token-bearing header.
  if ((!state.active_workflow || state.workflow_recovery_required || expiry) && !token) return;
  const recovered = {
    active_workflow: true, conversation_id: conversation[1],
    workflow_activity_at: new Date().toISOString(),
    workflow_recovery_required: false, step_resync_required: false,
    workflow_binding_pending: false,
    ...(token ? { current_step_token: token } : {}),
    ...(expiry ? { workflow_expiry: expiry } : {}),
  };
  if (pendingStep) {
    const metadata = extractPendingCheckpointMetadata(toolResponse);
    // A recovery that re-serves the question already pinned keeps the pin time
    // and its evidence; one that reveals a different question (or the first
    // sight of one after a lost reply) starts over, so the answer needs a
    // fresh ask.
    const sameQuestion = state.pending_checkpoint === true
      && (!metadata.questionId || !state.pending_checkpoint_question_id || metadata.questionId === state.pending_checkpoint_question_id);
    sessionState.write({
      ...recovered,
      current_step_skill: bareStepId(pendingStep),
      current_step_tools: extractToolPermissions(headerText),
      write_lock: extractWriteLock(headerText) || state.write_lock,
      pending_checkpoint: true,
      pending_checkpoint_step: bareStepId(pendingStep),
      pending_checkpoint_at: sameQuestion && state.pending_checkpoint_at ? state.pending_checkpoint_at : new Date().toISOString(),
      pending_checkpoint_question_id: metadata.questionId || state.pending_checkpoint_question_id || null,
      pending_checkpoint_response_field: metadata.responseField || state.pending_checkpoint_response_field || null,
      ...(sameQuestion ? {} : { pending_checkpoint_asked_at: null, pending_checkpoint_user_turn_at: null }),
    });
    return;
  }

  const nextStep = statusLine.match(/^\*\*NEXT STEP\*\*:\s*"([^"]+)"/);
  if (!nextStep) return;
  sessionState.write({
    ...recovered,
    pending_checkpoint: false,
    pending_checkpoint_step: null,
    pending_checkpoint_at: null,
    pending_checkpoint_question_id: null,
    pending_checkpoint_response_field: null,
    pending_checkpoint_asked_at: null,
    pending_checkpoint_user_turn_at: null,
    current_step_tools: extractToolPermissions(header.join('\n')),
    current_step_skill: bareStepId(nextStep[1]),
    // The lock travels with the step, so a recovery that restores the step
    // must restore the lock with it. Leaving it behind fails OPEN — the guard
    // reads a missing lock as unlocked and allows every write tool for the
    // rest of an Always-asks step, with no approval recorded. The reverse
    // skew is just as wrong: a stale `on` blocks writes the user approved.
    write_lock: extractWriteLock(header.join('\n')),
    // The step is known again, with its own allowlist and lock. (A CHECKPOINT
    // recovery above leaves an unverified step as it is: the pin holds every
    // write, and the RE-ENTRY that releases it carries the step's header.)
    step_resync_required: false,
  });
}

// -- update_state reply header ------------------------------------------------

// The lines an update_state reply's header is made of.
const STEP_STATUS_LINE = /^Step "[^"]+" completed\. \((\d+)\/(\d+)\)\s*$/;
// A standalone skill's completion line, as servers once led with it.
const SKILL_STATUS_LINE = /^Skill \*\*\w+\*\* completed\.\s*$/;
const MARKER_LINE = /^\*\*(?:(NEXT STEP)\*\*:\s*|(CHECKPOINT|RE-ENTRY)\*\*\s+—\s+)"([^"]+)"/;
// `Write Lock` belongs here with the rest: the server renders it between Tool
// Permissions and Step Token, so leaving it out
// ended the header at that line — the lock went unread and the Step Token
// after it fell into the body.
const METADATA_LINE = /^\*\*(?:Idempotent Retry|Model Routing|Tool Permissions|Write Lock|Step Token|Workflow Expiry|Question ID|Response Field)\*\*:/;
const DISPLAY_BLOCK_OPEN = /^(?:> \*\*Relay to the user\*\*|<<<FORGE_DISPLAY_VERBATIM\b)/;
const DISPLAY_BLOCK_CLOSE = '<<<END FORGE_DISPLAY_VERBATIM>>>';
// The caption the server puts above a finished step's `## Findings` block.
const FINDINGS_CAPTION = /^_What \*\*.*\*\* found — .*_\s*$/;
// The step envelope's opening sentinel. Everything after it is the step
// body, which is free text.
const ENVELOPE_OPEN = /^<<<FORGE_NEXT_STEP\b/;

function isStatusLine(line) {
  return STEP_STATUS_LINE.test(line) || SKILL_STATUS_LINE.test(line);
}

// The stray-gate re-serve opens with this line, above its **NEXT STEP** marker.
const IDEMPOTENT_RETRY_LINE = /^\*\*Idempotent Retry\*\*:/;

function startsHeader(line) {
  return isStatusLine(line) || MARKER_LINE.test(line) || IDEMPOTENT_RETRY_LINE.test(line);
}

/**
 * Skip the must-display blocks that start at `start`, as the server
 * renders them: an optional
 * `## Findings` heading, the `> **Relay to the user**` directive, the copy
 * between the FORGE_DISPLAY_VERBATIM sentinels and, for findings, a truncation
 * note and a `---` rule. With `caption`, a finished step's findings caption may
 * precede a block too. Returns the index of the first line after them — the
 * first non-blank line at or after `start` when there is nothing to skip.
 *
 * An unclosed block is a truncated reply or a body line that merely looks like
 * an opening sentinel. Skipping to the end of the reply there discarded it
 * whole — no header was read, so a finished run stayed active and a checkpoint
 * went unpinned. Give the line back instead and let the header logic decide:
 * the opening line is not header-shaped, so nothing is adopted from the body,
 * and a wrapped reply can still find its header further down.
 */
function skipDisplayBlocks(lines, start, { caption = false } = {}) {
  const isFiller = (line) => !line.trim() || line.trim() === '---' || line.startsWith('[…content truncated');
  let index = start;
  while (index < lines.length && !lines[index].trim()) index++;
  for (;;) {
    let open = index;
    if (caption && FINDINGS_CAPTION.test(lines[open] || '')) {
      open++;
      while (open < lines.length && !lines[open].trim()) open++;
    }
    if (/^## Findings\b/.test(lines[open] || '')) {
      open++;
      while (open < lines.length && !lines[open].trim()) open++;
    }
    if (!DISPLAY_BLOCK_OPEN.test(lines[open] || '')) return index;
    const close = lines.findIndex((line, i) => i > open && line.trim() === DISPLAY_BLOCK_CLOSE);
    if (close === -1) return index;
    index = close + 1;
    while (index < lines.length && isFiller(lines[index])) index++;
  }
}

function skipLeadingDisplayBlocks(lines) {
  return skipDisplayBlocks(lines, 0);
}

/**
 * Where an older server's advance resumes its header after the finished
 * step's findings, or -1 when `index` does not start such a region.
 *
 * Some older servers rendered a finished step's
 * findings BETWEEN the status line and `**NEXT STEP**`. Reading stopped at
 * the findings caption, so the marker was never seen: the next step's tool
 * permissions, write lock and active-time boundary went unrecorded, and an
 * Always-asks step's lock was never enforced. Current servers render the
 * findings after the header; this reads the old layout too.
 *
 * Only a run that goes on qualifies — a status line counting fewer steps than
 * the run has. A completion carries no marker in any layout, so there is
 * nothing to find past its findings, and looking would let its recap stand in.
 *
 * The findings are display content, so what follows them is adopted only when
 * it is unambiguous: the region must end exactly at a header line, and exactly
 * one marker line may stand between it and the step envelope. The first
 * servers with this layout did not yet neutralize sentinels inside findings,
 * so a finding could close its block early and plant a header of its own; the
 * real header still follows, and two markers mean the reply cannot be trusted.
 *
 * The marker count stops at the step envelope, so a planted header followed by
 * a planted envelope would hide the real header from it. The reply's own
 * boundaries are therefore checked first: a server reply carries exactly one
 * step envelope, and its display sentinels pair up. A finding that closed its
 * block early must add a second envelope to hide the real header, or leave a
 * sentinel unmatched — either way the reply is refused. Refusing leaves it
 * read as before this change.
 */
function findingsRegionEnd(lines, index, status) {
  const counts = status.match(STEP_STATUS_LINE);
  if (!counts || counts[1] === counts[2]) return -1;
  if (lines.filter((line) => ENVELOPE_OPEN.test(line)).length !== 1) return -1;
  const opens = lines.filter((line) => /^<<<FORGE_DISPLAY_VERBATIM\b/.test(line)).length;
  const closes = lines.filter((line) => line.trim() === DISPLAY_BLOCK_CLOSE).length;
  if (opens !== closes) return -1;
  const end = skipDisplayBlocks(lines, index, { caption: true });
  if (end === index || end >= lines.length) return -1;
  if (!MARKER_LINE.test(lines[end]) && !METADATA_LINE.test(lines[end])) return -1;
  let markers = 0;
  for (let i = end; i < lines.length && !ENVELOPE_OPEN.test(lines[i]); i++) {
    if (MARKER_LINE.test(lines[i])) markers++;
  }
  return markers === 1 ? end : -1;
}

/**
 * Read the header a forge__update_state reply leads with. Every pin, release,
 * advance and completion decision is made from it, never from the body.
 *
 * The server renders each reply as a header, then a body:
 *
 *   advance     Step "<done>" completed. (n/m)
 *               (blank)
 *               [**Idempotent Retry**: …]          only on a replayed advance
 *               **NEXT STEP**: "<step>" — follow the instructions below. …
 *               [**Model Routing**] [**Tool Permissions**] [**Write Lock**] [**Step Token**]
 *               (blank)
 *               [the finished step's findings]     body; older servers put them
 *                                                  above the marker (see below)
 *   reveal      **NEXT STEP**: "<step>" — the workflow's first step … (no status line)
 *               [**Tool Permissions**] [**Write Lock**] [**Step Token**]
 *   RE-ENTRY    **RE-ENTRY** — "<step>" resumed with user answer
 *               (blank)
 *               [**Model Routing**] [**Tool Permissions**] [**Write Lock**] [**Step Token**]
 *   CHECKPOINT  **CHECKPOINT** — "<step>" awaiting user input | paused at confirmation gate
 *                 | report complete; optional follow-up | question unresolved[; PR revision check …]
 *               (blank)
 *               [**Question ID**, **Response Field** (blank)] [**Step Token** (blank)]
 *   complete    Step "<last>" completed. (n/n) — also a gate's "Stop here" and
 *               a standalone skill's (1/1); findings, then the recap, follow
 *   no header   an `Error: …` reply; a duplicate answer with no open question
 *
 * The body is free text: the step envelope, a `## Findings` display block, the
 * question, a recap, org-authored step instructions, the appended Pre-Forge
 * Session Context. Any of it can quote the lines above. Reading the whole reply
 * let a NEXT STEP reply that quoted a CHECKPOINT header pin the guard.
 *
 * The header is the run of status, marker and metadata lines at the top of the
 * reply. It holds at most one status line (its first) and one marker. A blank
 * line may separate the status line from the marker and the marker from its
 * metadata, but once the metadata run has started the next blank line ends the
 * header — otherwise the body's first line joins it whenever it looks like
 * metadata. The first line of any other kind starts the body. It is read after
 * any must-display block the reply leads with: none does today, but that block
 * is copy for the user and can quote a header too.
 *
 * One exception to "the first other line starts the body": some older
 * servers rendered an advance's findings (caption,
 * `## Findings`, relay line, display block, `---`) between its status line and
 * its marker. Stopping there lost the marker, and with it the next step's tool
 * permissions and write lock. When only a status line has been read and the
 * run is not complete, that one region is stepped over and the header read on
 * — never adopted into it, and only when exactly one marker follows before the
 * step envelope (findingsRegionEnd).
 *
 * Behind Codex's functions.exec wrapper the script's own output surrounds the
 * reply, so a log line it printed first can be marker-shaped. There the first
 * STRUCTURED header wins — a marker with the status line or metadata run that
 * belongs to it — and a lone marker-shaped line only stands when nothing
 * structured follows it. A first candidate carrying a status line is the
 * reply's own header and stops the scan outright, so a completion (which has
 * no marker) is never traded for something its body quotes.
 *
 * When the reply has not opened at all — nothing header-shaped led it, because
 * the script printed plain output first — the scan is looking for where the
 * reply BEGINS, so a status line there is its own and ends the search too. A
 * completion carries no marker, so demanding one skipped it and left a finished
 * run locally active and pinned, or handed its step and allowlist to whatever
 * its body quoted. Once a marker has opened a candidate, a later status line is
 * the script's trailing output and stays ineligible.
 *
 * That leaves shapes the wrapper cannot resolve, both turning on a marker with
 * NO metadata — Codex gives no reply boundary to tell a logged echo from the
 * real reply. Its body quoting a structured header reads as an echo followed by
 * that reply; and when plain output preceded it, so the reply never opened, a
 * status line in the script's TRAILING output is still eligible and would be
 * read as a completion. Both need the server to emit a metadata-less marker,
 * and it does not: every CHECKPOINT and RE-ENTRY carries a Step Token.
 *
 * Deciding the second one the other way costs more than it saves. Closing the
 * scan once any marker has been seen would also drop a completion that a
 * marker-shaped LOG line precedes — a shape Codex does produce, and one the
 * wrapper tests pin.
 */
function readHeaderAt(lines, start) {
  const header = [];
  let status = null;
  let marker = null;
  let metadata = false;
  let skippedFindings = false;
  if (startsHeader(lines[start] || '')) {
    for (let index = start; index < lines.length; index++) {
      const line = lines[index];
      // A blank line separates the status line from the marker, and the marker
      // from its metadata run — but once that run has started, the next blank
      // line ends the header. Reading past it let the body's first line in
      // whenever it looked like metadata, so a `**Tool Permissions**` line in a
      // CHECKPOINT body installed its own allowlist.
      if (!line.trim()) {
        if (metadata) break;
        continue;
      }
      const markerMatch = marker ? null : line.match(MARKER_LINE);
      if (!header.length && isStatusLine(line)) status = line;
      else if (markerMatch) marker = markerMatch;
      else if (METADATA_LINE.test(line)) metadata = true;
      else {
        // An older server's advance puts the finished step's findings between
        // the status line and the marker. Step over them — once, and only
        // before anything but the status line has been read — and never into
        // the header: the region's lines are not pushed.
        const resume = !skippedFindings && status && !marker && !metadata
          ? findingsRegionEnd(lines, index, status)
          : -1;
        if (resume === -1) break; // the body starts here
        skippedFindings = true;
        index = resume - 1;
        continue;
      }
      header.push(line);
    }
  }
  return { header, status, marker };
}

/**
 * A header the server itself would render: a marker with the status line or the
 * metadata run that belongs to it. A lone marker-shaped line is what a relayed
 * log echo looks like, so it does not qualify.
 */
function isStructuredHeader({ header, marker }) {
  return !!marker && header.length > 1;
}

function parseReplyHeader(response, { wrapped = false } = {}) {
  const lines = responseText(response).split(/\r?\n/);
  const first = skipLeadingDisplayBlocks(lines);
  let parsed = readHeaderAt(lines, first);

  // Codex functions.exec: the script's own output surrounds the reply, so a log
  // line it printed first can be marker-shaped and take the header's place.
  // Prefer the first STRUCTURED header over such a line — a real reply carries
  // its status line or metadata with it. When nothing structured follows (a
  // minimal reply, a bare completion), the reply's own first header stands.
  //
  // A status line is where a reply starts, so a first candidate that has one is
  // already the reply's own header and the scan must not run: a completion
  // carries no marker, and scanning past it would hand the decision to whatever
  // its body quotes. Later status-only candidates stay ineligible, because
  // those are the script's trailing logs.
  //
  // `unopened` is the case that guard cannot cover: the script printed ordinary
  // output first, so nothing header-shaped led the reply and there is no
  // candidate yet. The scan is then looking for the reply's START, and a status
  // line there is its own header — a completion has no marker, so requiring one
  // walked past it into the body. It is false whenever the reply DID open with
  // a marker, and that is what keeps a trailing `Step "x" completed.` log from
  // recording a live run as complete.
  if (wrapped && !parsed.status && !isStructuredHeader(parsed)) {
    const unopened = !parsed.header.length;
    for (let index = first + 1; index < lines.length; index++) {
      if (!startsHeader(lines[index])) continue;
      const candidate = readHeaderAt(lines, index);
      if (isStructuredHeader(candidate) || (unopened && candidate.status)) {
        parsed = candidate;
        break;
      }
    }
  }

  const { header, status, marker } = parsed;
  const kind = marker ? marker[1] || marker[2] : null;
  const counts = status ? status.match(STEP_STATUS_LINE) : null;
  return {
    marker: kind,
    step: marker ? marker[3] : null,
    pendingCheckpointStep: kind === 'CHECKPOINT' ? extractPendingCheckpointStep(marker.input) : null,
    reentry: kind === 'RE-ENTRY' && /^\*\*RE-ENTRY\*\*\s+—\s+"[^"]+"\s+resumed with user answer/.test(marker.input),
    idempotentRetry: header.some((line) => line.startsWith('**Idempotent Retry**')),
    toolPermissions: extractToolPermissions(header.join('\n')),
    // Read from the header for the same reason the markers are —
    // the write lock is authorization state, and a body that could name a
    // released lock would unlock the guard.
    writeLock: extractWriteLock(header.join('\n')),
    expiry: expiryMetadata(header.join('\n')),
    stepToken: header.join('\n').match(/^\*\*Step Token\*\*: `([^`]+)`/m)?.[1],
    // A marker means the run goes on. Without one, the status line completes
    // the run when it counts the last step, or when it is a skill's.
    complete: !kind && !!status && (!counts || counts[1] === counts[2]),
  };
}

/**
 * A reply's AUTHORITATIVE header — the only region a marker may be read from.
 *
 * Why this exists: a completed step's findings are model-supplied
 * (`state_updates.display_text`) and the orchestrator renders them ABOVE its
 * own marker lines. Matching markers across the whole reply therefore let a
 * forged line outrank the real one — and because findings routinely summarize
 * fetched tracker or PR content, anyone who can comment on the work item under
 * review could plant it. Display state must never become authorization state.
 *
 * Model-supplied content is always delivered inside a
 * `<<<FORGE_DISPLAY_VERBATIM …>>>` block, so removing those blocks removes the
 * whole attack surface while leaving every reply shape intact. It deliberately
 * does NOT narrow to the marker block itself: the status line is separated
 * from the marker lines by a blank line on RE-ENTRY and CHECKPOINT replies, so
 * a "contiguous run" reading would silently drop the permissions those replies
 * legitimately carry.
 *
 * A forged CLOSING sentinel inside the text would end a block early and let
 * the rest escape, so an unbalanced count is treated as hostile and everything
 * from the first opening to the last close is dropped. The server also strips
 * sentinels and marker prefixes out of `display_text`; an older plugin against
 * a newer server is covered by that half alone, and this half covers a newer
 * plugin against an older server. Neither relies on the other.
 */
const DISPLAY_VERBATIM_BLOCK = /<<<FORGE_DISPLAY_VERBATIM[^\n>]*>>>[\s\S]*?<<<END FORGE_DISPLAY_VERBATIM>>>/g;
const DISPLAY_VERBATIM_OPEN = /<<<FORGE_DISPLAY_VERBATIM/g;
const DISPLAY_VERBATIM_CLOSE = /<<<END FORGE_DISPLAY_VERBATIM>>>/g;

function trustedText(response) {
  if (!response) return '';
  const text = responseText(response);
  const opens = (text.match(DISPLAY_VERBATIM_OPEN) || []).length;
  const closes = (text.match(DISPLAY_VERBATIM_CLOSE) || []).length;
  if (opens !== closes) {
    const first = text.indexOf('<<<FORGE_DISPLAY_VERBATIM');
    const last = text.lastIndexOf('<<<END FORGE_DISPLAY_VERBATIM>>>');
    if (first >= 0 && last > first) {
      return text.slice(0, first) + text.slice(last + '<<<END FORGE_DISPLAY_VERBATIM>>>'.length);
    }
    if (first >= 0) return text.slice(0, first);
  }
  return text.replace(DISPLAY_VERBATIM_BLOCK, '');
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
  const match = trustedText(response).match(/\*\*Tool Permissions\*\*:\s*([^\n]+)/);
  if (!match) return null;
  return match[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract the write lock the server publishes as one line:
 *
 *   **Write Lock**: on — "<step id>" is set to Always asks: …
 *   **Write Lock**: released — "<step id>" write plan approved (<id>)
 *
 * Returns `{ state, step_id }` — or null when the line is absent, which is
 * what an older server sends. Null means "no lock known", and the guard
 * treats that as unlocked: a plugin newer than its server must not start
 * refusing writes nothing told it to refuse.
 *
 * On an update_state reply the caller passes the reply's HEADER, never the
 * whole reply (parseReplyHeader) — a body naming a released lock would
 * otherwise unlock the guard, the same reason every marker is read from the
 * header alone.
 */
function extractWriteLock(response) {
  if (!response) return null;
  const match = trustedText(response).match(/\*\*Write Lock\*\*:\s*(on|released)\s+—\s+"([^"]+)"/);
  if (!match) return null;
  return { state: match[1], step_id: match[2] };
}

/**
 * Extract the active step's bare skill_id from a start_workflow response.
 * Tries the NEXT STEP, RE-ENTRY, and CHECKPOINT markers in that order.
 * Returns null if none match. An update_state reply takes its step from its
 * header instead (parseReplyHeader).
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

// Fallback map from session_observer outcome values to local session status,
// used only when the payload carries no valid `final_session_state.status`
// (older skill payloads). The AUTHORITATIVE source is the skill's declared
// `final_session_state.status` — see extractObserverEvent. These are the
// outcomes carried on a normal `event_type: "observation_outcome"` payload —
// the user engaged with the nudge.
//
// "linked"/"created" are intentionally ABSENT here: they have no fallback
// status because the declared `final_session_state.status` ("linked") now
// covers them. Before that was honoured, a "linked" outcome that did NOT chain
// a follow-up workflow (follow_up: null — linking to an already-complete item)
// left status null and stop-observer.cjs re-fired the nudge every turn.
//
// The org-disabled gate is deliberately NOT in this map. It arrives as
// outcome "observation_disabled" with event_type "observation_skipped" (so
// the orchestrator suppresses the audit row via the server's gated-completion
// path) and is handled separately by extractObservationGate below. It must NOT map
// to a tracking status like "logged": a disabled org is not tracked, and a
// "logged" status would make stop-observer.cjs fire periodic engineering-time
// checkpoints for it. The only thing the gate writes is the per-session +
// cross-session `forge_observation_enabled: false` cache flag.
const OUTCOME_TO_STATUS = {
  ad_hoc: 'logged',
  snoozed: 'snoozed',
  dismissed: 'dismissed',
  // A SOFT decline. Distinct from `dismissed`, which stays
  // terminal. Mapped to the `snoozed` status because both planes already
  // speak that vocabulary end to end — the re-fire branch in
  // stop-observer.cjs and the wake check in prompt-router.cjs both read it.
  // Introducing a new status value instead would have to cross the
  // schema-free final_session_state boundary, where the validation below is
  // ONE-DIRECTIONAL: an unrecognised value is silently dropped to this map
  // rather than raising, so the mistake would never surface. The two
  // outcomes stay separable in the audit trail via `outcome`, which is what
  // AC3 actually needs; only the local session STATUS is shared.
  declined_for_now: 'snoozed',
};

// The tracking statuses stop-observer.cjs recognises. A skill-declared
// `final_session_state.status` is validated against this set before it is
// persisted, so a malformed/unknown value can't wedge the checkpoint/nudge
// logic — it falls back to the outcome mapping instead.
const VALID_STATUSES = new Set(['logged', 'linked', 'snoozed', 'dismissed']);

// Bounds for the two free-form values the observer hands across. Both are
// quoted back into hook directives the model reads (the wake check, the
// checkpoint), so they must stay one short line and a key must look like one.
const WAKE_CONDITION_MAX_CHARS = 200;
const WORK_ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9_.\/#-]{0,79}$/;

function wakeConditionFrom(value) {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, WAKE_CONDITION_MAX_CHARS) : null;
}

function workItemKeyFrom(value) {
  return typeof value === 'string' && WORK_ITEM_KEY.test(value.trim()) ? value.trim() : null;
}

/**
 * Extract observer event metadata from a forge__update_state tool input.
 * Returns `{ status, outcome, sdlcStage, wakeCondition, workItemKey }` for a
 * recognised observation_outcome event, or null otherwise. `status` is the
 * mapped local session status (null for stage-carrying outcomes like
 * linked/created that have no status mapping); `outcome` is the raw outcome
 * string the caller can branch on for outcome-specific side effects (e.g. the
 * cache-flag pin); `sdlcStage` is the observer's classified stage, persisted
 * so stop-observer.cjs periodic checkpoints (which read `state.sdlc_stage`,
 * defaulting to 'other') bank engineering time under the real stage.
 *
 * `wakeCondition` and `workItemKey` come from `final_session_state` (the key
 * also from the top-level `work_item_key` the link payload carries). The
 * session_observer skill sends both, and they used to be dropped here: the
 * snooze wake check fell back to generic copy instead of the user's words, and
 * every checkpoint of a linked session sent `work_item_key: null` (contract
 * audit). Anything else on final_session_state is still ignored.
 *
 * Periodic engineering-time checkpoints reuse `observation_outcome` but must
 * NOT touch status or re-stamp the stage — they carry the already-persisted
 * stage (or its 'other' fallback), so re-capturing would risk clobbering a
 * good value with the default. They are skipped here.
 */
function extractObserverEvent(call) {
  const updates = call?.state_updates;
  if (!updates || updates.event_type !== 'observation_outcome') return null;
  if (updates.outcome === 'checkpoint') return null;
  // Prefer the skill's DECLARED final state. session_observer emits
  // `final_session_state.status` as the authoritative post-observation status
  // (the object its own instructions say the parent must persist). Honouring it
  // closes the re-nudge loop for a "linked"/"created" outcome that did NOT
  // chain a follow-up workflow: those have no OUTCOME_TO_STATUS mapping, so the
  // status stayed null and stop-observer.cjs re-fired the nudge every turn even
  // though the skill had already declared status: "linked". Validate against
  // the known set, then fall back to the outcome map for older payloads that
  // carry no final_session_state.
  const final = updates.final_session_state && typeof updates.final_session_state === 'object'
    ? updates.final_session_state
    : {};
  const declared = final.status;
  const status = (typeof declared === 'string' && VALID_STATUSES.has(declared))
    ? declared
    : (OUTCOME_TO_STATUS[updates.outcome] || null);
  const sdlcStage = typeof updates.sdlc_stage === 'string' && updates.sdlc_stage
    ? updates.sdlc_stage
    : null;
  const workItemKey = workItemKeyFrom(final.work_item_key) || workItemKeyFrom(updates.work_item_key);
  // Nothing actionable unless the event maps to a status, carries a stage, or
  // names the work item.
  if (!status && !sdlcStage && !workItemKey) return null;
  return {
    status,
    outcome: updates.outcome,
    sdlcStage,
    wakeCondition: wakeConditionFrom(final.wake_condition),
    workItemKey,
  };
}

/**
 * Detect the org-disabled gate completion from a forge__update_state input.
 *
 * The session_observer gated-completion payload (rendered by the server)
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
function extractObservationGate(call) {
  return !!call?.state_updates && call.state_updates.outcome === 'observation_disabled';
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
function extractSkillContext(call) {
  return call?.workflow || null;
}

/**
 * A wrapped (Codex functions.exec) forge__update_state whose reply this hook
 * cannot adopt — the call failed, or the host put a saved-result pointer in
 * place of the reply. The server may still have moved the run, possibly into
 * a locked step, and keeping the previous step's lock would fail open. So hold
 * writes until forge__get_workflow_state names the step: the same hold a
 * direct call gets in main() (step_resync_required).
 *
 * The call is only identified — a single literal, top-level awaited Forge
 * call — and nothing is read from its reply, so this can only tighten state.
 * Unlike a direct call, a refusal is not exempt: the reply text here is the
 * script's output, and a refusal-shaped line in it proves nothing.
 */
function holdAfterUnreadWrappedUpdate(event) {
  const name = wrappedForgeCall(event);
  if (!name || !name.includes(WORKFLOW_STATE_PATTERN)) return;
  const sessionState = sessionStateModule.forSession(event.session_id);
  if (sessionState.read().active_workflow) sessionState.write({ step_resync_required: true });
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
    // A host may frame stdin with a UTF-8 byte-order mark and a trailing CRLF
    // (Cursor on Windows pipes it through PowerShell); trim() removes both.
    event = JSON.parse(input.trim());
  } catch {
    return; // Malformed input — exit silently
  }

  const rawToolName = event.tool_name;
  const rawEvent = event;
  event = normalizeToolEvent(event);
  if (!event) {
    // Ambiguous wrapped calls cannot safely update session state — except to
    // tighten it after a lost update_state (see holdAfterUnreadWrappedUpdate).
    holdAfterUnreadWrappedUpdate(rawEvent);
    return;
  }
  // Codex functions.exec: the script's own output can precede the Forge reply.
  const wrapped = event.tool_name !== rawToolName;

  // Scope state to this Claude Code session so concurrent sessions in the
  // same directory each track their own workflow.
  const sessionState = sessionStateModule.forSession(event.session_id);

  const toolName = event.tool_name || '';
  const toolResponse = event.tool_response || '';

  // Codex: a failed tool must not acknowledge passive delivery or clear guards.
  // Scoped to the response-driven branches below — the start_workflow preflight
  // branch still needs to run for a failed start, which is exactly when the
  // observer should stay suppressed for the turn.
  const toolFailed = !!(toolResponse?.isError || event.error ||
    (typeof toolResponse === 'object' && toolResponse.error));

  // The one shape every branch below agrees on. A malformed top-level input is
  // not a call we can reason about.
  const call = stateCall(event.tool_input || {});

  // Track local skill invocations via the Skill tool (Claude Code).
  // The PostToolUse hook fires for ALL tool calls — including the built-in
  // Skill tool. We record which local skills the AI invoked so the
  // stop-observer checkpoint can flush them to the Forge audit trail.
  if (toolName === 'Skill') {
    if (toolFailed) return;
    const skillName = call?.skill || null;
    // Ignore forge-autopilot — that's our own routing skill, not a local skill.
    // The skill id can arrive namespaced: Claude Code surfaces plugin skills as
    // "forge-shiptoday:forge-autopilot", so a bare `=== 'forge-autopilot'` check
    // misses it and records our own router into skill_invocations — which then
    // pollutes the local-skill audit flush. Compare the bare id after any
    // "plugin:" prefix so both the bare and namespaced forms are ignored.
    const bareSkillName = skillName ? skillName.split(':').pop() : null;
    if (skillName && bareSkillName !== 'forge-autopilot') {
      const state = sessionState.read();
      const invocations = state.skill_invocations || [];
      invocations.push({ name: skillName, at: new Date().toISOString() });
      const updates = { skill_invocations: invocations };
      // Arm the required-skill continuation backstop. If a Forge
      // workflow step is mid-flight when a local skill runs, the model is
      // expected to relay the skill's findings and call forge__update_state in
      // the same turn. A skill prompt like "reply with only your output" can
      // make the model stop instead; the Stop hook (stop-observer.cjs) fires a
      // one-time continuation nudge when this flag is still set at turn end.
      // Cleared by any forge__update_state below.
      if (state.active_workflow) updates.pending_skill_continuation = true;
      sessionState.write(updates);
    }
    return;
  }

  // Recovery reads re-sync the CHECKPOINT pin and nothing else.
  // Codex: a failed read said nothing, so it re-syncs nothing.
  if (toolName.includes(WORKFLOW_STATE_READ_PATTERN)) {
    if (toolFailed) return;
    resyncFromStateRead(sessionState, toolResponse, event.tool_input);
    return;
  }

  // Approval authenticity. A relayed question reaches the user
  // through the host's question tool; the guard refuses an answer posted with
  // no such call (and no user turn) after the pin. Record the call here, where
  // every PostToolUse arrives — only while pinned, because the timestamp is
  // compared against the pin's, and a call made before the question existed
  // proves nothing about it. Codex: a failed call (the question UI closed or
  // errored) is no proof the question reached the user.
  if (QUESTION_TOOL_RE.test(toolName)) {
    if (toolFailed) return;
    const state = sessionState.read();
    if (state.active_workflow && state.pending_checkpoint) {
      sessionState.write({ pending_checkpoint_asked_at: new Date().toISOString() });
    }
    return;
  }

  // Fast path: check if this is a Forge tool at all
  const isWorkflowStart = WORKFLOW_START_PATTERNS.some((p) => toolName.includes(p));
  const isStateUpdate = toolName.includes(WORKFLOW_STATE_PATTERN);
  const isAbandon = toolName.includes(WORKFLOW_ABANDON_PATTERN);

  if (!isWorkflowStart && !isStateUpdate && !isAbandon) return; // Not a Forge tool — exit silently

  // Codex: an update_state reply this hook does not take state from still
  // leaves the active step unknown, unless it is the server's own `Error:`
  // refusal (the call was refused and the run did not move). Keeping the
  // previous step's lock would fail open, so writes are held until
  // forge__get_workflow_state re-syncs — the same hold the step re-sync below
  // sets. Holding only tightens the guard; nothing is released on such a reply.
  const holdForResync = () => {
    if (!isStateUpdate || /^\s*Error: /.test(responseText(toolResponse))) return;
    if (sessionState.read().active_workflow) sessionState.write({ step_resync_required: true });
  };

  // A response-driven branch reads what the server said; a failed call said
  // nothing. The preflight branch below is the exception and checks this
  // itself, because a FAILED start is still a start that must suppress the
  // observer for this turn.
  if (toolFailed && !isWorkflowStart) {
    holdForResync();
    return;
  }

  // Workflow abandoned: clear local session state immediately. Mirrors the
  // workflow-completion handler below — same flag flips, same observer-block
  // semantics — so the UserPromptSubmit hook stops emitting "workflow active"
  // reminders on the next turn.
  if (isAbandon && isWorkflowAbandoned(toolResponse)) {
    sessionState.write({
      // Codex: the turn-cadence baseline moves with the time baseline below.
      last_checkpoint_turn: sessionState.read().turn_count || 0,
      active_workflow: false,
      observer_blocked: true,
      conversation_id: null,
      current_skill: null,
      pending_checkpoint: false,
      pending_checkpoint_step: null,
      pending_checkpoint_at: null,
      pending_checkpoint_question_id: null,
      pending_checkpoint_response_field: null,
      pending_checkpoint_asked_at: null,
      pending_checkpoint_user_turn_at: null,
      current_step_tools: null,
      write_lock: null,
      current_step_skill: null,
      step_resync_required: false,
      // Anti-double-count: the workflow span was already banked — per-step
      // duration_ms stamps for the completed steps plus the __abandoned__ row
      // for the in-flight one. Advance the observer-checkpoint baseline past it
      // so a logged/linked session's next checkpoint measures post-abandon
      // activity only, instead of re-banking the whole workflow window
      // (stop-observer suppresses checkpoints while active_workflow is true,
      // so the baseline would otherwise still point at the pre-workflow Stop).
      last_checkpoint_at: new Date().toISOString(),
    });
    return;
  }

  // Workflow start: mark session as active and capture context
  if (isWorkflowStart && !toolFailed && isValidWorkflowResponse(toolResponse)) {
    const conversationId = extractConversationId(toolResponse);
    const currentSkill = extractSkillContext(call);
    const toolPermissions = extractToolPermissions(toolResponse);
    const currentStepSkill = extractCurrentStepSkill(toolResponse);
    const updates = {
      active_workflow: true,
      conversation_id: conversationId,
      current_skill: currentSkill,
      // Per-step allowlist. null when the orchestrator did
      // not publish a Tool Permissions line — workflow-guard fails open.
      current_step_tools: toolPermissions,
      current_step_skill: currentStepSkill,
      // The first step may already be locked (Always asks + writes).
      write_lock: extractWriteLock(toolResponse),
      step_resync_required: false,
      // Active time: the first step begins now. workflow-guard reads this as
      // the lower bound of the active-time window it stamps onto duration_ms.
      step_active_since: new Date().toISOString(),
      workflow_recovery_required: false,
      workflow_binding_pending: false,
      workflow_expiry: expiryMetadata(startHeader(toolResponse)) || null,
      workflow_activity_at: new Date().toISOString(),
      current_step_token: startHeader(toolResponse).match(/^\*\*Step Token\*\*: `([^`]+)`/m)?.[1] || null,
    };
    // Pin the observe_session conversation id separately so the periodic
    // Stop-hook checkpoint can target it after the workflow completes —
    // conversation_id above is nulled on completion. Captured here (not
    // on completion) so it always reflects the observer run and is never
    // overwritten by a chained follow-up workflow.
    if (currentSkill === 'observe_session') {
      updates.last_observer_conversation_id = conversationId;
      updates.observation_due = null;
      const delivery = sessionState.read().observation_delivery;
      if (delivery) updates.observation_delivery = { ...delivery,
        processed_at: new Date().toISOString(), disposition: 'observe' };
    }
    sessionState.write(updates);
    return;
  }

  // Workflow preflight: forge__start_workflow returned WITHOUT a Conversation
  // ID. It did not start a workflow — it returned a clarification prompt
  // (disambiguation, team selection, key confirmation, name resolution,
  // recommendation, or intent classification) or a disabled/error response.
  // No workflow is in flight, but the user is mid-negotiation with Forge and is
  // about to answer a question, so suppress the passive observer for this Stop:
  // otherwise stop-observer.cjs sees an untracked session and stacks its tracking
  // nudge on top of the clarification prompt the user is still answering.
  //
  // `**Conversation ID**` is rendered ONLY on a real start
  // (by the server), so its ABSENCE is the robust preflight signal
  // across every current and future preflight type — no per-prompt text matching
  // to keep in sync as prompts are reworded or added.
  //
  // observer_blocked (NOT observer_fired): prompt-router.cjs re-arms the observer
  // on a later turn while !observer_fired, so if the user abandons the preflight
  // and drifts into other untracked work the observer still fires for it. When
  // the user answers and the real workflow starts, the branch above sets
  // active_workflow, which keeps the observer suppressed for the workflow's own
  // duration. A hard start error lands here too and is benign — the re-arm clears
  // the block on the next turn.
  if (isWorkflowStart) {
    // Codex: passive delivery (passive-observation.cjs) suppresses the next
    // prompt from this turn stamp, because prompt-router re-arms
    // observer_blocked before delivery runs.
    sessionState.write({ observer_blocked: true, clarification_at_turn: sessionState.read().turn_count || 0 });
    return;
  }

  // Every update_state decision below reads the reply's header, not its body.
  const header = isStateUpdate ? parseReplyHeader(toolResponse, { wrapped }) : null;

  // Observer outcome: when session_observer completes via forge__update_state,
  // persist the status to the local session state file so stop-observer can
  // use it for checkpoint logic. Claude is instructed to write this itself,
  // but it inconsistently forgets — this hook makes it reliable.
  if (isStateUpdate) {
    if (!call) return;
    const passive = call.state_updates;
    const text = responseText(toolResponse);
    // Only recognized successful responses may update local workflow state: a
    // reply whose header carries a marker or completes the run. In particular,
    // a rejected update must not clear a pending question.
    if (!header.complete && !header.marker) {
      holdForResync();
      return;
    }
    if (passive.outcome === 'checkpoint' && call.completed_step === 'session_observer') {
      const state = sessionState.read();
      if (attempted(sessionState, state, call) && !state.checkpoint_delivery.processed_at &&
          /Checkpoint recorded/.test(text)) {
        sessionState.write({ checkpoint_delivery: { ...state.checkpoint_delivery,
          processed_at: new Date().toISOString() } });
      }
      // A completed-observer checkpoint is NOT completion of another active
      // workflow. It must not reset the already-reserved time boundary.
      return;
    }
    let callInput = event.tool_input;
    if (typeof callInput === 'string') { try { callInput = JSON.parse(callInput); } catch { return; } }
    const tracked = sessionState.read();
    if (tracked.active_workflow && callInput?.conversation_id && callInput.conversation_id !== tracked.conversation_id) return;
    if (header.expiry === false || toolResponse?.isError || toolResponse?.is_error) {
      if (tracked.active_workflow) sessionState.write({ step_resync_required: true });
      return;
    }
    if (tracked.workflow_recovery_required) return;
    if (header.marker && header.stepToken) {
      sessionState.write({ current_step_token: header.stepToken, workflow_activity_at: new Date().toISOString(),
        ...(header.expiry ? { workflow_expiry: header.expiry } : {}) });
    }
    // The wake condition and work item are recorded below, validated, with the
    // rest of the observer outcome (extractObserverEvent).
    if (header.complete && (passive.event_type === 'observation_outcome' ||
        passive.outcome === 'observation_disabled')) {
      const state = sessionState.read();
      sessionState.write({ observation_due: null, last_observer_turn: state.turn_count,
        ...(state.observation_delivery ? { observation_delivery: { ...state.observation_delivery,
          processed_at: new Date().toISOString(), disposition: passive.outcome } } : {}),
      });
    }
    // Any forge__update_state means the model is driving the workflow
    // forward (advance, checkpoint, re-entry, or completion) — disarm the
    // required-skill continuation backstop so the Stop hook does not nudge.
    sessionState.write({ pending_skill_continuation: false });

    // Org-disabled gate backstop. The session_observer gated
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
    if (extractObservationGate(call)) {
      sessionState.write({ forge_observation_enabled: false });
      // Don't return — a single-step gated workflow also reports completion
      // below, which clears active_workflow / sets observer_blocked.
    }

    const observerEvent = extractObserverEvent(call);
    if (observerEvent) {
      const { status: observerStatus, outcome: observerOutcome, sdlcStage, wakeCondition, workItemKey } = observerEvent;
      const statusUpdates = {};
      // A soft decline is DERIVED from the outcome here rather than
      // read from a field on final_session_state. That is not a stylistic
      // choice — `extractObserverEvent` reads only `status`, `wake_condition`
      // and `work_item_key` from final_session_state, so any other key the
      // skill puts there is silently discarded on this side of the plane
      // boundary. A `declined_once` sent across directly would simply never
      // arrive, with no error at either end, and AC4's acknowledging re-offer
      // would quietly never fire. The outcome already crosses validated, so
      // the client-local flag is computed from it instead.
      if (observerOutcome === 'declined_for_now') {
        statusUpdates.declined_once = true;
      }
      // Status-carrying outcomes (ad_hoc → logged, snoozed, dismissed) set the
      // tracking status and advance the checkpoint baseline. Stage-only
      // outcomes (linked/created) carry no status mapping — they persist the
      // stage without disturbing status or the baseline.
      if (observerStatus) {
        statusUpdates.status = observerStatus;
        statusUpdates.last_checkpoint_at = new Date().toISOString();
        // Codex: the turn-cadence baseline moves with the time baseline, so a
        // freshly logged session does not queue a near-zero checkpoint on its
        // very next Stop.
        statusUpdates.last_checkpoint_turn = sessionState.read().turn_count || 0;
        // The wake condition belongs to this status: a snooze sets it, and any
        // new status (a re-snooze without one included) replaces the old
        // condition rather than inheriting it.
        statusUpdates.wake_condition = observerStatus === 'snoozed' ? wakeCondition : null;
        // For dismissed, also block re-observation
        if (observerStatus === 'dismissed') {
          statusUpdates.observer_blocked = true;
        }
      }
      // The linked work item — stop-observer.cjs puts it on every checkpoint.
      // Like the wake condition it belongs to the status: a session re-observed
      // as ad-hoc, snoozed or dismissed is no longer attributed to the item it
      // was once linked to.
      if (observerStatus && observerStatus !== 'linked') {
        statusUpdates.work_item_key = null;
      } else if (workItemKey) {
        statusUpdates.work_item_key = workItemKey;
      }
      // Persist the observer's classified SDLC stage so stop-observer.cjs
      // periodic checkpoints bank engineering time under the real stage
      // instead of defaulting to 'other'. Previously `state.sdlc_stage` was
      // never written, so every checkpoint heartbeat fell back to 'other'.
      if (sdlcStage) {
        statusUpdates.sdlc_stage = sdlcStage;
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
    // implicitly on workflow completion / abandonment below. Only the reply's
    // header counts: its body can quote a CHECKPOINT header, and pinning on
    // that locked the guard on a plain NEXT STEP.
    if (header.pendingCheckpointStep) {
      const metadata = extractPendingCheckpointMetadata(toolResponse);
      const state = sessionState.read();
      // The same question re-served — a retry, or an answer that bounced —
      // keeps its pin time and the evidence gathered since: the user was
      // already asked it. A different question starts over, so evidence for
      // the last one can never vouch for this one.
      const sameQuestion = state.pending_checkpoint === true
        && typeof metadata.questionId === 'string'
        && metadata.questionId === state.pending_checkpoint_question_id;
      sessionState.write({
        pending_checkpoint: true,
        pending_checkpoint_step: header.pendingCheckpointStep,
        pending_checkpoint_at: sameQuestion && state.pending_checkpoint_at ? state.pending_checkpoint_at : new Date().toISOString(),
        pending_checkpoint_question_id: metadata.questionId,
        pending_checkpoint_response_field: metadata.responseField,
        ...(sameQuestion ? {} : { pending_checkpoint_asked_at: null, pending_checkpoint_user_turn_at: null }),
      });
    } else if (header.reentry) {
      sessionState.write({
        pending_checkpoint: false,
        pending_checkpoint_step: null,
        pending_checkpoint_at: null,
        pending_checkpoint_question_id: null,
        pending_checkpoint_response_field: null,
        pending_checkpoint_asked_at: null,
        pending_checkpoint_user_turn_at: null,
      });
    } else if (!header.complete) {
      // Normal step advance ("NEXT STEP") — clear any stale pin AND advance the
      // active-time boundary so the next step's duration_ms is measured from
      // here. Workflow completion is handled by the dedicated branch below which
      // also clears the pin via active_workflow: false semantics.
      //
      // The boundary advance is gated on the **NEXT STEP** marker so a
      // non-advancing response cannot move it. CHECKPOINT / RE-ENTRY are handled
      // in the branches above; an older server's confirmation-gate PAUSE renders a
      // CHECKPOINT (so it lands in the pendingStep branch and correctly does NOT
      // advance the boundary) — mirroring the server resetting its step start
      // time only on a true advance. Gate-continue renders a fresh NEXT STEP, so the
      // boundary advances on confirm too.
      //
      // Idempotent-retry exclusion: a duplicate update_state for an already-
      // completed step replays the CACHED advance result — same **NEXT STEP**
      // body — with an explicit **Idempotent Retry** marker (rendered by
      // the server). The step did NOT advance, so the boundary
      // must not move: resetting it mid-step would silently drop the active
      // time accrued on the in-flight step before the retry.
      const isNextStepAdvance = header.marker === 'NEXT STEP' && !header.idempotentRetry;
      const state = sessionState.read();
      const advanceUpdates = {};
      if (state.pending_checkpoint && isNextStepAdvance) {
        advanceUpdates.pending_checkpoint = false;
        advanceUpdates.pending_checkpoint_step = null;
        advanceUpdates.pending_checkpoint_at = null;
        advanceUpdates.pending_checkpoint_question_id = null;
        advanceUpdates.pending_checkpoint_response_field = null;
        advanceUpdates.pending_checkpoint_asked_at = null;
        advanceUpdates.pending_checkpoint_user_turn_at = null;
      }
      if (isNextStepAdvance) {
        advanceUpdates.step_active_since = new Date().toISOString();
      }
      if (Object.keys(advanceUpdates).length) sessionState.write(advanceUpdates);
    }

    // A reply this hook can take the active step from carries a marker header
    // or completes the run. Any other reply to an active run leaves the step
    // unknown: a saved-result pointer the host put in place of an oversized
    // reply, an advance whose header the parsing above refused, a transport
    // failure, the server's own "recover the current workflow state"
    // duplicate. Keeping the previous step's allowlist and lock fails open
    // (its shell and no lock, into a step that may be locked), so the step is
    // marked unverified and workflow-guard holds writes until
    // forge__get_workflow_state re-syncs it. The one exception is the server's
    // own `Error:` reply: the call was refused and the run did not move.
    const refused = /^\s*Error: /.test(responseText(toolResponse));
    if (header.marker) {
      sessionState.write({ step_resync_required: false });
    } else if (!header.complete && !refused && sessionState.read().active_workflow) {
      sessionState.write({ step_resync_required: true });
    }

    // Per-step tool-permission allowlist refresh. Each
    // step transition publishes a fresh `**Tool Permissions**: …` line;
    // we mirror it into session state so workflow-guard can enforce the
    // correct allowlist for the active step. Cleared on workflow
    // completion / abandonment via the dedicated branches.
    if (!header.complete && (header.toolPermissions || header.step)) {
      const updates = {
        current_step_tools: header.toolPermissions,
        current_step_skill: header.step,
      };
      // The lock travels with the step, so it refreshes from a reply that
      // publishes the step's full marker set — including to null, which is
      // how a step that does not write, or a server predating the marker,
      // clears an earlier lock.
      //
      // A CHECKPOINT is NOT such a reply. It names the step but carries no
      // Tool Permissions and no Write Lock, so refreshing from it wrote null
      // on every relayed question — silently discarding a lock the step is
      // still under. That was masked while the checkpoint pin denied
      // everything anyway, and became reachable the moment a reply was lost
      // and the run recovered through `get_workflow_state`. Absence of a
      // marker is not evidence the lock was released.
      if (header.toolPermissions || header.writeLock) updates.write_lock = header.writeLock;
      sessionState.write(updates);
    }
  }

  // Workflow completion: deactivate workflow but keep observer blocked.
  // Setting observer_blocked: true prevents the stop-observer from
  // immediately re-firing the session observer on the same turn.
  // A new request after completion is the model's to judge (the
  // forge-autopilot trigger rule); nothing here or in prompt-router gates it.
  if (isStateUpdate && header.complete) {
    sessionState.write({
      // Codex: the turn-cadence baseline moves with the time baseline below.
      last_checkpoint_turn: sessionState.read().turn_count || 0,
      active_workflow: false,
      observer_blocked: true,
      conversation_id: null,
      current_skill: null,
      pending_checkpoint: false,
      pending_checkpoint_step: null,
      pending_checkpoint_at: null,
      pending_checkpoint_question_id: null,
      pending_checkpoint_response_field: null,
      pending_checkpoint_asked_at: null,
      pending_checkpoint_user_turn_at: null,
      current_step_tools: null,
      write_lock: null,
      current_step_skill: null,
      step_resync_required: false,
      // Anti-double-count: the workflow span was already banked per-step
      // via the guard's duration_ms stamps. Advance the observer-checkpoint
      // baseline past it so a logged/linked session's next checkpoint measures
      // post-workflow activity only — without this, the first post-workflow
      // checkpoint window spans the entire workflow (stop-observer suppresses
      // checkpoints while active_workflow is true and nothing else moves the
      // baseline), re-banking the same active time on the observer conversation
      // and double-counting it in the dashboard's SUM(duration_ms). The small
      // pre-workflow tail (activity between the last checkpoint and workflow
      // start) is dropped with it — bounded by TIME_FLOOR_MS, and under-count
      // is the accepted failure direction.
      last_checkpoint_at: new Date().toISOString(),
    });
    return;
  }
}

main().catch(() => {
  // Fail silently — never interfere with Claude's response
});
