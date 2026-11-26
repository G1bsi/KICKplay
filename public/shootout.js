/* ══════════════════════════════════════════════════════════════
   shootout.js — ФІНАЛ Батл Рояля: перестрілка прямо на острові лобі, у місці, де закінчилась зона.
   Та сама сцена й рендерер, що й у лобі (RV): лобійних бійців ховаємо, фіналісти стартують там, де стояли.
   Укриття — будинки, контейнери, скелі, стовбури дерев острова (колайдери з island2.json + межі моделей),
   плюс розкидані ящики (розлітаються на дошки) й вибухові бочки. Вода й круті схили — непрохідні.
   Відлік → бій: черги, гранати, ragdoll, кругла зона, що стискається. Останнє вбивство — сповільнене,
   далі заставка чемпіона. Після «Готово» лобі повертається як було, переможець стоїть там, де виграв.
   Контракт: window.RSO = { start(finalists, {onWinner, center:{x,z}, pos:{nick:{x,z}}}), stop(), focusNext(dir), toggleOverview(), toggleFly() }
   finalists: [{nick, col, row, startHP}]. Переможця визначає сама симуляція (крипто-сід).
   ══════════════════════════════════════════════════════════════ */
function rsoFocusNext(dir) { if (window.RSO) window.RSO.focusNext(dir); }
function rsoToggleOverview() { if (window.RSO) window.RSO.toggleOverview(); }
function rsoToggleFly() { if (window.RSO && window.RSO.toggleFly) window.RSO.toggleFly(); }

(function () {
'use strict';
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
let _rs = 1;
function seedRng() { try { _rs = ((typeof secureRandomInt === 'function' ? secureRandomInt(0x7fffffff) : Math.random() * 0x7fffffff) | 1) >>> 0; } catch (e) { _rs = (Math.random() * 1e9) | 1; } }
function rnd() { _rs = (_rs + 0x6D2B79F5) | 0; let t = Math.imul(_rs ^ (_rs >>> 15), 1 | _rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function esc(s) { return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
const V3 = () => new THREE.Vector3();

let W = null;      // світ (рендерер, сцена, арена) — створюється один раз
let G = null;      // поточний бій
let raf = 0, lastT = 0;

// ── DOM: HUD фіналу (MOBA): рядок портретів зверху, анонси подій, картка бійця, панель камери, кілфід ──
function ensureDom() {
  const root = document.getElementById('royale-shootout');
  if (!root || root._br2) return root;
  root._br2 = true;
  root.innerHTML =
    '<canvas id="so-canvas"></canvas>' +
    '<div class="sf-top">' +
      '<div class="sf-roster sf-roster-l" id="sf-roster-l"></div>' +
      '<div class="sf-core">' +
        '<div class="sf-core-alive"><b id="so-alive">0</b><span>в живых</span></div>' +
        '<div class="sf-core-zone"><svg viewBox="0 0 44 44" aria-hidden="true"><circle class="sf-zr-bg" cx="22" cy="22" r="18"/><circle class="sf-zr-fg" id="sf-zone-ring" cx="22" cy="22" r="18"/></svg>' +
          '<b id="so-zone-timer">—</b></div>' +
        '<div class="sf-core-k" id="so-zone-lbl">зона</div>' +
      '</div>' +
      '<div class="sf-roster sf-roster-r" id="sf-roster-r"></div>' +
    '</div>' +
    '<div class="sf-feed" id="so-killfeed"></div>' +
    '<div class="sf-announce" id="sf-announce"><div class="sf-ann-k" id="sf-ann-k"></div><div class="sf-ann-n" id="sf-ann-n"></div></div>' +
    '<div class="sf-hero" id="so-focus">' +
      '<div class="sf-hero-av" id="sf-hero-av"></div>' +
      '<div class="sf-hero-main">' +
        '<div class="sf-hero-nick" id="sf-hero-nick"></div>' +
        '<div class="sf-hero-hp"><i id="sf-hero-hp"></i><em id="sf-hero-hpg"></em><span id="sf-hero-hptxt"></span></div>' +
        '<div class="sf-hero-st"><span><b id="sf-hero-k">0</b> киллов</span><span><b id="sf-hero-d">0</b> урона</span></div>' +
      '</div>' +
    '</div>' +
    '<div class="sf-dock">' +
      '<button class="sf-b" type="button" onclick="rsoFocusNext(-1)" title="Предыдущий боец">PREV</button>' +
      '<div class="sf-cam"><span>камера</span><b id="so-cam-name">авто</b></div>' +
      '<button class="sf-b" type="button" onclick="rsoFocusNext(1)" title="Следующий боец">NEXT</button>' +
      '<i class="sf-sep"></i>' +
      '<button class="sf-b sf-bl" id="so-auto-btn" type="button" onclick="rsoToggleFly()" title="Автокамера">AUTO<span>Авто</span></button>' +
      '<button class="sf-b sf-bl" id="so-overview-btn" type="button" onclick="rsoToggleOverview()" title="Всё поле боя">MAP<span>Поле</span></button>' +
      '<button class="sf-b sf-bl" id="so-speed-btn" type="button" title="Скорость">SPEED<span id="sf-speed-v">×1</span></button>' +
    '</div>' +
    '<div class="sf-count" id="so-countdown"></div>' +
    '<div class="sf-load" id="so-load"><div class="sf-load-ring"></div><span>Готовим финал…</span></div>' +
    '<div class="sf-win" id="so-winner">' +
      '<div class="sf-win-av" id="sf-win-av"></div>' +
      '<div class="sf-win-rib">ЧЕМПИОН ОСТРОВА</div>' +
      '<div class="sf-win-n" id="so-winner-name"></div>' +
      '<div class="sf-win-s" id="so-winner-stats"></div>' +
      '<button class="sf-win-x" id="so-winner-close" type="button">Готово</button>' +
    '</div>';
  root.querySelectorAll('.sf-b').forEach(b => { const k = b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent : ''; if (SF_ICO[k]) { b.firstChild.remove(); b.insertAdjacentHTML('afterbegin', SF_ICO[k]); } });
  document.getElementById('so-winner-close').onclick = () => stop();
  document.getElementById('so-speed-btn').onclick = () => { if (!G) return; G.speed = G.speed === 1 ? 2 : 1; document.getElementById('sf-speed-v').textContent = '×' + G.speed; };
  // клік по портрету — камера на цього бійця
  ['sf-roster-l', 'sf-roster-r'].forEach(id => document.getElementById(id).addEventListener('click', e => {
    const el = e.target.closest('.sf-pt'); if (!el || !G) return;
    const f = G.fighters[+el.dataset.i]; if (!f) return;
    G.cam.focus = f; G.cam.manual = true; G.cam.mode = 'follow';
  }));
  return root;
}
const SF_ICO = { PREV: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>', NEXT: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>', AUTO: '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>', MAP: '<svg viewBox="0 0 24 24"><path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/></svg>', SPEED: '<svg viewBox="0 0 24 24"><path d="M4 6l7 6-7 6zM13 6l7 6-7 6z"/></svg>' };
const $ = id => document.getElementById(id);

// ── світ: фінал іде прямо на острові лобі (та сама сцена й рендерер), у місці, де закінчилась зона ──
const S_SOLD = 1.0;                // масштаб солдата
const AR = 21;                     // радіус поля бою навколо центру
let CX = 0, CZ = 0;                // центр поля бою (світові координати острова)
function ground(x, z) { return typeof rlGround === 'function' ? Math.max(rlGround(x, z), -0.3) : 0; }   // у воді — по поверхні, як у лобі
function areaD(x, z) { return Math.hypot(x - CX, z - CZ); }
function ringTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 30, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.62, 'rgba(255,255,255,0.18)'); g.addColorStop(0.78, 'rgba(255,255,255,1)');
  g.addColorStop(0.86, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.beginPath(); x.arc(64, 64, 63, 0, 7); x.fill();
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
}
function soldierMat(col) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, skinning: true });
  m.userData.tint = { value: col.clone() };
  m.onBeforeCompile = sh => {
    sh.uniforms.uTint = m.userData.tint;
    sh.vertexShader = 'uniform vec3 uTint;\n' + sh.vertexShader.replace('#include <color_vertex>',
      '#include <color_vertex>\n#ifdef USE_COLOR\n  vColor.xyz = color.xyz;\n  if (color.r > 0.97 && color.g < 0.03 && color.b > 0.97) vColor.xyz = uTint;\n#endif');
  };
  m.customProgramCacheKey = () => 'br-soldier';
  return m;
}
// межі моделей набору (для колайдерів) — один раз на прототип
const PROTO_BOX = {};
function protoBox(key) {
  if (PROTO_BOX[key]) return PROTO_BOX[key];
  const b = new THREE.Box3();
  for (const part of (RV.protos[key] || [])) { if (!part.geo.boundingBox) part.geo.computeBoundingBox(); b.union(part.geo.boundingBox.clone().applyMatrix4(part.local)); }
  return (PROTO_BOX[key] = b);
}
function initWorld() {
  if (W) return W.ready;
  if (typeof RV === 'undefined' || !RV.ready) return Promise.resolve(false);
  W = {};
  W.ready = BR3.loadKit().then(kit => {
    const scene = RV.scene;
    W.R = RV.R; W.scene = scene;
    W.camera = new THREE.PerspectiveCamera(34, 1, 0.5, 900);
    W.wall = BR3.zoneWall(); W.wall.visible = false; scene.add(W.wall);
    W.fx = new BR3.Fx(scene, ground);
    W.labels = new BR3.Labels($('royale-shootout'));
    W.planks = new BR3.Debris(scene, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xc58a4a }), 260, ground);
    W.nadeGeo = kit.geo.Grenade; W.nadeMat = BR3.tintMat();
    W.crownGeo = kit.geo.Crown; W.crownMat = BR3.tintMat();
    W.chuteGeo = kit.geo.Chute;
    W.soldier = RV.soldier; W.clips = RV.clips;
    W.rings = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.0, 2.0).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: ringTex(), transparent: true, depthWrite: false, toneMapped: false }), 128);
    for (let i = 0; i < 128; i++) W.rings.setColorAt(i, new THREE.Color(1, 1, 1));
    W.rings.count = 0; W.rings.frustumCulled = false; W.rings.renderOrder = 2; scene.add(W.rings);
    W.spot = new THREE.SpotLight(0xfff0c0, 0, 40, 0.42, 0.5, 1.2); scene.add(W.spot); scene.add(W.spot.target);
    W.crateInst = []; W.barrelInst = [];
    window.addEventListener('resize', resize);
    BR3.sndInit();
    return true;
  }).catch(e => { console.warn('[final] не вдалося підготувати фінал', e); W = null; return false; });
  return W.ready;
}
// інстанси ящиків/бочок, розкиданих по полю бою
function makeInst(key, list) {
  const out = [], q = new THREE.Quaternion(), sv = new THREE.Vector3(), v = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  for (const part of RV.protos[key] || []) {
    const im = new THREE.InstancedMesh(part.geo, part.mat, Math.max(1, list.length)); im.castShadow = true; im.receiveShadow = true;
    const base = list.map((p, i) => { q.setFromAxisAngle(Y, p.rot); sv.set(p.s, p.s, p.s); v.set(p.x, p.y, p.z); const mm = new THREE.Matrix4().compose(v, q, sv).multiply(part.local); im.setMatrixAt(i, mm); return mm; });
    im.count = list.length; W.scene.add(im); out.push({ im, base });
  }
  return out;
}
function dropInst(list) { for (const p of list) W.scene.remove(p.im); }
function setInstVisible(list, i, on) {
  for (const p of list) { p.im.setMatrixAt(i, on ? p.base[i] : BR3.ZERO); p.im.instanceMatrix.needsUpdate = true; }
}
// солдат бійця: клон зі скелетом, власний міксер і колір форми
function addSoldier(f) {
  const o = THREE.SkeletonUtils.clone(W.soldier.scene);
  const uni = new THREE.Color().setHSL(BR3.hue(f.nick) / 360, 0.85, 0.36);
  f.mat = soldierMat(uni);
  o.traverse(n => { if (n.isMesh) { n.material = f.mat; n.castShadow = true; n.frustumCulled = false; } if (n.isBone && n.name === 'Head') f.head = n; });
  o.scale.setScalar(S_SOLD);
  W.scene.add(o); f.obj = o; f.mixer = new THREE.AnimationMixer(o);
  const cm = soldierMat(uni); cm.side = THREE.DoubleSide; cm.skinning = false;
  f.chuteMesh = new THREE.Mesh(W.chuteGeo, cm); f.chuteMesh.position.set(0, 1.55, 0); f.chuteMesh.scale.setScalar(0.01); o.add(f.chuteMesh);
}
function play(f, name, once) {
  const clip = W.clips[name]; if (!clip || f.actName === name) return;
  const a = f.mixer.clipAction(clip);
  a.reset(); a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat); a.clampWhenFinished = !!once;
  if (f.act) a.crossFadeFrom(f.act, 0.15, false);
  a.play(); f.act = a; f.actName = name;
}
function removeSoldier(f) { if (f.obj) { W.scene.remove(f.obj); f.mixer.stopAllAction(); f.mat.dispose(); f.obj = null; } }
function resize() {
  if (!W || !W.R) return;
  const w = RV.w || window.innerWidth, h = RV.h || window.innerHeight;   // рендер — у полотно лобі (воно на весь екран)
  W.camera.aspect = w / h; W.camera.updateProjectionMatrix();
  const root = $('royale-shootout'); W.labels.resize(root.clientWidth || w, root.clientHeight || h);
}

