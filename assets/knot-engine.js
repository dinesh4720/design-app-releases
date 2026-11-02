// The mark, live: the app's own WebGL scene (the app's src/app/ui,
// bundled by tools/download-page-mark.mjs). It replaces the picture once it
// can draw; with less motion, or without WebGL, the picture stays.
(() => {
// Liquid chrome: a small WebGL2 raymarcher that draws the app's mark as a
// 3D object in polished metal, the way a product shot does (logo.js, through
// metal-mark.js; the shape and its motion are plasma.js). The metal has no
// colour of its own; it is the studio it mirrors: a cool white room with a
// big softbox up and to the left (the one light the brand keeps), a tall
// strip on the right, two black flags that lay the dark bands down the
// metal, and a darker floor under a sharp horizon. Chrome mirrors itself
// too (one bounce), and crevices darken. A dark studio (same lights, black
// walls) is the dark theme's version.
//
// A direction is a shape and its motion, written as GLSL:
//   float map(vec3 p)     signed distance to the shape (object space, y up,
//                         camera on +z looking at the origin)
// with these to use: u_time (s), u_t (0..1 through the loop, 0 = the rest
// pose), u_px (the mark's size in CSS px, for optical sizes), u_dark, and
// the helpers in METAL_HEAD. It may #define F0 (the metal's reflectance) and
// ROUGH (0 mirror .. 1 satin) before the shading, and CAM (camera distance)
// and FOV (degrees). Something that glows (the plasma) defines EMIT and
//   vec4 emit(vec3 p, vec3 n, vec3 F)   rgb: linear light added at a surface
//                                       point (its own glow, and the light a
//                                       glowing part casts on nearby metal);
//                                       a: how much of the reflection there
//                                       it replaces. Also called where the
//                                       metal mirrors itself (EMIT_MIRROR)
// and, for a soft glow in the air round it, HALO and
//   vec4 halo(vec3 ro, vec3 rd, float t)  rgb (linear, to 1) and cover, for
//                                         a ray (t: where it hits, or -1).
// Both get points, normals and rays in map()'s space.
//
// One WebGL context draws every mark on the page: each frame it renders a
// mark into the shared canvas and copies it into that mark's own 2D canvas.
// The lab that tunes it (renders, sheets, icons, timing) is brand/metal.

const METAL_HEAD = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time, u_t, u_px, u_dark, u_tile, u_aa, u_rest, u_tiledark;
uniform vec2 u_tilt;
out vec4 outColor;
#define TAU 6.28318530718
#define PI 3.14159265359
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * .25; }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }
float sdSphere(vec3 p, float r) { return length(p) - r; }
float sdTorus(vec3 p, vec2 t) { vec2 q = vec2(length(p.xy) - t.x, p.z); return length(q) - t.y; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h) - r; }
float sdRoundBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.) - r; }
float ease(float x) { x = clamp(x, 0., 1.); return x * x * (3. - 2. * x); }
float wrapd(float a) { return mod(a + .5, 1.) - .5; }

// The trefoil: a (2,3) torus knot around the z axis, a lobe pointing up.
// R and r set its size (lobes reach R + r, the middle R - r); h is how far
// the strands swing in depth (h sin 3t), which sets the air between them at
// the crossings. trefoilAt(t) is the centre line, t in 0..1 once round,
// t = 0 at the tip of the top lobe.
vec3 trefoilAt(float t, float R, float r, float h) {
  float a = TAU * t, rho = R + r * cos(3. * a), ph = 2. * a + PI * .5;
  return vec3(rho * cos(ph), rho * sin(ph), h * sin(3. * a));
}
// Distance to the centre line: x = distance, y = t (0..1) there. In the
// plane through the z axis and p, the knot passes at two points (k = 0, 1);
// the distance to each is measured across the strand's slant (exact for a
// straight run), so the tube stays round where it runs steeply.
vec2 trefoil(vec3 p, float R, float r, float h) {
  float ang = atan(p.y, p.x + 1e-6) - PI * .5;
  vec2 mp = vec2(length(p.xy), p.z);
  vec2 best = vec2(1e9, 0.);
  for (int k = 0; k < 2; k++) {
    float a = (ang + TAU * float(k)) * .5;
    float c3 = cos(3. * a), s3 = sin(3. * a), rho = R + r * c3;
    vec2 q = mp - vec2(rho, h * s3);
    vec3 T = vec3(-3. * r * s3, 2. * rho, 3. * h * c3);
    float L = length(T), cb = T.y / L;
    vec2 u = normalize(T.xz + vec2(1e-6, 0.));
    float al = dot(q, u), be = dot(q, vec2(-u.y, u.x));
    float d = sqrt(al * al * cb * cb + be * be);
    float t = (a + al * length(T.xz) / (L * L)) / TAU;
    t -= floor(t);
    float pick = step(d, best.x);
    best = mix(best, vec2(d, t), pick);
  }
  return vec2(best.x, clamp(best.y, 0., 1.));
}
// The knot as the logo draws it: the classic trefoil (sin t + 2 sin 2t,
// 2 cos 2t - cos t), depth -H sin 3t. Lobes reach 3S from the centre, the
// inner turns 1S. knotAt(u) is the centre line, u in 0..1 once round, u = 0
// at the tip of the top lobe; knot(p) is x = distance to it, y = u there.
// Solved like trefoil(): the two points where the curve crosses p's
// meridian (Newton on the angle, which always turns the same way), then the
// distance across the strand's slant.
vec3 knotAt(float u, float S, float H) {
  float t = TAU * u + PI;
  return vec3(S * (sin(t) + 2. * sin(2. * t)), S * (2. * cos(2. * t) - cos(t)), -H * sin(3. * t));
}
vec2 knot(vec3 p, float S, float H) {
  float target = atan(p.y, p.x + 1e-6);
  vec2 mp = vec2(length(p.xy), p.z);
  vec2 best = vec2(1e9, 0.);
  for (int k = 0; k < 2; k++) {
    float t = (PI * .5 - target) * .5 + PI * float(k);
    for (int i = 0; i < 3; i++) {
      float c3 = cos(3. * t), s3 = sin(3. * t);
      float e = mod(-PI * .5 - 2. * t + atan(s3, c3 - 2.) - target + PI, TAU) - PI;
      t -= e / (-2. + 3. * (1. - 2. * c3) / (5. - 4. * c3));
    }
    float s1 = sin(t), c1 = cos(t), s2 = sin(2. * t), c2 = cos(2. * t);
    vec2 P = S * vec2(s1 + 2. * s2, 2. * c2 - c1);
    vec2 D = S * vec2(c1 + 4. * c2, s1 - 4. * s2);
    float rho = length(P);
    vec2 er = P / rho;
    vec3 T = vec3(dot(D, er), dot(D, vec2(-er.y, er.x)), -3. * H * cos(3. * t));
    vec2 q = mp - vec2(rho, -H * sin(3. * t));
    float L = length(T), cb = T.y / L;
    vec2 w = normalize(T.xz + vec2(1e-6, 0.));
    float al = dot(q, w), be = dot(q, vec2(-w.y, w.x));
    float d = sqrt(al * al * cb * cb + be * be);
    float u = (t + al * length(T.xz) / (L * L)) / TAU - .5;
    u -= floor(u);
    float pick = step(d, best.x);
    best = mix(best, vec2(d, u), pick);
  }
  return vec2(best.x, clamp(best.y, 0., 1.));
}
vec3 trefoilAt(float t, float R, float r) { return trefoilAt(t, R, r, r); }
vec2 trefoil(vec3 p, float R, float r) { return trefoil(p, R, r, r); }
`;

const METAL_SHADE = `
#ifndef F0
#define F0 vec3(.93, .935, .945)
#endif
#ifndef ROUGH
#define ROUGH 0.
#endif
#ifndef CAM
#define CAM 7.
#endif
#ifndef FOV
#define FOV 30.
#endif
#ifndef DISP
#define DISP .5
#endif
// How strongly a glow shows where the metal mirrors it (1 = a perfect
// mirror, which floods a knot with its own light).
#ifndef EMIT_MIRROR
#define EMIT_MIRROR 1.
#endif

