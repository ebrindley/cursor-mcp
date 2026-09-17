import { test, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PolicySchema } from '../src/config.js';
import { TerminalService } from '../src/terminal.js';
import { TerminalFailure, type TerminalConnector, type TerminalPeer } from '../src/terminal-gateway.js';
import { registerTerminalTools } from '../src/tools/terminal.js';

function fixture(maxBytes = 65536, maxResults = 32) {
  const calls: string[] = [];
  const attachments: Record<string, unknown>[] = [];
  const peers: { closed: boolean }[] = [];
  const connectFailures: string[] = [];
  let rejectStream: ((error: Error) => void) | undefined;
  let endStream: (() => void) | undefined;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let present = false;
  let failSpawn = false;
  let changed = false;
  let cleanupFails = false;
  let holdNext = false;
  let releaseConnect: (() => void) | undefined;
  // Each connect returns its own peer, as the real connector does, so a superseded one is visible.
  const newPeer = () => {
    const state = { closed: false };
    peers.push(state);
    const peer: TerminalPeer = {
      async unary(method, _input, submitted) {
        calls.push(method);
        if (method === 'SpawnPty') { submitted?.(); present = true; if (failSpawn) throw new TerminalFailure('gateway_disconnected', true); return { ptyId: 'owned' }; }
        if (cleanupFails) throw new TerminalFailure('gateway_disconnected');
        if (method === 'TerminatePty') { present = false; return { success: true }; }
        return { ptys: present ? [{ ptyId: 'owned' }] : [] };
      },
      stream(_method, input, event, signal) {
        attachments.push(input); listener = event;
        return new Promise<void>((resolve, reject) => { rejectStream = reject; endStream = resolve; signal.addEventListener('abort', () => reject(new TerminalFailure('request_cancelled')), { once: true }); });
      },
      close() { state.closed = true; },
    };
    return peer;
  };
  const connector: TerminalConnector = { async connect(expected) {
    if (holdNext) { holdNext = false; await new Promise<void>(resolve => { releaseConnect = resolve; }); }
    if (connectFailures.length) throw new TerminalFailure(connectFailures.shift()!);
    if (changed && expected) throw new TerminalFailure('machine_changed');
    return { machineId: 'machine-1', peer: newPeer() };
  } };
  const service = new TerminalService('bc-test', connector, maxBytes, maxResults);
  const request = (operation: string, commandId = 'one') => ({ operation, sessionId: service.sessionId, commandId, command: "printf 'x\ty'\nexit 7", timeoutMs: 10000 });
  return { service, calls, request, attachments, peers,
    event: (event: Record<string, unknown>) => listener!(event),
    breakStream: (code = 'gateway_disconnected') => rejectStream!(new TerminalFailure(code)),
    endStream: () => endStream!(),
    failConnect: (...codes: string[]) => connectFailures.push(...codes),
    holdConnect: () => { holdNext = true; }, connectHeld: () => releaseConnect !== undefined, releaseConnect: () => releaseConnect!(),
    failSpawn: () => { failSpawn = true; }, changeMachine: () => { changed = true; }, failCleanup: () => { cleanupFails = true; }, recoverCleanup: () => { cleanupFails = false; },
    async started() { await vi.waitFor(() => expect(listener).toBeTypeOf('function')); },
    async attached(count: number) { await vi.waitFor(() => expect(attachments).toHaveLength(count)); },
    data(data: Buffer, eventId?: string) { listener!({ ...(eventId ? { eventId } : {}), ptyData: { data: data.toString('base64') } }); },
    exit(code = 7, eventId?: string) { present = false; listener!({ ...(eventId ? { eventId } : {}), ptyExited: code ? { exitCode: code } : {} }); },
    async finished(id = 'one') {
      let result: Record<string, unknown> = {};
      await vi.waitFor(async () => { result = await service.handle(request('read', id)); expect(result.state).toBe('finished'); });
      return result;
    },
  };
}

test('protocol exit completes despite a held-open attachment, accepts multiline/tab source and deduplicates', async () => {
  const f = fixture();
  expect(await f.service.handle(f.request('execute'))).toMatchObject({ state: 'starting', commandOutcome: 'not_submitted' });
  await f.started(); f.data(Buffer.from('RESULT\n')); f.exit();
  expect(await f.finished()).toMatchObject({ commandOutcome: 'ended', exitCode: 7, output: 'RESULT\n', outputComplete: true, cleanup: 'process_exited' });
  expect(await f.service.handle(f.request('execute'))).toMatchObject({ exitCode: 7 });
  expect(await f.service.handle({ ...f.request('execute'), command: 'changed' })).toMatchObject({ status: 'command_id_conflict' });
  expect(f.calls.filter(x => x === 'SpawnPty')).toHaveLength(1); f.service.close();
});

