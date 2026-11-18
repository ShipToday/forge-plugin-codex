'use strict';

// Keep the shared classifier/hash contract in observed-calls.cjs unchanged.
// Codex shell hooks carry program output, not the model-facing exit header;
// only structured status or a matching persisted runtime receipt is evidence.
const shared = require('./observed-calls.cjs');
const { randomBytes } = require('node:crypto');

const SHELL = /^(?:Bash|PowerShell|Shell)$/;
const PATCH = /^(?:functions\.)?apply_patch$/;

function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function structuredExit(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)
      || response.isError || response.is_error || response.interrupted || response.backgroundTaskId != null) return null;
  for (const field of ['exit_code', 'exitCode', 'returnCode', 'return_code']) {
    if (Number.isInteger(response[field]) && Math.abs(response[field]) <= 2147483647) return response[field];
  }
  return null;
}

function observationFor(event, now = Date.now()) {
  if (!event || event.hook_event_name === 'PostToolUseFailure') return null;
  if (SHELL.test(event.tool_name || '')) {
    const input = object(event.tool_input);
    let command = input?.command ?? input?.cmd;
    if (Array.isArray(command) && command.every(part => typeof part === 'string')) command = command.join(' ');
    const hash = shared.commandHash(command);
    if (!hash) return null;
    const exit = input?.run_in_background === true ? null : structuredExit(event.tool_response);
    return { id: randomBytes(8).toString('hex'), ts: now, kind: 'shell', hash,
      exit_code: exit, test_runner: shared.isTestRunner(command), codex_exit_verified: exit !== null,
      ...(typeof event.tool_use_id === 'string' && event.tool_use_id.length <= 256
        ? { codex_call_id: event.tool_use_id } : {}) };
  }
  if (PATCH.test(event.tool_name || '')) {
    const response = object(event.tool_response);
    if (response?.isError || response?.is_error) return null;
    const input = object(event.tool_input);
    const patch = input?.command ?? input?.input ?? input?.patch ?? event.tool_input;
    if (typeof patch !== 'string' || patch.length > 1024 * 1024) return null;
    const normalized = patch.replace(/\r\n/g, '\n');
    if (!normalized.startsWith('*** Begin Patch\n') || !normalized.trimEnd().endsWith('*** End Patch')) return null;
    const paths = [...normalized.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1].trim());
    return paths.some(shared.isTestFile)
      ? { id: randomBytes(8).toString('hex'), ts: now, kind: 'edit', test_file: true } : null;
  }
  return shared.observationFor(event, now);
}

// This header belongs to the persisted function-call OUTPUT, not to the raw
// stdout in a hook event. Require the whole runtime header before Output:, so
// text printed by a test cannot manufacture a status. Match by call id too.
function rolloutExit(output) {
  if (typeof output !== 'string') return null;
  output = output.replace(/\r\n/g, '\n');
  const end = output.indexOf('\nOutput:\n');
  if (end < 0) return null;
  const header = output.slice(0, end);
  const match = /^(?:Chunk ID: [\w.-]+\n)?Wall time: \d+(?:\.\d+)? seconds\nProcess exited with code (-?\d+)(?:\nOriginal token count: \d+)?$/.exec(header);
  const exit = match ? Number(match[1]) : null;
  return Number.isInteger(exit) && Math.abs(exit) <= 2147483647 ? exit : null;
}

function reconcileObservations(state, resolved) {
  if (resolved?.kind !== 'codex' || !Array.isArray(state.observed_calls)) return null;
  const pending = new Set(state.observed_calls.filter(c => c.kind === 'shell'
    && !c.codex_exit_verified && c.codex_call_id).map(c => c.codex_call_id));
  if (!pending.size) return null;
  const exits = new Map();
  for (const rec of resolved.records || []) {
    const payload = rec?.type === 'response_item' && rec.payload;
    if (payload?.type !== 'function_call_output' || !pending.has(payload.call_id)) continue;
    const exit = rolloutExit(payload.output);
    if (exit !== null) exits.set(payload.call_id, exit);
  }
  if (!exits.size) return null;
  return { observed_calls: state.observed_calls.map(c => c.kind === 'shell' && exits.has(c.codex_call_id)
    ? { ...c, exit_code: exits.get(c.codex_call_id), codex_exit_verified: true } : c) };
}

function observationsForUpdate(state) {
  const observed = shared.observationsForUpdate(state);
  if (!observed) return null;
  return {
    // Legacy entries may have guessed an exit from program text. Never promote
    // those guesses just because a newer, independently verified call exists.
    // Server observation IDs are immutable. Withhold pending shells until
    // verified, rather than sending a null exit the server could never upgrade.
    calls: observed.calls.filter(c => c.kind !== 'shell' || c.codex_exit_verified === true)
      .map(({ codex_call_id, codex_exit_verified, ...call }) => call),
    supported: observed.calls.some(c => c.kind === 'shell' && c.codex_exit_verified === true),
  };
}

module.exports = { observationFor, recordObservation: shared.recordObservation, observationsForUpdate,
  reconcileObservations, rolloutExit };
