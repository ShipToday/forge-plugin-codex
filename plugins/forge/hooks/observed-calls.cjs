'use strict';

/**
 * What the plugin saw the session do, kept so a run's record can say which
 * test runs Forge saw rather than only what the AI reported.
 *
 * For each shell call: a hash of the command, its exit code, whether the
 * command is a known test runner, and when it ran. For each edit to a test
 * file: that it happened, and when. Never any text — no command, output or
 * path leaves this machine; the test-runner and test-file checks run here.
 *
 * The tracker (PostToolUse) records; the guard (PreToolUse) stamps the log
 * onto every forge__update_state, replacing anything the AI sent. The log is
 * cumulative and capped, so a lost call loses nothing: the next one carries it.
 *
 * Nothing here throws.
 */

const { createHash } = require('node:crypto');

const MAX_OBSERVED_CALLS = 100;
const COMMAND_HASH_HEX = 24;

// Shell tools whose calls are recorded: only hosts whose shell results are
// known to carry the outcome. Other hosts' shell tools are added once a live
// session confirms their result shape; until then their runs stay reported.
const SHELL_TOOL_RE = /^(?:Bash|PowerShell|Shell)$/;
const EDIT_TOOL_RE = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/;

// Known test runners, matched on the command here so only a yes/no leaves.
const TEST_RUNNERS = [
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:.-]+)?(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(/])(?:vitest|jest|mocha|ava|tap|karma|jasmine|playwright\s+test|cypress\s+run)(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(])node\s+(?:[^;&|]*\s)?--test(?=$|[\s;&|)=])/,
  /(?:^|[\s;&|(])(?:bun|deno)\s+test(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(/])(?:pytest|py\.test|tox|nox)(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(])python[\d.]*\s+-m\s+(?:pytest|unittest)(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(])(?:go|cargo|dotnet|mix|swift)\s+test(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(/])(?:mvn|mvnw|gradle|gradlew)\s+(?:[^;&|]*\s)?test(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(/])(?:rspec|phpunit|pest|ctest)(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(])(?:bundle\s+exec\s+)?rake\s+(?:test|spec)(?=$|[\s;&|)])/,
  /(?:^|[\s;&|(])Invoke-Pester(?=$|[\s;&|)])/i,
];

// Test files by name or folder: a ".test" or "_spec" style suffix before the
// extension, a "test_" prefix on a Python file, and anything under a tests,
// test, spec or __tests__ folder.
const TEST_FILE_RE = /(?:^|[\\/])(?:__tests__|tests?|spec|specs)[\\/]|[._-](?:test|spec)s?\.[A-Za-z0-9]+$|(?:^|[\\/])test_[^\\/]+\.py$/i;

function normalizeCommand(command) {
  return typeof command === 'string' ? command.trim().replace(/\s+/g, ' ') : '';
}

/** SHA-256 of the trimmed, whitespace-collapsed command — the server computes the same. */
function commandHash(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, COMMAND_HASH_HEX);
}

const ENV_ASSIGNMENTS = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
// Words that only launch the next one, with any options or variables they
// take: `npx --yes vitest`, `pnpm exec vitest`, `uv run pytest`,
// `env CI=1 npm test`. The longer forms come first, so `pnpm exec` is not
// read as `pnpm` launching `exec`.
const LAUNCHERS = /^(?:(?:(?:pnpm|yarn|bun)\s+(?:exec|dlx|x)|(?:uv|poetry|pipenv|hatch)\s+run|bundle\s+exec|npx|bunx|pnpx|time|env|sudo|yarn|pnpm|bun)\s+(?:-\S+\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)+/;
const SEPARATORS = ';&|(\n\r';

/**
 * The commands a shell line runs, whitespace collapsed. A command starts at
 * the beginning of the line or after ; & | ( or a newline, but never inside
 * quotes: `echo "a; npm test"` is one command that only prints.
 */
function commandSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (SEPARATORS.includes(ch)) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map(normalizeCommand).filter(Boolean);
}

/** Does a known runner start at this point (not merely appear in an argument)? */
function runnerAtStart(text) {
  return TEST_RUNNERS.some((re) => { const m = re.exec(text); return m !== null && m.index === 0; });
}

/**
 * Is this command a test run? A runner counts only where a command starts:
 * `cd app && npm test` and `npx vitest` do, `echo npm test` and
 * `grep "pytest" log` do not.
 */