test('Unicode byte splits and capped output retain valid pages while still observing exit', async () => {
  const f = fixture(9); await f.service.handle(f.request('execute')); await f.started();
  const bytes = Buffer.from('🌍🌍🌍'); f.data(bytes.subarray(0, 3)); f.data(bytes.subarray(3)); f.exit(0);
  expect(await f.finished()).toMatchObject({ exitCode: 0, output: '🌍🌍', outputTruncated: true, outputComplete: true, outputLength: 2 });
  expect(await f.service.handle({ ...f.request('read'), outputOffset: 1, outputLimit: 1 })).toMatchObject({ output: '🌍', outputNextOffset: 2 });
  f.service.close();
});

test('ambiguous spawn retains its ID and never retries without known process identity', async () => {
  const f = fixture(); f.failSpawn(); await f.service.handle(f.request('execute'));
  expect(await f.finished()).toMatchObject({ commandOutcome: 'unknown', cleanup: 'identity_unknown', exitCode: null });
  await f.service.handle(f.request('execute')); expect(f.calls).toEqual(['SpawnPty']); f.service.close();
});

test.each(['cancel', 'deadline', 'changed', 'cleanup-failure'] as const)('%s reports cleanup separately from unknown command outcome', async mode => {
  const f = fixture(); await f.service.handle({ ...f.request('execute'), timeoutMs: mode === 'deadline' ? 15 : 10000 }); await f.started();
  if (mode === 'changed') f.changeMachine();
  if (mode === 'cleanup-failure') f.failCleanup();
  if (mode !== 'deadline') await f.service.handle(f.request('cancel'));
  expect(await f.finished()).toMatchObject({ commandOutcome: 'unknown', exitCode: null,
    cleanup: mode === 'changed' ? 'machine_changed' : mode === 'cleanup-failure' ? 'termination_unconfirmed' : 'process_not_listed',
    reason: mode === 'deadline' ? 'deadline_exceeded' : 'cancel_requested' });
  if (mode === 'changed') expect(f.calls).not.toContain('TerminatePty'); f.service.close();
});

test('MCP request abort does not kill accepted work; shutdown detaches without termination', async () => {
  const f = fixture(), signal = new AbortController();
  await f.service.handle(f.request('execute'), signal.signal); await f.started(); signal.abort();
  expect(await f.service.handle(f.request('read'))).toMatchObject({ state: 'running' });
  f.service.close(); expect(await f.finished()).toMatchObject({ cleanup: 'detached', commandOutcome: 'unknown' });
  expect(f.calls).not.toContain('TerminatePty');
});

test('busy/capacity/session checks preserve deduplication and reject unsupported NUL before submission', async () => {
  const f = fixture(65536, 1);
  expect(await f.service.handle({ ...f.request('execute'), command: 'a\0b' })).toMatchObject({ status: 'invalid_request' });
  expect(f.calls).toEqual([]);
  await f.service.handle(f.request('execute')); await f.started();
  expect(await f.service.handle(f.request('execute', 'two'))).toMatchObject({ status: 'busy' });
  f.exit(); await f.finished();
  expect(await f.service.handle(f.request('execute', 'two'))).toMatchObject({ status: 'session_capacity' });
  expect(await f.service.handle({ ...f.request('read'), sessionId: 'other' })).toMatchObject({ status: 'session_mismatch' });
  expect(await f.service.handle(f.request('read', 'missing'))).toMatchObject({ status: 'not_retained' }); f.service.close();
});

