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
/* пул плеєрів пострілу: playSfx клонує Audio на кожен виклик, а Chrome
   обмежує кількість WebMediaPlayer (~75) — довгий бій засмічував консоль
   «Blocked attempt to create a WebMediaPlayer». Пул із 6 багаторазових
   клонів дає ті самі накладені постріли без нових плеєрів. */
let _shotPool = null, _shotPoolI = 0;
function sfx(name, vol, rate, maxMs) {
  /* тимчасово, на прохання власника: у перестрілці звучать ЛИШЕ постріли */
  if (name !== 'pubg-shot') return;
  try {
    const base = (typeof SFX === 'object' && SFX) ? SFX[name] : null;
    if (!base) return;
    if (!_shotPool) {
      _shotPool = [];
      for (let i = 0; i < 6; i++) _shotPool.push(base.cloneNode());
    }
    const a = _shotPool[_shotPoolI = (_shotPoolI + 1) % _shotPool.length];
    a.volume = vol == null ? 0.8 : vol;
    if (rate) a.playbackRate = rate;
    a.currentTime = 0;
    a.play().catch(function () {});
  } catch (e) {}
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

/* ── Персонаж: Toon Shooter Game Kit, Character_Soldier — ОДИН на всіх.
   Ідентифікація гравця — колір костюма (матеріал 'Character_Main'
   перефарбовується у p.color) + кільце під ногами + нік-плашка. */
function charKeyOf(p) { return 'soldier'; }

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
let dmgPops = [];   // циферки урону, що вилітають з гравця: {p, dmg, t0}
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
      hp: 100, maxHP: 100,   // на прохання власника: старт завжди зі 100, без переносу з лобі
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
      /* памʼять про ворогів (нік → {x,y,vx,vy,at}) — оновлюється лише тим, що САМ бачив */
      mem: new Map(),
      /* останній ПОЧУТИЙ постріл (без ніка — «звук звідти») */
      memNoise: null, lastNoiseAt: 0,
      /* ухиляння під вогнем і полювання за зниклою ціллю */
      serpUntil: 0, searchUntil: 0,
      /* відкладена перезарядка: спершу за укриття, потім reload */
      wantReload: false, reloadForceAt: 0,
      /* керування глядачем із телефону (hostNet): human=true — AI вимкнений,
         inp — останній пакет вводу {mx,my,aim,fire,at} */
      human: false, inp: null,
      /* «характер»: агресивність, влучність, швидкість реакції (роль призначає assignRoles) */
      persona: { aggr: 0.2 + frnd() * 0.5, acc: 0.6 + frnd() * 0.4, react: 220 + fint(260), role: 'RUSHER', spreadMul: 1 },
    };
  });
  assignRoles();
}
/* ── Архетипи: роль на бій, детерміновано від сіда ──
   Базова четвірка перемішується (щоб у малих боях були різні), решта
   добирає випадково — у 2-3 бійців ролі можуть збігатись, це ок. */
