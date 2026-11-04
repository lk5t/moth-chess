// Opening Explorer data (3.0): MOTH's engine-validated opening book (bundled, loaded lazily), the user's
// own games at a position, and short plan summaries for the main opening families.
import type { OpeningBook, BookMove } from '@/moth-engine/book';
import { gamesWithPosition } from '@/memory/repo';
import { parsePgn, positionKey } from '@/chess/position';

let bookPromise: Promise<OpeningBook | null> | null = null;
export function loadBook(): Promise<OpeningBook | null> {
  const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('moth-engine/book.json') : 'moth-engine/book.json';
  bookPromise ??= fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return bookPromise;
}
export function bookMoves(book: OpeningBook | null, fen: string): { moves: BookMove[]; name?: string; eco?: string } | null {
  if (!book) return null;
  const f = fen.trim().split(/\s+/);
  return book.positions[f.slice(0, 4).join(' ')] ?? book.positions[[f[0], f[1], f[2], '-'].join(' ')] ?? null;
}

export interface MyGamesStat { san: string; uci: string; games: number; score: number | null }
/** Moves the user's saved games played from this position, with the user's score after each. */
export async function myGamesAt(fen: string): Promise<{ total: number; moves: MyGamesStat[] }> {
  const games = await gamesWithPosition(fen);
  const key = positionKey(fen);
  const by = new Map<string, { san: string; uci: string; games: number; pts: number; n: number }>();
  for (const g of games) {
    let p; try { p = parsePgn(g.pgn); } catch { continue; }
    const fens = [p.startFen, ...p.moves.map((m) => m.fenAfter)];
    const i = fens.findIndex((x) => positionKey(x) === key);
    const m = i >= 0 ? p.moves[i] : undefined;
    if (!m) continue;
    const e = by.get(m.uci) ?? { san: m.san, uci: m.uci, games: 0, pts: 0, n: 0 };
    e.games++;
    if (g.userColor && g.result !== '*') { e.n++; e.pts += g.result === '1/2-1/2' ? 0.5 : (g.result === '1-0') === (g.userColor === 'w') ? 1 : 0; }
    by.set(m.uci, e);
  }
  return { total: games.length, moves: [...by.values()].sort((a, b) => b.games - a.games).map((e) => ({ san: e.san, uci: e.uci, games: e.games, score: e.n ? e.pts / e.n : null })) };
}

/** Typical plans by opening family (matched on the opening name). Short, general guidance. */
const PLANS: [RegExp, string[]][] = [
  [/Sicilian/, ['Black fights for d4 from the side and usually gets a queenside pawn majority after …cxd4.', 'White often attacks on the kingside; Black counterattacks on the c-file and queenside.']],
  [/French/, ['Black accepts a cramped light-squared bishop for a solid centre; the …c5 and …f6 breaks attack White\'s chain.', 'White gains space on the kingside (e5 pawn) and often attacks there.']],
  [/Caro-Kann/, ['Black develops the light-squared bishop before …e6 and aims for a solid, sound structure.', 'White usually plays for space or a lead in development; endgames often favour Black\'s structure.']],
  [/Ruy Lopez|Spanish/, ['White pressures e5 indirectly through the pin on the c6 knight.', 'Typical plans: c3 and d4 for White; …b5, …Na5 and …c5 for Black on the queenside.']],
  [/Italian|Giuoco|Two Knights/, ['Fast development with pressure on f7; slow lines with c3 and d4 or d3 manoeuvring.', 'Watch out for early tactics on f7 and e5.']],
  [/Queen's Gambit/, ['White pressures d5 with c4; Black chooses between holding the centre (Declined) or taking and returning the pawn (Accepted).', 'Minority attack (b4-b5) is a classic White plan in the Exchange structure.']],
  [/King's Indian/, ['Black lets White build a big centre, then strikes with …e5 or …c5.', 'Opposite-wing attacks are typical: White on the queenside, Black with …f5 on the kingside.']],
  [/Nimzo|Queen's Indian/, ['Black controls e4 with pieces and may give up the bishop pair to damage White\'s pawns.']],
  [/English/, ['A flank opening: White controls d5 and often fianchettoes the king\'s bishop.']],
  [/Scandinavian/, ['Black challenges e4 at once; the queen comes out early, so White gains tempi by attacking it.']],
  [/Pirc|Modern/, ['Black lets White occupy the centre and attacks it later with …c5 or …e5.']],
  [/London|Colle|System/, ['A system opening: the same set-up against most replies; plans are steady development and a kingside attack.']],
  [/Gambit/, ['A pawn (or more) is given for development and initiative; use the time before the opponent consolidates.']],
];
export function plansFor(name?: string): string[] {
  if (!name) return [];
  for (const [re, p] of PLANS) if (re.test(name)) return p;
  return ['Develop pieces toward the centre, castle early, and connect your rooks before starting operations.'];
}
