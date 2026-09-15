import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { activeProfile, type Policy } from '../config.js';
import type { AgentScope } from '../agent-scope.js';
import { TerminalTargets } from '../terminal-targets.js';
import { currentRequestSignal } from '../client.js';
import { CursorTerminalConnector } from '../terminal-gateway.js';
import { TerminalSessions } from '../terminal-sessions.js';
import { TerminalService } from '../terminal.js';
import { defineTool } from './register.js';
import { fitTerminalPage } from '../terminal-output.js';
import { ok, structuredCost } from './result.js';
import { READ, CANCEL, DESTRUCTIVE, REVERSIBLE } from './annotations.js';

export function registerTerminalTools(server: McpServer, policy: Policy, apiKey = '',
  supplied?: Pick<TerminalService, 'handle' | 'close'>, scope?: Pick<AgentScope, 'assert'>): string[] {
  const config = policy.terminal;
  if (!config) return [];
  const targets = new TerminalTargets(agentId => {
    const connector = new CursorTerminalConnector(apiKey, agentId);
    return { terminal: (supplied ?? new TerminalService(agentId, connector)) as TerminalService,
      sessions: new TerminalSessions(connector) };
  }, config.targets === 'profile' ? config.maxTargets : 1);
  const onclose = server.server.onclose;
  server.server.onclose = () => { targets.close(); onclose?.(); };
  const names: string[] = [];
  const profile = activeProfile(policy);
  const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
  const sessionId = z.string().uuid();
  const invoke = async (operation: string, args: Record<string, unknown> = {}) => {
    const signal = currentRequestSignal();
    let raw: Record<string, unknown>;
    if (operation === 'status' && args.overview === true) {
      const offset = Number(args.targetOffset ?? 0);
      let limit = Number(args.targetLimit ?? 10);
      raw = targets.overview(offset, limit);
      while (limit > 1 && structuredCost(raw) > policy.maxResponseBytes) {
        raw = targets.overview(offset, --limit);
      }
      if (structuredCost(raw) > policy.maxResponseBytes) {
        raw = { status: 'response_budget_too_small' };
      }
    } else {
      const agentId = typeof args.agentId === 'string' ? args.agentId : config.agentId;
      if (!agentId) raw = { status: 'agent_required' };
      else if (config.targets !== 'profile' && agentId !== config.agentId) raw = { status: 'target_mismatch', agentId };
      else if (config.targets === 'profile' && !scope) raw = { status: 'scope_unavailable', agentId };
      else {
        // Recheck discovery/new work. Owned handles stay usable for output, input and
        // cleanup during an account-API outage; the registry cannot admit them.
        if (config.targets === 'profile' && ['status', 'wake', 'session_list', 'execute', 'session_create'].includes(operation))
          await scope!.assert(agentId, signal ? { signal } : {});
        raw = await targets.handle(agentId, operation, args, signal);
      }
    }
    const result = fitTerminalPage(raw, policy.maxResponseBytes);
    const summary = Object.fromEntries([
      'agentId', 'status', 'maxTargets', 'retainedTargets', 'targetOffset', 'targetNextOffset', 'state', 'commandOutcome', 'exitCode', 'signal', 'reason', 'cleanup', 'outputComplete',
      'outputReadFailed', 'outputTruncated', 'outputOffset', 'outputNextOffset', 'outputLength',
      'outputStartOffset', 'outputEndOffset', 'outputGap', 'reconnectGapPossible', 'inputOutcome', 'nextInputSequence', 'remoteOutcome',
      'wakeOutcome', 'readiness', 'machineChanged',
    ].filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]]));
    return ok({ source: 'Cursor direct VM terminal', text: JSON.stringify(summary), structured: result, policy });
  };
  const add = (operation: string, description: string, schema: z.ZodRawShape, annotations: typeof READ | typeof CANCEL | typeof DESTRUCTIVE | typeof REVERSIBLE) => {
    if (!annotations.readOnlyHint && !config.executeEnabled) return;
    const name = `cursor_terminal_${operation}`;
    if (defineTool(server, policy, profile, { name, config: { description, inputSchema: { agentId: z.string().max(128).regex(/^bc-[A-Za-z0-9-]+$/).optional(), ...schema }, annotations },
      handler: (args: Record<string, unknown>) => invoke(operation, args) })) names.push(name);
  };
  add('status', 'Check VM availability and get its command sessionId; does not intentionally request a wake. agentId defaults to the configured target. overview lists retained targets; follow targetNextOffset.', { overview: z.boolean().default(false), targetOffset: z.number().int().min(0).max(128).default(0), targetLimit: z.number().int().min(1).max(128).default(10) }, READ);
  add('wake', 'Explicitly request VM wake once if discovery succeeds but its gateway is unavailable. No agent prompt or command replay. wakeOutcome is acknowledgement, not readiness; unknown must not be automatically retried. waitMs bounds readiness checks after submission (0 skips); precheck up to 30s, each HTTP request up to 10s.',
    { waitMs: z.number().int().min(0).max(60000).default(30000) }, CANCEL);
  add('execute', 'Run Bash once in /tmp. Use status sessionId and a unique commandId; poll read. Identical requests deduplicate. Never retry uncertain execution under a new ID. command must be at most 16384 UTF-8 bytes; a schema or argument rejection means this request submitted nothing. Combined PTY output; startup profiles disabled.',
    { sessionId, commandId: id, command: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 16384, 'command must be at most 16384 UTF-8 bytes')
      .refine(value => !value.includes('\0'), 'command must not contain NUL'), timeoutMs: z.number().int().min(1).max(300000).default(30000) }, DESTRUCTIVE);
  add('read', 'Read retained command output. Follow outputNextOffset (Unicode code points). Retains first 64 KiB; outputTruncated marks loss. outputComplete means process exit observed, not lossless output. not_retained never proves non-execution.',
    { sessionId, commandId: id, outputOffset: z.number().int().min(0).max(65536).default(0), outputLimit: z.number().int().min(1).max(2000).default(2000) }, READ);
  add('cancel', 'Terminate an owned command and verify PTY absence on its original machine. Unknown cleanup can be retried; absence does not prove descendant exit. MCP cancellation is separate.', { sessionId, commandId: id }, CANCEL);
  add('reset', 'Release settled command results and rotate command sessionId. Refuses active work or unresolved cleanup. Old session IDs fail; interactive terminals are unaffected.', { sessionId }, CANCEL);
  const owned = { sessionId, terminalId: z.string().uuid() };
  const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
  const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) };
  add('session_list', 'Get this target’s interactive sessionId, nextCreateSequence, and owned terminals. This sessionId differs from status. Four retained terminals per target; close to release slots.', {}, READ);
  add('session_create', 'Create persistent Bash in /tmp with session_list sessionId and nextCreateSequence. Latest identical sequence deduplicates; older ones fail. Never retry unknown creation under a new sequence. No command deadline.',
    { sessionId, sequence, cols: dimensions.cols.default(80), rows: dimensions.rows.default(24) }, DESTRUCTIVE);
  add('session_input', 'Send UTF-8 text/control keys using nextInputSequence; newline submits, Ctrl-C is U+0003, EOF U+0004. Latest identical input deduplicates. inputOutcome is delivery, not execution. Never resend uncertain input under a new sequence. data must be at most 16384 UTF-8 bytes; a schema or argument rejection means this request submitted nothing.',
    { ...owned, sequence, data: z.string().min(1).refine(value => Buffer.byteLength(value) <= 16384, 'input must be at most 16384 UTF-8 bytes') }, DESTRUCTIVE);
  add('session_resize', 'Resize an owned terminal; may signal its foreground program. Does not submit input.', { ...owned, ...dimensions }, REVERSIBLE);
  const sessionRead = { ...owned, outputOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    outputLimit: z.number().int().min(1).max(2000).default(2000), waitMs: z.number().int().min(0).max(10000).default(0) };
  add('session_read', 'Read recent 64 KiB with Unicode offsets; follow outputNextOffset. outputGap counts evicted characters; reconnectGapPossible means uncertain continuity. Detached sessions attempt attachment once. waitMs cancellation leaves the shell running.', sessionRead, READ);
  add('session_attach', 'Reattach an owned terminal using its event cursor, then read output with session_read semantics. Never replays input. No adoption or recovery across MCP restart.', sessionRead, READ);
  add('session_close', 'Terminate and verify owned PTY absence; retry uncertain cleanup explicitly. forget=true only releases lost/identity-unknown records, reporting remoteOutcome unknown. Healthy terminals cannot be forgotten. MCP shutdown only detaches.', { ...owned, forget: z.boolean().default(false) }, CANCEL);
  return names;
}