// ── колайдери та навігація ──
function buildBoxes() {
  G.boxes = [];
  const TREE = /^(T_tree|Tree1|pine|Palm)/, SOLID = /^(house01|farmHouse|WaterHouse|BerrHouse|th|T_struct|T_container|Tent|T_watertank|T_tank|T_car|Tower2|Cylinder)/,
    LOW = /^(T_sack|T_barrier|T_boxes|T_pallet|T_crate|T_barrel|T_tires)/, ROCK = /^Rock/;
  const v = new THREE.Vector3();
  for (const p of RV.place) {
    const [key, x, y, z, rot, s] = p;
    if (areaD(x, z) > AR + 8) continue;
    const gy = ground(x, z);
    if (TREE.test(key)) { G.boxes.push({ t: 'wall', x, z, w: 0.8, d: 0.8, h: gy + 3.2, dead: false, hp: 1e9 }); continue; }
    const t = SOLID.test(key) ? 'wall' : LOW.test(key) ? 'low' : ROCK.test(key) ? 'rock' : null;
    if (!t) continue;
    const b = protoBox(key), c = Math.cos(rot), sn = Math.sin(rot);
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const cx of [b.min.x, b.max.x]) for (const cz of [b.min.z, b.max.z]) {
      const wx = x + (cx * c + cz * sn) * s, wz = z + (-cx * sn + cz * c) * s;
      x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
    }
    const hh = (b.max.y - b.min.y) * s, k = t === 'wall' ? 0.86 : 0.8;
    const type = t === 'rock' ? (hh > 1.4 ? 'wall' : 'low') : t;
    G.boxes.push({ t: type, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: (x1 - x0) * k, d: (z1 - z0) * k, h: y + b.max.y * s, dead: false, hp: 1e9 });
  }
  // розкидані ящики й бочки
  G.crates.forEach((c, i) => G.boxes.push({ t: 'crate', id: i, x: c.x, z: c.z, w: 1.25 * c.s * 0.8, d: 1.25 * c.s * 0.8, h: c.y + 1.0 * c.s * 0.8, dead: false, hp: 70 }));
  G.barrels.forEach((c, i) => G.boxes.push({ t: 'barrel', id: i, x: c.x, z: c.z, w: 0.95, d: 0.95, h: c.y + 1.2, dead: false, hp: 22 }));
  G.crateBox = {}; G.barrelBox = {};
  for (const b of G.boxes) { if (b.t === 'crate') G.crateBox[b.id] = b; if (b.t === 'barrel') G.barrelBox[b.id] = b; }
  buildNav();
}
const NN = 52, NOFF = 26;
function buildNav() {
  const g = new Uint8Array(NN * NN);
  for (let j = 0; j < NN; j++) for (let i = 0; i < NN; i++) {
    const x = CX + i - NOFF + 0.5, z = CZ + j - NOFF + 0.5;
    if (areaD(x, z) > AR) { g[j * NN + i] = 1; continue; }
    const h = ground(x, z);
    // вода й круті схили (скелі плато) — непрохідні
    if (h < 0.3 || Math.max(Math.abs(ground(x + 0.7, z) - h), Math.abs(ground(x - 0.7, z) - h), Math.abs(ground(x, z + 0.7) - h), Math.abs(ground(x, z - 0.7) - h)) > 0.75) { g[j * NN + i] = 1; continue; }
    for (const b of G.boxes) { if (b.dead) continue; if (Math.abs(x - b.x) < b.w / 2 + 0.45 && Math.abs(z - b.z) < b.d / 2 + 0.45) { g[j * NN + i] = 1; break; } }
  }
  G.nav = g;
}
function cellFree(x, z) { const i = Math.floor(x - CX + NOFF), j = Math.floor(z - CZ + NOFF); return i >= 0 && j >= 0 && i < NN && j < NN && !G.nav[j * NN + i]; }
function findPath(x0, z0, x1, z1) {
  const nav = G.nav; let si = Math.floor(x0 - CX + NOFF), sj = Math.floor(z0 - CZ + NOFF), ti = Math.floor(x1 - CX + NOFF), tj = Math.floor(z1 - CZ + NOFF);
  ti = clamp(ti, 0, NN - 1); tj = clamp(tj, 0, NN - 1); si = clamp(si, 0, NN - 1); sj = clamp(sj, 0, NN - 1);
  if (nav[tj * NN + ti]) { // ціль у перешкоді — найближча вільна клітинка
    let best = -1, bd = 1e9;
    for (let r = 1; r < 6 && best < 0; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = ti + di, j = tj + dj; if (i < 0 || j < 0 || i >= NN || j >= NN || nav[j * NN + i]) continue;
      const d = di * di + dj * dj; if (d < bd) { bd = d; best = j * NN + i; }
    }
    if (best < 0) return null; ti = best % NN; tj = (best / NN) | 0;
  }
  const S = sj * NN + si, T = tj * NN + ti;
  const gs = new Float32Array(NN * NN).fill(1e9), from = new Int32Array(NN * NN).fill(-1), closed = new Uint8Array(NN * NN);
  const heap = [], push = (n, f) => { heap.push([f, n]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  gs[S] = 0; push(S, 0); let it = 0;
  while (heap.length && it++ < 5000) {
    const [, n] = pop(); if (n === T) break; if (closed[n]) continue; closed[n] = 1;
    const ci = n % NN, cj = (n / NN) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= NN || j >= NN) continue;
      const m = j * NN + i; if (nav[m] && m !== S) continue;
      if (di && dj && (nav[cj * NN + i] || nav[j * NN + ci])) continue;
      const ng = gs[n] + (di && dj ? 1.414 : 1); if (ng < gs[m]) { gs[m] = ng; from[m] = n; push(m, ng + Math.hypot(ti - i, tj - j)); }
    }
  }
  if (from[T] < 0 && T !== S) return null;
  const pts = []; let n = T; while (n !== S && n >= 0) { pts.push({ x: CX + (n % NN) - NOFF + 0.5, z: CZ + ((n / NN) | 0) - NOFF + 0.5 }); n = from[n]; }
  pts.reverse();
  // згладжування: пропускаємо точки, до яких видно напряму
  const out = []; let ax = x0, az = z0, k = 0;
  while (k < pts.length) { let far = k; for (let m = Math.min(pts.length - 1, k + 8); m > k; m--) if (walkClear(ax, az, pts[m].x, pts[m].z)) { far = m; break; } out.push(pts[far]); ax = pts[far].x; az = pts[far].z; k = far + 1; }
  return out;
}
function walkClear(x0, z0, x1, z1) {
  const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / 0.4);
  for (let i = 1; i <= n; i++) { const t = i / n; if (!cellFree(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false; }
  return true;
}
// промінь (x0,y0,z0)→(x1,y1,z1) проти AABB-коробок; повертає перший блокер {b,t}
function rayHit(x0, y0, z0, x1, y1, z1, skipLow) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0; let best = null;
  for (const b of G.boxes) {
    if (b.dead || b.deco) continue;
    if (skipLow && b.t === 'low') continue;
    let tmin = 0, tmax = 1;
    const ax = [[x0, dx, b.x - b.w / 2, b.x + b.w / 2], [z0, dz, b.z - b.d / 2, b.z + b.d / 2], [y0, dy, 0, b.h]];
    let ok = true;
    for (const [o, d, lo, hi] of ax) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { ok = false; break; } continue; }
      let t1 = (lo - o) / d, t2 = (hi - o) / d; if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) { ok = false; break; }
    }
    if (ok && (!best || tmin < best.t)) best = { b, t: tmin };
  }
  return best;
}
function eyeY(f) { return (f.y || 0) + (f.crouch ? 1.0 : 1.5); }
function chestY(f) { return (f.y || 0) + (f.crouch ? 0.75 : 1.25); }
function losTo(a, b) { return !rayHit(a.x, eyeY(a), a.z, b.x, chestY(b), b.z); }

