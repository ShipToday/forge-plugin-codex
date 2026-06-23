#!/usr/bin/env node

/**
 * token-usage.cjs
 *
 * Per-tool token capture adapters behind one interface. Called from the
 * Stop/SubagentStop hook (stop-observer.cjs) to extract a session's raw,
 * un-weighted token components from the local transcript, piggybacked on the
 * existing checkpoint directive (no new hook, no new directive).
 *
 * Design (architecture decision #3/#4):
 *   - **Raw components only** — input / cache_read / cache_creation (TTL-split
 *     5m+1h) / output + model_name. Never a pre-weighted number; weighting is
 *     applied at read on the server.
 *   - **Per-tool adapters** — Claude Code reads `transcript_path` + per-turn
 *     `message.usage` (+ `subagents/agent-*.jsonl`); Codex reads its
 *     `rollout-*.jsonl`; Cursor exposes no token usage today → null.
 *   - **Cumulative snapshot** — we re-derive the session total from the whole
 *     transcript each checkpoint. The read side takes latest-per-session, so a
 *     missed checkpoint never under-counts and a re-emitted one never
 *     double-counts (the snapshot is cumulative, not additive).
 *   - **Fail soft** — any parse/IO error returns null and is swallowed by the
 *     caller; token capture must NEVER crash the hook or block the session
 *     (NFR: error handling / observability).
 *
 * Pure-ish: only reads local files. No network, no external deps.
 *
 * ── Codex build localization ─────────────────────────────────────────────
 * This copy ships in the Codex plugin. resolveSessionRecords() is FIXED to
 * the Codex adapter, and resolveCodexRolloutPath() locates the session's
 * rollout file from the hook event (Codex's stdin mirrors Claude Code's and
 * passes the rollout as `transcript_path`) or, failing that, by a bounded
 * scan of ~/.codex/sessions keyed on the event's session_id. Everything
 * else is identical to the Claude Code source — keep it that way on every
 * plugin sync (/shiptoday-plugin).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Guard against pathological transcripts: cap bytes read per file so a
// runaway log can't add perceptible delay to the checkpoint turn (NFR:
// bounded parsing). 32 MiB covers very long sessions; beyond that we accept a
// slightly stale-but-bounded estimate rather than blocking.
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/**
 * Accumulate Claude `message.usage` across an array of parsed JSONL records.
 * Mutates and returns `acc`.
 *
 * **Deduplication is mandatory** (empirically validated 2026-06-05). Claude
 * Code writes ONE transcript line per content block, and every line of a single
 * turn repeats the SAME `requestId` / `message.id` carrying IDENTICAL `usage`.
 * A naive per-line sum overcounts 2.5–5× (Anthropic's own guidance: "always
 * deduplicate by ID"). So we GROUP by request, take the per-field MAX within a
 * group (robust to streaming snapshots where usage grows across lines for the
 * same request), THEN sum across distinct requests → the cumulative session
 * total. Records with no request id are each their own group (anon key).
 *
 * Recognizes both the split cache-creation shape
 * (`usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_…`) and
 * the flat `cache_creation_input_tokens` (older transcripts) — flat counts
 * land in `cacheCreationFlat` so the read side can mark them approximate.
 */
function groupByRequest(records) {
  const groups = new Map();
  let anon = 0;
  for (const rec of records) {
    const usage = rec && rec.message && rec.message.usage;
    if (!usage) continue;
    const key = rec.requestId || (rec.message && rec.message.id) || `__anon_${anon++}`;
    const g = groups.get(key) ||
      { input: 0, cacheRead: 0, output: 0, cc5m: 0, cc1h: 0, ccFlat: 0, model: null };
    // Per-field MAX within a request (streaming snapshots grow monotonically).
    g.input = Math.max(g.input, toInt(usage.input_tokens));
    g.cacheRead = Math.max(g.cacheRead, toInt(usage.cache_read_input_tokens));
    g.output = Math.max(g.output, toInt(usage.output_tokens));
    const cc = usage.cache_creation;
    if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
      g.cc5m = Math.max(g.cc5m, toInt(cc.ephemeral_5m_input_tokens));
      g.cc1h = Math.max(g.cc1h, toInt(cc.ephemeral_1h_input_tokens));
    } else {
      g.ccFlat = Math.max(g.ccFlat, toInt(usage.cache_creation_input_tokens));
    }
    const model = rec.message.model;
    if (model) g.model = model;
    groups.set(key, g);
  }
  return groups;
}

