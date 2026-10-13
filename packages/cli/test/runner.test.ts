import { describe, expect, it } from 'vitest';
import { RealRunner } from '../src/runner/real.js';

/** Stands in for process.stdin: records pause/resume and whether the child ran while paused. */
function fakeStdin(flowing: boolean | null) {
  const calls: string[] = [];
  const stdin = {
    readableFlowing: flowing,
    pause() {
      calls.push('pause');
      this.readableFlowing = false;
      return this;
    },
    resume() {
      calls.push('resume');
      this.readableFlowing = true;
      return this;
    },
  };
  return { calls, stdin };
}

describe('RealRunner', () => {
  it('stops reading its own stdin while an interactive child (sudo) owns the terminal', async () => {
    const { calls, stdin } = fakeStdin(true);
    const runner = new RealRunner(process.env, stdin as unknown as NodeJS.ReadStream);
    const r = await runner.run('sh', ['-c', 'exit 3'], { interactive: true });
    expect(r.code).toBe(3);
    expect(calls).toEqual(['pause', 'resume']);
    expect(stdin.readableFlowing).toBe(true);
  });

  it('leaves a stdin nobody reads alone (resuming it would drop input), and non-interactive runs too', async () => {
    const idle = fakeStdin(null);
    await new RealRunner(process.env, idle.stdin as unknown as NodeJS.ReadStream).run('true', [], { interactive: true });
    expect(idle.calls).toEqual([]);
    const reading = fakeStdin(true);
    await new RealRunner(process.env, reading.stdin as unknown as NodeJS.ReadStream).run('true', []);
    expect(reading.calls).toEqual([]);
  });
});
