// Copies the single-threaded "lite" Stockfish WASM build from node_modules/stockfish
// into public/engines/ as stockfish.js + stockfish.wasm (same base name, so the
// Emscripten loader finds its .wasm next to itself).
//
// Why lite-single:
//  * single-threaded → no SharedArrayBuffer → no cross-origin-isolation (COOP/COEP)
//    requirements, which extension iframes embedded in web pages cannot satisfy;
//  * "lite" uses the small NNUE net (~7 MB) instead of the ~75 MB full net.
// Licence: Stockfish is GPL-3.0; its licence text is copied alongside.
import { readdirSync, copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = resolve(root, 'node_modules/stockfish');
const outDir = resolve(root, 'public/engines');
mkdirSync(outDir, { recursive: true });

if (!existsSync(pkgDir)) {
  console.warn('[copy-engine] node_modules/stockfish not found — run `npm install` first. Skipping.');
  process.exit(0);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(pkgDir);
const pick = (re) => files.filter((f) => re.test(f.replace(/\\/g, '/'))).sort();
// Prefer "lite-single", then any "single" build.
let js = pick(/lite-single[^/]*\.js$/)[0] ?? pick(/single[^/]*\.js$/)[0];
if (!js) {
  console.error('[copy-engine] Could not find a single-threaded Stockfish build in node_modules/stockfish.');
  console.error('Files present:\n' + files.map((f) => '  ' + f).join('\n'));
  process.exit(1);
}
const wasm = js.replace(/\.js$/, '.wasm');
if (!existsSync(wasm)) {
  console.error(`[copy-engine] Found ${js} but no matching ${wasm}`);
  process.exit(1);
}

// Rename so the loader resolves "stockfish.wasm" — patch any hard-coded original wasm file name.
const origWasmName = wasm.split(/[\\/]/).pop();
let src = readFileSync(js, 'utf8');
if (src.includes(origWasmName)) src = src.split(origWasmName).join('stockfish.wasm');
writeFileSync(resolve(outDir, 'stockfish.js'), src);
copyFileSync(wasm, resolve(outDir, 'stockfish.wasm'));

const lic = files.find((f) => /(^|[\\/])(Copying\.txt|COPYING|LICENSE(\.md|\.txt)?)$/i.test(f));
if (lic) copyFileSync(lic, resolve(outDir, 'STOCKFISH-LICENSE.txt'));

const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'));
writeFileSync(
  resolve(outDir, 'engine.json'),
  JSON.stringify({ name: 'Stockfish', package: `stockfish@${pkg.version}`, source: js.slice(pkgDir.length + 1).replace(/\\/g, '/'), build: 'lite single-threaded WASM', license: 'GPL-3.0' }, null, 2),
);
console.log(`[copy-engine] ${js.slice(pkgDir.length + 1)} → public/engines/stockfish.{js,wasm} (stockfish@${pkg.version})`);
