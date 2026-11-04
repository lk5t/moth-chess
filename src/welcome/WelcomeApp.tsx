// First-run setup (v2.1). Five short steps; every choice can be changed later in Settings.
// Reopen any time from Settings → About or the Control Center.
import { useState } from 'react';
import { useSettings } from '@/settings/useSettings';
import { useThemeRoot, BetaBadge, Icon } from '@/components/ui';
import { ProfilePicker, SitesList, FairPlayNote, appVersion, openExt } from '@/components/shared';

const STEPS = ['Welcome', 'Engine', 'Performance', 'Websites', 'Fair play'] as const;

export function WelcomeApp() {
  const [s, update, loaded] = useSettings();
  useThemeRoot(s);
  const [step, setStep] = useState(0);
  const [ack, setAck] = useState(false);
  if (!loaded) return null;
  const finish = async (go: 'board' | 'close') => {
    await update({ onboarding: { completed: appVersion() } });
    if (go === 'board') location.href = 'board.html';
    else window.close();
  };
  const last = step === STEPS.length - 1;
  return (
    <div className="neural-bg" style={{ minHeight: '100vh', display: 'grid', placeItems: 'start center' }}>
      <div className="page" style={{ maxWidth: 720, width: '100%' }}>
        <header className="page-header">
          <img src="icons/moth.svg" alt="" />
          <h1>Welcome to MOTH Chess</h1><BetaBadge label="Public beta" />
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => finish('close')}>Skip</button>
        </header>
        <div className="steps" aria-hidden="true">{STEPS.map((x, i) => <span key={x} className={i <= step ? 'on' : ''} />)}</div>
        <div className="small muted" style={{ margin: '6px 0 14px' }}>Step {step + 1} of {STEPS.length} · {STEPS[step]}</div>

        <section className="card stack" style={{ gap: 12, padding: 20 }} aria-live="polite">
          {step === 0 && (
            <>
              <h2 style={{ margin: 0 }}>Chess analysis that stays on your computer</h2>
              <p style={{ margin: 0 }} className="muted">MOTH Chess is a free, open-source browser extension. Everything runs locally — no account, no server, no tracking. It is a public beta: some parts are still being finished and are marked <span className="badge beta">Beta</span>.</p>
              <div className="status-grid">
                {[[Icon.board, 'Analysis board', 'Two local engines, explanations, threats and a move tree.'],
                  [Icon.play, 'Play MOTH', 'Practice games against MOTH at seven levels.'],
                  [Icon.coach, 'Review & Coach', 'Game reviews, exercises from your mistakes, opening training.'],
                  [Icon.spark, 'On-board HUD', 'Suggestions on Lichess and Chess.com analysis boards you allow.']].map(([icon, t, d]) => (
                  <div key={t as string} className="tile"><span style={{ width: 22, height: 22, display: 'inline-flex', color: 'var(--accent)' }}>{icon}</span><b>{t as string}</b><span className="small muted">{d as string}</span></div>
                ))}
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <h2 style={{ margin: 0 }}>Choose your analysis engine</h2>
              <p className="muted" style={{ margin: 0 }}>Both are bundled and run in your browser. You can switch at any time.</p>
              {([['moth', 'MOTH Engine', 'Our own engine with a trained evaluation network and three styles. Fast answers, lighter on resources.'],
                ['stockfish', 'Stockfish 17.1', 'The strongest open-source engine (single-threaded build). Deeper, more accurate evaluations.']] as const).map(([id, name, d]) => (
                <button key={id} className="tile" style={{ textAlign: 'left', cursor: 'pointer', outline: s.engine.kind === id ? '2px solid var(--accent)' : undefined }} aria-pressed={s.engine.kind === id} onClick={() => update({ engine: { kind: id } })}>
                  <b>{name}{s.engine.kind === id ? ' ✓' : ''}</b><span className="small muted">{d}</span>
                </button>
              ))}
              <div className="small muted">Game reviews use Stockfish by default; change that under Settings → Engine.</div>
            </>
          )}
          {step === 2 && (
            <>
              <h2 style={{ margin: 0 }}>Pick a performance profile</h2>
              <ProfilePicker settings={s} update={update} />
              <div className="small muted">Laptop on battery? Choose Eco. Desktop with power to spare? Performance.</div>
            </>
          )}
          {step === 3 && (
            <>
              <h2 style={{ margin: 0 }}>Websites</h2>
              <p className="muted" style={{ margin: 0 }}>MOTH needs your permission before it can read a board on a website. It asks per site, and only works on the pages listed here. Everything else, including the built-in board, works without any website access.</p>
              <SitesList />
            </>
          )}
          {step === 4 && (
            <>
              <h2 style={{ margin: 0 }}>Fair play comes first</h2>
              <FairPlayNote />
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                <li>Using engine help in live or rated games breaks the rules of every chess site. MOTH is built to make that impossible, not just discouraged.</li>
                <li>If a page cannot be classified safely, MOTH stays off. Positions it cannot fully read are marked “unverified”.</li>
                <li>The rules live in the extension and are checked continuously while a page is open.</li>
              </ul>
              <label className="row"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand MOTH is for analysis and practice only.</label>
            </>
          )}
        </section>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          <span className="grow" />
          {!last && <button className="btn primary" onClick={() => setStep(step + 1)}>Next</button>}
          {last && <button className="btn" disabled={!ack} onClick={() => finish('close')}>Finish</button>}
          {last && <button className="btn primary" disabled={!ack} onClick={() => finish('board')}>Finish & open the board</button>}
        </div>
        <div className="small muted" style={{ marginTop: 18 }}>You can reopen this tour from Settings → About or the <a href="#" onClick={(e) => { e.preventDefault(); openExt('control.html'); }}>Control Center</a>.</div>
      </div>
    </div>
  );
}
