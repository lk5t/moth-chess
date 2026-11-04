// Builds public/moth-engine/book.json: position-keyed opening knowledge.
//   Sources: lichess-org/chess-openings (CC0) named lines — incl. gambits & traps — and human move
//            statistics from the Lichess open database sample (CC0).
//   Validation: every candidate move is evaluated by Stockfish (searchmoves), so selection is driven
//            by engine soundness, never by popularity alone. Unsound popular moves are tagged 'mistake'
//            and the best reply to them 'refutation'.
// Usage: node --experimental-strip-types scripts/moth/build-book.ts <openings-dir> <games.pgn.gz> [depth]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { MothWasm } from '../../src/moth-engine/wasm.ts';
import { bookKey, type BookMove, type BookTag, type OpeningBook } from '../../src/moth-engine/book.ts';
import { splitPgn, parsePgnGame } from '../../src/moth-engine/training/pgn.ts';
import { TeacherPool } from './teacher.ts';

const [openDir, gamesFile, depthArg] = process.argv.slice(2);
const DEPTH = Number(depthArg ?? 12);
const MAX_PLY = 16;
const engine = await MothWasm.create(readFileSync(new URL('../../public/moth-engine/moth.wasm', import.meta.url)), 8);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface Agg { fen: string; name?: string; eco?: string; moves: Map<string, { san: string; games: number; scoreSum: number; named: Set<string>; nameAfter?: string; ecoAfter?: string }> }
const pos = new Map<string, Agg>();
const nameAt = new Map<string, { name: string; eco: string; depth: number }>();
const touch = (fen: string) => { const k = bookKey(fen); let a = pos.get(k); if (!a) { a = { fen, moves: new Map() }; pos.set(k, a); } return a; };

// 1. named lines
let lines = 0;
for (const f of readdirSync(openDir).filter((x) => x.endsWith('.tsv'))) {
  for (const row of readFileSync(resolve(openDir, f), 'utf8').split('\n').slice(1)) {
    const [eco, name, pgn] = row.split('\t');
    if (!pgn) continue;
    const sans = pgn.replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/).filter(Boolean);
    engine.setFen(START);
    let ok = true;
    for (let i = 0; i < sans.length; i++) {
      const fen = engine.fen();
      const uci = engine.sanToUci(sans[i]);
      if (!uci) { ok = false; break; }
      const a = touch(fen);
      const m = a.moves.get(uci) ?? { san: engine.uciToSan(uci)!, games: 0, scoreSum: 0, named: new Set<string>() };
      m.named.add(name);
      a.moves.set(uci, m);
      engine.play(uci);
      if (i === sans.length - 1) {
        const k = bookKey(engine.fen());
        const prev = nameAt.get(k);
        if (!prev || sans.length < prev.depth) nameAt.set(k, { name, eco, depth: sans.length }); // shortest line names a transposed position
      }
    }
    if (ok) lines++;
  }
}
// 2. human statistics (first MAX_PLY plies)
let humanGames = 0;
const pgnText = gunzipSync(readFileSync(gamesFile)).toString('utf8');
for (const t of splitPgn(pgnText)) {
  const g = parsePgnGame(t);
  if (!g || g.result === '*') continue;
  const white = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
  engine.setFen(START);
  humanGames++;
  for (let i = 0; i < Math.min(MAX_PLY, g.sans.length); i++) {
    const fen = engine.fen();
    const uci = engine.sanToUci(g.sans[i]);
    if (!uci) break;
    const a = touch(fen);
    const m = a.moves.get(uci) ?? { san: engine.uciToSan(uci)!, games: 0, scoreSum: 0, named: new Set<string>() };
    m.games++; m.scoreSum += fen.split(' ')[1] === 'w' ? white : 1 - white;
    a.moves.set(uci, m);
    engine.play(uci);
  }
}
// 3. keep positions that matter: named lines, or moves seen in >= 8 games
const MIN_GAMES = 8;
const work: { key: string; fen: string; moves: string[] }[] = [];
for (const [key, a] of pos) {
  // most-played first so the cap never drops main lines; named-only moves fill the remaining slots
  const keep = [...a.moves.entries()].filter(([, m]) => m.named.size || m.games >= MIN_GAMES)
    .sort((x, y) => y[1].games - x[1].games || y[1].named.size - x[1].named.size).map(([u]) => u);
  if (keep.length) work.push({ key, fen: a.fen, moves: keep.slice(0, 16) });
}
console.log(`named lines ${lines}, human games ${humanGames}, positions ${pos.size}, to validate ${work.length}`);
const teacher = new TeacherPool(2, DEPTH);
await teacher.start();
const t0 = Date.now();
const evals = await teacher.evalMovesMany(work.map((w) => ({ fen: w.fen, moves: w.moves })), DEPTH, (d) => console.log(`  validated ${d}/${work.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`));
teacher.stop();

