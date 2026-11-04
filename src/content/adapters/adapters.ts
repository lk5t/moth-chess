// Board adapters for authorised third-party analysis boards.
// They read only what is visibly rendered (piece placement, orientation, last-move highlight) and the
// FEN the site itself puts in the URL. Castling/en-passant are NEVER reconstructed by guesswork:
// if the site doesn't expose them, they are reported as unknown and the user can set them.
import type { Color, Orientation, PieceType, Square } from '@/types';
import type { SiteId } from '../detector/sites';
import { applyMove, START_FEN, validateFen } from '@/chess/position';

export interface BoardReading {
  site: SiteId;
  placement: string; // FEN field 1
  orientation: Orientation;
  turn: Color | null; // null = could not be determined from the page
  castling: string | null; // null = unknown
  ep: string | null; // null = unknown
  lastMove?: [Square, Square];
  /** where the full position came from: the site's own FEN field, its move list replayed legally, the URL, or pieces only */
  source: 'fen' | 'history' | 'url' | 'dom';
  /** true when side to move, castling and e.p. are known from page data (not just piece placement) */
  verified: boolean;
  /** complete, validated FEN when verified */
  fullFen?: string;
  warnings: string[];
}

export interface BoardAdapter {
  site: SiteId;
  findBoard(doc: Document): HTMLElement | null;
  read(board: HTMLElement, doc: Document, loc: Location): BoardReading | null;
  /** Elements whose attribute changes mean the board changed (e.g. the orientation class lives on a wrapper). */
  watchTargets?(board: HTMLElement): Element[];
  /** Site controls the HUD panel should not cover (move list, analysis tools, sidebar). */
  avoid?(doc: Document): Element[];
}

const all = (doc: Document, sels: string[]) => sels.flatMap((s) => [...doc.querySelectorAll(s)]).filter((e) => (e as HTMLElement).offsetParent !== null || e.getClientRects().length > 0);

const FILES = 'abcdefgh';
type Grid = (null | { type: PieceType; color: Color })[][]; // [rankIndex 0 = rank 8][file]

export function emptyGrid(): Grid { return Array.from({ length: 8 }, () => Array(8).fill(null)); }

export function gridToPlacement(g: Grid): string {
  return g.map((row) => {
    let s = '', e = 0;
    for (const p of row) { if (!p) { e++; continue; } if (e) { s += e; e = 0; } s += p.color === 'w' ? p.type.toUpperCase() : p.type; }
    return s + (e ? e : '');
  }).join('/');
}

function put(g: Grid, sq: Square, p: { type: PieceType; color: Color }) {
  const f = FILES.indexOf(sq[0]);
  const r = Number(sq[1]);
  g[8 - r][f] = p;
}

function pieceAt(placement: string, sq: Square): { type: PieceType; color: Color } | null {
  const rows = placement.split('/');
  const row = rows[8 - Number(sq[1])];
  let f = 0;
  for (const ch of row ?? '') {
    if (/\d/.test(ch)) { f += Number(ch); continue; }
    if (f === FILES.indexOf(sq[0])) return { type: ch.toLowerCase() as PieceType, color: ch === ch.toUpperCase() ? 'w' : 'b' };
    f++;
  }
  return null;
}

const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

/** Side to move inferred from the last-move highlight: the side that just moved is not to move. */
export function turnFromLastMove(placement: string, last?: [Square, Square]): Color | null {
  if (!last) return placement === START_PLACEMENT ? 'w' : null;
  const a = pieceAt(placement, last[0]);
  const b = pieceAt(placement, last[1]);
  const mover = b ?? a; // the destination holds the piece that moved
  if (!mover) return null;
  return mover.color === 'w' ? 'b' : 'w';
}

/** Parse a FEN from a Lichess analysis URL (/analysis/<fen> or /analysis/standard/<fen>, underscores for spaces). */
export function fenFromLichessPath(pathname: string): string | null {
  const m = /^\/analysis\/(?:(?:standard|fromPosition)\/)?(.+)$/.exec(pathname);
  if (!m) return null;
  const fen = decodeURIComponent(m[1]).replace(/_/g, ' ').trim();
  return /^[pnbrqkPNBRQK1-8/]+ [wb]( [KQkq-]+)?( [a-h1-8-]+)?/.test(fen) ? fen : null;
}

// ---------------- position verification from page data ----------------

/** Replay SAN tokens from the start position; null if any move is illegal. */
export function replaySans(sans: string[], startFen = START_FEN): string | null {
  let fen = startFen;
  for (const raw of sans) {
    const san = raw.replace(/[!?]+$/, '').replace(/^\d+\.+/, '').trim();
    if (!san) continue;
    const r = applyMove(fen, san);
    if (!r) return null;
    fen = r.fenAfter;
  }
  return fen;
}

/**
 * Upgrade a pieces-only reading to a verified position using page data, but only when that data
 * reproduces exactly the placement visible on the board. Anything else stays unverified.
 */
