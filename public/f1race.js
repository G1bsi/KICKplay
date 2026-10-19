// ─────────────────────────────────────────────────────────────
//  🏎️ ГОНКА — Гран-прі у стилі прямого ефіру F1.
//  Classic script, підключається ПІСЛЯ app.js (користується state, rollPick,
//  addWinner, phase, escapeHtml). Публічно: window.startF1Race(n, laps),
//  window.closeF1Race(), window.F1_SIM (чисте ядро для тестів у node).
//
//  Чесність: переможця визначає random.org — перший у перестановці rollPick.
//  Сама гонка — режисура навколо цього результату: старт, боротьба, слипстрим,
//  обгони, помилки. Ядро (траса + симуляція) не чіпає DOM і детерміноване від сіда.
//  Одиниці — метри й секунди; траса в площині XZ.
// ─────────────────────────────────────────────────────────────
(function () {
'use strict';

// ── Детермінований генератор (xorshift32) — сід на гонку ──
function f1Rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ═════════════════════════════════════════════════════════════
//  ТРАСА: замкнений centripetal Catmull-Rom → рівномірні точки через 1 м
// ═════════════════════════════════════════════════════════════
// Конфігурація в дусі класичних автодромів: довга пряма старт-фінішу, правий
// шпилька, швидкі есси, задня пряма, шпилька, шикана й останній поворот на пряму.
const F1_PTS = [
  [-330, 0], [-150, 0], [60, 0], [230, 0],
  [290, 12], [312, 52], [292, 92], [250, 104],
  [190, 100], [150, 118], [128, 152],
  [110, 196], [60, 214], [10, 196], [-30, 214],
  [-90, 246], [-170, 252],
  [-300, 248], [-420, 244],
  [-478, 222], [-494, 176], [-470, 138],
  [-420, 128], [-400, 100], [-426, 72],
  [-444, 40], [-405, 6],
];
const F1_W = 13;            // ширина полотна, м
const F1_CAR_LEN = 5.6;     // довжина боліда
const F1_CAR_W = 2.0;
const F1_VTOP = 88;         // м/с ≈ 317 км/г
const F1_ALAT = 40;         // бокове прискорення в повороті (~4g)
const F1_ABRK = 45;         // гальмування (~4.6g)

function crPoint(p0, p1, p2, p3, t) {
  const d = (p, q) => Math.sqrt(Math.hypot(q[0] - p[0], q[1] - p[1])) || 1e-4;
  const t0 = 0, t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const L = (p, q, a, b) => { const k = (tt - a) / (b - a); return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]; };
  const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
  return L(L(A1, A2, t0, t2), L(A2, A3, t1, t3), t1, t2);
}

function f1Accel(v) { return 14 * (1 - v / F1_VTOP * 0.85); }

function f1BuildTrack() {
  const P = F1_PTS, n = P.length, raw = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < 48; k++) raw.push(crPoint(P[(i - 1 + n) % n], P[i], P[(i + 1) % n], P[(i + 2) % n], k / 48));
  const cum = [0];
  for (let i = 1; i <= raw.length; i++) { const a = raw[i - 1], b = raw[i % raw.length]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const L = cum[cum.length - 1], N = Math.round(L), ds = L / N;
  const x = new Float32Array(N), z = new Float32Array(N);
  let j = 0;
  for (let k = 0; k < N; k++) {
    const s = k * ds;
    while (cum[j + 1] < s) j++;
    const f = (s - cum[j]) / (cum[j + 1] - cum[j]), a = raw[j], b = raw[(j + 1) % raw.length];
    x[k] = a[0] + (b[0] - a[0]) * f; z[k] = a[1] + (b[1] - a[1]) * f;
  }
  // старт-фініш — посередині стартової прямої (решітка цілком на прямій, а не в повороті):
  // зсуваємо всі масиви так, щоб індекс 0 був на x ≈ -60 головної прямої
  {
    let best = 0, bd = 1e18;
    for (let i = 0; i < N; i++) { const dd = Math.hypot(x[i] + 60, z[i]); if (dd < bd) { bd = dd; best = i; } }
    const roll = arr => { const c = arr.slice(); for (let i = 0; i < N; i++) arr[i] = c[(i + best) % N]; };
    roll(x); roll(z);
  }
  // дотична, ліва нормаль, кривина (за +-3 м — без шуму дискретизації)
  const tx = new Float32Array(N), tz = new Float32Array(N), nx = new Float32Array(N), nz = new Float32Array(N), kap = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    let dx = x[b] - x[a], dz = z[b] - z[a]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    // нормаль n дивиться всередину поворотів із kap > 0: d > 0 — внутрішній бік таких поворотів
    tx[i] = dx; tz[i] = dz; nx[i] = -dz; nz[i] = dx;
    const p = (i - 3 + N) % N, q = (i + 3) % N;
    const h1 = Math.atan2(z[i] - z[p], x[i] - x[p]), h2 = Math.atan2(z[q] - z[i], x[q] - x[i]);
    let dh = h2 - h1; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    kap[i] = dh / (6 * ds);
  }
  // згладжена кривина: апекс «розмазується» на вхід і вихід (для траєкторії й кербів)
  const kapS = new Float32Array(N);
  for (let i = 0; i < N; i++) { let acc = 0; for (let k = -12; k <= 12; k++) acc += kap[(i + k + N) % N]; kapS[i] = acc / 25; }
  // профіль швидкості: межа зчеплення → гальмування назад → розгін уперед (двічі — замкнене коло)
  const v = new Float32Array(N);
  for (let i = 0; i < N; i++) v[i] = Math.min(F1_VTOP, Math.sqrt(F1_ALAT / Math.max(1e-6, Math.abs(kapS[i]))));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) { const nv = v[(i + 1) % N]; v[i] = Math.min(v[i], Math.sqrt(nv * nv + 2 * F1_ABRK * ds)); }
    for (let i = 0; i < N; i++) { const pv = v[(i - 1 + N) % N]; v[i] = Math.min(v[i], Math.sqrt(pv * pv + 2 * f1Accel(pv) * ds)); }
  }
  // «пряма» — де можна обганяти в слипстримі: на 60 м уперед машина не гальмує
  const straight = new Uint8Array(N);
  for (let i = 0; i < N; i++) { let ok = true; for (let k = 0; k < 60; k += 4) if (v[(i + k) % N] < F1_VTOP * 0.82) { ok = false; break; } straight[i] = ok ? 1 : 0; }
  // DRS-зони: прямі довші за 250 м (на коротких відкривати крило немає сенсу)
  const drs = new Uint8Array(N);
  {
    let i0 = -1;
    for (let k = 0; k <= 2 * N; k++) {
      const i = k % N, on = straight[i] === 1;
      if (on && i0 < 0) i0 = k;
      if ((!on || k === 2 * N) && i0 >= 0) { if (k - i0 >= 250 && k - i0 < N) for (let q = i0; q < k; q++) drs[q % N] = 1; i0 = -1; }
    }
  }
  // гоночна траєкторія: зовні на вході, всередині на апексі, зовні на виході
  const line = new Float32Array(N), half = F1_W / 2 - 1.8;
  for (let i = 0; i < N; i++) {
    const kNow = kapS[i], kAhead = kapS[(i + 45) % N], kBack = kapS[(i - 45 + N) % N];
    const t = (kNow * 1.0 - kAhead * 0.55 - kBack * 0.55) * 32;
    line[i] = Math.max(-1, Math.min(1, t)) * half;
  }
  let lapRef = 0; for (let i = 0; i < N; i++) lapRef += ds / v[i];
  return { L, N, ds, x, z, tx, tz, nx, nz, kap, kapS, v, straight, drs, line, W: F1_W, lapRef };
}

// індекс точки за відстанню (з обгортанням)
function f1Idx(T, s) { let i = Math.floor((((s % T.L) + T.L) % T.L) / T.ds); return i >= T.N ? T.N - 1 : i; }

// ═════════════════════════════════════════════════════════════
//  ГОНКА: машини, слипстрим, обгони, помилки, режисура результату
// ═════════════════════════════════════════════════════════════
// Палітра лівреїв у дусі пелетону F1 (кольори команд, без назв і логотипів)
const F1_LIVERY = ['#e10600', '#1e41ff', '#00d2be', '#ff8700', '#006f62', '#fff500', '#2b4562', '#b6babd', '#9b0000', '#469bff',
  '#ff5ec4', '#37bedd', '#c92d4b', '#5e8faa', '#6cd3bf', '#f58020', '#1b3d2f', '#dc0000', '#ffffff', '#7a2fd0', '#2293d1', '#c8a400', '#ff2a6d', '#00a19c'];
const F1_TYRES = ['S', 'M', 'H'];

function f1Code(nick) {
  const letters = String(nick).replace(/[^A-Za-zА-Яа-яЁёІіЇїЄєҐґ0-9]/g, '');
  return (letters.slice(0, 3) || 'DRV').toUpperCase().padEnd(3, 'X');
}

// order — результат random.org (order[0] — переможець). opts: { laps, seed }
function f1CreateRace(T, order, opts) {
  opts = opts || {};
  const rnd = f1Rng(opts.seed || 1);
  const laps = Math.max(1, Math.min(5, opts.laps || 2));
  const n = order.length;
  // стартова решітка: переможець — з поулу (30%) або з P2–P6; решта — випадково.
  // Так і в реальних гонках: фаворит стартує спереду, а інтрига — чи візьме він лідерство
  const winner = order[0];
  const rest = order.slice(1);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
  // в одноколовому спринті фаворит стартує не далі третього місця — інакше обгін усього поля за коло виглядав би ракетою
  const maxBack = laps === 1 ? 2 : (laps === 2 ? 3 : 5);
  const wSlot = n <= 2 ? Math.floor(rnd() * n) : (rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * Math.min(maxBack, n - 1)));
  const grid = rest.slice(); grid.splice(Math.min(wSlot, grid.length), 0, winner);
  const cars = grid.map(function (nick, g) {
    const isW = nick === winner;
    return {
      nick, code: f1Code(nick), idx: order.indexOf(nick), grid: g,
      color: F1_LIVERY[order.indexOf(nick) % F1_LIVERY.length],
      tyre: F1_TYRES[Math.floor(rnd() * 3)],
      // решітка: дві колонки, крок 8 м, перший ряд — за 4 м до лінії
      s: -(4 + g * 8), d: (g % 2 ? -2.7 : 2.7), dT: (g % 2 ? -2.7 : 2.7), gridD: (g % 2 ? -2.7 : 2.7), prevS: -(4 + g * 8), prevD: (g % 2 ? -2.7 : 2.7), v: 0,
      pace: isW ? 1.0 : 0.976 + rnd() * 0.02,      // переможець трохи швидший — решту довершує режисура
      react: 0.16 + rnd() * 0.22, launch: 0.82 + rnd() * 0.22,
      lap: -1, lapStart: 0, lastLap: 0, bestLap: 0, finished: false, finishT: 0, pos: g + 1,
      passing: null, passUntil: 0, mistakeUntil: 0, mistakeK: 1, mistakeSide: 0, smoke: 0,
      boost: 1, drs: false, wheel: 0, yaw: 0, brake: 0, isWinner: isW,
    };
  });
  return {
    T, laps, cars, rnd, t: 0, started: false, lightsOutAt: opts.lightsOutAt != null ? opts.lightsOutAt : 0,
    winner, finishOrder: [], done: false, doneAt: 0, leaderLap: 0, events: [], fastest: null,
    overtakes: 0, leadChanges: 0, contacts: 0, lastLeader: null, forcedMistakes: 0,
  };
}

