// ─────────────────────────────────────────────────────────────
//  ⚡ Карта «Зевсятина» — ТРАСА ЗМОДЕЛЬОВАНА В BLENDER (blender/marbles_zeus.blend).
//  Олімп над хмарами: вирва-змішувач → сходи храму з колонами → спіраль навколо
//  колони → ПЛОЩА ЗЕВСА (велетень збоку мече блискавки: де вдарило — кульки вибувають)
//  → два золоті млини → три брами (горби / гірка / зигзаг) → збірник → вихор → фініш.
//  Фізика — zeus_phys.json (сітки жолобів, профілі вирв, колони-перешкоди, мета),
//  показ — zeus.glb (траса, храм, Зевс, символи) + нічне небо з сяйвом тут.
//  Блискавки: map.step (детерміновано від st.raceT і порядку кульок), показ — map.frame.
// ─────────────────────────────────────────────────────────────
(function () {
const PHYS_URL = '/assets/models/marbles/zeus_phys.json';
const GLB_URL = '/assets/models/marbles/zeus.glb?v=20261119';   // ?v= — змінюй після переекспорту моделі (сервер кешує .glb на 7 днів)
let DATA = null, GLB_SCENE = null, GLB_PROM = null;

function b2u8(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const f32 = b64 => new Float32Array(b2u8(b64).buffer);
const u32 = b64 => new Uint32Array(b2u8(b64).buffer);
// сітка для фізики без вироджених трикутників: заглушки кінців кривої в Blender дають
// трикутники нульової площі, а Rapier на них рахує сміттєву нормаль — кулька
// «вдаряється» об порожнечу й відскакує назад (хаб тримав пів пелетону)
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
function polyLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += len(sub(p[i], p[i - 1])); return L; }
function data() {
  // node (headless-стенди): файл читає хост через глобальний MB_READ
  if (!DATA && typeof MB_READ === 'function') DATA = JSON.parse(MB_READ(PHYS_URL));
  if (!DATA) throw new Error('Зевсятина: дані траси ще не завантажені');
  return DATA;
}

// фізика тіла обертання: дотичні плити під кожним ребром ВНУТРІШНЬОЇ поверхні профілю
// (r, y, inner). Товщина 1 м — щільний пелетон не продавить кульку крізь стінку
function quatBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2], tr = m00 + m11 + m22;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S]; }
  if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; return [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S]; }
  if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S]; }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2; return [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
}
const nrm = a => { const L = len(a) || 1e-9; return [a[0] / L, a[1] / L, a[2] / L]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
function lathePlates(c, prof, N, thick) {
  // обхід контуру: знак площі → зовнішня нормаль (у повітря) для кожного ребра
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
      // рушій: площина обертання — XZ, вісь — Y
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


// Blender (x, y, z угору) → рушій (x, z, −y)
const BE = p => [p[0], p[2], -p[1]];
// детермінований ГВЧ (mulberry32): однаковий результат у headless-стенді й у браузері
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
// параметри блискавок: попередження (с), радіус удару (м), пауза між ударами, частка поля, яку можна вибити,
// lead — ціль обирається серед передніх lead-частки кульок на колонаді («гнів Зевса» на лідерів)
const ZB = { warn: 1.0, r: 1.8, gapMin: 1.5, gapRnd: 0.9, killShare: 0.25, lead: 0.35 };
// «рука Зевса» стрімера: блискавка в руці + приціл, ЛКМ — удар по кульці під прицілом
const ZP = { cd: 0.3, pickR: 1.7 };   // рука Зевса стрімера: удари без ліміту, пауза 0.3 с між ними

const MAP = {
  id: 'zeus',
  name: 'Зевсятина',
  icon: '⚡',
  approxSec: 75,
  allSec: 130,
  desc: 'Олимп в грозу: старт из храма, дорога на колоннах над пропастью. Колоннада Зевса — он бьёт молниями по лидерам; молоты-маятники, трамплин через пропасть, развилка (узкая балка или шестерня), волны под золотыми кольцами и финиш под аркой.',
  eliminate: false,
  customRender: true,
  theme: { sky: { hor: '#9db3d3', zen: '#27304f' }, fog: '#9fb0cb', fogDensity: 0.0011, clear: '#9fb0cb', cloudFloor: '#6f7f9e', cloudTint: '#c9d3e6', hemi: ['#dfe6f5', '#5f6b88', 0.8], sun: ['#fff0d0', 1.25] },

  preload() {
    if (DATA) return Promise.resolve();
    return fetch(PHYS_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => { DATA = j; });
  },

  build(B) {
    const D = data(), meta = D.meta || {};
    const X = B.extra.zeus = {};
    const aux = (g, st) => { B.segments.push(g); g.stage = st; g.stageIdx = B.stages.length - 1; g.noProgress = true; return g; };
    const sweep = s => {
      const center = s.center;
      return { id: s.id, kind: 'sweep', mesh: meshOf(s.v, s.i), center, length: polyLen(center),
        start: center[0].slice(), end: center[center.length - 1].slice(), branch: s.branch || 0 };
    };
    // ── лоток у храмі 32×16: нахиляється до дверей ──
    const TRAY_L = 32, TRAY_W = 16, HINGE = [-20.5, 3.8, 0];
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
    B.addStage('tray', [tray], () => 14);
    // тверді деталі з Blender: золоті кілки на спуску, задня стінка під лотком
    for (const e of D.extra) if (/^X_/.test(e.id)) aux({ id: e.id, kind: 'sweep', mesh: meshOf(e.v, e.i) }, 'tray');
    // ── жолоби по стадіях; розвилка — дві гілки однієї стадії ──
    const groups = [];
    for (const s of D.segs) {
      let g = groups.find(q => q.stage === s.stage);
      if (!g) groups.push(g = { stage: s.stage, segs: [] });
      g.segs.push(sweep(s));
    }
    // kick/land: кулька в польоті над провалом далеко від осі — допуск ширший
    const TOL = { ramp: 11, bridge: 6, hammers: 6, hairpin1: 6, run: 6, kick: 11, land: 11, split: 5, merge: 8, hairpin2: 6, waves: 6.5, final: 7 };
    for (const g of groups) B.addStage(g.stage, g.segs, () => TOL[g.stage] || 6);
    // ── молоти-маятники: вісь поперек траси, голова проходить над самою підлогою ──
    X.hammers = (meta.hammers || []).map((h, i) => {
      const c = BE(h.pivot), L = h.arm;
      const boxes = [
        { pos: [0, -L / 2, [-1.7, 1.7, 0][i % 3]], quat: [0, 0, 0, 1], size: [0.16, L / 2, 0.16] },
        // головка вужча за жолоб і зміщена (ліво / право / центр) — збоку лишається прохід
        { pos: [0, -L, [-1.7, 1.7, 0][i % 3]], quat: [0, 0, 0, 1], size: [0.5, 0.55, 1.9], role: 'bumper' },
      ];
      return aux({ id: 'hammer' + i, kind: 'spinner', c, axis: [0, 0, 1], swing: { amp: 0.75, omega: 1.2, phase: h.phase }, boxes, balls: [], friction: 0.15, restitution: 0.1, arm: L }, 'hammers');
    });
    // ── шестерня на широкій гілці розвилки: зубці штовхають кульки ──
    X.gears = (meta.gears || []).map((g, i) => {
      const c = BE(g.c), boxes = [{ pos: [0, 0.6, 0], quat: [0, 0, 0, 1], size: [0.7, 0.6, 0.7] }];
      for (let k = 0; k < 6; k++) { const a = k / 6 * 2 * Math.PI; boxes.push({ pos: [Math.cos(a) * 1.55, 0.6, Math.sin(a) * 1.55], quat: B.quatYaw(-a), size: [1.05, 0.55, 0.24] }); }
      return aux({ id: 'gear' + i, kind: 'spinner', c, axis: [0, 1, 0], omega: g.omega, boxes, balls: [], friction: 0.2, restitution: 0.5 }, 'split');
    });
    // ніс між гілками розвилки
    const noses = (meta.noses || []).map(n => B.box(BE(n), Math.PI / 4, [0.5, 0.9, 0.5], 'wedge'));
    if (noses.length) X.noses = aux({ id: 'splitNose', kind: 'boxes', boxes: noses, balls: [] }, 'split');
    // ── фінішна площа (неглибока чаша) ──
    const fb = D.lathes.find(l => l.id === 'F_finish'), fp = D.finish.p, last = groups[groups.length - 1].segs[0].end;
    const bowl = { id: 'plaza', kind: 'lathe', c: fb.center, plates: lathePlates(fb.center, fb.prof, 48, 1.0), center: [last.slice(), fb.center.slice()] };
    bowl.length = polyLen(bowl.center);
    B.addStage('plaza', [bowl], () => 15);
    B.finish = { p: fp.slice(), f: D.finish.f.slice(), r: D.finish.r, s: B.S() - bowl.length };
    B.tray = tray;
    B.extra.orbit = fb.center.slice();
    // прискорювачі (смуги на підлозі): a→b уздовж, ширина w, до швидкості vt
    X.boosts = (meta.boosts || []).map(z => {
      const a = BE(z.a), b = BE(z.b), d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
      const t = [d[0] / L, d[1] / L, d[2] / L], n = nrm(cross(t, [0, 1, 0]));
      return { a, b, t, n, L, w: z.w, vt: z.vt };
    });
    X.rings = (meta.rings || []).map(r => ({ c: BE(r.c), r: r.r }));
    // колонада Зевса: x0..x1, підлога y(x) = y0 − k·(x − ax0), півширина
    const A = meta.arena || { x0: 0, x1: 0, z0: 0, drop: 0, len: 1, half: 4 };
    X.arena = { x0: A.x0, x1: A.x1, half: A.half, y0: A.z0, k: A.drop / A.len, ax0: A.x0 - 8 };
    X.zeus = meta.zeus ? { hand: BE(meta.zeus.hand) } : { hand: [(A.x0 + A.x1) / 2, A.z0 + 50, -34] };
    X.finishP = fp.slice(); X.plazaC = fb.center.slice();
    X.gap = meta.finish_arch ? BE([meta.finish_arch.x, meta.finish_arch.y, meta.finish_arch.z]) : fp.slice();
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W]);
    B.extraPoints.push([fb.center[0] - 14, fb.center[1] - 2, fb.center[2] - 14], [fb.center[0] + 14, fb.center[1] + 4, fb.center[2] + 14]);
  },

  // ── крок фізики: прискорювачі + БЛИСКАВКИ ЗЕВСА (детерміновано від st.raceT і порядку кульок) ──
  step(st, dt) {
    const X = st.track.extra.zeus, A = X.arena;
    // прискорювачі: кулька над смугою розганяється вздовж неї до vt
    for (const z of X.boosts) {
      for (const b of st.active) {
        const dx = b.x - z.a[0], dy = b.y - z.a[1], dz = b.z - z.a[2];
        const s = dx * z.t[0] + dy * z.t[1] + dz * z.t[2];
        if (s < 0 || s > z.L) continue;
        const lat = dx * z.n[0] + dy * z.n[1] + dz * z.n[2];
        if (Math.abs(lat) > z.w / 2) continue;
        const h = dy - z.t[1] * s; if (h < -0.6 || h > 1.8) continue;
        const vt = b.vx * z.t[0] + b.vy * z.t[1] + b.vz * z.t[2];
        if (vt >= z.vt) continue;
        const a = Math.min(30 * dt, z.vt - vt);
        b.vx += z.t[0] * a; b.vy += z.t[1] * a; b.vz += z.t[2] * a;
        b.body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
        b.boostT = st.raceT;
      }
    }
    const yAt = x => A.y0 - A.k * (x - A.ax0);
    const Z = st.zeus || (st.zeus = { next: 0, strikes: [], n: 0, kills: 0, max: Math.floor(st.balls.length * ZB.killShare), log: [] });
    // удари стрімера: кулька з черги вибуває одразу, блискавка летить із «руки» біля камери
    if (st.zeusManual && st.zeusManual.length) {
      for (const q of st.zeusManual.splice(0)) {
        const b = q.nick != null ? st.active.find(x => x.nick === q.nick) : null;
        let killed = 0, p = q.miss;
        if (b && st.active.length + st.finishOrder.length > 1) { p = [b.x, b.y, b.z]; b.zeusT = st.raceT; b.zeusBy = 'streamer'; mbEliminate(st, b); killed = 1; }
        else if (b) p = [b.x, b.y, b.z];
        Z.strikes.push({ p, t0: st.raceT - ZB.warn, tHit: st.raceT, r: 0.9, done: true, killed, n: Z.n++, from: q.from, manual: true, nick: killed ? b.nick : null });
      }
    }
    for (let i = 0; i < Z.strikes.length; i++) {
      const s = Z.strikes[i];
      if (s.done || st.raceT < s.tHit) continue;
      s.done = true; s.killed = 0;
      const cand = st.active.slice();
      for (const b of cand) {
        if (Z.kills >= Z.max || st.active.length + st.finishOrder.length <= 1) break;
        const dx = b.x - s.p[0], dz = b.z - s.p[2], dy = b.y - s.p[1];
        if (dx * dx + dz * dz < s.r * s.r && dy > -1 && dy < 3.5) { b.zeusT = st.raceT; mbEliminate(st, b); Z.kills++; s.killed++; }
      }
      if (Z.log.length < 80) Z.log.push([Math.round(s.tHit * 10) / 10, s.killed]);
    }
    if (Z.strikes.length > 12) Z.strikes = Z.strikes.filter(s => st.raceT - s.tHit < 4);
    // сам Зевс більше не б'є — блискавки кидає лише стрімер «за Зевса» (клавіша 1 → рука, ЛКМ — удар)
  },

  intro(track, pos, look) {
    const H = track.tray.hinge;
    pos.set(H[0] + 26, H[1] + 16, H[2] + 34);
    look.set(H[0] - 10, H[1] + 2, H[2]);
  },

  // спецплани: двері храму на старті, колонада із Зевсом, трамплін збоку, фінішна арка
  camera(st, leader, pos, look) {
    const track = st.track, X = track.extra.zeus, s = leader.prog;
    if (!X.sIdx) { X.sIdx = {}; for (const g of track.stages) X.sIdx[g.id] = g; }
    const S = X.sIdx, A = X.arena, H = track.tray.hinge;
    if (s < S.ramp.s0 + 6) { pos.set(H[0] + 22, H[1] + 10, H[2] + 22); look.set(H[0] - 4, H[1], H[2]); return true; }
    if (S.bridge && s >= S.bridge.s0 + 6 && s < S.bridge.s1 - 4) {
      const y = A.y0 - A.k * (leader.x - A.ax0);
      pos.set(leader.x - 18, y + 12, 24); look.set(leader.x + 10, y + 9, -14); return true;
    }
    if (S.kick && s >= S.kick.s0 - 3 && s < S.land.s0 + 10) { const r = X.rings[0]; if (r) { pos.set(r.c[0] + 3, r.c[1] + 4, r.c[2] - 22); look.set(r.c[0] - 2, r.c[1] - 2, r.c[2]); return true; } }
    if (S.plaza && s >= S.plaza.s0 - 6) { const p = X.plazaC; pos.set(p[0] + 16, p[1] + 9, p[2] + 10); look.set(X.finishP[0] - 6, X.finishP[1], X.finishP[2]); return true; }
    return false;
  },

  // показ: модель з Blender + нічне небо; млини малюємо тут (їх обертає ядро)
  decor(track, ctx) {
    const { THREE, scene } = ctx, X = track.extra.zeus;
    const V = X.view = { nodes: {}, syms: [], flames: [], ready: false };
    const holder = new THREE.Group(); scene.add(holder);
    // фактури (згенеровані в Blender, безшовні) — трипланарно, бо в моделі немає UV
    const T = n => ctx.loadTex('/assets/models/textures/' + n + '.jpg');
    const TEXMAP = [
      [/^Z_Marble$/, 'marble_gold', 1 / 7, 1], [/^Z_Column$/, 'marble_white', 1 / 6, 1], [/^Z_Arena$/, 'stone_tiles', 1 / 5, 1],
      [/^Z_Stone$/, 'stone_tiles', 1 / 7, 0.9], [/^Z_Lane/, 'marble_light', 1 / 7, 1],
    ];
    const texOf = m => {
      if (!m || !ctx.triplanar || m.userData.tp) return;
      for (const [re, n, sc, mix] of TEXMAP) if (re.test(m.name)) {
        ctx.triplanar(m, T(n), { scale: sc, mix, key: n });
        // світлі поверхні під сонцем «вигоряли» в чисто білий — фактура не читалась
        if (/marble|stone/.test(n)) { m.color.multiplyScalar(0.88); m.envMapIntensity = Math.min(m.envMapIntensity, 0.35); m.roughness = Math.max(m.roughness, 0.45); }
        return;
      }
    };
    const put = sc => {
      const root = sc.clone(true);
      root.traverse(o => {
        if (/^SYM_/.test(o.name) && !(o.parent && /^SYM_/.test(o.parent.name))) V.syms.push({ o, p: o.position.clone(), q: o.quaternion.clone(), ph: V.syms.length * 1.7 });
        if (/^FLAME_\d+$/.test(o.name)) V.flames.push({ o, s: o.scale.clone(), ph: V.flames.length * 2.3 });
        if (/^(ZEUS_|DOOR_)/.test(o.name)) V.nodes[o.name] = o;
        if (!o.isMesh) return;
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        const m = o.material, n = (m && m.name) || '';
        if (m && m.isMeshStandardMaterial) {
          if (/^D_/.test(n)) { m.flatShading = true; m.envMapIntensity = 0.2; m.needsUpdate = true; }
          else { m.envMap = ctx.env; m.envMapIntensity = 0.6; if (m.roughness > 0.6) m.roughness = 0.6; }
          if (/Gold/i.test(n)) { m.envMap = ctx.env; m.envMapIntensity = 1.1; m.metalness = 0.85; m.roughness = 0.28; }
          if (/Glow|Flame|Bolt|Eye/i.test(n)) { m.emissive.copy(m.color); m.emissiveIntensity = 1.6; m.toneMapped = false; }
          if (/Flame/i.test(n)) { m.transparent = true; m.opacity = 0.85; m.depthWrite = false; }
          if (/Cloud/i.test(n)) m.emissive.set('#8fa3d8').multiplyScalar(0.3);
          if (/Gem/i.test(n)) { m.envMap = ctx.env; m.envMapIntensity = 1.4; m.roughness = 0.12; m.metalness = 0.1; m.emissive.copy(m.color).multiplyScalar(0.35); }
        }
        texOf(m);
        const fxm = /Cloud|Flame|Glow|Bolt/i.test(n);
        o.castShadow = !fxm; o.receiveShadow = !fxm;
      });
      if (window.mbDepthLayers) mbDepthLayers(root);   // без мерехтіння на стиках і там, де декор у площині траси
      holder.add(root);
      const tip = V.nodes.ZEUS_tip; if (tip) tip.visible = false;
      const arm = V.nodes.ZEUS_arm; if (arm) V.armQ = arm.quaternion.clone();
      for (const d of ['DOOR_L', 'DOOR_R']) if (V.nodes[d]) V.nodes[d].userData.q0 = V.nodes[d].quaternion.clone();
      V.ready = true;
    };
    if (GLB_SCENE) put(GLB_SCENE);
    else {
      if (!GLB_PROM) GLB_PROM = new Promise((ok, no) => new THREE.GLTFLoader().load(GLB_URL, g => { GLB_SCENE = g.scene; ok(g.scene); }, undefined, no));
      GLB_PROM.then(put).catch(e => console.warn('[marbles] модель «Зевсятины» не загрузилась', e));
    }
    const gold = new THREE.MeshStandardMaterial({ color: '#e0aa2a', roughness: 0.28, metalness: 0.85, envMap: ctx.env, envMapIntensity: 1.1 });
    // лоток
    if (ctx.trayGroup) {
      const tr = track.tray, mat = new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.35, envMap: ctx.env, envMapIntensity: 0.5 });
      if (ctx.triplanar) ctx.triplanar(mat, T('marble_gold'), { scale: 1 / 7, key: 'tray' });
      const floor = new THREE.Mesh(new THREE.BoxGeometry(tr.L, 0.5, tr.W), mat); floor.position.set(-tr.L / 2, -0.25, 0); floor.receiveShadow = floor.castShadow = true; ctx.trayGroup.add(floor);
      for (const [px, pz, sx, sz] of [[-tr.L / 2, tr.W / 2 + 0.3, tr.L, 0.6], [-tr.L / 2, -tr.W / 2 - 0.3, tr.L, 0.6], [-tr.L - 0.3, 0, 0.6, tr.W + 1.2]]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.5, sz), gold); w.position.set(px, 0.5, pz); w.castShadow = true; ctx.trayGroup.add(w);
      }
      const st = new THREE.Mesh(new THREE.PlaneGeometry(tr.W - 1.2, 2.2), ctx.mats.start); st.rotation.set(-Math.PI / 2, 0, Math.PI / 2); st.position.set(-1.8, 0.02, 0); ctx.trayGroup.add(st);
    }
    // носи брам
    for (const b of (X.noses ? X.noses.boxes : [])) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2), gold); m.position.set(...b.pos); m.quaternion.set(...b.quat); scene.add(m);
    }
    // молоти: руків'я + золота голова з червоною вставкою (хитає ядро — swing)
    const red = new THREE.MeshStandardMaterial({ color: '#b3202e', roughness: 0.4, metalness: 0.2 });
    for (const sp of (X.hammers || [])) {
      const grp = ctx.spinners[sp.id]; if (!grp) continue;
      const [arm, head] = sp.boxes;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, arm.size[1] * 2, 10), gold); rod.position.set(...arm.pos); rod.castShadow = true; grp.add(rod);
      const hd = new THREE.Mesh(new THREE.BoxGeometry(head.size[0] * 2, head.size[1] * 2, head.size[2] * 2), gold); hd.position.set(...head.pos); hd.castShadow = hd.receiveShadow = true; grp.add(hd);
      const band = new THREE.Mesh(new THREE.BoxGeometry(head.size[0] * 2 + 0.06, head.size[1] * 0.9, head.size[2] * 2 - 0.3), red); band.position.set(...head.pos); grp.add(band);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.2, 14), gold); pin.rotation.x = Math.PI / 2; pin.position.set(0, 0, arm.pos[2]); grp.add(pin);
      // портал-перекладина над жолобом, на якій висить молот
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 11), gold); beam.position.set(sp.c[0], sp.c[1] + 0.3, sp.c[2]); scene.add(beam);
      for (const sz of [-5.3, 5.3]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 7.6, 10), gold); post.position.set(sp.c[0], sp.c[1] - 3.5, sp.c[2] + sz); post.castShadow = true; scene.add(post); }
    }
    // шестерня: золотий диск із зубцями і фіолетовим кристалом
    const gemMat = new THREE.MeshStandardMaterial({ color: '#a24dff', emissive: '#6a1fd0', emissiveIntensity: 0.8, roughness: 0.15 });
    for (const sp of (X.gears || [])) {
      const grp = ctx.spinners[sp.id]; if (!grp) continue;
      for (const b of sp.boxes) { const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2), gold); m.position.set(...b.pos); m.quaternion.set(...b.quat); m.castShadow = true; grp.add(m); }
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 1.3, 24), gold); disc.position.y = 0.65; grp.add(disc);
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), gemMat); gem.position.y = 1.8; grp.add(gem);
    }
    // смуги прискорювачів: світні шеврони, що «біжать» уперед
    {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d');
      g.fillStyle = 'rgba(40,140,255,0.25)'; g.fillRect(0, 0, 64, 64);
      g.strokeStyle = '#bff3ff'; g.lineWidth = 9; g.lineCap = 'round';
      g.beginPath(); g.moveTo(14, 6); g.lineTo(46, 32); g.lineTo(14, 58); g.stroke();
      const tex = new THREE.CanvasTexture(c); tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
      V.boostMeshes = [];
      for (const z of (X.boosts || [])) {
        const t2 = tex.clone(); t2.needsUpdate = true; t2.repeat.set(z.L / 2.2, 1);
        // площина: вісь X — уздовж смуги (t), Y — поперек (n), нормаль — угору
        const xa = new THREE.Vector3(...z.t), ya = new THREE.Vector3(...z.n), na = new THREE.Vector3().crossVectors(xa, ya).normalize();
        if (na.y < 0) { na.negate(); ya.negate(); }
        const m = new THREE.Mesh(new THREE.PlaneGeometry(z.L, z.w), new THREE.MeshBasicMaterial({ map: t2, transparent: true, depthWrite: false, toneMapped: false, color: '#8fdcff', side: THREE.DoubleSide }));
        m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xa, ya, na));
        m.position.set((z.a[0] + z.b[0]) / 2 + na.x * 0.06, (z.a[1] + z.b[1]) / 2 + na.y * 0.06, (z.a[2] + z.b[2]) / 2 + na.z * 0.06);
        V.boostMeshes.push(t2); scene.add(m);
      }
    }
    // ── грозове небо: далекі розряди в хмарах (лише показ) ──
    V.storm = { next: performance.now() / 1000 + 2, bolts: [] };
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: '#f4f6ff', transparent: true, opacity: 0.9, toneMapped: false, fog: false, side: THREE.DoubleSide, depthWrite: false }));
      m.visible = false; m.frustumCulled = false; scene.add(m); V.storm.bolts.push(m);
    }
    V.storm.light = new THREE.HemisphereLight('#dfe8ff', '#404a66', 0); scene.add(V.storm.light);
    // ── пули ефектів блискавки: кола-попередження, сліди, 3 блискавки, спалах ──
    const fx = V.fx = { rings: [], bolts: [], scorch: [] };
    const ringGeo = new THREE.RingGeometry(0.75, 1.0, 40); ringGeo.rotateX(-Math.PI / 2);
    const scorchGeo = new THREE.CircleGeometry(1, 24); scorchGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffd84a', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      m.visible = false; scene.add(m); fx.rings.push(m);
      const s = new THREE.Mesh(scorchGeo, new THREE.MeshBasicMaterial({ color: '#1a1420', transparent: true, opacity: 0, depthWrite: false }));
      s.visible = false; scene.add(s); fx.scorch.push(s);
    }
    for (let i = 0; i < 3; i++) {
      const core = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: '#fffbe8', toneMapped: false, fog: false, side: THREE.DoubleSide }));
      const glow = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false, side: THREE.DoubleSide }));
      core.visible = glow.visible = false; core.frustumCulled = glow.frustumCulled = false; scene.add(core); scene.add(glow);
      fx.bolts.push({ core, glow, n: -1 });
    }
    fx.light = new THREE.PointLight('#ffe9a8', 0, 90, 1.6); scene.add(fx.light);
    // звуки (згенеровано в ElevenLabs): удар блискавки на кожен удар, сміх — коли когось вибило
    V.snd = {};
    for (const n of ['zeus-bolt', 'zeus-laugh']) { const a = new Audio('/assets/sfx/' + n + '.mp3'); a.preload = 'auto'; V.snd[n] = a; }
    V.lastHitN = -1; V.laughT = -99;
  },

  // покадрово: сяйво, символи, вогні, рука Зевса, кола-попередження, блискавки
  frame(st, ctx) {
    const X = st.track.extra.zeus, V = X.view; if (!V) return;
    const THREE = ctx.THREE, T = performance.now() / 1000;
    zpFrame(V, st, ctx);
    // двері храму відчиняються, щойно лоток почав нахилятись
    const open = st.raceOn || st.tilting ? 1 : 0;
    V.doorK = (V.doorK || 0) + (open - (V.doorK || 0)) * Math.min(1, (ctx.dt || 0.016) * 2.5);
    for (const [d, sg] of [['DOOR_L', 1], ['DOOR_R', -1]]) { const n = V.nodes[d]; if (n && n.userData.q0) { n.quaternion.copy(n.userData.q0); n.rotateY(sg * 1.75 * V.doorK); } }
    for (const t2 of (V.boostMeshes || [])) t2.offset.x = -T * 1.6;
    // гроза: раз на кілька секунд — далекий розряд і спалах неба
    if (V.storm) {
      const S = V.storm;
      if (T > S.next) {
        S.next = T + 3 + Math.random() * 6; S.t0 = T;
        const m = S.bolts[(S.k = (S.k || 0) + 1) % S.bolts.length];
        const a = Math.random() * Math.PI * 2, R = 420 + Math.random() * 300;
        stormBolt(THREE, m, 80 + Math.cos(a) * R, 160 + Math.random() * 80, Math.sin(a) * R, -60);
        if (S.cur && S.cur !== m) S.cur.visible = false;
        S.cur = m;
      }
      const age = T - (S.t0 || -9), on = age < 0.09 || (age > 0.15 && age < 0.26);
      if (S.cur) S.cur.visible = on;
      S.light.intensity = on ? 0.3 : 0;
    }
    for (const s of V.syms) {
      s.o.position.set(s.p.x, s.p.y + Math.sin(T * 0.9 + s.ph) * 1.6, s.p.z);
      s.o.quaternion.copy(s.q); s.o.rotateY(T * 0.6 + s.ph);
    }
    for (const f of V.flames) { const k = 1 + 0.12 * Math.sin(T * 9 + f.ph) + 0.07 * Math.sin(T * 23 + f.ph * 3); f.o.scale.set(f.s.x * (2 - k), f.s.y * k, f.s.z * (2 - k)); }
    const Z = st.zeus, fx = V.fx; if (!fx) return;
    // рука: піднімається, поки Зевс «цілиться», і різко опускається в момент удару
    let raise = 0;
    if (Z) for (const s of Z.strikes) {
      if (!s.done) raise = Math.max(raise, clamp((st.raceT - s.t0) / ZB.warn, 0, 1));
      else raise = Math.max(raise, 1 - clamp((st.raceT - s.tHit) / 0.35, 0, 1));
    }
    const arm = V.nodes.ZEUS_arm;
    if (arm && V.armQ) {
      V.armRaise = (V.armRaise || 0) + (raise - (V.armRaise || 0)) * Math.min(1, (ctx.dt || 0.016) * 10);
      arm.quaternion.copy(V.armQ); arm.rotateX(-0.75 * V.armRaise);
    }
    for (const r of fx.rings) r.visible = false;
    for (const b of fx.bolts) b.core.visible = b.glow.visible = false;
    // звук удару — один раз на блискавку; сміх не частіше ніж раз на 6 с
    if (Z && V.snd) for (const s of Z.strikes) {
      if (!s.done || s.n <= V.lastHitN || st.raceT - s.tHit > 0.5) continue;
      V.lastHitN = s.n;
      zSfx(V.snd['zeus-bolt'], 0.75);
      if (s.killed > 0 && T - V.laughT > 6) { V.laughT = T; setTimeout(() => zSfx(V.snd['zeus-laugh'], 0.85), 450); }
    }
    let ri = 0, bi = 0, light = 0;
    if (Z) for (const s of Z.strikes) {
      if (!s.done && ri < fx.rings.length) {
        const k = clamp((st.raceT - s.t0) / ZB.warn, 0, 1), m = fx.rings[ri++];
        m.visible = true; m.position.set(s.p[0], s.p[1] + 0.06, s.p[2]);
        const sc = s.r * (1.6 - 0.6 * k); m.scale.set(sc, 1, sc);
        m.material.opacity = 0.35 + 0.55 * k * (0.6 + 0.4 * Math.sin(T * 30));
      }
      if (!s.done) continue;
      const age = st.raceT - s.tHit;
      if (age < 0.42 && bi < fx.bolts.length) {
        const B = fx.bolts[bi++];
        if (B.n !== s.n) { B.n = s.n; boltGeo(THREE, B, X, V, s); }
        const on = age < 0.12 || (age > 0.18 && age < 0.3);
        B.core.visible = B.glow.visible = on;
        light = Math.max(light, on ? 1 : 0.3);
        B.glow.material.opacity = 0.5 * (1 - age / 0.42);
        fx.light.position.set(s.p[0], s.p[1] + 6, s.p[2]);
      }
      const sm = fx.scorch[s.n % fx.scorch.length];
      if (age < 3) { sm.visible = true; sm.userData.n = s.n; sm.position.set(s.p[0], s.p[1] + 0.04, s.p[2]); sm.scale.setScalar(s.r * 0.9); sm.material.opacity = 0.55 * (1 - age / 3); }
      else if (sm.userData.n === s.n) sm.visible = false;
    }
    fx.light.intensity = light * 260;
  },
};

