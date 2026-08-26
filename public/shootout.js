/* ══════════════════════════════════════════════════════════════
   shootout.js — ПЕРЕСТРІЛКА (фінал Батл Рояля) у стилі PUBG.
   Classic script, підключається ПІСЛЯ app.js.
   Контракт:
     window.RSO = { start(finalists, {onWinner}), stop(),
                    focusNext(dir), toggleOverview(), toggleFly() }
     rsoFocusNext(dir), rsoToggleOverview(), rsoToggleFly() — глобальні для onclick.
   Все інше живе в IIFE, щоб не конфліктувати іменами зі старим
   кодом перестрілки в app.js (він буде видалений пізніше).
   ══════════════════════════════════════════════════════════════ */

/* Контрактні глобали (перекривають старі однойменні function declarations
   з app.js — пізніше оголошення виграє) */
function rsoFocusNext(dir) { if (window.RSO) window.RSO.focusNext(dir); }
function rsoToggleOverview() { if (window.RSO) window.RSO.toggleOverview(); }
function rsoToggleFly() { if (window.RSO && window.RSO.toggleFly) window.RSO.toggleFly(); }

(function () {
'use strict';

/* ── Дрібна математика ── */
const TAU = Math.PI * 2;
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }
function lerpAng(a, b, t) { return a + angDiff(b, a) * t; }
function hyp(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }

/* Безпечні містки до глобалів app.js (щоб файл не падав наодинці) */
function esc(s) {
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function sfx(name, vol, rate, maxMs) {
  try { if (typeof playSfx === 'function') playSfx(name, vol, rate, maxMs); } catch (e) {}
}
/* Реєструємо pubg-звуки в SFX app.js, якщо їх там ще нема (щоб не правити app.js).
   playSfx мовчки ігнорує невідомі імена, тож без цього пострілів не чути. */
function ensureSfx() {
  try {
    if (typeof SFX === 'object' && SFX) {
      for (const n of ['pubg-shot', 'pubg-down', 'pubg-heal']) {
        if (!SFX[n] || SFX[n].error) {
          const a = new Audio('/assets/sfx/' + n + '.mp3');
          a.preload = 'auto';
          SFX[n] = a;
        }
      }
    }
  } catch (e) {}
}

/* ── Швидкий PRNG (xorshift32) ──
   crypto-рандом у гарячому циклі (розкид куль, частинки) дорогий,
   тому сідимо генератор один раз крипто-значенням на старті бою. */
let _rs = 2463534242;
function seedRng() {
  try { _rs = ((typeof secureRandomInt === 'function' ? secureRandomInt(0x7fffffff) : Math.random() * 0x7fffffff) | 1) >>> 0; }
  catch (e) { _rs = ((Math.random() * 0x7fffffff) | 1) >>> 0; }
  /* похідний сід рельєфу: свій на кожен бій, але БЕЗ Date.now — базується
     на тому ж crypto-сіді, тож пагорби щобою інші й стабільні протягом бою */
  _terr = Math.imul(_rs, 2654435761) >>> 0;
}
function frnd() {
  _rs ^= _rs << 13; _rs >>>= 0;
  _rs ^= _rs >>> 17;
  _rs ^= _rs << 5; _rs >>>= 0;
  return _rs / 4294967296;
}
function fint(n) { return (frnd() * n) | 0; }

/* ── Рельєф арени: heightAt(x, y) у СВІТОВИХ 2D-координатах бою ──
   Рельєф суто ВІЗУАЛЬНИЙ (3D-шар): бій, LOS і колізії лишаються чесним 2D.
   value-noise у 3 октави: плавні пагорби ±~22 юніти без обривів; краї арени
   плавно зведені до 0, щоб бійці на межі не «висіли» над землею.
   Дешево і без алокацій — викликається сотні разів на кадр. */
let _terr = 1013904223;
const TERRA_EXT = 760;   // на скільки юнітів рельєф і декор тривають ЗА межі арени
function terrHash(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + _terr) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);   // smoothstep — без зламів
  const a = terrHash(ix, iz), b = terrHash(ix + 1, iz);
  const c = terrHash(ix, iz + 1), d = terrHash(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function heightAt(x, y) {
  /* 3 октави: великі пагорби → середні хвилі → дрібна шорсткість */
  let n = vnoise(x * 0.0026, y * 0.0026) * 0.58
        + vnoise(x * 0.0062 + 71.3, y * 0.0062 + 23.7) * 0.30
        + vnoise(x * 0.015 + 133.1, y * 0.015 + 57.9) * 0.12;
  n = (n - 0.5) * 2;
  /* рельєф «домальований» далеко за арену (TERRA_EXT) — межа поля не читається
     квадратом; занулення тільки біля зовнішнього краю розширеного меша */
  let e = Math.min(x + TERRA_EXT, W + TERRA_EXT - x) / 300;
  const ey = Math.min(y + TERRA_EXT, H + TERRA_EXT - y) / 300;
  if (ey < e) e = ey;
  if (e <= 0) return 0;
  if (e > 1) e = 1;
  e = e * e * (3 - 2 * e);
  /* м'який max(0, h): долини йшли до -30 і пірнали під плаский far-план
     (y=-1.6), який їх зрізав — виглядало як «карта провалюється».
     Пагорби не змінюються, низини плавно виполажуються до ~0 без зламу */
  const h = n * 30;
  return (h + Math.sqrt(h * h + 30)) / 2 * e;
}

/* ── Спрайти (шляхи фіксовані; нема файла — малюємо placeholder) ── */
const SPR_NAMES = ['soldier', 'dead', 'crate', 'barrel', 'sandbag', 'wall', 'car', 'bush', 'tree', 'medkit', 'grenade', 'barrier', 'arena'];
const SPR = {};
function loadSprites() {
  for (const n of SPR_NAMES) {
    if (SPR[n]) continue;
    const rec = { img: new Image(), ok: false };
    rec.img.onload = function () { rec.ok = true; };
    rec.img.onerror = function () { rec.ok = false; }; // деградація без помилок
    rec.img.src = '/assets/pubg/' + n + '.png';
    SPR[n] = rec;
  }
}
function spr(n) { const s = SPR[n]; return (s && s.ok && s.img.naturalWidth > 0) ? s.img : null; }

/* ── Константи світу ── */
const W = 1600, H = 1000;      // світові координати
const PR = 16;                 // радіус гравця
const VISION = 640;            // дальність зору
const GUN = { rof: 105, mag: 30, reload: 1600, speed: 900, range: 560 };
const COLORS = ['#ff453a', '#4a9bff', '#ffd93d', '#a0ff4a', '#c77dff', '#ff8a4a', '#00ffcc', '#ff4aa8'];

/* ── Стан бою ── */
let root = null, cv = null, ctx = null, vw = 0, vh = 0, dpr = 1;
let running = false, raf = 0;
let players = [], obstacles = [], medkits = [], bullets = [], grenades = [], explosions = [], killfeed = [];
let fires = [], smokes = [];               // калюжі вогню (молотов) і димові завіси (смок)
let spawns = [];
let onWinnerCb = null, winnerShown = false, winnerP = null, endAt = 0;
/* режим перемоги: бойова симуляція стоїть, але рендер/аніматори живуть —
   переможець «святкує» за вінер-оверлеєм (пробіжки колами ↔ Wave) */
let victory = false;
const vic = { phase: 'run', until: 0, cx: 0, cy: 0, ang: 0 };
let goAt = 0;                              // момент «БОЙ!» — старт таймлайну
let lastShotHeard = 0, lastShotX = W / 2, lastShotY = H / 2, lastShotSfx = 0;
let aggroUntil = 0;                        // форсована агресія при застої
let zone = null;
let cam = { x: W / 2, y: H / 2, z: 1, tx: W / 2, ty: H / 2, tz: 1, shake: 0 };
let camMode = 'overview', manualIdx = 0, manualUntil = 0;   // старт — загальний план
let killCam = { x: 0, y: 0, until: 0, p: null };
/* Вільний політ спектатора («дрон») — лише в 3D, окремий camMode 'fly'.
   Один постійний обʼєкт — жодних алокацій у кадрі. Позиція у СВІТОВИХ
   координатах (px/pz як 2D x/y, py — висота) — так heightAt працює напряму. */
const FLY_PITCH_MAX = 1.4835;   // ±85°
const fly = {
  on: false,
  px: 0, py: 0, pz: 0,
  yaw: 0, pitch: 0,
  vx: 0, vy: 0, vz: 0,          // плавний розгін/гальмування: лерп до цільової швидкості
  speedMul: 1,                  // колесо миші, 0.4х..4х
  kW: false, kA: false, kS: false, kD: false, kUp: false, kDn: false, kBoost: false,
  drag: false, lastX: 0, lastY: 0,   // drag-look фолбек, коли pointer lock недоступний
};
let focusP = null, focusKey = '';   // «гравець у кадрі» для нижньої панелі
let kfDirty = true, hudAt = 0, camLblTxt = '', aliveTxt = '', zoneTxt = '', cdTxt = '';
let ground = null, gctx = null;            // офскрін-декалі (кров, кіптява)
let groundPat = null;                      // fallback-текстура землі
let obSeq = 0;

/* ── Пули частинок і флоат-текстів (без алокацій у гарячому циклі) ── */
const PMAX = 512, parts = new Array(PMAX);
let pHead = 0;
const FMAX = 48, floats = new Array(FMAX);
let fHead = 0;
(function initPools() {
  for (let i = 0; i < PMAX; i++) parts[i] = { on: false, type: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, color: '#fff' };
  for (let i = 0; i < FMAX; i++) floats[i] = { on: false, x: 0, y: 0, life: 0, max: 1, text: '', color: '#fff', size: 11 };
})();
/* type: 1 іскра, 2 кров, 3 дим, 4 тріска/уламок */
function addPart(type, x, y, vx, vy, life, size, color) {
  const p = parts[pHead]; pHead = (pHead + 1) % PMAX;
  p.on = true; p.type = type; p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.life = life; p.max = life; p.size = size; p.color = color;
}
function addFloat(x, y, text, color, size) {
  const f = floats[fHead]; fHead = (fHead + 1) % FMAX;
  f.on = true; f.x = x; f.y = y; f.life = 0.9; f.max = 0.9;
  f.text = text; f.color = color; f.size = size || 11;
}

/* ── Перешкоди ──
   rect: axis-aligned (vert лише міняє габарити й поворот спрайта),
   circle: бочка / кущ / стовбур дерева. */
function makeOb(type, x, y, vert) {
  const o = {
    id: obSeq++, type: type, x: x, y: y, vert: !!vert,
    shape: 'rect', hw: 0, hh: 0, r: 0,
    solid: true, blocksLOS: true, alive: true,
    hp: Infinity, hits: 0, fuseAt: 0, crown: 0,
  };
  if (type === 'wall') { o.hw = 78; o.hh = 14; }
  else if (type === 'barrier') { o.hw = 55; o.hh = 16; }
  else if (type === 'sandbag') { o.hw = 50; o.hh = 17; }
  else if (type === 'crate') { o.hw = 24; o.hh = 24; o.hp = 120; }
  else if (type === 'barrel') { o.shape = 'circle'; o.r = 15; o.blocksLOS = false; }
  else if (type === 'bush') { o.shape = 'circle'; o.r = 30; o.solid = false; o.blocksLOS = false; }
  else if (type === 'tree') { o.shape = 'circle'; o.r = 13; o.crown = 50 + fint(16); }
  if (o.shape === 'rect' && vert) { const t = o.hw; o.hw = o.hh; o.hh = t; }
  return o;
}
/* пара з точковою симетрією відносно центру — розкладка чесна для всіх */
function pushObPair(type, x, y, vert) {
  obstacles.push(makeOb(type, x, y, vert));
  obstacles.push(makeOb(type, W - x, H - y, vert));
}

/* ── Геометричні запити ── */
function solidAt(x, y, pad) {
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (!o.alive || !o.solid) continue;
    if (o.shape === 'circle') {
      const dx = o.x - x, dy = o.y - y;
      if (dx * dx + dy * dy < (o.r + pad) * (o.r + pad)) return o;
    } else {
      const cx = clamp(x, o.x - o.hw, o.x + o.hw), cy = clamp(y, o.y - o.hh, o.y + o.hh);
      const dx = cx - x, dy = cy - y;
      if (dx * dx + dy * dy < pad * pad) return o;
    }
  }
  return null;
}
/* t перетину відрізка (x0,y0)+(dx,dy)·t з AABB, або -1 */
function segRectT(x0, y0, dx, dy, o) {
  let tmin = 0, tmax = 1;
  const x1 = o.x - o.hw, x2 = o.x + o.hw, y1 = o.y - o.hh, y2 = o.y + o.hh;
  if (Math.abs(dx) < 1e-9) { if (x0 < x1 || x0 > x2) return -1; }
  else {
    let ta = (x1 - x0) / dx, tb = (x2 - x0) / dx;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
  }
  if (Math.abs(dy) < 1e-9) { if (y0 < y1 || y0 > y2) return -1; }
  else {
    let ta = (y1 - y0) / dy, tb = (y2 - y0) / dy;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
  }
  return tmin > tmax ? -1 : tmin;
}
function segCircleT(x0, y0, dx, dy, cx, cy, r) {
  const fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return -1;
  const b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  let t = (-b - disc) / (2 * a);
  if (t < 0) t = (-b + disc) / (2 * a);
  return (t < 0 || t > 1) ? -1 : t;
}
/* лінія погляду: перекривають лише blocksLOS-перешкоди */
function losBlocked(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (!o.alive || !o.blocksLOS) continue;
    if (o.shape === 'circle') { if (segCircleT(x0, y0, dx, dy, o.x, o.y, o.r) >= 0) return true; }
    else if (segRectT(x0, y0, dx, dy, o) >= 0) return true;
  }
  return false;
}
/* чи можна пройти по прямій (семпли по 12px) */
function walkClear(x0, y0, x1, y1) {
  const d = hyp(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(d / 12));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (solidAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, PR)) return false;
  }
  return true;
}

/* ── Навігаційна сітка + A* (клітинка 40px, 40×25) ── */
const CELL = 40, GW = W / CELL, GH = H / CELL, GN = GW * GH;
const navB = new Uint8Array(GN);
const aG = new Float32Array(GN), aF = new Float32Array(GN);
const aFrom = new Int16Array(GN), aState = new Uint8Array(GN); // 0 нове, 1 open, 2 closed
const aOpen = new Int16Array(GN);
function rebuildNav() {
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      navB[gy * GW + gx] = solidAt(gx * CELL + CELL / 2, gy * CELL + CELL / 2, PR + 3) ? 1 : 0;
    }
  }
}
function cellOf(x, y) {
  return clamp((y / CELL) | 0, 0, GH - 1) * GW + clamp((x / CELL) | 0, 0, GW - 1);
}
/* найближча вільна клітинка (спіраллю навколо) */
function freeCellNear(ci) {
  if (!navB[ci]) return ci;
  const cx = ci % GW, cy = (ci / GW) | 0;
  for (let r = 1; r < 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        if (!navB[ny * GW + nx]) return ny * GW + nx;
      }
    }
  }
  return ci;
}
/* A* — викликається подієво (зміна цілі), не щокадрово */
function findPath(x0, y0, x1, y1) {
  const start = freeCellNear(cellOf(x0, y0));
  const goal = freeCellNear(cellOf(x1, y1));
  if (start === goal) return null;
  aState.fill(0);
  let openN = 0;
  const gx1 = goal % GW, gy1 = (goal / GW) | 0;
  aG[start] = 0;
  aF[start] = Math.abs((start % GW) - gx1) + Math.abs(((start / GW) | 0) - gy1);
  aFrom[start] = -1; aState[start] = 1; aOpen[openN++] = start;
  let found = false;
  while (openN > 0) {
    /* лінійний пошук мінімального f — сітка мала, це дешевше за купу */
    let bi = 0;
    for (let i = 1; i < openN; i++) if (aF[aOpen[i]] < aF[aOpen[bi]]) bi = i;
    const cur = aOpen[bi];
    aOpen[bi] = aOpen[--openN];
    if (cur === goal) { found = true; break; }
    aState[cur] = 2;
    const cx = cur % GW, cy = (cur / GW) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const ni = ny * GW + nx;
        if (navB[ni] || aState[ni] === 2) continue;
        /* без зрізання кутів по діагоналі */
        if (dx && dy && (navB[cy * GW + nx] || navB[ny * GW + cx])) continue;
        const step = (dx && dy) ? 1.414 : 1;
        const ng = aG[cur] + step;
        if (aState[ni] === 1 && ng >= aG[ni]) continue;
        aG[ni] = ng;
        aF[ni] = ng + Math.abs(nx - gx1) + Math.abs(ny - gy1);
        aFrom[ni] = cur;
        if (aState[ni] !== 1) { aState[ni] = 1; aOpen[openN++] = ni; }
      }
    }
  }
  if (!found) return null;
  const pts = [];
  let c = goal;
  while (c !== -1 && c !== start) {
    pts.push({ x: (c % GW) * CELL + CELL / 2, y: ((c / GW) | 0) * CELL + CELL / 2 });
    c = aFrom[c];
  }
  pts.reverse();
  /* згладжування: пропускаємо точки, до яких і так видно прохід */
  const sm = [];
  let px = x0, py = y0, i = 0;
  while (i < pts.length) {
    let j = i;
    while (j + 1 < pts.length && walkClear(px, py, pts[j + 1].x, pts[j + 1].y)) j++;
    sm.push(pts[j]); px = pts[j].x; py = pts[j].y; i = j + 1;
  }
  sm.push({ x: x1, y: y1 });
  return sm;
}

/* ── Генерація світу: чесно-симетрична розкладка ── */
function genWorld(n) {
  obstacles.length = 0; medkits.length = 0; obSeq = 0;
  /* Спавни рівномірно по еліпсу навколо центру: всі рівновіддалені
     від центру, сусіди — один від одного. Стартовий кут випадковий. */
  spawns.length = 0;
  const a0 = frnd() * TAU;
  for (let i = 0; i < n; i++) {
    const a = a0 + i * TAU / n;
    spawns.push({ x: W / 2 + Math.cos(a) * 590, y: H / 2 + Math.sin(a) * 350, ang: a });
  }
  /* Персональне укриття перед КОЖНИМ спавном (між спавном і центром) —
     ніхто не стартує голим у чистому полі */
  for (let i = 0; i < n; i++) {
    const s = spawns[i];
    const dx = W / 2 - s.x, dy = H / 2 - s.y, d = hyp(dx, dy) || 1;
    const cx = s.x + dx / d * 95, cy = s.y + dy / d * 95;
    const vert = Math.abs(dx) > Math.abs(dy);  // стіна поперек напрямку до центру
    obstacles.push(makeOb(i % 2 ? 'sandbag' : 'wall', cx, cy, vert));
  }
  /* Центральний «компаунд»: пара ящиків — точка інтересу (вантажівку
     прибрано на прохання власника — центр став прострілюваним) */
  pushObPair('crate', W / 2 + 118, H / 2 - 78, false);
  /* Аптечки: 3-4, рівновіддалені, на «пів-кутах» між спавнами */
  const kits = n <= 4 ? 3 : 4;
  for (let i = 0; i < kits; i++) {
    const a = a0 + (i + 0.5) * TAU / kits;
    medkits.push({ x: W / 2 + Math.cos(a) * 300, y: H / 2 + Math.sin(a) * 205, taken: false, resBy: null });
  }
  /* Філлери точково-симетричними парами */
  const pool = ['crate', 'crate', 'crate', 'bush', 'bush', 'tree', 'tree', 'barrier', 'sandbag', 'wall', 'crate', 'tree'];   // бочки прибрано (вибір власника)
  const wantPairs = 16;
  let placed = 0, tries = 0;
  while (placed < wantPairs && tries < 400) {
    tries++;
    const type = pool[fint(pool.length)];
    const x = 110 + frnd() * (W - 220), y = 90 + frnd() * (H - 180);
    if (!spotFree(x, y) || !spotFree(W - x, H - y)) continue;
    pushObPair(type, x, y, frnd() < 0.5);
    placed++;
  }
  rebuildNav();
}
/* перевірка вільного місця для філлера */
function spotFree(x, y) {
  if (hyp(x - W / 2, y - H / 2) < 190) return false;              // центр зайнятий
  for (let i = 0; i < spawns.length; i++)
    if (hyp(x - spawns[i].x, y - spawns[i].y) < 135) return false; // не душимо спавни
  for (let i = 0; i < medkits.length; i++)
    if (hyp(x - medkits[i].x, y - medkits[i].y) < 80) return false;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const ext = o.shape === 'circle' ? o.r : Math.max(o.hw, o.hh);
    if (hyp(x - o.x, y - o.y) < ext + 88) return false;            // просвіт для проходу
  }
  return true;
}

/* ── Гравці ── */
function initPlayers(finalists) {
  players = finalists.map(function (f, i) {
    const s = spawns[i];
    return {
      idx: i, nick: String(f.nick || ('Гравець' + (i + 1))), col: f.col, row: f.row,
      color: COLORS[i % COLORS.length],
      x: s.x, y: s.y, vx: 0, vy: 0,
      aim: Math.atan2(H / 2 - s.y, W / 2 - s.x),   // дивимось у центр
      hp: clamp(Math.round(f.startHP || 100), 30, 100), maxHP: 100,
      armor: [0, 25, 50][fint(3)],                 // броня випадкова на старті
      alive: true, kills: 0, dmg: 0,
      ammo: GUN.mag, reloading: false, reloadEnd: 0, reloadT0: 0,
      recoil: 0, burstLeft: 0, nextShotAt: 0, burstRestUntil: 0, lastShotAt: 0,
      state: 'ROAM', decideAt: 0, strafeSide: frnd() < 0.5 ? 1 : -1, strafeAt: 0,
      target: null, losToTarget: false, hadLos: false, firstLosAt: -1e9, lastSeenX: 0, lastSeenY: 0, lastSeenAt: -1e9, noLosSince: 0,
      goalX: s.x, goalY: s.y, path: null, pathI: 0, repathAt: 0,
      coverOb: null, peekPhase: 0, peekAt: 0, peekSide: frnd() < 0.5 ? 1 : -1,
      healKit: null, healUntil: 0, healT0: 0,
      lastHurtAt: -1e9, grenades: 1, nadeAt: 0,
      specialUsed: false,   // молотов/смок — одноразовий на бійця (баланс: бій не затягується)
      bush: null, deadAt: 0, deadAng: 0, walk: frnd() * TAU,
      /* «характер»: агресивність, влучність, швидкість реакції */
      persona: { aggr: 0.2 + frnd() * 0.5, acc: 0.6 + frnd() * 0.4, react: 220 + fint(260) },
    };
  });
}

/* ── Зона ── */
function initZone(now) {
  zone = {
    cx: W / 2, cy: H / 2, r: 820,
    fcx: W / 2, fcy: H / 2, fr: 820,      // звідки анімуємо
    tcx: W / 2, tcy: H / 2, tr: 820,      // куди
    phaseN: 0, nextAt: now + 14000, shrinkUntil: 0, dmgAt: 0,
  };
}
function updateZone(dt, now) {
  const z = zone;
  const age = now - goAt;
  if (now >= z.nextAt && z.shrinkUntil <= now) {
    /* нова фаза: після 60с бою — частіше і жорсткіше */
    const late = age > 60000;
    z.phaseN++;
    z.fcx = z.cx; z.fcy = z.cy; z.fr = z.r;
    z.tr = Math.max(70, z.r * (late ? 0.52 : 0.62));
    /* центр дрейфує в межах поточного кола, але не вилазить за мапу */
    const drift = (z.r - z.tr) * 0.5;
    z.tcx = clamp(z.cx + (frnd() * 2 - 1) * drift, 320, W - 320);
    z.tcy = clamp(z.cy + (frnd() * 2 - 1) * drift, 240, H - 240);
    z.shrinkUntil = now + 4200;
    z.nextAt = z.shrinkUntil + (late ? 7000 : 12000);
  }
  if (z.shrinkUntil > now) {
    const t = 1 - (z.shrinkUntil - now) / 4200;
    z.cx = lerp(z.fcx, z.tcx, t); z.cy = lerp(z.fcy, z.tcy, t); z.r = lerp(z.fr, z.tr, t);
  } else if (z.phaseN > 0) { z.cx = z.tcx; z.cy = z.tcy; z.r = z.tr; }
  /* урон поза колом: 4/с, під кінець — жорсткіше, щоб бій точно скінчився */
  if (now - z.dmgAt >= 500) {
    z.dmgAt = now;
    const perTick = age > 80000 ? 5 : 2;   // 4/с → 10/с після 80с
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      if (hyp(p.x - z.cx, p.y - z.cy) > z.r + 2) {
        hurt(p, perTick, null, { label: 'ЗОНА', color: '#ff453a', pierce: true });
        addFloat(p.x, p.y - 26, '-' + perTick, '#ff453a', 10);
      }
    }
  }
}
function outsideZone(p, margin) {
  return zone && hyp(p.x - zone.cx, p.y - zone.cy) > zone.r - (margin || 0);
}

