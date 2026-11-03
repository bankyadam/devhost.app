import { describe, expect, it } from 'vitest';
import { DevhostClient } from '../src/client/client';
import { CommandError, IncompatibleError, UnreachableError } from '../src/client/errors';
import type { RunResult, StreamHandle, Transport } from '../src/transport/types';

/** A scripted transport: `run` answers from a function, `stream` plays lines then ends. */
function scripted(over: { run?: (args: string[]) => RunResult; lines?: string[]; exit?: number } = {}) {
  const written: string[] = [];
  const t = {
    host: 'macmini',
    run: async (args: string[]) => (over.run ?? (() => ({ code: 0, stdout: '', stderr: '' })))(args),
    stream(args: string[], onLine: (l: string) => void): StreamHandle {
      let resolve!: (c: number) => void;
      const done = new Promise<number>((r) => (resolve = r));
      queueMicrotask(async () => {
        for (const l of over.lines ?? []) {
          onLine(l);
          await new Promise((r) => setTimeout(r, 1));
        }
        resolve(over.exit ?? 0);
      });
      return { write: (l) => void written.push(l), cancel: () => resolve(130), done };
    },
  } as unknown as Transport;
  return { t, written };
}

const env = (data: unknown, ok = true, errors: unknown[] = []) => JSON.stringify({ contractVersion: 1, ok, data, errors });

describe('short commands', () => {
  it('append --json and return the envelope data', async () => {
    let seen: string[] = [];
    const { t } = scripted({ run: (a) => ((seen = a), { code: 0, stdout: `${env({ cliVersion: '1', contractVersion: 1 })}\n`, stderr: '' }) });
    await expect(new DevhostClient(t).version()).resolves.toMatchObject({ cliVersion: '1' });
    expect(seen).toEqual(['version', '--json']);
  });

  it('ignore banners before the JSON (a login shell may print one)', async () => {
    const { t } = scripted({ run: () => ({ code: 0, stdout: `Last login: Mon\n${env({ environments: [] })}\n`, stderr: '' }) });
    await expect(new DevhostClient(t).envs()).resolves.toEqual({ environments: [] });
  });

  it('turn ssh failure, timeout and a missing devhost into "unreachable"', async () => {
    for (const code of [255, 124]) {
      const { t } = scripted({ run: () => ({ code, stdout: '', stderr: 'ssh: timed out' }) });
      await expect(new DevhostClient(t).envs()).rejects.toBeInstanceOf(UnreachableError);
    }
    const { t } = scripted({ run: () => ({ code: 127, stdout: '', stderr: 'devhost: command not found' }) });
    await expect(new DevhostClient(t).envs()).rejects.toBeInstanceOf(UnreachableError);
  });

  it('report a failed command with its code, message, hint and exit code', async () => {
    const { t } = scripted({ run: () => ({ code: 2, stdout: env(null, false, [{ code: 'config-invalid', message: '/machine/hostname: bad', hint: 'fix it' }]), stderr: '' }) });
    const err = await new DevhostClient(t).envs().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ code: 'config-invalid', exit: 2, hint: 'fix it', message: '/machine/hostname: bad' });
    expect((err as CommandError).needsHuman).toBe(false);
  });

  it('refuse a different contract major', async () => {
    const { t } = scripted({ run: () => ({ code: 0, stdout: env({ cliVersion: '9.0.0', contractVersion: 2 }), stderr: '' }) });
    const err = await new DevhostClient(t).version().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompatibleError);
    expect((err as Error).message).toContain('Update devhost Desktop');
  });

  it('doctor with failures still returns its report', async () => {
    const data = { ok: false, summary: { ok: 0, warn: 0, fail: 1 }, checks: [{ id: 'x', status: 'fail', message: 'm' }] };
    const { t } = scripted({ run: () => ({ code: 1, stdout: env(data, false), stderr: '' }) });
    await expect(new DevhostClient(t).doctor()).resolves.toEqual(data);
  });

  it('validate returns the problems instead of throwing', async () => {
    const { t } = scripted({ run: () => ({ code: 2, stdout: env(null, false, [{ code: 'config-invalid', message: '/a: b', path: '/a' }]), stderr: '' }) });
    await expect(new DevhostClient(t).validateConfig('x')).resolves.toMatchObject({ valid: false, issues: [{ path: '/a' }] });
  });
});

