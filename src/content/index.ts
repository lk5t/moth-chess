// MOTH Chess content script. Injected ONLY on permitted analysis pages (see detector/sites.ts).
// Responsibilities: fair-play page classification (continuously), reading the visible board,
// hosting the overlay frame in a closed Shadow DOM, drawing arrows/highlights (pointer-events: none).
// It never makes moves, never interacts with the site's game logic, and does not hide itself.
import { classifyPage, siteById, type PageVerdict, type SiteId } from './detector/sites';
import { ADAPTERS, type BoardReading } from './adapters/adapters';
import { arrowPath, squareCenter, squareOrigin } from './arrows/geometry';
import { clampToViewport, defaultOverlayState, dragTo, resizeTo, placeAvoiding, evalBarSide, BAR_H, MINI_W, type OverlayState, type Rect } from './overlay/layout';
import { PORT_CONTENT, type Highlight } from '@/utils/messages';
import type { Arrow } from '@/types';
import { loadSettings, subscribeSettings } from '@/settings/store';
import type { Settings } from '@/settings/schema';

declare global { interface Window { __mothChess?: { teardown(reason: string): void; toggle(): void } } }

const STATE_KEY = 'moth.overlay.state.v1';

const probe = () => ({ hostname: location.hostname, pathname: location.pathname, has: (s: string) => !!document.querySelector(s) });

async function main() {
  if (window.__mothChess) { window.__mothChess.toggle(); return; }
  const settings = await loadSettings();
  if (!settings.enabled) return;
  const verdict = classifyPage(probe());
  if (verdict.status !== 'supported') return;
  start(verdict.site, settings);
}

