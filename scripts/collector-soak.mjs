#!/usr/bin/env node
// Regression soak for the collector's load (spec A10.9). Runs a second collector (copy of this
// host's config and database in a temporary HOME, its own port, no automatic updates) together with
// `dash --follow` for SOAK_MINUTES (default 10), with an `lsof` shim first on PATH that logs every
// call. Fails on any lsof call, collector CPU averaging 3 % or more, or a child command of the
// collector overlapping itself. Usage: npm run soak [-- <minutes>]
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const minutes = Number(process.argv[2] ?? process.env.SOAK_MINUTES ?? 10);
const cli = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const port = Number(process.env.SOAK_PORT ?? 14318);
const realHome = homedir();
const home = mkdtempSync(join(tmpdir(), 'devhost-soak-'));
const shim = join(home, 'shim');
const lsofLog = join(shim, 'lsof.log');

// The shim: log, then run the real lsof.
mkdirSync(shim, { recursive: true });
writeFileSync(join(shim, 'lsof'), `#!/bin/sh\necho "$PPID $*" >> "${lsofLog}"\nexec /usr/sbin/lsof "$@"\n`);
chmodSync(join(shim, 'lsof'), 0o755);
writeFileSync(lsofLog, '');

// This host's config and data, in the temporary home.
const cfgDir = join(home, '.config', 'devhost');
mkdirSync(cfgDir, { recursive: true });
const cfg = join(cfgDir, 'config.yaml');
copyFileSync(join(realHome, '.config', 'devhost', 'config.yaml'), cfg);
const dataDir = join(home, '.local', 'share', 'devhost');
mkdirSync(dataDir, { recursive: true });
const realDb = join(realHome, '.local', 'share', 'devhost', 'devhost.db');
if (existsSync(realDb)) execFileSync('sqlite3', [realDb, `.backup '${join(dataDir, 'devhost.db')}'`]);

const env = { ...process.env, HOME: home, PATH: `${shim}:${process.env.PATH}` };
const devhost = (args) => execFileSync(process.execPath, [cli, ...args, '--config', cfg], { env, stdio: 'pipe' });
devhost(['config', 'set', '/collector/port', String(port)]);
devhost(['config', 'set', '/claude/update', '"off"']);

const collector = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'collector', 'run', '--config', cfg], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let collectorErr = '';
collector.stderr.on('data', (c) => (collectorErr += c));
const dash = spawn(process.execPath, [cli, 'dash', '--follow', '--json', '--config', cfg], { env, stdio: ['ignore', 'pipe', 'ignore'] });
let snapshots = 0;
dash.stdout.on('data', (c) => (snapshots += String(c).split('\n').filter((l) => l.startsWith('{"type":"snapshot"')).length));

const cpuSeconds = (pid) => {
  const t = execFileSync('ps', ['-o', 'time=', '-p', String(pid)]).toString().trim(); // [[dd-]hh:]mm:ss.cc
  return t.split(/[-:]/).map(Number).reverse().reduce((s, v, i) => s + v * [1, 60, 3600, 86400][i], 0);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const overlaps = [];
let maxChildren = 0;
await sleep(15_000); // warm-up: first samples, the first rollup
const start = { at: Date.now(), cpu: cpuSeconds(collector.pid) };
const end = start.at + minutes * 60_000;
while (Date.now() < end) {
  const procs = execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean);
  const children = procs.filter((m) => Number(m[2]) === collector.pid).map((m) => m[3].split(' ')[0].split('/').pop());
  maxChildren = Math.max(maxChildren, children.length);
  const dup = children.filter((c, i) => children.indexOf(c) !== i);
  if (dup.length) overlaps.push({ at: new Date().toISOString(), commands: dup });
  await sleep(500);
}
const elapsed = (Date.now() - start.at) / 1000;
const cpuPct = ((cpuSeconds(collector.pid) - start.cpu) / elapsed) * 100;
collector.kill('SIGTERM');
dash.kill('SIGTERM');
await sleep(1000);

const lsofCalls = readFileSync(lsofLog, 'utf8').split('\n').filter(Boolean);
const report = { minutes, collectorCpuPercent: Number(cpuPct.toFixed(2)), lsofCalls: lsofCalls.length, overlaps: overlaps.length, maxChildren, snapshots };
console.log(JSON.stringify(report, null, 2));
if (lsofCalls.length) console.log(`lsof calls (ppid args):\n  ${lsofCalls.slice(0, 10).join('\n  ')}`);
if (overlaps.length) console.log(`overlapping children: ${JSON.stringify(overlaps.slice(0, 5))}`);
if (collectorErr.trim()) console.log(`collector stderr: ${collectorErr.trim().split('\n').slice(-5).join(' / ')}`);
rmSync(home, { recursive: true, force: true });
const ok = lsofCalls.length === 0 && cpuPct < 3 && overlaps.length === 0;
console.log(ok ? '✅ soak passed' : '❌ soak failed');
process.exit(ok ? 0 : 1);
