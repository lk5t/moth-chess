// Minimal, dependency-free PGN reader for training ingestion (headers + main-line SAN tokens).
// Comments, variations, NAGs and move numbers are stripped; legality is checked later by replaying
// every move through MOTH Engine's own move generator.

export interface PgnGame {
  headers: Record<string, string>;
  sans: string[];
  result: '1-0' | '0-1' | '1/2-1/2' | '*';
}

/** Split a multi-game PGN file into individual game texts. */
export function splitPgn(text: string): string[] {
  const out: string[] = [];
  const parts = text.replace(/\r\n?/g, '\n').split(/\n(?=\[Event\s)/);
  for (const p of parts) if (p.trim()) out.push(p.trim());
  return out;
}

export function parsePgnGame(text: string): PgnGame | null {
  const headers: Record<string, string> = {};
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*\[(\w+)\s+"(.*)"\]\s*$/.exec(lines[i]);
    if (!m) { if (lines[i].trim() === '' && Object.keys(headers).length) continue; break; }
    headers[m[1]] = m[2];
  }
  let body = lines.slice(i).join(' ');
  // strip comments (brace and semicolon), variations (nested), NAGs
  body = body.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  let prev = '';
  while (prev !== body) { prev = body; body = body.replace(/\([^()]*\)/g, ' '); }
  body = body.replace(/\$\d+/g, ' ');
  const tokens = body.split(/\s+/).filter(Boolean);
  const sans: string[] = [];
  let result: PgnGame['result'] = (['1-0', '0-1', '1/2-1/2'].includes(headers.Result) ? headers.Result : '*') as PgnGame['result'];
  for (let t of tokens) {
    if (t === '1-0' || t === '0-1' || t === '1/2-1/2' || t === '*') { if (t !== '*') result = t; continue; }
    t = t.replace(/^\d+\.(\.\.)?/, '');
    if (!t || /^\d+\.*$/.test(t)) continue;
    sans.push(t);
  }
  return { headers, sans, result };
}
