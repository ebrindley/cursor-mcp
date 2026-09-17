import { test, expect } from 'vitest';
import { fitTerminalPage } from '../src/terminal-output.js';
import { ok, structuredCost } from '../src/tools/result.js';
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

test('a stream-loss hint is charged against the page budget it shares with the output', () => {
  const hint = 'Output stream failed; see reason and cleanup. Do not resubmit uncertain work. For future jobs needing results after MCP restart, use caller-owned detached tmux with output and exit-status files, polled by short commands.';
  const output = 'x'.repeat(2000);
  const policy = PolicySchema.parse({ maxResponseBytes: 1024 });
  const raw = { status: 'command', state: 'finished', commandOutcome: 'unknown', exitCode: null,
    reason: 'stream_ended_without_exit', cleanup: 'process_not_listed', outputReadFailed: true,
    hint, outputOffset: 40, outputLength: 2040, output };
  const page = fitTerminalPage(raw, 1024);
  expect(page.hint).toBe(hint);
  expect(structuredCost(page)).toBeLessThanOrEqual(1024);
  expect(page.output).toBe(output.slice(0, (page.outputNextOffset as number) - 40));
  expect(page.output).not.toBe('');
  // Without the hint the same budget pages more output, so its bytes were charged.
  const bare: Record<string, unknown> = { ...raw }; delete bare.hint;
  expect(fitTerminalPage(bare, 1024).outputNextOffset).toBeGreaterThan(page.outputNextOffset as number);
  const response = ok({ source: 'test', text: '', structured: page, policy });
  expect(response.content).toHaveLength(1);
  expect(response.structuredContent?.hint).toBe(hint);
  expect(response.structuredContent?.output).toBe(page.output);
  expect(response.structuredContent?.outputNextOffset).toBe(page.outputNextOffset);
});
