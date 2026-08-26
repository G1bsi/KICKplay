// ── Міст до дизайн-токенів ──────────────────────────────────
// Canvas, Three.js і градієнти в JS не розуміють var(--accent), тому
// один раз зчитуємо палітру з tokens.css. Змінюєш колір там — міняється
// і в мініиграх, без правок у коді.
const THEME = (() => {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    accent:     v('--accent',      '#ffd93d'),
    accentHi:   v('--accent-hi',   '#ffe873'),
    accentDeep: v('--accent-deep', '#e6b800'),
    accentRgb:  v('--accent-rgb',  '255, 217, 61'),
    danger:     v('--danger',      '#ff453a'),
    text:       v('--text',        '#f2f2f4'),
    onAccent:   v('--on-accent',   '#0a0a0c'),
  };
})();
// Акцент із заданою прозорістю — для canvas-обведень і світінь
const accentA = (alpha) => 'rgba(' + THEME.accentRgb + ', ' + alpha + ')';

let state = { joinCmd: '!призи', accepting: false, participants: [], count: 0, game: null };

const STICKERS = [
  '🍎','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥝','🍍','🥥','🍐','🍈',
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸',
  '🐵','🐔','🐧','🐦','🦄','🐝','🦋','🐢','🐙','🦀','🐳','🐬','🦓','🦒'
];

// ── Cash Hunt: мішені тиру (нарізані зі згенерованого спрайтшита) ──
// Якщо файла мішені немає, <img onerror> підставляє emoji-фолбек зі STICKERS.
const TARGETS = Array.from({ length: 16 }, (_, i) =>
  '/assets/targets/t' + String(i + 1).padStart(2, '0') + '.png');

// ── Звуки Cash Hunt (згенеровано ElevenLabs) ─────────────────────
const SFX = {};
for (const name of ['cannon', 'shuffle', 'win', 'rev-spin', 'rev-shot', 'rev-load', 'pubg-shot', 'pubg-down', 'pubg-heal']) {
  const a = new Audio('/assets/sfx/' + name + '.mp3');
  a.preload = 'auto';
  SFX[name] = a;
}
function playSfx(name, volume, rate, maxMs) {
  const base = SFX[name];
  if (!base) return;
  const a = base.cloneNode();       // клон — щоб постріли могли накладатись
  a.volume = volume == null ? 0.8 : volume;
  if (rate) a.playbackRate = rate;  // розтягнути/стиснути під тривалість анімації
  a.play().catch(() => {});          // автоплей могли заблокувати — не падаємо
  // Обрізати довгий хвіст (швидкі повтори інакше накладаються в кашу):
  // за maxMs — 60мс fade і стоп
  if (maxMs) {
    setTimeout(() => {
      const v0 = a.volume;
      const t0 = performance.now();
      const fade = setInterval(() => {
        const k = 1 - (performance.now() - t0) / 60;
        if (k <= 0) { clearInterval(fade); a.pause(); a.src = ''; }
        else a.volume = Math.max(0, v0 * k);
      }, 10);
    }, maxMs);
  }
}

// ── Пушка Cash Hunt ──────────────────────────────────────────────
// Кут від дула до центру клітинки; 0° = вертикально вгору.
function cannonAngleTo(cellEl) {
  const barrel = document.getElementById('cannon-barrel');
  const b = barrel.getBoundingClientRect();
  const c = cellEl.getBoundingClientRect();
  const dx = (c.left + c.width / 2) - (b.left + b.width / 2);
  const dy = (c.top + c.height / 2) - (b.top + b.height);   // база ствола
  return { deg: Math.atan2(dx, -dy) * 180 / Math.PI, dist: Math.hypot(dx, dy) };
}
/* живий супровід прицілу гарматою під час вибору: кут до точки курсора
   від осі ствола (та сама геометрія, що cannonAngleTo, але без клітинки) */
function aimCannonAtPoint(cx, cy) {
  const cannon = document.getElementById('cannon');
  const barrel = document.getElementById('cannon-barrel');
  if (!cannon || !barrel) return;
  const b = barrel.getBoundingClientRect();
  const dx = cx - (b.left + b.width / 2);
  const dy = cy - (b.top + b.height);
  cannon.style.setProperty('--aim', (Math.atan2(dx, -dy) * 180 / Math.PI).toFixed(2) + 'deg');
}
function aimCannonAt(cellEl, showLaser) {
  const cannon = document.getElementById('cannon');
  const { deg, dist } = cannonAngleTo(cellEl);
  cannon.style.setProperty('--aim', deg.toFixed(2) + 'deg');
  cannon.style.setProperty('--laser-len', Math.max(0, dist - 40).toFixed(0) + 'px');
  cannon.classList.toggle('aiming', !!showLaser);
}
function restCannon() {
  const cannon = document.getElementById('cannon');
  cannon.classList.remove('aiming');
  cannon.style.setProperty('--aim', '0deg');
}
// Прицілитись і вистрілити в клітинку; резолвиться в момент влучання
async function fireCannonAt(cellEl) {
  const cannon = document.getElementById('cannon');
  aimCannonAt(cellEl, true);
  await sleep(420);                          // глядач бачить довороти ствола
  cannon.classList.add('firing');
  /* лише постріл: у cannon.mp3 ~2с (постріл + вибух-влучання) —
     обрізаємо хвіст із фейдом, звук попадання прибрано */
  playSfx('cannon', 1, 1, 500);
  await sleep(110);                          // снаряд «долітає»
  cellEl.classList.add('hit');
  cannon.classList.remove('firing');
  cannon.classList.remove('aiming');
}

let checkTimerInterval = null;
let currentGame = null;     
let selected = new Set();   
let phase = 'idle';         
let winnersHistory = [];    

// ── Ініціалізація кастомного чату (SSE) ─────────────
const chatBox = document.getElementById('chat-box');
let msgCount = 0;

// Розпарсити [emote:ID:NAME] у повідомленнях Kick і вивести як <img>
// Рендеримо значки Kick (модератор, OG, підписник тощо)
function renderBadges(badges) {
  if (!badges || !badges.length) return '';
  return badges.map(b => {
    const url = b.badge_image?.src || b.src || '';
    const label = b.text || b.type || '';
    if (!url) return '';
    return '<img class="kick-badge" src="' + escapeAttr(url) + '" alt="' + escapeAttr(label) + '" title="' + escapeAttr(label) + '">';
  }).join('');
}

// Додаємо повідомлення в боковий чат оверлею ЧАТ
function appendChatgameChatMsg(username, content, color, badges) {
  const box = document.getElementById('chatgame-chat-box');
  if (!box) return;
  const empty = box.querySelector('.empty-box');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = renderBadges(badges || []) + '<b style="color:' + escapeHtml(color) + '">' + escapeHtml(username) + '</b>: <span>' + parseChatContent(content) + '</span>';
  /* той самий якір скролу, що й у головному чаті */
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(el);
  if (box.children.length > 200) {
    const first = box.firstElementChild;   // не текстовий вузол розмітки
    if (first) {
      const h = first.getBoundingClientRect().height;
      box.removeChild(first);
      if (!atBottom) box.scrollTop -= h;
    }
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function parseChatContent(content) {
  const re = /\[emote:(\d+):([^\]]+)\]/g;
  let result = '';
  let lastIndex = 0;
  let m;
  while ((m = re.exec(content)) !== null) {
    result += escapeHtml(content.slice(lastIndex, m.index));
    const id = m[1], name = m[2];
    result += '<img class="chat-emote" src="https://files.kick.com/emotes/' + id + '/fullsize" alt="' + escapeAttr(name) + '" title="' + escapeAttr(name) + '" loading="lazy">';
    lastIndex = re.lastIndex;
  }
  result += escapeHtml(content.slice(lastIndex));
  return result;
}

const chatEvtSource = new EventSource('/api/chat/stream');
chatEvtSource.onmessage = (e) => {
  const parsed = JSON.parse(e.data);

  // Пуш від сервера: переможець відповів — оновлюємо одразу без polling
  if (parsed.type === 'winner_reply') {
    const { name, message } = parsed;
    const w = winnersHistory.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (w && w.status === 'pending') {
      w.status = 'ok';
      w.message = message;
      renderWinners();
      updateAnnounceMsg(name, message);
    }
    return;
  }

  const { username, content, color, badges = [] } = parsed;
  
  const empty = chatBox.querySelector('.empty-box');
  if (empty) empty.remove();

  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg';
  msgEl.innerHTML = renderBadges(badges) + '<b style="color: ' + escapeHtml(color) + '">' + escapeHtml(username) + '</b>: <span>' + parseChatContent(content) + '</span>';

  /* якір скролу: автопрокрутка вниз ЛИШЕ якщо читач і так був унизу;
     якщо він проскролив історію вгору — тримаємо його на тому ж місці */
  const atBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 40;
  chatBox.appendChild(msgEl);
  msgCount++;

  if (chatBox.children.length > 150) {
    /* firstElementChild, НЕ firstChild: перший вузол може бути текстовим
       (пробіли розмітки) — у нього нема getBoundingClientRect */
    const first = chatBox.firstElementChild;
    if (first) {
      const h = first.getBoundingClientRect().height;
      chatBox.removeChild(first);
      if (!atBottom) chatBox.scrollTop -= h;   // компенсуємо зріз історії зверху
    }
  }
  if (atBottom) chatBox.scrollTop = chatBox.scrollHeight;

  // В режиме ЧАТ — добавляем в панель переможця И в боковой чат оверлея
  if (gameMode === 'chatgame') {
    handleChatgameMessage(username, content);
    appendChatgameChatMsg(username, content, color, badges);
  }
  // В режиме БАТЛ РОЯЛЬ — занимаем клетку по координате
  if (gameMode === 'royale') {
    royHandleMessage(username, content);
  }
};

async function loadState() {
  const res = await fetch('/api/raffle/state');
  if (res.status === 401) { location.reload(); return; }
  state = await res.json();

  const cmdInput = document.getElementById('raffle-cmd');
  if (document.activeElement !== cmdInput) {
    cmdInput.value = state.joinCmd || '';
  }
  raffleOpen = state.accepting;

  document.getElementById('participants-count-title').textContent = state.count;
  document.getElementById('conn-dot').className = 'dot ' + (state.accepting ? 'open' : 'closed');

  const regBtn = document.getElementById('btn-reg-toggle');
  if (raffleOpen) {
    regBtn.textContent = '⏹ Остановить регистрацию';
    regBtn.className = 'btn-red';
    cmdInput.disabled = true;
  } else {
    regBtn.textContent = '▶ Начать регистрацию';
    regBtn.className = 'btn-green';
    cmdInput.disabled = false;
  }

  // Відновлюємо переможців з сервера (лише при першому завантаженні)
  if (winnersHistory.length === 0 && Array.isArray(state.savedWinners) && state.savedWinners.length > 0) {
    winnersHistory = state.savedWinners;
    renderWinners();
  }
  if (chatgameWinners.length === 0 && Array.isArray(state.savedChatgameWinners) && state.savedChatgameWinners.length > 0) {
    chatgameWinners = state.savedChatgameWinners;
    renderChatgameWinners();
  }

  if (phase === 'idle') renderParticipants(state.participants);
}

function renderParticipants(list) {
  const box = document.getElementById('main-box');
  if (!list.length) {
    box.innerHTML = '<div class="empty-box">Ожидание регистрации...</div>';
    return;
  }
  /* нові учасники ЗВЕРХУ (номер лишається порядком реєстрації) —
     стрімеру видно свіжі заходи без прокрутки вниз */
  box.innerHTML = '<div class="participants-grid" id="plist-grid">' +
    list.map((name, i) =>
      '<div class="participant-row"><span class="p-num">' + (i+1) + '</span><span>' + escapeHtml(name) + '</span></div>'
    ).reverse().join('') + '</div>';
}

function downloadCSV() {
  window.location.href = '/api/raffle/csv';
}

let raffleOpen = false;

async function saveRaffleCmd() {
  const cmd = document.getElementById('raffle-cmd').value.trim();
  if (!cmd) return false;
  const res = await fetch('/api/raffle/setcmd', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd })
  });
  const el = document.getElementById('saved-msg');
  el.style.color = res.ok ? 'var(--accent)' : 'var(--danger)';
  el.textContent = res.ok ? '✓ сохранено' : '✗ ошибка';
  setTimeout(() => el.textContent = '', 2000);
  return res.ok;
}

async function toggleRegistration() {
  if (!raffleOpen) {
    const cmd = document.getElementById('raffle-cmd').value.trim();
    if (!cmd) {
      const el = document.getElementById('saved-msg');
      el.style.color = '#ff4444';
      el.textContent = '✗ введите слово';
      setTimeout(() => el.textContent = '', 2000);
      return;
    }
    const ok = await saveRaffleCmd();
    if (!ok) return;
  }
  await fetch('/api/raffle/toggle', { method: 'POST' });
  await loadState();
}

async function resetRaffle() {
  if (!confirm('Сбросить список участников и победителей?')) return;
  await fetch('/api/raffle/reset', { method: 'POST' });
  winnersHistory = [];
  renderWinners();
  saveWinnersToServer();
  closeAnnounce();
  resetGameUI();
  loadState();
}

async function addTestPlayer() {
  const input = document.getElementById('test-name');
  const name = input.value.trim();
  if (!name) return;
  const res = await fetch('/api/raffle/addtest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  const el = document.getElementById('test-msg');
  if (res.ok && !data.error) {
    el.style.color = 'var(--accent)';
    el.textContent = '✓ добавлен (' + data.count + ')';
    input.value = '';
  } else {
    el.style.color = '#ff4444';
    el.textContent = '✗ ' + (data.error || 'ошибка');
  }
  setTimeout(() => el.textContent = '', 2000);
  loadState();
}

async function addBulkTest() {
  const res = await fetch('/api/raffle/addbulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 10 })
  });
  const data = await res.json();
  const el = document.getElementById('test-msg');
  if (res.ok) {
    el.style.color = 'var(--accent)';
    el.textContent = '✓ добавлено ' + data.added + ' (всего: ' + data.count + ')';
  } else {
    el.style.color = '#ff4444';
    el.textContent = '✗ ошибка';
  }
  setTimeout(() => el.textContent = '', 2500);
  loadState();
}