float box(float az, float el, vec4 r, float s) {
  vec2 d = abs(vec2(mod(az - r.x + PI, TAU) - PI, el - r.y)) - r.zw;
  return 1. - smoothstep(-s, s, max(d.x, d.y));
}
// The studio, by direction. Linear light; the lights go past 1.
vec3 studio(vec3 d, float blur) {
  float az = atan(d.x, d.z), el = asin(clamp(d.y, -1., 1.));
  float s = .025 + blur;
  float up = smoothstep(-s, s, el + .04);
  vec3 wallL = mix(vec3(.62, .645, .68), vec3(.93, .945, .97), smoothstep(-.05, 1.1, el));
  vec3 floorL = mix(vec3(.30, .305, .315), vec3(.12, .125, .13), smoothstep(0., -1.2, el));
  vec3 wallD = mix(vec3(.07, .072, .08), vec3(.2, .205, .22), smoothstep(-.05, 1.1, el));
  vec3 floorD = vec3(.022, .022, .025);
  vec3 c = mix(mix(floorL, wallL, up), mix(floorD, wallD, up), u_dark);
  // Black flags: the dark bands chrome is read by.
  c *= 1. - .92 * box(az, el, vec4(.62, .15, .07, 1.3), s);
  c *= 1. - .85 * box(az, el, vec4(-1.25, .1, .16, 1.3), s * 1.5);
  c *= 1. - .75 * box(az, el, vec4(2.75, .25, .22, 1.1), s * 2.);
  // The key: a big softbox up and to the left, in front of the object.
  c += 2.6 * box(az, el, vec4(-.5, .62, .42, .26), .06 + s * 2.) * vec3(1., .99, .97);
  // A tall strip on the right and a thin one behind for the rims.
  c += 2.2 * box(az, el, vec4(1.05, .12, .07, .9), .02 + s) * vec3(.97, .99, 1.);
  c += 1.6 * box(az, el, vec4(-2.35, .2, .05, .8), .02 + s);
  c += 1.2 * box(az, el, vec4(2.2, .5, .1, .5), .03 + s);
  // A low bounce card, so the undersides aren't dead.
  c += .35 * box(az, el, vec4(0., -.55, 1.2, .18), .2 + s) * (1. - u_dark * .6);
  return c;
}
#ifndef TILE_SCALE
#define TILE_SCALE .64
#endif
// World (camera) space to the direction's own space: the pointer's tilt,
// then the tile's scale. Directions with light of their own (EMIT, HALO)
// get their points, normals and rays in this space.
vec3 dirToMap(vec3 d) {
  d.xz *= rot(u_tilt.x * .45);
  d.yz *= rot(-u_tilt.y * .35);
  return d;
}
vec3 toMap(vec3 p) { return dirToMap(p) / mix(1., TILE_SCALE, u_tile); }
float sceneMap(vec3 p) {
  return map(toMap(p)) * mix(1., TILE_SCALE, u_tile);
}
vec3 normal(vec3 p, float e) {
  vec2 k = vec2(1, -1);
  return normalize(k.xyy * sceneMap(p + k.xyy * e) + k.yyx * sceneMap(p + k.yyx * e) + k.yxy * sceneMap(p + k.yxy * e) + k.xxx * sceneMap(p + k.xxx * e));
}
float march(vec3 ro, vec3 rd, float far, float px, int steps) {
  float t = 0.;
  for (int i = 0; i < 160; i++) {
    if (i >= steps) break;
    float d = sceneMap(ro + rd * t);
    if (d < px * max(t, 1.)) return t;
    t += d * .8;
    if (t > far) break;
  }
  return -1.;
}
float occlusion(vec3 p, vec3 n) {
  float o = 0., w = 1.;
  for (int i = 1; i <= 5; i++) {
    float h = .03 + .09 * float(i);
    o += (h - sceneMap(p + n * h)) * w;
    w *= .7;
  }
  return clamp(1. - 1.6 * o, 0., 1.);
}
vec3 mirror(vec3 r, vec3 n, float blur) {
  vec3 c = studio(r, blur);
  float k = DISP * .045 * (1. - abs(dot(r, n)));
  return vec3(studio(normalize(r + n * k), blur).r, c.g, studio(normalize(r - n * k), blur).b);
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }

