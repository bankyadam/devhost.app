import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DevhostConfig } from '@devhost/contract';
import { MIN_REMOTE_CONTROL_VERSION, parseVersion, versionAtLeast } from '../claude-version.js';
import { Db, dbPath } from '../collector/db.js';
import { managedSettings, parseSettings } from '../claude-settings.js';
import { accountEnv, accountRoot, accountsOf, composeProject, effectiveClaudeDir, envDir, environmentsOf, rcLabel, rcLogPath, type Account, type Environment } from '../config/accounts.js';
import type { Deps } from '../deps.js';
import { daemonState, plistPath } from '../launchd.js';
import { authStatus, claudeBinary, claudeRunOptions } from '../login.js';
import type { Executor } from '../runner/executor.js';
import { miseBinary } from '../mise.js';
import { brewfilePath, renderBrewfile, BUNDLE_CHECK_ENV, bundleCheckArgs } from '../steps/packages.js';
import { COMPOSE_FILES, envrcFor, workspaceTrusted } from '../steps/env.js';
import { COLIMA_LABEL } from '../steps/docker.js';
import { COLLECTOR_LABEL } from '../steps/collector.js';
import { parseTailscale } from '../steps/tailscale.js';
import { powerState, unsupportedPowerNote } from '../steps/system.js';
import { parsePs, subtree } from '../collector/samplers.js';
import type { DevhostPlugin, PluginContext } from '../plugins/api.js';
import { pluginContext } from '../plugins/context.js';
import { loadPlugins } from '../plugins/loader.js';
import { NoPrompter } from '../prompter.js';
import type { Reporter } from '../reporter.js';
import type { StepContext } from '../steps/types.js';

export type Status = 'ok' | 'warn' | 'fail';
export interface Check {
  id: string;
  status: Status;
  message: string;
  fix?: string;
  /** Plugins' notes on this check. */
  advice?: CheckAdvice[];
}

export interface CheckAdvice {
  plugin: string;
  message: string;
  fix?: string;
  action?: string;
}

export interface DoctorContext {
  deps: Deps;
  config: DevhostConfig;
  configPath: string;
  exec: Executor;
  now: number;
}

const ok = (id: string, message: string): Check => ({ id, status: 'ok', message });
const warn = (id: string, message: string, fix?: string): Check => ({ id, status: 'warn', message, ...(fix ? { fix } : {}) });
const fail = (id: string, message: string, fix?: string): Check => ({ id, status: 'fail', message, ...(fix ? { fix } : {}) });

const stepCtx = (c: DoctorContext): StepContext => ({ config: c.config, home: c.deps.home, user: c.deps.user, brewPrefix: c.deps.brewPrefix, nodePath: c.deps.nodePath, exec: c.exec, configPath: c.configPath });

/** Run a group of checks; a throwing check becomes a failed check instead of aborting the report. */
async function guarded(id: string, fn: () => Promise<Check[]>): Promise<Check[]> {
  try {
    return await fn();
  } catch (err) {
    return [fail(id, `check crashed: ${(err as Error).message}`)];
  }
}

const major = (v: string): number => Number(v.split('.')[0]);

