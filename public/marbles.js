// ─────────────────────────────────────────────────────────────
//  🔮 МАРБЛС — 3D-гонка кульок у дусі Marbles on Stream. ЯДРО: фізика Rapier,
//  рендер Three.js, HUD, камери. КАРТИ — окремі файли public/marbles-maps/*.js
//  (реєстр window.MB_MAPS; див. mbTrackBuilder нижче), підключаються ПІСЛЯ цього файла.
//  Classic script, підключається ПІСЛЯ app.js.
//  Користується глобалами app.js: state, rollPick, addWinner, phase.
//  Контракт: window.startMarblesGame(), window.closeMarblesOverlay(),
//  window.mbRestartRace(), window.mbRunHeadless(nicks, opts), window.mbDebug().
//  Всі власні глобали — з префіксом mb/MB_.
//
//  ФАЗА 1 (цей файл): фізика на Rapier 3D (vendor/rapier3d-compat.mjs, ESM
//  + WASM inline; dynamic import, ініціалізація один раз) + траса з ОДНОГО
//  джерела правди: track.segments — масив сегментів, кожен несе і геометрію
//  для фізики, і ту саму геометрію для рендера фази 2:
//    kind 'sweep'  — жолоб: центральна крива + U-профіль → mesh{vertices,indices}
//                    (trimesh у Rapier / BufferGeometry у Three), frames[] (p,t,r,u,w,s)
//    kind 'lathe'  — тіло обертання (диск+лійка): profile[[r,y]] → mesh (рендер)
//                    і plates[] (дотичні cuboid-плити — фізика; товсті, щоб пелетон
//                    не продавив кульку крізь безтовщинний трикутник)
//    kind 'boxes'  — cuboid-и (бампери, клини розгалужень, чаша) + balls[] (горбики)
//    kind 'tray'   — стартовий лоток: kinematic-тіло, boxes у локальних координатах
//                    hinge; кут нахилу — st.trayAng (рендер крутить групу так само)
//  Прогрес кульки = довжина дуги вздовж центральної полілінії (track.cl) до
//  проєкції; у розгалуженнях усі гілки лежать у cl з s, промасштабованим на
//  спільний інтервал стадії — прогрес монотонний і чесний між гілками.
//  Рендер (фаза 2): Three.js r128 — ті самі вершини, що й фізика, небо над
//  хмарами, мармур, кульки InstancedMesh, ніки атласом, камера за лідером.
//
//  СИСТЕМА ОДИНИЦЬ: метри. Кулька r = 0.5 (маса 1). Потік траси — вздовж +x.
//  Ядро (mbCreateSim/mbSimStep) НЕ чіпає DOM — ним користується і живий
//  цикл (rAF), і headless mbRunHeadless із синхронним віртуальним годинником
//  (у node: покласти вже ініціалізований Rapier у globalThis.RAPIER до
//  завантаження файла — dynamic import не потрібен).
// ─────────────────────────────────────────────────────────────

// ── Константи фізики ─────────────────────────────────────────
const MB_R = 0.5;                 // радіус кульки, м
const MB_G = 12.0;                // «важча» гравітація — відчуття швидкості, як у грі
const MB_DT = 1 / 60;             // фіксований крок
const MB_ITER = 4;                // ітерацій солвера Rapier
const MB_VMAX = 32;               // м/с: страховий кап швидкості
const MB_STUCK_V = 0.3;           // |v| нижче — кандидат на застряглого
const MB_STUCK_T = 2.5;           // секунд нерухомості до поштовху
const MB_COUNTDOWN = 60;          // сек після першого фінішу — далі ранжування за прогресом
const MB_FIN_HIDE = 3.5;          // сек після фінішу — кулька зникає з чаші (як у грі)
const MB_TRAY_TILT = 22;          // градусів нахилу лотка
const MB_TRAY_SEC = 2.5;          // за скільки секунд нахиляється
const MB_TRAY_COLS = 14;          // кульок у ряду на лотку
const MB_TRAY_STEP = 1.1;         // крок сітки на лотку

// матеріали. Rapier комбінує пару як СЕРЕДНЄ: кулька–траса = (ball+track)/2
const MB_FR_BALL = 0.10, MB_E_BALL = 0.42;   // кулька–кулька: 0.10 / 0.42 (жвавіше штовхаються, як у грі)
const MB_FR_TRACK = 0.45, MB_E_TRACK = 0.38; // кулька–траса: 0.275 / 0.40 — помітніші підскоки на стиках і бамперах (вище — кулька, що треться об борт у спіралях/шпильках, надто гальмує)
const MB_FR_BUMP = 0.20, MB_E_BUMP = 0.90;   // кулька–червоний бампер: 0.18 / 0.60

// ── Rapier: одноразова ініціалізація (кеш промісу) ───────────
const MB_RAPIER_URL = '/assets/vendor/rapier3d-compat.mjs';
let mbR = (typeof globalThis !== 'undefined' && globalThis.RAPIER && globalThis.RAPIER.World) ? globalThis.RAPIER : null;
let mbRProm = null;
function mbInitPhysics() {
  if (mbR) return Promise.resolve(mbR);
  if (!mbRProm) {
    mbRProm = import(MB_RAPIER_URL).then(async m => {
      const R = m.default || m;
      await R.init();
      mbR = R;
      return R;
    }).catch(e => { mbRProm = null; throw e; });
  }
  return mbRProm;
}

// ── Векторні хелпери (плоскі масиви — опис траси не залежить від Rapier) ──
function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vScale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function vLen(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
function vNorm(a) { const L = vLen(a) || 1e-9; return [a[0] / L, a[1] / L, a[2] / L]; }
function vLerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
const D2R = Math.PI / 180;

// кватерніон [x,y,z,w] з правого ортонормованого базису (стовпці x,y,z)
function mbQuatFromBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; qw = 0.25 * S; qx = (m21 - m12) / S; qy = (m02 - m20) / S; qz = (m10 - m01) / S; }
  else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / S; qx = 0.25 * S; qy = (m01 + m10) / S; qz = (m02 + m20) / S; }
  else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / S; qx = (m01 + m10) / S; qy = 0.25 * S; qz = (m12 + m21) / S; }
  else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / S; qx = (m02 + m20) / S; qy = (m12 + m21) / S; qz = 0.25 * S; }
  return [qx, qy, qz, qw];
}
// кватерніон повороту навколо Y на yaw (рад)
function mbQuatYaw(yaw) { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]; }

// ═════════════════════════════════════════════════════════════
//  ГЕОМЕТРІЯ: криві, рамки, sweep U-профілю, lathe
// ═════════════════════════════════════════════════════════════

// Catmull-Rom крізь контрольні точки [x,y,z] (кінці дубльовані), крок ~ds
function mbCatmull(ctrl, ds) {
  const P = [ctrl[0]].concat(ctrl, [ctrl[ctrl.length - 1]]);
  const out = [];
  for (let i = 1; i + 2 < P.length; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const n = Math.max(2, Math.ceil(vLen(vSub(p2, p1)) / ds) * 2);
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const pt = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        pt[c] = 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
      }
      out.push(pt);
    }
  }
  out.push(ctrl[ctrl.length - 1].slice());
  return out;
}

// рівномірна перевибірка полілінії з кроком ds (лінійно), повертає [x,y,z][]
function mbResample(pts, ds) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + vLen(vSub(pts[i], pts[i - 1])));
  const L = cum[cum.length - 1];
  const n = Math.max(2, Math.round(L / ds));
  const out = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const s = L * k / n;
    while (j + 1 < cum.length - 1 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    out.push(vLerp(pts[j], pts[j + 1], Math.min(1, Math.max(0, (s - cum[j]) / seg))));
  }
  return out;
}

// децимація рівномірної полілінії: на прямих (сумарний поворот дотичної < angDeg)
// точки рідшають до maxDs — між рамками sweep і так лінійний, геометрія та сама,
// а трикутників (і роботи narrow-phase) менше
function mbDecimate(pts, angDeg, maxDs) {
  const n = pts.length;
  if (n < 4) return pts;
  const out = [pts[0], pts[1]];
  let acc = 0, dist = 0;
  let last = 1;
  for (let i = 2; i + 1 < n; i++) {
    const t0 = vNorm(vSub(pts[i], pts[i - 1])), t1 = vNorm(vSub(pts[i + 1], pts[i]));
    acc += Math.acos(Math.max(-1, Math.min(1, vDot(t0, t1)))) / D2R;
    dist += vLen(vSub(pts[i], pts[last]));
    if (acc >= angDeg || dist >= maxDs) { out.push(pts[i]); acc = 0; dist = 0; last = i; }
    else dist = vLen(vSub(pts[i], pts[last]));
  }
  // передостання точка потрібна для дотичної на кінці, але без дубля (нульовий
  // сегмент → вироджена рамка → «стінка» поперек жолоба)
  if (last < n - 2) out.push(pts[n - 2]);
  out.push(pts[n - 1]);
  return out;
}

// y лінійно за довжиною дуги: від y0 до y1 (перезаписує y точок)
function mbAssignY(pts, y0, y1) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  const L = cum[cum.length - 1] || 1;
  for (let i = 0; i < pts.length; i++) pts[i][1] = y0 + (y1 - y0) * cum[i] / L;
  return pts;
}

// «черепашка» в плані: heading — кут у площині xz (0 = +x, +90° = +z)
function mbTurtle(x, z, headingDeg) {
  const T = { x, z, h: headingDeg * D2R, pts: [[x, 0, z]] };
  T.fwd = function (L) {
    const n = Math.max(1, Math.ceil(L / 1.0));
    for (let k = 1; k <= n; k++) {
      this.pts.push([this.x + Math.cos(this.h) * L * k / n, 0, this.z + Math.sin(this.h) * L * k / n]);
    }
    this.x += Math.cos(this.h) * L; this.z += Math.sin(this.h) * L;
    return this;
  };
  // поворот на deg (плюс — до +z від +x), радіус r; точки кожні ~4°
  T.arc = function (deg, r) {
    const sg = Math.sign(deg) || 1;
    const cx = this.x - Math.sin(this.h) * r * sg, cz = this.z + Math.cos(this.h) * r * sg;
    const a0 = this.h - sg * Math.PI / 2;
    const n = Math.max(2, Math.ceil(Math.abs(deg) / 4));
    for (let k = 1; k <= n; k++) {
      const a = a0 + deg * D2R * k / n;
      this.pts.push([cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r]);
    }
    this.h += deg * D2R;
    this.x = cx + Math.cos(a0 + deg * D2R) * r; this.z = cz + Math.sin(a0 + deg * D2R) * r;
    return this;
  };
  return T;
}

// рамки вздовж полілінії: t (дотична), r0/u0 (право/верх без крену від світової Y),
// s (дуга), bank (автоматично з кривини: зовнішній край піднятий), r/u — з креном
function mbFrames(pts, o) {
  const n = pts.length;
  const F = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const t = vNorm(vSub(b, a));
    let u0 = vSub([0, 1, 0], vScale(t, t[1]));
    u0 = vNorm(u0);
    const r0 = vNorm(vCross(t, u0));
    if (i > 0) s += vLen(vSub(pts[i], pts[i - 1]));
    F[i] = { p: pts[i].slice(), t, r0, u0, s, bank: 0, w: 0 };
  }
  // кривина в плані → крен: tan(bank) = v²κ/g при розрахунковій швидкості vBank
  const vBank = o.vBank != null ? o.vBank : 9, maxBank = (o.maxBank != null ? o.maxBank : 34) * D2R;
  const raw = new Float64Array(n);
  for (let i = 1; i + 1 < n; i++) {
    const dl = F[i + 1].s - F[i - 1].s || 1;
    const c = vDot(vSub(F[i + 1].t, F[i - 1].t), F[i].r0) / dl; // >0 — поворот праворуч
    const mag = Math.min(maxBank, Math.atan(vBank * vBank * Math.abs(c) / 9.81));
    raw[i] = Math.sign(c) * mag;
  }
  // згладжування вікном ±3 м (двічі): крен наростає плавно, без «викруту» рамок
  const win = Math.max(1, Math.round(3 / Math.max(0.3, (F[n - 1].s / (n - 1)))));
  let cur = raw;
  for (let pass = 0; pass < 2; pass++) {
    const nx = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0, cnt = 0;
      for (let k = -win; k <= win; k++) { const j = i + k; if (j >= 0 && j < n) { acc += cur[j]; cnt++; } }
      nx[i] = acc / cnt;
    }
    cur = nx;
  }
  // обмеження ШВИДКОСТІ зміни крену: нижній край жолоба (lat = w/2) не має
  // підійматись швидше за 80% місцевого ухилу, інакше на виході з крену
  // утворюється «долина», з якої повільна кулька скочується назад
  // Крен на кінцях = 0: наступний сегмент починається плоско, і банкований
  // торець давав сходинку на стику (у зигзагу об неї впирався пелетон)
  {
    const hw = Math.max(1, o.w0 / 2);
    const lim = i => 0.8 * Math.max(0.03, Math.abs(F[i].t[1])) * (i ? F[i].s - F[i - 1].s : 1) / hw;
    cur[0] = 0; cur[n - 1] = 0;
    for (let i = 1; i < n; i++) { const d = lim(i); cur[i] = Math.max(cur[i - 1] - d, Math.min(cur[i - 1] + d, cur[i])); }
    for (let i = n - 2; i >= 0; i--) { const d = lim(i + 1); cur[i] = Math.max(cur[i + 1] - d, Math.min(cur[i + 1] + d, cur[i])); }
  }
  const fixedBank = o.bank != null ? o.bank * D2R : null;
  for (let i = 0; i < n; i++) {
    const b = fixedBank != null ? fixedBank : cur[i];
    const f = F[i];
    const cb = Math.cos(b), sb = Math.sin(b);
    // крен b>0 (правий поворот): правий край опускається, лівий піднімається
    f.bank = b;
    f.r = vSub(vScale(f.r0, cb), vScale(f.u0, sb));
    f.u = vAdd(vScale(f.u0, cb), vScale(f.r0, sb));
    const k = f.s / (F[n - 1].s || 1);
    f.w = o.w0 + ((o.w1 != null ? o.w1 : o.w0) - o.w0) * (o.wEase ? k * k * (3 - 2 * k) : k);
  }
  return F;
}

// U-профіль жолоба як 5 замкнених контурів: підлога, два борти з заокругленою
// «губою» (опуклі) і дві увігнуті галтелі радіуса MB_FILLET між дном і бортом
// (зірчасті від кутової вершини — fanRoot). Галтель — принципова: у гострому
// куті «дно–борт» кулька клинилась двома контактами і статичне тертя тримало
// її на схилі; на дузі контакт один — котиться завжди. Контури перекривають
// сусідів на 0.1 — усередині твердого тіла, кульки не бачать
const MB_FILLET = 1.0;
function mbProfile(w, H, t, T) {
  const R = t / 2, hw = w / 2, fr = Math.min(MB_FILLET, hw * 0.45);
  const floor = { pts: [[-hw - t, -T], [hw + t, -T], [hw + t, 0], [-hw - t, 0]], fanRoot: 0 };
  const wall = sg => {
    const x0 = sg * hw, x1 = sg * (hw + t), cx = sg * (hw + R), cy = H - R;
    const pts = [[x0, -0.1], [x1, -0.1], [x1, cy]];
    for (let k = 1; k < 4; k++) { const a = k * Math.PI / 4; pts.push([cx + sg * R * Math.cos(a), cy + R * Math.sin(a)]); }
    pts.push([x0, cy]);
    return { pts, fanRoot: 0 };
  };
  const cove = sg => {
    // кут (hw,0) → уздовж борту до (hw,fr) → дуга до (hw-fr,0) (центр (hw-fr,fr)) → назад до кута
    const pts = [[sg * (hw + 0.1), -0.1], [sg * (hw + 0.1), fr]];
    for (let k = 0; k <= 4; k++) { const a = k * Math.PI / 8; pts.push([sg * (hw - fr + fr * Math.cos(a)), fr - fr * Math.sin(a)]); }
    pts.push([sg * (hw - fr), -0.1]);
    // увігнутий контур: центроїд вершин лежить поза тілом, тому опорна точка «всередині» явна
    return { pts, fanRoot: 0, inside: [sg * (hw + 0.03), 0.0] };
  };
  return [floor, wall(1), wall(-1), cove(1), cove(-1)];
}

// sweep контурів уздовж рамок → {vertices, indices} з узгодженими зовнішніми
// нормалями (Rapier ORIENTED + Three без flipSided). Профіль залежить від w рамки.
function mbSweep(frames, profileFn) {
  const n = frames.length;
  const prof0 = profileFn(frames[0].w);
  const loops0 = prof0.map(l => l.pts);
  const roots = prof0.map(l => l.fanRoot || 0);
  const counts = loops0.map(l => l.length);
  const ringSize = counts.reduce((a, b) => a + b, 0);
  const verts = new Float32Array(n * ringSize * 3);
  const idx = [];
  // опорна точка всередині контуру (для орієнтації нормалей назовні): явна inside або центроїд
  const cents = prof0.map(L => { if (L.inside) return L.inside; let x = 0, y = 0; for (const p of L.pts) { x += p[0]; y += p[1]; } return [x / L.pts.length, y / L.pts.length]; });
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const loops = i === 0 ? loops0 : profileFn(f.w).map(l => l.pts);
    let vi = i * ringSize;
    for (let l = 0; l < loops.length; l++) {
      for (let j = 0; j < loops[l].length; j++, vi++) {
        const q = loops[l][j];
        verts[vi * 3] = f.p[0] + f.r[0] * q[0] + f.u[0] * q[1];
        verts[vi * 3 + 1] = f.p[1] + f.r[1] * q[0] + f.u[1] * q[1];
        verts[vi * 3 + 2] = f.p[2] + f.r[2] * q[0] + f.u[2] * q[1];
      }
    }
  }
  const V = k => [verts[k * 3], verts[k * 3 + 1], verts[k * 3 + 2]];
  const tri = (a, b, c, ref) => {
    const pa = V(a), pb = V(b), pc = V(c);
    if (vDot(vCross(vSub(pb, pa), vSub(pc, pa)), ref) < 0) idx.push(a, c, b); else idx.push(a, b, c);
  };
  let base = 0;
  for (let l = 0; l < loops0.length; l++) {
    const m = counts[l], loop = loops0[l], cen = cents[l];
    for (let i = 0; i + 1 < n; i++) {
      const f = frames[i];
      const r0 = i * ringSize + base, r1 = (i + 1) * ringSize + base;
      for (let j = 0; j < m; j++) {
        const j1 = (j + 1) % m;
        const e = [loop[j1][0] - loop[j][0], loop[j1][1] - loop[j][1]];
        const mid = [(loop[j][0] + loop[j1][0]) / 2 - cen[0], (loop[j][1] + loop[j1][1]) / 2 - cen[1]];
        let n2 = [e[1], -e[0]];
        if (n2[0] * mid[0] + n2[1] * mid[1] < 0) n2 = [-e[1], e[0]];
        const ref = vAdd(vScale(f.r, n2[0]), vScale(f.u, n2[1]));
        tri(r0 + j, r0 + j1, r1 + j, ref);
        tri(r0 + j1, r1 + j1, r1 + j, ref);
      }
    }
    // торцеві кришки (віяло з fanRoot — контур зірчастий від нього): нормаль назад на старті, вперед на кінці
    const refA = vScale(frames[0].t, -1), refB = frames[n - 1].t;
    const rA = base, rB = (n - 1) * ringSize + base, root = roots[l];
    for (let j = 0; j < m; j++) {
      const j1 = (j + 1) % m;
      if (j === root || j1 === root) continue;
      tri(rA + root, rA + j, rA + j1, refA); tri(rB + root, rB + j, rB + j1, refB);
    }
    base += m;
  }
  return { vertices: verts, indices: new Uint32Array(idx) };
}

