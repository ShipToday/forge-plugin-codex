#!/usr/bin/env node

/**
 * must-display.cjs — PostToolUse hook that guarantees Forge's must-display
 * blocks actually reach the user.
 *
 * ## Why this exists
 *
 * The orchestrator marks content that is FOR THE USER (the preflight brief,
 * the per-step "Step N of M" position marker) by wrapping it in a
 * `<<<FORGE_DISPLAY_VERBATIM id="…">>>` envelope carrying an explicit
 * "render this verbatim" directive. Rendering it is the client's job.
 *
 * Measured behaviour says that job is done unreliably. In one observed
 * `forge_setup` run NONE of the eight position markers reached the user;
 * in later runs of the identical server payload (byte-for-byte — the
 * envelopes declare the same `bytes=` count) every marker rendered. The
 * variable was not the model (it failed on Sonnet and succeeded on both
 * Sonnet and Opus) and not delegation (it failed on a step that ran
 * inline). The variable was how much else was competing for attention:
 * the directive sits directly above the ~4 KB model-delegation advisory,
 * the largest imperative block in the payload.
 *
 * That is the same failure mode this hooks directory already documents
 * twice — "the parent consistently forgets because the MCP response's
 * large instruction block captures its attention" (workflow-tracker.cjs)
 * — and the same remedy applies: stop asking, and do it in the hook.
 *
 * Server-side placement fixes (hoisting the block out of the
 * `<<<FORGE_NEXT_STEP>>>` envelope, naming it in the sub-agent relay
 * contract, restating ownership below the advisory) all improve the odds.
 * None of them REMOVE the dependency on the model choosing to comply, and
 * a probabilistic dependency cannot be verified by simulation — isolated
 * single-turn agents sit in the high-compliance regime and render every
 * time, so a green test proves nothing about a long real session. This
 * hook is the only lever that is deterministic, and therefore the only
 * one that can actually be tested.
 *
 * ## How
 *
 * `systemMessage` is the one documented PostToolUse output field that is
 * shown to the USER and not to the model. That asymmetry is exactly right
 * here: the block is user-facing content, and echoing it back into the
 * model's context would just spend tokens re-stating what it already read.
 *
 * Belt-and-braces, not replacement: the model may ALSO render the block
 * (and on a compliant turn it will). Duplicate display is a cosmetic cost;
 * a silently missing progress marker is the bug. The dedup below removes
 * the common duplicate — a replayed idempotent retry — but deliberately
 * does not try to detect "the model already showed this", which the hook
 * cannot observe.
 *
 * ## Why this hook does NOT tell the model to stand down
 *
 * A previous version emitted `hookSpecificOutput.additionalContext` — the
 * model-facing mirror of `systemMessage` — saying the block was already on
 * screen, to save the 80-150 tokens a compliant model spends rendering it
 * a second time. That rests on a premise the hook cannot check: that
 * `systemMessage` is user-VISIBLE on the host client.
 *
 * On `claude-desktop` it is not. The client records the emit as a
 * `hook_system_message` transcript attachment that the user never sees, so
 * the model's render was the only visible copy — and suppressing it took
 * the preflight brief and every "Step N of M" marker off screen entirely
 * (observed across a full forge_setup run, plugin v1.13.0).
 *
 * The asymmetry is what settles it. A duplicate render costs tokens and
 * looks untidy; a suppressed render costs the user the only view they have
 * of where the run has got to. The hook cannot distinguish the clients
 * where the saving is safe — the PostToolUse event carries no client
 * identity — so it does not try, and never suppresses. Cursor ships no
 * must-display hook at all, which makes the model the sole channel there in
 * any case; Codex ships this hook, where the same unverifiable question
 * applies.
 *
 * It is also moot for a DELEGATED step: the `forge__update_state` call is
 * made by the sub-agent, so this hook fires in the sub-agent's session (if
 * at all) and never puts anything in front of the user. There the parent
 * rendering the relayed block is the only channel that exists.
 *
 * @see plugin/hooks/session-state.cjs for state management
 * @see src/capabilities/protocols/run-contract.js for the emitting side
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const sessionStateModule = require('./session-state.cjs');

// -- Constants ----------------------------------------------------------------

/**
 * Forge tools whose responses can carry a must-display block. Matched as a
 * SUBSTRING of the fully-qualified MCP name, because the real tool name
 * embeds a per-connection server id assigned at install time
 * (`mcp__<uuid>__forge__update_state`, `mcp__plugin_forge-shiptoday_forge__…`).
 */
const DISPLAY_BEARING_TOOLS = [
  'forge__start_workflow',
  'forge__update_state',
  'forge__get_workflow_state',
];

const BLOCK_RE = /<<<FORGE_DISPLAY_VERBATIM id="([^"]*)">>>\n([\s\S]*?)\n<<<END FORGE_DISPLAY_VERBATIM>>>/g;

/** systemMessage is capped at 10,000 chars; stay clear of the ceiling. */
const MAX_MESSAGE_CHARS = 8000;

// -- Pure helpers (exported for tests) ---------------------------------------

