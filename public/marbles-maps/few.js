// ─────────────────────────────────────────────────────────────
//  💀 Карта «Few Will Survive» — збудована з нуля за відео власника
//  (2026-10-19). Власна геометрія (профіль жолоба з окремою внутрішньою й
//  зовнішньою поверхнею, лійка, скляні куполи), власна фізика зіткнень
//  (trimesh-и з тих самих кілець) і власний рендер (map.customRender):
//  пісок з рельєфом усередині, глянцевий чорний низ, скло з френелем.
//  Від ядра marbles.js — лише рушій: Rapier, лоток, лідерборд, ніки, камера.
//
//  Маршрут: лоток → тарілка Ø44 з лійкою (скляний обідок) → ніжка-труба →
//  хаб → довгий жолоб → купол 1 з червоним «гребенем», що крутиться →
//  купол 2 з полем червоних куполів → жолоб із трампліном і провалом →
//  купол 3 з гребенем → 4 смуги (крайні — з петлями) із золотими шевронами
//  → трампліни й політ у фінішну чашу над прірвою. Хто не долетів — вибув.
//  Одиниці — метри, кулька r = 0.5, потік уздовж +x.
// ─────────────────────────────────────────────────────────────
(function () {
// ── векторні дрібниці (свої — карта не залежить від хелперів ядра) ──
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.sqrt(dot(a, a));
const nrm = a => { const L = len(a) || 1e-9; return [a[0] / L, a[1] / L, a[2] / L]; };
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const ease = k => { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); };
const D2R = Math.PI / 180;
const G_FEW = 8;          // гравітація карти (менше — дешевший крок фізики на швидких ділянках)
const JD = 0.15, JE = 0.3; // стик: наступна ділянка на 0.15 нижче і на 0.3 раніше

// ── криві в плані ──
// центростремительний Catmull-Rom крізь контрольні точки (без петель і «вусів»)
function spline(ctrl, step) {
  const P = [ctrl[0]].concat(ctrl, [ctrl[ctrl.length - 1]]), out = [];
  for (let i = 1; i + 2 < P.length; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const n = Math.max(2, Math.ceil(len(sub(p2, p1)) / step));
    const t0 = 0, t1 = t0 + Math.sqrt(len(sub(p1, p0)) || 1e-3), t2 = t1 + Math.sqrt(len(sub(p2, p1)) || 1e-3), t3 = t2 + Math.sqrt(len(sub(p3, p2)) || 1e-3);
    for (let k = 0; k < n; k++) {
      const t = t1 + (t2 - t1) * k / n;
      const A1 = add(mul(p0, (t1 - t) / (t1 - t0)), mul(p1, (t - t0) / (t1 - t0)));
      const A2 = add(mul(p1, (t2 - t) / (t2 - t1)), mul(p2, (t - t1) / (t2 - t1)));
      const A3 = add(mul(p2, (t3 - t) / (t3 - t2)), mul(p3, (t - t2) / (t3 - t2)));
      const B1 = add(mul(A1, (t2 - t) / (t2 - t0)), mul(A2, (t - t0) / (t2 - t0)));
      const B2 = add(mul(A2, (t3 - t) / (t3 - t1)), mul(A3, (t - t1) / (t3 - t1)));
      out.push(add(mul(B1, (t2 - t) / (t2 - t1)), mul(B2, (t - t1) / (t2 - t1))));
    }
  }
  out.push(ctrl[ctrl.length - 1].slice());
  return out;
}
// «черепашка»: прямі й дуги в плані (heading 0 = +x, +90° = +z)
function path(x, z, hDeg) {
  const T = { x, z, h: hDeg * D2R, pts: [[x, 0, z]] };
  T.fwd = function (L) { const n = Math.max(1, Math.ceil(L)); for (let k = 1; k <= n; k++) this.pts.push([this.x + Math.cos(this.h) * L * k / n, 0, this.z + Math.sin(this.h) * L * k / n]); this.x += Math.cos(this.h) * L; this.z += Math.sin(this.h) * L; return this; };
  T.arc = function (deg, r) {
    const sg = Math.sign(deg) || 1, cx = this.x - Math.sin(this.h) * r * sg, cz = this.z + Math.cos(this.h) * r * sg, a0 = this.h - sg * Math.PI / 2;
    const n = Math.max(2, Math.ceil(Math.abs(deg) / 3));
    for (let k = 1; k <= n; k++) { const a = a0 + deg * D2R * k / n; this.pts.push([cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r]); }
    this.h += deg * D2R; this.x = cx + Math.cos(a0 + deg * D2R) * r; this.z = cz + Math.sin(a0 + deg * D2R) * r; return this;
  };
  return T;
}
// рівномірний крок по дузі
function resample(pts, ds) {
  const out = [pts[0].slice()]; let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1]; const b = pts[i]; let L = len(sub(b, a));
    while (acc + L >= ds) { const t = (ds - acc) / L; a = add(a, mul(sub(b, a), t)); out.push(a); L = len(sub(b, a)); acc = 0; }
    acc += L;
  }
  if (len(sub(out[out.length - 1], pts[pts.length - 1])) > ds * 0.3) out.push(pts[pts.length - 1].slice()); else out[out.length - 1] = pts[pts.length - 1].slice();
  return out;
}
// висоти по дузі: профіль спуску fy(k), k ∈ [0,1] від y0 до y1 (за замовчуванням лінійний)
function heights(pts, y0, y1, fy) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  const L = cum[cum.length - 1] || 1;
  for (let i = 0; i < pts.length; i++) { const k = cum[i] / L; pts[i][1] = y0 + (y1 - y0) * (fy ? fy(k) : k); }
  return pts;
}
// трамплін: підйом на h за останні L м (квадратично) — кулька злітає під кутом
function kick(pts, L, h) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  const S = cum[cum.length - 1];
  for (let i = 0; i < pts.length; i++) { const u = (cum[i] - (S - L)) / L; if (u > 0) pts[i][1] += h * u * u; }
  return pts;
}

// ── рамки вздовж осі: t, r (праворуч), u (угору), s, w, крен з кривини ──
function frames(pts, o) {
  const n = pts.length, F = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t = nrm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
    const u0 = nrm(sub([0, 1, 0], mul(t, t[1]))), r0 = nrm(cross(t, u0));
    if (i) s += len(sub(pts[i], pts[i - 1]));
    F.push({ p: pts[i].slice(), t, r0, u0, s, bank: 0 });
  }
  const S = F[n - 1].s || 1, vB = o.vBank || 0, maxB = (o.maxBank != null ? o.maxBank : 26) * D2R;
  // крен: tan b = v²κ/g, згладжування ±4 м двічі, нуль на кінцях (стик із сусідом рівний)
  const raw = new Float64Array(n);
  if (vB) for (let i = 1; i + 1 < n; i++) { const dl = F[i + 1].s - F[i - 1].s || 1, c = dot(sub(F[i + 1].t, F[i - 1].t), F[i].r0) / dl; raw[i] = Math.sign(c) * Math.min(maxB, Math.atan(vB * vB * Math.abs(c) / 9.81)); }
  let cur = raw;
  for (let pass = 0; pass < 3; pass++) {
    const nx = new Float64Array(n);
    for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let j = i - 4; j <= i + 4; j++) if (j >= 0 && j < n) { a += cur[j]; c++; } nx[i] = a / c; }
    cur = nx;
  }
  for (let i = 0; i < n; i++) {
    const f = F[i], k = f.s / S;
    const fade = Math.min(1, f.s / 6, (S - f.s) / 6);
    const b = (o.bank != null ? o.bank * D2R : cur[i]) * Math.max(0, fade);
    f.bank = b;
    f.r = sub(mul(f.r0, Math.cos(b)), mul(f.u0, Math.sin(b)));
    f.u = add(mul(f.u0, Math.cos(b)), mul(f.r0, Math.sin(b)));
    f.w = o.wFn ? o.wFn(k, f.s, S) : o.w0 + ((o.w1 != null ? o.w1 : o.w0) - o.w0) * (o.wEase ? ease(k) : k);
  }
  return F;
}

