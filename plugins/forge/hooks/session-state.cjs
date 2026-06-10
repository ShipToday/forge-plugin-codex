#!/usr/bin/env node

/**
 * session-state.js — Shared session state module for Forge plugin hooks.
 *
 * Manages a local JSON state file used by all four plugin hooks
 * (prompt-router, workflow-tracker, stop-observer, workflow-guard) to
 * coordinate active-workflow tracking and passive observation.
 *
 * State is scoped per Claude Code session. Each hook event carries a
 * `session_id`; the state file is keyed by hash(cwd + session_id) so two
 * concurrent Claude Code sessions in the same working directory each get
 * an independent workflow slot. When no session id is available (older
 * Claude Code, or the Codex/Cursor builds of this plugin), the key falls
 * back to hash(cwd) — preserving the original single-workflow-per-
 * directory behavior.
 *
 * Usage: `require('./session-state.cjs').forSession(event.session_id)`
 * returns a `{ read, write, increment, stateFilePath }` instance bound to
 * that session's file.
 *
 * State files live in {os.tmpdir()}/forge-observer/{key}.json and
 * auto-expire after 4 hours (matching Forge's server-side TTL).
 *
 * This module is deterministic — no AI, no network calls.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// -- Constants ---------------------------------------------------------------

const STATE_DIR = path.join(os.tmpdir(), 'forge-observer');
const TTL_MS = 4 * 60 * 60 * 1000;       // 4 hours — matches Forge's Redis TTL
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — auto-clean stale files

// -- Helpers -----------------------------------------------------------------

/**
 * Compute the state file key. Scoped to the Claude Code session when a
 * session id is available so concurrent sessions in the same working
 * directory get independent state. Falls back to a cwd-only key when no
 * session id is present.
 */
function stateKey(sessionId) {
  const material = sessionId ? `${process.cwd()}:${sessionId}` : process.cwd();
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `${stateKey(sessionId)}.json`);
}

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function freshState(sessionId) {
  return {
    session_id: sessionId || crypto.randomUUID(),
    session_start: new Date().toISOString(),
    turn_count: 0,
    nudge_shown: false,
    status: null,          // null | "snoozed" | "dismissed" | "linked" | "logged"
    wake_condition: null,
    routing_emitted: false,
    active_workflow: false,
    observer_blocked: false,
    last_observer_turn: null,
    last_checkpoint_at: null,
    conversation_id: null,   // Forge conversation ID for active workflow
    // Forge conversation ID of the observe_session run, kept after that
    // workflow completes (conversation_id above is nulled on completion).
    // The periodic Stop-hook checkpoint targets this so it works even
    // from a later process that never ran observe_session itself.
    // Only cleared by the 4h session-state TTL reset.
    last_observer_conversation_id: null,
    current_skill: null,     // Active skill_id or workflow type
    skill_invocations: [],   // Local skills invoked this session [{ name, at }]
    skills_flushed_at_turn: 0, // Turn count at last skill invocation flush
    // Relayed-question pin: set when forge__update_state returns a
    // **CHECKPOINT** response (skill is awaiting user input via
    // AskUserQuestion). Cleared on **RE-ENTRY** (answer flowed back),
    // normal step advance, workflow completion, or abandonment.
    // The workflow-guard PreToolUse hook reads this to deny tool calls
    // other than AskUserQuestion / forge__update_state /
    // forge__abandon_workflow until the user has answered.
    pending_checkpoint: false,
    pending_checkpoint_step: null,    // Skill id pinned for input
    pending_checkpoint_at: null,      // ISO timestamp the pin was set
    // Per-step tool-permission allowlist (V2 enforcement).
    //   - current_step_tools: array of category strings the orchestrator
    //     published in the latest **Tool Permissions** line, or null when
    //     unknown (workflow-guard fails open).
    //   - current_step_skill: bare skill_id of the active step, used in
    //     deny messages so the model knows which step is gating.
    current_step_tools: null,
    current_step_skill: null,
    // ── R1 active-time: step_active_since ───────────────────────────────
    // ISO timestamp marking when the CURRENT workflow step began (the
    // client-side analog of the server's `stepStartedAt`). Set by
    // workflow-tracker.cjs on workflow start and on every genuine NEXT STEP
    // advance; NOT advanced on relayed-question CHECKPOINT/RE-ENTRY (the step
    // does not advance there). workflow-guard.cjs reads it as the lower bound
    // of the active-time window it stamps onto forge__update_state's
    // duration_ms. null until the first step begins.
    step_active_since: null,
    // ── SHI-759 / SHI-758 contract: forge_observation_enabled ──────────
    // Per-Claude-Code-session cache of the org-admin's observation
    // toggle (Clerk publicMetadata.forgeObservationEnabled, surfaced
    // on the MCP side as context.org_settings.forgeObservationEnabled).
    // Three-valued semantics:
    //   - `null` (default) — cache miss. The stop-observer hook
    //     proceeds with the normal FORGE OBSERVATION directive; the
    //     MCP-side session_observer skill will read Clerk on the
    //     first Stop in this session and the gated path will write
    //     `false` here if the admin has disabled observation.
    //   - `false` — admin has disabled observation for this org.
    //     stop-observer.cjs exits silently on subsequent Stops
    //     without invoking session_observer again (zero MCP
    //     round-trips for the steady state).
    //   - `true` — admin has explicitly enabled (also the implicit
    //     default when no toggle is set). Same behavior as `null`
    //     for the hook: normal directive on every Stop.
    // Cache TTL is the session lifetime — no timestamp / invalidation
    // logic on either side. Admin toggles take effect at the next
    // Claude Code session start (which begins with a fresh state file).
    // Field name SHARED VERBATIM with SHI-741 (Cursor stop-observer.cjs
    // parity) — do NOT rename without coordinating both halves.
    forge_observation_enabled: null,
  };
}

