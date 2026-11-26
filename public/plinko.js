/* ══════════════════════════════════════════════════════════════
   🎱 ПЛИНКО — режим: випадковий учасник кидає шарик, шарик падає крізь кілочки
   у лунку з виграшем. Виграші — у межах «мин…макс» (вводить стрімер), лунки
   перетасовуються. Механіка — класичне плінко/пачінко; оформлення власне
   (автомат з Blender: blender/plinko.blend → models/plinko/plinko.glb).
   Хто кидає — ролл random.org (rollPick), де впаде — фізика з випадковою
   точкою скидання (crypto). Логіка переможця — спільна addWinner.
   ══════════════════════════════════════════════════════════════ */
(function () {
  if (typeof GAME_MODES !== 'undefined' && !GAME_MODES.find(m => m.id === 'plinko')) GAME_MODES.push({ id: 'plinko', icon: '🎱', label: 'Плинко' });

  const GLB = '/assets/models/plinko/plinko.glb?v=20261118';
  const B = { x0: -8.5, x1: 8.5, top: 24, slotH: 3.0 };          // ігрове поле (світові одиниці, y угору)
  const N_SLOTS = 16, BALL_R = 0.34, PEG_R = 0.13;   // 16 лунок, як у відео
// рух як у відео: шарик «пливе» вниз ~10 с, м'яко перекочуючись між кілочками; видимий шарик більший за фізичний
const MOVE = { g: 11, bounce: 1.3, vmax: 6.5, look: 1.55 };
  const CAM = { pos: [0, 11.6, 47], look: [0, 11.2, 0] };
  const LS_KEY = 'plinko_bet';
  let R = null, S = null, token = 0;

  // ── утиліти ──
  const $ = id => document.getElementById(id);
  const rnd = () => (typeof secureRandomInt === 'function' ? secureRandomInt(1e9) / 1e9 : Math.random());
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const fmt = v => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  // лунки: 15 множників по рівнях (щоразу випадкові в межах рівня) + 1 DOUBLE
  // рівні множників у діапазоні [мін..макс] (геометрично): t — частка шляху від мін до макс
  const TIERS = [
    { t: [1, 1], n: 1, edge: 4 },            // максимум — рівно «до», лише в одній з 4 крайніх лунок (туди шарик падає найрідше)
    { t: [0.62, 0.85], n: 2, edge: 6 },      // великі — у 6 крайніх
    { t: [0.3, 0.55], n: 4 },
    { t: [0, 0.25], n: 8 },
  ];
  // гарне округлення ікса: лише цілі (без x2.5), великі — «круглі»
  function niceX(v) {
    if (v < 100) return Math.max(2, Math.round(v));
    const p = Math.pow(10, Math.floor(Math.log10(v)) - 1); return Math.round(v / p / 5) * p * 5;
  }
  const N_DBL = 1;                         // одна лунка DOUBLE
  function makeBoard() {
    const [lo, hi] = readX(), items = [];
    for (const t of TIERS) for (let k = 0; k < t.n; k++) {
      const f = t.t[0] + (t.t[1] - t.t[0]) * rnd();
      const m = f >= 1 ? hi : Math.min(hi, Math.max(lo, niceX(lo * Math.pow(hi / lo, f))));
      items.push({ m, edge: t.edge || 0 });
    }
    for (let k = 0; k < N_DBL; k++) items.push({ dbl: true, edge: 0 });
    return items;
  }
  // розкладка: спершу «крайові» множники в свої крайні лунки, решта — куди випаде
  function placeOrder(items) {
    const free = new Set([...Array(N_SLOTS).keys()]), order = Array(items.length);
    const outer = n => { const h = n / 2, a = []; for (let k = 0; k < h; k++) a.push(k, N_SLOTS - 1 - k); return a; };
    const idx = items.map((_, i) => i).sort((a, b) => (items[a].edge || 99) - (items[b].edge || 99));
    for (const i of idx) {
      const pool = items[i].edge ? outer(items[i].edge).filter(x => free.has(x)) : [...free];
      const pick = (pool.length ? pool : [...free])[Math.floor(rnd() * (pool.length || free.size))];
      order[i] = pick; free.delete(pick);
    }
    return order;
  }
  const labelOf = it => it.dbl ? 'DOUBLE' : 'x' + it.m;
  function shuffled(a) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
  function readX() {
    const num = id => parseFloat(String(($(id) || {}).value || '').replace(',', '.').replace(/[^\d.]/g, ''));
    let lo = num('pl-xmin'), hi = num('pl-xmax');
    if (!(lo >= 2)) lo = 2; if (!(hi > 0)) hi = 100;
    lo = Math.round(lo); hi = Math.round(hi);
    if (hi < lo) [lo, hi] = [hi, lo];
    if (hi < lo + 2) hi = lo + 2;
    if ($('pl-xmin')) $('pl-xmin').value = lo; if ($('pl-xmax')) $('pl-xmax').value = hi;   // показуємо округлене
    try { localStorage.setItem(LS_KEY + '_x', JSON.stringify([lo, hi])); } catch (e) { /* приватний режим */ }
    return [lo, hi];
  }
  function readBet() {
    let v = parseFloat(String(($('pl-bet') || {}).value || '').replace(/[^\d.]/g, ''));
    if (!(v > 0)) v = 100;
    v = Math.max(1, Math.round(v));
    try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch (e) { /* приватний режим */ }
    return v;
  }

  // ── звук (ElevenLabs, sfx/pl-*.mp3 через KPS): кілочки, поява иксів, скидання, DOUBLE, виграш ──
  const snd = (n, v, r) => { if (window.KPS) KPS.play(n, v, r); };
  const ac = () => (window.KPS ? KPS.ctx() : null);
  const pegTick = (k) => snd('pl-peg', 0.32, 0.85 + k * 0.035);
  const winChime = () => snd('pl-win', 0.75);

  // ── DOM-оверлей ──
  function ensureDom() {
    if ($('plinko-overlay')) return;
    const ov = document.createElement('div'); ov.id = 'plinko-overlay';
    let saved = 100; try { const v = JSON.parse(localStorage.getItem(LS_KEY)); if (v > 0) saved = v; } catch (e) {}
    let savedX = [2, 50]; try { const v = JSON.parse(localStorage.getItem(LS_KEY + '_x')); if (v && v[0] > 0 && v[1] > 0) savedX = v; } catch (e) {}
    ov.innerHTML =
      '<div id="pl-stage"></div>' +
      '<div id="pl-labels"></div>' +
      '<div class="pl-top"><div class="pl-who" id="pl-who"><div class="pl-av" id="pl-av"><span></span><img alt=""></div><div><div class="pl-who-k">Шарик бросает</div><div class="pl-who-n" id="pl-who-n">…</div></div></div></div>' +
      '<div class="pl-panel" id="pl-panel">' +
        '<div class="pl-panel-h"><span class="pl-panel-ico">💰</span><div><div class="pl-panel-t">Ставка</div><div class="pl-panel-s">выигрыш = ставка × икс</div></div></div>' +
        '<label class="pl-field pl-bet"><input id="pl-bet" type="text" inputmode="numeric" value="' + saved + '"></label>' +
        '<div class="pl-range">' +
          '<label class="pl-field"><span>икс от</span><input id="pl-xmin" type="text" inputmode="numeric" value="' + savedX[0] + '"></label>' +
          '<span class="pl-dash">—</span>' +
          '<label class="pl-field"><span>до</span><input id="pl-xmax" type="text" inputmode="numeric" value="' + savedX[1] + '"></label>' +
        '</div>' +
        '<div class="pl-panel-s pl-maxwin" id="pl-maxwin"></div>' +
        '<button class="pl-shuffle" id="pl-shuffle"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h3.5c2 0 3.2 1 4.3 2.6l2.4 4.8C14.3 16 15.5 17 17.5 17H21M17.5 7H21M3 17h3.5c1.2 0 2.1-.4 2.9-1.1M18 4l3 3-3 3M18 14l3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Новые иксы</button>' +
      '</div>' +
      '<div class="pl-result" id="pl-result"></div>' +
      '<div class="pl-ctrl" id="pl-ctrl"></div>';
    document.body.appendChild(ov);
    // «Новые иксы» — нова розкладка множників (поки шарик ще не кинули); ставка — підказка макс. виграшу
    $('pl-shuffle').onclick = async () => {
      if (!S || S.state !== 'ready' || S.revealing) return;
      setCtrl(''); await doShuffle(true, true);
      if (S && S.state === 'ready') { setCtrl('<button class="pl-btn pl-btn-drop" id="pl-drop"><svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="5.5"/><path d="M12 17v5M9 19.5l3 3 3-3"/></svg>Бросить шарик</button>'); $('pl-drop').onclick = dropBall; }
    };
    $('pl-bet').addEventListener('input', () => updateMaxWin());
    $('pl-bet').addEventListener('change', () => { readBet(); updateMaxWin(); });
    // новий діапазон іксів — нова розкладка з відкриттям по черзі (поки шарик не кинули)
    for (const id of ['pl-xmin', 'pl-xmax']) $(id).addEventListener('change', () => { readX(); $('pl-shuffle').onclick(); });
  }
  function updateMaxWin() {
    const el = $('pl-maxwin'); if (!el || !S || !S.values) return;
    const top = Math.max(...S.values.filter(v => !v.dbl).map(v => v.m));
    el.textContent = 'максимум: ' + fmt(readBet() * top) + ' (x' + top + ')';
  }
  function setCtrl(html) { const c = $('pl-ctrl'); c.innerHTML = html; c.style.display = html ? 'flex' : 'none'; }

  // ── сцена ──
  async function ensureScene() {
    const host = $('pl-stage');
    if (R) { if (R.canvas.parentNode !== host) host.appendChild(R.canvas); return R; }
    const gltf = await new Promise((ok, no) => new THREE.GLTFLoader().load(GLB, ok, undefined, no));
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
    const canvas = renderer.domElement; host.appendChild(canvas);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 300);
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(60, 24, 12), new THREE.MeshBasicMaterial({ color: '#0b0812', side: THREE.BackSide })));
    for (const [c, x, y, z, w, h] of [['#fff1d0', 0, 40, 10, 60, 14], ['#ffcf6b', -40, 10, 20, 20, 30], ['#b46cff', 40, 6, 20, 18, 20]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    }
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(env, 0.04).texture;
    scene.add(new THREE.HemisphereLight('#efe6ff', '#1a0f20', 0.6));
    const key = new THREE.DirectionalLight('#fff3dc', 1.1); key.position.set(-10, 26, 30); scene.add(key);
    const root = gltf.scene; scene.add(root);
    const nodes = {}; root.traverse(o => { if (o.name && !nodes[o.name]) nodes[o.name] = o; });
    root.traverse(o => { if (o.isMesh && o.material && o.material.name === 'P_Bulb') { o.material = o.material.clone(); o.material.toneMapped = false; } });
    // задник поля: темне скло з дрібним візерунком-ромбами
    const bg = (() => { const c = document.createElement('canvas'); c.width = 512; c.height = 720; const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 0, 720); g.addColorStop(0, '#1d1236'); g.addColorStop(1, '#0d0818'); x.fillStyle = g; x.fillRect(0, 0, 512, 720);
      x.strokeStyle = 'rgba(255,214,120,.06)'; x.lineWidth = 2;
      for (let i = -720; i < 1240; i += 48) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 720, 720); x.stroke(); x.beginPath(); x.moveTo(i + 720, 0); x.lineTo(i, 720); x.stroke(); }
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t; })();
    const back = new THREE.Mesh(new THREE.PlaneGeometry(B.x1 - B.x0, B.top), new THREE.MeshBasicMaterial({ map: bg }));
    back.position.set(0, B.top / 2, -0.06); scene.add(back);
    // кілочки: рядами в шаховому порядку
    const pegs = [];
    const rows = 14, dy = 1.36, dx = 1.3;
    for (let r = 0; r < rows; r++) {
      const y = 21.4 - r * dy, off = r % 2 ? dx / 2 : 0;
      // крайні кілочки — не ближче 1.2 до стінки: щілина ширша за шарик, заклинитись нема де
      for (let x = -7.15 + off; x <= 7.2; x += dx) if (Math.abs(x) <= 7.2) pegs.push({ x, y, hit: 0 });
      // напівкілочки на стінках (через ряд): шарик не мчить «коридором» уздовж стінки до крайньої лунки
      if (r % 2) { pegs.push({ x: B.x0, y, hit: 0, wall: true, r: 0.45 }); pegs.push({ x: B.x1, y, hit: 0, wall: true, r: 0.45 }); }
    }
    const pegMat = new THREE.MeshStandardMaterial({ color: '#ffd27a', metalness: 0.85, roughness: 0.25, emissive: '#000000' });
    const pegMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(PEG_R, PEG_R, 0.7, 12), pegMat, pegs.length);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    pegs.forEach((p, i) => { const k = p.r ? p.r / PEG_R : 1; mtx.compose(new THREE.Vector3(p.x, p.y, 0.3), q, new THREE.Vector3(k, 1, k)); pegMesh.setMatrixAt(i, mtx); pegMesh.setColorAt(i, new THREE.Color('#ffd27a')); });
    scene.add(pegMesh);
    // лунки: золоті перегородки + підсвітка дна (колір вмикається при виграші)
    const sw = (B.x1 - B.x0) / N_SLOTS, divs = [], slotGlow = [];
    const divMat = new THREE.MeshStandardMaterial({ color: '#ffc93d', metalness: 0.9, roughness: 0.25 });
    for (let k = 0; k <= N_SLOTS; k++) {
      const x = B.x0 + k * sw; divs.push(x);
      if (k === 0 || k === N_SLOTS) continue;
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.16, B.slotH, 0.7), divMat); d.position.set(x, B.slotH / 2, 0.3); scene.add(d);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), divMat); cap.position.set(x, B.slotH, 0.3); scene.add(cap);
    }
    for (let k = 0; k < N_SLOTS; k++) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(sw - 0.2, B.slotH), new THREE.MeshBasicMaterial({ color: '#ffc93d', transparent: true, opacity: 0, toneMapped: false }));
      g.position.set(B.x0 + (k + 0.5) * sw, B.slotH / 2, -0.03); scene.add(g); slotGlow.push(g);
    }
    // шарик: світиться, як у відео — біле ядро з ореолом
    const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 16), new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4d6', emissiveIntensity: 1.2, roughness: 0.2 }));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(255,255,240,1)'); gr.addColorStop(0.3, 'rgba(255,220,150,.5)'); gr.addColorStop(1, 'rgba(255,180,80,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    halo.scale.setScalar(4.2); ball.add(halo); ball.scale.setScalar(MOVE.look); ball.visible = false; scene.add(ball);
    // шлейф: кілька сяючих плям, що тягнуться за шариком і тануть
    const trail = [];
    for (let i = 0; i < 10; i++) { const t = new THREE.Sprite(halo.material.clone()); t.material.opacity = 0; t.scale.setScalar(2.2 - i * 0.15); t.visible = false; scene.add(t); trail.push(t); }
    const ballL = new THREE.PointLight('#fff1c8', 0, 9, 2); scene.add(ballL);
    R = { renderer, canvas, scene, camera, root, nodes, pegs, pegMesh, pegMat, divs, sw, slotGlow, ball, ballL, trail, hist: [], raf: 0, parts: [] };
    resize(); window.addEventListener('resize', resize);
    return R;
  }
  function resize() {
    if (!R) return;
    const host = $('pl-stage'), w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    R.renderer.setSize(w, h, false); R.canvas.style.width = w + 'px'; R.canvas.style.height = h + 'px';
    R.camera.aspect = w / h; R.camera.fov = w / h < 1 ? 58 : 40; R.camera.updateProjectionMatrix();
  }

  // ── підписи виграшів під лунками (HTML — чіткий текст) ──
  function buildLabels() {
    const box = $('pl-labels'); box.innerHTML = '';
    // ікси не показуємо до відкриття по черзі — лунки одразу закриті «?» (раніше цифри мигали й зникали)
    S.labels = S.values.map(() => { const el = document.createElement('div'); el.className = 'pl-lbl pl-hide'; el.textContent = '?'; box.appendChild(el); return el; });
    placeLabels(true);
  }
  function placeLabels(instant) {
    if (!R || !S || !S.labels) return;
    const v = new THREE.Vector3(), r = R.canvas.getBoundingClientRect();
    S.labels.forEach((el, i) => {
      const slot = S.order[i];
      // підпис стоїть вертикально всередині лунки (лунка вузька, а висока)
      v.set(B.x0 + (slot + 0.5) * R.sw, B.slotH * 0.5, 0.6).project(R.camera);
      const x = (v.x * 0.5 + 0.5) * r.width, y = (-v.y * 0.5 + 0.5) * r.height;
      if (instant) el.style.transition = 'none';
      el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-50%) rotate(-90deg)';
      if (instant) { void el.offsetWidth; el.style.transition = ''; }
    });
  }
  function refreshLabels(pop) {
    S.labels.forEach((el, i) => {
      el.textContent = labelOf(S.values[i]); el.classList.toggle('pl-lbl-dbl', !!S.values[i].dbl);
      if (pop && !S.values[i].dbl) { el.classList.remove('pl-pop'); void el.offsetWidth; el.classList.add('pl-pop'); }
    });
    updateMaxWin();
  }
  // тасування: (за потреби) нові множники + нова розкладка; values[i] стоїть у лунці order[i]
  async function doShuffle(anim, fresh) {
    // нова розкладка й відкриття іксів по черзі — від найменшого до найбільшого
    S.values = makeBoard(); S.order = placeOrder(S.values);
    S.labels.forEach((el, i) => { el.classList.add('pl-hide'); el.classList.remove('pl-pop', 'pl-pop-big'); el.classList.remove('pl-lbl-dbl'); el.textContent = '?'; });   // DOUBLE теж не видно до відкриття
    placeLabels(true);
    await revealSeq();
  }
  // інтрига: усі лунки закриті «?», ікси відкриваються по одному за зростанням;
  // передостаннім — DOUBLE, останнім — максимальний ікс (з великим спалахом)
  async function revealSeq() {
    const my = token, st = S;
    st.revealing = true; st.flash = st.flash || {};
    S.labels.forEach(el => { el.classList.add('pl-hide'); el.classList.remove('pl-lbl-dbl'); el.textContent = '?'; });
    $('pl-maxwin').textContent = 'максимум: ?';
    const idx = S.values.map((v, i) => i).filter(i => !S.values[i].dbl).sort((a, b) => S.values[a].m - S.values[b].m);
    const top = idx.pop(), seq = idx.concat(S.values.map((v, i) => i).filter(i => S.values[i].dbl), [top]);
    await wait(500);
    for (let k = 0; k < seq.length; k++) {
      if (my !== token || S !== st) return;
      const i = seq[k], el = S.labels[i], last = k === seq.length - 1, slow = k >= seq.length - 2;
      el.textContent = labelOf(S.values[i]); el.classList.toggle('pl-lbl-dbl', !!S.values[i].dbl);
      el.classList.remove('pl-hide', 'pl-pop'); void el.offsetWidth; el.classList.add('pl-pop');
      if (last) el.classList.add('pl-pop-big');
      S.flash[S.order[i]] = performance.now();
      if (last) snd('pl-big', 0.85); else snd('pl-pop', 0.5, 0.8 + k * 0.045);
      await wait(last ? 900 : slow ? 750 : 210 + k * 14);
    }
    st.revealing = false;
    updateMaxWin();
  }

  // ── фізика шарика (2D у площині поля) ──
  function physStep(dt) {
    const b = S.b, g = MOVE.g;
    b.vy -= g * dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
    // кілочки
    for (let i = 0; i < R.pegs.length; i++) {
      const p = R.pegs[i], dx = b.x - p.x, dy = b.y - p.y, rr = BALL_R + (p.r || PEG_R), d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
      b.x = p.x + nx * rr; b.y = p.y + ny * rr;
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        b.vx -= MOVE.bounce * vn * nx; b.vy -= MOVE.bounce * vn * ny;  // м'який відскок
        b.vx += (S.jit() - 0.5) * 0.9;                                    // ледь-ледь випадковості (crypto-ролл на старті)
        if (!S.sim && performance.now() - p.hit > 70) { p.hit = performance.now(); pegTick(Math.min(10, S.hits++ % 10)); }
      }
    }
    // стінки
    if (b.x < B.x0 + BALL_R) { b.x = B.x0 + BALL_R; b.vx = Math.abs(b.vx) * 0.5; }
    if (b.x > B.x1 - BALL_R) { b.x = B.x1 - BALL_R; b.vx = -Math.abs(b.vx) * 0.5; }
    // перегородки лунок: відрізки x = const, y ∈ [0, slotH]
    for (let k = 1; k < N_SLOTS; k++) {
      const x = R.divs[k], cy = Math.min(B.slotH, Math.max(0, b.y)), dx = b.x - x, dy = b.y - cy, d2 = dx * dx + dy * dy, rr = BALL_R + 0.08;
      if (d2 >= rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
      b.x = x + nx * rr; b.y = cy + ny * rr;
      const vn = b.vx * nx + b.vy * ny; if (vn < 0) { b.vx -= 1.4 * vn * nx; b.vy -= 1.4 * vn * ny; }
      // завис на верхівці перегородки — скочується в бік (інакше лежав би там вічно)
      if (b.y > B.slotH && Math.abs(dx) < 0.12 && Math.abs(b.vx) < 0.6) b.vx += (S.jit() < 0.5 ? -1 : 1) * 1.6;
    }
    // дно
    if (b.y < BALL_R + 0.05) { b.y = BALL_R + 0.05; b.vy = Math.abs(b.vy) * 0.3; b.vx *= 0.8; }
    const sp = Math.hypot(b.vx, b.vy); if (sp > MOVE.vmax) { b.vx *= MOVE.vmax / sp; b.vy *= MOVE.vmax / sp; }
  }

  // ── кадр ──
  function frame() {
    const ov = $('plinko-overlay');
    if (!R || !ov || !ov.classList.contains('visible')) { if (R) R.raf = 0; return; }
    R.raf = requestAnimationFrame(frame);
    const now = performance.now(), T = now / 1000;
    // скидач: гойдається, поки чекаємо; під час скидання — їде до точки
    const drop = R.nodes.PL_DROPPER;
    if (drop && S) {
      if (S.state === 'aim') { S.dx += (S.tx - S.dx) * 0.12; }
      else if (S.state === 'ready' || S.state === 'pick') S.dx = Math.sin(T * 1.25) * 6.5;
      drop.position.x = S.dx;
    }
    // кілочки підсвічуються після удару
    let dirty = false;
    for (let i = 0; i < R.pegs.length; i++) {
      const p = R.pegs[i], k = Math.max(0, 1 - (now - p.hit) / 380);
      if (k > 0 || p.lit) { p.lit = k > 0; R.pegMesh.setColorAt(i, new THREE.Color('#ffd27a').lerp(new THREE.Color('#ffffff'), k)); dirty = true; }
    }
    if (dirty) R.pegMesh.instanceColor.needsUpdate = true;
    // шарик
    if (S && S.state === 'fall') {
      const sub = 6, dt = Math.min(1 / 30, (now - (S.lastT || now)) / 1000) / sub;
      for (let i = 0; i < sub; i++) physStep(dt);
      S.lastT = now;
      const b = S.b;
      const spd = Math.hypot(b.vx, b.vy);
      if (b.y < B.slotH - 0.4 && spd < 1.2) { S.calm = (S.calm || 0) + 1; if (S.calm > 20) land(); } else S.calm = 0;
      // страховка: шарик завмер над лунками (заклинило) — поштовх угору-вбік
      if (b.y > B.slotH && spd < 0.5) { S.stuck = (S.stuck || 0) + 1; if (S.stuck > 30) { b.vx = (S.jit() < 0.5 ? -1 : 1) * (2 + S.jit() * 2); b.vy = 3; S.stuck = 0; } } else S.stuck = 0;
      if (now - S.t0 > 25000) land();                                   // страховка
    }
    if (S && S.b) {
      R.ball.position.set(S.b.x, S.b.y, 0.6); R.ballL.position.set(S.b.x, S.b.y, 2.5); R.ballL.intensity = R.ball.visible ? 5 : 0;
      R.hist.unshift([S.b.x, S.b.y]); if (R.hist.length > 40) R.hist.pop();
      R.trail.forEach((t, i) => { const h = R.hist[(i + 1) * 3]; t.visible = R.ball.visible && !!h; if (h) { t.position.set(h[0], h[1], 0.55); t.material.opacity = 0.35 * (1 - i / R.trail.length); } });
    } else if (R.trail) R.trail.forEach(t => { t.visible = false; });
    // підсвітка виграшної лунки
    R.slotGlow.forEach((g, k) => {
      const on = S && S.win === k, f = S && S.flash && S.flash[k] ? Math.max(0, 1 - (now - S.flash[k]) / 450) : 0;
      g.material.opacity = on ? 0.35 + 0.25 * Math.sin(T * 8) : 0.55 * f;
    });
    // лампочки на колонах: хвиля
    R.root.traverse(o => { if (o.isMesh && o.material && o.material.name === 'P_Bulb') { const ph = Math.sin(T * 4 + o.position.y * 0.6); o.material.color.setScalar(0.6 + 0.4 * ph); } });
    // конфеті
    for (let i = R.parts.length - 1; i >= 0; i--) {
      const p = R.parts[i]; p.v.y -= 14 / 60; p.o.position.addScaledVector(p.v, 1 / 60); p.o.rotation.x += 0.2; p.o.rotation.y += 0.15; p.life -= 1 / 60;
      if (p.life <= 0) { R.scene.remove(p.o); R.parts.splice(i, 1); }
    }
    R.camera.position.set(CAM.pos[0] + Math.sin(T * 0.4) * 0.4, CAM.pos[1], CAM.pos[2]);
    R.camera.lookAt(CAM.look[0], CAM.look[1], CAM.look[2]);
    R.renderer.render(R.scene, R.camera);
    placeLabels(false);
  }

  // ── хід гри ──
  async function startPlinko() {
    if (!state.participants.length) return alert('Нет участников');
    const drawn = new Set(winnersHistory.map(w => String(w.name).toLowerCase()));
    const pool = state.participants.filter(p => !drawn.has(String(p).toLowerCase()));
    if (!pool.length) return alert('Все участники уже выигрывали. Сбросьте розыгрыш и проведите новую регистрацию.');
    ensureDom();
    const ov = $('plinko-overlay'); ov.classList.add('visible');
    $('pl-result').classList.remove('show'); $('pl-panel').classList.remove('pl-locked');
    const my = ++token;
    phase = 'racing';
    setCtrl('');
    try { await ensureScene(); } catch (e) { console.warn('[plinko] модель не завантажилась', e); }
    if (my !== token || !R) return;
    resize();
    S = { state: 'pick', values: makeBoard(), dx: 0, tx: 0, b: null, win: -1, hits: 0, doubles: 0 };
    S.order = placeOrder(S.values);
    buildLabels(); $('pl-maxwin').textContent = 'максимум: ?';
    if (!R.raf) R.raf = requestAnimationFrame(frame);
    ac();
    // хто кидає: швидкий перебір ніків, а тим часом — ролл random.org
    const whoN = $('pl-who-n');
    $('pl-who').classList.add('pl-rolling');
    let spin = true;
    (async () => { while (spin) { whoN.textContent = pool[Math.floor(Math.random() * pool.length)]; snd('rl-tick', 0.22, 1.25); await wait(70); } })();
    // тіньовий бан: у переборі ніків крутяться всі, кидає — лише допущений
    const drawPool = typeof blEligible === 'function' && blEligible(pool).length ? blEligible(pool) : pool;
    const [player] = await rollPick(drawPool, 1, 'Плинко: кто бросает шарик (из ' + drawPool.length + ')');
    await wait(900);
    spin = false;
    if (my !== token) return;
    S.player = player; whoN.textContent = player; $('pl-who').classList.remove('pl-rolling');
    if (window.WC) WC.avatar($('pl-av'), player);
    snd('pl-pick', 0.7);
    await doShuffle(true, true);
    if (my !== token) return;
    S.state = 'ready';
    setCtrl('<button class="pl-btn pl-btn-drop" id="pl-drop"><svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="5.5"/><path d="M12 17v5M9 19.5l3 3 3-3"/></svg>Бросить шарик</button>');
    $('pl-drop').onclick = dropBall;
  }
  async function dropBall() {
    if (!S || S.state !== 'ready') return;
    const my = token;
    S.state = 'aim'; setCtrl('');
    $('pl-panel').classList.add('pl-locked');
    // точка скидання — crypto-випадкова, скидач плавно їде до неї
    S.tx = (rnd() * 2 - 1) * 7.2;
    snd('pl-drop', 0.7);
    await wait(900);
    if (my !== token) return;
    const seed = Math.floor(rnd() * 1e9); let a = seed >>> 0;
    S.jit = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    S.b = { x: S.dx, y: B.top - 1.0, vx: 0, vy: -1 }; R.hist = [];
    R.ball.visible = true;
    S.state = 'fall'; S.t0 = performance.now(); S.lastT = performance.now();
  }
  function land() {
    if (!S || S.state !== 'fall') return;
    S.state = 'done';
    const slot = Math.max(0, Math.min(N_SLOTS - 1, Math.floor((S.b.x - B.x0) / R.sw)));
    S.win = slot;
    const vi = S.order.indexOf(slot), it = S.values[vi];
    S.labels.forEach((el, i) => el.classList.toggle('pl-lbl-win', i === vi));
    if (it.dbl) { doDouble(); return; }
    const bet = readBet(), prize = bet * it.m;
    winChime();
    // конфеті з лунки
    const cols = ['#ffc93d', '#ffe48a', '#53fc18', '#b46cff', '#ffffff', '#ff4d6a'];
    for (let i = 0; i < 90; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.42), new THREE.MeshBasicMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide, toneMapped: false }));
      p.position.set(S.b.x, B.slotH, 1); R.scene.add(p);
      R.parts.push({ o: p, v: new THREE.Vector3((Math.random() - 0.5) * 12, 8 + Math.random() * 10, (Math.random() - 0.2) * 6), life: 2.6 });
    }
    const res = $('pl-result');
    res.innerHTML = '<div class="pl-res-k">' + escapeHtml(S.player) + ' выигрывает</div><div class="pl-res-v">' + fmt(prize) + '</div>' +
      '<div class="pl-res-x">' + fmt(bet) + ' × x' + it.m + (S.doubles ? ' · DOUBLE ×' + Math.pow(2, S.doubles) : '') + '</div>';
    res.classList.add('show');
    setTimeout(() => {
      if (!S || S.state !== 'done') return;
      window.WA_PRIZE = fmt(prize) + ' · x' + it.m;
      addWinner(S.player);
      phase = 'done';
      setCtrl('<button class="pl-btn pl-btn-drop" onclick="startPlinko()"><svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>Ещё раз</button><button class="pl-btn pl-btn-ghost" onclick="closePlinkoOverlay()">Закрыть</button>');
    }, 1600);
  }
  // DOUBLE: усі множники ×2 (з анімацією), шарик повертається в скидач і падає ще раз
  async function doDouble() {
    const my = token;
    S.doubles++;
    snd('pl-double', 0.8);
    const res = $('pl-result');
    res.innerHTML = '<div class="pl-res-k">Двойной шанс!</div><div class="pl-res-v pl-res-dbl">DOUBLE</div><div class="pl-res-x">все иксы ×2 · шарик падает ещё раз</div>';
    res.classList.add('show');
    await wait(1200);
    if (my !== token || !S) return;
    for (const v of S.values) if (!v.dbl) v.m *= 2;
    refreshLabels(true);
    await wait(1400);
    if (my !== token || !S) return;
    res.classList.remove('show');
    S.labels.forEach(el => el.classList.remove('pl-lbl-win'));
    R.ball.visible = false; S.win = -1; S.b = null;
    S.state = 'ready';
    dropBall();
  }
  function closePlinkoOverlay(silent) {
    token++;
    const ov = $('plinko-overlay'); if (ov) ov.classList.remove('visible');
    if ($('pl-result')) $('pl-result').classList.remove('show');
    if ($('pl-panel')) $('pl-panel').classList.remove('pl-locked');
    if (R) { R.ball.visible = false; for (const p of R.parts) R.scene.remove(p.o); R.parts = []; }
    S = null;
    if (!silent && phase !== 'idle') { phase = 'idle'; resetGameUI(); }
  }
  window.startPlinko = startPlinko;
  window.closePlinkoOverlay = closePlinkoOverlay;
  window.__pl = () => ({ S, R });   // для відладки з консолі
  // офлайн-перевірка фізики: n кидків без показу → скільки застрягло, розподіл по лунках
  window.__plSim = (n) => {
    if (!R) return 'спершу відкрий режим';
    const keep = S, out = { stuck: 0, maxT: 0, slots: Array(N_SLOTS).fill(0) };
    for (let k = 0; k < n; k++) {
      let a = (k * 2654435761) >>> 0;
      S = { sim: true, b: { x: (Math.random() * 2 - 1) * 7.2, y: B.top - 1, vx: 0, vy: -1 }, hits: 0, jit: () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; } };
      let t = 0, calm = 0, st = 0;
      for (; t < 40; t += 1 / 360) {
        physStep(1 / 360); const b = S.b, sp = Math.hypot(b.vx, b.vy);
        if (b.y < B.slotH - 0.4 && sp < 1.2) { if (++calm > 120) break; } else calm = 0;
        if (b.y > B.slotH && sp < 0.5) { if (++st > 180) { b.vx = (S.jit() < 0.5 ? -1 : 1) * (2 + S.jit() * 2); b.vy = 3; st = 0; } } else st = 0;
      }
      if (t >= 40) out.stuck++; out.maxT = Math.max(out.maxT, +t.toFixed(1)); (out.ts || (out.ts = [])).push(t);
      out.slots[Math.max(0, Math.min(N_SLOTS - 1, Math.floor((S.b.x - B.x0) / R.sw)))]++;
    }
    out.ts.sort((a, b) => a - b); out.p50 = +out.ts[out.ts.length >> 1].toFixed(1); out.p95 = +out.ts[Math.floor(out.ts.length * 0.95)].toFixed(1); delete out.ts;
    S = keep; return out;
  };
})();
