import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DashData } from '@devhost/contract/lite';
import { allocateAccountRange, allocatePortBase } from '../../cli/src/ports.js';
import { parseConfig } from '../../cli/src/config/load.js';
import { seriesSlot, seriesVar } from '../src/lib/colors';
import { ago, bytes, compact, duration, pct, usd } from '../src/lib/format';
import { predictAccountRange, predictEnvBlock } from '../src/lib/ports';
import { loadPrefs, savePrefs } from '../src/lib/prefs';
import { sortSessions, type Session } from '../src/lib/sessions';
import { monitorGrid, monitorOrder } from '../src/screens/Monitor';
import { trayState } from '../src/lib/tray';
import { qrPath } from '../src/ui/qr';
import { SERIES_HEX, webAppIconSvg } from '../src/lib/webAppIcon';
import { BUCKET_MS, buildBuckets, meterTone } from '../src/lib/usage';
import { deleteAt, fromPointer, readAt, toPointer, writeAt } from '../src/lib/yamlEdit';
import { labelOf, schemaDefault, type JsonSchema } from '../src/ui/schema-form';
import { niceScale } from '../src/ui/chart';
import { schemas } from '@devhost/contract/lite';

const session = (o: Partial<Session> & { id: string }): Session => ({ account: 'a', env: 'e', state: 'idle', startedAt: 1, lastActivityAt: 1, tokensToday: 0, costToday: 0, cpuPercent: null, rssBytes: null, ...o });

const dash = (o: Partial<DashData> = {}): DashData => ({
  generatedAt: 1_000_000,
  range: '1h',
  models: [],
  host: { name: 'm', online: true, uptimeSeconds: 1, cpuPercent: 1, memPercent: 1, memTotalBytes: 1, diskFreePercent: 50, diskFreeBytes: 1, docker: 'up', tailscale: null },
  collector: { lastSampleAt: 1, lastOtelAt: null, lastHookAt: null, dbSizeBytes: 1, schemaVersion: 1 },
  alerts: [],
  accounts: [{ name: 'a', loggedIn: true, lastAuthCheckAt: null, today: { tokens: 0, costUsd: 0 }, week: { tokens: 0, costUsd: 0 }, dailyCostAlertUsd: null }],
  environments: [{ account: 'a', name: 'e', service: { state: 'running', pid: 1 }, cpuPercent: 0, rssBytes: 0, containerCpuPercent: null, containerMemBytes: null, portBase: 3000, diskBytes: null, activeSessions: 0, costToday: 0, costLastHour: 0, costAlert: { dailyUsd: null, hourlyUsd: null } }],
  sessions: [],
  usage: [],
  limits: [],
  ...o,
});

describe('menu bar state', () => {
  it('is red when unreachable, when the collector is silent or when an alert is active', () => {
    expect(trayState(false, null)).toEqual({ status: 'red', waiting: 0 });
    expect(trayState(true, dash({ host: { ...dash().host, online: false } })).status).toBe('red');
    expect(trayState(true, dash({ alerts: [{ id: 'disk', message: 'x', since: 1 }] })).status).toBe('red');
  });
  it('is yellow while loading or when something needs a look', () => {
    expect(trayState(true, null).status).toBe('yellow');
    expect(trayState(true, dash({ host: { ...dash().host, docker: 'down' } })).status).toBe('yellow');
    expect(trayState(true, dash({ accounts: [{ ...dash().accounts[0]!, loggedIn: false }] })).status).toBe('yellow');
    expect(trayState(true, dash({ environments: [{ ...dash().environments[0]!, service: { state: 'stopped', pid: null } }] })).status).toBe('yellow');
  });
  it('is green when healthy, and counts sessions waiting for input', () => {
    expect(trayState(true, dash()).status).toBe('green');
    expect(trayState(true, dash({ sessions: [session({ id: '1', state: 'waiting' }), session({ id: '2', state: 'waiting' }), session({ id: '3', state: 'running' })] })).waiting).toBe(2);
  });
});

describe('account colors', () => {
  const all = ['personal', 'business', 'lab'];
  it('follow the entity, not its rank: a filter never repaints survivors', () => {
    expect(seriesSlot(all, 'business')).toBe(2);
    expect(seriesSlot(all, 'business')).toBe(seriesSlot([...all, 'new'], 'business'));
    expect(seriesVar(2)).toBe('var(--series-2)');
  });
  it('fold into "Other" past eight slots or when unknown', () => {
    const many = Array.from({ length: 10 }, (_, i) => `a${i}`);
    expect(seriesSlot(many, 'a7')).toBe(8);
    expect(seriesSlot(many, 'a8')).toBe(0);
    expect(seriesSlot(many, 'ghost')).toBe(0);
    expect(seriesVar(0)).toBe('var(--series-other)');
  });
});

