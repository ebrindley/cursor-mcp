import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(source, 'scripts/install.sh');
const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-install-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), root = path.join(dir, 'runtime'), repo = path.join(dir, 'repo'), bin = path.join(dir, 'bin');
  for (const target of [home, repo, bin, path.join(repo, 'scripts')]) fs.mkdirSync(target, { recursive: true });
  for (const file of ['install.sh', 'install-hosts.mjs']) fs.copyFileSync(path.join(source, 'scripts', file), path.join(repo, 'scripts', file));
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"installer-fixture","version":"1.0.0"}\n');
  const env = { ...process.env, HOME: home, CURSOR_MCP_ROOT: root, CURSOR_MCP_REPOSITORY: repo, CURSOR_MCP_REF: 'refs/heads/main', PATH: `${bin}:${process.env.PATH}`, CURSOR_API_KEY: 'test-build-must-not-see-this', FIXTURE: dir };
  for (const variable of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_CONFIG_DIR', 'GROK_HOME', 'CURSOR_MCP_POLICY', 'XDG_CONFIG_HOME']) delete env[variable];
  function git(...args) {
    const r = spawnSync(realGit, ['-C', repo, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  }
  git('init', '-b', 'main'); git('config', 'user.name', 'Installer Fixture'); git('config', 'user.email', 'installer@example.invalid');
  function commit(name) { fs.writeFileSync(path.join(repo, 'revision'), `${name}\n`); git('add', 'scripts/install.sh', 'scripts/install-hosts.mjs', 'package.json', 'revision'); git('commit', '-m', name); return git('rev-parse', 'HEAD'); }
  const sha = commit('first');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FIXTURE/git-calls"\nexec '${realGit.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
[ -z "\${CURSOR_API_KEY:-}" ] || { echo leaked >&2; exit 99; }
printf '%s\\n' "$*" >> "$FIXTURE/npm-calls"
case "$*" in
  ci*) [ ! -f "$FIXTURE/fail-ci" ] || exit 1; mkdir -p node_modules ;;
  *check:bin*) [ ! -f "$FIXTURE/fail-check" ] || exit 1 ;;
  *build*) [ ! -f "$FIXTURE/fail-build" ] || exit 1; mkdir -p dist; printf 'if (process.argv.includes("doctor")) { console.log("INFO: terminal: Not configured."); process.exit(1); } if (process.argv.includes("setup")) console.log("SETUP_DEFAULT_ACCOUNT"); console.log("fixture");\\n' > dist/bin.js ;;
