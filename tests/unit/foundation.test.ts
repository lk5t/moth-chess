// Settings migration, performance profiles, backup validation/restore, diagnostics redaction, HUD placement.
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettings, mergeSettings, validateSettings } from '@/settings/schema';
import { PROFILES, profilePatch, detectProfile, withProfileTracking } from '@/settings/profiles';
import { inspectBackup, createBackup, restoreBackup, BACKUP_FORMAT } from '@/backup/backup';
import { MothDB, setDb, db } from '@/memory/db';
import { importPgnText, EXPORT_FORMAT } from '@/memory/repo';
import { redact } from '@/diagnostics/redact';
import { buildReport, issueLink } from '@/diagnostics/report';
import { logError, readErrors, clearErrors, ERROR_LOG_MAX } from '@/diagnostics/log';
import { placeAvoiding, overlapArea, evalBarSide, defaultOverlayState } from '@/content/overlay/layout';

const G1 = `[Event "A"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;
let n = 0;
beforeEach(() => { setDb(new MothDB(`moth-foundation-${++n}`)); });

describe('settings migration', () => {
  it('keeps every v2.0 choice and marks tuned engines as a custom profile', () => {
    const v20 = { enabled: true, appearance: { theme: 'light', accent: 'teal' }, engine: { depth: 22, hashMb: 128, kind: 'stockfish' }, visual: { evalBar: false, arrows: false }, moth: { style: 'aggressive' } };
    const m = migrateSettings(v20);
    expect(m.from).toBe(2);
    expect(m.settings.settingsVersion).toBe(SETTINGS_VERSION);
    expect(m.settings.appearance.theme).toBe('light');
    expect(m.settings.appearance.accent).toBe('teal');
    expect(m.settings.engine).toMatchObject({ depth: 22, hashMb: 128, kind: 'stockfish' });
    expect(m.settings.visual.arrows).toBe(false);
    expect(m.settings.moth.style).toBe('aggressive');
    expect(m.settings.performance.profile).toBe('custom');
    expect(m.settings.hud.evalBar).toBe('off'); // carried over from visual.evalBar=false
    expect(m.settings.onboarding.completed).not.toBe(''); // existing users are not re-onboarded
  });
  it('untuned v2.0 settings get the Standard profile; fresh installs are not onboarded yet', () => {
    expect(migrateSettings({ enabled: true }).settings.performance.profile).toBe('standard');
    const fresh = migrateSettings(undefined);
    expect(fresh.settings).toEqual(DEFAULT_SETTINGS);
    expect(fresh.settings.onboarding.completed).toBe('');
  });
  it('recovers from corrupted settings without throwing', () => {
    for (const bad of ['garbage', 42, [1, 2], true]) {
      const m = migrateSettings(bad);
      expect(m.corrupt).toBe(true);
      expect(m.settings.enabled).toBe(true);
      expect(m.changed.join(' ')).toMatch(/unreadable/);
    }
    const partial = validateSettings({ hud: { evalBar: 'diagonal', arrowCount: 99 }, performance: { idleSec: -5 } });
    expect(partial.hud.evalBar).toBe('left');
    expect(partial.hud.arrowCount).toBe(3);
    expect(partial.performance.idleSec).toBe(10);
  });
  it('is idempotent on current settings', () => {
    const m = migrateSettings(DEFAULT_SETTINGS);
    expect(m.changed).toEqual([]);
    expect(m.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('performance profiles', () => {
  it('apply concrete, ordered resource values', () => {
    const eco = mergeSettings(DEFAULT_SETTINGS, profilePatch('eco'));
    const perf = mergeSettings(DEFAULT_SETTINGS, profilePatch('performance'));
    expect(eco.engine.hashMb).toBeLessThan(perf.engine.hashMb);
    expect(eco.engine.depth).toBeLessThan(perf.engine.depth);
    expect(eco.performance.idleSec).toBeLessThan(perf.performance.idleSec);
    expect(eco.performance.debounceMs).toBeGreaterThan(perf.performance.debounceMs);
    expect(eco.moth.ponder).toBe(false);
    for (const p of PROFILES) expect(detectProfile(mergeSettings(DEFAULT_SETTINGS, profilePatch(p.id)))).toBe(p.id);
  });
  it('the default settings are the Standard profile', () => { expect(detectProfile(DEFAULT_SETTINGS)).toBe('standard'); });
  it('switches to custom when a profile-controlled value is edited by hand, and back when it matches again', () => {
    const p = withProfileTracking(DEFAULT_SETTINGS, { engine: { hashMb: 32 } }, mergeSettings);
    expect(p.performance?.profile).toBe('custom');
    const custom = mergeSettings(DEFAULT_SETTINGS, p);
    expect(withProfileTracking(custom, { engine: { hashMb: 64 } }, mergeSettings).performance?.profile).toBe('standard');
    expect(withProfileTracking(DEFAULT_SETTINGS, { appearance: { theme: 'light' } }, mergeSettings).performance).toBeUndefined();
  });
});

describe('backup and restore', () => {
  it('round-trips settings and data, skipping duplicates', async () => {
    await importPgnText(G1);
    const s = mergeSettings(DEFAULT_SETTINGS, { appearance: { theme: 'light' }, onboarding: { completed: '3.0.0' } });
    const text = await createBackup(s, '3.0.0');
    const check = inspectBackup(text);
    expect(check.ok).toBe(true);
    expect(check.kind).toBe('backup');
    expect(check.counts.games).toBe(1);
    setDb(new MothDB(`moth-foundation-${++n}`));
    const r = await restoreBackup(text, { settings: true, data: true }, mergeSettings(DEFAULT_SETTINGS, { onboarding: { completed: 'x' } }));
    expect(r.data.inserted.games).toBe(1);
    expect(r.settings?.appearance.theme).toBe('light');
    expect(r.settings?.onboarding.completed).toBe('x'); // never overwritten by a backup
    const again = await restoreBackup(text, { settings: false, data: true });
    expect(again.data.skippedDuplicates.games).toBe(1);
    expect(again.settings).toBeUndefined();
    expect(await db().games.count()).toBe(1);
  });
  it('accepts 2.0 Memory exports as data-only', async () => {
    const legacy = JSON.stringify({ format: EXPORT_FORMAT, version: 2, exportedAt: '2026-11-01', data: { games: [], positions: [] } });
    const c = inspectBackup(legacy);
    expect(c.ok).toBe(true);
    expect(c.kind).toBe('legacy-export');
    expect(c.hasSettings).toBe(false);
  });
  it('rejects malformed, foreign and future backups with clear messages', () => {
    expect(inspectBackup('{not json').errors[0]).toMatch(/not valid JSON/);
    expect(inspectBackup('[]').ok).toBe(false);
    expect(inspectBackup(JSON.stringify({ format: 'something-else', version: 1 })).errors[0]).toMatch(/unknown format/);
    expect(inspectBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99, data: {} })).errors[0]).toMatch(/newer/);
    expect(inspectBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 3, data: { games: 'oops' } })).ok).toBe(false);
    const w = inspectBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 3, settings: {}, data: { games: [null, {}], weird: [] } }));
    expect(w.ok).toBe(true);
    expect(w.counts.games).toBe(1);
    expect(w.warnings.join(' ')).toMatch(/weird/);
  });
  it('restores the v3 tables (practice, runs) that 2.0 exported but never re-imported', async () => {
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: 3, settings: DEFAULT_SETTINGS, data: { practice: [{ id: 5, at: 111, userColor: 'w', result: '1-0' }], runs: [{ id: 2, at: 222, status: 'done', log: [], params: {} }] } });
    const r = await restoreBackup(text, { settings: false, data: true });
    expect(r.data.inserted.practice).toBe(1);
    expect(r.data.inserted.runs).toBe(1);
  });
});

describe('diagnostics', () => {
  it('redacts URLs, e-mail addresses, IDs and file paths', () => {
    const t = redact('at https://www.chess.com/game/live/123456789?u=bob user a.b@example.com chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.js /home/alice/file.pgn id=AbCdEfGhIjKlMnOpQrStUvWxYz12');
    expect(t).toContain('https://www.chess.com/<path>');
    expect(t).not.toMatch(/123456789|bob|example\.com|alice|AbCdEf/);
    expect(t).toContain('chrome-extension://<id>');
  });
  it('builds a report without private data and links an issue only on request', () => {
    const r = buildReport({ version: '3.0.0', browser: 'Brave (Chromium 130)', platform: 'Linux', settings: DEFAULT_SETTINGS, grantedSites: ['lichess'], engines: [], errors: [{ at: 0, source: 'MOTH Engine', message: 'crash at https://lichess.org/abcdEFGH', count: 2 }] });
    expect(r).toContain('3.0.0');
    expect(r).toContain('×2');
    expect(r).not.toContain('abcdEFGH');
    expect(buildReport({ version: '3', browser: 'x', platform: 'y', settings: DEFAULT_SETTINGS, grantedSites: [], engines: [], errors: [] }, { includeSettings: false })).not.toContain('```json');
    expect(issueLink('bug', 'X', 'body')).toMatch(/^https:\/\/github\.com\/lk5t\/moth-chess\/issues\/new\?/);
  });
  it('keeps a bounded, folded error log', async () => {
    await clearErrors();
    await logError('a', 'same'); await logError('a', 'same');
    expect((await readErrors())[0].count).toBe(2);
    for (let i = 0; i < ERROR_LOG_MAX + 10; i++) await logError('b', `e${i}`);
    expect((await readErrors()).length).toBe(ERROR_LOG_MAX);
  });
});

describe('HUD placement', () => {
  const board = { left: 60, top: 60, width: 480, height: 480 };
  it('leaves a panel alone when it covers nothing', () => {
    const s = defaultOverlayState(1400, 900);
    expect(placeAvoiding(s, board, [], 1400, 900)).toMatchObject({ x: s.x, y: s.y });
  });
  it('moves a panel off the board and the site controls', () => {
    const s = { ...defaultOverlayState(1400, 900), x: 100, y: 100 };
    const tools = { left: 560, top: 60, width: 400, height: 600 };
    const p = placeAvoiding(s, board, [tools], 1400, 900);
    expect(overlapArea({ left: p.x, top: p.y, width: p.w, height: p.h }, board)).toBe(0);
    expect(overlapArea({ left: p.x, top: p.y, width: p.w, height: p.h }, tools)).toBe(0);
  });
  it('flips the eval bar when the preferred side is off-screen', () => {
    expect(evalBarSide('left', { left: 2, top: 0, width: 400, height: 400 }, 1000, 10)).toBe('right');
    expect(evalBarSide('right', { left: 590, top: 0, width: 400, height: 400 }, 1000, 10)).toBe('left');
    expect(evalBarSide('left', board, 1400, 10)).toBe('left');
  });
});