// The app-icon tile behind the mark: a rounded square (macOS's 22.5%
// corner), lit from the top left, the mark standing just in front of it and
// casting a soft shadow down and to the right.
vec4 tile(vec2 uv, vec3 ro, vec3 rd) {
  vec2 q = abs(uv) - vec2(.5 - .225);
  float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - .225;
  float a = 1. - smoothstep(-.0025, .0025, d);
  // Display colours (not tone mapped): near white to a cool grey, or graphite.
  vec3 top = mix(vec3(.976, .98, .984), vec3(.215, .222, .238), u_tiledark);
  vec3 bot = mix(vec3(.85, .862, .878), vec3(.078, .082, .09), u_tiledark);
  vec3 c = mix(bot, top, smoothstep(-.55, .5, uv.y - uv.x * .25));
  c += (1. - u_tiledark * .5) * .05 * exp(-dot(uv - vec2(-.3, .32), uv - vec2(-.3, .32)) * 6.);
  float z = -.75 * TILE_SCALE, t = (z - ro.z) / rd.z;
  vec3 p = ro + rd * t, l = normalize(vec3(-.45, .7, 1.));
  float sh = 1., h = .03;
  for (int i = 0; i < 32; i++) {
    float dd = sceneMap(p + l * h);
    sh = min(sh, 9. * dd / h);
    h += clamp(dd, .02, .25);
    if (h > 3.) break;
  }
  c *= mix(mix(.72, .55, u_tiledark), 1., smoothstep(0., 1., clamp(sh, 0., 1.)));
  // A hairline of light along the top edge, a darker one along the bottom.
  float edge = 1. - smoothstep(0., .01, abs(d + .007));
  c += edge * mix(.1, .06, u_tiledark) * smoothstep(-.2, .4, uv.y);
  c -= edge * .05 * smoothstep(.1, -.4, uv.y);
  return vec4(c, a);
}

