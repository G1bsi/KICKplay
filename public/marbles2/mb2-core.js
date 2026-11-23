/* ══════════════════════════════════════════════════════════════
   Шарики 2.0 — ядро симуляції (без DOM і без рушія фізики).
   Розраховано на 1000 кульок: власна фізика під жанр.
   • Траса — рамки через 0.5 м (позиція, напрям T, «вгору» U, «вправо» R) і переріз жолоба:
     підлога y=0, заокруглення радіуса Rf, борти x=±W висотою H. Кулька штовхається від цього
     перерізу аналітично — без трикутників і без широкої фази.
   • Вирва під контейнером і фінішна чаша — тіла обертання (профіль r(h)).
   • Кілки — циліндри вздовж «вгору» рамки.
   • Кулька ↔ кулька — сітка-хеш (комірка = діаметр), позиційна корекція + імпульс.
   Зони кульки: 0 — контейнер і вирва, 1 — траса, 2 — фінішна чаша.
   ══════════════════════════════════════════════════════════════ */
(function (root) {
  const R = 0.5, D = 2 * R;
  const G = 15;                 // гравітація (трохи важча — відчуття швидкості)
  const SUB = 2, DT = 1 / 60;   // крок кадру й підкроки
  const E_WALL = 0.32, E_BALL = 0.22, FR_ROLL = 0.04, VMAX = 30, AIR = 0.012;
  const STUCK_V = 0.35, STUCK_T = 2.2;
  const BOOST_A = 16, BOOST_V = 14;   // прискорення на бусті (м/с²) і до якої швидкості вздовж траси
  const BUMP = 7.5;             // швидкість, з якою хмарний бампер відкидає кульку
  const HASH = 8192;            // розмір хеш-таблиці (степінь 2)

  // ── карта ──
  function loadMap(j) {
    const F = j.frames, n = F.p.length;
    const fp = new Float32Array(n * 3), ft = new Float32Array(n * 3), fu = new Float32Array(n * 3), fr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { fp[i * 3 + k] = F.p[i][k]; ft[i * 3 + k] = F.T[i][k]; fu[i * 3 + k] = F.U[i][k]; fr[i * 3 + k] = F.R[i][k]; }
    const map = {
      raw: j, n, ds: j.ds, fp, ft, fu, fr,
      W: Float32Array.from(F.W), H: Float32Array.from(F.H), Rf: Float32Array.from(F.Rf), open: Uint8Array.from(F.open),
      len: (n - 1) * j.ds,
      funnel: { c: j.funnel.c, prof: j.funnel.prof, exitY: j.funnel.exitY },
      bowl: { c: j.bowl.c, prof: j.bowl.prof },
      box: j.box, eliminate: !!j.eliminate,
      pegs: j.pegs.map(p => ({ x: p.p[0], y: p.p[1], z: p.p[2], ax: p.a[0], ay: p.a[1], az: p.a[2], r: p.r, h: p.h, i: p.i })),
    };
    map.pegs.sort((a, b) => a.i - b.i);
    map.faces = []; for (let i = 1; i < n; i++) if (map.open[i - 1] && !map.open[i]) map.faces.push(i);
    map.gapStarts = []; for (let i = 1; i < n; i++) if (!map.open[i - 1] && map.open[i]) map.gapStarts.push(i);   // губи трамплінів
    map.pegFirst = map.pegs.length ? map.pegs[0].i - 6 : 1e9; map.pegLast = map.pegs.length ? map.pegs[map.pegs.length - 1].i + 6 : -1;
    map.pegsMove = j.pegsMove !== 0;                 // «Гнев Зевса» — колони стоять на місці
    // хмарні бампери: циліндри, що відкидають кульку з запасом енергії (як у пінболі)
    map.bumpers = (j.bumpers || []).map(p => ({ x: p.p[0], y: p.p[1], z: p.p[2], ax: p.a[0], ay: p.a[1], az: p.a[2], r: p.r, h: p.h, i: p.i, hit: 0 }));
    map.storm = j.storm || [];                       // ділянки рамок, куди б'ють блискавки
    map.boost = j.boost || [];                       // бусти: ділянки рамок, де кульку розганяє вздовж траси
    return map;
  }

  // ── створення гонки ──
  // opts.noWin — індекси кульок, що не можуть виграти (тіньовий бан): їдуть як усі, але не перелітають провал на трампліні
  // (на трасі без провалу — вилітають за борт на 70% траси); переможець — лише допущений
  function createSim(nicks, map, rnd, opts) {
    rnd = rnd || Math.random;
    const N = nicks.length;
    const s = {
      map, N, nicks,
      px: new Float32Array(N), py: new Float32Array(N), pz: new Float32Array(N),
      vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
      zone: new Uint8Array(N), idx: new Int32Array(N), prog: new Float32Array(N),
      alive: new Uint8Array(N).fill(1), fin: new Uint8Array(N), fallT: new Float32Array(N), stuck: new Float32Array(N),
      finT: new Float32Array(N), elimT: new Float32Array(N), cause: new Array(N).fill(''),
      cellOf: new Int32Array(N), cellStart: new Int32Array(HASH + 1), cellBalls: new Int32Array(N),
      t: 0, raceT: 0, raceOn: false, gateOpen: false, frame: 0, subT: 0,
      seed: Math.floor(rnd() * 0x7fffffff), rnd, strikes: [], noWin: new Uint8Array(N), ejected: new Uint8Array(N), ghost: new Uint8Array(N), weakV: new Float32Array(N), ejT: new Float32Array(N), struckT: new Float32Array(N).fill(-99), pegOff: new Float32Array(map.pegs.length), pegV: new Float32Array(map.pegs.length),
      finishOrder: [], eliminated: [], firstFinishT: null, done: false, kicks: 0, oob: 0,
    };
    if (opts && opts.noWin) for (const i of opts.noWin) if (i >= 0 && i < N) { s.noWin[i] = 1; s.weakV[i] = 5.2 + rnd() * 0.9; }
    // розставляємо кульки в контейнері ярусами (порядок з розіграшу: перші — ближче до центру нижнього ярусу)
    const B = map.box, half = B.half - 0.6, step = 1.06;
    const per = Math.floor((2 * half) / step) + 1;
    const slots = [];
    // стійка укладка: кожен наступний ярус лежить у ямках попереднього (зсув на пів кроку),
    // висота ярусу sqrt(D² − step²/2) — кульки не «осідають» і не тремтять на заставці
    const lh = Math.sqrt(Math.max(0.2, D * D - step * step / 2)) + 0.01;
    for (let l = 0; slots.length < N; l++) {
      const off = (l % 2) * step / 2, cnt = per - (l % 2);
      for (let a = 0; a < cnt; a++) for (let b = 0; b < cnt; b++) slots.push([-half + off + a * step, B.c[1] + R + 0.02 + l * lh, -half + off + b * step, l]);
    }
    slots.sort((p, q) => p[3] - q[3] || (Math.hypot(p[0], p[2]) - Math.hypot(q[0], q[2])));
    for (let i = 0; i < N; i++) {
      const sl = slots[i];
      s.px[i] = B.c[0] + sl[0] + (rnd() - 0.5) * 0.04; s.py[i] = sl[1]; s.pz[i] = B.c[2] + sl[2] + (rnd() - 0.5) * 0.04;
    }
    // наперед «утрамбовуємо» купу з сильним гасінням швидкостей — на заставці кульки вже лежать спокійно
    for (let k = 0; k < 240; k++) substep(s, DT / SUB);
    for (let i = 0; i < N; i++) s.vx[i] = s.vy[i] = s.vz[i] = 0;
    return s;
  }

  // ── сітка-хеш для пар кульок ──
  function cellKey(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & (HASH - 1);
  }
  function buildHash(s) {
    const { cellStart, cellBalls, cellOf, N } = s;
    cellStart.fill(0);
    for (let i = 0; i < N; i++) {
      if (!s.alive[i] || s.fin[i] === 2 || s.ghost[i]) { cellOf[i] = -1; continue; }   // «привид» (приречений заблокований) нікого не штовхає
      const k = cellKey(s.px[i], s.py[i], s.pz[i]); cellOf[i] = k; cellStart[k + 1]++;
    }
    for (let k = 0; k < HASH; k++) cellStart[k + 1] += cellStart[k];
    const fill = s._fill || (s._fill = new Int32Array(HASH));
    fill.set(cellStart.subarray(0, HASH));
    for (let i = 0; i < N; i++) { const k = cellOf[i]; if (k >= 0) cellBalls[fill[k]++] = i; }
  }
  function ballBall(s) {
    const { px, py, pz, vx, vy, vz, cellStart, cellBalls, cellOf, N } = s;
    const D2 = D * D;
    for (let i = 0; i < N; i++) {
      if (cellOf[i] < 0) continue;
      const x = px[i], y = py[i], z = pz[i];
      const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const k = (((ix + dx) * 73856093) ^ ((iy + dy) * 19349663) ^ ((iz + dz) * 83492791)) & (HASH - 1);
        for (let q = cellStart[k], e = cellStart[k + 1]; q < e; q++) {
          const j = cellBalls[q]; if (j <= i) continue;
          const ex = px[j] - x, ey = py[j] - y, ez = pz[j] - z, d2 = ex * ex + ey * ey + ez * ez;
          if (d2 >= D2 || d2 < 1e-10) continue;
          const d = Math.sqrt(d2), nx = ex / d, ny = ey / d, nz = ez / d, ov = (D - d) * 0.5;
          px[i] -= nx * ov; py[i] -= ny * ov; pz[i] -= nz * ov; px[j] += nx * ov; py[j] += ny * ov; pz[j] += nz * ov;
          const rv = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny + (vz[j] - vz[i]) * nz;
          if (rv < 0) {
            const jm = -(1 + (rv < -1 ? E_BALL : 0)) * rv * 0.5;
            vx[i] -= jm * nx; vy[i] -= jm * ny; vz[i] -= jm * nz; vx[j] += jm * nx; vy[j] += jm * ny; vz[j] += jm * nz;
          }
        }
      }
    }
  }

  // відштовхнути кульку i від поверхні: нормаль n (одинична, «з поверхні до кульки»), глибина pen
  function resolve(s, i, nx, ny, nz, pen) {
    s.px[i] += nx * pen; s.py[i] += ny * pen; s.pz[i] += nz * pen;
    const vn = s.vx[i] * nx + s.vy[i] * ny + s.vz[i] * nz;
    if (vn < 0) {
      // повільний дотик (кочення, лежання) — без відскоку, інакше кулька дрібно тремтить
      const k = (1 + (vn < -1.2 ? E_WALL : 0)) * vn;
      s.vx[i] -= k * nx; s.vy[i] -= k * ny; s.vz[i] -= k * nz;
      // кочення: невелике тертя дотичної складової
      const f = 1 - FR_ROLL * Math.min(1, -vn * 0.25);
      s.vx[i] *= f; s.vy[i] *= f; s.vz[i] *= f;
    }
  }

  // тіло обертання: профіль [(r, h)] навколо вертикальної осі в точці c; кулька всередині
  function lathe(s, i, c, prof) {
    const dx = s.px[i] - c[0], dz = s.pz[i] - c[2], h = s.py[i] - c[1];
    const rho = Math.hypot(dx, dz) || 1e-6, ux = dx / rho, uz = dz / rho;
    let best = 1e9, bq = 0, bh = 0;
    for (let k = 0; k + 1 < prof.length; k++) {
      const a = prof[k], b = prof[k + 1];
      const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
      let t = ((rho - a[0]) * ex + (h - a[1]) * ey) / (L2 || 1); t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a[0] + ex * t, qy = a[1] + ey * t, d2 = (rho - qx) * (rho - qx) + (h - qy) * (h - qy);
      if (d2 < best) { best = d2; bq = qx; bh = qy; }
    }
    const d = Math.sqrt(best);
    if (d >= R || d < 1e-6) return;
    // нормаль від поверхні до кульки (у площині r-h); кулька всередині — нормаль має бути «до осі/вгору»
    let nr = (rho - bq) / d, nh = (h - bh) / d;
    resolve(s, i, nr * ux, nh, nr * uz, R - d);
  }

  // трек: найближча рамка (локальний пошук) і зіткнення з перерізом
  function trackStep(s, i) {
    const m = s.map, fp = m.fp;
    const x = s.px[i], y = s.py[i], z = s.pz[i];
    let bi = s.idx[i], bd = 1e18;
    const lo = Math.max(0, bi - 4), hi = Math.min(m.n - 1, bi + 10);
    for (let k = lo; k <= hi; k++) {
      const ex = x - fp[k * 3], ey = y - fp[k * 3 + 1], ez = z - fp[k * 3 + 2], d2 = ex * ex + ey * ey + ez * ez;
      if (d2 < bd) { bd = d2; bi = k; }
    }
    s.idx[i] = bi;
    const o = bi * 3, ft = m.ft, fu = m.fu, fr = m.fr;
    const ex = x - fp[o], ey = y - fp[o + 1], ez = z - fp[o + 2];
    const lx = ex * fr[o] + ey * fr[o + 1] + ez * fr[o + 2];
    const ly = ex * fu[o] + ey * fu[o + 1] + ez * fu[o + 2];
    const ls = ex * ft[o] + ey * ft[o + 1] + ez * ft[o + 2];
    s.prog[i] = bi * m.ds + ls;
    const W = m.W[bi], H = m.H[bi], Rf = m.Rf[bi];
    // початок траси — задня стінка
    if (bi === 0 && ls < 0) resolve(s, i, ft[o], ft[o + 1], ft[o + 2], -ls);
    // кінець траси — кулька в чаші
    if (bi === m.n - 1 && ls > 0.2) { s.zone[i] = 2; return; }
    const ax = Math.abs(lx);
    // торець траси за провалом: хто не долетів і йде нижче кромки — відбивається від торця і падає,
    // а не «підстрибує» на трасу
    for (let q = 0; q < m.faces.length; q++) {
      const f0 = m.faces[q]; if (bi < f0 - 6 || bi > f0 + 3) continue;
      const o0 = f0 * 3, ex0 = x - fp[o0], ey0 = y - fp[o0 + 1], ez0 = z - fp[o0 + 2];
      const ls0 = ex0 * ft[o0] + ey0 * ft[o0 + 1] + ez0 * ft[o0 + 2], ly0 = ex0 * fu[o0] + ey0 * fu[o0 + 1] + ez0 * fu[o0 + 2];
      const lx0 = ex0 * fr[o0] + ey0 * fr[o0 + 1] + ez0 * fr[o0 + 2];
      if (Math.abs(lx0) < m.W[f0] + 0.35 && ly0 < 0 && ly0 > -0.35 - R && ls0 > -R && ls0 < 0.6) resolve(s, i, -ft[o0], -ft[o0 + 1], -ft[o0 + 2], ls0 + R);
    }
    const onTrack = !m.open[bi] && ax < W + 0.6 && ly > -0.9 && ly < H + 1.2;
    if (!onTrack) {
      if (!m.open[bi] || ly < -1.5) s.fallT[i] += DT / SUB; // поза жолобом або вже нижче провалу — падає
      return;
    }
    s.fallT[i] = 0;
    const inner = W - Rf;
    if (ax <= inner) {
      if (ly < R && ly > -0.3) resolve(s, i, fu[o], fu[o + 1], fu[o + 2], R - ly);
    } else if (ly < Rf) {
      const sx = lx > 0 ? 1 : -1, cx = sx * inner, cy = Rf;
      const dx = lx - cx, dy = ly - cy, d = Math.hypot(dx, dy) || 1e-6;
      if (d > Rf - R && d < Rf + 0.3) {
        const pen = d - (Rf - R), nlx = -dx / d, nly = -dy / d;
        resolve(s, i, fr[o] * nlx + fu[o] * nly, fr[o + 1] * nlx + fu[o + 1] * nly, fr[o + 2] * nlx + fu[o + 2] * nly, pen);
      }
    }
    if (ly >= Rf * 0.5 && ly < H && ax > W - R && ax < W + 0.3) {
      const sx = lx > 0 ? 1 : -1, pen = ax - (W - R);
      resolve(s, i, -fr[o] * sx, -fr[o + 1] * sx, -fr[o + 2] * sx, pen);
    }
    // кілки поруч
    if (bi >= m.pegFirst && bi <= m.pegLast) {
      const P = m.pegs;
      for (let q = 0; q < P.length; q++) {
        const p = P[q]; if (p.i < bi - 4) continue; if (p.i > bi + 4) break;
        const off = s.pegOff[q];
        if (2 * p.h + off < 0.03) continue;                 // сховався в підлогу
        const qx = s.px[i] - p.x, qy = s.py[i] - p.y, qz = s.pz[i] - p.z;
        const along = qx * p.ax + qy * p.ay + qz * p.az - off;   // відносно зсунутого центру
        if (along > p.h + R || along < -p.h - R) continue;
        const rx = qx - p.ax * (along + off), ry = qy - p.ay * (along + off), rz = qz - p.az * (along + off), rd = Math.hypot(rx, ry, rz) || 1e-6;
        if (along <= p.h) {
          if (rd < p.r + R) resolve(s, i, rx / rd, ry / rd, rz / rd, p.r + R - rd);
        } else if (rd <= p.r) {
          // над кришкою — виштовхує вгору (кілок, що піднімається, підкидає кульку)
          resolve(s, i, p.ax, p.ay, p.az, p.h + R - along);
          if (s.pegV[q] > 0) { const vn = s.vx[i] * p.ax + s.vy[i] * p.ay + s.vz[i] * p.az; if (vn < s.pegV[q]) { const d = s.pegV[q] - vn; s.vx[i] += p.ax * d; s.vy[i] += p.ay * d; s.vz[i] += p.az * d; } }
        } else {
          // ребро кришки
          const ex = rd - p.r, ey = along - p.h, d = Math.hypot(ex, ey);
          if (d < R && d > 1e-6) { const nr = ex / d, na = ey / d; resolve(s, i, rx / rd * nr + p.ax * na, ry / rd * nr + p.ay * na, rz / rd * nr + p.az * na, R - d); }
        }
      }
    }
    // хмарні бампери: відштовхують і додають швидкості вздовж нормалі (мінімум BUMP м/с)
    const BB = m.bumpers;
    for (let q = 0; q < BB.length; q++) {
      const p = BB[q]; if (p.i < bi - 8 || p.i > bi + 8) continue;
      const qx = s.px[i] - p.x, qy = s.py[i] - p.y, qz = s.pz[i] - p.z;
      const along = qx * p.ax + qy * p.ay + qz * p.az;
      if (along > p.h + R * 0.6 || along < -p.h - R) continue;
      const rx = qx - p.ax * along, ry = qy - p.ay * along, rz = qz - p.az * along, rd = Math.hypot(rx, ry, rz) || 1e-6;
      if (rd >= p.r + R) continue;
      const nx = rx / rd, ny = ry / rd, nz = rz / rd;
      s.px[i] += nx * (p.r + R - rd); s.py[i] += ny * (p.r + R - rd); s.pz[i] += nz * (p.r + R - rd);
      const vn = s.vx[i] * nx + s.vy[i] * ny + s.vz[i] * nz;
      const out = Math.max(BUMP, -vn * 1.15);
      if (vn < out) { const d = out - vn; s.vx[i] += nx * d; s.vy[i] += ny * d; s.vz[i] += nz * d; }
      p.hit = s.t;                                   // для підсвітки в рендері
    }
  }

  // ── рухомі кілки: кожен за власним випадковим розкладом то ховається в підлогу, то виїжджає.
  // Розклад — чиста функція від часу й зерна гонки: рендер рахує те саме, що й фізика.
  function hash2(seed, a, b) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ seed;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  }
  const PEG_TR = 0.4;   // секунд на опускання / підйом
  // 0 — піднятий, 1 — повністю в підлозі
  function pegLevel(seed, q, t) {
    const L = 2.6 + hash2(seed, q, -1) * 2.8;
    const tt = t + hash2(seed, q, -2) * L, k = Math.floor(tt / L), u = (tt - k * L);
    if (hash2(seed, q, k) > 0.5) return 0;
    const a = (0.08 + hash2(seed, q, k + 7777) * 0.3) * L, b = Math.min(L - PEG_TR - 0.05, a + PEG_TR + (0.25 + hash2(seed, q, k + 999) * 0.35) * L);
    const sm = x => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
    return sm((u - a) / PEG_TR) * (1 - sm((u - b) / PEG_TR));
  }
  function pegsAt(s, t, outOff, outV) {
    const P = s.map.pegs;
    if (!s.map.pegsMove) { outOff.fill(0); if (outV) outV.fill(0); return; }
    for (let q = 0; q < P.length; q++) {
      const D = 2 * P[q].h + 0.08, o = -pegLevel(s.seed, q, t) * D;
      if (outV) outV[q] = (o - outOff[q]) / (DT / SUB);
      outOff[q] = o;
    }
  }

  function boxStep(s, i) {
    const B = s.map.box, h = B.half;
    const lx = s.px[i] - B.c[0], lz = s.pz[i] - B.c[2], y = s.py[i];
    if (y > B.c[1] - 0.6 && y < B.c[1] + B.h + 2) {
      if (lx > h - R) resolve(s, i, -1, 0, 0, lx - (h - R)); else if (lx < -h + R) resolve(s, i, 1, 0, 0, -h + R - lx);
      if (lz > h - R) resolve(s, i, 0, 0, -1, lz - (h - R)); else if (lz < -h + R) resolve(s, i, 0, 0, 1, -h + R - lz);
      if (!s.gateOpen && y < B.c[1] + R) resolve(s, i, 0, 1, 0, B.c[1] + R - y);
    }
  }

  function substep(s, h) {
    const m = s.map, N = s.N;
    s.subT += h; pegsAt(s, s.subT, s.pegOff, s.pegV);
    for (let i = 0; i < N; i++) {
      if (!s.alive[i] || s.fin[i] === 2) continue;
      s.vy[i] -= G * h;
      const air = 1 - AIR * h; s.vx[i] *= air; s.vy[i] *= air; s.vz[i] *= air;
      const v2 = s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i] + s.vz[i] * s.vz[i];
      if (v2 > VMAX * VMAX) { const k = VMAX / Math.sqrt(v2); s.vx[i] *= k; s.vy[i] *= k; s.vz[i] *= k; }
      s.px[i] += s.vx[i] * h; s.py[i] += s.vy[i] * h; s.pz[i] += s.vz[i] * h;
    }
    buildHash(s);
    ballBall(s);
    for (let i = 0; i < N; i++) {
      if (!s.alive[i] || s.fin[i] === 2) continue;
      const zn = s.zone[i];
      if (zn === 0) {
        // до старту купа в контейнері лежить спокійно (підлога без тертя інакше дає вічне ковзання)
        if (!s.gateOpen) { s.vx[i] *= 0.9; s.vz[i] *= 0.9; if (s.vy[i] > 0) s.vy[i] *= 0.9; }
        boxStep(s, i);
        if (s.py[i] < m.box.c[1] - 0.5) lathe(s, i, m.funnel.c, m.funnel.prof);
        s.prog[i] = (s.py[i] - m.box.c[1]) * -0.01 - 30;   // поки в контейнері/вирві — всі майже рівні
        if (s.py[i] < m.funnel.exitY) { s.zone[i] = 1; s.idx[i] = 0; }
      } else if (zn === 1) {
        trackStep(s, i);
      } else {
        lathe(s, i, m.bowl.c, m.bowl.prof);
      }
    }
  }

  // ── крок кадру: підкроки, фініш, вибування, «застряглі», відлік ──
  function step(s) {
    const h = DT / SUB, m = s.map;
    for (let k = 0; k < SUB; k++) substep(s, h);
    s.t += DT; s.frame++;
    stormTick(s, DT);
    if (s.raceOn) s.raceT += DT;
    for (let i = 0; i < s.N; i++) {
      if (!s.alive[i]) continue;
      // заблокований таки долетів до чаші — вилітає з неї за край (і вибуває); рендер домалює політ
      if (s.zone[i] === 2 && !s.fin[i] && s.noWin[i]) {
        const b = m.bowl.c, dx = s.px[i] - b[0], dz = s.pz[i] - b[2], d = Math.hypot(dx, dz) || 1;
        s.vx[i] = dx / d * 9; s.vz[i] = dz / d * 9; s.vy[i] = 9;
        s.alive[i] = 0; s.elimT[i] = s.raceT; s.cause[i] = 'вылетел с трассы'; s.eliminated.push(i);
        continue;
      }
      if (s.zone[i] === 2 && !s.fin[i]) {
        s.fin[i] = 1; s.finT[i] = s.raceT; s.prog[i] = m.len + 10;
        s.finishOrder.push(i);
        if (s.firstFinishT == null && !s.noWin[i]) { s.firstFinishT = s.raceT; if (s.onWinner) s.onWinner(i); }
      }
      if (s.fin[i] === 1 && s.raceT - s.finT[i] > 4) s.fin[i] = 2;
      // буст: на ділянці зі стрілками кулька розганяється вздовж траси (до BOOST_V)
      if (s.alive[i] && s.zone[i] === 1 && m.boost.length) {
        const b = s.idx[i];
        for (const r of m.boost) if (b >= r[0] && b <= r[1]) {
          const o = b * 3, vf = s.vx[i] * m.ft[o] + s.vy[i] * m.ft[o + 1] + s.vz[i] * m.ft[o + 2];
          if (vf < BOOST_V) { const d = Math.min(BOOST_A * DT, BOOST_V - vf); s.vx[i] += m.ft[o] * d; s.vy[i] += m.ft[o + 1] * d; s.vz[i] += m.ft[o + 2] * d; }
          break;
        }
      }
      // тіньовий бан: заблокований вилітає з траси.
      //  • у провалі (трамплін) — гасимо швидкість уперед: не долітає;
      //  • запасний варіант — на 70% траси викидає за борт (на трасі з грозою — блискавкою)
      if (s.noWin[i] && s.alive[i] && !s.fin[i] && s.zone[i] === 1 && (!s.ejected[i] || s.t - s.ejT[i] > 2.5)) {   // повернувся на трасу — ще раз
        const b = s.idx[i];
        // на розгоні перед трампліном (останні ~6 м) плавно втрачає швидкість, як від тертя, — злітає слабше і по звичайній дузі
        // не долітає. У повітрі вже нічого не робимо. Із цього моменту — «привид»: його не штовхають і він нікого не збиває
        const g0 = m.gapStarts.find(g => b >= g - 12 && b < g);
        if (g0 != null) {
          const o = b * 3, vf = s.vx[i] * m.ft[o] + s.vz[i] * m.ft[o + 2], target = s.weakV[i];
          if (vf > target) { const f = Math.max(target / vf, 0.95); s.vx[i] *= f; s.vz[i] *= f; }
          s.ghost[i] = 1;
        }
        else if (!m.faces.length && s.prog[i] > m.len * 0.7) {   // траса без провалу — запасний варіант
          if (m.storm.length) { const x = s.px[i], y = s.py[i] - 0.3, z = s.pz[i]; s.strikes.push({ x, y, z, hit: strike(s, x, y, z, 1.2, STORM_POWER, s.rnd), t: s.raceT }); }
          else eject(s, i, s.rnd);
        }
      }     // фінішер «зникає» з чаші
      // падіння з траси: кілька секунд поза жолобом — вибув (або повертається на трасу)
      if (s.zone[i] === 1 && s.fallT[i] > 1.4) {
        const o = s.idx[i] * 3;
        if (m.eliminate && s.py[i] < m.fp[o + 1] - 4) {
          s.alive[i] = 0; s.elimT[i] = s.raceT;
          s.cause[i] = s.t - s.struckT[i] < 5 ? 'сбит молнией' : (s.ghost[i] && !s.ejected[i]) || m.open[s.idx[i]] || m.open[Math.max(0, s.idx[i] - 6)] ? 'не допрыгнул' : 'вылетел с трассы';
          s.eliminated.push(i); s.fallT[i] = 0;
        } else if (!m.eliminate || s.py[i] < m.fp[o + 1] - 12) {
          s.px[i] = m.fp[o]; s.py[i] = m.fp[o + 1] + 1; s.pz[i] = m.fp[o + 2]; s.vx[i] = s.vy[i] = s.vz[i] = 0; s.fallT[i] = 0; s.oob++;
        }
      }
      // застряг — поштовх уперед по трасі
      if (s.raceOn && s.zone[i] === 1 && !s.fin[i]) {
        const v2 = s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i] + s.vz[i] * s.vz[i];
        if (v2 < STUCK_V * STUCK_V) { s.stuck[i] += DT; if (s.stuck[i] > STUCK_T) { const o = s.idx[i] * 3, kk = s.noWin[i] ? 12 : 3; s.vx[i] += m.ft[o] * kk; s.vy[i] += 2; s.vz[i] += m.ft[o + 2] * kk; s.stuck[i] = 0; s.kicks++; } }   // заблокований, що скотився з трампліна, штовхаємо сильніше: злітає в провал
        else s.stuck[i] = 0;
      }
    }
    // кінець: усі фінішували/вибули, або 60 с після першого фінішу
    if (!s.done) {
      let left = 0; for (let i = 0; i < s.N; i++) if (s.alive[i] && !s.fin[i]) left++;
      if (!left || (s.firstFinishT != null && s.raceT - s.firstFinishT > 60)) s.done = true;
    }
  }
  // удар блискавки в точку (x, y, z): кульки в радіусі r отримують поштовх угору й від центру
  // (сила спадає до краю). Повертає індекси зачеплених — для спалахів у рендері.
  function strike(s, x, y, z, r, power, rnd) {
    rnd = rnd || Math.random;
    const hit = [];
    for (let i = 0; i < s.N; i++) {
      if (!s.alive[i] || s.fin[i] || s.zone[i] !== 1) continue;
      const dx = s.px[i] - x, dy = s.py[i] - y, dz = s.pz[i] - z, d = Math.hypot(dx, dy, dz);
      if (d > r) continue;
      const k = 1 - d / r, hd = Math.hypot(dx, dz) || 1e-6;
      s.struckT[i] = s.t;
      if (s.noWin[i]) { eject(s, i, rnd); hit.push(i); continue; }
      const side = power * 0.7 * k * (0.6 + 0.8 * rnd());
      s.vx[i] += dx / hd * side + (rnd() - 0.5) * 2; s.vz[i] += dz / hd * side + (rnd() - 0.5) * 2;
      s.vy[i] += power * k * (0.75 + 0.5 * rnd());
      s.stuck[i] = 0; hit.push(i);
    }
    return hit;
  }
  // викинути кульку за борт: убік від середини жолоба (вздовж «вправо» рамки) + угору — перелітає будь-який борт
  function eject(s, i, rnd) {
    const m = s.map, o = s.idx[i] * 3;
    const lx = (s.px[i] - m.fp[o]) * m.fr[o] + (s.py[i] - m.fp[o + 1]) * m.fr[o + 1] + (s.pz[i] - m.fp[o + 2]) * m.fr[o + 2];
    const sd = Math.abs(lx) > 0.3 ? Math.sign(lx) : (rnd() < 0.5 ? -1 : 1);
    const sp = 9 + rnd() * 3;
    s.vx[i] = m.fr[o] * sd * sp + m.ft[o] * 3; s.vz[i] = m.fr[o + 2] * sd * sp + m.ft[o + 2] * 3;
    s.vy[i] = 8 + rnd() * 3;
    s.ejected[i] = 1; s.ejT[i] = s.t; s.stuck[i] = 0; s.ghost[i] = 1;
  }
  // гроза: поки гонка йде, раз на 1.1–2.6 с блискавка б'є в кульку, що зараз у грозовій ділянці
  // (ціль — випадкова кулька з тих, хто там; так удар припадає туди, де густо). Події — у s.strikes для рендера.
  const STORM_R = 2.8, STORM_POWER = 12.5;
  function stormTick(s, dt) {
    const m = s.map; if (!m.storm.length || !s.raceOn || s.done) return;
    s.stormT = (s.stormT == null ? 1.5 : s.stormT) - dt;
    if (s.stormT > 0) return;
    s.stormT = 1.1 + s.rnd() * 1.5;
    const cand = [];
    for (let i = 0; i < s.N; i++) {
      if (!s.alive[i] || s.fin[i] || s.zone[i] !== 1) continue;
      const b = s.idx[i];
      for (const r of m.storm) if (b >= r[0] && b <= r[1]) { cand.push(i); break; }
    }
    if (!cand.length) return;
    const banned = cand.filter(i => s.noWin[i] && (!s.ejected[i] || s.t - s.ejT[i] > 2.5));
    const t = banned.length && s.rnd() < 0.75 ? banned[Math.floor(s.rnd() * banned.length)] : cand[Math.floor(s.rnd() * cand.length)];
    const x = s.px[t] + (s.rnd() - 0.5) * 1.2, y = s.py[t] - 0.3, z = s.pz[t] + (s.rnd() - 0.5) * 1.2;
    const hit = strike(s, x, y, z, STORM_R, STORM_POWER, s.rnd);
    s.strikes.push({ x, y, z, hit, t: s.raceT });
  }
  function openGate(s) { s.gateOpen = true; s.raceOn = true; }
  // підсумковий порядок: фінішери за часом, далі — хто далі проїхав, далі — вибулі (останній вибулий вище)
  function standings(s) {
    const out = s.finishOrder.filter(i => !s.noWin[i]).concat(s.finishOrder.filter(i => s.noWin[i]));
    const rest = [];
    for (let i = 0; i < s.N; i++) if (s.alive[i] && !s.fin[i]) rest.push(i);
    rest.sort((a, b) => s.prog[b] - s.prog[a]);
    return out.concat(rest, s.eliminated.slice().reverse());
  }
  root.MB2Core = { loadMap, createSim, step, openGate, standings, pegsAt, strike, R, DT };
})(typeof window !== 'undefined' ? window : globalThis);
