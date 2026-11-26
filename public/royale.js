// ─────────────────────────────────────────────────────────────
//  БАТЛ РОЯЛЬ 2.0 — лобі на 3D-острові (Blender: blender/br_build.py → models/br/island.glb).
//  Правила ті самі: глядачі пишуть у чат координату (A1…J10) — десант падає в цю клітинку на парашуті;
//  стрімер стискає зону (фіолетовий шторм + стіна) і кидає червону зону (ракетний удар).
//  Вибулих розкидає фізика (ragdoll). Остання клітинка зони → фінал на арені (shootout.js, window.RSO).
//  Classic script після app.js. Контракт: startRoyale, closeRoyaleOverlay, royHandleMessage, royRender,
//  royaleShrinkZone, royaleRedZone, royLaunchFight, royNewGame, royToggleTestForm, royTest*.
//  Рушій — public/br/brcore.js (window.BR3).
// ─────────────────────────────────────────────────────────────

const RL_COLS = 'ABCDEFGHIJ';
const RL_N = 10;                        // 10×10 клітинок
const RL_CELL = 10;                     // світових одиниць на клітинку
const RL_SAVE_KEY = 'royaleState';
const RL_MIN_RADIUS = 0.5;
const RL_SHRINK_K = 0.62, RL_SHRINK_B = 0.3;
const RL_ANCHOR_R = 1.2;
const RL_MAX_PLAYERS = 100;             // місць на острові: перші 100, хто встиг написати координату
const RL_LABEL_MAX = 60;                // до стількох живих — ніки над усіма
const RL_SCALE = 2.1;                   // бійці на острові трохи «мультяшно» великі — щоб читались на стрімі
const RL_ZONE_MS = 2400;

let rlPlayers = {};       // nick -> {nick, num, col, row, alive, dying, removed, died}
let rlZone = null;        // квадрат по клітинках: {cx, cy — центр (у клітинках), radius — половина сторони, stage}
let rlJoinLocked = false;
let rlPhase = 'idle';     // idle | playing | shootout | finished
let rlPendingFight = null;
let rlWinner = null;
let rlNextNum = 1;
let rlDeathSeq = 0;
let rlRedBusy = false;
let rlZoneBusy = false;
let rlRedTimers = [];
let rlDom = null;
let rlRenderRAF = 0;
let rlSaveT = 0;
let rlRecent = new Map();
let rlHoverKey = null;

// ── Утиліти ──────────────────────────────────────────────────
function rlFloat() { return secureRandomInt(1000000) / 1000000; }
function rlClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rlAlive() { return Object.values(rlPlayers).filter(p => p.alive); }
function rlDist(c, r, cx, cy) { return Math.hypot(c - cx, r - cy); }
function rlInZone(c, r, z) { z = z || rlZone; return !z || (Math.abs(c - z.cx) <= z.radius - 0.5 + 1e-6 && Math.abs(r - z.cy) <= z.radius - 0.5 + 1e-6); }
// відстань від клітинки до квадрата зони (0 — всередині)
function rlZoneDist(c, r, z) { const dx = Math.max(0, Math.abs(c - z.cx) - (z.radius - 0.5)), dy = Math.max(0, Math.abs(r - z.cy) - (z.radius - 0.5)); return Math.hypot(dx, dy); }
function rlCoordName(c, r) { return RL_COLS[c] + (r + 1); }
function rlEsc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function rlParseCoord(text) {
  const m = String(text || '').trim().match(/^([A-Ja-j])\s*([1-9]|10)$/);
  if (!m) return null;
  const col = RL_COLS.indexOf(m[1].toUpperCase()), row = parseInt(m[2], 10) - 1;
  if (col < 0 || row < 0 || row >= RL_N) return null;
  return { col, row };
}
function rlStatus(msg) {
  if (!rlDom || !rlDom.status) return;
  rlDom.status.textContent = msg; rlDom.status.title = msg;
  if (rlDom.toast) {
    rlDom.toast.textContent = msg; rlDom.toast.classList.remove('rl-show'); void rlDom.toast.offsetWidth; rlDom.toast.classList.add('rl-show');
    clearTimeout(rlDom._toastT); rlDom._toastT = setTimeout(() => rlDom.toast && rlDom.toast.classList.remove('rl-show'), 4200);
  }
}
// клітинка → світ
function rlWX(c) { return (c - (RL_N - 1) / 2) * RL_CELL; }
function rlWZ(r) { return (r - (RL_N - 1) / 2) * RL_CELL; }

// ── DOM ──────────────────────────────────────────────────────
function rlEnsureDom() {
  if (rlDom && rlDom.root && document.body.contains(rlDom.root)) return rlDom;
  const root = document.getElementById('royale-overlay');
  if (!root) return null;
  const q = id => document.getElementById(id);
  rlDom = {
    root,
    status: q('rl-status'), alive: q('rl-alive-n'), zoneChip: q('rl-zone-chip'), lockChip: q('rl-lock-chip'),
    aliveList: q('rl-alive-list'), deadList: q('rl-dead-list'), aliveCnt: q('rl-alive-cnt'), deadCnt: q('rl-dead-cnt'),
    stage: q('rl-stage'), map: q('rl-map'), tip: q('rl-tip'), banner: q('rl-banner'), bannerNick: q('rl-banner-nick'),
    zoneBtn: q('rl-zone-btn'), redBtn: q('rl-red-btn'), fightBtn: q('rl-fight-btn'),
    testForm: q('rl-test-form'), testArea: q('rl-test-area'), testMsg: q('rl-test-msg'), testPartBtn: q('rl-test-part-btn'),
    dAlive: q('rl-d-alive'), dZone: q('rl-d-zone'), dSeat: q('rl-d-seat'), dSeatK: q('rl-d-seat-k'), fightN: q('rl-fight-n'),
    dRing: q('rl-d-ring'), dSRing: q('rl-d-sring'), dZmap: q('rl-d-zmap'),
  };
  // гарячі клавіші панелі: Q — зона, W — ракети, E — фінал (за фізичною клавішею — працює й на кирилиці)
  if (!window._rlKeys) {
    window._rlKeys = true;
    window.addEventListener('keydown', e => {
      if (!rlDom || !rlDom.root.classList.contains('visible') || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const so = document.getElementById('royale-shootout'); if (so && so.classList.contains('visible')) return;
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const btn = e.code === 'KeyQ' ? rlDom.zoneBtn : e.code === 'KeyW' ? rlDom.redBtn : e.code === 'KeyE' ? rlDom.fightBtn : null;
      if (!btn || btn.disabled) return;
      e.preventDefault(); btn.classList.add('rl-press'); setTimeout(() => btn.classList.remove('rl-press'), 160); btn.click();
    });
  }
  if (!q('rl-toast') && rlDom.stage) { const t = document.createElement('div'); t.id = 'rl-toast'; t.className = 'rl-toast'; rlDom.stage.appendChild(t); }
  rlDom.toast = q('rl-toast');
  if (rlDom.aliveList && !rlDom.aliveList._rlHooked) {
    for (const list of [rlDom.aliveList, rlDom.deadList]) {
      if (!list) continue;
      list._rlHooked = true;
      list.addEventListener('mouseover', e => {
        const row = e.target.closest('.rl-row'); if (!row) return;
        rlHoverCell(+row.dataset.c, +row.dataset.r, false);
      });
      list.addEventListener('mouseleave', () => rlUnhover());
    }
  }
  return rlDom;
}

// ══════════════════════════ 3D-ОСТРІВ (MOBA-подача) ══════════════════════════
// Острів зібрано в Blender (blender/br_island2.blend → models/br/island2.glb + island_kit.glb + island2.json):
// рельєф із вершинними кольорами, дерева/будинки/табір — інстансами набору. Бійці — анімований мультяшний солдат
// (models/br/soldier.glb: Idle, Run, Death, Wave…), під ногами — кольорове коло гравця, над головою — нік і смужка.
// Камера — зверху під кутом, як у MOBA: колесо — зум, тягнути мишею — рух, мінімапа зліва внизу.
const RV = { ready: false, loading: null, vis: new Map(), t: 0, last: 0, raf: 0, cam: { x: 0, z: 2, zoom: 1, tx: 0, tz: 2, tzoom: 1, focus: null, fp: null },
  plane: null, missiles: [], zoneAnim: null, redK: 0, redTarget: 0, red: null, drag: null };
const RL_SOLDIER_S = 1.15;
function rlGround(x, z) {
  const H = RV.hmap; if (!H) return 0;
  const fx = (x + H.e) / H.step, fz = (z + H.e) / H.step, n = H.n;
  const i = Math.max(0, Math.min(n - 2, Math.floor(fx))), j = Math.max(0, Math.min(n - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i)), tz = Math.max(0, Math.min(1, fz - j));
  const h = H.h, a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
  return ((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz) / 100;
}
function rlStand(x, z) { return Math.max(rlGround(x, z), -0.3); }

// матеріал солдата: вершинні кольори, пурпур (форма) → колір гравця
function rlSoldierMat(col) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, skinning: true });   // r128: скінінг вмикається в матеріалі
  m.userData.tint = { value: col.clone() };
  m.onBeforeCompile = sh => {
    sh.uniforms.uTint = m.userData.tint;
    sh.vertexShader = 'uniform vec3 uTint;\n' + sh.vertexShader.replace('#include <color_vertex>',
      '#include <color_vertex>\n#ifdef USE_COLOR\n  vColor.xyz = color.xyz;\n  if (color.r > 0.97 && color.g < 0.03 && color.b > 0.97) vColor.xyz = uTint;\n#endif');
  };
  m.customProgramCacheKey = () => 'br-soldier';
  return m;
}
// текстура кола під ногами (MOBA-кільце з легким сяйвом)
function rlRingTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 30, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.62, 'rgba(255,255,255,0.18)'); g.addColorStop(0.78, 'rgba(255,255,255,1)');
  g.addColorStop(0.86, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.beginPath(); x.arc(64, 64, 63, 0, 7); x.fill();
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
}