// ── профіль жолоба: замкнений контур (x — поперек, y — угору), за годинниковою ──
// mat 0 — пісок (внутрішня поверхня), 1 — чорне (губа, борти зовні, низ).
// Дно з великими галтелями: кулька котиться, а не клиниться в куті дно–борт
function trough(w, H, t, T, nf) {
  const hw = w / 2, R = Math.min(1.4, hw * 0.42), P = [];
  const push = (x, y, mat, hard) => P.push({ x, y, mat, hard: !!hard });
  push(-hw, H, 0, true);                                                   // верх лівого борту (межа з губою)
  for (let k = 1; k <= 6; k++) push(-hw, H - (H - R) * k / 6, 0);
  for (let k = 1; k <= 7; k++) { const a = Math.PI + k / 8 * Math.PI / 2; push(-hw + R + R * Math.cos(a), R + R * Math.sin(a), 0); }
  push(-hw + R, 0, 0);
  for (let k = 1; k < nf; k++) push(-hw + R + (w - 2 * R) * k / nf, 0, 0);
  push(hw - R, 0, 0);
  for (let k = 1; k <= 7; k++) { const a = 1.5 * Math.PI + k / 8 * Math.PI / 2; push(hw - R + R * Math.cos(a), R + R * Math.sin(a), 0); }
  for (let k = 0; k <= 5; k++) push(hw, R + (H - R) * k / 6, 0);
  push(hw, H, 1, true);                                                    // губа — чорна, кругла
  for (let k = 1; k < 6; k++) { const a = Math.PI - k / 6 * Math.PI; push(hw + t / 2 + t / 2 * Math.cos(a), H + t / 2 * Math.sin(a), 1); }
  push(hw + t, H, 1);
  push(hw + t, -T + 0.25, 1, true); push(hw + t - 0.25, -T, 1, true);      // зовнішній борт і фаска
  push(-hw - t + 0.25, -T, 1, true); push(-hw - t, -T + 0.25, 1, true);
  push(-hw - t, H, 1);
  for (let k = 1; k < 6; k++) { const a = k / 6 * Math.PI; push(-hw - t / 2 - t / 2 * Math.cos(a), H + t / 2 * Math.sin(a), 1); }
  return P;
}

// ── меш із сітки кілець: P[i][j] (i — уздовж, j — по профілю) ──
// phys — унікальні вершини (trimesh Rapier), rend — з дублями на жорстких ребрах
// і межах матеріалів, групи за матеріалом, uv у метрах (u — уздовж, v — по контуру)
function gridMesh(rings, prof, o) {
  const n = rings.length, m = prof.length, closedJ = o.closedJ !== false, closedI = !!o.closedI;
  const nE = closedJ ? m : m - 1;
  // зовнішня нормаль ребра профілю в 3D — для правильного обходу трикутників
  const refN = o.refN;
  const pv = new Float32Array(n * m * 3);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const q = rings[i][j]; pv.set(q, (i * m + j) * 3); }
  const pIdx = [];
  const triOK = (A, B, C, ref) => dot(cross(sub(B, A), sub(C, A)), ref) >= 0;
  const P3 = k => [pv[k * 3], pv[k * 3 + 1], pv[k * 3 + 2]];
  const nI = closedI ? n : n - 1;
  for (let i = 0; i < nI; i++) {
    const i1 = (i + 1) % n;
    for (let j = 0; j < nE; j++) {
      const j1 = (j + 1) % m, a = i * m + j, b = i * m + j1, c = i1 * m + j, d = i1 * m + j1;
      const ref = refN(i, j);
      if (triOK(P3(a), P3(b), P3(c), ref)) pIdx.push(a, b, c); else pIdx.push(a, c, b);
      if (triOK(P3(b), P3(d), P3(c), ref)) pIdx.push(b, d, c); else pIdx.push(b, c, d);
    }
  }
  const phys = { vertices: pv, indices: new Uint32Array(pIdx) };
  if (o.physOnly) return { phys };
  // рендер: копії точки j для ребра j−1 і ребра j, якщо точка жорстка або там міняється матеріал
  const copies = []; let nv = 0;
  for (let j = 0; j < m; j++) {
    const prevE = (j - 1 + m) % m, split = prof[j].hard || (closedJ || j > 0) && prof[prevE].mat !== prof[j].mat;
    copies.push(split ? [nv, nv + 1] : [nv, nv]);
    nv += split ? 2 : 1;
  }
  // довжина контуру до точки j — для v
  const vAcc = [0]; for (let j = 1; j < m; j++) vAcc.push(vAcc[j - 1] + Math.hypot(prof[j].x - prof[j - 1].x, prof[j].y - prof[j - 1].y));
  const vClose = vAcc[m - 1] + Math.hypot(prof[0].x - prof[m - 1].x, prof[0].y - prof[m - 1].y);
  const pos = new Float32Array(n * nv * 3), uv = new Float32Array(n * nv * 2), TX = o.tex || 3;
  for (let i = 0; i < n; i++) {
    const u = (o.uAt ? o.uAt(i) : i) / TX;
    for (let j = 0; j < m; j++) {
      const q = rings[i][j];
      for (const c of new Set(copies[j])) { const k = i * nv + c; pos.set(q, k * 3); uv[k * 2] = u; uv[k * 2 + 1] = vAcc[j] / TX; }
    }
  }
  const groups = {};
  for (let i = 0; i < nI; i++) {
    const i1 = (i + 1) % n;
    for (let j = 0; j < nE; j++) {
      const j1 = (j + 1) % m, mat = prof[j].mat;
      const a = i * nv + copies[j][1], b = i * nv + copies[j1][0], c = i1 * nv + copies[j][1], d = i1 * nv + copies[j1][0];
      const g = groups[mat] || (groups[mat] = []);
      const ref = refN(i, j), A = rings[i][j], B = rings[i][j1], C = rings[i1][j];
      if (triOK(A, B, C, ref)) g.push(a, b, c, b, d, c); else g.push(a, c, b, b, c, d);
    }
  }
  // кінець контуру (замкнений): ребро m−1 → 0 має v від vAcc[m−1] до vClose — дрібниця, шва не видно на чорному
  void vClose;
  return { phys, rend: { pos, uv, groups } };
}
// нормаль ребра профілю (2D) назовні: контур за годинниковою — ліворуч від обходу
function profNormals(prof, closed) {
  let area = 0; const m = prof.length;
  for (let j = 0; j < m; j++) { const a = prof[j], b = prof[(j + 1) % m]; area += a.x * b.y - b.x * a.y; }
  const sg = area < 0 ? 1 : -1, N = [];
  for (let j = 0; j < m; j++) {
    const a = prof[j], b = prof[closed === false && j === m - 1 ? j : (j + 1) % m];
    const ex = b.x - a.x, ey = b.y - a.y, L = Math.hypot(ex, ey) || 1;
    N.push([sg * -ey / L, sg * ex / L]);
  }
  return N;
}

// ── сегмент-жолоб: осьова лінія pts (рівень підлоги) + параметри профілю ──
function chute(id, pts, o) {
  const rs = resample(pts, o.ds || 1.0);
  const F = frames(rs, o);
  const H = o.H != null ? o.H : 3, t = o.t != null ? o.t : 0.8, T = o.T != null ? o.T : 0.6;
  // кількість точок дна — стала на весь сегмент (за найширшим місцем), інакше кільця різні
  let wMax = 0; for (const f of F) wMax = Math.max(wMax, f.w);
  const nf = Math.max(2, Math.round((wMax - 2.8) / 1.2));
  const prof0 = trough(F[0].w, H, t, T, nf);
  const rings = [], profs = [];
  for (const f of F) {
    const pr = trough(f.w, H, t, T, nf); profs.push(pr);
    rings.push(pr.map(q => add(add(f.p, mul(f.r, q.x)), mul(f.u, q.y))));
  }
  const N2 = profs.map(pr => profNormals(pr));
  const refN = (i, j) => { const f = F[i], nn = N2[i][j]; return add(mul(f.r, nn[0]), mul(f.u, nn[1])); };
  const gm = gridMesh(rings, prof0, { refN, uAt: i => F[i].s });
  const center = F.map(f => f.p);
  return {
    id, kind: 'sweep', mesh: gm.phys, frames: F, center, length: F[F.length - 1].s, H, t,
    w0: F[0].w, w1: F[F.length - 1].w, start: center[0].slice(), end: center[center.length - 1].slice(), endDir: F[F.length - 1].t.slice(),
    _rend: gm.rend, _cap: { prof0, profN: profs[profs.length - 1], f0: F[0], fN: F[F.length - 1] }, branch: o.branch || 0,
  };
}
// скляний купол над сегментом (кілька кілець з рамок; відкритий контур, фізика — теж)
function dome(id, seg, s0, s1, hgt) {
  const F = seg.frames.filter(f => f.s >= s0 - 0.01 && f.s <= s1 + 0.01);
  const K = 14, rings = [], prof = [];
  for (let k = 0; k <= K; k++) prof.push({ mat: 2 });
  for (const f of F) {
    const hw = f.w / 2 + seg.t, h = hgt(f.w), ring = [];
    for (let k = 0; k <= K; k++) { const a = Math.PI * k / K; ring.push(add(add(f.p, mul(f.r, -Math.cos(a) * hw)), mul(f.u, seg.H + Math.sin(a) * h))); }
    rings.push(ring);
  }
  const refN = (i, j) => { const f = F[i], a = Math.PI * (j + 0.5) / K; return add(mul(f.r, Math.cos(a)), mul(f.u, -Math.sin(a))); };
  const gm = gridMesh(rings, prof, { refN, closedJ: false, uAt: i => F[i].s });
  return { id, kind: 'sweep', mesh: gm.phys, noProgress: true, _rend: gm.rend, _glass: true };
}

