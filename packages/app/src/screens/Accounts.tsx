import { useCallback, useState } from 'react';
import type { AccountListData, DashData, EnvListData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { accountAddArgs, type AccountAddInput } from '../client/client';
import { useHostQuery } from '../use-host-query';
import { errorMessage } from '../client/errors';
import { ago } from '../lib/format';
import { predictAccountRange, SLUG } from '../lib/ports';
import { Badge, CopyButton, Dialog, Empty, Field, WizardStep } from '../ui/primitives';
import { RunDialog } from '../ui/run-dialog';
import { rasterizeIcon, webAppIconSvg } from '../lib/webAppIcon';
import { defaultWebAppName, useWebApps } from '../use-web-apps';

type Account = AccountListData['accounts'][number];

export function Accounts() {
  const { client, transport } = useApp();
  const [dash, setDash] = useState<DashData | null>(null);
  const fetchAll = useCallback(async () => {
    const [a, e] = await Promise.all([client.accounts(), client.envs()]);
    void client.dash('1h').then(setDash).catch(() => undefined);
    return { accounts: a.accounts, envs: e.environments };
  }, [client]);
  const { data: loaded, error, refresh } = useHostQuery(fetchAll);
  const accounts: Account[] | null = loaded?.accounts ?? null;
  const envs: EnvListData['environments'] = loaded?.envs ?? [];
  const [dialog, setDialog] = useState<null | { kind: 'add' } | { kind: 'login'; account: Account } | { kind: 'remove'; account: Account } | { kind: 'web-app'; account: Account }>(null);
  const names = (accounts ?? []).map((a) => a.name);
  const webApps = useWebApps();

  return (
    <div className="content">
      <div className="row">
        <h1>Accounts</h1>
        <span style={{ marginLeft: 'auto' }}><button className="btn primary" onClick={() => setDialog({ kind: 'add' })}>New account</button></span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <section className="card">
        {accounts === null ? <Empty>Loading…</Empty> : accounts.length === 0 ? <Empty>No accounts yet. Add one to sign in with a claude.ai account.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Default</th><th>Login</th><th>Credentials</th><th>Last auth check</th><th>Port range</th><th className="num">Environments</th><th>Web app</th><th><span className="sr">Actions</span></th></tr></thead>
              <tbody>
                {accounts.map((a) => {
                  const mine = envs.filter((e) => e.account === a.name);
                  const checked = dash?.accounts.find((x) => x.name === a.name)?.lastAuthCheckAt;
                  return (
                    <tr key={a.name}>
                      <td><b>{a.name}</b><div className="note mono">{a.configDir ?? '~/.claude (default)'}</div></td>
                      <td>{a.default ? 'yes' : '–'}</td>
                      <td>{a.loggedIn === true ? <Badge tone="good">logged in</Badge> : a.loggedIn === false ? <Badge tone="bad">not logged in</Badge> : <Badge>unknown</Badge>}</td>
                      <td>{a.credentialStore === 'keychain' ? 'Keychain' : a.credentialStore === 'file' ? 'file' : '–'}</td>
                      <td>{checked ? ago(checked, Date.now()) : '–'}</td>
                      <td className="mono">{a.portRange[0]}–{a.portRange[1]}</td>
                      <td className="num">{a.environments}</td>
                      <td>
                        {(() => {
                          const app = webApps.appFor(a.name);
                          return app ? (
                            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }} title={app}>
                              <button className="btn sm" onClick={() => void transport.openWebApp(app)}>Open</button>
                              <button className="btn sm" onClick={() => setDialog({ kind: 'web-app', account: a })}>Change…</button>
                            </div>
                          ) : <button className="btn sm" onClick={() => setDialog({ kind: 'web-app', account: a })}>Set up…</button>;
                        })()}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <button className="btn sm" onClick={() => setDialog({ kind: 'login', account: a })}>{a.loggedIn ? 'Re-login' : 'Log in'}</button>
                          <button className="btn sm danger" disabled={mine.length > 0} title={mine.length > 0 ? `Remove its environments first: ${mine.map((e) => e.name).join(', ')}` : undefined} onClick={() => setDialog({ kind: 'remove', account: a })}>Remove…</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">Removing an account never deletes its projects, its Claude config directory or its credentials.</p>
      </section>

      {dialog?.kind === 'add' && <AddWizard accounts={accounts ?? []} onClose={() => { setDialog(null); void refresh(); }} />}
      {dialog?.kind === 'login' && (
        <RunDialog
          title={`Log in ${dialog.account.name}`}
          begin={(h) => client.login(dialog.account.name, h)}
          terminal={{ kind: 'devhost', args: ['login', dialog.account.name] }}
          onClose={() => { setDialog(null); void refresh(); }}
          after={(r) => <p className="note">{(r.data as { restarted?: string[] } | null)?.restarted?.length ? `Restarted: ${(r.data as { restarted: string[] }).restarted.join(', ')}.` : 'No environments to restart.'}</p>}
        >
          <p className="sec">devhost prints a sign-in URL. Open it in your browser, sign in as <b>{dialog.account.name}</b> and paste the code back here. Then it accepts workspace trust for the account's environments and restarts their services.</p>
        </RunDialog>
      )}
      {dialog?.kind === 'web-app' && (
        <WebAppSetup
          accounts={names}
          account={dialog.account.name}
          // A web app another account uses is not offered again.
          others={webApps.installed.filter((n) => !names.some((x) => x !== dialog.account.name && webApps.appFor(x) === n))}
          current={webApps.appFor(dialog.account.name)}
          onChoose={(n) => { webApps.choose(dialog.account.name, n); setDialog(null); }}
          recheck={webApps.refresh}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'remove' && <RemoveFlow account={dialog.account} onClose={() => { setDialog(null); void refresh(); }} />}
    </div>
  );
}

/**
 * A Safari web app per account keeps several claude.ai logins open side by side. Safari has no API
 * for "Add to Dock", so the app does the rest: the icon in the account's color, Safari on
 * claude.ai/code, the icon shown in Finder, then it checks that the web app exists. A web app made
 * earlier under another name can be picked instead.
 */
function WebAppSetup({ accounts, account, others, current, onChoose, recheck, onClose }: {
  accounts: string[];
  account: string;
  /** Web apps in ~/Applications that are free to take. */
  others: string[];
  current: string | null;
  onChoose: (name: string) => void;
  recheck: () => Promise<string[]>;
  onClose: () => void;
}) {
  const { transport } = useApp();
  const svg = webAppIconSvg(accounts, account);
  const name = defaultWebAppName(account);
  const [pick, setPick] = useState(current ?? others[0] ?? '');
  const [phase, setPhase] = useState<'intro' | 'busy' | 'started' | 'missing'>('intro');
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setPhase('busy');
    setError(null);
    try {
      await transport.setupWebApp(account, await rasterizeIcon(svg));
      setPhase('started');
    } catch (e) {
      setError(errorMessage(e));
      setPhase('intro');
    }
  };
  const check = async (): Promise<void> => {
    if ((await recheck()).includes(name)) onClose();
    else setPhase('missing');
  };

  return (
    <Dialog
      title={`Web app for ${account}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{phase === 'intro' ? 'Cancel' : 'Close'}</button>
          {phase === 'intro' || phase === 'busy'
            ? <button className="btn primary" disabled={phase === 'busy'} onClick={() => void start()}>Open Safari</button>
            : <button className="btn primary" onClick={() => void check()}>Done, check</button>}
        </>
      }
    >
      <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} width={96} height={96} alt={`Icon for ${account}`} />
        <p className="sec" style={{ margin: 0 }}>A Safari web app has its own cookies, so it stays signed in as <b>{account}</b> while other accounts use their own web apps or the Claude app.</p>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {others.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <Field label="Already have one?">{(id) => (
            <select id={id} className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
              {others.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}</Field>
          <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={pick === ''} onClick={() => onChoose(pick)}>Use this one</button>
        </div>
      )}
      <ol className="sec" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
        <li><b>Open Safari</b> below: it opens claude.ai/code and shows the icon in Finder.</li>
        <li>In Safari: <b>File → Add to Dock…</b></li>
        <li>Name: <span className="mono">{name}</span> <CopyButton text={name} /></li>
        <li>Drag the icon from Finder onto the icon in Safari's dialog, then <b>Add</b>.</li>
        <li>Sign in to claude.ai in the new web app as <b>{account}</b>.</li>
      </ol>
      {phase === 'missing' && <div className="notice" role="status">No web app named <span className="mono">{name}</span> in ~/Applications yet. Check the name in Safari's dialog, it has to match exactly.</div>}
    </Dialog>
  );
}

function RemoveFlow({ account, onClose }: { account: Account; onClose: () => void }) {
  const { client } = useApp();
  const [logout, setLogout] = useState(false);
  const [go, setGo] = useState(false);
  if (go) {
    return <RunDialog title={`Remove ${account.name}`} begin={(h) => client.accountRemove(account.name, logout, h)} terminal={{ kind: 'devhost', args: ['account', 'remove', account.name, ...(logout ? ['--logout'] : [])] }} onClose={onClose} />;
  }
  return (
    <Dialog
      title={`Remove account ${account.name}?`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" onClick={() => setGo(true)}>Remove account</button></>}
    >
      <p>devhost forgets this account: it removes its config entry, the direnv file, the git identity and the settings keys devhost added.</p>
      <div className="notice"><b>Stays on disk:</b> projects under <span className="mono">{account.root}</span>, the Claude config directory <span className="mono">{account.configDir ?? '~/.claude'}</span> and the credentials.</div>
      <label className="check"><input type="checkbox" checked={logout} onChange={(e) => setLogout(e.target.checked)} /> Also sign out (<span className="mono">claude auth logout</span>)</label>
    </Dialog>
  );
}

const ADD_STEPS = ['Name', 'Git identity', 'Default', 'Cost alert', 'Review'];

/** name → git name/email → default or not → daily cost alert → review → `devhost account add` with its login (spec B3.3). */
function AddWizard({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const { client } = useApp();
  const [step, setStep] = useState(0);
  const [d, setD] = useState({ name: '', gitName: '', gitEmail: '', isDefault: false, alert: '' });
  const [run, setRun] = useState(false);
  const hasDefault = accounts.some((a) => a.default);
  const range = predictAccountRange(accounts.map((a) => a.portRange));
  const nameError = d.name === '' ? null : !SLUG.test(d.name) ? 'Lowercase letters, digits and dashes, starting with a letter.' : accounts.some((a) => a.name === d.name) ? 'This account already exists.' : null;
  const emailOk = /^\S+@\S+\.\S+$/.test(d.gitEmail);
  const alertNum = d.alert === '' ? undefined : Number(d.alert);
  const alertOk = d.alert === '' || (Number.isFinite(alertNum) && alertNum! >= 0);
  const canNext = step === 0 ? d.name !== '' && !nameError : step === 1 ? emailOk : step === 3 ? alertOk : true;

  if (run) {
    const input: AccountAddInput = { name: d.name, gitEmail: d.gitEmail, gitName: d.gitName || undefined, isDefault: d.isDefault, dailyCostAlert: alertNum };
    return (
      <RunDialog
        title={`Add account ${d.name}`}
        begin={(h) => client.accountAdd(input, h)}
        terminal={{ kind: 'devhost', args: accountAddArgs(input) }}
        onClose={onClose}
      >
        <p className="sec">devhost sets the account up, then continues straight into the sign-in: open the URL it shows and paste the code back.</p>
      </RunDialog>
    );
  }

  return (
    <Dialog
      title="New account"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Back</button>}
          {/* Distinct keys: a focused Next must not turn into the run button, where Enter would start it. */}
          {step < ADD_STEPS.length - 1 ? <button key="next" className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button> : <button key="run" className="btn primary" onClick={() => setRun(true)}>Add account and sign in</button>}
        </>
      }
    >
      <div className="steps" aria-label="Steps">{ADD_STEPS.map((s, i) => (i === step ? <b key={s}>{i + 1}. {s}</b> : <span key={s}>{i + 1}. {s}</span>))}</div>
      <WizardStep step={step} canNext={canNext && step < ADD_STEPS.length - 1} onNext={() => setStep(step + 1)}>
      {step === 0 && <Field label="Account name" hint="For example personal or business." error={nameError}>{(id) => <input id={id} className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} aria-invalid={!!nameError} autoComplete="off" spellCheck={false} />}</Field>}
      {step === 1 && (
        <>
          <Field label="Git name (optional)">{(id) => <input id={id} className="input" value={d.gitName} onChange={(e) => setD({ ...d, gitName: e.target.value })} />}</Field>
          <Field label="Git email" hint="Used for commits in repositories under this account's root." error={d.gitEmail !== '' && !emailOk ? 'Enter an email address.' : null}>{(id) => <input id={id} className="input" type="email" value={d.gitEmail} onChange={(e) => setD({ ...d, gitEmail: e.target.value })} autoComplete="off" />}</Field>
        </>
      )}
      {step === 2 && (
        <>
          <label className="check"><input type="checkbox" disabled={hasDefault} checked={d.isDefault} onChange={(e) => setD({ ...d, isDefault: e.target.checked })} /> Use Claude Code's default config directory (<span className="mono">~/.claude</span>)</label>
          <p className="note">{hasDefault ? 'Another account already is the default; only one can be.' : 'Only one account can be the default. Others get their own directory.'}</p>
        </>
      )}
      {step === 3 && <Field label="Daily cost alert in USD (optional)" hint="An estimate: you get a notification when the day's API-equivalent cost passes it." error={alertOk ? null : 'Enter a number.'}>{(id) => <input id={id} className="input" inputMode="decimal" value={d.alert} onChange={(e) => setD({ ...d, alert: e.target.value })} />}</Field>}
      {step === 4 && (
        <dl style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: '6px 12px', margin: 0 }}>
          <dt className="muted">Account</dt><dd>{d.name}</dd>
          <dt className="muted">Config directory</dt><dd className="mono">{d.isDefault ? '~/.claude (default, CLAUDE_CONFIG_DIR unset)' : `~/.claude-${d.name}`}</dd>
          <dt className="muted">Root</dt><dd className="mono">~/work/{d.name}</dd>
          <dt className="muted">Port range</dt><dd className="mono">{range[0]}–{range[1]}</dd>
          <dt className="muted">Git identity</dt><dd>{d.gitName ? `${d.gitName} ` : ''}&lt;{d.gitEmail}&gt;</dd>
          <dt className="muted">Cost alert</dt><dd>{d.alert === '' ? 'none' : `$${d.alert} per day`}</dd>
        </dl>
      )}
      </WizardStep>
    </Dialog>
  );
}
