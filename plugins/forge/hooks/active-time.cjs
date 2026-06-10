#!/usr/bin/env node

/**
 * active-time.cjs — R1 idle-excluded engineering-time measurement.
 *
 * Forge records `duration_ms` as raw wall-clock between two coarse activity
 * markers (step issued → step completed; checkpoint → checkpoint). Any wait
 * inside that window — a build, a coffee, an overnight pause — is counted as
 * engineering time, which inflates `total_ai_time_ms` AND deflates the
 * cost-per-minute the dashboard now derives from `SUM(duration_ms)`.
 *
 * This module derives ACTIVE time instead: it reads the local AI-client session
 * log (the SAME files token-usage.cjs already parses) and sums the gaps between
 * consecutive timestamped records WITHIN the window, capping any gap longer
 * than IDLE_CAP_MS. A 3-hour idle between records collapses to one ~5-minute
 * segment; back-to-back work is unaffected. The lead-in gap (window start →
 * first record) is deliberately NOT credited: at a window boundary it is
 * indistinguishable from idle (a pure-idle checkpoint window with one trivial
 * prompt would otherwise bank ~IDLE_CAP_MS of phantom time per checkpoint —
 * ~50% of an idle day at the checkpoint cadence), while in genuinely active
 * windows the first record lands within seconds of the boundary, so the loss
 * is negligible. Under-count is the accepted failure direction. A window with
 * no records (or one record) yields 0.
 *
 * Both client tiers carry the signal it needs (verified on disk):
 *   - Claude Code transcript records: top-level ISO-8601 `timestamp`.
 *   - Codex rollout records: the SAME top-level `timestamp` (`{timestamp,type,payload}`).
 *   - Cursor: no session log → null (caller falls back to server wall-clock).
 *
 * Design:
 *   - **Pure / read-only** — only reads local files; no network, no deps.
 *   - **Fail-soft** — any parse/IO error returns `null`; the caller then keeps
 *     today's wall-clock value. Active-time must NEVER crash a hook or block a
 *     session (NFR: error handling / observability).
 *   - **Deterministic core** — the math takes records + sinceMs (+ optional
 *     nowMs upper bound); no Date.now() inside the gap sum, so it is unit-testable.
 *
 * @see plugin/hooks/token-usage.cjs   for the shared transcript reader + adapters
 * @see plugin/hooks/workflow-guard.cjs for the PreToolUse duration_ms stamp (workflow steps)
 * @see plugin/hooks/stop-observer.cjs  for the Stop checkpoint delta (observer sessions)
 */

'use strict';

const { resolveSessionRecords } = require('./token-usage.cjs');

// Gaps longer than this between timestamped records are treated as idle and
// clamped to this value. 5 minutes: a silent gap that long almost always means
// "nobody's working" (waiting on a human, stepped away). Tunable — smaller
// excludes more idle but risks clipping a rare long silent tool run (e.g. a
// multi-minute test suite emits no transcript heartbeat until it returns);
// larger readmits idle. Even at 5 min a 3-hour gap is cut by ~97%.
const IDLE_CAP_MS = 5 * 60 * 1000;

/** Non-negative, idle-capped single gap. */
function clampGap(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms > IDLE_CAP_MS ? IDLE_CAP_MS : ms;
}

/**
 * Active milliseconds within [sinceMs, nowMs] across a set of timestamped
 * records. Parses each record's top-level `timestamp`, drops un-parseable /
 * out-of-window values, sorts (records can interleave out of order), and sums
 * each gap BETWEEN consecutive records capped at IDLE_CAP_MS.
 *
 * Both window brackets are FILTERS only, never credited segments (review #3):
 *   - The lead-in gap (sinceMs → first record) is NOT counted. At a window
 *     boundary it is indistinguishable from idle — crediting it (capped) let a
 *     pure-idle checkpoint window with one trivial prompt bank ~IDLE_CAP_MS of
 *     phantom "active" time per checkpoint (~50% of an idle day, since the cap
 *     is half the checkpoint time floor). In active windows the first record
 *     lands within seconds of the boundary, so dropping it loses ~nothing.
 *   - The upper bracket only filters future/clock-skewed rows; it is NOT added
 *     as a trailing segment.
 * Consequently a window with no records — or only one — returns 0.
 *
 * @param {Array<object>} records  parsed JSONL records (each may have `timestamp`)
 * @param {number} sinceMs         window start (epoch ms)
 * @param {number} [nowMs]         upper bound (epoch ms); defaults to Date.now()
 * @returns {number} active ms, rounded (0 when no in-window activity)
 */
