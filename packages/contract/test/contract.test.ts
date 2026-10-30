import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, schemas, validate, validateConfig } from '../src/index.js';

const minimal = { machine: { hostname: 'macmini' }, notify: { topic: 'devhost-abcdefgh' } };

describe('config schema', () => {
  it('accepts a minimal config and fills in defaults', () => {
    const r = validateConfig(minimal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.machine.power).toEqual({ neverSleep: true, autoRestartAfterPowerLoss: true, wakeOnLan: true });
    expect(r.value.docker).toEqual({ runtime: 'colima', cpu: 6, memoryGiB: 16, diskGiB: 200, idleSleepMinutes: 60 });
    expect(r.value.collector?.retention).toEqual({ rawDays: 7, rollupDays: 365, logDays: 7 });
    expect(r.value.runtimes).toEqual({ node: 'lts', python: '3.12', ruby: '3.3', php: '8.3' });
    expect(r.value.accounts).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = structuredClone(minimal);
    validateConfig(input);
    expect(input).toEqual(minimal);
  });

  it('accepts the example accounts and environment from the spec', () => {
    const r = validateConfig({
      ...minimal,
      accounts: [
        { name: 'personal', default: true, configDir: null, root: '~/work/personal', portRange: [3000, 3999], git: { name: 'A', email: 'a@example.com' }, alerts: { dailyCostUsd: null } },
        { name: 'business', default: false, configDir: '~/.claude-business', root: '~/work/business', portRange: [4000, 4999], git: { name: 'A', email: 'b@example.com' }, alerts: { dailyCostUsd: 50 } },
      ],
      environments: [{ name: 'acme-api', account: 'business', repo: 'git@github.com:acme/api.git', portBase: 4100 }],
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['unknown top-level key', { ...minimal, bogus: 1 }, '/bogus'],
    ['bad hostname', { ...minimal, machine: { hostname: 'not a host' } }, '/machine/hostname'],
    ['unknown docker runtime', { ...minimal, docker: { runtime: 'podman' } }, '/docker/runtime'],
    ['missing notify', { machine: { hostname: 'x' } }, '/notify'],
    ['shell metacharacters in a brew name', { ...minimal, packages: { brew: ['git"; rm -rf ~'] } }, '/packages/brew/0'],
    ['non-slug account name', { ...minimal, accounts: [{ name: 'My Account', root: '/r', portRange: [3000, 3999], git: { name: 'a', email: 'a@b.c' } }] }, '/accounts/0/name'],
  ])('rejects %s', (_label, input, path) => {
    const r = validateConfig(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain(path);
  });
});

describe('envelope and events', () => {
  it('has contract version 1', () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(validate('envelope', { contractVersion: 1, ok: true, data: {}, errors: [] }).ok).toBe(true);
    expect(validate('envelope', { contractVersion: 2, ok: true, data: {}, errors: [] }).ok).toBe(false);
  });

  it.each([
    { type: 'step', id: 'docker', status: 'start' },
    { type: 'step', id: 'docker', status: 'changed', message: 'x' },
    { type: 'log', level: 'warn', message: 'hi' },
    { type: 'prompt', id: 'auth-code', kind: 'open-url', url: 'https://example.com', message: 'open it' },
    { type: 'result', ok: true, data: { a: 1 } },
  ])('accepts event %j', (event) => {
    expect(validate('events', event).ok).toBe(true);
  });

  it('rejects malformed events', () => {
    expect(validate('events', { type: 'step', id: 'x', status: 'weird' }).ok).toBe(false);
    expect(validate('events', { type: 'nope' }).ok).toBe(false);
  });

  it('validates prompt answers', () => {
    expect(validate('prompt-answer', { id: 'auth-code', value: 'abc' }).ok).toBe(true);
    expect(validate('prompt-answer', { id: 'auth-code' }).ok).toBe(false);
  });

  it('ships every schema with a title', () => {
    for (const [name, schema] of Object.entries(schemas)) expect((schema as { title?: string }).title, name).toBeTruthy();
  });
});