// ── тарілка з лійкою: тіло обертання замкненого контуру (r, y) ──
function bowlLathe(id, c, prof, N) {
  const rings = [];
  for (let i = 0; i < N; i++) { const ph = i / N * 2 * Math.PI, cs = Math.cos(ph), sn = Math.sin(ph); rings.push(prof.map(q => [c[0] + q.x * cs, c[1] + q.y, c[2] + q.x * sn])); }
  const N2 = profNormals(prof);
  const refN = (i, j) => { const ph = (i + 0.5) / N * 2 * Math.PI, nn = N2[j]; return [nn[0] * Math.cos(ph), nn[1], nn[0] * Math.sin(ph)]; };
  const gm = gridMesh(rings, prof, { refN, closedI: true, uAt: i => i / N * 2 * Math.PI * 12 });
  return { id, kind: 'sweep', mesh: gm.phys, _rend: gm.rend };
}

// фізика тіла обертання: дотичні плити-кубоїди під кожним ребром ВНУТРІШНЬОЇ поверхні
// (mat 0). Товщина 1 м: щільний пелетон у лійці не продавить кульку крізь стінку,
// як крізь безтовщинний трикутник
function quatBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2], tr = m00 + m11 + m22;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S]; }
  if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; return [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S]; }
  if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S]; }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2; return [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
}
function latheplates(c, prof, N, thick) {
  const plates = [], N2 = profNormals(prof);
  for (let j = 0; j + 1 < prof.length; j++) {
    if (prof[j].mat !== 0) continue;
    const a = prof[j], b = prof[j + 1], gl = Math.hypot(b.x - a.x, b.y - a.y);
    if (gl < 1e-3) continue;
    const nn2 = N2[j], rMax = Math.max(a.x, b.x), halfW = rMax * Math.tan(Math.PI / N) + 0.35;
    for (let k = 0; k < N; k++) {
      const ph = (k + 0.5) / N * 2 * Math.PI, cs = Math.cos(ph), sn = Math.sin(ph);
      const tv = [-sn, 0, cs], gv = nrm([(b.x - a.x) * cs, b.y - a.y, (b.x - a.x) * sn]);
      const nv = nrm([nn2[0] * cs, nn2[1], nn2[0] * sn]);                // у повітря
      const zv = cross(tv, nv), gz = dot(zv, gv) < 0 ? mul(zv, -1) : zv;
      const tx = dot(cross(nv, gz), tv) < 0 ? mul(tv, -1) : tv;           // правий базис (tx, nv, gz)
      const mid = [c[0] + (a.x + b.x) / 2 * cs, c[1] + (a.y + b.y) / 2, c[2] + (a.x + b.x) / 2 * sn];
      plates.push({ pos: sub(mid, mul(nv, thick / 2)), quat: quatBasis(tx, nv, gz), size: [halfW, thick / 2, gl / 2] }); // без подовження: на опуклому стику (край лійки) воно стирчало гребенем
    }
  }
  return plates;
}
// бокс у форматі ядра (фізика: kind 'boxes'): pos — центр, yaw, size — півдіагоналі
function box(pos, yaw, size, role) { return { pos: pos.slice(), quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], size: size.slice(), role: role || 'wall' }; }
// висота підлоги сегмента біля x (по осі)
function floorAt(seg, x) {
  const F = seg.frames; let best = 1e9, y = F[0].p[1];
  for (let i = 0; i + 1 < F.length; i++) { const a = F[i].p, b = F[i + 1].p; if ((x - a[0]) * (x - b[0]) <= 0 && b[0] !== a[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); const d = Math.abs(a[0] - x); if (d < best) { best = d; y = a[1]; } }
  return y;
}
// розширення «пляшкою»: w0 → wMax (плато) → w1
function bulgeW(w0, wMax, w1, kIn, kOut) { return k => k < kIn ? w0 + (wMax - w0) * ease(k / kIn) : (k > kOut ? w1 + (wMax - w1) * ease((1 - k) / (1 - kOut)) : wMax); }
// висоти з плато: спуск dropIn за [0,kIn], рівно на плато, спуск dropOut за [kOut,1]
function plateauY(y0, dropIn, dropOut, kIn, kOut, slopeMid) {
  return pts => {
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
    const L = cum[cum.length - 1];
    // плато не пласке: на рівній підлозі кульки зупинялись і чекали, поки їх штовхне гребінь
    for (let i = 0; i < pts.length; i++) { const k = cum[i] / L; pts[i][1] = y0 - dropIn * ease(k / kIn) - (slopeMid || 0) * L * (clamp(k, kIn, kOut) - kIn) - (k > kOut ? dropOut * ease((k - kOut) / (1 - kOut)) : 0); }
    return pts;
  };
}
// поворот, що веде вісь Y у вектор u (кватерніон [x,y,z,w]) і обертання точки ним
function quatYto(u) { const c = u[1]; if (c > 0.999999) return [0, 0, 0, 1]; const ax = nrm([u[2], 0, -u[0]]), a = Math.acos(clamp(c, -1, 1)), sn = Math.sin(a / 2); return [ax[0] * sn, ax[1] * sn, ax[2] * sn, Math.cos(a / 2)]; }
function qmul(a, b) { return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]; }
function qrot(q, v) { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [p[0], p[1], p[2]]; }
// гребінь на похилому плато: вісь обертання — нормаль підлоги, бокси нахилені разом із нею
function makeComb(id, seg, cx, L, n, omega, phase) {
  const F = seg.frames; let f = F[0]; for (const g of F) if (Math.abs(g.p[0] - cx) < Math.abs(f.p[0] - cx)) f = g;
  const u = f.u, q = quatYto(u), c = add(f.p, mul(u, 0.03));
  const cb = combBoxes(L, 2.0, 1.45, 1.2, n, 0.5);
  const boxes = cb.boxes.map(b => ({ pos: qrot(q, b.pos), quat: qmul(q, b.quat), size: b.size, role: b.role }));
  return { id, kind: 'spinner', c, axis: u.slice(), omega, phase, boxes, balls: [], red: true, friction: 0.3, restitution: 0.45, tilt: q, comb: { L, Hc: 2.0, aw: 1.45, ah: 1.2, n, th: 0.5 } };
}
// гребінь: червона балка з арками знизу (кульки проскакують в арки), крутиться навколо вертикалі
function combBoxes(L, Hc, archW, archH, nA, th) {
  const tw = (L - nA * archW) / (nA + 1), boxes = [];
  boxes.push({ pos: [0, archH + (Hc - archH) / 2, 0], quat: [0, 0, 0, 1], size: [L / 2, (Hc - archH) / 2, th / 2], role: 'bumper' });
  for (let k = 0; k <= nA; k++) { const x = -L / 2 + tw / 2 + k * (tw + archW); boxes.push({ pos: [x, archH / 2, 0], quat: [0, 0, 0, 1], size: [tw / 2, archH / 2, th / 2], role: 'bumper' }); }
  return { boxes, tw };
}