void main() {
  vec2 res = u_res;
  float n = u_aa;
  vec4 acc = vec4(0);
  float fov = tan(radians(FOV) * .5);
  vec3 ro = vec3(0, 0, CAM);
  float px = 2. * fov / res.y;
  int steps = res.y < 80. ? 70 : 110;
  for (float j = 0.; j < 3.; j++) {
    if (j >= n) break;
    for (float i = 0.; i < 3.; i++) {
      if (i >= n) break;
      vec2 off = (vec2(i, j) + .5) / n - .5;
      vec2 uv = (gl_FragCoord.xy + off - res * .5) / res.y;
      vec3 rd = normalize(vec3(uv * 2. * fov, -1.));
      vec4 bg = u_tile > .5 ? tile(uv * 1.0, ro, rd) : vec4(0);
      float t = march(ro, rd, CAM + 4., px * .5, steps);
#ifdef HALO
      // Light in the air round a glowing part: rgb (linear, up to 1) and how
      // much it covers.
      vec4 h = halo(toMap(ro), dirToMap(rd), t);
      // Round, and gone before the frame's edge, so a glow never shows the
      // canvas's square.
      h.a *= smoothstep(.5, .36, length(uv * vec2(res.y / res.x, 1.)));
#else
      vec4 h = vec4(0);
#endif
      if (t < 0.) {
        vec4 b = vec4(pow(max(bg.rgb, 0.), vec3(2.2)) * bg.a, bg.a);
        acc += vec4(h.rgb * h.a, h.a) + b * (1. - h.a);
        continue;
      }
      vec3 p = ro + rd * t;
      vec3 nn = normal(p, max(px * t * .5, .0008));
      vec3 r = reflect(rd, nn);
      float ndv = clamp(dot(nn, -rd), 0., 1.);
      vec3 F = F0 + (1. - F0) * pow(1. - ndv, 5.);
      float blur = ROUGH * .35;
      // One bounce: the metal mirrors itself.
      vec3 col;
      float t2 = march(p + nn * .01, r, 5., px * 2., 48);
      if (t2 > 0.) {
        vec3 p2 = p + nn * .01 + r * t2;
        vec3 n2 = normal(p2, .002);
        vec3 r2 = reflect(r, n2);
        col = studio(r2, blur + .05) * F0 * .9 * mix(.5, 1., occlusion(p2, n2));
#ifdef EMIT
        // A glowing part seen in the metal next to it.
        vec4 e2 = emit(toMap(p2), dirToMap(n2), F0) * EMIT_MIRROR;
        col = col * (1. - e2.a) + e2.rgb;
#endif
      } else {
        col = mirror(r, nn, blur);
      }
      col *= F * mix(.35, 1., occlusion(p, nn));
#ifdef EMIT
      // Light of the direction's own: what glows on this surface (replacing
      // that much of the reflection), and what a glowing part nearby casts
      // on it.
      vec4 e1 = emit(toMap(p), dirToMap(nn), F);
      col = col * (1. - e1.a) + e1.rgb;
#endif
      col += h.rgb * h.a;
      acc += vec4(aces(col * 1.08), 1.);
    }
  }
  acc /= n * n;
  // Display gamma; premultiplied for the page.
  vec3 c = pow(max(acc.rgb, 0.) / max(acc.a, 1e-4), vec3(1. / 2.2)) * acc.a;
  // A little dither, so faint glows don't band into rings at 8 bits.
  float dn = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715)))) - .5) / 255.;
  outColor = clamp(vec4(c + dn * step(.002, acc.a), acc.a + dn * step(.002, acc.a) * (1. - acc.a)), 0., 1.);
}
`;

const METAL_VERT = `#version 300 es
in vec2 a; void main() { gl_Position = vec4(a, 0, 1); }`;

// The shared renderer.
let metalShared = null;
function metalEngine() {
  if (metalShared) return metalShared;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
  if (!gl) return (metalShared = { ok: false });
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const programs = new Map();
  const compile = (direction) => {
    const key = direction.key;
    if (programs.has(key)) return programs.get(key);
    const make = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${key}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, make(gl.VERTEX_SHADER, METAL_VERT));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, METAL_HEAD + direction.glsl + METAL_SHADE));
    gl.bindAttribLocation(prog, 0, "a");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`${key}: ${gl.getProgramInfoLog(prog)}`);
    const u = {};
    for (const name of ["u_res", "u_time", "u_t", "u_px", "u_dark", "u_tile", "u_aa", "u_rest", "u_tilt", "u_tiledark"]) u[name] = gl.getUniformLocation(prog, name);
    const entry = { prog, u };
    programs.set(key, entry);
    return entry;
  };
  // Draw one frame of a direction; the pixels are in the canvas's bottom-left
  // w x h until the task ends.
  // tileDark: the icon tile's own colour (graphite or light), apart from the
  // studio the metal mirrors (dark); by default the same.
  const draw = (direction, { w, h, time = 0, loop = direction.loop || 4, px = h, dark = 0, tile = 0, aa, rest = 0, tilt = [0, 0], tileDark = dark }) => {
    if (canvas.width < w || canvas.height < h) {
      canvas.width = Math.max(canvas.width, w);
      canvas.height = Math.max(canvas.height, h);
    }
    const { prog, u } = compile(direction);
    gl.useProgram(prog);
    gl.viewport(0, 0, w, h);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(u.u_res, w, h);
    gl.uniform1f(u.u_time, time);
    gl.uniform1f(u.u_t, (((time / loop) % 1) + 1) % 1);
    gl.uniform1f(u.u_px, px);
    gl.uniform1f(u.u_dark, dark);
    gl.uniform1f(u.u_tiledark, tileDark);
    gl.uniform1f(u.u_tile, tile);
    gl.uniform1f(u.u_aa, aa ?? (h <= 96 ? 3 : 2));
    gl.uniform1f(u.u_rest, rest);
    gl.uniform2f(u.u_tilt, tilt[0], tilt[1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  // Draw and copy into a 2D context at (x, y).
  const paint = (ctx, direction, opts, x = 0, y = 0) => {
    draw(direction, opts);
    ctx.drawImage(canvas, 0, canvas.height - opts.h, opts.w, opts.h, x, y, opts.w, opts.h);
  };
  return (metalShared = { ok: true, gl, canvas, compile, draw, paint });
}

// The app's mark (logo.js), drawn by metal.js: the plasma knot, and the two
// ways it plays, KNOT (the loop every loader and logo runs) and IGNITION
// (the onboarding's finale).
//
// The plasma knot: the trefoil in polished chrome, still and face-on, with
// a pulse of plasma riding inside the tube, white-hot at its core, red at
// its leading edge and blue in its trail (today's pulse colours, app.css
// --mark-lead / --mark-trail). It lights the chrome round it and the strands
// it passes under, throws a bloom into the air, and shows, faintly, in the
// strands that mirror it. Run fast enough, its comet tail wraps the whole
// knot into one ring of light.
//
// A direction gives a GLSL `void timeline(float t)` (t in seconds) that sets
// the pulse's state: gU (where it is, 0..1 round the knot, 0 = the top
// lobe's tip), gV (how fast, 0..1, which draws the comet out), gE (how much
// light it throws), gTrail (the tail's length, arc units), gFlare, gRip and
// gRipA (the flare and ripple as it seats), gRing (0..1, the tail wrapped
// into a ring), gWhite (0..1, white-hot) and gBloom (the bloom's reach).

const PL_TAU = 2 * Math.PI;
const PL_S = .42;
// The knot's length (arc units), so the pulse is sized in the tube's units.
const PL_LEN = (() => {
  let len = 0;
  for (let i = 0; i < 4096; i++) {
    const c3 = Math.cos(3 * (PL_TAU * (i + .5) / 4096 + Math.PI));
    len += PL_TAU * Math.sqrt(PL_S * PL_S * (17 + 8 * c3) + 9 * .4 * .4 * c3 * c3) / 4096;
  }
  return len;
})();
// Straight: a long lens, so the outline has no perspective (near strands
// drawn bigger made the knot look turned) and is mirror-symmetric, framed
// as the default camera frames it (half-height 1.876 at the knot).
const PL_CAM = 28;
const PL_FOV = 2 * Math.atan(7 * Math.tan(Math.PI / 12) / PL_CAM) * 180 / Math.PI;
// Centred on its bounding box: the top lobe reaches 3S, the lower two
// 2.0625S down (the curve's lowest point, where cos t = 1/8).
const PL_LIFT = (3 - 2.0625) / 2 * PL_S;
const f5 = (x) => x.toFixed(5);

const plasmaKnot = (timeline) => `
#define KLEN ${f5(PL_LEN)}
#define KS ${f5(PL_S)}
#define CAM ${f5(PL_CAM)}
#define FOV ${f5(PL_FOV)}
// Polished, with the studio's band edges softened a touch so the chrome
// reads liquid rather than wire-drawn; satin and no fringes when small, so
// 16 px isn't a scatter of glints. In the dark studio a small tube is
// blurred further, into a soft silver form; small on a light page, darker
// steel keeps the shape and its holes.
#define ROUGH mix(mix(1.2, .1, smoothstep(14., 36., u_px)), mix(mix(2.4, .8, smoothstep(14., 30., u_px)), .1, smoothstep(30., 64., u_px)), u_dark)
#define DISP (.5 * smoothstep(20., 48., u_px))
#define F0 (vec3(.93, .935, .945) * (1. - .6 * (1. - smoothstep(20., 44., u_px)) * (1. - u_dark)))
#define TILE_SCALE mix(.86, .75, smoothstep(40., 160., u_px))
#define EMIT
#define HALO
// The strands round the pulse mirror its glow: a third of it, so the knot
// is lit by the pulse rather than filled with it.
#define EMIT_MIRROR .32

