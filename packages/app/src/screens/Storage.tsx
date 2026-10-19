import { useCallback, useEffect, useState } from 'react';
import type { AccountListData, StorageChangeData, StorageListData, StorageStatusData } from '@devhost/contract/lite';
import { useApp } from '../app-context';
import { errorMessage } from '../client/errors';
import { bytes } from '../lib/format';
import { Badge, Empty } from '../ui/primitives';
import { RunDialog } from '../ui/run-dialog';

type Volume = NonNullable<StorageStatusData['volume']>;
const yes = (b: boolean | null | undefined, on: string, off: string) => (b == null ? <Badge>unknown</Badge> : b ? <Badge tone="good">{on}</Badge> : <Badge tone="bad">{off}</Badge>);

/**
 * The external work volume (spec B3.8): its state, adopting an existing APFS volume, moving an
 * account onto it, and removing the old copy afterwards. Erasing a disk is not here: it is CLI only.
 */
export function StorageScreen() {
  const { client, connection, hostName, reportUnreachable } = useApp();
  const [status, setStatus] = useState<StorageStatusData | null>(null);
  const [disks, setDisks] = useState<StorageListData['disks']>([]);
  const [accounts, setAccounts] = useState<AccountListData['accounts']>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'adopt'; volume: string; name: string } | { kind: 'migrate'; account: string; cleanup: boolean }>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, l, a] = await Promise.all([client.storageStatus(), client.storageList(), client.accounts()]);
      setStatus(s);
      setDisks(l.disks);
      setAccounts(a.accounts);
      setError(null);
    } catch (e) {
      reportUnreachable(e);
      setError(errorMessage(e));
    }
  }, [client, reportUnreachable]);
  useEffect(() => {
    if (connection.kind === 'connected') void refresh();
  }, [connection.kind, refresh]);

  const v = status?.volume;
  const offVolume = v ? accounts.filter((a) => !(a.root === v.mountPoint || a.root.startsWith(`${v.mountPoint}/`))) : [];
  return (
    <div className="content">
      <div className="row">
        <h1>Storage</h1>
        <span style={{ marginLeft: 'auto' }}><button className="btn" onClick={() => void refresh()}>Check again</button></span>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <p className="sec">An external SSD on {hostName} can hold the project data (account roots, environments, worktrees, node_modules); the system, Claude config, credentials and logs stay on the internal disk.</p>

      {!status ? <section className="card"><Empty>Loading…</Empty></section> : v ? <VolumeCard v={v} /> : (
        <section className="card" aria-label="Work volume">
          <header><h2>No work volume</h2></header>
          <p className="note">Everything is on the internal disk. Adopt an external APFS volume below. To erase a new disk as APFS, run <code>devhost storage prepare &lt;disk&gt; --label &lt;name&gt; --yes-erase</code> in a terminal on {hostName}: erasing is never offered here.</p>
        </section>
      )}

      {v && (
        <section className="card" aria-label="Accounts and the volume">
          <header><h2>Accounts</h2></header>
          {offVolume.length === 0 ? <p className="note">Every account root is on the volume.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Account</th><th>Root</th><th><span className="sr">Actions</span></th></tr></thead>
                <tbody>
                  {offVolume.map((a) => (
                    <tr key={a.name}>
                      <td><b>{a.name}</b></td>
                      <td className="mono small">{a.root}</td>
                      <td><button className="btn sm" disabled={!v.ready} onClick={() => setDialog({ kind: 'migrate', account: a.name, cleanup: false })}>Move to the volume…</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(status?.oldCopies ?? []).map((c) => (
            <div className="row" key={c.account}>
              <span className="note">Old copy of <b>{c.account}</b> kept at <span className="mono">{c.path}</span>.</span>
              <button className="btn sm danger" onClick={() => setDialog({ kind: 'migrate', account: c.account, cleanup: true })}>Delete the old copy…</button>
            </div>
          ))}
        </section>
      )}

      <section className="card" aria-label="External disks">
        <header><h2>External disks</h2></header>
        {disks.length === 0 ? <Empty>No external disk is connected to {hostName}.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Disk</th><th>Volume</th><th>UUID</th><th>Mounted at</th><th><span className="sr">Actions</span></th></tr></thead>
              <tbody>
                {disks.flatMap((d) => (d.volumes.length ? d.volumes : [null]).map((x, i) => (
                  <tr key={`${d.device}-${x?.device ?? i}`}>
                    <td>{i === 0 ? <><b>{d.device}</b> <span className="muted">{d.model} {bytes(d.sizeBytes)}</span></> : ''}</td>
                    <td>{x ? x.name : <span className="muted">no APFS volume</span>}</td>
                    <td className="mono small">{x?.uuid ?? ''}</td>
                    <td className="mono small">{x?.mountPoint ?? (x ? 'not mounted' : '')}</td>
                    <td>{x && (x.adopted ? <Badge tone="good">work volume</Badge> : !v && x.mountPoint && <button className="btn sm" onClick={() => setDialog({ kind: 'adopt', volume: x.uuid, name: x.name })}>Use as work volume…</button>)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog?.kind === 'adopt' && (
        <RunDialog<StorageChangeData>
          title={`Use ${dialog.name} as the work volume`}
          begin={(h) => client.storageAdopt(dialog.volume, h)}
          terminal={{ kind: 'devhost', args: ['storage', 'adopt', dialog.volume] }}
          onClose={() => { setDialog(null); void refresh(); }}
          after={(r) => r.data?.notes && <ul className="note">{r.data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        >
          <p className="sec">Records the volume by its APFS UUID, writes a marker file on it, and makes new accounts land on it. Nothing on the volume is erased. Then apply the configuration for its settings (mount at boot, ownership, Spotlight, unlock).</p>
        </RunDialog>
      )}
      {dialog?.kind === 'migrate' && (
        <RunDialog<StorageChangeData>
          title={dialog.cleanup ? `Delete the old copy of ${dialog.account}` : `Move ${dialog.account} to the volume`}
          begin={(h) => client.storageMigrate(dialog.account, dialog.cleanup, h)}
          terminal={{ kind: 'devhost', args: ['storage', 'migrate', '--account', dialog.account, ...(dialog.cleanup ? ['--cleanup'] : [])] }}
          onClose={() => { setDialog(null); void refresh(); }}
          after={(r) => r.data?.notes && <ul className="note">{r.data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        >
          {dialog.cleanup ? (
            <p className="sec">Deletes the copy {dialog.account} left on the internal disk when it moved. Asks once more before it deletes anything.</p>
          ) : (
            <div className="sec">
              <p>What happens, in order (you confirm before anything changes):</p>
              <ol>
                <li>{dialog.account}'s Remote Control services stop (other accounts keep running).</li>
                <li>Its root is copied onto the volume and the copy is checked (file count and size).</li>
                <li>The configuration points at the copy; .envrc, git identity, services and Colima's mounts are regenerated; workspace trust is accepted again.</li>
                <li>The old copy stays until you delete it here.</li>
              </ol>
              <p className="note">Claude Code keeps session history by project path: earlier sessions stay listed under the old path. Remote Control sessions of the old paths end.</p>
            </div>
          )}
        </RunDialog>
      )}
    </div>
  );
}

function VolumeCard({ v }: { v: Volume }) {
  const pct = v.freeBytes != null && v.totalBytes ? (v.freeBytes / v.totalBytes) * 100 : null;
  return (
    <section className="card" aria-label="Work volume">
      <header>
        <h2>{v.label}</h2>
        {v.ready ? <Badge tone="good">ready</Badge> : v.mounted ? <Badge tone="bad">not the configured volume</Badge> : <Badge tone="bad">not mounted</Badge>}
        <span className="push note mono">{v.uuid}</span>
      </header>
      {(v.strayDirectory || v.doubleMount) && (
        <div className="notice bad" role="alert">
          {v.strayDirectory && <div>{v.mountPoint} is a plain directory on the internal disk, not the volume.</div>}
          {v.doubleMount && <div>{v.mountPoint} 1 exists: the volume is mounted a second time.</div>}
        </div>
      )}
      <div className="grid cols-4">
        <div className="tile"><span className="label">Free</span><span className="value">{pct == null ? '–' : `${pct.toFixed(0)}%`}</span><span className="sub">{bytes(v.freeBytes)} of {bytes(v.totalBytes)}</span></div>
        <div className="tile"><span className="label">Mounted at</span><span className="value small mono">{v.mountPoint}</span><span className="sub">root {v.root}</span></div>
        <div className="tile"><span className="label">Encryption</span><span className="value">{v.encrypted ? (v.locked ? <Badge tone="warn">locked</Badge> : <Badge tone="good">encrypted</Badge>) : <Badge>not encrypted</Badge>}</span>{v.encryptedInConfig && <span className="sub">unlock service {v.unlockDaemon ? 'loaded' : 'missing'} · passphrase {v.passphraseStored ? 'stored' : 'missing'}</span>}</div>
        <div className="tile"><span className="label">Identity</span><span className="value">{v.uuidMatch && v.markerMatch ? <Badge tone="good">matches</Badge> : <Badge tone="bad">differs</Badge>}</span><span className="sub">uuid {v.uuidMatch ? 'ok' : 'differs'} · marker {v.markerMatch ? 'ok' : 'missing'}</span></div>
      </div>
      <div className="row note">
        <span>Ownership {yes(v.ownership, 'on', 'off')}</span>
        <span>Spotlight {v.spotlightOff == null ? <Badge>unknown</Badge> : v.spotlightOff ? <Badge tone="good">off</Badge> : <Badge tone="warn">on</Badge>}</span>
        <span>Mounts without login {yes(v.automountWithoutLogin, 'yes', 'no')}</span>
      </div>
    </section>
  );
}