async function uploadCSVParticipants(input) {
  const file = input.files[0];
  if (!file) return;
  const el = document.getElementById('test-msg');
  el.style.color = '#aaa';
  el.textContent = 'Загрузка...';

  const text = await file.text();
  // Парсимо CSV: беремо перший стовпець кожного рядка, ігноруємо заголовок якщо є
  const lines = text.split('\n');
  const names = [];
  for (let li = 0; li < lines.length; li++) {
    let cell = lines[li].split(',')[0].trim();
    if (cell.length > 1 && cell[0] === cell[cell.length-1] && (cell[0] === '"' || cell[0] === "'")) {
      cell = cell.slice(1, -1).trim();
    }
    const low = cell.toLowerCase();
    if (cell && low !== 'name' && low !== 'username' && low !== 'nick') {
      names.push(cell);
    }
  }
    if (!names.length) {
    el.style.color = '#ff4444';
    el.textContent = '✗ порожній файл';
    input.value = '';
    return;
  }

  const res = await fetch('/api/raffle/addcsv', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names })
  });
  const data = await res.json();
  if (res.ok) {
    el.style.color = 'var(--accent)';
    el.textContent = '✓ добавлено ' + data.added + ' (всего: ' + data.count + ')';
  } else {
    el.style.color = '#ff4444';
    el.textContent = '✗ ' + (data.error || 'ошибка');
  }
  setTimeout(() => el.textContent = '', 3000);
  input.value = '';
  loadState();
}

let gameMode = 'roulette';
let raceQualifiers = [];
let raceAnimId = null;

// Список режимів для каруселі (порядок = порядок перемикання стрілками)
const GAME_MODES = [
  { id: 'roulette', icon: '🎰', label: 'Дефолт' },
  { id: 'revolver', icon: '🔫', label: 'Револьвер' },
  { id: 'cashhunt', icon: '🎯', label: 'Cash Hunt' },
  { id: 'royale',   icon: '🪂', label: 'Батл Рояль' },
  { id: 'chatgame', icon: '💬', label: 'Бонусбуря с чатом' },
  /* «Гонка» тимчасово прихована з перемикача (код гри лишився цілим —
     щоб повернути, просто розкоментуй рядок) */
  // { id: 'race',     icon: '🏎️', label: 'Гонка' },
];

// Перемикання режиму стрілками (з циклічним переходом)
function cycleGameMode(dir) {
  const idx = GAME_MODES.findIndex(m => m.id === gameMode);
  const next = (idx + dir + GAME_MODES.length) % GAME_MODES.length;
  setGameMode(GAME_MODES[next].id);
}

// Пресети часу на відповідь (стрілки перемикають між ними, без зациклення)
// 0 — окремий пресет: підтвердження не потрібне, переможець одразу вважається готовим
const CONFIRM_PRESETS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600];
function fmtConfirmSec(s) {
  if (s === 0) return '-';
  if (s < 60) return s + ' сек';
  if (s % 60 === 0) return (s / 60) + ' мин';
  return Math.floor(s / 60) + 'м ' + (s % 60) + 'с';
}
function setConfirmSecondsValue(val) {
  const inp = document.getElementById('confirm-seconds');
  if (inp) inp.value = val;
  const disp = document.getElementById('confirm-display');
  if (disp) disp.textContent = fmtConfirmSec(val);
}
// Безпечний парсинг: parseInt(...) || 60 неправильно трактує 0 як falsy — тут 0 зберігається коректно
function getConfirmSeconds() {
  const raw = document.getElementById('confirm-seconds').value;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 60;
}
function adjustConfirmSeconds(dir) {
  const inp = document.getElementById('confirm-seconds');
  if (!inp) return;
  const cur = getConfirmSeconds();
  let idx = CONFIRM_PRESETS.indexOf(cur);
  if (idx === -1) { // поточне значення не з пресетів — беремо найближчий
    let bd = 1e9;
    for (let k = 0; k < CONFIRM_PRESETS.length; k++) {
      const d = Math.abs(CONFIRM_PRESETS[k] - cur);
      if (d < bd) { bd = d; idx = k; }
    }
  }
  idx = Math.max(0, Math.min(CONFIRM_PRESETS.length - 1, idx + dir));
  const val = CONFIRM_PRESETS[idx];
  setConfirmSecondsValue(val);
}

function setGameMode(mode) {
  // Примусово закриваємо всі оверлеї та скидаємо стан перед перемиканням режиму
  hideRaceOverlay();
  hideRouletteOverlay();
  closeRevolverOverlay();
  closeChatgameOverlay();
  closeCashhuntOverlay();
  // Рояль живе в royale.js, який вантажиться ПІСЛЯ app.js — на момент
  // top-level ініціалізації (setGameMode('roulette') внизу файла) функції ще немає
  if (typeof closeRoyaleOverlay === 'function') closeRoyaleOverlay();
  phase = 'idle';

  gameMode = mode;
  // оновлюємо центральну плитку каруселі
  const _m = GAME_MODES.find(x => x.id === mode) || GAME_MODES[0];
  const _cur = document.getElementById('mode-current');
  if (_cur) _cur.innerHTML = '<span class="mc-icon">' + _m.icon + '</span><span class="mc-label">' + _m.label + '</span>' + (_m.beta ? '<span class="mc-beta">бета</span>' : '');
  document.getElementById('race-count-field').style.display = mode === 'race' ? 'block' : 'none';
  document.querySelector('#winners-count').closest('.field').style.display = 'none';   // Cash Hunt — завжди один переможець
}

function hideRaceOverlay() {
  if (raceAnimId) { cancelAnimationFrame(raceAnimId); raceAnimId = null; }
  document.getElementById('race-overlay').classList.remove('visible');
  document.getElementById('race-overlay-controls').style.display = 'none';
  document.getElementById('race-track-area').innerHTML =
    '<button class="race-close-btn" onclick="closeRaceOverlay()">✕</button>' +
    '<div id="race-standings"></div>';
}

function hideRouletteOverlay() {
  if (rouletteTimeout) { clearTimeout(rouletteTimeout); rouletteTimeout = null; }
  document.getElementById('roulette-overlay').classList.remove('visible');
  document.getElementById('roulette-overlay-controls').style.display = 'none';
  document.getElementById('roulette-strip').innerHTML = '';
  document.getElementById('roulette-strip').style.transition = 'none';
  document.getElementById('roulette-strip').style.transform = 'translateX(0)';
}

function resetGameUI() {
  currentGame = null;
  selected = new Set();
  phase = 'idle';
  raceQualifiers = [];
  hideRaceOverlay();
  hideRouletteOverlay();
  /* selecting-mode ховає системний курсор (cursor:none) — знімаємо разом
     з оверлеєм, інакше клас доживає до наступної гри і курсор зникає */
  document.getElementById('cashhunt-overlay').classList.remove('visible', 'selecting-mode');
  document.getElementById('cashhunt-grid').innerHTML = '';
  document.getElementById('game-controls').style.display = 'none';
  document.getElementById('hint').textContent = '';
  const _prog = document.getElementById('progress'); if(_prog) _prog.textContent = '';
  document.getElementById('main-box').className = 'box';
  // Скидаємо таймери щоб не було багів при реролі
  if (typeof announceTimer !== 'undefined' && announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  if (typeof checkTimerInterval !== 'undefined' && checkTimerInterval) { clearInterval(checkTimerInterval); checkTimerInterval = null; }
  renderParticipants(state.participants || []);
}

async function startGame() {
  if (gameMode === 'race') return startRaceGame();
  if (gameMode === 'roulette') return startRoulette();
  if (gameMode === 'revolver') return startRevolverGame();
  if (gameMode === 'chatgame') return startChatgame();
  if (gameMode === 'royale') return startRoyale();

  const n = 1;   // Cash Hunt: завжди один переможець
  const res = await fetch('/api/raffle/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winners: n })
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Ошибка');
  if (!data.game || !Array.isArray(data.game.cells) || !data.game.cells.length) {
    return alert('Сервер не вернул игру — нет участников?');
  }
  renderGame(data.game);
}

async function reroll() {
  if (gameMode === 'race') {
    // В гонці ліміт до 300
    const n = raceQualifiers.length || Math.min(parseInt(document.getElementById('race-count').value) || 10, 300);
    const count = Math.min(n, state.participants.length);
    raceQualifiers = pickRandom(state.participants, count);
    return runRace(raceQualifiers, true);
  }
  if (gameMode === 'roulette') {
    return startRoulette();
  }

  const res = await fetch('/api/raffle/reroll', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Ошибка');
  if (!data.game || !Array.isArray(data.game.cells) || !data.game.cells.length) {
    return alert('Сервер не вернул игру — нет участников?');
  }
  renderGame(data.game);
}

// Швидкий рерол рулетки — те саме, але з коротким прокручуванням
function fastReroll() {
  return startRoulette(true);
}


function resetGameUIKeepMode() {
  selected = new Set();
  phase = 'idle';
  raceQualifiers = [];
  hideRaceOverlay();
  hideRouletteOverlay();
  /* selecting-mode ховає системний курсор (cursor:none) — знімаємо разом
     з оверлеєм, інакше клас доживає до наступної гри і курсор зникає */
  document.getElementById('cashhunt-overlay').classList.remove('visible', 'selecting-mode');
  document.getElementById('cashhunt-grid').innerHTML = '';
  document.getElementById('game-controls').style.display = 'none';
  document.getElementById('hint').textContent = '';
  const _prog = document.getElementById('progress'); if(_prog) _prog.textContent = '';
  document.getElementById('main-box').className = 'box';
  renderParticipants(state.participants || []);
}

let rouletteTimeout = null;

async function startRoulette(fast) {
  if (!state.participants.length) return alert('Нет участников');

  // Виключаємо тих, хто вже випадав (у списку переможців) — повторно випасти не можуть.
  // Знову доступними стають лише після скидання розіграшу та нової реєстрації.
  const drawnNames = new Set(winnersHistory.map(w => String(w.name).toLowerCase()));
  const eligible = state.participants.filter(p => !drawnNames.has(String(p).toLowerCase()));
  if (!eligible.length) return alert('Все участники уже выпадали. Сбросьте розыгрыш и проведите новую регистрацию.');

  phase = 'racing';

  const overlay = document.getElementById('roulette-overlay');
  const overlayHint = document.getElementById('roulette-overlay-hint');
  const controls = document.getElementById('roulette-overlay-controls');
  const strip = document.getElementById('roulette-strip');

  overlay.classList.add('visible');
  controls.style.display = 'none';
  overlayHint.textContent = 'Крутим барабан...';

  const winner = eligible[await rollInt(eligible.length)];   // ролл через random.org

  const STRIP_LEN = 60;
  const WINNER_IDX = 52;
  const items = [];
  for (let i = 0; i < STRIP_LEN; i++) {
    items.push(i === WINNER_IDX ? winner : state.participants[Math.floor(Math.random() * state.participants.length)]);
  }

  strip.style.transition = 'none';
  strip.style.transform = 'translateX(0)';
  strip.innerHTML = items.map((name, i) =>
    '<div class="roulette-cell" data-idx="' + i + '">' + escapeHtml(name) + '</div>'
  ).join('');

  void strip.offsetWidth;

  const cellWidth = 200;
  const trackWidth = document.getElementById('roulette-track').clientWidth;
  const targetOffset = WINNER_IDX * cellWidth + cellWidth/2 - trackWidth/2;

  await sleep(50);

  const spinDur = fast ? 0.9 : 4.6; // «фаст рерол» — швидке прокручування
  strip.style.transition = 'transform ' + spinDur + 's cubic-bezier(0.12, 0.7, 0.15, 1)';
  strip.style.transform = 'translateX(-' + targetOffset + 'px)';

  await new Promise(resolve => {
    rouletteTimeout = setTimeout(resolve, fast ? 1000 : 4700);
  });
  rouletteTimeout = null;

  const winnerCell = strip.querySelector('[data-idx="' + WINNER_IDX + '"]');
  if (winnerCell) winnerCell.classList.add('win');

  overlayHint.innerHTML = '🎉 Победитель: <b style="color:var(--kick);">' + escapeHtml(winner) + '</b>';
  controls.style.display = 'flex';
  phase = 'done';

  addWinner(winner);
}

function closeRouletteOverlay() {
  resetGameUI();
}

// ── Ролл через random.org ─────────────────────────────────────
// Джерело справжньої випадковості (атмосферний шум) — щоб розіграш був
// чесним і перевірюваним. Ходимо через власний сервер: у random.org немає
// CORS-заголовків, а сервер ще й тримає фолбек на crypto при збоях мережі.
let lastRollSource = 'crypto';   // показуємо глядачам на екрані переможця
let lastRollProof = null;        // {url, serial} — сторінка перевірки random.org
async function rollInts(count, max) {
  if (max <= 1) { lastRollSource = 'crypto'; return new Array(count).fill(0); }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch('/api/random/ints?n=' + count + '&max=' + max, { signal: ctl.signal });
    clearTimeout(t);
    const d = await res.json();
    if (Array.isArray(d.ints) && d.ints.length === count) {
      lastRollSource = d.source || 'random.org';
      lastRollProof = d.proof || null;
      return d.ints;
    }
  } catch (e) { /* мережа/сервер лягли — тихо на локальний крипто-рандом */ }
  lastRollSource = 'crypto';
  lastRollProof = null;
  return Array.from({ length: count }, () => secureRandomInt(max));
}
// один випадковий індекс [0, max)
async function rollInt(max) { return (await rollInts(1, max))[0]; }
// n унікальних елементів списку — перемішування на числах random.org
async function rollPick(arr, n) {
  const a = [...arr];
  if (a.length < 2) { lastRollSource = 'crypto'; return a.slice(0, n); }
  const pool = await rollInts(a.length - 1, 1000000);
  for (let i = a.length - 1, k = 0; i > 0; i--, k++) {
    const j = pool[k] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/* Підпис під ніком переможця: чим саме розіграно. Якщо ролл підписаний
   ключем Signed API — підпис стає КНОПКОЮ на офіційну сторінку random.org,
   де глядач сам перевіряє автентичність числа (серійний номер, час, підпис). */
function renderRollSource() {
  const el = document.getElementById('wa-source');
  if (!el) return;
  const proof = lastRollProof && lastRollProof.url ? lastRollProof : null;
  if (proof) {
    el.textContent = '🎲 проверить на random.org' + (proof.serial ? ' #' + proof.serial : '');
    el.href = proof.url;
    el.classList.add('is-link');
  } else {
    el.textContent = lastRollSource === 'random.org' ? '🎲 random.org' : '🎲 crypto';
    el.removeAttribute('href');
    el.classList.remove('is-link');
  }
}

// Криптографічно стійкий випадковий цілий [0, max) — без зміщення (rejection sampling)
function secureRandomInt(max) {
  if (max <= 0) return 0;
  const limit = Math.floor(0xFFFFFFFF / max) * max;
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

// Перемішування Фішера-Йейтса на крипто-рандомі
function secureShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr, n) {
  // Чесний вибір n унікальних елементів через крипто-перемішування
  return secureShuffle(arr).slice(0, n);
}

async function startRaceGame() {
  const n = Math.min(Math.max(parseInt(document.getElementById('race-count').value) || 10, 2), 300);
  const laps = Math.min(Math.max(parseInt(document.getElementById('race-laps').value) || 3, 1), 20);
  if (state.participants.length < 2) return alert('Нужно минимум 2 участника');
  const count = Math.min(n, state.participants.length);
  raceQualifiers = pickRandom(state.participants, count);
  await runRace(raceQualifiers, laps);
}

const TRACK_POINTS_2D = [
  [60, 70], [0, 70], [-80, 70], [-120, 70], [-145, 60], [-155, 45],
  [-165, 25], [-185, 0], [-170, -50], [-130, -45], [-80, -40], [-50, -40],
  [-40, -35], [-40, -15], [-55, -5], [-75, 0], [-85, 15], [-80, 30],
  [-60, 35], [-30, 35], [-10, 20], [10, -10], [30, -45], [45, -40],
  [70.5, -4.5], [110.5, 27.5], [118.5, 19.5], [102.5, -4.5], [78.5, -28.5], [94.5, -44.5],
  [120, -45], [135, -35], [145, -25], [135, 0], [150, 35], [145, 65],
  [140, 70], [110, 70],
];

const ROAD_RADIUS = 7.5;  

let renderer3D = null, scene3D = null, camera3D = null, orbitControls3D = null;
let raceKeyHandler = null, raceMouseHandler = null, raceCtxHandler = null;

function disposeRace3D() {
  if (raceKeyHandler) { window.removeEventListener('keydown', raceKeyHandler); raceKeyHandler = null; }
  if (raceMouseHandler) { window.removeEventListener('mousedown', raceMouseHandler); raceMouseHandler = null; }
  if (raceCtxHandler) { window.removeEventListener('contextmenu', raceCtxHandler); raceCtxHandler = null; }

  if (orbitControls3D) {
    try { orbitControls3D.dispose(); } catch (e) {}
    orbitControls3D = null;
  }
  if (renderer3D) {
    try {
      renderer3D.dispose();
      if (renderer3D.domElement && renderer3D.domElement.parentNode) {
        renderer3D.domElement.parentNode.removeChild(renderer3D.domElement);
      }
    } catch (e) {}
    renderer3D = null;
  }
  if (scene3D) {
    scene3D.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose && obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => {
          if (m.map) m.map.dispose && m.map.dispose();
          m.dispose && m.dispose();
        });
      }
    });
  }
  scene3D = null;
  camera3D = null;
}

