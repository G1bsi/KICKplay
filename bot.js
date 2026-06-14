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
let raffleJoinCmd   = '';
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
    raffleJoinCmd   = state.raffleJoinCmd || '';
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
    grid-template-columns: 340px 1fr;
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

  /* ── Перемикач режиму гри ─────────────────── */
  .mode-switch { display: flex; gap: 8px; }
  .mode-btn {
    flex: 1; padding: 9px 10px; border-radius: 8px; border: 1px solid #333;
    background: #0e0e10; color: #888; font-size: 13px; font-weight: 700;
    font-family: 'Rajdhani', sans-serif; cursor: pointer; transition: all 0.2s;
  }
  .mode-btn:hover { border-color: #555; color: #ccc; }
  .mode-btn.active { background: #1a2a1a; border-color: #53fc18; color: #53fc18; }
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
  .switch input:disabled + .slider { opacity: 0.35; cursor: not-allowed; }
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
  .limit-info { font-size: 12px; color: #888; font-family: 'Share Tech Mono', monospace; margin-bottom: 12px; text-align: right; }
  .limit-info b { color: #ffd700; }

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
    grid-template-columns: 1fr 1fr 1fr;
    gap: 2px;
  }
  .participant-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-radius: 6px; font-size: 13px;
    color: #ddd;
  }
  .participant-row:nth-child(6n+1),
  .participant-row:nth-child(6n+2),
  .participant-row:nth-child(6n+3) { background: #161618; }
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

  /* ── Гонка (3D) ───────────────────────────── */
  #race-overlay {
    position: fixed; inset: 0; z-index: 9990;
    background: rgba(5,5,8,0.94);
    display: none;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 14px;
    backdrop-filter: blur(4px);
  }
  #race-overlay.visible { display: flex; }
  #race-overlay-hint {
    font-family: 'Share Tech Mono', monospace;
    font-size: 20px; color: #ffd700; letter-spacing: 2px;
    min-height: 28px; text-align: center;
  }
  #race-track-area {
    width: min(98vw, 1560px);
    aspect-ratio: 12 / 7;
    max-height: 90vh;
    position: relative;
    background: #0a0a0c;
    border: 1px solid #2a2a2e;
    border-radius: 14px;
    overflow: hidden;
  }
  #race-track-area canvas {
    width: 100% !important; height: 100% !important; display: block;
  }
  #race-overlay-controls { display: flex; gap: 10px; }
  #race-overlay-controls button { min-width: 140px; }
  .race-close-btn {
    position: absolute; top: -50px; right: 0; z-index: 4;
    background: #1a1a1d; border: 1px solid #333; color: #888;
    width: 38px; height: 38px; border-radius: 8px;
    font-size: 18px; line-height: 1; cursor: pointer;
  }
  .race-close-btn:hover { border-color: #ff4444; color: #ff4444; }

  #race-labels { position: absolute; inset: 0; pointer-events: none; z-index: 2; }

  #race-standings {
    position: absolute; top: 12px; left: 12px; z-index: 4;
    width: 190px; max-height: calc(100% - 24px);
    background: rgba(15,15,15,0.88);
    border-left: 5px solid #e10600;
    border-radius: 8px;
    padding: 10px 12px;
    font-family: 'Rajdhani', sans-serif;
    overflow-y: auto;
    pointer-events: none;
  }
  .standings-title {
    font-size: 14px; font-weight: 900; color: #fff;
    text-transform: uppercase; letter-spacing: 1px;
    border-bottom: 2px solid #333;
    padding-bottom: 10px; margin-bottom: 8px;
  }
  .standing-row {
    display: flex; align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    font-weight: 600; font-size: 14px; color: #fff;
  }
  .standing-row.winner { color: #ffd700; }
  .standing-pos {
    width: 25px; text-align: center; margin-right: 10px;
    color: #aaa; font-size: 12px; flex-shrink: 0;
  }
  .standing-row.winner .standing-pos { color: #ffd700; }
  .standing-swatch {
    width: 8px; height: 16px; margin-right: 12px; border-radius: 2px; flex-shrink: 0;
  }
  .standing-name {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0; letter-spacing: 0.5px;
  }
  .standing-lap { font-size: 12px; color: #888; flex-shrink: 0; }
  .standing-row.winner .standing-lap { color: #ffd700; }

  .car-label-3d {
    position: absolute; transform: translate(-50%, -100%);
    background: rgba(10,10,10,0.85); color: #fff;
    padding: 4px 10px; border-radius: 6px;
    font-size: 13px; font-weight: 800;
    text-transform: uppercase; letter-spacing: 0.5px;
    white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis;
    font-family: 'Rajdhani', sans-serif;
    border-bottom: 3px solid var(--car-color, #888);
    box-shadow: 0 3px 8px rgba(0,0,0,0.6);
    transition: left 0.05s linear, top 0.05s linear;
  }
  .car-label-3d.winner {
    background: #ffd700; color: #000; border-bottom-color: #ffd700;
    animation: winnerGlow 0.6s ease infinite alternate;
  }

  #race-countdown {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 110px; font-weight: 900; color: #ffd700;
    font-family: 'Rajdhani', sans-serif;
    text-shadow: 0 0 40px rgba(255,215,0,0.6);
    z-index: 3;
    pointer-events: none;
  }
  #race-countdown.pulse { animation: countdownPulse 0.9s ease; }
  @keyframes countdownPulse {
    from { transform: scale(1.6); opacity: 0; }
    to   { transform: scale(1);   opacity: 1; }
  }

  /* ── Рулетка ──────────────────────────────── */
  #roulette-overlay {
    position: fixed; inset: 0; z-index: 9990;
    background: rgba(5,5,8,0.94);
    display: none;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 18px;
    backdrop-filter: blur(4px);
  }
  #roulette-overlay.visible { display: flex; }
  #roulette-overlay-hint {
    font-family: 'Share Tech Mono', monospace;
    font-size: 20px; color: #ffd700; letter-spacing: 2px;
    min-height: 28px; text-align: center;
  }
  #roulette-track-area {
    width: min(90vw, 1100px);
    position: relative;
    padding: 40px 0;
  }
  #roulette-track {
    width: 100%; height: 140px;
    background: linear-gradient(180deg, #161618, #0c0c0e);
    border: 1px solid #2a2a2e;
    border-radius: 14px;
    overflow: hidden;
    position: relative;
    box-shadow: inset 0 0 40px rgba(0,0,0,0.6);
  }
  #roulette-track::before, #roulette-track::after {
    content: ''; position: absolute; top: 0; bottom: 0; width: 80px; z-index: 5;
    pointer-events: none;
  }
  #roulette-track::before { left: 0; background: linear-gradient(90deg, #0c0c0e, transparent); }
  #roulette-track::after  { right: 0; background: linear-gradient(270deg, #0c0c0e, transparent); }
  #roulette-strip {
    display: flex; align-items: center; height: 100%;
    position: absolute; left: 0; top: 0;
    will-change: transform;
  }
  .roulette-cell {
    flex: 0 0 180px; height: 100%;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 22px;
    color: #ccc;
    border-right: 1px solid #232327;
    text-align: center; padding: 0 14px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .roulette-cell.win {
    color: #000; background: linear-gradient(145deg, #ffd700, #ff9900);
    font-weight: 900;
    animation: winnerGlow 0.6s ease infinite alternate;
  }
  #roulette-pointer {
    position: absolute; left: 50%; top: 12px; bottom: 12px;
    width: 4px; background: #ffd700; transform: translateX(-50%);
    z-index: 6; border-radius: 2px;
    box-shadow: 0 0 12px rgba(255,215,0,0.8);
  }
  #roulette-pointer::before, #roulette-pointer::after {
    content: ''; position: absolute; left: 50%; transform: translateX(-50%);
    border: 8px solid transparent;
  }
  #roulette-pointer::before { top: -8px; border-top: none; border-bottom-color: #ffd700; }
  #roulette-pointer::after  { bottom: -8px; border-bottom: none; border-top-color: #ffd700; }
  #roulette-overlay-controls { display: flex; gap: 10px; }
  #roulette-overlay-controls button { min-width: 140px; }

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
    font-family: 'Rajdhani', sans-serif;
    font-size: clamp(28px, 3.5vw, 52px); font-weight: 700; color: #fff;
    background: rgba(255,255,255,0.06);
    border-radius: 12px; padding: 14px 32px;
    max-width: 85vw; text-align: center;
    letter-spacing: 1px;
    animation: waMsgIn 0.4s cubic-bezier(0.34,1.56,0.64,1);
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
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
</head>
<body>