bool poseReady = false;
float KH, zoom, small;
float gU, gV, gE, gTrail, gFlare, gRip, gRipA, gRing, gWhite, gBloom;
vec3 cRed, cBlue;
// The pulse's size: small, it is bigger, to read at 16 px.
float pulseR() { return mix(.17, .3, small); }
${timeline}
// The moment, worked out on a pixel's first call.
void pose() {
  small = 1. - smoothstep(18., 96., u_px);
  zoom = mix(1., 1.04, small);
  // The strands' swing in depth: shallow when large (smooth slivers at the
  // crossings), deeper when small to keep the holes open.
  KH = mix(.5, .4, smoothstep(20., 48., u_px));
  gRing = 0.; gWhite = 0.; gBloom = 1.; gFlare = 0.; gRip = 0.; gRipA = 0.;
  timeline(u_t * LOOP);
  // Today's pulse colours (app.css --mark-lead / --mark-trail), as light.
  cRed = mix(vec3(.78, .034, .05), vec3(1., .07, .107), u_dark);
  cBlue = mix(vec3(.005, .32, .69), vec3(.03, .66, 1.), u_dark);
}
vec3 toKnot(vec3 p) { return p / zoom + vec3(0, ${f5(PL_LIFT)}, 0); }
// Distance to the centre line and u there, tightened: knot() is off by up
// to ~.03 on the lobes' sides, which chrome shows as a tube that isn't round,
// so two Newton steps on the true closest point from its answer.
vec2 knotFine(vec3 p) {
  float t = TAU * knot(p, KS, KH).y + PI;
  for (int i = 0; i < 2; i++) {
    float s1 = sin(t), c1 = cos(t), s2 = sin(2. * t), c2 = cos(2. * t), s3 = sin(3. * t), c3 = cos(3. * t);
    vec3 r = vec3(KS * (s1 + 2. * s2), KS * (2. * c2 - c1), -KH * s3) - p;
    vec3 d1 = vec3(KS * (c1 + 4. * c2), KS * (s1 - 4. * s2), -3. * KH * c3);
    vec3 d2 = vec3(-KS * (s1 + 8. * s2), KS * (c1 - 8. * c2), 9. * KH * s3);
    t += clamp(-dot(r, d1) / max(dot(d1, d1) + dot(r, d2), .5), -.3, .3);
  }
  vec3 c = vec3(KS * (sin(t) + 2. * sin(2. * t)), KS * (2. * cos(2. * t) - cos(t)), -KH * sin(3. * t));
  return vec2(length(p - c), fract((t - PI) / TAU));
}
// The swelling the pulse makes (s is arc length from its centre, + ahead).
// It smooths out as the tail wraps into a ring.
float swell(float s) {
  float r = pulseR() * 1.1;
  float w = s >= 0. ? r : r * (1. + 1.2 * gV);
  return mix(.04, .065, max(gV, small * .6)) * (1. + .45 * gFlare) * exp(-s * s / (w * w)) * (1. - gRing);
}
float map(vec3 p) {
  if (!poseReady) { pose(); poseReady = true; }
  // Far off, a sphere round it is cheaper and safe.
  vec3 q = toKnot(p);
  float bound = length(q) - 1.85;
  if (bound > .5) return bound * zoom;
  vec2 k = knotFine(q);
  float s = wrapd(k.y - gU) * KLEN;
  float tube = mix(.19, .195, small);
  return (k.x - tube - swell(s)) * .85 * zoom;
}
// A point light that dies out within about r (plasma lights only the metal
// right round it), on a surface facing it.
vec3 lamp(vec3 q, vec3 n, vec3 at, vec3 c, float r) {
  vec3 d = at - q;
  float dd = dot(d, d);
  return c * max(dot(n, d) * inversesqrt(dd + 1e-6), 0.) * exp(-dd / (r * r));
}
vec4 emit(vec3 pm, vec3 n, vec3 F) {
  if (!poseReady) { pose(); poseReady = true; }
  vec3 q = toKnot(pm);
  float s = wrapd(knot(q, KS, KH).y - gU) * KLEN;
  // How far behind the pulse this is, round the knot (the tail of a fast
  // pulse wraps all the way round).
  float sb = s <= 0. ? -s : KLEN - s;
  float rc = pulseR();
  vec3 white = vec3(1., .94, .92);
  // The plasma: a white-hot core, the red edge it leads with, the blue it
  // leaves behind as a comet's tail, fading off exponentially. Once the
  // tail is a ring there is no head to see: the core and edge fade into it.
  float head = 1. - .85 * gRing;
  float core = exp(-s * s / (rc * rc * .35)) * head;
  float lead = exp(-pow(max(s, 0.) / (rc * 1.15), 2.)) * smoothstep(-.03, .09, s) * head;
  float trail = exp(-sb / gTrail) * mix(1., smoothstep(.03, -.09, s), exp(-s * s / .04)) * (1. - .25 * gV * (1. - gRing));
  // The tube carries its light on: a faint glow inside the metal ahead (red)
  // and behind (blue), as in a light pipe.
  float pipeA = exp(-max(s, 0.) / .22) * smoothstep(-.02, .1, s) * head;
  float pipeB = exp(-sb / (.26 + .2 * gV)) * smoothstep(-.02, .1, sb);
  // The ripple after it seats: red runs on ahead, blue runs back.
  float ripR = exp(-pow((s - gRip) / .13, 2.)) * gRipA;
  float ripB = exp(-pow((s + gRip) / .13, 2.)) * gRipA;
  float hot = gE * mix(1., 1.25, small);
  vec3 red = mix(cRed, white, gWhite * .6), blue = mix(cBlue, white, gWhite);
  vec3 glow = core * white * 3.2 * hot
    + (lead * 2.6 + pipeA * .3) * red * hot + ripR * cRed * 2.6
    + (trail * 2.6 + pipeB * .3) * blue * hot + ripB * cBlue * 2.6;
  // White-hot, the metal's form still shows through the light.
  float cover = clamp(core + .85 * max(lead, trail) + .3 * max(pipeA, pipeB) + .6 * max(ripR, ripB), 0., mix(.95, .62, gWhite));
  // Its light on the metal round it: white from the core, red ahead, blue
  // behind; strong enough that a strand crossing over it lights up from
  // underneath as it passes. A ring lights everything near it.
  vec3 c = knotAt(gU, KS, KH);
  vec3 ahead = knotAt(gU + .03, KS, KH), behind = knotAt(gU - .03 - .03 * gV, KS, KH);
  vec3 light = (lamp(q, n, c, white * 1.6, .5) + lamp(q, n, ahead, red * 1.4, .45)) * head
    + lamp(q, n, behind, blue * 1.2, .45 + .08 * gV)
    + blue * .35 * gRing * (.6 + .4 * max(n.z, 0.));
  return vec4(glow + light * (F * .6 + .4) * gE, cover);
}
// The light it throws into the air: a hot bloom round the core, a red
// glow ahead, blue along the comet's tail, a wide faint wash, and once the
// tail is a ring, a glow along the whole knot; in both studios (a neon glow
// on a white wall is still a glow).
float bloom(vec3 o, vec3 d, vec3 at, float r, float t) {
  float tc = dot(at - o, d);
  vec3 cl = o + d * tc - at;
  float g = exp(-dot(cl, cl) / (r * r));
  // Behind a strand in front of it, mostly hidden.
  if (t > 0. && t / (mix(1., TILE_SCALE, u_tile) * zoom) < tc - .22) g *= .3;
  return g;
}
vec4 halo(vec3 ro, vec3 rd, float t) {
  if (!poseReady) { pose(); poseReady = true; }
  vec3 o = toKnot(ro);
  float k = mix(1., 1.35, small) * gBloom;
  float du = .03 / KLEN * 9.;
  float head = 1. - .85 * gRing;
  vec3 c = knotAt(gU, KS, KH);
  float wc = bloom(o, rd, c, .26 * k, t) * 1.1 * head;
  float wr = bloom(o, rd, knotAt(gU + du, KS, KH), .3 * k, t) * .9 * head;
  float wb = 0.;
  for (int i = 1; i <= 3; i++) {
    float f = float(i);
    wb += bloom(o, rd, knotAt(gU - du * f * (.8 + .7 * gV), KS, KH), .26 * k, t) * exp(-f * .8) * (.45 + .35 * gV) * head;
  }
  float wide = bloom(o, rd, c, .55 * k, t) * .2;
  // The ring's glow: how far the ray passes from the knot where it crosses
  // the knot's plane.
  vec3 pz = o + rd * (-o.z / rd.z);
  float dr = knot(pz, KS, KH).x;
  float wring = exp(-dr * dr / (.09 * k * k)) * gRing * 1.2;
  vec3 white = vec3(1., .94, .92);
  vec3 red = mix(cRed, white, gWhite * .6), blue = mix(cBlue, white, gWhite);
  vec3 sum = wc * white + (wr + wide * .5) * red + (wb + wide * .5 + wring) * blue;
  float wsum = wc + wr + wb + wide + wring;
  float w = wsum * gE;
  // How much it covers: more in the dark studio, where light is all there is.
  // A soft curve, so a strong glow still fades out from the light rather
  // than filling a flat disc.
  float a = w / (1. + w) * mix(.6, .9, u_dark);
  // Over the metal, the glow is the thin air in front of it: much less
  // of it, so the chrome under it stays chrome (until it whites out).
  if (t > 0.) a *= mix(.35, 1., gWhite * gRing);
  return vec4(sum / max(wsum, 1e-4), a);
}
`;

// KNOT, the mark's loop. The trefoil lies still,
// straight and face-on in polished chrome, and the plasma pulse (plasma.mjs)
// does the moving: it eases away from the top lobe, runs once round the knot
// (drawn out into a comet as it gathers speed, burning brighter), and brakes
// back into the top. The payoff is the seating: it flares, and a ripple of
// red and blue light runs off down the tube both ways and fades. Rest pose
// (t = 0): the plasma parked on the top lobe, as the old pulse parked. The
// knot itself never moves (no flick, no lift, no rattle: each was tried and
// taken out).

const EU_LOOP = 3.2;
const EU_TP = .1;   // the pulse leaves the top, s
const EU_TL = 2.35; // and is home again, s
// The pulse's top speed (laps/s), to read its speed as 0..1 in the shader.
let EU_VMAX = 0;
for (let i = 1; i < 1000; i++) {
  const x = i / 1000, e = x ** 1.25;
  EU_VMAX = Math.max(EU_VMAX, 30 * e * e * (e - 1) ** 2 * 1.25 * x ** .25 / (EU_TL - EU_TP));
}
const eu = (x) => x.toFixed(5);

const KNOT = {
  key: "plasma-knot",
  name: "Plasma knot",
  loop: EU_LOOP,
  glsl: `