function buildTrackCurve3() {
  let cx = 0, cz = 0;
  TRACK_POINTS_2D.forEach(([x, z]) => { cx += x; cz += z; });
  cx /= TRACK_POINTS_2D.length;
  cz /= TRACK_POINTS_2D.length;
  const points = TRACK_POINTS_2D.map(([x, z]) => new THREE.Vector3(x - cx, 0, z - cz));
  return new THREE.CatmullRomCurve3(points, true); 
}

function makeCanvasTexture(draw, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildTrack3D(scene, curve) {
  const finishTex = makeCanvasTexture((ctx, w, h) => {
    const cell = 32;
    for (let y = 0; y < h; y += cell) {
      for (let x = 0; x < w; x += cell) {
        ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? '#fff' : '#111';
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }, 64, 64);
  finishTex.repeat.set(6, 1);

  const edgeGeo = new THREE.TubeGeometry(curve, 400, ROAD_RADIUS + 0.5, 16, true);
  edgeGeo.scale(1, 0.03, 1);
  const edgeMesh = new THREE.Mesh(edgeGeo, new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.8 }));
  edgeMesh.position.y = 0.05;
  scene.add(edgeMesh);

  const roadGeo = new THREE.TubeGeometry(curve, 400, ROAD_RADIUS, 16, true);
  roadGeo.scale(1, 0.04, 1);
  const roadMesh = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.9 }));
  roadMesh.position.y = 0.1;
  scene.add(roadMesh);

  // ── Фінішна лінія: горизонтальний банер над трасою + два стовпи ──
  const UP = new THREE.Vector3(0, 1, 0);
  const m0 = curve.getPointAt(0);
  const t0 = curve.getTangentAt(0);
  const right0 = new THREE.Vector3().crossVectors(t0, UP).normalize();
  const BANNER_H = 12;   // висота стовпів
  const BANNER_W = ROAD_RADIUS * 2 + 2;  // ширина банера = ширина дороги

  // Горизонтальна площина (шахматка) на землі — для видимості знизу
  const flatFinish = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_RADIUS * 2, 2.5),
    new THREE.MeshStandardMaterial({ map: finishTex })
  );
  flatFinish.rotation.x = -Math.PI / 2;
  flatFinish.rotation.y = Math.atan2(right0.x, right0.z);
  flatFinish.position.set(m0.x, 0.55, m0.z);
  scene.add(flatFinish);

  // Вертикальний банер (шахматка видна з кута)
  const bannerTex2 = makeCanvasTexture((ctx, w, h) => {
    const cell = 16;
    for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
      ctx.fillStyle = ((x/cell + y/cell) % 2 === 0) ? '#fff' : '#111';
      ctx.fillRect(x, y, cell, cell);
    }
  }, 64, 32);
  bannerTex2.repeat.set(6, 1);

  const bannerMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(BANNER_W, 3.5),
    new THREE.MeshStandardMaterial({ map: bannerTex2, side: THREE.DoubleSide })
  );
  bannerMesh.position.set(m0.x, BANNER_H, m0.z);
  bannerMesh.lookAt(m0.x + t0.x, BANNER_H, m0.z + t0.z);
  scene.add(bannerMesh);

  // Два стовпи
  const poleGeo = new THREE.CylinderGeometry(0.25, 0.25, BANNER_H, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.7, roughness: 0.3 });
  [-1, 1].forEach(side => {
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.copy(m0).addScaledVector(right0, side * (BANNER_W / 2));
    pole.position.y = BANNER_H / 2;
    scene.add(pole);
  });
}

let CAR_GEO = null;
function getCarGeometries() {
  if (CAR_GEO) return CAR_GEO;
  CAR_GEO = {
    floor: new THREE.BoxGeometry(3.6, 0.1, 8.5),
    chassis: new THREE.CylinderGeometry(0.8, 1.2, 5.0, 16),
    nose: new THREE.CylinderGeometry(0.3, 0.8, 4.0, 16),
    noseTip: new THREE.SphereGeometry(0.3, 10, 10),
    sidepods: new THREE.CylinderGeometry(1.8, 1.4, 4.0, 16),
    intake: new THREE.BoxGeometry(3.2, 0.8, 0.2),
    airbox: new THREE.CylinderGeometry(0.2, 0.8, 3.0, 12),
    airboxHole: new THREE.CylinderGeometry(0.15, 0.2, 0.2, 12),
    halo: new THREE.TorusGeometry(0.65, 0.08, 8, 20, Math.PI),
    haloStrut: new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6),
    fwMain: new THREE.BoxGeometry(5.0, 0.1, 1.2),
    fwUpper: new THREE.BoxGeometry(4.8, 0.05, 0.8),
    fwEnd: new THREE.BoxGeometry(0.1, 0.8, 1.5),
    rwPillar: new THREE.BoxGeometry(0.2, 1.8, 0.6),
    rwMain: new THREE.BoxGeometry(3.5, 0.1, 1.0),
    rwUpper: new THREE.BoxGeometry(3.5, 0.1, 0.6),
    rwEnd: new THREE.BoxGeometry(0.1, 1.6, 1.2),
    wheel: new THREE.CylinderGeometry(1.1, 1.1, 1.2, 16),
    rim: new THREE.CylinderGeometry(0.65, 0.65, 1.25, 16),
    susp: new THREE.CylinderGeometry(0.06, 0.06, 2.0, 6),
  };
  return CAR_GEO;
}

function makeF1Car(teamColorHex) {
  const G = getCarGeometries();
  const group = new THREE.Group();
  const carBody = new THREE.Group();

  const paintMat = new THREE.MeshStandardMaterial({ color: teamColorHex, metalness: 0.8, roughness: 0.2 });
  const carbonMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.4, roughness: 0.8 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.9, roughness: 0.2 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0f0f0f, metalness: 0.1, roughness: 0.9 });

  const floor = new THREE.Mesh(G.floor, carbonMat);
  floor.position.set(0, 0.2, -0.5); carBody.add(floor);

  const chassis = new THREE.Mesh(G.chassis, paintMat);
  chassis.rotation.x = Math.PI / 2; chassis.position.set(0, 0.8, -1.0); carBody.add(chassis);

  const nose = new THREE.Mesh(G.nose, paintMat);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.55, 3.5); carBody.add(nose);
  const noseTip = new THREE.Mesh(G.noseTip, paintMat);
  noseTip.position.set(0, 0.55, 5.5); carBody.add(noseTip);

  const sidepods = new THREE.Mesh(G.sidepods, paintMat);
  sidepods.rotation.x = Math.PI / 2; sidepods.position.set(0, 0.7, -1.0); sidepods.scale.set(1, 1, 0.6); carBody.add(sidepods);
  const intake = new THREE.Mesh(G.intake, carbonMat);
  intake.position.set(0, 0.8, 1.0); carBody.add(intake);

  const airbox = new THREE.Mesh(G.airbox, paintMat);
  airbox.position.set(0, 1.6, -2.0); airbox.rotation.x = Math.PI / 6; carBody.add(airbox);
  const airboxHole = new THREE.Mesh(G.airboxHole, carbonMat);
  airboxHole.rotation.x = Math.PI / 2; airboxHole.position.set(0, 2.0, -0.6); carBody.add(airboxHole);

  const halo = new THREE.Mesh(G.halo, carbonMat);
  halo.rotation.x = -Math.PI / 2; halo.rotation.z = Math.PI / 2; halo.position.set(0, 1.5, 0.2); carBody.add(halo);
  const haloStrut = new THREE.Mesh(G.haloStrut, carbonMat);
  haloStrut.position.set(0, 1.2, 0.8); haloStrut.rotation.x = Math.PI / 5; carBody.add(haloStrut);

  const fwMain = new THREE.Mesh(G.fwMain, paintMat);
  fwMain.position.set(0, 0.35, 5.0); carBody.add(fwMain);
  const fwUpper = new THREE.Mesh(G.fwUpper, carbonMat);
  fwUpper.position.set(0, 0.5, 4.8); fwUpper.rotation.x = Math.PI / 12; carBody.add(fwUpper);
  const fwEndL = new THREE.Mesh(G.fwEnd, paintMat); fwEndL.position.set(-2.5, 0.5, 5.0); carBody.add(fwEndL);
  const fwEndR = new THREE.Mesh(G.fwEnd, paintMat); fwEndR.position.set(2.5, 0.5, 5.0); carBody.add(fwEndR);

  const rwPillar = new THREE.Mesh(G.rwPillar, carbonMat);
  rwPillar.position.set(0, 1.0, -4.2); carBody.add(rwPillar);
  const rwMain = new THREE.Mesh(G.rwMain, paintMat);
  rwMain.position.set(0, 1.8, -4.4); rwMain.rotation.x = -Math.PI / 12; carBody.add(rwMain);
  const rwUpper = new THREE.Mesh(G.rwUpper, paintMat);
  rwUpper.position.set(0, 2.2, -4.6); rwUpper.rotation.x = -Math.PI / 6; carBody.add(rwUpper);
  const rwEndL = new THREE.Mesh(G.rwEnd, carbonMat); rwEndL.position.set(-1.75, 1.6, -4.4); carBody.add(rwEndL);
  const rwEndR = new THREE.Mesh(G.rwEnd, carbonMat); rwEndR.position.set(1.75, 1.6, -4.4); carBody.add(rwEndR);

  const wheelPositions = [
    { pos: [-2.4, 1.1, 3.5], isLeft: true }, { pos: [2.4, 1.1, 3.5], isLeft: false },
    { pos: [-2.4, 1.1, -3.0], isLeft: true }, { pos: [2.4, 1.1, -3.0], isLeft: false },
  ];
  wheelPositions.forEach(p => {
    const w = new THREE.Mesh(G.wheel, tireMat); w.rotation.z = Math.PI / 2; w.position.set(...p.pos); carBody.add(w);
    const rim = new THREE.Mesh(G.rim, metalMat); rim.rotation.z = Math.PI / 2; rim.position.set(...p.pos); carBody.add(rim);
    const susp1 = new THREE.Mesh(G.susp, carbonMat); susp1.rotation.z = Math.PI / 2;
    susp1.position.set(p.isLeft ? p.pos[0] + 1.0 : p.pos[0] - 1.0, p.pos[1], p.pos[2]); carBody.add(susp1);
    const susp2 = new THREE.Mesh(G.susp, carbonMat); susp2.rotation.z = Math.PI / 2;
    susp2.rotation.y = Math.PI / 6 * (p.isLeft ? 1 : -1);
    susp2.position.set(p.isLeft ? p.pos[0] + 1.0 : p.pos[0] - 1.0, p.pos[1], p.pos[2]); carBody.add(susp2);
  });

  carBody.rotation.y = 0;
  group.add(carBody);
  group.scale.set(0.45, 0.45, 0.45);
  return group;
}

