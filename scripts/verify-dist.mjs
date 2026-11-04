// Verifies dist/ is a complete, loadable MV3 extension.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const errors = [];
const need = (p) => { if (!existsSync(resolve(dist, p))) errors.push(`missing ${p}`); };

need('manifest.json');
const m = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
if (m.manifest_version !== 3) errors.push('manifest_version must be 3');
need(m.background?.service_worker ?? 'background.js');
need(m.action?.default_popup ?? 'popup.html');
need(m.options_page ?? 'options.html');
for (const s of Object.values(m.icons ?? {})) need(s);
['board.html', 'overlay.html', 'content.js', 'engines/stockfish.js', 'engines/stockfish.wasm'].forEach(need);
const csp = m.content_security_policy?.extension_pages ?? '';
if (!csp.includes("'wasm-unsafe-eval'")) errors.push("extension_pages CSP lacks 'wasm-unsafe-eval' (needed for Stockfish WASM)");
if (/https?:\/\//.test(csp)) errors.push('CSP must not allow remote script origins');
if (existsSync(resolve(dist, 'engines/stockfish.wasm')) && statSync(resolve(dist, 'engines/stockfish.wasm')).size < 100_000)
  errors.push('engines/stockfish.wasm is suspiciously small');
for (const f of ['content.js', 'background.js']) {
  if (existsSync(resolve(dist, f))) {
    const src = readFileSync(resolve(dist, f), 'utf8');
    if (/\bimport\s*\(|^import\s/m.test(src) && f === 'content.js') errors.push('content.js must be a classic script (no imports)');
  }
}
if (errors.length) {
  console.error('[verify] FAILED:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`[verify] dist OK — ${m.name} v${m.version}, MV3, engine + pages present`);
