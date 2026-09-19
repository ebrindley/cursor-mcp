import { expect, test, vi } from 'vitest';
import { CursorTerminalConnector, TerminalFailure, TerminalGateway, type Pod } from '../src/terminal-gateway.js';

const pod: Pod = { tenantId: 'tenant-test', podId: 'pod-test', cluster: 'cluster-test', networkToken: 'private-network', ptyAuthToken: 'private-pty' };
const encode = (value: unknown, flags = 0) => {
  const b = Buffer.from(JSON.stringify(value)), h = Buffer.alloc(5); h[0] = flags; h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]);
};
class Socket extends EventTarget {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  respond: (frame: Record<string, unknown>) => void = () => {};
  constructor(openAfterMs = 0) {
    super();
    const open = () => { this.readyState = 1; this.dispatchEvent(new Event('open')); };
    if (openAfterMs) setTimeout(open, openAfterMs); else queueMicrotask(open);
  }
  send(text: string) { const f = JSON.parse(text); this.sent.push(f); if (f.type === 1) this.respond(f); }
  frame(value: unknown) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  reply(id: unknown, value: unknown = {}, status = 200) {
    this.frame({ type: 4, requestId: id, status, headers: {} });
    this.frame({ type: 3, requestId: id, body: Buffer.from(JSON.stringify(value)).toString('base64') });
    this.frame({ type: 5, requestId: id, trailers: {} });
  }
}
function fixture(timeout = 1000, keepaliveMs = 0) { // Keepalives stay off unless a case exercises them.
  let socket!: Socket;
  const gateway = new TerminalGateway(pod, () => { socket = new Socket(); return socket as unknown as WebSocket; }, timeout, undefined, keepaliveMs);
  return { gateway, socket: () => socket };
}
const listPtys = (socket: Socket) => socket.sent.filter(frame => frame.type === 1 && String(frame.path).endsWith('/ListPtys'));

test('JSON unary request uses exact service route, accepts an empty default response and closes cleanly', async () => {
  const f = fixture();
  const result = f.gateway.unary('ListPtys', {});
  f.socket().respond = frame => f.socket().reply(frame.requestId);
  expect(await result).toEqual({});
  expect(f.socket().sent[0]).toMatchObject({ path: '/agent.v1.PtyHostService/ListPtys', headers: { 'content-type': 'application/json' } });
  f.gateway.close(); expect(f.socket().readyState).toBe(3);
});

test('Connect stream reconstructs split headers/payloads and a coalesced terminal end frame', async () => {
  const f = fixture(), controller = new AbortController(), events: unknown[] = [];
  const result = f.gateway.stream('AttachPty', { ptyId: 'owned' }, event => events.push(event), controller.signal);
  f.socket().respond = frame => {
    const all = Buffer.concat([encode({ ptyData: { data: Buffer.from('🌍').toString('base64') } }), encode({ ptyExited: { exitCode: 7 } }), encode({}, 2)]);
    f.socket().frame({ type: 4, requestId: frame.requestId, status: 200 });
    for (const chunk of [all.subarray(0, 2), all.subarray(2, 13), all.subarray(13)]) f.socket().frame({ type: 3, requestId: frame.requestId, body: chunk.toString('base64') });
    f.socket().frame({ type: 5, requestId: frame.requestId, trailers: {} });
  };
  await result; expect(events).toHaveLength(2); expect(events[1]).toEqual({ ptyExited: { exitCode: 7 } });
  f.gateway.close();
});

test.each(['error', 'truncated', 'oversize', 'malformed'] as const)('invalid stream %s rejects without leaking gateway secrets', async mode => {
  const f = fixture(), controller = new AbortController();
  const result = f.gateway.stream('AttachPty', { ptyId: 'owned' }, () => {}, controller.signal);
  f.socket().respond = frame => {
    f.socket().frame({ type: 4, requestId: frame.requestId, status: 200 });
    let body = mode === 'error' ? encode({ error: { code: 'internal', message: 'private-pty' } }, 2) : mode === 'truncated' ? Buffer.from([0, 0]) : Buffer.alloc(5);
    if (mode === 'oversize') body.writeUInt32BE(2 * 1024 * 1024, 1);
    f.socket().frame({ type: 3, requestId: frame.requestId, body: mode === 'malformed' ? 'not!base64' : body.toString('base64') });
    f.socket().frame({ type: 5, requestId: frame.requestId, trailers: {} });
  };
  const error = await result.catch(error => error);
  expect(error).toBeInstanceOf(TerminalFailure); expect(error.message).not.toMatch(/private|cursorvm/);
  f.gateway.close();
});