function rl3dInit() {
  if (RV.ready) return Promise.resolve(true);
  if (RV.loading) return RV.loading;
  if (typeof THREE === 'undefined' || !window.BR3 || !THREE.SkeletonUtils) return Promise.resolve(false);
  RV.loading = Promise.all([BR3.loadKit(), BR3.loadGLB('island2.glb'), BR3.loadGLB('island_kit.glb'), BR3.loadJSON('island2.json'), BR3.loadGLB('soldier.glb')]).then(([kit, glb, kitg, js, sold]) => {
    const host = rlDom.stage;
    const cv = document.createElement('canvas'); cv.className = 'rl-cv'; host.insertBefore(cv, host.firstChild);
    const R = BR3.makeRenderer(cv, { dpr: 1.5 });
    R.toneMappingExposure = 0.95;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a8fd0);
    scene.fog = new THREE.Fog(0x63b7e6, 190, 420);
    const camera = new THREE.PerspectiveCamera(32, 1, 1, 1000);
    const L = BR3.lights(scene, 95);
    L.hemi.intensity = 0.55; L.sun.intensity = 1.2; L.sun.color.set(0xfff0d0); L.sun.position.set(-48, 95, 40);
    RV.hmap = { e: js.e, step: js.step, n: js.n, h: js.h };
    RV.foot = js.foot || [];
    // рельєф: вершинні кольори + шторм/червона зона/сітка
    const tMat = BR3.zoneMat({ grid: true });
    glb.scene.traverse(o => { if (o.isMesh) { o.material = tMat; o.receiveShadow = true; RV.terrain = o; } });
    scene.add(glb.scene);
    // набір: прототипи → інстанси
    const protos = {};
    kitg.scene.updateMatrixWorld(true);
    kitg.scene.traverse(o => {
      if (!o.isMesh) return;
      let n = o; while (n && !/^K_/.test(n.name)) n = n.parent;
      if (!n) return;
      const key = n.name.slice(2);
      const local = new THREE.Matrix4().copy(n.matrixWorld).invert().multiply(o.matrixWorld);
      (protos[key] = protos[key] || []).push({ geo: o.geometry, mat: o.material, local });
    });
    RV.protos = protos; RV.place = js.place;   // фінал б'ється прямо на острові — йому потрібні моделі й розстановка
    const byProto = {};
    for (const p of js.place) (byProto[p[0]] = byProto[p[0]] || []).push(p);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    RV.props = [];
    for (const key in byProto) {
      const parts = protos[key]; if (!parts) continue;
      const list = byProto[key];
      for (const part of parts) {
        const mat = part.mat;
        if (mat && mat.map) mat.map.anisotropy = 4;
        if (mat && 'roughness' in mat) { mat.roughness = Math.max(0.75, mat.roughness); mat.metalness = 0; }
        const im = new THREE.InstancedMesh(part.geo, mat, list.length);
        list.forEach((p, i) => {
          q.setFromAxisAngle(Y, p[4]); s.set(p[5], p[5], p[5]); v.set(p[1], p[2], p[3]);
          m4.compose(v, q, s).multiply(part.local); im.setMatrixAt(i, m4);
        });
        im.castShadow = true; im.receiveShadow = true;
        scene.add(im); RV.props.push(im);
      }
    }
    // вода
    const n = js.n, data = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) { const vv = Math.max(0, Math.min(255, Math.round(((js.h[i] / 100) + 20) / 40 * 255))); data[i * 4] = vv; data[i * 4 + 3] = 255; }
    const hTex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat); hTex.magFilter = THREE.LinearFilter; hTex.minFilter = THREE.LinearFilter; hTex.needsUpdate = true;
    const water = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200, 1, 1), BR3.waterMat(hTex, js.e));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.05; scene.add(water);
    RV.wall = BR3.zoneWall(true); RV.wall.visible = false; scene.add(RV.wall);
    // солдат-шаблон
    RV.soldier = sold; RV.clips = {}; sold.animations.forEach(a => RV.clips[a.name] = a);
    RV.chuteGeo = kit.geo.Chute; RV.crownGeo = kit.geo.Crown;
    RV.chuteMat = BR3.tintMat({ side: THREE.DoubleSide }); RV.crownMat = BR3.tintMat();
    // кола під ногами
    RV.rings = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.2, 2.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: rlRingTex(), transparent: true, depthWrite: false, toneMapped: false }), 800);
    for (let i = 0; i < 800; i++) RV.rings.setColorAt(i, new THREE.Color(1, 1, 1));   // до count=0: r128 створює instanceColor під поточний count
    RV.rings.count = 0; RV.rings.frustumCulled = false; RV.rings.renderOrder = 2; RV.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(RV.rings);
    RV.fx = new BR3.Fx(scene, rlStand);
    RV.labels = new BR3.Labels(host);
    RV.plane = new THREE.Mesh(kit.geo.Plane, BR3.tintMat()); RV.plane.visible = false; RV.plane.castShadow = true; scene.add(RV.plane);
    RV.missileGeo = kit.geo.Missile; RV.missileMat = BR3.tintMat();
    RV.spot = new THREE.SpotLight(0xfff1c2, 0, 60, 0.35, 0.6, 1.2); scene.add(RV.spot); scene.add(RV.spot.target);
    RV.list = [];
    Object.assign(RV, { R, scene, camera, L, cv, ready: true });
    rlMinimapInit(host);
    host.addEventListener('mousemove', rlMouseMove);
    host.addEventListener('mouseleave', () => { rlUnhover(); RV.drag = null; });
    host.addEventListener('mousedown', e => { if (e.target === RV.cv || e.target.classList.contains('br-labels')) RV.drag = { x: e.clientX, y: e.clientY, cx: RV.cam.tx, cz: RV.cam.tz, moved: false }; });
    window.addEventListener('mouseup', () => { RV.drag = null; });
    host.addEventListener('wheel', e => { e.preventDefault(); RV.cam.tzoom = Math.max(0.28, Math.min(1, RV.cam.tzoom * (e.deltaY > 0 ? 1.12 : 0.89))); }, { passive: false });
    window.addEventListener('resize', rlResize3d);
    rlResize3d();
    rlSnapMinimap();
    rlSync3d(true);
    return true;
  }).catch(e => { console.warn('[royale] 3D не завантажилось', e); RV.loading = null; return false; });
  return RV.loading;
}
function rlResize3d() {
  if (!RV.ready) return;
  const r = rlDom.stage.getBoundingClientRect(), w = Math.max(10, r.width | 0), h = Math.max(10, r.height | 0);
  RV.R.setSize(w, h, false); RV.camera.aspect = w / h; RV.camera.updateProjectionMatrix();
  RV.labels.resize(w, h); RV.w = w; RV.h = h;
  // «весь острів»: найменша дистанція, за якої сітка (з полями) у кадрі; острів центруємо у вільній зоні між верхом
  // і доком (док знизу перекриває кадр, тож карту трохи піднято — без порожнечі зверху)
  const cam = RV.camera, pos = new THREE.Vector3(), look = new THREE.Vector3(), p = new THREE.Vector3();
  const dk = document.getElementById('rl-dock'), dr = dk && dk.offsetParent ? dk.getBoundingClientRect() : null;
  const dockPx = dr && dr.height ? Math.max(0, r.bottom - dr.top) : 0;
  const yTop = 0.95, yBot = -1 + 2 * (dockPx * 0.55 + 6) / h, yMid = (yTop + yBot) / 2;
  const span = (hz) => { rlCamPose(0, hz, 1, pos, look); cam.position.copy(pos); cam.lookAt(look); cam.updateMatrixWorld(true);
    let y0 = 9, y1 = -9, xm = 0;
    for (const [x, z] of [[-57, -56], [57, -56], [-57, 57], [57, 57]]) { p.set(x, 1, z).project(cam); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); xm = Math.max(xm, Math.abs(p.x)); }
    return { y0, y1, xm }; };
  let lo = 40, hi = 600, homeZ = 2;
  for (let it = 0; it < 30; it++) {
    const D = (lo + hi) / 2; RV.Dfit = D;
    // зсув погляду так, щоб середина острова припала на середину вільної зони
    let a = -40, b = 60;
    for (let k = 0; k < 22; k++) { const m = (a + b) / 2, S = span(m); if ((S.y0 + S.y1) / 2 < yMid) a = m; else b = m; }
    const hz = (a + b) / 2, S = span(hz);
    if (S.xm <= 0.96 && S.y1 <= yTop && S.y0 >= yBot) { hi = D; homeZ = hz; } else lo = D;
  }
  RV.Dfit = hi;
  const wasHome = Math.abs(RV.cam.tz - (RV.homeZ == null ? 2 : RV.homeZ)) < 0.01 && Math.abs(RV.cam.tx) < 0.01;
  RV.homeZ = homeZ;
  if (wasHome) { RV.cam.tz = homeZ; RV.cam.z = homeZ; }
}
function rlLoop() {
  RV.raf = 0;
  if (!RV.ready || rlPhase === 'idle') return;
  const shootout = document.getElementById('royale-shootout');
  const paused = shootout && shootout.classList.contains('visible');
  const now = performance.now(), dt = Math.min(0.05, (now - (RV.last || now)) / 1000); RV.last = now;
  if (!paused) { RV.t += dt; rlStep3d(dt); RV.R.render(RV.scene, RV.camera); rlDrawLabels(); rlDrawMinimap(); }
  RV.raf = requestAnimationFrame(rlLoop);
}
function rlKick() { if (!RV.raf && RV.ready) { RV.last = performance.now(); RV.raf = requestAnimationFrame(rlLoop); } }

// ── камера: MOBA-кут; зум колесом, рух мишею/мінімапою, на переможця — наїзд ──
const _rlV = new THREE.Vector3(), _rlV2 = new THREE.Vector3(), _rlP = { x: 0, y: 0, z: 0 };
const RL_PITCH = 0.98;   // ~56° вниз
function rlCamPose(cx, cz, zoom, out, look) {
  const D = (RV.Dfit || 140) * zoom;
  look.set(cx, 1, cz);
  out.set(cx, 1 + Math.sin(RL_PITCH) * D, cz + Math.cos(RL_PITCH) * D);
  return D;
}
function rlCamera(dt) {
  const C = RV.cam, k = Math.min(1, dt * 5);
  const F = C.focus ? RV.vis.get(C.focus) : null;
  if (F) { C.tx = F.x; C.tz = F.z + 1; C.tzoom = 0.3; }
  const lim = 55 * (1 - C.tzoom) + 4;
  C.tx = Math.max(-lim, Math.min(lim, C.tx)); C.tz = Math.max(-lim, Math.min(Math.max(lim + 6, (RV.homeZ == null ? 2 : RV.homeZ) + 1), C.tz));
  C.x += (C.tx - C.x) * k; C.z += (C.tz - C.z) * k; C.zoom += (C.tzoom - C.zoom) * k;
  const pos = _rlV, look = _rlV2;
  rlCamPose(C.x, C.z, C.zoom, pos, look);
  const sh = RV.fx.shake;
  if (sh > 0) { pos.x += (Math.random() - 0.5) * sh * 1.4; pos.y += (Math.random() - 0.5) * sh; pos.z += (Math.random() - 0.5) * sh * 1.4; }
  RV.camera.position.copy(pos); RV.camera.lookAt(look);
}