/**
 * Sum deduped request groups into a single combined accumulator. Last-seen
 * model wins (Map preserves order). Retained for the back-compat combined
 * component fields on the capture result.
 */
function accumulateClaudeUsage(records, acc) {
  for (const g of groupByRequest(records).values()) {
    acc.input += g.input;
    acc.cacheRead += g.cacheRead;
    acc.output += g.output;
    acc.cacheCreation5m += g.cc5m;
    acc.cacheCreation1h += g.cc1h;
    acc.cacheCreationFlat += g.ccFlat;
    if (g.model) acc.modelName = g.model;
  }
  return acc;
}

/**
 * Per-model attribution: bucket deduped request groups into a
 * `Map<model_name, acc>` so a delegated session (e.g. Opus main agent +
 * Sonnet sub-agent) is attributed PER model rather than collapsing to one
 * `model_name`. Each request's tokens belong wholly to its own model; the
 * orchestrator later writes one token_usage row per model so the read side
 * can weight each slice with its own price profile.
 */
function accumulateClaudeUsageByModel(records, byModelMap) {
  for (const g of groupByRequest(records).values()) {
    const model = g.model || '__unknown__';
    const acc = byModelMap.get(model) || freshAcc();
    acc.input += g.input;
    acc.cacheRead += g.cacheRead;
    acc.output += g.output;
    acc.cacheCreation5m += g.cc5m;
    acc.cacheCreation1h += g.cc1h;
    acc.cacheCreationFlat += g.ccFlat;
    acc.modelName = model === '__unknown__' ? null : model;
    byModelMap.set(model, acc);
  }
  return byModelMap;
}

/**
 * Convert a per-model accumulator map into a list of non-empty per-model
 * component bags — the shape the hook relays and the orchestrator writes one
 * audit row from per entry.
 */
function byModelList(byModelMap) {
  const list = [];
  for (const acc of byModelMap.values()) {
    if (!(acc.input || acc.cacheRead || acc.cacheCreation5m
        || acc.cacheCreation1h || acc.cacheCreationFlat || acc.output)) continue;
    list.push({
      modelName: acc.modelName,
      input: acc.input,
      cacheRead: acc.cacheRead,
      cacheCreation5m: acc.cacheCreation5m,
      cacheCreation1h: acc.cacheCreation1h,
      cacheCreationFlat: acc.cacheCreationFlat,
      output: acc.output,
    });
  }
  return list;
}

/**
 * Read a JSONL file and return parsed records plus whether the read was
 * TAIL-TRUNCATED by MAX_TRANSCRIPT_BYTES. Truncation drops the OLDEST
 * records — safe for cumulative token snapshots (the freshest lines carry
 * the totals) but NOT for active-time gap sums, where losing the start of a
 * measurement window silently collapses real activity (review #8). The
 * `truncated` flag lets active-time.cjs fall back to wall-clock when it
 * can't prove window-start coverage.
 */
function readJsonlEx(filePath) {
  let raw;
  let truncated = false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { records: [], truncated: false };
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = Math.min(stat.size, MAX_TRANSCRIPT_BYTES);
      truncated = stat.size > MAX_TRANSCRIPT_BYTES;
      const buf = Buffer.allocUnsafe(len);
      // Read the TAIL when the file exceeds the cap — recent turns carry the
      // freshest cumulative usage and the active model.
      const position = truncated ? stat.size - len : 0;
      fs.readSync(fd, buf, 0, len, position);
      raw = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { records: [], truncated: false };
  }
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Partial first line (when we read the tail) or a corrupt line — skip.
    }
  }
  return { records, truncated };
}

