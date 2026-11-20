// Аналіз GLB карти: (1) z-fighting — копланарні трикутники різних мешів, що перекриваються;
// (2) взаємопроникнення — трикутники різних обʼєктів, що перетинаються.
// node tools/mb-glb-clip.mjs public/models/marbles/<id>.glb   (великий файл: node --max-old-space-size=6000 …)
import fs from 'node:fs';
const file = process.argv[2];
const buf = fs.readFileSync(file);
const jl = buf.readUInt32LE(12); const J = JSON.parse(buf.slice(20, 20 + jl).toString());
const binOff = 20 + jl + 8; const BIN = buf.slice(binOff);
const acc = i => {
  const a = J.accessors[i], bv = J.bufferViews[a.bufferView];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const C = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
  const stride = bv.byteStride;
  if (stride && stride !== n * C.BYTES_PER_ELEMENT) throw new Error('stride');
  return new C(BIN.buffer.slice(BIN.byteOffset + off, BIN.byteOffset + off + a.count * n * C.BYTES_PER_ELEMENT));
};
const mmul = (a, b) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const trs = n => {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
};
const tris = []; // {o, mat, p:[9]}
const walk = (ni, M) => {
  const n = J.nodes[ni], W = mmul(M, trs(n));
  if (n.mesh != null) for (const pr of J.meshes[n.mesh].primitives) {
    const P = acc(pr.attributes.POSITION), I = pr.indices != null ? acc(pr.indices) : null;
    const v = k => { const x = P[k * 3], y = P[k * 3 + 1], z = P[k * 3 + 2]; return [W[0] * x + W[4] * y + W[8] * z + W[12], W[1] * x + W[5] * y + W[9] * z + W[13], W[2] * x + W[6] * y + W[10] * z + W[14]]; };
    const cnt = I ? I.length : P.length / 3;
    const mat = pr.material != null ? J.materials[pr.material].name : '';
    for (let t = 0; t < cnt; t += 3) { const a = v(I ? I[t] : t), b = v(I ? I[t + 1] : t + 1), c = v(I ? I[t + 2] : t + 2); tris.push({ o: n.name, mat, a, b, c }); }
  }
  for (const c of n.children || []) walk(c, W);
};
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (const r of J.scenes[J.scene || 0].nodes) walk(r, I4);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
for (const t of tris) {
  const n = cross(sub(t.b, t.a), sub(t.c, t.a)), L = Math.hypot(...n); t.area = L / 2; t.n = L ? n.map(x => x / L) : [0, 0, 0];
  t.min = [0, 1, 2].map(i => Math.min(t.a[i], t.b[i], t.c[i])); t.max = [0, 1, 2].map(i => Math.max(t.a[i], t.b[i], t.c[i]));
  t.cen = [0, 1, 2].map(i => (t.a[i] + t.b[i] + t.c[i]) / 3);
}
const T = tris.filter(t => t.area > 1e-4);
// spatial hash
const CS = 2.0, H = new Map();
T.forEach((t, i) => { for (let x = Math.floor(t.min[0] / CS); x <= Math.floor(t.max[0] / CS); x++) for (let y = Math.floor(t.min[1] / CS); y <= Math.floor(t.max[1] / CS); y++) for (let z = Math.floor(t.min[2] / CS); z <= Math.floor(t.max[2] / CS); z++) { const k = x + ',' + y + ',' + z; let a = H.get(k); if (!a) H.set(k, a = []); a.push(i); } });
// 2D overlap of coplanar triangles: test centroid-in-triangle or edge-overlap approx via SAT on plane projection
function projOverlap(t, u) {
  // project onto plane of t using dominant axis
  const ax = t.n.map(Math.abs); const k = ax[0] > ax[1] ? (ax[0] > ax[2] ? 0 : 2) : (ax[1] > ax[2] ? 1 : 2); const i0 = (k + 1) % 3, i1 = (k + 2) % 3;
  const P = tt => [[tt.a[i0], tt.a[i1]], [tt.b[i0], tt.b[i1]], [tt.c[i0], tt.c[i1]]];
  const A = P(t), B = P(u);
  const axes = []; for (const Q of [A, B]) for (let e = 0; e < 3; e++) { const p = Q[e], q = Q[(e + 1) % 3]; axes.push([q[1] - p[1], p[0] - q[0]]); }
  let minPen = 1e9;
  for (const a of axes) { const L = Math.hypot(a[0], a[1]); if (L < 1e-9) continue; const pa = A.map(p => (p[0] * a[0] + p[1] * a[1]) / L), pb = B.map(p => (p[0] * a[0] + p[1] * a[1]) / L);
    const pen = Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)); if (pen <= 0.02) return 0; minPen = Math.min(minPen, pen); }
  return minPen;
}
// triangle-triangle intersection (Möller, спрощено: відрізок перетину довжиною)
function triSeg(t, u) {
  const d = p => dot(sub(p, u.a), u.n); const da = d(t.a), db = d(t.b), dc = d(t.c);
  if ((da > 1e-3 && db > 1e-3 && dc > 1e-3) || (da < -1e-3 && db < -1e-3 && dc < -1e-3)) return 0;
  const e = q => dot(sub(q, t.a), t.n); const ea = e(u.a), eb = e(u.b), ec = e(u.c);
  if ((ea > 1e-3 && eb > 1e-3 && ec > 1e-3) || (ea < -1e-3 && eb < -1e-3 && ec < -1e-3)) return 0;
  // точки перетину ребер t з площиною u
  const pts = []; const E = [[t.a, t.b, da, db], [t.b, t.c, db, dc], [t.c, t.a, dc, da]];
  for (const [p, q, dp, dq] of E) if (dp * dq < 0) { const s = dp / (dp - dq); pts.push([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s]); }
  if (pts.length < 2) return 0;
  // обрізати відрізок трикутником u (барицентрично, грубо: частка точок усередині)
  const inside = p => { const c1 = dot(cross(sub(u.b, u.a), sub(p, u.a)), u.n), c2 = dot(cross(sub(u.c, u.b), sub(p, u.b)), u.n), c3 = dot(cross(sub(u.a, u.c), sub(p, u.c)), u.n); return c1 >= -1e-4 && c2 >= -1e-4 && c3 >= -1e-4; };
  let L = 0; const N = 6; for (let s = 0; s < N; s++) { const f0 = s / N, f1 = (s + 1) / N, m = (f0 + f1) / 2; const p = pts[0].map((x, i) => x + (pts[1][i] - x) * m); if (inside(p)) L += Math.hypot(...sub(pts[1], pts[0])) / N; }
  return L;
}
const zf = new Map(), ix = new Map(), seen = new Set();
const grp = s => s.replace(/\.\d+$/, '').replace(/_\d+$/, '');
for (const arr of H.values()) for (let p = 0; p < arr.length; p++) for (let q = p + 1; q < arr.length; q++) {
  const i = arr[p], j = arr[q], t = T[i], u = T[j];
  if (t.o === u.o) continue;
  const key = i < j ? i * 1e7 + j : j * 1e7 + i; if (seen.has(key)) continue; seen.add(key);
  if (t.max[0] < u.min[0] || u.max[0] < t.min[0] || t.max[1] < u.min[1] || u.max[1] < t.min[1] || t.max[2] < u.min[2] || u.max[2] < t.min[2]) continue;
  const pair = [t.o, u.o].sort().join(' × ');
  const nd = Math.abs(dot(t.n, u.n));
  if (nd > 0.995 && Math.abs(dot(sub(u.cen, t.a), t.n)) < 0.025) {
    const pen = projOverlap(t, u); if (pen > 0) { const r = zf.get(pair) || { n: 0, area: 0, at: t.cen, mats: t.mat + '/' + u.mat }; r.n++; r.area += Math.min(t.area, u.area); zf.set(pair, r); }
  } else {
    const L = triSeg(t, u) + triSeg(u, t); if (L > 0.05) { const r = ix.get(pair) || { len: 0, at: t.cen, mats: t.mat + '/' + u.mat }; r.len += L / 2; ix.set(pair, r); }
  }
}
const f1 = x => Math.round(x * 10) / 10;
console.log('FILE', file, 'tris', T.length);
console.log('Z-FIGHT (копланарні перекриття):');
for (const [k, r] of [...zf].sort((a, b) => b[1].area - a[1].area).slice(0, 25)) console.log('  ', k, '| площа', f1(r.area), '| ', r.mats, '| біля', r.at.map(f1).join(','));
console.log('ПРОНИКНЕННЯ (довжина лінії перетину, м):');
for (const [k, r] of [...ix].sort((a, b) => b[1].len - a[1].len).slice(0, 40)) console.log('  ', k, '|', f1(r.len), '| ', r.mats, '| біля', r.at.map(f1).join(','));