/**
 * Extract the human-readable text from a PostToolUse `tool_response`.
 *
 * Four shapes, because the field is not stable across clients and sizes:
 *   - Bare content array `[{ type: "text", text }]` (Claude Code's MCP shape)
 *   - Wrapped envelope `{ content: [...] }`
 *   - A plain string
 *   - A FILE PATH — Claude Code replaces tool output above ~10,000 chars with
 *     a path to the spilled content. This matters here rather than being a
 *     rare edge: real forge_setup step payloads run 11–19 KB, so the spill is
 *     the COMMON case for exactly the tool this hook targets. A version that
 *     only handled inline text would work on short responses and silently
 *     no-op on every long one — i.e. fail precisely where the attention-capture
 *     bug is worst.
 */
function responseText(response) {
  if (!response) return '';
  if (Array.isArray(response)) {
    return response.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  }
  if (typeof response === 'object' && Array.isArray(response.content)) {
    return response.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  }
  if (typeof response === 'string') {
    // A spilled-to-disk payload arrives as a bare path. Only treat it as one
    // when it has no sentinel of its own (so genuine inline text that happens
    // to mention a path is never mistaken for a pointer) and the file reads.
    if (!response.includes('FORGE_DISPLAY_VERBATIM') && looksLikePath(response)) {
      try {
        if (fs.existsSync(response.trim())) return fs.readFileSync(response.trim(), 'utf8');
      } catch {
        return response;
      }
    }
    return response;
  }
  return '';
}

function looksLikePath(s) {
  const t = s.trim();
  if (t.length > 1024 || t.includes('\n')) return false;
  return /^([a-zA-Z]:[\\/]|\/|\.{1,2}[\\/])/.test(t);
}

/** True when this tool's response is one that can carry a display block. */
function isDisplayBearingTool(toolName) {
  if (typeof toolName !== 'string') return false;
  return DISPLAY_BEARING_TOOLS.some((p) => toolName.includes(p));
}

/**
 * Pull every must-display block out of a response, in order.
 *
 * Returns the INNER content only — never the sentinels, and never the
 * "Relay to the user" directive above them, which is addressed to the model
 * and is not content for the user.
 *
 * @returns {Array<{ id: string, body: string }>}
 */
function extractDisplayBlocks(response) {
  const text = responseText(response);
  if (!text || !text.includes('FORGE_DISPLAY_VERBATIM')) return [];
  const out = [];
  BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    const body = (m[2] || '').trim();
    if (body) out.push({ id: m[1] || 'block', body });
  }
  return out;
}

/** Stable fingerprint of a block set, for replay dedup. */
function fingerprint(blocks) {
  return crypto
    .createHash('sha256')
    .update(blocks.map((b) => `${b.id}\u0000${b.body}`).join('\u0001'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Decide what this event should surface.
 *
 * Pure: no I/O, no process state — the caller supplies the previously-emitted
 * fingerprint and persists the returned one. Keeps the whole decision testable
 * without a session file or a live hook harness.
 *
 * Never returns anything model-facing: the hook's whole output is the
 * user-visible `systemMessage`. See "Why this hook does NOT tell the model to
 * stand down" above.
 *
 * @param {{ tool_name?: string, tool_response?: any }} event
 * @param {string|null} lastFingerprint
 * @returns {{ systemMessage: string|null, fingerprint: string|null, reason: string }}
 */
function decide(event, lastFingerprint) {
  const toolName = event && event.tool_name;
  if (!isDisplayBearingTool(toolName)) {
    return { systemMessage: null, fingerprint: lastFingerprint || null, reason: 'not_a_forge_display_tool' };
  }
  const blocks = extractDisplayBlocks(event.tool_response);
  if (blocks.length === 0) {
    return { systemMessage: null, fingerprint: lastFingerprint || null, reason: 'no_display_block' };
  }
  const fp = fingerprint(blocks);
  if (lastFingerprint && fp === lastFingerprint) {
    // An idempotent retry replays the cached advance body verbatim. Re-emitting
    // would show the user the same "Step 3 of 8" twice for one real step.
    return { systemMessage: null, fingerprint: fp, reason: 'duplicate_replay' };
  }
  let message = blocks.map((b) => b.body).join('\n\n');
  if (message.length > MAX_MESSAGE_CHARS) {
    message = `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
    return { systemMessage: message, fingerprint: fp, reason: 'emitted_truncated' };
  }
  return { systemMessage: message, fingerprint: fp, reason: 'emitted' };
}

// -- Main ---------------------------------------------------------------------

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return; // Malformed input — exit silently.
  }

  const sessionState = sessionStateModule.forSession(event.session_id);

  let last = null;
  try {
    last = sessionState.read().last_display_fingerprint || null;
  } catch {
    last = null; // A missing/corrupt state file must not suppress the display.
  }

  const result = decide(event, last);
  if (!result.systemMessage) return;

  try {
    sessionState.write({ last_display_fingerprint: result.fingerprint });
  } catch {
    // Persisting dedup state is best-effort; showing the block is not.
  }

  process.stdout.write(JSON.stringify({ systemMessage: result.systemMessage }));
}

// Exported for the unit test; `require.main` guard keeps importing side-effect free.
module.exports = { decide, extractDisplayBlocks, isDisplayBearingTool, responseText, fingerprint };

if (require.main === module) {
  main().catch(() => {
    // Fail silently — a hook must never interfere with Claude's response.
  });
}