// 4. assemble with tags
const book: OpeningBook = { format: 'moth-book-1', built: new Date().toISOString(), sources: ['lichess-org/chess-openings (CC0)', 'Lichess open database sample (CC0)'], validation: { engine: 'Stockfish 17.1 lite', depth: DEPTH }, positions: {}, stats: { positions: 0, moves: 0, named: 0, gambits: 0, traps: 0, mistakes: 0, humanGames } };
const mistakeKeys = new Set<string>();
for (let i = 0; i < work.length; i++) {
  const w = work[i], a = pos.get(w.key)!, ev = evals[i];
  if (!ev || !ev.size) continue;
  const best = Math.max(...ev.values());
  const most = Math.max(...w.moves.map((u) => a.moves.get(u)!.games));
  const named = nameAt.get(w.key);
  const out: BookMove[] = [];
  for (const u of w.moves) {
    const m = a.moves.get(u)!;
    const e = ev.get(u);
    if (e === undefined) continue;
    engine.setFen(w.fen);
    const see = engine.see(u);
    const isCheck = (() => { engine.play(u); const c = engine.inCheck(); return c; })();
    const afterKey = bookKey(engine.fen());
    const nameAfter = nameAt.get(afterKey);
    const tags = new Set<BookTag>();
    if (nameAfter) tags.add('named');
    const newName = nameAfter && nameAfter.name !== named?.name ? nameAfter.name : '';
    if (/Gambit/i.test(newName) && !/Declined/i.test(newName)) tags.add('gambit');
    if (/Trap/i.test(newName)) tags.add('trap');
    if (/Attack|Gambit|Aggressive|Assault|Storm/i.test(newName) || isCheck || see < 0) tags.add('aggressive');
    if (/Defen[cs]e|System|Exchange|Solid|Quiet|Classical|Closed/i.test(nameAfter?.name ?? '') && see >= 0 && !isCheck) tags.add('solid');
    if (m.games === most && m.games >= MIN_GAMES) tags.add('main');
    if (e < best - 100 && (m.games >= MIN_GAMES || m.named.size)) { tags.add('mistake'); mistakeKeys.add(afterKey); }
    out.push({ uci: u, san: m.san, games: m.games, score: m.games ? Math.round((m.scoreSum / m.games) * 1000) / 1000 : 0, eval: e, depth: DEPTH, tags: [...tags], ...(nameAfter ? { name: nameAfter.name, eco: nameAfter.eco } : {}) });
  }
  out.sort((x, y) => y.eval - x.eval);
  book.positions[w.key] = { moves: out, ...(named ? { name: named.name, eco: named.eco } : {}) };
}
// refutations: best move in positions reached by a mistake
for (const k of mistakeKeys) { const p = book.positions[k]; if (p?.moves[0] && !p.moves[0].tags.includes('refutation')) p.moves[0].tags.push('refutation'); }
for (const p of Object.values(book.positions)) {
  book.stats.positions++;
  for (const m of p.moves) { book.stats.moves++; if (m.tags.includes('named')) book.stats.named++; if (m.tags.includes('gambit')) book.stats.gambits++; if (m.tags.includes('trap')) book.stats.traps++; if (m.tags.includes('mistake')) book.stats.mistakes++; }
}
writeFileSync(new URL('../../public/moth-engine/book.json', import.meta.url), JSON.stringify(book));
console.log('book', book.stats, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
