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
 * retain active workflow guards for the server-provided idle window, then
 * hold writes for recovery for at most a further grace period.
 * Passive and legacy session state still expires after 12 idle hours.
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
// Passive/legacy idle window, measured from the last local write. Active
// workflows with expiry metadata use confirmed server activity instead.
const TTL_MS = 12 * 60 * 60 * 1000;      // 12 hours idle
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — auto-clean stale files

// How long a recovery hold may wait for the server's answer after the run's
// own idle window has passed. By then the server has expired the run too, so
// the hold has nothing left to protect, and a hold whose answer never arrives
// must not block writes for good.
const RECOVERY_GRACE_MS = 12 * 60 * 60 * 1000;

function workflowTtl(state) {
  const days = state?.workflow_expiry?.days;
  return Number.isInteger(days) && days >= 1 && days <= 7 ? days * 86400000 : null;
}

function holdLapsed(idleMs, ttl) {
  return idleMs >= (ttl || TTL_MS) + RECOVERY_GRACE_MS;
}

function workflowTtl(state) {
  const days = state?.workflow_expiry?.days;
  return Number.isInteger(days) && days >= 1 && days <= 7 ? days * 86400000 : null;
}

function holdLapsed(idleMs, ttl) {
  return idleMs >= (ttl || TTL_MS) + RECOVERY_GRACE_MS;
}

// Older installed hooks delete root state files after one day. Keep a small
// recovery record below that cleanup boundary. Its presence restores a hold,
// never permission to write; only a server response can verify the run again.
// The record lapses with the hold it restores.
function recoveryPath(fp) { return path.join(STATE_DIR, 'workflow-recovery', path.basename(fp)); }
function recoverGuard(fp, sessionId, base = freshState(sessionId)) {
  try {
    const saved = JSON.parse(fs.readFileSync(recoveryPath(fp), 'utf8'));
    if (!saved.active_workflow || typeof saved.conversation_id !== 'string' || !saved.conversation_id) return null;
    let since = Date.parse(saved.workflow_activity_at);
    if (!Number.isFinite(since)) since = fs.statSync(recoveryPath(fp)).mtimeMs;
    if (holdLapsed(Date.now() - since, workflowTtl(saved))) return null;
    return { ...base, ...saved, step_resync_required: true, workflow_recovery_required: true };
  } catch { return null; }
}
function persistRecovery(fp, state) {
  const target = recoveryPath(fp);
  if (!state.active_workflow || (!workflowTtl(state) && !state.workflow_recovery_required)) {
    try { fs.unlinkSync(target); } catch { /* absent */ }
    return;
  }
  const saved = {};
  for (const key of ['active_workflow', 'conversation_id', 'workflow_expiry', 'workflow_activity_at']) saved[key] = state[key];
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(saved), { encoding: 'utf8', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, target); break; }
      catch (error) {
        if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } finally { try { fs.unlinkSync(temp); } catch { /* renamed or absent */ } }
}

function idleState(state, lastTouched, sessionId, fp) {
  // An older client may recreate a deleted root file as fresh/inactive. Only
  // a confirmed ending removes our protected record, so keep its hold.
  if (!state.active_workflow) {
    const recovery = recoverGuard(fp, sessionId, state);
    if (recovery) return recovery;
  }
  const ttl = state.active_workflow ? workflowTtl(state) : null;
  const confirmed = ttl && Date.parse(state.workflow_activity_at);
  const lastActivity = Number.isFinite(confirmed) ? confirmed : lastTouched;
  const idle = Date.now() - lastActivity;
  if (idle < (ttl || TTL_MS)) return state;
  // Local age is not proof that the server run ended. Keep its guard until
  // recovery confirms the step or its end, or until the hold lapses;
  // unrelated hooks cannot revive it.
  if (state.active_workflow && (ttl || state.workflow_recovery_required) && !holdLapsed(idle, ttl)) {
    return { ...state, step_resync_required: true, workflow_recovery_required: true };
  }
  return freshState(sessionId);
}
// -- Helpers -----------------------------------------------------------------

// TEMPORARY DIAGNOSTIC — remove once the cwd-change trigger is identified.
const TRACE_FILE = path.join(STATE_DIR, 'cwd-trace.jsonl');
const TRACE_MAX_BYTES = 2 * 1024 * 1024;
let tracedKey = null; // per-process: collapse repeat stateKey() calls to one line

