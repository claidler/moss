export const COLORS = ["#3ec5a8", "#f5a03c", "#6a6bf5", "#9b5cf6", "#3b82f6", "#f2622a", "#d9508a"];

// Wire-globe faces (Chris, 2026-09-25): wireframed globes, armillary rings,
// geodesic shells and orbital systems — globe-inspired, our own mix. Static
// geometry is computed once per family/variant and cached; per-call phase
// stamping keeps the 1s live repaint animation-continuous. All motion is
// composited CSS (transform/opacity only): no SVG filters, no geometry
// animation, nothing per-frame on the main thread. Colour stays in CSS via
// --face-color; spin is the classic meridian scaleX projection, so it works
// in every engine (rotate3d only decorates the geodesic family).

const PHI = (1 + Math.sqrt(5)) / 2;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Edges = closest vertex pairs (platonic solids).
function autoEdges(vs) {
  const pairs = [];
  let min = Infinity;
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) {
      const d = dist(vs[i], vs[j]);
      pairs.push([i, j, d]);
      if (d < min) min = d;
    }
  return pairs.filter((p) => p[2] <= min * 1.02).map((p) => [p[0], p[1]]);
}

const ICOSA_V = [
  [0, 1, PHI], [0, 1, -PHI], [0, -1, PHI], [0, -1, -PHI],
  [1, PHI, 0], [1, -PHI, 0], [-1, PHI, 0], [-1, -PHI, 0],
  [PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, 1], [-PHI, 0, -1],
];
const ICOSA_E = autoEdges(ICOSA_V);

// --- static geometry caches (phase-independent strings) ---
const GEO = new Map();

function globeGeo(variant) {
  const key = "globe" + variant;
  if (GEO.has(key)) return GEO.get(key);
  const R = 21;
  const nMer = variant ? 5 : 4;
  const mer = [];
  for (let i = 0; i < nMer; i++)
    mer.push(`<ellipse class="${i % 2 ? "m" : "c"}" cx="32" cy="32" rx="${R}" ry="${R}"/>`);
  // Parallels: globe viewed ~18° above the equator.
  const par =
    `<ellipse class="o" cx="32" cy="20.6" rx="17.2" ry="5.3"/>` +
    `<ellipse class="o" cx="32" cy="43.4" rx="17.2" ry="5.3"/>` +
    `<ellipse class="o" cx="32" cy="32" rx="${R}" ry="6.5"/>`;
  const sil = `<circle class="m" cx="32" cy="32" r="${R}"/>`;
  const g = { mer, par, sil };
  GEO.set(key, g);
  return g;
}

function armGeo() {
  if (GEO.has("arm")) return GEO.get("arm");
  const g = {
    sil: `<circle class="m" cx="32" cy="32" r="11"/>`,
    eq: `<ellipse class="o" cx="32" cy="32" rx="11" ry="2.9"/>`,
    mer: [
      `<ellipse class="c" cx="32" cy="32" rx="11" ry="11"/>`,
      `<ellipse class="m" cx="32" cy="32" rx="11" ry="11"/>`,
    ],
  };
  GEO.set("arm", g);
  return g;
}

function orbGeo() {
  if (GEO.has("orb")) return GEO.get("orb");
  const g = {
    sil: `<circle class="m" cx="32" cy="32" r="10.5"/>`,
    eq: `<ellipse class="o" cx="32" cy="32" rx="10.5" ry="2.7"/>`,
    mer: [
      `<ellipse class="c" cx="32" cy="32" rx="10.5" ry="10.5"/>`,
      `<ellipse class="m" cx="32" cy="32" rx="10.5" ry="10.5"/>`,
      `<ellipse class="m" cx="32" cy="32" rx="10.5" ry="10.5"/>`,
    ],
  };
  GEO.set("orb", g);
  return g;
}

function geoGeo(variant) {
  const key = "geo" + variant;
  if (GEO.has(key)) return GEO.get(key);
  const maxR = Math.hypot(1, PHI);
  const s = 21 / maxR;
  const P = ICOSA_V.map(([x, y]) => [32 + x * s, 32 + y * s]);
  const Z = ICOSA_V.map((v) => Math.hypot(v[0], v[1], v[2]) / maxR);
  const f = variant ? 0.46 : 0.52;
  let shell = "";
  for (const [i, j] of ICOSA_E) {
    const zm = (Z[i] + Z[j]) / 2;
    const cls = zm < 0.45 ? "c" : zm < 0.75 ? "m" : "o";
    shell += `<path class="${cls}" d="M${P[i][0].toFixed(1)} ${P[i][1].toFixed(1)}L${P[j][0].toFixed(1)} ${P[j][1].toFixed(1)}"/>`;
  }
  let core = "";
  for (const [i, j] of ICOSA_E) {
    core += `<path class="m" d="M${(32 + (P[i][0] - 32) * f).toFixed(1)} ${(32 + (P[i][1] - 32) * f).toFixed(1)}L${(32 + (P[j][0] - 32) * f).toFixed(1)} ${(32 + (P[j][1] - 32) * f).toFixed(1)}"/>`;
  }
  let dots = "";
  for (const [x, y] of P) dots += `<circle class="wf-v" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.3"/>`;
  const g = { shell, core, dots };
  GEO.set(key, g);
  return g;
}