#define LOOP ${eu(EU_LOOP)}
#define TL ${eu(EU_TL)}
#define TP ${eu(EU_TP)}
#define VMAX ${eu(EU_VMAX)}
${plasmaKnot(`
void timeline(float t) {
  // Eases away from the top, fastest late in the lap, brakes into the top.
  float xp = clamp((t - TP) / (TL - TP), 0., 1.);
  float e = pow(xp, 1.25);
  gU = t >= TL ? 0. : e * e * e * (e * (e * 6. - 15.) + 10.);
  gV = t > TP && t < TL ? 30. * e * e * (e - 1.) * (e - 1.) * 1.25 * pow(xp, .25) / (TL - TP) / VMAX : 0.;
  gTrail = pulseR() * (.55 + 1.1 * gV);
  // The seating: it flares, and a ripple of light runs off both ways and
  // fades; all of it gone before the loop wraps.
  float since = t - TL, fade = 1. - smoothstep(LOOP - .45, LOOP - .05, t);
  gFlare = (since < 0. ? smoothstep(-.08, 0., since) : exp(-since / .24)) * fade;
  gRip = max(since, 0.) * 3.;
  gRipA = since > 0. ? (1. - exp(-since / .04)) * exp(-since / .34) * fade : 0.;
  // Steady when parked, brighter the faster it runs, brightest as it seats.
  gE = .65 + .55 * gV + 1.1 * gFlare;
}
`)}
`,
};

// IGNITION: the onboarding's last moment, played once, not looped. It
// starts from the mark's rest pose (the plasma parked on the top lobe) and
// the pulse sets off slowly, then speeds up without limit: its speed is
// W0 / (1 - t/T)^P, which runs to infinity at T. As it goes faster it burns
// brighter and its comet tail draws out (the smear of a frame's exposure)
// until it wraps the whole knot: no head left, one ring of light, going
// white-hot. At T it flashes and the bloom floods out, and the app opens
// from it (the page's job, not the mark's).

const IG_T = 3;      // infinity, s
const IG_DUR = 3.2;  // the flash after it, brief: the page takes over
const IG_W0 = .3;    // laps/s when it sets off
const IG_P = 1.6;
const ig = (x) => x.toFixed(5);

const IGNITION = {
  key: "plasma-ignite",
  name: "Ignition",
  loop: IG_DUR,
  once: true,
  // When it flashes: what mark.ignite() resolves at.
  flash: IG_T,
  glsl: `
