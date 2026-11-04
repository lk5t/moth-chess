// Version, release notes and update check (Settings → About & updates, Control Center).
import { useEffect, useState } from 'react';
import { Card } from './ui';
import { appVersion } from './shared';
import { useSettings } from '@/settings/useSettings';
import { checkForUpdate, isStoreInstall, readUpdateState, updateAvailable, RELEASES_PAGE, type UpdateState } from '@/updates/updates';
import { CHANGELOG } from '@/control/changelog';

export function UpdatesCard() {
  const [s, update] = useSettings();
  const [st, setSt] = useState<UpdateState>({});
  const [busy, setBusy] = useState(false);
  const v = appVersion();
  useEffect(() => { void readUpdateState().then(setSt); }, []);
  const check = async () => {
    setBusy(true);
    if (isStoreInstall()) { try { await chrome.runtime.requestUpdateCheck(); } catch { /* not supported */ } }
    setSt(await checkForUpdate(v, { force: true }));
    setBusy(false);
  };
  const newer = updateAvailable(st, v);
  const notes = CHANGELOG.find((c) => c.version === v);
  return (
    <Card title={<span className="row">Version {v}<span className="badge beta">Public beta</span></span>}>
      {newer
        ? <div className="banner good small" data-testid="update-available"><b>MOTH Chess {st.latest} is available.</b> <a href={st.url ?? RELEASES_PAGE} target="_blank" rel="noreferrer">Release notes & download</a>. To update an unpacked install: download the zip, replace the extension folder, then press reload in brave://extensions. Settings, games and training data are kept.</div>
        : st.latest ? <div className="small">You have the latest release{st.checkedAt ? ` (checked ${new Date(st.checkedAt).toLocaleString()})` : ''}.</div> : null}
      {st.error && <div className="small muted">Last check failed: {st.error}</div>}
      <div className="row wrap" style={{ margin: '8px 0' }}>
        <button className="btn sm" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check for updates'}</button>
        <a className="btn sm ghost" href={RELEASES_PAGE} target="_blank" rel="noreferrer">All releases</a>
      </div>
      <label className="row small"><input type="checkbox" checked={s.updates.auto} onChange={(e) => update({ updates: { auto: e.target.checked } })} />Check GitHub for new releases once a day (sends no personal data; turn off for fully offline use)</label>
      {notes && (
        <details style={{ marginTop: 8 }}>
          <summary className="small" style={{ cursor: 'pointer' }}>What's new in {v}</summary>
          <ul className="small" style={{ paddingLeft: 18 }}>{notes.items.map((i) => <li key={i}>{i}</li>)}</ul>
        </details>
      )}
    </Card>
  );
}