// ── старт ──
function start(finalists, opts) {
  opts = opts || {};
  const root = ensureDom();
  root.classList.add('visible', 'sf-island');
  const lobby = document.getElementById('royale-overlay'); if (lobby) lobby.classList.add('rl-final-on');
  $('so-winner').classList.remove('show'); $('so-load').classList.add('show');
  $('so-killfeed').innerHTML = ''; $('so-countdown').textContent = '';
  seedRng();
  initWorld().then(ok => {
    if (!ok) { $('so-load').querySelector('span').textContent = 'Не удалось подготовить финал — обнови страницу'; return; }
    resize();
    setup(finalists, opts);
    $('so-load').classList.remove('show');
    lastT = performance.now();
    if (!raf) raf = requestAnimationFrame(loop);
  });
}
// лобі на час фіналу: ховаємо його бійців, кола, стіну й прожектор (сцена спільна)
function lobbyHide(on) {
  if (typeof RV === 'undefined' || !RV.ready) return;
  RV.list.forEach(v => { if (v.obj) v.obj.visible = !on; });
  RV.rings.visible = !on; if (on) { RV.wall.visible = false; RV.spot.intensity = 0; RV.plane.visible = false; }
}
function setup(finalists, opts) {
  // прибрати попередній бій
  W.fx.clear(); W.planks.clear();
  if (G && G.nades) G.nades.forEach(n => W.scene.remove(n.mesh));
  if (G && G.fighters) G.fighters.forEach(removeSoldier);
  dropInst(W.crateInst); dropInst(W.barrelInst);
  CX = opts.center ? opts.center.x : 0; CZ = opts.center ? opts.center.z : 0;
  // центр — на суші й подалі від краю острова
  for (let k = 0; k < 40 && (ground(CX, CZ) < 0.6 || Math.hypot(CX, CZ) > 46); k++) { CX *= 0.9; CZ *= 0.9; }
  lobbyHide(true);
  G = { t: 0, phase: 'intro', fighters: [], nades: [], boxes: null, onWinner: opts.onWinner || null, winner: null, cam: { mode: 'intro', focus: null, manual: false, sw: 0, pos: V3(), look: V3(), ready: false },
    zone: null, zoneNext: 0, zoneStage: 0, slow: 1, slowT: 0, speed: 1, feed: [], killcam: null, fightT: 0, crates: [], barrels: [] };
  $('sf-speed-v').textContent = '×1'; G.firstBlood = false; G.annT = 0; G.rosterT = 0; $('sf-announce').classList.remove('show');
  // перешкоди острова (без ящиків/бочок) — щоб знайти вільні місця під реквізит і бійців
  buildBoxes();
  const freeSpot = (rMin, rMax, pad) => { for (let k = 0; k < 80; k++) { const a = rnd() * TAU, r = rMin + rnd() * (rMax - rMin), x = CX + Math.cos(a) * r, z = CZ + Math.sin(a) * r;
    if (!cellFree(x, z) || !cellFree(x + pad, z) || !cellFree(x - pad, z) || !cellFree(x, z + pad) || !cellFree(x, z - pad)) continue; return { x, z }; } return null; };
  for (let k = 0; k < 9; k++) { const p = freeSpot(3, AR - 3, 1.2); if (p) G.crates.push({ x: p.x, z: p.z, y: ground(p.x, p.z) - 0.02, rot: rnd() < 0.5 ? 0 : Math.PI / 2, s: 1.6 }); }
  for (let k = 0; k < 6; k++) { const p = freeSpot(3, AR - 3, 1.0); if (p) G.barrels.push({ x: p.x, z: p.z, y: ground(p.x, p.z) - 0.02, rot: 0, s: 1.25 }); }
  W.crateInst = makeInst('T_crate', G.crates); W.barrelInst = makeInst('T_barrel', G.barrels);
  buildBoxes();   // тепер разом із ящиками й бочками
  // бійці — там, де стояли в лобі (якщо далеко — на краю поля в їхньому напрямку)
  finalists.forEach((fz, i) => {
    let x, z; const lp = opts.pos && opts.pos[fz.nick];
    if (lp && areaD(lp.x, lp.z) < AR - 2 && cellFree(lp.x, lp.z)) { x = lp.x; z = lp.z; }
    else {
      let a = lp ? Math.atan2(lp.z - CZ, lp.x - CX) : rnd() * TAU, tries = 0;
      do { const r = AR - 4 - rnd() * 8; x = CX + Math.cos(a) * r; z = CZ + Math.sin(a) * r; a += 0.35; } while (!cellFree(x, z) && ++tries < 40);
    }
    const hp = clamp(fz.startHP || 100, 10, 100);
    const f = { nick: fz.nick, src: fz, x, z, y: ground(x, z), yaw: Math.atan2(CX - x, CZ - z), s: 1, mode: 'stand', chute: 0, ph: rnd() * 6, aim: 0, pitch: 0, col: BR3.colorOf(fz.nick),
      hp, maxhp: 100, alive: true, kills: 0, dmg: 0, path: null, pi: 0, think: rnd() * 0.5, fireCd: 1 + rnd(), burst: 3, nadeCd: 10 + rnd() * 9, crouch: false,
      vx: 0, vz: 0, target: null, heat: 0, landDelay: 0, lastSeen: null, coverT: 0, strafe: rnd() < 0.5 ? 1 : -1 };
    addSoldier(f); G.fighters.push(f);
  });
  // камера стартує з кадру лобі й з'їжджає до місця бою
  G.cam.pos.copy(RV.camera.position); G.cam.look.set(RV.cam.x, 1, RV.cam.z); G.cam.ready = true;
  G.cam.focus = G.fighters[0];
  renderFeed();
}

// ── цикл ──
function loop() {
  raf = 0;
  if (!G || !W) return;
  const root = $('royale-shootout'); if (!root.classList.contains('visible')) return;
  const now = performance.now(); let rdt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const dt = rdt * G.slow * G.speed;
  step(dt, rdt);
  W.R.render(W.scene, W.camera);   // полотно лобі
  drawLabels();
  raf = requestAnimationFrame(loop);
}
function alive() { return G.fighters.filter(f => f.alive); }
function step(dt, rdt) {
  G.t += dt; BR3.ZU.uTime.value += dt;
  // уповільнення: повертаємось до 1 після кіно-моменту
  if (G.slowT > 0) { G.slowT -= rdt; if (G.slowT <= 0) G.slow = 1; }
  if (G.phase === 'intro') intro(dt);
  else if (G.phase === 'count') countdown(dt);
  else if (G.phase === 'fight') fight(dt);
  else if (G.phase === 'outro') outro(dt);
  // зона
  if (G.zone) {
    const Z = G.zone; if (Z.anim) { Z.anim.t += dt; const k = clamp(Z.anim.t / Z.anim.d, 0, 1), e = k * k * (3 - 2 * k); Z.r = Z.anim.r0 + (Z.anim.r1 - Z.anim.r0) * e; Z.x = Z.anim.x0 + (Z.anim.x1 - Z.anim.x0) * e; Z.z = Z.anim.z0 + (Z.anim.z1 - Z.anim.z0) * e; if (k >= 1) Z.anim = null; }
    BR3.ZU.uZone.value.set(Z.x, Z.z, Z.r, 1); W.wall.visible = true; W.wall.position.set(Z.x, -1, Z.z); W.wall.scale.set(Z.r, 22, Z.r);
  } else { BR3.ZU.uZone.value.w = 0; W.wall.visible = false; }
  BR3.ZU.uRed.value.w = 0; BR3.ZU.uZoneSq.value = 0; BR3.ZU.uGrid.value = 0;   // у фіналі зона кругла, без сітки лобі (лобі поверне своє)
  // бійці
  let ri = 0;
  for (const f of G.fighters) {
    animate(f, dt);
    if (f.alive || G.t - f.diedT < 1.2) {
      const gy = ground(f.x, f.z) + 0.08, sc = f.alive ? (f.mode === 'chute' ? 0.6 + 0.4 * Math.sin(G.t * 6) : 1) : 1 - (G.t - f.diedT) / 1.2;
      _rm.compose(_rv.set(f.x, gy, f.z), _rq, _rSc.set(sc, 1, sc)); W.rings.setMatrixAt(ri, _rm); W.rings.setColorAt(ri, f.alive ? f.col : BR3.C.red); ri++;
    }
  }
  W.rings.count = ri; W.rings.instanceMatrix.needsUpdate = true; if (W.rings.instanceColor) W.rings.instanceColor.needsUpdate = true;
  stepNades(dt);
  W.fx.step(dt, W.camera); W.planks.step(dt);
  camera(rdt, dt);
  hud();
}

