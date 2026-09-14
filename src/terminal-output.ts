import { sanitize } from './untrusted.js';
import { structuredCost } from './tools/result.js';

/** Fit the raw page and its cursor together, before the shared result envelope. */
export function fitTerminalPage(result: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  if (typeof result.output !== 'string' || typeof result.outputOffset !== 'number') return result;
  const points = [...result.output];
  const page = (count: number) => ({ ...result, outputNextOffset: result.outputOffset as number + count,
    output: points.slice(0, count).join('') });
  const cost = (value: Record<string, unknown>) => structuredCost({ ...value, output: sanitize(value.output as string) });
  if (cost(page(0)) > maxBytes) return { status: 'response_budget_too_small' };
  let low = 0, high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (cost(page(mid)) <= maxBytes) low = mid; else high = mid - 1;
  }
  return page(low);
}