// ── «Рука Зевса» стрімера ──────────────────────────────────────
// DOM-шар над канвою: блискавка в правому нижньому куті, приціл, лічильник зарядів, підпис удару.
// піксельний арт: рядки-карти → SVG з квадратів (crispEdges). Рука в рукаві хітона + блискавка в кулаці
const ZP_PAL = { D: '#6b3d00', W: '#fffbe6', Y: '#ffd447', O: '#ff9f1c', S: '#e9b48a', s: '#c98d62', k: '#a8714c', L: '#f6dcc2', C: '#f4f1ea', c: '#d9d3c6', G: '#e7b12c', g: '#b9831a' };
const ZP_BOLT = [
  '..DDDDD.......',
  '..DYYWWD......',
  '...DYYWWD.....',
  '....DYYWWD....',
  '.....DYYWWD...',
  '..DDDDYYYWWD..',
  '..DOOYYYWWWWD.',
  '...DOOYWWDDDD.',
  '....DOYWWD....',
  '.....DOYWWD...',
  '......DOYWD...',
  '.......DOYWD..',
  '........DOWD..',
  '.........DOYD.',
  '..........DOD.',
  '...........DD.',
];
const ZP_ARM = [
  'kssssssk', 'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk',
  'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk', 'sLSSSSsk',
  'GGGGGGGg', 'gGGGGGgg', 'cCCCCCcc', 'cCCCCCcc', 'cCCCCCcc', 'cCCCCCcc', 'cCCCCCcc', 'cCCCCCcc', 'cCCCCCcc', 'cCCCCCcc',
];
function zpPix(map, px, ox, oy, cls) {
  let r = '';
  map.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const c = ZP_PAL[row[x]]; if (c) r += '<rect x="' + (ox + x * px) + '" y="' + (oy + y * px) + '" width="' + (px + 0.3) + '" height="' + (px + 0.3) + '" fill="' + c + '"/>'; } });
  return '<g class="' + cls + '">' + r + '</g>';
}
function zpHandSvg() {
  // рука вертикально, кулак угорі; блискавка — над кулаком, тримається за нижній кінець
  const P = 7, armX = 70, armY = 96;
  return '<svg viewBox="0 0 190 270" shape-rendering="crispEdges">' +
    '<defs><filter id="zpGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
    zpPix(ZP_BOLT, P, 6, 0, 'zp-boltpx') +
    zpPix(ZP_ARM, P, armX, armY, 'zp-armpx') +
    '</svg>';
}
function zpDom(V) {
  if (V.zp && V.zp.root && V.zp.root.isConnected) return V.zp;
  const ov = document.getElementById('marbles-overlay'), cv = document.getElementById('mb-canvas');
  if (!ov || !cv) return null;
  const root = document.createElement('div'); root.className = 'zp-root';
  root.innerHTML =
    '<div class="zp-cross"></div>' +
    '<div class="zp-hand"><div class="zp-bob"><div class="zp-swing">' + zpHandSvg() + '</div></div></div>' +
    '<div class="zp-flash"></div><div class="zp-feed"></div>' +
    '<div class="zp-bar"><div class="zp-slot"><span class="zp-key">1</span>' +
      '<svg viewBox="0 0 98 112" shape-rendering="crispEdges">' + zpPix(ZP_BOLT, 7, 0, 0, '') + '</svg></div>' +
      '<div class="zp-tip"></div></div>';
  ov.appendChild(root);
  const zp = V.zp = { root, cross: root.querySelector('.zp-cross'), hand: root.querySelector('.zp-hand'), swing: root.querySelector('.zp-swing'),
    flash: root.querySelector('.zp-flash'), feed: root.querySelector('.zp-feed'), tip: root.querySelector('.zp-tip'), cdUntil: 0, mx: -1, my: -1, raceId: null, lastFeedN: -1 };
  const active = () => V.zpOn && performance.now() - (V.zpSeen || 0) < 300;
  // сторож: кадри карти Зевса не йдуть (інша карта / закрили) — ховаємо руку й повертаємо курсор
  setInterval(() => { if (!active()) { root.classList.remove('zp-on'); cv.classList.remove('zp-nocursor'); } }, 250);
  cv.addEventListener('mousemove', e => { zp.mx = e.clientX; zp.my = e.clientY; });
  cv.addEventListener('mouseleave', () => { zp.mx = -1; });
  cv.addEventListener('mousedown', e => {
    if (e.button !== 0 || !active() || !V.zpArmed) return;
    const locked = document.pointerLockElement === cv;
    const G = window.mbGfx && window.mbGfx(), fly = !!(G && G.fly && G.fly.on);
    if (fly && !locked) return;                 // перший клік у польоті — захоплення миші, не постріл
    zpShoot(V, locked ? null : e);
  });
  // клавіша 1 — дістати / сховати руку Зевса (як слот 1 у хотбарі)
  document.addEventListener('keydown', e => {
    if (e.repeat || !(e.code === 'Digit1' || e.code === 'Numpad1' || e.key === '1') || !active()) return;
    // поле вводу на сторінці під оверлеєм (слово реєстрації тощо) не має «з'їдати» клавішу — знімаємо з нього фокус
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { if (ov.contains(ae)) return; ae.blur(); }
    e.preventDefault();
    V.zpArmed = !V.zpArmed;
    if (V.zpArmed) { zp.swing.classList.remove('zp-kick'); zp.hand.classList.remove('zp-equip'); void zp.hand.offsetWidth; zp.hand.classList.add('zp-equip'); }
  });
  return zp;
}
function zpFrame(V, st, ctx) {
  V.cam = ctx.camera; V.st = st; V.THREE = ctx.THREE;
  const on = !!(st.raceOn && !st.done);
  V.zpOn = on; V.zpSeen = performance.now();
  const zp = zpDom(V); if (!zp) return;
  if (zp.raceId !== st) { zp.raceId = st; zp.cdUntil = 0; zp.lastFeedN = -1; zp.feed.innerHTML = ''; V.zpArmed = false; }
  const armed = on && !!V.zpArmed;
  const cv = document.getElementById('mb-canvas'), locked = document.pointerLockElement === cv;
  zp.root.classList.toggle('zp-on', on);
  zp.root.classList.toggle('zp-armed', armed);
  zp.root.classList.toggle('zp-cool', performance.now() < zp.cdUntil);
  cv.classList.toggle('zp-nocursor', armed && !locked && zp.mx >= 0);
  const tip = armed ? 'ЛКМ — молния · 1 — убрать' : 'Рука Зевса';
  if (zp.tip.textContent !== tip) zp.tip.textContent = tip;
  // приціл: у польоті (миша захоплена) — по центру, інакше — за курсором
  if (!armed) zp.cross.style.display = 'none';
  else if (locked) { zp.cross.style.left = '50%'; zp.cross.style.top = '50%'; zp.cross.style.display = ''; }
  else if (zp.mx >= 0) { const r = cv.getBoundingClientRect(); zp.cross.style.left = (zp.mx - r.left) + 'px'; zp.cross.style.top = (zp.my - r.top) + 'px'; zp.cross.style.display = ''; }
  else zp.cross.style.display = 'none';
  // підпис промаху — один раз на ручну блискавку (влучання показує спільний кіл-фід)
  const Z = st.zeus;
  if (Z) for (const s of Z.strikes) {
    if (!s.manual || s.n <= zp.lastFeedN) continue;
    zp.lastFeedN = s.n;
    if (s.nick) continue;
    const el = document.createElement('div'); el.className = 'zp-msg';
    el.textContent = '⚡ Мимо!';
    zp.feed.appendChild(el); setTimeout(() => el.remove(), 2200);
  }
}
function zpShoot(V, e) {
  const zp = V.zp, st = V.st, cam = V.cam, THREE = V.THREE; if (!zp || !st || !cam) return;
  const now = performance.now();
  if (now < zp.cdUntil) return;
  const cv = document.getElementById('mb-canvas'), r = cv.getBoundingClientRect();
  const nx = e ? ((e.clientX - r.left) / r.width) * 2 - 1 : 0, ny = e ? -((e.clientY - r.top) / r.height) * 2 + 1 : 0;
  const ray = new THREE.Raycaster(); ray.setFromCamera({ x: nx, y: ny }, cam);
  const o = ray.ray.origin, d = ray.ray.direction;
  // найближча до променя кулька в межах pickR (при рівних — ближча до камери)
  let best = null, bestScore = 1e9;
  for (const b of st.active) {
    const vx = b.x - o.x, vy = b.y - o.y, vz = b.z - o.z, t = vx * d.x + vy * d.y + vz * d.z;
    if (t <= 0) continue;
    const px = vx - d.x * t, py = vy - d.y * t, pz = vz - d.z * t, dist = Math.sqrt(px * px + py * py + pz * pz);
    if (dist > ZP.pickR + t * 0.004) continue;   // далі — трохи більший допуск
    const score = dist + t * 0.002;
    if (score < bestScore) { bestScore = score; best = b; }
  }
  // рука — трохи праворуч і нижче камери, звідти й летить блискавка
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  const from = cam.position.clone().addScaledVector(d, 2.2).addScaledVector(right, 1.1).addScaledVector(up, -0.9);
  const miss = o.clone().addScaledVector(d, 40);
  (st.zeusManual || (st.zeusManual = [])).push({ nick: best ? best.nick : null, from: [from.x, from.y, from.z], miss: [miss.x, miss.y, miss.z] });
  zp.cdUntil = now + ZP.cd * 1000;
  // замах рукою, як удар у Minecraft
  zp.swing.classList.remove('zp-kick'); void zp.swing.offsetWidth; zp.swing.classList.add('zp-kick');
  zp.flash.classList.remove('zp-fl'); void zp.flash.offsetWidth; zp.flash.classList.add('zp-fl');
}

