import { expect, test, vi } from 'vitest';
import { TerminalTargets } from '../src/terminal-targets.js';
import { TerminalService } from '../src/terminal.js';
import { TerminalSessions } from '../src/terminal-sessions.js';
import { TerminalFailure, type TerminalConnector, type TerminalPeer } from '../src/terminal-gateway.js';

function fixture(maxTargets = 2) {
  const peers = new Map<string, ReturnType<typeof peerFixture>>();
  const closes: { mock: { calls: unknown[][] } }[] = [];
  const targets = new TerminalTargets(agentId => {
    const peer = peerFixture(agentId); peers.set(agentId, peer);
    const terminal = new TerminalService(agentId, peer.connector), sessions = new TerminalSessions(peer.connector);
    closes.push(vi.spyOn(terminal, 'close'), vi.spyOn(sessions, 'close'));
    return { terminal, sessions };
  }, maxTargets);
  return { targets, peers, closes };
}
function peerFixture(agentId: string) {
  let present = false, failSpawn = false;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let release: (() => void) | undefined;
  const calls: string[] = [];
  const peer: TerminalPeer = {
    async unary(method, _input, submitted) {
      calls.push(method);
      if (method === 'SpawnPty') {
        submitted?.(); present = true;
        if (failSpawn) throw new TerminalFailure('gateway_disconnected', true);
        return { ptyId: `${agentId}-pty` };
      }
      if (method === 'TerminatePty') { present = false; return { success: true }; }
      if (release) await new Promise<void>(resolve => { release = resolve; });
      return { ptys: present ? [{ ptyId: `${agentId}-pty` }] : [] };
    },
    stream(_method, _input, event, signal) {
      listener = event;
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new TerminalFailure('request_cancelled')), { once: true }));
    },
    close: vi.fn(),
  };
  const connector: TerminalConnector = { async connect() { return { machineId: `${agentId}-machine`, peer }; } };
  return { connector, calls, close: peer.close,
    failSpawn() { failSpawn = true; },
    holdList() { release = () => {}; },
    releaseList() { const done = release; release = undefined; done?.(); },
    async started() { await vi.waitFor(() => expect(listener).toBeTypeOf('function')); },
    finish(output: string) { present = false; listener!({ eventId: 'data-1', ptyData: { data: Buffer.from(output).toString('base64') } }); listener!({ eventId: 'exit-2', ptyExited: { exitCode: 7 } }); },
  };
}
const command = (sessionId: unknown) => ({ sessionId, commandId: 'same-id', command: 'exit 7', timeoutMs: 10000 });
async function finished(targets: TerminalTargets, agentId: string, args: Record<string, unknown>) {
  let result: Record<string, unknown> = {};
  await vi.waitFor(async () => { result = await targets.handle(agentId, 'read', args); expect(result.state).toBe('finished'); });
  return result;
}

test('lazy targets reject unknown mutations and isolate concurrent commands, outputs and crossed session IDs', async () => {
  const { targets, peers } = fixture();
  try {
    expect(await targets.handle('a', 'execute', command('stale'))).toMatchObject({ status: 'not_retained' });
    expect(await targets.handle('a', 'session_create', {})).toMatchObject({ status: 'not_retained' });
    expect(peers.size).toBe(0);
    const [a, b] = await Promise.all([targets.handle('a', 'status', {}), targets.handle('b', 'status', {})]);
    const ca = command(a.sessionId), cb = command(b.sessionId);
    expect(await targets.handle('b', 'execute', ca)).toMatchObject({ status: 'session_mismatch', agentId: 'b' });
    await Promise.all([targets.handle('a', 'execute', ca), targets.handle('b', 'execute', cb)]);
    await Promise.all([...peers.values()].map(peer => peer.started()));
    peers.get('a')!.finish('ONLY_A'); peers.get('b')!.finish('ONLY_B');
    expect(await finished(targets, 'a', ca)).toMatchObject({ output: 'ONLY_A', exitCode: 7, agentId: 'a' });
    expect(await finished(targets, 'b', cb)).toMatchObject({ output: 'ONLY_B', exitCode: 7, agentId: 'b' });
    expect(await targets.handle('b', 'read', ca)).toMatchObject({ status: 'session_mismatch' });
    expect(targets.overview(1, 1)).toMatchObject({ retainedTargets: 2, targetNextOffset: 2, targets: [{ agentId: 'b', retainedResults: 1, canRetire: false }] });
  } finally { targets.close(); }
});