// тіло обертання навколо вертикальної осі через c: profile [[r,y]...] у порядку
// обходу (зовнішня нормаль — праворуч від напрямку обходу при погляді з +φ);
// mesh — для рендера; plates — дотичні cuboid-и лише для ребер phys
function mbLathe(c, profile, physEdges, N, thick) {
  const m = profile.length;
  const verts = new Float32Array(m * N * 3);
  const idx = [];
  for (let i = 0; i < m; i++) for (let k = 0; k < N; k++) {
    const phi = k * 2 * Math.PI / N, v = (i * N + k) * 3;
    verts[v] = c[0] + profile[i][0] * Math.cos(phi);
    verts[v + 1] = c[1] + profile[i][1];
    verts[v + 2] = c[2] + profile[i][0] * Math.sin(phi);
  }
  for (let i = 0; i + 1 < m; i++) for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N, a = i * N + k, b = i * N + k1, cI = (i + 1) * N + k, d = (i + 1) * N + k1;
    // нормаль профільного ребра: (dy, -dr) у площині (r,y) — «праворуч» від обходу
    const dr = profile[i + 1][0] - profile[i][0], dy = profile[i + 1][1] - profile[i][1];
    const phi = (k + 0.5) * 2 * Math.PI / N;
    const ref = [dy * Math.cos(phi), -dr, dy * Math.sin(phi)];
    const V = q => [verts[q * 3], verts[q * 3 + 1], verts[q * 3 + 2]];
    const tri = (p, q, r) => { if (vDot(vCross(vSub(V(q), V(p)), vSub(V(r), V(p))), ref) < 0) idx.push(p, r, q); else idx.push(p, q, r); };
    tri(a, b, cI); tri(b, d, cI);
  }
  const plates = [];
  // подовження плити за кінець ребра (щоб не було щілини на стику) — лише
  // там, де сусіднє ребро «ховає» торець (увігнутий стик). На опуклому стику
  // торець стирчав би над сусідньою поверхнею гребенем, об який упирались кульки
  const nrm2 = (i, j) => { const dr = profile[j][0] - profile[i][0], dy = profile[j][1] - profile[i][1], L = Math.hypot(dr, dy) || 1; let nx = -dy / L, ny = dr / L; if (-nx + ny < 0) { nx = -nx; ny = -ny; } return [nx, ny]; };
  const extAt = (v, g) => { // v — індекс вершини, g — напрям подовження (r,y)
    for (let i = 0; i + 1 < m; i++) {
      const o = i === v ? i + 1 : (i + 1 === v ? i : -1);
      if (o < 0) continue;
      const nn = nrm2(v, o);
      if (g[0] * nn[0] + g[1] * nn[1] > 1e-6) return 0;
    }
    return 0.3;
  };
  for (const e of physEdges) {
    const [r0, y0] = profile[e[0]], [r1, y1] = profile[e[1]];
    const gen0 = Math.hypot(r1 - r0, y1 - y0);
    const gd = [(r1 - r0) / (gen0 || 1), (y1 - y0) / (gen0 || 1)];
    const ext0 = extAt(e[0], [-gd[0], -gd[1]]), ext1 = extAt(e[1], gd);
    const gen = gen0 + ext0 + ext1, shift = (ext1 - ext0) / 2;
    const rMax = Math.max(r0, r1);
    const halfW = rMax * Math.tan(Math.PI / N) + 0.35;
    for (let k = 0; k < N; k++) {
      const phi = (k + 0.5) * 2 * Math.PI / N, cs = Math.cos(phi), sn = Math.sin(phi);
      const t = [-sn, 0, cs];
      const g = vNorm([(r1 - r0) * cs, y1 - y0, (r1 - r0) * sn]);
      let nn = vCross(g, t);
      if (vDot(nn, [-cs, 1, -sn]) < 0) nn = vScale(nn, -1); // нормаль — усередину/вгору, до кульок
      const gz = vCross(t, nn); // базис має бути правим, інакше кватерніон — сміття (знак твірної не важливий)
      const rm = (r0 + r1) / 2 + gd[0] * shift, ym = (y0 + y1) / 2 + gd[1] * shift;
      const mid = [c[0] + rm * cs, c[1] + ym, c[2] + rm * sn];
      const pos = vSub(mid, vScale(nn, thick / 2));
      plates.push({ pos, quat: mbQuatFromBasis(t, nn, gz), size: [halfW, thick / 2, gen / 2], b: { x: t, y: nn, z: gz } });
    }
  }
  return { mesh: { vertices: verts, indices: new Uint32Array(idx) }, plates };
}

// бокс: pos — центр, yaw — поворот навколо Y (рад), size — півдіагоналі
function mbBox(pos, yaw, size, role) {
  return { pos: pos.slice(), quat: mbQuatYaw(yaw), size: size.slice(), role: role || 'wall' };
}
// ніс на торець розділової стінки: суцільний ромб (квадрат під 45°) з діагоналлю
// = товщині стінки, вістря на halfW проти потоку від xBase. Плоский торець —
// пастка: кулька, що котиться на нього в лоб, зупиняється без бічної складової.
// Саме суцільний: дві тонкі V-плити пелетон продавлював, і кулька сиділа всередині
function mbNose(xBase, y, z, halfW) {
  return [mbBox([xBase, y, z], Math.PI / 4, [halfW / Math.SQRT2, 1.0, halfW / Math.SQRT2], 'wedge')];
}

// ═════════════════════════════════════════════════════════════
//  ТРАСА «ENDURANCE TEST» — одне джерело правди
// ═════════════════════════════════════════════════════════════
const MB_WALL_H = 2.0;   // висота борту над підлогою
const MB_WALL_T = 1.4;   // товщина борту (= 2·радіус губи 0.7)
const MB_LANE_T = 0.8;   // тонший борт для 4 смуг (розділові стінки)
const MB_FLOOR_T = 0.5;  // товщина підлоги
const MB_DS = 1.2;       // крок рамок sweep, м (1.0 → 159k трикутників і ~3.1мс/крок на 194; 1.2 — ~2.7мс)
const MB_JOIN_DROP = 0.15, MB_JOIN_EXT = 0.3; // стик: наступний сегмент нижче на 0.15 і починається на 0.3 раніше

// ═════════════════════════════════════════════════════════════
//  РЕЄСТР КАРТ. Кожна карта — файл у public/marbles-maps/*.js, що кладе в
//  window.MB_MAPS[id] обʼєкт { id, name, icon, approxSec, desc, theme, physics?,
//  eliminate?, build(B), intro?(track,pos,look), camera?(st,leader,pos,look),
//  decor?(track,ctx) }. build(B) описує трасу через будівельник B (нижче) і
//  ОБОВʼЯЗКОВО задає B.finish; старт — або B.tray (кінематичний лоток), або
//  B.startSlots (світові позиції) + опційно сегменти з gate:true (ворота,
//  що зникають на старті). Ядро нічого не знає про конкретну карту.
// ═════════════════════════════════════════════════════════════
function mbMapIds() { const M = (typeof MB_MAPS !== 'undefined' && MB_MAPS) || (typeof window !== 'undefined' && window.MB_MAPS) || {}; return Object.keys(M); }
function mbMapDef(id) {
  const M = (typeof MB_MAPS !== 'undefined' && MB_MAPS) || (typeof window !== 'undefined' && window.MB_MAPS) || {};
  const ids = Object.keys(M);
  if (!ids.length) throw new Error('Марблс: жодної карти не зареєстровано (public/marbles-maps/*.js)');
  return M[id] || M[mbCurMapId] || M[ids[0]];
}
let mbCurMapId = null;

function mbTrackBuilder() {
  const segments = [], stages = [];
  let S = 0;            // поточна довжина головної лінії
  let stageN = 0;

  // стадія: одна або кілька гілок (segs з .center і .length); s гілки
  // масштабується на спільний інтервал [S, S+Lmain]
  function addStage(id, segs, tolFn) {
    const Lmain = segs.reduce((a, g) => a + g.length, 0) / segs.length;
    const st = { id, s0: S, s1: S + Lmain, segIds: segs.map(g => g.id), branches: segs.length };
    for (const g of segs) {
      g.stage = id; g.stageIdx = stageN;
      g.s0 = S; g.sScale = Lmain / (g.length || 1);
      g.tolFn = tolFn;
      segments.push(g);
    }
    stages.push(st);
    S += Lmain;
    stageN++;
  }
  function centerLen(center) { let L = 0; for (let i = 1; i < center.length; i++) L += vLen(vSub(center[i], center[i - 1])); return L; }

  // жолоб: pts (x,y,z) — центральна лінія на рівні підлоги; o: {w0,w1,H,t,vBank,maxBank,bank,wEase}
  function sweepSeg(id, pts, o) {
    const rs = mbDecimate(mbResample(pts, MB_DS), 2.0, MB_DS * 3);
    const H = o.H != null ? o.H : MB_WALL_H, t = o.t != null ? o.t : MB_WALL_T;
    const frames = mbFrames(rs, { w0: o.w0, w1: o.w1, vBank: o.vBank, maxBank: o.maxBank, bank: o.bank, wEase: o.wEase });
    const mesh = mbSweep(frames, w => mbProfile(w, H, t, MB_FLOOR_T));
    const center = frames.map(f => f.p);
    return {
      id, kind: 'sweep', branch: o.branch || 0, w0: o.w0, w1: o.w1 != null ? o.w1 : o.w0, H, t, lipR: t / 2, floorT: MB_FLOOR_T,
      frames, mesh, center, length: frames[frames.length - 1].s,
      start: center[0].slice(), end: center[center.length - 1].slice(), endDir: frames[frames.length - 1].t.slice(),
    };
  }
  // висота підлоги жолоба (центральна лінія) біля x — для бамперів
  function floorAtX(seg, x) {
    const F = seg.frames;
    for (let i = 0; i + 1 < F.length; i++) {
      const a = F[i].p, b = F[i + 1].p;
      if ((x - a[0]) * (x - b[0]) <= 0 && b[0] !== a[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
    }
    let best = 1e9, y = 0; for (const f of F) { const d = Math.abs(f.p[0] - x); if (d < best) { best = d; y = f.p[1]; } } return y;
  }
  // стик: точка старту на 0.3 раніше вздовж dir і на 0.15 нижче
  function joinStart(p, dir) { return [p[0] - dir[0] * MB_JOIN_EXT, p[1] - MB_JOIN_DROP, p[2] - dir[2] * MB_JOIN_EXT]; }

  const B = {
    segments, stages, addStage, sweepSeg, floorAtX, joinStart, centerLen,
    S: () => S, stageCount: () => stageN,
    box: mbBox, nose: mbNose, bumper: mbBumper, lathe: mbLathe, catmull: mbCatmull, turtle: mbTurtle, assignY: mbAssignY,
    translateSeg: mbTranslateSeg, resample: mbResample, decimate: mbDecimate, frames: mbFrames, sweep: mbSweep, profile: mbProfile,
    quatYaw: mbQuatYaw, quatFromBasis: mbQuatFromBasis, D2R,
    v: { add: vAdd, sub: vSub, scale: vScale, dot: vDot, cross: vCross, len: vLen, norm: vNorm, lerp: vLerp },
    C: { R: MB_R, WALL_H: MB_WALL_H, WALL_T: MB_WALL_T, LANE_T: MB_LANE_T, FLOOR_T: MB_FLOOR_T, DS: MB_DS, JOIN_DROP: MB_JOIN_DROP, JOIN_EXT: MB_JOIN_EXT, TRAY_COLS: MB_TRAY_COLS, TRAY_STEP: MB_TRAY_STEP, TRAY_TILT: MB_TRAY_TILT, TRAY_SEC: MB_TRAY_SEC },
    finish: null, tray: null, startSlots: null, gate: null, extra: {}, extraPoints: [],
    zones: [],
    // зона-ефект на жолобі (див. mbZoneAt): B.zone('jump', seg, 12, { len: 3 })
    zone(type, seg, sLoc, o) { const z = mbZoneAt(type, seg, sLoc, o); this.zones.push(z); return z; },
  };
  return B;
}

function mbBuildTrack(mapId) {
  const map = mbMapDef(mapId);
  const B = mbTrackBuilder();
  map.build(B);
  const segments = B.segments, stages = B.stages, S = B.S();
  if (!B.finish) throw new Error('Марблс: карта ' + map.id + ' не задала B.finish');
  if (!B.tray && !(B.startSlots && B.startSlots.length)) throw new Error('Марблс: карта ' + map.id + ' без B.tray і без B.startSlots');
  const finish = B.finish, tray = B.tray, disc = B.extra.disc || null;
  // ── центральна полілінія прогресу (усі гілки, s промасштабовано на стадію) ──
  const cl = [];
  for (const g of segments) {
    if (g.noProgress || !g.center) continue;
    let sLoc = 0;
    for (let i = 0; i + 1 < g.center.length; i++) {
      const a = g.center[i], d = vSub(g.center[i + 1], a), L2 = vDot(d, d);
      if (L2 < 1e-8) continue;
      const L = Math.sqrt(L2);
      cl.push({ a, d, L2, L, s0: g.s0 + sLoc * g.sScale, sScale: g.sScale, tol: g.tolFn ? g.tolFn(g, i) : 8, seg: g.id, segRef: g });
      sLoc += L;
    }
  }
  // bbox статики (для OOB-контролю)
  const bbox = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
  const grow = (x, y, z) => { if (x < bbox.min[0]) bbox.min[0] = x; if (x > bbox.max[0]) bbox.max[0] = x; if (y < bbox.min[1]) bbox.min[1] = y; if (y > bbox.max[1]) bbox.max[1] = y; if (z < bbox.min[2]) bbox.min[2] = z; if (z > bbox.max[2]) bbox.max[2] = z; };
  let tris = 0;
  for (const g of segments) {
    if (g.mesh) { const v = g.mesh.vertices; for (let i = 0; i < v.length; i += 3) grow(v[i], v[i + 1], v[i + 2]); tris += g.mesh.indices.length / 3; }
    if (g.boxes && g.kind !== 'tray') for (const b of g.boxes) { const e = b.size[0] + b.size[1] + b.size[2]; grow(b.pos[0] - e, b.pos[1] - e, b.pos[2] - e); grow(b.pos[0] + e, b.pos[1] + e, b.pos[2] + e); }
  }
  for (const p of B.extraPoints) grow(p[0], p[1], p[2]);
  // прогрес зон (сегменти отримали s0/sScale лише в addStage) і радіус перевірки
  for (const z of B.zones) { z.s = (z.seg.s0 || 0) + z.sLoc * (z.seg.sScale || 1); z.reach = z.h[0] * (z.seg.sScale || 1) + 12; z.segId = z.seg.id; }
  return { id: map.id, map, segments, stages, cl, finish, tray, disc, startSlots: B.startSlots, gate: B.gate, extra: B.extra, bbox, pathLen: S, tris, zones: B.zones, byId: Object.fromEntries(segments.map(g => [g.id, g])) };
}
// зсув сегмента (усі копії геометрії: mesh, frames, center, boxes, balls)
function mbTranslateSeg(g, d) {
  if (g.mesh) { const v = g.mesh.vertices; for (let i = 0; i < v.length; i += 3) { v[i] += d[0]; v[i + 1] += d[1]; v[i + 2] += d[2]; } }
  if (g.frames) for (const f of g.frames) { f.p[0] += d[0]; f.p[1] += d[1]; f.p[2] += d[2]; }
  if (g.center) for (const c of g.center) { if (g.frames && g.frames.some(f => f.p === c)) continue; c[0] += d[0]; c[1] += d[1]; c[2] += d[2]; }
  for (const k of ['start', 'end', 'c']) if (g[k]) { g[k][0] += d[0]; g[k][1] += d[1]; g[k][2] += d[2]; }
  if (g.boxes && g.kind !== 'tray') for (const b of g.boxes) { b.pos[0] += d[0]; b.pos[1] += d[1]; b.pos[2] += d[2]; }
  if (g.balls) for (const b of g.balls) { b.pos[0] += d[0]; b.pos[1] += d[1]; b.pos[2] += d[2]; }
  if (g.plates) for (const b of g.plates) { b.pos[0] += d[0]; b.pos[1] += d[1]; b.pos[2] += d[2]; }
}

// червоний бампер: балка 14×1.2 м під кутом yaw + рядок кульок-горбиків на верхньому ребрі.
// Балка лежить у площині підлоги (floorY(x) — висота підлоги жолоба): горизонтальна
// балка на похилій (11-16%) підлозі одним кінцем тонула, другим лишала щілину
// ~0.7 м, куди пелетон вдавлював кульку всередину бокса — і вона там застрягала
function mbBumper(id, floorY, xc, zc, yaw, halfLen) {
  const k = (floorY(xc + 1) - floorY(xc - 1)) / 2;          // ухил dy/dx
  const nrm = vNorm([-k, 1, 0]);                              // нормаль підлоги
  const d0 = [Math.cos(yaw), 0, Math.sin(yaw)];
  const ax = vNorm(vSub(d0, vScale(nrm, vDot(d0, nrm))));     // вісь балки в площині підлоги
  const az = vCross(ax, nrm);
  const base = [xc, floorY(xc), zc];
  const pos = vAdd(base, vScale(nrm, 0.7 + 0.05));
  const boxes = [{ pos, quat: mbQuatFromBasis(ax, nrm, az), size: [halfLen, 0.7, 0.6], role: 'bumper', basis: { x: ax, y: nrm, z: az } }];
  const balls = [];
  for (let k2 = -3; k2 <= 3; k2++) {
    const a = k2 * (halfLen * 2 - 2) / 6;
    balls.push({ pos: vAdd(vAdd(base, vScale(ax, a)), vScale(nrm, 0.95 + 0.75)), r: 0.45 }); // горбики над верхом балки — кулька на підлозі їх не дістає
  }
  return { id, kind: 'boxes', boxes, balls, noProgress: true, bumper: true };
}

// точка центральної лінії за прогресом s (камера/проліт). У розгалуженнях
// кілька відрізків покривають той самий s — беремо найближчий до near
// (позиція лідера), щоб камера трималась його гілки, а не сусідньої
function mbCenterAt(track, s, near) {
  const cl = track.cl;
  if (!cl.length) return [0, 0, 0];
  if (s < 0) s = 0;
  let best = null, bestD = 1e18, last = cl[cl.length - 1];
  for (let i = 0; i < cl.length; i++) {
    const c = cl[i], L = c.L * c.sScale;
    if (s < c.s0 || s > c.s0 + L) continue;
    if (!near) { best = c; break; }
    const mx = c.a[0] + c.d[0] * 0.5, my = c.a[1] + c.d[1] * 0.5, mz = c.a[2] + c.d[2] * 0.5;
    const d2 = (near[0] - mx) * (near[0] - mx) + (near[1] - my) * (near[1] - my) + (near[2] - mz) * (near[2] - mz);
    if (d2 < bestD) { bestD = d2; best = c; }
  }
  if (!best) {
    // за кінцем траси (s ≥ pathLen) — кінець останнього відрізка; інакше — найближчий за s
    if (s >= last.s0) return [last.a[0] + last.d[0], last.a[1] + last.d[1], last.a[2] + last.d[2]];
    let bs = 1e18;
    for (let i = 0; i < cl.length; i++) { const d = Math.abs(cl[i].s0 - s); if (d < bs) { bs = d; best = cl[i]; } }
  }
  const t = Math.max(0, Math.min(1, (s - best.s0) / (best.L * best.sScale || 1)));
  return [best.a[0] + best.d[0] * t, best.a[1] + best.d[1] * t, best.a[2] + best.d[2] * t];
}

// прогрес кульки = довжина вздовж центральної лінії до її проєкції на полілінію
// (лідерборд, камера, анти-застрягання, OOB); повертає і відхилення
function mbProject(track, p, out) {
  const cl = track.cl;
  let best = 1e18, bs = 0, bi = 0, bt = 0;
  for (let i = 0; i < cl.length; i++) {
    const c = cl[i];
    const ex = p[0] - c.a[0], ey = p[1] - c.a[1], ez = p[2] - c.a[2];
    let t = (ex * c.d[0] + ey * c.d[1] + ez * c.d[2]) / c.L2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ex - c.d[0] * t, qy = ey - c.d[1] * t, qz = ez - c.d[2] * t;
    // штраф за відхилення поза допуском: щоб кулька в сусідній гілці/ярусі не «перестрибувала» лінію
    let d2 = qx * qx + qy * qy + qz * qz;
    if (d2 > c.tol * c.tol) d2 += 400;
    if (d2 < best) { best = d2; bs = c.s0 + t * c.L * c.sScale; bi = i; bt = t; }
  }
  if (out) {
    const c = cl[bi];
    const q = [c.a[0] + c.d[0] * bt, c.a[1] + c.d[1] * bt, c.a[2] + c.d[2] * bt];
    out.dist = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); out.i = bi; out.tol = c.tol; out.seg = c.seg;
    out.dir = [c.d[0] / c.L, c.d[1] / c.L, c.d[2] / c.L];
    out.q = q;
  }
  return bs;
}

// ═════════════════════════════════════════════════════════════
//  СВІТ RAPIER З ОПИСУ ТРАСИ
// ═════════════════════════════════════════════════════════════
const mbQ = a => ({ x: a[0], y: a[1], z: a[2], w: a[3] });

function mbBuildWorld(track) {
  const R = mbR;
  const P = track.map.physics || {};
  const world = new R.World({ x: 0, y: -(P.g != null ? P.g : MB_G), z: 0 });
  world.timestep = MB_DT;
  world.numSolverIterations = MB_ITER;
  const frT = P.frTrack != null ? P.frTrack : MB_FR_TRACK, eT = P.eTrack != null ? P.eTrack : MB_E_TRACK;
  const fixed = (desc, fr, e) => world.createCollider(desc.setFriction(fr).setRestitution(e));
  let trayBody = null;
  const gates = [], spinners = [];
  for (const g of track.segments) {
    if (g.kind === 'sweep') {
      fixed(R.ColliderDesc.trimesh(g.mesh.vertices, g.mesh.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES), frT, eT);
    } else if (g.kind === 'lathe') {
      for (const p of g.plates) fixed(R.ColliderDesc.cuboid(p.size[0], p.size[1], p.size[2]).setTranslation(p.pos[0], p.pos[1], p.pos[2]).setRotation(mbQ(p.quat)), frT, eT);
    } else if (g.kind === 'boxes') {
      for (const b of g.boxes) {
        const bump = b.role === 'bumper';
        const col = fixed(R.ColliderDesc.cuboid(b.size[0], b.size[1], b.size[2]).setTranslation(b.pos[0], b.pos[1], b.pos[2]).setRotation(mbQ(b.quat)), bump ? MB_FR_BUMP : frT, bump ? MB_E_BUMP : eT);
        if (g.gate) gates.push(col);
      }
      for (const s of g.balls) fixed(R.ColliderDesc.ball(s.r).setTranslation(s.pos[0], s.pos[1], s.pos[2]), MB_FR_BUMP, MB_E_BUMP);
    } else if (g.kind === 'spinner') {
      // обертовий елемент (млинок, колесо-мішень): кінематичне тіло, кут веде mbSimStep
      const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(g.c[0], g.c[1], g.c[2]));
      for (const b of g.boxes) world.createCollider(R.ColliderDesc.cuboid(b.size[0], b.size[1], b.size[2]).setTranslation(b.pos[0], b.pos[1], b.pos[2]).setRotation(mbQ(b.quat)).setFriction(g.friction != null ? g.friction : frT).setRestitution(g.restitution != null ? g.restitution : eT), body);
      for (const s2 of (g.balls || [])) world.createCollider(R.ColliderDesc.ball(s2.r).setTranslation(s2.pos[0], s2.pos[1], s2.pos[2]).setFriction(frT).setRestitution(eT), body);
      spinners.push({ body, g, ang: g.phase || 0, t: 0, off: 0 });
    } else if (g.kind === 'tray') {
      trayBody = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(g.hinge[0], g.hinge[1], g.hinge[2]));
      for (const b of g.boxes) world.createCollider(R.ColliderDesc.cuboid(b.size[0], b.size[1], b.size[2]).setTranslation(b.pos[0], b.pos[1], b.pos[2]).setFriction(frT).setRestitution(eT), trayBody);
    }
  }
  return { world, trayBody, gates, spinners };
}