/** Back-compat reader: parsed records only (skips malformed lines). */
function readJsonl(filePath) {
  return readJsonlEx(filePath).records;
}

/**
 * Collect ALL parsed transcript records for a Claude Code session — the main
 * transcript plus any sub-agent transcripts in
 * `<transcript_dir>/subagents/agent-*.jsonl` — as a single flat array.
 *
 * The on-disk sub-agent layout is Claude-Code-version-dependent (NFR: "treat
 * the subagents/ path as version-fragile"). Two layouts seen in the wild:
 *   - legacy:  <dir>/subagents/agent-*.jsonl            (sibling of the file)
 *   - current: <dir>/<session-id>/subagents/agent-*.jsonl
 *              (a directory BESIDE the main <session-id>.jsonl, named after
 *               the session — i.e. transcriptPath with `.jsonl` stripped)
 * The old single-path lookup (legacy only) silently dropped ALL delegated/
 * sub-agent records (the multi-model gap). Probe the nested layout first,
 * then the legacy sibling, and use the FIRST that exists so a session's
 * sub-agent files are never read twice.
 *
 * Shared by the token adapter (reads `message.usage`) and the active-time
 * module (reads `timestamp`) so this fragile path logic lives in ONE place.
 *
 * @returns {Array<object>} parsed JSONL records (possibly empty).
 */
function collectClaudeRecordsEx(transcriptPath) {
  if (!transcriptPath) return { records: [], truncated: false };
  const main = readJsonlEx(transcriptPath); // fresh array per call — safe to extend
  const records = main.records;
  let truncated = main.truncated;
  const subDirCandidates = [
    path.join(transcriptPath.replace(/\.jsonl$/i, ''), 'subagents'),
    path.join(path.dirname(transcriptPath), 'subagents'),
  ];
  for (const subDir of subDirCandidates) {
    try {
      if (!fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) continue;
      for (const f of fs.readdirSync(subDir)) {
        if (f.startsWith('agent-') && f.endsWith('.jsonl')) {
          const sub = readJsonlEx(path.join(subDir, f));
          for (const rec of sub.records) records.push(rec);
          truncated = truncated || sub.truncated;
        }
      }
      break; // first matching layout wins — don't double-read across layouts
    } catch {
      // Unreadable candidate — try the next; main-agent records stay valid.
    }
  }
  return { records, truncated };
}

/** Back-compat: records only. */
function collectClaudeRecords(transcriptPath) {
  return collectClaudeRecordsEx(transcriptPath).records;
}

/**
 * Claude Code adapter (records-based core) — sum main + sub-agent records
 * into one session total (combined component fields + per-model attribution).
 *
 * @returns {object|null} raw components + modelName, or null when nothing parseable.
 */
function captureClaudeFromRecords(records) {
  if (!records || !records.length) return null;
  const acc = freshAcc();
  const byModelMap = new Map();
  accumulateClaudeUsage(records, acc);                 // combined (back-compat fields)
  accumulateClaudeUsageByModel(records, byModelMap);   // per-model attribution
  const result = finalize(acc);
  if (result) result.byModel = byModelList(byModelMap);
  return result;
}

/** Path-based wrapper (kept for tests / direct callers). */
function captureClaude(transcriptPath) {
  if (!transcriptPath) return null;
  return captureClaudeFromRecords(collectClaudeRecords(transcriptPath));
}

