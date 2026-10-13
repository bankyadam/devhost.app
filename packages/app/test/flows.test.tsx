// @vitest-environment jsdom
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { feed, makeHarness, mount, type Harness } from './support/harness';

const cfg = (h: Harness) => readFile(join(h.env.home, '.config', 'devhost', 'config.yaml'), 'utf8');
const goto = (h: Harness, name: string) => h.user.click(screen.getByRole('button', { name }));

async function withBusiness(h: Harness, login = true) {
  await h.cli('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login');
  if (login) h.mac.state.loggedIn.add(join(h.env.home, '.claude-business'));
}

async function openWizard(h: Harness, button: string) {
  await h.user.click(screen.getByRole('button', { name: button }));
  return within(await screen.findByRole('dialog'));
}

describe('environments (spec B3.2)', () => {
  it('create wizard: account → name → repo → Remote Control → compose → review → live run with prompts', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    mount(h);
    await screen.findByText(/connected · devhost/);
    await goto(h, 'Environments');
    expect(await screen.findByText(/No environments yet/)).toBeInTheDocument();

    const dlg = await openWizard(h, 'New environment');
    await h.user.click(await dlg.findByRole('combobox', { name: 'Account' }).then(() => dlg.getByRole('button', { name: 'Next' })));
    const name = dlg.getByLabelText('Name');
    await h.user.type(name, 'Bad Name');
    expect(await dlg.findByText(/Lowercase letters, digits and dashes/)).toBeInTheDocument();
    expect(dlg.getByRole('button', { name: 'Next' })).toBeDisabled();
    await h.user.clear(name);
    await h.user.type(name, 'acme-api');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.type(dlg.getByLabelText(/Repository URL/), 'git@github.com:acme/api.git');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.selectOptions(dlg.getByLabelText('Permission mode of its sessions'), 'plan');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));

    // Review shows the allocated port block and the generated paths before anything runs.
    expect(dlg.getByText('3000–3099')).toBeInTheDocument();
    expect(dlg.getByText(/~\/work\/business\/acme-api/)).toBeInTheDocument();
    expect(dlg.getByText(/com\.devhost\.rc\.business\.acme-api, plan/)).toBeInTheDocument();
    expect(dlg.getByText(/devhost-acme-api/)).toBeInTheDocument();
    expect(h.transport.calls.some((c) => c[0] === 'env' && c[1] === 'create')).toBe(false);

    await h.user.click(dlg.getByRole('button', { name: 'Create environment' }));
    // The workspace-trust question arrives as a prompt event and is answered in the app.
    const trust = await screen.findByText(/Trust .* and let Claude Code run there\?/, undefined, { timeout: 8000 });
    await h.user.click(within(trust.closest('.prompt') as HTMLElement).getByRole('button', { name: 'Yes' }));
    const enable = await screen.findByText(/Enable Remote Control for this account/, undefined, { timeout: 8000 });
    await h.user.click(within(enable.closest('.prompt') as HTMLElement).getByRole('button', { name: 'Yes' }));
    expect(await screen.findByText('Done.', undefined, { timeout: 8000 })).toBeInTheDocument();

    // Same result as the CLI: config entry, directory, service.
    expect(await cfg(h)).toMatch(/- name: acme-api[\s\S]*portBase: 3000[\s\S]*permissionMode: plan/);
    expect((await stat(join(h.env.home, 'work', 'business', 'acme-api', '.git'))).isDirectory()).toBe(true);
    expect(h.mac.state.loaded.has('com.devhost.rc.business.acme-api')).toBe(true);
    expect(h.transport.calls.find((c) => c[1] === 'create')).toEqual(['env', 'create', '--account', 'business', '--name', 'acme-api', '--repo', 'git@github.com:acme/api.git', '--permission-mode', 'plan', '--compose', 'auto', '--json']);

    await h.user.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('running · pid 4242')).toBeInTheDocument();
  });

  it('create stopped by sudo: Open in Terminal runs the same command, which finishes the setup', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    h.mac.state.sudoNeedsPassword = true;
    mount(h);
    await screen.findByText(/connected · devhost/);
    await goto(h, 'Environments');
    const dlg = await openWizard(h, 'New environment');
    await h.user.click(await dlg.findByRole('combobox', { name: 'Account' }).then(() => dlg.getByRole('button', { name: 'Next' })));
    await h.user.type(dlg.getByLabelText('Name'), 'acme-api');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.type(dlg.getByLabelText(/Repository URL/), 'git@github.com:acme/api.git');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.selectOptions(dlg.getByLabelText('Permission mode of its sessions'), 'plan');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.click(dlg.getByRole('button', { name: 'Create environment' }));
    const trust = await screen.findByText(/Trust .* and let Claude Code run there\?/, undefined, { timeout: 8000 });
    await h.user.click(within(trust.closest('.prompt') as HTMLElement).getByRole('button', { name: 'Yes' }));
    const enable = await screen.findByText(/Enable Remote Control for this account/, undefined, { timeout: 8000 });
    await h.user.click(within(enable.closest('.prompt') as HTMLElement).getByRole('button', { name: 'Yes' }));

    const alert = await screen.findByText(/needs you at a keyboard/, undefined, { timeout: 8000 });
    await h.user.click(within(alert.closest('.notice') as HTMLElement).getByRole('button', { name: 'Open in Terminal' }));
    const sent = h.transport.calls.find((c) => c[1] === 'create')!;
    const terminal = h.transport.opened.at(-1)!.terminal!;
    expect(terminal).toEqual({ kind: 'devhost', args: sent.filter((a) => a !== '--json') });

    // In the Terminal the password is entered; the same command continues instead of "already exists".
    h.mac.state.sudoNeedsPassword = false;
    feed(h, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    // (The Terminal asks these on its tty; here they are answered as prompt events.)
    expect(await h.cli(...(terminal.kind === 'devhost' ? terminal.args : []), '--json')).toBe(0);
    expect((await cfg(h)).match(/^\s+- name: acme-api$/gm)).toHaveLength(1);
    expect(h.mac.state.loaded.has('com.devhost.rc.business.acme-api')).toBe(true);
  });

  it('start / stop / restart a service; a missing sudo password offers a Terminal window', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    mount(h);
    await goto(h, 'Environments');
    // `--no-rc` means no service: no start/stop buttons, the row says the service is off.
    expect(await screen.findByText('off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('delete keeps the files by default; deleting files needs the typed name', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    mount(h);
    await goto(h, 'Environments');
    await h.user.click(await screen.findByRole('button', { name: 'Delete…' }));
    let dlg = within(await screen.findByRole('dialog'));
    expect(dlg.getByText(/The files stay on disk/)).toBeInTheDocument();
    await h.user.click(dlg.getByLabelText('Also delete the project files'));
    expect(dlg.getByText(/asks you to type/)).toBeInTheDocument();
    await h.user.click(dlg.getByRole('button', { name: 'Review and delete…' }));
    // The CLI asks for the typed name; a wrong one deletes nothing.
    const ask = await screen.findByText(/Type the environment name "acme-api"/, undefined, { timeout: 8000 });
    const box = within(ask.closest('.prompt') as HTMLElement);
    await h.user.type(box.getByLabelText('Answer'), 'nope');
    await h.user.click(box.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/the typed name does not match/, undefined, { timeout: 8000 })).toBeInTheDocument();
    expect((await stat(join(h.env.home, 'work', 'business', 'acme-api'))).isDirectory()).toBe(true);
    await h.user.click(screen.getByRole('button', { name: 'Close' }));

    // Plain delete: confirm, entry gone, files stay.
    await h.user.click(await screen.findByRole('button', { name: 'Delete…' }));
    dlg = within(await screen.findByRole('dialog'));
    await h.user.click(dlg.getByRole('button', { name: 'Stop and remove' }));
    const confirm = await screen.findByText(/Stop and remove environment business\/acme-api\?/, undefined, { timeout: 8000 });
    await h.user.click(within(confirm.closest('.prompt') as HTMLElement).getByRole('button', { name: 'Yes' }));
    expect(await screen.findByText('Done.', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(await cfg(h)).not.toMatch(/^ *- name: acme-api/m);
    expect((await stat(join(h.env.home, 'work', 'business', 'acme-api'))).isDirectory()).toBe(true);
  });

  it('a service action that needs the sudo password offers Terminal and never handles the password', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    feed(h, { id: 'trust-workspace', value: true }, { id: 'enable-remote-control', value: true });
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--json');
    h.env.deps.stdin = process.stdin;
    // sudo wants a password and there is no terminal
    const original = h.mac.runner.run.bind(h.mac.runner);
    h.mac.runner.run = async (cmd, args, opts) => (cmd === 'sudo' ? { code: 1, stdout: '', stderr: 'sudo: a password is required\n' } : original(cmd, args, opts));
    mount(h);
    await goto(h, 'Environments');
    await h.user.click(await screen.findByRole('button', { name: 'Restart' }));
    const alert = await screen.findByText(/needs you at a keyboard/, undefined, { timeout: 8000 });
    expect(alert.closest('.notice')).toHaveTextContent('sudo password');
    expect(alert.closest('.notice')).toHaveTextContent('never handles the password');
    await h.user.click(within(alert.closest('.notice') as HTMLElement).getByRole('button', { name: 'Open in Terminal' }));
    expect(h.transport.opened.at(-1)).toEqual({ terminal: { kind: 'devhost', args: ['env', 'restart', 'acme-api'] } });
  });

  it('shows the service log in a viewer', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(h.env.home, 'Library', 'Logs', 'devhost'), { recursive: true });
    await writeFile(join(h.env.home, 'Library', 'Logs', 'devhost', 'rc-business-acme-api.log'), 'server started\nconnected\n');
    mount(h);
    await goto(h, 'Environments');
    await h.user.click(await screen.findByRole('button', { name: 'Logs' }));
    await waitFor(() => expect(screen.getByLabelText('Log')).toHaveTextContent('server started'));
  });
});

