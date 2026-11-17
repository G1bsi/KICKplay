/* ══════════════════════════════════════════════════════════════
   Рулетка «Дефолт» у новому вигляді: canvas-барабан замість CSS-стрічки.
   Переможця, як і раніше, обирає rollInt (random.org, фолбек — crypto) серед тих,
   хто ще не випадав; тут лише показ:
   • картки з аватаркою Kick (або кольоровою літерою), cover-flow до центру;
   • розмиття на швидкості, клацання щоразу, як картка проходить під стрілкою;
   • зупинка «на волосинку» (випадкове місце в межах картки) і доводка в центр;
   • переможець — золота картка з променями й конфеті.
   Звуки — синтез WebAudio (без файлів). Без canvas 2D лишається стара стрічка.
   ══════════════════════════════════════════════════════════════ */
(function () {
  const orig = { start: window.startRoulette, hide: window.hideRouletteOverlay };
  const CW = 168, GAP = 16, STEP = CW + GAP, CH = 212;     // картка, крок, висота (CSS-пікселі)
  const N = 72, WIN = 62;                                  // довжина стрічки й місце переможця
  let S = null, token = 0;

  // ── аватарки: той самий ендпоінт, що й у списку учасників (браузер уже має їх у кеші) ──
  const AV = new Map();
  function avatar(name) {
    const k = String(name).toLowerCase();
    let a = AV.get(k);
    if (!a) {
      a = { img: new Image(), ok: false }; a.img.decoding = 'async';
      a.img.onload = () => { a.ok = a.img.naturalWidth > 0; };
      a.img.src = '/api/avatar/' + encodeURIComponent(name);
      AV.set(k, a);
    }
    return a;
  }
  function hueOf(s) { let h = 2166136261; s = String(s).toLowerCase(); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; }

  // ── звук: короткі клацання під стрілкою, «вжух» на старті, стук на зупинці ──
  let AC = null;
  function ac() { try { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch (e) {} return AC; }
  function tick(speed) {
    const a = ac(); if (!a) return;
    const t = a.currentTime, o = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter();
    o.type = 'square'; o.frequency.value = 1400 + Math.min(1, speed / 3000) * 900;
    f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 3;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    o.connect(f); f.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 0.04);
  }
  function whoosh(dur) {
    const a = ac(); if (!a) return;
    const t = a.currentTime, len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1);
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(2400, t + dur * 0.25); f.frequency.exponentialRampToValueAtTime(300, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(a.destination); src.start(t); src.stop(t + dur);
  }
  function lock() {
    const a = ac(); if (!a) return;
    const t = a.currentTime;
    for (const [fr, v, d] of [[110, 0.5, 0.25], [880, 0.12, 0.6], [1320, 0.08, 0.8]]) {
      const o = a.createOscillator(), g = a.createGain(); o.type = fr < 200 ? 'sine' : 'triangle';
      o.frequency.setValueAtTime(fr * (fr < 200 ? 1.6 : 1), t); o.frequency.exponentialRampToValueAtTime(fr, t + 0.06);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + d + 0.02);
    }
  }

  // ── сцена ──
  function ensureStage() {
    const ov = document.getElementById('roulette-overlay');
    let host = document.getElementById('rl2-stage');
    if (!host) {
      host = document.createElement('div'); host.id = 'rl2-stage';
      host.innerHTML = '<canvas></canvas>';
      ov.insertBefore(host, document.getElementById('roulette-overlay-controls'));
    }
    const cv = host.querySelector('canvas'), ctx = cv.getContext('2d');
    if (!ctx) return null;
    S = S || {};
    Object.assign(S, { ov, host, cv, ctx });
    resize();
    return S;
  }
  function resize() {
    if (!S) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = S.host.clientWidth || 1000, h = S.host.clientHeight || 300;
    S.w = w; S.h = h; S.dpr = dpr;
    S.cv.width = Math.round(w * dpr); S.cv.height = Math.round(h * dpr);
    S.cv.style.width = w + 'px'; S.cv.style.height = h + 'px';
  }
  window.addEventListener('resize', () => { if (S && S.ov.classList.contains('rl2')) resize(); });

  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function fitText(c, text, maxW, size, weight, font) {
    let fs = size; c.font = weight + ' ' + fs + 'px ' + font;
    while (c.measureText(text).width > maxW && fs > 11) { fs -= 1; c.font = weight + ' ' + fs + 'px ' + font; }
    return fs;
  }

  function drawCard(c, name, cx, cy, sc, alpha, win, glowK) {
    const w = CW * sc, h = CH * sc, x = cx - w / 2, y = cy - h / 2, hue = hueOf(name);
    c.save(); c.globalAlpha = alpha;
    // тінь і тіло
    if (win) { c.shadowColor = 'rgba(255,201,61,' + (0.55 + 0.35 * glowK) + ')'; c.shadowBlur = 40 * sc; }
    else { c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 18 * sc; c.shadowOffsetY = 8 * sc; }
    rr(c, x, y, w, h, 18 * sc);
    const g = c.createLinearGradient(x, y, x, y + h);
    if (win) { g.addColorStop(0, '#ffe48a'); g.addColorStop(0.5, '#ffc93d'); g.addColorStop(1, '#ff9f1c'); }
    else { g.addColorStop(0, 'hsl(' + hue + ',38%,20%)'); g.addColorStop(1, 'hsl(' + hue + ',30%,10%)'); }
    c.fillStyle = g; c.fill();
    c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
    // скляний відблиск і рамка
    const gl = c.createLinearGradient(x, y, x, y + h * 0.5); gl.addColorStop(0, 'rgba(255,255,255,' + (win ? 0.35 : 0.10) + ')'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    rr(c, x, y, w, h * 0.5, 18 * sc); c.fillStyle = gl; c.fill();
    rr(c, x + 0.5, y + 0.5, w - 1, h - 1, 18 * sc); c.lineWidth = win ? 2.5 * sc : 1; c.strokeStyle = win ? 'rgba(255,255,255,.75)' : 'hsla(' + hue + ',80%,70%,.22)'; c.stroke();
    // аватарка
    const r = 46 * sc, ay = y + h * 0.40;
    c.save(); c.beginPath(); c.arc(cx, ay, r, 0, Math.PI * 2); c.closePath();
    const av = avatar(name);
    if (av.ok) { c.clip(); c.drawImage(av.img, cx - r, ay - r, r * 2, r * 2); }
    else {
      const ag = c.createLinearGradient(cx - r, ay - r, cx + r, ay + r); ag.addColorStop(0, 'hsl(' + hue + ',75%,58%)'); ag.addColorStop(1, 'hsl(' + ((hue + 40) % 360) + ',70%,42%)');
      c.fillStyle = ag; c.fill();
      c.fillStyle = 'rgba(255,255,255,.95)'; c.font = '800 ' + Math.round(40 * sc) + 'px Unbounded, Manrope, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(((String(name).match(/[\p{L}\p{N}]/u) || ['?'])[0]).toUpperCase(), cx, ay + 2 * sc);
    }
    c.restore();
    c.beginPath(); c.arc(cx, ay, r + 2 * sc, 0, Math.PI * 2); c.lineWidth = 3 * sc; c.strokeStyle = win ? '#fff6d6' : 'hsla(' + hue + ',90%,70%,.55)'; c.stroke();
    // нік
    c.fillStyle = win ? '#2b1a00' : '#f4f3ff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, String(name), w - 22 * sc, Math.round(19 * sc), 800, 'Manrope, sans-serif');
    c.fillText(String(name), cx, y + h * 0.80);
    c.restore();
  }

  // ── кадр ──
  function frame(now) {
    if (!S || !S.ov.classList.contains('visible') || !S.ov.classList.contains('rl2')) { if (S) S.raf = 0; return; }
    S.raf = requestAnimationFrame(frame);
    const c = S.ctx, W = S.w, H = S.h, mid = W / 2, cy = H / 2 + 6;
    c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); c.clearRect(0, 0, W, H);

    // рух: позиція стрічки x (у пікселях від початку) за кривою
    let x = S.x, speed = 0;
    if (S.free) {                                            // розгін, поки чекаємо результат random.org
      const f = S.free, dt = Math.min(0.05, (now - (S.lastT || now)) / 1000);
      f.v = Math.min(f.vmax, f.v + f.acc * dt); x += f.v * dt; speed = f.v;
      ensureItems(Math.ceil((x + W) / STEP) + 4);
    } else if (S.anim) {
      const a = S.anim, k = Math.min(1, (now - a.t0) / a.ms);
      const e = 1 - Math.pow(1 - k, a.p || 4.2);            // плавне гальмування
      x = a.from + (a.to - a.from) * e;
      speed = Math.abs(x - S.x) / Math.max(1, now - (S.lastT || now)) * 1000;
      if (k >= 1) { S.anim = null; a.done(); }
    }
    S.lastT = now; S.x = x; S.speed = speed;

    // клацання: індекс картки під стрілкою змінився
    const under = Math.floor((x + STEP / 2) / STEP);
    if (S.under !== undefined && under !== S.under && (S.anim || S.free)) {
      if (now - (S.lastTick || 0) > 28) { tick(speed); S.lastTick = now; S.ptrKick = 1; }
    }
    S.under = under;

    // світло під стрілкою
    const spot = c.createRadialGradient(mid, cy, 10, mid, cy, 260);
    spot.addColorStop(0, S.won ? 'rgba(255,201,61,.22)' : 'rgba(83,252,24,.12)'); spot.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = spot; c.fillRect(0, 0, W, H);

    // промені за переможцем
    if (S.won) {
      const t = now / 1000, k = Math.min(1, (now - S.won) / 600);
      c.save(); c.translate(mid, cy); c.rotate(t * 0.35); c.globalAlpha = 0.35 * k;
      for (let i = 0; i < 14; i++) { c.rotate(Math.PI * 2 / 14); c.beginPath(); c.moveTo(0, 0); c.lineTo(-40, -H); c.lineTo(40, -H); c.closePath(); c.fillStyle = i % 2 ? 'rgba(255,201,61,.55)' : 'rgba(255,240,190,.35)'; c.fill(); }
      c.restore();
    }

    // картки: cover-flow — менші й тьмяніші до країв, легка дуга
    const blur = Math.min(10, speed / 380);
    const first = Math.max(0, Math.floor((x - mid) / STEP) - 1), last = Math.min(S.items.length - 1, Math.ceil((x + mid) / STEP) + 1);
    const order = [];
    for (let i = first; i <= last; i++) order.push(i);
    order.sort((a, b) => Math.abs(b * STEP - x) - Math.abs(a * STEP - x));     // центральні — зверху
    for (const i of order) {
      const dx = i * STEP - x, n = Math.min(1, Math.abs(dx) / (mid + STEP));
      const isWin = S.won && i === S.win;
      let sc = 1 - 0.22 * n * n, al = 1 - 0.75 * n * n;
      if (S.won) { if (isWin) sc *= 1 + 0.16 * Math.min(1, (now - S.won) / 450); else al *= 0.35; }
      if (blur > 0.6 && !isWin) c.filter = 'blur(' + blur.toFixed(1) + 'px)';
      drawCard(c, S.items[i], mid + dx * (1 - 0.06 * n), cy + 14 * n * n, sc, al, isWin, 0.5 + 0.5 * Math.sin(now / 220));
      c.filter = 'none';
    }

    // стрілка: тонкий промінь + два трикутники, «підстрибує» на клацанні
    S.ptrKick = Math.max(0, (S.ptrKick || 0) - 0.12);
    const col = S.won ? '#ffc93d' : '#53fc18', kick = S.ptrKick * 5;
    c.save(); c.shadowColor = col; c.shadowBlur = 16;
    const lg = c.createLinearGradient(0, 12, 0, H - 12); lg.addColorStop(0, col); lg.addColorStop(0.5, S.won ? 'rgba(255,201,61,.15)' : 'rgba(83,252,24,.25)'); lg.addColorStop(1, col);
    if (!S.won) { c.fillStyle = lg; c.fillRect(mid - 1, 14, 2, H - 28); }
    c.fillStyle = col;
    c.beginPath(); c.moveTo(mid - 13, 4 + kick); c.lineTo(mid + 13, 4 + kick); c.lineTo(mid, 22 + kick); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(mid - 13, H - 4 - kick); c.lineTo(mid + 13, H - 4 - kick); c.lineTo(mid, H - 22 - kick); c.closePath(); c.fill();
    c.restore();

    // затінення країв
    const fl = c.createLinearGradient(0, 0, W, 0);
    fl.addColorStop(0, 'rgba(7,7,12,1)'); fl.addColorStop(0.12, 'rgba(7,7,12,0)'); fl.addColorStop(0.88, 'rgba(7,7,12,0)'); fl.addColorStop(1, 'rgba(7,7,12,1)');
    c.fillStyle = fl; c.fillRect(0, 0, W, H);

    // конфеті
    for (let i = S.parts.length - 1; i >= 0; i--) {
      const p = S.parts[i]; p.vy += 900 / 60; p.vx *= 0.99;
      p.x += p.vx / 60; p.y += p.vy / 60; p.r += p.vr / 60; p.life -= 1 / 60;
      if (p.life <= 0 || p.y > H + 30) { S.parts.splice(i, 1); continue; }
      c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.globalAlpha = Math.min(1, p.life * 1.5);
      c.fillStyle = p.c; c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2 * (0.4 + 0.6 * Math.abs(Math.sin(p.r * 2)))); c.restore();
    }
  }
  function burst(n) {
    const COLS = ['#ffc93d', '#ffe48a', '#53fc18', '#9dff6b', '#8b5cf6', '#ff4d6a', '#ffffff', '#4fb0ff'];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1, v = 380 + Math.random() * 520;
      S.parts.push({ x: S.w / 2 + (Math.random() - 0.5) * 80, y: S.h / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * 6, vr: (Math.random() - 0.5) * 16, s: 7 + Math.random() * 7, c: COLS[i % COLS.length], life: 1.6 + Math.random() * 1.2 });
    }
  }
  const move = (to, ms, p) => new Promise(done => { S.anim = { from: S.x, to, ms, p, t0: performance.now(), done }; });
  function ensureItems(n) { while (S.items.length < n) S.items.push(S.pick()); }

  // ── підміна startRoulette ──
  async function startRoulette2(fast) {
    if (!state.participants.length) return alert('Нет участников');
    const drawnNames = new Set(winnersHistory.map(w => String(w.name).toLowerCase()));
    const eligible = state.participants.filter(p => !drawnNames.has(String(p).toLowerCase()));
    if (!eligible.length) return alert('Все участники уже выпадали. Сбросьте розыгрыш и проведите новую регистрацию.');

    const overlay = document.getElementById('roulette-overlay');
    overlay.classList.add('visible', 'rl2');
    if (!ensureStage()) { overlay.classList.remove('rl2'); return orig.start(fast); }
    const my = ++token;
    phase = 'racing';
    const hint = document.getElementById('roulette-overlay-hint'), controls = document.getElementById('roulette-overlay-controls');
    controls.style.display = 'none'; hint.textContent = 'Крутим барабан...';
    ac();   // AudioContext — у межах жесту кліку, поки браузер дозволяє

    // барабан стартує одразу повною стрічкою й розганяється, поки чекаємо random.org;
    // гальмування рахуємо від поточної швидкості, коли переможець уже відомий (без «завислого» першого кадру)
    const pool = state.participants;
    const rnd = () => pool[Math.floor(Math.random() * pool.length)];
    S.pick = rnd; S.items = []; S.parts = []; S.won = 0; S.anim = null; S.win = -1;
    S.x = 8 * STEP; S.under = undefined; S.lastT = performance.now();
    ensureItems(40);
    for (const nm of new Set(S.items)) avatar(nm);
    S.free = { v: 0, vmax: fast ? 3400 : 2700, acc: fast ? 9000 : 5200 }; S.t0spin = performance.now();
    whoosh(fast ? 1.3 : 2.4);
    if (!S.raf) S.raf = requestAnimationFrame(frame);

    const winner = eligible[await rollInt(eligible.length)];      // ролл через random.org
    if (my !== token) return;
    // невеличкий мінімум розгону, щоб навіть миттєва відповідь виглядала як прокрут
    const minSpin = fast ? 250 : 700, waited = performance.now() - (S.t0spin || 0);
    S.t0spin = 0;
    await new Promise(r => setTimeout(r, Math.max(0, minSpin - waited)));
    if (my !== token) return;

    const P = 3, v = Math.max(400, S.free.v);                      // px/с у момент переходу на гальмування
    const decel = fast ? 1900 : 5000;
    const WINi = Math.round((S.x + v * decel / 1000 / P) / STEP);
    S.win = WINi; ensureItems(WINi + 6);
    S.items[WINi] = winner; avatar(winner);
    // сусіди переможця — не він сам (щоб не здавалось, що «випав двічі»)
    for (const j of [WINi - 2, WINi - 1, WINi + 1, WINi + 2]) if (S.items[j] === winner && pool.length > 1) { let o; do { o = rnd(); } while (o === winner); S.items[j] = o; }
    for (let j = WINi - 6; j <= WINi + 6; j++) avatar(S.items[j]);

    // зупинка не в центрі картки, а в випадковому місці (аж до самого краю) — інтрига «чи перескочить?»
    const edge = (Math.random() < 0.5 ? -1 : 1) * (0.18 + Math.random() * 0.26) * CW;
    const target = WINi * STEP + edge, ms = Math.max(fast ? 900 : 2500, (target - S.x) * P * 1000 / v);
    S.free = null;
    await move(target, ms, P);
    if (my !== token) return;
    await new Promise(r => setTimeout(r, fast ? 240 : 380));
    if (my !== token) return;
    await move(WINi * STEP, fast ? 400 : 520);                     // доводка точно в центр
    if (my !== token) return;

    S.won = performance.now(); lock(); burst(fast ? 110 : 140);
    hint.innerHTML = '🎉 Победитель: <b>' + escapeHtml(winner) + '</b>';
    controls.style.display = 'flex';
    phase = 'done';
    addWinner(winner);
  }

  function hide2() {
    token++;
    const ov = document.getElementById('roulette-overlay');
    if (ov) ov.classList.remove('rl2');
    if (S) { S.anim = null; S.free = null; S.parts = []; S.won = 0; }
    return orig.hide.apply(this, arguments);
  }

  if (typeof orig.start === 'function') {
    window.startRoulette = startRoulette2;
    window.hideRouletteOverlay = hide2;
  }
})();
