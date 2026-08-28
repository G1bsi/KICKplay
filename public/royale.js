// ─────────────────────────────────────────────────────────────
//  🪂 БАТЛ РОЯЛЬ — лобі / мінімапа (PUBG HUD)
//  Classic script, підключається ПІСЛЯ app.js. Користується його
//  глобалами: addWinner, escapeHtml, secureRandomInt, playSfx, phase.
//  Контракт (глобальні імена незмінні): startRoyale, closeRoyaleOverlay,
//  royHandleMessage, royRender. Фінал (перестрілку) веде window.RSO
//  з shootout.js — тут лише виклик start/stop.
//  Усі власні змінні — з префіксом rl/RL_, щоб не зіткнутись зі старими
//  let/const рояля в app.js, поки їх не прибрали.
// ─────────────────────────────────────────────────────────────

const RL_COLS = 'ABCDEFGHIJ';
const RL_N = 10;                       // 10×10 клітинок
const RL_U = 100;                      // одиниць viewBox на клітинку
const RL_PAD = 40;                     // поля під підписи осей
const RL_VB = RL_PAD * 2 + RL_N * RL_U; // 1080
const RL_SAVE_KEY = 'royaleState';     // той самий ключ, що й раніше — старі сейви відновлюються
const RL_MIN_RADIUS = 0.5;             // зона ніколи не зникає: центр-клітинка завжди всередині
const RL_SHRINK_K = 0.62, RL_SHRINK_B = 0.3; // r' = r·0.62 − 0.3 (зі старих правил)
const RL_ANCHOR_R = 1.2;               // маленька зона «чіпляється» за клітинку живого гравця
const RL_FINAL_MAX = 8;                // стільки живих (і менше) — стрімер може запустити фінал вручну
const RL_LABEL_MAX = 30;               // до стількох живих — підписуємо ніки прямо на мапі
/* Мапи лобі: щогри випадкова з map1/map2/map3. Розширення не фіксоване:
   слот пробує png → jpg → jpeg → webp → gif, тож стрімер кладе файл у
   будь-якому форматі. Слот без жодного файла поступається іншому;
   коли не лишилось жодного — лобі показує плейсхолдер. */
const RL_MAP_SLOTS = ['map1', 'map2', 'map3'];
const RL_MAP_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const RL_EXT_KEY = 'royaleMapExts';
const rlMapUrl = (slot, ext) => '/assets/pubg/' + slot + '.' + ext;
/* памʼять форматів: коли слот один раз завантажився, його розширення
   запамʼятовується — наступні ігри не смикають неіснуючі шляхи (без 404) */
let rlExtMemo = {};
try { rlExtMemo = JSON.parse(localStorage.getItem(RL_EXT_KEY) || '{}') || {}; } catch (e) { rlExtMemo = {}; }
let rlMapSrc = null;        // мапа поточної гри (переживає F5 разом зі станом)
let rlMapQueue = [], rlMapQi = 0;   // черга кандидатів на цю гру
function rlSlotExts(slot) {
  const memo = rlExtMemo[slot];
  const rest = RL_MAP_EXTS.filter(e => e !== memo);
  return memo ? [memo].concat(rest) : rest;
}
function rlPickMap() {
  /* випадковий порядок слотів: перший — мапа гри, решта підстрахують,
     якщо файла нема */
  const order = RL_MAP_SLOTS.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  rlMapQueue = [];
  order.forEach(slot => rlSlotExts(slot).forEach(ext => rlMapQueue.push(rlMapUrl(slot, ext))));
  rlMapQi = 0;
  rlMapSrc = rlMapQueue[0];
}
/* Біом фінальної перестрілки жорстко привʼязаний до СЛОТА мапи цієї гри:
   map1 → ліс, map2 → пустеля, map3 → зима. Невпізнаний шлях — ліс. */
function rlBiomeOf(src) {
  const m = typeof src === 'string' ? src.match(/\/(map[123])\.[a-z0-9]+$/i) : null;
  return m ? { map1: 'forest', map2: 'desert', map3: 'winter' }[m[1].toLowerCase()] : 'forest';
}
function rlNextMapCandidate() {
  if (rlMapQi + 1 >= rlMapQueue.length) return false;
  rlMapSrc = rlMapQueue[++rlMapQi];
  return true;
}
function rlRememberMapExt(src) {
  const m = String(src || '').match(/([a-z0-9]+)\.([a-z]+)$/i);
  if (!m || rlExtMemo[m[1]] === m[2]) return;
  rlExtMemo[m[1]] = m[2];
  try { localStorage.setItem(RL_EXT_KEY, JSON.stringify(rlExtMemo)); } catch (e) {}
}
function rlApplyMap() {
  if (!rlDom || !rlDom.mapImg) return;
  if (!rlMapSrc) rlPickMap();
  rlDom.map.classList.remove('rl-noimg');
  rlDom.mapImg.setAttribute('href', rlMapSrc);
}

let rlPlayers = {};       // nick -> {nick, num, col, row, alive, dying, removed, died}
let rlZone = null;        // {cx, cy, radius, stage, next:{cx,cy,radius}|null} у клітинкових координатах (центри 0..9)
let rlJoinLocked = false; // після першого звуження/червоної зони новачки не приймаються
let rlPhase = 'idle';     // idle | playing | shootout | finished
let rlPendingFight = null;// [{nick, col, row, startHP}] — фіналісти за правилами (усі поза зоною / в одній клітинці / всі в red zone)
let rlWinner = null;      // нік переможця
let rlNextNum = 1;        // порядковий номер маркера
let rlDeathSeq = 0;       // порядок вибуття — для сортування списку «Выбыли»
let rlRedBusy = false;    // триває анімація червоної зони — кнопки заблоковані
let rlRedTimers = [];
let rlDom = null;         // кеш елементів
let rlRenderRAF = 0;
let rlSaveT = 0;
let rlRecent = new Map(); // nick -> час появи/переходу, для pop-анімації маркера
let rlHoverKey = null;

// ── Утиліти ──────────────────────────────────────────────────
function rlFloat() { return secureRandomInt(1000000) / 1000000; }
function rlClamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rlAlive() { return Object.values(rlPlayers).filter(p => p.alive); }
function rlDist(c, r, cx, cy) { return Math.hypot(c - cx, r - cy); }
function rlInZone(c, r, z) { z = z || rlZone; return !z || rlDist(c, r, z.cx, z.cy) <= z.radius + 1e-6; }
function rlCoordName(c, r) { return RL_COLS[c] + (r + 1); }
function rlTrunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function rlSfx(name, vol, rate, maxMs) { try { if (typeof playSfx === 'function') playSfx(name, vol, rate, maxMs); } catch (e) {} }
function rlEsc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function rlSvg(tag, attrs, parent) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}
function rlParseCoord(text) {
  const m = String(text || '').trim().match(/^([A-Ja-j])\s*([1-9]|10)$/);
  if (!m) return null;
  const col = RL_COLS.indexOf(m[1].toUpperCase()), row = parseInt(m[2], 10) - 1;
  if (col < 0 || row < 0 || row >= RL_N) return null;
  return { col, row };
}
function rlStatus(msg) { if (rlDom && rlDom.status) { rlDom.status.textContent = msg; rlDom.status.title = msg; } }
// позиція центру клітинки у viewBox
function rlCX(c) { return RL_PAD + (c + 0.5) * RL_U; }
function rlCY(r) { return RL_PAD + (r + 0.5) * RL_U; }

