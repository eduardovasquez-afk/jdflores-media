// Stamp patterns: pick one of JD's real stamp mats (3D, made from his photos), press it into a slab, see the stamped concrete.
// Loaded lazily by main.js when #stamps gets close to the screen.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Concrete colors are illustrations: [field, release/antique in the joints]
const STAMPS = [
  { file: 'https://eduardovasquez-afk.github.io/jdflores-media/media/stamps/ashlar.glb', base: [150, 147, 141], dark: [58, 56, 54] },
  { file: 'https://eduardovasquez-afk.github.io/jdflores-media/media/stamps/flag-red.glb', base: [168, 104, 80], dark: [74, 36, 26] },
  { file: 'https://eduardovasquez-afk.github.io/jdflores-media/media/stamps/flag-gold.glb', base: [196, 164, 112], dark: [92, 66, 40] },
  { file: 'https://eduardovasquez-afk.github.io/jdflores-media/media/stamps/cobble.glb', base: [166, 161, 152], dark: [74, 70, 64] },
];
const RES = 512, DEPTH = 0.07, HOVER = 0.6, SPAN = 3.4;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = t => t * t * (3 - 2 * t);

const root = document.getElementById('stamps');
const canvas = document.getElementById('stamp-gl');
const hint = root.querySelector('.stamp-loading');
const picks = [...root.querySelectorAll('[data-stamp]')];
const views = [...root.querySelectorAll('[data-view]')];

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xfff1dd, 0x2a1d17, 1.1));
const sun = new THREE.DirectionalLight(0xffe2bf, 2.6); sun.position.set(-4, 7, 3); scene.add(sun);
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 60);
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, { enableDamping: true, enablePan: false, minDistance: 3, maxDistance: 14, maxPolarAngle: Math.PI * 0.46 });

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map();
let cur = null, anim = null, state = 'stamp', token = 0;

// Lay a mat flat (thinnest axis up), long side along x, centered, scaled to SPAN.
function prepMat(gltf) {
  const mat = gltf.scene;
  const s0 = new THREE.Box3().setFromObject(mat).getSize(new THREE.Vector3());
  if (s0.z < s0.x && s0.z < s0.y) mat.rotation.x = -Math.PI / 2;
  else if (s0.x < s0.y && s0.x < s0.z) mat.rotation.z = Math.PI / 2;
  const g = new THREE.Group(); g.add(mat);
  let s = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
  if (s.z > s.x) { g.rotation.y = Math.PI / 2; s = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3()); }
  g.scale.setScalar(SPAN / Math.max(s.x, s.z));
  // photo-to-3D guesses thickness; real mats are thin, so cap it at 5% of the width
  const tall = s.y * g.scale.x, cap = SPAN * 0.05;
  if (tall > cap) g.scale.y *= cap / tall;
  const b =new THREE.Box3().setFromObject(g), c = b.getCenter(new THREE.Vector3());
  g.position.set(-c.x, -b.min.y, -c.z); // bottom of the mat at y=0
  const wrap = new THREE.Group(); wrap.add(g);
  const mats = [];
  wrap.traverse(o => { if (o.isMesh) { o.material.transparent = true; mats.push(o.material); } });
  wrap.userData.mats = mats;
  return wrap;
}

