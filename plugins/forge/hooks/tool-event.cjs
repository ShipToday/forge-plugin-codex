'use strict';

// Codex functions.exec exposes one outer hook event. Do not execute its source
// or infer that a mentioned tool ran: require a single literal tools.<name>()
// call AND a recognizable Forge result. Multi-call/dynamic scripts need host
// per-call receipts to associate inputs with results safely.
const FORGE_TOOL = /(?:^|__)forge__(?:start_workflow|update_state|abandon_workflow)$/;

function responseText(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') {
    try { return responseText(JSON.parse(value), depth + 1); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map((v) => responseText(v, depth + 1)).join('\n');
  if (Array.isArray(value.content)) return responseText(value.content, depth + 1);
  if (typeof value.text === 'string') return responseText(value.text, depth + 1);
  return JSON.stringify(value);
}

function tokensFor(source) {
  // Strings/comments are single tokens so quoted examples cannot become calls.
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?|[^\s]/gy;
  const tokens = [];
  let match;
  while ((match = re.exec(source))) {
    if (!/^\s|^\/\//.test(match[0]) && !match[0].startsWith('/*')) tokens.push(match[0]);
  }
  return tokens;
}

function literalString(token) {
  if (token?.startsWith('"')) return JSON.parse(token);
  // Single-quoted identifiers are sufficient for workflow/session identity;
  // escaped JS strings and template expressions are deliberately unsupported.
  if (/^'[^'\\]*'$/.test(token || '')) return token.slice(1, -1);
  throw new Error('Not a literal string');
}

function literalInput(tokens, start) {
  let index = start;
  function value() {
    const token = tokens[index++];
    if (token === '{') {
      const object = Object.create(null);
      while (tokens[index] !== '}') {
        const keyToken = tokens[index++];
        const key = /^[A-Za-z_$][\w$]*$/.test(keyToken || '') ? keyToken : literalString(keyToken);
        if (tokens[index++] !== ':') throw new Error('Not a literal property');
        object[key] = value();
        if (tokens[index] === ',') index++;
        else if (tokens[index] !== '}') throw new Error('Not a literal object');
      }
      index++;
      return object;
    }
    if (token === '[') {
      const array = [];
      while (tokens[index] !== ']') {
        array.push(value());
        if (tokens[index] === ',') index++;
        else if (tokens[index] !== ']') throw new Error('Not a literal array');
      }
      index++;
      return array;
    }
    if (token === 'null') return null;
    if (token === 'true' || token === 'false') return token === 'true';
    if (/^-?\d+(?:\.\d+)?$/.test(token || '')) return Number(token);
    return literalString(token);
  }
  try {
    const input = value();
    return tokens[index] === ')' && input && typeof input === 'object' ? input : null;
  } catch { return null; }
}

function isTopLevelAwait(tokens, index) {
  let depth = 0;
  let statementStart = 0;
  for (let i = 0; i < index; i++) {
    if (['{', '(', '['].includes(tokens[i])) depth++;
    if (['}', ')', ']'].includes(tokens[i])) depth--;
    if (tokens[i] === ';' && depth === 0) statementStart = i + 1;
  }
  const prefix = tokens.slice(statementStart, index);
  if (depth === 1 && prefix.join(' ') === 'text ( await') return true;
  if (depth !== 0) return false;
  return prefix.join(' ') === 'await' || (prefix.length === 4
    && ['const', 'let', 'var'].includes(prefix[0])
    && /^[A-Za-z_$][\w$]*$/.test(prefix[1]) && prefix[2] === '=' && prefix[3] === 'await');
}

function normalizeToolEvent(event) {
  if (!['functions.exec', 'functions__exec'].includes(event.tool_name)) return event;
  const source = typeof event.tool_input === 'string' ? event.tool_input : event.tool_input?.code;
  if (typeof source !== 'string') return null;
  const tokens = tokensFor(source);
  let callIndex = -1;
  for (let i = 0; i < tokens.length - 3; i++) {
    if (tokens[i] === 'tools' && tokens[i + 1] === '.' && tokens[i + 3] === '(') {
      if (callIndex !== -1) return null;
      callIndex = i;
    }
  }
  if (callIndex === -1 || !FORGE_TOOL.test(tokens[callIndex + 2])
    || !isTopLevelAwait(tokens, callIndex) || event.tool_response?.isError) return null;
  const input = literalInput(tokens, callIndex + 4);
  if (!input) return null;
  const text = responseText(event.tool_response);
  if (!/(?:\*\*(?:CHECKPOINT|RE-ENTRY|NEXT STEP|Workflow abandoned)\*\*|Conversation ID|Step "[^"]+" completed\.|Skill \*\*\w+\*\* completed\.)/.test(text)) return null;
  return { ...event, tool_name: tokens[callIndex + 2], tool_input: input, tool_response: text };
}

module.exports = { normalizeToolEvent, responseText };