test('terminal config is opt-in, unknown keys fail, and execute/cancel use their existing distinct gates', async () => {
  const server = new McpServer({ name: 'fixture', version: '1' }); expect(registerTerminalTools(server, PolicySchema.parse({}))).toEqual([]);
  expect(() => PolicySchema.parse({ unknownOption: true })).toThrow();
  for (const deleteEnabled of [false, true]) for (const executeEnabled of [false, true]) {
    const server = new McpServer({ name: 'fixture', version: '1' });
    const names = registerTerminalTools(server, PolicySchema.parse({ deleteEnabled, terminal: { agentId: 'bc-test', executeEnabled },
      defaultProfile: 'terminal', profiles: { terminal: { tools: ['cursor_terminal_execute', 'cursor_terminal_cancel', 'cursor_terminal_wake'] } } }));
    expect(names.includes('cursor_terminal_execute')).toBe(deleteEnabled && executeEnabled);
    expect(names.includes('cursor_terminal_cancel')).toBe(executeEnabled);
    expect(names.includes('cursor_terminal_wake')).toBe(executeEnabled);
    if (names.length) {
      const client = new Client({ name: 'fixture-client', version: '1' });
      const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
      const list = await client.listTools();
      if (executeEnabled) expect(list.tools.find(x => x.name === 'cursor_terminal_wake')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      if (deleteEnabled && executeEnabled) expect(list.tools.find(x => x.name === 'cursor_terminal_execute')?.annotations).toMatchObject({ destructiveHint: true });
      await client.close(); await server.close();
    }
  }
});

test('real MCP validates source and emits sanitized terminal output and identifiers in both text and structured content', async () => {
  const calls: unknown[] = [];
  let lost = false;
  const backend = { handle: async (input: unknown) => { calls.push(input); return lost
    ? { status: 'command', state: 'finished', sessionId: '11111111-1111-4111-8111-111111111111', commandId: 'two', commandOutcome: 'unknown', exitCode: null,
      reason: 'stream_ended_without_exit', cleanup: 'process_not_listed', outputReadFailed: true, reattachments: 3,
      continuityUncertain: true, outputOffset: 0, outputLength: 0, output: '' }
    : { status: 'command', state: 'finished', sessionId: '11111111-1111-4111-8111-111111111111', commandId: 'one', output: '\u001b[31mUNIQUE_PAYLOAD', outputTruncated: true, exitCode: 7 }; }, close() {} };
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerTerminalTools(server, PolicySchema.parse({ deleteEnabled: true, terminal: { agentId: 'bc-test', executeEnabled: true },
    defaultProfile: 'terminal', profiles: { terminal: { tools: ['cursor_terminal_status', 'cursor_terminal_execute', 'cursor_terminal_read'] } } }), '', backend);
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const args = { sessionId: '11111111-1111-4111-8111-111111111111', commandId: 'one' };
  try {
    await client.callTool({ name: 'cursor_terminal_status', arguments: {} });
    calls.length = 0;
    expect((await client.callTool({ name: 'cursor_terminal_execute', arguments: { ...args, command: 'x\0y' } })).isError).toBe(true);
    expect(calls).toEqual([]);
    // Oversized source reaches this stub handler.
    expect((await client.callTool({ name: 'cursor_terminal_execute', arguments: { ...args, command: '€'.repeat(6000) } })).isError).not.toBe(true);
    expect(calls).toHaveLength(1); calls.length = 0;
    const result = await client.callTool({ name: 'cursor_terminal_execute', arguments: { ...args, command: "printf 'x\ty'\nexit 7" } });
    expect(result.structuredContent).toMatchObject({ outputTruncated: true, exitCode: 7 });
    expect(JSON.stringify(result.structuredContent)).toContain('UNIQUE_PAYLOAD');
    // A text-only client needs the identifiers for its next call and the output itself.
    const text = (result.content as Array<{ type: string; text: string }>).map(block => block.text).join('\n');
    expect(text).toContain('UNIQUE_PAYLOAD');
    expect(text).toContain('"sessionId":"11111111-1111-4111-8111-111111111111"');
    expect(text).toContain('"commandId":"one"');
    expect(JSON.stringify(result)).not.toContain('u001b'); expect(calls).toHaveLength(1);
    // A completed command needs no recovery advice; a lost output stream carries it in both places.
    expect(result.structuredContent).not.toHaveProperty('hint'); expect(text).not.toContain('hint');
    lost = true;
    const failed = await client.callTool({ name: 'cursor_terminal_execute', arguments: { ...args, commandId: 'two', command: 'sleep 1' } });
    expect(failed.structuredContent).toMatchObject({ outputReadFailed: true, commandOutcome: 'unknown', exitCode: null,
      hint: 'Output stream failed; see reason and cleanup. Do not resubmit uncertain work. For future jobs needing results after MCP restart, use caller-owned detached tmux with output and exit-status files, polled by short commands.' });
    const failedText = (failed.content as Array<{ type: string; text: string }>).map(block => block.text).join('\n');
    expect(failedText).toContain('"reattachments":3'); expect(failedText).toContain('"continuityUncertain":true');
    expect(failedText).toContain('"hint":"Output stream failed; see reason and cleanup.');
    expect(failedText).toContain('caller-owned detached tmux with output and exit-status files, polled by short commands.');
  } finally { await client.close(); await server.close(); }
});

test('oversized command is refused before submission with machine-readable size fields', async () => {
  const f = fixture();
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerTerminalTools(server, PolicySchema.parse({ deleteEnabled: true, terminal: { agentId: 'bc-test', executeEnabled: true },
    defaultProfile: 'terminal', profiles: { terminal: { tools: ['*'] } } }), '', f.service);
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const args = { sessionId: f.service.sessionId, commandId: 'one', timeoutMs: 10000 };
  try {
    await client.callTool({ name: 'cursor_terminal_status', arguments: {} });
    // 5462 euro signs are 16386 UTF-8 bytes: the cap counts bytes, not code points.
    const refused = await client.callTool({ name: 'cursor_terminal_execute', arguments: { ...args, command: '€'.repeat(5462) } });
    expect(refused.isError).not.toBe(true);
    expect(refused.structuredContent).toMatchObject({ status: 'invalid_request', commandOutcome: 'not_submitted',
      reason: 'command_too_large', bytes: 16386, maxBytes: 16384 });
    expect(JSON.stringify(refused.content)).toContain('command_too_large');
    expect(f.calls).not.toContain('SpawnPty');
    // The rejected attempt created no record, so the same commandId still accepts work, and the cap boundary itself is accepted.
    expect((await client.callTool({ name: 'cursor_terminal_execute', arguments: { ...args, command: 'x'.repeat(16384) } })).structuredContent)
      .toMatchObject({ status: 'command', state: 'starting', commandOutcome: 'not_submitted' });
    await f.started(); expect(f.calls.filter(x => x === 'SpawnPty')).toHaveLength(1);
  } finally { await client.close(); await server.close(); f.service.close(); }
});

test('multi-target configuration is explicit and keeps the thirteen-tool surface with normal profile filtering', () => {
  expect(PolicySchema.parse({ terminal: { agentId: 'bc-test' } }).terminal).toMatchObject({ agentId: 'bc-test', targets: 'pinned', maxTargets: 16 });
  expect(() => PolicySchema.parse({ terminal: {} })).toThrow();
  expect(PolicySchema.parse({ terminal: { targets: 'profile' } }).terminal).toMatchObject({ targets: 'profile' });
  for (const maxTargets of [0, 129, 1.5]) expect(() => PolicySchema.parse({ terminal: { targets: 'profile', maxTargets } })).toThrow();
  const all = registerTerminalTools(new McpServer({ name: 'fixture', version: '1' }),
    PolicySchema.parse({ deleteEnabled: true, terminal: { targets: 'profile', executeEnabled: true },
      defaultProfile: 'all-terminal', profiles: { 'all-terminal': { tools: [
        'status', 'wake', 'execute', 'read', 'cancel', 'reset', 'session_list', 'session_create',
        'session_input', 'session_resize', 'session_read', 'session_attach', 'session_close',
      ].map(operation => `cursor_terminal_${operation}`) } } }));
  expect(all).toHaveLength(13);
  expect(new Set(all).size).toBe(13);
  const filtered = registerTerminalTools(new McpServer({ name: 'fixture', version: '1' }),
    PolicySchema.parse({ deleteEnabled: true, terminal: { targets: 'profile', executeEnabled: true },
      defaultProfile: 'selected', profiles: { selected: { tools: ['cursor_terminal_status', 'cursor_terminal_read'] } } }));
  expect(filtered).toEqual(['cursor_terminal_status', 'cursor_terminal_read']);
});

test('MCP target selection enforces pinned identity and profile scope before backend admission', async () => {
  for (const mode of ['pinned', 'profile', 'missing-scope'] as const) {
    const calls: Record<string, unknown>[] = [];
    const backend = { async handle(input: Record<string, unknown>) { calls.push(input); return { status: 'ready' }; }, close() {} };
    const scope = { assert: vi.fn(async (agentId: string) => { if (agentId === 'bc-denied') throw new Error('target denied'); }) };
    const server = new McpServer({ name: 'fixture', version: '1' });
    registerTerminalTools(server, PolicySchema.parse({ terminal: { agentId: mode === 'pinned' ? 'bc-default' : undefined,
      targets: mode === 'pinned' ? 'pinned' : 'profile' } }), '', backend, mode === 'missing-scope' ? undefined : scope);
    const client = new Client({ name: 'fixture-client', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    const status = (args: Record<string, unknown>) => client.callTool({ name: 'cursor_terminal_status', arguments: args });
    try {
      expect((await status({ overview: true })).structuredContent).toMatchObject({ status: 'targets', retainedTargets: 0 });
      expect(scope.assert).not.toHaveBeenCalled(); expect(calls).toEqual([]);
      if (mode === 'pinned') {
        expect((await status({ agentId: 'bc-other' })).structuredContent).toMatchObject({ status: 'target_mismatch' });
        expect(calls).toEqual([]);
        expect((await status({})).structuredContent).toMatchObject({ status: 'ready', agentId: 'bc-default' });
        expect(scope.assert).not.toHaveBeenCalled();
      } else if (mode === 'missing-scope') {
        expect((await status({ agentId: 'bc-allowed' })).structuredContent).toMatchObject({ status: 'scope_unavailable' });
        expect(calls).toEqual([]);
      } else {
        expect((await status({})).structuredContent).toMatchObject({ status: 'agent_required' });
        expect((await status({ agentId: 'bc-denied' })).isError).toBe(true);
        expect(calls).toEqual([]);
        expect((await status({ agentId: 'bc-allowed' })).structuredContent).toMatchObject({ status: 'ready', agentId: 'bc-allowed' });
        expect(scope.assert.mock.calls.map(call => call[0])).toEqual(['bc-denied', 'bc-allowed']);
      }
    } finally { await client.close(); await server.close(); }
  }
});

test('profile-owned output and cleanup survive scope API failure while new work still checks access', async () => {
  const f = fixture(); let unavailable = false;
  const scope = { assert: vi.fn(async () => { if (unavailable) throw new Error('account API unavailable'); }) };
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerTerminalTools(server, PolicySchema.parse({ terminal: { targets: 'profile', executeEnabled: true }, deleteEnabled: true,
    defaultProfile: 'terminal', profiles: { terminal: { tools: ['*'] } } }), '', f.service, scope);
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const call = (operation: string, args: Record<string, unknown> = {}) => client.callTool({ name: `cursor_terminal_${operation}`, arguments: { agentId: 'bc-test', ...args } });
  try {
    await call('status'); await call('execute', f.request('execute')); await f.started();
    f.data(Buffer.from('retained during outage')); unavailable = true;
    expect((await call('read', f.request('read'))).structuredContent).toMatchObject({ output: 'retained during outage' });
    expect((await call('cancel', f.request('cancel'))).isError).not.toBe(true);
    await f.finished();
    expect((await call('reset', f.request('reset'))).structuredContent).toMatchObject({ status: 'reset' });
    expect(scope.assert).toHaveBeenCalledTimes(2);
    for (const operation of ['status', 'session_list', 'execute', 'session_create']) {
      expect((await call(operation, { ...f.request(operation), sequence: 1 })).isError).toBe(true);
    }
    expect(scope.assert).toHaveBeenCalledTimes(6);
    expect(f.calls.filter(method => method === 'SpawnPty')).toHaveLength(1);
  } finally { await client.close(); await server.close(); }
});

test('target overview shrinks to budget without skipping retained entries', async () => {
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerTerminalTools(server, PolicySchema.parse({ terminal: { targets: 'profile' }, maxResponseBytes: 1024 }), '',
    { async handle() { return { status: 'ready' }; }, close() {} }, { async assert() {} });
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  const ids = Array.from({ length: 8 }, (_, i) => `bc-${i}${'a'.repeat(124)}`);
  try {
    for (const agentId of ids) await client.callTool({ name: 'cursor_terminal_status', arguments: { agentId } });
    let offset = 0; const seen: string[] = [];
    while (offset < ids.length) {
      const result = await client.callTool({ name: 'cursor_terminal_status', arguments: { overview: true, targetOffset: offset, targetLimit: 128 } });
      expect(result.content).toHaveLength(1);
      const page = result.structuredContent! as Record<string, unknown>;
      const entries = page.targets as { agentId: string }[];
      expect(entries.length).toBeGreaterThan(0); expect(entries.length).toBeLessThan(ids.length);
      expect(page.retainedTargets).toBe(ids.length);
      expect(page.targetNextOffset).toBe(offset + entries.length);
      seen.push(...entries.map(entry => entry.agentId)); offset = page.targetNextOffset as number;
    }
    expect(seen).toEqual(ids);
  } finally { await client.close(); await server.close(); }
});

test.each([true, false])('status reports prerequisites with WebSocket available: %s', async available => {
  const server = new McpServer({ name: 'fixture', version: '1' });
  const client = new Client({ name: 'fixture-client', version: '1' });
  try {
    vi.stubGlobal('WebSocket', available ? class { constructor() { throw new Error('unexpected WebSocket construction'); } } : undefined);
    registerTerminalTools(server, PolicySchema.parse({ terminal: { agentId: 'bc-test' } }));
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    expect((await client.callTool({ name: 'cursor_terminal_status', arguments: {} })).structuredContent)
      .toMatchObject({ status: available ? 'api_key_missing' : 'websocket_runtime_required' });
  } finally { vi.unstubAllGlobals(); await client.close(); await server.close(); }
});

 test('signal exit cannot be reported as success', async () => {
  const f = fixture(); await f.service.handle(f.request('execute')); await f.started();
  f.event({ ptyExited: { signal: 15 } });
  expect(await f.finished()).toMatchObject({ exitCode: null, signal: 15, reason: 'signaled', commandOutcome: 'ended', cleanup: 'process_exited' });
  f.service.close();
});

test('empty and unknown PTY events do not interrupt output or completion', async () => {
  const f = fixture(); await f.service.handle(f.request('execute')); await f.started();
  f.event({ ptyData: {} }); f.event({ eventId: 'future-event' }); f.data(Buffer.from('ok')); f.exit();
  expect(await f.finished()).toMatchObject({ output: 'ok', exitCode: 7, outputReadFailed: false, cleanup: 'process_exited' });
  expect(f.calls).not.toContain('TerminatePty'); f.service.close();
});

test.each([['no events', false], ['an event without an id', true]])('stream loss after %s preserves unknown outcome and checks owned-process cleanup', async (_case, idless) => {
  const f = fixture(); await f.service.handle(f.request('execute')); await f.started();
  if (idless) f.data(Buffer.from('no cursor'));
  f.breakStream();
  expect(await f.finished()).toMatchObject({ outputReadFailed: true, commandOutcome: 'unknown', exitCode: null,
    cleanup: 'process_not_listed', reattachments: 0, continuityUncertain: false });
  expect(f.attachments).toHaveLength(1);
  expect(f.calls).toContain('TerminatePty'); f.service.close();
});

test('a lost stream reattaches from its cursor and still reports the real exit', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.service.handle({ ...f.request('execute'), timeoutMs: 300000 }); await f.started();
    f.data(Buffer.from('one'), 'owned-1'); f.data(Buffer.from('two'), 'owned-2'); f.breakStream();
    await vi.advanceTimersByTimeAsync(1000); await f.attached(2);
    expect(f.attachments.at(-1)).toEqual({ ptyId: 'owned', lastEventId: 'owned-2' });
    f.data(Buffer.from('three'), 'owned-3'); f.exit(7, 'owned-4');
    expect(await f.finished()).toMatchObject({ output: 'onetwothree', exitCode: 7, commandOutcome: 'ended', outputComplete: true,
      outputReadFailed: false, reattachments: 1, continuityUncertain: false, cleanup: 'process_exited' });
    expect(f.calls).not.toContain('TerminatePty');
    expect(f.peers.every(peer => peer.closed)).toBe(true);
  } finally { vi.useRealTimers(); f.service.close(); }
});

// Replay is exclusive of the cursor, an unknown cursor replays the whole history, and a gap is only reported.
test.each([
  { replay: ['owned-3'], exit: 'owned-4', uncertain: false },
  { replay: ['owned-1', 'owned-2', 'owned-3'], exit: 'owned-4', uncertain: false },
  { replay: ['owned-9'], exit: 'owned-10', uncertain: true },
])('a reattached stream deduplicates its replay (continuity uncertain: $uncertain)', async ({ replay, exit, uncertain }) => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.service.handle({ ...f.request('execute'), timeoutMs: 300000 }); await f.started();
    f.data(Buffer.from('one'), 'owned-1'); f.data(Buffer.from('two'), 'owned-2'); f.breakStream();
    await vi.advanceTimersByTimeAsync(1000); await f.attached(2);
    for (const eventId of replay) f.data(Buffer.from(eventId === 'owned-1' ? 'one' : eventId === 'owned-2' ? 'two' : 'three'), eventId);
    f.exit(7, exit);
    expect(await f.finished()).toMatchObject({ output: 'onetwothree', exitCode: 7, outputReadFailed: false,
      reattachments: 1, continuityUncertain: uncertain, cleanup: 'process_exited' });
  } finally { vi.useRealTimers(); f.service.close(); }
});

