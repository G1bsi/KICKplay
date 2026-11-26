/* ══════════════════════════════════════════════════════════════
   brcore.js — спільний 3D-рушій Батл Рояля 2.0 (лобі на острові + фінал на арені).
   Моделі — власні, з Blender (blender/br_build.py → public/models/br/*).
   window.BR3 = {
     loadKit(), loadIsland(), loadArena()           — GLB/JSON (кешуються)
     tintMat(), zoneMat(base)                       — матеріали: «фарба гравця», тонування зони/червоної зони/сітки
     Crowd                                          — бійці: InstancedMesh на кожну частину тіла, процедурна анімація
     Ragdoll                                        — верле-ragdoll (7 точок), падіння, вибухи, стіни
     Debris                                         — тверді уламки (дошки ящиків, гвинтівки)
     Fx                                             — мультяшні частинки: вогонь, дим, іскри, трасери, блискавки, конфеті
     Labels                                         — ніки/HP на 2D-канві поверх 3D
     snd(name, vol, rate)                           — звуки ElevenLabs через KPS
     hue(nick), colorOf(nick)
   }
   ══════════════════════════════════════════════════════════════ */
(function () {
'use strict';
const V = '20261127b';
const BASE = '/assets/models/br/';
const cache = {};
function loadGLB(name) {
  return cache[name] || (cache[name] = new Promise((res, rej) => new THREE.GLTFLoader().load(BASE + name + '?v=' + V, res, undefined, rej)));
}
function loadJSON(name) { return cache[name] || (cache[name] = fetch(BASE + name + '?v=' + V).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })); }

// ── кольори гравців ──
function hue(s) { let h = 2166136261; s = String(s).toLowerCase(); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; }
function colorOf(nick) { return new THREE.Color().setHSL(hue(nick) / 360, 0.78, 0.55); }
function cssOf(nick) { return 'hsl(' + hue(nick) + ',78%,60%)'; }

// ── звук ──
const SND = ['br-shot', 'br-shot2', 'br-boom', 'br-zap', 'br-chute', 'br-land', 'br-zone', 'br-siren', 'br-whistle', 'br-crate', 'br-hit', 'br-win', 'br-plane', 'br-clink', 'br-death', 'br-beep', 'br-go'];
let sndLoaded = false;
function sndInit() { if (sndLoaded || !window.KPS) return; sndLoaded = true; SND.forEach(n => KPS.load(n)); }
const lastSnd = {};
function snd(name, vol, rate, minGap) {
  if (!window.KPS) return;
  const now = performance.now();
  if (minGap && lastSnd[name] && now - lastSnd[name] < minGap) return;
  lastSnd[name] = now;
  KPS.play(name, vol == null ? 0.7 : vol, rate || 1);
}