function f1Event(R, type, data) { R.events.push(Object.assign({ type, t: R.t }, data || {})); if (R.events.length > 60) R.events.shift(); }

function f1StepRace(R, dt) {
  const T = R.T, cars = R.cars, n = cars.length, L = T.L;
  R.t += dt;
  const raceOn = R.t >= R.lightsOutAt;
  // порядок на трасі (за пройденою відстанню)
  const ord = cars.slice().sort(function (a, b) { return b.s - a.s; });
  for (let i = 0; i < n; i++) ord[i].pos = i + 1;
  const leader = ord[0];
  if (raceOn && R.lastLeader && R.lastLeader !== leader && !leader.finished) { R.leadChanges++; f1Event(R, 'lead', { nick: leader.nick }); }
  R.lastLeader = leader;
  const total = R.laps * L;
  const prog = Math.max(0, leader.s) / total;
  const W = cars.find(function (c) { return c.isWinner; });

  // ── режисура результату (переможець від random.org має фінішувати першим) ──
  for (let i = 0; i < n; i++) cars[i].boost = 1;
  if (raceOn && !W.finished) {
    const wPos = W.pos;
    const gapLead = leader === W ? 0 : (leader.s - W.s) / Math.max(30, W.v);
    if (leader === W) {
      // відірвався надто далеко — нудно; трохи стримуємо, щоб боротьба тривала
      const second = ord[1];
      if (second && (W.s - second.s) / Math.max(30, second.v) > 2.2 && prog < 0.9) W.boost = 0.992;
      // у другій половині лідер тримає оборону: атаку на нього не доводять до кінця
      if (prog > 0.5) {
        if (prog > 0.75) W.boost = Math.max(W.boost, 1.01);
        for (let i = 1; i < n; i++) if (ord[i].passing === W || (i === 1 && (W.s - ord[i].s) < 25)) ord[i].boost = Math.min(ord[i].boost, 0.975);
      }
    } else {
      // тиск зростає ближче до фінішу: 0 — далеко, 1 — на останніх метрах
      const remain = total - W.s;
      const urg = Math.max(0, Math.min(1, 1 - remain / (1.2 * L)));
      W.boost = 1.01 + 0.06 * urg;
      if (gapLead > 1.6) W.boost = Math.max(W.boost, 1.02);           // «магніт»: не відпускаємо далеко
      // ті, хто попереду переможця, наприкінці «підсідають» — гума, паливо, тиск
      if (urg > 0.3) for (let i = 0; i < wPos - 1; i++) ord[i].boost = Math.min(ord[i].boost, 1 - 0.03 * urg);
      // остання чверть кола — машина просто попереду помиляється (широкий вихід)
      if (remain < 0.25 * L) {
        const ahead = ord[wPos - 2];
        if (ahead && ahead.mistakeUntil < R.t - 1.5 && (ahead.s - W.s) < 60) {
          ahead.mistakeUntil = R.t + 0.9; ahead.mistakeK = 0.72; ahead.mistakeSide = T.kapS[f1Idx(T, ahead.s)] > 0 ? -1 : 1;
          R.forcedMistakes++; f1Event(R, 'mistake', { nick: ahead.nick });
        }
      }
    }
  }

  // ── абсолютна гарантія результату random.org: фінальна драма ──
  // Якщо лідер уже близько до прапора, а переможець ще не попереду, у машин перед ним
  // «проблема» (прокол, мотор) — вони йдуть до краю й пропускають. Спрацьовує рідко:
  // зазвичай режисура вище встигає раніше. Відстань тригера росте з відривом лідера
  if (raceOn && !W.finished && leader !== W && !R.finalSafety) {
    const leadRemain = total - leader.s;
    if (leadRemain < Math.max(320, (leader.s - W.s) * 1.8 + 200)) R.finalSafety = true;
  }
  if (R.finalSafety && !W.finished) {
    for (let i = 0; i < n; i++) {
      const c = ord[i];
      if (c === W) break;
      if (!c.finished && !c.trouble) { c.trouble = true; c.troubleSide = c.d >= W.d ? 1 : -1; R.troubles = (R.troubles || 0) + 1; f1Event(R, 'trouble', { nick: c.nick }); }
    }
  }

  for (let oi = 0; oi < n; oi++) {
    const c = ord[oi];
    if (!raceOn) { c.v = 0; c.prevS = c.s; c.prevD = c.d; continue; }
    if (c.finished && R.t - c.finishT > 0.1) {
      // коло пошани: повільно котиться далі
      c.v += (Math.min(36, T.v[f1Idx(T, c.s)]) - c.v) * Math.min(1, dt * 0.8);
      c.prevS = c.s; c.prevD = c.d;
      c.s += c.v * dt; c.wheel += c.v * dt / 0.36;
      continue;
    }
    const ti = f1Idx(T, c.s);
    let vRef = T.v[ti] * c.pace * c.boost;
    const vBase = T.v[ti] * c.pace;   // для множника прискорення (буксир/DRS/режисура)
    // старт: реакція на згасання вогнів + пробуксовка першу секунду
    const st = R.t - R.lightsOutAt;
    if (st < c.react) vRef = 0;
    else if (st < c.react + 1.2) vRef *= c.launch;
    // помилка пілота: блокування / широкий вихід — втрата швидкості й дрейф назовні
    if (c.mistakeUntil > R.t) { vRef *= c.mistakeK; c.smoke = 1; }
    else if (c.mistakeUntil === 0 || R.t - c.mistakeUntil > 8) {
      // рідкісні власні помилки на сильному гальмуванні
      const brakeZone = T.v[(ti + 40) % T.N] < T.v[ti] * 0.6;
      if (brakeZone && R.rnd() < 0.0009) { c.mistakeUntil = R.t + 0.6 + R.rnd() * 0.5; c.mistakeK = 0.78; c.mistakeSide = T.kapS[ti] > 0 ? -1 : 1; f1Event(R, 'mistake', { nick: c.nick }); }
    }
    // ── сусіди: слипстрим, DRS, хвіст, обгін, бік-у-бік ──
    const ahead = oi > 0 ? ord[oi - 1] : null;
    const onStraight = T.straight[ti] === 1;
    c.drs = false;
    let dTwant = T.line[ti];
    // розгін до першого повороту: тримаємо свою колону зі стартової решітки (дві-три
    // в ряд), і лише ближче до гальмування збиваємось на траєкторію — «воронка» T1
    if (c.s < 360) { const k = Math.max(0, Math.min(1, (c.s - 120) / 240)); dTwant = c.gridD + (dTwant - c.gridD) * k * k; }
    if (ahead && !ahead.finished) {
      const gapA = ahead.s - c.s - F1_CAR_LEN;
      if (onStraight && gapA < 30 && gapA > -F1_CAR_LEN) vRef *= 1 + 0.05 * (1 - Math.max(0, gapA) / 30);   // слипстрим
      if (T.drs[ti] && c.lap >= 1 && gapA / Math.max(20, c.v) < 1.0) { c.drs = true; vRef *= 1.035; }      // DRS з 2-го кола
      if (!onStraight && gapA < 18 && gapA > 0) vRef *= 0.992;                                          // брудне повітря
    }
    // вистріл зі слипстриму: вийшов з-за спини на прямій — аеродинамічний «буксир» дає
    // запас швидкості, і обгін завершується за 2–3 с, як у трансляціях F1
    if (c.passing && onStraight && Math.abs(c.d - c.passing.d) >= F1_CAR_W + 0.3 && c.s < c.passing.s + F1_CAR_LEN + 2) vRef *= 1.06;
    // атака на гальмуванні: той, хто вже поруч, гальмує пізніше («пірнає» всередину)
    if (c.passing && T.v[(ti + 30) % T.N] < T.v[ti] * 0.85) vRef *= 1.02;
    const vRaw = vRef;
    // найближча машина ПОПЕРЕДУ на моїй смузі (перекриття по ширині)
    let blocker = null, bGap = 1e9;
    const half = F1_W / 2 - 1.2;
    for (let k = 0; k < n; k++) {
      const o = cars[k];
      if (o === c || (o.finished && R.t - o.finishT > 0.1)) continue;
      const ds2 = o.s - c.s;
      if (ds2 <= 0 || ds2 > 14 + c.v * 0.25) continue;
      if (Math.abs(c.d - o.d) >= F1_CAR_W + 0.35) continue;
      const g = ds2 - F1_CAR_LEN;
      if (g < bGap) { bGap = g; blocker = o; }
    }
    // попереду вже той, кого обганяли, — обгін зараховано, можна атакувати наступного
    if (c.passing && c.s > c.passing.s + 0.5 && blocker !== c.passing) {
      R.overtakes++; f1Event(R, 'overtake', { nick: c.nick, on: c.passing.nick }); c.passing = null;
    }
    if (blocker) {
      // швидший — виходимо з-за спини на вільний бік (першим — внутрішній до наступного повороту)
      if (vRaw > blocker.v + 0.3) {
        if (c.passing !== blocker) {
          const kNext = T.kapS[(ti + 70) % T.N];
          const pref = kNext > 0 ? 1 : -1;
          const free = function (side) {
            const pos = blocker.d + side * 2.9;
            if (Math.abs(pos) > half) return false;
            for (let k = 0; k < n; k++) {
              const o = cars[k];
              if (o === c || o === blocker) continue;
              const rel = o.s - c.s;
              if (rel > -F1_CAR_LEN * 0.6 && rel < 14 && Math.abs(o.d - pos) < F1_CAR_W + 0.3) return false;
            }
            return true;
          };
          const side = free(pref) ? pref : (free(-pref) ? -pref : 0);
          if (side) { c.passing = blocker; c.passSide = side; c.passUntil = R.t + 8; R.attempts = (R.attempts || 0) + 1; }
        }
        if (c.passing === blocker) dTwant = Math.max(-half, Math.min(half, blocker.d + c.passSide * 2.9));
      }
      // поки перекриваємось по ширині — не таранимо: сидимо на хвості
      // (переможець у фінальній драмі не чекає за машиною з проблемою — вона вже йде до краю)
      if (!(R.finalSafety && c === W && blocker.trouble)) {
        const want = 2 + c.v * 0.075;         // ~8 м на 300 км/г, ~5 м у повільному повороті
        const cap = blocker.v + Math.max(-4, (bGap - want) * 1.4);
        if (vRef > cap) vRef = cap;
      }
    }
    // обгін завершено (вийшли попереду) або протух — назад на траєкторію
    if (c.passing && (c.s > c.passing.s + F1_CAR_LEN + 2 || R.t > c.passUntil)) {
      if (c.s > c.passing.s) { R.overtakes++; f1Event(R, 'overtake', { nick: c.nick, on: c.passing.nick }); }
      c.passing = null;
    }
    // продовжуємо обгін збоку, навіть коли вже не «за спиною»
    if (c.passing && !blocker) dTwant = Math.max(-half, Math.min(half, c.passing.d + c.passSide * 2.9));
    // бік-у-бік: тримаємо дистанцію по ширині, не зрізаємо в сусіда
    for (let k = 0; k < n; k++) {
      const o = cars[k];
      if (o === c) continue;
      if (Math.abs(o.s - c.s) < F1_CAR_LEN + 0.8) {
        const sep = c.d - o.d;
        if (Math.abs(sep) < F1_CAR_W + 0.5) {
          dTwant = o.d + (sep >= 0 ? 1 : -1) * (F1_CAR_W + 0.6);
          if (Math.abs(sep) < F1_CAR_W - 0.2 && Math.abs(o.s - c.s) < F1_CAR_LEN - 0.4 && k > c.grid) R.contacts++;
        }
      }
    }
    if (c.passing) dTwant = Math.max(-(F1_W / 2 - 1.2), Math.min(F1_W / 2 - 1.2, dTwant));
    if (c.trouble) {
      // кульгає до краю траси з димом; після того як переможець проїхав — доїжджає повільно
      const passedByW = W.s > c.s + F1_CAR_LEN;
      vRef = Math.min(vRef, T.v[ti] * (passedByW ? 0.78 : 0.5));
      dTwant = c.troubleSide * (F1_W / 2 - 1.0);
      c.smoke = Math.max(c.smoke, 0.6);
    }
    if (R.finalSafety && c === W && !c.finished) { dTwant = 0; vRef = Math.max(vRef, T.v[ti] * 1.04); }
    if (c.mistakeUntil > R.t) dTwant = c.mistakeSide * (F1_W / 2 - 0.6);
    c.dT = Math.max(-(F1_W / 2 - 1.0), Math.min(F1_W / 2 - 1.0, dTwant));
    // поздовжня динаміка з межами прискорення/гальмування
    const dv = vRef - c.v;
    const prevV = c.v;
    // слипстрим і DRS зменшують опір: розгін теж кращий, а не лише стеля швидкості.
    // Без цього на розгоні обидва боліди впирались у межу прискорення й ішли «в ногу»
    const accMul = Math.max(0.6, 1 + (vRef / Math.max(1, vBase) - 1) * 4);
    c.v += dv > 0 ? Math.min(dv, f1Accel(c.v) * accMul * dt) : Math.max(dv, -F1_ABRK * dt);
    if (c.v < 0) c.v = 0;
    c.brake = prevV - c.v > 0.3 ? Math.min(1, (prevV - c.v) / (F1_ABRK * dt)) : 0;
    // бокова динаміка: обмежена швидкість зміщення (4.5 м/с)
    const lat = Math.max(-4.5 * dt, Math.min(4.5 * dt, (c.dT - c.d) * Math.min(1, dt * 2.6)));
    c.yaw = lat / Math.max(0.5, c.v * dt);
    c.prevS = c.s; c.prevD = c.d;   // для плавного рендеру між кроками фізики
    c.d += lat;
    c.s += c.v * dt;
    c.wheel += c.v * dt / 0.36;
    if (c.smoke > 0) c.smoke = Math.max(0, c.smoke - dt * 1.5);
    // кола і фініш
    const lapNow = Math.floor(c.s / L);
    if (lapNow > c.lap) {
      if (c.lap >= 0) {
        const lt = R.t - c.lapStart;
        c.lastLap = lt;
        if (!c.bestLap || lt < c.bestLap) c.bestLap = lt;
        if (!R.fastest || lt < R.fastest.t) { R.fastest = { nick: c.nick, t: lt }; if (lapNow > 1) f1Event(R, 'fastest', { nick: c.nick, t: lt }); }
      }
      c.lap = lapNow; c.lapStart = R.t;
      if (c === leader && lapNow === R.laps - 1 && R.laps > 1) f1Event(R, 'final', {});
      if (c.s >= total && !c.finished) {
        c.finished = true; c.finishT = R.t;
        R.finishOrder.push(c.nick);
        if (R.finishOrder.length === 1) f1Event(R, 'flag', { nick: c.nick });
      }
    }
  }
  if (!R.done && R.finishOrder.length && R.finishOrder.length === n) { R.done = true; R.doneAt = R.t; }
  // страховка: 25 с після переможця — решту класифікуємо за дистанцією
  if (!R.done && R.finishOrder.length && R.t - cars.find(function (c) { return c.nick === R.finishOrder[0]; }).finishT > 25) {
    const left = cars.filter(function (c) { return !c.finished; }).sort(function (a, b) { return b.s - a.s; });
    for (const c of left) { c.finished = true; c.finishT = R.t; R.finishOrder.push(c.nick); }
    R.done = true; R.doneAt = R.t;
  }
  R.leaderLap = Math.max(0, Math.min(R.laps, leader.lap + 1));
}