test('output at the retention cap still advances the resume cursor', async () => {
  vi.useFakeTimers();
  const f = fixture(4);
  try {
    await f.service.handle({ ...f.request('execute'), timeoutMs: 300000 }); await f.started();
    f.data(Buffer.from('abcd'), 'owned-1'); f.data(Buffer.from('efgh'), 'owned-2'); f.breakStream();
    await vi.advanceTimersByTimeAsync(1000); await f.attached(2);
    expect(f.attachments.at(-1)).toEqual({ ptyId: 'owned', lastEventId: 'owned-2' });
    f.exit(0, 'owned-3');
    expect(await f.finished()).toMatchObject({ output: 'abcd', outputTruncated: true, exitCode: 0, outputComplete: true,
      reattachments: 1, continuityUncertain: false, cleanup: 'process_exited' });
  } finally { vi.useRealTimers(); f.service.close(); }
});

test('a transport connect failure consumes one attempt and the next one reattaches', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.service.handle({ ...f.request('execute'), timeoutMs: 300000 }); await f.started();
    f.data(Buffer.from('partial'), 'owned-1'); f.failConnect('gateway_unavailable'); f.breakStream();
    await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(2000); await f.attached(2);
    expect(f.attachments.at(-1)).toEqual({ ptyId: 'owned', lastEventId: 'owned-1' });
    f.exit(0, 'owned-2');
    expect(await f.finished()).toMatchObject({ exitCode: 0, outputReadFailed: false, reattachments: 2,
      continuityUncertain: false, cleanup: 'process_exited' });
  } finally { vi.useRealTimers(); f.service.close(); }
});