test('after-send socket loss is ambiguous, never resubmits, and a later read may use a new connection', async () => {
  const f = fixture();
  const result = f.gateway.unary('SpawnPty', {});
  f.socket().respond = () => f.socket().close();
  await expect(result).rejects.toMatchObject({ submitted: true, code: 'gateway_disconnected' });
  expect(f.socket().sent.filter(x => x.type === 1)).toHaveLength(1);
  const read = f.gateway.unary('ListPtys', {});
  f.socket().respond = frame => f.socket().reply(frame.requestId);
  expect(await read).toEqual({}); f.gateway.close();
});

test('stream detach sends request cancellation and does not send TerminatePty', async () => {
  const f = fixture(), controller = new AbortController();
  const result = f.gateway.stream('AttachPty', { ptyId: 'owned' }, () => {}, controller.signal).catch(error => error);
  await vi.waitFor(() => expect(f.socket().sent).toHaveLength(1));
  controller.abort(); expect(await result).toMatchObject({ code: 'request_cancelled' });
  expect(f.socket().sent[1]).toMatchObject({ type: 2 });
  expect(f.socket().sent.some(x => String(x.path).includes('TerminatePty'))).toBe(false); f.gateway.close();
});

test('unary timeout is bounded and retains ambiguous delivery', async () => {
  const f = fixture(10);
  await expect(f.gateway.unary('SpawnPty', {})).rejects.toMatchObject({
    code: 'terminal_rpc_timeout', submitted: true, detail: { operation: 'SpawnPty' },
  });
  expect(f.socket().sent.filter(x => x.type === 1)).toHaveLength(1); f.gateway.close();
});

test('pod RPC rejection preserves its method and observed HTTP status without response bodies', async () => {
  const f = fixture();
  try {
    const pending = f.gateway.unary('ListPtys', {});
    f.socket().respond = frame => f.socket().reply(frame.requestId, { message: 'private-pty' }, 503);
    const error = await pending.catch(error => error);
    expect(error).toMatchObject({ code: 'terminal_rpc_failed', submitted: true,
      detail: { operation: 'ListPtys', httpStatus: 503 } });
    expect(JSON.stringify(error)).not.toContain('private-pty');
    expect(error.message).toBe('terminal_rpc_failed');
  } finally { f.gateway.close(); }
});

test('standalone auth caches its token, rediscovers machines, and rejects changed cleanup identity', async () => {
  const calls: string[] = [];
  let changed = false;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(String(url).endsWith('exchange_user_api_key') ? { accessToken: 'private-account', refreshToken: 'unused-refresh' } :
      { machine: { pod: { ...pod, podId: changed ? 'pod-replaced' : pod.podId } } }));
  }) as unknown as typeof fetch;
  const connector = new CursorTerminalConnector('private-api-key', 'bc-test', fetcher, () => new Socket() as unknown as WebSocket);
  const first = await connector.connect(); first.peer.close();
  changed = true; await expect(connector.connect(first.machineId)).rejects.toMatchObject({ code: 'machine_changed' });
  expect(calls.filter(x => x.endsWith('exchange_user_api_key'))).toHaveLength(1);
  expect(calls.filter(x => x.endsWith('GetMachine'))).toHaveLength(2);
});

test('authentication denial is sanitized, makes no discovery call, and never becomes ready', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: 'private-account private-api-key' }), { status: 403 })) as unknown as typeof fetch;
  const connector = new CursorTerminalConnector('private-api-key', 'bc-test', fetcher, () => new Socket() as unknown as WebSocket);
  await expect(connector.connect()).rejects.toMatchObject({ message: 'terminal_permission_denied', submitted: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('cached authentication expiry refreshes once for discovery without retrying a command', async () => {
  const calls: string[] = [];
  let discoveries = 0;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).endsWith('exchange_user_api_key')) return new Response(JSON.stringify({ accessToken: 'private-account' }));
    if (++discoveries === 2) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ machine: { pod } }));
  }) as unknown as typeof fetch;
  const connector = new CursorTerminalConnector('private-api-key', 'bc-test', fetcher, () => new Socket() as unknown as WebSocket);
  (await connector.connect()).peer.close(); (await connector.connect()).peer.close();
  expect(calls.filter(x => x.endsWith('exchange_user_api_key'))).toHaveLength(2);
  expect(discoveries).toBe(3); expect(calls.some(x => x.includes('SpawnPty'))).toBe(false);
});

 test('late close from an old socket cannot fail a request on its replacement', async () => {
  const f = fixture(); const initial = f.gateway.unary('ListPtys', {});
  const old = f.socket(); old.respond = frame => old.reply(frame.requestId); await initial;
  old.readyState = 2;
  const replacement = f.gateway.unary('ListPtys', {});
  const current = f.socket();
  await vi.waitFor(() => expect(current.sent).toHaveLength(1));
  old.close(); current.reply(current.sent[0]!.requestId);
  expect(await replacement).toEqual({}); f.gateway.close();
});

