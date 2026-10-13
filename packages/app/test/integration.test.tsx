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

  it('shows an unreachable Mac mini and recovers by itself when it returns', async () => {
    const h = await makeHarness();
    h.transport.offline = true;
    mount(h);
    expect(await screen.findByText(/The Mac mini is unreachable/)).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
    h.transport.offline = false;
    expect(await screen.findByText(/connected · devhost/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/The Mac mini is unreachable/)).not.toBeInTheDocument();
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
    expect(JSON.parse(storage.getItem('devhost.prefs.v1')!)).toEqual({ host: 'macmini', theme: 'system', range: '24h' });
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
  async function dashboard() {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('account', 'add', '--name', 'personal', '--git-email', 'me@example.com', '--no-login');
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    seedUsage(h, await configText(h));
    mount(h);
    await screen.findByLabelText('Mac mini health');
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
    const health = within(screen.getByLabelText('Mac mini health'));
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
    await h.user.click(screen.getByRole('button', { name: 'Show as table' }));
    const usage = within(screen.getByLabelText('Usage'));
    expect(usage.getAllByRole('row').length).toBe(25); // header + 24 hourly buckets
    expect(usage.getByRole('table')).toHaveTextContent('10.5K');
    await h.user.click(screen.getByRole('button', { name: 'Cost' }));
    expect(within(screen.getByLabelText('Usage')).getByRole('table')).toHaveTextContent('$1.50');
    await h.user.click(screen.getByRole('button', { name: 'Show chart' }));
    await h.user.click(screen.getByRole('button', { name: 'Tokens' }));
    await h.user.click(screen.getByRole('button', { name: 'Token type' }));
    expect(screen.getByLabelText('Legend')).toHaveTextContent('Cache read');
  });

  it('filters re-query the host; sorting reorders the table', async () => {
    const h = await dashboard();
    await h.user.selectOptions(screen.getByLabelText('Account'), 'personal');
    await waitFor(() => expect(h.transport.calls.some((c) => c[0] === 'dash' && c.includes('--account') && c.includes('personal'))).toBe(true));
    await waitFor(() => expect(within(screen.getByLabelText('Sessions')).getByText('No sessions in this view.')).toBeInTheDocument());
    await h.user.selectOptions(screen.getByLabelText('Account'), '');
    const sessions = within(await screen.findByLabelText('Sessions'));
    await sessions.findByText('sess-wai');
    await h.user.click(sessions.getByRole('button', { name: /^Tokens today/ }));
    const first = () => within(sessions.getAllByRole('row')[1]!).getAllByRole('cell')[2]!.textContent;
    await waitFor(() => expect(first()).toBe('sess-run')); // 9,000 > 1,500
    await h.user.click(sessions.getByRole('button', { name: /^Tokens today/ }));
    await waitFor(() => expect(first()).toBe('sess-wai'));
  });

  it('time range presets and session actions', async () => {
    const h = await dashboard();
    await h.user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(h.transport.calls.some((c) => c[0] === 'dash' && c.includes('7d'))).toBe(true));
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

  it('keeps the last data on screen while the Mac mini is unreachable', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    seedUsage(h, await configText(h));
    mount(h, { heartbeatMs: 50 });
    await screen.findByLabelText('Mac mini health');
    h.transport.offline = true;
    expect(await screen.findByText(/The Mac mini is unreachable/)).toBeInTheDocument();
    // the frame stays: last numbers visible, flagged as stale
    expect(screen.getByLabelText('Mac mini health')).toBeInTheDocument();
    expect(screen.getByText('showing the last data')).toBeInTheDocument();
    h.transport.offline = false;
    await waitFor(() => expect(screen.queryByText(/The Mac mini is unreachable/)).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText('showing the last data')).not.toBeInTheDocument();
  });
});