const _rm = new THREE.Matrix4(), _rv = new THREE.Vector3(), _rq = new THREE.Quaternion(), _rSc = new THREE.Vector3();
// анімація й тіло бійця
function animate(f, dt) {
  if (!f.obj) return;
  if (!f.alive) {
    play(f, 'Death', true);
    if (f.air) {
      f.vy -= 30 * dt; f.x += f.vx * dt; f.z += f.vz * dt; f.y += f.vy * dt;
      const od = areaD(f.x, f.z); if (od > AR + 4) { f.x = CX + (f.x - CX) / od * (AR + 4); f.z = CZ + (f.z - CZ) / od * (AR + 4); }
      const gy = ground(f.x, f.z);
      if (f.y <= gy) { f.y = gy; if (f.vy < -6) { f.vy = -f.vy * 0.25; f.vx *= 0.5; f.vz *= 0.5; W.fx.dust(new THREE.Vector3(f.x, gy, f.z), 0.5); } else { f.air = false; f.vy = 0; } }
    }
  } else if (f.mode === 'chute') play(f, 'Wave');
  else if (f.mode === 'win') play(f, 'Wave');
  else if (f.moving) play(f, f.target && f.target.alive ? 'Run_Shoot' : 'Run_Gun');
  else play(f, f.target && f.target.alive ? 'Idle_Shoot' : 'Idle');
  f.mixer.update(dt);
  f.obj.position.set(f.x, f.y, f.z); f.obj.rotation.set(0, f.yaw, 0);
  if (f.chuteMesh) {
    const want = f.mode === 'chute' && G.t >= f.landDelay ? 1 : 0, c = f.chuteMesh.scale.x + (want - f.chuteMesh.scale.x) * Math.min(1, dt * 4);
    f.chuteMesh.scale.setScalar(Math.max(0.001, c)); f.chuteMesh.visible = c > 0.02;
  }
  if (f.crown && !f.crownMesh && f.head) { f.crownMesh = new THREE.Mesh(W.crownGeo, W.crownMat); f.crownMesh.position.set(0, 0.6, 0); f.crownMesh.scale.setScalar(1.0); f.head.add(f.crownMesh); }
}
// дуло: перед бійцем, на висоті плеча
function muzzle(f, out) {
  const s = Math.sin(f.yaw), c = Math.cos(f.yaw);
  return out.set(f.x + s * 0.95 * S_SOLD + c * 0.12, f.y + 1.3 * S_SOLD, f.z + c * 0.95 * S_SOLD - s * 0.12);
}