// ═════════════════════════════════════════════════════════════
//  ЗОНИ ТРАСИ: батут, прискорювач, липка зона, лазер
//  Зона — орієнтований бокс на жолобі (x — уздовж траси, y — нормаль підлоги,
//  z — поперек). Фізики не має: ефект накладає mbSimStep на кульки всередині.
//  Усе детерміноване від st.raceT — headless-прогін і живий показ однакові.
//    jump  {launch, fwd}   — підкидає вздовж нормалі на launch м/с (+fwd уперед)
//    boost {vt, acc}       — розганяє вздовж траси до vt м/с
//    slow  {k, vmin}       — «желе»: швидкість гасне з темпом k/с, не нижче vmin
//    laser {period, on, phase, back} — промінь вмикається на on с з кожних period;
//                            кого зачепив — відкидає на back м назад по жолобу
// ═════════════════════════════════════════════════════════════
const MB_ZONE_DEF = {
  jump: { launch: 10, fwd: 2, hh: 0.9 },
  boost: { vt: 17, acc: 26, hh: 1.0 },
  slow: { k: 2.6, vmin: 2.2, hh: 1.0 },
  laser: { period: 3.2, on: 1.1, phase: 0, back: 12, hh: 1.6, len: 0.9 },
};
// зона на сегменті seg на відстані sLoc від його початку; o: {len, w, lat, ...параметри}
function mbZoneAt(type, seg, sLoc, o) {
  o = Object.assign({}, MB_ZONE_DEF[type], o || {});
  const F = seg.frames;
  let i = 0; while (i + 1 < F.length && F[i + 1].s < sLoc) i++;
  const f = F[i], hh = o.hh, lat = o.lat || 0;
  const w = o.w != null ? o.w : f.w;
  const z = {
    type, seg, sLoc, o,
    c: vAdd(vAdd(f.p, vScale(f.u, hh - 0.05)), vScale(f.r, lat)),
    x: f.t.slice(), y: f.u.slice(), z: f.r.slice(),
    h: [(o.len || 2) / 2, hh, w / 2],
    s: 0, reach: 0,
  };
  if (type === 'laser') {
    // точка повернення: на back м раніше по тому ж сегменту
    let j = i; while (j > 0 && F[j].s > sLoc - o.back) j--;
    const g = F[j];
    z.respawn = vAdd(g.p, vScale(g.u, MB_R + 0.15)); z.respawnDir = g.t.slice(); z.respawnR = g.r.slice(); z.respawnW = g.w;
  }
  return z;
}
// стан лазера в момент t: 0 — вимкнено, 1 — горить, 0.5 — попередження (блимає перед увімкненням)
function mbLaserState(z, t) {
  const o = z.o, ph = ((t + o.phase) % o.period + o.period) % o.period;
  if (ph < o.on) return 1;
  return ph > o.period - 0.45 ? 0.5 : 0;
}
// ефекти зон на кульку b (викликається з mbSimStep для активних кульок)
function mbApplyZones(st, b, dt) {
  const Z = st.track.zones;
  for (let k = 0; k < Z.length; k++) {
    const z = Z[k];
    if (Math.abs(b.prog - z.s) > z.reach) continue;
    const dx = b.x - z.c[0], dy = b.y - z.c[1], dz = b.z - z.c[2];
    const lx = dx * z.x[0] + dy * z.x[1] + dz * z.x[2];
    if (lx > z.h[0] || lx < -z.h[0]) continue;
    const ly = dx * z.y[0] + dy * z.y[1] + dz * z.y[2];
    if (ly > z.h[1] || ly < -z.h[1]) continue;
    const lz = dx * z.z[0] + dy * z.z[1] + dz * z.z[2];
    if (lz > z.h[2] || lz < -z.h[2]) continue;
    const o = z.o, body = b.body;
    let vx = b.vx, vy = b.vy, vz = b.vz;
    if (z.type === 'jump') {
      const vn = vx * z.y[0] + vy * z.y[1] + vz * z.y[2];
      if (vn > o.launch * 0.5 || st.raceT - (b.jumpT || -9) < 0.35) continue;
      const add = o.launch - vn;
      vx += z.y[0] * add + z.x[0] * o.fwd; vy += z.y[1] * add + z.x[1] * o.fwd; vz += z.y[2] * add + z.x[2] * o.fwd;
      b.jumpT = st.raceT; st.zoneHits.jump++;
    } else if (z.type === 'boost') {
      const vt = vx * z.x[0] + vy * z.x[1] + vz * z.x[2];
      if (vt >= o.vt) continue;
      const a = Math.min(o.acc * dt, o.vt - vt);
      vx += z.x[0] * a; vy += z.x[1] * a; vz += z.x[2] * a;
      if (b.boostT !== st.frame - 1) st.zoneHits.boost++;
      b.boostT = st.frame;
    } else if (z.type === 'slow') {
      const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (v <= o.vmin) continue;
      const kk = Math.max(o.vmin / v, Math.exp(-o.k * dt));
      vx *= kk; vy *= kk; vz *= kk;
    } else if (z.type === 'laser') {
      if (mbLaserState(z, st.raceT) !== 1) continue;
      // зап: назад по жолобу, з поперечним розкидом (детермінованим від номера кульки),
      // щоб відкинуті не ставали одна в одну
      const j = ((b.idx * 0.618034) % 1 - 0.5) * Math.max(0, z.respawnW - 1.4);
      const p = vAdd(z.respawn, vScale(z.respawnR, j));
      st.zapFx.push({ p: [b.x, b.y, b.z], t: st.raceT }, { p: p.slice(), t: st.raceT });
      if (st.zapFx.length > 40) st.zapFx.splice(0, st.zapFx.length - 40);
      body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
      b.x = b.px = p[0]; b.y = b.py = p[1]; b.z = b.pz = p[2];
      vx = z.respawnDir[0] * 3; vy = z.respawnDir[1] * 3; vz = z.respawnDir[2] * 3;
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.zapT = st.raceT; b.zaps = (b.zaps || 0) + 1; st.zoneHits.laser++;
      b.prog = mbProject(st.track, p);
    } else continue;
    b.vx = vx; b.vy = vy; b.vz = vz;
    body.setLinvel({ x: vx, y: vy, z: vz }, true);
  }
}

// ═════════════════════════════════════════════════════════════
//  СИМУЛЯЦІЯ
// ═════════════════════════════════════════════════════════════
// Палітра: HSL через золотий кут — сусідні кульки контрастні навіть у пелетоні
function mbHue(i) { return Math.round(i * 137.508) % 360; }
function mbColor(i) { return 'hsl(' + mbHue(i) + ',78%,60%)'; }

const mbTrackCache = {};
function mbTrack(mapId) { const id = mbMapDef(mapId).id; return mbTrackCache[id] || (mbTrackCache[id] = mbBuildTrack(id)); }

// opts.rnd — генератор [0,1) для джитера стартових позицій (±3 см): Rapier
// детермінований, і без джитера один і той самий слот лотка вигравав би щоразу —
// стартовий порядок міняв би лише ніки. У headless — сідований LCG (відтворюваність)
function mbCreateSim(nicks, opts) {
  if (!mbR) throw new Error('Марблс: Rapier не ініціалізовано — спершу await mbInitPhysics()');
  const R = mbR;
  const rnd = (opts && opts.rnd) || Math.random;
  const track = mbTrack(opts && opts.map);
  const P = track.map.physics || {};
  const w = mbBuildWorld(track);
  // старт: лоток (слоти локальні відносно hinge) або світові startSlots карти
  const tray = track.tray, H = tray ? tray.hinge : [0, 0, 0];
  const slots = tray ? tray.slots : track.startSlots;
  const balls = nicks.map((nick, i) => {
    // порядок з rollPick → місце на старті: перший — найближчий до виходу
    const slot = slots[i % slots.length];
    const tier = Math.floor(i / slots.length); // переповнення — ярусом вище
    const x = H[0] + slot[0] + (rnd() - 0.5) * 0.06, y = H[1] + slot[1] + tier * 1.05, z = H[2] + slot[2] + (rnd() - 0.5) * 0.06;
    const body = w.world.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinearDamping(P.linDamp != null ? P.linDamp : 0.01).setAngularDamping(P.angDamp != null ? P.angDamp : 0.03)
      .setCcdEnabled(true).setCanSleep(true));
    w.world.createCollider(R.ColliderDesc.ball(MB_R).setMass(1).setFriction(P.frBall != null ? P.frBall : MB_FR_BALL).setRestitution(P.eBall != null ? P.eBall : MB_E_BALL), body);
    return {
      nick, idx: i, hue: mbHue(i), color: mbColor(i), r: MB_R, body,
      x, y, z, vx: 0, vy: 0, vz: 0, q: [0, 0, 0, 1],
      px: x, py: y, pz: z, pq: [0, 0, 0, 1], gone: false, goneT: 0,
      prog: 0, stuck: 0, finished: false, finishT: 0, inWorld: true, kicks: 0,
    };
  });
  return {
    balls, active: balls.slice(), track, world: w.world, trayBody: w.trayBody, gates: w.gates, spinners: w.spinners,
    trayAng: 0, trayT: 0, tilting: false, eliminated: [],
    raceOn: false, raceT: 0, simT: 0, frame: 0,
    finishOrder: [], winner: null, firstFinishT: null, countdown: null, done: false,
    teleported: 0, rankedByProgress: 0,
    oobCount: 0, stuckKicks: 0, kickBySeg: {}, oobLog: [], stepMs: 0, maxStepMs: 0, sumMs: 0, steps: 0,
    onWinner: null, onDone: null,
    zoneHits: { jump: 0, boost: 0, laser: 0 }, zapFx: [],
  };
}

// старт гонки: лоток починає нахилятись, усі кульки прокидаються
function mbGo(st) {
  if (st.raceOn) return;
  st.raceOn = true; st.tilting = !!st.trayBody; st.trayT = 0;
  // ворота карти (сегменти з gate:true) зникають зі світу
  if (st.gates && st.gates.length) { for (const c of st.gates) { try { st.world.removeCollider(c, false); } catch (e) { /* уже немає */ } } st.gates = []; }
  for (let i = 0; i < st.balls.length; i++) st.balls[i].body.wakeUp();
}

// звільнити WASM-память світу (Rapier не збирається GC-ем)
function mbFreeSim(st) {
  if (st && st.world) { try { st.world.free(); } catch (e) { /* уже звільнено */ } st.world = null; }
}

const mbProjOut = { dist: 0, i: 0, tol: 0, seg: '', dir: null, q: null };

// вибування: кулька зникає зі світу і йде в кінець підсумку (останній вибулий — вищий)
function mbEliminate(st, b) {
  if (b.eliminated) return;
  b.finished = true; b.eliminated = true; b.inWorld = false; b.elimT = st.raceT;
  b.gone = true; b.goneT = st.raceT;
  try { st.world.removeRigidBody(b.body); } catch (e) { /* уже видалено */ }
  st.eliminated.push(b.nick);
  st.active = st.active.filter(x => x !== b);
  if (st.onEliminate) st.onEliminate(b);
}
// повний підсумок: фінішери (і ранжовані за прогресом), потім вибулі у зворотному порядку
function mbFinalOrder(st) { return st.finishOrder.concat(st.eliminated.slice().reverse()); }

// ранжування решти за прогресом (кінець відліку) — фізично кульки лишаються
function mbRankRest(st) {
  const cur = st.active;
  for (let i = 0; i < cur.length; i++) cur[i].prog = mbProject(st.track, [cur[i].x, cur[i].y, cur[i].z]);
  const rest = cur.slice().sort((a, b) => b.prog - a.prog);
  for (let i = 0; i < rest.length; i++) { rest[i].finished = true; rest[i].ranked = true; st.finishOrder.push(rest[i].nick); }
  st.rankedByProgress = rest.length;
  st.teleported = rest.length;
  st.active = [];
}