// ── бійці ──
function rlSpotIn(c, r, nick) {
  const x0 = rlWX(c), z0 = rlWZ(r), others = [];
  RV.vis.forEach(v => { if (!v.dead && v.c === c && v.r === r && v.nick !== nick) others.push(v); });
  let best = null, bestS = -1e9;
  for (let k = 0; k < 26; k++) {
    const x = x0 + (Math.random() - 0.5) * RL_CELL * 0.84, z = z0 + (Math.random() - 0.5) * RL_CELL * 0.84;
    let s = 0;
    for (const f of RV.foot) { const d = Math.hypot(x - f[0], z - f[1]) - f[2]; if (d < 0.8) s -= (0.8 - d) * 5; }
    let md = 99; for (const o of others) md = Math.min(md, Math.hypot(x - o.tx, z - o.tz));
    s += Math.min(md, 3.5) * 1.6;
    if (rlGround(x, z) < 0.15) s -= 5;
    if (s > bestS) { bestS = s; best = { x, z }; }
  }
  return best;
}
function rlVisAdd(p, drop) {
  const sp = rlSpotIn(p.col, p.row, p.nick);
  const col = BR3.colorOf(p.nick);
  const uni = new THREE.Color().setHSL(BR3.hue(p.nick) / 360, 0.85, 0.36);   // форма — насиченіша й темніша за нік
  const o = THREE.SkeletonUtils.clone(RV.soldier.scene);
  const mat = rlSoldierMat(uni);
  let head = null;
  o.traverse(n => { if (n.isMesh) { n.material = mat; n.castShadow = true; n.frustumCulled = false; } if (n.isBone && /^Head$/.test(n.name)) head = n; });
  o.scale.setScalar(RL_SOLDIER_S);
  RV.scene.add(o);
  const mixer = new THREE.AnimationMixer(o);
  const v = { nick: p.nick, num: p.num, c: p.col, r: p.row, tx: sp.x, tz: sp.z, x: sp.x, z: sp.z, y: rlStand(sp.x, sp.z), yaw: (Math.random() - 0.5) * 1.2,
    col, css: BR3.cssOf(p.nick), obj: o, mat, mixer, head, act: null, mode: 'stand', dead: false, born: RV.t, vy: 0, vx: 0, vz: 0, air: false };
  if (drop) {
    v.mode = 'chute'; v.y += 30 + Math.random() * 8; v.drop = 1;
    const cm = rlSoldierMat(uni); cm.side = THREE.DoubleSide;
    v.chute = new THREE.Mesh(RV.chuteGeo, cm); v.chute.scale.setScalar(0.01); o.add(v.chute); v.chute.position.set(0, 1.55, 0);
    BR3.snd && BR3.snd('br-chute', 0.3, 1, 150);
  }
  rlPlay(v, drop ? 'Wave' : 'Idle');
  RV.vis.set(p.nick, v); RV.list.push(v);
  return v;
}
function rlPlay(v, name, once) {
  const clip = RV.clips[name]; if (!clip) return;
  if (v.actName === name) return;
  const a = v.mixer.clipAction(clip);
  a.reset(); a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat); a.clampWhenFinished = !!once;
  if (v.act) a.crossFadeFrom(v.act, 0.18, false);
  a.play(); v.act = a; v.actName = name;
}
function rlVisRemove(v) {
  RV.scene.remove(v.obj); v.mixer.stopAllAction(); v.mat.dispose();
  RV.vis.delete(v.nick);
  const i = RV.list.indexOf(v); if (i >= 0) RV.list.splice(i, 1);
}
function rlSync3d(initial) {
  if (!RV.ready) return;
  const seen = new Set();
  Object.values(rlPlayers).forEach(p => {
    seen.add(p.nick);
    let v = RV.vis.get(p.nick);
    if (p.removed) { if (v) { RV.fx.dust(new THREE.Vector3(v.x, v.y, v.z), 0.6); rlVisRemove(v); } return; }
    if (!v) { v = rlVisAdd(p, !initial && p.alive); if (!p.alive) rlVisDie(v, null, true); return; }
    if (p.alive && (v.c !== p.col || v.r !== p.row) && !v.dead) { v.c = p.col; v.r = p.row; const sp = rlSpotIn(p.col, p.row, p.nick); v.tx = sp.x; v.tz = sp.z; }
    if (!p.alive && !v.dead) rlVisDie(v, null, initial);
    if (p.alive && v.dead) { rlVisRemove(v); rlVisAdd(p, false); }
  });
  RV.vis.forEach((v, nick) => { if (!seen.has(nick)) rlVisRemove(v); });
  const w = rlWinner && rlPhase === 'finished' ? RV.vis.get(rlWinner) : null;
  RV.list.forEach(v => {
    const on = v === w;
    if (on && !v.crown && v.head) { v.crown = new THREE.Mesh(RV.crownGeo, RV.crownMat); v.crown.position.set(0, 0.62, 0); v.crown.scale.setScalar(1.35); v.head.add(v.crown); }
    if (!on && v.crown) { v.crown.parent && v.crown.parent.remove(v.crown); v.crown = null; }
  });
  if (w && RV.cam.focus !== w.nick) { RV.cam.focus = w.nick; RV.fx.confetti(new THREE.Vector3(w.x, w.y + 4, w.z), 140, 10); }
  if (!w) RV.cam.focus = null;
  rlKick();
}
// смерть: анімація падіння + фізичний відкид (вибух/блискавка)
function rlVisDie(v, cause, quiet) {
  if (v.dead) return;
  v.dead = true; v.diedT = RV.t; v.mode = 'dead';
  if (v.chute) { v.obj.remove(v.chute); v.chute = null; }
  if (v.drop) { v.y = rlStand(v.x, v.z); v.drop = 0; }
  rlPlay(v, 'Death', true);
  if (quiet) { v.act.time = v.act.getClip().duration; v.mixer.update(0); return; }
  let dx = (Math.random() - 0.5), dz = (Math.random() - 0.5), k = 4, up = 7;
  if (cause && cause.from) {
    dx = v.x - cause.from.x; dz = v.z - cause.from.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    if (cause.kind === 'boom') { k = Math.max(9, 26 - L * 1.2); up = 15 + Math.random() * 7; } else { k = 7; up = 8; }
  }
  v.vx = dx * k; v.vz = dz * k; v.vy = up; v.air = true; v.spin = (Math.random() - 0.5) * 12;
  v.yaw = Math.atan2(-dx, -dz);   // падає навзнак від удару
}

