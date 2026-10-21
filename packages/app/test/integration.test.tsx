// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeHarness, mount, seedUsage, type Harness } from './support/harness';

const configText = (h: Harness) => readFile(join(h.env.home, '.config', 'devhost', 'config.yaml'), 'utf8');

async function withBusiness(h: Harness) {
  await h.cli('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login');
  h.mac.state.loggedIn.add(join(h.env.home, '.claude-business'));
}

describe('connection (spec B2, B6)', () => {
  it('connects, checks the contract version and shows the CLI version', async () => {
    const h = await makeHarness();
    mount(h);
    expect(await screen.findByText(/connected · devhost 0\.1\.0/)).toBeInTheDocument();
    expect(h.transport.calls[0]).toEqual(['version', '--json']);
  });

  it('refuses an incompatible contract major with a clear message', async () => {
    const h = await makeHarness();
    h.transport.rewrite = (args, out) => (args[0] === 'version' ? out.replace('"contractVersion":1,"ok"', '"contractVersion":1,"ok"').replace(/"contractVersion":1,"cliVersion"/, '"contractVersion":9,"cliVersion"').replace(/"contractVersion":1(?=,"node")/, '"contractVersion":9') : out);
    mount(h);
    expect(await screen.findByText(/speaks contract 9, this app speaks 1/)).toBeInTheDocument();
    expect(screen.getByText(/Update devhost Desktop/)).toBeInTheDocument();
    expect(screen.queryByText('Dashboard', { selector: 'h1' })).not.toBeInTheDocument();
  });

  it('shows an unreachable host, by name, and recovers by itself when it returns', async () => {
    const h = await makeHarness();
    h.transport.offline = true;
    mount(h);
    expect(await screen.findByText(/ is unreachable\./)).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
    h.transport.offline = false;
    expect(await screen.findByText(/connected · devhost/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/ is unreachable\./)).not.toBeInTheDocument();
  });

  it('asks for the host on first run and keeps only the host name', async () => {
    const h = await makeHarness();
    const { render } = await import('@testing-library/react');
    const { App } = await import('../src/App');
    const { memoryStorage } = await import('./support/harness');
    const storage = memoryStorage();
    render(<App makeTransport={() => h.transport} storage={storage} retryMs={30} />);
    await h.user.type(await screen.findByLabelText('Host'), 'macmini');
    await h.user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/connected · devhost/)).toBeInTheDocument();
    expect(JSON.parse(storage.getItem('devhost.prefs.v1')!)).toEqual({ host: 'macmini', theme: 'system', pluginParams: {} });
  });

  it('changes the host through an in-app confirmation (no window.confirm)', async () => {
    const h = await makeHarness();
    const { render } = await import('@testing-library/react');
    const { App } = await import('../src/App');
    const { memoryStorage } = await import('./support/harness');
    const storage = memoryStorage();
    storage.setItem('devhost.prefs.v1', JSON.stringify({ host: 'macmini', theme: 'system', range: '24h' }));
    const hosts: string[] = [];
    render(<App makeTransport={(host) => (hosts.push(host), h.transport)} storage={storage} retryMs={30} />);
    expect(await screen.findByText(/connected · devhost/)).toBeInTheDocument();

    // Cancel keeps the connection.
    await h.user.click(screen.getByRole('button', { name: 'Change host…' }));
    await h.user.click(within(screen.getByRole('dialog', { name: 'Change host' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/connected · devhost/)).toBeInTheDocument();

    // Disconnect shows the host form, pre-filled; a new host connects.
    await h.user.click(screen.getByRole('button', { name: 'Change host…' }));
    await h.user.click(within(screen.getByRole('dialog', { name: 'Change host' })).getByRole('button', { name: 'Disconnect' }));
    const input = await screen.findByLabelText('Host');
    expect(input).toHaveValue('macmini');
    await h.user.clear(input);
    await h.user.type(input, 'other-mini');
    await h.user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/connected · devhost/)).toBeInTheDocument();
    expect(hosts).toEqual(['macmini', 'other-mini']);
    expect(JSON.parse(storage.getItem('devhost.prefs.v1')!)).toMatchObject({ host: 'other-mini' });
  });
});

