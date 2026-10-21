// @vitest-environment jsdom
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { feed, makeHarness, mount, type Harness } from './support/harness';

// jsdom has no canvas; the SVG → PNG step is the browser's job.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
vi.mock('../src/lib/webAppIcon', async (load) => ({ ...(await load<object>()), rasterizeIcon: async () => PNG }));

const cfg = (h: Harness) => readFile(join(h.env.home, '.config', 'devhost', 'config.yaml'), 'utf8');
const goto = (h: Harness, name: string) => h.user.click(screen.getByRole('button', { name }));

async function withBusiness(h: Harness, login = true) {
  await h.cli('account', 'add', '--name', 'business', '--git-email', 'me@work.example', '--no-login');
  if (login) h.mac.state.loggedIn.add(join(h.env.home, '.claude-business'));
}

/** The Environments row actions other than opening Claude live in its "…" menu. */
async function envAction(h: Harness, env: string, action: string) {
  await h.user.click(await screen.findByRole('button', { name: `More actions for ${env}` }));
  await h.user.click(screen.getByRole('menuitem', { name: action }));
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

  it('create wizard by keyboard: each step opens focused, Enter moves on, the review never starts by Enter', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    mount(h);
    await screen.findByText(/connected · devhost/);
    await goto(h, 'Environments');
    const dlg = await openWizard(h, 'New environment');
    expect(await dlg.findByRole('combobox', { name: 'Account' })).toHaveFocus();
    await h.user.keyboard('{Enter}');

    const name = dlg.getByLabelText('Name');
    expect(name).toHaveFocus();
    await h.user.keyboard('Bad Name{Enter}'); // invalid: stays on the step
    expect(name).toHaveFocus();
    await h.user.clear(name);
    await h.user.keyboard('acme-api{Enter}');

    expect(dlg.getByLabelText(/Repository URL/)).toHaveFocus();
    await h.user.keyboard('git@github.com:acme/api.git{Enter}');

    // Two fields in one step: Enter goes to the next field first, then to the next step.
    expect(dlg.getByLabelText('Run a Remote Control service for this project')).toHaveFocus();
    await h.user.keyboard('{Enter}');
    expect(dlg.getByLabelText('Permission mode of its sessions')).toHaveFocus();
    await h.user.keyboard('{Enter}');
    expect(dlg.getByLabelText('Docker Compose')).toHaveFocus();
    await h.user.keyboard('{Enter}');

    expect(dlg.getByText('3000–3099')).toBeInTheDocument();
    await h.user.keyboard('{Enter}');
    // Reaching the review by clicking Next does not leave focus on the run button either.
    await h.user.click(dlg.getByRole('button', { name: 'Back' }));
    await h.user.click(dlg.getByRole('button', { name: 'Next' }));
    expect(dlg.getByRole('button', { name: 'Create environment' })).not.toHaveFocus();
    await h.user.keyboard('{Enter}');
    expect(h.transport.calls.some((c) => c[0] === 'env' && c[1] === 'create')).toBe(false);
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
    await h.user.click(screen.getByRole('button', { name: 'More actions for acme-api' }));
    // Placed next to the button (position: fixed), so the scrolling table does not clip it.
    expect(screen.getByRole('menu').style.top).toBe('4px');
    expect(screen.queryByRole('menuitem', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Logs' })).toBeInTheDocument();
  });

  it('groups the environments by account, in the order of the config', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('account', 'add', '--name', 'personal', '--git-email', 'me@example.com', '--no-login');
    await h.cli('env', 'create', '--account', 'personal', '--name', 'blog', '--no-rc');
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-web', '--no-rc');
    mount(h);
    await goto(h, 'Environments');
    const business = within(await screen.findByRole('region', { name: 'Environments of business' }));
    expect(business.getByText('2 environments')).toBeInTheDocument();
    expect(business.getByText('acme-api')).toBeInTheDocument();
    expect(business.getByText('acme-web')).toBeInTheDocument();
    const personal = within(screen.getByRole('region', { name: 'Environments of personal' }));
    expect(personal.getByText('blog')).toBeInTheDocument();
    expect(personal.queryByText('acme-api')).toBeNull();
    await waitFor(() => expect(screen.getAllByRole('region', { name: /^Environments of / }).map((r) => r.getAttribute('aria-label'))).toEqual(['Environments of business', 'Environments of personal']));
  });

  it('delete keeps the files by default; deleting files needs the typed name', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    mount(h);
    await goto(h, 'Environments');
    await envAction(h, 'acme-api', 'Delete…');
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
    await envAction(h, 'acme-api', 'Delete…');
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
    await envAction(h, 'acme-api', 'Restart');
    const alert = await screen.findByText(/needs you at a keyboard/, undefined, { timeout: 8000 });
    expect(alert.closest('.notice')).toHaveTextContent('sudo password');
    expect(alert.closest('.notice')).toHaveTextContent('never handles the password');
    await h.user.click(within(alert.closest('.notice') as HTMLElement).getByRole('button', { name: 'Open in Terminal' }));
    expect(h.transport.opened.at(-1)).toEqual({ terminal: { kind: 'devhost', args: ['env', 'restart', 'acme-api'] } });
  });

  it("▶ opens the environment's Remote Control link, in the account's web app when it has one", async () => {
    localStorage.clear();
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    mount(h);
    await goto(h, 'Environments');
    // No link logged yet: claude.ai/code in the browser.
    await h.user.click(await screen.findByRole('button', { name: 'Open Claude for acme-api' }));
    expect(h.transport.opened.at(-1)).toEqual({ url: 'https://claude.ai/code' });

    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(h.env.home, 'Library', 'Logs', 'devhost'), { recursive: true });
    await writeFile(join(h.env.home, 'Library', 'Logs', 'devhost', 'rc-business-acme-api.log'), 'Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_01Abc\n');
    h.transport.webAppsInstalled.add('Claude – business');
    await goto(h, 'Dashboard');
    await goto(h, 'Environments');
    await h.user.click(await screen.findByRole('button', { name: 'Open Claude for acme-api' }));
    await waitFor(() => expect(h.transport.opened.at(-1)).toEqual({ webApp: 'Claude – business', url: 'https://claude.ai/code?environment=env_01Abc' }));
  });

  it('a running setup shows an endless spinner (and the running step) until it is done', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(h.env.home, 'work', 'business', 'acme-api', 'compose.yaml'), 'services: { db: { image: postgres } }\n');
    const original = h.mac.runner.run.bind(h.mac.runner);
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    h.mac.runner.run = async (cmd, args, opts) => {
      if (cmd === 'docker' && args.includes('up')) await slow; // a slow `docker compose up`
      return original(cmd, args, opts);
    };
    mount(h);
    await goto(h, 'Environments');
    await envAction(h, 'acme-api', 'Run setup again');
    const dlg = within(await screen.findByRole('dialog', { name: 'Set up business/acme-api' }));
    expect(await dlg.findByRole('status')).toHaveTextContent(/Working on \S+… 0:0\d/);
    expect(dlg.getAllByRole('progressbar').map((e) => e.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Working', 'env.acme-api is running']));
    release();
    expect(await dlg.findByText('Done.', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(dlg.queryAllByRole('progressbar')).toEqual([]);
  });

  it('Run setup again repeats a failed setup; Try again continues it once the cause is fixed', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(h.env.home, 'work', 'business', 'acme-api', 'compose.yaml'), 'services: { db: { image: postgres } }\n');
    const original = h.mac.runner.run.bind(h.mac.runner);
    let broken = true;
    h.mac.runner.run = async (cmd, args, opts) =>
      broken && cmd === 'docker' && args.includes('up') ? { code: 1, stdout: '', stderr: 'Error response from daemon: network with name devhost-acme-api_default already exists\n' } : original(cmd, args, opts);
    mount(h);
    await goto(h, 'Environments');
    await envAction(h, 'acme-api', 'Run setup again');
    const dlg = within(await screen.findByRole('dialog', { name: 'Set up business/acme-api' }));
    expect(await dlg.findByText(/could not create the network "devhost-acme-api_default"/, undefined, { timeout: 8000 })).toBeInTheDocument();
    broken = false;
    await h.user.click(dlg.getByRole('button', { name: 'Try again' }));
    expect(await dlg.findByText('Done.', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(h.mac.state.composeUp.has('devhost-acme-api')).toBe(true);
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
    await envAction(h, 'acme-api', 'Logs');
    await waitFor(() => expect(screen.getByLabelText('Log')).toHaveTextContent('server started'));
  });
});

