// ─────────────────────────────────────────────────────────────
//  🌀 Карта «Крутой спуск» — АВТОРСЬКА карта стрімера (ескіз twisting_tumble.blend),
//  перебудована під рушій у blender/marbles_tumble.blend (tumble_track.py / tumble_export.py).
//  Маршрут: лоток → тарілка-вирва з червоним бортом → підземний Y-розподіл (дах-клин)
//  → коротка ліва / довга права гілка → ДВІ ГАРМАТИ стріляють у чашу з кілками →
//  жолоб → пачинко-дошка зі шпильками → два серпантини з розгоном → ГАКИ (кулька
//  злітає вгору трубою і падає згори) → фінішна коробка FINISH.
//  Дані: tumble_phys.json (фізика, осі, гармати, гаки), tumble.glb (показ).
// ─────────────────────────────────────────────────────────────
(function () {
const PHYS_URL = '/assets/models/marbles/tumble_phys.json';
const GLB_URL = '/assets/models/marbles/tumble.glb?v=20261119c';   // ?v= — змінюй після переекспорту моделі
let DATA = null, GLB_SCENE = null, GLB_PROM = null;
const G = 12;                                   // гравітація рушія (MB_G)
// гармати: кулька в казенній частині → постріл по дузі в чашу (розкид у межах чаші — вибування немає)
const CN = { trigR: 2.4, spread: 6.2, catchR: 11.5, damp: 0.3, aimUp: 3.0, gap: 0.08 };
// гаки: поїздка трубою по кривій; швидкість з енергії (вгору — гальмує, вниз — розганяється)
const HK = { trigR: 2.1, v0: 17, vmin: 9, vmax: 22, exitV: 6, gap: 0.07 };

function b2u8(b64) { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const f32 = b64 => new Float32Array(b2u8(b64).buffer);
const u32 = b64 => new Uint32Array(b2u8(b64).buffer);
function meshOf(vb, ib) {
  const v = f32(vb), ix = u32(ib), keep = [];
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (cx * cx + cy * cy + cz * cz > 1e-8) keep.push(ix[t], ix[t + 1], ix[t + 2]);
  }
  return { vertices: v, indices: new Uint32Array(keep) };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const nrm = a => { const L = len(a) || 1e-9; return [a[0] / L, a[1] / L, a[2] / L]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
function polyLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += len(sub(p[i], p[i - 1])); return L; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function data() {
  if (!DATA && typeof MB_READ === 'function') DATA = JSON.parse(MB_READ(PHYS_URL));
  if (!DATA) throw new Error('Крутой спуск: дані траси ще не завантажені');
  return DATA;
}
function quatBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2], tr = m00 + m11 + m22;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S]; }
  if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; return [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S]; }
  if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S]; }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2; return [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
}
// кватерніон, що повертає вісь Y у напрям a (для циліндрів-шпильок)
function quatY(a) {
  const y = nrm(a), x = nrm(Math.abs(y[0]) < 0.9 ? cross(y, [1, 0, 0]) : cross(y, [0, 0, 1])), z = cross(x, y);
  return quatBasis(x, y, z);
}
function lathePlates(c, prof, N, thick) {
  let area = 0; const m = prof.length;
  for (let j = 0; j < m; j++) { const a = prof[j], b = prof[(j + 1) % m]; area += a[0] * b[1] - b[0] * a[1]; }
  const sg = area < 0 ? 1 : -1, plates = [];
  for (let j = 0; j + 1 < m; j++) {
    if (!prof[j][2]) continue;
    const a = prof[j], b = prof[j + 1], gl = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (gl < 1e-3) continue;
    const nx = sg * -(b[1] - a[1]) / gl, ny = sg * (b[0] - a[0]) / gl;
    const halfW = Math.max(a[0], b[0]) * Math.tan(Math.PI / N) + 0.35;
    for (let k = 0; k < N; k++) {
      const ph = (k + 0.5) / N * 2 * Math.PI, cs = Math.cos(ph), sn = Math.sin(ph);
      const tv = [-sn, 0, cs], gv = nrm([(b[0] - a[0]) * cs, b[1] - a[1], (b[0] - a[0]) * sn]);
      const nv = nrm([nx * cs, ny, nx * sn]);
      const zv = cross(tv, nv), gz = dot(zv, gv) < 0 ? mul(zv, -1) : zv;
      const tx = dot(cross(nv, gz), tv) < 0 ? mul(tv, -1) : tv;
      const mid = [c[0] + (a[0] + b[0]) / 2 * cs, c[1] + (a[1] + b[1]) / 2, c[2] + (a[0] + b[0]) / 2 * sn];
      plates.push({ pos: sub(mid, mul(nv, thick / 2)), quat: quatBasis(tx, nv, gz), size: [halfW, thick / 2, gl / 2] });
    }
  }
  return plates;
}
// номінальна дуга пострілу (вісь стадії «політ» і камера)
function arc(c, n) {
  const F = c.flight, M = c.muzzle, T = [c.target[0], c.target[1] + CN.aimUp, c.target[2]];
  const v = [(T[0] - M[0]) / F, (T[1] - M[1]) / F + 0.5 * G * F, (T[2] - M[2]) / F], out = [];
  for (let i = 0; i <= n; i++) { const t = F * i / n; out.push([M[0] + v[0] * t, M[1] + v[1] * t - 0.5 * G * t * t, M[2] + v[2] * t]); }
  return out;
}
// точка й дотична на полілінії гака за довжиною s
function pathAt(h, s) {
  const P = h.path, C = h.cum;
  let i = 1; while (i < P.length - 1 && C[i] < s) i++;
  const a = P[i - 1], b = P[i], L = C[i] - C[i - 1] || 1e-6, t = Math.max(0, Math.min(1, (s - C[i - 1]) / L));
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], d: nrm(sub(b, a)) };
}
// колізії кульки на час поїздки трубою вимикаємо (кульки в гаку не штовхаються)
function setSolid(b, on) {
  try { const c = b.body.collider(0); if (c && c.setCollisionGroups) c.setCollisionGroups(on ? 0xFFFFFFFF : 0); } catch (e) { /* стара збірка Rapier — нехай штовхаються */ }
}

