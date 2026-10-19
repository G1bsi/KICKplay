// ─────────────────────────────────────────────────────────────
//  🌀 Карта «Endurance Test» (копія карти з Marbles on Stream): лоток, що
//  нахиляється → диск з лійкою → 2 S-рукави → 4 смуги з коркскрю → овал з
//  бампером → зигзаг → 2 спіралі → бампер і 4 смуги → S-крива → спуск у чашу.
//  Classic script, підключається ПІСЛЯ marbles.js (користується його
//  будівельником B і глобальними хелперами mb*/MB_*). Реєструється в MB_MAPS.
//  Одиниці — метри, кулька r = 0.5, потік траси — вздовж +x.
// ─────────────────────────────────────────────────────────────
(function () {
const MAP = {
  id: 'endurance',
  name: 'Endurance Test',
  icon: '🌀',
  approxSec: 142,   // лідер (у грі ~2:20)
  allSec: 200,      // усі 194 (з 60-с відліком)
  desc: 'Лоток, воронка, 4 полосы с петлями, зигзаг, две спирали, финишная чаша. Синий мрамор над облаками.',
  eliminate: false,
  theme: { marble: null },   // палітра за замовчуванням ядра — синьо-білий мармур

  build(B) {
    const { addStage, sweepSeg, floorAtX, joinStart, centerLen } = B;
  // ── 1) СТАРТОВИЙ ЛОТОК: 32×16 м, бортики 1.2 м, кульки сіткою 14×N ──
  const TRAY_L = 32, TRAY_W = 16, HINGE = [-20.5, 3.8, 0];
  const tray = {
    id: 'tray', kind: 'tray', hinge: HINGE.slice(), axis: [0, 0, 1], tiltDeg: MB_TRAY_TILT, tiltSec: MB_TRAY_SEC,
    L: TRAY_L, W: TRAY_W,
    boxes: [ // локальні координати відносно hinge; нахил — поворот навколо z
      mbBox([-TRAY_L / 2, -0.25, 0], 0, [TRAY_L / 2, 0.25, TRAY_W / 2], 'floor'),
      mbBox([-TRAY_L / 2, 0.5, TRAY_W / 2 + 0.3], 0, [TRAY_L / 2, 0.75, 0.3], 'wall'),
      mbBox([-TRAY_L / 2, 0.5, -TRAY_W / 2 - 0.3], 0, [TRAY_L / 2, 0.75, 0.3], 'wall'),
      mbBox([-TRAY_L - 0.3, 0.5, 0], 0, [0.3, 0.75, TRAY_W / 2 + 0.6], 'wall'),
    ],
    slots: [], // локальні позиції центрів кульок (перший ряд — біля краю)
    center: [[HINGE[0] - TRAY_L, HINGE[1], HINGE[2]], HINGE.slice()], length: TRAY_L,
  };
  {
    const rows = Math.floor((TRAY_L - 1.6) / MB_TRAY_STEP);
    for (let r = 0; r < rows; r++) for (let c = 0; c < MB_TRAY_COLS; c++) {
      tray.slots.push([-(1.3 + 0.55 + r * MB_TRAY_STEP), MB_R + 0.05, (c - (MB_TRAY_COLS - 1) / 2) * MB_TRAY_STEP]);
    }
  }
  addStage('tray', [tray], () => 12);

  // ── 2) ДИСК З ЛІЙКОЮ: тарілка Ø44 (ледь увігнута), обідок 2 м, лійка Ø12 → горло Ø4 ──
  const DISC = [0, 0, 0];
  // горло Ø5.6: потік крізь отвір ~(D−1.4d)^2.5 (Беверлу) — при Ø4 194 кульки цідились 120с, тут ~35с
  const R_DISC = 22, R_FUN = 6, R_TH = 2.8, Y_RIM = 1.6, H_FUN = 10, Y_TH = -12;
  const profile = [
    [R_TH, Y_TH - 0.5], [R_TH, -H_FUN], [R_FUN, 0], [R_DISC, Y_RIM], [R_DISC, Y_RIM + 2.0],
    [R_DISC + 1, Y_RIM + 2.0], [R_DISC + 1, Y_RIM - 1.2], [R_FUN + 1.2, -1.0], [R_TH + 1.0, -H_FUN - 0.6], [R_TH + 1.0, Y_TH - 0.5],
  ];
  const lathe = mbLathe(DISC, profile, [[0, 1], [1, 2], [2, 3], [3, 4]], 48, 1.0);
  const disc = {
    id: 'disc', kind: 'lathe', c: DISC.slice(), profile, N: 48, mesh: lathe.mesh, plates: lathe.plates,
    rDisc: R_DISC, rFunnel: R_FUN, rThroat: R_TH, yRim: Y_RIM, yThroat: Y_TH,
    center: [HINGE.slice(), [0, 0.3, 0], [0, Y_TH, 0]], length: 0,
  };
  disc.length = centerLen(disc.center);
  addStage('disc', [disc], (seg, i) => i === 0 ? 26 : 7);

  // ── 3) ХАБ І ДВА S-РУКАВИ ──
  // хаб: широкий короткий жолоб під горлом (задня стінка — cap), розширюється до розвилки
  const HUB_Y = -14.5, ARM_W = 7, ARM_Z = 4.2;
  // хаб — зона приземлення з горла (кульки прилітають ~13 м/с і розлітаються): борти 5 м
  const hub = sweepSeg('hub', [[-4.5, HUB_Y, 0], [10, HUB_Y - 2.0, 0]], { w0: 8, w1: 2 * (ARM_Z + ARM_W / 2), H: 5 });
  const hubCap = { id: 'hubCap', kind: 'boxes', boxes: [mbBox([-4.8, HUB_Y + 0.8, 0], 0, [0.4, 1.4, 6.5], 'wall')], balls: [], center: hub.center, length: hub.length };
  addStage('hub', [hub], () => 9);
  B.segments.push(hubCap); hubCap.stage = 'hub'; hubCap.stageIdx = B.stages.length - 1; hubCap.noProgress = true;

  // рукави: дзеркальні S-хвилі (амплітуда ~15 м) з спуском 16 м, банк авто
  const armDrop = 26, armY0 = hub.end[1] - MB_JOIN_DROP;
  const armCtrl = [[9.7, ARM_Z], [16, 4.6], [26, 10], [36, 18], [46, 19], [56, 12], [66, 5], [76, 6], [86, 13], [96, 18.5], [106, 12], [114, 6], [122, 5.5], [126, 5.5]];
  const ARM_END_X = 126;
  const arms = [];
  for (const sg of [1, -1]) {
    const ctrl = armCtrl.map(c => [c[0], 0, sg * c[1]]);
    const pts = mbAssignY(mbCatmull(ctrl, 2), armY0, armY0 - armDrop);
    arms.push(sweepSeg(sg > 0 ? 'armR' : 'armL', pts, { w0: ARM_W, branch: sg > 0 ? 1 : 2, vBank: 8, maxBank: 24 }));
  }
  // клин розвилки: ромб вістрям проти потоку
  const fork1 = { id: 'fork1', kind: 'boxes', boxes: [mbBox([10.6, hub.end[1] + 0.9, 0], Math.PI / 4, [1.5, 1.0, 1.5], 'wedge')], balls: [], noProgress: true };
  addStage('arms', arms, seg => seg.w0 / 2 + 3.5);
  B.segments.push(fork1); fork1.stage = 'arms'; fork1.stageIdx = B.stages.length - 1;

  // ── злиття у широку плиту (18 → 22.8 м, 15 м), далі 4 смуги ──
  const LANE_W = 4.5, LANE_PITCH = LANE_W + 2 * MB_LANE_T;           // 6.1
  const LANES_Z = [-1.5 * LANE_PITCH, -0.5 * LANE_PITCH, 0.5 * LANE_PITCH, 1.5 * LANE_PITCH]; // ±3.05, ±9.15
  const LANES_FOOT = 4 * LANE_W + 6 * MB_LANE_T;                      // 22.8
  const plateY0 = arms[0].end[1] - MB_JOIN_DROP;
  const PX = ARM_END_X - 0.3;
  const plate = sweepSeg('plate', [[PX, plateY0, 0], [PX + 14.6, plateY0 - 2, 0]], { w0: 18, w1: LANES_FOOT, wEase: true });
  addStage('plate', [plate], seg => 15);

  // ── 4) ЧОТИРИ СМУГИ З КОРКСКРЮ: віяло → пряма → петля 360° → пряма → сходження ──
  const laneY0 = plate.end[1] - MB_JOIN_DROP, laneDrop = 24; // більше — 20 м/с у петлі r=5.5 (6g) і переліт борту
  const LOOP_R = 5.5, LOOP_OFF = [0, 12, 4, 16];
  const laneOut = [-27, -9, 9, 27];
  const lanes = [];
  for (let k = 0; k < 4; k++) {
    const z0 = LANES_Z[k], z1 = laneOut[k], sg = z1 > 0 ? 1 : -1;
    const LX = plate.end[0] - 0.3;
    // віяло 46 м: при 32 м крайні смуги вигинались з r≈15 і кулька на 14 м/с перелітала борт
    const fan = mbCatmull([[LX, 0, z0], [LX + 6, 0, z0], [LX + 26, 0, (z0 + z1) / 2], [LX + 46, 0, z1], [LX + 52, 0, z1]], 2);
    const xl = LX + 60 + LOOP_OFF[k];
    const T = mbTurtle(LX + 52, z1, 0).fwd(xl - LX - 52).arc(sg * 360, LOOP_R).fwd(LX + 90 - xl);
    const conv = mbCatmull([[LX + 90, 0, z1], [LX + 96, 0, z1], [LX + 114, 0, (z0 + z1) / 2], [LX + 132, 0, z0], [LX + 138.6, 0, z0]], 2);
    const pts = fan.concat(T.pts.slice(1), conv.slice(1));
    mbAssignY(pts, laneY0, laneY0 - laneDrop);
    lanes.push(sweepSeg('lane' + (k + 1), pts, { w0: LANE_W, t: MB_LANE_T, branch: k + 1, vBank: 8, maxBank: 30, H: 2.5 }));
  }
  addStage('lanes', lanes, seg => seg.w0 / 2 + 3.5);
  {
    const LX = plate.end[0] - 0.3, boxes = [];
    for (let k = 0; k < 3; k++) boxes.push(...mbNose(LX, plate.end[1] + 0.7, (LANES_Z[k] + LANES_Z[k + 1]) / 2, MB_LANE_T));
    const noses = { id: 'laneNoses', kind: 'boxes', boxes, balls: [], noProgress: true, stage: 'lanes', stageIdx: B.stages.length - 1 };
    B.segments.push(noses);
  }

  // ── овал із діагональним червоним бампером, звуження до 6 м ──
  const ovalY0 = lanes[0].end[1] - MB_JOIN_DROP;
  const OX = lanes[0].end[0] - 0.3;
  // овал: сходження 22.8 → 6 м за 42 м (крутіше — кульки з петель на 15 м/с перелітають борт), борти 3 м
  const oval = sweepSeg('oval1', mbAssignY(mbCatmull([[OX, 0, 0], [OX + 12, 0, 0], [OX + 28, 0, 0], [OX + 42, 0, 0]], 2), ovalY0, ovalY0 - 4.5),
    { w0: LANES_FOOT, w1: 6, wEase: true, H: 3 });
  const bumper1 = mbBumper('bumper1', x => floorAtX(oval, x), OX + 10, 0, 35 * D2R, 7);
  addStage('oval1', [oval], seg => seg.w0 / 2 + 4);
  B.segments.push(bumper1); bumper1.stage = 'oval1'; bumper1.stageIdx = B.stages.length - 1;

  // ── 5) ЗИГЗАГ: 4 шпильки 180° (плече 15 м, r 4.5), спуск 20 м ──
  const zzY0 = oval.end[1] - MB_JOIN_DROP;
  const Z = mbTurtle(oval.end[0] - 0.3, 0, 0).fwd(6).arc(90, 6).fwd(10).arc(-180, 6).fwd(14).arc(180, 6).fwd(14).arc(-180, 6).fwd(14).arc(180, 6).fwd(10).arc(-90, 6).fwd(12);
  const zig = sweepSeg('zigzag', mbAssignY(Z.pts, zzY0, zzY0 - 26), { w0: 6, vBank: 7, maxBank: 28, H: 3 }); // 30 м спуску → 17 м/с у нижніх шпильках (4g) і виліт
  addStage('zigzag', [zig], seg => seg.w0 / 2 + 3.5);
  const zzEnd = zig.end;

  // ── 6) ДВІ СПІРАЛІ: розвилка → два гелікоїди (r 9, 3 оберти, крок 4.6) → злиття ──
  const SP_Z = 5.5, SP_W = 7, SP_R = 9, SP_TURNS = 3, SP_PITCH = 6.5;
  const ZO = zzEnd[2]; // 4 шпильки виводять жолоб убік — усе далі будуємо при z=0 і зсуваємо на ZO
  const downstreamFrom = B.segments.length;
  const forkY0 = zzEnd[1] - MB_JOIN_DROP;
  const fx0 = zzEnd[0];
  const fork2 = sweepSeg('fork2', [[fx0 - 0.3, forkY0, 0], [fx0 + 12, forkY0 - 1.0, 0]], { w0: 6, w1: 2 * (SP_Z + SP_W / 2), wEase: true });
  addStage('fork2', [fork2], seg => 12);
  const wedge2 = { id: 'fork2wedge', kind: 'boxes', boxes: [mbBox([fx0 + 12.6, fork2.end[1] + 0.9, 0], Math.PI / 4, [1.5, 1.0, 1.5], 'wedge')], balls: [], noProgress: true };
  B.segments.push(wedge2); wedge2.stage = 'fork2'; wedge2.stageIdx = B.stages.length - 1;
  const spY0 = fork2.end[1] - MB_JOIN_DROP;
  const spX = fx0 + 11.7, spXc = spX + 6;
  const spirals = [];
  for (const sg of [1, -1]) {
    const T = mbTurtle(spX, sg * SP_Z, 0).fwd(spXc - spX).arc(sg * 360 * SP_TURNS, SP_R).fwd(14);
    const Lh = 2 * Math.PI * SP_R * SP_TURNS, Ltot = (spXc - spX) + Lh + 14;
    const drop = SP_PITCH * SP_TURNS * Ltot / Lh; // рівномірний градієнт: крок гелікоїда рівно SP_PITCH
    spirals.push(sweepSeg(sg > 0 ? 'spiralR' : 'spiralL', mbAssignY(T.pts, spY0, spY0 - drop), { w0: SP_W, branch: sg > 0 ? 1 : 2, vBank: 7, maxBank: 24 }));
  }
  addStage('spirals', spirals, seg => seg.w0 / 2 + 3.5);
  const spEnd = spirals[0].end;

  // ── 7) ШИРОКИЙ ЖОЛОБ З БАМПЕРОМ → 4 СМУГИ 35 м → ОВАЛ → S-звуження до 6 м ──
  const mX = spEnd[0] - 0.3, mY0 = spEnd[1] - MB_JOIN_DROP;
  const merge2 = sweepSeg('merge2', [[mX, mY0, 0], [mX + 22, mY0 - 3.5, 0]], { w0: 2 * (SP_Z + SP_W / 2), w1: LANES_FOOT, wEase: true });
  const bumper2 = mbBumper('bumper2', x => floorAtX(merge2, x), mX + 10, 0, -35 * D2R, 7);
  addStage('merge2', [merge2], seg => seg.w0 / 2 + 4);
  B.segments.push(bumper2); bumper2.stage = 'merge2'; bumper2.stageIdx = B.stages.length - 1;
  const l2X = mX + 21.7, l2Y0 = merge2.end[1] - MB_JOIN_DROP;
  const lanes2 = [];
  for (let k = 0; k < 4; k++) {
    lanes2.push(sweepSeg('lane2_' + (k + 1), [[l2X, l2Y0, LANES_Z[k]], [l2X + 35.3, l2Y0 - 4.5, LANES_Z[k]]], { w0: LANE_W, t: MB_LANE_T, branch: k + 1 }));
  }
  addStage('lanes2', lanes2, seg => seg.w0 / 2 + 3.5);
  {
    const boxes = [];
    for (let k = 0; k < 3; k++) boxes.push(...mbNose(l2X, merge2.end[1] + 0.7, (LANES_Z[k] + LANES_Z[k + 1]) / 2, MB_LANE_T));
    const noses = { id: 'lane2Noses', kind: 'boxes', boxes, balls: [], noProgress: true, stage: 'lanes2', stageIdx: B.stages.length - 1 };
    B.segments.push(noses);
  }
  const o2X = l2X + 35, o2Y0 = lanes2[0].end[1] - MB_JOIN_DROP;
  const oval2 = sweepSeg('oval2', mbAssignY(mbCatmull([[o2X, 0, 0], [o2X + 8, 0, 0], [o2X + 18, 0, 0], [o2X + 28, 0, 0]], 2), o2Y0, o2Y0 - 4),
    { w0: LANES_FOOT, w1: 6, wEase: true, H: 3 });
  addStage('oval2', [oval2], seg => seg.w0 / 2 + 4);
  const sX = o2X + 27.7, sY0 = oval2.end[1] - MB_JOIN_DROP;
  const sCurve = sweepSeg('scurve', mbAssignY(mbCatmull([[sX, 0, 0], [sX + 8, 0, 0], [sX + 22, 0, 7], [sX + 38, 0, -7], [sX + 52, 0, 0], [sX + 68, 0, 0]], 2), sY0, sY0 - 8.5),
    { w0: 6, vBank: 8, maxBank: 26, H: 3 });
  addStage('scurve', [sCurve], seg => seg.w0 / 2 + 3.5);

  // ── 8) ФІНАЛЬНИЙ СПУСК (12 м, ~30 м) І ФІНІШНА ЧАША 22×22 ──
  const fX = sCurve.end[0] - 0.3, fY0 = sCurve.end[1] - MB_JOIN_DROP;
  const widen = sweepSeg('widen', [[fX, fY0, 0], [fX + 12, fY0 - 2, 0]], { w0: 6, w1: 12, wEase: true });
  addStage('widen', [widen], seg => seg.w0 / 2 + 4);
  const dX = widen.end[0] - 0.3, dY0 = widen.end[1] - MB_JOIN_DROP;
  // профіль спуску: нахил плавно (smoothstep за 10 м) зростає з 12% до 70% —
  // без «горба» кубічного сплайна на зламі, у який упирались повільні кульки
  const dpts = [];
  { let y = dY0; for (let x = 0; x <= 30; x++) { if (x) { const k = Math.min(1, x / 10), sm = k * k * (3 - 2 * k); y -= 0.12 + 0.58 * sm; } dpts.push([dX + x, y, 0]); } }
  const descent = sweepSeg('descent', dpts, { w0: 12, H: 2.5 });
  addStage('descent', [descent], seg => 10);
  const BOWL = 22, bX = descent.end[0] + BOWL / 2 - 0.3, bY = descent.end[1] - MB_JOIN_DROP - 0.1, BW_H = 3.5, CORNER = 4;
  const bowl = {
    id: 'bowl', kind: 'boxes', balls: [], boxes: [
      mbBox([bX, bY - 0.3, 0], 0, [BOWL / 2 + 0.6, 0.3, BOWL / 2 + 0.6], 'floor'),
      mbBox([bX + BOWL / 2 + 0.5, bY + BW_H / 2, 0], 0, [0.5, BW_H / 2, BOWL / 2 - CORNER + 0.5], 'wall'),      // далекий борт
      mbBox([bX, bY + BW_H / 2, BOWL / 2 + 0.5], 0, [BOWL / 2 - CORNER + 0.5, BW_H / 2, 0.5], 'wall'),          // бічні
      mbBox([bX, bY + BW_H / 2, -BOWL / 2 - 0.5], 0, [BOWL / 2 - CORNER + 0.5, BW_H / 2, 0.5], 'wall'),
      // ближній борт з прорізом під жолоб (12 м) — два шматки
      mbBox([bX - BOWL / 2 - 0.5, bY + BW_H / 2, (BOWL / 2 - CORNER + 6.5) / 2], 0, [0.5, BW_H / 2, (BOWL / 2 - CORNER - 6.5) / 2 + 0.01], 'wall'),
      mbBox([bX - BOWL / 2 - 0.5, bY + BW_H / 2, -(BOWL / 2 - CORNER + 6.5) / 2], 0, [0.5, BW_H / 2, (BOWL / 2 - CORNER - 6.5) / 2 + 0.01], 'wall'),
    ],
    size: BOWL, corner: CORNER, c: [bX, bY, 0], wallH: BW_H, noProgress: false,
    center: [[bX - BOWL / 2, bY, 0], [bX, bY, 0]], length: BOWL / 2,
  };
  // заокруглені кути — плити під 45°
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const cx = bX + sx * (BOWL / 2 - CORNER / 2 + 0.35), cz = sz * (BOWL / 2 - CORNER / 2 + 0.35);
    bowl.boxes.push(mbBox([cx, bY + BW_H / 2, cz], sx * sz > 0 ? -Math.PI / 4 : Math.PI / 4, [CORNER * 0.75, BW_H / 2, 0.5], 'wall'));
  }
  addStage('bowl', [bowl], () => 20);
  for (let i = downstreamFrom; i < B.segments.length; i++) mbTranslateSeg(B.segments[i], [0, 0, ZO]);
    B.finish = { p: descent.end.slice(), f: [1, 0, 0], r: 9, s: descent.s0 + descent.length };
    B.tray = tray;
    B.extra.disc = disc;
    B.extra.orbit = bowl.c.slice();
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W]);
  },

  // інтро-камера: позаду лотка з видом на диск (як стартовий кадр гри)
  intro(track, pos, look) {
    const H = track.tray.hinge, L = track.tray.L;
    pos.set(H[0] - L - 34, H[1] + 30, H[2] - 40);
    look.set(H[0] - 6, H[1] - 2, H[2] + 4);
  },

  // режисура по секціях (правила з першої версії, підібрані по кадрах гри)
  camera(st, leader, pos, look, centerAt) {
    const track = st.track, disc = track.disc, stg = track.stages, s = leader.prog;
    const inDisc = s >= stg[1].s0 - 6 && s < stg[2].s0;
    if (inDisc) { pos.set(disc.c[0] - 30, disc.c[1] + 20, disc.c[2] - 18); look.set(disc.c[0], disc.c[1] - 5, disc.c[2]); return true; }
    const hub = track.byId.hub;
    if (s < stg[3].s0 + 30) {
      // збоку під тарілкою, з видом на вихід горла й розвилку (як у грі)
      pos.set(leader.x - 34, hub.start[1] + 8, hub.start[2] - 38);
      look.set(leader.x + 6, leader.y - 1, leader.z * 0.6);
      return true;
    }
    let stage = null; for (const g of stg) if (s >= g.s0) stage = g;
    if (stage && stage.id === 'spirals') {
      // обидві спіралі в кадрі: камера над розвилкою, дивиться вниз на витки й лідера
      const f2 = track.byId.fork2;
      pos.set(f2.end[0] - 26, f2.end[1] + 24, f2.end[2]);
      look.set(f2.end[0] + 16, leader.y - 6, f2.end[2] + (leader.z - f2.end[2]) * 0.4);
      return true;
    }
    // далі — загальні плани режисера ядра; спецплан лише поки лідер біля тарілки
    // (вище за її обідок, інакше обідок затуляє жолоб)
    if (Math.hypot(leader.x - disc.c[0], leader.z - disc.c[2]) > disc.rDisc + 30) return false;
    const lp = [leader.x, leader.y, leader.z];
    const back = centerAt(track, Math.max(0, s - 34), lp), fwd = centerAt(track, s + 10, lp);
    let dx = leader.x - back[0], dz = leader.z - back[2], hl = Math.hypot(dx, dz) || 1;
    const minD = 24; let bx = back[0], bz = back[2];
    if (hl < minD) { bx = leader.x - dx / hl * minD; bz = leader.z - dz / hl * minD; dx = leader.x - bx; dz = leader.z - bz; hl = minD; }
    pos.set(bx - dx / hl * 4 + dz / hl * 6, Math.max(back[1] + 19, leader.y + 13), bz - dz / hl * 4 - dx / hl * 6);
    if (Math.hypot(pos.x - disc.c[0], pos.z - disc.c[2]) < disc.rDisc + 12) pos.y = Math.max(pos.y, disc.c[1] + disc.yRim + 22);
    look.set(fwd[0] * 0.5 + leader.x * 0.5, leader.y - 2, fwd[2] * 0.5 + leader.z * 0.5);
    return true;
  },

  // декор: START на лотку, логотип на тарілці, LED-обідок чаші
  decor(track, ctx) {
    const { THREE, trayGroup, mats } = ctx;
    const tr = track.tray;
  if (trayGroup) {
    // START — шаховка вздовж відкритого краю лотка
    const geo = new THREE.PlaneGeometry(tr.W - 1.2, 2.4); // довга вісь → після поворотів уздовж z, текст біжить по ній
    geo.rotateX(-Math.PI / 2); geo.rotateY(Math.PI / 2);
    const uvA = geo.getAttribute('uv'); for (let i = 0; i < uvA.count; i++) uvA.setX(i, uvA.getX(i) * 2);
    const m = new THREE.Mesh(geo, mats.start); m.position.set(-1.6, 0.03, 0); m.receiveShadow = true;
    trayGroup.add(m);
  }
  // логотип на тарілці: кільцева смуга, що лежить на увігнутій поверхні (планарні uv)
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
        // текст читається з боку лотка (камера дивиться вздовж +x, екранне право = +z)
        uv[v * 2] = (z - d.c[2]) / (2 * d.rDisc) + 0.5; uv[v * 2 + 1] = (x - d.c[0]) / (2 * d.rDisc) + 0.5;
      }
      const k1 = (k + 1) % N, a = k * 2, b = k * 2 + 1, c2 = k1 * 2, dd = k1 * 2 + 1;
      idx.set([a, c2, b, b, c2, dd], k * 6); // обхід проти годинника при погляді згори — лицьова грань угору
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.Mesh(geo, mats.logo); m.renderOrder = 1;
    ctx.scene.add(m);
  }
  // обідок фінішної чаші: смуга LED + FINISH! на верхній грані кожного борту
  {
    const finishRim = track.byId.bowl.boxes.filter(b => b.role === 'wall');
    const parts = [];
    for (const b of finishRim) {
      const long = b.size[0] > b.size[2] ? 0 : 2; // довга вісь бокса
      const L = 2 * b.size[long] + 0.2, Wd = 1.1;
      // смуга завжди будується довгою віссю вздовж x (u текстури = довжина), кладеться
      // в площину xz і лише тоді розвертається до бортів уздовж z; попередній варіант
      // задавав довжину по y і після двох поворотів стирчав за чашу на 7.5 м
      const geo = new THREE.PlaneGeometry(L, Wd);
      geo.rotateX(-Math.PI / 2);
      if (long === 2) geo.rotateY(Math.PI / 2);
      const uvA = geo.getAttribute('uv'); for (let i = 0; i < uvA.count; i++) uvA.setX(i, uvA.getX(i) * L / 6);
      const q = new THREE.Quaternion(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
      geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(b.pos[0], b.pos[1] + b.size[1] + 0.03, b.pos[2]), q, new THREE.Vector3(1, 1, 1)));
      parts.push({ pos: new Float32Array(geo.getAttribute('position').array), nrm: new Float32Array(geo.getAttribute('normal').array), uv: new Float32Array(uvA.array), idx: new Uint32Array(geo.getIndex().array) });
      geo.dispose();
    }
    const m = new THREE.Mesh(mbMergeParts(parts), mats.finish); m.renderOrder = 1;
    ctx.scene.add(m);
  }
  },
};
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
