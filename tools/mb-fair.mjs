// Чесність старту Марблс: чи не вирішує місце на лотку результат.
//   node tools/mb-fair.mjs [mapId=endurance] [кульок=60] [гонок=10]
// Порядок на лотку дає random.org, тож шанси учасників і так рівні; але якщо
// перші ряди стабільно їдуть попереду, гонка передбачувана. Очікування —
// приблизно порівну по чвертях (у кожній чверті ~гонок·10/4 потраплянь у топ-10).
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
vm.runInThisContext(fs.readFileSync(path.join(PUB, 'marbles.js'), 'utf8'), { filename: 'marbles.js' });
for (const f of fs.readdirSync(path.join(PUB, 'marbles-maps')).filter(n => n.endsWith('.js')).sort()) {
  vm.runInThisContext(fs.readFileSync(path.join(PUB, 'marbles-maps', f), 'utf8'), { filename: f });
}
const map = process.argv[2] || 'endurance', N = +process.argv[3] || 60, runs = +process.argv[4] || 10;
const q = i => Math.min(3, Math.floor(i / (N / 4)));
const top = [0, 0, 0, 0], wins = [0, 0, 0, 0];
for (let r = 0; r < runs; r++) {
  const res = globalThis.mbRunHeadless(Array.from({ length: N }, (_, i) => 'p' + i), { map, seed: 100 + r * 31, maxSec: 300 });
  wins[q(+res.winner.slice(1))]++;
  for (const nk of res.top10) top[q(+nk.slice(1))]++;
  console.log('гонка', r, 'переможець', res.winner, 'топ-10', res.top10.join(','));
}
console.log('переможці по чвертях старту (1-ша — ближче до виходу):', wins.join(' / '));
console.log('потрапляння в топ-10 по чвертях:', top.join(' / '), '(очікування ~' + Math.round(runs * 10 / 4) + ' кожна)');