// ── Крок симуляції: один кадр 1/60 ────────────────────────────
function mbSimStep(st, dt) {
  const t0 = performance.now();
  const world = st.world;
  const track = st.track;

  // лоток: кінематичний нахил за MB_TRAY_SEC (плавний smoothstep)
  if (st.tilting && st.trayBody) {
    st.trayT += dt;
    let k = Math.min(1, st.trayT / MB_TRAY_SEC);
    k = k * k * (3 - 2 * k);
    st.trayAng = -MB_TRAY_TILT * D2R * k;
    st.trayBody.setNextKinematicRotation({ x: 0, y: 0, z: Math.sin(st.trayAng / 2), w: Math.cos(st.trayAng / 2) });
    if (k >= 1) st.tilting = false;
  }
  // обертові елементи: кут += ω·dt (крутяться і до старту — як млинки в грі)
  for (let i = 0; i < st.spinners.length; i++) {
    const sp = st.spinners[i], g = sp.g;
    sp.ang += (g.omega || 0) * dt;
    const ax = g.axis || [0, 1, 0], h = sp.ang / 2, sn = Math.sin(h);
    sp.body.setNextKinematicRotation({ x: ax[0] * sn, y: ax[1] * sn, z: ax[2] * sn, w: Math.cos(h) });
    // підйом: lift {amp, omega, phase, up} — зміщення 0..amp уздовж up за косинусом (поршні-стінки)
    if (g.lift) {
      sp.t += dt;
      sp.off = g.lift.amp * (0.5 - 0.5 * Math.cos((g.lift.omega || 1) * sp.t + (g.lift.phase || 0)));
      const up = g.lift.up || [0, 1, 0];
      sp.body.setNextKinematicTranslation({ x: g.c[0] + up[0] * sp.off, y: g.c[1] + up[1] * sp.off, z: g.c[2] + up[2] * sp.off });
    }
  }
  // попередня поза — для інтерполяції рендера між фіксованими кроками (60 Гц фізики
  // на 120–144 Гц моніторі без неї дає «двоїння» і ривки кульок)
  const balls = st.balls;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    b.px = b.x; b.py = b.y; b.pz = b.z;
    b.pq[0] = b.q[0]; b.pq[1] = b.q[1]; b.pq[2] = b.q[2]; b.pq[3] = b.q[3];
  }
  world.step();
  st.simT += dt;
  st.frame++;

  // дзеркало позицій усіх кульок у світі
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (!b.inWorld) continue;
    const body = b.body;
    const p = body.translation(), q = body.rotation();
    b.x = p.x; b.y = p.y; b.z = p.z;
    b.q[0] = q.x; b.q[1] = q.y; b.q[2] = q.z; b.q[3] = q.w;
  }
  // активні: швидкість, кап, фініш
  const act = st.active;
  const fin = track.finish;
  let anyFinish = false;
  for (let i = 0; i < act.length; i++) {
    const b = act[i], body = b.body;
    // Rapier присипляє тіло після ~0.3с нижче ~0.4 м/с, а статична траса його не
    // будить — кулька «засинала» б на схилі назавжди; активним спати не даємо
    if (st.raceOn && body.isSleeping()) body.wakeUp();
    const v = body.linvel();
    b.vx = v.x; b.vy = v.y; b.vz = v.z;
    const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (v2 > MB_VMAX * MB_VMAX) {
      const k = MB_VMAX / Math.sqrt(v2);
      b.vx *= k; b.vy *= k; b.vz *= k;
      body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
    }
    if (st.raceOn && track.zones.length) mbApplyZones(st, b, dt);
    const dx = b.x - fin.p[0], dy = b.y - fin.p[1], dz = b.z - fin.p[2];
    if (dx * fin.f[0] + dy * fin.f[1] + dz * fin.f[2] > 0 && dx * dx + dy * dy + dz * dz < fin.r * fin.r) {
      b.finished = true; anyFinish = true;
      b.prog = track.pathLen; b.finishT = st.raceT;
      st.finishOrder.push(b.nick);
      if (!st.winner) {
        st.winner = b.nick; st.firstFinishT = st.raceT; st.countdown = MB_COUNTDOWN;
        if (st.onWinner) st.onWinner(b.nick);
      }
    }
  }
  if (anyFinish) st.active = st.active.filter(b => !b.finished);

  // фінішер за MB_FIN_HIDE с зникає з чаші, як у грі: інакше 150+ кульок
  // переповнюють чашу, і нові виштовхують старих через борт у небо
  if (st.raceOn && (st.frame % 6) === 0) {
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.inWorld && b.finished && !b.ranked && !b.eliminated && st.raceT - b.finishT > MB_FIN_HIDE) {
        try { world.removeRigidBody(b.body); } catch (e) { /* уже видалено */ }
        b.inWorld = false; b.gone = true; b.goneT = st.raceT;
      }
    }
  }

  // прогрес + OOB-контроль 4 рази на секунду
  if ((st.frame % 15) === 0) {
    const bb = track.bbox;
    const cur = st.active;
    for (let i = 0; i < cur.length; i++) {
      const b = cur[i];
      b.prog = mbProject(track, [b.x, b.y, b.z], mbProjOut);
      const off = b.x < bb.min[0] - 2 || b.x > bb.max[0] + 2 || b.z < bb.min[2] - 2 || b.z > bb.max[2] + 2 || b.y < bb.min[1] - 1
        || mbProjOut.dist > mbProjOut.tol || b.y < mbProjOut.q[1] - 5;
      if (off && st.raceOn) {
        // карти з вибуванням (Few Will Survive): вилетіла — вибула, рятувати не треба
        if (track.map.eliminate) {
          // видовище як у грі: кулька ще ~1.5с падає в небо, і лише тоді вибуває
          if (b.fallT == null) b.fallT = st.raceT;
          else if (st.raceT - b.fallT > 1.5) mbEliminate(st, b);
          continue;
        }
        // вилетіла/провалилась — рятуємо на центральну лінію (для тестів рахуємо як oob)
        st.oobCount++;
        if (st.oobLog.length < 40) st.oobLog.push({ t: Math.round(st.raceT * 10) / 10, seg: mbProjOut.seg, dist: Math.round(mbProjOut.dist * 10) / 10, dy: Math.round((b.y - mbProjOut.q[1]) * 10) / 10, s: Math.round(b.prog), v: Math.round(Math.hypot(b.vx, b.vy, b.vz) * 10) / 10, p: [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, Math.round(b.z * 10) / 10] });
        const q = mbProjOut.q;
        b.body.setTranslation({ x: q[0], y: q[1] + 1.0, z: q[2] }, true);
        b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
  }

  // гоночний час, анти-застрягання, відлік після першого фінішу
  if (st.raceOn) {
    st.raceT += dt;
    const cur = st.active;
    for (let i = 0; i < cur.length; i++) {
      const b = cur[i];
      if (b.fallT != null) continue; // падає у прірву — не підштовхувати
      if (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz < MB_STUCK_V * MB_STUCK_V) {
        b.stuck += dt;
        if (b.stuck > MB_STUCK_T) {
          mbProject(track, [b.x, b.y, b.z], mbProjOut);
          const d = mbProjOut.dir, q = mbProjOut.q;
          let dx = d[0], dz = d[2], vy = 1.5;
          const hl = Math.hypot(dx, dz);
          const lat = Math.hypot(q[0] - b.x, q[2] - b.z);
          if (hl < 0.3 || lat > 2.5) {
            // вертикальна ділянка (лійка/горло) або далеко від лінії (тарілка): поштовх ДО лінії
            dx = q[0] - b.x; dz = q[2] - b.z;
            const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
            if (hl < 0.3) vy = -1.0;
          } else { dx /= hl; dz /= hl; }
          // уперед по трасі + випадково вбік + підскок: розбиває арки в горлах;
          // повторний поштовх — переважно вбік (упор попереду, напр. бампер, не пробʼєш)
          const side = (b.kicks & 1) ? (Math.random() < 0.5 ? -2.5 : 2.5) : (Math.random() * 2 - 1) * 1.2;
          const fwd = (b.kicks & 1) ? 0.8 : 2.5;
          b.body.wakeUp();
          b.body.setLinvel({ x: dx * fwd - dz * side, y: vy, z: dz * fwd + dx * side }, true);
          b.stuck = 0; b.kicks++;
          st.stuckKicks++;
          st.kickBySeg[mbProjOut.seg] = (st.kickBySeg[mbProjOut.seg] || 0) + 1;
        }
      } else b.stuck = 0;
    }
    if (st.countdown != null && !st.done) {
      st.countdown = MB_COUNTDOWN - (st.raceT - st.firstFinishT);
      if (st.countdown <= 0 && st.active.length) { st.countdown = 0; mbRankRest(st); }
    }
  }

  if (!st.done && st.finishOrder.length + st.eliminated.length === st.balls.length) {
    st.done = true;
    if (st.countdown != null) st.countdown = Math.max(0, st.countdown);
    if (st.onDone) st.onDone();
  }

  const ms = performance.now() - t0;
  st.stepMs = ms; st.sumMs += ms; st.steps++;
  if (ms > st.maxStepMs) st.maxStepMs = ms;
}

// ── Headless-прогін: синхронний virtual clock, без DOM/rAF ───
// Повертає РЕЗУЛЬТАТ синхронно, якщо Rapier уже ініціалізовано, інакше — Promise.
// opts: { settleSec=2, maxSec=300, seed — сід джитера стартових позицій,
// maxSteps — зупинитись через N кроків (для шматкування) → результат із
// paused:true і state; resume: state — продовжити; keep:true — не звільняти
// світ; onStep(st) — колбек на кожен крок }
function mbRunHeadless(nicks, opts) {
  opts = opts || {};
  if (!mbR) return mbInitPhysics().then(() => mbRunHeadless(nicks, opts));
  let st = opts.resume || null;
  if (!st) {
    let seed = (opts.seed != null ? opts.seed : 1) | 0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    st = mbCreateSim(nicks, { rnd, map: opts.map });
    const settle = opts.settleSec != null ? opts.settleSec : 2;
    for (let i = 0; i < settle * 60; i++) mbSimStep(st, MB_DT); // кульки осідають на лотку
    mbGo(st);
    st.hl = { steps: 0, sumMs: 0, minY: 1e9, maxDist: 0, marks: {}, segT: {}, segLast: {} };
    for (const b of st.balls) b.stageIdx = 0;
  }
  const hl = st.hl;
  const cap = opts.maxSec || 300;
  const maxSteps = opts.maxSteps || Infinity;
  let n = 0;
  while (!st.done && st.raceT < cap && n < maxSteps) {
    mbSimStep(st, MB_DT);
    hl.sumMs += st.stepMs; hl.steps++; n++;
    if (opts.onStep) opts.onStep(st);
    const f = st.finishOrder.length;
    if (f >= 1 && hl.marks.first == null) hl.marks.first = st.raceT;
    if (f >= 10 && hl.marks.top10 == null) hl.marks.top10 = st.raceT;
    if (f >= Math.ceil(st.balls.length / 2) && hl.marks.half == null) hl.marks.half = st.raceT;
    if ((hl.steps & 15) === 0) {
      for (let i = 0; i < st.active.length; i++) {
        const b = st.active[i];
        if (b.y < hl.minY) hl.minY = b.y;
        mbProject(st.track, [b.x, b.y, b.z], mbProjOut);
        if (mbProjOut.dist > hl.maxDist) hl.maxDist = mbProjOut.dist;
      }
      // час першого і останнього входу кульок у кожну стадію (темп лідера і розтяг поля)
      const stg = st.track.stages, tNow = Math.round(st.raceT * 10) / 10;
      for (let i = 0; i < st.active.length; i++) {
        const b = st.active[i];
        while (b.stageIdx + 1 < stg.length && b.prog >= stg[b.stageIdx + 1].s0) {
          b.stageIdx++;
          const id = stg[b.stageIdx].id;
          if (hl.segT[id] == null) hl.segT[id] = tNow;
          hl.segLast[id] = tNow;
        }
      }
    }
  }
  const r = x => Math.round(x * 10) / 10;
  const res = {
    time: r(st.raceT),
    allFinished: st.done,
    finished: st.finishOrder.length,
    physFinished: st.finishOrder.length - st.rankedByProgress,
    total: st.balls.length,
    winner: st.finishOrder[0] || null,
    top10: mbFinalOrder(st).slice(0, 10),
    teleported: st.teleported,
    eliminated: st.eliminated.length,
    oob: st.oobCount,
    zoneHits: st.zoneHits,
    stuckKicks: st.stuckKicks,
    kickBySeg: st.kickBySeg,
    maxStepMs: Math.round(st.maxStepMs * 100) / 100,
    avgStepMs: Math.round((hl.sumMs / Math.max(1, hl.steps)) * 1000) / 1000,
    marks: { first: r(hl.marks.first || 0), top10: r(hl.marks.top10 || 0), half: r(hl.marks.half || 0) },
    stageT: hl.segT,
    stageLast: hl.segLast,
    bounds: { minY: r(hl.minY), maxCenterDist: r(hl.maxDist), trackMinY: r(st.track.bbox.min[1]) },
    oobLog: st.oobLog,
  };
  if (!st.done && st.raceT < cap) { res.paused = true; res.state = st; }
  else if (!opts.keep) mbFreeSim(st);
  return res;
}

// ═════════════════════════════════════════════════════════════
//  ФАЗА 2: РЕНДЕР THREE.JS (r128, UMD-глобал THREE) + HUD + КАМЕРИ
//  Усе, що нижче, чіпає DOM/WebGL і в headless (node) не викликається.
//  Траса рендериться з ТИХ САМИХ вершин, що й фізика (g.mesh) — злиті в
//  кілька BufferGeometry: мармур (жолоби+диск+стінки), червоні бампери,
//  лоток (окрема група — крутиться разом із кінематичним тілом).
// ═════════════════════════════════════════════════════════════
let mbDom = null;
let mbSt = null;
let mbRaf = 0, mbLastTs = 0, mbAcc = 0;
let mbBaseList = [];   // учасники поточної сесії — для «Ще раз»
let mbGoTimer = 0;
let mbPodTimer = 0;
let mbBoardAcc = 0;

const MB_INTRO = 1.0;      // сек статичної камери на лоток перед відліком
const MB_CD = 5;           // відлік 5-4-3-2-1 як у грі
const MB_TEX_M = 16;       // метрів на один тайл мармурової текстури (10 — надто дрібно, «зерно»)
const MB_C_GOLD = '#ffd93d';

function mbEase(t) { if (t < 0) t = 0; if (t > 1) t = 1; return t * t * (3 - 2 * t); }
function mbClamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function mbEnsureDom() {
  if (mbDom && mbDom.root) return true;
  if (typeof document === 'undefined') return false;
  const root = document.getElementById('marbles-overlay');
  if (!root) return false;
  const $ = id => document.getElementById(id);
  mbDom = {
    root, cvs: $('mb-canvas'),
    timer: $('mb-timer'), alive: $('mb-alive'), cd: $('mb-cd'), hud: $('mb-hud'),
    board: $('mb-board'), count: $('mb-count'), podium: $('mb-podium'),
    controls: $('mb-controls'), cambar: $('mb-cambar'), flyBtn: $('mb-fly-btn'), flyHint: $('mb-flyhint'),
    picker: $('mb-picker'), pickerCards: $('mb-picker-cards'), pillName: $('mb-pill-name'),
  };
  return true;
}

function mbSetCount(txt) {
  if (!mbDom) return;
  mbDom.count.textContent = txt;
  mbDom.count.style.display = txt ? 'flex' : 'none';
}
function mbShowControls() { if (mbDom) mbDom.controls.style.display = 'flex'; }

// ═════════════════════════════════════════════════════════════
//  ПРОЦЕДУРНІ ТЕКСТУРИ (canvas): тайлений value-noise fbm
// ═════════════════════════════════════════════════════════════
function mbHash(ix, iy, seed) {
  let n = (ix * 374761393 + iy * 668265263 + seed * 1013904223) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
// fbm розміром size², період першої октави p0 клітин (тайлиться по обох осях)
function mbFbm(size, oct, p0, seed) {
  const out = new Float32Array(size * size);
  let amp = 1, norm = 0, p = p0;
  for (let o = 0; o < oct; o++) {
    const inv = p / size;
    for (let y = 0; y < size; y++) {
      const fy = y * inv, iy = fy | 0, ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      const iy1 = (iy + 1) % p;
      for (let x = 0; x < size; x++) {
        const fx = x * inv, ix = fx | 0, tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const ix1 = (ix + 1) % p;
        const a = mbHash(ix, iy, seed + o), b = mbHash(ix1, iy, seed + o), c = mbHash(ix, iy1, seed + o), d = mbHash(ix1, iy1, seed + o);
        out[y * size + x] += amp * ((a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy);
      }
    }
    norm += amp; amp *= 0.5; p *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
function mbSmooth(a, b, x) { const t = mbClamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function mbHex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mbMixC(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

// синьо-білий мармур (еталон — стінка лійки в грі): хмарні білі плями на
// блакитній базі + тонкі темні й світлі прожилки (ridged fbm)
const MB_PAL_DEFAULT = { base: '#86a2d4', light: '#e6ecf5', dark: '#4763a8', white: '#f2f5fa', a0: 0.3, a1: 0.8, dk: 0.6, wk: 0.5, grain: 8 };
// «граніт» — палітра траси за замовчуванням (карта без theme.marble): глибока синя
// база, світліші хмарні плями, дрібний білий крап і рідкі тонкі жилки — як камінь у грі.
// Стара пастельна схема з білими жилами разом із туманом читалась як потріскана крига
const MB_GRANITE_DEFAULT = { granite: true, base: '#4767ab', light: '#8ea8db', dark: '#22397a', white: '#e9f0fb', lk: 0.75, wk: 0.45, sk: 0.5, dk: 0.35 };
function mbMarbleTexture(size, pal) {
  if (!pal || pal.granite) return mbGraniteTexture(size, Object.assign({}, MB_GRANITE_DEFAULT, pal || {}));
  pal = Object.assign({}, MB_PAL_DEFAULT, pal);
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  // мʼякіше за перший варіант (контрастні «крижані» уламки читались як лід, не мармур):
  // крупніші плями, ширший поріг переходу, слабші темні жили
  const n1 = mbFbm(size, 6, 2, 11), n2 = mbFbm(size, 5, 4, 23), n3 = mbFbm(size, 5, 6, 37);
  const base = mbHex(pal.base), light = mbHex(pal.light), dark = mbHex(pal.dark), white = mbHex(pal.white);
  for (let i = 0; i < size * size; i++) {
    let col = mbMixC(base, light, mbSmooth(pal.a0, pal.a1, n1[i]));
    const r2 = 1 - Math.abs(2 * n2[i] - 1);
    col = mbMixC(col, dark, pal.dk * mbSmooth(0.86, 0.99, r2));
    const r3 = 1 - Math.abs(2 * n3[i] - 1);
    col = mbMixC(col, white, pal.wk * mbSmooth(0.9, 1.0, r3));
    // дрібне зерно, щоб плями не були «гумові»
    const gr = (mbHash(i & 1023, i >> 10, 5) - 0.5) * pal.grain;
    d[i * 4] = col[0] + gr; d[i * 4 + 1] = col[1] + gr; d[i * 4 + 2] = col[2] + gr; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
  return t;
}

// хмарний шар: біле покриття з синьо-сірими тінями, альфа — розриви
function mbGraniteTexture(size, P) {
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  const n1 = mbFbm(size, 6, 4, 11), n2 = mbFbm(size, 6, 6, 29), n3 = mbFbm(size, 5, 5, 37), n4 = mbFbm(size, 3, 96, 53);
  const base = mbHex(P.base), light = mbHex(P.light), dark = mbHex(P.dark), white = mbHex(P.white);
  for (let i = 0; i < size * size; i++) {
    let col = mbMixC(dark, base, mbSmooth(0.28, 0.55, n1[i]));          // темні й базові плями
    col = mbMixC(col, light, mbSmooth(0.5, 0.78, n2[i]) * P.lk);          // світлі «хмари»
    const r3 = 1 - Math.abs(2 * n3[i] - 1);
    col = mbMixC(col, white, P.wk * mbSmooth(0.93, 0.995, r3));           // рідкі тонкі жилки
    col = mbMixC(col, white, P.sk * mbSmooth(0.62, 0.8, n4[i]));          // білий крап
    col = mbMixC(col, dark, P.dk * mbSmooth(0.62, 0.8, 1 - n4[i]));       // темний крап
    d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
  return t;
}

// хмарний шар: купчасті хмари з самозатіненням (шум, зсунутий до сонця, темнить
// «тіньовий» бік кожної купи) і розриви, крізь які видно синю глибину неба
function mbCloudTexture(size) {
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  const n = mbFbm(size, 7, 4, 71), n2 = mbFbm(size, 5, 12, 91);
  const lit = mbHex('#ffffff'), mid = mbHex('#e2eaf6'), shade = mbHex('#8ea6c8');
  const off = Math.max(2, Math.round(size / 340));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, j = ((y + off) % size) * size + ((x + off) % size);
    const v = n[i] * 0.82 + n2[i] * 0.18, vs = n[j] * 0.82 + n2[j] * 0.18;
    const sh = mbClamp(0.5 + (v - vs) * 9, 0, 1);
    let col = mbMixC(shade, mid, sh);
    col = mbMixC(col, lit, mbSmooth(0.6, 0.8, v) * sh);
    d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2];
    d[i * 4 + 3] = 255 * mbSmooth(0.47, 0.66, v);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
  return t;
}

// логотип на тарілці: «МАРБЛС» червоним (як у грі) + бренд сайту
function mbLogoTexture() {
  const S = 1024, c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.save(); g.translate(S / 2, S * 0.30); g.transform(1, 0, -0.18, 1, 0, 0);
  g.font = '900 150px Inter, Arial Black, sans-serif';
  g.lineJoin = 'round'; g.lineWidth = 22; g.strokeStyle = '#ffffff'; g.strokeText('МАРБЛС', 0, 0);
  g.fillStyle = '#d8232f'; g.fillText('МАРБЛС', 0, 0);
  g.restore();
  g.font = '900 78px Inter, Arial Black, sans-serif';
  g.lineWidth = 14; g.strokeStyle = '#ffffff'; g.strokeText('⚡ KICKPLAY', S / 2, S * 0.72);
  g.fillStyle = '#ffd93d'; g.fillText('⚡ KICKPLAY', S / 2, S * 0.72);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
  return t;
}

// кулька: базовий колір + мʼякий білий завиток і темна пляма. Без візерунка
// однотонна сфера виглядає як каменюка, що ковзає, — обертання не видно
// Основа біла: колір кожної кульки дає instanceColor (множиться на текстуру), тож
// візерунок зроблено ТЕМНІШИМИ відтінками — смуга-завиток і пляма того ж кольору
function mbBallTexture() {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 128);
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(0,0,0,0.30)'; g.lineWidth = 16;
  g.beginPath();
  for (let x = -8; x <= 264; x += 8) { const y = 64 + Math.sin(x / 256 * Math.PI * 4) * 26; if (x === -8) g.moveTo(x, y); else g.lineTo(x, y); }
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 5; g.stroke();
  const gr2 = g.createRadialGradient(60, 26, 2, 60, 26, 22);
  gr2.addColorStop(0, 'rgba(0,0,0,0.45)'); gr2.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr2; g.fillRect(0, 0, 256, 128);
  const t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding;
  return t;
}
// колір кульки i: золотий кут по тону + три рівні насиченості/яскравості, щоб
// сусіди в пелетоні не зливались; лінійний простір (instanceColor у r128 — лінійний)
function mbBallColor(i, out) {
  const h = ((i * 137.508) % 360) / 360, k = i % 3;
  out.setHSL(h, [0.82, 0.7, 0.9][k], [0.52, 0.6, 0.45][k]);
  return out.convertSRGBToLinear();
}

// стрічка обідка фінішної чаші: жовті світлодіоди пунктиром + напис FINISH!
function mbFinishTexture() {
  const W = 1024, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#ffe14a';
  for (let x = 12; x < W; x += 32) { g.beginPath(); g.arc(x, 14, 8, 0, 6.2832); g.fill(); g.beginPath(); g.arc(x, H - 14, 8, 0, 6.2832); g.fill(); }
  g.font = '900 64px Inter, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = '#3a2a00';
  for (let k = 0; k < 2; k++) { const x = W * (0.25 + 0.5 * k); g.strokeText('FINISH!', x, H / 2 + 2); g.fillText('FINISH!', x, H / 2 + 2); }
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.encoding = THREE.sRGBEncoding;
  return t;
}

// шаховка START (жовто-чорна) на краю лотка
function mbStartTexture() {
  const W = 1024, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const sq = 32;
  for (let y = 0; y < H; y += sq) for (let x = 0; x < W; x += sq) { g.fillStyle = (((x + y) / sq) & 1) ? '#111111' : '#ffd93d'; g.fillRect(x, y, sq, sq); }
  g.font = '900 72px Inter, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = '#000'; g.fillStyle = '#ffd93d';
  for (let k = 0; k < 3; k++) { const x = W * (k + 0.5) / 3; g.strokeText('START', x, H / 2 + 3); g.fillText('START', x, H / 2 + 3); }
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding;
  return t;
}

// атлас ніків: 8 колонок слотів 256×80; у слоті — виноска від кульки (лівий
// нижній кут) і білий жирний текст із чорною обводкою. Один InstancedMesh
// квадів-білбордів замість сотень draw call
const MB_SLOT_W = 256, MB_SLOT_H = 80, MB_SLOT_COLS = 8;
function mbLabelAtlas(nicks) {
  const rows = Math.max(1, Math.ceil(Math.min(nicks.length, 408) / MB_SLOT_COLS));
  const W = MB_SLOT_COLS * MB_SLOT_W;
  let H = 128; while (H < rows * MB_SLOT_H) H *= 2;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
  for (let i = 0; i < nicks.length && i < 408; i++) {
    const x0 = (i % MB_SLOT_COLS) * MB_SLOT_W, y0 = Math.floor(i / MB_SLOT_COLS) * MB_SLOT_H;
    const label = String(nicks[i]);
    let fs = 34;
    g.font = '700 ' + fs + 'px Inter, Arial, sans-serif';
    let tw = g.measureText(label).width;
    if (tw > 220) { fs = Math.max(15, Math.floor(fs * 220 / tw)); g.font = '700 ' + fs + 'px Inter, Arial, sans-serif'; tw = g.measureText(label).width; }
    // виноска: від кульки (0,80) підйом до (18,66) і підкреслення під текстом
    g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(x0 + 1, y0 + MB_SLOT_H - 1); g.lineTo(x0 + 18, y0 + 66); g.lineTo(x0 + 22 + tw, y0 + 66); g.stroke();
    // обводка тонша за початкові 6px: у щільному пелетоні (194 плашки) чорне
    // домінувало і хмара ніків читалась чорною, у грі вона біла
    g.lineWidth = 4; g.strokeStyle = '#000'; g.strokeText(label, x0 + 20, y0 + 58);
    g.fillStyle = '#fff'; g.fillText(label, x0 + 20, y0 + 58);
  }
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return { tex: t, W, H };
}

// ═════════════════════════════════════════════════════════════
//  ГЕОМЕТРІЯ РЕНДЕРА З ОПИСУ ТРАСИ (ті самі вершини, що й фізика)
// ═════════════════════════════════════════════════════════════
// частина: {pos, nrm, uv, idx} → злиття в один BufferGeometry
function mbMergeParts(parts) {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.pos.length / 3; ni += p.idx.length; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.pos, vo * 3); nrm.set(p.nrm, vo * 3); uv.set(p.uv, vo * 2);
    for (let i = 0; i < p.idx.length; i++) idx[io + i] = p.idx[i] + vo;
    vo += p.pos.length / 3; io += p.idx.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}
function mbNormalsOf(pos, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const n = g.getAttribute('normal').array;
  g.dispose();
  return n;
}
// жолоб: u = дуга/T, v = обхід контуру профілю (тайлів — ціле число, щоб
// замикання контуру не давало шва)
function mbSweepPart(g) {
  const pos = new Float32Array(g.mesh.vertices);
  const idx = g.mesh.indices;
  const uv = new Float32Array(pos.length / 3 * 2);
  const F = g.frames, n = F.length;
  const ring = pos.length / 3 / n;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const loops = mbProfile(F[i].w, g.H, g.t, g.floorT);
    const u = F[i].s / MB_TEX_M;
    for (const L of loops) {
      const pts = L.pts, m = pts.length;
      let tot = 0; for (let j = 0; j < m; j++) { const a = pts[j], b = pts[(j + 1) % m]; tot += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      const tiles = Math.max(1, Math.round(tot / MB_TEX_M)), sc = tiles / (tot || 1);
      let acc = 0;
      for (let j = 0; j < m; j++, k++) {
        if (j) { const a = pts[j - 1], b = pts[j]; acc += Math.hypot(b[0] - a[0], b[1] - a[1]); }
        uv[k * 2] = u; uv[k * 2 + 1] = acc * sc;
      }
    }
  }
  if (k !== ring * n) console.warn('[marbles] uv ring mismatch', g.id, k, ring * n);
  return { pos, nrm: mbNormalsOf(pos, idx), uv, idx: new Uint32Array(idx) };
}
// тіло обертання: пласкі ділянки — планарне (x,z), круті (лійка, горло) — циліндричне
function mbLathePart(g) {
  const pos = new Float32Array(g.mesh.vertices), idx = g.mesh.indices, N = g.N, prof = g.profile, m = prof.length;
  const uv = new Float32Array(pos.length / 3 * 2);
  for (let i = 0; i < m; i++) {
    const p = prof[i], pn = prof[Math.min(m - 1, i + 1)], pp = prof[Math.max(0, i - 1)];
    const steep = Math.abs(pn[1] - pp[1]) > Math.abs(pn[0] - pp[0]);
    const tiles = Math.max(2, Math.round(2 * Math.PI * Math.max(3, p[0]) / MB_TEX_M));
    for (let k = 0; k < N; k++) {
      const v = i * N + k;
      if (steep) { uv[v * 2] = k / N * tiles; uv[v * 2 + 1] = pos[v * 3 + 1] / MB_TEX_M; }
      else { uv[v * 2] = pos[v * 3] / MB_TEX_M; uv[v * 2 + 1] = pos[v * 3 + 2] / MB_TEX_M; }
    }
  }
  return { pos, nrm: mbNormalsOf(pos, idx), uv, idx: new Uint32Array(idx) };
}
// бокс (cuboid опису траси) → частина з uv у метрах (без розтягу на довгих балках)
function mbBoxPart(b) {
  const sx = b.size[0], sy = b.size[1], sz = b.size[2];
  const geo = new THREE.BoxGeometry(2 * sx, 2 * sy, 2 * sz);
  const uvA = geo.getAttribute('uv');
  // порядок граней BoxGeometry: +x,-x (глибина×висота), +y,-y (ширина×глибина), +z,-z (ширина×висота)
  const dims = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uvA.setXY(i, uvA.getX(i) * 2 * dims[f][0] / MB_TEX_M, uvA.getY(i) * 2 * dims[f][1] / MB_TEX_M);
  }
  const q = new THREE.Quaternion(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
  const mtx = new THREE.Matrix4().compose(new THREE.Vector3(b.pos[0], b.pos[1], b.pos[2]), q, new THREE.Vector3(1, 1, 1));
  geo.applyMatrix4(mtx);
  const part = { pos: new Float32Array(geo.getAttribute('position').array), nrm: new Float32Array(geo.getAttribute('normal').array), uv: new Float32Array(uvA.array), idx: new Uint32Array(geo.getIndex().array) };
  geo.dispose();
  return part;
}
function mbSpherePart(pos, r) {
  const geo = new THREE.SphereGeometry(r, 12, 8);
  geo.translate(pos[0], pos[1], pos[2]);
  const part = { pos: new Float32Array(geo.getAttribute('position').array), nrm: new Float32Array(geo.getAttribute('normal').array), uv: new Float32Array(geo.getAttribute('uv').array), idx: new Uint32Array(geo.getIndex().array) };
  geo.dispose();
  return part;
}

// ═════════════════════════════════════════════════════════════
//  СЦЕНА (створюється один раз на сторінку; траса кешується)
// ═════════════════════════════════════════════════════════════
let mbG = null;      // renderer/scene/camera/матеріали/меші траси
let mbRace = null;   // ресурси поточної гонки (кульки, атлас ніків)

function mbGfxInit() {
  if (mbG) return mbG;
  const cvs = mbDom.cvs;
  const renderer = new THREE.WebGLRenderer({ canvas: cvs, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xa9c3ea, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xa9c3ea, 0.0011);
  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 5000);
  scene.add(camera);

  // небо: купол-градієнт горизонт → зеніт (без текстур)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { hor: { value: new THREE.Color(0xa9c3ea) }, zen: { value: new THREE.Color(0x2f62c4) } },
    vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 hor; uniform vec3 zen; varying vec3 vW; void main(){ float h = clamp(normalize(vW - cameraPosition).y, 0.0, 1.0); gl_FragColor = vec4(mix(hor, zen, pow(h, 0.55)), 1.0); }',
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3500, 32, 16), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  // шар хмар під трасою: суцільна нижня «підлога» + два прозорі шари з дрейфом
  // (позиція під конкретну трасу ставиться в mbTrackGfxBuild)
  const cloudTex = mbCloudTexture(1024);
  const cloudY = 0, cx = 0, cz = 0;
  const cloudGeo = new THREE.PlaneGeometry(7000, 7000);
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x3d68b5 });
  const cloudFloor = new THREE.Mesh(cloudGeo, floorMat);
  cloudFloor.rotation.x = -Math.PI / 2; cloudFloor.position.set(cx, cloudY - 30, cz);
  scene.add(cloudFloor);
  const clouds = [];
  for (let l = 0; l < 2; l++) {
    const tex = l ? cloudTex.clone() : cloudTex;
    tex.needsUpdate = true;
    tex.repeat.set(l ? 4 : 7, l ? 4 : 7);
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: l ? 0.9 : 1 });
    const mesh = new THREE.Mesh(cloudGeo, m);
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(cx, cloudY + l * 18, cz);
    scene.add(mesh);
    clouds.push({ mesh, tex, drift: l ? 0.0011 : 0.0006, dy: l * 18 });
  }

  // освітлення: небо/хмари + сонце з мʼякими тінями, що їдуть за камерою
  const hemi = new THREE.HemisphereLight(0xd6e4f6, 0x93a9c6, 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff6e6, 1.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 520;
  sun.shadow.camera.left = -80; sun.shadow.camera.right = 80; sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.06;
  scene.add(sun); scene.add(sun.target);

  // envMap з неба — вологий блиск губ жолоба і кульок. Не з PMREM-сцени
  // (купол-шейдер у кубічній камері давав NaN → усі StandardMaterial білі),
  // а з крихітної еквіректангулярної градієнтної текстури: зеніт → горизонт → хмари
  const envCv = document.createElement('canvas'); envCv.width = 128; envCv.height = 64;
  {
    const g = envCv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, '#3f72cf'); gr.addColorStop(0.45, '#b4cbec'); gr.addColorStop(0.5, '#d6e3f4'); gr.addColorStop(0.56, '#e9eff8'); gr.addColorStop(1, '#5d82c2');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 64);
    // сонце (той самий бік, що й DirectionalLight): мала яскрава пляма → блік на кульках
  }
  const envTex = new THREE.CanvasTexture(envCv);
  envTex.mapping = THREE.EquirectangularReflectionMapping; envTex.encoding = THREE.sRGBEncoding;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(envTex).texture;
  // для кульок — те саме небо + сонце (мала яскрава пляма): блік, без якого глянець виглядав матовим.
  // Трасі сонце в envMap не даємо — на гладкому жолобі воно засвічувало цілі ділянки
  {
    const g = envCv.getContext('2d');
    const sg = g.createRadialGradient(78, 11, 0, 78, 11, 9);
    sg.addColorStop(0, 'rgba(255,255,250,1)'); sg.addColorStop(0.35, 'rgba(255,250,235,0.8)'); sg.addColorStop(1, 'rgba(255,250,235,0)');
    g.fillStyle = sg; g.fillRect(60, 0, 40, 26);
    envTex.needsUpdate = true;
  }
  const envBall = pmrem.fromEquirectangular(envTex).texture;
  pmrem.dispose(); envTex.dispose();

  const mats = {
    red: new THREE.MeshStandardMaterial({ color: 0xd0202a, roughness: 0.35, metalness: 0.05, envMap: env, envMapIntensity: 0.25 }), // 0.8 — яскраве небо в envMap робило бампери рожевими
    ball: new THREE.MeshStandardMaterial({ map: mbBallTexture(), color: 0xffffff, roughness: 0.16, metalness: 0.0, envMap: envBall, envMapIntensity: 0.75 }),
    logo: new THREE.MeshBasicMaterial({ map: mbLogoTexture(), transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    finish: new THREE.MeshBasicMaterial({ map: mbFinishTexture(), transparent: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    start: new THREE.MeshBasicMaterial({ map: mbStartTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  mbG = {
    renderer, scene, camera, sky, skyMat, clouds, cloudFloor, hemi, sun, env, mats, cloudTex, tg: null, themeId: null,
    camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), camInit: false,
    fly: { on: false, px: 0, py: 0, pz: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, speedMul: 1, kW: false, kA: false, kS: false, kD: false, kUp: false, kDn: false, kBoost: false, drag: false, lastX: 0, lastY: 0 },
    frameMs: 0, drawCalls: 0, tris: 0,
    focus: new THREE.Vector3(),
    orbitT: 0,
  };
  mbGfxResize();
  mbBindInput();
  return mbG;
}

// ── Тема карти: небо/туман/хмари (карта може задати theme.sky {hor, zen}, theme.fog, theme.cloudTint, theme.cloudFloor) ──
// ballColors: 'rainbow' — кожна кулька свого кольору (легше знайти свою), 'mono' — усі ballColor
const MB_THEME_DEFAULT = { sky: { hor: '#a9c3ea', zen: '#2f62c4' }, fog: '#a9c3ea', fogDensity: 0.0011, cloudFloor: '#3d68b5', cloudTint: '#ffffff', clear: '#a9c3ea', hemi: ['#d6e4f6', '#6f89b3', 0.75], sun: ['#fff4e2', 1.1], marble: null, roughness: 0.42, metalness: 0.05, envInt: 0.55, ballColor: '#ffffff', ballColors: 'rainbow', redColor: '#d0202a' };
function mbApplyTheme(map) {
  const G = mbG, T = Object.assign({}, MB_THEME_DEFAULT, map.theme || {});
  G.skyMat.uniforms.hor.value.set(T.sky.hor || MB_THEME_DEFAULT.sky.hor);
  G.skyMat.uniforms.zen.value.set(T.sky.zen || MB_THEME_DEFAULT.sky.zen);
  G.scene.fog.color.set(T.fog); G.scene.fog.density = T.fogDensity;
  G.renderer.setClearColor(new THREE.Color(T.clear), 1);
  G.cloudFloor.material.color.set(T.cloudFloor);
  G.hemi.color.set(T.hemi[0]); G.hemi.groundColor.set(T.hemi[1]); G.hemi.intensity = T.hemi[2];
  G.sun.color.set(T.sun[0]); G.sun.intensity = T.sun[1];
  G.mats.ball.color.set(T.ballColor); G.mats.red.color.set(T.redColor);
  // нічні теми: хмари підфарбовуються (theme.cloudTint), інакше вони білі, як удень
  for (const c of G.clouds) { c.mesh.visible = T.clouds !== false; c.mesh.material.color.set(T.cloudTint || '#ffffff'); }
  G.cloudFloor.visible = T.clouds !== false;
  G.theme = T;
  return T;
}

// ── Меші траси конкретної карти (ті самі вершини, що й фізика) + декор карти ──
function mbTrackGfxDispose() {
  const G = mbG; if (!G || !G.tg) return;
  const t = G.tg;
  for (const o of [t.trackMesh, t.redMesh, t.gateMesh, t.trayGroup, t.decor, t.zones]) if (o) G.scene.remove(o);
  const kill = o => { if (!o) return; o.traverse(x => { if (x.geometry) x.geometry.dispose(); }); };
  kill(t.trackMesh); kill(t.redMesh); kill(t.gateMesh); kill(t.trayGroup); kill(t.decor); kill(t.zones);
  for (const sp of (t.spinners || [])) { G.scene.remove(sp.grp); kill(sp.grp); }
  if (t.marbleTex) t.marbleTex.dispose();
  if (t.marbleMat) t.marbleMat.dispose();
  G.tg = null;
}
function mbTrackGfxBuild(track) {
  const G = mbG;
  if (G.tg && G.tg.trackId === track.id) return G.tg;
  mbTrackGfxDispose();
  const T = mbApplyTheme(track.map);
  const scene = G.scene, mats = G.mats;
  const marbleTex = mbMarbleTexture(1024, T.marble);
  const marbleMat = new THREE.MeshStandardMaterial({ map: marbleTex, roughness: T.roughness, metalness: T.metalness, envMap: G.env, envMapIntensity: T.envInt });
  mats.marble = marbleMat;
  const marbleParts = [], redParts = [], trayParts = [], gateParts = [];
  const spinGroups = [];
  for (const g of track.segments) {
    if (g.kind === 'spinner') {
      const grp = new THREE.Group(); grp.position.set(g.c[0], g.c[1], g.c[2]);
      const parts = [];
      for (const b of g.boxes) parts.push(mbBoxPart(b));
      for (const s2 of (g.balls || [])) parts.push(mbSpherePart(s2.pos, s2.r));
      spinGroups.push({ g, grp, parts, red: !!g.red });
      continue;
    }
    if (g.kind === 'sweep') marbleParts.push(mbSweepPart(g));
    else if (g.kind === 'lathe') marbleParts.push(mbLathePart(g));
    else if (g.kind === 'boxes') {
      for (const b of g.boxes) (g.gate ? gateParts : (b.role === 'bumper' ? redParts : marbleParts)).push(mbBoxPart(b));
      for (const s2 of g.balls) redParts.push(mbSpherePart(s2.pos, s2.r));
    } else if (g.kind === 'tray') for (const b of g.boxes) trayParts.push(mbBoxPart(b));
  }
  const tg = { trackId: track.id, marbleTex, marbleMat, trackMesh: null, redMesh: null, gateMesh: null, trayGroup: null, decor: null, spinners: [] };
  for (const sp of spinGroups) {
    const m = new THREE.Mesh(mbMergeParts(sp.parts), sp.red ? mats.red : marbleMat);
    m.castShadow = true; m.receiveShadow = true;
    sp.grp.add(m); scene.add(sp.grp);
    tg.spinners.push({ id: sp.g.id, grp: sp.grp, axis: sp.g.axis || [0, 1, 0], c: sp.g.c, up: (sp.g.lift && sp.g.lift.up) || [0, 1, 0], lift: !!sp.g.lift });
  }
  if (marbleParts.length) {
    tg.trackMesh = new THREE.Mesh(mbMergeParts(marbleParts), marbleMat);
    tg.trackMesh.castShadow = true; tg.trackMesh.receiveShadow = true; tg.trackMesh.frustumCulled = false;
    scene.add(tg.trackMesh);
  }
  if (redParts.length) {
    tg.redMesh = new THREE.Mesh(mbMergeParts(redParts), mats.red);
    tg.redMesh.castShadow = true; tg.redMesh.receiveShadow = true;
    scene.add(tg.redMesh);
  }
  if (gateParts.length) {
    tg.gateMesh = new THREE.Mesh(mbMergeParts(gateParts), marbleMat);
    tg.gateMesh.castShadow = true;
    scene.add(tg.gateMesh);
  }
  if (track.tray) {
    // лоток — група з локальними координатами: обертається навколо hinge як кінематичне тіло
    const tr = track.tray;
    tg.trayGroup = new THREE.Group();
    tg.trayGroup.position.set(tr.hinge[0], tr.hinge[1], tr.hinge[2]);
    const trayMesh = new THREE.Mesh(mbMergeParts(trayParts), marbleMat);
    trayMesh.castShadow = true; trayMesh.receiveShadow = true;
    tg.trayGroup.add(trayMesh);
    scene.add(tg.trayGroup);
  }
  // декор карти (логотипи, LED, шаховки, ферми…) — рендер-only
  tg.decor = new THREE.Group();
  scene.add(tg.decor);
  if (track.map.decor) {
    try {
      track.map.decor(track, { THREE, scene: tg.decor, trayGroup: tg.trayGroup, mats, env: G.env, mergeParts: mbMergeParts, boxPart: mbBoxPart, spherePart: mbSpherePart, texM: MB_TEX_M, textures: { logo: mbLogoTexture, finish: mbFinishTexture, start: mbStartTexture, marble: mbMarbleTexture, cloud: mbCloudTexture } });
    } catch (e) { console.error('[marbles] декор карти ' + track.id + ' впав', e); }
  }
  if (track.zones && track.zones.length) mbZonesGfxBuild(track, tg);
  // хмари під трасою і по центру
  const bb = track.bbox, cloudY = bb.min[1] - 45, cx = (bb.min[0] + bb.max[0]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;
  G.cloudFloor.position.set(cx, cloudY - 30, cz);
  for (const c of G.clouds) c.mesh.position.set(cx, cloudY + c.dy, cz);
  G.tg = tg;
  return tg;
}

// ── Зони на екрані: наліпки на підлозі (батут, прискорювач, желе), лазерні рамки ──
function mbZoneTexture(type) {
  const W = 256, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (type === 'jump') {
    // батут: жовто-чорна рамка + помаранчеве полотно з концентричними кільцями
    g.fillStyle = '#ff7a1a'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,220,120,0.9)'; g.lineWidth = 10;
    for (let r = 30; r < 130; r += 30) { g.beginPath(); g.arc(W / 2, H / 2, r, 0, 6.2832); g.stroke(); }
    for (let k = 0; k < 16; k++) { g.fillStyle = (k & 1) ? '#111' : '#ffd93d'; g.fillRect(k * 16, 0, 16, 18); g.fillRect(k * 16, H - 18, 16, 18); g.fillRect(0, k * 16, 18, 16); g.fillRect(W - 18, k * 16, 18, 16); }
  } else if (type === 'boost') {
    // прискорювач: бірюзові шеврони вздовж руху (u текстури — уздовж траси)
    g.fillStyle = '#062a33'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#21f3ff'; g.strokeStyle = '#bffcff'; g.lineWidth = 4;
    for (let k = 0; k < 2; k++) {
      const x0 = 30 + k * 120;
      g.beginPath(); g.moveTo(x0, 30); g.lineTo(x0 + 70, H / 2); g.lineTo(x0, H - 30); g.lineTo(x0 + 34, H - 30); g.lineTo(x0 + 104, H / 2); g.lineTo(x0 + 34, 30); g.closePath(); g.fill(); g.stroke();
    }
  } else {
    // желе: фіолетові бульбашки
    const gr = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, W * 0.7);
    gr.addColorStop(0, '#c04dff'); gr.addColorStop(1, '#5a1a9a'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let k = 0; k < 40; k++) {
      const x = mbHash(k, 1, 7) * W, y = mbHash(k, 2, 7) * H, r = 6 + mbHash(k, 3, 7) * 16;
      g.fillStyle = 'rgba(240,200,255,0.35)'; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.25, 0, 6.2832); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
  if (type === 'boost') { t.wrapS = THREE.RepeatWrapping; }
  return t;
}
// смуга на підлозі сегмента між sLoc a..b, поперек lat±hw, піднята на lift уздовж нормалі
function mbFloorStrip(seg, a, b, lat, hw, lift, uRep) {
  const F = seg.frames, rows = [];
  for (let i = 0; i < F.length; i++) if (F[i].s >= a - 0.6 && F[i].s <= b + 0.6) rows.push(F[i]);
  if (rows.length < 2) { let i = 0; while (i + 2 < F.length && F[i + 1].s < a) i++; rows.length = 0; rows.push(F[i], F[i + 1]); }
  const n = rows.length, pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), idx = [];
  for (let i = 0; i < n; i++) {
    const f = rows[i], s = mbClamp(f.s, a, b);
    // точка на центрі сегмента з тим самим s (рамки рідкі — інтерполюємо до краю зони)
    const p = f.p, t = (s - f.s);
    for (let j = 0; j < 2; j++) {
      const l = lat + (j ? hw : -hw), k = (i * 2 + j) * 3;
      pos[k] = p[0] + f.t[0] * t + f.r[0] * l + f.u[0] * lift;
      pos[k + 1] = p[1] + f.t[1] * t + f.r[1] * l + f.u[1] * lift;
      pos[k + 2] = p[2] + f.t[2] * t + f.r[2] * l + f.u[2] * lift;
      uv[(i * 2 + j) * 2] = (s - a) / Math.max(0.01, b - a) * (uRep || 1); uv[(i * 2 + j) * 2 + 1] = j;
    }
    if (i) { const q = (i - 1) * 2; idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  return geo;
}
function mbZonesGfxBuild(track, tg) {
  const G = mbG;
  if (!G.zoneMats) {
    G.zoneMats = {
      jump: new THREE.MeshBasicMaterial({ map: mbZoneTexture('jump'), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
      boost: new THREE.MeshBasicMaterial({ map: mbZoneTexture('boost'), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
      slow: new THREE.MeshBasicMaterial({ map: mbZoneTexture('slow'), transparent: true, opacity: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
      post: new THREE.MeshStandardMaterial({ color: '#23232b', roughness: 0.4, metalness: 0.6 }),
      tip: new THREE.MeshBasicMaterial({ color: '#ff2a2a' }),
      beam: new THREE.MeshBasicMaterial({ color: '#ff3030', fog: false }),
      glow: new THREE.MeshBasicMaterial({ color: '#ff2020', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    };
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,80,60,0.9)'); gr.addColorStop(1, 'rgba(255,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    G.zoneMats.zap = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  }
  const M = G.zoneMats, grp = new THREE.Group();
  tg.lasers = [];
  for (const z of track.zones) {
    const o = z.o, half = z.h[0];
    if (z.type === 'laser') {
      // рамка: дві стійки на бортах (за губою), два промені між ними на 0.5 і 1.15 м
      const span = z.h[2] + 1.0, fl = vSub(z.c, vScale(z.y, z.h[1] - 0.05));
      const lg = new THREE.Group();
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...z.x), new THREE.Vector3(...z.y), new THREE.Vector3(...z.z));
      lg.quaternion.setFromRotationMatrix(basis); lg.position.set(fl[0], fl[1], fl[2]);
      for (const sd of [-1, 1]) {
        // стійка помітна й тоді, коли промінь вимкнено: чорна колона з червоною неоновою смугою і «очима» випромінювачів
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.75, 3.6, 0.75), M.post); post.position.set(0, 1.8, sd * span); post.castShadow = true; lg.add(post);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.18, 0.78), M.tip); strip.position.set(0, 3.45, sd * span); lg.add(strip);
        for (const hy of [0.5, 1.15]) { const tp = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), M.tip); tp.position.set(0, hy, sd * (span - 0.4)); lg.add(tp); }
      }
      const beams = new THREE.Group();
      for (const hy of [0.5, 1.15]) {
        const core = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, span * 2 - 0.6, 6), M.beam); core.rotation.x = Math.PI / 2; core.position.y = hy; beams.add(core);
        const gl = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, span * 2 - 0.6, 10, 1, true), M.glow); gl.rotation.x = Math.PI / 2; gl.position.y = hy; beams.add(gl);
      }
      lg.add(beams); grp.add(lg);
      tg.lasers.push({ z, beams });
      continue;
    }
    const geo = mbFloorStrip(z.seg, z.sLoc - half, z.sLoc + half, o.lat || 0, z.h[2], 0.06, z.type === 'boost' ? Math.max(1, Math.round(half * 2 / 2.5)) : 1);
    const m = new THREE.Mesh(geo, M[z.type]); m.renderOrder = 1; m.receiveShadow = false;
    grp.add(m);
  }
  // спалахи «запу»: пул спрайтів
  tg.zapPool = [];
  for (let i = 0; i < 16; i++) { const s = new THREE.Sprite(M.zap.clone()); s.visible = false; grp.add(s); tg.zapPool.push(s); }
  tg.zones = grp;
  G.scene.add(grp);
}
function mbZonesGfxUpdate(st) {
  const tg = mbG && mbG.tg; if (!tg || !tg.zones) return;
  const t = st.raceOn ? st.raceT : 0;
  for (const L of tg.lasers) {
    const s = st.raceOn ? mbLaserState(L.z, t) : 0;
    // попередження — швидке блимання за 0.45 с до ввімкнення
    L.beams.visible = s === 1 || (s === 0.5 && Math.floor(t * 12) % 2 === 0);
  }
  const fx = st.zapFx, pool = tg.zapPool;
  let k = 0;
  for (let i = fx.length - 1; i >= 0 && k < pool.length; i--) {
    const a = (t - fx[i].t) / 0.45;
    if (a < 0 || a > 1) continue;
    const s = pool[k++]; s.visible = true; s.position.set(fx[i].p[0], fx[i].p[1], fx[i].p[2]);
    s.scale.setScalar(0.8 + a * 3.5); s.material.opacity = 1 - a;
  }
  for (; k < pool.length; k++) pool[k].visible = false;
}

function mbSetLowQuality() {
  const G = mbG; if (!G || G.lowQ) return;
  G.lowQ = true;
  G.renderer.shadowMap.enabled = false;
  G.scene.traverse(o => { if (o.material && o.material.isMaterial) o.material.needsUpdate = true; });
  G.renderer.setPixelRatio(1);
  mbGfxResize();
  console.info('[marbles] слабкий GPU: тіні вимкнено, pixelRatio 1');
}

function mbGfxResize() {
  if (!mbG || !mbDom) return;
  const w = mbDom.root.clientWidth || window.innerWidth, h = mbDom.root.clientHeight || window.innerHeight;
  mbG.renderer.setSize(w, h, false);
  mbG.camera.aspect = w / Math.max(1, h);
  mbG.camera.updateProjectionMatrix();
}

// ресурси гонки: кульки (InstancedMesh) + плашки ніків (InstancedMesh білбордів)
function mbRaceGfxBuild(st) {
  mbRaceGfxDispose();
  const G = mbG, N = st.balls.length;
  const balls = new THREE.InstancedMesh(new THREE.SphereGeometry(MB_R, 20, 14), G.mats.ball, N);
  balls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  balls.castShadow = true; balls.receiveShadow = false; balls.frustumCulled = false;
  {
    const col = new THREE.Color(), mono = !G.theme || G.theme.ballColors !== 'rainbow';
    for (let i = 0; i < N; i++) balls.setColorAt(i, mono ? col.setRGB(1, 1, 1) : mbBallColor(i, col));
    balls.instanceColor.needsUpdate = true;
  }
  G.scene.add(balls);
  const atlas = mbLabelAtlas(st.balls.map(b => b.nick));
  const quad = new THREE.PlaneGeometry(1, MB_SLOT_H / MB_SLOT_W);
  quad.translate(0.5, MB_SLOT_H / MB_SLOT_W / 2, 0); // лівий нижній кут — на кульці
  const slot = new Float32Array(N * 2), gold = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = i % 408;
    slot[i * 2] = (s % MB_SLOT_COLS) * MB_SLOT_W / atlas.W;
    slot[i * 2 + 1] = 1 - (Math.floor(s / MB_SLOT_COLS) + 1) * MB_SLOT_H / atlas.H;
  }
  quad.setAttribute('slot', new THREE.InstancedBufferAttribute(slot, 2));
  quad.setAttribute('gold', new THREE.InstancedBufferAttribute(gold, 1).setUsage(THREE.DynamicDrawUsage));
  const labelMat = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    uniforms: { map: { value: atlas.tex }, slotSz: { value: new THREE.Vector2(MB_SLOT_W / atlas.W, MB_SLOT_H / atlas.H) }, k: { value: 0.1 }, goldCol: { value: new THREE.Color(MB_C_GOLD) }, fade: { value: new THREE.Vector2(95, 170) } },
    // gold: 1 — лідер (золота, завжди видно), 0 — звичайна, -1 — схована (кулька зникла).
    // Далекі плашки блякнуть: у пелетоні на 150+ кульок вони зливались у сіру хмару
    vertexShader: [
      'attribute vec2 slot; attribute float gold; uniform vec2 slotSz; uniform float k; uniform vec2 fade;',
      'varying vec2 vUv; varying float vGold; varying float vA;',
      'void main(){ vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0); float d = max(1.0, -mv.z);',
      '  vGold = max(gold, 0.0); vA = gold > 0.5 ? 1.0 : 1.0 - smoothstep(fade.x, fade.y, d);',
      '  if (gold < -0.5 || vA < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); return; }',
      '  mv.xy += position.xy * d * k; gl_Position = projectionMatrix * mv; vUv = slot + uv * slotSz; }',
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D map; uniform vec3 goldCol; varying vec2 vUv; varying float vGold; varying float vA;',
      'void main(){ vec4 c = texture2D(map, vUv); c.a *= vA; if (c.a < 0.03) discard; c.rgb *= mix(vec3(1.0), goldCol, vGold); gl_FragColor = c; }',
    ].join('\n'),
  });
  const labels = new THREE.InstancedMesh(quad, labelMat, N);
  labels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  labels.frustumCulled = false; labels.renderOrder = 10;
  G.scene.add(labels);
  mbRace = { balls, labels, atlasTex: atlas.tex, labelMat, quad, goldAttr: quad.getAttribute('gold'), N, leaderIdx: -1 };
  // індекс кульки за ніком — для золотої плашки лідера
  mbRace.idxByNick = new Map(st.balls.map((b, i) => [b.nick, i]));
}
function mbRaceGfxDispose() {
  if (!mbRace || !mbG) { mbRace = null; return; }
  const r = mbRace;
  mbG.scene.remove(r.balls); mbG.scene.remove(r.labels);
  r.balls.geometry.dispose(); r.quad.dispose(); r.atlasTex.dispose(); r.labelMat.dispose();
  mbRace = null;
}