describe('dashboard (spec B3.1, B6)', () => {
  /** A plugin of yours (installed in ~/.config/devhost/plugins and enabled): a host action that removes things, a session one. */
  const FIXTURE = `export default {
    name: 'tidy', version: '0.1.0', description: 'test plugin',
    actions: [
      { id: 'clean', title: 'Free disk space', description: 'removes caches', scope: 'host', destructive: true,
        async run(ctx) { await ctx.exec.exec('rm', ['-rf', ctx.home + '/cache']); return { summary: ctx.exec.dryRun ? 'would free 1 GB' : 'freed 1 GB' }; } },
      { id: 'stop', title: 'Stop the session process', description: 'ends it', scope: 'session', destructive: true,
        async run(ctx, t) { return { summary: 'stopped ' + t.session.id + ' in ' + t.session.cwd }; } },
    ],
    widgets: [{ id: 'space', title: 'Caches', async run() { return { status: 'warn', summary: '1 GB reclaimable', tiles: [{ label: 'npm cache', value: '1 GB' }], action: 'clean' }; } }],
    advice: [{ check: 'system.disk', on: ['ok', 'warn', 'fail'], async run() { return { message: '1 GB in caches', action: 'clean' }; } }],
  };`;

  async function dashboard(webApps: string[] = [], transcripts: Record<string, string> = {}, plugin = false) {
    const h = await makeHarness();
    webApps.forEach((a) => h.transport.webAppsInstalled.add(a));
    await withBusiness(h);
    if (plugin) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(h.env.home, '.config', 'devhost', 'plugins', 'tidy'), { recursive: true });
      await writeFile(join(h.env.home, '.config', 'devhost', 'plugins', 'tidy', 'index.js'), FIXTURE);
      await h.cli('plugin', 'enable', 'tidy');
    }
    for (const [id, lines] of Object.entries(transcripts)) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const dir = join(h.env.home, '.claude-business', 'projects', join(h.env.home, 'work', 'business', 'acme-api').replace(/[^A-Za-z0-9]/g, '-'));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${id}.jsonl`), lines);
    }
    await h.cli('account', 'add', '--name', 'personal', '--git-email', 'me@example.com', '--no-login');
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    seedUsage(h, await configText(h));
    mount(h);
    await screen.findByLabelText('Host health');
    return h;
  }

  it('shows sessions of all accounts, highlights the one waiting, and the tray follows', async () => {
    const h = await dashboard();
    const sessions = within(await screen.findByLabelText('Sessions'));
    const rows = await sessions.findAllByRole('row');
    expect(rows.length).toBe(3); // header + 2 sessions
    const waiting = sessions.getByText('sess-wai').closest('tr')!;
    expect(waiting).toHaveClass('waiting');
    expect(within(waiting).getByText('waiting for input')).toBeInTheDocument();
    expect(sessions.getByText('sess-run').closest('tr')).not.toHaveClass('waiting');
    // matches what `devhost dash --json` says: 9,000 + 1,200 + 300 tokens, $1.50
    expect(within(sessions.getByText('sess-run').closest('tr')!).getByText('$1.50')).toBeInTheDocument();
    expect(within(sessions.getByText('sess-run').closest('tr')!).getByText('9,000')).toBeInTheDocument();
    expect(screen.getByLabelText('1 sessions waiting')).toBeInTheDocument();
    await waitFor(() => expect(h.transport.tray.at(-1)).toEqual({ status: 'green', waiting: 1 }));
  });

  it('health header, per-account totals with the alert limit, and the known limits', async () => {
    await dashboard();
    const health = within(screen.getByLabelText('Host health'));
    expect(health.getByText('online')).toBeInTheDocument();
    expect(health.getByText('40%')).toBeInTheDocument(); // memory from the sampler
    const business = within(screen.getByLabelText('Account business'));
    expect(business.getAllByText('10.5K')).toHaveLength(2); // tokens today and this week
    expect(business.getAllByText(/~\$1\.50/)).toHaveLength(2);
    expect(screen.getByLabelText('Known limits')).toHaveTextContent('Subscription plan limits');
    expect(screen.getByText(/Cost is an estimate from Claude Code/)).toBeInTheDocument();
  });

  it('draws the usage chart with a legend, a table view and a per-column readout', async () => {
    const h = await dashboard();
    expect(screen.getByRole('img', { name: /Tokens per hour/ })).toBeInTheDocument();
    // two accounts → a legend; the chart has focusable columns that carry their values
    expect(screen.getByLabelText('Legend')).toHaveTextContent('business');
    const columns = screen.getAllByLabelText(/business 10\.5K/);
    expect(columns.length).toBe(1);
    expect(columns[0]).toHaveAttribute('tabindex', '0');
    const usage = within(screen.getByRole('region', { name: 'Usage over time (stats)' }));
    await h.user.click(usage.getByRole('button', { name: 'Show as table' }));
    expect(usage.getAllByRole('row').length).toBe(25); // header + 24 hourly buckets
    expect(usage.getByRole('table')).toHaveTextContent('10.5K');
    await h.user.click(screen.getByRole('button', { name: 'Cost' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Usage over time (stats)' })).getByRole('table')).toHaveTextContent('$1.50'));
    await h.user.click(within(screen.getByRole('region', { name: 'Usage over time (stats)' })).getByRole('button', { name: 'Show chart' }));
    await h.user.click(screen.getByRole('button', { name: 'Tokens' }));
    await h.user.click(screen.getByRole('button', { name: 'Token type' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Usage over time (stats)' })).getByLabelText('Legend')).toHaveTextContent('Cache read'));
  });

  it('filters re-query the host; sorting reorders the table', async () => {
    const h = await dashboard();
    // The filters are the stats plugin's: they narrow its cards, not the sessions.
    await h.user.selectOptions(screen.getByLabelText('Account'), 'personal');
    await waitFor(() => expect(h.transport.calls.some((c) => c[0] === 'plugin' && c.includes('stats.account=personal'))).toBe(true));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Account business' })).toBeNull());
    expect(screen.getByRole('region', { name: 'Account personal' })).toBeInTheDocument();
    await h.user.selectOptions(screen.getByLabelText('Account'), '');
    const sessions = within(await screen.findByLabelText('Sessions'));
    await sessions.findByText('sess-wai');
    await h.user.click(sessions.getByRole('button', { name: /^Tokens today/ }));
    const first = () => within(within(sessions.getAllByRole('row')[1]!).getAllByRole('cell')[2]!).getByText(/^sess-/).textContent;
    await waitFor(() => expect(first()).toBe('sess-run')); // 9,000 > 1,500
    await h.user.click(sessions.getByRole('button', { name: /^Tokens today/ }));
    await waitFor(() => expect(first()).toBe('sess-wai'));
  });

  it("shows each session's title from its transcript, else its last prompt", async () => {
    await dashboard([], {
      'sess-waiting-1': `${JSON.stringify({ type: 'custom-title', customTitle: 'Fix the login flow', sessionId: 'sess-waiting-1' })}\n`,
      'sess-running-2': `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'run the   tests again', sessionId: 'sess-running-2' })}\n`,
    });
    const sessions = within(await screen.findByLabelText('Sessions'));
    expect(await sessions.findByText('Fix the login flow')).toBeInTheDocument();
    const prompt = sessions.getByText('run the tests again');
    expect(prompt).toHaveClass('last-prompt');
    expect(prompt.closest('td')).toHaveAttribute('title', expect.stringContaining('Last prompt: run the tests again'));
  });

  it('shows subagents per session and how many agents worked at once', async () => {
    await dashboard();
    const card = within(await screen.findByRole('region', { name: 'Agents at work (stats)' }));
    expect(card.getByText(/now 1 session \+ 1 subagent/)).toBeInTheDocument();
    expect(card.getByText(/most at once in this range: 5$/)).toBeInTheDocument(); // the peak, an hour ago: 2 sessions + 3 subagents
    const row = (await screen.findByText('sess-run')).closest('tr')!;
    expect(within(row).getByText('+1 subagent running')).toBeInTheDocument();
    expect(within(row).getByText(/2 subagents \(Explore, Plan\)/)).toBeInTheDocument();
  });

  it("plugin session actions are in the session's Open menu and ask before they stop anything", async () => {
    const h = await dashboard([], {}, true);
    const row = (await screen.findByText('sess-wai')).closest('tr')!;
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    await h.user.click(await screen.findByRole('menuitem', { name: 'Stop the session process…' }));
    const dlg = within(await screen.findByRole('dialog', { name: /Stop the session process · sess-wai/ }));
    const ask = await dlg.findByText(/Stop the session process for session sess-wai/, undefined, { timeout: 8000 });
    await h.user.click(within(ask.closest('.prompt') as HTMLElement).getByRole('button', { name: 'Yes' }));
    expect(await dlg.findByLabelText('Result', undefined, { timeout: 8000 })).toHaveTextContent(`stopped sess-waiting-1 in ${join(h.env.home, 'work', 'business', 'acme-api')}`);
    expect(h.transport.calls.some((c) => c.join(' ').startsWith('plugin run tidy stop --session sess-waiting-1'))).toBe(true);
  });

  it("a plugin's widget is a dashboard card whose button runs its action; its advice shows in Doctor", async () => {
    const h = await dashboard([], {}, true);
    const card = within(await screen.findByRole('region', { name: 'Caches (tidy)' }));
    expect(card.getByText('1 GB reclaimable')).toBeInTheDocument();
    expect(card.getByText('npm cache')).toBeInTheDocument();
    await h.user.click(card.getByRole('button', { name: 'Free disk space…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Free disk space' }));
    const ask = await dlg.findByText(/Free disk space\?/, undefined, { timeout: 8000 });
    await h.user.click(within(ask.closest('.prompt') as HTMLElement).getByRole('button', { name: 'No' }));
    expect(h.transport.calls.some((c) => c.join(' ').startsWith('plugin run tidy clean'))).toBe(true);
    const widgetCalls = () => h.transport.calls.filter((c) => c[0] === 'plugin' && c[1] === 'widgets').length;
    const before = widgetCalls();
    await h.user.click(await dlg.findByRole('button', { name: 'Close' }, { timeout: 8000 }));
    await waitFor(() => expect(widgetCalls()).toBeGreaterThan(before)); // the card is refreshed

    await h.user.click(screen.getByRole('button', { name: 'Doctor' }));
    // The disk check is OK: its advice shows with all checks, not only problems.
    await h.user.click(await screen.findByRole('button', { name: 'All checks' }, { timeout: 8000 }));
    const advice = within(await screen.findByLabelText('Advice from tidy', undefined, { timeout: 8000 }));
    expect(advice.getByText(/1 GB in caches/)).toBeInTheDocument();
    expect(advice.getByRole('button', { name: 'Free disk space…' })).toBeInTheDocument();
  });

  it('the Plugins screen lists the plugins and runs host actions, with a preview for the ones that remove things', async () => {
    const h = await dashboard([], {}, true);
    await h.user.click(screen.getByRole('button', { name: 'Plugins' }));
    const card = within(await screen.findByRole('region', { name: 'Plugin tidy' }));
    expect(card).not.toBeNull();
    await h.user.click(card.getByRole('button', { name: 'Preview' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Preview: Free disk space' }));
    expect(await dlg.findByLabelText('Result', undefined, { timeout: 8000 })).toHaveTextContent('would free 1 GB');
    expect(h.transport.calls.some((c) => c.join(' ') === 'plugin run tidy clean --dry-run --json')).toBe(true);
    expect(screen.getByRole('region', { name: 'Plugin tidy' })).toHaveTextContent("In each session's Open menu");
    await h.user.click(dlg.getByRole('button', { name: 'Close' }));

    // Off and on again; uninstall removes it.
    await h.user.click(card.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(card.getByText('off')).toBeInTheDocument());
    await h.user.click(card.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(card.getByText('on')).toBeInTheDocument());
    await h.user.click(card.getByRole('button', { name: 'Uninstall…' }));
    await h.user.click(within(await screen.findByRole('dialog', { name: 'Uninstall tidy?' })).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Plugin tidy' })).toBeNull());
    // Install asks for a repository and says the plugin stays off.
    await h.user.click(screen.getByRole('button', { name: 'Install from GitHub…' }));
    const inst = within(await screen.findByRole('dialog', { name: 'Install a plugin' }));
    expect(inst.getByRole('button', { name: 'Install' })).toBeDisabled();
    await h.user.type(inst.getByLabelText('GitHub repository'), 'someone/devhost-plugin-x');
    expect(inst.getByText(/stays off until you enable it/)).toBeInTheDocument();
    await h.user.click(inst.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(h.transport.calls.some((c) => c.join(' ') === 'plugin install someone/devhost-plugin-x --json')).toBe(true));
  });

  it("claude.ai/code opens the account's web app when it has one", async () => {
    const h = await dashboard(['Claude – business']);
    const row = (await screen.findByText('sess-wai')).closest('tr')!;
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    await h.user.click(await screen.findByRole('menuitem', { name: 'claude.ai/code (Claude – business)' }));
    expect(h.transport.opened.at(-1)).toEqual({ webApp: 'Claude – business' });
  });

  it('time range presets and session actions', async () => {
    const h = await dashboard();
    await h.user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(h.transport.calls.some((c) => c[0] === 'plugin' && c.includes('stats.range=7d'))).toBe(true));
    const row = (await screen.findByText('sess-wai')).closest('tr')!;
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    await h.user.click(screen.getByRole('menuitem', { name: 'Terminal: resume this session' }));
    expect(h.transport.opened.at(-1)).toEqual({ terminal: { kind: 'resume', dir: join(h.env.home, 'work', 'business', 'acme-api'), sessionId: 'sess-waiting-1' } });
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    await h.user.click(screen.getByRole('menuitem', { name: 'VS Code (Remote SSH)' }));
    expect(h.transport.opened.at(-1)).toEqual({ vscode: join(h.env.home, 'work', 'business', 'acme-api') });
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    await h.user.click(screen.getByRole('menuitem', { name: 'claude.ai/code' }));
    expect(h.transport.opened.at(-1)).toEqual({ url: 'https://claude.ai/code' });
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    await h.user.click(screen.getByRole('menuitem', { name: /Dev server \(port 3000\)/ }));
    expect(h.transport.opened.at(-1)).toEqual({ url: 'http://macmini:3000' });
  });

  it('an ended Remote Control worktree session can be reattached from its Open menu; others cannot', async () => {
    const h = await dashboard();
    const { Db, dbPath } = await import('../../cli/src/collector/db.js');
    const wt = join(h.env.home, 'work', 'business', 'acme-api', '.claude', 'worktrees', 'bridge-cse_01Abc');
    const now = h.env.deps.now().getTime();
    const db = new Db(dbPath(h.env.home));
    db.run("INSERT INTO sessions VALUES ('sess-ended-3', 'business', 'acme-api', ?, 'ended', ?, ?, ?)", wt, now - 60_000, now - 30_000, now - 1000);
    db.close();
    const row = (await screen.findByText('sess-end', undefined, { timeout: 8000 })).closest('tr')!;
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    await h.user.click(screen.getByRole('menuitem', { name: 'claude.ai/code' }));
    expect(h.transport.opened.at(-1)).toEqual({ url: 'https://claude.ai/code/session_01Abc' });
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    await h.user.click(screen.getByRole('menuitem', { name: 'Reattach to Remote Control…' }));
    expect(await screen.findByRole('dialog', { name: 'Reattach session sess-end' })).toBeInTheDocument();
    await waitFor(() => expect(h.transport.calls.some((c) => c.join(' ') === 'session reattach sess-ended-3 --json')).toBe(true));

    const other = (await screen.findByText('sess-wai')).closest('tr')!;
    await h.user.click(within(other).getByRole('button', { name: /Open/ }));
    expect(screen.queryByRole('menuitem', { name: 'Reattach to Remote Control…' })).toBeNull();
  });

  it('hides VS Code when it is not installed on the MacBook', async () => {
    const h = await dashboard();
    h.transport.tools = { code: false, iterm: false };
    // tools are detected once on connect; remount
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    mount(h);
    const row = (await screen.findByText('sess-wai')).closest('tr')!;
    await h.user.click(within(row).getByRole('button', { name: /Open/ }));
    expect(screen.queryByRole('menuitem', { name: 'VS Code (Remote SSH)' })).not.toBeInTheDocument();
  });

  it("names the host as devhost reports it, and no screen says Mac mini", async () => {
    const h = await makeHarness();
    await h.cli('config', 'set', '/machine/hostname', '"studio"');
    mount(h);
    expect(await screen.findByText(/connected · devhost/)).toBeInTheDocument();
    h.transport.offline = true;
    expect(await screen.findByText('studio is unreachable.', undefined, { timeout: 25_000 })).toBeInTheDocument();
    const { readdir, readFile: read } = await import('node:fs/promises');
    const src = join(__dirname, '..', 'src');
    const files = (await readdir(src, { recursive: true })).filter((f) => /\.(tsx?|css)$/.test(String(f)));
    for (const f of files) expect(await read(join(src, String(f)), 'utf8'), String(f)).not.toContain('Mac mini');
  }, 30_000);

  it('keeps the last data on screen while the host is unreachable', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    seedUsage(h, await configText(h));
    mount(h, { heartbeatMs: 50 });
    await screen.findByLabelText('Host health');
    h.transport.offline = true;
    expect(await screen.findByText(/ is unreachable\./)).toBeInTheDocument();
    // the frame stays: last numbers visible, flagged as stale
    expect(screen.getByLabelText('Host health')).toBeInTheDocument();
    expect(screen.getByText('showing the last data')).toBeInTheDocument();
    h.transport.offline = false;
    await waitFor(() => expect(screen.queryByText(/ is unreachable\./)).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText('showing the last data')).not.toBeInTheDocument();
  });
});