function isTestRunner(command) {
  if (typeof command !== 'string') return false;
  return commandSegments(command).some((segment) => {
    const bare = segment.replace(ENV_ASSIGNMENTS, '');
    const launched = bare.replace(LAUNCHERS, '').replace(/^\S*\//, '');
    return runnerAtStart(bare) || runnerAtStart(launched);
  });
}

function isTestFile(filePath) {
  return typeof filePath === 'string' && TEST_FILE_RE.test(filePath.trim());
}

function parseInput(input) {
  if (typeof input !== 'string') return input && typeof input === 'object' ? input : {};
  try { const parsed = JSON.parse(input); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

/** The command a shell call ran: a string, or an argv list joined. */
function shellCommand(event) {
  const input = parseInput(event.tool_input);
  const command = input.command ?? input.cmd;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
  return null;
}

const EXIT_IN_TEXT = /exit(?:ed with)?[ _]?code[:=\s]+(-?\d+)/i;

/**
 * The call's exit code, or null when it cannot be told. A failed call
 * (PostToolUseFailure) says "Exit code N" in its error. A call reported as
 * successful is a clean exit only when its result has the shape of a
 * finished foreground command (stdout/stderr) — a command sent to the
 * background is still running, an interrupted one has no code, and an
 * unfamiliar shape is never assumed to have passed.
 */
function exitCodeOf(event) {
  if (event.hook_event_name === 'PostToolUseFailure') {
    const match = EXIT_IN_TEXT.exec(String(event.error ?? ''));
    return match ? Number(match[1]) : null;
  }
  const input = parseInput(event.tool_input);
  if (input.run_in_background === true) return null;
  const response = event.tool_response;
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if (response.interrupted === true || response.backgroundTaskId != null) return null;
    for (const key of ['exit_code', 'exitCode', 'returnCode', 'return_code']) {
      if (Number.isInteger(response[key])) return response[key];
    }
    if (response.isError === true || response.is_error === true) return null;
    return typeof response.stdout === 'string' || typeof response.stderr === 'string' ? 0 : null;
  }
  if (typeof response === 'string') {
    const match = EXIT_IN_TEXT.exec(response);
    return match ? Number(match[1]) : null;
  }
  return null;
}

/** The edited file path(s) of an edit call. */
function editedPaths(event) {
  const input = parseInput(event.tool_input);
  return [input.file_path, input.notebook_path, input.path].filter((p) => typeof p === 'string');
}

function entryId(sessionId, ts, salt) {
  return createHash('sha256').update(`${sessionId || ''}:${ts}:${salt}:${Math.random()}`).digest('hex').slice(0, 16);
}

/**
 * The observation one tool event adds, or null when it adds none.
 *
 * @param {object} event - a PostToolUse or PostToolUseFailure event, as sent
 * @param {number} [now]
 * @returns {object|null}
 */
function observationFor(event, now = Date.now()) {
  try {
    const tool = event && event.tool_name;
    if (typeof tool !== 'string') return null;
    if (SHELL_TOOL_RE.test(tool)) {
      const command = shellCommand(event);
      const hash = commandHash(command);
      if (!hash) return null;
      return { id: entryId(event.session_id, now, hash), ts: now, kind: 'shell', hash, exit_code: exitCodeOf(event), test_runner: isTestRunner(command) };
    }
    if (EDIT_TOOL_RE.test(tool) && event.hook_event_name !== 'PostToolUseFailure' && editedPaths(event).some(isTestFile)) {
      return { id: entryId(event.session_id, now, 'edit'), ts: now, kind: 'edit', test_file: true };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The session-state update that records one observation: appended, newest
 * kept, and `observation_shell_seen` set once any shell call has been seen.
 *
 * @param {object} state - current session state
 * @param {object} entry - from observationFor
 * @returns {object}
 */
/** A test run or a test-file edit: what the flags are drawn from. */
function isEvidence(call) {
  return Boolean(call) && ((call.kind === 'shell' && call.test_runner === true) || call.kind === 'edit');
}

/**
 * The newest `max` calls, in order. When there are more, the oldest ordinary
 * calls go first, so a long run of other commands cannot push out the test
 * run that shows a test was seen.
 */
function keepNewest(calls, max) {
  if (calls.length <= max) return calls;
  const excess = calls.length - max;
  const ordinary = calls.filter((c) => !isEvidence(c)).length;
  let dropOrdinary = Math.min(excess, ordinary);
  let dropEvidence = excess - dropOrdinary;
  return calls.filter((c) => {
    if (!isEvidence(c) && dropOrdinary > 0) { dropOrdinary -= 1; return false; }
    if (isEvidence(c) && dropEvidence > 0) { dropEvidence -= 1; return false; }
    return true;
  });
}

function recordObservation(state, entry) {
  const log = Array.isArray(state && state.observed_calls) ? state.observed_calls : [];
  const updates = { observed_calls: keepNewest([...log, entry], MAX_OBSERVED_CALLS) };
  if (entry.kind === 'shell') updates.observation_shell_seen = true;
  return updates;
}

/**
 * What the guard stamps on a forge__update_state, or null when there is
 * nothing to stamp. Only during a workflow: an observer check-in has no
 * evidence to compare.
 *
 * @param {object} state - session state
 * @returns {{ calls: object[], supported: boolean }|null}
 */
function observationsForUpdate(state) {
  if (!state || !state.active_workflow) return null;
  const calls = Array.isArray(state.observed_calls) ? keepNewest(state.observed_calls, MAX_OBSERVED_CALLS) : [];
  const supported = state.observation_shell_seen === true;
  if (!supported && calls.length === 0) return null;
  return { calls, supported };
}

module.exports = {
  MAX_OBSERVED_CALLS,
  commandHash,
  isTestRunner,
  isTestFile,
  observationFor,
  recordObservation,
  observationsForUpdate,
};
