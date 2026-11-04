// Diagnostic report: plain text the user reads, edits and copies or saves themselves. Nothing is sent
// anywhere automatically. Contains no PGNs, positions, usernames, URLs with paths or browsing history —
// only versions, settings, counts and the local error log (already redacted).
import type { Settings } from '@/settings/schema';
import type { LogEntry } from './log';
import { redact } from './redact';

export interface DiagnosticInput {
  version: string;
  browser: string;
  platform: string;
  settings: Settings;
  grantedSites: string[];
  engines: { name: string; status: string; detail?: string; warnings?: string[] }[];
  counts?: Record<string, number>;
  storage?: { usage?: number; quota?: number };
  errors: LogEntry[];
  migration?: { from: number; to: number; changed: string[] } | null;
  checks?: { name: string; ok: boolean; detail: string }[];
}

export const ISSUE_URL = 'https://github.com/lk5t/moth-chess/issues/new';

export function buildReport(d: DiagnosticInput, opts: { includeSettings?: boolean; includeErrors?: boolean } = {}): string {
  const mb = (b?: number) => (b === undefined ? 'unknown' : `${(b / 1048576).toFixed(1)} MB`);
  const L: string[] = [];
  L.push('## MOTH Chess diagnostic report', '');
  L.push(`- Version: ${d.version} (public beta)`, `- Browser: ${d.browser}`, `- Platform: ${d.platform}`);
  L.push(`- Analysis engine: ${d.settings.engine.kind} · review engine: ${d.settings.engine.reviewKind} · profile: ${d.settings.performance.profile}`);
  L.push(`- Site access granted: ${d.grantedSites.length ? d.grantedSites.join(', ') : 'none'}`);
  if (d.storage) L.push(`- Local storage used: ${mb(d.storage.usage)} of ${mb(d.storage.quota)}`);
  if (d.migration) L.push(`- Last settings migration: v${d.migration.from} → v${d.migration.to} (${d.migration.changed.join('; ')})`);
  L.push('', '### Engines');
  for (const e of d.engines) L.push(`- ${e.name}: ${e.status}${e.detail ? ` — ${redact(e.detail)}` : ''}${e.warnings?.length ? ` (warnings: ${e.warnings.map(redact).join('; ')})` : ''}`);
  if (d.checks?.length) {
    L.push('', '### Self-checks');
    for (const c of d.checks) L.push(`- ${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${redact(c.detail)}`);
  }
  if (d.counts) L.push('', '### Local data (record counts only)', Object.entries(d.counts).map(([k, v]) => `${k} ${v}`).join(' · '));
  if (opts.includeSettings !== false) {
    const { onboarding, ...rest } = d.settings; void onboarding;
    L.push('', '### Settings', '```json', JSON.stringify(rest), '```');
  }
  if (opts.includeErrors !== false) {
    L.push('', `### Recent errors (${d.errors.length})`);
    if (!d.errors.length) L.push('none');
    for (const e of d.errors.slice(-20)) L.push(`- ${new Date(e.at).toISOString()} [${e.source}] ${redact(e.message)}${e.count > 1 ? ` ×${e.count}` : ''}`);
  }
  L.push('', '### What happened?', '(describe what you did, what you expected and what you saw)');
  return L.join('\n');
}

/** Pre-filled GitHub issue link (opened by the user; the body is only what they reviewed). */
export function issueLink(kind: 'bug' | 'feedback', title: string, body: string): string {
  const q = new URLSearchParams({ title: `[${kind}] ${title}`.slice(0, 120), body: body.slice(0, 6000), labels: kind === 'bug' ? 'bug,beta' : 'feedback,beta' });
  return `${ISSUE_URL}?${q.toString()}`;
}

export function browserName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const brands = (typeof navigator !== 'undefined' && (navigator as any).userAgentData?.brands) as { brand: string; version: string }[] | undefined;
  const isBrave = typeof navigator !== 'undefined' && !!(navigator as any).brave;
  const chrome = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? brands?.find((b) => /Chromium/.test(b.brand))?.version ?? '?';
  return `${isBrave ? 'Brave' : brands?.find((b) => !/Not|Chromium/.test(b.brand))?.brand ?? 'Chromium'} (Chromium ${chrome})`;
}