// A reaped PTY, a protocol violation and a replacement machine are outcomes, not transport noise.
test.each([
  { loss: 'terminal_stream_error', changed: false, attempts: 0, cleanup: 'process_not_listed' },
  { loss: 'invalid_gateway_response', changed: false, attempts: 0, cleanup: 'process_not_listed' },
  { loss: 'gateway_disconnected', changed: true, attempts: 1, cleanup: 'machine_changed' },
])('a non-transport failure ($loss) keeps the unknown outcome and its existing cleanup', async ({ loss, changed, attempts, cleanup }) => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.service.handle({ ...f.request('execute'), timeoutMs: 300000 }); await f.started();
    f.data(Buffer.from('partial'), 'owned-1');
    if (changed) f.changeMachine();
    f.breakStream(loss);
    if (attempts) await vi.advanceTimersByTimeAsync(1000);
    expect(await f.finished()).toMatchObject({ output: 'partial', outputReadFailed: true, commandOutcome: 'unknown',
      exitCode: null, reason: 'output_read_failed', reattachments: attempts, continuityUncertain: false, cleanup });
    expect(f.attachments).toHaveLength(1);
    expect(f.calls.includes('TerminatePty')).toBe(!changed);
  } finally { vi.useRealTimers(); f.service.close(); }
});

