// sound.js — a quiet piece of music in D that the journey plays by moving through it. No files
// and no noise: every sound here is a few sine waves in a long, soft room.
//
//   The room holds one chord per screen, barely there, and moves between them with the camera.
//   What happens in the world is a single note: a soft mallet, a drop on still water, a bowl.
//   The page says ahead of time when a thing will be seen, and the note is placed to be heard then.
//
//   KnotSound.unlock()         from a click, tap or key: a browser won't start audio before one
//   KnotSound.set(on)          remembers the choice
//   KnotSound.frame(s)         every frame: how far the room is open, how dark it is
//   KnotSound.lead()           how far ahead the page has to say what's coming, in ms
//   KnotSound.at(ms, cue, …)   a cue, placed to be heard at that moment of performance.now()
//   KnotSound.<cue>(…)         a cue, now
//   KnotSound.render(list, seconds)  the same voices into an OfflineAudioContext, for tests
(() => {
  "use strict";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const midi = (n) => 440 * 2 ** ((n - 69) / 12);
  const D3 = 50, A3 = 57, D4 = 62, E4 = 64, Fs4 = 66, G4 = 67, A4 = 69, B4 = 71, D5 = 74, E5 = 76, Fs5 = 78, A5 = 81, B5 = 83, D6 = 86;
  // One chord for each screen, all of them at home in D.
  const CHORDS = [
    [D3, A3, E4, Fs4],                  // the landing: open
    [47, 54, A3, D4, E4],               // how it works: B minor, leaning forward
    [43, D3, 59, Fs4, A4],              // features: G major, wide
    [45, 52, 59, D4],                   // the app: A, suspended
    [52, 59, D4, G4],                   // the turn: E minor
    [D3, A3, D4, Fs4, A4, E5],          // the end: home
  ];
  const MASTER = .8, PAD = .0072;
  let A = null, bus = null, dry = null, wet = null, out = null, an = null, soft = null, padBus = null, padTop = null, chordNow = null, chordIdx = -1;
  let on = true, unlocked = false, scale = 1;
  try { on = localStorage.getItem("knot-sound") !== "off"; } catch {}
  const log = [];

  // A large, soft room: a moment's distance, then a long tail that darkens as it goes.
  function roomImpulse(c, secs) {
    const n = Math.ceil(c.sampleRate * secs), b = c.createBuffer(2, n, c.sampleRate), pre = Math.ceil(c.sampleRate * .028);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0, lp2 = 0;
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / c.sampleRate, k = .32 * Math.exp(-t * 1.3) + .012;
        lp += ((Math.random() * 2 - 1) - lp) * k; lp2 += (lp - lp2) * k;
        d[i] = lp2 * Math.exp(-t * 1.75) * Math.min(1, t / .045);
      }
    }
    return b;
  }
  function graph(c) {
    out = c.createGain(); out.gain.value = MASTER;
    const hold = c.createDynamicsCompressor();
    hold.threshold.value = -15; hold.knee.value = 22; hold.ratio.value = 2.6; hold.attack.value = .012; hold.release.value = .35;
    const top = c.createBiquadFilter(); top.type = "lowpass"; top.frequency.value = 6400; top.Q.value = .5;
    bus = c.createGain();
    dry = c.createGain(); dry.gain.value = .78;
    wet = c.createGain(); wet.gain.value = 1;
    const room = c.createConvolver(); room.buffer = roomImpulse(c, 4.6);
    const roomGain = c.createGain(); roomGain.gain.value = .86;
    dry.connect(bus); wet.connect(room); room.connect(roomGain); roomGain.connect(bus);
    bus.connect(top); top.connect(hold); hold.connect(out);
    an = c.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = .7;
    out.connect(an); out.connect(c.destination);
    // The chords' own voice: warm, a breath of the octave and hardly anything above it.
    soft = c.createPeriodicWave(new Float32Array(6), new Float32Array([0, 1, .22, .07, .02, .006]));
    padTop = c.createBiquadFilter(); padTop.type = "lowpass"; padTop.frequency.value = 760; padTop.Q.value = .3;
    padBus = c.createGain(); padBus.gain.value = 1;
    padBus.connect(padTop); const padWet = c.createGain(); padWet.gain.value = .7; padTop.connect(padWet); padWet.connect(wet);
    const padDry = c.createGain(); padDry.gain.value = .5; padTop.connect(padDry); padDry.connect(dry);
    out.gain.setValueAtTime(0, c.currentTime); out.gain.linearRampToValueAtTime(MASTER, c.currentTime + .4);
    A = c; chordNow = null; chordIdx = -1;
  }

  // ---- voices ----
  const when = () => A.currentTime + .005;
  function pan(v) { const p = A.createStereoPanner(); p.pan.value = clamp(v, -1, 1); return p; }
  function send(node, wetAmt) { node.connect(dry); if (wetAmt > 0) { const s = A.createGain(); s.gain.value = wetAmt; node.connect(s); s.connect(wet); } }
  // One sine that rises smoothly and dies away smoothly, so nothing in it can click.
  function sine(t, f, g, attack, decay, dest, f2) {
    const o = A.createOscillator(), e = A.createGain();
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + attack + decay * .5);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + attack); e.gain.setTargetAtTime(0, t + attack, decay / 5);
    o.connect(e); e.connect(dest); o.start(t); o.stop(t + attack + decay * 1.7);
  }
  // A soft mallet on a warm bar: the note, a second string a hair away from it so it slowly
  // breathes, and a little of its octave that fades first.
  function note(t, n, g = .08, p = 0, ring = 2.2, wetAmt = .7, attack = .009) {
    const f = midi(n), out = pan(p), v = g * scale; send(out, wetAmt);
    sine(t, f, v * .72, attack, ring, out);
    sine(t, f * 1.0018, v * .36, attack, ring * .9, out);
    sine(t, f * 2, v * .16, attack, ring * .46, out);
    sine(t, f * 3, v * .035, attack, ring * .24, out);
  }
  // A drop on still water: one round note, lifting a little as it closes.
  function drop(t, n, g = .05, p = 0, wetAmt = .85) {
    const f = midi(n), out = pan(p); send(out, wetAmt);
    sine(t, f * .94, g * scale, .007, .2, out, f * 1.07);
  }
  // A bowl: two tones so close they beat, slowly. It swells; it's never struck.
  function bowl(t, ns, g = .05, p = 0, swell = .5, ring = 3.4) {
    const out = pan(p); send(out, 1);
    ns.forEach((n, i) => { const f = midi(n), v = g * scale * (i ? .68 : 1); sine(t, f, v, swell, ring, out); sine(t, f * 1.0032, v * .7, swell * 1.1, ring, out); sine(t, f * 2, v * .2, swell * .8, ring * .6, out); });
  }

  const cues = {
    // The chord of a screen: the old one thins out as the new one comes in, over the flight.
    chord(t, i, fade = 1.6) {
      if (i === chordIdx) return;
      chordIdx = i;
      if (chordNow) { const old = chordNow; old.g.gain.cancelScheduledValues(t); old.g.gain.setTargetAtTime(0, t, fade / 3.2); old.nodes.forEach((n) => n.stop(t + fade * 2.4)); }
      const g = A.createGain(), nodes = [];
      g.gain.setValueAtTime(0, t); g.gain.setTargetAtTime(1, t + fade * .1, fade / 3);
      g.connect(padBus);
      CHORDS[i].forEach((n, k) => {
        const o = A.createOscillator(), v = A.createGain(), tide = A.createOscillator(), deep = A.createGain(), level = PAD * (1 - k * .09);
        o.setPeriodicWave(soft); o.frequency.value = midi(n); o.detune.value = (k % 2 ? 1 : -1) * 1.5;
        v.gain.value = level; tide.frequency.value = .051 + k * .019; deep.gain.value = level * .32;
        tide.connect(deep); deep.connect(v.gain); o.connect(v); v.connect(g);
        o.start(t); tide.start(t); nodes.push(o, tide);
      });
      chordNow = { g, nodes };
    },
    // The bands reach each other's tails.
    touch(t) { [A4, D5, E5].forEach((n, i) => note(t + i * .05, n, .05, (i - 1) * .35, 2.4, .8, .02)); },
    // The strand closes.
    close(t) { note(t, D5, .08, 0, 3.4, .9, .014); note(t + .02, A4, .06, -.15, 3.2, .9, .02); note(t + .05, Fs5, .04, .15, 3, .9, .02); bowl(t - .08, [D3, A3], .04, 0, .22, 3.6); },
    // The camera goes through the knot.
    chime(t) { [A4, D5, E5, Fs5].forEach((n, i) => note(t + i * .07, n, .028, (i - 1.5) * .3, 2.2, 1, .12)); },
    // The sea begins to stand.
    stand(t) { bowl(t, [A3, E4], .036, 0, .6, 3.2); },
    // The strand starts to run.
    drip(t, i, p = 0) { drop(t, [A5, Fs5, B5, E5, A5][i % 5], .03, p, .9); },
    // A neck lets go: the n-th of six, each a step higher.
    pinch(t, n, p = 0) { note(t, [D5, E5, Fs5, A5, B5, D6][n % 6], .062, p, 2.6, .8, .007); },
    // A drop steps out from the others.
    step(t, i, p = .3, g = 1) { note(t, [Fs4, A4, D5, E5, D5, A4][i % 6], .09 * g, p, 2.2, .75, .011); },
    // A drop goes into the sea.
    plop(t, n, p = 0) { drop(t, [D6, B5, A5, Fs5, E5, D5][n % 6], .07, p); },
    // The field stands the sea up.
    field(t) { bowl(t, [D3, A3], .05, 0, .7, 4); },
    // A rising note, climbing over the columns.
    climb(t, i) { note(t, [D4, A4, D5, Fs5, A5][i % 5], .046, (i - 2) * .16, 2.4, .95, .03); },
    // The sea's figure changes: a bowl, a different pair each time.
    figure(t, i, g = 1) { const f = [[55, D5], [59, Fs5], [D4, A5], [Fs4, E5], [55, B4], [D4, Fs5], [59, D5], [D4, E5]][i % 8]; bowl(t, f, .05 * g, ((i % 8) / 7 - .5) * .5, .42, 2.8); },
    // The mirror comes up.
    mirror(t, p = 0) { bowl(t, [45, 52, A3], .056, p, .5, 3.6); },
    // Mercury runs down the glass: a note for each stretch of the lip.
    drain(t, k, p = 0) { note(t, [A5, Fs5, E5, D5, B4, A4][k % 6], .056, p, 1.9, .85, .012); },
    // The same small note for every window, exactly the same.
    window(t, p = 0) { note(t, E5, .022, p, .9, .55, .006); },
    // Mercury closes over everything.
    flood(t) { [B4, D5, E5].forEach((n, i) => note(t + i * .1, n, .036, (i - 1) * .2, 1.6, .9, .02)); },
    // The wall comes down.
    melt(t) { [E4, D4, 59, 55].forEach((n, i) => bowl(t + i * .62, [n], .036, (1.5 - i) * .14, .34, 2.2)); },
    // A drop climbs out of the sea.
    leave(t, n, p = 0) { drop(t, [A4, B4, D5, E5, Fs5, A5][n % 6], .062, p); },
    // A drop flows back into the knot: the n-th of six, down towards home.
    join(t, n, p = 0) { note(t, [A5, Fs5, E5, D5, A4, Fs4][n % 6], .056, p, 3, .9, .03); },
    // A tap on the sea: a drop from the chord that's playing.
    ring(t, p = 0, s = 1) { drop(t, [D5, Fs5, A5, B5, E5][tapN++ % 5], .062 * s, p); },
    press(t) { note(t, A5, .016, 0, .4, .4, .004); },
    tab(t, i) { note(t, [A4, B4, D5][i % 3], .04, (i - 1) * .3, 1.2, .7, .008); },
    // The lights go out, and the comet starts: a low bowl, and a harp that runs faster with it.
    ignite(t) {
      bowl(t + .1, [D3, A3], .05, 0, 1, 4);
      // The comet's laps, at the speed the mark's own timeline gives them: W0 / (1 - x)^P.
      const T = 3, W0 = .3, P = 1.6, lapsAt = (s) => { const x = Math.min(s / T, .9992), ease = clamp(s / .7, 0, 1), k = ease * ease * (3 - 2 * ease); return W0 * T / (P - 1) * ((1 - x) ** (1 - P) - 1) * k; };
      const SCALE = [D4, E4, Fs4, A4, B4, D5, E5, Fs5, A5, B5, D6];
      let last = 0, n = 0, at = -1;
      for (let s = .1; s < 2.9; s += .002) {
        const l = lapsAt(s);
        if (Math.floor(l) > Math.floor(last) && s - at > .13) { at = s; const k = s / T, m = SCALE[Math.min(n++, SCALE.length - 1)]; note(t + s, m, .03 + .022 * k, Math.sin(l * Math.PI * 2) * .4, 1.5, 1, .007); }
        last = l;
      }
    },
    // The flash, and the day: every note of home at once, opening, and the six going up over it.
    flash(t) {
      [[26, .1], [38, .092], [45, .08], [D3, .072], [A3, .06], [D4, .052], [Fs4, .042], [A4, .036], [E5, .022]].forEach(([n, g], i) => {
        const o = pan((i - 4) * .1); send(o, 1);
        sine(t - .02, midi(n), g * .7, .07, 6.5, o); sine(t - .02, midi(n) * 1.0022, g * .35, .09, 6, o);
      });
      [D5, E5, Fs5, A5, B5, D6].forEach((n, i) => note(t + .1 + i * .15, n, .05, (i - 2.5) * .26, 3.4, 1, .012));
    },
  };
  let tapN = 0;

  // A hurried flight thins out; it doesn't pile up.
  const lastOf = {}, GAP = new Proxy({ ring: 180, press: 60, step: 150, figure: 300 }, { get: (o, k) => o[k] ?? 0 });
  const S = { log, tl: null, get on() { return on; }, get unlocked() { return unlocked; }, set scale(v) { scale = v; } };
  // The clock the page runs on, as a time on the audio clock that will be heard at that moment.
  const heardAt = (ms) => {
    const ts = A.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) return ts.contextTime + (ms - ts.performanceTime) / 1000;
    return A.currentTime + (ms - performance.now()) / 1000 - (A.outputLatency || A.baseLatency || .01);
  };
  const play = (name, t, ms, args) => {
    if (ms - (lastOf[name] ?? -1e9) < GAP[name]) return;
    lastOf[name] = ms;
    log.push([+ms.toFixed(1), name, S.tl, +((t - A.currentTime) * 1000).toFixed(1)]); if (log.length > 400) log.shift();
    cues[name](t, ...args);
  };
  for (const name of Object.keys(cues)) S[name] = (...args) => { if (A && on && A.state === "running") play(name, when(), performance.now(), args); };
  // A frame reaches the eye a beat after it is drawn; the note waits for it.
  const SEEN = 26;
  S.at = (ms, name, ...args) => { S.record?.(ms, name, args); if (A && on && A.state === "running") play(name, Math.max(when(), heardAt(ms + SEEN)), ms, args); };
  S.lead = () => (A ? Math.max(140, (A.outputLatency || .03) * 1000 + 110) : 140);
  // Resume from anything that isn't running: a phone call leaves iOS "interrupted", not "suspended".
  S.unlock = (then) => {
    if (!on) return;
    if (!A) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return; try { graph(new C({ latencyHint: "interactive" })); } catch { A = null; return; } }
    const ready = () => { if (!on) return hush(); unlocked = A.state === "running"; S.onchange?.(); if (unlocked) { out.gain.cancelScheduledValues(A.currentTime); out.gain.setTargetAtTime(MASTER, A.currentTime, .05); then?.(); } };
    if (A.state === "running") ready(); else A.resume().then(ready, () => {});
  };
  // Fading first: stopping a waveform mid-swing is a click.
  const hush = () => { if (!A || A.state !== "running") return; out.gain.cancelScheduledValues(A.currentTime); out.gain.setTargetAtTime(0, A.currentTime, .03); setTimeout(() => { if (A.state === "running" && (!on || document.hidden)) A.suspend(); }, 160); };
  S.set = (v, then) => {
    on = !!v;
    try { localStorage.setItem("knot-sound", on ? "on" : "off"); } catch {}
    if (on) S.unlock(then); else hush();
    S.onchange?.();
  };
  // Every frame: the room opens a little as the camera moves, and goes quiet in the dark.
  S.frame = ({ open = 0, dark = 0 }) => {
    if (!A || !on || A.state !== "running") return;
    const t = A.currentTime;
    padTop.frequency.setTargetAtTime(760 + 900 * clamp(open, 0, 1), t, .3);
    padBus.gain.setTargetAtTime(1 + .35 * clamp(open, 0, 1) - .86 * clamp(dark, 0, 1), t, .25);
  };
  const meter = new Uint8Array(256);
  S.level = () => { if (!an || !A || A.state !== "running") return 0; an.getByteTimeDomainData(meter); let m = 0; for (let i = 0; i < 256; i++) { const v = Math.abs(meter[i] - 128); if (v > m) m = v; } return m / 128; };
  addEventListener("visibilitychange", () => { if (!A || !on) return; if (document.hidden) hush(); else S.unlock(); });
  // The same voices into an offline context, so timing and levels can be measured, not guessed.
  S.render = async (list, seconds, rate = 44100) => {
    const keep = [A, bus, dry, wet, out, an, soft, padBus, padTop, chordNow, chordIdx];
    try {
      const c = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
      graph(c);
      for (const [t, name, ...args] of list) cues[name](t, ...args);
      const buf = await c.startRendering();
      return [buf.getChannelData(0), buf.getChannelData(1)];
    } finally { [A, bus, dry, wet, out, an, soft, padBus, padTop, chordNow, chordIdx] = keep; }
  };
  window.KnotSound = S;
})();