// ── інтро: десант на арену → відлік ──
function intro(dt) {
  // бійці вже стоять на острові; камера з'їжджає з плану лобі до поля бою
  if (G.t > 2.6) { G.phase = 'count'; G.countT = 0; G.countN = 4; }
}
function countdown(dt) {
  G.countT -= dt;
  for (const f of G.fighters) { f.aim = Math.min(1, f.aim + dt * 2); f.mode = 'stand'; }
  if (G.countT <= 0) {
    G.countN--; G.countT = 0.85;
    const el = $('so-countdown');
    if (G.countN > 0) { el.textContent = G.countN; BR3.snd('br-beep', 0.7); }
    else { el.textContent = 'БОЙ!'; BR3.snd('br-go', 0.8); G.phase = 'fight'; G.fightT = 0; G.zoneNext = 14; setTimeout(() => { if ($('so-countdown').textContent === 'БОЙ!') $('so-countdown').textContent = ''; }, 900); }
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
}

// ── бій ──
function fight(dt) {
  G.fightT += dt;
  zoneTick(dt);
  const al = alive();
  for (const f of al) brain(f, dt, al);
  for (const f of al) move(f, dt, al);
  for (const f of al) shoot(f, dt);
  // зона шкодить
  if (G.zone) for (const f of alive()) {
    if (Math.hypot(f.x - G.zone.x, f.z - G.zone.z) > G.zone.r) {
      f.zoneAcc = (f.zoneAcc || 0) + dt;
      if (f.zoneAcc > 0.5) { damage(f, (4 + G.zoneStage * 1.5) * f.zoneAcc, null, 'zone', null); f.zoneAcc = 0; }
    }
  }
  if (alive().length <= 1 && G.phase === 'fight') finishFight();
}
function zoneTick(dt) {
  if (G.fightT < G.zoneNext) return;
  const stage = G.zoneStage++;
  if (!G.zone) {
    G.zone = { x: CX + (rnd() - 0.5) * 5, z: CZ + (rnd() - 0.5) * 5, r: AR + 5 };
  }
  const Z = G.zone, r1 = Math.max(3.5, Z.r * (stage === 0 ? 0.62 : 0.66));
  const shift = (Z.r - r1) * 0.35, a = rnd() * TAU;
  let x1 = clamp(Z.x + Math.cos(a) * shift, CX - 6, CX + 6), z1 = clamp(Z.z + Math.sin(a) * shift, CZ - 6, CZ + 6);
  Z.anim = { t: 0, d: 6, r0: Z.r, r1, x0: Z.x, z0: Z.z, x1, z1 };
  G.zoneNext = G.fightT + 15;
  BR3.snd('br-zone', 0.55);
}
function brain(f, dt, al) {
  f.think -= dt; f.fireCd -= dt; f.nadeCd -= dt; f.heat = Math.max(0, f.heat - dt * 0.6);
  if (f.think > 0) return;
  f.think = 0.28 + rnd() * 0.25;
  // ціль: найближчий видимий, інакше найближчий узагалі
  let best = null, bd = 1e9, vis = null, vd = 1e9;
  for (const e of al) {
    if (e === f) continue;
    const d = Math.hypot(e.x - f.x, e.z - f.z);
    if (d < bd) { bd = d; best = e; }
    if (d < 38 && d < vd && losTo(f, e)) { vd = d; vis = e; }
  }
  f.target = vis || null; f.visible = !!vis;
  if (vis) f.lastSeen = { x: vis.x, z: vis.z, t: G.t, who: vis };
  const zoneOut = G.zone && Math.hypot(f.x - G.zone.x, f.z - G.zone.z) > G.zone.r - 2.5;
  // граната: ціль за укриттям / купка ворогів
  if (f.nadeCd <= 0 && best) {
    const tgt = vis || (f.lastSeen && G.t - f.lastSeen.t < 4 ? f.lastSeen : null);
    const tx = tgt ? tgt.x : best.x, tz = tgt ? tgt.z : best.z, d = Math.hypot(tx - f.x, tz - f.z);
    if (d > 6 && d < 21 && (!vis || rnd() < 0.3)) { throwNade(f, tx + (rnd() - 0.5) * 2, tz + (rnd() - 0.5) * 2); f.nadeCd = 13 + rnd() * 10; }
  }
  // куди йти
  let goal = null;
  if (zoneOut) goal = towardZone(f);
  else if (vis) {
    if (!f.cover || G.t > f.coverT || rnd() < 0.08) { f.cover = findCover(f, vis); f.coverT = G.t + 3 + rnd() * 3; }
    goal = f.cover;
    if (!goal || Math.hypot(goal.x - f.x, goal.z - f.z) < 0.6) {
      // у прикритті: присідаємо між чергами, або стрейф
      f.crouch = f.fireCd > 0.25 && f.lowCover;
      if (!f.lowCover && rnd() < 0.5) { const ang = Math.atan2(vis.x - f.x, vis.z - f.z) + Math.PI / 2 * f.strafe; goal = { x: f.x + Math.sin(ang) * 2.5, z: f.z + Math.cos(ang) * 2.5 }; if (!cellFree(goal.x, goal.z)) { f.strafe *= -1; goal = null; } }
    }
  } else {
    f.crouch = false;
    const ls = f.lastSeen && G.t - f.lastSeen.t < 6 ? f.lastSeen : best;
    if (ls) goal = { x: ls.x, z: ls.z };
  }
  if (goal && (!f.goal || Math.hypot(goal.x - f.goal.x, goal.z - f.goal.z) > 1.2 || !f.path)) {
    f.goal = goal; f.path = findPath(f.x, f.z, goal.x, goal.z); f.pi = 0;
  }
  if (!goal) { f.path = null; f.goal = null; }
}
function towardZone(f) {
  const Z = G.zone, dx = Z.x - f.x, dz = Z.z - f.z, d = Math.hypot(dx, dz) || 1, k = Math.max(0, d - Z.r * 0.55);
  return { x: f.x + dx / d * k, z: f.z + dz / d * k };
}
function findCover(f, e) {
  let best = null, bs = -1e9;
  for (let k = 0; k < 16; k++) {
    const a = rnd() * TAU, r = 1.5 + rnd() * 7, x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r;
    if (!cellFree(x, z)) continue;
    if (G.zone && Math.hypot(x - G.zone.x, z - G.zone.z) > G.zone.r - 2) continue;
    const de = Math.hypot(e.x - x, e.z - z); if (de < 5) continue;
    const hidLow = !!rayHit(e.x, 1.5, e.z, x, 0.75, z);
    const hidHigh = !!rayHit(e.x, 1.5, e.z, x, 1.3, z);
    const peek = !rayHit(x, 1.5, z, e.x, 1.25, e.z);
    let s = (hidLow ? 3 : 0) + (peek && hidLow && !hidHigh ? 4 : 0) + (hidHigh ? 1.5 : 0) - r * 0.25 - Math.abs(de - 14) * 0.12;
    if (s > bs) { bs = s; best = { x, z, low: hidLow && !hidHigh }; }
  }
  f.lowCover = best ? best.low : false;
  return best;
}
const _sep = { x: 0, z: 0 };
function move(f, dt, al) {
  let mvx = 0, mvz = 0;
  if (f.path && f.pi < f.path.length) {
    const p = f.path[f.pi], dx = p.x - f.x, dz = p.z - f.z, d = Math.hypot(dx, dz);
    if (d < 0.35) f.pi++;
    else { mvx = dx / d; mvz = dz / d; }
  }
  // розштовхування
  for (const o of al) { if (o === f) continue; const dx = f.x - o.x, dz = f.z - o.z, d = Math.hypot(dx, dz); if (d < 0.9 && d > 1e-4) { mvx += dx / d * 0.8; mvz += dz / d * 0.8; } }
  const moving = Math.hypot(mvx, mvz) > 0.1;
  const sp = f.crouch ? 1.6 : (f.visible ? 3.6 : 5.8);
  if (moving) { const L = Math.hypot(mvx, mvz); mvx /= L; mvz /= L; if (f.crouch && f.path) f.crouch = false; }
  f.vx += ((moving ? mvx * sp : 0) - f.vx) * Math.min(1, dt * 10); f.vz += ((moving ? mvz * sp : 0) - f.vz) * Math.min(1, dt * 10);
  const px = f.x, pz = f.z;
  f.x += f.vx * dt; f.z += f.vz * dt;
  if (ground(f.x, f.z) < 0.3 && ground(px, pz) >= 0.3) { f.x = px; f.z = pz; f.vx *= -0.3; f.vz *= -0.3; }   // у річку/море не заходимо
  // зіткнення з коробками
  for (const b of G.boxes) {
    if (b.dead) continue;
    const hx = b.w / 2 + 0.35, hz = b.d / 2 + 0.35, dx = f.x - b.x, dz = f.z - b.z;
    if (Math.abs(dx) < hx && Math.abs(dz) < hz) { const ox = hx - Math.abs(dx), oz = hz - Math.abs(dz); if (ox < oz) f.x = b.x + Math.sign(dx || 1) * hx; else f.z = b.z + Math.sign(dz || 1) * hz; }
  }
  const ad = areaD(f.x, f.z); if (ad > AR - 0.3) { f.x = CX + (f.x - CX) / ad * (AR - 0.3); f.z = CZ + (f.z - CZ) / ad * (AR - 0.3); }
  f.y = ground(f.x, f.z);
  const spd = Math.hypot(f.vx, f.vz);
  f.moving = spd > 0.6;
  f.ph += dt * spd * 2.4;
  // куди дивимось
  const T = f.target;
  if (T && T.alive) {
    const want = Math.atan2(T.x - f.x, T.z - f.z); f.yaw += angD(want, f.yaw) * Math.min(1, dt * 9);
    f.aim = Math.min(1, f.aim + dt * 4);
    f.pitch = Math.atan2(chestY(T) - eyeY(f), Math.hypot(T.x - f.x, T.z - f.z)) * 0.8;
  } else {
    if (spd > 0.5) f.yaw += angD(Math.atan2(f.vx, f.vz), f.yaw) * Math.min(1, dt * 8);
    f.aim = Math.max(0.55, f.aim - dt * 2); f.pitch *= 0.9;
  }
  f.mode = f.crouch ? 'crouch' : (spd > 4.2 ? 'run' : (spd > 0.6 ? 'walk' : 'stand'));
}
function angD(a, b) { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }

// ── стрільба ──
const _mz = new THREE.Vector3(), _to = new THREE.Vector3(), _dir = new THREE.Vector3();
function shoot(f, dt) {
  const T = f.target;
  if (!T || !T.alive || f.fireCd > 0 || f.aim < 0.8) return;
  if (Math.abs(angD(Math.atan2(T.x - f.x, T.z - f.z), f.yaw)) > 0.35) return;
  f.crouch = false;
  f.burst--; f.fireCd = f.burst > 0 ? 0.11 + rnd() * 0.04 : 0.55 + rnd() * 0.8;
  if (f.burst <= 0) f.burst = 3 + Math.floor(rnd() * 4);
  muzzle(f, _mz);
  // часом — у бочку поруч із ціллю
  let aimAt = T, barrel = null;
  for (const id in G.barrelBox) { const b = G.barrelBox[id]; if (b.dead) continue; if (Math.hypot(b.x - T.x, b.z - T.z) < 3 && rnd() < 0.35 && !rayHit(f.x, eyeY(f), f.z, b.x, ground(b.x, b.z) + 0.6, b.z) ) { barrel = b; break; } }
  const d = Math.hypot(T.x - f.x, T.z - f.z);
  let tx, ty, tz;
  if (barrel) { tx = barrel.x; ty = ground(barrel.x, barrel.z) + 0.6; tz = barrel.z; }
  else { tx = T.x; ty = chestY(T); tz = T.z; }
  _dir.set(tx - _mz.x, ty - _mz.y, tz - _mz.z).normalize();
  W.fx.muzzle(_mz, _dir);
  BR3.snd(d < 14 || f === G.cam.focus ? 'br-shot' : 'br-shot2', f === G.cam.focus ? 0.5 : 0.28, 0.92 + rnd() * 0.16, 35);
  // перешкода на лінії вогню?
  const blk = rayHit(_mz.x, _mz.y, _mz.z, tx, ty, tz);
  if (barrel && (!blk || blk.b === barrel)) {
    _to.set(barrel.x, ty, barrel.z); W.fx.tracer(_mz, _to); W.fx.hit(_to, null);
    barrel.hp -= 9; if (barrel.hp <= 0) explodeBarrel(barrel, f);
    return;
  }
  if (blk && blk.b !== T) {
    _to.set(_mz.x + (tx - _mz.x) * blk.t, _mz.y + (ty - _mz.y) * blk.t, _mz.z + (tz - _mz.z) * blk.t);
    W.fx.tracer(_mz, _to); W.fx.hit(_to, null);
    if (rnd() < 0.15) BR3.snd('br-hit', 0.2, 0.9 + rnd() * 0.4, 120);
    if (blk.b.t === 'crate') { blk.b.hp -= 10; if (blk.b.hp <= 0) breakCrate(blk.b, _dir); }
    else if (blk.b.t === 'barrel') { blk.b.hp -= 9; if (blk.b.hp <= 0) explodeBarrel(blk.b, f); }
    return;
  }
  // влучання?
  let p = 0.4 * Math.max(0.16, 1 - d / 44);
  if (T.moving) p *= 0.78; if (f.moving) p *= 0.75; if (T.crouch) p *= 0.6;
  p *= 1 + Math.min(0.4, f.heat * 0.08);
  if (rnd() < p) {
    const head = rnd() < 0.1;
    _to.set(T.x + (rnd() - 0.5) * 0.3, head ? T.y + 1.8 : chestY(T) + (rnd() - 0.5) * 0.3, T.z + (rnd() - 0.5) * 0.3);
    W.fx.tracer(_mz, _to); W.fx.star(_to);
    damage(T, (6 + rnd() * 5) * (head ? 2 : 1), f, head ? 'head' : 'rifle', _dir.clone());
    f.heat += 1;
  } else {
    const miss = new THREE.Vector3((rnd() - 0.5) * 2.6, (rnd() - 0.5) * 1.4, (rnd() - 0.5) * 2.6);
    _to.set(tx, ty, tz).add(miss); const ext = _to.clone().sub(_mz).normalize().multiplyScalar(6); _to.add(ext); const gy = ground(_to.x, _to.z); _to.y = Math.max(gy + 0.02, _to.y);
    W.fx.tracer(_mz, _to); if (_to.y < gy + 0.1) W.fx.hit(_to, new THREE.Vector3(0, 1, 0));
  }
}
function damage(T, dmg, by, kind, dir) {
  if (!T.alive) return;
  // не допускаємо нічиєї: останній живий не гине, якщо гинуть усі
  const rest = alive().filter(f => f !== T);
  if (!rest.length) return;
  T.hp -= dmg; T.heat += 0.5; if (by) by.dmg += dmg;
  T.hitT = G.t;
  if (T.hp <= 0) kill(T, by, kind, dir);
}
function kill(T, by, kind, dir, blast) {
  T.alive = false; T.hp = 0; T.diedT = G.t;
  if (by && by !== T) by.kills++;
  const imp = blast ? blast : (dir ? dir.clone().setY(0).normalize().multiplyScalar(kind === 'head' ? 7 : 5).setY(3) : new THREE.Vector3(0, 2, 0));
  // падіння навзнак від удару + фізичний відкид (від вибуху — політ)
  T.vx = imp.x * (blast ? 0.9 : 0.6); T.vz = imp.z * (blast ? 0.9 : 0.6); T.vy = blast ? imp.y : 3.5; T.air = true;
  T.yaw = Math.atan2(-imp.x, -imp.z); T.moving = false; T.target = null;
  if (T.chuteMesh) T.chuteMesh.visible = false;
  BR3.snd('br-death', 0.45, 0.9 + rnd() * 0.25, 150);
  addFeed(by, T, kind);
  const left = alive().length;
  if (left === 1) {   // фінальне вбивство — кіно-уповільнення
    G.killcam = { victim: T, killer: by && by.alive ? by : alive()[0], t: 0 };
    G.slow = 0.2; G.slowT = 2.4;
  } else if (by && (T === G.cam.focus || by === G.cam.focus) && rnd() < 0.6) { G.slow = 0.4; G.slowT = 0.45; }
  if (T === G.cam.focus && !G.cam.manual) G.cam.sw = 0;
}

// ── гранати, бочки, ящики ──
function throwNade(f, tx, tz) {
  const T = clamp(Math.hypot(tx - f.x, tz - f.z) / 13, 0.7, 1.4), g = 22;
  const p = new THREE.Vector3(f.x, f.y + 1.7, f.z), gy = ground(tx, tz), v = new THREE.Vector3((tx - f.x) / T, (gy - p.y + 0.5 * g * T * T) / T, (tz - f.z) / T);
  const mesh = new THREE.Mesh(W.nadeGeo, W.nadeMat); mesh.scale.setScalar(1.4); mesh.castShadow = true; W.scene.add(mesh);
  G.nades.push({ p, v, fuse: T + 0.9, mesh, by: f, spin: V3().set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), g });
  f.aim = 0.3;
}
function stepNades(dt) {
  for (let i = G.nades.length - 1; i >= 0; i--) {
    const n = G.nades[i]; n.fuse -= dt;
    n.v.y -= n.g * dt; n.p.addScaledVector(n.v, dt);
    const ngy = ground(n.p.x, n.p.z) + 0.12;
    if (n.p.y < ngy) { n.p.y = ngy; if (Math.abs(n.v.y) > 2) BR3.snd('br-clink', 0.35, 1, 120); n.v.y = Math.abs(n.v.y) * 0.35; n.v.x *= 0.55; n.v.z *= 0.55; }
    for (const b of G.boxes) {
      if (b.dead) continue;
      const dx = n.p.x - b.x, dz = n.p.z - b.z, hx = b.w / 2 + 0.12, hz = b.d / 2 + 0.12;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz && n.p.y < b.h + 0.12) {
        const ox = hx - Math.abs(dx), oz = hz - Math.abs(dz), oy = b.h + 0.12 - n.p.y;
        if (oy < ox && oy < oz) { n.p.y = b.h + 0.12; n.v.y = Math.abs(n.v.y) * 0.35; } else if (ox < oz) { n.p.x = b.x + Math.sign(dx || 1) * hx; n.v.x *= -0.5; } else { n.p.z = b.z + Math.sign(dz || 1) * hz; n.v.z *= -0.5; }
      }
    }
    n.mesh.position.copy(n.p); n.mesh.rotateOnAxis(n.spin, dt * 12 * Math.min(1, n.v.length() / 4));
    if (n.fuse <= 0) { W.scene.remove(n.mesh); G.nades.splice(i, 1); explode(n.p.clone(), 1.1, n.by); }
  }
}
function explode(at, power, by) {
  W.fx.boom(at, power); BR3.snd('br-boom', 0.8, 0.9 + rnd() * 0.2, 50);
  const R = 5.4 * power;
  // хто в радіусі — шкода (стіни глушать)
  const al = alive();
  const victims = [];
  for (const f of al) {
    const d = Math.hypot(f.x - at.x, f.z - at.z); if (d > R) continue;
    const shield = rayHit(at.x, at.y + 0.4, at.z, f.x, f.y + 1.0, f.z, true) ? 0.3 : 1;
    victims.push({ f, dmg: 72 * Math.pow(1 - d / R, 0.8) * shield, d });
  }
  victims.sort((a, b) => a.dmg - b.dmg);
  for (const v of victims) {
    const f = v.f; if (!f.alive) continue;
    const rest = alive().filter(o => o !== f); if (!rest.length) break;
    f.hp -= v.dmg; if (by && by !== f) by.dmg += v.dmg;
    if (f.hp <= 0) {
      const dir = new THREE.Vector3(f.x - at.x, 0, f.z - at.z); const L = dir.length() || 1; dir.multiplyScalar(1 / L);
      kill(f, by, 'boom', null, dir.multiplyScalar(Math.max(8, 26 - L * 3)).setY(12 + rnd() * 6));
    }
  }
  // ragdoll'и й уламки відкидає
  for (const f of G.fighters) if (!f.alive && f.diedT < G.t) {
    const d = Math.hypot(f.x - at.x, f.z - at.z);
    if (d < R * 1.4) { const k = 1 - d / (R * 1.4), L = d || 1; f.vx += (f.x - at.x) / L * 16 * k; f.vz += (f.z - at.z) / L * 16 * k; f.vy = Math.max(f.vy || 0, 10 * k); f.air = true; }
  }
  for (const d of W.planks.list) { const dd = d.p.distanceTo(at); if (dd < R * 1.3) { d.rest = 0; d.v.add(d.p.clone().sub(at).normalize().multiplyScalar(14 * (1 - dd / (R * 1.3)))).y += 6; } }
  // ящики й бочки поруч
  for (const b of G.boxes) {
    if (b.dead) continue;
    const d = Math.hypot(b.x - at.x, b.z - at.z);
    if (b.t === 'crate' && d < 3.4 * power) breakCrate(b, new THREE.Vector3(b.x - at.x, 0.5, b.z - at.z).normalize());
    if (b.t === 'barrel' && d < 3.2 * power) setTimeout(() => { if (G && !b.dead) explodeBarrel(b, by); }, 140 + rnd() * 120);
  }
}
function explodeBarrel(b, by) {
  if (b.dead) return;
  b.dead = true; setInstVisible(W.barrelInst, b.id, false);
  buildNav();
  explode(new THREE.Vector3(b.x, ground(b.x, b.z) + 0.6, b.z), 1.35, by);
}
function breakCrate(b, dir) {
  if (b.dead) return;
  b.dead = true; setInstVisible(W.crateInst, b.id, false);
  buildNav();
  BR3.snd('br-crate', 0.55, 0.9 + rnd() * 0.2, 80);
  const base = new THREE.Vector3(b.x, ground(b.x, b.z) + 0.65, b.z);
  for (let i = 0; i < 9; i++) {
    const p = base.clone().add(new THREE.Vector3((rnd() - 0.5) * 1.1, (rnd() - 0.2) * 1.0, (rnd() - 0.5) * 1.1));
    const v = (dir ? dir.clone().multiplyScalar(4 + rnd() * 4) : V3()).add(new THREE.Vector3((rnd() - 0.5) * 6, 3 + rnd() * 5, (rnd() - 0.5) * 6));
    const lng = rnd() < 0.5;
    W.planks.spawn(p, v, new THREE.Vector3(lng ? 1.25 : 0.5, 0.1, lng ? 0.22 : 0.5), null);
  }
  W.fx.hit(base, new THREE.Vector3(0, 1, 0)); W.fx.dust(new THREE.Vector3(b.x, base.y - 0.6, b.z), 0.6);
}