/* ── Урон / смерть ── */
function hurt(v, dmg, attacker, opts) {
  if (!v.alive || winnerShown) return;
  opts = opts || {};
  /* броня з'їдає половину вхідного урону, поки не зламається */
  if (!opts.pierce && v.armor > 0) {
    const ab = Math.min(v.armor, dmg * 0.5);
    v.armor = Math.max(0, v.armor - ab);
    dmg -= ab;
  }
  dmg = Math.max(1, Math.round(dmg));
  v.hp -= dmg;
  v.lastHurtAt = perfNow;
  if (attacker) attacker.dmg += dmg;
  if (v.hp <= 0) {
    // Гарантія переможця: останній живий померти не може — нічиїх не буває.
    // Покриває розмін кулями в одному кадрі, вибух бочки по обох і зону:
    // хто помер першим — той і програв, другий лишається з 1 HP.
    if (players.filter(p => p.alive).length <= 1) { v.hp = 1; return; }
    v.hp = 0; v.alive = false; v.deadAt = perfNow; v.deadAng = v.aim;
    if (v.healKit) { v.healKit.resBy = null; v.healKit = null; }
    if (attacker && attacker.alive) attacker.kills++;
    killfeed.push({
      k: opts.label || (attacker ? attacker.nick : '?'),
      kc: opts.color || (attacker ? attacker.color : '#9a9aa4'),
      v: v.nick, vc: v.color, head: !!opts.head, until: perfNow + 7000,
      /* тип іконки в рядку: гвинтівка (кульова смерть) / вибух / зона-череп */
      gun: !opts.label && !opts.boom, boom: !!opts.boom,
    });
    if (killfeed.length > 5) killfeed.shift();
    kfDirty = true;
    sfx('pubg-down', 0.6);
    decalBlood(v.x, v.y, 1.6);
    killCam.x = v.x; killCam.y = v.y; killCam.until = perfNow + 1400;
    killCam.p = v;   // «зірка» киллкама для нижньої панелі
    cam.shake = Math.min(16, cam.shake + 5);
    for (let k = 0; k < 10; k++)
      addPart(2, v.x, v.y, (frnd() * 2 - 1) * 120, (frnd() * 2 - 1) * 120, 0.5, 2 + frnd() * 2, '#a01212');
  }
}

/* ── Вибухи (бочки, гранати) ── */
function explode(x, y, radius, maxDmg, attacker, label) {
  explosions.push({ x: x, y: y, r: radius, t: 0, max: 0.55 });
  cam.shake = Math.min(22, cam.shake + 13);
  sfx('cannon', 0.5);
  decalScorch(x, y, radius * 0.55);
  for (let k = 0; k < 14; k++)
    addPart(3, x + (frnd() * 2 - 1) * 14, y + (frnd() * 2 - 1) * 14,
      (frnd() * 2 - 1) * 60, -20 - frnd() * 50, 1.4 + frnd() * 1.2, 10 + frnd() * 14, '#6a675f');
  for (let k = 0; k < 16; k++) {
    const a = frnd() * TAU, sp = 140 + frnd() * 260;
    addPart(1, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.35 + frnd() * 0.25, 1.6, '#ffc46a');
  }
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.alive) continue;
    const d = hyp(p.x - x, p.y - y);
    if (d < radius + PR) {
      let dmg = maxDmg * (1 - d / (radius + PR));
      if (losBlocked(x, y, p.x, p.y)) dmg *= 0.35;   // укриття гасить хвилю
      if (dmg >= 1) {
        hurt(p, dmg, attacker, { label: label, color: '#ff8a4a', boom: true });
        if (p.alive) addFloat(p.x, p.y - 26, '-' + Math.round(dmg), '#ff8a4a', 11);
      }
    }
  }
  /* ланцюжок: ящики ламаються, сусідні бочки детонують із затримкою */
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (!o.alive) continue;
    const d = hyp(o.x - x, o.y - y);
    if (o.type === 'crate' && d < radius + 20) breakCrate(o);
    else if (o.type === 'barrel' && d < radius + 30 && !o.fuseAt) o.fuseAt = perfNow + 140 + fint(160);
  }
}
function breakCrate(o) {
  if (!o.alive) return;
  o.alive = false;
  for (let k = 0; k < 10; k++)
    addPart(4, o.x, o.y, (frnd() * 2 - 1) * 160, (frnd() * 2 - 1) * 160, 0.5 + frnd() * 0.3, 3 + frnd() * 3, '#8a6a3f');
  rebuildNav();
}
function blowBarrel(o, attacker) {
  if (!o.alive) return;
  o.alive = false;
  rebuildNav();
  explode(o.x, o.y, 130, 78, attacker, attacker ? null : 'БОЧКА');
}

/* ── ШІ ── */
let perfNow = 0;   // performance.now() поточного кадру — щоб не смикати щоразу

/* ── Зони молотова/смока ── */
function fireAt(x, y, pad) {
  for (let i = 0; i < fires.length; i++) {
    const f = fires[i];
    if (hyp(x - f.x, y - f.y) < f.r + (pad || 0)) return f;
  }
  return null;
}
/* дим ЧЕСНО блокує зір: сегмент-коло по активних завісах; хто стоїть
   усередині — не бачить нікого (і його самого завіса теж ховає) */
function smokeBlocks(x0, y0, x1, y1) {
  for (let i = 0; i < smokes.length; i++) {
    const s = smokes[i];
    if (hyp(x0 - s.x, y0 - s.y) < s.r || hyp(x1 - s.x, y1 - s.y) < s.r) return true;
    if (segCircleT(x0, y0, x1 - x0, y1 - y0, s.x, s.y, s.r) >= 0) return true;
  }
  return false;
}
/* чи стоїть боєць у «чистому полі» (жодного LOS-укриття поруч) */
function inOpenField(q) {
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (o.alive && o.blocksLOS && hyp(o.x - q.x, o.y - q.y) < 150) return false;
  }
  return true;
}
/* баланс спецкидків: не частіше 1 на бійця за бій; у фінальній дуелі на
   відкритій місцевості — заборонено (щоб фінал не тонув у диму/вогні) */
function specialOk(p, aliveN) {
  if (p.specialUsed || perfNow < p.nadeAt) return false;
  if (aliveN <= 2) {
    let e = null;
    for (let i = 0; i < players.length; i++)
      if (players[i] !== p && players[i].alive) { e = players[i]; break; }
    if (e && inOpenField(p) && inOpenField(e)) return false;
  }
  return true;
}

/* чи бачить p гравця e (LOS + кущі; «без читерства») */
function canSee(p, e) {
  const dx = e.x - p.x, dy = e.y - p.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > VISION * VISION) return false;
  if (losBlocked(p.x, p.y, e.x, e.y)) return false;
  if (smokeBlocks(p.x, p.y, e.x, e.y)) return false;   // крізь дим не бачить і не стріляє ніхто
  /* у кущі невидимий, поки не стріляє і не впритул */
  if (e.bush && perfNow - e.lastShotAt > 1200 && d2 > 70 * 70) return false;
  return true;
}

/* точка «сховатись за o від ворога (ex,ey)» */
function coverPoint(o, ex, ey) {
  const dx = o.x - ex, dy = o.y - ey, d = hyp(dx, dy) || 1;
  const ext = o.shape === 'circle' ? o.r : Math.max(o.hw, o.hh);
  return { x: o.x + dx / d * (ext + PR + 8), y: o.y + dy / d * (ext + PR + 8) };
}
/* точка «визирнути збоку від o» */
function peekPoint(o, ex, ey, side) {
  const dx = o.x - ex, dy = o.y - ey, d = hyp(dx, dy) || 1;
  const px = -dy / d * side, py = dx / d * side;
  const ext = o.shape === 'circle' ? o.r : Math.max(o.hw, o.hh);
  return { x: o.x + px * (ext + PR + 6) - dx / d * 6, y: o.y + py * (ext + PR + 6) - dy / d * 6 };
}
/* найкраще укриття: близько до нас, з боку від ворога, в зоні */
function pickCover(p, ex, ey) {
  let best = null, bestScore = -1e9;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (!o.alive || !o.blocksLOS) continue;
    const dMe = hyp(o.x - p.x, o.y - p.y);
    if (dMe > 340) continue;
    const dEn = hyp(o.x - ex, o.y - ey);
    if (dEn < 110) continue;                      // не бігти в укриття під ноги ворогу
    const cp = coverPoint(o, ex, ey);
    if (zone && hyp(cp.x - zone.cx, cp.y - zone.cy) > zone.r - 30) continue;
    const score = -dMe - Math.abs(dEn - 260) * 0.35;
    if (score > bestScore) { bestScore = score; best = o; }
  }
  return best;
}

/* головне рішення стан-машини — раз на «реакцію» персонажа */
function decide(p, aliveN) {
  const now = perfNow;
  p.decideAt = now + p.persona.react + fint(180);

  /* 1. Поза зоною — все інше не важливе */
  if (outsideZone(p, 14)) {
    p.state = 'ESCAPE_ZONE';
    const d = hyp(p.x - zone.cx, p.y - zone.cy) || 1;
    setGoal(p, zone.cx + (p.x - zone.cx) / d * zone.r * 0.5,
               zone.cy + (p.y - zone.cy) / d * zone.r * 0.5);
    return;
  }
  /* 1.5 Стоїмо у калюжі молотова — тікаємо НЕГАЙНО («викурювання» працює) */
  const fz = fireAt(p.x, p.y, PR + 6);
  if (fz) {
    p.state = 'ESCAPE_FIRE';
    let ax = p.x - fz.x, ay = p.y - fz.y;
    const ad = hyp(ax, ay) || 1; ax /= ad; ay /= ad;
    let gx = fz.x + ax * (fz.r + 70), gy = fz.y + ay * (fz.r + 70);
    /* якщо «назовні від вогню» веде за зону — тікаємо вздовж дотичної */
    if (zone && hyp(gx - zone.cx, gy - zone.cy) > zone.r - 20) {
      gx = fz.x - ay * (fz.r + 70); gy = fz.y + ax * (fz.r + 70);
    }
    setGoal(p, gx, gy);
    p.decideAt = now + 300;   // у вогні перерішуємо частіше за звичайну реакцію
    return;
  }
  /* 2. Лікування: мало HP, не під вогнем, аптечка досяжна */
  if (p.hp < 45 && now - p.lastHurtAt > 1600 && p.state !== 'HEAL') {
    let kit = null, kd = 520;
    for (let i = 0; i < medkits.length; i++) {
      const k = medkits[i];
      if (k.taken || (k.resBy && k.resBy !== p)) continue;
      if (zone && hyp(k.x - zone.cx, k.y - zone.cy) > zone.r - 20) continue;
      const d = hyp(k.x - p.x, k.y - p.y);
      if (d < kd) { kd = d; kit = k; }
    }
    if (kit) {
      if (p.healKit && p.healKit !== kit) p.healKit.resBy = null;
      kit.resBy = p; p.healKit = kit; p.state = 'HEAL';
      /* відхід на лікування прикриваємо димом, якщо переслідувач близько */
      if (p.target && p.target.alive && specialOk(p, aliveN)) {
        const dd = hyp(p.target.x - p.x, p.target.y - p.y);
        if (dd > 1 && dd < 420)
          throwNade(p, p.x + (p.target.x - p.x) / dd * 70, p.y + (p.target.y - p.y) / dd * 70, 'smoke');
      }
      setGoal(p, kit.x, kit.y);
      return;
    }
  }
  if (p.state === 'HEAL' && p.healKit && !p.healKit.taken) return; // не смикаємось, доки лікуємось

  /* 3. Ціль: видимий ворог → пам'ять → форсована агресія */
  let vis = null, vd = 1e9;
  for (let i = 0; i < players.length; i++) {
    const e = players[i];
    if (e === p || !e.alive) continue;
    if (canSee(p, e)) {
      const d = hyp(e.x - p.x, e.y - p.y);
      if (d < vd) { vd = d; vis = e; }
    }
  }
  if (vis) {
    p.target = vis; p.lastSeenX = vis.x; p.lastSeenY = vis.y; p.lastSeenAt = now;
  } else if (now < aggroUntil || aliveN === 2) {
    /* застій або дуель: даємо приблизну розвідку, щоб зійшлися */
    let ne = null, nd = 1e9;
    for (let i = 0; i < players.length; i++) {
      const e = players[i];
      if (e === p || !e.alive) continue;
      const d = hyp(e.x - p.x, e.y - p.y);
      if (d < nd) { nd = d; ne = e; }
    }
    if (ne && (now < aggroUntil || now - p.lastSeenAt > 4000)) {
      p.target = ne;
      p.lastSeenX = ne.x + (frnd() * 2 - 1) * 60;
      p.lastSeenY = ne.y + (frnd() * 2 - 1) * 60;
      p.lastSeenAt = now - 1000;
    }
  } else if (p.target && (!p.target.alive || now - p.lastSeenAt > 6000)) {
    p.target = null;
  }

  if (!p.target || !p.target.alive) {
    /* нікого не знаємо: йдемо на звук пострілів або тиняємось у зоні */
    p.state = 'ROAM';
    if (now - lastShotHeard < 3000) setGoal(p, lastShotX + (frnd() * 2 - 1) * 80, lastShotY + (frnd() * 2 - 1) * 80);
    else {
      const a = frnd() * TAU, rr = frnd() * zone.r * 0.55;
      setGoal(p, zone.cx + Math.cos(a) * rr, zone.cy + Math.sin(a) * rr);
    }
    return;
  }

  const t = p.target;
  const los = canSee(p, t);
  p.losToTarget = los;
  if (los) { p.noLosSince = 0; } else if (!p.noLosSince) p.noLosSince = now;
  const noLosFor = p.noLosSince ? now - p.noLosSince : 0;
  const d = hyp(t.x - p.x, t.y - p.y);
  const underFire = now - p.lastHurtAt < 1300;
  /* настрій: характер + добивання + пізня гра */
  const mood = p.persona.aggr
    + (aliveN <= 2 ? 0.22 : 0)
    + (now < aggroUntil ? 0.55 : 0)
    + (t.hp < 35 ? 0.4 : 0)
    + (zone.r < 230 ? 0.35 : 0);

  if (los) {
    if (mood > 0.9 || d > 470) {
      p.state = 'PUSH';
      setGoal(p, t.x, t.y);
    } else if (underFire && p.hp < 72 && frnd() < 0.75) {
      p.state = 'SEEK_COVER';
      p.coverOb = pickCover(p, t.x, t.y);
      if (p.coverOb) {
        const cp = coverPoint(p.coverOb, t.x, t.y);
        setGoal(p, cp.x, cp.y);
        /* димова завіса між собою і стрільцем — прикриває відхід під вогнем */
        if (specialOk(p, aliveN) && frnd() < 0.6) {
          const dd = d || 1, k = Math.min(90, dd * 0.4);
          throwNade(p, p.x + (t.x - p.x) / dd * k, p.y + (t.y - p.y) / dd * k, 'smoke');
        }
      }
      else { p.state = 'ENGAGE'; }
    } else {
      p.state = 'ENGAGE';
    }
  } else {
    /* кидок по засілому ворогу — ТУТ вибирається тип: frag ~50% /
       молотов ~25% (викурити з укриття — кидаємо В ЗОНУ, де сидить ціль) /
       смок ~25% (пуш ворога в укритті: завіса на підході, йдемо крізь дим) */
    if (noLosFor > 1800 && d > 120 && d < 380 && now > p.nadeAt && frnd() < 0.55) {
      const ntx = p.lastSeenX + (frnd() * 2 - 1) * 30, nty = p.lastSeenY + (frnd() * 2 - 1) * 30;
      const roll = frnd();
      if (roll < 0.5) { if (p.grenades > 0) throwNade(p, ntx, nty, 'frag'); }
      else if (roll < 0.75) { if (specialOk(p, aliveN)) throwNade(p, ntx, nty, 'molotov'); }
      else if (specialOk(p, aliveN)) {
        /* смок — на пів-дорозі до укриття ворога: за завісою і пушимо */
        throwNade(p, p.x + (ntx - p.x) * 0.6, p.y + (nty - p.y) * 0.6, 'smoke');
      }
    }
    const nearCover = p.coverOb && p.coverOb.alive && hyp(p.coverOb.x - p.x, p.coverOb.y - p.y) < 120;
    if (noLosFor > 3200 || mood > 0.85) {
      /* ворог довго сидить — обходимо з флангу */
      p.state = 'FLANK';
      const ang = Math.atan2(p.lastSeenY - p.y, p.lastSeenX - p.x) + p.peekSide * 1.25;
      setGoal(p, clamp(p.lastSeenX - Math.cos(ang) * 240, 60, W - 60),
                 clamp(p.lastSeenY - Math.sin(ang) * 240, 60, H - 60));
    } else if (nearCover || (p.coverOb = pickCover(p, p.lastSeenX, p.lastSeenY))) {
      p.state = 'PEEK';
      p.peekPhase = 0; p.peekAt = now + 450 + fint(650);
    } else {
      p.state = 'PUSH';                      // укриттів нема — просто йдемо
      setGoal(p, p.lastSeenX, p.lastSeenY);
    }
  }
}

/* ── Рух ── */
function setGoal(p, x, y) {
  x = clamp(x, 40, W - 40); y = clamp(y, 40, H - 40);
  /* не перепрокладаємо шлях через дрібне зміщення цілі */
  if (hyp(p.goalX - x, p.goalY - y) > 30 || !p.path) {
    p.goalX = x; p.goalY = y;
    p.path = null; p.repathAt = 0;
  }
}
function followGoal(p, dt, sprint) {
  const gx = p.goalX, gy = p.goalY;
  const dGoal = hyp(gx - p.x, gy - p.y);
  if (dGoal < 8) { p.vx *= 0.8; p.vy *= 0.8; return; }
  let tx = gx, ty = gy;
  if (!walkClear(p.x, p.y, gx, gy)) {
    /* пряма перекрита → A*-шлях (рахуємо нечасто) */
    if (!p.path && perfNow > p.repathAt) {
      p.path = findPath(p.x, p.y, gx, gy);
      p.pathI = 0; p.repathAt = perfNow + 600;
    }
    if (p.path) {
      while (p.pathI < p.path.length - 1 && hyp(p.path[p.pathI].x - p.x, p.path[p.pathI].y - p.y) < 26) p.pathI++;
      const wp = p.path[Math.min(p.pathI, p.path.length - 1)];
      tx = wp.x; ty = wp.y;
    }
  } else { p.path = null; }
  const d = hyp(tx - p.x, ty - p.y) || 1;
  const sp = sprint ? 150 : 115;                     // px/с (повільніше — глядач встигає стежити)
  const k = 1 - Math.exp(-dt * 6);                   // інерція розгону
  p.vx += ((tx - p.x) / d * sp - p.vx) * k;
  p.vy += ((ty - p.y) / d * sp - p.vy) * k;
}
/* колізії: гравець ↔ перешкоди ↔ гравці ↔ межі світу */
function resolveCollisions(p) {
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (!o.alive || !o.solid) continue;
    if (o.shape === 'circle') {
      const dx = p.x - o.x, dy = p.y - o.y, d = hyp(dx, dy);
      const min = o.r + PR;
      if (d < min && d > 0.001) { p.x = o.x + dx / d * min; p.y = o.y + dy / d * min; }
    } else {
      const cx = clamp(p.x, o.x - o.hw, o.x + o.hw), cy = clamp(p.y, o.y - o.hh, o.y + o.hh);
      const dx = p.x - cx, dy = p.y - cy, d = hyp(dx, dy);
      if (d < PR) {
        if (d > 0.001) { p.x = cx + dx / d * PR; p.y = cy + dy / d * PR; }
        else p.y = o.y - o.hh - PR;                  // центр усередині — виштовхуємо вгору
      }
    }
  }
  for (let i = 0; i < players.length; i++) {
    const q = players[i];
    if (q === p || !q.alive) continue;
    const dx = p.x - q.x, dy = p.y - q.y, d = hyp(dx, dy);
    const min = PR * 2 - 2;
    if (d < min && d > 0.001) {
      const push = (min - d) / 2;
      p.x += dx / d * push; p.y += dy / d * push;
      q.x -= dx / d * push; q.y -= dy / d * push;
    }
  }
  p.x = clamp(p.x, PR + 4, W - PR - 4);
  p.y = clamp(p.y, PR + 4, H - PR - 4);
}

/* ── Стрільба ── */
function spreadOf(p, d) {
  const moving = hyp(p.vx, p.vy) / 235;
  /* штраф першої секунди контакту — «реакція» замість аімбота */
  const fresh = perfNow - p.firstLosAt < 650 ? 0.13 : 0;
  return 0.09 + moving * 0.11 + p.recoil + (d / 900) * 0.14 + fresh;
}
function fire(p) {
  const now = perfNow;
  p.ammo--; p.lastShotAt = now;
  p.recoil = Math.min(0.28, p.recoil + 0.025);
  lastShotHeard = now; lastShotX = p.x; lastShotY = p.y;
  if (now - lastShotSfx > 125) { lastShotSfx = now; sfx('pubg-shot', 0.35); } // ≤8 пострілів/с у звуці
  const t = p.target;
  const d = t ? hyp(t.x - p.x, t.y - p.y) : 300;
  /* упередження за швидкістю цілі — краще у влучніших персонажів */
  let aimX = t ? t.x + t.vx * (d / GUN.speed) * p.persona.acc : p.x + Math.cos(p.aim) * 100;
  let aimY = t ? t.y + t.vy * (d / GUN.speed) * p.persona.acc : p.y + Math.sin(p.aim) * 100;
  let ang = Math.atan2(aimY - p.y, aimX - p.x);
  /* розкид: сума двох рівномірних ≈ трикутний розподіл */
  ang += (frnd() + frnd() - 1) * spreadOf(p, d);
  const mx = p.x + Math.cos(p.aim) * (PR + 6), my = p.y + Math.sin(p.aim) * (PR + 6);
  bullets.push({
    x: mx, y: my, px: mx, py: my,
    vx: Math.cos(ang) * GUN.speed, vy: Math.sin(ang) * GUN.speed,
    owner: p, traveled: 0, dead: false,
  });
  if (p.ammo <= 0) startReload(p);
}
function startReload(p) {
  if (p.reloading) return;
  p.reloading = true; p.reloadT0 = perfNow; p.reloadEnd = perfNow + GUN.reload;
  p.burstLeft = 0;
}
/* бойова частина кадру: доворот прицілу + черги */
function combat(p, dt) {
  const t = p.target, now = perfNow;
  if (p.reloading && now >= p.reloadEnd) { p.reloading = false; p.ammo = GUN.mag; }
  p.recoil = Math.max(0, p.recoil - dt * 0.09);
  if (!t || !t.alive || p.healUntil) return;
  const los = canSee(p, t);
  if (los && !p.hadLos) p.firstLosAt = now;   // ціль щойно з'явилась у прицілі
  p.hadLos = los;
  p.losToTarget = los;
  if (los) { p.lastSeenX = t.x; p.lastSeenY = t.y; p.lastSeenAt = now; p.noLosSince = 0; }
  const d = hyp(t.x - p.x, t.y - p.y);
  const want = los ? Math.atan2(t.y - p.y, t.x - p.x)
                   : Math.atan2(p.lastSeenY - p.y, p.lastSeenX - p.x);
  p.aim = lerpAng(p.aim, want, Math.min(1, dt * 7));   // швидкість довороту
  /* тактична перезарядка, поки ворога не видно */
  if (!los && !p.reloading && p.ammo < 10) startReload(p);
  if (!los || p.reloading || d > GUN.range) return;
  if (Math.abs(angDiff(p.aim, want)) > 0.14) return;
  if (p.ammo <= 0) { startReload(p); return; }
  if (now < p.burstRestUntil || now < p.nextShotAt) return;
  if (p.burstLeft <= 0) p.burstLeft = 3 + fint(4);      // черга 3–6
  fire(p);
  p.burstLeft--; p.nextShotAt = now + GUN.rof;
  if (p.burstLeft <= 0) p.burstRestUntil = now + 520 + fint(650);
}

