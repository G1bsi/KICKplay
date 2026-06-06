import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Настройки ──────────────────────────────────────────────
const CHANNEL_ID  = 235226;
const CHATROOM_ID = 235222;
const PREFIX      = '!';
const STREAMER    = 'kosteze231';
const CSV_FILE    = path.join(__dirname, 'marble.csv');
// ───────────────────────────────────────────────────────────

const PUSHER_WS =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679' +
  '?protocol=7&client=js&version=8.4.0-rc2&flash=false';

let players   = [];
let accepting = true;

function saveCSV() {
  fs.writeFileSync(CSV_FILE, players.join('\n'), 'utf8');
  console.log(`[CSV] Сохранено ${players.length} игроков`);
}

// ── Веб-страница для стримера ───────────────────────────────
const HTML = () => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kick Marbles — Список игроков</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0f0f0f; color: #fff; font-family: 'Segoe UI', sans-serif; padding: 24px; }
  h1 { font-size: 22px; color: #53fc18; margin-bottom: 6px; }
  .sub { color: #888; font-size: 14px; margin-bottom: 20px; }
  .stats { display: flex; gap: 16px; margin-bottom: 20px; }
  .stat { background: #1a1a1a; border: 1px solid #333; border-radius: 10px; padding: 14px 22px; }
  .stat-num { font-size: 32px; font-weight: bold; color: #53fc18; }
  .stat-label { font-size: 12px; color: #888; margin-top: 2px; }
  .status { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: bold; margin-bottom: 20px; }
  .status.open { background: #1a3a1a; color: #53fc18; border: 1px solid #53fc18; }
  .status.closed { background: #3a1a1a; color: #ff4444; border: 1px solid #ff4444; }
  .buttons { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
  button { padding: 10px 20px; border: none; border-radius: 8px; font-size: 14px; font-weight: bold; cursor: pointer; transition: opacity 0.2s; }
  button:hover { opacity: 0.8; }
  .btn-csv { background: #53fc18; color: #000; }
  .btn-reset { background: #ff4444; color: #fff; }
  .btn-refresh { background: #333; color: #fff; }
  .list { background: #1a1a1a; border: 1px solid #333; border-radius: 10px; overflow: hidden; }
  .list-header { padding: 12px 16px; background: #222; color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .player { display: flex; align-items: center; padding: 10px 16px; border-bottom: 1px solid #222; font-size: 14px; }
  .player:last-child { border-bottom: none; }
  .player-num { color: #555; width: 36px; font-size: 12px; }
  .player-name { color: #fff; }
  .empty { padding: 40px; text-align: center; color: #555; }
  .auto { font-size: 12px; color: #555; margin-top: 12px; }
</style>
</head>
<body>
<h1>🎮 Kick Marbles Bot</h1>
<div class="sub">Канал: kosteze231 · Обновляется автоматически каждые 5 секунд</div>

<div class="stats">
  <div class="stat">
    <div class="stat-num" id="count">0</div>
    <div class="stat-label">Игроков зарегистрировано</div>
  </div>
</div>

<div class="status open" id="status">● Регистрация открыта</div>

<div class="buttons">
  <button class="btn-csv" onclick="downloadCSV()">⬇ Скачать CSV</button>
  <button class="btn-reset" onclick="resetList()">🗑 Сбросить список</button>
  <button class="btn-refresh" onclick="loadPlayers()">↻ Обновить</button>
</div>

<div class="list">
  <div class="list-header">Список игроков</div>
  <div id="players-list"><div class="empty">Никто ещё не зарегистрировался</div></div>
</div>
<div class="auto">Автообновление каждые 5 секунд</div>

<script>
async function loadPlayers() {
  const res = await fetch('/api/players');
  const data = await res.json();
  document.getElementById('count').textContent = data.players.length;
  const statusEl = document.getElementById('status');
  if (data.accepting) {
    statusEl.textContent = '● Регистрация открыта';
    statusEl.className = 'status open';
  } else {
    statusEl.textContent = '● Регистрация закрыта';
    statusEl.className = 'status closed';
  }
  const list = document.getElementById('players-list');
  if (data.players.length === 0) {
    list.innerHTML = '<div class="empty">Никто ещё не зарегистрировался</div>';
    return;
  }
  list.innerHTML = data.players.map((name, i) =>
    '<div class="player"><span class="player-num">' + (i+1) + '</span><span class="player-name">' + name + '</span></div>'
  ).join('');
}

function downloadCSV() {
  window.location.href = '/api/csv';
}

async function resetList() {
  if (!confirm('Сбросить список всех игроков?')) return;
  await fetch('/api/reset', { method: 'POST' });
  loadPlayers();
}

loadPlayers();
setInterval(loadPlayers, 5000);
</script>
</body>
</html>`;

// ── HTTP сервер ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/api/players') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ players, accepting }));
    return;
  }
  if (req.url === '/api/csv') {
    const csv = players.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="marble.csv"'
    });
    res.end(csv);
    return;
  }
  if (req.url === '/api/reset' && req.method === 'POST') {
    players = [];
    accepting = true;
    if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE);
    console.log('[BOT] Список сброшен через веб-интерфейс');
    res.writeHead(200);
    res.end('OK');
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

  ws.on('open', () => {
    console.log('[WS] Подключено к Kick Pusher');
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${CHATROOM_ID}.v2` }
    }));
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

      if (lower === `${PREFIX}play`) {
        if (!accepting) {
          console.log(`[SKIP] ${username} написал !play но регистрация закрыта`);
          return;
        }
        if (players.includes(username)) {
          console.log(`[DUP]  ${username} уже в списке`);
          return;
        }
        players.push(username);
        saveCSV();
        console.log(`[+] ${username} добавлен (всего: ${players.length})`);
        return;
      }

      if (lower === `${PREFIX}stop` && username.toLowerCase() === STREAMER) {
        accepting = false;
        console.log('[BOT] Регистрация ОСТАНОВЛЕНА командой !stop');
        return;
      }

      if (lower === `${PREFIX}reset` && username.toLowerCase() === STREAMER) {
        players   = [];
        accepting = true;
        if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE);
        console.log('[BOT] Список ОЧИЩЕН командой !reset, регистрация открыта');
        return;
      }
    }
  });

  ws.on('error', (err) => console.error('[WS] Ошибка:', err.message));

  ws.on('close', () => {
    console.log('[WS] Соединение закрыто, переподключение через 5с...');
    setTimeout(connect, 5000);
  });

  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    }
  }, 30000);
}

console.log('╔══════════════════════════════════════╗');
console.log('║   Kick → Marbles on Stream  BOT      ║');
console.log('╠══════════════════════════════════════╣');
console.log(`║  Channel:  ${CHANNEL_ID}                  ║`);
console.log(`║  Chatroom: ${CHATROOM_ID}                  ║`);
console.log('║  Команды: !play / !stop / !reset     ║');
console.log('╚══════════════════════════════════════╝\n');

connect();