/**
 * Record the cwd each hook process uses to key session state.
 *
 * `stateKey` mixes `process.cwd()` into the hash, so a cwd change mid-session
 * silently re-keys the state file: `active_workflow` / `status` are orphaned,
 * token capture stops (both the Stop-hook and workflow-guard paths gate on
 * them), and the guard's per-step tool allowlist fails OPEN. That has been
 * observed in the wild but the trigger is unknown — this makes it visible
 * after the fact.
 *
 * Lightweight by construction: one line per hook process (repeat calls within
 * a process are skipped), bounded by TRACE_MAX_BYTES, and fail-soft — a
 * diagnostic must never break a hook. Disable with FORGE_CWD_TRACE=0.
 */
function traceCwd(sessionId, cwd, key) {
  if (process.env.FORGE_CWD_TRACE === '0') return;
  if (tracedKey === key) return;
  tracedKey = key;
  try {
    ensureDir();
    if (fs.existsSync(TRACE_FILE) && fs.statSync(TRACE_FILE).size > TRACE_MAX_BYTES) return;
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify({
      t: new Date().toISOString(),
      hook: path.basename(process.argv[1] || '?', '.cjs'),
      pid: process.pid,
      sid: sessionId || null,
      cwd,
      key,
    })}\n`);
  } catch {
    /* diagnostics must never break a hook */
  }
}

/**
 * Compute the state file key.
 *
 * Keyed on the session id ALONE when one is available. The cwd is only a
 * fallback for the no-session case.
 *
 * It used to be `hash(cwd + ':' + sessionId)`, with the cwd there so that
 * "concurrent sessions in the same working directory get independent state" —
 * but the session id already guarantees that on its own, and mixing in a
 * MUTABLE runtime value meant the key could change underneath a live session.
 * When it did, the hook did not find the old state: it started a brand-new file
 * reporting no active workflow, which silently disabled token capture, the
 * per-step tool allowlist and the CHECKPOINT pin for the rest of the run.
 *
 * Confirmed rather than theorised: one real session produced two state files,
 * and both filenames were reproduced exactly by hashing this function's input —
 * one with the session's own worktree, one with a SECOND repository the run had
 * touched. Session id alone is stable for the session's whole life, so the key
 * no longer depends on where a hook process happens to be standing.
 */
function stateKey(sessionId) {
  const cwd = process.cwd();
  const material = sessionId || cwd;
  const key = crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
  traceCwd(sessionId, cwd, key);
  return key;
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `${stateKey(sessionId)}.json`);
}

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    // Codex: owner-private where the platform honours modes (POSIX; ignored on
    // Windows).
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  }
}

// Codex: rename-over on Windows fails with EPERM (EACCES/EBUSY on some
// filesystems) while another process has the target open — and the two
// PostToolUse hooks run concurrently on every tool call, so that is common,
// not rare. A dropped write here silently loses a workflow-completion reset
// and leaves a stale allowlist enforcing for hours. The contention window is
// microseconds; retry with a short bounded backoff (≤ ~180 ms total).
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 8;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err.code) || attempt >= RENAME_ATTEMPTS) throw err;
      sleepSync(5 * (attempt + 1));
    }
  }
}

function freshState(sessionId) {
  return {
    session_id: sessionId || crypto.randomUUID(),
    session_start: new Date().toISOString(),
    turn_count: 0,
    nudge_shown: false,
    // null | "snoozed" | "dismissed" | "linked" | "logged".
    // A soft decline ("not this one") is persisted AS "snoozed" so
    // the existing re-fire path picks it up unchanged; only the audit
    // `outcome` distinguishes it from an explicit snooze. "dismissed"
    // remains terminal and means "stop asking".
    status: null,
    // The user's own words for when a snoozed offer may return, and the work
    // item a linked session tracks. workflow-tracker.cjs records both from the
    // session_observer completion's `final_session_state`; prompt-router.cjs
    // quotes the first in its wake check and stop-observer.cjs puts the second
    // on every engineering-time checkpoint. null until the observer sets them.
    wake_condition: null,
    work_item_key: null,
    // Set when the user softly declines the observer offer. NOT
    // cleared by the snooze re-fire, so a returning offer can acknowledge
    // the earlier "no" instead of repeating itself verbatim (AC4).
    declined_once: false,
    // HEAD sha (or ref name) seen when this session was first
    // observed inside a repository. The git-milestone eligibility route in
    // stop-observer.cjs seeds it on first sight and advances it whenever a
    // milestone is consumed; null until then, and forever outside a repo.
    git_head_baseline: null,
    active_workflow: false,
    observer_blocked: false,
    // Codex-only passive queue/delivery state. Missing fields in older files
    // are treated as empty; delivered does not mean processed or authorized.
    observation_due: null,
    delivered_observation: null,
    observation_delivery: null,
    passive_checkpoint_due: null,
    delivered_checkpoint: null,
    checkpoint_delivery: null,
    last_stop_turn_id: null,
    last_passive_prompt_turn: null,
    last_checkpoint_turn: 0,
    last_observer_turn: null,
    last_checkpoint_at: null,
    conversation_id: null,   // Forge conversation ID for active workflow
    // Forge conversation ID of the observe_session run, kept after that
    // workflow completes (conversation_id above is nulled on completion).
    // The periodic Stop-hook checkpoint targets this so it works even
    // from a later process that never ran observe_session itself.
    // Only cleared by the 12h session-state TTL reset.
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
    // Optional wire metadata parsed from a CHECKPOINT response. Older servers
    // do not publish it; callers must retain the conservative fallback.
    pending_checkpoint_question_id: null,
    pending_checkpoint_response_field: null,
    // Approval authenticity — evidence the pinned question reached a
    // person: the host's question tool was called after the pin
    // (`pending_checkpoint_asked_at`, recorded by workflow-tracker), or a user
    // prompt arrived after it (`pending_checkpoint_user_turn_at`, recorded by
    // prompt-router — the numbered-reply fallback). workflow-guard refuses an
    // answer posted with neither: a relayed question is the user's to answer,
    // and a write plan "approved" by the model would be recorded as approved
    // by the user. Both reset when a different question is pinned.
    pending_checkpoint_asked_at: null,
    pending_checkpoint_user_turn_at: null,
    // Per-step tool-permission allowlist.
    //   - current_step_tools: array of category strings the orchestrator
    //     published in the latest **Tool Permissions** line, or null when
    //     unknown (workflow-guard fails open).
    //   - current_step_skill: bare skill_id of the active step, used in
    //     deny messages so the model knows which step is gating.
    current_step_tools: null,
    current_step_skill: null,
    // Write lock: `{ state: 'on'|'released', step_id }` parsed from
    // the server's `**Write Lock**` line, or null when no lock is known —
    // which is what an older server, or a step that writes nothing, leaves
    // here. workflow-guard treats null as unlocked, so a plugin ahead of its
    // server never blocks writes on its own initiative.
    write_lock: null,
    // True when an update_state reply to an active run carried no header this
    // plugin can trust — a saved-result pointer in place of an oversized
    // reply, a malformed or ambiguous older-server reply, a transport failure
    // — so the active step's permissions and write lock are unknown. Keeping
    // the previous step's would fail open (its shell and no lock, into a
    // locked step), so workflow-guard holds writes until
    // forge__get_workflow_state re-syncs.
    step_resync_required: false,
    // ── active time: step_active_since ──────────────────────────────────
    // ISO timestamp marking when the CURRENT workflow step began (the
    // client-side analog of the server's step start time). Set by
    // workflow-tracker.cjs on workflow start and on every genuine NEXT STEP
    // advance; NOT advanced on relayed-question CHECKPOINT/RE-ENTRY (the step
    // does not advance there). workflow-guard.cjs reads it as the lower bound
    // of the active-time window it stamps onto forge__update_state's
    // duration_ms. null until the first step begins.
    step_active_since: null,
    // ── observation gate contract: forge_observation_enabled ───────────
    // Per-Claude-Code-session cache of the org-admin's observation
    // toggle (an org setting the server reads and surfaces to the
    // session_observer skill).
    // Three-valued semantics:
    //   - `null` (default) — cache miss. The stop-observer hook
    //     proceeds with the normal FORGE OBSERVATION directive; the
    //     MCP-side session_observer skill will read the org setting on the
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
    // Field name shared verbatim with the Cursor stop-observer.cjs
    // (parity) — do NOT rename without coordinating both halves.
    forge_observation_enabled: null,
  };
}

/** Remove stale session files and recovery records without letting one bad file
 * prevent later entries from being cleaned. Runs on every read(). */
function cleanupStale() {
  const now = Date.now();
  for (const [dir, recovery] of [[STATE_DIR, false], [path.join(STATE_DIR, 'workflow-recovery'), true]]) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      // Codex sidecars expire on the ordinary cleanup window.
      if (!file.endsWith('.json') && !( !recovery && ['.tmp', '.display', '.attempt'].some(ext => file.endsWith(ext)))) continue;
      const fp = path.join(dir, file);
      try {
        const stat = fs.statSync(fp);
        if (!file.endsWith('.json')) {
          if (now - stat.mtimeMs > CLEANUP_AGE_MS) fs.unlinkSync(fp);
          continue;
        }
        if (!recovery && now - stat.mtimeMs <= CLEANUP_AGE_MS) continue;
        let state;
        try { state = JSON.parse(fs.readFileSync(fp, 'utf8')); }
        catch {
          // A corrupt recent recovery record might still be rewritten by an
          // active hook; only remove it after the ordinary cleanup window.
          if (now - stat.mtimeMs > CLEANUP_AGE_MS) fs.unlinkSync(fp);
          continue;
        }
        const lastActivity = Date.parse(state.workflow_activity_at);
        const since = Number.isFinite(lastActivity) ? lastActivity : stat.mtimeMs;
        const active = state.active_workflow && (workflowTtl(state) || state.workflow_recovery_required);
        if (active && !holdLapsed(now - since, workflowTtl(state))) continue;
        if (recovery && !active && now - stat.mtimeMs <= CLEANUP_AGE_MS) continue;
        fs.unlinkSync(fp);
      } catch {
        // Best-effort cleanup is per file: another hook may have changed it.
      }
    }
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
// Codex: atomic replace. The temp file is owner-private (0600 where honoured)
// and renamed over the target, so a reader never sees a torn write. Exported
// because the sidecars beside the state file deserve the same treatment.
function writeFileAtomic(fp, contents) {
  ensureDir();
  const temporary = `${fp}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(temporary, fp);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}

