// ─────────────────────────────────────────────────────────────
//  🧔 Карта «Pixel vs The Unknown» (копія карти з Marbles on Stream):
//  стартова плита-ворота над островом з піксельною головою → дві дзеркальні
//  гілки (Pixel — світла, z>0; The Unknown — темна, z<0): лійка → хаб →
//  крендель із двох коркскрю → «ложка» з пегами → колесо-мішень (обертовий
//  похилий диск) під лазерами велетнів → гелікоїд і рампа до центру →
//  злиття у V-плиту → зміїста труба → тарілка з горлом → труба з «пузом»
//  → хвиляста труба → фінішний квадрат із золотим LED-обідком.
//  Classic script, підключається ПІСЛЯ marbles.js (будівельник B і
//  глобальні хелпери mb*/MB_*). Одиниці — метри, кулька r = 0.5, потік +x.
// ─────────────────────────────────────────────────────────────
(function () {
// піксель-арт бюста (колонки — вздовж z, рядки — згори вниз): H волосся,
// S шкіра, B борода, T сорочка, W білок ока, P зіниця, K чорне, '.' порожньо
const PIX_ROWS = [
  '......HHHHHHHHHH......',
  '....HHHHHHHHHHHHHH....',
  '...HHHHHHHHHHHHHHHH...',
  '..HHHHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHHHH..',
  '.HHHHHSSSSSSSSSSHHHHH.',
  '.HHHHSSSSSSSSSSSSHHHH.',
  '.HHHSSSSSSSSSSSSSSHHH.',
  '.HHHSSHHSSSSSSHHSSHHH.',
  '.HHHSSWWSSSSSSWWSSHHH.',
  '.HHHSSWPSSSSSSPWSSHHH.',
  '.HHHSSSSSSSSSSSSSSHHH.',
  '.HHHSSSSSSSSSSSSSSHHH.',
  '.HHHSSSSSSBBSSSSSSHHH.',
  '.HHHSSSSSBBBBSSSSSHHH.',
  '.HHHSSSBBBBBBBBSSSHHH.',
  '.HHHSSBBBBBBBBBBSSHHH.',
  '.HHHSBBBBBBBBBBBBSHHH.',
  '..HHSBBBBBBBBBBBBSHH..',
  '..HHBBBBBBBBBBBBBBHH..',
  '...HBBBBBBBBBBBBBBH...',
  '....BBBBBBBBBBBBBB....',
  '.....BBBBBBBBBBBB.....',
  '.......BBBBBBBB.......',
  '........SSSSSS........',
  '........SSSSSS........',
  '....TTTTTTTTTTTTTT....',
  '..TTTTTTTTTTTTTTTTTT..',
  '.TTTTTTTTTTTTTTTTTTTT.',
  'TTTTTTTTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTTTTTTTT',
];
const PIX_COLS = PIX_ROWS[0].length, PIX_H = PIX_ROWS.length;
const PIX_PAL = { H: '#d8641a', S: '#f2c9a0', B: '#b8481a', T: '#2a4fd8', W: '#ffffff', P: '#c81818', K: '#0c0c10' };
// «The Unknown» — той самий силует, але чорний, лише білки очей
const UNK_MAP = { H: 'K', S: 'K', B: 'K', T: 'K', W: 'W', P: 'K' };

const MAP = {
  id: 'pixel',
  name: 'Pixel vs The Unknown',
  icon: '🧔',
  approxSec: 135,   // лідер (у грі перший фініш ~2:24 за описом власника, у відео ~2:50)
  allSec: 190,      // усі 194 (з 60-с відліком)
  desc: 'Две зеркальные ветки: воронки, петли, колёса-мишени под лазерами великанов, затем тарелка и финиш. Чёрный глянец в ночном небе.',
  eliminate: false,
  theme: {
    marble: { base: '#12161e', light: '#2a3140', dark: '#04060a', white: '#3a4254', a0: 0.3, a1: 0.8, dk: 0.5, wk: 0.2, grain: 4 },
    roughness: 0.28, metalness: 0.1, envInt: 0.9,
    sky: { hor: '#1c2a44', zen: '#060a16' }, fog: '#141c30', fogDensity: 0.0022,
    cloudFloor: '#1a2438', clear: '#101828', hemi: ['#2c3a5a', '#0c1020', 0.55], sun: ['#cfe0ff', 0.9],
    clouds: true, cloudTint: '#6b7a96', ballColor: '#ffffff',   // нічні хмари — сіро-сині, не білі
  },

  build(B) {
    const { addStage, sweepSeg, centerLen } = B;
    const V = B.v, D2R = B.D2R, JD = B.C.JOIN_DROP, JE = B.C.JOIN_EXT;
    const SIDES = [1, -1];                       // +1 — Pixel (z>0), −1 — The Unknown (z<0)
    const sid = (base, sg) => base + (sg > 0 ? 'P' : 'U');
    const pushAux = (seg, stageId) => { seg.noProgress = true; seg.stage = stageId; seg.stageIdx = B.stages.length - 1; B.segments.push(seg); };
    const X = { giants: [], lasers: [], islands: [], wheels: [], lightIds: [] };  // для decor()

    // ── 1) СТАРТ: плита-ворота 20×18 над островом, кульки сіткою 14×14; на старті
    //    плита зникає і кульки падають на острів (як «провал» у грі) ──
    const GY = 3.6;
    const gate = { id: 'gate', kind: 'boxes', gate: true, balls: [], boxes: [
      B.box([-2, GY, 0], 0, [10, 0.25, 9], 'floor'),
      B.box([-2, GY + 1.0, 9.3], 0, [10, 0.75, 0.3], 'wall'), B.box([-2, GY + 1.0, -9.3], 0, [10, 0.75, 0.3], 'wall'),
      B.box([-12.3, GY + 1.0, 0], 0, [0.3, 0.75, 9.6], 'wall'), B.box([8.3, GY + 1.0, 0], 0, [0.3, 0.75, 9.6], 'wall'),
    ] };
    B.startSlots = [];
    for (let r = 0; r < 14; r++) for (let c = 0; c < 14; c++) B.startSlots.push([-2 + (6.5 - r) * 1.1, GY + 0.25 + 0.55, (c - 6.5) * 1.1]);
    // острів: широка плита 24 м, звужується до розвилки
    const AZ = 5.5, AW = 7;
    const island = sweepSeg('island', [[-14, 0, 0], [-4, -0.4, 0], [16, -1.9, 0]], { w0: 24, w1: 2 * (AZ + AW / 2), wEase: true, H: 3 });
    addStage('island', [island], () => 15);
    pushAux(gate, 'island');
    pushAux({ id: 'islandCap', kind: 'boxes', balls: [], boxes: [B.box([-14.3, 1.5, 0], 0, [0.3, 1.6, 13.5], 'wall')] }, 'island');
    X.head = { c: [-25, -2, 0], s: 1.5, split: true };
    X.islands.push({ c: [-14, -2.2, 0], r: 24, h: 16 });
    X.panel = { c: [-46, 16, 0], w: 48, h: 36 };

    // ── 2) ДВА РУКАВИ → ЛІЙКИ (Ø19, горло Ø8 — ~97 кульок цідяться ~15 с; вужче — хвіст відставав понад 60 с відліку) ──
    const FZ = 46, R_FUN = 9.5, R_TH = 4.0, H_FUN = 7, Y_TH = -12.5;
    const armCtrl = [[15.7, AZ], [22, 7], [30, 14], [38, 27], [45, 37.5], [50, 42.5]];
    const armY0 = island.end[1] - JD, ARM_DROP = 5.5;
    const FY = armY0 - ARM_DROP - 3.2;
    const arms = [], funnels = [], hubs = [];
    for (const sg of SIDES) {
      const pts = B.assignY(B.catmull(armCtrl.map(c => [c[0], 0, sg * c[1]]), 2), armY0, armY0 - ARM_DROP);
      arms.push(sweepSeg(sid('arm', sg), pts, { w0: AW, branch: sg > 0 ? 1 : 2, vBank: 8, maxBank: 24 }));
    }
    addStage('arms', arms, seg => seg.w0 / 2 + 3.5);
    pushAux({ id: 'fork1', kind: 'boxes', balls: [], boxes: [B.box([16.6, island.end[1] + 0.9, 0], Math.PI / 4, [1.5, 1.0, 1.5], 'wedge')] }, 'arms');
    const fprof = [[R_TH, Y_TH], [R_TH, -H_FUN], [R_FUN, 0], [R_FUN, 2.2], [R_FUN + 1, 2.2], [R_FUN + 1, -1.0], [R_TH + 1, -H_FUN - 0.6], [R_TH + 1, Y_TH]];
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], c = [57, FY, sg * FZ];
      const L = B.lathe(c, fprof, [[0, 1], [1, 2], [2, 3]], 40, 1.0);
      const f = { id: sid('funnel', sg), kind: 'lathe', c, profile: fprof, N: 40, mesh: L.mesh, plates: L.plates, branch: k + 1,
        center: [arms[k].end.slice(), [c[0], c[1] - 3.5, c[2]], [c[0], c[1] + Y_TH, c[2]]], length: 0 }; // середня точка на півглибині конуса: вище — кулька на конусі була 5 м під лінією (OOB)
      f.length = centerLen(f.center);
      funnels.push(f);
    }
    addStage('funnels', funnels, (seg, i) => i === 0 ? 14 : 6);
    // хаб під горлом: зона приземлення (~13 м/с) — борти 5 м, задня стінка
    const HUB_Y = FY + Y_TH - 1.6;
    for (const sg of SIDES) hubs.push(sweepSeg(sid('hub', sg), [[57 - 4.5, HUB_Y, sg * FZ], [57 + 10, HUB_Y - 2, sg * FZ]], { w0: 8, w1: 6, H: 5, branch: sg > 0 ? 1 : 2 }));
    addStage('hubs', hubs, () => 9);
    for (const sg of SIDES) pushAux({ id: sid('hubCap', sg), kind: 'boxes', balls: [], boxes: [B.box([57 - 4.8, HUB_Y + 0.8, sg * FZ], 0, [0.4, 1.4, 4.6], 'wall')] }, 'hubs');

    // ── 3) КРЕНДЕЛЬ: два коркскрю r 8 у різні боки (крок 6 м), рівномірний ухил ──
    const LOOP_R = 8, LOOP_PITCH = 6;
    const loops = [];
    for (const sg of SIDES) {
      const h = hubs[sg > 0 ? 0 : 1];
      const T = B.turtle(h.end[0] - JE, sg * FZ, 0).fwd(14).arc(-sg * 360, LOOP_R).fwd(6).arc(sg * 360, LOOP_R).fwd(16);
      const Lh = 2 * Math.PI * LOOP_R, Ltot = 36 + 2 * Lh;
      const drop = 2 * LOOP_PITCH * Ltot / (2 * Lh);
      loops.push(sweepSeg(sid('loops', sg), B.assignY(T.pts, h.end[1] - JD, h.end[1] - JD - drop), { w0: 6, branch: sg > 0 ? 1 : 2, vBank: 8, maxBank: 28, H: 2.5 }));
    }
    addStage('loops', loops, seg => seg.w0 / 2 + 3.5);

    // ── 4) «ЛОЖКА»: розширення 6→13 і довга пласка таця 13→7 з трьома темними пегами-ромбами
    //    (не пружні кулі: від них кулька на 5 % відскакувала назад угору і каталась туди-сюди до 37 с) ──
    const spoons = [], widens = [];
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], l = loops[k], x0 = l.end[0] - JE, y0 = l.end[1] - JD, z = sg * FZ;
      widens.push(sweepSeg(sid('widen', sg), [[x0, y0, z], [x0 + 12, y0 - 1.3, z]], { w0: 6, w1: 13, wEase: true, branch: k + 1 }));
    }
    addStage('widens', widens, () => 10);
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], w = widens[k], x0 = w.end[0] - JE, y0 = w.end[1] - JD, z = sg * FZ;
      const SP_L = 62;
      spoons.push(sweepSeg(sid('spoon', sg), [[x0, y0, z], [x0 + SP_L, y0 - 4.8, z]], { w0: 13, w1: 7, wEase: true, H: 2.5, branch: k + 1 }));
    }
    addStage('spoons', spoons, seg => seg.w0 / 2 + 3.5);
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], s = spoons[k], boxes = [];
      for (const [dx, dz] of [[12, 3.2], [12, -3.2], [26, 0]]) { const x = s.start[0] + dx; boxes.push(B.box([x, B.floorAtX(s, x) + 0.6, sg * FZ + dz], Math.PI / 4, [0.75, 0.9, 0.75], 'wedge')); }
      pushAux({ id: sid('pegs', sg), kind: 'boxes', balls: [], boxes }, 'spoons');
    }

    // ── 5) КОЛЕСО-МІШЕНЬ: похилий (14°) обертовий диск r 9 із 12 планок, 6 низьких коротких
    //    радіальних ребер (до обода не дістають — інакше кульки їздили по колу) і центральним
    //    бобом; статичний обід з прорізами на вході й виході ──
    const WR = 9, WT = 14 * D2R, ct = Math.cos(WT), st = Math.sin(WT);
    const n = [st, ct, 0], e1 = [ct, -st, 0], e2 = [0, 0, 1];   // нормаль, напрям «униз по схилу», поперек
    const inPlane = (r, phi) => V.add(V.scale(e1, r * Math.cos(phi)), V.scale(e2, r * Math.sin(phi)));
    const rims = [], exits = [];
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], s = spoons[k];
      const E = [s.end[0] - 0.2, s.end[1] - JD, sg * FZ];                   // край диска на вході
      const c = V.add(E, V.scale(e1, WR));
      const Xp = V.add(c, V.scale(e1, WR));                                 // край на виході
      const boxes = [];
      for (let i = 0; i < 12; i++) {
        const phi = i * Math.PI / 12, a = inPlane(1, phi), z2 = V.cross(a, n);
        boxes.push({ pos: V.scale(n, -0.3), quat: B.quatFromBasis(a, n, z2), size: [WR, 0.3, WR * Math.tan(Math.PI / 24) + 0.05], role: 'floor' });
      }
      for (let i = 0; i < 6; i++) {
        const phi = i * Math.PI / 3, a = inPlane(1, phi), z2 = V.cross(a, n);
        boxes.push({ pos: V.add(V.scale(a, 4.3), V.scale(n, 0.08)), quat: B.quatFromBasis(a, n, z2), size: [2.2, 0.08, 0.4], role: 'wall' });
      }
      const spinner = { id: sid('wheel', sg), kind: 'spinner', c, axis: n.slice(), omega: -sg * 0.3, phase: 0, boxes,
        balls: [{ pos: V.scale(n, 0.4), r: 1.3 }], noProgress: true };
      // обід: 24 сектори, внутрішня грань на r 9.3 (щілина до планок ≤0.3 — кульку не защемлює), без секторів ±25° на вході (−x) і ±15° на виході (+x) —
      // ширший проріз, ніж губи жолоба, давав щілину, крізь яку кульки падали з краю диска
      const rimBoxes = [];
      for (let i = 0; i < 24; i++) {
        const phi = i * Math.PI / 12, deg = i * 15;
        if (Math.abs(deg - 180) <= 25 || deg <= 15 || deg >= 345) continue;
        const t = inPlane(1, phi + Math.PI / 2), rad = inPlane(1, phi);
        rimBoxes.push({ pos: V.add(V.add(c, V.scale(rad, WR + 0.8)), V.scale(n, 1.75)), quat: B.quatFromBasis(t, n, V.cross(t, n)), size: [(WR + 0.8) * Math.tan(Math.PI / 24) + 0.12, 1.75, 0.5], role: 'wall' }); // обід 3.5 м: кулька, підкинута ребром, перелітала 2.5
      }
      rims.push({ id: sid('rim', sg), kind: 'boxes', boxes: rimBoxes, balls: [], branch: k + 1, center: [E, Xp], length: 2 * WR, spinner });
      exits.push(Xp);
      X.wheels.push({ c, n, e1, e2, R: WR, sg });
    }
    addStage('wheels', rims, () => 13.5);
    for (const r of rims) pushAux(r.spinner, 'wheels');

    // ── 6) ВИХІД (30 м, 7 % — хвіст, що сповзає з диска на 2 м/с, на 3 % повз) → ГЕЛІКОЇД (1 виток r 9, крок 6.5 — власний ухил, бо при
    //    спільному 9 % крок падав до 4 м і борти нижнього витка стирчали крізь підлогу
    //    підходу) → РАМПА ДО ЦЕНТРУ (дуга 40° → пряма → дуга 40°, 8 %) ──
    const RAMP_R = 12, RAMP_A = 40, RZ = 7, HX_R = 9, HX_PITCH = 6.5;
    const L_RAMP = (FZ - RZ - 2 * RAMP_R * (1 - Math.cos(RAMP_A * D2R))) / Math.sin(RAMP_A * D2R);
    const wexits = [], helices = [], ramps = [];
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], Xp = exits[k];
      wexits.push(sweepSeg(sid('wexit', sg), [[Xp[0] - 0.2, Xp[1] - JD, sg * FZ], [Xp[0] + 30, Xp[1] - JD - 30 * 0.07, sg * FZ]], { w0: 8, w1: 6, wEase: true, branch: k + 1, H: 3 }));
    }
    addStage('wexits', wexits, seg => seg.w0 / 2 + 3.5);
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], e = wexits[k];
      // 16 м прямої після витка: крен спадає ≤1.7°/м, коротша пряма лишала ~19° на стику
      // з пласкою рампою — внутрішній край на 1 м нижче, кулька впиралась у торець
      const T = B.turtle(e.end[0] - JE, sg * FZ, 0).fwd(2).arc(-sg * 360, HX_R).fwd(16);
      const Lh = 2 * Math.PI * HX_R;
      helices.push(sweepSeg(sid('helix', sg), B.assignY(T.pts, e.end[1] - JD, e.end[1] - JD - HX_PITCH * (Lh + 18) / Lh), { w0: 6, branch: k + 1, vBank: 9, maxBank: 28, H: 3 }));
    }
    addStage('helices', helices, seg => seg.w0 / 2 + 3.5);
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], h = helices[k];
      const T = B.turtle(h.end[0] - JE, sg * FZ, 0).fwd(2).arc(-sg * RAMP_A, RAMP_R).fwd(L_RAMP).arc(sg * RAMP_A, RAMP_R).fwd(16);
      const Ltot = 18 + 2 * RAMP_R * RAMP_A * D2R + L_RAMP;
      ramps.push(sweepSeg(sid('ramp', sg), B.assignY(T.pts, h.end[1] - JD, h.end[1] - JD - Ltot * 0.06), { w0: 6, w1: 5, branch: k + 1, vBank: 6, maxBank: 18 }));
    }
    addStage('ramps', ramps, seg => seg.w0 / 2 + 3.5);
    // велетні за колесами (обличчям до старту), лазери з очей — на «ложки»
    for (let k = 0; k < 2; k++) {
      const sg = SIDES[k], c = X.wheels[k].c, s = 4.2;
      const gx = c[0] + 50, gz = sg * (FZ + 8), gy = c[1] - 26;
      X.giants.push({ c: [gx, gy, gz], s, unk: sg < 0 });
      X.islands.push({ c: [gx, gy, gz], r: 30, h: 22 });
      const eyeY = gy + (PIX_H - 10) * s, sp = spoons[k];
      const tgt = [sp.start[0] + 26, B.floorAtX(sp, sp.start[0] + 26), sg * FZ];
      for (const dz of [-3.5 * s, 3.5 * s]) X.lasers.push({ a: [gx - 1.5 * s, eyeY, gz + dz], b: [tgt[0] + dz * 0.3, tgt[1] + 0.3, tgt[2] + dz * 0.15], unk: sg < 0 });
    }

    // ── 7) ЗЛИТТЯ: посадкова плита 21 м → V-звуження до 6 м (обидва пологі, ~5 %: крутіше —
    //    у зміїсту трубу влітали 14–16 м/с і перелітали борт у першій дузі) ──
    const rE = ramps[0].end;
    const landing = sweepSeg('landing', [[rE[0] - JE, rE[1] - JD, 0], [rE[0] + 46, rE[1] - JD - 2.2, 0]], { w0: 2 * (RZ + 3.5), H: 3 });
    addStage('landing', [landing], () => 14);
    const vplate = sweepSeg('vplate', B.assignY(B.catmull([[landing.end[0] - JE, 0, 0], [landing.end[0] + 15, 0, 0], [landing.end[0] + 30, 0, 0], [landing.end[0] + 44, 0, 0]], 2), landing.end[1] - JD, landing.end[1] - JD - 2.6),
      { w0: 2 * (RZ + 3.5), w1: 6, wEase: true, H: 3 });
    addStage('vplate', [vplate], seg => seg.w0 / 2 + 4);

    // ── 8) ЗМІЇСТА ТРУБА: 7 дуг r 10 (50/−100/100/−100/100/−100/50), спуск 12%, крен під 6 м/с (під 9 кулька терлась об внутрішній борт і повзла 4 м/с) ──
    const Z = B.turtle(vplate.end[0] - JE, 0, 0).fwd(6).arc(50, 10).arc(-100, 10).arc(100, 10).arc(-100, 10).arc(100, 10).arc(-100, 10).arc(50, 10).fwd(14);
    const zigL = 20 + 600 * D2R * 10;
    const zig = sweepSeg('zig', B.assignY(Z.pts, vplate.end[1] - JD, vplate.end[1] - JD - zigL * 0.12), { w0: 4.5, vBank: 6, maxBank: 24, H: 3 });
    addStage('zig', [zig], seg => seg.w0 / 2 + 3.5);

    // ── 9) ТАРІЛКА Ø36 з горлом Ø7.6: труба закінчується над обідком за 12 м від центру ──
    const R_D = 18, R_T = 3.8, Y_T = -12;
    const zE = zig.end, zD = zig.endDir;
    const DC = [zE[0] + zD[0] * 12, zE[1] - 3.2, zE[2] + zD[2] * 12];
    const dprof = [[R_T, Y_T], [R_T, -6], [6, -2.2], [R_D, 0], [R_D, 2.0], [R_D + 1, 2.0], [R_D + 1, -1.2], [7, -3.4], [R_T + 1, -6.5], [R_T + 1, Y_T]];
    const DL = B.lathe(DC, dprof, [[0, 1], [1, 2], [2, 3], [3, 4]], 48, 1.0);
    const dish = { id: 'dish', kind: 'lathe', c: DC.slice(), profile: dprof, N: 48, mesh: DL.mesh, plates: DL.plates,
      center: [zE.slice(), [DC[0], DC[1] - 1.5, DC[2]], [DC[0], DC[1] + Y_T, DC[2]]], length: 0 };
    dish.length = centerLen(dish.center);
    addStage('dish', [dish], (seg, i) => i === 0 ? 22 : 6);
    const H2Y = DC[1] + Y_T - 1.6;
    const hub2 = sweepSeg('hub2', [[DC[0] - 4.5, H2Y, DC[2]], [DC[0] + 10, H2Y - 2, DC[2]]], { w0: 8, w1: 6, H: 5 });
    addStage('hub2', [hub2], () => 9);
    pushAux({ id: 'hub2Cap', kind: 'boxes', balls: [], boxes: [B.box([DC[0] - 4.8, H2Y + 0.8, DC[2]], 0, [0.4, 1.4, 4.6], 'wall')] }, 'hub2');

    // ── 10) ТРУБА З «ПУЗОМ» (6→11→5, два пеги) І ХВИЛЯСТИЙ СПУСК ДО ФІНІШУ ──
    const b0 = [hub2.end[0] - JE, hub2.end[1] - JD, DC[2]];
    const bulge1 = sweepSeg('bulge1', [b0, [b0[0] + 16, b0[1] - 2.9, DC[2]]], { w0: 6, w1: 11, wEase: true, H: 3 });
    addStage('bulge1', [bulge1], () => 10);
    const bulge2 = sweepSeg('bulge2', [[bulge1.end[0] - JE, bulge1.end[1] - JD, DC[2]], [bulge1.end[0] + 16, bulge1.end[1] - JD - 2.9, DC[2]]], { w0: 11, w1: 5, wEase: true, H: 3 });
    addStage('bulge2', [bulge2], () => 10);
    // пеги-ромби (не пружні кулі: з горла кульки летять ~12 м/с і від пружного пега перелітали борт)
    pushAux({ id: 'bulgePegs', kind: 'boxes', balls: [], boxes: [
      B.box([bulge1.end[0] - 2, B.floorAtX(bulge1, bulge1.end[0] - 2) + 0.6, DC[2] - 2.4], Math.PI / 4, [0.75, 0.9, 0.75], 'wedge'),
      B.box([bulge1.end[0] - 2, B.floorAtX(bulge1, bulge1.end[0] - 2) + 0.6, DC[2] + 2.4], Math.PI / 4, [0.75, 0.9, 0.75], 'wedge'),
    ] }, 'bulge2');
    const wx = bulge2.end[0] - JE, wy = bulge2.end[1] - JD;
    const wavy = sweepSeg('wavy', B.assignY(B.catmull([[wx, 0, DC[2]], [wx + 8, 0, DC[2]], [wx + 20, 0, DC[2] + 4], [wx + 34, 0, DC[2] - 4], [wx + 48, 0, DC[2] + 4], [wx + 62, 0, DC[2]], [wx + 72, 0, DC[2]]], 2), wy, wy - 11),
      { w0: 5, vBank: 6, maxBank: 24, H: 2.5 });
    addStage('wavy', [wavy], seg => seg.w0 / 2 + 3.5);
    // фінішний квадрат 22×22 із заокругленими кутами
    const BOWL = 22, bX = wavy.end[0] + BOWL / 2 - JE, bY = wavy.end[1] - JD - 0.1, BW_H = 3.5, CORNER = 4, bz = DC[2];
    const bowl = {
      id: 'bowl', kind: 'boxes', balls: [], boxes: [
        B.box([bX, bY - 0.3, bz], 0, [BOWL / 2 + 0.6, 0.3, BOWL / 2 + 0.6], 'floor'),
        B.box([bX + BOWL / 2 + 0.5, bY + BW_H / 2, bz], 0, [0.5, BW_H / 2, BOWL / 2 - CORNER + 0.5], 'wall'),
        B.box([bX, bY + BW_H / 2, bz + BOWL / 2 + 0.5], 0, [BOWL / 2 - CORNER + 0.5, BW_H / 2, 0.5], 'wall'),
        B.box([bX, bY + BW_H / 2, bz - BOWL / 2 - 0.5], 0, [BOWL / 2 - CORNER + 0.5, BW_H / 2, 0.5], 'wall'),
        B.box([bX - BOWL / 2 - 0.5, bY + BW_H / 2, bz + (BOWL / 2 - CORNER + 5.5) / 2], 0, [0.5, BW_H / 2, (BOWL / 2 - CORNER - 5.5) / 2 + 0.01], 'wall'),
        B.box([bX - BOWL / 2 - 0.5, bY + BW_H / 2, bz - (BOWL / 2 - CORNER + 5.5) / 2], 0, [0.5, BW_H / 2, (BOWL / 2 - CORNER - 5.5) / 2 + 0.01], 'wall'),
      ],
      c: [bX, bY, bz], center: [[bX - BOWL / 2, bY, bz], [bX, bY, bz]], length: BOWL / 2,
    };
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = bX + sx * (BOWL / 2 - CORNER / 2 + 0.35), cz = bz + sz * (BOWL / 2 - CORNER / 2 + 0.35);
      bowl.boxes.push(B.box([cx, bY + BW_H / 2, cz], sx * sz > 0 ? -Math.PI / 4 : Math.PI / 4, [CORNER * 0.75, BW_H / 2, 0.5], 'wall'));
    }
    addStage('bowl', [bowl], () => 20);

    B.finish = { p: wavy.end.slice(), f: [1, 0, 0], r: 9, s: wavy.s0 + wavy.length };
    B.extra.orbit = bowl.c.slice();
    B.extra.pixel = X;
    X.lightIds = B.segments.filter(g => /P$/.test(g.id) && g.kind !== 'spinner').map(g => g.id);
    B.extraPoints.push([-50, 40, -30], [-50, 40, 30]);
  },

  // інтро: голова за стартовою плитою анфас (як стартовий кадр гри)
  intro(track, pos, look) {
    pos.set(74, 26, -14);
    look.set(-14, 20, 0);
  },

  // режисура: розвилка й лійки з фронту (голова в кадрі), крендель з обома
  // гілками і головою за ними, колесо-мішень з велетнем, тарілка згори
  camera(st, leader, pos, look, centerAt) {
    const track = st.track, stg = track.stages, s = leader.prog, X = track.extra.pixel;
    let stage = null; for (const g of stg) if (s >= g.s0) stage = g;
    const id = stage ? stage.id : '';
    if (id === 'island' || id === 'arms') { pos.set(112, 24, 0); look.set(18, -8, 0); return true; }
    if (id === 'funnels' || id === 'hubs') {
      const f = track.byId[leader.z > 0 ? 'funnelP' : 'funnelU'];
      pos.set(f.c[0] + 6, f.c[1] + 30, f.c[2] * 0.15); look.set(f.c[0], f.c[1] - 6, f.c[2] * 0.85); return true;
    }
    if (id === 'loops' || id === 'widens') {
      const l = track.byId.loopsP;
      pos.set(l.end[0] + 80, l.start[1] + 58, 0); look.set(l.start[0] + 2, l.start[1] + 6, 0); return true;
    }
    if (id === 'spoons' || id === 'wheels') {
      const w = X.wheels[leader.z > 0 ? 0 : 1], c = w.c;
      pos.set(c[0] - 34, c[1] + 18, c[2] * 0.62); look.set(c[0] + 4, c[1] + 6, c[2]); return true;
    }
    if (id === 'dish' || id === 'hub2') {
      const d = track.byId.dish;
      pos.set(d.c[0] - 32, d.c[1] + 28, d.c[2] - 22); look.set(d.c[0], d.c[1] - 5, d.c[2]); return true;
    }
    return false;
  },

  // декор: піксельні бюсти (InstancedMesh), лазери, острови, панель за головою,
  // світлий шар гілки Pixel, кільця мішеней, LED-обідок фінішу
  decor(track, ctx) {
    const { THREE, scene, mats, env } = ctx;
    const X = track.extra.pixel;
    // матеріали й текстура — один раз на сторінку: ядро при зміні карти звільняє лише геометрії
    const DM = MAP._decorMats || (MAP._decorMats = {
      pix: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.02, envMap: env, envMapIntensity: 0.25 }),
      laserP: new THREE.MeshBasicMaterial({ color: '#ff3a24', fog: false, side: THREE.DoubleSide }),
      laserU: new THREE.MeshBasicMaterial({ color: '#5af2ff', fog: false, side: THREE.DoubleSide }),
      rock: new THREE.MeshStandardMaterial({ color: '#3a3f48', roughness: 0.95 }),
      grass: new THREE.MeshStandardMaterial({ color: '#4f8a2c', roughness: 0.9 }),
      panel: null,
      light: new THREE.MeshStandardMaterial({ color: '#a4a9b4', roughness: 0.3, metalness: 0.25, envMap: env, envMapIntensity: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      ringP: new THREE.MeshStandardMaterial({ color: '#e6e8ee', roughness: 0.4, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      ringU: new THREE.MeshStandardMaterial({ color: '#4a505c', roughness: 0.4, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    });
    // ── бюсти: 1 куб на піксель (масштаб s, глибина 3s), колір per-instance ──
    {
      const figs = [X.head].concat(X.giants);
      let count = 0;
      for (const f of figs) for (const row of PIX_ROWS) for (const ch of row) if (ch !== '.') count++;
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const inst = new THREE.InstancedMesh(geo, DM.pix, count);
      const M = new THREE.Matrix4(), col = new THREE.Color();
      let i = 0;
      for (const f of figs) {
        const s = f.s, top = f.c[1] + PIX_H * s;
        for (let r = 0; r < PIX_H; r++) for (let c = 0; c < PIX_COLS; c++) {
          let ch = PIX_ROWS[r][c];
          if (ch === '.') continue;
          // спереду (з +x) екранне ліво = +z: колонка 0 — найбільший z
          const z = f.c[2] + (PIX_COLS / 2 - c - 0.5) * s;
          if (f.unk || (f.split && z < 0)) ch = UNK_MAP[ch];
          M.makeScale(s, s, 3 * s); M.setPosition(f.c[0], top - (r + 0.5) * s, z);
          inst.setMatrixAt(i, M); inst.setColorAt(i, col.set(PIX_PAL[ch])); i++;
        }
      }
      inst.castShadow = false; inst.receiveShadow = true; inst.frustumCulled = false; // тіні велетнів накривали б колеса й «ложки» суцільною плямою
      scene.add(inst);
    }
    // ── лазери: тонкі циліндри від очей до «ложок» (червоні — Pixel, блакитні — Unknown) ──
    {
      const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), d = new THREE.Vector3();
      const build = unk => {
        const parts = [];
        for (const l of X.lasers) {
          if (l.unk !== unk) continue;
          d.set(l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]);
          const L = d.length(); q.setFromUnitVectors(up, d.normalize());
          const g = new THREE.CylinderGeometry(0.28, 0.45, L, 6, 1, true);
          g.translate(0, L / 2, 0); g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)); g.translate(l.a[0], l.a[1], l.a[2]); // r128: BufferGeometry без applyQuaternion
          parts.push({ pos: new Float32Array(g.getAttribute('position').array), nrm: new Float32Array(g.getAttribute('normal').array), uv: new Float32Array(g.getAttribute('uv').array), idx: new Uint32Array(g.getIndex().array) });
          g.dispose();
        }
        const m = new THREE.Mesh(ctx.mergeParts(parts), unk ? DM.laserU : DM.laserP);
        m.frustumCulled = false; scene.add(m);
      };
      build(false); build(true);
    }
    // ── острови: скеля (усічений конус) + зелена «трава» зверху ──
    {
      const rock = [], grass = [];
      const part = g => ({ pos: new Float32Array(g.getAttribute('position').array), nrm: new Float32Array(g.getAttribute('normal').array), uv: new Float32Array(g.getAttribute('uv').array), idx: new Uint32Array(g.getIndex().array) });
      for (const isl of X.islands) {
        const g = new THREE.CylinderGeometry(isl.r, isl.r * 0.25, isl.h, 14, 1); g.translate(isl.c[0], isl.c[1] - isl.h / 2 - 0.4, isl.c[2]); rock.push(part(g)); g.dispose();
        const t = new THREE.CylinderGeometry(isl.r + 0.4, isl.r + 0.4, 0.8, 14, 1); t.translate(isl.c[0], isl.c[1] - 0.4, isl.c[2]); grass.push(part(t)); t.dispose();
      }
      const mr = new THREE.Mesh(ctx.mergeParts(rock), DM.rock); mr.receiveShadow = true; scene.add(mr);
      const mg = new THREE.Mesh(ctx.mergeParts(grass), DM.grass); mg.receiveShadow = true; scene.add(mg);
    }
    // ── панель-сітка за головою (у грі — стартова плита, піднята вертикально) ──
    {
      if (!DM.panel) {
        const cv = document.createElement('canvas'); cv.width = cv.height = 128;
        const g = cv.getContext('2d'); g.fillStyle = '#151a24'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#3a4250';
        for (let y = 8; y < 128; y += 16) for (let x = 8; x < 128; x += 16) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
        const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(X.panel.w / 8, X.panel.h / 8);
        DM.panel = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.2, envMap: env, envMapIntensity: 0.6, side: THREE.DoubleSide });
      }
      const m = new THREE.Mesh(new THREE.PlaneGeometry(X.panel.w, X.panel.h), DM.panel);
      m.position.set(X.panel.c[0], X.panel.c[1], X.panel.c[2]); m.rotation.y = Math.PI / 2; m.receiveShadow = true;
      scene.add(m);
    }
    // ── світлий «срібний» шар гілки Pixel: ті самі вершини поверх темного мармуру ──
    {
      const parts = [];
      for (const id of X.lightIds) {
        const g = track.byId[id];
        if (g.kind === 'sweep') parts.push(mbSweepPart(g));
        else if (g.kind === 'lathe') parts.push(mbLathePart(g));
        else if (g.kind === 'boxes') { for (const b of g.boxes) parts.push(ctx.boxPart(b)); }
      }
      if (parts.length) {
        const m = new THREE.Mesh(ctx.mergeParts(parts), DM.light);
        m.receiveShadow = true; m.frustumCulled = false; scene.add(m);
      }
    }
    // ── кільця-мішені на колесах (концентричні — обертання не видно) ──
    {
      const part = g => ({ pos: new Float32Array(g.getAttribute('position').array), nrm: new Float32Array(g.getAttribute('normal').array), uv: new Float32Array(g.getAttribute('uv').array), idx: new Uint32Array(g.getIndex().array) });
      const mk = (w, mat) => {
        const parts = [];
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(w.n[0], w.n[1], w.n[2]));
        for (const [r0, r1] of [[1.9, 3.2], [4.6, 5.9], [7.3, 8.6]]) {
          const g = new THREE.RingGeometry(r0, r1, 40, 1); g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)); g.translate(w.c[0] + w.n[0] * 0.04, w.c[1] + w.n[1] * 0.04, w.c[2] + w.n[2] * 0.04);
          parts.push(part(g)); g.dispose();
        }
        const m = new THREE.Mesh(ctx.mergeParts(parts), mat);
        m.renderOrder = 1; scene.add(m);
      };
      for (const w of X.wheels) mk(w, w.sg > 0 ? DM.ringP : DM.ringU);
    }
    // ── обідок фінішу: смуга LED + FINISH! на верхній грані кожного борту ──
    {
      const parts = [];
      for (const b of track.byId.bowl.boxes.filter(b => b.role === 'wall')) {
        const long = b.size[0] > b.size[2] ? 0 : 2;
        const L = 2 * b.size[long] + 0.2;
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
      scene.add(m);
    }
  },
};
window.MB_MAPS = window.MB_MAPS || {};
window.MB_MAPS[MAP.id] = MAP;
})();