<div class="topbar" style="justify-content:flex-end;">
  <div class="title">kosteze231 <span class="dot closed" id="conn-dot"></span></div>
</div>

<div class="layout">

  <!-- ── Налаштування ──────────────────────── -->
  <div class="col">
    <div class="col-title">Настройки</div>

    <div class="field-row">
      <div class="field">
        <label class="field-label">Слово для участия</label>
        <input type="text" id="raffle-cmd" value="" placeholder="буц" onkeydown="if(event.key==='Enter')saveRaffleCmd()">
        <button type="button" id="btn-reg-toggle" class="btn-green" style="margin-top:6px;" onclick="toggleRegistration()">▶ Начать регистрацию</button>
      </div>
      <div class="field small">
        <label class="field-label">Победителей</label>
        <input type="number" id="winners-count" value="1" min="1" max="108">
      </div>
    </div>
    <span id="saved-msg"></span>

    <div class="field" style="margin-top:6px;">
      <label class="field-label">Режим игры</label>
      <div class="mode-switch">
        <button type="button" class="mode-btn" id="mode-btn-roulette" onclick="setGameMode('roulette')">🎰 Дефолт</button>
        <button type="button" class="mode-btn" id="mode-btn-race" onclick="setGameMode('race')">🏎️ Гонка</button>
        <button type="button" class="mode-btn active" id="mode-btn-cashhunt" onclick="setGameMode('cashhunt')">🎯 Cash Hunt</button>
      </div>
    </div>

    <div id="race-count-field" style="display:none;">
      <div class="field-row" style="margin-top:6px;">
        <div class="field">
          <label class="field-label">Участников гонки (2–15)</label>
          <input type="number" id="race-count" value="12" min="2" max="15">
        </div>
        <div class="field small">
          <label class="field-label">Кругов</label>
          <input type="number" id="race-laps" value="3" min="1" max="20">
        </div>
      </div>
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

    <div class="limit-info" style="margin-top:6px;">Участников: <b id="participant-count">0</b></div>

    <button class="btn-primary" onclick="startGame()">🎯 Начать розыгрыш</button>

    <div class="btn-row">
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

    <div class="col-title" style="margin-top:14px;">
      <span>Победители</span>
      <span class="count">(<span id="winners-count-title">0</span>)</span>
    </div>
    <div class="box" id="winners-box" style="flex:1;">
      <div class="empty-box">Победителей пока нет</div>
    </div>
    <button class="btn-red" style="margin-top:12px;" onclick="finishRaffle()">🏁 Финиш</button>
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

