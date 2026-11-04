// Game/variation state for the built-in analysis board.
import { useCallback, useMemo, useState } from 'react';
import type { MoveRecord, Square } from '@/types';
import { START_FEN, applyMove, gameStatus, parsePgn, validateFen } from '@/chess/position';

export interface GameState {
  rootFen: string;
  moves: MoveRecord[];
  cursor: number; // moves applied
  headers: Record<string, string>;
  gameId?: number;
}

export function useGame(initialFen = START_FEN) {
  const [g, setG] = useState<GameState>({ rootFen: validateFen(initialFen).fen ?? START_FEN, moves: [], cursor: 0, headers: {} });
  const fen = g.cursor === 0 ? g.rootFen : g.moves[g.cursor - 1].fenAfter;
  const lastMove: [Square, Square] | undefined = g.cursor > 0 ? [g.moves[g.cursor - 1].from, g.moves[g.cursor - 1].to] : undefined;
  const history = useMemo(() => [g.rootFen, ...g.moves.slice(0, g.cursor).map((m) => m.fenAfter)].slice(0, -1), [g]);
  const status = useMemo(() => gameStatus(fen, history), [fen, history]);

  const play = useCallback((uci: string): boolean => {
    let ok = false;
    setG((s) => {
      const cur = s.cursor === 0 ? s.rootFen : s.moves[s.cursor - 1].fenAfter;
      const next = s.moves[s.cursor];
      const r = applyMove(cur, uci);
      if (!r) return s;
      ok = true;
      if (next && next.uci === r.uci) return { ...s, cursor: s.cursor + 1 };
      // new variation: truncate future moves (the imported game stays in Memory untouched)
      return { ...s, moves: [...s.moves.slice(0, s.cursor), r], cursor: s.cursor + 1, gameId: s.cursor < s.moves.length ? undefined : s.gameId };
    });
    return ok;
  }, []);

  const goto = useCallback((ply: number) => setG((s) => ({ ...s, cursor: Math.max(0, Math.min(s.moves.length, ply)) })), []);
  const step = useCallback((d: number) => setG((s) => ({ ...s, cursor: Math.max(0, Math.min(s.moves.length, s.cursor + d)) })), []);
  const loadFen = useCallback((f: string) => {
    const v = validateFen(f);
    if (!v.ok || !v.fen) throw new Error(v.error);
    setG({ rootFen: v.fen, moves: [], cursor: 0, headers: {} });
  }, []);
  const loadPgn = useCallback((pgn: string, gameId?: number, toPly?: number) => {
    const p = parsePgn(pgn);
    setG({ rootFen: p.startFen, moves: p.moves, cursor: toPly ?? p.moves.length, headers: p.headers, gameId });
  }, []);
  const loadLine = useCallback((rootFen: string, uciMoves: string[], cursor?: number) => {
    const moves: MoveRecord[] = [];
    let cur = rootFen;
    for (const u of uciMoves) { const r = applyMove(cur, u); if (!r) break; moves.push(r); cur = r.fenAfter; }
    setG({ rootFen, moves, cursor: cursor ?? moves.length, headers: {} });
  }, []);
  const reset = useCallback(() => setG({ rootFen: START_FEN, moves: [], cursor: 0, headers: {} }), []);

  return { state: g, fen, lastMove, status, play, goto, step, loadFen, loadPgn, loadLine, reset };
}