const _rlTmp = new THREE.Vector3(), _rlM4 = new THREE.Matrix4(), _rlQ = new THREE.Quaternion(), _rlS = new THREE.Vector3(), _rlY = new THREE.Vector3(0, 1, 0);
function rlStep3d(dt) {
  const t = RV.t;
  BR3.ZU.uTime.value = t;
  // зона
  const Z = RV.zoneAnim;
  let zc = null;
  if (Z) {
    const k = Math.min(1, (performance.now() - Z.t0) / Z.ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    zc = { cx: Z.a.cx + (Z.b.cx - Z.a.cx) * e, cy: Z.a.cy + (Z.b.cy - Z.a.cy) * e, radius: Z.a.radius + (Z.b.radius - Z.a.radius) * e };
    if (k >= 1) { RV.zoneAnim = null; const d = Z.done; Z.done = null; if (d) d(); }
  } else zc = rlZone;
  RV.zc = zc;
  if (zc) {
    const X = rlWX(zc.cx), Zz = rlWZ(zc.cy), Rr = zc.radius * RL_CELL;
    BR3.ZU.uZone.value.set(X, Zz, Rr, 1);
    RV.wall.visible = true; RV.wall.position.set(X, -3, Zz); RV.wall.scale.set(Rr * Math.SQRT2, 36, Rr * Math.SQRT2);
  } else { BR3.ZU.uZone.value.w = 0; RV.wall.visible = false; }
  BR3.ZU.uGrid.value = 1; BR3.ZU.uZoneSq.value = 1;
  RV.redK += (RV.redTarget - RV.redK) * Math.min(1, dt * 5);
  if (RV.red) BR3.ZU.uRed.value.set(rlWX(RV.red.cx), rlWZ(RV.red.cy), RV.red.radius * RL_CELL, RV.redK * (0.75 + 0.25 * Math.sin(t * 9)));
  else BR3.ZU.uRed.value.w = 0;
  // ракети
  for (let i = RV.missiles.length - 1; i >= 0; i--) {
    const m = RV.missiles[i]; m.t += dt;
    const k = Math.min(1, Math.max(0, m.t) / m.dur);
    m.mesh.position.set(m.x + m.dx * (1 - k), m.gy + 60 * (1 - k * k), m.z + m.dz * (1 - k));
    if (m.t > 0 && Math.random() < 0.9) RV.fx.trail(_rlTmp.copy(m.mesh.position).add(new THREE.Vector3(0, 2.5, 0)));
    if (k >= 1) {
      RV.scene.remove(m.mesh); RV.missiles.splice(i, 1);
      const at = new THREE.Vector3(m.x, m.gy, m.z);
      RV.fx.boom(at, 1.5); BR3.snd('br-boom', 0.75, 0.85 + Math.random() * 0.3, 60);
      if (m.onHit) m.onHit(at);
    }
  }
  // літак
  if (RV.plane.visible) {
    const P = RV.planeFly; P.t += dt; const k = P.t / P.dur;
    if (k >= 1) RV.plane.visible = false;
    else { RV.plane.position.set(P.ax + (P.bx - P.ax) * k, 78, P.az + (P.bz - P.az) * k); RV.plane.rotation.set(0, P.yaw, Math.sin(RV.t * 0.8) * 0.06); RV.plane.scale.setScalar(1.15); }
  } else if (!rlJoinLocked && rlPhase === 'playing' && Object.keys(rlPlayers).length && RV.t - (RV.planeAt || -99) > 26) rlFlyPlane();
  // бійці
  let ri = 0, fresh = 0;
  for (const v of RV.list) {
    if (v.dead) {
      if (v.air) {
        v.vy -= 30 * dt; v.x += v.vx * dt; v.z += v.vz * dt; v.y += v.vy * dt;
        const gy = rlStand(v.x, v.z);
        if (v.y <= gy) { v.y = gy; if (v.vy < -6) { v.vy = -v.vy * 0.25; v.vx *= 0.5; v.vz *= 0.5; RV.fx.dust(new THREE.Vector3(v.x, gy, v.z), 0.5); } else { v.air = false; v.vy = 0; } }
      }
    } else if (v.mode === 'chute') {
      const gy = rlStand(v.x, v.z);
      v.y -= dt * (10 + Math.sin(t * 2 + v.num) * 1.4); v.yaw += dt * 0.5;
      if (v.chute) { const c = Math.min(1, v.chute.scale.x + dt * 3); v.chute.scale.setScalar(c); v.chute.rotation.z = Math.sin(t * 2 + v.num) * 0.08; }
      if (v.y <= gy) {
        v.y = gy; v.mode = 'stand'; v.drop = 0; v.yaw = (Math.random() - 0.5) * 1.2;
        if (v.chute) { v.obj.remove(v.chute); v.chute = null; }
        rlPlay(v, 'Idle'); RV.fx.dust(new THREE.Vector3(v.x, gy, v.z), 0.7);
        if (fresh++ < 3) BR3.snd('br-land', 0.35, 0.9 + Math.random() * 0.3, 90);
      }
    } else {
      const dx = v.tx - v.x, dz = v.tz - v.z, d = Math.hypot(dx, dz);
      if (d > 0.3) {
        // швидка перебіжка: база 22 од./с (~пів секунди на клітинку), на далеку відстань — розгін, тож навіть через увесь острів ≈ 2 с
        const vel = Math.max(22, d * 1.7), sp = Math.min(d, dt * vel);
        v.x += dx / d * sp; v.z += dz / d * sp; v.y = rlStand(v.x, v.z);
        const want = Math.atan2(dx, dz); let a = want - v.yaw; while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; v.yaw += a * Math.min(1, dt * 14);
        if (v.mode !== 'run') { v.mode = 'run'; rlPlay(v, 'Run'); }
        if (v.act) v.act.timeScale = Math.min(2.4, Math.max(1.4, vel / 16));   // ноги встигають за швидкістю
      } else if (v.mode === 'run') { v.mode = 'stand'; rlPlay(v, 'Idle'); }
      if (v.crown && v.actName !== 'Wave') rlPlay(v, 'Wave');
      if (!v.crown && v.actName === 'Wave' && v.mode === 'stand') rlPlay(v, 'Idle');
    }
    v.mixer.update(dt);
    v.obj.position.set(v.x, v.y, v.z); v.obj.rotation.set(0, v.yaw, 0);
    // кільце
    if (!v.dead || RV.t - v.diedT < 1.2) {
      const gy = rlStand(v.x, v.z) + 0.07, sc = v.dead ? 1 - (RV.t - v.diedT) / 1.2 : (v.mode === 'chute' ? 0.6 + 0.4 * Math.sin(t * 6) : 1);
      _rlQ.identity(); _rlS.set(sc, 1, sc); _rlTmp.set(v.x, gy, v.z);
      RV.rings.setMatrixAt(ri, _rlM4.compose(_rlTmp, _rlQ, _rlS)); RV.rings.setColorAt(ri, v.dead ? BR3.C.red : v.col); ri++;
    }
  }
  RV.rings.count = ri; RV.rings.instanceMatrix.needsUpdate = true; if (RV.rings.instanceColor) RV.rings.instanceColor.needsUpdate = true;
  RV.fx.step(dt, RV.camera);
  const W = RV.cam.focus ? RV.vis.get(RV.cam.focus) : null;
  if (W) {
    RV.spot.intensity += (2.2 - RV.spot.intensity) * Math.min(1, dt * 2); RV.spot.position.set(W.x, W.y + 22, W.z + 4); RV.spot.target.position.set(W.x, W.y, W.z);
    if (RV.t - (RV.lastConf || 0) > 2.2) { RV.lastConf = RV.t; RV.fx.confetti(new THREE.Vector3(W.x, W.y + 5, W.z), 50, 12); }
  } else RV.spot.intensity *= 0.9;
  rlCamera(dt);
}
function rlFlyPlane() {
  RV.planeAt = RV.t;
  const a = Math.random() * Math.PI * 2, R = 160;
  const ax = Math.cos(a) * R, az = Math.sin(a) * R;
  RV.planeFly = { ax, az, bx: -ax, bz: -az, t: 0, dur: 14, yaw: Math.atan2(-ax - ax, -az - az) };
  RV.plane.visible = true; BR3.snd('br-plane', 0.3, 1, 1000);
}

// ── ніки (MOBA: нік + сегментна смужка в кольорі гравця) і осі ──
function rlDrawLabels() {
  const Lb = RV.labels, c = Lb.begin(), cam = RV.camera, P = _rlP;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = '800 16px Unbounded, Manrope, sans-serif';
  c.lineJoin = 'round';
  for (let i = 0; i < RL_N; i++) {
    const x = rlWX(i), z = rlWZ(i);
    for (const [px, pz, s] of [[x, -52.5, RL_COLS[i]], [x, 52.5, RL_COLS[i]], [-52.5, z, String(i + 1)], [52.5, z, String(i + 1)]]) {
      if (!Lb.project(cam, _rlV.set(px, Math.max(0.6, rlGround(px, pz)) + 0.4, pz), P)) continue;
      c.lineWidth = 4; c.strokeStyle = 'rgba(10,20,30,0.55)'; c.strokeText(s, P.x, P.y); c.fillStyle = 'rgba(255,255,255,0.92)'; c.fillText(s, P.x, P.y);
    }
  }
  const alive = RV.list.filter(v => !v.dead);
  const many = alive.length > RL_LABEL_MAX && RV.cam.zoom > 0.6;
  const now = performance.now(), hover = rlHoverKey;
  const items = [];
  for (const v of RV.list) {
    if (v.dead) {
      const age = RV.t - (v.diedT || 0); if (age > 3) continue;
      if (Lb.project(cam, _rlV.set(v.x, v.y + 3, v.z), P)) items.push({ x: P.x, y: P.y - age * 10, z: P.z, v, dead: 1, a: Math.max(0, 1 - age / 3) });
      continue;
    }
    const recent = (now - (rlRecent.get(v.nick) || 0)) < 5000 || v.mode === 'chute';
    if (many && !recent && hover !== v.c + ',' + v.r && !v.crown) continue;
    if (Lb.project(cam, _rlV.set(v.x, v.y + 2.75 * RL_SOLDIER_S, v.z), P)) items.push({ x: P.x, y: P.y, z: P.z, v });
  }
  items.sort((a, b) => b.z - a.z);
  const fs = Math.round(Math.max(10, Math.min(14, 13 / Math.sqrt(RV.cam.zoom))));
  for (const it of items) {
    const v = it.v;
    c.globalAlpha = it.a == null ? 1 : it.a;
    c.font = '800 ' + fs + 'px Manrope, system-ui, sans-serif';
    c.lineWidth = 3.5; c.strokeStyle = 'rgba(8,10,16,0.85)';
    const txt = it.dead ? '✕ ' + v.nick : v.nick;
    c.strokeText(txt, it.x, it.y - 9); c.fillStyle = it.dead ? '#ff8a8a' : (v.crown ? '#ffd23f' : '#fff'); c.fillText(txt, it.x, it.y - 9);
    if (!it.dead) {   // сегментна смужка
      const W = Math.max(34, Math.min(64, c.measureText(v.nick).width)), H = 5, x0 = it.x - W / 2, y0 = it.y;
      c.fillStyle = 'rgba(8,10,16,0.85)'; c.fillRect(x0 - 1.5, y0 - 1.5, W + 3, H + 3);
      c.fillStyle = v.css; c.fillRect(x0, y0, W, H);
      c.fillStyle = 'rgba(0,0,0,0.45)'; for (let k = 1; k < 5; k++) c.fillRect(x0 + W * k / 5 - 0.5, y0, 1, H);
    }
  }
  c.globalAlpha = 1;
}

// ── мінімапа (знімок острова згори + сітка, зона, гравці, рамка камери) ──
function rlMinimapInit(host) {
  let mm = document.getElementById('rl-minimap');
  if (!mm) {
    mm = document.createElement('div'); mm.id = 'rl-minimap'; mm.className = 'rl-minimap';
    mm.innerHTML = '<canvas></canvas><button class="rl-mm-home" type="button" title="Весь остров">Весь остров</button>';
    host.appendChild(mm);
  }
  RV.mm = { el: mm, cv: mm.querySelector('canvas'), img: null };
  const go = e => {
    const r = RV.mm.cv.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, w = (e.clientY - r.top) / r.height;
    RV.cam.tx = (u - 0.5) * 120; RV.cam.tz = (w - 0.5) * 120; if (RV.cam.tzoom > 0.55) RV.cam.tzoom = 0.5; RV.cam.focus = null;
  };
  RV.mm.cv.addEventListener('mousedown', e => { RV.mm.down = true; go(e); });
  RV.mm.cv.addEventListener('mousemove', e => { if (RV.mm.down) go(e); });
  window.addEventListener('mouseup', () => { if (RV.mm) RV.mm.down = false; });
  mm.querySelector('.rl-mm-home').onclick = () => { RV.cam.tx = 0; RV.cam.tz = RV.homeZ == null ? 2 : RV.homeZ; RV.cam.tzoom = 1; RV.cam.focus = null; };
}
function rlSnapMinimap() {
  // один кадр згори ортокамерою → картинка мінімапи (120×120 од.)
  const S = 256, cam = new THREE.OrthographicCamera(-60, 60, 60, -60, 1, 300);
  cam.position.set(0, 150, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0);
  const g = BR3.ZU.uGrid.value; BR3.ZU.uGrid.value = 0;
  const old = { w: RV.R.domElement.width, h: RV.R.domElement.height }, fog = RV.scene.fog; RV.scene.fog = null;
  RV.R.setSize(S, S, false); RV.R.render(RV.scene, cam);
  const c = document.createElement('canvas'); c.width = c.height = S; c.getContext('2d').drawImage(RV.R.domElement, 0, 0, S, S);
  RV.mm.img = c; RV.scene.fog = fog; BR3.ZU.uGrid.value = g;
  rlResize3d();
}
function rlDrawMinimap() {
  const M = RV.mm; if (!M) return;
  const cv = M.cv, size = cv.clientWidth | 0; if (!size) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== size * dpr) { cv.width = cv.height = size * dpr; }
  const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = size, k = W / 120, toX = wx => (wx + 60) * k, toY = wz => (wz + 60) * k;
  x.clearRect(0, 0, W, W);
  if (M.img) x.drawImage(M.img, 0, 0, W, W);
  // сітка
  x.strokeStyle = 'rgba(255,255,255,0.35)'; x.lineWidth = 1;
  for (let i = 0; i <= RL_N; i++) { const p = toX(-50 + i * 10); x.beginPath(); x.moveTo(p, toY(-50)); x.lineTo(p, toY(50)); x.stroke(); x.beginPath(); x.moveTo(toX(-50), p); x.lineTo(toX(50), p); x.stroke(); }
  x.font = '700 9px Manrope, sans-serif'; x.fillStyle = 'rgba(255,255,255,0.85)'; x.textAlign = 'center'; x.textBaseline = 'middle';
  for (let i = 0; i < RL_N; i++) { x.fillText(RL_COLS[i], toX(rlWX(i)), toY(-54.5)); x.fillText(String(i + 1), toX(-55), toY(rlWZ(i))); }
  // зона
  const zc = RV.zc;
  if (zc) { const h = zc.radius * RL_CELL; x.strokeStyle = '#b48cff'; x.lineWidth = 2; x.strokeRect(toX(rlWX(zc.cx) - h), toY(rlWZ(zc.cy) - h), 2 * h * k, 2 * h * k); }
  if (RV.red && RV.redK > 0.05) { const h = RV.red.radius * RL_CELL; x.fillStyle = 'rgba(255,60,40,' + (0.35 * RV.redK) + ')'; x.fillRect(toX(rlWX(RV.red.cx) - h), toY(rlWZ(RV.red.cy) - h), 2 * h * k, 2 * h * k); }
  // гравці
  for (const v of RV.list) {
    if (v.dead) continue;
    x.fillStyle = v.css; x.beginPath(); x.arc(toX(v.x), toY(v.z), v.crown ? 4 : 2.4, 0, 7); x.fill();
  }
  // рамка камери (перетин променів з площиною y=1)
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const r = new THREE.Raycaster(); r.setFromCamera({ x: a, y: b }, RV.camera);
    const o = r.ray.origin, d = r.ray.direction; const t = d.y < -0.01 ? (1 - o.y) / d.y : 400;
    return [toX(o.x + d.x * t), toY(o.z + d.z * t)];
  });
  x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = 1.5; x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.closePath(); x.stroke();
}

