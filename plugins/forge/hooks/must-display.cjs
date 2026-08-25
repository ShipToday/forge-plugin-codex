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
 * ## How — a breadcrumb, not a second copy
 *
 * `systemMessage` is the one documented PostToolUse output field that is
 * shown to the USER and not to the model. That asymmetry is exactly right
 * here: the block is user-facing content, and echoing it back into the
 * model's context would just spend tokens re-stating what it already read.
 *
 * What it emits is ONE LINE — the block's heading, or its first real line
 * where it has none. Claude Code renders a hook's `systemMessage` by
 * prefixing EVERY line with `PostToolUse:<tool> says:`, so a four-line
 * block (heading, `next:` trail, blank, rule) became four prefixed lines
 * sitting directly above the model's own clean render of the same content.
 * The floor was doing its job and still reading as noise.
 *
 * So the two channels get different jobs rather than the same job twice:
 * the hook guarantees the user always knows WHERE the run is, and the
 * model's render carries the full block as ordinary markdown.
 *
 * Belt-and-braces, not replacement: the model may ALSO render the block
 * (and on a compliant turn it will). A one-line breadcrumb alongside it is
 * a cosmetic cost; a silently missing progress marker is the bug. The dedup
 * below removes the common duplicate — a replayed idempotent retry — but
 * deliberately does not try to detect "the model already showed this",
 * which the hook cannot observe.
 *
 * ## Rejected: emit nothing and let the model render
 *
 * The obvious way to remove the noise entirely is to flip this hook from
 * renderer to reminder — emit a model-facing "render it now" and no
 * `systemMessage` at all. Rejected: it trades the one deterministic channel
 * in the chain for an unverifiable one, and the paragraph above is why
 * unverifiable is the whole problem here — a green test proves nothing.
 *
 * A Stop-hook backstop that re-emits only when the model demonstrably
 * skipped was rejected for a different reason: it fires at END of turn, so
 * a recovered "Step 2 of 3" arrives after step 2 already ran. It guarantees
 * presence, not timeliness, and timeliness is most of what a progress
 * marker is for.
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

/**
 * Breadcrumb cap. `systemMessage` allows 10,000 chars, but the bound that
 * matters here is readability: this is a one-line locator, not the content.
 */
const MAX_BREADCRUMB_CHARS = 200;

/** A markdown thematic break — the block's trailing separator, never its label. */
const RULE_RE = /^-{3,}$/;

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
 * Reduce one block to the single line that identifies it: its heading, or
 * its first real line when it has none (the `findings` block is bare prose).
 *
 * Returns '' when there is nothing to name, so the caller can drop the
 * segment rather than emit an empty one.
 */
function breadcrumbFor(body) {
  const first = String(body || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !RULE_RE.test(l));
  return first ? first.replace(/^#{1,6}\s+/, '') : '';
}

/**
 * One line for the whole event, however many blocks it carried. The response
 * that opens a run carries `preflight` AND `position`; joining them keeps
 * that a single prefixed line instead of two.
 */
function breadcrumb(blocks) {
  return blocks.map((b) => breadcrumbFor(b.body)).filter(Boolean).join(' · ');
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
  let message = breadcrumb(blocks);
  if (!message) {
    // Blocks that are nothing but a separator have no line to name them.
    return { systemMessage: null, fingerprint: fp, reason: 'no_breadcrumb' };
  }
  if (message.length > MAX_BREADCRUMB_CHARS) {
    message = `${message.slice(0, MAX_BREADCRUMB_CHARS - 1)}…`;
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
module.exports = { decide, extractDisplayBlocks, isDisplayBearingTool, responseText, fingerprint, breadcrumb };

if (require.main === module) {
  main().catch(() => {
    // Fail silently — a hook must never interfere with Claude's response.
  });
}