/* покадрова поведінка гравця */
function updatePlayer(p, dt, aliveN) {
  const now = perfNow;
  /* кущ, у якому сидимо (для маскування й малювання) */
  p.bush = null;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (o.type === 'bush' && o.alive && hyp(o.x - p.x, o.y - p.y) < o.r - 4) { p.bush = o; break; }
  }
  /* канал лікування: стоїмо 2с; збили — аптечка лишається */
  if (p.healUntil) {
    if (now - p.lastHurtAt < 300) { p.healUntil = 0; p.state = 'ROAM'; p.decideAt = 0; }
    else if (now >= p.healUntil) {
      p.hp = Math.min(p.maxHP, p.hp + 50);
      if (p.healKit) { p.healKit.taken = true; p.healKit.resBy = null; }
      p.healKit = null; p.healUntil = 0; p.decideAt = 0;
      addFloat(p.x, p.y - 28, '+50', '#a0ff4a', 13);
      sfx('pubg-heal', 0.55);
    } else { p.vx *= 0.7; p.vy *= 0.7; combat(p, dt); return; }
  }

  if (now >= p.decideAt) decide(p, aliveN);

  /* поведінка стану (цілі руху) */
  let sprint = false;
  const t = p.target;
  switch (p.state) {
    case 'ENGAGE': {
      /* стрейф боком, тримаємо дистанцію */
      if (now > p.strafeAt) { p.strafeAt = now + 700 + fint(800); p.strafeSide = -p.strafeSide; }
      if (t && t.alive) {
        const d = hyp(t.x - p.x, t.y - p.y) || 1;
        const px = -(t.y - p.y) / d, py = (t.x - p.x) / d;
        let gx = p.x + px * p.strafeSide * 70, gy = p.y + py * p.strafeSide * 70;
        if (d > 450) { gx += (t.x - p.x) / d * 120; gy += (t.y - p.y) / d * 120; }
        else if (d < 210) { gx -= (t.x - p.x) / d * 90; gy -= (t.y - p.y) / d * 90; } // відступ: не зближуємось даром
        setGoal(p, gx, gy);
      }
      break;
    }
    case 'PUSH':
      sprint = true;
      if (t && t.alive) {
        const d = hyp(t.x - p.x, t.y - p.y);
        if (p.losToTarget && d < 190) { p.state = 'ENGAGE'; }
        else setGoal(p, p.losToTarget ? t.x : p.lastSeenX, p.losToTarget ? t.y : p.lastSeenY);
      }
      break;
    case 'SEEK_COVER':
      sprint = true;
      if (p.coverOb && !p.coverOb.alive) { p.coverOb = null; p.decideAt = 0; }
      else if (p.coverOb && hyp(p.goalX - p.x, p.goalY - p.y) < 12) {
        p.state = 'PEEK'; p.peekPhase = 0; p.peekAt = now + 500 + fint(600);
      }
      break;
    case 'PEEK': {
      /* цикл: сховався → визирнув-вистрілив → назад */
      const o = p.coverOb;
      if (!o || !o.alive) { p.decideAt = 0; break; }
      const ex = p.losToTarget && t ? t.x : p.lastSeenX;
      const ey = p.losToTarget && t ? t.y : p.lastSeenY;
      if (p.peekPhase === 0) {
        const cp = coverPoint(o, ex, ey);
        setGoal(p, cp.x, cp.y);
        if (now > p.peekAt) {
          p.peekPhase = 1; p.peekAt = now + 750 + fint(500);
          if (frnd() < 0.35) p.peekSide = -p.peekSide;
        }
      } else {
        const pp = peekPoint(o, ex, ey, p.peekSide);
        setGoal(p, pp.x, pp.y);
        if (now > p.peekAt) { p.peekPhase = 0; p.peekAt = now + 550 + fint(650); }
      }
      break;
    }
    case 'FLANK':
      sprint = true;
      if (p.losToTarget) { p.state = 'ENGAGE'; p.decideAt = 0; }
      break;
    case 'HEAL':
      if (!p.healKit || p.healKit.taken) { p.state = 'ROAM'; p.decideAt = 0; break; }
      setGoal(p, p.healKit.x, p.healKit.y);
      if (hyp(p.healKit.x - p.x, p.healKit.y - p.y) < 20 && !p.healUntil) {
        p.healUntil = now + 2000; p.healT0 = now;    // +50hp за 2с
      }
      break;
    case 'ESCAPE_ZONE':
      sprint = true;
      if (!outsideZone(p, 30)) p.decideAt = 0;       // повернулись — перерішуємо
      break;
    case 'ESCAPE_FIRE':
      sprint = true;
      if (!fireAt(p.x, p.y, PR + 10)) p.decideAt = 0;  // вибігли з вогню — перерішуємо
      break;
    case 'ROAM':
      if (hyp(p.goalX - p.x, p.goalY - p.y) < 20) p.decideAt = 0;
      break;
  }

  followGoal(p, dt, sprint);
  p.x += p.vx * dt; p.y += p.vy * dt;
  p.walk += hyp(p.vx, p.vy) * dt * 0.05;
  /* без цілі дивимось за рухом */
  if ((!t || !t.alive) && hyp(p.vx, p.vy) > 20)
    p.aim = lerpAng(p.aim, Math.atan2(p.vy, p.vx), Math.min(1, dt * 5));
  combat(p, dt);
}

/* ── Кулі: сегментний рейкаст (без тунелювання) ── */
function updateBullets(dt) {
  for (let bi = bullets.length - 1; bi >= 0; bi--) {
    const b = bullets[bi];
    b.px = b.x; b.py = b.y;
    const dx = b.vx * dt, dy = b.vy * dt;
    let bestT = 1.01, hitOb = null, hitP = null;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!o.alive || !o.solid) continue;            // кущі кулю не спиняють
      let t;
      if (o.shape === 'circle') t = segCircleT(b.px, b.py, dx, dy, o.x, o.y, o.r);
      else t = segRectT(b.px, b.py, dx, dy, o);
      if (t >= 0 && t < bestT) { bestT = t; hitOb = o; hitP = null; }
    }
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive || p === b.owner) continue;
      const t = segCircleT(b.px, b.py, dx, dy, p.x, p.y, PR + 1);
      if (t >= 0 && t < bestT) { bestT = t; hitP = p; hitOb = null; }
    }
    if (bestT <= 1) {
      const hx = b.px + dx * bestT, hy = b.py + dy * bestT;
      const dist = b.traveled + hyp(dx, dy) * bestT;
      if (hitP) {
        /* падіння урону за дистанцією */
        const k = clamp(1 - (dist - 180) / 700, 0.5, 1);
        const head = frnd() < 0.08;
        let dmg = (6 + frnd() * 3) * k * (head ? 2 : 1);
        for (let q = 0; q < 5; q++)
          addPart(2, hx, hy, (frnd() * 2 - 1) * 150, (frnd() * 2 - 1) * 150, 0.4, 2, '#b01515');
        if (frnd() < 0.3) decalBlood(hx, hy, 0.6);
        hurt(hitP, dmg, b.owner, { head: head });
        addFloat(hx + (frnd() * 20 - 10), hy - 22, '-' + Math.round(dmg), head ? '#ffe873' : '#ff6b60', head ? 13 : 11);
      } else if (hitOb) {
        if (hitOb.type === 'crate') {
          hitOb.hp -= 15;                            // ~8 куль на ящик
          for (let q = 0; q < 3; q++)
            addPart(4, hx, hy, (frnd() * 2 - 1) * 120, (frnd() * 2 - 1) * 120, 0.35, 2.5, '#9a7443');
          if (hitOb.hp <= 0) breakCrate(hitOb);
        } else if (hitOb.type === 'barrel') {
          hitOb.hits++;
          for (let q = 0; q < 4; q++)
            addPart(1, hx, hy, (frnd() * 2 - 1) * 180, (frnd() * 2 - 1) * 180, 0.3, 1.6, '#ffc46a');
          if (hitOb.hits >= 3) blowBarrel(hitOb, b.owner);
        } else {
          for (let q = 0; q < 3; q++)
            addPart(1, hx, hy, (frnd() * 2 - 1) * 160, (frnd() * 2 - 1) * 160, 0.28, 1.5, '#ffdf9a');
        }
      }
      b.dead = true;
    } else {
      b.x += dx; b.y += dy; b.traveled += hyp(dx, dy);
      if (b.traveled > GUN.range + 60) b.dead = true;
    }
    if (b.dead) { bullets[bi] = bullets[bullets.length - 1]; bullets.pop(); }
  }
}

/* ── Гранати / молотови / смоки ── */
function throwNade(p, tx, ty, kind) {
  kind = kind || 'frag';
  if (kind === 'frag') p.grenades--;
  else p.specialUsed = true;                 // молотов/смок — один на бійця за бій
  p.nadeAt = perfNow + 9000;
  const d = hyp(tx - p.x, ty - p.y);
  grenades.push({ sx: p.x, sy: p.y, tx: tx, ty: ty, t: 0, dur: clamp(d / 300, 0.7, 1.15), owner: p, kind: kind });
}
function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.t += dt / g.dur;
    if (g.t >= 1) {
      if (g.kind === 'molotov') igniteMolotov(g);
      else if (g.kind === 'smoke') popSmoke(g);
      else explode(g.tx, g.ty, 110, 72, g.owner, null);
      grenades[i] = grenades[grenades.length - 1]; grenades.pop();
    }
  }
}
/* молотов: розбиття зі сплеском вогню → калюжа r≈70 на ~5с (8 хп/с) */
function igniteMolotov(g) {
  sfx('cannon', 0.35);   // «розбиття» — той самий бас, що спалах, тихіше за вибух
  fires.push({ x: g.tx, y: g.ty, r: 70, born: perfNow, until: perfNow + 5000, owner: g.owner, dmgAt: perfNow });
  cam.shake = Math.min(16, cam.shake + 4);
  for (let k = 0; k < 18; k++) {             // бризки палаючої суміші врізнобіч
    const a = frnd() * TAU, sp = 60 + frnd() * 190;
    addPart(1, g.tx, g.ty, Math.cos(a) * sp, Math.sin(a) * sp, 0.4 + frnd() * 0.35, 2.2, '#ffb35a');
  }
  /* усі в радіусі перерішують негайно — «тікати з вогню» спрацює цим же кадром */
  for (let i = 0; i < players.length; i++) {
    const q = players[i];
    if (q.alive && hyp(q.x - g.tx, q.y - g.ty) < 70 + PR + 20) q.decideAt = 0;
  }
}
/* смок: хлопок → завіса r≈80 на ~7с; LOS блокує smokeBlocks() у canSee */
function popSmoke(g) {
  sfx('rev-load', 0.25);
  smokes.push({ x: g.tx, y: g.ty, r: 80, born: perfNow, until: perfNow + 7000 });
}
/* тік зон: урон вогню (8/с — двічі на секунду по 4) + протухання */
function updateAreas() {
  for (let i = fires.length - 1; i >= 0; i--) {
    const f = fires[i];
    if (perfNow >= f.until) {
      decalScorch(f.x, f.y, f.r * 0.9);      // обвуглена пляма лишається назавжди
      fires[i] = fires[fires.length - 1]; fires.pop();
      continue;
    }
    if (perfNow - f.dmgAt >= 500) {
      f.dmgAt = perfNow;
      for (let j = 0; j < players.length; j++) {
        const q = players[j];
        if (!q.alive) continue;
        if (hyp(q.x - f.x, q.y - f.y) < f.r + PR * 0.5) {
          hurt(q, 4, f.owner, { label: '🔥', color: '#ff8a4a' });
          if (q.alive) addFloat(q.x, q.y - 26, '-4', '#ff8a4a', 10);
        }
      }
      /* жарини вгору: працюють і у 2D-фолбеку (у 3D свої язики полум'я) */
      for (let k = 0; k < 3; k++) {
        const a = frnd() * TAU, rr = frnd() * f.r * 0.8;
        addPart(1, f.x + Math.cos(a) * rr, f.y + Math.sin(a) * rr,
          (frnd() * 2 - 1) * 30, -30 - frnd() * 40, 0.5, 2, '#ff9a3a');
      }
    }
  }
  for (let i = smokes.length - 1; i >= 0; i--)
    if (perfNow >= smokes[i].until) { smokes[i] = smokes[smokes.length - 1]; smokes.pop(); }
}

/* ── Частинки / вибухи / флоати ── */
function updateParts(dt) {
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on) continue;
    p.life -= dt;
    if (p.life <= 0) { p.on = false; continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.type === 3) { p.vx *= 0.98; p.vy *= 0.98; p.size += dt * 14; } // дим росте
    else { p.vx *= 0.9; p.vy *= 0.9; }
  }
  for (let i = 0; i < FMAX; i++) {
    const f = floats[i];
    if (!f.on) continue;
    f.life -= dt;
    if (f.life <= 0) { f.on = false; continue; }
    f.y -= 26 * dt;
  }
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    e.t += dt;
    if (e.t > e.max) { explosions[i] = explosions[explosions.length - 1]; explosions.pop(); }
  }
}

/* ── Декалі на офскрін-землі (кров, кіптява) — малюються раз, живуть вічно ── */
function decalBlood(x, y, scale) {
  if (!gctx) return;
  gctx.save();
  gctx.globalAlpha = 0.4;
  gctx.fillStyle = '#571010';
  for (let i = 0; i < 5; i++) {
    const a = frnd() * TAU, d = frnd() * 14 * scale;
    gctx.beginPath();
    gctx.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d, (3 + frnd() * 6) * scale, (2 + frnd() * 4) * scale, a, 0, TAU);
    gctx.fill();
  }
  gctx.restore();
  groundDirty3D = true;   // 3D-шар декалей перезалє текстуру лише коли щось домальовано
}
function decalScorch(x, y, r) {
  if (!gctx) return;
  gctx.save();
  const g = gctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, 'rgba(12,10,8,0.65)');
  g.addColorStop(0.7, 'rgba(15,13,10,0.35)');
  g.addColorStop(1, 'rgba(15,13,10,0)');
  gctx.fillStyle = g;
  gctx.beginPath(); gctx.arc(x, y, r, 0, TAU); gctx.fill();
  gctx.restore();
  groundDirty3D = true;
}

/* ── Камера: авторежисура ── */
function fitZoom() { return Math.min(vw / W, vh / H) * 0.97; }
const camAlive = [];
function updateCam(dt) {
  const now = perfNow;
  camAlive.length = 0;
  for (let i = 0; i < players.length; i++) if (players[i].alive) camAlive.push(players[i]);
  /* перемикачі камер вимикають політ явно (flyStop) — це лише страховка від розсинку */
  if (fly.on && camMode !== 'fly') flyStop(false);
  if (camMode === 'manual' && now > manualUntil) { camMode = 'auto'; updOverviewBtn(); }
  let label = 'авто', chip = '';
  focusP = null;
  if (camMode === 'overview') {
    cam.tx = W / 2; cam.ty = H / 2; cam.tz = fitZoom();
    label = 'обзор';
  } else if (camMode === 'manual' && camAlive.length) {
    const t = camAlive[((manualIdx % camAlive.length) + camAlive.length) % camAlive.length];
    focusP = t;
    cam.tx = t.x; cam.ty = t.y; cam.tz = 2.0;
    label = t.nick; chip = t.color;
  } else if (now < killCam.until) {
    /* короткий наїзд на свіжу жертву */
    cam.tx = killCam.x; cam.ty = killCam.y; cam.tz = 2.3;
    focusP = killCam.p;   // панель показує жертву (hp 0) — як у PUBG
  } else if (camAlive.length === 1) {
    cam.tx = camAlive[0].x; cam.ty = camAlive[0].y; cam.tz = 2.0;
    label = camAlive[0].nick; chip = camAlive[0].color;
    focusP = camAlive[0];
  } else if (camAlive.length >= 2) {
    /* найцікавіша пара: нещодавно стріляли/отримували + найближчі */
    let ba = camAlive[0], bb = camAlive[1], bs = -1e9;
    for (let i = 0; i < camAlive.length; i++) {
      for (let j = i + 1; j < camAlive.length; j++) {
        const a = camAlive[i], b = camAlive[j];
        const d = hyp(a.x - b.x, a.y - b.y);
        let s = -d * 0.6;
        if (now - Math.max(a.lastShotAt, b.lastShotAt) < 1600) s += 700;
        if (now - Math.max(a.lastHurtAt, b.lastHurtAt) < 1200) s += 500;
        if (s > bs) { bs = s; ba = a; bb = b; }
      }
    }
    cam.tx = (ba.x + bb.x) / 2; cam.ty = (ba.y + bb.y) / 2;
    const needW = Math.abs(ba.x - bb.x) / 2 + 260, needH = Math.abs(ba.y - bb.y) / 2 + 200;
    cam.tz = clamp(Math.min(vw / 2 / needW, vh / 2 / needH), 1.1, 2.0);
    /* «зірка» пари — той, хто стріляв останнім (він і веде дуель) */
    focusP = ba.lastShotAt >= bb.lastShotAt ? ba : bb;
  }
  /* у польоті — свій підпис камери; focusP лишається від авто-логіки вище
     (панель гравця у fly живе як зазвичай) */
  if (camMode === 'fly') { label = 'полёт'; chip = ''; }
  /* не показуємо задвірки за межами світу */
  const hw = vw / 2 / cam.tz, hh = vh / 2 / cam.tz;
  cam.tx = hw * 2 >= W ? W / 2 : clamp(cam.tx, hw, W - hw);
  cam.ty = hh * 2 >= H ? H / 2 : clamp(cam.ty, hh, H - hh);
  const k = 1 - Math.exp(-dt * 3.4), kz = 1 - Math.exp(-dt * 2.6);
  cam.x += (cam.tx - cam.x) * k;
  cam.y += (cam.ty - cam.y) * k;
  cam.z += (cam.tz - cam.z) * kz;
  cam.shake *= Math.exp(-dt * 5);
  if (cam.shake < 0.2) cam.shake = 0;
  /* підпис камери */
  if (label !== camLblTxt) {
    camLblTxt = label;
    const el = document.getElementById('so-cam-name');
    if (el) el.textContent = label;
    const ch = document.getElementById('so-cam-chip');
    if (ch) { ch.style.background = chip || 'transparent'; ch.style.opacity = chip ? '1' : '0'; }
  }
}

/* ── Головний крок симуляції ── */
function update(dt) {
  perfNow = performance.now();
  const now = perfNow;
  if (victory) {
    /* сцена перемоги: жодного бою/зони/AI — лише хореографія переможця,
       догорання ефектів (урон скрізь глушить guard winnerShown у hurt) і камера */
    updateVictory(dt, now);
    updateBullets(dt);
    updateGrenades(dt);
    updateAreas();
    updateParts(dt);
    for (let i = killfeed.length - 1; i >= 0; i--)
      if (killfeed[i].until < now) { killfeed.splice(i, 1); kfDirty = true; }
    updateCam(dt);
    return;
  }
  if (now >= goAt) {
    /* бочки з підпаленим гнітом (ланцюгова детонація) */
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (o.alive && o.type === 'barrel' && o.fuseAt && now >= o.fuseAt) blowBarrel(o, null);
    }
    updateZone(dt, now);
    let aliveN = 0;
    for (let i = 0; i < players.length; i++) if (players[i].alive) aliveN++;
    /* антизастій: 6с без пострілів при ≥2 живих → форсуємо агресію */
    if (aliveN >= 2 && now - lastShotHeard > 6000 && now > aggroUntil) {
      aggroUntil = now + 7000;
      for (let i = 0; i < players.length; i++) if (players[i].alive) players[i].decideAt = 0;
    }
    for (let i = 0; i < players.length; i++) if (players[i].alive) updatePlayer(players[i], dt, aliveN);
    for (let i = 0; i < players.length; i++) if (players[i].alive) resolveCollisions(players[i]);
    updateBullets(dt);
    updateGrenades(dt);
    updateAreas();   // вогонь молотовів (урон/згасання) + протухання димів
    /* фініш: останній живий трохи «святкує», потім екран переможця */
    aliveN = 0;
    let lastAlive = null;
    for (let i = 0; i < players.length; i++) if (players[i].alive) { aliveN++; lastAlive = players[i]; }
    if (aliveN <= 1 && !endAt) {
      endAt = now + 2000;
      winnerP = lastAlive;
      if (!winnerP) {
        /* обидва лягли одночасно — переможцем стає той, хто протримався довше */
        for (let i = 0; i < players.length; i++)
          if (!winnerP || players[i].deadAt > winnerP.deadAt) winnerP = players[i];
      }
      camMode = 'auto'; manualUntil = 0;
    }
    if (endAt && now >= endAt && !winnerShown) finishFight();
  }
  updateParts(dt);
  /* протухлі рядки кіллфіда */
  for (let i = killfeed.length - 1; i >= 0; i--)
    if (killfeed[i].until < now) { killfeed.splice(i, 1); kfDirty = true; }
  updateCam(dt);
}

/* ── Малювання ── */
function buildGroundPat() {
  const t = document.createElement('canvas');
  t.width = t.height = 128;
  const c = t.getContext('2d');
  c.fillStyle = '#41402f';
  c.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 260; i++) {
    c.fillStyle = frnd() < 0.5 ? '#484633' : '#3a392a';
    c.globalAlpha = 0.3 + frnd() * 0.5;
    c.beginPath();
    c.arc(frnd() * 128, frnd() * 128, frnd() * 3, 0, TAU);
    c.fill();
  }
  c.globalAlpha = 1;
  return ctx.createPattern(t, 'repeat');
}
/* спрайт, вписаний у бокс зі збереженням пропорцій; false = картинки нема */
function drawSpr(name, x, y, boxW, boxH, rot, alpha, stretch) {
  const im = spr(name);
  if (!im) return false;
  ctx.save();
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  if (alpha != null) ctx.globalAlpha *= alpha;
  if (stretch) ctx.drawImage(im, -boxW / 2, -boxH / 2, boxW, boxH);
  else {
    const s = Math.min(boxW / im.naturalWidth, boxH / im.naturalHeight);
    ctx.drawImage(im, -im.naturalWidth * s / 2, -im.naturalHeight * s / 2, im.naturalWidth * s, im.naturalHeight * s);
  }
  ctx.restore();
  return true;
}
function shadow(x, y, rx, ry) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(x + 3, y + 5, rx, ry, 0, 0, TAU); ctx.fill();
}

function drawObstacle(o) {
  if (o.shape === 'rect') {
    const bw = (o.vert ? o.hh : o.hw) * 2 + 8, bh = (o.vert ? o.hw : o.hh) * 2 + 8;
    const rot = o.vert ? Math.PI / 2 : 0;
    shadow(o.x, o.y, o.hw * 0.95, o.hh * 0.8);
    if (drawSpr(o.type, o.x, o.y, bw, bh, rot, 1, true)) {
      /* тріщини на побитому ящику */
      if (o.type === 'crate' && o.hp < 90) crateCracks(o);
      return;
    }
    /* placeholder-форми, поки спрайти не згенеровані */
    ctx.save();
    ctx.translate(o.x, o.y);
    const colors = { wall: '#55575c', barrier: '#84878e', sandbag: '#7a6f4e', crate: '#8a6a3f' };
    ctx.fillStyle = colors[o.type] || '#666';
    roundRect(-o.hw, -o.hh, o.hw * 2, o.hh * 2, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2; ctx.stroke();
    if (o.type === 'crate') {
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.moveTo(-o.hw, -o.hh); ctx.lineTo(o.hw, o.hh);
      ctx.moveTo(o.hw, -o.hh); ctx.lineTo(-o.hw, o.hh);
      ctx.stroke();
    }
    ctx.restore();
    if (o.type === 'crate' && o.hp < 90) crateCracks(o);
  } else if (o.type === 'barrel') {
    shadow(o.x, o.y, o.r, o.r * 0.8);
    if (!drawSpr('barrel', o.x, o.y, o.r * 2.3, o.r * 2.3, 0, 1)) {
      ctx.fillStyle = '#a32b24';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#5f1712'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r - 4, 0, TAU); ctx.stroke();
    }
    /* прострелена бочка ледь «димить» — підказка глядачу */
    if (o.hits > 0) {
      ctx.fillStyle = 'rgba(255,180,60,' + (0.25 * o.hits) + ')';
      ctx.beginPath(); ctx.arc(o.x, o.y, 4 + o.hits * 2, 0, TAU); ctx.fill();
    }
  } else if (o.type === 'tree') {
    /* тут лише стовбур; крона — окремим верхнім шаром */
    shadow(o.x, o.y, o.r, o.r * 0.8);
    ctx.fillStyle = '#4a3520';
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2e2113'; ctx.lineWidth = 2; ctx.stroke();
  }
}
function crateCracks(o) {
  ctx.strokeStyle = 'rgba(20,12,4,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(o.x - o.hw * 0.6, o.y - o.hh * 0.5);
  ctx.lineTo(o.x + o.hw * 0.2, o.y + o.hh * 0.3);
  if (o.hp < 45) { ctx.moveTo(o.x + o.hw * 0.55, o.y - o.hh * 0.6); ctx.lineTo(o.x - o.hw * 0.1, o.y + o.hh * 0.6); }
  ctx.stroke();
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.rect(x, y, w, h);
}

function drawMedkit(k) {
  if (k.taken) return;
  /* пульс, щоб читалась як лут */
  const pulse = 1 + Math.sin(perfNow * 0.004) * 0.07;
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.5)';
  ctx.shadowBlur = 10;
  if (!drawSpr('medkit', k.x, k.y, 28 * pulse, 28 * pulse, 0, 1)) {
    ctx.fillStyle = '#e8e6e0';
    roundRect(k.x - 12 * pulse, k.y - 9 * pulse, 24 * pulse, 18 * pulse, 4);
    ctx.fill();
    ctx.fillStyle = '#d02020';
    ctx.fillRect(k.x - 2.5, k.y - 6, 5, 12);
    ctx.fillRect(k.x - 6, k.y - 2.5, 12, 5);
  }
  ctx.restore();
}