<!-- Оверлей гонки -->
<div id="race-overlay">
  <div id="race-overlay-hint"></div>
  <div id="race-track-area">
    <button class="race-close-btn" onclick="closeRaceOverlay()">✕</button>
    <div id="race-standings"></div>
  </div>
  <div id="race-overlay-controls" style="display:none;">
    <button class="btn-orange" onclick="reroll()">🔄 Рерол</button>
    <button class="btn-dark" onclick="fastReroll()">⚡ Быстрый рерол</button>
    <button class="btn-dark" onclick="closeRaceOverlay()">Закрыть</button>
  </div>
</div>

<!-- Оверлей рулетки -->
<div id="roulette-overlay">
  <div id="roulette-overlay-hint"></div>
  <div id="roulette-track-area">
    <button class="race-close-btn" onclick="closeRouletteOverlay()">✕</button>
    <div id="roulette-pointer"></div>
    <div id="roulette-track">
      <div id="roulette-strip"></div>
    </div>
  </div>
  <div id="roulette-overlay-controls" style="display:none;">
    <button class="btn-orange" onclick="reroll()">🔄 Рерол</button>
    <button class="btn-dark" onclick="fastReroll()">⚡ Быстрый рерол</button>
    <button class="btn-dark" onclick="closeRouletteOverlay()">Закрыть</button>
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
let winnersHistory = [];    // [{ name, time, status: 'ok'|'pending'|'bad', message }]