function assignRoles() {
  const ROLES = ['RUSHER', 'CAMPER', 'SNIPER', 'SURVIVOR'];
  const bag = ROLES.slice();
  for (let i = bag.length - 1; i > 0; i--) { const j = fint(i + 1); const s = bag[i]; bag[i] = bag[j]; bag[j] = s; }
  for (let i = 0; i < players.length; i++) {
    const ps = players[i].persona;
    const role = i < bag.length ? bag[i] : ROLES[fint(ROLES.length)];
    ps.role = role;
    if (role === 'RUSHER') {         // пре вперед, швидка реакція, гранати з ходу
      /* CQB-профіль: влучний і купчастий впритул — інакше рашер, що біжить
         під перехресний вогонь кемперів/снайперів, не виграє взагалі */
      ps.aggr = 0.62 + frnd() * 0.25; ps.react = 150 + fint(140);
      ps.acc = 0.8 + frnd() * 0.2; ps.spreadMul = 0.88;
      /* пуш через відкрите поле під перехресний вогонь — без броні рашер
         не доживає до клінчу; повний бронік вирівнює вінрейт ролі */
      players[i].armor = 50;
    } else if (role === 'CAMPER') {  // сидить, чекає, стріляє перший здалеку
      ps.aggr = 0.12 + frnd() * 0.14; ps.react = 240 + fint(200);
      ps.acc = 0.72 + frnd() * 0.2; ps.spreadMul = 0.92;
    } else if (role === 'SNIPER') {  // довгі лінії, точніший, повільніше перерішує
      ps.aggr = 0.25 + frnd() * 0.15; ps.react = 360 + fint(240);
      ps.acc = 0.85 + frnd() * 0.15; ps.spreadMul = 0.8;
    } else {                         // SURVIVOR: уникає боїв, у фіналі — агресія
      ps.aggr = 0.12 + frnd() * 0.12; ps.react = 230 + fint(200); ps.spreadMul = 1;
    }
  }
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
  /* Ухиляння: миттєвий перпендикулярний ривок від лінії вогню (без перевищення
     спринту — просто різка зміна напрямку) + серпантин, доки біжить до укриття */
  if (attacker && attacker !== v && v.hp > 0 && !v.human) {
    v.strafeSide = -v.strafeSide;
    const ax = v.x - attacker.x, ay = v.y - attacker.y, ad = hyp(ax, ay) || 1;
    v.vx = -ay / ad * v.strafeSide * 150;
    v.vy = ax / ad * v.strafeSide * 150;
    v.serpUntil = perfNow + 1200;
    /* під вогнем реагуємо швидше за звичайну «реакцію» */
    if (v.decideAt > perfNow + 260) v.decideAt = perfNow + 140 + fint(140);
  }
  /* циферка урону над головою; швидкі тики (вогонь) зливаються в одну,
     щоб не сипався дощ одиничок */
  for (let i = dmgPops.length - 1; i >= 0; i--)
    if (perfNow - dmgPops[i].t0 > 900) dmgPops.splice(i, 1);   // прострочені геть
  let pop = null;
  for (let i = dmgPops.length - 1; i >= 0; i--)
    if (dmgPops[i].p === v && perfNow - dmgPops[i].t0 < 280) { pop = dmgPops[i]; break; }
  if (pop) { pop.dmg += dmg; pop.redraw = true; }
  else { dmgPops.push({ p: v, dmg: dmg, t0: perfNow, redraw: true }); if (dmgPops.length > 24) dmgPops.shift(); }
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

/* ПАМ'ЯТЬ: запамʼятати позицію/швидкість щойно ПОБАЧЕНОГО ворога.
   Обʼєкт на нік створюється один раз і мутується — без сміття в гарячому циклі. */
function memRemember(p, e) {
  let m = p.mem.get(e.nick);
  if (!m) { m = { x: 0, y: 0, vx: 0, vy: 0, at: 0 }; p.mem.set(e.nick, m); }
  m.x = e.x; m.y = e.y; m.vx = e.vx; m.vy = e.vy; m.at = perfNow;
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
  const role = p.persona.role;

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
  /* 2. Лікування: поріг за характером (SURVIVOR береже себе, RUSHER терпить довше) */
  const healHp = role === 'SURVIVOR' ? 60 : (role === 'RUSHER' ? 40 : 45);
  if (p.hp < healHp && now - p.lastHurtAt > 1600 && p.state !== 'HEAL') {
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

  /* 3. Ціль серед ВИДИМИХ: пріоритет — найменше HP, далі найближчий */
  let vis = null, vd = 1e9;
  for (let i = 0; i < players.length; i++) {
    const e = players[i];
    if (e === p || !e.alive) continue;
    if (canSee(p, e)) {
      memRemember(p, e);                      // бачу → оновлюю памʼять
      const d = hyp(e.x - p.x, e.y - p.y);
      if (!vis || e.hp < vis.hp - 8 || (e.hp < vis.hp + 8 && d < vd)) { vd = d; vis = e; }
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
    /* СЛУХ: свіжий звук пострілу (і не мертва тиша >8с) — реакція за характером */
    const noise = p.memNoise;
    const noiseFresh = noise && now - noise.at < 6000 && now - lastShotHeard < 8000;
    if (noiseFresh && (role === 'RUSHER' || p.persona.aggr > 0.42)) {
      /* агресивний іде перевіряти — обережно, від укриття до укриття.
         Укриття беремо лише БЛИЖЧЕ до звуку за нас — інакше бот вічно
         топчеться біля свого поточного укриття й ніколи не доходить */
      p.state = 'SEARCH';
      p.searchUntil = now + 6000;
      const o = pickCover(p, noise.x, noise.y);
      const dNoise = hyp(p.x - noise.x, p.y - noise.y);
      let hopped = false;
      if (o && hyp(o.x - noise.x, o.y - noise.y) > 160) {
        const cp = coverPoint(o, noise.x, noise.y);
        /* стрибок лише в укриття, що НАБЛИЖАЄ до звуку і не є поточним —
           інакше бот вічно топчеться за своєю ж стіною й нікуди не йде */
        if (hyp(cp.x - noise.x, cp.y - noise.y) < dNoise - 80 &&
            hyp(cp.x - p.x, cp.y - p.y) > 40) {
          setGoal(p, cp.x, cp.y);
          hopped = true;
        }
      }
      if (!hopped) setGoal(p, noise.x + (frnd() * 2 - 1) * 70, noise.y + (frnd() * 2 - 1) * 70);
      return;
    }
    if (noiseFresh) {
      /* боязкий: позиція за укриттям ФРОНТОМ до звуку (доворот — у стані CAMP) */
      p.state = 'CAMP';
      const o = pickCover(p, noise.x, noise.y);
      if (o) { const cp = coverPoint(o, noise.x, noise.y); setGoal(p, cp.x, cp.y); }
      else setGoal(p, clamp(p.x - (noise.x - p.x) * 0.25, 60, W - 60),
                      clamp(p.y - (noise.y - p.y) * 0.25, 60, H - 60));
      p.decideAt = now + 900 + fint(600);
      return;
    }
    /* ГРА ВІД ЗОНИ у фіналі: край кола, спина в «мертве» поле, фронт усередину.
       CAMPER займає край раніше за всіх. */
    if ((aliveN <= 3 && zone.r < 300) || (role === 'CAMPER' && (aliveN <= 4 || zone.r < 430))) {
      p.state = 'EDGE';
      const a = Math.atan2(p.y - zone.cy, p.x - zone.cx) + (frnd() * 2 - 1) * 0.4;
      const rr = Math.max(40, zone.r - 55);
      setGoal(p, zone.cx + Math.cos(a) * rr, zone.cy + Math.sin(a) * rr);
      p.decideAt = now + 1200 + fint(800);
      return;
    }
    if (role === 'CAMPER') {
      /* кемпер сідає за укриття (між собою і центром — звідти зазвичай приходять) */
      p.state = 'CAMP';
      const ex = noise ? noise.x : zone.cx, ey = noise ? noise.y : zone.cy;
      const o = pickCover(p, ex, ey);
      if (o) { const cp = coverPoint(o, ex, ey); setGoal(p, cp.x, cp.y); }
      else {
        const a = frnd() * TAU;
        setGoal(p, zone.cx + Math.cos(a) * zone.r * 0.5, zone.cy + Math.sin(a) * zone.r * 0.5);
      }
      p.decideAt = now + 1600 + fint(900);
      return;
    }
    if (role === 'SURVIVOR') {
      /* кружляє по краю зони, подалі від мʼясорубки в центрі */
      p.state = 'ROAM';
      const a = Math.atan2(p.y - zone.cy, p.x - zone.cx) + 0.6 + frnd() * 0.5;
      setGoal(p, zone.cx + Math.cos(a) * zone.r * 0.72, zone.cy + Math.sin(a) * zone.r * 0.72);
      return;
    }
    if (role === 'SNIPER') {
      /* шукає відкриту позицію з довгими лініями обстрілу */
      p.state = 'ROAM';
      let bx = zone.cx, by = zone.cy, ok = false;
      for (let k = 0; k < 4 && !ok; k++) {
        const a = frnd() * TAU, rr = zone.r * (0.45 + frnd() * 0.3);
        bx = zone.cx + Math.cos(a) * rr; by = zone.cy + Math.sin(a) * rr;
        ok = inOpenField({ x: bx, y: by });
      }
      setGoal(p, bx, by);
      return;
    }
    p.state = 'ROAM';
    const a = frnd() * TAU, rr = frnd() * zone.r * 0.55;
    setGoal(p, zone.cx + Math.cos(a) * rr, zone.cy + Math.sin(a) * rr);
    return;
  }

  const t = p.target;
  const los = canSee(p, t);
  p.losToTarget = los;
  if (los) { memRemember(p, t); p.noLosSince = 0; } else if (!p.noLosSince) p.noLosSince = now;
  const noLosFor = p.noLosSince ? now - p.noLosSince : 0;
  const d = hyp(t.x - p.x, t.y - p.y);
  /* RUSHER має «коротку памʼять страху» — швидше забуває, що по ньому стріляли */
  const underFire = now - p.lastHurtAt < (role === 'RUSHER' ? 650 : 1300);
  /* настрій: характер + роль + добивання + пізня гра */
  const mood = p.persona.aggr
    + (aliveN <= 2 ? 0.22 : 0)
    + (now < aggroUntil ? 0.55 : 0)
    + (t.hp < 35 ? 0.4 : 0)
    + (zone.r < 230 ? 0.35 : 0)
    + (role === 'RUSHER' ? 0.25 : 0)
    + (role === 'SURVIVOR' ? (aliveN <= 2 ? 0.55 : -0.3) : 0)
    + (role === 'CAMPER' ? -0.2 : 0);

  if (los) {
    /* ВІДСТУП ПО HP: мало здоровʼя і ворог у контакті → рвемо LOS через укриття */
    if (p.hp < 35 && d < 480) {
      p.state = 'SEEK_COVER';
      p.coverOb = pickCover(p, t.x, t.y);
      if (p.coverOb) { const cp = coverPoint(p.coverOb, t.x, t.y); setGoal(p, cp.x, cp.y); }
      else setGoal(p, clamp(p.x + (p.x - t.x) / (d || 1) * 200, 60, W - 60),
                      clamp(p.y + (p.y - t.y) / (d || 1) * 200, 60, H - 60));
      /* смок між собою і переслідувачем — прикриває відхід на лікування */
      if (specialOk(p, aliveN) && d < 460 && frnd() < 0.85) {
        const dd = d || 1, k = Math.min(90, dd * 0.4);
        throwNade(p, p.x + (t.x - p.x) / dd * k, p.y + (t.y - p.y) / dd * k, 'smoke');
      }
      return;
    }
    /* SURVIVOR не лізе в перестрілку, поки бійців багато — тихо зникає */
    if (role === 'SURVIVOR' && aliveN > 2 && d > 260 && !underFire && frnd() < 0.6) {
      p.coverOb = pickCover(p, t.x, t.y);
      if (p.coverOb) {
        p.state = 'SEEK_COVER';
        const cp = coverPoint(p.coverOb, t.x, t.y);
        setGoal(p, cp.x, cp.y);
        return;
      }
    }
    /* SNIPER відступає при зближенні — тримає свою дистанцію */
    if (role === 'SNIPER' && d < 250 && mood < 1.1) {
      p.coverOb = pickCover(p, t.x, t.y);
      if (p.coverOb) {
        p.state = 'SEEK_COVER';
        const cp = coverPoint(p.coverOb, t.x, t.y);
        setGoal(p, cp.x, cp.y);
        return;
      }
    }
    /* CAMPER стріляє перший здалеку і не зривається в пуш без крайньої потреби */
    if ((mood > 0.9 || d > 470) && !(role === 'CAMPER' && d < 540 && mood < 1.15)) {
      p.state = 'PUSH';
      setGoal(p, t.x, t.y);
      /* RUSHER: фраг з ходу — з упередженням по вектору руху цілі */
      if (role === 'RUSHER' && p.grenades > 0 && now > p.nadeAt && d > 130 && d < 360 && frnd() < 0.5) {
        const fdur = clamp(d / 300, 0.7, 1.15);
        throwNade(p, clamp(t.x + t.vx * fdur, 40, W - 40), clamp(t.y + t.vy * fdur, 40, H - 40), 'frag');
      }
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
    /* ПАМ'ЯТЬ: передбачена точка = остання бачена позиція + вектор швидкості */
    const m = p.mem.get(t.nick);
    let px = p.lastSeenX, py = p.lastSeenY;
    if (m) {
      const lag = Math.min(1200, now - m.at) / 1000;
      px = clamp(m.x + m.vx * lag, 40, W - 40);
      py = clamp(m.y + m.vy * lag, 40, H - 40);
      if (solidAt(px, py, PR)) { px = m.x; py = m.y; }   // передбачення вперлось у стіну
    }
    const dMem = hyp(px - p.x, py - p.y);
    /* РОЗУМНІ ГРАНАТИ по засілому: молотов — ЗА укриття по памʼяті (ціль сидить),
       фраг — з упередженням по вектору руху, смок — завіса для пушу */
    const nadeReady = noLosFor > (role === 'RUSHER' ? 900 : 1800) && dMem > 120 && dMem < 380 && now > p.nadeAt;
    if (nadeReady && frnd() < (role === 'RUSHER' ? 0.7 : 0.55)) {
      const still = m && hyp(m.vx, m.vy) < 30;   // за памʼяттю ціль не рухалась — сидить
      const roll = frnd();
      if (still && roll < (role === 'CAMPER' ? 0.55 : 0.35) && specialOk(p, aliveN)) {
        throwNade(p, px, py, 'molotov');         // викурювання кемпера з укриття
      } else if (roll < 0.7) {
        if (p.grenades > 0) {
          const fdur = clamp(dMem / 300, 0.7, 1.15);
          const lvx = m ? m.vx : 0, lvy = m ? m.vy : 0;
          throwNade(p, clamp(px + lvx * fdur, 40, W - 40), clamp(py + lvy * fdur, 40, H - 40), 'frag');
        }
      } else if (specialOk(p, aliveN)) {
        /* смок — на пів-дорозі до укриття ворога: за завісою і пушимо */
        throwNade(p, p.x + (px - p.x) * 0.6, p.y + (py - p.y) * 0.6, 'smoke');
      }
    }
    const nearCover = p.coverOb && p.coverOb.alive && hyp(p.coverOb.x - p.x, p.coverOb.y - p.y) < 120;
    if ((role === 'CAMPER' || role === 'SNIPER') && mood < 0.95 &&
        (nearCover || (p.coverOb = pickCover(p, px, py)))) {
      /* терплячі архетипи не бігають за зниклим — чекають на визирці */
      p.state = 'PEEK';
      p.peekPhase = 0; p.peekAt = now + 450 + fint(650);
    } else if (noLosFor > 3200 || mood > 0.85) {
      /* ворог довго сидить — обходимо з флангу */
      p.state = 'FLANK';
      const ang = Math.atan2(py - p.y, px - p.x) + p.peekSide * 1.25;
      setGoal(p, clamp(px - Math.cos(ang) * 240, 60, W - 60),
                 clamp(py - Math.sin(ang) * 240, 60, H - 60));
    } else if (noLosFor > 600) {
      /* ПОЛЮВАННЯ: до передбаченої точки заходимо ЗБОКУ, не в лоб через укриття */
      p.state = 'SEARCH';
      p.searchUntil = now + 6000;
      const dxs = px - p.x, dys = py - p.y, ds = hyp(dxs, dys) || 1;
      setGoal(p, clamp(px - dys / ds * p.peekSide * 110, 60, W - 60),
                 clamp(py + dxs / ds * p.peekSide * 110, 60, H - 60));
    } else if (nearCover || (p.coverOb = pickCover(p, px, py))) {
      p.state = 'PEEK';
      p.peekPhase = 0; p.peekAt = now + 450 + fint(650);
    } else {
      p.state = 'PUSH';                      // щойно зник і укриттів нема — дотискаємо
      setGoal(p, px, py);
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
  let ddx = (tx - p.x) / d, ddy = (ty - p.y) / d;
  /* серпантин після влучання: напрямок «гойдається», модуль швидкості той самий */
  if (p.serpUntil > perfNow) {
    const a = Math.sin(perfNow * 0.012 + p.idx * 2.1) * 0.75;
    const ca = Math.cos(a), sa = Math.sin(a);
    const nx = ddx * ca - ddy * sa; ddy = ddx * sa + ddy * ca; ddx = nx;
  }
  const k = 1 - Math.exp(-dt * 6);                   // інерція розгону
  p.vx += (ddx * sp - p.vx) * k;
  p.vy += (ddy * sp - p.vy) * k;
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
  /* RUSHER стріляє на бігу без великого штрафу (CQB-вишкіл) — інакше
     роль, що завжди рухається, програє кожну дуель стоячим стрільцям */
  const movK = p.persona.role === 'RUSHER' ? 0.045 : 0.11;
  /* архетипний множник: снайпер купчастіший, рашер трохи «поливає» */
  return (0.09 + moving * movK + p.recoil + (d / 900) * 0.14 + fresh) * (p.persona.spreadMul || 1);
}
function fire(p) {
  const now = perfNow;
  p.ammo--; p.lastShotAt = now;
  p.recoil = Math.min(0.28, p.recoil + 0.025);
  lastShotHeard = now; lastShotX = p.x; lastShotY = p.y;
  if (now - lastShotSfx > 125) { lastShotSfx = now; sfx('pubg-shot', 0.35); } // ≤8 пострілів/с у звуці
  /* СЛУХ: постріл чутно в радіусі ~650. Хто НЕ бачить стрільця — запамʼятовує
     лише «звук звідти» (без ніка). Троттл раз на 400мс — не по кожній кулі. */
  if (now - p.lastNoiseAt > 400) {
    p.lastNoiseAt = now;
    for (let i = 0; i < players.length; i++) {
      const q = players[i];
      if (q === p || !q.alive || q.human) continue;
      if (hyp(q.x - p.x, q.y - p.y) > 650) continue;
      if (canSee(q, p)) continue;              // бачить сам — звук нічого не додає
      if (!q.memNoise) q.memNoise = { x: 0, y: 0, at: 0 };
      q.memNoise.x = p.x; q.memNoise.y = p.y; q.memNoise.at = now;
    }
  }
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
  if (p.ammo <= 0) requestReload(p);
}
function startReload(p) {
  if (p.reloading) return;
  p.reloading = true; p.reloadT0 = perfNow; p.reloadEnd = perfNow + GUN.reload;
  p.burstLeft = 0;
  p.wantReload = false;
}
/* Перезарядка ЗА укриттям: якщо ворог тримає нас у прицілі — спершу крок за
   найближче укриття, reload стартує в combat(), коли LOS розірвано (або по
   таймауту-страховці, щоб не бігати вічно з пустим магазином). */
function requestReload(p) {
  if (p.reloading || p.wantReload) return;
  const t = p.target;
  if (p.human || !t || !t.alive || !canSee(p, t)) { startReload(p); return; }
  const o = pickCover(p, t.x, t.y);
  if (!o) { startReload(p); return; }        // чисте поле — краще перезарядитись одразу
  p.wantReload = true;
  p.reloadForceAt = perfNow + 1200;
  p.state = 'SEEK_COVER';
  p.coverOb = o;
  const cp = coverPoint(o, t.x, t.y);
  setGoal(p, cp.x, cp.y);
  p.decideAt = perfNow + 600;
}
/* бойова частина кадру: доворот прицілу + черги */
function combat(p, dt) {
  const t = p.target, now = perfNow;
  if (p.reloading && now >= p.reloadEnd) { p.reloading = false; p.ammo = GUN.mag; }
  p.recoil = Math.max(0, p.recoil - dt * 0.09);
  /* відкладена перезарядка: сховались / ворог зник / вийшов таймаут-страховка */
  if (p.wantReload && !p.reloading &&
      (now >= p.reloadForceAt || !t || !t.alive || !canSee(p, t))) startReload(p);
  if (!t || !t.alive || p.healUntil) return;
  const los = canSee(p, t);
  if (los && !p.hadLos) p.firstLosAt = now;   // ціль щойно з'явилась у прицілі
  p.hadLos = los;
  p.losToTarget = los;
  if (los) { memRemember(p, t); p.lastSeenX = t.x; p.lastSeenY = t.y; p.lastSeenAt = now; p.noLosSince = 0; }
  const d = hyp(t.x - p.x, t.y - p.y);
  const want = los ? Math.atan2(t.y - p.y, t.x - p.x)
                   : Math.atan2(p.lastSeenY - p.y, p.lastSeenX - p.x);
  p.aim = lerpAng(p.aim, want, Math.min(1, dt * 7));   // швидкість довороту
  /* тактична перезарядка, поки ворога не видно */
  if (!los && !p.reloading && p.ammo < 10) startReload(p);
  if (!los || p.reloading || d > GUN.range) return;
  if (Math.abs(angDiff(p.aim, want)) > 0.14) return;
  if (p.ammo <= 0) { requestReload(p); return; }
  if (now < p.burstRestUntil || now < p.nextShotAt) return;
  if (p.burstLeft <= 0) p.burstLeft = 3 + fint(4);      // черга 3–6
  fire(p);
  p.burstLeft--; p.nextShotAt = now + GUN.rof;
  if (p.burstLeft <= 0) p.burstRestUntil = now + 520 + fint(650);
}

/* ── Керування людиною (глядач із телефону через hostNet) ──
   Чесність: та сама швидкість, що в бота (без спринт-буста), стрільба через
   той самий тракт fire/startReload (rof/ammo/reload не обійти), колізії/зона/
   урон — спільний код у update(). AI для такого бійця повністю вимкнений. */
function humanControl(p, dt) {
  const now = perfNow, inp = p.inp;
  /* канал лікування руками не тримаємо — аптечка лишається на землі */
  if (p.healUntil) { p.healUntil = 0; p.healKit = null; }
  /* fire() без цілі стріляє строго по p.aim — інакше цілився б у стару AI-ціль */
  p.target = null; p.losToTarget = false; p.hadLos = false;
  const m = hyp(inp.mx, inp.my);
  const k = 1 - Math.exp(-dt * 6);              // та сама інерція розгону, що в followGoal
  if (m > 0.05) {
    p.vx += (inp.mx / m * 115 - p.vx) * k;      // 115 — швидкість бота без спринту
    p.vy += (inp.my / m * 115 - p.vy) * k;
  } else { p.vx *= 0.8; p.vy *= 0.8; }
  p.x += p.vx * dt; p.y += p.vy * dt;
  p.walk += hyp(p.vx, p.vy) * dt * 0.05;
  p.aim = inp.aim;
  if (p.reloading && now >= p.reloadEnd) { p.reloading = false; p.ammo = GUN.mag; }
  p.recoil = Math.max(0, p.recoil - dt * 0.09);
  if (inp.fire) {
    if (p.ammo <= 0) startReload(p);
    else if (!p.reloading && now >= p.nextShotAt) {
      fire(p);
      p.nextShotAt = now + GUN.rof;
    }
  }
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
  if (p.human) {
    if (p.inp && now - p.inp.at <= 1200) { humanControl(p, dt); return; }
    /* ввід протух (лаг/пішов) → бот плавно перехоплює з нового рішення */
    p.human = false; p.decideAt = 0;
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
      /* стрейф боком, тримаємо СВОЮ дистанцію (архетипи різні) */
      if (now > p.strafeAt) { p.strafeAt = now + 700 + fint(800); p.strafeSide = -p.strafeSide; }
      if (t && t.alive) {
        const role = p.persona.role;
        const d = hyp(t.x - p.x, t.y - p.y) || 1;
        const px = -(t.y - p.y) / d, py = (t.x - p.x) / d;
        const amp = role === 'CAMPER' ? 34 : 70;      // кемпер майже не міняє позицію
        let gx = p.x + px * p.strafeSide * amp, gy = p.y + py * p.strafeSide * amp;
        const far = role === 'SNIPER' ? 520 : 450;
        const near = role === 'RUSHER' ? 150 : (role === 'SNIPER' ? 300 : 210);
        if (d > far) { gx += (t.x - p.x) / d * 120; gy += (t.y - p.y) / d * 120; }
        else if (d < near) {                          // відступ: не зближуємось даром
          const back = role === 'SNIPER' ? 130 : 90;
          gx -= (t.x - p.x) / d * back; gy -= (t.y - p.y) / d * back;
        }
        setGoal(p, gx, gy);
      }
      break;
    }
    case 'SEARCH':
      /* полювання за зниклою ціллю / перевірка звуку */
      sprint = true;
      /* без живої цілі losToTarget може лишитись протухлим true — не фліпаємо */
      if (p.losToTarget && t && t.alive) { p.state = 'ENGAGE'; p.decideAt = 0; }
      else if (now > p.searchUntil) { p.target = null; p.state = 'ROAM'; p.decideAt = 0; }
      else if (hyp(p.goalX - p.x, p.goalY - p.y) < 18) p.decideAt = 0;  // кут зачищено — далі
      break;
    case 'CAMP':
    case 'EDGE': {
      /* сидимо на позиції; без цілі — фронт до загрози (звук) або всередину зони */
      if (hyp(p.goalX - p.x, p.goalY - p.y) < 14 && (!t || !t.alive)) {
        const nz = p.memNoise && now - p.memNoise.at < 6000;
        const fx = nz ? p.memNoise.x : zone.cx, fy = nz ? p.memNoise.y : zone.cy;
        p.aim = lerpAng(p.aim, Math.atan2(fy - p.y, fx - p.x), Math.min(1, dt * 4));
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
        /* CQB-бонус рашера: впритул його черга боляча — роль виграє клінч,
           який сама ж і створює (інакше вінрейт рашера просідає до ~10%) */
        if (b.owner && b.owner.persona.role === 'RUSHER' && dist < 220) dmg *= 1.25;
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
/* Колір циферки урону: дрібний — білий, відчутний — жовтий, жирний — червоний */
function popColor(d) { return d >= 35 ? '#ff6b57' : (d >= 20 ? '#ffd93d' : '#ffffff'); }
const POP_MS = 850;   // життя циферки: злет + розчинення
function drawPops2D() {
  if (!dmgPops.length) return;
  const z = cam.z;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < dmgPops.length; i++) {
    const pp = dmgPops[i], age = (perfNow - pp.t0) / POP_MS;
    if (age >= 1) continue;
    const sx = (pp.p.x - cam.x) * z + vw / 2;
    const sy = (pp.p.y - cam.y) * z + vh / 2 - (PR + 26) * z - age * 34;
    if (sx < -40 || sx > vw + 40 || sy < -40 || sy > vh + 40) continue;
    ctx.globalAlpha = age < 0.6 ? 1 : 1 - (age - 0.6) / 0.4;
    const fs2 = Math.round((pp.dmg >= 35 ? 21 : 17) * Math.min(1.4, Math.max(0.8, z)));
    ctx.font = '800 ' + fs2 + 'px "Roboto Mono", monospace';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText('-' + pp.dmg, sx, sy);
    ctx.fillStyle = popColor(pp.dmg);
    ctx.fillText('-' + pp.dmg, sx, sy);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
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
  drawPops2D();
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
/* глядач почав керувати польотом — підказка своє відпрацювала, ховаємо одразу */
function hideFlyHint() {
  if (flyHintTimer) { clearTimeout(flyHintTimer); flyHintTimer = 0; }
  const el = document.getElementById('so-flyhint');
  if (el) el.classList.remove('show');
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
  hideFlyHint();
  fly.yaw += mx * 0.0022;
  fly.pitch = clamp(fly.pitch - my * 0.0022, -FLY_PITCH_MAX, FLY_PITCH_MAX);
}
/* true → клавіша належить польоту (хоткеї камер ◀▶/V не зачіпаємо) */
function flyKey(code, down) {
  let took = true;
  switch (code) {
    case 'KeyW': fly.kW = down; break;
    case 'KeyA': fly.kA = down; break;
    case 'KeyS': fly.kS = down; break;
    case 'KeyD': fly.kD = down; break;
    case 'Space': fly.kUp = down; break;
    case 'KeyC': case 'ControlLeft': case 'ControlRight': fly.kDn = down; break;
    case 'ShiftLeft': case 'ShiftRight': fly.kBoost = down; break;
    default: took = false;
  }
  if (took && down) hideFlyHint();
  return took;
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
const FTON = 8, SPUF = 21;  // язиків полум'я на калюжу / сфер-клубків на хмару диму

/* ══ БІОМИ ══ Мапа лобі вибирає біом фіналу (royale.js передає opts.biome:
   map1 → forest, map2 → desert, map3 → winter). Прямий RSO.start без
   опції — ліс. Все біомне зібрано тут: палітра землі (три тони + стежка),
   туман/небо/дальня земля, набір моделей на логічні слоти і периметр.
   Моделі вантажаться ЛІНИВО лише для активного біому (loadModels3D). */
/* Пропси Toon Shooter Game Kit — «база» промо-рендера: контейнери, споруди,
   водонапірка, ліхтарі, коробки, розбита машина, паркани. ОДНАКОВІ в усіх
   біомах (стиль кіта самодостатній), домішуються в models кожного біому. */
const TOON_PROPS = {
  cont1: 'toon/container.glb', cont2: 'toon/containerlong.glb',
  struct1: 'toon/struct1.glb', struct2: 'toon/struct2.glb',
  struct3: 'toon/struct3.glb', struct4: 'toon/struct4.glb',
  wtank: 'toon/watertank.glb', slight: 'toon/light.glb',
  cone: 'toon/cone.glb', pallet: 'toon/pallet.glb',
  boxes1: 'toon/boxes1.glb', boxes2: 'toon/boxes2.glb',
  boxes3: 'toon/boxes3.glb', boxes4: 'toon/boxes4.glb',
  car: 'toon/car.glb', tires: 'toon/tires.glb',
  planks: 'toon/planks.glb', tank: 'toon/tank.glb',
  keydec: 'toon/key.glb', fencem: 'toon/metalfence.glb',
};
function withToon(models) { for (const k in TOON_PROPS) models[k] = TOON_PROPS[k]; return models; }
const BIOMES = {
  /* ліс — база: соковите зелене поле під ясним теплим небом (промо-настрій);
     дерева арени — тунові Tree_1-4 кіта, підлісок — Stylized Nature MegaKit */
  forest: {
    key: 'forest',
    dirt: '#8a7050', grass: '#5fa53e', sand: '#8fa74b', far: '#569b3c',
    path: '#a8895b', pathHalf: 30, pathRocks: 18,
    fog: '#dbe8d0', fogGame: 0.00030, fogOver: 0.00008,
    sky: ['#6fb2e4', '#a9d3ec', '#e2efdd'],
    hemi: ['#d8e9f8', '#5d7c46'],
    sun: '#fff3d6',
    treeKeys: ['tree', 'tree2', 'tree3', 'tree4'],
    /* кущ-укриття — процедурні бліби (makeBush3D): два тони зелені крон кіта
       (шини з ролі куща прибрано — стос гуми читався як тверде укриття) */
    bushCols: ['#778d2b', '#657822'],
    models: withToon({
      tree: 'toon/tree1.glb', tree2: 'toon/tree2.glb', tree3: 'toon/tree3.glb', tree4: 'toon/tree4.glb',
      rock1: 'nature/rock1.glb', rock2: 'nature/rock2.glb',
      grass1: 'nature/grass1.glb', grass2: 'nature/grass2.glb',
      fern: 'nature/fern.glb', clover: 'nature/clover.glb',
      flower1: 'nature/flower1.glb', flower2: 'nature/flower2.glb',
      mushroom: 'nature/mushroom.glb',
      pebble1: 'nature/pebble1.glb', pebble2: 'nature/pebble2.glb',
      path1: 'nature/path1.glb', path2: 'nature/path2.glb',
      log1: 'nature/dead2.glb', log2: 'nature/dead4.glb',
      tree1far: 'nature/tree1far.glb', tree2far: 'nature/tree2far.glb', tree3far: 'nature/tree3far.glb',
    }),
  },
  /* пустеля: та сама тун-база, але суха жовто-пісочна земля, мертві дерева */
  desert: {
    key: 'desert',
    dirt: '#b9945a', grass: '#cfab63', sand: '#e2c684',
    far: '#c9a55f',
    path: '#97907f', pathHalf: 26, pathRocks: 34,   // сіра камʼяниста стежка, бруківка щільніша
    noiseSX: 0.0016, noiseSZ: 0.0052,   // витягнутий шум — смуги читаються як хвилі дюн
    fog: '#e2d4b2', fogGame: 0.00036, fogOver: 0.00010,
    sky: ['#8fb0d4', '#d9c491', '#ecdcae'],
    hemi: ['#eee0c4', '#8a7a52'],
    sun: '#ffedc4',
    treeKeys: ['tree', 'tree2', 'tree3', 'tree4', 'tree5'],
    bushCols: ['#9a8f52', '#857b43'],   // сухо-оливковий чагарник пустелі
    models: withToon({
      tree: 'nature/dead1.glb', tree2: 'nature/twist2.glb', tree3: 'nature/dead3.glb',
      tree4: 'nature/dead5.glb', tree5: 'nature/twist4.glb',
      rock1: 'nature/rockdes1.glb', rock2: 'nature/rockdes2.glb',
      grass1: 'nature/grassdry1.glb', grass2: 'nature/grassdry2.glb',
      plant7: 'nature/plant7.glb',
      pebble1: 'nature/pebble1.glb', pebble2: 'nature/pebble2.glb',
      path1: 'nature/path1.glb', path2: 'nature/path2.glb',
      deadfar: 'nature/deadfar.glb',
    }),
    decorSrc: { mesa: 'rock1' },   // мезаси — ті самі пустельні скелі, збільшені
  },
  /* зима: та сама тун-база на снігу, сосни з підмороженими кронами */
  winter: {
    key: 'winter',
    dirt: '#b8c0c8', grass: '#dde4ea', sand: '#eef2f6',
    far: '#dbe2e8',
    path: '#7b7268', pathHalf: 24, pathRocks: 8,
    fog: '#e4eaf0', fogGame: 0.00050, fogOver: 0.00012,
    sky: ['#93a9c2', '#ccd7e2', '#e2e8ee'],
    hemi: ['#dfe8f2', '#9aa6b2'],
    sun: '#fff6e8',
    treeKeys: ['tree', 'tree2', 'tree3', 'tree4'],
    bushCols: ['#3f5a3c', '#344f34'],   // темна хвойна зелень
    bushSnow: '#e6ecf2',                // присніжені шапки поверх блібів
    models: withToon({
      tree: 'nature/pinew2.glb', tree2: 'nature/pinew4.glb', tree3: 'nature/pinew5.glb',
      tree4: 'nature/dead3.glb',
      rock1: 'nature/rock1.glb', rock2: 'nature/rock2.glb',
      grass1: 'nature/grass1.glb',
      pebble1: 'nature/pebble1.glb', pebble2: 'nature/pebble2.glb',
      path1: 'nature/path1.glb', path2: 'nature/path2.glb',
      pinefar: 'nature/pinefar.glb',
    }),
    decorSrc: { lean1: 'tree', lean2: 'tree2' },
  },
};
let BIO = BIOMES.forest;   // активний біом бою; ставиться в apiStart ДО setup3D

/* ── Ґрунтова стежка: звивиста синусоїдна крива від краю до краю через
   центр арени. Детермінована від сіда рельєфу (_terr) — той самий бій,
   та сама стежка. Малюється вершинними кольорами землі (paintGround3D),
   декор її оминає (decorFree), бруківка сіється вздовж (planDecor3D). */
function pathZAt(x) {
  const ph = (_terr % 4096) / 4096 * TAU;
  return H / 2 + Math.sin(x * 0.0036 + ph) * (H * 0.185)
               + Math.sin(x * 0.0013 + ph * 1.7) * (H * 0.115);
}
function pathDistAt(x, y) { return Math.abs(y - pathZAt(x)); }

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

/* небо активного біому: 3 стопи градієнта (зеніт/середина/горизонт) */
function paintSky3D() {
  if (!T3A || !T3A.skyCanvas) return;
  const sg = T3A.skyCanvas.getContext('2d');
  const lin = sg.createLinearGradient(0, 0, 0, 256);
  lin.addColorStop(0, BIO.sky[0]); lin.addColorStop(0.62, BIO.sky[1]); lin.addColorStop(1, BIO.sky[2]);
  sg.fillStyle = lin; sg.fillRect(0, 0, 2, 256);
  T3A.skyTex.needsUpdate = true;
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
  /* бліб куща: ікосаедр detail=1; штатні нормалі сферично-гладкі, а
     computeVertexNormals по non-indexed геометрії дає нормалі НА ФАСЕТКУ —
     бліб читається як тун-крона кіта без окремої GLB */
  G.ico = new THREE.IcosahedronGeometry(1, 1);
  G.ico.computeVertexNormals();
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
  /* без flatShading: Lambert у r128 його не має (warn у консолі), фасетки
     й так дає non-indexed геометрія з пофасетковими нормалями */
  M.ground = new THREE.MeshLambertMaterial({ vertexColors: true });
  /* дальня земля: базовий тон палітри біому (перефарбовується у build3D) */
  M.farGround = new THREE.MeshLambertMaterial({ color: BIO.far });
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
  /* фолбеки до приходу GLB: прості зелені квади (спрайти tree-side/bush-side
     видалені разом зі старими моделями) */
  M.tree = new THREE.MeshLambertMaterial({ color: '#3d6b2f', side: THREE.DoubleSide });
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
  /* випалене коло під калюжею молотова: майже чорне «плато» до ~60% радіуса,
     далі м'який прозорий край (двостопний градієнт давав бліду пляму) */
  {
    const sc = document.createElement('canvas'); sc.width = sc.height = 64;
    const sg = sc.getContext('2d');
    const sgr = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
    sgr.addColorStop(0, 'rgba(22,15,11,0.92)');
    sgr.addColorStop(0.6, 'rgba(22,15,11,0.85)');
    sgr.addColorStop(1, 'rgba(22,15,11,0)');
    sg.fillStyle = sgr; sg.fillRect(0, 0, 64, 64);
    T3A.scorchTex = new THREE.CanvasTexture(sc);
  }
  /* ── Лоуполі-язики полум'я: 3 варіанти «крапель»-конусів із джитером бічних
     вершин і вертикальним градієнтом вершинних кольорів (жовте ядро →
     помаранч → червоно-оранжевий край). MeshBasicMaterial vertexColors —
     вогонь світиться сам, без освітлення; без прозорості (гасне масштабом),
     тож ОДИН спільний матеріал на всі язики. Джитер — власний детермінований
     хеш: terrHash тут не можна (залежить від сіда бою, а ассети — сторінкові) */
  const fRnd = function (i, k) { const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); };
  const fCols = [new THREE.Color('#ffe38a'), new THREE.Color('#ff9a2e'), new THREE.Color('#ff4a1c')];
  for (let i = 0; i < 3; i++) fCols[i].convertSRGBToLinear();   // та сама причина, що й у paintGround3D
  const fTmp = new THREE.Color();
  G.flames = [];
  for (let v = 0; v < 3; v++) {
    const fg = new THREE.ConeGeometry(0.45, 1, 6 + v, 1).toNonIndexed();
    const fp = fg.attributes.position;
    const fc = new Float32Array(fp.count * 3);
    for (let i = 0; i < fp.count; i++) {
      const t = fp.getY(i) + 0.5;   // 0 основа → 1 вістря
      if (t < 0.99 && t > 0.01) {   // бічні вершини «пливуть» — крапля, не циркуль
        fp.setX(i, fp.getX(i) * (0.8 + fRnd(i * 7 + v * 131, 1) * 0.55));
        fp.setZ(i, fp.getZ(i) * (0.8 + fRnd(i * 13 + v * 57, 2) * 0.55));
      }
      fTmp.copy(fCols[0]).lerp(fCols[1], clamp(t / 0.55, 0, 1));
      if (t > 0.55) fTmp.lerp(fCols[2], (t - 0.55) / 0.45);
      const o = i * 3; fc[o] = fTmp.r; fc[o + 1] = fTmp.g; fc[o + 2] = fTmp.b;
    }
    fg.setAttribute('color', new THREE.BufferAttribute(fc, 3));
    fg.translate(0, 0.5, 0);   // півот у основі — язик росте з землі
    G.flames.push(fg);
  }
  M.flame = new THREE.MeshBasicMaterial({ vertexColors: true });
  /* ── Пухка тун-хмара диму «цвітною капустою»: гладкі сфери-клубки у 3-х
     розмірних класах + сплюснутий варіант. Тун-затінення запечене у вершинні
     кольори по висоті (світла маківка → сірий низ, 3 тони з різкуватими
     межами) на MeshBasic БЕЗ освітлення: вигляд стабільний у будь-якому
     біомі й найдешевший. Непрозорість 0.94 — щільна хмара (вона й чесна:
     LOS крізь дим блокується у smokeBlocks) */
  G.puffs = [];
  (function () {
    const segs = [[12, 9, 1], [10, 8, 1], [10, 8, 0.78], [8, 6, 1]];   // великий/середній/сплюснутий/дрібний
    /* convertSRGBToLinear: рендерер видає sRGB — інакше тони посвітліють */
    const top = new THREE.Color('#f5f7f9').convertSRGBToLinear();
    const mid = new THREE.Color('#ccd1d9').convertSRGBToLinear();
    const low = new THREE.Color('#a2a8b3').convertSRGBToLinear();
    for (let v = 0; v < segs.length; v++) {
      const pg = new THREE.SphereGeometry(1, segs[v][0], segs[v][1]);
      if (segs[v][2] !== 1) pg.scale(1.15, segs[v][2], 1.15);
      const pp = pg.attributes.position, pc = new Float32Array(pp.count * 3);
      for (let k = 0; k < pp.count; k++) {
        const t = (pp.getY(k) / segs[v][2] + 1) / 2;   // 0 = низ … 1 = маківка
        /* межі високо, мід-смуга вузька: світла лише маківка, нижня половина
           клубка чесно сіра — двотоновий «намальований» перехід видно збоку */
        const c = t > 0.64 ? top : (t > 0.52 ? mid : low);
        pc[k * 3] = c.r; pc[k * 3 + 1] = c.g; pc[k * 3 + 2] = c.b;
      }
      pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
      G.puffs.push(pg);
    }
  })();
  M.puff = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.94 });
  /* небо: вертикальний градієнт (велика сфера BackSide) — фон + серпанок FogExp2 в тон.
     Канвас живе в T3A: paintSky3D перемальовує його під палітру біому щобою */
  T3A.skyCanvas = document.createElement('canvas'); T3A.skyCanvas.width = 2; T3A.skyCanvas.height = 256;
  T3A.skyTex = new THREE.CanvasTexture(T3A.skyCanvas);
  paintSky3D();
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
const GLB = { loader: null, ready: {}, files: {}, started: false, bioKey: '' };
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
/* один логічний слот: кеш по ФАЙЛУ вічний (GLB.files), слот (GLB.ready) —
   пер-біомний. Гард на resolve: поки модель їхала мережею, біом міг
   змінитись — чужий файл у слот не кладемо. */
function loadSlot3D(name, path, biome) {
  if (GLB.files[path]) {
    GLB.ready[name] = GLB.files[path];
    if (T3) swapIn3D(name);
    return;
  }
  loadModel(path).then(function (g) {
    const prep = glbPrep(g);
    GLB.files[path] = prep;
    if (biome && ('/assets/models/' + BIO.models[name] !== path)) return;   // біом уже інший
    GLB.ready[name] = prep;
    if (T3) swapIn3D(name);   // бій уже йде — підмінюємо живі інстанси
  }).catch(function (e) {
    try { console.warn('[RSO] Модель ' + path + ' не завантажилась, лишаємо примітив:', e); } catch (_) {}
  });
}
function loadModels3D() {
  /* ядро (зброя/укриття/аптечка/бійці) — раз на життя сторінки */
  if (!GLB.started) {
    GLB.started = true;
    /* усе ядро — Toon Shooter Game Kit: боєць (револьвер уже в кисті),
       аптечка Health, вибухова бочка, укриття */
    const defs = [
      ['soldier',   '/assets/models/toon/soldier.glb'],
      ['medkit',    '/assets/models/toon/health.glb'],
      ['barrel',    '/assets/models/toon/barrel.glb'],
      ['barrier',   '/assets/models/toon/barrier.glb'],
      ['sandbags',  '/assets/models/toon/sack.glb'],
      ['crate',     '/assets/models/toon/crate.glb'],
      ['container', '/assets/models/toon/containerlong.glb'],   // 2D 'wall' → ряд контейнерів
      ['nadefrag',  '/assets/models/toon/nadefrag.glb'],   // осколкова (і база під смок)
      ['nadefire',  '/assets/models/toon/nadefire.glb'],   // молотов у польоті
    ];
    for (let i = 0; i < defs.length; i++) loadSlot3D(defs[i][0], defs[i][1], false);
  }
  /* природа — ЛІНИВО лише для активного біому: пустелю в лісі не вантажимо */
  if (GLB.bioKey !== BIO.key) {
    GLB.bioKey = BIO.key;
    for (const k in GLB.ready)
      if (!CORE_KEYS[k] && !BIO.models[k]) delete GLB.ready[k];
    for (const k in BIO.models) {
      const full = '/assets/models/' + BIO.models[k];
      /* слот міг лишитись від минулого біому (той самий ключ — інший файл):
         чистимо, інакше build3D поставить у зимовий кущ пустельний агав */
      if (GLB.ready[k] && GLB.ready[k] !== GLB.files[full]) delete GLB.ready[k];
      loadSlot3D(k, full, true);
    }
  }
}
const CORE_KEYS = { soldier: 1, medkit: 1, barrel: 1, barrier: 1, sandbags: 1, crate: 1, container: 1, nadefrag: 1, nadefire: 1 };
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
/* дерева арени — слоти активного біому (ліс: 2 листяні + сосна; пустеля: 5
   мертвих/покручених; зима: сосни + сухостій): вибір за id перешкоди (стабільно між
   кадрами і не зсуває ігровий RNG). Дальнє декоративне кільце дерев іде НЕ
   сюди, а в запечений декор (tree*far у planDecor3D) — інакше кожне дерево
   коштує 4 draw call-и (2 матеріали x 2 проходи з тінню) */
function treeKeyOf(o) { return BIO.treeKeys[o.id % BIO.treeKeys.length]; }
/* радіус стовбура моделі (вершини нижніх 20% висоти) — рахується раз на GLB.
   Потрібен, щоб дерева з ГОЛИМ стовбуром не наїжджали стовбуром на колізію
   o.r (гравець «входив у картинку»); у сосен/сухостою при землі гілля, а не
   стовбур — їм ця метрика безглузда, тому кап на них не застосовується */
function treeTrunkR(rec) {
  if (rec.trunkR !== undefined) return rec.trunkR;
  let tr = 0;
  const yCut = rec.min.y + rec.size.y * 0.2;
  const v = new THREE.Vector3();
  rec.scene.updateMatrixWorld(true);
  rec.scene.traverse(function (m) {
    if (!m.isMesh || !m.geometry.attributes.position) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.y < yCut) tr = Math.max(tr, Math.hypot(v.x - rec.center.x, v.z - rec.center.z));
    }
  });
  rec.trunkR = tr;
  return tr;
}
function makeTree3D(o) {
  const rec = GLB.ready[treeKeyOf(o)];
  const inst = glbStatic(rec, true);
  /* масштаб від крони: стовбур-колізія (o.r) вузький, крона ширша — як у 2D */
  let s = (o.crown * 1.9) / Math.max(rec.size.x, rec.size.z, 0.001);
  /* кап великих екземплярів: голий стовбур (<35% півширини моделі — інакше
     це гілля при землі) не ширший за колізію+15%, крона жертвує до ~18% */
  const tr = treeTrunkR(rec);
  if (tr > 0.001 && tr < Math.max(rec.size.x, rec.size.z) * 0.175 && tr * s > o.r * 1.15)
    s = (o.r * 1.15) / tr;
  inst.scale.setScalar(s);
  inst.position.set(-rec.center.x * s, -rec.min.y * s, -rec.center.z * s);
  return inst;
}
/* кущ-укриття: процедурні фасеткові бліби (ікосаедри) у тонах крон кіта —
   стос шин із ролі куща прибрано, бо гума читалась як ТВЕРДЕ укриття, а кущ
   навмисно прохідний (маскування). XZ-габарит ≈ колізія (діаметр ~2.1r,
   не ширше +10%), верхівка ~36-38 юнітів — боєць (44) пірнає в крону по
   плечі. Рандом — терен-хеш від id: стабільний між кадрами, RNG не зсуває. */
let bushMatCache = { key: '', mats: [], snow: null };
function bushMats3D() {
  if (bushMatCache.key === BIO.key) return bushMatCache;
  bushMatCache = { key: BIO.key, mats: [], snow: null };
  const cols = BIO.bushCols || ['#778d2b', '#657822'];
  for (let i = 0; i < cols.length; i++)
    bushMatCache.mats.push(new THREE.MeshLambertMaterial({ color: new THREE.Color(cols[i]).convertSRGBToLinear() }));
  if (BIO.bushSnow)
    bushMatCache.snow = new THREE.MeshLambertMaterial({ color: new THREE.Color(BIO.bushSnow).convertSRGBToLinear() });
  return bushMatCache;
}
function makeBush3D(o) {
  const G = T3A.geo, mc = bushMats3D(), grp = new THREE.Group();
  const k = o.r / 30;   // розкладка тюнена під штатний r=30
  const jr = function (i) { return terrHash(o.id * 13 + i, 4271) - 0.5; };
  /* [r, x, y, z, сплюснутість]; сума зсув+радіус+джитер ≤ ~31.5 → діаметр ≤ 63 */
  const B = [[24, 0, 15, 0, 0.8], [17, 12, 10, -6, 0.85], [15, -11, 9, 7, 0.85], [12, 2, 28, 2, 0.8]];
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    const m = new THREE.Mesh(G.ico, mc.mats[i % mc.mats.length]);
    const r = (b[0] + jr(i) * 2) * k;
    m.scale.set(r, r * b[4], r);
    m.position.set((b[1] + jr(i + 4) * 3) * k, b[2] * k, (b[3] + jr(i + 8) * 3) * k);
    m.receiveShadow = true;
    grp.add(m);
  }
  if (mc.snow) {   // зимові снігові шапки — трохи ВИЩЕ верхівок блібів, інакше тонуть у зелені
    const SC = [[10, 2, 37, 2], [7, 12, 24, -6]];
    for (let i = 0; i < SC.length; i++) {
      const sb = SC[i], m = new THREE.Mesh(G.ico, mc.snow);
      m.scale.set(sb[0] * k, sb[0] * 0.45 * k, sb[0] * k);
      m.position.set(sb[1] * k, sb[2] * k, sb[3] * k);
      grp.add(m);
    }
  }
  return grp;
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
  /* XZ-масштаб — рівно від короткої сторони КОЛІЗІЇ; висота капиться ОКРЕМО
     вертикальним масштабом (~42, зріст бійця 44): старий спільний кап тягнув
     униз і XZ — барʼєр виходив на третину менший за колізію (невидима стіна) */
  const s = oS / Math.max(mS, 0.001);
  const sy = Math.min(s, 42 / Math.max(rec.size.y, 0.001));
  const secL = Math.max(mL * s, 1);
  const n = clamp(Math.round(oL / secL), 1, 6);
  const grp = new THREE.Group();
  const step = oL / n;
  /* kL тягне/тисне секцію вздовж ряду: n секцій закривають oL БЕЗ щілин і
     звисань за колізію на торцях (Container_Long раніше стирчав/розривався) */
  const kL = step / secL;
  /* stackTo: цільова ВИСОТА стіни у світових юнітах — секції складаються
     поверхами (мішки по коліна не читались як укриття, хоч і блокували кулі) */
  const rowH = Math.max(rec.size.y * sy, 1);
  const floors = stackTo ? clamp(Math.round(stackTo / rowH), 1, 4) : 1;
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < floors; f++) {
      const rot = new THREE.Group();   // поворот усередині, розтяг kL ззовні — інакше kL тиснув би поперек
      const inst = glbStatic(rec, false);
      inst.scale.set(s, sy, s);
      inst.position.set(-rec.center.x * s, -rec.min.y * sy, -rec.center.z * s);
      rot.add(inst);
      if (rec.size.z > rec.size.x) rot.rotation.y = Math.PI / 2;  // довга вісь моделі → локальний X
      const sec = new THREE.Group();
      sec.add(rot);
      sec.scale.x = kL;
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
  /* XZ точно по колізії, висота капиться окремим вертикальним масштабом —
     спільний min-масштаб робив ящик на ~12% вужчим за колізію */
  const sx = (o.hw * 2) / Math.max(rec.size.x, 0.001);
  const sz = (o.hh * 2) / Math.max(rec.size.z, 0.001);
  const sy = Math.min(sx, sz, 42 / Math.max(rec.size.y, 0.001));
  inst.scale.set(sx, sy, sz);
  inst.position.set(-rec.center.x * sx, -rec.min.y * sy, -rec.center.z * sz);
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
  const dirt = new THREE.Color(BIO.dirt).convertSRGBToLinear(),
        grass = new THREE.Color(BIO.grass).convertSRGBToLinear(),
        sand = new THREE.Color(BIO.sand).convertSRGBToLinear(),
        pathC = new THREE.Color(BIO.path).convertSRGBToLinear();
  /* пустеля розтягує головний шум у смуги — читається як хвилі дюн */
  const nsx = BIO.noiseSX || 0.0035, nsz = BIO.noiseSZ || 0.0035;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3 + W2;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3 + H2;
    /* КРУПНІ плями бруд↔трава (низька частота — поле читається великими
       м'якими зонами, не рябить) + рідші піщані «проплішини» дрібнішим шумом */
    const n = vnoise(x * nsx + 7.7, z * nsz + 3.1);
    const m = vnoise(x * 0.014 + 41.2, z * 0.014 + 17.9);
    /* зміщений поріг: більша частка поля — соковита трава, бруд лише плямами */
    c.copy(dirt).lerp(grass, clamp((n - 0.16) / 0.38, 0, 1));
    if (m > 0.68) c.lerp(sand, clamp((m - 0.68) / 0.3, 0, 1) * 0.4);
    /* витоптані ПЛЯМИ землі (промо-лук): 2 октави шуму з порогом дають
       органічні «язики» голої землі серед трави, а не смуги; краї м'які */
    const wb = vnoise(x * 0.0052 + 211.4, z * 0.0052 + 87.2) * 0.62
             + vnoise(x * 0.011 + 55.5, z * 0.011 + 31.1) * 0.38;
    if (wb > 0.62) c.lerp(pathC, clamp((wb - 0.62) / 0.06, 0, 1) * 0.85);
    /* стежка: м'який край гуляє шумом, щоб не було «лінійки» по фасетках */
    const pd = pathDistAt(x, z);
    const pw = BIO.pathHalf + (vnoise(x * 0.02 + 3.3, z * 0.02 + 9.1) - 0.5) * 16;
    if (pd < pw + 10) c.lerp(pathC, clamp((pw - pd) / 9, 0, 1) * 0.9);
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
/* тільки ігрові обʼєкти (укриття/спавни/аптечки) — спільна частина для
   звичайного розсіву і для бруківки, яка ЛЯГАЄ на стежку */
function decorObFree(x, y, m) {
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
function decorFree(x, y, m) {
  /* декор розсівається і ЗА межами арени (домальований світ до TERRA_EXT) */
  if (x < -TERRA_EXT + 60 || x > W + TERRA_EXT - 60 || y < -TERRA_EXT + 60 || y > H + TERRA_EXT - 60) return false;
  if (hyp(x - W / 2, y - H / 2) < 150) return false;   // центр — точка інтересу
  /* стежка лишається чистою — трава/кущики її не заростають */
  if (pathDistAt(x, y) < BIO.pathHalf + 8 + m * 0.4) return false;
  return decorObFree(x, y, m);
}
/* усі види запеченого декору (суперсет по всіх біомах) — список спільний
   для planDecor3D / bakeDecor3D / swapIn3D; невикористані в біомі плани
   просто порожні. lean* — нахилені дерева стіни, log* — повалені колоди,
   path* — бруківка стежки, mesa — пустельні скелі-мезаси. */
const DECOR_NAMES = ['rock1', 'rock2', 'grass1', 'grass2', 'fern', 'clover',
                     'flower1', 'flower2', 'mushroom', 'pebble1', 'pebble2',
                     'plant7', 'path1', 'path2', 'log1', 'log2', 'lean1', 'lean2',
                     'mesa', 'tree1far', 'tree2far', 'tree3far',
                     'deadfar', 'pinefar',
                     /* тун-«база»: великі споруди периметра + дрібний реквізит арени */
                     'cont1', 'cont2', 'struct1', 'struct2', 'struct3', 'struct4',
                     'wtank', 'slight', 'cone', 'pallet', 'boxes1', 'boxes2',
                     'boxes3', 'boxes4', 'car', 'tires', 'planks', 'tank',
                     'keydec', 'fencem', 'barreldec', 'cratedec'];
/* декор-ім'я → логічний слот моделі активного біому; barreldec/cratedec —
   візуальні клони CORE-моделей (бочки/ящики без колізій біля споруд) */
const DECOR_SRC_COMMON = { barreldec: 'barrel', cratedec: 'crate' };
function decorSrcOf(name) {
  return (BIO.decorSrc && BIO.decorSrc[name]) || DECOR_SRC_COMMON[name] || name;
}
function planDecor3D() {
  const plan = { baked: {} };
  for (let i = 0; i < DECOR_NAMES.length; i++) plan[DECOR_NAMES[i]] = [];
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
  /* додатковий засів УСЕРЕДИНІ арени: камера більшість часу тут, трава
     має читатися під ногами, а не лише в домальованому світі */
  const putIn = function (list, szMin, szSpan, margin, tries) {
    for (let t = 0; t < tries; t++) {
      idx++;
      const x = 50 + decorRnd(idx, 5) * (W - 100);
      const y = 45 + decorRnd(idx, 6) * (H - 90);
      if (!decorFree(x, y, margin)) continue;
      list.push({ x: x, y: y, rot: decorRnd(idx, 3) * TAU, size: szMin + decorRnd(idx, 4) * szSpan });
      return;
    }
  };
  const K = BIO.key;
  /* площа з домальованим світом ~5x арени — кількості підтягнуті під неї
     І під бюджет трикутників сцени (≤ ~300к) */
  if (K === 'desert') {
    /* пустеля: рідкий сухий підлісок — золота трава, руді кущики, пісочні камені */
    for (let i = 0; i < 40; i++) put(decorRnd(i + 1, 9) < 0.5 ? plan.rock1 : plan.rock2, 7, 9, 26, 14);
    /* 34/10 (було 64/18): зовнішній сухостій проріджено під бюджет землі 230x170 */
    for (let i = 0; i < 34; i++) put(plan.grass1, 9, 5, 14, 10);
    for (let i = 0; i < 10; i++) put(plan.grass2, 10, 5, 16, 8);
    for (let i = 0; i < 16; i++) put(plan.plant7, 8, 5, 16, 8);
    for (let i = 0; i < 26; i++) put(plan.pebble1, 2.5, 2.5, 8, 6);
    for (let i = 0; i < 26; i++) put(plan.pebble2, 2.5, 2.5, 8, 6);
    for (let i = 0; i < 46; i++) putIn(plan.grass1, 8, 4, 12, 8);
    for (let i = 0; i < 12; i++) putIn(plan.plant7, 7, 4, 14, 8);
    for (let i = 0; i < 12; i++) putIn(plan.pebble1, 2.5, 2, 8, 6);
  } else if (K === 'winter') {
    /* зима: сніг ховає підлісок — лише рідкі кущики трави і сірі камені */
    for (let i = 0; i < 30; i++) put(decorRnd(i + 1, 9) < 0.5 ? plan.rock1 : plan.rock2, 6, 8, 26, 14);
    for (let i = 0; i < 14; i++) put(plan.grass1, 8, 4, 14, 10);
    for (let i = 0; i < 18; i++) put(plan.pebble1, 2.5, 2.5, 8, 6);
    for (let i = 0; i < 18; i++) put(plan.pebble2, 2.5, 2.5, 8, 6);
    for (let i = 0; i < 10; i++) putIn(plan.grass1, 7, 3, 12, 8);
    for (let i = 0; i < 8; i++)  putIn(plan.pebble1, 2.5, 2, 8, 6);
  } else {
    /* ліс: густий підлісок (зовнішню зону ледь проріджено — її ховає стіна лісу) */
    for (let i = 0; i < 38; i++)
      put(decorRnd(i + 1, 9) < 0.5 ? plan.rock1 : plan.rock2, 6, 8, 26, 14);   // камені, 6-14 юнітів
    for (let i = 0; i < 72; i++)
      put(plan.grass1, 9, 5, 14, 10);        // головна маса: соковиті кущики трави
    for (let i = 0; i < 14; i++)
      put(plan.grass2, 10, 5, 16, 8);        // високі «віхті» — акценти
    for (let i = 0; i < 10; i++)
      put(plan.fern, 9, 4, 16, 8);
    for (let i = 0; i < 8; i++)
      put(plan.clover, 6, 3, 14, 8);
    for (let i = 0; i < 6; i++)
      put(plan.flower1, 8, 3, 16, 8);        // квіти — кольорові плями галявини
    for (let i = 0; i < 4; i++)
      put(plan.flower2, 9, 3, 16, 8);
    for (let i = 0; i < 20; i++)
      put(plan.pebble1, 2.5, 2.5, 8, 6);     // галька — дрібна, можна ближче до укриттів
    for (let i = 0; i < 20; i++)
      put(plan.pebble2, 2.5, 2.5, 8, 6);
    for (let i = 0; i < 104; i++) putIn(plan.grass1, 8, 4, 12, 8);
    for (let i = 0; i < 10; i++)  putIn(plan.clover, 6, 3, 12, 8);
    for (let i = 0; i < 5; i++)  putIn(plan.flower1, 7, 3, 14, 8);
    for (let i = 0; i < 10; i++) putIn(plan.pebble1, 2.5, 2, 8, 6);
  }
  /* бруківка стежки: RockPath-камені лягають НА стежку «місцями» (кластери
     від детермінованого гейту) + жменя гальки — читається як стара мостова */
  for (let i = 0; i < BIO.pathRocks; i++) {
    const px = 30 + ((i + 0.5) / BIO.pathRocks) * (W - 60);
    if (decorRnd(3100 + i, 1) < 0.5) continue;
    const pz = pathZAt(px) + (decorRnd(3100 + i, 2) - 0.5) * BIO.pathHalf * 1.4;
    if (!decorObFree(px, pz, 12)) continue;
    const key = decorRnd(3100 + i, 3) < 0.3 ? 'path1' : 'path2';
    plan[key].push({ x: px, y: pz, rot: decorRnd(3100 + i, 4) * TAU, size: 7 + decorRnd(3100 + i, 5) * 7, sink: 2 });
    if (decorRnd(3100 + i, 6) < 0.5)
      plan.pebble1.push({ x: px + (decorRnd(3100 + i, 7) - 0.5) * 34, y: pz + (decorRnd(3100 + i, 8) - 0.5) * 24,
                          rot: decorRnd(3100 + i, 9) * TAU, size: 2.5 + decorRnd(3100 + i, 10) * 2 });
  }
  /* повалені колоди (тільки ліс): мертві стовбури ГОРИЗОНТАЛЬНО — нахил ~90°
     навколо випадкової горизонтальної осі + втоплення, щоб лягли в рельєф.
     Декор без колізій; не в центрі, не на стежці (decorFree відсіює) */
  if (K === 'forest') {
    let logsPlaced = 0;
    for (let t = 0; t < 60 && logsPlaced < 4; t++) {
      const lx = 100 + decorRnd(4200 + t, 1) * (W - 200);
      const lz = 90 + decorRnd(4200 + t, 2) * (H - 180);
      if (!decorFree(lx, lz, 40)) continue;
      const dir = decorRnd(4200 + t, 3) * TAU;
      plan[logsPlaced % 2 ? 'log2' : 'log1'].push({
        x: lx, y: lz, rot: decorRnd(4200 + t, 4) * TAU,
        size: 58 + decorRnd(4200 + t, 5) * 26, byH: true,
        tax: Math.cos(dir), taz: Math.sin(dir), tilt: Math.PI / 2 * 0.95, sink: 2.6,
      });
      logsPlaced++;
    }
  }
  /* ── Периметр біому (за межами арени, чистий декор) ── */
  const per = 2 * (W + H);
  const perimPt = function (t, dist) {   // точка на межі арени + зсув назовні
    let d = ((t % 1) + 1) % 1 * per;
    let x, z, nx, nz;
    if (d < W) { x = d; z = 0; nx = 0; nz = -1; }
    else if ((d -= W) < H) { x = W; z = d; nx = 1; nz = 0; }
    else if ((d -= H) < W) { x = W - d; z = H; nx = 0; nz = 1; }
    else { d -= W; x = 0; z = H - d; nx = -1; nz = 0; }
    return { x: x + nx * dist, y: z + nz * dist };
  };
  /* ── Тун-«база» (усі біоми, стиль промо): великі контейнери і споруди
     кільцем ЗА межами арени замість лісової стіни впритул; водонапірка,
     танк у кутку, сітчасті паркани, ліхтарі вздовж стежки; дрібний
     реквізит (коробки/палети/конуси/шини) — розсипом у арені; великий
     безколізійний декор (машина, танк, водонапірка) — ТІЛЬКИ за межами ── */
  const BIG_RING = ['struct1', 'cont2', 'struct2', 'cont1', 'struct3', 'cont2',
                    'struct4', 'cont2', 'struct1', 'cont1', 'struct2', 'cont2'];
  /* «природний» габарит пропса: метри кіта × (зріст бійця 44 / 2.2 м) */
  const BIG_SIZE = { cont1: 44, cont2: 88, struct1: 160, struct2: 212, struct3: 158, struct4: 208 };
  for (let i = 0; i < BIG_RING.length; i++) {
    const key = BIG_RING[i];
    const p = perimPt((i + 0.15 + terrHash(8101 + i, 3) * 0.7) / BIG_RING.length,
                      95 + terrHash(8105 + i, 5) * 110);
    if (pathDistAt(p.x, p.y) < BIO.pathHalf + 50) continue;   // «ворота» стежки відкриті
    plan[key].push({ x: p.x, y: p.y, rot: terrHash(8109 + i, 7) * TAU,
                     size: BIG_SIZE[key] * (0.9 + terrHash(8113 + i, 9) * 0.3), sink: 2 });
  }
  /* водонапірка — домінанта силуету бази, по різні боки арени */
  for (let i = 0; i < 2; i++) {
    const p = perimPt(0.18 + i * 0.52 + terrHash(8201 + i, 3) * 0.08, 70 + terrHash(8205 + i, 5) * 60);
    plan.wtank.push({ x: p.x, y: p.y, rot: terrHash(8209 + i, 7) * TAU, size: 74 });
  }
  { /* танк — один, «у кутку» бази */
    const p = perimPt(0.62 + terrHash(8301, 3) * 0.05, 90);
    plan.tank.push({ x: p.x, y: p.y, rot: terrHash(8305, 5) * TAU, size: 56, sink: 1.5 });
  }
  /* сітчасті паркани короткими ланками вздовж межі арени */
  for (let i = 0; i < 8; i++) {
    const t = (i + 0.5 + terrHash(8401 + i, 3) * 0.5) / 8;
    const p = perimPt(t, 48 + terrHash(8405 + i, 5) * 22);
    if (pathDistAt(p.x, p.y) < BIO.pathHalf + 40) continue;
    const d = ((t % 1) + 1) % 1 * per;
    const yaw = (d < W || (d >= W + H && d < W * 2 + H)) ? 0 : Math.PI / 2;   // ланка паралельна своїй стороні
    plan.fencem.push({ x: p.x, y: p.y, rot: yaw, size: 70, sink: 1 });
  }
  /* ліхтарі вздовж стежки — «жила» бази; плафон нависає НАД стежкою */
  for (let i = 0; i < 5; i++) {
    const lx = 140 + (i / 4) * (W - 280);
    const side = i % 2 ? 1 : -1;
    const lz = pathZAt(lx) + side * (BIO.pathHalf + 26);
    if (!decorObFree(lx, lz, 10)) continue;
    plan.slight.push({ x: lx, y: lz, rot: side > 0 ? Math.PI : 0, size: 44 });
  }
  /* дрібний реквізит УСЕРЕДИНІ арени — лише ОЧЕВИДНО прохідна дрібнота
     (конуси, плоскі палети/дошки, ключі): крізь неї пробігти не соромно.
     Об'ємне (шини/бочки/ящики/стоси коробок) всередину НЕ сіємо — гравець
     читає його як тверде укриття, а колізії нема */
  for (let i = 0; i < 6; i++) putIn(plan.cone, 12, 4, 8, 8);
  for (let i = 0; i < 4; i++) putIn(plan.pallet, 30, 6, 10, 8);
  for (let i = 0; i < 3; i++) putIn(plan.planks, 30, 6, 10, 8);
  for (let i = 0; i < 2; i++) putIn(plan.keydec, 9, 3, 8, 8);
  /* об'ємний реквізит — на периметр бази (за полем гри, серед споруд):
     там «тверде без колізій» чесне, бо туди не добігти */
  const putPer = function (list, seed, szMin, szSpan) {
    const p = perimPt(terrHash(seed, 3), 55 + terrHash(seed, 5) * 130);
    if (pathDistAt(p.x, p.y) < BIO.pathHalf + 30) return;   // «ворота» стежки відкриті
    list.push({ x: p.x, y: p.y, rot: terrHash(seed, 7) * TAU,
                size: szMin + terrHash(seed, 9) * szSpan, sink: 1 });
  };
  for (let i = 0; i < 3; i++) putPer(plan.boxes1, 8601 + i, 20, 6);
  for (let i = 0; i < 3; i++) putPer(plan.boxes2, 8611 + i, 20, 6);
  for (let i = 0; i < 2; i++) putPer(plan.boxes3, 8621 + i, 26, 6);
  for (let i = 0; i < 2; i++) putPer(plan.boxes4, 8631 + i, 26, 6);
  for (let i = 0; i < 3; i++) putPer(plan.tires, 8641 + i, 32, 8);
  for (let i = 0; i < 4; i++) putPer(plan.barreldec, 8651 + i, 16, 3);
  for (let i = 0; i < 3; i++) putPer(plan.cratedec, 8661 + i, 18, 4);
  { /* розбита машина — на периметрі бази: всередині арени крізь неї
       пробігали б (колізії нема), а гравець читає її як тверде укриття */
    const p = perimPt(0.34 + terrHash(8501, 3) * 0.08, 75 + terrHash(8503, 5) * 50);
    if (pathDistAt(p.x, p.y) >= BIO.pathHalf + 30)
      plan.car.push({ x: p.x, y: p.y, rot: terrHash(8505, 7) * TAU,
                      size: 105 + terrHash(8507, 9) * 15, sink: 1.5 });
  }
  if (K === 'desert') {
    /* пустеля: рідші мертві дерева ЗА кільцем бази + скелі-мезаси вдалині.
       10 (було 26) і 7 мез (було 9): компенсація детальнішої землі 230x170 —
       overview пустелі має лишатись ≤ ~340к трикутників */
    for (let di = 0; di < 10; di++) {
      const p = perimPt(terrHash(9101 + di, 17), 230 + terrHash(9202 + di, 29) * 420);
      if (pathDistAt(p.x, p.y) < BIO.pathHalf + 30) continue;
      plan.deadfar.push({ x: p.x, y: p.y, rot: terrHash(9303 + di, 7) * TAU,
                          size: (30 + terrHash(9404 + di, 3) * 26) * 1.9 });
    }
    for (let di = 0; di < 7; di++) {
      const p = perimPt(terrHash(9501 + di, 11), 240 + terrHash(9602 + di, 13) * 400);
      plan.mesa.push({ x: p.x, y: p.y, rot: terrHash(9703 + di, 5) * TAU,
                       size: 110 + terrHash(9804 + di, 3) * 90, sink: 5 });
    }
  } else {
    /* ліс/зима: кільце дерев ГЛИБШЕ за базу (споруди стоять на чистому полі,
       як у промо), далі рідкі far-LOD до горизонту */
    const dense = K === 'winter';
    const putRing = function (p, di) {
      if (p.x < -TERRA_EXT + 60 || p.x > W + TERRA_EXT - 60 || p.y < -TERRA_EXT + 60 || p.y > H + TERRA_EXT - 60) return;
      if (pathDistAt(p.x, p.y) < BIO.pathHalf + 26) return;
      /* волохаті nature-кущі (bushfar) прибрано: стіна лише з дерев */
      const key = dense ? 'pinefar' : ['tree1far', 'tree2far', 'tree3far'][di % 3];
      plan[key].push({ x: p.x, y: p.y, rot: ((9000 + di) % 7) * 0.9,
                       size: (40 + terrHash(9404 + di, 3) * 26) * 1.9 });
    };
    /* власне кільце: СТРАТИФІКОВАНО по периметру (без дір), джитер уздовж і вглиб */
    const nWall = dense ? 90 : 36;
    for (let di = 0; di < nWall; di++)
      putRing(perimPt((di + terrHash(9202 + di, 29) * 0.9) / nWall,
                      240 + terrHash(9101 + di, 17) * 200), di);
    /* глибина до горизонту — рідші, випадкові: силуети в серпанку */
    const nDeep = dense ? 30 : 10;
    for (let di = 0; di < nDeep; di++)
      putRing(perimPt(terrHash(9602 + di, 23), 470 + terrHash(9101 + di, 19) * 330), 200 + di);
  }
  /* гриби — ПІД деревами (у тіні крони), а не де попало: читається як ліс */
  if (K !== 'forest') return plan;
  for (let i = 0; i < obstacles.length; i++) {
    const o = obstacles[i];
    if (o.type !== 'tree') continue;
    if (decorRnd(700 + i, 11) < 0.45) continue;   // не під кожним деревом
    const a = decorRnd(700 + i, 12) * TAU;
    const d = o.r + 8 + decorRnd(700 + i, 13) * 14;
    const x = o.x + Math.cos(a) * d, y = o.y + Math.sin(a) * d;
    if (x < -TERRA_EXT + 60 || x > W + TERRA_EXT - 60 || y < -TERRA_EXT + 60 || y > H + TERRA_EXT - 60) continue;
    plan.mushroom.push({ x: x, y: y, rot: decorRnd(700 + i, 14) * TAU, size: 3.5 + decorRnd(700 + i, 15) * 2.5 });
  }
  return plan;
}
/* Запікання декору: ОДИН merged-меш на матеріал замість 60 окремих нод
   (кущик grass1 — це 32 підмеші: клонами то були б тисячі draw-call-ів).
   Декор статичний, тож трансформи вершин рахуємо раз на CPU. */
function bakeDecor3D(name) {
  if (!T3 || !T3.decor || T3.decor.baked[name]) return;
  const rec = GLB.ready[decorSrcOf(name)], places = T3.decor[name];
  if (!rec || !places || !places.length) return;
  T3.decor.baked[name] = true;
  rec.scene.updateMatrixWorld(true);
  const meshes = [];
  rec.scene.traverse(function (m) { if (m.isMesh) meshes.push(m); });
  const buckets = [];   // {mat, pos, norm, uv}
  const M4 = new THREE.Matrix4(), R4 = new THREE.Matrix4(), S4 = new THREE.Matrix4(),
        C4 = new THREE.Matrix4(), A4 = new THREE.Matrix4(), MM = new THREE.Matrix4(),
        N3 = new THREE.Matrix3();
  const v = new THREE.Vector3(), nv = new THREE.Vector3(), ax = new THREE.Vector3();
  const span = Math.max(rec.size.x, rec.size.z, 0.001);
  for (let pi = 0; pi < places.length; pi++) {
    const pl = places[pi];
    /* моделі кіта — цілісні кущики/камінці: масштаб від горизонтального
       габариту всієї моделі (byH — від висоти: колоди мірою є довжина
       стовбура), посадка низом bbox на рельєф */
    const use = meshes,
          s = pl.byH ? pl.size / Math.max(rec.size.y, 0.001) : pl.size / span,
          cx = rec.center.x, cz = rec.center.z, my = rec.min.y;
    /* легке втоплення: фасетки рельєфу трохи відхиляються від heightAt між
       вершинами сітки — основа декору не повинна «висіти» над схилом */
    M4.makeTranslation(pl.x - W2, heightAt(pl.x, pl.y) - (pl.sink != null ? pl.sink : 1.4), pl.y - H2);
    /* нахил навколо СВІТОВОЇ горизонтальної осі, півот — основа моделі:
       дерева стіни хиляться до центру, колоди валяться в горизонталь */
    if (pl.tilt) { A4.makeRotationAxis(ax.set(pl.tax, 0, pl.taz).normalize(), pl.tilt); M4.multiply(A4); }
    R4.makeRotationY(pl.rot); S4.makeScale(s, s, s);
    C4.makeTranslation(-cx, -my, -cz);
    M4.multiply(R4).multiply(S4).multiply(C4);
    for (let mi = 0; mi < use.length; mi++) {
      const mesh = use[mi];
      MM.copy(M4).multiply(mesh.matrixWorld);
      N3.getNormalMatrix(MM);
      let bk = null;
      for (let b = 0; b < buckets.length; b++) if (buckets[b].mat === mesh.material) { bk = buckets[b]; break; }
      if (!bk) { bk = { mat: mesh.material, pos: [], norm: [], uv: [], col: [] }; buckets.push(bk); }
      const g = mesh.geometry, p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv,
            vc = g.attributes.color;   // COLOR_0 кіта: без нього vertexColors-шейдер малює ЧОРНЕ
      /* COLOR_0 у glTF — normalized ubyte/ushort, а getX() в r128 повертає СИРІ
         значення (0..255) — без масштабу кольори «вигорають» у білий */
      const vcs = vc ? (vc.normalized ? (vc.array.BYTES_PER_ELEMENT === 1 ? 1 / 255 : 1 / 65535) : 1) : 1;
      const ix = g.index, cnt = ix ? ix.count : p.count;
      for (let k = 0; k < cnt; k++) {
        const vi = ix ? ix.getX(k) : k;
        v.fromBufferAttribute(p, vi).applyMatrix4(MM);
        bk.pos.push(v.x, v.y, v.z);
        if (n) { nv.fromBufferAttribute(n, vi).applyMatrix3(N3).normalize(); bk.norm.push(nv.x, nv.y, nv.z); }
        if (u) bk.uv.push(u.getX(vi), u.getY(vi));
        if (vc) bk.col.push(vc.getX(vi) * vcs, vc.getY(vi) * vcs, vc.getZ(vi) * vcs);
      }
    }
  }
  for (let b = 0; b < buckets.length; b++) {
    const bk = buckets[b];
    const g = reg3(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bk.pos), 3));
    if (bk.norm.length === bk.pos.length) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bk.norm), 3));
    if (bk.uv.length * 3 === bk.pos.length * 2) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bk.uv), 2));
    if (bk.col.length === bk.pos.length) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(bk.col), 3));
    const mesh = new THREE.Mesh(g, bk.mat);
    /* тіні — лише помітному декору АРЕНИ: каміння, колоди, мезаси, машина,
       водонапірка, танк; споруди периметра далеко (їх тіні не читаються),
       а кожен castShadow-бакет — зайвий draw call у shadow-pass */
    mesh.castShadow = name === 'rock1' || name === 'rock2' || name === 'lean1' ||
                      name === 'lean2' || name === 'log1' || name === 'log2' || name === 'mesa' ||
                      name === 'wtank' || name === 'tank' || name === 'car';
    mesh.matrixAutoUpdate = false;
    T3.scene.add(mesh);
  }
}
/* ── Боєць: Toon Shooter Game Kit, Character_Soldier (риг CharacterArmature) —
   кліпи Idle / Idle_Shoot / Run_Gun / Run_Shoot / Death / HitReact / Wave.
   АК УЖЕ вбудований у праву кисть моделі (нода 'AK' на кістці
   пальця; зайві стволи вирізані при конвертації) — хват авторський,
   пер-кліпова калібровка не потрібна. ── */