// headless-прогін для тестів: повертає підсумок
function f1RunHeadless(order, opts) {
  const T = opts.track || f1BuildTrack();
  const R = f1CreateRace(T, order, opts);
  const dt = 1 / 60;
  let guard = 0;
  while (!R.done && guard++ < 60 * 600) f1StepRace(R, dt);
  return {
    winnerOk: R.finishOrder[0] === order[0], winner: R.finishOrder[0], expected: order[0],
    raceSec: Math.round((R.cars.find(function (c) { return c.nick === R.finishOrder[0]; }) || { finishT: R.t }).finishT * 10) / 10,
    overtakes: R.overtakes, leadChanges: R.leadChanges, contacts: R.contacts, forcedMistakes: R.forcedMistakes,
    attempts: R.attempts || 0, troubles: R.troubles || 0,
    gridOfWinner: R.cars.find(function (c) { return c.isWinner; }).grid + 1,
    fastest: R.fastest && Math.round(R.fastest.t * 100) / 100,
  };
}

const F1_SIM = { buildTrack: f1BuildTrack, createRace: f1CreateRace, stepRace: f1StepRace, runHeadless: f1RunHeadless, idx: f1Idx, code: f1Code, CAR_LEN: F1_CAR_LEN, CAR_W: F1_CAR_W, W: F1_W, LIVERY: F1_LIVERY };
if (typeof window !== 'undefined') window.F1_SIM = F1_SIM;
if (typeof globalThis !== 'undefined') globalThis.F1_SIM = F1_SIM;

// ═════════════════════════════════════════════════════════════
//  РЕНДЕР (Three.js r128) — усе нижче працює лише в браузері
// ═════════════════════════════════════════════════════════════
if (typeof document === 'undefined') return;

let G = null;        // сцена, траса, оточення — будуються один раз на сторінку
let RC = null;       // поточна гонка: стан, боліди, режисер
let raf = 0, lastTs = 0, acc = 0, manual = false;   // manual — дебаг: шоу крокує лише через f1Pump

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ── процедурні текстури (canvas) ──
function cvTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}
function noiseFill(g, w, h, base, amp, seed) {
  const img = g.createImageData(w, h), d = img.data; let s = seed | 0 || 7;
  for (let i = 0; i < w * h; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const r = ((s >>> 0) / 4294967296 - 0.5) * amp;
    d[i * 4] = base[0] + r; d[i * 4 + 1] = base[1] + r; d[i * 4 + 2] = base[2] + r; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
function texAsphalt() {
  // u — поперек полотна (0..1), v — уздовж (тайл 8 м); білі лінії краю полотна
  return cvTex(256, 512, function (g, w, h) {
    noiseFill(g, w, h, [58, 60, 64], 26, 11);
    // темніша «гоночна траєкторія» (накатана гума) — легкими смугами
    g.fillStyle = 'rgba(20,20,22,0.18)'; g.fillRect(w * 0.3, 0, w * 0.4, h);
    g.fillStyle = '#f2f2f2'; g.fillRect(w * 0.012, 0, w * 0.03, h); g.fillRect(w * 0.958, 0, w * 0.03, h);
  }, true);
}
function texGrass() {
  // скошена трава смугами, як на автодромах
  return cvTex(512, 512, function (g, w, h) {
    noiseFill(g, w, h, [74, 128, 52], 22, 23);
    for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'; g.fillRect(0, i * h / 8, w, h / 8); }
  }, true);
}
function texKerb() {
  return cvTex(64, 256, function (g, w, h) {
    for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#f4f4f4' : '#d2141b'; g.fillRect(0, i * h / 4, w, h / 4); }
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 0, w * 0.12, h);
  }, true);
}
function texGravel() { return cvTex(256, 256, function (g, w, h) { noiseFill(g, w, h, [196, 178, 140], 40, 31); }, true); }
function texBoards() {
  // рекламні щити вздовж огорожі — лише свій бренд і нейтральні слова
  const P = [['KICKPLAY', '#e10600', '#fff'], ['GRAND PRIX', '#101a3a', '#fff'], ['KICK.COM', '#53fc18', '#0b0b0b'], ['RACE DAY', '#ffffff', '#111'], ['LIVE', '#ffd93d', '#111'], ['KICKPLAY GP', '#1e41ff', '#fff']];
  return cvTex(2048, 96, function (g, w, h) {
    const pw = w / P.length;
    P.forEach(function (p, i) {
      g.fillStyle = p[1]; g.fillRect(i * pw, 0, pw, h);
      g.fillStyle = p[2]; g.font = '900 54px Inter, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(p[0], i * pw + pw / 2, h / 2 + 2);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(i * pw, 0, 3, h);
    });
  }, true);
}
function texChecker() {
  return cvTex(256, 64, function (g, w, h) {
    const sq = 16; for (let y = 0; y < h; y += sq) for (let x = 0; x < w; x += sq) { g.fillStyle = ((x + y) / sq) & 1 ? '#111' : '#f4f4f4'; g.fillRect(x, y, sq, sq); }
  }, false);
}
function texGarage() {
  return cvTex(1024, 128, function (g, w, h) {
    g.fillStyle = '#d9dde3'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 10; i++) { g.fillStyle = '#1b1f26'; g.fillRect(i * w / 10 + 8, 30, w / 10 - 16, h - 30); g.fillStyle = '#e10600'; g.fillRect(i * w / 10 + 8, 18, w / 10 - 16, 8); }
  }, false);
}

