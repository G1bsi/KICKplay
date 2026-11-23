/* ══════════════════════════════════════════════════════════════
   «Золота картка» для батл-рояля (екран переможця після перестрілки) і Бонусбурі
   (центральна колонка: обраний глядач, кільце-таймер, його повідомлення).
   Логіку режимів не чіпаємо: shootout.js і app.js пишуть у ті самі id,
   а тут лише аватарка, підгонка ніка, кільце, конфеті й стани (через спостерігачі).
   ══════════════════════════════════════════════════════════════ */
(function () {
  const $ = id => document.getElementById(id);
  const RING = 2 * Math.PI * 92;

  function hueOf(s) { let h = 2166136261; s = String(s).toLowerCase(); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; }
  function avatar(av, name) {
    if (!av) return;
    const img = av.querySelector('img'), letter = av.querySelector('span');
    av.style.setProperty('--h', hueOf(name));
    letter.textContent = ((String(name).match(/[\p{L}\p{N}]/u) || ['?'])[0]).toUpperCase();
    img.classList.remove('ok'); img.style.display = '';
    img.onload = () => { if (img.naturalWidth) img.classList.add('ok'); };
    img.onerror = () => { img.style.display = 'none'; };
    img.src = '/api/avatar/' + encodeURIComponent(name);
  }
  // нік в один рядок, поки шрифт не замалий
  function fit(el, minPx) {
    if (!el) return;
    el.style.fontSize = ''; el.style.whiteSpace = 'nowrap';
    const box = el.parentElement.clientWidth - 56;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > box && fs > (minPx || 26)) { fs -= 2; el.style.fontSize = fs + 'px'; }
    if (el.scrollWidth > box) el.style.whiteSpace = '';
  }
  function confetti(cv, originEl, n) {
    if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const cr = cv.getBoundingClientRect(), r = originEl ? originEl.getBoundingClientRect() : cr;
    const ox = r.left - cr.left + r.width / 2, oy = r.top - cr.top + r.height / 2;
    const COLS = ['#ffc93d', '#ffe48a', '#ff9f1c', '#53fc18', '#9dff6b', '#ffffff', '#8b5cf6'];
    const parts = [];
    for (let i = 0; i < (n || 160); i++) {
      const a = Math.random() * Math.PI * 2, v = 260 + Math.random() * 620;
      parts.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 220, r: Math.random() * 6, vr: (Math.random() - 0.5) * 14,
        s: 6 + Math.random() * 8, c: COLS[i % COLS.length], life: 2.4 + Math.random() * 1.6, sw: Math.random() * 6 });
    }
    cancelAnimationFrame(cv._raf);
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.2 * dt) + 520 * dt;
        p.x += (p.vx + Math.sin(now / 300 + p.sw) * 30) * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.life -= dt;
        if (p.life <= 0 || p.y > H + 20) { parts.splice(i, 1); continue; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.min(1, p.life);
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, (p.s / 2) * (0.35 + 0.65 * Math.abs(Math.sin(p.r * 2))));
        ctx.restore();
      }
      if (parts.length) cv._raf = requestAnimationFrame(step); else ctx.clearRect(0, 0, W, H);
    };
    cv._raf = requestAnimationFrame(step);
  }
  window.WC = { avatar, fit, confetti, hueOf };

  // ── батл-рояль: shootout.js ставить нік/статистику і клас .show ──
  function royaleInit() {
    const w = $('so-winner'); if (!w) return;
    let shown = false;
    new MutationObserver(() => {
      const on = w.classList.contains('show');
      if (on && !shown) {
        const name = ($('so-winner-name').textContent || '').trim();
        avatar(w.querySelector('.wc-avatar'), name);
        // «убийств: 3 · урон: 248» → два бейджі
        const st = $('so-winner-stats'), txt = st.textContent || '';
        const k = txt.match(/убийств:\s*(\d+)/), d = txt.match(/урон:\s*(\d+)/);
        if (k || d) {
          st.innerHTML = '';
          const chip = (ico, label, val) => { const c = document.createElement('span'); c.className = 'wc-chip'; c.textContent = ico + ' ' + label + ' '; const b = document.createElement('b'); b.textContent = val; c.appendChild(b); st.appendChild(c); };
          if (k) chip('💀', 'убийств', k[1]);
          if (d) chip('💥', 'урон', d[1]);
        }
        requestAnimationFrame(() => { fit($('so-winner-name')); confetti(w.querySelector('.wc-fx'), w.querySelector('.wc-hero'), 170); });
      }
      shown = on;
    }).observe(w, { attributes: true, attributeFilter: ['class'] });
  }

  // ── Бонусбуря: стани беремо з того, що app.js пише в #chatgame-timer ──
  function chatgameInit() {
    const col = $('chatgame-left'), timer = $('chatgame-timer'), ring = $('cg-ring');
    if (!col || !timer || typeof window.openChatgameOverlay !== 'function') return;
    let raf = 0, t0 = 0, total = 0;
    function setState() {
      const st = timer.dataset.st || 'idle';
      for (const s of ['answered', 'timeout', 'idle', 'expiring', 'running']) col.classList.toggle('cg-' + s, s === st);
      if (st !== 'running' && st !== 'expiring') cancelAnimationFrame(raf);
      if (st === 'timeout') ring.style.strokeDashoffset = RING.toFixed(1);
    }
    new MutationObserver(setState).observe(timer, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-st'] });
    function ringLoop() {
      const left = Math.max(0, total - (performance.now() - t0) / 1000);
      ring.style.strokeDashoffset = (RING * (1 - left / total)).toFixed(1);
      if (left > 0 && (col.classList.contains('cg-running') || col.classList.contains('cg-expiring'))) raf = requestAnimationFrame(ringLoop);
    }
    const origOpen = window.openChatgameOverlay;
    window.openChatgameOverlay = function (nick) {
      ring.style.strokeDashoffset = '0';
      const r = origOpen.apply(this, arguments);
      avatar($('cg-avatar'), nick);
      col.classList.remove('cg-pop'); void col.offsetWidth; col.classList.add('cg-pop');
      requestAnimationFrame(() => fit($('chatgame-winner-name'), 22));
      total = (typeof getConfirmSeconds === 'function' ? getConfirmSeconds() : 60) || 60; t0 = performance.now();
      setState(); cancelAnimationFrame(raf); raf = requestAnimationFrame(ringLoop);
      return r;
    };
  }

  function init() { royaleInit(); chatgameInit(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