/**
 * Remove state files older than CLEANUP_AGE_MS.
 * Runs on every read() — cheap because the directory is small.
 */
function cleanupStale() {
  try {
    const files = fs.readdirSync(STATE_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fp = path.join(STATE_DIR, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > CLEANUP_AGE_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch {
    // Best-effort cleanup — never block
  }
}

// -- Public API --------------------------------------------------------------

/**
 * Build a session-scoped state accessor. Pass the `session_id` from the
 * hook event; a falsy value yields the cwd-only fallback file.
 *
 * @param {string|undefined} sessionId — Claude Code session id
 * @returns {{ read: Function, write: Function, increment: Function, stateFilePath: string }}
 */
function forSession(sessionId) {
  const fp = statePath(sessionId);

  function writeRaw(state) {
    ensureDir();
    fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * Read this session's state.
   * Returns a fresh state if the file doesn't exist or is stale (> TTL_MS old).
   * Also triggers cleanup of stale files older than CLEANUP_AGE_MS.
   */
  function read() {
    ensureDir();
    cleanupStale();

    if (!fs.existsSync(fp)) {
      const state = freshState(sessionId);
      writeRaw(state);
      return state;
    }

    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const state = JSON.parse(raw);

      // Check staleness — if older than TTL, start a new session
      const age = Date.now() - new Date(state.session_start).getTime();
      if (age > TTL_MS) {
        const fresh = freshState(sessionId);
        writeRaw(fresh);
        return fresh;
      }

      return state;
    } catch {
      // Corrupted file — start fresh
      const state = freshState(sessionId);
      writeRaw(state);
      return state;
    }
  }

  /**
   * Merge updates into this session's state and persist.
   * @param {Object} updates — fields to merge (shallow)
   */
  function write(updates) {
    const state = read();
    Object.assign(state, updates);
    writeRaw(state);
    return state;
  }

  /**
   * Increment a numeric field by 1 and persist.
   * @param {string} field — the field name to increment
   */
  function increment(field) {
    const state = read();
    state[field] = (state[field] || 0) + 1;
    writeRaw(state);
    return state;
  }

  return { read, write, increment, stateFilePath: fp };
}

module.exports = { forSession };