// ── геометрія з вершинними кольорами: набір боксів у буфер ──
function GeoBuf() { this.p = []; this.n = []; this.c = []; }
GeoBuf.prototype.quad = function (a, b, c, d, nrm, col) {
  const P = this.p, N = this.n, C = this.c;
  [a, b, c, a, c, d].forEach(function (v) { P.push(v[0], v[1], v[2]); N.push(nrm[0], nrm[1], nrm[2]); C.push(col[0], col[1], col[2]); });
};
// бокс із 8 вершин (v[0..3] — низ, v[4..7] — верх; обхід проти годинника згори)
GeoBuf.prototype.hex = function (v, col) {
  const f = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  for (const q of f) {
    const a = v[q[0]], b = v[q[1]], c = v[q[2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz) || 1;
    this.quad(v[q[0]], v[q[1]], v[q[2]], v[q[3]], [nx / l, ny / l, nz / l], col);
  }
};
GeoBuf.prototype.box = function (x0, x1, y0, y1, z0, z1, col) {
  this.hex([[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], col);
};
// звужений бокс: передній торець (x1) масштабований по висоті/ширині
GeoBuf.prototype.taper = function (x0, x1, y0, y1, z0, z1, fy0, fy1, fz, col) {
  const zc = (z0 + z1) / 2, hz = (z1 - z0) / 2 * fz;
  this.hex([[x0, y0, z1], [x1, fy0, zc + hz], [x1, fy0, zc - hz], [x0, y0, z0], [x0, y1, z1], [x1, fy1, zc + hz], [x1, fy1, zc - hz], [x0, y1, z0]], col);
};
GeoBuf.prototype.geometry = function () {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
  return g;
};

// ── боліди: одна геометрія на всіх, лівреї — колір інстансу ──
// Вершинний колір множиться на колір інстансу: білі деталі = лівреї, темні — карбон
function carGeometry() {
  // кольори вершин лінійні: на виході sRGB 0.09 ставало сірим ~0.33, тож карбон — 0.012 (≈ 0.1 у кадрі)
  const B = new GeoBuf(), L = [1, 1, 1], K = [0.012, 0.012, 0.014], H = [1, 0.92, 0.45], Wt = [0.7, 0.7, 0.7];
  B.box(-2.3, 2.1, 0.05, 0.11, -0.78, 0.78, K);                       // днище
  B.box(-0.6, 1.0, 0.11, 0.6, -0.42, 0.42, L);                        // монокок
  B.taper(1.0, 2.62, 0.18, 0.56, -0.24, 0.24, 0.16, 0.3, 0.55, L);    // ніс
  B.box(2.4, 2.86, 0.07, 0.15, -0.98, 0.98, K);                       // переднє крило
  B.box(2.5, 2.8, 0.15, 0.2, -0.95, 0.95, L);                         // верхній елемент крила
  B.box(2.38, 2.86, 0.07, 0.34, 0.92, 0.98, L); B.box(2.38, 2.86, 0.07, 0.34, -0.98, -0.92, L);   // ендплейти
  B.taper(-0.9, 0.55, 0.11, 0.52, 0.42, 0.8, 0.14, 0.42, 0.8, L);     // понтони
  B.taper(-0.9, 0.55, 0.11, 0.52, -0.8, -0.42, 0.14, 0.42, 0.8, L);
  B.taper(-2.0, -0.45, 0.11, 0.78, -0.4, 0.4, 0.11, 0.6, 0.9, L);     // капот двигуна (до кабіни вищий)
  B.box(-1.95, -0.85, 0.78, 0.98, -0.025, 0.025, L);                  // «плавник»
  B.box(-0.58, -0.24, 0.6, 0.98, -0.17, 0.17, K);                     // повітрозабірник над головою
  B.box(-0.2, 0.3, 0.6, 0.88, -0.17, 0.17, H);                        // шолом пілота
  B.box(0.5, 0.6, 0.6, 0.86, -0.04, 0.04, K);                         // стійка halo
  B.box(-0.25, 0.6, 0.84, 0.9, -0.36, 0.36, K);                       // кільце halo
  B.box(-2.82, -2.34, 0.82, 0.94, -0.52, 0.52, K);                    // заднє крило
  B.box(-2.66, -2.38, 0.96, 1.02, -0.52, 0.52, L);                    // закрилок
  B.box(-2.86, -2.3, 0.42, 1.04, 0.5, 0.55, L); B.box(-2.86, -2.3, 0.42, 1.04, -0.55, -0.5, L);   // ендплейти
  B.box(-2.5, -2.4, 0.4, 0.84, -0.04, 0.04, K);                       // пілон
  B.box(-2.4, -2.1, 0.06, 0.32, -0.62, 0.62, K);                      // дифузор
  B.box(-2.9, -2.84, 0.5, 0.58, -0.08, 0.08, Wt);                     // задній ліхтар
  return B.geometry();
}
function wheelGeometry() {
  // тіло обертання: у циліндра немає вершин посередині боковини, і кольорова смуга
  // суміші не мала де намалюватись. Профіль (радіус, вісь) з окремим кільцем під смугу
  const P = [[0.001, -0.18], [0.14, -0.18], [0.232, -0.18], [0.236, -0.182], [0.292, -0.182], [0.296, -0.18], [0.352, -0.172], [0.366, -0.08], [0.368, 0], [0.366, 0.08], [0.352, 0.172], [0.296, 0.18], [0.292, 0.182], [0.236, 0.182], [0.232, 0.18], [0.14, 0.18], [0.001, 0.18]];
  const g = new THREE.LatheGeometry(P.map(function (p) { return new THREE.Vector2(p[0], p[1]); }), 20);
  g.rotateX(Math.PI / 2);   // вісь обертання Y → вісь колеса Z
  const pos = g.getAttribute('position'), col = [];
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i)), az = Math.abs(pos.getZ(i));
    if (az > 0.177 && r > 0.234 && r < 0.294) col.push(1, 1, 1);        // смуга суміші (колір інстансу)
    else if (az > 0.177 && r < 0.2) col.push(0.02, 0.02, 0.022);         // ковпак диска
    else col.push(0.006, 0.006, 0.007);                                  // гума
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
const TYRE_COL = { S: '#ff2d2d', M: '#ffd800', H: '#f2f2f2' };

// ── точка траси за відстанню + бокове зміщення ──
function trackPos(T, s, d, out) {
  const L = T.L; let u = (((s % L) + L) % L) / T.ds; let i = Math.floor(u); const f = u - i; i = i % T.N; const j = (i + 1) % T.N;
  const x = T.x[i] + (T.x[j] - T.x[i]) * f, z = T.z[i] + (T.z[j] - T.z[i]) * f;
  const nx = T.nx[i] + (T.nx[j] - T.nx[i]) * f, nz = T.nz[i] + (T.nz[j] - T.nz[i]) * f;
  const tx = T.tx[i] + (T.tx[j] - T.tx[i]) * f, tz = T.tz[i] + (T.tz[j] - T.tz[i]) * f;
  out.x = x + nx * d; out.z = z + nz * d; out.tx = tx; out.tz = tz; out.nx = nx; out.nz = nz;
  return out;
}

// ── сцена й траса (один раз) ──
function buildScene() {
  const T = f1BuildTrack();
  const cvs = $('f1-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas: cvs, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xc9dcef, 0.0007);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.3, 6000);
  scene.add(camera);

  // небо — купол-градієнт
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { hor: { value: new THREE.Color(0xdbe8f5) }, zen: { value: new THREE.Color(0x3d7fd6) } },
    vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 hor; uniform vec3 zen; varying vec3 vW; void main(){ float h = clamp(normalize(vW - cameraPosition).y, 0.0, 1.0); gl_FragColor = vec4(mix(hor, zen, pow(h, 0.6)), 1.0); }',
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), skyMat); sky.frustumCulled = false; scene.add(sky);

  scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a6b45, 0.75));
  const sun = new THREE.DirectionalLight(0xfff1d8, 1.25);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90; sc.near = 10; sc.far = 600;
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.04;
  scene.add(sun); scene.add(sun.target);

  const tex = { asphalt: texAsphalt(), grass: texGrass(), kerb: texKerb(), gravel: texGravel(), boards: texBoards(), checker: texChecker(), garage: texGarage() };
  tex.grass.repeat.set(140, 140);

  // земля
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ map: tex.grass }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  // просторовий хеш точок траси: чи вільне місце від полотна (для огорож, гравію, трибун, дерев)
  const HC = 20, hash = new Map();
  for (let i = 0; i < T.N; i += 2) { const k = Math.floor(T.x[i] / HC) + ',' + Math.floor(T.z[i] / HC); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(i); }
  function nearTrack(px, pz, r, skipI, skipSpan) {
    const cx = Math.floor(px / HC), cz = Math.floor(pz / HC), rr = Math.ceil(r / HC);
    for (let a = -rr; a <= rr; a++) for (let b = -rr; b <= rr; b++) {
      const arr = hash.get((cx + a) + ',' + (cz + b)); if (!arr) continue;
      for (const i of arr) {
        if (skipI != null) { let di = Math.abs(i - skipI); di = Math.min(di, T.N - di); if (di < skipSpan) continue; }
        if (Math.hypot(T.x[i] - px, T.z[i] - pz) < r) return true;
      }
    }
    return false;
  }

  // стрічка вздовж траси між зміщеннями a..b (функції від індексу), з маскою
  function ribbon(step, offA, offB, y, mask, vPer) {
    const P = [], U = [], I = [];
    let run = -1;
    for (let k = 0; k <= T.N; k += step) {
      const i = k % T.N;
      const ok = mask ? mask(i) : true;
      if (!ok) { run = -1; continue; }
      const a = offA(i), b = offB(i), base = P.length / 3;
      P.push(T.x[i] + T.nx[i] * a, y, T.z[i] + T.nz[i] * a, T.x[i] + T.nx[i] * b, y, T.z[i] + T.nz[i] * b);
      const v = k * T.ds / vPer; U.push(0, v, 1, v);
      if (run >= 0) I.push(run, run + 1, base, run + 1, base + 1, base);
      run = base;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I); g.computeVertexNormals();
    // нормалі — угору (стрічка може бути «перевернута» залежно від знака зміщень)
    const nA = g.getAttribute('normal'); for (let i = 0; i < nA.count; i++) nA.setXYZ(i, 0, 1, 0);
    return g;
  }
  const half = T.W / 2;
  const mk = (geo, mat, rec) => { const m = new THREE.Mesh(geo, mat); m.receiveShadow = rec !== false; scene.add(m); return m; };
  // полотно
  mk(ribbon(2, () => -half, () => half, 0.02, null, 8), new THREE.MeshStandardMaterial({ map: tex.asphalt, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }));
  // керби там, де поворот: усередині (і зовні на виході)
  const kerbIn = i => Math.abs(T.kapS[i]) > 0.006;
  const sideIn = i => (T.kapS[i] > 0 ? 1 : -1);
  const kerbMat = new THREE.MeshStandardMaterial({ map: tex.kerb, roughness: 0.7, side: THREE.DoubleSide });
  mk(ribbon(2, i => sideIn(i) * half, i => sideIn(i) * (half + 1.6), 0.05, kerbIn, 4), kerbMat);
  mk(ribbon(2, i => -sideIn(i) * half, i => -sideIn(i) * (half + 1.2), 0.05, i => Math.abs(T.kapS[i]) > 0.012, 4), kerbMat);
  // гравій на виносі тісних поворотів
  const gravW = i => Math.abs(T.kapS[i]) > 0.01 ? 26 : 0;
  mk(ribbon(4, i => -sideIn(i) * (half + 1.6), i => -sideIn(i) * (half + 1.6 + gravW(i)), 0.03,
    i => gravW(i) > 0 && !nearTrack(T.x[i] - T.nx[i] * sideIn(i) * (half + 22), T.z[i] - T.nz[i] * sideIn(i) * (half + 22), half + 4, i, 60), 10),
    new THREE.MeshLambertMaterial({ map: tex.gravel, side: THREE.DoubleSide }));
  // старт-фініш: шахова стрічка через усе полотно
  {
    const g = new THREE.PlaneGeometry(T.W, 1.6); g.rotateX(-Math.PI / 2);
    const m = mk(g, new THREE.MeshBasicMaterial({ map: tex.checker })); m.position.set(T.x[0], 0.04, T.z[0]);
    m.rotation.y = Math.atan2(-T.tz[0], T.tx[0]) + Math.PI / 2;
  }
  // розмітка стартових боксів
  {
    const B = new GeoBuf(), W1 = [0.95, 0.95, 0.95], tmp = {};
    for (let gIdx = 0; gIdx < 24; gIdx++) {
      trackPos(T, -(4 + gIdx * 8) + 2.4, gIdx % 2 ? -2.7 : 2.7, tmp);
      const yaw = Math.atan2(-tmp.tz, tmp.tx);
      const c = Math.cos(yaw), sN = Math.sin(yaw);
      const tr = (lx, lz) => [tmp.x + lx * c + lz * sN, 0.045, tmp.z - lx * sN + lz * c];
      const quad = (x0, x1, z0, z1) => B.quad(tr(x0, z1), tr(x1, z1), tr(x1, z0), tr(x0, z0), [0, 1, 0], W1);
      quad(-0.1, 0.1, -1.2, 1.2); quad(-1.4, 0.1, 1.05, 1.2); quad(-1.4, 0.1, -1.2, -1.05);
    }
    mk(B.geometry(), new THREE.MeshBasicMaterial({ vertexColors: true }));
  }
  // огорожа з рекламою: зовні, де не перетинає інші ділянки траси
  const wallOff = i => (Math.abs(T.kapS[i]) > 0.01 ? half + 30 : half + 9);
  const wallOK = (i, sg) => {
    const o = sg * wallOff(i);
    return !nearTrack(T.x[i] + T.nx[i] * o, T.z[i] + T.nz[i] * o, half + 3, i, 50);
  };
  function wall(sg) {
    const P = [], U = [], I = []; let run = -1;
    for (let k = 0; k <= T.N; k += 3) {
      const i = k % T.N; if (!wallOK(i, sg)) { run = -1; continue; }
      const o = sg * wallOff(i), px = T.x[i] + T.nx[i] * o, pz = T.z[i] + T.nz[i] * o, base = P.length / 3;
      P.push(px, 0, pz, px, 1.15, pz);
      const v = k * T.ds / 34; U.push(v, 0, v, 1);
      if (run >= 0) I.push(run, base, run + 1, run + 1, base, base + 1);
      run = base;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setIndex(I); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex.boards, side: THREE.DoubleSide }));
    m.castShadow = true; scene.add(m);
  }
  wall(1); wall(-1);

  // ── трибуни з глядачами (одна злита геометрія + один InstancedMesh натовпу) ──
  const stands = [
    { s0: -230, s1: 60, side: -1, off: half + 16, rows: 14, seat: [0.12, 0.3, 0.75] },    // головна, навпроти боксів
    { s0: 330, s1: 430, side: -1, off: half + 34, rows: 11, seat: [0.75, 0.1, 0.1] },     // шпилька T1
    { s0: 1450, s1: 1560, side: 1, off: half + 30, rows: 10, seat: [0.9, 0.9, 0.92] },    // задня пряма
    { s0: 1700, s1: 1790, side: -1, off: half + 34, rows: 11, seat: [0.1, 0.55, 0.3] },   // шикана
  ];
  const SB = new GeoBuf(), crowd = [], CONC = [0.62, 0.63, 0.66], ROOF = [0.42, 0.45, 0.5], tmpP = {};
  const CROWD_COL = [[0.9, 0.1, 0.1], [0.95, 0.85, 0.1], [0.1, 0.35, 0.9], [0.95, 0.95, 0.95], [0.15, 0.15, 0.15], [0.2, 0.75, 0.3], [1, 0.5, 0.1], [0.6, 0.2, 0.8], [0.95, 0.6, 0.65]];
  let cs = 99;
  const crnd = () => { cs ^= cs << 13; cs ^= cs >>> 17; cs ^= cs << 5; return (cs >>> 0) / 4294967296; };
  for (const st of stands) {
    // трибуну ставимо прямими блоками по 30 м, повернутими за дотичною
    for (let s = st.s0; s < st.s1; s += 30) {
      trackPos(T, s + 15, st.side * st.off, tmpP);
      const yaw = Math.atan2(-tmpP.tz, tmpP.tx);
      const c = Math.cos(yaw), sN = Math.sin(yaw), out = st.side;   // «назовні» = напрям нормалі * side
      const tr = (lx, ly, lz) => [tmpP.x + lx * c + lz * sN * 1, ly, tmpP.z - lx * sN + lz * c];
      // локально: x — уздовж траси, z — від траси (знак side), y — угору
      const D = 0.85, Hs = 0.5;
      const zz = z => z * out;    // локальна z → у бік ВІД траси (+lz збігається з нормаллю n, out — бік)
      for (let r = 0; r < st.rows; r++) {
        const z0 = r * D, z1 = (r + 1) * D, y1 = (r + 1) * Hs;
        const v = [tr(-15, 0, zz(z0)), tr(15, 0, zz(z0)), tr(15, 0, zz(z1)), tr(-15, 0, zz(z1)), tr(-15, y1, zz(z0)), tr(15, y1, zz(z0)), tr(15, y1, zz(z1)), tr(-15, y1, zz(z1))];
        if (out > 0) { SB.hex([v[3], v[2], v[1], v[0], v[7], v[6], v[5], v[4]], r % 2 ? CONC : st.seat); } else SB.hex(v, r % 2 ? CONC : st.seat);
        for (let x = -14.4; x <= 14.4; x += 0.62) {
          if (crnd() < 0.14) continue;
          const p = tr(x + (crnd() - 0.5) * 0.15, y1, zz(z0 + D * 0.55));
          crowd.push({ p, yaw, col: CROWD_COL[Math.floor(crnd() * CROWD_COL.length)], h: 0.75 + crnd() * 0.25 });
        }
      }
      // дах на стовпах
      const zt = st.rows * D, yt = st.rows * Hs + 3.2, zr = zt * 0.45;   // дах — лише над задньою половиною
      const roofV = [tr(-15.5, yt, zz(zr)), tr(15.5, yt, zz(zr)), tr(15.5, yt, zz(zt + 0.5)), tr(-15.5, yt, zz(zt + 0.5)), tr(-15.5, yt + 0.3, zz(zr)), tr(15.5, yt + 0.3, zz(zr)), tr(15.5, yt + 0.3, zz(zt + 0.5)), tr(-15.5, yt + 0.3, zz(zt + 0.5))];
      if (out > 0) SB.hex([roofV[3], roofV[2], roofV[1], roofV[0], roofV[7], roofV[6], roofV[5], roofV[4]], ROOF); else SB.hex(roofV, ROOF);
      for (const px of [-14.5, 0, 14.5]) {
        const a = tr(px - 0.2, 0, zz(zt)), b = tr(px + 0.2, 0, zz(zt)), cc = tr(px + 0.2, 0, zz(zt + 0.4)), d = tr(px - 0.2, 0, zz(zt + 0.4));
        const top = [a, b, cc, d].map(q => [q[0], yt, q[2]]);
        const vv = [a, b, cc, d, top[0], top[1], top[2], top[3]];
        if (out > 0) SB.hex([vv[3], vv[2], vv[1], vv[0], vv[7], vv[6], vv[5], vv[4]], CONC); else SB.hex(vv, CONC);
      }
    }
  }
  const standMesh = new THREE.Mesh(SB.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  standMesh.castShadow = true; standMesh.receiveShadow = true; scene.add(standMesh);
  {
    const pg = new THREE.BoxGeometry(0.42, 1, 0.32); pg.translate(0, 0.5, 0);
    const im = new THREE.InstancedMesh(pg, new THREE.MeshLambertMaterial(), crowd.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), col = new THREE.Color();
    crowd.forEach(function (c, i) {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw); sv.set(1, c.h, 1); pv.set(c.p[0], c.p[1], c.p[2]);
      m4.compose(pv, q, sv); im.setMatrixAt(i, m4); col.setRGB(c.col[0], c.col[1], c.col[2]).convertSRGBToLinear(); im.setColorAt(i, col);
    });
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    scene.add(im);
  }

  // ── бокси (піт-будівля) уздовж стартової прямої, з протилежного боку від трибуни ──
  {
    const B = new GeoBuf(), tmp = {};
    trackPos(T, -60, half + 24, tmp);
    const yaw = Math.atan2(-tmp.tz, tmp.tx), c = Math.cos(yaw), sN = Math.sin(yaw);
    const tr = (lx, ly, lz) => [tmp.x + lx * c + lz * sN, ly, tmp.z - lx * sN + lz * c];
    const hx = (x0, x1, y0, y1, z0, z1, col) => SBhex(B, tr, x0, x1, y0, y1, z0, z1, col);
    hx(-130, 130, 0, 9, 0, 16, [0.86, 0.88, 0.92]);           // корпус
    hx(-130, 130, 9, 9.6, -3, 17, [0.2, 0.22, 0.26]);           // козирок даху
    hx(-130, 130, 0, 1.1, -10.5, -10.1, [0.9, 0.9, 0.9]);      // стіна піт-лейну
    const pit = new THREE.Mesh(B.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    pit.castShadow = true; pit.receiveShadow = true; scene.add(pit);
    // фасад гаражів текстурою
    const fg = new THREE.PlaneGeometry(260, 8.5);
    const fm = new THREE.Mesh(fg, new THREE.MeshLambertMaterial({ map: tex.garage }));
    const f = tr(0, 4.25, -0.05); fm.position.set(f[0], f[1], f[2]); fm.rotation.y = yaw + Math.PI; scene.add(fm);
    // асфальт піт-лейну
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(270, 10), new THREE.MeshStandardMaterial({ map: tex.asphalt, roughness: 0.95 }));
    pl.rotation.x = -Math.PI / 2; const pp = tr(0, 0.025, -5); pl.position.set(pp[0], pp[1], pp[2]); pl.rotation.z = yaw; pl.receiveShadow = true; scene.add(pl);
  }
  // ── стартові вогні над лінією ──
  const lights = [];
  {
    const tmp = {}; trackPos(T, 0, 0, tmp);
    const yaw = Math.atan2(-tmp.tz, tmp.tx), c = Math.cos(yaw), sN = Math.sin(yaw);
    const tr = (lx, ly, lz) => [tmp.x + lx * c + lz * sN, ly, tmp.z - lx * sN + lz * c];
    const B = new GeoBuf(), DK = [0.12, 0.12, 0.14];
    SBhex(B, tr, -0.4, 0.4, 0, 8, half + 1, half + 1.8, DK); SBhex(B, tr, -0.4, 0.4, 0, 8, -half - 1.8, -half - 1, DK);
    SBhex(B, tr, -0.5, 0.5, 7.2, 8.4, -half - 1.8, half + 1.8, DK);
    SBhex(B, tr, -0.3, 0.3, 5.4, 7.2, -2.6, 2.6, DK);
    const gm = new THREE.Mesh(B.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); gm.castShadow = true; scene.add(gm);
    const lg = new THREE.CircleGeometry(0.28, 16);
    for (let k = 0; k < 5; k++) for (let row = 0; row < 2; row++) {
      const m = new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ color: 0x0d0000, toneMapped: false }));
      const p = tr(-0.33, 6.95 - row * 0.75, -2.0 + k * 1.0); m.position.set(p[0], p[1], p[2]); m.rotation.y = yaw - Math.PI / 2;
      scene.add(m); lights.push({ m, k });
    }
  }
  // ── дерева навколо ──
  {
    const trees = [];
    let ts = 1234; const tr = () => { ts ^= ts << 13; ts ^= ts >>> 17; ts ^= ts << 5; return (ts >>> 0) / 4294967296; };
    for (let k = 0; k < 2600 && trees.length < 900; k++) {
      const px = -900 + tr() * 1500, pz = -500 + tr() * 1300;
      if (nearTrack(px, pz, 58)) continue;
      if (px > -360 && px < 120 && pz > -70 && pz < 60) continue;   // зона трибун/боксів на прямій
      trees.push([px, pz, 0.8 + tr() * 0.8]);
    }
    const cg = new THREE.ConeGeometry(3.2, 9, 7); cg.translate(0, 7.5, 0);
    const tg = new THREE.CylinderGeometry(0.4, 0.5, 3.4, 6); tg.translate(0, 1.7, 0);
    const crowns = new THREE.InstancedMesh(cg, new THREE.MeshLambertMaterial({ color: 0x2f6b34 }), trees.length);
    const trunks = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: 0x5a3f26 }), trees.length);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    trees.forEach(function (t, i) {
      m4.makeScale(t[2], t[2], t[2]); m4.setPosition(t[0], 0, t[1]);
      crowns.setMatrixAt(i, m4); trunks.setMatrixAt(i, m4);
      col.setHSL(0.3 + tr() * 0.06, 0.45, 0.25 + tr() * 0.1); crowns.setColorAt(i, col);
    });
    crowns.castShadow = true; scene.add(crowns); scene.add(trunks);
  }
  // ── точки ТВ-камер: зовні траси, кожні ~85 м, вищі на прямих ──
  const spots = [];
  for (let s = 20; s < T.L; s += 85) {
    const i = f1Idx(T, s), out = T.kapS[i] > 0 ? -1 : 1;
    for (const off of [half + 38, half + 60, half + 90]) {
      const px = T.x[i] + T.nx[i] * out * off, pz = T.z[i] + T.nz[i] * out * off;
      if (!nearTrack(px, pz, half + 14)) { spots.push({ s, x: px, z: pz, y: 7 + (T.straight[i] ? 6 : 3) + (off - half) * 0.08 }); break; }
    }
  }
  return { T, renderer, scene, camera, sky, sun, tex, lights, spots, nearTrack };
}
// бокс у локальній системі tr(): x0..x1 уздовж, y0..y1 висота, z0..z1 поперек
function SBhex(B, tr, x0, x1, y0, y1, z0, z1, col) {
  B.hex([tr(x0, y0, z1), tr(x1, y0, z1), tr(x1, y0, z0), tr(x0, y0, z0), tr(x0, y1, z1), tr(x1, y1, z1), tr(x1, y1, z0), tr(x0, y1, z0)], col);
}

