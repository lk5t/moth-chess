// Backup & restore (v2.1). A backup is one local JSON file: settings + the Memory database (games, reviews,
// positions, training data, practice history…). Nothing leaves the device unless the user saves the file.
// Trained model weights stay in the Learning Lab's own .mothnn export (binary, can be large).
//
// Accepted inputs:
//   • format "moth-chess-backup" v3  (2.1+: { settings, data })
//   • format "moth-chess-export" v1–2 (2.0 Memory export: { data }) — restored as data only
import { EXPORT_FORMAT, EXPORT_VERSION, exportAll, importAll, type RestoreReport } from '@/memory/repo';
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from '@/settings/schema';

export const BACKUP_FORMAT = 'moth-chess-backup';
export const BACKUP_VERSION = 3;
export const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

const KNOWN_TABLES = ['games', 'reviews', 'positions', 'openings', 'sessions', 'trees', 'exercises', 'attempts', 'annotations', 'folders', 'simulations', 'practice', 'latency', 'runs'];

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  app: string;
  createdAt: string;
  settings: Settings;
  data: Record<string, unknown[]>;
}

export interface BackupCheck {
  ok: boolean;
  kind?: 'backup' | 'legacy-export';
  version?: number;
  app?: string;
  createdAt?: string;
  hasSettings: boolean;
  counts: Record<string, number>;
  errors: string[];
  warnings: string[];
}

/** Validate a backup without changing anything (used for the preview before restoring). */
export function inspectBackup(text: string): BackupCheck {
  const out: BackupCheck = { ok: false, hasSettings: false, counts: {}, errors: [], warnings: [] };
  if (text.length > MAX_BACKUP_BYTES) { out.errors.push('File is larger than 200 MB — not a MOTH Chess backup.'); return out; }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { out.errors.push('This file is not valid JSON (it may be truncated or damaged).'); return out; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { out.errors.push('Not a MOTH Chess backup.'); return out; }
  if (parsed.format === BACKUP_FORMAT) out.kind = 'backup';
  else if (parsed.format === EXPORT_FORMAT) out.kind = 'legacy-export';
  else { out.errors.push('Not a MOTH Chess backup (unknown format).'); return out; }
  out.version = Number(parsed.version);
  out.app = typeof parsed.app === 'string' ? parsed.app : undefined;
  out.createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : typeof parsed.exportedAt === 'string' ? parsed.exportedAt : undefined;
  const maxV = out.kind === 'backup' ? BACKUP_VERSION : EXPORT_VERSION;
  if (!Number.isFinite(out.version) || out.version < 1) { out.errors.push('Backup version is missing.'); return out; }
  if (out.version > maxV) { out.errors.push(`This backup was made by a newer MOTH Chess (format v${out.version}). Update the extension first.`); return out; }
  if (parsed.data !== undefined && (typeof parsed.data !== 'object' || Array.isArray(parsed.data))) { out.errors.push('Backup data section is damaged.'); return out; }
  for (const [k, v] of Object.entries(parsed.data ?? {})) {
    if (!KNOWN_TABLES.includes(k)) { out.warnings.push(`Unknown section “${k}” will be ignored.`); continue; }
    if (!Array.isArray(v)) { out.errors.push(`Section “${k}” is damaged.`); continue; }
    const bad = (v as unknown[]).filter((r) => !r || typeof r !== 'object').length;
    if (bad) out.warnings.push(`${bad} unreadable ${k} record(s) will be skipped.`);
    out.counts[k] = (v as unknown[]).length - bad;
  }
  if (out.kind === 'backup') {
    out.hasSettings = !!parsed.settings && typeof parsed.settings === 'object';
    if (!out.hasSettings) out.warnings.push('No settings in this backup; current settings are kept.');
  } else out.warnings.push('MOTH Chess 2.0 Memory export: games and training data only, no settings.');
  out.ok = out.errors.length === 0;
  return out;
}

export async function createBackup(settings: Settings, app: string): Promise<string> {
  const mem = JSON.parse(await exportAll()) as { data: Record<string, unknown[]> };
  const file: BackupFile = { format: BACKUP_FORMAT, version: BACKUP_VERSION, app, createdAt: new Date().toISOString(), settings, data: mem.data };
  return JSON.stringify(file);
}

export interface RestoreResult { settings?: Settings; settingsChanges: string[]; data: RestoreReport }

/**
 * Restore: data is merged (existing records are kept, duplicates skipped); settings, if present and chosen,
 * are migrated through the same path as stored settings so older backups are upgraded, not rejected.
 * Onboarding state is never overwritten by a backup.
 */
export async function restoreBackup(text: string, opts: { settings: boolean; data: boolean }, current: Settings = DEFAULT_SETTINGS): Promise<RestoreResult> {
  const check = inspectBackup(text);
  if (!check.ok) throw new Error(check.errors.join(' '));
  const parsed = JSON.parse(text);
  const clean: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(parsed.data ?? {})) if (KNOWN_TABLES.includes(k) && Array.isArray(v)) clean[k] = (v as unknown[]).filter((r) => r && typeof r === 'object');
  const data = opts.data ? await importAll(JSON.stringify({ format: EXPORT_FORMAT, version: Math.min(EXPORT_VERSION, check.kind === 'legacy-export' ? check.version! : EXPORT_VERSION), data: clean }))
    : { inserted: {}, skippedDuplicates: {} };
  let settings: Settings | undefined;
  let settingsChanges: string[] = [];
  if (opts.settings && check.kind === 'backup' && check.hasSettings) {
    const m = migrateSettings(parsed.settings);
    settings = { ...m.settings, onboarding: current.onboarding };
    settingsChanges = m.changed.filter((c) => !c.startsWith('onboarding'));
  }
  return { settings, settingsChanges, data };
}
