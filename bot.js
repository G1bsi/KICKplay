import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Настройки ──────────────────────────────────────────────
const CHANNEL_ID  = 235226;
const CHATROOM_ID = 235222;
const PREFIX      = '!';
const STREAMER    = 'kosteze231';
const CSV_FILE    = path.join(__dirname, 'marble.csv');
const STATE_FILE  = path.join(__dirname, 'marble_state.json');
const MAX_PLAYERS = 1000;

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

let players   = [];
let accepting = true;
let joinCmd   = '!play'; // змінюється через сайт

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
  const state = { players, accepting, joinCmd, savedAt: new Date().toISOString() };
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
    players   = Array.isArray(state.players) ? state.players : [];
    accepting = typeof state.accepting === 'boolean' ? state.accepting : true;
    joinCmd   = state.joinCmd || '!play';
    console.log(`[STATE] Восстановлено: ${players.length} игроков, регистрация: ${accepting ? 'открыта' : 'закрыта'}`);
  } catch (e) {
    console.error('[STATE] Ошибка загрузки:', e.message);
  }
}

function saveCSV() {
  try {
    fs.writeFileSync(CSV_FILE, players.join('\n'), 'utf8');
    console.log(`[CSV] Сохранено ${players.length} игроков`);
  } catch (e) {
    console.error('[CSV] Ошибка сохранения:', e.message);
  }
}

// Автозбереження кожні 30 секунд
setInterval(() => { if (players.length > 0) saveState(); }, 30000);

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

