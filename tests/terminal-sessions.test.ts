import { test, expect, vi } from 'vitest';
import { TerminalSessions } from '../src/terminal-sessions.js';
import { TerminalFailure, type TerminalConnector, type TerminalPeer } from '../src/terminal-gateway.js';

function fixture(bytes = 65536, capacity = 4) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const listeners = new Map<string, { event: (e: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const present = new Set<string>(); let releaseSpawn: (() => void) | undefined; let pauseSpawn = false;
  let counter = 0, failInput = false, failCleanup = false, changed = false, failSpawn = false;
  let timeoutMethod: string | undefined;
  const connector: TerminalConnector = { async connect(expected) {
    if (changed && expected) throw new TerminalFailure('machine_changed');
    const peer: TerminalPeer = { async unary(method, input, submitted) {
      calls.push({ method, input }); submitted?.();
      if (method === timeoutMethod) { timeoutMethod = undefined; throw new TerminalFailure('terminal_rpc_timeout', true); }
      if (method === 'SpawnPty') { if (pauseSpawn) await new Promise<void>(resolve => { releaseSpawn = resolve; }); if (failSpawn) throw new TerminalFailure('gateway_disconnected', true); const ptyId = `pty-${++counter}`; present.add(ptyId); return { ptyId }; }
      if (method === 'SendInput' && failInput) throw new TerminalFailure('gateway_disconnected', true);
      if (method === 'TerminatePty') { if (failCleanup) throw new TerminalFailure('gateway_disconnected', true); present.delete(input.ptyId as string); }
      if (method === 'ListPtys') return { ptys: [...present].map(ptyId => ({ ptyId })) };
      return { success: true };
    }, stream(_method, input, event, signal) {
      calls.push({ method: 'AttachPty', input });
      return new Promise<void>((_resolve, reject) => {
        listeners.set(input.ptyId as string, { event: e => { try { event(e); } catch (error) { reject(error as Error); } }, reject });
        signal.addEventListener('abort', () => reject(new TerminalFailure('request_cancelled')), { once: true });
      });
    }, close() {} };
    return { machineId: 'machine', peer };
  } };
  const service = new TerminalSessions(connector, bytes, capacity);
  const request = (operation: string, args = {}) => ({ operation, sessionId: service.sessionId, ...args });
  return { service, calls, request, pauseSpawn: () => { pauseSpawn = true; }, releaseSpawn: () => releaseSpawn!(),
    timeoutNext: (method: string) => { timeoutMethod = method; },
    inputFails: () => { failInput = true; }, cleanupFails: () => { failCleanup = true; }, recover: () => { failCleanup = false; },
    changed: () => { changed = true; }, spawnFails: () => { failSpawn = true; },
    event: (event: Record<string, unknown>, pty = 'pty-1') => listeners.get(pty)!.event(event),
    drop: (pty = 'pty-1') => listeners.get(pty)!.reject(new TerminalFailure('gateway_disconnected')),
    async create(sequence = 1) { return service.handle(request('create', { sequence })); },
  };
}

test('owned sessions support persistent input/resize, bounded concurrency and safe sequence retirement', async () => {
  const f = fixture(65536, 2), a = await f.create(), b = await f.create(2);
  expect(a.terminalId).not.toBe(b.terminalId); expect(await f.create(3)).toMatchObject({ status: 'session_capacity' });
  const input = f.request('input', { terminalId: a.terminalId, sequence: 1, data: 'cd /tmp\n' });
  // 5462 euro signs are 16386 UTF-8 bytes. Refused before any sequence bookkeeping, so sequence 1 stays usable below.
  expect(await f.service.handle({ ...input, data: '€'.repeat(5462) })).toMatchObject({ status: 'invalid_request',
    inputOutcome: 'not_submitted', reason: 'input_too_large', bytes: 16386, maxBytes: 16384 });
  expect(f.calls.some(c => c.method === 'SendInput')).toBe(false);
  expect(await f.service.handle(input)).toMatchObject({ inputOutcome: 'submitted', nextInputSequence: 2 });
  expect(await f.service.handle(input)).toMatchObject({ inputOutcome: 'submitted' });
  expect(await f.service.handle({ ...input, data: 'changed' })).toMatchObject({ status: 'sequence_conflict' });
  await f.service.handle({ ...input, sequence: 2, data: '\x03' });
  expect(await f.service.handle(input)).toMatchObject({ status: 'request_retired' });
  expect(f.calls.filter(c => c.method === 'SendInput')).toHaveLength(2);
  expect(Buffer.from(f.calls.filter(c => c.method === 'SendInput')[1]!.input.data as string, 'base64').toString()).toBe('\x03');
  expect(await f.service.handle(f.request('resize', { terminalId: a.terminalId, cols: 120, rows: 40 }))).toMatchObject({ status: 'resized' });
  expect(await f.service.handle(f.request('close', { terminalId: a.terminalId }))).toMatchObject({ status: 'closed' });
  expect(await f.create(1)).toMatchObject({ status: 'request_retired' });
  expect((await f.create(3)).terminalId).toBeTypeOf('string');
  // Input at the byte limit is accepted.
  expect(await f.service.handle(f.request('input', { terminalId: b.terminalId, sequence: 1, data: 'x'.repeat(16384) })))
    .toMatchObject({ inputOutcome: 'submitted', nextInputSequence: 2 }); f.service.close();
});

test('stream loss detaches, resumes from opaque cursor, suppresses replay and exposes output gaps', async () => {
  const f = fixture(12), a = await f.create();
  const data = (eventId: string, text: string) => ({ eventId, ptyData: { data: Buffer.from(text).toString('base64') } });
  f.event(data('opaque-a', '🌍🌍')); f.drop();
  await vi.waitFor(async () => expect((await f.service.handle(f.request('list'))).terminals).toMatchObject([{ state: 'detached' }]));
  expect(f.calls.some(c => c.method === 'TerminatePty')).toBe(false);
  await f.service.handle(f.request('attach', { terminalId: a.terminalId }));
  expect(f.calls.filter(c => c.method === 'AttachPty').at(-1)?.input).toMatchObject({ lastEventId: 'opaque-a' });
  f.event(data('opaque-a', '🌍🌍')); f.event(data('opaque-b', '🌍🌍'));
  expect(await f.service.handle(f.request('read', { terminalId: a.terminalId, outputOffset: 0 })))
    .toMatchObject({ output: '🌍🌍🌍', outputGap: 1, outputOffset: 1, outputNextOffset: 4, reconnectGapPossible: true });
  f.service.close();
});

test('uncertain input and spawn cannot be replayed by retrying their sequence', async () => {
  const f = fixture(), a = await f.create(); f.inputFails();
  const input = f.request('input', { terminalId: a.terminalId, sequence: 1, data: 'echo test\n' });
  expect(await f.service.handle(input)).toMatchObject({ inputOutcome: 'unknown' });
  expect(await f.service.handle(input)).toMatchObject({ inputOutcome: 'unknown' });
  expect(f.calls.filter(c => c.method === 'SendInput')).toHaveLength(1); f.service.close();
  const g = fixture(); g.spawnFails();
  expect(await g.create()).toMatchObject({ creationOutcome: 'unknown', cleanup: 'identity_unknown' });
  expect(await g.create()).toMatchObject({ creationOutcome: 'unknown' });
  expect(g.calls.filter(c => c.method === 'SpawnPty')).toHaveLength(1); g.service.close();
});

test.each(['input', 'resize'] as const)('unary %s timeout detaches only its session and permits explicit cursor reattachment without replay', async operation => {
  const f = fixture(), a = await f.create(), b = await f.create(2);
  f.event({ eventId: 'cursor-before-timeout', ptyData: { data: Buffer.from('ready').toString('base64') } });
  f.event({ eventId: 'other-cursor', ptyData: { data: '' } }, 'pty-2');
  const request = f.request(operation, { terminalId: a.terminalId, sequence: 1, data: 'marker\n', cols: 100, rows: 30 });
  f.timeoutNext(operation === 'input' ? 'SendInput' : 'ResizePty');
  expect(await f.service.handle(request)).toMatchObject({ status: 'terminal_rpc_timeout',
    ...(operation === 'input' ? { inputOutcome: 'unknown', nextInputSequence: 2 } : {}) });
  expect((await f.service.handle(f.request('list'))).terminals).toEqual([
    { terminalId: a.terminalId, state: 'detached' }, { terminalId: b.terminalId, state: 'attached' },
  ]);
  expect(f.calls.filter(c => c.method === 'AttachPty')).toHaveLength(2);
  if (operation === 'input') expect(await f.service.handle(request)).toMatchObject({ inputOutcome: 'unknown' });
  expect(await f.service.handle(f.request('attach', { terminalId: a.terminalId }))).toMatchObject({ reconnectGapPossible: true });
  expect(f.calls.filter(c => c.method === 'AttachPty')).toHaveLength(3);
  expect(f.calls.filter(c => c.method === 'AttachPty').at(-1)?.input).toEqual({ ptyId: 'pty-1', lastEventId: 'cursor-before-timeout' });
  expect(f.calls.filter(c => c.method === (operation === 'input' ? 'SendInput' : 'ResizePty'))).toHaveLength(1);
  expect(f.calls.some(c => c.method === 'TerminatePty')).toBe(false);
  const next = operation === 'input' ? 2 : 1;
  expect(await f.service.handle(f.request('input', { terminalId: a.terminalId, sequence: next, data: 'new input\n' })))
    .toMatchObject({ inputOutcome: 'submitted', nextInputSequence: next + 1 });
  f.service.close();
});

test('close retries unresolved cleanup, and refuses cleanup against a replacement machine', async () => {
  const f = fixture(), a = await f.create(); f.cleanupFails();
  expect(await f.service.handle(f.request('close', { terminalId: a.terminalId }))).toMatchObject({ cleanup: 'termination_unconfirmed', reconnectGapPossible: true });
  f.recover(); expect(await f.service.handle(f.request('close', { terminalId: a.terminalId }))).toMatchObject({ status: 'closed' });
  const b = await f.create(2); f.changed(); const before = f.calls.filter(c => c.method === 'TerminatePty').length;
  expect(await f.service.handle(f.request('close', { terminalId: b.terminalId }))).toMatchObject({ cleanup: 'machine_changed' });
  expect(f.calls.filter(c => c.method === 'TerminatePty')).toHaveLength(before);
  expect(await f.service.handle(f.request('close', { terminalId: b.terminalId, forget: true }))).toMatchObject({ status: 'released', remoteOutcome: 'unknown', cleanup: 'machine_changed' });
  expect((await f.service.handle(f.request('list'))).terminals).toEqual([]);
  expect(f.calls.filter(c => c.method === 'TerminatePty')).toHaveLength(before); f.service.close();
});

test('wait cancellation and MCP shutdown leave shells alive; only shell exit marks completion', async () => {
  const f = fixture(), a = await f.create(), abort = new AbortController();
  const waiting = f.service.handle(f.request('read', { terminalId: a.terminalId, waitMs: 10000 }), abort.signal); abort.abort();
  expect(await waiting).toMatchObject({ state: 'attaching' });
  f.event({ eventId: 'exit', ptyExited: { signal: 15 } });
  expect(await f.service.handle(f.request('read', { terminalId: a.terminalId }))).toMatchObject({ state: 'exited', signal: 15, exitCode: null });
  await f.create(2); f.service.close(); expect(f.calls.some(c => c.method === 'TerminatePty')).toBe(false);
});

 test('forget releases only unknown identities and never restores old create authority', async () => {
  const f = fixture(65536, 1); f.spawnFails(); const a = await f.create();
  expect(await f.create(2)).toMatchObject({ status: 'session_capacity' });
  expect(await f.service.handle(f.request('close', { terminalId: a.terminalId, forget: true }))).toMatchObject({ status: 'released', remoteOutcome: 'unknown' });
  expect(await f.create(1)).toMatchObject({ status: 'request_retired' });
  expect(await f.create(2)).toMatchObject({ creationOutcome: 'unknown' });
  expect(f.calls.filter(c => c.method === 'SpawnPty')).toHaveLength(2); f.service.close();
  const g = fixture(); const healthy = await g.create();
  expect(await g.service.handle(g.request('close', { terminalId: healthy.terminalId, forget: true }))).toMatchObject({ status: 'release_not_allowed' });
  expect((await g.service.handle(g.request('list'))).terminals).toHaveLength(1); g.service.close();
});

 test('forget cannot retire a spawn whose reply is still in flight', async () => {
  const f = fixture(); f.pauseSpawn(); const creating = f.create();
  await vi.waitFor(() => expect(f.calls.some(c => c.method === 'SpawnPty')).toBe(true));
  const list = await f.service.handle(f.request('list'));
  const terminalId = (list.terminals as {terminalId: string}[])[0]!.terminalId;
  expect(await f.service.handle(f.request('close', { terminalId, forget: true }))).toMatchObject({ status: 'release_not_allowed' });
  f.releaseSpawn(); expect(await creating).toMatchObject({ creationOutcome: 'submitted' });
  expect((await f.service.handle(f.request('list'))).terminals).toHaveLength(1); f.service.close();
});
