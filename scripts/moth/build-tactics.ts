// Bundles a deterministic tactical test suite (Lichess puzzles, CC0) for the extension:
// public/moth-engine/tactics.json — used by the Learning Lab gate and the dashboard.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { MothWasm } from '../../src/moth-engine/wasm.ts';
import { parseLichessPuzzles, pickSuite, CORE_THEMES } from '../../src/moth-engine/training/tactics.ts';
const engine = await MothWasm.create(readFileSync(new URL('../../public/moth-engine/moth.wasm', import.meta.url)), 4);
const all = parseLichessPuzzles(gunzipSync(readFileSync(process.argv[2])).toString('utf8'), engine);
const suite = pickSuite(all, CORE_THEMES, Number(process.argv[3] ?? 12));
writeFileSync(new URL('../../public/moth-engine/tactics.json', import.meta.url), JSON.stringify({ source: 'Lichess puzzle database (CC0), https://database.lichess.org', themes: CORE_THEMES, puzzles: suite }));
console.log(`tactics.json: ${suite.length} puzzles from ${all.length}`);
