// reel.js — the journey on a phone. A phone can't be counted on to run the world live, so it plays
// films of it, made from the same scene frame by frame, with the real words on top. Each screen is
// a film of getting there and a loop of being there, and a swipe plays the next one. The film is
// the clock: the words and the notes read the time from it, so they can't drift from the picture.
(() => {
  "use strict";
  const html = document.documentElement, F = window.FILM, S = window.KnotSound;
  const $ = (s) => document.querySelector(s), all = (s, r = document) => [...r.querySelectorAll(s)];
  // No films, no journey: the ordinary page still says everything.
  if (!F) { html.classList.remove("paged", "reel", "titled"); html.classList.add("flow"); return; }
  const IDS = ["top", "how", "features", "proof", "turn", "download"], LAST = IDS.length - 1, HOW = 1, FEATURES = 2, PROOF = 3, TURN = 4;
  const pages = IDS.map((id) => $("#" + id)), stepWords = all("#how .steps b"), feats = all("#features .feat"), shots = all("#shots img"), tabs = all(".tabs button");
  for (const p of pages) all(".r", p).forEach((r, k) => r.style.setProperty("--i", k));

  // ---- the stage ----
  const box = document.createElement("div");
  box.id = "reel"; box.setAttribute("aria-hidden", "true");
  document.body.prepend(box);
  const pool = [0, 1, 2].map(() => {
    const v = document.createElement("video");
    v.muted = v.defaultMuted = v.playsInline = true;
    for (const a of ["muted", "playsinline", "webkit-playsinline", "disableremoteplayback"]) v.setAttribute(a, "");
    v.preload = "auto"; v.disablePictureInPicture = true;
    box.append(v);
    return v;
  });
  const blobs = new Map(), holds = new Map(); // what each film's address is, and which player has it
  let direct = false; // this host won't play fetched films
  const url = (name) => (direct ? F.base + name : blobs.get(name) ?? F.base + name);
  // A film may play from one address and not the other: some hosts don't serve parts of a file,
  // which an iPhone insists on, and some forbid fetched films. Try the other before giving up.
  pool.forEach((v) => v.addEventListener("error", async () => {
    const name = v.dataset.film;
    if (!name) return;
    if (v.dataset.tried === name) { if (v === starting || v === live || !live) stillOnly(); return; }
    v.dataset.tried = name;
    if (v.src.startsWith("blob:")) direct = true;
    else try { const r = await fetch(F.base + name); if (!r.ok) throw 0; blobs.set(name, URL.createObjectURL(await r.blob())); } catch { if (v === starting || v === live || !live) stillOnly(); return; }
    if (holds.get(name) !== v) return;
    const going = v === starting;
    v.src = url(name); v.load();
    if (going) v.play().catch(() => {});
  }));
  let at = 0, part = "a", live = null, fading = null, starting = null, top = 1, next = 0, noteI = 0, wraps = 0, lastT = 0, dead = false, tapped = false, onward = false;
  const seg = () => F.segments[at];

  function load(v, name) {
    for (const [k, h] of holds) if (h === v) holds.delete(k);
    holds.set(name, v);
    v.dataset.film = name; delete v.dataset.tried;
    v.src = url(name); v.loop = name[0] === "b"; v.load();
    return v;
  }
  // A player that isn't on screen and isn't needed, for the film wanted next.
  function player(name) {
    const have = holds.get(name);
    if (have) return have;
    const keep = [live, fading, starting];
    const v = pool.find((p) => !keep.includes(p) && ![...holds].some(([k, h]) => h === p && k === wanted())) ?? pool.find((p) => !keep.includes(p));
    return load(v, name);
  }
  const wanted = () => (part === "a" ? seg().b : F.segments[at + 1]?.a);
  // A film underneath, stopped on its first frame and ready to go.
  function prepare(name) { if (name && !holds.has(name)) player(name); }
  // The new film comes up over the old one; nothing is ever seen starting or stopping.
  function show(v, ms) {
    const old = live;
    v.style.zIndex = ++top;
    v.style.transition = `opacity ${ms}ms linear`;
    v.style.opacity = 1;
    live = v;
    if (old && old !== v) {
      fading = old;
      setTimeout(() => { if (fading === old) fading = null; if (old !== live && old !== starting) { old.pause(); old.style.transition = "none"; old.style.opacity = 0; } }, ms + 40);
    }
  }
  function start(v, ms, then) {
    let shown = false;
    const running = !v.paused; // taken back while it was fading out: it will never say "playing"
    starting = v;
    const up = () => { if (shown || starting !== v) return; shown = true; starting = null; show(v, ms); then?.(); };
    v.addEventListener("playing", up, { once: true });
    // some phones say nothing until the first frame is already up
    setTimeout(() => { if (!v.paused && v.currentTime > 0) up(); }, 400);
    // and on a very slow connection, the words and a picture are better than waiting
    setTimeout(() => { if (starting === v) stillOnly(); }, 6000);
    const p = v.play();
    if (running) up();
    // A refusal means no films at all until a touch; anything else was only interrupted, so try again.
    p?.catch?.((e) => {
      if (starting !== v) return;
      if (e?.name === "NotAllowedError" && !tapped) return stillOnly();
      setTimeout(() => { if (starting === v) v.play().catch(stillOnly); }, 150);
    });
    return p;
  }
  // When a film can't play, the screen still can: its picture, and the words.
  function stillOnly() {
    if (dead) return;
    dead = true; starting = null;
    finishLoader();
    html.classList.remove("intro");
    box.style.backgroundImage = `url(${F.base}${seg().poster})`;
    enter(at);
    if (at === HOW) setStep(0);
    if (at === FEATURES) setFeat(0);
  }
  const finishLoader = () => $("#loader")?.classList.add("done");

  // ---- words ----
  function enter(i) { pages[i].classList.remove("off"); pages[i].classList.add("on"); }
  function leave(i) {
    const p = pages[i];
    p.classList.remove("on"); p.classList.add("off");
    setTimeout(() => p.classList.remove("off"), 260);
    if (i === HOW) stepWords.forEach((b) => { b.classList.remove("live"); b.parentElement.classList.remove("on"); });
    if (i === FEATURES) feats.forEach((f) => f.classList.remove("live"));
    if (i === TURN) setTimeout(() => { if (at !== TURN) pages[TURN].classList.remove("swap"); }, 300);
  }
  const setStep = (k) => stepWords.forEach((b, j) => { b.classList.toggle("live", j === k); b.parentElement.classList.toggle("on", j === k); });
  const setFeat = (k) => feats.forEach((f, j) => f.classList.toggle("live", j === k));
  const setShot = (k) => { shots.forEach((im, j) => im.classList.toggle("on", j === k)); tabs.forEach((t, j) => t.setAttribute("aria-selected", j === k ? "true" : "false")); };
  const DO = {
    enter: () => { html.classList.remove("intro"); enter(at); },
    walk: (k) => { if (at === HOW) setStep(k); else if (at === FEATURES) setFeat(k); },
    shot: setShot,
    swap: (v) => pages[TURN].classList.toggle("swap", !!v),
    night: (v) => html.classList.toggle("night", !!v),
    dusk: (v) => html.classList.toggle("dusk", !!v),
  };

  // ---- the journey ----
  const tickBox = $(".ticks");
  IDS.forEach(() => tickBox.append(document.createElement("span")));
  tickBox.setAttribute("aria-hidden", "true");
  const ticks = all("span", tickBox);
  const mark = (i) => ticks.forEach((b, j) => b.toggleAttribute("aria-current", j === i));
  const rearm = (t) => {
    const s = seg(), ev = part === "a" ? s.events : s.loop, no = part === "a" ? s.notes : s.loopNotes;
    next = 0; while (next < ev.length && ev[next][0] <= t) DO[ev[next][1]]?.(ev[next][2]), next++;
    noteI = 0; while (noteI < no.length && no[noteI][0] <= t) noteI++;
    lastT = t;
  };
  function go(i) {
    i = Math.max(0, Math.min(LAST, i));
    if (i === at) return;
    if (dead) { leave(at); at = i; box.style.backgroundImage = `url(${F.base}${seg().poster})`; mark(i); setTimeout(() => { enter(at); if (at === HOW) setStep(0); if (at === FEATURES) setFeat(0); if (at === PROOF) setShot(0); }, 280); return; }
    html.classList.remove("intro", "night", "dusk");
    const forward = i === at + 1, old = at;
    onward = false;
    leave(old);
    at = i; mark(i);
    fetchNear();
    S.chord(i, forward ? Math.min(3, seg().aDur * .4) : 1.2);
    S.scale = forward ? 1 : .7;
    if (forward) {
      part = "a"; wraps = 0; next = 0; noteI = 0; lastT = 0;
      const v = player(seg().a);
      v.playbackRate = 1;
      try { v.currentTime = 0; } catch {}
      start(v, 240, () => prepare(seg().b));
    } else {
      part = "b"; wraps = 0;
      const v = player(seg().b);
      v.playbackRate = 1;
      try { v.currentTime = 0; } catch {}
      start(v, 300, () => { rearm(0); prepare(F.segments[at + 1]?.a); });
      setTimeout(() => { enter(at); }, 180);
    }
  }
  function toLoop() {
    part = "b"; wraps = 0;
    const v = player(seg().b);
    v.playbackRate = 1;
    try { v.currentTime = 0; } catch {}
    rearm(0);
    start(v, 160, () => prepare(F.segments[at + 1]?.a));
  }
  function frame() {
    requestAnimationFrame(frame);
    const v = live;
    if (!v || dead || starting) return; // the film on show isn't the one this screen is waiting for yet
    const t = v.currentTime, s = seg(), events = part === "a" ? s.events : s.loop, notes = part === "a" ? s.notes : s.loopNotes;
    if (part === "b" && t < lastT - 1) { next = 0; noteI = 0; wraps++; S.scale = Math.max(.4, .86 ** wraps); }
    lastT = t;
    while (next < events.length && events[next][0] <= t) { const e = events[next++]; DO[e[1]]?.(e[2]); }
    const lead = S.lead() / 1000, rate = v.playbackRate || 1;
    while (noteI < notes.length && notes[noteI][0] <= t + lead * rate) { const n = notes[noteI++]; S.at(performance.now() + Math.max(0, n[0] - t) / rate * 1000, n[1], ...n[2]); }
    if (part === "a" && !s.hold && rate !== 1 && t >= s.fly) v.playbackRate = 1;
    if (part === "a" && (t >= s.aDur - .17 || v.ended)) { if (onward) go(at + 1); else toLoop(); }
    const lv = S.on && S.unlocked ? S.level() : 0;
    bars.forEach((b, j) => b.style.setProperty("--b", (.28 + Math.min(.72, lv * (2.6 + j * 1.1 - (j === 2 ? 2 : 0)))).toFixed(2)));
  }

  // ---- gestures ----
  // A swipe during a flight hurries it. The wall has to finish coming down before anything can follow it.
  const hurry = () => { if (live) live.playbackRate = 2.2; };
  const step = (d) => {
    const t = live?.currentTime ?? 0, s = seg();
    if (d > 0 && part === "a" && t < s.fly) return hurry();
    if (d > 0 && part === "a" && s.hold) { hurry(); onward = true; return; }
    go(at + d);
  };
  let y0 = null;
  addEventListener("touchstart", (e) => { tapped = true; y0 = e.touches.length === 1 ? e.touches[0].clientY : null; live?.paused && !dead && live.play().catch(() => {}); }, { passive: true });
  addEventListener("touchmove", (e) => { if (!e.target.closest("a, button")) e.preventDefault(); }, { passive: false });
  addEventListener("touchend", (e) => {
    if (y0 === null) return;
    const dy = y0 - e.changedTouches[0].clientY; y0 = null;
    if (Math.abs(dy) > 34) step(Math.sign(dy));
  }, { passive: true });
  let armed = true, lastWheel = 0;
  addEventListener("wheel", (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel > 160) armed = true;
    lastWheel = now;
    if (armed && Math.abs(e.deltaY) >= 3) { armed = false; step(Math.sign(e.deltaY)); }
  }, { passive: false });
  addEventListener("keydown", (e) => {
    if (["ArrowDown", "PageDown", " "].includes(e.key)) { e.preventDefault(); step(1); } else if (["ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); step(-1); } else if (e.key === "Home") go(0); else if (e.key === "End") go(LAST);
  });
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]");
    if (g && !g.hasAttribute("data-send")) { e.preventDefault(); go(IDS.indexOf(g.dataset.go)); }
    const s = e.target.closest("[data-send]");
    if (!s) return;
    e.preventDefault();
    const LINK = "https://dinesh4720.github.io/design-app-releases/download.html", label = s.querySelector(".send"), was = label.dataset.was ??= label.textContent;
    const say = (t) => { label.textContent = t; clearTimeout(label.timer); label.timer = setTimeout(() => { label.textContent = was; }, 2600); };
    const copy = () => (navigator.clipboard ? navigator.clipboard.writeText(LINK).then(() => say("Link copied"), () => say("Open knot on your Mac")) : say("Open knot on your Mac"));
    if (navigator.share) navigator.share({ title: "Knot for Mac", text: "Open this on your Mac.", url: LINK }).catch((err) => { if (err?.name !== "AbortError") copy(); });
    else copy();
  });
  tabs.forEach((b) => b.addEventListener("click", () => {
    const k = +b.dataset.shot;
    S.tab(k);
    if (at !== PROOF || part !== "b" || dead) return;
    const t = seg().shotAt[k];
    try { live.currentTime = t; } catch {}
    rearm(t);
    setShot(k);
  }));

  // ---- sound ----
  const soundBtn = $(".sound"), soundLabel = $(".say-sound"), bars = all(".bars i");
  const paint = () => { const on = S.on && S.unlocked; soundBtn.setAttribute("aria-pressed", String(on)); soundBtn.setAttribute("aria-label", on ? "Turn sound off" : "Turn sound on"); soundLabel.textContent = on ? "Sound" : "Turn sound on"; };
  S.onchange = () => { paint(); if (S.on && S.unlocked) S.chord(at, 1.8); }; paint();
  soundBtn.addEventListener("click", (e) => { e.stopPropagation(); if (S.on && S.unlocked) S.set(false); else S.set(true, () => S.press()); paint(); });
  for (const type of ["pointerdown", "touchend", "keydown"]) addEventListener(type, (e) => { if (!e.target?.closest?.(".sound")) S.unlock(); }, { capture: true, passive: true });

  // ---- bringing the films in, nearest first, so a swipe never waits ----
  let fetching = false;
  async function fetchNear() {
    if (fetching) return;
    fetching = true;
    for (let name; !direct && (name = [seg().b, F.segments[at + 1]?.a, F.segments[at + 1]?.b].find((n) => n && !blobs.has(n)));) {
      try { const r = await fetch(F.base + name); if (!r.ok) throw 0; blobs.set(name, URL.createObjectURL(await r.blob())); } catch { blobs.set(name, F.base + name); }
      const seen = holds.get(name);
      if (seen && seen !== live && seen !== fading && seen !== starting) load(seen, name);
    }
    fetching = false;
  }
  addEventListener("visibilitychange", () => { if (!document.hidden && live && !dead) live.play().catch(() => {}); });

  // ---- off we go ----
  html.classList.add("intro");
  pages[0].classList.remove("on");
  mark(0);
  const first = load(pool[0], seg().a);
  start(first, 200, () => { finishLoader(); prepare(seg().b); });
  fetchNear();
  // Low Power Mode won't start a film by itself: don't wait for it.
  setTimeout(() => { if (!live) stillOnly(); }, 5000);
  requestAnimationFrame(frame);
  window.__reel = { go, get at() { return at; }, get part() { return part; }, get time() { return live?.currentTime; }, get live() { return live; }, get holds() { return [...holds.keys()]; }, get dead() { return dead; } };
})();
