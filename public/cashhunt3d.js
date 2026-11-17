/* ══════════════════════════════════════════════════════════════
   Cash Hunt у 3D — «ярмарковий тир» (модель: blender/cashhunt.blend → models/cashhunt/cashhunt.glb).
   Логіка та сама, що в app.js: сервер розкладає учасників по клітинках (з доказом random.org),
   стрімер обирає клітинку, гармата стріляє, решта відкривається, обрана — переможець.
   Тут лише показ: плитки-кубики з ніками ззаду й 3D-мішенями спереду, хвиля перевертання,
   колонки-барабани, вибір кліком прямо в 3D (гармата водить стволом за курсором), постріл
   ядром, плитка розлітається з конфеті, переможець — золота табличка вилітає вперед.
   Без WebGL або моделі — працює стара 2D-версія.
   ══════════════════════════════════════════════════════════════ */
(function () {
  const GLB = '/assets/models/cashhunt/cashhunt.glb';
  const BOARD = { x0: -12.6, x1: 12.6, y0: 0.7, y1: 15.1, z: 0.35 };   // зона плиток у площині отвору будки
  const CAM = { pos: [0, 6, 30], look: [0, 6.4, 0] };   // табло — на всю висоту, ствол — під ним
  const BARREL = [0, 1.6, 13.5];                           // ствол висить у повітрі перед прилавком
  const PENGUIN = { url: '/assets/models/cashhunt/penguin.glb', scale: 1.55, pos: [14.3, -0.25, 3.4], yaw: -0.35 };
  const SIGN_Y = 19.3;                                    // вище — вивіска, її не показуємо
  const ICONS = ['TGT_can', 'TGT_duck', 'TGT_star', 'TGT_apple', 'TGT_bottle', 'TGT_balloon', 'TGT_horseshoe', 'TGT_diamond'];
  const orig = { renderGame: window.renderGame, startReveal: window.startReveal, close: window.closeCashhuntOverlay };
  let glbP = null, R = null, token = 0;

  const loadGLB = () => glbP || (glbP = new Promise((ok, no) => new THREE.GLTFLoader().load(GLB, g => ok(g.scene), undefined, no)));
  const ease = { out: t => 1 - Math.pow(1 - t, 3), inOut: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    back: t => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); } };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function tween(ms, fn, ez) { return new Promise(res => R.tweens.push({ t0: performance.now(), ms, fn, ez: ez || ease.out, res })); }

  // ── звуки тиру (ElevenLabs → sfx/ch-*.mp3): клон на кожне відтворення, щоб накладались;
  // rate міняє й висоту — легкий розкид, аби повтори не звучали як копія ──
  const SND = {};
  for (const n of ['flip', 'reel', 'stop', 'aim', 'fire', 'hit', 'cascade']) { const a = new Audio('/assets/sfx/ch-' + n + '.mp3'); a.preload = 'auto'; SND[n] = a; }
  function snd(name, vol, rate) {
    const b = SND[name]; if (!b) return null;
    const a = b.cloneNode(); a.volume = Math.min(1, vol == null ? 0.8 : vol);
    if (rate) { a.preservesPitch = false; a.mozPreservesPitch = false; a.webkitPreservesPitch = false; a.playbackRate = rate; }
    a.play().catch(() => {}); return a;
  }
  function fadeOut(a, ms) {
    if (!a) return; const v0 = a.volume, t0 = performance.now();
    const iv = setInterval(() => { const k = 1 - (performance.now() - t0) / ms; if (k <= 0) { clearInterval(iv); a.pause(); } else a.volume = v0 * k; }, 20);
  }
  const jit = (base, spread) => base + (Math.random() - 0.5) * spread;

  // ── сцена ──
  async function ensureScene(host) {
    if (R) { if (R.canvas.parentNode !== host) host.appendChild(R.canvas); return R; }
    const src = await loadGLB();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.25;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = renderer.domElement; canvas.className = 'ch3d-canvas'; host.appendChild(canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.5, 300);
    // оточення для металу (латунь гармати, золото рамок)
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(60, 24, 12), new THREE.MeshBasicMaterial({ color: '#0b0a10', side: THREE.BackSide })));
    for (const [c, x, y, z, w, h] of [['#fff1d0', 0, 40, 10, 60, 14], ['#ffd27a', -40, 10, 20, 20, 30], ['#ff6a6a', 40, 6, 20, 18, 20]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    }
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(env, 0.04).texture;
    scene.add(new THREE.HemisphereLight('#fff3e0', '#2a1a14', 0.55));
    const key = new THREE.SpotLight('#fff1d8', 2.2, 120, 0.7, 0.55, 1.2); key.position.set(-8, 30, 34); key.target.position.set(0, 6, 0);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0005; scene.add(key, key.target);
    const fill = new THREE.PointLight('#ffb36b', 0.7, 80, 2); fill.position.set(14, 4, 20); scene.add(fill);
    const root = src.clone(true); scene.add(root);
    // вивіску CASH HUNT над тентом прибираємо: у моделі вона злита з будкою, тож
    // викидаємо трикутники будки, що повністю вище тенту (y > SIGN_Y у світі)
    root.updateMatrixWorld(true);
    const booth = root.getObjectByName('CH_BOOTH');
    if (booth) booth.traverse(o => {
      if (!o.isMesh || !o.geometry.index) return;
      const g = o.geometry.clone(), pos = g.attributes.position, idx = g.index.array, keep = [], v = new THREE.Vector3();
      const wy = i => v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).y;
      for (let t = 0; t < idx.length; t += 3) if (Math.min(wy(idx[t]), wy(idx[t + 1]), wy(idx[t + 2])) < SIGN_Y) keep.push(idx[t], idx[t + 1], idx[t + 2]);
      g.setIndex(keep); o.geometry = g;
    });
    // залишки ведмедиків (мордочка, носик — злиті з будкою іншими матеріалами): дрібні трикутники в їхніх «коробках»
    if (booth) booth.traverse(o => {
      if (!o.isMesh || !o.geometry.index) return;
      const g = o.geometry, pos = g.attributes.position, idx = g.index.array, keep = [], v = new THREE.Vector3();
      const inTeddy = i => { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); const ax = Math.abs(v.x); return ax > 13.0 && ax < 15.7 && v.y > -0.35 && v.y < 2.7 && v.z > 2.0 && v.z < 4.0; };
      let cut = 0;
      for (let t = 0; t < idx.length; t += 3) { if (inTeddy(idx[t]) && inTeddy(idx[t + 1]) && inTeddy(idx[t + 2])) { cut++; continue; } keep.push(idx[t], idx[t + 1], idx[t + 2]); }
      if (cut) g.setIndex(keep);
    });
    const nodes = {}; root.traverse(o => { if (o.name && !nodes[o.name]) nodes[o.name] = o; if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const icons = {}; for (const k of ICONS) if (nodes[k]) { icons[k] = nodes[k]; nodes[k].visible = false; }
    // повністю металеві мішені (золоті зірка й підкова, бляшанка) у темному оточенні виходили чорними —
    // робимо їх «фарбованим металом»: менше дзеркальності, трохи власного світіння кольором
    for (const k in icons) icons[k].traverse(o => {
      if (!o.isMesh || o.material.metalness < 0.5) return;
      const m = o.material.clone(); m.metalness = 0.3; m.roughness = Math.max(0.35, m.roughness);
      m.emissive = m.color.clone().multiplyScalar(0.35); o.material = m;
    });
    // ведмедиків прибрано (їх місце займає пінгвін), лафет гармати теж — ствол висить у повітрі
    root.traverse(o => { if (o.isMesh && o.material && o.material.name === 'C_Teddy') o.visible = false; });
    if (nodes.CH_CANNON) nodes.CH_CANNON.visible = false;
    if (nodes.CH_BARREL) nodes.CH_BARREL.position.set(BARREL[0], BARREL[1], BARREL[2]);
    const pad = new THREE.Sprite(new THREE.SpriteMaterial({ map: (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 2, 64, 64, 62); gr.addColorStop(0, 'rgba(255,214,120,.55)'); gr.addColorStop(1, 'rgba(255,170,60,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    pad.scale.set(6, 6, 1); pad.position.set(BARREL[0], BARREL[1], BARREL[2] - 0.5); scene.add(pad);
    loadPenguin(scene);
    // лампочки: два матеріали блимають по черзі
    const bulbMats = { A: [], B: [] };
    // лампочки: тепле скло, що світиться (без тонмапінгу — не вигоряє в біле), + м'яке сяйво-спрайт навколо кожної
    bulbMats.gA = []; bulbMats.gB = [];
    const haloTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 1, 32, 32, 31); gr.addColorStop(0, 'rgba(255,236,170,1)'); gr.addColorStop(0.25, 'rgba(255,200,90,.55)'); gr.addColorStop(1, 'rgba(255,150,40,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    if (nodes.CH_BULBS) nodes.CH_BULBS.traverse(o => {
      if (!o.isMesh) return;
      const n = o.material.name; if (n !== 'Bulb_A' && n !== 'Bulb_B') return;
      const k = n.slice(-1);
      o.material = new THREE.MeshBasicMaterial({ color: '#ffd77a', toneMapped: false });
      bulbMats[k].push(o.material); o.castShadow = false; o.receiveShadow = false;
      // центри окремих лампочок: групуємо вершини злитого меша
      const pos = o.geometry.attributes.position, v = new THREE.Vector3(), cl = [];
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        let c = cl.find(q => q.c.distanceToSquared(v) < 0.36);
        if (!c) { c = { c: v.clone(), s: new THREE.Vector3(), n: 0 }; cl.push(c); }
        c.s.add(v); c.n++; c.c.copy(c.s).divideScalar(c.n);
      }
      for (const c of cl) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: '#ffd27a', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
        sp.position.copy(c.c); sp.position.z += 0.3; sp.scale.setScalar(1.7); scene.add(sp);
        bulbMats['g' + k].push(sp.material);
      }
    });
    // ствол: тримаємо базову орієнтацію, цілимось кватерніоном
    const barrel = nodes.CH_BARREL; const barrelQ0 = barrel ? barrel.quaternion.clone() : null;
    // ефекти: спалах, дим, ядро, уламки, конфеті, кільце вибору
    const radial = (stops) => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62); stops.forEach(([o, col]) => gr.addColorStop(o, col)); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); };
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: radial([[0, 'rgba(255,255,235,1)'], [0.3, 'rgba(255,200,80,.9)'], [1, 'rgba(255,90,0,0)']]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    flash.scale.set(4, 4, 1); scene.add(flash);
    const smokeTex = radial([[0, 'rgba(220,215,210,.55)'], [1, 'rgba(220,215,210,0)']]);
    const smokes = []; for (let i = 0; i < 8; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0 })); s.visible = false; scene.add(s); smokes.push(s); }
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), new THREE.MeshStandardMaterial({ color: '#1d1f24', metalness: 0.7, roughness: 0.35 })); ball.visible = false; ball.castShadow = true; scene.add(ball);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.07, 10, 48), new THREE.MeshBasicMaterial({ color: '#ff3b3b', toneMapped: false })); ring.visible = false; scene.add(ring);
    const hover = new THREE.Mesh(new THREE.TorusGeometry(1, 0.045, 8, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, toneMapped: false })); hover.visible = false; scene.add(hover);
    const hitL = new THREE.PointLight('#ffcf6b', 0, 30, 2); scene.add(hitL);
    R = { renderer, canvas, scene, camera, root, nodes, icons, barrel, barrelQ0, bulbMats, flash, smokes, ball, ring, hover, hitL,
      tiles: [], parts: [], tweens: [], raf: 0, shake: 0, fast: false, aimAt: null, aimQ: new THREE.Quaternion(), host, ray: new THREE.Raycaster(), mouse: new THREE.Vector2(), hovered: -1 };
    if (barrel && barrelQ0) R.aimQ.copy(barrelQ0);
    bindPointer();
    resize(); window.addEventListener('resize', resize);
    return R;
  }
  // пінгвін у темних окулярах із газетою (blender/cashhunt.blend, колекція PENGUIN) — стоїть на прилавку праворуч
  function loadPenguin(scene) {
    new THREE.GLTFLoader().load(PENGUIN.url, g => {
      const p = g.scene;
      p.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        if (o.material.name === 'PG_Paper') { o.material = o.material.clone(); o.material.map = paperTex(); o.material.color.set('#ffffff'); }
      });
      p.scale.setScalar(PENGUIN.scale); p.position.set(PENGUIN.pos[0], PENGUIN.pos[1], PENGUIN.pos[2]); p.rotation.y = PENGUIN.yaw;
      scene.add(p); if (R) R.penguin = p;
    }, undefined, () => {});
  }
  function paperTex() {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 700; const x = c.getContext('2d');
    x.fillStyle = '#f1eee4'; x.fillRect(0, 0, 1024, 700);
    for (const half of [0, 512]) {
      x.fillStyle = '#1b1b1b'; x.font = '900 64px Georgia, serif'; x.textAlign = 'center';
      x.fillText(half ? 'CASH HUNT' : 'KICK NEWS', half + 256, 92);
      x.fillRect(half + 40, 112, 432, 5);
      x.font = '700 26px Georgia, serif'; x.fillText(half ? 'Кто заберёт приз?' : 'Розыгрыш сегодня!', half + 256, 152);
      for (let r = 0; r < 14; r++) for (let col = 0; col < 2; col++) {
        const w = 190 - (r % 3) * 26; x.fillStyle = 'rgba(30,30,30,.55)'; x.fillRect(half + 46 + col * 222, 190 + r * 33, w, 9);
      }
      if (half) { x.fillStyle = '#d6343a'; x.fillRect(half + 300, 190, 150, 120); x.fillStyle = '#ffd27a'; x.font = '900 60px Georgia, serif'; x.fillText('$', half + 375, 270); }
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }
  function resize() {
    if (!R) return;
    const w = R.host.clientWidth || 1200, h = R.host.clientHeight || 680;
    R.renderer.setSize(w, h, false); R.canvas.style.width = w + 'px'; R.canvas.style.height = h + 'px';
    R.camera.aspect = w / h; R.camera.fov = w / h < 1.5 ? 44 : 36; R.camera.updateProjectionMatrix();
  }

  // ── плитки: розкладка під кількість учасників, атлас ніків, 3D-мішені ──
  function nameAtlas(names) {
    const n = names.length, g = Math.ceil(Math.sqrt(n)), S = 2048, cs = Math.floor(S / g);
    const c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d');
    for (let i = 0; i < n; i++) {
      const cx = (i % g) * cs, cy = Math.floor(i / g) * cs;
      const gr = x.createLinearGradient(0, cy, 0, cy + cs); gr.addColorStop(0, '#fbf2dc'); gr.addColorStop(1, '#ecd9b2');
      x.fillStyle = gr; x.fillRect(cx, cy, cs, cs);
      x.strokeStyle = '#c99a3a'; x.lineWidth = Math.max(2, cs * 0.035); x.strokeRect(cx + cs * 0.03, cy + cs * 0.03, cs * 0.94, cs * 0.94);
      // нік — якомога більшим: у рядок, а довгий — у два рядки (так шрифт лишається читабельним)
      const name = String(names[i]), W = cs * 0.9, font = f => '800 ' + f + 'px Manrope, sans-serif';
      const fit = (s, max) => { let f = max; x.font = font(f); while (x.measureText(s).width > W && f > cs * 0.08) { f *= 0.94; x.font = font(f); } return f; };
      let lines = [name], fs = fit(name, cs * 0.36);
      if (fs < cs * 0.22 && name.length > 7) {
        // розрив — на природній межі поблизу середини (перед цифрами, «_», «-», великою літерою)
        let h = Math.ceil(name.length / 2), bestD = 1e9;
        for (let k = 2; k <= name.length - 2; k++) {
          const a = name[k - 1], b = name[k];
          const nat = (/\D/.test(a) && /\d/.test(b)) || /[_\-.]/.test(a) || (/[a-zа-яії]/.test(a) && /[A-ZА-ЯІЇ]/.test(b));
          const d = Math.abs(k - name.length / 2);
          if (nat && d <= name.length * 0.3 && d < bestD) { bestD = d; h = k; }
        }
        const two = [name.slice(0, h), name.slice(h)];
        const f2 = Math.min(fit(two[0], cs * 0.3), fit(two[1], cs * 0.3));
        if (f2 > fs * 1.15) { lines = two; fs = f2; }
      }
      x.font = font(fs); x.fillStyle = '#2a1a10'; x.textAlign = 'center'; x.textBaseline = 'middle';
      lines.forEach((ln, k) => x.fillText(ln, cx + cs / 2, cy + cs / 2 + (k - (lines.length - 1) / 2) * fs * 1.02, W));
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
    return { tex: t, g };
  }
  // лицьова сторона: пласкі «наліпки» з товстою темною обводкою й чистими кольорами (качка, кактус, яблуко…) —
  // читаються здалеку краще за дрібні 3D-фігурки; кожна плитка — випадкова наліпка на світлому крузі
  const INK = '#2a1a10';
  const ST = {
    duck(x) {
      blob(x, () => { x.ellipse(-0.05, 0.28, 0.62, 0.42, 0, 0, Math.PI * 2); }, '#ffd23f');
      blob(x, () => { x.arc(0.3, -0.22, 0.32, 0, Math.PI * 2); }, '#ffd23f');
      blob(x, () => { x.moveTo(0.58, -0.24); x.quadraticCurveTo(0.95, -0.2, 0.88, -0.06); x.quadraticCurveTo(0.7, 0.0, 0.56, -0.1); }, '#ff8a1f');
      dot(x, 0.36, -0.3, 0.07);
      x.beginPath(); x.moveTo(-0.38, 0.22); x.quadraticCurveTo(-0.05, 0.05, 0.12, 0.3); x.stroke();
    },
    cactus(x) {
      blob(x, () => { rr(x, -0.18, -0.78, 0.36, 1.12, 0.18); }, '#3bb54a');
      blob(x, () => { x.moveTo(-0.18, 0.02); x.lineTo(-0.44, 0.02); x.quadraticCurveTo(-0.6, 0.02, -0.6, -0.14); x.lineTo(-0.6, -0.42); x.quadraticCurveTo(-0.6, -0.56, -0.48, -0.56); x.quadraticCurveTo(-0.36, -0.56, -0.36, -0.42); x.lineTo(-0.36, -0.2); x.lineTo(-0.18, -0.2); }, '#3bb54a');
      blob(x, () => { x.moveTo(0.18, 0.12); x.lineTo(0.44, 0.12); x.quadraticCurveTo(0.6, 0.12, 0.6, -0.04); x.lineTo(0.6, -0.26); x.quadraticCurveTo(0.6, -0.4, 0.48, -0.4); x.quadraticCurveTo(0.36, -0.4, 0.36, -0.26); x.lineTo(0.36, -0.08); x.lineTo(0.18, -0.08); }, '#3bb54a');
      blob(x, () => { x.moveTo(-0.42, 0.34); x.lineTo(0.42, 0.34); x.lineTo(0.32, 0.84); x.lineTo(-0.32, 0.84); x.closePath(); }, '#d9773a');
      x.lineWidth *= 0.6; for (const [px, py] of [[0, -0.5], [0, -0.1], [-0.48, -0.32], [0.48, -0.18]]) { x.beginPath(); x.moveTo(px - 0.05, py); x.lineTo(px + 0.05, py); x.stroke(); }
    },
    apple(x) {
      blob(x, () => { x.moveTo(0, -0.38); x.bezierCurveTo(0.5, -0.66, 0.86, -0.18, 0.66, 0.3); x.bezierCurveTo(0.5, 0.72, 0.18, 0.82, 0, 0.66); x.bezierCurveTo(-0.18, 0.82, -0.5, 0.72, -0.66, 0.3); x.bezierCurveTo(-0.86, -0.18, -0.5, -0.66, 0, -0.38); }, '#e8343e');
      blob(x, () => { x.moveTo(0.04, -0.4); x.quadraticCurveTo(0.42, -0.86, 0.6, -0.62); x.quadraticCurveTo(0.36, -0.36, 0.04, -0.4); }, '#4cc35a');
      x.beginPath(); x.moveTo(0, -0.38); x.lineTo(-0.06, -0.66); x.stroke();
      shine(x, -0.34, -0.06);
    },
    star(x) { blob(x, () => { for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, r = k % 2 ? 0.36 : 0.86; x.lineTo(Math.cos(a) * r, Math.sin(a) * r + 0.06); } }, '#ffc93d'); shine(x, -0.18, -0.12); },
    bottle(x) {
      blob(x, () => { x.moveTo(-0.12, -0.86); x.lineTo(0.12, -0.86); x.lineTo(0.12, -0.42); x.quadraticCurveTo(0.36, -0.3, 0.36, -0.04); x.lineTo(0.36, 0.72); x.quadraticCurveTo(0.36, 0.84, 0.24, 0.84); x.lineTo(-0.24, 0.84); x.quadraticCurveTo(-0.36, 0.84, -0.36, 0.72); x.lineTo(-0.36, -0.04); x.quadraticCurveTo(-0.36, -0.3, -0.12, -0.42); x.closePath(); }, '#2aa556');
      blob(x, () => { rr(x, -0.36, 0.1, 0.72, 0.36, 0.02); }, '#fff4d6');
      shine(x, -0.2, -0.1);
    },
    balloon(x) {
      x.beginPath(); x.moveTo(0, 0.5); x.quadraticCurveTo(0.18, 0.7, -0.04, 0.9); x.stroke();
      blob(x, () => { x.ellipse(0, -0.12, 0.5, 0.62, 0, 0, Math.PI * 2); }, '#ff5fa2');
      blob(x, () => { x.moveTo(-0.1, 0.56); x.lineTo(0.1, 0.56); x.lineTo(0, 0.44); x.closePath(); }, '#ff5fa2');
      shine(x, -0.22, -0.36);
    },
    horseshoe(x) {
      const w = x.lineWidth; x.lineCap = 'round';
      x.lineWidth = w * 4.6; x.strokeStyle = INK; x.beginPath(); x.arc(0, -0.04, 0.54, Math.PI * 0.95, Math.PI * 2.05, true); x.stroke();
      x.lineWidth = w * 3.0; x.strokeStyle = '#c9ced6'; x.stroke();
      x.lineWidth = w; x.strokeStyle = INK; x.lineCap = 'butt';
      for (let k = 0; k < 6; k++) { const a = Math.PI * (1.0 + k * 0.2) - Math.PI; dot(x, Math.cos(a) * 0.54, -0.04 + Math.sin(a) * 0.54, 0.045); }
    },
    diamond(x) {
      blob(x, () => { x.moveTo(-0.7, -0.24); x.lineTo(-0.38, -0.62); x.lineTo(0.38, -0.62); x.lineTo(0.7, -0.24); x.lineTo(0, 0.74); x.closePath(); }, '#4fb0ff');
      x.beginPath(); x.moveTo(-0.7, -0.24); x.lineTo(0.7, -0.24); x.moveTo(-0.22, -0.62); x.lineTo(-0.3, -0.24); x.lineTo(0, 0.74); x.lineTo(0.3, -0.24); x.lineTo(0.22, -0.62); x.stroke();
    },
    cherry(x) {
      x.beginPath(); x.moveTo(-0.34, 0.24); x.quadraticCurveTo(-0.2, -0.4, 0.18, -0.66); x.moveTo(0.34, 0.3); x.quadraticCurveTo(0.24, -0.3, 0.18, -0.66); x.stroke();
      blob(x, () => { x.moveTo(0.18, -0.66); x.quadraticCurveTo(0.6, -0.86, 0.72, -0.56); x.quadraticCurveTo(0.44, -0.44, 0.18, -0.66); }, '#4cc35a');
      blob(x, () => { x.arc(-0.34, 0.44, 0.3, 0, Math.PI * 2); }, '#d81f3c'); shine(x, -0.44, 0.34, 0.08);
      blob(x, () => { x.arc(0.34, 0.5, 0.3, 0, Math.PI * 2); }, '#d81f3c'); shine(x, 0.24, 0.4, 0.08);
    },
    mushroom(x) {
      blob(x, () => { rr(x, -0.2, -0.04, 0.4, 0.8, 0.16); }, '#fff1d6');
      blob(x, () => { x.moveTo(-0.8, 0.04); x.bezierCurveTo(-0.8, -0.86, 0.8, -0.86, 0.8, 0.04); x.closePath(); }, '#e8343e');
      for (const [px, py, r] of [[-0.42, -0.2, 0.1], [0.08, -0.46, 0.12], [0.46, -0.14, 0.09]]) { x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fillStyle = '#ffffff'; x.fill(); }
    },
    can(x) {
      blob(x, () => { rr(x, -0.44, -0.66, 0.88, 1.36, 0.14); }, '#c9ced6');
      blob(x, () => { x.rect(-0.44, -0.3, 0.88, 0.6); }, '#e8343e');
      x.beginPath(); x.moveTo(-0.44, -0.5); x.lineTo(0.44, -0.5); x.moveTo(-0.44, 0.5); x.lineTo(0.44, 0.5); x.stroke();
      shine(x, -0.26, -0.1, 0.07);
    },
    heart(x) {
      blob(x, () => { x.moveTo(0, 0.7); x.bezierCurveTo(-0.9, 0.06, -0.62, -0.74, 0, -0.32); x.bezierCurveTo(0.62, -0.74, 0.9, 0.06, 0, 0.7); }, '#ff4d6a');
      shine(x, -0.32, -0.18);
    },
  };
  const ST_KEYS = Object.keys(ST);
  function rr(x, px, py, w, h, r) { x.moveTo(px + r, py); x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r); x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath(); }
  function blob(x, path, fill) { x.beginPath(); path(); x.closePath(); x.fillStyle = fill; x.fill(); x.strokeStyle = INK; x.stroke(); }
  function dot(x, px, py, r) { x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fillStyle = INK; x.fill(); }
  function shine(x, px, py, r) { x.beginPath(); x.ellipse(px, py, (r || 0.13), (r || 0.13) * 0.6, -0.6, 0, Math.PI * 2); x.fillStyle = 'rgba(255,255,255,.75)'; x.fill(); }
  function frontAtlas(n) {
    const g = Math.ceil(Math.sqrt(n)), S = Math.min(4096, Math.max(1024, Math.ceil(g * 300 / 256) * 256)), cs = S / g;
    const c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d');
    let last = '';
    for (let i = 0; i < n; i++) {
      const cx = (i % g) * cs, cy = Math.floor(i / g) * cs, mx = cx + cs / 2, my = cy + cs / 2;
      const gr = x.createLinearGradient(0, cy, 0, cy + cs); gr.addColorStop(0, '#fbf3df'); gr.addColorStop(1, '#efdcb6');
      x.fillStyle = gr; x.fillRect(cx, cy, cs, cs);
      x.strokeStyle = '#c99a3a'; x.lineWidth = cs * 0.035; x.strokeRect(cx + cs * 0.03, cy + cs * 0.03, cs * 0.94, cs * 0.94);
      x.beginPath(); x.arc(mx, my, cs * 0.42, 0, Math.PI * 2); x.fillStyle = '#ffffff'; x.fill();
      x.lineWidth = cs * 0.02; x.strokeStyle = 'rgba(201,154,58,.55)'; x.stroke();
      let k; do { k = ST_KEYS[Math.floor(Math.random() * ST_KEYS.length)]; } while (k === last && ST_KEYS.length > 1);
      last = k;
      x.save(); x.translate(mx, my); x.scale(cs * 0.34, cs * 0.34);
      x.lineWidth = 0.11; x.lineJoin = 'round'; x.lineCap = 'round'; x.strokeStyle = INK;
      ST[k](x); x.restore();
    }
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
    return { tex: t, g };
  }
  function buildTiles(names) {
    for (const t of R.tiles) R.scene.remove(t.mesh); R.tiles = [];
    for (const p of R.parts) R.scene.remove(p.o); R.parts = [];
    const n = names.length, W = BOARD.x1 - BOARD.x0, H = BOARD.y1 - BOARD.y0;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols), s = Math.min(W / cols, H / rows);
      if (!best || s > best.s + 1e-6) best = { cols, rows, s };
    }
    const { cols, rows, s } = best, sz = s * 0.94;
    const atlas = nameAtlas(names), front = frontAtlas(n);
    const side = new THREE.MeshStandardMaterial({ color: '#8a5a32', roughness: 0.7 });
    const fmat = new THREE.MeshStandardMaterial({ map: front.tex, roughness: 0.55 });
    const bmat = new THREE.MeshStandardMaterial({ map: atlas.tex, roughness: 0.6 });
    R.blurMat = R.blurMat || new THREE.MeshStandardMaterial({ color: '#d6343a', roughness: 0.6 });
    const ox = (W - cols * s) / 2, oy = (H - rows * s) / 2;
    for (let i = 0; i < n; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const geo = new THREE.BoxGeometry(sz, sz, sz * 0.2);
      // задня грань (−z) — клітинка атласу з ніком
      const g = atlas.g, u0 = (i % g) / g, v1 = 1 - Math.floor(i / g) / g, du = 1 / g;
      const uv = geo.attributes.uv;
      for (let k = 20; k < 24; k++) { const u = uv.getX(k), v = uv.getY(k); uv.setXY(k, u0 + u * du, v1 - du + v * du); }
      // передня грань (+z) — клітинка атласу мішеней із номером
      const fg = front.g, fu0 = (i % fg) / fg, fv1 = 1 - Math.floor(i / fg) / fg, fdu = 1 / fg;
      for (let k = 16; k < 20; k++) { const u = uv.getX(k), v = uv.getY(k); uv.setXY(k, fu0 + u * fdu, fv1 - fdu + v * fdu); }
      uv.needsUpdate = true;
      const mesh = new THREE.Mesh(geo, [side, side, side, side, fmat, bmat]);
      mesh.castShadow = true; mesh.receiveShadow = true;
      const x = BOARD.x0 + ox + (c + 0.5) * s, y = BOARD.y1 - oy - (r + 0.5) * s;
      mesh.position.set(x, y, BOARD.z); mesh.rotation.y = Math.PI;    // спершу — ніком до глядача
      mesh.userData.idx = i;
      R.scene.add(mesh);
      const t = { idx: i, name: names[i], mesh, sz, x, y, col: c, row: r, bmat };
      R.tiles.push(t);
    }
    R.grid = { cols, rows, s };
  }


  // ── кадр ──
  function frame() {
    const ov = document.getElementById('cashhunt-overlay');
    if (!R || !ov.classList.contains('visible') || !ov.classList.contains('ch3d')) { if (R) R.raf = 0; return; }
    R.raf = requestAnimationFrame(frame);
    const now = performance.now(), T = now / 1000;
    for (let i = R.tweens.length - 1; i >= 0; i--) { const tw = R.tweens[i], k = Math.min(1, (now - tw.t0) / tw.ms); tw.fn(tw.ez(k)); if (k >= 1) { R.tweens.splice(i, 1); tw.res(); } }
    // лампочки: дві групи по черзі; під час розкриття — частіше
    const on = Math.floor(T / (R.fast ? 0.14 : 0.42)) % 2;
    const ON = new THREE.Color('#ffe08a'), OFF = new THREE.Color('#6a4a1e');
    R.bulbMats.A.forEach(m => m.color.copy(on ? ON : OFF)); R.bulbMats.B.forEach(m => m.color.copy(on ? OFF : ON));
    R.bulbMats.gA.forEach(m => { m.opacity = on ? 0.95 : 0.08; }); R.bulbMats.gB.forEach(m => { m.opacity = on ? 0.08 : 0.95; });
    // гармата: плавно доводимо ствол до цілі
    if (R.barrel && R.barrelQ0) {
      let q = R.barrelQ0;
      if (R.aimAt) {
        const p = new THREE.Vector3(); R.barrel.getWorldPosition(p);
        const d = new THREE.Vector3().subVectors(R.aimAt, p).normalize();
        // ствол у моделі дивиться в −Z; доворот від −Z до напрямку на ціль
        q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), d).multiply(R.barrelQ0);
      }
      R.aimQ.slerp(q, 0.18); R.barrel.quaternion.copy(R.aimQ);
      R.barrel.position.y = BARREL[1] + Math.sin(T * 1.7) * 0.16;          // ствол легенько «пливе» в повітрі
    }
    // частини підстреленого пінгвіна: падають, відскакують від прилавка/підлоги
    if (R.pgParts) for (const pp of R.pgParts) {
      const o = pp.o, v = o.userData.v, w = o.userData.w, dt = 1 / 60;
      v.y -= 30 * dt; o.position.addScaledVector(v, dt);
      o.rotation.x += w.x * dt; o.rotation.y += w.y * dt; o.rotation.z += w.z * dt;
      const floor = o.position.z < 6.6 && o.position.x > -16.5 && o.position.x < 16.5 ? -0.25 : -12;
      if (o.position.y < floor) { o.position.y = floor; v.y = Math.abs(v.y) * 0.35; v.x *= 0.7; v.z *= 0.7; w.multiplyScalar(0.6); }
    }
    // уламки й конфеті
    for (let i = R.parts.length - 1; i >= 0; i--) {
      const p = R.parts[i], dt = 1 / 60;
      p.v.y -= p.g * dt; p.o.position.addScaledVector(p.v, dt); p.o.rotation.x += p.w[0] * dt; p.o.rotation.y += p.w[1] * dt;
      if (p.drag) p.v.multiplyScalar(0.985);
      p.life -= dt; if (p.o.material && p.o.material.opacity !== undefined && p.life < 0.6) { p.o.material.transparent = true; p.o.material.opacity = Math.max(0, p.life / 0.6); }
      if (p.life <= 0) { R.scene.remove(p.o); R.parts.splice(i, 1); }
    }
    for (const s of R.smokes) if (s.visible) { s.userData.age += 1 / 60; const a = s.userData.age; s.position.addScaledVector(s.userData.v, 1 / 60); s.scale.setScalar(1.5 + a * 5); s.material.opacity = Math.max(0, 0.5 * (1 - a / 1.5)); if (a > 1.5) s.visible = false; }
    if (R.ring.visible) { const k = 1 + 0.06 * Math.sin(T * 8); R.ring.scale.set(R.ring.userData.s * k, R.ring.userData.s * k, 1); }
    const sh = R.shake; R.shake = Math.max(0, R.shake - 0.03);
    R.camera.position.set(CAM.pos[0] + Math.sin(T * 0.5) * 0.3 + (Math.random() - 0.5) * sh, CAM.pos[1] + (Math.random() - 0.5) * sh, CAM.pos[2]);
    R.camera.lookAt(CAM.look[0], CAM.look[1], CAM.look[2]);
    R.renderer.render(R.scene, R.camera);
  }
  const startLoop = () => { if (!R.raf) R.raf = requestAnimationFrame(frame); };

  // ── вибір кліком у 3D ──
  function pick(e) {
    const r = R.canvas.getBoundingClientRect();
    R.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    R.ray.setFromCamera(R.mouse, R.camera);
    const hits = R.ray.intersectObjects(R.tiles.map(t => t.mesh), false);
    return hits.length ? R.tiles[hits[0].object.userData.idx] : null;
  }
  function pickPenguin(e) {
    if (!R.penguin || R.pgDown) return false;
    const r = R.canvas.getBoundingClientRect();
    R.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    R.ray.setFromCamera(R.mouse, R.camera);
    return R.ray.intersectObject(R.penguin, true).length > 0;
  }
  async function shootPenguin() {
    if (R.pgBusy || phase === 'revealing') return;
    R.pgBusy = true;
    const p = R.penguin, box = new THREE.Box3().setFromObject(p), c = box.getCenter(new THREE.Vector3());
    const prevAim = R.aimAt; R.aimAt = c.clone();
    await wait(420);
    await shoot(c);
    R.aimAt = prevAim;
    R.pgDown = true; R.shake = 0.9; snd('hit', 1, 0.8);
    R.hitL.position.set(c.x, c.y, c.z + 2); R.hitL.intensity = 9; tween(450, k => { R.hitL.intensity = 9 * (1 - k); });
    // кожна частина пінгвіна (тулуб, голова, окуляри, газета…) летить своєю дорогою з обертанням
    p.updateMatrixWorld(true);
    R.pgParts = [];
    const kids = []; p.traverse(o => { if (o.isMesh) kids.push(o); });
    for (const o of kids) {
      R.pgParts.push({ o, parent: o.parent, home: { pos: o.position.clone(), quat: o.quaternion.clone(), scale: o.scale.clone() } });
      R.scene.attach(o);
      const d = o.getWorldPosition(new THREE.Vector3()).sub(c); d.z = Math.abs(d.z) + 0.6;
      o.userData.v = d.normalize().multiplyScalar(8 + Math.random() * 9).add(new THREE.Vector3((Math.random() - 0.5) * 4, 7 + Math.random() * 6, 3 + Math.random() * 4));
      o.userData.v.x = -Math.abs(o.userData.v.x) * 0.7 + (Math.random() - 0.5) * 4;   // пінгвін справа — шматки летять у кадр, а не за край
      o.userData.w = new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
    }
    // пір'я: чорно-білі пластинки
    for (let i = 0; i < 40; i++) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.16), new THREE.MeshStandardMaterial({ color: i % 3 ? '#16171c' : '#f2f2f4', side: THREE.DoubleSide, transparent: true }));
      f.position.copy(c); R.scene.add(f);
      R.parts.push({ o: f, v: new THREE.Vector3((Math.random() - 0.5) * 12, 4 + Math.random() * 9, 2 + Math.random() * 7), w: [Math.random() * 10, Math.random() * 10], g: 6, drag: true, life: 2.6 + Math.random() });
    }
    await wait(5200);
    // збираємо назад: частини повертаються в пінгвіна й «випірнають» із нуля
    for (const pp of R.pgParts) {
      pp.parent.add(pp.o); pp.o.position.copy(pp.home.pos); pp.o.quaternion.copy(pp.home.quat); pp.o.scale.copy(pp.home.scale);
    }
    R.pgParts = null; R.pgDown = false;
    const s0 = PENGUIN.scale; p.scale.setScalar(0.01);
    snd('flip', 0.5, 0.9);
    await tween(520, k => { p.scale.setScalar(Math.max(0.01, s0 * k)); }, ease.back);
    R.pgBusy = false;
  }
  function bindPointer() {
    R.canvas.addEventListener('pointermove', e => {
      if (pickPenguin(e) && phase !== 'revealing') { R.canvas.style.cursor = 'crosshair'; R.hover.visible = false; return; }
      if (phase !== 'selecting') { R.hover.visible = false; R.canvas.style.cursor = 'default'; return; }
      const t = pick(e);
      R.canvas.style.cursor = t ? 'crosshair' : 'default';
      if (t) { R.hover.visible = true; R.hover.position.set(t.x, t.y, BOARD.z + t.sz * 0.12); R.hover.scale.set(t.sz * 0.62, t.sz * 0.62, 1); if (!selected.size) R.aimAt = new THREE.Vector3(t.x, t.y, BOARD.z); }
      else R.hover.visible = false;
    });
    R.canvas.addEventListener('pointerdown', e => {
      if (e.button === 0 && pickPenguin(e)) { shootPenguin(); return; }      // пасхалка
      if (phase !== 'selecting') return;
      const t = pick(e); if (!t) return;
      const need = currentGame.winnersNeeded;
      if (selected.has(t.idx)) selected.delete(t.idx);
      else { if (selected.size >= need) selected.delete([...selected][0]); selected.add(t.idx); }
      if (selected.size) {
        const last = R.tiles[[...selected][selected.size - 1]];
        R.ring.visible = true; R.ring.position.set(last.x, last.y, BOARD.z + last.sz * 0.13); R.ring.userData.s = last.sz * 0.58;
        R.aimAt = new THREE.Vector3(last.x, last.y, BOARD.z);
        snd('aim', 0.6, jit(1.05, 0.12));
      } else { R.ring.visible = false; R.aimAt = null; }
      updateHint();
      const ctrl = document.getElementById('cashhunt-controls');
      if (selected.size === need) {
        ctrl.style.display = 'flex';
        // одна кнопка пострілу знизу по центру (без «Закрыть» — на етапі вибору вона не потрібна)
        ctrl.innerHTML = '<button class="ch-fire" onclick="startReveal()"><svg viewBox="0 0 40 40" aria-hidden="true">' +
          '<circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="20" cy="20" r="7.5" fill="none" stroke="currentColor" stroke-width="3"/>' +
          '<circle cx="20" cy="20" r="2.4" fill="currentColor"/><path d="M20 1v9M20 30v9M1 20h9M30 20h9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg><span>Выстрел</span></button>';
      } else ctrl.style.display = 'none';
    });
    R.canvas.addEventListener('pointerleave', () => { R.hover.visible = false; });
  }

  // ── інтро: ніки → хвиля перевертання на мішені → колонки-барабани → зупинка ──
  async function intro(my) {
    const alive = () => phase === 'intro' && token === my;
    const hint = document.getElementById('cashhunt-hint');
    hint.textContent = 'Участники на табло';
    await wait(1900); if (!alive()) return;
    const { rows, cols } = R.grid;
    for (let r = 0; r < rows; r++) {
      for (const t of R.tiles) if (t.row === r) tween(420, k => { t.mesh.rotation.y = Math.PI * (1 - k); }, ease.back);
      snd('flip', 0.5, jit(1 + r * 0.03, 0.08));
      await wait(70); if (!alive()) return;
    }
    await wait(520); if (!alive()) return;
    hint.textContent = 'Перемешивание...';
    const reel = snd('reel', 0.55);
    // кожна колонка — барабан: плитки крутяться навколо горизонтальної осі зі своєю швидкістю,
    // ребром до глядача мішень підміняється, на звороті — червона «сорочка» замість ніка
    const spin = [];
    for (let c = 0; c < cols; c++) spin.push({ v: 13 + Math.random() * 7, a: Math.random() * 6 });
    for (const t of R.tiles) t.mesh.material[5] = R.blurMat;
    const t0 = performance.now();
    await new Promise(res => {
      const step = () => {
        if (!alive()) return res();
        const el = (performance.now() - t0) / 1000;
        for (const t of R.tiles) {
          const sp = spin[t.col], a = sp.a + sp.v * el;
          t.mesh.rotation.x = a;
        }
        if (el < 2.6) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
    fadeOut(reel, rows * 95 + 300);
    if (!alive()) return;
    // зупинка: ряд за рядом згори вниз, з пружним «стуком»
    for (let r = 0; r < rows; r++) {
      for (const t of R.tiles) if (t.row === r) {
        const a0 = t.mesh.rotation.x, a1 = Math.ceil(a0 / (Math.PI * 2)) * Math.PI * 2;
        tween(380, k => { t.mesh.rotation.x = a0 + (a1 - a0) * k; }, ease.back).then(() => { t.mesh.rotation.x = 0; });
      }
      setTimeout(() => snd('stop', 0.55, jit(1.08 - r * 0.03, 0.06)), 260);
      await wait(95); if (!alive()) return;
    }
    await wait(450);
    for (const t of R.tiles) t.mesh.material[5] = t.bmat;
    if (!alive()) return;
    phase = 'selecting';
    updateHint();
  }

  // ── підміна: показ табло ──
  async function renderGame3D(game) {
    const overlay = document.getElementById('cashhunt-overlay');
    if (game && game.rollSource) { lastRollSource = game.rollSource; lastRollProof = game.rollProof || null; }
    currentGame = game; selected = new Set(); phase = 'intro';
    const my = ++token;
    overlay.classList.add('visible', 'ch3d');
    document.getElementById('cashhunt-controls').style.display = 'none';
    document.getElementById('cashhunt-progress-overlay').textContent = '';
    document.getElementById('cashhunt-grid').innerHTML = '';
    document.getElementById('game-controls').style.display = 'none';
    let host = document.getElementById('ch3d');
    if (!host) { host = document.createElement('div'); host.id = 'ch3d'; overlay.insertBefore(host, document.getElementById('cashhunt-hint')); }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { await ensureScene(host); } catch (e) {
      console.warn('[cashhunt3d] 3D недоступне — 2D-табло', e);
      overlay.classList.remove('ch3d'); return orig.renderGame(game);
    }
    if (token !== my) return;
    resize(); R.fast = false; R.aimAt = null; R.ring.visible = false; R.hover.visible = false;
    buildTiles(game.cells);
    startLoop();
    intro(my);
  }

  // ── підміна: постріл і розкриття ──
  async function fireAt(t) {
    R.aimAt = new THREE.Vector3(t.x, t.y, BOARD.z);
    await wait(480);
    await shoot(new THREE.Vector3(t.x, t.y, BOARD.z));
    // плитка розлітається: уламки + конфеті + спалах
    t.mesh.visible = false; R.ring.visible = false; R.shake = 0.8;
    snd('hit', 0.9, jit(1, 0.08));
    burstAt(t);
  }
  // постріл: спалах і дим із дула, ядро летить дугою до точки end
  async function shoot(end) {
    const mz = new THREE.Vector3(0, 0, -3.6).applyQuaternion(R.barrel.getWorldQuaternion(new THREE.Quaternion())).add(R.barrel.getWorldPosition(new THREE.Vector3()));
    snd('fire', 1);
    R.flash.position.copy(mz); R.flash.material.opacity = 1; tween(180, k => { R.flash.material.opacity = 1 - k; R.flash.scale.setScalar(4 + 4 * k); });
    R.smokes.forEach((s, j) => { s.visible = true; s.userData.age = -j * 0.03; s.position.copy(mz); s.userData.v = new THREE.Vector3((Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, 1 + Math.random() * 2); });
    R.shake = 0.35;
    R.ball.visible = true;
    await tween(200, k => { R.ball.position.lerpVectors(mz, end, k); R.ball.position.y += Math.sin(k * Math.PI) * 1.2; }, x => x);
    R.ball.visible = false;
  }
  function burstAt(t) {
    R.hitL.position.set(t.x, t.y, BOARD.z + 2); R.hitL.intensity = 8; tween(400, k => { R.hitL.intensity = 8 * (1 - k); });
    const fragMat = new THREE.MeshStandardMaterial({ color: '#f3e3c3', roughness: 0.6 }), redMat = new THREE.MeshStandardMaterial({ color: '#d6343a', roughness: 0.6 });
    for (let i = 0; i < 16; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(t.sz * (0.12 + Math.random() * 0.2), t.sz * (0.12 + Math.random() * 0.2), t.sz * 0.12), i % 3 ? fragMat : redMat);
      f.position.set(t.x + (Math.random() - 0.5) * t.sz * 0.6, t.y + (Math.random() - 0.5) * t.sz * 0.6, BOARD.z); f.castShadow = true; R.scene.add(f);
      R.parts.push({ o: f, v: new THREE.Vector3((Math.random() - 0.5) * 14, 4 + Math.random() * 9, 4 + Math.random() * 8), w: [Math.random() * 12, Math.random() * 12], g: 26, life: 2.2 });
    }
    const COLS = ['#ff4d6a', '#ffcf3f', '#53fc18', '#4fb0ff', '#b46cff', '#ffffff'];
    for (let i = 0; i < 70; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.34), new THREE.MeshBasicMaterial({ color: COLS[i % COLS.length], side: THREE.DoubleSide, transparent: true, toneMapped: false }));
      p.position.set(t.x, t.y, BOARD.z + 0.6); R.scene.add(p);
      R.parts.push({ o: p, v: new THREE.Vector3((Math.random() - 0.5) * 16, 6 + Math.random() * 12, 2 + Math.random() * 9), w: [Math.random() * 14, Math.random() * 14], g: 9, drag: true, life: 3 + Math.random() });
    }
  }
  async function startReveal3D() {
    if (!R || !document.getElementById('cashhunt-overlay').classList.contains('ch3d')) return orig.startReveal();
    if (selected.size !== currentGame.winnersNeeded) return;
    phase = 'revealing'; R.fast = true;
    for (const t of R.tiles) { t.mesh.material[5] = t.bmat; t.mesh.rotation.x = 0; }   // навіть якщо інтро не встигло прибрати «сорочку»
    const hint = document.getElementById('cashhunt-hint'), ctrl = document.getElementById('cashhunt-controls');
    ctrl.style.display = 'none'; hint.textContent = 'Раскрытие...'; R.hover.visible = false;
    const order = [...selected].sort(() => Math.random() - 0.5);
    for (const idx of order) await fireAt(R.tiles[idx]);
    await wait(450);
    // ніки інших НЕ відкриваємо (за проханням стрімера) — табло лише трохи тьмяніє, щоб виділити переможця
    const others = R.tiles.filter(t => !selected.has(t.idx));
    if (others.length) { const fm = others[0].mesh.material[4]; tween(600, k => { fm.color.setScalar(1 - 0.45 * k); }); }
    await wait(700);
    // переможець: на місці розбитої плитки перевертається темна картка з золотою рамкою й ніком
    for (const idx of order) {
      const t = R.tiles[idx], name = currentGame.cells[idx];
      const card = winnerCard(name), w = Math.min(11, Math.max(9.5, t.sz * 5));
      const tx = Math.min(BOARD.x1 - w / 2, Math.max(BOARD.x0 + w / 2, t.x)), ty = Math.min(BOARD.y1 - w * 0.25, Math.max(BOARD.y0 + w * 0.25, t.y));
      card.position.set(t.x, t.y, BOARD.z + 0.4); card.scale.setScalar(0.25); card.rotation.x = -Math.PI / 2; R.scene.add(card);
      snd('flip', 0.6, 0.85);
      const from = card.position.clone(), to = new THREE.Vector3(tx, ty, BOARD.z + 1.8);
      await tween(560, k => { card.position.lerpVectors(from, to, k); card.scale.setScalar(0.25 + (w - 0.25) * k); card.rotation.x = -Math.PI / 2 * (1 - k); }, ease.back);
      R.parts.push({ o: card, v: new THREE.Vector3(), w: [0, 0], g: 0, life: 1e9 });
      addWinner(name);
      await wait(900);
    }
    R.fast = false; R.aimAt = null;
    phase = 'done';
    hint.innerHTML = '🏆 Готово!';
    ctrl.style.display = 'flex';
    ctrl.innerHTML = '<button class="btn-orange" onclick="reroll()">🔄 Рерол</button><button class="btn-dark" onclick="closeCashhuntOverlay()">Закрыть</button>';
  }
  // картка переможця (1 × 0.42 у світових одиницях, масштабується до потрібної ширини):
  // темне скло, золота рамка, кружок із літерою ніка, нік — золотим градієнтом
  function winnerCard(name) {
    const W = 1200, H = 504, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    const rr = (px, py, pw, ph, r) => { x.beginPath(); x.moveTo(px + r, py); x.arcTo(px + pw, py, px + pw, py + ph, r); x.arcTo(px + pw, py + ph, px, py + ph, r); x.arcTo(px, py + ph, px, py, r); x.arcTo(px, py, px + pw, py, r); x.closePath(); };
    let g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#1d1a28'); g.addColorStop(1, '#0b0a11');
    rr(6, 6, W - 12, H - 12, 60); x.fillStyle = g; x.fill();
    g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#ffe48a'); g.addColorStop(0.5, '#ffc93d'); g.addColorStop(1, '#ff9f1c');
    x.lineWidth = 12; x.strokeStyle = g; rr(10, 10, W - 20, H - 20, 56); x.stroke();
    x.lineWidth = 2; x.strokeStyle = 'rgba(255,214,120,.35)'; rr(34, 34, W - 68, H - 68, 40); x.stroke();
    // кружок із літерою
    let h = 2166136261; for (const ch of String(name).toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } h = (h >>> 0) % 360;
    const cx = 190, cy = H / 2, r = 120;
    g = x.createLinearGradient(cx - r, cy - r, cx + r, cy + r); g.addColorStop(0, 'hsl(' + h + ',75%,58%)'); g.addColorStop(1, 'hsl(' + ((h + 40) % 360) + ',70%,40%)');
    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fillStyle = g; x.fill();
    x.lineWidth = 10; x.strokeStyle = '#ffc93d'; x.stroke();
    x.fillStyle = '#fff'; x.font = '800 130px Unbounded, Manrope, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(((String(name).match(/[\p{L}\p{N}]/u) || ['?'])[0]).toUpperCase(), cx, cy + 6);
    // підпис і нік
    x.textAlign = 'left'; x.fillStyle = 'rgba(255,214,120,.75)'; x.font = '800 40px Manrope, sans-serif';
    x.fillText('П О Б Е Д И Т Е Л Ь', 350, 165);
    let fs = 120; x.font = '800 ' + fs + 'px Unbounded, Manrope, sans-serif';
    while (x.measureText(name).width > W - 420 && fs > 44) { fs -= 4; x.font = '800 ' + fs + 'px Unbounded, Manrope, sans-serif'; }
    g = x.createLinearGradient(0, 220, 0, 340); g.addColorStop(0, '#ffe9a6'); g.addColorStop(1, '#ffb52e');
    x.fillStyle = g; x.fillText(name, 350, 290);
    const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 8;
    const face = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, H / W), face);
    // м'яке золоте сяйво позаду
    const gc = document.createElement('canvas'); gc.width = gc.height = 128; const gx = gc.getContext('2d');
    const gg = gx.createRadialGradient(64, 64, 8, 64, 64, 62); gg.addColorStop(0, 'rgba(255,201,61,.55)'); gg.addColorStop(1, 'rgba(255,160,40,0)'); gx.fillStyle = gg; gx.fillRect(0, 0, 128, 128);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(gc), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    glow.position.z = -0.02; m.add(glow);
    return m;
  }

  // ── підключення ──
  if (typeof THREE !== 'undefined' && THREE.GLTFLoader) {
    window.renderGame = renderGame3D;
    window.startReveal = startReveal3D;
    window.__ch3d = () => R;                               // для відладки з консолі
    setTimeout(() => { loadGLB().catch(() => {}); }, 3500);   // прогрів у фоні
  }
  window.closeCashhuntOverlay = function () {
    token++;
    const ov = document.getElementById('cashhunt-overlay'); ov.classList.remove('ch3d');
    if (R) { for (const p of R.parts) R.scene.remove(p.o); R.parts = []; R.ring.visible = false; }
    return orig.close.apply(this, arguments);
  };
})();
