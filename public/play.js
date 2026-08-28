/* ══════════════════════════════════════════════════════════════
   play.js — публічна сторінка гравця (мультиплеєр перестрілки).
   Бій рахує панель стрімера; сюди по WS прилітає state ~13 разів/с,
   назад летить input. Тут лише рендер з інтерполяцією і керування.
   ══════════════════════════════════════════════════════════════ */
(function () {
'use strict';

/* ── Константи світу — ДЗЕРКАЛО shootout.js (палітра по idx та радіус
   бійця мають збігатися з тим, що бачить глядач на стрімі) ── */
const COLORS = ['#ff453a', '#4a9bff', '#ffd93d', '#a0ff4a', '#c77dff', '#ff8a4a', '#00ffcc', '#ff4aa8'];
const PR = 16;                 // радіус бійця
const BULLET_SPEED = 900;      // для екстраполяції куль між пакетами
const VIEW_UNITS = 650;        // ширина вьюпорта у світових юнітах (довша сторона екрана)
const LERP_DELAY = 150;        // рендеримо минуле на ~2 пакети — лерп завжди має пару
const TOKEN_KEY = 'kp_play_token';

/* ── DOM ── */
const $ = function (id) { return document.getElementById(id); };
const scrCode = $('scr-code'), scrLobby = $('scr-lobby'), scrGame = $('scr-game');
const elCode = $('p-code'), elNick = $('p-nick'), elLobbyStatus = $('p-lobby-status');
const elRejoin = $('p-rejoin'), elReconnect = $('p-reconnect');
const elHud = $('p-hud'), elHpFill = $('p-hpfill'), elHpText = $('p-hptext');
const elSpec = $('p-spec'), elTouch = $('p-touch'), elStick = $('p-stick'), elKnob = $('p-knob');
const cv = $('p-cv');
const ctx = cv.getContext('2d');

/* ── Стан клієнта ── */
let ws = null, retry = 0, reTimer = 0, stolen = false;
let nick = '', myIdx = -1;
let fighting = false, finalists = [];
let map = null;                          // {w,h,obs}
let states = [];                         // буфер state-пакетів: {at, s} для лерпу
let raf = 0;
let cw = 0, ch = 0, dpr = 1;

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

/* Один з трьох екранів: 'code' | 'lobby' | 'game' */
function screen(name) {
  (name === 'code' ? show : hide)(scrCode);
  (name === 'lobby' ? show : hide)(scrLobby);
  (name === 'game' ? show : hide)(scrGame);
  if (name === 'game') { resize(); if (!raf) raf = requestAnimationFrame(frame); }
  else { if (raf) { cancelAnimationFrame(raf); raf = 0; } inp.fire = false; inp.mx = 0; inp.my = 0; }
}

/* Гравець «у бою», якщо його нік серед фіналістів поточного бою */
function refreshScreen() {
  if (!nick) { screen('code'); return; }
  if (!fighting) {
    elLobbyStatus.innerHTML = '<span class="p-spin"></span> чекаємо на фінал…';
    screen('lobby');
    return;
  }
  myIdx = -1;
  const k = nick.toLowerCase();
  for (let i = 0; i < finalists.length; i++)
    if (String(finalists[i]).toLowerCase() === k) { myIdx = i; break; }
  screen('game');
}

/* ── WebSocket ── */
function wsUrl() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/play';
}
function sendObj(o) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) { /* сокет обірвався */ } }
}
function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { ws = new WebSocket(wsUrl()); } catch (e) { ws = null; schedule(); return; }
  ws.onopen = function () {
    retry = 0;
    hide(elReconnect);
    let token = null;
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* приватний режим */ }
    sendObj(token ? { t: 'hello', role: 'player', token: token } : { t: 'hello', role: 'player' });
  };
  ws.onmessage = function (ev) {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m) return;
    if (m.t === 'code') {
      /* токен протух (рестарт сервера) — привʼязуємось наново через чат */
      nick = ''; fighting = false; states.length = 0;
      elCode.textContent = m.code;
      screen('code');
    } else if (m.t === 'bound') {
      nick = m.nick;
      try { localStorage.setItem(TOKEN_KEY, m.token); } catch (e) { /* ок, буде код */ }
      elNick.textContent = nick;
      hide(elRejoin);
      refreshScreen();
    } else if (m.t === 'roster') {
      fighting = !!m.fighting;
      finalists = Array.isArray(m.finalists) ? m.finalists : [];
      if (!fighting) { map = null; states.length = 0; }
      if (nick) refreshScreen();
    } else if (m.t === 'map') {
      map = m;
    } else if (m.t === 'state') {
      states.push({ at: performance.now(), s: m });
      if (states.length > 12) states.shift();
    }
  };
  ws.onclose = function (ev) {
    ws = null;
    if (ev && ev.code === 4001) {
      /* нік привʼязали з іншого пристрою — не воюємо за сокет автоматично,
         інакше дві вкладки перетягують привʼязку нескінченно */
      stolen = true;
      elLobbyStatus.textContent = 'Відкрито на іншому пристрої';
      show(elRejoin);
      screen(nick ? 'lobby' : 'code');
      return;
    }
    show(elReconnect);
    schedule();
  };
  ws.onerror = function () { try { if (ws) ws.close(); } catch (e) { /* ок */ } };
}
function schedule() {
  if (reTimer || stolen) return;
  const wait = Math.min(8000, 500 * Math.pow(2, retry++));
  reTimer = setTimeout(function () { reTimer = 0; connect(); }, wait);
}
elRejoin.addEventListener('click', function () {
  stolen = false; retry = 0;
  hide(elRejoin);
  connect();
});

