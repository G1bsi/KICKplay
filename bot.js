import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Налаштування ──────────────────────────────────────────────
const CHANNEL_ID  = 389295;   // твій channel id
const CHATROOM_ID = 389201;   // твій chatroom id
const PREFIX      = '!';
const CSV_FILE    = path.join(__dirname, 'marble.csv');
// ─────────────────────────────────────────────────────────────

const PUSHER_WS =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679' +
  '?protocol=7&client=js&version=8.4.0-rc2&flash=false';

let players   = [];   // список нікнеймів
let accepting = true; // чи приймаємо заявки

function saveCSV() {
  fs.writeFileSync(CSV_FILE, players.join('\n'), 'utf8');
  console.log(`[CSV] Збережено ${players.length} гравців → ${CSV_FILE}`);
}

function connect() {
  const ws = new WebSocket(PUSHER_WS);

  ws.on('open', () => {
    console.log('[WS] Підключено до Kick Pusher');

    // Підписуємось на чат-кімнату
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { auth: '', channel: `chatrooms.${CHATROOM_ID}.v2` }
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Підтримка ping
    if (msg.event === 'pusher:ping') {
      ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      return;
    }

    // Успішна підписка
    if (msg.event === 'pusher_internal:subscription_succeeded') {
      console.log(`[WS] Підписка на chatroom ${CHATROOM_ID} активна`);
      console.log('[BOT] Бот працює! Чекаю команди в чаті...\n');
      return;
    }

    // Повідомлення чату
    if (msg.event === 'App\\Events\\ChatMessageEvent') {
      let data;
      try { data = JSON.parse(msg.data); } catch { return; }

      const username = data?.sender?.username;
      const content  = data?.content?.trim();
      if (!username || !content) return;

      const lower = content.toLowerCase();

      // !play
      if (lower === `${PREFIX}play`) {
        if (!accepting) {
          console.log(`[SKIP] ${username} написав !play але реєстрація закрита`);
          return;
        }
        if (players.includes(username)) {
          console.log(`[DUP]  ${username} вже в списку`);
          return;
        }
        players.push(username);
        saveCSV();
        console.log(`[+] ${username} доданий (всього: ${players.length})`);
        return;
      }

      // !stop  (тільки стрімер — slug g1bsi)
      if (lower === `${PREFIX}stop` && username.toLowerCase() === 'g1bsi') {
        accepting = false;
        console.log('[BOT] Реєстрація ЗУПИНЕНА командою !stop');
        return;
      }

      // !reset  (тільки стрімер)
      if (lower === `${PREFIX}reset` && username.toLowerCase() === 'g1bsi') {
        players   = [];
        accepting = true;
        if (fs.existsSync(CSV_FILE)) fs.unlinkSync(CSV_FILE);
        console.log('[BOT] Список ОЧИЩЕНО командою !reset, реєстрація відкрита');
        return;
      }
    }
  });

  ws.on('error', (err) => console.error('[WS] Помилка:', err.message));

  ws.on('close', () => {
    console.log('[WS] З\'єднання закрито, перепідключення через 5с...');
    setTimeout(connect, 5000);
  });

  // Ping кожні 30с щоб не відвалився
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
console.log('║  Команди: !play / !stop / !reset     ║');
console.log('╚══════════════════════════════════════╝\n');

connect();
http.createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);