// ═════════════════════════════════════════════════════════════
//  КАМЕРИ: режисура (лоток → за лідером → фініш → обліт чаші) і політ
// ═════════════════════════════════════════════════════════════
const mbV = { a: null, b: null, c: null, d: null };
function mbVec() { return new THREE.Vector3(); }

// точка інтро-камери: карта може задати map.intro(track, pos, look); інакше —
// позаду стартових слотів з видом уперед по трасі
function mbIntroCam(track, pos, look) {
  if (track.map.intro && track.map.intro(track, pos, look) !== false) return;
  let c;
  if (track.tray) { const H = track.tray.hinge, L = track.tray.L; c = [H[0] - L / 2, H[1], H[2]]; }
  else { const sl = track.startSlots; c = [0, 0, 0]; for (const p of sl) { c[0] += p[0] / sl.length; c[1] += p[1] / sl.length; c[2] += p[2] / sl.length; } }
  const f = mbCenterAt(track, 25), d = [f[0] - c[0], 0, f[2] - c[2]], L = Math.hypot(d[0], d[2]) || 1;
  pos.set(c[0] - d[0] / L * 40 - d[2] / L * 26, c[1] + 26, c[2] - d[2] / L * 40 + d[0] / L * 26);
  look.set(c[0] + d[0] / L * 12, c[1] - 3, c[2] + d[2] / L * 12);
}