// ── DOM: знаходимо/будуємо один раз ──────────────────────────
function rlEnsureDom() {
  if (rlDom && rlDom.root && document.body.contains(rlDom.root)) return rlDom;
  const root = document.getElementById('royale-overlay');
  if (!root) return null;
  const q = id => document.getElementById(id);
  rlDom = {
    root,
    status: q('rl-status'), alive: q('rl-alive-n'), zoneChip: q('rl-zone-chip'), lockChip: q('rl-lock-chip'),
    aliveList: q('rl-alive-list'), deadList: q('rl-dead-list'), aliveCnt: q('rl-alive-cnt'), deadCnt: q('rl-dead-cnt'),
    stage: q('rl-stage'), map: q('rl-map'), tip: q('rl-tip'), banner: q('rl-banner'), bannerNick: q('rl-banner-nick'),
    zoneBtn: q('rl-zone-btn'), redBtn: q('rl-red-btn'), fightBtn: q('rl-fight-btn'),
    testForm: q('rl-test-form'), testArea: q('rl-test-area'), testMsg: q('rl-test-msg'), testPartBtn: q('rl-test-part-btn'),
  };
  if (rlDom.map && !rlDom.map.querySelector('svg')) rlBuildSvg();
  if (rlDom.aliveList && !rlDom.aliveList._rlHooked) {
    // наведення на рядок списку підсвічує клітинку на мапі
    for (const list of [rlDom.aliveList, rlDom.deadList]) {
      if (!list) continue;
      list._rlHooked = true;
      list.addEventListener('mouseover', e => {
        const row = e.target.closest('.rl-row'); if (!row) return;
        rlHoverCell(+row.dataset.c, +row.dataset.r, false);
      });
      list.addEventListener('mouseleave', () => rlUnhover());
    }
  }
  return rlDom;
}

// Статичні шари SVG. Динамічні (зона, маркери, fx) перемальовує royRender.
function rlBuildSvg() {
  const map = rlDom.map;
  const svg = rlSvg('svg', { viewBox: '0 0 ' + RL_VB + ' ' + RL_VB, 'aria-hidden': 'true' });
  const defs = rlSvg('defs', null, svg);
  // маска: все, крім кола зони — затемнюємо
  const mask = rlSvg('mask', { id: 'rl-zone-mask', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: RL_VB, height: RL_VB }, defs);
  rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: RL_N * RL_U, height: RL_N * RL_U, fill: '#fff' }, mask);
  const hole = rlSvg('circle', { id: 'rl-zone-hole', cx: RL_VB / 2, cy: RL_VB / 2, r: 0, fill: '#000' }, mask);
  const blur = rlSvg('filter', { id: 'rl-blur', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
  rlSvg('feGaussianBlur', { stdDeviation: 7 }, blur);
  const pat = rlSvg('pattern', { id: 'rl-ph', width: 25, height: 25, patternUnits: 'userSpaceOnUse' }, defs);
  rlSvg('circle', { cx: 12.5, cy: 12.5, r: 1.4, class: 'rl-ph-dot' }, pat);
  const clip = rlSvg('clipPath', { id: 'rl-map-clip' }, defs);
  rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: RL_N * RL_U, height: RL_N * RL_U }, clip);

  const M = RL_N * RL_U;
  // тло
  const bg = rlSvg('g', { class: 'rl-l-bg', 'clip-path': 'url(#rl-map-clip)' }, svg);
  rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: M, height: M, class: 'rl-bg-ph' }, bg);
  rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: M, height: M, fill: 'url(#rl-ph)' }, bg);
  const t = rlSvg('text', { x: RL_VB / 2, y: RL_VB / 2, class: 'rl-bg-phtxt' }, bg); t.textContent = 'NO MAP';
  const img = rlSvg('image', { x: RL_PAD, y: RL_PAD, width: M, height: M, preserveAspectRatio: 'xMidYMid slice', class: 'rl-bg-img' }, bg);
  rlDom.mapImg = img;
  if (!rlMapSrc) rlPickMap();
  img.setAttribute('href', rlMapSrc);
  /* мапи нема на диску — тихо пробуємо наступну; коли скінчились кандидати,
     показуємо плейсхолдер (без помилок у консолі) */
  img.addEventListener('error', () => {
    if (rlNextMapCandidate()) img.setAttribute('href', rlMapSrc);
    else map.classList.add('rl-noimg');
  });
  img.addEventListener('load', () => rlRememberMapExt(rlMapSrc));
  rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: M, height: M, class: 'rl-bg-dim' }, bg);

  // клітинки поза зоною (динамічно)
  rlSvg('g', { class: 'rl-l-outcells', 'clip-path': 'url(#rl-map-clip)' }, svg);
  // зона (динамічно)
  const zg = rlSvg('g', { class: 'rl-l-zone', 'clip-path': 'url(#rl-map-clip)', style: 'display:none' }, svg);
  rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: M, height: M, class: 'rl-outside', mask: 'url(#rl-zone-mask)' }, zg);
  rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: M, height: M, class: 'rl-outside-tint', mask: 'url(#rl-zone-mask)' }, zg);
  rlSvg('circle', { class: 'rl-zone-glow', cx: 0, cy: 0, r: 0 }, zg);
  rlSvg('circle', { class: 'rl-zone-edge', cx: 0, cy: 0, r: 0 }, zg);
  rlSvg('circle', { class: 'rl-zone-next', cx: 0, cy: 0, r: 0, style: 'display:none' }, zg);

  // сітка + рамка + осі (статично)
  const grid = rlSvg('g', { class: 'rl-l-grid' }, svg);
  for (let i = 0; i <= RL_N; i++) {
    const p = RL_PAD + i * RL_U;
    rlSvg('line', { x1: p, y1: RL_PAD, x2: p, y2: RL_PAD + M, class: 'rl-grid-line' }, grid);
    rlSvg('line', { x1: RL_PAD, y1: p, x2: RL_PAD + M, y2: p, class: 'rl-grid-line' }, grid);
  }
  rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: M, height: M, class: 'rl-frame' }, grid);
  // HUD-кутики
  const L = 46, o = 3;
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const x0 = sx > 0 ? RL_PAD - o : RL_PAD + M + o, y0 = sy > 0 ? RL_PAD - o : RL_PAD + M + o;
    rlSvg('polyline', { points: (x0) + ',' + (y0 + sy * L) + ' ' + x0 + ',' + y0 + ' ' + (x0 + sx * L) + ',' + y0, class: 'rl-corner' }, grid);
  }
  for (let i = 0; i < RL_N; i++) {
    const c = rlCX(i);
    for (const y of [RL_PAD / 2, RL_PAD + M + RL_PAD / 2]) { const tx = rlSvg('text', { x: c, y, class: 'rl-axis' }, grid); tx.textContent = RL_COLS[i]; }
    for (const x of [RL_PAD / 2, RL_PAD + M + RL_PAD / 2]) { const tx = rlSvg('text', { x, y: c, class: 'rl-axis' }, grid); tx.textContent = String(i + 1); }
  }
  // дрібні координати в кутку кожної клітинки (ховаються, коли мапа мала)
  for (let r = 0; r < RL_N; r++) for (let c = 0; c < RL_N; c++) {
    const tx = rlSvg('text', { x: RL_PAD + c * RL_U + 6, y: RL_PAD + r * RL_U + 20, class: 'rl-cellcoord' }, grid);
    tx.textContent = rlCoordName(c, r);
  }

  rlSvg('g', { class: 'rl-l-red', 'clip-path': 'url(#rl-map-clip)' }, svg);
  rlSvg('g', { class: 'rl-l-dying' }, svg);
  rlSvg('g', { class: 'rl-l-markers' }, svg);
  rlSvg('g', { class: 'rl-l-win' }, svg);
  rlSvg('g', { class: 'rl-l-fx', style: 'pointer-events:none' }, svg);

  // шар наведення: прозорі прямокутники-клітинки
  const hit = rlSvg('g', { class: 'rl-l-hit' }, svg);
  rlSvg('rect', { class: 'rl-hover', x: 0, y: 0, width: RL_U, height: RL_U }, hit);
  for (let r = 0; r < RL_N; r++) for (let c = 0; c < RL_N; c++) {
    rlSvg('rect', { x: RL_PAD + c * RL_U, y: RL_PAD + r * RL_U, width: RL_U, height: RL_U, class: 'rl-hit', 'data-c': c, 'data-r': r }, hit);
  }
  hit.addEventListener('mouseover', e => {
    const el = e.target; if (!el.classList || !el.classList.contains('rl-hit')) return;
    rlHoverCell(+el.getAttribute('data-c'), +el.getAttribute('data-r'), true);
  });
  hit.addEventListener('mouseleave', () => rlUnhover());

  map.appendChild(svg);
  rlDom.svg = svg; rlDom.hole = hole;
  rlDom.lOut = svg.querySelector('.rl-l-outcells'); rlDom.lZone = zg;
  rlDom.zGlow = zg.querySelector('.rl-zone-glow'); rlDom.zEdge = zg.querySelector('.rl-zone-edge'); rlDom.zNext = zg.querySelector('.rl-zone-next');
  rlDom.lRed = svg.querySelector('.rl-l-red'); rlDom.lDying = svg.querySelector('.rl-l-dying');
  rlDom.lMarkers = svg.querySelector('.rl-l-markers'); rlDom.lWin = svg.querySelector('.rl-l-win'); rlDom.lFx = svg.querySelector('.rl-l-fx');
  rlDom.hover = hit.querySelector('.rl-hover');
}

