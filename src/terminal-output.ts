import { sanitizeDeep, structuredCost } from './tools/result.js';

/** Requested Unicode code points; retained output and response budgets stay byte-based. */
export const MAX_OUTPUT_CODE_POINTS = 16384;

/** The same sanitized JSON representation is used for fitting and the text-only client view. */
export function terminalText(result: Record<string, unknown>): string {
  const { hint, output, ...metadata } = result;
  const ordered = { ...metadata, ...(Object.hasOwn(result, 'hint') ? { hint } : {}),
    ...(Object.hasOwn(result, 'output') ? { output } : {}) };
  // Sanitize nested strings before JSON escaping, using the structured renderer's rules.
  return JSON.stringify(sanitizeDeep(ordered, Number.MAX_SAFE_INTEGER).value);
}

/** Both result representations must fit before a page advances its cursor. */
export function terminalCost(result: Record<string, unknown>): number {
  return Math.max(structuredCost(sanitizeDeep(result, Number.MAX_SAFE_INTEGER).value),
    Buffer.byteLength(terminalText(result), 'utf8'));
}

/** Fit the raw page and its cursor together, before the shared result envelope. */
export function fitTerminalPage(result: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (typeof result.output !== 'string' || typeof result.outputOffset !== 'number') return result;
  const points = [...result.output];
  const page = (count: number) => ({ ...result, outputNextOffset: result.outputOffset as number + count,
    output: points.slice(0, count).join('') });
  if (terminalCost(page(0)) > maxBytes) return { status: 'response_budget_too_small' };
  let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (terminalCost(page(mid)) <= maxBytes) low = mid; else high = mid - 1;
  }
  return page(low);
}