function forSession(sessionId) {
  const fp = statePath(sessionId);

  function withLock(action) {
    const lock = `${fp}.lock`; const deadline = Date.now() + 750;
    while (true) {
      try { fs.mkdirSync(lock); break; } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* released concurrently */ }
        if (Date.now() >= deadline) throw new Error('Timed out acquiring Forge session-state lock');
        sleepSync(10);
      }
    }
    try { return action(); } finally { try { fs.rmdirSync(lock); } catch { /* best effort */ } }
  }

  // Same idle expiry as read(): the first write after the idle window must not
  // merge into, and so revive, the dead session's workflow, CHECKPOINT pin and
  // allowlist. An expired file is replaced even when unreadable.
  function readForWrite() {
    if (!fs.existsSync(fp)) return recoverGuard(fp, sessionId) || freshState(sessionId);
    let last;
    for (let i = 0; i < 4; i += 1) {
      try { return idleState(JSON.parse(fs.readFileSync(fp, 'utf8')), fs.statSync(fp).mtimeMs, sessionId, fp); } catch (error) { last = error; sleepSync(10); }
    }
    const recovery = recoverGuard(fp, sessionId);
    if (recovery) return recovery;
    if (Date.now() - fs.statSync(fp).mtimeMs > TTL_MS) return freshState(sessionId);
    throw new Error(`Forge session state is unreadable; refusing to overwrite it: ${last?.message || 'parse failure'}`);
  }

  function writeRaw(state) {
    persistRecovery(fp, state);
    writeFileAtomic(fp, JSON.stringify(state, null, 2));
  }

  /**
   * Read this session's state.
   * Applies the passive/legacy idle window and preserves active workflow
   * recovery holds. Also cleans old files without active recovery state.
   *
   * Pure read — never persists. A read that materialised state made "never
   * seen this session" indistinguishable from "seen it, and it says no
   * workflow is running": a hook firing under a new key did not merely miss the
   * state, it wrote a decoy that then looked like a legitimate fresh session.
   * That is what made a re-key silently disable token capture and the guard's
   * per-step allowlist rather than surfacing as an error. The file is now
   * created by the first write() instead, so an absent file means exactly
   * that, and callers can tell the two apart.
   */
  function read() {
    ensureDir();
    cleanupStale();

    if (!fs.existsSync(fp)) return recoverGuard(fp, sessionId) || freshState(sessionId);

    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const state = JSON.parse(raw);

      // Passive/legacy sessions use local mtime; active runs use their last
      // server-confirmed activity and retain a recovery hold after expiry.
      let lastTouchedMs;
      try {
        lastTouchedMs = fs.statSync(fp).mtimeMs;
      } catch {
        lastTouchedMs = new Date(state.session_start).getTime();
      }
      return idleState(state, lastTouchedMs, sessionId, fp);
    } catch {
      // Preserve a protected recovery hold if the root cannot be read.
      return recoverGuard(fp, sessionId) || freshState(sessionId);
    }
  }

  /**
   * Merge updates into this session's state and persist.
   * @param {Object} updates — fields to merge (shallow)
   */
  function write(updates) {
    return withLock(() => { const state = readForWrite(); Object.assign(state, updates); writeRaw(state); return state; });
  }

  /**
   * Increment a numeric field by 1 and persist.
   * @param {string} field — the field name to increment
   */
  function increment(field) {
    return withLock(() => { const state = readForWrite(); state[field] = (state[field] || 0) + 1; writeRaw(state); return state; });
  }

  return { read, write, increment, stateFilePath: fp };
}

module.exports = { forSession, writeFileAtomic };