// ── фінал бою ──
function finishFight() {
  const al = alive();
  const w = al[0] || null;
  G.winner = w;
  G.phase = 'outro'; G.outroT = 0;
  if (!G.killcam) { G.slow = 1; }
}
function outro(dt) {
  G.outroT += dt / Math.max(0.2, G.slow);
  const w = G.winner;
  if (!w) return;
  if (G.slowT <= 0 && !G.celebrated) {
    G.celebrated = true;
    w.mode = 'win'; w.aim = 0; w.crown = true; w.target = null;
    W.fx.confetti(new THREE.Vector3(w.x, w.y + 5, w.z), 160, 10);
    BR3.snd('br-win', 0.85);
    $('so-winner-name').textContent = w.nick;
    $('so-winner-stats').innerHTML = '<div><b>' + w.kills + '</b><span>киллов</span></div><div><b>' + Math.max(1, Math.round(w.hp)) + '</b><span>HP осталось</span></div><div><b>' + Math.round(w.dmg) + '</b><span>урона</span></div><div><b>' + G.fighters.length + '</b><span>бойцов</span></div>';
    $('so-winner').style.setProperty('--pc', BR3.cssOf(w.nick)); $('sf-win-av').innerHTML = avatarHtml(w.nick);
    setTimeout(() => { if (G && G.winner === w) $('so-winner').classList.add('show'); }, 900);
    // переможця записуємо одразу (лобі оновить свій стан)
    const cb = G.onWinner; G.onWinner = null;
    if (cb) { try { cb({ nick: w.nick, col: w.src.col, row: w.src.row }); } catch (e) { console.warn(e); } }
  }
  if (G.celebrated) {
    w.mode = 'win';
    w.yaw += angD(Math.atan2(W.camera.position.x - w.x, W.camera.position.z - w.z), w.yaw) * Math.min(1, dt * 3);   // обличчям до камери
    if (G.outroT > 2 && Math.floor(G.outroT * 0.5) !== Math.floor((G.outroT - dt) * 0.5)) W.fx.confetti(new THREE.Vector3(w.x, w.y + 6, w.z), 60, 12);
    W.spot.intensity += (2.6 - W.spot.intensity) * Math.min(1, dt * 2);
    W.spot.position.set(w.x, w.y + 16, w.z + 3); W.spot.target.position.set(w.x, w.y, w.z);
  }
}

