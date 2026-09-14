import { test, expect } from 'vitest';
import { fitTerminalPage } from '../src/terminal-output.js';
import { ok } from '../src/tools/result.js';
import { PolicySchema } from '../src/config.js';

test('small response budget preserves metadata and contiguous multibyte pages', () => {
  const output = '🌍<<<CURSOR_UNTRUSTED\u001b'.repeat(200);
  const points = [...output]; let offset = 0, raw = '';
  const policy = PolicySchema.parse({ maxResponseBytes: 1024 });
  while (offset < points.length) {
    const page = fitTerminalPage({ status: 'command', outputOffset: offset, outputNextOffset: offset + 2000,
      outputLength: points.length, output: points.slice(offset, offset + 2000).join('') }, 1024);
    expect(page.outputNextOffset).toBeGreaterThan(offset);
    const response = ok({ source: 'test', text: '', structured: page, policy });
    expect(response.content).toHaveLength(1);
    expect(response.structuredContent?.outputNextOffset).toBe(page.outputNextOffset);
    raw += page.output; offset = page.outputNextOffset as number;
  }
  expect(raw).toBe(output);
});