// режисура за лідером: карта може перехопити (map.camera → true), інакше —
// точка центральної лінії за 34 м позаду, +19 м угору, погляд трохи вперед
function mbAutoCamTarget(st, leader, pos, look) {
  const track = st.track;
  const s = leader.prog;
  const lp = [leader.x, leader.y, leader.z];
  const back = mbCenterAt(track, Math.max(0, s - 34), lp);
  const fwd = mbCenterAt(track, s + 10, lp);
  let dx = leader.x - back[0], dz = leader.z - back[2];
  let hl = Math.hypot(dx, dz) || 1;
  // складена траса (зигзаг): точка позаду по дузі в плані поруч — відсуваємо камеру, щоб не сидіти на кульках
  const minD = 24; let bx = back[0], bz = back[2];
  if (hl < minD) { bx = leader.x - dx / hl * minD; bz = leader.z - dz / hl * minD; dx = leader.x - bx; dz = leader.z - bz; hl = minD; }
  // камера трохи збоку від лінії руху, щоб бачити пелетон і жолоб попереду;
  // висота — і над точкою позаду, і над лідером (спіралі/петлі: позаду може бути нижче)
  pos.set(bx - dx / hl * 4 + dz / hl * 6, Math.max(back[1] + 19, leader.y + 13), bz - dz / hl * 4 - dx / hl * 6);
  mbCamAboveDisc(track, pos);
  look.set(fwd[0] * 0.5 + leader.x * 0.5, leader.y - 2, fwd[2] * 0.5 + leader.z * 0.5);
}
// тарілка-лійка (track.disc) — суцільна: камера над нею або далеко збоку, не під нею
// (точка «позаду по трасі» біля горла давала камеру під дном тарілки)
function mbCamAboveDisc(track, pos) {
  const d = track.disc; if (!d) return;
  if (Math.hypot(pos.x - d.c[0], pos.z - d.c[2]) < d.rDisc + 12 && pos.y < d.c[1] + d.yRim + 22) pos.y = d.c[1] + d.yRim + 22;
}
// ── Режисер «прямого ефіру»: план 4–9 с, потім склейка на інший ──────────
// Пріоритет: спецплан карти на її секції (map.camera → true, підібрано під
// перекриття трасою) → камера на фініші, коли лідер на підході → «бій за
// лідерство», коли двоє поруч → чергування загальних планів. Кожен план перед
// склейкою перевіряється на перекриття: відрізок камера→ціль не має проходити
// поруч з іншою ділянкою траси (центральна лінія ± ширина жолоба)
const MB_SHOT_W = { wide: 3, chase: 3, side: 2, top: 1.4, pack: 1.6 };
const MB_SHOT_DUR = { wide: [6, 9], chase: [5, 8], side: [4, 6], top: [4, 6], pack: [5, 7], battle: [4, 6] };
const MB_FIN_CAM = 42;     // м до фінішу — склейка на камеру фінішу
const MB_BATTLE_GAP = 2.2; // м між першим і другим — «бій за лідерство»
// чи перекриває траса відрізок a→b (окрім ділянки біля цілі: |s − sT| < skip)
function mbOccluded(track, a, b, sT, skip) {
  const dsc = track.disc;
  if (dsc) {
    // відрізок проходить крізь «шайбу» тарілки (від горла до обідка)?
    for (let k = 1; k < 8; k++) {
      const t = k / 8, px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t, pz = a[2] + (b[2] - a[2]) * t;
      if (py > dsc.c[1] + dsc.yThroat && py < dsc.c[1] + dsc.yRim + 2 && Math.hypot(px - dsc.c[0], pz - dsc.c[2]) < dsc.rDisc + 1) return true;
    }
  }
  const cl = track.cl, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], uu = ux * ux + uy * uy + uz * uz;
  for (let i = 0; i < cl.length; i += 2) {
    const c = cl[i];
    if (Math.abs(c.s0 - sT) < skip) continue;
    // найближчі точки двох відрізків (камера→ціль і шматок осі траси)
    const vx = c.d[0], vy = c.d[1], vz = c.d[2], wx = a[0] - c.a[0], wy = a[1] - c.a[1], wz = a[2] - c.a[2];
    const bb = ux * vx + uy * vy + uz * vz, cc = c.L2, dd = ux * wx + uy * wy + uz * wz, ee = vx * wx + vy * wy + vz * wz;
    const den = uu * cc - bb * bb;
    let sc = den > 1e-9 ? (bb * ee - cc * dd) / den : 0; sc = sc < 0 ? 0 : (sc > 1 ? 1 : sc);
    let tc = (ee + bb * sc) / cc; tc = tc < 0 ? 0 : (tc > 1 ? 1 : tc);
    sc = (bb * tc - dd) / uu; sc = sc < 0 ? 0 : (sc > 1 ? 1 : sc);
    if (sc > 0.97) continue; // сама ціль
    const px = wx + ux * sc - vx * tc, py = wy + uy * sc - vy * tc, pz = wz + uz * sc - vz * tc;
    if (px * px + py * py + pz * pz < 12) return true;
  }
  return false;
}
// напрям траси в плані біля прогресу s (одиничний [x, z])
function mbDirAt(track, s, near) {
  const a = mbCenterAt(track, Math.max(0, s - 4), near), b = mbCenterAt(track, s + 4, near);
  const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz);
  if (L < 0.5) return [1, 0];
  return [dx / L, dz / L];
}
// загальний план за кулькою b
function mbShotTarget(shot, st, b, sorted, pos, look, D) {
  const track = st.track, s = b.prog, lp = [b.x, b.y, b.z];
  const d = mbDirAt(track, s, lp), nx = -d[1], nz = d[0];
  if (shot === 'chase') {
    const back = mbCenterAt(track, Math.max(0, s - 15), lp), f = mbCenterAt(track, s + 9, lp);
    pos.set(back[0] - d[0] * 3 + nx * 3, Math.max(back[1] + 10, b.y + 9), back[2] - d[1] * 3 + nz * 3);
    look.set(f[0] * 0.4 + b.x * 0.6, b.y - 0.5, f[2] * 0.4 + b.z * 0.6);
  } else if (shot === 'side') {
    const sd = D.side || 1;
    pos.set(b.x + nx * 19 * sd - d[0] * 2, b.y + 13, b.z + nz * 19 * sd - d[1] * 2);
    look.set(b.x + d[0] * 4, b.y - 0.5, b.z + d[1] * 4);
  } else if (shot === 'top') {
    pos.set(b.x - d[0] * 7, b.y + 36, b.z - d[1] * 7);
    look.set(b.x + d[0] * 5, b.y, b.z + d[1] * 5);
  } else if (shot === 'battle') {
    const a2 = sorted[1] || b, my = (b.y + a2.y) / 2;
    const back = mbCenterAt(track, Math.max(0, s - 13), lp);
    pos.set(back[0] + nx * 3, Math.max(back[1] + 9, my + 8), back[2] + nz * 3);
    look.set((b.x + a2.x) / 2 + d[0] * 3, my - 0.3, (b.z + a2.z) / 2 + d[1] * 3);
  } else { mbAutoCamTarget(st, b, pos, look); return; } // 'wide' і 'pack' — загальний план позаду й згори
  mbCamAboveDisc(track, pos);
}
// камера на фініші: за чашею, дивиться назустріч кулькам, що підлітають
function mbFinishCam(track, pos, look) {
  const fin = track.finish, inc = mbCenterAt(track, track.pathLen - 26);
  let dx = fin.p[0] - inc[0], dz = fin.p[2] - inc[2]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  pos.set(fin.p[0] + dx * 15 - dz * 7, fin.p[1] + 11, fin.p[2] + dz * 15 + dx * 7);
  look.set(inc[0] * 0.6 + fin.p[0] * 0.4, inc[1] * 0.6 + fin.p[1] * 0.4, inc[2] * 0.6 + fin.p[2] * 0.4);
}
// хто в кадрі: на «пелетоні» — кулька на 30% поля, інакше лідер
function mbShotSubject(shot, sorted) { return (shot === 'pack' && sorted.length > 10) ? sorted[Math.floor(sorted.length * 0.3)] : sorted[0]; }
const mbDirTmp = { p: null };
// повертає true, якщо щойно була склейка (камера переходить жорстко)
function mbDirector(st, dt, sorted, pos, look) {
  const G = mbG, track = st.track, leader = sorted[0];
  const D = G.dir || (G.dir = { shot: '', t: 0, dur: 0, side: 1, occT: 0, last: '' });
  D.t += dt;
  let cut = false;
  const setShot = (id, dur) => { if (D.shot !== id) { D.last = D.shot; D.shot = id; cut = true; } D.t = 0; D.occT = 0; D.dur = dur || 0; };
  // 1) спецплан карти на її секції
  if (track.map.camera && track.map.camera(st, leader, pos, look, mbCenterAt)) { if (D.shot !== 'map') setShot('map'); return cut; }
  // 2) лідер на підході до фінішу
  if (!st.winner && track.pathLen - leader.prog < MB_FIN_CAM) { if (D.shot !== 'finish') setShot('finish'); mbFinishCam(track, pos, look); return cut; }
  // 3) склейка: план вичерпано, щойно вийшли зі спецплану, або почався бій за лідерство
  const battle = sorted.length > 1 && leader.prog - sorted[1].prog < MB_BATTLE_GAP && st.raceT > 8;
  const generic = D.shot !== 'map' && D.shot !== 'finish' && D.shot !== '';
  if (!generic || D.t > D.dur || (battle && D.shot !== 'battle' && D.last !== 'battle' && D.t > 2.5)) {
    const pick = [];
    if (battle && D.shot !== 'battle') pick.push('battle');
    const pool = Object.keys(MB_SHOT_W).filter(k => k !== D.shot && (k !== 'pack' || sorted.length > 10));
    while (pool.length) {
      let tot = 0; for (const k of pool) tot += MB_SHOT_W[k];
      let r = Math.random() * tot, k = 0;
      while (k < pool.length - 1 && (r -= MB_SHOT_W[pool[k]]) > 0) k++;
      pick.push(pool.splice(k, 1)[0]);
    }
    const P = mbDirTmp.p || (mbDirTmp.p = new THREE.Vector3()), L = new THREE.Vector3();
    let chosen = 'wide';
    for (const id of pick) {
      const b = mbShotSubject(id, sorted);
      D.side = Math.random() < 0.5 ? 1 : -1;
      let ok = false;
      for (let tr = 0; tr < (id === 'side' ? 2 : 1) && !ok; tr++) {
        if (tr) D.side = -D.side;
        mbShotTarget(id, st, b, sorted, P, L, D);
        ok = id === 'wide' || !mbOccluded(track, [P.x, P.y, P.z], [b.x, b.y, b.z], b.prog, 14);
      }
      if (ok) { chosen = id; break; }
    }
    const r = MB_SHOT_DUR[chosen];
    setShot(chosen, r[0] + Math.random() * (r[1] - r[0]));
  }
  const b = mbShotSubject(D.shot, sorted);
  mbShotTarget(D.shot, st, b, sorted, pos, look, D);
  // перекриття посеред плану (траса пройшла між камерою й кулькою) — склейка на загальний
  D.occAcc = (D.occAcc || 0) + dt;
  if (D.occAcc >= 0.33 && D.shot !== 'wide' && D.shot !== 'pack') {
    D.occAcc = 0;
    if (mbOccluded(track, [pos.x, pos.y, pos.z], [b.x, b.y, b.z], b.prog, 14)) D.occT += 0.33; else D.occT = 0;
    if (D.occT > 0.6) { setShot('wide', 6); mbShotTarget('wide', st, leader, sorted, pos, look, D); }
  }
  return cut;
}