// ── боліди поточної гонки ──
function buildCars(R) {
  const n = R.cars.length;
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.25 });
  const bodies = new THREE.InstancedMesh(carGeometry(), bodyMat, n);
  const wheels = new THREE.InstancedMesh(wheelGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), n * 4);
  bodies.castShadow = true; wheels.castShadow = true;
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage); wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.frustumCulled = false; wheels.frustumCulled = false;
  const col = new THREE.Color();
  R.cars.forEach(function (c, i) {
    col.set(c.color).convertSRGBToLinear(); bodies.setColorAt(i, col);
    col.set(TYRE_COL[c.tyre] || '#fff').convertSRGBToLinear();
    for (let k = 0; k < 4; k++) wheels.setColorAt(i * 4 + k, col);
  });
  bodies.instanceColor.needsUpdate = true; wheels.instanceColor.needsUpdate = true;
  G.scene.add(bodies); G.scene.add(wheels);
  // плашки з ніком над боліду в кадрі (як «трекер пілота» у трансляції)
  const tags = [];
  for (let k = 0; k < 3; k++) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96;
    const tx = new THREE.CanvasTexture(cv); tx.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tx, depthTest: false, transparent: true }));
    sp.renderOrder = 20; sp.visible = false; G.scene.add(sp);
    tags.push({ sp, cv, tx, key: '' });
  }
  // дим (помилки, проблеми): точки з мʼяким краєм і власною прозорістю
  const MAXP = 360, pPos = new Float32Array(MAXP * 3), pA = new Float32Array(MAXP), pS = new Float32Array(MAXP);
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pPos, 3)); pg.setAttribute('alpha', new THREE.BufferAttribute(pA, 1)); pg.setAttribute('size', new THREE.BufferAttribute(pS, 1));
  const pm = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'attribute float alpha; attribute float size; varying float vA; void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * 320.0 / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vA; void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard; gl_FragColor = vec4(0.82, 0.82, 0.84, vA * (1.0 - r * 2.0)); }',
  });
  const smoke = new THREE.Points(pg, pm); smoke.frustumCulled = false; G.scene.add(smoke);
  const parts = []; for (let k = 0; k < MAXP; k++) parts.push({ x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, life: 0, size: 1 });
  return { bodies, wheels, tags, smoke, parts, pPos, pA, pS, pIdx: 0 };
}
function disposeCars(V) {
  if (!V) return;
  for (const o of [V.bodies, V.wheels, V.smoke]) { G.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
  for (const t of V.tags) { G.scene.remove(t.sp); t.tx.dispose(); t.sp.material.dispose(); }
}

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _p = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _wm = new THREE.Matrix4(), _wl = new THREE.Matrix4(), _wr = new THREE.Matrix4(), _tp = {};
const WHEELS = [[1.72, 0.36, 0.84, 1], [1.72, 0.36, -0.84, 1], [-1.58, 0.36, 0.84, 0], [-1.58, 0.36, -0.84, 0]];
// Поза боліда в кадрі — інтерпольована між двома кроками фізики (60 Гц). Без цього на
// 300 км/г болід стрибав по 1.3 м, і на нерівній частоті кадрів «двоївся» й розмивався
function carPose(c, out) {
  const T = G.T, a = RC ? RC.alpha : 1;
  const s = c.prevS + (c.s - c.prevS) * a, d = c.prevD + (c.d - c.prevD) * a;
  trackPos(T, s, d, _tp);
  out.x = _tp.x; out.z = _tp.z;
  out.yaw = Math.atan2(-_tp.tz, _tp.tx) - (c.yawVis || 0) * 0.5;
  out.fx = _tp.tx; out.fz = _tp.tz; out.nx = _tp.nx; out.nz = _tp.nz;
  return out;
}
const _pose = {};
function syncCars(dt) {
  const R = RC.R, V = RC.V, T = G.T;
  const kY = 1 - Math.exp(-dt * 5), kP = 1 - Math.exp(-dt * 6);
  R.cars.forEach(function (c, i) {
    c.yawVis = (c.yawVis || 0) + (Math.max(-0.12, Math.min(0.12, c.yaw)) - (c.yawVis || 0)) * kY;
    c.pitchVis = (c.pitchVis || 0) + (c.brake * 0.012 - (c.pitchVis || 0)) * kP;
    carPose(c, _pose);
    _e.set(0, _pose.yaw, -c.pitchVis); _q.setFromEuler(_e);
    _p.set(_pose.x, 0.02, _pose.z);
    _m4.compose(_p, _q, _one); V.bodies.setMatrixAt(i, _m4);
    const steer = clamp(T.kapS[f1Idx(T, c.s)] * 4, -0.32, 0.32);
    for (let k = 0; k < 4; k++) {
      const w = WHEELS[k];
      _wl.makeRotationZ(-c.wheel);
      if (w[3]) { _wr.makeRotationY(steer); _wl.premultiply(_wr); }
      _wl.setPosition(w[0], w[1], w[2]);
      _wm.multiplyMatrices(_m4, _wl);
      V.wheels.setMatrixAt(i * 4 + k, _wm);
    }
    // дим: блокування, широкий вихід, проблема
    if (c.smoke > 0.05 && Math.random() < 0.7) {
      const p = V.parts[V.pIdx]; V.pIdx = (V.pIdx + 1) % V.parts.length;
      p.x = _pose.x - _pose.fx * 2.2 + (Math.random() - 0.5); p.y = 0.4; p.z = _pose.z - _pose.fz * 2.2 + (Math.random() - 0.5);
      p.vx = (Math.random() - 0.5) * 2; p.vy = 1 + Math.random() * 1.5; p.vz = (Math.random() - 0.5) * 2; p.life = 1; p.size = 1.6 + Math.random() * 1.6;
    }
  });
  V.bodies.instanceMatrix.needsUpdate = true; V.wheels.instanceMatrix.needsUpdate = true;
  for (let k = 0; k < V.parts.length; k++) {
    const p = V.parts[k];
    if (p.life > 0) { p.life -= dt * 0.55; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.size += dt * 2.4; }
    V.pPos[k * 3] = p.x; V.pPos[k * 3 + 1] = p.life > 0 ? p.y : -99; V.pPos[k * 3 + 2] = p.z;
    V.pA[k] = Math.max(0, p.life) * 0.55; V.pS[k] = p.size;
  }
  V.smoke.geometry.attributes.position.needsUpdate = true; V.smoke.geometry.attributes.alpha.needsUpdate = true; V.smoke.geometry.attributes.size.needsUpdate = true;
}

// ═════════════════════════════════════════════════════════════
//  РЕЖИСЕР ТРАНСЛЯЦІЇ: ТВ-камери біля траси, онборд, погоня, вертоліт
// ═════════════════════════════════════════════════════════════
const CAM = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40, shot: null, lastType: '', manual: '' };
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function carAt(nick) { return RC.R.cars.find(function (c) { return c.nick === nick; }); }
function order() { return RC.R.cars.slice().sort(function (a, b) { return b.s - a.s; }); }
function gapT(a, b) { return (a.s - b.s) / Math.max(30, b.v); }   // a попереду b, секунди

