#!/usr/bin/env node
// Installer-private registration helper. Repoint only command/args; retain
// credentials, envFile, policy settings, comments and unrelated server entries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const options = { hosts: [], install: false, withCursor: false };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--install') options.install = true;
  else if (arg === '--with-cursor') options.withCursor = true;
  else if (arg === '--root') options.root = process.argv[++i];
  else if (arg === '--node') options.node = process.argv[++i];
  else if (arg === '--host') options.hosts.push(process.argv[++i]);
  else throw new Error('Unknown registration option');
}
if (!options.root || !options.node) throw new Error('Missing installation paths');
const home = process.env.HOME || os.homedir();
const entry = path.join(options.root, 'current/dist/bin.js');
const configs = {
  claude: process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'),
  codex: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
  grok: path.join(process.env.GROK_CONFIG_DIR || process.env.GROK_HOME || path.join(home, '.grok'), 'config.toml'),
  cursor: path.join(home, '.cursor/mcp.json'),
};
// Native process-boundary watchdog before the runtime build. Ignored stdio avoids
// inherited output pipes; settlement still relies on the OS reaping this shell.
const present = (host) => host === 'cursor' ? fs.existsSync(path.dirname(configs.cursor)) : spawnSync('/bin/sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', host], { timeout: 5_000, killSignal: 'SIGKILL', stdio: 'ignore' }).status === 0;
const addAllowed = (host) => options.install && (host === 'cursor' ? options.withCursor : options.hosts.length ? options.hosts.includes(host) : present(host));