async function systemChecks(c: DoctorContext): Promise<Check[]> {
  const { exec, config } = c;
  const out: Check[] = [];

  const sw = await exec.query('sw_vers', ['-productVersion']);
  const ver = sw.stdout.trim();
  out.push(
    sw.code !== 0 ? warn('system.macos', 'could not read the macOS version')
    : major(ver) >= 13 ? ok('system.macos', `macOS ${ver}`)
    : fail('system.macos', `macOS ${ver} is too old for Claude Code (13+)`, 'Update macOS in System Settings → General → Software Update.'),
  );

  const arch = (await exec.query('uname', ['-m'])).stdout.trim();
  // Under Rosetta uname reports x86_64 on Apple Silicon, and the Intel Homebrew prefix would be used.
  const translated = (await exec.query('sysctl', ['-n', 'sysctl.proc_translated'])).stdout.trim() === '1';
  out.push(
    translated ? fail('system.arch', 'devhost runs under Rosetta (x86_64 Node on Apple Silicon)', 'Install the arm64 Node: run ./bootstrap.sh from a native (non-Rosetta) terminal.')
    : arch === 'arm64' ? ok('system.arch', `Apple Silicon (Homebrew in ${c.deps.brewPrefix})`)
    : arch === 'x86_64' ? ok('system.arch', `Intel (Homebrew in ${c.deps.brewPrefix})`)
    : fail('system.arch', `architecture is ${arch || 'unknown'}; devhost supports Apple Silicon and Intel Macs`),
  );

  const fv = await exec.query('fdesetup', ['status']);
  out.push(
    /FileVault is On/i.test(fv.stdout)
      ? ok('system.filevault', 'FileVault is on: after a reboot the disk must be unlocked (at the keyboard or with an authenticated restart) before anything starts')
      : /FileVault is Off/i.test(fv.stdout)
        ? warn('system.filevault', 'FileVault is off: the disk is not encrypted (devhost never changes this)', 'System Settings → Privacy & Security → FileVault')
        : warn('system.filevault', 'could not read the FileVault status'),
  );

  const want = config.machine.hostname;
  const names: string[] = [];
  for (const key of ['ComputerName', 'HostName', 'LocalHostName']) {
    const r = await exec.query('scutil', ['--get', key]);
    if (r.code !== 0 || r.stdout.trim() !== want) names.push(key);
  }
  out.push(names.length === 0 ? ok('system.hostname', `hostname is ${want}`) : fail('system.hostname', `${names.join(', ')} differ from "${want}"`, 'devhost apply --only system.hostname'));

  const power = await powerState(config, exec);
  if (power.want.length > 0 || power.unsupported.length > 0) {
    const wrong = power.wrong ?? ['could not read power settings'];
    const done = power.want.map(([k, v]) => `${k} ${v}`).join(', ');
    out.push(
      wrong.length > 0 ? fail('system.power', wrong.join(', '), 'devhost apply --only system.power')
      : power.unsupported.length > 0 ? warn('system.power', `${done ? `${done}; ` : ''}${unsupportedPowerNote(power.unsupported)}`, 'Turn that option off under machine.power in the config to silence this.')
      : ok('system.power', 'never sleeps, restarts after power loss, wake on LAN'),
    );
  }

  if (config.network?.ssh) {
    out.push((await exec.query('nc', ['-z', '-w', '2', '127.0.0.1', '22'])).code === 0 ? ok('system.ssh', 'Remote Login (SSH) is on') : fail('system.ssh', 'nothing listens on port 22', 'devhost apply --only system.ssh'));
  }

  const df = await exec.query('df', ['-k', '/']);
  const line = df.stdout.trim().split('\n')[1]?.trim().split(/\s+/);
  const total = Number(line?.[1]);
  const avail = Number(line?.[3]);
  const limit = config.collector?.alerts?.diskFreePercent ?? 15;
  if (df.code === 0 && total > 0) {
    const freePct = (avail / total) * 100;
    out.push(freePct >= limit ? ok('system.disk', `${freePct.toFixed(0)}% of the disk is free`) : fail('system.disk', `only ${freePct.toFixed(0)}% of the disk is free (alert limit ${limit}%)`, 'Free space: docker system prune, remove old worktrees and node_modules.'));
  } else {
    out.push(warn('system.disk', 'could not read free disk space'));
  }
  return out;
}