test('read or unread results hold capacity until explicit reset; recreation invalidates old command IDs', async () => {
  const { targets, peers } = fixture(1);
  try {
    const a = await targets.handle('a', 'status', {}), args = command(a.sessionId);
    await targets.handle('a', 'execute', args); await peers.get('a')!.started();
    expect(await targets.handle('b', 'wake', {})).toMatchObject({ status: 'target_capacity' });
    peers.get('a')!.finish('retained'); await finished(targets, 'a', args);
    expect(await targets.handle('b', 'wake', {})).toMatchObject({ status: 'target_capacity' });
    expect(await targets.handle('a', 'reset', args)).toMatchObject({ status: 'reset' });
    expect(await targets.handle('b', 'status', {})).toMatchObject({ status: 'ready' });
    expect(await targets.handle('a', 'execute', args)).toMatchObject({ status: 'not_retained' });
    const recreated = await targets.handle('a', 'status', {});
    expect(recreated.sessionId).not.toBe(a.sessionId);
    expect(await targets.handle('a', 'execute', args)).toMatchObject({ status: 'session_mismatch' });
    expect(peers.get('a')!.calls).toEqual(['ListPtys']);
  } finally { targets.close(); }
});

test('an empty target with an in-flight request cannot be retired', async () => {
  const { targets, peers } = fixture(1);
  try {
    await targets.handle('a', 'status', {}); peers.get('a')!.holdList();
    const pending = targets.handle('a', 'wake', {});
    expect(targets.overview()).toMatchObject({ targets: [{ inFlight: 1, canRetire: false }] });
    expect(await targets.handle('b', 'wake', {})).toMatchObject({ status: 'target_capacity' });
    // Allow the pending connector continuation to enter ListPtys before release.
    await vi.waitFor(() => expect(peers.get('a')!.calls).toHaveLength(2));
    peers.get('a')!.releaseList(); await pending;
    expect(await targets.handle('b', 'status', {})).toMatchObject({ status: 'ready' });
  } finally { targets.close(); }
});

test('uncertain execution retains capacity without blocking another target; shutdown closes both managers', async () => {
  const { targets, peers, closes } = fixture();
  try {
    const a = await targets.handle('a', 'status', {}), b = await targets.handle('b', 'status', {});
    peers.get('a')!.failSpawn();
    await targets.handle('a', 'execute', command(a.sessionId));
    expect(await finished(targets, 'a', command(a.sessionId))).toMatchObject({ commandOutcome: 'unknown', cleanup: 'identity_unknown' });
    await targets.handle('b', 'execute', command(b.sessionId)); await peers.get('b')!.started();
    peers.get('b')!.finish('still works'); await finished(targets, 'b', command(b.sessionId));
    expect(await targets.handle('c', 'status', {})).toMatchObject({ status: 'target_capacity' });
    expect(await targets.handle('a', 'reset', command(a.sessionId))).toMatchObject({ status: 'reset_blocked' });
    targets.close();
    expect(closes).toHaveLength(4);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
    expect(await targets.handle('b', 'status', {})).toMatchObject({ status: 'closed' });
    expect(targets.overview()).toMatchObject({ status: 'closed', retainedTargets: 2 });
  } finally { targets.close(); }
});

test('interactive handles stay scoped and capacity is released only by explicit close', async () => {
  const { targets, peers } = fixture(1);
  try {
    const a = await targets.handle('a', 'session_list', {});
    const created = await targets.handle('a', 'session_create', { sessionId: a.sessionId, sequence: 1, cols: 80, rows: 24 });
    const owned = { sessionId: a.sessionId, terminalId: created.terminalId };
    expect(await targets.handle('b', 'session_input', { ...owned, sequence: 1, data: 'x' })).toMatchObject({ status: 'not_retained' });
    peers.get('a')!.finish('unread interactive output');
    expect(await targets.handle('b', 'session_list', {})).toMatchObject({ status: 'target_capacity' });
    expect(await targets.handle('a', 'session_close', owned)).toMatchObject({ status: 'closed' });
    await targets.handle('b', 'session_list', {});
    const recreated = await targets.handle('a', 'session_list', {});
    expect(recreated.sessionId).not.toBe(a.sessionId);
    expect(await targets.handle('a', 'session_create', { sessionId: a.sessionId, sequence: 1, cols: 80, rows: 24 })).toMatchObject({ status: 'session_mismatch' });
    expect(peers.get('a')!.calls).toEqual([]);
  } finally { targets.close(); }
});
