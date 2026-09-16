// Headless-прогін гонки Марблс без браузера: Rapier у node, DOM-заглушки,
// marbles.js + карти як classic-скрипти в цьому ж контексті.
//   node tools/mb-headless.mjs [N=194] [runs=1] [seed=1] [mapId]
// Друкує стадії траси і результат mbRunHeadless: час, фінішери, вибулі,
// телепорти, вильоти, підштовхування, мс/крок, час першого/10-го/половини.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const R = (await import(pathToFileURL(path.join(PUB, 'vendor', 'rapier3d-compat.mjs')).href)).default;
await R.init();
globalThis.RAPIER = R;
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, createElement: () => ({ getContext: () => ({}) }) };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => 0;
vm.runInThisContext(fs.readFileSync(path.join(PUB, 'marbles.js'), 'utf8'), { filename: 'marbles.js' });
const mapsDir = path.join(PUB, 'marbles-maps');
for (const f of fs.readdirSync(mapsDir).filter(n => n.endsWith('.js')).sort()) {
  vm.runInThisContext(fs.readFileSync(path.join(mapsDir, f), 'utf8'), { filename: f });
}
const mb = globalThis;

const N = parseInt(process.argv[2] || '194', 10);
const runs = parseInt(process.argv[3] || '1', 10);
const seedBase = parseInt(process.argv[4] || '1', 10);
const MAP = process.argv[5] || undefined;
const t0 = performance.now();
const info = mb.mbTrackInfo(MAP);
console.log('track', JSON.stringify(info), 'build ms', Math.round(performance.now() - t0));
const T = mb.mbTrack(MAP);
for (const s of T.stages) console.log('  stage', s.id.padEnd(8), 's0', Math.round(s.s0), 'len', Math.round(s.s1 - s.s0), 'branches', s.branches);
for (let r = 0; r < runs; r++) {
  // детермінований порядок: перемішування за сідом
  let seed = seedBase + r * 7919;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const nicks = Array.from({ length: N }, (_, i) => 'p' + (i + 1));
  for (let i = nicks.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [nicks[i], nicks[j]] = [nicks[j], nicks[i]]; }
  const t1 = performance.now();
  const res = mb.mbRunHeadless(nicks, { maxSec: 320, map: MAP, seed: seedBase + r * 7919 });
  const wall = Math.round(performance.now() - t1);
  const { oobLog, ...rest } = res;
  console.log('RUN', r, JSON.stringify(rest), 'wall ms', wall);
  if (oobLog.length) console.log('  oob', JSON.stringify(oobLog.slice(0, 12)));
}