// ── Наведення: підсвітка клітинки, підказка, рядки списків ──
function rlHoverCell(c, r, showTip) {
  if (!rlDom || isNaN(c) || isNaN(r)) return;
  const key = c + ',' + r;
  if (rlHoverKey === key) return;
  rlUnhover();
  rlHoverKey = key;
  rlDom.hover.setAttribute('x', RL_PAD + c * RL_U); rlDom.hover.setAttribute('y', RL_PAD + r * RL_U);
  rlDom.hover.classList.add('rl-show');
  const here = Object.values(rlPlayers).filter(p => p.col === c && p.row === r && !p.removed);
  here.forEach(p => { const row = document.getElementById('rl-row-' + p.num); if (row) row.classList.add('rl-hl'); });
  if (!showTip || !rlDom.tip) return;
  const alive = here.filter(p => p.alive).sort((a, b) => a.num - b.num);
  const dead = here.filter(p => !p.alive);
  if (!alive.length && !dead.length) return;
  const MAX = 14;
  let html = '<div class="rl-tip-h"><span>' + rlCoordName(c, r) + '</span><span>' + alive.length + ' чел.</span></div>';
  alive.slice(0, MAX).forEach(p => { html += '<div class="rl-tip-n"><i>' + p.num + '</i>' + rlEsc(p.nick) + '</div>'; });
  dead.slice(0, Math.max(0, MAX - alive.length)).forEach(p => { html += '<div class="rl-tip-n rl-tip-dead"><i>' + p.num + '</i>' + rlEsc(p.nick) + '</div>'; });
  const rest = alive.length + dead.length - MAX;
  if (rest > 0) html += '<div class="rl-tip-more">+' + rest + ' ещё</div>';
  rlDom.tip.innerHTML = html;
  rlDom.tip.classList.add('rl-show');
  // підказка праворуч від клітинки; біля правого краю — ліворуч
  const sr = rlDom.stage.getBoundingClientRect(), k = sr.width / RL_VB;
  const cellL = (RL_PAD + c * RL_U) * k, cellT = (RL_PAD + r * RL_U) * k, cs = RL_U * k;
  const tw = rlDom.tip.offsetWidth, th = rlDom.tip.offsetHeight;
  let left = cellL + cs + 6; if (left + tw > sr.width) left = cellL - tw - 6;
  let top = rlClamp(cellT + cs / 2 - th / 2, 0, Math.max(0, sr.height - th));
  rlDom.tip.style.left = Math.round(left) + 'px'; rlDom.tip.style.top = Math.round(top) + 'px';
}
function rlUnhover() {
  if (!rlDom || !rlHoverKey) return;
  rlHoverKey = null;
  rlDom.hover.classList.remove('rl-show');
  if (rlDom.tip) rlDom.tip.classList.remove('rl-show');
  rlDom.root.querySelectorAll('.rl-row.rl-hl').forEach(el => el.classList.remove('rl-hl'));
}

// ── Стан гри ─────────────────────────────────────────────────
function rlResetState() {
  rlPlayers = {}; rlZone = null; rlJoinLocked = false; rlPhase = 'playing';
  rlPendingFight = null; rlWinner = null; rlNextNum = 1; rlDeathSeq = 0;
  rlRecent.clear(); rlClearRed();
  rlPickMap(); rlApplyMap();   // кожна нова гра — інша мапа
}
function rlAddPlayer(nick, col, row) {
  const p = { nick, num: rlNextNum++, col, row, alive: true, dying: false, removed: false, died: 0 };
  rlPlayers[nick] = p;
  rlRecent.set(nick, performance.now());
  return p;
}
function rlKill(p) { p.alive = false; p.dying = true; p.died = ++rlDeathSeq; }
// «лежачі» вибулі прибираються з мапи при наступній події зони
function rlPurgeDying() { Object.values(rlPlayers).forEach(p => { if (p.dying) { p.dying = false; p.removed = true; } }); }