function slotFor(color, gid) {
  const n = Number(String(gid).replace(/\D/g, ""));
  if (Number.isFinite(n) && n > 0) return n % 8;
  // No digits (e.g. "head"): derive a stable slot from the palette index.
  const idx = COLORS.indexOf(color);
  return idx >= 0 ? idx % 8 : 0;
}

function seedFor(color, gid) {
  return Number(String(gid).replace(/\D/g, "")) || COLORS.indexOf(color) + 1 || 1;
}

// Shared animation epoch so a rebuilt SVG resumes at the same phase instead of
// snapping back to 0deg on every 1s live repaint.
const EPOCH = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

// Seconds into the current cycle for the given period.
function phaseSec(dur) {
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
  return (now - EPOCH) % dur;
}

const AXES = ["1,0.35,0", "0.4,1,0.2", "1,1,0", "-0.6,1,0.3", "1,-0.4,0.5", "0.2,0.8,-1"];
const D_MAIN = [12, 15, 10, 17, 13, 16];
const D_ORB = [9, 11, 8, 13, 10, 12];
const D_HALO = [22, 26, 19, 24, 21, 27];
const D_MIST = [5.2, 6.1, 4.7, 5.8, 6.6, 5];
const TILTS = [-19, -11, -24, -15, -8, -21];
const pick = (list, seed, salt) => list[(seed * 31 + salt * 17) % list.length];

function gradientDef(gid) {
  const id = "wfg-" + String(gid).replace(/[^a-zA-Z0-9_-]/g, "");
  const svg =
    `<defs><radialGradient id="${id}">` +
    `<stop offset="0" style="stop-color:var(--face-color);stop-opacity:.26"/>` +
    `<stop offset=".55" style="stop-color:var(--face-color);stop-opacity:.11"/>` +
    `<stop offset="1" style="stop-color:var(--face-color);stop-opacity:0"/>` +
    `</radialGradient></defs>`;
  return { id, svg };
}

function mist(gradId, r, dur) {
  return `<circle class="wf-mist" cx="32" cy="32" r="${r}" fill="url(#${gradId})" style="--wd:${dur}s;--wo:${phaseSec(dur).toFixed(2)}s"/>`;
}

// Meridians spinning: each ellipse's projected width follows |cos| via a
// composited scaleX, phases offset by i/n of the cycle.
function meridianSpin(els, dur, seed) {
  const n = els.length;
  const base = ((seed % 7) * dur) / 97;
  let out = "";
  for (let i = 0; i < n; i++) {
    const ph = (phaseSec(dur) + base + (i * dur) / n) % dur;
    out += `<g class="mspin" style="--wd:${dur}s;--wo:${ph.toFixed(2)}s">${els[i]}</g>`;
  }
  return out;
}

// Tilted circular orbit, projected flat: rotate(tilt) scale(1 k) about the
// centre. dashed = the ring itself rotates; otherwise a satellite dot does.
function orbit(rx, k, tilt, dur, seed, salt, dashed) {
  const ph = phaseSec(dur);
  const proj = `transform="rotate(${tilt} 32 32) translate(32 32) scale(1 ${k}) translate(-32 -32)"`;
  const style = `--wd:${dur}s;--wo:${ph.toFixed(2)}s`;
  const rev = salt % 2 ? " rev" : "";
  if (dashed) {
    return `<g ${proj}><g class="orb${rev}" style="${style}">` +
      `<circle class="wf-halo" cx="32" cy="32" r="${rx}" stroke-dasharray="3 7"/></g></g>`;
  }
  return `<g ${proj}><circle class="o" cx="32" cy="32" r="${rx}"/>` +
    `<g class="orb${rev}" style="${style}"><circle class="sat" cx="${32 + rx}" cy="32" r="1.9"/></g></g>`;
}

