/* ══════════════════════════════════════════════════════════════
   Револьвер у 3D (модель — blender/revolver.blend → models/revolver/revolver.glb).
   Та сама гра, що й 2D-версія в app.js (runRevolver): до 6 учасників у
   каморах, барабан крутиться, курок б'є — камора під ним вибуває, останній
   перемагає. Тут лише показ: камера з-за плеча стрільця на торець барабана,
   патрони з ніками в'їжджають у камори, барабан справді обертається, спалах,
   дим, віддача, вилітає гільза. Ніки — HTML-плашки поверх канви (чіткий текст).
   Якщо WebGL/модель недоступні — працює стара 2D-версія.
   ══════════════════════════════════════════════════════════════ */
(function () {
  // моделі револьвера: однакова схема вузлів (REV_FRAME/REV_CYL/REV_HAMMER/REV_BULLET/REV_CASE), свої мітки
  //   RC — радіус кола камор, RIM_X — задня площина барабана (тут сидять фланці патронів), MUZZLE — дуло,
  //   FLOOR_Y — стіл під руків'ям, PIVOT — точка віддачі біля руків'я, cap — декоративна розетка в центрі барабана
  const MODELS = {
    classic: { glb: '/assets/models/revolver/revolver.glb', RC: 1.36, RIM_X: -1.75, MUZZLE: [14.1, 1.36, 0], FLOOR_Y: -9.2,
               PIVOT: [-4.2, -4.5, 0], CAM: { pos: [-17.0, 5.0, -7.6], look: [1.4, -1.1, 0] }, cap: true },
    // Кольт Нейві 1851 (blender/colt_build.py): довгий ствол, курок на гвинті нижче осі барабана
    colt:    { glb: '/assets/models/revolver/revolver_colt.glb?v=20261122c', RC: 1.36, RIM_X: -2.495, MUZZLE: [22.31, 1.36, 0], FLOOR_Y: -11.47,
               PIVOT: [-7.6, -6.4, 0], CAM: { pos: [-19.5, 5.6, -8.6], look: [1.6, -1.4, 0] }, cap: false,   // з-за плеча стрільця на торець барабана (як було спочатку)
               // барабан відкидається вбік на «кронштейні»: вісь повороту паралельна стволу, у точці (y, z) під барабаном; ang — кут (рад)
               swing: { y: -3.0, z: 0, ang: -1.66 } },
  };
  const MODEL = MODELS.colt;
  const GLB = MODEL.glb, RC = MODEL.RC, RIM_X = MODEL.RIM_X, MUZZLE = MODEL.MUZZLE, FLOOR_Y = MODEL.FLOOR_Y, CAM = MODEL.CAM;
  const runRevolver2D = window.runRevolver;
  let glbP = null, R = null;

  function loadGLB() {
    if (!glbP) glbP = new Promise((ok, no) => new THREE.GLTFLoader().load(GLB, g => ok(g.scene), undefined, no));
    return glbP;
  }
  const ease = {
    outCubic: t => 1 - Math.pow(1 - t, 3),
    outQuart: t => 1 - Math.pow(1 - t, 4),
    inOut: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    // ≈ cubic-bezier(0.2, 0.9, 0.3, 1) як у 2D-версії: різкий розгін, довге гальмування
    spin: t => 1 - Math.pow(1 - t, 3.6),
  };
  function tween(ms, fn, ez) {
    return new Promise(res => R.tweens.push({ t0: performance.now(), ms, fn, ez: ez || ease.outCubic, res }));
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── сцена: рендерер, світло, оточення для металу ──
  async function ensureScene(area) {
    if (R && R.area === area) return R;
    const scene0 = await loadGLB();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.4;
    renderer.domElement.className = 'rev3d-canvas';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 200);
    // оточення: темна кімната з теплою смугою світла згори і зеленим відсвітом — для відблисків металу
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ color: '#08080d', side: THREE.BackSide })));
    const panel = (c, x, y, z, w, h) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); envScene.add(m); };
    panel('#fff2d6', 0, 30, 0, 60, 14); panel('#ffffff', -30, 12, -18, 18, 10); panel('#53fc18', 20, -6, 30, 30, 8); panel('#8b5cf6', -20, -4, 30, 26, 8);
    const pm = new THREE.PMREMGenerator(renderer); const env = pm.fromScene(envScene, 0.04).texture; scene.environment = env;
    scene.add(new THREE.HemisphereLight('#cfd6ff', '#140f0a', 0.55));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const key = new THREE.DirectionalLight('#fff1dc', 1.6); key.position.set(-6, 16, -10); scene.add(key);
    key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0006;
    Object.assign(key.shadow.camera, { left: -18, right: 22, top: 16, bottom: -16, near: 1, far: 60 }); key.shadow.camera.updateProjectionMatrix();
    // стіл: темна поверхня з плямою світла під револьвером — гільзи падають сюди й лишаються лежати
    const tableTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d');
      // темне сукно, що до країв розчиняється в прозорість — стіл зливається з фоном оверлея
      const gr = g.createRadialGradient(256, 256, 10, 256, 256, 256);
      gr.addColorStop(0, 'rgba(26,28,36,1)'); gr.addColorStop(0.45, 'rgba(16,17,24,0.95)'); gr.addColorStop(0.8, 'rgba(10,10,15,0.5)'); gr.addColorStop(1, 'rgba(8,8,12,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 9000; i++) { g.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.02) + ')'; g.fillRect(Math.random() * 512, Math.random() * 512, 1, 1); }
      const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t; })();
    const table = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.95, metalness: 0.0, transparent: true, depthWrite: false, color: '#9a9aa8' }));
    table.rotation.x = -Math.PI / 2; table.position.set(2, FLOOR_Y, 0); table.receiveShadow = true; scene.add(table);
    const rim = new THREE.DirectionalLight('#9fd8ff', 1.0); rim.position.set(10, 4, 12); scene.add(rim);
    const glowL = new THREE.PointLight('#53fc18', 0.0, 30, 2); glowL.position.set(-4, 0, 0); scene.add(glowL);
    // модель: рама (корінь віддачі), барабан, курок; шаблони патрона й гільзи
    const root = scene0.clone(true);
    const nodes = {}; root.traverse(o => { if (/^REV_/.test(o.name) && !nodes[o.name]) nodes[o.name] = o; if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const gun = new THREE.Group(); scene.add(gun);
    // точка віддачі — біля руків'я: група-шарнір, у якій сидить модель
    const pivot = new THREE.Group(); pivot.position.set(MODEL.PIVOT[0], MODEL.PIVOT[1], MODEL.PIVOT[2]); gun.add(pivot);
    root.position.set(-MODEL.PIVOT[0], -MODEL.PIVOT[1], -MODEL.PIVOT[2]); pivot.add(root);
    const tplB = nodes.REV_BULLET, tplC = nodes.REV_CASE;
    if (tplB) tplB.visible = false; if (tplC) tplC.visible = false;
    // латунь патрона: повністю металева в темному оточенні виходила коричневою — робимо світлішою й теплішою
    if (tplB) tplB.traverse(o => { if (o.isMesh && o.material.name === 'R_Brass') { const m = o.material.clone(); m.color.set('#e7b04a'); m.metalness = 0.6; m.roughness = 0.28; m.emissive = new THREE.Color('#3a2404'); o.material = m; } });
    headMat = new THREE.MeshStandardMaterial({ map: headTex(), metalness: 0.55, roughness: 0.28, emissive: new THREE.Color('#ffffff'), emissiveMap: null, emissiveIntensity: 0 });
    headMat.emissiveMap = headMat.map; headMat.emissiveIntensity = 0.14;
    // центр барабана: замість «зірки» екстрактора з кубиків — полірована розетка з зеленим камінцем
    if (nodes.REV_CYL && MODEL.cap) {
      // саму «зірку» з моделі вирізаємо (золоті трикутники біля осі на задньому торці) — тоді кришка може бути маленькою
      root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(nodes.REV_CYL.matrixWorld).invert();
      nodes.REV_CYL.traverse(o => {
        if (!o.isMesh || !o.geometry.index || o.material.name !== 'R_Gold') return;
        const g = o.geometry.clone(), pos = g.attributes.position, idx = g.index.array, keep = [], v = new THREE.Vector3();
        const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
        const star = i => { v.fromBufferAttribute(pos, i).applyMatrix4(m); return v.x < -1.4 && Math.hypot(v.y, v.z) < 0.75; };
        for (let t = 0; t < idx.length; t += 3) if (!(star(idx[t]) && star(idx[t + 1]) && star(idx[t + 2]))) keep.push(idx[t], idx[t + 1], idx[t + 2]);
        g.setIndex(keep); o.geometry = g;
      });
      const cap = new THREE.Group();
      // темна сталь у тон барабана (лише прикриває «зірку»), по краю — тонке золоте кільце, у центрі — камінчик
      const steel = new THREE.MeshStandardMaterial({ color: '#141519', metalness: 0.85, roughness: 0.32 });
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.42, 0.1, 48), steel);
      disc.rotation.z = Math.PI / 2;                  // вісь циліндра → вздовж X (вісь барабана)
      const gold = new THREE.MeshStandardMaterial({ color: '#d9a640', metalness: 0.7, roughness: 0.3, emissive: '#2a1a02' });
      const ringG = new THREE.Mesh(new THREE.TorusGeometry(0.39, 0.03, 10, 48), gold); ringG.rotation.y = Math.PI / 2; ringG.position.x = -0.06;
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.02, 8, 32), gold); ring2.rotation.y = Math.PI / 2; ring2.position.x = -0.06;
      const gem = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), new THREE.MeshStandardMaterial({ color: '#16f802', emissive: '#53fc18', emissiveIntensity: 0.9, roughness: 0.15 }));
      gem.scale.set(0.5, 1, 1); gem.position.x = -0.07;
      cap.add(disc, ringG, ring2, gem); cap.position.set(-2.0, 0, 0);
      nodes.REV_CYL.add(cap);
    }
    for (const n of ['REV_gem']) if (nodes[n]) nodes[n].traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.emissive = new THREE.Color('#53fc18'); o.material.emissiveIntensity = 1.4; } });
    // спалах на дулі + дим
    const flashTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62); gr.addColorStop(0, 'rgba(255,255,240,1)'); gr.addColorStop(0.25, 'rgba(255,214,90,0.95)'); gr.addColorStop(0.6, 'rgba(255,120,20,0.35)'); gr.addColorStop(1, 'rgba(255,80,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
    const smokeTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 6, 64, 64, 62); gr.addColorStop(0, 'rgba(210,210,220,0.55)'); gr.addColorStop(1, 'rgba(210,210,220,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    flash.position.set(...MUZZLE); flash.scale.set(5, 5, 1); root.add(flash);
    const flashL = new THREE.PointLight('#ffcc66', 0, 40, 2); flashL.position.set(MUZZLE[0] - 1, MUZZLE[1], MUZZLE[2]); root.add(flashL);
    const smokes = [];
    for (let i = 0; i < 6; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, depthWrite: false, transparent: true, opacity: 0 })); s.visible = false; scene.add(s); smokes.push(s); }
    // шар ніків
    const labels = document.createElement('div'); labels.className = 'rev3d-labels';
    area.appendChild(renderer.domElement); area.appendChild(labels);
    R = { area, renderer, scene, camera, gun, pivot, root, nodes, cyl: nodes.REV_CYL, hammer: nodes.REV_HAMMER, tplB, tplC, flash, flashL, smokes, glowL,
          labels, chambers: [], tweens: [], free: [], shake: 0, raf: 0, recoil: 0, swing: 0, cylP0: nodes.REV_CYL ? nodes.REV_CYL.position.clone() : null,
          cyl0: nodes.REV_CYL ? nodes.REV_CYL.quaternion.clone() : null,
          ham0: nodes.REV_HAMMER ? nodes.REV_HAMMER.quaternion.clone() : null, spin: 0, cock: 0, t: 0 };
    resize(); window.addEventListener('resize', resize);
    return R;
  }
  function resize() {
    if (!R) return;
    const w = R.area.clientWidth || 900, h = R.area.clientHeight || 520;
    R.renderer.setSize(w, h, false); R.renderer.domElement.style.width = w + 'px'; R.renderer.domElement.style.height = h + 'px';
    R.camera.aspect = w / h;
    // вужчий екран — камера трохи далі, щоб усе влізло
    R.camera.fov = w / h < 1.3 ? 40 : 30;
    R.camera.updateProjectionMatrix();
  }

  // ── кадр: твіни, обертання барабана, курок, віддача, гільзи, дим, ніки ──
  function frame() {
    if (!R) return;
    const vis = document.getElementById('revolver-overlay').classList.contains('visible');
    if (!vis) { R.raf = 0; return; }
    R.raf = requestAnimationFrame(frame);
    const now = performance.now();
    for (let i = R.tweens.length - 1; i >= 0; i--) {
      const tw = R.tweens[i], k = Math.min(1, (now - tw.t0) / tw.ms);
      tw.fn(tw.ez(k));
      if (k >= 1) { R.tweens.splice(i, 1); tw.res(); }
    }
    const t = now / 1000;
    // барабан: кут spin навколо осі X моделі
    if (R.cyl && R.cyl0) {
      // відкидання барабана вбік (заряджання): поворот навколо осі кронштейна, паралельної стволу
      const sw = MODEL.swing, th = sw ? sw.ang * (R.swing || 0) : 0;
      if (sw) {
        const dy = R.cylP0.y - sw.y, dz = R.cylP0.z - sw.z, c = Math.cos(th), sn = Math.sin(th);
        R.cyl.position.set(R.cylP0.x, sw.y + dy * c - dz * sn, sw.z + dy * sn + dz * c);
      }
      R.cyl.quaternion.copy(R.cyl0); if (th) R.cyl.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), th));
      R.cyl.rotateX(R.spin);
    }
    if (R.hammer && R.ham0) { R.hammer.quaternion.copy(R.ham0); R.hammer.rotateZ(R.cock * 0.62); }
    R.pivot.rotation.z = R.recoil * 0.22;
    // камера: легке «дихання» + трусіння від пострілу
    const sh = R.shake; R.shake = Math.max(0, R.shake - 0.035);
    const c = CAM.pos;
    R.camera.position.set(c[0] + Math.sin(t * 0.6) * 0.25 + (Math.random() - 0.5) * sh, c[1] + Math.sin(t * 0.8) * 0.12 + (Math.random() - 0.5) * sh, c[2] + (Math.random() - 0.5) * sh);
    R.camera.lookAt(CAM.look[0], CAM.look[1], CAM.look[2]);
    // вільні гільзи: політ назад зі спіном, удар об стіл із відскоком, потім лежать до кінця раунду
    for (const f of R.free) {
      if (f.rest) continue;
      const dt = 1 / 60;
      f.v.y -= 22 * dt; f.o.position.addScaledVector(f.v, dt); f.o.rotation.x += f.w[0] * dt; f.o.rotation.z += f.w[1] * dt;
      if (f.o.position.y < FLOOR_Y + 0.45 && f.v.y < 0) {
        f.o.position.y = FLOOR_Y + 0.45; f.v.y *= -0.38; f.v.x *= 0.6; f.v.z *= 0.6; f.w[0] *= 0.5; f.w[1] *= 0.5;
        if (f.bounces++ === 0 && typeof playSfx === 'function') playSfx('rev-load', 0.25, 1.6, 120);   // дзенькіт латуні об стіл
        if (Math.abs(f.v.y) < 1.2) { f.rest = true; f.o.rotation.x = Math.round(f.o.rotation.x / Math.PI) * Math.PI; f.o.rotation.z = Math.PI / 2 * (f.o.rotation.z > 0 ? 1 : -1); }
      }
    }
    for (const s of R.smokes) if (s.visible) {
      s.userData.age += 1 / 60; const a = s.userData.age;
      s.position.addScaledVector(s.userData.v, 1 / 60); const sc = 1.5 + a * 6; s.scale.set(sc, sc, 1);
      s.material.opacity = Math.max(0, 0.5 * (1 - a / 1.6)); if (a > 1.6) s.visible = false;
    }
    R.renderer.render(R.scene, R.camera);
    // ніки — над денцем патрона в каморі
    const w = R.area.clientWidth, h = R.area.clientHeight, v = new THREE.Vector3();
    for (const ch of R.chambers) {
      const el = ch.label; if (!el) continue;
      ch.anchor.getWorldPosition(v); v.project(R.camera);
      el.style.transform = 'translate(' + ((v.x * 0.5 + 0.5) * w).toFixed(1) + 'px,' + ((-v.y * 0.5 + 0.5) * h).toFixed(1) + 'px) translate(-50%,-50%)';
      el.style.opacity = v.z < 1 ? '' : '0';
    }
  }
  function startLoop() { if (!R.raf) R.raf = requestAnimationFrame(frame); }

  // кут камори i на торці (0 = 12 годин, за годинниковою з боку стрільця)
  function chamberPos(i) { const a = i * Math.PI / 3; return [RC * Math.cos(a), RC * Math.sin(a)]; }

  function clearChambers() {
    for (const ch of R.chambers) { if (ch.obj) R.cyl.remove(ch.obj); if (ch.label) ch.label.remove(); }
    R.chambers = []; R.labels.innerHTML = '';
    for (const f of R.free) R.scene.remove(f.o); R.free = [];
  }
  // донце патрона: латунь із фаскою, капсуль у центрі, гравіювання по колу (рисуємо на canvas)
  let headMat = null;
  function headTex() {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'), m = S / 2;
    let gr = g.createRadialGradient(m * 0.7, m * 0.6, 4, m, m, m);
    gr.addColorStop(0, '#ffe7a3'); gr.addColorStop(0.55, '#e3ad45'); gr.addColorStop(0.9, '#a8701c'); gr.addColorStop(1, '#6e4510');
    g.fillStyle = gr; g.beginPath(); g.arc(m, m, m, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(80,45,5,.7)'; g.lineWidth = 6; g.beginPath(); g.arc(m, m, m * 0.86, 0, Math.PI * 2); g.stroke();   // фаска
    g.strokeStyle = 'rgba(255,240,200,.5)'; g.lineWidth = 2; g.beginPath(); g.arc(m, m, m * 0.82, 0, Math.PI * 2); g.stroke();
    // гравіювання «KICK ★ PLAY ★» по колу
    g.fillStyle = 'rgba(70,40,4,.85)'; g.font = '700 22px Manrope, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const txt = 'KICK ★ PLAY ★ ', step = (Math.PI * 2) / txt.length;
    for (let k = 0; k < txt.length; k++) { const a = -Math.PI / 2 + k * step; g.save(); g.translate(m + Math.cos(a) * m * 0.64, m + Math.sin(a) * m * 0.64); g.rotate(a + Math.PI / 2); g.fillText(txt[k], 0, 0); g.restore(); }
    // капсуль: сріблястий з ямкою від бойка
    gr = g.createRadialGradient(m - 8, m - 8, 2, m, m, m * 0.3);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.6, '#c3c8d2'); gr.addColorStop(1, '#7b808a');
    g.fillStyle = gr; g.beginPath(); g.arc(m, m, m * 0.3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(40,40,46,.7)'; g.lineWidth = 3; g.stroke();
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4; return t;
  }
  function makeRound(i, name) {
    const [y, z] = chamberPos(i);
    const obj = R.tplB.clone(true); obj.visible = true; obj.position.set(RIM_X - 7, y, z); obj.rotation.set(0, 0, 0);
    obj.traverse(o => { if (o.isMesh) o.material = o.material.clone(); });
    if (headMat) {                                   // донце дивиться в −X (до стрільця й камери)
      const head = new THREE.Mesh(new THREE.CircleGeometry(0.47, 48), headMat);
      head.rotation.y = -Math.PI / 2; head.position.x = -0.15; obj.add(head);
    }
    R.cyl.add(obj);
    const anchor = new THREE.Object3D(); anchor.position.set(RIM_X - 0.2, y, z); R.cyl.add(anchor);
    const label = document.createElement('div'); label.className = 'rev3d-label'; label.textContent = name; R.labels.appendChild(label);
    return { i, name, obj, anchor, label, y, z, alive: true };
  }

  // ── постріл: курок, спалах, дим, віддача, трусіння, гільза вилітає ──
  // відкинути барабан убік (заряджання, викидання гільзи)
  async function swingOut(ms) {
    if (typeof playSfx === 'function') playSfx('rev-load', 0.5, 0.8, 220);
    await tween(ms || 520, k => { R.swing = k; }, ease.outCubic);
    R.swing = 1;
  }
  // закрити: змах із розгоном і прокрутом на ходу (повний оберт — камори знову навпроти ствола), клацання, ледь помітний відскок
  async function swingIn() {
    const s0 = R.spin;
    if (typeof playSfx === 'function') playSfx('rev-spin', 0.6, 1.6);
    await tween(420, k => {
      R.swing = 1 - k * k * k;
      R.spin = s0 - Math.PI * 2 * (1 - Math.pow(1 - k, 2));
    }, k => k);
    R.swing = 0; R.spin = s0 - Math.PI * 2;
    if (typeof playSfx === 'function') playSfx('rev-load', 0.85, 1.1, 260);
    await tween(140, k => { R.swing = 0.025 * Math.sin(Math.PI * k); }, ease.outCubic);
    R.swing = 0;
  }
  async function fire(ch) {
    tween(110, k => { R.cock = 1 - k; }, ease.outCubic);
    await sleep(90);
    if (typeof playSfx === 'function') playSfx('rev-shot', 1);
    R.flash.material.opacity = 1; R.flash.scale.set(6.5, 6.5, 1); R.flashL.intensity = 6; R.shake = 0.6;
    tween(170, k => { R.flash.material.opacity = 1 - k; R.flashL.intensity = 6 * (1 - k); R.flash.scale.setScalar(6.5 + 3 * k); }, ease.outCubic);
    tween(90, k => { R.recoil = k; }, ease.outCubic).then(() => tween(520, k => { R.recoil = 1 - k; }, ease.inOut));
    const mw = new THREE.Vector3(); R.flash.getWorldPosition(mw);
    R.smokes.forEach((s, j) => { s.visible = true; s.userData.age = -j * 0.04; s.position.copy(mw); s.userData.v = new THREE.Vector3(1.5 + Math.random() * 2, 1 + Math.random() * 1.6, (Math.random() - 0.5) * 1.5); });
    const [y, z] = [ch.y, ch.z];
    ch.alive = false; ch.label.classList.add('dead');
    if (MODEL.swing) {
      // кольт: весь патрон вилітає вперед — з камори крізь ствол і далі за дуло
      const b = ch.obj; ch.obj = null;
      const wp = new THREE.Vector3(), wq = new THREE.Quaternion(); b.getWorldPosition(wp); b.getWorldQuaternion(wq);
      R.cyl.remove(b); R.root.add(b);
      R.root.updateMatrixWorld(true);
      b.position.copy(R.root.worldToLocal(wp.clone()));
      b.quaternion.copy(R.root.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(wq));
      b.scale.setScalar(0.78);                                   // калібр ствола вужчий за камору
      const x0 = b.position.x, y0 = b.position.y, z0 = b.position.z, x1 = MUZZLE[0] + 40;
      await tween(320, k => {
        b.position.set(x0 + (x1 - x0) * k, y0 + (MUZZLE[1] - y0) * Math.min(1, k * 4), z0 * (1 - Math.min(1, k * 4)));
        b.visible = k < 0.98;
      }, k => k);
      R.root.remove(b);
      return;
    }
    // старий револьвер: патрон → стріляна гільза, що вилітає назад
    R.cyl.remove(ch.obj);
    const cs = R.tplC.clone(true); cs.visible = true; cs.position.set(RIM_X, y, z); R.cyl.add(cs); ch.obj = cs;
    await sleep(260);
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(); cs.getWorldPosition(wp); cs.getWorldQuaternion(wq);
    R.cyl.remove(cs); R.scene.add(cs); cs.position.copy(wp); cs.quaternion.copy(wq); ch.obj = null;
    cs.traverse(o => { if (o.isMesh) o.castShadow = true; });
    R.free.push({ o: cs, v: new THREE.Vector3(-5 - Math.random() * 3, 6 + Math.random() * 3, (Math.random() - 0.5) * 7), w: [8 + Math.random() * 6, 6 - Math.random() * 12], bounces: 0 });
  }

  // ── гра (повторює логіку 2D-версії, змінено лише показ) ──
  async function runRevolver3D(qualifiers) {
    const overlay = document.getElementById('revolver-overlay');
    const hint = document.getElementById('revolver-overlay-hint');
    const controls = document.getElementById('revolver-overlay-controls');
    const area = document.getElementById('revolver-area');
    phase = 'racing';
    overlay.classList.add('visible', 'rev3d');
    controls.style.display = 'none'; controls.innerHTML = '';
    hint.textContent = 'Заряжаем барабан...';
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { await ensureScene(area); } catch (e) {
      console.warn('[revolver3d] 3D недоступне — 2D-версія', e);
      overlay.classList.remove('rev3d'); return runRevolver2D(qualifiers);
    }
    resize(); startLoop();
    clearChambers(); R.spin = 0; R.cock = 0; R.recoil = 0; R.swing = 0;
    const n = qualifiers.length;
    // барабан відкидається вбік — задня стінка відкрита, патрони заходять у камори, а не крізь рамку
    if (MODEL.swing) { await sleep(250); await swingOut(520); await sleep(150); }
    // ── заряджання: патрони по одному в'їжджають у камори ──
    for (let i = 0; i < n; i++) {
      const ch = makeRound(i, qualifiers[i]); R.chambers.push(ch);
      ch.label.classList.add('in');
      tween(300, k => { ch.obj.position.x = RIM_X - 7 * (1 - k); }, ease.outQuart);
      await sleep(240);
      if (typeof playSfx === 'function') playSfx('rev-load', 0.7, 1, 260);
      await sleep(120);
      if (phase !== 'racing') return;
    }
    await sleep(300);
    // барабан закривається зі змахом і прокрутом на ходу
    if (MODEL.swing) { await swingIn(); await sleep(250); }
    let remaining = R.chambers.slice();

    // ── пауза: чекаємо кнопку СТАРТ ──
    hint.textContent = 'Барабан заряжен';
    await new Promise(resolve => {
      const btn = document.createElement('button');
      btn.className = 'rev-go';
      // іконка — торець барабана з шістьма каморами (своя SVG замість емодзі-пістолета)
      btn.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="3"/>' +
        [0, 1, 2, 3, 4, 5].map(k => { const a = k * Math.PI / 3 - Math.PI / 2; return '<circle cx="' + (20 + Math.cos(a) * 9.5).toFixed(1) + '" cy="' + (20 + Math.sin(a) * 9.5).toFixed(1) + '" r="3.6" fill="currentColor"/>'; }).join('') +
        '<circle cx="20" cy="20" r="2.4" fill="currentColor"/></svg><span>Крутить барабан</span>';
      controls.style.display = 'flex'; controls.innerHTML = ''; controls.appendChild(btn);
      btn.onclick = () => {
        controls.style.display = 'none';
        controls.innerHTML = '<button class="btn-dark" onclick="startRevolverGame()"><svg class="kp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>Ещё раз</button>' +
          '<button class="btn-primary" onclick="closeRevolverOverlay()">Завершить</button>';
        resolve();
      };
    });
    hint.textContent = '';

    while (remaining.length > 1) {
      if (phase !== 'racing') return;
      hint.textContent = 'Крутим барабан...';
      const killIdx = secureRandomInt(remaining.length);   // прокрут барабана — локально, як у 2D-версії
      const target = remaining[killIdx];
      // докручуємо так, щоб камора цілі стала під курок (12 годин), мінімум 3 повних оберти
      const deg = R.spin * 180 / Math.PI;
      const rest = (((deg + 60 * target.i) % 360) + 360) % 360;
      const to = (deg - rest - 360 * 3) * Math.PI / 180, from = R.spin;
      const SPIN_MS = 1700;
      tween(260, k => { R.cock = k; }, ease.outCubic);                       // курок зводиться разом із прокрутом
      if (typeof playSfx === 'function') playSfx('rev-spin', 0.9, 1000 / SPIN_MS);
      await tween(SPIN_MS, k => { R.spin = from + (to - from) * k; }, ease.spin);
      R.spin = to;
      if (typeof playSfx === 'function') playSfx('rev-load', 0.45, 1, 260);  // барабан став на фіксатор
      await sleep(260);
      if (phase !== 'racing') return;
      hint.innerHTML = '💥 <b style="color:var(--red);">' + escapeHtml(target.name) + '</b> вылетает!';
      await fire(target);
      remaining.splice(killIdx, 1);
      await sleep(1000);
    }

    const winner = remaining[0];
    winner.label.classList.add('winner');
    winner.obj.traverse(o => { if (o.isMesh && o.material && o.material.emissive) { o.material.emissive.set('#ffc93d'); o.material.emissiveIntensity = 0.55; } });
    R.glowL.color.set('#ffc93d'); R.glowL.intensity = 2.5;
    // барабан повертає переможця під курок — урочисто, повільно
    const deg = R.spin * 180 / Math.PI, rest = (((deg + 60 * winner.i) % 360) + 360) % 360, from = R.spin, to = (deg - rest - 360) * Math.PI / 180;
    tween(1400, k => { R.spin = from + (to - from) * k; }, ease.spin).then(() => { R.glowL.intensity = 0; });
    hint.innerHTML = '🎉 Победитель: <b style="color:var(--kick);">' + escapeHtml(winner.name) + '</b>';
    controls.style.display = 'flex';
    phase = 'done';
    if (typeof playSfx === 'function') playSfx('win', 0.7);
    addWinner(winner.name);
  }

  // підміняємо глобальну функцію: startRevolverGame() у app.js кличе runRevolver(...)
  if (typeof THREE !== 'undefined' && THREE.GLTFLoader) {
    window.runRevolver = runRevolver3D;
    window.__rev = () => ({ R, CAM, MODEL });   // для відладки з консолі (камера, модель)
    // прогрів моделі у фоні — перший старт без підвантаження
    setTimeout(() => { loadGLB().catch(() => {}); }, 2500);
  }
  // при закритті оверлея — прибрати клас 3D (2D-розмітка повертається для запасного режиму)
  const _close = window.closeRevolverOverlay;
  window.closeRevolverOverlay = function () { document.getElementById('revolver-overlay').classList.remove('rev3d'); return _close.apply(this, arguments); };
})();
