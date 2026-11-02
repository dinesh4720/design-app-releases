// world.js — the page's one 3D world in a single WebGL2 canvas: a white studio, a
// sea of liquid silver and the app's knot. Built for smoothness:
//
//   · The knot's shape is baked once into a 3D texture (distance to the strand, and
//     where along it), so a marching step is one texture read. Melting is the smooth
//     overlap of that field and a chain of closing spheres, both continuous everywhere,
//     so the strand can neck, pinch off and round up with nothing to tear or switch.
//   · The studio is baked once into a mipmapped cubemap. Every reflection reads it at
//     a blur matched to how much of the room one pixel of curved metal sees, so metal
//     has no hard edges and nothing shimmers.
//   · Frames accumulate: each one is jittered and reprojected through the camera into
//     a history at the screen's own resolution, so edges stay soft and steady in
//     motion, a still picture sharpens by itself, and the scene can draw fewer pixels
//     than the screen has. Motion blur comes from the same reprojection.
//   · The scene draws into part of a fixed target, so resolution can change every
//     frame without reallocating anything.
//
// Passes: sea simulation → the sea's height baked into a texture → scene (colour, and how
// far each point moved) → resolve into history → bloom → composite (motion blur, tone,
// grain). The sim is a real wave equation on a square of sea round the knot: a drop
// anywhere rings out, crosses others and dies away. The height bake is what lets a ray
// cross a field of spikes one texel a step, and read a smooth slope back from it.
//
//   const w = new World(canvas);     w.ok is false without what it needs
//   await-free: w.bake() a slice at a time, until w.baked
//   w.size(dpr, share, ceil)         canvas pixels per CSS px; share of them to draw now; most it may ever draw
//   w.gpuMs                          how long the last frame took the GPU, where it can say
//   w.frame(state)                   see the fields read in frame()
//   w.drop(x, z, radius, strength)   a drop on the sea (world units)
//   w.ray(state, cssX, cssY)         the sea point under a screen point