// ── Стан / реєстрація ─────────────────────────────────────────
async function loadState() {
  const res = await fetch('/api/raffle/state');
  if (res.status === 401) { location.reload(); return; }
  state = await res.json();

  const cmdInput = document.getElementById('raffle-cmd');
  if (document.activeElement !== cmdInput) {
    cmdInput.value = state.joinCmd || '';
  }
  raffleOpen = state.accepting;

  document.getElementById('participant-count').textContent = state.count;
  document.getElementById('participants-count-title').textContent = state.count;
  document.getElementById('conn-dot').className = 'dot ' + (state.accepting ? 'open' : 'closed');

  const regBtn = document.getElementById('btn-reg-toggle');
  if (raffleOpen) {
    regBtn.textContent = '⏹ Завершить регистрацию';
    regBtn.className = 'btn-red';
    cmdInput.disabled = true;
  } else {
    regBtn.textContent = '▶ Начать регистрацию';
    regBtn.className = 'btn-green';
    cmdInput.disabled = false;
  }

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

let raffleOpen = false;

async function saveRaffleCmd() {
  const cmd = document.getElementById('raffle-cmd').value.trim();
  if (!cmd) return false;
  const res = await fetch('/api/raffle/setcmd', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd })
  });
  const el = document.getElementById('saved-msg');
  el.style.color = res.ok ? '#53fc18' : '#ff4444';
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
// ── Режим гри (Cash Hunt / Гонка) ────────────────────────────
let gameMode = 'cashhunt';
let raceQualifiers = [];
let raceAnimId = null;

function setGameMode(mode) {
  if (phase !== 'idle') return; // не можна перемкнути під час гри
  gameMode = mode;
  document.getElementById('mode-btn-cashhunt').classList.toggle('active', mode === 'cashhunt');
  document.getElementById('mode-btn-race').classList.toggle('active', mode === 'race');
  document.getElementById('mode-btn-roulette').classList.toggle('active', mode === 'roulette');
  document.getElementById('race-count-field').style.display = mode === 'race' ? 'block' : 'none';
  document.querySelector('#winners-count').closest('.field').style.display = mode === 'cashhunt' ? '' : 'none';
  hideRaceOverlay();
  hideRouletteOverlay();
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
  document.getElementById('game-controls').style.display = 'none';
  document.getElementById('hint').textContent = '';
  document.getElementById('progress').textContent = '';
  document.getElementById('main-box').className = 'box';
  renderParticipants(state.participants || []);
}