function drawDead(p) {
  ctx.save();
  ctx.globalAlpha = 0.9;
  if (!drawSpr('dead', p.x, p.y, 46, 46, p.deadAng + Math.PI / 2, 1)) {
    ctx.translate(p.x, p.y);
    ctx.rotate(p.deadAng);
    ctx.fillStyle = '#3c3c40';
    ctx.beginPath(); ctx.ellipse(0, 0, 17, 9, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#2c2c30';
    ctx.beginPath(); ctx.arc(10, 0, 6, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawGrenade(g) {
  const t = clamp(g.t, 0, 1);
  const x = lerp(g.sx, g.tx, t), y = lerp(g.sy, g.ty, t);
  const lift = Math.sin(t * Math.PI) * 26;    // дуга польоту
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(x, y + 4, 5, 3, 0, 0, TAU); ctx.fill();
  /* молотов/смок мають власний силует — спрайт гранати лише для frag */
  const special = g.kind === 'molotov' || g.kind === 'smoke';
  if (special || !drawSpr('grenade', x, y - lift, 14, 14, t * 9, 1)) {
    ctx.fillStyle = g.kind === 'molotov' ? '#7a4a1f' : (g.kind === 'smoke' ? '#7d838c' : '#3e4a2e');
    ctx.beginPath(); ctx.arc(x, y - lift, 5, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#1c220f'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}
/* 2D-фолбек зон: вогонь — мерехтливе помаранчеве коло, дим — сіре, щоб нічого не ламалось без WebGL */
function drawFires2D() {
  for (let i = 0; i < fires.length; i++) {
    const f = fires[i];
    const flick = 0.75 + Math.sin(perfNow * 0.02 + i * 2.1) * 0.25;
    const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r);
    g.addColorStop(0, 'rgba(255,190,90,' + (0.5 * flick).toFixed(3) + ')');
    g.addColorStop(0.65, 'rgba(255,110,30,' + (0.32 * flick).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,60,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, TAU); ctx.fill();
  }
}
function drawSmokes2D() {
  for (let i = 0; i < smokes.length; i++) {
    const s = smokes[i];
    const ease = Math.min(1, (perfNow - s.born) / 900) * Math.min(1, (s.until - perfNow) / 1400);
    ctx.globalAlpha = 0.85 * clamp(ease, 0, 1);
    ctx.fillStyle = '#9aa0a2';
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawPlayer(p) {
  const inBush = !!p.bush;
  ctx.save();
  if (inBush) ctx.globalAlpha = 0.55;          // глядач бачить, вороги — ні
  shadow(p.x, p.y, PR * 0.9, PR * 0.6);
  /* ідентифікаційне кільце кольору гравця */
  ctx.strokeStyle = p.color;
  ctx.lineWidth = 3;
  ctx.globalAlpha *= 0.95;
  ctx.beginPath(); ctx.arc(p.x, p.y, PR + 4, 0, TAU); ctx.stroke();
  ctx.globalAlpha = inBush ? 0.55 : 1;
  /* спрайт: кут 0 на картинці = «дивиться вгору», тому + PI/2 */
  const bob = 1 + Math.sin(p.walk) * 0.02;
  if (!drawSpr('soldier', p.x, p.y, 46 * bob, 46 * bob, p.aim + Math.PI / 2, 1)) {
    ctx.translate(p.x, p.y);
    ctx.rotate(p.aim);
    ctx.fillStyle = '#585a60';
    ctx.beginPath(); ctx.arc(0, 0, PR - 2, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#2a2b2e'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#26272a';
    ctx.fillRect(6, -2.5, 24, 5);              // «зброя» вперед
    ctx.fillStyle = '#43454a';
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, TAU); ctx.fill();
    ctx.rotate(-p.aim);
    ctx.translate(-p.x, -p.y);
  }
  ctx.restore();
  /* спалах пострілу */
  if (perfNow - p.lastShotAt < 50) {
    const mx = p.x + Math.cos(p.aim) * (PR + 12), my = p.y + Math.sin(p.aim) * (PR + 12);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(mx, my, 0, mx, my, 14);
    g.addColorStop(0, 'rgba(255,240,180,0.95)');
    g.addColorStop(1, 'rgba(255,150,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(mx, my, 14, 0, TAU); ctx.fill();
    ctx.restore();
  }
  /* кільця прогресу: перезарядка (жовте) / лікування (зелене) */
  let prog = -1, pc = '#ffd93d';
  if (p.reloading) prog = (perfNow - p.reloadT0) / GUN.reload;
  else if (p.healUntil) { prog = 1 - (p.healUntil - perfNow) / 2000; pc = '#a0ff4a'; }
  if (prog >= 0) {
    ctx.strokeStyle = pc;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, PR + 9, -Math.PI / 2, -Math.PI / 2 + clamp(prog, 0, 1) * TAU); ctx.stroke();
  }
  /* білий зблиск при щойно отриманому уроні */
  if (perfNow - p.lastHurtAt < 110) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.arc(p.x, p.y, PR + 2, 0, TAU); ctx.fill();
  }
}

/* нік + смужки HP/броні — в ЕКРАННИХ координатах, щоб читались на будь-якому зумі */
function drawLabels() {
  const z = cam.z;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.alive) continue;
    const sx = (p.x - cam.x) * z + vw / 2;
    const sy = (p.y - cam.y) * z + vh / 2;
    if (sx < -60 || sx > vw + 60 || sy < -60 || sy > vh + 60) continue;
    const top = sy - (PR + 12) * z;
    /* нік */
    ctx.font = '700 12px ' + "'Roboto Mono', monospace";
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(p.nick, sx, top - 12);
    ctx.fillStyle = '#f2f2f4';
    ctx.fillText(p.nick, sx, top - 12);
    /* смужка HP кольору гравця + тонка смужка броні */
    const bw = 42, bh = 5;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(sx - bw / 2 - 1, top - 8 - 1, bw + 2, bh + 2);
    ctx.fillStyle = p.color;
    ctx.fillRect(sx - bw / 2, top - 8, bw * clamp(p.hp / p.maxHP, 0, 1), bh);
    if (p.armor > 0) {
      ctx.fillStyle = '#c9d4e4';
      ctx.fillRect(sx - bw / 2, top - 11, bw * clamp(p.armor / 50, 0, 1), 2);
    }
  }
  ctx.restore();
}

function render() {
  if (!ctx) return;
  const z = cam.z;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, vw, vh);
  const shX = cam.shake ? (frnd() * 2 - 1) * cam.shake : 0;
  const shY = cam.shake ? (frnd() * 2 - 1) * cam.shake : 0;
  ctx.save();
  ctx.translate(vw / 2 + shX, vh / 2 + shY);
  ctx.scale(z, z);
  ctx.translate(-cam.x, -cam.y);
  const vL = cam.x - vw / 2 / z - 80, vR = cam.x + vw / 2 / z + 80;
  const vT = cam.y - vh / 2 / z - 80, vB = cam.y + vh / 2 / z + 80;
  /* 1. Земля: arena.png (cover) або згенерована текстура */
  const bg = spr('arena');
  if (bg) {
    const s = Math.max(W / bg.naturalWidth, H / bg.naturalHeight);
    const dw = bg.naturalWidth * s, dh = bg.naturalHeight * s;
    ctx.drawImage(bg, W / 2 - dw / 2, H / 2 - dh / 2, dw, dh);
  } else {
    if (!groundPat) groundPat = buildGroundPat();
    ctx.fillStyle = groundPat;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1, 1, W - 2, H - 2);
  }
  /* 2. Декалі (кров/кіптява) */
  if (ground) ctx.drawImage(ground, 0, 0);
  /* 3. Лут і трупи — лежать на землі */
  for (let i = 0; i < medkits.length; i++) drawMedkit(medkits[i]);
  drawFires2D();   // калюжі вогню лежать на землі — під бійцями
  for (let i = 0; i < players.length; i++) if (!players[i].alive) drawDead(players[i]);
  /* 4. Перешкоди + живі гравці + гранати, відсортовані по Y (псевдоглибина) */
  rList.length = 0;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (!o.alive || o.type === 'bush') continue;   // кущі — верхнім шаром
    if (o.x > vL - 90 && o.x < vR + 90 && o.y > vT - 90 && o.y < vB + 90) rList.push(o);
  }
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p.alive && p.x > vL && p.x < vR && p.y > vT && p.y < vB) rList.push(p);
  }
  for (let i = 0; i < grenades.length; i++) rList.push(grenades[i]);
  rList.sort(byY);
  for (let i = 0; i < rList.length; i++) {
    const it = rList[i];
    if (it.nick !== undefined) drawPlayer(it);
    else if (it.dur !== undefined) drawGrenade(it);
    else drawObstacle(it);
  }
  drawFx(vL, vR, vT, vB);
  /* 5. Кущі й крони дерев — накривають гравців */
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (!o.alive) continue;
    if (o.type === 'bush') {
      if (!drawSpr('bush', o.x, o.y, o.r * 2.4, o.r * 2.4, 0, 0.92)) {
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = '#37502a';
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
        ctx.fillStyle = '#425f31';
        ctx.beginPath(); ctx.arc(o.x - 8, o.y - 7, o.r * 0.6, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      }
    } else if (o.type === 'tree') {
      if (!drawSpr('tree', o.x, o.y, o.crown * 2, o.crown * 2, 0, 0.88)) {
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = '#2e4722';
        ctx.beginPath(); ctx.arc(o.x, o.y, o.crown, 0, TAU); ctx.fill();
        ctx.fillStyle = '#3a5a2a';
        ctx.beginPath(); ctx.arc(o.x - o.crown * 0.2, o.y - o.crown * 0.2, o.crown * 0.62, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
  drawSmokes2D();   // завіса накриває бійців — глядач теж «не бачить» крізь дим
  drawZone(vL, vR, vT, vB);
  ctx.restore();
  drawLabels();
  /* віньєтка — кінематографічність */
  const vg = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.45, vw / 2, vh / 2, Math.max(vw, vh) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, vw, vh);
  updateHud();
}
const rList = [];
function byY(a, b) { return (a.nick !== undefined ? a.y : (a.dur !== undefined ? a.sy : a.y)) - (b.nick !== undefined ? b.y : (b.dur !== undefined ? b.sy : b.y)); }

/* кулі, частинки, вибухи, флоат-текст — у світових координатах */
function drawFx(vL, vR, vT, vB) {
  /* трасери — адитивно, щоб світились */
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (b.x < vL || b.x > vR || b.y < vT || b.y > vB) continue;
    const d = hyp(b.vx, b.vy) || 1;
    const tx = b.x - b.vx / d * 26, ty = b.y - b.vy / d * 26;
    const g = ctx.createLinearGradient(tx, ty, b.x, b.y);
    g.addColorStop(0, 'rgba(255,200,110,0)');
    g.addColorStop(1, 'rgba(255,225,150,0.9)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  /* іскри та спалахи */
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on || p.type === 3 || p.type === 2 || p.type === 4) continue;
    if (p.x < vL || p.x > vR || p.y < vT || p.y > vB) continue;
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  /* вибухи: спалах + ударна хвиля */
  for (let i = 0; i < explosions.length; i++) {
    const e = explosions[i];
    const t = e.t / e.max;
    const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * (0.4 + t * 0.8));
    g.addColorStop(0, 'rgba(255,235,180,' + (0.9 * (1 - t)) + ')');
    g.addColorStop(0.4, 'rgba(255,150,50,' + (0.55 * (1 - t)) + ')');
    g.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + t * 0.8), 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,220,170,' + (0.7 * (1 - t)) + ')';
    ctx.lineWidth = 3 * (1 - t) + 0.5;
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r * t, 0, TAU); ctx.stroke();
  }
  ctx.restore();
  /* кров, тріски, дим — звичайне накладання */
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on || p.type === 1) continue;
    if (p.x < vL || p.x > vR || p.y < vT || p.y > vB) continue;
    const a = clamp(p.life / p.max, 0, 1);
    if (p.type === 3) {
      ctx.globalAlpha = a * 0.35;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
    } else {
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;
  /* дрібний флоат-текст урону */
  ctx.textAlign = 'center';
  for (let i = 0; i < FMAX; i++) {
    const f = floats[i];
    if (!f.on) continue;
    ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
    ctx.font = '700 ' + f.size + "px 'Roboto Mono', monospace";
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

/* зона: червона заливка зовні + кільце; наступне коло — пунктиром */
function drawZone(vL, vR, vT, vB) {
  if (!zone) return;
  const z = zone;
  ctx.fillStyle = 'rgba(255,69,58,0.10)';
  ctx.beginPath();
  ctx.rect(vL, vT, vR - vL, vB - vT);
  ctx.arc(z.cx, z.cy, z.r, 0, TAU, true);
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(255,69,58,0.85)';
  ctx.lineWidth = 3 / cam.z;
  ctx.shadowColor = 'rgba(255,69,58,0.8)';
  ctx.shadowBlur = 16;
  ctx.beginPath(); ctx.arc(z.cx, z.cy, z.r, 0, TAU); ctx.stroke();
  ctx.shadowBlur = 0;
  if (z.tr < z.r - 2) {
    ctx.setLineDash([12, 9]);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.6 / cam.z;
    ctx.beginPath(); ctx.arc(z.tcx, z.tcy, z.tr, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* ── HUD (DOM поверх canvas; оновлюємо тільки при зміні) ── */
function setText(id, txt) {
  const el = document.getElementById(id);
  if (el && el.textContent !== txt) el.textContent = txt;
}
/* Іконки кіллфіда (інлайн-SVG, білий силует АК з прикладом і магазином):
   рядки будуються рідко (kfDirty), тому конкатенація рядків тут дешева */
const KF_GUN = '<svg class="so-kf-gun" viewBox="0 0 68 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="currentColor" d="M2 8.4 L7 7.2 L13 7.2 L13 6 L19 6 L19 7.2 L40.5 7.2 ' +
  'L40.5 4.6 L42.6 4.6 L42.6 7.2 L49 7.2 L49 9 L67 9 L67 11.4 L54 11.4 L54 12.6 L49 12.6 ' +
  'L47 14.8 L36.4 14.8 C35.2 19.6 31 22.2 27.6 21.4 L30.8 14.8 L25.2 14.8 L23 19.4 L19.4 19.4 ' +
  'L21.4 14.2 L14 13.4 L4.4 13.4 L2 12 Z"/></svg>';
const KF_HEAD = '<span class="so-kf-head">⦿</span>';
const KF_BOOM = '<span class="so-kf-x">💥</span>';
const KF_SKULL = '<span class="so-kf-x">☠</span>';
function updateHud() {
  const now = perfNow;
  /* countdown — щокадрово (дешево, лише порівняння рядка) */
  let cd = '';
  if (now < goAt) {
    const n = Math.ceil((goAt - now) / 1000);
    cd = n > 3 ? '' : String(n);
  } else if (now < goAt + 800) cd = 'БОЙ!';
  if (cd !== cdTxt) {
    cdTxt = cd;
    const el = document.getElementById('so-countdown');
    if (el) { el.textContent = cd; el.classList.toggle('show', !!cd); }
  }
  if (now - hudAt < 120) return;
  hudAt = now;
  let aliveN = 0;
  for (let i = 0; i < players.length; i++) if (players[i].alive) aliveN++;
  const at = String(aliveN);
  if (at !== aliveTxt) { aliveTxt = at; setText('so-alive', at); }
  /* зона: фаза + таймер до наступного звуження */
  let zt;
  const zEl = document.getElementById('so-zone-box');
  let danger = false;
  if (!zone || now < goAt) zt = '—';
  else if (zone.shrinkUntil > now) { zt = 'ИДЁТ'; danger = true; }
  else {
    const left = Math.max(0, Math.ceil((zone.nextAt - now) / 1000));
    zt = '0:' + (left < 10 ? '0' : '') + left;
  }
  if (zt !== zoneTxt) {
    zoneTxt = zt;
    setText('so-zone-timer', zt);
    setText('so-zone-lbl', zone && zone.phaseN > 0 ? 'ЗОНА ' + zone.phaseN : 'ЗОНА');
  }
  if (zEl) zEl.classList.toggle('so-danger', danger);
  /* кіллфід: «вбивця [іконка зброї] жертва», кольори гравців — як у PUBG */
  if (kfDirty) {
    kfDirty = false;
    const el = document.getElementById('so-killfeed');
    if (el) {
      let html = '';
      for (let i = killfeed.length - 1; i >= 0; i--) {
        const k = killfeed[i];
        const icon = k.gun ? ((k.head ? KF_HEAD : '') + KF_GUN) : (k.boom ? KF_BOOM : KF_SKULL);
        html += '<div class="so-kf-row"><span class="so-kf-n" style="color:' + k.kc + '">' + esc(k.k) +
          '</span>' + icon + '<span class="so-kf-n" style="color:' + k.vc + '">' + esc(k.v) + '</span></div>';
      }
      el.innerHTML = html;
    }
  }
  /* нижня панель «гравець у кадрі»: DOM чіпаємо лише при зміні ключа */
  const fk = focusP
    ? (focusP.idx + '|' + ((focusP.hp + 0.5) | 0) + '|' + focusP.kills + '|' + (focusP.alive ? 1 : 0))
    : '';
  if (fk !== focusKey) {
    focusKey = fk;
    const box = document.getElementById('so-focus');
    if (box) {
      /* під вінер-скріном панель гравця не потрібна: вона накривала нижню
         половину кнопки «Закрыть» — глядач цілився в неї і не влучав */
      if (!focusP || winnerShown) box.classList.remove('show');
      else {
        box.classList.add('show');
        const hp = clamp(Math.round(focusP.hp), 0, 100);
        setText('so-focus-nick', focusP.nick);
        setText('so-focus-hptxt', hp + '/100');
        setText('so-focus-kills', String(focusP.kills));
        const num = document.getElementById('so-focus-num');
        if (num) { num.textContent = String(focusP.idx + 1); num.style.background = focusP.color; }
        const fill = document.getElementById('so-focus-hp');
        if (fill) { fill.style.width = hp + '%'; fill.style.background = focusP.color; }
      }
    }
  }
}
function updOverviewBtn() {
  const b = document.getElementById('so-overview-btn');
  if (!b) return;
  /* «Вид» прибрано: кнопка існує лише як «К бою» — вивести камеру з
     огляду; поза overview вона прихована (панель: ◀ ▶, Полёт, К бою) */
  b.textContent = '⚔ К бою';
  b.style.display = camMode === 'overview' ? '' : 'none';
}
function updFlyBtn() {
  const b = document.getElementById('so-fly-btn');
  if (b) b.classList.toggle('so-on', fly.on);
}

/* ── Вільний політ: старт/стоп/кадр ── */
let flyHintTimer = 0;
function showFlyHint() {
  const el = document.getElementById('so-flyhint');
  if (!el) return;
  el.classList.add('show');
  if (flyHintTimer) clearTimeout(flyHintTimer);
  flyHintTimer = setTimeout(function () { el.classList.remove('show'); flyHintTimer = 0; }, 4000);
}
function flyRequestLock() {
  /* pointer lock може впасти (прихована вкладка, політика браузера) —
     тоді працює drag-look фолбек, режим від цього не залежить */
  if (!cv || document.pointerLockElement === cv) return;
  try {
    const r = cv.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(function () {});
  } catch (e) {}
}
function flyStart() {
  if (!USE_3D || !T3) return;
  /* відрив із поточної позиції камери: нуль швидкості = плавний старт без ривка */
  fly.px = T3.cpos.x + W2; fly.py = T3.cpos.y; fly.pz = T3.cpos.z + H2;
  const dx = T3.clook.x - T3.cpos.x, dy = T3.clook.y - T3.cpos.y, dz = T3.clook.z - T3.cpos.z;
  fly.yaw = Math.atan2(dz, dx);
  fly.pitch = clamp(Math.atan2(dy, hyp(dx, dz) || 1e-4), -FLY_PITCH_MAX, FLY_PITCH_MAX);
  fly.vx = 0; fly.vy = 0; fly.vz = 0; fly.speedMul = 1;
  fly.kW = false; fly.kA = false; fly.kS = false; fly.kD = false;
  fly.kUp = false; fly.kDn = false; fly.kBoost = false; fly.drag = false;
  fly.on = true;
  camMode = 'fly'; manualUntil = 0;
  flyRequestLock();
  showFlyHint();
  updFlyBtn(); updOverviewBtn();
}
function flyStop(toAuto) {
  fly.on = false; fly.drag = false;
  if (toAuto) { camMode = 'auto'; manualUntil = 0; }
  /* мишу віддаємо БЕЗУМОВНО (навіть якщо режим уже вимкнено): захоплений
     курсор, що пережив бій, зникав у користувача на всьому сайті */
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
  updFlyBtn(); updOverviewBtn();
}
function flyLook(mx, my) {
  fly.yaw += mx * 0.0022;
  fly.pitch = clamp(fly.pitch - my * 0.0022, -FLY_PITCH_MAX, FLY_PITCH_MAX);
}
/* true → клавіша належить польоту (хоткеї камер ◀▶/V не зачіпаємо) */
function flyKey(code, down) {
  switch (code) {
    case 'KeyW': fly.kW = down; return true;
    case 'KeyA': fly.kA = down; return true;
    case 'KeyS': fly.kS = down; return true;
    case 'KeyD': fly.kD = down; return true;
    case 'Space': fly.kUp = down; return true;
    case 'KeyC': case 'ControlLeft': case 'ControlRight': fly.kDn = down; return true;
    case 'ShiftLeft': case 'ShiftRight': fly.kBoost = down; return true;
  }
  return false;
}
function flyUpdate(dt) {
  const spd = 260 * fly.speedMul * (fly.kBoost ? 2.6 : 1);
  const cp = Math.cos(fly.pitch), sp = Math.sin(fly.pitch);
  const cy = Math.cos(fly.yaw), sy = Math.sin(fly.yaw);
  /* noclip: W/S уздовж погляду (з вертикаллю), A/D — горизонтальний стрейф */
  let tx = 0, ty = 0, tz = 0;
  if (fly.kW) { tx += cp * cy; ty += sp; tz += cp * sy; }
  if (fly.kS) { tx -= cp * cy; ty -= sp; tz -= cp * sy; }
  if (fly.kA) { tx += sy; tz -= cy; }
  if (fly.kD) { tx -= sy; tz += cy; }
  if (fly.kUp) ty += 1;
  if (fly.kDn) ty -= 1;
  const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const s = len > 1e-4 ? spd / len : 0;
  const k = 1 - Math.exp(-dt * 8);   // плавний розгін/гальмування
  fly.vx += (tx * s - fly.vx) * k;
  fly.vy += (ty * s - fly.vy) * k;
  fly.vz += (tz * s - fly.vz) * k;
  fly.px += fly.vx * dt; fly.py += fly.vy * dt; fly.pz += fly.vz * dt;
  /* межі домальованого світу; під рельєф не пірнаємо */
  fly.px = clamp(fly.px, -TERRA_EXT + 40, W + TERRA_EXT - 40);
  fly.pz = clamp(fly.pz, -TERRA_EXT + 40, H + TERRA_EXT - 40);
  fly.py = Math.max(fly.py, heightAt(fly.px, fly.pz) + 6);
  /* стеля мʼяка: старт з високого overview (~1500) плавно осідає до 900, без ривка */
  if (fly.py > 900) fly.py += (900 - fly.py) * Math.min(1, dt * 2);
}

/* ══════════════════════════════════════════════════════════════
   3D-РЕНДЕР (Three.js r128) — low-poly, настрій PUBG.
   ТУТ НЕМАЄ ІГРОВОЇ ЛОГІКИ: щокадру читаємо готовий стан
   (players, obstacles, bullets, grenades, medkits, zone, cam*)
   і синхронізуємо Three.js-сцену. Старий 2D render() лишається
   фолбеком, якщо THREE не завантажився або WebGL недоступний.
   ══════════════════════════════════════════════════════════════ */
let USE_3D = false;
let t3Renderer = null;   // живе весь час сторінки: WebGL-контекст канваса не можна «повернути» назад у 2D
let T3A = null;          // спільні ресурси (геометрії/матеріали/текстури) — створюються один раз
let T3 = null;           // сцена конкретного бою; перебудовується у build3D(), чиститься в dispose3D()
let groundDirty3D = true;
const W2 = W / 2, H2 = H / 2;
const TR3N = 40, SM3N = 36, EX3N = 6, GR3N = 6;   // розміри пулів (жодних алокацій у кадрі)
const FI3N = 3, SK3N = 3;   // одночасні калюжі вогню / димові завіси у 3D
const FTON = 8, SPUF = 9;   // язиків полум'я на калюжу / спрайтів на хмару диму

/* ── Палітра сухого степу (лоуполі-земля): бруд / суха трава / пісок.
   Тони близькі й теплі — плями читаються, але не рябить під фасетками. */
/* тони приглушені й зведені близько: насичена оливка з overview рябіла
   «камуфляжем» — тепер глибокі спокійні хакі, бруд і трава майже тон-у-тон,
   пісок лише трохи світліший (м'які проплішини, не плями) */
const TERRA_DIRT = '#6e6247', TERRA_GRASS = '#68704a', TERRA_SAND = '#94875f';
const TERRA_FAR = '#786f4e';   // базовий тон дальньої землі — між травою і піском

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch (e) { return false; }
}

/* Матеріал з текстурою, якої може ще НЕ БУТИ на диску (генерується паралельно):
   стартуємо з плоского кольору; коли файл довантажиться — підміняємо мапу.
   onError мовчазний — рендер ніколи не падає через відсутню картинку. */
function t3Mat(url, fallback, opts) {
  opts = opts || {};
  const m = new THREE.MeshLambertMaterial({ color: fallback });
  if (opts.side != null) m.side = opts.side;
  if (opts.alphaTest) { m.alphaTest = opts.alphaTest; m.transparent = true; }
  T3A.loader.load(url, function (t) {
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = 4;
    m.map = t; m.color.set('#ffffff'); m.needsUpdate = true;
  }, undefined, function () { /* файла нема — лишаємось на кольорі */ });
  return m;
}
/* Текстура «енергетичної стіни» зони: вертикальний альфа-градієнт (щільно
   біля землі, тане догори) + гаряча смуга при основі + вертикальні світлові
   струмені — їх повільний офсет-скрол по колу оживляє стіну в рендер-лупі.
   Верх канваса = верх стіни (flipY CanvasTexture). Основа циліндра пірнає
   під рельєф (−23…+107), тож «гаряча» зона розтягнута на висоти 0…26. */
function makeZoneWallTex3() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0.00, 'rgba(255,150,60,0)');
  gr.addColorStop(0.40, 'rgba(255,150,58,0.14)');
  gr.addColorStop(0.60, 'rgba(255,148,55,0.32)');
  gr.addColorStop(0.72, 'rgba(255,155,60,0.52)');
  gr.addColorStop(0.79, 'rgba(255,216,124,0.95)');   // світна лінія при землі
  gr.addColorStop(0.85, 'rgba(255,190,90,0.66)');
  gr.addColorStop(1.00, 'rgba(255,160,66,0.45)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 256);
  /* струмені енергії: яскравішають донизу, дрейфують разом із offset.x */
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 9; i++) {
    const x = (i * 41 + 13) % 128, w = 3 + (i * 7) % 5;
    const sg = g.createLinearGradient(0, 70, 0, 240);
    sg.addColorStop(0, 'rgba(255,190,100,0)');
    sg.addColorStop(1, 'rgba(255,200,110,0.3)');
    g.fillStyle = sg; g.fillRect(x, 0, w, 256);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(5, 1);
  return t;
}
function makeRadialTex3(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* Спільні ресурси: створюються один раз на життя сторінки, не диспозяться —
   бої повторюються, а текстури перевикористовуються. */
function ensureAssets3D() {
  if (T3A) return;
  T3A = { loader: new THREE.TextureLoader(), camoTex: null, camoClones: [], geo: {}, mat: {} };
  const G = T3A.geo, M = T3A.mat;
  /* одиничні геометрії — все масштабується scale-ом конкретного меша */
  G.box = new THREE.BoxGeometry(1, 1, 1);
  G.boxTop = new THREE.BoxGeometry(1, 1, 1); G.boxTop.translate(0, -0.5, 0);   // півот угорі — для ніг
  G.cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
  G.sphere = new THREE.SphereGeometry(1, 12, 10);
  G.helmet = new THREE.SphereGeometry(1, 12, 8, 0, TAU, 0, Math.PI / 2);
  G.ring = new THREE.RingGeometry(0.82, 1, 32); G.ring.rotateX(-Math.PI / 2);
  G.plane = new THREE.PlaneGeometry(1, 1);
  G.groundPlane = new THREE.PlaneGeometry(W, H); G.groundPlane.rotateX(-Math.PI / 2);
  /* «земля-продовження» довкола арени: щоб за краєм не було білого обрізу */
  G.farGround = new THREE.PlaneGeometry(6000, 4000); G.farGround.rotateX(-Math.PI / 2);
  G.zoneCyl = new THREE.CylinderGeometry(1, 1, 130, 72, 1, true);
  /* базове кільце стіни: тонка світна лінія по колу при землі */
  G.zoneBase = new THREE.RingGeometry(0.985, 1.008, 96); G.zoneBase.rotateX(-Math.PI / 2);
  G.zoneTint = new THREE.RingGeometry(1, 3.2, 72); G.zoneTint.rotateX(-Math.PI / 2);
  G.zoneNext = new THREE.RingGeometry(0.975, 1, 72); G.zoneNext.rotateX(-Math.PI / 2);
  G.sky = new THREE.SphereGeometry(3000, 24, 12);
  /* матеріали з текстурами (шляхи фіксовані; нема файла — плоский колір) */
  /* земля: лоуполі-фасетки з vertex-кольорами (жодних картинок — розмита
     arena.png мила пагорби; фасетки різкі на будь-якому зумі). Нормалі «на
     трикутник» дає non-indexed геометрія у build3D, кольори — paintGround3D */
  M.ground = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  /* дальня земля: базовий тон тієї ж палітри, тане в серпанку FogExp2 */
  M.farGround = new THREE.MeshLambertMaterial({ color: TERRA_FAR });
  M.farGround.color.convertSRGBToLinear();   // та сама причина, що й у paintGround3D
  const crS = t3Mat('/assets/pubg3d/crate-side.png', '#8a6a3f');
  const crT = t3Mat('/assets/pubg/crate.png', '#9a7748');
  M.crate = [crS, crS, crT, crS, crS, crS];               // [+x,-x,верх,низ,+z,-z]
  const brS = t3Mat('/assets/pubg3d/barrel-side.png', '#a32b24');
  const brT = t3Mat('/assets/pubg/barrel.png', '#7d1f1a');
  M.barrel = [brS, brT, brS];                             // [бік, кришка, дно]
  M.barrelDead = new THREE.MeshLambertMaterial({ color: '#1b1815' });
  M.sandbag = t3Mat('/assets/pubg3d/sandbag-side.png', '#7a6f4e');
  M.barrier = t3Mat('/assets/pubg3d/barrier-side.png', '#84878e');
  M.trunk = new THREE.MeshLambertMaterial({ color: '#4a3520' });
  M.tree = t3Mat('/assets/pubg3d/tree-side.png', '#2e4722', { alphaTest: 0.35, side: THREE.DoubleSide });
  M.bush = t3Mat('/assets/pubg3d/bush-side.png', '#37502a', { alphaTest: 0.35, side: THREE.DoubleSide });
  M.white = new THREE.MeshLambertMaterial({ color: '#e8e6e0' });
  const mkT = t3Mat('/assets/pubg/medkit.png', '#d8d6d0');
  M.medkit = [M.white, M.white, mkT, M.white, M.white, M.white];
  M.skin = new THREE.MeshLambertMaterial({ color: '#c9a184' });
  M.helmet = new THREE.MeshLambertMaterial({ color: '#2c2f33' });
  M.gun = new THREE.MeshLambertMaterial({ color: '#1f2023' });
  M.grenade = new THREE.MeshLambertMaterial({ color: '#3e4a2e' });
  M.tracer = new THREE.MeshBasicMaterial({ color: '#ffe2a0', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  /* стіна зони: additive — світиться в бурштиновій гамі сайту й НІКОЛИ не
     затуляє бійців за собою; opacity веде syncZone3D (фейд-поява + пульс) */
  T3A.zoneTex = makeZoneWallTex3();
  M.zone = new THREE.MeshBasicMaterial({ map: T3A.zoneTex, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  M.zoneTint = new THREE.MeshBasicMaterial({ color: '#ff7a36', transparent: true, opacity: 0.08, depthWrite: false });
  M.zoneBase = new THREE.MeshBasicMaterial({ color: '#ffd07a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  M.zoneNext = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false });
  /* стрілецька поза: постійний нахил хребта вперед + легкий доворот плеча
     (корпус на ціль розвертає grp.rotation.y, тут — лише «прицільна» постава) */
  T3A.spineQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.34, -0.18, 0));
  T3A.flashTex = makeRadialTex3('rgba(255,240,180,1)', 'rgba(255,150,40,0)');
  T3A.smokeTex = makeRadialTex3('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
  M.flash = new THREE.SpriteMaterial({ map: T3A.flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  /* небо: вертикальний градієнт (велика сфера BackSide) — фон + серпанок FogExp2 в тон */
  const sc = document.createElement('canvas'); sc.width = 2; sc.height = 256;
  const sg = sc.getContext('2d');
  const lin = sg.createLinearGradient(0, 0, 0, 256);
  lin.addColorStop(0, '#7e96b6'); lin.addColorStop(0.62, '#b9b8a6'); lin.addColorStop(1, '#cfc7ae');
  sg.fillStyle = lin; sg.fillRect(0, 0, 2, 256);
  T3A.skyTex = new THREE.CanvasTexture(sc);
  M.sky = new THREE.MeshBasicMaterial({ map: T3A.skyTex, side: THREE.BackSide, fog: false, depthWrite: false });
  /* камуфляж гравців: одна текстура, але персональні клони матеріалу
     (щоб фарбувати смерть/спалах урону не зачіпаючи інших) */
  T3A.loader.load('/assets/pubg3d/camo.png', function (t) {
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    T3A.camoTex = t;
    for (let i = 0; i < T3A.camoClones.length; i++) {
      const m = T3A.camoClones[i];
      if (m.userData.dead) continue;   // мрець лишається сірим
      m.map = t; m.color.set('#ffffff'); m.needsUpdate = true;
    }
  }, undefined, function () {});
  loadModels3D();   // GLB-моделі стартують вантажитись разом із рештою ассетів
}
function newCamoMat(playerColor) {
  // Fortnite-стиль: боєць у «скіні» свого кольору — глядач розрізняє
  // гравців з першого погляду; камуфляж-текстуру не використовуємо
  return new THREE.MeshLambertMaterial({ color: playerColor || '#5a6b4a' });
}

/* ══ GLB-моделі (low-poly) замість самопальних примітивів ══
   Кеш: один THREE.GLTFLoader, кожен файл вантажиться раз на життя сторінки.
   Поки модель не готова (чи впала мережа/парсер) — працює старий
   примітив-фолбек, НІЧОГО не ламається; після onLoad живі інстанси
   поточного бою підмінюються на льоту через swapIn3D(). */
const GLB = { loader: null, ready: {}, started: false };
function loadModel(path) {
  return new Promise(function (resolve, reject) {
    if (typeof THREE === 'undefined' || !THREE.GLTFLoader) { reject(new Error('GLTFLoader відсутній')); return; }
    if (!GLB.loader) GLB.loader = new THREE.GLTFLoader();
    GLB.loader.load(path, resolve, undefined, reject);
  });
}
/* нормалізація один раз на модель: габарити/півот, далі інстанси лише масштабуються */
function glbPrep(g) {
  const box = new THREE.Box3().setFromObject(g.scene);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  return { scene: g.scene, clips: g.animations || [], size: size, min: box.min.clone(), center: center };
}
function loadModels3D() {
  if (GLB.started) return;
  GLB.started = true;
  const defs = [
    /* adventurer — Quaternius Adventurer (той самий риг UAL): готові кліпи
       Idle_Gun / Idle_Gun_Shoot / Run / Run_Shoot / Death (вибір власника) */
    ['soldier',  '/assets/models/adventurer.glb'],
    ['revolver', '/assets/models/revolver.glb'],
    ['tree',     '/assets/models/tree.glb'],
    ['tree2',    '/assets/models/tree2.glb'],    // сосна — різноманіття лісу
    ['bush',     '/assets/models/bush.glb'],
    ['medkit',   '/assets/models/medkit.glb'],
    ['barrel',   '/assets/models/barrel.glb'],
    ['barrier',  '/assets/models/barrier.glb'],
    ['sandbags', '/assets/models/sandbags.glb'],
    ['crate',    '/assets/models/crate.glb'],    // Quaternius, poly.pizza/m/3OEFd1AWfa (CC0)
    /* декор арени (без колізій): камінці та кущики сухої трави */
    ['rock1',    '/assets/models/rock1.glb'],
    ['rock2',    '/assets/models/rock2.glb'],
    ['grass1',   '/assets/models/grass1.glb'],
  ];
  for (let i = 0; i < defs.length; i++) {
    (function (name, path) {
      loadModel(path).then(function (g) {
        GLB.ready[name] = glbPrep(g);
        if (T3) swapIn3D(name);   // бій уже йде — підмінюємо живі інстанси
      }).catch(function (e) {
        try { console.warn('[RSO] Модель ' + path + ' не завантажилась, лишаємо примітив:', e); } catch (_) {}
      });
    })(defs[i][0], defs[i][1]);
  }
}
/* статичний клон: геометрії/матеріали СПІЛЬНІ між клонами (дешево).
   shadows=false для дрібноти (бочки/кущі/аптечки/мішки/барʼєри) — кожен
   castShadow-меш дорогий у shadow-pass, а тінь від дрібноти не читається */
function glbStatic(rec, shadows) {
  const inst = rec.scene.clone(true);
  inst.traverse(function (m) { if (m.isMesh) m.castShadow = !!shadows; });
  return inst;
}
/* Заморозка статики: перешкоди після розстановки не рухаються, тож
   компонувати їхні локальні матриці щокадру — марна робота */
function onceUpdateMatrix(obj) {
  obj.traverse(function (n) { n.updateMatrix(); n.matrixAutoUpdate = false; });
}
/* Кожна фабрика повертає inst із локальним зсувом -min.y (щоб модель стояла
   НА землі навіть із півотом не в основі) та -center.x/z (центр по колізії).
   Обертання ставиться на holder ззовні — інакше зсув центрування
   «поїхав» би при повороті inst навколо власного origin. */
/* ~половина дерев — сосна tree2: за парністю id перешкоди (стабільно між
   кадрами і не зсуває ігровий RNG) */
function treeKeyOf(o) { return (o.id % 2) ? 'tree2' : 'tree'; }
function makeTree3D(o) {
  const rec = GLB.ready[treeKeyOf(o)];
  const inst = glbStatic(rec, true);
  /* масштаб від крони: стовбур-колізія (o.r) вузький, крона ширша — як у 2D */
  const s = (o.crown * 1.9) / Math.max(rec.size.x, rec.size.z, 0.001);
  inst.scale.setScalar(s);
  inst.position.set(-rec.center.x * s, -rec.min.y * s, -rec.center.z * s);
  return inst;
}
function makeBush3D(o) {
  const rec = GLB.ready.bush;
  const inst = glbStatic(rec, false);
  const s = (o.r * 2.2) / Math.max(rec.size.x, rec.size.z, 0.001);
  inst.scale.setScalar(s);
  inst.position.set(-rec.center.x * s, -rec.min.y * s, -rec.center.z * s);
  return inst;
}
/* бочка GLB: діаметр = колізія (2r), посадка на землю; тіней нема (дрібнота).
   Модель із poly.pizza — дерев'яна діжка, а бочка в нас ВИБУХОВА, тому
   тонуємо в червоний: глядач одразу читає «в це стріляти можна». */
let barrelRedMat = null;
function makeBarrel3D(o) {
  const rec = GLB.ready.barrel;
  const inst = glbStatic(rec, false);
  const s = (o.r * 2) / Math.max(rec.size.x, rec.size.z, 0.001);
  inst.scale.setScalar(s);
  inst.position.set(-rec.center.x * s, -rec.min.y * s, -rec.center.z * s);
  return inst;   // нова діжка текстурована — тонування не потрібне
}
/* барʼєр/мішки: масштаб від КОРОТКОЇ сторони колізії; якщо одна секція
   коротша за перешкоду — ставимо кілька уряд. Обертання лише на групах-
   обгортках, бо зсув центрування «поїхав» би при повороті inst. */
function makeRow3D(rec, o, stackTo) {
  const oL = Math.max(o.hw, o.hh) * 2, oS = Math.min(o.hw, o.hh) * 2;
  const mL = Math.max(rec.size.x, rec.size.z), mS = Math.min(rec.size.x, rec.size.z);
  let s = oS / Math.max(mS, 0.001);
  /* тонкі високі моделі (цегляна стіна) інакше виростають хмарочосами:
     висота секції не може перевищувати ~42 юніти (зріст бійця 44) */
  if (rec.size.y * s > 42) s = 42 / Math.max(rec.size.y, 0.001);
  const n = clamp(Math.round(oL / Math.max(mL * s, 1)), 1, 6);
  const grp = new THREE.Group();
  const step = oL / n;
  /* stackTo: цільова ВИСОТА стіни у світових юнітах — секції складаються
     поверхами (мішки по коліна не читались як укриття, хоч і блокували кулі) */
  const rowH = Math.max(rec.size.y * s, 1);
  const floors = stackTo ? clamp(Math.round(stackTo / rowH), 1, 4) : 1;
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < floors; f++) {
      const sec = new THREE.Group();
      const inst = glbStatic(rec, false);
      inst.scale.setScalar(s);
      inst.position.set(-rec.center.x * s, -rec.min.y * s, -rec.center.z * s);
      sec.add(inst);
      if (rec.size.z > rec.size.x) sec.rotation.y = Math.PI / 2;  // довга вісь моделі → локальний X
      sec.position.x = (i - (n - 1) / 2) * step + (f % 2 ? 2 : -2) * (floors > 1 ? 1 : 0);
      sec.position.y = f * rowH * 0.92;               // легкий нахлест рядів
      grp.add(sec);
    }
  }
  if (o.hh > o.hw) grp.rotation.y = Math.PI / 2;  // довга вісь X → довга вісь перешкоди
  return grp;
}
/* ящик: справжня GLB-модель (Quaternius) замість текстурованого бокса.
   Вписуємо в колізію hw/hh, висота капиться ~42 (зріст бійця 44) — масштаб
   один спільний (менший із трьох), щоб пропорції моделі не пливли */
function makeCrate3D(o) {
  const rec = GLB.ready.crate;
  const inst = glbStatic(rec, true);   // ящик великий — тінь від нього читається
  const s = Math.min((o.hw * 2) / Math.max(rec.size.x, 0.001),
                     (o.hh * 2) / Math.max(rec.size.z, 0.001),
                     42 / Math.max(rec.size.y, 0.001));
  inst.scale.setScalar(s);
  inst.position.set(-rec.center.x * s, -rec.min.y * s, -rec.center.z * s);
  return inst;
}
/* «випадковий» yaw 0/90/180/270 від id — стабільний між кадрами і не зсуває RNG */
function crateYaw(o) { return (o.id % 4) * (Math.PI / 2); }
function makeMedkit3D() {
  const rec = GLB.ready.medkit;
  const inst = glbStatic(rec, false);
  const s = 20 / Math.max(rec.size.x, rec.size.z, 0.001);   // ~20 юнітів по ширині
  inst.scale.setScalar(s);
  /* центр у півоті — syncPickups3D крутить/гойдає holder навколо центру */
  inst.position.set(-rec.center.x * s, -rec.center.y * s, -rec.center.z * s);
  return inst;
}
/* ── Лоуполі-фарбування землі: 2 масштаби value-noise вибирають тон із
   палітри TERRA_* (плями бруду/трави/піску), плюс дрібний пер-фасетковий
   джитер яскравості — фасетки «дихають», картинка-текстура не потрібна.
   Колір один на трикутник (3 однакові вершини non-indexed геометрії). */
function paintGround3D(geo) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  /* convertSRGBToLinear: рендерер на виході кодує в sRGB, тож «сирі» hex
     без конверсії виходили б вицвіло-білястими */
  const dirt = new THREE.Color(TERRA_DIRT).convertSRGBToLinear(),
        grass = new THREE.Color(TERRA_GRASS).convertSRGBToLinear(),
        sand = new THREE.Color(TERRA_SAND).convertSRGBToLinear();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3 + W2;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3 + H2;
    /* КРУПНІ плями бруд↔трава (низька частота — поле читається великими
       м'якими зонами, не рябить) + рідші піщані «проплішини» дрібнішим шумом */
    const n = vnoise(x * 0.0035 + 7.7, z * 0.0035 + 3.1);
    const m = vnoise(x * 0.014 + 41.2, z * 0.014 + 17.9);
    c.copy(dirt).lerp(grass, clamp((n - 0.28) / 0.44, 0, 1));
    if (m > 0.64) c.lerp(sand, clamp((m - 0.64) / 0.3, 0, 1) * 0.6);
    /* джитер на фасетку: детермінований від індексу трикутника; м'який —
       фасетки лише вгадуються, без «шахівниці» */
    const j = 1 + (terrHash(i, 977) - 0.5) * 0.09;
    const r = c.r * j, g = c.g * j, b = c.b * j;
    for (let q = 0; q < 3; q++) { const o = (i + q) * 3; col[o] = r; col[o + 1] = g; col[o + 2] = b; }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
/* ── Декор арени: детермінований розсів каменів (rock1/rock2) і кущиків
   сухої трави (grass1). Увесь рандом — від terrHash (сід рельєфу): БЕЗ
   Math.random/Date.now, тож та сама арена → той самий декор, і пізнє
   довантаження GLB нічого не зсуває. Це суто ВІЗУАЛЬНИЙ шар — у 2D-логіці
   колізій/LOS цих обʼєктів НЕМАЄ. */
function decorRnd(i, k) { return terrHash(i * 131 + k * 7, 9173 - i); }
function decorFree(x, y, m) {
  /* декор розсівається і ЗА межами арени (домальований світ до TERRA_EXT) */
  if (x < -TERRA_EXT + 60 || x > W + TERRA_EXT - 60 || y < -TERRA_EXT + 60 || y > H + TERRA_EXT - 60) return false;
  if (hyp(x - W / 2, y - H / 2) < 150) return false;   // центр — точка інтересу
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const r = o.shape === 'circle' ? Math.max(o.r, o.crown || 0) : Math.max(o.hw, o.hh);
    if (hyp(x - o.x, y - o.y) < r + m) return false;   // не впритул до укриттів
  }
  for (let i = 0; i < spawns.length; i++)
    if (hyp(x - spawns[i].x, y - spawns[i].y) < 70) return false;
  for (let i = 0; i < medkits.length; i++)
    if (hyp(x - medkits[i].x, y - medkits[i].y) < 55) return false;
  return true;
}
function planDecor3D() {
  const plan = { rock1: [], rock2: [], grass1: [], baked: {} };
  let idx = 0;
  const put = function (list, szMin, szSpan, margin, tries) {
    for (let t = 0; t < tries; t++) {
      idx++;
      const x = -TERRA_EXT + 60 + decorRnd(idx, 1) * (W + TERRA_EXT * 2 - 120);
      const y = -TERRA_EXT + 60 + decorRnd(idx, 2) * (H + TERRA_EXT * 2 - 120);
      if (!decorFree(x, y, margin)) continue;
      list.push({ x: x, y: y, rot: decorRnd(idx, 3) * TAU, size: szMin + decorRnd(idx, 4) * szSpan });
      return;
    }
  };
  /* площа з домальованим світом ~5x арени — кількість підтягнута під неї */
  for (let i = 0; i < 64; i++)
    put(decorRnd(i + 1, 9) < 0.5 ? plan.rock1 : plan.rock2, 6, 8, 26, 14);   // камені, 6-14 юнітів
  for (let i = 0; i < 170; i++)
    put(plan.grass1, 8, 4, 18, 10);                                          // кущики трави, 8-12 юнітів
  return plan;
}
/* Запікання декору: ОДИН merged-меш на матеріал замість 60 окремих нод
   (кущик grass1 — це 32 підмеші: клонами то були б тисячі draw-call-ів).
   Декор статичний, тож трансформи вершин рахуємо раз на CPU. */
function bakeDecor3D(name) {
  if (!T3 || !T3.decor || T3.decor.baked[name]) return;
  const rec = GLB.ready[name], places = T3.decor[name];
  if (!rec || !places || !places.length) return;
  T3.decor.baked[name] = true;
  rec.scene.updateMatrixWorld(true);
  const meshes = [];
  rec.scene.traverse(function (m) { if (m.isMesh) meshes.push(m); });
  /* grass1 — це ЦІЛА ГАЛЯВИНА з ~30 окремих кущиків, розкиданих по 176
     юнітах: вписувати її всю у 8-12 юнітів — отримати невидиму крапку.
     Тому для трави беремо ПО ОДНОМУ кущику (підмешу) на точку розсіву,
     кожен зі своїм власним bbox для центрування/посадки. */
  const single = name === 'grass1';
  const boxes = [];
  if (single) {
    for (let mi = 0; mi < meshes.length; mi++) {
      const b = new THREE.Box3().setFromObject(meshes[mi]);
      const sz = new THREE.Vector3(); b.getSize(sz);
      const c = new THREE.Vector3(); b.getCenter(c);
      boxes.push({ min: b.min, size: sz, center: c });
    }
  }
  const buckets = [];   // {mat, pos, norm, uv}
  const M4 = new THREE.Matrix4(), R4 = new THREE.Matrix4(), S4 = new THREE.Matrix4(),
        C4 = new THREE.Matrix4(), MM = new THREE.Matrix4(), N3 = new THREE.Matrix3();
  const v = new THREE.Vector3(), nv = new THREE.Vector3();
  const span = Math.max(rec.size.x, rec.size.z, 0.001);
  for (let pi = 0; pi < places.length; pi++) {
    const pl = places[pi];
    let use = meshes, s, cx, cz, my;
    if (single) {
      const mi = (terrHash(pi * 17 + 3, 4211) * meshes.length) | 0;
      use = [meshes[Math.min(mi, meshes.length - 1)]];
      const bx = boxes[Math.min(mi, meshes.length - 1)];
      s = pl.size / Math.max(bx.size.x, bx.size.y, bx.size.z, 0.001);
      cx = bx.center.x; cz = bx.center.z; my = bx.min.y;
    } else {
      s = pl.size / span;
      cx = rec.center.x; cz = rec.center.z; my = rec.min.y;
    }
    /* легке втоплення: фасетки рельєфу трохи відхиляються від heightAt між
       вершинами сітки — основа декору не повинна «висіти» над схилом */
    M4.makeTranslation(pl.x - W2, heightAt(pl.x, pl.y) - 1.4, pl.y - H2);
    R4.makeRotationY(pl.rot); S4.makeScale(s, s, s);
    C4.makeTranslation(-cx, -my, -cz);
    M4.multiply(R4).multiply(S4).multiply(C4);
    for (let mi = 0; mi < use.length; mi++) {
      const mesh = use[mi];
      MM.copy(M4).multiply(mesh.matrixWorld);
      N3.getNormalMatrix(MM);
      let bk = null;
      for (let b = 0; b < buckets.length; b++) if (buckets[b].mat === mesh.material) { bk = buckets[b]; break; }
      if (!bk) { bk = { mat: mesh.material, pos: [], norm: [], uv: [] }; buckets.push(bk); }
      const g = mesh.geometry, p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
      const ix = g.index, cnt = ix ? ix.count : p.count;
      for (let k = 0; k < cnt; k++) {
        const vi = ix ? ix.getX(k) : k;
        v.fromBufferAttribute(p, vi).applyMatrix4(MM);
        bk.pos.push(v.x, v.y, v.z);
        if (n) { nv.fromBufferAttribute(n, vi).applyMatrix3(N3).normalize(); bk.norm.push(nv.x, nv.y, nv.z); }
        if (u) bk.uv.push(u.getX(vi), u.getY(vi));
      }
    }
  }
  for (let b = 0; b < buckets.length; b++) {
    const bk = buckets[b];
    const g = reg3(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bk.pos), 3));
    if (bk.norm.length === bk.pos.length) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bk.norm), 3));
    if (bk.uv.length * 3 === bk.pos.length * 2) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bk.uv), 2));
    const mesh = new THREE.Mesh(g, bk.mat);
    mesh.castShadow = name !== 'grass1';   // тіні лише каменям: трава в shadow-pass дорога й не читається
    mesh.matrixAutoUpdate = false;
    T3.scene.add(mesh);
  }
}
/* ── Боєць: Quaternius Adventurer (риг UAL) — готові кліпи Idle_Gun /
   Idle_Gun_Shoot / Run / Run_Shoot / Death; револьвер у правій кисті ── */
