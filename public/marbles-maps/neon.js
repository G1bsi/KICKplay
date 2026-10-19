// ─────────────────────────────────────────────────────────────
//  🌅 Карта «Неоновый закат» — власна траса KICKplay (не копія чужої гри).
//  Лоток → широкий старт → поле пінбол-бамперів і желе → РОЗВИЛКА: довга
//  S-дуга з прискорювачами або СЕКРЕТНИЙ скляний тунель (вузький, коротший) →
//  батут і політ через провал → лазерний коридор (кого зачепило — назад на 12 м)
//  → млин з обертовою лопаттю → поле батутів → спринт з прискорювачами → чаша.
//  Classic script, підключається ПІСЛЯ marbles.js (будівельник B, зони B.zone,
//  глобальні хелпери mb*/MB_*). Одиниці — метри, кулька r = 0.5, потік уздовж +x.
// ─────────────────────────────────────────────────────────────
(function () {
// підйом хвоста жолоба на h за останні L м (квадратично) — трамплін
function neonKick(pts, L, h) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  const S = cum[cum.length - 1];
  for (let i = 0; i < pts.length; i++) { const u = (cum[i] - (S - L)) / L; if (u > 0) pts[i][1] += h * u * u; }
  return pts;
}
let neonMats = null; // матеріали декору — один раз на сторінку (ядро чистить лише геометрію)

const MAP = {
  id: 'neon',
  name: 'Неоновый закат',
  icon: '🌅',
  approxSec: 85,
  allSec: 135,
  desc: 'Вихрь, пинбол-бамперы и желе, секретный стеклянный тоннель, батут и прыжок через пропасть, лазеры, мельница, поле батутов и ускорители.',
  eliminate: false,
  theme: {
    // темно-фіолетовий мармур з бузковим крапом — неон, лазери й кольорові кульки на ньому світяться
    marble: { granite: true, base: '#4a3a86', light: '#7c68c4', dark: '#221849', white: '#e4d6ff', lk: 0.65, wk: 0.5, sk: 0.45, dk: 0.35 },
    roughness: 0.34, metalness: 0.05, envInt: 0.4,
    sky: { hor: '#ffb08a', zen: '#3a2a78' }, fog: '#f0a088', fogDensity: 0.0007, clear: '#f0a088',
    cloudFloor: '#5e3f8a', cloudTint: '#ffd3c2', clouds: true,
    hemi: ['#ffd8c4', '#6a4f9a', 0.8], sun: ['#ffc98f', 1.15], redColor: '#ff2d7a',
  },

  build(B) {
    const { addStage, sweepSeg, floorAtX, centerLen } = B;
    const catmull = B.catmull, assignY = B.assignY;
    const JD = B.C.JOIN_DROP, JE = B.C.JOIN_EXT, LT = B.C.LANE_T;
    const X = B.extra.neon = {};
    const pushAux = (seg, stageId) => { B.segments.push(seg); seg.stage = stageId; seg.stageIdx = B.stages.length - 1; seg.noProgress = true; };
    const next = g => [g.end[0] - JE, g.end[1] - JD];

    // ── 1) ЛОТОК 32×16 ──
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
      slots: [], center: [[HINGE[0] - TRAY_L, HINGE[1], HINGE[2]], HINGE.slice()], length: TRAY_L,
    };
    {
      const rows = Math.floor((TRAY_L - 1.6) / B.C.TRAY_STEP);
      for (let r = 0; r < rows; r++) for (let c = 0; c < B.C.TRAY_COLS; c++) tray.slots.push([-(1.3 + 0.55 + r * B.C.TRAY_STEP), B.C.R + 0.05, (c - (B.C.TRAY_COLS - 1) / 2) * B.C.TRAY_STEP]);
    }
    addStage('tray', [tray], () => 12);

    // ── 2) ВИХОР: тарілка Ø44 (край лотка — над тарілкою, не над бортом) з лійкою → горло Ø5.6. Без неї перші ряди лотка просто
    // їхали попереду всю гонку (топ-10 на 3/4 з першої чверті старту); лійка перемішує
    // пелетон, і стартове місце перестає вирішувати
    const DISC = [0, 0, 0];
    const R_DISC = 22, R_FUN = 6, R_TH = 2.8, Y_RIM = 1.6, H_FUN = 10, Y_TH = -12;
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
    addStage('disc', [disc], (seg, i) => i === 0 ? 24 : 7);
    // хаб під горлом (кульки падають ~13 м/с — борти 5 м) розширюється до поля бамперів
    const HUB_Y = -14.5;
    const launch = sweepSeg('launch', [[-4.5, HUB_Y, 0], [16, HUB_Y - 2.6, 0]], { w0: 8, w1: 16, wEase: true, H: 5 });
    addStage('launch', [launch], () => 10);
    pushAux({ id: 'launchCap', kind: 'boxes', boxes: [B.box([-4.8, HUB_Y + 0.8, 0], 0, [0.4, 1.4, 5.5], 'wall')], balls: [] }, 'launch');

    // ── 3) ПІНБОЛ: плита 16×44 з рядами червоних бамперів шахівкою + дві плями желе ──
    let [x, y] = next(launch);
    const pin = sweepSeg('pinball', [[x, y, 0], [x + 44, y - 5.5, 0]], { w0: 16, H: 3.2 });
    addStage('pinball', [pin], () => 12);
    {
      const balls = [];
      for (let r = 0; r < 6; r++) {
        const bx = x + 7 + r * 5.6, zs = (r & 1) ? [-2.6, 2.6] : [-5.2, 0, 5.2];
        for (const z of zs) balls.push({ pos: [bx, floorAtX(pin, bx) + 0.55, z], r: 0.85 });
      }
      pushAux({ id: 'pinBumpers', kind: 'boxes', boxes: [], balls }, 'pinball');
      B.zone('slow', pin, 18, { len: 4.5, w: 4.2, lat: 4.6 });
      B.zone('slow', pin, 30, { len: 4.5, w: 4.2, lat: -4.6 });
    }
    [x, y] = next(pin);
    const narA = sweepSeg('narrowA', [[x, y, 0], [x + 14, y - 2, 0]], { w0: 16, w1: 9.6, wEase: true, H: 3 });
    addStage('narrowA', [narA], () => 12);

    // ── 4) РОЗВИЛКА: основна S-дуга (6 м, 2 прискорювачі) і секретний тунель (2.4 м, прямий) ──
    [x, y] = next(narA);
    const FX = x, MAIN_Z = -1.6, SEC_Z = 3.6, FORK_DROP = 12, FORK_L = 92;
    const mainPts = assignY(catmull([[FX, 0, MAIN_Z], [FX + 8, 0, MAIN_Z], [FX + 24, 0, -12], [FX + 46, 0, -24], [FX + 68, 0, -12], [FX + 84, 0, MAIN_Z], [FX + FORK_L, 0, MAIN_Z]], 2), y, y - FORK_DROP);
    const main = sweepSeg('forkMain', mainPts, { w0: 6, t: LT, H: 2.6, vBank: 9, maxBank: 26, branch: 1 });
    const secret = sweepSeg('secret', [[FX, y, SEC_Z], [FX + FORK_L, y - FORK_DROP, SEC_Z]], { w0: 2.4, t: LT, H: 2.2, branch: 2 });
    addStage('fork', [main, secret], seg => seg.w0 / 2 + 3.2);
    pushAux({ id: 'forkNose', kind: 'boxes', boxes: B.nose(FX, y + 0.7, (MAIN_Z + 3 + LT + SEC_Z - 1.2 - LT) / 2, LT), balls: [] }, 'fork');
    // прискорювачі на дузі — помірні (vt 13): з 17 м/с кульки перелітали борт на злитті
    B.zone('boost', main, 30, { len: 5, vt: 13 });
    B.zone('boost', main, 60, { len: 5, vt: 13 });
    X.secret = secret; X.forkMain = main;
    // злиття: обидві гілки закінчуються на FX + FORK_L
    x = FX + FORK_L - JE; y = y - FORK_DROP - JD;
    const merge = sweepSeg('mergeB', [[x, y, 0.3], [x + 16, y - 2.3, 0.3]], { w0: 10.2, w1: 7, wEase: true, H: 4 });
    addStage('mergeB', [merge], () => 12);

    // ── 5) БАТУТ І ПОЛІТ ЧЕРЕЗ ПРОВАЛ: трамплін + батут, приземлення нижче на 5.5 м ──
    [x, y] = next(merge);
    const jPts = assignY(catmull([[x, 0, 0.3], [x + 12, 0, 0], [x + 36, 0, 0]], 2), y, y - 4.5);
    neonKick(jPts, 6, 0.9);
    const jump = sweepSeg('jumpRun', jPts, { w0: 7, H: 3.5 });
    addStage('jumpRun', [jump], () => 10);
    B.zone('jump', jump, jump.length - 3.2, { len: 2.6, launch: 7, fwd: 1 });
    X.jumpEnd = jump.end.slice();
    const lx = jump.end[0] - 3, ly = jump.end[1] - 5.5;
    // приземлення широке (12 м) і з високими бортами на всю довжину, звуження — окремо після
    const land = sweepSeg('landA', [[lx, ly, 0], [lx + 46, ly - 5, 0]], { w0: 12, H: 5 });
    addStage('landA', [land], () => 14);
    pushAux({ id: 'landCap', kind: 'boxes', boxes: [B.box([lx - 0.4, ly + 1.6, 0], 0, [0.4, 2.2, 7.4], 'wall')], balls: [] }, 'landA');

    [x, y] = next(land);
    const landOut = sweepSeg('landOut', [[x, y, 0], [x + 16, y - 2, 0]], { w0: 12, w1: 7, wEase: true, H: 4 });
    addStage('landOut', [landOut], () => 12);

    // ── 6) ЛАЗЕРНИЙ КОРИДОР: S-змійка 130 м, три рамки з різною фазою ──
    [x, y] = next(landOut);
    const lzPts = assignY(catmull([[x, 0, 0], [x + 14, 0, 0], [x + 38, 0, 10], [x + 65, 0, -10], [x + 95, 0, 10], [x + 120, 0, 0], [x + 130, 0, 0]], 2), y, y - 15);
    const laser = sweepSeg('laserRun', lzPts, { w0: 7, H: 3, vBank: 9, maxBank: 26 });
    addStage('laserRun', [laser], seg => seg.w0 / 2 + 3.5);
    // промінь горить 0.8 с з кожних 3.6; відкидає на 8 м — у середньому ~1 зап на кульку за коридор
    for (const [s, ph] of [[36, 0], [74, 1.2], [112, 2.4]]) B.zone('laser', laser, s, { phase: ph, period: 3.6, on: 0.8, back: 8 });
    X.laser = laser;

    // ── 7) МЛИН: розширення до 20 м, пласка арена з обертовою лопаттю (2 прорізи) ──
    [x, y] = next(laser);
    const millIn = sweepSeg('millIn', [[x, y, 0], [x + 12, y - 2, 0]], { w0: 7, w1: 20, wEase: true, H: 4.5 });
    addStage('millIn', [millIn], () => 13);
    [x, y] = next(millIn);
    const mill = sweepSeg('mill', [[x, y, 0], [x + 22, y - 0.4, 0]], { w0: 20, H: 4.5 });
    addStage('mill', [mill], () => 13);
    {
      const mx = x + 11, my = floorAtX(mill, mx), boxes = [];
      for (const cx of [-6.8, 0, 6.8]) boxes.push({ pos: [cx, 0.7, 0], quat: [0, 0, 0, 1], size: [2.2, 0.7, 0.35], role: 'bumper' });
      pushAux({ id: 'mill', kind: 'spinner', c: [mx, my, 0], axis: [0, 1, 0], omega: 0.75, phase: 20 * B.D2R, boxes, balls: [], red: true, friction: 0.25, restitution: 0.55 }, 'mill');
      X.millC = [mx, my, 0];
    }
    [x, y] = next(mill);
    const millOut = sweepSeg('millOut', [[x, y, 0], [x + 12, y - 3, 0]], { w0: 20, w1: 8, wEase: true, H: 4.5 });
    addStage('millOut', [millOut], () => 13);

    // ── 8) ПОЛЕ БАТУТІВ: 14 м завширшки, 4 батути шахівкою + желе між ними ──
    [x, y] = next(millOut);
    const bIn = sweepSeg('bounceIn', [[x, y, 0], [x + 10, y - 1.5, 0]], { w0: 8, w1: 14, wEase: true, H: 4.5 });
    addStage('bounceIn', [bIn], () => 12);
    [x, y] = next(bIn);
    const bounce = sweepSeg('bounce', [[x, y, 0], [x + 40, y - 6, 0]], { w0: 14, H: 4.5 });
    addStage('bounce', [bounce], () => 14);
    for (const [s, lat] of [[8, -3.2], [16, 3.2], [24, -3.2], [32, 3.2]]) B.zone('jump', bounce, s, { len: 3, w: 4.4, lat, launch: 7.5, fwd: 1.2 });
    B.zone('slow', bounce, 12, { len: 3, w: 3.6, lat: 4.2 });
    B.zone('slow', bounce, 28, { len: 3, w: 3.6, lat: -4.2 });
    X.bounce = bounce;
    [x, y] = next(bounce);
    const bOut = sweepSeg('bounceOut', [[x, y, 0], [x + 10, y - 1.5, 0]], { w0: 14, w1: 8, wEase: true, H: 4 });
    addStage('bounceOut', [bOut], () => 12);

    // ── 9) СПРИНТ: хвиля 60 м з двома прискорювачами → розширення → спуск у чашу ──
    [x, y] = next(bOut);
    const sprint = sweepSeg('sprint', assignY(catmull([[x, 0, 0], [x + 8, 0, 0], [x + 22, 0, 6], [x + 40, 0, -6], [x + 54, 0, 0], [x + 60, 0, 0]], 2), y, y - 8),
      { w0: 8, H: 3.6, vBank: 9, maxBank: 24 });
    addStage('sprint', [sprint], seg => seg.w0 / 2 + 4.5);
    B.zone('boost', sprint, 14, { len: 5, vt: 14 });
    B.zone('boost', sprint, 44, { len: 5, vt: 14 });
    [x, y] = next(sprint);
    const widen = sweepSeg('widen', [[x, y, 0], [x + 12, y - 2, 0]], { w0: 8, w1: 12, wEase: true });
    addStage('widen', [widen], () => 10);
    [x, y] = next(widen);
    const dpts = [];
    { let yy = y; for (let k = 0; k <= 24; k++) { if (k) { const t = Math.min(1, k / 8), sm = t * t * (3 - 2 * t); yy -= 0.12 + 0.5 * sm; } dpts.push([x + k, yy, 0]); } }
    const descent = sweepSeg('descent', dpts, { w0: 12, H: 2.5 });
    addStage('descent', [descent], () => 10);

    // ── 10) ФІНІШНА ЧАША 22×22 ──
    const BOWL = 22, bX = descent.end[0] + BOWL / 2 - 0.3, bY = descent.end[1] - JD - 0.1, BW_H = 3.5, CORNER = 4;
    const bowl = {
      id: 'bowl', kind: 'boxes', balls: [], boxes: [
        B.box([bX, bY - 0.3, 0], 0, [BOWL / 2 + 0.6, 0.3, BOWL / 2 + 0.6], 'floor'),
        B.box([bX + BOWL / 2 + 0.5, bY + BW_H / 2, 0], 0, [0.5, BW_H / 2, BOWL / 2 - CORNER + 0.5], 'wall'),
        B.box([bX, bY + BW_H / 2, BOWL / 2 + 0.5], 0, [BOWL / 2 - CORNER + 0.5, BW_H / 2, 0.5], 'wall'),
        B.box([bX, bY + BW_H / 2, -BOWL / 2 - 0.5], 0, [BOWL / 2 - CORNER + 0.5, BW_H / 2, 0.5], 'wall'),
        B.box([bX - BOWL / 2 - 0.5, bY + BW_H / 2, (BOWL / 2 - CORNER + 6.5) / 2], 0, [0.5, BW_H / 2, (BOWL / 2 - CORNER - 6.5) / 2 + 0.01], 'wall'),
        B.box([bX - BOWL / 2 - 0.5, bY + BW_H / 2, -(BOWL / 2 - CORNER + 6.5) / 2], 0, [0.5, BW_H / 2, (BOWL / 2 - CORNER - 6.5) / 2 + 0.01], 'wall'),
      ],
      size: BOWL, corner: CORNER, c: [bX, bY, 0], wallH: BW_H,
      center: [[bX - BOWL / 2, bY, 0], [bX, bY, 0]], length: BOWL / 2,
    };
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = bX + sx * (BOWL / 2 - CORNER / 2 + 0.35), cz = sz * (BOWL / 2 - CORNER / 2 + 0.35);
      bowl.boxes.push(B.box([cx, bY + BW_H / 2, cz], sx * sz > 0 ? -Math.PI / 4 : Math.PI / 4, [CORNER * 0.75, BW_H / 2, 0.5], 'wall'));
    }
    addStage('bowl', [bowl], () => 20);
    B.finish = { p: descent.end.slice(), f: [1, 0, 0], r: 9, s: descent.s0 + descent.length };
    B.tray = tray;
    B.extra.disc = disc;
    B.extra.orbit = bowl.c.slice();
    B.extraPoints.push([HINGE[0] - TRAY_L - 2, HINGE[1] + 14, -TRAY_W], [HINGE[0], HINGE[1], TRAY_W]);
  },

  // інтро: позаду лотка, у кадрі лоток і вихор
  intro(track, pos, look) {
    const H = track.tray.hinge, L = track.tray.L;
    pos.set(H[0] - L - 30, H[1] + 28, H[2] - 36);
    look.set(H[0] - 4, H[1] - 2, H[2] + 4);
  },

  // спецплани: секретний тунель збоку, політ з батута збоку, млин згори
  camera(st, leader, pos, look) {
    const track = st.track, X = track.extra.neon, s = leader.prog;
    if (!X.sIdx) { X.sIdx = {}; for (const g of track.stages) X.sIdx[g.id] = g; }
    const S = X.sIdx, disc = track.disc;
    if (s < S.launch.s0 - 2) { pos.set(disc.c[0] - 28, disc.c[1] + 20, disc.c[2] - 18); look.set(disc.c[0], disc.c[1] - 5, disc.c[2]); return true; }
    // під тарілкою (хаб і початок пінболу): збоку, нижче обідка — інакше тарілка закриває лідера
    if (s < S.pinball.s0 + 18) {
      const h = track.byId.launch.start;
      pos.set(leader.x - 8, h[1] + 7, -38); look.set(leader.x + 8, leader.y - 1, leader.z * 0.5);
      return true;
    }
    if (s >= S.jumpRun.s1 - 14 && s < S.landA.s0 + 22) {
      const j = X.jumpEnd;
      pos.set(j[0] + 4, j[1] + 6, j[2] + 34); look.set(j[0] + 8, j[1] - 3, 0);
      return true;
    }
    if (s >= S.mill.s0 - 4 && s < S.millOut.s0 + 4) {
      const c = X.millC;
      pos.set(c[0] - 18, c[1] + 26, c[2] - 14); look.set(c[0] + 2, c[1], c[2]);
      return true;
    }
    return false;
  },

  // декор: START на лотку, скляний тунель над секретною гілкою, неонові арки, LED-обідок чаші
  decor(track, ctx) {
    const { THREE, trayGroup, mats } = ctx;
    const X = track.extra.neon;
    if (!neonMats) {
      neonMats = {
        glass: new THREE.MeshStandardMaterial({ color: '#7a3cff', transparent: true, opacity: 0.38, roughness: 0.1, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false }),
        rib: new THREE.MeshBasicMaterial({ color: '#c06bff' }),
        neonA: new THREE.MeshBasicMaterial({ color: '#21f3ff' }),
        neonB: new THREE.MeshBasicMaterial({ color: '#ff3d9a' }),
      };
    }
    const N = neonMats;
    if (trayGroup) {
      const geo = new THREE.PlaneGeometry(track.tray.W - 1.2, 2.4);
      geo.rotateX(-Math.PI / 2); geo.rotateY(Math.PI / 2);
      const uvA = geo.getAttribute('uv'); for (let i = 0; i < uvA.count; i++) uvA.setX(i, uvA.getX(i) * 2);
      const m = new THREE.Mesh(geo, mats.start); m.position.set(-1.6, 0.03, 0);
      trayGroup.add(m);
    }
    // логотип на тарілці вихору: кільцева смуга на увігнутій поверхні (планарні uv)
    {
      const d = track.disc, NS = 64, r0 = d.rFunnel + 0.8, r1 = d.rDisc - 0.6;
      const yAt = r => (r - d.rFunnel) / (d.rDisc - d.rFunnel) * d.yRim + 0.06;
      const pos = new Float32Array(2 * NS * 3), uv = new Float32Array(2 * NS * 2), idx = new Uint32Array(NS * 6);
      for (let k = 0; k < NS; k++) {
        const phi = k * 2 * Math.PI / NS;
        for (let j = 0; j < 2; j++) {
          const r = j ? r1 : r0, v = k * 2 + j, x = d.c[0] + r * Math.cos(phi), z = d.c[2] + r * Math.sin(phi);
          pos[v * 3] = x; pos[v * 3 + 1] = d.c[1] + yAt(r); pos[v * 3 + 2] = z;
          uv[v * 2] = (z - d.c[2]) / (2 * d.rDisc) + 0.5; uv[v * 2 + 1] = (x - d.c[0]) / (2 * d.rDisc) + 0.5;
        }
        const k1 = (k + 1) % NS, a = k * 2, b = k * 2 + 1, c2 = k1 * 2, dd = k1 * 2 + 1;
        idx.set([a, c2, b, b, c2, dd], k * 6);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
      const m = new THREE.Mesh(geo, mats.logo); m.renderOrder = 1; ctx.scene.add(m);
    }
    // секретний тунель: напівциліндр-скло над вузькою гілкою + фіолетові ребра кожні 4 м
    {
      const seg = X.secret, F = seg.frames, R = seg.w0 / 2 + seg.t, K = 12;
      const pos = [], idx = [];
      for (let i = 0; i < F.length; i++) {
        const f = F[i];
        for (let k = 0; k <= K; k++) {
          const a = Math.PI * k / K, lr = Math.cos(a) * R, lu = seg.H + Math.sin(a) * R * 0.9;
          pos.push(f.p[0] + f.r[0] * lr + f.u[0] * lu, f.p[1] + f.r[1] * lr + f.u[1] * lu, f.p[2] + f.r[2] * lr + f.u[2] * lu);
        }
        if (i) for (let k = 0; k < K; k++) { const a = (i - 1) * (K + 1) + k, b = a + K + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, N.glass); m.renderOrder = 2; ctx.scene.add(m);
      const ribGeo = new THREE.TorusGeometry(R, 0.12, 6, 16, Math.PI);
      for (let s = 4; s < seg.length - 2; s += 4) {
        let i = 0; while (i + 1 < F.length && F[i + 1].s < s) i++;
        const f = F[i];
        const rib = new THREE.Mesh(ribGeo, N.rib);
        rib.position.set(f.p[0] + f.u[0] * seg.H, f.p[1] + f.u[1] * seg.H, f.p[2] + f.u[2] * seg.H);
        rib.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.r), new THREE.Vector3(...f.u), new THREE.Vector3(...f.t)));
        ctx.scene.add(rib);
      }
    }
    // неонові арки над входом у лазерний коридор і над спринтом
    for (const [id, sl, mat] of [['laserRun', 6, N.neonB], ['sprint', 4, N.neonA], ['jumpRun', 4, N.neonA]]) {
      const seg = track.byId[id]; if (!seg) continue;
      const F = seg.frames; let i = 0; while (i + 1 < F.length && F[i + 1].s < sl) i++;
      const f = F[i], R = seg.w0 / 2 + 2;
      const arch = new THREE.Mesh(new THREE.TorusGeometry(R, 0.25, 8, 24, Math.PI), mat);
      arch.position.set(f.p[0], f.p[1], f.p[2]);
      arch.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.r), new THREE.Vector3(...f.u), new THREE.Vector3(...f.t)));
      ctx.scene.add(arch);
    }
    // обідок фінішної чаші: LED + FINISH!
    {
      const parts = [];
      for (const b of track.byId.bowl.boxes.filter(b => b.role === 'wall')) {
        const long = b.size[0] > b.size[2] ? 0 : 2, L = 2 * b.size[long] + 0.2;
        const geo = new THREE.PlaneGeometry(L, 1.1);
        geo.rotateX(-Math.PI / 2);
        if (long === 2) geo.rotateY(Math.PI / 2);
        const uvA = geo.getAttribute('uv'); for (let i = 0; i < uvA.count; i++) uvA.setX(i, uvA.getX(i) * L / 6);
        const q = new THREE.Quaternion(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
        geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(b.pos[0], b.pos[1] + b.size[1] + 0.03, b.pos[2]), q, new THREE.Vector3(1, 1, 1)));
        parts.push({ pos: new Float32Array(geo.getAttribute('position').array), nrm: new Float32Array(geo.getAttribute('normal').array), uv: new Float32Array(uvA.array), idx: new Uint32Array(geo.getIndex().array) });
        geo.dispose();
      }
      const m = new THREE.Mesh(ctx.mergeParts(parts), mats.finish); m.renderOrder = 1;
      ctx.scene.add(m);
    }
  },
};
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