// 🚜 Трактор для Crystalyne7
function makeTractor(colorHex) {
  const group = new THREE.Group();
  const body = new THREE.Group();

  const paintMat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.8 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const darkMat  = new THREE.MeshStandardMaterial({ color: 0x222200, roughness: 0.9 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.5 });
  const exhaustMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });

  // Основний корпус (довгий)
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 4.5), paintMat);
  chassis.position.set(0, 0.6, 0); body.add(chassis);

  // Капот двигуна (висунутий вперед)
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 2.2), paintMat);
  hood.position.set(0, 0.85, 2.8); body.add(hood);

  // Труба вихлопу (збоку капота)
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.0, 8), exhaustMat);
  exhaust.position.set(0.7, 1.8, 2.2); body.add(exhaust);
  const exhaustTop = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.12, 0.2, 8), exhaustMat);
  exhaustTop.position.set(0.7, 2.85, 2.2); body.add(exhaustTop);

  // Кабіна
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.4, 2.2), paintMat);
  cab.position.set(0, 1.7, -0.6); body.add(cab);

  // Скло кабіни (спереду)
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.85, 1.0, 0.08), glassMat);
  windshield.position.set(0, 1.7, 0.52); body.add(windshield);

  // Скло кабіни (ззаду)
  const rearWindow = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.8, 0.08), glassMat);
  rearWindow.position.set(0, 1.75, -1.71); body.add(rearWindow);

  // Великі задні колеса
  const rearWheelGeo = new THREE.CylinderGeometry(1.05, 1.05, 0.9, 16);
  const rearWheelMat = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 1.0 });
  [[-1.4, 0], [1.4, 0]].forEach(([x]) => {
    const w = new THREE.Mesh(rearWheelGeo, rearWheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.95, -1.4); body.add(w);
    // Обід
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.95, 8), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8 }));
    rim.rotation.z = Math.PI / 2;
    rim.position.set(x, 0.95, -1.4); body.add(rim);
  });

  // Маленькі передні колеса
  const frontWheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.6, 14);
  [[-0.9, 0], [0.9, 0]].forEach(([x]) => {
    const w = new THREE.Mesh(frontWheelGeo, rearWheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.5, 2.8); body.add(w);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.65, 8), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8 }));
    rim.rotation.z = Math.PI / 2;
    rim.position.set(x, 0.5, 2.8); body.add(rim);
  });

  // Відвал/ківш ззаду (бонус)
  const bucket = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.15, 1.0), darkMat);
  bucket.position.set(0, 0.2, -2.8); body.add(bucket);
  const bucketLeft  = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.7, 1.0), darkMat);
  bucketLeft.position.set(-1.1, 0.55, -2.8); body.add(bucketLeft);
  const bucketRight = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.7, 1.0), darkMat);
  bucketRight.position.set(1.1, 0.55, -2.8); body.add(bucketRight);

  body.rotation.y = 0;
  group.add(body);
  group.scale.set(0.65, 0.65, 0.65);
  return group;
}

async function runRace(qualifiers, totalLaps) {
  if (!qualifiers.length) return;
  phase = 'racing';

  const overlay = document.getElementById('race-overlay');
  const area = document.getElementById('race-track-area');
  const overlayHint = document.getElementById('race-overlay-hint');
  const controls = document.getElementById('race-overlay-controls');

  overlay.classList.add('visible');
  controls.style.display = 'none';
  overlayHint.textContent = 'Загрузка трассы...';

  disposeRace3D();
  area.innerHTML =
    '<button class="race-close-btn" onclick="closeRaceOverlay()">✕</button>' +
    '<div id="race-standings"></div>' +
    '<div id="race-labels"></div>' +
    '<div id="race-countdown"></div>' +
    '<div id="race-controls-hint">' +
      '<b>ЛКМ</b> — вращать камеру <br>' +
      '<b>Колесо</b> — масштаб <br>' +
      '<b>CTRL</b> — сменить вид (свободная / за авто) <br>' +
      '<b>ЛКМ / ПКМ</b> (в режиме авто) — смена игрока' +
    '</div>';

  if (!window.THREE) {
    overlayHint.textContent = '3D недоступно (не загрузился Three.js)';
    controls.style.display = 'flex';
    phase = 'done';
    return;
  }

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const n = qualifiers.length;
  const width = area.clientWidth || 800;
  const height = area.clientHeight || 467;

  scene3D = new THREE.Scene();
  scene3D.background = new THREE.Color(0x0a0a0c);

  camera3D = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);

  renderer3D = new THREE.WebGLRenderer({ antialias: true });
  renderer3D.setSize(width, height);
  renderer3D.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  area.insertBefore(renderer3D.domElement, area.firstChild);

  scene3D.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(100, 200, 100);
  scene3D.add(sun);

  const curve = buildTrackCurve3();
  buildTrack3D(scene3D, curve);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  curve.points.forEach(p => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  });
  const margin = ROAD_RADIUS + 2.5;
  const boundRadius = Math.hypot(Math.max(Math.abs(minX), Math.abs(maxX)) + margin, Math.max(Math.abs(minZ), Math.abs(maxZ)) + margin);
  const elevation = 38 * Math.PI / 180;
  const camDist = boundRadius / Math.tan((camera3D.fov / 2) * Math.PI / 180) * 0.425 * 1.3;
  camera3D.position.set(0, camDist * Math.sin(elevation), camDist * Math.cos(elevation));
  camera3D.lookAt(0, 0, 0);
  camera3D.updateProjectionMatrix();
  camera3D.updateMatrixWorld(true);

  if (window.THREE && THREE.OrbitControls) {
    orbitControls3D = new THREE.OrbitControls(camera3D, renderer3D.domElement);
    orbitControls3D.enableDamping = true;
    orbitControls3D.dampingFactor = 0.08;
    orbitControls3D.target.set(0, 0, 0);
    orbitControls3D.maxPolarAngle = Math.PI / 2 - 0.02;
    orbitControls3D.minDistance = camDist * 0.2;
    orbitControls3D.maxDistance = camDist * 2.5;
    orbitControls3D.enablePan = false;
    orbitControls3D.update();
  }

  const laneSpacing = 0.9;
  const cars = [];
  for (let i = 0; i < n; i++) {
    const color = new THREE.Color().setHSL(i / n, 0.8, 0.5);
    // Crystalyne7 їде на тракторі 🚜
    const isTractor = qualifiers[i].toLowerCase() === 'crystalyne7';
    const car = isTractor ? makeTractor(color.getHex()) : makeF1Car(color.getHex());
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.3, 24),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    car.add(ring);
    scene3D.add(car);
    cars.push(car);
  }

  const labelsBox = document.getElementById('race-labels');
  const labelEls = qualifiers.map((name, i) => {
    const el = document.createElement('div');
    el.className = 'car-label-3d';
    const colorHex = '#' + new THREE.Color().setHSL(i / n, 0.8, 0.5).getHexString();
    el.style.setProperty('--car-color', colorHex);
    el.textContent = name;
    labelsBox.appendChild(el);
    return el;
  });

  const UP = new THREE.Vector3(0, 1, 0);

  function positionCars(progressArr) {
    // Щоб при 300+ машинках вони не вилітали за асфальт, обмежуємо смуги
    const maxLanes = 12;
    for (let i = 0; i < n; i++) {
      let u = progressArr[i] % 1;
      if (u < 0) u += 1;
      const p = curve.getPointAt(u);
      const tangent = curve.getTangentAt(u).clone();
      tangent.y = 0;
      tangent.normalize();
      const right = new THREE.Vector3().crossVectors(tangent, UP).normalize();
      
      const laneIndex = i % maxLanes;
      const offset = (laneIndex - (maxLanes - 1) / 2) * laneSpacing;
      
      const pos = p.clone().addScaledVector(right, offset);
      pos.y = 0.55;
      cars[i].position.copy(pos);
      cars[i].lookAt(pos.clone().add(tangent));
    }
  }

  function updateLabels() {
    // Знаходимо лідера (максимальна сумарна дистанція)
    let leaderIdx = 0;
    let leaderDist = -Infinity;
    if (typeof laps !== 'undefined' && typeof progress !== 'undefined') {
      for (let i = 0; i < n; i++) {
        const d = laps[i] + (progress[i] % 1);
        if (d > leaderDist) { leaderDist = d; leaderIdx = i; }
      }
    }

    for (let i = 0; i < n; i++) {
      const v = cars[i].position.clone();
      v.y += 4.5;
      v.project(camera3D);
      if (v.z > 1 || v.z < -1) { labelEls[i].style.display = 'none'; continue; }
      labelEls[i].style.display = '';
      labelEls[i].style.left = ((v.x * 0.5 + 0.5) * width) + 'px';
      labelEls[i].style.top  = ((-v.y * 0.5 + 0.5) * height) + 'px';
      // Лідер завжди поверх інших нікнеймів
      labelEls[i].style.zIndex = (i === leaderIdx) ? '10' : '2';
    }
  }

  const standingsBox = document.getElementById('race-standings');
  const carColors = qualifiers.map((_, i) => '#' + new THREE.Color().setHSL(i / n, 0.8, 0.5).getHexString());

  function renderStandings(progressArr, lapsArr, winnerIdx) {
    const order = qualifiers.map((_, i) => i).sort((a, b) => {
      const totalA = lapsArr[a] + (progressArr[a] % 1);
      const totalB = lapsArr[b] + (progressArr[b] % 1);
      return totalB - totalA;
    });
    // Відображаємо максимум ТОП 10, щоб не засмічувати екран при 300 гравцях
    const top10 = order.slice(0, 10);
    const leadLapDisplay = Math.min(lapsArr[order[0]] + 1, totalLaps);
    standingsBox.innerHTML = '<div class="standings-title">Круг ' + leadLapDisplay + ' / ' + totalLaps + '</div>' +
      top10.map((idx, pos) => {
        const cls = 'standing-row' + (idx === winnerIdx ? ' winner' : '');
        return '<div class="' + cls + '">' +
          '<span class="standing-pos">' + (pos + 1) + '</span>' +
          '<span class="standing-swatch" style="background:' + carColors[idx] + '"></span>' +
          '<span class="standing-name">' + escapeHtml(qualifiers[idx]) + '</span>' +
          '<span class="standing-lap">' + Math.min(lapsArr[idx] + 1, totalLaps) + '/' + totalLaps + '</span>' +
        '</div>';
      }).join('');
  }

  const progress = new Array(n).fill(0);
  const laps = new Array(n).fill(0);
  positionCars(progress);
  renderStandings(progress, laps, -1);

  // Камера від особи (Follow Mode)
  let camMode = 'free';
  let followIdx = 0;

  raceKeyHandler = (e) => {
    if (e.key === 'Control') {
      camMode = camMode === 'free' ? 'follow' : 'free';
      if (orbitControls3D) {
        orbitControls3D.enabled = (camMode === 'free');
        if (camMode === 'free') {
          // Повертаємо камеру на початковий загальний план
          camera3D.position.set(0, camDist * Math.sin(elevation), camDist * Math.cos(elevation));
          camera3D.lookAt(0, 0, 0);
          orbitControls3D.target.set(0, 0, 0);
          orbitControls3D.update();
        }
      }
    }
  };
  window.addEventListener('keydown', raceKeyHandler);

  raceMouseHandler = (e) => {
    if (camMode === 'follow') {
      if (e.button === 0) { // ЛКМ
        followIdx = (followIdx + 1) % n;
      } else if (e.button === 2) { // ПКМ
        followIdx = (followIdx - 1 + n) % n;
      }
    }
  };
  raceCtxHandler = (e) => {
    if (camMode === 'follow') {
      e.preventDefault();
    }
  };
  renderer3D.domElement.addEventListener('mousedown', raceMouseHandler);
  renderer3D.domElement.addEventListener('contextmenu', raceCtxHandler);

  function renderFrame() {
    if (camMode === 'follow') {
      const targetCar = cars[followIdx];
      const tangent = new THREE.Vector3(0, 0, 1).applyQuaternion(targetCar.quaternion);
      const idealPos = targetCar.position.clone().add(tangent.multiplyScalar(-12)).add(new THREE.Vector3(0, 4, 0));
      camera3D.position.lerp(idealPos, 0.15);
      camera3D.lookAt(targetCar.position.clone().add(new THREE.Vector3(0, 1, 0)));
    } else {
      if (orbitControls3D) orbitControls3D.update();
    }
    updateLabels();
    renderer3D.render(scene3D, camera3D);
  }

  renderFrame();

  const cd = document.getElementById('race-countdown');
  overlayHint.textContent = '';

  // ── Оверлей з гравцями перед стартом ──
  await new Promise(resolve => {
    const preRace = document.createElement('div');
    preRace.id = 'pre-race-overlay';
    preRace.style.cssText = [
      'position:absolute;inset:0;z-index:10',
      'background:rgba(4,8,4,0.92)',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px',
      'padding:24px',
    ].join(';');

    // Сітка гравців
    const grid = document.createElement('div');
    grid.style.cssText = [
      'display:grid',
      'grid-template-columns:repeat(auto-fill,minmax(140px,1fr))',
      'gap:8px',
      'max-width:min(95%,900px)',
      'max-height:70%',
      'overflow-y:auto',
      'width:100%',
    ].join(';');

    qualifiers.forEach((name, i) => {
      const colorHex = '#' + new THREE.Color().setHSL(i / n, 0.65, 0.5).getHexString();
      const isTractor = name.toLowerCase() === 'crystalyne7';
      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex;align-items:center;gap:8px',
        'padding:7px 12px;border-radius:8px',
        'background:rgba(255,255,255,0.05)',
        'border:1px solid ' + colorHex + '55',
        'font-size:13px;font-weight:700;color:#eee',
        'overflow:hidden',
      ].join(';');
      const dot = document.createElement('div');
      dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:' + colorHex + ';flex-shrink:0';
      const label = document.createElement('span');
      label.textContent = (isTractor ? '🚜 ' : '') + name;
      label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      row.appendChild(dot);
      row.appendChild(label);
      grid.appendChild(row);
    });

    // Кнопка старт
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.style.cssText = 'font-size:24px;padding:14px 60px;margin:0;letter-spacing:3px;flex-shrink:0;';
    btn.textContent = '🚀 СТАРТ';
    btn.onclick = () => { area.removeChild(preRace); resolve(); };

    preRace.appendChild(grid);
    preRace.appendChild(btn);
    area.appendChild(preRace);
    renderFrame();
  });

  for (const txt of ['3', '2', '1', 'GO!']) {
    cd.textContent = txt;
    cd.classList.remove('pulse');
    void cd.offsetWidth;
    cd.classList.add('pulse');
    await new Promise(resolve => {
      const endTime = performance.now() + 700;
      function cdFrame(now) {
        renderFrame();
        if (now < endTime) requestAnimationFrame(cdFrame);
        else resolve();
      }
      requestAnimationFrame(cdFrame);
    });
  }
  cd.textContent = '';

  const LAP_SECONDS = 9; 
  const baseSpeed = 1 / (LAP_SECONDS * 60); 
  const speed = qualifiers.map(() => baseSpeed * (0.85 + Math.random() * 0.3));
  const targetSpeed = speed.slice();
  const boostTimer = qualifiers.map(() => 30 + Math.random() * 120);

  let winnerIdx = -1;
  let lastTime = performance.now();
  let elapsed = 0;
  let lastStandingsUpdate = 0;
  const maxElapsed = totalLaps * 16;

  await new Promise(resolve => {
    function frame(now) {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      elapsed += dt;
      const frames = dt * 60; 

      for (let i = 0; i < n; i++) {
        if (winnerIdx !== -1) continue;

        boostTimer[i] -= frames;
        if (boostTimer[i] <= 0) {
          targetSpeed[i] = baseSpeed * (0.8 + Math.random() * 0.45);
          boostTimer[i] = 30 + Math.random() * 120;
        }
        speed[i] += (targetSpeed[i] - speed[i]) * Math.min(0.02 * frames, 1);

        progress[i] += speed[i] * frames;
        while (progress[i] >= 1) {
          progress[i] -= 1;
          laps[i]++;
          if (laps[i] >= totalLaps && winnerIdx === -1) {
            winnerIdx = i;
            progress[i] = 0;
          }
        }
      }

      positionCars(progress);
      renderFrame();

      if (now - lastStandingsUpdate > 200 || winnerIdx !== -1) {
        renderStandings(progress, laps, winnerIdx);
        lastStandingsUpdate = now;
      }

      if (winnerIdx !== -1 || elapsed > maxElapsed) {
        if (winnerIdx === -1) {
          winnerIdx = laps.map((l, i) => l + progress[i]).reduce((best, val, i, arr) => val > arr[best] ? i : best, 0);
        }
        labelEls[winnerIdx].classList.add('winner');
        renderStandings(progress, laps, winnerIdx);
        raceAnimId = null;
        resolve();
        return;
      }

      raceAnimId = requestAnimationFrame(frame);
    }
    raceAnimId = requestAnimationFrame(frame);
  });

  const winnerName = qualifiers[winnerIdx];
  overlayHint.innerHTML = 'Победитель: <b style="color:var(--kick);">' + escapeHtml(winnerName) + '</b>';
  controls.style.display = 'flex';
  phase = 'done';

  addWinner(winnerName);
}