const SOLDIER_H = 44;              // зріст у світових юнітах (гравець-коло r=16)
const SOLDIER_ROT = Math.PI / 2;   // Quaternius дивиться у +Z → «перед» рига +X
const CLIP_PREFIX = 'CharacterArmature|';
/* Хват револьвера: однорука зброя живе в кістці правої кисті ('Wrist.R';
   GLTFLoader санітизує крапки в іменах нод → перевіряємо і 'WristR') —
   у Gun-кліпах UAL права рука витягнута з пістолетом, тож кисть сама несе
   зброю через усі стани (Idle_Gun / Run_Shoot / Death) без пер-кліпових
   пресетів. Значення відкалібровано ВІЗУАЛЬНО (скріншоти айдлу/бігу/стрільби):
   вісь кістки кисті ≈ +Y уздовж передпліччя, тому ствол (+X групи зброї)
   довернутий до +Y, а руків'я лягає в долоню невеликим офсетом. */
const GUN_HAND_POS = [0, 2.2, 0.6];      // світові юніти в осях кістки Wrist.R
const GUN_HAND_EULER = [0, 0, 88];       // градуси, порядок XYZ; ствол = +X групи зброї
const REVOLVER_LEN = 14;                 // нормалізація: ~14 юнітів по довшій осі
function soldierClip(rec, name) {
  return THREE.AnimationClip.findByName(rec.clips, CLIP_PREFIX + name) ||
         THREE.AnimationClip.findByName(rec.clips, name);
}
function makeSoldier3D(p) {
  const rec = GLB.ready.soldier;
  const inst = THREE.SkeletonUtils.clone(rec.scene);   // скелет клонується коректно
  const s = SOLDIER_H / Math.max(rec.size.y, 0.001);
  inst.scale.setScalar(s);
  inst.position.y = -rec.min.y * s;
  inst.rotation.y = SOLDIER_ROT;
  const wrap = new THREE.Group();
  wrap.add(inst);
  const mats = [];
  let handBone = null, fallbackBone = null;
  inst.traverse(function (m) {
    if (m.isMesh) {
      m.castShadow = true;
      m.frustumCulled = false;   // скелетні меші «зникають» край кадру без цього
      m.material = reg3(m.material.clone());   // персональний матеріал під тонування
      /* Fortnite-скін: тіло/ноги/черевики/рюкзак у колір гравця, а голову
         (обличчя+волосся) НЕ фарбуємо — лице лишається читабельним; кольору
         на корпусі досить, щоб розрізняти гравців на будь-якому плані */
      if (m.name.indexOf('Head') === -1) m.material.color.set(p.color);
      mats.push(m.material);   // голова теж у tintMats: сіріє в трупа, блимає від урону
    } else if (m.isBone) {
      /* права кисть: у Gun-кліпах UAL вона витягнута з пістолетом */
      if (m.name === 'Wrist.R' || m.name === 'WristR') handBone = m;
      else if (m.name === 'Chest') fallbackBone = m;
    }
  });
  /* ── Револьвер (revolver.glb) у правій кисті. Кістка живе у масштабі
     рига, тому світові юніти перераховуємо через її world-scale. */
  let muzzle = null, gunGrp = null;
  if (!handBone) {
    // страховка: кисть не знайшли (інша версія рига) — зброя чіпляється до
    // грудей/кореня моделі, щоб боєць НІКОЛИ не був голоруч
    try { console.warn('[RSO] кістка кисті не знайдена — револьвер на тулубі'); } catch (_) {}
    handBone = fallbackBone;
    if (!handBone) {
      handBone = new THREE.Group();
      handBone.position.set(6 / Math.max(inst.scale.x, 1e-6), 28 / Math.max(inst.scale.x, 1e-6), 0);
      inst.add(handBone);
    }
  }
  {
    inst.updateMatrixWorld(true);
    const ws = new THREE.Vector3();
    handBone.getWorldScale(ws);
    const u = 1 / Math.max(ws.x, 1e-6);        // світові юніти → локальні юніти кістки
    const gun = new THREE.Group();
    const rvRec = GLB.ready.revolver;
    if (rvRec) {
      const rv = rvRec.scene.clone(true);
      /* нормалізуємо револьвер до ~REVOLVER_LEN світових юнітів по найдовшій
         осі; центр моделі — в (0,0,0) групи, руків'я підганяє GUN_HAND_POS */
      const L = Math.max(rvRec.size.x, rvRec.size.y, rvRec.size.z, 0.001);
      const k = REVOLVER_LEN / L;
      rv.scale.setScalar(k);
      const c = new THREE.Vector3();
      c.set((rvRec.min.x + rvRec.size.x / 2) * k, (rvRec.min.y + rvRec.size.y / 2) * k, (rvRec.min.z + rvRec.size.z / 2) * k);
      rv.position.sub(c);                       // центр моделі в (0,0,0) групи
      /* модель лежить стволом уздовж +X — це і є вісь стволу групи зброї */
      gun.add(rv);
    } else {
      /* фолбек: пістолет із боксів (стволом у +X), поки revolver.glb не доїхав */
      const barrel = new THREE.Mesh(T3A.geo.box, T3A.mat.gun);
      barrel.scale.set(9, 2.2, 1.8); barrel.position.set(3.5, 1, 0);
      const grip = new THREE.Mesh(T3A.geo.box, T3A.mat.gun);
      grip.scale.set(2.6, 5, 2); grip.position.set(-1.5, -2, 0);
      gun.add(barrel); gun.add(grip);
    }
    /* спалах пострілу — спрайт на кінці ствола (керується із syncPlayers3D) */
    muzzle = new THREE.Sprite(T3A.mat.flash);
    muzzle.scale.set(12, 12, 1); muzzle.position.set(REVOLVER_LEN / 2 + 1.5, 1.2, 0); muzzle.visible = false;
    gun.add(muzzle);
    /* нормалізація масштабу кістки + фіксований офсет/кут відносно кисті:
       ствол уздовж напрямку, куди показує рука, руків'я в долоні */
    gun.scale.setScalar(u);
    const dg = Math.PI / 180;
    gun.quaternion.setFromEuler(new THREE.Euler(
      GUN_HAND_EULER[0] * dg, GUN_HAND_EULER[1] * dg, GUN_HAND_EULER[2] * dg, 'XYZ'));
    gun.position.set(GUN_HAND_POS[0] * u, GUN_HAND_POS[1] * u, GUN_HAND_POS[2] * u);
    gun.userData.u = u;   // для живого калібрування хвата
    handBone.add(gun);
    gunGrp = gun;
  }
  const mixer = new THREE.AnimationMixer(inst);
  const acts = {};
  /* wave — окремий victory-стан (переможець махає глядачам за вінер-скріном) */
  const CLIPS = { idle: 'Idle_Gun', idleShoot: 'Idle_Gun_Shoot', run: 'Run', runShoot: 'Run_Shoot', death: 'Death', wave: 'Wave' };
  for (const k in CLIPS) {
    const c = soldierClip(rec, CLIPS[k]);
    if (c) acts[k] = mixer.clipAction(c);
  }
  if (acts.death) {
    acts.death.setLoop(THREE.LoopOnce, 1);
    acts.death.clampWhenFinished = true;       // завмирає в фінальній позі — труп
  }
  if (acts.idle) {
    acts.idle.play();
    acts.idle.time = (p.idx * 0.37) % (acts.idle.getClip().duration || 1);   // десинхрон айдлів
  }
  return { obj: wrap, mixer: mixer, idle: acts.idle || null, run: acts.run || null,
           acts: acts, mats: mats, muzzle: muzzle, gun: gunGrp, spine: null };
}
/* повісити GLB-солдата на риг (виклик і при build, і при hot-swap) */
function attachSoldier3D(r) {
  const sd = makeSoldier3D(r.p);
  if (r.prim) { r.inner.remove(r.prim); r.prim = null; }
  r.legL = r.legR = null;
  r.inner.add(sd.obj);
  r.model = sd.obj; r.mixer = sd.mixer; r.idleA = sd.idle; r.runA = sd.run;
  r.acts = sd.acts; r.animKey = 'idle'; r.deathPlayed = false;
  r.tintMats = sd.mats; r.running3 = false;
  r.gunFlash = sd.muzzle; r.gun = sd.gun; r.spine = sd.spine; r.aimW = 0;
}
/* модель довантажилась посеред бою — міняємо живі інстанси, трупи не чіпаємо */
function swapIn3D(name) {
  if (!T3) return;
  try {
    if (name === 'soldier') {
      for (let i = 0; i < T3.rigs.length; i++) {
        const r = T3.rigs[i];
        if (r.model || !r.p.alive) continue;   // мрець лишається примітивним трупом
        attachSoldier3D(r);
      }
      return;
    }
    if (name === 'rock1' || name === 'rock2' || name === 'grass1') { bakeDecor3D(name); return; }
    const list = T3.pending[name];
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      /* вибухла бочка лишається примітивним «згарищем» — не підміняємо */
      if (name === 'barrel' && it.rec && it.rec.wrecked) continue;
      while (it.holder.children.length) it.holder.remove(it.holder.children[0]);
      if (name === 'tree' || name === 'tree2') { it.holder.add(makeTree3D(it.o)); it.holder.rotation.y = (it.o.id % 7) * 0.9; }
      else if (name === 'bush') { it.holder.add(makeBush3D(it.o)); it.holder.rotation.y = (it.o.id % 5) * 1.3; }
      else if (name === 'medkit') it.holder.add(makeMedkit3D());
      else if (name === 'barrel') { it.holder.add(makeBarrel3D(it.o)); it.rec.isGlb = true; it.rec.mesh = null; }
      else if (name === 'barrier') it.holder.add(makeRow3D(GLB.ready[name], it.o));
      else if (name === 'sandbags') it.holder.add(makeRow3D(GLB.ready[name], it.o, 35));
      else if (name === 'crate') it.holder.add(makeCrate3D(it.o));   // yaw уже стоїть на холдері
      /* аптечки рухаються щокадру — їм матриці не заморожуємо */
      if (name !== 'medkit') onceUpdateMatrix(it.holder);
    }
    list.length = 0;
  } catch (e) {
    try { console.warn('[RSO] swapIn3D(' + name + ') не вдався:', e); } catch (_) {}
  }
}