export function verifyReading(r: BoardReading, page: { fen?: string | null; sans?: string[] | null }): BoardReading {
  const tryFen = (fen: string | null | undefined, source: BoardReading['source']): BoardReading | null => {
    if (!fen) return null;
    const v = validateFen(fen);
    if (!v.ok || !v.fen || v.fen.split(' ')[0] !== r.placement) return null;
    const [, t, c, e] = v.fen.split(' ');
    return { ...r, turn: t as Color, castling: c, ep: e, source, verified: true, fullFen: v.fen, warnings: r.warnings.filter((w) => !/Castling|Side to move/.test(w)) };
  };
  return tryFen(page.fen, 'fen') ?? (page.sans?.length ? tryFen(replaySans(page.sans), 'history') : null) ?? (r.placement === START_PLACEMENT && !page.sans?.length ? tryFen(START_FEN, 'history') : null) ?? r;
}

const moveText = (el: Element) => (el.textContent ?? '').replace(/\s+/g, '').replace(/[^\w=+#-]/g, '');

// ---------------- Lichess (chessground) ----------------

function translateOf(el: Element): { x: number; y: number } | null {
  const t = (el as HTMLElement).style?.transform ?? '';
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(t);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

function cgSquare(x: number, y: number, sqSize: number, o: Orientation): Square | null {
  const col = Math.round(x / sqSize), row = Math.round(y / sqSize);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  const f = o === 'white' ? col : 7 - col;
  const r = o === 'white' ? 8 - row : row + 1;
  return `${FILES[f]}${r}` as Square;
}

const CG_TYPES: Record<string, PieceType> = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };

export const lichessAdapter: BoardAdapter = {
  site: 'lichess',
  findBoard: (doc) => (doc.querySelector('.main-board cg-container') ?? doc.querySelector('cg-container')) as HTMLElement | null,
  watchTargets: (board) => [board.closest('.cg-wrap')].filter(Boolean) as Element[],
  avoid: (doc) => all(doc, ['.analyse__tools', '.analyse__controls', '.study__side', '.practice__side']),
  read(board, _doc, loc) {
    const wrap = board.closest('.cg-wrap');
    const orientation: Orientation = wrap?.classList.contains('orientation-black') ? 'black' : 'white';
    const size = board.getBoundingClientRect().width || board.clientWidth;
    if (!size) return null;
    const sqSize = size / 8;
    const grid = emptyGrid();
    const pieces = board.querySelectorAll('cg-board piece');
    let count = 0;
    pieces.forEach((p) => {
      if (p.classList.contains('ghost') || p.classList.contains('fading') || p.classList.contains('dragging')) return;
      const color: Color | null = p.classList.contains('white') ? 'w' : p.classList.contains('black') ? 'b' : null;
      const typeName = Object.keys(CG_TYPES).find((t) => p.classList.contains(t));
      const pos = translateOf(p);
      if (!color || !typeName || !pos) return;
      const sq = cgSquare(pos.x, pos.y, sqSize, orientation);
      if (!sq) return;
      put(grid, sq, { type: CG_TYPES[typeName], color });
      count++;
    });
    if (!count) return null;
    const placement = gridToPlacement(grid);
    const lastSq: Square[] = [];
    board.querySelectorAll('cg-board square.last-move').forEach((s) => {
      const pos = translateOf(s);
      const sq = pos && cgSquare(pos.x, pos.y, sqSize, orientation);
      if (sq) lastSq.push(sq);
    });
    let lastMove: [Square, Square] | undefined;
    if (lastSq.length === 2) {
      const occ0 = pieceAt(placement, lastSq[0]);
      lastMove = occ0 ? [lastSq[1], lastSq[0]] : [lastSq[0], lastSq[1]];
    }
    const warnings: string[] = [];
    const urlFen = fenFromLichessPath(loc.pathname);
    if (urlFen && urlFen.split(' ')[0] === placement) {
      const [, t, c = '-', e = '-'] = urlFen.split(' ');
      const v = validateFen(`${urlFen.split(' ').slice(0, 4).join(' ')} 0 1`);
      if (v.ok && v.fen) return { site: 'lichess', placement, orientation, turn: t as Color, castling: c, ep: e, lastMove, source: 'url', verified: true, fullFen: v.fen, warnings };
    }
    const turn = turnFromLastMove(placement, lastMove);
    if (!turn) warnings.push('Side to move could not be read from the page — choose it in the overlay.');
    warnings.push('Castling and en-passant rights are not exposed by the page; set them in the overlay if they matter.');
    const base: BoardReading = { site: 'lichess', placement, orientation, turn, castling: null, ep: null, lastMove, source: 'dom', verified: false, warnings };
    // the analysis page shows the current FEN in a copyable field and the move tree up to the active move
    const fenField = [..._doc.querySelectorAll<HTMLInputElement>('.copyables input, input.copyable, .analyse__underboard input[spellcheck="false"]')].map((i) => i.value).find((v) => validateFen(v).ok);
    const tree = [..._doc.querySelectorAll('.tview2 move, .analyse__moves move')];
    const activeIdx = tree.findIndex((m) => m.classList.contains('active'));
    const mainline = tree.filter((m) => !m.closest('lines, interrupt, .inline'));
    const upto = activeIdx >= 0 && mainline.includes(tree[activeIdx]) ? mainline.slice(0, mainline.indexOf(tree[activeIdx]) + 1) : mainline;
    const sans = upto.map((m) => moveText(m.querySelector('san') ?? m)).filter(Boolean);
    return verifyReading(base, { fen: fenField, sans });
  },
};

// ---------------- Chess.com ----------------

export const chesscomAdapter: BoardAdapter = {
  site: 'chesscom',
  findBoard: (doc) => (doc.querySelector('wc-chess-board') ?? doc.querySelector('chess-board') ?? doc.querySelector('#board-analysis-board') ?? doc.querySelector('.board')) as HTMLElement | null,
  watchTargets: (board) => [board.parentElement].filter(Boolean) as Element[],
  avoid: (doc) => all(doc, ['#board-layout-sidebar', '.board-layout-sidebar', '#board-layout-controls', '.board-layout-controls']),
  read(board) {
    const orientation: Orientation = board.classList.contains('flipped') ? 'black' : 'white';
    const grid = emptyGrid();
    let count = 0;
    board.querySelectorAll('.piece').forEach((p) => {
      const cls = [...p.classList];
      const code = cls.find((c) => /^[wb][pnbrqk]$/.test(c));
      const sqc = cls.find((c) => /^square-[1-8][1-8]$/.test(c));
      if (!code || !sqc) return;
      const f = Number(sqc[7]) - 1, r = Number(sqc[8]);
      put(grid, `${FILES[f]}${r}` as Square, { type: code[1] as PieceType, color: code[0] as Color });
      count++;
    });
    if (!count) return null;
    const placement = gridToPlacement(grid);
    const hl: Square[] = [];
    board.querySelectorAll('.highlight').forEach((h) => {
      const sqc = [...h.classList].find((c) => /^square-[1-8][1-8]$/.test(c));
      if (sqc) hl.push(`${FILES[Number(sqc[7]) - 1]}${sqc[8]}` as Square);
    });
    let lastMove: [Square, Square] | undefined;
    if (hl.length === 2) lastMove = pieceAt(placement, hl[0]) ? [hl[1], hl[0]] : [hl[0], hl[1]];
    const turn = turnFromLastMove(placement, lastMove);
    const warnings: string[] = [];
    if (!turn) warnings.push('Side to move could not be read from the page — choose it in the overlay.');
    warnings.push('Castling and en-passant rights are not exposed by the page; set them in the overlay if they matter.');
    const base: BoardReading = { site: 'chesscom', placement, orientation, turn, castling: null, ep: null, lastMove, source: 'dom', verified: false, warnings };
    // the analysis move list: replay up to the selected node; verified only if it reproduces the board
    const doc = board.ownerDocument;
    const nodes = [...doc.querySelectorAll('wc-simple-move-list .node, .move-list .node, .analysis-view-movelist .node')].filter((n) => !n.closest('.subline, .variation'));
    const sel = nodes.findIndex((n) => n.classList.contains('selected') || n.querySelector('.selected'));
    const upto = sel >= 0 ? nodes.slice(0, sel + 1) : nodes;
    const sans = upto.map((n) => {
      const c = n.querySelector('.node-highlight-content') ?? n;
      const fig = c.querySelector('[data-figurine]')?.getAttribute('data-figurine') ?? '';
      return fig + moveText(c);
    }).filter(Boolean);
    return verifyReading(base, { sans });
  },
};

export const ADAPTERS: Record<'chessground' | 'chesscom', BoardAdapter> = { chessground: lichessAdapter, chesscom: chesscomAdapter };

/**
 * Compose a FEN from a reading plus user-provided metadata. Castling rights the user enabled are kept
 * only if king and rook still stand on their original squares (impossible rights are dropped, not invented).
 */
export function composeFen(r: Pick<BoardReading, 'placement' | 'turn' | 'castling' | 'ep'>, manual: { turn?: Color; castling?: string; ep?: string } = {}): { fen: string | null; problems: string[] } {
  const problems: string[] = [];
  const turn = r.turn ?? manual.turn;
  if (!turn) return { fen: null, problems: ['Side to move unknown'] };
  let castling = r.castling ?? manual.castling ?? '-';
  const ok = (sq: Square, ch: string) => { const p = pieceAt(r.placement, sq); return !!p && (p.color === 'w' ? p.type.toUpperCase() : p.type) === ch; };
  castling = castling.split('').filter((c) => {
    const keep = c === 'K' ? ok('e1', 'K') && ok('h1', 'R') : c === 'Q' ? ok('e1', 'K') && ok('a1', 'R') : c === 'k' ? ok('e8', 'k') && ok('h8', 'r') : c === 'q' ? ok('e8', 'k') && ok('a8', 'r') : false;
    if (!keep && c !== '-') problems.push(`Dropped impossible castling right "${c}"`);
    return keep;
  }).join('') || '-';
  const ep = r.ep ?? manual.ep ?? '-';
  return { fen: `${r.placement} ${turn} ${castling} ${ep} 0 1`, problems };
}