// ── Режим «Револьвер» ────────────────────────────────────────────────────────
// Бере до 6 рандомних учасників, крутить барабан, вибиває по одному — останній перемагає.

let revolverQualifiers = [];

async function startRevolverGame() {
  if (state.participants.length < 2) return alert('Нужно минимум 2 участника!');
  const n = Math.min(state.participants.length, 6);
  revolverQualifiers = await rollPick(state.participants, n);   // ролл через random.org
  runRevolver(revolverQualifiers);
}

function closeRevolverOverlay() {
  document.getElementById('revolver-overlay').classList.remove('visible');
  if (phase !== 'idle') { phase = 'idle'; resetGameUI(); }
}

// Геометрія згенерованого барабана (revolver/cylinder.png). Картинка
// перецентрована по осі обертання; отвори на 3D-моделі стоять НЕ ідеально
// по 60° і не на одному радіусі, тому позиції кожної камори виміряні по
// латунних кільцях окремо: a — кут у градусах (0 = праворуч, -90 = 12 годин),
// r — відстань від осі у частках сторони елемента.
const REV_CHAMBERS = [
  { a: -90.04, r: 0.2982 }, { a: -32.24, r: 0.3033 }, { a:  25.74, r: 0.2920 },
  { a:  90.22, r: 0.2806 }, { a: 154.33, r: 0.2930 }, { a: -148.11, r: 0.3059 },
];
const REV_CH    = 0.248;    // діаметр камори (частка сторони)
const REV_SLOTS = REV_CHAMBERS.length;

async function runRevolver(qualifiers) {
  const overlay  = document.getElementById('revolver-overlay');
  const cylinder = document.getElementById('revolver-cylinder');
  const hint     = document.getElementById('revolver-overlay-hint');
  const controls = document.getElementById('revolver-overlay-controls');
  const area     = document.getElementById('revolver-area');
  const hammer   = document.getElementById('revolver-barrel-indicator');
  const bullet   = document.getElementById('revolver-bullet');

  phase = 'racing';
  overlay.classList.add('visible');
  controls.style.display = 'none';
  controls.innerHTML = '';
  hint.textContent = 'Заряжаем барабан...';

  const n = qualifiers.length;
  cylinder.innerHTML = '';
  cylinder.style.transition = 'none';
  cylinder.style.transform = 'rotate(0deg)';
  hammer.classList.remove('strike');
  bullet.classList.remove('flying');

  // Розміри рахуємо від фактичної сторони барабана — після показу оверлея
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const S = cylinder.clientWidth || 480;
  const CH = Math.round(S * REV_CH);

  // Камори: гравець i — в отворі i (0 = 12 годин), за виміряними позиціями.
  // Патрон сидить точно по центру отвору (фізично інакше не буває);
  // «живість» — лише у випадковому повороті самого патрона.
  const chambers = [];
  for (let i = 0; i < n; i++) {
    const slot = REV_CHAMBERS[i];
    const angleDeg = slot.a;
    const rad = angleDeg * Math.PI / 180;
    const jr = (Math.random() - 0.5) * 40;               // ±20° обертання патрона
    const x = Math.cos(rad) * slot.r * S;
    const y = Math.sin(rad) * slot.r * S;

    const el = document.createElement('div');
    el.className = 'rev-chamber loading';
    el.style.width = el.style.height = CH + 'px';
    el.style.transform = 'translate(calc(-50% + ' + x.toFixed(1) + 'px), calc(-50% + ' + y.toFixed(1) + 'px)) rotate(' + jr.toFixed(1) + 'deg)';

    const inner = document.createElement('div');
    inner.className = 'rev-chamber-inner';
    inner.textContent = qualifiers[i];
    inner.style.transform = 'rotate(' + (-jr).toFixed(1) + 'deg)';   // нік завжди горизонтальний

    el.appendChild(inner);
    cylinder.appendChild(el);
    chambers.push({ el, inner, name: qualifiers[i], angle: angleDeg, jr });
  }

  // ── Заряджання: патрони сідають у камори по одному, з клацанням ──
  for (const c of chambers) {
    await sleep(60);
    c.el.classList.remove('loading');
    c.el.classList.add('loaded');
    playSfx('rev-load', 0.7, 1, 260);   // лише клац, хвіст обрізаємо
    await sleep(240);
    if (phase !== 'racing') return;
  }
  await sleep(300);
  chambers.forEach(c => c.el.classList.remove('loaded'));

  let remaining = [...chambers];
  let currentRot = 0;

  // ── Пауза — чекаємо кнопку СТАРТ ──
  hint.textContent = 'Барабан заряжен';
  await new Promise(resolve => {
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.style.cssText = 'font-size:22px;padding:14px 44px;margin:20px 0 0;letter-spacing:3px;';
    btn.textContent = '🔫 СТАРТ';
    controls.style.display = 'flex';
    controls.innerHTML = '';
    controls.appendChild(btn);
    btn.onclick = () => {
      controls.style.display = 'none';
      controls.innerHTML =
        '<button class="btn-dark" onclick="startRevolverGame()">🔄 Ещё раз</button>' +
        '<button class="btn-primary" style="width:auto;margin-bottom:0;" onclick="closeRevolverOverlay()">Завершить</button>';
      resolve();
    };
  });
  hint.textContent = '';

  while (remaining.length > 1) {
    if (phase !== 'racing') return;
    hint.textContent = 'Крутим барабан...';

    const killIdx = await rollInt(remaining.length);   // ролл через random.org
    const target = remaining[killIdx];

    // Докручуємо так, щоб камора цілі стала під курок (12 годин = -90°/270°)
    const targetPos = 270;
    let diff = (targetPos - target.angle) % 360;
    if (diff < 0) diff += 360;
    let currentMod = currentRot % 360;
    if (currentMod < 0) currentMod += 360;
    let delta = diff - currentMod;
    if (delta <= 0) delta += 360;
    const nextRot = currentRot + delta + 360 * 3;

    // Звук храповика триває ~1с — розтягуємо його playbackRate-ом рівно під
    // тривалість оберту, а на зупинці — клац фіксації барабана
    const SPIN_MS = 1700;
    const ease = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
    cylinder.style.transition = 'transform ' + SPIN_MS + 'ms ' + ease;
    cylinder.style.transform = 'rotate(' + nextRot + 'deg)';
    chambers.forEach(c => {
      c.inner.style.transition = 'transform ' + SPIN_MS + 'ms ' + ease;
      c.inner.style.transform = 'rotate(' + (-nextRot - c.jr) + 'deg)';
    });
    currentRot = nextRot;

    playSfx('rev-spin', 0.9, 1000 / SPIN_MS);
    await sleep(SPIN_MS);
    playSfx('rev-load', 0.45, 1, 260);  // барабан став на фіксатор
    await sleep(140);
    if (phase !== 'racing') return;

    // ── Постріл: курок б'є, куля влітає в камору, спалах, іскри, віддача ──
    hammer.classList.add('strike');
    bullet.classList.remove('flying');
    void bullet.offsetWidth;
    bullet.classList.add('flying');
    playSfx('rev-shot', 1);
    hint.innerHTML = '💥 <b style="color:var(--red);">' + escapeHtml(target.name) + '</b> вылетает!';

    area.classList.add('shake-anim');
    const flash = document.createElement('div');
    flash.className = 'muzzle-flash';
    area.appendChild(flash);

    for (let s = 0; s < 10; s++) {
      const spark = document.createElement('div');
      spark.className = 'spark';
      const ang = (Math.random() * 360) * Math.PI / 180;
      const dist = 35 + Math.random() * 70;
      spark.style.setProperty('--sx', (Math.cos(ang) * dist) + 'px');
      spark.style.setProperty('--sy', (Math.sin(ang) * dist - 30) + 'px');
      spark.style.animationDelay = (Math.random() * 0.06) + 's';
      spark.style.width = spark.style.height = (2 + Math.random() * 3) + 'px';
      area.appendChild(spark);
      setTimeout(() => spark.remove(), 500);
    }

    setTimeout(() => target.el.classList.add('eliminated'), 90);   // гільза замість патрона
    setTimeout(() => flash.remove(), 230);
    setTimeout(() => { area.classList.remove('shake-anim'); hammer.classList.remove('strike'); }, 500);

    remaining.splice(killIdx, 1);
    await sleep(1000);
  }

  const winner = remaining[0];
  winner.el.classList.add('winner');
  hint.innerHTML = '🎉 Победитель: <b style="color:var(--kick);">' + escapeHtml(winner.name) + '</b>';
  controls.style.display = 'flex';
  phase = 'done';
  playSfx('win', 0.7);

  addWinner(winner.name);
}

