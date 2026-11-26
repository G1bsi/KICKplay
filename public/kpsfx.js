/* KPS — короткі звуки з файлів (public/sfx/*.mp3, згенеровано ElevenLabs) через WebAudio.
   Буфер декодується один раз; кожне відтворення — новий BufferSource, тож часті клацання
   (стрілка рулетки, кілочки Плинко) накладаються без затримок, а rate міняє висоту. */
(function () {
  const V = '20261126';
  let AC = null;
  const BUF = {}, LOAD = {};
  function ctx() {
    try {
      if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
    } catch (e) {}
    return AC;
  }
  // декодуємо офлайн-контекстом — можна ще до першого кліку (звичайний AudioContext до жесту «спить»)
  let OFF = null;
  function decoder() {
    try { if (!OFF) OFF = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100); } catch (e) {}
    return OFF;
  }
  function load(n) {
    if (LOAD[n]) return LOAD[n];
    LOAD[n] = fetch('/assets/sfx/' + n + '.mp3?v=' + V)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(ab => new Promise((res, rej) => { const d = decoder() || ctx(); d.decodeAudioData(ab, res, rej); }))
      .then(b => (BUF[n] = b))
      .catch(() => { delete LOAD[n]; return null; });
    return LOAD[n];
  }
  // play(name, гучність 0..1, швидкість/висота)
  function play(n, vol, rate) {
    const b = BUF[n];
    if (!b) { load(n); return; }
    const a = ctx(); if (!a) return;
    try {
      const s = a.createBufferSource(), g = a.createGain();
      s.buffer = b; if (rate) s.playbackRate.value = rate;
      g.gain.value = vol == null ? 1 : vol;
      s.connect(g); g.connect(a.destination); s.start();
    } catch (e) {}
  }
  const ALL = ['rl-tick', 'rl-whoosh', 'rl-win', 'pl-peg', 'pl-pop', 'pl-big', 'pl-pick', 'pl-drop', 'pl-double', 'pl-win', 'timeout'];
  ALL.forEach(load);
  window.KPS = { ctx, load, play };
})();