// ── Збереження / відновлення (localStorage) ──────────────────
function roySaveState(force) {
  if (!rlPlayers || !Object.keys(rlPlayers).length) return; // не затираємо сейв порожньою грою
  const now = Date.now();
  if (!force && now - rlSaveT < 700) return; // легкий тротлінг — рендер буває часто
  rlSaveT = now;
  try {
    localStorage.setItem(RL_SAVE_KEY, JSON.stringify({
      v: 2, players: rlPlayers, zone: rlZone, joinLocked: rlJoinLocked,
      phase: rlPhase === 'finished' ? 'finished' : 'playing', // shootout → playing: після F5 фінал можна запустити знову
      pendingFight: rlPendingFight, winner: rlWinner, nextNum: rlNextNum, deathSeq: rlDeathSeq, savedAt: now,
      mapSrc: rlMapSrc,   // після F5 гра лишається на тій самій мапі
    }));
  } catch (e) {}
}
function royLoadState() {
  try {
    const raw = localStorage.getItem(RL_SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || !d.players || !Object.keys(d.players).length) return false;
    rlPlayers = {};
    let maxNum = 0, maxDied = 0;
    Object.keys(d.players).forEach(nick => {
      const s = d.players[nick] || {};
      const col = rlClamp(parseInt(s.col, 10) || 0, 0, RL_N - 1), row = rlClamp(parseInt(s.row, 10) || 0, 0, RL_N - 1);
      const p = { nick, num: parseInt(s.num, 10) || 0, col, row, alive: !!s.alive, dying: !!s.dying, removed: !!s.removed, died: parseInt(s.died, 10) || 0 };
      rlPlayers[nick] = p;
      if (p.num > maxNum) maxNum = p.num;
      if (p.died > maxDied) maxDied = p.died;
    });
    // старий формат без номерів — нумеруємо по порядку
    Object.values(rlPlayers).forEach(p => { if (!p.num) p.num = ++maxNum; });
    rlNextNum = Math.max(maxNum + 1, parseInt(d.nextNum, 10) || 1);
    rlDeathSeq = Math.max(maxDied, parseInt(d.deathSeq, 10) || 0);
    rlZone = null;
    if (d.zone && isFinite(d.zone.radius)) {
      rlZone = { cx: +d.zone.cx, cy: +d.zone.cy, radius: +d.zone.radius, stage: parseInt(d.zone.stage, 10) || 1, next: null };
      if (d.zone.next && isFinite(d.zone.next.radius)) rlZone.next = { cx: +d.zone.next.cx, cy: +d.zone.next.cy, radius: +d.zone.next.radius };
    }
    rlJoinLocked = !!d.joinLocked;
    rlPhase = d.phase === 'finished' ? 'finished' : 'playing';
    rlPendingFight = Array.isArray(d.pendingFight) && d.pendingFight.length ? d.pendingFight : null;
    rlWinner = (d.winner && rlPlayers[d.winner]) ? d.winner : null;
    /* мапа гри переживає F5: приймаємо лише свій формат шляху */
    if (typeof d.mapSrc === 'string' && /^\/assets\/pubg\/[a-z0-9]+\.[a-z]+$/i.test(d.mapSrc)) {
      const m = d.mapSrc.match(/([a-z0-9]+)\.([a-z]+)$/i);
      if (RL_MAP_SLOTS.indexOf(m[1]) >= 0 && RL_MAP_EXTS.indexOf(m[2].toLowerCase()) >= 0) {
        /* збережена мапа — перший кандидат, решта лишаються підстраховкою */
        rlPickMap();
        rlMapQueue = [d.mapSrc].concat(rlMapQueue.filter(u => u !== d.mapSrc));
        rlMapQi = 0; rlMapSrc = d.mapSrc;
        rlApplyMap();
      }
    }
    if (rlPhase === 'finished' && !rlWinner && rlAlive().length === 1) rlWinner = rlAlive()[0].nick;
    return true;
  } catch (e) { return false; }
}

// ── Контракт: відкрити / закрити ─────────────────────────────
function startRoyale() {
  if (!rlEnsureDom()) return;
  rlClearRed();
  const resumed = royLoadState();
  if (!resumed) rlResetState();
  if (typeof phase !== 'undefined') phase = 'racing';
  rlDom.root.classList.add('visible');
  if (!window._rlResizeHooked) {
    window._rlResizeHooked = true;
    window.addEventListener('resize', () => { if (rlPhase !== 'idle') rlScheduleRender(); });
  }
  royRender();
  if (resumed && rlPhase === 'finished') {
    rlStatus(rlWinner ? '👑 Игра завершена · победитель: ' + rlWinner + ' · «Новая» — начать заново' : 'Игра завершена · «Новая» — начать заново');
  } else if (resumed) {
    rlStatus('▶️ Игра восстановлена · в игре: ' + rlAlive().length + (rlJoinLocked ? ' · 🔒 вход закрыт' : '') + (rlPendingFight ? ' · ⚔️ финал готов' : ''));
  } else {
    rlStatus('Зрители пишут координаты (A1, G4…) чтобы занять клетку');
  }
}

function closeRoyaleOverlay() {
  if (rlPhase !== 'idle') roySaveState(true); // гра відновиться при наступному вході
  if (window.RSO && typeof window.RSO.stop === 'function') { try { window.RSO.stop(); } catch (e) {} }
  rlClearRed();
  rlPhase = 'idle';
  rlUnhover();
  const root = document.getElementById('royale-overlay');
  if (root) root.classList.remove('visible');
  if (typeof phase !== 'undefined' && phase === 'racing') phase = 'idle';
}

function royNewGame() {
  if (!rlEnsureDom()) return;
  if (Object.keys(rlPlayers).length && !confirm('Начать новую игру? Текущая будет удалена.')) return;
  try { localStorage.removeItem(RL_SAVE_KEY); } catch (e) {}
  if (window.RSO && typeof window.RSO.stop === 'function') { try { window.RSO.stop(); } catch (e) {} }
  rlResetState();
  if (rlDom.lFx) rlDom.lFx.innerHTML = '';
  royRender();
  rlStatus('Зрители пишут координаты (A1, G4…) чтобы занять клетку');
}

// ── Контракт: повідомлення з чату ────────────────────────────
function royHandleMessage(nick, text) {
  if (rlPhase !== 'playing') return;
  const coord = rlParseCoord(text);
  if (!coord) return;
  nick = String(nick || '').trim();
  if (!nick || nick.length > 60) return;
  const existing = rlPlayers[nick];
  if (existing && !existing.alive) return;          // вибулі не повертаються
  if (!existing && rlJoinLocked) return;             // вхід закритий — новачки не приймаються
  if (existing) {
    if (existing.col === coord.col && existing.row === coord.row) return; // та сама клітинка — нічого не міняємо
    existing.col = coord.col; existing.row = coord.row; // зміна клітинки дозволена (втекти від зони)
    rlRecent.set(nick, performance.now());
  } else {
    rlAddPlayer(nick, coord.col, coord.row);
  }
  rlScheduleRender();
}
// злиття частих викликів (флуд чату) в один кадр
function rlScheduleRender() {
  if (rlRenderRAF) return;
  rlRenderRAF = requestAnimationFrame(() => { rlRenderRAF = 0; royRender(); });
}