#define LOOP ${ig(IG_DUR)}
#define T_INF ${ig(IG_T)}
#define W0 ${ig(IG_W0)}
#define P ${ig(IG_P)}
${plasmaKnot(`
void timeline(float t) {
  float x = min(t / T_INF, .9992);
  // Laps travelled (the integral of the speed), eased off the rest.
  float ease = smoothstep(0., .7, t);
  float laps = W0 * T_INF / (P - 1.) * (pow(1. - x, 1. - P) - 1.) * ease;
  float speed = W0 * pow(1. - x, -P) * ease;
  gU = fract(laps);
  gV = clamp(speed / 2.5, 0., 1.);
  // The tail is what a frame's exposure smears: at about 45 laps/s it
  // reaches all the way round.
  gTrail = pulseR() * .55 + speed * KLEN / 45.;
  gRing = smoothstep(6., 40., speed);
  float since = t - T_INF;
  float flash = smoothstep(-.06, .04, since);
  gWhite = max(smoothstep(25., 90., speed), flash);
  // Its light climbs with its speed, up to a point: past ~120 laps/s it is
  // all one ring already.
  gE = .7 + .38 * log2(1. + min(speed, 120.)) + flash;
  gBloom = 1. + .55 * gRing + .45 * smoothstep(0., .2, since);
  gFlare = flash;
}
`)}
`,
};

// The mark as an element, on top of the metal engine (metal.js), for
// logo.js: animated, it loops; with `idle` it waits at rest until
// setRunning(true), and on setRunning(false) it finishes the loop it is in
// and parks at the rest pose; ignite() plays the onboarding's finale.
//
// Cost is what decides the design. One WebGL context draws every mark. A
// small mark (48 CSS px and under) never renders twice: each frame of its
// loop is drawn once, into a strip shared by every mark of that size,
// studio and tile, and played from there at 30 fps; a cold strip fills in
// as the loop first plays, at most a few frames per tick. Larger marks
// render live at the display's rate. Marks off screen, in hidden tabs or
// detached don't draw at all.
//
// The studio follows the theme: --mark-studio on the mark (1 dark, 0 light),
// which app.css sets per theme and a dark card can override locally.



const MM_SMALL = 48;
const MM_FPS = 30;
const MM_MISSES = 4;

let mmCount = 0;
const mmMarks = new Set();
const mmStrips = new Map();
let mmFrame = 0;
let mmLast = 0;

const mmStudio = (el) => {
  const v = getComputedStyle(el).getPropertyValue("--mark-studio").trim();
  if (v) return +v ? 1 : 0;
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark" ? 1 : 0;
  return matchMedia("(prefers-color-scheme: dark)").matches ? 1 : 0;
};

// Frames of one loop at one pixel size, studio and tile, kept in a canvas
// as a grid of cells.
function mmStrip(dir, w, dark, tile, px) {
  const key = `${dir.key}|${w}|${dark}|${tile}`;
  let s = mmStrips.get(key);
  if (s) return s;
  const n = Math.max(1, Math.round(dir.loop * MM_FPS));
  const cols = Math.ceil(Math.sqrt(n));
  const cv = document.createElement("canvas");
  cv.width = cols * w;
  cv.height = Math.ceil(n / cols) * w;
  s = { cv, ctx: cv.getContext("2d"), n, cols, w, have: new Uint8Array(n), dark, tile, px, dir };
  mmStrips.set(key, s);
  return s;
}
const mmCell = (s, i) => [(i % s.cols) * s.w, Math.floor(i / s.cols) * s.w];
// Without WebGL the mark is a picture of its rest pose (mark-still.js,
// fetched only then).
let mmStill = null;
const mmStillFor = (dark) => (mmStill ??= import("./mark-still.js").then((m) => m.MARK_STILL)).then((s) => s[dark ? "dark" : "light"]);

// `ignition` is the onboarding's one-shot direction (plasma.js's IGNITION),
// played by box.ignite().
function metalLogo(dir, { size = 24, animated = true, tile = false, className = "", idle = false, duration, ignition } = {}) {
  // Drawn at the size it is laid out at when CSS makes it bigger than asked.
  let drawn = size;
  const still = !animated || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const box = document.createElement("span");
  box.className = `logo-mark metal${className ? ` ${className}` : ""}`;
  box.style.width = `${size}px`;
  box.style.height = `${size}px`;
  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  cv.style.cssText = "display:block;width:100%;height:100%";
  box.append(cv);
  const loop = dir.loop;
  const rate = duration ? loop / duration : 1;
  const id = ++mmCount;
  let running = !idle && !still;
  let homing = false;
  let clock = 0;
  let shown = -1;
  let visible = true;
  let studio = null;

  // Once on the page, a mark that leaves it is dropped (and taken back if it
  // returns). Before then its studio is a guess from the document's theme.
  let seen = false;
  let guessed = false;
  // The ignition, while it plays: its clock, rate, and the promise waiting
  // for its flash.
  let igniting = false, igClock = 0, igRate = 1, igDone = null;
  const flashed = () => { if (igDone) { const done = igDone; igDone = null; done(); } };

  const draw = (budget) => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const size = drawn;
    if (igniting) {
      // One-shot, so drawn live at any size.
      const w = Math.round(size * dpr);
      if (cv.width !== w) { cv.width = w; cv.height = w; }
      if (studio === null) { studio = mmStudio(box); guessed = !box.isConnected; }
      const e = metalEngine();
      if (!e.ok) return budget;
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, w, w);
      e.paint(ctx, ignition, { w, h: w, px: size, time: Math.min(igClock, ignition.loop - .001), loop: ignition.loop, dark: studio, tile: tile ? 1 : 0, aa: size <= 96 ? 2 : 1 });
      shown = 1;
      return budget;
    }
    const w = Math.round(size * dpr);
    if (cv.width !== w) { cv.width = w; cv.height = w; shown = -1; }
    if (studio === null) { studio = mmStudio(box); guessed = !box.isConnected; }
    const e = metalEngine();
    const ctx = cv.getContext("2d");
    if (!e.ok) {
      if (shown < 0) {
        shown = 0;
        mmStillFor(studio).then((src) => {
          const img = new Image();
          img.onload = () => { ctx.clearRect(0, 0, w, w); ctx.drawImage(img, 0, 0, w, w); };
          img.src = src;
        }, () => {});
      }
      return budget;
    }
    if (size <= MM_SMALL) {
      const s = mmStrip(dir, w, studio, tile ? 1 : 0, size);
      const i = Math.floor((clock / loop) * s.n) % s.n;
      if (!s.have[i]) {
        // Cold strip: past this tick's budget, hold the last frame shown
        // rather than stall the page.
        if (budget <= 0 && shown >= 0 && i !== 0) return budget;
        const [x, y] = mmCell(s, i);
        e.paint(s.ctx, dir, { w, h: w, px: size, time: (i / s.n) * loop, loop, dark: studio, tile: s.tile }, x, y);
        s.have[i] = 1;
        budget--;
      }
      if (i === shown) return budget;
      const [x, y] = mmCell(s, i);
      ctx.clearRect(0, 0, w, w);
      ctx.drawImage(s.cv, x, y, w, w, 0, 0, w, w);
      shown = i;
      return budget;
    }
    ctx.clearRect(0, 0, w, w);
    e.paint(ctx, dir, { w, h: w, px: size, time: clock, loop, dark: studio, tile: tile ? 1 : 0, aa: size <= 96 ? 2 : 1, tilt: window.KnotMark?.tilt ?? [0, 0] });
    shown = 1;
    return budget;
  };

  const m = {
    id,
    // Whether this mark still wants frames.
    wants: () => box.isConnected && visible && (running || homing || shown < 0 || (igniting && igClock < ignition.loop)),
    step(dt, budget) {
      if (!box.isConnected) { if (seen) mmMarks.delete(m); return budget; }
      seen = true;
      if (guessed) {
        guessed = false;
        const real = mmStudio(box);
        if (real !== studio) { studio = real; shown = -1; }
      }
      if (!visible) return budget;
      if (igniting) {
        if (igClock >= ignition.loop) return budget;
        igClock += dt * igRate;
        if (igClock >= ignition.flash) flashed();
        return draw(budget);
      }
      if (!running && !homing && shown >= 0) return budget;
      if (running || homing) {
        clock += dt * rate;
        if (homing && clock >= loop) { clock = 0; homing = false; }
        clock %= loop;
      }
      return draw(budget);
    },
    restyle() { studio = null; shown = -1; },
  };
  mmMarks.add(m);
  // The first frame now, so the canvas is never blank: a view transition
  // can snapshot it before the next animation frame.
  draw(1);

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(([en]) => {
      const laid = Math.round(Math.max(size, en.contentRect.width));
      if (laid !== drawn) { drawn = laid; shown = -1; mmWake(); }
    }).observe(box);
  }
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) { mmMarks.add(m); mmWake(); } }).observe(box);
  }

  // Waits at rest until running; on stop, finishes the loop it is in and
  // parks at the rest pose (t = 0).
  box.setRunning = (on) => {
    if (still) return;
    on = Boolean(on);
    if (on) { running = true; homing = false; }
    else if (running) { running = false; homing = clock > .001; }
    box.classList.toggle("running", running);
    mmWake();
  };
  if (running) box.classList.add("running");
  // logo.js's marks were SVG with a SMIL timeline, and callers rewind them
  // through it (welcome.js's oneLap: mark.firstElementChild.setCurrentTime(0)).
  // The canvas answers the same calls, in seconds of the mark's own lap
  // (`duration`), so those callers keep working unchanged.
  cv.setCurrentTime = (t) => { clock = ((t * rate) % loop + loop) % loop; shown = -1; mmWake(); };
  cv.getCurrentTime = () => clock / rate;
  box.restart = () => cv.setCurrentTime(0);
  // The onboarding's finale: from rest, the plasma speeds up to infinity and
  // flashes. Resolves at the flash, when the page should open the app;
  // `duration` is the time to the flash. Resolves at once when there is
  // nothing to play (reduced motion, no WebGL, no ignition), and a timer
  // backs it up so it never hangs (a hidden tab draws no frames).
  box.ignite = ({ duration: d } = {}) => new Promise((done) => {
    if (!ignition || still || !metalEngine().ok) { done(); return; }
    igDone = done;
    igniting = true;
    igClock = 0;
    igRate = d ? ignition.flash / d : 1;
    running = false; homing = false;
    setTimeout(flashed, (ignition.flash / igRate) * 1000 + 600);
    mmWake();
  });
  mmWake();
  return box;
}

function mmTick(now) {
  mmFrame = 0;
  const dt = mmLast ? Math.min((now - mmLast) / 1000, .1) : 0;
  mmLast = now;
  if (document.hidden) { mmLast = 0; return; }
  let budget = MM_MISSES;
  for (const m of mmMarks) budget = m.step(dt, budget);
  if ([...mmMarks].some((m) => m.wants())) mmWake();
  else mmLast = 0;
}
function mmWake() { if (!mmFrame) mmFrame = requestAnimationFrame(mmTick); }

// Theme changes repaint every mark in its new studio.
const mmRestyle = () => { for (const m of mmMarks) m.restyle(); mmWake(); };
if (typeof window !== "undefined") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", mmRestyle);
  new MutationObserver(mmRestyle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) mmWake(); });
}

  // Knot's motion directions: the engine as a page API. tilt is a [x, y]
  // the page sets (scroll, the pointer), in the shader's own units (radians
  // times .45 and .35), applied to every live mark.
  window.KnotMark = { metalLogo, metalEngine, KNOT, IGNITION, METAL_HEAD, METAL_SHADE, tilt: [0, 0] };
})();