// Звук пострілу (інший від основного playTimeoutSound)
// Звук пострілу револьвера (bang + металевий відгук)
function playRevolverShot() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;

    // Основний удар ("bang") — шум + низький тон
    const bufferSize = audioCtx.sampleRate * 0.25;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;

    // Фільтр — надає характер пострілу
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, now);
    filter.frequency.exponentialRampToValueAtTime(120, now + 0.15);

    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(2.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(audioCtx.destination);
    noise.start(now);

    // Низькочастотний "boom"
    const boom = audioCtx.createOscillator();
    const boomGain = audioCtx.createGain();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(90, now);
    boom.frequency.exponentialRampToValueAtTime(30, now + 0.2);
    boomGain.gain.setValueAtTime(1.2, now);
    boomGain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    boom.connect(boomGain);
    boomGain.connect(audioCtx.destination);
    boom.start(now); boom.stop(now + 0.22);

    // Металевий відгук гільзи
    const clank = audioCtx.createOscillator();
    const clankGain = audioCtx.createGain();
    clank.type = 'triangle';
    clank.frequency.setValueAtTime(600, now + 0.08);
    clank.frequency.exponentialRampToValueAtTime(200, now + 0.3);
    clankGain.gain.setValueAtTime(0, now);
    clankGain.gain.setValueAtTime(0.3, now + 0.08);
    clankGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    clank.connect(clankGain);
    clankGain.connect(audioCtx.destination);
    clank.start(now + 0.08); clank.stop(now + 0.38);
  } catch(e) {}
}

// Звук прокрутки барабана (клацання механізму)
function playRevolverSpin() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;

    // Серія клацань
    const clicks = 7;
    for (let i = 0; i < clicks; i++) {
      const t = now + i * 0.06 * (1 + i * 0.04); // прискорення на початку, сповільнення в кінці
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(900 - i * 60, t);
      osc.frequency.exponentialRampToValueAtTime(300, t + 0.04);
      g.gain.setValueAtTime(0.25 - i * 0.02, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      osc.connect(g); g.connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.07);
    }
  } catch(e) {}
}

// ── Режим «Чат» ──────────────────────────────────────────────────────────────
// Рулетка выбирает победителя, бот перехватывает его сообщения,
// стример нажимает «Сохранить» на нужном, список победителей справа.

let chatgameWinners = [];       // [{nick, slot, time}]
let chatgameCurrentNick = '';   // кто сейчас отвечает
let chatgameMsgBuffer = [];     // сообщения текущего победителя
let chatgameTimedOut = false;   // время вышло — не принимаем новые сообщения
let chatgameTimer = null;
let chatgameTimerSeconds = 0;

// ── 🪂 Батл Рояль і перестрілка ─────────────────────────────
// Винесено в окремі модулі: royale.js (лобі/мінімапа/зона) і
// shootout.js (canvas-движок перестрілки, window.RSO). Вони
// підключаються в index.html ПІСЛЯ app.js і несуть весь контракт:
// startRoyale, closeRoyaleOverlay, royHandleMessage, royRender,
// rsoFocusNext, rsoToggleOverview тощо.



async function startChatgame() {
  if (state.participants.length < 1) return alert('Нужно хотя бы 1 участника');
  const winner = (await rollPick(state.participants, 1))[0];   // ролл через random.org
  openChatgameOverlay(winner);
}

function openChatgameOverlay(nick) {
  chatgameCurrentNick = nick;
  chatgameMsgBuffer = [];
  chatgameTimedOut = false;
  phase = 'racing';

  const overlay = document.getElementById('chatgame-overlay');
  overlay.classList.add('visible');

  document.getElementById('chatgame-winner-name').textContent = nick;
  document.getElementById('chatgame-msgs').innerHTML =
    '<div id="chatgame-no-msgs"></div>';
  const oldBadge = document.getElementById('chatgame-replied-badge');
  if (oldBadge) oldBadge.remove();

  // Запускаем таймер
  const seconds = getConfirmSeconds();
  chatgameTimerSeconds = seconds;
  renderChatgameTimer(seconds);

  if (chatgameTimer) clearInterval(chatgameTimer);
  chatgameTimer = setInterval(() => {
    chatgameTimerSeconds--;
    renderChatgameTimer(chatgameTimerSeconds);
    if (chatgameTimerSeconds <= 0) {
      clearInterval(chatgameTimer);
      chatgameTimer = null;
      chatgameTimedOut = true;
      document.getElementById('chatgame-timer').textContent = '⏰';
      document.getElementById('chatgame-timer').className = '';
      document.getElementById('chatgame-sub').textContent = 'ВРЕМЯ ВЫШЛО — НЕТ ОТВЕТА';
      document.getElementById('chatgame-sub').style.color = 'var(--red)';
      document.getElementById('chatgame-sub').style.display = '';
    }
  }, 1000);

  renderChatgameWinners();
}

function renderChatgameTimer(sec) {
  const el = document.getElementById('chatgame-timer');
  const sub = document.getElementById('chatgame-sub');
  el.textContent = sec + 'с';
  el.className = sec <= 10 ? 'expiring' : '';
  sub.textContent = 'ВРЕМЯ НА ОТВЕТ';
  sub.style.color = '';
  sub.style.display = sec > 0 ? '' : 'none';
}

// Вызывается из SSE-обработчика при каждом сообщении чата
function handleChatgameMessage(username, content) {
  if (!chatgameCurrentNick) return;
  if (username.toLowerCase() !== chatgameCurrentNick.toLowerCase()) return;
  if (chatgameTimedOut) return; // час вийшов — не приймаємо

  const isFirst = chatgameMsgBuffer.length === 0;
  chatgameMsgBuffer.push(content);

  const box = document.getElementById('chatgame-msgs');
  const noMsg = document.getElementById('chatgame-no-msgs');
  if (noMsg) noMsg.remove();

  // Якщо перше повідомлення — показуємо індикатор "Ответил"
  if (isFirst) {
    const replied = document.getElementById('chatgame-replied-badge');
    if (!replied) {
      const badge = document.createElement('div');
      badge.id = 'chatgame-replied-badge';
      badge.style.cssText = 'font-size:12px;font-weight:700;color:var(--kick);letter-spacing:2px;text-transform:uppercase;padding:4px 0;';
      badge.textContent = '✓ ОТВЕТИЛ';
      box.before(badge);
    }
    // Зупиняємо таймер — людина вже відповіла
    if (chatgameTimer) { clearInterval(chatgameTimer); chatgameTimer = null; }
    document.getElementById('chatgame-timer').textContent = '✓';
    document.getElementById('chatgame-timer').style.color = 'var(--kick)';
    document.getElementById('chatgame-sub').style.display = 'none';
  }

  const row = document.createElement('div');
  row.className = 'chatgame-msg-row';

  // Відображаємо емодзі через parseChatContent
  const txt = document.createElement('div');
  txt.className = 'chatgame-msg-text';
  txt.innerHTML = parseChatContent(content);

  const btn = document.createElement('button');
  btn.className = 'chatgame-msg-save';
  btn.textContent = '✓ Сохранить';
  const captured = content;
  const capturedNick = chatgameCurrentNick;
  btn.onclick = () => {
    document.querySelectorAll('.chatgame-msg-save').forEach(b => {
      b.textContent = '✓ Сохранить';
      b.style.background = '';
      b.disabled = false;
      b.style.opacity = '1';
      b.style.cursor = 'pointer';
    });
    btn.textContent = '✅ Сохранено';
    btn.style.background = '#1a5c1a';
    btn.disabled = true;
    addChatgameWinner(capturedNick, captured);
    stopChatgameTimer();
  };

  row.appendChild(txt);
  row.appendChild(btn);
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function deleteAllChatgameWinners() {
  if (!chatgameWinners.length) return;
  if (!confirm('Удалить всех победителей (' + chatgameWinners.length + ')? Это действие нельзя отменить.')) return;
  chatgameWinners = [];
  renderChatgameWinners();
  saveChatgameWinnersToServer();
}

function saveChatgameWinnersToServer() {
  fetch('/api/chatgame-winners/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winners: chatgameWinners })
  });
}

function addChatgameWinner(nick, slot) {
  // Не дублировать
  const existing = chatgameWinners.find(w => w.nick === nick);
  if (existing) {
    existing.slot = slot;
    existing.time = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  } else {
    chatgameWinners.push({
      nick,
      slot,
      time: new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    });
  }
  renderChatgameWinners();
  saveChatgameWinnersToServer();
  document.getElementById('chatgame-winner-name').textContent = nick;
}

function deleteChatgameWinner(idx) {
  chatgameWinners.splice(idx, 1);
  renderChatgameWinners();
  saveChatgameWinnersToServer();
}

function renderChatgameWinners() {
  const list = document.getElementById('chatgame-winners-list');
  document.getElementById('chatgame-count').textContent = chatgameWinners.length;
  if (!chatgameWinners.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:20px;">Победителей пока нет</div>';
    return;
  }
  list.innerHTML = chatgameWinners.map((w, i) =>
    '<div class="chatgame-winner-row">' +
      '<div class="cg-num">' + (i+1) + '</div>' +
      '<div class="chatgame-winner-info">' +
        '<div class="cg-nick">' + escapeHtml(w.nick) + '</div>' +
        '<div class="cg-slot' + (w.slot ? '' : ' empty') + '">' +
          escapeHtml(w.slot || 'ожидаем сообщение...') +
        '</div>' +
        '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">' + w.time + '</div>' +
      '</div>' +
      '<button class="chatgame-delete-btn" onclick="editChatgameWinner(' + i + ')" title="Редактировать" style="color:var(--accent);border-color:var(--border-strong);margin-right:4px;">✎</button>' +
      '<button class="chatgame-delete-btn" onclick="deleteChatgameWinner(' + i + ')" title="Удалить">🗑</button>' +
    '</div>'
  ).join('');
}

let cgEditingIdx = -1;

function editChatgameWinner(i) {
  cgEditingIdx = i;
  const w = chatgameWinners[i];
  hideCGAddForm();
  const f = document.getElementById('cg-edit-form');
  f.style.display = 'flex';
  document.getElementById('cg-edit-nick').value = w.nick;
  document.getElementById('cg-edit-msg').value = w.slot || '';
  document.getElementById('cg-edit-nick').focus();
  // Прокручуємо форму редагування у видиму область
  f.scrollIntoView({ block: 'nearest' });
}
function hideCGEditForm() {
  document.getElementById('cg-edit-form').style.display = 'none';
  cgEditingIdx = -1;
}
function submitCGEdit() {
  if (cgEditingIdx < 0) return;
  const w = chatgameWinners[cgEditingIdx];
  const newNick = document.getElementById('cg-edit-nick').value.trim();
  const newMsg = document.getElementById('cg-edit-msg').value.trim();
  w.nick = newNick || w.nick;
  w.slot = newMsg || null;
  renderChatgameWinners();
  saveChatgameWinnersToServer();
  hideCGEditForm();
}

function showCGAddForm() {
  hideCGEditForm();
  const f = document.getElementById('cg-add-form');
  f.style.display = 'flex';
  document.getElementById('cg-add-nick').value = '';
  document.getElementById('cg-add-msg').value = '';
  document.getElementById('cg-add-nick').focus();
}
function hideCGAddForm() {
  document.getElementById('cg-add-form').style.display = 'none';
}
function submitCGAdd() {
  const nick = document.getElementById('cg-add-nick').value.trim();
  if (!nick) return;
  const msg = document.getElementById('cg-add-msg').value.trim();
  const time = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  chatgameWinners.push({ nick, slot: msg || null, time });
  renderChatgameWinners();
  saveChatgameWinnersToServer();
  hideCGAddForm();
}

function stopChatgameTimer() {
  if (chatgameTimer) { clearInterval(chatgameTimer); chatgameTimer = null; }
  // НЕ очищаємо chatgameCurrentNick — щоб нові повідомлення продовжували надходити
  document.getElementById('chatgame-timer').textContent = '—';
  document.getElementById('chatgame-sub').style.display = 'none';
}

function clearChatgameWinner() {
  chatgameCurrentNick = '';
}

async function chatgameNextWinner() {
  stopChatgameTimer();
  clearChatgameWinner();
  const alreadyWon = new Set(chatgameWinners.map(w => w.nick.toLowerCase()));
  const pool = state.participants.filter(p => !alreadyWon.has(p.toLowerCase()));
  if (!pool.length) { alert('Все участники уже победили!'); return; }
  const next = (await rollPick(pool, 1))[0];   // ролл через random.org
  openChatgameOverlay(next);
}

function closeChatgameOverlay() {
  stopChatgameTimer();
  clearChatgameWinner();
  chatgameMsgBuffer = [];
  document.getElementById('chatgame-overlay').classList.remove('visible');
  if (phase !== 'idle') { phase = 'idle'; resetGameUI(); }
}

function closeRaceOverlay() {
  resetGameUI();
}

// Підбирає кількість колонок так, щоб усі N клітинок (квадратних, gap=6px)
// влізли в контейнер без скролу. Якщо учасників мало — клітинки великі,
// якщо багато — автоматично зменшуються (з мінімумом, нижче якого дозволяється скрол).
// Табло як у Crazy Time: сітка ЗАВЖДИ заповнює прямокутник борда цілком,
// незалежно від кількості гравців. Підбираємо rows×cols з найквадратнішими
// клітинками; хвіст останнього ряду просто лишається коротшим.
function fitGridColumns(grid, box, n) {
  const W = Math.max(box.clientWidth - 12, 50);
  const H = Math.max(box.clientHeight - 12, 50);

  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const aspect = (W / cols) / (H / rows);          // 1 = квадратна клітинка
    const score = Math.abs(Math.log(aspect));
    if (!best || score < best.score) best = { cols, rows, score };
  }

  grid.style.gridTemplateColumns = 'repeat(' + best.cols + ', 1fr)';
  grid.style.gridTemplateRows = 'repeat(' + best.rows + ', 1fr)';
  grid.style.width = '100%';
  grid.style.height = '100%';
  grid.style.justifyContent = '';

  // Хвіст останнього ряду лишається незаповненим — кілька відсутніх
  // клітинок виглядають чесніше за порожні заглушки
}
// DOM-клітинка гравця за ігровим індексом (порядок у DOM інший через заглушки)
function cellByIdx(i) {
  return document.querySelector('#cashhunt-grid .cell[data-idx="' + i + '"]');
}

