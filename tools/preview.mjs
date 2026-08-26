/* ══════════════════════════════════════════════════════════════
   Дизайн-харнес: віддає public/ на http://localhost:4321 БЕЗ пароля
   і БЕЗ підключення до Kick, з підставними учасниками й чатом.

       npm run preview

   Навіщо: щоб крутити мініігри й правити верстку, не піднімаючи бота,
   не логінячись і не чіпаючи живий розіграш. Правиш CSS → F5.
   У прод це не їде — Render запускає лише bot.js.
   ══════════════════════════════════════════════════════════════ */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = parseInt(process.env.PORT) || 4321;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.woff2':'font/woff2',
  '.mp3':  'audio/mpeg',
};

// Реальні ніки з експорту стріму (tools/mock-participants.csv);
// якщо файла немає — вбудований запасний список.
const FALLBACK_PLAYERS = [
  'GlebusMaximus','katya_777','ЛютийДраник','xX_Sniper_Xx','мамкин_вояка','PixelPusher',
  'Оксана','n1ghtmare','КотЛеопольд','tvoy_batya','Даринка','ZeroCool','Мурчик','SaltyPeanut',
  'Владислав_К','shrekoslav','Ліна','BigChungus','fedya_gg','Тарас','Sanya_Kyiv','moonlight',
  'Гриць','protonchik','wasd_wasd','Юля','TrashPanda','deadinside','Богдан','qwerty123',
];
let MOCK_PLAYERS = FALLBACK_PLAYERS;
try {
  const csv = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-participants.csv');
  const names = fs.readFileSync(csv, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (names.length) MOCK_PLAYERS = names;
} catch { /* файла немає — лишаємось на запасному списку */ }

let lastWinnersN = 1;   // скільки переможців було на минулому старті (для рерола без body)
const mockChecks = {};  // таймери підтвердження переможців — як raffleChecks у bot.js

/* кольори — як шле реальний Kick (sender.identity.color): у кожного свій */
const MOCK_CHAT = [
  ['katya_777',    '!призи мене мене мене', '#e9709b'],
  ['ЛютийДраник',  'го вже крути',          '#f86754'],
  ['ZeroCool',     '!призи',                '#1e9df2'],
  ['Оксана',       'удачі всім 💛',         '#ff9d00'],
  ['BigChungus',   'LETS GOOO',             '#75fd46'],
  ['Мурчик',       '!призи',                '#ffd93d'],
  ['tvoy_batya',   'я виграю 100%',         '#e05ecb'],
  ['Ліна',         'o_O',                   '#31ec9f'],
  ['deadinside',   '!призи',                '#a970ff'],
  ['Гриць',        'ну шо там',             '#53fc18'],
];

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // Живий чат (SSE) — щоб бачити, як виглядає панель чату під навантаженням
  if (url === '/api/chat/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const timer = setInterval(() => {
      const [username, content, color] = MOCK_CHAT[Math.floor(Math.random() * MOCK_CHAT.length)];
      res.write('data: ' + JSON.stringify({ username, content, color, badges: [] }) + '\n\n');
    }, 1500);
    req.on('close', () => clearInterval(timer));
    return;
  }

  if (url.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (url === '/api/raffle/state') {
      return res.end(JSON.stringify({
        joinCmd: '!призи', accepting: true,
        participants: MOCK_PLAYERS, count: MOCK_PLAYERS.length,
        game: null, winners: [], chatgameWinners: [],
      }));
    }
    if (url === '/api/raffle/check/state') return res.end(JSON.stringify({ checks: {} }));

    // Чек-таймер переможця — поведінка bot.js, з навмисною затримкою 300мс,
    // щоб ловити гонку «poll обігнав check/start» (баг зеленої версії)
    if (url === '/api/raffle/check/start') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        setTimeout(() => {
          try {
            const { winner, seconds } = JSON.parse(body);
            mockChecks[winner] = { seconds: Math.max(5, parseInt(seconds) || 60), startedAt: Date.now(), active: true, message: null };
          } catch { /* ігноруємо битий body */ }
          res.end('{"ok":true}');
        }, 300);
      });
      return;
    }
    if (url === '/api/raffle/check/state') {
      return res.end(JSON.stringify({ checks: mockChecks }));
    }

    // Кнопка СТАРТ у режимі Cash Hunt — віддаємо гру, як робить bot.js;
    // кількість переможців приходить у body ({winners: n}); рерол іде БЕЗ body —
    // як і bot.js, повторюємо число з попереднього старту (раніше мок тут
    // підставляв 2 і рерол вимагав вибрати дві клітинки)
    if (url === '/api/raffle/start' || url === '/api/raffle/reroll' || url === '/api/raffle/fastreroll') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let n = lastWinnersN;
        try { n = Math.max(1, parseInt(JSON.parse(body).winners) || n); } catch { /* без body — як минулого разу */ }
        lastWinnersN = n;
        const shuffled = [...MOCK_PLAYERS].sort(() => Math.random() - 0.5);
        if (url === '/api/raffle/fastreroll') {
          res.end(JSON.stringify({ ok: true, winners: shuffled.slice(0, n) }));
        } else {
          res.end(JSON.stringify({
            ok: true,
            game: { winnersNeeded: n, gridSize: shuffled.length, cells: shuffled },
          }));
        }
      });
      return;
    }
    return res.end('{"ok":true}');
  }

  const rel  = url === '/' ? 'index.html' : url.replace(/^\/assets\//, '/');
  const file = path.resolve(ROOT, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('403'); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('');
  console.log('  Дизайн-харнес:  http://localhost:' + PORT);
  console.log('  ' + MOCK_PLAYERS.length + ' підставних учасників, чат сиплеться сам, пароля немає.');
  console.log('');
});
