// ─────────────────────────────────────────────────────────────
//  💥 Карта «Закатные пушки» — ВЛАСНА траса з Blender (blender/marbles_canyon.blend).
//  Маршрут: лоток → широкий жолоб → спіраль довкола вежі → рампа → ГАРМАТА 1
//  (постріл через прірву в чашу-вирву; хто не долетів — вибуває) → серпантин з
//  віражами → рампа → ГАРМАТА 2 (постріл у фінішну чашу).
//  Звідти два файли: canyon_phys.json (фізика, осьові лінії, профілі чаш, гармати)
//  і canyon.glb (показ). Тут — склейка з рушієм: лоток, стадії, гармати, камера, показ.
// ─────────────────────────────────────────────────────────────
(function () {
const PHYS_URL = '/assets/models/marbles/canyon_phys.json';
const GLB_URL = '/assets/models/marbles/canyon.glb?v=20261118';   // ?v= — змінюй після переекспорту моделі
let DATA = null, GLB_SCENE = null, GLB_PROM = null;
const G = 12;                                   // гравітація рушія (MB_G)
// гармати: spread — радіус розкиду точки приземлення; maxMiss — частка поля, яку гармата може «вбити»
const CN = { trigR: 2.6, c1: { spread: 10.2, maxMiss: 0.2 }, c2: { spread: 9.6, maxMiss: 0.12 }, safeR: 5.5, catchR: 9.2, damp: 0.25, aimUp: 4.5, gap: 0.09 };

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
  if (!DATA) throw new Error('Закатные пушки: дані траси ще не завантажені');
  return DATA;
}
function quatBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2], tr = m00 + m11 + m22;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S]; }
  if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; return [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S]; }
  if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S]; }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2; return [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
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
// точки номінальної дуги пострілу (для осі стадії «стрибок» і камери)
function arc(c, n) {
  const F = c.flight, M = c.muzzle, T = c.target, v = [(T[0] - M[0]) / F, (T[1] - M[1]) / F + 0.5 * G * F, (T[2] - M[2]) / F], out = [];
  for (let i = 0; i <= n; i++) { const t = F * i / n; out.push([M[0] + v[0] * t, M[1] + v[1] * t - 0.5 * G * t * t, M[2] + v[2] * t]); }
  return out;
}

const MAP = {
  id: 'canyon',
  name: 'Закатные пушки',
  icon: '💥',
  approxSec: 60,
  desc: 'Спираль вокруг башни, две пушки над каньоном: кто не долетел до чаши — выбывает.',
  eliminate: true,
  customRender: true,
  theme: { sky: { hor: '#ff9a5c', zen: '#2b1438' }, fog: '#a8553e', fogDensity: 0.0014, clear: '#a8553e', cloudFloor: '#7a3324', hemi: ['#ffd8b8', '#4a2030', 0.8], sun: ['#ffb37a', 1.15] },

  preload() {
    if (DATA) return Promise.resolve();
    return fetch(PHYS_URL).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(j => { DATA = j; });
  },

  build(B) {
    const D = data();
    const X = B.extra.canyon = { cannons: [] };
    const sweep = s => ({ id: s.id, kind: 'sweep', mesh: meshOf(s.v, s.i), center: s.center, length: polyLen(s.center),
      start: s.center[0].slice(), end: s.center[s.center.length - 1].slice(), branch: s.branch || 0 });
    // лоток 32×16, нахиляється до стартового жолоба
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
    const L = id => D.lathes.find(l => l.id === id);
    const groups = [];
    for (const s of D.segs) { let g = groups.find(q => q.stage === s.stage); if (!g) groups.push(g = { stage: s.stage, segs: [] }); g.segs.push(sweep(s)); }
    const TOL = { start: 9, lead: 5, helix: 4.8, ramp1: 5, serp: 7, ramp2: 5 };
    const leapStage = (id, c) => {
      const pts = arc(c, 10);
      const seg = { id, kind: 'boxes', boxes: [], balls: [], center: pts, length: polyLen(pts), start: pts[0].slice(), end: pts[pts.length - 1].slice() };
      B.addStage(id, [seg], () => 18);
    };
    const lathe = (id, l, center, tol) => {
      const seg = { id, kind: 'lathe', c: l.center, plates: lathePlates(l.center, l.prof, 48, 1.0), center };
      seg.length = polyLen(center); B.addStage(id, [seg], () => tol); return seg;
    };
    for (const g of groups) {
      B.addStage(g.stage, g.segs, () => TOL[g.stage] || 6);
      if (g.stage === 'ramp1') {
        const c = Object.assign({ k: 1 }, D.cannons.c1, CN.c1); X.cannons.push(c); leapStage('leap1', c);
        const b = D.bowl1, bc = b.c;
        X.bowl1 = lathe('bowl1', L('F_bowl1'), [[bc[0], bc[1] + 1, bc[2]], [bc[0], b.throat, bc[2]]], 12);
      }
      if (g.stage === 'ramp2') {
        const c = Object.assign({ k: 2 }, D.cannons.c2, CN.c2); X.cannons.push(c); leapStage('leap2', c);
      }
    }
    const fp = D.finish.p;
    const fb = L('F_finish');
    const c2 = X.cannons[1];
    const bowl = { id: 'bowlF', kind: 'lathe', c: fb.center, plates: lathePlates(fb.center, fb.prof, 48, 1.0), center: [c2.target.slice(), fp.slice()] };
    bowl.length = polyLen(bowl.center);
    B.addStage('bowl', [bowl], () => 16);
    B.finish = { p: fp.slice(), f: D.finish.f.slice(), r: D.finish.r, s: B.S() };
    B.tray = tray;
    X.finishP = fp.slice();
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W]);
    for (const c of X.cannons) for (const p of arc(c, 6)) B.extraPoints.push([p[0], p[1] + 4, p[2] + 12], [p[0], p[1] - 4, p[2] - 12]);
  },

  // ── гармати: кулька в стволі — постріл по дузі з розкидом; промах = падіння в каньйон ──
  step(st, dt) {
    const X = st.track.extra.canyon; if (!X || !st.raceOn) return;
    for (const c of X.cannons) {
      if (c.miss == null) { c.miss = 0; c.maxN = Math.max(1, Math.floor(st.balls.length * c.maxMiss)); c.n = 0; }
      for (const b of st.active) {
        if (b['shot' + c.k]) continue;
        const dx = b.x - c.trig[0], dy = b.y - c.trig[1], dz = b.z - c.trig[2];
        if (dx * dx + dy * dy + dz * dz > CN.trigR * CN.trigR) continue;
        // черга: по одному шарику за CN.gap с — інакше кілька телепортувались би в одну точку дула й розштовхували одне одного
        if (c.lastT != null && st.raceT - c.lastT < CN.gap) {
          b.vx *= 0.2; b.vz *= 0.2; if (b.vy > 0) b.vy = 0; b.body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
          continue;
        }
        const r = rng(b.idx * 131 + c.k * 977 + st.balls.length * 7 + 3);
        const a = r() * Math.PI * 2;
        let rad = c.spread * Math.sqrt(r());
        if (rad > 8.4) { if (c.miss < c.maxN) c.miss++; else rad = CN.safeR * Math.sqrt(r()); }   // ліміт «убитих» гарматою
        // ціль — над обідком чаші (інакше дуга чіпляла ближній край); «сітка» нижче підхоплює
        const T = [c.target[0] + Math.cos(a) * rad, c.target[1] + CN.aimUp, c.target[2] + Math.sin(a) * rad], M = c.muzzle, F = c.flight;
        const v = { x: (T[0] - M[0]) / F, y: (T[1] - M[1]) / F + 0.5 * G * F, z: (T[2] - M[2]) / F };
        b.body.setTranslation({ x: M[0], y: M[1], z: M[2] }, true);
        b.body.setLinvel(v, true); b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        b.x = M[0]; b.y = M[1]; b.z = M[2]; b.vx = v.x; b.vy = v.y; b.vz = v.z;
        b['shot' + c.k] = st.raceT; b.leapT = st.raceT;
        c.n++; c.lastT = st.raceT;
      }
      // «ловильна сітка»: шарик, що прилетів у чашу, гасить швидкість — інакше відскакує через край
      for (const b of st.active) {
        if (b['shot' + c.k] == null || b['caught' + c.k]) continue;
        const dx = b.x - c.target[0], dz = b.z - c.target[2], dy = b.y - c.target[1];
        if (dx * dx + dz * dz > CN.catchR * CN.catchR || dy > CN.aimUp + 1.5 || dy < -6 || b.vy > 0) continue;
        b['caught' + c.k] = 1;
        b.vx *= CN.damp; b.vy *= CN.damp; b.vz *= CN.damp;
        b.body.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
      }
    }
  },

  intro(track, pos, look) {
    const H = track.tray.hinge;
    pos.set(H[0] - 46, H[1] + 24, H[2] - 30);
    look.set(H[0] + 6, H[1] - 2, H[2] + 4);
  },

  // спецплани: збоку на кожен постріл, поки летить лідер
  camera(st, leader, pos, look) {
    const X = st.track.extra.canyon; if (!X) return false;
    for (const c of X.cannons) {
      const t = leader['shot' + c.k];
      if (t != null && st.raceT - t < 2.4) {
        const m = c.muzzle, T = c.target, mx = (m[0] + T[0]) / 2, my = (m[1] + T[1]) / 2;
        pos.set(mx - 4, my + 9, 46); look.set(mx + 2, my - 2, 0); return true;
      }
      const dx = leader.x - c.trig[0];
      if (dx > -14 && dx < 0 && Math.abs(leader.y - c.trig[1]) < 6) { pos.set(c.trig[0] - 6, c.trig[1] + 6, 20); look.set(c.trig[0] + 6, c.trig[1] + 1, 0); return true; }
    }
    return false;
  },

  // показ: модель з Blender + лоток + сонце + спалахи гармат
  decor(track, ctx) {
    const { THREE, scene } = ctx;
    const X = track.extra.canyon;
    const holder = new THREE.Group(); scene.add(holder);
    const put = sc => {
      const root = sc.clone(true);
      root.traverse(o => {
        if (!o.isMesh) return;
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        const m = o.material; if (!m || !m.isMeshStandardMaterial) return;
        const deco = /^D_/.test(m.name);
        if (deco) { m.flatShading = true; m.metalness = 0; m.envMapIntensity = 0; m.needsUpdate = true; }
        else { m.envMap = ctx.env; m.envMapIntensity = 0.6; }
        if (/Neon/.test(m.name)) { m.emissive = m.color.clone(); m.emissiveIntensity = 0.55; }
        if (/Gold/.test(m.name)) { m.metalness = 0.85; m.roughness = 0.3; }
        o.castShadow = !deco || /Tower|pillar/i.test(o.name); o.receiveShadow = true;
      });
      holder.add(root);
    };
    if (GLB_SCENE) put(GLB_SCENE);
    else {
      if (!GLB_PROM) GLB_PROM = new Promise((ok, no) => new THREE.GLTFLoader().load(GLB_URL, g => { GLB_SCENE = g.scene; ok(g.scene); }, undefined, no));
      GLB_PROM.then(put).catch(e => console.warn('[marbles] модель «Закатных пушек» не загрузилась', e));
    }
    if (ctx.trayGroup) {
      const tr = track.tray, mat = new THREE.MeshStandardMaterial({ color: '#3b4160', roughness: 0.35, metalness: 0.3, envMap: ctx.env, envMapIntensity: 0.5 });
      const rim = new THREE.MeshStandardMaterial({ color: '#ffb43a', roughness: 0.3, metalness: 0.8 });
      const floor = new THREE.Mesh(new THREE.BoxGeometry(tr.L, 0.5, tr.W), mat); floor.position.set(-tr.L / 2, -0.25, 0); floor.receiveShadow = floor.castShadow = true; ctx.trayGroup.add(floor);
      for (const [px, pz, sx, sz] of [[-tr.L / 2, tr.W / 2 + 0.3, tr.L, 0.6], [-tr.L / 2, -tr.W / 2 - 0.3, tr.L, 0.6], [-tr.L - 0.3, 0, 0.6, tr.W + 1.2]]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.5, sz), rim); w.position.set(px, 0.5, pz); w.castShadow = true; ctx.trayGroup.add(w);
      }
      const s = new THREE.Mesh(new THREE.PlaneGeometry(tr.W - 1.2, 2.2), ctx.mats.start); s.rotation.set(-Math.PI / 2, 0, Math.PI / 2); s.position.set(-1.8, 0.02, 0); ctx.trayGroup.add(s);
    }
    // велике червоне сонце над каньйоном
    const glowTex = (inner, outer) => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62); gr.addColorStop(0, inner); gr.addColorStop(0.35, outer); gr.addColorStop(1, 'rgba(255,90,40,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); };
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,236,200,1)', 'rgba(255,140,70,.75)'), depthWrite: false, fog: false, toneMapped: false, transparent: true }));
    sun.position.set(420, 60, -520); sun.scale.setScalar(260); scene.add(sun);
    // спалах і дим на дулах
    X.fx = X.cannons.map(c => {
      const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,255,230,1)', 'rgba(255,170,60,.9)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, opacity: 0 }));
      fl.position.set(c.muzzle[0] + 1, c.muzzle[1] + 0.4, c.muzzle[2]); fl.scale.setScalar(7); scene.add(fl);
      const light = new THREE.PointLight('#ffb36b', 0, 40, 2); light.position.copy(fl.position); scene.add(light);
      return { c, fl, light, lastN: 0, sndT: 0 };
    });
  },

  frame(st, ctx) {
    const X = st.track.extra.canyon; if (!X || !X.fx) return;
    const now = performance.now();
    for (const f of X.fx) {
      const age = f.c.lastT != null ? st.raceT - f.c.lastT : 9;
      const k = Math.max(0, 1 - age / 0.25);
      f.fl.material.opacity = k; f.fl.scale.setScalar(6 + 5 * (1 - k)); f.light.intensity = 30 * k;
      // звук пострілу — не частіше ніж раз на 0.18 с (у пелетоні гармата стріляє чергою)
      if ((f.c.n || 0) > f.lastN && now - f.sndT > 180) {
        f.lastN = f.c.n; f.sndT = now;
        if (typeof playSfx === 'function') playSfx('cannon', 0.45, 0.9 + Math.random() * 0.25, 600);
      }
    }
  },
};
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