function setShot(type, car, opts) {
  opts = opts || {};
  const R = RC.R;
  const shot = { type, car: car ? car.nick : null, t0: R.t, until: R.t + (opts.dur || 5), spot: null, cut: true, label: opts.label || '' };
  if (type === 'tv') {
    // ТВ-камера попереду машини: вона наїжджає на нас, камера ведe її панорамою
    const T = G.T, sm = ((car.s % T.L) + T.L) % T.L;
    let best = null, bd = 1e9;
    for (const sp of G.spots) { let ds = sp.s - sm; if (ds < 0) ds += T.L; if (ds > 40 && ds < 280 && ds < bd) { bd = ds; best = sp; } }
    if (!best) best = G.spots[0];
    shot.spot = best; shot.until = R.t + (opts.dur || 7);
  }
  CAM.shot = shot; CAM.lastType = type;
}

function director() {
  const R = RC.R, ord = order(), leader = ord[0], L = R.lightsOutAt;
  const sh = CAM.shot;
  if (CAM.manual) {
    const focus = RC.focus ? carAt(RC.focus) : leader;
    if (!sh || sh.type !== CAM.manual || sh.car !== focus.nick || (sh.type === 'tv' && R.t > sh.until)) setShot(CAM.manual, focus, { dur: 1e9 });
    return;
  }
  // до старту: решітка з вертольота → перший ряд → вогні
  if (R.t < L) {
    const want = R.t < L - 7.5 ? 'gridheli' : (R.t < L - 4.6 ? 'frontrow' : 'lights');
    if (!sh || sh.type !== want) setShot(want, ord[0], { dur: 99 });
    return;
  }
  if (R.t < L + 6.5) { if (!sh || sh.type !== 'startwide') setShot('startwide', leader, { dur: 6.5 }); return; }
  // фініш і святкування
  if (R.finishOrder.length) {
    const w = carAt(R.finishOrder[0]);
    const since = R.t - w.finishT;
    const want = since < 3.2 ? 'finish' : (since < 6.5 ? 'onboard' : 'celebrate');
    if (!sh || sh.type !== want || sh.car !== w.nick) setShot(want, w, { dur: 99 });
    return;
  }
  // останні метри — камера на лінії
  const remain = R.laps * G.T.L - leader.s;
  if (remain < 380 && leader.v > 0) {
    if (!sh || sh.type !== 'finish') setShot('finish', leader, { dur: 99 });
    else sh.car = leader.nick;   // хто веде на останніх метрах, того й тримає фінішна камера
    return;
  }
  // свіжий обгін у першій вісімці — одразу туди
  const ev = R.events.length ? R.events[R.events.length - 1] : null;
  if (ev && ev.type === 'overtake' && R.t - ev.t < 0.6 && (!sh || sh.car !== ev.nick)) {
    const c = carAt(ev.nick); if (c && c.pos <= 8) { setShot(Math.random() < 0.6 ? 'tv' : 'chase', c, { dur: 5 }); return; }
  }
  if (sh && R.t < sh.until) {
    // ТВ-кадр кінчається, коли машина проїхала камеру й відʼїхала
    if (sh.type === 'tv') {
      const c = carAt(sh.car); carPose(c, _pose);
      const dist = Math.hypot(_pose.x - sh.spot.x, _pose.z - sh.spot.z);
      const behind = (_pose.x - sh.spot.x) * _pose.fx + (_pose.z - sh.spot.z) * _pose.fz > 0;
      if (!(behind && dist > 120)) return;
    } else return;
  }
  // новий кадр: кого показати
  let focus = leader;
  const battles = [];
  for (let i = 1; i < ord.length; i++) { const g = gapT(ord[i - 1], ord[i]); if (g < 0.9) battles.push({ i, g }); }
  const leadBattle = battles.find(function (b) { return b.i === 1; });
  const r = Math.random();
  if (leadBattle && r < 0.55) focus = ord[1];
  else if (battles.length && r < 0.85) { const b = battles[Math.floor(Math.random() * Math.min(3, battles.length))]; focus = ord[b.i]; }
  else if (r < 0.95) focus = leader;
  else focus = ord[Math.floor(Math.random() * ord.length)];
  // тип кадру, без повтору підряд
  const types = [['tv', 0.55], ['onboard', 0.2], ['chase', 0.15], ['heli', 0.1]];
  let t = 'tv';
  for (let k = 0; k < 6; k++) {
    let x = Math.random(), pick = 'tv';
    for (const tt of types) { if (x < tt[1]) { pick = tt[0]; break; } x -= tt[1]; }
    if (pick !== CAM.lastType || pick === 'tv') { t = pick; break; }
  }
  setShot(t, focus, { dur: t === 'tv' ? 9 : 4.5 + Math.random() * 2.5 });
}