/* ── Інтерполяція: пара пакетів навколо (now - LERP_DELAY) ── */
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAng(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
/* Повертає {a, b, t} — кадри до/після часу рендера; або null, якщо пакетів нема */
function framePair() {
  if (!states.length) return null;
  const rt = performance.now() - LERP_DELAY;
  let a = states[0], b = states[states.length - 1];
  for (let i = states.length - 1; i >= 0; i--) {
    if (states[i].at <= rt) { a = states[i]; b = states[i + 1] || states[i]; break; }
  }
  const span = b.at - a.at;
  const t = span > 0 ? Math.max(0, Math.min(1, (rt - a.at) / span)) : 1;
  return { a: a.s, b: b.s, t: t, bAt: b.at };
}

/* ── Рендер ── */
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = scrGame.clientWidth; ch = scrGame.clientHeight;
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
}
window.addEventListener('resize', function () { if (!scrGame.classList.contains('hidden')) resize(); });

/* тінти перешкод: прості форми, але типи розрізняються з першого погляду */
const OB_FILL = { wall: '#3a3a3e', barrier: '#45453b', sandbag: '#5a5138', crate: '#6b5327', barrel: '#8a4a2a', bush: '#2f4a2b', tree: '#4a3b2a' };
const OB_LINE = { wall: '#55555b', barrier: '#61614f', sandbag: '#7a6f4d', crate: '#8f7136', barrel: '#b06438', bush: '#41663a', tree: '#655139' };