// ── матеріали ──
function patchColor(sh) {
  sh.vertexShader = sh.vertexShader.replace('#include <color_vertex>', [
    '#include <color_vertex>',
    '#if defined( USE_COLOR ) && defined( USE_INSTANCING_COLOR )',
    '  vColor.xyz = color.xyz;',
    '  if (color.r > 0.97 && color.g < 0.03 && color.b > 0.97) vColor.xyz = instanceColor.xyz;',
    '#endif'].join('\n'));
}
// бійці: вершинні кольори; пурпурні вершини фарбуються кольором гравця, решта (шкіра, чоботи, зброя) — як є
function tintMat(extra) {
  const m = new THREE.MeshLambertMaterial(Object.assign({ vertexColors: true }, extra || {}));
  m.onBeforeCompile = patchColor;
  return m;
}
/* рельєф/споруди: + зона (фіолетовий шторм зовні), край зони, червона зона, сітка 10×10, підсвітка клітинки */
const ZU = {
  uTime: { value: 0 }, uZone: { value: new THREE.Vector4(0, 0, 999, 0) },       // cx, cz, r, увімк
  uRed: { value: new THREE.Vector4(0, 0, 0, 0) },                               // cx, cz, r, сила
  uGrid: { value: 0 }, uHover: { value: new THREE.Vector2(-9, -9) }, uZoneSq: { value: 0 },   // uZoneSq=1 — зона й червона зона квадратні (лобі)
};
function zoneMat(opts) {
  opts = opts || {};
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: opts.side || THREE.FrontSide });
  m.extensions = { derivatives: true };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, ZU);
    sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = ['varying vec3 vWPos;', 'uniform float uTime; uniform vec4 uZone; uniform vec4 uRed; uniform float uGrid; uniform vec2 uHover; uniform float uZoneSq;',
      'float zd(vec2 p, vec2 c, float r) { vec2 d = abs(p - c); return uZoneSq > 0.5 ? max(d.x, d.y) - r : length(p - c) - r; }'].join('\n') + '\n' +
      sh.fragmentShader.replace('#include <tonemapping_fragment>', [
        'vec3 col = gl_FragColor.rgb;',
        (opts.grid ? [
          'if (uGrid > 0.5 && abs(vWPos.x) < 50.0 && abs(vWPos.z) < 50.0) {',
          '  vec2 g = abs(fract((vWPos.xz + 50.0) / 10.0 + 0.5) - 0.5) * 10.0;',
          '  vec2 fw = fwidth(vWPos.xz) * 1.2;',
          '  float ln = 1.0 - min(smoothstep(0.06, 0.06 + fw.x, g.x), smoothstep(0.06, 0.06 + fw.y, g.y));',
          '  col = mix(col, vec3(1.0), ln * 0.4);',
          '  vec2 cell = floor((vWPos.xz + 50.0) / 10.0);',
          '  if (cell.x == uHover.x && cell.y == uHover.y) col = mix(col, vec3(1.0, 0.92, 0.45), 0.28);',
          '}'].join('\n') : ''),
        'if (uZone.w > 0.5) {',
        '  float dz = zd(vWPos.xz, uZone.xy, uZone.z);',
        '  if (dz > 0.0) {',
        '    float n = sin(vWPos.x * 0.21 + uTime * 1.3) * sin(vWPos.z * 0.19 - uTime * 0.9);',
        '    col = mix(col, vec3(0.42, 0.18, 0.78) * (0.75 + 0.2 * n), 0.5);',
        '  }',
        '  col += vec3(0.55, 0.35, 1.0) * exp(-abs(dz) * 0.9) * 0.55;',
        '}',
        'if (uRed.w > 0.001) {',
        '  float dr = zd(vWPos.xz, uRed.xy, uRed.z);',
        '  if (dr < 0.0) {',
        '    float st = step(0.5, fract((vWPos.x + vWPos.z) * 0.18 + uTime * 0.9));',
        '    col = mix(col, vec3(1.0, 0.12, 0.08), uRed.w * (0.5 + 0.22 * st));',
        '  }',
        '  col += vec3(1.0, 0.25, 0.15) * exp(-abs(dr) * 0.8) * uRed.w * 1.3;',
        '}',
        'gl_FragColor.rgb = col;',
        '#include <tonemapping_fragment>'].join('\n'));
  };
  return m;
}
// вода: мілина бірюзова, глибина синя, піна біля берега (за картою висот острова)
function waterMat(hTex, e) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: ZU.uTime, uH: { value: hTex }, uE: { value: e }, uZone: ZU.uZone, uZoneSq: ZU.uZoneSq },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: [
      'uniform float uTime; uniform sampler2D uH; uniform float uE; uniform vec4 uZone; uniform float uZoneSq; varying vec3 vW;',
      'void main(){',
      '  vec2 uv = (vW.xz + uE) / (2.0 * uE);',
      '  float h = -6.0; if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) h = texture2D(uH, uv).r * 40.0 - 20.0;',
      '  float d = clamp(-h / 4.5, 0.0, 1.0);',
      '  vec3 c = mix(vec3(0.33, 0.86, 0.92), vec3(0.09, 0.42, 0.78), d);',
      '  float w = sin(vW.x * 0.35 + uTime * 1.2) * sin(vW.z * 0.3 - uTime) * 0.5 + 0.5;',
      '  c += vec3(0.06) * w;',
      '  float foam = smoothstep(0.55, 0.0, -h) * (0.6 + 0.4 * sin(uTime * 2.2 - h * 9.0));',
      '  c = mix(c, vec3(1.0), clamp(foam, 0.0, 1.0) * 0.8);',
      '  vec2 zq = abs(vW.xz - uZone.xy); float zdd = uZoneSq > 0.5 ? max(zq.x, zq.y) : length(vW.xz - uZone.xy);',
      '  if (uZone.w > 0.5 && zdd > uZone.z) c = mix(c, vec3(0.38, 0.2, 0.72), 0.45);',
      '  gl_FragColor = vec4(c, 1.0);',
      '}'].join('\n'),
  });
}
// стіна зони: прозорий циліндр з біжучими смугами
function zoneWall(square) {
  // square: 4 грані, повернуті на 45° — квадрат із півстороною 1/√2 (масштабувати на half·√2)
  const geo = square ? new THREE.CylinderGeometry(1, 1, 1, 4, 1, true).rotateY(Math.PI / 4) : new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: ZU.uTime, uCol: { value: new THREE.Color(0.62, 0.38, 1.0) }, uSeg: { value: square ? 1 : 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'uniform float uTime; uniform vec3 uCol; uniform float uSeg; varying vec2 vUv;',
      'void main(){',
      '  float st = 0.5 + 0.5 * sin(vUv.x * (uSeg > 0.5 ? 120.0 : 380.0) + vUv.y * 14.0 - uTime * 4.0);',
      '  float hx = 0.5 + 0.5 * sin(vUv.y * 30.0 - uTime * 2.5);',
      '  float a = (1.0 - vUv.y) * (0.22 + 0.25 * st * hx) + smoothstep(0.08, 0.0, vUv.y) * 0.5;',
      '  gl_FragColor = vec4(uCol * a, a);',
      '}'].join('\n'),
  });
  const m = new THREE.Mesh(geo, mat); m.renderOrder = 5; m.frustumCulled = false;
  return m;
}

// ── завантаження ──
let KIT = null;
function loadKit() {
  if (KIT) return Promise.resolve(KIT);
  return loadGLB('kit.glb').then(g => {
    const geo = {};
    g.scene.traverse(o => { if (o.isMesh) { o.updateMatrixWorld(true); const gg = o.geometry.clone(); gg.applyMatrix4(o.matrixWorld); geo[o.name.replace(/^BR_/, '')] = gg; } });
    // GLTF кладе об'єкт у вузол з тим самим іменем; якщо меш названо інакше — беремо ім'я батька
    if (!geo.Torso) g.scene.traverse(o => { if (o.isMesh && o.parent && /^BR_/.test(o.parent.name)) geo[o.parent.name.replace(/^BR_/, '')] = geo[o.parent.name.replace(/^BR_/, '')] || o.geometry; });
    KIT = { geo };
    return KIT;
  });
}

// ── бійці ──
const PARTS = ['LegL', 'LegR', 'Torso', 'Head', 'ArmL', 'ArmR', 'Gun'];
const _m = new THREE.Matrix4(), _r = new THREE.Matrix4(), _t = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(),
  _s = new THREE.Vector3(), _e = new THREE.Euler(), _up = new THREE.Vector3(0, 1, 0);
const M = { root: new THREE.Matrix4(), torso: new THREE.Matrix4(), part: {} };
PARTS.forEach(p => M.part[p] = new THREE.Matrix4());
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
function mT(x, y, z) { return _t.makeTranslation(x, y, z); }
function rx(a) { return _r.makeRotationX(a); }
function ry(a) { return _r.makeRotationY(a); }
function rz(a) { return _r.makeRotationZ(a); }

