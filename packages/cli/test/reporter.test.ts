import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanReporter } from '../src/reporter.js';

const sink = () => {
  const lines: string[] = [];
  return { lines, write: (s: string) => void lines.push(s) };
};

describe('HumanReporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says which step is still running when it takes a while', () => {
    const out = sink();
    const r = new HumanReporter(out, sink(), false, 3000);
    r.step('system.ssh', 'start', 'Remote Login');
    r.step('system.ssh', 'ok');
    r.step('packages', 'start', 'Render the Brewfile and run brew bundle');
    vi.advanceTimersByTime(2999);
    expect(out.lines).toEqual(['✅ system.ssh\n']);
    vi.advanceTimersByTime(1);
    r.step('packages', 'changed', 'some Brewfile entries are not installed');
    vi.advanceTimersByTime(10_000);
    expect(out.lines).toEqual(['✅ system.ssh\n', '… packages — Render the Brewfile and run brew bundle\n', '🔧 packages — some Brewfile entries are not installed\n']);
  });

  it('verbose prints the start line right away', () => {
    const out = sink();
    new HumanReporter(out, sink(), true).step('packages', 'start', 'brew bundle');
    expect(out.lines).toEqual(['… packages — brew bundle\n']);
  });
});
