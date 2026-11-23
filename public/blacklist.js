/* ══════════════════════════════════════════════════════════════
   Блеклист: ніки, яким не можна брати участь (боти, мультиакаунти).
   • Головна копія — localStorage цієї панелі: на Render файл стану сервера зникає з кожним деплоєм.
     При першому стані з сервера синхронізуємось (порожній сервер отримує наш список; порожня панель
     на новому пристрої бере серверний), далі кожна правка одразу йде на сервер (/api/blacklist).
   • Сервер не реєструє заблокованих із чату й прибирає їх зі списку; панель додатково фільтрує
     учасників сама — на випадок, коли сервер щойно перезапустився й ще не отримав список.
   • UI: кнопка в заголовку «Участники» → вікно зі списком; у рядку учасника — кнопка бану з «Отменить».
   Глобали app.js: state, loadState, escapeHtml.
   ══════════════════════════════════════════════════════════════ */
(function () {
  const KEY = 'kp_blacklist';
  const norm = s => String(s || '').trim().replace(/^@+/, '').toLowerCase();
  let list = [];
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(v)) list = [...new Set(v.map(norm).filter(Boolean))]; } catch (e) { /* без localStorage — живемо з серверним */ }
  let synced = false, pushing = null, lastSrv = '';
  const ICO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>';

  function save() { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* приватний режим */ } }
  const has = n => list.includes(norm(n));
  const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));

  function push() {
    const body = JSON.stringify({ list });
    pushing = fetch('/api/blacklist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then(r => r.ok ? r.json() : null).catch(() => null)
      .then(j => { pushing = null; if (j && j.ok && typeof loadState === 'function') loadState(); return j; });
    return pushing;
  }

  // викликається з loadState() app.js на кожен стан із сервера
  window.blApply = function (st) {
    const srv = Array.isArray(st.blacklist) ? st.blacklist.map(norm) : null;   // null — сервер без підтримки блеклиста
    if (srv && !pushing) {
      if (!synced) {
        synced = true;
        if (!list.length && srv.length) { list = srv.slice(); save(); render(); }
        else if (!same(list, srv)) push();
      } else if (!same(list, srv) && lastSrv !== srv.join(',')) push();   // сервер перезапустився (порожній) — повертаємо список
      lastSrv = srv.join(',');
    }
    if (list.length && Array.isArray(st.participants)) {
      st.participants = st.participants.filter(n => !has(n));
      st.count = st.participants.length;
    }
    updCount();
  };
  window.isBlacklisted = has;

  function add(names) {
    const add = names.map(norm).filter(n => n && n.length <= 40 && !list.includes(n));
    if (!add.length) return [];
    list = add.concat(list); save(); render(); push();
    return add;
  }
  function remove(n) { n = norm(n); list = list.filter(x => x !== n); save(); render(); push(); }

  // ── UI ──
  let dom = null;
  function ensureDom() {
    if (dom) return dom;
    // кнопка — у топбарі праворуч
    const bar = document.querySelector('header.topbar');
    const btn = document.createElement('button');
    btn.className = 'bl-open'; btn.type = 'button'; btn.title = 'Блеклист: кто не может участвовать';
    btn.innerHTML = ICO + '<span>Блеклист</span><b id="bl-count">0</b>';
    if (bar) bar.appendChild(btn); else document.body.appendChild(btn);
    const m = document.createElement('div');
    m.id = 'bl-modal';
    m.innerHTML = `
      <div class="bl-card" role="dialog" aria-label="Блеклист">
        <div class="bl-head"><span class="bl-hico">${ICO}</span><h3>Блеклист</h3><span class="count-badge" id="bl-n">0</span><span class="head-spacer"></span>
          <button class="bl-x" type="button" title="Закрыть">✕</button></div>
        <form class="bl-add">
          <svg class="bl-lead" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="8" r="3.6"/><path d="M3.5 20a6.5 6.5 0 0 1 13 0"/><path d="M17 8h5"/></svg>
          <input id="bl-input" autocomplete="off" spellcheck="false" placeholder="Ник или несколько через запятую">
          <button class="bl-submit" type="submit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Добавить</button>
        </form>
        <div class="bl-list" id="bl-list"></div>
      </div>`;
    document.body.appendChild(m);
    const toast = document.createElement('div'); toast.id = 'bl-toast'; document.body.appendChild(toast);
    dom = { btn, m, toast, count: btn.querySelector('#bl-count'), n: m.querySelector('#bl-n'), list: m.querySelector('#bl-list'), input: m.querySelector('#bl-input') };
    btn.onclick = open;
    m.addEventListener('mousedown', e => { if (e.target === m) close(); });
    m.querySelector('.bl-x').onclick = close;
    m.querySelector('form').onsubmit = e => {
      e.preventDefault();
      const added = add(dom.input.value.split(/[\s,;]+/));
      dom.input.value = ''; dom.input.focus();
      if (added.length) note(added.length === 1 ? added[0] + ' — в блеклисте' : 'В блеклисте: +' + added.length);
    };
    dom.list.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) remove(b.dataset.rm); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && m.classList.contains('on')) close(); });
    // кнопка бану в рядках учасників (рядки перемальовуються кожні 2 с — дописуємо після кожного разу)
    const box = document.getElementById('main-box');
    if (box) {
      const deco = () => box.querySelectorAll('.participant-row:not([data-bl])').forEach(r => {
        r.dataset.bl = '1';
        const b = document.createElement('button');
        b.className = 'p-ban'; b.type = 'button'; b.title = 'В блеклист'; b.innerHTML = ICO;
        r.insertBefore(b, r.firstChild);     // першим: ui.js шукає нік як span:last-child
      });
      deco(); new MutationObserver(deco).observe(box, { childList: true, subtree: true });
      box.addEventListener('click', e => {
        const b = e.target.closest('.p-ban'); if (!b) return;
        e.stopPropagation();
        const row = b.closest('.participant-row'), nameEl = row && row.querySelector('span:last-child');
        const name = nameEl ? nameEl.textContent.trim() : '';
        if (!name) return;
        row.classList.add('p-banned');
        add([name]);
        note(name + ' — в блеклисте', () => remove(name));
      });
    }
    winnerHooks();
    return dom;
  }

  // ── бан переможця: перевіряють саме при виграші — кнопка на заставці переможця, у Бонусбурі й у списку ──
  const toggle = name => {
    if (!name) return;
    if (has(name)) { remove(name); note(name + ' — убран из блеклиста'); }
    else { add([name]); note(name + ' — в блеклисте', () => remove(name)); }
  };
  const winBtns = [];
  function winBtn(host, before, getName, cls) {
    if (!host) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bl-win ' + (cls || '');
    b.onclick = e => { e.stopPropagation(); toggle(getName()); };
    host.insertBefore(b, before || null);
    winBtns.push({ b, getName });
  }
  function syncWinBtns() {
    for (const w of winBtns) {
      const n = w.getName(), on = !!n && has(n);
      w.b.classList.toggle('on', on);
      w.b.innerHTML = ICO + '<span>' + (on ? 'В блеклисте' : 'В блеклист') + '</span>';
      w.b.title = on ? 'Убрать из блеклиста' : 'Добавить победителя в блеклист';
    }
    // список переможців: позначаємо заблокованих
    document.querySelectorAll('#winners-box .winner-row').forEach(r => {
      const n = r.querySelector('.w-name'); r.classList.toggle('w-banned', !!n && has(n.textContent.trim()));
    });
  }
  function winnerHooks() {
    const nameOf = id => () => { const el = document.getElementById(id); const t = el ? el.textContent.trim() : ''; return t && t !== '—' ? t : ''; };
    // на заставці переможця — в один ряд із «Закрыть»
    const wa = document.querySelector('#winner-announce .wa-close');
    if (wa) {
      const row = document.createElement('div'); row.className = 'wa-actions';
      wa.parentNode.insertBefore(row, wa); row.appendChild(wa);
      winBtn(row, wa, nameOf('wa-name'), 'wa-ban');
    }
    const cg = document.getElementById('chatgame-controls');
    if (cg) winBtn(cg, cg.lastElementChild, nameOf('chatgame-winner-name'), 'cg-ban');
    for (const id of ['wa-name', 'chatgame-winner-name']) {
      const el = document.getElementById(id);
      if (el) new MutationObserver(syncWinBtns).observe(el, { childList: true, characterData: true, subtree: true });
    }
    // рядки списку переможців: кнопка бану при наведенні (список перемальовується — дописуємо щоразу)
    const wb = document.getElementById('winners-box');
    if (wb) {
      const deco = () => {
        wb.querySelectorAll('.winner-row:not([data-bl])').forEach(r => {
          r.dataset.bl = '1';
          const b = document.createElement('button');
          b.className = 'w-ban'; b.type = 'button'; b.innerHTML = ICO;
          r.appendChild(b);
        });
        syncWinBtns();
      };
      deco(); new MutationObserver(deco).observe(wb, { childList: true });
      wb.addEventListener('click', e => {
        const b = e.target.closest('.w-ban'); if (!b) return;
        e.stopPropagation();
        const n = b.closest('.winner-row').querySelector('.w-name');
        toggle(n ? n.textContent.trim() : '');
      });
    }
    syncWinBtns();
  }
  function open() { ensureDom(); render(); dom.m.classList.add('on'); setTimeout(() => dom.input.focus(), 50); }
  function close() { if (dom) dom.m.classList.remove('on'); }
  function updCount() {
    if (!dom) return;
    dom.count.textContent = list.length; dom.btn.classList.toggle('has', list.length > 0);
    dom.n.textContent = list.length;
  }
  function render() {
    if (!dom) return;
    updCount(); syncWinBtns();
    dom.list.innerHTML = list.length
      ? list.map(n => '<div class="bl-row"><span class="bl-av">' + escapeHtml((n.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase()) + '</span><span class="bl-name">' + escapeHtml(n) +
          '</span><button class="bl-rm" type="button" data-rm="' + escapeHtml(n) + '" title="Убрать из блеклиста">✕</button></div>').join('')
      : '<div class="bl-empty">' + ICO + '<span>Пусто</span></div>';
  }
  let toastT = 0;
  function note(text, undo) {
    ensureDom();
    const t = dom.toast;
    t.innerHTML = '<span class="bl-tico">' + ICO + '</span><span class="bl-tt"></span>' + (undo ? '<button type="button" class="bl-undo">Отменить</button>' : '');
    t.querySelector('.bl-tt').textContent = text;
    if (undo) t.querySelector('.bl-undo').onclick = () => { undo(); t.classList.remove('on'); };
    t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), undo ? 5000 : 2200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { ensureDom(); updCount(); });
  else { ensureDom(); updCount(); }
})();
