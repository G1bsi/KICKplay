import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Настройки ──────────────────────────────────────────────
const CHATROOM_ID = 235222;
const STATE_FILE  = path.join(__dirname, 'marble_state.json');
const MAX_PARTICIPANTS = 1000;

// Пароль береться з Environment Variables на Render:
//   Render Dashboard → твій сервіс → Environment → Add variable
//   Key: WEB_PASSWORD    Value: твій_пароль
const WEB_PASSWORD = process.env.WEB_PASSWORD;
if (!WEB_PASSWORD) {
  console.error('╔══════════════════════════════════════════════════╗');
  console.error('║  ОШИБКА: WEB_PASSWORD не задан!                ║');
  console.error('║  Render Dashboard → Environment → Add variable  ║');
  console.error('║  Key: WEB_PASSWORD   Value: твой_пароль          ║');
  console.error('╚══════════════════════════════════════════════════╝');
  process.exit(1);
}
// ───────────────────────────────────────────────────────────

const PUSHER_WS =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679' +
  '?protocol=7&client=js&version=8.4.0-rc2&flash=false';

// ── Розіграш (Cash Hunt) ─────────────────────────────────────
let rafflePlayers   = [];
let raffleAccepting = false;
let raffleJoinCmd   = '!призи';
let raffleGame      = null; // активна гра (не зберігається на диск)
let raffleChecks    = {};   // { username: { seconds, startedAt, active, message, messageAt } }

// Активні сесії (token → expiry)
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// ── Збереження стану ────────────────────────────────────────
function saveState() {
  const state = {
    rafflePlayers, raffleAccepting, raffleJoinCmd,
    savedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[STATE] Ошибка сохранения:', e.message);
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw   = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    rafflePlayers   = Array.isArray(state.rafflePlayers) ? state.rafflePlayers : [];
    raffleAccepting = typeof state.raffleAccepting === 'boolean' ? state.raffleAccepting : false;
    raffleJoinCmd   = state.raffleJoinCmd || '!призи';
    console.log(`[STATE] Восстановлено: ${rafflePlayers.length} участников, регистрация: ${raffleAccepting ? 'открыта' : 'закрыта'}`);
  } catch (e) {
    console.error('[STATE] Ошибка загрузки:', e.message);
  }
}

// Автозбереження кожні 30 секунд
setInterval(() => { if (rafflePlayers.length > 0) saveState(); }, 30000);