// ── камера-режисер: MOBA-кут зверху (як у лобі); кіно-ракурси — лише на останньому вбивстві й переможці ──
const _cp = new THREE.Vector3(), _cl = new THREE.Vector3();
const PITCH = 0.98;
function mobaPose(x, z, D, pos, look) { look.set(x, ground(x, z) + 1, z); pos.set(x, look.y + Math.sin(PITCH) * D, z + Math.cos(PITCH) * D); }
function camera(rdt, dt) {
  const C = G.cam, cam = W.camera;
  const al = alive();
  let pos = _cp, look = _cl, low = false;
  if (G.phase === 'intro' || G.phase === 'count') {
    mobaPose(CX, CZ + 1, 40, pos, look);
  } else if (G.killcam && G.slowT > 0) {
    const K = G.killcam, c = V3().set(K.victim.x, K.victim.y + 0.8, K.victim.z);
    K.t += rdt; const a = K.t * 0.9 + 0.4;
    pos.set(c.x + Math.sin(a) * 6, c.y + 5, c.z + Math.cos(a) * 6); look.copy(c); low = true;
  } else if (G.phase === 'outro' && G.winner) {
    const w = G.winner, a = G.outroT * 0.3;
    pos.set(w.x + Math.sin(a) * 6.5, w.y + 11.5, w.z + Math.cos(a) * 6.5); look.set(w.x, w.y + 0.7, w.z); low = true;   // на острові навколо скелі й будинки — тримаємось вище
  } else if (C.mode === 'overview') {
    mobaPose(CX, CZ + 1, 52, pos, look);
  } else {
    // автовибір: де найгарячіше; камера — над бійцем, трохи на ціль
    C.sw -= rdt;
    if (!C.manual && (C.sw <= 0 || !C.focus || !C.focus.alive)) {
      let best = null, bs = -1;
      for (const f of al) { let s = f.heat * 2 + f.kills + (f.visible ? 2 : 0) + (G.t - (f.hitT || -9) < 2 ? 3 : 0); if (f === C.focus && f.alive) s *= 1.3; if (s > bs) { bs = s; best = f; } }
      C.sw = best !== C.focus ? 4.5 : 1.5;
      C.focus = best || al[0];
    }
    const f = C.focus && (C.focus.alive || C.manual) ? C.focus : al[0];
    if (al.length === 2 && !C.manual) {
      const [a, b] = al, L = Math.hypot(b.x - a.x, b.z - a.z);
      mobaPose((a.x + b.x) / 2, (a.z + b.z) / 2, clamp(L * 1.1 + 14, 20, 46), pos, look);
    } else if (f) {
      let tx = f.x, tz = f.z, D = 24;
      if (f.target && f.target.alive) { tx = (f.x * 2 + f.target.x) / 3; tz = (f.z * 2 + f.target.z) / 3; D = clamp(Math.hypot(f.target.x - f.x, f.target.z - f.z) * 0.9 + 16, 22, 40); }
      mobaPose(tx, tz, D, pos, look);
    }
  }
  if (low) { camSafe(pos, look); propSafe(pos, look); }
  if (!C.ready) { C.pos.copy(pos); C.look.copy(look); C.ready = true; }
  const k = Math.min(1, rdt * (G.killcam && G.slowT > 0 ? 6 : G.phase === 'intro' ? 1.8 : 2.4));
  C.pos.lerp(pos, k); C.look.lerp(look, k);
  cam.position.copy(C.pos);
  const sh = W.fx.shake; if (sh > 0) cam.position.add(new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh).multiplyScalar(0.6));
  cam.lookAt(C.look);
}

// кіно-ракурси: якщо між камерою й ціллю модель острова (скеля, будинок, крона) — піднімаємо камеру, поки не стане видно
const _ray = new THREE.Raycaster(), _rd = new THREE.Vector3();
function propSafe(p, look) {
  if (!RV.props || !RV.props.length) return;
  for (let k = 0; k < 6; k++) {
    _rd.subVectors(p, look); const L = _rd.length(); _rd.multiplyScalar(1 / L);
    _ray.set(look, _rd); _ray.far = L; _ray.near = 0.6;
    const hit = _ray.intersectObjects(RV.props, false);
    if (!hit.length) return;
    // вище й ближче: кут стає крутішим, і перешкода лишається збоку
    const hx = p.x - look.x, hz = p.z - look.z;
    p.x = look.x + hx * 0.72; p.z = look.z + hz * 0.72; p.y += 3.2;
  }
}
function camSafe(p, look) {
  // між камерою й ціллю стіна/контейнер — піднімаємо камеру над нею
  for (let k = 0; k < 3; k++) {
    const blk = rayHit(p.x, p.y, p.z, look.x, look.y + 0.6, look.z);
    if (!blk || blk.b.t === 'low' || blk.b.t === 'barrel') break;
    p.y = Math.max(p.y + 0.5, blk.b.h + 2.6);
  }
  for (const b of G.boxes) {
    if (b.dead || b.deco) continue;
    if (Math.abs(p.x - b.x) < b.w / 2 + 0.6 && Math.abs(p.z - b.z) < b.d / 2 + 0.6 && p.y < b.h + 0.8) p.y = b.h + 0.9;
  }
  p.x = clamp(p.x, CX - 45, CX + 45); p.z = clamp(p.z, CZ - 45, CZ + 45);
  p.y = Math.max(p.y, ground(p.x, p.z) + 1.2);
}

