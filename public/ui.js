/* ══════════════════════════════════════════════════════════════
   KICKplay — тонкий шар інтерфейсу для нового каркаса (редизайн 2026-11).
   Логіку не чіпає: лише будує плитки режимів із GAME_MODES (app.js),
   дзеркалить лічильники у топбар і прикрашає рядки учасників
   аватаркою-ініціалом. Усе — через MutationObserver на вузлах, які
   оновлює app.js, тож старий код працює як раніше.
   ══════════════════════════════════════════════════════════════ */
(function () {
  const $ = id => document.getElementById(id);

  // ── плитки режимів: клік = той самий setGameMode, що й стрілки каруселі ──
  // свій колір (RGB) і короткий підпис для кожного режиму
  const MODE_IMG = new Set(['roulette', 'revolver', 'cashhunt', 'royale', 'chatgame', 'marbles', 'plinko']);
  const MODE_LOOK = {
    roulette: { c: '255,196,61', sub: 'рулетка' },
    revolver: { c: '255,92,92', sub: 'барабан' },
    cashhunt: { c: '255,142,60', sub: 'тир мишеней' },
    royale:   { c: '168,120,255', sub: 'выживание' },
    chatgame: { c: '80,190,255', sub: 'решает чат' },
    marbles:  { c: '255,110,200', sub: 'гонка шаров' },
    plinko:   { c: '84,226,140', sub: 'иксы · DOUBLE' },
    race:     { c: '255,214,90', sub: 'гонка' },
  };
  function buildModeTiles() {
    const grid = $('mode-grid');
    if (!grid || typeof GAME_MODES === 'undefined') return;
    grid.innerHTML = '';
    for (const m of GAME_MODES) {
      const b = document.createElement('button');
      const look = MODE_LOOK[m.id] || { c: '120,255,90', sub: '' };
      b.type = 'button'; b.className = 'mode-tile'; b.dataset.mode = m.id;
      b.style.setProperty('--mc', look.c);
      // велика розтягнута напівпрозора емодзі на пів плитки, назва — поверх неї
      b.innerHTML = '<span class="mt-ico" aria-hidden="true"></span><span class="mt-text"><span class="mt-label"></span></span>';
      // іконка-картинка режиму (public/img/modes/<id>.webp); нема файлу — лишається емодзі
      const ico = b.querySelector('.mt-ico');
      if (MODE_IMG.has(m.id)) {
        const img = new Image(); img.alt = ''; img.decoding = 'async';
        img.onerror = () => { b.classList.remove('mt-has-img'); img.remove(); ico.textContent = m.icon; };
        img.src = '/assets/img/modes/' + m.id + '.webp?v=20261122';
        ico.appendChild(img); b.classList.add('mt-has-img');
      } else ico.textContent = m.icon;
      const lab = b.querySelector('.mt-label'); lab.textContent = m.label;
      if (m.beta) { const t = document.createElement('span'); t.className = 'mt-beta'; t.textContent = 'бета'; lab.appendChild(t); }
      b.onclick = () => { if (typeof setGameMode === 'function') setGameMode(m.id); };
      grid.appendChild(b);
    }
    // емодзі розтягується рівно на ліву половину плитки (ширина плиток залежить від ширини колонки)
    const fit = () => grid.querySelectorAll('.mode-tile').forEach(t => {
      const half = t.clientWidth * (t.matches(':last-child:nth-child(odd)') ? 0.3 : 0.5);
      t.style.setProperty('--sx', Math.max(1.15, Math.min(2.5, half / 56)).toFixed(3));   // >2.5 — емодзі вже нечитабельна
      // картинка — рівномірно збільшена (не розтягнута) до половини плитки, але не більше ~1.75 висоти плитки
      t.style.setProperty('--isz', Math.round(Math.max(64, Math.min(half, t.clientHeight * 1.75))) + 'px');
    });
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(grid);
    syncMode();
  }
  function syncMode() {
    const cur = typeof gameMode !== 'undefined' ? gameMode : null;
    document.querySelectorAll('.mode-tile').forEach(t => t.classList.toggle('active', t.dataset.mode === cur));
    const m = (typeof GAME_MODES !== 'undefined' && GAME_MODES.find(x => x.id === cur)) || null;
    const v = $('tstat-mode'); if (v) v.textContent = m ? m.icon + ' ' + m.label : '—';
  }

  // ── лічильники в топбарі ──
  function mirror(srcId, dstId) {
    const s = $(srcId), d = $(dstId); if (!s || !d) return;
    const upd = () => { d.textContent = s.textContent || '0'; };
    upd(); new MutationObserver(upd).observe(s, { childList: true, characterData: true, subtree: true });
  }

  // ── учасники: кольорова аватарка з першою літерою ніка (колір — від хеша ніка) ──
  function hueOf(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 360; }
  let lastCount = 0;
  // стан аватарок між перемальовуваннями списку (app.js оновлює його кожні 2 с):
  // 'ok' — фото є (з кешу браузера, без мигання), 'none' — фото немає, більше не питаємо
  const AV = new Map();
  function decorate() {
    const rows = document.querySelectorAll('#main-box .participant-row');
    rows.forEach((r, i) => {
      if (r.querySelector('.p-av')) return;
      const nameEl = r.querySelector('span:last-child'); if (!nameEl) return;
      const name = nameEl.textContent.trim();
      nameEl.classList.add('p-name');
      const av = document.createElement('span');
      av.className = 'p-av'; av.textContent = (name.match(/[\p{L}\p{N}]/u) || ['?'])[0];
      av.style.setProperty('--h', hueOf(name.toLowerCase()));
      // справжня аватарка Kick (сервер віддає редирект на картинку); літера лишається під нею,
      // якщо фото немає або воно не вантажиться
      const key = name.toLowerCase(), st = AV.get(key);
      if (st !== 'none') {
        const img = document.createElement('img');
        img.className = 'p-img'; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
        img.onload = () => { AV.set(key, 'ok'); img.classList.add('ok'); };
        img.onerror = () => { AV.set(key, 'none'); img.remove(); };
        img.src = '/api/avatar/' + encodeURIComponent(name);
        if (st === 'ok') img.classList.add('ok');
        av.appendChild(img);
      }
      r.insertBefore(av, r.firstChild);
    });
    // найсвіжіший учасник (перший рядок — список розвернутий) підсвічений, поки приходять нові
    if (rows.length > lastCount && rows[0]) rows[0].classList.add('fresh');
    else if (rows[0] && rows.length === lastCount && document.body.dataset.fresh === '1') rows[0].classList.add('fresh');
    document.body.dataset.fresh = rows.length > lastCount ? '1' : (document.body.dataset.fresh || '0');
    lastCount = rows.length;
  }

  // ── «● регистрация» біля заголовка учасників, поки йде реєстрація ──
  function syncReg() {
    const b = $('btn-reg-toggle'); if (!b) return;
    document.body.classList.toggle('reg-open', b.classList.contains('btn-red'));
  }

  function init() {
    buildModeTiles();
    const mc = $('mode-current');
    if (mc) new MutationObserver(syncMode).observe(mc, { childList: true, subtree: true, characterData: true });
    mirror('participants-count-title', 'tstat-part');
    mirror('winners-count-title', 'tstat-win');
    const mb = $('main-box');
    if (mb) { decorate(); new MutationObserver(decorate).observe(mb, { childList: true, subtree: true }); }
    const rb = $('btn-reg-toggle');
    if (rb) { syncReg(); new MutationObserver(syncReg).observe(rb, { attributes: true, attributeFilter: ['class'] }); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  // GAME_MODES може дописати локальний Марблс (IS_LOCAL_DEV) — перебудувати плитки після повного завантаження
  window.addEventListener('load', buildModeTiles);
})();