async function toolChecks(c: DoctorContext): Promise<Check[]> {
  const { exec, config, deps } = c;
  const out: Check[] = [];

  const brew = await exec.query('brew', ['--version']);
  if (brew.code !== 0) {
    out.push(fail('tools.homebrew', 'Homebrew is not installed', 'Run bootstrap.sh'));
  } else {
    out.push(ok('tools.homebrew', brew.stdout.split('\n')[0] ?? 'Homebrew'));
    const file = brewfilePath(deps.home);
    if ((await exec.readText(file)) !== (await renderBrewfile(config))) {
      out.push(fail('tools.packages', 'the Brewfile is out of date', 'devhost apply --only packages'));
    } else {
      const bundle = await exec.query('brew', bundleCheckArgs(file), { env: BUNDLE_CHECK_ENV });
      out.push(bundle.code === 0 ? ok('tools.packages', 'all Brewfile packages are installed') : fail('tools.packages', 'some Brewfile packages are missing', 'devhost apply --only packages'));
    }
  }

  const wantedRuntimes = Object.entries(config.runtimes ?? {});
  if (wantedRuntimes.length > 0) {
    const bin = await miseBinary(exec, deps.home);
    const mise = bin ? await exec.query(bin, ['ls', '--global', '--json']) : { code: 127, stdout: '', stderr: '' };
    let have: Record<string, { requested_version?: string; installed?: boolean }[]> = {};
    try {
      have = JSON.parse(mise.stdout) as typeof have;
    } catch {
      /* treated as missing */
    }
    const missing = wantedRuntimes.filter(([t, v]) => !(have[t] ?? []).some((e) => e.installed && e.requested_version === v)).map(([t, v]) => `${t}@${v}`);
    out.push(missing.length === 0 ? ok('tools.runtimes', wantedRuntimes.map(([t, v]) => `${t}@${v}`).join(', ')) : fail('tools.runtimes', `missing: ${missing.join(', ')}`, 'devhost apply --only runtimes'));
  }

  const runtime = config.docker?.runtime ?? 'none';
  if (runtime !== 'none') {
    const info = await exec.query('docker', ['info', '--format', '{{.ServerVersion}}']);
    out.push(info.code === 0 ? ok('tools.docker', `Docker ${info.stdout.trim()} (${runtime}) is running`) : fail('tools.docker', `Docker (${runtime}) is not running`, runtime === 'colima' ? 'devhost apply --only docker' : 'Open OrbStack on the Mac mini'));
    if (runtime === 'orbstack') out.push(warn('tools.docker-boot', 'OrbStack needs a GUI login after every reboot', 'Use docker.runtime: colima for a headless server'));
    if (runtime === 'colima') {
      const d = await daemonState(exec, COLIMA_LABEL);
      out.push(d.running ? ok('tools.colima-service', 'Colima starts at boot (LaunchDaemon)') : fail('tools.colima-service', 'the Colima boot service is not running', 'devhost apply --only docker.runtime'));
    }
  }

  if (config.network?.tailscale) {
    const r = await exec.query('tailscale', ['status', '--json']);
    const st = r.code === 0 ? parseTailscale(r.stdout) : null;
    if (!st?.BackendState) out.push(fail('tools.tailscale', 'the Tailscale daemon is not running', 'devhost apply --only tailscale'));
    else if (st.BackendState !== 'Running') out.push(warn('tools.tailscale', `Tailscale is ${st.BackendState}: not logged in`, 'sudo tailscale up'));
    else out.push(ok('tools.tailscale', `Tailscale is running as ${st.Self?.DNSName?.replace(/\.$/, '') ?? 'this machine'} (${(st.Self?.TailscaleIPs ?? []).join(', ') || 'no IP yet'})`));
  }

  const claude = await exec.query(await claudeBinary({ exec, deps }), ['--version']);
  const version = claude.code === 0 ? parseVersion(claude.stdout) : null;
  out.push(
    claude.code !== 0 ? fail('tools.claude', 'Claude Code is not installed', 'devhost apply --only packages claude')
    : version && !versionAtLeast(version, MIN_REMOTE_CONTROL_VERSION) ? fail('tools.claude', `Claude Code ${version.join('.')} is too old for Remote Control (${MIN_REMOTE_CONTROL_VERSION} or newer)`, 'devhost apply --only claude.binary')
    : ok('tools.claude', `Claude Code ${claude.stdout.trim()}`),
  );
  return out;
}