// ── Контракт: рендер ─────────────────────────────────────────
function royRender() {
  if (!rlEnsureDom() || !rlDom.svg) return;
  rlMeasure();
  rlRenderZone();
  rlRenderMarkers();
  rlRenderWinner();
  rlRenderLists();
  rlRenderHud();
  rlSyncControls();
  roySaveState();
}
function rlMeasure() {
  const w = rlDom.map.getBoundingClientRect().width || 600;
  const cellPx = w / RL_VB * RL_U;
  rlDom.map.classList.toggle('rl-small', cellPx < 40);
  rlDom.map.classList.toggle('rl-tiny', cellPx < 28);
  rlDom.cellPx = cellPx;
}
// Виставити кола зони (маска-діра + світіння + край) у довільну позицію —
// використовується і рендером, і анімацією звуження
function rlSetZoneCircles(z) {
  const cx = rlCX(z.cx), cy = rlCY(z.cy), r = Math.max(0, z.radius) * RL_U;
  rlDom.hole.setAttribute('cx', cx); rlDom.hole.setAttribute('cy', cy); rlDom.hole.setAttribute('r', r);
  for (const el of [rlDom.zGlow, rlDom.zEdge]) { el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r); }
}

// Плавне звуження: коло їде зі старої позиції в нову ~1с, easeOutCubic.
// Поки їде — rlZoneBusy=true (кнопка «Зона» заблокована, royRender кола не чіпає).
let rlZoneAnimRAF = null;
let rlZoneBusy = false;
function rlAnimateZone(from, to, ms, done) {
  if (rlZoneAnimRAF) cancelAnimationFrame(rlZoneAnimRAF);
  rlDom.lZone.style.display = '';
  const t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (rlZoneAnimRAF) { cancelAnimationFrame(rlZoneAnimRAF); rlZoneAnimRAF = null; }
    rlSetZoneCircles(to);
    if (done) done();
  };
  const frame = (now) => {
    if (finished) return;
    const k = Math.min(1, (now - t0) / ms);
    const e = ease(k);
    rlSetZoneCircles({
      cx: from.cx + (to.cx - from.cx) * e,
      cy: from.cy + (to.cy - from.cy) * e,
      radius: from.radius + (to.radius - from.radius) * e,
    });
    if (k < 1) rlZoneAnimRAF = requestAnimationFrame(frame);
    else finish();
  };
  rlZoneAnimRAF = requestAnimationFrame(frame);
  // страховка: у прихованій вкладці rAF не тікає — завершуємо по таймеру,
  // щоб гра ніколи не зависала з заблокованою кнопкою
  setTimeout(finish, ms + 120);
}