esac
`, { mode: 0o755 });
  // Detection only; no real host process should be launched by the helper.
  for (const host of ['claude', 'codex', 'grok']) fs.writeFileSync(path.join(bin, host), '#!/bin/sh\nexit 90\n', { mode: 0o755 });
  const run = (...args) => spawnSync('/bin/bash', [installer, ...args], { env, encoding: 'utf8' });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return r.stdout; };
  const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const pin = (id = sha) => ok('pin', '--source', repo, '--commit', id, '--yes');
  return { dir, home, root, repo, bin, env, sha, git, commit, run, ok, read, pin };
}

test('dry-run and absent update do not create files or access GitHub', t => {
  const f = fixture(t);
  f.ok('install', '--dry-run'); f.ok('update', '--unattended');
  assert.equal(fs.existsSync(f.root), false);
  assert.equal(f.read(path.join(f.dir, 'git-calls')), '');
  assert.match(f.ok('status', '--porcelain'), /^contract=1\ndeployed=\npinned=\nlast_failure=\n$/);
});

test('pin builds a clean commit without fetch or credentials and update respects it', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'uncommitted-secret'), 'must not be installed');
  f.pin();
  assert.equal(fs.existsSync(path.join(f.root, 'current/uncommitted-secret')), false);
  assert.equal(f.read(path.join(f.root, 'current/.release-sha')).trim(), f.sha);
  assert.match(f.read(path.join(f.dir, 'npm-calls')), /check:bin/);
  const calls = f.read(path.join(f.dir, 'git-calls')), builds = f.read(path.join(f.dir, 'npm-calls'));
  assert.doesNotMatch(calls, /fetch|clone|ls-remote/);
  f.ok('update', '--unattended');
  assert.equal(f.read(path.join(f.dir, 'git-calls')), calls);
  assert.equal(f.read(path.join(f.dir, 'npm-calls')), builds);
  assert.match(f.ok('status', '--porcelain'), new RegExp(`pinned=${f.sha}`));
  assert.equal(fs.existsSync(path.join(f.home, '.claude.json')), false);
});

test('pin migration preserves JSON settings and TOML comments, env and policy subtables', t => {
  const f = fixture(t);
  const claude = { mcpServers: { cursor: { command: 'node', args: ['/old/dist/bin.js'], env: { CURSOR_API_KEY: 'fixture-only', CURSOR_MCP_POLICY: '/policy' }, envFile: '/credentials', timeout: 9 }, other: { command: 'other' } } };
  fs.writeFileSync(path.join(f.home, '.claude.json'), JSON.stringify(claude));
  fs.mkdirSync(path.join(f.home, '.codex')); fs.mkdirSync(path.join(f.home, '.grok')); fs.mkdirSync(path.join(f.home, '.cursor'));
  const toml = '# retain header\n[mcp_servers.cursor]\ncommand = "node"\nargs = [\n  "/old/dist/bin.js", # legacy entry comment\n]\nenv_vars = ["CUSTOM"]\nenabled = true\n[mcp_servers.cursor.env]\nCUSTOM = "fixture-only"\n[mcp_servers.cursor.tools.cursor_create_agent]\napproval_policy = "prompt"\n[mcp_servers.other]\ncommand = "other"\n';
  fs.writeFileSync(path.join(f.home, '.codex/config.toml'), toml);
  fs.writeFileSync(path.join(f.home, '.grok/config.toml'), toml);
  fs.writeFileSync(path.join(f.home, '.cursor/mcp.json'), JSON.stringify(claude));
  f.pin();
  for (const file of ['.claude.json', '.cursor/mcp.json']) {
    const after = JSON.parse(f.read(path.join(f.home, file)));
    assert.deepEqual(after.mcpServers.cursor.env, claude.mcpServers.cursor.env);
    assert.equal(after.mcpServers.cursor.envFile, '/credentials'); assert.equal(after.mcpServers.cursor.timeout, 9);
    assert.deepEqual(after.mcpServers.other, claude.mcpServers.other);
    assert.equal(after.mcpServers.cursor.args[0], path.join(f.root, 'current/dist/bin.js'));
  }
  for (const file of ['.codex/config.toml', '.grok/config.toml']) {
    const after = f.read(path.join(f.home, file));
    assert.match(after, /env_vars = \["CUSTOM"\]/);
    assert.match(after, /\[mcp_servers.cursor.env\]\nCUSTOM = "fixture-only"/);
    assert.match(after, /approval_policy = "prompt"/);
    assert.match(after, /^# retain header/);
    assert.match(after, /\[mcp_servers.other\]\ncommand = "other"/);
  }
});

test('explicit client selection persists through updates; reinstall detects newly available clients', t => {
  const f = fixture(t);
  f.ok('install', '--yes', '--host', 'claude');
  assert.ok(fs.existsSync(path.join(f.home, '.claude.json')));
  assert.equal(fs.existsSync(path.join(f.home, '.codex/config.toml')), false);
  const sha2 = f.commit('second'); f.ok('update', '--unattended');
  assert.equal(f.read(path.join(f.root, 'current/.release-sha')).trim(), sha2);
  assert.equal(fs.existsSync(path.join(f.home, '.codex/config.toml')), false);
  const builds = f.read(path.join(f.dir, 'npm-calls'));
  f.ok('install', '--yes');
  assert.equal(fs.existsSync(path.join(f.home, '.codex/config.toml')), true);
  assert.equal(f.read(path.join(f.dir, 'npm-calls')), builds);
});

test('failed verification retains prior release and quarantines that commit', t => {
  const f = fixture(t);
  f.ok('install', '--yes', '--host', 'claude');
  const old = fs.readlinkSync(path.join(f.root, 'current')); const sha2 = f.commit('broken');
  fs.writeFileSync(path.join(f.dir, 'fail-check'), '1');
  assert.notEqual(f.run('update', '--unattended').status, 0);
  assert.equal(fs.readlinkSync(path.join(f.root, 'current')), old);
  assert.equal(f.read(path.join(f.root, 'state/failed-sha')).trim(), sha2);
  const builds = f.read(path.join(f.dir, 'npm-calls'));
  assert.notEqual(f.run('update', '--unattended').status, 0);
  assert.equal(f.read(path.join(f.dir, 'npm-calls')), builds);
  assert.match(f.ok('status', '--porcelain'), /last_failure=commit_quarantined/);
});

test('dependency failure backs off without quarantining the commit', t => {
  const f = fixture(t); f.ok('install', '--yes', '--host', 'claude'); f.commit('second');
  fs.writeFileSync(path.join(f.dir, 'fail-ci'), '1');
  assert.notEqual(f.run('update', '--unattended').status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'state/failed-sha')), false);
  const calls = f.read(path.join(f.dir, 'git-calls'));
  f.ok('update', '--unattended'); assert.equal(f.read(path.join(f.dir, 'git-calls')), calls);
});

test('rollback restores and pins predecessor; explicit unpin does not fetch', t => {
  const f = fixture(t); f.pin(); const sha2 = f.commit('second'); f.pin(sha2);
  f.ok('rollback', '--yes');
  assert.equal(f.read(path.join(f.root, 'current/.release-sha')).trim(), f.sha);
  assert.equal(f.read(path.join(f.root, 'state/pinned')).trim(), f.sha);
  const calls = f.read(path.join(f.dir, 'git-calls'));
  f.ok('unpin', '--yes'); assert.equal(f.read(path.join(f.dir, 'git-calls')), calls);
  assert.equal(fs.existsSync(path.join(f.root, 'state/pinned')), false);
});

test('live updater lock prevents pin or state mutation', t => {
  const f = fixture(t); const lock = path.join(f.root, 'state/update.lock'); fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
  assert.equal(f.run('pin', '--source', f.repo, '--commit', f.sha, '--yes').status, 3);
  assert.equal(fs.existsSync(path.join(f.root, 'state/pinned')), false);
  assert.equal(f.read(path.join(f.dir, 'npm-calls')), '');
});

test('invalid existing config prevents registration writes and retains credentials', t => {
  const f = fixture(t); const config = path.join(f.home, '.claude.json'); const text = '{"mcpServers":{"cursor":{"command":"node","args":["/old/dist/bin.js"],"envFile":"/fixture"}}}';
  fs.writeFileSync(config, text); fs.mkdirSync(path.join(f.home, '.cursor')); fs.writeFileSync(path.join(f.home, '.cursor/mcp.json'), '{broken');
  const result = f.run('pin', '--source', f.repo, '--commit', f.sha, '--yes');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release is active, but client registration failed/);
  assert.equal(f.read(path.join(f.root, 'current/.release-sha')).trim(), f.sha);
  assert.ok(fs.existsSync(path.join(f.root, 'state/backoff-until')));
  assert.equal(f.read(config), text);
  assert.match(f.ok('status', '--porcelain'), /last_failure=registration_failed/);
});


test('updates preserve registered launcher and config bytes despite a different updater Node', t => {
  const f = fixture(t);
  f.ok('install', '--yes', '--host', 'claude', '--host', 'codex');
  const claudeFile = path.join(f.home, '.claude.json');
  const data = JSON.parse(f.read(claudeFile)); data.mcpServers.cursor.command = '/custom/keychain-launcher';
  fs.writeFileSync(claudeFile, JSON.stringify(data));
  const tomlFile = path.join(f.home, '.codex/config.toml');
  fs.writeFileSync(tomlFile, `[mcp_servers.cursor]