function updatedArgs(old) {
  if (old === undefined) return [entry];
  if (!Array.isArray(old) || old.some(v => typeof v !== 'string')) throw new Error('Unsupported existing command arguments');
  const index = old.findIndex(value => /(?:^|\/)(?:bin|server)\.js$/.test(value));
  if (index >= 0) return old.map((value, at) => at === index ? entry : value);
  // Published-package registrations have no node-script args worth retaining.
  if (old.includes('@ebrindley/cursor-mcp')) return [entry];
  if (old.length === 0) return [entry];
  throw new Error('Cannot identify existing Cursor MCP entry point; registration retained');
}
function updatedCommand(old, args) {
  // Keep custom launchers and the user's Node choice. Only package-runner
  // registrations need conversion to Node when migrating to a source install.
  return old === undefined || typeof old === 'string' && path.basename(old) === 'npx' && args?.includes('@ebrindley/cursor-mcp') ? options.node : old;
}
function jsonConfig(text, allow) {
  const data = JSON.parse(text || '{}');
  const old = data.mcpServers?.cursor;
  if (!old && !allow) return null;
  if (old?.url || old?.type && old.type !== 'stdio') throw new Error('Existing cursor registration is not stdio');
  const next = { ...old, command: updatedCommand(old?.command, old?.args), args: updatedArgs(old?.args) };
  data.mcpServers ??= {};
  data.mcpServers.cursor = next;
  return { text: `${JSON.stringify(data, null, 2)}\n`, old, next };
}
// TOML command and args accept simple/literal strings and multiline arrays.
// Other values remain byte-for-byte untouched; unsupported layouts fail closed.
function valueEnd(text, start) {
  let quote = '', triple = false, depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (triple && text.slice(i, i + 3) === quote.repeat(3)) {
        while (text[i + 1] === quote) i++;
        quote = ''; triple = false;
      } else if (!triple && c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c; triple = text.slice(i, i + 3) === c.repeat(3); if (triple) i += 2;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '#') { const next = text.indexOf('\n', i); if (depth === 0) return i; if (next < 0) return text.length; i = next; }
    else if (c === '\n' && depth === 0) return i;
  }
  if (quote || depth) throw new Error('Incomplete TOML value');
  return text.length;
}
function stringArray(value) {
  // The launcher args are strings; no general-purpose TOML rewriting needed.
  const strings = []; let index = 0;
  const skip = () => { while (index < value.length) { if (/\s/.test(value[index])) index++; else if (value[index] === '#') { const end = value.indexOf('\n', index); index = end < 0 ? value.length : end + 1; } else break; } };
  skip(); if (value[index++] !== '[') throw new Error('Unsupported TOML args');
  while (true) {
    skip(); if (value[index] === ']') { index++; break; }
    const quote = value[index++]; if (quote !== '"' && quote !== "'") throw new Error('Unsupported TOML args');
    const begin = index; let escaped = false;
    for (; index < value.length; index++) { if (quote === '"' && !escaped && value[index] === '\\') { escaped = true; continue; } if (!escaped && value[index] === quote) break; escaped = false; }
    if (index === value.length) throw new Error('Unterminated TOML string');
    const raw = value.slice(begin, index++);
    strings.push(quote === '"' ? JSON.parse(`"${raw}"`) : raw);
    skip(); if (value[index] === ',') index++; else if (value[index] !== ']') throw new Error('Unsupported TOML args separator');
  }
  skip(); if (index !== value.length) throw new Error('Unsupported trailing TOML args');
  return strings;
}
// Scan complete statements so comments, multiline values and unrelated tables
// cannot masquerade as a registration. A dot inside a quoted key is literal.
const keyPart = /[A-Za-z0-9_-]+|'[^'\r\n]*'|"(?:\\.|[^"\\\r\n])*"/g;
function keyName(raw) {
  if (raw[0] === "'") return raw.slice(1, -1);
  if (raw[0] !== '"') return raw;
  // Only Unicode and hex escapes can spell a character in a launcher key.
  return raw.slice(1, -1).replace(/\\(?:u[\da-fA-F]{4}|U[\da-fA-F]{8}|x[\da-fA-F]{2}|.)/g,
    escape => escape.length > 2 ? String.fromCodePoint(parseInt(escape.slice(2), 16)) : escape);
}
function tomlConfig(text, allow, host) {
  const part = '(?:' + keyPart.source + ')';
  const statement = new RegExp('^[ \\t]*(\\[\\[?)?[ \\t]*(' + part + '(?:[ \\t]*\\.[ \\t]*' + part + ')*)[ \\t]*(=|\\]\\]?)[ \\t]*', 'gm');
  let table = [];
  let found = false, inCursor = false, unsupported = false;
  const edits = [];
  const seen = new Set();
  let match;
  while ((match = statement.exec(text))) {
    const names = match[2].match(keyPart).map(keyName);
    if (match[1]) {
      table = names;
      inCursor = match[1] === '[' && table.length === 2 && table[0] === 'mcp_servers' && table[1] === 'cursor';
      if (inCursor) {
        if (found) throw new Error('Duplicate cursor TOML tables');
        found = true;
      }
      if (table[0] === 'mcp_servers' && (table[1] === 'cursor' || table.length === 1 && match[1] === '[[')) unsupported = true;
      continue;
    }
    const start = statement.lastIndex;
    const stop = valueEnd(text, start);
    statement.lastIndex = stop;
    const full = [...table, ...names];
    if (full[0] === 'mcp_servers' && (full.length === 1 || full[1] === 'cursor')) unsupported = true;
    if (!inCursor || names.length !== 1) continue;
    const [name] = names;
    if (name === 'url') throw new Error('Existing cursor registration is not stdio');
    if (name !== 'command' && name !== 'args') continue;
    if (seen.has(name)) throw new Error('Duplicate TOML command key');
    seen.add(name);
    const raw = text.slice(start, stop).trim();
    const value = name === 'command' ? stringArray('[' + raw + ']')[0] : stringArray(raw);
    edits.push({ key: name, start, stop, value });
  }
  if (!found) {
    if (!allow) return null;
    if (unsupported) throw new Error('Unsupported inline/dotted MCP config layout; registration retained');
    return `${text}${text.endsWith('\n') || !text ? '' : '\n'}\n[mcp_servers.cursor]\ncommand = ${JSON.stringify(options.node)}\nargs = ${JSON.stringify([entry])}\n${host === 'codex' ? 'env_vars = ["CURSOR_API_KEY", "PATH", "HOME"]\n' : ''}`;
  }
  if (!seen.has('command') || !seen.has('args')) throw new Error('Unsupported TOML command layout; registration retained');
  const args = edits.find(edit => edit.key === 'args').value;
  let changed = text;
  for (const edit of edits.reverse()) {
    const value = edit.key === 'command' ? updatedCommand(edit.value, args) : updatedArgs(args);
    if (JSON.stringify(value) !== JSON.stringify(edit.value)) changed = changed.slice(0, edit.start) + JSON.stringify(value) + changed.slice(edit.stop);
  }
  return changed;
}
function configTarget(file, allow) {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
  try { return fs.realpathSync(file); }
  catch (error) {
    // An unselected host with a dangling config has no registration to migrate.
    if (error.code === 'ENOENT' && !allow) return undefined;
    throw error;
  }
}
try {
  // Render every intended change before writing any registration.
  const changes = []; let registered = false;
  for (const host of ['claude', 'codex', 'grok', 'cursor']) {
    const file = configs[host];
    const allow = addAllowed(host);
    const target = configTarget(file, allow);
    const before = target ? fs.readFileSync(target, 'utf8') : '';
    let after;
    if (host === 'claude' || host === 'cursor') {
      const result = jsonConfig(before, allow); if (!result) continue;
      if (host === 'cursor' && !result.old) {
        if (!process.env.CURSOR_API_KEY) throw new Error('New Cursor registration requires CURSOR_API_KEY; existing registrations are untouched');
        result.next.env = { CURSOR_API_KEY: process.env.CURSOR_API_KEY, PATH: process.env.PATH || '' };
        const data = JSON.parse(result.text); data.mcpServers.cursor = result.next;
        result.text = `${JSON.stringify(data, null, 2)}\n`;
        console.log('Cursor opt-in stores CURSOR_API_KEY in its private MCP configuration.');
      }
      registered = true;
      if (JSON.stringify(result.old) === JSON.stringify(result.next)) continue;
      after = result.text;
    } else { after = tomlConfig(before, allow, host); if (after !== null) registered = true; }
    if (after !== null && after !== before) changes.push({ host, file, before, after, target });
  }
  for (const change of changes) {
    // Detect an editor/client write between our read and replacement.
    const destination = change.target ?? change.file;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.cursor-mcp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, change.after, { flag: 'wx', mode: change.target ? fs.statSync(destination).mode & 0o777 : 0o600 });
      if (configTarget(change.file, true) !== change.target || change.target && fs.readFileSync(destination, 'utf8') !== change.before) throw new Error('Configuration changed concurrently; rerun installation');
      fs.renameSync(temporary, destination);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    console.log(`${change.host}: Cursor MCP registration updated; existing settings retained.`);
  }
  if (options.install && !registered) console.log('No client registered. Rerun install with --host claude, --host codex, --host grok or --with-cursor when ready.');
} catch (error) {
  // Do not print parser excerpts: configuration may contain secrets.
  console.error(`Registration failed: ${error instanceof SyntaxError ? 'invalid configuration syntax' : error.message}`);
  process.exitCode = 1;
}
