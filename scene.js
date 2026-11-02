// scene.js — six screens, one liquid. The knot melts into six drops (one for each
// step), the drops fall and the sea stands up in spikes, a mirror rises streaming
// from the sea with the app under its mercury, the mirror becomes a wall of the same
// screen, the wall melts, and the drops climb out and pull back into the knot, which
// ignites. One scroll, swipe or key plays the next part; the whole journey is one
// timeline in milliseconds, so going back plays it backwards. Each screen also keeps
// moving by itself while you read it.
(() => {
  "use strict";
  const html = document.documentElement;
  const $ = (s) => document.querySelector(s);
  const all = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const outBack = (t) => { const c = 1.4; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
  const nrm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

  const IDS = ["top", "how", "features", "proof", "turn", "download"];
  const LAST = IDS.length - 1, HOW = 1, FEATURES = 2, PROOF = 3, TURN = 4;
  const pages = IDS.map((id) => $("#" + id));
  const links = all("[data-go]");
  for (const p of pages) all(".r", p).forEach((r, i) => r.style.setProperty("--i", i));

  // ---- the app's screens ----
  const shots = all("#shots img"), tabs = all(".tabs button");
  let shot = 0, tabbed = false, onShot = null;
  function setShot(i) {
    const old = shot;
    shot = i;
    shots.forEach((im, j) => im.classList.toggle("on", j === i));
    tabs.forEach((t, j) => t.setAttribute("aria-selected", j === i ? "true" : "false"));
    onShot?.(old, i);
  }
  tabs.forEach((b) => b.addEventListener("click", () => { tabbed = true; if (+b.dataset.shot !== shot) setShot(+b.dataset.shot); }));

  // A phone can't install a Mac app, so its button sends the link to one. This holds on the plain page too.
  const SEND_URL = "https://dinesh4720.github.io/design-app-releases/download.html";
  document.addEventListener("click", (e) => {
    const s = e.target.closest("[data-send]");
    if (!s || !matchMedia("(max-aspect-ratio: 23/20), (max-width: 860px) and (min-height: 561px)").matches) return;
    e.preventDefault();
    const label = s.querySelector(".send"), was = label.dataset.was ??= label.textContent;
    const say = (t) => { label.textContent = t; clearTimeout(label.timer); label.timer = setTimeout(() => { label.textContent = was; }, 2600); };
    const copy = () => (navigator.clipboard ? navigator.clipboard.writeText(SEND_URL).then(() => say("Link copied"), () => say("Open knot on your Mac")) : say("Open knot on your Mac"));
    if (navigator.share) navigator.share({ title: "Knot for Mac", text: "Open this on your Mac.", url: SEND_URL }).catch((err) => { if (err?.name !== "AbortError") copy(); });
    else copy();
  });

  // Without the world this is an ordinary page: links jump, and that's all.
  if (!html.classList.contains("paged")) { $(".nav").setAttribute("data-solid", ""); return; }

  // ---- the screen every generator makes, as a picture: the same one for the whole wall ----
  function cloneScreen() {
    const c = document.createElement("canvas"); c.width = 1024; c.height = 640;
    const x = c.getContext("2d"), ink = "#141416", soft = "#77777d", line = "#dcdcdf", F = "Archivo, Helvetica, Arial, sans-serif";
    const pill = (l, t, w, h, r, fill, stroke) => { x.beginPath(); if (x.roundRect) x.roundRect(l, t, w, h, r); else x.rect(l, t, w, h); if (fill) { x.fillStyle = fill; x.fill(); } if (stroke) { x.strokeStyle = stroke; x.lineWidth = 2; x.stroke(); } };
    x.fillStyle = "#fbfbfc"; x.fillRect(0, 0, 1024, 640);
    pill(48, 34, 26, 26, 8, ink);
    x.fillStyle = ink; x.font = `600 23px ${F}`; x.textBaseline = "middle"; x.fillText("Acme", 86, 48);
    x.fillStyle = soft; x.font = `400 19px ${F}`; [["Product", 620], ["Pricing", 708], ["Docs", 790]].forEach(([w, l]) => x.fillText(w, l, 48));
    pill(848, 28, 128, 40, 20, ink); x.fillStyle = "#fff"; x.font = `600 18px ${F}`; x.textAlign = "center"; x.fillText("Get started", 912, 48);
    x.fillStyle = ink; x.font = `600 66px ${F}`; x.fillText("Build faster with AI", 512, 170);
    x.fillStyle = soft; x.font = `400 25px ${F}`; x.fillText("The all-in-one platform for modern teams.", 512, 232);
    pill(344, 272, 164, 50, 25, ink); x.fillStyle = "#fff"; x.font = `600 20px ${F}`; x.fillText("Get started", 426, 297);
    pill(520, 272, 164, 50, 25, null, line); x.fillStyle = ink; x.fillText("Learn more", 602, 297);
    [["Fast", "Ship in minutes."], ["Secure", "Built for scale."], ["Simple", "No code needed."]].forEach(([a, b], i) => {
      const l = 48 + i * 318;
      pill(l, 372, 292, 216, 18, "#fff", line); pill(l + 28, 402, 44, 44, 22, "#e6e6e9");
      x.textAlign = "left"; x.fillStyle = ink; x.font = `600 26px ${F}`; x.fillText(a, l + 28, 492);
      x.fillStyle = soft; x.font = `400 20px ${F}`; x.fillText(b, l + 28, 534);
    });
    return c;
  }

  // ---- the world ----
  const canvas = $("#world"), K = window.KNOT, mid = K.tier === "mid";
  let world = null;
  K.trial();
  // Leaving a page that's up, or one just opened, says nothing. Walking away from a long wait does.
  const opened = performance.now();
  addEventListener("pagehide", () => { if (shown || performance.now() - opened < 3000) K.left(); });
  try {
    world = new World(canvas, mid || (Math.min(screen.width, screen.height) < 600 && !html.classList.contains("film")) ? { heightSize: 640, sdfSize: 96 } : {});
    window.__world = world;
    if (!world.ok) world = null;
  } catch (e) { console.warn("world:", e); world = null; }
  const toFlow = () => { world = null; html.classList.remove("paged", "world-on"); html.classList.add("flow"); $(".nav").setAttribute("data-solid", ""); };
  let gone = false;
  const giveUp = (why) => { if (gone) return; gone = true; if (!K.film(why)) { gone = false; toFlow(); } };
  if (!world) { giveUp("the live world couldn't start"); return; }
  canvas.addEventListener("world:lost", () => giveUp("the graphics driver gave up"));
  // The build gets 8 s between one step and the next and 15 s in all, counting only time someone could be looking at it.
  if (!K.forced) {
    let was = opened, step = -1, still = 0, waited = 0;
    const watch = setInterval(() => {
      if (shown || !world) return clearInterval(watch);
      const now = performance.now(), dt = now - was;
      was = now;
      if (document.hidden) return;
      waited += dt;
      if (world.progress !== step) { step = world.progress; still = 0; } else still += dt;
      if (still >= 8000 || waited >= 15000) { clearInterval(watch); giveUp("the live world took too long to build"); }
    }, 500);
  }
  // The app's pictures take a tenth of a second to hand to the GPU: not while the bands are flying.
  let screensReady = false, decoding = false;
  const decode = () => { if (decoding) return; decoding = true; Promise.all(shots.map((im) => im.decode().catch(() => {}))).then(() => { screensReady = true; }); };
  K.font.then(() => world?.setClone(cloneScreen()));

  // ---- where you are ----
  const tickBox = $(".ticks");
  // On a phone these only say where you are: a swipe does the moving.
  const dots = matchMedia("(max-aspect-ratio: 23/20), (max-width: 860px) and (min-height: 561px)").matches;
  IDS.forEach((id, i) => {
    const b = document.createElement(dots ? "span" : "button");
    if (!dots) { b.type = "button"; b.setAttribute("aria-label", `Go to screen ${i + 1} of ${IDS.length}`); b.addEventListener("click", () => go(i)); }
    tickBox.append(b);
  });
  if (dots) tickBox.setAttribute("aria-hidden", "true");
  const ticks = all("button, span", tickBox);
  function mark(i) {
    ticks.forEach((b, j) => b.toggleAttribute("aria-current", j === i));
    links.forEach((a) => a.toggleAttribute("aria-current", a.dataset.go === IDS[i] && !a.classList.contains("btn")));
  }

  // ---- screens fit the screen ----
  function fit() {
    for (const p of pages) {
      const inner = p.querySelector(".inner"), cs = getComputedStyle(p);
      inner.style.zoom = "";
      const room = innerHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const h = inner.offsetHeight;
      if (h > room) inner.style.zoom = String(room / h);
    }
  }

  // ---- the knot's strand: where the six drops gather ----
  const KY = 1.6, LIFT = World.SHAPE.LIFT, HOLE = KY - LIFT, KS = World.SHAPE.S, KH = World.SHAPE.H;
  const curve = (u) => { const t = Math.PI * 2 * u + Math.PI; return [KS * (Math.sin(t) + 2 * Math.sin(2 * t)), KY - LIFT + KS * (2 * Math.cos(2 * t) - Math.cos(t)), -KH * Math.sin(3 * t)]; };
  const onKnot = [0, 1, 2, 3, 4, 5].map((i) => curve(i / 6));

  // ---- the journey ----
  const portraitMQ = matchMedia("(max-aspect-ratio: 23/20), (max-width: 860px) and (min-height: 561px)");
  let heroR = 200, heroCy = 300, titled = false, titleShift = .2;
  let isP = portraitMQ.matches, shotsBox = { left: 0, top: 0, right: 0, bottom: 0, width: 1, height: 1 };
  const portrait = () => isP;
  let stops = [], T = [], anchor = [], curves = {}, column = [], columnR = .3, slabAt = { x: -15, y: 1, hw: 2, hh: 1.3 };
  function build() {
    isP = portraitMQ.matches;
    const W = innerWidth, H = innerHeight, A = W / H, P = isP;
    const gut = parseFloat(getComputedStyle(pages[1]).paddingLeft) || 0;
    const base = { dim: 0, wave: 1, bulge: .3, bloom: .3, roll: 0, kyaw: 0, kpitch: 0, scrim: 0, crown: 0, still: 1, field: 0, ks: 1, up: [0, 1, 0], shift: [0, 0], krefl: 1, sx: .6, sw: .2, melt: 0, wob: 0, dropA: 0, dropF: 0, slab: 0, wall: 0, chl: 0, fw: 1 };
    const list = [];
    let ms = 0;
    const add = (dt, o) => { ms += dt; list.push({ ...base, ...o, ms }); return ms; };
    const az = (p) => -Math.atan2(p[0], p[2]);
    const aim = (pos, cx, cy, r) => {
      const d = Math.hypot(pos[0], pos[1] - KY, pos[2]);
      return { pos, tgt: [0, KY, 0], f: (H / 2) / (d * (r / 1.36)), shift: [-(2 * cx / W - 1) * A, -(1 - 2 * cy / H)], kyaw: az(pos) };
    };
    const side = (pos, rl, cyl = .5) => { const r = Math.min(rl * H, .24 * W); return aim(pos, W - gut - r - 8, cyl * H, r); };
    const rect = (sel) => $(sel).getBoundingClientRect();
    const hero = (() => { heroR = P ? Math.min(W * .4, H * .19) : Math.min(H * .3, W * .178); heroCy = P ? H * .42 : H * .44; return aim([0, .75, 9.4], W / 2, heroCy, heroR); })();
    const dropAt = P ? aim([0, .9, 9.4], W / 2, H * .5, Math.min(W * .4, H * .2)) : side([0, .9, 9.4], .34);

    // The six drops hang level with the six words.
    const howPos = [0, 2.6, 10.5], howF = .34, howD = howPos[2], howPpu = (H / 2) / (howD * howF);
    const rows = all("#how .steps b").map((b) => { const r = b.getBoundingClientRect(); return r.top + r.height / 2; });
    const gap = rows.length > 1 ? rows[1] - rows[0] : 60;
    const xPx = W * .72, rowGap = (W - gut * 2 - 36) / 5;
    columnR = (P ? rowGap * .44 : Math.min(gap * .34, H * .045)) / howPpu;
    column = rows.map((y, i) => {
      const px = P ? gut + 18 + i * rowGap : xPx, py = P ? H * .63 : y;
      return [((2 * px / W - 1) * A) * howF * howD, howPos[1] + (1 - 2 * py / H) * howF * howD, 0];
    });

    // The app's mirror stands on the sea, exactly over the page's own box for it.
    const box = shotsBox = rect("#shots"), pf = .3, pd = 11, px0 = -15, py0 = 1.05, ppu = (H / 2) / (pd * pf);
    slabAt = { hw: box.width / 2 / ppu, hh: box.height / 2 / ppu, x: px0 + (2 * (box.left + box.width / 2) / W - 1) * A * pf * pd };
    slabAt.y = .04 + slabAt.hh;
    boxW = box.width; boxH = box.height; windowed = box.width < 760; vw = Math.min(1, boxW / APP[0]); vh = Math.min(1, boxH / APP[1]);
    const proofCam = { pos: [px0, py0, pd], tgt: [px0, py0, 0], f: pf, shift: [0, (.04 - py0) / (pf * pd) - (1 - 2 * box.bottom / H)] };

    // 0 · the landing
    anchor[0] = add(0, { ...hero, still: 0, wave: .5, crown: .28 });
    // slowly up to the knot and through it
    add(900, { pos: [0, 1.1, 6.8], tgt: [0, 1.45, 0], f: .36, shift: [hero.shift[0] * .55, hero.shift[1] * .55], crown: .4, wob: .2 });
    add(900, { pos: [0, HOLE, 3], tgt: [0, HOLE, 0], f: .48, crown: .5, wob: .4, field: .15 });
    add(900, { pos: [0, HOLE, .1], tgt: [0, HOLE - .8, -3], f: .9, crown: .5, wob: .5, field: .5 });
    // a turn over the sea, standing up in spikes, to look back at it
    const back1 = [4.2, 1.8, -4.6], back2 = [8.6, 2.2, -1.8], back3 = [7.4, 2.5, 6];
    add(700, { pos: [1.3, 1.5, -3], tgt: [3.8, .55, -1.8], f: .6, roll: -.12, wob: .6, field: .9, kyaw: -1.2 });
    add(700, { pos: back1, tgt: [.6, 1.6, -.2], f: .46, roll: -.06, wob: .8, field: .7, kyaw: az(back1) });
    // and it comes apart, facing us
    add(800, { pos: back2, tgt: [0, 1.8, 0], f: .36, wob: 1, melt: .45, field: .2, kyaw: az(back2) });
    add(800, { pos: back3, tgt: [0, 2, 0], f: .34, melt: 1, wob: 1, kyaw: az(back3) });
    // 1 · how it works
    anchor[HOW] = add(900, { pos: howPos, tgt: [howPos[0], howPos[1], 0], f: howF, melt: 1, dropA: 1, bulge: 0, wave: .7 });
    // the drops fall, one by one, and the sea stands up
    add(800, { pos: [1, 2.8, 9.4], tgt: [2.4, .6, 0], f: .38, melt: 1, dropA: 1, dropF: .8, bulge: 0 });
    add(600, { pos: [2.2, 1.6, 8.6], tgt: [3.4, .8, 0], f: .5, melt: 1, dropA: 1, dropF: 1, field: .7, bulge: 0 });
    const R0 = 3 / .42;
    const orbit = (th, y = 1.5) => { const pos = [R0 * Math.sin(th), y, R0 * Math.cos(th)], t = [Math.cos(th), 0, -Math.sin(th)], inn = [-Math.sin(th), 0, -Math.cos(th)]; return { pos, tgt: [pos[0] + t[0] * 6 + inn[0] * 1.3, y + .5, pos[2] + t[2] * 6 + inn[2] * 1.3] }; };
    for (let i = 0; i <= 6; i++) { const q = i / 6; add(i ? 300 : 500, { ...orbit(lerp(.95, 2.5, q)), f: P ? .7 : .5, wave: .7, field: Math.min(2.6, .9 + q * 6), fw: .62, roll: -.1, melt: 1, dropA: 0, dropF: 1, bulge: 0 }); }
    add(1100, { pos: [-5.5, 7, -6], tgt: [0, 1, -.5], f: .62, field: 2.2, fw: .85, melt: 1, dropF: 1, chl: .6, bulge: 0 });
    // 2 · features: the sea from above, forming figures
    const fx = P ? [0, .3] : [-.5 * A, 0];
    anchor[FEATURES] = add(900, { pos: [.01, 12.5, 2.4], tgt: [0, 0, 0], f: .5, shift: fx, field: 1.4, melt: 1, dropF: 1, chl: 1, bulge: 0, ...(P ? {} : { scrim: .96, sx: .6, sw: .1 }) });
    // the spikes lie down, and a mirror rises
    add(600, { pos: [-9, 3.2, 10], tgt: [-13, 1.4, 0], f: .42, field: .35, melt: 1, dropF: 1, roll: .08, wave: .6, slab: .12, bulge: 0 });
    add(600, { pos: [-13, 1.5, 12], tgt: [-14.6, 1.1, 0], f: .34, melt: 1, dropF: 1, wave: .5, slab: .45, bulge: 0 });
    // 3 · the app
    anchor[PROOF] = add(900, { ...proofCam, melt: 1, dropF: 1, slab: 1, wave: .3, bulge: 0 });
    // the mirror goes under, and the same screen rises again and again
    add(800, { pos: [-13, 1.5, 14], tgt: [-8, 2, -3], f: .36, melt: 1, dropF: 1, slab: .25, wall: .5, bulge: 0 });
    // 4 · the turn
    const aimF = (pos, cx, cy, f) => aim(pos, cx, cy, (H / 2) / (Math.hypot(pos[0], pos[1] - KY, pos[2]) * f) * 1.36);
    const turnFar = P ? { ...aimF([-1.8, 1.5, 12.5], W / 2, H * .405, .52), kyaw: 0 } : { ...aimF([-5.5, 1.5, 12.5], W * .72, H * .62, .3), kyaw: 0, scrim: 1, sx: .47, sw: .1 };
    anchor[TURN] = add(900, { ...turnFar, melt: 1, dropF: 1, wall: 1, bulge: 0 });
    // the drops find each other, closing on the place the knot belongs
    const mid = { pos: [-2.8, 1.2, 10.8], tgt: [0, 1.5, 0], f: .3, shift: [lerp(turnFar.shift[0], dropAt.shift[0], .5), lerp(turnFar.shift[1], dropAt.shift[1], .5)] };
    add(1200, { ...mid, melt: 1, dropF: .6, bulge: 0 });
    add(1200, { ...dropAt, melt: 1, dropF: 0, wob: 1, bulge: .1 });
    // 5 · the knot, and the drop
    anchor[LAST] = add(1100, { ...dropAt, crown: P ? 0 : .8, wob: 0, still: 0 });

    stops = list; T = list.map((s) => s.ms);
    const vals = list.map((s) => [...s.pos, ...s.tgt, ...s.up, s.f, s.shift[0], s.shift[1]]), n = vals.length;
    curves = { vals, tans: vals.map((v, i) => v.map((x, k) => {
      const a = vals[Math.max(0, i - 1)][k], b = vals[Math.min(n - 1, i + 1)][k], d = T[Math.min(n - 1, i + 1)] - T[Math.max(0, i - 1)];
      return (b - a) / d;
    })) };
  }
  function evalAt(x) {
    const n = stops.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x >= T[m]) lo = m; else hi = m; }
    const h = T[hi] - T[lo], t = clamp((x - T[lo]) / h, 0, 1), st = smooth(t);
    const t2 = t * t, t3 = t2 * t, a = curves.vals[lo], b = curves.vals[hi], ma = curves.tans[lo], mb = curves.tans[hi];
    const c = a.map((v, k) => (2 * t3 - 3 * t2 + 1) * v + (t3 - 2 * t2 + t) * h * ma[k] + (-2 * t3 + 3 * t2) * b[k] + (t3 - t2) * h * mb[k]);
    const A = stops[lo], B = stops[hi], num = (k) => lerp(A[k], B[k], st);
    return {
      pos: [c[0], c[1], c[2]], tgt: [c[3], c[4], c[5]], up: nrm([c[6], c[7], c[8]]), f: c[9], shift: [c[10], c[11]], roll: num("roll"),
      dim: num("dim"), wave: num("wave"), bulge: num("bulge"), bloom: num("bloom"), kyaw: num("kyaw"), kpitch: num("kpitch"),
      scrim: num("scrim"), sx: num("sx"), sw: num("sw"), crown: num("crown"), still: num("still"), field: num("field"), ks: num("ks"), krefl: num("krefl"),
      melt: num("melt"), wob: num("wob"), dropA: num("dropA"), dropF: num("dropF"), slab: num("slab"), wall: num("wall"), chl: num("chl"), fw: num("fw"),
    };
  }

  // ---- moving between screens ----
  let page = 0, tl = 0, flight = null, arrived = performance.now();
  const leftSea = [false, false, false, false, false, false];
  // Sounds for moments that are coming: said a little ahead, so each is heard as it's seen.
  const queue = [];
  const soon = (at, name, ...args) => queue.push({ at, name, args });
  // A soft start and stop, and the timeline's own speed in between, so each moment lasts as long as its stops say.
  const EA = .16, ramp = (x) => x / 2 - (EA / (2 * Math.PI)) * Math.sin(Math.PI * x / EA);
  const ease = (q) => (q < EA ? ramp(q) / (1 - EA) : q > 1 - EA ? 1 - ramp(1 - q) / (1 - EA) : (EA / 2 + q - EA) / (1 - EA));
  // each screen's own life
  const stepWords = all("#how .steps b"), stepsBox = $("#how .steps"), feats = all("#features .feat");
  const BAND = { far: 9.5, T: 2.7, start: .05, spin: 1.3 };
  let closed = false, closedAt = -1, settleWob = 0, titleQ = 0, headWas = -BAND.far, tailWas = 0, wetBand = [0, 0, 0];
  // The strand closes: everything else on the first screen comes in from it.
  function closeKnot(now) {
    closed = true; closedAt = now;
    world.drop(0, 0, 1.5, .5);
    html.classList.remove("intro");
    if (page === 0 && !flight) enter(0); // someone may already be on their way to the next screen
  }
  let wallShow = 0, c0wall = 0, turnRise = 0, swapAt = 0, walkSaid = false, walkN = 0, leftN = 0, walkI = -1, walkAt = 0, chlFrom = 0, chlTo = 0, chlMix = 1, wallMelt = 0, slabL = 1, slabFirst = true, slabOld = 0, slabNew = 0, ripAt = -9, ripUV = [.5, .5], ripAmp = 0;
  const FIG = [[1, 2], [2, 3], [1, 4], [3, 5], [2, 5], [4, 5], [1, 3], [3, 4]];
  onShot = (a, b) => { slabOld = a; slabNew = b; slabL = 0; slabFirst = false; viewOld = view; tourT = 0; userX = 0; lipNotes(performance.now(), 1400, 4, .1); };
  // On a small screen the mirror is a window onto the real app, at the app's own size, and
  // it glides between the parts worth reading. A sideways drag takes it anywhere.
  const APP = [1440, 900];
  const TOUR = [
    [[245, 44], [1046, 44]],  // Home: the recent list, then the file's details
    [[0, 372], [560, 190]],   // Canvas: the agent's finished task, then the storyboard
    [[0, 0], [1440, 0]],      // Play: the site's headline, then its words and button
  ];
  // Play is a whole site, wider than a phone: its window takes in the full height.
  const zoomOf = (s) => (s === 2 ? Math.min(APP[0] / boxW, APP[1] / boxH) : 1);
  const HOLD_A = 2300, GLIDE = 1700, HOLD_B = 2600;
  let windowed = false, vw = 1, vh = 1, boxW = 1, boxH = 1, view = [0, 0], viewOld = [0, 0], viewLast = [0, 0], tourT = 0, userX = 0, dragging = false, dragAt = -1e9;
  function viewAt(s, t) {
    const [a, b] = TOUR[s], z = zoomOf(s), q = smooth(clamp((t - HOLD_A) / GLIDE, 0, 1)), maxX = APP[0] - boxW * z, maxY = Math.max(0, APP[1] - boxH * z);
    return [clamp(lerp(a[0], b[0], q) + userX, 0, maxX), clamp(lerp(a[1], b[1], q), 0, maxY)];
  }
  function enter(i) {
    // On a phone the first word is there as soon as its screen is.
    if (isP && i === HOW) { stepWords[0].classList.add("live"); stepWords[0].parentElement.classList.add("on"); walkI = 0; walkAt = performance.now(); }
    if (isP && i === FEATURES) { feats[0].classList.add("live"); walkI = 0; walkAt = performance.now(); }
    pages[i].classList.remove("off");
    pages[i].classList.add("on");
  }
  function arrive(i, now) {
    arrived = now;
    try { history.replaceState(null, "", i ? "#" + IDS[i] : location.pathname + location.search); } catch {}
    const h = $(`#${IDS[i]} h1, #${IDS[i]} h2, #${IDS[i]} .say`);
    h?.setAttribute("tabindex", "-1");
    h?.focus({ preventScroll: true });
    if (i === HOW) { stepsBox.classList.add("walk"); if (!isP) { walkI = -1; walkAt = 0; } }
    if (i === FEATURES && !isP) { walkI = -1; walkAt = 0; }
    if (i === LAST) turnRise = 0;
    if (i === PROOF) lipNotes(now, 2100, 6, .2);
    if (i === TURN) { swapAt = now + 2800; soon(swapAt, "flood"); soon(swapAt + 520, "melt"); }
    if (i === LAST && !ignited) { soon(now + 300, "ignite"); soon(now + 3300, "flash"); }
  }
  function leave(i) {
    pages[i].classList.remove("on");
    pages[i].classList.add("off");
    if (i === HOW) { stepsBox.classList.remove("walk"); stepWords.forEach((b) => { b.classList.remove("live"); b.parentElement.classList.remove("on"); }); }
    if (i === FEATURES) feats.forEach((f) => f.classList.remove("live"));
    walkSaid = false;
    if (i === TURN) { swapAt = 0; leftN = 0; leftSea.fill(false); setTimeout(() => pages[TURN].classList.remove("swap"), 300); }
    if (i === LAST) { ignited = false; ignition = -1; flood = -1; }
    queue.length = 0;
  }
  function go(i, instant) {
    i = clamp(i, 0, LAST);
    if (i === page || flight) return;
    const from = page;
    if (instant) {
      pages[from].classList.remove("on", "off");
      leave(from); pages[from].classList.remove("off");
      page = i; tl = anchor[i]; if (i === TURN) { wallMelt = 0; turnRise = 0; } enter(i); mark(i); arrive(i, performance.now());
      S.chord(i, 1);
      return;
    }
    leave(from);
    page = i; mark(i);
    if (i === PROOF) { slabL = 0; slabFirst = true; slabOld = slabNew = shot; tourT = 0; userX = 0; }
    if (i === TURN) { wallMelt = 0; turnRise = 0; }
    const dist = Math.abs(anchor[i] - tl), dur = Math.abs(i - from) > 1 ? clamp(dist * .5, 2200, 4200) : dist;
    flight = { from: tl, to: anchor[i], p: 0, el: 0, dur, next: i, old: from, textAt: Math.max(dur - 900, dur * .6), entered: false, cleared: false, rate: 1, heard: tl, fast: dist / dur > 1.3 };
    S.chord(i, Math.min(3, dur / 1000 * .7));
    S.scale = i > from ? 1 : .7;
  }
  document.addEventListener("click", (e) => {
    const s = e.target.closest("[data-send]");
    if (s && isP) {
      e.preventDefault();
      return;
    }
    const a = e.target.closest("[data-go]");
    if (!a) return;
    e.preventDefault();
    go(IDS.indexOf(a.dataset.go));
  });

  // One gesture, one screen; a second gesture during a flight hurries it along.
  let lastWheel = 0, armed = true;
  const nudge = () => { if (flight) flight.rate = 2.6; };
  addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel > 160) armed = true;
    lastWheel = now;
    if (!armed || Math.abs(e.deltaY) < 3) return;
    armed = false;
    if (flight) nudge(); else go(page + Math.sign(e.deltaY));
  }, { passive: false });
  let touchY = null;
  let touchX = 0, lastX = 0;
  addEventListener("touchstart", (e) => { if (e.touches.length > 1) { touchY = null; return; } touchY = e.touches[0].clientY; touchX = lastX = e.touches[0].clientX; dragging = false; }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (!e.target.closest("a, button")) e.preventDefault();
    const t = e.touches[0], onWindow = windowed && page === PROOF && !flight && touchY > shotsBox.top && touchY < shotsBox.bottom;
    if (onWindow && !dragging && Math.abs(t.clientX - touchX) > 10 && Math.abs(t.clientX - touchX) > Math.abs(t.clientY - touchY)) dragging = true;
    if (dragging) { userX += lastX - t.clientX; dragAt = performance.now(); }
    lastX = t.clientX;
  }, { passive: false });
  addEventListener("touchend", (e) => {
    if (touchY === null) return;
    const ch = e.changedTouches[0], dy = touchY - ch.clientY, was = dragging, moved = Math.hypot(ch.clientX - touchX, dy);
    touchY = null; dragging = false;
    if (was) return;
    if (moved < 10) { tapAt({ clientX: ch.clientX, clientY: ch.clientY, target: e.target }); return; }
    if (Math.abs(dy) > 36) { if (flight) nudge(); else go(page + Math.sign(dy)); }
  }, { passive: true });
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key, on = e.target.closest?.("a, button");
    const step = (d) => { e.preventDefault(); if (flight) nudge(); else go(page + d); };
    if (k === "ArrowDown" || k === "PageDown" || (k === " " && !on)) step(1);
    else if (k === "ArrowUp" || k === "PageUp") step(-1);
    else if (k === "Home") { e.preventDefault(); go(0); }
    else if (k === "End") { e.preventDefault(); go(LAST); }
  });
  setInterval(() => { if (!windowed && page === PROOF && !flight && !tabbed && slabL >= 1) setShot((shot + 1) % shots.length); }, 4600);

  // ---- the pointer ----
  const Pt = { x: 0, y: 0, tx: 0, ty: 0, last: 0, in: false };
  let st = null, magX = 0, magZ = 0, magOn = 0, magKick = 0, slabYaw = 0, slabPitch = 0;
  const overShots = (e) => { const r = shotsBox; return page === PROOF && !flight && e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom ? [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] : null; };
  addEventListener("pointermove", (e) => {
    Pt.tx = (e.clientX / innerWidth) * 2 - 1; Pt.ty = (e.clientY / innerHeight) * 2 - 1; Pt.in = true;
    const now = performance.now(), speed = Math.hypot(e.clientX - Pt.x, e.clientY - Pt.y);
    if (world && st && now - Pt.last > 30 && speed > 2) {
      const hit = world.ray(st, e.clientX, e.clientY);
      if (hit && hit[2] < 40) { world.drop(hit[0], hit[1], .34, clamp(speed / 900, .012, .07)); }
      Pt.last = now;
    }
    const uv = overShots(e);
    if (uv && now - ripAt * 1000 > 260 && speed > 3) { ripUV = uv; ripAt = (now - start) / 1000; ripAmp = clamp(speed / 26, .35, .9); }
    Pt.x = e.clientX; Pt.y = e.clientY;
  }, { passive: true });
  const tapAt = (e) => {
    if (!world || !st) return;
    const uv = overShots(e);
    if (uv) { ripUV = uv; ripAt = (performance.now() - start) / 1000; ripAmp = 1.5; S.ring(0, .6); return; }
    if (e.target.closest("a, button")) return;
    if (isP && (page === HOW || page === FEATURES)) walkAt = 0;
    const hit = world.ray(st, e.clientX, e.clientY);
    if (hit && hit[2] < 60) { world.drop(hit[0], hit[1], .7, .34); magKick = .5; S.ring((e.clientX / innerWidth - .5) * 1.2, 1); }
  };
  addEventListener("pointerdown", (e) => { if (e.pointerType !== "touch") tapAt(e); }, { passive: true });

  // ---- resolution: the screen's own pixels, down only if the GPU can't keep up ----
  // The canvas keeps to about 7.5 million pixels, or a big monitor pays for what no eye can see.
  // A smaller GPU gets a smaller canvas: drawing fewer of the scene's pixels doesn't touch the passes that run at full size.
  const dprNow = () => Math.min(devicePixelRatio || 1, 2, Math.sqrt((mid ? 1.6e6 : 7.5e6) / (innerWidth * innerHeight)));
  let canvasDpr = dprNow();
  const ceilNow = () => clamp(Math.sqrt((mid ? 1.6e6 : 5.6e6) / (innerWidth * innerHeight * canvasDpr * canvasDpr)), .4, 1);
  const FLOOR = .34;
  let shareCeil = ceilNow(), share = Math.min(shareCeil, .72), locked = false, late = 0, calm = 0, hold = 0;
  const limit = [1, 1]; // at rest, in flight: the most that has held
  // Frames arriving late are all that count. The GPU's own clock can't be trusted here: a chip that
  // scales its speed to the work reads about the same at any size, and trusting it draws a soft
  // picture for nothing. So the size climbs slowly while frames are on time, steps down at once when they aren't, and remembers where that was, so
  // it doesn't keep finding the edge by falling off it. In flight it draws fewer: motion blur and
  // the accumulated history cover the difference, and on time is what the eye reads.
  // The aim is 60 a second, or what the browser allows when it's saving a battery. That is read
  // once, while nothing is being drawn: under load, a page running late looks just like a slow
  // display. And 120 isn't worth a softer picture.
  let BEAT = 1000 / 60;
  const calmBeats = [];
  function adapt(dt, flying, bands) {
    if (document.hidden || dt > 1000 || locked) return; // a throttled tab or a sleeping machine says nothing about the GPU
    const k = flying ? 1 : 0;
    if (dt > BEAT * 1.26) { calm = 0; if (++late >= 2) { late = 0; share = limit[k] = Math.max(FLOOR, share * (dt > 120 ? .8 : .94)); hold = 120; } }
    else if (hold > 0) hold--;
    else if (++calm > 30) { calm = 0; late = 0; share *= 1.015; limit[k] = Math.min(1, limit[k] * 1.002); }
    share = Math.min(share, shareCeil * (bands ? .56 : flying ? .84 : 1), limit[k]);
  }
  // Still under 18 frames a second at the smallest picture, it won't get better, the machine is suffering
  // for it, and a film is smoother. A few good seconds, and this machine has shown it can run the world.
  let slowMs = 0, slowN = 0, goodN = 0;
  function judge(dt) {
    if (K.forced || document.hidden) { slowMs = slowN = 0; goodN = Math.min(goodN, 0); return; }
    // Proof takes four unbroken seconds at 25 frames a second or better, on a picture above the smallest.
    if (goodN >= 0) goodN = dt < 40 && share > FLOOR * 1.2 ? goodN + 1 : 0;
    if (goodN >= 240) { goodN = -1; K.proven(); }
    // One huge gap is a machine waking up. Only a run of them counts.
    if (dt > 55 && (share <= FLOOR * 1.02 || dt > 400)) { slowMs += Math.min(dt, 1000); slowN++; } else if ((slowMs = Math.max(0, slowMs - dt * 2)) === 0) slowN = 0;
    if (slowMs > 3000 && slowN >= 3) giveUp("the live world ran too slowly");
  }

  // ---- sound ----
  // It starts with the first click, tap or key, as browsers require; a wheel doesn't count.
  const S = window.KnotSound, soundBtn = $(".sound"), soundLabel = $(".say-sound"), barEls = all(".bars i");
  const paintSound = () => {
    const live = S.on && S.unlocked;
    soundBtn.setAttribute("aria-pressed", String(live));
    soundBtn.setAttribute("aria-label", live ? "Turn sound off" : "Turn sound on");
    soundLabel.textContent = live ? "Sound" : "Turn sound on";
  };
  S.onchange = () => { paintSound(); if (S.on && S.unlocked) S.chord(page, 1.8); }; paintSound();
  soundBtn.addEventListener("click", (e) => { e.stopPropagation(); if (S.on && S.unlocked) S.set(false); else S.set(true, () => S.press()); paintSound(); });
  const firstGesture = (e) => { if (!e.target?.closest?.(".sound") && !(e.key === "Escape")) S.unlock(); };
  for (const type of ["pointerdown", "touchend", "keydown"]) addEventListener(type, firstGesture, { capture: true, passive: true });
  addEventListener("keydown", (e) => { if ((e.key === "m" || e.key === "M") && !e.repeat && !e.metaKey && !e.ctrlKey) soundBtn.click(); });
  addEventListener("pointerdown", (e) => {
    const b = e.target.closest?.("a, button");
    if (!b) return;
    if (b.dataset.shot !== undefined) S.tab(+b.dataset.shot); else if (!b.classList.contains("sound")) S.press();
  }, { passive: true });
  // The journey's score: what sounds at which place on the timeline. Flights are exact, so each
  // note can be placed to the sample. Whatever the world does by itself is read off its motion
  // here, in advance, rather than noticed a frame after it has happened.
  let SCORE = [];
  function writeScore() {
    const ev = [], at = (x, name, early, ...args) => ev.push({ x, name, early, args });
    at(2700, "chime", 130); at(3050, "stand", 420);
    [4150, 4400, 4590, 4740, 4850].forEach((x, i) => at(x, "drip", 0, i, (i % 3 - 1) * .3));
    at(8100, "field", 380);
    [0, 1, 2, 3, 4].forEach((i) => at(10500 + i * 380, "climb", 30, i));
    const keep = turnRise, held = [...pull];
    pull.fill(0);
    let whole = null, under = null, slabbed = false, necks = 0, plops = 0, joins = 0;
    for (let x = 0; x <= anchor[LAST]; x += 4) {
      turnRise = x >= anchor[TURN] ? 1 : 0;
      const c = evalAt(x), w = [], u = [];
      for (let i = 0; i < 6; i++) {
        const b = beadPos(i, c, 0, 0), sx = clamp(b[0] / 5, -.8, .8);
        w.push(b[3] > .74); u.push(b[1] - b[3] * .4 < 0);
        if (whole && c.dropA === 0) { if (whole[i] && !w[i]) at(x, "pinch", 0, necks++, sx); else if (!whole[i] && w[i]) at(x, "join", 30, joins++, sx); }
        if (under && !under[i] && u[i] && b[3] > .02 && x > 200) at(x, "plop", 0, plops++, sx);
      }
      whole = w; under = u;
      if (!slabbed && c.slab > .1) { slabbed = true; at(x, "mirror", 260, -.2); }
    }
    turnRise = keep;
    held.forEach((v, i) => { pull[i] = v; });
    SCORE = ev.sort((a, b) => a.x - b.x);
  }
  // How long from now until a flight reaches a place on the timeline.
  function timeTo(x) {
    const f = flight, goal = (x - f.from) / (f.to - f.from);
    let a = f.p, b = 1;
    for (let i = 0; i < 22; i++) { const m = (a + b) / 2; if (ease(m) < goal) a = m; else b = m; }
    return (a - f.p) * f.dur / f.rate;
  }
  // The lip moves on a curve, so its notes are spaced by where it is, not by the clock.
  function lipNotes(now, dur, n, p) {
    for (let k = 0; k < n; k++) {
      const pos = (k + .6) / n; let a = 0, b = 1;
      for (let i = 0; i < 16; i++) { const m = (a + b) / 2; if (smooth(m) < pos) a = m; else b = m; }
      soon(now + a * dur, "drain", k + 6 - n, p);
    }
  }
  function playScore(now) {
    const lead = S.lead();
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].at - now < lead) { const q = queue.splice(i, 1)[0]; S.at(Math.max(q.at, now), q.name, ...q.args); }
    if (!flight) return;
    const f = flight, ahead = lerp(f.from, f.to, ease(clamp((f.el + (lead + 450) * f.rate) / f.dur, 0, 1))), up = f.to > f.from;
    for (const e of SCORE) {
      if (!(up ? e.x > f.heard && e.x <= ahead : e.x < f.heard && e.x >= ahead)) continue;
      if (f.fast && (e.name === "drip" || e.name === "climb" || e.name === "plop")) continue;
      S.at(now + Math.max(0, timeTo(e.x) - e.early), e.name, ...e.args);
    }
    f.heard = ahead;
  }
  let camP = null;
  const WALL_C = [2.72, 1.8];
  const wallTicks = []; for (let y = 0; y < 3; y++) for (let x = -1; x < 4; x++) { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453, h = v - Math.floor(v); wallTicks.push({ at: (1 + h * .75) / 1.75, x, done: false }); }
  function soundFrame(c, ds, pos, now, t) {
    S.tl = tl;
    playScore(now);
    // the room opens with the camera's real speed
    let speed = 0;
    if (camP && ds > 0) speed = Math.hypot(pos[0] - camP[0], pos[1] - camP[1], pos[2] - camP[2]) / ds;
    camP = pos;
    S.frame({ open: flight ? clamp(speed / 14, 0, 1) : 0, dark: night });
    // the same note for every window as it clears
    const lead = S.lead();
    for (const w of wallTicks) {
      if (wallShow + (c0wall > .35 ? lead / 2100 : 0) >= w.at && !w.done && wallMelt === 0) { w.done = true; S.at(now + Math.max(0, w.at - wallShow) * 2100, "window", (w.x - 1) * .22); }
      else if (wallShow < w.at - .05) w.done = false;
    }
    // each drop as it comes up out of the sea: worked out a moment ahead
    if (page === TURN && !flight && wallMelt > .55) {
      const keep = turnRise;
      turnRise = Math.min(1, keep + lead / 2400);
      for (let i = 0; i < 6; i++) { const b = beadPos(i, c, t, now); if (!leftSea[i] && b[1] - b[3] * .4 >= 0) { leftSea[i] = true; S.at(now + lead, "leave", leftN++, clamp(b[0] / 5, -.8, .8)); } }
      turnRise = keep;
    }
    const lv = S.on && S.unlocked ? S.level() : 0;
    barEls.forEach((b, i) => b.style.setProperty("--b", (.28 + Math.min(.72, lv * (2.6 + i * 1.1 - (i === 2 ? 2 : 0)))).toFixed(2)));
  }

  // ---- the frame ----
  const start = performance.now(), GROUND = [.965, .965, .965];
  const beads = new Float32Array(24), mag = new Float32Array(8), wet = [0, 0, 0, 0, 0, 0], pull = [0, 0, 0, 0, 0, 0], pullV = [0, 0, 0, 0, 0, 0];
  let last = start, kx = 0, ky = 0, lap = 0, lapped = false, shown = false, introT = -1, risen = false, ignition = -1, flood = -1, ignited = false, flash = 0, night = 0, wasNight = false, wasDusk = false, idle = 1, rose = false, wallDown = false, pulseAt = 0;
  function frame(stamp) {
    if (gone || !html.classList.contains("paged")) return;
    requestAnimationFrame(frame);
    // The display's own clock: frames land evenly, so motion is even too.
    const now = stamp ?? performance.now(), rawDt = now - last, dt = Math.min(100, Math.max(0, rawDt)); last = now;
    const t = (now - start) / 1000, ds = dt / 1000;
    if (seekT !== null) tl = seekT;
    if (flight) {
      flight.el += dt * flight.rate;
      flight.p = clamp(flight.el / flight.dur, 0, 1);
      const q = flight.p;
      tl = lerp(flight.from, flight.to, ease(q));
      if (!flight.cleared && flight.el > 260) { flight.cleared = true; pages[flight.old].classList.remove("off"); }
      if (!flight.entered && flight.el > flight.textAt) { flight.entered = true; enter(flight.next); }
      if (q >= 1) { const f = flight; flight = null; tl = f.to; if (!f.entered) enter(f.next); arrive(f.next, now); }
    }
    // each screen's own life, whatever the GPU is doing
    if (!flight && (page === HOW || page === FEATURES)) {
      const every = page === HOW ? (isP ? 1600 : 1250) : (isP ? 2300 : 1900), next = walkAt + every, list = page === HOW ? stepWords : feats, after = (walkI + 1) % list.length;
      // The notes grow quieter as the walk goes round: it's a place to read in, not a performance.
      if (!walkSaid && next - now < S.lead()) {
        walkSaid = true;
        const g = Math.max(.4, .95 ** walkN++);
        if (page === HOW) S.at(Math.max(next, now), "step", after, isP ? (after - 2.5) * .22 : .3, g); else S.at(Math.max(next, now) - 240, "figure", after, g);
      }
      if (now > next) {
        walkAt = now; walkSaid = false;
        walkI = after;
        list.forEach((el, i) => { el.classList.toggle("live", i === walkI); if (page === HOW) el.parentElement.classList.toggle("on", i === walkI); });
        if (page === FEATURES) { chlFrom = chlTo; chlTo = walkI; chlMix = 0; }
        if (page === HOW) { pulseAt = now; const b = beadPos(walkI); world?.drop(b[0], b[2], .5, .22); }
      }
    }
    if (swapAt && now >= swapAt) { swapAt = 0; pages[TURN].classList.add("swap"); }
    chlMix = Math.min(1, chlMix + dt / 1100);
    if (page === TURN && !flight && pages[TURN].classList.contains("swap")) wallMelt = Math.min(1, wallMelt + dt / 2600);
    wallShow = c0wall > .35 ? Math.min(1, wallShow + dt / 2100) : Math.max(0, wallShow - dt / 600);
    if (page === TURN && !flight && wallMelt > .55) turnRise = Math.min(1, turnRise + dt / 2400);
    else if (page !== TURN && page !== LAST) turnRise = Math.max(0, turnRise - dt / 900);
    if (flight && flight.old === PROOF) { slabFirst = true; slabL = Math.max(0, slabL - dt / 420); }
    else if (!(flight && flight.next === PROOF)) slabL = Math.min(1, slabL + dt / (slabFirst ? 2100 : 1400));
    if (windowed) {
      viewLast = view;
      if (page === PROOF && !flight && slabL > .55 && !dragging) {
        tourT += dt;
        if (tourT > HOLD_A + GLIDE + HOLD_B && !tabbed) setShot((shot + 1) % shots.length);
      }
      if (!dragging && now - dragAt > 2600) userX *= Math.exp(-dt / 500);
      view = viewAt(shot, tourT);
      if (dragging) userX = view[0] - lerp(TOUR[shot][0][0], TOUR[shot][1][0], smooth(clamp((tourT - HOLD_A) / GLIDE, 0, 1)));
    }
    if (slabFirst && slabL >= 1) slabFirst = false;
    if (!world || !world.bake() || !world.ready) return;
    if (shown) adapt(rawDt, !!flight, introT >= 0 && introT < BAND.start + BAND.T); // not before BEAT is known: a 30 Hz screen would look late
    world.size(canvasDpr, share, shareCeil);
    if (!shown) {
      // On a quick machine the ignition's program is built first, so it can't stall the ending.
      // Anywhere else it waits until the journey is nearly there: it's as big as the whole scene.
      const film = html.classList.contains("film"); // a film has all the time in the world, and needs the ending
      if ((!mid && now - start < 900) || film) world.prepareIgnition();
      if (world.ignite && !world.igniteReady && (film || now - start < 2600)) return;
      calmBeats.push(rawDt);
      if (now - start < 650 || calmBeats.length < 10) return; // the loader is allowed to be seen
      if (world.outOfMemory) return giveUp("the graphics card ran out of memory");
      BEAT = clamp(calmBeats.sort((a, b) => a - b)[calmBeats.length >> 1], 1000 / 60, 34);
      world.warmIgnition();
      shown = true; html.classList.add("world-on");
      $("#loader")?.classList.add("done");
      if (page === 0) { html.classList.add("intro"); pages[0].classList.remove("on"); introT = 0; soon(now + (BAND.start + BAND.T * .72) * 1000, "touch"); soon(now + (BAND.start + BAND.T) * 1000, "close"); } else { introT = 9; closed = true; closedAt = now; }
    }
    judge(rawDt);
    if (closedAt >= 0 || flight) decode();
    if (page >= TURN || flight?.next >= TURN) { world.prepareIgnition(); if (!flight) world.warmIgnition(); }
    if (screensReady && (flight ? flight.next >= PROOF : page >= PROOF || (closedAt >= 0 && now - closedAt > 1500))) { screensReady = false; world.setScreens(shots, mid); }
    idle += ((flight ? 0 : 1) - idle) * (1 - Math.exp(-dt / 400));
    const c = evalAt(tl);
    c0wall = c.wall;
    // the intro: the knot comes up out of the sea
    let fade = 1, kY = KY, bandA = null, bandB = null, bandC = null, bandD = null, bandV = null, spin = 0;
    if (introT >= 0 && introT < 9) {
      introT += ds * (flight ? 3 : 1);
      fade = clamp(introT / .3, 0, 1);
      // Three bands sweep in from three sides. Each head runs on round its third of the
      // strand and reaches the next one's tail first; then the tails are drawn in behind them, thinning, and the
      // whole thing turns with it, like line coming onto a reel. Everything lands softly.
      const WAY = window.World.WAY, L3 = WAY.L3, x = clamp((introT - BAND.start) / BAND.T, 0, 1), hq = clamp(x / .72, 0, 1);
      const head = -BAND.far + (BAND.far + L3) * (1 - (1 - hq) ** 3), tail = WAY.len * .98 * (1 - smooth(x)), swell = .16 * (1 - smooth(clamp((x - .5) / .4, 0, 1)));
      const toEnd = smooth(clamp((x - .5) / .5, 0, 1)), R = .19 * (1 + swell), ang = Math.PI + Math.max(0, head) / L3 * 2 * Math.PI / 3;
      const hp = head < 0 ? WAY.at(WAY.tOf(-head)) : [.42 * (Math.sin(ang) + 2 * Math.sin(2 * ang)), .42 * (2 * Math.cos(2 * ang) - Math.cos(ang)), -.4 * Math.sin(3 * ang)];
      bandA = [clamp(head / L3, 0, 1), head, tail, swell];
      bandB = [x < 1 ? 1 : 0, lerp(.42, 1, toEnd), 1 - x, lerp(3.4, .3, toEnd)];
      bandC = [...hp, R];
      bandD = [WAY.tOf(Math.max(0, -head)), WAY.tOf(tail), .34 * smooth(clamp((hq - .62) / .3, 0, 1)) * (1 - smooth(clamp((x - .84) / .15, 0, 1))), smooth(clamp((x - .72) / .2, 0, 1))];
      bandV = [head - headWas, tailWas ? tailWas - tail : 0];
      headWas = head; tailWas = tail;
      spin = -BAND.spin * (1 - x) ** 2.4;
      // whichever band comes up out of the sea, the sea knows
      for (let i = 0; i < 3; i++) {
        const a = spin + i * 2 * Math.PI / 3, c = Math.cos(a), s = Math.sin(a), y0 = hp[1] - LIFT;
        const wx = hp[0] * c + y0 * s, wy = -hp[0] * s + y0 * c + kY, wet = wy < 0 ? 1 : 0;
        if (wet !== wetBand[i]) { if (!wet) world.drop(clamp(wx, -7, 7), hp[2], .9, .4); wetBand[i] = wet; }
      }
      if (x >= 1 && !closed) closeKnot(now);
      if (introT > BAND.start + BAND.T + .6) introT = 9;
    }
    // The closed knot rings a little: it grows from nothing, because it starts on the frame the bands end.
    settleWob = closedAt >= 0 ? (1 - Math.exp(-(now - closedAt) / 110)) * Math.exp(-(now - closedAt) / 520) * 1.5 : 0;
    if (closedAt >= 0 && page === 0 && !flight) titleQ = Math.min(1, titleQ + dt / 1100); else titleQ = Math.max(0, titleQ - dt / 240);
    kY += (c.ks - 1) * 1.45 + Math.sin(t * .7) * .035 * (1 - c.still);
    kx += (Pt.tx * .12 - kx) * .04; ky += (Pt.ty * .08 - ky) * .04;
    const sway = Math.sin(t * .31) * .05;
    const px = Pt.in ? Pt.tx : 0, py = Pt.in ? Pt.ty : 0, quiet = 1 - c.slab;
    const pos = [c.pos[0] + (px * .12 + Math.sin(t * .23) * .05) * idle * quiet, c.pos[1] + (-py * .06 + Math.sin(t * .17) * .025) * idle * quiet, c.pos[2]];
    // the drops: springs, so the active one slides out and settles
    for (let i = 0; i < 6; i++) { const goal = page === HOW && !flight && i === walkI ? 1 : 0, sub = dt / 1000; pullV[i] += ((goal - pull[i]) * 62 - pullV[i] * 11) * sub; pull[i] += pullV[i] * sub; }
    let reach = 0, topB = -9;
    const m = smooth(clamp(c.melt, 0, 1));
    for (let i = 0; i < 6; i++) {
      const b = beadPos(i, c, t, now), r = b[3], o = i * 4;
      beads[o] = b[0]; beads[o + 1] = b[1] - kY; beads[o + 2] = b[2]; beads[o + 3] = r;
      if (r > 0) reach = Math.max(reach, Math.hypot(beads[o], beads[o + 1], beads[o + 2]) + r + .25);
      topB = Math.max(topB, b[1] + r);
      // a drop going in or coming out of the sea splashes
      const under = b[1] - r * .4 < 0 ? 1 : 0, sx = clamp(b[0] / 5, -.8, .8);
      if (under !== wet[i]) { wet[i] = under; if (r > .02 && tl > 200) world.drop(b[0], b[2], .6, under ? .6 : .34); }
    }
    const melted = c.melt >= 1, bound = bandA && bandB[0] ? clamp(bandA[2] + 2.8, 2.4, 13) : Math.max(melted ? 0 : 1.85, reach);
    // the mirror's arrival, and the wall's
    if (c.slab > .1 && !rose) { rose = true; world.drop(slabAt.x, 0, 1.6, .9); } else if (c.slab < .05) rose = false;
    if (wallMelt > .2 && !wallDown) { wallDown = true; for (let i = 0; i < 4; i++) world.drop(i * 4 - 2, -2.6, 1, .5); } else if (wallMelt < .1) wallDown = false;
    if (lap % 3.2 > 2.35 && !lapped) { lapped = true; if (!melted) world.drop(0, 0, .55, .06); } else if (lap % 3.2 < 2.35) lapped = false;
    lap += ds;
    // the ignition, once, on arrival
    if (page === LAST && !flight && !ignited && world.igniteReady && now - arrived > 300) { ignition = 0; ignited = true; }
    // The lights go out, the comet runs, and the flash sends the day back out over the sea.
    let plasma = 0, nightGoal = 0;
    if (ignition >= 0) {
      ignition += ds;
      plasma = smooth(clamp((ignition - .2) / 1, 0, 1));
      // The lights go out, the comet runs, and at the flash the day comes straight back.
      nightGoal = ignition < 3 ? smooth(clamp((ignition - .1) / .8, 0, 1)) : 0;
      if (ignition >= 3 && flood < 0) { flood = 0; world.drop(0, 0, 1.6, 1.3); flash = 1; }
      if (ignition >= 3.18) ignition = -1;
    }
    let fl = 0, flR = 0;
    if (flood >= 0) {
      flood += ds;
      plasma = Math.max(plasma, clamp(1 - flood * 2.4, 0, 1));
      flR = flood * 17;
      fl = clamp(1 - (flood - 1.6) / 1, 0, 1);
      if (flood > 2.8) flood = -1;
    }
    night += (nightGoal - night) * (1 - Math.exp(-dt / 120));
    if (night < .002) night = 0;
    const isNight = night > .85; // where the room's grey crosses the middle, so the text is never lost
    if (isNight !== wasNight) { wasNight = isNight; html.classList.toggle("night", isNight); }
    if ((night > .01) !== wasDusk) { wasDusk = night > .01; html.classList.toggle("dusk", wasDusk); }
    flash *= Math.exp(-dt / 240);
    // magnets
    const pulse = 1 + .16 * Math.sin(t * 1.9);
    const seaHit = Pt.in && st ? world.ray(st, Pt.x, Pt.y) : null;
    if (seaHit && seaHit[2] < 34 && !flight && !c.slab) { magX = magOn < .02 ? seaHit[0] : lerp(magX, seaHit[0], .14); magZ = magOn < .02 ? seaHit[1] : lerp(magZ, seaHit[1], .14); magOn = lerp(magOn, 1, .06); } else magOn = lerp(magOn, 0, .05);
    mag[2] = 1.55; mag[3] = .62 * c.crown * pulse * clamp(kY / KY, 0, 1) * (1 - m); mag[4] = magX; mag[5] = magZ; mag[6] = 1.1; mag[7] = .44 * magOn + magKick;
    magKick *= .93;
    // the mirror leans to the pointer
    const overP = page === PROOF && !flight;
    slabYaw += ((overP ? px * .07 : 0) - slabYaw) * .06; slabPitch += ((overP ? py * .05 : 0) - slabPitch) * .06;
    const riseY = lerp(-slabAt.hh * 1.05 - .3, slabAt.y, smooth(clamp(c.slab, 0, 1)));
    const shown2 = c.slab > .002 ? 1 : 0;
    st = {
      time: t, pos, tgt: c.tgt, up: c.up, roll: c.roll, f: c.f, shift: c.shift, kpos: [0, kY, 0],
      krot: [c.kyaw + (1 - c.still) * (sway + kx), c.kpitch + (1 - c.still) * ky, spin], kscale: c.ks, mag, dark: night, dim: c.dim, paper: 1 - night, wave: c.wave, bulge: c.bulge * clamp(kY, 0, 1.6) / 1.6 * (1 - m),
      fade, bloom: lerp(c.bloom, 1, night), scrim: c.scrim, scrimX: c.sx, scrimW: c.sw, flood: fl, floodR: flR, lap, ignite: ignition, plasma,
      blend: probe ? 1 : ignition >= 0 || (flood >= 0 && flood < 1.6) ? .4 : flight || bandA ? .3 : .13, shutter: probe ? 0 : windowed && page === PROOF ? .14 : .3,
      krefl: c.krefl, flash, flashC: [1, 1, 1], field: [c.field, .42, c.fw], ground: GROUND.map((v) => v * (1 - night)), mono: 1 - shown2,
      kOn: c.melt >= 1 && topB < -.2 ? 0 : 1, melt: c.melt, fuse: c.melt, tube: lerp(.19, .38, m), wob: c.wob + settleWob, bandA: bandA ?? undefined, bandB: bandB ?? undefined, bandC: bandC ?? undefined, bandD: bandD ?? undefined, bandV: bandV ?? undefined,
      titleP: titled ? [((1 - titleQ) ** 3) * titleShift, smooth(clamp(titleQ * 2.2, 0, 1)), isP ? 1 - heroCy / innerHeight : .5, isP ? 1 : 0] : undefined, seaTop: .9 + c.bulge * (1 - m) + c.field * 1.06 + (mag[3] + mag[7]) * 1.15,
      menA: [slabAt.x, 0, slabAt.hw, .13 * smooth(clamp(c.slab * 1.4, 0, 1))], menB: [0, -3, 1e3, .1 * smooth(clamp(c.wall * 1.4, 0, 1)) * (1 - wallMelt)], beads, beadK: lerp(.26, .05, smooth(clamp((c.melt - .45) / .5, 0, 1))), bound,
      chlA: [...FIG[chlFrom], ...FIG[chlTo]], chlF: [smooth(chlMix), c.chl],
      slab: [slabAt.x, riseY, 0, slabYaw], slabB: [slabAt.hw, slabAt.hh, slabPitch, Math.min(slabAt.hw, slabAt.hh) * .07], slabC: [smooth(slabL), slabFirst ? 1 : 0, shown2, .05],
      rip: [ripUV[0], ripUV[1], t - ripAt, ripAmp], texOld: slabOld, texNew: slabNew,
      view0: windowed ? [viewOld[0] / APP[0], viewOld[1] / APP[1], vw * zoomOf(slabOld), vh * zoomOf(slabOld)] : undefined, view1: windowed ? [view[0] / APP[0], view[1] / APP[1], vw * zoomOf(slabNew), vh * zoomOf(slabNew)] : undefined,
      slabMv: windowed ? [(viewLast[0] - view[0]) / innerWidth, (view[1] - viewLast[1]) / innerHeight] : undefined, slabEdge: windowed ? 18 / boxW : 0,
      wall: [c.wall, smooth(clamp((wallMelt - .22) / .78, 0, 1)), -3, c.wall > .002 ? 1 : 0], wallB: [wallShow * (1 - smooth(clamp(wallMelt / .26, 0, 1))), 0],
    };
    world.frame(st);
    soundFrame(c, ds, pos, now, t);
    window.__world = world;
    if (grabs.length) {
      const gl = world.gl, w = world.CW, h = world.CH, buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      for (const r of grabs.splice(0)) r({ w, h, buf });
    }
    if (costs.length) {
      const gl = world.gl, px = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const ms = performance.now() - now;
      for (const r of costs.splice(0)) r(ms);
    }
  }
  const grabs = [], costs = [];
  // Where a drop is: from its place on the knot to its place by the words, then down into the sea.
  function beadPos(i, c = evalAt(tl), t = (performance.now() - start) / 1000, now = performance.now()) {
    const a = smooth(clamp(c.dropA * 1.5 - i * .1, 0, 1)), f = clamp(c.dropF * 1.75 - i * .15, 0, 1);
    const k = onKnot[i], g = column[i] ?? k;
    const out = [lerp(k[0], g[0], a), lerp(k[1], g[1], a) + Math.sin(a * Math.PI) * .9, lerp(k[2], g[2], a)];
    // The six let go one after another, so the strand doesn't snap all at once.
    const g2 = smooth(clamp(c.melt * 1.3 - [0, .22, .08, .3, .14, .26][i], 0, 1));
    let r = lerp(lerp(.9, .3, g2), columnR, a);
    if (a >= .99) {
      out[1] += Math.sin(t * 1.3 + i * 1.1) * .045 * (1 - c.dropF);
      if (portrait()) out[1] += pull[i] * .62; else out[0] -= pull[i] * 1.5;
      r *= 1 + (portrait() ? .36 : .26) * pull[i];
    }
    const rise = smooth(clamp(turnRise * 1.5 - i * .1, 0, 1));
    out[1] = lerp(out[1], -1.4, f * f * (1 - rise));
    if (rise > 0) {
      // Round the place the knot belongs, and in towards it as the journey ends.
      const ang = (i / 6) * Math.PI * 2 + t * .42, R = portrait() ? 1.3 : 1.75, mixR = rise * smooth(clamp(c.dropF, 0, 1));
      const ring = [R * Math.cos(ang), KY + .1 + R * Math.sin(ang) * .92, Math.sin(ang * 2 + i) * .3];
      out[0] = lerp(out[0], ring[0], mixR); out[1] = lerp(out[1], ring[1], mixR); out[2] = lerp(out[2], ring[2], mixR);
      r = lerp(r, r * 1.4, mixR);
    }
    return [out[0], out[1], out[2], r];
  }

  let seekT = null, probe = false;
  // The headline, in two halves either side of the knot, for the world to draw behind it.
  const titleCanvas = document.createElement("canvas");
  function drawTitle() {
    titled = true;
    html.classList.add("titled");
    const W = innerWidth, H = innerHeight, d = canvasDpr, c = titleCanvas, x = c.getContext("2d"), cx = W / 2, reach = heroR * 1.2;
    c.width = Math.round(W * d); c.height = Math.round(H * d);
    if (isP) {
      // On a phone it parts up and down: the first line above the knot, the last below it.
      const F = Math.min(W * .115, H * .054), lh = F * 1.04, up = heroR * 1.16;
      x.scale(d, d); x.font = `600 ${F}px Archivo, Helvetica, Arial, sans-serif`; try { x.letterSpacing = `${-.03 * F}px`; } catch {}
      x.fillStyle = "#000"; x.textBaseline = "middle"; x.textAlign = "center";
      ["It reads", "the real thing"].forEach((t, i) => x.fillText(t, cx, heroCy - up - (1.5 - i) * lh));
      x.fillText("before it draws.", cx, heroCy + up + lh * .5);
      titleShift = (up + lh * 2) / H;
      world?.setTitle(c);
      return;
    }
    const gut = parseFloat(getComputedStyle(pages[1]).paddingLeft) || 40, L = ["It reads", "the real thing"], R = ["before", "it draws."];
    x.scale(d, d); x.font = "600 100px Archivo, Helvetica, Arial, sans-serif";
    const wide = x.measureText(L[1]).width, F = Math.min((cx - reach - gut) / wide * 100, H * .1), lh = F * 1.04;
    x.font = `600 ${F}px Archivo, Helvetica, Arial, sans-serif`; try { x.letterSpacing = `${-.03 * F}px`; } catch {}
    x.fillStyle = "#000"; x.textBaseline = "middle";
    const y0 = heroCy - lh / 2;
    x.textAlign = "right"; L.forEach((t, i) => x.fillText(t, cx - reach, y0 + i * lh));
    x.textAlign = "left"; R.forEach((t, i) => x.fillText(t, cx + reach, y0 + i * lh));
    titleShift = (reach + wide * (F / 100) * .78) / W;
    world?.setTitle(c);
  }
  function layout() { fit(); build(); writeScore(); drawTitle(); canvasDpr = dprNow(); shareCeil = ceilNow(); share = Math.min(share, shareCeil); tl = anchor[page]; }
  layout();
  mark(0);
  requestAnimationFrame(frame);
  let settling = 0;
  addEventListener("resize", () => { clearTimeout(settling); settling = setTimeout(layout, 120); });
  // Turning a phone can cross the line between the journey and the plain page.
  const roomy = innerHeight >= 440;
  addEventListener("resize", () => { if ((innerHeight >= 440) !== roomy && !matchMedia("(prefers-reduced-motion: reduce)").matches) location.reload(); });
  K.font.then(layout);
  if (document.readyState === "complete") layout(); else addEventListener("load", layout);
  window.__page = { get score() { return SCORE; }, state: () => [Math.round(tl), page, flight ? 1 : 0, walkI, shot, html.classList.contains("night") ? 1 : 0, html.classList.contains("dusk") ? 1 : 0, pages[TURN].classList.contains("swap") ? 1 : 0, pages.findIndex((p) => p.classList.contains("on"))], grab: () => new Promise((r) => grabs.push(r)), cost: () => new Promise((r) => costs.push(r)), still: (v) => { probe = v; }, ease, seek: (x) => { seekT = x; }, lock: (v) => { share = v; locked = true; }, get share() { return share; }, ids: IDS, go: (id) => go(IDS.indexOf(id)), jump: (id) => go(IDS.indexOf(id), true), get page() { return page; }, get flying() { return !!flight; }, get tl() { return tl; }, get stops() { return stops; }, get anchor() { return anchor; }, evalAt };
  const hash = location.hash.slice(1);
  if (IDS.includes(hash) && hash !== "top") go(IDS.indexOf(hash), true);
  K.started = true;
})();