class Crowd {
  constructor(scene, cap, opts) {
    opts = opts || {};
    this.cap = cap; this.list = [];
    this.mat = tintMat();
    this.meshes = {};
    for (const p of PARTS) {
      const im = new THREE.InstancedMesh(KIT.geo[p], this.mat, cap);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = !!opts.shadows; im.receiveShadow = false; im.frustumCulled = false;
      for (let i = 0; i < cap; i++) { im.setMatrixAt(i, ZERO); im.setColorAt(i, new THREE.Color(1, 1, 1)); }
      im.count = 0;
      scene.add(im); this.meshes[p] = im;
    }
    this.chute = new THREE.InstancedMesh(KIT.geo.Chute, tintMat({ side: THREE.DoubleSide }), cap);
    this.chute.frustumCulled = false; this.chute.count = 0;
    for (let i = 0; i < cap; i++) { this.chute.setMatrixAt(i, ZERO); this.chute.setColorAt(i, new THREE.Color(1, 1, 1)); }
    scene.add(this.chute);
    this.crown = new THREE.Mesh(KIT.geo.Crown, tintMat()); this.crown.visible = false; this.crown.matrixAutoUpdate = false; scene.add(this.crown);
  }
  add(f) {
    if (this.list.length >= this.cap) return null;
    f.slot = this.list.length; this.list.push(f);
    f.col = f.col || new THREE.Color(1, 1, 1);
    for (const p of PARTS) this.meshes[p].setColorAt(f.slot, f.col);
    this.chute.setColorAt(f.slot, f.col);
    for (const p of PARTS) { this.meshes[p].count = this.list.length; this.meshes[p].instanceColor.needsUpdate = true; }
    this.chute.count = this.list.length; this.chute.instanceColor.needsUpdate = true;
    return f;
  }
  clear() { this.list = []; for (const p of PARTS) this.meshes[p].count = 0; this.chute.count = 0; this.crown.visible = false; }
  recolor(f, c) { f.col = c; for (const p of PARTS) { this.meshes[p].setColorAt(f.slot, c); this.meshes[p].instanceColor.needsUpdate = true; } }
  dispose() { for (const p of PARTS) { this.meshes[p].parent && this.meshes[p].parent.remove(this.meshes[p]); } this.chute.parent && this.chute.parent.remove(this.chute); }
  /* поза бійця f: {x,y,z,yaw,s, mode, ph (фаза кроку), aim (0..1), pitch, lean, chute (0..1), wave, hide, rag, gunOff} */
  pose(f, t) {
    const s = f.s || 1, i = f.slot;
    if (f.hide) { for (const p of PARTS) this.meshes[p].setMatrixAt(i, ZERO); this.chute.setMatrixAt(i, ZERO); return; }
    if (f.rag) { f.rag.write(this, i, s); this.chute.setMatrixAt(i, ZERO); if (f.crown) this.crown.visible = false; return; }
    const mode = f.mode || 'stand';
    let legL = 0, legR = 0, armLx = 0, armRx = 0, armLz = 0.08, armRz = -0.08, bob = 0, lean = f.lean || 0, look = 0;
    const aim = f.aim || 0;
    if (mode === 'walk' || mode === 'run') {
      const k = mode === 'run' ? 0.85 : 0.55, sw = Math.sin(f.ph || 0);
      legL = sw * k; legR = -sw * k; armLx = -sw * k * 0.9; armRx = sw * k * 0.9;
      bob = Math.abs(Math.cos(f.ph || 0)) * 0.07; lean += mode === 'run' ? 0.12 : 0.04;
    } else if (mode === 'stand') {
      bob = Math.sin(t * 2 + i) * 0.012; look = Math.sin(t * 0.5 + i * 1.7) * 0.4;
    } else if (mode === 'chute') {
      const sw = Math.sin(t * 3 + i);
      legL = 0.25 + sw * 0.15; legR = 0.25 - sw * 0.15; armLz = -2.65; armRz = 2.65; armLx = 0.1; armRx = 0.1;
    } else if (mode === 'win') {
      const w = Math.sin(t * 7);
      armLz = -2.55 - w * 0.25; armRz = 2.55 - w * 0.25; bob = Math.max(0, Math.sin(t * 5)) * 0.35; look = 0;
    } else if (mode === 'crouch') {
      legL = -0.9; legR = -0.2; bob = -0.32; lean += 0.25;
    } else if (mode === 'fall') {
      const sw = Math.sin(t * 9 + i);
      legL = sw * 0.6; legR = -sw * 0.6; armLz = -2.2 + sw * 0.4; armRz = 2.2 + sw * 0.4;
    }
    if (aim > 0) {   // гвинтівка до плеча
      armRx = armRx * (1 - aim) + (-1.5 + (f.pitch || 0)) * aim; armRz = armRz * (1 - aim) + (-0.18) * aim;
      armLx = armLx * (1 - aim) + (-1.42 + (f.pitch || 0)) * aim; armLz = armLz * (1 - aim) + 0.62 * aim;
      look *= (1 - aim);
    }
    _q.setFromAxisAngle(_up, f.yaw || 0); _s.set(s, s, s); _v.set(f.x, f.y, f.z);
    M.root.compose(_v, _q, _s);
    const hy = 0.95 + bob;
    const T = M.torso.copy(M.root).multiply(mT(0, hy, 0)).multiply(rx(lean));
    this.meshes.Torso.setMatrixAt(i, T);
    _m.copy(M.root).multiply(mT(-0.16, hy, 0)).multiply(rx(legL)); this.meshes.LegL.setMatrixAt(i, _m);
    _m.copy(M.root).multiply(mT(0.16, hy, 0)).multiply(rx(legR)); this.meshes.LegR.setMatrixAt(i, _m);
    _m.copy(T).multiply(mT(0, 0.72, 0)).multiply(ry(look)).multiply(rx(aim > 0 ? (f.pitch || 0) * 0.5 : 0)); this.meshes.Head.setMatrixAt(i, _m);
    if (f.crown) { this.crown.matrix.copy(_m).multiply(mT(0, 0.5, 0)); this.crown.matrixWorldNeedsUpdate = true; this.crown.visible = true; }
    _m.copy(T).multiply(mT(-0.42, 0.62, 0)).multiply(rz(armLz)).multiply(rx(armLx)); this.meshes.ArmL.setMatrixAt(i, _m);
    _m.copy(T).multiply(mT(0.42, 0.62, 0)).multiply(rz(armRz)).multiply(rx(armRx)); this.meshes.ArmR.setMatrixAt(i, _m);
    if (f.gunOff) this.meshes.Gun.setMatrixAt(i, ZERO);
    else if (aim > 0.5) { _m.copy(T).multiply(mT(0.17, 0.5, 0.42)).multiply(rx(f.pitch || 0)); this.meshes.Gun.setMatrixAt(i, _m); }
    else if (mode === 'chute' || mode === 'win' || mode === 'fall') { _m.copy(T).multiply(mT(0, 0.42, -0.42)).multiply(rz(0.9)).multiply(rx(Math.PI / 2)); this.meshes.Gun.setMatrixAt(i, _m); }
    else { _m.copy(T).multiply(mT(0.12, 0.3, 0.3)).multiply(ry(-0.9)).multiply(rx(-0.35)); this.meshes.Gun.setMatrixAt(i, _m); }
    if (mode === 'chute' && (f.chute || 0) > 0.01) {
      const c = f.chute, sw = Math.sin(t * 2 + i) * 0.08;
      _q.setFromEuler(_e.set(sw, f.yaw || 0, -sw * 0.7)); _s.set(s * c, s * (0.4 + 0.6 * c), s * c); _v.set(f.x, f.y + 1.55 * s, f.z);
      _m.compose(_v, _q, _s); this.chute.setMatrixAt(i, _m);
    } else this.chute.setMatrixAt(i, ZERO);
  }
  // корисно для камери/ефектів: світова позиція точки на бійці (дуло, голова)
  muzzle(f, out) {
    const s = f.s || 1, c = Math.cos(f.yaw || 0), sn = Math.sin(f.yaw || 0), p = f.pitch || 0;
    const fx = 0.17, fz = 1.0 * Math.cos(p), fy = 0.95 + 0.5 + 0.05 + Math.sin(p) * 0.9;
    return out.set(f.x + (fx * c + fz * sn) * s, f.y + fy * s, f.z + (-fx * sn + fz * c) * s);
  }
  commit() {
    for (const p of PARTS) this.meshes[p].instanceMatrix.needsUpdate = true;
    this.chute.instanceMatrix.needsUpdate = true;
  }
}