const MAP = {
  id: 'tumble',
  name: 'Крутой спуск',
  icon: '🌀',
  approxSec: 75,
  desc: 'Тарелка-воронка, две пушки, пачинко и крюки над финишем.',
  customRender: true,
  theme: { sky: { hor: '#bfe3ff', zen: '#3a86d8' }, fog: '#cfe6fb', fogDensity: 0.0011, clear: '#cfe6fb', cloudFloor: '#7fb2ec', hemi: ['#eef6ff', '#7c8fb0', 0.85], sun: ['#fff4e0', 1.15] },

  preload() {
    if (DATA) return Promise.resolve();
    return fetch(PHYS_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => { DATA = j; });
  },

  build(B) {
    const D = data();
    const X = B.extra.tumble = { cannons: [], hooks: [] };
    const aux = (g, st) => { B.segments.push(g); g.stage = st; g.stageIdx = B.stages.length - 1; g.noProgress = true; return g; };
    const sweep = s => ({ id: s.id, kind: 'sweep', mesh: meshOf(s.v, s.i), center: s.center, length: polyLen(s.center),
      start: s.center[0].slice(), end: s.center[s.center.length - 1].slice(), branch: s.branch || 0 });
    const segOf = id => sweep(D.segs.find(s => s.id === id));
    const L = id => D.lathes.find(l => l.id === id);
    const way = (id, center, extra) => Object.assign({ id, kind: 'boxes', boxes: [], balls: [], center, length: polyLen(center), start: center[0].slice(), end: center[center.length - 1].slice() }, extra || {});
    // ── лоток 32×16 над бортом тарілки ──
    const bw = D.bowl, O = bw.c, rimY = O[1] + bw.rim;
    const TRAY_L = 32, TRAY_W = 16, HINGE = [O[0] - 20.5, rimY + 1.2, O[2]];
    const tray = {
      id: 'tray', kind: 'tray', hinge: HINGE.slice(), axis: [0, 0, 1], L: TRAY_L, W: TRAY_W,
      boxes: [
        B.box([-TRAY_L / 2, -0.25, 0], 0, [TRAY_L / 2, 0.25, TRAY_W / 2], 'floor'),
        B.box([-TRAY_L / 2, 0.5, TRAY_W / 2 + 0.3], 0, [TRAY_L / 2, 0.75, 0.3]),
        B.box([-TRAY_L / 2, 0.5, -TRAY_W / 2 - 0.3], 0, [TRAY_L / 2, 0.75, 0.3]),
        B.box([-TRAY_L - 0.3, 0.5, 0], 0, [0.3, 0.75, TRAY_W / 2 + 0.6]),
      ],
      slots: [], center: [[HINGE[0] - TRAY_L, HINGE[1], 0], HINGE.slice()], length: TRAY_L,
    };
    { const rows = Math.floor((TRAY_L - 1.6) / B.C.TRAY_STEP); for (let r = 0; r < rows; r++) for (let c = 0; c < B.C.TRAY_COLS; c++) tray.slots.push([-(1.85 + r * B.C.TRAY_STEP), B.C.R + 0.05, (c - (B.C.TRAY_COLS - 1) / 2) * B.C.TRAY_STEP]); }
    B.addStage('tray', [tray], () => 12);
    // ── 1) тарілка-вирва: вісь іде по схилу конуса до стоку ──
    const st = L('F_start'), cy = r => O[1] + bw.k * (r - bw.rT);
    const bowl = { id: 'bowl', kind: 'lathe', c: st.center, plates: lathePlates(st.center, st.prof, 56, 1.0),
      center: [HINGE.slice(), [O[0] - 18, cy(18), O[2]], [O[0] - 12, cy(12), O[2]], [O[0] - 6, cy(6), O[2]], [O[0] - bw.rT, cy(bw.rT), O[2]], [O[0], O[1] - 2.5, O[2]], [O[0], O[1] - 7.2, O[2]]] };
    bowl.length = polyLen(bowl.center);
    B.addStage('bowl', [bowl], (seg, i) => i <= 3 ? 30 : 7);   // кулька може кружляти по всій тарілці
    // тверді деталі з Blender (дах-розподільник, дошка, стінки, коробка) — сітки без прогресу
    for (const e of D.extra) aux({ id: e.id, kind: 'sweep', mesh: meshOf(e.v, e.i) }, 'bowl');
    // ── 2) Y-розподіл: коротка ліва і довга права гілки ──
    const gL = segOf('T10_left'), gR = segOf('T11_right');
    B.addStage('split', [gL, gR], () => 6);
    // ── гармати: кожна стріляє з кінця своєї гілки в чашу з кілками ──
    const cL = Object.assign({ k: 'L' }, D.cannons.cL), cR = Object.assign({ k: 'R' }, D.cannons.cR);
    X.cannons.push(cL, cR);
    B.addStage('leap', [way('leapL', arc(cL, 12), { branch: 0 }), way('leapR', arc(cR, 12), { branch: 1 })], () => 16);
    // ── 3) чаша з концентричними кілками ──
    const bs = D.basin, bc = bs.c, fb = L('F_basin');
    const cylOf = c => ({ pos: c.c, quat: quatY(c.a), r: c.r, hh: c.hh });
    const pegs = D.cyls.filter(c => c.c[1] > bc[1] - 2).map(cylOf);
    const pins = D.cyls.filter(c => c.c[1] <= bc[1] - 2).map(cylOf);
    const basin = { id: 'basin', kind: 'lathe', c: fb.center, plates: lathePlates(fb.center, fb.prof, 48, 1.0),
      center: [[bc[0], bc[1] + bs.rim, bc[2]], [bc[0], bc[1] + 0.5, bc[2]], [bc[0], bc[1] - 5.2, bc[2]]] };
    basin.length = polyLen(basin.center);
    B.addStage('basin', [basin], () => 14);
    X.basin = { c: bc, rD: bs.rD, rim: bs.rim };
    X.sBasin = B.stages[B.stages.length - 1].s0 + 2;
    aux({ id: 'basinPegs', kind: 'boxes', boxes: [], balls: [], cyls: pegs }, 'basin');
    // ── 4) жолоб → пачинко-дошка → два серпантини ──
    B.addStage('chute', [segOf('T20_chute')], () => 6);
    const bd = D.board, by = y => bd.z0 + (y - bd.y0) * bd.k;           // y у Blender (тут — −z рушія)
    const boardC = [[-12, by(-52) + 0.6, 52], [-12, by(-60) + 0.6, 60], [-12, by(-70) + 0.6, 70], [-12, by(-78) + 0.6, 78], [-12, by(-82) + 0.6, 82]];
    B.addStage('board', [way('board', boardC, { cyls: pins })], () => 14);
    X.board = boardC;
    const sR = segOf('T30_serpR'), sL = segOf('T31_serpL');
    B.addStage('serp', [sR, sL], () => 6);
    // розгін перед гаком: останні 7 м серпантина
    for (const g of [sR, sL]) {
      // рамок у сегментів з Blender немає — зону ставимо як бокс уздовж кінця осі
      const c = g.center, e = c[c.length - 1], p = c[Math.max(0, c.length - 6)], d = nrm(sub(e, p)), m = [(e[0] + p[0]) / 2, (e[1] + p[1]) / 2, (e[2] + p[2]) / 2];
      const up = [0, 1, 0], r = nrm(cross(d, up)), u = cross(r, d);
      B.zones.push({ type: 'boost', seg: g, sLoc: g.length - len(sub(e, p)) / 2, o: { vt: 15, acc: 30, hh: 1.0, len: len(sub(e, p)), noGfx: true },
        c: [m[0] + u[0] * 0.95, m[1] + u[1] * 0.95, m[2] + u[2] * 0.95], x: d, y: u, z: r, h: [len(sub(e, p)) / 2, 1.0, 3.0], s: 0, reach: 0 });
    }
    // ── 5) гаки: кулька їде трубою (вгору, загин, униз) і падає в коробку ──
    for (const h of D.hooks) {
      const cum = [0]; for (let i = 1; i < h.path.length; i++) cum.push(cum[i - 1] + len(sub(h.path[i], h.path[i - 1])));
      X.hooks.push({ side: h.side, trig: h.trig, path: h.path, cum, L: cum[cum.length - 1], n: 0, lastT: null });
    }
    const hR = X.hooks.find(h => h.side === 'R'), hL = X.hooks.find(h => h.side === 'L');
    B.addStage('hook', [way('hookR', hR.path, { branch: 0 }), way('hookL', hL.path, { branch: 1 })], () => 6);
    const fp = D.finish.p, ex = hR.path[hR.path.length - 1];
    B.addStage('box', [way('boxIn', [[(ex[0] + hL.path[hL.path.length - 1][0]) / 2, ex[1], ex[2]], fp.slice()])], () => 12);
    B.finish = { p: fp.slice(), f: D.finish.f.slice(), r: D.finish.r, s: B.S() };
    B.tray = tray;
    X.box = D.box; X.finishP = fp.slice();
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W]);
    for (const c of X.cannons) for (const p of arc(c, 6)) B.extraPoints.push([p[0] + 4, p[1] + 4, p[2] + 4], [p[0] - 4, p[1] - 4, p[2] - 4]);
    for (const h of X.hooks) for (const p of h.path) B.extraPoints.push([p[0] + 2, p[1] + 2, p[2] + 2], [p[0] - 2, p[1] - 2, p[2] - 2]);
  },

  step(st, dt) {
    const X = st.track.extra.tumble; if (!X || !st.raceOn) return;
    // ── гармати ──
    for (const c of X.cannons) {
      const key = 'shot' + c.k;
      for (const b of st.active) {
        if (b[key] != null || b.ride) continue;
        const dx = b.x - c.trig[0], dy = b.y - c.trig[1], dz = b.z - c.trig[2];
        if (dx * dx + dy * dy + dz * dz > CN.trigR * CN.trigR) continue;
        // черга: по одній кульці за CN.gap с — інакше кілька зʼявлялись би в одній точці дула
        if (c.lastT != null && st.raceT - c.lastT < CN.gap) {
          b.vx *= 0.2; b.vz *= 0.2; if (b.vy > 0) b.vy = 0; b.body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
          continue;
        }
        const r = rng(b.idx * 131 + (c.k === 'L' ? 977 : 1999) + st.balls.length * 7 + 3);
        const a = r() * Math.PI * 2, rad = CN.spread * Math.sqrt(r());
        const T = [c.target[0] + Math.cos(a) * rad, c.target[1] + CN.aimUp, c.target[2] + Math.sin(a) * rad], M = c.muzzle, F = c.flight * (0.94 + 0.12 * r());
        const v = { x: (T[0] - M[0]) / F, y: (T[1] - M[1]) / F + 0.5 * G * F, z: (T[2] - M[2]) / F };
        b.body.setTranslation({ x: M[0], y: M[1], z: M[2] }, true);
        b.body.setLinvel(v, true); b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        b.x = M[0]; b.y = M[1]; b.z = M[2]; b.vx = v.x; b.vy = v.y; b.vz = v.z;
        b[key] = st.raceT; b.leapT = st.raceT;
        c.n = (c.n || 0) + 1; c.lastT = st.raceT;
      }
    }
    // «сітка» чаші: прилетілий шарик гасить швидкість — інакше відскакує від кілків через борт
    const B0 = X.basin;
    // хто після пострілу так і не дістався чаші (застряг на борту, впав повз) — опускаємо в чашу згори
    if ((st.frame % 30) === 0) for (const b of st.active) {
      if (b.leapT == null || b.inBasin || st.raceT - b.leapT < 4.5) continue;
      if (b.prog >= X.sBasin) { b.inBasin = 1; continue; }
      const a = (b.idx * 2.399) % (Math.PI * 2), rr = 3 + (b.idx % 5);
      b.body.setTranslation({ x: B0.c[0] + Math.cos(a) * rr, y: B0.c[1] + B0.rim + 2, z: B0.c[2] + Math.sin(a) * rr }, true);
      b.body.setLinvel({ x: 0, y: -2, z: 0 }, true); b.inBasin = 1; b.caught = 1;
    }
    for (const b of st.active) {
      if (b.leapT == null || b.caught) continue;
      const dx = b.x - B0.c[0], dz = b.z - B0.c[2], dy = b.y - B0.c[1];
      if (dx * dx + dz * dz > CN.catchR * CN.catchR || dy > B0.rim + CN.aimUp + 1 || b.vy > 0) continue;
      b.caught = 1; b.vx *= CN.damp; b.vy *= CN.damp; b.vz *= CN.damp;
      b.body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
    }
    // ── гаки ──
    for (const h of X.hooks) {
      for (const b of st.active) {
        if (b.ride || b.rode) continue;
        const dx = b.x - h.trig[0], dy = b.y - h.trig[1], dz = b.z - h.trig[2];
        if (dx * dx + dy * dy + dz * dz > HK.trigR * HK.trigR) continue;
        if (h.lastT != null && st.raceT - h.lastT < HK.gap) {
          b.vx *= 0.3; b.vz *= 0.3; b.body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
          continue;
        }
        b.ride = { h, s: 0, v: Math.max(HK.v0, Math.hypot(b.vx, b.vy, b.vz)), y0: h.path[0][1] };
        b.ride.e = b.ride.v * b.ride.v;
        h.lastT = st.raceT; h.n++;
        setSolid(b, false);
        b.hookT = st.raceT;
      }
    }
    for (const b of st.active) {
      const R = b.ride; if (!R) continue;
      const h = R.h;
      R.s += R.v * dt;
      const at = pathAt(h, Math.min(R.s, h.L));
      R.v = Math.max(HK.vmin, Math.min(HK.vmax, Math.sqrt(Math.max(0, R.e - 2 * G * (at.p[1] - R.y0)))));
      if (R.s >= h.L) {
        // кінець труби: кулька вилітає донизу в коробку
        const v = mul(at.d, Math.max(HK.exitV, R.v * 0.6));
        b.body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
        b.vx = v[0]; b.vy = v[1]; b.vz = v[2];
        b.ride = null; b.rode = st.raceT; setSolid(b, true);
        continue;
      }
      const v = mul(at.d, R.v);
      b.body.setTranslation({ x: at.p[0], y: at.p[1], z: at.p[2] }, true);
      b.body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
      b.x = at.p[0]; b.y = at.p[1]; b.z = at.p[2]; b.vx = v[0]; b.vy = v[1]; b.vz = v[2];
      b.stuck = 0;
    }
    // коробка: приземлення гасимо, щоб фінішери не вистрибували за борт
    const bx = X.box;
    if ((st.frame & 1) === 0) for (const b of st.balls) {
      if (!b.rode || b.boxed || !b.inWorld) continue;
      if (b.y > bx.c[1] + 2.5 || Math.abs(b.x - bx.c[0]) > bx.hx || Math.abs(b.z - bx.c[2]) > bx.hz) continue;
      b.boxed = 1;
      const v = b.body.linvel(); b.body.setLinvel({ x: v.x * 0.3, y: v.y * 0.25, z: v.z * 0.3 }, true);
    }
  },

  intro(track, pos, look) {
    const H = track.tray.hinge;
    pos.set(H[0] - 40, H[1] + 26, H[2] - 34);
    look.set(H[0] + 14, H[1] - 6, H[2] + 4);
  },

  // спецплани: тарілка, розподіл під нею, гармати, дошка, гаки
  camera(st, leader, pos, look) {
    const track = st.track, X = track.extra.tumble; if (!X) return false;
    if (!X.sIdx) { X.sIdx = {}; for (const g of track.stages) X.sIdx[g.id] = g; }
    const S = X.sIdx, s = leader.prog, O = track.byId.bowl.c;
    if (s < S.bowl.s1 - 6) { pos.set(O[0] - 34, O[1] + 26, O[2] - 26); look.set(O[0], O[1] - 3, O[2]); return true; }
    if (leader.ride) {   // у гаку — збоку на трубу і коробку
      const h = leader.ride.h, e = h.path[h.path.length - 1];
      pos.set(e[0] + 26, e[1] + 10, e[2] - 14); look.set(e[0], e[1] - 2, e[2] - 4); return true;
    }
    for (const c of X.cannons) {
      const t = leader['shot' + c.k];
      if (t != null && st.raceT - t < c.flight + 0.3) {
        const m = c.muzzle, T = c.target, mx = (m[0] + T[0]) / 2, my = (m[1] + T[1]) / 2, mz = (m[2] + T[2]) / 2;
        const d = nrm([T[0] - m[0], 0, T[2] - m[2]]), side = [-d[2], 0, d[0]];
        pos.set(mx + side[0] * 34, my + 10, mz + side[2] * 34); look.set(mx, my - 2, mz); return true;
      }
    }
    if (s >= S.board.s0 - 1 && s < S.board.s1 + 2) {   // пачинко-дошка: згори-збоку, видно всі шпильки
      const B2 = X.board, a = B2[0], z = B2[B2.length - 1];
      pos.set(a[0] - 24, a[1] + 16, (a[2] + z[2]) / 2 - 2); look.set(a[0] + 1, (a[1] + z[1]) / 2 - 1, (a[2] + z[2]) / 2 + 2); return true;
    }
    if (s >= S.split.s0 - 2 && s < S.split.s1) { pos.set(leader.x + 10, leader.y + 5, leader.z - 16); look.set(leader.x, leader.y - 1, leader.z); return true; }
    return false;
  },

  decor(track, ctx) {
    const { THREE, scene } = ctx;
    const X = track.extra.tumble;
    const holder = new THREE.Group(); scene.add(holder);
    const put = sc => {
      const root = sc.clone(true);
      root.traverse(o => {
        if (!o.isMesh) return;
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        const m = o.material; if (!m || !m.isMeshStandardMaterial) return;
        const cloud = /Cloud/.test(m.name);
        if (cloud) { m.flatShading = false; m.metalness = 0; m.envMapIntensity = 0; m.roughness = 1; m.emissive.set('#9fb8d8').multiplyScalar(0.35); }
        else { m.envMap = ctx.env; m.envMapIntensity = 0.7; }
        if (/Glass/.test(m.name)) {
          m.transparent = true; m.opacity = 0.5; m.depthWrite = false; m.side = THREE.DoubleSide;
          m.color.set('#7cc4ff'); m.emissive.set('#2a78d8'); m.emissiveIntensity = 0.45; m.roughness = 0.08; m.envMapIntensity = 1.2;
        }
        if (/Finish_Text/.test(m.name)) { m.emissive.set('#000'); }
        // жовто-чорна шахівниця фінішу: процедурна фактура Blender у glTF не потрапляє — малюємо в шейдері за світовими координатами
        if (/Checker/.test(m.name) && !m.userData.chk) {
          m.userData.chk = true; m.color.set('#ffffff');
          m.onBeforeCompile = sh => {
            sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vChk;')
              .replace('#include <begin_vertex>', '#include <begin_vertex>\nvChk = (modelMatrix * vec4(position, 1.0)).xyz;');
            sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vChk;')
              .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec3 q = floor(vChk * 2.2); float k = mod(q.x + q.y + q.z, 2.0); vec4 diffuseColor = vec4(mix(vec3(1.0, 0.8, 0.05), vec3(0.04), k), opacity);');
          };
          m.needsUpdate = true;
        }
        o.castShadow = !cloud && !/Glass/.test(m.name); o.receiveShadow = !cloud;
      });
      if (window.mbDepthLayers) mbDepthLayers(root);   // без мерехтіння на стиках і там, де декор у площині траси
      holder.add(root);
    };
    if (GLB_SCENE) put(GLB_SCENE);
    else {
      if (!GLB_PROM) GLB_PROM = new Promise((ok, no) => new THREE.GLTFLoader().load(GLB_URL, g => { GLB_SCENE = g.scene; ok(g.scene); }, undefined, no));
      GLB_PROM.then(put).catch(e => console.warn('[marbles] модель «Крутого спуска» не загрузилась', e));
    }
    if (ctx.trayGroup) {
      const tr = track.tray, mat = new THREE.MeshStandardMaterial({ color: '#2f8cf2', roughness: 0.2, envMap: ctx.env, envMapIntensity: 0.6 });
      const rim = new THREE.MeshStandardMaterial({ color: '#f21414', roughness: 0.3 });
      const floor = new THREE.Mesh(new THREE.BoxGeometry(tr.L, 0.5, tr.W), mat); floor.position.set(-tr.L / 2, -0.25, 0); floor.receiveShadow = floor.castShadow = true; ctx.trayGroup.add(floor);
      for (const [px, pz, sx, sz] of [[-tr.L / 2, tr.W / 2 + 0.3, tr.L, 0.6], [-tr.L / 2, -tr.W / 2 - 0.3, tr.L, 0.6], [-tr.L - 0.3, 0, 0.6, tr.W + 1.2]]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.5, sz), rim); w.position.set(px, 0.5, pz); w.castShadow = true; ctx.trayGroup.add(w);
      }
      const s = new THREE.Mesh(new THREE.PlaneGeometry(tr.W - 1.2, 2.2), ctx.mats.start); s.rotation.set(-Math.PI / 2, 0, Math.PI / 2); s.position.set(-1.8, 0.02, 0); ctx.trayGroup.add(s);
    }
    // спалах на дулах гармат
    const glowTex = (inner, outer) => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62); gr.addColorStop(0, inner); gr.addColorStop(0.35, outer); gr.addColorStop(1, 'rgba(255,120,60,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); };
    X.fx = X.cannons.map(c => {
      const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,255,230,1)', 'rgba(255,170,60,.9)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0 }));
      fl.position.set(c.muzzle[0], c.muzzle[1] + 0.3, c.muzzle[2]); fl.scale.setScalar(6); scene.add(fl);
      const light = new THREE.PointLight('#ffb36b', 0, 36, 2); light.position.copy(fl.position); scene.add(light);
      return { c, fl, light, lastN: 0, sndT: 0 };
    });
  },

  frame(st) {
    const X = st.track.extra.tumble; if (!X || !X.fx) return;
    const now = performance.now();
    for (const f of X.fx) {
      const age = f.c.lastT != null ? st.raceT - f.c.lastT : 9;
      const k = Math.max(0, 1 - age / 0.25);
      f.fl.material.opacity = k; f.fl.scale.setScalar(5 + 4 * (1 - k)); f.light.intensity = 26 * k;
      if ((f.c.n || 0) > f.lastN && now - f.sndT > 180) {
        f.lastN = f.c.n; f.sndT = now;
        if (typeof playSfx === 'function') playSfx('cannon', 0.4, 0.9 + Math.random() * 0.25, 600);
      }
    }
  },
};
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
