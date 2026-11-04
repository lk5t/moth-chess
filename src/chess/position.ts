// Chess rules layer: everything legality-related goes through chess.js.
import { Chess, validateFen as cjsValidateFen } from 'chess.js';
import type { Color, MoveRecord, PieceType, Position, Square, GameResult } from '@/types';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface FenValidation { ok: boolean; error?: string; fen?: string }

/** Normalise and validate a FEN. Accepts 4-field EPD and fills halfmove/fullmove counters. */
export function validateFen(input: string): FenValidation {
  const raw = input.trim().replace(/\s+/g, ' ');
  if (!raw) return { ok: false, error: 'Empty FEN' };
  const parts = raw.split(' ');
  if (parts.length === 4) parts.push('0', '1');
  if (parts.length === 5) parts.push('1');
  if (parts.length !== 6) return { ok: false, error: `FEN must have 6 fields (got ${parts.length})` };
  const fen = parts.join(' ');
  const r = cjsValidateFen(fen) as { ok: boolean; error?: string };
  if (!r.ok) return { ok: false, error: r.error ?? 'Invalid FEN' };
  // chess.js accepts positions with kings in impossible check; reject "side not to move is in check".
  const flipped = parts.slice();
  flipped[1] = parts[1] === 'w' ? 'b' : 'w';
  flipped[3] = '-';
  try {
    const c = new Chess(flipped.join(' '));
    if (c.inCheck()) return { ok: false, error: 'The side not to move is in check (illegal position)' };
  } catch {
    /* if flipping fails validation we keep the original verdict */
  }
  return { ok: true, fen };
}

/**
 * Position identity (placement, side, castling, en-passant). The ep square is kept only when a pawn of the
 * side to move could actually capture there, so transpositions match regardless of how a FEN writer
 * records "phantom" ep squares after every double pawn push.
 */
export function positionKey(fen: string): string {
  const [placement, turn = 'w', castling = '-', ep = '-'] = fen.split(' ');
  let epOut = '-';
  if (ep !== '-' && /^[a-h][36]$/.test(ep)) {
    const rows = placement.split('/');
    const f = 'abcdefgh'.indexOf(ep[0]);
    // the capturing pawn stands on rank 5 (white to move) or rank 4 (black to move)
    const rank = turn === 'w' ? 5 : 4;
    const row = rows[8 - rank] ?? '';
    const cells: string[] = [];
    for (const ch of row) { if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) cells.push(''); else cells.push(ch); }
    const pawn = turn === 'w' ? 'P' : 'p';
    if (cells[f - 1] === pawn || cells[f + 1] === pawn) epOut = ep;
  }
  return `${placement} ${turn} ${castling} ${epOut}`;
}

export function toPosition(fen: string): Position {
  const v = validateFen(fen);
  if (!v.ok || !v.fen) throw new Error(v.error ?? 'Invalid FEN');
  return { fen: v.fen, key: positionKey(v.fen), turn: v.fen.split(' ')[1] as Color };
}

export function turnOf(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

export function parseUci(uci: string): { from: Square; to: Square; promotion?: PieceType } | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (!m) return null;
  return { from: m[1] as Square, to: m[2] as Square, promotion: m[3] as PieceType | undefined };
}

type CjsMove = { from: string; to: string; san: string; lan?: string; piece: string; color: string; captured?: string; promotion?: string; before?: string; after?: string; flags: string };

function toRecord(m: CjsMove, fenBefore: string, fenAfter: string): MoveRecord {
  return {
    san: m.san,
    uci: m.from + m.to + (m.promotion ?? ''),
    from: m.from as Square,
    to: m.to as Square,
    promotion: m.promotion as PieceType | undefined,
    fenBefore,
    fenAfter,
    color: m.color as Color,
    piece: m.piece as PieceType,
    captured: m.captured as PieceType | undefined,
  };
}