async function accountChecks(c: DoctorContext): Promise<Check[]> {
  const { config } = c;
  const accounts = accountsOf(config);
  if (accounts.length === 0) return [warn('accounts', 'no accounts exist', 'devhost account add --name <name> --git-email <email>')];

  const out: Check[] = [];
  for (const a of accounts) {
    out.push(...(await guarded(`account.${a.name}`, () => oneAccount(c, a))));
  }
  return out;
}

async function oneAccount(c: DoctorContext, a: Account): Promise<Check[]> {
  const { exec, config, deps } = c;
  const id = `account.${a.name}`;
  const out: Check[] = [];
  const dir = effectiveClaudeDir(a, deps.home);

  if ((await exec.query('test', ['-d', dir])).code !== 0) {
    return [fail(`${id}.config-dir`, `${dir} does not exist`, `devhost apply --only accounts`)];
  }
  out.push(ok(`${id}.config-dir`, dir));

  const settingsFile = join(dir, 'settings.json');
  try {
    const have = parseSettings(await exec.readText(settingsFile), settingsFile);
    const managed = managedSettings(config, a) as { env: Record<string, string>; hooks: Record<string, unknown> };
    const env = (have['env'] ?? {}) as Record<string, string>;
    const missing = [
      ...Object.keys(managed.env).filter((k) => env[k] !== managed.env[k]),
      ...(have['remoteControlAtStartup'] === true ? [] : ['remoteControlAtStartup']),
      ...Object.keys(managed.hooks).filter((e) => !JSON.stringify((have['hooks'] as Record<string, unknown> | undefined)?.[e] ?? '').includes('/hooks?account=')),
    ];
    out.push(missing.length === 0 ? ok(`${id}.settings`, 'required settings keys, telemetry and hooks are in place') : fail(`${id}.settings`, `settings.json lacks: ${missing.join(', ')}`, 'devhost apply --only accounts.claude'));
  } catch (err) {
    out.push(fail(`${id}.settings`, (err as Error).message));
  }

  const st = await authStatus({ exec, deps }, a);
  out.push(
    st.loggedIn === true ? ok(`${id}.login`, 'logged in')
    : st.loggedIn === false ? fail(`${id}.login`, 'not logged in', `devhost login ${a.name}`)
    : warn(`${id}.login`, 'could not run `claude auth status`'),
  );
  if (st.loggedIn === true) {
    const file = (await exec.readText(join(dir, '.credentials.json'))) !== null;
    out.push(file ? warn(`${id}.credentials`, `credentials are stored in ${join(dir, '.credentials.json')} (the Keychain was not writable, e.g. locked over SSH)`, `devhost login ${a.name}  # from a session where the Keychain is unlocked`) : ok(`${id}.credentials`, 'credentials are in the macOS Keychain'));
    const doctor = await exec.query(await claudeBinary({ exec, deps }), ['doctor'], { ...claudeRunOptions(a, deps.home), timeoutMs: 30_000 });
    const remote = doctor.stdout.split('\n').find((l) => /remote control/i.test(l));
    out.push(
      doctor.code !== 0 ? warn(`${id}.remote-control`, 'claude doctor reported problems', `claude doctor  # run it as ${a.name}`)
      : /not (available|eligible|enabled)|disabled/i.test(remote ?? '') ? fail(`${id}.remote-control`, remote!.trim(), 'See https://code.claude.com/docs/en/remote-control#troubleshooting')
      : ok(`${id}.remote-control`, remote ? remote.trim() : 'claude doctor found no problems'),
    );
  }

  // direnv: CLAUDE_CONFIG_DIR must resolve to the account's dir inside its root.
  const root = accountRoot(a, deps.home);
  if ((await exec.query('test', ['-d', root])).code === 0) {
    const resolved = await exec.query('direnv', ['exec', root, 'sh', '-c', 'printenv CLAUDE_CONFIG_DIR'], { unsetEnv: ['CLAUDE_CONFIG_DIR'] });
    const want = accountEnv(a, deps.home)['CLAUDE_CONFIG_DIR'] ?? '';
    const got = resolved.stdout.trim();
    out.push(got === want ? ok(`${id}.direnv`, want ? `CLAUDE_CONFIG_DIR resolves to ${want} under ${root}` : `CLAUDE_CONFIG_DIR stays unset under ${root}`) : fail(`${id}.direnv`, `CLAUDE_CONFIG_DIR is "${got}" under ${root}, expected "${want}"`, 'devhost apply --only accounts.routing'));
  } else {
    out.push(fail(`${id}.direnv`, `${root} does not exist`, 'devhost apply --only accounts.routing'));
  }
  return out;
}

