/* ══════════════════════════════════════════════════════════════
   💼 НИЩИЙ КЕЙС (DnD) — режим за мотивами власної гри стрімера (bonusbuy-widget/dnd-*.html):
   16 кейсів із сумами; переможець розіграшу вибирає свій кейс і відкриває решту,
   після 6-го і 12-го відкритого дзвонить банкір із пропозицією, на двох кейсах —
   фінал «оставить свой / поменять». Грою керує лише стрімер — кліками по кейсах
   і кнопках (гравець підказує йому голосом / в чаті, сам чат грою не керує).
   3D: студія з Blender (blender/dnd_studio.py → models/dnd/dnd.glb), розкладка — тут.
   Хто грає — ролл random.org (rollPick) серед допущених (блеклист), суми тасує crypto.
   ══════════════════════════════════════════════════════════════ */
(function () {
  if (typeof GAME_MODES !== 'undefined' && !GAME_MODES.find(m => m.id === 'dnd')) GAME_MODES.push({ id: 'dnd', icon: '💼', label: 'Нищий кейс' });

  const GLB = '/assets/models/dnd/dnd.glb?v=20261125b';
  // телефон банкіра: «Western Electric 500 Vintage Rotary Telephone» — Skyice (Sketchfab), CC BY 4.0
  // (підготовка — blender/dnd_phone_import.py); не завантажився — лишається власний телефон із dnd.glb
  const PHONE_GLB = '/assets/models/dnd/phone.glb?v=20261125a';
  const RINGS = 2, RING_MS = 1100;   // скільки дзвінків і як часто
  const N = 16, CUR = ' ₽';
  const LS_KEY = 'dnd_settings';
  // раунди як у ТВ-шоу: відкрий 4, 3, 3, 2, 1 — і після кожного дзвонить банкір; після 14-го — фінал на двох кейсах
  const BANK_AT = [4, 7, 10, 12, 13];
  // яку частку «справедливої» суми банкір дає залежно від кількості відкритих кейсів (ближче до фіналу — щедріше)
  const BANK_K = [[0, 0.22], [4, 0.30], [7, 0.45], [10, 0.60], [12, 0.75], [13, 0.88], [14, 0.92]];
  const C = new THREE.Vector3(0, 0, 6);   // центр дуг розкладки (як у blender/dnd_studio.py)
  const CAM0 = { pos: new THREE.Vector3(0, 5.5, 13.4), look: new THREE.Vector3(0, 1.0, -0.6) };
  const POD = new THREE.Vector3(-4.5, 0, 4.2), PHONE = new THREE.Vector3(4.5, 0, 4.2);   // подіум гравця і телефон банкіра — спереду з боків
  let R = null, S = null, token = 0;

  // ── утиліти ──
  const $ = id => document.getElementById(id);
  const rnd = () => (typeof secureRandomInt === 'function' ? secureRandomInt(1e9) / 1e9 : Math.random());
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const fmt = v => Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ');
  const money = v => fmt(v) + CUR;
  const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'));
  const ease = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const backOut = k => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
  function shuffled(a) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
  const caseWord = n => n === 1 ? 'кейс' : n <= 4 ? 'кейса' : 'кейсов';

  // ── налаштування (як у пульті: мін / макс + «шанс») ──
  function loadCfg() {
    let c = { min: 2000, max: 50000 };
    try { Object.assign(c, JSON.parse(localStorage.getItem(LS_KEY)) || {}); } catch (e) { /* приватний режим */ }
    return c;
  }
  function saveCfg(c) { try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch (e) {} }
  function readCfg() {
    const num = id => parseInt(String(($(id) || {}).value || '').replace(/[^\d]/g, ''), 10);
    const c = loadCfg();
    let lo = num('dnd-min'), hi = num('dnd-max');
    if (!(lo >= 1)) lo = c.min; if (!(hi >= 1)) hi = c.max;
    if (hi < lo) [lo, hi] = [hi, lo];
    if (hi - lo < 15) hi = lo + 15;
    c.min = lo; c.max = hi;
    if ($('dnd-min')) $('dnd-min').value = lo; if ($('dnd-max')) $('dnd-max').value = hi;
    saveCfg(c); return c;
  }
  // крок округлення: «гарне» число ≤ діапазон/60 (для 2000…50000 — 500, як у пульті)
  function niceStep(x) { if (x <= 1) return 1; const p = Math.pow(10, Math.floor(Math.log10(x))); for (const m of [5, 2, 1]) if (m * p <= x) return m * p; return p; }
  // 16 сум: ліві 8 — дрібні (густо біля мінімуму), праві 8 — великі (рідшають до максимуму).
  // Без налаштувань «шансу»: розклад завжди однаковий, по кейсах суми тасуються випадково
  function genValues(c) {
    const step = niceStep((c.max - c.min) / 60), r = v => Math.round(v / step) * step;
    const skew = 0;
    const mid = r(c.min + (c.max - c.min) * (0.5 + skew * 0.4));
    const all0 = [];
    for (let i = 0; i < 8; i++) all0.push(r(c.min + (mid - c.min) * Math.pow(i / 7, 0.7)));
    for (let i = 0; i < 8; i++) all0.push(r(mid + (c.max - mid) * Math.pow(i / 7, 1.3)));
    let all = [...new Set(all0.map(v => Math.max(step, v)))].sort((a, b) => a - b);
    let guard = 0;
    while (all.length < N && guard++ < 40) {
      let bg = 0, bi = 0;
      for (let i = 0; i < all.length - 1; i++) { const g = all[i + 1] - all[i]; if (g > bg) { bg = g; bi = i; } }
      const nv = r((all[bi] + all[bi + 1]) / 2);
      if (all.includes(nv)) break;
      all.splice(bi + 1, 0, nv);
    }
    while (all.length < N) all.push(all[all.length - 1] + step);
    return all.slice(0, N);
  }
  // пропозиція банкіра — круглим числом (як у пульті: тисячі → до сотень)
  function roundOffer(x) { const st = x < 100 ? 1 : x < 1000 ? 10 : x < 100000 ? 100 : 1000; return Math.max(st, Math.round(x / st) * st); }

  // ── звук: ефекти з ElevenLabs (public/sfx/dnd-*.mp3); клон на кожне відтворення — можуть накладатись ──
  const SFX = {}, VOL = { tick: 0.25, open: 0.8, good: 0.7, bad: 0.75, whoosh: 0.6, ring: 0.85, offer: 0.75, nodeal: 0.75, deal: 0.8, drumroll: 0.6, win: 0.85 };
  for (const n of Object.keys(VOL)) { const a = new Audio('/assets/sfx/dnd-' + n + '.mp3?v=20261125'); a.preload = 'auto'; SFX[n] = a; }
  let sfxLast = {};
  const VOLS = (() => { let v = { a: 0.8 }; try { const o = JSON.parse(localStorage.getItem('dnd_volume')) || {}; if (o.a >= 0) v.a = o.a; } catch (e) {} v.m = 1; v.s = 1; return v; })();
  const saveVols = () => { try { localStorage.setItem('dnd_volume', JSON.stringify({ a: VOLS.a })); } catch (e) {} };
  function sfx(n, vol) {
    const a = SFX[n]; if (!a) return null;
    const now = performance.now(); if (n === 'tick' && now - (sfxLast.tick || 0) < 110) return null;   // перебір ніків — не частіше ~9/с
    sfxLast[n] = now;
    if (VOLS.s * VOLS.a <= 0.001) return null;
    const c = a.cloneNode(); c.volume = Math.min(1, (vol == null ? 1 : vol) * VOL[n] * VOLS.s * VOLS.a);
    c.play().catch(() => {}); return c;
  }
  const sndStop = c => { if (c) { try { c.pause(); } catch (e) {} } };
  // музика гри (файл стрімера, sfx/dnd-banker-theme.ogg): один цикл 68.57 с, краї підігнані —
  // грає WebAudio-петлею без паузи на шві всю гру: фоном тихіше, на дзвінку й пропозиції банкіра — голосніше,
  // під барабанний дріб — майже тиша, на виграші плавно гасне під фанфари
  const TH = { ctx: null, buf: null, src: null, gain: null, p: null };
  const MUS = { bed: 0.22, bank: 0.5, hush: 0.06 };
  function themeLoad() {
    if (TH.p) return TH.p;
    TH.p = (async () => {
      TH.ctx = TH.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const ab = await (await fetch('/assets/sfx/dnd-banker-theme.ogg?v=20261125')).arrayBuffer();
      TH.buf = await new Promise((ok, no) => TH.ctx.decodeAudioData(ab, ok, no));
    })().catch(e => { console.warn('[dnd] тема банкіра не завантажилась', e); TH.p = null; });
    return TH.p;
  }
  async function themePlay(vol) {
    await themeLoad(); if (!TH.buf) return;
    const ov = $('dnd-overlay'); if (!ov || !ov.classList.contains('visible')) return;   // гру закрили, поки трек вантажився
    if (TH.src) return themeVol(vol == null ? MUS.bed : vol);
    TH.level = vol == null ? MUS.bed : vol;
    const c = TH.ctx; if (c.state === 'suspended') try { await c.resume(); } catch (e) {}
    const g = c.createGain(), src = c.createBufferSource();
    src.buffer = TH.buf; src.loop = true; src.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, TH.level * VOLS.m * VOLS.a), c.currentTime + 1.5);
    src.start(); TH.src = src; TH.gain = g;
  }
  // плавно змінити гучність музики, що вже грає
  function themeVol(v, t) {
    TH.level = v;
    if (!TH.src || !TH.gain) return;
    const c = TH.ctx, g = TH.gain.gain;
    try { g.cancelScheduledValues(c.currentTime); g.setValueAtTime(Math.max(0.0001, g.value), c.currentTime); g.exponentialRampToValueAtTime(Math.max(0.0001, v * VOLS.m * VOLS.a), c.currentTime + (t == null ? 0.8 : t)); } catch (e) {}
  }
  function themeStop(fade) {
    if (!TH.src) return;
    const c = TH.ctx, g = TH.gain, src = TH.src, f = fade == null ? 1.2 : fade; TH.src = null; TH.gain = null;
    try { g.gain.cancelScheduledValues(c.currentTime); g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), c.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + f); src.stop(c.currentTime + f + 0.05); } catch (e) {}
  }

  // ── DOM-оверлей ──
  function ensureDom() {
    if ($('dnd-overlay')) return;
    const c = loadCfg();
    const ov = document.createElement('div'); ov.id = 'dnd-overlay';
    ov.innerHTML =
      '<div id="dnd-stage"></div>' +
      '<div class="dnd-board dnd-board-l" id="dnd-board-l"></div>' +
      '<div class="dnd-board dnd-board-r" id="dnd-board-r"></div>' +
      '<div class="dnd-top"><div class="dnd-who" id="dnd-who"><div class="dnd-av" id="dnd-av"><span></span><img alt=""></div><div><div class="dnd-who-k">Играет</div><div class="dnd-who-n" id="dnd-who-n">…</div></div></div>' +
        '<div class="dnd-offers" id="dnd-offers"></div><div class="dnd-chat" id="dnd-chat"></div></div>' +
      '<div class="dnd-panel" id="dnd-panel">' +
        '<div class="dnd-panel-h"><div><div class="dnd-panel-t">Суммы в кейсах</div><div class="dnd-panel-s">16 кейсов от мин. до макс.</div></div></div>' +
        '<div class="dnd-range">' +
          '<label class="dnd-field"><span>от</span><input id="dnd-min" type="text" inputmode="numeric" value="' + c.min + '"></label>' +
          '<span class="dnd-dash">—</span>' +
          '<label class="dnd-field"><span>до</span><input id="dnd-max" type="text" inputmode="numeric" value="' + c.max + '"></label>' +
        '</div>' +
      '</div>' +
      '<div class="dnd-say" id="dnd-say"><div class="dnd-say-t" id="dnd-say-t"></div><div class="dnd-say-s" id="dnd-say-s"></div></div>' +
      '<div class="dnd-offer" id="dnd-offer"></div>' +
      '<div class="dnd-result" id="dnd-result"></div>' +
      '<div class="dnd-ctrl" id="dnd-ctrl"></div>' +
      '<div class="dnd-vol" id="dnd-vol"><button class="dnd-vol-b" id="dnd-vol-b" type="button" title="Звук"></button>' +
        '<div class="dnd-vol-p"><input type="range" id="dnd-vol-a" min="0" max="100" aria-label="Громкость"><b id="dnd-vol-al"></b></div></div>';
    document.body.appendChild(ov);
    const SPK = on => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/>' + (on ? '<path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>' : '<path d="M17 9l5 6M22 9l-5 6"/>') + '</svg>';
    const volUi = () => {
      const v = Math.round(VOLS.a * 100); $('dnd-vol-a').value = v; $('dnd-vol-al').textContent = v + '%'; $('dnd-vol-a').style.setProperty('--p', v + '%');
      $('dnd-vol-b').innerHTML = SPK(VOLS.a > 0);
    };
    volUi();
    $('dnd-vol-b').onclick = () => $('dnd-vol').classList.toggle('open');
    $('dnd-vol-a').addEventListener('input', e => { VOLS.a = e.target.value / 100; saveVols(); volUi(); if (TH.src) themeVol(TH.level, 0.15); });
    $('dnd-vol-a').addEventListener('change', () => sfx('tick', 3));
    const onCfg = () => { readCfg(); if (S && S.state === 'choose' && !S.busy) { S.values = genValues(readCfg()); dealValues(); renderBoard(true); } };
    for (const id of ['dnd-min', 'dnd-max']) $(id).addEventListener('change', onCfg);
  }
  function setCtrl(html) { const c = $('dnd-ctrl'); c.innerHTML = html; c.style.display = html ? 'flex' : 'none'; }
  function say(t, s) { $('dnd-say-t').textContent = t || ''; $('dnd-say-s').innerHTML = s || ''; $('dnd-say').classList.toggle('show', !!t); }
  const ICO = {
    phone: '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
    ok: '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    no: '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    keep: '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2"/></svg>',
    swap: '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
    again: '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>',
    user: '<svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
  };

  // ── табло сум ──
  function renderBoard(pop) {
    const sorted = S.values.slice().sort((a, b) => a - b);
    const gone = new Set(); for (let n = 1; n <= N; n++) if (S.cases[n].open) gone.add(S.cases[n].v);
    const remain = sorted.filter(v => !gone.has(v)).length;
    for (const [id, part] of [['dnd-board-l', sorted.slice(0, 8)], ['dnd-board-r', sorted.slice(8)]]) {
      const box = $(id);
      if (box.children.length !== 8) box.innerHTML = part.map(() => '<div class="dnd-slot"><span></span></div>').join('');
      part.forEach((v, i) => {
        const el = box.children[i];
        el.querySelector('span').textContent = money(v);
        el.classList.toggle('gone', gone.has(v));
        el.classList.toggle('last', !gone.has(v) && remain <= 2);
        el.classList.toggle('hi', id === 'dnd-board-r');
        if (pop) { el.classList.remove('pop'); void el.offsetWidth; el.style.animationDelay = (i * 40 + (id === 'dnd-board-r' ? 160 : 0)) + 'ms'; el.classList.add('pop'); }
      });
    }
  }
  function crossOut(v) {
    for (const id of ['dnd-board-l', 'dnd-board-r']) for (const el of $(id).children)
      if (el.querySelector('span').textContent === money(v) && !el.classList.contains('gone')) { el.classList.add('gone', 'hit'); setTimeout(() => el.classList.remove('hit'), 900); return; }
  }
  function renderOffers() {
    const o = $('dnd-offers');
    const list = S.offers.filter(x => !x.open);   // поточна пропозиція — лише на картці, сюди потрапляє після рішення
    o.innerHTML = list.length ? '<span>Банкир:</span>' + list.map(x => '<b class="' + (x.taken ? 'taken' : '') + '">' + fmt(x.v) + '</b>').join('') : '';
  }

  // ── текстури ──
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8; return t;
  }
  function rr(x, X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); }
  const FONT = '"Unbounded", "Manrope", system-ui, sans-serif';
  function numberTex(n) {
    return canvasTex(384, 270, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#fff3c4'); g.addColorStop(0.45, '#e8b54a'); g.addColorStop(1, '#a86f17');
      rr(x, 6, 6, w - 12, h - 12, 34); x.fillStyle = g; x.fill();
      x.lineWidth = 6; x.strokeStyle = 'rgba(90,50,0,.55)'; x.stroke();
      rr(x, 22, 22, w - 44, h - 44, 24); x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,.55)'; x.stroke();
      x.fillStyle = '#2a1600'; x.font = '800 168px ' + FONT; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(String(n), w / 2, h / 2 + 10);
    });
  }
  function valueTex(v, rank) {
    return canvasTex(512, 352, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#2b0612'); g.addColorStop(1, '#14020a');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      const col = rank > 0.5 ? '#ffd36a' : '#7fe7ff';
      rr(x, 18, 18, w - 36, h - 36, 26); x.lineWidth = 6; x.strokeStyle = col; x.stroke();
      x.fillStyle = col; x.textAlign = 'center'; x.textBaseline = 'middle';
      let fs = 120; x.font = '800 ' + fs + 'px ' + FONT;
      const t = fmt(v); while (x.measureText(t).width > w - 80 && fs > 40) { fs -= 6; x.font = '800 ' + fs + 'px ' + FONT; }
      x.fillText(t, w / 2, h / 2 - 14);
      x.font = '700 46px ' + FONT; x.globalAlpha = 0.85; x.fillText(CUR.trim(), w / 2, h / 2 + 88);
    });
  }
  // сума на дні кейса — лише для кейса гравця наприкінці (інші кейси віддають суму привидом)
  function plateValue(ci, rank) {
    const c = R.cases[ci - 1];
    c.vmat.map = valueTex(S.cases[ci].v, rank); c.vmat.emissiveMap = c.vmat.map; c.vmat.color.set('#ffffff'); c.vmat.emissiveIntensity = 0.32; c.vmat.needsUpdate = true;
    c.vplate.visible = true;
  }
  // великий круглий екран над сценою
  function drawScreen(lines, accent) {
    if (!R || !R.scr) return;
    const x = R.scr.ctx, w = 1024, h = 1024;
    const g = x.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, w / 2);
    g.addColorStop(0, '#2a1458'); g.addColorStop(1, '#07040f'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(255,255,255,.05)'; x.lineWidth = 2;
    for (let r = 120; r < 520; r += 70) { x.beginPath(); x.arc(w / 2, h / 2, r, 0, Math.PI * 2); x.stroke(); }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const col = accent || '#ffd36a';
    const tot = lines.length, y0 = h / 2 - (tot - 1) * 70;
    lines.forEach((ln, i) => {
      let fs = ln.size || 96; x.font = '800 ' + fs + 'px ' + FONT;
      while (x.measureText(ln.t).width > 760 && fs > 30) { fs -= 4; x.font = '800 ' + fs + 'px ' + FONT; }
      x.fillStyle = ln.c || (i === 0 ? '#ffffff' : col); x.shadowColor = ln.c || col; x.shadowBlur = 30;
      x.fillText(ln.t, w / 2, y0 + i * 140);
    });
    x.shadowBlur = 0;
    R.scr.tex.needsUpdate = true;
  }

  // ── графіка: світіння (bloom), дзеркальна підлога, процедурні текстури ──
  const PP_BASE = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/';
  const PP_FILES = [['shaders/CopyShader.js', 'CopyShader'], ['shaders/LuminosityHighPassShader.js', 'LuminosityHighPassShader'],
    ['postprocessing/EffectComposer.js', 'EffectComposer'], ['postprocessing/RenderPass.js', 'RenderPass'], ['postprocessing/ShaderPass.js', 'ShaderPass'],
    ['postprocessing/UnrealBloomPass.js', 'UnrealBloomPass'], ['objects/Reflector.js', 'Reflector']];
  function loadScript(url) { return new Promise((ok, no) => { const el = document.createElement('script'); el.src = url; el.onload = ok; el.onerror = no; document.head.appendChild(el); }); }
  let ppP = null;
  function loadPost() {   // ті самі файли можуть уже бути від Шариків — тоді не вантажимо вдруге
    if (!ppP) ppP = (async () => { for (const [f, name] of PP_FILES) if (!THREE[name]) await loadScript(PP_BASE + f); })().catch(e => { console.warn('[dnd] світіння/дзеркало недоступні', e); });
    return Promise.race([ppP, wait(6000)]);
  }
  // детермінований рандом для текстур (однаковий вигляд щоразу)
  function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function rtex(w, h, draw, rep, linear) {
    const t = canvasTex(w, h, draw); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]);
    if (linear) t.encoding = THREE.LinearEncoding; return t;
  }
  const TX = {};
  function textures() {
    if (TX.ok) return TX;
    // шліфований метал: горизонтальні штрихи різної довжини (шорсткість + рельєф)
    TX.brushed = rtex(512, 512, (x, w, h) => {
      const r = prng(7); x.fillStyle = '#5a5a5a'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 4200; i++) { const g = 60 + r() * 70 | 0; x.strokeStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + (0.25 + r() * 0.4) + ')'; x.lineWidth = r() < 0.9 ? 1 : 2; const y = r() * h, x0 = r() * w; x.beginPath(); x.moveTo(x0, y); x.lineTo(x0 + 40 + r() * 400, y); x.stroke(); }
    }, [2, 2], true);
    // мармурова підлога: чорні плити з тонкими золотими швами й прожилками
    TX.marble = rtex(1024, 1024, (x, w, h) => {
      const r = prng(11);
      for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) { const g = 9 + r() * 6 | 0; x.fillStyle = 'rgb(' + g + ',' + g + ',' + (g + 5) + ')'; x.fillRect(tx * w / 2, ty * h / 2, w / 2, h / 2); }
      x.filter = 'blur(1.5px)';
      for (let i = 0; i < 46; i++) {
        x.strokeStyle = 'rgba(' + (r() < 0.25 ? '210,170,90' : '200,200,220') + ',' + (0.05 + r() * 0.1) + ')'; x.lineWidth = 0.6 + r() * 2.2;
        x.beginPath(); let px = r() * w, py = r() * h; x.moveTo(px, py);
        for (let k = 0; k < 6; k++) { const nx = px + (r() - 0.3) * 260, ny = py + (r() - 0.5) * 220; x.quadraticCurveTo(px + (r() - 0.5) * 160, py + (r() - 0.5) * 160, nx, ny); px = nx; py = ny; }
        x.stroke();
      }
      x.filter = 'none'; x.strokeStyle = 'rgba(190,150,80,.1)'; x.lineWidth = 2;
      for (const [ox, oy] of [[0, 0], [w / 2, 0], [0, h / 2], [w / 2, h / 2]]) x.strokeRect(ox + 1.5, oy + 1.5, w / 2 - 3, h / 2 - 3);
    }, [0.22, 0.22]);
    TX.marbleR = rtex(256, 256, (x, w, h) => { const r = prng(12); for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) { const g = 55 + r() * 40 | 0; x.fillStyle = 'rgb(' + g + ',' + g + ',' + g + ')'; x.fillRect(tx * w / 2, ty * h / 2, w / 2, h / 2); } }, [0.22, 0.22], true);
    // оксамит: дрібний «ворс»
    TX.velvet = rtex(256, 256, (x, w, h) => {
      const r = prng(3); x.fillStyle = '#5c0f22'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) { const k = r(); x.fillStyle = k < 0.5 ? 'rgba(20,0,6,.35)' : 'rgba(150,40,70,.22)'; x.fillRect(r() * w, r() * h, 1.5, 1.5); }
    }, [3, 3]);
    // карбон для ярусу
    TX.carbon = rtex(128, 128, (x, w, h) => {
      x.fillStyle = '#0e0c16'; x.fillRect(0, 0, w, h);
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const g = x.createLinearGradient(i * 16, j * 16, i * 16 + 16, j * 16 + 16); const on = (i + j) % 2; g.addColorStop(0, on ? '#24203a' : '#141222'); g.addColorStop(1, on ? '#0c0a14' : '#1d1a2e'); x.fillStyle = g; x.fillRect(i * 16, j * 16, 16, 16); }
    }, [3, 3]);
    // LED-екран: точки, яскравість — хвилями (смуги біжать угору зсувом текстури в кадрі)
    TX.led = rtex(256, 256, (x, w, h) => {
      x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
      for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
        const wv = 0.22 + 0.78 * Math.pow(0.5 + 0.5 * Math.sin(j / 32 * Math.PI * 2), 6);
        x.fillStyle = 'rgba(255,255,255,' + wv.toFixed(3) + ')'; x.beginPath(); x.arc(i * 8 + 4, j * 8 + 4, 2.6, 0, Math.PI * 2); x.fill();
      }
    }, [1.6, 0.7]);
    // стіна: вертикальні рифлені панелі (рельєф)
    TX.grooves = rtex(256, 32, (x, w, h) => { const g = x.createLinearGradient(0, 0, w, 0); for (let k = 0; k <= 8; k++) g.addColorStop(k / 8, k % 2 ? '#202020' : '#e0e0e0'); x.fillStyle = g; x.fillRect(0, 0, w, h); }, [2, 1], true);
    TX.blob = canvasTex(128, 128, (x, w, h) => { const g = x.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2); g.addColorStop(0, 'rgba(0,0,0,.75)'); g.addColorStop(0.5, 'rgba(0,0,0,.35)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); });
    TX.dot = canvasTex(32, 32, (x, w, h) => { const g = x.createRadialGradient(16, 16, 0, 16, 16, 16); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); });
    TX.ok = true; return TX;
  }
  // матеріали з GLB за іменем → текстури (матеріали спільні для всіх клонів — достатньо один раз)
  function dressMaterials(scene) {
    const T = textures(), seen = new Set();
    scene.traverse(o => {
      if (!o.isMesh || !o.material || seen.has(o.material)) return; const m = o.material; seen.add(m);
      switch (m.name) {
        case 'DND_Alu': Object.assign(m, { roughnessMap: T.brushed, bumpMap: T.brushed, bumpScale: 0.0012, roughness: 1.25, metalness: 1.0, envMapIntensity: 0.55 }); m.color.set('#c2c8d2'); break;
        case 'DND_Ped': Object.assign(m, { roughnessMap: T.brushed, bumpMap: T.brushed, bumpScale: 0.001, roughness: 0.9, metalness: 0.85, envMapIntensity: 0.7 }); break;
        case 'DND_Trim': Object.assign(m, { roughnessMap: T.brushed, roughness: 1.15, metalness: 1.0, envMapIntensity: 0.8 }); break;
        case 'DND_Velvet': m.map = T.velvet; m.color.set('#ffffff'); m.roughness = 1; m.metalness = 0; break;
        case 'DND_Tier': m.map = T.carbon; m.color.set('#ffffff'); m.roughness = 0.38; m.metalness = 0.4; break;
        case 'DND_Wall': Object.assign(m, { bumpMap: T.grooves, bumpScale: 0.02, roughness: 0.55, metalness: 0.3 }); break;
        case 'DND_Floor': Object.assign(m, { map: T.marble, roughnessMap: T.marbleR, roughness: 0.55, metalness: 0.35 }); m.color.set('#ffffff'); break;
        case 'DND_PhoneBlack': m.roughness = 0.12; m.metalness = 0.3; break;
        default: return;
      }
      m.needsUpdate = true;
    });
  }
  // Стрімеру гра йде паралельно з OBS: якщо середній кадр довший за ~22 мс (менше ~45 к/с),
  // по кроку знижуємо якість: 1 — роздільність ×1, 2 — без дзеркальної підлоги, 3 — без світіння.
  function autoQuality(now) {
    const q = R.q || (R.q = { t0: now, n: 0, last: now, lvl: 0 });
    const dt = now - q.last; q.last = now;
    if (dt > 250) { q.t0 = now; q.n = 0; return; }             // вкладка була прихована — не рахуємо
    q.n++;
    if (now - q.t0 < 2500) return;
    const avg = (now - q.t0) / q.n; q.t0 = now; q.n = 0;
    if (avg < 22 || q.lvl >= 3) return;
    q.lvl++; R.quality = q.lvl;
    if (q.lvl === 1) { R.renderer.setPixelRatio(1); resize(); }
    if (q.lvl === 2 && R.mirror) { R.mirror.visible = false; R.scene.traverse(m => { if (m.isMesh && m.material && m.material.name === 'DND_Floor') { m.material.transparent = false; m.material.opacity = 1; m.material.needsUpdate = true; } }); }
    console.info('[dnd] автоякість: крок ' + q.lvl + ' (кадр ≈' + avg.toFixed(1) + ' мс)');
  }
  function setupComposer() {
    if (!THREE.EffectComposer || !THREE.UnrealBloomPass || R.composer) return;
    // HDR-буфер: світні матеріали яскравіші за 1.0 — саме вони й світяться
    const sz0 = R.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(sz0.x, sz0.y, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.HalfFloatType });
    rt.texture.encoding = THREE.sRGBEncoding;
    const c = new THREE.EffectComposer(R.renderer, rt);
    c.addPass(new THREE.RenderPass(R.scene, R.camera));
    const sz = R.renderer.getSize(new THREE.Vector2());
    R.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(sz.x, sz.y), 0.85, 0.5, 0.9);   // поріг високий: світиться лише неон / екрани, не метал під прожектором
    c.addPass(R.bloom);
    R.composer = c;
  }

  // ── сцена ──
  async function ensureScene() {
    const host = $('dnd-stage');
    if (R) { if (R.canvas.parentNode !== host) host.appendChild(R.canvas); return R; }
    const [gltf, phoneGltf] = await Promise.all([new Promise((ok, no) => new THREE.GLTFLoader().load(GLB, ok, undefined, no)),
      new Promise(ok => new THREE.GLTFLoader().load(PHONE_GLB, ok, undefined, e => { console.warn('[dnd] телефон не завантажився', e); ok(null); })), loadPost()]);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const canvas = renderer.domElement; host.appendChild(canvas);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#05040a'); scene.fog = new THREE.Fog('#05040a', 22, 40);
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 120);
    // оточення для металу: темна сфера з кількома світними панелями (студійні софтбокси)
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(60, 24, 12), new THREE.MeshBasicMaterial({ color: '#0a0812', side: THREE.BackSide })));
    for (const [c, x, y, z, w, h] of [['#a89f8e', 0, 40, 8, 50, 10], ['#ffcf7a', -38, 12, 18, 16, 26], ['#9b7bff', 38, 10, 14, 16, 22], ['#5fe6ff', 0, 8, -40, 60, 6], ['#6a5a90', 0, 14, 40, 30, 6]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    }
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(env, 0.03).texture;
    scene.add(new THREE.HemisphereLight('#d9d2ff', '#120c1c', 0.45));
    const key = new THREE.DirectionalLight('#fff2dc', 0.9); key.position.set(-6, 14, 12); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -14, right: 14, top: 12, bottom: -10, near: 1, far: 40 }); key.shadow.bias = -0.0006;
    scene.add(key);
    const rim = new THREE.DirectionalLight('#9a7bff', 0.2); rim.position.set(8, 9, -10); scene.add(rim);
    // прожектор, що «веде» активний кейс
    const spot = new THREE.SpotLight('#fff1d0', 0, 22, 0.12, 0.5, 1.2);   // вузький: світить лише відкритий кейс, не сусідів spot.position.set(0, 12, 4); spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0004; scene.add(spot); scene.add(spot.target);
    // теплий прожектор над подіумом гравця (вмикається, коли кейс обрано) — з тінню
    const podSpot = new THREE.SpotLight('#ffe2a8', 0, 22, 0.3, 0.65, 1.3); podSpot.position.set(POD.x + 1.2, 10.5, POD.z + 2.4); podSpot.target.position.copy(POD);
    podSpot.castShadow = true; podSpot.shadow.mapSize.set(1024, 1024); podSpot.shadow.bias = -0.0004; scene.add(podSpot); scene.add(podSpot.target);

    const root = gltf.scene;
    const tpl = n => root.getObjectByName(n);
    const tCase = tpl('DND_CaseRig'), tPed = tpl('DND_Pedestal'), tPod = tpl('DND_Podium'), tPhone = tpl('DND_PhoneSet'), tStage = tpl('DND_Stage');
    [tCase, tPed, tPod, tPhone].forEach(o => o.parent && o.parent.remove(o));
    const glowable = (o) => o.traverse(m => {
      if (!m.isMesh) return; m.castShadow = true; m.receiveShadow = true;
      const n = m.material && m.material.name;
      if (n === 'DND_Glow' || n === 'DND_Neon' || n === 'DND_NeonGold') { m.material = m.material.clone(); m.material.toneMapped = false; m.material.emissiveIntensity = n === 'DND_NeonGold' ? 1.35 : n === 'DND_Glow' ? 1.45 : 1.4; if (n === 'DND_Neon') m.material.emissive.set('#12a8ff'); m.castShadow = false; }   // ≈1: колір не вигорає в біле, поріг світіння все одно перевищено
    });
    scene.add(tStage); glowable(tStage);
    tStage.traverse(m => { if (m.isMesh && m.material && m.material.name === 'DND_Floor') { m.castShadow = false; m.renderOrder = 1; } });
    const fl = tStage.getObjectByName('DND_Floor');
    if (fl) fl.traverse(m => { if (m.isMesh && m.material.name === 'DND_NeonGold') { m.material.color.multiplyScalar(0.16); m.material.emissive.multiplyScalar(0.16); } if (m.isMesh) m.castShadow = false; });
    // LED-панелі стіни — один спільний матеріал, анімується
    let wallMat = null; tStage.traverse(m => { if (m.isMesh && m.material && m.material.name === 'DND_Screen') { if (!wallMat) { wallMat = m.material.clone(); wallMat.toneMapped = false; wallMat.emissiveMap = textures().led; wallMat.emissiveIntensity = 2.2; } m.material = wallMat; m.castShadow = false; } });
    // великий екран — полотно
    const scr = { c: document.createElement('canvas') }; scr.c.width = scr.c.height = 1024; scr.ctx = scr.c.getContext('2d');
    scr.tex = new THREE.CanvasTexture(scr.c); scr.tex.encoding = THREE.sRGBEncoding;
    scr.tex.flipY = false;   // UV екрана з Blender ідуть згори вниз
    const bigScreen = tStage.getObjectByName('DND_BigScreen');
    if (bigScreen) bigScreen.traverse(m => { if (m.isMesh) { m.material = new THREE.MeshBasicMaterial({ map: scr.tex, toneMapped: false }); m.material.color.setScalar(0.92); m.castShadow = false; } });

    // розкладка: задній ряд (1–8) на ярусі, передній (9–16) — ближче до камери
    const slots = [];
    const row = (R0, deg, y) => { const out = []; for (let i = 0; i < 8; i++) { const a = THREE.MathUtils.degToRad(-deg + (2 * deg) * i / 7); out.push({ p: new THREE.Vector3(C.x + R0 * Math.sin(a), y, C.z - R0 * Math.cos(a)) }); } return out; };
    slots.push(...row(9.6, 29, 0.75), ...row(7.0, 36, 0));
    const peds = [], cases = [];
    const seatOf = (o, name) => { o.updateMatrixWorld(true); const s = o.getObjectByName(name); const p = new THREE.Vector3(), q = new THREE.Quaternion(); s.getWorldPosition(p); s.getWorldQuaternion(q); return { p, q }; };
    slots.forEach((sl, i) => {
      const ped = tPed.clone(true); glowable(ped);
      ped.position.copy(sl.p); const d = C.clone().sub(sl.p); ped.rotation.y = Math.atan2(d.x, d.z);
      scene.add(ped);
      const glow = []; ped.traverse(m => { if (m.isMesh && m.material.name === 'DND_Glow') glow.push(m.material); });
      const seat = seatOf(ped, 'DND_Seat');
      peds.push({ o: ped, glow, seat, dir: new THREE.Vector3(d.x, 0, d.z).normalize() });
      const rig = tCase.clone(true); glowable(rig);
      rig.userData.n = i + 1;
      const lid = rig.getObjectByName('DND_CaseLid'), base = rig.getObjectByName('DND_CaseBase');
      lid.userData.q0 = lid.quaternion.clone();
      // номер на кришці
      const pmat = new THREE.MeshStandardMaterial({ map: numberTex(i + 1), metalness: 0.45, roughness: 0.4, envMapIntensity: 0.6, emissive: '#ffd36a', emissiveIntensity: 0 });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.436), pmat);
      plate.rotation.x = -Math.PI / 2; plate.position.set(0, 0.1135, 0.38); lid.add(plate);
      // табличка з сумою всередині (текстура — лише коли кейс відкривають)
      const vmat = new THREE.MeshStandardMaterial({ color: '#2b0612', roughness: 0.8, emissive: '#ffffff', emissiveIntensity: 0 });
      const vplate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.62), vmat);
      vplate.rotation.x = -Math.PI / 2; vplate.position.set(0, 0.026, 0); vplate.visible = false; base.add(vplate);   // сума на дні — лише в кейсі гравця наприкінці (plateValue)
      rig.position.copy(seat.p); rig.quaternion.copy(seat.q);
      scene.add(rig);
      cases.push({ o: rig, lid, base, vmat, vplate, pmat, home: i, at: { p: seat.p.clone(), q: seat.q.clone() } });
    });
    const podium = tPod.clone(true); glowable(podium); podium.position.copy(POD); podium.rotation.y = Math.atan2(-POD.x, CAM0.pos.z - POD.z); scene.add(podium);
    const podGlow = []; podium.traverse(m => { if (m.isMesh && m.material.name === 'DND_Glow') podGlow.push(m.material); });
    const podSeat = seatOf(podium, 'DND_PodiumSeat');
    const phone = tPhone.clone(true); glowable(phone); phone.position.copy(PHONE); phone.rotation.y = Math.atan2(-PHONE.x, CAM0.pos.z - PHONE.z) - 0.35; scene.add(phone);
    let handset = phone.getObjectByName('DND_Handset');
    if (phoneGltf) {
      // свій телефон ховаємо, на столик ставимо модель (стільниця — y 0.976 у координатах столика)
      for (const n of ['DND_PhoneBody', 'DND_PhoneParts', 'DND_Handset', 'DND_Cord']) { const o = phone.getObjectByName(n); if (o) o.visible = false; }
      const ph2 = phoneGltf.scene; ph2.position.set(0, 0.976, 0.02); phone.add(ph2);
      ph2.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; if (m.material) { m.material.envMapIntensity = 0.9; } } });
      handset = ph2.getObjectByName('DND_Phone2Handset') || handset;
    }
    handset.userData.p0 = handset.position.clone(); handset.userData.r0 = handset.rotation.clone();
    // світні «промені» прожекторів (фейковий об'єм)
    const beamTex = canvasTex(8, 256, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); });
    const beams = [];
    for (const [x, z, c] of [[-9, -7, '#9b7bff'], [-3.5, -7.6, '#5fe6ff'], [3.5, -7.6, '#ffcf7a'], [9, -7, '#ff6bd6']]) {
      const g = new THREE.CylinderGeometry(0.12, 2.2, 14, 32, 1, true); g.translate(0, -7, 0);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: beamTex, color: c, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false }));
      m.position.set(x, 9.5, z); m.material.opacity = 0.07; scene.add(m); beams.push(m);
    }
    // ореол над подіумом гравця
    const podBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 1.4, 9, 32, 1, true).translate(0, -4.5, 0), new THREE.MeshBasicMaterial({ map: beamTex, color: '#ffd36a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false }));
    podBeam.position.set(POD.x, 9.2, POD.z); scene.add(podBeam);

    dressMaterials(scene);
    // м'які «контактні» тіні під підставками (дешевий AO)
    const blob = (x, y, z, s) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: textures().blob, transparent: true, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.position.set(x, y + 0.012, z); m.renderOrder = 2; scene.add(m); };
    slots.forEach(sl => blob(sl.p.x, sl.p.y, sl.p.z, 1.7));
    blob(POD.x, 0, POD.z, 2.8); blob(PHONE.x, 0, PHONE.z, 2.0);
    // дзеркальна підлога: справжнє відображення під напівпрозорим мармуром
    let mirror = null;
    if (THREE.Reflector) {
      const pr = renderer.getPixelRatio();
      mirror = new THREE.Reflector(new THREE.CircleGeometry(12.5, 96), { clipBias: 0.003, textureWidth: 1024 * pr, textureHeight: 576 * pr, color: 0x9a9aa6 });
      mirror.rotation.x = -Math.PI / 2; mirror.position.set(0, -0.01, -0.5); scene.add(mirror);
      tStage.traverse(m => { if (m.isMesh && m.material && m.material.name === 'DND_Floor') { m.material.transparent = true; m.material.opacity = 0.8; } });
    }
    // пил у світлі прожекторів
    const DN = 420, dpos = new Float32Array(DN * 3), dr = prng(5);
    for (let i = 0; i < DN; i++) { dpos[i * 3] = (dr() - 0.5) * 22; dpos[i * 3 + 1] = dr() * 9; dpos[i * 3 + 2] = -9 + dr() * 15; }
    const dgeo = new THREE.BufferGeometry(); dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    const dust = new THREE.Points(dgeo, new THREE.PointsMaterial({ size: 0.06, map: textures().dot, color: '#ffe9c4', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    scene.add(dust);
    R = { renderer, canvas, scene, camera, key, spot, podSpot, mirror, dust, cases, peds, podium, podGlow, podSeat, podBeam, phone, handset, beams, wallMat, scr,
      cam: { pos: CAM0.pos.clone(), look: CAM0.look.clone(), tw: null }, tweens: [], parts: [], ghosts: [], wisps: [], raf: 0, ring: 0, flash: null };
    const ray = new THREE.Raycaster(), mv = new THREE.Vector2();
    const pick = ev => {
      const r = canvas.getBoundingClientRect(); mv.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mv, camera);
      const hit = ray.intersectObjects(cases.map(c => c.o), true)[0]; if (!hit) return 0;
      let o = hit.object; while (o && !o.userData.n) o = o.parent;
      return o ? o.userData.n : 0;
    };
    canvas.addEventListener('pointerdown', ev => { if (!S) return; const n = pick(ev); if (n) onCase(n); });
    // під курсором — кейс, який зараз можна вибрати/відкрити: світиться табличка, курсор-рука
    canvas.addEventListener('pointermove', ev => { const n = S ? pick(ev) : 0; R.hover = n && clickable(n) ? n : 0; canvas.style.cursor = R.hover ? 'pointer' : 'default'; });
    canvas.addEventListener('pointerleave', () => { R.hover = 0; });
    setupComposer();
    resize(); window.addEventListener('resize', resize);
    return R;
  }
  function resize() {
    if (!R) return;
    const host = $('dnd-stage'), w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    R.renderer.setSize(w, h, false); R.canvas.style.width = w + 'px'; R.canvas.style.height = h + 'px';
    R.camera.aspect = w / h; R.camera.fov = w / h < 1.2 ? 62 : w / h < 1.6 ? 48 : 40; R.camera.updateProjectionMatrix();
    if (R.composer) { R.composer.setSize(w, h); R.composer.setPixelRatio && R.composer.setPixelRatio(R.renderer.getPixelRatio()); }
    if (R.mirror) { const pr = R.renderer.getPixelRatio(); R.mirror.getRenderTarget().setSize(Math.round(w * pr * 0.6), Math.round(h * pr * 0.6)); }
  }

  // ── анімації ──
  function tween(dur, fn) { return new Promise(res => { R.tweens.push({ t0: performance.now(), dur, fn, res }); }); }
  function camTo(pos, look, dur) {
    const c = R.cam; c.tw = { p0: c.pos.clone(), l0: c.look.clone(), p1: pos.clone(), l1: look.clone(), t0: performance.now(), dur: dur || 1100 };
    return wait(dur || 1100);
  }
  const camHome = d => camTo(CAM0.pos, CAM0.look, d);
  function caseView(ci) {   // точка камери для кейса: спереду-зверху від пюпітра
    const c = R.cases[ci - 1], p = c.o.position.clone();
    const dir = c.onPodium ? new THREE.Vector3(-POD.x, 0, CAM0.pos.z - POD.z).normalize() : R.peds[c.home].dir;
    return { pos: p.clone().addScaledVector(dir, 3.1).add(new THREE.Vector3(0, 2.3, 0)), look: p.clone().add(new THREE.Vector3(0, 0.15, 0)) };
  }
  function setGlow(mats, hex, k) { for (const m of mats) { m.color.set(hex); m.emissive.set(hex).multiplyScalar(k == null ? 1 : k); } }
  // кейс коротко здригається (замки «клацають») — пауза-напруга перед кришкою
  function shakeCase(ci, dur) {
    const c = R.cases[ci - 1], q0 = c.o.quaternion.clone(), p0 = c.o.position.clone(), qz = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
    return tween(dur || 420, k => {
      const a = Math.sin(k * Math.PI * 7) * (1 - k) * 0.05;
      qz.setFromAxisAngle(Z, a); c.o.quaternion.copy(q0).multiply(qz);
      c.o.position.copy(p0); c.o.position.y += Math.abs(Math.sin(k * Math.PI * 7)) * (1 - k) * 0.03;
      if (k >= 1) { c.o.quaternion.copy(q0); c.o.position.copy(p0); }
    });
  }
  function flyCase(ci, to, dur) {
    const c = R.cases[ci - 1], p0 = c.o.position.clone(), q0 = c.o.quaternion.clone();
    sfx('whoosh');
    return tween(dur || 1300, k => {
      const e = ease(k);
      c.o.position.lerpVectors(p0, to.p, e); c.o.position.y += Math.sin(Math.PI * e) * 2.2;
      THREE.Quaternion.slerp(q0, to.q, c.o.quaternion, e);
      c.o.rotateY(Math.sin(Math.PI * e) * 0.6);
    });
  }
  function openLid(ci, dur) {
    const c = R.cases[ci - 1], qx = new THREE.Quaternion(), X = new THREE.Vector3(1, 0, 0);
    sfx('open');
    return tween(dur || 900, k => { qx.setFromAxisAngle(X, -1.95 * backOut(k)); c.lid.quaternion.copy(c.lid.userData.q0).multiply(qx); });
  }
  function showValue(ci) {
    const sorted = S.values.slice().sort((a, b) => a - b);
    // сума на дні кейса не пишеться: в один момент вона видна лише раз — привидом над кейсом
    return sorted.indexOf(S.cases[ci].v) / (N - 1);
  }
  function burst(pos, cols, n) {
    for (let i = 0; i < n; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.14), new THREE.MeshBasicMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide, toneMapped: false }));
      p.position.copy(pos); R.scene.add(p);
      R.parts.push({ o: p, v: new THREE.Vector3((Math.random() - 0.5) * 5, 3 + Math.random() * 5, (Math.random() - 0.5) * 5), life: 2.2 });
    }
  }

  // ── кадр ──
  function frame() {
    const ov = $('dnd-overlay');
    if (!R || !ov || !ov.classList.contains('visible')) { if (R) R.raf = 0; return; }
    R.raf = requestAnimationFrame(frame);
    const now = performance.now(), T = now / 1000;
    R.fdt = Math.min(0.05, Math.max(0.001, (now - (R.lastNow || now)) / 1000)) || 1 / 60; R.lastNow = now;
    for (let i = R.tweens.length - 1; i >= 0; i--) {
      const t = R.tweens[i], k = Math.min(1, (now - t.t0) / t.dur); t.fn(k);
      if (k >= 1) { R.tweens.splice(i, 1); t.res(); }
    }
    // камера
    const c = R.cam;
    if (c.tw) { const k = Math.min(1, (now - c.tw.t0) / c.tw.dur), e = ease(k); c.pos.lerpVectors(c.tw.p0, c.tw.p1, e); c.look.lerpVectors(c.tw.l0, c.tw.l1, e); if (k >= 1) c.tw = null; }
    R.camera.position.set(c.pos.x + Math.sin(T * 0.37) * 0.12, c.pos.y + Math.sin(T * 0.53) * 0.06, c.pos.z);
    R.camera.lookAt(c.look);
    // LED-стіна: повільний перелив, спалах подій
    if (R.wallMat) {
      const base = new THREE.Color().setHSL(0.72 + Math.sin(T * 0.25) * 0.06, 0.7, 0.085 + 0.02 * Math.sin(T * 1.3));
      if (R.flash) { const k = Math.max(0, 1 - (now - R.flash.t) / R.flash.d); base.lerp(new THREE.Color(R.flash.c), k * (0.6 + 0.4 * Math.sin(now / 60))); if (k <= 0) R.flash = null; }
      R.wallMat.emissive.copy(base); R.wallMat.color.set('#000000');
    }
    R.beams.forEach((b, i) => { b.rotation.z = Math.sin(T * 0.6 + i * 1.7) * 0.32; b.rotation.x = Math.cos(T * 0.45 + i) * 0.12; });
    tickGhosts(now, R.fdt || 1 / 60);
    R.cases.forEach((cc, i) => {
      const n = i + 1, idle = clickable(n) ? 0.06 + 0.06 * Math.sin(T * 2.2 + i * 0.7) : 0;
      const t = R.hover === n ? 0.55 + 0.2 * Math.sin(T * 8) : idle;
      cc.pmat.emissiveIntensity += (t - cc.pmat.emissiveIntensity) * 0.25;
    });
    R.podBeam.material.opacity += ((S && S.mine ? 0.22 : 0) - R.podBeam.material.opacity) * 0.05;
    // телефон дзвонить: трубка підстрибує
    const hs = R.handset;
    if (R.ring > now) { const k = Math.sin(now / 28); hs.position.y = hs.userData.p0.y + Math.abs(k) * 0.05; hs.rotation.z = hs.userData.r0.z + k * 0.08; }
    else { hs.position.copy(hs.userData.p0); hs.rotation.copy(hs.userData.r0); }
    for (let i = R.parts.length - 1; i >= 0; i--) {
      const p = R.parts[i]; p.v.y -= 9.8 / 60; p.o.position.addScaledVector(p.v, 1 / 60); p.o.rotation.x += 0.2; p.o.rotation.y += 0.15; p.life -= 1 / 60;
      if (p.life <= 0) { R.scene.remove(p.o); p.o.geometry.dispose(); p.o.material.dispose(); R.parts.splice(i, 1); }
    }
    // пил повільно пливе вгору; LED-хвилі біжать стіною; прожектор подіуму
    const dp = R.dust.geometry.attributes.position;
    for (let i = 0; i < dp.count; i++) { let y = dp.getY(i) + 0.004; if (y > 9) y = 0; dp.setY(i, y); dp.setX(i, dp.getX(i) + Math.sin(T * 0.3 + i) * 0.002); }
    dp.needsUpdate = true;
    if (R.wallMat && R.wallMat.emissiveMap) R.wallMat.emissiveMap.offset.y = -T * 0.06;
    R.podSpot.intensity += ((S && S.mine ? 0.55 : 0.35) - R.podSpot.intensity) * 0.05;
    if (R.composer && R.quality < 3) R.composer.render(); else R.renderer.render(R.scene, R.camera);
    autoQuality(now);
  }

  // ── підготовка столу ──
  function resetScene() {
    clearGhosts();
    R.tweens.length = 0;
    R.cases.forEach((c, i) => {
      c.home = i; c.onPodium = false;
      c.o.position.copy(R.peds[i].seat.p); c.o.quaternion.copy(R.peds[i].seat.q);
      c.lid.quaternion.copy(c.lid.userData.q0);
      c.vmat.map = null; c.vmat.emissiveMap = null; c.vmat.color.set('#2b0612'); c.vmat.emissiveIntensity = 0; c.vmat.needsUpdate = true; c.vplate.visible = false;
      c.o.visible = true;
    });
    R.peds.forEach(p => setGlow(p.glow, '#ffcf5a', 1));
    setGlow(R.podGlow, '#ffcf5a', 0.6);
    R.cam.pos.copy(CAM0.pos); R.cam.look.copy(CAM0.look); R.cam.tw = null;
    for (const p of R.parts) R.scene.remove(p.o); R.parts = [];
    R.spot.intensity = 0; R.ring = 0;
  }
  function dealValues() {
    const sh = shuffled(S.values);
    for (let n = 1; n <= N; n++) S.cases[n] = { v: sh[n - 1], open: false };
  }
  const openedCount = () => { let k = 0; for (let n = 1; n <= N; n++) if (S.cases[n].open && n !== S.mine) k++; return k; };
  const closedOthers = () => { const a = []; for (let n = 1; n <= N; n++) if (!S.cases[n].open && n !== S.mine) a.push(n); return a; };

  // ── хід гри ──
  // підготовка студії у фоні (поки крутиться рулетка): модель, текстури, світіння, шейдери, музика, шрифти
  async function prepScene() {
    try {
      await ensureScene();
      if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, wait(800)]);
      resize(); resetScene();
      // перший кадр — заздалегідь: компілюються шейдери, дзеркало, світіння (інакше гра «пригальмовує» на старті)
      try { R.renderer.compile(R.scene, R.camera); if (R.composer) R.composer.render(); else R.renderer.render(R.scene, R.camera); } catch (e) {}
      themeLoad();
      return true;
    } catch (e) { console.warn('[dnd] модель не завантажилась', e); return false; }
  }
  // хто грає — тією ж рулеткою, що й «Дефолт» (ролл random.org серед допущених: тіньовий бан — крутиться, але не випадає)
  async function pickPlayer(pool) {
    const drawPool = typeof blEligible === 'function' && blEligible(pool).length ? blEligible(pool) : pool;
    const pick = async () => (await rollPick(drawPool, 1, 'Нищий кейс: кто играет (из ' + drawPool.length + ')'))[0];
    if (typeof window.rouletteSpin === 'function') return window.rouletteSpin({ pool, pick, hint: 'Кто играет в «Нищий кейс»?' });
    return pick();
  }
  // рулетка показала гравця → дочекатись студії → прибрати рулетку
  async function afterSpin(player, sceneP, my) {
    const hint = document.getElementById('roulette-overlay-hint');
    if (hint) hint.innerHTML = '🎉 Играет: <b>' + esc(player) + '</b>';
    const t0 = performance.now();
    const ready = await Promise.race([sceneP, wait(30).then(() => 'wait')]);
    let ok = ready;
    if (ready === 'wait') { if (hint) hint.innerHTML += ' · загружаем студию…'; ok = await sceneP; }
    await wait(Math.max(0, 1300 - (performance.now() - t0)));     // дати глядачам побачити, хто випав
    if (my !== token) return false;
    if (typeof hideRouletteOverlay === 'function') hideRouletteOverlay();
    return ok;
  }
  function setPlayer(player) {
    S.player = player;
    $('dnd-who-n').textContent = player; $('dnd-who').classList.remove('dnd-rolling');
    if (window.WC) WC.avatar($('dnd-av'), player);
  }
  // ── хто грає: вписати нік (нагорода за бали каналу) або рулетка серед учасників ──
  const norm = n => String(n || '').trim().replace(/^@+/, '').toLowerCase();
  const CHATTERS = [];                                   // хто нещодавно писав у чат — підказки для поля ніку
  function poolNow() {
    const drawn = new Set(winnersHistory.map(w => norm(w.name)));
    return state.participants.filter(p => !drawn.has(norm(p)));
  }
  function ensureChooser() {
    if ($('dnd-start')) return;
    const m = document.createElement('div'); m.id = 'dnd-start'; m.className = 'dnd-start';
    m.innerHTML =
      '<div class="dnd-start-card" role="dialog" aria-label="Кто играет">' +
        '<button class="dnd-start-x" id="dnd-start-x" type="button" aria-label="Закрыть">' + ICO.no + '</button>' +
        '<div class="dnd-start-t">Кто играет в «Нищий кейс»?</div>' +
        '<div class="dnd-start-s">Впиши ник — например, кто взял награду за баллы канала</div>' +
        '<div class="dnd-start-row"><input id="dnd-start-nick" type="text" list="dnd-start-list" autocomplete="off" spellcheck="false" placeholder="Ник игрока">' +
          '<button class="dnd-btn dnd-deal" id="dnd-start-go" type="button">' + ICO.ok + 'Играть</button></div>' +
        '<datalist id="dnd-start-list"></datalist>' +
        '<div class="dnd-start-or"><span>или</span></div>' +
        '<button class="dnd-btn dnd-ghost dnd-start-roll" id="dnd-start-roll" type="button">' + ICO.again + '<span id="dnd-start-roll-t"></span></button>' +
      '</div>';
    document.body.appendChild(m);
    const go = () => {
      const nick = String($('dnd-start-nick').value || '').trim().replace(/^@+/, '');
      if (!nick) { $('dnd-start-nick').focus(); $('dnd-start-nick').classList.add('err'); setTimeout(() => $('dnd-start-nick').classList.remove('err'), 500); return; }
      closeChooser(); m._pick({ player: nick });
    };
    $('dnd-start-go').onclick = go;
    $('dnd-start-nick').addEventListener('keydown', e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { closeChooser(); m._pick(null); } });
    $('dnd-start-roll').onclick = () => { if ($('dnd-start-roll').disabled) return; closeChooser(); m._pick({ roll: true }); };
    $('dnd-start-x').onclick = () => { closeChooser(); m._pick(null); };
  }
  function closeChooser() { const m = $('dnd-start'); if (m) m.classList.remove('show'); }
  // показати вікно вибору; resolve({player}|{roll:true}|null)
  function askPlayer() {
    ensureChooser();
    return new Promise(res => {
      const m = $('dnd-start'), pool = poolNow();
      m._pick = res;
      const list = [...new Set([...CHATTERS.slice().reverse(), ...state.participants])].slice(0, 300);
      $('dnd-start-list').innerHTML = list.map(n => '<option value="' + esc(n) + '"></option>').join('');
      $('dnd-start-nick').value = '';
      const rb = $('dnd-start-roll'); rb.disabled = !pool.length;
      $('dnd-start-roll-t').textContent = pool.length ? 'Рулетка среди участников (' + pool.length + ')' : 'Рулетка — нет участников';
      m.classList.add('show');
      setTimeout(() => $('dnd-start-nick').focus(), 50);
    });
  }
  async function startDnd() {
    ensureDom();
    const choice = await askPlayer();
    if (!choice) return;
    const ov = $('dnd-overlay'); ov.classList.remove('visible');   // студія вантажиться прихованою (поки крутиться рулетка)
    $('dnd-result').classList.remove('show'); $('dnd-offer').classList.remove('show'); $('dnd-panel').classList.remove('dnd-locked');
    const my = ++token;
    phase = 'racing';
    setCtrl(''); say(''); clearChat();
    const sceneP = prepScene();
    let player = choice.player, pool = poolNow();
    if (choice.roll) {
      player = await pickPlayer(pool);
      if (my !== token || !player) return;
      const ok = await afterSpin(player, sceneP, my);
      if (my !== token) return;
      if (!ok || !R) { alert('Не удалось загрузить сцену «Нищий кейс» — обнови страницу'); phase = 'idle'; return; }
    } else {
      const ok = await sceneP;                                   // гравця вписали — лише дочекатись студії
      if (my !== token) return;
      if (!ok || !R) { alert('Не удалось загрузить сцену «Нищий кейс» — обнови страницу'); phase = 'idle'; return; }
    }
    ov.classList.add('visible'); resize();
    themePlay(MUS.bed);
    S = { state: 'choose', values: genValues(readCfg()), cases: {}, mine: 0, offers: [], busy: false, pool, manual: !choice.roll };
    dealValues(); renderBoard(true); renderOffers();
    setPlayer(player); sfx('good', 0.8);
    if (!R.raf) R.raf = requestAnimationFrame(frame);
    toChoose();
  }
  function toChoose() {
    S.state = 'choose';
    R.flash = { c: '#ffd36a', t: performance.now(), d: 900 };
    drawScreen([{ t: 'ВЫБЕРИ', size: 120 }, { t: 'СВОЙ КЕЙС', size: 120 }]);
    say('Выбери свой кейс', '<b>' + esc(S.player) + '</b> называет номер <b>1–16</b> — этот кейс будет его до конца игры');
    setCtrl('<button class="dnd-btn dnd-ghost" id="dnd-reroll">' + ICO.user + 'Другой игрок</button><button class="dnd-btn dnd-ghost" onclick="closeDndOverlay()">Закрыть</button>');
    // інший гравець — те саме вікно: вписати нік або рулетка (студія вже завантажена — на час прокруту ховаємо її)
    $('dnd-reroll').onclick = async () => {
      if (!S || S.state !== 'choose' || S.busy) return;
      const my = token; S.busy = true;
      const choice = await askPlayer();
      if (my !== token || !S) return;
      if (!choice) { S.busy = false; return; }
      let player = choice.player;
      if (choice.roll) {
        const rest = poolNow().filter(p => norm(p) !== norm(S.player));
        if (!rest.length) { S.busy = false; return; }
        setCtrl(''); say('');
        $('dnd-overlay').classList.remove('visible');
        player = await pickPlayer(rest);
        if (my !== token || !player) return;
        await afterSpin(player, Promise.resolve(true), my);
        if (my !== token) return;
        $('dnd-overlay').classList.add('visible'); resize();
        if (!R.raf) R.raf = requestAnimationFrame(frame);
      }
      clearChat(); setPlayer(player); sfx('good', 0.8);
      S.manual = !choice.roll; S.busy = false; toChoose();
    };
  }
  const clickable = n => !!S && !S.busy && !!S.cases[n] && (S.state === 'choose' || (S.state === 'open' && n !== S.mine && !S.cases[n].open));
  // клік стрімера по кейсу
  async function onCase(n) {
    if (!S || S.busy || !S.cases[n]) return;
    if (S.state === 'choose') return chooseMine(n);
    if (S.state !== 'open' || n === S.mine || S.cases[n].open) return;
    openOne(n);
  }
  async function chooseMine(n) {
    const my = token; S.busy = true; S.mine = n;
    $('dnd-panel').classList.add('dnd-locked');
    say('Кейс №' + n + ' — твой', '');
    setCtrl('');
    const c = R.cases[n - 1];
    setGlow(R.peds[c.home].glow, '#3b3550', 0.2);
    camTo(new THREE.Vector3(POD.x + 3.0, 4.0, POD.z + 5.6), new THREE.Vector3(POD.x + 0.6, 1.3, POD.z - 0.6), 1400);
    await flyCase(n, R.podSeat, 1500);
    if (my !== token) return;
    c.onPodium = true;
    setGlow(R.podGlow, '#ffd36a', 1.4);
    R.flash = { c: '#ffd36a', t: performance.now(), d: 700 }; sfx('good', 0.7);
    await wait(700);
    await camHome(1200);
    if (my !== token) return;
    S.state = 'open'; S.busy = false;
    promptOpen();
  }
  function promptOpen() {
    const op = openedCount(), next = BANK_AT.find(t => t > op) || 14, left = next - op;
    drawScreen([{ t: 'ОТКРОЙ', size: 120 }, { t: left + ' ' + caseWord(left).toUpperCase(), size: 110 }]);
    say((op === 0 || BANK_AT.includes(op) ? 'Открой ' : 'Открой ещё ') + left + ' ' + caseWord(left), '<b>' + esc(S.player) + '</b> называет номера — открываем по одному');
    setCtrl('<button class="dnd-btn dnd-ghost" id="dnd-bank">' + ICO.phone + 'Банкир</button><button class="dnd-btn dnd-ghost" onclick="closeDndOverlay()">Закрыть</button>');
    $('dnd-bank').onclick = () => { if (S && S.state === 'open' && !S.busy && openedCount() > 0) banker(); };
  }
  // камера не летить до кожного кейса: лишається на загальному плані й лише трохи «нахиляється» до нього
  function leanTo(n, dur) {
    const v = caseView(n);
    return camTo(CAM0.pos.clone().lerp(v.pos, 0.1), CAM0.look.clone().lerp(v.look, 0.3), dur || 700);
  }
  // сума вилітає з кейса «привидом»: напівпрозорий світний напис випливає з кейса, піднімається,
  // хитається, лишає димний слід і тане (3D-спрайт — світіння дає bloom)
  function ghostTex(n, val, col) {
    return canvasTex(640, 300, (x, w, h) => {
      x.textAlign = 'center'; x.textBaseline = 'middle';
      const s = fmt(val) + CUR; let fs = 118; x.font = '800 ' + fs + 'px ' + FONT;
      while (x.measureText(s).width > w - 70 && fs > 50) { fs -= 6; x.font = '800 ' + fs + 'px ' + FONT; }
      // кольорове сяйво в кілька шарів, поверх — майже білий «примарний» текст
      x.shadowColor = col;
      for (const [b, a] of [[46, 0.55], [22, 0.8], [8, 1]]) { x.shadowBlur = b; x.globalAlpha = a; x.fillStyle = col; x.fillText(s, w / 2, h / 2); }
      x.globalAlpha = 0.92; x.shadowBlur = 6; x.fillStyle = '#ffffff'; x.fillText(s, w / 2, h / 2);
    });
  }
  function ghostValue(n, val, bad) {
    const col = bad ? '#ff5a6e' : '#4dffa0';
    const c = R.cases[n - 1], from = c.o.position.clone().add(new THREE.Vector3(0, 0.15, 0));
    const mat = new THREE.SpriteMaterial({ map: ghostTex(n, val, col), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
    mat.color.setScalar(1.25);
    const sp = new THREE.Sprite(mat); sp.position.copy(from); sp.scale.set(0.01, 0.01, 1); sp.renderOrder = 10; R.scene.add(sp);
    const g = { sp, from, t0: performance.now(), dur: 2600, col, seed: Math.random() * 6, puffT: 0 };
    R.ghosts.push(g);
    // «видих» з кейса — хмарка світних частинок
    for (let i = 0; i < 8; i++) wisp(from.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, Math.random() * 0.2, (Math.random() - 0.5) * 0.3)), col, 0.3 + Math.random() * 0.3, new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4));
  }
  function wisp(pos, col, size, vel) {
    const m = new THREE.SpriteMaterial({ map: textures().dot, color: col, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
    const s = new THREE.Sprite(m); s.position.copy(pos); s.scale.setScalar(size); R.scene.add(s);
    R.wisps.push({ s, v: vel || new THREE.Vector3(0, 0.5, 0), life: 1, max: 0.9 + Math.random() * 0.5, size });
  }
  function tickGhosts(now, dt) {
    for (let i = R.ghosts.length - 1; i >= 0; i--) {
      const g = R.ghosts[i], k = Math.min(1, (now - g.t0) / g.dur), t = (now - g.t0) / 1000;
      const rise = 2.2 * (1 - Math.pow(1 - k, 2.2));                         // швидко вилітає, далі зависає
      const sway = Math.sin(t * 4.2 + g.seed) * 0.12 * (0.4 + k);
      g.sp.position.set(g.from.x + sway, g.from.y + 0.25 + rise, g.from.z + Math.cos(t * 3 + g.seed) * 0.05);
      const grow = Math.min(1, k / 0.22), sc = 3.3 * (0.25 + 0.75 * (1 - Math.pow(1 - grow, 3)));
      const stretch = 1 + (1 - grow) * 0.9 + Math.sin(t * 6 + g.seed) * 0.03;      // витягнутий, поки «вилазить» із кейса
      g.sp.scale.set(sc / Math.sqrt(stretch), sc * 0.47 * stretch, 1);
      g.sp.material.rotation = Math.sin(t * 2.6 + g.seed) * 0.06;
      const a = k < 0.12 ? k / 0.12 : k > 0.68 ? Math.max(0, 1 - (k - 0.68) / 0.32) : 1;
      g.sp.material.opacity = a * (0.85 + 0.15 * Math.sin(t * 9 + g.seed));      // ледь мерехтить
      // димний слід знизу
      g.puffT -= dt; if (g.puffT <= 0 && k < 0.8) { g.puffT = 0.07; wisp(g.sp.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, -0.45 - Math.random() * 0.25, 0)), g.col, 0.3 + Math.random() * 0.3, new THREE.Vector3((Math.random() - 0.5) * 0.2, -0.15 + Math.random() * 0.2, 0)); }
      if (k >= 1) { R.scene.remove(g.sp); g.sp.material.map.dispose(); g.sp.material.dispose(); R.ghosts.splice(i, 1); }
    }
    for (let i = R.wisps.length - 1; i >= 0; i--) {
      const w = R.wisps[i]; w.life -= dt / w.max;
      w.s.position.addScaledVector(w.v, dt); w.v.multiplyScalar(0.97);
      w.s.scale.setScalar(w.size * (1.6 - w.life * 0.6)); w.s.material.opacity = Math.max(0, w.life) * 0.22;
      if (w.life <= 0) { R.scene.remove(w.s); w.s.material.dispose(); R.wisps.splice(i, 1); }
    }
  }
  function clearGhosts() {
    if (!R) return;
    for (const g of R.ghosts) { R.scene.remove(g.sp); g.sp.material.dispose(); }
    for (const w of R.wisps) { R.scene.remove(w.s); w.s.material.dispose(); }
    R.ghosts = []; R.wisps = [];
  }
  async function openOne(n) {
    const my = token; S.busy = true; setCtrl('');
    S.cases[n].open = true;
    say('Кейс №' + n, '');
    R.spot.position.copy(R.cases[n - 1].o.position).add(new THREE.Vector3(0, 7, 2)); R.spot.target.position.copy(R.cases[n - 1].o.position); R.spot.intensity = 0.9;
    await leanTo(n, 650);
    if (my !== token) return;
    await shakeCase(n, 420); if (my !== token) return;
    const rank = showValue(n);
    await openLid(n, 950);
    if (my !== token) return;
    const val = S.cases[n].v;
    // велика сума з гри — погано для гравця (червоний), мала — добре (зелений)
    if (rank >= 0.5) { sfx('bad'); R.flash = { c: '#ff3b4f', t: performance.now(), d: 900 }; setGlow(R.peds[R.cases[n - 1].home].glow, '#ff3b4f', 1); }
    else { sfx('good'); R.flash = { c: '#35f08a', t: performance.now(), d: 900 }; setGlow(R.peds[R.cases[n - 1].home].glow, '#35f08a', 1); burst(R.cases[n - 1].o.position.clone().add(new THREE.Vector3(0, 0.4, 0)), ['#35f08a', '#a8ffcf', '#ffffff'], 40); }
    say('');
    ghostValue(n, val, rank >= 0.5);
    crossOut(val);
    await wait(1700);
    if (my !== token) return;
    R.spot.intensity = 0;
    setGlow(R.peds[R.cases[n - 1].home].glow, '#3b3550', 0.25);
    const op = openedCount();
    if (op >= 14) { await camHome(600); if (my !== token) return; S.busy = false; return final(); }
    if (BANK_AT.includes(op)) { S.busy = false; return banker(); }
    await camHome(600);
    if (my !== token) return;
    S.busy = false; promptOpen();
  }
  // Пропозиція банкіра (логіка ТВ-шоу):
  //  • база — середнє сум, що лишились у грі (разом зі своїм кейсом): вилетіли дрібні → пропозиція росте, великі → падає;
  //  • банкір не любить ризик: поки великі суми ще в грі, «справедлива» сума трохи нижча за середнє
  //    (суміш середнього арифметичного й геометричного — для однакових сум вони рівні);
  //  • гравцю й так гарантована найменша сума, що лишилась, — тому банкір пропонує
  //    «мінімум + частку того, що можна виграти понад мінімум»: пропозиція завжди вища за найменшу суму;
  //  • частка росте з раундом (BANK_K: 30% → 92%) — без ручних налаштувань;
  //  • ніколи не більше за найбільшу суму в грі; випадковість лише ±3%.
  function kOf(op) {
    for (let i = 1; i < BANK_K.length; i++) if (op <= BANK_K[i][0]) { const [a, ka] = BANK_K[i - 1], [b, kb] = BANK_K[i]; return ka + (kb - ka) * (op - a) / (b - a); }
    return BANK_K[BANK_K.length - 1][1];
  }
  function calcOffer() {
    const rem = []; for (let n = 1; n <= N; n++) if (!S.cases[n].open) rem.push(S.cases[n].v);
    const mean = rem.reduce((a, b) => a + b, 0) / rem.length;
    const geo = Math.exp(rem.reduce((a, b) => a + Math.log(Math.max(1, b)), 0) / rem.length);
    const fair = 0.65 * mean + 0.35 * geo;
    const lo = Math.min(...rem), hi = Math.max(...rem);
    const k = Math.min(0.97, kOf(openedCount()));
    let offer = lo + Math.max(0, fair - lo) * k * (1 + (rnd() * 0.06 - 0.03));
    offer = Math.min(hi * 0.97, offer);
    let v = roundOffer(offer);
    // після округлення пропозиція не має «зʼїхати» на найменшу суму — інакше в ній немає сенсу
    const step = v < 1000 ? 10 : v < 100000 ? 100 : 1000;
    if (v <= lo) v = lo + step * Math.max(1, Math.round((hi - lo) * 0.05 / step));
    if (v >= hi) v = Math.max(lo + step, hi - step);
    return { v, mean, pct: Math.round(v / mean * 100) };
  }
  async function banker() {
    const my = token; S.busy = true; S.state = 'banker'; setCtrl('');
    const calc = calcOffer(), offer = calc.v; S.offer = offer;
    const prev = S.offers.length ? S.offers[S.offers.length - 1].v : 0;
    say('Звонит банкир…', '');
    themeVol(MUS.bank, 1.2);
    drawScreen([{ t: 'ЗВОНИТ', size: 120 }, { t: 'БАНКИР', size: 130, c: '#ff6b7a' }], '#ff6b7a');
    const ph = R.phone.position;
    camTo(new THREE.Vector3(ph.x - 0.9, 2.05, ph.z + 1.85), new THREE.Vector3(ph.x, 1.12, ph.z), 1100);
    for (let k = 0; k < RINGS; k++) {
      R.ring = performance.now() + 900; R.flash = { c: '#ff3b4f', t: performance.now(), d: 900 }; sfx('ring');
      await wait(RING_MS); if (my !== token) return;
    }
    S.offers.push({ v: offer, open: true }); drawScreen([{ t: 'ЗАБРАТЬ', size: 110 }, { t: 'ИЛИ', size: 70, c: '#ff9aa8' }, { t: 'ИГРАТЬ?', size: 110 }], '#ff6b7a');
    const box = $('dnd-offer');
    box.innerHTML = '<div class="dnd-offer-k">' + ICO.phone + 'Банкир предлагает</div><div class="dnd-offer-v">' + money(offer) + '</div>' +
      '<div class="dnd-offer-m"><span>в среднем в кейсах <b>' + money(calc.mean) + '</b></span>' +
        (prev ? '<span class="' + (offer >= prev ? 'up' : 'down') + '">' + (offer >= prev ? '▲ +' : '▼ −') + fmt(Math.abs(offer - prev)) + ' к прошлому</span>' : '') + '</div>' +
      '<div class="dnd-offer-s"><b>' + esc(S.player) + '</b>: забрать деньги или играть дальше?</div>';
    box.classList.add('show');
    camHome(1000);
    // лічильник: від нуля до суми з уповільненням наприкінці (на картці й на великому екрані)
    const vEl = box.querySelector('.dnd-offer-v'), t0 = performance.now(), D = 1300;
    while (true) {
      const k = Math.min(1, (performance.now() - t0) / D), e = 1 - Math.pow(1 - k, 3), cur = roundOffer(Math.max(1, offer * e));
      vEl.textContent = money(k >= 1 ? offer : cur);
      if (k >= 1) break;
      await wait(50); if (my !== token) return;
    }
    vEl.classList.remove('dnd-tick'); void vEl.offsetWidth; vEl.classList.add('dnd-tick');
    await wait(200);
    if (my !== token) return;
    S.busy = false;
    say('');
    setCtrl('<button class="dnd-btn dnd-deal" id="dnd-yes">' + ICO.ok + 'Забрать</button><button class="dnd-btn dnd-nodeal" id="dnd-no">' + ICO.no + 'Играть дальше</button>');
    $('dnd-yes').onclick = () => decide(true); $('dnd-no').onclick = () => decide(false);
  }
  async function decide(deal) {
    if (!S || S.state !== 'banker' || S.busy) return;
    const my = token; S.busy = true; setCtrl('');
    $('dnd-offer').classList.remove('show');
    if (S.offers.length) { S.offers[S.offers.length - 1].open = false; renderOffers(); }
    themeVol(deal ? MUS.hush : MUS.bed, deal ? 0.6 : 1.2);
    if (!deal) {
      sfx('nodeal');
      R.flash = { c: '#5fe6ff', t: performance.now(), d: 600 };
      say('Играем дальше!', 'банкир остался ни с чем');
      await wait(900); if (my !== token) return;
      S.state = 'open'; S.busy = false; promptOpen(); return;
    }
    S.offers[S.offers.length - 1].taken = true; renderOffers();
    S.state = 'done'; sfx('deal');
    // сделка: показуємо, що було в його кейсі
    say('Забираю!', 'а что было в твоём кейсе?');
    await wait(1200); if (my !== token) return;
    const n = S.mine, v = caseView(n);
    themeVol(MUS.hush, 0.5); const roll = sfx('drumroll');
    await camTo(v.pos, v.look, 1100); if (my !== token) return sndStop(roll);
    await wait(1200); sndStop(roll); if (my !== token) return;
    plateValue(n, showValue(n)); await openLid(n, 950); if (my !== token) return;
    const inside = S.cases[n].v;
    say(inside > S.offer ? 'Банкир тебя переиграл' : 'Ты переиграл банкира!', '');
    await wait(1700); if (my !== token) return;
    // а що лежало в решті — відкриваємо все хвилею (як у ТВ-шоу після сделки)
    const rest = closedOthers();
    if (rest.length) {
      say('А что было в остальных кейсах?', '');
      await camHome(900); if (my !== token) return;
      for (const k of rest) {
        S.cases[k].open = true; const rk = showValue(k); openLid(k, 700); crossOut(S.cases[k].v); ghostValue(k, S.cases[k].v, rk >= 0.5);
        setGlow(R.peds[R.cases[k - 1].home].glow, S.values.slice().sort((a, b) => a - b).indexOf(S.cases[k].v) >= N / 2 ? '#ff3b4f' : '#35f08a', 1);
        await wait(260); if (my !== token) return;
      }
      await wait(2200); if (my !== token) return;
    }
    finish(S.offer);
  }
  async function final() {
    S.state = 'final'; themeVol(0.38, 1.2);
    const other = closedOthers()[0]; S.other = other;
    R.flash = { c: '#b46cff', t: performance.now(), d: 900 };
    drawScreen([{ t: 'ОСТАВИТЬ', size: 110 }, { t: 'ИЛИ', size: 70, c: '#cbb6ff' }, { t: 'ПОМЕНЯТЬ?', size: 110 }]);
    say('Финал: осталось 2 кейса', '<b>' + esc(S.player) + '</b>: <b>оставить</b> свой №' + S.mine + ' или <b>поменять</b> на №' + other + '?');
    setCtrl('<button class="dnd-btn dnd-deal" id="dnd-keep">' + ICO.keep + 'Оставить №' + S.mine + '</button><button class="dnd-btn dnd-swap" id="dnd-swap">' + ICO.swap + 'Поменять на №' + other + '</button>');
    $('dnd-keep').onclick = () => finalPick(false); $('dnd-swap').onclick = () => finalPick(true);
  }
  async function finalPick(swap) {
    if (!S || S.state !== 'final' || S.busy) return;
    const my = token; S.busy = true; setCtrl('');
    let mine = S.mine, other = S.other;
    if (swap) {
      say('Меняемся!', 'кейс №' + other + ' едет на подиум'); sfx('nodeal', 0.8);
      const a = R.cases[mine - 1], b = R.cases[other - 1], bHome = b.home;
      camTo(new THREE.Vector3(-1.2, 6.2, 12.2), new THREE.Vector3(-2.2, 1.1, 0.8), 1300);
      await Promise.all([flyCase(other, R.podSeat, 1600), flyCase(mine, R.peds[bHome].seat, 1600)]);
      if (my !== token) return;
      a.onPodium = false; a.home = bHome; b.onPodium = true;
      [mine, other] = [other, mine]; S.mine = mine; S.other = other; S.swapped = true;
    } else say('Оставляю свой!', '');
    await wait(500); if (my !== token) return;
    // напруга — лише на своєму кейсі: поки він закритий, у ньому може бути будь-яка з двох сум.
    // (раніше спершу відкривався кейс на полиці — і на табло вже було видно, що лишилось у своєму)
    say('');
    const v = caseView(mine);
    themeVol(MUS.hush, 0.5); const roll = sfx('drumroll');
    await camTo(v.pos, v.look, 1100); if (my !== token) return sndStop(roll);
    await wait(1600); sndStop(roll); if (my !== token) return;
    plateValue(mine, showValue(mine)); await openLid(mine, 1000); if (my !== token) return;
    S.state = 'done';
    // кейс на полиці відкривається одразу, без окремої паузи — просто щоб було видно, що там лежало
    S.cases[other].open = true; showValue(other); openLid(other, 800); crossOut(S.cases[other].v);
    setGlow(R.peds[R.cases[other - 1].home].glow, S.values.slice().sort((a, b) => a - b).indexOf(S.cases[other].v) >= N / 2 ? '#ff3b4f' : '#35f08a', 1);
    await wait(1800); if (my !== token) return;
    finish(S.cases[mine].v);
  }
  function finish(amount) {
    camHome(1200);
    themeStop(2.2);
    const my = token;
    S.state = 'done'; S.win = amount;
    sfx('win');
    R.flash = { c: '#ffd36a', t: performance.now(), d: 2400 };
    drawScreen([{ t: 'ПОБЕДА!', size: 150 }]);
    burst(R.podSeat.p.clone().add(new THREE.Vector3(0, 0.6, 0)), ['#ffc93d', '#ffe48a', '#53fc18', '#b46cff', '#ffffff', '#ff4d6a'], 120);
    say('');
    const res = $('dnd-result');
    res.innerHTML = '<div class="dnd-res-k">' + esc(S.player) + ' выигрывает</div><div class="dnd-res-v">' + money(amount) + '</div>';
    res.classList.add('show');
    setTimeout(() => {
      if (my !== token || !S) return;
      addWinner(S.player);
      phase = 'done';
      setCtrl('<button class="dnd-btn dnd-deal" onclick="startDnd()">' + ICO.again + 'Ещё раз</button><button class="dnd-btn dnd-ghost" onclick="closeDndOverlay()">Закрыть</button>');
    }, 1800);
  }

  // ── що пише гравець — бульбашками під його ніком (останні 3, кожна тане за ~15 с) ──
  function clearChat() { const c = $('dnd-chat'); if (c) c.innerHTML = ''; }
  function dndChat(user, content) {
    if (!user) return;
    const k = CHATTERS.indexOf(user); if (k >= 0) CHATTERS.splice(k, 1); CHATTERS.push(user); if (CHATTERS.length > 300) CHATTERS.shift();
    if (!S || !S.player || norm(user) !== norm(S.player)) return;
    const ov = $('dnd-overlay'), box = $('dnd-chat'); if (!ov || !box || !ov.classList.contains('visible')) return;
    const el = document.createElement('div'); el.className = 'dnd-msg';
    el.innerHTML = typeof parseChatContent === 'function' ? parseChatContent(String(content)) : esc(content);
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstElementChild);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 600); }, 15000);
  }
  function closeDndOverlay(silent) {
    closeChooser(); clearChat();
    themeStop(0.4);
    token++;
    const ov = $('dnd-overlay'); if (ov) ov.classList.remove('visible');
    for (const id of ['dnd-result', 'dnd-offer', 'dnd-say']) if ($(id)) $(id).classList.remove('show');
    clearGhosts();
    if (R) { R.tweens.length = 0; for (const p of R.parts) R.scene.remove(p.o); R.parts = []; }
    S = null;
    if (!silent && phase !== 'idle') { phase = 'idle'; resetGameUI(); }
  }
  window.startDnd = startDnd;
  window.closeDndOverlay = closeDndOverlay;
  window.dndChat = dndChat;
  window.__dnd = { get S() { return S; }, get R() { return R; }, get quality() { return R && R.quality || 0; }, get themeOn() { return !!TH.src; }, onCase, decide, finalPick, genValues };   // для відладки з консолі
})();