// ── HUD ──
function initials(n) { const m = String(n).replace(/[^A-Za-zА-Яа-яІіЇїЄєҐґ0-9]/g, ''); return (m[0] || '?').toUpperCase() + (m[1] || '').toLowerCase(); }
function hud() {
  const al = alive();
  $('so-alive').textContent = al.length;
  // кільце зони: скільки лишилось до наступного стискання
  const zt = $('so-zone-timer'), zl = $('so-zone-lbl'), ring = $('sf-zone-ring'), C = 2 * Math.PI * 18;
  let frac = 0;
  if (G.phase !== 'fight') { zt.textContent = G.phase === 'outro' ? '★' : '—'; zl.textContent = G.phase === 'outro' ? 'финиш' : 'зона'; }
  else if (G.zone && G.zone.anim) { zt.textContent = '!'; zl.textContent = 'сжимается'; frac = 1; }
  else { const left = Math.max(0, G.zoneNext - G.fightT); zt.textContent = Math.ceil(left); zl.textContent = G.zone ? 'до сжатия' : 'до зоны'; frac = 1 - left / (G.zone ? 15 : 14); }
  ring.style.strokeDashoffset = (C * (1 - clamp(frac, 0, 1))).toFixed(1);
  ring.classList.toggle('hot', !!(G.zone && G.zone.anim));
  // рядок портретів (оновлюємо 4 рази на секунду)
  G.rosterT -= 1 / 60;
  if (G.rosterT <= 0) { G.rosterT = 0.25; renderRoster(); }
  // картка бійця в кадрі
  const f = G.cam.focus, fc = $('so-focus');
  if (f && G.phase !== 'outro') {
    fc.classList.add('show'); fc.classList.toggle('dead', !f.alive);
    if (fc._nick !== f.nick) { fc._nick = f.nick; $('sf-hero-nick').textContent = f.nick; $('sf-hero-av').innerHTML = avatarHtml(f.nick); $('sf-hero-av').style.setProperty('--pc', BR3.cssOf(f.nick)); }
    const hp = Math.max(0, Math.round(f.hp));
    const hb = $('sf-hero-hp'); hb.style.width = hp + '%'; hb.className = hp > 50 ? '' : hp > 25 ? 'mid' : 'low';
    const g = $('sf-hero-hpg'); const gw = parseFloat(g.style.width) || 100; g.style.width = Math.max(hp, gw - 0.6) + '%';   // «тінь» втраченого HP повільно наздоганяє
    $('sf-hero-hptxt').textContent = f.alive ? hp + ' / 100' : 'ВЫБЫЛ';
    $('sf-hero-k').textContent = f.kills; $('sf-hero-d').textContent = Math.round(f.dmg);
  } else fc.classList.remove('show');
  $('so-cam-name').textContent = G.cam.mode === 'overview' ? 'поле боя' : (f ? f.nick : '—');
  $('so-auto-btn').classList.toggle('on', !G.cam.manual && G.cam.mode !== 'overview');
  $('so-overview-btn').classList.toggle('on', G.cam.mode === 'overview');
  $('so-speed-btn').classList.toggle('on', G.speed > 1);
}
// аватарка з Kick (/api/avatar/нік); поки вантажиться або її нема — буква на кольоровому тлі
function avatarHtml(nick) {
  return '<span class="sf-av-l">' + esc(initials(nick)) + '</span><img alt="" loading="lazy" src="/api/avatar/' + encodeURIComponent(nick) + '" onload="if(this.naturalWidth)this.classList.add(\'ok\')" onerror="this.remove()">';
}
function renderRoster() {
  // аватарки будуються один раз на бій (без повторних запитів), далі лише оновлюються HP/кіли/порядок
  if (!G.rosterEls) {
    G.rosterEls = G.fighters.map((f, i) => {
      const el = document.createElement('div'); el.className = 'sf-pt'; el.dataset.i = i; el.title = f.nick;
      el.style.setProperty('--pc', f.css || (f.css = BR3.cssOf(f.nick)));
      el.innerHTML = '<div class="sf-pt-av">' + avatarHtml(f.nick) + '</div><em></em><i><b></b></i>';
      return el;
    });
    const L = $('sf-roster-l'), R = $('sf-roster-r'); L.innerHTML = ''; R.innerHTML = '';
    G.rosterMore = document.createElement('div'); G.rosterMore.className = 'sf-pt sf-more';
  }
  // живі — спереду (за кілами), мертві — сірі; до 10 аватарок з кожного боку, решта — «+N»
  const list = G.fighters.map((f, i) => ({ f, i })).sort((a, b) => (b.f.alive - a.f.alive) || (b.f.kills - a.f.kills) || (a.i - b.i));
  const MAX = 10, half = Math.min(MAX, Math.ceil(list.length / 2));
  const L = $('sf-roster-l'), R = $('sf-roster-r');
  list.forEach(({ f, i }, k) => {
    const el = G.rosterEls[i], box = k < half ? L : (k < half + MAX ? R : null);
    if (!box) { if (el.parentNode) el.parentNode.removeChild(el); return; }
    if (el.parentNode !== box) box.appendChild(el);
    el.style.order = k;
    el.classList.toggle('dead', !f.alive); el.classList.toggle('foc', f === G.cam.focus);
    el.querySelector('b').style.width = (clamp(f.hp / 100, 0, 1) * 100).toFixed(0) + '%';
    const em = el.querySelector('em'); em.textContent = f.kills || ''; em.style.display = f.kills ? '' : 'none';
  });
  const rest = list.length - Math.min(list.length, half + MAX);
  if (rest > 0) { G.rosterMore.textContent = '+' + rest; G.rosterMore.style.order = 999; if (G.rosterMore.parentNode !== R) R.appendChild(G.rosterMore); }
  else if (G.rosterMore.parentNode) G.rosterMore.parentNode.removeChild(G.rosterMore);
}
// великі анонси подій по центру
function announce(kicker, name, tone) {
  const a = $('sf-announce'); if (!a) return;
  $('sf-ann-k').textContent = kicker; $('sf-ann-n').textContent = name || '';
  a.className = 'sf-announce ' + (tone || ''); void a.offsetWidth; a.classList.add('show');
  clearTimeout(a._t); a._t = setTimeout(() => a.classList.remove('show'), 2200);
}
function addFeed(by, T, kind) {
  const ico = kind === 'boom' ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="6"/><path d="M15 7l3-3M17 4h3v3"/></svg>' : kind === 'zone' ? '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>' : kind === 'head' ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M3 10h13l3-2h2v4h-3l-2 2H9l-1 4H5l1-4H3z"/></svg>';
  G.feed.unshift({ a: by && by !== T ? by.nick : null, b: T.nick, ico, kind, t: performance.now(), id: (G.feedId = (G.feedId || 0) + 1) });
  G.feed = G.feed.slice(0, 6);
  renderFeed();
  // анонси: перша кров, серії, дуель
  const left = alive().length;
  if (!G.firstBlood && by && by !== T) { G.firstBlood = true; announce('ПЕРВАЯ КРОВЬ', by.nick, 'red'); }
  else if (by && by !== T) {
    by.streak = (G.t - (by.lastKillT || -99) < 4.5) ? (by.streak || 1) + 1 : 1; by.lastKillT = G.t;
    if (by.streak === 2) announce('ДВОЙНОЕ УБИЙСТВО', by.nick, 'gold');
    else if (by.streak === 3) announce('ТРОЙНОЕ УБИЙСТВО', by.nick, 'gold');
    else if (by.streak >= 4) announce('НЕУДЕРЖИМ', by.nick, 'purple');
    else if (kind === 'head' && left > 2) announce('В ГОЛОВУ', by.nick + ' → ' + T.nick, 'white');
  }
  if (left === 2) { const [a, b] = alive(); setTimeout(() => { if (G && alive().length === 2) announce('ДУЭЛЬ', a.nick + '  vs  ' + b.nick, 'white'); }, 700); }
}
function renderFeed() {
  const el = $('so-killfeed'); if (!el) return;
  el.innerHTML = (G ? G.feed : []).map((x, k) => '<div class="sf-kf' + (k === 0 && performance.now() - x.t < 400 ? ' new' : '') + '" style="opacity:' + (1 - k * 0.12).toFixed(2) + '">' +
    (x.a ? '<b style="--pc:' + BR3.cssOf(x.a) + '">' + esc(x.a) + '</b>' : '<b class="sf-kf-env">' + (x.kind === 'zone' ? 'зона' : 'взрыв') + '</b>') +
    '<i class="sf-kf-' + (x.kind || 'rifle') + '">' + x.ico + '</i><span>' + esc(x.b) + '</span></div>').join('');
}
const _lp = { x: 0, y: 0, z: 0 }, _lv = new THREE.Vector3();
function drawLabels() {
  const Lb = W.labels, c = Lb.begin(); if (!G) return;
  const items = [];
  for (const f of G.fighters) {
    if (!f.alive) {
      const age = G.t - (f.diedT || 0); if (age > 2.5) continue;
      if (Lb.project(W.camera, _lv.set(f.x, f.y + 2.0, f.z), _lp)) items.push({ x: _lp.x, y: _lp.y - age * 12, z: _lp.z, f, dead: 1, a: 1 - age / 2.5 });
      continue;
    }
    if (G.phase === 'outro') continue;
    if (Lb.project(W.camera, _lv.set(f.x, f.y + 2.55 * S_SOLD, f.z), _lp)) items.push({ x: _lp.x, y: _lp.y, z: _lp.z, f });
  }
  items.sort((a, b) => b.z - a.z);
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  for (const it of items) {
    const f = it.f, foc = f === G.cam.focus;
    c.globalAlpha = it.a == null ? 1 : it.a;
    c.font = '800 ' + (foc ? 14 : 12) + 'px Manrope, system-ui, sans-serif';
    c.lineWidth = 3.5; c.strokeStyle = 'rgba(8,10,16,0.9)';
    const txt = it.dead ? '✕ ' + f.nick : f.nick;
    c.strokeText(txt, it.x, it.y - 10); c.fillStyle = it.dead ? '#ff8a8a' : (foc ? '#ffe27a' : '#fff'); c.fillText(txt, it.x, it.y - 10);
    if (!it.dead) {
      const hp = clamp(f.hp / 100, 0, 1), Wb = foc ? 66 : 56, Hb = 6, x0 = it.x - Wb / 2, y0 = it.y;
      c.fillStyle = 'rgba(8,10,16,0.9)'; c.fillRect(x0 - 1.5, y0 - 1.5, Wb + 3, Hb + 3);
      c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(x0, y0, Wb, Hb);
      c.fillStyle = hp > 0.5 ? '#5ee05a' : hp > 0.25 ? '#ffd23f' : '#ff4b4b'; c.fillRect(x0, y0, Wb * hp, Hb);
      c.fillStyle = 'rgba(0,0,0,0.5)'; for (let k = 1; k < 5; k++) c.fillRect(x0 + Wb * k / 5 - 0.5, y0, 1, Hb);
      c.fillStyle = f.css || (f.css = BR3.cssOf(f.nick)); c.fillRect(x0, y0 + Hb + 1.5, Wb, 2);
    }
  }
  c.globalAlpha = 1;
}

// ── керування камерою ──
function focusNext(dir) {
  if (!G) return;
  const al = alive(); if (!al.length) return;
  let i = al.indexOf(G.cam.focus); i = (i + (dir || 1) + al.length) % al.length;
  G.cam.focus = al[i]; G.cam.manual = true; G.cam.mode = 'follow';
}
function toggleOverview() { if (!G) return; G.cam.mode = G.cam.mode === 'overview' ? 'follow' : 'overview'; }
function toggleFly() { if (!G) return; G.cam.manual = false; G.cam.mode = 'follow'; G.cam.sw = 0; }

function stop() {
  const root = $('royale-shootout');
  if (root) root.classList.remove('visible', 'sf-island');
  const lobby = document.getElementById('royale-overlay'); if (lobby) lobby.classList.remove('rl-final-on');
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  const w = G && G.winner;
  if (W && G) {
    // прибрати фінал зі спільної сцени
    if (G.nades) G.nades.forEach(n => W.scene.remove(n.mesh));
    G.fighters.forEach(removeSoldier);
    dropInst(W.crateInst); dropInst(W.barrelInst); W.crateInst = []; W.barrelInst = [];
    W.fx.clear(); W.planks.clear(); W.rings.count = 0; W.wall.visible = false; W.spot.intensity = 0;
    if (W.labels) W.labels.begin();
  }
  lobbyHide(false);
  // переможець у лобі стоїть там, де виграв
  if (w && typeof RV !== 'undefined' && RV.vis) { const v = RV.vis.get(w.nick); if (v) { v.x = v.tx = w.x; v.z = v.tz = w.z; v.y = rlStand(w.x, w.z); } }
  if (G && G.onWinner && !G.winner) { const cb = G.onWinner; G.onWinner = null; G = null; try { cb(null); } catch (e) {} return; }
  G = null;
}

window.RSO = { start, stop, focusNext, toggleOverview, toggleFly };
})();