// ── наведення миші: клітинка під курсором; тягнути — рух камери ──
const _rlRay = new THREE.Raycaster(), _rlM = new THREE.Vector2();
function rlMouseMove(e) {
  if (!RV.ready || !RV.terrain) return;
  if (RV.drag) {
    const D = RV.drag, dx = e.clientX - D.x, dy = e.clientY - D.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) D.moved = true;
    const k = 0.16 * RV.cam.zoom * (1100 / Math.max(600, RV.w));
    RV.cam.tx = D.cx - dx * k; RV.cam.tz = D.cz - dy * k * 1.25; RV.cam.focus = null;
    return;
  }
  const r = rlDom.stage.getBoundingClientRect();
  _rlM.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _rlRay.setFromCamera(_rlM, RV.camera);
  const hit = _rlRay.intersectObject(RV.terrain, false)[0];
  if (!hit) { rlUnhover(); return; }
  const c = Math.floor((hit.point.x + 50) / RL_CELL), rr = Math.floor((hit.point.z + 50) / RL_CELL);
  if (c < 0 || rr < 0 || c >= RL_N || rr >= RL_N) { rlUnhover(); return; }
  rlHoverCell(c, rr, true);
}
function rlHoverCell(c, r, showTip) {
  if (!rlDom || isNaN(c) || isNaN(r)) return;
  const key = c + ',' + r;
  if (rlHoverKey === key) return;
  rlUnhover();
  rlHoverKey = key;
  BR3.ZU.uHover.value.set(c, r);
  const here = Object.values(rlPlayers).filter(p => p.col === c && p.row === r && !p.removed);
  here.forEach(p => { const row = document.getElementById('rl-row-' + p.num); if (row) row.classList.add('rl-hl'); });
  if (!showTip || !rlDom.tip || !RV.ready) return;
  const alive = here.filter(p => p.alive).sort((a, b) => a.num - b.num);
  const dead = here.filter(p => !p.alive);
  rlDom.tip.innerHTML = rlTipHtml(c, r, alive, dead);
  rlDom.tip.classList.add('rl-show');
  const P = _rlP; RV.labels.project(RV.camera, _rlV.set(rlWX(c) + RL_CELL / 2, rlGround(rlWX(c), rlWZ(r)) + 2, rlWZ(r)), P);
  const sr = rlDom.stage.getBoundingClientRect(), tw = rlDom.tip.offsetWidth, th = rlDom.tip.offsetHeight;
  let left = P.x + 18, flip = false; if (left + tw > sr.width) { left = P.x - tw - 74; flip = true; }
  rlDom.tip.classList.toggle('rt-flip', flip);
  const top = rlClamp(P.y - th / 2, 0, Math.max(0, sr.height - th));
  rlDom.tip.style.setProperty('--rt-ay', Math.round(rlClamp(P.y - top, 18, th - 18)) + 'px');   // стрілка — на клітинку
  rlDom.tip.style.left = Math.round(left) + 'px'; rlDom.tip.style.top = Math.round(top) + 'px';
}
// картка клітинки: тайл-координата зі статусом зони, аватарки Kick, ніки кольорами гравців
function rlPlural(n) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'боец' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'бойца' : 'бойцов'; }
function rlTipAv(nick) {
  const l = String(nick).replace(/[^A-Za-zА-Яа-яІіЇїЄєҐґ0-9]/g, '').slice(0, 1).toUpperCase() || '?';
  return '<span class="rt-av" style="--pc:' + BR3.cssOf(nick) + '"><em>' + rlEsc(l) + '</em><img alt="" loading="lazy" src="/api/avatar/' + encodeURIComponent(nick) + '" onload="if(this.naturalWidth)this.classList.add(\'ok\')" onerror="this.remove()"></span>';
}
function rlTipHtml(c, r, alive, dead) {
  const red = RV.red && RV.redK > 0.05 && Math.abs(c - RV.red.cx) <= RV.red.radius - 0.5 + 1e-6 && Math.abs(r - RV.red.cy) <= RV.red.radius - 0.5 + 1e-6;
  const st = red ? 'red' : (rlZone && !rlInZone(c, r)) ? 'storm' : 'safe';
  const stTxt = red ? 'Красная зона' : st === 'storm' ? 'За зоной' : rlZone ? 'В зоне' : 'Безопасно';
  let h = '<div class="rt-top rt-' + st + '">' +
    '<div class="rt-cell"><b>' + rlEsc(RL_COLS[c]) + '</b><span>' + (r + 1) + '</span></div>' +
    '<div class="rt-meta"><div class="rt-st"><i></i>' + stTxt + '</div>' +
    '<div class="rt-cnt">' + (alive.length ? '<b>' + alive.length + '</b> ' + rlPlural(alive.length) : 'никого нет') + (dead.length ? '<s>✕ ' + dead.length + '</s>' : '') + '</div></div></div>';
  if (!alive.length && !dead.length) return h;
  if (alive.length) {
    const AV = 6;
    h += '<div class="rt-avs">' + alive.slice(0, AV).map(p => rlTipAv(p.nick)).join('') + (alive.length > AV ? '<span class="rt-av rt-more">+' + (alive.length - AV) + '</span>' : '') + '</div>';
  }
  const MAX = 8, list = alive.slice(0, MAX).map(p => ({ p, d: 0 })).concat(dead.slice(0, Math.max(0, MAX - alive.length)).map(p => ({ p, d: 1 })));
  h += '<div class="rt-list">' + list.map(({ p, d }) => '<div class="rt-n' + (d ? ' rt-dead' : '') + '" style="--pc:' + BR3.cssOf(p.nick) + '"><i></i><span>' + rlEsc(p.nick) + '</span><em>#' + p.num + '</em></div>').join('') + '</div>';
  const rest = alive.length + dead.length - list.length;
  if (rest > 0) h += '<div class="rt-rest">и ещё ' + rest + '</div>';
  return h;
}
function rlUnhover() {
  if (!rlDom || !rlHoverKey) return;
  rlHoverKey = null;
  if (window.BR3) BR3.ZU.uHover.value.set(-9, -9);
  if (rlDom.tip) rlDom.tip.classList.remove('rl-show');
  rlDom.root.querySelectorAll('.rl-row.rl-hl').forEach(el => el.classList.remove('rl-hl'));
}

// ── Стан гри ─────────────────────────────────────────────────
function rlResetState() {
  rlPlayers = {}; rlZone = null; rlJoinLocked = false; rlPhase = 'playing';
  rlPendingFight = null; rlWinner = null; rlNextNum = 1; rlDeathSeq = 0;
  rlRecent.clear(); rlClearRed();
  if (RV.ready) { [...RV.list].forEach(v => rlVisRemove(v)); RV.vis.clear(); RV.fx.clear(); RV.cam.focus = null; RV.zoneAnim = null; RV.planeAt = -99; RV.cam.tx = 0; RV.cam.tz = RV.homeZ == null ? 2 : RV.homeZ; RV.cam.tzoom = 1; }
}
function rlAddPlayer(nick, col, row) {
  const p = { nick, num: rlNextNum++, col, row, alive: true, dying: false, removed: false, died: 0 };
  rlPlayers[nick] = p;
  rlRecent.set(nick, performance.now());
  return p;
}
function rlKill(p) { p.alive = false; p.dying = true; p.died = ++rlDeathSeq; }
function rlPurgeDying() { Object.values(rlPlayers).forEach(p => { if (p.dying) { p.dying = false; p.removed = true; } }); }