const SOLDIER_H = 44;              // зріст у світових юнітах (гравець-коло r=16)
const SOLDIER_ROT = Math.PI / 2;   // кіт дивиться у +Z → «перед» рига +X
const CLIP_PREFIX = 'CharacterArmature|';
/* дуло: офсет спалаху в ЛОКАЛЬНИХ осях ноди AK — ствол уздовж +X
   (bbox X −0.94…2.46, лінія ствола ~Y+0.6); з конвертера ak-swap.mjs */
const GUN_MUZZLE_POS = [2.4, 0.6, 0];
function soldierClip(rec, name) {
  return THREE.AnimationClip.findByName(rec.clips, name) ||
         THREE.AnimationClip.findByName(rec.clips, CLIP_PREFIX + name);
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
  let gunNode = null;
  inst.traverse(function (m) {
    if (m.isMesh) {
      m.castShadow = true;
      m.frustumCulled = false;   // скелетні меші «зникають» край кадру без цього
      m.material = reg3(m.material.clone());   // персональний матеріал під тонування
      /* ідентифікація гравця КОЛЬОРОМ КОСТЮМА: зелена частина уніформи —
         матеріал 'Character_Main' — фарбується в p.color; Skin/Pants/чорне
         лишаються авторськими */
      if (m.material.name === 'Character_Main')
        m.material.color.set(p.color).convertSRGBToLinear();
      mats.push(m.material);   // усі меші в tintMats: сіріють у трупа, блимають від урону
    }
    if (m.name === 'AK') gunNode = m;   // вбудована зброя (група мешів)
  });
  /* спалах пострілу — спрайт на дулі вбудованого револьвера; локальний
     простір ноди = метри кіта, тож масштаб спрайта нормалізуємо через
     world-scale (кістки пальця масштабів не додають, але страхуємось) */
  let muzzle = null;
  if (gunNode) {
    /* зброя тіні не кидає: 4 меші × 4 гравці у shadow-pass не читаються,
       а draw call-и коштують */
    gunNode.traverse(function (m) { if (m.isMesh) m.castShadow = false; });
    inst.updateMatrixWorld(true);
    const ws = new THREE.Vector3();
    gunNode.getWorldScale(ws);
    const u = 1 / Math.max(ws.x, 1e-6);   // світові юніти → локальні ноди зброї
    muzzle = new THREE.Sprite(T3A.mat.flash);
    muzzle.scale.set(12 * u, 12 * u, 1);
    muzzle.position.set(GUN_MUZZLE_POS[0], GUN_MUZZLE_POS[1], GUN_MUZZLE_POS[2]);
    muzzle.visible = false;
    gunNode.add(muzzle);
  } else {
    try { console.warn('[RSO] нода AK не знайдена — спалах лишиться на ризі'); } catch (_) {}
  }
  const mixer = new THREE.AnimationMixer(inst);
  const acts = {};
  /* мапінг станів бою → кліпи кіта; біг — Run_Gun (зі зброєю в руці),
     wave — victory-стан (переможець махає глядачам за вінер-скріном) */
  const CLIPS = { idle: 'Idle', idleShoot: 'Idle_Shoot', run: 'Run_Gun', runShoot: 'Run_Shoot', death: 'Death', hit2: 'HitReact', wave: 'Wave' };
  for (const k in CLIPS) {
    const c = soldierClip(rec, CLIPS[k]);
    if (c) acts[k] = mixer.clipAction(c);
  }
  if (acts.death) {
    acts.death.setLoop(THREE.LoopOnce, 1);
    acts.death.clampWhenFinished = true;       // завмирає в фінальній позі — труп
  }
  if (acts.hit2) {
    acts.hit2.setLoop(THREE.LoopOnce, 1);
    acts.hit2.clampWhenFinished = true;        // міст до Death у ланцюжковій смерті
  }
  if (acts.idle) {
    acts.idle.play();
    acts.idle.time = (p.idx * 0.37) % (acts.idle.getClip().duration || 1);   // десинхрон айдлів
  }
  return { obj: wrap, mixer: mixer, idle: acts.idle || null, run: acts.run || null,
           acts: acts, mats: mats, muzzle: muzzle, gun: gunNode, spine: null };
}
/* повісити GLB-солдата на риг (виклик і при build, і при hot-swap) */
function attachSoldier3D(r) {
  const sd = makeSoldier3D(r.p);
  if (r.prim) { r.inner.remove(r.prim); r.prim = null; }
  r.legL = r.legR = null;
  r.inner.add(sd.obj);
  r.model = sd.obj; r.mixer = sd.mixer; r.idleA = sd.idle; r.runA = sd.run;
  r.acts = sd.acts; r.animKey = 'idle'; r.deathPlayed = false; r.deathChainAt = 0;
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
    if (name === 'nadefrag' || name === 'nadefire') {
      /* шкурки снарядів у пулі: перебудова дає GLB замість фолбек-примітивів */
      for (let i = 0; i < T3.nades.length; i++) attachNadeSkins3D(T3.nades[i]);
      return;
    }
    if (DECOR_NAMES.indexOf(name) >= 0) { bakeDecor3D(name); return; }
    /* деякі моделі арени живлять і запечений декор (стіна лісу — повні
       дерева, кущ дальнього кільця тощо): довантаження запікає і його */
    for (let dn = 0; dn < DECOR_NAMES.length; dn++)
      if (decorSrcOf(DECOR_NAMES[dn]) === name) bakeDecor3D(DECOR_NAMES[dn]);
    const list = T3.pending[name];
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      /* вибухла бочка лишається примітивним «згарищем» — не підміняємо */
      if (name === 'barrel' && it.rec && it.rec.wrecked) continue;
      while (it.holder.children.length) it.holder.remove(it.holder.children[0]);
      if (name.indexOf('tree') === 0) { it.holder.add(makeTree3D(it.o)); it.holder.rotation.y = (it.o.id % 7) * 0.9; }
      else if (name === 'medkit') it.holder.add(makeMedkit3D());
      else if (name === 'barrel') { it.holder.add(makeBarrel3D(it.o)); it.rec.isGlb = true; it.rec.mesh = null; }
      else if (name === 'barrier' || name === 'container') it.holder.add(makeRow3D(GLB.ready[name], it.o));
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
      t3Renderer.setClearColor('#c4c9a8', 1);   // у тон низу неба
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
    obHolders: [],   // {o, holder} усіх укриттів — програмна звірка візуал↔колізія (аудит)
    fires3: [], smokes3: [],   // пули зон молотова/смока
    /* холдери, що чекають на свій GLB (фолбек-примітив усередині);
       слоти дерев — за списком активного біому (у пустелі їх 5) */
    pending: (function () {
      const p = { medkit: [], barrel: [], barrier: [], sandbags: [], crate: [], container: [] };   // кущ процедурний — без pending
      for (let i = 0; i < BIO.treeKeys.length; i++) p[BIO.treeKeys[i]] = [];
      return p;
    })(),
    decor: null,   // детермінований розсів каменів/трави (bakeDecor3D)
    cpos: new THREE.Vector3(0, 900, 700), clook: new THREE.Vector3(0, 0, 0),
    dpos: new THREE.Vector3(), dlook: new THREE.Vector3(), tmpV: new THREE.Vector3(),
    tmpQ: new THREE.Quaternion(),
    orbA: 0, decalTex: null,
  };
  const S = T3.scene;
  /* біомна атмосфера: моделі природи (ліниво), небо-градієнт, серпанок,
     дальня земля і фон рендерера — все з палітри активного біому */
  loadModels3D();
  paintSky3D();
  M.farGround.color.set(BIO.far).convertSRGBToLinear();
  if (t3Renderer) t3Renderer.setClearColor(BIO.sky[2], 1);
  /* серпанок: горизонт тане в колір неба (низ градієнта); густина помірна —
     фасетки лоуполі на загальному плані не «миляться» серпанком */
  S.fog = new THREE.FogExp2(BIO.fog, BIO.fogGame);
  S.add(new THREE.Mesh(G.sky, M.sky));
  /* світло: сонце з м'якими тінями — головний «продавець» 3D — плюс заповнення
     (відбите світло неба/землі — у тон біому) */
  S.add(new THREE.HemisphereLight(BIO.hemi[0], BIO.hemi[1], 0.6));
  const sun = new THREE.DirectionalLight(BIO.sun, 1.0);
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
  /* 230x170: дрібніші фасетки — плями витоптаної землі і стежка плавніші
     (запит власника); бюджет сцени тримаємо ≤ ~340к трикутників */
  const groundGeo = reg3(new THREE.PlaneGeometry(W + TERRA_EXT * 2, H + TERRA_EXT * 2, 230, 170).toNonIndexed());
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
  /* «домальований» світ: периметр біому (стіна лісу / мезаси) живе у
     запеченому декорі — див. блок периметра в planDecor3D */
  /* шар декалей: той самий offscreen-канвас `ground`, куди 2D-код малює
     кров/кіптяву — та сама РЕЛЬЄФНА геометрія, піднята на 0.4 (без z-fight):
     декалі «стеляться» по пагорбах, а не тонуть у них */
  if (ground) {
    T3.decalTex = reg3(new THREE.CanvasTexture(ground));
    const dm = reg3(new THREE.MeshBasicMaterial({ map: T3.decalTex, transparent: true, depthWrite: false }));
    /* декалі — на ЧВЕРТЬ-сітці рельєфу (індексованій): шар без освітлення
       фасеток не потребує, а повна non-indexed копія коштувала 46к трикутників
       щокадру; підйом 1.0 ховає розбіжність грубішої сітки зі схилами */
    const decalGeo = reg3(new THREE.PlaneGeometry(W + TERRA_EXT * 2, H + TERRA_EXT * 2, 56, 42));
    decalGeo.rotateX(-Math.PI / 2);
    const dgp = decalGeo.attributes.position;
    for (let i = 0; i < dgp.count; i++)
      dgp.setY(i, heightAt(dgp.getX(i) + W2, dgp.getZ(i) + H2));
    const dp = new THREE.Mesh(decalGeo, dm);
    dp.position.y = 1.0;
    dp.renderOrder = 1;
    S.add(dp); onceUpdateMatrix(dp);
    groundDirty3D = true;
  }
  /* декор (камені/трава): план — одразу, запікання — коли GLB готовий */
  T3.decor = planDecor3D();
  for (let dn = 0; dn < DECOR_NAMES.length; dn++) bakeDecor3D(DECOR_NAMES[dn]);
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
      T3.obHolders.push({ o: o, holder: holder });
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
      T3.obHolders.push({ o: o, holder: holder });
    } else if (o.type === 'sandbag' || o.type === 'wall' || o.type === 'barrier') {
      /* мішки → траншея з мішків; барʼєр → барикада зі сміття; стіна →
         ряд вантажних контейнерів («острови» бази на прямокутних колізіях) */
      const key = o.type === 'sandbag' ? 'sandbags' : (o.type === 'wall' ? 'container' : 'barrier');
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
      T3.obHolders.push({ o: o, holder: holder });
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
      T3.obHolders.push({ o: o, holder: holder });
    } else if (o.type === 'bush') {
      /* кущ процедурний (без GLB) — будується одразу, pending не потрібен */
      const holder = new THREE.Group();
      holder.position.set(gx, gy, gz);
      holder.add(makeBush3D(o));
      holder.rotation.y = (o.id % 5) * 1.3;
      S.add(holder); onceUpdateMatrix(holder);
      T3.obHolders.push({ o: o, holder: holder });
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
    if (GLB.ready[charKeyOf(p)]) {
      try { attachSoldier3D(rec); } catch (e) { attachPrimRig3D(rec); }
    } else {
      attachPrimRig3D(rec);
    }
    T3.rigs.push(rec);
  }
}

