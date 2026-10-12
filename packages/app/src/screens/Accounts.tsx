import { useCallback, useEffect, useState } from 'react';
import type { AccountListData, DashData, EnvListData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { ago } from '../lib/format';
import { predictAccountRange, SLUG } from '../lib/ports';
import { Badge, Dialog, Empty, Field } from '../ui/primitives';
import { RunDialog } from '../ui/run-dialog';

type Account = AccountListData['accounts'][number];

export function Accounts() {
  const { client, connection, reportUnreachable } = useApp();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [envs, setEnvs] = useState<EnvListData['environments']>([]);
  const [dash, setDash] = useState<DashData | null>(null);
  const [stores, setStores] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'add' } | { kind: 'login'; account: Account } | { kind: 'remove'; account: Account }>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, e] = await Promise.all([client.accounts(), client.envs()]);
      setAccounts(a.accounts);
      setEnvs(e.environments);
      setError(null);
      void client.dash('1h').then(setDash).catch(() => undefined);
    } catch (e) {
      reportUnreachable(e);
      setError(errorMessage(e));
    }
  }, [client, reportUnreachable]);

  useEffect(() => {
    if (connection.kind !== 'connected') return;
    void refresh();
    // The credential store (Keychain or file) is part of the doctor checks.
    void client.doctor().then((d) => {
      const m: Record<string, string> = {};
      for (const c of d.checks) {
        const hit = /^account\.(.+)\.credentials$/.exec(c.id);
        if (hit) m[hit[1]!] = c.status === 'ok' ? 'Keychain' : 'file';
      }
      setStores(m);
    }).catch(() => undefined);
  }, [client, connection.kind, refresh]);

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
              <thead><tr><th>Account</th><th>Default</th><th>Login</th><th>Credentials</th><th>Last auth check</th><th>Port range</th><th className="num">Environments</th><th><span className="sr">Actions</span></th></tr></thead>
              <tbody>
                {accounts.map((a) => {
                  const mine = envs.filter((e) => e.account === a.name);
                  const checked = dash?.accounts.find((x) => x.name === a.name)?.lastAuthCheckAt;
                  return (
                    <tr key={a.name}>
                      <td><b>{a.name}</b><div className="note mono">{a.configDir ?? '~/.claude (default)'}</div></td>
                      <td>{a.default ? 'yes' : '–'}</td>
                      <td>{a.loggedIn === true ? <Badge tone="good">logged in</Badge> : a.loggedIn === false ? <Badge tone="bad">not logged in</Badge> : <Badge>unknown</Badge>}</td>
                      <td>{stores[a.name] ?? '–'}</td>
                      <td>{checked ? ago(checked, Date.now()) : '–'}</td>
                      <td className="mono">{a.portRange[0]}–{a.portRange[1]}</td>
                      <td className="num">{a.environments}</td>
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
      {dialog?.kind === 'remove' && <RemoveFlow account={dialog.account} onClose={() => { setDialog(null); void refresh(); }} />}
    </div>
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
    return (
      <RunDialog
        title={`Add account ${d.name}`}
        begin={(h) => client.accountAdd({ name: d.name, gitEmail: d.gitEmail, gitName: d.gitName || undefined, isDefault: d.isDefault, dailyCostAlert: alertNum }, h)}
        terminal={{ kind: 'devhost', args: ['account', 'add', '--name', d.name, '--git-email', d.gitEmail, ...(d.isDefault ? ['--default'] : [])] }}
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
          {step < ADD_STEPS.length - 1 ? <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button> : <button className="btn primary" onClick={() => setRun(true)}>Add account and sign in</button>}
        </>
      }
    >
      <div className="steps" aria-label="Steps">{ADD_STEPS.map((s, i) => (i === step ? <b key={s}>{i + 1}. {s}</b> : <span key={s}>{i + 1}. {s}</span>))}</div>
      {step === 0 && <Field label="Account name" hint="For example personal or business." error={nameError}>{(id) => <input id={id} className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} aria-invalid={!!nameError} autoFocus autoComplete="off" spellCheck={false} />}</Field>}
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
    </Dialog>
  );
}
