#!/usr/bin/env node

/**
 * session-state.js — Shared session state module for Forge plugin hooks.
 *
 * Manages a local JSON state file per working directory, used by both
 * detect-forge.js (active mode) and session-observer.js (passive mode)
 * to coordinate and avoid conflicts.
 *
 * State files live in {os.tmpdir()}/forge-observer/{hash(cwd)}.json
 * and auto-expire after 4 hours (matching Forge's server-side TTL).
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

function hashCwd() {
  const cwd = process.cwd();
  return crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

function statePath() {
  return path.join(STATE_DIR, `${hashCwd()}.json`);
}

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function freshState() {
  return {
    session_id: crypto.randomUUID(),
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
    // user-question relay). Cleared on **RE-ENTRY** (answer flowed back),
    // normal step advance, workflow completion, or abandonment.
    // The future workflow-guard PreToolUse hook reads this to deny
    // tool calls other than user-question relay / forge__update_state /
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
  };
}

// -- Public API --------------------------------------------------------------

/**
 * Read the current session state.
 * Returns a fresh state if the file doesn't exist or is stale (> TTL_MS old).
 * Also triggers cleanup of stale files older than CLEANUP_AGE_MS.
 */
function read() {
  ensureDir();
  cleanupStale();

  const fp = statePath();
  if (!fs.existsSync(fp)) {
    const state = freshState();
    writeRaw(state);
    return state;
  }

  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const state = JSON.parse(raw);

    // Check staleness — if older than TTL, start a new session
    const age = Date.now() - new Date(state.session_start).getTime();
    if (age > TTL_MS) {
      const fresh = freshState();
      writeRaw(fresh);
      return fresh;
    }

    return state;
  } catch {
    // Corrupted file — start fresh
    const state = freshState();
    writeRaw(state);
    return state;
  }
}

/**
 * Merge updates into the current session state and persist.
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

// -- Internal ----------------------------------------------------------------

function writeRaw(state) {
  ensureDir();
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
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

module.exports = { read, write, increment };