/** Apply one move (UCI or SAN). Returns null if illegal — never throws. */
export function applyMove(fen: string, move: string | { from: Square; to: Square; promotion?: PieceType }): MoveRecord | null {
  let c: Chess;
  try { c = new Chess(fen); } catch { return null; }
  let arg: string | { from: string; to: string; promotion?: string } = move as never;
  if (typeof move === 'string') {
    const u = parseUci(move);
    if (u) arg = { from: u.from, to: u.to, promotion: u.promotion };
  }
  try {
    const m = c.move(arg as never) as unknown as CjsMove | null;
    if (!m) return null;
    return toRecord(m, fen, c.fen());
  } catch {
    return null;
  }
}

export function legalMoves(fen: string): MoveRecord[] {
  let c: Chess;
  try { c = new Chess(fen); } catch { return []; }
  const moves = c.moves({ verbose: true }) as unknown as CjsMove[];
  return moves.map((m) => toRecord(m, fen, m.after ?? afterFen(fen, m)));
}

function afterFen(fen: string, m: CjsMove): string {
  const c = new Chess(fen);
  c.move({ from: m.from, to: m.to, promotion: m.promotion });
  return c.fen();
}

export function legalMovesFrom(fen: string, from: Square): MoveRecord[] {
  return legalMoves(fen).filter((m) => m.from === from);
}

export function isPromotionMove(fen: string, from: Square, to: Square): boolean {
  return legalMoves(fen).some((m) => m.from === from && m.to === to && !!m.promotion);
}

/** Convert a UCI principal variation to SAN, stopping at the first illegal move (stale PV protection). */
export function uciLineToSan(fen: string, uciMoves: string[]): { san: string[]; fens: string[] } {
  const san: string[] = [];
  const fens: string[] = [];
  let cur = fen;
  for (const u of uciMoves) {
    const r = applyMove(cur, u);
    if (!r) break;
    san.push(r.san);
    fens.push(r.fenAfter);
    cur = r.fenAfter;
  }
  return { san, fens };
}

export interface GameStatus {
  over: boolean;
  checkmate: boolean;
  stalemate: boolean;
  draw: boolean;
  check: boolean;
  reason?: 'checkmate' | 'stalemate' | 'insufficient-material' | 'fifty-move' | 'threefold' | 'draw';
  winner?: Color;
}

export function gameStatus(fen: string, history: string[] = []): GameStatus {
  // `history` (FENs before this one) lets us detect threefold repetition.
  const c = new Chess(fen);
  const check = c.inCheck();
  if (c.isCheckmate()) return { over: true, checkmate: true, stalemate: false, draw: false, check, reason: 'checkmate', winner: c.turn() === 'w' ? 'b' : 'w' };
  if (c.isStalemate()) return { over: true, checkmate: false, stalemate: true, draw: true, check, reason: 'stalemate' };
  if (c.isInsufficientMaterial()) return { over: true, checkmate: false, stalemate: false, draw: true, check, reason: 'insufficient-material' };
  const half = Number(fen.split(' ')[4] ?? 0);
  if (half >= 100) return { over: true, checkmate: false, stalemate: false, draw: true, check, reason: 'fifty-move' };
  const key = positionKey(fen);
  if (history.filter((f) => positionKey(f) === key).length >= 2)
    return { over: true, checkmate: false, stalemate: false, draw: true, check, reason: 'threefold' };
  return { over: false, checkmate: false, stalemate: false, draw: false, check };
}

// ---------------- PGN ----------------

export interface ParsedGame {
  headers: Record<string, string>;
  startFen: string;
  moves: MoveRecord[];
  result: GameResult;
  comments: Record<number, string>;
}

export function parseHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const re = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn))) headers[m[1]] = m[2].replace(/\\"/g, '"');
  return headers;
}

/** Split a PGN file containing several games. */
export function splitPgn(text: string): string[] {
  const norm = text.replace(/\r\n?/g, '\n').trim();
  if (!norm) return [];
  const games: string[] = [];
  let cur: string[] = [];
  let seenMoves = false;
  for (const line of norm.split('\n')) {
    const isHeader = /^\s*\[\w+\s+".*"\]\s*$/.test(line);
    if (isHeader && seenMoves) {
      games.push(cur.join('\n').trim());
      cur = [];
      seenMoves = false;
    }
    if (!isHeader && line.trim()) seenMoves = true;
    cur.push(line);
  }
  if (cur.join('').trim()) games.push(cur.join('\n').trim());
  return games;
}