function frame() {
  raf = requestAnimationFrame(frame);
  const pair = framePair();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, cw, ch);
  if (!map || !pair) return;   // статика ще в дорозі — чорний кадр, не сміття

  const A = pair.a, B = pair.b, t = pair.t;

  /* свій боєць у пакеті (масив p упорядкований за idx, але шукаємо чесно) */
  let meA = null, meB = null;
  if (myIdx >= 0) {
    for (let i = 0; i < A.p.length; i++) if (A.p[i][0] === myIdx) { meA = A.p[i]; break; }
    for (let i = 0; i < B.p.length; i++) if (B.p[i][0] === myIdx) { meB = B.p[i]; break; }
  }
  const alive = !!(meB && meB[5]);
  const spectate = !alive;   // не фіналіст або вбитий — режим спостерігача

  /* камера: свій у центрі (вьюпорт ~VIEW_UNITS по довшій стороні);
     спостерігач бачить усю арену */
  let scale, camX, camY;
  if (spectate) {
    scale = Math.min(cw / (map.w + 80), ch / (map.h + 80));
    camX = map.w / 2; camY = map.h / 2;
  } else {
    scale = Math.max(cw, ch) / VIEW_UNITS;
    camX = lerp(meA ? meA[1] : meB[1], meB[1], t);
    camY = lerp(meA ? meA[2] : meB[2], meB[2], t);
  }
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(scale, scale);
  ctx.translate(-camX, -camY);

  /* арена: двотонове тло + рамка */
  ctx.fillStyle = '#161612';
  ctx.fillRect(0, 0, map.w, map.h);
  ctx.strokeStyle = '#38383b';
  ctx.lineWidth = 3 / scale;
  ctx.strokeRect(0, 0, map.w, map.h);
  /* легка сітка, щоб рух камери читався */
  ctx.strokeStyle = 'rgba(255,255,255,.03)';
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  for (let x = 0; x <= map.w; x += 200) { ctx.moveTo(x, 0); ctx.lineTo(x, map.h); }
  for (let y = 0; y <= map.h; y += 200) { ctx.moveTo(0, y); ctx.lineTo(map.w, y); }
  ctx.stroke();

  /* перешкоди: circle [t,x,y,r], rect [t,x,y,hw,hh] */
  ctx.lineWidth = 2 / scale;
  for (let i = 0; i < map.obs.length; i++) {
    const o = map.obs[i];
    ctx.fillStyle = OB_FILL[o[0]] || '#3a3a3e';
    ctx.strokeStyle = OB_LINE[o[0]] || '#55555b';
    if (o.length === 4) {
      ctx.beginPath();
      ctx.arc(o[1], o[2], o[3], 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      if (o[0] === 'tree') {   // крона: дерево читається не як бочка
        ctx.fillStyle = 'rgba(47,74,43,.35)';
        ctx.beginPath();
        ctx.arc(o[1], o[2], o[3] * 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillRect(o[1] - o[3], o[2] - o[4], o[3] * 2, o[4] * 2);
      ctx.strokeRect(o[1] - o[3], o[2] - o[4], o[3] * 2, o[4] * 2);
    }
  }

  /* аптечки — білий квадратик з хрестом */
  for (let i = 0; i < B.k.length; i++) {
    const k = B.k[i];
    ctx.fillStyle = '#e8e8ec';
    ctx.fillRect(k[0] - 9, k[1] - 9, 18, 18);
    ctx.fillStyle = '#ff453a';
    ctx.fillRect(k[0] - 6, k[1] - 2, 12, 4);
    ctx.fillRect(k[0] - 2, k[1] - 6, 4, 12);
  }

  /* вогонь і дим — кола з альфою */
  for (let i = 0; i < B.f.length; i++) {
    const f = B.f[i];
    ctx.fillStyle = 'rgba(255,120,40,.30)';
    ctx.beginPath(); ctx.arc(f[0], f[1], f[2], 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,200,60,.18)';
    ctx.beginPath(); ctx.arc(f[0], f[1], f[2] * 0.6, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < B.s.length; i++) {
    const s = B.s[i];
    ctx.fillStyle = 'rgba(160,160,170,.35)';
    ctx.beginPath(); ctx.arc(s[0], s[1], s[2], 0, Math.PI * 2); ctx.fill();
  }

  /* кулі: рисочки, екстрапольовані від часу пакета (13Гц → без телепортів) */
  const dtB = (performance.now() - LERP_DELAY - pair.bAt) / 1000;
  ctx.strokeStyle = '#ffe873';
  ctx.lineWidth = 3 / scale;
  ctx.beginPath();
  for (let i = 0; i < B.b.length; i++) {
    const b = B.b[i];
    const bx = b[0] + Math.cos(b[2]) * BULLET_SPEED * dtB;
    const by = b[1] + Math.sin(b[2]) * BULLET_SPEED * dtB;
    ctx.moveTo(bx - Math.cos(b[2]) * 10, by - Math.sin(b[2]) * 10);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();

  /* бійці: пакет A по idx → лерп до B */
  const byIdxA = {};
  for (let i = 0; i < A.p.length; i++) byIdxA[A.p[i][0]] = A.p[i];
  for (let i = 0; i < B.p.length; i++) {
    const pb = B.p[i];
    const pa = byIdxA[pb[0]] || pb;
    const x = lerp(pa[1], pb[1], t), y = lerp(pa[2], pb[2], t);
    const aim = lerpAng(pa[3], pb[3], t);
    const idx = pb[0], hp = pb[4], isAlive = !!pb[5], mine = idx === myIdx;
    if (!isAlive) {
      /* труп — сірий хрестик, без ніка */
      ctx.strokeStyle = 'rgba(150,150,155,.5)';
      ctx.lineWidth = 3 / scale;
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 8); ctx.lineTo(x + 8, y + 8);
      ctx.moveTo(x + 8, y - 8); ctx.lineTo(x - 8, y + 8);
      ctx.stroke();
      continue;
    }
    /* тіло */
    ctx.fillStyle = COLORS[idx % COLORS.length];
    ctx.beginPath(); ctx.arc(x, y, PR, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = mine ? 4 : 1.5;
    ctx.strokeStyle = mine ? '#ffffff' : 'rgba(0,0,0,.45)';
    ctx.stroke();
    /* напрямок прицілу; у свого — виразна стрілка */
    ctx.strokeStyle = mine ? '#ffffff' : 'rgba(0,0,0,.55)';
    ctx.lineWidth = mine ? 4 : 3;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(aim) * PR * 0.4, y + Math.sin(aim) * PR * 0.4);
    ctx.lineTo(x + Math.cos(aim) * PR * (mine ? 1.9 : 1.4), y + Math.sin(aim) * PR * (mine ? 1.9 : 1.4));
    ctx.stroke();
    /* HP-смужка */
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(x - 18, y - PR - 14, 36, 5);
    ctx.fillStyle = hp > 35 ? '#a0ff4a' : '#ff453a';
    ctx.fillRect(x - 18, y - PR - 14, 36 * Math.max(0, hp) / 100, 5);
    /* нік */
    const fs = Math.max(11, 13 / scale);
    ctx.font = '700 ' + fs + 'px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = mine ? '#ffd93d' : '#f2f2f4';
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = 3;
    const label = String(finalists[idx] || '');
    ctx.strokeText(label, x, y - PR - 19);
    ctx.fillText(label, x, y - PR - 19);
  }

  /* зона: затемнення зовні (evenodd) + жовте кільце */
  const zA = A.z, zB = B.z;
  if (zB) {
    const zx = zA ? lerp(zA.x, zB.x, t) : zB.x;
    const zy = zA ? lerp(zA.y, zB.y, t) : zB.y;
    const zr = zA ? lerp(zA.r, zB.r, t) : zB.r;
    ctx.fillStyle = 'rgba(0,0,0,.42)';
    ctx.beginPath();
    ctx.rect(-4000, -4000, map.w + 8000, map.h + 8000);
    ctx.arc(zx, zy, zr, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,217,61,.85)';
    ctx.lineWidth = 3 / scale;
    ctx.beginPath(); ctx.arc(zx, zy, zr, 0, Math.PI * 2); ctx.stroke();
  }

  /* HUD поза світовими координатами */
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (spectate) { hide(elHud); show(elSpec); }
  else {
    show(elHud); hide(elSpec);
    const hp = Math.max(0, meB[4]);
    elHpFill.style.width = hp + '%';
    elHpFill.classList.toggle('low', hp <= 35);
    elHpText.textContent = String(hp);
  }
}

/* ── Керування ─────────────────────────────────────────────────
   Свій боєць завжди в центрі екрана, тому aim рахується від центра
   канваса до курсора/пальця — без переведення у світові координати. */
const inp = { mx: 0, my: 0, aim: 0, fire: false };
const keys = {};

function canControl() {
  if (!fighting || myIdx < 0) return false;
  const last = states.length ? states[states.length - 1].s : null;
  if (!last) return false;
  for (let i = 0; i < last.p.length; i++)
    if (last.p[i][0] === myIdx) return !!last.p[i][5];
  return false;
}
function keysToMove() {
  let mx = 0, my = 0;
  if (keys.KeyA || keys.ArrowLeft) mx -= 1;
  if (keys.KeyD || keys.ArrowRight) mx += 1;
  if (keys.KeyW || keys.ArrowUp) my -= 1;
  if (keys.KeyS || keys.ArrowDown) my += 1;
  const len = Math.hypot(mx, my);
  inp.mx = len ? mx / len : 0;
  inp.my = len ? my / len : 0;
}
window.addEventListener('keydown', function (e) {
  if (e.repeat) return;
  keys[e.code] = true; keysToMove();
});
window.addEventListener('keyup', function (e) { keys[e.code] = false; keysToMove(); });
window.addEventListener('blur', function () {
  for (const k in keys) keys[k] = false;
  keysToMove(); inp.fire = false;
});

elTouch.addEventListener('mousemove', function (e) {
  inp.aim = Math.atan2(e.clientY - ch / 2, e.clientX - cw / 2);
});
elTouch.addEventListener('mousedown', function (e) {
  if (e.button !== 0) return;
  inp.aim = Math.atan2(e.clientY - ch / 2, e.clientX - cw / 2);
  inp.fire = true;
});
window.addEventListener('mouseup', function () { inp.fire = false; });
elTouch.addEventListener('contextmenu', function (e) { e.preventDefault(); });

/* Тач: ліва половина — джойстик руху, права — приціл, тримаєш = стріляєш */
let moveId = null, aimId = null, stickOX = 0, stickOY = 0;
const STICK_R = 60;   // радіус повного відхилення = розмір бази джойстика

function touchAim(t) {
  inp.aim = Math.atan2(t.clientY - ch / 2, t.clientX - cw / 2);
}
elTouch.addEventListener('touchstart', function (e) {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    if (t.clientX < cw / 2 && moveId === null) {
      moveId = t.identifier;
      stickOX = t.clientX; stickOY = t.clientY;
      elStick.style.left = stickOX + 'px';
      elStick.style.top = stickOY + 'px';
      elKnob.style.transform = 'translate(0,0)';
      show(elStick);
    } else if (aimId === null) {
      aimId = t.identifier;
      touchAim(t);
      inp.fire = true;
    }
  }
}, { passive: false });
elTouch.addEventListener('touchmove', function (e) {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    if (t.identifier === moveId) {
      let dx = t.clientX - stickOX, dy = t.clientY - stickOY;
      const len = Math.hypot(dx, dy);
      if (len > STICK_R) { dx = dx / len * STICK_R; dy = dy / len * STICK_R; }
      inp.mx = dx / STICK_R; inp.my = dy / STICK_R;
      elKnob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    } else if (t.identifier === aimId) {
      touchAim(t);
    }
  }
}, { passive: false });
function touchEnd(e) {
  e.preventDefault();
  for (let i = 0; i < e.changedTouches.length; i++) {
    const id = e.changedTouches[i].identifier;
    if (id === moveId) {
      moveId = null;
      inp.mx = 0; inp.my = 0;
      hide(elStick);
    } else if (id === aimId) {
      aimId = null;
      inp.fire = false;
    }
  }
}
elTouch.addEventListener('touchend', touchEnd, { passive: false });
elTouch.addEventListener('touchcancel', touchEnd, { passive: false });

/* Надсилання input: 20/с, і лише при зміні; кіпалайв кожні 400мс,
   щоб хост не скинув human-керування по таймауту пакета (1.2с) */
let lastSent = '', lastSentAt = 0;
setInterval(function () {
  if (!canControl()) return;
  const msg = {
    t: 'input',
    mx: Math.round(inp.mx * 100) / 100,
    my: Math.round(inp.my * 100) / 100,
    aim: Math.round(inp.aim * 100) / 100,
    fire: inp.fire,
  };
  const key = msg.mx + '|' + msg.my + '|' + msg.aim + '|' + msg.fire;
  const now = performance.now();
  if (key === lastSent && now - lastSentAt < 400) return;
  lastSent = key; lastSentAt = now;
  sendObj(msg);
}, 50);

/* ── Старт ── */
screen('code');
connect();
})();