function rlRenderZone() {
  rlDom.lOut.innerHTML = '';
  if (!rlZone) { rlDom.lZone.style.display = 'none'; return; }
  rlDom.lZone.style.display = '';
  if (!rlZoneBusy) rlSetZoneCircles(rlZone);   // під час анімації колами керує rlAnimateZone
  if (rlZone.next) {
    rlDom.zNext.style.display = '';
    rlDom.zNext.setAttribute('cx', rlCX(rlZone.next.cx)); rlDom.zNext.setAttribute('cy', rlCY(rlZone.next.cy)); rlDom.zNext.setAttribute('r', rlZone.next.radius * RL_U);
  } else rlDom.zNext.style.display = 'none';
  // клітинки, чий центр поза колом — підсвічуємо як небезпечні (точно видно, хто вилетить)
  for (let rr = 0; rr < RL_N; rr++) for (let c = 0; c < RL_N; c++) {
    if (!rlInZone(c, rr)) rlSvg('rect', { x: RL_PAD + c * RL_U, y: RL_PAD + rr * RL_U, width: RL_U, height: RL_U, class: 'rl-outcell' }, rlDom.lOut);
  }
}
function rlRenderMarkers() {
  const lm = rlDom.lMarkers, ld = rlDom.lDying;
  lm.innerHTML = ''; ld.innerHTML = '';
  const groups = {}, dying = {};
  const all = Object.values(rlPlayers);
  let aliveN = 0;
  for (const p of all) {
    if (p.removed) continue;
    const key = p.col + ',' + p.row;
    if (p.alive) { (groups[key] = groups[key] || []).push(p); aliveN++; }
    else if (p.dying) (dying[key] = dying[key] || []).push(p);
  }
  const showNicks = aliveN <= RL_LABEL_MAX && rlDom.cellPx >= 34;
  const now = performance.now();
  for (const key in dying) {
    const [c, r] = key.split(',').map(Number);
    const t = rlSvg('text', { x: RL_PAD + c * RL_U + RL_U - 6, y: RL_PAD + r * RL_U + RL_U - 8, class: 'rl-dying' }, ld);
    t.textContent = dying[key].length > 1 ? '✕' + dying[key].length : '✕';
  }
  for (const key in groups) {
    const g = groups[key].sort((a, b) => a.num - b.num);
    const [c, r] = key.split(',').map(Number);
    if (rlWinner && g.length === 1 && g[0].nick === rlWinner) continue; // переможця малює rlRenderWinner
    const outer = rlSvg('g', { transform: 'translate(' + (RL_PAD + c * RL_U) + ',' + (RL_PAD + r * RL_U) + ')' }, lm);
    const isNew = g.some(p => now - (rlRecent.get(p.nick) || -1e9) < 1200);
    const inner = rlSvg('g', { class: 'rl-m' + (g.length >= 3 ? ' rl-cluster' : '') + (isNew ? ' rl-new' : '') }, outer);
    const y0 = showNicks ? 42 : 50;
    if (g.length === 1) {
      rlMarkerDot(inner, 50, y0, 17, String(g[0].num));
      if (showNicks) rlMarkerLabel(inner, 50, 84, rlTrunc(g[0].nick, 12), '');
    } else if (g.length === 2) {
      rlMarkerDot(inner, 30, y0, 15, String(g[0].num));
      rlMarkerDot(inner, 70, y0, 15, String(g[1].num));
      if (showNicks) { rlMarkerLabel(inner, 50, 76, rlTrunc(g[0].nick, 11), 'rl-sm'); rlMarkerLabel(inner, 50, 94, rlTrunc(g[1].nick, 11), 'rl-sm'); }
    } else {
      rlMarkerDot(inner, 50, y0, 20, String(g.length));
      if (showNicks) rlMarkerLabel(inner, 50, 86, rlTrunc(g[0].nick, 9) + ' +' + (g.length - 1), 'rl-more');
    }
  }
  // pop-анімація одноразова — після кадру прибираємо позначку
  for (const [nick, t] of rlRecent) if (now - t > 1500) rlRecent.delete(nick);
}
function rlMarkerDot(parent, x, y, r, label) {
  rlSvg('circle', { cx: x, cy: y, r, class: 'rl-m-dot' }, parent);
  const t = rlSvg('text', { x, y: y + 1, class: 'rl-m-n' + (label.length >= 3 ? ' rl-m-n3' : '') }, parent);
  t.textContent = label;
}
function rlMarkerLabel(parent, x, y, text, cls) {
  const t = rlSvg('text', { x, y, class: 'rl-m-nick' + (cls ? ' ' + cls : '') }, parent);
  t.textContent = text;
}
function rlRenderWinner() {
  const lw = rlDom.lWin; lw.innerHTML = '';
  const p = rlWinner ? rlPlayers[rlWinner] : null;
  if (!p) { if (rlDom.banner) rlDom.banner.classList.remove('rl-show'); return; }
  const x = rlCX(p.col), y = rlCY(p.row);
  rlSvg('circle', { cx: x, cy: y, r: 34, class: 'rl-win-ring' }, lw);
  const g = rlSvg('g', { transform: 'translate(' + x + ',' + (y - 44) + ')' }, lw);
  const crown = rlSvg('text', { x: 0, y: 0, class: 'rl-crown' }, g); crown.textContent = '👑';
  const nick = rlSvg('text', { x, y: y + 56, class: 'rl-win-nick' }, lw); nick.textContent = rlTrunc(p.nick, 16);
  if (rlDom.banner) { rlDom.bannerNick.textContent = p.nick; rlDom.banner.classList.add('rl-show'); }
}
function rlRenderLists() {
  const all = Object.values(rlPlayers);
  const alive = all.filter(p => p.alive).sort((a, b) => a.num - b.num);
  const dead = all.filter(p => !p.alive).sort((a, b) => b.died - a.died); // останні вибулі зверху
  const row = (p, cls) => '<div class="rl-row' + cls + '" id="rl-row-' + p.num + '" data-c="' + p.col + '" data-r="' + p.row + '" title="' + rlEsc(p.nick) + '">' +
    '<span class="rl-num">' + p.num + '</span><span class="rl-nick">' + rlEsc(p.nick) + '</span><span class="rl-pos">' + rlCoordName(p.col, p.row) + '</span></div>';
  rlDom.aliveList.innerHTML = alive.length
    ? alive.map(p => row(p, p.nick === rlWinner ? ' rl-win' : '')).join('')
    : '<div class="rl-empty">Пока никого.<br>Пиши координату в чат: A1 … J10</div>';
  rlDom.deadList.innerHTML = dead.length ? dead.map(p => row(p, ' rl-out')).join('') : '<div class="rl-empty">Все живы</div>';
  rlDom.aliveCnt.textContent = alive.length; rlDom.deadCnt.textContent = dead.length;
  rlDom.alive.textContent = alive.length;
}
function rlRenderHud() {
  const zc = rlDom.zoneChip, lc = rlDom.lockChip;
  if (zc) {
    if (rlPhase === 'finished') zc.innerHTML = 'ЗОНА <b>ФИНИШ</b>';
    else if (!rlZone) zc.innerHTML = 'ЗОНА <b>ОЖИДАНИЕ</b>';
    else zc.innerHTML = 'ЗОНА <b>ФАЗА ' + rlZone.stage + '</b>' + (rlZone.next ? ' <span>→ ' + (rlZone.stage + 1) + '</span>' : ' <span>→ ?</span>');
    zc.classList.toggle('rl-final', !!rlPendingFight && rlPhase === 'playing');
  }
  if (lc) {
    lc.className = 'rl-chip ' + (rlJoinLocked ? 'rl-lock-closed' : 'rl-lock-open');
    lc.innerHTML = rlJoinLocked ? '🔒 <b>ВХОД ЗАКРЫТ</b>' : '🔓 <b>ВХОД ОТКРЫТ</b>';
  }
}
function rlFinalAvailable() {
  if (rlPhase !== 'playing' || rlRedBusy) return 0;
  if (rlPendingFight) return rlPendingFight.filter(f => rlPlayers[f.nick] && rlPlayers[f.nick].alive).length;
  const n = rlAlive().length;
  return (n >= 2 && n <= RL_FINAL_MAX) ? n : 0;
}
function rlSyncControls() {
  const playing = rlPhase === 'playing' && !rlRedBusy;
  const aliveN = rlAlive().length;
  if (rlDom.zoneBtn) {
    rlDom.zoneBtn.style.display = rlPendingFight ? 'none' : ''; // фінал готується — зона більше не звужується
    rlDom.zoneBtn.disabled = !playing || aliveN < 1 || rlZoneBusy;
  }
  if (rlDom.redBtn) rlDom.redBtn.disabled = !playing || aliveN <= 1;
  if (rlDom.fightBtn) {
    const n = rlFinalAvailable();
    rlDom.fightBtn.classList.toggle('rl-on', n >= 2);
    rlDom.fightBtn.textContent = '⚔️ НАЧАТЬ ФИНАЛ (' + n + ')';
  }
  if (rlDom.testPartBtn) {
    const parts = (typeof state !== 'undefined' && state && Array.isArray(state.participants)) ? state.participants.length : 0;
    rlDom.testPartBtn.textContent = '👥 Из участников (' + parts + ')';
    rlDom.testPartBtn.disabled = !parts;
  }
}

// ── Зона ─────────────────────────────────────────────────────
// Наступна зона: радіус r·0.62−0.3 (мін 0.5); центр зсувається випадково в межах
// (r−r')·0.6. Якщо нова зона вже «якірна» (≤1.2) — центр = клітинка випадкового
// живого, щоб завжди лишалась безпечна клітинка з людиною (зі старих правил).
function rlNextRadius(r) { return Math.max(RL_MIN_RADIUS, r * RL_SHRINK_K - RL_SHRINK_B); }
function rlShiftedCenter(z, newR) {
  const maxShift = Math.max(0, z.radius - newR);
  return {
    cx: rlClamp(z.cx + (rlFloat() * 2 - 1) * maxShift * 0.6, 0, RL_N - 1),
    cy: rlClamp(z.cy + (rlFloat() * 2 - 1) * maxShift * 0.6, 0, RL_N - 1),
  };
}
// Превью наступної зони НЕ показуємо ніколи: вся суть режиму — глядачі
// наосліп вгадують, куди переміститись перед кожним звуженням.
function rlInitialZone() { return { cx: (RL_N - 1) / 2, cy: (RL_N - 1) / 2, radius: RL_N, stage: 0, next: null }; }