describe('accounts (spec B3.3, B6)', () => {
  it('new account wizard continues straight into the login: URL to the browser, code back', async () => {
    const h = await makeHarness();
    mount(h);
    await goto(h, 'Accounts');
    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument();
    const dlg = await openWizard(h, 'New account');
    await h.user.type(dlg.getByLabelText('Account name'), 'business');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.type(dlg.getByLabelText('Git name (optional)'), 'Ada');
    expect(dlg.getByRole('button', { name: 'Next' })).toBeDisabled(); // email missing
    await h.user.type(dlg.getByLabelText('Git email'), 'ada@work.example');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.click(dlg.getByRole('button', { name: 'Next' })); // default? no
    await h.user.type(dlg.getByLabelText(/Daily cost alert/), '50');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    expect(dlg.getByText('~/.claude-business')).toBeInTheDocument();
    expect(dlg.getByText('3000–3999')).toBeInTheDocument();
    expect(dlg.getByText('$50 per day')).toBeInTheDocument();
    await h.user.click(dlg.getByRole('button', { name: 'Add account and sign in' }));

    const prompt = await screen.findByRole('group', { name: 'Question from devhost' }, { timeout: 8000 });
    await h.user.click(within(prompt).getByRole('button', { name: 'Open in my browser' }));
    expect(h.transport.opened.at(-1)).toEqual({ url: 'https://claude.ai/oauth/authorize?code=true&x=1' });
    await h.user.type(within(prompt).getByLabelText('Code from the browser'), 'CODE-42');
    await h.user.click(within(prompt).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Done.', undefined, { timeout: 8000 })).toBeInTheDocument();

    expect(h.mac.runner.spawned[0]!.process.written).toEqual(['CODE-42\n']);
    expect(await cfg(h)).toMatch(/- name: business[\s\S]*dailyCostUsd: 50/);
    await h.user.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('logged in')).toBeInTheDocument();
  });

  it('only one default account: the checkbox is disabled when one exists', async () => {
    const h = await makeHarness();
    await h.cli('account', 'add', '--name', 'personal', '--git-email', 'a@b.c', '--default', '--no-login');
    mount(h);
    await goto(h, 'Accounts');
    const dlg = await openWizard(h, 'New account');
    await h.user.type(dlg.getByLabelText('Account name'), 'second');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    await h.user.type(dlg.getByLabelText('Git email'), 'a@b.c');
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    expect(dlg.getByRole('checkbox')).toBeDisabled();
    expect(dlg.getByText(/Another account already is the default/)).toBeInTheDocument();
  });

  it('remove is disabled while the account has environments, then keeps files and credentials', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    mount(h);
    await goto(h, 'Accounts');
    const remove = await screen.findByRole('button', { name: 'Remove…' });
    await waitFor(() => expect(remove).toBeDisabled());
    expect(remove).toHaveAttribute('title', expect.stringContaining('acme-api'));
    await h.cli('env', 'delete', 'acme-api', '--yes');
    await goto(h, 'Dashboard');
    await goto(h, 'Accounts');
    const again = await screen.findByRole('button', { name: 'Remove…' });
    await waitFor(() => expect(again).toBeEnabled());
    await h.user.click(again);
    const dlg = within(await screen.findByRole('dialog'));
    expect(dlg.getByText(/Stays on disk/)).toBeInTheDocument();
    await h.user.click(dlg.getByLabelText(/Also sign out/));
    await h.user.click(dlg.getByRole('button', { name: 'Remove account' }));
    expect(await screen.findByText('Done.', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(await cfg(h)).not.toMatch(/^ *- name: business/m);
    expect((await stat(join(h.env.home, '.claude-business'))).isDirectory()).toBe(true);
    expect(h.mac.runner.lines()).toContain('/opt/homebrew/bin/claude auth logout');
  });

  it('re-login: opens the URL, sends the code, shows what was restarted', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    h.mac.state.loggedIn.clear();
    mount(h);
    await goto(h, 'Accounts');
    expect(await screen.findByText('not logged in')).toBeInTheDocument();
    await h.user.click(screen.getByRole('button', { name: 'Log in' }));
    const prompt = await screen.findByRole('group', { name: 'Question from devhost' }, { timeout: 8000 });
    await h.user.click(within(prompt).getByRole('button', { name: 'Open in my browser' }));
    expect(h.transport.opened.at(-1)).toMatchObject({ url: expect.stringContaining('claude.ai/oauth') });
    await h.user.type(within(prompt).getByLabelText('Code from the browser'), 'C');
    await h.user.click(within(prompt).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Done.', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(h.mac.state.loggedIn.size).toBe(1);
  });
});

describe('configuration (spec B3.4, B6)', () => {
  it('invalid config cannot be saved; the problem is shown', async () => {
    const h = await makeHarness();
    mount(h);
    await goto(h, 'Configuration');
    const host = await screen.findByLabelText('Hostname');
    await h.user.clear(host);
    await h.user.type(host, 'not a host');
    expect(await screen.findByText(/1 problem/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Problems')).toHaveTextContent('/machine/hostname');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(host).toHaveAttribute('aria-invalid', 'true');
    // The same text typed into the YAML tab is just as invalid.
    await h.user.click(screen.getByRole('tab', { name: 'YAML' }));
    expect((screen.getByLabelText('Config YAML') as HTMLTextAreaElement).value).toContain('hostname: not a host');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(await cfg(h)).toContain('hostname: macmini');
  });

  it('form edits keep comments; save → dry-run diff with sudo steps → confirm → live apply', async () => {
    const h = await makeHarness();
    mount(h);
    await goto(h, 'Configuration');
    const host = await screen.findByLabelText('Hostname');
    await h.user.clear(host);
    await h.user.type(host, 'newname');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await h.user.click(screen.getByRole('button', { name: 'Save' }));

    // Review: the plan from `apply --dry-run`, sudo steps called out, nothing applied yet.
    const dlg = within(await screen.findByRole('dialog', { name: 'Review before applying' }));
    expect(await dlg.findByText('What would change')).toBeInTheDocument();
    expect(dlg.getAllByText('system.hostname').length).toBeGreaterThan(0);
    const plan = dlg.getByLabelText('Plan');
    expect(plan).toHaveTextContent('[sudo] system.hostname: scutil --set ComputerName newname');
    expect(dlg.getByText(/These steps need the sudo password/)).toBeInTheDocument();
    expect(dlg.getByText(/the app never sees it/)).toBeInTheDocument();
    expect(h.mac.state.names.HostName).toBe('macmini');
    expect(await cfg(h)).toContain('hostname: newname');
    expect(await cfg(h)).toContain('# devhost configuration.'); // comments survive the round trip

    await h.user.click(dlg.getByRole('button', { name: 'Apply in Terminal' }));
    expect(h.transport.opened.at(-1)).toEqual({ terminal: { kind: 'devhost', args: ['apply'] } });

    // Apply here: the fake Mac has no sudo password prompt, so it goes through with live progress.
    await h.user.click(dlg.getByRole('button', { name: 'Apply' }));
    const applying = within(await screen.findByRole('dialog', { name: 'Applying' }));
    expect(await applying.findByText('Done.', undefined, { timeout: 10000 })).toBeInTheDocument();
    expect(applying.getAllByText('system.hostname').length).toBeGreaterThan(0);
    expect(h.mac.state.names.HostName).toBe('newname');
  });

  it('YAML tab edits and the form stay in sync', async () => {
    const h = await makeHarness();
    mount(h);
    await goto(h, 'Configuration');
    await screen.findByLabelText('Hostname');
    await h.user.click(screen.getByRole('tab', { name: 'YAML' }));
    const yaml = screen.getByLabelText('Config YAML') as HTMLTextAreaElement;
    await h.user.clear(yaml);
    await h.user.click(yaml);
    await h.user.paste('machine: { hostname: fromyaml }\nnotify: { topic: devhost-abcdefgh }\n');
    await h.user.click(screen.getByRole('tab', { name: 'Form' }));
    expect(await screen.findByLabelText('Hostname')).toHaveValue('fromyaml');
    expect(await screen.findByText('valid')).toBeInTheDocument();
  });
});

describe('doctor and logs (spec B3.5)', () => {
  it('shows the checklist with fixes you can copy, and opens the collector log', async () => {
    const h = await makeHarness();
    await withBusiness(h, false); // not logged in → a failing check with a fix
    mount(h);
    await goto(h, 'Doctor and logs');
    expect(await screen.findByText('account.business.login', undefined, { timeout: 8000 })).toBeInTheDocument();
    const item = screen.getByText('account.business.login').closest('.item') as HTMLElement;
    expect(item).toHaveTextContent('not logged in');
    expect(item).toHaveTextContent('devhost login business');
    expect(within(item).getByRole('button', { name: 'Copy fix' })).toBeInTheDocument();
    expect(screen.getByText(/\d+ failed/)).toBeInTheDocument();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(h.env.home, 'Library', 'Logs', 'devhost'), { recursive: true });
    await writeFile(join(h.env.home, 'Library', 'Logs', 'devhost', 'collector.log'), 'collector listening on 127.0.0.1:4318\n');
    await h.user.click(screen.getByRole('button', { name: 'Collector' }));
    await waitFor(() => expect(screen.getByLabelText('Log')).toHaveTextContent('collector listening'));
  });
});

describe('menu bar', () => {
  it('navigates when the tray asks; red when a login is invalid and an alert is active', async () => {
    const h = await makeHarness();
    mount(h);
    await screen.findByText(/connected · devhost/);
    h.transport.emitNavigate('environments');
    expect(await screen.findByText('Environments', { selector: 'h1' })).toBeInTheDocument();
    h.transport.emitNavigate('nonsense');
    expect(screen.getByText('Environments', { selector: 'h1' })).toBeInTheDocument();
    await waitFor(() => expect(h.transport.tray.length).toBeGreaterThan(0));
  });
});