// ═════════════════════════════════════════════════════════════
//  РЕНДЕР: матеріали (один раз на сторінку) і меші з _rend
// ═════════════════════════════════════════════════════════════
let FM = null;
function hash2(x, y, s) { let n = (x * 374761393 + y * 668265263 + s * 1013904223) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }
// тайловий value-noise size², період p клітин
function vnoise(size, p, seed) {
  const out = new Float32Array(size * size), inv = p / size;
  for (let y = 0; y < size; y++) {
    const fy = y * inv, iy = fy | 0, ty = fy - iy, sy = ty * ty * (3 - 2 * ty), iy1 = (iy + 1) % p;
    for (let x = 0; x < size; x++) {
      const fx = x * inv, ix = fx | 0, tx = fx - ix, sx = tx * tx * (3 - 2 * tx), ix1 = (ix + 1) % p;
      const a = hash2(ix, iy, seed), b = hash2(ix1, iy, seed), c = hash2(ix, iy1, seed), d = hash2(ix1, iy1, seed);
      out[y * size + x] = (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
    }
  }
  return out;
}
// пісок: дрібне зерно + ледь помітна «тканина» + мʼякі плями; низький контраст —
// жодних світлих цяток, які здалеку читаються як дірки в небо
function sandMaps(THREE, size) {
  const n1 = vnoise(size, 8, 3), n2 = vnoise(size, 32, 5), n3 = vnoise(size, 128, 7), n4 = vnoise(size, 256, 9);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    // лише шум (без регулярного візерунка): регулярна «тканина» здалеку давала муар-цятки
    h[i] = n2[i] * 0.3 + n3[i] * 0.4 + n4[i] * 0.3;
  }
  const cA = document.createElement('canvas'); cA.width = cA.height = size;
  const gA = cA.getContext('2d'), iA = gA.createImageData(size, size), dA = iA.data;
  const base = [196, 164, 118], dark = [160, 128, 86], light = [214, 186, 142];
  for (let i = 0; i < size * size; i++) {
    const m = n1[i] * 0.6 + n2[i] * 0.4, g = h[i];
    let r = base[0] + (light[0] - base[0]) * clamp((m - 0.5) * 2, 0, 1) + (dark[0] - base[0]) * clamp((0.5 - m) * 2, 0, 1);
    let gg = base[1] + (light[1] - base[1]) * clamp((m - 0.5) * 2, 0, 1) + (dark[1] - base[1]) * clamp((0.5 - m) * 2, 0, 1);
    let b = base[2] + (light[2] - base[2]) * clamp((m - 0.5) * 2, 0, 1) + (dark[2] - base[2]) * clamp((0.5 - m) * 2, 0, 1);
    const k = (g - 0.5) * 34; r += k; gg += k; b += k * 0.8;
    dA[i * 4] = r; dA[i * 4 + 1] = gg; dA[i * 4 + 2] = b; dA[i * 4 + 3] = 255;
  }
  gA.putImageData(iA, 0, 0);
  // нормалі з висоти (центральні різниці, тайлово)
  const cN = document.createElement('canvas'); cN.width = cN.height = size;
  const gN = cN.getContext('2d'), iN = gN.createImageData(size, size), dN = iN.data, S = 3.2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const hx = h[y * size + (x + 1) % size] - h[y * size + (x - 1 + size) % size];
    const hy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
    let nx = -hx * S, ny = -hy * S, nz = 1; const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
    const i = (y * size + x) * 4; dN[i] = (nx * 0.5 + 0.5) * 255; dN[i + 1] = (ny * 0.5 + 0.5) * 255; dN[i + 2] = (nz * 0.5 + 0.5) * 255; dN[i + 3] = 255;
  }
  gN.putImageData(iN, 0, 0);
  const map = new THREE.CanvasTexture(cA), nmap = new THREE.CanvasTexture(cN);
  for (const t of [map, nmap]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 16; }
  map.encoding = THREE.sRGBEncoding;
  return { map, nmap };
}
function fewMats(THREE, env, renderer) {
  if (FM) return FM;
  const maxAniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 8;
  const sand = sandMaps(THREE, 512);
  sand.map.anisotropy = sand.nmap.anisotropy = maxAniso;
  // скло: прозоре в лоб і світліше під скісним кутом (френель) — як куполи у відео
  const glass = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { tint: { value: new THREE.Color('#dfeeff') } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform vec3 tint; varying vec3 vN; varying vec3 vV; void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); float a = 0.035 + 0.55 * pow(f, 3.0); gl_FragColor = vec4(tint, a); }',
  });
  FM = {
    sand: new THREE.MeshStandardMaterial({ map: sand.map, normalMap: sand.nmap, normalScale: new THREE.Vector2(0.7, 0.7), color: 0xffffff, roughness: 0.88, metalness: 0.0, envMap: env, envMapIntensity: 0.25 }),
    // чорний глянець: мало металу й відбиття — інакше синє небо в envMap фарбувало його в сіро-синій
    dark: new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.42, metalness: 0.1, envMap: env, envMapIntensity: 0.35 }),
    glass,
    red: new THREE.MeshStandardMaterial({ color: 0xc01019, roughness: 0.32, metalness: 0.05, envMap: env, envMapIntensity: 0.45 }),
    gold: new THREE.MeshBasicMaterial({ color: 0xffd04a }),
    goldGlow: new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
    green: new THREE.MeshBasicMaterial({ color: 0x46ff8a }),
  };
  FM.darkDS = FM.dark.clone(); FM.darkDS.side = THREE.DoubleSide;
  // лоток START і логотип — свої текстури
  {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 128; const g = c.getContext('2d');
    for (let y = 0; y < 128; y += 32) for (let x = 0; x < 1024; x += 32) { g.fillStyle = (((x + y) / 32) & 1) ? '#111' : '#f2c230'; g.fillRect(x, y, 32, 32); }
    g.font = '900 76px Arial Black, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = '#111'; g.fillStyle = '#f2c230'; g.strokeText('START', 512, 66); g.fillText('START', 512, 66);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = maxAniso;
    FM.start = new THREE.MeshBasicMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }
  {
    const S = 1024, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // текст — на дальньому від лотка боці тарілки, між лійкою (r 8.5) і обідком (верх полотна = +x)
    g.save(); g.translate(S / 2, S * 0.15); g.transform(1, 0, -0.16, 1, 0, 0);
    g.font = '900 100px Arial Black, Arial, sans-serif'; g.fillStyle = 'rgba(210,40,60,0.92)'; g.fillText('KICKPLAY', 0, 0);
    g.restore();
    g.font = '900 52px Arial Black, Arial, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fillText('M A R B L E S', S / 2, S * 0.255);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = maxAniso;
    FM.logo = new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }
  {
    // LED обідка чаші: жовті точки на чорному, по краю зелена смуга
    const c = document.createElement('canvas'); c.width = 512; c.height = 64; const g = c.getContext('2d');
    g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, 512, 64); g.fillStyle = '#2bd66a'; g.fillRect(0, 54, 512, 10);
    g.fillStyle = '#ffd23c'; for (let x = 16; x < 512; x += 32) { g.beginPath(); g.arc(x, 18, 7, 0, 6.283); g.fill(); g.beginPath(); g.arc(x + 16, 38, 7, 0, 6.283); g.fill(); }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.wrapS = THREE.RepeatWrapping; t.anisotropy = maxAniso;
    FM.led = new THREE.MeshBasicMaterial({ map: t });
  }
  {
    // золоті шеврони прискорювача (u — уздовж руху)
    const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 128); g.fillStyle = '#ffcf45';
    for (let k = 0; k < 2; k++) { const x0 = 24 + k * 118; g.beginPath(); g.moveTo(x0, 14); g.lineTo(x0 + 56, 64); g.lineTo(x0, 114); g.lineTo(x0 + 30, 114); g.lineTo(x0 + 86, 64); g.lineTo(x0 + 30, 14); g.closePath(); g.fill(); }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = maxAniso;
    FM.chev = new THREE.MeshBasicMaterial({ map: t, transparent: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  }
  return FM;
}
// меш із _rend (групи матеріалів: 0 — пісок, 1 — чорне, 2 — скло)
function rendMesh(THREE, R) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(R.pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(R.uv, 2));
  const all = []; const keys = Object.keys(R.groups).map(Number).sort();
  for (const k of keys) { geo.addGroup(all.length, R.groups[k].length, k); for (const v of R.groups[k]) all.push(v); }
  geo.setIndex(all);
  geo.computeVertexNormals();
  return geo;
}
// торцеві кришки жолоба (чорні): трикутники контуру через ShapeUtils
function capGeo(THREE, prof, f, flip) {
  const pts2 = prof.map(q => new THREE.Vector2(q.x, q.y));
  const tris = THREE.ShapeUtils.triangulateShape(pts2, []);
  const pos = [];
  for (const tr of tris) {
    const idx = flip ? [tr[0], tr[2], tr[1]] : tr;
    for (const k of idx) { const q = prof[k]; pos.push(...add(add(f.p, mul(f.r, q.x)), mul(f.u, q.y))); }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
  return geo;
}

// ═════════════════════════════════════════════════════════════
const MAP = {
  id: 'few',
  name: 'Few Will Survive',
  icon: '💀',
  approxSec: 72,
  allSec: 132,
  desc: 'Тарелка-воронка, длинный жёлоб, купола с вращающимися гребнями, поле красных куполов, прыжки над пропастью и петли — до финишной чаши долетают не все.',
  eliminate: true,
  customRender: true,
  physics: { g: G_FEW },
  theme: { sky: { hor: '#c9dcf2', zen: '#2d64c4' }, fog: '#cfdff1', fogDensity: 0.0009, clear: '#cfdff1', cloudFloor: '#3f6fbf', hemi: ['#e4eefb', '#8a7a62', 0.75], sun: ['#fff2dc', 1.15], ballColor: '#ffffff' },

  build(B) {
    const segs = B.segments, stageOf = (seg, id) => { segs.push(seg); seg.stage = id; seg.stageIdx = B.stages.length - 1; seg.noProgress = true; };
    const X = B.extra.few = { chutes: [], domes: [], extra: [] };
    const reg = g => { X.chutes.push(g); return g; };

    // ── 1) ЛОТОК 32×16, нахиляється до тарілки ──
    const TRAY_L = 32, TRAY_W = 16, HINGE = [-20.5, 3.8, 0];
    const tray = {
      id: 'tray', kind: 'tray', hinge: HINGE.slice(), axis: [0, 0, 1], L: TRAY_L, W: TRAY_W,
      boxes: [
        box([-TRAY_L / 2, -0.25, 0], 0, [TRAY_L / 2, 0.25, TRAY_W / 2], 'floor'),
        box([-TRAY_L / 2, 0.5, TRAY_W / 2 + 0.3], 0, [TRAY_L / 2, 0.75, 0.3]),
        box([-TRAY_L / 2, 0.5, -TRAY_W / 2 - 0.3], 0, [TRAY_L / 2, 0.75, 0.3]),
        box([-TRAY_L - 0.3, 0.5, 0], 0, [0.3, 0.75, TRAY_W / 2 + 0.6]),
      ],
      slots: [], center: [[HINGE[0] - TRAY_L, HINGE[1], 0], HINGE.slice()], length: TRAY_L,
    };
    { const rows = Math.floor((TRAY_L - 1.6) / B.C.TRAY_STEP); for (let r = 0; r < rows; r++) for (let c = 0; c < B.C.TRAY_COLS; c++) tray.slots.push([-(1.85 + r * B.C.TRAY_STEP), B.C.R + 0.05, (c - (B.C.TRAY_COLS - 1) / 2) * B.C.TRAY_STEP]); }
    B.addStage('tray', [tray], () => 12);

    // ── 2) ТАРІЛКА Ø44 З ЛІЙКОЮ → горло Ø5.4 → ніжка-труба ──
    const DC = [0, 0, 0], R_D = 22, R_F = 6.5, R_T = 2.8, Y_RIM = 1.6, Y_TH = -12.5;
    const dprof = [];
    const P = (x, y, mat, hard) => dprof.push({ x, y, mat, hard: !!hard });
    // внутрішня поверхня (пісок): низ труби → горло → «труба-горн» → тарілка → обідок
    P(R_T, Y_TH, 0, true);
    for (let k = 1; k <= 3; k++) P(R_T, Y_TH + (2.5 * k / 3), 0);
    // ухил ніде не нульовий: тарілка — сталий 10% до лійки, далі різкий крутий конус (~70°).
    // Мʼякий горн давав стійкі орбіти біля краю, а пологий широкий — пропускав кульки по черзі,
    // без перемішування (перші ряди лотка вигравали); крутий вузький конус їх перемішує

    for (let k = 1; k <= 12; k++) { const t = k / 12; P(R_T + (R_F - R_T) * t, -10 * (1 - t), 0); }
    for (let k = 1; k <= 10; k++) { const t = k / 10; P(R_F + (R_D - R_F) * t, Y_RIM * t, 0); }
    const RIM = 1.3; // обідок нижче днища лотка (3.3) — лоток проходить над ним
    for (let k = 1; k <= 4; k++) P(R_D, Y_RIM + RIM * k / 4, 0);
    // губа і низ (чорне)
    P(R_D, Y_RIM + RIM, 1, true); P(R_D + 0.45, Y_RIM + RIM + 0.3, 1); P(R_D + 0.9, Y_RIM + RIM, 1);
    P(R_D + 0.9, Y_RIM - 1.0, 1, true);
    for (let k = 1; k <= 10; k++) { const t = k / 10; P(R_D + 0.9 - (R_D - R_F) * t, Y_RIM - 1.0 - 1.6 * Math.pow(t, 0.8), 1); }
    for (let k = 1; k <= 10; k++) { const t = k / 10; P(R_F + 0.9 - (R_F - R_T) * t * 0.98, -2.6 - 8.4 * Math.pow(t, 0.7), 1); }
    P(R_T + 0.9, Y_TH, 1, true);
    const disc = bowlLathe('disc', DC, dprof, 64);
    disc.kind = 'lathe'; disc.plates = latheplates(DC, dprof, 48, 1.0);
    Object.assign(disc, { c: DC.slice(), rDisc: R_D, yRim: Y_RIM, yThroat: Y_TH, center: [HINGE.slice(), [0, 0.3, 0], [0, Y_TH, 0]] });
    disc.length = len(sub(disc.center[1], disc.center[0])) + len(sub(disc.center[2], disc.center[1]));
    B.addStage('disc', [disc], (seg, i) => i === 0 ? 26 : 7);
    // скляний обідок тарілки (рендер + фізика: кульки з лотка не перелітають)
    {
      const gp = []; for (let k = 0; k <= 8; k++) { const a = k / 8 * Math.PI / 2; gp.push({ x: 0, y: Y_RIM + RIM + 0.3 + Math.sin(a) * 3.2, mat: 2 }); }
      const rings = []; const N = 64;
      for (let i = 0; i < N; i++) { const ph = i / N * 2 * Math.PI; rings.push(gp.map((q, k) => [DC[0] + (R_D + 0.6 - k * 0.22) * Math.cos(ph), DC[1] + q.y, DC[2] + (R_D + 0.6 - k * 0.22) * Math.sin(ph)])); }
      // проріз під лотком: скло не там, де кульки заходять (φ ≈ 180°)
      const keep = rings.map((r, i) => { const ph = i / N * 360; return !(ph > 150 && ph < 210); });
      const sub2 = rings.filter((r, i) => keep[i]);
      const refN = (i, j) => { const ph = ((i + 0.5) / N) * 2 * Math.PI; return [-Math.cos(ph), 0, -Math.sin(ph)]; };
      const gm = gridMesh(sub2, gp, { refN, closedJ: false, uAt: i => i });
      X.discGlass = { id: 'discGlass', kind: 'sweep', mesh: gm.phys, noProgress: true, _rend: gm.rend, _glass: true };
      stageOf(X.discGlass, 'disc');
    }
    X.disc = disc;
    // шість низьких радіальних ребер на тарілці: кульці, що котиться до лійки, не заважають,
    // а та, що стала на орбіту (рідко, але кружляла до 90 с), втрачає швидкість і падає в лійку
    {
      const boxes = [], slope = Y_RIM / (R_D - R_F), r0 = R_F + 1.2, r1 = R_D - 1.6, rm = (r0 + r1) / 2;
      for (let k = 0; k < 6; k++) {
        const ph = (30 + k * 60) * D2R, cs = Math.cos(ph), sn = Math.sin(ph);
        const xv = nrm([cs, slope, sn]), zv = [-sn, 0, cs], yv = cross(zv, xv);
        const surf = [DC[0] + rm * cs, DC[1] + Y_RIM * (rm - R_F) / (R_D - R_F), DC[2] + rm * sn];
        boxes.push({ pos: add(surf, mul(yv, 0.02)), quat: quatBasis(xv, yv, zv), size: [(r1 - r0) / 2, 0.2, 0.22], role: 'wall' });
      }
      X.ribs = { id: 'discRibs', kind: 'boxes', boxes, balls: [] };
      stageOf(X.ribs, 'disc');
    }

    // ── 3) ХАБ під горлом (кульки падають ~10 м/с — борти 5 м) і ДОВГИЙ ЖОЛОБ ──
    const HUB_Y = -14.6;
    const hub = reg(chute('hub', [[-4.6, HUB_Y, 0], [10, HUB_Y - 2.0, 0]], { w0: 8, w1: 7, wEase: true, H: 5 }));
    B.addStage('hub', [hub], () => 9);
    const hubCap = { id: 'hubCap', kind: 'boxes', boxes: [box([-4.9, HUB_Y + 1.2, 0], 0, [0.35, 2.2, 5.2])], balls: [] };
    stageOf(hubCap, 'hub'); X.hubCap = hubCap;
    let [x, y] = [hub.end[0] - JE, hub.end[1] - JD];
    // довгий прямий жолоб 220 м, спуск 22 м; наприкінці ледь помітна хвиля
    const c1 = reg(chute('chute1', heights(spline([[x, 0, 0], [x + 20, 0, 0], [x + 160, 0, 0], [x + 186, 0, 1.5], [x + 206, 0, -1.5], [x + 220, 0, 0]], 2), y, y - 22), { w0: 7, H: 3.2, vBank: 11, maxBank: 22 }));
    B.addStage('chute1', [c1], () => 7);

    // ── 4) КУПОЛ 1: 7 → 18 → 7, рівне плато з гребенем, що крутиться ──
    [x, y] = [c1.end[0] - JE, c1.end[1] - JD];
    const b1L = 40, b1 = reg(chute('bulge1', plateauY(y, 1.8, 2.2, 0.3, 0.7, 0.05)(resample([[x, 0, 0], [x + b1L, 0, 0]], 1)), { wFn: bulgeW(7, 18, 7, 0.3, 0.7), H: 3.4 }));
    B.addStage('bulge1', [b1], () => 12);
    X.domes.push(dome('dome1', b1, 1, b1L - 1, w => 1.6 + w * 0.17));
    {
      const sp = makeComb('comb1', b1, x + b1L / 2, 14.2, 7, 0.45, 20 * D2R);
      stageOf(sp, 'bulge1'); X.combs = [sp];
    }
    [x, y] = [b1.end[0] - JE, b1.end[1] - JD];
    const s1 = reg(chute('str1', [[x, y, 0], [x + 26, y - 3.6, 0]], { w0: 7, H: 3 }));
    B.addStage('str1', [s1], () => 7);

    // ── 5) КУПОЛ 2: 7 → 16 → 7 з полем червоних куполів (шахівкою, «пляшкою») ──
    [x, y] = [s1.end[0] - JE, s1.end[1] - JD];
    const b2L = 46, b2 = reg(chute('bulge2', heights(resample([[x, 0, 0], [x + b2L, 0, 0]], 1), y, y - 5.2), { wFn: bulgeW(7, 16, 7, 0.22, 0.78), H: 3.2 }));
    B.addStage('bulge2', [b2], () => 11);
    X.domes.push(dome('dome2', b2, 1, b2L - 1, w => 1.6 + w * 0.17));
    {
      const balls = [], widthAt = k => bulgeW(7, 16, 7, 0.22, 0.78)(k);
      for (let r = 0; r < 11; r++) {
        const k = 0.22 + r * 0.047, px = x + b2L * k, half = widthAt(k) / 2 - 2.3, off = (r & 1) ? 1.45 : 0;
        for (let zz = -half + ((half * 2) % 2.9) / 2 + off; zz <= half + 1e-6; zz += 2.9) {
          if (Math.abs(zz) > half) continue;
          balls.push({ pos: [px - x - b2L / 2, floorAt(b2, px) - 0.36 - floorAt(b2, x + b2L / 2), zz], r: 0.9 });
        }
      }
      const pegs = { id: 'pegs', kind: 'spinner', c: [x + b2L / 2, floorAt(b2, x + b2L / 2), 0], axis: [0, 1, 0], omega: 0, phase: 0, boxes: [], balls, red: true, friction: 0.4, restitution: 0.4 };
      stageOf(pegs, 'bulge2'); X.pegs = pegs;
    }

    // ── 6) ЖОЛОБ 100 м → ТРАМПЛІН (червоний блок з помаранчевим шевроном) ──
    // Трамплін кидає кульку вперед: швидкі долітають до ВЕРХНЬОГО рівня (приземлення →
    // сходинки → хвиляста доріжка), повільніші падають у НИЖНІЙ купол з гребенем, звідки
    // дві смуги йдуть закругленими петлями. Обидва рівні — хвилясті доріжки з кікерами
    // над розривами і фінальний стрибок у чашу. Хто не долетів — вибув
    [x, y] = [b2.end[0] - JE, b2.end[1] - JD];
    const c2pts = heights(spline([[x, 0, 0], [x + 10, 0, 0], [x + 32, 0, 1.2], [x + 54, 0, -1.2], [x + 74, 0, 0], [x + 100, 0, 0]], 2), y, y - 16);
    kick(c2pts, 8, 0.8);
    const c2 = reg(chute('chute2', c2pts, { w0: 7, H: 3, vBank: 11, maxBank: 20 }));
    B.addStage('chute2', [c2], () => 7);
    X.chev = [];
    X.kickers = [];
    // червоний клин на ПРАВІЙ половині жолоба (z > 0): хто котиться по ньому — злітає вище й
    // далі, на верхній рівень; решта зісковзує з краю жолоба вниз, у купол з гребенем
    {
      const xe = c2.end[0], x0 = xe - 4.6, y0 = floorAt(c2, x0) + 0.02, y1 = floorAt(c2, xe) + 1.7;
      const L = Math.hypot(xe - x0, y1 - y0), a = Math.atan2(y1 - y0, xe - x0), th = 0.3;
      const nx = -Math.sin(a), ny = Math.cos(a);
      const wedge = { id: 'kickWedge', kind: 'boxes', balls: [], boxes: [{ pos: [(x0 + xe) / 2 - nx * th / 2, (y0 + y1) / 2 - ny * th / 2, 1.8], quat: [0, 0, Math.sin(a / 2), Math.cos(a / 2)], size: [L / 2, th / 2, 1.6], role: 'wall' }] };
      stageOf(wedge, 'chute2'); X.wedge = wedge;
    }
    const R0 = c2.end.slice(), xr = R0[0], yr = R0[1];
    X.ramp1 = { end: R0.slice() };
    const XE = xr + 220, YE = yr - 36;            // кінці всіх доріжок: трамплін у чашу
    const aux = (g, id) => { segs.push(g); g.stage = id; g.noProgress = true; return g; };
    const branchCenters = { up: [R0.slice()], L: [R0.slice()], R: [R0.slice()] };
    const addC = (key, g, from) => { for (const p of g.center) if (!from || p[0] >= from) branchCenters[key].push(p.slice()); };
    // кікер над розривом: хвіст жолоба піднімається, далі розрив GAP і наступний шматок нижче на DROP
    const GAP = 8, GDROP = 1.5, KH = 1.2;

    // ── 7) ВЕРХНІЙ РІВЕНЬ: широке приземлення → 6 сходинок → хвиля → кікер → хвиля ──
    const upLand = reg(chute('upLand', [[xr + 11, yr - 1.5, 0], [xr + 35, yr - 4, 0]], { w0: 10, w1: 5.4, wEase: true, H: 3.6 }));
    aux(upLand, 'paths'); addC('up', upLand);
    let sx = upLand.end[0] - JE, sy = upLand.end[1] - 1.1;
    X.steps = [];
    for (let k = 0; k < 6; k++) {
      const st = reg(chute('step' + (k + 1), [[sx, sy, 0], [sx + 7, sy - 0.35, 0]], { w0: 5.4, H: 2.6 }));
      aux(st, 'paths'); addC('up', st); X.steps.push(st);
      sx = st.end[0] - JE; sy = st.end[1] - 1.1;   // сходинка: наступний — на 1.1 м нижче
    }
    const xw = sx, yw = sy + 1.1 - JD;
    const w1pts = heights(spline([[xw, 0, 0], [xw + 8, 0, 0], [xw + 26, 0, 3], [xw + 46, 0, -3], [xw + 66, 0, 0], [xr + 150, 0, 0]], 2), yw, yr - 25);
    kick(w1pts, 7, KH);
    const upW1 = reg(chute('upWave1', w1pts, { w0: 4.6, t: 0.7, H: 2.4, vBank: 9, maxBank: 24 }));
    aux(upW1, 'paths'); addC('up', upW1);
    const g1 = upW1.end, w2s = [g1[0] + GAP, g1[1] - GDROP, 0];
    const w2pts = heights(spline([w2s, [w2s[0] + 10, 0, 0], [w2s[0] + 26, 0, -2.5], [w2s[0] + 40, 0, 2.5], [XE - 16, 0, 0], [XE, 0, 0]], 2), w2s[1], YE - 1.6);
    kick(w2pts, 8, 1.6);
    const upW2 = reg(chute('upWave2', w2pts, { w0: 4.6, t: 0.7, H: 2.4, vBank: 9, maxBank: 24 }));
    aux(upW2, 'paths'); addC('up', upW2);
    // золоті шеврони на прямій перед трампліном у чашу: без них хвиля з віражами гасила швидкість до 9 м/с
    X.chev.push({ seg: upW2, s: upW2.length - 3.5 }); B.zone('boost', upW2, upW2.length - 3.5, { len: 5, vt: 14, acc: 34, noGfx: true });
    X.kickers.push({ seg: upW1, s: upW1.length - 3 }, { seg: upW2, s: upW2.length - 3 });

    // ── 8) НИЖНІЙ РІВЕНЬ: купол з гребенем під трампліном → дві смуги з петлями ──
    const LANE_W = 4.4, LT = 0.7, PITCH = LANE_W + 2 * LT, FOOT2 = 2 * PITCH - 2 * LT;
    const bx0 = xr - 3, by0 = yr - 9.5, b3L = 46;
    const b3 = reg(chute('bulge3', plateauY(by0, 1.6, 1.2, 0.3, 0.7, 0.05)(resample([[bx0, 0, 0], [bx0 + b3L, 0, 0]], 1)),
      { wFn: k => k < 0.3 ? 13 + 7 * ease(k / 0.3) : (k > 0.7 ? 20 + (FOOT2 - 20) * ease((k - 0.7) / 0.3) : 20), H: 3.6 }));
    aux(b3, 'paths'); addC('L', b3, xr + 2); addC('R', b3, xr + 2);
    // скло лише над другою половиною: зверху в першу падають кульки з трампліна
    X.domes.push(dome('dome3', b3, b3L * 0.4, b3L - 1, w => 1.4 + w * 0.15));
    { const sp = makeComb('comb2', b3, bx0 + b3L * 0.52, 15.6, 8, -0.85, 70 * D2R); aux(sp, 'paths'); X.combs.push(sp); }
    // задня стінка купола (під трампліном)
    const b3cap = { id: 'b3cap', kind: 'boxes', boxes: [box([bx0 - 0.35, by0 + 1.6, 0], 0, [0.35, 2.4, 7.5])], balls: [] };
    aux(b3cap, 'paths'); X.capBoxes = [X.hubCap.boxes[0], b3cap.boxes[0]];
    const LX = b3.end[0] - JE, LY = b3.end[1] - JD, LZ = [-PITCH / 2, PITCH / 2];
    X.lanes = [];
    for (const [k, key] of [[0, 'L'], [1, 'R']]) {
      const sg = k ? 1 : -1, z0 = LZ[k], zo = sg * 13, zi = sg * 10.5;
      const fan = spline([[LX, 0, z0], [LX + 6, 0, z0], [LX + 20, 0, (z0 + zo) / 2], [LX + 34, 0, zo], [LX + 40, 0, zo]], 2);
      const loop = path(LX + 40, zo, 0).fwd(8).arc(sg * 360, 8).fwd(10).pts;
      const back = spline([[LX + 58, 0, zo], [LX + 66, 0, zo], [LX + 80, 0, zi + sg * 2], [LX + 94, 0, zi], [xr + 150, 0, zi]], 2);
      const aPts = heights(fan.concat(loop.slice(1), back.slice(1)), LY, yr - 25);
      kick(aPts, 7, KH);
      const la = reg(chute('lane' + key + 'a', aPts, { w0: LANE_W, t: LT, H: 2.4, vBank: 10, maxBank: 28 }));
      aux(la, 'paths'); addC(key, la);
      const s2 = [la.end[0] + GAP, la.end[1] - GDROP, zi];
      const bPts = heights(spline([s2, [s2[0] + 10, 0, zi], [s2[0] + 22, 0, zi + sg * 3], [s2[0] + 40, 0, zi + sg * 1], [XE - 16, 0, zi], [XE, 0, zi]], 2), s2[1], YE - 1.6);
      kick(bPts, 8, 1.6);
      const lb = reg(chute('lane' + key + 'b', bPts, { w0: LANE_W, t: LT, H: 2.4, vBank: 10, maxBank: 28 }));
      aux(lb, 'paths'); addC(key, lb);
      X.lanes.push(la, lb);
      X.chev.push({ seg: lb, s: lb.length - 3.5 }); B.zone('boost', lb, lb.length - 3.5, { len: 5, vt: 14, acc: 34, noGfx: true });
      X.kickers.push({ seg: la, s: la.length - 3 }, { seg: lb, s: lb.length - 3 });
      // після петлі — шеврон (петля гасить швидкість); над розривом без розгону: повільні не перескочать
      X.chev.push({ seg: la, s: 30 }, { seg: la, s: 100 });
      B.zone('boost', la, 30, { len: 4, vt: 11, acc: 20, noGfx: true });
      B.zone('boost', la, 100, { len: 4, vt: 11, acc: 20, noGfx: true });
    }
    {
      const noses = { id: 'laneNoses', kind: 'boxes', boxes: [box([LX, LY + 0.9, 0], Math.PI / 4, [LT, 1.2, LT], 'wedge')], balls: [] };
      aux(noses, 'paths'); X.noses = noses;
    }
    // прогрес: три гілки (верх, ліва, права) — віртуальні осі крізь усі шматки й розриви
    const branch = (id, pts) => { const g = { id, kind: 'gap', center: pts, length: 0, start: pts[0].slice(), end: pts[pts.length - 1].slice() }; for (let i = 1; i < pts.length; i++) g.length += len(sub(pts[i], pts[i - 1])); return g; };
    B.addStage('paths', [branch('pathUp', branchCenters.up), branch('pathL', branchCenters.L), branch('pathR', branchCenters.R)], () => 13);
    X.stepEdges = X.steps.map(s => ({ seg: s, s: s.length - 1.2 }));
    const rampY = YE;
    const LANE_END = XE;

    // ── 9) ПОЛІТ У ФІНІШНУ ЧАШУ 26×26 над прірвою ──
    const BOWL = 26, BOWL_GAP = 22, BOWL_DROP = 13, BW_H = 4.5, TILT = 0.06;
    const bX = LANE_END + BOWL_GAP + BOWL / 2, bY = rampY - BOWL_DROP;
    const gap2 = { id: 'gap2', kind: 'gap', center: [[LANE_END, rampY, 0], [LANE_END + BOWL_GAP, bY, 0]], length: Math.hypot(BOWL_GAP, BOWL_DROP), start: [LANE_END, rampY, 0], end: [LANE_END + BOWL_GAP, bY, 0] };
    B.addStage('gap2', [gap2], () => 25);
    const ta = Math.atan(TILT);
    const bowl = {
      id: 'bowl', kind: 'boxes', balls: [], boxes: [
        { pos: [bX, bY - 0.3, 0], quat: [0, 0, Math.sin(-ta / 2), Math.cos(-ta / 2)], size: [BOWL / 2 + 0.6, 0.3, BOWL / 2 + 0.6], role: 'floor' },
        box([bX + BOWL / 2 + 0.5, bY + BW_H / 2 - 0.6, 0], 0, [0.5, BW_H / 2 + 0.6, BOWL / 2 + 1]),
        box([bX, bY + BW_H / 2 - 0.5, BOWL / 2 + 0.5], 0, [BOWL / 2 + 1, BW_H / 2 + 0.5, 0.5]),
        box([bX, bY + BW_H / 2 - 0.5, -BOWL / 2 - 0.5], 0, [BOWL / 2 + 1, BW_H / 2 + 0.5, 0.5]),
        box([bX - BOWL / 2 - 0.5, bY + BW_H / 2 - 0.2, 0], 0, [0.5, BW_H / 2 + 0.2, BOWL / 2 + 1]),
      ],
      size: BOWL, c: [bX, bY, 0], wallH: BW_H,
      center: [[bX - BOWL / 2, bY + TILT * BOWL / 2, 0], [bX + BOWL / 2, bY - TILT * BOWL / 2, 0]], length: BOWL,
    };
    B.addStage('bowl', [bowl], () => 20);
    X.bowl = bowl;
    // сенсор біля дальнього борту: недолетілі (впали перед чашею) і перелетілі не рахуються
    B.finish = { p: [bX + BOWL / 2 - 1.2, bY - TILT * BOWL / 2 + 0.6, 0], f: [-1, 0, 0], r: 14.5, s: B.S() };
    B.tray = tray;
    B.extra.disc = disc;
    B.extra.orbit = bowl.c.slice();
    X.laneEnd = [LANE_END, rampY, 0];
    // куполи — фізика (кульки від гребеня не вилітають за борт), без прогресу
    for (const d of X.domes) stageOf(d, 'bulge1');
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W]);
  },

  intro(track, pos, look) {
    const H = track.tray.hinge;
    pos.set(H[0] - 46, H[1] + 24, H[2] - 30);
    look.set(H[0] + 6, H[1] - 2, H[2] + 4);
  },

  // спецплани: тарілка, під тарілкою (горло → хаб), політ через провал, підліт до чаші
  camera(st, leader, pos, look) {
    const track = st.track, X = track.extra.few, s = leader.prog;
    if (!X.sIdx) { X.sIdx = {}; for (const g of track.stages) X.sIdx[g.id] = g; }
    const S = X.sIdx, d = X.disc;
    if (s < S.hub.s0 - 2) { pos.set(d.c[0] - 30, d.c[1] + 18, d.c[2] - 20); look.set(d.c[0], d.c[1] - 5, d.c[2]); return true; }
    if (s < S.chute1.s0 + 26) { pos.set(leader.x - 6, d.yThroat - 1, -36); look.set(leader.x + 10, leader.y - 1, 0); return true; }
    // трамплін: збоку видно і верхнє приземлення, і нижній купол
    if (s >= S.chute2.s1 - 14 && s < S.paths.s0 + 26) { const r = X.ramp1.end; pos.set(r[0] + 2, r[1] + 4, 46); look.set(r[0] + 12, r[1] - 6, 0); return true; }
    if (s >= S.paths.s1 - 16) { const e = X.laneEnd; pos.set(e[0] - 4, e[1] + 15, 56); look.set(e[0] + 22, e[1] - 8, 0); return true; }
    return false;
  },

  // ═══ РЕНДЕР ═══
  decor(track, ctx) {
    const { THREE, scene } = ctx, X = track.extra.few, M = fewMats(THREE, ctx.env, ctx.renderer);
    const matsFor = [M.sand, M.dark, M.glass];
    const add3 = (geo, mats, shadow) => { const m = new THREE.Mesh(geo, mats); m.castShadow = !!shadow; m.receiveShadow = !!shadow; scene.add(m); return m; };
    // жолоби + торці
    for (const g of X.chutes) {
      add3(rendMesh(THREE, g._rend), matsFor, true);
      const c = g._cap;
      add3(capGeo(THREE, c.prof0, c.f0, true), M.darkDS, true);
      add3(capGeo(THREE, c.profN, c.fN, false), M.darkDS, true);
    }
    add3(rendMesh(THREE, X.disc._rend), matsFor, true);
    // скло (тарілка + куполи) — без тіней, після непрозорого
    for (const g of [X.discGlass].concat(X.domes)) { const m = add3(rendMesh(THREE, g._rend), M.glass, false); m.renderOrder = 5; }
    // логотип на тарілці: кільцева смуга по поверхні (планарні uv)
    {
      const d = X.disc, NS = 72, r0 = 7.2, r1 = 21.2, rings = 6;
      const yAt = r => clamp((r - 6.5) / 15.5, 0, 1) * d.yRim + 0.05;
      const pos = [], uv = [], idx = [];
      for (let k = 0; k <= NS; k++) for (let j = 0; j <= rings; j++) {
        const ph = k / NS * 2 * Math.PI, r = r0 + (r1 - r0) * j / rings, xx = d.c[0] + r * Math.cos(ph), zz = d.c[2] + r * Math.sin(ph);
        pos.push(xx, d.c[1] + yAt(r), zz); uv.push((zz - d.c[2]) / 44 + 0.5, (xx - d.c[0]) / 44 + 0.5);
      }
      for (let k = 0; k < NS; k++) for (let j = 0; j < rings; j++) { const a = k * (rings + 1) + j, b = a + 1, c = a + rings + 1, e = c + 1; idx.push(a, b, c, b, e, c); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, M.logo); m.renderOrder = 1; m.receiveShadow = true; scene.add(m);
    }
    // лоток: пісок зверху, чорні борти і низ, шаховка START біля краю
    if (ctx.trayGroup) {
      const tr = track.tray, L = tr.L, W = tr.W;
      const floor = new THREE.Mesh(new THREE.BoxGeometry(L, 0.5, W), [M.dark, M.dark, M.sand, M.dark, M.dark, M.dark]);
      floor.position.set(-L / 2, -0.25, 0); floor.castShadow = floor.receiveShadow = true; ctx.trayGroup.add(floor);
      const uvA = floor.geometry.getAttribute('uv'); for (let i = 8; i < 12; i++) uvA.setXY(i, uvA.getX(i) * L / 3, uvA.getY(i) * W / 3);
      for (const [px, pz, sx, sz] of [[-L / 2, W / 2 + 0.3, L, 0.6], [-L / 2, -W / 2 - 0.3, L, 0.6], [-L - 0.3, 0, 0.6, W + 1.2]]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.5, sz), M.dark); wall.position.set(px, 0.5, pz); wall.castShadow = true; ctx.trayGroup.add(wall);
      }
      const st = new THREE.Mesh(new THREE.PlaneGeometry(W - 1.2, 2.2), M.start); st.rotation.set(-Math.PI / 2, 0, Math.PI / 2); st.position.set(-1.8, 0.02, 0); ctx.trayGroup.add(st);
    }
    // хаб: задня стінка
    for (const b of X.ribs.boxes) { const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2), M.sand); m.position.set(...b.pos); m.quaternion.set(...b.quat); m.castShadow = m.receiveShadow = true; scene.add(m); }
    for (const b of X.capBoxes) { const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2), M.dark); m.position.set(...b.pos); m.castShadow = true; scene.add(m); }
    // кікери: червоний блок поперек губи + помаранчевий шеврон на підлозі (як у відео)
    const onSeg = (seg, sl) => { const F = seg.frames; let i = 0; while (i + 1 < F.length && F[i + 1].s < sl) i++; const f = F[i]; const g = new THREE.Group(); g.position.set(...add(f.p, mul(f.u, 0.05))); g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.t), new THREE.Vector3(...f.u), new THREE.Vector3(...f.r))); scene.add(g); return { g, f }; };
    // клин трампліна: червоний, з помаранчевим шевроном на верхній грані
    {
      const b = X.wedge.boxes[0], g = new THREE.Group(); g.position.set(...b.pos); g.quaternion.set(...b.quat); scene.add(g);
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2), M.red); m.castShadow = m.receiveShadow = true; g.add(m);
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(b.size[0] * 1.6, b.size[2] * 1.7), M.chev); pl.rotation.x = -Math.PI / 2; pl.position.y = b.size[1] + 0.02; g.add(pl);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(b.size[0] * 2, b.size[2] * 2), M.goldGlow); glow.rotation.x = -Math.PI / 2; glow.position.y = b.size[1] + 0.01; g.add(glow);
    }
    for (const k of X.kickers) {
      const { g, f } = onSeg(k.seg, k.s);
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(2.6, f.w * 0.8), M.chev); pl.rotation.x = -Math.PI / 2; g.add(pl);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, f.w), M.goldGlow); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.03; g.add(glow);
      for (const sd of [-1, 1]) { const blk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.6), M.red); blk.position.set(0.4, k.seg.H + 0.2, sd * (f.w / 2 + 0.4)); blk.rotation.z = -0.25; g.add(blk); }
    }
    // край кожної сходинки — золота смуга, що світиться
    for (const e of X.stepEdges) {
      const { g, f } = onSeg(e.seg, e.s);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.08, f.w * 0.95), M.gold); g.add(bar);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.2, f.w), M.goldGlow); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.02; g.add(glow);
    }
    // гребені: червона балка з арками (Shape + extrude) + «гачок» зверху по центру
    for (const sp of X.combs) {
      const grp = ctx.spinners[sp.id]; if (!grp) continue;
      const cb = sp.comb, tw = (cb.L - cb.n * cb.aw) / (cb.n + 1);
      const sh = new THREE.Shape();
      sh.moveTo(-cb.L / 2, 0);
      for (let k = 0; k < cb.n; k++) {
        const x0 = -cb.L / 2 + tw + k * (tw + cb.aw), r = cb.aw / 2;
        sh.lineTo(x0, 0); sh.lineTo(x0, cb.ah - r); sh.absarc(x0 + r, cb.ah - r, r, Math.PI, 0, true); sh.lineTo(x0 + cb.aw, 0);
      }
      sh.lineTo(cb.L / 2, 0); sh.lineTo(cb.L / 2, cb.Hc); sh.lineTo(-cb.L / 2, cb.Hc); sh.lineTo(-cb.L / 2, 0);
      const geo = new THREE.ExtrudeGeometry(sh, { depth: cb.th, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 2, curveSegments: 10 });
      geo.translate(0, 0, -cb.th / 2);
      const tilt = new THREE.Group(); if (sp.tilt) tilt.quaternion.set(sp.tilt[0], sp.tilt[1], sp.tilt[2], sp.tilt[3]); grp.add(tilt);
      const m = new THREE.Mesh(geo, M.red); m.castShadow = m.receiveShadow = true; tilt.add(m);
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.09, 8, 16, Math.PI * 1.4), M.red); hook.position.set(0, cb.Hc + 0.4, 0); hook.rotation.y = Math.PI / 2; tilt.add(hook);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.5, 8), M.red); post.position.set(0, cb.Hc + 0.15, 0); tilt.add(post);
    }
    // поле куполів: червоні півсфери (видима частина над підлогою)
    {
      const grp = ctx.spinners[X.pegs.id];
      if (grp) {
        const cap = new THREE.SphereGeometry(0.9, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.42);
        const inst = new THREE.InstancedMesh(cap, M.red, X.pegs.balls.length), mt = new THREE.Matrix4();
        X.pegs.balls.forEach((b, i) => { mt.makeTranslation(b.pos[0], b.pos[1], b.pos[2]); inst.setMatrixAt(i, mt); });
        inst.castShadow = inst.receiveShadow = true; grp.add(inst);
      }
    }
    // носи розділових стінок смуг
    for (const b of X.noses.boxes) { const m = new THREE.Mesh(new THREE.BoxGeometry(b.size[0] * 2, b.size[1] * 2, b.size[2] * 2), M.dark); m.position.set(...b.pos); m.quaternion.set(...b.quat); scene.add(m); }
    // шеврони: золота наліпка на підлозі + червоний клин збоку + світіння
    for (const c of X.chev) {
      const F = c.seg.frames; let i = 0; while (i + 1 < F.length && F[i + 1].s < c.s) i++;
      const f = F[i], basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.t), new THREE.Vector3(...f.u), new THREE.Vector3(...f.r));
      const q = new THREE.Quaternion().setFromRotationMatrix(basis);
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(3.4, f.w * 0.85), M.chev); pl.rotation.x = -Math.PI / 2;
      const g = new THREE.Group(); g.position.set(...add(f.p, mul(f.u, 0.05))); g.quaternion.copy(q); g.add(pl);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(4.2, f.w), M.goldGlow); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.04; g.add(glow);
      const wedge = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.5), M.red); wedge.position.set(-2.4, c.seg.H + 0.35, -(f.w / 2 + 0.35)); wedge.rotation.z = 0.35; g.add(wedge);
      scene.add(g);
    }
    // фінішна чаша: пісок на дні, чорні борти, LED по верху
    {
      const b = X.bowl, S = b.size;
      for (const bx of b.boxes) {
        const isFloor = bx.role === 'floor';
        const geo = new THREE.BoxGeometry(bx.size[0] * 2, bx.size[1] * 2, bx.size[2] * 2);
        const m = new THREE.Mesh(geo, isFloor ? [M.dark, M.dark, M.sand, M.dark, M.dark, M.dark] : M.dark);
        if (isFloor) { const uvA = geo.getAttribute('uv'); for (let i = 8; i < 12; i++) uvA.setXY(i, uvA.getX(i) * S / 3, uvA.getY(i) * S / 3); }
        m.position.set(...bx.pos); m.quaternion.set(...bx.quat); m.castShadow = m.receiveShadow = true; scene.add(m);
        if (!isFloor) {
          const long = bx.size[0] > bx.size[2] ? 0 : 2, L = bx.size[long] * 2;
          const led = new THREE.Mesh(new THREE.PlaneGeometry(L, 1.0), M.led);
          led.material.map.repeat.set(1, 1);
          const uvL = led.geometry.getAttribute('uv'); for (let i = 0; i < uvL.count; i++) uvL.setX(i, uvL.getX(i) * L / 8);
          led.rotation.x = -Math.PI / 2; if (long === 2) led.rotation.z = Math.PI / 2;
          led.position.set(bx.pos[0], bx.pos[1] + bx.size[1] + 0.02, bx.pos[2]); scene.add(led);
        }
      }
    }
  },
};
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