function mbUpdateCamera(st, dt, sorted) {
  const G = mbG, cam = G.camera, track = st.track;
  if (G.fly.on) { mbFlyUpdate(dt, track); return; }
  const tp = mbV.a || (mbV.a = mbVec()), tl = mbV.b || (mbV.b = mbVec());
  let hard = false, kPos = 1 - Math.exp(-dt / 0.7), kLook = 1 - Math.exp(-dt / 0.3);
  const leader = sorted[0] || null;
  const fin = track.finish;
  const oc = track.extra.orbit || [fin.p[0] + fin.f[0] * 12, fin.p[1], fin.p[2] + fin.f[2] * 12];
  if (st.phase === 'intro' || st.phase === 'countdown') {
    mbIntroCam(track, tp, tl); hard = !G.camInit;
    kPos = 1 - Math.exp(-dt / 2.5);
  } else if (st.podShown || st.done) {
    // повільний обліт чаші після подіуму
    G.orbitT += dt * 0.12;
    tp.set(oc[0] + Math.cos(G.orbitT) * 38, oc[1] + 22, oc[2] + Math.sin(G.orbitT) * 38);
    tl.set(oc[0], oc[1] + 1, oc[2]);
    kPos = 1 - Math.exp(-dt / 1.2);
  } else if (st.finishZoom > 0 && st.winner) {
    st.finishZoom -= dt;
    tp.set(fin.p[0] - 22, fin.p[1] + 14, fin.p[2] - 14);
    tl.set(fin.p[0] + 8, fin.p[1] - 1, fin.p[2]);
    kPos = 1 - Math.exp(-dt / 0.45);
  } else if (leader) {
    // склейка — жорсткий перехід, як у трансляції; усередині плану — мʼякий супровід
    if (mbDirector(st, dt, sorted, tp, tl)) hard = true;
    const sh = G.dir.shot;
    if (sh === 'side' || sh === 'top' || sh === 'battle' || sh === 'chase') { kPos = 1 - Math.exp(-dt / 0.35); kLook = 1 - Math.exp(-dt / 0.18); }
  } else {
    tp.set(fin.p[0] - 22, fin.p[1] + 14, fin.p[2] - 14); tl.set(fin.p[0] + 8, fin.p[1] - 1, fin.p[2]);
  }
  if (hard || !G.camInit) { G.camPos.copy(tp); G.camLook.copy(tl); G.camInit = true; }
  else { G.camPos.lerp(tp, kPos); G.camLook.lerp(tl, kLook); }
  cam.position.copy(G.camPos);
  cam.lookAt(G.camLook);
  G.focus.copy(G.camLook);
}

// ── Політ (як у PUBG-режимі shootout.js): WASD, Space/C, Shift, колесо, pointer lock ──
const MB_FLY_PITCH_MAX = 1.45;
function mbFlyStart() {
  const G = mbG; if (!G) return;
  const f = G.fly, cam = G.camera;
  f.px = cam.position.x; f.py = cam.position.y; f.pz = cam.position.z;
  const d = mbV.c || (mbV.c = mbVec());
  d.subVectors(G.camLook, cam.position);
  f.yaw = Math.atan2(d.z, d.x);
  f.pitch = mbClamp(Math.atan2(d.y, Math.hypot(d.x, d.z) || 1e-4), -MB_FLY_PITCH_MAX, MB_FLY_PITCH_MAX);
  f.vx = f.vy = f.vz = 0; f.speedMul = 1; f.drag = false;
  f.kW = f.kA = f.kS = f.kD = f.kUp = f.kDn = f.kBoost = false;
  f.on = true;
  mbFlyLock();
  mbFlyHint(true);
  if (mbDom.flyBtn) mbDom.flyBtn.classList.add('mb-on');
}
function mbFlyStop() {
  const G = mbG; if (!G) return;
  G.fly.on = false; G.fly.drag = false;
  // мишу віддаємо безумовно — захоплений курсор не має пережити режим
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) { /* не наш lock */ } }
  mbFlyHint(false);
  if (mbDom.flyBtn) mbDom.flyBtn.classList.remove('mb-on');
  G.camInit = false; // авто-камера стартує з поточної точки без ривка: беремо позицію польоту
  G.camPos.copy(G.camera.position); G.camLook.copy(G.camera.position).add(mbFlyDir(mbV.d || (mbV.d = mbVec())).multiplyScalar(20)); G.camInit = true;
}
function mbFlyLock() {
  const cv = mbDom && mbDom.cvs;
  if (!cv || document.pointerLockElement === cv) return;
  try { const r = cv.requestPointerLock(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (e) { /* фолбек — drag-look */ }
}
let mbFlyHintTimer = 0;
function mbFlyHint(show) {
  const el = mbDom && mbDom.flyHint; if (!el) return;
  if (mbFlyHintTimer) { clearTimeout(mbFlyHintTimer); mbFlyHintTimer = 0; }
  el.classList.toggle('show', !!show);
  if (show) mbFlyHintTimer = setTimeout(() => { el.classList.remove('show'); mbFlyHintTimer = 0; }, 4000);
}
function mbFlyDir(out) {
  const f = mbG.fly, cp = Math.cos(f.pitch);
  return out.set(cp * Math.cos(f.yaw), Math.sin(f.pitch), cp * Math.sin(f.yaw));
}
function mbFlyLook(mx, my) {
  const f = mbG.fly;
  mbFlyHint(false);
  f.yaw += mx * 0.0022;
  f.pitch = mbClamp(f.pitch - my * 0.0022, -MB_FLY_PITCH_MAX, MB_FLY_PITCH_MAX);
}
function mbFlyKey(code, down) {
  const f = mbG.fly; let took = true;
  switch (code) {
    case 'KeyW': f.kW = down; break;
    case 'KeyA': f.kA = down; break;
    case 'KeyS': f.kS = down; break;
    case 'KeyD': f.kD = down; break;
    case 'Space': f.kUp = down; break;
    case 'KeyC': case 'ControlLeft': case 'ControlRight': f.kDn = down; break;
    case 'ShiftLeft': case 'ShiftRight': f.kBoost = down; break;
    default: took = false;
  }
  if (took && down) mbFlyHint(false);
  return took;
}
// найнижча дозволена висота: полотно поруч (найближча точка центральної лінії в плані) − 2
function mbFloorNear(track, x, z) {
  const cl = track.cl; let best = 1e18, y = track.bbox.min[1];
  for (let i = 0; i < cl.length; i++) {
    const c = cl[i], mx = c.a[0] + c.d[0] * 0.5, mz = c.a[2] + c.d[2] * 0.5;
    const d2 = (x - mx) * (x - mx) + (z - mz) * (z - mz);
    if (d2 < best) { best = d2; y = c.a[1] + c.d[1] * 0.5; }
  }
  return y;
}
function mbFlyUpdate(dt, track) {
  const G = mbG, f = G.fly;
  const spd = 45 * f.speedMul * (f.kBoost ? 2.6 : 1);
  const cp = Math.cos(f.pitch), sp = Math.sin(f.pitch), cy = Math.cos(f.yaw), sy = Math.sin(f.yaw);
  let tx = 0, ty = 0, tz = 0;
  if (f.kW) { tx += cp * cy; ty += sp; tz += cp * sy; }
  if (f.kS) { tx -= cp * cy; ty -= sp; tz -= cp * sy; }
  if (f.kA) { tx += sy; tz -= cy; }
  if (f.kD) { tx -= sy; tz += cy; }
  if (f.kUp) ty += 1;
  if (f.kDn) ty -= 1;
  const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const s = len > 1e-4 ? spd / len : 0;
  const k = 1 - Math.exp(-dt * 8);
  f.vx += (tx * s - f.vx) * k; f.vy += (ty * s - f.vy) * k; f.vz += (tz * s - f.vz) * k;
  f.px += f.vx * dt; f.py += f.vy * dt; f.pz += f.vz * dt;
  const bb = track.bbox, M = 120;
  f.px = mbClamp(f.px, bb.min[0] - M, bb.max[0] + M);
  f.pz = mbClamp(f.pz, bb.min[2] - M, bb.max[2] + M);
  f.py = mbClamp(f.py, mbFloorNear(track, f.px, f.pz) - 2, bb.max[1] + 160);
  const cam = G.camera;
  cam.position.set(f.px, f.py, f.pz);
  const d = mbFlyDir(mbV.c || (mbV.c = mbVec()));
  cam.lookAt(f.px + d.x, f.py + d.y, f.pz + d.z);
  G.focus.set(f.px + d.x * 30, f.py + d.y * 30, f.pz + d.z * 30);
}
function mbToggleFly() { if (!mbG || !mbSt) return; if (mbG.fly.on) mbFlyStop(); else mbFlyStart(); }
function mbAutoCam() { if (mbG && mbG.fly.on) mbFlyStop(); }

let mbInputBound = false;
function mbBindInput() {
  if (mbInputBound) return;
  mbInputBound = true;
  const vis = () => mbDom && mbDom.root.classList.contains('visible') && mbG;
  window.addEventListener('keydown', e => {
    if (!vis() || !mbG.fly.on) return;
    if (mbFlyKey(e.code, true)) e.preventDefault();
  });
  window.addEventListener('keyup', e => { if (vis() && mbG.fly.on) mbFlyKey(e.code, false); });
  const cv = mbDom.cvs;
  cv.addEventListener('mousedown', e => {
    if (!vis() || !mbG.fly.on) return;
    if (document.pointerLockElement !== cv) mbFlyLock();
    mbG.fly.drag = true; mbG.fly.lastX = e.clientX; mbG.fly.lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { if (mbG) mbG.fly.drag = false; });
  window.addEventListener('mousemove', e => {
    if (!vis() || !mbG.fly.on) return;
    if (document.pointerLockElement === cv) mbFlyLook(e.movementX || 0, e.movementY || 0);
    else if (mbG.fly.drag) { mbFlyLook(e.clientX - mbG.fly.lastX, e.clientY - mbG.fly.lastY); mbG.fly.lastX = e.clientX; mbG.fly.lastY = e.clientY; }
  });
  cv.addEventListener('wheel', e => {
    if (!vis() || !mbG.fly.on) return;
    e.preventDefault();
    mbG.fly.speedMul = mbClamp(mbG.fly.speedMul * Math.pow(1.15, -e.deltaY / 100), 0.15, 8);
    mbFlyHint(false);
  }, { passive: false });
  window.addEventListener('resize', () => { if (vis()) mbGfxResize(); });
}

// ═════════════════════════════════════════════════════════════
//  HUD: пігулка «Марблс | ⚪ N/N | ⏱ mm:ss.mmm», червоний відлік, лідерборд 1-10
// ═════════════════════════════════════════════════════════════
function mbFmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
}
const MB_ROW_H = 36;
const mbRows = new Map(); // nick → елемент плашки
function mbBoardReset() { mbRows.clear(); if (mbDom && mbDom.board) mbDom.board.innerHTML = ''; }
// повний рейтинг: спершу фінішери (порядок фінішу), далі активні за прогресом
function mbRanking(st, sorted) {
  const arr = [];
  for (let i = 0; i < st.finishOrder.length; i++) arr.push({ nick: st.finishOrder[i], fin: true });
  for (let i = 0; i < sorted.length; i++) arr.push({ nick: sorted[i].nick, fin: false });
  for (let i = st.eliminated.length - 1; i >= 0; i--) arr.push({ nick: st.eliminated[i], fin: false, dead: true });
  return arr;
}
function mbBoardUpdate(st, ranking) {
  const board = mbDom.board;
  const top = ranking.slice(0, 10);
  const seen = new Set();
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    seen.add(r.nick);
    let row = mbRows.get(r.nick);
    if (!row) {
      row = document.createElement('div');
      row.className = 'mb-row mb-enter';
      row.innerHTML = '<span class="mb-place"></span><span class="mb-nick"></span>';
      row.querySelector('.mb-nick').textContent = r.nick; // textContent — ніки не інжектяться в HTML
      row.style.transform = 'translateY(' + i * MB_ROW_H + 'px)';
      board.appendChild(row);
      mbRows.set(r.nick, row);
      void row.offsetWidth; // reflow: інакше fade-in злипається з появою
      row.classList.remove('mb-enter');
    }
    row.style.transform = 'translateY(' + i * MB_ROW_H + 'px)';
    row.querySelector('.mb-place').textContent = r.dead ? '💀' : (r.fin ? '✓' : String(i + 1));
    row.classList.toggle('mb-fin', !!r.fin);
    row.classList.toggle('mb-dead', !!r.dead);
    row.classList.remove('mb-exit');
  }
  mbRows.forEach((row, nick) => {
    if (seen.has(nick) || row.classList.contains('mb-exit')) return;
    row.classList.add('mb-exit');
    setTimeout(() => {
      // за 300мс плашка могла повернутись у топ-10 — тоді клас уже знято
      if (row.classList.contains('mb-exit')) { row.remove(); mbRows.delete(nick); }
    }, 320);
  });
}

// ── Подіум топ-3: 3 секунди слави ДО загальної заставки ──────
function mbShowPodium(st) {
  if (!mbDom) return;
  const medals = ['🥇', '🥈', '🥉'];
  const labels = ['1 место', '2 место', '3 место'];
  const top = st.finishOrder.slice(0, Math.min(3, st.balls.length));
  // золото в центрі, срібло зліва, бронза справа — класика подіуму
  const order = top.length >= 3 ? [1, 0, 2] : (top.length === 2 ? [1, 0] : [0]);
  let html = '';
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    html += '<div class="mb-pod-card mb-pod-' + (i + 1) + '">' +
      '<div class="mb-pod-medal">' + medals[i] + '</div>' +
      '<div class="mb-pod-ball"></div>' +
      '<div class="mb-pod-nick"></div>' +
      '<div class="mb-pod-place">' + labels[i] + '</div></div>';
  }
  mbDom.podium.innerHTML = html;
  const nickEls = mbDom.podium.querySelectorAll('.mb-pod-nick');
  for (let k = 0; k < order.length; k++) nickEls[k].textContent = String(top[order[k]]);
  mbDom.podium.classList.add('visible');
  if (mbPodTimer) clearTimeout(mbPodTimer);
  mbPodTimer = setTimeout(() => {
    mbPodTimer = 0;
    mbHidePodium();
    mbAnnounceWinner(st);
  }, 3000);
}
function mbHidePodium() { if (mbDom) mbDom.podium.classList.remove('visible'); }
// загальна заставка переможця (addWinner) — рівно один раз на гонку
function mbAnnounceWinner(st) {
  if (!st || !st.winner || st.winnerAnnounced) return;
  st.winnerAnnounced = true;
  if (typeof addWinner === 'function') addWinner(st.winner);
}

