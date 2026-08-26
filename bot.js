import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import crypto from 'crypto';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Настройки ──────────────────────────────────────────────
const CHATROOM_ID = 235222;
const STATE_FILE  = path.join(__dirname, 'marble_state.json');

// Пароль береться з Environment Variables на Render:
const WEB_PASSWORD = process.env.WEB_PASSWORD;

// OAuth токен бота для відправки повідомлень в чат Kick
// Render Dashboard → Environment → BOT_TOKEN = твій токен
const BOT_TOKEN = process.env.BOT_TOKEN || '';

// Відправляє повідомлення від бота в чат (потребує BOT_TOKEN)
async function sendChatAnnounce(msg) {
  if (!BOT_TOKEN) return;
  try {
    const res = await fetch(`https://kick.com/api/v2/messages/send/${CHATROOM_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + BOT_TOKEN,
        'Accept': 'application/json',
      },
      body: JSON.stringify({ content: msg, type: 'message' }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.log('[CHAT BOT] Помилка відправки:', res.status, text.slice(0, 200));
    } else {
      console.log('[CHAT BOT] Відправлено:', msg);
    }
  } catch (e) {
    console.log('[CHAT BOT] fetch error:', e.message);
  }
}
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
let savedWinners = []; // переможці що зберігаються між сесіями
let savedChatgameWinners = []; // переможці режиму "Бонусбуря с чатом"

function saveState() {
  const state = {
    rafflePlayers, raffleAccepting, raffleJoinCmd,
    savedWinners, savedChatgameWinners,
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
    savedWinners    = Array.isArray(state.savedWinners) ? state.savedWinners : [];
    savedChatgameWinners = Array.isArray(state.savedChatgameWinners) ? state.savedChatgameWinners : [];
    console.log(`[STATE] Восстановлено: ${rafflePlayers.length} участников, ${savedWinners.length} победителей, ${savedChatgameWinners.length} в чат-режиме`);
  } catch (e) {
    console.error('[STATE] Ошибка загрузки:', e.message);
  }
}

// Автозбереження кожні 30 секунд
setInterval(() => { if (rafflePlayers.length > 0) saveState(); }, 30000);

// ── Статика з public/ ───────────────────────────────────────
// Весь фронтенд (розмітка, стилі, клієнтський JS) живе у public/ окремими файлами.
// PROD: читається в пам'ять один раз на старті + gzip + ETag.
// DEV=1: перечитується з диска на кожен запит — правка CSS → F5 в OBS,
//        без рестарту процесу, без реконекту до Kick і без втрати активної гри.
const PUBLIC_DIR = path.join(__dirname, 'public');
// `npm run dev` або `node bot.js --dev` — прапорець працює і на Windows,
// де інлайнове DEV=1 перед командою не задається.
const DEV = !!process.env.DEV || process.argv.includes('--dev');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.woff2':'font/woff2',
  '.mp3':  'audio/mpeg',
  '.ico':  'image/x-icon',
  '.glb':  'model/gltf-binary',   // 3D-моделі перестрілки
};

const assetCache = new Map();

function loadAsset(name) {
  const file = path.resolve(PUBLIC_DIR, name);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return null; // не випускаємо за межі public/
  let buf;
  try {
    if (!fs.statSync(file).isFile()) return null;
    buf = fs.readFileSync(file);
  } catch { return null; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
  const gz = buf.length > 1024 ? zlib.gzipSync(buf, { level: 8 }) : null;
  return { buf, gz, type, etag };
}

function getAsset(name) {
  if (DEV) return loadAsset(name);
  if (!assetCache.has(name)) assetCache.set(name, loadAsset(name));
  return assetCache.get(name);
}

// Віддає файл із public/. cacheControl: 'no-cache' для HTML, 'immutable' для /assets/*?v=
function sendAsset(req, res, name, cacheControl) {
  const a = getAsset(name);
  if (!a) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  if (req.headers['if-none-match'] === a.etag) {
    res.writeHead(304, { 'ETag': a.etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }
  const useGz = a.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body  = useGz ? a.gz : a.buf;
  const headers = {
    'Content-Type': a.type,
    'Content-Length': body.length,
    'ETag': a.etag,
    'Cache-Control': cacheControl,
  };
  if (useGz) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Перевірка на старті: без public/ бот віддавав би 404 замість панелі
for (const required of ['index.html', 'login.html', 'app.css', 'app.js']) {
  if (!getAsset(required)) {
    console.error(`[STATIC] Не знайдено public/${required} — панель не працюватиме.`);
  }
}

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

  // Статика — ДО перевірки сесії. Інакше при протухлій сесії гейт віддає login.html
  // зі статусом 200 і Content-Type text/html замість CSS/JS, і панель рендериться
  // голим HTML прямо в ефірі.
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (req.url.startsWith('/assets/')) {
    const [rawPath, query] = req.url.split('?');
    const name = decodeURIComponent(rawPath.slice('/assets/'.length));
    sendAsset(req, res, name, /(^|&)v=/.test(query || '')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
    return;
  }

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
      sendAsset(req, res, 'login.html', 'no-cache');
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
      savedWinners,
      savedChatgameWinners,
    }));
    return;
  }

  // Зберегти список переможців (викликається з клієнта)
  if (req.url === '/api/winners/save' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { winners } = JSON.parse(body);
        if (Array.isArray(winners)) {
          savedWinners = winners;
          saveState();
        }
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // Зберегти список переможців режиму "Бонусбуря с чатом"
  if (req.url === '/api/chatgame-winners/save' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { winners } = JSON.parse(body);
        if (Array.isArray(winners)) {
          savedChatgameWinners = winners;
          saveState();
        }
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // Очистити збережених переможців
  if (req.url === '/api/winners/clear' && req.method === 'POST') {
    savedWinners = [];
    saveState();
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
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

  if (req.url === '/api/raffle/addcsv' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { names } = JSON.parse(body);
        if (!Array.isArray(names)) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid' })); return; }
        let added = 0;
        names.forEach(name => {
          const n = String(name).trim().slice(0, 64);
          if (n && !rafflePlayers.includes(n)) {
            rafflePlayers.push(n);
            added++;
          }
        });
        saveState();
        console.log(`[РОЗІГРАШ CSV] завантажено ${added} учасників (всього: ${rafflePlayers.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, added, count: rafflePlayers.length }));
      } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'parse error' })); }
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

        // Відправляємо повідомлення в чат Kick
        sendChatAnnounce(`🏆 ПОБЕДИТЕЛЬ: @${w} | ⏳ У тебя ${sec} сек на ответ в чат!`);

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

  // Відправка повідомлення в чат без підтвердження (коли toggle вимкнено)
  if (req.url === '/api/chat/announce' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { winner } = JSON.parse(body);
        const w = (winner || '').trim();
        if (w) sendChatAnnounce(`🏆 ПОБЕДИТЕЛЬ: @${w} — поздравляем!`);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
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

  // Випадкові числа для клієнтських розіграшів (рулетка/револьвер/чат-режим):
  // джерело — random.org, фолбек — crypto. Клієнт сам не ходить на random.org,
  // бо там немає CORS-заголовків.
  if (req.url.startsWith('/api/random/ints')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const num = Math.min(Math.max(parseInt(q.get('n')) || 1, 1), 200);
    const max = Math.min(Math.max(parseInt(q.get('max')) || 2, 1), 1000000);
    rollInts(num, max).then(ints => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ints, source: lastRollSource, proof: lastRollProof }));
    });
    return;
  }

  if (req.url === '/api/raffle/start' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { winners } = JSON.parse(body);
        const n = parseInt(winners);
        if (!rafflePlayers.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'Немає учасників' })); return; }
        const gridSize = rafflePlayers.length;
        if (!n || n < 1 || n > gridSize) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Некоректна кількість переможців (макс ' + gridSize + ')' })); return;
        }
        raffleGame = await buildRaffleGame(n);
        console.log(`[РОЗІГРАШ] Гра запущена: ${n} переможців з ${rafflePlayers.length} учасників (рандом: ${lastRollSource})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, game: raffleGame }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/reroll' && req.method === 'POST') {
    if (!raffleGame) { res.writeHead(400); res.end(JSON.stringify({ error: 'Гра не запущена' })); return; }
    const n = raffleGame.winnersNeeded;
    buildRaffleGame(n).then(g => {
      raffleGame = g;
      console.log(`[РОЗІГРАШ] Рерол: нова гра, ${n} переможців (рандом: ${lastRollSource})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, game: raffleGame }));
    });
    return;
  }

  if (req.url === '/api/raffle/fastreroll' && req.method === 'POST') {
    const n = raffleGame ? raffleGame.winnersNeeded :
      (() => { return null; })();
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const count = parseInt(parsed.winners) || n;
        if (!rafflePlayers.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'Немає учасників' })); return; }
        if (!count || count < 1 || count > rafflePlayers.length) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Некоректна кількість переможців' })); return;
        }
        const shuffled = await trueShuffle(rafflePlayers);
        const winnersList = shuffled.slice(0, count);
        raffleGame = { winnersNeeded: count, cells: null, winners: winnersList, fast: true };
        console.log(`[РОЗІГРАШ] Швидкий рерол: ${winnersList.join(', ')} (рандом: ${lastRollSource})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, winners: winnersList, rollSource: lastRollSource }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  sendAsset(req, res, 'index.html', 'no-cache');
});

// ── Справжня випадковість: random.org (з фолбеком на crypto) ──
// Чому: розіграш має бути перевірюваним для глядачів — random.org видає
// атмосферний шум, а не псевдовипадкові числа. Мережа може лежати або
// вичерпатись квота, тому будь-який збій тихо падає назад на crypto.
const RANDOM_ORG_TIMEOUT = 2500;
// Ключ Signed API (безкоштовний на api.random.org) — Render → Environment →
// RANDOM_ORG_KEY. Є ключ → числа приходять ПІДПИСАНИМИ, і глядач може
// перевірити розіграш на офіційному сайті random.org. Немає — працює
// звичайний відкритий API, лише без сторінки перевірки.
const RANDOM_ORG_KEY = process.env.RANDOM_ORG_KEY || '';
let lastRollSource = 'crypto';
let lastRollProof = null;   // {url, serial} — сторінка перевірки на random.org

// Підписаний ролл: JSON-RPC + посилання на форму перевірки random.org
async function randomOrgSigned(num, min, max) {
  if (!RANDOM_ORG_KEY) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), RANDOM_ORG_TIMEOUT * 2);
  try {
    const res = await fetch('https://api.random.org/json-rpc/4/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'generateSignedIntegers', id: Date.now(),
        params: {
          apiKey: RANDOM_ORG_KEY, n: num, min, max, replacement: true,
          userData: { app: 'KICKplay', chatroom: String(CHATROOM_ID) },
        },
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'rpc error');
    const r = j.result;
    const data = r && r.random && r.random.data;
    if (!Array.isArray(data) || data.length !== num) throw new Error('bad payload');
    /* посилання на офіційну форму: random — base64(JSON об'єкта random),
       signature — як прийшла (base64). Саме такий формат random.org
       використовує у власних прикладах */
    const rnd64 = Buffer.from(JSON.stringify(r.random), 'utf8').toString('base64');
    lastRollProof = {
      url: 'https://api.random.org/signatures/form?format=json&random=' +
           encodeURIComponent(rnd64) + '&signature=' + encodeURIComponent(r.signature),
      serial: r.random.serialNumber || null,
    };
    return data;
  } catch (e) {
    console.log('[ROLL] signed API не спрацював (' + (e && e.message) + ') → відкритий API');
    return null;
  } finally { clearTimeout(t); }
}
async function randomOrgInts(num, min, max) {
  if (num < 1 || max < min) return null;
  const url = 'https://www.random.org/integers/?num=' + num + '&min=' + min +
              '&max=' + max + '&col=1&base=10&format=plain&rnd=new';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), RANDOM_ORG_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'KICKplay raffle bot' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const out = (await res.text()).trim().split(/\s+/).map(Number);
    if (out.length !== num || out.some(v => !Number.isInteger(v) || v < min || v > max)) throw new Error('bad payload');
    return out;
  } catch (e) {
    console.log('[ROLL] random.org недоступний (' + (e && e.message) + ') → crypto');
    return null;
  } finally { clearTimeout(t); }
}
// n випадкових чисел [0, max) — з random.org, інакше crypto
async function rollInts(num, max) {
  lastRollProof = null;
  if (max <= 1) { lastRollSource = 'crypto'; return new Array(num).fill(0); }
  /* На random.org просимо діапазон 1..max — щоб число у підписаному записі
     збігалося з номером учасника у списку (людям зрозуміло: випало 29 —
     дивись 29-го). Всередині коду індекси лишаються 0-базовані. */
  const signed = await randomOrgSigned(num, 1, max);
  if (signed) { lastRollSource = 'random.org'; return signed.map(v => v - 1); }
  const got = await randomOrgInts(num, 1, max);
  if (got) { lastRollSource = 'random.org'; return got.map(v => v - 1); }
  lastRollSource = 'crypto';
  return Array.from({ length: num }, () => crypto.randomInt(0, max));
}
// Перемішування Фішера-Йейтса на числах random.org (фолбек — crypto)
async function trueShuffle(arr) {
  const a = [...arr];
  if (a.length < 2) { lastRollSource = 'crypto'; return a; }
  // для кроку i потрібне число [0, i] → беремо пул під найбільший діапазон
  const pool = await rollInts(a.length - 1, 1000000);
  for (let i = a.length - 1, k = 0; i > 0; i--, k++) {
    const j = pool[k] % (i + 1);   // залишок від великого діапазону — зміщення нехтовно мале
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Генерує сітку: кількість клітинок = кількості учасників, без обмежень
// Криптографічно стійке перемішування (Фішер-Йейтс) на сервері
function secureShuffleServer(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    // crypto.randomInt — рівномірний розподіл без зміщення
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function buildRaffleGame(n) {
  // Cash Hunt: розкладку по клітинках робить random.org (атмосферний шум) —
  // саме вона визначає, кому яка клітинка дістанеться
  const shuffled = await trueShuffle(rafflePlayers);
  const gridSize = shuffled.length;
  const cells = shuffled.slice(0, gridSize);

  return {
    winnersNeeded: n,
    gridSize,
    cells,
    rollSource: lastRollSource,   // 'random.org' або 'crypto' — показуємо глядачам
    rollProof: lastRollProof,     // посилання на офіційну сторінку перевірки
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
      const badges = data?.sender?.identity?.badges || [];
      
      if (!username || !content) return;

      // Відправляємо повідомлення у кастомний чат на фронтенді
      const chatMsg = JSON.stringify({ username, content, color, badges });
      chatClients.forEach(c => c.write(`data: ${chatMsg}\n\n`));

      const lower = content.toLowerCase();

      // Шукаємо переможця case-insensitive
      const checkKey = Object.keys(raffleChecks).find(
        k => k.toLowerCase() === username.toLowerCase()
      );
      console.log(`[CHAT] ${username}: "${content}" | keys: ${JSON.stringify(Object.keys(raffleChecks))} | found key: ${checkKey} | active: ${raffleChecks[checkKey]?.active}`);

      if (checkKey && raffleChecks[checkKey].active) {
        raffleChecks[checkKey].active = false;
        raffleChecks[checkKey].message = content;
        raffleChecks[checkKey].messageAt = Date.now();
        console.log(`[РОЗІГРАШ✓] ${username} ответил: ${content}`);
        // Push до клієнта — не чекаємо наступного poll
        const pushMsg = JSON.stringify({ type: 'winner_reply', name: checkKey, message: content });
        chatClients.forEach(c => c.write(`data: ${pushMsg}\n\n`));
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