function royaleShrinkZone() {
  if (rlPhase !== 'playing' || rlRedBusy || rlPendingFight || rlZoneBusy) return;
  const alive = rlAlive();
  if (alive.length <= 1) { rlCheckWinner(); return; }
  const firstLock = !rlJoinLocked;
  rlJoinLocked = true; // перше звуження закриває вхід
  rlPurgeDying();
  const cur = rlZone || rlInitialZone();

  let nz;
  {
    const newR = rlNextRadius(cur.radius);
    // фінальна зона зупиняється на якорі (клітинка живого + сусіди),
    // а не стискається в точку — інакше перестрілці нізвідки взятись
    if (newR <= RL_ANCHOR_R) { const a = alive[secureRandomInt(alive.length)]; nz = { cx: a.col, cy: a.row, radius: RL_MIN_RADIUS }; }
    else { const c = rlShiftedCenter(cur, newR); nz = { cx: c.cx, cy: c.cy, radius: newR }; }
  }
  rlZone = { cx: nz.cx, cy: nz.cy, radius: nz.radius, stage: (cur.stage || 0) + 1, next: null };

  const outside = alive.filter(p => !rlInZone(p.col, p.row));
  const inside = alive.filter(p => rlInZone(p.col, p.row));

  // Коло плавно їде у нову позицію ~1с; вибуття і статуси — після зупинки
  rlZoneBusy = true; rlSyncControls();
  rlAnimateZone(cur.radius >= RL_N ? { cx: nz.cx, cy: nz.cy, radius: RL_N * 0.95 } : cur, rlZone, 1000, () => {
    rlZoneBusy = false;

    if (inside.length === 0 && outside.length >= 2) {
      // усі поза зоною — ніхто не вибуває, але фінал: хто ближче до кола, тому більше HP
      const withDist = outside.map(p => ({ p, d: rlDist(p.col, p.row, rlZone.cx, rlZone.cy) - rlZone.radius }));
      const maxD = Math.max(0.01, ...withDist.map(w => w.d));
      const finalists = withDist.map(w => ({ nick: w.p.nick, col: w.p.col, row: w.p.row, startHP: Math.round(45 + (1 - w.d / maxD) * 55) }));
      royRender();
      rlPrepareFight(finalists, '⚠️ Все за зоной! Кто ближе — больше HP · Финал: ' + finalists.length);
      return;
    }
    if (inside.length === 0 && outside.length === 1) {
      // останній живий поза зоною — зона його не добиває, він переможець
      royRender();
      rlCheckWinner();
      return;
    }
    outside.forEach(p => rlKill(p));
    royRender();
    rlFxEliminate(outside);

    // Зона дійшла до останньої клітинки: хто вгадав її — одразу в перестрілку,
    // без зайвих натискань (вгадав один — він переможець через rlCheckWinner)
    if (rlZone.radius <= RL_MIN_RADIUS + 0.001 && inside.length >= 2) {
      rlPrepareFight(inside.map(p => ({ nick: p.nick, col: p.col, row: p.row, startHP: 100 })),
        '⚔️ Финальная клетка ' + rlCoordName(Math.round(rlZone.cx), Math.round(rlZone.cy)) +
        '! Перестрелка: ' + inside.length);
      return;
    }

    rlStatus((firstLock ? '🔒 Вход закрыт! ' : '') + '🌀 Зона ' + rlZone.stage + ': выбыло ' + outside.length + ', осталось ' + inside.length + (inside.length > 1 ? ' · Можно сменить клетку!' : ''));
    rlCheckWinner();
  });
}

// ── Червона зона ─────────────────────────────────────────────
function rlClearRed() {
  rlRedTimers.forEach(t => clearTimeout(t)); rlRedTimers = [];
  rlRedBusy = false;
  if (rlDom && rlDom.lRed) rlDom.lRed.innerHTML = '';
}
function rlRedLater(fn, ms) { const t = setTimeout(fn, ms); rlRedTimers.push(t); return t; }

function royaleRedZone() {
  if (rlPhase !== 'playing' || rlRedBusy) return;
  if (rlAlive().length <= 1) return;
  rlJoinLocked = true; // червона зона теж закриває вхід
  rlPurgeDying();
  // коло радіусом 1..2 клітинки, повністю в межах мапи
  const radius = 1 + rlFloat();
  const cx = (radius - 0.5) + rlFloat() * (RL_N - 2 * radius);
  const cy = (radius - 0.5) + rlFloat() * (RL_N - 2 * radius);
  const cells = [];
  for (let r = 0; r < RL_N; r++) for (let c = 0; c < RL_N; c++) if (rlDist(c, r, cx, cy) <= radius + 1e-6) cells.push([c, r]);
  const inRed = p => cells.some(([c, r]) => c === p.col && r === p.row);

  rlRedBusy = true;
  const L = rlDom.lRed; L.innerHTML = '';
  const X = rlCX(cx), Y = rlCY(cy), R = radius * RL_U;
  cells.forEach(([c, r]) => rlSvg('rect', { x: RL_PAD + c * RL_U, y: RL_PAD + r * RL_U, width: RL_U, height: RL_U, class: 'rl-red-cell' }, L));
  rlSvg('circle', { cx: X, cy: Y, r: R, class: 'rl-red-area' }, L);
  rlSvg('circle', { cx: X, cy: Y, r: R, class: 'rl-red-ring' }, L);
  const lbl = rlSvg('text', { x: X, y: Y, class: 'rl-red-label' }, L); lbl.textContent = 'RED ZONE';
  royRender();
  rlStatus('💥 КРАСНАЯ ЗОНА приближается! Успей сменить клетку');

  rlRedLater(() => {
    // удар: серія вибухів у колі
    const boomAt = (k) => rlRedLater(() => {
      const a = rlFloat() * Math.PI * 2, d = Math.sqrt(rlFloat()) * R * 0.85;
      const bx = X + Math.cos(a) * d, by = Y + Math.sin(a) * d;
      rlSvg('circle', { cx: bx, cy: by, r: 28 + rlFloat() * 26, class: 'rl-boom' }, rlDom.lFx);
      rlSvg('circle', { cx: bx, cy: by, r: 12, class: 'rl-boom-core' }, rlDom.lFx);
      if (k % 2 === 0) rlSfx('cannon', 0.6, 1 + rlFloat() * 0.3, 900);
    }, k * 90);
    for (let k = 0; k < 8; k++) boomAt(k);
    rlSvg('rect', { x: RL_PAD, y: RL_PAD, width: RL_N * RL_U, height: RL_N * RL_U, class: 'rl-flash' }, rlDom.lFx);
    const lblEl = L.querySelector('.rl-red-label'); if (lblEl) lblEl.remove();
    // позиції беремо в момент удару — хто встиг перебігти, той урятувався
    const alive = rlAlive();
    const hit = alive.filter(inRed), survivors = alive.filter(p => !inRed(p));
    rlRedLater(() => {
      L.innerHTML = '';
      rlDom.lFx.querySelectorAll('.rl-boom, .rl-boom-core, .rl-flash').forEach(el => el.remove());
      rlRedBusy = false;
      if (survivors.length === 0 && hit.length >= 2) {
        royRender();
        rlPrepareFight(hit.map(p => ({ nick: p.nick, col: p.col, row: p.row, startHP: 100 })), '⚠️ Все в красной зоне! Финал: ' + hit.length);
        return;
      }
      hit.forEach(p => rlKill(p));
      royRender();
      rlFxEliminate(hit);
      rlStatus(hit.length ? '💥 Взрыв! Выбыло: ' + hit.length + '. Осталось: ' + survivors.length : '💥 Взрыв! Промах — все целы');
      rlCheckWinner();
    }, 800);
  }, 1800);
}

