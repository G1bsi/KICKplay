// ─────────────────────────────────────────────────────────────
//  💀 Карта «Few Will Survive» (копія однойменної карти з Marbles on Stream):
//  лоток → піщаний диск із лійкою → довгий крутий жолоб з S-хвилею → бульба з
//  діагональним бампером → бульба з полем червоних кілочків → хвилястий жолоб
//  з трампліном і РОЗРИВОМ → 4 смуги (2 з петлями 360°) → 4 трампліни й політ
//  у фінішну чашу над прірвою. Хто не долетів — вибув (MAP.eliminate).
//  Classic script, підключається ПІСЛЯ marbles.js (бачить його хелпери mb*/MB_*).
//  Одиниці — метри, кулька r = 0.5, потік — уздовж +x.
// ─────────────────────────────────────────────────────────────
(function () {
// підйом хвоста жолоба на h за останні L м (квадратично): кінцевий нахил +2h/L —
// кулька злітає під невеликим кутом, а не «з обриву»
function mbFewKick(pts, L, h) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  const S = cum[cum.length - 1];
  for (let i = 0; i < pts.length; i++) { const u = (cum[i] - (S - L)) / L; if (u > 0) pts[i][1] += h * u * u; }
  return pts;
}
// матеріали декору — один раз на сторінку: ядро при зміні карти чистить лише
// геометрію, тож нові матеріали на кожен build були б витоком
let mbFewMats = null;

const MAP = {
  id: 'few',
  name: 'Few Will Survive',
  icon: '💀',
  approxSec: 75,    // лідер (у грі ~1:14)
  allSec: 140,      // усі: фініш або вибули до кінця 60-с відліку
  desc: 'Песчаная воронка, поле красных штырей, петли и прыжки над пропастью — до финишной чаши долетают не все.',
  eliminate: true,
  // g 8 замість 12: на 15–18 м/с (chute2, смуги) крок Rapier зростав до 40 мс (CCD на сотнях
  // швидких кульок); при ~11 м/с ті самі ділянки коштують ~2.5 мс. Дальність польоту від g
  // не залежить (швидкість ∝ √g, час польоту ∝ 1/√g), тож розриви лишаються тими самими
  physics: { g: 8.0 },
  // пісочний камінь; небо як у Endurance, але глибше синє
  theme: {
    marble: { base: '#c9b48c', light: '#eadfc4', dark: '#7a6544', white: '#f3ecdc', a0: 0.3, a1: 0.8, dk: 0.35, wk: 0.25, grain: 8 },
    roughness: 0.62, metalness: 0.03, envInt: 0.3,
    sky: { hor: '#bfd3ec', zen: '#3b74cf' }, fog: '#cddcef', fogDensity: 0.0012, clear: '#cddcef',
    hemi: ['#dbe7f7', '#8fa3bf', 0.7], sun: ['#fff3e0', 1.05], clouds: true,
  },

  build(B) {
    const { addStage, sweepSeg, floorAtX, centerLen } = B;
    const catmull = B.catmull, turtle = B.turtle, assignY = B.assignY;
    const JD = B.C.JOIN_DROP, JE = B.C.JOIN_EXT;
    const few = B.extra.few = {}; // опорні точки для камери/декору
    const pushAux = (seg, stageId) => { B.segments.push(seg); seg.stage = stageId; seg.stageIdx = B.stages.length - 1; seg.noProgress = true; };
    const gapSeg = (id, a, b) => ({ id, kind: 'gap', center: [a.slice(), b.slice()], length: B.v.len(B.v.sub(b, a)), start: a.slice(), end: b.slice() });

    // ── 1) СТАРТОВИЙ ЛОТОК 32×16 (як у Endurance) ──
    const TRAY_L = 32, TRAY_W = 16, HINGE = [-20.5, 3.8, 0];
    const tray = {
      id: 'tray', kind: 'tray', hinge: HINGE.slice(), axis: [0, 0, 1], tiltDeg: B.C.TRAY_TILT, tiltSec: B.C.TRAY_SEC,
      L: TRAY_L, W: TRAY_W,
      boxes: [
        B.box([-TRAY_L / 2, -0.25, 0], 0, [TRAY_L / 2, 0.25, TRAY_W / 2], 'floor'),
        B.box([-TRAY_L / 2, 0.5, TRAY_W / 2 + 0.3], 0, [TRAY_L / 2, 0.75, 0.3], 'wall'),
        B.box([-TRAY_L / 2, 0.5, -TRAY_W / 2 - 0.3], 0, [TRAY_L / 2, 0.75, 0.3], 'wall'),
        B.box([-TRAY_L - 0.3, 0.5, 0], 0, [0.3, 0.75, TRAY_W / 2 + 0.6], 'wall'),
      ],
      slots: [],
      center: [[HINGE[0] - TRAY_L, HINGE[1], HINGE[2]], HINGE.slice()], length: TRAY_L,
    };
    {
      const rows = Math.floor((TRAY_L - 1.6) / B.C.TRAY_STEP);
      for (let r = 0; r < rows; r++) for (let c = 0; c < B.C.TRAY_COLS; c++) {
        tray.slots.push([-(1.3 + 0.55 + r * B.C.TRAY_STEP), B.C.R + 0.05, (c - (B.C.TRAY_COLS - 1) / 2) * B.C.TRAY_STEP]);
      }
    }
    addStage('tray', [tray], () => 12);

    // ── 2) ДИСК Ø44 З ЛІЙКОЮ Ø12 → ГОРЛО Ø5.6 (затор ~35 с на 194 кульки) ──
    const DISC = [0, 0, 0];
    // горло Ø4.8: потік ∝ (D−1.4d)^2.5 — 194 кульки цідяться ~35 с (як затор 0–40 с у грі)
    const R_DISC = 22, R_FUN = 6, R_TH = 2.7, Y_RIM = 1.6, H_FUN = 10, Y_TH = -12; // 2.4 цідило хвіст 70 с — з рухомими перешкодами далі він не встигав до кінця відліку
    const profile = [
      [R_TH, Y_TH - 0.5], [R_TH, -H_FUN], [R_FUN, 0], [R_DISC, Y_RIM], [R_DISC, Y_RIM + 2.0],
      [R_DISC + 1, Y_RIM + 2.0], [R_DISC + 1, Y_RIM - 1.2], [R_FUN + 1.2, -1.0], [R_TH + 1.0, -H_FUN - 0.6], [R_TH + 1.0, Y_TH - 0.5],
    ];
    const lathe = B.lathe(DISC, profile, [[0, 1], [1, 2], [2, 3], [3, 4]], 48, 1.0);
    const disc = {
      id: 'disc', kind: 'lathe', c: DISC.slice(), profile, N: 48, mesh: lathe.mesh, plates: lathe.plates,
      rDisc: R_DISC, rFunnel: R_FUN, rThroat: R_TH, yRim: Y_RIM, yThroat: Y_TH,
      center: [HINGE.slice(), [0, 0.3, 0], [0, Y_TH, 0]], length: 0,
    };
    disc.length = centerLen(disc.center);
    addStage('disc', [disc], (seg, i) => i === 0 ? 26 : 7);

    // ── 3) ХАБ ПІД ГОРЛОМ (борти 5 м — кульки прилітають ~13 м/с) І ДОВГИЙ ЖОЛОБ ──
    const HUB_Y = -14.5;
    const hub = sweepSeg('hub', [[-4.5, HUB_Y, 0], [10, HUB_Y - 2.0, 0]], { w0: 8, w1: 7, H: 5 });
    const hubCap = { id: 'hubCap', kind: 'boxes', boxes: [B.box([-4.8, HUB_Y + 0.8, 0], 0, [0.4, 1.4, 5.5], 'wall')], balls: [], center: hub.center, length: hub.length };
    addStage('hub', [hub], () => 9);
    pushAux(hubCap, 'hub');

    // крутий прямий жолоб 230 м зі спуском 24 м (як довжелезна пряма в грі); крутіше —
    // 15 м/с і крок фізики знову 9 мс; хвиля наприкінці ледь помітна (амплітуда 1.5):
    // сильніша S коштувала 3–4 м/с на кожному вигині об борт
    const c1Y0 = hub.end[1] - JD;
    const chute1 = sweepSeg('chute1', assignY(catmull([[9.7, 0, 0], [18, 0, 0], [80, 0, 0], [170, 0, 0], [196, 0, 1.5], [216, 0, -1.5], [230, 0, 0], [240, 0, 0]], 2), c1Y0, c1Y0 - 24),
      { w0: 7, H: 3, vBank: 12, maxBank: 26 });
    addStage('chute1', [chute1], seg => seg.w0 / 2 + 3.5);

    // ── 4) БУЛЬБА 7→18→7 З ДІАГОНАЛЬНИМ ЧЕРВОНИМ БАМПЕРОМ ──
    const b1X = chute1.end[0] - JE, b1Y = chute1.end[1] - JD;
    const widen1 = sweepSeg('widen1', [[b1X, b1Y, 0], [b1X + 12, b1Y - 2.0, 0]], { w0: 7, w1: 18, wEase: true, H: 4.5 });
    addStage('widen1', [widen1], () => 12);
    // бампер — у середній частині сталої ширини: у розширенні його кінець підходив до борту
    // на 1.35 м, і кульки клинились у цій щілині
    const m1X = widen1.end[0] - JE, m1Y = widen1.end[1] - JD;
    // борти 4.5 м: на 13 м/с бампер (відскок 0.9) перекидав кульки через 3-метровий борт.
    // Середина бульби ПЛАСКА: палка крутиться навколо вертикалі, і на похилій підлозі один
    // її кінець тонув би, а другий висів (перепад 2 м на 14 м)
    const mid1 = sweepSeg('mid1', [[m1X, m1Y, 0], [m1X + 12, m1Y - 0.3, 0]], { w0: 18, H: 4.5 });
    addStage('mid1', [mid1], () => 12);
    {
      // палка-пропелер, як у грі: крутиться (оберт за ~12 с), з двома прорізами по 1.8 м,
      // крізь які кульки проскакують; зверху білі «кнопки» — лише вигляд (вище за кульку)
      const bx = m1X + 6, by = floorAtX(mid1, bx);
      const boxes = [], balls = [];
      for (const cx of [-5.2, 0, 5.2]) boxes.push({ pos: [cx, 0.7, 0], quat: [0, 0, 0, 1], size: [1.7, 0.7, 0.32], role: 'bumper' });
      for (let k = -6; k <= 6; k += 1.5) { if (Math.abs(Math.abs(k) - 3.5) < 0.9) continue; balls.push({ pos: [k, 1.55, 0], r: 0.28 }); }
      pushAux({ id: 'propeller', kind: 'spinner', c: [bx, by, 0], axis: [0, 1, 0], omega: 0.5, phase: 35 * B.D2R, boxes, balls, red: true, friction: 0.25, restitution: 0.55 }, 'mid1');
    }
    const n1X = mid1.end[0] - JE, n1Y = mid1.end[1] - JD;
    const narrow1 = sweepSeg('narrow1', [[n1X, n1Y, 0], [n1X + 12, n1Y - 3.7, 0]], { w0: 18, w1: 7, wEase: true, H: 4.5 });
    addStage('narrow1', [narrow1], () => 12);
    const s1X = narrow1.end[0] - JE, s1Y = narrow1.end[1] - JD;
    const str1 = sweepSeg('str1', [[s1X, s1Y, 0], [s1X + 30, s1Y - 4.2, 0]], { w0: 7, H: 3 });
    addStage('str1', [str1], seg => seg.w0 / 2 + 3.5);

    // ── 5) БУЛЬБА 7→16→7 З ПОЛЕМ ЧЕРВОНИХ КІЛОЧКІВ (7 рядів шахівкою) ──
    const w2X = str1.end[0] - JE, w2Y = str1.end[1] - JD;
    const widen2 = sweepSeg('widen2', [[w2X, w2Y, 0], [w2X + 12, w2Y - 2.0, 0]], { w0: 7, w1: 16, wEase: true, H: 3 });
    addStage('widen2', [widen2], () => 12);
    const fX = widen2.end[0] - JE, fY = widen2.end[1] - JD;
    const field = sweepSeg('field', [[fX, fY, 0], [fX + 18, fY - 2.8, 0]], { w0: 16, H: 3 });
    addStage('field', [field], () => 12);
    {
      // поле поршнів, як у грі: червоні куполи (сфери r 1.2) рядами поперек жолоба; кожен ряд —
      // окреме кінематичне тіло, що ПІДНІМАЄТЬСЯ на 1.6 м і утворює стінку (сусідні куполи
      // торкаються — кулька не проскочить), потім опускається до 0.25 над підлогою (легкий
      // горбик). Фази рядів зміщені: стінки біжать хвилею, кульки проходять пачками.
      // Роль 'bumper' не годиться (відскок 0.9 кидав кульки назад угору на 15 м)
      const ROWS = 6, PERIOD = 2.6; // піднімаються лише ряди 1 і 3, у кожному один купол пропущено: 3 суцільні стінки тримали хвіст 70 с, і його ранжувало за прогресом
      for (let i = 0; i < ROWS; i++) {
        const x = fX + 3 + i * 2.4, off = (i & 1) ? 1.2 : 0;
        const c = [x, floorAtX(field, x), 0], balls = [];
        const lifting = i === 1 || i === 3, gapJ = i === 1 ? 1 : -1;
        for (let j = -3; j <= 3; j++) {
          const z = j * 2.4 + off;
          if (Math.abs(z) > 6.3) continue;
          if (lifting && j === gapJ) continue; // пропуск у стінці
          balls.push({ pos: [0, -0.95, z], r: 1.2 });
        }
        pushAux({ id: 'pegs' + i, kind: 'spinner', c, axis: [0, 1, 0], omega: 0, phase: 0, lift: lifting ? { amp: 1.6, omega: 2 * Math.PI / PERIOD, phase: i === 1 ? 0 : Math.PI } : null, boxes: [], balls, red: true, friction: 0.45, restitution: 0.3 }, 'field');
      }
    }
    const n2X = field.end[0] - JE, n2Y = field.end[1] - JD;
    const narrow2 = sweepSeg('narrow2', [[n2X, n2Y, 0], [n2X + 12, n2Y - 2.0, 0]], { w0: 16, w1: 7, wEase: true, H: 3 });
    addStage('narrow2', [narrow2], () => 12);

    // ── 6) ЖОЛОБ 110 м → ТРАМПЛІН → РОЗРИВ 8 м → ЗОНА ПРИЗЕМЛЕННЯ ──
    const c2X = narrow2.end[0] - JE, c2Y = narrow2.end[1] - JD;
    // хвиля лише ледь помітна (амплітуда 1) і тільки в першій половині: на крені кулька
    // «скакала» по скрученій підлозі і злітала з трампліна під випадковим кутом
    const c2pts = assignY(catmull([[c2X, 0, 0], [c2X + 10, 0, 0], [c2X + 30, 0, 1], [c2X + 50, 0, -1], [c2X + 68, 0, 0], [c2X + 90, 0, 0], [c2X + 110, 0, 0]], 2), c2Y, c2Y - 18);
    // трамплін: +1.6 м за 8 м проти ухилу 18% → зліт під ~12°; +0.7 за 6 м давало майже плаский зліт
    mbFewKick(c2pts, 8, 1.6);
    const chute2 = sweepSeg('chute2', c2pts, { w0: 7, H: 3, vBank: 12, maxBank: 26 });
    addStage('chute2', [chute2], seg => seg.w0 / 2 + 3.5);
    few.ramp1 = { end: chute2.end.slice(), dir: chute2.endDir.slice() };
    // розрив: повільніші за ~9 м/с не долітають і вибувають
    const GAP1 = 8, DROP1 = 3.5;
    const l1 = [chute2.end[0] + GAP1, chute2.end[1] - DROP1, 0];
    const gap1 = gapSeg('gap1', chute2.end, l1);
    addStage('gap1', [gap1], () => 25);
    const land1 = sweepSeg('land1', [l1, [l1[0] + 46, l1[1] - 4.6, 0]], { w0: 10, H: 3.5 });
    addStage('land1', [land1], () => 25);
    few.land1 = land1.start.slice();

    // ── 7) ПЛИТА 10 → 22.8 І ЧОТИРИ СМУГИ: віяло → петлі 360° на крайніх → сходження → трампліни ──
    const LANE_W = 4.5, LANE_T = B.C.LANE_T, LANE_PITCH = LANE_W + 2 * LANE_T;
    const LANES_Z = [-1.5 * LANE_PITCH, -0.5 * LANE_PITCH, 0.5 * LANE_PITCH, 1.5 * LANE_PITCH];
    const LANES_FOOT = 4 * LANE_W + 6 * LANE_T;
    const pX = land1.end[0] - JE, pY = land1.end[1] - JD;
    const plate = sweepSeg('plate', [[pX, pY, 0], [pX + 14.6, pY - 2, 0]], { w0: 10, w1: LANES_FOOT, wEase: true, H: 3 });
    addStage('plate', [plate], () => 15);
    const LX = plate.end[0] - JE, laneY0 = plate.end[1] - JD, LANE_DROP = 17;
    // віяло мʼяке (±16, не ±27): у крутих вигинах крайні смуги втрачали 4–5 м/с об борт;
    // петлі крутяться назовні, тож сусіднім смугам не заважають
    // петля r 8 (не 5.5): у тісній петлі кулька їхала бортом і виходила на 8 м/с проти 14 у сусідів
    const LOOP_R = 8, laneOut = [-16, -7, 7, 16], laneIn = [-9.6, -3.2, 3.2, 9.6];
    const LANE_END = LX + 164;
    const lanes = [];
    for (let k = 0; k < 4; k++) {
      const z0 = LANES_Z[k], z1 = laneOut[k], z2 = laneIn[k], sg = z1 > 0 ? 1 : -1, outer = k === 0 || k === 3;
      const fan = catmull([[LX, 0, z0], [LX + 6, 0, z0], [LX + 24, 0, (z0 + z1) / 2], [LX + 42, 0, z1], [LX + 48, 0, z1]], 2);
      let mid;
      if (outer) {
        const xl = LX + 60 + (k === 0 ? 0 : 8);
        mid = turtle(LX + 48, z1, 0).fwd(xl - LX - 48).arc(sg * 360, LOOP_R).fwd(LX + 98 - xl).pts;
      } else {
        // внутрішні смуги прямі: навіть мʼяка хвиля (амплітуда 3) зʼїдала 6 м/с об борт
        mid = turtle(LX + 48, z1, 0).fwd(50).pts;
      }
      // петльові смуги на 50 м довші: при спільному перепаді їхній ухил менший і кульки
      // виходили на трамплін на 7 м/с проти 13. Тому їм — додаткові 5.2 м спуску (той самий
      // ухил) і трамплін на 8 м ближче до чаші: нижчий старт польоту компенсується відстанню
      const xEnd = LANE_END + (outer ? 8 : 0);
      const conv = catmull([[LX + 98, 0, z1], [LX + 106, 0, z1], [LX + 126, 0, (z1 + z2) / 2], [LX + 146, 0, z2], [LX + 154, 0, z2], [xEnd, 0, z2]], 2);
      const pts = fan.concat(mid.slice(1), conv.slice(1));
      assignY(pts, laneY0, laneY0 - LANE_DROP - (outer ? 5.2 : 0));
      mbFewKick(pts, 8, 1.6);
      lanes.push(sweepSeg('lane' + (k + 1), pts, { w0: LANE_W, t: LANE_T, branch: k + 1, vBank: 10, maxBank: 30, H: 2.5 }));
    }
    addStage('lanes', lanes, seg => seg.w0 / 2 + 3.5);
    {
      const boxes = [];
      for (let k = 0; k < 3; k++) boxes.push(...B.nose(LX, plate.end[1] + 0.7, (LANES_Z[k] + LANES_Z[k + 1]) / 2, LANE_T));
      pushAux({ id: 'laneNoses', kind: 'boxes', boxes, balls: [] }, 'lanes');
    }
    few.ramps = lanes.map(l => ({ end: l.end.slice(), dir: l.endDir.slice() }));
    const rampY = lanes[1].end[1]; // внутрішні смуги (крайні закінчуються нижче)

    // ── 8) ПОЛІТ У ФІНІШНУ ЧАШУ 26×26 над прірвою ──
    // дальність ≈ v·2 с (спуск 14 м, зліт ~12°): ближній борт на +24.5 м — долітають внутрішні
    // швидші за ~12.5 м/с і петльові (трамплін на 8 м ближче) швидші за ~10.5 м/с; це ~третина вибулих
    const BOWL = 26, BOWL_GAP = 24.5, BOWL_DROP = 14, BW_H = 4.5, CORNER = 4, TILT = 0.06;
    const bX = LANE_END + BOWL_GAP + BOWL / 2, bY = rampY - BOWL_DROP;
    const gap2 = gapSeg('gap2', [LANE_END, rampY, 0], [LANE_END + BOWL_GAP, bY, 0]);
    addStage('gap2', [gap2], () => 25);
    // підлога нахилена 6% до дальнього борту: усі кульки скочуються до сенсора фінішу
    const ta = Math.atan(TILT), tFloorQ = B.quatFromBasis([Math.cos(ta), -Math.sin(ta), 0], [Math.sin(ta), Math.cos(ta), 0], [0, 0, 1]);
    const bowl = {
      id: 'bowl', kind: 'boxes', balls: [], boxes: [
        { pos: [bX, bY - 0.3, 0], quat: tFloorQ, size: [BOWL / 2 + 0.6, 0.3, BOWL / 2 + 0.6], role: 'floor' },
        B.box([bX + BOWL / 2 + 0.5, bY + BW_H / 2 - 0.6, 0], 0, [0.5, BW_H / 2 + 0.6, BOWL / 2 - CORNER + 0.5], 'wall'),   // дальній — вищий
        B.box([bX, bY + BW_H / 2 - 0.5, BOWL / 2 + 0.5], 0, [BOWL / 2 - CORNER + 0.5, BW_H / 2 + 0.5, 0.5], 'wall'),
        B.box([bX, bY + BW_H / 2 - 0.5, -BOWL / 2 - 0.5], 0, [BOWL / 2 - CORNER + 0.5, BW_H / 2 + 0.5, 0.5], 'wall'),
        B.box([bX - BOWL / 2 - 0.5, bY + BW_H / 2 - 0.2, 0], 0, [0.5, BW_H / 2 + 0.2, BOWL / 2 - CORNER + 0.5], 'wall'),   // ближній
      ],
      size: BOWL, corner: CORNER, c: [bX, bY, 0], wallH: BW_H,
      center: [[bX - BOWL / 2, bY + TILT * BOWL / 2, 0], [bX + BOWL / 2, bY - TILT * BOWL / 2, 0]], length: BOWL,
    };
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = bX + sx * (BOWL / 2 - CORNER / 2 + 0.35), cz = sz * (BOWL / 2 - CORNER / 2 + 0.35);
      // yaw +45° для кутів (+,+)/(−,−): поворот навколо Y на θ веде вісь x у (cos θ, −sin θ), тож
      // −45° давало плиту вздовж діагоналі (радіально), а не поперек кута
      bowl.boxes.push(B.box([cx, bY + BW_H / 2 - 0.5, cz], sx * sz > 0 ? Math.PI / 4 : -Math.PI / 4, [CORNER * 0.75, BW_H / 2 + 0.5, 0.5], 'wall'));
    }
    addStage('bowl', [bowl], () => 20);
    few.bowl = bowl.c.slice(); few.laneEnd = [LANE_END, rampY, 0]; few.bowlNear = [bX - BOWL / 2, bY, 0];

    // сенсор — півкуля біля дальнього борту, відкрита назад у чашу: ті, хто впав перед
    // чашею (26 м далі), і ті, хто перелетів (за бортом), не зараховуються
    B.finish = { p: [bX + BOWL / 2 - 1.2, bY - TILT * BOWL / 2 + 0.6, 0], f: [-1, 0, 0], r: 14.5, s: B.S() };
    B.tray = tray;
    B.extra.disc = disc;
    B.extra.orbit = bowl.c.slice();
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W]);
  },

  intro(track, pos, look) {
    const H = track.tray.hinge, L = track.tray.L;
    pos.set(H[0] - L - 34, H[1] + 30, H[2] - 40);
    look.set(H[0] - 6, H[1] - 2, H[2] + 4);
  },

  // режисура: диск, вихід з горла, обидва польоти — збоку, щоб видно й тих, хто летить, і тих, хто падає
  camera(st, leader, pos, look) {
    const track = st.track, disc = track.disc, stg = track.stages, s = leader.prog, few = track.extra.few;
    if (!few.sIdx) { few.sIdx = {}; for (const g of stg) few.sIdx[g.id] = g; }
    const S = few.sIdx;
    if (s >= S.disc.s0 - 6 && s < S.hub.s0) { pos.set(disc.c[0] - 30, disc.c[1] + 20, disc.c[2] - 18); look.set(disc.c[0], disc.c[1] - 5, disc.c[2]); return true; }
    if (s < S.chute1.s0 + 30) {
      const hub = track.byId.hub;
      pos.set(leader.x - 34, hub.start[1] + 8, hub.start[2] + 38);
      look.set(leader.x + 6, leader.y - 1, leader.z * 0.6);
      return true;
    }
    if (s >= S.gap1.s0 - 14 && s < S.land1.s0 + 18) {
      const r = few.ramp1.end;
      pos.set(r[0] + 4, r[1] + 10, r[2] + 44); // з боку +z: потік зліва направо, як у грі
      look.set(r[0] + 12, r[1] - 3, 0);
      return true;
    }
    if (s >= S.lanes.s1 - 16) {
      const e = few.laneEnd;
      pos.set(e[0] - 4, e[1] + 16, 58);
      look.set(e[0] + 22, e[1] - 8, 0);
      return true;
    }
    return false;
  },

  // декор: START на лотку, логотип на диску, темні обідки бортів, помаранчеві ферми,
  // червоні прапорці й золоті пластини трамплінів, LED-обідок чаші
  decor(track, ctx) {
    const { THREE, trayGroup, mats } = ctx;
    const few = track.extra.few;
    if (!mbFewMats) {
      mbFewMats = {
        dark: new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.7, metalness: 0.05 }),
        orange: new THREE.MeshStandardMaterial({ color: '#e8651c', roughness: 0.55, metalness: 0.15 }),
        gold: new THREE.MeshStandardMaterial({ color: '#ffd23a', emissive: '#b98600', emissiveIntensity: 0.7, roughness: 0.4, metalness: 0.2 }),
      };
    }
    const M = mbFewMats;
    const addMesh = (parts, mat, ro) => { if (!parts.length) return; const m = new THREE.Mesh(ctx.mergeParts(parts), mat); m.castShadow = true; m.receiveShadow = true; if (ro) m.renderOrder = ro; ctx.scene.add(m); };
    // орієнтований бокс: центр, базис (x — уздовж, y — вгору), півдіагоналі
    const obox = (pos, x, y, size) => { const z = ctx ? [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]] : null; return ctx.boxPart({ pos, quat: mbQuatFromBasis(x, y, z), size }); };

    if (trayGroup) {
      const geo = new THREE.PlaneGeometry(track.tray.W - 1.2, 2.4);
      geo.rotateX(-Math.PI / 2); geo.rotateY(Math.PI / 2);
      const uvA = geo.getAttribute('uv'); for (let i = 0; i < uvA.count; i++) uvA.setX(i, uvA.getX(i) * 2);
      const m = new THREE.Mesh(geo, mats.start); m.position.set(-1.6, 0.03, 0); m.receiveShadow = true;
      trayGroup.add(m);
    }
    // логотип на диску: кільцева смуга на увігнутій поверхні
    {
      const d = track.disc, N = 64, r0 = d.rFunnel + 0.8, r1 = d.rDisc - 0.6;
      const yAt = r => (r - d.rFunnel) / (d.rDisc - d.rFunnel) * d.yRim + 0.06;
      const pos = new Float32Array(2 * N * 3), uv = new Float32Array(2 * N * 2), idx = new Uint32Array(N * 6);
      for (let k = 0; k < N; k++) {
        const phi = k * 2 * Math.PI / N;
        for (let j = 0; j < 2; j++) {
          const r = j ? r1 : r0, v = k * 2 + j;
          const x = d.c[0] + r * Math.cos(phi), z = d.c[2] + r * Math.sin(phi);
          pos[v * 3] = x; pos[v * 3 + 1] = d.c[1] + yAt(r); pos[v * 3 + 2] = z;
          uv[v * 2] = (z - d.c[2]) / (2 * d.rDisc) + 0.5; uv[v * 2 + 1] = (x - d.c[0]) / (2 * d.rDisc) + 0.5;
        }
        const k1 = (k + 1) % N, a = k * 2, b = k * 2 + 1, c2 = k1 * 2, dd = k1 * 2 + 1;
        idx.set([a, c2, b, b, c2, dd], k * 6);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
      const m = new THREE.Mesh(geo, mats.logo); m.renderOrder = 1;
      ctx.scene.add(m);
    }
    // темні обідки: стрічка з 3 точок поперек на гребені кожного борту всіх жолобів (один меш)
    {
      const parts = [];
      for (const g of track.segments) {
        if (g.kind !== 'sweep') continue;
        const F = g.frames, n = F.length, hw = g.t / 2;
        for (const sg of [1, -1]) {
          const pos = new Float32Array(n * 3 * 3), nrm = new Float32Array(n * 3 * 3), uv = new Float32Array(n * 3 * 2), idx = new Uint32Array((n - 1) * 12);
          for (let i = 0; i < n; i++) {
            const f = F[i], xc = sg * (f.w / 2 + hw);
            const prof = [[xc - sg * hw * 0.85, g.H - 0.16], [xc, g.H + 0.03], [xc + sg * hw * 0.85, g.H - 0.16]];
            for (let j = 0; j < 3; j++) {
              const q = prof[j], v = i * 3 + j;
              pos[v * 3] = f.p[0] + f.r[0] * q[0] + f.u[0] * q[1]; pos[v * 3 + 1] = f.p[1] + f.r[1] * q[0] + f.u[1] * q[1]; pos[v * 3 + 2] = f.p[2] + f.r[2] * q[0] + f.u[2] * q[1];
              nrm[v * 3] = f.u[0]; nrm[v * 3 + 1] = f.u[1]; nrm[v * 3 + 2] = f.u[2];
              uv[v * 2] = f.s / 8; uv[v * 2 + 1] = j / 2;
            }
            if (i + 1 < n) {
              const a = i * 3, b = (i + 1) * 3, o = i * 12;
              // обхід: при погляді згори проти годинника (нормаль угору)
              const tri = (p, q, r, k) => { if (sg > 0) { idx[k] = p; idx[k + 1] = r; idx[k + 2] = q; } else { idx[k] = p; idx[k + 1] = q; idx[k + 2] = r; } };
              tri(a, b, a + 1, o); tri(a + 1, b, b + 1, o + 3); tri(a + 1, b + 1, a + 2, o + 6); tri(a + 2, b + 1, b + 2, o + 9);
            }
          }
          parts.push({ pos, nrm, uv, idx });
        }
      }
      addMesh(parts, M.dark);
    }
    // помаранчеві ферми-решітки вздовж жолоба між диском і полем кілочків (два боки)
    {
      const parts = [];
      const floorY = x => { let best = 1e9, y = 0; for (const g of track.segments) { if (g.kind !== 'sweep') continue; for (const f of g.frames) { const d = Math.abs(f.p[0] - x); if (d < best) { best = d; y = f.p[1]; } } } return y; };
      const truss = (x0, x1, z, dz, seed) => {
        const nodes = [];
        for (let x = x0; x <= x1 + 0.01; x += 12) nodes.push([x, floorY(x) + 2.2 + Math.sin(x * 0.11 + seed) * 1.6, z + Math.sin(x * 0.07 + seed) * dz]);
        const up0 = [0, 1, 0];
        for (let i = 0; i + 1 < nodes.length; i++) {
          const a = nodes[i], b = nodes[i + 1], d = B_v.norm(B_v.sub(b, a)), L = B_v.len(B_v.sub(b, a));
          const side = B_v.norm(B_v.cross(d, up0)), up = B_v.norm(B_v.cross(side, d));
          const mid = B_v.lerp(a, b, 0.5);
          for (const h of [0, 2.4]) parts.push(obox(B_v.add(mid, B_v.scale(up, h)), d, up, [L / 2, 0.2, 0.2]));
          for (const h of [0, 2.4]) parts.push(obox(B_v.add(B_v.add(mid, B_v.scale(up, h)), B_v.scale(side, 1.6)), d, up, [L / 2, 0.16, 0.16]));
          const nd = Math.max(2, Math.round(L / 3));
          for (let k = 0; k < nd; k++) {
            const p0 = B_v.add(a, B_v.scale(d, L * k / nd)), p1 = B_v.add(B_v.add(a, B_v.scale(d, L * (k + 1) / nd)), B_v.scale(up, 2.4));
            const q0 = (k & 1) ? p1 : p0, q1 = (k & 1) ? [p0[0], p0[1], p0[2]] : p1;
            const dd = B_v.sub(q1, q0), dl = B_v.len(dd), dn = B_v.norm(dd), du = B_v.norm(B_v.cross(side, dn));
            parts.push(obox(B_v.lerp(q0, q1, 0.5), dn, du, [dl / 2, 0.11, 0.11]));
            parts.push(obox(B_v.add(p0, B_v.scale(up, 1.2)), up, d, [1.2, 0.11, 0.11]));
            parts.push(obox(B_v.add(B_v.add(p0, B_v.scale(up, 1.2)), B_v.scale(side, 0.8)), side, up, [0.8, 0.11, 0.11]));
          }
        }
      };
      const B_v = { add: vAdd, sub: vSub, scale: vScale, cross: vCross, len: vLen, norm: vNorm, lerp: vLerp };
      truss(160, 340, 13.5, 2.0, 0.3);
      truss(260, 420, -14.5, 2.5, 2.1);
      addMesh(parts, M.orange);
    }
    // трампліни: червоні прапорці на бортах і золоті пластини на підлозі
    {
      const red = [], gold = [];
      const ramps = [few.ramp1].concat(few.ramps);
      for (const r of ramps) {
        const seg = track.segments.find(g => g.kind === 'sweep' && g.end === g.end && Math.hypot(g.end[0] - r.end[0], g.end[2] - r.end[2]) < 0.01);
        if (!seg) continue;
        const f = seg.frames[seg.frames.length - 1], t = f.t, u = f.u, rr = f.r;
        const hw = f.w / 2, ht = seg.t / 2;
        for (const sg of [1, -1]) {
          const p = vAdd(vAdd(vAdd(f.p, vScale(rr, sg * (hw + ht))), vScale(u, seg.H + 0.7)), vScale(t, -1.4));
          red.push(obox(p, t, u, [1.3, 0.75, 0.32]));
        }
        gold.push(obox(vAdd(vAdd(f.p, vScale(t, -2.4)), vScale(u, 0.03)), t, u, [2.2, 0.03, hw - 0.4]));
      }
      addMesh(red, mats.red);
      addMesh(gold, M.gold, 1);
    }
    // LED-обідок фінішної чаші
    {
      const parts = [];
      for (const b of track.byId.bowl.boxes.filter(b => b.role === 'wall')) {
        const long = b.size[0] > b.size[2] ? 0 : 2;
        const L = 2 * b.size[long] + 0.2, Wd = 1.1;
        const geo = new THREE.PlaneGeometry(L, Wd);
        geo.rotateX(-Math.PI / 2);
        if (long === 2) geo.rotateY(Math.PI / 2);
        const uvA = geo.getAttribute('uv'); for (let i = 0; i < uvA.count; i++) uvA.setX(i, uvA.getX(i) * L / 6);
        const q = new THREE.Quaternion(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
        geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(b.pos[0], b.pos[1] + b.size[1] + 0.03, b.pos[2]), q, new THREE.Vector3(1, 1, 1)));
        parts.push({ pos: new Float32Array(geo.getAttribute('position').array), nrm: new Float32Array(geo.getAttribute('normal').array), uv: new Float32Array(uvA.array), idx: new Uint32Array(geo.getIndex().array) });
        geo.dispose();
      }
      addMesh(parts, mats.finish, 1);
    }
  },
};
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