test('three transport failures exhaust the budget and fall back to the unknown outcome', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.service.handle({ ...f.request('execute'), timeoutMs: 300000 }); await f.started();
    f.data(Buffer.from('partial'), 'owned-1'); f.failConnect('terminal_connection_failed'); f.breakStream();
    await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(2000); await f.attached(2);
    f.breakStream('gateway_send_failed');
    await vi.advanceTimersByTimeAsync(4000); await f.attached(3);
    f.endStream();
    expect(await f.finished()).toMatchObject({ output: 'partial', outputReadFailed: true, commandOutcome: 'unknown',
      exitCode: null, reason: 'stream_ended_without_exit', reattachments: 3, cleanup: 'process_not_listed' });
    expect(f.attachments.map(input => input.lastEventId)).toEqual([undefined, 'owned-1', 'owned-1']);
    expect(f.calls).toContain('TerminatePty');
    expect(f.peers.every(peer => peer.closed)).toBe(true);
  } finally { vi.useRealTimers(); f.service.close(); }
});

test.each(['backoff', 'connect', 'deadline'] as const)('%s interruption installs no late attachment and releases the command once', async mode => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.service.handle({ ...f.request('execute'), timeoutMs: mode === 'deadline' ? 2000 : 300000 }); await f.started();
    f.data(Buffer.from('partial'), 'owned-1');
    if (mode !== 'backoff') f.holdConnect();
    f.breakStream();
    if (mode === 'backoff') await vi.advanceTimersByTimeAsync(500);
    else { await vi.advanceTimersByTimeAsync(1000); await vi.waitFor(() => expect(f.connectHeld()).toBe(true)); }
    if (mode === 'deadline') await vi.advanceTimersByTimeAsync(2000);
    else await f.service.handle(f.request('cancel'));
    if (mode !== 'backoff') f.releaseConnect();
    expect(await f.finished()).toMatchObject({ output: 'partial', commandOutcome: 'unknown', exitCode: null,
      outputReadFailed: false, reattachments: 1, cleanup: 'process_not_listed',
      reason: mode === 'deadline' ? 'deadline_exceeded' : 'cancel_requested' });
    expect(f.attachments).toHaveLength(1);
    expect(f.service.retention.activeCommandId).toBeNull();
    expect(f.calls.filter(call => call === 'TerminatePty')).toHaveLength(1);
    expect(f.peers.every(peer => peer.closed)).toBe(true);
  } finally { vi.useRealTimers(); f.service.close(); }
});

 test('explicit cancel retries only unresolved cleanup after connectivity returns', async () => {
  const f = fixture(); await f.service.handle(f.request('execute')); await f.started(); f.failCleanup();
  await f.service.handle(f.request('cancel')); expect(await f.finished()).toMatchObject({ cleanup: 'termination_unconfirmed' });
  f.recoverCleanup(); expect(await f.service.handle(f.request('cancel'))).toMatchObject({ cleanup: 'process_not_listed', commandOutcome: 'unknown' });
  expect(f.calls.filter(x => x === 'SpawnPty')).toHaveLength(1); f.service.close();
});