// ── Інтро табло Cash Hunt ────────────────────────────────────────
// Послідовність як у Crazy Time: спершу стіна показує НІКИ учасників,
// потім хвилею перевертається на мішені, «прокручується» (перемішування
// слот-машиною) і плавно зупиняється колонка за колонкою — після цього
// стрімер може вибирати клітинки.
let introToken = 0;   // новий рендер/закриття оверлея абортить попереднє інтро

// Прибрати стрічки прокрутки (виклик і при аборті, і на вході нового інтро)
function cleanupReels(grid) {
  grid.classList.remove('reeling');
  grid.querySelectorAll('.slot-reel').forEach(r => r.remove());
}

async function playBoardIntro() {
  const myToken = ++introToken;
  const alive = () => phase === 'intro' && introToken === myToken;
  cleanupReels(document.getElementById('cashhunt-grid'));

  const grid = document.getElementById('cashhunt-grid');
  const cells = [...grid.querySelectorAll('.cell')];
  const hint = document.getElementById('cashhunt-hint');
  if (!cells.length) return;
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  const rows = Math.ceil(cells.length / cols);

  // 1. Стіна імен — глядачі бачать, хто на табло
  hint.textContent = 'Участники на табло';
  await sleep(2000);
  if (!alive()) return;

  // 2. Хвиля фліпів на мішені — ряд за рядом згори вниз (без звуку прокрута)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const el = cells[r * cols + c];
      if (el) el.classList.remove('flipped');
    }
    await sleep(45);
    if (!alive()) return;
  }
  await sleep(380);
  if (!alive()) return;

  // 3. Прокрутка як у Crazy Time: колонки стіни їдуть ВЕРТИКАЛЬНО
  //    стрічками мішеней (слот-барабани). Стрічка в кожній клітинці
  //    колонки має ту саму швидкість і фазу, тому колонка читається
  //    як одна суцільна колона що котиться; різні колонки — різні
  //    фази й швидкості, як на відео.
  hint.textContent = 'Перемешивание...';
  grid.classList.add('reeling');
  for (let r = 0; r < rows; r++) {
    const dur   = (0.26 + Math.random() * 0.16).toFixed(3) + 's';
    const delay = (-Math.random()).toFixed(3) + 's';
    for (let c = 0; c < cols; c++) {
      const el = cells[r * cols + c];
      if (!el) continue;
      const reel = document.createElement('div');
      reel.className = 'slot-reel';
      const seq = [0, 0, 0].map(() => TARGETS[Math.floor(Math.random() * TARGETS.length)]);
      seq.push(seq[0]);                     // перший = останній → безшовний луп
      reel.innerHTML = seq.map(s =>
        '<div class="reel-seg"><img src="' + s + '" alt="" draggable="false"></div>').join('');
      reel.style.animationDuration = dur;
      reel.style.animationDelay = delay;
      el.querySelector('.cell-front').appendChild(reel);
    }
  }

  await sleep(2600);
  if (!alive()) { cleanupReels(grid); return; }

  // 4. Зупинка: ряди докочуються згори вниз, кожен з пружним «стуком»
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const el = cells[r * cols + c];
      if (!el) continue;
      const reel = el.querySelector('.slot-reel');
      if (reel) reel.remove();
      const img = el.querySelector('.cell-target');
      if (img) img.src = TARGETS[Math.floor(Math.random() * TARGETS.length)]; // перемішана мішень
      el.classList.add('stopped');
    }
    await sleep(85);
    if (!alive()) { cleanupReels(grid); return; }
  }
  grid.classList.remove('reeling');
  await sleep(400);
  cells.forEach(el => el.classList.remove('stopped'));
  if (!alive()) return;

  // 5. Табло готове — відкриваємо вибір; ЛИШЕ тепер ховаємо системний курсор
  // (selecting-mode дає cursor:none, а кастомний приціл малюється тільки у
  // фазі вибору — якщо повісити клас при відкритті, все інтро сидиш без курсора)
  phase = 'selecting';
  document.getElementById('cashhunt-overlay').classList.add('selecting-mode');
  updateHint();
}

function closeCashhuntOverlay() {
  const ol = document.getElementById('cashhunt-overlay');
  ol.classList.remove('visible', 'selecting-mode');
  document.getElementById('cashhunt-area').classList.remove('bulbs-fast');
  document.getElementById('cashhunt-controls').style.display = 'none';
  document.getElementById('cashhunt-hint').textContent = '';
  document.getElementById('cashhunt-progress-overlay').textContent = '';
  document.getElementById('cashhunt-grid').innerHTML = '';
  if (phase !== 'idle') { phase = 'idle'; resetGameUI(); }
}

function renderGame(game) {
  /* Cash Hunt: розкладку робив сервер, тож джерело і доказ приходять з грою */
  if (game && game.rollSource) { lastRollSource = game.rollSource; lastRollProof = game.rollProof || null; }
  currentGame = game;
  selected = new Set();
  phase = 'intro';                 // кліки заблоковані до кінця інтро
  restCannon();

  // Відкриваємо оверлей
  const overlay = document.getElementById('cashhunt-overlay');
  overlay.classList.add('visible');   // selecting-mode повісить кінець інтро
  initCashhuntBulbs();
  document.getElementById('cashhunt-area').classList.remove('bulbs-fast');
  document.getElementById('cashhunt-controls').style.display = 'none';
  document.getElementById('cashhunt-progress-overlay').textContent = '';

  const grid = document.getElementById('cashhunt-grid');
  grid.innerHTML = '';

  // fitGridColumns після двох rAF щоб overlay вже був видимий і мав розміри;
  // інтро стартує після розкладки — заглушки на той момент уже в сітці
  const wrap = document.getElementById('cashhunt-grid-wrap');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fitGridColumns(grid, wrap, game.cells.length);
    playBoardIntro();
  }));

  // Прибираємо old main-box UI
  document.getElementById('game-controls').style.display = 'none';

  game.cells.forEach((name, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell flipped';   // народжується ніком до глядача — інтро почнеться з імен
    cell.dataset.idx = i;
    const tIdx = Math.floor(Math.random() * TARGETS.length);
    const fallback = STICKERS[Math.floor(Math.random() * STICKERS.length)];
    cell.innerHTML =
      '<div class="cell-inner">' +
        '<div class="cell-face cell-front">' +
          '<img class="cell-target" src="' + TARGETS[tIdx] + '" alt="" draggable="false" ' +
               'onerror="this.outerHTML=\'' + fallback + '\'">' +
        '</div>' +
        '<div class="cell-face cell-back"><span class="nick">' + escapeHtml(name) + '</span></div>' +
      '</div>';
    cell.addEventListener('click', () => onCellClick(i, cell));
    grid.appendChild(cell);
  });
}

function onCellClick(idx, cellEl) {
  if (phase !== 'selecting') return;

  if (selected.has(idx)) {
    // Деселект
    selected.delete(idx);
    cellEl.classList.remove('selected');
  } else if (selected.size >= currentGame.winnersNeeded) {
    // Ліміт досягнуто — знімаємо першу вибрану і ставимо нову (instant replace)
    const oldIdx = [...selected][0];
    selected.delete(oldIdx);
    const oldCell = document.querySelector('#cashhunt-grid .cell[data-idx="' + oldIdx + '"]');
    if (oldCell) oldCell.classList.remove('selected');
    selected.add(idx);
    cellEl.classList.add('selected');
  } else {
    selected.add(idx);
    cellEl.classList.add('selected');
  }

  // Пушка супроводжує останню вибрану клітинку лазером-прицілом
  if (selected.size > 0) {
    const lastIdx = [...selected][selected.size - 1];
    const lastCell = document.querySelector('#cashhunt-grid .cell[data-idx="' + lastIdx + '"]');
    if (lastCell) aimCannonAt(lastCell, true);
  } else {
    restCannon();
  }

  updateHint();
  const ctrl = document.getElementById('cashhunt-controls');
  if (selected.size === currentGame.winnersNeeded) {
    ctrl.style.display = 'flex';
    ctrl.innerHTML = '<button class="btn-gold" onclick="startReveal()">🔫 Выстрел</button>' +
      '<button class="btn-dark" onclick="closeCashhuntOverlay()">Закрыть</button>';
  } else {
    ctrl.style.display = 'none';
  }
}

function updateHint() {
  const n = currentGame ? currentGame.winnersNeeded : 0;
  const hint = document.getElementById('cashhunt-hint');
  if (phase === 'selecting') {
    hint.innerHTML = 'Выберите <b>' + n + '</b> ' + (n === 1 ? 'ячейку' : 'ячеек') +
      ' — выбрано: <b>' + selected.size + ' / ' + n + '</b>';
  }
}

async function startReveal() {
  if (selected.size !== currentGame.winnersNeeded) return;
  phase = 'revealing';
  document.getElementById('cashhunt-overlay').classList.remove('selecting-mode');
  // у фазі розкриття лампочки мерехтять швидше (див. .bulbs-fast в app.css)
  document.getElementById('cashhunt-area').classList.add('bulbs-fast');

  const hint = document.getElementById('cashhunt-hint');
  const ctrl = document.getElementById('cashhunt-controls');
  ctrl.style.display = 'none';
  hint.textContent = 'Раскрытие...';

  const allIdx = currentGame.cells.map((_, i) => i);
  const others = allIdx.filter(i => !selected.has(i));
  const winnersOrder = [...selected].sort(() => Math.random() - 0.5);

  /* Постріл ОДРАЗУ по натисканню «Выстрел»: гармата б'є по вибраній
     клітинці, влучання маркується світною міткою — і лише ПОТІМ
     відкривається решта поля (драматургія: спершу дія, потім розкриття) */
  document.getElementById('cannon').classList.remove('tracking');
  for (const idx of winnersOrder) {
    const cell = cellByIdx(idx);
    if (!cell) continue;
    await fireCannonAt(cell);
    cell.classList.add('shot');
  }
  await sleep(450);

  // Порожні клітинки фліпаються перемішаним потоком (без звуку прокрута)
  const flipQueue = others.map(cellByIdx)
    .filter(Boolean).sort(() => Math.random() - 0.5);

  const REFERENCE_COUNT = 20;
  const BASE_DELAY = 65;
  const MIN_DELAY = 8;
  const flipDelay = Math.max(MIN_DELAY, Math.min(BASE_DELAY, BASE_DELAY * REFERENCE_COUNT / Math.max(flipQueue.length, 1)));

  for (const el of flipQueue) {
    el.classList.add('flipped', 'revealed');
    await sleep(flipDelay);
  }

  await sleep(900);

  const winners = [];
  for (let k = 0; k < winnersOrder.length; k++) {
    const idx = winnersOrder[k];
    const cell = cellByIdx(idx);
    cell.classList.remove('shot');
    /* winner-reveal: клітинка спершу виростає, потім повільно перекидається
       і ЛИШАЄТЬСЯ збільшеною (анімація з fill forwards поверх .flipped) */
    cell.classList.add('flipped', 'revealed', 'winner', 'winner-reveal');
    const name = currentGame.cells[idx];
    winners.push(name);
    await sleep(1300);          // дати перекиду відіграти ДО заставки переможця
    addWinner(name);
    await sleep(900);
  }
  /* фанфару переможця в кешханті прибрано — лишається тільки звук пострілу */
  restCannon();

  phase = 'done';
  hint.innerHTML = '🏆 Готово!';
  ctrl.style.display = 'flex';
  ctrl.innerHTML = '<button class="btn-orange" onclick="reroll()">🔄 Рерол</button>' +
    '<button class="btn-dark" onclick="closeCashhuntOverlay()">Закрыть</button>';
}

let announceTimer = null;
let announceSeconds = 0;
let audioCtx = null;

function playTimeoutSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;

    // Старий звук (3 короткі піпи 880Hz), відтворений двічі з паузою
    function tripleBeep(startOffset) {
      [0, 0.25, 0.5].forEach(offset => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, now + startOffset + offset);
        gain.gain.exponentialRampToValueAtTime(0.3, now + startOffset + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + offset + 0.2);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + startOffset + offset);
        osc.stop(now + startOffset + offset + 0.25);
      });
    }

    tripleBeep(0);    // перший раз
    tripleBeep(1.0);  // другий раз через 1 секунду
  } catch (e) {}
}

function showAnnounce(name, seconds, confirmOn) {
  document.getElementById('wa-name').textContent = name;
  const timerEl = document.getElementById('wa-timer');
  const msgEl   = document.getElementById('wa-msg');
  const subEl   = document.getElementById('wa-sub');

  if (announceTimer) clearInterval(announceTimer);
  msgEl.style.display = 'none';
  msgEl.textContent = '';

  spawnParticles();

  if (confirmOn) {
    announceSeconds = seconds;
    timerEl.textContent = seconds + 'с';
    timerEl.className = 'wa-timer';
    subEl.style.display = '';
    subEl.textContent = 'ВРЕМЯ НА ОТВЕТ';
    document.getElementById('winner-announce').classList.add('visible');

    announceTimer = setInterval(() => {
      announceSeconds--;
      timerEl.textContent = Math.max(0, announceSeconds) + 'с';
      timerEl.className = 'wa-timer' + (announceSeconds <= 10 ? ' expiring' : '');
      if (announceSeconds <= 0) {
        clearInterval(announceTimer);
        announceTimer = null;
        subEl.textContent = 'Время вышло';
        playTimeoutSound();
      }
    }, 1000);
  } else {
    timerEl.textContent = '';
    subEl.style.display = 'none';
    document.getElementById('winner-announce').classList.add('visible');
  }
}

