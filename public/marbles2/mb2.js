/* ══════════════════════════════════════════════════════════════
   Шарики 2.0 — рендер, режисер камери, HUD (фізика — mb2-core.js).
   • До 1000 кульок: одна InstancedMesh, матриці пишуться прямо в буфер,
     кочення — кватерніон на кульку; між кроками фізики — інтерполяція.
   • Траса з Blender (maps/<id>.glb) + та сама геометрія для фізики (maps/<id>.json).
   • Графіка: тіні від сонця, що їде за лідером; неон зі світінням (UnrealBloom);
     відбиття від простої студії-оточення; зоряне небо й туман.
   Глобали app.js: state, rollPick, addWinner, phase.
   ══════════════════════════════════════════════════════════════ */
(function () {
  const ASSET = '/assets/marbles2/';
  // карти: id → назва, версія файлів (підняти після перебудови в Blender), тема оточення, кольори картки вибору
  const MAPS = {
    neon: { name: 'Неоновый каскад', v: '20261123h', theme: 'neon', look: ['#0b0b26', '#3a1450', '#2fe8ff'] },
    zeus: { name: 'Гнев Зевса', v: '20261123z4', theme: 'zeus', hidden: true,   // прихована: власнику не сподобалась (файли лишаються)
            look: ['#27315f', '#f0c27a', '#ffffff'] },
  };
  const PP_BASE = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/';
  const PP_FILES = ['shaders/CopyShader.js', 'shaders/LuminosityHighPassShader.js',
    'postprocessing/EffectComposer.js', 'postprocessing/RenderPass.js', 'postprocessing/ShaderPass.js', 'postprocessing/UnrealBloomPass.js'];
  const INTRO = 4.2;          // секунд огляду контейнера до старту
  const LABELS = 10;

  let dom = null, G = null, S = null, raf = 0, lastTs = 0, acc = 0;
  let baseList = [], mapId = 'neon', winnerName = null, announced = false, annTimer = 0;
  const mapCache = {};
  // r128 без керування кольором: hex — це sRGB, а шейдер рахує в лінійному просторі
  const lin = hex => new THREE.Color(hex).convertSRGBToLinear();

  // ── DOM ──
  function ensureDom() {
    if (dom) return dom;
    const root = document.createElement('div');
    root.id = 'mb2-overlay';
    root.innerHTML = `
      <canvas id="mb2-canvas"></canvas>
      <div class="mb2-hud">
        <div class="mb2-pill"><span class="mb2-pill-name" id="mb2-name">Шарики</span>
          <span class="mb2-pill-it"><i class="mb2-i-ball"></i><b id="mb2-alive">0/0</b></span>
          <span class="mb2-pill-it"><i class="mb2-i-clock"></i><b id="mb2-time">00:00.0</b></span></div>
        <div class="mb2-pill mb2-cd" id="mb2-cd">60</div>
      </div>
      <div class="mb2-board" id="mb2-board"></div>
      <div class="mb2-feed" id="mb2-feed"></div>
      <div class="mb2-labels" id="mb2-labels"></div>
      <div class="mb2-big" id="mb2-big"></div>
      <div class="mb2-win" id="mb2-win"><div class="mb2-win-k">ПОБЕДИТЕЛЬ</div><div class="mb2-win-n" id="mb2-win-n"></div></div>
      <div class="mb2-load" id="mb2-load"><div class="mb2-spin"></div><span id="mb2-load-t">Загрузка…</span></div>
      <div class="mb2-cam">
        <button class="mb2-btn" id="mb2-free" title="Свободная камера (мышь)">Свободная</button>
        <button class="mb2-btn on" id="mb2-auto" title="Режиссёр камеры">Режиссёр</button>
        <button class="mb2-btn mb2-x" id="mb2-close" title="Закрыть">✕</button>
      </div>
      <div class="mb2-hint" id="mb2-hint">WASD — движение · мышь — обзор · Space/E — вверх · C/Q — вниз · Shift — быстрее · колесо — скорость · Esc — отпустить мышь</div>
      <div class="mb2-flash" id="mb2-flash"></div>
      <div class="mb2-pick" id="mb2-pick"><div class="mb2-pick-t">Выбери трассу</div><div class="mb2-pick-cards" id="mb2-pick-cards"></div>
        <button class="mb2-btn" id="mb2-pick-x" type="button">Закрыть</button></div>
      <div class="mb2-end" id="mb2-end"><button class="btn-dark" id="mb2-again">Ещё раз</button><button class="btn-dark" id="mb2-other">Другая трасса</button><button class="btn-primary" id="mb2-close2">Закрыть</button></div>`;
    document.body.appendChild(root);
    const $ = id => root.querySelector('#' + id);
    dom = { root, canvas: $('mb2-canvas'), name: $('mb2-name'), alive: $('mb2-alive'), time: $('mb2-time'), cd: $('mb2-cd'), board: $('mb2-board'),
      feed: $('mb2-feed'), labels: $('mb2-labels'), big: $('mb2-big'), win: $('mb2-win'), winN: $('mb2-win-n'), load: $('mb2-load'), loadT: $('mb2-load-t'),
      free: $('mb2-free'), auto: $('mb2-auto'), hint: $('mb2-hint'), end: $('mb2-end'), flash: $('mb2-flash'), pick: $('mb2-pick'), pickCards: $('mb2-pick-cards'), rows: [], lab: [] };
    $('mb2-other').onclick = () => otherMap();
    if (Object.keys(MAPS).filter(id => !MAPS[id].hidden).length < 2) $('mb2-other').style.display = 'none';   // одна траса — вибирати нема з чого
    $('mb2-pick-x').onclick = () => { if (pickResolve) { const r = pickResolve; pickResolve = null; r(null); } };
    $('mb2-close').onclick = $('mb2-close2').onclick = () => closeMarbles2Overlay();
    $('mb2-again').onclick = () => restart();
    dom.free.onclick = () => setFree(!fly.on);
    dom.auto.onclick = () => setFree(false);
    for (let k = 0; k < LABELS; k++) { const d = document.createElement('div'); d.className = 'mb2-lab'; dom.labels.appendChild(d); dom.lab.push({ el: d, txt: '' }); }
    return dom;
  }
  function loading(t) { if (!dom) return; dom.load.classList.toggle('on', !!t); if (t) dom.loadT.textContent = t; }

  // ── завантаження ──
  function loadScript(url) {
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  }
  let ppP = null;
  function loadPost() {
    if (!ppP) ppP = (async () => { for (const f of PP_FILES) await loadScript(PP_BASE + f); })().catch(e => { console.warn('[mb2] bloom недоступний', e); ppP = null; });
    return ppP;
  }
  function loadMap(id) {
    if (mapCache[id]) return mapCache[id];
    const v = MAPS[id].v;
    return (mapCache[id] = Promise.all([
      fetch(ASSET + 'maps/' + id + '.json?v=' + v).then(r => r.json()),
      new Promise((ok, no) => new THREE.GLTFLoader().load(ASSET + 'maps/' + id + '.glb?v=' + v, g => ok(g.scene), undefined, no)),
    ]).then(([j, scene]) => ({ j, map: MB2Core.loadMap(j), scene })).catch(e => { delete mapCache[id]; throw e; }));
  }

  // ── текстури ──
  function swirlTexture() {
    const W = 256, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), im = g.createImageData(W, H), d = im.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = x / W * Math.PI * 2, v = y / H * Math.PI;
      const w = Math.sin(u * 2 + Math.sin(v * 3 + u) * 1.6 + v * 2.2);
      const band = Math.pow(Math.abs(w), 6), vein = Math.pow(1 - Math.abs(Math.sin(u * 3 - v * 4 + w * 1.4)), 18);
      const k = 0.62 + 0.38 * (1 - band) , wh = vein * 0.8;
      const o = (y * W + x) * 4, val = Math.min(255, (k + wh) * 255);
      d[o] = d[o + 1] = d[o + 2] = val; d[o + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t;
  }
  // підлога: темний індиго з розміткою — смуги поперек кожні 4 м дають відчуття швидкості
  function floorTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#1f2350'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(120,140,255,.07)'; for (let k = 0; k < 4; k++) g.fillRect(0, k * 64, 256, 2);
    g.fillStyle = 'rgba(90,230,255,.16)'; g.fillRect(0, 0, 256, 5);
    g.fillStyle = 'rgba(120,140,255,.10)'; g.fillRect(62, 0, 3, 256); g.fillRect(191, 0, 3, 256);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t;
  }
  // мармур: теплий білий із сірими прожилками, золота смуга поперек кожні 4 м
  function marbleTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
    g.fillStyle = '#f1ece3'; g.fillRect(0, 0, 512, 512);
    let seed = 7; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 26; k++) {
      g.strokeStyle = 'rgba(110,104,98,' + (0.05 + r() * 0.12).toFixed(3) + ')'; g.lineWidth = 0.6 + r() * 1.8;
      g.beginPath(); let x = r() * 512, y = r() * 512; g.moveTo(x, y);
      for (let q = 0; q < 6; q++) { const nx = x + (r() - 0.3) * 160, ny = y + (r() - 0.5) * 120; g.quadraticCurveTo(x + (r() - 0.5) * 90, y + (r() - 0.5) * 90, nx, ny); x = nx; y = ny; }
      g.stroke();
    }
    g.fillStyle = 'rgba(214,170,74,.55)'; g.fillRect(0, 0, 512, 6);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t;
  }
  // небо Олімпу: грозова синява згори → золотий захід на горизонті → світлі хмари внизу
  function zeusSky() {
    const c = document.createElement('canvas'); c.width = 4; c.height = 256; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#2b3a72'); gr.addColorStop(0.32, '#4a5a95'); gr.addColorStop(0.5, '#8a86a8'); gr.addColorStop(0.6, '#f0c27a'); gr.addColorStop(0.7, '#e9d6bf'); gr.addColorStop(1, '#aab3c9');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }
  function skyTexture() {
    const c = document.createElement('canvas'); c.width = 4; c.height = 256; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#04040c'); gr.addColorStop(0.45, '#0b0b26'); gr.addColorStop(0.72, '#231040'); gr.addColorStop(1, '#0a0618');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }
  // золотий шеврон над лідером
  function chevronSprite() {
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    g.shadowColor = 'rgba(255,190,60,.9)'; g.shadowBlur = 10;
    g.fillStyle = '#ffd25a'; g.beginPath(); g.moveTo(12, 18); g.lineTo(52, 18); g.lineTo(32, 46); g.closePath(); g.fill();
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
  }
  function glowSprite(col) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, col); gr.addColorStop(0.25, col.replace(/[\d.]+\)$/, '0.45)')); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  // ── сцена (один раз) ──
  function gfxInit() {
    if (G) return G;
    const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene();
    scene.background = skyTexture();
    scene.fog = new THREE.FogExp2(lin(0x0a0a20), 0.0042);
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 1500);
    // оточення для відбиттів: темна студія з неоновими панелями
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 24, 12), new THREE.MeshBasicMaterial({ color: lin(0x0c0d1c), side: THREE.BackSide })));
    const panel = (col, x, y, z, w, h) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: lin(col), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m); };
    panel(0x33e6ff, 30, 18, 20, 30, 6); panel(0xff2aa8, -30, 14, -18, 26, 6); panel(0x8a96c0, 0, 40, 0, 16, 16); panel(0xffa21a, 10, 6, -40, 20, 4);
    const pm = new THREE.PMREMGenerator(renderer); const envTex = pm.fromScene(env, 0.02).texture; pm.dispose();
    const hemi = new THREE.HemisphereLight(lin(0x8fa8ff), lin(0x2a1840), 0.55); scene.add(hemi);
    // оточення Олімпу: світле небо, тепле сонце — золото й мармур відбивають його
    const env2 = new THREE.Scene();
    env2.add(new THREE.Mesh(new THREE.SphereGeometry(50, 24, 12), new THREE.MeshBasicMaterial({ color: lin(0x6f7fae), side: THREE.BackSide })));
    const panel2 = (col, x, y, z, w, h) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: lin(col), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); env2.add(m); };
    panel2(0xfff2d6, 0, 42, 0, 40, 40); panel2(0xffc77a, 40, 10, 10, 40, 12); panel2(0xdfe6f5, -40, 0, -10, 50, 14);
    const pm2 = new THREE.PMREMGenerator(renderer); const envZeus = pm2.fromScene(env2, 0.02).texture; pm2.dispose();
    const flashL = new THREE.PointLight(lin(0xcfe2ff), 0, 46, 2); scene.add(flashL);
    const sun = new THREE.DirectionalLight(lin(0xfff1dd), 1.9);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 160;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
    scene.add(sun); scene.add(sun.target);
    // зорі
    const sp = new Float32Array(2400 * 3);
    for (let i = 0; i < 2400; i++) { const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = 700, q = Math.sqrt(1 - u * u); sp[i * 3] = r * q * Math.cos(a); sp[i * 3 + 1] = Math.abs(u) * r * 0.9 + 40; sp[i * 3 + 2] = r * q * Math.sin(a); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xbfd0ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 }));
    scene.add(stars);
    // кулі: одна інстансна сітка на всіх (ємність росте за потреби)
    const ballMat = new THREE.MeshStandardMaterial({ map: swirlTexture(), roughness: 0.16, metalness: 0.08, envMap: envTex, envMapIntensity: 1.1 });
    const ballGeo = new THREE.SphereGeometry(MB2Core.R, 18, 12);
    // німб лідера і золоте кільце
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: chevronSprite(), depthWrite: false, depthTest: false, transparent: true, toneMapped: false, fog: false }));
    halo.scale.set(0.9, 0.9, 1); halo.renderOrder = 20; halo.visible = false; scene.add(halo);
    G = { renderer, scene, camera, sun, hemi, envTex, envNeon: envTex, envZeus, flashL, bolts: [], skies: { neon: scene.background, zeus: zeusSky() }, ballMat, ballGeo, balls: null, cap: 0, halo, stars, track: null, trackId: null, gate: null, composer: null, bloom: null,
      cam: { pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false, shot: 'chase', shotT: 0, subj: -1, free: false }, mtmp: new THREE.Matrix4(), v3: new THREE.Vector3() };
    window.addEventListener('resize', resize);
    return G;
  }
  // тема оточення під карту: небо, туман, світло, світіння, відбиття
  function applyTheme(theme) {
    if (!G || G.theme === theme) return; G.theme = theme;
    const z = theme === 'zeus';
    G.scene.background = G.skies[z ? 'zeus' : 'neon'];
    G.scene.fog.color.copy(lin(z ? 0xaeb6cf : 0x0a0a20)); G.scene.fog.density = z ? 0.0038 : 0.0042;
    G.hemi.color.copy(lin(z ? 0xe6edff : 0x8fa8ff)); G.hemi.groundColor.copy(lin(z ? 0x8a7a66 : 0x2a1840)); G.hemi.intensity = z ? 0.55 : 0.55;
    G.sun.color.copy(lin(z ? 0xfff0d2 : 0xfff1dd)); G.sun.intensity = z ? 1.9 : 1.9;
    G.stars.visible = !z;
    G.envTex = z ? G.envZeus : G.envNeon;
    G.ballMat.envMap = G.envTex; G.ballMat.needsUpdate = true;
    G.renderer.toneMappingExposure = z ? 0.88 : 1.05;
    if (G.bloom) { G.bloom.strength = z ? 0.45 : 0.8; G.bloom.radius = z ? 0.35 : 0.45; G.bloom.threshold = z ? 0.97 : 0.72; }
  }
  function setupComposer() {
    if (G.composer || !THREE.EffectComposer || !THREE.UnrealBloomPass) return;
    // HDR-буфер: неон яскравіший за 1.0 — саме він і світиться, решта сцени після ACES ≤ 1
    const sz0 = G.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(sz0.x, sz0.y, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    rt.texture.encoding = THREE.sRGBEncoding;   // сцена пишеться вже в sRGB: світіння рахується в «видимих» яскравостях, без підсилення темних хвостів гамою
    const c = new THREE.EffectComposer(G.renderer, rt);
    c.addPass(new THREE.RenderPass(G.scene, G.camera));
    const sz = G.renderer.getSize(new THREE.Vector2());
    G.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(sz.x, sz.y), 0.8, 0.45, 0.72);
    c.addPass(G.bloom);
    G.composer = c; resize();
    const th = G.theme; G.theme = null; if (th) applyTheme(th);
  }
  function resize() {
    if (!G || !dom) return;
    const w = dom.root.clientWidth || window.innerWidth, h = dom.root.clientHeight || window.innerHeight;
    G.renderer.setSize(w, h, false); G.camera.aspect = w / h; G.camera.updateProjectionMatrix();
    if (G.composer) { G.composer.setSize(w, h); G.composer.setPixelRatio && G.composer.setPixelRatio(G.renderer.getPixelRatio()); }
  }
  function ensureBalls(n) {
    if (G.balls && G.cap >= n) return;
    if (G.balls) { G.scene.remove(G.balls); G.balls.dispose && G.balls.dispose(); }
    const cap = Math.max(n, 64);
    const m = new THREE.InstancedMesh(G.ballGeo, G.ballMat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    G.scene.add(m); G.balls = m; G.cap = cap;
  }

  // ── траса ──
  function buildTrack(M) {
    if (G.trackId === mapId) { resetGate(); return; }
    if (G.track) G.scene.remove(G.track);
    const root = M.scene.clone(true);
    const glass = new THREE.MeshStandardMaterial({ color: lin(0x9fdcff), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, envMap: G.envTex, envMapIntensity: 0.7 });
    const floor = new THREE.MeshStandardMaterial({ color: 0xffffff, map: floorTexture(), roughness: 0.42, metalness: 0.2, envMap: G.envTex, envMapIntensity: 0.6 });
    const under = new THREE.MeshStandardMaterial({ color: lin(0x232856), roughness: 0.55, metalness: 0.3, envMap: G.envTex, envMapIntensity: 0.5 });
    const tower = new THREE.MeshStandardMaterial({ color: lin(0x161a36), roughness: 0.3, metalness: 0.7, envMap: G.envTex });
    const floorPlain = new THREE.MeshStandardMaterial({ color: lin(0x1f2350), roughness: 0.42, metalness: 0.2, envMap: G.envTex, envMapIntensity: 0.6 });
    const chrome = new THREE.MeshStandardMaterial({ color: lin(0xb8c0e8), roughness: 0.22, metalness: 0.9, envMap: G.envTex, envMapIntensity: 1.3 });
    const gateM = new THREE.MeshStandardMaterial({ color: lin(0x3a1450), roughness: 0.4, metalness: 0.3, emissive: lin(0x5a0e6a), emissiveIntensity: 0.5, transparent: true, opacity: 1 });
    const neon = col => new THREE.MeshBasicMaterial({ color: lin(col).multiplyScalar(1.9), toneMapped: false, fog: false });
    // «Гнев Зевса»: мармур, кришталь, золото, хмари, бампери
    const zMarble = new THREE.MeshStandardMaterial({ color: lin(0xe6e0d6), map: marbleTexture(), roughness: 0.36, metalness: 0, envMap: G.envTex, envMapIntensity: 0.55 });
    const zMarblePlain = new THREE.MeshStandardMaterial({ color: lin(0xd9d2c4), roughness: 0.38, metalness: 0, envMap: G.envTex, envMapIntensity: 0.55 });
    const zGlass = new THREE.MeshStandardMaterial({ color: lin(0xe8f6ff), roughness: 0.05, metalness: 0, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, envMap: G.envTex, envMapIntensity: 0.9 });
    const zGold = new THREE.MeshStandardMaterial({ color: lin(0xffcf5a), roughness: 0.22, metalness: 1, envMap: G.envTex, envMapIntensity: 1.25, emissive: lin(0x3a2600), emissiveIntensity: 0.25 });
    const zUnder = new THREE.MeshStandardMaterial({ color: lin(0xc9c2b4), roughness: 0.7, metalness: 0, envMap: G.envTex, envMapIntensity: 0.3 });
    const zColumn = new THREE.MeshStandardMaterial({ color: lin(0xf4f0e8), roughness: 0.45, metalness: 0, envMap: G.envTex, envMapIntensity: 0.4 });
    const zCloud = new THREE.MeshStandardMaterial({ color: lin(0xffffff), roughness: 1, metalness: 0, emissive: lin(0x9aa3bd), emissiveIntensity: 0.35 });
    const zBump = new THREE.MeshStandardMaterial({ color: lin(0xbfe8ff), roughness: 0.2, metalness: 0, emissive: lin(0x4fc3ff), emissiveIntensity: 1.1, envMap: G.envTex });
    const zGate = new THREE.MeshStandardMaterial({ color: lin(0xc9a24a), roughness: 0.3, metalness: 0.8, envMap: G.envTex, transparent: true, opacity: 1 });
    const pick = (name, old) => {
      if (/^ZS_Marble/.test(name)) return zMarble;
      if (/^ZS_Glass/.test(name)) return zGlass;
      if (/^ZS_Gold/.test(name)) return zGold;
      if (/^ZS_Under/.test(name)) return zUnder;
      if (/^ZS_Column/.test(name)) return zColumn;
      if (/^ZS_Cloud/.test(name)) return zCloud;
      if (/^ZS_Bumper/.test(name)) return zBump;
      if (/^ZS_Gate/.test(name)) return zGate;
      if (/Glass/.test(name)) return glass;
      if (/NeonCyan/.test(name)) return neon(0x2fe8ff);
      if (/NeonPink/.test(name)) return neon(0xff2fae);
      if (/NeonGold/.test(name)) return neon(0xffa52a);
      if (/Floor/.test(name)) return floor;
      if (/Under/.test(name)) return under;
      if (/Tower/.test(name)) return tower;
      if (/Gate/.test(name)) return gateM;
      return old;
    };
    let gate = null;
    root.traverse(o => {
      if (!o.isMesh) return;
      if (Array.isArray(o.material)) o.material = o.material.map(m => pick(m.name, m)); else o.material = pick(o.material.name, o.material);
      if (!o.geometry.attributes.uv) { const a = (Array.isArray(o.material) ? o.material : [o.material]).map(m => m === floor ? floorPlain : m === zMarble ? zMarblePlain : m); o.material = a.length === 1 ? a[0] : a; }
      if (/Pegs/.test(o.name)) { const a = (Array.isArray(o.material) ? o.material : [o.material]).map(m => m === tower ? chrome : m); o.material = a.length === 1 ? a[0] : a; }
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const isGlass = mats.every(m => m === glass || m === zGlass), isNeon = mats.every(m => m.isMeshBasicMaterial);
      if (mats.every(m => m === zCloud)) { o.castShadow = false; o.receiveShadow = false; return; }
      o.castShadow = !isGlass && !isNeon; o.receiveShadow = !isNeon;
      if (isGlass) o.renderOrder = 5;
      // ворота зникають на старті (прозорість) — свій матеріал, щоб не зникало все, що має такий самий (чаша тощо)
      if (/GATE/.test(o.name)) { gate = o; o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); }
    });
    // кілки: рухомі (неон) малюємо самі інстансами, нерухомі (колони Олімпу) — як є з GLB
    if (M.map.pegsMove) { root.traverse(o => { if (o.isMesh && /Pegs/.test(o.name)) o.visible = false; }); buildPegs(M.map, chrome); }
    else removePegs();
    // хмарні бампери: у кожного свій матеріал — спалахує при ударі
    G.bumpers = [];
    root.traverse(o => { const mm = o.isMesh && /ZS_Bumper_(\d+)/.exec(o.name); if (!mm) return;
      const k = +mm[1]; const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(m => m === zBump ? zBump.clone() : m);
      o.material = mats.length === 1 ? mats[0] : mats; const bm = mats.find(m => m.emissive && m.emissiveIntensity === 1.1); if (bm) G.bumpers[k] = bm; });
    buildBoosts(M.map);
    G.scene.add(root); G.track = root; G.trackId = mapId; G.gate = gate;
    if (gate) gate.userData.y0 = gate.position.y;
    resetGate();
  }
  // рухомі кілки: корпус «виростає» з підлоги (масштаб по осі), неонова кришка тьмяніє, коли кілок схований
  // бусти: неонова смуга на підлозі з шевронами, що біжать уперед (текстура зсувається щокадру)
  function chevronTex() {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = '#fff'; g.lineWidth = 16; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(22, 92); g.lineTo(64, 44); g.lineTo(106, 92); g.stroke();
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  function buildBoosts(map) {
    if (G.boosts) G.boosts.forEach(b => G.scene.remove(b));
    G.boosts = []; G.boostTex = null;
    if (!map.boost || !map.boost.length) return;
    const tex = chevronTex(); G.boostTex = tex;
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: lin(0x2fe8ff).multiplyScalar(2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
    for (const r of map.boost) {
      const pos = [], uv = [], idx = [];
      for (let i = r[0], k = 0; i <= r[1]; i++, k++) {
        const o = i * 3, half = Math.max(0.6, (map.W[i] - map.Rf[i]) * 0.9);
        for (const sd of [-1, 1]) {
          pos.push(map.fp[o] + map.fu[o] * 0.04 + map.fr[o] * half * sd, map.fp[o + 1] + map.fu[o + 1] * 0.04 + map.fr[o + 1] * half * sd, map.fp[o + 2] + map.fu[o + 2] * 0.04 + map.fr[o + 2] * half * sd);
          uv.push(sd < 0 ? 0 : 1, k * map.ds / 2.2);
        }
        if (k) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = 3; mesh.frustumCulled = false;
      G.scene.add(mesh); G.boosts.push(mesh);
    }
  }
  function removePegs() { if (G.pegBody) { G.scene.remove(G.pegBody); G.scene.remove(G.pegCap); G.pegBody = G.pegCap = null; } }
  function buildPegs(map, chrome) {
    removePegs();
    const P = map.pegs; if (!P.length) return;
    const r = P[0].r;
    const bg = new THREE.CylinderGeometry(r, r, 1, 16); bg.translate(0, 0.5, 0);
    const cg = new THREE.CylinderGeometry(r + 0.05, r + 0.05, 0.16, 16);
    const body = new THREE.InstancedMesh(bg, chrome, P.length), cap = new THREE.InstancedMesh(cg, new THREE.MeshBasicMaterial({ color: lin(0xff2fae).multiplyScalar(1.9), toneMapped: false, fog: false }), P.length);
    body.castShadow = true; body.receiveShadow = true; body.instanceMatrix.setUsage(THREE.DynamicDrawUsage); cap.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    body.frustumCulled = cap.frustumCulled = false;
    const up = new THREE.Vector3(0, 1, 0);
    G.pegQ = P.map(p => new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(p.ax, p.ay, p.az)));
    G.pegOff = new Float32Array(P.length);
    for (let q = 0; q < P.length; q++) cap.setColorAt(q, new THREE.Color(1, 1, 1));
    G.scene.add(body); G.scene.add(cap); G.pegBody = body; G.pegCap = cap;
  }
  const _pv = { p: null, s: null, m: null, c: null };
  function updatePegs(alpha) {
    if (!G.pegBody || !S) return;
    if (!_pv.p) { _pv.p = new THREE.Vector3(); _pv.s = new THREE.Vector3(); _pv.m = new THREE.Matrix4(); _pv.c = new THREE.Color(); }
    const P = S.map.pegs, off = G.pegOff;
    MB2Core.pegsAt(S, S.subT - (1 - alpha) * MB2Core.DT, off);
    for (let q = 0; q < P.length; q++) {
      const p = P[q], vis = Math.max(0.001, 2 * p.h + off[q] + 0.06);
      // основа — трохи під підлогою; корпус росте вгору на vis
      _pv.p.set(p.x - p.ax * (p.h + 0.06), p.y - p.ay * (p.h + 0.06), p.z - p.az * (p.h + 0.06));
      _pv.m.compose(_pv.p, G.pegQ[q], _pv.s.set(1, vis, 1)); G.pegBody.setMatrixAt(q, _pv.m);
      _pv.p.set(_pv.p.x + p.ax * vis, _pv.p.y + p.ay * vis, _pv.p.z + p.az * vis);
      _pv.m.compose(_pv.p, G.pegQ[q], _pv.s.set(1, 1, 1)); G.pegCap.setMatrixAt(q, _pv.m);
      const lv = 1 + off[q] / (2 * p.h + 0.08);   // 1 — піднятий, 0 — схований
      G.pegCap.setColorAt(q, _pv.c.setScalar(0.18 + 0.82 * lv));
    }
    G.pegBody.instanceMatrix.needsUpdate = true; G.pegCap.instanceMatrix.needsUpdate = true; G.pegCap.instanceColor.needsUpdate = true;
  }
  function resetGate() { const g = G.gate; if (!g) return; g.visible = true; g.position.y = g.userData.y0; g.material.opacity = 1; }

  // ── гонка ──
  let ST = null;   // стан відображення поточної гонки
  function newRace(order, M) {
    const N = order.length;
    // тіньовий бан: заблоковані їдуть разом з усіма, але не перелітають трамплін і виграти не можуть
    const noWin = []; if (typeof isBlacklisted === 'function') order.forEach((n, i) => { if (isBlacklisted(n)) noWin.push(i); });
    S = MB2Core.createSim(order, M.map, null, { noWin });
    ensureBalls(N);
    const col = new THREE.Color();
    for (let i = 0; i < G.cap; i++) {
      col.setHSL(((i * 137.508) % 360) / 360, 0.85, i % 3 === 0 ? 0.6 : 0.52).convertSRGBToLinear();
      G.balls.setColorAt(i, col);
    }
    G.balls.instanceColor.needsUpdate = true;
    G.balls.count = N;
    ST = {
      M, N, phase: 'intro', t: 0, px0: new Float32Array(N), py0: new Float32Array(N), pz0: new Float32Array(N),
      q: new Float32Array(N * 4), q0: new Float32Array(N * 4), rx: new Float32Array(N), ry: new Float32Array(N), rz: new Float32Array(N), ranking: [], boardAcc: 1, feedSeen: 0, feed: [], winShown: false, endShown: false, bigTxt: '',
      colors: Array.from({ length: N }, (_, i) => 'hsl(' + Math.round((i * 137.508) % 360) + ',78%,60%)'),
      gaps: gapCenters(M.map), finFocus: 0,
      bbox: trackBox(M.map),
    };
    for (let i = 0; i < N; i++) { ST.q[i * 4 + 3] = 1; const a = Math.random() * 6.28; ST.q[i * 4 + 1] = Math.sin(a); ST.q[i * 4 + 3] = Math.cos(a); }
    copyPrev(); ST.q0.set(ST.q);
    winnerName = null; announced = false; if (annTimer) { clearTimeout(annTimer); annTimer = 0; }
    S.onWinner = i => {
      winnerName = S.nicks[i]; ST.finFocus = 3.2;
      annTimer = setTimeout(announce, 1600);
    };
    Object.assign(G.cam, { init: false, mode: null, modeT: 0, si: 0, subj: -1, subjT: 0, spInit: false, cut: false });
    dom.board.innerHTML = ''; dom.rows = []; dom.feed.innerHTML = ''; dom.win.classList.remove('on'); dom.end.classList.remove('on');
    dom.cd.style.display = 'none'; dom.name.textContent = MAPS[mapId].name;
    dom.alive.textContent = N + '/' + N; dom.time.textContent = '00:00.0';
  }
  function trackBox(m) {
    const b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
    for (let i = 0; i < m.n * 3; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], m.fp[i + k]); b[k + 3] = Math.max(b[k + 3], m.fp[i + k]); }
    b[4] = Math.max(b[4], m.box.c[1] + m.box.h);
    return b;
  }
  function gapCenters(m) {
    const out = []; let a = -1;
    for (let i = 0; i < m.n; i++) { if (m.open[i] && a < 0) a = i; if (!m.open[i] && a >= 0) { out.push([a, i, (a + i) >> 1]); a = -1; } }
    return out;
  }
  function copyPrev() { ST.px0.set(S.px); ST.py0.set(S.py); ST.pz0.set(S.pz); }
  function announce() {
    annTimer = 0;
    if (announced || !winnerName) return;
    announced = true;
    dom.winN.textContent = winnerName; dom.win.classList.add('on');
    setTimeout(() => dom && dom.win.classList.remove('on'), 5200);
    if (typeof addWinner === 'function') addWinner(winnerName);
  }

  // фізичний крок + кочення
  function physStep() {
    copyPrev(); ST.q0.set(ST.q);
    MB2Core.step(S);
    const q = ST.q, dt = MB2Core.DT, R = MB2Core.R;
    for (let i = 0; i < S.N; i++) {
      if (!S.alive[i] || S.fin[i] === 2) continue;
      const wx = S.vz[i] / R, wz = -S.vx[i] / R, w = Math.hypot(wx, wz);
      if (w < 1e-3) continue;
      const ang = w * dt * 0.5, s = Math.sin(ang) / w, ax = wx * s, az = wz * s, aw = Math.cos(ang);
      const o = i * 4, x = q[o], y = q[o + 1], z = q[o + 2], ww = q[o + 3];
      // dq * q, dq = (ax, 0, az, aw)
      q[o] = aw * x + ax * ww + 0 * z - az * y;
      q[o + 1] = aw * y - ax * z + 0 * ww + az * x;
      q[o + 2] = aw * z + ax * y - 0 * x + az * ww;
      q[o + 3] = aw * ww - ax * x - 0 * y - az * z;
      const n = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]); q[o] /= n; q[o + 1] /= n; q[o + 2] /= n; q[o + 3] /= n;
    }
  }

  // запис матриць інстансів
  function writeInstances(alpha) {
    const a = G.balls.instanceMatrix.array, q = ST.q, N = S.N;
    for (let i = 0; i < N; i++) {
      let x, y, z, sc = 1;
      if (!S.alive[i]) {
        // вибулий падає далі ще 2 с і зникає
        const t = S.raceT - S.elimT[i];
        if (t > 2) sc = 0;
        x = S.px[i] + S.vx[i] * t; y = S.py[i] + S.vy[i] * t - 7.5 * t * t; z = S.pz[i] + S.vz[i] * t;
      } else {
        x = ST.px0[i] + (S.px[i] - ST.px0[i]) * alpha; y = ST.py0[i] + (S.py[i] - ST.py0[i]) * alpha; z = ST.pz0[i] + (S.pz[i] - ST.pz0[i]) * alpha;
        if (S.fin[i] === 2) sc = 0;
        else if (S.fin[i] === 1) { const t = S.raceT - S.finT[i]; if (t > 3.5) sc = Math.max(0, (4 - t) / 0.5); }
      }
      ST.rx[i] = x; ST.ry[i] = y; ST.rz[i] = z;
      const o = i * 16;
      if (sc <= 0) { a.fill(0, o, o + 16); continue; }
      // обертання теж інтерполюємо (nlerp між кроками фізики), інакше візерунок «стрибає» на 144 Гц
      const j = i * 4, q0 = ST.q0, sg = (q0[j] * q[j] + q0[j + 1] * q[j + 1] + q0[j + 2] * q[j + 2] + q0[j + 3] * q[j + 3]) < 0 ? -1 : 1;
      let qx = q0[j] + (q[j] * sg - q0[j]) * alpha, qy = q0[j + 1] + (q[j + 1] * sg - q0[j + 1]) * alpha,
        qz = q0[j + 2] + (q[j + 2] * sg - q0[j + 2]) * alpha, qw = q0[j + 3] + (q[j + 3] * sg - q0[j + 3]) * alpha;
      const ql = 1 / Math.hypot(qx, qy, qz, qw); qx *= ql; qy *= ql; qz *= ql; qw *= ql;
      const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz, xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
      a[o] = (1 - (yy + zz)) * sc; a[o + 1] = (xy + wz) * sc; a[o + 2] = (xz - wy) * sc; a[o + 3] = 0;
      a[o + 4] = (xy - wz) * sc; a[o + 5] = (1 - (xx + zz)) * sc; a[o + 6] = (yz + wx) * sc; a[o + 7] = 0;
      a[o + 8] = (xz + wy) * sc; a[o + 9] = (yz - wx) * sc; a[o + 10] = (1 - (xx + yy)) * sc; a[o + 11] = 0;
      a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
    }
    G.balls.instanceMatrix.needsUpdate = true;
  }

  // ── рейтинг, HUD, лідерборд, кілфід ──
  function rankNow() {
    const out = S.finishOrder.slice(), rest = [];
    for (let i = 0; i < S.N; i++) if (S.alive[i] && !S.fin[i]) rest.push(i);
    rest.sort((a, b) => S.prog[b] - S.prog[a]);
    ST.ranking = out.concat(rest); ST.racing = rest;
  }
  function fmtT(t) { const m = Math.floor(t / 60), s = t - m * 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function hud(dt) {
    dom.time.textContent = fmtT(S.raceT);
    let left = 0; for (let i = 0; i < S.N; i++) if (S.alive[i] && !S.fin[i]) left++;
    dom.alive.textContent = left + '/' + S.N;
    if (S.firstFinishT != null && !S.done) { dom.cd.style.display = ''; dom.cd.textContent = Math.max(0, Math.ceil(60 - (S.raceT - S.firstFinishT))); }
    else dom.cd.style.display = 'none';
    ST.boardAcc += dt;
    if (ST.boardAcc >= 0.25) { ST.boardAcc = 0; rankNow(); board(); }
    // кілфід
    while (ST.feedSeen < S.eliminated.length) {
      const i = S.eliminated[ST.feedSeen++];
      const el = document.createElement('div'); el.className = 'mb2-kill';
      el.innerHTML = '<i style="background:' + ST.colors[i] + '"></i><b>' + esc(S.nicks[i]) + '</b><span>' + esc(S.cause[i]) + '</span>';
      dom.feed.prepend(el); ST.feed.push({ el, t: 0 });
      while (dom.feed.children.length > 5) { dom.feed.lastChild.remove(); }
    }
    for (const f of ST.feed) { f.t += dt; if (f.t > 4.5 && !f.gone) { f.gone = true; f.el.classList.add('out'); setTimeout(() => f.el.remove(), 400); } }
    ST.feed = ST.feed.filter(f => f.t < 6);
  }
  function board() {
    const top = ST.ranking.slice(0, 10), lead = top.length ? top[0] : -1;
    while (dom.rows.length < top.length) { const r = document.createElement('div'); r.className = 'mb2-row'; r.innerHTML = '<span class="mb2-pos"></span><i></i><b></b><span class="mb2-gap"></span>'; dom.board.appendChild(r); dom.rows.push(r); }
    for (let k = 0; k < dom.rows.length; k++) {
      const r = dom.rows[k], i = top[k];
      if (i == null) { r.style.display = 'none'; continue; }
      r.style.display = '';
      if (r._i !== i) { r._i = i; r.children[1].style.background = ST.colors[i]; r.children[2].textContent = S.nicks[i]; r.children[0].textContent = k + 1; r.classList.toggle('gold', k === 0); }
      else r.children[0].textContent = k + 1;
      let gap = '';
      if (S.fin[i]) gap = fmtT(S.finT[i]);
      else if (k > 0 && !S.fin[lead]) gap = '−' + Math.max(0, S.prog[lead] - S.prog[i]).toFixed(0) + ' м';
      else if (k === 0) gap = Math.min(100, Math.max(0, S.prog[i] / S.map.len * 100)).toFixed(0) + '%';
      else gap = Math.max(0, S.map.len - S.prog[i]).toFixed(0) + ' м';
      r.children[3].textContent = gap;
    }
  }
  // мітки з ніками над топ-10
  const pv = () => (G.v3);
  function labels() {
    const w = dom.root.clientWidth, h = dom.root.clientHeight, cam = G.camera, v = pv();
    const list = (ST.racing || []).slice(0, LABELS);
    for (let k = 0; k < LABELS; k++) {
      const L = dom.lab[k], i = list[k];
      if (i == null || ST.phase === 'intro') { if (L.on) { L.el.style.display = 'none'; L.on = false; } continue; }
      v.set(ST.rx[i], ST.ry[i] + 1.1, ST.rz[i]);
      const d = v.distanceTo(cam.position);
      v.project(cam);
      if (v.z > 1 || d > 60 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) { if (L.on) { L.el.style.display = 'none'; L.on = false; } continue; }
      if (!L.on) { L.el.style.display = 'block'; L.on = true; }
      const txt = (k + 1 + S.finishOrder.length) + ' ' + S.nicks[i];
      if (L.txt !== txt) { L.txt = txt; L.el.textContent = txt; L.el.style.borderColor = ST.colors[i]; L.el.classList.toggle('gold', k === 0 && !S.finishOrder.length); }
      L.el.style.transform = 'translate(' + ((v.x * 0.5 + 0.5) * w).toFixed(1) + 'px,' + ((-v.y * 0.5 + 0.5) * h).toFixed(1) + 'px) translate(-50%,-100%)';
      L.el.style.opacity = d > 40 ? (60 - d) / 20 : 1;
    }
  }

  // ── режисер камери ──
  // План обирається з «гістерезисом» (мінімум 2.5 с до наступної склейки), обʼєкт зйомки
  // тримається щонайменше 2.5 с, а позиція кульки й напрям траси для камери згладжені —
  // інакше кадр смикається на кожній зміні лідера і на кожній рамці траси.
  const SHOTS = ['chase', 'side', 'chase', 'top', 'pack'];
  const HOLD = 2.5;
  // рамка траси в дробовій позиції (між сусідніми рамками — лінійно)
  function frameLerp(sIdx, out) {
    const m = S.map, n = m.n, i0 = Math.max(0, Math.min(n - 2, Math.floor(sIdx))), t = Math.max(0, Math.min(1, sIdx - i0)), a = i0 * 3, b = a + 3;
    for (let k = 0; k < 3; k++) {
      out.p[k] = m.fp[a + k] + (m.fp[b + k] - m.fp[a + k]) * t; out.t[k] = m.ft[a + k] + (m.ft[b + k] - m.ft[a + k]) * t;
      out.u[k] = m.fu[a + k] + (m.fu[b + k] - m.fu[a + k]) * t; out.r[k] = m.fr[a + k] + (m.fr[b + k] - m.fr[a + k]) * t;
    }
    return out;
  }
  const FR = { p: [0, 0, 0], t: [0, 0, 0], u: [0, 0, 0], r: [0, 0, 0] };
  function wantMode(subj) {
    const C = G.cam, m = S.map;
    if (ST.phase === 'intro' || S.raceT < 1.2) return 'intro';
    if (ST.finFocus > 0) return 'fin';
    if (subj < 0) return 'end';
    if (S.zone[subj] === 0 || (S.map.raw.theme === 'zeus' && S.idx[subj] < 70)) return 'funnel';
    const idx = S.idx[subj];
    for (const g of ST.gaps) if (idx > g[0] - 60 && idx < g[1] + 16) return 'gap' + g[2];
    const tw = m.raw.tower;
    if (tw && tw.hr && S.zone[subj] === 1) {
      const d = Math.hypot(ST.rx[subj] - tw.c[0], ST.rz[subj] - tw.c[2]);
      if (Math.abs(d - tw.hr) < 6 && ST.ry[subj] < tw.z0 + 2.5) return 'helix';
    }
    return SHOTS[C.si || 0];
  }
  function pickSubject(dt) {
    const C = G.cam, racing = ST.racing || [];
    C.subjT = (C.subjT || 0) + dt;
    const ok = C.subj >= 0 && C.subj < S.N && S.alive[C.subj] && !S.fin[C.subj];
    let want = racing.length ? racing[0] : -1;
    if (C.mode === 'pack' && racing.length > 20) want = racing[Math.floor(racing.length * 0.25)];
    if ((!ok || C.subjT > HOLD) && want !== C.subj) { C.subj = want; C.subjT = 0; C.snapSubj = true; }
    return C.subj;
  }
  function camTarget(dt, pos, look) {
    const C = G.cam, m = S.map;
    const subj = pickSubject(dt);
    // вибір плану
    C.modeT = (C.modeT || 0) + dt;
    if (C.mode && SHOTS.indexOf(C.mode) >= 0 && C.modeT > 7.5) C.si = ((C.si || 0) + 1) % SHOTS.length;
    const want = wantMode(subj);
    if (want !== C.mode && (C.modeT > HOLD || !C.mode || C.mode === 'intro' || C.mode === 'fin' || C.mode === 'end' || want === 'fin' || want === 'end')) {
      C.mode = want; C.modeT = 0; C.cut = true;
    }
    // згладжені позиція обʼєкта і напрям траси
    if (subj >= 0) {
      const sp = C.sp || (C.sp = new THREE.Vector3()), tv = C.tv || (C.tv = new THREE.Vector3()), rv = C.rv || (C.rv = new THREE.Vector3());
      const sIdx = S.zone[subj] === 1 ? Math.max(0, S.prog[subj] / m.ds) : 0;
      frameLerp(sIdx + 6, FR);
      const snap = C.cut || C.snapSubj || !C.spInit; C.snapSubj = false; C.spInit = true;
      // зміна обʼєкта без зміни плану — плавно перевозимо камеру (повільніше, ніж стежимо)
      const ks = snap && C.cut ? 1 : 1 - Math.exp(-(C.subjT < 1 ? 2.5 : 4.5) * dt), kt = C.cut ? 1 : 1 - Math.exp(-2.5 * dt);
      sp.x += (ST.rx[subj] - sp.x) * ks; sp.y += (ST.ry[subj] - sp.y) * ks; sp.z += (ST.rz[subj] - sp.z) * ks;
      tv.x += (FR.t[0] - tv.x) * kt; tv.y += (FR.t[1] - tv.y) * kt; tv.z += (FR.t[2] - tv.z) * kt; tv.normalize();
      rv.x += (FR.r[0] - rv.x) * kt; rv.y += (FR.r[1] - rv.y) * kt; rv.z += (FR.r[2] - rv.z) * kt; rv.normalize();
    }
    const mode = C.mode;
    if (mode === 'intro') {
      const B = m.box.c, a = 0.9 + ST.t * 0.22, r = 30;
      pos.set(B[0] + Math.cos(a) * r, B[1] + 14, B[2] + Math.sin(a) * r); look.set(B[0], B[1] - 2, B[2]); return 1.5;
    }
    if (mode === 'fin' || mode === 'end') {
      const b = m.bowl.c, f = frameLerp(m.n - 1, FR), zs = m.raw.theme === 'zeus';
      pos.set(b[0] - f.t[0] * (zs ? 12 : 16) + f.r[0] * (zs ? 4 : 9), b[1] + (zs ? 17 : 11), b[2] - f.t[2] * (zs ? 12 : 16) + f.r[2] * (zs ? 4 : 9)); look.set(b[0], b[1] + 1, b[2]); return 2;
    }
    if (mode === 'funnel') {
      const F = m.funnel.c;
      pos.set(F[0] + 16, F[1] + 20, F[2] + 18); look.set(F[0], F[1] - 4, F[2] - 3); return 2;
    }
    const P = C.sp, T = C.tv, Rr = C.rv, x = P.x, y = P.y, z = P.z;
    if (mode.startsWith('gap')) {
      // статична камера збоку від провалу, погляд — між кулькою і центром стрибка
      const f = frameLerp(+mode.slice(3), FR);
      pos.set(f.p[0] + f.r[0] * 11 - f.t[0] * 2, f.p[1] + 2.6, f.p[2] + f.r[2] * 11 - f.t[2] * 2);
      look.set((x + f.p[0]) * 0.5, (y + f.p[1]) * 0.5 - 1, (z + f.p[2]) * 0.5); return 3;
    }
    if (mode === 'helix') {
      // всередині спіралі, між вежею і жолобом: віраж нахилений до центру, внутрішній борт низький
      const tw = m.raw.tower, dx = x - tw.c[0], dz = z - tw.c[2], d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d, R2 = tw.r + 1.6;
      pos.set(tw.c[0] + ux * R2 - T.x * 6, y + 4.2, tw.c[2] + uz * R2 - T.z * 6); look.set(x + T.x * 3, y + 0.3, z + T.z * 3); return 4;
    }
    if (mode === 'chase') { pos.set(x - T.x * 9, y - T.y * 9 + 4.2, z - T.z * 9); look.set(x + T.x * 6, y + T.y * 6, z + T.z * 6); return 3; }
    if (mode === 'side') { pos.set(x + Rr.x * 10 + T.x * 3, y + 3.5, z + Rr.z * 10 + T.z * 3); look.set(x + T.x * 2, y, z + T.z * 2); return 2.5; }
    if (mode === 'top') { pos.set(x - T.x * 4, y + 17, z - T.z * 4); look.set(x + T.x * 3, y, z + T.z * 3); return 2.5; }
    pos.set(x - T.x * 16 + Rr.x * 6, y + 10, z - T.z * 16 + Rr.z * 6); look.set(x + T.x * 4, y, z + T.z * 4); return 2;
  }
  const tp = { a: null, b: null };
  function updateCamera(dt) {
    const C = G.cam, cam = G.camera;
    if (!tp.a) { tp.a = new THREE.Vector3(); tp.b = new THREE.Vector3(); }
    if (fly.on) { flyUpdate(dt); return; }
    const k = camTarget(dt, tp.a, tp.b);
    // новий план — жорстка склейка, як у трансляції (а не проліт крізь пів траси)
    if (C.cut) { C.cut = false; C.init = false; }
    if (!C.init) { C.pos.copy(tp.a); C.look.copy(tp.b); C.init = true; }
    C.pos.lerp(tp.a, 1 - Math.exp(-k * dt)); C.look.lerp(tp.b, 1 - Math.exp(-k * 1.8 * dt));
    cam.position.copy(C.pos); cam.lookAt(C.look);
    if (C.shake > 0.01) { const a = C.shake; cam.position.x += (Math.random() - 0.5) * a; cam.position.y += (Math.random() - 0.5) * a; cam.position.z += (Math.random() - 0.5) * a; C.shake *= Math.exp(-7 * dt); }
  }
  // ── вільний політ (як у старих Шариках): WASD — рух, миша — огляд (pointer lock або затиснута кнопка),
  //    Space/E — вгору, C/Q — вниз, Shift — швидше, колесо — швидкість. Ctrl не чіпаємо: Ctrl+W закриває вкладку ──
  const PITCH_MAX = 1.45;
  const fly = { on: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, mul: 1, k: {}, drag: false, lx: 0, ly: 0, big: 0, bound: false };
  function flyLock() {
    const cv = dom.canvas; if (document.pointerLockElement === cv) return;
    // unadjustedMovement — «сирий» рух без прискорення ОС (з ним у Chrome трапляються фантомні стрибки)
    const plain = () => { try { const r2 = cv.requestPointerLock(); if (r2 && r2.catch) r2.catch(() => {}); } catch (e) { /* лишається drag-огляд */ } };
    try { const r = cv.requestPointerLock({ unadjustedMovement: true }); if (r && r.catch) r.catch(plain); } catch (e) { plain(); }
  }
  function flyLook(mx, my) {
    const big = Math.max(Math.abs(mx), Math.abs(my));
    // поодинокий викид movementX у сотні пікселів — не рух руки, відкидаємо
    if (big > 160 && big > fly.big * 4 + 40) { fly.big = Math.min(fly.big, 60); return; }
    fly.big = big;
    mx = Math.max(-120, Math.min(120, mx)); my = Math.max(-120, Math.min(120, my));
    fly.yaw += mx * 0.0022;
    fly.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, fly.pitch - my * 0.0022));
    hint(false);
  }
  const KEYS = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', Space: 'up', KeyE: 'up', KeyC: 'dn', KeyQ: 'dn', ShiftLeft: 'boost', ShiftRight: 'boost' };
  function bindFly() {
    if (fly.bound) return; fly.bound = true;
    const act = () => fly.on && dom && dom.root.classList.contains('visible');
    window.addEventListener('keydown', e => {
      if (!act()) return;
      const k = KEYS[e.code]; if (!k) return;
      // поле вводу (чат тощо) не перехоплюємо
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      fly.k[k] = true; e.preventDefault(); e.stopPropagation(); hint(false);
    }, true);
    window.addEventListener('keyup', e => { const k = KEYS[e.code]; if (k) fly.k[k] = false; }, true);
    window.addEventListener('blur', () => { fly.k = {}; });
    dom.canvas.addEventListener('mousedown', e => {
      if (!act()) return;
      if (document.pointerLockElement !== dom.canvas) flyLock();
      fly.drag = true; fly.lx = e.clientX; fly.ly = e.clientY;
    });
    window.addEventListener('mouseup', () => { fly.drag = false; });
    document.addEventListener('pointerlockchange', () => { fly.drag = false; fly.big = 0; });
    window.addEventListener('mousemove', e => {
      if (!act()) return;
      if (document.pointerLockElement === dom.canvas) flyLook(e.movementX || 0, e.movementY || 0);
      else if (fly.drag) { flyLook(e.clientX - fly.lx, e.clientY - fly.ly); fly.lx = e.clientX; fly.ly = e.clientY; }
    });
    dom.canvas.addEventListener('wheel', e => {
      if (!act()) return;
      e.preventDefault();
      fly.mul = Math.max(0.15, Math.min(8, fly.mul * Math.pow(1.15, -e.deltaY / 100)));
    }, { passive: false });
  }
  let hintTo = 0;
  function hint(show) {
    if (!dom) return;
    clearTimeout(hintTo); dom.hint.classList.toggle('on', !!show);
    if (show) hintTo = setTimeout(() => dom && dom.hint.classList.remove('on'), 5000);
  }
  function flyUpdate(dt) {
    const k = fly.k, spd = 22 * fly.mul * (k.boost ? 2.6 : 1);
    const cp = Math.cos(fly.pitch), sp = Math.sin(fly.pitch), cy = Math.cos(fly.yaw), sy = Math.sin(fly.yaw);
    let tx = 0, ty = 0, tz = 0;
    if (k.w) { tx += cp * cy; ty += sp; tz += cp * sy; }
    if (k.s) { tx -= cp * cy; ty -= sp; tz -= cp * sy; }
    if (k.a) { tx += sy; tz -= cy; }
    if (k.d) { tx -= sy; tz += cy; }
    if (k.up) ty += 1;
    if (k.dn) ty -= 1;
    const len = Math.hypot(tx, ty, tz), s = len > 1e-4 ? spd / len : 0, a = 1 - Math.exp(-dt * 8);
    fly.vx += (tx * s - fly.vx) * a; fly.vy += (ty * s - fly.vy) * a; fly.vz += (tz * s - fly.vz) * a;
    fly.px += fly.vx * dt; fly.py += fly.vy * dt; fly.pz += fly.vz * dt;
    // не відлітаємо від траси далі ніж на 150 м
    const B = ST && ST.bbox;
    if (B) {
      fly.px = Math.max(B[0] - 150, Math.min(B[3] + 150, fly.px)); fly.py = Math.max(B[1] - 40, Math.min(B[4] + 150, fly.py)); fly.pz = Math.max(B[2] - 150, Math.min(B[5] + 150, fly.pz));
    }
    const cam = G.camera;
    cam.position.set(fly.px, fly.py, fly.pz);
    cam.lookAt(fly.px + cp * cy, fly.py + sp, fly.pz + cp * sy);
    G.cam.look.set(fly.px + cp * cy * 25, fly.py + sp * 25, fly.pz + cp * sy * 25);   // сюди ж ставимо тінь
  }
  function setFree(on) {
    const C = G && G.cam; if (!C || !dom) return;
    on = !!on;
    if (on && !fly.on) {
      bindFly();
      const cam = G.camera, d = new THREE.Vector3().subVectors(C.look, cam.position);
      fly.px = cam.position.x; fly.py = cam.position.y; fly.pz = cam.position.z;
      fly.yaw = Math.atan2(d.z, d.x); fly.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Math.atan2(d.y, Math.hypot(d.x, d.z) || 1e-4)));
      fly.vx = fly.vy = fly.vz = 0; fly.k = {}; fly.mul = 1; fly.on = true;
      flyLock(); hint(true);
    } else if (!on && fly.on) {
      fly.on = false; fly.drag = false; fly.k = {};
      if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) { /* не наш lock */ } }
      hint(false);
      // режисер підхоплює з поточного кадру — без ривка
      C.cut = true;
    }
    C.free = fly.on;
    dom.free.classList.toggle('on', fly.on); dom.auto.classList.toggle('on', !fly.on);
  }

  // сонце й тінь — за точкою огляду
  function updateSun() {
    const L = G.cam.look, s = G.sun;
    s.target.position.copy(L); s.position.set(L.x + 30, L.y + 60, L.z + 22); s.target.updateMatrixWorld();
    if (G.halo.visible = !!(ST.racing && ST.racing.length && ST.phase !== 'intro')) {
      const i = ST.racing[0]; G.halo.position.set(ST.rx[i], ST.ry[i] + 1.25 + Math.sin(ST.t * 5) * 0.12, ST.rz[i]);
    }
  }

  // ── блискавки (події з ядра: S.strikes) ──
  const boltMat = () => new THREE.MeshBasicMaterial({ color: lin(0xd6e9ff).multiplyScalar(5), toneMapped: false, fog: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  function boltPath(a, b, segs, jag) {
    const path = new THREE.CurvePath(); let prev = a.clone();
    for (let k = 1; k <= segs; k++) {
      const t = k / segs, p = a.clone().lerp(b, t);
      if (k < segs) { p.x += (Math.random() - 0.5) * jag * (1 - t * 0.6); p.z += (Math.random() - 0.5) * jag * (1 - t * 0.6); }
      path.add(new THREE.LineCurve3(prev, p)); prev = p;
    }
    return path;
  }
  function spawnStrike(e) {
    const end = new THREE.Vector3(e.x, e.y, e.z), top = new THREE.Vector3(e.x + (Math.random() - 0.5) * 14, e.y + 46, e.z + (Math.random() - 0.5) * 14);
    const grp = new THREE.Group(), mat = boltMat();
    grp.add(new THREE.Mesh(new THREE.TubeGeometry(boltPath(top, end, 16, 5), 64, 0.13, 5), mat));
    for (let k = 0; k < 3; k++) {     // гілки
      const from = top.clone().lerp(end, 0.25 + Math.random() * 0.5), to = from.clone().add(new THREE.Vector3((Math.random() - 0.5) * 12, -6 - Math.random() * 8, (Math.random() - 0.5) * 12));
      grp.add(new THREE.Mesh(new THREE.TubeGeometry(boltPath(from, to, 6, 3), 24, 0.06, 4), mat));
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.0, 40), new THREE.MeshBasicMaterial({ color: lin(0xbfe0ff).multiplyScalar(4), toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.copy(end).y += 0.15; ring.rotation.x = -Math.PI / 2; grp.add(ring);
    G.scene.add(grp);
    G.bolts.push({ grp, ring, mat, t: 0 });
    G.flashL.position.copy(end).y += 4; G.flashT = 0.38;
    const d = end.distanceTo(G.camera.position);
    if (d < 70) { G.cam.shake = Math.max(G.cam.shake || 0, 0.7 * (1 - d / 70)); dom.flash.classList.remove('on'); void dom.flash.offsetWidth; dom.flash.classList.add('on'); }
  }
  function updateFx(dt) {
    if (G.boostTex) G.boostTex.offset.y -= dt * 2.4;   // шеврони біжать уперед
    if (S && S.strikes.length) { for (const e of S.strikes) spawnStrike(e); S.strikes.length = 0; }
    for (let i = G.bolts.length - 1; i >= 0; i--) {
      const b = G.bolts[i]; b.t += dt;
      b.grp.children.forEach(c => { if (c !== b.ring) c.visible = b.t < 0.32 && (b.t < 0.08 || Math.random() > 0.35); });   // мерехтіння
      b.mat.opacity = Math.max(0, 1 - b.t / 0.32);
      const k = Math.min(1, b.t / 0.5); b.ring.scale.setScalar(1 + k * 4.5); b.ring.material.opacity = 1 - k;
      if (b.t > 0.55) { G.scene.remove(b.grp); b.grp.traverse(o => { if (o.geometry) o.geometry.dispose(); }); b.mat.dispose(); b.ring.material.dispose(); G.bolts.splice(i, 1); }
    }
    if (G.flashT > 0) { G.flashT -= dt; G.flashL.intensity = Math.max(0, G.flashT / 0.38) * 14 * (Math.random() > 0.3 ? 1 : 0.4); } else G.flashL.intensity = 0;
    // хмарні бампери спалахують при ударі
    if (G.bumpers && S) S.map.bumpers.forEach((bp, k) => { const m = G.bumpers[k]; if (!m) return; const age = S.t - bp.hit; m.emissiveIntensity = 1.1 + (age >= 0 && age < 0.3 ? (1 - age / 0.3) * 3.5 : 0); });
  }

  // ── цикл ──
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (window.__mb2.paused) { lastTs = ts; return; }
    const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0); lastTs = ts;
    frame(dt);
  }
  function frame(dt) {
    if (!S || !ST) return;
    ST.t += dt;
    if (ST.phase === 'intro') {
      const left = INTRO - ST.t;
      const txt = left > 3 ? '' : left > 0 ? String(Math.ceil(left)) : '';
      bigText(txt);
      if (left <= 0) { ST.phase = 'race'; MB2Core.openGate(S); bigText('СТАРТ!', 900); }
    }
    // ворота опускаються
    if (G.gate && S.gateOpen && G.gate.visible) {
      G.gate.position.y -= dt * 6; G.gate.material.opacity = Math.max(0, G.gate.material.opacity - dt * 2.2);
      if (G.gate.material.opacity <= 0) G.gate.visible = false;
    }
    acc += dt; let n = 0;
    while (acc >= MB2Core.DT && n < 4) { physStep(); acc -= MB2Core.DT; n++; }
    if (n === 4) acc = 0;
    if (ST.finFocus > 0) ST.finFocus -= dt;
    if (ST.phase === 'race') {
      hud(dt);
      if (S.done && !ST.endShown) {
        ST.endShown = true; ST.phase = 'done'; rankNow(); board();
        const fin = MB2Core.standings(S);
        window.mbLastResults = fin.slice(0, 10).map(i => S.nicks[i]);
        if (!winnerName && fin.length) { winnerName = S.nicks[fin[0]]; announce(); }
        dom.end.classList.add('on'); dom.cd.style.display = 'none';
      }
    } else if (ST.phase === 'intro') { if (!ST.ranking.length) { rankNow(); } }
    writeInstances(Math.min(1, acc / MB2Core.DT)); updatePegs(Math.min(1, acc / MB2Core.DT));
    updateFx(dt); updateCamera(dt); updateSun(); labels();
    if (G.composer) G.composer.render(); else G.renderer.render(G.scene, G.camera);
  }
  let bigTo = 0;
  function bigText(t, ms) {
    if (ST.bigTxt === t && !ms) return; ST.bigTxt = t;
    dom.big.textContent = t; dom.big.classList.toggle('on', !!t);
    if (t) { dom.big.classList.remove('pop'); void dom.big.offsetWidth; dom.big.classList.add('pop'); }
    if (ms) { clearTimeout(bigTo); bigTo = setTimeout(() => { if (dom) { dom.big.classList.remove('on'); ST && (ST.bigTxt = ''); } }, ms); }
  }

  // ── вибір траси ──
  let pickResolve = null;
  function pickMap() {
    const ids = Object.keys(MAPS).filter(id => !MAPS[id].hidden);
    if (ids.length < 2) return Promise.resolve(ids[0]);
    dom.pickCards.innerHTML = ids.map((id, k) => { const m = MAPS[id];
      return '<button class="mb2-card" type="button" data-id="' + id + '" style="--c1:' + m.look[0] + ';--c2:' + m.look[1] + ';--c3:' + m.look[2] + '">' +
        '<span class="mb2-card-art"></span><span class="mb2-card-n">' + m.name + '</span><span class="mb2-card-k">' + (k + 1) + '</span></button>'; }).join('') +
      '<button class="mb2-card mb2-card-rnd" type="button" data-id="*"><span class="mb2-card-art"></span><span class="mb2-card-n">Случайная</span><span class="mb2-card-k">' + (ids.length + 1) + '</span></button>';
    dom.pick.classList.add('on');
    return new Promise(res => {
      pickResolve = res;
      const done = id => { if (!pickResolve) return; pickResolve = null; dom.pick.classList.remove('on'); document.removeEventListener('keydown', onKey, true);
        res(id === '*' ? ids[Math.floor(Math.random() * ids.length)] : id); };
      dom.pickCards.onclick = e => { const b = e.target.closest('.mb2-card'); if (b) done(b.dataset.id); };
      const onKey = e => { const k = parseInt(e.key, 10); if (k >= 1 && k <= ids.length + 1) { e.preventDefault(); done(k === ids.length + 1 ? '*' : ids[k - 1]); } };
      document.addEventListener('keydown', onKey, true);
      const prev = pickResolve; pickResolve = id => { document.removeEventListener('keydown', onKey, true); dom.pick.classList.remove('on'); prev(id); };
    });
  }
  async function otherMap() {
    if (!baseList.length) return;
    dom.end.classList.remove('on');
    if (S && !announced && winnerName) announce();
    const id = await pickMap();
    if (!id || !dom.root.classList.contains('visible')) { dom.end.classList.add('on'); return; }
    mapId = id; return restart();
  }

  // ── публічний контракт ──
  async function startMarbles2Game() {
    ensureDom();
    const list = (typeof state !== 'undefined' && Array.isArray(state.participants)) ? state.participants.slice() : [];
    if (list.length < 2) return alert('Нужно минимум 2 участника');
    if (typeof THREE === 'undefined' || !THREE.GLTFLoader) return alert('Шарики: three.js не загрузился');
    baseList = list;
    if (typeof phase !== 'undefined') phase = 'racing';
    dom.root.classList.add('visible'); dom.end.classList.remove('on');
    gfxInit(); resize();
    loadPost();
    const picked = await pickMap();
    if (!picked || !dom.root.classList.contains('visible')) { if (!picked) closeMarbles2Overlay(); return; }
    mapId = picked;
    loading('Загружаем трассу…');
    let M;
    try { [M] = await Promise.all([loadMap(mapId), loadPost()]); }
    catch (e) { console.error('[mb2] карта не загрузилась', e); alert('Шарики: не удалось загрузить трассу'); closeMarbles2Overlay(); return; }
    if (!dom.root.classList.contains('visible')) return;
    setupComposer();
    applyTheme(MAPS[mapId].theme); buildTrack(M);
    loading('Жеребьёвка стартовых мест…');
    const order = await rollPick(list, list.length, 'Шарики: стартовый порядок ' + list.length + ' шариков');
    if (!dom.root.classList.contains('visible')) return;
    begin(order, M);
  }
  function begin(order, M) {
    loading(null);
    newRace(order, M);
    setFree(false);
    if (!raf) { lastTs = performance.now(); acc = 0; raf = requestAnimationFrame(loop); }
  }
  async function restart() {
    if (!baseList.length) return;
    dom.end.classList.remove('on');
    if (S && !announced && winnerName) announce();
    loading('Жеребьёвка стартовых мест…');
    const [M, order] = await Promise.all([loadMap(mapId), rollPick(baseList, baseList.length, 'Шарики: стартовый порядок ' + baseList.length + ' шариков')]);
    if (!dom.root.classList.contains('visible')) return;
    applyTheme(MAPS[mapId].theme); buildTrack(M); begin(order, M);
  }
  function closeMarbles2Overlay() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (annTimer) { clearTimeout(annTimer); annTimer = 0; }
    if (S && !announced && winnerName) announce();     // закрили до заставки — переможець усе одно в історії
    S = null; ST = null;
    if (dom) {
      dom.root.classList.remove('visible'); loading(null); dom.end.classList.remove('on'); dom.win.classList.remove('on'); dom.big.classList.remove('on');
      dom.board.innerHTML = ''; dom.rows = []; dom.feed.innerHTML = '';
      for (const L of dom.lab) { L.el.style.display = 'none'; L.on = false; L.txt = ''; }
    }
    if (G && fly.on) setFree(false);
    if (dom) dom.pick.classList.remove('on');
    if (pickResolve) { const r = pickResolve; pickResolve = null; r(null); }
    if (G) { for (const b of G.bolts) G.scene.remove(b.grp); G.bolts.length = 0; G.flashL.intensity = 0; }
    if (typeof phase !== 'undefined' && phase === 'racing') phase = 'idle';
  }
  function isMarbles2Open() { return !!(dom && dom.root.classList.contains('visible')); }

  // для прогріву кешу в app.js (ті самі URL, що й при завантаженні траси)
  window.MB2_ASSETS = Object.keys(MAPS).filter(id => !MAPS[id].hidden).flatMap(id => [ASSET + 'maps/' + id + '.glb?v=' + MAPS[id].v, ASSET + 'maps/' + id + '.json?v=' + MAPS[id].v]);
  window.startMarbles2Game = startMarbles2Game;
  window.closeMarbles2Overlay = closeMarbles2Overlay;
  window.isMarbles2Open = isMarbles2Open;
  // налагодження: ручний кадр, коли вкладка прихована
  window.__mb2 = { frame: dt => frame(dt || 1 / 60), get S() { return S; }, get ST() { return ST; }, get G() { return G; },
    // локальний превʼю (tools/preview.mjs): кадр канваса → файл у тимчасовій теці
    snap: name => { frame(0.001); const data = dom.canvas.toDataURL('image/jpeg', 0.85);
      return fetch('/api/dev/snap', { method: 'POST', body: JSON.stringify({ name, data }) }).then(r => r.json()); } };
})();