async function envChecks(c: DoctorContext): Promise<Check[]> {
  const out: Check[] = [];
  for (const e of environmentsOf(c.config)) {
    const a = accountsOf(c.config).find((x) => x.name === e.account);
    if (a) out.push(...(await guarded(`env.${e.name}`, () => oneEnv(c, a, e))));
  }
  return out;
}

async function oneEnv(c: DoctorContext, a: Account, e: Environment): Promise<Check[]> {
  const { exec, config, deps } = c;
  const id = `env.${e.name}`;
  const dir = envDir(a, e, deps.home);
  const out: Check[] = [];

  if ((await exec.query('git', ['-C', dir, 'rev-parse', '--git-dir'])).code !== 0) {
    return [fail(`${id}.repo`, `${dir} is not a git repository`, `devhost apply --only ${id}`)];
  }
  out.push(ok(`${id}.repo`, dir));

  const rcOn = e.remoteControl?.enabled !== false;
  if (rcOn) {
    out.push((await workspaceTrusted(stepCtx(c), a, dir)) ? ok(`${id}.trust`, 'workspace trust is recorded') : warn(`${id}.trust`, 'workspace trust is not recorded; the service exits with "Workspace not trusted"', `devhost login ${a.name}`));

    const state = await daemonState(exec, rcLabel(a.name, e.name));
    out.push(state.running ? ok(`${id}.service`, `Remote Control service running (pid ${state.pid ?? '?'})`) : fail(`${id}.service`, 'the Remote Control service is not running', (await exec.readText(plistPath(rcLabel(a.name, e.name)))) === null ? `devhost apply --only ${id}` : `devhost env start ${e.name}`));

    const log = await exec.readText(rcLogPath(deps.home, a.name, e.name));
    const bad = (log ?? '').split('\n').slice(-40).filter((l) => /error|not trusted|exited|failed/i.test(l));
    out.push(bad.length === 0 ? ok(`${id}.log`, log === null ? 'no log yet' : 'recent log has no errors') : warn(`${id}.log`, `recent log: ${bad.at(-1)!.trim().slice(0, 160)}`, `devhost env logs ${e.name}`));
  }

  // Ports: the block must not contain the collector port, and listeners from outside this environment are suspicious.
  const base = e.portBase ?? 0;
  const collectorPort = config.collector?.port ?? 4318;
  if (base > 0 && collectorPort >= base && collectorPort < base + 100) {
    out.push(fail(`${id}.ports`, `the port block ${base}-${base + 99} contains the collector port ${collectorPort}`, `devhost config set /environments/<index>/portBase <free base>`));
  } else if (base > 0) {
    out.push(...(await portConflicts(c, e, id, base)));
  }

  if (e.compose !== 'off') {
    let file: string | null = null;
    for (const f of COMPOSE_FILES) if ((await exec.readText(join(dir, f))) !== null) file = f;
    if (file) {
      const running = await exec.query('docker', ['compose', '-p', composeProject(e.name), 'ps', '-q', '--status', 'running'], { cwd: dir });
      const all = await exec.query('docker', ['compose', '-p', composeProject(e.name), 'ps', '-q', '-a'], { cwd: dir });
      const n = (s: string): number => s.split('\n').filter(Boolean).length;
      out.push(running.code === 0 && n(running.stdout) > 0 && n(running.stdout) === n(all.stdout) ? ok(`${id}.compose`, `${n(running.stdout)} compose service(s) up`) : fail(`${id}.compose`, 'compose services are not all up', `devhost apply --only ${id}`));
    }
  }

  const envrc = await exec.readText(join(dir, '.envrc'));
  out.push(envrc === envrcFor(a.name, e.name, base) ? ok(`${id}.envrc`, '.envrc is as generated') : fail(`${id}.envrc`, '.envrc is missing or edited', `devhost apply --only ${id}`));

  const email = await exec.query('git', ['-C', dir, 'config', '--get', 'user.email']);
  out.push(email.stdout.trim() === a.git.email ? ok(`${id}.git-identity`, `git user.email is ${a.git.email}`) : fail(`${id}.git-identity`, `git user.email is "${email.stdout.trim()}", expected ${a.git.email}`, 'devhost apply --only accounts.git'));
  return out;
}

