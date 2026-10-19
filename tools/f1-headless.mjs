// Перевірка гонки без браузера: тисячі заїздів чистим ядром f1race.js.
//   node tools/f1-headless.mjs [гонок=500]
// Головне — «переможець не той» має бути 0: переможця визначає random.org
// (перший у перестановці), режисура гонки мусить довести його до прапора.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'public', 'f1race.js'), 'utf8'), { filename: 'f1race.js' });
const S = globalThis.F1_SIM;
const T = S.buildTrack();
console.log('траса', Math.round(T.L), 'м, еталонне коло', T.lapRef.toFixed(1), 'с');

const runs = +process.argv[2] || 500;
let bad = 0, drama = 0;
const sec = [], ot = [], lc = [];
for (let r = 0; r < runs; r++) {
  const n = 6 + (r % 15), laps = 1 + (r % 3);
  const order = Array.from({ length: n }, (_, i) => 'p' + ((i * 7 + r) % 97));
  const res = S.runHeadless(order, { track: T, laps, seed: 1000 + r * 7919 });
  if (!res.winnerOk) { bad++; if (bad < 6) console.log('ПРОВАЛ', JSON.stringify(res), 'пілотів', n, 'кіл', laps); }
  if (res.troubles) drama++;
  sec.push(res.raceSec / laps); ot.push(res.overtakes); lc.push(res.leadChanges);
}
const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
console.log('гонок', runs, '| переможець не той:', bad, '| с/коло', avg(sec), '| обгонів', avg(ot), '| змін лідера', avg(lc), '| фінальна драма', (drama / runs * 100).toFixed(1) + '%');
process.exitCode = bad ? 1 : 0;