describe('accounts (spec B3.3, B6)', () => {
  it('new account wizard by keyboard: Enter walks the fields and steps, an invalid email stops it', async () => {
    const h = await makeHarness();
    mount(h);
    await goto(h, 'Accounts');
    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument();
    const dlg = await openWizard(h, 'New account');
    expect(dlg.getByLabelText('Account name')).toHaveFocus();
    await h.user.keyboard('business{Enter}');

    expect(dlg.getByLabelText('Git name (optional)')).toHaveFocus();
    await h.user.keyboard('Ada{Enter}');
    const email = dlg.getByLabelText('Git email');
    expect(email).toHaveFocus();
    await h.user.keyboard('not-an-email{Enter}');
    expect(email).toHaveFocus();
    await h.user.clear(email);
    await h.user.keyboard('ada@work.example{Enter}');

    expect(dlg.getByText(/Use Claude Code's default config directory/)).toBeInTheDocument();
    await h.user.keyboard('{Enter}');
    expect(dlg.getByLabelText(/Daily cost alert/)).toHaveFocus();
    await h.user.keyboard('{Enter}');
    expect(dlg.getByRole('button', { name: 'Add account and sign in' })).toBeInTheDocument();
    await h.user.keyboard('{Enter}');
    expect(h.transport.calls.some((c) => c[0] === 'account' && c[1] === 'add')).toBe(false);
  });

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

describe('account web apps', () => {
  it('set up: icon in the account color, Safari and Finder, then it checks the web app exists', async () => {
    const h = await makeHarness();
    await withBusiness(h);
    mount(h);
    await goto(h, 'Accounts');
    await h.user.click(await screen.findByRole('button', { name: 'Set up…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Web app for business' }));
    expect(dlg.getByRole('img', { name: 'Icon for business' }).getAttribute('src')).toContain(encodeURIComponent('>business</text>'));
    expect(dlg.getByText('Claude – business')).toBeInTheDocument();
    await h.user.click(dlg.getByRole('button', { name: 'Open Safari' }));
    await waitFor(() => expect(h.transport.webAppIcons.get('business')).toEqual(PNG));
    await h.user.click(await dlg.findByRole('button', { name: 'Done, check' }));
    expect(await dlg.findByRole('status')).toHaveTextContent('No web app named Claude – business');
    h.transport.webAppsInstalled.add('Claude – business');
    await h.user.click(dlg.getByRole('button', { name: 'Done, check' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await h.user.click(screen.getByRole('button', { name: 'Open' }));
    expect(h.transport.opened.at(-1)).toEqual({ webApp: 'Claude – business' });
  });

  it('a web app made earlier under another name can be picked for the account', async () => {
    localStorage.clear();
    const h = await makeHarness();
    await withBusiness(h);
    h.transport.webAppsInstalled.add('Claude - Work');
    mount(h);
    await goto(h, 'Accounts');
    await h.user.click(await screen.findByRole('button', { name: 'Set up…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Web app for business' }));
    expect(dlg.getByLabelText('Already have one?')).toHaveValue('Claude - Work');
    await h.user.click(dlg.getByRole('button', { name: 'Use this one' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await h.user.click(screen.getByRole('button', { name: 'Open' }));
    expect(h.transport.opened.at(-1)).toEqual({ webApp: 'Claude - Work' });
    // The choice is remembered.
    expect(JSON.parse(localStorage.getItem('devhost.webApps.v1')!)).toEqual({ business: 'Claude - Work' });
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
    await goto(h, 'Doctor');
    expect(await screen.findByText('account.business.login', undefined, { timeout: 8000 })).toBeInTheDocument();
    const item = screen.getByText('account.business.login').closest('.item') as HTMLElement;
    expect(item).toHaveTextContent('not logged in');
    expect(item).toHaveTextContent('devhost login business');
    expect(within(item).getByRole('button', { name: 'Copy fix' })).toBeInTheDocument();
    expect(screen.getByText(/\d+ failed/)).toBeInTheDocument();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(h.env.home, 'Library', 'Logs', 'devhost'), { recursive: true });
    await writeFile(join(h.env.home, 'Library', 'Logs', 'devhost', 'collector.log'), 'collector listening on 127.0.0.1:4318\n');
    await goto(h, 'Logs');
    await h.user.click(await screen.findByRole('button', { name: 'Collector' }));
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

describe('storage (spec B3.8)', () => {
  it('adopts an external volume, shows its state, moves an account onto it, and never offers to erase a disk', async () => {
    const { mountVolume } = await import('../../cli/test/helpers.js');
    const h = await makeHarness();
    await withBusiness(h);
    await h.cli('env', 'create', '--account', 'business', '--name', 'acme-api', '--no-rc');
    const volumes = join(h.env.home, 'Volumes');
    const v = { uuid: '6F1C2A44-9B3E-4C5D-8E7F-0123456789AB', name: 'devwork', device: 'disk5s1', mountPoint: null as string | null, ownership: true };
    h.mac.state.volumes = [v];
    mountVolume(volumes, v, true);
    mount(h);
    await goto(h, 'Storage');
    expect(await screen.findByText('No work volume')).toBeInTheDocument();
    const disks = within(await screen.findByRole('region', { name: 'External disks' }));
    expect(await disks.findByText('devwork')).toBeInTheDocument();
    expect(screen.queryByText(/erase|prepare/i, { selector: 'button' })).toBeNull();

    await h.user.click(disks.getByRole('button', { name: 'Use as work volume…' }));
    const adopt = within(await screen.findByRole('dialog', { name: 'Use devwork as the work volume' }));
    await adopt.findByRole('button', { name: 'Close' }, { timeout: 8000 });
    await h.user.click(adopt.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Work volume' })).toHaveTextContent(/devwork.*ready/), { timeout: 8000 });

    const accounts = within(await screen.findByRole('region', { name: 'Accounts and the volume' }));
    await h.user.click(await accounts.findByRole('button', { name: 'Move to the volume…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Move business to the volume' }));
    expect(dlg.getAllByText(/session history by project path/).length).toBeGreaterThan(0);
    const ask = await dlg.findByText(/Move business from/, undefined, { timeout: 8000 });
    await h.user.click(within(ask.closest('.prompt') as HTMLElement).getByRole('button', { name: 'Yes' }));
    await dlg.findByRole('button', { name: 'Close' }, { timeout: 15000 });
    expect(await readFile(join(h.env.home, '.config', 'devhost', 'config.yaml'), 'utf8')).toContain(`root: ${join(volumes, 'devwork', 'work', 'business')}`);
    await h.user.click(dlg.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('button', { name: 'Delete the old copy…' })).toBeInTheDocument();
  }, 40_000);
});