// ── Головна сторінка ────────────────────────────────────────
const HTML = () => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kick Marbles — Игроки</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Share+Tech+Mono&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #fff;
    font-family: 'Rajdhani', sans-serif;
    min-height: 100vh;
    padding: 20px;
  }
  .wrapper { width: 100%; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 24px; color: #53fc18; text-align: center; letter-spacing: 1px; margin-bottom: 4px; }
  .sub { color: #444; font-size: 11px; margin-bottom: 18px; text-align: center; font-family: 'Share Tech Mono', monospace; }

  .stats { display: flex; justify-content: center; margin-bottom: 12px; }
  .stat { background: #111; border: 1px solid #1e1e1e; border-radius: 10px; padding: 12px 40px; text-align: center; }
  .stat-num { font-size: 38px; font-weight: 700; color: #53fc18; line-height: 1; }
  .stat-label { font-size: 10px; color: #444; margin-top: 3px; font-family: 'Share Tech Mono', monospace; }

  .bar-wrap { max-width: 320px; margin: 0 auto 12px; }
  .bar-bg { background: #1a1a1a; border-radius: 4px; height: 5px; overflow: hidden; }
  .bar { height: 100%; border-radius: 4px; transition: width 0.4s, background 0.4s; }
  .bar-label { font-size: 10px; color: #333; text-align: center; margin-top: 4px; font-family: 'Share Tech Mono', monospace; }

  .status-wrap { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 14px; }
  .status { display: inline-block; padding: 3px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; font-family: 'Share Tech Mono', monospace; }
  .status.open   { background: #0d200d; color: #53fc18; border: 1px solid #2a5a2a; }
  .status.closed { background: #200d0d; color: #ff4444; border: 1px solid #5a2a2a; }

  .buttons { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; justify-content: center; }
  button { padding: 8px 18px; border: none; border-radius: 7px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: 'Rajdhani', sans-serif; letter-spacing: 0.3px; transition: opacity 0.2s, transform 0.1s; }
  button:hover  { opacity: 0.82; }
  button:active { transform: scale(0.97); }
  .btn-csv    { background: #53fc18; color: #000; }
  .btn-reset  { background: #c0392b; color: #fff; }
  .btn-stop   { background: #e67e22; color: #fff; padding: 3px 12px; font-size: 12px; }
  .btn-upd    { background: #1e1e1e; color: #888; border: 1px solid #2a2a2a; }
  .btn-out    { background: #111; color: #333; border: 1px solid #1a1a1a; font-size: 12px; }

  .list { background: #111; border: 1px solid #1a1a1a; border-radius: 10px; overflow: hidden; }
  .list-head { padding: 9px 16px; background: #141414; color: #333; font-size: 10px; letter-spacing: 2px; text-align: center; font-family: 'Share Tech Mono', monospace; border-bottom: 1px solid #1a1a1a; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); }
  .player { display: flex; align-items: center; padding: 6px 10px; border-bottom: 1px solid #141414; border-right: 1px solid #141414; gap: 7px; transition: background 0.1s; }
  .player:hover { background: #141414; }
  .player:nth-child(4n) { border-right: none; }
  .pnum { color: #2a2a2a; width: 24px; font-size: 10px; flex-shrink: 0; font-family: 'Share Tech Mono', monospace; }
  .pname { color: #ddd; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 32px; text-align: center; color: #2a2a2a; font-family: 'Share Tech Mono', monospace; font-size: 12px; }
  .footer { font-size: 10px; color: #1e1e1e; margin-top: 8px; text-align: center; font-family: 'Share Tech Mono', monospace; }
  .cmd-panel { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 12px; }
  .cmd-panel input { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 7px; padding: 7px 12px; color: #53fc18; font-family: 'Share Tech Mono', monospace; font-size: 14px; outline: none; width: 140px; text-align: center; transition: border-color 0.2s; }
  .cmd-panel input:focus { border-color: #53fc18; }
  .btn-cmd { background: #1a2a1a; color: #53fc18; border: 1px solid #2a5a2a; border-radius: 7px; padding: 7px 14px; font-family: 'Rajdhani', sans-serif; font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
  .btn-cmd:hover { opacity: 0.8; }
  #cmd-saved { font-size: 11px; font-family: 'Share Tech Mono', monospace; color: #555; }
  .test-panel { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; justify-content: center; flex-wrap: wrap; }
  .test-panel input { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 7px; padding: 7px 12px; color: #fff; font-family: 'Share Tech Mono', monospace; font-size: 12px; outline: none; width: 180px; transition: border-color 0.2s; }
  .test-panel input:focus { border-color: #444; }
  .btn-test { background: #1e3a1e; color: #53fc18; border: 1px solid #2a5a2a; border-radius: 7px; padding: 7px 14px; font-family: 'Rajdhani', sans-serif; font-size: 13px; font-weight: 700; cursor: pointer; transition: opacity 0.2s; }
  .btn-test:hover { opacity: 0.8; }
  #test-result { font-size: 11px; font-family: 'Share Tech Mono', monospace; color: #555; }
</style>
</head>
<body>
<div class="wrapper">
  <h1>🎮 KICK MARBLES BOT</h1>
  <div class="sub">kosteze231 · автообновление 5с</div>

  <div class="stats">
    <div class="stat">
      <div class="stat-num" id="count">0</div>
      <div class="stat-label">игроков зарегистрировано</div>
    </div>
  </div>

  <div class="bar-wrap">
    <div class="bar-bg"><div class="bar" id="bar" style="width:0%"></div></div>
    <div class="bar-label" id="bar-label">0 / 1000</div>
  </div>

  <div class="status-wrap">
    <div class="status open" id="status">● регистрация открыта</div>
    <button class="btn-stop" id="btn-stop" onclick="toggleStop()">⏹ Стоп</button>
  </div>

  <div class="buttons">
    <button class="btn-csv"   onclick="downloadCSV()">⬇ Скачать CSV</button>
    <button class="btn-reset" onclick="resetList()">🗑 Сбросить список</button>
    <button class="btn-upd"   onclick="loadPlayers()">↻ Обновить</button>
    <button class="btn-out"   onclick="logout()">выйти</button>
  </div>

  <div class="cmd-panel">
    <span style="font-size:11px;color:#444;font-family:'Share Tech Mono',monospace;">слово реєстрації:</span>
    <input type="text" id="cmd-input" value="!play" placeholder="!play" onkeydown="if(event.key==='Enter')saveCmd()">
    <button class="btn-cmd" onclick="saveCmd()">✓ Зберегти</button>
    <span id="cmd-saved"></span>
  </div>

  <div class="test-panel">
    <input type="text" id="test-name" placeholder="Ник для теста..." onkeydown="if(event.key==='Enter')testPlay()">
    <button class="btn-test" onclick="testPlay()" id="btn-test">▶ Тест</button>
    <span id="test-result"></span>
  </div>

  <div class="list">
    <div class="list-head">СПИСОК ИГРОКОВ</div>
    <div id="plist"><div class="empty">никто ещё не зарегистрировался</div></div>
  </div>
  <div class="footer">автообновление каждые 5 секунд</div>
</div>

<script>
async function loadPlayers() {
  const res = await fetch('/api/players');
  if (res.status === 401) { location.reload(); return; }
  const d = await res.json();

  document.getElementById('count').textContent = d.players.length;

  const pct = Math.min(d.players.length / 1000 * 100, 100);
  const bar = document.getElementById('bar');
  bar.style.width = pct + '%';
  bar.style.background = d.players.length >= 1000 ? '#ff4444' : d.players.length >= 800 ? '#ffaa00' : '#53fc18';
  document.getElementById('bar-label').textContent = d.players.length + ' / 1000';

  const cmdInput = document.getElementById('cmd-input');
  if (cmdInput && d.joinCmd && document.activeElement !== cmdInput) {
    cmdInput.value = d.joinCmd;
  }
  const st = document.getElementById('status');
  st.textContent = d.accepting ? '● регистрация открыта' : '● регистрация закрыта';
  st.className = 'status ' + (d.accepting ? 'open' : 'closed');
  const stopBtn = document.getElementById('btn-stop');
  if (stopBtn) stopBtn.textContent = d.accepting ? '⏹ Остановить регистрацию' : '▶ Открыть регистрацию';

  const list = document.getElementById('plist');
  if (!d.players.length) {
    list.innerHTML = '<div class="empty">никто ещё не зарегистрировался</div>';
    return;
  }
  list.innerHTML = '<div class="grid">' + d.players.map((n, i) =>
    '<div class="player"><span class="pnum">' + (i+1) + '</span><span class="pname">' + n + '</span></div>'
  ).join('') + '</div>';
}

async function saveCmd() {
  const cmd = document.getElementById('cmd-input').value.trim();
  if (!cmd) return;
  const res = await fetch('/api/setcmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd })
  });
  const el = document.getElementById('cmd-saved');
  if (res.ok) {
    el.style.color = '#53fc18';
    el.textContent = '✓ збережено';
  } else {
    el.style.color = '#ff4444';
    el.textContent = '✗ помилка';
  }
  setTimeout(() => el.textContent = '', 2000);
}

async function testPlay() {
  const name = document.getElementById('test-name').value.trim();
  if (!name) return;
  const res = await fetch('/api/testplay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name })
  });
  const data = await res.json();
  const el = document.getElementById('test-result');
  if (data.ok) {
    el.style.color = '#53fc18';
    el.textContent = '✓ добавлен (' + data.total + ')';
    document.getElementById('test-name').value = '';
  } else {
    el.style.color = '#ff4444';
    el.textContent = '✗ ' + data.error;
  }
  setTimeout(() => el.textContent = '', 3000);
  loadPlayers();
}

async function toggleStop() {
  await fetch('/api/stop', { method: 'POST' });
  loadPlayers();
}

function downloadCSV() { window.location.href = '/api/csv'; }

async function resetList() {
  if (!confirm('Сбросить список всех игроков?')) return;
  await fetch('/api/reset', { method: 'POST' });
  loadPlayers();
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

loadPlayers();
setInterval(loadPlayers, 5000);
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

  if (req.url === '/api/setcmd' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { cmd } = JSON.parse(body);
        const trimmed = cmd.trim().toLowerCase();
        if (!trimmed || trimmed.length > 30) { res.writeHead(400); res.end(); return; }
        joinCmd = trimmed;
        saveState();
        console.log('[BOT] Команда реєстрації змінена на: ' + joinCmd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cmd: joinCmd }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/players') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ players, accepting, joinCmd }));
    return;
  }

  if (req.url.startsWith('/api/testplay') && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { username } = JSON.parse(body);
        const name = (username || '').trim();
        if (!name) { res.writeHead(400); res.end(JSON.stringify({ error: 'Нет имени' })); return; }
        if (!accepting) { res.writeHead(200); res.end(JSON.stringify({ error: 'Регистрация закрыта' })); return; }
        if (players.length >= MAX_PLAYERS) { res.writeHead(200); res.end(JSON.stringify({ error: 'Лимит достигнут' })); return; }
        if (players.includes(name)) { res.writeHead(200); res.end(JSON.stringify({ error: 'Уже в списке' })); return; }
        players.push(name);
        saveState(); saveCSV();
        console.log('[TEST] Добавлен тестовый игрок: ' + name);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, total: players.length }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="marble.csv"'
    });
    res.end(players.join('\n'));
    return;
  }

  if (req.url === '/api/stop' && req.method === 'POST') {
    accepting = !accepting;
    saveState();
    console.log('[BOT] Регистрация ' + (accepting ? 'ОТКРЫТА' : 'ОСТАНОВЛЕНА') + ' через веб-интерфейс');
    res.writeHead(200); res.end();
    return;
  }

  if (req.url === '/api/reset' && req.method === 'POST') {
    players   = [];
    accepting = true;
    saveState();
    try { if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE); } catch {}
    console.log('[BOT] Список сброшен через веб-интерфейс');
    res.writeHead(200); res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML());
});

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

      if (lower === joinCmd) {
        if (!accepting) {
          console.log(`[SKIP] ${username}: регистрация закрыта`);
          return;
        }
        if (players.length >= MAX_PLAYERS) {
          accepting = false;
          saveState();
          console.log(`[BOT] Лимит ${MAX_PLAYERS} достигнут — регистрация закрыта`);
          return;
        }
        if (players.includes(username)) {
          console.log(`[DUP]  ${username} уже в списке`);
          return;
        }
        players.push(username);
        saveState();
        saveCSV();
        console.log(`[+] ${username} (${players.length}/${MAX_PLAYERS})`);
        if (players.length >= MAX_PLAYERS) {
          accepting = false;
          saveState();
          console.log(`[BOT] Лимит ${MAX_PLAYERS} достигнут — регистрация закрыта`);
        }
        return;
      }

      if (lower === `${PREFIX}stop` && username.toLowerCase() === STREAMER) {
        accepting = false;
        saveState();
        console.log('[BOT] Регистрация ОСТАНОВЛЕНА (!stop)');
        return;
      }

      if (lower === `${PREFIX}reset` && username.toLowerCase() === STREAMER) {
        players   = [];
        accepting = true;
        saveState();
        try { if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE); } catch {}
        console.log('[BOT] Список ОЧИЩЕН (!reset)');
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
console.log('║   Kick → Marbles on Stream  BOT      ║');
console.log('╠══════════════════════════════════════╣');
console.log(`║  Channel:  ${CHANNEL_ID}                  ║`);
console.log(`║  Chatroom: ${CHATROOM_ID}                  ║`);
console.log('║  Команды: !play / !stop / !reset     ║');
console.log(`║  Лимит: ${MAX_PLAYERS} игроков                ║`);
console.log('║  Защита: пароль через env variable   ║');
console.log('╚══════════════════════════════════════╝\n');

loadState();
connect();
