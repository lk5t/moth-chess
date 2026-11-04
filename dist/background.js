const W = [{ id: "lichess", label: "Lichess", hosts: ["lichess.org"], origin: "https://lichess.org/*", adapter: "chessground", matches: ["https://lichess.org/*"], liveDom: [".rclock.running", ".rclock .time.running", ".storm--play", ".racer--play"], allow: [{ path: "^/analysis(/|$)", context: "analysis" }, { path: "^/practice/", context: "practice" }, { path: "^/study/(?!broadcast)[A-Za-z0-9]{8}(/[A-Za-z0-9]{8})?/?$", context: "study" }, { path: "^/editor(/|$)", context: "board editor" }], review: [{ path: "^/[A-Za-z0-9]{8}(/(white|black))?/?$", context: "finished game", requireDom: [".result-wrap", ".rcontrols .follow-up", ".status .result"], pendingReason: "Engine help turns on here once the game has finished" }, { path: "^/training(/[A-Za-z0-9]{5,}|/[a-zA-Z]+)?/?$", context: "solved puzzle", requireDom: [".puzzle__feedback.after", ".puzzle__vote", ".puzzle__more"], pendingReason: "Engine help turns on once you have solved or failed this puzzle" }], block: [{ path: "^/(tv|games|streak|storm|racer|tournament|swiss|simul|broadcast|setup|challenge)\\b", reason: "Live, timed or competitive Lichess page" }, { path: "^/[A-Za-z0-9]{12}/?$", reason: "Lichess game in progress (player view)" }], unsupportedReason: "This Lichess page has no board MOTH can analyse" }, { id: "chesscom", label: "Chess.com", hosts: ["chess.com", "www.chess.com"], origin: "https://www.chess.com/*", adapter: "chesscom", matches: ["https://www.chess.com/*"], liveDom: [".clock-component.clock-running", ".clock-component.clock-player-turn", ".clock-player-turn", '[data-cy="clock-running"]', ".board-layout-player .clock-running", ".puzzle-rush-timer", ".puzzle-battle-timer"], allow: [{ path: "^/analysis(/|$)", context: "analysis" }, { path: "^/play/computer(/|$)", context: "computer" }, { path: "^/(lessons|drills|practice)/", context: "lesson" }, { path: "^/(explorer|openings)(/|$)", context: "explorer" }], review: [{ path: "^/game/(live|daily)/\\d+/?$", context: "finished game", requireDom: [".game-over-modal-content", ".game-over-header-component", ".game-result-component", '[data-cy="game-over"]'], pendingReason: "Engine help turns on here once the game has finished" }, { path: "^/game/(computer|\\d+)(/|$)", context: "finished game", requireDom: [".game-over-modal-content", ".game-result-component"], pendingReason: "Engine help turns on here once the game has finished" }, { path: "^/puzzles?(/(rated|learning|problem/\\d+)?)?/?$", context: "solved puzzle", requireDom: [".puzzle-feedback-solved", ".bottom-content-solved", '[data-cy="puzzle-solved"]', '[data-cy="puzzle-failed"]', ".puzzle-feedback-incorrect"], pendingReason: "Engine help turns on once you have solved or failed this puzzle" }], block: [{ path: "^/(play|live|game|daily|tournament|tournaments|arena|puzzles?/(rush|battle)|puzzle-rush|puzzle-battle|variants|votechess)\\b", reason: "Live, rated or competitive Chess.com page" }], unsupportedReason: "This Chess.com page has no board MOTH can analyse" }], G = {
  sites: W
}, D = G.sites.map((e) => ({
  id: e.id,
  label: e.label,
  hosts: e.hosts,
  origin: e.origin,
  adapter: e.adapter === "chesscom" ? "chesscom" : "chessground",
  matches: e.matches,
  liveDom: e.liveDom ?? [],
  allow: (e.allow ?? []).map((t) => ({ path: new RegExp(t.path), context: t.context })),
  review: (e.review ?? []).map((t) => ({ path: new RegExp(t.path), context: t.context, requireDom: t.requireDom ?? [], pendingReason: t.pendingReason ?? "Engine help turns on when this page shows a finished game" })),
  block: (e.block ?? []).map((t) => ({ path: new RegExp(t.path), reason: t.reason })),
  unsupportedReason: e.unsupportedReason ?? `Only supported ${e.label} pages`
}));
function B(e) {
  const t = e.toLowerCase();
  return D.find((a) => a.hosts.includes(t));
}
function K(e) {
  const t = B(e.hostname);
  if (!t) return { status: "unsupported", reason: "MOTH does not integrate with this website" };
  const a = e.pathname || "/";
  for (const n of t.liveDom) if (e.has(n)) return { status: "blocked", site: t.id, reason: "Live-game elements (running clocks) detected on this page" };
  for (const n of t.allow) if (n.path.test(a)) return { status: "supported", site: t.id, context: n.context };
  for (const n of t.review)
    if (n.path.test(a))
      return n.requireDom.some((o) => e.has(o)) ? { status: "supported", site: t.id, context: n.context } : { status: "blocked", site: t.id, reason: n.pendingReason, pending: !0 };
  for (const n of t.block) if (n.path.test(a)) return { status: "blocked", site: t.id, reason: n.reason };
  return { status: "unsupported", reason: t.unsupportedReason };
}
function Z(e) {
  if (!e) return { status: "unsupported", reason: "No URL" };
  try {
    const t = new URL(e);
    return t.protocol !== "https:" ? { status: "unsupported", reason: "Not an https page" } : K({ hostname: t.hostname, pathname: t.pathname, has: () => !1 });
  } catch {
    return { status: "unsupported", reason: "Invalid URL" };
  }
}
function F(e) {
  try {
    return B(new URL(e ?? "").hostname);
  } catch {
    return;
  }
}
const Y = "moth-content", J = "moth-overlay", P = 4, Q = {
  enabled: !0,
  performance: { profile: "standard", debounceMs: 140, idleSec: 90 },
  hud: { layout: "full", evalBar: "left", bestMoveSquares: !0, arrowCount: 1, showPv: !0, showStatus: !0, avoidBoard: !0, stableArrow: !0, depthCap: 14 },
  onboarding: { completed: "" },
  ui: { mode: "simple", lastTab: "home", tips: !0 },
  updates: { auto: !0 },
  appearance: { theme: "dark", accent: "violet", overlayOpacity: 0.97, overlayScale: 1, animation: 1 },
  engine: { depth: 18, moveTimeMs: 0, threads: 1, hashMb: 64, multiPv: 3, kind: "moth", reviewKind: "stockfish" },
  moth: { style: "balanced", model: "builtin", ownBook: !0, moveTimeMs: 100, learning: !0, ponder: !0 },
  board: { autoOverlay: !0, autoAnalyse: !0, compactPanel: !0 },
  visual: {
    arrows: !0,
    arrowWidth: 1,
    arrowOpacity: 0.85,
    threatVision: !1,
    squareHighlights: !0,
    evalBar: !0,
    threatLayers: { attacked: !1, undefended: !0, hanging: !0, checks: !0, pins: !0, forks: !0, skewers: !0, kingSafety: !0, defences: !1 }
  },
  intelligence: { detail: "standard", autoSummary: !0, coachingRecommendations: !0 },
  review: { depth: 14 },
  general: { startMinimized: !1, notifications: !0, autoAnalyse: !0 }
}, c = {
  depth: [1, 30],
  moveTimeMs: [0, 6e4],
  // Clamped again by the engine to the `Threads` max it reports (the bundled lite build is single-threaded → 1).
  threads: [1, 8],
  hashMb: [16, 512],
  multiPv: [1, 5],
  overlayOpacity: [0.4, 1],
  overlayScale: [0.75, 1.4],
  animation: [0, 1],
  arrowWidth: [0.5, 2],
  arrowOpacity: [0.2, 1],
  reviewDepth: [8, 22],
  mothMoveTime: [5, 5e3],
  debounceMs: [30, 1e3],
  idleSec: [10, 600],
  arrowCount: [0, 3],
  depthCap: [6, 24]
}, f = (e, [t, a], n) => {
  const o = typeof e == "number" ? e : Number(e);
  return Number.isFinite(o) ? Math.min(a, Math.max(t, o)) : n;
}, l = (e, t, a) => Math.round(f(e, t, a)), r = (e, t) => typeof e == "boolean" ? e : t, u = (e, t, a) => t.includes(e) ? e : a;
function X(e) {
  const t = e && typeof e == "object" ? e : {}, a = Q, n = t.appearance ?? {}, o = t.engine ?? {}, s = t.visual ?? {}, i = t.intelligence ?? {}, m = t.general ?? {}, w = t.review ?? {}, d = t.moth ?? {}, M = t.board ?? {}, N = s.threatLayers ?? {}, k = t.performance ?? {}, h = t.hud ?? {}, z = t.onboarding ?? {};
  return {
    settingsVersion: P,
    enabled: r(t.enabled, a.enabled),
    performance: {
      profile: u(k.profile, ["eco", "standard", "performance", "custom"], a.performance.profile),
      debounceMs: l(k.debounceMs, c.debounceMs, a.performance.debounceMs),
      idleSec: l(k.idleSec, c.idleSec, a.performance.idleSec)
    },
    hud: {
      layout: u(h.layout, ["full", "compact"], a.hud.layout),
      evalBar: u(h.evalBar, ["left", "right", "off"], a.hud.evalBar),
      bestMoveSquares: r(h.bestMoveSquares, a.hud.bestMoveSquares),
      arrowCount: l(h.arrowCount, c.arrowCount, a.hud.arrowCount),
      showPv: r(h.showPv, a.hud.showPv),
      showStatus: r(h.showStatus, a.hud.showStatus),
      avoidBoard: r(h.avoidBoard, a.hud.avoidBoard),
      stableArrow: r(h.stableArrow, a.hud.stableArrow),
      depthCap: l(h.depthCap, c.depthCap, a.hud.depthCap)
    },
    ui: {
      mode: u((t.ui ?? {}).mode, ["simple", "full"], a.ui.mode),
      lastTab: typeof (t.ui ?? {}).lastTab == "string" && /^[a-z]{2,16}$/.test(t.ui.lastTab) ? t.ui.lastTab : a.ui.lastTab,
      tips: r((t.ui ?? {}).tips, a.ui.tips)
    },
    updates: { auto: r((t.updates ?? {}).auto, a.updates.auto) },
    onboarding: { completed: typeof z.completed == "string" && z.completed.length <= 20 ? z.completed : a.onboarding.completed },
    appearance: {
      theme: u(n.theme, ["dark", "light", "system"], a.appearance.theme),
      accent: u(n.accent, ["violet", "indigo", "teal", "rose", "amber"], a.appearance.accent),
      overlayOpacity: f(n.overlayOpacity, c.overlayOpacity, a.appearance.overlayOpacity),
      overlayScale: f(n.overlayScale, c.overlayScale, a.appearance.overlayScale),
      animation: f(n.animation, c.animation, a.appearance.animation)
    },
    engine: {
      depth: l(o.depth, c.depth, a.engine.depth),
      moveTimeMs: l(o.moveTimeMs, c.moveTimeMs, a.engine.moveTimeMs),
      threads: l(o.threads, c.threads, a.engine.threads),
      hashMb: l(o.hashMb, c.hashMb, a.engine.hashMb),
      multiPv: l(o.multiPv, c.multiPv, a.engine.multiPv),
      kind: u(o.kind, ["moth", "stockfish"], a.engine.kind),
      reviewKind: u(o.reviewKind, ["moth", "stockfish"], a.engine.reviewKind)
    },
    moth: {
      style: u(d.style, ["aggressive", "balanced", "defensive"], a.moth.style),
      model: typeof d.model == "string" && /^(builtin|classical|idb:[\w.-]+|file:[\w.-]+)$/.test(d.model) ? d.model : a.moth.model,
      ownBook: r(d.ownBook, a.moth.ownBook),
      moveTimeMs: l(d.moveTimeMs, c.mothMoveTime, a.moth.moveTimeMs),
      learning: r(d.learning, a.moth.learning),
      ponder: r(d.ponder, a.moth.ponder)
    },
    board: {
      autoOverlay: r(M.autoOverlay, a.board.autoOverlay),
      autoAnalyse: r(M.autoAnalyse, a.board.autoAnalyse),
      compactPanel: r(M.compactPanel, a.board.compactPanel)
    },
    visual: {
      arrows: r(s.arrows, a.visual.arrows),
      arrowWidth: f(s.arrowWidth, c.arrowWidth, a.visual.arrowWidth),
      arrowOpacity: f(s.arrowOpacity, c.arrowOpacity, a.visual.arrowOpacity),
      threatVision: r(s.threatVision, a.visual.threatVision),
      squareHighlights: r(s.squareHighlights, a.visual.squareHighlights),
      evalBar: r(s.evalBar, a.visual.evalBar),
      threatLayers: Object.fromEntries(
        Object.entries(a.visual.threatLayers).map(([A, H]) => [A, r(N[A], H)])
      )
    },
    intelligence: {
      detail: u(i.detail, ["brief", "standard", "detailed"], a.intelligence.detail),
      autoSummary: r(i.autoSummary, a.intelligence.autoSummary),
      coachingRecommendations: r(i.coachingRecommendations, a.intelligence.coachingRecommendations)
    },
    review: { depth: l(w.depth, c.reviewDepth, a.review.depth) },
    general: {
      startMinimized: r(m.startMinimized, a.general.startMinimized),
      notifications: r(m.notifications, a.general.notifications),
      autoAnalyse: r(m.autoAnalyse, a.general.autoAnalyse)
    }
  };
}
function $(e) {
  const t = e != null && (typeof e != "object" || Array.isArray(e)), a = !t && e ? e : {}, n = typeof a.settingsVersion == "number" ? a.settingsVersion : e ? 2 : P, o = [], s = { ...a };
  if (n < 3) {
    const m = a.engine ?? {}, w = a.moth ?? {}, d = m.hashMb !== void 0 && m.hashMb !== 64 || m.depth !== void 0 && m.depth !== 18 || w.moveTimeMs !== void 0 && w.moveTimeMs !== 100;
    s.performance = { profile: d ? "custom" : "standard", debounceMs: 140, idleSec: 90 }, o.push(`performance profile → ${s.performance.profile}`), s.hud = { evalBar: a.visual?.evalBar === !1 ? "off" : "left", layout: "full" }, s.onboarding = { completed: e ? "pre-2.1" : "" }, s.ui = { mode: e ? "full" : "simple", lastTab: "analysis", tips: !e }, o.push("HUD settings added", "onboarding marked as seen (existing install)");
  }
  n === 3 && a.hud?.arrowCount === 3 && (s.hud = { ...a.hud, arrowCount: 1 }, o.push("arrows: best move only"));
  const i = X(s);
  return t && o.push("stored settings were unreadable; defaults restored"), { settings: i, from: n, changed: o, corrupt: t };
}
const T = /* @__PURE__ */ new Map(), ee = /* @__PURE__ */ new Set(), I = () => typeof chrome < "u" && !!chrome.storage?.local;
async function b(e) {
  return I() ? (await chrome.storage.local.get(e))[e] : T.get(e);
}
async function v(e, t) {
  if (I()) return chrome.storage.local.set({ [e]: t });
  const a = T.get(e);
  T.set(e, t), ee.forEach((n) => n({ [e]: { newValue: t, oldValue: a } }));
}
const p = "moth.settings.v1", te = "moth.settings.migration";
async function y() {
  return $(await b(p)).settings;
}
async function _() {
  const e = await b(p), t = $(e);
  return (e === void 0 || t.changed.length || e?.settingsVersion !== t.settings.settingsVersion) && (t.corrupt && await v(`${p}.corrupt`, { at: Date.now(), value: String(e).slice(0, 2e3) }), await v(p, t.settings), t.changed.length && await v(te, { at: Date.now(), from: t.from, to: t.settings.settingsVersion, changed: t.changed, corrupt: t.corrupt })), { from: t.from, changed: t.changed, corrupt: t.corrupt };
}
Promise.resolve();
function ae(e) {
  return e.replace(/chrome-extension:\/\/[a-p]{32}/g, "chrome-extension://<id>").replace(/\bhttps?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, (t, a) => `https://${a}/<path>`).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>").replace(/(?:[A-Za-z]:\\|\/(?:home|Users)\/)[^\s"']+/g, "<path>").replace(/\b[a-zA-Z0-9]{24,}\b/g, "<id>");
}
const E = "moth.errors.v1";
let O = Promise.resolve();
function x(e, t) {
  const a = ae(String(t)).slice(0, 400), n = O.then(async () => {
    const o = (await b(E) ?? []).filter((i) => i && typeof i.message == "string"), s = o[o.length - 1];
    s && s.source === e && s.message === a ? (s.count++, s.at = Date.now()) : o.push({ at: Date.now(), source: e, message: a, count: 1 }), await v(E, o.slice(-50));
  });
  return O = n.catch(() => {
  }), n;
}
const ne = "https://api.github.com/repos/lk5t/moth-chess/releases/latest", oe = "https://github.com/lk5t/moth-chess/releases", q = "moth.update.v1", se = 24 * 36e5;
function re(e, t) {
  const a = (s) => s.replace(/^v/i, "").split(/[-+]/)[0].split(".").map((i) => parseInt(i, 10) || 0), n = a(e), o = a(t);
  for (let s = 0; s < Math.max(n.length, o.length); s++) {
    const i = (n[s] ?? 0) - (o[s] ?? 0);
    if (i) return i > 0 ? 1 : -1;
  }
  return 0;
}
async function L() {
  return await b(q) ?? {};
}
async function R(e) {
  await v(q, { ...await L(), ...e });
}
async function ie(e, t) {
  await R({ installed: { from: t, to: e, at: Date.now(), seen: !1 } });
}
async function ce(e, t = {}) {
  const a = await L();
  if (!t.force && a.checkedAt && Date.now() - a.checkedAt < se) return a;
  try {
    const o = await (t.fetcher ?? fetch)(ne, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    if (!o.ok) throw new Error(`GitHub answered ${o.status}`);
    const s = await o.json(), i = String(s.tag_name ?? "").replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+/.test(i)) throw new Error("No release version found");
    await R({ checkedAt: Date.now(), latest: i, url: s.html_url ?? oe, notes: (s.body ?? "").slice(0, 4e3), error: void 0 });
  } catch (o) {
    await R({ checkedAt: Date.now(), error: String(o?.message ?? o) });
  }
  return await L();
}
const le = (e, t) => !!e.latest && re(e.latest, t) > 0, de = (e) => `moth-${e.id}`;
async function ue() {
  const e = [];
  for (const t of D) await chrome.permissions.contains({ origins: [t.origin] }) && e.push(t);
  return e;
}
async function U() {
  const e = await y(), a = (await chrome.scripting.getRegisteredContentScripts()).filter((o) => o.id.startsWith("moth-")).map((o) => o.id);
  if (a.length && await chrome.scripting.unregisterContentScripts({ ids: a }), !e.enabled) return;
  const n = await ue();
  n.length && await chrome.scripting.registerContentScripts(
    n.map((o) => ({ id: de(o), matches: o.matches, js: ["content.js"], runAt: "document_idle", persistAcrossSessions: !0, allFrames: !1 }))
  );
}
const g = /* @__PURE__ */ new Map(), he = (e) => {
  let t = g.get(e);
  return t || (t = { overlays: /* @__PURE__ */ new Set() }, g.set(e, t)), t;
};
chrome.runtime.onConnect.addListener((e) => {
  const t = e.sender?.tab?.id;
  if (e.sender?.id !== chrome.runtime.id || t === void 0) {
    e.disconnect();
    return;
  }
  const a = he(t);
  if (e.name === Y)
    a.content = e, e.onMessage.addListener((n) => a.overlays.forEach((o) => o.postMessage(n))), e.onDisconnect.addListener(() => {
      a.content === e && (a.content = void 0), a.overlays.forEach((n) => n.postMessage({ type: "page", verdict: { status: "unsupported", reason: "Page closed or navigated" } }));
    });
  else if (e.name === J) {
    if (!e.sender?.url?.startsWith(chrome.runtime.getURL("overlay.html"))) {
      e.disconnect();
      return;
    }
    a.overlays.add(e), e.onMessage.addListener((n) => a.content?.postMessage(n)), e.onDisconnect.addListener(() => a.overlays.delete(e)), a.content?.postMessage({ type: "request-board" });
  } else e.disconnect();
});
chrome.tabs.onRemoved.addListener((e) => g.delete(e));
function V(e) {
  for (const t of g.values()) t.content?.postMessage({ type: "teardown", reason: e });
}
async function S() {
  try {
    await U();
  } catch (e) {
    await x("service worker", `content script registration failed: ${String(e?.message ?? e)}`);
  }
}
chrome.runtime.onInstalled.addListener(async (e) => {
  try {
    (await _()).corrupt && await x("settings", "Stored settings were unreadable and were reset to defaults (the original was kept for diagnostics).");
  } catch (t) {
    await x("settings", `migration failed: ${String(t?.message ?? t)}`);
  }
  await S(), (e.reason === "update" || e.reason === "install") && await ie(chrome.runtime.getManifest().version, e.previousVersion), e.reason === "install" && chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});
