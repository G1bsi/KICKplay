import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import crypto from 'crypto';
import zlib from 'zlib';
import { createPlayRelay } from './ws-play.js';
const MP_ENABLED = process.env.MP === '1';   // мультиплеєр законсервовано до кращих часів

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Настройки ──────────────────────────────────────────────
// Кілька стрімерів на одному сайті: кожен входить своїм паролем і бачить лише свій канал —
// свою реєстрацію, переможців, блеклист і чат. Задаються в Environment Variables на Render:
//   STREAMERS = канал1:пароль1;канал2:пароль2
//   або JSON: [{"channel":"канал1","password":"...","chatroom":123,"botToken":"..."}]
// Без STREAMERS працює як раніше — один стрімер з KICK_CHANNEL / KICK_CHATROOM / WEB_PASSWORD / BOT_TOKEN.
// Безкоштовний Render присипляє сервіс після 15 хв без запитів ззовні. Сплячий
// бот — це зупинений процес: сокет до чату Kick мертвий, повідомлення тих хвилин
// утрачені назавжди, а файл стану може обнулитись при пробудженні. Тому раз на
// KEEPALIVE_MIN хвилин смикаємо власний /healthz через зовнішню адресу (її Render
// сам кладе в RENDER_EXTERNAL_URL) — для платформи це вхідний запит, і сон не настає.
// Вимкнути: KEEPALIVE=0. Своя адреса: KEEPALIVE_URL=https://...
const KEEPALIVE_URL = (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const KEEPALIVE_MIN = Number(process.env.KEEPALIVE_MIN) || 10;
const KEEPALIVE_ON = KEEPALIVE_URL && process.env.KEEPALIVE !== '0';
const STATE_DIR   = process.env.STATE_DIR || __dirname;   // де лежать файли стану (для тестів — окрема тека)
const STATE_FILE  = path.join(STATE_DIR, 'marble_state.json');

// ── Стрімери (окремі «сайти» за одним посиланням) ──
// чат-боти Kick: не реєструємо їх, коли участь — за будь-яке повідомлення
const CHAT_BOTS = new Set(['botrix', 'kicklet', 'kickbot', 'streamelements', 'nightbot', 'fossabot', 'moobot', 'sery_bot', 'wizebot']);
function parseStreamers() {
  const raw = (process.env.STREAMERS || '').trim();
  if (!raw) {
    // старий режим: один стрімер
    return [{ channel: (process.env.KICK_CHANNEL || '').trim().toLowerCase(), password: process.env.WEB_PASSWORD,
      chatroom: Number(process.env.KICK_CHATROOM) || 235222, botToken: process.env.BOT_TOKEN || '' }];
  }
  let list;
  if (raw[0] === '[') {
    try { list = JSON.parse(raw); } catch (e) { console.error('[STREAMERS] JSON не читається: ' + e.message); process.exit(1); }
  } else {
    list = raw.split(/[;\n]+/).map(x => x.trim()).filter(Boolean).map(x => {
      const k = x.indexOf(':');
      return k < 0 ? { channel: x } : { channel: x.slice(0, k).trim(), password: x.slice(k + 1).trim() };
    });
  }
  return list.map((c, i) => ({
    channel: String(c.channel || '').trim().toLowerCase().replace(/^@/, ''),
    password: c.password != null ? String(c.password) : '',
    chatroom: Number(c.chatroom) || (i === 0 ? Number(process.env.KICK_CHATROOM) || 0 : 0),
    // токен бота: свій у JSON, інакше BOT_TOKEN — лише для першого стрімера (як було)
    botToken: c.botToken || (i === 0 ? process.env.BOT_TOKEN || '' : ''),
  }));
}
function newKickState() {
  return { state: 'init', subscribed: false, msgs: 0, lastMsgAt: 0, lastError: '', reconnects: 0, since: Date.now() };
}
const TENANTS = parseStreamers().map((c, i) => ({
  id: c.channel || 'main', channel: c.channel, password: c.password, botToken: c.botToken,
  chatroomId: c.chatroom || 235222,
  // перший стрімер лишається на старому файлі стану (сумісність), решта — на своїх
  stateFile: i === 0 ? STATE_FILE : path.join(STATE_DIR, 'state_' + (c.channel || 'main').replace(/[^\w-]/g, '_') + '.json'),
  players: [], accepting: false, joinCmd: '', game: null, checks: {}, blacklist: [],
  savedWinners: [], savedChatgameWinners: [],
  chatClients: [],        // SSE-підключення панелі цього стрімера (живий чат)
  kick: newKickState(),   // стан звʼязку з чатом — лампочка BOT STATUS у панелі
}));
{
  const bad = TENANTS.filter(t => !t.password);
  const pw = TENANTS.map(t => t.password), dup = pw.filter((x, i) => x && pw.indexOf(x) !== i);
  const ids = TENANTS.map(t => t.id), dupId = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (bad.length || dup.length || dupId.length) {
    console.error('╔══════════════════════════════════════════════════╗');
    if (bad.length) console.error('║  ОШИБКА: не задан пароль (WEB_PASSWORD / STREAMERS) ║');
    if (dup.length) console.error('║  ОШИБКА: у двух стримеров одинаковый пароль        ║');
    if (dupId.length) console.error('║  ОШИБКА: канал указан дважды в STREAMERS           ║');
    console.error('║  Render Dashboard → Environment                    ║');
    console.error('╚══════════════════════════════════════════════════╝');
    process.exit(1);
  }
}

// Відправляє повідомлення від бота в чат стрімера (потребує його botToken)
async function sendChatAnnounce(T, msg) {
  if (!T.botToken) return;
  try {
    const res = await fetch(`https://kick.com/api/v2/messages/send/${T.chatroomId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + T.botToken,
        'Accept': 'application/json',
      },
      body: JSON.stringify({ content: msg, type: 'message' }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.log(`[CHAT BOT ${T.id}] Помилка відправки:`, res.status, text.slice(0, 200));
    } else {
      console.log(`[CHAT BOT ${T.id}] Відправлено:`, msg);
    }
  } catch (e) {
    console.log(`[CHAT BOT ${T.id}] fetch error:`, e.message);
  }
}
// ───────────────────────────────────────────────────────────

// Kick вимкнув свій публічний Pusher (сокет рвався з кодом 4001 «App key not in
// this cluster») і перейшов на власний Centrifugo. Нинішній шлях: взяти гостьовий
// токен по HTTP, підключитись і підписатись на канал чату.
const KICK_WS_URL = process.env.KICK_WS_URL || 'wss://realtime.us-east-1.platform.kick.com/connection/websocket';
const KICK_TOKEN_URL = process.env.KICK_TOKEN_URL || 'https://web.kick.com/api/v1/realtime/auth/connection';

// Гостьовий токен живе ~45 хв; після розриву беремо новий
async function fetchRealtimeToken() {
  const r = await fetch(KICK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://kick.com', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ client_id: 'js' }),
  });
  if (!r.ok) throw new Error('токен: HTTP ' + r.status);
  const j = await r.json();
  const token = j && j.data && j.data.token;
  if (!token) throw new Error('у відповіді немає токена: ' + JSON.stringify(j).slice(0, 120));
  return token;
}
// ── Розіграш: стан кожного стрімера — у його обʼєкті T (players, accepting, joinCmd, game, checks, blacklist…) ──
// Блеклист («тіньовий бан»): ніки (у нижньому регістрі) ботів і мультиакаунтів. Вони реєструються й видні
// в списку учасників, але виграти не можуть — розіграші беруть лише допущених (eligible()).
// Клієнтські режими фільтрують так само (blacklist.js → blEligible).
// Головна копія живе в браузері панелі (localStorage) і приходить сюди через /api/blacklist:
// на Render файл стану зникає при кожному деплої, а список банів має жити довго.
const normNick = s => String(s || '').trim().replace(/^@+/, '').toLowerCase();
const isBanned = (T, name) => T.blacklist.includes(normNick(name));
const eligible = (T, list) => list.filter(n => !isBanned(T, n));

// Активні сесії: token → { exp, tid } — сесія привʼязана до стрімера, чий пароль ввели
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// стрімер сесії або null
function sessionTenant(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(token); return null; }
  return TENANTS.find(t => t.id === s.tid) || null;
}
function isValidSession(token) { return !!sessionTenant(token); }

// ── Збереження стану (кожен стрімер — свій файл) ────────────
function saveState(T) {
  const state = {
    rafflePlayers: T.players, raffleAccepting: T.accepting, raffleJoinCmd: T.joinCmd,
    savedWinners: T.savedWinners, savedChatgameWinners: T.savedChatgameWinners, raffleBlacklist: T.blacklist,
    savedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(T.stateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error(`[STATE ${T.id}] Ошибка сохранения:`, e.message);
  }
}

function loadState(T) {
  if (!fs.existsSync(T.stateFile)) return;
  try {
    const state = JSON.parse(fs.readFileSync(T.stateFile, 'utf8'));
    T.players   = Array.isArray(state.rafflePlayers) ? state.rafflePlayers : [];
    T.accepting = typeof state.raffleAccepting === 'boolean' ? state.raffleAccepting : false;
    T.joinCmd   = state.raffleJoinCmd || '';
    T.savedWinners = Array.isArray(state.savedWinners) ? state.savedWinners : [];
    T.savedChatgameWinners = Array.isArray(state.savedChatgameWinners) ? state.savedChatgameWinners : [];
    T.blacklist = Array.isArray(state.raffleBlacklist) ? state.raffleBlacklist.map(normNick).filter(Boolean) : [];
    console.log(`[STATE ${T.id}] Восстановлено: ${T.players.length} участников, ${T.savedWinners.length} победителей, ${T.savedChatgameWinners.length} в чат-режиме`);
  } catch (e) {
    console.error(`[STATE ${T.id}] Ошибка загрузки:`, e.message);
  }
}

// Автозбереження кожні 30 секунд
setInterval(() => { for (const T of TENANTS) if (T.players.length > 0) saveState(T); }, 30000);

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
  '.mjs':  'text/javascript; charset=utf-8',   // ESM (Rapier для марблс) — браузер вимагає JS-MIME для module-скриптів
  '.wasm': 'application/wasm',
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

// Медіа з довгим кешем (див. маршрут /assets/): міняється рідко, а на хостингу
// кожна зайва перевірка — окремий round-trip перед стартом режиму
const MEDIA_RE = /\.(webp|png|jpe?g|gif|svg|ico|glb|mp3|woff2?)$/i;

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
  // gzip лишаємо лише коли він реально менший: webp/mp3 уже стиснуті, і
  // «стиснута» копія виходила більшою за оригінал — ми слали зайві байти
  const gzTry = buf.length > 1024 ? zlib.gzipSync(buf, { level: 8 }) : null;
  const gz = gzTry && gzTry.length < buf.length * 0.92 ? gzTry : null;
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
// ── Аватарки Kick для панелі ─────────────────────────────────
// У подіях чату Kick аватарки немає — беремо її з профілю (api/v1/users/<нік>,
// поле profilepic), кешуємо і віддаємо панелі як редирект на картинку
// (files.kick.com / s3 — <img> тягне без CORS). Запити — чергою по 3, щоб на
// розіграші з сотнями учасників не засипати Kick. Kick іноді ріже хмарні IP —
// тоді кеш тримає «немає» 15 хв, а панель показує кольорову літеру.
const avatarCache = new Map();        // нік (lower) → { url|null, t }
const avatarQueue = [];               // ніки, що чекають запиту
const avatarWaiters = new Map();      // нік (lower) → [resolve]
let avatarActive = 0;
function avatarFetchOne(name) {
  const key = name.toLowerCase();
  avatarActive++;
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 6000);
  fetch('https://kick.com/api/v1/users/' + encodeURIComponent(name), { signal: ac.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } })
    .then(r => r.ok ? r.json() : null)
    .then(j => { const u = j && (j.profilepic || j.profile_pic); return typeof u === 'string' && /^https:\/\//.test(u) ? u : null; })
    .catch(() => null)
    .then(url => {
      clearTimeout(to); avatarActive--;
      avatarCache.set(key, { url, t: Date.now() });
      (avatarWaiters.get(key) || []).forEach(fn => fn(url)); avatarWaiters.delete(key);
      avatarPump();
    });
}
function avatarPump() {
  while (avatarActive < 3 && avatarQueue.length) avatarFetchOne(avatarQueue.shift());
}
function avatarFresh(key) {
  const c = avatarCache.get(key);
  if (!c) return false;
  return Date.now() - c.t < (c.url ? 24 * 3600e3 : 15 * 60e3);
}
function avatarWant(name) {
  const key = String(name || '').toLowerCase();
  if (!/^[a-z0-9_\-.]{1,40}$/i.test(key) || avatarFresh(key)) return;
  if (avatarQueue.some(n => n.toLowerCase() === key) || avatarWaiters.has(key)) return;
  if (avatarCache.size > 5000) avatarCache.clear();
  avatarQueue.push(name); avatarPump();
}
function avatarGet(name, ms) {
  const key = String(name || '').toLowerCase();
  if (avatarFresh(key)) return Promise.resolve(avatarCache.get(key).url);
  if (!/^[a-z0-9_\-.]{1,40}$/i.test(key)) return Promise.resolve(null);
  return new Promise(res => {
    const list = avatarWaiters.get(key) || []; list.push(res); avatarWaiters.set(key, list);
    if (!avatarQueue.some(n => n.toLowerCase() === key) && list.length === 1) { avatarQueue.push(name); avatarPump(); }
    setTimeout(() => res(null), ms);
  });
}

const server = http.createServer((req, res) => {

  // Статика — ДО перевірки сесії. Інакше при протухлій сесії гейт віддає login.html
  // зі статусом 200 і Content-Type text/html замість CSS/JS, і панель рендериться
  // голим HTML прямо в ефірі.
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (req.url.startsWith('/assets/')) {
    const [rawPath, query] = req.url.split('?');
    const name = decodeURIComponent(rawPath.slice('/assets/'.length));
    // Медіа (картинки, моделі, звуки) кешуємо на тиждень: з 'no-cache' браузер
    // перепитував КОЖЕН файл, і бій на 80 моделях витрачав ~13 кіл RTT на самі
    // лише 304-і. Код (js/css/html) лишається no-cache — він міняється щодеплою
    sendAsset(req, res, name, /(^|&)v=/.test(query || '')
      ? 'public, max-age=31536000, immutable'
      : (MEDIA_RE.test(name) ? 'public, max-age=604800' : 'no-cache'));
    return;
  }

  // Сторінка гравця — публічна, БЕЗ сесійного гейта: глядачі заходять
  // з телефонів без пароля; привʼязка до ніка йде через код у чаті
  if (MP_ENABLED && (req.url === '/play' || req.url === '/play/')) {
    sendAsset(req, res, 'play.html', 'no-cache');
    return;
  }

  // Публічна перевірка живості — без пароля, щоб її міг смикати пінгер
  // (і щоб із телефона було видно, чи бот узагалі слухає чат)
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: TENANTS.every(T => T.kick.subscribed),
      uptimeSec: Math.round(process.uptime()),
      streamers: TENANTS.map(T => ({
        channel: T.channel || null, ok: T.kick.subscribed, state: T.kick.state, chatroom: T.chatroomId, msgs: T.kick.msgs,
        lastMsgAgo: T.kick.lastMsgAt ? Math.round((Date.now() - T.kick.lastMsgAt) / 1000) : null,
        reconnects: T.kick.reconnects, error: T.kick.lastError || null, accepting: T.accepting, players: T.players.length,
      })),
    }));
    return;
  }

  // Логін — відкритий маршрут
  if (req.url === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        const T = TENANTS.find(t => t.password === password);
        if (T) {
          const token = generateToken();
          sessions.set(token, { exp: Date.now() + 86400000, tid: T.id });
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
  const T = sessionTenant(token);   // стрімер, чий пароль ввели — усе нижче працює з його даними
  if (!T) {
    if (req.url.startsWith('/api/')) {
      res.writeHead(401); res.end();
    } else {
      sendAsset(req, res, 'login.html', 'no-cache');
    }
    return;
  }

  // SSE маршрут для живого чату (чат саме цього стрімера)
  if (req.url === '/api/chat/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    T.chatClients.push(res);
    req.on('close', () => {
      T.chatClients = T.chatClients.filter(c => c !== res);
    });
    return;
  }

  if (req.url === '/api/logout' && req.method === 'POST') {
    sessions.delete(token);
    res.writeHead(200); res.end();
    return;
  }

  // аватарка учасника: 302 на картинку Kick або 404 (панель покаже літеру)
  if (req.url.startsWith('/api/avatar/')) {
    const name = decodeURIComponent(req.url.slice('/api/avatar/'.length).split('?')[0]);
    avatarGet(name, 5000).then(url => {
      if (url) res.writeHead(302, { 'Location': url, 'Cache-Control': 'private, max-age=86400' });
      else res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
    });
    return;
  }

  // ── Розіграш (Cash Hunt) API ────────────────────────────────
  if (req.url === '/api/raffle/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tenant: T.id,
      channel: T.channel || null,
      joinCmd: T.joinCmd,
      accepting: T.accepting,
      participants: T.players,
      count: T.players.length,
      game: T.game,
      savedWinners: T.savedWinners,
      savedChatgameWinners: T.savedChatgameWinners,
      blacklist: T.blacklist,
      // звʼязок із чатом Kick — щоб «бот не реєструє» було видно одразу в панелі
      kick: {
        ok: T.kick.subscribed,
        state: T.kick.state,
        chatroom: T.chatroomId,
        channel: T.channel || null,
        msgs: T.kick.msgs,
        lastMsgAgo: T.kick.lastMsgAt ? Math.round((Date.now() - T.kick.lastMsgAt) / 1000) : null,
        error: T.kick.lastError || null,
        reconnects: T.kick.reconnects,
      },
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
          T.savedWinners = winners;
          saveState(T);
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
          T.savedChatgameWinners = winners;
          saveState(T);
        }
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // Очистити збережених переможців
  if (req.url === '/api/winners/clear' && req.method === 'POST') {
    T.savedWinners = [];
    saveState(T);
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === '/api/raffle/csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="participants.csv"'
    });
    res.end(T.players.join('\n'));
    return;
  }

  if (req.url === '/api/raffle/setcmd' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { cmd } = JSON.parse(body);
        // порожнє слово = участь за будь-яке повідомлення в чаті
        const trimmed = (cmd || '').trim().toLowerCase();
        if (trimmed.length > 30) { res.writeHead(400); res.end(); return; }
        T.joinCmd = trimmed;
        saveState(T);
        console.log('[РОЗІГРАШ] Слово реєстрації: ' + (T.joinCmd || '(будь-яке повідомлення)'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cmd: T.joinCmd }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/toggle' && req.method === 'POST') {
    T.accepting = !T.accepting;
    saveState(T);
    console.log('[РОЗІГРАШ] Реєстрація ' + (T.accepting ? 'ВІДКРИТА' : 'ЗАКРИТА'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, accepting: T.accepting }));
    return;
  }

  if (req.url === '/api/raffle/reset' && req.method === 'POST') {
    T.players = [];
    T.accepting = false;
    T.game = null;
    saveState(T);
    console.log('[РОЗІГРАШ] Список учасників очищено');
    res.writeHead(200); res.end();
    return;
  }

  // Блеклист: панель надсилає весь список (після правки або коли сервер перезапустився й список порожній)
  if (req.url === '/api/blacklist' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { list } = JSON.parse(body);
        if (!Array.isArray(list)) { res.writeHead(400); res.end(); return; }
        T.blacklist = [...new Set(list.map(normNick).filter(n => n && n.length <= 40))].slice(0, 5000);
        saveState(T);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, list: T.blacklist, count: T.players.length }));
      } catch { res.writeHead(400); res.end(); }
    });
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
        if (T.players.includes(trimmed)) { res.writeHead(200); res.end(JSON.stringify({ error: 'Уже в списке' })); return; }
        T.players.push(trimmed);
        saveState(T);
        console.log(`[РОЗІГРАШ +тест] ${trimmed} (${T.players.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count: T.players.length }));
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
          } while (T.players.includes(name));
          T.players.push(name);
          added++;
        }
        saveState(T);
        console.log(`[РОЗІГРАШ +тест] добавлено ${added} тестовых участников (всего: ${T.players.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, added, count: T.players.length }));
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
          if (n && !T.players.includes(n)) {
            T.players.push(n);
            added++;
          }
        });
        saveState(T);
        console.log(`[РОЗІГРАШ CSV] завантажено ${added} учасників (всього: ${T.players.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, added, count: T.players.length }));
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
        T.checks[w] = { seconds: sec, startedAt: Date.now(), active: true, message: null, messageAt: null };
        console.log(`[РОЗІГРАШ] Таймер запущен для ${w} (${sec}с)`);

        // Відправляємо повідомлення в чат Kick
        sendChatAnnounce(T, `🏆 ПОБЕДИТЕЛЬ: @${w} | ⏳ У тебя ${sec} сек на ответ в чат!`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/check/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ checks: T.checks }));
    return;
  }

  if (req.url === '/api/raffle/check/reset' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { winner } = JSON.parse(body);
        const w = (winner || '').trim();
        if (w) delete T.checks[w];
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
        if (w) sendChatAnnounce(T, `🏆 ПОБЕДИТЕЛЬ: @${w} — поздравляем!`);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/finish' && req.method === 'POST') {
    T.game = null;
    T.checks = {};
    T.accepting = false;
    saveState(T);
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
    const ctx = { chatroom: T.chatroomId };
    rollInts(num, max, ctx).then(ints => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ints, source: ctx.source, proof: ctx.proof }));
    });
    return;
  }

  // Перестановка 1..N для клієнтських розіграшів (револьвер, чат-режим):
  // на сторінці перевірки видно зрозумілий порядок, а не службові числа
  if (req.url.startsWith('/api/random/perm')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const n = Math.min(Math.max(parseInt(q.get('n')) || 2, 2), 10000);
    // k — скільки треба вибрати (без k = перестановка всього списку)
    const k = Math.min(Math.max(parseInt(q.get('k')) || n, 1), n);
    // опис призначення ролла — глядач бачить його на сторінці перевірки
    const what = String(q.get('what') || '').slice(0, 200) || undefined;
    const ctx = { chatroom: T.chatroomId };
    truePick(n, k, what, ctx).then(order => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ order, source: ctx.source, proof: ctx.proof }));
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
        if (!T.players.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'Немає учасників' })); return; }
        const gridSize = T.players.length;
        if (!n || n < 1 || n > gridSize) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Некоректна кількість переможців (макс ' + gridSize + ')' })); return;
        }
        T.game = await buildRaffleGame(T, n);
        console.log(`[РОЗІГРАШ ${T.id}] Гра запущена: ${n} переможців з ${T.players.length} учасників (рандом: ${T.game.rollSource})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, game: T.game }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/api/raffle/reroll' && req.method === 'POST') {
    if (!T.game) { res.writeHead(400); res.end(JSON.stringify({ error: 'Гра не запущена' })); return; }
    const n = T.game.winnersNeeded;
    buildRaffleGame(T, n).then(g => {
      T.game = g;
      console.log(`[РОЗІГРАШ ${T.id}] Рерол: нова гра, ${n} переможців (рандом: ${g.rollSource})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, game: T.game }));
    });
    return;
  }

  if (req.url === '/api/raffle/fastreroll' && req.method === 'POST') {
    const n = T.game ? T.game.winnersNeeded :
      (() => { return null; })();
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const count = parseInt(parsed.winners) || n;
        if (!T.players.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'Немає учасників' })); return; }
        if (!count || count < 1 || count > T.players.length) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Некоректна кількість переможців' })); return;
        }
        const pool = eligible(T, T.players);
        if (!pool.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'Немає учасників' })); return; }
        const ctx = { chatroom: T.chatroomId };
        const shuffled = await trueShuffle(pool,
          'Быстрый реролл: выбор ' + count + ' победителей из ' + pool.length, ctx);
        const winnersList = shuffled.slice(0, count);
        T.game = { winnersNeeded: count, cells: null, winners: winnersList, fast: true };
        console.log(`[РОЗІГРАШ ${T.id}] Швидкий рерол: ${winnersList.join(', ')} (рандом: ${ctx.source})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, winners: winnersList, rollSource: ctx.source }));
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  sendAsset(req, res, 'index.html', 'no-cache');
});

/* ── Мультиплеєр перестрілки: реле /ws/play на ТОМУ Ж http-сервері ──
   Хост (панель) підтверджується сесійною кукою; гравці — публічні,
   привʼязка ніка — кодом у чаті Kick (див. обробник ChatMessageEvent). */
/* реле створюється лише з MP=1; заглушка-обʼєкт тримає ті самі методи,
   щоб виклики з обробника чату не падали */
const playRelay = MP_ENABLED ? createPlayRelay({
  server,
  isHostReq: (req) => isValidSession(getCookie(req, 'session')),
}) : { chatCode: () => false };

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
// Джерело ролла ('random.org' | 'crypto') і доказ {url, serial} пишуться в ctx конкретного виклику:
// два стрімери можуть розігрувати одночасно, і спільна змінна переплутала б їхні посилання перевірки

// Підписаний ролл: JSON-RPC + посилання на форму перевірки random.org
async function randomOrgSigned(num, min, max, ctx) {
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
          userData: { app: 'KICKplay', chatroom: String(ctx.chatroom || '') },
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
    ctx.proof = {
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
async function rollInts(num, max, ctx = {}) {
  ctx.proof = null;
  if (max <= 1) { ctx.source = 'crypto'; return new Array(num).fill(0); }
  /* На random.org просимо діапазон 1..max — щоб число у підписаному записі
     збігалося з номером учасника у списку (людям зрозуміло: випало 29 —
     дивись 29-го). Всередині коду індекси лишаються 0-базовані. */
  const signed = await randomOrgSigned(num, 1, max, ctx);
  if (signed) { ctx.source = 'random.org'; return signed.map(v => v - 1); }
  const got = await randomOrgInts(num, 1, max);
  if (got) { ctx.source = 'random.org'; return got.map(v => v - 1); }
  ctx.source = 'crypto';
  return Array.from({ length: num }, () => crypto.randomInt(0, max));
}
// Підписана ПЕРЕСТАНОВКА 1..N з random.org (replacement:false — кожне число
// рівно раз). Саме її видно на сторінці перевірки: це і є порядок розсадки
// по клітинках, читабельний людиною, а не тисячі службових чисел.
async function randomOrgSignedPerm(n, what, total, ctx) {
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
          apiKey: RANDOM_ORG_KEY, n, min: 1, max: total || n, replacement: false,
          userData: { app: 'KICKplay', what: what || 'случайный порядок участников' },
        },
      }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'rpc error');
    const r = j.result;
    const data = r && r.random && r.random.data;
    if (!Array.isArray(data) || data.length !== n) throw new Error('bad payload');
    const rnd64 = Buffer.from(JSON.stringify(r.random), 'utf8').toString('base64');
    ctx.proof = {
      url: 'https://api.random.org/signatures/form?format=json&random=' +
           encodeURIComponent(rnd64) + '&signature=' + encodeURIComponent(r.signature),
      serial: r.random.serialNumber || null,
    };
    return data;
  } catch (e) {
    console.log('[ROLL] підписана перестановка не вийшла (' + (e && e.message) + ')');
    return null;
  } finally { clearTimeout(t); }
}
// Те саме без ключа: відкритий сервіс послідовностей random.org
async function randomOrgPerm(n) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), RANDOM_ORG_TIMEOUT);
  try {
    const res = await fetch('https://www.random.org/sequences/?min=1&max=' + n +
                            '&col=1&format=plain&rnd=new', { signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const out = (await res.text()).trim().split(/\s+/).map(Number);
    if (out.length !== n || out.some(v => !Number.isInteger(v) || v < 1 || v > n)) throw new Error('bad payload');
    return out;
  } catch (e) {
    console.log('[ROLL] перестановка з random.org не вийшла (' + (e && e.message) + ') → crypto');
    return null;
  } finally { clearTimeout(t); }
}
/* Вибір k учасників зі списку n: у random.org просимо рівно k чисел без
   повторів у діапазоні 1..n. На сторінці перевірки видно саме тих, кого
   набрали («5, 20, 128…» = учасники з такими номерами), а не перестановку
   всього списку — коротко і зрозуміло. */
async function truePick(total, k, what, ctx = {}) {
  ctx.proof = null;
  if (k >= total) return trueShuffle(Array.from({ length: total }, (_, i) => i), what, ctx).then(a => a.slice(0, k));
  const signed = await randomOrgSignedPerm(k, what, total, ctx);
  if (signed) { ctx.source = 'random.org'; return signed.map(v => v - 1); }
  const perm = await randomOrgPerm(total);
  if (perm) { ctx.source = 'random.org'; return perm.slice(0, k).map(v => v - 1); }
  ctx.source = 'crypto';
  const a = Array.from({ length: total }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// Перемішування: перестановка з random.org, інакше Фішер-Йейтс на crypto
async function trueShuffle(arr, what, ctx = {}) {
  ctx.proof = null;
  const a = [...arr];
  if (a.length < 2) { ctx.source = 'crypto'; return a; }
  const perm = (await randomOrgSignedPerm(a.length, what, undefined, ctx)) || (await randomOrgPerm(a.length));
  if (perm) {
    ctx.source = 'random.org';
    // perm[k] = який учасник (1-базовано) стає на k-ту клітинку
    return perm.map(v => a[v - 1]);
  }
  ctx.source = 'crypto';
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
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

async function buildRaffleGame(T, n) {
  // Cash Hunt: розкладку по клітинках робить random.org (атмосферний шум) —
  // саме вона визначає, кому яка клітинка дістанеться
  const ctx = { chatroom: T.chatroomId };
  const shuffled = await trueShuffle(T.players,
    'Cash Hunt: раскладка ' + T.players.length + ' участников по ячейкам табло', ctx);
  const gridSize = shuffled.length;
  const cells = shuffled.slice(0, gridSize);

  return {
    winnersNeeded: n,
    gridSize,
    cells,
    rollSource: ctx.source,   // 'random.org' або 'crypto' — показуємо глядачам
    rollProof: ctx.proof,     // посилання на офіційну сторінку перевірки
  };
}


server.listen(process.env.PORT || 3000, () => {
  console.log(`[WEB] Сервер запущен на порту ${process.env.PORT || 3000}`);
});

// ── Kick realtime (Centrifugo) ──────────────────────────────
async function connect(T) {
  T.kick.state = 'connecting';
  let token;
  try {
    token = await fetchRealtimeToken();
  } catch (e) {
    T.kick.lastError = 'токен: ' + e.message;
    console.error('[WS] Не вдалось отримати токен Kick: ' + e.message + ' — повтор через 10с');
    setTimeout(() => connect(T), 10000);
    return;
  }
  const ws = new WebSocket(KICK_WS_URL, { headers: { Origin: 'https://kick.com' } });
  let aliveTimer = null, subTimer = null;
  // будь-який байт = звʼязок живий; тиша довше 90с означає напівмертвий сокет
  // (на хмарному хостингу так буває після простою): сокет «відкритий», а чату вже нема
  const bump = () => {
    if (aliveTimer) clearTimeout(aliveTimer);
    aliveTimer = setTimeout(() => {
      console.log('[WS] 90с тиші від Kick — перепідключаюсь');
      T.kick.lastError = 'тиша 90с, перепідключення';
      try { ws.terminate(); } catch { try { ws.close(); } catch {} }
    }, 90000);
  };

  ws.on('open', () => {
    T.kick.state = 'open'; T.kick.lastError = '';
    console.log('[WS] Подключено к Kick realtime');
    ws.send(JSON.stringify({ connect: { token, name: 'js' }, id: 1 }));
    ws.send(JSON.stringify({ subscribe: { channel: `chatrooms.${T.chatroomId}.v2`, flag: 1 }, id: 2 }));
    bump();
    // підписка не підтвердилась за 15с — сокет є, а чату не буде: пробуємо заново
    subTimer = setTimeout(() => {
      if (T.kick.subscribed) return;
      console.log('[WS] Підписка на chatroom ' + T.chatroomId + ' не підтвердилась за 15с — перепідключаюсь');
      T.kick.lastError = 'підписка не підтвердилась';
      try { ws.terminate(); } catch { try { ws.close(); } catch {} }
    }, 15000);
  });

  ws.on('message', (raw) => {
    bump();
    // Centrifugo шле кілька кадрів в одному повідомленні, розділених \n
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      // порожній кадр — пінг сервера, відповідаємо тим самим
      if (Object.keys(msg).length === 0) { ws.send('{}'); continue; }

      if (msg.id === 1) {
        if (msg.error) {
          T.kick.lastError = 'connect: ' + JSON.stringify(msg.error).slice(0, 120);
          console.error('[WS] Kick відмовив у підключенні: ' + T.kick.lastError);
          try { ws.terminate(); } catch {}
        }
        continue;
      }
      if (msg.id === 2) {
        if (msg.error) {
          T.kick.lastError = 'subscribe: ' + JSON.stringify(msg.error).slice(0, 120);
          console.error('[WS] Не вдалось підписатись на chatroom ' + T.chatroomId + ': ' + T.kick.lastError);
          try { ws.terminate(); } catch {}
          continue;
        }
        T.kick.state = 'subscribed'; T.kick.subscribed = true;
        console.log(`[WS] Подписка на chatroom ${T.chatroomId} активна`);
        console.log('[BOT] Бот работает! Жду команды в чате...\n');
        continue;
      }

      const pub = msg.push && msg.push.pub && msg.push.pub.data;
      if (!pub || pub.event !== 'App\\Events\\ChatMessageEvent') continue;
      let data;
      try { data = JSON.parse(pub.data); } catch { continue; }

    const username = data?.sender?.username;
    const content  = data?.content?.trim();
    const color = data?.sender?.identity?.color || '#53fc18';
    const badges = data?.sender?.identity?.badges || [];
    
      if (!username || !content) continue;
    T.kick.msgs++; T.kick.lastMsgAt = Date.now();

    // Відправляємо повідомлення у кастомний чат на фронтенді
    const chatMsg = JSON.stringify({ username, content, color, badges });
    T.chatClients.forEach(c => c.write(`data: ${chatMsg}\n\n`));

    // Привʼязка гравця перестрілки: у повідомленні є 4-значний код зі
    // сторінки гравця → реле привʼязує його сокет до цього ніка
    try { playRelay.chatCode(username, content); } catch (e) { /* реле не валить чат */ }

    const lower = content.toLowerCase();

    // Шукаємо переможця case-insensitive
    const checkKey = Object.keys(T.checks).find(
      k => k.toLowerCase() === username.toLowerCase()
    );
    console.log(`[CHAT ${T.id}] ${username}: "${content}" | keys: ${JSON.stringify(Object.keys(T.checks))} | found key: ${checkKey} | active: ${T.checks[checkKey]?.active}`);

    if (checkKey && T.checks[checkKey].active) {
      T.checks[checkKey].active = false;
      T.checks[checkKey].message = content;
      T.checks[checkKey].messageAt = Date.now();
      console.log(`[РОЗІГРАШ✓] ${username} ответил: ${content}`);
      // Push до клієнта — не чекаємо наступного poll
      const pushMsg = JSON.stringify({ type: 'winner_reply', name: checkKey, message: content });
      T.chatClients.forEach(c => c.write(`data: ${pushMsg}\n\n`));
    }

    // слово збігається з точністю до знаку «!»: стрімер пише в панель «призи»,
    // а глядачі в чаті — «!призи» (і навпаки), і реєстрація мовчки не працювала
    // слово не задане — бере участь будь-яке повідомлення (крім самого стрімера і чат-ботів)
    const unameL = username.toLowerCase();
    const cmdMatch = !T.joinCmd ? (unameL !== T.channel && !CHAT_BOTS.has(unameL)) : (lower === T.joinCmd
      || lower === '!' + T.joinCmd
      || (T.joinCmd[0] === '!' && lower === T.joinCmd.slice(1)));
    if (T.accepting && cmdMatch) {
      if (!T.players.includes(username)) {
      T.players.push(username);
      avatarWant(username);
      saveState(T);
      console.log(`[РОЗІГРАШ + ${T.id}] ${username} (${T.players.length})`);
      }
        continue;
      }
    }
  });

  ws.on('error', (err) => { T.kick.lastError = err.message; console.error('[WS] Ошибка:', err.message); });

  ws.on('close', (code, reason) => {
    if (aliveTimer) clearTimeout(aliveTimer);
    if (subTimer) clearTimeout(subTimer);
    T.kick.state = 'closed'; T.kick.subscribed = false; T.kick.reconnects++;
    const why = code ? (' код ' + code + (reason ? ' ' + String(reason).slice(0, 120) : '')) : '';
    console.log('[WS] Соединение закрыто' + why + ', переподключение через 5с...');
    setTimeout(() => connect(T), 5000);
  });
}

// ── Старт ───────────────────────────────────────────────────
// Нік каналу → id чату. Без цього id був зашитий у код, і бот міг слухати
// чужий чат: панель працює, чат порожній, реєстрація «не бачить» нікого
async function resolveChatroom(T) {
  if (!T.channel) return;
  try {
    const r = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(T.channel), {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const id = j && j.chatroom && j.chatroom.id;
    if (!id) throw new Error('у відповіді немає chatroom.id');
    if (id !== T.chatroomId) console.log(`[KICK] chatroom каналу ${T.channel}: ${id} (було ${T.chatroomId})`);
    T.chatroomId = id;
  } catch (e) {
    // Kick часто ріже запити з хмарних IP — тоді лишаємось на KICK_CHATROOM/дефолті
    T.kick.lastError = 'не вдалось знайти chatroom для ' + T.channel + ': ' + e.message;
    console.error('[KICK] ' + T.kick.lastError + ' — слухаю chatroom ' + T.chatroomId);
  }
}

console.log('╔══════════════════════════════════════════════════╗');
console.log('║   KICKPLAY — бот розіграшів для Kick              ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log('  Стримеров:             ' + TENANTS.length + (process.env.STREAMERS ? ' (STREAMERS)' : ' (KICK_CHANNEL / WEB_PASSWORD)'));
for (const T of TENANTS) {
  console.log('  • ' + (T.channel || '— канал не задан') + ' — chatroom ' + T.chatroomId + ', бот пишет в чат: ' + (T.botToken ? 'да' : 'нет'));
}
console.log('  Realtime:              ' + KICK_WS_URL.replace('wss://', '').split('/')[0]);
console.log('  Антисон (keepalive):   ' + (KEEPALIVE_ON ? KEEPALIVE_URL + '/healthz кожні ' + KEEPALIVE_MIN + ' хв' : 'вимкнено — на безкоштовному Render бот засне за 15 хв без відкритої панелі'));
console.log('  Далі чекай рядок «Подписка на chatroom ... активна» і [CHAT] на кожне повідомлення.');
console.log('  Якщо [CHAT] нема, а в чаті пишуть — це не той chatroom: перевір канал у STREAMERS / KICK_CHANNEL.\n');

for (const T of TENANTS) {
  loadState(T);
  resolveChatroom(T).then(() => connect(T));
}

// сам себе будить: інакше після 15 хв сну в чаті можна писати слово скільки завгодно —
// бот його не побачить, бо процес зупинено
if (KEEPALIVE_ON) {
  setInterval(() => {
    fetch(KEEPALIVE_URL + '/healthz', { headers: { 'User-Agent': 'KICKplay-keepalive' } })
      .then(r => { if (!r.ok) console.log('[KEEPALIVE] ' + KEEPALIVE_URL + ' відповів ' + r.status); })
      .catch(e => console.log('[KEEPALIVE] не достукався: ' + e.message));
  }, KEEPALIVE_MIN * 60000);
}

// Раз на хвилину нагадуємо в логи, якщо чат мовчить при відкритій реєстрації:
// саме так виглядає «бот не реєструє» — підписка є, а повідомлень нема
setInterval(() => {
  for (const T of TENANTS) {
    if (!T.accepting) continue;
    const quiet = T.kick.lastMsgAt ? Math.round((Date.now() - T.kick.lastMsgAt) / 1000) : null;
    if (!T.kick.subscribed) console.log(`[ДІАГ ${T.id}] Немає підписки на чат Kick (стан: ` + T.kick.state + ', помилка: ' + (T.kick.lastError || 'нема') + ')');
    else if (quiet === null) console.log(`[ДІАГ ${T.id}] Підписка на chatroom ` + T.chatroomId + ' є, але жодного повідомлення ще не прийшло — перевір, чи це твій чат');
    else if (quiet > 300) console.log(`[ДІАГ ${T.id}] Останнє повідомлення чату ` + quiet + 'с тому (chatroom ' + T.chatroomId + ')');
  }
}, 60000);