/* шкурка снаряда з GLB: клон, нормалізований під габарит старого примітива
   і відцентрований — снаряд крутиться в польоті навколо власного центру.
   recolor: смок — це nadefrag із Green/DarkGreen, перефарбованими в біло-сіре */
function makeNadeSkin3D(rec, target, recolor) {
  const inst = glbStatic(rec, false);
  const s = target / Math.max(rec.size.x, rec.size.y, rec.size.z, 0.001);
  inst.scale.set(s, s, s);
  inst.position.set(-rec.center.x * s, -rec.center.y * s, -rec.center.z * s);
  if (recolor) inst.traverse(function (m) {
    if (!m.isMesh || !m.material || !m.material.name) return;
    if (m.material.name === 'Green') { m.material = reg3(m.material.clone()); m.material.color.set('#d9dbdd'); }
    else if (m.material.name === 'DarkGreen') { m.material = reg3(m.material.clone()); m.material.color.set('#8f959b'); }
  });
  const holder = new THREE.Group();
  holder.add(inst);
  return holder;
}
/* три «шкурки» снаряда на групі з пулу T3.nades; викликається і з buildPools3D
   (фолбек-примітиви, якщо GLB ще їде), і зі swapIn3D після довантаження */
function attachNadeSkins3D(g) {
  const G = T3A.geo, M = T3A.mat;
  while (g.children.length) g.remove(g.children[0]);
  let frag, molo, smk;
  if (GLB.ready.nadefrag) frag = makeNadeSkin3D(GLB.ready.nadefrag, 6, false);
  else {
    /* фолбек: сфера з важелем і чекою (габарит — вибір власника, ~2.25/2.6) */
    frag = new THREE.Group();
    const body = new THREE.Mesh(G.sphere, M.grenade);
    body.scale.set(2.25, 2.6, 2.25);
    const lever = new THREE.Mesh(G.box, M.gun);
    lever.scale.set(0.8, 2.1, 0.6); lever.position.set(0.8, 2.5, 0); lever.rotation.z = -0.35;
    const pin = new THREE.Mesh(G.box, reg3(new THREE.MeshBasicMaterial({ color: '#d8d8d8' })));
    pin.scale.set(1.3, 0.45, 0.45); pin.position.set(-1.2, 2.3, 0);
    frag.add(body); frag.add(lever); frag.add(pin);
  }
  if (GLB.ready.nadefire) molo = makeNadeSkin3D(GLB.ready.nadefire, 9, false);
  else {
    /* фолбек-молотов: пляшка (циліндр + шийка) з палаючою ганчіркою-спрайтом */
    molo = new THREE.Group();
    const glassM = reg3(new THREE.MeshLambertMaterial({ color: '#3f6a2f' }));
    const btl = new THREE.Mesh(G.cyl, glassM);
    btl.scale.set(2.1, 6.5, 2.1);
    const neck = new THREE.Mesh(G.cyl, glassM);
    neck.scale.set(0.95, 3.2, 0.95); neck.position.y = 4.4;
    const rag = new THREE.Sprite(M.flash);
    rag.scale.set(7, 7, 1); rag.position.y = 6.6;
    molo.add(btl); molo.add(neck); molo.add(rag);
  }
  if (GLB.ready.nadefrag) smk = makeNadeSkin3D(GLB.ready.nadefrag, 6.5, true);
  else {
    /* фолбек-смок: сіра шашка-циліндр зі світлою кришкою */
    smk = new THREE.Group();
    const can = new THREE.Mesh(G.cyl, reg3(new THREE.MeshLambertMaterial({ color: '#7d838c' })));
    can.scale.set(2.3, 6, 2.3);
    const cap = new THREE.Mesh(G.cyl, reg3(new THREE.MeshLambertMaterial({ color: '#d8d8d8' })));
    cap.scale.set(1.4, 1.2, 1.4); cap.position.y = 3.4;
    smk.add(can); smk.add(cap);
  }
  molo.visible = false; smk.visible = false;
  g.add(frag); g.add(molo); g.add(smk);
  g.userData.frag = frag; g.userData.molo = molo; g.userData.smk = smk;
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
       Шкурки — GLB (nadefrag/nadefire) з примітивним фолбеком до довантаження */
    const g = new THREE.Group();
    attachNadeSkins3D(g);
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
  /* ── Молотов-вогонь: FI3N калюж × FTON лоуполі-«крапель» полум'я (спільні
     геометрії G.flames + один M.flame: без прозорості, тож фейд — масштабом);
     під ними випалене коло, зверху — пульсуюче точкове світло ── */
  for (let i = 0; i < FI3N; i++) {
    const grp = new THREE.Group();
    /* темна пляма з м'яким прозорим краєм: свій матеріал, бо опасіті пер-калюжна */
    const scM = reg3(new THREE.MeshBasicMaterial({ map: T3A.scorchTex, transparent: true, depthWrite: false, opacity: 0 }));
    const scorch = new THREE.Mesh(G.plane, scM);
    scorch.rotation.x = -Math.PI / 2; scorch.position.y = 1.1; scorch.renderOrder = 2;
    grp.add(scorch);
    const tongues = [];
    for (let q = 0; q < FTON; q++) {
      const m = new THREE.Mesh(G.flames[q % G.flames.length], M.flame);
      const a = (q / FTON) * TAU + q * 0.9;
      const rr = q === 0 ? 0 : 0.3 + ((q * 37) % 45) / 100;   // частка радіуса калюжі
      m.userData.ox = Math.cos(a) * rr; m.userData.oz = Math.sin(a) * rr;
      m.userData.ph = q * 1.7;
      m.userData.base = q === 0 ? 1 : 0.62 + ((q * 53) % 30) / 100;   // центральний — найвищий
      grp.add(m); tongues.push(m);
    }
    const li = new THREE.PointLight('#ff7a2a', 0, 260, 2);   // помаранчеве точкове з пульсом
    li.position.y = 26;
    grp.add(li);
    grp.visible = false;
    S.add(grp);
    T3.fires3.push({ grp: grp, tongues: tongues, light: li, scorch: scorch });
  }
  /* ── Димова завіса: SK3N хмар × SPUF клубків «цвітною капустою»: великі
     сфери в серці й на маківці, середні кільцем по «плечах», дрібні каскадом
     по низу та краях — горбкуватий, майже непрозорий силует ── */
  for (let i = 0; i < SK3N; i++) {
    const grp = new THREE.Group();
    const puffs = [];
    for (let q = 0; q < SPUF; q++) {
      /* детермінований джитер від індексів: хмари різні, але відтворювані */
      const j1 = ((i * 97 + q * 57) % 100) / 100;
      const j2 = ((i * 53 + q * 83) % 100) / 100;
      let geoIdx, rad, oy, br, a;
      if (q < 4) {              // великі: серце клубка і маківка
        geoIdx = 0;
        a = q * (TAU / 4) + i * 0.8 + j1 * 0.9;
        rad = q === 0 ? 0 : 0.12 + j1 * 0.1;
        oy = q === 0 ? 0.72 : 0.5 + j2 * 0.18;
        br = 0.46 + j1 * 0.12;
      } else if (q < 12) {      // середні: кільце по «плечах»
        geoIdx = 1 + (q % 2);   // чергуємо круглий/сплюснутий — живіший силует
        a = ((q - 4) / 8) * TAU + i * 0.7 + j2 * 0.5;
        rad = 0.38 + j1 * 0.14;
        oy = 0.3 + j2 * 0.16;
        br = 0.3 + j1 * 0.1;
      } else {                  // дрібні: каскад по низу і краях
        geoIdx = 3;
        a = ((q - 12) / 9) * TAU + i * 1.3 + j1 * 0.6;
        /* каскад тягнеться до краю ігрового радіуса завіси (r=80) —
           гравець усередині кола схований і візуально, не лише в LOS */
        rad = 0.56 + j2 * 0.2;
        oy = 0.08 + j1 * 0.14;
        br = 0.2 + j2 * 0.12;
      }
      const sp = new THREE.Mesh(G.puffs[geoIdx], M.puff);
      sp.userData.ox = Math.cos(a) * rad;
      sp.userData.oz = Math.sin(a) * rad;
      sp.userData.oy = oy;
      sp.userData.br = br;
      sp.userData.ph = q * 0.9 + i * 2.1;
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
/* скруглений прямокутник вручну — ctx.roundRect є не в усіх CEF/OBS */
function rr2(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function heart2(c, cx, cy, s) {
  c.beginPath();
  c.moveTo(cx, cy + s * 0.92);
  c.bezierCurveTo(cx - s * 1.42, cy - s * 0.08, cx - s * 0.72, cy - s * 1.08, cx, cy - s * 0.38);
  c.bezierCurveTo(cx + s * 0.72, cy - s * 1.08, cx + s * 1.42, cy - s * 0.08, cx, cy + s * 0.92);
  c.closePath();
}
function drawLabel3D(rec) {
  const p = rec.p, c = rec.lctx;
  c.clearRect(0, 0, 256, 64);
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.font = '700 22px "Roboto Mono", monospace';
  const wpx = c.measureText(p.nick).width;
  if (wpx > 236) c.font = '700 ' + Math.max(14, (22 * 236 / wpx) | 0) + 'px "Roboto Mono", monospace';
  c.lineWidth = 5; c.strokeStyle = 'rgba(0,0,0,0.8)'; c.strokeText(p.nick, 128, 20);
  c.fillStyle = '#f2f2f4'; c.fillText(p.nick, 128, 20);
  /* бар за референсом власника: серце + скруглена смужка з темною обводкою,
     заливка кольору гравця (ідентифікація), сірий трек порожнього */
  const bw = 150, bh = 14, x = 64, y = 27, hpF = clamp(p.hp / p.maxHP, 0, 1);
  rr2(c, x, y, bw, bh, 7);
  c.fillStyle = '#b9bdc4'; c.fill();                 // трек
  if (hpF > 0.02) {
    c.save(); c.clip();                              // заливка не вилазить за скруглення
    c.fillStyle = p.color; c.fillRect(x, y, bw * hpF, bh);
    c.restore();
  }
  rr2(c, x, y, bw, bh, 7);
  c.lineWidth = 3; c.strokeStyle = '#14161a'; c.stroke();
  heart2(c, 46, y + bh / 2 + 1, 12);
  c.lineWidth = 4; c.strokeStyle = '#14161a'; c.stroke();
  c.fillStyle = '#e2334a'; c.fill();
  /* число N/100 — більше й окремо під баром, як у референсі */
  c.font = '800 17px "Roboto Mono", monospace';
  c.textAlign = 'right';
  const hpTxt = Math.max(0, Math.round(p.hp)) + '/' + p.maxHP;
  c.lineWidth = 4; c.strokeStyle = 'rgba(0,0,0,0.85)';
  c.strokeText(hpTxt, x + bw, 60);
  c.fillStyle = '#fff'; c.fillText(hpTxt, x + bw, 60);
  c.textAlign = 'center';
  /* броня і прогрес (перезарядка/хіл) — тонкі смужки під баром зліва */
  if (p.armor > 0) { c.fillStyle = '#c9d4e4'; c.fillRect(x, y + bh + 3, 96 * clamp(p.armor / 50, 0, 1), 3); }
  let prog = -1, pc = '#ffd93d';
  if (p.reloading) prog = (perfNow - p.reloadT0) / GUN.reload;
  else if (p.healUntil) { prog = 1 - (p.healUntil - perfNow) / 2000; pc = '#a0ff4a'; }
  if (prog >= 0) { c.fillStyle = pc; c.fillRect(x, y + bh + 8, 96 * clamp(prog, 0, 1), 3); }
  rec.ltex.needsUpdate = true;
}
/* ── Циферки урону в 3D: лінивий пул спрайтів із канвас-текстурами.
   Кожен запис dmgPops орендує спрайт: злітає над головою жертви і тане.
   redraw ставить hurt() при злитті тиків — текстура переливається раз. ── */
function popSlot3D(i) {
  if (!T3.pops) T3.pops = [];
  if (!T3.pops[i]) {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const tex = reg3(new THREE.CanvasTexture(cv));
    const mat = reg3(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    const spr = new THREE.Sprite(mat);
    spr.visible = false; spr.renderOrder = 9;
    T3.scene.add(spr);
    T3.pops[i] = { spr: spr, cv: cv, ctx: cv.getContext('2d'), tex: tex, key: '' };
  }
  return T3.pops[i];
}
function syncPops3D() {
  const camera = T3.camera, tv = T3.tmpV;
  const tanV = Math.tan(camera.fov * Math.PI / 360);
  let used = 0;
  for (let i = 0; i < dmgPops.length; i++) {
    const pp = dmgPops[i], age = (perfNow - pp.t0) / POP_MS;
    if (age >= 1) continue;
    const slot = popSlot3D(used++);
    const key = pp.dmg;
    if (slot.key !== key || pp.redraw) {
      slot.key = key; pp.redraw = false;
      const c = slot.ctx;
      c.clearRect(0, 0, 128, 64);
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '800 ' + (pp.dmg >= 35 ? 40 : 32) + 'px "Roboto Mono", monospace';
      c.lineWidth = 7; c.strokeStyle = 'rgba(0,0,0,0.85)';
      c.strokeText('-' + pp.dmg, 64, 32);
      c.fillStyle = popColor(pp.dmg);
      c.fillText('-' + pp.dmg, 64, 32);
      slot.tex.needsUpdate = true;
    }
    const gx = pp.p.x - W2, gz = pp.p.y - H2;
    const gy = heightAt(pp.p.x, pp.p.y) + 62 + age * 26;   // злітає над плашкою
    slot.spr.position.set(gx, gy, gz);
    /* екранний розмір ≈ сталий, як у лейблів */
    tv.set(gx, gy, gz);
    const d = camera.position.distanceTo(tv);
    const wh = Math.min(30, 2 * d * tanV * ((pp.dmg >= 35 ? 26 : 21) / Math.max(240, vh)));
    slot.spr.scale.set(wh * 2, wh, 1);
    slot.spr.material.opacity = age < 0.6 ? 1 : 1 - (age - 0.6) / 0.4;
    slot.spr.visible = true;
  }
  if (T3.pops) for (let i = used; i < T3.pops.length; i++) T3.pops[i].spr.visible = false;
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
          /* 50/50: чистий Death або «підкинуло — впав» (HitRecieve_2 -> Death) */
          const chain = r.acts.hit2 && frnd() < 0.5;
          for (const k in r.acts) if (k !== 'death' && k !== 'hit2') r.acts[k].fadeOut(0.1);
          if (chain) {
            /* трошки раніше кінця HitRecieve_2 — кросфейд без «завмерлої» паузи */
            r.deathChainAt = perfNow + (r.acts.hit2.getClip().duration || 0.6) * 1000 - 120;
            r.acts.hit2.reset().play();
          } else {
            r.deathChainAt = 0;
            r.acts.death.reset().play();
          }
        }
        if (r.deathChainAt && perfNow >= r.deathChainAt) {
          r.deathChainAt = 0;
          r.acts.death.reset();
          r.acts.death.play();
          r.acts.hit2.crossFadeTo(r.acts.death, 0.12, false);
        }
        if (perfNow - p.deadAt < 3600) r.mixer.update(dt);   // дограти ланцюжок і завмерти
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
/* зони молотова/смока: лоуполі-язики танцюють масштабом, тун-хмара клубочиться */
function syncAreas3D() {
  for (let i = 0; i < FI3N; i++) {
    const F = T3.fires3[i];
    if (i < fires.length) {
      const f = fires[i];
      F.grp.visible = true;
      F.grp.position.set(f.x - W2, heightAt(f.x, f.y), f.y - H2);   // калюжа на рельєфі
      /* виростання з нуля (~200мс) і згасання в останню секунду життя */
      const ease = Math.min(1, (perfNow - f.born) / 200) * clamp((f.until - perfNow) / 1000, 0, 1);
      for (let q = 0; q < F.tongues.length; q++) {
        const m = F.tongues[q], ud = m.userData;
        /* пульс у власній фазі: повільна хвиля + швидше тремтіння */
        const flick = 0.72 + 0.19 * Math.sin(perfNow * 0.006 + ud.ph)
                           + 0.09 * Math.sin(perfNow * 0.023 + ud.ph * 2.1);
        const h = f.r * 0.5 * ud.base * flick * ease;
        m.visible = h > 0.5;   // нульовий масштаб дає вироджену матрицю
        m.position.set(ud.ox * f.r * 0.68, 0.6, ud.oz * f.r * 0.68);
        m.scale.set(h * 0.8, h, h * 0.8);
        /* ледь похитується — «живий» язик, не металевий конус */
        m.rotation.x = Math.sin(perfNow * 0.004 + ud.ph) * 0.1;
        m.rotation.z = Math.cos(perfNow * 0.0035 + ud.ph * 1.3) * 0.1;
      }
      /* випалене коло проявляється й лишається до кінця (далі — decalScorch);
         нахил за схилом рельєфу — інакше плоске коло тоне в пагорбі */
      const sx = (heightAt(f.x + 16, f.y) - heightAt(f.x - 16, f.y)) / 32;
      const sz = (heightAt(f.x, f.y + 16) - heightAt(f.x, f.y - 16)) / 32;
      F.scorch.rotation.set(-Math.PI / 2 + Math.atan(sz), 0, -Math.atan(sx));
      F.scorch.position.y = 2.2;
      F.scorch.scale.set(f.r * 1.9, f.r * 1.9, 1);
      F.scorch.material.opacity = 0.8 * Math.min(1, (perfNow - f.born) / 450);
      F.light.intensity = (2.2 + Math.sin(perfNow * 0.017 + i * 2.4) * 0.8) * ease;   // пульс
      F.light.distance = f.r * 3.2;
    } else { F.grp.visible = false; F.light.intensity = 0; }
  }
  for (let i = 0; i < SK3N; i++) {
    const K = T3.smokes3[i];
    if (i < smokes.length) {
      const s = smokes[i];
      K.grp.position.set(s.x - W2, heightAt(s.x, s.y), s.y - H2);   // завіса на рельєфі
      /* надувається за ~350мс, здувається за останні ~600мс */
      const ease = clamp(Math.min((perfNow - s.born) / 350, (s.until - perfNow) / 600), 0, 1);
      K.grp.visible = ease > 0.01;
      K.grp.rotation.y = perfNow * 0.00015;   // повільне обертання клубка (0.15 рад/с)
      const breathe = 1 + 0.04 * Math.sin(perfNow * 0.0016);   // «дихання» всієї хмари
      for (let q = 0; q < K.puffs.length; q++) {
        const sp = K.puffs[q], ud = sp.userData;
        const bob = Math.sin(perfNow * 0.0021 + ud.ph) * s.r * 0.03;   // бобання своєї фази
        /* зсуви теж їдуть від ease — хмара саме НАДУВАЄТЬСЯ, а не проявляється */
        const sw = 0.4 + 0.6 * ease;
        sp.position.set(ud.ox * s.r * sw, ud.oy * s.r * sw + bob, ud.oz * s.r * sw);
        const rr = s.r * ud.br * breathe * ease;
        sp.visible = rr > 0.5;
        sp.scale.set(rr, rr * 0.88, rr);
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
    const fd = camMode === 'overview' ? BIO.fogOver : BIO.fogGame;
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
  syncPops3D();
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
  hostNet.fightEnd();   // гравцям: roster {fighting:false}, state більше не летить
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
  /* біом арени — ДО setup3D: ensureAssets3D/loadModels3D читають BIO.
     Лобі передає за слотом мапи (map1/2/3); без опції — ліс */
  BIO = BIOMES[opts.biome] || BIOMES.forest;
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
  bullets.length = 0; grenades.length = 0; explosions.length = 0; killfeed.length = 0; dmgPops.length = 0;
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
  /* дебаг: покласти дим-завісу в точку — дивитись ефект без RNG бою */
  window.__RSO_SMOKE = function (x, y) { smokes.push({ x: x || W / 2, y: y || H / 2, r: 80, born: perfNow, until: perfNow + 7000 }); };
  window.__RSO_GET = function () { return { T3: T3, players: players, heightAt: heightAt, renderer: t3Renderer, biome: BIO.key,
    obstacles: obstacles, zone: zone,
    roles: players.map(function (q) { return q.nick + ':' + q.persona.role; }) }; };
  goAt = perfNow + 3400;                              // 3-2-1-БОЙ
  initZone(goAt);
  lastShotHeard = goAt; lastShotSfx = 0;
  hostNet.fightStart();   // гравцям: roster {fighting:true} + map, далі state ~13/с
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
  hostNet.fightEnd();   // «Закрыть» без фіналу — гравцям теж {fighting:false}
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

/* ── hostNet: міст панелі-хоста до сервер-реле /ws/play ─────────
   Симуляція бою ЛИШАЄТЬСЯ в цьому браузері (чесна 2D-логіка вище) —
   сервер лише ретранслює: звідси гравцям летить map/roster/state,
   назад приходить input привʼязаних глядачів. Працює і в превʼю
   (мок приймає хоста без куки), і в проді (кука сесії йде з upgrade). */
/* МУЛЬТИПЛЕЄР ЗАКОНСЕРВОВАНО (прохання власника: «керування поки не
   потрібне, заховай — доробимо в майбутньому»). Уся інфраструктура
   робоча: сервер-реле ws-play.js, сторінка /play, цей міст і human-інпут
   у симуляції. Щоб оживити — постав true (і MP=1 на сервері bot.js). */
const MP_ENABLED = false;
const hostNet = (function () {
  let ws = null, retry = 0, reTimer = 0, stateTimer = 0;
  let fighting = false, finalNicks = [];

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/play';
  }
  function sendObj(o) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) { /* сокет обірвався */ } }
  }
  function open() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try { ws = new WebSocket(wsUrl()); } catch (e) { ws = null; schedule(); return; }
    ws.onopen = function () {
      retry = 0;
      sendObj({ t: 'hello', role: 'host' });
      /* реконект посеред бою: сервер утратив кеш → гравцям знову статика */
      if (fighting) { sendObj(rosterMsg()); sendObj(mapMsg()); }
    };
    ws.onmessage = function (ev) {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m) return;
      if (m.t === 'input') applyInput(m);
      else if (m.t === 'left') dropHuman(m.nick);
      /* 'joined' — нічого: мапу/ростер новачку шле сервер зі свого кешу */
    };
    ws.onclose = function () { ws = null; schedule(); };
    ws.onerror = function () { try { if (ws) ws.close(); } catch (e) { /* ок */ } };
  }
  function schedule() {
    if (reTimer) return;
    /* бекоф 0.5с → 15с: не довбемо сервер, але після рестарту чіпляємось швидко */
    const wait = Math.min(15000, 500 * Math.pow(2, retry++));
    reTimer = setTimeout(function () { reTimer = 0; open(); }, wait);
  }

  function findByNick(nick) {
    const k = String(nick || '').toLowerCase();
    for (let i = 0; i < players.length; i++)
      if (players[i].nick.toLowerCase() === k) return players[i];
    return null;
  }
  function applyInput(m) {
    if (!running || winnerShown) return;
    const p = findByNick(m.nick);
    if (!p || !p.alive) return;
    const num = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; };
    /* привʼязаний зайшов і після старту бою: human — з першого input */
    p.human = true;
    p.inp = {
      mx: clamp(num(m.mx), -1, 1), my: clamp(num(m.my), -1, 1),
      aim: num(m.aim), fire: !!m.fire, at: performance.now(),
    };
  }
  function dropHuman(nick) {
    const p = findByNick(nick);
    if (p && p.human) { p.human = false; p.decideAt = 0; }   // AI перехоплює одразу
  }

  const r1 = function (v) { return Math.round(v * 10) / 10; };
  const r2 = function (v) { return Math.round(v * 100) / 100; };
  function mapMsg() {
    const obs = [];
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      /* геометрія: circle → [type,x,y,r] (4 ел.), rect → [type,x,y,hw,hh] (5 ел.) */
      if (o.shape === 'circle') obs.push([o.type, Math.round(o.x), Math.round(o.y), Math.round(o.r)]);
      else obs.push([o.type, Math.round(o.x), Math.round(o.y), o.hw, o.hh]);
    }
    return { t: 'map', w: W, h: H, obs: obs };
  }
  function rosterMsg() { return { t: 'roster', fighting: fighting, finalists: finalNicks }; }
  function stateMsg() {
    const ps = [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      ps.push([p.idx, r1(p.x), r1(p.y), r2(p.aim), p.hp > 0 ? Math.round(p.hp) : 0,
               p.alive ? 1 : 0, p.human ? 1 : 0]);
    }
    const bs = [];
    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      bs.push([Math.round(b.x), Math.round(b.y), r2(Math.atan2(b.vy, b.vx))]);
    }
    const ks = [];
    for (let i = 0; i < medkits.length; i++)
      if (!medkits[i].taken) ks.push([Math.round(medkits[i].x), Math.round(medkits[i].y)]);
    const fs = [];
    for (let i = 0; i < fires.length; i++)
      fs.push([Math.round(fires[i].x), Math.round(fires[i].y), Math.round(fires[i].r)]);
    const ss = [];
    for (let i = 0; i < smokes.length; i++)
      ss.push([Math.round(smokes[i].x), Math.round(smokes[i].y), Math.round(smokes[i].r)]);
    return {
      t: 'state',
      z: zone ? { x: Math.round(zone.cx), y: Math.round(zone.cy), r: Math.round(zone.r) } : null,
      p: ps, b: bs, k: ks, f: fs, s: ss,
    };
  }

  function fightStart() {
    finalNicks = players.map(function (p) { return p.nick; });
    fighting = true;
    sendObj(rosterMsg());
    sendObj(mapMsg());
    if (stateTimer) clearInterval(stateTimer);
    /* 75мс ≈ 13 пакетів/с — у вилці 12–15 з протоколу */
    stateTimer = setInterval(function () {
      if (running && !winnerShown) sendObj(stateMsg());
    }, 75);
  }
  function fightEnd() {
    if (!fighting && !stateTimer) return;
    fighting = false;
    if (stateTimer) { clearInterval(stateTimer); stateTimer = 0; }
    sendObj(rosterMsg());
    for (let i = 0; i < players.length; i++) players[i].human = false;
  }

  if (MP_ENABLED) open();   // законсервовано: без прапорця міст сплячий
  return { fightStart: fightStart, fightEnd: fightEnd };
})();

window.RSO = {
  start: apiStart,
  stop: apiStop,
  focusNext: apiFocusNext,
  toggleOverview: apiToggleOverview,
  toggleFly: apiToggleFly,
};

})();
