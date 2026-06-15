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
let raffleGame      = null; 
let raffleChecks    = {};   

// Активні сесії (token → expiry)
const sessions = new Map();

// SSE клієнти для живого чату
let chatClients = [];

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
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&family=Roboto+Mono:wght@400;500&display=swap');
  :root {
    --kick: #53fc18;
    --bg-main: #070907;
    --panel: rgba(15, 20, 16, 0.8);
    --border: #1b261b;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: radial-gradient(circle at top, #111a11 0%, var(--bg-main) 100%);
    color: #fff;
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .box {
    background: var(--panel);
    backdrop-filter: blur(12px);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 40px;
    width: 340px;
    text-align: center;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }
  h1 { font-family: 'Inter', sans-serif; font-size: 24px; font-weight: 900; color: var(--kick); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px;}
  .sub { color: #888; font-size: 12px; margin-bottom: 30px; letter-spacing: 0.5px;}
  input {
    width: 100%;
    background: rgba(0,0,0,0.4);
    border: 1px solid #2a3a2a;
    border-radius: 8px;
    padding: 14px;
    color: #fff;
    font-family: 'Roboto Mono', monospace;
    font-size: 15px;
    margin-bottom: 16px;
    outline: none;
    transition: all 0.3s ease;
  }
  input:focus { border-color: var(--kick); box-shadow: 0 0 10px rgba(83, 252, 24, 0.2); }
  button {
    width: 100%;
    background: var(--kick);
    color: #000;
    border: none;
    border-radius: 8px;
    padding: 14px;
    font-family: 'Inter', sans-serif;
    font-size: 16px;
    font-weight: 800;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 1px;
    transition: all 0.3s ease;
    box-shadow: 0 4px 15px rgba(83, 252, 24, 0.2);
  }
  button:hover { 
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(83, 252, 24, 0.4); 
  }
  .err { color: #ff4444; font-size: 12px; margin-top: 12px; min-height: 16px; }
</style>
</head>
<body>
<div class="box">
  <h1>🎮 Marbles Dash</h1>
  <div class="sub">STREAMER ACCESS ONLY</div>
  <input type="password" id="pw" placeholder="Введите пароль..." onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">Подключиться</button>
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
    err.textContent = 'Доступ запрещен. Неверный пароль.';
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
<title>Kick Studio — Розыгрыши</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Roboto+Mono:wght@400;500;700&display=swap');
  
  :root {
    --kick: #53fc18;
    --kick-dark: #1a4a0a;
    --bg-main: #060806;
    --panel-bg: #0d120d;
    --panel-border: #1a261a;
    --text-main: #e8e8e8;
    --text-muted: #889288;
    --gold: #ffd700;
    --red: #ff4a4a;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  body {
    background: var(--bg-main);
    color: var(--text-main);
    font-family: 'Inter', sans-serif;
    height: 100vh;
    overflow: hidden;
    padding: 16px;
    background-image: 
      radial-gradient(circle at 15% 50%, rgba(83, 252, 24, 0.03), transparent 25%),
      radial-gradient(circle at 85% 30%, rgba(83, 252, 24, 0.03), transparent 25%);
  }

  /* ── Плаваючий статус бота ──────────────── */
  #floating-status {
    position: fixed;
    bottom: 16px;
    right: 16px;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    padding: 8px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    z-index: 1000;
    backdrop-filter: blur(8px);
  }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-left:8px; background:#444; transition: 0.3s; }
  .dot.open { background: var(--kick); box-shadow: 0 0 10px var(--kick); }
  .dot.closed { background: var(--red); box-shadow: 0 0 10px rgba(255, 74, 74, 0.4); }

  /* ── Сітка Layout ──────────────────────── */
  .layout {
    max-width: 1700px; margin: 0 auto;
    display: grid;
    grid-template-columns: 320px 1fr 340px;
    gap: 16px;
    height: calc(100vh - 32px); /* 100vh мінус верхній та нижній padding(16+16) */
  }
  @media (max-width: 1200px) {
    .layout { grid-template-columns: 320px 1fr; }
    #chat-col { display: none; }
  }
  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; overflow-y: auto;}
    body { overflow: auto; height: auto; }
  }

  .col {
    background: var(--panel-bg); 
    border: 1px solid var(--panel-border); 
    border-radius: 12px;
    padding: 16px;
    display: flex; flex-direction: column;
    min-height: 0;
    box-shadow: 0 4px 15px rgba(0,0,0,0.2);
  }
  
  .col-title {
    font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 12px;
    display: flex; align-items: center; justify-content: space-between;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }
  .col-title .count { color: var(--kick); font-size: 16px; }

  /* ── Поля вводу ──────────────────────────── */
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .field-row { display: flex; gap: 10px; }
  .field.small { flex: 0 0 100px; }
  label.field-label { font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }

  input[type=text], input[type=number] {
    background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); border-radius: 8px;
    padding: 10px 12px; color: #fff; font-family: 'Roboto Mono', monospace;
    font-size: 14px; outline: none; transition: all 0.2s; width: 100%;
  }
  input:focus { border-color: var(--kick); box-shadow: inset 0 0 8px rgba(83,252,24,0.1); }
  
  #raffle-cmd { color: var(--kick); font-weight: bold; }
  #winners-count, #confirm-seconds { text-align: center; }

  /* ── Перемикач режиму гри ─────────────────── */
  .mode-switch { display: flex; gap: 6px; background: rgba(0,0,0,0.3); padding: 4px; border-radius: 10px; border: 1px solid var(--panel-border); }
  .mode-btn {
    flex: 1; padding: 8px 6px; border-radius: 6px; border: none;
    background: transparent; color: var(--text-muted); font-size: 13px; font-weight: 800;
    font-family: 'Inter', sans-serif; cursor: pointer; transition: all 0.3s;
    text-transform: uppercase;
  }
  .mode-btn:hover { color: #fff; background: rgba(255,255,255,0.05); }
  .mode-btn.active { background: var(--kick-dark); color: var(--kick); box-shadow: 0 2px 8px rgba(83,252,24,0.1); }

  /* ── Перемикачі (toggle) ─────────────────── */
  .toggle-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px solid rgba(255,255,255,0.02); }
  .toggle-row .toggle-label { font-size: 13px; color: #ccc; flex: 1; font-weight: 600; }
  .switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; inset: 0;
    background: #222; border-radius: 22px; transition: 0.3s; border: 1px solid #333;
  }
  .slider:before {
    content: ''; position: absolute; height: 14px; width: 14px;
    left: 3px; bottom: 3px; background: #888; border-radius: 50%; transition: 0.3s;
  }
  .switch input:checked + .slider { background: var(--kick-dark); border-color: var(--kick); }
  .switch input:checked + .slider:before { transform: translateX(18px); background: var(--kick); box-shadow: 0 0 5px var(--kick); }

  /* ── Кнопки ──────────────────────────────── */
  button {
    padding: 10px 14px; border: none; border-radius: 8px; font-size: 14px;
    font-weight: 800; cursor: pointer; font-family: 'Inter', sans-serif;
    text-transform: uppercase; letter-spacing: 0.5px; transition: all 0.2s;
    flex-shrink: 0;
  }
  button:hover  { transform: translateY(-1px); }
  button:active { transform: scale(0.97); }
  button:disabled { opacity: 0.3; cursor: not-allowed; transform: none; }

  .btn-primary { 
    background: var(--kick); color: #000; padding: 14px; font-size: 15px; 
    box-shadow: 0 4px 10px rgba(83,252,24,0.15); 
  }
  .btn-primary:hover { box-shadow: 0 6px 15px rgba(83,252,24,0.3); }
  
  .btn-gold   { background: var(--gold); color: #000; box-shadow: 0 4px 10px rgba(255,215,0,0.15); }
  .btn-gold:hover { box-shadow: 0 6px 15px rgba(255,215,0,0.3); }
  
  .btn-green  { background: rgba(83,252,24,0.1); color: var(--kick); border: 1px solid rgba(83,252,24,0.3); }
  .btn-green:hover { background: rgba(83,252,24,0.2); }
  
  .btn-red    { background: rgba(255,74,74,0.1); color: var(--red); border: 1px solid rgba(255,74,74,0.3); width: 100%; }
  .btn-red:hover { background: rgba(255,74,74,0.2); }
  
  .btn-dark   { background: rgba(255,255,255,0.05); color: #ccc; border: 1px solid rgba(255,255,255,0.1); }
  .btn-dark:hover { background: rgba(255,255,255,0.1); color: #fff; }
  
  .btn-small  { padding: 6px 10px; font-size: 12px; }

  .btn-row { display: flex; gap: 8px; margin-top: 8px; }
  .btn-row button { margin: 0; }

  .limit-info { font-size: 12px; color: var(--text-muted); font-family: 'Roboto Mono', monospace; margin-bottom: 12px; text-align: right; }
  .limit-info b { color: var(--kick); font-size: 14px; }

  #saved-msg, #test-msg { font-size: 11px; font-family: 'Roboto Mono', monospace; margin-top: 4px; display:block; height: 14px; }

  /* ── Тестова панель ──────────────────────── */
  /* Невелика непомітна панель тестових учасників у правому нижньому куті */
  .test-section-fixed {
    position: fixed; bottom: 10px; left: 10px; z-index: 50;
    background: rgba(20,20,22,0.55);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 8px;
    padding: 4px 8px;
    opacity: 0.35;
    transition: opacity 0.2s ease;
    max-width: 220px;
  }
  .test-section-fixed:hover,
  .test-section-fixed[open] { opacity: 1; }
  .test-section-fixed summary {
    font-size: 13px; cursor: pointer; outline: none; list-style: none;
    color: var(--text-muted); text-align: center;
  }
  .test-section-fixed summary::-webkit-details-marker { display: none; }
  .test-section-fixed .field-row { margin-top: 8px; gap: 6px; }
  .test-section-fixed input { font-size: 11px; padding: 4px 6px; }
  .test-section-fixed .btn-small { font-size: 11px; padding: 4px 8px; }
  .test-section-fixed #test-msg { font-size: 10px; }

  /* ── Списки / Бокси ───────────────── */
  .box {
    background: rgba(0,0,0,0.3); border: 1px solid var(--panel-border); border-radius: 10px;
    flex: 1; min-height: 50px; overflow-y: auto; overflow-x: hidden;
    padding: 10px;
  }
  .box::-webkit-scrollbar { width: 4px; }
  .box::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
  .box::-webkit-scrollbar-track { background: transparent; }

  .participants-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 6px;
  }
  .participant-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-radius: 6px; font-size: 13px; font-weight: 500;
    color: #ddd; background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.02);
    transition: all 0.2s;
  }
  .participant-row:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1); }
  .participant-row .p-num { color: var(--text-muted); font-family: 'Roboto Mono', monospace; font-size: 10px; width: 20px; flex-shrink: 0; }

  .empty-box { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 13px; font-family: 'Roboto Mono', monospace; text-align: center; padding: 20px; }

  /* ── Сітка Cash Hunt ─────────────────────── */
  #hint { text-align: center; font-size: 14px; color: #ccc; margin: 8px 0 4px; font-family: 'Roboto Mono', monospace; min-height: 18px; flex-shrink: 0;}
  #hint b { color: var(--kick); font-size: 15px; }
  #progress { text-align: center; font-size: 13px; color: var(--text-muted); margin-bottom: 8px; font-family: 'Roboto Mono', monospace; min-height: 18px; flex-shrink: 0;}
  #progress b { color: var(--kick); }

  .grid {
    display: grid;
    gap: 6px;
    align-content: start;
    padding: 4px;
  }

  .cell {
    aspect-ratio: 1;
    width: 100%;
    position: relative;
    cursor: pointer;
    perspective: 800px;
  }
  .cell-inner {
    width: 100%; height: 100%;
    position: relative;
    transform-style: preserve-3d;
    transition: transform 0.6s cubic-bezier(0.4, 0.0, 0.2, 1);
  }
  .cell.flipped .cell-inner { transform: rotateY(180deg); }
  .cell-face {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px;
    backface-visibility: hidden;
    font-family: 'Inter', sans-serif;
    font-weight: 800;
    text-align: center;
    overflow: hidden;
    padding: 2px;
  }
  .cell-front {
    background: linear-gradient(145deg, #162016, #0a100a);
    border: 1px solid var(--panel-border);
    color: var(--kick);
    font-size: 24px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    transition: all 0.3s;
  }
  .cell-front:hover {
    border-color: rgba(83,252,24,0.5);
    transform: translateY(-2px);
    box-shadow: 0 4px 10px rgba(83,252,24,0.1);
  }
  .cell-back {
    transform: rotateY(180deg);
    background: #111;
    border: 1px solid #333;
    color: #fff;
    font-size: 12px;
    line-height: 1.2;
    word-break: break-word;
    box-shadow: inset 0 0 15px rgba(0,0,0,0.8);
  }
  .cell.selected .cell-front {
    border-color: var(--kick);
    background: linear-gradient(145deg, rgba(83,252,24,0.2), rgba(20,60,10,0.8));
    box-shadow: 0 0 15px rgba(83,252,24,0.4), inset 0 0 8px rgba(83,252,24,0.2);
    transform: scale(1.05);
  }
  .cell.winner .cell-back {
    background: linear-gradient(145deg, var(--kick), #28a708);
    border: 1px solid #a4ff82;
    color: #000;
    font-weight: 900;
    font-size: 14px;
    animation: winnerGlow 1s ease infinite alternate;
  }
  @keyframes winnerGlow {
    from { box-shadow: 0 0 8px rgba(83,252,24,0.4); }
    to   { box-shadow: 0 0 20px rgba(83,252,24,0.8); }
  }
  .cell.revealed { cursor: default; }
  .selecting .cell:not(.selected):hover .cell-inner { transform: scale(1.05); }
  .selecting .cell { cursor: none; }
  .selecting .cell.selected { cursor: none; }
  .selecting * { cursor: none !important; }

  /* ── Кастомний Чат ─────────────────────── */
  .chat-msg {
    font-family: 'Roboto Mono', monospace;
    font-size: 12px;
    line-height: 1.4;
    word-wrap: break-word;
    padding: 6px 10px;
    background: rgba(255,255,255,0.02);
    border-radius: 6px;
    border-left: 2px solid var(--panel-border);
    transition: background 0.2s;
  }
  .chat-emote {
    height: 1.6em; width: auto; vertical-align: middle;
    margin: 0 1px; display: inline-block;
  }
  .chat-msg:hover {
    background: rgba(255,255,255,0.05);
  }

  /* ── Гонка & Рулетка (Оверлеї) ───────────────────────────── */
  #race-overlay, #roulette-overlay {
    position: fixed; inset: 0; z-index: 9990;
    background: rgba(4,6,4,0.95);
    display: none;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 20px;
    backdrop-filter: blur(8px);
  }
  #race-overlay.visible, #roulette-overlay.visible { display: flex; }
  
  #race-overlay-hint, #roulette-overlay-hint {
    font-family: 'Roboto Mono', monospace;
    font-size: 24px; font-weight: bold; color: var(--kick); letter-spacing: 2px;
    text-transform: uppercase;
    text-shadow: 0 0 15px rgba(83,252,24,0.4);
  }

  #race-track-area {
    width: min(98vw, 1560px);
    aspect-ratio: 12 / 7;
    max-height: 85vh;
    position: relative;
    background: #000;
    border: 2px solid var(--panel-border);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 10px 50px rgba(0,0,0,0.8);
  }
  
  #roulette-track-area {
    width: min(90vw, 1100px);
    position: relative;
    padding: 40px 0;
  }
  
  #roulette-track {
    width: 100%; height: 160px;
    background: linear-gradient(180deg, #111, #050505);
    border: 2px solid var(--panel-border);
    border-radius: 16px;
    overflow: hidden;
    position: relative;
    box-shadow: inset 0 0 50px rgba(0,0,0,0.8), 0 10px 30px rgba(0,0,0,0.5);
  }
  
  #roulette-track::before, #roulette-track::after {
    content: ''; position: absolute; top: 0; bottom: 0; width: 100px; z-index: 5; pointer-events: none;
  }
  #roulette-track::before { left: 0; background: linear-gradient(90deg, #050505, transparent); }
  #roulette-track::after  { right: 0; background: linear-gradient(270deg, #050505, transparent); }
  
  #roulette-strip {
    display: flex; align-items: center; height: 100%;
    position: absolute; left: 0; top: 0;
    will-change: transform;
  }

  .roulette-cell {
    flex: 0 0 200px; height: 100%;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Inter', sans-serif; font-weight: 800; font-size: 24px;
    color: #888;
    border-right: 1px solid #1a1a1a;
    text-align: center; padding: 0 16px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: rgba(255,255,255,0.02);
  }
  .roulette-cell.win {
    color: #000; background: linear-gradient(145deg, var(--kick), #28a708);
    font-weight: 900; font-size: 28px;
    animation: winnerGlow 0.8s ease infinite alternate;
    border: none;
  }
  
  #roulette-pointer {
    position: absolute; left: 50%; top: 6px; bottom: 6px;
    width: 6px; background: var(--kick); transform: translateX(-50%);
    z-index: 6; border-radius: 3px;
    box-shadow: 0 0 15px var(--kick);
  }

  .race-close-btn {
    position: absolute; top: -50px; right: 0; z-index: 4;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #aaa;
    width: 44px; height: 44px; border-radius: 10px;
    font-size: 20px; line-height: 1; cursor: pointer; transition: 0.2s;
  }
  .race-close-btn:hover { border-color: var(--red); color: var(--red); background: rgba(255,74,74,0.1); }

  /* ── Список переможців ──────────────────── */
  .winner-row {
    background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px;
    padding: 10px; margin-bottom: 8px;
    animation: rowPop 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    transition: transform 0.2s;
  }
  .winner-row:hover { transform: translateX(4px); }
  @keyframes rowPop {
    from { transform: translateX(-20px); opacity: 0; }
    to   { transform: translateX(0); opacity: 1; }
  }
  .winner-row.confirmed { border-left: 4px solid var(--kick); }
  .winner-row.expired   { border-left: 4px solid var(--red); opacity: 0.7; }
  
  .winner-top { display: flex; align-items: center; gap: 10px; }
  .w-status { font-size: 14px; width: 20px; text-align: center; flex-shrink: 0; }
  .w-status.ok { color: var(--kick); text-shadow: 0 0 6px rgba(83,252,24,0.4); }
  .w-status.pending { color: var(--gold); font-family: 'Roboto Mono', monospace; font-size: 12px; width: auto; font-weight: bold; }
  .w-status.bad { color: var(--red); }
  .w-name { font-weight: 700; color: #fff; flex: 1; font-size: 14px; letter-spacing: 0.5px; }
  .w-time { font-size: 10px; color: var(--text-muted); font-family: 'Roboto Mono', monospace; }
  
  .w-msg {
    margin-top: 6px; font-size: 12px; color: var(--kick); font-family: 'Roboto Mono', monospace;
    background: rgba(83,252,24,0.05); border-radius: 6px; padding: 6px 10px;
    border: 1px dashed rgba(83,252,24,0.2);
  }
  .w-msg.empty { color: var(--text-muted); font-style: italic; background: rgba(0,0,0,0.2); border-color: transparent; }

  /* ── Оголошення переможця (кінематографічний оверлей) ──────── */
  #winner-announce {
    position: fixed; inset: 0; z-index: 9998;
    background: rgba(4,6,4,0.85);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px;
    opacity: 0; pointer-events: none;
    transition: opacity 0.5s ease;
    backdrop-filter: blur(12px);
  }
  #winner-announce.visible { opacity: 1; pointer-events: auto; }

  #winner-announce .wa-label {
    font-family: 'Roboto Mono', monospace;
    font-size: 28px; font-weight: bold; color: var(--kick); letter-spacing: 8px; text-transform: uppercase;
    text-shadow: 0 0 15px rgba(83,252,24,0.3);
  }
  #winner-announce .wa-name {
    font-family: 'Inter', sans-serif;
    font-size: clamp(60px, 8vw, 120px);
    font-weight: 900;
    color: #fff;
    text-shadow: 0 0 30px rgba(255,255,255,0.2), 0 0 60px rgba(255,255,255,0.1);
    letter-spacing: 4px;
    text-align: center;
    max-width: 90vw;
    word-break: break-word;
    animation: waNameIn 0.7s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
  }
  @keyframes waNameIn {
    from { transform: scale(0.8) translateY(20px); opacity: 0; filter: blur(10px); }
    to   { transform: scale(1) translateY(0);   opacity: 1; filter: blur(0); }
  }
  #winner-announce .wa-timer {
    font-family: 'Roboto Mono', monospace;
    font-size: 56px; font-weight: bold;
    color: var(--gold);
    letter-spacing: 2px;
    min-width: 120px;
    text-align: center;
    text-shadow: 0 0 20px rgba(255,215,0,0.3);
  }
  #winner-announce .wa-timer.expiring { color: var(--red); text-shadow: 0 0 20px rgba(255,74,74,0.5); animation: timerBlink 0.5s infinite alternate; }
  @keyframes timerBlink {
    from { opacity: 1; transform: scale(1); }
    to   { opacity: 0.5; transform: scale(0.95); }
  }
  
  #winner-announce .wa-msg {
    font-family: 'Inter', sans-serif;
    font-size: clamp(32px, 4vw, 64px); font-weight: 800; color: var(--kick);
    background: rgba(83,252,24,0.05);
    border: 1px solid rgba(83,252,24,0.2);
    border-radius: 16px; padding: 20px 40px;
    max-width: 85vw; text-align: center;
    letter-spacing: 1px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    animation: waMsgIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  }
  @keyframes waMsgIn {
    from { transform: translateY(20px) scale(0.9); opacity: 0; }
    to   { transform: translateY(0) scale(1);    opacity: 1; }
  }
  
  #winner-announce .wa-sub {
    font-size: 18px; color: var(--text-muted); font-family: 'Roboto Mono', monospace; font-weight: bold; letter-spacing: 4px; text-transform: uppercase;
  }
  #winner-announce .wa-close {
    margin-top: 20px;
    background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #aaa;
    padding: 12px 32px; border-radius: 10px;
    font-family: 'Inter', sans-serif; font-size: 15px; font-weight: 800;
    cursor: pointer; transition: all 0.3s;
    text-transform: uppercase; letter-spacing: 1px;
  }
  #winner-announce .wa-close:hover { border-color: #fff; color: #fff; background: rgba(255,255,255,0.05); }

  /* Частинки */
  .wa-particle {
    position: fixed; pointer-events: none; border-radius: 50%; z-index: 9997;
    animation: waPart 2s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
    box-shadow: 0 0 10px currentColor;
  }
  @keyframes waPart {
    0% { transform: translate(0,0) scale(1); opacity: 1; }
    100% { transform: translate(var(--tx),var(--ty)) scale(0); opacity: 0; }
  }

  /* Race specific 3D layout fixes */
  #race-overlay-controls, #roulette-overlay-controls { display: flex; gap: 12px; margin-top: 10px;}
  #race-standings {
    position: absolute; top: 16px; left: 16px; z-index: 4;
    width: 220px; max-height: calc(100% - 32px);
    background: rgba(0,0,0,0.8);
    backdrop-filter: blur(4px);
    border-left: 4px solid var(--kick);
    border-radius: 12px;
    padding: 16px;
    font-family: 'Inter', sans-serif;
    overflow-y: auto;
    pointer-events: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }
  .standings-title {
    font-size: 16px; font-weight: 900; color: #fff;
    text-transform: uppercase; letter-spacing: 1.5px;
    border-bottom: 1px solid rgba(255,255,255,0.1);
    padding-bottom: 12px; margin-bottom: 12px;
  }
  .standing-row {
    display: flex; align-items: center;
    padding: 8px 0;
    font-weight: 600; font-size: 14px; color: #ccc;
  }
  .standing-row.winner { color: var(--kick); font-weight: 800; text-shadow: 0 0 8px rgba(83,252,24,0.3); }
  .standing-pos { width: 24px; color: #666; font-size: 12px; font-family: 'Roboto Mono', monospace; font-weight: bold; }
  .standing-swatch { width: 10px; height: 10px; border-radius: 50%; margin-right: 12px; }
  .standing-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .standing-lap { font-size: 11px; color: #555; font-family: 'Roboto Mono', monospace; font-weight: bold; }
  
  .car-label-3d {
    position: absolute; transform: translate(-50%, -100%);
    background: rgba(0,0,0,0.7); color: #fff;
    padding: 6px 12px; border-radius: 8px;
    font-size: 13px; font-weight: 800;
    text-transform: uppercase; letter-spacing: 0.5px;
    border-bottom: 3px solid var(--car-color, #888);
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    transition: left 0.05s linear, top 0.05s linear;
    backdrop-filter: blur(4px);
  }
  .car-label-3d.winner { background: var(--kick); color: #000; border-bottom-color: #fff; animation: winnerGlow 0.6s ease infinite alternate; }

  #race-countdown {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 140px; font-weight: 900; color: var(--kick);
    font-family: 'Inter', sans-serif;
    text-shadow: 0 0 50px rgba(83,252,24,0.6);
    z-index: 3; pointer-events: none;
  }

  /* Підказки керування 3D */
  #race-controls-hint {
    position: absolute;
    bottom: 16px;
    right: 16px;
    background: rgba(0,0,0,0.8);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    padding: 12px 16px;
    font-size: 12px;
    font-family: 'Inter', sans-serif;
    color: #ddd;
    z-index: 10;
    pointer-events: none;
    line-height: 1.6;
    text-align: right;
    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    backdrop-filter: blur(4px);
  }
  #race-controls-hint b { color: var(--kick); font-weight: 800; }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
</head>
<body>

<div id="floating-status">
  bot status <span class="dot closed" id="conn-dot"></span>
</div>

<div class="layout">

  <!-- ── Налаштування ──────────────────────── -->
  <div class="col">
    <div class="col-title">Настройки</div>

    <div class="field-row">
      <div class="field" style="flex:1;">
        <label class="field-label">Слово для участия</label>
        <input type="text" id="raffle-cmd" value="" placeholder="!join" onkeydown="if(event.key==='Enter')saveRaffleCmd()">
      </div>
      <div class="field small">
        <label class="field-label">Победителей</label>
        <input type="number" id="winners-count" value="1" min="1" max="200">
      </div>
    </div>
    <button type="button" id="btn-reg-toggle" class="btn-green" style="width:100%; margin-bottom:12px;" onclick="toggleRegistration()">▶ Начать регистрацию</button>
    <span id="saved-msg"></span>

    <div class="field" style="margin-top:4px;">
      <label class="field-label">Режим игры</label>
      <div class="mode-switch">
        <button type="button" class="mode-btn" id="mode-btn-roulette" onclick="setGameMode('roulette')">🎰 Дефолт</button>
        <button type="button" class="mode-btn" id="mode-btn-race" onclick="setGameMode('race')">🏎️ Гонка</button>
        <button type="button" class="mode-btn active" id="mode-btn-cashhunt" onclick="setGameMode('cashhunt')">🎯 Cash Hunt</button>
      </div>
    </div>

    <div id="race-count-field" style="display:none;">
      <div class="field-row" style="margin-top:8px;">
        <div class="field">
          <label class="field-label">Участников гонки (до 300)</label>
          <input type="number" id="race-count" value="12" min="2" max="300">
        </div>
        <div class="field small">
          <label class="field-label">Кругов</label>
          <input type="number" id="race-laps" value="3" min="1" max="20">
        </div>
      </div>
    </div>

    <div class="toggle-row" style="margin-top:8px;">
      <span class="toggle-label">Ожидание ответа в чат</span>
      <label class="switch">
        <input type="checkbox" id="toggle-confirm" checked onchange="toggleConfirmField()">
        <span class="slider"></span>
      </label>
    </div>
    <div id="confirm-time-field" style="display: block; margin-bottom: 12px;">
      <div class="field">
        <label class="field-label">Время на ответ (сек)</label>
        <input type="number" id="confirm-seconds" value="60" min="5" max="600">
      </div>
    </div>

    <div class="limit-info">Участников: <b id="participant-count">0</b></div>

    <!-- Кнопки в один ряд -->
    <div class="btn-row" style="margin-bottom: 12px; gap: 8px;">
      <button class="btn-primary" style="margin:0; flex: 2; font-size: 13px;" onclick="startGame()">🎯 СТАРТ</button>
      <button class="btn-dark" style="margin:0; flex: 1; font-size: 12px;" onclick="downloadCSV()">⬇ CSV</button>
      <button class="btn-dark" style="margin:0; flex: 1; font-size: 12px;" onclick="resetRaffle()">🗑 Сброс</button>
    </div>

    <div class="col-title" style="margin-top:16px;">
      <span>Победители</span>
      <span class="count" id="winners-count-title">0</span>
    </div>
    <div class="box" id="winners-box">
      <div class="empty-box">Победителей пока нет</div>
    </div>
  </div>

  <!-- ── Учасники / Гра ────────────────────── -->
  <div class="col">
    <div class="col-title">
      <span>Участники</span>
      <span class="count" id="participants-count-title">0</span>
    </div>

    <div id="hint"></div>
    <div id="progress"></div>
    <div class="box" id="main-box">
      <div class="empty-box">Ожидание регистрации...</div>
    </div>
    <div class="btn-row" id="game-controls" style="display:none; margin-top: 12px;">
      <button class="btn-gold" id="btn-go" onclick="startReveal()" disabled>🚀 Начать раскрытие</button>
      <button class="btn-dark" onclick="reroll()">🔄 Рерол</button>
    </div>
  </div>
  
  <!-- ── Кастомний Чат ────────────────────── -->
  <div class="col" id="chat-col">
    <div class="col-title">
      <span>Чат стрима</span>
      <span class="count" id="chat-count">0</span>
    </div>
    <div class="box" id="chat-box" style="flex:1; display:flex; flex-direction:column; gap:6px;">
      <div class="empty-box">Ожидание сообщений...</div>
    </div>
  </div>

</div>

<!-- Тестові учасники — невелика непомітна панель у правому нижньому куті -->
<details class="test-section-fixed" id="test-section-fixed">
  <summary>🧪</summary>
  <div class="field-row">
    <input type="text" id="test-name" placeholder="имя игрока" onkeydown="if(event.key==='Enter')addTestPlayer()">
    <button class="btn-green btn-small" onclick="addTestPlayer()">+1</button>
    <button class="btn-dark btn-small" onclick="addBulkTest()">+10</button>
  </div>
  <span id="test-msg"></span>
</details>

<!-- Оголошення переможця -->
<div id="winner-announce">
  <div class="wa-label">Победитель</div>
  <div class="wa-name" id="wa-name">—</div>
  <div class="wa-timer" id="wa-timer"></div>
  <div class="wa-msg" id="wa-msg" style="display:none;"></div>
  <div class="wa-sub" id="wa-sub">Напишите сообщение в чат</div>
  <button class="wa-close" onclick="closeAnnounce()">Закрыть</button>
</div>

<!-- Оверлей гонки -->
<div id="race-overlay">
  <div id="race-overlay-hint"></div>
  <div id="race-track-area">
    <button class="race-close-btn" onclick="closeRaceOverlay()">✕</button>
    <div id="race-standings"></div>
    <!-- Підказки генеруються динамічно в JS -->
  </div>
  <div id="race-overlay-controls" style="display:none;">
    <button class="btn-dark" onclick="reroll()">🔄 Рерол</button>
    <button class="btn-dark" onclick="fastReroll()">⚡ Быстрый рерол</button>
    <button class="btn-primary" style="width:auto; margin-bottom: 0;" onclick="closeRaceOverlay()">Завершить</button>
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
    <button class="btn-dark" onclick="reroll()">🔄 Рерол</button>
    <button class="btn-dark" onclick="fastReroll()">⚡ Быстрый рерол</button>
    <button class="btn-primary" style="width:auto; margin-bottom: 0;" onclick="closeRouletteOverlay()">Завершить</button>
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
let currentGame = null;     
let selected = new Set();   
let phase = 'idle';         
let winnersHistory = [];    

// ── Ініціалізація кастомного чату (SSE) ─────────────
const chatBox = document.getElementById('chat-box');
const chatCount = document.getElementById('chat-count');
let msgCount = 0;

// Розпарсити [emote:ID:NAME] у повідомленнях Kick і вивести як <img>
function parseChatContent(content) {
  const re = /\\[emote:(\\d+):([^\\]]+)\\]/g;
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
  const { username, content, color } = JSON.parse(e.data);
  
  const empty = chatBox.querySelector('.empty-box');
  if (empty) empty.remove();

  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg';
  msgEl.innerHTML = '<b style="color: ' + escapeHtml(color) + '">' + escapeHtml(username) + '</b>: <span>' + parseChatContent(content) + '</span>';
  
  chatBox.appendChild(msgEl);
  msgCount++;
  chatCount.textContent = msgCount;

  chatBox.scrollTop = chatBox.scrollHeight;

  if (chatBox.children.length > 150) {
    chatBox.removeChild(chatBox.firstChild);
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

  document.getElementById('participant-count').textContent = state.count;
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

  if (phase === 'idle') renderParticipants(state.participants);
}

function renderParticipants(list) {
  const box = document.getElementById('main-box');
  if (!list.length) {
    box.innerHTML = '<div class="empty-box">Ожидание регистрации...</div>';
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

let gameMode = 'cashhunt';
let raceQualifiers = [];
let raceAnimId = null;

function setGameMode(mode) {
  if (phase !== 'idle') return; 
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
    // В гонці ліміт до 300
    const n = raceQualifiers.length || Math.min(parseInt(document.getElementById('race-count').value) || 12, 300);
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
      qualifiers = pickRandom(state.participants, Math.min(n, 300));
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
  selected = new Set();
  phase = 'idle';
  raceQualifiers = [];
  document.getElementById('game-controls').style.display = 'none';
  document.getElementById('hint').textContent = '';
  document.getElementById('progress').textContent = '';
  document.getElementById('main-box').className = 'box';
  renderParticipants(state.participants || []);
}

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

  void strip.offsetWidth;

  const cellWidth = 200;
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

  overlayHint.innerHTML = '🎉 Победитель: <b style="color:var(--kick);">' + escapeHtml(winner) + '</b>';
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

async function startRaceGame() {
  // Збільшено ліміт до 300
  const n = Math.min(Math.max(parseInt(document.getElementById('race-count').value) || 12, 2), 300);
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
          '<span class="standing-lap">L' + Math.min(lapsArr[idx] + 1, totalLaps) + '/' + totalLaps + '</span>' +
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
          orbitControls3D.target.copy(cars[followIdx].position);
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

  // Динамічна авто-сітка, що підлаштовується під будь-яку кількість елементів без обрізання
  grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(45px, 1fr))';

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
    hint.innerHTML = 'Выберите <b>' + n + '</b> ' + (n === 1 ? 'ячейку' : 'ячеек') +
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

  // Швидкість розкриття клітинок масштабується під кількість учасників:
  // стандарт (35мс) для звичної кількості (~20), пропорційно швидше для великих
  // (на 300 учасників 35мс*297 ≈ 10.4с було дуже довго → тепер ~4мс*297 ≈ 1.2с)
  const REFERENCE_COUNT = 20;
  const BASE_DELAY = 35;
  const MIN_DELAY = 4;
  const flipDelay = Math.max(MIN_DELAY, Math.min(BASE_DELAY, BASE_DELAY * REFERENCE_COUNT / Math.max(others.length, 1)));

  for (const idx of others) {
    cells[idx].classList.add('flipped', 'revealed');
    await sleep(flipDelay);
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
  document.getElementById('hint').innerHTML = 'Готово!';
  document.getElementById('btn-go').textContent = '🚀 Начать раскрытие';
}

let announceTimer = null;
let announceSeconds = 0;
let audioCtx = null;

function playTimeoutSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
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
  const colors = ['#53fc18','#28a708','#fff'];
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
        '<button class="btn-dark btn-small w-retry" style="margin-top:8px;" onclick="retryWinner(\\'' + escapeAttr(w.name) + '\\')">↻ Заново</button>';
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

renderWinners();
loadState();
setInterval(() => { if (phase === 'idle') loadState(); }, 5000);

// Пробіл не повинен "клікати" по фокусованій кнопці (через це після старту
// гри натискання пробілу повторно запускало startGame() з нуля)
window.addEventListener('keydown', (e) => {
  if ((e.code === 'Space' || e.key === ' ') && document.activeElement && document.activeElement.tagName === 'BUTTON') {
    e.preventDefault();
  }
});

function toggleConfirmField() {
  const on = document.getElementById('toggle-confirm').checked;
  const f = document.getElementById('confirm-time-field');
  f.style.display = on ? 'block' : 'none';
}

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
    const alpha = 0.6 + 0.4 * Math.sin(pulse);

    const cx = 24, cy = 24;
    const R = 14;

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(83,252,24,' + alpha + ')';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(83,252,24,' + alpha + ')';
    ctx.fill();

    const gap = 6, len = 6;
    ctx.strokeStyle = 'rgba(83,252,24,' + alpha + ')';
    ctx.lineWidth = 2;
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
    if (phase === 'selecting') { if (!visible) show(); }
    else { if (visible) hide(); }
  });

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

  // SSE маршрут для живого чату
  if (req.url === '/api/chat/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    chatClients.push(res);
    req.on('close', () => {
      chatClients = chatClients.filter(c => c !== res);
    });
    return;
  }

  // Логін — відкритий маршрут
  if (req.url === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (password === WEB_PASSWORD) {
          const token = generateToken();
          sessions.set(token, Date.now() + 86400000); 
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ token }));
        } else {
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
        const gridSize = rafflePlayers.length;
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

// Генерує сітку: кількість клітинок = кількості учасників, без обмежень
function buildRaffleGame(n) {
  const shuffled = [...rafflePlayers].sort(() => Math.random() - 0.5);
  const gridSize = shuffled.length;
  const cells = shuffled.slice(0, gridSize);

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
      const color = data?.sender?.identity?.color || '#53fc18';
      
      if (!username || !content) return;

      // Відправляємо повідомлення у кастомний чат на фронтенді
      const chatMsg = JSON.stringify({ username, content, color });
      chatClients.forEach(c => c.write(`data: ${chatMsg}\n\n`));

      const lower = content.toLowerCase();

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