async function startGame() {
  if (gameMode === 'race') return startRaceGame();
  if (gameMode === 'roulette') return startRoulette();

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
  if (gameMode === 'race') {
    const n = raceQualifiers.length || Math.min(parseInt(document.getElementById('race-count').value) || 12, state.participants.length);
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
  renderGame(data.game);
}

async function fastReroll() {
  if (gameMode === 'race') {
    let qualifiers = raceQualifiers;
    if (!qualifiers.length) {
      const n = Math.min(parseInt(document.getElementById('race-count').value) || 12, state.participants.length);
      if (n < 2) return alert('Нужно минимум 2 участника');
      qualifiers = pickRandom(state.participants, n);
    }
    hideRaceOverlay();
    resetGameUIKeepMode();
    const winner = qualifiers[Math.floor(Math.random() * qualifiers.length)];
    addWinner(winner);
    return;
  }
  if (gameMode === 'roulette') {
    if (!state.participants.length) return alert('Нет участников');
    hideRouletteOverlay();
    resetGameUIKeepMode();
    const winner = state.participants[Math.floor(Math.random() * state.participants.length)];
    addWinner(winner);
    return;
  }

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

function resetGameUIKeepMode() {
  // як resetGameUI, але без зміни кнопок режиму
  selected = new Set();
  phase = 'idle';
  raceQualifiers = [];
  document.getElementById('game-controls').style.display = 'none';
  document.getElementById('hint').textContent = '';
  document.getElementById('progress').textContent = '';
  document.getElementById('main-box').className = 'box';
  renderParticipants(state.participants || []);
}

// ── Режим "Рулетка" ──────────────────────────────────────────
let rouletteTimeout = null;

async function startRoulette() {
  if (!state.participants.length) return alert('Нет участников');
  phase = 'racing';

  const overlay = document.getElementById('roulette-overlay');
  const overlayHint = document.getElementById('roulette-overlay-hint');
  const controls = document.getElementById('roulette-overlay-controls');
  const strip = document.getElementById('roulette-strip');

  overlay.classList.add('visible');
  controls.style.display = 'none';
  overlayHint.textContent = 'Крутим барабан...';

  const winner = state.participants[Math.floor(Math.random() * state.participants.length)];

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

  // force reflow
  void strip.offsetWidth;

  const cellWidth = 180;
  const trackWidth = document.getElementById('roulette-track').clientWidth;
  const targetOffset = WINNER_IDX * cellWidth + cellWidth/2 - trackWidth/2;

  await sleep(50);

  strip.style.transition = 'transform 4.6s cubic-bezier(0.12, 0.7, 0.15, 1)';
  strip.style.transform = 'translateX(-' + targetOffset + 'px)';

  await new Promise(resolve => {
    rouletteTimeout = setTimeout(resolve, 4700);
  });
  rouletteTimeout = null;

  const winnerCell = strip.querySelector('[data-idx="' + WINNER_IDX + '"]');
  if (winnerCell) winnerCell.classList.add('win');

  overlayHint.innerHTML = '🎉 Победитель: <b style="color:#ffd700;">' + escapeHtml(winner) + '</b>';
  controls.style.display = 'flex';
  phase = 'done';

  addWinner(winner);
}

function closeRouletteOverlay() {
  resetGameUI();
}

function pickRandom(arr, n) {
  const copy = [...arr];
  const result = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

// ── Режим "Гонка" (3D, Three.js) ─────────────────────────────────

async function startRaceGame() {
  const n = Math.min(Math.max(parseInt(document.getElementById('race-count').value) || 12, 2), 15);
  const laps = Math.min(Math.max(parseInt(document.getElementById('race-laps').value) || 3, 1), 20);
  if (state.participants.length < 2) return alert('Нужно минимум 2 участника');
  const count = Math.min(n, state.participants.length);
  raceQualifiers = pickRandom(state.participants, count);
  await runRace(raceQualifiers, laps);
}

// ── Геометрія траси: точки центральної лінії (F1-стиль, з петлею) ──
// Координати: [x, z]. Центруються навколо центроїда при побудові кривої.
// Шикана (точки 24-29) розширена в 1.6 рази навколо власного центру —
// у вихідному варіанті ця ділянка перетиналась сама із собою
// (мін. відстань 12.94 < ширини дороги 15) і траса виглядала "склеєною".
const TRACK_POINTS_2D = [
  [60, 70], [0, 70], [-80, 70], [-120, 70], [-145, 60], [-155, 45],
  [-165, 25], [-185, 0], [-170, -50], [-130, -45], [-80, -40], [-50, -40],
  [-40, -35], [-40, -15], [-55, -5], [-75, 0], [-85, 15], [-80, 30],
  [-60, 35], [-30, 35], [-10, 20], [10, -10], [30, -45], [45, -40],
  [70.5, -4.5], [110.5, 27.5], [118.5, 19.5], [102.5, -4.5], [78.5, -28.5], [94.5, -44.5],
  [120, -45], [135, -35], [145, -25], [135, 0], [150, 35], [145, 65],
  [140, 70], [110, 70],
];

const ROAD_RADIUS = 7.5;  // радіус дорожнього покриття (TubeGeometry)

let renderer3D = null, scene3D = null, camera3D = null, orbitControls3D = null;

function disposeRace3D() {
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

// Будує замкнену 3D-криву (центрипетальна параметризація — стабільна навіть
// для нерівномірно розташованих точок)
function buildTrackCurve3() {
  let cx = 0, cz = 0;
  TRACK_POINTS_2D.forEach(([x, z]) => { cx += x; cz += z; });
  cx /= TRACK_POINTS_2D.length;
  cz /= TRACK_POINTS_2D.length;
  const points = TRACK_POINTS_2D.map(([x, z]) => new THREE.Vector3(x - cx, 0, z - cz));
  return new THREE.CatmullRomCurve3(points, true); // 'centripetal' за замовчуванням
}

// Текстура з канвасу (процедурна — без зовнішніх файлів)
function makeCanvasTexture(draw, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Будує асфальт, поребрики, траву та фінішну лінію на базі TubeGeometry
// (TubeGeometry сама рахує орієнтацію вздовж кривої — без ручних "right"-векторів
// і проблем із самоперетинами/телепортацією)
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

  // ── Світлий контур траси (трохи ширший, нижче) ──
  const edgeGeo = new THREE.TubeGeometry(curve, 400, ROAD_RADIUS + 0.5, 16, true);
  edgeGeo.scale(1, 0.03, 1);
  const edgeMesh = new THREE.Mesh(edgeGeo, new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.8 }));
  edgeMesh.position.y = 0.05;
  scene.add(edgeMesh);

  // ── Дорога: рівний сірий колір, без текстур та бортиків ──
  const roadGeo = new THREE.TubeGeometry(curve, 400, ROAD_RADIUS, 16, true);
  roadGeo.scale(1, 0.04, 1);
  const roadMesh = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.9 }));
  roadMesh.position.y = 0.1;
  scene.add(roadMesh);

  // ── Фінішна лінія (шахматка) ──
  const UP = new THREE.Vector3(0, 1, 0);
  const m0 = curve.getPointAt(0);
  const t0 = curve.getTangentAt(0);
  const right0 = new THREE.Vector3().crossVectors(t0, UP).normalize();
  const finishMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_RADIUS * 2, 2.2),
    new THREE.MeshStandardMaterial({ map: finishTex })
  );
  finishMesh.rotation.x = -Math.PI / 2;
  finishMesh.rotation.y = Math.atan2(right0.x, right0.z);
  finishMesh.position.set(m0.x, 0.55, m0.z);
  scene.add(finishMesh);
}

