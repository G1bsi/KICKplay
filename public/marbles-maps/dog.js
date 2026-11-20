// ─────────────────────────────────────────────────────────────
//  🐶 Карта «Собачий двор» — ТРАСА ЗМОДЕЛЬОВАНА В BLENDER (blender/marbles_dog.blend).
//  Мультяшне передмістя: будка-старт → спуск по колу навколо бляшанки корму → слалом
//  між гідрантами → ПОЛЯНА (з неба падають будки й давлять кульки) → кістки, що крутяться →
//  садовий шланг із трампліном → розвилка (будка-тунель / тенісні м'ячі) → гірка → миска-фініш.
//  Фізика — dog_phys.json, показ — dog.glb; будки — map.step (детерміновано), показ — map.frame.
// ─────────────────────────────────────────────────────────────
(function () {
const PHYS_URL = '/assets/models/marbles/dog_phys.json';
const GLB_URL = '/assets/models/marbles/dog.glb?v=20261119';   // ?v= — змінюй після переекспорту моделі (сервер кешує .glb на 7 днів)
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
  if (!DATA) throw new Error('Собачий двор: дані траси ще не завантажені');
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
// будки, що падають на поляну: попередження (тінь росте), скільки стоїть перешкодою, пауза, частка поля,
// lead — ціль серед передніх (будки «полюють» на лідерів — задні мають шанс), HW — півширина основи
const KB = { warn: 1.15, stay: 3.0, gapMin: 1.6, gapRnd: 1.1, killShare: 0.25, lead: 0.4, HW: 2.15, pool: 4 };
const PARK = [-40, -46, 16]; // схованка для будок поза грою (під будкою-стартом, усередині bbox)

const MAP = {
  id: 'dog',
  name: 'Собачий двор',
  icon: '🐶',
  approxSec: 90,
  allSec: 140,
  desc: 'Старт из огромной будки, спуск по кругу вокруг банки корма, слалом между гидрантами, поляна, куда с неба падают будки и давят шарики, крутящиеся кости, садовый шланг с трамплином, развилка через будку-туннель и финиш в миске.',
  eliminate: false,
  customRender: true,
  theme: { sky: { hor: '#c4e9ff', zen: '#3f97ea' }, fog: '#cdeaff', fogDensity: 0.0009, clear: '#cdeaff', cloudFloor: '#9fd07a', cloudTint: '#ffffff', hemi: ['#ffffff', '#7fae6a', 0.9], sun: ['#fff3dc', 1.2] },

  preload() {
    if (DATA) return Promise.resolve();
    return fetch(PHYS_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => { DATA = j; });
  },

  build(B) {
    const D = data(), meta = D.meta || {};
    const X = B.extra.dog = {};
    const aux = (g, st) => { B.segments.push(g); g.stage = st; g.stageIdx = B.stages.length - 1; g.noProgress = true; return g; };
    const sweep = s => {
      const center = s.center;
      return { id: s.id, kind: 'sweep', mesh: meshOf(s.v, s.i), center, length: polyLen(center),
        start: center[0].slice(), end: center[center.length - 1].slice(), branch: s.branch || 0 };
    };
    // ── лоток у будці-старті ──
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
    for (const e of D.extra) if (/^X_/.test(e.id)) aux({ id: e.id, kind: 'sweep', mesh: meshOf(e.v, e.i) }, 'tray');
    const groups = [];
    for (const s of D.segs) {
      let g = groups.find(q => q.stage === s.stage);
      if (!g) groups.push(g = { stage: s.stage, segs: [] });
      g.segs.push(sweep(s));
    }
    const TOL = { chute: 9, can: 5, slalom: 6.5, lawn: 11, bones: 6.5, hose: 5, kick: 10, land: 10, split: 5, slide: 7 };
    for (const g of groups) B.addStage(g.stage, g.segs, () => TOL[g.stage] || 6);
    // ── кістки, що крутяться (вісь вертикальна): стрижень + кулясті «маслаки» ──
    X.bones = (meta.bones || []).map((b, i) => {
      const c = BE(b.c), h = b.half;
      return aux({ id: 'bone' + i, kind: 'spinner', c, axis: [0, 1, 0], omega: b.omega, phase: i * 0.8,
        boxes: [{ pos: [0, 0.8, 0], quat: [0, 0, 0, 1], size: [h, 0.38, 0.38] }],
        balls: [[h, 0.45], [h, -0.45], [-h, 0.45], [-h, -0.45]].map(([x, z]) => ({ pos: [x, 0.8, z], r: 0.62 })),
        friction: 0.2, restitution: 0.5, half: h }, 'bones');
    });
    // ── тенісні м'ячі — пружні відбійники ──
    X.tennis = aux({ id: 'tennis', kind: 'boxes', boxes: [], balls: (meta.balls || []).map(([p, r]) => ({ pos: BE(p), r })) }, 'lawn');
    const noses = (meta.noses || []).map(n => B.box(BE(n), Math.PI / 4, [0.55, 0.9, 0.55], 'wedge'));
    if (noses.length) X.noses = aux({ id: 'splitNose', kind: 'boxes', boxes: noses, balls: [] }, 'split');
    // ── будки: пул кінематичних тіл; до падіння сховані (PARK) ──
    X.kennels = [];
    for (let k = 0; k < KB.pool; k++) X.kennels.push(aux({ id: 'kennel' + k, kind: 'spinner', c: PARK.slice(), axis: [0, 1, 0], omega: 0,
      boxes: [{ pos: [0, 1.55, 0], quat: [0, 0, 0, 1], size: [KB.HW, 1.55, KB.HW] }, { pos: [0, 3.5, 0], quat: [0, 0, 0, 1], size: [KB.HW + 0.2, 0.45, KB.HW + 0.2] }],
      balls: [], friction: 0.3, restitution: 0.3 }, 'lawn'));
    // ── фінішна миска ──
    const fb = D.lathes.find(l => l.id === 'F_finish'), fp = D.finish.p, last = groups[groups.length - 1].segs[0].end;
    const bowl = { id: 'bowl', kind: 'lathe', c: fb.center, plates: lathePlates(fb.center, fb.prof, 48, 1.0), center: [last.slice(), fb.center.slice()] };
    bowl.length = polyLen(bowl.center);
    B.addStage('bowl', [bowl], () => 15);
    B.finish = { p: fp.slice(), f: [0, 1, 0], r: D.finish.r, s: B.S() };
    B.tray = tray;
    B.extra.orbit = fb.center.slice();
    X.boosts = (meta.boosts || []).map(z => {
      const a = BE(z.a), b = BE(z.b), d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
      const t = [d[0] / L, d[1] / L, d[2] / L], n = nrm(cross(t, [0, 1, 0]));
      return { a, b, t, n, L, w: z.w, vt: z.vt };
    });
    // поляна в координатах рушія: x0..x1, вісь z = zc, підлога y(x) = y0 − k·(x − xs)
    const LW = meta.lawn;
    X.lawn = { x0: LW.x0, x1: LW.x1, zc: -LW.y, y0: LW.z0, k: LW.k, xs: LW.xs, half: LW.half };
    X.can = meta.can ? { c: [meta.can.c[0], 0, -meta.can.c[1]], r: meta.can.r } : null;
    X.bowlC = fb.center.slice(); X.finishP = fp.slice();
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W], PARK.slice());
    B.extraPoints.push([fb.center[0] - 12, fb.center[1] - 2, fb.center[2] - 12], [fb.center[0] + 12, fb.center[1] + 4, fb.center[2] + 12]);
  },

  // ── крок фізики: прискорювачі + БУДКИ, ЩО ПАДАЮТЬ (детерміновано від st.raceT і порядку кульок) ──
  step(st, dt) {
    const X = st.track.extra.dog, A = X.lawn;
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
      }
    }
    const yAt = x => A.y0 - A.k * (x - A.xs);
    const K = st.dog || (st.dog = { next: 0, drops: [], n: 0, kills: 0, max: Math.floor(st.balls.length * KB.killShare), log: [], sp: null });
    if (!K.sp) { K.sp = X.kennels.map(g => st.spinners.find(s => s.g === g)); for (const sp of K.sp) if (sp) kennelPlace(sp, PARK, 0, false); }
    for (const d of K.drops) {
      const sp = K.sp[d.slot];
      if (!d.hit && st.raceT >= d.tHit) {
        // удар: усі, хто під основою будки, розчавлені
        d.hit = true; d.killed = 0;
        const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
        for (const b of st.active.slice()) {
          if (K.kills >= K.max || st.active.length + st.finishOrder.length <= 1) break;
          const dx = b.x - d.p[0], dz = b.z - d.p[2], dy = b.y - d.p[1];
          const lx = dx * c - dz * s, lz = dx * s + dz * c;
          if (Math.abs(lx) < KB.HW + 0.5 && Math.abs(lz) < KB.HW + 0.5 && dy > -1 && dy < 4.5) { b.crushT = st.raceT; mbEliminate(st, b); K.kills++; d.killed++; }
        }
        if (K.log.length < 80) K.log.push([Math.round(d.tHit * 10) / 10, d.killed]);
      }
      // поки будка стоїть — тверда перешкода; потім ховається. Переміщення — телепортом (setTranslation)
      // і з вимкненими зіткненнями в схованці: кінематичний «переліт» за один крок дав би сотні м/с
      // і розкидав би сусідні кульки
      const on = d.hit && st.raceT < d.tHit + KB.stay;
      if (sp && on !== !!d.placed) { d.placed = on; kennelPlace(sp, on ? d.p : PARK, on ? d.yaw : 0, on); }
    }
    for (const d of K.drops) if (d.placed && st.raceT >= d.tHit + KB.stay + 1.2) { d.placed = false; kennelPlace(K.sp[d.slot], PARK, 0, false); }
    K.drops = K.drops.filter(d => st.raceT < d.tHit + KB.stay + 1.2);
    if (st.raceT < K.next || K.kills >= K.max) return;
    const busy = new Set(K.drops.map(d => d.slot));
    let slot = -1; for (let k = 0; k < KB.pool; k++) if (!busy.has(k)) { slot = k; break; }
    if (slot < 0) { K.next = st.raceT + 0.3; return; }
    const cand = [];
    for (const b of st.active) if (b.x > A.x0 && b.x < A.x1 && Math.abs(b.z - A.zc) < A.half + 0.5 && Math.abs(b.y - yAt(b.x)) < 4) cand.push(b);
    if (!cand.length) { K.next = st.raceT + 0.25; return; }
    cand.sort((p, q) => q.x - p.x);
    const r = rng(K.n * 7919 + st.balls.length * 31 + 11);
    const b = cand[Math.floor(r() * Math.max(1, Math.ceil(cand.length * KB.lead)))];
    const px = clamp(b.x + b.vx * KB.warn, A.x0, A.x1), pz = clamp(b.z + b.vz * KB.warn, A.zc - A.half + KB.HW, A.zc + A.half - KB.HW);
    // не на іншу будку, що ще стоїть
    if (K.drops.some(d => Math.hypot(d.p[0] - px, d.p[2] - pz) < KB.HW * 2.6)) { K.next = st.raceT + 0.3; return; }
    K.drops.push({ p: [px, yAt(px) - 0.05, pz], yaw: (r() - 0.5) * 0.9, t0: st.raceT, tHit: st.raceT + KB.warn, slot, n: K.n, hit: false });
    K.n++;
    K.next = st.raceT + KB.gapMin + r() * KB.gapRnd;
  },

  intro(track, pos, look) {
    const H = track.tray.hinge;
    pos.set(H[0] + 28, H[1] + 14, H[2] + 30);
    look.set(H[0] - 8, H[1] + 3, H[2]);
  },

  // спецплани: двері будки-старту, бляшанка згори, поляна зверху-збоку (видно, куди падає), миска
  camera(st, leader, pos, look) {
    const track = st.track, X = track.extra.dog, s = leader.prog;
    if (!X.sIdx) { X.sIdx = {}; for (const g of track.stages) X.sIdx[g.id] = g; }
    const S = X.sIdx, A = X.lawn, H = track.tray.hinge;
    if (s < S.chute.s0 + 8) { pos.set(H[0] + 22, H[1] + 9, H[2] + 20); look.set(H[0] - 4, H[1], H[2]); return true; }
    if (S.lawn && s >= S.lawn.s0 + 4 && s < S.lawn.s1 - 4) {
      const y = A.y0 - A.k * (leader.x - A.xs);
      pos.set(leader.x - 14, y + 17, A.zc + 24); look.set(leader.x + 9, y + 1, A.zc); return true;
    }
    if (S.bowl && s >= S.slide.s1 - 8) { const p = X.bowlC; pos.set(p[0] - 14, p[1] + 13, p[2] + 14); look.set(p[0], p[1] + 1, p[2]); return true; }
    return false;
  },

  decor(track, ctx) {
    const { THREE, scene } = ctx, X = track.extra.dog;
    const V = X.view = { nodes: {}, kennels: [], ready: false };
    const holder = new THREE.Group(); scene.add(holder);
    const T = n => ctx.loadTex('/assets/models/textures/' + n + '.jpg');
    const TEXMAP = [[/^G_Wood$/, 'wood_planks', 1 / 5, 1], [/^G_Lawn$|^D_Grass/, 'grass_toon', 1 / 8, 1], [/^G_Lane|^G_Hose$/, 'marble_light', 1 / 6, 0.7], [/^D_Terrain$/, 'grass_toon', 1 / 14, 1], [/^D_Path$/, 'stone_tiles', 1 / 3, 0.8], [/^D_Brick/, 'brick_toon', 1 / 3, 1]];
    const texOf = m => {
      if (!m || !ctx.triplanar || m.userData.tp) return;
      for (const [re, n, sc, mix] of TEXMAP) if (re.test(m.name)) { ctx.triplanar(m, T(n), { scale: sc, mix, key: n }); return; }
    };
    const put = sc => {
      const root = sc.clone(true);
      root.traverse(o => {
        if (/^(KENNEL_TPL|DOOR_)/.test(o.name)) V.nodes[o.name] = o;
        if (!o.isMesh) return;
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        const m = o.material, n = (m && m.name) || '';
        if (m && m.isMeshStandardMaterial) {
          m.envMap = ctx.env; m.envMapIntensity = 0.35; if (m.roughness < 0.35) m.roughness = 0.35;
          if (/^D_/.test(n)) { m.flatShading = /Leaf|Bush|Hill/.test(n); m.envMapIntensity = 0.15; m.needsUpdate = true; }
          if (/Gold|Metal/i.test(n)) { m.envMapIntensity = 1.0; m.metalness = 0.8; m.roughness = 0.3; }
          if (/Lamp|Glow/i.test(n)) { m.emissive.copy(m.color); m.emissiveIntensity = 1.2; }
          if (/Cloud/i.test(n)) m.emissive.set('#c9d9ef').multiplyScalar(0.25);
        }
        texOf(m);
        const fx = /Cloud|Glow/i.test(n);
        o.castShadow = !fx; o.receiveShadow = true;
      });
      if (window.mbDepthLayers) mbDepthLayers(root);   // без мерехтіння на стиках і там, де декор у площині траси
      holder.add(root);
      for (const d of ['DOOR_L', 'DOOR_R']) if (V.nodes[d]) V.nodes[d].userData.q0 = V.nodes[d].quaternion.clone();
      // будки для падіння: клони шаблону (по одній на слот пулу)
      const tpl = V.nodes.KENNEL_TPL;
      if (tpl) {
        tpl.visible = false;
        const COLS = ['#e2453c', '#4fa8ff', '#ffcc33', '#58c46a'];
        for (let k = 0; k < KB.pool; k++) {
          const c = tpl.clone(true); c.visible = false; c.position.set(0, 0, 0); c.quaternion.identity();
          c.traverse(o => { if (o.isMesh && /Kennel_Wall/.test(o.material.name)) { o.material = o.material.clone(); o.material.color.set(COLS[k]); } });
          scene.add(c); V.kennels.push(c);
        }
      }
      V.ready = true;
    };
    if (GLB_SCENE) put(GLB_SCENE);
    else {
      if (!GLB_PROM) GLB_PROM = new Promise((ok, no) => new THREE.GLTFLoader().load(GLB_URL, g => { GLB_SCENE = g.scene; ok(g.scene); }, undefined, no));
      GLB_PROM.then(put).catch(e => console.warn('[marbles] модель «Собачьего двора» не загрузилась', e));
    }
    const red = new THREE.MeshStandardMaterial({ color: '#e2453c', roughness: 0.5 });
    // лоток
    if (ctx.trayGroup) {
      const tr = track.tray, mat = new THREE.MeshStandardMaterial({ color: '#f3dcb4', roughness: 0.6 });
      if (ctx.triplanar) ctx.triplanar(mat, T('wood_planks'), { scale: 1 / 5, key: 'trayw' });
      const floor = new THREE.Mesh(new THREE.BoxGeometry(tr.L, 0.5, tr.W), mat); floor.position.set(-tr.L / 2, -0.25, 0); floor.receiveShadow = floor.castShadow = true; ctx.trayGroup.add(floor);
      for (const [px, pz, sx, sz] of [[-tr.L / 2, tr.W / 2 + 0.3, tr.L, 0.6], [-tr.L / 2, -tr.W / 2 - 0.3, tr.L, 0.6], [-tr.L - 0.3, 0, 0.6, tr.W + 1.2]]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.5, sz), red); w.position.set(px, 0.5, pz); w.castShadow = true; ctx.trayGroup.add(w);
      }
      const st = new THREE.Mesh(new THREE.PlaneGeometry(tr.W - 1.2, 2.2), ctx.mats.start); st.rotation.set(-Math.PI / 2, 0, Math.PI / 2); st.position.set(-1.8, 0.02, 0); ctx.trayGroup.add(st);
    }
    for (const b of (X.noses ? X.noses.boxes : [])) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2), red); m.position.set(...b.pos); m.quaternion.set(...b.quat); scene.add(m);
    }
    // кістки: біла кістка (стрижень + 4 маслаки)
    const boneMat = new THREE.MeshStandardMaterial({ color: '#fbf3e3', roughness: 0.55 });
    for (const sp of (X.bones || [])) {
      const grp = ctx.spinners[sp.id]; if (!grp) continue;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, sp.half * 2, 16), boneMat); shaft.rotation.z = Math.PI / 2; shaft.position.y = 0.8; shaft.castShadow = true; grp.add(shaft);
      for (const s2 of sp.balls) { const k = new THREE.Mesh(new THREE.SphereGeometry(s2.r, 18, 12), boneMat); k.position.set(...s2.pos); k.castShadow = true; grp.add(k); }
    }
    // тенісні м'ячі: салатові зі «швом»
    {
      const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d');
      g.fillStyle = '#d6f03c'; g.fillRect(0, 0, 256, 128);
      g.strokeStyle = '#ffffff'; g.lineWidth = 8; g.beginPath();
      for (let x = 0; x <= 256; x += 4) { const y = 64 + 34 * Math.sin(x / 256 * Math.PI * 4); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
      const tm = new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c), roughness: 0.85 });
      for (const s2 of X.tennis.balls) { const m = new THREE.Mesh(new THREE.SphereGeometry(s2.r, 24, 16), tm); m.position.set(...s2.pos); m.rotation.set(0.4, s2.pos[0], 0.2); m.castShadow = true; scene.add(m); }
    }
    // прискорювачі: смуги з лапками, що «біжать» уперед
    {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d');
      g.fillStyle = 'rgba(255,190,40,0.35)'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#fff6d8';
      const paw = (x, y, s) => { g.beginPath(); g.ellipse(x, y + 6 * s, 9 * s, 7 * s, 0, 0, Math.PI * 2); g.fill(); for (const [dx, dy] of [[-9, -5], [-3, -10], [3, -10], [9, -5]]) { g.beginPath(); g.arc(x + dx * s, y + dy * s, 3.2 * s, 0, Math.PI * 2); g.fill(); } };
      g.save(); g.translate(32, 32); g.rotate(Math.PI / 2); g.translate(-32, -32); paw(32, 32, 1.4); g.restore();
      const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      V.boostTex = [];
      for (const z of (X.boosts || [])) {
        const t2 = tex.clone(); t2.needsUpdate = true; t2.repeat.set(z.L / 2.4, 1);
        const xa = new THREE.Vector3(...z.t), ya = new THREE.Vector3(...z.n), na = new THREE.Vector3().crossVectors(xa, ya).normalize();
        if (na.y < 0) { na.negate(); ya.negate(); }
        const m = new THREE.Mesh(new THREE.PlaneGeometry(z.L, z.w), new THREE.MeshBasicMaterial({ map: t2, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xa, ya, na));
        m.position.set((z.a[0] + z.b[0]) / 2 + na.x * 0.06, (z.a[1] + z.b[1]) / 2 + na.y * 0.06, (z.a[2] + z.b[2]) / 2 + na.z * 0.06);
        V.boostTex.push(t2); scene.add(m);
      }
    }
    // тіні-попередження під будками, що падають
    V.shadows = [];
    const shGeo = new THREE.PlaneGeometry(1, 1); shGeo.rotateX(-Math.PI / 2);
    for (let k = 0; k < KB.pool; k++) {
      const m = new THREE.Mesh(shGeo, new THREE.MeshBasicMaterial({ color: '#1d2a14', transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false; scene.add(m); V.shadows.push(m);
    }
    // пил від удару
    V.dust = [];
    const dGeo = new THREE.SphereGeometry(1, 10, 8);
    for (let k = 0; k < KB.pool; k++) {
      const g = new THREE.Group();
      for (let i = 0; i < 7; i++) { const m = new THREE.Mesh(dGeo, new THREE.MeshBasicMaterial({ color: '#f1e3c4', transparent: true, opacity: 0.8, depthWrite: false })); m.userData.a = i / 7 * Math.PI * 2; g.add(m); }
      g.visible = false; scene.add(g); V.dust.push(g);
    }
    V.snd = {};
    for (const n of ['dog-thud', 'dog-bark']) { const a = new Audio('/assets/sfx/' + n + '.mp3'); a.preload = 'auto'; V.snd[n] = a; }
    V.lastHit = -1; V.barkT = -99;
  },

  // покадрово: двері будки-старту, шеврони, будки (падіння → стоїть → відлітає), тіні, пил, звук
  frame(st, ctx) {
    const X = st.track.extra.dog, V = X.view; if (!V) return;
    const T = performance.now() / 1000;
    const open = st.raceOn || st.tilting ? 1 : 0;
    V.doorK = (V.doorK || 0) + (open - (V.doorK || 0)) * Math.min(1, (ctx.dt || 0.016) * 2.5);
    for (const [d, sg] of [['DOOR_L', 1], ['DOOR_R', -1]]) { const n = V.nodes[d]; if (n && n.userData.q0) { n.quaternion.copy(n.userData.q0); n.rotateY(sg * 1.7 * V.doorK); } }
    for (const t2 of (V.boostTex || [])) t2.offset.x = -T * 1.4;
    const K = st.dog;
    for (const c of V.kennels) c.visible = false;
    for (const s of V.shadows) s.visible = false;
    for (const g of V.dust) g.visible = false;
    if (!K) return;
    for (const d of K.drops) {
      const c = V.kennels[d.slot], sh = V.shadows[d.slot], du = V.dust[d.slot];
      if (!c) continue;
      const tFall = clamp((st.raceT - d.t0) / KB.warn, 0, 1);
      let y = d.p[1], spin = 0, scl = 1;
      if (!d.hit) y = d.p[1] + 46 * Math.pow(1 - tFall, 2);          // падає з неба, прискорюючись
      else {
        const age = st.raceT - d.tHit;
        if (age < 0.18) scl = 1 - 0.12 * Math.sin(age / 0.18 * Math.PI);   // «присідає» від удару
        if (age > KB.stay) { const u = age - KB.stay; y = d.p[1] + 30 * u * u; spin = u * 6; }   // відлітає вгору
        if (age < 0.7) { du.visible = true; du.position.set(d.p[0], d.p[1] + 0.4, d.p[2]); du.children.forEach(m => { const rr = 1.5 + age * 7; m.position.set(Math.cos(m.userData.a) * rr, 0.3 + age * 1.5, Math.sin(m.userData.a) * rr); m.scale.setScalar(0.6 + age * 1.6); m.material.opacity = 0.75 * (1 - age / 0.7); }); }
        if (d.slot !== undefined && d.n > V.lastHit) {
          V.lastHit = d.n; dSfx(V.snd['dog-thud'], 0.8);
          if (d.killed > 0 && T - V.barkT > 5) { V.barkT = T; setTimeout(() => dSfx(V.snd['dog-bark'], 0.75), 350); }
        }
      }
      c.visible = true; c.position.set(d.p[0], y, d.p[2]); c.rotation.set(0, d.yaw + spin, 0); c.scale.set(1 / scl, scl, 1 / scl);
      if (!d.hit) { sh.visible = true; sh.position.set(d.p[0], d.p[1] + 0.08, d.p[2]); sh.rotation.y = d.yaw; const s = (KB.HW * 2 + 0.6) * (0.45 + 0.55 * tFall); sh.scale.set(s, 1, s); sh.material.opacity = 0.15 + 0.45 * tFall; }
    }
  },
};
function kennelPlace(sp, p, yaw, solid) {
  const b = sp.body, v = { x: p[0], y: p[1], z: p[2] };
  sp.ang = yaw;
  b.setTranslation(v, true); b.setNextKinematicTranslation(v);
  for (let i = 0; i < b.numColliders(); i++) b.collider(i).setEnabled(solid);
}
function dSfx(base, vol) {
  if (!base) return;
  const a = base.cloneNode(); a.volume = vol; a.play().catch(() => {}); // автоплей могли заблокувати — не падаємо
}
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