// Top-down height render of the mat face -> depth field (0 = untouched concrete, 1 = deepest).
function impression(wrap, w, d) {
  const rt = new THREE.WebGLRenderTarget(RES, RES);
  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, d / 2, -d / 2, 0.1, 20);
  cam.up.set(0, 0, -1); cam.position.set(0, 10, 0); cam.lookAt(0, 0, 0);
  const top = new THREE.Box3().setFromObject(wrap);
  const tmp = new THREE.Scene(); const parent = wrap.parent; tmp.add(wrap);
  tmp.overrideMaterial = new THREE.ShaderMaterial({
    uniforms: { lo: { value: top.min.y }, hi: { value: top.max.y } },
    vertexShader: 'varying float vy; void main(){ vec4 p = modelMatrix * vec4(position,1.); vy = p.y; gl_Position = projectionMatrix * viewMatrix * p; }',
    // 16-bit height packed into R (coarse) + G (fine): the face relief is a tiny slice of the mat's thickness
    fragmentShader: 'uniform float lo, hi; varying float vy; void main(){ float v = clamp((vy-lo)/(hi-lo), 0., 1.) * 255.; gl_FragColor = vec4(floor(v)/255., fract(v), 0., 1.); }',
  });
  const prevTone = renderer.toneMapping, prevCs = renderer.outputColorSpace;
  renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setRenderTarget(rt); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(tmp, cam); renderer.setRenderTarget(null);
  const px = new Uint8Array(RES * RES * 4); renderer.readRenderTargetPixels(rt, 0, 0, RES, RES, px);
  tmp.overrideMaterial.dispose(); tmp.overrideMaterial = null;
  // Second pass: the mat's own surface normals (geometry + its normal map), seen from above = the face detail.
  const swaps = [];
  wrap.traverse(o => { if (o.isMesh) { swaps.push([o, o.material]); o.material = new THREE.MeshNormalMaterial({ normalMap: o.material.normalMap || null }); } });
  renderer.setRenderTarget(rt); renderer.setClearColor(0x8080ff, 0); renderer.clear(); renderer.render(tmp, cam); renderer.setRenderTarget(null);
  const nrm = new Uint8Array(RES * RES * 4); renderer.readRenderTargetPixels(rt, 0, 0, RES, RES, nrm);
  swaps.forEach(([o, m]) => { o.material.dispose(); o.material = m; });
  renderer.toneMapping = prevTone; renderer.outputColorSpace = prevCs;
  rt.dispose(); if (parent) parent.add(wrap);

  // Raw heights (flip rows: render target is bottom-up, canvas is top-down)
  const raw = new Float32Array(RES * RES), on = new Uint8Array(RES * RES);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const i = (RES - 1 - y) * RES + x, j = y * RES + x;
    if (px[i * 4 + 3]) { on[j] = 1; raw[j] = px[i * 4] + px[i * 4 + 1] / 255; }
  }
  // Local relief = height minus its wide blur, so mat tilt and stray scan bits don't swamp the joints.
  const R = 20, W1 = RES + 1, S = new Float64Array(W1 * W1), N = new Float64Array(W1 * W1);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const j = y * RES + x, k = (y + 1) * W1 + x + 1;
    S[k] = raw[j] + S[k - 1] + S[k - W1] - S[k - W1 - 1]; N[k] = on[j] + N[k - 1] + N[k - W1] - N[k - W1 - 1];
  }
  const box = (A, x0, y0, x1, y1) => A[y1 * W1 + x1] - A[y0 * W1 + x1] - A[y1 * W1 + x0] + A[y0 * W1 + x0];
  const det = new Float32Array(RES * RES), vals = [];
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const j = y * RES + x; if (!on[j]) continue;
    const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(RES, x + R + 1), y1 = Math.min(RES, y + R + 1);
    det[j] = raw[j] - box(S, x0, y0, x1, y1) / box(N, x0, y0, x1, y1); vals.push(det[j]);
  }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.04)] ?? 0, hi = vals[Math.floor(vals.length * 0.9)] ?? 1;
  let h = new Float32Array(RES * RES);
  // stone faces stay near the top, joints press deepest
  for (let j = 0; j < h.length; j++) h[j] = on[j] ? 0.15 + 0.85 * (1 - clamp((det[j] - lo) / Math.max(1e-3, hi - lo))) : 0;
  for (let pass = 0; pass < 2; pass++) { // soften scan noise
    const o = new Float32Array(h.length);
    for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < RES && yy < RES) { s += h[yy * RES + xx]; n++; } }
      o[y * RES + x] = s / n;
    }
    h = o;
  }
  // Mat face slopes (flipped rows), inverted because the concrete gets the mirror of the relief.
  const sx = new Float32Array(RES * RES), sy = new Float32Array(RES * RES);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const i = (RES - 1 - y) * RES + x, j = y * RES + x;
    if (!on[j]) continue;
    const nx = nrm[i * 4] / 127.5 - 1, ny = nrm[i * 4 + 1] / 127.5 - 1, nz = Math.max(0.2, nrm[i * 4 + 2] / 127.5 - 1);
    sx[j] = -nx / nz; sy[j] = -ny / nz;
  }
  return { h, sx, sy };
}