// Спільні геометрії для всіх машинок (економія пам'яті — 15 машинок x ~20 mesh)
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

// Детальна процедурна машинка F1 (шасі, антикрила, halo, колеса з підвіскою)
function makeF1Car(teamColorHex) {
  const G = getCarGeometries();
  const group = new THREE.Group();
  const carBody = new THREE.Group();

  const paintMat = new THREE.MeshStandardMaterial({ color: teamColorHex, metalness: 0.6, roughness: 0.2 });
  const carbonMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.2, roughness: 0.8 });
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

  // Розвертаємо болід на 180° (виправлення напрямку/орієнтації моделі)
  carBody.rotation.y = 0;
  group.add(carBody);
  group.scale.set(0.45, 0.45, 0.45);
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
    '<div id="race-countdown"></div>';

  if (!window.THREE) {
    overlayHint.textContent = '3D недоступно (не загрузился Three.js)';
    controls.style.display = 'flex';
    phase = 'done';
    return;
  }

  // Чекаємо, поки layout оверлею встановиться (правильний розмір canvas — без піксельності)
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

  // ── Камера: фіксований ракурс, що охоплює всю карту ──
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

  // ── Керування камерою: ЛКМ — обертати, колесо — зум ──
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

  // ── Машинки ──
  const laneSpacing = 0.9;
  const cars = [];
  for (let i = 0; i < n; i++) {
    const color = new THREE.Color().setHSL(i / n, 0.65, 0.5);
    const car = makeF1Car(color.getHex());
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
    const colorHex = '#' + new THREE.Color().setHSL(i / n, 0.65, 0.5).getHexString();
    el.style.setProperty('--car-color', colorHex);
    el.textContent = name;
    labelsBox.appendChild(el);
    return el;
  });

  const UP = new THREE.Vector3(0, 1, 0);

  function positionCars(progressArr) {
    for (let i = 0; i < n; i++) {
      let u = progressArr[i] % 1;
      if (u < 0) u += 1;
      const p = curve.getPointAt(u);
      const tangent = curve.getTangentAt(u).clone();
      tangent.y = 0;
      tangent.normalize();
      const right = new THREE.Vector3().crossVectors(tangent, UP).normalize();
      const offset = (i - (n - 1) / 2) * laneSpacing;
      const pos = p.clone().addScaledVector(right, offset);
      pos.y = 0.55;
      cars[i].position.copy(pos);
      cars[i].lookAt(pos.clone().add(tangent));
    }
  }

  function updateLabels() {
    for (let i = 0; i < n; i++) {
      const v = cars[i].position.clone();
      v.y += 4.5;
      v.project(camera3D);
      if (v.z > 1 || v.z < -1) { labelEls[i].style.display = 'none'; continue; }
      labelEls[i].style.display = '';
      labelEls[i].style.left = ((v.x * 0.5 + 0.5) * width) + 'px';
      labelEls[i].style.top  = ((-v.y * 0.5 + 0.5) * height) + 'px';
    }
  }

  // ── Турнірна таблиця (позиції учасників) ──
  const standingsBox = document.getElementById('race-standings');
  const carColors = qualifiers.map((_, i) => '#' + new THREE.Color().setHSL(i / n, 0.65, 0.5).getHexString());

  function renderStandings(progressArr, lapsArr, winnerIdx) {
    const order = qualifiers.map((_, i) => i).sort((a, b) => {
      const totalA = lapsArr[a] + (progressArr[a] % 1);
      const totalB = lapsArr[b] + (progressArr[b] % 1);
      return totalB - totalA;
    });
    const leadLapDisplay = Math.min(lapsArr[order[0]] + 1, totalLaps);
    standingsBox.innerHTML = '<div class="standings-title">🏁 Круг ' + leadLapDisplay + ' / ' + totalLaps + '</div>' +
      order.map((idx, pos) => {
        const cls = 'standing-row' + (idx === winnerIdx ? ' winner' : '');
        return '<div class="' + cls + '">' +
          '<span class="standing-pos">' + (pos + 1) + '</span>' +
          '<span class="standing-swatch" style="background:' + carColors[idx] + '"></span>' +
          '<span class="standing-name">' + escapeHtml(qualifiers[idx]) + '</span>' +
          '<span class="standing-lap">L' + Math.min(lapsArr[idx] + 1, totalLaps) + '/' + totalLaps + '</span>' +
        '</div>';
      }).join('');
  }

  const progress = new Array(n).fill(0);
  const laps = new Array(n).fill(0);
  positionCars(progress);
  renderStandings(progress, laps, -1);

  function renderFrame() {
    if (orbitControls3D) orbitControls3D.update();
    updateLabels();
    renderer3D.render(scene3D, camera3D);
  }

  renderFrame();

  // Зворотний відлік
  const cd = document.getElementById('race-countdown');
  overlayHint.textContent = '';
  for (const txt of ['3', '2', '1', '🏁 СТАРТ!']) {
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

  // ── Симуляція гонки: плавна фізика прискорення/гальмування ──
  const LAP_SECONDS = 9; // середній час кола
  const baseSpeed = 1 / (LAP_SECONDS * 60); // прогрес за кадр (60fps)
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
      const frames = dt * 60; // нормалізація до 60fps-кроків

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
  overlayHint.innerHTML = '🏁 Победитель: <b style="color:#ffd700;">' + escapeHtml(winnerName) + '</b>';
  controls.style.display = 'flex';
  phase = 'done';

  addWinner(winnerName);
}

function closeRaceOverlay() {
  resetGameUI();
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
  document.getElementById('btn-go').style.display = '';
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

// ── Звукове сповіщення при закінченні таймера ──────────────────
let audioCtx = null;
function playTimeoutSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    // Три короткі високі сигнали
    [0, 0.25, 0.5].forEach(offset => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.3, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.25);
    });
  } catch (e) {}
}

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
  if (document.getElementById('wa-name').textContent !== name) return;

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

      if (raffleAccepting && raffleJoinCmd && lower === raffleJoinCmd) {
        if (!rafflePlayers.includes(username)) {
          rafflePlayers.push(username);
          saveState();
          console.log(`[РОЗІГРАШ +] ${username} (${rafflePlayers.length})`);
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
console.log('║  Защита: пароль через env variable   ║');
console.log('╚══════════════════════════════════════╝\n');

loadState();
connect();