function updateAnnounceMsg(name, message) {
  const ann = document.getElementById('winner-announce');
  if (!ann.classList.contains('visible')) return;
  const waName = document.getElementById('wa-name').textContent;
  if (waName.toLowerCase() !== name.toLowerCase()) return;

  if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  const timerEl = document.getElementById('wa-timer');
  const msgEl   = document.getElementById('wa-msg');
  const subEl   = document.getElementById('wa-sub');

  timerEl.style.display = 'none';
  subEl.style.display = 'none';
  msgEl.textContent = message;
  msgEl.style.display = '';
}

function closeAnnounce() {
  document.getElementById('winner-announce').classList.remove('visible');
  if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  document.getElementById('wa-timer').style.color = '';
}

function spawnParticles() {
  const colors = [THEME.accent, THEME.accentDeep, '#fff'];
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'wa-particle';
    const size = 6 + Math.random() * 12;
    const angle = (Math.random() * 360) * Math.PI / 180;
    const dist  = 150 + Math.random() * 300;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist - 100;
    p.style.cssText =
      'width:' + size + 'px;height:' + size + 'px;' +
      'background:' + colors[Math.floor(Math.random()*colors.length)] + ';' +
      'left:' + (window.innerWidth/2 - size/2) + 'px;' +
      'top:' + (window.innerHeight/2 - size/2) + 'px;' +
      '--tx:' + tx + 'px;--ty:' + ty + 'px;' +
      'animation-duration:' + (1.5 + Math.random()*1) + 's;';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 2500);
  }
}

function deleteAllWinners() {
  if (!winnersHistory.length) return;
  if (!confirm('Удалить всех победителей (' + winnersHistory.length + ')? Это действие нельзя отменить.')) return;
  winnersHistory = [];
  renderWinners();
  saveWinnersToServer();
}

function saveWinnersToServer() {
  fetch('/api/winners/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winners: winnersHistory })
  });
}

function addWinner(name) {
  const seconds = getConfirmSeconds();
  const confirmOn = document.getElementById('toggle-confirm').checked && seconds > 0; // 0 = времени не надо, ждать не нужно
  const time = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

  const entry = { name, time, status: confirmOn ? 'pending' : 'ok', message: null };
  winnersHistory.unshift(entry);
  renderWinners();
  saveWinnersToServer();

  /* батл-рояль має ВЛАСНУ заставку переможця (Chicken Dinner після перестрілки
     або банер з короною на мапі) — загальна поверх неї дублювалась і зайва.
     Решта конвеєра (історія, сервер, чат-анонс, таймер підтвердження) працює як скрізь */
  if (gameMode !== 'royale') showAnnounce(name, seconds, confirmOn);
  renderRollSource();

  if (confirmOn) {
    /* ГОНКА (стара, ще з зеленої версії): pollCheckState стартував ДО того,
       як сервер створив чек нового переможця → опитування не бачило pending
       і глушило власний інтервал — таймер у переможця «не відкривався».
       Тепер перший poll іде лише ПІСЛЯ відповіді check/start */
    if (checkTimerInterval) clearInterval(checkTimerInterval);
    checkTimerInterval = setInterval(pollCheckState, 1000);
    fetch('/api/raffle/check/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winner: name, seconds })
    }).catch(() => {}).finally(() => pollCheckState());
  } else {
    // Без підтвердження — просто повідомляємо в чат
    fetch('/api/chat/announce', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winner: name })
    });
  }
}

// ── Ручне додавання / редагування / видалення переможців ──

function renderWinners() {
  document.getElementById('winners-count-title').textContent = winnersHistory.length;
  const box = document.getElementById('winners-box');
  if (!winnersHistory.length) {
    box.innerHTML = '<div class="empty-box">Победителей пока нет</div>';
    return;
  }

  box.innerHTML = winnersHistory.map((w, i) =>
    '<div class="winner-row">' +
      '<div class="winner-top">' +
        '<span class="w-num">' + (i + 1) + '</span>' +
        '<span class="w-name">' + escapeHtml(w.name) + '</span>' +
      '</div>' +
    '</div>'
  ).join('');
}

function escapeAttr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function pollCheckState() {
  const res = await fetch('/api/raffle/check/state');
  if (res.status === 401) return;
  const data = await res.json();

  let anyPending = false;
  let changed = false;

  winnersHistory.forEach(w => {
    if (w.status !== 'pending') return;
    const c = data.checks[w.name] ||
      Object.entries(data.checks).find(([k]) => k.toLowerCase() === w.name.toLowerCase())?.[1];
    /* страховка від гонки: pending-переможець, чий чек ще не долетів до
       сервера, НЕ означає «нема чого чекати» — тримаємо опитування живим */
    if (!c) { anyPending = true; return; }

    if (c.message !== null) {
      console.log('[CLIENT] Winner replied:', w.name, 'message:', c.message, 'updating announce...');
      w.status = 'ok';
      w.message = c.message;
      updateAnnounceMsg(w.name, c.message);
      changed = true;
    } else if (c.active) {
      const elapsed = (Date.now() - c.startedAt) / 1000;
      const remaining = Math.max(0, Math.ceil(c.seconds - elapsed));
      if (remaining <= 0) {
        w.status = 'bad';
        changed = true;
      } else {
        anyPending = true;
        const el = document.querySelector('.w-status.pending[data-name="' + escapeAttr(w.name) + '"]');
        if (el) el.textContent = remaining + 'с';
      }
    }
  });

  if (changed) renderWinners();
  if (!anyPending && checkTimerInterval) {
    clearInterval(checkTimerInterval);
    checkTimerInterval = null;
  }
}

async function retryWinner(name) {
  const seconds = getConfirmSeconds();
  await fetch('/api/raffle/check/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winner: name })
  });
  await fetch('/api/raffle/check/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winner: name, seconds })
  });
  const entry = winnersHistory.find(w => w.name === name);
  if (entry) { entry.status = 'pending'; entry.message = null; }
  renderWinners();
  if (checkTimerInterval) clearInterval(checkTimerInterval);
  checkTimerInterval = setInterval(pollCheckState, 1000);
  pollCheckState();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

renderWinners();
loadState();
setGameMode('roulette'); // ховає поле переможців в дефолтному режимі
adjustConfirmSeconds(0); // синхронізуємо плитку «час на відповідь» з поточним значенням
setInterval(() => { if (phase === 'idle') loadState(); }, 2000);

// Пробіл не повинен "клікати" по фокусованій кнопці (через це після старту
// гри натискання пробілу повторно запускало startGame() з нуля)
window.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.key === ' ') && document.activeElement && document.activeElement.tagName === 'BUTTON') {
    e.preventDefault();
  }
});

// Перерахувати сітку Cash Hunt при зміні розміру вікна
window.addEventListener('resize', () => {
  if (phase === 'selecting' || phase === 'revealing' || phase === 'done') {
    const grid = document.getElementById('grid');
    const box = document.getElementById('main-box');
    if (grid && box && currentGame) fitGridColumns(grid, box, currentGame.cells.length);
  }
});

function toggleConfirmField() {
  const on = document.getElementById('toggle-confirm').checked;
  const f = document.getElementById('confirm-time-field');
  f.style.display = on ? 'block' : 'none';
}

// ── Вогники на лампочках табло Cash Hunt ────────────────────────
// Лампочки намальовані прямо в board.png, тож координати шукаємо
// програмно (кластери яскраво-жовтих пікселів по периметру рами):
// так вогники сідають точно на малюнок, а позиції у відсотках
// не з'їжджають при ресайзі табло.
let chBulbsInit = false;
function initCashhuntBulbs() {
  if (chBulbsInit) return;
  chBulbsInit = true;
  const img = new Image();
  img.onload = () => {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c = cv.getContext('2d', { willReadFrequently: true });
      c.drawImage(img, 0, 0);
      const d = c.getImageData(0, 0, w, h).data;

      // Внутрішній «екран» рами — лампочок там нема, пропускаємо
      const ix0 = w * 0.135, ix1 = w * 0.865, iy0 = h * 0.10, iy1 = h * 0.885;
      const step = 2;                 // семпл через піксель — вистачає точності
      const rad2 = Math.pow(w * 0.016, 2); // радіус злиття ~ розмір лампочки
      const clusters = [];
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          if (x > ix0 && x < ix1 && y > iy0 && y < iy1) continue;
          const i = (y * w + x) * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          // яскравий жовтий: багато R і G, мало B
          if (!(r > 200 && g > 150 && b < 130)) continue;
          let best = null, bestD = rad2;
          for (const cl of clusters) {
            const dx = cl.cx - x, dy = cl.cy - y;
            const dd = dx * dx + dy * dy;
            if (dd < bestD) { bestD = dd; best = cl; }
          }
          if (best) {
            best.sx += x; best.sy += y; best.n++;
            best.cx = best.sx / best.n; best.cy = best.sy / best.n;
          } else {
            clusters.push({ sx: x, sy: y, n: 1, cx: x, cy: y });
          }
        }
      }
      // Дрібні кластери — блиски металу рами, а не лампочки
      const bulbs = clusters.filter(cl => cl.n >= 25)
        .map(cl => ({ x: cl.cx / w * 100, y: cl.cy / h * 100 }));
      if (!bulbs.length) return;

      // Сортуємо по куту навколо центру — щоб «біжучий вогонь» ішов по колу
      bulbs.sort((a, b) => Math.atan2(a.y - 50, a.x - 50) - Math.atan2(b.y - 50, b.x - 50));

      const area = document.getElementById('cashhunt-area');
      const els = bulbs.map((bp, i) => {
        const el = document.createElement('div');
        el.className = 'ch-bulb';
        el.style.left = bp.x.toFixed(2) + '%';
        el.style.top  = bp.y.toFixed(2) + '%';
        // випадкові фази/тривалості, щоб мерехтіння не було синхронним
        el.style.setProperty('--tw-dur', (1.2 + Math.random() * 1.4).toFixed(2) + 's');
        el.style.animationDelay = (-(i % 7) * 0.37).toFixed(2) + 's';
        area.appendChild(el);
        return el;
      });

      // «Біжучий вогонь» по колу, як у казино-маркізи (тільки клас → opacity)
      let run = 0;
      setInterval(() => {
        if (!document.getElementById('cashhunt-overlay').classList.contains('visible')) return;
        for (let k = 0; k < els.length; k++) {
          const off = ((k - run) % els.length + els.length) % els.length;
          els[k].classList.toggle('ch-run', off < 3);
        }
        run = (run + 1) % els.length;
      }, 110);
    } catch (e) { /* вогники — прикраса: збій аналізу не має валити гру */ }
  };
  img.src = '/assets/board.png';
}

(function() {
  // DOM-приціл замість canvas: анімації (ротація/пульс) живуть у CSS —
  // rAF-цикл не потрібен, JS лише рухає елемент і перемикає класи
  const xh = document.createElement('div');
  xh.id = 'cashhunt-crosshair';
  xh.innerHTML =
    '<div class="xh-ring"></div>' +
    '<div class="xh-ticks"><i></i><i></i><i></i><i></i></div>' +
    '<div class="xh-dot"></div>';
  document.body.appendChild(xh);

  let visible = false;
  let lastX = -1, lastY = -1;   // остання позиція миші — щоб приціл зʼявився одразу

  function show() { xh.classList.add('on'); visible = true; }
  function hide() { xh.classList.remove('on', 'locked'); visible = false; }

  const overlayEl = document.getElementById('cashhunt-overlay');

  document.addEventListener('mousemove', e => {
    lastX = e.clientX; lastY = e.clientY;
    xh.style.left = e.clientX + 'px';
    xh.style.top  = e.clientY + 'px';
    // Показуємо приціл лише всередині cashhunt-overlay під час вибору
    if (phase === 'selecting' && overlayEl.classList.contains('visible') && e.target.closest('#cashhunt-overlay')) {
      if (!visible) show();
      // «Захоплення цілі»: над живою клітинкою приціл стискається (CSS transition)
      xh.classList.toggle('locked', !!e.target.closest('#cashhunt-grid .cell:not(.dummy)'));
      /* гармата веде ствол за прицілом, ПОКИ вибір не завершено;
         після вибору клітинки вона лишається залоченою на цілі */
      const cannon = document.getElementById('cannon');
      if (cannon && selected.size < (currentGame ? currentGame.winnersNeeded : 1)) {
        cannon.classList.add('tracking');
        aimCannonAtPoint(e.clientX, e.clientY);
      } else if (cannon) {
        cannon.classList.remove('tracking');
      }
    } else {
      if (visible) hide();
    }
  });

  // Коли виходимо з оверлею — ховаємо курсор
  overlayEl.addEventListener('mouseleave', () => { if (visible) hide(); });

  /* selecting-mode вмикає cursor:none — приціл має зʼявитись ТОЇ Ж МИТІ,
     інакше поки глядач не зрушить мишу, на екрані нема ні курсора, ні прицілу.
     І навпаки: клас зняли — приціл ховаємо, навіть без руху миші */
  new MutationObserver(() => {
    const sel = overlayEl.classList.contains('selecting-mode');
    if (sel && !visible && lastX >= 0) {
      xh.style.left = lastX + 'px'; xh.style.top = lastY + 'px';
      show();
    } else if (!sel && visible) hide();
  }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });

  const boxEl = document.getElementById('main-box');
  const boxObs = new MutationObserver(() => {
    if (phase !== 'selecting') hide();
  });
  boxObs.observe(boxEl, { attributes: true, attributeFilter: ['class'] });
})();
