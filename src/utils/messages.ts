// Message protocol between content script ⇄ background ⇄ overlay frame / pages.
import type { Arrow, Square } from '@/types';
import type { BoardReading } from '@/content/adapters/adapters';
import type { PageVerdict } from '@/content/detector/sites';

export const PORT_CONTENT = 'moth-content';
export const PORT_OVERLAY = 'moth-overlay';

export interface Highlight { square: Square; color: string; opacity: number; label?: string }

/** content → overlay (relayed by background, scoped to the same tab) */
export type ContentToOverlay =
  | { type: 'board'; reading: BoardReading }
  | { type: 'page'; verdict: PageVerdict }
  | { type: 'overlay-visibility'; visible: boolean };

/** overlay → content */
export type OverlayToContent =
  | { type: 'draw'; arrows: Arrow[]; highlights: Highlight[] }
  | { type: 'request-board' }
  | { type: 'close' };

/** background → content/overlay */
export type BackgroundMessage =
  | { type: 'teardown'; reason: string }
  | { type: 'toggle-overlay' }
  | { type: 'command'; command: 'toggle-analysis' };

/** one-shot runtime messages */
export type RuntimeRequest =
  | { type: 'open-board'; fen?: string; tab?: string }
  | { type: 'notify'; title: string; message: string }
  | { type: 'tab-status'; tabId: number; url?: string }
  | { type: 'inject'; tabId: number };

export type TabStatus =
  | { state: 'disabled' }
  | { state: 'unsupported'; reason: string }
  | { state: 'blocked'; reason: string }
  | { state: 'needs-permission'; origin: string; label: string }
  | { state: 'ready'; label: string; injected: boolean };
