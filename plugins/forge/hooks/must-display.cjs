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
 * (and on a compliant turn it will). The dedup below removes the common
 * duplicate — a replayed idempotent retry — but deliberately does not try
 * to detect "the model already showed this", which the hook cannot observe.
 *
 * ## Suppressing the double render
 *
 * Once the hook has emitted the block, a compliant model rendering it too
 * produces it TWICE on screen and spends the block's full length in output
 * tokens to do it — 80-150 tokens per step, every step, for a duplicate.
 * The original note above called that "a cosmetic cost", which understated
 * it: the cost is paid per step for the life of every run.
 *
 * `hookSpecificOutput.additionalContext` is the mirror of `systemMessage`
 * — shown to the MODEL and not to the user — so the same event that puts
 * the block on screen can also tell the model it is already there. That
 * keeps the two channels in agreement instead of racing.
 *
 * Deliberately client-LOCAL. The server's `frameForDisplay` is barred from
 * knowing which client it renders for (SHI-899 AC3, pinned by a test on the
 * function's arity), so the "is the block already on screen?" answer has to
 * come from wherever the display actually happened — which is here.
 *
 * That distinction is load-bearing because this hook does NOT ship
 * everywhere. It is wired on PostToolUse in the Claude plugin
 * (forge-plugin-claude, forge-plugin-claude-mp) and in the Codex plugin
 * (forge-plugin-codex), both of which honour `hookSpecificOutput.
 * additionalContext` with this exact shape. forge-plugin-cursor carries no
 * `must-display` hook at all, so on Cursor the model rendering the block
 * remains the ONLY channel and is correctly never suppressed — not by
 * special-casing, but because nothing runs to suppress it. Keeping the
 * suppression in the hook is what makes that fall out for free, with the
 * server never branching on client identity.
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

/**
 * Told to the MODEL (never the user) whenever this event carried a
 * must-display block — whether or not the systemMessage was emitted for it.
 *
 * Emitted on the duplicate-replay path too: there the user saw the block on
 * the FIRST emit, so a model rendering it on the replay is the same double
 * render, minus the hook's own contribution.
 *
 * Phrased as a statement of fact plus one instruction. It has to overrule a
 * "render this verbatim" directive sitting in the same payload, so it names
 * what already happened rather than asking for cooperation — and it says
 * what to do INSTEAD, because a bare prohibition tends to produce a
 * paraphrase ("I've shown you the step marker above") which is the same
 * tokens with worse fidelity.
 */
const ALREADY_DISPLAYED_NOTICE = 'Forge display hook: the FORGE_DISPLAY_VERBATIM block(s) in that tool '
  + 'response have ALREADY been rendered to the user by this hook — they are on screen now. Do not '
  + 'render, quote, summarize, or otherwise restate them; doing so shows the user the same block '
  + 'twice. Proceed directly to the step body.';

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
 * @param {{ tool_name?: string, tool_response?: any }} event
 * @param {string|null} lastFingerprint
 * @returns {{ systemMessage: string|null, additionalContext: string|null,
 *   fingerprint: string|null, reason: string }}
 */
function decide(event, lastFingerprint) {
  const toolName = event && event.tool_name;
  if (!isDisplayBearingTool(toolName)) {
    return {
      systemMessage: null,
      additionalContext: null,
      fingerprint: lastFingerprint || null,
      reason: 'not_a_forge_display_tool',
    };
  }
  const blocks = extractDisplayBlocks(event.tool_response);
  if (blocks.length === 0) {
    return {
      systemMessage: null,
      additionalContext: null,
      fingerprint: lastFingerprint || null,
      reason: 'no_display_block',
    };
  }
  const fp = fingerprint(blocks);
  if (lastFingerprint && fp === lastFingerprint) {
    // An idempotent retry replays the cached advance body verbatim. Re-emitting
    // would show the user the same "Step 3 of 8" twice for one real step.
    //
    // The suppression notice still goes out: the block is in THIS response's
    // text, so the model can render it now even though the user saw it on the
    // first emit. Suppressing on the replay is the same win as suppressing on
    // the original.
    return {
      systemMessage: null,
      additionalContext: ALREADY_DISPLAYED_NOTICE,
      fingerprint: fp,
      reason: 'duplicate_replay',
    };
  }
  let message = blocks.map((b) => b.body).join('\n\n');
  if (message.length > MAX_MESSAGE_CHARS) {
    message = `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
    // A truncated systemMessage means the user did NOT get the whole block, so
    // the model must stay free to render it in full. Fidelity beats the
    // duplicate-render saving here: a silently half-shown brief is the bug the
    // hook exists to prevent.
    return { systemMessage: message, additionalContext: null, fingerprint: fp, reason: 'emitted_truncated' };
  }
  return {
    systemMessage: message,
    additionalContext: ALREADY_DISPLAYED_NOTICE,
    fingerprint: fp,
    reason: 'emitted',
  };
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
  // The duplicate-replay path emits no systemMessage but DOES carry the
  // suppression notice, so gate on "nothing to say at all" rather than on the
  // systemMessage alone.
  if (!result.systemMessage && !result.additionalContext) return;

  try {
    sessionState.write({ last_display_fingerprint: result.fingerprint });
  } catch {
    // Persisting dedup state is best-effort; showing the block is not.
  }

  const payload = {};
  if (result.systemMessage) payload.systemMessage = result.systemMessage;
  if (result.additionalContext) {
    payload.hookSpecificOutput = {
      hookEventName: 'PostToolUse',
      additionalContext: result.additionalContext,
    };
  }
  process.stdout.write(JSON.stringify(payload));
}

// Exported for the unit test; `require.main` guard keeps importing side-effect free.
module.exports = {
  decide,
  extractDisplayBlocks,
  isDisplayBearingTool,
  responseText,
  fingerprint,
  ALREADY_DISPLAYED_NOTICE,
};

if (require.main === module) {
  main().catch(() => {
    // Fail silently — a hook must never interfere with Claude's response.
  });
}
