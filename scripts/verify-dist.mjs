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
['board.html', 'overlay.html', 'control.html', 'welcome.html', 'icons/moth.svg', 'content.js', 'engines/stockfish.js', 'engines/stockfish.wasm',
  'moth-worker.js', 'moth-train-worker.js', 'moth-engine/moth.wasm', 'moth-engine/book.json', 'moth-engine/tactics.json', 'moth-engine/models/registry.json'].forEach(need);
if (existsSync(resolve(dist, 'moth-engine/models/registry.json'))) {
  const reg = JSON.parse(readFileSync(resolve(dist, 'moth-engine/models/registry.json'), 'utf8'));
  for (const mdl of reg.models ?? []) need(`moth-engine/models/${mdl.file}`);
  if (reg.active && !(reg.models ?? []).some((x) => x.id === reg.active)) errors.push(`registry active model ${reg.active} is not listed`);
}
if (existsSync(resolve(dist, 'moth-worker.js')) && /\bimport\s*\(|^import\s/m.test(readFileSync(resolve(dist, 'moth-worker.js'), 'utf8')))
  errors.push('moth-worker.js must be a classic worker script (no imports)');
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
// fair-play rules (compiled in from /fair-play/sites.json): every site's origin must be requestable and embeddable
const rules = JSON.parse(readFileSync(resolve(dist, '../fair-play/sites.json'), 'utf8'));
for (const site of rules.sites) {
  if (!(m.optional_host_permissions ?? []).includes(site.origin)) errors.push(`fair-play site ${site.id}: ${site.origin} missing from optional_host_permissions`);
  if (!(m.web_accessible_resources?.[0]?.matches ?? []).includes(site.origin)) errors.push(`fair-play site ${site.id}: ${site.origin} missing from web_accessible_resources matches`);
  for (const pat of site.matches) if (!pat.startsWith(site.origin.replace(/\*$/, ''))) errors.push(`fair-play site ${site.id}: match ${pat} is outside ${site.origin}`);
  for (const r of [...(site.allow ?? []), ...(site.review ?? []), ...(site.block ?? [])]) { try { new RegExp(r.path); } catch { errors.push(`fair-play site ${site.id}: invalid regex ${r.path}`); } }
}
if (errors.length) {
  console.error('[verify] FAILED:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`[verify] dist OK — ${m.name} v${m.version}, MV3, engine + pages present`);
