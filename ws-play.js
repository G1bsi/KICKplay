/* ══════════════════════════════════════════════════════════════
   ws-play.js — реле /ws/play: хост (панель стрімера) ↔ гравці.
   Спільний модуль для bot.js (прод) і tools/preview.mjs (мок),
   щоб протокол не розходився між середовищами.

   Ролі:
     host   — панель стрімера; в проді автентифікується сесійною кукою
              (isHostReq), у моці приймається без неї.
     player — публічний; привʼязується до ніка через код у чаті Kick
              (chatCode) або миттєво за збереженим token-ом.

   Сервер НЕ рахує бій — лише ретранслює: input гравців → хосту,
   state/map/roster хоста → усім привʼязаним гравцям.
   ══════════════════════════════════════════════════════════════ */
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

const CODE_TTL_MS  = 10 * 60 * 1000;   // код привʼязки живе 10 хвилин
const INPUT_MIN_MS = 33;               // ≤30 input-пакетів/с на гравця

export function createPlayRelay({ server, isHostReq }) {
  const wss = new WebSocketServer({ noServer: true });
  const pendingCodes = new Map();   // code → {ws, at} — чекають повідомлення в чаті
  const tokens       = new Map();   // token → nick — реконект без повторного коду
  const bound        = new Map();   // nickLower → {ws, nick, token}
  const hosts        = new Set();
  let lastMap = null, lastRoster = null;   // кеш статики: новий гравець отримує її одразу

  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== '/ws/play') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  function send(ws, obj) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch { /* сокет умер між перевіркою і send */ } }
  }
  function toHosts(obj) { for (const h of hosts) send(h, obj); }
  function toPlayers(obj) {
    const raw = JSON.stringify(obj);   // один stringify на всіх — state летить 13 разів/с
    for (const b of bound.values())
      if (b.ws && b.ws.readyState === 1) { try { b.ws.send(raw); } catch { /* ок */ } }
  }

  function newCode() {
    // 4 цифри; колізію перебираємо, бо одночасних очікувань — одиниці
    for (let i = 0; i < 100; i++) {
      const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      if (!pendingCodes.has(c)) return c;
    }
    return null;
  }

  function bindPlayer(ws, nick, token) {
    const key = String(nick).toLowerCase();
    const old = bound.get(key);
    if (old && old.ws && old.ws !== ws) {
      // повторна привʼязка ніка з нового сокета розриває стару
      old.ws._nickKey = null;   // щоб close старого сокета не зняв НОВУ привʼязку
      try { old.ws.close(4001, 'rebound'); } catch { /* ок */ }
    }
    bound.set(key, { ws, nick: String(nick), token });
    ws._role = 'player'; ws._nickKey = key;
    if (ws._code) { pendingCodes.delete(ws._code); ws._code = null; }
    send(ws, { t: 'bound', nick: String(nick), token });
    // новачок одразу отримує поточний стан лобі/бою
    if (lastRoster) send(ws, lastRoster);
    if (lastMap && lastRoster && lastRoster.fighting) send(ws, lastMap);
    toHosts({ t: 'joined', nick: String(nick) });
  }

  /* Повідомлення з чату Kick від ніка nick: містить 4-значний код із
     pendingCodes → привʼязуємо той сокет до nick. Захист від самозванства:
     написати код може лише власник акаунта. У превʼю це ж викликає
     POST /api/mock/bind. Повертає true, якщо бінд відбувся. */
  function chatCode(nick, content) {
    if (!nick || !pendingCodes.size) return false;
    const codes = String(content || '').match(/\d{4}/g);
    if (!codes) return false;
    for (const c of codes) {
      const pend = pendingCodes.get(c);
      if (!pend) continue;
      pendingCodes.delete(c);
      if (!pend.ws || pend.ws.readyState !== 1) continue;   // вкладка вже закрита
      const token = crypto.randomBytes(16).toString('hex');
      tokens.set(token, String(nick));
      bindPlayer(pend.ws, nick, token);
      return true;
    }
    return false;
  }

  wss.on('connection', (ws, req) => {
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    ws.on('error', () => { /* обрив мережі — close прибере */ });

    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string') return;

      if (m.t === 'hello') {
        if (m.role === 'host') {
          // хост — лише з валідною сесією стрімера (у моці isHostReq завжди true)
          if (!isHostReq(req)) { try { ws.close(4003, 'unauthorized'); } catch { /* ок */ } return; }
          ws._role = 'host';
          hosts.add(ws);
          return;
        }
        ws._role = 'player';
        if (typeof m.token === 'string' && tokens.has(m.token)) {
          bindPlayer(ws, tokens.get(m.token), m.token);   // реконект без коду
          return;
        }
        const code = newCode();
        if (!code) { try { ws.close(1013, 'busy'); } catch { /* ок */ } return; }
        pendingCodes.set(code, { ws, at: Date.now() });
        ws._code = code;
        send(ws, { t: 'code', code });
        return;
      }

      if (ws._role === 'host') {
        // кешуємо статику — привʼязаний пізніше гравець отримає її при бінді
        if (m.t === 'map')    { lastMap = m;    toPlayers(m); return; }
        if (m.t === 'roster') { lastRoster = m; toPlayers(m); return; }
        if (m.t === 'state')  { toPlayers(m); return; }
        return;
      }

      if (ws._role === 'player' && m.t === 'input' && ws._nickKey) {
        const now = Date.now();
        if (now - (ws._lastInputAt || 0) < INPUT_MIN_MS) return;   // тротл на гравця
        ws._lastInputAt = now;
        const rec = bound.get(ws._nickKey);
        if (!rec || rec.ws !== ws) return;
        // числа клампимо ТУТ: хост-браузеру має прилітати вже безпечне
        const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
        const c1  = v => Math.max(-1, Math.min(1, num(v)));
        toHosts({ t: 'input', nick: rec.nick, mx: c1(m.mx), my: c1(m.my), aim: num(m.aim), fire: !!m.fire });
      }
    });

    ws.on('close', () => {
      if (ws._code) pendingCodes.delete(ws._code);
      if (ws._role === 'host') {
        hosts.delete(ws);
        if (!hosts.size) {
          // хост зник — гравцям нема кого керувати, кажемо «бій не йде»
          lastRoster = { t: 'roster', fighting: false, finalists: [] };
          lastMap = null;
          toPlayers(lastRoster);
        }
      } else if (ws._nickKey) {
        const rec = bound.get(ws._nickKey);
        if (rec && rec.ws === ws) {
          bound.delete(ws._nickKey);
          toHosts({ t: 'left', nick: rec.nick });   // хост поверне бійця AI
        }
      }
    });
  });

  // чистка: протухлі коди + мертві сокети (ping/pong кожні 30с)
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [c, p] of pendingCodes)
      if (now - p.at > CODE_TTL_MS || !p.ws || p.ws.readyState > 1) pendingCodes.delete(c);
    for (const ws of wss.clients) {
      if (!ws._alive) { try { ws.terminate(); } catch { /* ок */ } continue; }
      ws._alive = false;
      try { ws.ping(); } catch { /* ок */ }
    }
  }, 30000);
  if (sweep.unref) sweep.unref();   // не тримає процес живим

  return { chatCode };
}