test.each([true, false, 'omitted', null, 'malformed', 'network', 401, 403, 404, 500] as const)('wake submits once and classifies acknowledgement %s', async outcome => {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith('exchange_user_api_key')) return Response.json({ accessToken: 'private-account' });
    if (outcome === 'network') throw new Error('private credential-bearing error');
    if (typeof outcome === 'number') return new Response('{}', { status: outcome });
    return Response.json(outcome === 'omitted' ? {} : { signaled: outcome });
  }) as typeof fetch;
  const connector = new CursorTerminalConnector('private-api-key', 'bc-test', fetcher);
  if (typeof outcome === 'boolean' || outcome === 'omitted' || outcome === null) expect(await connector.wake()).toBe(outcome === true);
  else {
    const failure = await connector.wake().catch(error => error);
    expect(failure).toBeInstanceOf(TerminalFailure);
    expect(failure.submitted).toBe(outcome !== 401 && outcome !== 403);
    expect(failure.message).not.toMatch(/private|credential/);
    // The detail names the RPC and, for an HTTP rejection, its status; a network failure has no status.
    expect(failure.detail).toEqual(outcome === 'malformed' ? {} : outcome === 'network'
      ? { operation: 'WakeBackgroundComposer' } : { httpStatus: outcome, operation: 'WakeBackgroundComposer' });
  }
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ url: 'https://api2.cursor.sh/aiserver.v1.BackgroundComposerService/WakeBackgroundComposer', body: { bcId: 'bc-test', reason: 1 } });
});

test.each(['auth', 'discovery', 'opening', 'rpc'] as const)('probe cancellation bounds in-flight %s', async phase => {
  const controller = new AbortController();
  const sockets: Socket[] = [];
  const fetcher = vi.fn(async (url, init) => {
    if ((phase === 'auth' && String(url).endsWith('exchange_user_api_key')) || (phase === 'discovery' && String(url).endsWith('GetMachine')))
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return Response.json(String(url).endsWith('exchange_user_api_key') ? { accessToken: 'private-account' } : { machine: { pod } });
  }) as typeof fetch;
  const connector = new CursorTerminalConnector('private-api-key', 'bc-test', fetcher, () => {
    if (phase === 'opening') return Object.assign(new EventTarget(), { readyState: 0, close: vi.fn() }) as unknown as WebSocket;
    const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
  let peer: Awaited<ReturnType<typeof connector.connect>>['peer'] | undefined;
  const pending = connector.connect(undefined, controller.signal).then(async connection => {
    peer = connection.peer; return peer.unary('ListPtys', {});
  }).catch(error => error);
  await vi.waitFor(() => expect(phase === 'auth' ? vi.mocked(fetcher).mock.calls.length : phase === 'discovery' ? vi.mocked(fetcher).mock.calls.length - 1 : peer).toBeTruthy());
  controller.abort();
  const failure = await pending;
  expect(failure).toBeInstanceOf(TerminalFailure);
  peer?.close();
  for (const socket of sockets) expect(socket.readyState).toBe(3);
});

test('an idle stream is kept warm by one ListPtys, a received frame restarts the interval, and settling ends keepalives', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(10000, 20000), controller = new AbortController(), events: unknown[] = [];
    const result = f.gateway.stream('AttachPty', { ptyId: 'owned' }, event => events.push(event), controller.signal);
    const socket = f.socket();
    let id = '';
    socket.respond = frame => {
      if (String(frame.path).endsWith('/ListPtys')) socket.reply(frame.requestId);
      else { id = String(frame.requestId); socket.frame({ type: 4, requestId: id, status: 200 }); }
    };
    await vi.advanceTimersByTimeAsync(15000);
    expect(listPtys(socket)).toHaveLength(0);
    socket.frame({ type: 3, requestId: id, body: encode({ ptyData: { data: '' } }).toString('base64') });
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toHaveLength(1); expect(listPtys(socket)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15000);
    expect(socket.sent[1]).toMatchObject({ type: 1, path: '/agent.v1.PtyHostService/ListPtys', headers: { 'content-type': 'application/json' } });
    expect(listPtys(socket)).toHaveLength(1);
    socket.frame({ type: 3, requestId: id, body: Buffer.concat([encode({ ptyExited: { exitCode: 0 } }), encode({}, 2)]).toString('base64') });
    socket.frame({ type: 5, requestId: id, trailers: {} });
    await result; expect(events).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(listPtys(socket)).toHaveLength(1); f.gateway.close();
  } finally { vi.useRealTimers(); }
});