test('explicit reset releases settled records and makes old command requests invalid', async () => {
  const f = fixture(65536, 1); const old = f.request('execute');
  await f.service.handle(old); await f.started();
  expect(await f.service.handle(f.request('reset'))).toMatchObject({ status: 'reset_blocked' });
  f.exit(); await f.finished();
  expect(await f.service.handle(f.request('reset'))).toMatchObject({ status: 'reset' });
  expect(await f.service.handle(old)).toMatchObject({ status: 'session_mismatch' });
  expect(f.calls.filter(x => x === 'SpawnPty')).toHaveLength(1); f.service.close();
});

function wakeFixture(before = 'gateway_unavailable', outcome: boolean | Error = true, changed = false, failFirstPoll = false) {
  let connections = 0;
  const calls: string[] = [];
  const wake = vi.fn(async () => { if (outcome instanceof Error) throw outcome; return outcome; });
  const connector = { wake, async connect() {
    const first = ++connections === 1;
    if (first && before !== 'gateway_unavailable' && before !== 'ready') throw new TerminalFailure(before);
    return { machineId: !first && changed ? 'replacement' : 'original', peer: {
      async unary(method: string) { calls.push(method); if (first && before !== 'ready') throw new TerminalFailure(before); if (failFirstPoll && connections === 2) throw new TerminalFailure('gateway_unavailable'); return {}; },
      async stream() {}, close: vi.fn(),
    } };
  } };
  const service = new TerminalService('bc-test', connector);
  return { service, wake, calls };
}

test.each(['ready', 'terminal_permission_denied', 'machine_unavailable', 'invalid_machine_response', 'websocket_runtime_required'])('wake precheck %s never submits', async before => {
  const f = wakeFixture(before);
  try {
    const result = await f.service.handle({ operation: 'wake' });
    expect(result).toMatchObject({ wakeOutcome: 'not_submitted', machineChanged: null, readiness: before === 'ready' ? 'ready' : 'unavailable' });
    expect(f.wake).not.toHaveBeenCalled();
  } finally { f.service.close(); }
});