function camUpdate(dt) {
  const R = RC.R, sh = CAM.shot, T = G.T, cam = G.camera;
  if (!sh) return;
  const c = sh.car ? carAt(sh.car) : order()[0];
  if (c) carPose(c, _pose);
  const fwd = _a.set(_pose.fx, 0, _pose.fz), right = _b.set(_pose.nx, 0, _pose.nz);
  let px, py, pz, lx, ly, lz, fov, smooth = 0, shake = 0;
  switch (sh.type) {
    case 'tv': {
      px = sh.spot.x; py = sh.spot.y; pz = sh.spot.z;
      lx = _pose.x; ly = 0.8; lz = _pose.z;
      const dist = Math.hypot(px - lx, py - ly, pz - lz);
      fov = clamp(2 * Math.atan(8.5 / dist) * 57.3, 5, 48);   // довгофокусний: болід ~третина кадру
      smooth = 8; break;
    }
    case 'onboard': {
      px = _pose.x - fwd.x * 0.35; py = 1.3; pz = _pose.z - fwd.z * 0.35;
      lx = _pose.x + fwd.x * 30; ly = 0.6; lz = _pose.z + fwd.z * 30;
      fov = 74; shake = 0.0012 + c.v * 0.00004; break;
    }
    case 'chase': {
      px = _pose.x - fwd.x * 8; py = 2.5; pz = _pose.z - fwd.z * 8;
      lx = _pose.x + fwd.x * 10; ly = 0.9; lz = _pose.z + fwd.z * 10;
      fov = 50; smooth = 6; break;
    }
    case 'heli': case 'celebrate': {
      const a = R.t * 0.08 + (sh.type === 'celebrate' ? 0 : 1.3);
      const rad = sh.type === 'celebrate' ? 70 : 105, h = sh.type === 'celebrate' ? 55 : 120;
      px = _pose.x + Math.cos(a) * rad; py = h; pz = _pose.z + Math.sin(a) * rad;
      lx = _pose.x + fwd.x * 15; ly = 0; lz = _pose.z + fwd.z * 15;
      fov = 34; smooth = 2; break;
    }
    case 'gridheli': {
      const k = clamp((R.t - sh.t0) / 4.5, 0, 1);
      trackPos(T, -170 + k * 150, -45, _tp); px = _tp.x; py = 55 - k * 15; pz = _tp.z;
      trackPos(T, -60 + k * 50, 0, _tp); lx = _tp.x; ly = 0; lz = _tp.z;
      fov = 42; smooth = 3; break;
    }
    case 'frontrow': {
      trackPos(T, 22, -3, _tp); px = _tp.x; py = 1.4; pz = _tp.z;
      trackPos(T, -10, 0.5, _tp); lx = _tp.x; ly = 0.7; lz = _tp.z;
      fov = 30; break;
    }
    case 'lights': {
      // з боку решітки: лампи дивляться на пілотів — кадр «вогні над першим рядом»
      trackPos(T, -20, -1.2, _tp); px = _tp.x; py = 5.4; pz = _tp.z;
      trackPos(T, 0, 0.6, _tp); lx = _tp.x; ly = 2.4; lz = _tp.z;
      fov = 38; break;
    }
    case 'startwide': {
      trackPos(T, -200, -18, _tp); px = _tp.x; py = 24; pz = _tp.z;
      const lead = order()[0]; carPose(lead, _pose); lx = _pose.x; ly = 0; lz = _pose.z;
      fov = 36; smooth = 4; break;
    }
    case 'finish': {
      trackPos(T, R.laps * T.L + 30, -(T.W / 2 + 6), _tp); px = _tp.x; py = 2.4; pz = _tp.z;
      lx = _pose.x; ly = 0.8; lz = _pose.z;
      const dist = Math.hypot(px - lx, pz - lz);
      fov = clamp(2 * Math.atan(9 / dist) * 57.3, 8, 55); smooth = 9; break;
    }
  }
  if (sh.cut || !smooth) {
    CAM.pos.set(px, py, pz); CAM.look.set(lx, ly, lz); CAM.fov = fov; sh.cut = false;
  } else {
    const k = 1 - Math.exp(-dt * smooth);
    // ТВ-камера стоїть на місці — плавно рухається лише «погляд» (панорама)
    if (sh.type !== 'tv' && sh.type !== 'finish') CAM.pos.lerp(_p.set(px, py, pz), k); else CAM.pos.set(px, py, pz);
    CAM.look.lerp(_p.set(lx, ly, lz), Math.min(1, k * 1.6));
    CAM.fov += (fov - CAM.fov) * k;
  }
  cam.position.copy(CAM.pos);
  cam.lookAt(CAM.look);
  // вібрація онборду — сума кількох синусоїд (як камера на болті кузова), а не білий шум:
  // випадковий шум щокадру давав «дрижання» картинки замість відчуття швидкості
  if (shake) {
    const t = performance.now() / 1000;
    cam.rotation.z += (Math.sin(t * 23) + Math.sin(t * 37 + 1.3) * 0.5) * shake;
    cam.rotation.x += (Math.sin(t * 29 + 2.1) + Math.sin(t * 53) * 0.4) * shake * 0.6;
  }
  if (Math.abs(cam.fov - CAM.fov) > 0.01) { cam.fov = CAM.fov; cam.updateProjectionMatrix(); }
  // тіні слідують за тим, що в кадрі
  G.sun.position.set(CAM.look.x + 80, 160, CAM.look.z + 60); G.sun.target.position.copy(CAM.look); G.sun.target.updateMatrixWorld();
  G.sky.position.copy(cam.position);
}

// ═════════════════════════════════════════════════════════════
//  ГРАФІКА ТРАНСЛЯЦІЇ (DOM поверх канви)
// ═════════════════════════════════════════════════════════════
function fmtLap(t) { if (!t) return '—'; const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3); }
const CAM_LABEL = { tv: '', onboard: 'ONBOARD', chase: 'TRACKING', heli: 'HELI CAM', celebrate: 'HELI CAM', finish: '', gridheli: 'THE GRID', frontrow: '', lights: '', startwide: '' };
let hudAcc = 0, msgUntil = 0, lastEventSeen = 0;
function hudBuild(R) {
  const rows = $('f1-rows'); rows.innerHTML = '';
  rows.style.setProperty('--f1-n', R.cars.length);
  RC.rowEls = new Map();
  R.cars.forEach(function (c) {
    const el = document.createElement('div'); el.className = 'f1-row';
    el.innerHTML = '<span class="f1-pos"></span><span class="f1-team"></span><span class="f1-code"></span><span class="f1-gap"></span>';
    el.querySelector('.f1-team').style.background = c.color;
    el.querySelector('.f1-code').textContent = c.code;
    rows.appendChild(el); RC.rowEls.set(c.nick, el);
  });
  $('f1-tower').style.display = 'block';
  $('f1-flag').classList.remove('show'); $('f1-podium').classList.remove('show'); $('f1-done').style.display = 'none';
  $('f1-msg').classList.remove('show'); $('f1-lower').classList.remove('show'); $('f1-battle').classList.remove('show');
}
function showMsg(html, ms) { const m = $('f1-msg'); m.innerHTML = html; m.classList.add('show'); msgUntil = performance.now() + (ms || 3200); }
function hudUpdate(dt) {
  const R = RC.R, ord = order();
  // вогні: по одному кожні 0.7 с, усі гаснуть разом
  const L = R.lightsOutAt, lit = R.t >= L ? 0 : clamp(Math.floor((R.t - (L - 4.2)) / 0.7) + 1, 0, 5);
  if (lit !== RC.lit) {
    RC.lit = lit;
    G.lights.forEach(function (o) { o.m.material.color.set(o.k < lit ? 0xff0000 : 0x0d0000); });   // лінійні кольори: 0x1a «розбілювався» в рожевий
    const box = $('f1-lights'); box.classList.toggle('show', R.t > L - 4.6 && R.t < L + 1.6);
    box.querySelectorAll('.f1-lamp').forEach(function (e, i) { e.classList.toggle('on', i < lit); });
    if (R.t >= L && !RC.gone) { RC.gone = true; showMsg('<b>LIGHTS OUT</b> AND AWAY WE GO!', 2600); }
  }
  if (R.t > L - 4.6 && R.t < L + 1.6) $('f1-lights').classList.add('show'); else $('f1-lights').classList.remove('show');
  // повідомлення дирекції гонки
  for (const ev of R.events) {
    if (ev.t <= lastEventSeen) continue;
    lastEventSeen = ev.t;
    const c = carAt(ev.nick || '');
    if (ev.type === 'overtake' && c && c.pos <= 6 && ev.t > R.lightsOutAt + 8) showMsg('<span class="f1-tag">OVERTAKE</span> ' + escapeHtml(c.code) + ' → P' + c.pos, 2400);
    else if (ev.type === 'fastest') showMsg('<span class="f1-tag f1-purple">FASTEST LAP</span> ' + escapeHtml(f1Code(ev.nick)) + ' ' + fmtLap(ev.t), 3200);
    else if (ev.type === 'final') showMsg('<span class="f1-tag f1-white">FINAL LAP</span>', 3000);
    else if (ev.type === 'trouble' && c) showMsg('<span class="f1-tag f1-yellow">PROBLEM</span> ' + escapeHtml(c.nick) + ' SLOWS DOWN', 3200);
    else if (ev.type === 'mistake' && c && c.pos <= 5) showMsg('<span class="f1-tag f1-yellow">INCIDENT</span> ' + escapeHtml(c.code) + ' RUNS WIDE', 2400);
    else if (ev.type === 'lead' && c) showMsg('<span class="f1-tag">NEW LEADER</span> ' + escapeHtml(c.nick), 2600);
  }
  if (!RC.drsShown && ord[0].lap >= 1 && R.laps > 1) { RC.drsShown = true; showMsg('<span class="f1-tag f1-green">DRS ENABLED</span>', 2600); }
  if (msgUntil && performance.now() > msgUntil) { $('f1-msg').classList.remove('show'); msgUntil = 0; }
  // мітка камери
  const sh = CAM.shot;
  $('f1-camtag').textContent = sh ? (CAM_LABEL[sh.type] || '') : '';
  $('f1-camtag').style.display = $('f1-camtag').textContent ? 'block' : 'none';
  hudAcc += dt;
  if (hudAcc < 0.2) { syncTags(); return; }
  hudAcc = 0;
  $('f1-lap').textContent = R.finishOrder.length ? 'FINISH' : 'LAP ' + Math.max(1, Math.min(R.laps, ord[0].lap + 1)) + '/' + R.laps;
  const fin = R.finishOrder;
  const list = fin.length ? fin.map(carAt).concat(ord.filter(function (c) { return !c.finished; })) : ord;
  list.forEach(function (c, i) {
    const el = RC.rowEls.get(c.nick); if (!el) return;
    el.style.transform = 'translateY(' + (i * 26) + 'px)';
    el.querySelector('.f1-pos').textContent = i + 1;
    let g;
    if (i === 0) g = c.finished ? 'WINNER' : 'LEADER';
    else if (c.finished) g = '+' + (c.finishT - list[0].finishT).toFixed(3);
    else g = R.t < R.lightsOutAt + 2 ? '' : '+' + gapT(list[i - 1], c).toFixed(3);
    el.querySelector('.f1-gap').textContent = g;
    el.classList.toggle('f1-fast', !!(R.fastest && R.fastest.nick === c.nick));
    el.classList.toggle('f1-focus', !!(sh && sh.car === c.nick));
    el.classList.toggle('f1-out', !!c.trouble);
  });
  // нижня плашка пілота в кадрі + «битва» з тим, хто поруч
  const lower = $('f1-lower'), battle = $('f1-battle');
  const fc = sh && sh.car ? carAt(sh.car) : null;
  const showLower = fc && R.t > R.lightsOutAt + 3 && ['onboard', 'chase', 'tv'].indexOf(sh.type) >= 0 && !R.finishOrder.length;
  if (showLower) {
    const pos = ord.indexOf(fc) + 1;
    lower.innerHTML = '<span class="f1-lp">P' + pos + '</span><span class="f1-lc" style="background:' + fc.color + '"></span><span class="f1-ln">' + escapeHtml(fc.nick) + '</span>' +
      (sh.type === 'onboard' ? '<span class="f1-ls">' + Math.round(fc.v * 3.6) + ' <small>KM/H</small></span>' : '') +
      (fc.drs ? '<span class="f1-drs">DRS</span>' : '');
    lower.classList.add('show');
    const i = ord.indexOf(fc), ahead = ord[i - 1];
    if (ahead && gapT(ahead, fc) < 1.0) {
      battle.innerHTML = '<span style="border-color:' + ahead.color + '">' + escapeHtml(ahead.code) + '</span><b>' + gapT(ahead, fc).toFixed(1) + 's</b><span style="border-color:' + fc.color + '">' + escapeHtml(fc.code) + '</span>';
      battle.classList.add('show');
    } else battle.classList.remove('show');
  } else { lower.classList.remove('show'); battle.classList.remove('show'); }
  syncTags();
}
// плашки над болідами в кадрі (крім онборду — там і так ясно, хто це)
function syncTags() {
  const V = RC.V, sh = CAM.shot, R = RC.R;
  const show = [];
  if (sh && sh.car && ['tv', 'chase', 'heli', 'finish'].indexOf(sh.type) >= 0 && R.t > R.lightsOutAt + 6) {
    const ord = order(), fc = carAt(sh.car), i = ord.indexOf(fc);
    show.push(fc); if (ord[i - 1]) show.push(ord[i - 1]); if (ord[i + 1] && gapT(fc, ord[i + 1]) < 0.8) show.push(ord[i + 1]);
  }
  V.tags.forEach(function (t, k) {
    const c = show[k];
    if (!c) { t.sp.visible = false; return; }
    const pos = order().indexOf(c) + 1, key = c.nick + '|' + pos;
    if (t.key !== key) {
      t.key = key; const g = t.cv.getContext('2d');
      g.clearRect(0, 0, 512, 96);
      g.fillStyle = 'rgba(12,14,20,0.82)'; g.fillRect(0, 14, 512, 68);
      g.fillStyle = c.color; g.fillRect(0, 14, 12, 68);
      g.fillStyle = '#ffd93d'; g.font = '900 40px Inter, Arial, sans-serif'; g.textBaseline = 'middle'; g.fillText('P' + pos, 26, 49);
      g.fillStyle = '#fff'; g.font = '800 38px Inter, Arial, sans-serif';
      let name = String(c.nick).toUpperCase(); while (g.measureText(name).width > 360 && name.length > 3) name = name.slice(0, -1);
      g.fillText(name, 118, 50);
      t.tx.needsUpdate = true;
    }
    carPose(c, _pose);
    // плашка «пливе» за болідом: інтерпольована поза + легке згладження, розмір теж — без тремтіння
    if (!t.sp.visible || t.car !== c.nick) { t.sp.position.set(_pose.x, 3.4, _pose.z); t.car = c.nick; t.sc = 0; }
    else t.sp.position.lerp(_a.set(_pose.x, 3.4, _pose.z), 0.6);
    const dist = G.camera.position.distanceTo(t.sp.position);
    const scT = dist * Math.tan(G.camera.fov * Math.PI / 360) * 0.05;
    t.sc = t.sc ? t.sc + (scT - t.sc) * 0.25 : scT;
    t.sp.scale.set(t.sc * 5.33, t.sc, 1);
    t.sp.visible = true;
  });
}

