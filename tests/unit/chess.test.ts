import { describe, it, expect } from 'vitest';
import {
  START_FEN, applyMove, buildPgn, gameStatus, legalMoves, parsePgn, positionKey, splitPgn, uciLineToSan, validateFen, isPromotionMove, flipTurn,
} from '@/chess/position';

describe('FEN parsing', () => {
  it('accepts the start position and normalises whitespace', () => {
    expect(validateFen(`  ${START_FEN.replace(/ /g, '   ')}  `)).toEqual({ ok: true, fen: START_FEN });
  });
  it('fills missing move counters for 4-field EPD', () => {
    expect(validateFen('8/8/8/8/8/8/8/K6k w - -').fen).toBe('8/8/8/8/8/8/8/K6k w - - 0 1');
  });
  it('rejects malformed FENs with a reason', () => {
    for (const bad of ['', 'not a fen', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1', '8/8/8/8/8/8/8/8 w - - 0 1', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1']) {
      const r = validateFen(bad);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });
  it('rejects positions where the side NOT to move is in check', () => {
    // black king on e8 attacked by white rook on e1, but it is white to move
    expect(validateFen('4k3/8/8/8/8/8/8/4RK2 w - - 0 1').ok).toBe(false);
    expect(validateFen('4k3/8/8/8/8/8/8/4RK2 b - - 0 1').ok).toBe(true);
  });
});

describe('legal moves', () => {
  it('has 20 moves from the start', () => expect(legalMoves(START_FEN)).toHaveLength(20));
  it('applies UCI and SAN, returns null for illegal moves', () => {
    expect(applyMove(START_FEN, 'e2e4')?.san).toBe('e4');
    expect(applyMove(START_FEN, 'Nf3')?.uci).toBe('g1f3');
    expect(applyMove(START_FEN, 'e2e5')).toBeNull();
    expect(applyMove(START_FEN, 'Ke2')).toBeNull();
  });
  it('supports castling both sides', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    expect(applyMove(fen, 'e1g1')?.san).toBe('O-O');
    expect(applyMove(fen, 'e1c1')?.san).toBe('O-O-O');
    // cannot castle through check
    expect(applyMove('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1', 'e1g1')).toBeNull();
  });
  it('supports en passant', () => {
    const fen = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
    const r = applyMove(fen, 'e5f6');
    expect(r?.san).toBe('exf6');
    expect(r?.captured).toBe('p');
  });
  it('supports promotions and under-promotions', () => {
    const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1';
    expect(isPromotionMove(fen, 'a7', 'a8')).toBe(true);
    expect(applyMove(fen, 'a7a8q')?.san).toMatch(/^a8=Q/);
    expect(applyMove(fen, 'a7a8n')?.san).toBe('a8=N');
  });
  it('converts a UCI PV to SAN and stops at the first illegal move (stale PV protection)', () => {
    expect(uciLineToSan(START_FEN, ['e2e4', 'e7e5', 'g1f3']).san).toEqual(['e4', 'e5', 'Nf3']);
    expect(uciLineToSan(START_FEN, ['e2e4', 'e2e4', 'g1f3']).san).toEqual(['e4']);
  });
});

describe('game status', () => {
  it('detects checkmate (fool’s mate)', () => {
    const s = gameStatus('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
    expect(s.checkmate).toBe(true);
    expect(s.winner).toBe('b');
  });
  it('detects stalemate', () => {
    const s = gameStatus('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(s.stalemate).toBe(true);
    expect(s.draw).toBe(true);
  });
  it('detects insufficient material and the fifty-move rule', () => {
    expect(gameStatus('8/8/8/8/8/8/8/K6k w - - 0 1').reason).toBe('insufficient-material');
    expect(gameStatus('8/8/8/8/8/8/R7/K6k w - - 100 80').reason).toBe('fifty-move');
  });
  it('detects threefold repetition from history', () => {
    const f = 'r3k3/8/8/8/8/8/8/4K2R w - - 4 30';
    expect(gameStatus(f, [f, f]).reason).toBe('threefold');
    expect(gameStatus(f, [f]).over).toBe(false);
  });
});

describe('position identity', () => {
  it('ignores an en-passant square that cannot be used', () => {
    expect(positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
  });
  it('keeps a usable en-passant square', () => {
    expect(positionKey('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3')).toContain(' f6');
  });
  it('flipTurn clears ep', () => expect(flipTurn('8/8/8/8/8/8/8/K6k w - e3 0 1')).toBe('8/8/8/8/8/8/8/K6k b - - 0 1'));
});

describe('PGN', () => {
  const pgn = `[Event "Test"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 {develops} Nc6 (2... d6 3. d4) 3. Bb5 a6 $6 4. Ba4 Nf6 5. O-O 1-0`;
  it('parses headers, moves (ignoring comments/variations/NAGs) and result', () => {
    const g = parsePgn(pgn);
    expect(g.headers.White).toBe('Alice');
    expect(g.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O']);
    expect(g.result).toBe('1-0');
    expect(g.moves[8].fenBefore).toBe(g.moves[7].fenAfter);
  });
  it('supports a FEN start position', () => {
    const g = parsePgn('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]\n\n1. e4 Kd7 *');
    expect(g.startFen).toBe('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
    expect(g.moves).toHaveLength(2);
  });
  it('throws on illegal PGN', () => expect(() => parsePgn('1. e4 e5 2. Ke3 Qh4 3. Kxh4 *')).toThrow());
  it('splits multi-game files', () => {
    expect(splitPgn(`${pgn}\n\n[Event "Two"]\n\n1. d4 d5 *\n`)).toHaveLength(2);
  });
  it('round-trips through buildPgn', () => {
    const g = parsePgn(pgn);
    const out = buildPgn({ headers: g.headers, moves: g.moves.map((m) => ({ san: m.san })), result: g.result });
    expect(parsePgn(out).moves.map((m) => m.uci)).toEqual(g.moves.map((m) => m.uci));
  });
  it('writes black-to-move starts with "N..."', () => {
    const out = buildPgn({ startFen: '4k3/8/8/8/8/8/4P3/4K3 b - - 0 7', moves: [{ san: 'Kd7' }, { san: 'e4' }] });
    expect(out).toContain('7... Kd7 8. e4');
    expect(out).toContain('[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 7"]');
  });
});