async function portConflicts(c: DoctorContext, e: Environment, id: string, base: number): Promise<Check[]> {
  const { exec } = c;
  const lsof = await exec.query('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  if (lsof.code !== 0 && lsof.stdout === '') return [ok(`${id}.ports`, `block ${base}-${base + 99} (listeners could not be inspected)`)];
  const ps = parsePs((await exec.query('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,command='])).stdout);
  const svc = await daemonState(exec, rcLabel(e.account, e.name));
  const mine = new Set(svc.pid ? subtree(ps, svc.pid).map((p) => p.pid) : []);
  const conflicts: string[] = [];
  let pid = 0;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (port >= base && port < base + 100 && !mine.has(pid)) {
        const cmd = ps.find((p) => p.pid === pid)?.command ?? '';
        if (!/colima|lima|docker|vz|com\.apple/i.test(cmd)) conflicts.push(`${port} (${cmd.split(' ')[0]?.split('/').pop() || `pid ${pid}`})`);
      }
    }
  }
  return conflicts.length === 0 ? [ok(`${id}.ports`, `block ${base}-${base + 99} is free of conflicts`)] : [warn(`${id}.ports`, `ports in ${base}-${base + 99} are used by other processes: ${conflicts.join(', ')}`, 'Stop them or move this environment to another block')];
}

async function collectorChecks(c: DoctorContext): Promise<Check[]> {
  const { exec, deps, config } = c;
  const out: Check[] = [];
  const d = await daemonState(exec, COLLECTOR_LABEL);
  out.push(d.running ? ok('collector.service', `running (pid ${d.pid ?? '?'})`) : fail('collector.service', 'the collector is not running', 'devhost apply --only collector'));

  const port = config.collector?.port ?? 4318;
  const health = await exec.query('curl', ['-s', '-m', '2', `http://127.0.0.1:${port}/health`]);
  out.push(health.code === 0 && health.stdout.includes('"ok"') ? ok('collector.http', `answers on 127.0.0.1:${port}`) : fail('collector.http', `nothing answers on 127.0.0.1:${port}`, 'devhost apply --only collector'));

  const path = dbPath(deps.home);
  if (!existsSync(path)) {
    out.push(warn('collector.db', 'no database yet', 'The collector creates it on first start.'));
    return out;
  }
  const db = new Db(path, { readonly: true });
  try {
    const size = (await exec.query('du', ['-sk', path])).stdout.split('\t')[0] ?? '?';
    out.push(ok('collector.db', `${path} (${size} KB, schema v${db.schemaVersion})`));
    const last = Number(db.kvGet('last_otel_at') ?? 0);
    if (accountsOf(config).length === 0) out.push(ok('collector.data', 'no accounts, so no telemetry is expected'));
    else if (c.now - last <= 3_600_000 && last > 0) out.push(ok('collector.data', 'received telemetry in the last hour'));
    else out.push(warn('collector.data', 'no telemetry received in the last hour (fine if no session was used)', 'Start a session; check ~/.claude*/settings.json has the OTEL_* env keys.'));
  } finally {
    db.close();
  }
  return out;
}