test.each([true, false, new TerminalFailure('terminal_connection_failed', true)])('wake keeps acknowledgement separate and does not reset or replay (%s)', async outcome => {
  const f = wakeFixture('gateway_unavailable', outcome, true, true), sessionId = f.service.sessionId;
  try {
    expect(await f.service.handle({ operation: 'wake' })).toMatchObject({ sessionId, readiness: 'ready', machineChanged: true,
      wakeOutcome: outcome === true ? 'signaled' : outcome === false ? 'not_signaled' : 'unknown',
      reason: outcome instanceof Error ? 'terminal_connection_failed' : null });
    expect(f.wake).toHaveBeenCalledOnce(); expect(f.calls).toEqual(['ListPtys', 'ListPtys', 'ListPtys']);
    expect(f.service.sessionId).toBe(sessionId);
  } finally { f.service.close(); }
});

test('zero wait acknowledges only; explicit rejection skips polling', async () => {
  for (const outcome of [true, new TerminalFailure('terminal_permission_denied')]) {
    const f = wakeFixture('gateway_unavailable', outcome);
    try {
      expect(await f.service.handle({ operation: 'wake', waitMs: 0 })).toMatchObject({ wakeOutcome: outcome === true ? 'signaled' : 'rejected', readiness: 'skipped', machineChanged: null });
      expect(f.calls).toEqual(['ListPtys']); expect(f.wake).toHaveBeenCalledOnce();
    } finally { f.service.close(); }
  }
});

test.each(['deadline', 'cancel', 'shutdown', 'precheck-cancel'])('wake %s ends an in-flight readiness probe without resubmission', async mode => {
  const controller = new AbortController(); let connects = 0;
  const wake = vi.fn(async () => true);
  const service = new TerminalService('bc-test', { wake, async connect(_expected, signal) {
    if (++connects === 1 && mode !== 'precheck-cancel') return { machineId: 'original', peer: {
      async unary() { throw new TerminalFailure('gateway_unavailable'); }, async stream() {}, close() {},
    } };
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new TerminalFailure(mode === 'precheck-cancel' ? 'gateway_unavailable' : 'request_cancelled')), { once: true }));
  } });
  try {
    const pending = service.handle({ operation: 'wake', waitMs: mode === 'deadline' ? 100 : 60000 }, controller.signal);
    await vi.waitFor(() => expect(connects).toBe(mode === 'precheck-cancel' ? 1 : 2));
    if (mode === 'cancel' || mode === 'precheck-cancel') controller.abort();
    if (mode === 'shutdown') service.close();
    expect(await pending).toMatchObject({ wakeOutcome: mode === 'precheck-cancel' ? 'not_submitted' : 'signaled', readiness: mode === 'deadline' ? 'deadline' : 'cancelled' });
    expect(wake).toHaveBeenCalledTimes(mode === 'precheck-cancel' ? 0 : 1);
  } finally { service.close(); }
});

test('profile wake checks scope before admission, validates wait and retains results', async () => {
  const f = fixture(); const scope = { assert: vi.fn(async (id: string) => { if (id === 'bc-denied') throw new Error('denied'); }) };
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerTerminalTools(server, PolicySchema.parse({ terminal: { targets: 'profile', executeEnabled: true }, deleteEnabled: true,
    defaultProfile: 'terminal', profiles: { terminal: { tools: ['*'] } } }), '', f.service, scope);
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  try {
    for (const args of [{ agentId: 'bc-denied' }, { agentId: 'bc-test', waitMs: -1 }, { agentId: 'bc-test', waitMs: 60001 }])
      expect((await client.callTool({ name: 'cursor_terminal_wake', arguments: args })).isError).toBe(true);
    expect(f.calls).toEqual([]);
    expect((await client.callTool({ name: 'cursor_terminal_wake', arguments: { agentId: 'bc-test' } })).structuredContent).toMatchObject({ status: 'already_ready' });
    await f.service.handle(f.request('execute')); await f.started(); f.exit(); await f.finished();
    const retained = await f.service.handle(f.request('read'));
    await client.callTool({ name: 'cursor_terminal_wake', arguments: { agentId: 'bc-test' } });
    expect(await f.service.handle(f.request('read'))).toEqual(retained);
    expect(f.calls.filter(x => x === 'SpawnPty')).toHaveLength(1);
  } finally { await client.close(); await server.close(); }
});

test('execute and session_create descriptions name the detached-job recipe and the restart loss', async () => {
  const server = new McpServer({ name: 'fixture', version: '1' });
  registerTerminalTools(server, PolicySchema.parse({ deleteEnabled: true, terminal: { agentId: 'bc-test', executeEnabled: true },
    defaultProfile: 'terminal', profiles: { terminal: { tools: ['*'] } } }));
  const client = new Client({ name: 'fixture-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  try {
    const list = await client.listTools();
    const description = (name: string) => list.tools.find(x => x.name === name)?.description ?? '';
    expect(description('cursor_terminal_execute')).toContain("For jobs exceeding timeoutMs or needing recoverable results after MCP restart, use caller-owned detached tmux with output and the workload's exit status in VM files, polled by short commands.");
    expect(description('cursor_terminal_session_create')).toContain('No command deadline; handles and retained output are lost on MCP restart, while the shell may keep running.');
  } finally { await client.close(); await server.close(); }
});
