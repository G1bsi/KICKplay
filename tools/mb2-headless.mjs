// Headless-прогін «Шариків 2.0»: node tools/mb2-headless.mjs [N=1000] [map=neon] [maxSec=180]
// Друкує: мс/кадр (фізика), час першого/половини/останнього фінішу, вибулих, поштовхів, повернень на трасу.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public', 'marbles2', 'mb2-core.js'), 'utf8'));
const N = parseInt(process.argv[2] || '1000', 10), mapId = process.argv[3] || 'neon', maxSec = parseFloat(process.argv[4] || '180');
const map = MB2Core.loadMap(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'marbles2', 'maps', mapId + '.json'), 'utf8')));
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const s = MB2Core.createSim(Array.from({ length: N }, (_, i) => 'p' + i), map, rnd);
for (let k = 0; k < 60; k++) MB2Core.step(s);   // осідають у контейнері
MB2Core.openGate(s);
let ms = 0, steps = 0, maxMs = 0; const marks = {};
const t0 = performance.now();
while (!s.done && s.raceT < maxSec) {
  const a = performance.now(); MB2Core.step(s); const d = performance.now() - a; ms += d; steps++; if (d > maxMs) maxMs = d;
  const f = s.finishOrder.length;
  if (f >= 1 && marks.first == null) marks.first = s.raceT.toFixed(1);
  if (f >= N / 2 && marks.half == null) marks.half = s.raceT.toFixed(1);
  if (steps % 600 === 0) {
    const zones = [0, 0, 0]; let leader = -1e9; for (let i = 0; i < N; i++) { if (s.alive[i]) zones[s.zone[i]]++; if (s.prog[i] > leader) leader = s.prog[i]; }
    console.log('t=' + s.raceT.toFixed(0), 'zones', zones.join('/'), 'fin', f, 'elim', s.eliminated.length, 'lead', leader.toFixed(0) + '/' + map.len.toFixed(0), 'ms/step', (ms / steps).toFixed(2));
  }
}
console.log(JSON.stringify({ N, time: s.raceT.toFixed(1), finished: s.finishOrder.length, eliminated: s.eliminated.length, done: s.done, marks, kicks: s.kicks, oob: s.oob, strikes: s.strikes.length, struck: s.strikes.reduce((a, e) => a + e.hit.length, 0),
  msPerStep: (ms / steps).toFixed(2), maxMs: maxMs.toFixed(1), wall: Math.round(performance.now() - t0) }));