/**
 * Codex adapter (records-based core) — OpenAI rollout records. `token_count`
 * events are CUMULATIVE, so we take the LAST event rather than summing.
 * OpenAI reports `input` as the grand total INCLUDING cached input
 * (cached ⊆ input), so the un-cached input is `input - cached`.
 * No cache-creation concept → those stay 0.
 *
 * @returns {object|null}
 */
function captureCodexFromRecords(records) {
  let last = null;
  let modelName = null;
  for (const rec of records || []) {
    const tc = extractCodexTokenCount(rec);
    if (tc) last = tc; // CUMULATIVE — last event wins (summing overcounts ~19.6x)
    const m = extractCodexModel(rec);
    if (m) modelName = m;
  }
  if (!last) return null;
  // OpenAI reports `input_tokens` as the TOTAL prompt INCLUDING cached input
  // (cached ⊆ input, unlike Claude's separate buckets). Store un-cached input
  // only, or read-time weighting double-counts the cache-dominated bulk.
  const totalInput = toInt(last.input_tokens);
  const cached = toInt(last.cached_input_tokens);
  const acc = freshAcc();
  acc.input = Math.max(0, totalInput - cached);
  acc.cacheRead = cached;
  // reasoning_output ⊆ output_tokens, so output already includes it — no
  // separate column needed. No cache-creation concept in OpenAI's model.
  acc.output = toInt(last.output_tokens);
  acc.modelName = modelName;
  const result = finalize(acc);
  // Codex is single-model per session — emit a one-element byModel so the
  // orchestrator's per-model write path is uniform across adapters.
  if (result) {
    result.byModel = [{
      modelName: result.modelName,
      input: result.input,
      cacheRead: result.cacheRead,
      cacheCreation5m: result.cacheCreation5m,
      cacheCreation1h: result.cacheCreation1h,
      cacheCreationFlat: result.cacheCreationFlat,
      output: result.output,
    }];
  }
  return result;
}

/** Path-based wrapper (kept for tests / direct callers). */
function captureCodex(rolloutPath) {
  if (!rolloutPath) return null;
  return captureCodexFromRecords(readJsonl(rolloutPath));
}

/**
 * Pull the cumulative token usage out of a Codex rollout record. The validated
 * schema (2026-06-05) is `payload.type='token_count'` →
 * `payload.info.total_token_usage.{input_tokens, cached_input_tokens,
 * output_tokens, ...}`. Tolerant of a few simpler/nested shapes for forward/
 * backward compat.
 */
function extractCodexTokenCount(rec) {
  if (!rec) return null;
  const payload = rec.payload || rec;
  if (payload && payload.type === 'token_count' && payload.info && payload.info.total_token_usage) {
    return payload.info.total_token_usage;
  }
  // Fallbacks: direct total_token_usage, or a flat token_count object.
  const cand = (payload && payload.total_token_usage) ||
    payload.token_count || rec.token_count || null;
  if (cand && (cand.input_tokens != null || cand.output_tokens != null)) return cand;
  return null;
}

/** Resolve the model from a `turn_context` event (null on pre-Sept-2025 builds). */
function extractCodexModel(rec) {
  if (!rec) return null;
  const payload = rec.payload || rec;
  if (payload) {
    if (payload.turn_context && payload.turn_context.model) return payload.turn_context.model;
    if (payload.type === 'turn_context' && payload.model) return payload.model;
    if (payload.model) return payload.model;
  }
  return rec.model || null;
}

/**
 * ── Codex build localization ─────────────────────────────────────────────
 * Resolve the Codex rollout (session log) for a hook event. Codex's hook
 * stdin mirrors Claude Code's schema, so when a path is present it arrives
 * as `transcript_path` — but it points at the Codex rollout
 * (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl), never at
 * a Claude transcript. Some events carry no path at all, so fall back to a
 * bounded filename scan of the recent session-date dirs keyed on the
 * event's `session_id` — rollout filenames embed the session id, so the
 * match needs no file reads. Newest day first; within a day the
 * lexicographically last match wins (filenames lead with an ISO timestamp).
 * Sessions can span midnight (the rollout stays in its start-date dir), so
 * today plus the two prior days are probed.
 *
 * @param {object} event - Stop/PreToolUse hook event.
 * @returns {string|null} absolute rollout path, or null when unresolvable.
 */