// далекий розряд у хмарах: зигзаг-стрічка зверху вниз
function stormBolt(THREE, m, x, y0, z, y1) {
  const pts = []; let px = x, pz = z;
  for (let i = 0; i <= 14; i++) { const t = i / 14; pts.push([px, y0 + (y1 - y0) * t, pz]); px += (Math.random() - 0.5) * 22; pz += (Math.random() - 0.5) * 22; }
  const pos = [], idx = [], w = 2.2, L = Math.hypot(x, z) || 1, sx = -z / L, sz = x / L;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    pos.push(p[0] + sx * w, p[1], p[2] + sz * w, p[0] - sx * w, p[1], p[2] - sz * w);
    if (i) { const o = (i - 1) * 2; idx.push(o, o + 1, o + 3, o, o + 3, o + 2); }
  }
  m.geometry.dispose(); const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); m.geometry = g;
}
function zSfx(base, vol) {
  if (!base) return;
  const a = base.cloneNode(); a.volume = vol; a.play().catch(() => {}); // автоплей могли заблокувати — не падаємо
}
// зигзаг блискавки від вістря в руці Зевса до точки удару (дві стрічки-хрестовини: ядро і сяйво)
function boltGeo(THREE, B, X, V, s) {
  const tip = new THREE.Vector3();
  if (s.from) tip.set(s.from[0], s.from[1], s.from[2]);
  else if (V.nodes.ZEUS_tip) V.nodes.ZEUS_tip.getWorldPosition(tip); else tip.set(X.zeus.hand[0], X.zeus.hand[1], X.zeus.hand[2]);
  const end = new THREE.Vector3(s.p[0], s.p[1], s.p[2]);
  const r = rng(s.n * 131 + 17), pts = [], N = 22;
  const dir = end.clone().sub(tip), L = dir.length(); dir.normalize();
  const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize(), up = dir.clone().cross(side).normalize();
  for (let i = 0; i <= N; i++) {
    const t = i / N, amp = Math.sin(Math.PI * t) * L * 0.06;
    const p = tip.clone().addScaledVector(dir, L * t).addScaledVector(side, (r() - 0.5) * 2 * amp).addScaledVector(up, (r() - 0.5) * 2 * amp);
    pts.push(i === N ? end.clone() : p);
  }
  const mk = w => {
    const pos = [], idx = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const t = b.clone().sub(a).normalize(), n1 = side.clone().cross(t).normalize().multiplyScalar(w), n2 = side.clone().multiplyScalar(w), p = pts[i];
      pos.push(p.x + n1.x, p.y + n1.y, p.z + n1.z, p.x - n1.x, p.y - n1.y, p.z - n1.z, p.x + n2.x, p.y + n2.y, p.z + n2.z, p.x - n2.x, p.y - n2.y, p.z - n2.z);
      if (i) { const o = (i - 1) * 4; idx.push(o, o + 1, o + 5, o, o + 5, o + 4, o + 2, o + 3, o + 7, o + 2, o + 7, o + 6); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); return g;
  };
  B.core.geometry.dispose(); B.core.geometry = mk(0.35);
  B.glow.geometry.dispose(); B.glow.geometry = mk(1.6);
}
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
