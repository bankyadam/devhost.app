import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { schemas, type ApplyData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { OperationView, useOperation } from '../ui/operation';
import { Badge, Dialog, Empty } from '../ui/primitives';
import { SchemaForm, type JsonSchema } from '../ui/schema-form';

const schema = schemas.config as unknown as JsonSchema;

export function Configuration() {
  const { client, connection, reportUnreachable } = useApp();
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [tab, setTab] = useState<'form' | 'yaml'>('form');
  const [validity, setValidity] = useState<{ checking: boolean; valid: boolean; issues: { message: string; path?: string }[] }>({ checking: false, valid: true, issues: [] });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applyFlow, setApplyFlow] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    try {
      const raw = await client.configRaw();
      setSaved(raw.text);
      setText(raw.text);
      setError(null);
    } catch (e) {
      reportUnreachable(e);
      setError(errorMessage(e));
    }
  }, [client, reportUnreachable]);

  useEffect(() => {
    if (connection.kind === 'connected') void load();
  }, [connection.kind, load]);

  // Live validation by the CLI on the Mac mini: schema and cross-field rules, the same ones `apply` enforces.
  useEffect(() => {
    if (saved === null) return;
    const mine = ++seq.current;
    setValidity((v) => ({ ...v, checking: true }));
    const t = setTimeout(() => {
      client.validateConfig(text).then(
        (r) => mine === seq.current && setValidity({ checking: false, valid: r.valid, issues: r.issues }),
        (e) => {
          if (mine !== seq.current) return;
          reportUnreachable(e);
          setValidity({ checking: false, valid: false, issues: [{ message: errorMessage(e) }] });
        },
      );
    }, 350);
    return () => clearTimeout(t);
  }, [client, text, saved, reportUnreachable]);

  const issuesByPointer = useMemo(() => {
    const m: Record<string, string> = {};
    for (const i of validity.issues) if (i.path) m[i.path] = i.message.replace(/^[^:]*: /, '');
    return m;
  }, [validity.issues]);

  const dirty = saved !== null && text !== saved;
  const canSave = dirty && validity.valid && !validity.checking && !saving;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await client.putConfig(text);
      setSaved(text);
      setError(null);
      setApplyFlow(true);
    } catch (e) {
      reportUnreachable(e);
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (saved === null) return <div className="content"><h1>Configuration</h1><Empty>{error ?? 'Loading the config from the Mac mini…'}</Empty></div>;

  return (
    <div className="content">
      <div className="row">
        <h1>Configuration</h1>
        {validity.checking ? <Badge>checking…</Badge> : validity.valid ? <Badge tone="good">valid</Badge> : <Badge tone="bad">{validity.issues.length} problem{validity.issues.length === 1 ? '' : 's'}</Badge>}
        {dirty && <Badge tone="warn">unsaved changes</Badge>}
        <span style={{ marginLeft: 'auto' }} className="row">
          <button className="btn" disabled={!dirty} onClick={() => setText(saved)}>Revert</button>
          <button className="btn" onClick={() => setApplyFlow(true)}>Review and apply…</button>
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>Save</button>
        </span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      {!validity.valid && !validity.checking && (
        <div className="notice bad" role="alert" aria-label="Problems">
          {validity.issues.map((i, k) => <div key={k}>{i.message}</div>)}
          <div className="note">An invalid config cannot be saved.</div>
        </div>
      )}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'form'} onClick={() => setTab('form')}>Form</button>
        <button role="tab" aria-selected={tab === 'yaml'} onClick={() => setTab('yaml')}>YAML</button>
      </div>
      {tab === 'form' ? (
        <SchemaForm
          root={schema}
          text={text}
          onText={setText}
          issues={issuesByPointer}
          skip={['accounts', 'environments']}
          summaries={{ accounts: 'Add and remove accounts on the Accounts screen.', environments: 'Create and delete environments on the Environments screen.' }}
        />
      ) : (
        <textarea className="textarea" rows={32} spellCheck={false} aria-label="Config YAML" aria-invalid={!validity.valid && !validity.checking} value={text} onChange={(e) => setText(e.target.value)} />
      )}
      <p className="note">Saving only writes the file (a backup is kept on the Mac mini). Nothing changes on the machine until you apply.</p>
      {applyFlow && <ApplyFlow onClose={() => setApplyFlow(false)} />}
    </div>
  );
}

/** save → `apply --dry-run` → the plan as a diff (what changes, which steps need sudo) → confirm → `apply` with live progress (spec B3.4). */
function ApplyFlow({ onClose }: { onClose: () => void }) {
  const { client, transport } = useApp();
  const review = useOperation<ApplyData>();
  const real = useOperation<ApplyData>();
  const [stage, setStage] = useState<'review' | 'run'>('review');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void review.start((h) => client.apply(true, h));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = review.state.result?.data ?? null;
  const sudoSteps = plan ? [...new Set(plan.plan.filter((p) => p.sudo).map((p) => p.stepId))] : [];
  const changed = plan?.steps.filter((s) => s.status === 'changed') ?? [];
  const terminal = { kind: 'devhost' as const, args: ['apply'] };

  if (stage === 'run') {
    const running = real.state.phase === 'running';
    return (
      <Dialog title="Applying" wide footer={running ? <button className="btn" onClick={real.cancel}>Cancel</button> : <button className="btn primary" onClick={onClose}>Close</button>}>
        <OperationView op={real} terminal={terminal} />
        {real.state.result?.data?.warnings?.map((w) => <div className="notice" key={w}>{w}</div>)}
      </Dialog>
    );
  }

  const reviewing = review.state.phase === 'running';
  return (
    <Dialog
      title="Review before applying"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Not now</button>
          {sudoSteps.length > 0 && <button className="btn" onClick={() => void transport.openTerminal(terminal)}>Apply in Terminal</button>}
          <button className="btn primary" disabled={reviewing || !plan} onClick={() => { setStage('run'); void real.start((h) => client.apply(false, h)); }}>{changed.length === 0 && plan ? 'Apply anyway' : 'Apply'}</button>
        </>
      }
    >
      {reviewing && <p className="sec">Asking the Mac mini what would change…</p>}
      <OperationView op={review} terminal={terminal} />
      {plan && (
        <>
          {changed.length === 0 ? (
            <p className="sec">The machine already matches the config: no changes.</p>
          ) : (
            <div>
              <h3>What would change</h3>
              <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
                {changed.map((s) => <li key={s.id}><span className="mono">{s.id}</span> <span className="sec">{(s.message ?? '').replace(/^would change: /, '')}</span></li>)}
              </ul>
            </div>
          )}
          {plan.plan.length > 0 && (
            <div>
              <h3>Commands and file changes</h3>
              <div className="plan" aria-label="Plan">
                {plan.plan.map((p, i) => (
                  <div key={i}>{p.sudo && <span className="sudo">[sudo] </span>}<span className="muted">{p.stepId}:</span> {p.action.replace(/^sudo /, '')}</div>
                ))}
              </div>
            </div>
          )}
          {sudoSteps.length > 0 && (
            <div className="notice">
              <b>These steps need the sudo password:</b> <span className="mono">{sudoSteps.join(', ')}</span>.
              <div className="note">The password is typed in a Terminal window the app opens (<b>Apply in Terminal</b>); the app never sees it. If you press Apply here and no password can be asked, devhost stops with exit code 3 and offers the same Terminal window.</div>
            </div>
          )}
          {plan.warnings?.map((w) => <div className="notice" key={w}>{w}</div>)}
        </>
      )}
    </Dialog>
  );
}