// ── Ефекти вибуття ───────────────────────────────────────────
function rlFxEliminate(players) {
  if (!players.length || !rlDom || !rlDom.lFx) return;
  const shown = players.slice(0, 40); // при масовому вильоті — 40 анімацій достатньо
  shown.forEach((p, i) => {
    setTimeout(() => {
      if (!rlDom || !rlDom.lFx) return;
      const x = rlCX(p.col) + (rlFloat() - 0.5) * 30, y = rlCY(p.row) + (rlFloat() - 0.5) * 30;
      const ring = rlSvg('circle', { cx: x, cy: y, r: 20, class: 'rl-fx-ring' }, rlDom.lFx);
      const xx = rlSvg('text', { x, y, class: 'rl-fx-x' }, rlDom.lFx); xx.textContent = '✕';
      setTimeout(() => { ring.remove(); xx.remove(); }, 1300);
    }, Math.min(i * 45, 700));
  });
  const n = Math.min(3, Math.ceil(shown.length / 4));
  for (let i = 0; i < n; i++) setTimeout(() => rlSfx('pubg-down', 0.7, 0.95 + rlFloat() * 0.15), i * 220);
}

// ── Фінал / переможець ───────────────────────────────────────
function rlCheckWinner() {
  const alive = rlAlive();
  if (alive.length > 1) {
    const cells = new Set(alive.map(p => p.col + ',' + p.row));
    if (cells.size === 1) rlPrepareFight(alive.map(p => ({ nick: p.nick, col: p.col, row: p.row, startHP: 100 })), '⚔️ Все в одной клетке! Финал: ' + alive.length);
    return;
  }
  if (alive.length === 0) {
    rlPhase = 'finished'; rlPendingFight = null;
    royRender(); rlStatus('Все выбыли! «Новая» — начать заново');
    roySaveState(true);
    return;
  }
  royDeclareWinner(alive[0]);
}
function rlPrepareFight(finalists, msg) {
  rlPendingFight = finalists;
  rlStatus(msg);
  rlRenderHud(); rlSyncControls();
  roySaveState(true);
}
function royLaunchFight() {
  if (rlPhase !== 'playing' || rlRedBusy) return;
  let finalists;
  if (rlPendingFight) {
    // список міг застаріти (червона зона після підготовки) — лишаємо тільки живих
    finalists = rlPendingFight.map(f => { const p = rlPlayers[f.nick]; return p && p.alive ? { nick: p.nick, col: p.col, row: p.row, startHP: f.startHP || 100 } : null; }).filter(Boolean);
  } else {
    finalists = rlAlive().map(p => ({ nick: p.nick, col: p.col, row: p.row, startHP: 100 }));
    if (finalists.length > RL_FINAL_MAX) return;
  }
  if (finalists.length < 2) { rlPendingFight = null; rlSyncControls(); rlCheckWinner(); return; }
  if (!window.RSO || typeof window.RSO.start !== 'function') {
    rlStatus('⚠️ Модуль перестрелки (shootout.js) не загружен — финал недоступен');
    return;
  }
  rlPendingFight = finalists;
  rlPhase = 'shootout';
  rlSyncControls();
  roySaveState(true); // після F5 під час бою — фінал можна запустити знову
  rlStatus('⚔️ ФИНАЛ: ' + finalists.length + ' бойцов');
  try {
    window.RSO.start(finalists, { biome: rlBiomeOf(rlMapSrc), onWinner: (f) => royDeclareWinner(f) });
  } catch (e) {
    rlPhase = 'playing'; rlSyncControls();
    rlStatus('⚠️ Ошибка запуска перестрелки: ' + (e && e.message ? e.message : e));
  }
}
function royDeclareWinner(f) {
  if (!f || !f.nick) {
    // нічия / скасування — повертаємось у лобі, фінал можна запустити ще раз
    rlPhase = 'playing'; royRender(); rlStatus('Ничья — финал можно запустить ещё раз');
    return;
  }
  let p = rlPlayers[f.nick];
  if (!p) p = rlAddPlayer(f.nick, rlClamp(parseInt(f.col, 10) || 0, 0, RL_N - 1), rlClamp(parseInt(f.row, 10) || 0, 0, RL_N - 1));
  Object.values(rlPlayers).forEach(q => { if (q !== p && q.alive) { q.alive = false; q.dying = false; q.removed = true; q.died = ++rlDeathSeq; } });
  p.alive = true; p.dying = false; p.removed = false;
  rlWinner = p.nick; rlPhase = 'finished'; rlPendingFight = null;
  royRender();
  rlStatus('👑 ПОБЕДИТЕЛЬ: ' + p.nick);
  rlSfx('win');
  if (typeof addWinner === 'function') addWinner(p.nick);
  roySaveState(true);
}

// ── Тестова панель (олівець) ─────────────────────────────────
function royToggleTestForm() {
  if (!rlEnsureDom() || !rlDom.testForm) return;
  rlDom.testForm.classList.toggle('rl-open');
  rlSyncControls();
}
function rlTestMsg(s) { if (rlDom && rlDom.testMsg) rlDom.testMsg.textContent = s; }
// розсадити ніки по випадкових клітинках (дублі пропускаємо)
function rlAddNicks(nicks) {
  let added = 0;
  for (const raw of nicks) {
    const nick = String(raw || '').trim();
    if (!nick || nick.length > 60 || rlPlayers[nick]) continue;
    rlAddPlayer(nick, secureRandomInt(RL_N), secureRandomInt(RL_N));
    added++;
  }
  if (added) royRender();
  return added;
}
function royTestLoadFile(ev) {
  const file = ev && ev.target && ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = String(e.target.result || '');
    const nicks = text.split(/[\r\n]+/).map(line => line.split(/[,;\t]/)[0].trim()).filter(Boolean);
    if (nicks.length && /^(nick|name|никнейм|ник|имя|user|username)$/i.test(nicks[0])) nicks.shift(); // ймовірний заголовок
    const added = rlAddNicks(nicks);
    rlTestMsg('Из файла: +' + added);
    rlStatus('Из файла загружено: ' + added);
  };
  reader.readAsText(file);
  ev.target.value = '';
}
function royTestAddList() {
  if (!rlEnsureDom() || !rlDom.testArea) return;
  const nicks = rlDom.testArea.value.split(/[\r\n,;\t]+/).map(s => s.trim()).filter(Boolean);
  if (!nicks.length) { rlTestMsg('Список пуст'); return; }
  const added = rlAddNicks(nicks);
  rlDom.testArea.value = '';
  rlTestMsg('Добавлено: ' + added);
}
function royTestFromParticipants() {
  const list = (typeof state !== 'undefined' && state && Array.isArray(state.participants)) ? state.participants : [];
  if (!list.length) { rlTestMsg('Участников нет'); return; }
  const added = rlAddNicks(list.map(x => (x && typeof x === 'object') ? (x.nick || x.name || x.username || '') : x));
  rlTestMsg('Из участников: +' + added);
}