test('an unanswered keepalive times out on its own and leaves its stream to finish', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(10000, 20000), controller = new AbortController(), events: unknown[] = [];
    const result = f.gateway.stream('AttachPty', { ptyId: 'owned' }, event => events.push(event), controller.signal);
    const socket = f.socket();
    let id = '';
    socket.respond = frame => { // The stream is answered; the keepalive gets no reply at all.
      if (String(frame.path).endsWith('/AttachPty')) { id = String(frame.requestId); socket.frame({ type: 4, requestId: id, status: 200 }); }
    };
    await vi.advanceTimersByTimeAsync(20000);
    expect(listPtys(socket)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(socket.sent.filter(frame => frame.type === 2)).toEqual([{ type: 2, requestId: listPtys(socket)[0]!.requestId }]);
    socket.frame({ type: 3, requestId: id, body: Buffer.concat([encode({ ptyData: { data: '' } }), encode({}, 2)]).toString('base64') });
    socket.frame({ type: 5, requestId: id, trailers: {} });
    await result; expect(events).toHaveLength(1); expect(listPtys(socket)).toHaveLength(1);
    f.gateway.close();
  } finally { vi.useRealTimers(); }
});

test('keepalives need a live socket with a pending stream, so unary-only work, a closed gateway, and a replaced socket get none', async () => {
  vi.useFakeTimers();
  try {
    const quiet = fixture(10000, 20000); // Unary-only traffic is never kept warm.
    const read = quiet.gateway.unary('ListPtys', {});
    quiet.socket().respond = frame => quiet.socket().reply(frame.requestId);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await read).toEqual({}); expect(quiet.socket().sent).toHaveLength(1); quiet.gateway.close();

    const closed = fixture(10000, 20000); // close() disarms a keepalive that is already armed.
    const detached = closed.gateway.stream('AttachPty', { ptyId: 'owned' }, () => {}, new AbortController().signal).catch(error => error);
    const armed = closed.socket();
    armed.respond = frame => armed.frame({ type: 4, requestId: frame.requestId, status: 200 });
    await vi.advanceTimersByTimeAsync(19000);
    closed.gateway.close();
    expect(await detached).toMatchObject({ code: 'terminal_closed' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(listPtys(armed)).toHaveLength(0);

    const sockets: Socket[] = []; // A silently lost socket's timer cannot keepalive the socket that replaced it.
    const gateway = new TerminalGateway(pod, () => {
      const socket = new Socket(sockets.length ? 5000 : 0); sockets.push(socket); return socket as unknown as WebSocket;
    }, 10000, undefined, 20000);
    const stranded = gateway.stream('AttachPty', { ptyId: 'owned' }, () => {}, new AbortController().signal).catch(error => error);
    const [old] = sockets as [Socket];
    old.respond = frame => old.frame({ type: 4, requestId: frame.requestId, status: 200 });
    await vi.advanceTimersByTimeAsync(19000);
    old.readyState = 2; // Closing, with no close event delivered yet.
    const reopened = gateway.unary('ListPtys', {});
    const replacement = sockets[1]!;
    replacement.respond = frame => replacement.reply(frame.requestId);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await reopened).toEqual({});
    expect(listPtys(old)).toHaveLength(0); expect(listPtys(replacement)).toHaveLength(1);
    gateway.close(); expect(await stranded).toMatchObject({ code: 'terminal_closed' });
  } finally { vi.useRealTimers(); }
});