// ── ragdoll (верле) ──
// точки: 0 голова, 1 груди, 2 таз, 3 кисть Л, 4 кисть П, 5 стопа Л, 6 стопа П
const RAG_STICKS = [[0, 1, 1], [1, 2, 1], [0, 2, 1]];                       // жорсткий корпус
const RAG_RANGE = [[1, 3, 0.35, 0.82], [1, 4, 0.35, 0.82], [2, 5, 0.55, 0.95], [2, 6, 0.55, 0.95], [1, 5, 0.75, 1.9], [1, 6, 0.75, 1.9], [5, 6, 0.15, 1.2]];
class Ragdoll {
  constructor(f, crowd, ground, opts) {
    opts = opts || {};
    const s = f.s || 1; this.s = s; this.ground = ground; this.boxes = opts.boxes || null;
    this.p = []; this.o = [];
    const yaw = f.yaw || 0, c = Math.cos(yaw), sn = Math.sin(yaw);
    const L = (lx, ly, lz) => new THREE.Vector3(f.x + (lx * c + lz * sn) * s, f.y + ly * s, f.z + (-lx * sn + lz * c) * s);
    const aim = (f.aim || 0) > 0.5;
    const pts = [L(0, 1.94, 0), L(0, 1.6, 0), L(0, 0.97, 0), aim ? L(-0.1, 1.45, 0.55) : L(-0.47, 1.0, 0), aim ? L(0.25, 1.45, 0.55) : L(0.47, 1.0, 0), L(-0.16, 0.08, 0.05), L(0.16, 0.08, 0.05)];
    for (const q of pts) { this.p.push(q); this.o.push(q.clone()); }
    this.side = new THREE.Vector3(c, 0, -sn);
    this.len = RAG_STICKS.map(([a, b]) => pts[a].distanceTo(pts[b]));
    this.sleep = 0; this.still = 0; this.age = 0;
    if (opts.impulse) this.kick(opts.impulse, opts.at);
  }
  // імпульс: вектор швидкості; at — точка удару (ближчі точки отримують більше)
  kick(v, at, spin) {
    const dt = 1 / 60;
    for (let i = 0; i < this.p.length; i++) {
      let k = 1;
      if (at) { const d = this.p[i].distanceTo(at); k = 0.6 + 0.8 / (1 + d * d / (this.s * this.s)); }
      const jitter = 1 + (Math.random() - 0.5) * 0.5;
      this.o[i].x -= v.x * dt * k * jitter; this.o[i].y -= v.y * dt * k * jitter; this.o[i].z -= v.z * dt * k * jitter;
    }
    if (spin) { this.o[0].x += spin * dt; this.o[5].x -= spin * dt; }
    this.sleep = 0; this.still = 0;
  }
  step(dt) {
    if (this.sleep) return;
    this.age += dt;
    const g = -26 * this.s, sub = 2, h = dt / sub, s = this.s, R = 0.13 * s;
    for (let it = 0; it < sub; it++) {
      let mv = 0;
      for (let i = 0; i < this.p.length; i++) {
        const p = this.p[i], o = this.o[i];
        const vx = (p.x - o.x) * 0.995, vy = (p.y - o.y) * 0.995, vz = (p.z - o.z) * 0.995;
        o.copy(p);
        p.x += vx; p.y += vy + g * h * h; p.z += vz;
        mv += Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
      }
      for (let k = 0; k < 4; k++) {
        for (let j = 0; j < RAG_STICKS.length; j++) this.stick(RAG_STICKS[j][0], RAG_STICKS[j][1], this.len[j], this.len[j]);
        for (const [a, b, lo, hi] of RAG_RANGE) this.stick(a, b, lo * s, hi * s);
        for (let i = 0; i < this.p.length; i++) this.collide(i, R);
      }
      if (mv < 0.004 * s * this.p.length) this.still += h; else this.still = 0;
    }
    if (this.still > 0.8 && this.age > 1.2) this.sleep = 1;
  }
  stick(a, b, lo, hi) {
    const A = this.p[a], B = this.p[b];
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    let t = d < lo ? lo : (d > hi ? hi : d); if (t === d) return;
    const k = (d - t) / d * 0.5;
    A.x += dx * k; A.y += dy * k; A.z += dz * k; B.x -= dx * k; B.y -= dy * k; B.z -= dz * k;
  }
  collide(i, R) {
    const p = this.p[i], o = this.o[i];
    const gy = this.ground(p.x, p.z) + R;
    if (p.y < gy) {
      p.y = gy;
      const fr = 0.55; o.x = p.x - (p.x - o.x) * fr; o.z = p.z - (p.z - o.z) * fr; o.y = p.y + (p.y - o.y) * 0.25 * 0;   // тертя
    }
    if (this.boxes) {
      for (const b of this.boxes) {
        if (b.dead) continue;
        const hx = b.w / 2 + R, hz = b.d / 2 + R;
        const dx = p.x - b.x, dz = p.z - b.z;
        if (Math.abs(dx) < hx && Math.abs(dz) < hz && p.y < b.h + R) {
          const ox = hx - Math.abs(dx), oz = hz - Math.abs(dz), oy = b.h + R - p.y;
          if (oy < ox && oy < oz) { p.y = b.h + R; o.x = p.x - (p.x - o.x) * 0.6; o.z = p.z - (p.z - o.z) * 0.6; }
          else if (ox < oz) { p.x = b.x + Math.sign(dx || 1) * hx; o.x = p.x + (p.x - o.x) * 0.3; }
          else { p.z = b.z + Math.sign(dz || 1) * hz; o.z = p.z + (p.z - o.z) * 0.3; }
        }
      }
    }
  }
  center(out) { return out.copy(this.p[1]).add(this.p[2]).multiplyScalar(0.5); }
  // матриці частин з точок
  write(crowd, i, s) {
    const P = this.p;
    const up = _a.subVectors(P[1], P[2]).normalize();
    const side = this.side; side.addScaledVector(up, -side.dot(up)); if (side.lengthSq() < 1e-4) side.set(1, 0, 0); side.normalize();
    const fwd = _b.crossVectors(side, up).normalize();
    // тулуб
    basis(_m, side, up, fwd, P[2]); _m.scale(_s.set(s, s, s)); crowd.meshes.Torso.setMatrixAt(i, _m);
    // голова
    const hu = _c.subVectors(P[0], P[1]).normalize(); const hs = _d.copy(side).addScaledVector(hu, -side.dot(hu)).normalize(); const hf = _f.crossVectors(hs, hu);
    _v.copy(P[1]).addScaledVector(up, 0.08 * s);
    basis(_m, hs, hu, hf, _v); _m.scale(_s.set(s, s, s)); crowd.meshes.Head.setMatrixAt(i, _m);
    if (crowd.crown) crowd.crown.visible = false;
    // руки: від плеча до кисті
    limb(crowd.meshes.ArmL, i, _g.copy(P[1]).addScaledVector(side, -0.42 * s).addScaledVector(up, -0.05 * s), P[3], side, s, 0.62);
    limb(crowd.meshes.ArmR, i, _g.copy(P[1]).addScaledVector(side, 0.42 * s).addScaledVector(up, -0.05 * s), P[4], side, s, 0.62);
    limb(crowd.meshes.LegL, i, _g.copy(P[2]).addScaledVector(side, -0.16 * s), P[5], side, s, 0.9);
    limb(crowd.meshes.LegR, i, _g.copy(P[2]).addScaledVector(side, 0.16 * s), P[6], side, s, 0.9);
    crowd.meshes.Gun.setMatrixAt(i, ZERO);
  }
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3(),
  _h = new THREE.Vector3(), _k = new THREE.Vector3(), _l = new THREE.Vector3();
function basis(m, x, y, z, pos) {
  m.set(x.x, y.x, z.x, pos.x, x.y, y.y, z.y, pos.y, x.z, y.z, z.z, pos.z, 0, 0, 0, 1);
  return m;
}
function limb(im, i, from, to, side, s, len) {
  const y = _h.subVectors(from, to); const d = y.length() || 1e-6; y.multiplyScalar(1 / d);
  const x = _k.copy(side).addScaledVector(y, -side.dot(y)); if (x.lengthSq() < 1e-5) x.set(1, 0, 0); x.normalize();
  const z = _l.crossVectors(x, y);
  basis(_m, x, y, z, from); _m.scale(_s.set(s, s * Math.min(1.25, Math.max(0.8, d / (len * s))), s));
  im.setMatrixAt(i, _m);
}

// ── тверді уламки ──
class Debris {
  constructor(scene, geo, mat, cap, ground) {
    this.im = new THREE.InstancedMesh(geo, mat, cap); this.im.frustumCulled = false; this.im.castShadow = true;
    this.im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < cap; i++) this.im.setMatrixAt(i, ZERO);
    scene.add(this.im); this.cap = cap; this.list = []; this.ground = ground; this.boxes = null; this.k = 0;
  }
  spawn(pos, vel, scl, color, life) {
    const d = { p: pos.clone(), v: vel.clone(), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
      w: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14), s: scl.clone(), life: life || 1e9, t: 0, slot: this.k, rest: 0 };
    this.k = (this.k + 1) % this.cap;
    const old = this.list.findIndex(x => x.slot === d.slot); if (old >= 0) this.list.splice(old, 1);
    this.list.push(d);
    if (color && this.im.instanceColor !== undefined) { this.im.setColorAt(d.slot, color); this.im.instanceColor.needsUpdate = true; }
    else if (color) { this.im.setColorAt(d.slot, color); }
    return d;
  }
  step(dt) {
    const dq = new THREE.Quaternion();
    for (let n = this.list.length - 1; n >= 0; n--) {
      const d = this.list[n]; d.t += dt;
      if (d.t > d.life) { this.im.setMatrixAt(d.slot, ZERO); this.list.splice(n, 1); continue; }
      if (!d.rest) {
        d.v.y -= 30 * dt; d.p.addScaledVector(d.v, dt);
        const r = Math.min(d.s.x, d.s.y, d.s.z) * 0.5;
        const gy = this.ground(d.p.x, d.p.z) + r;
        if (d.p.y < gy) { d.p.y = gy; d.v.y = Math.abs(d.v.y) * 0.3; d.v.x *= 0.62; d.v.z *= 0.62; d.w.multiplyScalar(0.6); if (d.v.lengthSq() < 0.6) d.rest = 1; }
        if (this.boxes) for (const b of this.boxes) {
          if (b.dead) continue;
          const dx = d.p.x - b.x, dz = d.p.z - b.z, hx = b.w / 2 + r, hz = b.d / 2 + r;
          if (Math.abs(dx) < hx && Math.abs(dz) < hz && d.p.y < b.h + r) {
            const ox = hx - Math.abs(dx), oz = hz - Math.abs(dz), oy = b.h + r - d.p.y;
            if (oy < ox && oy < oz) { d.p.y = b.h + r; d.v.y = Math.abs(d.v.y) * 0.3; d.v.x *= 0.7; d.v.z *= 0.7; if (d.v.lengthSq() < 0.6) d.rest = 1; }
            else if (ox < oz) { d.p.x = b.x + Math.sign(dx || 1) * hx; d.v.x *= -0.4; } else { d.p.z = b.z + Math.sign(dz || 1) * hz; d.v.z *= -0.4; }
          }
        }
        const wl = d.w.length();
        if (wl > 0.01) { dq.setFromAxisAngle(_a.copy(d.w).multiplyScalar(1 / wl), wl * dt); d.q.premultiply(dq); }
      }
      const sk = d.life < 1e8 ? Math.min(1, (d.life - d.t) / 0.6) : 1;
      _m.compose(d.p, d.q, _s.copy(d.s).multiplyScalar(Math.max(0.001, sk))); this.im.setMatrixAt(d.slot, _m);
    }
    this.im.instanceMatrix.needsUpdate = true;
  }
  clear() { for (const d of this.list) this.im.setMatrixAt(d.slot, ZERO); this.list = []; this.im.instanceMatrix.needsUpdate = true; }
}