function resolveCodexRolloutPath(event) {
  const explicit = event.codex_rollout_path || event.rollout_path || event.transcript_path;
  if (explicit) {
    try {
      if (fs.statSync(explicit).isFile()) return explicit;
    } catch {
      // Stale/unreadable path — fall through to the session-id scan.
    }
  }
  const sessionId = event.session_id;
  if (!sessionId) return null;
  try {
    const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    for (let i = 0; i < 3; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dir = path.join(
        sessionsRoot,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')
      );
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue; // no sessions recorded that day
      }
      const match = names
        .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl') && f.includes(sessionId))
        .sort()
        .pop();
      if (match) return path.join(dir, match);
    }
  } catch {
    // Unresolvable — capture degrades to null (fail-soft).
  }
  return null;
}

/**
 * Resolve a hook event's session log into parsed records — ONE read shared
 * by token capture AND active-time.
 *
 * Codex build: the host client IS Codex, so the session log is always a
 * rollout-*.jsonl and dispatch is FIXED to the Codex adapter. (The Claude
 * source's client-sniffing ladder would mis-classify Codex's
 * `transcript_path` — which points at the rollout — as a Claude transcript
 * and capture nothing.)
 *
 * `truncated` reports whether the file was tail-truncated by
 * MAX_TRANSCRIPT_BYTES — consumed by active-time's window-coverage guard.
 *
 * @param {object} event - Stop/PreToolUse hook event (or a synthetic one in tests).
 * @returns {{kind: 'codex', records: Array<object>, truncated: boolean}|null}
 */
function resolveSessionRecords(event) {
  try {
    if (!event || typeof event !== 'object') return null;
    const rollout = resolveCodexRolloutPath(event);
    if (!rollout) return null;
    const { records, truncated } = readJsonlEx(rollout);
    return records.length ? { kind: 'codex', records, truncated } : null;
  } catch {
    return null; // never throw into a hook
  }
}

/**
 * Token components from an ALREADY-resolved session log — the single-read
 * path for callers that also feed the same records to active-time.
 *
 * @param {{kind: string, records: Array<object>}|null} resolved
 * @returns {object|null} `{ input, cacheRead, cacheCreation5m, cacheCreation1h,
 *   cacheCreationFlat, output, modelName, byModel }` or null.
 */
function captureTokenUsageFromResolved(resolved) {
  try {
    if (!resolved) return null;
    return resolved.kind === 'codex'
      ? captureCodexFromRecords(resolved.records)
      : captureClaudeFromRecords(resolved.records);
  } catch {
    return null; // never throw into the hook
  }
}

/** Single entry point: resolve the event's log, then capture (one read). */
function captureTokenUsage(event) {
  try {
    return captureTokenUsageFromResolved(resolveSessionRecords(event));
  } catch {
    return null; // never throw into the hook
  }
}

function freshAcc() {
  return {
    input: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0,
    cacheCreationFlat: 0, output: 0, modelName: null,
  };
}

/** Return null when no signal was found, otherwise the component bag. */
function finalize(acc) {
  const any = acc.input || acc.cacheRead || acc.cacheCreation5m ||
    acc.cacheCreation1h || acc.cacheCreationFlat || acc.output;
  if (!any) return null;
  return acc;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

module.exports = {
  captureTokenUsage,
  captureTokenUsageFromResolved,
  resolveSessionRecords,
  resolveCodexRolloutPath,
  captureClaude,
  captureCodex,
  collectClaudeRecords,
  accumulateClaudeUsage,
  accumulateClaudeUsageByModel,
  // exported for tests
  _readJsonl: readJsonl,
};