(() => {
  "use strict";
  const VERT = `#version 300 es
in vec2 a; void main() { gl_Position = vec4(a, 0., 1.); }`;
  const VERT_UV = `#version 300 es
in vec2 a; out vec2 v; void main() { v = a * .5 + .5; gl_Position = vec4(a, 0., 1.); }`;

  // The knot's geometry, as the mark's shader defines it.
  const SHAPE = { S: .42, H: .4, LIFT: (3 - 2.0625) / 2 * .42, B: 2 };

  // The way in: one long curve that leaves the strand along the strand's own tangent and sweeps
  // out of the frame. The other two are this one turned by a third. Distance along it is a
  // cubic of the curve's parameter, right at both ends, so the shader and the page agree.
  const WAY = (() => {
    const P = [[0, 1.26, 0], [-2.3, 1.26, -2.2], [-6.6, -8.2, -1]];
    const at = (t) => [0, 1, 2].map((i) => (1 - t) ** 2 * P[0][i] + 2 * t * (1 - t) * P[1][i] + t * t * P[2][i]);
    let len = 0;
    for (let i = 1, a = at(0); i <= 256; i++) { const b = at(i / 256); len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); a = b; }
    const v0 = 2 * Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]), v1 = 2 * Math.hypot(P[2][0] - P[1][0], P[2][1] - P[1][1], P[2][2] - P[1][2]);
    const C = [v0, 3 * len - 2 * v0 - v1, v1 + v0 - 2 * len];
    const wOf = (t) => t * (C[0] + t * (C[1] + t * C[2]));
    const tOf = (w) => { let a = 0, b = 1; for (let i = 0; i < 26; i++) { const m = (a + b) / 2; if (wOf(m) < w) a = m; else b = m; } return (a + b) / 2; };
    // The curve stays within this of the two straight pieces through its middle, tremble and all.
    const M = at(.5), off = (q, a, b) => { const ab = b.map((v, i) => v - a[i]), aq = q.map((v, i) => v - a[i]), k = Math.min(1, Math.max(0, ab.reduce((s, v, i) => s + v * aq[i], 0) / ab.reduce((s, v) => s + v * v, 0))); return Math.hypot(...aq.map((v, i) => v - ab[i] * k)); };
    let hull = 0;
    for (let i = 0; i <= 64; i++) { const t = i / 64; hull = Math.max(hull, t < .5 ? off(at(t), P[0], M) : off(at(t), M, P[2])); }
    return { P, C, M, hull: hull + .46, len, at, wOf, tOf, L3: 3.996 };
  })();

  // Distance to the strand's centre line, and where along it, for one slice of the volume.
  const BAKE_SDF = `#version 300 es
precision highp float;
uniform float u_z, u_n; out vec4 o;
#define TAU 6.28318530718
#define PI 3.14159265359
const float S = ${SHAPE.S.toFixed(5)}, H = ${SHAPE.H.toFixed(5)}, LIFT = ${SHAPE.LIFT.toFixed(5)}, B = ${SHAPE.B.toFixed(5)};
vec3 C(float t) { return vec3(S * (sin(t) + 2. * sin(2. * t)), S * (2. * cos(2. * t) - cos(t)), -H * sin(3. * t)); }
void main() {
  vec3 p = (vec3(gl_FragCoord.xy, u_z + .5) / u_n * 2. - 1.) * B, q = p + vec3(0., LIFT, 0.);
  float best = 1e9, t = 0.;
  for (int i = 0; i < 72; i++) { float x = float(i) / 72. * TAU; vec3 e = C(x) - q; float d = dot(e, e); if (d < best) { best = d; t = x; } }
  for (int i = 0; i < 6; i++) {
    float s1 = sin(t), c1 = cos(t), s2 = sin(2. * t), c2 = cos(2. * t), s3 = sin(3. * t), c3 = cos(3. * t);
    vec3 r = vec3(S * (s1 + 2. * s2), S * (2. * c2 - c1), -H * s3) - q;
    vec3 d1 = vec3(S * (c1 + 4. * c2), S * (s1 - 4. * s2), -3. * H * c3);
    vec3 d2 = vec3(-S * (s1 + 8. * s2), S * (c1 - 8. * c2), 9. * H * s3);
    t += clamp(-dot(r, d1) / max(dot(d1, d1) + dot(r, d2), .5), -.3, .3);
  }
  float a = t - PI;
  o = vec4(length(C(t) - q), cos(a), sin(a), 1.);
}`;

  // The studio. Nothing here has an edge: a white cyclorama, a dark band round the
  // horizon, big black flags that lay the long dark curves down the metal, and soft
  // lights. All gaussians.
  const BAKE_ENV = `#version 300 es
precision highp float;
uniform mat3 u_face; uniform float u_s, u_crisp; out vec4 o;
#define TAU 6.28318530718
#define PI 3.14159265359
// A light's edge: soft in the room small metal sees, defined in the room big metal sees,
// where a surface magnifies whatever it reflects.
float gauss(float x, float w) { return mix(exp(-x * x / (w * w)), exp(-pow(abs(x / w), 4.)), u_crisp); }
float wrapA(float a) { return mod(a + PI, TAU) - PI; }
void main() {
  vec2 uv = gl_FragCoord.xy / u_s * 2. - 1.;
  vec3 r = normalize(u_face * vec3(uv, 1.));
  float az = atan(r.x, r.z), el = asin(clamp(r.y, -1., 1.));
  // The horizon wanders and leans, so that on a sphere it is a form and not a drawn line.
  float hz = el + .04 + .12 * r.x + .075 * sin(az * 2. + 1.) + .04 * sin(az * 5. + 2.);
  float v = mix(.14, 1.1, smoothstep(-1., .9, el));
  v *= 1. - .9 * gauss(hz, .21);
  v += .34 * gauss(hz - .2, .09);
  v *= 1. - .84 * gauss(wrapA(az - 2.), .42) * gauss(el - .15, .85);
  v *= 1. - .76 * gauss(wrapA(az + 1.75), .34) * gauss(el, .8);
  v *= 1. - .6 * gauss(wrapA(az - .35), .14) * gauss(el - .3, .55);
  v *= 1. - .72 * smoothstep(.4, 1., el) * gauss(sin(r.x / max(r.y, .3) * 3.1 + .4), .55);
  v += 2.2 * gauss(wrapA(az + .5), .46) * gauss(el - .6, .24);
  v += 1.5 * gauss(wrapA(az - 1.05), .1) * gauss(el - .1, .75);
  v += 1.1 * gauss(wrapA(az + 2.45), .08) * gauss(el - .2, .65);
  if (u_crisp > .5) {
    // A little more to see in it: one tall bright window and one deep flag.
    v = mix(v, 2.2, gauss(wrapA(az - 2.75), .3) * gauss(el - .34, .42));
    v *= 1. - .9 * gauss(wrapA(az + .95), .16) * gauss(el - .2, .9);
    v *= mix(.45, 1., smoothstep(-.42, -.08, el));
  }
  o = vec4(vec3(v), 1.);
}`;

  // The big slow waves, which the scene needs beyond the baked square as well.
  const SEA0 = `
float seaWaves(vec2 q) {
  float T = u_time;
  vec2 w = q + .8 * vec2(sin(q.y * .21 + T * .1), sin(q.x * .17 - T * .08));
  return u_wave * (.11 * sin(dot(w, vec2(.8, .6)) * TAU / 11. + T * .32) + .07 * sin(dot(w, vec2(-.64, .77)) * TAU / 7.3 + T * .41) + .035 * sin(dot(w, vec2(.28, -.96)) * TAU / 4.6 + T * .55));
}
`;
  // The spikes, which only the pass that bakes the sea's height works out.
  const SEA = `
uniform vec4 u_mag[2];
uniform vec3 u_field; // height, lattice scale, width of a column
uniform vec4 u_chlA; uniform vec2 u_chlF; // two figures (n, m, n, m); how far from one to the other, how strongly
float spike(float x) { x = clamp(1. - x * x, 0., 1.); return x * x * (3. - 2. * x); }
float ferroCell(vec2 q) {
  vec2 p = q * 1.5 + vec2(sin(q.y * 1.3 + 1.) * .5, sin(q.x * 1.1 + 2.) * .5);
  const vec2 r = vec2(1., 1.7320508), hh = r * .5;
  vec2 a = mod(p, r) - hh, b = mod(p - hh, r) - hh;
  float da = dot(a, a), db = dot(b, b);
  vec2 id = da < db ? floor(p / r) * 2. : floor((p - hh) / r) * 2. + 1.;
  float k = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
  return spike(sqrt(min(da, db)) / .5) * (.3 + .7 * k) * (.8 + .2 * sin(u_time * 1.1 + k * 40.));
}
float magField(vec2 q) {
  float e = 0.;
  for (int i = 0; i < 2; i++) { vec2 d = q - u_mag[i].xy; e += u_mag[i].w * exp(-dot(d, d) / (u_mag[i].z * u_mag[i].z)); }
  return e;
}
float chladni(vec2 q, float n, float m) { vec2 x = q * PI / 7.; return cos(n * x.x) * cos(m * x.y) - cos(m * x.x) * cos(n * x.y); }
vec2 fieldWarp(vec2 q) { return q + .3 * vec2(sin(q.y * .6 + 1.), sin(q.x * .55 + 2.)); }
float fieldCell(vec2 q) {
  q = fieldWarp(q);
  float rr = length(q) * u_field.y, ring = floor(rr), n = max(3., floor((ring + .5) * TAU * .86));
  float ang = atan(q.x, q.y) / TAU + .5, cell = (fract(ang * n + ring * .37) - .5) * (ring + .5) * TAU / n;
  float k = fract(sin((floor(ang * n + ring * .37) + ring * 17.) * 12.9898) * 43758.5453);
  return spike(length(vec2(rr - ring - .5, cell)) / (.48 * u_field.z)) * mix(1., .5 + .5 * k, 1. - u_chlF.y);
}
// How far a ray can go sideways from here before anything can stand in its way.
float clearAt(vec2 q) {
  float c = 9.;
  if (u_field.x > .01) {
    vec2 w = fieldWarp(q);
    float rr = length(w) * u_field.y, ring = floor(rr), n = max(3., floor((ring + .5) * TAU * .86));
    float ang = atan(w.x, w.y) / TAU + .5, cell = (fract(ang * n + ring * .37) - .5) * (ring + .5) * TAU / n, x = length(vec2(rr - ring - .5, cell));
    c = max(min(x, 1. - x) - .48 * u_field.z, 0.) / u_field.y;
  }
  for (int i = 0; i < 2; i++) { vec4 m = u_mag[i]; if (m.w > .01) c = min(c, max(length(q - m.xy) - m.z * 1.9, 0.)); }
  return c;
}
float ferro(vec2 q) {
  // Where the field runs out it fades: even a hair's step in a mirror tears what it shows.
  float e = magField(q), k = smoothstep(.0001, .02, e), h = k > 0. ? k * k * e * (.12 + ferroCell(q)) : 0.;
  if (u_field.x <= .01) return h;
  float c = fieldCell(q);
  if (u_chlF.y > .001) {
    float ch = mix(chladni(q, u_chlA.x, u_chlA.y), chladni(q, u_chlA.z, u_chlA.w), u_chlF.x);
    c *= mix(1., smoothstep(.5, .06, abs(ch)), u_chlF.y);
  }
  return h + u_field.x * c * smoothstep(23., 17., length(q));
}
// The simulated sea, read through a cubic: its grid is coarse, and a mirror shows every kink.
vec4 simSmooth(vec2 uv) {
  const float N = 256.;
  vec2 st = uv * N - .5, i = floor(st), f = st - i, f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1. - f) * (1. - f) * (1. - f) / 6., w1 = (4. - 6. * f2 + 3. * f3) / 6., w3 = f3 / 6., w2 = 1. - w0 - w1 - w3;
  vec2 g0 = w0 + w1, g1 = w2 + w3, h0 = (i + w1 / g0 - .5) / N, h1 = (i + 1.5 + w3 / g1) / N;
  return (textureLod(u_sim, vec2(h0.x, h0.y), 0.) * g0.x + textureLod(u_sim, vec2(h1.x, h0.y), 0.) * g1.x) * g0.y + (textureLod(u_sim, vec2(h0.x, h1.y), 0.) * g0.x + textureLod(u_sim, vec2(h1.x, h1.y), 0.) * g1.x) * g1.y;
}
uniform vec4 u_menA, u_menB; // where the sea climbs something standing in it: centre x, z, half length, height
float climb(vec2 q, vec4 m) {
  if (m.w == 0.) return 0.;
  vec2 d = vec2(max(abs(q.x - m.x) - m.z, 0.), q.y - m.y);
  return m.w * exp(-dot(d, d) / .42) * (.72 + .28 * sin(q.x * .8 + u_time * .5));
}
float seaH(vec2 q) {
  vec2 kq = q - u_kpos.xz, uv = q / u_simL + .5;
  float h = seaWaves(q) + u_bulge * exp(-dot(kq, kq) / 2.6) + climb(q, u_menA) + climb(q, u_menB);
  vec2 edge = min(uv, 1. - uv);
  if (edge.x > .01 && edge.y > .01) h += simSmooth(uv).r * smoothstep(.01, .16, min(edge.x, edge.y));
  return h + ferro(q);
}
`;

  const WORLD = `
precision highp sampler3D; precision highp samplerCube;
uniform samplerCube u_envC;
const float B = ${SHAPE.B.toFixed(5)}, TUBE = .19, LIFT0 = ${SHAPE.LIFT.toFixed(5)}, KS0 = ${SHAPE.S.toFixed(5)}, KH0 = ${SHAPE.H.toFixed(5)}, ENV_T = .00307, LOD0 = 2.6;
uniform vec3 u_pos; uniform mat3 u_cam; uniform float u_f; uniform vec2 u_shift, u_jit;
uniform vec3 u_kpos; uniform mat3 u_krot; uniform float u_kscale, u_krefl;
uniform vec3 u_ppos, u_kposP; uniform mat3 u_pcam, u_krotP; uniform float u_pf, u_aspect; uniform vec2 u_pshift; // the same, one frame ago
uniform sampler3D u_sdf; uniform samplerCube u_env;
uniform float u_wave, u_bulge, u_flood, u_floodR;
uniform float u_fuse, u_wob, u_bound, u_beadK, u_tubeOn, u_stepK, u_tube, u_kOn;
uniform vec4 u_bead[6];

// ---- the knot ----
float beads(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < 6; i++) { vec4 b = u_bead[i]; if (b.w > 0.) d = smin(d, length(p - b.xyz) - b.w, u_beadK); }
  return d;
}
// A slow tremble, worked out from where a point is, so it is the same on both sides of
// the line where one strand stops being the nearest and another starts.
float wobF(vec3 p) { return sin(p.x * 3.1 + p.z * 2.3 + u_time * 2.4) * sin(p.y * 3.7 - p.z * 1.9 - u_time * 1.3); }
vec3 wobG(vec3 p) {
  float a = p.x * 3.1 + p.z * 2.3 + u_time * 2.4, b = p.y * 3.7 - p.z * 1.9 - u_time * 1.3, sa = sin(a), ca = cos(a), sb = sin(b), cb = cos(b);
  return vec3(3.1 * ca * sb, 3.7 * sa * cb, 2.3 * ca * sb - 1.9 * sa * cb);
}
// The melt: the strand fattens while a chain of spheres closes in round it, and the shape
// is the smooth overlap of the two. Both fields are continuous everywhere, so it can't tear,
// and where the chain lets go the strand ends in a piece of sphere: a round end, not a point.
float strand(vec3 p) {
  vec3 c = clamp(p, -B, B);
  float d = textureLod(u_sdf, c / (2. * B) + .5, 0.).r + length(p - c) - u_tube;
  return u_wob > 0. ? d - u_wob * .03 * wobF(p) : d;
}
// The way in. Three bands, a third of the strand each, slide in along their own lines and run
// on round the knot, each head closing on the next one's tail. One line is worked out and
// the other two are it turned by a third: the knot has that symmetry, so it costs almost nothing.
uniform vec4 u_bandA, u_bandB, u_bandC, u_bandD; // head round its third (0..1), head along the band, tail back along the way in, swell of the head · on, thinness of the tail, tremble, length of the taper · the head's centre and size · head and tail on the curve, how soft the place where a head meets the next tail
uniform vec2 u_bandV; // how far the head and the tail moved since the last frame
const float L3 = ${WAY.L3.toFixed(5)};
const vec3 WAY0 = vec3(${WAY.P[0].map((v) => v.toFixed(5)).join(",")}), WAY1 = vec3(${WAY.P[1].map((v) => v.toFixed(5)).join(",")}), WAY2 = vec3(${WAY.P[2].map((v) => v.toFixed(5)).join(",")}), WAYC = vec3(${WAY.C.map((v) => v.toFixed(5)).join(",")});
const vec3 WAYM = vec3(${WAY.M.map((v) => v.toFixed(5)).join(",")});
const mat2 R120 = mat2(-.5, .8660254, -.8660254, -.5);
vec3 gWayTan; float gWayAt;
// A band's thickness at a place along it: thin at the tail, full behind the head.
float bandR(float at) {
  float h = (u_bandA.y - at) / .9;
  return TUBE * (mix(u_bandB.y, 1., smoothstep(0., u_bandB.w, at + u_bandA.z)) + u_bandA.w * exp(-h * h));
}
float wayIn(vec3 q) {
  vec3 a = WAY1 - WAY0, b = WAY0 - 2. * WAY1 + WAY2, e = 2. * a, d = WAY0 - q;
  float kk = 1. / dot(b, b), kx = kk * dot(a, b), ky = kk * (2. * dot(a, a) + dot(d, b)) / 3., kz = kk * dot(d, a);
  float pp = ky - kx * kx, g = kx * (2. * kx * kx - 3. * ky) + kz, h = g * g + 4. * pp * pp * pp, t;
  if (h >= 0.) {
    h = sqrt(h);
    vec2 x = (vec2(h, -h) - g) / 2., r = sign(x) * pow(abs(x), vec2(1. / 3.));
    t = r.x + r.y - kx;
  } else {
    float z = sqrt(-pp), v = acos(clamp(g / (pp * z * 2.), -1., 1.)) / 3., m = cos(v), n = sin(v) * 1.732050808;
    vec2 ts = clamp(vec2(m + m, -n - m) * z - kx, 0., 1.);
    vec3 da = d + (e + b * ts.x) * ts.x, db = d + (e + b * ts.y) * ts.y;
    t = dot(da, da) < dot(db, db) ? ts.x : ts.y;
  }
  t = clamp(t, u_bandD.x, u_bandD.y);
  float w = t * (WAYC.x + t * (WAYC.y + t * WAYC.z)), f = u_bandB.z * smoothstep(.3, 2.5, w);
  vec3 c = WAY0 + (e + b * t) * t;
  c.y += f * .17 * sin(w * 1.5 - u_time * 6.5);
  c.z += f * .12 * sin(w * 1.1 - u_time * 5. + 1.);
  gWayTan = e + 2. * b * t; gWayAt = -w;
  return length(q - c) - bandR(-w);
}
// Most rays are nowhere near most of the curves, and the two straight pieces say so cheaply.
float hullTo(vec3 a, vec3 b) { return length(a - b * clamp(dot(a, b) / dot(b, b), 0., 1.)); }
float wayNear(vec3 q) {
  float h = min(hullTo(q - WAY0, WAYM - WAY0), hullTo(q - WAYM, WAY2 - WAYM)) - ${WAY.hull.toFixed(5)};
  return h > .5 ? h : wayIn(q);
}
float bandLines(vec3 p) {
  vec3 q = p + vec3(0., LIFT0, 0.);
  float l = wayNear(q), m;
  vec3 tan0 = gWayTan; float at = gWayAt;
  q.xy = q.xy * R120; m = wayNear(q);
  if (m < l) { l = m; tan0 = vec3(R120 * gWayTan.xy, gWayTan.z); at = gWayAt; }
  q.xy = q.xy * R120; m = wayNear(q);
  if (m < l) { l = m; tan0 = vec3(R120 * (R120 * gWayTan.xy), gWayTan.z); at = gWayAt; }
  gWayTan = tan0; gWayAt = at;
  return l;
}
vec3 nearestHead(vec3 q) {
  vec3 a = u_bandC.xyz, b = vec3(R120 * a.xy, a.z), c = vec3(R120 * b.xy, a.z);
  float da = dot(q - a, q - a), db = dot(q - b, q - b), dc = dot(q - c, q - c);
  return da < db ? (da < dc ? a : c) : (db < dc ? b : c);
}
// x, y: the first and second half of each third of the strand. z: the ways in. w: the heads.
// Each way in runs straight on from the start of its third at the same thickness, so the two
// are one tube; only the end of one band and the start of the next ever melt together.
// Past a head the strand isn't there yet, but the distance to it still holds rays back,
// so one can't step through a strand that is.
vec4 bandParts(vec3 p) {
  vec4 o = vec4(1e3);
  if (u_bandA.x > 0.) {
    vec3 c = clamp(p, -B, B), q = p + vec3(0., LIFT0, 0.);
    vec4 s = textureLod(u_sdf, c / (2. * B) + .5, 0.);
    float u = fract(atan(s.b, s.g) / TAU * 3.), d = s.r + length(p - c) - bandR(u * L3);
    if (u > u_bandA.x) d = max(d, .2);
    if (u < .5) o.x = d; else o.y = d;
    o.w = length(q - nearestHead(q)) - u_bandC.w;
  }
  if (u_bandD.y > u_bandD.x) o.z = bandLines(p);
  return o;
}
float bands(vec3 p) {
  vec4 o = bandParts(p);
  float a = min(o.x, o.z), b = min(o.y, o.w);
  return u_bandD.z > .001 ? smin(a, b, u_bandD.z) : min(a, b);
}
float sd(vec3 p) {
  if (u_bandB.x > .5) return bands(p);
  if (u_tubeOn < .5) return beads(p);
  return u_fuse > 0. ? smax(strand(p), beads(p), .09) : strand(p);
}
float gMinT, gMinD;
float traceK(vec3 o, vec3 d, float px, int steps) {
  gMinD = 1e9; gMinT = -1.;
  if (u_kOn < .5) return -1.;
  float b = dot(o, d), c = dot(o, o) - u_bound * u_bound, h = b * b - c;
  if (h < 0.) return -1.;
  h = sqrt(h);
  float t = max(0., -b - h), t1 = -b + h;
  if (t1 < 0.) return -1.;
  for (int i = 0; i < steps; i++) {
    float dd = sd(o + d * t), e = px * max(t, .25);
    if (dd < e * .5) return t;
    if (dd / e < gMinD) { gMinD = dd / e; gMinT = t; }
    t += dd * u_stepK;
    if (t > t1) break;
  }
  return -1.;
}
vec3 beadNormal(vec3 p) {
  vec2 k = vec2(1., -1.); const float e = .002;
  return normalize(k.xyy * beads(p + k.xyy * e) + k.yyx * beads(p + k.yyx * e) + k.yxy * beads(p + k.yxy * e) + k.xxx * beads(p + k.xxx * e));
}
// The surface at p, exactly: the closest point on the strand, not a difference of
// samples, so a mirror never shows the volume's grid.
vec3 onStrand(vec3 p, out vec3 d1, out float t) {
  vec3 c = clamp(p, -B, B), q = p + vec3(0., LIFT0, 0.), cc;
  int N = textureSize(u_sdf, 0).x;
  vec4 s = texelFetch(u_sdf, clamp(ivec3((c / (2. * B) + .5) * float(N)), ivec3(0), ivec3(N - 1)), 0);
  float s1, c1, s2, c2, s3, c3;
  t = atan(s.b, s.g) + PI;
  for (int i = 0; i < 2; i++) {
    s1 = sin(t); c1 = cos(t); s2 = sin(2. * t); c2 = cos(2. * t); s3 = sin(3. * t); c3 = cos(3. * t);
    cc = vec3(KS0 * (s1 + 2. * s2), KS0 * (2. * c2 - c1), -KH0 * s3);
    d1 = vec3(KS0 * (c1 + 4. * c2), KS0 * (s1 - 4. * s2), -3. * KH0 * c3);
    vec3 d2 = vec3(-KS0 * (s1 + 8. * s2), KS0 * (c1 - 8. * c2), 9. * KH0 * s3), r = cc - q;
    t += clamp(-dot(r, d1) / max(dot(d1, d1) + dot(r, d2), .5), -.3, .3);
  }
  s1 = sin(t); c1 = cos(t); s2 = sin(2. * t); c2 = cos(2. * t); s3 = sin(3. * t);
  return vec3(KS0 * (s1 + 2. * s2), KS0 * (2. * c2 - c1), -KH0 * s3);
}
// A band's surface, each part from its own exact shape: the numbers read from the volume are
// good for finding it, but a mirror would show their grid.
vec3 bandNormal(vec3 p) {
  vec4 o = bandParts(p);
  float a = min(o.x, o.z), b = min(o.y, o.w), k = u_bandD.z, t, e = .02;
  vec3 q = p + vec3(0., LIFT0, 0.), d1, nt = vec3(0., 1., 0.);
  if (u_bandA.x > 0.) {
    vec3 cc = onStrand(p, d1, t);
    float at = fract((t - PI) / TAU * 3.) * L3;
    nt = normalize(normalize(q - cc) - normalize(d1) * (bandR(at + e) - bandR(at - e)) / (2. * e));
  }
  vec3 na = nt, nb = nt;
  if (o.z < o.x) {
    const vec2 s = vec2(1., -1.); const float h = .012;
    na = normalize(s.xyy * bandLines(p + s.xyy * h) + s.yyx * bandLines(p + s.yyx * h) + s.yxy * bandLines(p + s.yxy * h) + s.xxx * bandLines(p + s.xxx * h));
  }
  if (o.w < o.y) nb = normalize(q - nearestHead(q));
  float h = k > .001 ? max(k - abs(a - b), 0.) / k * .5 : 0.;
  return normalize(a < b ? mix(na, nb, h) : mix(nb, na, h));
}
// How far the metal here moved since the last frame: the head's pace at the head, the tail's at the tail.
vec3 bandFlow(vec3 p) {
  vec4 o = bandParts(p);
  float at, t; vec3 dir, d1;
  if (o.z < min(o.x, o.y)) { dir = -normalize(gWayTan); at = gWayAt; }
  else { onStrand(p, d1, t); dir = d1 * (TAU / 3. / L3); at = fract((t - PI) / TAU * 3.) * L3; }
  return dir * mix(u_bandV.y, u_bandV.x, clamp((at + u_bandA.z) / max(u_bandA.y + u_bandA.z, .01), 0., 1.));
}
void surfaceAt(vec3 p, out vec3 n, out float rad) {
  if (u_bandB.x > .5) { n = bandNormal(p); rad = TUBE; return; }
  vec3 nb = vec3(0., 1., 0.);
  float f = u_tubeOn < .5 ? 1. : 0.;
  if (f < 1. && u_fuse > 0.) {
    // How much each field has a say here, from the smooth overlap itself.
    float a = strand(p), b = beads(p), h = max(.09 - abs(a - b), 0.) / .09;
    f = a > b ? h * .5 : 1. - h * .5;
  }
  if (f > 0.) nb = beadNormal(p);
  if (f >= 1.) { n = nb; rad = .3; return; }
  vec3 d1; float t;
  vec3 cc = onStrand(p, d1, t), nt = normalize(p + vec3(0., LIFT0, 0.) - cc);
  if (u_wob > 0.) nt = normalize(nt - u_wob * .03 * wobG(p));
  n = f > 0. ? normalize(mix(nt, nb, f)) : nt;
  rad = mix(TUBE, .3, f);
}
float occK(vec3 p, vec3 n) {
  float o = 0., w = 1.;
  for (int i = 1; i <= 3; i++) { float h = .06 + .13 * float(i); o += (h - sd(p + n * h)) * w; w *= .6; }
  return clamp(1. - 1.3 * o, 0., 1.);
}
// Where one strand faces another it darkens softly, never with a hard image.
float seeOther(vec3 o, vec3 d, float cone, out float at) {
  float near = 1., t = .03;
  at = -1.;
  for (int i = 0; i < 18; i++) {
    float h = sd(o + d * t), q = h / (cone * t + .004);
    if (q < near) { near = q; at = t; }
    if (h < .002) { near = 0.; at = t; break; }
    t += h;
    if (t > 3.2) break;
  }
  near = clamp(near, 0., 1.);
  return near * near * (3. - 2. * near);
}
float gLit = 0.; // how far the wave of light has reached, at this point of the sea
vec3 env(vec3 r, float lod) { return textureLod(u_env, r, lod).rgb * mix(1., .05, u_dark * (1. - gLit)); }
vec3 envC(vec3 r, float lod) { return textureLod(u_envC, r, lod).rgb * mix(1., .05, u_dark * (1. - gLit)); }
vec3 knotColor(vec3 ro, vec3 rd, float t, float px, bool full) {
  mat3 toW = transpose(u_krot);
  vec3 p = ro + rd * t, nn; float rad;
  surfaceAt(p, nn, rad);
  vec3 r = reflect(rd, nn);
  float ndv = clamp(dot(nn, -rd), 0., 1.);
  vec3 F = F0 + (1. - F0) * pow(1. - ndv, 5.);
  float spread = 2. * px * t / rad / max(ndv, .14);
  vec3 col = env(toW * r, clamp(log2(spread / ENV_T), LOD0, 7.));
  float others = u_bandB.x > .5 ? u_bandD.w : 1.; // the bands are too quick to need this, until they slow down
  if (full && others > 0.) {
    // Where a strand faces another it shows that strand, with the room in it: a real ray,
    // followed until it lands, so the reflection is as continuous as the metal.
    float at, vis = seeOther(p + nn * .01, r, .03 + spread, at);
    if (vis < .995 && at > 0.) {
      vec3 n2; float r2;
      surfaceAt(p + nn * .01 + r * at, n2, r2);
      col = mix(env(toW * reflect(r, n2), 4.) * .82, col, mix(1., vis, others));
    }
  }
  col *= F * mix(.55, 1., occK(p, nn));
  if (u_plasma > .005) {
    // White-hot, it is still a tube: brightest facing you, falling away round its sides.
    vec4 e1 = emit(p, nn, F) * u_plasma;
    float form = .3 + .7 * pow(ndv, .8);
    col = col * (1. - e1.a * .8) + e1.rgb * form * .62;
  }
  return col;
}

// ---- the sea ----
// Ferrofluid: under a magnet the liquid stands up in a lattice of spikes.
// u_mag[i]: x, z, radius, height. [0] is the knot, [1] is the pointer.
uniform vec4 u_mag[2];
uniform vec3 u_field;
${SEA0}
uniform sampler2D u_hmap; uniform float u_hL, u_hN;
float seaAt(vec2 q) {
  vec2 uv = q / u_hL + .5;
  if (uv.x > 0. && uv.x < 1. && uv.y > 0. && uv.y < 1.) return textureLod(u_hmap, uv, 0.).r;
  return seaWaves(q);
}
// The slope of the baked sea, read through a cubic, so a mirror never shows its texels.
vec2 hmapGrad(vec2 uv) {
  float N = u_hN;
  vec2 st = uv * N - .5, i = floor(st), f = st - i, f2 = f * f, f3 = f2 * f, o = 1. - f;
  vec2 w0 = o * o * o / 6., w1 = (4. - 6. * f2 + 3. * f3) / 6., w3 = f3 / 6., w2 = 1. - w0 - w1 - w3;
  vec2 d0 = -o * o * .5, d1 = f * (3. * f - 4.) * .5, d3 = f2 * .5, d2 = -d0 - d1 - d3;
  vec2 g0 = w0 + w1, g1 = w2 + w3, h0 = (i + w1 / g0 - .5) / N, h1 = (i + 1.5 + w3 / g1) / N;
  vec2 e0 = d0 + d1, e1 = d2 + d3, k0 = (i + d1 / e0 - .5) / N, k1 = (i + 1.5 + d3 / e1) / N;
  #define HT(a, b) textureLod(u_hmap, vec2(a, b), 0.).r
  float x = (HT(k0.x, h0.y) * e0.x + HT(k1.x, h0.y) * e1.x) * g0.y + (HT(k0.x, h1.y) * e0.x + HT(k1.x, h1.y) * e1.x) * g1.y;
  float y = (HT(h0.x, k0.y) * e0.y + HT(h0.x, k1.y) * e1.y) * g0.x + (HT(h1.x, k0.y) * e0.y + HT(h1.x, k1.y) * e1.y) * g1.x;
  return vec2(x, y) * N / u_hL;
}
vec2 seaGrad(vec2 q, float lod, float fp) {
  float T = u_time;
  vec2 w = q + .8 * vec2(sin(q.y * .21 + T * .1), sin(q.x * .17 - T * .08)), g = vec2(0.), uv = q / u_hL + .5;
  #define WV(dx, dy, L, A, S) { float k = TAU / L, ph = dot(w, vec2(dx, dy)) * k + T * S; g += A * k * cos(ph) * vec2(dx, dy); }
  if (uv.x > .002 && uv.x < .998 && uv.y > .002 && uv.y < .998) {
    // The bake holds everything but the two finest ripples. A spike smaller than a pixel can
    // only sparkle, so the bake's slope fades as it gets too fine to see.
    WV(-.9, -.44, 2.9, .014 * lod, .8)
    WV(.55, .83, 1.7, .005 * lod, 1.1)
    return g * u_wave + hmapGrad(uv) / (1. + fp * fp * 14.);
  }
  WV(.8, .6, 11., .11, .32)
  WV(-.64, .77, 7.3, .07, .41)
  WV(.28, -.96, 4.6, .035, .55)
  WV(-.9, -.44, 2.9, .014 * lod, .8)
  WV(.55, .83, 1.7, .005 * lod, 1.1)
  return g * u_wave;
}
uniform float u_seaTop; // nothing in the sea stands higher than this
float walk(vec3 ro, vec3 rd, float t, float end) {
  // A step can't go through a slope: what limits it is how fast the ray closes on the sea,
  // straight down plus sideways times how steep the sea can be here.
  float prev = t, drop = max(-rd.y, 0.), side = length(rd.xz);
  for (int i = 0; i < 64; i++) {
    vec3 p = ro + rd * t;
    vec4 hs = textureLod(u_hmap, p.xz / u_hL + .5, 0.);
    float d = p.y - hs.r;
    if (d < .001 + t * .0003) {
      for (int j = 0; j < 4; j++) { float mid = .5 * (prev + t); vec3 q = ro + rd * mid; if (q.y < seaAt(q.xz)) t = mid; else prev = mid; }
      return t;
    }
    prev = t;
    t += max(max(.9 * d / (drop + hs.g * side), hs.b / max(side, .02)), .012 + t * .0008);
    if (t > end) break;
  }
  return -1.;
}
float traceSea(vec3 ro, vec3 rd, float limit) {
  float start = 0., end = min(70., limit);
  if (ro.y > u_seaTop) { if (rd.y >= -.0006) return -1.; start = (ro.y - u_seaTop) / -rd.y; }
  if (rd.y > 0.) end = (u_seaTop - ro.y) / rd.y; else if (rd.y < -.0006) end = min(end, (ro.y + .3) / -rd.y);
  if (start >= end) return -1.;
  if (u_field.x > .01) { float f = walk(ro, rd, start, end); if (f > 0.) return f; }
  else {
    // Only a strong magnet's circle stands up; everywhere else the sea is gentle, and marching over
    // it would only leave a grain in the distance, which a mirror shows as an edge.
    float a = 1e9, b = -1.;
    for (int m = 0; m < 2; m++) {
      vec4 g = u_mag[m];
      if (g.w < .26) continue;
      vec2 co = ro.xz - g.xy, cd = rd.xz;
      float R = g.z * 1.9, qa = dot(cd, cd), qb = dot(co, cd), qc = dot(co, co) - R * R, disc = qb * qb - qa * qc;
      if (disc <= 0. || qa < 1e-6) continue;
      disc = sqrt(disc);
      a = min(a, (-qb - disc) / qa); b = max(b, (-qb + disc) / qa);
    }
    a = max(a, start); b = min(b, end);
    // A ray that met the water before it got this far has already found its surface.
    vec3 pa = ro + rd * a;
    if (a < b && pa.y > seaAt(pa.xz)) { float f = walk(ro, rd, a, b); if (f > 0.) return f; }
  }
  if (rd.y > -.0006) return -1.;
  float t = start;
  for (int i = 0; i < 3; i++) {
    vec3 p = ro + rd * t;
    t += (p.y - seaAt(p.xz)) / max(-rd.y, .09) * .85;
    t = max(t, 0.);
  }
  return t;
}
vec3 skyColor(vec3 rd) {
  vec3 dark = vec3(.5, .56, .66) * .022 * exp(-abs(rd.y) * 22.);
  return mix(vec3(.985, .98, .965), dark, u_dark);
}
vec3 seaEnv(vec3 r) {
  vec3 lit = mix(vec3(.62, .63, .66), vec3(1.04, 1.03, 1.02), smoothstep(0., .55, r.y));
  return lit * mix(1., .008 + .04 * smoothstep(0., 1., r.y), u_dark * (1. - gLit));
}

#define FOLD(q) (.72 * vn(q) + .28 * vn((q) * 1.8 + 5.))
float n21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * f * (f * (f * 6. - 15.) + 10.); return mix(mix(n21(i), n21(i + vec2(1, 0)), f.x), mix(n21(i + vec2(0, 1)), n21(i + vec2(1, 1)), f.x), f.y); }
float fbm2(vec2 p) { return .6 * vn(p) + .3 * vn(p * 2.1 + 7.) + .1 * vn(p * 4.3 + 3.); }
// What a display colour needs to be in the scene to come out of the tone curve unchanged.
vec3 screenLin(vec3 s) { return -log(max(1. - pow(s, vec3(2.2)), vec3(.004))) / 2.6; }

// ---- the mirror: rises out of the sea, with the app under its mercury ----
uniform vec4 u_slab, u_slabB, u_slabC, u_rip, u_view0, u_view1; // centre + yaw · half w, half h, pitch, corner · line, first, amount, rim · ripple uv, age, strength · what part of each picture shows
uniform sampler2D u_title; uniform vec4 u_titleP;
uniform vec2 u_slabMv; // how far the picture moved across the mirror this frame
uniform float u_slabEdge; // how wide the picture fades at its sides, when it is a window onto something larger
uniform sampler2D u_tex0, u_tex1;
float slabT(vec3 ro, vec3 rd, float grow, float pad, out vec3 sp) {
  vec3 o = ro - u_slab.xyz, d = rd;
  float cy = cos(u_slab.w), sy = sin(u_slab.w), cp = cos(u_slabB.z), sn = sin(u_slabB.z);
  o = vec3(cy * o.x - sy * o.z, o.y, sy * o.x + cy * o.z); d = vec3(cy * d.x - sy * d.z, d.y, sy * d.x + cy * d.z);
  o = vec3(o.x, cp * o.y - sn * o.z, sn * o.y + cp * o.z); d = vec3(d.x, cp * d.y - sn * d.z, sn * d.y + cp * d.z);
  if (abs(d.z) < 1e-4) return -1.;
  float t = -o.z / d.z;
  if (t <= .001) return -1.;
  sp = o + d * t;
  float cr = u_slabB.w;
  vec2 e = abs(sp.xy) - u_slabB.xy + cr;
  float sd2 = length(max(e, 0.)) + min(max(e.x, e.y), 0.) - cr;
  if (sd2 > grow * t + pad) return -1.;
  sp.z = sd2;
  return t;
}
vec3 slabColor(vec3 rd, vec3 sp, float blur, out float metal) {
  vec2 b = u_slabB.xy, uv = vec2(sp.x / b.x * .5 + .5, .5 - sp.y / b.y * .5), bend = vec2(0.);
  if (u_rip.w > 0.) {
    vec2 e = (uv - u_rip.xy) * vec2(b.x / b.y, 1.);
    float dd = length(e), wv = sin(dd * 36. - u_rip.z * 10.) * exp(-dd * 4.5) * exp(-u_rip.z * 1.3) * smoothstep(0., .12, u_rip.z * 1.1 - dd * .4 + .1) * u_rip.w;
    bend = e / max(dd, .001) * wv;
    uv += bend * .01;
  }
  float L = u_slabC.x, edge = L * 1.34 - .17 + (fbm2(vec2(uv.x * 2.4, u_time * .2)) - .5) * .2 + pow(vn(vec2(uv.x * 7. * b.x / b.y, 3.)), 3.) * .18;
  float dy = uv.y - edge, bev = smoothstep(-u_slabC.w, 0., sp.z);
  vec3 n = vec3(bend * 2.2, 1.);
  n.xy += sign(sp.xy) * smoothstep(0., 1., abs(sp.xy) / b) * bev * bev * .8;
  n = normalize(n);
  // Mercury runs down the sheet in long soft folds, and each fold carries the room in it.
  vec2 fq = vec2(sp.x * .85 + sin(sp.y * .7 + u_time * .3) * .25, sp.y * .22 + u_time * .2);
  const float dn = .2;
  float f0 = FOLD(fq), fx = FOLD(fq + vec2(dn, 0.)), fy = FOLD(fq + vec2(0., dn));
  vec3 nf = normalize(n + vec3((f0 - fx) / dn * .62, (f0 - fy) / dn * .18 + .2, 0.));
  vec3 ch = env(reflect(rd, nf), 3.2);
  vec2 u0 = u_view0.xy + uv * u_view0.zw, u1 = u_view1.xy + uv * u_view1.zw;
  vec3 neu = screenLin(texture(u_tex1, u1, blur - .8).rgb), old = screenLin(texture(u_tex0, u0, blur - .8).rgb);
  if (u_slabEdge > 0.) {
    float side = smoothstep(0., u_slabEdge, min(uv.x, 1. - uv.x));
    vec3 ground = screenLin(vec3(.086));
    neu = mix(ground, neu, side); old = mix(ground, old, side);
  }
  if (u_slabC.y > .5) old = ch;
  // The lip: a rounded wet edge, as wide as a thick drop of mercury and no wider.
  float k = smoothstep(-.012, .012, dy), lip = exp(-dy * dy / .0011);
  vec3 col = mix(neu, old, k);
  vec3 nl = normalize(nf + vec3(0., clamp(dy * 34., -1., 1.) * .95, 0.));
  col = mix(col, env(reflect(rd, nl), 2.4), lip);
  col = mix(col, env(reflect(rd, n), 3.), bev * bev);
  metal = max(max(lip, bev), k * u_slabC.y);
  return col;
}

// ---- the wall: the same generated screen, again and again, cast in silver ----
uniform vec4 u_wall; // rise, melt, z, amount
uniform vec2 u_wallB; // how far its windows have cleared, unused
uniform sampler2D u_clone; // the screen every generator makes
float rrect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
// One sheet of mercury climbs out of the sea and comes down the same way. Under it, in rows,
// the same screen: each window's mercury drains in its turn, and every one shows the same thing.
float wallTop(float x, float r, float m) {
  float wav = (vn(vec2(x * .34, 2. + u_time * .05)) - .5) * 2.2 * smoothstep(0., .3, r);
  float sag = (vn(vec2(x * .78, 9.)) - .35) * 3.2 * smoothstep(0., .5, m);
  return 7.9 * r - 9.4 * m - .6 + wav - sag;
}
vec4 wallAt(vec3 ro, vec3 rd, float tMax, float pxs, bool quick, out float lipOut, out float tOut) {
  lipOut = 0.; tOut = 1e4;
  if (abs(rd.z) < 1e-4) return vec4(0.);
  float t = (u_wall.z - ro.z) / rd.z;
  if (t <= 0. || t > tMax) return vec4(0.);
  vec3 p = ro + rd * t;
  float m = u_wall.y * u_wall.y * (3. - 2. * u_wall.y), top = wallTop(p.x, u_wall.x, m), e2 = p.y - top, fw = max(pxs * t, .01);
  float a = clamp(.5 - e2 / fw, 0., 1.);
  if (a <= 0.) return vec4(0.);
  vec3 nf = normalize(vec3(0., .2, 1.));
  if (!quick) {
    vec2 fq = vec2(p.x * .85 + sin(p.y * .7 + u_time * .3) * .25, p.y * .22 + u_time * .2);
    const float dn = .2;
    float f0 = FOLD(fq), fx = FOLD(fq + vec2(dn, 0.)), fy = FOLD(fq + vec2(0., dn));
    nf = normalize(vec3((f0 - fx) / dn * .62, (f0 - fy) / dn * .18 + .2, 1.));
  }
  vec3 sheet = env(reflect(rd, nf), 3.2), col = sheet;
  const vec2 C = vec2(2.72, 1.8), HS = vec2(1.16, .725);
  vec2 g = vec2(p.x - .3, p.y - .1) / C, id = floor(g), f = (fract(g) - .5) * C;
  if (id.y > -.5 && id.y < 2.5) {
    float d = rrect(f, HS, .11), aa = max(pxs * t, .012), win = clamp(.5 - d / aa, 0., 1.);
    if (win > 0.) {
      vec2 uv = f / (2. * HS) + .5;
      float h = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453), L = clamp(u_wallB.x * 1.75 - h * .75, 0., 1.);
      L = L * L * (3. - 2. * L);
      float edge = L * 1.36 - .18 + (vn(vec2(uv.x * 3. + id.x * 7., id.y * 3. + u_time * .2)) - .5) * .16;
      float dy = (1. - uv.y) - edge, k = smoothstep(-.012, .012, dy), lip = exp(-dy * dy / .0011);
      vec3 pic = screenLin(texture(u_clone, vec2(uv.x, 1. - uv.y), quick ? 2.5 : 0.).rgb);
      vec3 w = mix(pic, sheet, k);
      w = mix(w, env(reflect(rd, normalize(nf + vec3(0., clamp(dy * 34., -1., 1.) * .95, 0.))), 2.4), lip);
      float bev = smoothstep(-.04, 0., d);
      // Under the mercury there is no window at all: the glass's edge comes with the drain.
      w = mix(w, env(reflect(rd, normalize(nf + vec3(sign(f) * smoothstep(0., 1., abs(f) / HS) * .7, 0.))), 3.), bev * bev);
      col = mix(col, w, win * smoothstep(0., .12, L));
    }
  }
  // the top edge is a rounded lip of liquid
  float rim = clamp(1. + e2 / .3, 0., 1.); rim *= rim;
  if (rim > 0.) {
    float dd = (wallTop(p.x + .05, u_wall.x, m) - top) / .05;
    col = mix(col, env(reflect(rd, normalize(vec3(-dd * .5 * rim, rim, sqrt(max(1. - rim * rim, .03))))), 2.8), smoothstep(.05, .6, rim));
  }
  lipOut = 1.; tOut = t;
  return vec4(col, a);
}

// What stands next to this point of the sea, along its reflected ray.
float seeNext(vec3 ro, vec3 rd, out float near) {
  float t = .04, prev = t, side = length(rd.xz), drop = max(-rd.y, 0.), at = -1.;
  near = 1.;
  for (int i = 0; i < 26; i++) {
    vec3 p = ro + rd * t;
    if (p.y > u_seaTop) break;
    vec4 hs = textureLod(u_hmap, p.xz / u_hL + .5, 0.);
    float d = p.y - hs.r;
    if (d < 0.) {
      for (int j = 0; j < 3; j++) { float mid = .5 * (prev + t); vec3 q = ro + rd * mid; if (q.y < textureLod(u_hmap, q.xz / u_hL + .5, 0.).r) t = mid; else prev = mid; }
      near = 0.; return t;
    }
    float nr = d / (t * .05 + .012);
    if (nr < near) { near = nr; at = t; }
    prev = t;
    t += max(max(.9 * d / (drop + hs.g * side), hs.b / max(side, .02)), .02 + t * .025);
    if (t > 26.) break;
  }
  return at;
}
float gSteep = 0.;
vec3 seaColor(vec3 ro, vec3 rd, float t, float px) {
  vec3 p = ro + rd * t;
  float lod = 1. / (1. + t * .05), fp = px * t / max(-rd.y, .04);
  vec2 g = seaGrad(p.xz, lod, fp) * mix(.35, 1., lod);
  vec3 n = normalize(vec3(-g.x, 1., -g.y));
  gLit = u_flood > 0. ? smoothstep(1., -3., length(p.xz - u_kpos.xz) - u_floodR) : 0.;
  vec3 r = reflect(rd, n);
  // A ray that would run down into the sea folds back up, softly: a hard fold draws a line.
  r.y = sqrt(r.y * r.y + .0025); r = normalize(r);
  vec3 col = seaEnv(r);
  // Spikes are chrome; the flat sea stays pale. The change is gradual, so there is no outline,
  // and the studio is read soft, so a spike's flank is a gradient and not a contour map.
  float slope = 1. - n.y, steep = smoothstep(.015, .4, slope);
  gSteep = steep * (1. - u_dark * (1. - gLit));
  bool field = u_field.x > .01;
  if (steep > 0. || field) {
    vec3 ch = envC(r, clamp(log2(length(fwidth(r)) / ENV_T), 1.4, 7.));
    // Each spike carries the others in it, and the floor between them is a mirror: that is what
    // makes a field of them read as metal.
    float near, at = seeNext(p + n * .02, r, near);
    float mirror = max(steep, field ? mix(.42, .85, pow(1. - clamp(dot(n, -rd), 0., 1.), 2.)) : 0.);
    if (at > 0. && near < 1.) {
      vec2 hq = (p.xz + r.xz * at) / u_hL + .5;
      const vec2 he = vec2(.0024, 0.);
      vec2 g2 = vec2(textureLod(u_hmap, hq + he.xy, 0.).r - textureLod(u_hmap, hq - he.xy, 0.).r, textureLod(u_hmap, hq + he.yx, 0.).r - textureLod(u_hmap, hq - he.yx, 0.).r) / (2. * he.x * u_hL);
      vec3 n2 = normalize(vec3(-g2.x, 1., -g2.y));
      vec3 seen = envC(reflect(r, n2), 2.6) * mix(1., .55, pow(1. - clamp(dot(n2, -r), 0., 1.), 2.));
      if (steep > .001) ch = mix(seen, ch, smoothstep(0., 1., near));
      else ch = seen;
      if (steep <= .001) mirror *= 1. - smoothstep(0., 1., near);
    } else if (steep <= .001) mirror = 0.;
    // Chrome against a white room needs a little dark at its edge to hold its shape.
    ch *= mix(1., .55, pow(1. - clamp(dot(n, -rd), 0., 1.), 3.) * steep);
    col = mix(col, ch, mirror);
  }
  // The knot in the mirror.
  if (u_krefl > .01 && u_kOn > .5) {
    vec3 ok = u_krot * (p - u_kpos) / u_kscale, dk = u_krot * r;
    float spread = clamp(length(fwidth(r)) * 1.4, px * 2.5, .1), tk = traceK(ok, dk, spread, 24), a = 1.;
    a = tk > 0. ? 1. : gMinD < 2. ? 1. - smoothstep(0., 2., gMinD) : 0.;
    if (tk < 0. && a > 0.) tk = gMinT;
    if (tk > 0.) col = mix(col, knotColor(ok, dk, tk, spread, false), u_krefl * a);
  }
  if (u_titleP.y > .01 && r.z < -.05) {
    // The words in the sea, where a plane behind the knot would put them.
    vec3 hw = p + r * ((-1.6 - p.z) / r.z) - u_pos, tq = transpose(u_cam) * hw;
    vec2 sv = (tq.xy / tq.z / u_f - u_shift) / vec2(u_aspect, 1.) * .5 + .5;
    float along = u_titleP.w > .5 ? sv.y : sv.x, side = along < u_titleP.z ? -1. : 1., s = along + side * u_titleP.x;
    float ta = textureLod(u_title, u_titleP.w > .5 ? vec2(sv.x, 1. - s) : vec2(s, 1. - sv.y), 1.6).a * u_titleP.y;
    col = mix(col, vec3(.1), ta * .62);
  }
  if (u_slabC.z > .001) {
    // The mirror in the sea: soft at its edges, the way a rippled reflection is.
    vec3 sp; float t2 = slabT(p + n * .01, r, 0., .3, sp), mt;
    if (t2 > 0.) col = mix(col, slabColor(r, sp, 2.5, mt), .78 * u_slabC.z * smoothstep(.3, -.1, sp.z));
  }
  if (u_wall.w > .001) { float lp, tw; vec4 wc = wallAt(p, r, 1e9, 0., true, lp, tw); col = mix(col, wc.rgb, wc.a * .7 * u_wall.w); }
  // The wave of light running out over the sea.
  if (u_flood > 0.) { float e = length(p.xz - u_kpos.xz) - u_floodR; col += exp(-e * e / 1.1) * 6. * u_flood; }
  if (u_field.x > .01) col *= mix(mix(1., .3, u_dark), 1., smoothstep(0., u_field.x * .7, p.y));
  float fd = length(p.xz - ro.xz);
  float fog = 1. - exp(-fd * fd * .0028);
  return mix(col, skyColor(rd), fog);
}

// How far this point has moved on screen since the last frame.
vec2 movedBy(vec3 d, vec2 now) {
  vec3 q = transpose(u_pcam) * d;
  if (q.z <= .001) return vec2(0.);
  return now - ((q.xy / q.z / u_pf - u_pshift) / vec2(u_aspect, 1.) * .5 + .5);
}
void main() {
  vec2 uv = ((gl_FragCoord.xy + u_jit) / u_res * 2. - 1.) * vec2(u_aspect, 1.);
  vec3 ro = u_pos, rd = normalize(u_cam * vec3((uv + u_shift) * u_f, 1.));
  float px = 2. * u_f / u_res.y;
  vec3 ok = u_krot * (ro - u_kpos) / u_kscale, dk = u_krot * rd;
  float tk = traceK(ok, dk, px, 80), minT = gMinT, minD = gMinD;
  float ts = ro.y > 0. ? traceSea(ro, rd, tk > 0. ? tk * u_kscale + .02 : 70.) : -1.;
  vec3 col = skyColor(rd);
  float cover = 0., depth = 1e4, kHit = -1., onSlab = 0.;
  float tw = tk > 0. ? tk * u_kscale : -1.;
  if (ts > 0. && (tw < 0. || ts < tw)) { col = seaColor(ro, rd, ts, px); tw = -1.; cover = .5 + .5 * gSteep; depth = ts; }
  else if (tw > 0.) { col = knotColor(ok, dk, tk, px, true); cover = 1.; depth = tw; kHit = tk; }
  if (tw < 0. && minD < 1. && minT > 0. && (ts < 0. || minT * u_kscale < ts)) {
    vec3 edge = knotColor(ok, dk, minT, px, false);
    float ec = smoothstep(0., 1., minD);
    col = mix(edge, col, ec);
    cover = max(cover, 1. - ec);
    if (minT * u_kscale < depth) { depth = minT * u_kscale; kHit = minT; }
  }
  float tNear = min(depth, ts > 0. ? ts : 1e4);
  if (u_slabC.z > .001) {
    vec3 sp; float t2 = slabT(ro, rd, px, 0., sp);
    if (t2 > 0. && t2 < tNear) {
      float mt, a = clamp(.5 - sp.z / (px * t2), 0., 1.);
      col = mix(col, slabColor(rd, sp, 0., mt), a); cover = mix(cover, .5 + .5 * mt, a); tNear = t2; depth = t2; kHit = -1.; onSlab = a;
    }
  }
  if (u_wall.w > .001) {
    float lp, tz; vec4 wc = wallAt(ro, rd, tNear, px, false, lp, tz);
    if (wc.a > 0.) { col = mix(col, wc.rgb, wc.a * u_wall.w); cover = max(cover, (.5 + .5 * lp) * wc.a * u_wall.w); if (tz < depth) { depth = tz; kHit = -1.; } }
  }
  if (u_plasma > .01) {
    float along = -dot(ok, dk), miss = dot(ok, ok) - along * along;
    if (miss < 7.5 && along > -1.) {
      vec4 hl = halo(ok, dk, tk);
      hl.a *= mix(.62, .5, 1. - u_dark) * u_plasma * smoothstep(7.5, 4.5, miss);
      col = col * (1. - hl.a) + hl.rgb * hl.a * 1.5;
    }
  }
  // Stored squeezed, so accumulating can't ring round the hot spots.
  col = min(col, vec3(24.));
  outColor = vec4(col / (1. + max(col.r, max(col.g, col.b))), cover);
  // The knot moves as well as the camera, so its points are followed through its own turn.
  vec2 now = (gl_FragCoord.xy + u_jit) / u_res, mv;
  if (depth > 5e3) mv = movedBy(rd, now);
  else if (kHit > 0.) {
    vec3 pk = ok + dk * kHit;
    if (u_bandB.x > .5) pk -= bandFlow(pk);
    mv = movedBy(u_kposP + transpose(u_krotP) * (pk * u_kscale) - u_ppos, now);
  }
  else mv = movedBy(ro + rd * depth - u_ppos, now);
  outVel = vec4(mv + u_slabMv * onSlab, depth, 1.);
}
`;

  // The sea's height for this frame, in a texture, so a ray walking through it reads one
  // texel a step instead of working out every spike again.
  const HEIGHT = `#version 300 es
precision highp float;
#define TAU 6.28318530718
#define PI 3.14159265359
uniform float u_time, u_wave, u_bulge, u_simL, u_hL, u_hN; uniform vec3 u_kpos; uniform sampler2D u_sim;
${SEA0}
${SEA}
out vec4 o;
void main() {
  vec2 q = (gl_FragCoord.xy / u_hN - .5) * u_hL;
  o = vec4(seaH(q), .24 + 8. * magField(q) + 3. * u_field.x / u_field.z, clearAt(q), 1.);
}`;

  const SIM = `#version 300 es
precision highp float;
uniform sampler2D u_prev; uniform vec2 u_texel; uniform float u_cell;
uniform vec4 u_drops[10];
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  vec4 s = texture(u_prev, uv);
  float l = texture(u_prev, uv - vec2(u_texel.x, 0.)).r, r = texture(u_prev, uv + vec2(u_texel.x, 0.)).r;
  float d = texture(u_prev, uv - vec2(0., u_texel.y)).r, u = texture(u_prev, uv + vec2(0., u_texel.y)).r;
  float v = s.g + ((l + r + d + u) * .25 - s.r) * .62;
  v *= .991;
  float h = (s.r + v) * .9985;
  for (int i = 0; i < 10; i++) {
    vec4 k = u_drops[i];
    if (k.w == 0.) continue;
    vec2 e = uv - k.xy;
    h += k.w * exp(-dot(e, e) / (k.z * k.z));
  }
  vec2 edge = min(uv, 1. - uv);
  float damp = smoothstep(0., .08, min(edge.x, edge.y));
  h *= mix(.9, 1., damp); v *= mix(.9, 1., damp);
  o = vec4(h, v, (l - r) * -.5 / u_cell, (d - u) * -.5 / u_cell);
}`;

  const BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform vec2 u_dir; uniform float u_threshold;