function emitGlobe(gid, seed, variant) {
  const g = globeGeo(variant);
  const d1 = pick(D_MAIN, seed, 0);
  const dH = pick(D_ORB, seed, 1);
  const dM = pick(D_MIST, seed, 5);
  const tilt = TILTS[(seed + variant * 3) % TILTS.length];
  const { id, svg: defs } = gradientDef(gid);
  return defs +
    mist(id, 23.5, dM) +
    `<g transform="rotate(${tilt} 32 32)">` + g.sil + g.par + meridianSpin(g.mer, d1, seed) + `</g>` +
    orbit(26.5, 0.32, tilt + 14, dH, seed, 1, true);
}

function emitArmillary(gid, seed, variant) {
  const g = armGeo();
  const dCore = pick(D_ORB, seed, 1);
  const dA = pick(D_MAIN, seed, 0);
  const dB = pick(D_MAIN, seed, 2);
  const dM = pick(D_MIST, seed, 5);
  const tA = variant ? -28 : -34;
  const tB = variant ? 38 : 47;
  const { id, svg: defs } = gradientDef(gid);
  // Rings are projected to ellipses (rotate + squash) so the tilt reads as 3D;
  // the inner mspin sweep then rolls each ring like a gyroscope gimbal.
  const ringA = `<g transform="rotate(${tA} 32 32) translate(32 32) scale(1 .58) translate(-32 -32)"><g class="mspin" style="--wd:${dA}s;--wo:${phaseSec(dA).toFixed(2)}s"><circle class="c" cx="32" cy="32" r="21"/></g></g>`;
  const ringB = `<g transform="rotate(${tB} 32 32) translate(32 32) scale(1 .4) translate(-32 -32)"><g class="mspin" style="--wd:${dB}s;--wo:${((phaseSec(dB) + dB / 3) % dB).toFixed(2)}s"><circle class="m" cx="32" cy="32" r="17.5"/></g></g>`;
  const halo = `<g transform="rotate(${variant ? 52 : 38} 32 32) translate(32 32) scale(1 .3) translate(-32 -32)"><circle class="wf-halo" cx="32" cy="32" r="24.5" stroke-dasharray="3 7"/></g>`;
  return defs + mist(id, 23, dM) + halo +
    g.sil + g.eq + meridianSpin(g.mer, dCore, seed) +
    ringA + ringB;
}

function emitOrbital(gid, seed, variant) {
  const g = orbGeo();
  const dCore = pick(D_ORB, seed, 1);
  const oA = pick(D_ORB, seed, 2);
  const oB = pick(D_ORB, seed, 4);
  const dM = pick(D_MIST, seed, 5);
  const { id, svg: defs } = gradientDef(gid);
  return defs + mist(id, 23.5, dM) +
    g.sil + g.eq + meridianSpin(g.mer, dCore, seed) +
    orbit(23.5, 0.36, variant ? -10 : -18, oA, seed, 1, false) +
    orbit(19, 0.5, variant ? 22 : 31, oB, seed, 0, false);
}

function emitGeodesic(gid, seed, variant) {
  const g = geoGeo(variant);
  const d1 = pick(D_MAIN, seed, 0);
  const d2 = pick(D_ORB, seed, 1);
  const d3 = pick(D_HALO, seed, 2);
  const dM = pick(D_MIST, seed, 5);
  const ax1 = pick(AXES, seed, 3);
  const ax2 = pick(AXES, seed, 4);
  const { id, svg: defs } = gradientDef(gid);
  return defs + mist(id, 23, dM) +
    `<g class="wf wf-3" style="--wd:${d3}s;--wo:${phaseSec(d3).toFixed(2)}s">` +
    `<circle class="wf-halo" cx="32" cy="32" r="27.5"/>` +
    `<circle class="wf-halo h2" cx="32" cy="32" r="21.5"/></g>` +
    `<g class="wf wf-2" style="--wd:${d2}s;--wo:${phaseSec(d2).toFixed(2)}s;--ax2:${ax2}">${g.core}</g>` +
    `<g class="wf wf-1" style="--wd:${d1}s;--wo:${phaseSec(d1).toFixed(2)}s;--ax1:${ax1}">${g.shell}${g.dots}</g>`;
}

const EMIT = [emitGlobe, emitGeodesic, emitArmillary, emitOrbital];

export function shapeSvg(color, gid) {
  const slot = slotFor(color, gid);
  const seed = seedFor(color, gid);
  const emit = EMIT[slot % 4];
  return `<svg viewBox="0 0 64 64" aria-hidden="true" shape-rendering="geometricPrecision" style="--face-color:${color}">` +
    emit(gid, seed, slot >= 4 ? 1 : 0) +
    `</svg>`;
}

export function colorFor(id) {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (i + 1) * id.charCodeAt(i);
  return COLORS[n % COLORS.length];
}

// Legacy alias used by the chat sidebar.
export const blobSvg = shapeSvg;
