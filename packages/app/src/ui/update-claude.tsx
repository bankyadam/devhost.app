import { useState } from 'react';
import type { UpdateData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { ConfirmDialog } from './primitives';
import { RunDialog } from './run-dialog';

/**
 * Update Claude Code on the host from the app (`devhost update`): confirm, run it live, and when
 * sessions are in the middle of a turn offer to interrupt them (`--force`; they are reattached).
 */
export function UpdateClaude({ latest, onClose }: { latest: string | null; onClose: () => void }) {
  const { client, hostName } = useApp();
  const [step, setStep] = useState<'confirm' | 'run' | 'force'>('confirm');
  if (step === 'confirm') {
    return (
      <ConfirmDialog title="Update Claude Code" confirmLabel="Update" onConfirm={() => setStep('run')} onCancel={onClose}>
        <p>Updates Claude Code on {hostName} to {latest ?? 'the latest version'}, restarts every Remote Control service onto it, and reattaches the sessions they had open.</p>
        <p className="note">If a session is in the middle of a turn, the update waits; you can then choose to interrupt it.</p>
      </ConfirmDialog>
    );
  }
  const force = step === 'force';
  return (
    <RunDialog<UpdateData>
      key={step}
      title="Update Claude Code"
      begin={(h) => client.update({ force }, h)}
      terminal={{ kind: 'devhost', args: ['update', ...(force ? ['--force'] : [])] }}
      onClose={onClose}
      after={(r) => r.data?.busy?.length ? (
        <div className="notice warn">
          <p>{r.data.busy.length} session(s) are in the middle of a turn: {r.data.busy.join(', ')}.</p>
          <button className="btn danger" onClick={() => setStep('force')}>Interrupt them and update</button>
        </div>
      ) : r.data?.reattached?.length ? <ul className="note">{r.data.reattached.map((x) => <li key={x.remoteSession}>{x.ok ? '✅' : '❌'} {x.account}/{x.env} · {x.remoteSession}{x.error ? `: ${x.error}` : ''}</li>)}</ul> : null}
    >
      <p className="sec">Claude Code is upgraded, then the Remote Control services restart onto it and their open sessions are reattached.</p>
    </RunDialog>
  );
}