const RESULTS: GameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];

export function parsePgn(pgn: string): ParsedGame {
  const headers = parseHeaders(pgn);
  const c = new Chess();
  try {
    c.loadPgn(pgn);
  } catch (e) {
    throw new Error(`Invalid PGN: ${(e as Error).message}`);
  }
  const verbose = c.history({ verbose: true }) as unknown as CjsMove[];
  const startFen = headers.FEN ? (validateFen(headers.FEN).fen ?? START_FEN) : START_FEN;
  const moves: MoveRecord[] = [];
  let cur = startFen;
  for (const m of verbose) {
    const r = applyMove(cur, { from: m.from as Square, to: m.to as Square, promotion: m.promotion as PieceType | undefined });
    if (!r) throw new Error(`Illegal move in PGN: ${m.san}`);
    moves.push(r);
    cur = r.fenAfter;
  }
  const tail = pgn.trim().split(/\s+/).pop() ?? '*';
  const result = (RESULTS.includes(headers.Result as GameResult) ? headers.Result : RESULTS.includes(tail as GameResult) ? tail : '*') as GameResult;
  const comments: Record<number, string> = {};
  try {
    const cm = (c as unknown as { getComments?: () => { fen: string; comment: string }[] }).getComments?.() ?? [];
    for (const { fen, comment } of cm) {
      const idx = moves.findIndex((mv) => mv.fenAfter === fen);
      if (idx >= 0) comments[idx] = comment;
    }
  } catch { /* optional */ }
  return { headers, startFen, moves, result, comments };
}

export function buildPgn(opts: { headers?: Record<string, string>; startFen?: string; moves: { san: string; comment?: string; nag?: string }[]; result?: GameResult }): string {
  const headers: Record<string, string> = { Event: '?', Site: 'MOTH Chess', Date: '????.??.??', Round: '-', White: '?', Black: '?', Result: opts.result ?? '*', ...(opts.headers ?? {}) };
  const start = opts.startFen && opts.startFen !== START_FEN ? opts.startFen : undefined;
  if (start) { headers.SetUp = '1'; headers.FEN = start; }
  const head = Object.entries(headers).map(([k, v]) => `[${k} "${String(v).replace(/"/g, '\\"')}"]`).join('\n');
  const startFull = Number(start?.split(' ')[5] ?? 1);
  let white = (start?.split(' ')[1] ?? 'w') === 'w';
  let num = startFull;
  const parts: string[] = [];
  opts.moves.forEach((m, i) => {
    if (white) parts.push(`${num}.`);
    else if (i === 0) parts.push(`${num}...`);
    parts.push(m.san + (m.nag ? ` ${m.nag}` : ''));
    if (m.comment) parts.push(`{ ${m.comment.replace(/[{}]/g, '')} }`);
    if (!white) num++;
    white = !white;
  });
  parts.push(headers.Result);
  // wrap at ~80 chars
  const lines: string[] = [];
  let line = '';
  for (const p of parts) {
    if ((line + ' ' + p).trim().length > 80) { lines.push(line.trim()); line = p; } else line += ' ' + p;
  }
  if (line.trim()) lines.push(line.trim());
  return `${head}\n\n${lines.join('\n')}\n`;
}

export function boardFromFen(fen: string): (null | { type: PieceType; color: Color })[][] {
  // rank 8 first (row 0) like chess.js board()
  const rows = fen.split(' ')[0].split('/');
  return rows.map((r) => {
    const row: (null | { type: PieceType; color: Color })[] = [];
    for (const ch of r) {
      if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) row.push(null);
      else row.push({ type: ch.toLowerCase() as PieceType, color: ch === ch.toUpperCase() ? 'w' : 'b' });
    }
    return row;
  });
}

export function placementFromBoard(board: (null | { type: PieceType; color: Color })[][]): string {
  return board
    .map((row) => {
      let s = '';
      let empty = 0;
      for (const p of row) {
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        s += p.color === 'w' ? p.type.toUpperCase() : p.type;
      }
      if (empty) s += empty;
      return s;
    })
    .join('/');
}

export function flipTurn(fen: string): string {
  const p = fen.split(' ');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  p[3] = '-';
  return p.join(' ');
}