// ── Збереження / відновлення ──────────────────────────────────
function roySaveState(force) {
  if (!rlPlayers || !Object.keys(rlPlayers).length) return;
  const now = Date.now();
  if (!force && now - rlSaveT < 700) return;
  rlSaveT = now;
  try {
    localStorage.setItem(RL_SAVE_KEY, JSON.stringify({
      v: 3, players: rlPlayers, zone: rlZone, joinLocked: rlJoinLocked,
      phase: rlPhase === 'finished' ? 'finished' : 'playing',
      pendingFight: rlPendingFight, winner: rlWinner, nextNum: rlNextNum, deathSeq: rlDeathSeq, savedAt: now,
    }));
  } catch (e) {}
}
function royLoadState() {
  try {
    const raw = localStorage.getItem(RL_SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !d.players || !Object.keys(d.players).length) return false;
    rlPlayers = {};
    let maxNum = 0, maxDied = 0;
    Object.keys(d.players).forEach(nick => {
      const s = d.players[nick] || {};
      const col = rlClamp(parseInt(s.col, 10) || 0, 0, RL_N - 1), row = rlClamp(parseInt(s.row, 10) || 0, 0, RL_N - 1);
      const p = { nick, num: parseInt(s.num, 10) || 0, col, row, alive: !!s.alive, dying: !!s.dying, removed: !!s.removed, died: parseInt(s.died, 10) || 0 };
      rlPlayers[nick] = p;
      if (p.num > maxNum) maxNum = p.num;
      if (p.died > maxDied) maxDied = p.died;
    });
    Object.values(rlPlayers).forEach(p => { if (!p.num) p.num = ++maxNum; });
    rlNextNum = Math.max(maxNum + 1, parseInt(d.nextNum, 10) || 1);
    rlDeathSeq = Math.max(maxDied, parseInt(d.deathSeq, 10) || 0);
    rlZone = null;
    if (d.zone && isFinite(d.zone.radius)) {
      const n = rlClamp(Math.round(+d.zone.radius * 2), 1, RL_N), x0 = rlClamp(Math.round(+d.zone.cx - (n - 1) / 2), 0, RL_N - n), y0 = rlClamp(Math.round(+d.zone.cy - (n - 1) / 2), 0, RL_N - n);
      rlZone = rlSquare(x0, y0, n); rlZone.stage = parseInt(d.zone.stage, 10) || 1;
    }
    rlJoinLocked = !!d.joinLocked;
    rlPhase = d.phase === 'finished' ? 'finished' : 'playing';
    rlPendingFight = Array.isArray(d.pendingFight) && d.pendingFight.length ? d.pendingFight : null;
    rlWinner = (d.winner && rlPlayers[d.winner]) ? d.winner : null;
    if (rlPhase === 'finished' && !rlWinner && rlAlive().length === 1) rlWinner = rlAlive()[0].nick;
    return true;
  } catch (e) { return false; }
}

// ── Контракт: відкрити / закрити ─────────────────────────────
function startRoyale() {
  if (!rlEnsureDom()) return;
  rlClearRed();
  const resumed = royLoadState();
  if (!resumed) rlResetState();
  if (typeof phase !== 'undefined') phase = 'racing';
  rlDom.root.classList.add('visible');
  rlDom.stage.classList.add('rl-loading');
  rl3dInit().then(ok => {
    rlDom.stage.classList.remove('rl-loading');
    if (!ok) { rlStatus('Не удалось загрузить остров — обнови страницу'); return; }
    rlResize3d(); royRender(); rlKick();
  });
  royRender();
  if (resumed && rlPhase === 'finished') rlStatus(rlWinner ? 'Игра завершена · победитель: ' + rlWinner + ' · «Новая» — начать заново' : 'Игра завершена · «Новая» — начать заново');
  else if (resumed) rlStatus('Игра восстановлена · в игре: ' + rlAlive().length + (rlJoinLocked ? ' · вход закрыт' : '') + (rlPendingFight ? ' · финал готов' : ''));
  else rlStatus('Зрители пишут координату в чат (A1, G4…) — и десантируются в эту клетку');
}
function closeRoyaleOverlay() {
  if (rlPhase !== 'idle') roySaveState(true);
  if (window.RSO && typeof window.RSO.stop === 'function') { try { window.RSO.stop(); } catch (e) {} }
  rlClearRed();
  rlPhase = 'idle';
  rlUnhover();
  const root = document.getElementById('royale-overlay');
  if (root) root.classList.remove('visible');
  if (typeof phase !== 'undefined' && phase === 'racing') phase = 'idle';
}
function royNewGame() {
  if (!rlEnsureDom()) return;
  if (Object.keys(rlPlayers).length && !confirm('Начать новую игру? Текущая будет удалена.')) return;
  try { localStorage.removeItem(RL_SAVE_KEY); } catch (e) {}
  if (window.RSO && typeof window.RSO.stop === 'function') { try { window.RSO.stop(); } catch (e) {} }
  rlResetState();
  royRender();
  rlStatus('Зрители пишут координату в чат (A1, G4…) — и десантируются в эту клетку');
}

// ── Контракт: повідомлення з чату ────────────────────────────
function royHandleMessage(nick, text) {
  if (rlPhase !== 'playing') return;
  const coord = rlParseCoord(text);
  if (!coord) return;
  nick = String(nick || '').trim();
  if (!nick || nick.length > 60) return;
  const existing = rlPlayers[nick];
  if (existing && !existing.alive) return;
  if (!existing && rlJoinLocked) return;
  if (!existing && rlFull()) return;       // місць немає — хто не встиг, той не встиг
  if (existing) {
    if (existing.col === coord.col && existing.row === coord.row) return;
    existing.col = coord.col; existing.row = coord.row;
    rlRecent.set(nick, performance.now());
  } else {
    rlAddPlayer(nick, coord.col, coord.row);
    if (rlFull()) rlStatus('Все ' + RL_MAX_PLAYERS + ' мест заняты — вход закрыт');
  }
  rlScheduleRender();
}
function rlFull() { return Object.keys(rlPlayers).length >= RL_MAX_PLAYERS; }
function rlScheduleRender() {
  if (rlRenderRAF) return;
  rlRenderRAF = requestAnimationFrame(() => { rlRenderRAF = 0; royRender(); });
}

// ── Контракт: рендер ─────────────────────────────────────────
function royRender() {
  if (!rlEnsureDom()) return;
  rlSync3d(false);
  rlRenderBanner();
  rlRenderLists();
  rlRenderHud();
  rlSyncControls();
  roySaveState(false);
}
function rlRenderBanner() {
  if (!rlDom.banner) return;
  const on = false;   // плашку «Последний выживший» прибрано: переможця видно по короні й наїзду камери, у фіналі — картка чемпіона
  rlDom.banner.classList.toggle('rl-show', on);
  if (on && rlDom.bannerNick) rlDom.bannerNick.textContent = rlWinner;
}
function rlRenderLists() {
  const all = Object.values(rlPlayers);
  const alive = all.filter(p => p.alive).sort((a, b) => a.num - b.num);
  const dead = all.filter(p => !p.alive).sort((a, b) => b.died - a.died);
  const row = (p, cls) => '<div class="rl-row' + cls + '" id="rl-row-' + p.num + '" data-c="' + p.col + '" data-r="' + p.row + '" title="' + rlEsc(p.nick) + '">' +
    '<span class="rl-num" style="--pc:' + (window.BR3 ? BR3.cssOf(p.nick) : 'var(--accent)') + '">' + p.num + '</span><span class="rl-nick">' + rlEsc(p.nick) + '</span><span class="rl-pos">' + rlCoordName(p.col, p.row) + '</span></div>';
  rlDom.aliveList.innerHTML = alive.length
    ? alive.map(p => row(p, p.nick === rlWinner ? ' rl-win' : '')).join('')
    : '<div class="rl-empty">Пока никого.<br>Пиши координату в чат: A1 … J10</div>';
  rlDom.deadList.innerHTML = dead.length ? dead.map(p => row(p, ' rl-out')).join('') : '<div class="rl-empty">Все живы</div>';
  rlDom.aliveCnt.textContent = alive.length; rlDom.deadCnt.textContent = dead.length;
  rlDom.alive.textContent = alive.length;
}
function rlRenderHud() {
  const n = Object.keys(rlPlayers).length, shut = rlJoinLocked || n >= RL_MAX_PLAYERS;
  // кільце «живих»: частка живих від усіх, хто зайшов; кільце місць: n/100; мінісітка — де зараз зона
  const C = 2 * Math.PI * 18, aliveN = rlAlive().length;
  if (rlDom.dAlive) rlDom.dAlive.textContent = aliveN;
  if (rlDom.dRing) rlDom.dRing.style.strokeDashoffset = (C * (1 - (n ? aliveN / n : 0))).toFixed(1);
  if (rlDom.dSeat) rlDom.dSeat.textContent = n;
  if (rlDom.dSRing) rlDom.dSRing.style.strokeDashoffset = (C * (1 - n / RL_MAX_PLAYERS)).toFixed(1);
  if (rlDom.dSeatK) { rlDom.dSeatK.textContent = shut ? 'закрыто' : 'из ' + RL_MAX_PLAYERS; rlDom.dSeatK.parentNode.classList.toggle('rl-shut', shut); }
  if (rlDom.dZone) rlDom.dZone.textContent = rlPhase === 'finished' ? 'финиш' : !rlZone ? 'весь остров' : 'зона ' + rlZoneN(rlZone) + '×' + rlZoneN(rlZone);
  if (rlDom.dZmap) {
    const x = rlDom.dZmap.getContext('2d'), W = 88, c = W / 10;
    x.clearRect(0, 0, W, W);
    x.fillStyle = 'rgba(120, 80, 200, 0.35)'; x.fillRect(0, 0, W, W);
    const z = rlZone || (rlPhase !== 'finished' ? rlInitialZone() : null);
    if (z) { const N = rlZoneN(z), x0 = Math.round(z.cx - (N - 1) / 2), y0 = Math.round(z.cy - (N - 1) / 2); x.fillStyle = '#7ddc5a'; x.fillRect(x0 * c, y0 * c, N * c, N * c); }
    x.strokeStyle = 'rgba(255,255,255,0.22)'; x.lineWidth = 1;
    for (let i = 1; i < 10; i++) { x.beginPath(); x.moveTo(i * c, 0); x.lineTo(i * c, W); x.stroke(); x.beginPath(); x.moveTo(0, i * c); x.lineTo(W, i * c); x.stroke(); }
  }
  const zc = rlDom.zoneChip, lc = rlDom.lockChip;
  if (zc) {
    if (rlPhase === 'finished') zc.innerHTML = 'ЗОНА <b>ФИНИШ</b>';
    else if (!rlZone) zc.innerHTML = 'ЗОНА <b>ОЖИДАНИЕ</b>';
    else zc.innerHTML = 'ЗОНА <b>ФАЗА ' + rlZone.stage + '</b>';
    zc.classList.toggle('rl-final', !!rlPendingFight && rlPhase === 'playing');
  }
  if (lc) {
    const n = Object.keys(rlPlayers).length, shut = rlJoinLocked || n >= RL_MAX_PLAYERS;
    lc.className = 'rl-chip ' + (shut ? 'rl-lock-closed' : 'rl-lock-open');
    lc.innerHTML = shut ? '<b>ВХОД ЗАКРЫТ</b> ' + n + '/' + RL_MAX_PLAYERS : 'МЕСТА <b>' + n + '/' + RL_MAX_PLAYERS + '</b>';
  }
}
function rlFinalAvailable() {
  if (rlPhase !== 'playing' || rlRedBusy) return 0;
  if (rlPendingFight) return rlPendingFight.filter(f => rlPlayers[f.nick] && rlPlayers[f.nick].alive).length;
  return 0;
}
function rlSyncControls() {
  const playing = rlPhase === 'playing' && !rlRedBusy;
  const aliveN = rlAlive().length;
  if (rlDom.zoneBtn) {
    rlDom.zoneBtn.disabled = !playing || aliveN < 1 || rlZoneBusy || !!rlPendingFight;
    rlCooldown(rlDom.zoneBtn, rlZoneBusy, RL_ZONE_MS);
  }
  if (rlDom.redBtn) {
    rlDom.redBtn.disabled = !playing || aliveN <= 1 || rlZoneBusy || rlRedBusy;
    rlCooldown(rlDom.redBtn, rlRedBusy, 5600);
  }
  if (rlDom.fightBtn) {
    const n = rlFinalAvailable();
    rlDom.fightBtn.classList.toggle('rl-on', n >= 2);
    rlDom.fightBtn.disabled = n < 2;
    if (rlDom.fightN) rlDom.fightN.textContent = n >= 2 ? n : '';
  }
  if (rlDom.testPartBtn) {
    const parts = (typeof state !== 'undefined' && state && Array.isArray(state.participants)) ? state.participants.length : 0;
    rlDom.testPartBtn.innerHTML = '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/></svg>Из участников (' + parts + ')';
    rlDom.testPartBtn.disabled = !parts;
  }
}

