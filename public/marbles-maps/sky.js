// ─────────────────────────────────────────────────────────────
//  ☁️ Карта «Небесные острова» — ТРАСА ЗМОДЕЛЬОВАНА В BLENDER (blender/marbles_sky.blend).
//  Звідти два файли: sky_phys.json — фізика (трикутні сітки жолобів, осьові лінії для
//  прогресу, профілі тіл обертання, ребра, фініш) у координатах рушія (метри, Y угору,
//  потік уздовж +x), і sky.glb — модель для показу. Тут лише «склейка» з рушієм:
//  лоток (кінематичний, як на інших картах), стадії, плити вирв, камера, показ моделі.
//  Маршрут: лоток → вирва-змішувач → хаб → спіраль (2 витки з креном) → хвиля →
//  три смуги (горби / гірка / зигзаг) → збірник → жолоб → вихор → фінішна чаша.
// ─────────────────────────────────────────────────────────────
(function () {
const PHYS_URL = '/assets/models/marbles/sky_phys.json';
const GLB_URL = '/assets/models/marbles/sky.glb?v=20261117';   // ?v= — змінюй після переекспорту моделі (сервер кешує .glb на 7 днів)
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
function rainbowStep(st) {
  if (!st.raceOn) return;
  // свій сід на гонку: моменти ударів щоразу інші (раніше веселка чекала перших 3 кульок — і лідери гинули завжди)
  if (!st.rb) { const seed = (Math.random() * 1e9) >>> 0, r0 = rng(seed); st.rb = { ph: 'idle', seed, next: RB.first + r0() * RB.gapRnd, t0: 0, off: 0, n: 0, kills: 0, max: Math.max(1, Math.floor(st.balls.length * RB.killShare)) }; }
  const R = st.rb;
  const t = st.raceT;
  if (R.ph === 'idle') {
    R.off = 0;
    // б'є за випадковим розкладом, незалежно від того, хто під нею: влучить у лідера чи в порожнечу — удача.
    // Коли повз неї пройшло все поле (ніхто ще не дійшов до леза) — замовкає
    if (t >= R.next && R.kills < R.max) {
      let behind = 0; for (const b of st.active) if (b.x < RB.x + 4) behind++;
      if (behind) { R.ph = 'warn'; R.t0 = t; } else R.next = t + 1;
    }
    return;
  }
  const el = t - R.t0;
  if (R.ph === 'warn') { R.off = 0; if (el >= RB.warn) { R.ph = 'down'; R.t0 = t; R.n++; } return; }
  if (R.ph === 'down') {
    const k = Math.min(1, el / RB.down), prev = R.off;
    R.off = RB.drop * k * k;                       // прискорене падіння
    // ріже все, що лежить у смузі, яку лезо пройшло за цей крок
    const yTop = RB.topY - prev, yBot = RB.topY - RB.band - R.off;
    for (const b of st.active.slice()) {
      if (R.kills >= R.max || st.active.length + st.finishOrder.length <= 1) break;
      if (Math.abs(b.x - RB.x) > RB.half || b.y > yTop || b.y < yBot) continue;
      b.cutT = t; mbEliminate(st, b); R.kills++;
    }
    if (k >= 1) { R.ph = 'hold'; R.t0 = t; }
    return;
  }
  if (R.ph === 'hold') {
    R.off = RB.drop;
    // лезо стоїть поперек траси: кульки, що в нього вкотились, теж розрізані
    const yTop = RB.topY - R.off, yBot = yTop - RB.band;
    for (const b of st.active.slice()) {
      if (R.kills >= R.max || st.active.length + st.finishOrder.length <= 1) break;
      if (Math.abs(b.x - RB.x) > RB.half || b.y > yTop || b.y < yBot) continue;
      b.cutT = t; mbEliminate(st, b); R.kills++;
    }
    if (el >= RB.hold) { R.ph = 'up'; R.t0 = t; }
    return;
  }
  if (R.ph === 'up') {
    const k = Math.min(1, el / RB.up);
    R.off = RB.drop * (1 - k * k * (3 - 2 * k));
    if (k >= 1) { R.ph = 'idle'; const r = rng(R.seed + R.n * 977); R.next = t + RB.gapMin + r() * RB.gapRnd; }
  }
}

// веселка-гільйотина над «хвилею»: площина x = 80, дуга з верхом на y = -8, смуга ~9.6 м завтовшки
const RB = { x: 80, topY: -8, band: 9.6, drop: 27, warn: 0.9, down: 0.3, hold: 0.6, up: 1.4, first: 6, gapMin: 3.5, gapRnd: 5, killShare: 0.2, half: 2.2 };   // перший удар — у вікні 6…11 с, далі кожні 3.5…8.5 с   // drop 27 — смуга зупиняється поперек траси (y≈-38)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function polyLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += len(sub(p[i], p[i - 1])); return L; }
function data() {
  // node (headless-стенди): файл читає хост через глобальний MB_READ
  if (!DATA && typeof MB_READ === 'function') DATA = JSON.parse(MB_READ(PHYS_URL));
  if (!DATA) throw new Error('Небесные острова: дані траси ще не завантажені');
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

const MAP = {
  id: 'sky',
  name: 'Небесные острова',
  icon: '☁️',
  approxSec: 70,
  allSec: 120,
  desc: 'Трасса из Blender: вихрь, спираль вокруг скалы, волна, три дорожки (горки, горбы, зигзаг) и воронка-вихрь перед финишем.',
  eliminate: false,
  customRender: true,
  theme: { sky: { hor: '#bfe0ff', zen: '#3d7fe0' }, fog: '#cfe6fb', fogDensity: 0.0012, clear: '#cfe6fb', cloudFloor: '#7fb2ec', hemi: ['#e8f2ff', '#7c8fb0', 0.8], sun: ['#fff4e0', 1.15] },

  preload() {
    if (DATA) return Promise.resolve();
    return fetch(PHYS_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => { DATA = j; });
  },

  build(B) {
    const D = data();
    const X = B.extra.sky = { decorSegs: [] };
    const aux = (g, st) => { B.segments.push(g); g.stage = st; g.stageIdx = B.stages.length - 1; g.noProgress = true; return g; };
    const sweep = s => {
      const center = s.center;
      return { id: s.id, kind: 'sweep', mesh: meshOf(s.v, s.i), center, length: polyLen(center),
        start: center[0].slice(), end: center[center.length - 1].slice(), branch: s.branch || 0 };
    };
    // ── лоток 32×16, нахиляється до вирви ──
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
    B.addStage('tray', [tray], () => 12);
    // ── вирва-змішувач ──
    const L = id => D.lathes.find(l => l.id === id), E = id => D.extra.find(e => e.id === id);
    const st = L('F_start'), Y_TH = -12.5;
    const disc = { id: 'disc', kind: 'lathe', c: st.center, plates: lathePlates(st.center, st.prof, 48, 1.0), rDisc: 22, yRim: 1.6, yThroat: Y_TH,
      // вісь стадії йде по схилу конуса (поверхня: y = -8 + (r - 2.8)·0.5) — кулька будь-де на конусі «на трасі»
      center: [HINGE.slice(), [-21, 1.2, 0], [-14, -2.4, 0], [-7, -5.9, 0], [-2.8, -8.0, 0], [0, Y_TH, 0]] };
    disc.length = polyLen(disc.center);
    B.addStage('disc', [disc], (seg, i) => i <= 4 ? 34 : 9);   // кулька може кружляти по всьому конусу (до 22 м від центру)
    // додаткові тверді деталі з Blender (X_*: задня стінка хаба тощо) — сітки без прогресу
    for (const e of D.extra) if (/^X_/.test(e.id)) aux({ id: e.id, kind: 'sweep', mesh: meshOf(e.v, e.i) }, 'disc');
    const rib = E('F_start_ribs');               // старі радіальні ребра (на конусі їх уже немає)
    if (rib) aux({ id: 'discRibs', kind: 'sweep', mesh: meshOf(rib.v, rib.i) }, 'disc');
    // ── жолоби з Blender по стадіях ──
    const groups = [];
    for (const s of D.segs) {
      let g = groups.find(q => q.stage === s.stage);
      if (!g) groups.push(g = { stage: s.stage, segs: [] });
      g.segs.push(sweep(s));
    }
    // допуск проєкції — під ширину жолоба: ширше — і кулька з нижнього витка спіралі
    // «перескакувала» б на заїзд над ним (прогрес назад, камера смикалась)
    const TOL = { hub: 7, lead: 5, helix: 4.8, wave: 8, plate: 8, lanes: 3.6, collect: 8, chute: 5 };
    for (const g of groups) B.addStage(g.stage, g.segs, () => TOL[g.stage] || 6);
    // носи розділових стінок трьох смуг (тупий торець спиняв би кульку в лоб)
    const lanes = groups.find(g => g.stage === 'lanes');
    if (lanes) {
      const s0 = lanes.segs.map(s => s.start).sort((a, b) => a[2] - b[2]);
      const boxes = [];
      for (let k = 0; k + 1 < s0.length; k++) {
        const z = (s0[k][2] + s0[k + 1][2]) / 2, x = Math.min(s0[k][0], s0[k + 1][0]), y = (s0[k][1] + s0[k + 1][1]) / 2;
        boxes.push(B.box([x, y + 0.65, z], Math.PI / 4, [0.45, 0.8, 0.45], 'wedge'));
      }
      X.noses = aux({ id: 'laneNoses', kind: 'boxes', boxes, balls: [] }, 'lanes');
    }
    // ── фініш: жолоб веде одразу у фінішну миску (вихор із діркою прибрано) ──
    const vc = D.vortex.center;                         // кінець жолоба над миською (центр миски)
    const chuteEnd = groups[groups.length - 1].segs[0].end;
    const vx = L('F_vortex');
    if (vx) {                                            // стара модель з вихором — лишаємо як було
      const vortex = { id: 'vortex', kind: 'lathe', c: vx.center, plates: lathePlates(vx.center, vx.prof, 48, 1.0),
        center: [chuteEnd.slice(), [vc[0], vc[1] - 1.5, vc[2]], [vc[0], vc[1] - 6.5, vc[2]]] };
      vortex.length = polyLen(vortex.center);
      B.addStage('vortex', [vortex], (seg, i) => 14);
      const vr = E('F_vortex_ribs');
      if (vr) aux({ id: 'vortexRibs', kind: 'sweep', mesh: meshOf(vr.v, vr.i) }, 'vortex');
    }
    const fb = L('F_finish'), fp = D.finish.p;
    const bowl = { id: 'bowl', kind: 'lathe', c: fb.center, plates: lathePlates(fb.center, fb.prof, 48, 1.0),
      center: vx ? [[vc[0], vc[1] - 6.5, vc[2]], fp.slice()] : [chuteEnd.slice(), fp.slice()] };
    bowl.length = polyLen(bowl.center);
    B.addStage('bowl', [bowl], () => 16);
    B.finish = { p: fp.slice(), f: D.finish.f.slice(), r: D.finish.r, s: B.S() };
    B.tray = tray;
    B.extra.disc = disc;
    B.extra.orbit = fp.slice();
    X.vortexC = vc.slice(); X.finishP = fp.slice();
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W]);
  },

  // конус-вирва: легке «закручування» (як у монетній вирві) — кульки йдуть по колу
  // і поступово сповзають до горла, а не скочуються з лотка прямо в дірку
  step(st, dt) {
    rainbowStep(st);
    const SW = { k: 0.75, acc: 4.5, maxT: 4.5 };
    // вихор перед фінішем: стеля швидкості — інакше швидкі кульки перелітали його край
    const vc = st.track.extra.sky && st.track.extra.sky.vortexC;
    if (vc && st.raceOn) for (const b of st.active) {
      const dx = b.x - vc[0], dz = b.z - vc[2];
      if (dx * dx + dz * dz > 13 * 13 || b.y < vc[1] - 8 || b.y > vc[1] + 6) continue;
      const v = Math.hypot(b.vx, b.vy, b.vz); if (v <= 10) continue;
      const k = 10 / v; b.vx *= k; b.vy *= k; b.vz *= k; b.body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
    }
    const d = st.track.disc; if (!d || !st.raceOn) return;
    const c = d.c, RD = d.rDisc, yR = d.yRim, yC = -8.0, slope = (yR - yC) / (RD - 2.8);
    for (const b of st.active) {
      const dx = b.x - c[0], dz = b.z - c[2], r = Math.hypot(dx, dz);
      if (r < 3.4 || r > RD - 5) continue;                        // біля бортика не розганяємо — інакше перелітають через край
      const ySurf = c[1] + yC + (r - 2.8) * slope;
      if (b.y < ySurf - 1.5 || b.y > ySurf + 2.5) continue;      // лише кульки на поверхні конуса
      if (b.swT == null) b.swT = st.raceT;
      if (st.raceT - b.swT > SW.maxT) continue;                    // накрутився — далі сповзає сам
      const fade = 1 - (st.raceT - b.swT) / SW.maxT;
      const tx = -dz / r, tz = dx / r;                            // дотична (проти годинникової згори)
      const vt = b.vx * tx + b.vz * tz;
      // трохи нижче швидкості «стійкої орбіти» (v² = g·tanθ·r) — тому кулька повільно сповзає вниз
      const want = SW.k * fade * Math.sqrt(9.81 * slope * r);
      if (vt >= want) continue;
      const a = Math.min(SW.acc * dt, want - vt);
      b.vx += tx * a; b.vz += tz * a;
      b.body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
    }
  },

  frame(st, ctx) {
    const X = st.track.extra.sky, R = st.rb; if (!X || !X.rbNode) return;
    const n = X.rbNode, T = performance.now() / 1000;
    const off = R ? R.off : 0, warn = R && R.ph === 'warn';
    n.position.y = X.rbY - off;
    n.position.x = X.rbX + (warn ? Math.sin(T * 70) * 0.25 : 0);          // тремтить перед ударом
    const glow = warn ? 0.6 + 0.4 * Math.sin(T * 30) : (R && R.ph === 'down' ? 1 : 0);
    for (const q of X.rbMats) q.m.emissive.copy(q.e).multiplyScalar(1 + glow * 1.8);
    if (R && R.ph === 'down' && X.rbSndN !== R.n) {
      X.rbSndN = R.n;
      try { const a = new Audio('/assets/sfx/zeus-strike.mp3'); a.volume = 0.7; a.playbackRate = 1.25; a.play().catch(() => {}); } catch (e) { /* без звуку */ }
    }
  },

  intro(track, pos, look) {
    const H = track.tray.hinge;
    pos.set(H[0] - 46, H[1] + 24, H[2] - 30);
    look.set(H[0] + 6, H[1] - 2, H[2] + 4);
  },

  // спецплани: тарілка вирви, під нею (горло → хаб), вихор згори
  camera(st, leader, pos, look) {
    const track = st.track, X = track.extra.sky, s = leader.prog;
    if (!X.sIdx) { X.sIdx = {}; for (const g of track.stages) X.sIdx[g.id] = g; }
    const S = X.sIdx, d = track.disc;
    // удар веселки — показуємо збоку: лезо і траса під ним
    const R = st.rb;
    // удар веселки — збоку, але лише коли біля леза є кульки (б'є тепер навмання, і в порожнечу теж)
    if (R && (R.ph === 'warn' || R.ph === 'down' || R.ph === 'hold' || (R.ph === 'up' && st.raceT - R.t0 < 0.6)) && st.active.some(b => b.x > RB.x - 22 && b.x < RB.x + 6 && b.y < -20)) {
      pos.set(RB.x - 34, -24, 30); look.set(RB.x + 2, -36, -4); return true;
    }
    if (s < S.hub.s0 - 2) { pos.set(d.c[0] - 30, d.c[1] + 18, d.c[2] - 20); look.set(d.c[0], d.c[1] - 5, d.c[2]); return true; }
    if (s < S.lead.s0 + 6) { pos.set(leader.x - 6, d.yThroat - 1, -32); look.set(leader.x + 10, leader.y - 1, 0); return true; }
    if (S.vortex && s >= S.vortex.s0 - 4) { const v = X.vortexC; pos.set(v[0] - 16, v[1] + 16, v[2] - 16); look.set(v[0], v[1] - 4, v[2]); return true; }
    if (!S.vortex && S.bowl && s >= S.bowl.s0 - 8) { const f = X.finishP; pos.set(f[0] - 18, f[1] + 14, f[2] - 16); look.set(f[0], f[1] + 1, f[2]); return true; }
    return false;
  },

  // показ: модель з Blender (нормалі рахуємо тут — у файлі їх немає) + лоток
  decor(track, ctx) {
    const { THREE, scene } = ctx;
    const holder = new THREE.Group(); scene.add(holder);
    // фактури (згенеровані в Blender, безшовні) — трипланарно, бо в моделі немає UV
    const T = n => ctx.loadTex('/assets/models/textures/' + n + '.jpg');
    const TEXMAP = [
      [/^TrackWhite$/, 'marble_white', 1 / 7, 1], [/^Track(Blue|Pink|Yellow|Mint)$/, 'marble_light', 1 / 7, 1],
      [/^D_Grass/, 'grass_toon', 1 / 9, 1], [/^D_Rock/, 'rock_layers', 1 / 12, 0.9],
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
        if (!o.isMesh) return;
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        const m = o.material, deco = m && /^D_/.test(m.name);
        if (m && m.isMeshStandardMaterial) {
          if (deco) {
            // декор (острови, хмари, веселка) — пласке toon-затінення, без дзеркальних відблисків
            m.flatShading = true; m.metalness = 0; m.envMapIntensity = 0; m.needsUpdate = true;
            if (/^D_RB/.test(m.name)) { m.side = THREE.DoubleSide; m.emissive.copy(m.color).multiplyScalar(0.35); }
            if (m.name === 'D_Water') { m.transparent = true; m.opacity = 0.82; m.side = THREE.DoubleSide; m.emissive.set('#3aa0d8').multiplyScalar(0.3); }
            if (m.name === 'D_Cloud' || m.name === 'D_Foam') m.emissive.set('#9fb8d8').multiplyScalar(0.35);
          } else { m.envMap = ctx.env; m.envMapIntensity = 0.55; if (m.roughness > 0.6) m.roughness = 0.6; }
        }
        texOf(m);
        // хмари й веселка тіні не кидають (інакше чорні плями на трасі)
        o.castShadow = !(deco && /^D_(Cloud|Foam|RB|Water)/.test(m.name)); o.receiveShadow = !deco || /^D_(Grass|Rock)/.test(m.name);
      });
      if (window.mbDepthLayers) mbDepthLayers(root);   // без мерехтіння на стиках і там, де декор у площині траси
      holder.add(root);
      const rb = root.getObjectByName('D_rainbow');
      if (rb) { const X = track.extra.sky; X.rbNode = rb; X.rbY = rb.position.y; X.rbX = rb.position.x; X.rbMats = []; rb.traverse(o => { if (o.isMesh && /^D_RB/.test(o.material.name)) { X.rbMats.push({ m: o.material, e: o.material.emissive.clone() }); } }); }
    };
    if (GLB_SCENE) put(GLB_SCENE);
    else {
      if (!GLB_PROM) GLB_PROM = new Promise((ok, no) => new THREE.GLTFLoader().load(GLB_URL, g => { GLB_SCENE = g.scene; ok(g.scene); }, undefined, no));
      GLB_PROM.then(put).catch(e => console.warn('[marbles] модель «Небесных островов» не загрузилась', e));
    }
    if (ctx.trayGroup) {
      const tr = track.tray, mat = new THREE.MeshStandardMaterial({ color: '#eef2f7', roughness: 0.35, envMap: ctx.env, envMapIntensity: 0.5 });
      const rim = new THREE.MeshStandardMaterial({ color: '#2b3442', roughness: 0.45 });
      const floor = new THREE.Mesh(new THREE.BoxGeometry(tr.L, 0.5, tr.W), mat); floor.position.set(-tr.L / 2, -0.25, 0); floor.receiveShadow = floor.castShadow = true; ctx.trayGroup.add(floor);
      for (const [px, pz, sx, sz] of [[-tr.L / 2, tr.W / 2 + 0.3, tr.L, 0.6], [-tr.L / 2, -tr.W / 2 - 0.3, tr.L, 0.6], [-tr.L - 0.3, 0, 0.6, tr.W + 1.2]]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.5, sz), rim); w.position.set(px, 0.5, pz); w.castShadow = true; ctx.trayGroup.add(w);
      }
      const st = new THREE.Mesh(new THREE.PlaneGeometry(tr.W - 1.2, 2.2), ctx.mats.start); st.rotation.set(-Math.PI / 2, 0, Math.PI / 2); st.position.set(-1.8, 0.02, 0); ctx.trayGroup.add(st);
    }
    // кільця на конусі — щоб згори було видно глибину вирви (біла поверхня читалась як пласка тарілка)
    const d = track.disc;
    if (d) {
      const cols = ['#5aa7ff', '#ff6fae', '#ffd23f', '#43d6a4', '#b46cff'];
      [5.2, 8.6, 12, 15.4, 18.8].forEach((r, i) => {
        const y = -8 + (r - 2.8) * 0.5 + 0.06;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.16, 6, 96), new THREE.MeshStandardMaterial({ color: cols[i], emissive: cols[i], emissiveIntensity: 0.35, roughness: 0.4 }));
        ring.rotation.x = Math.PI / 2; ring.position.set(d.c[0], d.c[1] + y, d.c[2]); ring.scale.z = 0.5; scene.add(ring);
      });
    }
    const nm = new THREE.MeshStandardMaterial({ color: '#2b3442', roughness: 0.45 });
    for (const b of (track.extra.sky.noses ? track.extra.sky.noses.boxes : [])) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2), nm); m.position.set(...b.pos); m.quaternion.set(...b.quat); scene.add(m);
    }
  },
};
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