/** Everything `devhost doctor` checks (spec A12), then the plugins' advice on them. Read-only. */
export async function runDoctor(c: DoctorContext): Promise<Check[]> {
  const plugins = await enabledPlugins(c);
  const checks = [
    ...(await guarded('system', () => systemChecks(c))),
    ...(await guarded('tools', () => toolChecks(c))),
    ...(await guarded('accounts', () => accountChecks(c))),
    ...(await guarded('envs', () => envChecks(c))),
    ...(await guarded('collector', () => collectorChecks(c))),
    ...(await guarded('plugins', () => pluginChecks(plugins))),
  ];
  await addAdvice(plugins, checks);
  return checks;
}

type EnabledPlugin = { name: string; source: string; plugin?: DevhostPlugin; error?: string; ctx?: PluginContext };

/** Enabled plugins, each with its context (built once: checks and advice share it). */
async function enabledPlugins(c: DoctorContext): Promise<EnabledPlugin[]> {
  const silent: Reporter = { step: () => undefined, log: () => undefined };
  let loaded: Awaited<ReturnType<typeof loadPlugins>>;
  try {
    loaded = await loadPlugins(c.config, c.deps.home);
  } catch {
    return [];
  }
  return loaded
    .filter((p) => p.enabled)
    .map((p) => ({
      name: p.name,
      source: p.source,
      ...(p.plugin ? { plugin: p.plugin, ctx: pluginContext({ config: c.config, name: p.name, home: c.deps.home, user: c.deps.user, nodePath: c.deps.nodePath, exec: c.exec, reporter: silent, prompter: new NoPrompter() }) } : {}),
      ...(p.error ? { error: p.error } : {}),
    }));
}

/** Each enabled plugin's checks, as `plugin.<name>.<check>`; a plugin that does not load is a warning. */
async function pluginChecks(plugins: EnabledPlugin[]): Promise<Check[]> {
  const out: Check[] = [];
  for (const p of plugins) {
    if (!p.plugin || !p.ctx) {
      out.push(warn(`plugin.${p.name}`, `could not be loaded: ${p.error ?? 'unknown error'}`, `Fix or remove ${p.source}`));
      continue;
    }
    for (const check of p.plugin.checks ?? []) {
      const id = `plugin.${p.name}.${check.id}`;
      try {
        const r = await check.run(p.ctx);
        out.push({ id, status: r.status, message: r.message, ...(r.fix ? { fix: r.fix } : {}) });
      } catch (err) {
        out.push(warn(id, `check crashed: ${(err as Error).message}`));
      }
    }
  }
  return out;
}

/** `system.disk` matches itself; `env.*.service` matches `env.<any one part>.service`. */
export function checkMatches(pattern: string, id: string): boolean {
  const p = pattern.split('.');
  const i = id.split('.');
  return p.length === i.length && p.every((part, n) => part === '*' || part === i[n]);
}

/** Plugins' advice, attached to the checks it speaks to (in place). Advice that throws says so instead. */
async function addAdvice(plugins: EnabledPlugin[], checks: Check[]): Promise<void> {
  for (const p of plugins) {
    if (!p.plugin || !p.ctx) continue;
    for (const a of p.plugin.advice ?? []) {
      for (const check of checks) {
        if (!checkMatches(a.check, check.id) || !(a.on ?? ['warn', 'fail']).includes(check.status)) continue;
        let note: CheckAdvice | null;
        try {
          const r = await a.run(p.ctx, { id: check.id, status: check.status, message: check.message, ...(check.fix ? { fix: check.fix } : {}) });
          const fix = r?.fix ?? (r?.action ? `devhost plugin run ${p.name} ${r.action}` : undefined);
          note = r ? { plugin: p.name, message: r.message, ...(fix ? { fix } : {}), ...(r.action ? { action: r.action } : {}) } : null;
        } catch (err) {
          note = { plugin: p.name, message: `advice crashed: ${(err as Error).message}` };
        }
        if (note) check.advice = [...(check.advice ?? []), note];
      }
    }
  }
}