// «перезарядка» слота: поки дія триває, по слоту біжить сектор (CSS, тривалість — --cd)
function rlCooldown(btn, busy, ms) {
  if (busy && !btn.classList.contains('rl-cd')) { btn.style.setProperty('--cd', ms + 'ms'); btn.classList.add('rl-cd'); }
  if (!busy) btn.classList.remove('rl-cd');
}

// ── Зона ─────────────────────────────────────────────────────
// квадрат n×n клітинок: 10 → 7 → 5 → 3 → 2 → 1 (остання клітинка — фінал)
const RL_NEXT_N = { 10: 7, 7: 5, 5: 3, 3: 2, 2: 1 };
function rlSquare(x0, y0, n) { return { cx: x0 + (n - 1) / 2, cy: y0 + (n - 1) / 2, radius: n / 2, stage: 0, next: null }; }
function rlZoneN(z) { return Math.round(z.radius * 2); }
function rlNextRadius(r) { return Math.max(RL_MIN_RADIUS, r * RL_SHRINK_K - RL_SHRINK_B); }
function rlShiftedCenter(z, newR) {
  const maxShift = Math.max(0, z.radius - newR);
  return {
    cx: rlClamp(z.cx + (rlFloat() * 2 - 1) * maxShift * 0.6, 0, RL_N - 1),
    cy: rlClamp(z.cy + (rlFloat() * 2 - 1) * maxShift * 0.6, 0, RL_N - 1),
  };
}
function rlInitialZone() { return rlSquare(0, 0, RL_N); }
function rlAnimateZone(from, to, ms, done) {
  if (!RV.ready) { done && done(); return; }
  RV.zoneAnim = { a: { cx: from.cx, cy: from.cy, radius: from.radius }, b: { cx: to.cx, cy: to.cy, radius: to.radius }, t0: performance.now(), ms, done };
  BR3.snd('br-zone', 0.7);
  rlKick();
}
// блискавка зі стіни зони в кожного, хто лишився зовні
function rlFxZoneKills(players) {
  if (!RV.ready) return;
  const z = rlZone, X = rlWX(z.cx), Zz = rlWZ(z.cy), R = z.radius * RL_CELL;
  players.forEach((p, i) => {
    const v = RV.vis.get(p.nick); if (!v || v.dead) return;
    const delay = Math.min(i * 55, 1400);
    setTimeout(() => {
      if (v.dead) return;
      const dx = v.x - X, dz = v.z - Zz, d = Math.hypot(dx, dz) || 1;
      const m = Math.max(Math.abs(dx), Math.abs(dz)) || 1, ex = X + dx / m * R, ez = Zz + dz / m * R;   // точка на квадратній стіні
      const from = new THREE.Vector3(ex, rlStand(ex, ez) + 16, ez), to = new THREE.Vector3(v.x, v.y + 2.5, v.z);
      if (i < 70) RV.fx.zap(from, to);
      rlVisDie(v, { kind: 'zap', from: new THREE.Vector3(ex, 0, ez) });
      if (i < 8) BR3.snd('br-zap', 0.55, 0.9 + Math.random() * 0.3, 70);
      if (i === 0) BR3.snd('br-death', 0.6, 1, 200);
    }, delay);
  });
}

function royaleShrinkZone() {
  if (rlPhase !== 'playing' || rlRedBusy || rlPendingFight || rlZoneBusy) return;
  const alive = rlAlive();
  if (alive.length <= 1) { rlCheckWinner(); return; }
  const firstLock = !rlJoinLocked;
  rlJoinLocked = true;
  rlPurgeDying();
  const cur = rlZone || rlInitialZone();
  let nz;
  {
    const n = rlZoneN(cur), n2 = RL_NEXT_N[n] || Math.max(1, n - 1);
    const x0 = Math.round(cur.cx - (n - 1) / 2), y0 = Math.round(cur.cy - (n - 1) / 2);
    if (n2 <= 1) {
      // остання клітинка — будь-яка клітинка поточної зони навмання (не «де найбільше людей»)
      nz = rlSquare(x0 + secureRandomInt(n), y0 + secureRandomInt(n), 1);
    } else {
      // непередбачувана зона: новий квадрат може «з'їхати» за межі старого на 1–2 клітинки,
      // тож центр попередньої зони більше не гарантовано безпечний (сидіти в центрі — теж ризик)
      const drift = n2 >= 5 ? 2 : 1, rng = (lo, hi) => lo + secureRandomInt(hi - lo + 1);
      const nx = rng(Math.max(0, x0 - drift), Math.min(RL_N - n2, x0 + n - n2 + drift));
      const ny = rng(Math.max(0, y0 - drift), Math.min(RL_N - n2, y0 + n - n2 + drift));
      nz = rlSquare(nx, ny, n2);
    }
  }
  const from = cur.stage === 0 ? Object.assign({}, cur, { radius: RL_N / 2 + 0.6 }) : cur;
  rlZone = { cx: nz.cx, cy: nz.cy, radius: nz.radius, stage: (cur.stage || 0) + 1, next: null };
  const outside = alive.filter(p => !rlInZone(p.col, p.row));
  const inside = alive.filter(p => rlInZone(p.col, p.row));
  rlZoneBusy = true; royRender();
  rlStatus('Зона сжимается…');
  rlAnimateZone(from, rlZone, RL_ZONE_MS, () => {
    rlZoneBusy = false;
    if (inside.length === 0 && outside.length >= 2) {
      const withDist = outside.map(p => ({ p, d: rlZoneDist(p.col, p.row, rlZone) }));
      const maxD = Math.max(0.01, ...withDist.map(w => w.d));
      const finalists = withDist.map(w => ({ nick: w.p.nick, col: w.p.col, row: w.p.row, startHP: Math.round(45 + (1 - w.d / maxD) * 55) }));
      royRender();
      rlPrepareFight(finalists, 'Все за зоной! Кто ближе — больше HP · Финал: ' + finalists.length);
      return;
    }
    if (inside.length === 0 && outside.length === 1) { royRender(); rlCheckWinner(); return; }
    outside.forEach(p => rlKill(p));
    rlFxZoneKills(outside);
    royRender();
    if (rlZoneN(rlZone) <= 1 && inside.length >= 2) {
      rlPrepareFight(inside.map(p => ({ nick: p.nick, col: p.col, row: p.row, startHP: 100 })),
        'Финальная клетка ' + rlCoordName(Math.round(rlZone.cx), Math.round(rlZone.cy)) + '! Перестрелка: ' + inside.length);
      return;
    }
    rlStatus((firstLock ? 'Вход закрыт! ' : '') + 'Зона ' + rlZone.stage + ': выбыло ' + outside.length + ', осталось ' + inside.length + (inside.length > 1 ? ' · Можно сменить клетку!' : ''));
    rlCheckWinner();
  });
}