chrome.runtime.onStartup.addListener(async () => {
  try {
    await _();
  } catch {
  }
  S();
  try {
    if (!(await y()).updates.auto) return;
    const e = chrome.runtime.getManifest().version;
    le(await ce(e), e) && (await chrome.action.setBadgeText({ text: "new" }), await chrome.action.setBadgeBackgroundColor({ color: "#6d4dff" }));
  } catch {
  }
});
chrome.permissions.onAdded.addListener(() => {
  S();
});
chrome.permissions.onRemoved.addListener(() => {
  S(), V("Site access was removed");
});
chrome.storage.onChanged.addListener(async (e, t) => {
  if (t !== "local" || !(p in e)) return;
  const a = e[p].oldValue?.enabled ?? !0, n = e[p].newValue?.enabled ?? !0;
  a !== n && (await U(), n || V("MOTH Chess was disabled"), await chrome.action.setBadgeText({ text: n ? "" : "off" }), await chrome.action.setBadgeBackgroundColor({ color: "#5b4bd6" }));
});
async function me() {
  return (await chrome.tabs.query({ active: !0, currentWindow: !0 }))[0];
}
async function j(e = {}) {
  const t = new URLSearchParams(e).toString(), a = chrome.runtime.getURL(`board.html${t ? "?" + t : ""}`), n = await chrome.tabs.query({ url: chrome.runtime.getURL("board.html") + "*" });
  if (n[0]?.id !== void 0 && !t) {
    await chrome.tabs.update(n[0].id, { active: !0 });
    return;
  }
  await chrome.tabs.create({ url: a });
}
chrome.commands.onCommand.addListener(async (e) => {
  const t = await me(), a = t?.id !== void 0 ? g.get(t.id) : void 0;
  if (e === "open-board") return j();
  if (e === "toggle-overlay") {
    a?.content?.postMessage({ type: "toggle-overlay" });
    return;
  }
  e === "toggle-analysis" && (a?.overlays.size ? a.overlays.forEach((n) => n.postMessage({ type: "command", command: "toggle-analysis" })) : chrome.runtime.sendMessage({ type: "command", command: "toggle-analysis" }).catch(() => {
  }));
});
async function C(e, t) {
  if (!(await y()).enabled) return { state: "disabled" };
  const n = Z(t);
  if (n.status === "unsupported") return { state: "unsupported", reason: n.reason };
  if (n.status === "blocked" && !n.pending) return { state: "blocked", reason: n.reason };
  const o = F(t);
  if (!await chrome.permissions.contains({ origins: [o.origin] })) return { state: "needs-permission", origin: o.origin, label: o.label };
  const s = !!g.get(e)?.content;
  return n.status === "blocked" ? s ? { state: "ready", label: o.label, injected: s } : { state: "pending", reason: n.reason, label: o.label } : { state: "ready", label: o.label, injected: s };
}
chrome.runtime.onMessage.addListener((e, t, a) => t.id !== chrome.runtime.id ? !1 : ((async () => {
  switch (e.type) {
    case "open-board":
      return await j({ ...e.fen ? { fen: e.fen } : {}, ...e.tab ? { tab: e.tab } : {} }), { ok: !0 };
    case "notify":
      return (await y()).general.notifications && chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title: e.title, message: e.message }), { ok: !0 };
    case "tab-status":
      return C(e.tabId, e.url);
    case "inject": {
      const n = await chrome.tabs.get(e.tabId), o = await C(e.tabId, n.url);
      return o.state !== "ready" ? { ok: !1, status: o } : (o.injected ? g.get(e.tabId)?.content?.postMessage({ type: "toggle-overlay" }) : await chrome.scripting.executeScript({ target: { tabId: e.tabId }, files: ["content.js"] }), { ok: !0 });
    }
  }
})().then(a, (n) => a({ ok: !1, error: String(n) })), !0));
export {
  U as syncContentScripts
};
