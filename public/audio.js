// Sound for Hoverslam, synthesised live with Web Audio. There are no audio files, so nothing to download
// or license, and every sound follows the physics: the engine's tone and brightness track the throttle and
// drop dead the moment it cuts, the rush of air tracks falling speed, and the weather follows the level.
// app.js calls tick() every frame with a small state object and fires one-off events (legs, touchdown...).
// Browsers only allow audio after a click or key press, so the context is built on the first one.
import { icon } from './icons.js';

function createAudio() {
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const rand = (a, b) => a + Math.random() * (b - a);
  const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
  const reduced = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const MASTER = 0.36, MUSIC = 0.6; // overall level and music level, low by default
  let muted = load('hs.muted', false);
  let musicOn = load('hs.music', true); // soft lofi music on by default; the toggle is in the corner
  let ac = null, failed = false;
  let master, sfx, amb, musDuck, musBus, revA, revM, white, brown;
  const L = {}; // the long-running loops: engine, air, sea, rain, wind
  const live = new Set(); // one-off sounds tied to a flight, so a retry can cut them off
  const S = { wasLit: false, gull: 5 };
  const M = { mood: '', next: 0, step: 0, t0: 0 };

  // ---------- building blocks ----------
  function noiseBuffer(brownish) {
    const n = Math.floor(ac.sampleRate * 3), fade = 2048, raw = new Float32Array(n + fade);
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brownish) { last = (last + 0.02 * w) / 1.02; raw[i] = last * 3.5; } else raw[i] = w;
    }
    const b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = i < fade ? raw[i] * (i / fade) + raw[n + i] * (1 - i / fade) : raw[i]; // seamless loop
    return b;
  }
  function impulse(sec) {
    const n = Math.floor(ac.sampleRate * sec), b = ac.createBuffer(2, n, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2.6; }
    return b;
  }
  const gainNode = (v, dest) => { const g = ac.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; };
  const filterNode = (type, f, q = 0.7) => { const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
  function loopSrc(buf) { const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * 2); return s; }
  const track = (src) => { live.add(src); src.onended = () => live.delete(src); };
  const env = (g, t, peak, attack, decay) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };
  const withSend = (g, rev, amount) => { if (rev && amount) g.connect(gainNode(amount, rev)); };
  const panner = (p, dest) => { if (!ac.createStereoPanner) return dest; const n = ac.createStereoPanner(); n.pan.value = p; n.connect(dest); return n; };

  // a burst of filtered noise: the basis of thuds, hisses, crackle, thunder
  function burst({ kind = 'lowpass', f0, f1 = f0, q = 0.7, t = ac.currentTime, dur, gain, attack = 0.005, dest = sfx, buf = white, keep = false, send, wet = 0 }) {
    const s = ac.createBufferSource(); s.buffer = buf; s.loop = true;
    const f = filterNode(kind, f0, q);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + attack + dur);
    const g = ac.createGain(); env(g, t, gain, attack, dur);
    s.connect(f); f.connect(g); g.connect(dest); withSend(g, send, wet);
    s.start(t, Math.random() * 2); s.stop(t + attack + dur + 0.05);
    if (!keep) track(s);
  }
  // a single pitched tone that can glide, optionally through a low-pass
  function tone({ type = 'sine', f0, f1 = f0, t = ac.currentTime, dur, gain, attack = 0.003, dest = sfx, lp = 0, keep = false, send, wet = 0 }) {
    const o = ac.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + dur);
    const g = ac.createGain(); env(g, t, gain, attack, dur);
    if (lp) { const f = filterNode('lowpass', lp); o.connect(f); f.connect(g); } else o.connect(g);
    g.connect(dest); withSend(g, send, wet);
    o.start(t); o.stop(t + attack + dur + 0.05);
    if (!keep) track(o);
  }

  function build() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { failed = true; return; }
    ac = new Ctor();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.25;
    master = gainNode(MASTER); master.connect(comp); comp.connect(ac.destination);
    sfx = gainNode(muted ? 0 : 1, master); amb = gainNode(muted ? 0 : 0.8, master); // sound off silences effects only; music has its own switch
    musDuck = gainNode(1); musBus = gainNode(musicOn ? MUSIC : 0, master); musDuck.connect(musBus);
    const ir = impulse(2.8);
    revA = ac.createConvolver(); revA.buffer = ir; revA.connect(gainNode(0.6, amb)); // for bells
    revM = ac.createConvolver(); revM.buffer = ir; revM.connect(gainNode(0.8, musDuck)); // for the music
    white = noiseBuffer(false); brown = noiseBuffer(true);

    // engine: a roar of low noise whose brightness follows the throttle, a hiss on top, and a sub rumble
    L.eng = gainNode(0, sfx);
    L.engF = filterNode('lowpass', 300); loopSrc(brown).connect(L.engF); L.engF.connect(gainNode(0.6, L.eng));
    L.hissF = filterNode('bandpass', 1800, 0.6); L.hissG = gainNode(0.03, L.eng); loopSrc(white).connect(L.hissF); L.hissF.connect(L.hissG);
    const rumble = filterNode('lowpass', 130), rg = gainNode(0.22, L.eng);
    L.rumA = ac.createOscillator(); L.rumA.type = 'sawtooth'; L.rumA.frequency.value = 34;
    L.rumB = ac.createOscillator(); L.rumB.type = 'triangle'; L.rumB.frequency.value = 51;
    L.rumA.connect(rumble); L.rumB.connect(rumble); rumble.connect(rg); L.rumA.start(); L.rumB.start();
    document.addEventListener('visibilitychange', () => {
      if (!ac) return;
      if (document.hidden) ac.suspend(); else ac.resume();
    });
  }

  function unlock() {
    if (!ac && !failed) { try { build(); } catch { ac = null; failed = true; } }
    if (ac && ac.state === 'suspended' && !document.hidden) ac.resume();
  }
  function apply() {
    if (!ac) return;
    const t = ac.currentTime;
    sfx.gain.setTargetAtTime(muted ? 0 : 1, t, 0.05);
    amb.gain.setTargetAtTime(muted ? 0 : 0.8, t, 0.05);
    musBus.gain.setTargetAtTime(musicOn ? MUSIC : 0, t, 0.4);
  }

  // ---------- one-off effects ----------
  function click(primary) {
    if (!ac || muted) return;
    const t = ac.currentTime;
    tone({ f0: 1500, f1: 900, dur: 0.03, gain: 0.07, t, keep: true });
    burst({ kind: 'highpass', f0: 3000, dur: 0.012, gain: 0.04, t, keep: true });
    if (primary) tone({ f0: 1800, f1: 1300, dur: 0.05, gain: 0.05, t: t + 0.045, keep: true });
  }
  function ignite(t) {
    burst({ kind: 'bandpass', f0: 250, f1: 900, q: 0.8, dur: 0.55, gain: 0.22, attack: 0.04, t });
    tone({ f0: 90, f1: 40, dur: 0.45, gain: 0.25, t });
  }
  function clunk(t, k) {
    burst({ kind: 'bandpass', f0: 900, q: 4, dur: 0.08, gain: 0.5 * k, t });
    tone({ f0: 160, f1: 70, dur: 0.16, gain: 0.55 * k, t });
    tone({ type: 'triangle', f0: 430, f1: 300, dur: 0.12, gain: 0.14 * k, t });
  }
  function legs() {
    if (!ac || muted) return;
    const t = ac.currentTime;
    clunk(t, 0.45); // the latches let go
    tone({ type: 'sawtooth', f0: 105, f1: 185, dur: 1.9, gain: 0.035, attack: 0.2, t: t + 0.1, lp: 520 }); // the actuators
    clunk(t + 2.15, 1); // and lock
  }
  function touchdown(kind) {
    if (!ac || muted) return;
    const t = ac.currentTime, rough = kind === 'rough';
    tone({ f0: 95, f1: 42, dur: 0.35, gain: rough ? 1 : 0.8, t });
    burst({ kind: 'lowpass', f0: 700, f1: 180, dur: 0.28, gain: rough ? 0.8 : 0.5, t });
    clunk(t + 0.04, rough ? 1 : 0.6);
    clunk(t + 0.3, 0.3);
    if (rough) tone({ type: 'sawtooth', f0: 92, f1: 58, dur: 0.7, gain: 0.12, t: t + 0.05, lp: 300 });
    ending(true);
  }
  function splash() {
    if (!ac || muted) return;
    const t = ac.currentTime;
    burst({ kind: 'lowpass', f0: 2600, f1: 260, dur: 1.5, gain: 0.9, attack: 0.03, t });
    burst({ kind: 'bandpass', f0: 900, f1: 400, q: 1, dur: 0.9, gain: 0.35, t: t + 0.1 });
    tone({ f0: 330, f1: 90, dur: 0.45, gain: 0.4, t });
    for (let i = 0; i < 7; i++) { const f = rand(420, 900); tone({ f0: f, f1: f * 1.6, dur: 0.08, gain: 0.07, t: t + 0.25 + i * rand(0.1, 0.18) }); }
    ending(false);
  }
  function crash(speed) {
    if (!ac || muted) return;
    const t = ac.currentTime, k = clamp(0.55 + speed / 30, 0.55, 1) * (reduced() ? 0.6 : 1);
    tone({ f0: 78, f1: 22, dur: 1.8, gain: 1.0 * k, attack: 0.004, t });
    tone({ type: 'triangle', f0: 160, f1: 40, dur: 0.9, gain: 0.35 * k, t });
    burst({ kind: 'lowpass', f0: 1400, f1: 110, dur: 2.6, gain: 1.1 * k, attack: 0.004, t });
    burst({ kind: 'highpass', f0: 1200, dur: 0.3, gain: 0.5 * k, attack: 0.002, t });
    for (let i = 0; i < 16; i++) burst({ kind: 'bandpass', f0: rand(1800, 4500), q: 2, dur: 0.02, gain: rand(0.1, 0.3) * k, attack: 0.001, t: t + rand(0.3, 2.6) });
    ending(false);
  }
  // a quiet chord for a landing, a low fall-away for a crash: no jingle
  function ending(good) {
    if (!musicOn || !ac) return;
    const t = ac.currentTime + 0.5;
    if (good) for (const [i, m] of [72, 76, 79, 83].entries()) tone({ f0: mtof(m), t: t + i * 0.09, dur: 4.5, gain: 0.05, attack: 0.4, dest: musDuck, send: revM, wet: 0.7, keep: true });
    else tone({ type: 'sawtooth', f0: 110, f1: 32, dur: 3.2, gain: 0.14, attack: 0.1, t, lp: 220, dest: musDuck, keep: true });
  }
  function gull() {
    let t = ac.currentTime;
    const pan = rand(-0.8, 0.8), dest = panner(pan, amb);
    for (let i = 0, n = Math.random() < 0.5 ? 2 : 3; i < n; i++) {
      const f = rand(1500, 2100), dur = rand(0.16, 0.26);
      const o = ac.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 0.8, t); o.frequency.linearRampToValueAtTime(f * 1.1, t + dur * 0.3); o.frequency.exponentialRampToValueAtTime(f * 0.62, t + dur);
      const lfo = ac.createOscillator(); lfo.frequency.value = 28; const lg = gainNode(60, o.frequency); lfo.connect(lg);
      const bp = filterNode('bandpass', f, 2), g = ac.createGain(); env(g, t, 0.035, 0.03, dur);
      o.connect(bp); bp.connect(g); g.connect(dest);
      o.start(t); o.stop(t + dur + 0.1); lfo.start(t); lfo.stop(t + dur + 0.1);
      t += dur + rand(0.06, 0.14);
    }
  }

  // ---------- music: soft lofi, slow and warm, never the same twice ----------
  // electric-piano chords on a lazy swung beat, a round bass, a soft kick and a quiet tap, and a sparse melody
  const PROG = {
    sunset: { bpm: 72, chords: [[48, 55, 59, 62, 64], [45, 55, 59, 60, 64], [50, 57, 60, 64, 65], [43, 53, 59, 62, 64]] }, // Cmaj9 Am9 Dm9 G13
    dusk: { bpm: 66, chords: [[45, 55, 59, 60, 64], [41, 55, 57, 60, 64], [50, 57, 60, 64, 65], [40, 55, 59, 62, 66]] }, // Am9 Fmaj9 Dm9 E7
    storm: { bpm: 62, chords: [[50, 57, 60, 64, 65], [46, 57, 60, 62, 65], [43, 57, 60, 62, 65], [45, 55, 59, 60, 64]] }, // Dm9 Bbmaj9 Gm9 Am9
  };
  const SCALE = { sunset: [72, 74, 76, 79, 81, 84], dusk: [69, 72, 74, 76, 79, 81], storm: [69, 72, 74, 76, 77, 81] };
  function keys(m, t, gain, bright) {
    const f = mtof(m), g = ac.createGain(), lp = filterNode('lowpass', bright, 0.4);
    env(g, t, gain, 0.012, 2.4);
    for (const [r, w, type] of [[1, 1, 'sine'], [2, 0.18, 'sine'], [1, 0.35, 'triangle']]) {
      const o = ac.createOscillator(), og = gainNode(w); o.type = type; o.frequency.value = f * r; o.detune.value = rand(-5, 5);
      o.connect(og); og.connect(lp); o.start(t); o.stop(t + 2.6);
    }
    lp.connect(g); g.connect(musDuck); withSend(g, revM, 0.5);
  }
  function lofi(t, st) {
    const key = st.menu ? 'sunset' : st.theme, P = PROG[key] || PROG.sunset;
    if (M.mood !== key) { M.mood = key; M.step = 0; M.next = t + 0.15; }
    const eighth = 60 / P.bpm / 2;
    while (M.next < t + 0.6) {
      const n = M.step, bar = Math.floor(n / 8), pos = n % 8, chord = P.chords[Math.floor(bar / 2) % P.chords.length];
      const at = M.next + (pos % 2 ? eighth * 0.28 : 0) + rand(0, 0.012); // swing and a little looseness
      const bright = st.menu ? 900 + clamp((at - M.t0) / 16, 0, 1) * 700 : 1500;
      if (pos === 0 || pos === 5) chord.forEach((m, i) => keys(m, at + i * 0.022, (pos === 0 ? 0.034 : 0.024), bright));
      if (pos === 0 || pos === 4) tone({ f0: mtof(chord[0] - 12), dur: 0.9, gain: pos === 0 ? 0.2 : 0.13, attack: 0.012, t: at, dest: musDuck, keep: true });
      if (pos === 0 || pos === 4) tone({ f0: 115, f1: 42, dur: 0.2, gain: 0.3, t: at, dest: musDuck, keep: true }); // soft kick
      if (pos === 2 || pos === 6) tone({ type: 'triangle', f0: 330, f1: 240, dur: 0.07, gain: 0.07, t: at, dest: musDuck, keep: true }); // a quiet tap
      if (Math.random() < 0.22 && (pos === 3 || pos === 6 || pos === 7)) {
        const sc = SCALE[key] || SCALE.sunset;
        tone({ f0: mtof(sc[Math.floor(Math.random() * sc.length)]), dur: 1.6, gain: 0.045, attack: 0.01, t: at, dest: musDuck, send: revM, wet: 0.8, keep: true });
      }
      M.step++; M.next += eighth;
    }
  }
  function music(t, st) {
    if (M.mood && M.next < t - 3) M.mood = ''; // fell far behind (a stalled tab): start over
    if (!M.t0) M.t0 = t;
    lofi(t, st);
  }

  // ---------- per frame ----------
  function tick(dt, st) {
    if (!ac || failed) return;
    const t = ac.currentTime;

    // engine: the tone follows the throttle, and it stops dead when the engine does
    const lit = Boolean(st.lit) && !st.menu;
    const thr = clamp(st.throttle || 0, 0, 1);
    if (lit && !S.wasLit && !muted) ignite(t);
    S.wasLit = lit;
    L.eng.gain.setTargetAtTime(lit ? 0.3 + 0.7 * thr : 0, t, lit ? 0.07 : 0.006);
    L.engF.frequency.setTargetAtTime(160 + thr * 650 + (lit ? clamp(1 - st.alt / 600, 0, 1) * 150 : 0), t, 0.08);
    L.hissF.frequency.setTargetAtTime(900 + thr * 1200, t, 0.08);
    L.hissG.gain.setTargetAtTime(0.02 + 0.06 * thr, t, 0.08);
    L.rumA.frequency.setTargetAtTime(32 + thr * 20, t, 0.1);
    L.rumB.frequency.setTargetAtTime(48 + thr * 30, t, 0.1);

    // gulls on Easy, now and then
    if (!muted) {
      S.gull -= dt;
      if (S.gull <= 0) { if (st.theme === 'sunset' && st.scene.includes('birds')) gull(); S.gull = rand(9, 22); }
    }

    // music dips only slightly under the engine, so it stays in front
    musDuck.gain.setTargetAtTime(lit ? 0.85 : 1, t, lit ? 0.12 : 0.9);
    if (musicOn) music(t, st); else M.mood = '';
  }

  function reset() {
    for (const s of live) { try { s.stop(); } catch { /* already finished */ } }
    live.clear();
    S.wasLit = false;
  }

  // ---------- the controls: sound and music toggles in the corner ----------
  function init() {
    // the two toggles live in the dock; a page without a dock (the style guide) gets its own pair
    let snd = document.querySelector('[data-snd]'), mus = document.querySelector('[data-mus]');
    if (!snd || !mus) {
      const box = document.createElement('div');
      box.className = 'sound';
      box.innerHTML = '<button type="button" class="icon-btn" data-nosound data-snd></button><button type="button" class="icon-btn" data-nosound data-mus></button>';
      document.body.appendChild(box);
      snd = box.querySelector('[data-snd]'); mus = box.querySelector('[data-mus]');
    }
    const paint = () => {
      snd.innerHTML = icon(muted ? 'sound-off' : 'sound-on', 20);
      snd.setAttribute('aria-pressed', String(!muted));
      snd.setAttribute('aria-label', muted ? 'Sound off' : 'Sound on');
      snd.dataset.tip = muted ? 'Sound effects off' : 'Sound effects on'; snd.dataset.key = 'M'; snd.dataset.tipDetail = muted ? 'Press to turn them on.' : 'Engine, birds and clicks. Press to turn them off.';
      mus.innerHTML = icon(musicOn ? 'music' : 'music-off', 20);
      mus.setAttribute('aria-pressed', String(musicOn));
      mus.setAttribute('aria-label', musicOn ? 'Music on' : 'Music off');
      mus.dataset.tip = musicOn ? 'Music on' : 'Music off'; mus.dataset.tipDetail = musicOn ? 'Press to turn it off.' : 'Press to turn it on.';
    };
    const flip = (which) => {
      unlock();
      if (which === 'sound') { muted = !muted; save('hs.muted', muted); } else { musicOn = !musicOn; save('hs.music', musicOn); }
      apply(); paint();
      if (which === 'sound' && !muted) click(false);
    };
    paint();
    snd.addEventListener('click', () => { flip('sound'); snd.blur(); }); // blur, so Space still works the engine
    mus.addEventListener('click', () => { flip('music'); mus.blur(); });
    for (const ev of ['pointerdown', 'pointerup', 'keydown', 'click']) window.addEventListener(ev, unlock, true);
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !(e.target.matches && e.target.matches('input, select, textarea'))) flip('sound'); });
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button, .lvl-card');
      if (b && !b.hasAttribute('data-nosound')) click(b.classList.contains('primary'));
    }, true);
  }

  return { init, tick, reset, legs, touchdown, splash, crash, get ctx() { return ac; }, get master() { return master; } };
}
export const audio = createAudio();
