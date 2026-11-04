// Local opening database with ECO codes. Entries are matched by *position* (not move string),
// so transpositions are recognised regardless of move order.
import { START_FEN, applyMove, positionKey } from '@/chess/position';

export interface OpeningEntry { eco: string; name: string; moves: string }

// prettier-ignore
export const OPENINGS: OpeningEntry[] = [
  { eco: 'A00', name: 'Polish Opening', moves: 'b4' },
  { eco: 'A00', name: 'Grob Opening', moves: 'g4' },
  { eco: 'A01', name: 'Nimzo-Larsen Attack', moves: 'b3' },
  { eco: 'A02', name: "Bird's Opening", moves: 'f4' },
  { eco: 'A03', name: "Bird's Opening: Dutch Variation", moves: 'f4 d5' },
  { eco: 'A04', name: 'Réti Opening', moves: 'Nf3' },
  { eco: 'A05', name: 'Réti Opening', moves: 'Nf3 Nf6' },
  { eco: 'A06', name: 'Réti Opening', moves: 'Nf3 d5' },
  { eco: 'A07', name: "King's Indian Attack", moves: 'Nf3 d5 g3' },
  { eco: 'A09', name: 'Réti Opening', moves: 'Nf3 d5 c4' },
  { eco: 'A10', name: 'English Opening', moves: 'c4' },
  { eco: 'A13', name: 'English Opening: Agincourt Defence', moves: 'c4 e6' },
  { eco: 'A15', name: 'English Opening: Anglo-Indian Defence', moves: 'c4 Nf6' },
  { eco: 'A16', name: 'English Opening: Anglo-Indian Defence', moves: 'c4 Nf6 Nc3' },
  { eco: 'A20', name: "English Opening: King's English Variation", moves: 'c4 e5' },
  { eco: 'A22', name: "English Opening: King's English, Two Knights", moves: 'c4 e5 Nc3 Nf6' },
  { eco: 'A25', name: 'English Opening: Reversed Sicilian, Closed', moves: 'c4 e5 Nc3 Nc6' },
  { eco: 'A30', name: 'English Opening: Symmetrical Variation', moves: 'c4 c5' },
  { eco: 'A40', name: "Queen's Pawn Game", moves: 'd4' },
  { eco: 'A41', name: "Queen's Pawn Game: Modern Defence", moves: 'd4 d6' },
  { eco: 'A43', name: 'Old Benoni Defence', moves: 'd4 c5' },
  { eco: 'A45', name: 'Indian Defence', moves: 'd4 Nf6' },
  { eco: 'A45', name: 'Trompowsky Attack', moves: 'd4 Nf6 Bg5' },
  { eco: 'A46', name: 'Indian Defence: Knights Variation', moves: 'd4 Nf6 Nf3' },
  { eco: 'A46', name: 'Indian Defence: London System', moves: 'd4 Nf6 Nf3 e6 Bf4' },
  { eco: 'A51', name: 'Budapest Gambit', moves: 'd4 Nf6 c4 e5' },
  { eco: 'A52', name: 'Budapest Gambit', moves: 'd4 Nf6 c4 e5 dxe5 Ng4' },
  { eco: 'A56', name: 'Benoni Defence', moves: 'd4 Nf6 c4 c5' },
  { eco: 'A57', name: 'Benko Gambit', moves: 'd4 Nf6 c4 c5 d5 b5' },
  { eco: 'A60', name: 'Modern Benoni', moves: 'd4 Nf6 c4 c5 d5 e6' },
  { eco: 'A80', name: 'Dutch Defence', moves: 'd4 f5' },
  { eco: 'A81', name: 'Dutch Defence: Fianchetto Attack', moves: 'd4 f5 g3' },
  { eco: 'A83', name: 'Dutch Defence: Staunton Gambit', moves: 'd4 f5 e4' },
  { eco: 'A84', name: 'Dutch Defence', moves: 'd4 f5 c4' },
  { eco: 'B00', name: "King's Pawn Game", moves: 'e4' },
  { eco: 'B00', name: 'Nimzowitsch Defence', moves: 'e4 Nc6' },
  { eco: 'B00', name: "Owen's Defence", moves: 'e4 b6' },
  { eco: 'B01', name: 'Scandinavian Defence', moves: 'e4 d5' },
  { eco: 'B01', name: 'Scandinavian Defence: Main Line', moves: 'e4 d5 exd5 Qxd5' },
  { eco: 'B01', name: 'Scandinavian Defence: Modern Variation', moves: 'e4 d5 exd5 Nf6' },
  { eco: 'B02', name: "Alekhine's Defence", moves: 'e4 Nf6' },
  { eco: 'B03', name: "Alekhine's Defence", moves: 'e4 Nf6 e5 Nd5 d4' },
  { eco: 'B06', name: 'Modern Defence', moves: 'e4 g6' },
  { eco: 'B07', name: 'Pirc Defence', moves: 'e4 d6 d4 Nf6 Nc3 g6' },
  { eco: 'B10', name: 'Caro-Kann Defence', moves: 'e4 c6' },
  { eco: 'B12', name: 'Caro-Kann Defence: Advance Variation', moves: 'e4 c6 d4 d5 e5' },
  { eco: 'B13', name: 'Caro-Kann Defence: Exchange Variation', moves: 'e4 c6 d4 d5 exd5' },
  { eco: 'B15', name: 'Caro-Kann Defence', moves: 'e4 c6 d4 d5 Nc3' },
  { eco: 'B17', name: 'Caro-Kann Defence: Karpov Variation', moves: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7' },
  { eco: 'B18', name: 'Caro-Kann Defence: Classical Variation', moves: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5' },
  { eco: 'B20', name: 'Sicilian Defence', moves: 'e4 c5' },
  { eco: 'B21', name: 'Sicilian Defence: Smith-Morra Gambit', moves: 'e4 c5 d4 cxd4 c3' },
  { eco: 'B22', name: 'Sicilian Defence: Alapin Variation', moves: 'e4 c5 c3' },
  { eco: 'B23', name: 'Sicilian Defence: Closed', moves: 'e4 c5 Nc3' },
  { eco: 'B27', name: 'Sicilian Defence', moves: 'e4 c5 Nf3' },
  { eco: 'B30', name: 'Sicilian Defence: Old Sicilian', moves: 'e4 c5 Nf3 Nc6' },
  { eco: 'B30', name: 'Sicilian Defence: Rossolimo Variation', moves: 'e4 c5 Nf3 Nc6 Bb5' },
  { eco: 'B32', name: 'Sicilian Defence: Open', moves: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4' },
  { eco: 'B33', name: 'Sicilian Defence: Sveshnikov Variation', moves: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5' },
  { eco: 'B40', name: 'Sicilian Defence: French Variation', moves: 'e4 c5 Nf3 e6' },
  { eco: 'B41', name: 'Sicilian Defence: Kan Variation', moves: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6' },
  { eco: 'B44', name: 'Sicilian Defence: Taimanov Variation', moves: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6' },
  { eco: 'B50', name: 'Sicilian Defence: Modern Variations', moves: 'e4 c5 Nf3 d6' },
  { eco: 'B51', name: 'Sicilian Defence: Moscow Variation', moves: 'e4 c5 Nf3 d6 Bb5+' },
  { eco: 'B54', name: 'Sicilian Defence: Open', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4' },
  { eco: 'B56', name: 'Sicilian Defence: Open', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3' },
  { eco: 'B56', name: 'Sicilian Defence: Classical Variation', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6' },
  { eco: 'B60', name: 'Sicilian Defence: Richter-Rauzer Variation', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5' },
  { eco: 'B70', name: 'Sicilian Defence: Dragon Variation', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6' },
  { eco: 'B80', name: 'Sicilian Defence: Scheveningen Variation', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 e6' },
  { eco: 'B90', name: 'Sicilian Defence: Najdorf Variation', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6' },
  { eco: 'C00', name: 'French Defence', moves: 'e4 e6' },
  { eco: 'C01', name: 'French Defence: Exchange Variation', moves: 'e4 e6 d4 d5 exd5' },
  { eco: 'C02', name: 'French Defence: Advance Variation', moves: 'e4 e6 d4 d5 e5' },
  { eco: 'C03', name: 'French Defence: Tarrasch Variation', moves: 'e4 e6 d4 d5 Nd2' },
  { eco: 'C10', name: 'French Defence: Paulsen Variation', moves: 'e4 e6 d4 d5 Nc3' },
  { eco: 'C10', name: 'French Defence: Rubinstein Variation', moves: 'e4 e6 d4 d5 Nc3 dxe4' },
  { eco: 'C11', name: 'French Defence: Classical Variation', moves: 'e4 e6 d4 d5 Nc3 Nf6' },
  { eco: 'C15', name: 'French Defence: Winawer Variation', moves: 'e4 e6 d4 d5 Nc3 Bb4' },
  { eco: 'C20', name: "King's Pawn Game", moves: 'e4 e5' },
  { eco: 'C21', name: 'Center Game', moves: 'e4 e5 d4 exd4' },
  { eco: 'C23', name: "Bishop's Opening", moves: 'e4 e5 Bc4' },
  { eco: 'C24', name: "Bishop's Opening: Berlin Defence", moves: 'e4 e5 Bc4 Nf6' },
  { eco: 'C25', name: 'Vienna Game', moves: 'e4 e5 Nc3' },
  { eco: 'C26', name: 'Vienna Game: Falkbeer Variation', moves: 'e4 e5 Nc3 Nf6' },
  { eco: 'C29', name: 'Vienna Gambit', moves: 'e4 e5 Nc3 Nf6 f4' },
  { eco: 'C30', name: "King's Gambit", moves: 'e4 e5 f4' },
  { eco: 'C31', name: "King's Gambit Declined: Falkbeer Countergambit", moves: 'e4 e5 f4 d5' },
  { eco: 'C33', name: "King's Gambit Accepted", moves: 'e4 e5 f4 exf4' },
  { eco: 'C40', name: "King's Knight Opening", moves: 'e4 e5 Nf3' },
  { eco: 'C40', name: 'Latvian Gambit', moves: 'e4 e5 Nf3 f5' },
  { eco: 'C41', name: 'Philidor Defence', moves: 'e4 e5 Nf3 d6' },
  { eco: 'C42', name: 'Petrov Defence', moves: 'e4 e5 Nf3 Nf6' },
  { eco: 'C44', name: "King's Pawn Game: Two Knights", moves: 'e4 e5 Nf3 Nc6' },
  { eco: 'C44', name: 'Ponziani Opening', moves: 'e4 e5 Nf3 Nc6 c3' },
  { eco: 'C44', name: 'Scotch Game', moves: 'e4 e5 Nf3 Nc6 d4' },
  { eco: 'C44', name: 'Scotch Gambit', moves: 'e4 e5 Nf3 Nc6 d4 exd4 Bc4' },
  { eco: 'C45', name: 'Scotch Game', moves: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4' },
  { eco: 'C46', name: 'Three Knights Opening', moves: 'e4 e5 Nf3 Nc6 Nc3' },
  { eco: 'C47', name: 'Four Knights Game', moves: 'e4 e5 Nf3 Nc6 Nc3 Nf6' },
  { eco: 'C50', name: 'Italian Game', moves: 'e4 e5 Nf3 Nc6 Bc4' },
  { eco: 'C50', name: 'Italian Game: Giuoco Piano', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5' },
  { eco: 'C51', name: 'Italian Game: Evans Gambit', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4' },
  { eco: 'C53', name: 'Italian Game: Classical Variation', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3' },
  { eco: 'C55', name: 'Italian Game: Two Knights Defence', moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6' },
  { eco: 'C57', name: 'Italian Game: Two Knights Defence, Knight Attack', moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5' },
  { eco: 'C60', name: 'Ruy Lopez', moves: 'e4 e5 Nf3 Nc6 Bb5' },
  { eco: 'C62', name: 'Ruy Lopez: Steinitz Defence', moves: 'e4 e5 Nf3 Nc6 Bb5 d6' },
  { eco: 'C63', name: 'Ruy Lopez: Schliemann Defence', moves: 'e4 e5 Nf3 Nc6 Bb5 f5' },
  { eco: 'C64', name: 'Ruy Lopez: Classical Variation', moves: 'e4 e5 Nf3 Nc6 Bb5 Bc5' },
  { eco: 'C65', name: 'Ruy Lopez: Berlin Defence', moves: 'e4 e5 Nf3 Nc6 Bb5 Nf6' },
  { eco: 'C68', name: 'Ruy Lopez: Exchange Variation', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6' },
  { eco: 'C70', name: 'Ruy Lopez: Morphy Defence', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4' },
  { eco: 'C78', name: 'Ruy Lopez: Morphy Defence', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O' },
  { eco: 'C84', name: 'Ruy Lopez: Closed', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7' },
  { eco: 'C88', name: 'Ruy Lopez: Closed', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3' },
  { eco: 'C89', name: 'Ruy Lopez: Marshall Attack', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5' },
  { eco: 'D00', name: "Queen's Pawn Game", moves: 'd4 d5' },
  { eco: 'D00', name: 'Blackmar-Diemer Gambit', moves: 'd4 d5 e4' },
  { eco: 'D00', name: "Queen's Pawn Game: Accelerated London System", moves: 'd4 d5 Bf4' },
  { eco: 'D02', name: "Queen's Pawn Game: Zukertort Variation", moves: 'd4 d5 Nf3' },
  { eco: 'D02', name: "Queen's Pawn Game: London System", moves: 'd4 d5 Nf3 Nf6 Bf4' },
  { eco: 'D06', name: "Queen's Gambit", moves: 'd4 d5 c4' },
  { eco: 'D07', name: "Queen's Gambit Declined: Chigorin Defence", moves: 'd4 d5 c4 Nc6' },
  { eco: 'D08', name: "Queen's Gambit Declined: Albin Countergambit", moves: 'd4 d5 c4 e5' },
  { eco: 'D10', name: 'Slav Defence', moves: 'd4 d5 c4 c6' },
  { eco: 'D11', name: 'Slav Defence', moves: 'd4 d5 c4 c6 Nf3' },
  { eco: 'D15', name: 'Slav Defence: Three Knights', moves: 'd4 d5 c4 c6 Nf3 Nf6 Nc3' },
  { eco: 'D20', name: "Queen's Gambit Accepted", moves: 'd4 d5 c4 dxc4' },
  { eco: 'D30', name: "Queen's Gambit Declined", moves: 'd4 d5 c4 e6' },
  { eco: 'D31', name: "Queen's Gambit Declined", moves: 'd4 d5 c4 e6 Nc3' },
  { eco: 'D35', name: "Queen's Gambit Declined: Exchange Variation", moves: 'd4 d5 c4 e6 Nc3 Nf6 cxd5' },
  { eco: 'D37', name: "Queen's Gambit Declined: Three Knights", moves: 'd4 d5 c4 e6 Nc3 Nf6 Nf3' },
  { eco: 'D43', name: 'Semi-Slav Defence', moves: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6' },
  { eco: 'D80', name: 'Grünfeld Defence', moves: 'd4 Nf6 c4 g6 Nc3 d5' },
  { eco: 'D85', name: 'Grünfeld Defence: Exchange Variation', moves: 'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5' },
  { eco: 'E00', name: 'Catalan Opening', moves: 'd4 Nf6 c4 e6 g3' },
  { eco: 'E00', name: 'Indian Defence: East Indian', moves: 'd4 Nf6 c4 e6' },
  { eco: 'E10', name: 'Indian Defence: Anglo-Indian', moves: 'd4 Nf6 c4 e6 Nf3' },
  { eco: 'E11', name: 'Bogo-Indian Defence', moves: 'd4 Nf6 c4 e6 Nf3 Bb4+' },
  { eco: 'E12', name: "Queen's Indian Defence", moves: 'd4 Nf6 c4 e6 Nf3 b6' },
  { eco: 'E20', name: 'Nimzo-Indian Defence', moves: 'd4 Nf6 c4 e6 Nc3 Bb4' },
  { eco: 'E32', name: 'Nimzo-Indian Defence: Classical Variation', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2' },
  { eco: 'E40', name: 'Nimzo-Indian Defence: Rubinstein Variation', moves: 'd4 Nf6 c4 e6 Nc3 Bb4 e3' },
  { eco: 'E60', name: "King's Indian Defence", moves: 'd4 Nf6 c4 g6' },
  { eco: 'E61', name: "King's Indian Defence", moves: 'd4 Nf6 c4 g6 Nc3' },
  { eco: 'E70', name: "King's Indian Defence: Normal Variation", moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4' },
  { eco: 'E73', name: "King's Indian Defence: Averbakh System", moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Be2' },
  { eco: 'E80', name: "King's Indian Defence: Sämisch Variation", moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3' },
  { eco: 'E90', name: "King's Indian Defence: Classical Variation", moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3' },
];

export interface IndexedOpening extends OpeningEntry { key: string; ply: number; uci: string[] }
export interface Continuation { san: string; uci: string; resultKey: string; opening?: IndexedOpening }

let index: { byKey: Map<string, IndexedOpening>; edges: Map<string, Map<string, Continuation>>; invalid: string[] } | null = null;

/** Build (once) the position index and the move tree used by the explorer. */
export function openingIndex() {
  if (index) return index;
  const byKey = new Map<string, IndexedOpening>();
  const edges = new Map<string, Map<string, Continuation>>();
  const invalid: string[] = [];
  for (const o of OPENINGS) {
    let fen = START_FEN;
    const uci: string[] = [];
    let ok = true;
    for (const san of o.moves.split(' ')) {
      const r = applyMove(fen, san);
      if (!r) { ok = false; invalid.push(`${o.eco} ${o.name}: illegal ${san}`); break; }
      const from = positionKey(fen);
      const to = positionKey(r.fenAfter);
      if (!edges.has(from)) edges.set(from, new Map());
      edges.get(from)!.set(r.uci, { san: r.san, uci: r.uci, resultKey: to });
      uci.push(r.uci);
      fen = r.fenAfter;
    }
    if (!ok) continue;
    const key = positionKey(fen);
    const entry: IndexedOpening = { ...o, key, ply: uci.length, uci };
    // keep the most specific (longest) name if two lines reach the same position
    const prev = byKey.get(key);
    if (!prev || prev.ply < entry.ply) byKey.set(key, entry);
  }
  for (const m of edges.values()) for (const c of m.values()) c.opening = byKey.get(c.resultKey);
  index = { byKey, edges, invalid };
  return index;
}

export interface Recognition { opening: IndexedOpening | null; ply: number; inBook: boolean; leftBookAt?: number }

/** Identify the opening for a sequence of FENs (positions after each move, starting position first). */
export function recogniseOpening(fens: string[]): Recognition {
  const { byKey, edges } = openingIndex();
  let best: IndexedOpening | null = null;
  let bestPly = 0;
  let leftBookAt: number | undefined;
  for (let i = 0; i < fens.length; i++) {
    const k = positionKey(fens[i]);
    const hit = byKey.get(k);
    if (hit) { best = hit; bestPly = i; }
    if (leftBookAt === undefined && i > 0 && !byKey.has(k) && !edges.has(k)) {
      // position not reachable in the book tree
      const prevKey = positionKey(fens[i - 1]);
      const inTree = [...(edges.get(prevKey)?.values() ?? [])].some((c) => c.resultKey === k);
      if (!inTree) leftBookAt = i;
    }
  }
  const last = positionKey(fens[fens.length - 1] ?? START_FEN);
  return { opening: best, ply: bestPly, inBook: byKey.has(last) || edges.has(last), leftBookAt };
}

export function lookupPosition(fen: string): IndexedOpening | undefined {
  return openingIndex().byKey.get(positionKey(fen));
}

/** Book continuations from this position (from the local database — not popularity statistics). */
export function continuations(fen: string): Continuation[] {
  return [...(openingIndex().edges.get(positionKey(fen))?.values() ?? [])];
}

export function searchOpenings(q: string): OpeningEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return OPENINGS;
  return OPENINGS.filter((o) => o.name.toLowerCase().includes(s) || o.eco.toLowerCase().startsWith(s) || o.moves.toLowerCase().includes(s));
}