describe('long commands', () => {
  it('stream events, answer prompts on stdin and return the result', async () => {
    const lines = [
      JSON.stringify({ type: 'step', id: 'a', status: 'start' }),
      'some banner that is not JSON',
      JSON.stringify({ type: 'prompt', id: 'q1', kind: 'confirm', message: 'ok?' }),
      JSON.stringify({ type: 'result', ok: true, data: { name: 'x' } }),
    ];
    const { t, written } = scripted({ lines });
    const events: string[] = [];
    const run = new DevhostClient(t).run(['env', 'create'], { onEvent: (e) => events.push(e.type), onPrompt: async () => true });
    const r = await run.promise;
    expect(r).toEqual({ ok: true, exit: 0, data: { name: 'x' }, errors: [] });
    expect(events).toEqual(['step', 'prompt']);
    expect(written).toEqual([JSON.stringify({ id: 'q1', value: true })]);
  });

  it('a prompt left unanswered when the command ends is abandoned (the signal aborts) and does not block the result', async () => {
    const lines = [JSON.stringify({ type: 'prompt', id: 'q1', kind: 'confirm', message: 'ok?' })];
    const { t, written } = scripted({ lines, exit: 255 });
    let aborted = false;
    const run = new DevhostClient(t).run(['env', 'create'], { onPrompt: (_p, signal) => new Promise(() => signal.addEventListener('abort', () => (aborted = true))) });
    await expect(run.promise).rejects.toBeInstanceOf(UnreachableError);
    expect(aborted).toBe(true);
    expect(written).toEqual([]);
  });

  it('report exit code 3 as a human-action result', async () => {
    const lines = [JSON.stringify({ type: 'result', ok: false, data: null, errors: [{ code: 'human-action-required', message: 'sudo needs a password' }] })];
    const { t } = scripted({ lines, exit: 3 });
    const r = await new DevhostClient(t).run(['apply']).promise;
    expect(r).toMatchObject({ ok: false, exit: 3, errors: [{ code: 'human-action-required' }] });
  });

  it('a lost connection without a result is "unreachable"; cancelling is a clean result', async () => {
    await expect(new DevhostClient(scripted({ exit: 255 }).t).run(['apply']).promise).rejects.toBeInstanceOf(UnreachableError);
    const { t } = scripted({ lines: [JSON.stringify({ type: 'step', id: 'a', status: 'start' })], exit: 1 });
    const run = new DevhostClient(t).run(['apply']);
    const r = await run.promise;
    expect(r).toMatchObject({ ok: false, errors: [{ code: 'no-result' }] });
  });

  it('builds the CLI commands the wizards stand for', async () => {
    const calls: string[][] = [];
    const t = { host: 'h', stream: (args: string[]) => (calls.push(args), { write() {}, cancel() {}, done: Promise.resolve(0) }) } as unknown as Transport;
    const c = new DevhostClient(t);
    c.accountAdd({ name: 'biz', gitEmail: 'a@b.c', gitName: 'A', isDefault: false, dailyCostAlert: 50 });
    c.envCreate({ account: 'biz', name: 'api', repo: 'git@x:y.git', remoteControl: false, compose: 'off' });
    c.envDelete('api', true);
    c.accountRemove('biz', true);
    c.follow('7d', { account: 'biz' }, () => undefined);
    expect(calls).toEqual([
      ['account', 'add', '--name', 'biz', '--git-email', 'a@b.c', '--git-name', 'A', '--daily-cost-alert', '50', '--json'],
      ['env', 'create', '--account', 'biz', '--name', 'api', '--repo', 'git@x:y.git', '--no-rc', '--compose', 'off', '--json'],
      ['env', 'delete', 'api', '--delete-files', '--json'],
      ['account', 'remove', 'biz', '--yes', '--logout', '--json'],
      ['dash', '--follow', '--range', '7d', '--account', 'biz', '--json'],
    ]);
  });
});

describe('cancel and diagnostics', () => {
  it('a cancelled stream is a clean "cancelled" result, not a lost connection', async () => {
    const { t } = scripted({ lines: [JSON.stringify({ type: 'step', id: 'a', status: 'start' })], exit: 255 });
    const slow = { ...t, stream: (_a: string[], on: (l: string) => void) => { let r!: (c: number) => void; const done = new Promise<number>((x) => (r = x)); on(JSON.stringify({ type: 'step', id: 'a', status: 'start' })); return { write() {}, cancel: () => r(255), done }; } } as unknown as Transport;
    const run = new DevhostClient(slow).run(['apply']);
    run.cancel();
    await expect(run.promise).resolves.toMatchObject({ ok: false, exit: 130, errors: [{ code: 'cancelled' }] });
  });

  it('the unreachable message carries ssh\'s first line (key problems are visible)', async () => {
    const { t } = scripted({ run: () => ({ code: 255, stdout: '', stderr: 'macmini: Permission denied (publickey).\nmore' }) });
    const err = await new DevhostClient(t).envs().catch((e: unknown) => e);
    expect((err as Error).message).toBe('Could not reach macmini: macmini: Permission denied (publickey).');
  });
});