in vec2 v; out vec4 o;
void main() {
  vec3 c = vec3(0.); float w = 0.;
  for (int i = -6; i <= 6; i++) {
    float f = float(i), g = exp(-f * f / 14.);
    vec3 s = texture(u_tex, v + u_dir * f).rgb;
    if (u_threshold > 0.) s = max(s - u_threshold, 0.);
    c += s * g; w += g;
  }
  o = vec4(c / w, 1.);
}`;

  const RESOLVE = `#version 300 es
precision highp float;
uniform sampler2D u_cur, u_vel, u_hist;
uniform vec2 u_sz, u_cap, u_hsz, u_jit; uniform float u_a;
in vec2 v; out vec4 o;
// History, sharply: five taps of Catmull-Rom.
vec4 sharpHist(vec2 uv) {
  vec2 px = uv * u_hsz, c = floor(px - .5) + .5, f = px - c, f2 = f * f;
  vec2 w0 = f * (-.5 + f * (1. - .5 * f)), w1 = 1. + f2 * (-2.5 + 1.5 * f), w2 = f * (.5 + f * (2. - 1.5 * f)), w3 = f2 * (-.5 + .5 * f);
  vec2 w12 = w1 + w2, p0 = (c - 1.) / u_hsz, p3 = (c + 2.) / u_hsz, p12 = (c + w2 / w12) / u_hsz;
  vec4 s = texture(u_hist, vec2(p12.x, p0.y)) * w12.x * w0.y + texture(u_hist, vec2(p0.x, p12.y)) * w0.x * w12.y + texture(u_hist, p12) * w12.x * w12.y + texture(u_hist, vec2(p3.x, p12.y)) * w3.x * w12.y + texture(u_hist, vec2(p12.x, p3.y)) * w12.x * w3.y;
  return s / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
}
void main() {
  vec2 sc = v * u_sz;
  ivec2 lim = ivec2(u_sz) - 1, ic = clamp(ivec2(floor(sc - u_jit)), ivec2(0), lim);
  if (u_a >= .99) { o = texture(u_cur, (sc - u_jit) / u_cap); return; }
  vec4 c = texelFetch(u_cur, ic, 0);
  vec4 n1 = texelFetch(u_cur, clamp(ic + ivec2(1, 0), ivec2(0), lim), 0), n2 = texelFetch(u_cur, clamp(ic - ivec2(1, 0), ivec2(0), lim), 0), n3 = texelFetch(u_cur, clamp(ic + ivec2(0, 1), ivec2(0), lim), 0), n4 = texelFetch(u_cur, clamp(ic - ivec2(0, 1), ivec2(0), lim), 0);
  vec4 mean = (c + n1 + n2 + n3 + n4) * .2, dev = sqrt(max((c * c + n1 * n1 + n2 * n2 + n3 * n3 + n4 * n4) * .2 - mean * mean, vec4(0.)));
  // The move of whatever is nearest here, so an edge carries its own history with it.
  vec4 near = texelFetch(u_vel, ic, 0);
  for (int i = 0; i < 4; i++) {
    ivec2 d = i < 2 ? ivec2(2 * i - 1, 0) : ivec2(0, 2 * i - 5);
    vec4 n = texelFetch(u_vel, clamp(ic + d, ivec2(0), lim), 0);
    if (n.b < near.b) near = n;
  }
  vec2 pv = v - near.xy;
  if (pv.x < 0. || pv.y < 0. || pv.x > 1. || pv.y > 1.) { o = texture(u_cur, (sc - u_jit) / u_cap); return; }
  vec4 h = clamp(sharpHist(pv), mean - dev * 1.5, mean + dev * 1.5);
  vec2 dd = sc - (vec2(ic) + .5 + u_jit);
  float w = exp(-2.6 * dot(dd, dd));
  o = mix(h, c, clamp(u_a * (.3 + 1.4 * w), .02, 1.));
}`;

  const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D u_scene, u_vel, u_bloom;
uniform vec2 u_sz, u_csz;
uniform sampler2D u_title; uniform vec4 u_titleP; // how far it still has to slide, how solid, where the middle is, and whether it parts up and down rather than sideways
uniform float u_dim, u_time, u_fade, u_bloomA, u_paper, u_grain, u_scrim, u_scrimX, u_scrimW, u_flash, u_mono, u_shutter; uniform vec3 u_flashC, u_ground;
in vec2 v; out vec4 o;
vec3 unsqueeze(vec3 c) { return c / max(1. - max(c.r, max(c.g, c.b)), .04); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(.06711056, .00583715)))); }
void main() {
  vec4 base = texture(u_scene, v);
  // A touch of contrast at the finest scale, held to the neighbours so it can't ring.
  vec2 ep = 1. / u_csz;
  vec3 n0 = texture(u_scene, v + vec2(ep.x, 0.)).rgb, n1 = texture(u_scene, v - vec2(ep.x, 0.)).rgb, n2 = texture(u_scene, v + vec2(0., ep.y)).rgb, n3 = texture(u_scene, v - vec2(0., ep.y)).rgb;
  vec3 lo = min(base.rgb, min(n0, min(n1, min(n2, n3)))), hi = max(base.rgb, max(n0, max(n1, max(n2, n3))));
  vec3 c = unsqueeze(clamp(base.rgb + (base.rgb * 4. - n0 - n1 - n2 - n3) * .13, lo, hi));
  // Motion blur along where each point actually moved.
  if (u_shutter > 0.) {
    vec2 mv = texelFetch(u_vel, ivec2(v * u_sz), 0).xy * u_shutter;
    float L = length(mv * u_csz), lim = .032 * u_csz.y;
    if (L > lim) mv *= lim / L;
    if (L > 1.2) {
      float j = ign(gl_FragCoord.xy + u_time * 61.) - .5;
      vec3 s = vec3(0.);
      for (int i = 0; i < 10; i++) { float f = (float(i) + .5 + j) / 10. - .5; s += texture(u_scene, v + mv * f).rgb; }
      c = unsqueeze(s / 10.);
    }
  }
  c += unsqueeze(texture(u_bloom, v).rgb) * u_bloomA;
  vec2 e = (v - .5) * vec2(1.1, 1.);
  c *= 1. - .35 * smoothstep(.35, .95, length(e)) * (1. - u_paper);
  c = mix(c + u_flashC * u_flash, c * mix(vec3(1.), u_flashC, clamp(u_flash * 2.2, 0., 1.)), u_paper);
  float metal = clamp(base.a * 2. - 1., 0., 1.);
  c = mix(aces(c * 1.05), mix(1. - exp(-c * 2.6), aces(c * 1.12), metal), u_paper);
  c = pow(c, vec3(1. / 2.2));
  c = mix(c, vec3(dot(c, vec3(.2126, .7152, .0722))), u_mono);
  c = mix(c, u_ground, u_dim);
  // The headline stands behind the knot: it comes out from behind it, each side its own way,
  // and only the empty room shows it. Drawn at the screen's own pixels, so type stays type.
  if (u_titleP.y > 0.) {
    float along = u_titleP.w > .5 ? v.y : v.x, side = along < u_titleP.z ? -1. : 1., s = along + side * u_titleP.x;
    vec2 tv = u_titleP.w > .5 ? vec2(v.x, 1. - s) : vec2(s, 1. - v.y);
    float keep = side < 0. ? step(s, u_titleP.z) : step(u_titleP.z, s);
    c = mix(c, vec3(.043, .043, .047), texture(u_title, tv).a * keep * u_titleP.y * (1. - (u_titleP.w > .5 ? smoothstep(.8, .98, base.a) : smoothstep(.02, .3, base.a))));
  }
  // The reading side: whatever the camera sees, the column of text sits on the ground colour.
  if (u_scrim > 0.) c = mix(c, u_ground, u_scrim * smoothstep(u_scrimX + u_scrimW, u_scrimX + .005, v.x));
  c = mix(u_ground, c, u_fade);
  // Interleaved gradient noise: grain with no pattern of its own, and it hides banding in the soft gradients.
  c += (ign(gl_FragCoord.xy + 5.588238 * floor(fract(u_time * .73) * 64.)) - .5) * u_grain;
  o = vec4(c, 1.);
}`;

  const mix1 = (a, b, t) => a + (b - a) * t;
  const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  const JIT = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - .5, halton(i + 1, 3) - .5]);
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  function basis(pos, tgt, roll, up) {
    const f = norm(sub(tgt, pos));
    let r = norm(cross(f, up ?? [0, 1, 0]));
    let u = cross(r, f);
    if (roll) { const c = Math.cos(roll), s = Math.sin(roll); const r2 = [r[0] * c + u[0] * s, r[1] * c + u[1] * s, r[2] * c + u[2] * s]; u = [u[0] * c - r[0] * s, u[1] * c - r[1] * s, u[2] * c - r[2] * s]; r = r2; }
    return { r, u, f };
  }
  // World to knot: yaw, then pitch, then roll. Column-major.
  function knotRot([yaw, pitch, roll]) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const Y = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]], X = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]], Z = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
    const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
    const m = mul(Z, mul(X, Y));
    return new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);
  }

  class World {
    constructor(canvas, { simSize = 256, simL = 44, sdfSize = 112, envSize = 512, heightSize = 1024 } = {}) {
      this.canvas = canvas; this.ok = false; this.simL = simL; this.simSize = simSize; this.sdfSize = sdfSize; this.envSize = envSize;
      this.cssW = 0; this.cssH = 0; this.pendingDrops = []; this.simAcc = 0; this.last = 0; this.baked = false; this.bakeZ = 0;
      const K = window.KnotMark;
      if (!K?.METAL_HEAD) return;
      const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
      if (!gl) return;
      this.gl = gl;
      canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.ok = false; canvas.dispatchEvent(new CustomEvent("world:lost", { bubbles: true })); });
      if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return;
      this.parallel = gl.getExtension("KHR_parallel_shader_compile");
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      const silver = (glsl) => glsl
        .replace("float g = exp(-dot(cl, cl) / (r * r));", "float g = exp(-dot(cl, cl) / (r * r)) * smoothstep(-.05, .35, tc);")
        .replace("cRed = mix(vec3(.78, .034, .05), vec3(1., .07, .107), u_dark);", "cRed = vec3(.92);")
        .replace("cBlue = mix(vec3(.005, .32, .69), vec3(.03, .66, 1.), u_dark);", "cBlue = vec3(.62, .64, .68);");
      const head = K.METAL_HEAD.replace("out vec4 outColor;", "layout(location = 0) out vec4 outColor; layout(location = 1) out vec4 outVel;\nuniform float u_plasma;");
      const src = (dir) => head + silver(dir.glsl) + "\n" + WORLD;
      this.loop = K.KNOT.loop; this.igniteLoop = K.IGNITION.loop;
      this.scene = this.#program(VERT, src(K.KNOT));
      this.blur = this.#program(VERT_UV, BLUR);
      this.resolve = this.#program(VERT_UV, RESOLVE);
      this.comp = this.#program(VERT_UV, COMPOSITE);
      this.sim = this.#program(VERT, SIM);
      this.hmapP = this.#program(VERT, HEIGHT);
      this.hmap = this.#target(heightSize, heightSize); this.hmapN = heightSize; this.hmapL = 48;
      this.bakeS = this.#program(VERT, BAKE_SDF);
      this.bakeE = this.#program(VERT, BAKE_ENV);
      this.simA = this.#target(simSize, simSize);
      this.simB = this.#target(simSize, simSize);
      for (const t of [this.simA, this.simB]) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      this.dummy = this.#texture(new Uint8Array([0, 0, 0, 255]));
      this.igniteSrc = src(K.IGNITION);
      this.view = [0, 0, 1, 1]; this.still = [0, 0]; this.none = [0, 0, 0, 0]; this.none4 = [0, 0, 0, 0]; this.title3 = [0, 0, .5];
      this.prev = null;
      this.timer = gl.getExtension("EXT_disjoint_timer_query_webgl2"); this.queries = []; this.gpuMs = 0;
      this.ok = true;
    }
    #program(vs, fs) {
      const gl = this.gl;
      const make = (type, s) => { const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
      const p = gl.createProgram(), v = make(gl.VERTEX_SHADER, vs), f = make(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(p, v); gl.attachShader(p, f); gl.bindAttribLocation(p, 0, "a"); gl.linkProgram(p);
      return { p, v, f, u: new Map(), ready: false };
    }
    #linked(entry) {
      const gl = this.gl;
      if (entry.ready) return true;
      if (this.parallel && !gl.getProgramParameter(entry.p, this.parallel.COMPLETION_STATUS_KHR)) return false;
      if (!gl.getProgramParameter(entry.p, gl.LINK_STATUS)) {
        const log = gl.getShaderInfoLog(entry.f) || gl.getProgramInfoLog(entry.p);
        console.warn("world: shader failed", log);
        this.ok = false;
        canvasFail(this.canvas);
        throw new Error(log);
      }
      entry.ready = true;
      return true;
    }
    #u(e, name) { let l = e.u.get(name); if (l === undefined) { l = this.gl.getUniformLocation(e.p, name); e.u.set(name, l); } return l; }
    #texture(data) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.#params();
      return t;
    }
    #params(filter) { const gl = this.gl, f = filter ?? gl.LINEAR; for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, f], [gl.TEXTURE_MAG_FILTER, f], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); }
    #target(w, h) {
      const gl = this.gl, tex = gl.createTexture(), fb = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      this.#params();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fb, w, h };
    }
    #free(t) { if (t) { this.gl.deleteTexture(t.tex); this.gl.deleteFramebuffer(t.fb); if (t.depth) this.gl.deleteTexture(t.depth); } }
    // The scene's target: colour, and how far away each pixel is.
    #sceneTarget(w, h) {
      const gl = this.gl, t = this.#target(w, h), depth = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, depth);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      this.#params(gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depth, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      t.depth = depth;
      return t;
    }
    // Shape and studio, a few slices a frame, so a slow GPU never freezes the page.
    bake() {
      if (this.baked || !this.ok) return this.baked;
      if (!this.#linked(this.bakeS) || !this.#linked(this.bakeE)) return false;
      const gl = this.gl, N = this.sdfSize;
      if (!this.sdf) {
        this.sdf = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, this.sdf);
        gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, N, N, N);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
        this.bakeFb = gl.createFramebuffer();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bakeFb);
      gl.useProgram(this.bakeS.p);
      gl.viewport(0, 0, N, N);
      gl.uniform1f(this.#u(this.bakeS, "u_n"), N);
      for (let i = 0; i < 16 && this.bakeZ < N; i++, this.bakeZ++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.sdf, 0, this.bakeZ);
        gl.uniform1f(this.#u(this.bakeS, "u_z"), this.bakeZ);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (this.bakeZ < N) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); return false; }
      const S = this.envSize, levels = Math.floor(Math.log2(S)) + 1;
      gl.useProgram(this.bakeE.p);
      gl.viewport(0, 0, S, S);
      gl.uniform1f(this.#u(this.bakeE, "u_s"), S);
      // Each face: where (u, v, 1) points, as columns.
      const FACES = [[0, 0, -1, 0, -1, 0, 1, 0, 0], [0, 0, 1, 0, -1, 0, -1, 0, 0], [1, 0, 0, 0, 0, 1, 0, 1, 0], [1, 0, 0, 0, 0, -1, 0, -1, 0], [1, 0, 0, 0, -1, 0, 0, 0, 1], [-1, 0, 0, 0, -1, 0, 0, 0, -1]];
      const room = (crisp) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
        gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, gl.RGBA16F, S, S);
        gl.uniform1f(this.#u(this.bakeE, "u_crisp"), crisp);
        FACES.forEach((m, i) => {
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, tex, 0);
          gl.uniformMatrix3fv(this.#u(this.bakeE, "u_face"), false, new Float32Array(m));
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        });
        gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return tex;
      };
      this.env = room(0); this.envC = room(1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const p of [this.bakeS, this.bakeE]) gl.deleteProgram(p.p);
      this.baked = true;
      return true;
    }
    get ready() { try { return this.#linked(this.scene) && this.#linked(this.blur) && this.#linked(this.resolve) && this.#linked(this.comp) && this.#linked(this.sim) && this.#linked(this.hmapP); } catch { return false; } }
    // The ignition's timeline is a second program; built in the background.
    prepareIgnition() { if (!this.ignite && this.ok) this.ignite = this.#program(VERT, this.igniteSrc); }
    // A GPU builds a program's pipeline on its first draw, and that stalls the page.
    // Doing it before anything is on show keeps the stall out of the ignition.
    warm(program) {
      const gl = this.gl;
      gl.useProgram(program.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneT.fb);
      gl.viewport(0, 0, 4, 4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    warmIgnition() { if (!this.warmed && this.igniteReady) { this.warmed = true; this.warm(this.ignite); this.warm(this.scene); } }
    get igniteReady() { try { return !!this.ignite && this.#linked(this.ignite); } catch { return false; } }
    drop(x, z, r = .6, s = .2) {
      const L = this.simL;
      if (Math.abs(x) > L / 2 || Math.abs(z) > L / 2) return;
      if (this.pendingDrops.length < 30) this.pendingDrops.push({ x: x / L + .5, z: z / L + .5, r: r / L, s, n: 0 });
    }
    setScreens(images) {
      const gl = this.gl, an = gl.getExtension("EXT_texture_filter_anisotropic");
      this.screens = images.map((img) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, 8);
        return t;
      });
    }
    setTitle(image) {
      const gl = this.gl;
      if (!this.title) this.title = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.title);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    }
    setClone(image) {
      const gl = this.gl, an = gl.getExtension("EXT_texture_filter_anisotropic"), t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      this.clone = t;
    }
    // dpr: canvas pixels per CSS px. share: how much of them to draw this frame.
    // ceil: the most it will ever draw. Only a new canvas size reallocates anything.
    size(dpr, share, ceil) {
      const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
      const CW = Math.round(w * dpr), CH = Math.round(h * dpr);
      const gl = this.gl;
      if (CW !== this.CW || CH !== this.CH || ceil !== this.ceil) {
        this.cssW = w; this.cssH = h; this.CW = CW; this.CH = CH; this.ceil = ceil;
        if (this.canvas.width !== CW) this.canvas.width = CW;
        if (this.canvas.height !== CH) this.canvas.height = CH;
        const capW = Math.max(2, Math.ceil(CW * ceil)), capH = Math.max(2, Math.ceil(CH * ceil));
        for (const t of [this.sceneT, this.b1, this.b2]) this.#free(t);
        this.sceneT = this.#sceneTarget(capW, capH);
        for (const t of this.hist ?? []) this.#free(t);
        this.hist = [this.#target(CW, CH), this.#target(CW, CH)]; this.histOK = false;
        const bw = Math.max(2, capW >> 2), bh = Math.max(2, capH >> 2);
        this.b1 = this.#target(bw, bh); this.b2 = this.#target(bw, bh);
      }
      this.W = Math.max(2, Math.min(this.sceneT.w, Math.round(CW * share)));
      this.H = Math.max(2, Math.min(this.sceneT.h, Math.round(CH * share)));
    }
    // A sea point under a screen point, for the pointer.
    ray(st, x, y) {
      const { r, u, f } = basis(st.pos, st.tgt, st.roll, st.up);
      const H = this.cssH || innerHeight, W = this.cssW || innerWidth;
      const ux = ((x / W) * 2 * W - W) / H, uy = -((y / H) * 2 - 1);
      const X = (ux + st.shift[0]) * st.f, Y = (uy + st.shift[1]) * st.f;
      const d = [r[0] * X + u[0] * Y + f[0], r[1] * X + u[1] * Y + f[1], r[2] * X + u[2] * Y + f[2]];
      if (d[1] >= -1e-3) return null;
      const t = st.pos[1] / -d[1];
      return [st.pos[0] + d[0] * t, st.pos[2] + d[2] * t, t];
    }
    #stepHeight(s) {
      const gl = this.gl, e = this.hmapP;
      gl.useProgram(e.p);
      const f = (n, v) => gl.uniform1f(this.#u(e, n), v);
      f("u_time", s.time); f("u_wave", s.wave); f("u_bulge", s.bulge); f("u_simL", this.simL); f("u_hL", this.hmapL); f("u_hN", this.hmapN);
      gl.uniform3fv(this.#u(e, "u_kpos"), s.kpos); gl.uniform4fv(this.#u(e, "u_mag"), s.mag); gl.uniform3fv(this.#u(e, "u_field"), s.field);
      gl.uniform4fv(this.#u(e, "u_menA"), s.menA ?? this.none); gl.uniform4fv(this.#u(e, "u_menB"), s.menB ?? this.none);
      gl.uniform4fv(this.#u(e, "u_chlA"), s.chlA); gl.uniform2fv(this.#u(e, "u_chlF"), s.chlF);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.simA.tex); gl.uniform1i(this.#u(e, "u_sim"), 0);
      this.#fsTri(this.hmap.fb, this.hmapN, this.hmapN);
    }
    #fsTri(fb, w, h) { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    #stepSim(dt) {
      const gl = this.gl, e = this.sim;
      this.simAcc = Math.min(this.simAcc + dt, 0.05);
      const arr = this.dropArr ??= new Float32Array(40), STEPS = 7;
      for (let n = 0; this.simAcc >= 1 / 60 && n < 2; n++) {
        this.simAcc -= 1 / 60;
        gl.useProgram(e.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.simA.tex);
        gl.uniform1i(this.#u(e, "u_prev"), 0);
        gl.uniform2f(this.#u(e, "u_texel"), 1 / this.simSize, 1 / this.simSize);
        gl.uniform1f(this.#u(e, "u_cell"), this.simL / this.simSize);
        // A drop arrives over a few steps, as a soft push: all at once, it is a pop in the sea.
        arr.fill(0);
        const live = this.pendingDrops;
        for (let i = 0; i < 10 && i < live.length; i++) {
          const d = live[i];
          arr[i * 4] = d.x; arr[i * 4 + 1] = d.z; arr[i * 4 + 2] = d.r;
          arr[i * 4 + 3] = d.s * (1 - Math.cos(2 * Math.PI * (d.n + .5) / STEPS)) / STEPS;
          d.n++;
        }
        for (let i = live.length - 1; i >= 0; i--) if (live[i].n >= STEPS) live.splice(i, 1);
        gl.uniform4fv(this.#u(e, "u_drops"), arr);
        this.#fsTri(this.simB.fb, this.simSize, this.simSize);
        [this.simA, this.simB] = [this.simB, this.simA];
      }
    }
    frame(s) {
      if (!this.ok || !this.ready || !this.baked) return false;
      const gl = this.gl;
      const dt = Math.min(.05, Math.max(0, s.time - this.last)); this.last = s.time;
      // The GPU's own clock, where it offers one, for how much of the screen to draw.
      const tq = this.timer;
      if (tq) {
        while (this.queries.length) {
          const q = this.queries[0];
          if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
          const bad = gl.getParameter(tq.GPU_DISJOINT_EXT), ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
          if (!bad) this.gpuMs = ns / 1e6;
          gl.deleteQuery(q); this.queries.shift();
        }
        if (this.queries.length < 4) { const q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); this.queries.push(q); this.timing = true; }
      }
      this.#stepSim(dt);
      this.#stepHeight(s);
      const igniting = s.ignite >= 0 && this.igniteReady;
      const e = igniting ? this.ignite : this.scene;
      gl.useProgram(e.p);
      const set1 = (n, v) => gl.uniform1f(this.#u(e, n), v);
      const loop = igniting ? this.igniteLoop : this.loop;
      const W = this.W, H = this.H;
      gl.uniform2f(this.#u(e, "u_res"), W, H); set1("u_aspect", this.CW / this.CH);
      const n = this.jitN = ((this.jitN ?? -1) + 1) % 16, j = JIT[n];
      gl.uniform2f(this.#u(e, "u_jit"), j[0], j[1]);
      const m = s.melt ?? 0;
      gl.uniform4fv(this.#u(e, "u_bandA"), s.bandA ?? this.none4); gl.uniform4fv(this.#u(e, "u_bandB"), s.bandB ?? this.none4); gl.uniform4fv(this.#u(e, "u_bandC"), s.bandC ?? this.none4); gl.uniform4fv(this.#u(e, "u_bandD"), s.bandD ?? this.none4); gl.uniform2fv(this.#u(e, "u_bandV"), s.bandV ?? this.still); set1("u_kOn", s.kOn ?? 1); set1("u_fuse", s.fuse ?? 0); set1("u_tube", s.tube ?? .19); set1("u_tubeOn", m >= 1 ? 0 : 1); set1("u_wob", s.wob ?? 0); set1("u_stepK", s.bandA ? .8 : .9);
      set1("u_beadK", s.beadK ?? .26); set1("u_bound", s.bound ?? 1.85);
      gl.uniform4fv(this.#u(e, "u_bead"), s.beads);
      gl.uniform4fv(this.#u(e, "u_slab"), s.slab); gl.uniform4fv(this.#u(e, "u_slabB"), s.slabB); gl.uniform4fv(this.#u(e, "u_slabC"), s.slabC); gl.uniform4fv(this.#u(e, "u_rip"), s.rip);
      gl.uniform4fv(this.#u(e, "u_view0"), s.view0 ?? this.view); gl.uniform4fv(this.#u(e, "u_view1"), s.view1 ?? this.view); gl.uniform2fv(this.#u(e, "u_slabMv"), s.slabMv ?? this.still); set1("u_slabEdge", s.slabEdge ?? 0);
      gl.uniform4fv(this.#u(e, "u_wall"), s.wall); gl.uniform2fv(this.#u(e, "u_wallB"), s.wallB ?? this.still);
      set1("u_time", s.time); set1("u_t", igniting ? Math.min(s.ignite / loop, .9995) : (s.lap % loop) / loop); set1("u_px", 360); set1("u_dark", s.dark); set1("u_tile", 0); set1("u_tiledark", 0); set1("u_aa", 1); set1("u_rest", 0);
      const { r, u, f } = basis(s.pos, s.tgt, s.roll, s.up);
      const krot = knotRot(s.krot);
      const cam = { pos: s.pos, f: s.f, shift: s.shift, m: new Float32Array([...r, ...u, ...f]), kpos: s.kpos, krot };
      // A jump between screens has no motion to follow.
      const prev = this.prev && Math.hypot(s.pos[0] - this.prev.pos[0], s.pos[1] - this.prev.pos[1], s.pos[2] - this.prev.pos[2]) < 4 ? this.prev : cam;
      set1("u_pf", prev.f); gl.uniform2fv(this.#u(e, "u_pshift"), prev.shift); gl.uniform3fv(this.#u(e, "u_ppos"), prev.pos);
      gl.uniformMatrix3fv(this.#u(e, "u_pcam"), false, prev.m); gl.uniform3fv(this.#u(e, "u_kposP"), prev.kpos); gl.uniformMatrix3fv(this.#u(e, "u_krotP"), false, prev.krot);
      gl.uniform4fv(this.#u(e, "u_mag"), s.mag);
      set1("u_krefl", s.krefl ?? 1); set1("u_plasma", s.plasma ?? 0); set1("u_seaTop", s.seaTop ?? 1);
      gl.uniform3fv(this.#u(e, "u_field"), s.field);
      gl.uniform3fv(this.#u(e, "u_pos"), s.pos);
      gl.uniformMatrix3fv(this.#u(e, "u_cam"), false, cam.m);
      set1("u_f", s.f); gl.uniform2fv(this.#u(e, "u_shift"), s.shift);
      gl.uniform3fv(this.#u(e, "u_kpos"), s.kpos); gl.uniformMatrix3fv(this.#u(e, "u_krot"), false, krot); set1("u_kscale", s.kscale);
      set1("u_wave", s.wave); set1("u_bulge", s.bulge);
      set1("u_flood", s.flood); set1("u_floodR", s.floodR);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, this.sdf); gl.uniform1i(this.#u(e, "u_sdf"), 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.env); gl.uniform1i(this.#u(e, "u_env"), 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.screens?.[s.texOld ?? 0] ?? this.dummy); gl.uniform1i(this.#u(e, "u_tex0"), 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.screens?.[s.texNew ?? 0] ?? this.dummy); gl.uniform1i(this.#u(e, "u_tex1"), 4);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.clone ?? this.dummy); gl.uniform1i(this.#u(e, "u_clone"), 7);
      gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, this.title ?? this.dummy); gl.uniform1i(this.#u(e, "u_title"), 8); gl.uniform4fv(this.#u(e, "u_titleP"), s.titleP ?? this.none4);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.envC); gl.uniform1i(this.#u(e, "u_envC"), 6);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.hmap.tex); gl.uniform1i(this.#u(e, "u_hmap"), 5); set1("u_hL", this.hmapL); set1("u_hN", this.hmapN);
      this.#fsTri(this.sceneT.fb, W, H);
      // accumulate
      const rs = this.resolve, a = this.histOK ? s.blend ?? .12 : 1;
      gl.useProgram(rs.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneT.tex); gl.uniform1i(this.#u(rs, "u_cur"), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.sceneT.depth); gl.uniform1i(this.#u(rs, "u_vel"), 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.hist[0].tex); gl.uniform1i(this.#u(rs, "u_hist"), 2);
      gl.uniform2f(this.#u(rs, "u_sz"), W, H); gl.uniform2f(this.#u(rs, "u_cap"), this.sceneT.w, this.sceneT.h); gl.uniform2f(this.#u(rs, "u_hsz"), this.CW, this.CH);
      gl.uniform2f(this.#u(rs, "u_jit"), j[0], j[1]);
      gl.uniform1f(this.#u(rs, "u_a"), a);
      this.#fsTri(this.hist[1].fb, this.CW, this.CH);
      this.hist.reverse(); this.histOK = true;
      // bloom
      const b = this.blur;
      gl.useProgram(b.p);
      gl.uniform1i(this.#u(b, "u_tex"), 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.hist[0].tex);
      gl.uniform2f(this.#u(b, "u_dir"), 1 / this.b1.w * 1.1, 0); gl.uniform1f(this.#u(b, "u_threshold"), mix1(.42, .62, s.paper));
      this.#fsTri(this.b1.fb, this.b1.w, this.b1.h);
      gl.bindTexture(gl.TEXTURE_2D, this.b1.tex);
      gl.uniform2f(this.#u(b, "u_dir"), 0, 1 / this.b1.h * 1.1); gl.uniform1f(this.#u(b, "u_threshold"), 0);
      this.#fsTri(this.b2.fb, this.b2.w, this.b2.h);
      // composite
      const c = this.comp;
      gl.useProgram(c.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.hist[0].tex); gl.uniform1i(this.#u(c, "u_scene"), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.b2.tex); gl.uniform1i(this.#u(c, "u_bloom"), 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.sceneT.depth); gl.uniform1i(this.#u(c, "u_vel"), 2);
      gl.uniform2f(this.#u(c, "u_sz"), W, H); gl.uniform2f(this.#u(c, "u_csz"), this.CW, this.CH);
      gl.uniform1f(this.#u(c, "u_shutter"), s.shutter ?? .7);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.title ?? this.dummy); gl.uniform1i(this.#u(c, "u_title"), 3); gl.uniform4fv(this.#u(c, "u_titleP"), s.titleP ?? this.none4);
      gl.uniform1f(this.#u(c, "u_dim"), s.dim); gl.uniform1f(this.#u(c, "u_time"), s.time % 100);
      gl.uniform1f(this.#u(c, "u_fade"), s.fade); gl.uniform1f(this.#u(c, "u_bloomA"), s.bloom); gl.uniform1f(this.#u(c, "u_paper"), s.paper); gl.uniform1f(this.#u(c, "u_grain"), mix1(.016, .006, s.paper));
      gl.uniform3fv(this.#u(c, "u_ground"), s.ground); gl.uniform1f(this.#u(c, "u_mono"), s.mono ?? 1); gl.uniform1f(this.#u(c, "u_scrimW"), s.scrimW ?? .2); gl.uniform1f(this.#u(c, "u_flash"), s.flash ?? 0); gl.uniform3fv(this.#u(c, "u_flashC"), s.flashC ?? [1, 1, 1]); gl.uniform1f(this.#u(c, "u_scrim"), s.scrim ?? 0); gl.uniform1f(this.#u(c, "u_scrimX"), s.scrimX ?? .55);
      this.#fsTri(null, this.CW, this.CH);
      if (this.timing) { gl.endQuery(tq.TIME_ELAPSED_EXT); this.timing = false; }
      this.prev = cam;
      return true;
    }
  }
  const canvasFail = (canvas) => canvas.dispatchEvent(new CustomEvent("world:lost", { bubbles: true }));
  World.basis = basis;
  World.SHAPE = SHAPE; World.WAY = WAY;
  window.World = World;
})();