function setup3D() {
  try {
    if (!t3Renderer) {
      t3Renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
      t3Renderer.shadowMap.enabled = true;
      t3Renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      t3Renderer.outputEncoding = THREE.sRGBEncoding;
      t3Renderer.setClearColor('#cfc7ae', 1);
    }
    ensureAssets3D();
    return true;
  } catch (e) {
    try { console.warn('[RSO] WebGL init не вдався, фолбек у 2D:', e); } catch (_) {}
    return false;
  }
}

function reg3(x) { T3.disposables.push(x); return x; }

/* Побудова сцени бою — викликається з apiStart після genWorld/initPlayers */
function build3D() {
  dispose3D();
  if (!T3A.camoTex) T3A.camoClones.length = 0;   // скидаємо посилання на клони минулого бою
  const G = T3A.geo, M = T3A.mat;
  T3 = {
    disposables: [],
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(50, Math.max(0.5, vw / Math.max(1, vh)), 2, 7000),
    rigs: [], dynObs: [], kits: [], tracers: [], smoke: [], expl: [], nades: [], nadeMarks: [],
    fires3: [], smokes3: [],   // пули зон молотова/смока
    /* холдери, що чекають на свій GLB (фолбек-примітив усередині) */
    pending: { tree: [], tree2: [], bush: [], medkit: [], barrel: [], barrier: [], sandbags: [], crate: [] },
    decor: null,   // детермінований розсів каменів/трави (bakeDecor3D)
    cpos: new THREE.Vector3(0, 900, 700), clook: new THREE.Vector3(0, 0, 0),
    dpos: new THREE.Vector3(), dlook: new THREE.Vector3(), tmpV: new THREE.Vector3(),
    tmpQ: new THREE.Quaternion(),
    orbA: 0, decalTex: null,
  };
  const S = T3.scene;
  /* серпанок: горизонт тане в колір неба (низ градієнта). Колір під теплу
     палітру нової землі; густина трохи менша за стару — фасетки лоуполі
     на загальному плані не «миляться» серпанком */
  S.fog = new THREE.FogExp2('#c0baa5', 0.00045);   // серпанок у тон приглушеної землі
  S.add(new THREE.Mesh(G.sky, M.sky));
  /* світло: сонце з м'якими тінями — головний «продавець» 3D — плюс заповнення */
  S.add(new THREE.HemisphereLight('#bdd0e6', '#6b6250', 0.6));
  const sun = new THREE.DirectionalLight('#fff1da', 1.0);
  sun.position.set(-430, 760, -280);
  sun.castShadow = true;
  /* 1024 замість 2048: чверть пікселів shadow-pass, різниця в картинці
     на таких дистанціях непомітна, а FPS відчутно вищий */
  sun.shadow.mapSize.width = 1024; sun.shadow.mapSize.height = 1024;
  sun.shadow.camera.left = -920; sun.shadow.camera.right = 920;
  sun.shadow.camera.top = 660; sun.shadow.camera.bottom = -660;
  sun.shadow.camera.near = 80; sun.shadow.camera.far = 2400;
  /* ВАЖЛИВО: r128 сам не перераховує проєкцію shadow-камери після зміни меж —
     без цього виклику тіні лишаються у box ±5 і «зникають» */
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0008;
  S.add(sun); S.add(sun.target);
  /* земля-арена: НЕ плоска — сегментований план, вершини підняті по heightAt;
     геометрія пер-бойова (рельєф щобою інший), тож живе у disposables.
     toNonIndexed: вершини трикутників не діляться між фасетками, тож
     computeVertexNormals дає нормаль НА ТРИКУТНИК — справжній flat-look
     (сам прапорець flatShading у r128-Lambert фасеток не дав би: освітлення
     там рахується у vertex-шейдері) */
  const groundGeo = reg3(new THREE.PlaneGeometry(W + TERRA_EXT * 2, H + TERRA_EXT * 2, 176, 132).toNonIndexed());
  groundGeo.rotateX(-Math.PI / 2);
  const gpos = groundGeo.attributes.position;
  for (let i = 0; i < gpos.count; i++)
    gpos.setY(i, heightAt(gpos.getX(i) + W2, gpos.getZ(i) + H2));
  groundGeo.computeVertexNormals();
  paintGround3D(groundGeo);
  const gr = new THREE.Mesh(groundGeo, M.ground);
  gr.receiveShadow = true;
  S.add(gr); onceUpdateMatrix(gr);
  /* дальня земля: плоска, трохи нижче арени — краї рельєфу зведені до 0,
     тож стик непомітний; тіней не приймає — дешева */
  const far = new THREE.Mesh(G.farGround, M.farGround);
  far.position.y = -1.6;
  S.add(far); onceUpdateMatrix(far);
  /* «домальований» світ: зовнішнє кільце (за ареною, до TERRA_EXT) засаджуємо
     деревами й кущами — суто декор, у 2D-логіці колізій/LOS їх нема */
  for (let di = 0; di < 34; di++) {
    const rx = -TERRA_EXT + 90 + terrHash(9101 + di, 17) * (W + TERRA_EXT * 2 - 180);
    const rz = -TERRA_EXT + 90 + terrHash(9202 + di, 29) * (H + TERRA_EXT * 2 - 180);
    if (rx > -60 && rx < W + 60 && rz > -50 && rz < H + 50) continue;   // тільки ЗОВНІ арени
    const dh = new THREE.Group();
    dh.position.set(rx - W2, heightAt(rx, rz), rz - H2);
    if (terrHash(9303 + di, 7) < 0.62) {
      const o = { id: 9000 + di, crown: 30 + terrHash(9404 + di, 3) * 26 };
      if (GLB.ready[treeKeyOf(o)]) { dh.add(makeTree3D(o)); dh.rotation.y = (o.id % 7) * 0.9; }
      else T3.pending[treeKeyOf(o)].push({ holder: dh, o: o });
    } else {
      const o = { id: 9000 + di, r: 15 + terrHash(9505 + di, 5) * 13 };
      if (GLB.ready.bush) { dh.add(makeBush3D(o)); dh.rotation.y = (o.id % 5) * 1.3; }
      else T3.pending.bush.push({ holder: dh, o: o });
    }
    S.add(dh); onceUpdateMatrix(dh);
  }
  /* шар декалей: той самий offscreen-канвас `ground`, куди 2D-код малює
     кров/кіптяву — та сама РЕЛЬЄФНА геометрія, піднята на 0.4 (без z-fight):
     декалі «стеляться» по пагорбах, а не тонуть у них */
  if (ground) {
    T3.decalTex = reg3(new THREE.CanvasTexture(ground));
    const dm = reg3(new THREE.MeshBasicMaterial({ map: T3.decalTex, transparent: true, depthWrite: false }));
    const dp = new THREE.Mesh(groundGeo, dm);
    dp.position.y = 0.4;
    dp.renderOrder = 1;
    S.add(dp); onceUpdateMatrix(dp);
    groundDirty3D = true;
  }
  /* декор (камені/трава): план — одразу, запікання — коли GLB готовий */
  T3.decor = planDecor3D();
  bakeDecor3D('rock1'); bakeDecor3D('rock2'); bakeDecor3D('grass1');
  buildObstacles3D();
  buildPickups3D();
  buildRigs3D();
  buildPools3D();
  buildZone3D();
  overviewPos3D(T3.cpos); T3.clook.set(0, 0, 0);   // старт камери = overview, без стрибка
}

function buildObstacles3D() {
  const G = T3A.geo, M = T3A.mat, S = T3.scene;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    const gx = o.x - W2, gz = o.y - H2;
    const gy = heightAt(o.x, o.y);   // укриття/дерева стоять НА рельєфі (раз при build)
    if (o.type === 'crate') {
      /* ящик: GLB якщо готовий; фолбек — старий текстурований бокс */
      const holder = new THREE.Group();
      holder.position.set(gx, gy, gz);
      holder.rotation.y = crateYaw(o);
      if (GLB.ready.crate) {
        holder.add(makeCrate3D(o));
      } else {
        const m = new THREE.Mesh(G.box, M.crate);
        m.scale.set(o.hw * 2, 42, o.hh * 2); m.position.y = 21;
        m.castShadow = m.receiveShadow = true;
        holder.add(m);
        T3.pending.crate.push({ holder: holder, o: o });
      }
      S.add(holder); onceUpdateMatrix(holder);   // статичний: зникає visible-ом
      T3.dynObs.push({ o: o, holder: holder, kind: 'crate' });
    } else if (o.type === 'barrel') {
      /* бочка: GLB якщо готова, фолбек — старий текстурований циліндр */
      const holder = new THREE.Group();
      holder.position.set(gx, gy, gz);
      const r = { o: o, holder: holder, mesh: null, isGlb: false, glow: null, kind: 'barrel', wrecked: false };
      if (GLB.ready.barrel) {
        holder.add(makeBarrel3D(o));
        r.isGlb = true;
      } else {
        const m = new THREE.Mesh(G.cyl, M.barrel);
        m.scale.set(o.r, 34, o.r); m.position.y = 17;
        m.receiveShadow = true;   // castShadow вимкнено: дрібнота
        holder.add(m);
        r.mesh = m;
        T3.pending.barrel.push({ holder: holder, o: o, rec: r });
      }
      S.add(holder); onceUpdateMatrix(holder);
      /* «гніт»: підсвітка пробитої бочки — підказка глядачу, що зараз рвоне */
      const glow = new THREE.Sprite(M.flash);
      glow.scale.set(10, 10, 1); glow.position.set(gx, gy + 37, gz); glow.visible = false;
      S.add(glow);
      r.glow = glow;
      T3.dynObs.push(r);
    } else if (o.type === 'sandbag' || o.type === 'wall' || o.type === 'barrier') {
      /* мішки → sandbags.glb; барʼєр і стіна → barrier.glb; фолбек — бокс */
      const key = o.type === 'sandbag' ? 'sandbags' : 'barrier';
      const holder = new THREE.Group();
      holder.position.set(gx, gy, gz);
      if (GLB.ready[key]) {
        holder.add(makeRow3D(GLB.ready[key], o, o.type === 'sandbag' ? 35 : 0));
      } else {
        const h = o.type === 'wall' ? 34 : (o.type === 'barrier' ? 26 : 20);
        const mat = o.type === 'sandbag' ? M.sandbag : M.barrier;
        const m = new THREE.Mesh(G.box, mat);
        m.scale.set(o.hw * 2, h, o.hh * 2); m.position.y = h / 2;
        m.receiveShadow = true;   // castShadow вимкнено: не в списку «великих»
        holder.add(m);
        T3.pending[key].push({ holder: holder, o: o });
      }
      S.add(holder); onceUpdateMatrix(holder);
    } else if (o.type === 'tree') {
      const holder = new THREE.Group();
      holder.position.set(gx, gy, gz);
      if (GLB.ready[treeKeyOf(o)]) {
        holder.add(makeTree3D(o));
        holder.rotation.y = (o.id % 7) * 0.9;   // різні повороти — менше відчуття клонів
      } else {
        const tr = new THREE.Mesh(G.cyl, M.trunk);
        tr.scale.set(8, 46, 8); tr.position.y = 23;
        tr.castShadow = true;
        holder.add(tr);
        /* крона — два схрещені статичні квади з alphaTest (класичний low-poly ліс);
           тіні від квадів вимкнені: alphaTest дає квадратну тінь без customDepthMaterial */
        const ch = o.crown * 1.9, cw = o.crown * 2.1;
        for (let q = 0; q < 2; q++) {
          const pl = new THREE.Mesh(G.plane, M.tree);
          pl.scale.set(cw, ch, 1);
          pl.position.y = 38 + ch / 2;
          pl.rotation.y = q * Math.PI / 2 + (o.id % 4) * 0.35;
          holder.add(pl);
        }
        T3.pending[treeKeyOf(o)].push({ holder: holder, o: o });
      }
      S.add(holder); onceUpdateMatrix(holder);
    } else if (o.type === 'bush') {
      const holder = new THREE.Group();
      holder.position.set(gx, gy, gz);
      if (GLB.ready.bush) {
        holder.add(makeBush3D(o));
        holder.rotation.y = (o.id % 5) * 1.3;
      } else {
        for (let q = 0; q < 2; q++) {
          const pl = new THREE.Mesh(G.plane, M.bush);
          pl.scale.set(o.r * 2.3, o.r * 1.55, 1);
          pl.position.y = o.r * 0.75;
          pl.rotation.y = q * Math.PI / 2 + (o.id % 4) * 0.4;
          holder.add(pl);
        }
        T3.pending.bush.push({ holder: holder, o: o });
      }
      S.add(holder); onceUpdateMatrix(holder);
    }
  }
}

function buildPickups3D() {
  const G = T3A.geo, M = T3A.mat, S = T3.scene;
  for (let i = 0; i < medkits.length; i++) {
    /* holder — щоб GLB-аптечка могла підмінити бокс без правок syncPickups3D
       (той рухає/крутить самі T3.kits[i]) */
    const holder = new THREE.Group();
    if (GLB.ready.medkit) {
      holder.add(makeMedkit3D());
    } else {
      const m = new THREE.Mesh(G.box, M.medkit);
      m.scale.set(22, 9, 16);   // castShadow вимкнено: дрібнота
      holder.add(m);
      T3.pending.medkit.push({ holder: holder, o: null });
    }
    S.add(holder); T3.kits.push(holder);
  }
}

/* Боєць: GLB-солдат (SkinnedMesh + Idle/Run) якщо модель уже готова,
   інакше чоловічок із примітивів (фолбек, підміниться після onLoad).
   Кільце кольору під ногами + канвас-лейбл нік/HP над головою — завжди. */
function attachPrimRig3D(r) {
  /* старий чоловічок із боксів — усе в підгрупі prim, щоб swap зняв одним remove */
  const G = T3A.geo, M = T3A.mat, p = r.p;
  const prim = new THREE.Group();
  const body = reg3(newCamoMat(p.color));   // скін кольору гравця
  const legL = new THREE.Mesh(G.boxTop, body);
  legL.scale.set(5, 13, 5); legL.position.set(0, 13, -5); legL.castShadow = true;
  const legR = new THREE.Mesh(G.boxTop, body);
  legR.scale.set(5, 13, 5); legR.position.set(0, 13, 5); legR.castShadow = true;
  const torso = new THREE.Mesh(G.box, body);
  torso.scale.set(11, 19, 17); torso.position.set(0, 22.5, 0); torso.castShadow = true;
  const head = new THREE.Mesh(G.sphere, M.skin);
  head.scale.set(6, 6, 6); head.position.set(1, 37.5, 0); head.castShadow = true;
  const helm = new THREE.Mesh(G.helmet, M.helmet);
  helm.scale.set(6.8, 6.4, 6.8); helm.position.set(0.6, 37.6, 0);
  const gunA = new THREE.Mesh(G.box, M.gun);
  gunA.scale.set(24, 2.6, 2.6); gunA.position.set(15, 28, 6.5);
  const gunB = new THREE.Mesh(G.box, M.gun);
  gunB.scale.set(8, 4.6, 3); gunB.position.set(1.5, 27, 6.5);
  const gunC = new THREE.Mesh(G.box, M.gun);
  gunC.scale.set(2.6, 7, 2.6); gunC.position.set(11, 24.5, 6.5);
  prim.add(legL); prim.add(legR); prim.add(torso); prim.add(head); prim.add(helm);
  prim.add(gunA); prim.add(gunB); prim.add(gunC);
  r.inner.add(prim);
  r.prim = prim; r.legL = legL; r.legR = legR; r.tintMats = [body];
}
function buildRigs3D() {
  const G = T3A.geo, M = T3A.mat, S = T3.scene;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const grp = new THREE.Group();
    const inner = new THREE.Group();   // окрема група — щоб tween падіння не бився з yaw
    grp.add(inner);
    const flash = new THREE.Sprite(M.flash);
    flash.scale.set(16, 16, 1); flash.position.set(29, 28, 6.5); flash.visible = false;
    inner.add(flash);
    const ringMat = reg3(new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.85, depthWrite: false }));
    const ring = new THREE.Mesh(G.ring, ringMat);
    ring.scale.set(PR + 5, 1, PR + 5); ring.position.y = 0.6; ring.renderOrder = 2;
    grp.add(ring);
    const lcv = document.createElement('canvas'); lcv.width = 256; lcv.height = 64;
    const ltex = reg3(new THREE.CanvasTexture(lcv));
    const lmat = reg3(new THREE.SpriteMaterial({ map: ltex, depthTest: false, transparent: true }));
    const label = new THREE.Sprite(lmat);
    label.position.set(0, 58, 0);
    label.renderOrder = 10;   // нік читається крізь усе — depthTest:false
    grp.add(label);
    S.add(grp);
    const rec = {
      p: p, grp: grp, inner: inner,
      prim: null, legL: null, legR: null,           // примітив-фолбек
      model: null, mixer: null, idleA: null, runA: null, running3: false,   // GLB-солдат
      gunFlash: null, gun: null, spine: null, aimW: 0,   // гвинтівка в руці + стрілецька поза
      tintMats: [],                                  // матеріали під сплеск урону/смерть
      flash: flash, ring: ring, label: label, lcv: lcv, lctx: lcv.getContext('2d'),
      ltex: ltex, labelKey: '', deadTint: false,
    };
    if (GLB.ready.soldier) {
      try { attachSoldier3D(rec); } catch (e) { attachPrimRig3D(rec); }
    } else {
      attachPrimRig3D(rec);
    }
    T3.rigs.push(rec);
  }
}