// ── мультяшні частинки ──
class Fx {
  constructor(scene, ground) {
    const ico = new THREE.IcosahedronGeometry(1, 0);
    this.glow = this.pool(scene, ico, new THREE.MeshBasicMaterial({ toneMapped: false }), 1600);
    this.smoke = this.pool(scene, ico, new THREE.MeshLambertMaterial({ flatShading: true }), 900);
    this.ground = ground || (() => 0);
    this.rings = [];
    this.scene = scene; this.shake = 0;
  }
  pool(scene, geo, mat, cap) {
    const im = new THREE.InstancedMesh(geo, mat, cap); im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < cap; i++) { im.setMatrixAt(i, ZERO); im.setColorAt(i, new THREE.Color(1, 1, 1)); }
    scene.add(im);
    return { im, cap, list: [], k: 0 };
  }
  add(pool, o) {
    const P = pool === 'glow' ? this.glow : this.smoke;
    const slot = P.k; P.k = (P.k + 1) % P.cap;
    const old = P.list.findIndex(x => x.slot === slot); if (old >= 0) P.list.splice(old, 1);
    o.slot = slot; o.t = 0; o.c0 = o.c0 || new THREE.Color(1, 1, 1); o.c1 = o.c1 || o.c0; o.s1 = o.s1 == null ? o.s0 : o.s1;
    o.v = o.v || new THREE.Vector3(); o.g = o.g || 0; o.drag = o.drag || 0; o.q = o.q || null; o.bounce = o.bounce || 0;
    P.list.push(o); return o;
  }
  step(dt, camera) {
    for (const P of [this.glow, this.smoke]) {
      for (let n = P.list.length - 1; n >= 0; n--) {
        const o = P.list[n]; o.t += dt;
        if (o.t >= o.life) { P.im.setMatrixAt(o.slot, ZERO); P.list.splice(n, 1); continue; }
        if (o.delay) { if (o.t < o.delay) { P.im.setMatrixAt(o.slot, ZERO); continue; } }
        o.v.y += o.g * dt; if (o.drag) o.v.multiplyScalar(Math.max(0, 1 - o.drag * dt));
        o.p.addScaledVector(o.v, dt);
        if (o.bounce) { const gy = this.ground(o.p.x, o.p.z) + 0.05; if (o.p.y < gy) { o.p.y = gy; o.v.y = Math.abs(o.v.y) * o.bounce; o.v.x *= 0.6; o.v.z *= 0.6; } }
        const k = (o.t - (o.delay || 0)) / (o.life - (o.delay || 0));
        const e = o.ease === 'pop' ? Math.sin(Math.min(1, k * 1.15) * Math.PI) : (o.ease === 'grow' ? Math.min(1, k * 4) * (1 - Math.max(0, (k - 0.6) / 0.4)) : 1 - k);
        const sc = o.s0 + (o.s1 - o.s0) * k;
        const S = Math.max(0.0001, sc * (o.ease ? e : 1));
        if (o.dir) {   // витягнута частинка (трасер, блискавка)
          _q.setFromUnitVectors(_up, o.dir); _s.set(o.w || 0.05, (o.len || 1) * (o.ease ? e : 1), o.w || 0.05);
          _m.compose(o.p, _q, _s);
        } else if (o.q) {
          if (o.spin) o.q.multiply(_q.setFromAxisAngle(o.spinAx, o.spin * dt));
          _m.compose(o.p, o.q, _s.set(S * (o.sx || 1), S * (o.sy || 1), S * (o.sz || 1)));
        } else { _m.makeScale(S, S, S); _m.setPosition(o.p); }
        P.im.setMatrixAt(o.slot, _m);
        if (o.c1 !== o.c0) { _col.copy(o.c0).lerp(o.c1, Math.min(1, k * (o.cs || 1))); P.im.setColorAt(o.slot, _col); }
        else if (!o.cset) { P.im.setColorAt(o.slot, o.c0); o.cset = 1; }
      }
      P.im.instanceMatrix.needsUpdate = true; if (P.im.instanceColor) P.im.instanceColor.needsUpdate = true;
    }
    for (let n = this.rings.length - 1; n >= 0; n--) {
      const r = this.rings[n]; r.t += dt; const k = r.t / r.life;
      if (k >= 1) { this.scene.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); this.rings.splice(n, 1); continue; }
      const sc = r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - k, 2.2)); r.m.scale.set(sc, sc, sc); r.m.material.opacity = (1 - k) * r.a;
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
  }
  clear() {
    for (const P of [this.glow, this.smoke]) { for (const o of P.list) P.im.setMatrixAt(o.slot, ZERO); P.list = []; P.im.instanceMatrix.needsUpdate = true; }
    for (const r of this.rings) this.scene.remove(r.m); this.rings = [];
  }
  ring(pos, r0, r1, color, life, a) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: a || 0.8, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    m.rotation.x = -Math.PI / 2; m.position.copy(pos); m.position.y += 0.15; this.scene.add(m);
    this.rings.push({ m, r0, r1, life, t: 0, a: a || 0.8 });
  }
  // ── готові ефекти ──
  boom(pos, power) {
    power = power || 1; const P = power;
    this.add('glow', { p: pos.clone(), s0: 2.2 * P, s1: 4.2 * P, life: 0.16, c0: C.white, c1: C.yellow, ease: 'pop' });
    for (let i = 0; i < 16 * P; i++) {
      const v = rndDir(_a).multiplyScalar(4 + Math.random() * 7 * P); v.y = Math.abs(v.y) * 0.9 + 2;
      this.add('glow', { p: pos.clone().addScaledVector(v, 0.06), v: v.clone().multiplyScalar(0.5), drag: 2.5, g: 3, s0: (0.7 + Math.random() * 0.9) * P, s1: (1.3 + Math.random()) * P,
        life: 0.45 + Math.random() * 0.35, c0: C.yellow, c1: C.red, cs: 1.6, ease: 'pop' });
    }
    for (let i = 0; i < 12 * P; i++) {
      const v = rndDir(_a).multiplyScalar(2 + Math.random() * 3 * P); v.y = Math.abs(v.y) + 1.5;
      this.add('smoke', { p: pos.clone().addScaledVector(v, 0.15), v: v.clone(), drag: 1.4, g: 1.6, s0: (0.8 + Math.random()) * P, s1: (2 + Math.random() * 1.4) * P,
        life: 1.4 + Math.random() * 1.2, delay: 0.08 + Math.random() * 0.15, c0: C.smoke1, c1: C.smoke2, ease: 'grow' });
    }
    for (let i = 0; i < 22 * P; i++) {
      const v = rndDir(_a).multiplyScalar(9 + Math.random() * 12 * P); v.y = Math.abs(v.y) * 1.2 + 3;
      this.add('glow', { p: pos.clone(), v: v.clone(), g: -24, s0: 0.09, s1: 0.03, life: 0.5 + Math.random() * 0.6, c0: C.spark, c1: C.orange, bounce: 0.4 });
    }
    for (let i = 0; i < 8 * P; i++) {
      const v = rndDir(_a).multiplyScalar(6 + Math.random() * 8); v.y = Math.abs(v.y) * 1.3 + 4;
      this.add('smoke', { p: pos.clone(), v: v.clone(), g: -26, s0: 0.14 + Math.random() * 0.14, life: 1.6, c0: C.dirt, bounce: 0.35, q: new THREE.Quaternion(), spin: 8, spinAx: rndDir(new THREE.Vector3()) });
    }
    this.ring(pos, 0.5, 9 * P, 0xffe0a0, 0.5, 0.75);
    this.shake = Math.min(1.4, this.shake + 0.55 * P);
  }
  muzzle(pos, dir) {
    this.add('glow', { p: pos.clone(), s0: 0.32, s1: 0.1, life: 0.06, c0: C.white, c1: C.yellow });
    this.add('glow', { p: pos.clone().addScaledVector(dir, 0.25), dir: dir.clone(), len: 0.6, w: 0.14, life: 0.05, c0: C.yellow, ease: 'pop' });
  }
  tracer(from, to) {
    const d = _a.subVectors(to, from); const L = d.length(); if (L < 0.1) return; d.multiplyScalar(1 / L);
    const segL = Math.min(3.5, L * 0.5), sp = 140;
    const life = Math.max(0.05, (L - segL) / sp);
    this.add('glow', { p: from.clone().addScaledVector(d, segL / 2), v: d.clone().multiplyScalar(sp), dir: d.clone(), len: segL, w: 0.045, life, c0: C.tracer });
  }
  hit(pos, n) {
    for (let i = 0; i < 7; i++) {
      const v = rndDir(_a).multiplyScalar(3 + Math.random() * 5); if (n) v.addScaledVector(n, 4);
      this.add('glow', { p: pos.clone(), v: v.clone(), g: -18, s0: 0.08, s1: 0.02, life: 0.28 + Math.random() * 0.2, c0: C.white, c1: C.yellow });
    }
    this.add('smoke', { p: pos.clone(), v: new THREE.Vector3(0, 1, 0), s0: 0.25, s1: 0.6, life: 0.5, c0: C.puff, ease: 'grow' });
  }
  star(pos) {   // попадання в бійця — мультяшна «зірочка», без крові
    this.add('glow', { p: pos.clone(), s0: 0.45, s1: 0.1, life: 0.16, c0: C.white, c1: C.hitc });
    for (let i = 0; i < 5; i++) {
      const v = rndDir(_a).multiplyScalar(4 + Math.random() * 3);
      this.add('glow', { p: pos.clone(), v: v.clone(), g: -10, s0: 0.1, s1: 0.03, life: 0.3, c0: C.hitc });
    }
  }
  dust(pos, k) {
    k = k || 1;
    for (let i = 0; i < 10 * k; i++) {
      const a = Math.random() * Math.PI * 2, v = new THREE.Vector3(Math.cos(a), 0.25 + Math.random() * 0.3, Math.sin(a)).multiplyScalar(2.5 + Math.random() * 2.5 * k);
      this.add('smoke', { p: pos.clone().add(new THREE.Vector3(0, 0.2, 0)), v, drag: 2.6, s0: 0.35 * k, s1: 0.9 * k, life: 0.8 + Math.random() * 0.4, c0: C.dust, ease: 'grow' });
    }
  }
  zap(from, to, col) {
    col = col || C.zap;
    let a = from.clone(); const n = 9;
    for (let i = 1; i <= n; i++) {
      const b = from.clone().lerp(to, i / n);
      if (i < n) b.add(new THREE.Vector3((Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 2.4));
      const d = new THREE.Vector3().subVectors(b, a); const L = d.length(); d.multiplyScalar(1 / L);
      this.add('glow', { p: a.clone().lerp(b, 0.5), dir: d, len: L, w: 0.14, life: 0.32, c0: C.white, c1: col, ease: 'pop' });
      this.add('glow', { p: a.clone().lerp(b, 0.5), dir: d.clone(), len: L, w: 0.36, life: 0.22, c0: col, ease: 'pop' });
      a = b;
    }
    this.add('glow', { p: to.clone(), s0: 1.2, s1: 2.4, life: 0.25, c0: C.white, c1: col, ease: 'pop' });
    for (let i = 0; i < 10; i++) { const v = rndDir(_a).multiplyScalar(6); v.y = Math.abs(v.y) + 2; this.add('glow', { p: to.clone(), v: v.clone(), g: -20, s0: 0.1, s1: 0.03, life: 0.5, c0: col, bounce: 0.3 }); }
  }
  confetti(pos, n, spread) {
    for (let i = 0; i < (n || 80); i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * (spread || 8), 8 + Math.random() * 9, (Math.random() - 0.5) * (spread || 8));
      this.add('glow', { p: pos.clone(), v, g: -9, drag: 1.2, s0: 0.16, life: 2.6 + Math.random() * 1.6, c0: C.conf[i % C.conf.length], q: new THREE.Quaternion(), spin: 9, spinAx: rndDir(new THREE.Vector3()), sx: 1, sy: 0.15, sz: 0.65 });
    }
  }
  trail(pos) { this.add('smoke', { p: pos.clone(), v: new THREE.Vector3((Math.random() - .5), 0.6, (Math.random() - .5)), s0: 0.35, s1: 0.9, life: 0.9, c0: C.trail, ease: 'grow' }); }
}
const _col = new THREE.Color();
const C = {
  white: new THREE.Color(1, 1, 1), yellow: new THREE.Color(1, 0.85, 0.3), orange: new THREE.Color(1, 0.5, 0.1), red: new THREE.Color(0.85, 0.18, 0.05),
  spark: new THREE.Color(1, 0.95, 0.6), smoke1: new THREE.Color(0.32, 0.3, 0.32), smoke2: new THREE.Color(0.62, 0.6, 0.62), dirt: new THREE.Color(0.45, 0.33, 0.22),
  tracer: new THREE.Color(1, 0.92, 0.55), puff: new THREE.Color(0.85, 0.82, 0.78), dust: new THREE.Color(0.86, 0.8, 0.66), zap: new THREE.Color(0.55, 0.45, 1.0),
  hitc: new THREE.Color(1, 0.95, 0.4), trail: new THREE.Color(0.85, 0.85, 0.88),
  conf: [new THREE.Color(1, 0.3, 0.35), new THREE.Color(1, 0.85, 0.2), new THREE.Color(0.3, 0.8, 1), new THREE.Color(0.45, 1, 0.45), new THREE.Color(0.85, 0.45, 1), new THREE.Color(1, 0.6, 0.2)],
};
function rndDir(v) { const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u); return v.set(r * Math.cos(a), u, r * Math.sin(a)); }