// ── Червона зона: сирена → ракетний удар ──────────────────────
function rlClearRed() {
  rlRedTimers.forEach(t => clearTimeout(t)); rlRedTimers = [];
  rlRedBusy = false;
  RV.red = null; RV.redTarget = 0;
}
function rlRedLater(fn, ms) { const t = setTimeout(fn, ms); rlRedTimers.push(t); return t; }
function royaleRedZone() {
  if (rlPhase !== 'playing' || rlRedBusy || rlZoneBusy) return;
  if (rlAlive().length <= 1) return;
  rlJoinLocked = true;
  rlPurgeDying();
  const side = rlFloat() < 0.5 ? 2 : 3;
  const sq = rlSquare(Math.floor(rlFloat() * (RL_N - side + 1)), Math.floor(rlFloat() * (RL_N - side + 1)), side);
  const cx = sq.cx, cy = sq.cy, radius = side / 2;
  const cells = [];
  for (let r = 0; r < RL_N; r++) for (let c = 0; c < RL_N; c++) if (rlInZone(c, r, sq)) cells.push([c, r]);
  const inRed = p => cells.some(([c, r]) => c === p.col && r === p.row);
  rlRedBusy = true;
  RV.red = { cx, cy, radius }; RV.redTarget = 1;
  royRender();
  rlStatus('КРАСНАЯ ЗОНА! Успей сменить клетку');
  BR3.snd('br-siren', 0.6);
  rlRedLater(() => {
    // позиції — в момент пуску ракет: хто встиг перебігти, той урятувався
    const alive = rlAlive();
    const hit = alive.filter(inRed), survivors = alive.filter(p => !inRed(p));
    const impacts = [];
    const N = 9 + Math.round(radius * 3);
    BR3.snd('br-whistle', 0.55);
    for (let k = 0; k < N; k++) {
      const a = 0, d = 0;
      // частина ракет — точно в бійців у зоні (щоб удар виглядав влучним)
      let x = rlWX(cx) + (rlFloat() - 0.5) * 2 * radius * RL_CELL * 0.9 + a, z = rlWZ(cy) + (rlFloat() - 0.5) * 2 * radius * RL_CELL * 0.9 + d;
      const tgt = hit[k] && RV.vis.get(hit[k].nick);
      if (tgt && k < N - 3) { x = tgt.x + (Math.random() - 0.5) * 3; z = tgt.z + (Math.random() - 0.5) * 3; }
      rlLaunchMissile(x, z, 0.75 + k * 0.11, at => impacts.push(at));
    }
    rlRedLater(() => {
      RV.redTarget = 0;
      rlRedBusy = false;
      if (survivors.length === 0 && hit.length >= 2) {
        royRender();
        rlPrepareFight(hit.map(p => ({ nick: p.nick, col: p.col, row: p.row, startHP: 100 })), 'Все в красной зоне! Финал: ' + hit.length);
        return;
      }
      hit.forEach(p => rlKill(p));
      hit.forEach(p => {
        const v = RV.vis.get(p.nick); if (!v) return;
        let best = impacts[0], bd = 1e9; for (const at of impacts) { const d = Math.hypot(at.x - v.x, at.z - v.z); if (d < bd) { bd = d; best = at; } }
        rlVisDie(v, { kind: 'boom', from: best || new THREE.Vector3(v.x + 1, 0, v.z) });
      });
      if (hit.length) BR3.snd('br-death', 0.6, 1, 200);
      royRender();
      rlStatus(hit.length ? 'Ракетный удар! Выбыло: ' + hit.length + '. Осталось: ' + survivors.length : 'Ракетный удар — промах, все целы');
      rlCheckWinner();
      rlRedLater(() => { if (!rlRedBusy) RV.red = null; }, 900);
    }, 0.75 * 1000 + N * 110 + 950);
  }, 2600);
}
function rlLaunchMissile(x, z, dur, onHit) {
  if (!RV.ready) { onHit && onHit(new THREE.Vector3(x, 0, z)); return; }
  const m = new THREE.Mesh(RV.missileGeo, RV.missileMat); m.scale.setScalar(2.2); m.rotation.x = Math.PI; m.castShadow = true;
  const gy = rlStand(x, z);
  RV.scene.add(m);
  RV.missiles.push({ mesh: m, x, z, gy, dx: (Math.random() - 0.5) * 30, dz: -20 - Math.random() * 10, t: -Math.random() * 0.15, dur, onHit });
}

// ── Фінал / переможець ───────────────────────────────────────
function rlCheckWinner() {
  let alive = rlAlive();
  if (typeof isBlacklisted === 'function' && alive.length <= 1 && alive.length && isBlacklisted(alive[0].nick)) { rlKill(alive[0]); alive = []; }
  // кілька живих — гра триває, навіть якщо всі в одній клітинці: фінал лише на останній клітинці зони (або коли всі за зоною)
  if (alive.length > 1) return;
  if (alive.length === 0) {
    rlPhase = 'finished'; rlPendingFight = null;
    royRender(); rlStatus('Все выбыли! «Новая» — начать заново');
    roySaveState(true);
    return;
  }
  royDeclareWinner(alive[0]);
}
function rlPrepareFight(finalists, msg) {
  rlPendingFight = finalists;
  rlStatus(msg);
  rlRenderHud(); rlSyncControls();
  roySaveState(true);
}
function royLaunchFight() {
  if (rlPhase !== 'playing' || rlRedBusy) return;
  let finalists;
  if (rlPendingFight) {
    finalists = rlPendingFight.map(f => { const p = rlPlayers[f.nick]; return p && p.alive ? { nick: p.nick, col: p.col, row: p.row, startHP: f.startHP || 100 } : null; }).filter(Boolean);
  } else return;
  if (typeof isBlacklisted === 'function') {
    const clean = finalists.filter(f => !isBlacklisted(f.nick));
    if (clean.length && clean.length < finalists.length) {
      finalists.forEach(f => { if (isBlacklisted(f.nick) && rlPlayers[f.nick]) rlKill(rlPlayers[f.nick]); });
      finalists = clean; royRender();
    }
  }
  if (finalists.length < 2) { rlPendingFight = null; rlSyncControls(); rlCheckWinner(); return; }
  if (!window.RSO || typeof window.RSO.start !== 'function') { rlStatus('Модуль финала не загружен'); return; }
  rlPendingFight = finalists;
  rlPhase = 'shootout';
  rlSyncControls();
  roySaveState(true);
  rlStatus('ФИНАЛ: ' + finalists.length + ' бойцов');
  try {
    // фінал — прямо на острові: у центрі останньої зони, бійці стартують там, де стоять у лобі
    const z = rlZone || rlInitialZone(), pos = {};
    finalists.forEach(f => { const v = RV.vis.get(f.nick); if (v) pos[f.nick] = { x: v.x, z: v.z }; });
    window.RSO.start(finalists, { onWinner: (f) => royDeclareWinner(f), center: { x: rlWX(z.cx), z: rlWZ(z.cy) }, pos });
  } catch (e) {
    rlPhase = 'playing'; rlSyncControls();
    rlStatus('Ошибка запуска финала: ' + (e && e.message ? e.message : e));
  }
}
function royDeclareWinner(f) {
  if (!f || !f.nick) { rlPhase = 'playing'; royRender(); rlStatus('Ничья — финал можно запустить ещё раз'); return; }
  let p = rlPlayers[f.nick];
  if (!p) p = rlAddPlayer(f.nick, rlClamp(parseInt(f.col, 10) || 0, 0, RL_N - 1), rlClamp(parseInt(f.row, 10) || 0, 0, RL_N - 1));
  Object.values(rlPlayers).forEach(q => { if (q !== p && q.alive) { q.alive = false; q.dying = false; q.removed = true; q.died = ++rlDeathSeq; } });
  p.alive = true; p.dying = false; p.removed = false;
  rlWinner = p.nick; rlPhase = 'finished'; rlPendingFight = null;
  royRender();
  rlStatus('ПОБЕДИТЕЛЬ: ' + p.nick);
  BR3.snd('br-win', 0.8);
  if (typeof addWinner === 'function') addWinner(p.nick);
  roySaveState(true);
}

// ── Тестова панель (олівець) ─────────────────────────────────
function royToggleTestForm() {
  if (!rlEnsureDom() || !rlDom.testForm) return;
  rlDom.testForm.classList.toggle('rl-open');
  rlSyncControls();
}
function rlTestMsg(s) { if (rlDom && rlDom.testMsg) rlDom.testMsg.textContent = s; }
function rlAddNicks(nicks) {
  let added = 0;
  for (const raw of nicks) {
    const nick = String(raw || '').trim();
    if (!nick || nick.length > 60 || rlPlayers[nick]) continue;
    if (rlJoinLocked || rlFull()) break;
    rlAddPlayer(nick, secureRandomInt(RL_N), secureRandomInt(RL_N));
    added++;
  }
  if (added) royRender();
  return added;
}
function royTestLoadFile(ev) {
  const file = ev && ev.target && ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = String(e.target.result || '');
    const nicks = text.split(/[\r\n]+/).map(line => line.split(/[,;\t]/)[0].trim()).filter(Boolean);
    if (nicks.length && /^(nick|name|никнейм|ник|имя|user|username)$/i.test(nicks[0])) nicks.shift();
    const added = rlAddNicks(nicks);
    rlTestMsg('Из файла: +' + added);
    rlStatus('Из файла загружено: ' + added);
  };
  reader.readAsText(file);
  ev.target.value = '';
}
function royTestAddList() {
  if (!rlEnsureDom() || !rlDom.testArea) return;
  const nicks = rlDom.testArea.value.split(/[\r\n,;\t]+/).map(s => s.trim()).filter(Boolean);
  if (!nicks.length) { rlTestMsg('Список пуст'); return; }
  const added = rlAddNicks(nicks);
  rlDom.testArea.value = '';
  rlTestMsg('Добавлено: ' + added);
}
function royTestFromParticipants() {
  const list = (typeof state !== 'undefined' && state && Array.isArray(state.participants)) ? state.participants : [];
  if (!list.length) { rlTestMsg('Участников нет'); return; }
  const added = rlAddNicks(list.map(x => (x && typeof x === 'object') ? (x.nick || x.name || x.username || '') : x));
  rlTestMsg('Из участников: +' + added);
}
