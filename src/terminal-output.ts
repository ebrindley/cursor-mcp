import { sanitize } from './untrusted.js';
import { structuredCost } from './tools/result.js';

/** Requested Unicode code points; retained output and response budgets stay byte-based. */
export const MAX_OUTPUT_CODE_POINTS = 16384;

/** The same sanitized JSON representation is used for fitting and the text-only client view. */
export function terminalText(result: Record<string, unknown>): string {
  const summary = Object.fromEntries([
    'agentId', 'status', 'sessionId', 'commandId', 'terminalId', 'nextCreateSequence',
    'maxTargets', 'retainedTargets', 'targetOffset', 'targetNextOffset', 'state', 'commandOutcome', 'exitCode', 'signal', 'reason', 'httpStatus', 'failedOperation', 'cleanup', 'outputComplete',
    'outputReadFailed', 'outputTruncated', 'outputOffset', 'outputNextOffset', 'outputLength',
    'outputStartOffset', 'outputEndOffset', 'outputGap', 'reconnectGapPossible', 'inputOutcome', 'nextInputSequence', 'remoteOutcome', 'bytes', 'maxBytes',
    'wakeOutcome', 'readiness', 'failureStage', 'serverElapsedMs', 'machineChanged', 'reattachments', 'continuityUncertain', 'hint', 'output',
  ].filter(key => Object.hasOwn(result, key)).map(key => [key, typeof result[key] === 'string' ? sanitize(result[key] as string) : result[key]]));
  // Sanitize fields before JSON escaping, just as the renderer did before fitting.
  return JSON.stringify(summary);
}

/** Fit the raw page and its cursor together, before the shared result envelope. */
export function fitTerminalPage(result: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (typeof result.output !== 'string' || typeof result.outputOffset !== 'number') return result;
  const points = [...result.output];
  const page = (count: number) => ({ ...result, outputNextOffset: result.outputOffset as number + count,
    output: points.slice(0, count).join('') });
  const cost = (value: Record<string, unknown>) => Math.max(
    structuredCost({ ...value, output: sanitize(value.output as string) }),
    Buffer.byteLength(sanitize(terminalText(value)), 'utf8'),
  );
  if (cost(page(0)) > maxBytes) return { status: 'response_budget_too_small' };
  let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (cost(page(mid)) <= maxBytes) low = mid; else high = mid - 1;
  }
  return page(low);
}