function buildPools3D() {
  const G = T3A.geo, M = T3A.mat, S = T3.scene;
  for (let i = 0; i < TR3N; i++) {
    const m = new THREE.Mesh(G.box, M.tracer);
    m.scale.set(26, 1.4, 1.4); m.visible = false;
    S.add(m); T3.tracers.push(m);
  }
  for (let i = 0; i < GR3N; i++) {
    /* снаряд у польоті: три «шкурки» під тип кидка (frag/molotov/smoke),
       перемикаються visible-ом у syncGrenades3D; поруч — мітка приземлення.
       Граната вдвічі менша за стару (4.5/5.2 → 2.25/2.6) — вибір власника. */
    const g = new THREE.Group();
    const frag = new THREE.Group();
    const body = new THREE.Mesh(G.sphere, M.grenade);
    body.scale.set(2.25, 2.6, 2.25);
    const lever = new THREE.Mesh(G.box, T3A.mat.gun);
    lever.scale.set(0.8, 2.1, 0.6); lever.position.set(0.8, 2.5, 0); lever.rotation.z = -0.35;
    const pinM = reg3(new THREE.MeshBasicMaterial({ color: '#d8d8d8' }));
    const pin = new THREE.Mesh(G.box, pinM);
    pin.scale.set(1.3, 0.45, 0.45); pin.position.set(-1.2, 2.3, 0);
    frag.add(body); frag.add(lever); frag.add(pin);
    /* молотов: пляшка (циліндр + шийка) з палаючою ганчіркою-спрайтом */
    const molo = new THREE.Group();
    const glassM = reg3(new THREE.MeshLambertMaterial({ color: '#3f6a2f' }));
    const btl = new THREE.Mesh(G.cyl, glassM);
    btl.scale.set(2.1, 6.5, 2.1);
    const neck = new THREE.Mesh(G.cyl, glassM);
    neck.scale.set(0.95, 3.2, 0.95); neck.position.y = 4.4;
    const rag = new THREE.Sprite(M.flash);
    rag.scale.set(7, 7, 1); rag.position.y = 6.6;
    molo.add(btl); molo.add(neck); molo.add(rag);
    /* смок: сіра шашка-циліндр зі світлою кришкою */
    const smk = new THREE.Group();
    const canM = reg3(new THREE.MeshLambertMaterial({ color: '#7d838c' }));
    const can = new THREE.Mesh(G.cyl, canM);
    can.scale.set(2.3, 6, 2.3);
    const capM = reg3(new THREE.MeshLambertMaterial({ color: '#d8d8d8' }));
    const cap = new THREE.Mesh(G.cyl, capM);
    cap.scale.set(1.4, 1.2, 1.4); cap.position.y = 3.4;
    smk.add(can); smk.add(cap);
    molo.visible = false; smk.visible = false;
    g.add(frag); g.add(molo); g.add(smk);
    g.userData.frag = frag; g.userData.molo = molo; g.userData.smk = smk;
    g.visible = false;
    S.add(g); T3.nades.push(g);
    /* мітка приземлення: пульсуюче кільце в точці, куди летить граната —
       глядач бачить, куди прилетить, і встигає перевести погляд */
    const rgM = reg3(new THREE.MeshBasicMaterial({ color: '#ff6a3a', transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 40), rgM);
    ring.rotation.x = -Math.PI / 2; ring.visible = false; ring.renderOrder = 3;
    S.add(ring); T3.nadeMarks.push(ring);
  }
  for (let i = 0; i < EX3N; i++) {
    /* власний матеріал на кожен вибух — щоб опасіті були незалежні */
    const mat = reg3(new THREE.MeshBasicMaterial({ color: '#ffb066', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const m = new THREE.Mesh(G.sphere, mat);
    m.visible = false;
    S.add(m); T3.expl.push(m);
  }
  for (let i = 0; i < SM3N; i++) {
    const mat = reg3(new THREE.SpriteMaterial({ map: T3A.smokeTex, color: '#6a675f', transparent: true, opacity: 0, depthWrite: false }));
    const sp = new THREE.Sprite(mat);
    sp.visible = false;
    S.add(sp); T3.smoke.push(sp);
  }
  /* ── Молотов-вогонь: FI3N калюж × FTON язиків-спрайтів + пульсуюче світло.
     Кожен язик має власний матеріал — мерехтять незалежно (усе через reg3 → dispose) */
  for (let i = 0; i < FI3N; i++) {
    const grp = new THREE.Group();
    const tongues = [];
    for (let q = 0; q < FTON; q++) {
      const fm = reg3(new THREE.SpriteMaterial({ map: T3A.flashTex, color: '#ffb35a', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
      const sp = new THREE.Sprite(fm);
      const a = (q / FTON) * TAU, rr = q === 0 ? 0 : 0.35 + (q % 3) * 0.2;   // частка радіуса калюжі
      sp.userData.ox = Math.cos(a) * rr; sp.userData.oz = Math.sin(a) * rr;
      sp.userData.ph = q * 1.7;
      grp.add(sp); tongues.push(sp);
    }
    const li = new THREE.PointLight('#ff7a2a', 0, 260, 2);   // помаранчеве точкове з пульсом
    li.position.y = 26;
    grp.add(li);
    grp.visible = false;
    S.add(grp);
    T3.fires3.push({ grp: grp, tongues: tongues, light: li });
  }
  /* ── Димова завіса: SK3N хмар × SPUF великих м'яких спрайтів, що клубочаться ── */
  for (let i = 0; i < SK3N; i++) {
    const grp = new THREE.Group();
    const puffs = [];
    for (let q = 0; q < SPUF; q++) {
      const sm = reg3(new THREE.SpriteMaterial({ map: T3A.smokeTex, color: '#c9cbc9', transparent: true, depthWrite: false, opacity: 0 }));
      const sp = new THREE.Sprite(sm);
      sp.userData.ph = q * 0.9;
      sp.userData.rr = 0.2 + (q % 4) * 0.17;   // частка радіуса завіси
      puffs.push(sp); grp.add(sp);
    }
    grp.visible = false;
    S.add(grp);
    T3.smokes3.push({ grp: grp, puffs: puffs });
  }
  T3.sparks = makePoints3D(true);
  T3.bits = makePoints3D(false);
  S.add(T3.sparks.pts); S.add(T3.bits.pts);
  /* два спільні PointLight замість світла на кожен постріл/вибух — дешево */
  T3.shotLight = new THREE.PointLight('#ffcf8a', 0, 260, 2);
  T3.explLight = new THREE.PointLight('#ff9a4a', 0, 500, 2);
  S.add(T3.shotLight); S.add(T3.explLight);
}
function makePoints3D(additive) {
  const g = reg3(new THREE.BufferGeometry());
  const pos = new Float32Array(PMAX * 3), col = new Float32Array(PMAX * 3);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setDrawRange(0, 0);
  const m = reg3(new THREE.PointsMaterial({
    size: 4.5, vertexColors: true, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  }));
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;   // буфер живе своїм життям, баунд-бокс не перераховуємо
  return { pts: pts, geo: g, pos: pos, col: col };
}

function buildZone3D() {
  const G = T3A.geo, M = T3A.mat, S = T3.scene;
  T3.zoneCyl = new THREE.Mesh(G.zoneCyl, M.zone);
  /* центр на 42: циліндр h=130 покриває −23…+107 — весь рельєф ±22 у стінці */
  T3.zoneCyl.position.y = 42; T3.zoneCyl.renderOrder = 3;
  S.add(T3.zoneCyl);
  T3.zoneBase = new THREE.Mesh(G.zoneBase, M.zoneBase);   // світна лінія основи
  T3.zoneBase.position.y = 1.1; T3.zoneBase.renderOrder = 3;
  S.add(T3.zoneBase);
  T3.zoneShowAt = 0;   // мітка першого кадру зони — старт фейд-появи
  T3.zoneTint = new THREE.Mesh(G.zoneTint, M.zoneTint);   // легке червоне тонування ПОЗА зоною
  T3.zoneTint.position.y = 0.5; T3.zoneTint.renderOrder = 2;
  S.add(T3.zoneTint);
  T3.zoneNext = new THREE.Mesh(G.zoneNext, M.zoneNext);   // біле кільце наступного кола
  T3.zoneNext.position.y = 0.7; T3.zoneNext.renderOrder = 2; T3.zoneNext.visible = false;
  S.add(T3.zoneNext);
}

/* ── Покадрова синхронізація стану → сцена ── */
function labelKeyOf(p) {
  let prog = -1;
  if (p.reloading) prog = (perfNow - p.reloadT0) / GUN.reload;
  else if (p.healUntil) prog = 1 - (p.healUntil - perfNow) / 2000;
  /* прогрес квантуємо до 12 кроків — менше перезаливань текстури лейбла */
  const ps = prog < 0 ? -1 : Math.min(11, (clamp(prog, 0, 1) * 12) | 0);
  return ((p.hp + 0.5) | 0) + '|' + ((p.armor + 0.5) | 0) + '|' + ps + '|' + (p.reloading ? 'r' : (p.healUntil ? 'h' : ''));
}
function drawLabel3D(rec) {
  const p = rec.p, c = rec.lctx;
  c.clearRect(0, 0, 256, 64);
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.font = '700 24px "Roboto Mono", monospace';
  const wpx = c.measureText(p.nick).width;
  if (wpx > 236) c.font = '700 ' + Math.max(14, (24 * 236 / wpx) | 0) + 'px "Roboto Mono", monospace';
  c.lineWidth = 5; c.strokeStyle = 'rgba(0,0,0,0.8)'; c.strokeText(p.nick, 128, 26);
  c.fillStyle = '#f2f2f4'; c.fillText(p.nick, 128, 26);
  const bw = 150, bh = 11, x = 128 - bw / 2, y = 36;
  c.fillStyle = 'rgba(0,0,0,0.65)'; c.fillRect(x - 2, y - 2, bw + 4, bh + 4);
  c.fillStyle = p.color; c.fillRect(x, y, bw * clamp(p.hp / p.maxHP, 0, 1), bh);
  if (p.armor > 0) { c.fillStyle = '#c9d4e4'; c.fillRect(x, y - 6, bw * clamp(p.armor / 50, 0, 1), 3); }
  let prog = -1, pc = '#ffd93d';
  if (p.reloading) prog = (perfNow - p.reloadT0) / GUN.reload;
  else if (p.healUntil) { prog = 1 - (p.healUntil - perfNow) / 2000; pc = '#a0ff4a'; }
  if (prog >= 0) { c.fillStyle = pc; c.fillRect(x, y + bh + 3, bw * clamp(prog, 0, 1), 3); }
  rec.ltex.needsUpdate = true;
}
function syncPlayers3D(dt) {
  const camera = T3.camera, tv = T3.tmpV;
  const tanV = Math.tan(camera.fov * Math.PI / 360);
  for (let i = 0; i < T3.rigs.length; i++) {
    const r = T3.rigs[i], p = r.p;
    const gx = p.x - W2, gz = p.y - H2;
    /* боєць (і труп) стоїть НА рельєфі — кільце/лейбл їдуть разом (діти grp) */
    const gy = heightAt(p.x, p.y);
    r.grp.position.set(gx, gy, gz);
    r.grp.rotation.y = -p.aim;   // корпус повертається за aim (2D-кут → yaw): біг обличчям у рух
    if (p.alive) {
      const spd = hyp(p.vx, p.vy);
      if (r.mixer && r.acts) {
        /* UAL-солдат: 4 стани — стоїть/біжить × стріляє/ні. Кліпи стрільби
           готові в моделі (вибір власника), жодних override-ів хребта. */
        const shooting = perfNow - p.lastShotAt < 450;
        /* victory-стан ПОВЕРХ звичайних чотирьох: на паузах пробіжки
           переможець махає рукою (Wave); звичайний sync не зачеплений */
        const celebrating = victory && p === winnerP && vic.phase === 'wave' && r.acts.wave;
        const wantKey = celebrating ? 'wave'
                      : spd > 55 ? (shooting && r.acts.runShoot ? 'runShoot' : 'run')
                                 : (shooting && r.acts.idleShoot ? 'idleShoot' : 'idle');
        if (wantKey !== r.animKey && r.acts[wantKey]) {
          const from = r.acts[r.animKey], to = r.acts[wantKey];
          /* ВАЖЛИВО: to.reset().play() — crossFadeTo сам НЕ запускає цільову
             дію; без play() кліп не має ваги і скелет падає в T-позу */
          to.reset();
          to.setEffectiveTimeScale(1);
          to.setEffectiveWeight(1);
          to.play();
          if (from) from.crossFadeTo(to, 0.18, false);
          r.animKey = wantKey;
        }
        /* темп бігу під фактичну швидкість — ноги не «ковзають» */
        const cur = r.acts[r.animKey];
        if (cur && (r.animKey === 'run' || r.animKey === 'runShoot')) cur.timeScale = clamp(spd / 140, 0.7, 1.6);
        /* хват револьвера фіксований відносно кисті — жодних пер-кліпових пресетів */
        r.mixer.update(dt);
        r.inner.rotation.z = 0;
        r.inner.position.y = 0;
      } else if (r.legL) {
        /* примітив-фолбек: ноги гойдаються у протифазі пропорційно швидкості */
        const sp = clamp(spd / 150, 0, 1);
        const sw = Math.sin(p.walk * 2.4) * 0.62 * sp;
        r.legL.rotation.z = sw; r.legR.rotation.z = -sw;
        r.inner.rotation.z = 0;
        r.inner.position.y = Math.abs(Math.sin(p.walk * 2.4)) * 1.3 * sp;
      }
      /* сплеск урону — на всіх матеріалах бійця */
      const em = perfNow - p.lastHurtAt < 110 ? 0x661d1d : 0x000000;
      for (let m = 0; m < r.tintMats.length; m++) r.tintMats[m].emissive.setHex(em);
      /* спалах: на дулі гвинтівки в руці (GLB), фолбек — старий спрайт рига */
      const fl = perfNow - p.lastShotAt < 55;
      if (r.gunFlash) { r.gunFlash.visible = fl; r.flash.visible = false; }
      else r.flash.visible = fl;
      r.ring.visible = true;
      r.label.visible = true;
      const key = labelKeyOf(p);
      if (key !== r.labelKey) { r.labelKey = key; drawLabel3D(r); }
      /* екранний розмір лейбла ≈ сталий (нік ~16-18px) незалежно від дистанції */
      tv.set(gx, gy + 58, gz);
      const d = camera.position.distanceTo(tv);
      // ~30 екранних px висоти, але не ширше 130 світових юнітів (інакше на
      // загальному плані лейбли лягають на пів-арени)
      const wh = Math.min(32.5, 2 * d * tanV * (30 / Math.max(240, vh)));
      r.label.scale.set(wh * 4, wh, 1);
    } else {
      /* смерть: у UAL-моделі є справжній кліп Death — граємо його один раз
         (clampWhenFinished лишає фінальну позу трупом). Фолбек без кліпа —
         старий tween падіння «обличчям уперед». */
      if (r.acts && r.acts.death) {
        if (!r.deathPlayed) {
          r.deathPlayed = true;
          for (const k in r.acts) if (k !== 'death') r.acts[k].fadeOut(0.1);
          r.acts.death.reset().play();
        }
        if (perfNow - p.deadAt < 2600) r.mixer.update(dt);   // дограти кліп і завмерти
        r.inner.rotation.z = 0;
        r.inner.position.y = 0;
      } else {
        const e0 = clamp((perfNow - p.deadAt) / 450, 0, 1);
        const e = e0 * e0;
        r.inner.rotation.z = -e * Math.PI / 2;
        if (r.legL) { r.legL.rotation.z = 0; r.legR.rotation.z = 0; }
        r.inner.position.y = e * 2;
      }
      r.flash.visible = false;
      if (r.gunFlash) r.gunFlash.visible = false;
      r.ring.visible = false;
      r.label.visible = false;
      if (!r.deadTint) {
        r.deadTint = true;
        for (let m = 0; m < r.tintMats.length; m++) {
          const tm = r.tintMats[m];
          tm.userData.dead = true;   // щоб пізній onLoad текстур не «оживив» колір
          tm.color.set('#6f6f6c');
          tm.emissive.setHex(0x000000);
        }
      }
    }
  }
  /* одне спільне світло пострілу — на наймолодший постріл (замість 8 PointLight) */
  let best = null, bt = 0;
  for (let i = 0; i < players.length; i++)
    if (players[i].lastShotAt > bt) { bt = players[i].lastShotAt; best = players[i]; }
  const age = perfNow - bt;
  if (best && age < 90) {
    T3.shotLight.position.set(best.x - W2 + Math.cos(best.aim) * 26, heightAt(best.x, best.y) + 30, best.y - H2 + Math.sin(best.aim) * 26);
    T3.shotLight.intensity = 2.2 * (1 - age / 90);
  } else T3.shotLight.intensity = 0;
}
function syncObstacles3D() {
  for (let i = 0; i < T3.dynObs.length; i++) {
    const r = T3.dynObs[i], o = r.o;
    if (r.kind === 'crate') {
      r.holder.visible = o.alive;   // модель ховаємо; уламки/трісочки — частинки type=4
    } else if (!o.alive && !r.wrecked) {
      /* вибухла бочка: чорна і «зім'ята», лишається як декорація */
      r.wrecked = true;
      if (r.isGlb) {
        /* GLB: усі меші чорніють спільним barrelDead, корпус сплющуємо;
           база лишається на землі, бо модель посаджена на y=0 холдера */
        r.holder.traverse(function (m) { if (m.isMesh) m.material = T3A.mat.barrelDead; });
        r.holder.scale.set(1.2, 0.42, 1.2);
      } else if (r.mesh) {
        r.mesh.material = T3A.mat.barrelDead;
        r.mesh.scale.set(o.r * 1.2, 15, o.r * 1.2);
        r.mesh.position.y = 7.5;
      }
      onceUpdateMatrix(r.holder);   // матриці статики заморожені — перекомпонувати раз
      r.glow.visible = false;
    } else if (o.alive) {
      r.glow.visible = o.hits > 0;
      if (o.hits > 0) {
        const s = 7 + o.hits * 4 + Math.sin(perfNow * 0.02) * 2;
        r.glow.scale.set(s, s, 1);
      }
    }
  }
}
function syncPickups3D() {
  for (let i = 0; i < T3.kits.length; i++) {
    const k = medkits[i], m = T3.kits[i];
    if (!k || k.taken) { m.visible = false; continue; }
    m.visible = true;
    m.position.set(k.x - W2, heightAt(k.x, k.y) + 7 + Math.sin(perfNow * 0.003 + i * 1.7) * 2.5, k.y - H2);
    m.rotation.y = perfNow * 0.0012 + i;
  }
}
function syncBullets3D() {
  const n = Math.min(bullets.length, TR3N);
  for (let i = 0; i < n; i++) {
    const b = bullets[i], m = T3.tracers[i];
    const d = hyp(b.vx, b.vy) || 1;
    const ux = b.vx / d, uy = b.vy / d;
    m.visible = true;
    /* трасер їде по heightAt поточної точки — не пірнає в пагорб посередині
       (LOS-логіка лишається чесним 2D, це суто візуальний підйом) */
    m.position.set(b.x - ux * 13 - W2, heightAt(b.x, b.y) + 27, b.y - uy * 13 - H2);
    m.rotation.y = -Math.atan2(uy, ux);   // бокс витягнутий уздовж локального +x
  }
  for (let i = n; i < TR3N; i++) T3.tracers[i].visible = false;
}
function syncGrenades3D() {
  const n = Math.min(grenades.length, GR3N);
  for (let i = 0; i < n; i++) {
    const g = grenades[i], m = T3.nades[i], mk = T3.nadeMarks[i];
    const t = clamp(g.t, 0, 1);
    m.visible = true;
    /* шкурка снаряда за типом кидка */
    const u = m.userData;
    if (u.frag) {
      u.frag.visible = !g.kind || g.kind === 'frag';
      u.molo.visible = g.kind === 'molotov';
      u.smk.visible = g.kind === 'smoke';
    }
    /* дуга польоту поверх рельєфу поточної точки */
    const ngx = lerp(g.sx, g.tx, t), ngy = lerp(g.sy, g.ty, t);
    m.position.set(ngx - W2, heightAt(ngx, ngy) + 7 + Math.sin(t * Math.PI) * 55, ngy - H2);
    const spin = g.kind === 'molotov' || g.kind === 'smoke' ? 0.55 : 1;   // пляшка/шашка легко обертаються
    m.rotation.x = t * 11 * spin;
    m.rotation.z = t * 5 * spin;
    if (mk) {                                  // мітка пульсує в точці падіння
      mk.visible = true;
      mk.material.color.set(g.kind === 'smoke' ? '#cfd4da' : '#ff6a3a');   // сіра для смока
      mk.position.set(g.tx - W2, heightAt(g.tx, g.ty) + 1.2, g.ty - H2);
      const pulse = 16 + Math.sin(perfNow * 0.02) * 3 + (1 - t) * 6;
      mk.scale.set(pulse, pulse, 1);
      mk.material.opacity = 0.25 + t * 0.45;   // ближче до вибуху — тривожніше
    }
  }
  for (let i = n; i < GR3N; i++) { T3.nades[i].visible = false; if (T3.nadeMarks[i]) T3.nadeMarks[i].visible = false; }
}
/* зони молотова/смока: язики полум'я мерехтять, дим повільно клубочиться */
function syncAreas3D() {
  for (let i = 0; i < FI3N; i++) {
    const F = T3.fires3[i];
    if (i < fires.length) {
      const f = fires[i];
      F.grp.visible = true;
      F.grp.position.set(f.x - W2, heightAt(f.x, f.y), f.y - H2);   // калюжа на рельєфі
      /* швидкий розгін (0.25с) і догорання (останні 0.6с) */
      const ease = Math.min(1, (perfNow - f.born) / 250) * clamp((f.until - perfNow) / 600, 0, 1);
      for (let q = 0; q < F.tongues.length; q++) {
        const sp = F.tongues[q], ud = sp.userData;
        const flick = 0.72 + 0.28 * Math.sin(perfNow * 0.021 + ud.ph * 3.1);   // мерехтіння
        const h = f.r * (0.26 + 0.15 * flick) * (q === 0 ? 1.5 : 1);           // центральний язик вищий
        sp.position.set(ud.ox * f.r, h * 0.55, ud.oz * f.r);
        sp.scale.set(h * 0.9, h * 1.6, 1);   // витягнуті вгору «низькі язики»
        sp.material.opacity = 0.85 * ease * flick;
      }
      F.light.intensity = (2.2 + Math.sin(perfNow * 0.017 + i * 2.4) * 0.8) * ease;   // пульс
      F.light.distance = f.r * 3.2;
    } else { F.grp.visible = false; F.light.intensity = 0; }
  }
  for (let i = 0; i < SK3N; i++) {
    const K = T3.smokes3[i];
    if (i < smokes.length) {
      const s = smokes[i];
      K.grp.visible = true;
      K.grp.position.set(s.x - W2, heightAt(s.x, s.y), s.y - H2);   // завіса на рельєфі
      /* плавний вхід (0.9с) і вихід (1.4с) */
      const ease = clamp(Math.min((perfNow - s.born) / 900, (s.until - perfNow) / 1400), 0, 1);
      for (let q = 0; q < K.puffs.length; q++) {
        const sp = K.puffs[q], ud = sp.userData;
        const a = ud.ph + perfNow * 0.00022 * (q % 2 ? 1 : -1);   // повільне клубочіння
        const rr = s.r * ud.rr;
        sp.position.set(Math.cos(a) * rr,
          18 + (q % 3) * 14 + Math.sin(perfNow * 0.0011 + ud.ph) * 4,
          Math.sin(a) * rr);
        const sc = s.r * (1.05 + (q % 3) * 0.22);
        sp.scale.set(sc, sc * 0.82, 1);
        sp.material.opacity = (0.55 + (q % 2) * 0.3) * ease;   // ~0.85 у піку
      }
    } else K.grp.visible = false;
  }
}
const col3Cache = {};
function col3Of(hex) {
  let c = col3Cache[hex];
  if (!c) {
    c = col3Cache[hex] = [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255];
  }
  return c;
}
function syncParts3D() {
  /* іскри — Points additive (гаснуть кольором), кров/тріски — Points normal,
     дим — пул спрайтів (бо росте в розмірі і блідне) */
  let ns = 0, nb = 0, sm = 0;
  const sp = T3.sparks, bp = T3.bits;
  for (let i = 0; i < PMAX; i++) {
    const p = parts[i];
    if (!p.on) continue;
    const a = clamp(p.life / p.max, 0, 1);
    const ph = heightAt(p.x, p.y);   // частинки живуть над рельєфом, не в товщі пагорба
    if (p.type === 3) {
      if (sm < SM3N) {
        const s = T3.smoke[sm++];
        s.visible = true;
        s.position.set(p.x - W2, ph + 10 + (p.max - p.life) * 15, p.y - H2);   // дим підіймається
        // легкий серпанок, а не куля: у 3D розміри 2D-частинок треба гасити
        s.scale.set(p.size * 1.1, p.size * 1.1, 1);
        s.material.opacity = a * 0.15;
      }
    } else if (p.type === 1) {
      const c = col3Of(p.color), j = ns * 3;
      sp.pos[j] = p.x - W2; sp.pos[j + 1] = ph + 9; sp.pos[j + 2] = p.y - H2;
      sp.col[j] = c[0] * a; sp.col[j + 1] = c[1] * a; sp.col[j + 2] = c[2] * a;
      ns++;
    } else {
      const c = col3Of(p.color), j = nb * 3;
      bp.pos[j] = p.x - W2; bp.pos[j + 1] = ph + (p.type === 2 ? 5 : 9); bp.pos[j + 2] = p.y - H2;
      bp.col[j] = c[0]; bp.col[j + 1] = c[1]; bp.col[j + 2] = c[2];
      nb++;
    }
  }
  for (let i = sm; i < SM3N; i++) T3.smoke[i].visible = false;
  sp.geo.setDrawRange(0, ns);
  bp.geo.setDrawRange(0, nb);
  sp.geo.attributes.position.needsUpdate = true;
  sp.geo.attributes.color.needsUpdate = true;
  bp.geo.attributes.position.needsUpdate = true;
  bp.geo.attributes.color.needsUpdate = true;
  /* вибухи: сфера-спалах + світло-пульс від останнього */
  let li = -1;
  for (let i = 0; i < EX3N; i++) {
    const m = T3.expl[i];
    if (i < explosions.length) {
      const e = explosions[i];
      const t = clamp(e.t / e.max, 0, 1);
      m.visible = true;
      m.position.set(e.x - W2, heightAt(e.x, e.y) + 22, e.y - H2);
      const s = e.r * (0.35 + t * 0.85);
      m.scale.set(s, s * 0.8, s);
      m.material.opacity = 0.85 * (1 - t);
      li = i;
    } else m.visible = false;
  }
  if (li >= 0) {
    const e = explosions[li], t = clamp(e.t / e.max, 0, 1);
    T3.explLight.position.set(e.x - W2, heightAt(e.x, e.y) + 60, e.y - H2);
    T3.explLight.intensity = 6 * (1 - t);
    T3.explLight.distance = e.r * 4;
  } else T3.explLight.intensity = 0;
}
function syncZone3D(dt) {
  if (!zone) return;
  const z = zone, M = T3A.mat;
  T3.zoneCyl.position.x = z.cx - W2; T3.zoneCyl.position.z = z.cy - H2;
  T3.zoneCyl.scale.set(z.r, 1, z.r);
  T3.zoneBase.position.x = z.cx - W2; T3.zoneBase.position.z = z.cy - H2;
  T3.zoneBase.scale.set(z.r, 1, z.r);
  T3.zoneTint.position.x = z.cx - W2; T3.zoneTint.position.z = z.cy - H2;
  T3.zoneTint.scale.set(z.r, 1, z.r);
  /* плавна поява: перший кадр бою → фейд ~0.5с, без різкого «вистрибування» */
  if (!T3.zoneShowAt) T3.zoneShowAt = perfNow;
  const fade = clamp((perfNow - T3.zoneShowAt) / 500, 0, 1);
  /* жива стіна: струмені дрейфують по колу + м'яка пульсація щільності */
  if (M.zone.map) M.zone.map.offset.x = (M.zone.map.offset.x + dt * 0.02) % 1;
  M.zone.opacity = fade * (0.78 + 0.12 * Math.sin(perfNow * 0.0021));
  M.zoneBase.opacity = fade * (0.75 + 0.2 * Math.sin(perfNow * 0.0033));
  M.zoneTint.opacity = fade * 0.08;
  const showNext = z.tr < z.r - 2;
  T3.zoneNext.visible = false;   // превью наступного кола не показуємо — як і в лобі
  if (showNext) {
    T3.zoneNext.position.x = z.tcx - W2; T3.zoneNext.position.z = z.tcy - H2;
    T3.zoneNext.scale.set(z.tr, 1, z.tr);
  }
}

/* ── 3D-камера: та сама стейт-машина (overview/auto/manual/killcam), інші ракурси ── */
function overviewPos3D(v) {
  const asp = Math.max(0.6, vw / Math.max(1, vh));
  const t2 = Math.tan(T3.camera.fov * Math.PI / 360);
  /* дистанція: арена на весь кадр (світ домальований — за краями тепер
     рельєф і ліс, тож кадруємо впритул); нахил 62° — менше смуги горизонту */
  const dist = Math.max(790 / (t2 * asp), 528 / t2);
  v.set(0, dist * 0.883, dist * 0.469);   // ~62° над горизонтом, «з півдня»
}
function updateCam3D(dt) {
  const now = perfNow;
  const cam3 = T3.camera, D = T3.dpos, L = T3.dlook;
  const nAlive = camAlive.length;   // масив уже заповнив updateCam() цього кадру
  const asp = Math.max(0.5, vw / Math.max(1, vh));
  const tanV = Math.tan(cam3.fov * Math.PI / 360);
  let flySnap = false;   // у польоті камера жорстко на дроні — без лерпа позиції
  if (camMode === 'fly' && fly.on) {
    /* ── ВІЛЬНИЙ ПОЛІТ: позиція/кути веде інпут; авто-режисура і killcam
       сюди не заходять — камеру ніхто не «краде» ── */
    flyUpdate(dt);
    const cp = Math.cos(fly.pitch), sp = Math.sin(fly.pitch);
    const cy = Math.cos(fly.yaw), sy = Math.sin(fly.yaw);
    D.set(fly.px - W2, fly.py, fly.pz - H2);
    L.set(D.x + cp * cy * 200, D.y + sp * 200, D.z + cp * sy * 200);
    flySnap = true;
  } else if (camMode === 'overview') {
    overviewPos3D(D); L.set(0, 0, 0);
  } else if (camMode === 'manual' && nAlive) {
    const t = camAlive[((manualIdx % nAlive) + nAlive) % nAlive];
    /* за вибраним гравцем через плече — позаду по aim, погляд уперед;
       точка погляду теж на рельєфі, щоб на схилах камера стелилась за пагорбом */
    const dx = Math.cos(t.aim), dz = Math.sin(t.aim);
    const th = heightAt(t.x, t.y);
    const fx = t.x + dx * 96, fz = t.y + dz * 96;
    D.set(t.x - W2 - dx * 118, th + 58, t.y - H2 - dz * 118);
    L.set(fx - W2, heightAt(fx, fz) + 22, fz - H2);
  } else if (now < killCam.until) {
    /* наїзд на свіжу жертву */
    const kh = heightAt(killCam.x, killCam.y);
    D.set(killCam.x - W2 + 80, kh + 105, killCam.y - H2 + 125);
    L.set(killCam.x - W2, kh + 6, killCam.y - H2);
  } else if (nAlive === 1) {
    /* фінал: повільна орбіта навколо переможця */
    T3.orbA += dt * 0.45;
    const s = camAlive[0];
    const sh = heightAt(s.x, s.y);
    D.set(s.x - W2 + Math.cos(T3.orbA) * 150, sh + 62, s.y - H2 + Math.sin(T3.orbA) * 150);
    /* під вінер-оверлеєм центр кадру зайнятий плашкою з ніком — зсуваємо
       точку погляду вправо (camera-right), щоб переможець стояв ЛІВІШЕ
       плашки й глядач бачив пробіжки/Wave, а не жовтий прямокутник */
    const ok = victory ? 55 : 0;
    L.set(s.x - W2 + Math.sin(T3.orbA) * ok, sh + 26, s.y - H2 - Math.cos(T3.orbA) * ok);
  } else if (nAlive >= 2) {
    /* авто-дуель: та сама евристика «найцікавішої пари», що у 2D updateCam */
    let ba = camAlive[0], bb = camAlive[1], bs = -1e9;
    for (let i = 0; i < nAlive; i++) {
      for (let j = i + 1; j < nAlive; j++) {
        const a = camAlive[i], b = camAlive[j];
        const d = hyp(a.x - b.x, a.y - b.y);
        let s = -d * 0.6;
        if (now - Math.max(a.lastShotAt, b.lastShotAt) < 1600) s += 700;
        if (now - Math.max(a.lastHurtAt, b.lastHurtAt) < 1200) s += 500;
        if (s > bs) { bs = s; ba = a; bb = b; }
      }
    }
    const mx = (ba.x + bb.x) / 2 - W2, mz = (ba.y + bb.y) / 2 - H2;
    let ax = bb.x - ba.x, az = bb.y - ba.y;
    const ad = hyp(ax, az) || 1; ax /= ad; az /= ad;
    let px = -az, pz = ax;   // перпендикуляр до осі пари — камера збоку, обоє в кадрі
    /* тримаємось боку, де камера вже стоїть — без раптових перельотів через пару */
    if (px * (T3.cpos.x - mx) + pz * (T3.cpos.z - mz) < 0) { px = -px; pz = -pz; }
    const need = ad / 2 + 110;
    const back = clamp(need / (tanV * asp) * 1.05, 250, 720);
    /* базова висота — рельєф середини пари; фінальний клемп нижче не дає пірнути під пагорб */
    const mh = heightAt(mx + W2, mz + H2);
    D.set(mx + px * back, mh + back * 0.4 + 18, mz + pz * back);   // ~20-22° над горизонтом — кінематографічно низько
    L.set(mx, mh + 22, mz);
  } else {
    overviewPos3D(D); L.set(0, 0, 0);
  }
  /* серпанок глушить фарби на дальньому overview — там туман майже вимикаємо,
     на ігрових камерах повертаємо повну щільність (плавно, без стрибка кольору) */
  if (T3.scene.fog) {
    const fd = camMode === 'overview' ? 0.00010 : 0.00045;
    T3.scene.fog.density += (fd - T3.scene.fog.density) * Math.min(1, dt * 3);
  }
  /* плавність: без ривків, різні швидкості для позиції та погляду.
     Політ — виняток: позицію веде власний лерп швидкості у flyUpdate,
     ще один лерп зверху дав би «гумову» камеру */
  if (flySnap) {
    T3.cpos.copy(D);
    T3.clook.copy(L);
  } else {
    const k = 1 - Math.exp(-dt * 3.0), kl = 1 - Math.exp(-dt * 4.2);
    T3.cpos.lerp(D, k);
    T3.clook.lerp(L, kl);
  }
  let sx = 0, sy = 0, sz = 0;
  if (cam.shake) {   // те саме поле shake, що трясе 2D-камеру
    sx = (frnd() * 2 - 1) * cam.shake * 0.7;
    sy = (frnd() * 2 - 1) * cam.shake * 0.45;
    sz = (frnd() * 2 - 1) * cam.shake * 0.7;
  }
  /* ніколи не під землею І не під пагорбом: мінімум — рельєф під камерою + 9 */
  const camFloor = heightAt(T3.cpos.x + sx + W2, T3.cpos.z + sz + H2) + 9;
  cam3.position.set(T3.cpos.x + sx, Math.max(camFloor, T3.cpos.y + sy), T3.cpos.z + sz);
  T3.tmpV.copy(T3.clook);
  cam3.lookAt(T3.tmpV);
}

function render3D(dt) {
  if (!T3 || !t3Renderer) return;
  syncPlayers3D(dt || 0.016);
  syncObstacles3D();
  syncPickups3D();
  syncBullets3D();
  syncGrenades3D();
  syncAreas3D();
  syncParts3D();
  syncZone3D(dt || 0.016);
  if (groundDirty3D && T3.decalTex) { T3.decalTex.needsUpdate = true; groundDirty3D = false; }
  updateCam3D(dt || 0.016);
  t3Renderer.render(T3.scene, T3.camera);
  updateHud();
}

/* звільняємо ресурси конкретного бою; спільні (T3A, renderer) лишаються на наступний */
function dispose3D() {
  if (!T3) return;
  /* глушимо мікшери солдатів (клоновані матеріали вже в disposables через reg3;
     геометрії GLB спільні з кешем — їх НЕ диспозимо, вони на наступний бій) */
  for (let i = 0; i < T3.rigs.length; i++) {
    const r = T3.rigs[i];
    if (r.mixer) { try { r.mixer.stopAllAction(); } catch (e) {} }
  }
  for (let i = 0; i < T3.disposables.length; i++) {
    const d = T3.disposables[i];
    try { if (d && d.dispose) d.dispose(); } catch (e) {}
  }
  T3 = null;
}

/* ── Фінал ── */
/* Хореографія переможця за вінер-оверлеєм: пробіжка колом навколо своєї
   точки (синк сам вмикає Run за швидкістю) ↔ зупинка з Wave (махає глядачам).
   Рухаємо ЛИШЕ позицію/aim — жодної бойової логіки. */
function updateVictory(dt, now) {
  const w = winnerP;
  if (!w || !w.alive) return;
  if (now >= vic.until) {
    if (vic.phase === 'run') { vic.phase = 'wave'; vic.until = now + 2000; w.vx = 0; w.vy = 0; }
    else {
      vic.phase = 'run'; vic.until = now + 2500;
      /* нове коло стартує З ПОТОЧНОЇ позиції — без телепорту */
      vic.ang = Math.atan2(w.y - vic.cy, w.x - vic.cx) || 0;
    }
  }
  if (vic.phase === 'run') {
    const R = 46, SPD = 125;               // радіус кола і лінійна швидкість пробіжки
    vic.ang += dt * SPD / R;
    const nx = vic.cx + Math.cos(vic.ang) * R, ny = vic.cy + Math.sin(vic.ang) * R;
    const sdt = Math.max(dt, 1e-3);
    w.vx = (nx - w.x) / sdt; w.vy = (ny - w.y) / sdt;   // швидкість веде Run-аніму і 2D-ноги
    w.x = nx; w.y = ny;
    resolveCollisions(w);                  // не забігати в ящики/бочки
    if (hyp(w.vx, w.vy) > 1) w.aim = Math.atan2(w.vy, w.vx);
    w.walk += hyp(w.vx, w.vy) * dt * 0.05; // 2D-фолбек: гойдання ніг/боб
  } else { w.vx = 0; w.vy = 0; }
}
function finishFight() {
  winnerShown = true;
  /* бій скінчився — віддаємо мишу назад: у польоті вона захоплена (курсора
     не видно) і глядач не міг би клікнути «Закрыть» на вінер-скріні */
  flyStop(false);
  /* рендер НЕ зупиняємо: під напівпрозорим вінер-скріном живе сцена
     перемоги; повний стоп — лише RSO.stop() (кнопка «Закрыть») */
  victory = true;
  vic.phase = 'run'; vic.until = perfNow + 2500;
  bullets.length = 0;   // кулі, що летіли в момент фіналу, не висять у повітрі
  if (winnerP) {
    /* якір кола — так, щоб поточна позиція вже лежала НА колі (без ривка) */
    const a = frnd() * TAU;
    vic.ang = a;
    vic.cx = winnerP.x - Math.cos(a) * 46;
    vic.cy = winnerP.y - Math.sin(a) * 46;
  }
  sfx('win', 0.8);
  const w = winnerP;
  setText('so-winner-name', w ? w.nick : '—');
  setText('so-winner-stats', w ? ('убийств: ' + w.kills + ' · урон: ' + Math.round(w.dmg)) : '');
  const el = document.getElementById('so-winner');
  if (el) el.classList.add('show');
  /* один-єдиний виклик onWinner — лобі саме оновить свій стан */
  if (onWinnerCb && w) {
    const cb = onWinnerCb;
    onWinnerCb = null;
    try { cb({ nick: w.nick, col: w.col, row: w.row }); } catch (e) {}
  }
}

/* ── Канвас / події ── */
function resize() {
  if (!cv || !root) return;
  const r = root.getBoundingClientRect();
  vw = Math.max(320, r.width || window.innerWidth);
  vh = Math.max(240, r.height || window.innerHeight);
  dpr = Math.min(window.devicePixelRatio || 1, 1.75);   // капінг DPR заради 60fps
  if (USE_3D && t3Renderer) {
    /* у 3D розмір буфера веде WebGLRenderer (він множить на pixelRatio сам);
       капимо жорсткіше за 2D: на retina 1.75× дає ~2× пікселів проти 1.25× —
       головний пожирач fillrate при тінях+тумані */
    t3Renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    t3Renderer.setSize(vw, vh, false);
    if (T3 && T3.camera) {
      T3.camera.aspect = vw / Math.max(1, vh);
      T3.camera.updateProjectionMatrix();
    }
  } else {
    cv.width = Math.round(vw * dpr);
    cv.height = Math.round(vh * dpr);
  }
}
window.addEventListener('resize', function () { if (running) resize(); });
window.addEventListener('keydown', function (e) {
  if (!root || !root.classList.contains('visible')) return;
  /* політ їсть свої клавіші першим (e.code — незалежно від розкладки);
     Esc не чіпаємо — браузер сам знімає pointer lock, режим лишається */
  if (fly.on && flyKey(e.code, true)) { e.preventDefault(); return; }
  if (winnerShown) return;
  if (e.key === 'ArrowLeft') { apiFocusNext(-1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { apiFocusNext(1); e.preventDefault(); }
  else if (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М') apiToggleOverview();
});
window.addEventListener('keyup', function (e) {
  if (fly.on) flyKey(e.code, false);
});
window.addEventListener('blur', function () {
  /* чому: без цього затиснута клавіша «залипає» після Alt-Tab */
  if (fly.on) { fly.kW = fly.kA = fly.kS = fly.kD = fly.kUp = fly.kDn = fly.kBoost = fly.drag = false; }
});
/* остання страховка: оверлей перестрілки закрився (або сховався) будь-яким
   шляхом — миша має повернутись користувачу, а не лишитись захопленою */
document.addEventListener('visibilitychange', function () {
  if (document.hidden && document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
});
/* Миша польоту: pointer lock → movementX/Y; фолбек — drag-look затиснутою ЛКМ.
   Слухачі на document, бо cv зʼявляється лише після start(). */
document.addEventListener('mousedown', function (e) {
  if (!fly.on || !cv || e.target !== cv || e.button !== 0) return;
  flyRequestLock();   // повторний клік по канвасу знову захоплює мишу після Esc
  fly.drag = true; fly.lastX = e.clientX; fly.lastY = e.clientY;
});
document.addEventListener('mousemove', function (e) {
  if (!fly.on) return;
  if (cv && document.pointerLockElement === cv) flyLook(e.movementX, e.movementY);
  else if (fly.drag) {
    flyLook(e.clientX - fly.lastX, e.clientY - fly.lastY);
    fly.lastX = e.clientX; fly.lastY = e.clientY;
  }
});
document.addEventListener('mouseup', function () { fly.drag = false; });
document.addEventListener('wheel', function (e) {
  if (!fly.on || !cv || (e.target !== cv && document.pointerLockElement !== cv)) return;
  fly.speedMul = clamp(fly.speedMul * Math.exp(-e.deltaY * 0.0009), 0.4, 4);
  e.preventDefault();
}, { passive: false });

/* ── Публічний контракт ── */
function apiStart(finalists, opts) {
  opts = opts || {};
  stopLoop();
  root = document.getElementById('royale-shootout');
  cv = document.getElementById('so-canvas');
  if (!root || !cv) return;
  /* Вибір шару малювання: 3D (Three.js) якщо THREE підключений і WebGL живий,
     інакше — старий 2D-canvas. Логіка бою в обох випадках одна. */
  USE_3D = (typeof THREE !== 'undefined') && webglAvailable() && setup3D();
  ctx = USE_3D ? null : cv.getContext('2d');
  try { console.log('[RSO] Активний рендер: ' + (USE_3D ? '3D (Three.js WebGL)' : '2D canvas (fallback)')); } catch (e) {}
  onWinnerCb = typeof opts.onWinner === 'function' ? opts.onWinner : null;
  loadSprites();
  ensureSfx();
  seedRng();
  perfNow = performance.now();
  /* повний скид стану */
  bullets.length = 0; grenades.length = 0; explosions.length = 0; killfeed.length = 0;
  fires.length = 0; smokes.length = 0;
  for (let i = 0; i < PMAX; i++) parts[i].on = false;
  for (let i = 0; i < FMAX; i++) floats[i].on = false;
  winnerShown = false; winnerP = null; endAt = 0; aggroUntil = 0;
  camMode = 'overview'; manualIdx = 0; manualUntil = 0; killCam.until = 0; killCam.p = null;   // кожен бій починається з огляду всієї арени
  fly.on = false; fly.drag = false; fly.vx = 0; fly.vy = 0; fly.vz = 0; fly.speedMul = 1;
  fly.kW = fly.kA = fly.kS = fly.kD = fly.kUp = fly.kDn = fly.kBoost = false;
  focusP = null; focusKey = '§';   // «§» ≠ будь-який ключ → перший updateHud сховає панель
  updFlyBtn();
  /* у 2D-фолбеку польоту нема — кнопку ховаємо цілком */
  const flyBtn = document.getElementById('so-fly-btn');
  if (flyBtn) flyBtn.style.display = USE_3D ? '' : 'none';
  kfDirty = true; hudAt = 0; camLblTxt = ''; aliveTxt = ''; zoneTxt = ''; cdTxt = '';
  /* контракт — 2..8, але якщо лобі раптом передасть більше — нікого не викидаємо
     (кольори почнуть повторюватись, це менше зло за зниклого фіналіста) */
  const list = (finalists || []).slice(0, 16);
  genWorld(Math.max(2, list.length));
  initPlayers(list);
  /* офскрін-декалі */
  ground = document.createElement('canvas');
  ground.width = W; ground.height = H;
  gctx = ground.getContext('2d');
  groundPat = null;
  if (USE_3D) build3D();   // сцена будується вже ПІСЛЯ genWorld/initPlayers/ground
  /* дебаг-контракт (постійний, ним користуються інструменти розробки):
     заморозка бою + доступ до сцени/heightAt із консолі */
  window.__RSO_FREEZE = function (ms) { goAt = performance.now() + (ms == null ? 1e9 : ms); };
  window.__RSO_GET = function () { return { T3: T3, players: players, heightAt: heightAt }; };
  goAt = perfNow + 3400;                              // 3-2-1-БОЙ
  initZone(goAt);
  lastShotHeard = goAt; lastShotSfx = 0;
  root.classList.add('visible');
  const wEl = document.getElementById('so-winner');
  if (wEl) wEl.classList.remove('show');
  resize();
  cam.z = fitZoom(); cam.x = W / 2; cam.y = H / 2;
  cam.tx = W / 2; cam.ty = H / 2; cam.tz = cam.z;
  updOverviewBtn();
  try { if (typeof phase !== 'undefined') phase = 'racing'; } catch (e) {}
  sfx('shuffle', 0.5);
  running = true;
  let last = performance.now();
  const loop = function (now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);   // dt-капінг
    last = now;
    update(dt);
    if (running) {
      if (USE_3D) render3D(dt); else render();
      raf = requestAnimationFrame(loop);
    } else {
      if (USE_3D) render3D(dt); else render();         // останній кадр під екраном переможця
    }
  };
  raf = requestAnimationFrame(loop);
}
function stopLoop() {
  running = false;
  victory = false;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}
function apiStop() {
  stopLoop();
  flyStop(false);   // знімаємо pointer lock і підсвітку кнопки
  dispose3D();   // геометрії/матеріали/текстури бою; renderer і спільні ресурси лишаються
  if (!root) root = document.getElementById('royale-shootout');
  if (root) root.classList.remove('visible');
  const wEl = document.getElementById('so-winner');
  if (wEl) wEl.classList.remove('show');
  /* phase не чіпаємо: під нами ще відкрите лобі рояля, воно керує phase */
}
function apiFocusNext(dir) {
  if (!running) return;
  let aliveN = 0;
  for (let i = 0; i < players.length; i++) if (players[i].alive) aliveN++;
  if (!aliveN) return;
  flyStop(false);   // перемикання камери ◀▶ — свідомий вихід із польоту
  if (camMode === 'manual') manualIdx += dir > 0 ? 1 : -1;
  else manualIdx = 0;
  camMode = 'manual';
  manualUntil = perfNow + 6000;                       // ручний фокус тимчасовий
  updOverviewBtn();
}
function apiToggleOverview() {
  if (!running) return;
  flyStop(false);   // «Вид» — свідомий вихід із польоту
  camMode = camMode === 'overview' ? 'auto' : 'overview';
  manualUntil = 0;
  updOverviewBtn();
}
function apiToggleFly() {
  /* політ існує лише в 3D: у 2D-фолбеку кнопка прихована й нічого не робить */
  if (!running || !USE_3D || !T3) return;
  if (fly.on) flyStop(true);   // вихід кнопкою → назад в авто-режисуру
  else flyStart();
}

window.RSO = {
  start: apiStart,
  stop: apiStop,
  focusNext: apiFocusNext,
  toggleOverview: apiToggleOverview,
  toggleFly: apiToggleFly,
};

})();