// ═════════════════════════════════════════════════════════════
//  ПУБЛІЧНИЙ КОНТРАКТ
// ═════════════════════════════════════════════════════════════
async function startMarblesGame() {
  if (!mbEnsureDom()) return;
  const list = (typeof state !== 'undefined' && Array.isArray(state.participants)) ? state.participants.slice() : [];
  if (list.length < 2) return alert('Нужно минимум 2 участника');
  mbBaseList = list;
  if (typeof phase !== 'undefined') phase = 'racing';
  mbDom.root.classList.add('visible');
  mbDom.controls.style.display = 'none';
  mbSetCount('…');
  // Rapier (WASM) вантажиться один раз — далі проміс закешовано
  try {
    await mbInitPhysics();
  } catch (e) {
    console.error('[marbles] Rapier не завантажився', e);
    alert('Марблс: не вдалося завантажить фізику (vendor/rapier3d-compat.mjs)');
    closeMarblesOverlay();
    return;
  }
  if (typeof THREE === 'undefined') { alert('Марблс: three.js не завантажився'); closeMarblesOverlay(); return; }
  if (!mbDom.root.classList.contains('visible')) return; // закрили, поки чекали
  const mapId = await mbPickMap();
  if (!mapId || !mbDom.root.classList.contains('visible')) return;
  // стартовий порядок — перестановка random.org з доказом (кнопка перевірки
  // на заставці переможця працює сама через lastRollProof в app.js)
  mbSetCount('…');
  const order = await rollPick(list, list.length, 'Марблс: стартовый порядок ' + list.length + ' шариков');
  if (!mbDom.root.classList.contains('visible')) return;
  mbStartRace(order, mapId);
}

// ── Вибір карти: картки з іконкою, назвою, орієнтовним часом і описом + «Случайная» ──
let mbPickResolve = null;
function mbFmtApprox(sec) { const m = Math.floor(sec / 60), s2 = Math.round(sec % 60); return m + ':' + (s2 < 10 ? '0' : '') + s2; }
function mbPickMap() {
  return new Promise(resolve => {
    const ids = mbMapIds();
    if (!ids.length) { resolve(null); return; }
    if (mbPickResolve) mbPickResolve(null);
    mbPickResolve = resolve;
    mbSetCount('');
    const cards = mbDom.pickerCards; cards.innerHTML = '';
    let last = null; try { last = localStorage.getItem('mb_map'); } catch (e) { /* приватний режим */ }
    for (const id of ids) {
      const m = mbMapDef(id);
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'mb-card' + (id === last ? ' mb-card-last' : '');
      el.innerHTML = '<div class="mb-card-ico"></div><div class="mb-card-name"></div><div class="mb-card-time"></div><div class="mb-card-desc"></div>';
      el.querySelector('.mb-card-ico').textContent = m.icon || '🔮';
      el.querySelector('.mb-card-name').textContent = m.name || id;
      el.querySelector('.mb-card-time').textContent = '⏱ ≈ ' + mbFmtApprox(m.approxSec || 120) + (m.allSec ? ' · все ≈ ' + mbFmtApprox(m.allSec) : '');
      el.querySelector('.mb-card-desc').textContent = m.desc || '';
      el.onclick = () => mbChooseMap(id);
      cards.appendChild(el);
    }
    const rnd = document.createElement('button');
    rnd.type = 'button'; rnd.className = 'mb-card mb-card-rnd';
    rnd.innerHTML = '<div class="mb-card-ico">🎲</div><div class="mb-card-name">Случайная</div><div class="mb-card-time">карту выберет жребий</div>';
    rnd.onclick = () => mbChooseMap(ids[Math.floor(Math.random() * ids.length)]);
    cards.appendChild(rnd);
    mbDom.picker.style.display = 'flex';
  });
}
function mbChooseMap(id) {
  if (mbDom) mbDom.picker.style.display = 'none';
  try { localStorage.setItem('mb_map', id); } catch (e) { /* приватний режим */ }
  const r = mbPickResolve; mbPickResolve = null;
  if (r) r(id);
}
// «Другая карта» після фінішу: знову пікер, потім новий ролл
async function mbChangeMap() {
  if (!mbEnsureDom() || !mbBaseList.length) return;
  mbDom.controls.style.display = 'none';
  const mapId = await mbPickMap();
  if (!mapId || !mbDom.root.classList.contains('visible')) return;
  mbSetCount('…');
  const order = await rollPick(mbBaseList, mbBaseList.length, 'Марблс: стартовый порядок ' + mbBaseList.length + ' шариков');
  if (!mbDom.root.classList.contains('visible')) return;
  mbStartRace(order, mapId);
}

function mbStartRace(order, mapId) {
  if (mbSt) mbFreeSim(mbSt);
  mbCurMapId = mbMapDef(mapId).id;
  const track = mbTrack(mbCurMapId);
  mbGfxInit();
  mbGfxResize();
  mbTrackGfxBuild(track);
  if (mbDom.pillName) mbDom.pillName.textContent = '🔮 ' + (track.map.name || 'Марблс');
  mbSt = mbCreateSim(order, { map: mbCurMapId });
  mbSt.phase = 'intro';
  mbSt.introT = 0;
  mbSt.cdT = 0;
  mbSt.podShown = false;
  mbSt.winnerAnnounced = false;
  mbSt.finishZoom = 0;
  // переможець відомий одразу, але заставка — після подіуму; зараз лише наїзд на фініш
  mbSt.onWinner = () => { mbSt.finishZoom = 2.0; };
  mbSt.onDone = () => {
    window.mbLastResults = mbFinalOrder(mbSt).slice(0, 10);
    mbShowControls();
  };
  window.mbLastResults = null;
  mbRaceGfxBuild(mbSt);
  mbG.camInit = false; mbG.orbitT = 0; mbG.dir = null;
  if (mbG.fly.on) mbFlyStop();
  mbBoardAcc = 1; // перше оновлення лідерборду — одразу
  mbBoardReset();
  mbHidePodium();
  if (mbPodTimer) { clearTimeout(mbPodTimer); mbPodTimer = 0; }
  mbSetCount('');
  mbHudReset(order.length);
  if (mbGoTimer) { clearTimeout(mbGoTimer); mbGoTimer = 0; }
  if (!mbRaf) {
    mbLastTs = performance.now();
    mbAcc = 0;
    mbRaf = requestAnimationFrame(mbLoop);
  }
}
function mbHudReset(n) {
  if (!mbDom) return;
  if (mbDom.timer) mbDom.timer.textContent = '00:00.000';
  if (mbDom.alive) mbDom.alive.textContent = n + '/' + n;
  if (mbDom.cd) mbDom.cd.style.display = 'none';
  if (mbDom.hud) mbDom.hud.style.display = 'flex';
  if (mbDom.cambar) mbDom.cambar.style.display = 'flex';
}

async function mbRestartRace() {
  if (!mbEnsureDom() || !mbBaseList.length) return;
  mbDom.controls.style.display = 'none';
  mbSetCount('…');
  const order = await rollPick(mbBaseList, mbBaseList.length, 'Марблс: стартовый порядок ' + mbBaseList.length + ' шариков');
  if (!mbDom.root.classList.contains('visible')) return;
  mbStartRace(order, mbCurMapId);
}

function closeMarblesOverlay() {
  if (mbRaf) { cancelAnimationFrame(mbRaf); mbRaf = 0; }
  if (mbGoTimer) { clearTimeout(mbGoTimer); mbGoTimer = 0; }
  if (mbPodTimer) { clearTimeout(mbPodTimer); mbPodTimer = 0; }
  // закрили до кінця подіуму — переможець усе одно фіксується в історії
  if (mbSt) { mbAnnounceWinner(mbSt); mbFreeSim(mbSt); }
  mbSt = null;
  if (mbG && mbG.fly.on) mbFlyStop();
  mbRaceGfxDispose();
  if (mbPickResolve) { const r = mbPickResolve; mbPickResolve = null; r(null); }
  if (mbDom && mbDom.root) {
    mbDom.root.classList.remove('visible');
    mbDom.controls.style.display = 'none';
    if (mbDom.picker) mbDom.picker.style.display = 'none';
    mbSetCount('');
    if (mbDom.hud) mbDom.hud.style.display = 'none';
    if (mbDom.cambar) mbDom.cambar.style.display = 'none';
    mbBoardReset();
    mbHidePodium();
    mbFlyHint(false);
  }
  if (typeof phase !== 'undefined' && phase === 'racing') phase = 'idle';
}

// ── Живий цикл: акумулятор фіксованих кроків + рендер ────────
function mbLoop(ts) {
  mbRaf = requestAnimationFrame(mbLoop);
  if (!mbSt || !mbDom) return;
  let dtReal = (ts - mbLastTs) / 1000;
  mbLastTs = ts;
  if (!(dtReal > 0)) dtReal = MB_DT;
  // стеля 0.1с: нижче 10 fps гонка йде у сповільненні, але не вибухає кроками;
  // попередні 0.05 давали слоу-мо вже нижче 20 fps (слабкий GPU + тіні), і кульки здавались «кам'яними»
  if (dtReal > 0.1) dtReal = 0.1;
  const t0 = performance.now();
  mbAdvance(mbSt, dtReal);
  mbRender(dtReal);
  if (mbG) {
    const ms = performance.now() - t0;
    mbG.frameMs = ms;
    // адаптивна якість: якщо кадр стабільно важчий за 24 мс — без тіней і на pixelRatio 1
    mbG.frameEma = mbG.frameEma == null ? ms : mbG.frameEma * 0.95 + ms * 0.05;
    if (!mbG.lowQ && mbG.frameEma > 24 && mbSt.frame > 120) mbSetLowQuality();
  }
}

// просування фаз шоу на dtReal секунд (окремо від rAF — для ручного pump у тестах)
function mbAdvance(st, dtReal) {
  if (st.phase === 'done') return;
  mbAcc += dtReal;
  while (mbAcc >= MB_DT) {
    mbAcc -= MB_DT;
    if (st.phase === 'intro') {
      st.introT += MB_DT;
      mbSimStep(st, MB_DT); // кульки осідають на лотку
      if (st.introT >= MB_INTRO) { st.phase = 'countdown'; st.cdT = 0; }
    } else if (st.phase === 'countdown') {
      st.cdT += MB_DT;
      mbSimStep(st, MB_DT);
      if (st.cdT >= MB_CD) {
        mbGo(st);
        st.phase = 'race';
        mbSetCount('GO!');
        mbGoTimer = setTimeout(() => { mbSetCount(''); mbGoTimer = 0; }, 700);
      } else {
        mbSetCount(String(MB_CD - Math.floor(st.cdT)));
      }
    } else {
      mbSimStep(st, MB_DT);
      // подіум — щойно є вся трійка (на 2 учасниках — двійка)
      if (!st.podShown && st.finishOrder.length >= Math.min(3, st.balls.length)) {
        st.podShown = true;
        mbShowPodium(st);
      }
      if (st.done) { st.phase = 'done'; break; }
    }
  }
}

// ── Кадр: синхронізація сцени зі станом + камера + HUD ───────
const mbM4 = { m: null, q: null, p: null, s: null };
function mbRender(dtReal) {
  const st = mbSt, G = mbG;
  if (!st || !G || !mbRace) return;
  const track = st.track;
  if (!mbM4.m) { mbM4.m = new THREE.Matrix4(); mbM4.q = new THREE.Quaternion(); mbM4.p = new THREE.Vector3(); mbM4.s = new THREE.Vector3(1, 1, 1); }
  const M = mbM4.m, Q = mbM4.q, P = mbM4.p, S1 = mbM4.s;

  // рейтинг активних за прогресом (прогрес оновлює ядро 4 рази/с)
  const sorted = st.active.slice().sort((a, b) => b.prog - a.prog);
  const leader = st.raceOn ? (sorted[0] || null) : null;

  // лоток — той самий кут, що й у Rapier; ворота зникають зі стартом
  if (G.tg && G.tg.trayGroup) G.tg.trayGroup.rotation.z = st.trayAng;
  if (G.tg && G.tg.gateMesh) G.tg.gateMesh.visible = !st.raceOn;
  if (G.tg && G.tg.spinners.length) {
    for (let i = 0; i < G.tg.spinners.length; i++) {
      const sp = G.tg.spinners[i], src = st.spinners[i];
      if (!src) continue;
      const ax = sp.axis; sp.grp.quaternion.setFromAxisAngle(mbM4.p.set(ax[0], ax[1], ax[2]).normalize(), src.ang);
      if (sp.lift) sp.grp.position.set(sp.c[0] + sp.up[0] * src.off, sp.c[1] + sp.up[1] * src.off, sp.c[2] + sp.up[2] * src.off);
    }
  }

  if (G.tg && G.tg.zones) mbZonesGfxUpdate(st);

  // кульки + плашки
  const balls = st.balls, inst = mbRace.balls, lab = mbRace.labels, gold = mbRace.goldAttr;
  const leadIdx = leader ? mbRace.idxByNick.get(leader.nick) : -1;
  // частка кроку, що вже «накопичилась» в акумуляторі: малюємо між попередньою і поточною позою
  const al = st.phase === 'done' ? 1 : mbClamp(mbAcc / MB_DT, 0, 1);
  const Q0 = mbM4.q0 || (mbM4.q0 = new THREE.Quaternion());
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    let sc = 1, g = i === leadIdx ? 1 : 0;
    if (b.gone) {
      // зникнення: за 0.35 с стискається в точку, плашка ховається одразу
      sc = mbClamp(1 - (st.raceT - b.goneT) / 0.35, 0, 1);
      g = -1;
    }
    P.set(b.px + (b.x - b.px) * al, b.py + (b.y - b.py) * al, b.pz + (b.z - b.pz) * al);
    Q0.set(b.pq[0], b.pq[1], b.pq[2], b.pq[3]); Q.set(b.q[0], b.q[1], b.q[2], b.q[3]);
    Q0.slerp(Q, al);
    S1.setScalar(sc);
    M.compose(P, Q0, S1);
    inst.setMatrixAt(i, M);
    P.y += MB_R * 0.6;
    M.makeTranslation(P.x, P.y, P.z);
    lab.setMatrixAt(i, M);
    if (gold.array[i] !== g) { gold.array[i] = g; gold.needsUpdate = true; }
  }
  S1.setScalar(1);
  inst.instanceMatrix.needsUpdate = true;
  lab.instanceMatrix.needsUpdate = true;
  // сталий розмір плашки на екрані: висота слота ≈ 3.4% висоти вʼюпорту
  mbRace.labelMat.uniforms.k.value = 2 * Math.tan(G.camera.fov * Math.PI / 360) * 0.034 / (MB_SLOT_H / MB_SLOT_W);

  // камера
  mbUpdateCamera(st, dtReal, sorted);
  // сонце і тіні їдуть за фокусом камери (2048² на 160 м — різкі тіні кульок)
  const f = G.focus;
  G.sun.position.set(f.x + 90, f.y + 190, f.z + 70);
  G.sun.target.position.copy(f);
  G.sun.target.updateMatrixWorld();
  G.sky.position.copy(G.camera.position);
  // дрейф хмар
  for (const c of G.clouds) { c.tex.offset.x += c.drift * dtReal; c.tex.offset.y += c.drift * 0.4 * dtReal; }

  G.renderer.render(G.scene, G.camera);
  G.drawCalls = G.renderer.info.render.calls; G.tris = G.renderer.info.render.triangles;

  // страховка: цифра відліку не має пережити старт
  if (st.raceOn && !mbGoTimer && mbDom.count.style.display !== 'none') mbSetCount('');

  // HUD
  if (mbDom.timer) mbDom.timer.textContent = mbFmtTime(st.raceOn ? st.raceT : 0);
  if (mbDom.alive) mbDom.alive.textContent = st.active.length + '/' + st.balls.length;
  if (mbDom.cd) {
    const show = st.countdown != null && !st.done;
    mbDom.cd.style.display = show ? 'inline-flex' : 'none';
    if (show) { const c = Math.max(0, Math.ceil(st.countdown)); mbDom.cd.textContent = '00:' + (c < 10 ? '0' : '') + c; }
  }
  mbBoardAcc += dtReal;
  if (mbBoardAcc >= 0.25 && (st.raceOn || st.done)) {
    mbBoardAcc = 0;
    mbBoardUpdate(st, mbRanking(st, sorted));
  }
}

// ── Експорт контракту в window (classic script) ──────────────
window.startMarblesGame = startMarblesGame;
window.closeMarblesOverlay = closeMarblesOverlay;
window.mbRestartRace = mbRestartRace;
window.mbRunHeadless = mbRunHeadless;
window.mbDebug = () => mbSt;
window.mbTrack = mbTrack;          // опис траси (segments/stages/cl/finish/tray) — для тестів; mbTrack(mapId)
window.mbMapIds = mbMapIds;
window.mbChangeMap = mbChangeMap;
window.mbChooseMap = mbChooseMap;
window.mbToggleFly = mbToggleFly;
window.mbAutoCam = mbAutoCam;
window.mbGfx = () => mbG;          // сцена/рендерер — для дебагу і заміру renderer.info
// ручний pump фаз шоу (тести без rAF). Інша назва навмисно: у classic-скрипті
// top-level function mbAdvance і є window.mbAdvance — перезапис дав би рекурсію
window.mbPump = (dt) => { if (mbSt) mbAdvance(mbSt, dt); };
window.mbRenderFrame = (dt) => { if (mbSt && mbDom) mbRender(dt || MB_DT); };
window.mbTrackInfo = (mapId) => {
  const t = mbTrack(mapId);
  return { map: t.id, segments: t.segments.length, tris: t.tris, pathLen: Math.round(t.pathLen), stages: t.stages.map(s => s.id + ':' + Math.round(s.s0)), bbox: t.bbox };
};