// ── ніки поверх 3D ──
class Labels {
  constructor(host) {
    this.cv = document.createElement('canvas'); this.cv.className = 'br-labels';
    host.appendChild(this.cv); this.x = this.cv.getContext('2d'); this.w = 0; this.h = 0; this.dpr = 1;
  }
  resize(w, h) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr; this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
  }
  begin() { const x = this.x; x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); x.clearRect(0, 0, this.w, this.h); return x; }
  project(cam, p, out) {
    _v.copy(p).project(cam);
    out.x = (_v.x * 0.5 + 0.5) * this.w; out.y = (-_v.y * 0.5 + 0.5) * this.h; out.z = _v.z;
    return out.z < 1 && out.z > -1;
  }
  pill(x, y, text, opt) {
    opt = opt || {};
    const c = this.x, fs = opt.fs || 12;
    c.font = '800 ' + fs + 'px Manrope, system-ui, sans-serif';
    const tw = c.measureText(text).width, pad = fs * 0.55, h = fs * 1.55, w = tw + pad * 2 + (opt.dot ? fs * 0.9 : 0);
    const X = Math.round(x - w / 2), Y = Math.round(y - h);
    c.globalAlpha = opt.a == null ? 1 : opt.a;
    c.fillStyle = opt.bg || 'rgba(12,14,22,0.78)';
    rr(c, X, Y, w, h, h / 2); c.fill();
    if (opt.border) { c.lineWidth = 1.5; c.strokeStyle = opt.border; c.stroke(); }
    let tx = X + pad;
    if (opt.dot) { c.fillStyle = opt.dot; c.beginPath(); c.arc(tx + fs * 0.3, Y + h / 2, fs * 0.3, 0, 7); c.fill(); tx += fs * 0.9; }
    c.fillStyle = opt.fg || '#fff'; c.textBaseline = 'middle'; c.fillText(text, tx, Y + h / 2 + 0.5);
    if (opt.hp != null) {
      const bw = w - 6, by = Y + h + 3;
      c.fillStyle = 'rgba(0,0,0,0.55)'; rr(c, X + 3, by, bw, 5, 2.5); c.fill();
      c.fillStyle = opt.hp > 0.5 ? '#5dff7a' : opt.hp > 0.25 ? '#ffd23f' : '#ff4b4b'; rr(c, X + 3, by, Math.max(2, bw * opt.hp), 5, 2.5); c.fill();
    }
    c.globalAlpha = 1;
    return { x: X, y: Y, w, h };
  }
}
function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

// ── сцена: рендерер, світло, композер ──
function makeRenderer(canvas, opts) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(opts && opts.dpr || 1.5, window.devicePixelRatio || 1));
  r.outputEncoding = THREE.sRGBEncoding; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.98;
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
  return r;
}
function lights(scene, size) {
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b5a3a, 0.72); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.2);
  sun.position.set(-0.55, 1, 0.35).multiplyScalar(size); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera; c.left = -size * 0.8; c.right = size * 0.8; c.top = size * 0.8; c.bottom = -size * 0.8; c.near = 1; c.far = size * 3.5;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);
  return { hemi, sun };
}
function skyTex() {
  const c = document.createElement('canvas'); c.width = 2; c.height = 256; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#4aa3ff'); g.addColorStop(0.55, '#9fd4ff'); g.addColorStop(1, '#e9f6ff');
  x.fillStyle = g; x.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
}

window.BR3 = {
  V, loadGLB, loadJSON, loadKit, hue, colorOf, cssOf, snd, sndInit, tintMat, zoneMat, waterMat, zoneWall, ZU,
  Crowd, Ragdoll, Debris, Fx, Labels, makeRenderer, lights, skyTex, rndDir, C, PARTS, ZERO,
};
})();
