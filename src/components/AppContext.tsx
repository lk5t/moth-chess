import { createContext, useContext } from 'react';
import type { Orientation, MoveRecord, NeuralTree } from '@/types';
import type { Settings, SettingsPatch } from '@/settings/schema';
import type { AnalysisState } from './useAnalysis';

export type TabId = 'analysis' | 'intelligence' | 'threats' | 'neural' | 'whatif' | 'review' | 'openings' | 'coach' | 'memory' | 'dashboard';

export interface AppCtx {
  surface: 'board' | 'overlay';
  fen: string;
  rootFen: string;
  moves: MoveRecord[];
  cursor: number;
  headers: Record<string, string>;
  gameId?: number;
  orientation: Orientation;
  settings: Settings;
  updateSettings: (p: SettingsPatch) => Promise<void>;
  analysis: AnalysisState;
  play: (uci: string) => boolean;
  goto: (ply: number) => void;
  loadFen: (fen: string) => void;
  loadPgn: (pgn: string, gameId?: number, toPly?: number) => void;
  loadLine: (rootFen: string, uci: string[], cursor?: number) => void;
  setTab: (t: TabId) => void;
  /** Neural Map tree shared across tabs (What-If can send variations into it). */
  tree: NeuralTree | null;
  setTree: (t: NeuralTree | null | ((t: NeuralTree | null) => NeuralTree | null)) => void;
  toast: (msg: string) => void;
  /** Opens the full board page (overlay → board) with a position or a tab. */
  openFull?: (opts: { fen?: string; tab?: TabId }) => void;
}

export const AppContext = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const c = useContext(AppContext);
  if (!c) throw new Error('AppContext missing');
  return c;
}