function start(site: SiteId, initialSettings: Settings) {
  let settings = initialSettings;
  const adapter = ADAPTERS[siteById(site).adapter];
  const cleanups: (() => void)[] = [];
  let alive = true;
  let reading: BoardReading | null = null;
  let lastSent = '';
  let arrows: Arrow[] = [];
  let highlights: Highlight[] = [];
  let evalBar: { white: number; label: string } | null = null;
  let boardEl: HTMLElement | null = null;

  // ---------- shadow DOM host ----------
  const host = document.createElement('moth-chess-host');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .layer { position: fixed; pointer-events: none; overflow: visible; }
      .frame { position: fixed; pointer-events: auto; display: flex; flex-direction: column; border-radius: 14px; overflow: hidden;
        background: #15141f; border: 1px solid rgba(155,135,255,.38); box-shadow: 0 16px 44px rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.4);
        font: 12px/1.2 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color: #eeebfb; transition: opacity .15s; }
      .frame.hidden { display: none; }
      .bar { height: ${BAR_H}px; flex: 0 0 ${BAR_H}px; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 10px; cursor: grab; user-select: none;
        background: #100f19; border-bottom: 1px solid #24223a; }
      .bar.dragging { cursor: grabbing; }
      .bar img { width: 18px; height: 18px; }
      .title { font-weight: 800; letter-spacing: .12em; flex: 1; white-space: nowrap; }
      .title small { font-weight: 500; letter-spacing: .02em; color: #8a84a8; margin-left: 8px; }
      .btn { all: unset; width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; cursor: pointer; color: #b9b3d6; font-size: 15px; }
      .btn:hover { background: rgba(139,123,255,.18); color: #fff; }
      .btn:focus-visible { outline: 2px solid #8b7bff; }
      iframe { flex: 1; border: 0; width: 100%; background: #15141f; color-scheme: normal; }
      .frame.min iframe, .frame.min .resize { display: none; }
      .frame.dragging iframe { pointer-events: none; }
      .resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 50%, rgba(139,123,255,.6) 50%); }
    </style>
    <svg class="layer" xmlns="http://www.w3.org/2000/svg"></svg>
    <div class="frame" role="dialog" aria-label="MOTH Chess analysis overlay">
      <div class="bar" title="Drag to move">
        <img alt="" src="${chrome.runtime.getURL('icons/moth.svg')}">
        <div class="title">MOTH<small>analysis · beta</small></div>
        <button class="btn" data-act="dock" aria-label="Place beside the board" title="Place beside the board">⇆</button>
        <button class="btn" data-act="min" aria-label="Minimise" title="Minimise">–</button>
        <button class="btn" data-act="close" aria-label="Close overlay" title="Close (Alt+Shift+M to reopen)">×</button>
      </div>
      <iframe title="MOTH Chess overlay" src="${chrome.runtime.getURL('overlay.html')}" allow=""></iframe>
      <div class="resize" title="Resize"></div>
    </div>`;
  document.documentElement.appendChild(host);
  const svg = root.querySelector('svg') as SVGSVGElement;
  const frame = root.querySelector('.frame') as HTMLDivElement;
  const bar = root.querySelector('.bar') as HTMLDivElement;
  const resizer = root.querySelector('.resize') as HTMLDivElement;
  cleanups.push(() => host.remove());

  // ---------- messaging ----------
  const port = chrome.runtime.connect({ name: PORT_CONTENT });
  const send = (m: unknown) => { try { port.postMessage(m); } catch { /* port closed */ } };
  // ---------- overlay state ----------
  let state: OverlayState = defaultOverlayState(innerWidth, innerHeight, settings.general.startMinimized);
  const applyState = () => {
    state = clampToViewport(state, innerWidth, innerHeight);
    frame.style.left = state.x + 'px';
    frame.style.top = state.y + 'px';
    frame.style.width = (state.minimized ? MINI_W : state.w) + 'px';
    frame.style.height = (state.minimized ? BAR_H : state.h) + 'px';
    frame.style.opacity = String(settings.appearance.overlayOpacity);
    frame.classList.toggle('min', state.minimized);
    frame.classList.toggle('hidden', state.hidden);
    svg.style.display = state.hidden ? 'none' : '';
    const visible = !state.hidden && !state.minimized;
    if (visible !== lastVisible) { lastVisible = visible; send({ type: 'overlay-visibility', visible }); }
  };
  let lastVisible: boolean | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => chrome.storage.local.set({ [STATE_KEY]: state }), 250); };
  chrome.storage.local.get(STATE_KEY).then((r) => {
    // supported boards are recognised automatically; the overlay opens on its own unless the user turned that off
    if (r[STATE_KEY]) state = { ...state, ...r[STATE_KEY], hidden: !settings.board.autoOverlay, minimized: settings.general.startMinimized || !!r[STATE_KEY].minimized };
    else state = { ...state, hidden: !settings.board.autoOverlay };
    applyState();
    autoPlace();
  });
  applyState();

  const onBtn = (e: Event) => {
    const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
    if (act === 'min') { state.minimized = !state.minimized; applyState(); persist(); }
    if (act === 'close') { state.hidden = true; applyState(); persist(); }
    if (act === 'dock') { state.userPlaced = false; autoPlace(true); persist(); }
  };
  bar.addEventListener('click', onBtn);

  const startPointer = (mode: 'drag' | 'resize') => (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-act]')) return;
    e.preventDefault();
    const s0 = { px: e.clientX, py: e.clientY, x: state.x, y: state.y, w: state.w, h: state.h };
    frame.classList.add('dragging'); bar.classList.add('dragging');
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - s0.px) + Math.abs(ev.clientY - s0.py) > 3) moved = true;
      state = mode === 'drag' ? dragTo(state, s0, ev.clientX, ev.clientY, innerWidth, innerHeight) : resizeTo(state, s0, ev.clientX, ev.clientY, innerWidth, innerHeight);
      applyState();
    };
    let moved = false;
    const up = () => {
      if (moved) state.userPlaced = true;
      frame.classList.remove('dragging'); bar.classList.remove('dragging');
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      persist();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  bar.addEventListener('pointerdown', startPointer('drag'));
  resizer.addEventListener('pointerdown', startPointer('resize'));
  // keep the panel off the board and the site's own controls until the user places it themselves
  const rectOf = (el: Element): Rect => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  const autoPlace = (force = false) => {
    if (!boardEl || state.hidden || (!force && (state.userPlaced || !settings.hud.avoidBoard))) return;
    const next = placeAvoiding(state, rectOf(boardEl), (adapter.avoid?.(document) ?? []).map(rectOf), innerWidth, innerHeight, { keepIfClear: !force });
    if (next.x !== state.x || next.y !== state.y) { state = next; applyState(); }
  };
  const onResize = () => { applyState(); autoPlace(); scheduleLayer(); };
  window.addEventListener('resize', onResize);
  cleanups.push(() => window.removeEventListener('resize', onResize));

  port.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'draw': arrows = msg.arrows ?? []; highlights = msg.highlights ?? []; evalBar = msg.evalBar ?? null; drawLayer(); break;
      case 'request-board': lastSent = ''; publishBoard(); send({ type: 'page', verdict: classifyPage(probe()) }); send({ type: 'overlay-visibility', visible: !state.hidden && !state.minimized }); break;
      case 'close': state.hidden = true; applyState(); persist(); break;
      case 'toggle-overlay': toggle(); break;
      case 'teardown': teardown(msg.reason ?? 'disabled'); break;
    }
  });
  port.onDisconnect.addListener(() => teardown('Extension reloaded or disabled'));
  cleanups.push(() => { try { port.disconnect(); } catch { /* */ } });

  const offSettings = subscribeSettings((s) => {
    settings = s;
    if (!s.enabled) teardown('MOTH Chess was disabled');
    else { applyState(); autoPlace(); drawLayer(); }
  });
  cleanups.push(offSettings);

  // ---------- board reading ----------
  const publishBoard = () => {
    if (!alive) return;
    if (!boardEl || !boardEl.isConnected) attachBoard();
    if (!boardEl) return;
    const r = adapter.read(boardEl, document, location);
    if (!r) return;
    reading = r;
    const sig = JSON.stringify(r);
    if (sig !== lastSent) { lastSent = sig; send({ type: 'board', reading: r }); arrows = []; highlights = []; drawLayer(); }
    scheduleLayer();
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const onBoardChange = () => { clearTimeout(debounce); debounce = setTimeout(publishBoard, 120); };
  let mo: MutationObserver | null = null;
  let ro: ResizeObserver | null = null;
  const attachBoard = () => {
    const el = adapter.findBoard(document);
    if (el === boardEl) return;
    mo?.disconnect(); ro?.disconnect();
    const replaced = !!boardEl;
    boardEl = el;
    if (!el) { reading = null; drawLayer(); return; }
    mo = new MutationObserver(onBoardChange);
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    // orientation / size classes that live on wrappers (e.g. Lichess .cg-wrap.orientation-black)
    for (const t of adapter.watchTargets?.(el) ?? []) mo.observe(t, { attributes: true, attributeFilter: ['class', 'style'] });
    ro = new ResizeObserver(() => { scheduleLayer(); onBoardChange(); });
    ro.observe(el);
    if (replaced) console.info('[MOTH Chess] board replaced by the page — reattached');
    autoPlace();
  };
  // boards that load late or are replaced by single-page navigation: react to DOM insertions (cheap check)
  let attachTimer: ReturnType<typeof setTimeout> | undefined;
  const docObserver = new MutationObserver(() => {
    if (boardEl && boardEl.isConnected) return;
    clearTimeout(attachTimer);
    attachTimer = setTimeout(() => { lastSent = ''; publishBoard(); }, 150);
  });
  docObserver.observe(document.documentElement, { childList: true, subtree: true });
  cleanups.push(() => { mo?.disconnect(); ro?.disconnect(); docObserver.disconnect(); clearTimeout(debounce); clearTimeout(attachTimer); });

  // ---------- arrow / highlight layer ----------
  let raf = 0;
  const scheduleLayer = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; positionLayer(); }); };
  const positionLayer = () => {
    if (!boardEl) return;
    const r = boardEl.getBoundingClientRect();
    svg.style.left = r.left + 'px';
    svg.style.top = r.top + 'px';
    svg.setAttribute('width', String(r.width));
    svg.setAttribute('height', String(r.height));
    svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    drawLayer();
  };
  const onScroll = () => scheduleLayer();
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  cleanups.push(() => { window.removeEventListener('scroll', onScroll, { capture: true }); cancelAnimationFrame(raf); });

  const NS = 'http://www.w3.org/2000/svg';
  const drawLayer = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!reading || !boardEl) { host.removeAttribute('data-moth-layer'); return; }
    const size = Number(svg.getAttribute('width')) || boardEl.getBoundingClientRect().width;
    if (!size) return;
    const o = reading.orientation;
    // best move (engine line 1 = rank 0): outline its start and destination squares
    const best = settings.hud.bestMoveSquares ? arrows.find((a) => a.rank === 0) : undefined;
    if (best) for (const sq of [best.from, best.to]) {
      const p = squareOrigin(sq, size, o);
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(p.x + 1.5)); rect.setAttribute('y', String(p.y + 1.5));
      rect.setAttribute('width', String(size / 8 - 3)); rect.setAttribute('height', String(size / 8 - 3));
      rect.setAttribute('fill', best.color); rect.setAttribute('fill-opacity', '0.18');
      rect.setAttribute('stroke', best.color); rect.setAttribute('stroke-opacity', '0.8'); rect.setAttribute('stroke-width', '2');
      svg.appendChild(rect);
    }
    // evaluation bar beside the board (White's winning chance), on the side of the board nearer White
    let barSide: 'left' | 'right' | null = null;
    if (evalBar && settings.hud.evalBar !== 'off') {
      const w = Math.max(6, Math.round(size / 48));
      barSide = evalBarSide(settings.hud.evalBar, rectOf(boardEl), innerWidth, w);
      const x = barSide === 'left' ? -w - 4 : size + 4;
      const whiteH = size * Math.max(0, Math.min(1, evalBar.white));
      const bg = document.createElementNS(NS, 'rect');
      bg.setAttribute('x', String(x)); bg.setAttribute('y', '0'); bg.setAttribute('width', String(w)); bg.setAttribute('height', String(size));
      bg.setAttribute('rx', '3'); bg.setAttribute('fill', '#23202e'); bg.setAttribute('stroke', 'rgba(139,123,255,.6)');
      svg.appendChild(bg);
      const fg = document.createElementNS(NS, 'rect');
      fg.setAttribute('x', String(x)); fg.setAttribute('width', String(w)); fg.setAttribute('height', String(whiteH)); fg.setAttribute('rx', '3');
      fg.setAttribute('y', String(o === 'white' ? size - whiteH : 0)); fg.setAttribute('fill', '#eceaf6');
      svg.appendChild(fg);
      const t = document.createElementNS(NS, 'title'); t.textContent = `MOTH evaluation: ${evalBar.label}`; bg.appendChild(t);
    }
    for (const h of highlights) {
      const p = squareOrigin(h.square, size, o);
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(p.x)); rect.setAttribute('y', String(p.y));
      rect.setAttribute('width', String(size / 8)); rect.setAttribute('height', String(size / 8));
      rect.setAttribute('fill', h.color); rect.setAttribute('fill-opacity', String(h.opacity));
      svg.appendChild(rect);
    }
    for (const a of [...arrows].sort((x, y) => y.rank - x.rank)) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', arrowPath(a.from, a.to, size, o, a.width));
      path.setAttribute('fill', a.color);
      path.setAttribute('fill-opacity', String(a.opacity));
      svg.appendChild(path);
    }
    // geometry for verification (tests, debugging): where each arrow starts/ends in viewport pixels
    const br = boardEl.getBoundingClientRect();
    host.setAttribute('data-moth-layer', JSON.stringify({
      board: { x: Math.round(br.left * 10) / 10, y: Math.round(br.top * 10) / 10, size: Math.round(size * 10) / 10, orientation: o },
      layer: { x: parseFloat(svg.style.left), y: parseFloat(svg.style.top) },
      arrows: arrows.map((a) => { const f = squareCenter(a.from, size, o), t = squareCenter(a.to, size, o); return { from: a.from, to: a.to, rank: a.rank, x1: f.x + br.left, y1: f.y + br.top, x2: t.x + br.left, y2: t.y + br.top }; }),
      evalBar: barSide ? evalBar?.label ?? null : null,
      evalBarSide: barSide,
      panel: { x: state.x, y: state.y, w: state.minimized ? MINI_W : state.w, h: state.minimized ? BAR_H : state.h, hidden: state.hidden, userPlaced: !!state.userPlaced },
    }));
  };

  // ---------- fair-play watchdog ----------
  let lastPath = location.pathname;
  const watchdog = setInterval(() => {
    const v: PageVerdict = classifyPage(probe());
    if (v.status !== 'supported') { send({ type: 'page', verdict: v }); teardown(v.reason); return; }
    if (location.pathname !== lastPath) { lastPath = location.pathname; lastSent = ''; publishBoard(); }
    if (!boardEl || !boardEl.isConnected) publishBoard();
  }, 800);
  cleanups.push(() => clearInterval(watchdog));
  // single-page navigation: re-check fair play and the board immediately instead of waiting for the poll
  const nav = (window as any).navigation as EventTarget | undefined;
  const onNav = () => setTimeout(() => {
    const v: PageVerdict = classifyPage(probe());
    if (v.status !== 'supported') { send({ type: 'page', verdict: v }); teardown(v.reason); return; }
    send({ type: 'page', verdict: v });
    lastPath = location.pathname; lastSent = ''; publishBoard();
  }, 50);
  nav?.addEventListener('navigatesuccess', onNav);
  window.addEventListener('popstate', onNav);
  cleanups.push(() => { nav?.removeEventListener('navigatesuccess', onNav); window.removeEventListener('popstate', onNav); });
  const onVis = () => { if (document.visibilityState === 'visible') publishBoard(); };
  document.addEventListener('visibilitychange', onVis);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

  function toggle() { state.hidden = !state.hidden; applyState(); persist(); if (!state.hidden) publishBoard(); }

  function teardown(reason: string) {
    if (!alive) return;
    alive = false;
    console.info(`[MOTH Chess] overlay removed: ${reason}`);
    cleanups.reverse().forEach((c) => { try { c(); } catch { /* ignore */ } });
    delete window.__mothChess;
  }

  window.__mothChess = { teardown, toggle };
  publishBoard();
}

void main();