// ── Сторінка входу ──────────────────────────────────────────
const LOGIN_HTML = () => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kick Marbles — Вход</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;700&family=Share+Tech+Mono&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #fff;
    font-family: 'Share Tech Mono', monospace;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .box {
    background: #111;
    border: 1px solid #222;
    border-radius: 14px;
    padding: 40px;
    width: 320px;
    text-align: center;
  }
  h1 { font-family: 'Rajdhani', sans-serif; font-size: 22px; color: #53fc18; margin-bottom: 6px; }
  .sub { color: #444; font-size: 11px; margin-bottom: 28px; }
  input {
    width: 100%;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 11px 14px;
    color: #fff;
    font-family: 'Share Tech Mono', monospace;
    font-size: 14px;
    margin-bottom: 12px;
    outline: none;
    transition: border-color 0.2s;
  }
  input:focus { border-color: #53fc18; }
  button {
    width: 100%;
    background: #53fc18;
    color: #000;
    border: none;
    border-radius: 8px;
    padding: 11px;
    font-family: 'Rajdhani', sans-serif;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    letter-spacing: 0.5px;
    transition: opacity 0.2s;
  }
  button:hover { opacity: 0.85; }
  .err { color: #ff4444; font-size: 11px; margin-top: 10px; min-height: 16px; }
</style>
</head>
<body>
<div class="box">
  <h1>🎮 Marbles Bot</h1>
  <div class="sub">только для стримера</div>
  <input type="password" id="pw" placeholder="пароль..." onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">Войти</button>
  <div class="err" id="err"></div>
</div>
<script>
async function login() {
  const pw = document.getElementById('pw').value;
  if (!pw) return;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  if (res.ok) {
    const { token } = await res.json();
    document.cookie = 'session=' + token + '; path=/; max-age=86400; SameSite=Strict';
    location.reload();
  } else {
    const err = document.getElementById('err');
    err.textContent = 'Неверный пароль';
    setTimeout(() => err.textContent = '', 3000);
    document.getElementById('pw').value = '';
    document.getElementById('pw').focus();
  }
}
document.getElementById('pw').focus();
</script>
</body>
</html>`;

// ── Сторінка розіграшу (Cash Hunt) ───────────────────────────
const RAFFLE_HTML = () => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Розыгрыш — Cash Hunt</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700;900&family=Share+Tech+Mono&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #fff;
    font-family: 'Rajdhani', sans-serif;
    min-height: 100vh;
    padding: 20px;
  }
  .wrapper { width: 100%; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 26px; color: #ffd700; text-align: center; letter-spacing: 2px; margin-bottom: 4px; text-shadow: 0 0 20px rgba(255,215,0,0.3); }
  .sub { color: #444; font-size: 11px; margin-bottom: 18px; text-align: center; font-family: 'Share Tech Mono', monospace; }
  .back { display: block; text-align: center; margin-bottom: 16px; }
  .back a { color: #666; font-size: 12px; text-decoration: none; font-family: 'Share Tech Mono', monospace; }
  .back a:hover { color: #aaa; }

  .panel {
    background: #111;
    border: 1px solid #1e1e1e;
    border-radius: 10px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .panel-title { font-size: 11px; color: #444; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px; font-family: 'Share Tech Mono', monospace; }

  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .row:last-child { margin-bottom: 0; }

  input[type=text], input[type=number] {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 7px;
    padding: 8px 12px; color: #fff; font-family: 'Share Tech Mono', monospace;
    font-size: 14px; outline: none; transition: border-color 0.2s;
  }
  input:focus { border-color: #ffd700; }
  #raffle-cmd { color: #ffd700; width: 140px; text-align: center; }
  #winners-count { width: 80px; text-align: center; }

  button {
    padding: 9px 18px; border: none; border-radius: 7px; font-size: 14px;
    font-weight: 700; cursor: pointer; font-family: 'Rajdhani', sans-serif;
    letter-spacing: 0.5px; transition: opacity 0.2s, transform 0.1s;
  }
  button:hover  { opacity: 0.85; }
  button:active { transform: scale(0.97); }
  button:disabled { opacity: 0.25; cursor: not-allowed; }

  .btn-gold  { background: #ffd700; color: #000; }
  .btn-green { background: #1a2a1a; color: #53fc18; border: 1px solid #2a5a2a; }
  .btn-orange{ background: #e67e22; color: #fff; }
  .btn-red   { background: #c0392b; color: #fff; }
  .btn-dark  { background: #1e1e1e; color: #888; border: 1px solid #2a2a2a; }
  .btn-big   { padding: 14px 36px; font-size: 18px; }

  .status-badge {
    display: inline-block; padding: 3px 14px; border-radius: 20px;
    font-size: 12px; font-weight: 600; font-family: 'Share Tech Mono', monospace;
  }
  .status-badge.open   { background: #0d200d; color: #53fc18; border: 1px solid #2a5a2a; }
  .status-badge.closed { background: #200d0d; color: #ff4444; border: 1px solid #5a2a2a; }

  .count-display { font-size: 13px; color: #aaa; font-family: 'Share Tech Mono', monospace; }
  .count-display b { color: #ffd700; font-size: 18px; }

  .limit-bar-wrap { max-width: 400px; margin: 8px 0 0; }
  .limit-bar-bg { background: #1a1a1a; border-radius: 6px; height: 6px; overflow: hidden; }
  .limit-bar { height: 100%; background: #53fc18; border-radius: 6px; transition: width 0.4s ease, background 0.4s ease; }

  #saved-msg { font-size: 11px; font-family: 'Share Tech Mono', monospace; color: #555; }

  /* ── Сітка ────────────────────────────────── */
  #grid-wrap { display: none; }
  #grid-wrap.visible { display: block; }

  #hint { text-align: center; font-size: 14px; color: #aaa; margin-bottom: 12px; font-family: 'Share Tech Mono', monospace; }
  #hint b { color: #ffd700; }

  .grid {
    display: grid;
    gap: 4px;
    margin-bottom: 16px;
    justify-content: center;
  }

  .cell {
    aspect-ratio: 1;
    width: 100%;
    position: relative;
    cursor: pointer;
    perspective: 400px;
  }

  .cell-inner {
    width: 100%; height: 100%;
    position: relative;
    transform-style: preserve-3d;
    transition: transform 0.5s;
  }

  .cell.flipped .cell-inner { transform: rotateY(180deg); }

  .cell-face {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 6px;
    backface-visibility: hidden;
    font-family: 'Rajdhani', sans-serif;
    font-weight: 700;
    text-align: center;
    overflow: hidden;
    padding: 2px;
  }

  .cell-front {
    background: linear-gradient(145deg, #2a1e00, #1a1200);
    border: 2px solid #4a3a00;
    color: #ffd700;
    font-size: 22px;
    transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
  }

  .cell-back {
    transform: rotateY(180deg);
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    color: #ccc;
    font-size: 10px;
    line-height: 1.2;
    word-break: break-word;
  }

  /* Обрана клітинка (до розкриття) */
  .cell.selected .cell-front {
    border-color: #ffd700;
    box-shadow: 0 0 14px rgba(255,215,0,0.7), inset 0 0 14px rgba(255,215,0,0.25);
  }
  .cell.selected .cell-front::after {
    content: '★';
    position: absolute;
    top: 2px; right: 4px;
    font-size: 12px;
    color: #ffd700;
  }

  /* Переможна клітинка (після розкриття) */
  .cell.winner .cell-back {
    background: linear-gradient(145deg, #ffd700, #ff9900);
    border: 1px solid #ffec80;
    color: #000;
    font-weight: 900;
    animation: winnerGlow 0.6s ease infinite alternate;
  }

  @keyframes winnerGlow {
    from { box-shadow: 0 0 6px rgba(255,215,0,0.4); }
    to   { box-shadow: 0 0 16px rgba(255,215,0,0.9); }
  }

  .cell.revealed { cursor: default; }

  .selecting .cell:not(.selected):hover .cell-inner { transform: scale(1.07); }
  .selecting .cell { cursor: pointer; }
  .revealing .cell, .done .cell { cursor: default; }

  #progress { text-align: center; font-size: 14px; color: #aaa; margin-bottom: 14px; font-family: 'Share Tech Mono', monospace; min-height: 20px; }
  #progress b { color: #ffd700; }

  #winners-list {
    background: #111; border: 1px solid #1e1e1e; border-radius: 10px;
    padding: 16px; margin-top: 16px; display: none;
  }
  #winners-list.visible { display: block; }
  #winners-list h3 { color: #ffd700; font-size: 16px; margin-bottom: 10px; text-align: center; letter-spacing: 1px; }
  .winner-chip {
    display: inline-block; background: linear-gradient(145deg, #ffd700, #ff9900);
    color: #000; font-weight: 700; padding: 6px 16px; border-radius: 20px;
    margin: 4px; font-size: 14px;
    animation: chipPop 0.4s ease;
  }
  @keyframes chipPop {
    from { transform: scale(0); opacity: 0; }
    to   { transform: scale(1); opacity: 1; }
  }

  .game-controls { display: flex; gap: 10px; justify-content: center; margin-top: 16px; flex-wrap: wrap; }

  /* ── Перевірка переможців ────────────────── */
  .check-item {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    background: #161616; border: 1px solid #2a2a2a; border-radius: 8px;
    padding: 10px 14px; margin-bottom: 8px;
  }
  .check-item.responded { border-color: #2a5a2a; background: #0d180d; }
  .check-item.expired   { border-color: #5a2a2a; background: #1a0d0d; }
  .check-name { font-weight: 700; color: #ffd700; min-width: 140px; font-size: 15px; }
  .check-timer { font-family: 'Share Tech Mono', monospace; font-size: 20px; color: #aaa; min-width: 50px; }
  .check-timer.running { color: #53fc18; }
  .check-timer.expired { color: #ff4444; }
  .check-msg { font-family: 'Share Tech Mono', monospace; font-size: 13px; color: #ccc; background: #1a1a1a; border-radius: 6px; padding: 4px 10px; flex: 1; min-width: 120px; }
  .check-msg.empty { color: #444; font-style: italic; }
  .btn-check-start { background: #1a2a1a; color: #53fc18; border: 1px solid #2a5a2a; padding: 6px 14px; font-size: 13px; }
  .btn-check-retry { background: #1e1e1e; color: #888; border: 1px solid #2a2a2a; padding: 6px 14px; font-size: 12px; }

</style>
</head>
<body>
<div class="wrapper">
  <h1>🎁 РОЗЫГРЫШ — CASH HUNT</h1>
  <div class="sub">kosteze231</div>

  <div class="panel">
    <div class="panel-title">Регистрация участников</div>
    <div class="row">
      <span style="font-size:13px;color:#888;">слово для регистрации:</span>
      <input type="text" id="raffle-cmd" value="!призи" placeholder="!призи" onkeydown="if(event.key==='Enter')saveRaffleCmd()">
      <button class="btn-green" onclick="saveRaffleCmd()">✓ Сохранить</button>
      <span id="saved-msg"></span>
    </div>
    <div class="row">
      <span class="status-badge closed" id="raffle-status">● регистрация закрыта</span>
      <button class="btn-orange" id="btn-raffle-toggle" onclick="toggleRaffleAccepting()">▶ Открыть регистрацию</button>
      <button class="btn-red" onclick="resetRaffle()">🗑 Сбросить участников</button>
      <button class="btn-gold" onclick="downloadCSV()">⬇ Скачать CSV</button>
    </div>
    <div class="row">
      <span class="count-display">Участников: <b id="participant-count">0</b> / <span id="max-count">1000</span></span>
    </div>
    <div class="limit-bar-wrap">
      <div class="limit-bar-bg"><div class="limit-bar" id="limit-bar" style="width:0%"></div></div>
    </div>
    <div class="row">
      <span style="font-size:13px;color:#888;">🧪 тест:</span>
      <input type="text" id="test-name" placeholder="имя тестового игрока" onkeydown="if(event.key==='Enter')addTestPlayer()">
      <button class="btn-green" onclick="addTestPlayer()">+ Добавить</button>
      <button class="btn-dark" onclick="addBulkTest()">+10 случайных</button>
      <span id="test-msg"></span>
    </div>
  </div>

  <div class="panel">
    <div class="panel-title">Игра</div>
    <div class="row">
      <span style="font-size:13px;color:#888;">количество победителей:</span>
      <input type="number" id="winners-count" value="1" min="1" max="108">
      <button class="btn-gold btn-big" onclick="startGame()">🎯 НАЧАТЬ ИГРУ</button>
    </div>
    <div class="row">
      <button class="btn-dark" onclick="fastReroll()">⚡ Быстрый рерол (без игры)</button>
    </div>
  </div>

  <div id="hint"></div>
  <div id="progress"></div>

  <div id="grid-wrap">
    <div class="grid" id="grid"></div>
    <div class="game-controls">
      <button class="btn-gold" id="btn-go" onclick="startReveal()" disabled>🚀 Начать раскрытие</button>
      <button class="btn-orange" onclick="reroll()">🔄 Рерол (новая игра)</button>
      <button class="btn-dark" onclick="fastReroll()">⚡ Быстрый рерол</button>
    </div>
  </div>

  <div id="winners-list">
    <h3>🏆 ПОБЕДИТЕЛИ</h3>
    <div id="winners-chips"></div>
  </div>

  <div id="check-panel" class="panel" style="display:none;">
    <div class="panel-title">Проверка победителей</div>
    <div id="check-items"></div>
    <div class="game-controls">
      <button class="btn-orange" onclick="reroll()">🔄 Рерол (новая игра)</button>
      <button class="btn-red" onclick="finishRaffle()">🏁 Финиш</button>
    </div>
  </div>
</div>

<script>
let state = { joinCmd: '!призи', accepting: false, participants: [], count: 0, game: null };

const STICKERS = [
  '🍎','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥝','🍍','🥥','🍐','🍈',
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸',
  '🐵','🐔','🐧','🐦','🦄','🐝','🦋','🐢','🐙','🦀','🐳','🐬','🦓','🦒'
];

let checkTimerInterval = null;
let currentGame = null;     // { winnersNeeded, gridSize, cells }
let selected = new Set();   // індекси обраних клітинок
let phase = 'idle';         // idle | selecting | revealing | done

async function loadState() {
  const res = await fetch('/api/raffle/state');
  if (res.status === 401) { location.reload(); return; }
  state = await res.json();

  const cmdInput = document.getElementById('raffle-cmd');
  if (document.activeElement !== cmdInput) cmdInput.value = state.joinCmd;

  document.getElementById('participant-count').textContent = state.count;
  document.getElementById('max-count').textContent = state.max || 1000;
  const pct = Math.min(100, (state.count / (state.max || 1000)) * 100);
  const bar = document.getElementById('limit-bar');
  bar.style.width = pct + '%';
  bar.style.background = state.count >= (state.max || 1000) ? '#ff4444' : state.count >= (state.max || 1000) * 0.8 ? '#ffaa00' : '#53fc18';

  const badge = document.getElementById('raffle-status');
  const toggleBtn = document.getElementById('btn-raffle-toggle');
  if (state.accepting) {
    badge.textContent = '● регистрация открыта';
    badge.className = 'status-badge open';
    toggleBtn.textContent = '⏹ Закрыть регистрацию';
  } else {
    badge.textContent = '● регистрация закрыта';
    badge.className = 'status-badge closed';
    toggleBtn.textContent = '▶ Открыть регистрацию';
  }
}

function downloadCSV() {
  window.location.href = '/api/raffle/csv';
}

async function saveRaffleCmd() {
  const cmd = document.getElementById('raffle-cmd').value.trim();
  if (!cmd) return;
  const res = await fetch('/api/raffle/setcmd', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd })
  });
  const el = document.getElementById('saved-msg');
  el.style.color = res.ok ? '#53fc18' : '#ff4444';
  el.textContent = res.ok ? '✓ сохранено' : '✗ ошибка';
  setTimeout(() => el.textContent = '', 2000);
}

async function toggleRaffleAccepting() {
  await fetch('/api/raffle/toggle', { method: 'POST' });
  loadState();
}

async function resetRaffle() {
  if (!confirm('Сбросить список участников розыгрыша?')) return;
  await fetch('/api/raffle/reset', { method: 'POST' });
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
    el.style.color = '#53fc18';
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
    el.style.color = '#53fc18';
    el.textContent = '✓ добавлено ' + data.added + ' (всего: ' + data.count + ')';
  } else {
    el.style.color = '#ff4444';
    el.textContent = '✗ ошибка';
  }
  setTimeout(() => el.textContent = '', 2500);
  loadState();
}

function resetGameUI() {
  currentGame = null;
  selected = new Set();
  phase = 'idle';
  document.getElementById('grid-wrap').classList.remove('visible');
  document.getElementById('grid-wrap').className = 'grid-wrap';
  document.getElementById('grid-wrap').classList.remove('visible');
  document.getElementById('hint').textContent = '';
  document.getElementById('progress').textContent = '';
  document.getElementById('winners-list').classList.remove('visible');
  document.getElementById('check-panel').style.display = 'none';
  if (checkTimerInterval) { clearInterval(checkTimerInterval); checkTimerInterval = null; }
}

async function startGame() {
  const n = parseInt(document.getElementById('winners-count').value);
  if (!n || n < 1) return alert('Укажите количество победителей');
  const res = await fetch('/api/raffle/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winners: n })
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Ошибка');
  document.getElementById('winners-list').classList.remove('visible');
  renderGame(data.game);
}

async function reroll() {
  const res = await fetch('/api/raffle/reroll', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Ошибка');
  document.getElementById('winners-list').classList.remove('visible');
  renderGame(data.game);
}

async function fastReroll() {
  const n = currentGame ? currentGame.winnersNeeded : parseInt(document.getElementById('winners-count').value);
  if (!n || n < 1) return alert('Укажите количество победителей');
  const res = await fetch('/api/raffle/fastreroll', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winners: n })
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Ошибка');

  resetGameUI();
  showWinners(data.winners);
}

function renderGame(game) {
  currentGame = game;
  selected = new Set();
  phase = 'selecting';

  document.getElementById('check-panel').style.display = 'none';
  if (checkTimerInterval) { clearInterval(checkTimerInterval); checkTimerInterval = null; }

  const gridWrap = document.getElementById('grid-wrap');
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  gridWrap.classList.add('visible');
  gridWrap.className = 'visible selecting';

  // Розмір клітинки залежить від кількості — менше учасників = більші клітинки
  const cols = game.gridSize <= 12 ? game.gridSize : 12;
  const cellSize = game.gridSize <= 12 ? 'min(70px, calc((100vw - 80px) / ' + cols + '))' : '1fr';
  grid.style.gridTemplateColumns = game.gridSize <= 12
    ? 'repeat(' + cols + ', ' + cellSize + ')'
    : 'repeat(' + cols + ', 1fr)';

  document.getElementById('winners-list').classList.remove('visible');
  document.getElementById('btn-go').disabled = true;
  updateHint();
  document.getElementById('progress').textContent = '';

  game.cells.forEach((name, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.idx = i;
    const sticker = STICKERS[Math.floor(Math.random() * STICKERS.length)];
    cell.innerHTML =
      '<div class="cell-inner">' +
        '<div class="cell-face cell-front">' + sticker + '</div>' +
        '<div class="cell-face cell-back">' + escapeHtml(name) + '</div>' +
      '</div>';
    cell.addEventListener('click', () => onCellClick(i, cell));
    grid.appendChild(cell);
  });
}

function onCellClick(idx, cellEl) {
  if (phase !== 'selecting') return;

  if (selected.has(idx)) {
    selected.delete(idx);
    cellEl.classList.remove('selected');
  } else {
    if (selected.size >= currentGame.winnersNeeded) return;
    selected.add(idx);
    cellEl.classList.add('selected');
  }

  updateHint();
  document.getElementById('btn-go').disabled = selected.size !== currentGame.winnersNeeded;
}

function updateHint() {
  const n = currentGame.winnersNeeded;
  const hint = document.getElementById('hint');
  if (phase === 'selecting') {
    hint.innerHTML = 'Выберите <b>' + n + '</b> ' + (n === 1 ? 'клетку' : 'клеток') +
      ' — выбрано: <b>' + selected.size + ' / ' + n + '</b>';
  }
}

async function startReveal() {
  if (selected.size !== currentGame.winnersNeeded) return;
  phase = 'revealing';
  document.getElementById('grid-wrap').className = 'visible revealing';
  document.getElementById('hint').textContent = 'Раскрытие...';
  document.getElementById('btn-go').disabled = true;

  const allIdx = currentGame.cells.map((_, i) => i);
  const others = allIdx.filter(i => !selected.has(i)).sort(() => Math.random() - 0.5);
  const winnersOrder = [...selected].sort(() => Math.random() - 0.5);

  const cells = document.querySelectorAll('.cell');

  // 1. Швидко відкриваємо всі звичайні клітинки
  for (const idx of others) {
    cells[idx].classList.add('flipped', 'revealed');
    await sleep(35);
  }

  await sleep(600);

  // 2. Урочисто відкриваємо обрані (переможні) клітинки одна за одною
  const winners = [];
  for (let k = 0; k < winnersOrder.length; k++) {
    const idx = winnersOrder[k];
    const cell = cells[idx];
    cell.classList.add('flipped', 'revealed', 'winner');
    const name = currentGame.cells[idx];
    winners.push(name);
    document.getElementById('progress').innerHTML =
      'Найдено победителей: <b>' + winners.length + ' / ' + winnersOrder.length + '</b>';
    addWinnerChip(name);
    await sleep(900);
  }

  phase = 'done';
  document.getElementById('grid-wrap').className = 'visible done';
  document.getElementById('hint').innerHTML = '🏁 Готово!';
  document.getElementById('winners-list').classList.add('visible');
  showCheckPanel(winners);
}

function addWinnerChip(name) {
  const box = document.getElementById('winners-list');
  const chips = document.getElementById('winners-chips');
  box.classList.add('visible');
  const chip = document.createElement('span');
  chip.className = 'winner-chip';
  chip.textContent = '🏆 ' + name;
  chips.appendChild(chip);
}

function showWinners(winners) {
  const box = document.getElementById('winners-list');
  const chips = document.getElementById('winners-chips');
  chips.innerHTML = winners.map(w => '<span class="winner-chip">🏆 ' + escapeHtml(w) + '</span>').join('');
  box.classList.add('visible');
  showCheckPanel(winners);
}

// ── Перевірка відповіді переможців ───────────────────────────
function showCheckPanel(winners) {
  const panel = document.getElementById('check-panel');
  const items = document.getElementById('check-items');
  panel.style.display = 'block';
  items.innerHTML = '';

  winners.forEach(name => {
    const item = document.createElement('div');
    item.className = 'check-item';
    item.dataset.name = name;

    const nameEl = document.createElement('span');
    nameEl.className = 'check-name';
    nameEl.textContent = name;

    const timerEl = document.createElement('span');
    timerEl.className = 'check-timer';
    timerEl.textContent = '\u2014';

    const msgEl = document.createElement('span');
    msgEl.className = 'check-msg empty';
    msgEl.textContent = 'ожидание...';

    const secInput = document.createElement('input');
    secInput.type = 'number';
    secInput.value = '60';
    secInput.min = '5';
    secInput.max = '600';
    secInput.style.width = '60px';
    secInput.style.textAlign = 'center';

    const startBtn = document.createElement('button');
    startBtn.className = 'btn-check-start';
    startBtn.textContent = '\u25B6 Старт';
    startBtn.onclick = () => startCheckTimer(name, parseInt(secInput.value) || 60);

    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn-check-retry';
    retryBtn.textContent = '\u21BB Заново';
    retryBtn.onclick = () => retryCheck(name);

    item.append(nameEl, timerEl, msgEl, secInput, startBtn, retryBtn);
    items.appendChild(item);
  });

  if (checkTimerInterval) clearInterval(checkTimerInterval);
  checkTimerInterval = setInterval(pollCheckState, 1000);
  pollCheckState();
}

async function startCheckTimer(name, sec) {
  await fetch('/api/raffle/check/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winner: name, seconds: sec })
  });
  pollCheckState();
}

async function retryCheck(name) {
  await fetch('/api/raffle/check/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ winner: name })
  });
  const item = document.querySelector('.check-item[data-name="' + cssAttrEsc(name) + '"]');
  if (!item) return;
  item.className = 'check-item';
  const timerEl = item.querySelector('.check-timer');
  const msgEl = item.querySelector('.check-msg');
  timerEl.textContent = '\u2014';
  timerEl.className = 'check-timer';
  msgEl.textContent = 'ожидание...';
  msgEl.className = 'check-msg empty';
}

function cssAttrEsc(s) {
  return s.replace(/["\\\\]/g, '\\\\$&');
}

async function pollCheckState() {
  const res = await fetch('/api/raffle/check/state');
  if (res.status === 401) return;
  const data = await res.json();

  document.querySelectorAll('.check-item').forEach(item => {
    const name = item.querySelector('.check-name').textContent;
    const c = data.checks[name];
    if (!c) return;

    const timerEl = item.querySelector('.check-timer');
    const msgEl = item.querySelector('.check-msg');

    if (c.message !== null) {
      // Отримано відповідь
      item.className = 'check-item responded';
      timerEl.textContent = '✓';
      timerEl.className = 'check-timer';
      msgEl.textContent = c.message;
      msgEl.className = 'check-msg';
    } else if (c.active) {
      const elapsed = (Date.now() - c.startedAt) / 1000;
      const remaining = Math.max(0, Math.ceil(c.seconds - elapsed));
      timerEl.textContent = remaining + 'с';
      if (remaining > 0) {
        timerEl.className = 'check-timer running';
        msgEl.textContent = 'ожидание ответа...';
        msgEl.className = 'check-msg empty';
      } else {
        item.className = 'check-item expired';
        timerEl.textContent = '⏰';
        timerEl.className = 'check-timer expired';
        msgEl.textContent = 'время вышло, ответа нет';
        msgEl.className = 'check-msg empty';
      }
    }
  });
}

async function finishRaffle() {
  if (!confirm('Завершить розыгрыш? Регистрация будет закрыта.')) return;
  if (checkTimerInterval) clearInterval(checkTimerInterval);
  await fetch('/api/raffle/finish', { method: 'POST' });
  resetGameUI();
  document.getElementById('check-panel').style.display = 'none';
  loadState();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

loadState();
setInterval(() => { if (phase === 'idle') loadState(); }, 5000);
</script>
</body>
</html>`;

// ── Парсинг cookies ─────────────────────────────────────────
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v;
  }
  return null;
}

// ── HTTP сервер ─────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // Логін — відкритий маршрут
  if (req.url === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (password === WEB_PASSWORD) {
          const token = generateToken();
          sessions.set(token, Date.now() + 86400000); // 24 год
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token }));
        } else {
          // Затримка 1с щоб ускладнити брутфорс
          setTimeout(() => { res.writeHead(401); res.end(); }, 1000);
        }
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // Перевірка сесії для всіх інших маршрутів
  const token = getCookie(req, 'session');
  if (!isValidSession(token)) {
    if (req.url.startsWith('/api/')) {
      res.writeHead(401); res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_HTML());
    }
    return;
  }

  if (req.url === '/api/logout' && req.method === 'POST') {
    sessions.delete(token);
    res.writeHead(200); res.end();
    return;
  }

  // ── Розіграш (Cash Hunt) API ────────────────────────────────
  if (req.url === '/api/raffle/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      joinCmd: raffleJoinCmd,
      accepting: raffleAccepting,
      participants: rafflePlayers,
      count: rafflePlayers.length,
      max: MAX_PARTICIPANTS,
      game: raffleGame,
    }));
    return;
  }

  if (req.url === '/api/raffle/csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="participants.csv"'
    });
    res.end(rafflePlayers.join('\n'));
    return;
  }


  if (req.url === '/api/raffle/setcmd' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { cmd } = JSON.parse(body);
        const trimmed = (cmd || '').trim().toLowerCase();
        if (!trimmed || trimmed.length > 30) { res.writeHead(400); res.end(); return; }
        raffleJoinCmd = trimmed;
        saveState();
        console.log('[РОЗІГРАШ] Слово реєстрації: ' + raffleJoinCmd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cmd: raffleJoinCmd }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/toggle' && req.method === 'POST') {
    raffleAccepting = !raffleAccepting;
    saveState();
    console.log('[РОЗІГРАШ] Реєстрація ' + (raffleAccepting ? 'ВІДКРИТА' : 'ЗАКРИТА'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, accepting: raffleAccepting }));
    return;
  }

  if (req.url === '/api/raffle/reset' && req.method === 'POST') {
    rafflePlayers = [];
    raffleAccepting = false;
    raffleGame = null;
    saveState();
    console.log('[РОЗІГРАШ] Список учасників очищено');
    res.writeHead(200); res.end();
    return;
  }

  if (req.url === '/api/raffle/addtest' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        const trimmed = (name || '').trim();
        if (!trimmed) { res.writeHead(400); res.end(JSON.stringify({ error: 'Введите имя' })); return; }
        if (rafflePlayers.includes(trimmed)) { res.writeHead(200); res.end(JSON.stringify({ error: 'Уже в списке' })); return; }
        rafflePlayers.push(trimmed);
        saveState();
        console.log(`[РОЗІГРАШ +тест] ${trimmed} (${rafflePlayers.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: rafflePlayers.length }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/addbulk' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { count } = JSON.parse(body);
        const n = Math.min(Math.max(parseInt(count) || 0, 1), 200);
        let added = 0;
        for (let i = 0; i < n; i++) {
          let name;
          do {
            name = 'Тестер' + Math.floor(Math.random() * 100000);
          } while (rafflePlayers.includes(name));
          rafflePlayers.push(name);
          added++;
        }
        saveState();
        console.log(`[РОЗІГРАШ +тест] добавлено ${added} тестовых участников (всего: ${rafflePlayers.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, added, count: rafflePlayers.length }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // ── Перевірка відповіді переможця ───────────────────────────
  if (req.url === '/api/raffle/check/start' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { winner, seconds } = JSON.parse(body);
        const w = (winner || '').trim();
        const sec = Math.min(Math.max(parseInt(seconds) || 60, 5), 600);
        if (!w) { res.writeHead(400); res.end(); return; }
        raffleChecks[w] = { seconds: sec, startedAt: Date.now(), active: true, message: null, messageAt: null };
        console.log(`[РОЗІГРАШ] Таймер запущен для ${w} (${sec}с)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/check/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ checks: raffleChecks }));
    return;
  }

  if (req.url === '/api/raffle/check/reset' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { winner } = JSON.parse(body);
        const w = (winner || '').trim();
        if (w) delete raffleChecks[w];
        res.writeHead(200); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/finish' && req.method === 'POST') {
    raffleGame = null;
    raffleChecks = {};
    raffleAccepting = false;
    saveState();
    console.log('[РОЗІГРАШ] Завершено');
    res.writeHead(200); res.end();
    return;
  }

  if (req.url === '/api/raffle/start' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { winners } = JSON.parse(body);
        const n = parseInt(winners);
        if (!rafflePlayers.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'Немає учасників' })); return; }
        const gridSize = Math.min(rafflePlayers.length, 108);
        if (!n || n < 1 || n > gridSize) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Некоректна кількість переможців (макс ' + gridSize + ')' })); return;
        }
        raffleGame = buildRaffleGame(n);
        console.log(`[РОЗІГРАШ] Гра запущена: ${n} переможців з ${rafflePlayers.length} учасників`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, game: raffleGame }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/reroll' && req.method === 'POST') {
    if (!raffleGame) { res.writeHead(400); res.end(JSON.stringify({ error: 'Гра не запущена' })); return; }
    const n = raffleGame.winnersNeeded;
    raffleGame = buildRaffleGame(n);
    console.log(`[РОЗІГРАШ] Рерол: нова гра, ${n} переможців`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, game: raffleGame }));
    return;
  }

  if (req.url === '/api/raffle/fastreroll' && req.method === 'POST') {
    const n = raffleGame ? raffleGame.winnersNeeded :
      (() => { return null; })();
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const count = parseInt(parsed.winners) || n;
        if (!rafflePlayers.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'Немає учасників' })); return; }
        if (!count || count < 1 || count > rafflePlayers.length) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Некоректна кількість переможців' })); return;
        }
        const shuffled = [...rafflePlayers].sort(() => Math.random() - 0.5);
        const winnersList = shuffled.slice(0, count);
        raffleGame = { winnersNeeded: count, cells: null, winners: winnersList, fast: true };
        console.log(`[РОЗІГРАШ] Швидкий рерол: ${winnersList.join(', ')}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, winners: winnersList }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(RAFFLE_HTML());
});

// Генерує сітку: до 108 клітинок із учасниками (рандом, якщо їх більше 108)
function buildRaffleGame(n) {
  const shuffled = [...rafflePlayers].sort(() => Math.random() - 0.5);
  const gridSize = Math.min(shuffled.length, 108);
  const cells = shuffled.slice(0, gridSize); // масив ніків — по одному на клітинку

  return {
    winnersNeeded: n,
    gridSize,
    cells,
  };
}


server.listen(process.env.PORT || 3000, () => {
  console.log(`[WEB] Сервер запущен на порту ${process.env.PORT || 3000}`);
});

// ── Kick WebSocket ──────────────────────────────────────────
function connect() {
  const ws = new WebSocket(PUSHER_WS);
  let pingInterval = null;

  ws.on('open', () => {
    console.log('[WS] Подключено к Kick Pusher');
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${CHATROOM_ID}.v2` }
    }));
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    }, 30000);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.event === 'pusher:ping') {
      ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      return;
    }

    if (msg.event === 'pusher_internal:subscription_succeeded') {
      console.log(`[WS] Подписка на chatroom ${CHATROOM_ID} активна`);
      console.log('[BOT] Бот работает! Жду команды в чате...\n');
      return;
    }

    if (msg.event === 'App\\Events\\ChatMessageEvent') {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }

      const username = data?.sender?.username;
      const content  = data?.content?.trim();
      if (!username || !content) return;

      const lower = content.toLowerCase();

      // Перевірка відповіді переможця розіграшу (працює завжди, незалежно від інших команд)
      const check = raffleChecks[username];
      if (check && check.active) {
        check.active = false;
        check.message = content;
        check.messageAt = Date.now();
        console.log(`[РОЗІГРАШ✓] ${username} ответил: ${content}`);
      }

      if (raffleAccepting && lower === raffleJoinCmd) {
        if (rafflePlayers.length >= MAX_PARTICIPANTS) {
          raffleAccepting = false;
          saveState();
          console.log(`[РОЗІГРАШ] Лимит ${MAX_PARTICIPANTS} достигнут — регистрация закрыта`);
          return;
        }
        if (!rafflePlayers.includes(username)) {
          rafflePlayers.push(username);
          saveState();
          console.log(`[РОЗІГРАШ +] ${username} (${rafflePlayers.length}/${MAX_PARTICIPANTS})`);
          if (rafflePlayers.length >= MAX_PARTICIPANTS) {
            raffleAccepting = false;
            saveState();
            console.log(`[РОЗІГРАШ] Лимит ${MAX_PARTICIPANTS} достигнут — регистрация закрыта`);
          }
        }
        return;
      }
    }
  });

  ws.on('error', (err) => console.error('[WS] Ошибка:', err.message));

  ws.on('close', () => {
    if (pingInterval) clearInterval(pingInterval);
    console.log('[WS] Соединение закрыто, переподключение через 5с...');
    setTimeout(connect, 5000);
  });
}

// ── Старт ───────────────────────────────────────────────────
console.log('╔══════════════════════════════════════╗');
console.log('║   Kick Cash Hunt — Розыгрыш BOT      ║');
console.log('╠══════════════════════════════════════╣');
console.log(`║  Chatroom: ${CHATROOM_ID}                  ║`);
console.log(`║  Лимит участников: ${MAX_PARTICIPANTS}            ║`);
console.log('║  Защита: пароль через env variable   ║');
console.log('╚══════════════════════════════════════╝\n');

loadState();
connect();
