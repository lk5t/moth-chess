// UCI protocol parsing. Pure functions — no engine state.
import type { EngineScore } from '@/types';

export interface UciInfo {
  depth?: number;
  seldepth?: number;
  multipv: number;
  score?: EngineScore;
  bound?: 'lower' | 'upper';
  nodes?: number;
  nps?: number;
  timeMs?: number;
  pv: string[];
  hashfull?: number;
  string?: string;
}

const INT_KEYS = new Set(['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time', 'hashfull', 'tbhits', 'currmovenumber']);

/** Parse an `info ...` line. Returns null for non-info lines. */
export function parseInfo(line: string): UciInfo | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info') return null;
  const out: UciInfo = { multipv: 1, pv: [] };
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === 'string') { out.string = t.slice(i + 1).join(' '); break; }
    if (k === 'pv') { out.pv = t.slice(i + 1).filter((m) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)); break; }
    if (k === 'score') {
      const type = t[i + 1];
      const val = Number(t[i + 2]);
      if ((type === 'cp' || type === 'mate') && Number.isFinite(val)) out.score = { type, value: val };
      i += 2;
      if (t[i + 1] === 'lowerbound') { out.bound = 'lower'; i++; }
      else if (t[i + 1] === 'upperbound') { out.bound = 'upper'; i++; }
      continue;
    }
    if (INT_KEYS.has(k)) {
      const v = Number(t[i + 1]);
      if (Number.isFinite(v)) {
        if (k === 'depth') out.depth = v;
        else if (k === 'seldepth') out.seldepth = v;
        else if (k === 'multipv') out.multipv = v;
        else if (k === 'nodes') out.nodes = v;
        else if (k === 'nps') out.nps = v;
        else if (k === 'time') out.timeMs = v;
        else if (k === 'hashfull') out.hashfull = v;
      }
      i++;
      continue;
    }
    if (k === 'currmove' || k === 'wdl' || k === 'refutation' || k === 'currline') {
      // skip values we don't use
      if (k === 'wdl') i += 3; else i++;
    }
  }
  return out;
}

export interface BestMove { bestMove: string | null; ponder?: string }

export function parseBestMove(line: string): BestMove | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'bestmove') return null;
  const bm = t[1];
  return { bestMove: !bm || bm === '(none)' || bm === '0000' ? null : bm, ponder: t[2] === 'ponder' ? t[3] : undefined };
}

export interface UciOption { name: string; type: string; default?: string; min?: number; max?: number }

export function parseOption(line: string): UciOption | null {
  const m = /^option name (.+?) type (\w+)(.*)$/.exec(line.trim());
  if (!m) return null;
  const rest = m[3];
  const def = /default (\S*)/.exec(rest)?.[1];
  const min = /min (-?\d+)/.exec(rest)?.[1];
  const max = /max (-?\d+)/.exec(rest)?.[1];
  return { name: m[1], type: m[2], default: def, min: min ? Number(min) : undefined, max: max ? Number(max) : undefined };
}

export function goCommand(opts: { depth?: number; moveTimeMs?: number; infinite?: boolean }): string {
  if (opts.infinite) return 'go infinite';
  const parts = ['go'];
  if (opts.depth) parts.push('depth', String(opts.depth));
  if (opts.moveTimeMs) parts.push('movetime', String(opts.moveTimeMs));
  if (parts.length === 1) parts.push('depth', '18');
  return parts.join(' ');
}