function canvasTex(fill, srgb) {
  const c = document.createElement('canvas'); c.width = c.height = RES;
  const g = c.getContext('2d'), img = g.createImageData(RES, RES);
  for (let i = 0; i < RES * RES; i++) fill(i, img.data, i * 4);
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildSlab({ h, sx, sy }, w, d, spec) {
  const at = (x, y) => h[clamp(y, 0, RES - 1) * RES + clamp(x, 0, RES - 1)];
  const k = DEPTH * RES / w * 1.2;
  const normal = canvasTex((i, o, p) => {
    const x = i % RES, y = (i / RES) | 0;
    // tangent space: +x right, +y = image up (canvas row - 1); normal leans away from the deeper side
    const nx = (at(x + 1, y) - at(x - 1, y)) * k + sx[i], ny = (at(x, y - 1) - at(x, y + 1)) * k + sy[i], nz = 1;
    const l = Math.hypot(nx, ny, nz); o[p] = (nx / l * 0.5 + 0.5) * 255; o[p + 1] = (ny / l * 0.5 + 0.5) * 255; o[p + 2] = (nz / l * 0.5 + 0.5) * 255; o[p + 3] = 255;
  });
  const disp = canvasTex((i, o, p) => { const v = (1 - h[i]) * 255; o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = 255; });
  const rnd = mulberry(7);
  const color = canvasTex((i, o, p) => {
    // antique release collects in the joints: deep spots and steep edges
    const t = clamp(clamp((h[i] - 0.55) / 0.45) ** 1.5 * 0.85 + clamp(Math.hypot(sx[i], sy[i]) * 0.9 - 0.15) * 0.6, 0, 0.9), n = (rnd() - 0.5) * 14;
    for (let c = 0; c < 3; c++) o[p + c] = clamp(spec.base[c] + (spec.dark[c] - spec.base[c]) * t + n, 0, 255);
    o[p + 3] = 255;
  }, true);
  const plainCol = new THREE.Color().setRGB(...spec.base.map(v => v / 255), THREE.SRGBColorSpace);

  const geo = new THREE.PlaneGeometry(w, d, 220, Math.round(220 * d / w)); geo.rotateX(-Math.PI / 2);
  const stamped = new THREE.MeshStandardMaterial({ map: color, normalMap: normal, displacementMap: disp, displacementScale: DEPTH, displacementBias: -DEPTH, roughness: 0.86 });
  const plain = new THREE.MeshStandardMaterial({ color: plainCol, roughness: 0.55 }); // fresh, still wet
  const top = new THREE.Mesh(geo, plain);
  // open-top box: the stamped surface dips below y=0, so a lid would hide it
  const sideMat = new THREE.MeshStandardMaterial({ color: plainCol.clone().multiplyScalar(0.72), roughness: 0.9 }), noLid = new THREE.MeshBasicMaterial({ visible: false });
  const sides = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), [sideMat, sideMat, noLid, sideMat, sideMat, sideMat]);
  sides.position.y = -0.15;
  const slab = new THREE.Group(); slab.add(top, sides);
  slab.userData = { top, plain, stamped, dispose: () => [geo, sides.geometry, stamped, plain, sideMat, noLid, color, normal, disp].forEach(x => x.dispose()) };
  return slab;
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function frame(w, d) {
  const portrait = camera.aspect < 1;
  // closer on wide windows, further out as the window gets squarer or taller
  const r = Math.max(w, d) * (portrait ? 2.2 / Math.max(camera.aspect, 0.55) : 1.45 * Math.max(1, 1.5 / camera.aspect));
  camera.position.set(0, r * 0.78 + 0.25, r * 0.62); controls.target.set(0, 0.25, 0); controls.update();
}

