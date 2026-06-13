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
    background: #0e0e10;
    color: #e8e8e8;
    font-family: 'Rajdhani', sans-serif;
    min-height: 100vh;
    padding: 16px;
  }
  .topbar {
    max-width: 1400px; margin: 0 auto 16px;
    background: #1a1a1d; border: 1px solid #2a2a2e; border-radius: 12px;
    padding: 14px 20px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .topbar .title { font-size: 17px; color: #aaa; }
  .topbar .title b { color: #ffd700; font-size: 19px; letter-spacing: 1px; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-left:8px; background:#444; }
  .dot.open { background:#53fc18; box-shadow:0 0 8px #53fc18; }
  .dot.closed { background:#ff4444; }

  .layout {
    max-width: 1400px; margin: 0 auto;
    display: grid;
    grid-template-columns: 340px 1fr 340px;
    gap: 16px;
  }
  @media (max-width: 1100px) {
    .layout { grid-template-columns: 1fr; }
  }

  .col {
    background: #1a1a1d; border: 1px solid #2a2a2e; border-radius: 12px;
    padding: 18px 20px;
    display: flex; flex-direction: column;
    height: calc(100vh - 90px);
  }
  .col-title {
    font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 14px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .col-title .count { color: #ffd700; }

  /* ── Поля вводу ──────────────────────────── */
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .field-row { display: flex; gap: 10px; }
  .field.small { flex: 0 0 100px; }
  label.field-label { font-size: 12px; color: #999; }

  input[type=text], input[type=number] {
    background: #0e0e10; border: 1px solid #333; border-radius: 8px;
    padding: 10px 12px; color: #fff; font-family: 'Share Tech Mono', monospace;
    font-size: 14px; outline: none; transition: border-color 0.2s; width: 100%;
  }
  input:focus { border-color: #ffd700; }
  #raffle-cmd { color: #ffd700; }
  #winners-count, #confirm-seconds { text-align: center; }

  /* ── Перемикачі (toggle) ─────────────────── */
  .toggle-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .toggle-row .toggle-label { font-size: 14px; color: #ddd; flex: 1; }
  .switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; inset: 0;
    background: #333; border-radius: 22px; transition: 0.2s;
  }
  .slider:before {
    content: ''; position: absolute; height: 16px; width: 16px;
    left: 3px; bottom: 3px; background: #ccc; border-radius: 50%; transition: 0.2s;
  }
  .switch input:checked + .slider { background: #1a4a0a; }
  .switch input:checked + .slider:before { transform: translateX(18px); background: #53fc18; }

  /* ── Кнопки ──────────────────────────────── */
  button {
    padding: 10px 16px; border: none; border-radius: 8px; font-size: 14px;
    font-weight: 700; cursor: pointer; font-family: 'Rajdhani', sans-serif;
    letter-spacing: 0.5px; transition: opacity 0.2s, transform 0.1s;
  }
  button:hover  { opacity: 0.85; }
  button:active { transform: scale(0.97); }
  button:disabled { opacity: 0.25; cursor: not-allowed; }

  .btn-primary { background: #53fc18; color: #000; width: 100%; padding: 14px; font-size: 17px; }
  .btn-gold   { background: #ffd700; color: #000; }
  .btn-green  { background: #1a2a1a; color: #53fc18; border: 1px solid #2a5a2a; }
  .btn-orange { background: #e67e22; color: #fff; }
  .btn-red    { background: #c0392b; color: #fff; width: 100%; }
  .btn-dark   { background: #232327; color: #ccc; border: 1px solid #333; }
  .btn-small  { padding: 6px 12px; font-size: 12px; }

  .btn-row { display: flex; gap: 8px; margin-top: 8px; }
  .btn-row button { flex: 1; }

  .divider { height: 1px; background: #2a2a2e; margin: 14px 0; }

  /* ── Прогрес-бар лімиту ──────────────────── */
  .limit-info { font-size: 12px; color: #888; font-family: 'Share Tech Mono', monospace; margin-bottom: 6px; text-align: right; }
  .limit-info b { color: #ffd700; }
  .limit-bar-bg { background: #0e0e10; border-radius: 6px; height: 6px; overflow: hidden; margin-bottom: 14px; }
  .limit-bar { height: 100%; background: #53fc18; border-radius: 6px; transition: width 0.4s ease, background 0.4s ease; }

  #saved-msg, #test-msg { font-size: 11px; font-family: 'Share Tech Mono', monospace; color: #555; margin-top: 4px; display:block; }

  /* ── Тестова панель ──────────────────────── */
  details.test-section { margin-top: 14px; }
  details.test-section summary { font-size: 12px; color: #777; cursor: pointer; font-family: 'Share Tech Mono', monospace; }
  details.test-section .field-row { margin-top: 10px; }

  /* ── Середня колонка / box ───────────────── */
  .box {
    background: #0e0e10; border: 1px solid #2a2a2e; border-radius: 10px;
    flex: 1; min-height: 0; overflow-y: auto;
    padding: 8px;
    min-height: 200px;
  }
  .box::-webkit-scrollbar { width: 8px; }
  .box::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

  .participants-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
  }
  .participant-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-radius: 6px; font-size: 13px;
    color: #ddd;
  }
  .participant-row:nth-child(4n+1),
  .participant-row:nth-child(4n+2) { background: #161618; }
  .participant-row .p-num { color: #444; font-family: 'Share Tech Mono', monospace; font-size: 10px; width: 24px; flex-shrink: 0; }

  .empty-box { display: flex; align-items: center; justify-content: center; height: 100%; color: #444; font-size: 14px; font-family: 'Share Tech Mono', monospace; text-align: center; padding: 20px; }

  /* ── Сітка Cash Hunt ─────────────────────── */
  #hint { text-align: center; font-size: 14px; color: #aaa; margin: 12px 0 4px; font-family: 'Share Tech Mono', monospace; min-height: 18px; }
  #hint b { color: #ffd700; }
  #progress { text-align: center; font-size: 14px; color: #aaa; margin-bottom: 8px; font-family: 'Share Tech Mono', monospace; min-height: 18px; }
  #progress b { color: #ffd700; }

  .grid {
    display: grid;
    gap: 4px;
    justify-content: center;
    align-content: center;
    height: 100%;
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
  .cell.selected .cell-front {
    border-color: #ffd700;
    box-shadow: 0 0 14px rgba(255,215,0,0.7), inset 0 0 14px rgba(255,215,0,0.25);
  }
  .cell.selected .cell-front::after {
    content: '★'; position: absolute; top: 2px; right: 4px;
    font-size: 12px; color: #ffd700;
  }
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
  .selecting .cell { cursor: none; }
  .selecting .cell.selected { cursor: none; }
  .selecting * { cursor: none !important; }


  .revealing .cell, .done .cell { cursor: default; }

  /* ── Список переможців ──────────────────── */
  .winner-row {
    background: #161618; border: 1px solid #2a2a2e; border-radius: 8px;
    padding: 10px 12px; margin-bottom: 8px;
    animation: rowPop 0.3s ease;
  }
  @keyframes rowPop {
    from { transform: scale(0.95); opacity: 0; }
    to   { transform: scale(1); opacity: 1; }
  }
  .winner-row.confirmed { border-color: #2a5a2a; }
  .winner-row.expired   { border-color: #5a2a2a; }
  .winner-top { display: flex; align-items: center; gap: 8px; }
  .w-status { font-size: 15px; width: 22px; text-align: center; flex-shrink: 0; }
  .w-status.ok { color: #53fc18; }
  .w-status.pending { color: #ffaa00; font-family: 'Share Tech Mono', monospace; font-size: 13px; width: auto; }
  .w-status.bad { color: #ff4444; }
  .w-name { font-weight: 700; color: #ffd700; flex: 1; font-size: 15px; }
  .w-time { font-size: 11px; color: #666; font-family: 'Share Tech Mono', monospace; white-space: nowrap; }
  .w-msg {
    margin-top: 6px; font-size: 12px; color: #bbb; font-family: 'Share Tech Mono', monospace;
    background: #0e0e10; border-radius: 6px; padding: 6px 10px;
  }
  .w-msg.empty { color: #444; font-style: italic; }
  .w-retry { margin-top: 6px; }

  /* ── Оголошення переможця (оверлей) ──────── */
  #winner-announce {
    position: fixed; inset: 0; z-index: 9998;
    background: rgba(0,0,0,0.85);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px;
    opacity: 0; pointer-events: none;
    transition: opacity 0.4s ease;
    backdrop-filter: blur(6px);
  }
  #winner-announce.visible { opacity: 1; pointer-events: auto; }

  #winner-announce .wa-label {
    font-family: 'Share Tech Mono', monospace;
    font-size: 26px; color: #888; letter-spacing: 6px; text-transform: uppercase;
  }
  #winner-announce .wa-name {
    font-family: 'Rajdhani', sans-serif;
    font-size: clamp(48px, 6vw, 90px);
    font-weight: 900;
    color: #ffd700;
    text-shadow: 0 0 40px rgba(255,215,0,0.7), 0 0 80px rgba(255,215,0,0.3);
    letter-spacing: 3px;
    text-align: center;
    max-width: 90vw;
    word-break: break-word;
    animation: waNameIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both;
  }
  @keyframes waNameIn {
    from { transform: scale(0.6); opacity: 0; }
    to   { transform: scale(1);   opacity: 1; }
  }
  #winner-announce .wa-timer {
    font-family: 'Share Tech Mono', monospace;
    font-size: 48px;
    color: #fff;
    letter-spacing: 2px;
    min-width: 100px;
    text-align: center;
  }
  #winner-announce .wa-timer.expiring { color: #ff4444; animation: timerBlink 0.5s infinite alternate; }
  @keyframes timerBlink {
    from { opacity: 1; }
    to   { opacity: 0.3; }
  }
  #winner-announce .wa-msg {
    font-family: 'Share Tech Mono', monospace;
    font-size: 18px; color: #ccc;
    background: rgba(255,255,255,0.07);
    border-radius: 10px; padding: 10px 24px;
    max-width: 80vw; text-align: center;
    animation: waMsgIn 0.3s ease;
  }
  @keyframes waMsgIn {
    from { transform: translateY(10px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
  #winner-announce .wa-sub {
    font-size: 22px; color: #888; font-family: 'Share Tech Mono', monospace; letter-spacing: 3px;
  }
  #winner-announce .wa-close {
    margin-top: 8px;
    background: #1a1a1d; border: 1px solid #333; color: #888;
    padding: 10px 28px; border-radius: 8px;
    font-family: 'Rajdhani', sans-serif; font-size: 15px; font-weight: 700;
    cursor: pointer; transition: border-color 0.2s, color 0.2s;
  }
  #winner-announce .wa-close:hover { border-color: #ffd700; color: #ffd700; }

  /* Частинки */
  .wa-particle {
    position: fixed; pointer-events: none; border-radius: 50%; z-index: 9997;
    animation: waPart 1.8s ease forwards;
  }
  @keyframes waPart {
    from { transform: translate(0,0) scale(1); opacity: 1; }
    to   { transform: translate(var(--tx),var(--ty)) scale(0); opacity: 0; }
  }
</style>
</head>
<body>

<div class="topbar">
  <div class="title">🎁 <b>РОЗЫГРЫШ — CASH HUNT</b></div>
  <div class="title">kosteze231 <span class="dot closed" id="conn-dot"></span></div>
</div>

<div class="layout">

  <!-- ── Налаштування ──────────────────────── -->
  <div class="col">
    <div class="col-title">Настройки</div>

    <div class="field-row">
      <div class="field">
        <label class="field-label">Слово для участия</label>
        <input type="text" id="raffle-cmd" value="!призи" placeholder="!призи" onkeydown="if(event.key==='Enter')saveRaffleCmd()" onblur="saveRaffleCmd()">
      </div>
      <div class="field small">
        <label class="field-label">Победителей</label>
        <input type="number" id="winners-count" value="1" min="1" max="108">
      </div>
    </div>
    <span id="saved-msg"></span>

    <div class="toggle-row" style="margin-top:10px;">
      <span class="toggle-label">Регистрация открыта</span>
      <label class="switch">
        <input type="checkbox" id="toggle-reg" onchange="toggleRaffleAccepting()">
        <span class="slider"></span>
      </label>
    </div>

    <div class="toggle-row">
      <span class="toggle-label">Подтверждение победителя</span>
      <label class="switch">
        <input type="checkbox" id="toggle-confirm" checked onchange="toggleConfirmField()">
        <span class="slider"></span>
      </label>
    </div>
    <div id="confirm-time-field" style="overflow:hidden;transition:max-height 0.3s ease,opacity 0.3s ease;max-height:80px;opacity:1;">
      <div class="field" style="margin-top:6px;">
        <label class="field-label">Время на ответ (сек)</label>
        <input type="number" id="confirm-seconds" value="60" min="5" max="600">
      </div>
    </div>

    <div style="flex:1;"></div>

    <div class="limit-info">Участников: <b id="participant-count">0</b> / <span id="max-count">1000</span></div>
    <div class="limit-bar-bg"><div class="limit-bar" id="limit-bar" style="width:0%"></div></div>

    <button class="btn-primary" onclick="startGame()">🎯 Начать розыгрыш</button>

    <div class="btn-row">
      <button class="btn-dark" onclick="fastReroll()">⚡ Быстрый</button>
      <button class="btn-dark" onclick="downloadCSV()">⬇ CSV</button>
      <button class="btn-dark" onclick="resetRaffle()">🗑 Сброс</button>
    </div>

    <details class="test-section">
      <summary>🧪 Тестовые участники</summary>
      <div class="field-row">
        <input type="text" id="test-name" placeholder="имя тестового игрока" onkeydown="if(event.key==='Enter')addTestPlayer()">
        <button class="btn-green btn-small" onclick="addTestPlayer()">+1</button>
        <button class="btn-dark btn-small" onclick="addBulkTest()">+10</button>
      </div>
      <span id="test-msg"></span>
    </details>
  </div>

  <!-- ── Учасники / Гра ────────────────────── -->
  <div class="col">
    <div class="col-title">
      <span>Участники</span>
      <span class="count">(<span id="participants-count-title">0</span>)</span>
    </div>
    <div id="hint"></div>
    <div id="progress"></div>
    <div class="box" id="main-box">
      <div class="empty-box">Пока никто не зарегистрировался</div>
    </div>
    <div class="btn-row" id="game-controls" style="display:none;">
      <button class="btn-gold" id="btn-go" onclick="startReveal()" disabled>🚀 Начать раскрытие</button>
      <button class="btn-orange" onclick="reroll()">🔄 Рерол</button>
    </div>
  </div>

  <!-- ── Переможці ─────────────────────────── -->
  <div class="col">
    <div class="col-title">
      <span>Победители</span>
      <span class="count">(<span id="winners-count-title">0</span>)</span>
    </div>
    <div class="box" id="winners-box">
      <div class="empty-box">Победителей пока нет</div>
    </div>
    <button class="btn-red" style="margin-top:12px;" onclick="finishRaffle()">🏁 Финиш</button>
  </div>

</div>

<!-- Оголошення переможця -->
<div id="winner-announce">
  <div class="wa-label">🏆 Победитель</div>
  <div class="wa-name" id="wa-name">—</div>
  <div class="wa-timer" id="wa-timer"></div>
  <div class="wa-msg" id="wa-msg" style="display:none;"></div>
  <div class="wa-sub" id="wa-sub">Напишите любое сообщение в чате</div>
  <button class="wa-close" onclick="closeAnnounce()">Закрыть</button>
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
let winnersHistory = [];    // [{ name, time, status: 'ok'|'pending'|'bad', message }]

// ── Стан / реєстрація ─────────────────────────────────────────
async function loadState() {
  const res = await fetch('/api/raffle/state');
  if (res.status === 401) { location.reload(); return; }
  state = await res.json();

  const cmdInput = document.getElementById('raffle-cmd');
  if (document.activeElement !== cmdInput) cmdInput.value = state.joinCmd;

  document.getElementById('participant-count').textContent = state.count;
  document.getElementById('participants-count-title').textContent = state.count;
  document.getElementById('max-count').textContent = state.max || 1000;
  const pct = Math.min(100, (state.count / (state.max || 1000)) * 100);
  const bar = document.getElementById('limit-bar');
  bar.style.width = pct + '%';
  bar.style.background = state.count >= (state.max || 1000) ? '#ff4444' : state.count >= (state.max || 1000) * 0.8 ? '#ffaa00' : '#53fc18';

  const dot = document.getElementById('conn-dot');
  const toggle = document.getElementById('toggle-reg');
  toggle.checked = state.accepting;
  dot.className = 'dot ' + (state.accepting ? 'open' : 'closed');

  if (phase === 'idle') renderParticipants(state.participants);
}

function renderParticipants(list) {
  const box = document.getElementById('main-box');
  if (!list.length) {
    box.innerHTML = '<div class="empty-box">Пока никто не зарегистрировался</div>';
    return;
  }
  box.innerHTML = '<div class="participants-grid">' +
    list.map((name, i) =>
      '<div class="participant-row"><span class="p-num">' + (i+1) + '</span><span>' + escapeHtml(name) + '</span></div>'
    ).join('') + '</div>';
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
  if (!confirm('Сбросить список участников и победителей?')) return;
  await fetch('/api/raffle/reset', { method: 'POST' });
  winnersHistory = [];
  renderWinners();
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

// ── Гра Cash Hunt ─────────────────────────────────────────────
function resetGameUI() {
  currentGame = null;
  selected = new Set();
  phase = 'idle';
  document.getElementById('game-controls').style.display = 'none';
  document.getElementById('hint').textContent = '';
  document.getElementById('progress').textContent = '';
  renderParticipants(state.participants || []);
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
  renderGame(data.game);
}

async function reroll() {
  const res = await fetch('/api/raffle/reroll', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Ошибка');
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
  data.winners.forEach(name => addWinner(name));
}

function renderGame(game) {
  currentGame = game;
  selected = new Set();
  phase = 'selecting';

  const box = document.getElementById('main-box');
  box.innerHTML = '<div class="grid" id="grid"></div>';
  box.className = 'box selecting';
  const grid = document.getElementById('grid');

  const cols = game.gridSize <= 12 ? game.gridSize : 12;
  const cellSize = game.gridSize <= 12 ? 'min(70px, calc((100% - 40px) / ' + cols + '))' : '1fr';
  grid.style.gridTemplateColumns = game.gridSize <= 12
    ? 'repeat(' + cols + ', ' + cellSize + ')'
    : 'repeat(' + cols + ', 1fr)';

  document.getElementById('game-controls').style.display = 'flex';
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
  document.getElementById('main-box').className = 'box revealing';
  document.getElementById('hint').textContent = 'Раскрытие...';
  document.getElementById('btn-go').disabled = true;

  const allIdx = currentGame.cells.map((_, i) => i);
  const others = allIdx.filter(i => !selected.has(i)).sort(() => Math.random() - 0.5);
  const winnersOrder = [...selected].sort(() => Math.random() - 0.5);

  const cells = document.querySelectorAll('.cell');

  for (const idx of others) {
    cells[idx].classList.add('flipped', 'revealed');
    await sleep(35);
  }

  await sleep(600);

  const winners = [];
  for (let k = 0; k < winnersOrder.length; k++) {
    const idx = winnersOrder[k];
    const cell = cells[idx];
    cell.classList.add('flipped', 'revealed', 'winner');
    const name = currentGame.cells[idx];
    winners.push(name);
    document.getElementById('progress').innerHTML =
      'Найдено победителей: <b>' + winners.length + ' / ' + winnersOrder.length + '</b>';
    addWinner(name);
    await sleep(900);
  }

  phase = 'done';
  document.getElementById('main-box').className = 'box done';
  document.getElementById('hint').innerHTML = '🏁 Готово!';
  document.getElementById('btn-go').textContent = '🚀 Начать раскрытие';
}

// ── Список переможців ──────────────────────────────────────────
// ── Оголошення переможця ─────────────────────────────────────
let announceTimer = null;
let announceSeconds = 0;

function showAnnounce(name, seconds, confirmOn) {
  document.getElementById('wa-name').textContent = name;
  const timerEl = document.getElementById('wa-timer');
  const msgEl   = document.getElementById('wa-msg');
  const subEl   = document.getElementById('wa-sub');

  // Скидаємо попередній таймер
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
  if (document.getElementById('wa-name').textContent !== name) return;

  if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  const timerEl = document.getElementById('wa-timer');
  const msgEl   = document.getElementById('wa-msg');
  const subEl   = document.getElementById('wa-sub');

  timerEl.textContent = '✓';
  timerEl.className = 'wa-timer';
  timerEl.style.color = '#53fc18';
  subEl.style.display = 'none';
  msgEl.textContent = '💬 ' + message;
  msgEl.style.display = '';
}

function closeAnnounce() {
  document.getElementById('winner-announce').classList.remove('visible');
  if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
  document.getElementById('wa-timer').style.color = '';
}

function spawnParticles() {
  const colors = ['#ffd700','#ff9900','#53fc18','#fff','#ff44aa','#44aaff'];
  for (let i = 0; i < 24; i++) {
    const p = document.createElement('div');
    p.className = 'wa-particle';
    const size = 5 + Math.random() * 10;
    const angle = (Math.random() * 360) * Math.PI / 180;
    const dist  = 120 + Math.random() * 220;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist - 100;
    p.style.cssText =
      'width:' + size + 'px;height:' + size + 'px;' +
      'background:' + colors[Math.floor(Math.random()*colors.length)] + ';' +
      'left:' + (window.innerWidth/2 - size/2) + 'px;' +
      'top:' + (window.innerHeight/2 - size/2) + 'px;' +
      '--tx:' + tx + 'px;--ty:' + ty + 'px;' +
      'animation-duration:' + (1.2 + Math.random()*0.8) + 's;';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 2100);
  }
}

function addWinner(name) {
  const confirmOn = document.getElementById('toggle-confirm').checked;
  const seconds = parseInt(document.getElementById('confirm-seconds').value) || 60;
  const time = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

  const entry = { name, time, status: confirmOn ? 'pending' : 'ok', message: null };
  winnersHistory.unshift(entry);
  renderWinners();

  showAnnounce(name, seconds, confirmOn);

  if (confirmOn) {
    fetch('/api/raffle/check/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winner: name, seconds })
    });
    if (checkTimerInterval) clearInterval(checkTimerInterval);
    checkTimerInterval = setInterval(pollCheckState, 1000);
    pollCheckState();
  }
}

function renderWinners() {
  document.getElementById('winners-count-title').textContent = winnersHistory.length;
  const box = document.getElementById('winners-box');
  if (!winnersHistory.length) {
    box.innerHTML = '<div class="empty-box">Победителей пока нет</div>';
    return;
  }

  box.innerHTML = winnersHistory.map(w => {
    let statusHtml, rowClass = '';
    if (w.status === 'ok') {
      statusHtml = '<span class="w-status ok">✓</span>';
      rowClass = 'confirmed';
    } else if (w.status === 'bad') {
      statusHtml = '<span class="w-status bad">⏰</span>';
      rowClass = 'expired';
    } else {
      statusHtml = '<span class="w-status pending" data-name="' + escapeAttr(w.name) + '">…</span>';
    }

    let msgHtml = '';
    if (w.status === 'ok' && w.message) {
      msgHtml = '<div class="w-msg">' + escapeHtml(w.message) + '</div>';
    } else if (w.status === 'pending') {
      msgHtml = '<div class="w-msg empty">ожидание ответа...</div>';
    } else if (w.status === 'bad') {
      msgHtml = '<div class="w-msg empty">время вышло, ответа нет</div>' +
        '<button class="btn-dark btn-small w-retry" onclick="retryWinner(\\'' + escapeAttr(w.name) + '\\')">↻ Заново</button>';
    }

    return '<div class="winner-row ' + rowClass + '">' +
      '<div class="winner-top">' + statusHtml +
      '<span class="w-name">' + escapeHtml(w.name) + '</span>' +
      '<span class="w-time">' + w.time + '</span></div>' +
      msgHtml +
    '</div>';
  }).join('');
}

function escapeAttr(s) {
  return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}

async function pollCheckState() {
  const res = await fetch('/api/raffle/check/state');
  if (res.status === 401) return;
  const data = await res.json();

  let anyPending = false;
  let changed = false;

  winnersHistory.forEach(w => {
    if (w.status !== 'pending') return;
    const c = data.checks[w.name];
    if (!c) return;

    if (c.message !== null) {
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
  const seconds = parseInt(document.getElementById('confirm-seconds').value) || 60;
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

async function finishRaffle() {
  if (!confirm('Завершить розыгрыш? Регистрация будет закрыта, список победителей очищен.')) return;
  if (checkTimerInterval) clearInterval(checkTimerInterval);
  await fetch('/api/raffle/finish', { method: 'POST' });
  winnersHistory = [];
  renderWinners();
  closeAnnounce();
  resetGameUI();
  loadState();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

renderWinners();
loadState();
setInterval(() => { if (phase === 'idle') loadState(); }, 5000);

// ── Перемикач "Время на ответ" ─────────────────────────────────
function toggleConfirmField() {
  const on = document.getElementById('toggle-confirm').checked;
  const f = document.getElementById('confirm-time-field');
  f.style.maxHeight = on ? '80px' : '0px';
  f.style.opacity   = on ? '1' : '0';
}

// ── Прицільний курсор через Canvas ─────────────────────────────
(function() {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 48;
  canvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:9999;display:none;';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let mouseX = 0, mouseY = 0;
  let animId = null;
  let visible = false;
  let pulse = 0;

  function draw() {
    ctx.clearRect(0, 0, 48, 48);
    pulse += 0.08;
    const alpha = 0.75 + 0.25 * Math.sin(pulse);

    const cx = 24, cy = 24;
    const R = 14;

    // Зовнішнє коло
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,215,0,' + alpha + ')';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Внутрішнє коло маленьке
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,215,0,' + alpha + ')';
    ctx.fill();

    // Хрест — 4 відрізки з зазором
    const gap = 5, len = 7;
    ctx.strokeStyle = 'rgba(255,215,0,' + alpha + ')';
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    [[cx, cy - gap, cx, cy - gap - len],
     [cx, cy + gap, cx, cy + gap + len],
     [cx - gap, cy, cx - gap - len, cy],
     [cx + gap, cy, cx + gap + len, cy]].forEach(([x1,y1,x2,y2]) => {
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });
  }

  function loop() {
    if (!visible) return;
    draw();
    animId = requestAnimationFrame(loop);
  }

  function show() {
    canvas.style.display = 'block';
    visible = true;
    if (!animId) loop();
  }

  function hide() {
    canvas.style.display = 'none';
    visible = false;
    if (animId) { cancelAnimationFrame(animId); animId = null; }
  }

  document.addEventListener('mousemove', e => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    canvas.style.left = (mouseX - 24) + 'px';
    canvas.style.top  = (mouseY - 24) + 'px';
    // Показуємо/ховаємо залежно від фази
    if (phase === 'selecting') { if (!visible) show(); }
    else { if (visible) hide(); }
  });

  // MutationObserver — ховаємо одразу як фаза змінилась
  const boxEl = document.getElementById('main-box');
  const boxObs = new MutationObserver(() => {
    if (phase !== 'selecting') hide();
  });
  boxObs.observe(boxEl, { attributes: true, attributeFilter: ['class'] });
})();
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