function activeMsFromRecords(records, sinceMs, nowMs) {
  if (!Array.isArray(records) || !Number.isFinite(sinceMs)) return 0;
  const upper = Number.isFinite(nowMs) ? nowMs : Date.now();
  const pts = records
    .map((r) => Date.parse(r && r.timestamp))
    .filter((t) => Number.isFinite(t) && t >= sinceMs && t <= upper)
    .sort((a, b) => a - b);
  let active = 0;
  let prev = null;
  for (const t of pts) {
    if (prev !== null) active += clampGap(t - prev);
    prev = t;
  }
  return Math.round(active);
}

/**
 * Active ms from an ALREADY-resolved session log (see token-usage.cjs
 * `resolveSessionRecords`) — the single-read path: workflow-guard and
 * stop-observer resolve the log once per invocation and feed the same records
 * to BOTH token capture and this function, instead of re-reading and
 * re-parsing multi-MiB files twice (review #10).
 *
 * Truncated-log guard (review #8): the shared reader tail-reads files larger
 * than its byte cap, dropping the OLDEST records. That is safe for cumulative
 * token snapshots but NOT for gap sums — records lost at the start of the
 * window would silently erase real activity (the surviving tail still
 * produces a finite number, so no fallback would engage). When the log was
 * truncated and no surviving record sits at/before `sinceMs` (i.e. coverage
 * of the window start cannot be proven), return null so the caller keeps the
 * wall-clock fallback — documented degradation beats a silent undercount.
 *
 * @param {{kind: string, records: Array<object>, truncated: boolean}|null} resolved
 * @param {number} sinceMs window start (epoch ms) — step start or last checkpoint
 * @param {number} [nowMs] upper bound (epoch ms); defaults to Date.now()
 * @returns {number|null} active ms, or null when no usable / fully-covering log
 */
function activeMsFromResolved(resolved, sinceMs, nowMs) {
  try {
    if (!resolved || !Number.isFinite(sinceMs)) return null;
    if (resolved.truncated) {
      let earliest = Infinity;
      for (const r of resolved.records) {
        const t = Date.parse(r && r.timestamp);
        if (Number.isFinite(t) && t < earliest) earliest = t;
      }
      if (!(earliest <= sinceMs)) return null; // window start not covered
    }
    return activeMsFromRecords(resolved.records, sinceMs, nowMs);
  } catch {
    return null; // never throw into a hook
  }
}

/**
 * Single entry point for one-shot callers: resolve the event's session log
 * (same dispatch ladder as token capture — Claude transcript, Codex rollout,
 * Cursor/unknown → null) and compute the active window.
 *
 * @param {object} event   Stop / PreToolUse hook event (or a synthetic test one)
 * @param {number} sinceMs window start (epoch ms) — step start or last checkpoint
 * @param {number} [nowMs] upper bound (epoch ms); defaults to Date.now()
 * @returns {number|null} active ms, or null when no usable session log
 */
function activeMsFromEvent(event, sinceMs, nowMs) {
  try {
    return activeMsFromResolved(resolveSessionRecords(event), sinceMs, nowMs);
  } catch {
    return null; // never throw into a hook
  }
}

module.exports = {
  activeMsFromEvent,
  activeMsFromResolved,
  IDLE_CAP_MS,
  // exported for tests
  _activeMsFromRecords: activeMsFromRecords,
  _clampGap: clampGap,
};