function setMat(o) { cur.mat.userData.mats.forEach(m => { m.opacity = o; m.depthWrite = o > 0.99; }); cur.mat.visible = o > 0.01; }
function setPressed(v) { // v: 0 = fresh slab, 1 = fully stamped
  const { top, plain, stamped } = cur.slab.userData;
  top.material = v > 0 ? stamped : plain;
  stamped.displacementScale = DEPTH * v; stamped.displacementBias = -DEPTH * v; stamped.normalScale.setScalar(v);
}
function setView(v) {
  state = v;
  views.forEach(b => b.setAttribute('aria-pressed', b.dataset.view === v));
  if (!cur) return;
  if (v === 'stamp') anim = { t0: performance.now(), dur: reduced ? 1 : 500, kind: 'show' };
  else anim = { t0: performance.now(), dur: reduced ? 1 : 1900, kind: 'press' };
}
function step(now) {
  if (!anim || !cur) return;
  const a = clamp((now - anim.t0) / anim.dur);
  if (anim.kind === 'show') { setPressed(0); cur.mat.position.y = HOVER + (1 - ease(a)) * 0.6; setMat(ease(a)); }
  else if (a < 0.42) { const e = a / 0.42; cur.mat.position.y = HOVER * (1 - e * e); setMat(1); setPressed(0); }
  else if (a < 0.58) { const e = ease((a - 0.42) / 0.16); cur.mat.position.y = -DEPTH * e; setPressed(e); }
  else { const e = ease((a - 0.58) / 0.42); cur.mat.position.y = -DEPTH + (HOVER + 0.5 + DEPTH) * e; setMat(1 - e); setPressed(1); }
  if (a >= 1) anim = null;
}

async function pick(i) {
  const my = ++token;
  picks.forEach((b, j) => b.setAttribute('aria-selected', j === i));
  hint.hidden = false;
  let entry = cache.get(i);
  if (!entry) {
    const gltf = await loader.loadAsync(STAMPS[i].file).catch(() => null);
    if (!gltf) { hint.hidden = true; return; }
    const mat = prepMat(gltf), b = new THREE.Box3().setFromObject(mat), sz = b.getSize(new THREE.Vector3());
    const w = sz.x * 1.14, d = sz.z * 1.14;
    const imp = impression(mat, w, d);
    entry = { mat, w, d, imp, slab: buildSlab(imp, w, d, STAMPS[i]) };
    cache.set(i, entry);
  }
  if (my !== token) return;
  if (cur) { scene.remove(cur.mat, cur.slab); }
  cur = entry; scene.add(cur.mat, cur.slab);
  hint.hidden = true;
  frame(cur.w, cur.d);
  setView('stamp');
  setTimeout(() => { if (my === token && state === 'stamp') setView('concrete'); }, reduced ? 0 : 900);
}

picks.forEach((b, i) => b.addEventListener('click', () => pick(i)));
views.forEach(b => b.addEventListener('click', () => { if (b.dataset.view !== state || b.dataset.view === 'concrete') setView(b.dataset.view); }));

let visible = false;
new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { rootMargin: '100px' }).observe(canvas);
(function loop(now) {
  requestAnimationFrame(loop);
  if (!visible) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w && (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio()))) {
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); if (cur) frame(cur.w, cur.d);
  }
  step(now); controls.update(); renderer.render(scene, camera);
})(performance.now());

pick(0);
window.__stamps = { pick, setView, cache, get state() { return state; }, get anim() { return anim; } };