command = '/custom/node'
args = [
 '${path.join(f.root, 'current/dist/bin.js')}', # retain formatting
]
`);
  const before = [f.read(claudeFile), f.read(tomlFile)];
  fs.symlinkSync(process.execPath, path.join(f.bin, 'node'));
  f.commit('updated'); f.ok('update', '--unattended');
  assert.deepEqual([f.read(claudeFile), f.read(tomlFile)], before);
});

test('migration retains custom launcher but converts package runner to Node', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { cursor: { command: '/custom/keychain-launcher', args: ['/old/dist/bin.js'] } } }));
  fs.mkdirSync(path.join(f.home, '.codex'));
  fs.writeFileSync(path.join(f.home, '.codex/config.toml'), "[mcp_servers.cursor]\ncommand = 'npx'\nargs = ['-y', '@ebrindley/cursor-mcp']\n");
  f.pin();
  assert.equal(JSON.parse(f.read(path.join(f.home, '.claude.json'))).mcpServers.cursor.command, '/custom/keychain-launcher');
  assert.doesNotMatch(f.read(path.join(f.home, '.codex/config.toml')), /npx|@ebrindley/);
  assert.match(f.read(path.join(f.home, '.codex/config.toml')), /current\/dist\/bin.js/);
});

test('pin does not consume first-install client detection', t => {
  const f = fixture(t); f.pin();
  assert.equal(fs.existsSync(path.join(f.root, 'state/registered')), false);
  f.ok('install', '--yes');
  assert.ok(fs.existsSync(path.join(f.home, '.claude.json')));
  assert.ok(fs.existsSync(path.join(f.home, '.codex/config.toml')));
});

test('an install without detected clients reports it and keeps detection available', t => {
  const f = fixture(t); f.pin();
  const result = spawnSync(process.execPath, [path.join(source, 'scripts/install-hosts.mjs'), '--root', f.root, '--node', process.execPath, '--install'], { env: { ...f.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No client registered/);
  assert.equal(fs.existsSync(path.join(f.root, 'state/registered')), false);
  f.ok('install', '--yes');
  assert.ok(fs.existsSync(path.join(f.home, '.claude.json')));
});

test('noninteractive install without consent fails without writes', t => {
  const f = fixture(t);
  const result = spawnSync('/bin/bash', [installer, 'install'], { env: f.env, encoding: 'utf8', detached: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No interactive terminal/);
  assert.equal(fs.existsSync(f.root), false);
});


test('unattended fresh install invokes default setup without a repository questionnaire', t => {
  const f = fixture(t);
  const output = f.ok('install', '--yes');
  assert.match(output, /SETUP_DEFAULT_ACCOUNT/);
  assert.doesNotMatch(output, /setup --repo OWNER\/REPO/);
  assert.equal(fs.existsSync(path.join(f.home, '.config/cursor-mcp/policy.json')), false);
});


test('successful installation retires stale restart markers without changing status contract', t => {
  const f = fixture(t); f.pin();
  fs.writeFileSync(path.join(f.root, 'state/restart-needed'), '1');
  f.ok('install', '--yes');
  assert.equal(fs.existsSync(path.join(f.root, 'state/restart-needed')), false);
  assert.match(f.ok('status', '--porcelain'), /^contract=1\n/);
  assert.doesNotMatch(f.ok('status', '--porcelain'), /restart_needed/);
});


test('install preserves an existing policy and does not invoke setup', t => {
  const f = fixture(t);
  const policy = path.join(f.home, '.config/cursor-mcp/policy.json');
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  const original = '{"existing":"policy"}\n';
  fs.writeFileSync(policy, original);
  const output = f.ok('install', '--yes');
  assert.doesNotMatch(output, /SETUP_DEFAULT_ACCOUNT/);
  assert.equal(f.read(policy), original);
});

test('update reports an existing policy without a terminal block and leaves it unchanged', t => {
  const f = fixture(t);
  const policy = path.join(f.home, '.config/cursor-mcp/policy.json');
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  const original = '{"defaultProfile":"dev","profiles":{"dev":{"tools":["*"]}}}\n';
  fs.writeFileSync(policy, original);
  f.ok('install', '--yes');
  f.commit('second');
  const output = f.ok('update', '--unattended');
  assert.match(output, /no terminal block/);
  assert.match(output, /setup --account --preview/);
  assert.equal(f.read(policy), original);
  fs.writeFileSync(policy, '{"defaultProfile":"dev","profiles":{"dev":{"tools":["cursor_whoami"]}},"terminal":{"targets":"profile","executeEnabled":true}}\n');
  f.commit('third');
  assert.doesNotMatch(f.ok('update', '--unattended'), /no terminal block/);
  fs.writeFileSync(policy, 'not json\n');
  f.commit('fourth');
  assert.doesNotMatch(f.ok('update', '--unattended'), /no terminal block/);
});