describe('web app icon', () => {
  const all = ['personal', 'business'];
  it('uses the account color, matching the light palette in styles.css', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const light = css.slice(0, css.indexOf('@media'));
    SERIES_HEX.forEach((hex, slot) => expect(light).toContain(`--series-${slot === 0 ? 'other' : slot}: ${hex};`));
    expect(webAppIconSvg(all, 'business')).toContain(`fill="${SERIES_HEX[2]}"`);
    expect(webAppIconSvg(all, 'ghost')).toContain(`fill="${SERIES_HEX[0]}"`);
  });
  it('writes the account name, shrunk to fit and escaped', () => {
    expect(webAppIconSvg(all, 'business')).toContain('font-size="150"');
    expect(webAppIconSvg(all, 'business')).toMatch(/>business<\/text>/);
    expect(webAppIconSvg(all, 'a'.repeat(32))).toContain('font-size="46"');
    expect(webAppIconSvg(all, '<b>&')).toContain('&#60;b&#62;&#38;');
  });
});

describe('sessions table', () => {
  const list = [
    session({ id: 'a', state: 'idle', account: 'x', env: 'p', tokensToday: 5, cpuPercent: 10, lastActivityAt: 30 }),
    session({ id: 'b', state: 'waiting', account: 'y', env: 'q', tokensToday: 50, cpuPercent: null, lastActivityAt: 10 }),
    session({ id: 'c', state: 'running', account: 'x', env: 'q', tokensToday: 20, cpuPercent: 80, lastActivityAt: 20 }),
  ];
  it('monitor order: waiting, running, idle, latest activity first; ended left out', () => {
    const more = [...list, session({ id: 'd', state: 'ended', lastActivityAt: 99 }), session({ id: 'e', state: 'idle', lastActivityAt: 40 })];
    expect(monitorOrder(more).map((s) => s.id)).toEqual(['b', 'c', 'e', 'a']);
  });
  it('monitor grid: every card fits without scrolling, as large as it can be', () => {
    for (const n of [1, 4, 9, 16, 30]) {
      const { cols, cardPx } = monitorGrid(n, 1600, 900);
      const rows = Math.ceil(n / cols);
      expect(rows * cardPx + (rows - 1) * 8).toBeLessThanOrEqual(900);
      expect(cols * cardPx * 2.6 + (cols - 1) * 8).toBeLessThanOrEqual(1600 + 1);
    }
    expect(monitorGrid(1, 1600, 900).cardPx).toBe(170); // capped
    expect(monitorGrid(3, 1280, 800).cols).toBe(2); // at the cap: two columns, not one of very wide cards
    expect(monitorGrid(4, 500, 900).cols).toBe(1); // narrow window: one column
  });
  it('sorts by any column; empty values sort last in both directions', () => {
    expect(sortSessions(list, 'tokensToday', 'desc').map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(sortSessions(list, 'cpuPercent', 'desc').map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(sortSessions(list, 'cpuPercent', 'asc').map((s) => s.id)).toEqual(['a', 'c', 'b']);
    expect(sortSessions(list, 'state', 'asc').map((s) => s.id)).toEqual(['b', 'c', 'a']); // waiting, running, idle
    expect(sortSessions(list, 'account', 'asc').map((s) => s.account)).toEqual(['x', 'x', 'y']);
  });
});

describe('usage buckets', () => {
  it('are dense over the range, so quiet periods show as gaps', () => {
    const d = dash({ range: '24h', generatedAt: 10 * 3_600_000 + 5, usage: [{ ts: 9 * 3_600_000, account: 'a', input: 1, output: 2, cacheRead: 3, cacheCreation: 4, costUsd: 0.5 }] });
    const b = buildBuckets(d, 'tokens', 'account', ['a']);
    expect(b).toHaveLength(24);
    expect(b.at(-1)!.ts).toBe(10 * 3_600_000);
    expect(b.find((x) => x.ts === 9 * 3_600_000)!.values).toEqual({ a: 10 });
    expect(b.filter((x) => Object.keys(x.values).length > 0)).toHaveLength(1);
    expect(b.every((x, i) => i === 0 || x.ts - b[i - 1]!.ts === BUCKET_MS['24h'])).toBe(true);
  });
  it('stack by token type or by account, tokens or cost', () => {
    const row = { ts: 9 * 3_600_000, account: 'a', input: 1, output: 2, cacheRead: 3, cacheCreation: 4, costUsd: 0.5 };
    const d = dash({ range: '24h', generatedAt: 10 * 3_600_000, usage: [row, { ...row, account: 'b' }] });
    const at = (m: 'tokens' | 'cost', s: 'account' | 'type', accounts: string[]) => buildBuckets(d, m, s, accounts).find((x) => x.ts === row.ts)!.values;
    expect(at('tokens', 'type', ['a', 'b'])).toEqual({ input: 2, output: 4, cacheRead: 6, cacheCreation: 8 });
    expect(at('cost', 'account', ['a', 'b'])).toEqual({ a: 0.5, b: 0.5 });
    expect(at('tokens', 'account', ['a'])).toEqual({ a: 10 }); // a hidden account is not counted
  });
  it('meter tone escalates at 80 % and 100 %', () => {
    expect([meterTone(0.5), meterTone(0.8), meterTone(1.2)]).toEqual(['', 'warn', 'bad']);
  });
  it('axis scale gives clean ticks', () => {
    expect(niceScale(1_340_000)).toEqual({ max: 1_500_000, step: 500_000 });
    expect(niceScale(0).max).toBe(1);
    expect(niceScale(7).max).toBeGreaterThanOrEqual(7);
  });
});

describe('formatting', () => {
  it('formats numbers compactly', () => {
    expect([compact(1284), compact(12_900), compact(4_200_000), compact(999)]).toEqual(['1,284', '12.9K', '4.2M', '999']);
    expect([usd(3.8), usd(188.6)]).toEqual(['$3.80', '$189']);
    expect([pct(null), pct(18.4)]).toEqual(['–', '18%']);
    expect([bytes(null), bytes(2.5 * 1024 ** 3), bytes(300 * 1024 ** 2)]).toEqual(['–', '2.5 GB', '300 MB']);
    expect([duration(9 * 86400 + 4 * 3600), duration(3700), duration(null)]).toEqual(['9d 4h', '1h 1m', '–']);
    expect([ago(null, 10), ago(9_000, 10_000), ago(0, 130_000)]).toEqual(['–', 'now', '2m ago']);
  });
});

describe('port prediction matches the CLI', () => {
  const config = parseConfig(`machine: { hostname: m }\nnotify: { topic: devhost-abcdefgh }\naccounts:\n  - { name: a, default: true, root: /r, portRange: [4000, 4999], git: { name: A, email: a@b.c } }`, '/c');
  it('environment blocks (collector 4318 skipped)', () => {
    const account = config.accounts![0]!;
    for (const taken of [[], [4000], [4000, 4100], [4000, 4100, 4200], [4000, 4100, 4200, 4400]]) {
      const base = taken.map((b, i) => ({ name: `e${i}`, account: 'a', portBase: b }));
      const cfg = { ...config, environments: base };
      expect(predictEnvBlock(account.portRange, taken, 4318)).toBe(allocatePortBase(cfg, account));
    }
    expect(predictEnvBlock(account.portRange, [4000, 4100, 4200], 4318)).toBe(4400); // 4300-4399 holds the collector
    expect(predictEnvBlock([4000, 4099], [4000], 4318)).toBeNull();
  });
  it('account ranges', () => {
    expect(predictAccountRange([])).toEqual([3000, 3999]);
    expect(predictAccountRange([[3000, 3999], [4000, 4999]])).toEqual([5000, 5999]);
    expect(predictAccountRange([[3000, 3999], [4000, 4999]])).toEqual(allocateAccountRange({ ...config, accounts: [{ ...config.accounts![0]!, portRange: [3000, 3999] }, { ...config.accounts![0]!, name: 'b', portRange: [4000, 4999] }] }));
  });
});

describe('YAML editing keeps comments', () => {
  const text = '# top\nmachine:\n  hostname: old # why\n  power: { neverSleep: true }\nlist: [a, b]\n';
  it('reads and writes by pointer', () => {
    expect(readAt(text, ['machine', 'hostname'])).toBe('old');
    expect(readAt(text, ['nope'])).toBeUndefined();
    expect(readAt('{ broken', ['x'])).toBeUndefined();
    const next = writeAt(text, ['machine', 'hostname'], 'new');
    expect(next).toContain('hostname: new # why');
    expect(next).toContain('# top');
    expect(readAt(writeAt(text, ['docker', 'cpu'], 8), ['docker', 'cpu'])).toBe(8);
    expect(readAt(writeAt(text, ['list'], ['x']), ['list'])).toEqual(['x']);
    expect(deleteAt(text, ['machine', 'power'])).not.toContain('neverSleep');
    expect(writeAt('{ broken', ['a'], 1)).toBe('{ broken');
  });
  it('round-trips JSON pointers', () => {
    expect(toPointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
    expect(fromPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(fromPointer('')).toEqual([]);
  });
});

describe('schema form helpers', () => {
  const root = schemas.config as unknown as JsonSchema;
  it('labels are readable, acronyms survive', () => {
    expect([labelOf('memoryGiB'), labelOf('wakeOnLan'), labelOf('hostname'), labelOf('sampleIntervalSeconds')]).toEqual(['Memory GiB', 'Wake on lan', 'Hostname', 'Sample interval seconds']);
  });
  it('defaults come from the schema, including nested ones', () => {
    expect(schemaDefault(root, ['docker', 'runtime'])).toBe('colima');
    expect(schemaDefault(root, ['machine', 'power', 'neverSleep'])).toBe(true);
    expect(schemaDefault(root, ['collector', 'retention', 'rawDays'])).toBe(7);
    expect(schemaDefault(root, ['runtimes'])).toEqual({ node: 'lts', python: '3.12', ruby: '3.3', php: '8.3' });
  });
});

describe('preferences', () => {
  it('store the host name and UI preferences only', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    savePrefs({ host: 'macmini', theme: 'dark', pluginParams: { 'stats.range': '7d' }, qrCodes: true, ...({ password: 'x', ssh_key: 'y' } as object) } as never, storage);
    const raw = JSON.parse([...mem.values()][0]!) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['host', 'pluginParams', 'qrCodes', 'theme']);
    expect(loadPrefs(storage)).toEqual({ host: 'macmini', theme: 'dark', pluginParams: { 'stats.range': '7d' }, qrCodes: true });
    expect(loadPrefs({ getItem: () => '{broken' })).toEqual({ host: '', theme: 'system', pluginParams: {}, qrCodes: false });
    // The dashboard's own time range from before the stats plugin carries over.
    expect(loadPrefs({ getItem: () => '{"host":"m","theme":"dark","range":"30d"}' })).toEqual({ host: 'm', theme: 'dark', pluginParams: { 'stats.range': '30d' }, qrCodes: false });
    expect(loadPrefs({ getItem: () => { throw new Error('blocked'); } })).toMatchObject({ host: '' });
  });
});

import { grouped } from '../src/screens/Agents';

describe('agents grid order', () => {
  it('lists accounts in ABC order, each followed by its environments in ABC order', () => {
    const t = (account: string, env: string | null) => ({ scope: env ? 'environment' : 'account', account, env, dir: '', agents: [] }) as never;
    const out = grouped([t('personal', 'kipipa'), t('stylers-group', null), t('personal', null), t('personal', 'devhost'), t('stylers-group', 'api'), t('Beta', null)]) as { account: string; env: string | null }[];
    expect(out.map((x) => `${x.account}/${x.env ?? ''}`)).toEqual(['Beta/', 'personal/', 'personal/devhost', 'personal/kipipa', 'stylers-group/', 'stylers-group/api']);
  });
});

describe('qrPath', () => {
  it('encodes a link with the three finder patterns, sized by its length', () => {
    const short = qrPath('https://claude.ai/code/session_01Abc');
    const long = qrPath(`https://claude.ai/code?environment=env_${'x'.repeat(120)}`);
    expect(short.size).toBeGreaterThanOrEqual(21);
    expect(long.size).toBeGreaterThan(short.size);
    // The finder patterns' top-left modules (0,0), (size-7,0) and (0,size-7) are dark.
    for (const [c, r] of [[0, 0], [short.size - 7, 0], [0, short.size - 7]]) expect(short.d).toContain(`M${c} ${r}h1`);
    expect(short.d).not.toContain('M7 7h1'); // the separator next to the top-left finder is light
  });
});

describe('host naming', () => {
  it('dev server URLs prefer the Tailscale DNS name, else the ssh host name', async () => {
    const { devServerUrl, sshHostName } = await import('../src/lib/host');
    expect(sshHostName('me@macmini')).toBe('macmini');
    expect(devServerUrl('me@macmini', 'macmini.tail1.ts.net.', 4001)).toBe('http://macmini.tail1.ts.net:4001');
    expect(devServerUrl('me@macmini', null, 4001)).toBe('http://macmini:4001');
  });
});