// ═════════════════════════════════════════════════════════════
//  ЦИКЛ, СТАРТ, ФІНІШ
// ═════════════════════════════════════════════════════════════
function resize() {
  if (!G) return;
  const ov = $('f1-overlay'), w = ov.clientWidth || window.innerWidth, h = ov.clientHeight || window.innerHeight;
  G.renderer.setSize(w, h, false); G.camera.aspect = w / Math.max(1, h); G.camera.updateProjectionMatrix();
}
function frame(ts) {
  raf = requestAnimationFrame(frame);
  if (!RC || manual) return;
  let dt = (ts - lastTs) / 1000; lastTs = ts;
  if (!(dt > 0)) dt = 1 / 60; if (dt > 0.1) dt = 0.1;
  advance(dt);
  G.renderer.render(G.scene, G.camera);
}
// крок шоу на dt (окремо від rAF — для ручного прогону в тестах)
function advance(dt) {
  const R = RC.R;
  acc += dt;
  while (acc >= 1 / 60) { acc -= 1 / 60; if (!(R.done && R.t - R.doneAt > 12)) f1StepRace(R, 1 / 60); }
  RC.alpha = Math.min(1, acc * 60);
  director();
  camUpdate(dt);
  syncCars(dt);
  hudUpdate(dt);
  finishFlow();
}
function finishFlow() {
  const R = RC.R;
  if (R.finishOrder.length && !RC.flagShown) { RC.flagShown = true; $('f1-flag').classList.add('show'); }
  const w = R.finishOrder.length ? carAt(R.finishOrder[0]) : null;
  if (w && !RC.podiumShown && R.t - w.finishT > 9) {
    RC.podiumShown = true;
    $('f1-flag').classList.remove('show');
    const top = R.finishOrder.slice(0, 3).map(carAt);
    const medal = ['1', '2', '3'];
    const ord3 = top.length >= 3 ? [1, 0, 2] : top.map(function (_, i) { return i; });
    $('f1-podium').innerHTML = ord3.map(function (i) {
      const c = top[i];
      return '<div class="f1-pod f1-pod-' + (i + 1) + '"><div class="f1-pod-n">' + medal[i] + '</div><div class="f1-pod-bar" style="background:' + c.color + '"></div><div class="f1-pod-name"></div><div class="f1-pod-t">' + (i === 0 ? 'WINNER' : '+' + (c.finishT - top[0].finishT).toFixed(3)) + '</div></div>';
    }).join('');
    $('f1-podium').querySelectorAll('.f1-pod-name').forEach(function (e, k) { e.textContent = top[ord3[k]].nick; });
    $('f1-podium').classList.add('show');
    setTimeout(function () {
      if (!RC || RC.R !== R) return;
      $('f1-podium').classList.remove('show');
      $('f1-done').style.display = 'flex';
      if (typeof phase !== 'undefined') phase = 'done';
      if (typeof addWinner === 'function' && !RC.announced) { RC.announced = true; addWinner(R.winner); }
    }, 5200);
  }
}

async function startF1Race(nWanted, laps) {
  if (typeof THREE === 'undefined') { alert('Гонка: three.js не загрузился'); return; }
  const list = (typeof state !== 'undefined' && Array.isArray(state.participants)) ? state.participants.slice() : [];
  if (list.length < 2) { alert('Нужно минимум 2 участника'); return; }
  const n = Math.max(2, Math.min(nWanted || 20, 24, list.length));
  laps = Math.max(1, Math.min(3, laps || 2));
  RC && stopRace();
  const ov = $('f1-overlay'); ov.classList.add('visible');
  $('f1-loading').style.display = 'flex'; $('f1-done').style.display = 'none';
  if (typeof phase !== 'undefined') phase = 'racing';
  // склад і переможець — перестановка random.org (перше місце в послідовності — переможець)
  const order0 = await rollPick(list, n, 'Гонка: ' + n + ' пилотов, ' + laps + ' кр.; победитель — первый в последовательности');
  if (!ov.classList.contains('visible')) return;
  if (!G) { G = buildScene(); window.addEventListener('resize', resize); }
  resize();
  const seed = (crypto.getRandomValues(new Uint32Array(1))[0] >>> 0) || 1;
  const R = f1CreateRace(G.T, order0, { laps, seed, lightsOutAt: 9.6 });
  RC = { R, V: buildCars(R), alpha: 1, lit: -1, gone: false, drsShown: false, flagShown: false, podiumShown: false, announced: false, focus: null, laps, n };
  lastEventSeen = 0; msgUntil = 0;
  CAM.shot = null; CAM.manual = ''; setCamBtn('');
  hudBuild(R);
  $('f1-loading').style.display = 'none';
  acc = 0; lastTs = performance.now();
  if (!raf) raf = requestAnimationFrame(frame);
}
function stopRace() {
  if (!RC) return;
  disposeCars(RC.V); RC = null;
}
function closeF1Race(silent) {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  // закрили до заставки — переможець усе одно фіксується (крім тихого закриття при скиданні)
  if (!silent && RC && RC.R.finishOrder.length && !RC.announced && typeof addWinner === 'function') { RC.announced = true; addWinner(RC.R.winner); }
  stopRace();
  const ov = $('f1-overlay'); if (ov) ov.classList.remove('visible');
  if (typeof phase !== 'undefined' && phase === 'racing') phase = 'idle';
}
function setCamBtn(mode) {
  document.querySelectorAll('#f1-controls [data-cam]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-cam') === mode); });
}
function f1Cam(mode) {
  if (!RC) return;
  CAM.manual = mode === 'auto' ? '' : mode;
  if (mode !== 'auto') RC.focus = CAM.shot && CAM.shot.car ? CAM.shot.car : order()[0].nick;
  CAM.shot = null; setCamBtn(mode === 'auto' ? '' : mode);
}
function f1Again() {
  if (!RC) return;
  if (typeof closeAnnounce === 'function') closeAnnounce();   // заставка минулого переможця не має висіти над новою гонкою
  const n = RC.n, laps = RC.laps;
  return startF1Race(n, laps);
}

window.startF1Race = startF1Race;
window.closeF1Race = closeF1Race;
window.f1Cam = f1Cam;
window.f1Again = f1Again;
// дебаг: ручний крок шоу без rAF (у пейні автоматизації rAF задушений) і доступ до стану
window.f1Pump = function (sec) { if (!RC) return; const steps = Math.round(sec * 60); for (let i = 0; i < steps; i++) advance(1 / 60); G.renderer.render(G.scene, G.camera); };
// дебаг: один кадр шоу з довільним dt (перевірка плавності на нерівній частоті кадрів)
window.f1Frame = function (dt) { if (!RC) return; advance(dt); G.renderer.render(G.scene, G.camera); };
window.f1Manual = function (on) { manual = !!on; lastTs = performance.now(); };
window.f1Debug = function () { return { R: RC && RC.R, G, CAM }; };

})();
