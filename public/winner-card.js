/* ══════════════════════════════════════════════════════════════
   Заставка переможця «Золота картка» — надбудова над showAnnounce / updateAnnounceMsg /
   closeAnnounce з app.js (вони й далі ведуть таймер, чат-перевірку і random.org).
   Тут лише показ: аватарка Kick (або кольорова літера), кільце-таймер, що плавно спадає
   (останні 10 с — червоне, після відповіді — зелене повне), конфеті на canvas.
   ══════════════════════════════════════════════════════════════ */
(function () {
  const RING = 2 * Math.PI * 92;                         // довжина кола в SVG (r = 92)
  const orig = { show: window.showAnnounce, msg: window.updateAnnounceMsg, close: window.closeAnnounce };
  if (typeof orig.show !== 'function') return;
  const $ = id => document.getElementById(id);
  let loop = 0, fxLoop = 0, parts = [];

  function hueOf(s) { let h = 2166136261; s = String(s).toLowerCase(); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; }

  function setAvatar(name) {
    const av = $('wa-avatar'), img = $('wa-av-img'), letter = $('wa-av-letter');
    if (!av) return;
    av.style.setProperty('--h', hueOf(name));
    letter.textContent = ((String(name).match(/[\p{L}\p{N}]/u) || ['?'])[0]).toUpperCase();
    img.classList.remove('ok'); img.style.display = '';
    img.onload = () => { if (img.naturalWidth) img.classList.add('ok'); };
    img.onerror = () => { img.style.display = 'none'; };
    img.src = '/api/avatar/' + encodeURIComponent(name);
  }

  // ── кільце-таймер: плавно, а не стрибками по секунді ──
  function runRing(seconds) {
    cancelAnimationFrame(loop);
    const ov = $('winner-announce'), ring = $('wa-ring'), t0 = performance.now();
    const step = () => {
      if (!ov.classList.contains('visible') || ov.classList.contains('answered')) return;
      const left = Math.max(0, seconds - (performance.now() - t0) / 1000);
      ring.style.strokeDashoffset = (RING * (1 - left / seconds)).toFixed(1);
      ov.classList.toggle('expiring', left <= 10 && left > 0);
      if (left <= 0) { ov.classList.remove('expiring'); ov.classList.add('timeout'); return; }
      loop = requestAnimationFrame(step);
    };
    loop = requestAnimationFrame(step);
  }

  // ── конфеті: золото + зелень, вилітають з-за аватарки й повільно опадають ──
  function confetti() {
    const cv = $('wa-fx'); if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const hero = document.querySelector('#winner-announce .wa-hero');
    const r = hero ? hero.getBoundingClientRect() : { left: W / 2, top: H / 3, width: 0, height: 0 };
    const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
    const COLS = ['#ffc93d', '#ffe48a', '#ff9f1c', '#53fc18', '#9dff6b', '#ffffff', '#8b5cf6'];
    parts = [];
    for (let i = 0; i < 160; i++) {
      const a = Math.random() * Math.PI * 2, v = 260 + Math.random() * 620;
      parts.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 220, r: Math.random() * 6, vr: (Math.random() - 0.5) * 14,
        s: 6 + Math.random() * 8, c: COLS[i % COLS.length], life: 2.4 + Math.random() * 1.6, sway: Math.random() * 6 });
    }
    cancelAnimationFrame(fxLoop);
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.2 * dt) + 520 * dt;
        p.x += (p.vx + Math.sin(now / 300 + p.sway) * 30) * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.life -= dt;
        if (p.life <= 0 || p.y > H + 20) { parts.splice(i, 1); continue; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.min(1, p.life);
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, (p.s / 2) * (0.35 + 0.65 * Math.abs(Math.sin(p.r * 2))));
        ctx.restore();
      }
      if (parts.length) fxLoop = requestAnimationFrame(step); else ctx.clearRect(0, 0, W, H);
    };
    fxLoop = requestAnimationFrame(step);
  }

  // нік — в один рядок, поки шрифт не стане замалим (тоді вже переносимо)
  function fitName() {
    const el = $('wa-name'); if (!el) return;
    el.style.fontSize = ''; el.style.whiteSpace = 'nowrap';
    const box = el.parentElement.clientWidth - 68;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > box && fs > 30) { fs -= 2; el.style.fontSize = fs + 'px'; }
    if (el.scrollWidth > box) el.style.whiteSpace = '';
  }

  window.spawnParticles = function () {};              // старі CSS-частинки замінює canvas-конфеті

  window.showAnnounce = function (name, seconds, confirmOn) {
    const ov = $('winner-announce');
    ov.classList.remove('answered', 'timeout', 'expiring', 'no-timer');
    $('wa-timer').style.display = '';                  // updateAnnounceMsg минулого разу його ховав
    $('wa-ring').style.strokeDashoffset = '0';
    setAvatar(name);
    // виграш (Плинко передає суму через window.WA_PRIZE) — золотий бейдж під ніком
    let pz = document.querySelector('#winner-announce .wa-prize');
    if (!pz) { pz = document.createElement('div'); pz.className = 'wa-prize'; const card = document.querySelector('#winner-announce .wa-card'); if (card) card.appendChild(pz); }
    if (pz) { pz.textContent = window.WA_PRIZE ? '💰 ' + window.WA_PRIZE : ''; pz.style.display = window.WA_PRIZE ? '' : 'none'; }
    window.WA_PRIZE = null;
    const r = orig.show.apply(this, arguments);
    // перезапуск анімацій появи, якщо заставка вже була відкрита
    ov.classList.remove('visible'); void ov.offsetWidth; ov.classList.add('visible');
    if (confirmOn && seconds > 0) runRing(seconds); else ov.classList.add('no-timer');
    fitName();
    confetti();
    return r;
  };

  window.updateAnnounceMsg = function (name, message) {
    const r = orig.msg.apply(this, arguments);
    const ov = $('winner-announce'), m = $('wa-msg');
    if (ov.classList.contains('visible') && m && m.style.display !== 'none' && m.textContent) {
      cancelAnimationFrame(loop);
      ov.classList.remove('expiring', 'timeout'); ov.classList.add('answered');
    }
    return r;
  };

  window.closeAnnounce = function () {
    cancelAnimationFrame(loop); cancelAnimationFrame(fxLoop); parts = [];
    const cv = $('wa-fx'); if (cv) { const c = cv.getContext('2d'); c && c.clearRect(0, 0, cv.width, cv.height); }
    $('winner-announce').classList.remove('answered', 'timeout', 'expiring', 'no-timer');
    return orig.close.apply(this, arguments);
  };
})();
