import { useCallback, useEffect, useState } from 'react';
import type { AccountListData, EnvListData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { ENV_SLUG, predictEnvBlock } from '../lib/ports';
import { Badge, Dialog, Empty, Field } from '../ui/primitives';
import { RunDialog } from '../ui/run-dialog';

type Env = EnvListData['environments'][number];

export function Environments() {
  const { client, connection, reportUnreachable } = useApp();
  const [envs, setEnvs] = useState<Env[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'create' } | { kind: 'service'; env: Env; action: 'start' | 'stop' | 'restart' } | { kind: 'delete'; env: Env } | { kind: 'logs'; env: Env }>(null);

  const refresh = useCallback(async () => {
    try {
      setEnvs((await client.envs()).environments);
      setError(null);
    } catch (e) {
      reportUnreachable(e);
      setError(errorMessage(e));
    }
  }, [client, reportUnreachable]);

  useEffect(() => {
    if (connection.kind !== 'connected') return;
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [connection.kind, refresh]);

  return (
    <div className="content">
      <div className="row">
        <h1>Environments</h1>
        <span className="push" style={{ marginLeft: 'auto' }}><button className="btn primary" onClick={() => setDialog({ kind: 'create' })}>New environment</button></span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <section className="card">
        {envs === null ? <Empty>Loading…</Empty> : envs.length === 0 ? <Empty>No environments yet. Create one to get a project with its own Remote Control session.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Environment</th><th>Remote Control service</th><th>Port block</th><th>Compose</th><th>Directory</th><th><span className="sr">Actions</span></th></tr></thead>
              <tbody>
                {envs.map((e) => (
                  <tr key={e.name}>
                    <td><b>{e.name}</b> <span className="muted">{e.account}</span></td>
                    <td>{e.service.state === 'running' ? <Badge tone="good">running{e.service.pid ? ` · pid ${e.service.pid}` : ''}</Badge> : e.service.state === 'stopped' ? <Badge tone="bad">stopped</Badge> : e.service.state === 'not-installed' ? <Badge tone="warn">not installed</Badge> : <Badge>off</Badge>}</td>
                    <td className="mono">{e.portBase === null ? '–' : `${e.portBase}–${e.portBase + 99}`}</td>
                    <td>{e.compose}</td>
                    <td className="mono small" title={e.dir}>{e.dir}{e.dirExists === false && <> <Badge tone="bad">missing</Badge></>}</td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        {e.remoteControl.enabled && (
                          <>
                            <button className="btn sm" disabled={e.service.state === 'running'} onClick={() => setDialog({ kind: 'service', env: e, action: 'start' })}>Start</button>
                            <button className="btn sm" disabled={e.service.state !== 'running'} onClick={() => setDialog({ kind: 'service', env: e, action: 'stop' })}>Stop</button>
                            <button className="btn sm" onClick={() => setDialog({ kind: 'service', env: e, action: 'restart' })}>Restart</button>
                          </>
                        )}
                        <button className="btn sm" onClick={() => setDialog({ kind: 'logs', env: e })}>Logs</button>
                        <button className="btn sm danger" onClick={() => setDialog({ kind: 'delete', env: e })}>Delete…</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">Start, stop and restart change a system service, so they need the sudo password; if it cannot be asked here you get a Terminal window for it. A stopped service stays stopped until you start it or the Mac mini reboots.</p>
      </section>

      {dialog?.kind === 'create' && <CreateWizard onClose={() => { setDialog(null); void refresh(); }} />}
      {dialog?.kind === 'service' && (
        <RunDialog
          title={`${dialog.action[0]!.toUpperCase()}${dialog.action.slice(1)} ${dialog.env.name}`}
          begin={(h) => client.envService(dialog.env.name, dialog.action, h)}
          terminal={{ kind: 'devhost', args: ['env', dialog.action, dialog.env.name] }}
          onClose={() => { setDialog(null); void refresh(); }}
          onFinished={() => void refresh()}
        />
      )}
      {dialog?.kind === 'delete' && <DeleteFlow env={dialog.env} onClose={() => { setDialog(null); void refresh(); }} />}
      {dialog?.kind === 'logs' && <LogViewer title={`${dialog.env.name} · Remote Control log`} load={() => client.envLogs(dialog.env.name, 300).then((l) => l.lines)} onClose={() => setDialog(null)} />}
    </div>
  );
}

function DeleteFlow({ env, onClose }: { env: Env; onClose: () => void }) {
  const { client } = useApp();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [go, setGo] = useState(false);
  if (go) {
    return (
      <RunDialog
        title={`Delete ${env.name}`}
        begin={(h) => client.envDelete(env.name, deleteFiles, h)}
        terminal={{ kind: 'devhost', args: ['env', 'delete', env.name, ...(deleteFiles ? ['--delete-files'] : [])] }}
        onClose={onClose}
      />
    );
  }
  return (
    <Dialog
      title={`Delete ${env.name}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={() => setGo(true)}>{deleteFiles ? 'Review and delete…' : 'Stop and remove'}</button>
        </>
      }
    >
      <p>This stops its Remote Control service, takes down its compose services and removes it from the config.</p>
      <p className="sec small mono">{env.dir}</p>
      <label className="check">
        <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
        Also delete the project files
      </label>
      {deleteFiles ? (
        <div className="notice bad">devhost first lists unpushed commits and uncommitted changes, then asks you to type <b>{env.name}</b>. Deleted files cannot be recovered.</div>
      ) : (
        <p className="note">The files stay on disk. Nothing is deleted unless you tick the box.</p>
      )}
    </Dialog>
  );
}

export function LogViewer({ title, load, onClose }: { title: string; load: () => Promise<string[]>; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const refresh = useCallback(() => {
    load().then((l) => { setLines(l); setError(null); }, (e) => setError(errorMessage(e)));
  }, [load]);
  useEffect(() => {
    refresh();
    if (!follow) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh, follow]);
  return (
    <Dialog title={title} wide onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Close</button>}>
      <div className="row">
        <button className="btn sm" onClick={refresh}>Refresh</button>
        <label className="check small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Update every 3 s</label>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <pre className="logview" aria-label="Log">{lines === null ? 'Loading…' : lines.length === 0 ? '(empty)' : lines.join('\n')}</pre>
    </Dialog>
  );
}

type Draft = { account: string; name: string; repo: string; rc: boolean; permissionMode: string; compose: 'auto' | 'off' };
const STEPS = ['Account', 'Name', 'Repository', 'Remote Control', 'Compose', 'Review'];

/** account → name → repo URL → Remote Control + permission mode → compose → review → live `devhost env create` (spec B3.2). */
function CreateWizard({ onClose }: { onClose: () => void }) {
  const { client } = useApp();
  const [step, setStep] = useState(0);
  const [accounts, setAccounts] = useState<AccountListData['accounts']>([]);
  const [envs, setEnvs] = useState<Env[]>([]);
  const [collectorPort, setCollectorPort] = useState(4318);
  const [d, setD] = useState<Draft>({ account: '', name: '', repo: '', rc: true, permissionMode: 'acceptEdits', compose: 'auto' });
  const [run, setRun] = useState(false);

  useEffect(() => {
    void client.accounts().then((a) => { setAccounts(a.accounts); setD((x) => ({ ...x, account: x.account || a.accounts[0]?.name || '' })); }).catch(() => undefined);
    void client.envs().then((e) => setEnvs(e.environments)).catch(() => undefined);
    void client.configGet().then((c) => setCollectorPort(c.collector?.port ?? 4318)).catch(() => undefined);
  }, [client]);

  const account = accounts.find((a) => a.name === d.account);
  const nameTaken = envs.some((e) => e.name === d.name);
  const block = account ? predictEnvBlock(account.portRange, envs.filter((e) => e.account === account.name).flatMap((e) => (e.portBase === null ? [] : [e.portBase])), collectorPort) : null;
  const nameError = d.name === '' ? null : !ENV_SLUG.test(d.name) ? 'Lowercase letters, digits and dashes, starting with a letter.' : nameTaken ? 'An environment with this name already exists.' : null;
  const canNext = step === 0 ? !!account : step === 1 ? d.name !== '' && !nameError : true;

  if (run) {
    return (
      <RunDialog
        title={`Create ${d.account}/${d.name}`}
        begin={(h) => client.envCreate({ account: d.account, name: d.name, repo: d.repo || undefined, remoteControl: d.rc, permissionMode: d.permissionMode, compose: d.compose }, h)}
        terminal={{ kind: 'devhost', args: ['env', 'create', '--account', d.account, '--name', d.name, ...(d.repo ? ['--repo', d.repo] : []), ...(d.rc ? [] : ['--no-rc'])] }}
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog
      title="New environment"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Back</button>}
          {step < STEPS.length - 1 ? <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button> : <button className="btn primary" onClick={() => setRun(true)}>Create environment</button>}
        </>
      }
    >
      <div className="steps" aria-label="Steps">{STEPS.map((s, i) => (i === step ? <b key={s}>{i + 1}. {s}</b> : <span key={s}>{i + 1}. {s}</span>))}</div>
      {step === 0 && (
        accounts.length === 0 ? <div className="notice">There is no account yet. Add one on the Accounts screen first.</div> : (
          <Field label="Account" hint="The environment lives under this account's root and uses its Claude login.">
            {(id) => <select id={id} className="select" value={d.account} onChange={(e) => setD({ ...d, account: e.target.value })}>{accounts.map((a) => <option key={a.name} value={a.name}>{a.name}{a.loggedIn === false ? ' (not logged in)' : ''}</option>)}</select>}
          </Field>
        )
      )}
      {step === 1 && <Field label="Name" hint="Used for the directory, the service and the compose project." error={nameError}>{(id) => <input id={id} className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} aria-invalid={!!nameError} autoFocus autoComplete="off" spellCheck={false} />}</Field>}
      {step === 2 && <Field label="Repository URL (optional)" hint="Leave empty to start with a new git repository.">{(id) => <input id={id} className="input" value={d.repo} placeholder="git@github.com:owner/repo.git" onChange={(e) => setD({ ...d, repo: e.target.value })} autoComplete="off" spellCheck={false} />}</Field>}
      {step === 3 && (
        <>
          <label className="check"><input type="checkbox" checked={d.rc} onChange={(e) => setD({ ...d, rc: e.target.checked })} /> Run a Remote Control service for this project</label>
          <Field label="Permission mode of its sessions">
            {(id) => <select id={id} className="select" disabled={!d.rc} value={d.permissionMode} onChange={(e) => setD({ ...d, permissionMode: e.target.value })}>{['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'].map((m) => <option key={m}>{m}</option>)}</select>}
          </Field>
        </>
      )}
      {step === 4 && <Field label="Docker Compose" hint="auto starts the project's compose services when it has a compose file.">{(id) => <select id={id} className="select" value={d.compose} onChange={(e) => setD({ ...d, compose: e.target.value as 'auto' | 'off' })}><option value="auto">auto</option><option value="off">off</option></select>}</Field>}
      {step === 5 && account && (
        <dl className="review" style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: '6px 12px', margin: 0 }}>
          <dt className="muted">Account</dt><dd>{d.account}</dd>
          <dt className="muted">Directory</dt><dd className="mono">{account.root}/{d.name}</dd>
          <dt className="muted">Repository</dt><dd>{d.repo || 'new git repository'}</dd>
          <dt className="muted">Port block</dt><dd className="mono">{block === null ? 'none free in this account' : `${block}–${block + 99}`} <span className="muted">(allocated for real by devhost)</span></dd>
          <dt className="muted">Remote Control</dt><dd>{d.rc ? `service com.devhost.rc.${d.account}.${d.name}, ${d.permissionMode}` : 'off'}</dd>
          <dt className="muted">Compose</dt><dd>{d.compose} (project devhost-{d.name})</dd>
          <dt className="muted">Log</dt><dd className="mono">~/Library/Logs/devhost/rc-{d.account}-{d.name}.log</dd>
        </dl>
      )}
    </Dialog>
  );
}
