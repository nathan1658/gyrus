/* ============================ PLANNING ============================ */
import { clamp, v3 } from '../util.js';
import { field, gridExt, inVol, sampleNear } from '../io/volume.js';

function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
function edt3d(mask, dims) {   // returns Float32Array of distances (voxels)
  const [nx, ny, nz] = dims, N = nx * ny * nz, INF = 1e10;
  const D = new Float32Array(N); for (let i = 0; i < N; i++) D[i] = mask[i] ? 0 : INF;
  const m = Math.max(nx, ny, nz), f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { const o = nx * (j + ny * k); for (let i = 0; i < nx; i++) f[i] = D[o + i]; edt1d(f, nx, d, v, z); for (let i = 0; i < nx; i++) D[o + i] = d[i]; }
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { for (let j = 0; j < ny; j++) f[j] = D[i + nx * (j + ny * k)]; edt1d(f, ny, d, v, z); for (let j = 0; j < ny; j++) D[i + nx * (j + ny * k)] = d[j]; }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { for (let k = 0; k < nz; k++) f[k] = D[i + nx * (j + ny * k)]; edt1d(f, nz, d, v, z); for (let k = 0; k < nz; k++) D[i + nx * (j + ny * k)] = Math.sqrt(d[k]); }
  return D;
}
export const PLAN = { cst: null, cstDims: null };
export function prepPlanning(C) {
  PLAN.cst = null;
  if (C.tracts) {
    const e = gridExt(C), dims = e.map(x => Math.ceil(x / 2));
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    for (const k of ['CST_L', 'CST_R']) for (const s of C.tracts[k] || []) for (let i = 0; i < s.length; i += 3) {
      const x = Math.floor(s[i] / 2), y = Math.floor(s[i + 1] / 2), z = Math.floor(s[i + 2] / 2);
      if (x >= 0 && y >= 0 && z >= 0 && x < dims[0] && y < dims[1] && z < dims[2]) mask[x + dims[0] * (y + dims[1] * z)] = 1;
    }
    PLAN.cst = edt3d(mask, dims); PLAN.cstDims = dims;
  }
  // brain z-extent (for excluding skull-base entries)
  const e = gridExt(C); let zmin = e[2], zmax = 0;
  const cx = e[0] / 2, cy = e[1] / 2;
  for (let z = 1; z < e[2]; z += 2) for (let y = 4; y < e[1]; y += 6) for (let x = 4; x < e[0]; x += 6) { if (field(C, 'cortex', [x, y, z]) > 0.5) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); } }
  PLAN.zmin = zmin; PLAN.zmax = zmax;
}
export function cstDist(p) {
  if (!PLAN.cst) return null;
  const d = PLAN.cstDims, x = Math.floor(p[0] / 2), y = Math.floor(p[1] / 2), z = Math.floor(p[2] / 2);
  if (x < 0 || y < 0 || z < 0 || x >= d[0] || y >= d[1] || z >= d[2]) return 99;
  return PLAN.cst[x + d[0] * (y + d[1] * z)] * 2;
}
export function defaultTarget(C) {
  const c = C.meta.metrics.centroid_vox; return [c[0] + 0.5, c[1] + 0.5, c[2] + 0.5];
}
const ELOQ = { 7: ['Primary motor cortex', 0.5], 17: ['Primary sensory cortex', 0.3], 26: ['Supplementary motor area', 0.25] };
const ELOQ_L = { 5: ["Broca's area", 0.4], 6: ["Broca's area", 0.4], 10: ["Wernicke's area", 0.4], 19: ['Supramarginal gyrus (language)', 0.25], 20: ['Supramarginal gyrus (language)', 0.25], 21: ['Angular gyrus (language)', 0.25] };
function eloqOf(code) {
  if (!code) return null; const c = code & 127, right = !!(code & 128);
  if (ELOQ[c]) return ELOQ[c];
  if (!right && ELOQ_L[c]) return ELOQ_L[c];
  return null;
}
// Evaluate a straight trajectory. Returns metrics + risk score
export function evalPath(C, entry, target, fast) {
  const head = C.meta.has_head;
  const L = v3.dist(entry, target), d = v3.norm(v3.sub(target, entry));
  const step = fast ? 1.2 : 0.5, n = Math.ceil(L / step);
  let vent = 0, ventAt = null, sulci = 0, inCsf = 0, brainMM = 0, cstMin = 99, cortexEntry = null, inBrain = false, tumourMM = 0;
  const tumName = head ? 'tumour' : 'tc';
  for (let i = 0; i <= n; i++) {
    const s = Math.min(i * step, L), p = v3.add(entry, v3.mul(d, s));
    const ctx = field(C, 'cortex', p), ve = field(C, 'vent', p), tu = field(C, tumName, p);
    if (tu > 0.5) tumourMM += step;
    if (ve > 0.5 && L - s > 3) { vent++; if (!ventAt) ventAt = p; }
    if (ctx > 0.5 && tu < 0.5) { if (!inBrain && !cortexEntry) cortexEntry = p; inBrain = true; brainMM += step; if (inCsf >= 1.0) sulci++; inCsf = 0; }
    else if (inBrain && tu < 0.5 && ve < 0.5) inCsf += step;
    if (PLAN.cst) { const cd = cstDist(p); if (cd < cstMin && L - s > 1) cstMin = cd; }
  }
  let eloq = null, entryCode = 0;
  if (cortexEntry) {
    const at = C.meta.fields.atlas;
    for (let s = 0; s <= 4; s += 1) { const q = v3.add(cortexEntry, v3.mul(d, s)); const cd = sampleNear(C, at[0], at[1], q); if (cd && (cd & 127) <= 48) { entryCode = cd; break; } }
    eloq = eloqOf(entryCode);
  }
  // angle to surface normal at entry
  const nm = surfNormal(C, entry);
  const ang = nm ? Math.acos(clamp(v3.dot(nm, v3.mul(d, -1)), -1, 1)) * 180 / Math.PI : 0;
  let risk = 0; const fail = [];
  if (vent > 0) { risk += 1; fail.push('ventricle'); }
  if (eloq) risk += eloq[1];
  risk += Math.min(sulci, 3) * 0.1;
  if (PLAN.cst) risk += cstMin < 5 ? 0.45 : (cstMin < 10 ? 0.18 : 0);
  risk += clamp((brainMM - 12) * 0.006, 0, 0.35);
  risk += clamp((ang - 35) / 60, 0, 0.3);
  const zlim = PLAN.zmin + (PLAN.zmax - PLAN.zmin) * (head ? 0.42 : 0.3);
  if (entry[2] < zlim) { risk += 1; fail.push('skull base'); }
  return { L, vent, ventAt, sulci, brainMM, cstMin: PLAN.cst ? cstMin : null, eloq, entryCode, ang, risk: clamp(risk, 0, 1), fail, tumourMM, cortexEntry };
}
function surfNormal(C, p) {
  const nm = C.meta.has_head ? 'head' : 'brain', h = 1.5;
  const g = [field(C, nm, [p[0] + h, p[1], p[2]]) - field(C, nm, [p[0] - h, p[1], p[2]]), field(C, nm, [p[0], p[1] + h, p[2]]) - field(C, nm, [p[0], p[1] - h, p[2]]), field(C, nm, [p[0], p[1], p[2] + h]) - field(C, nm, [p[0], p[1], p[2] - h])];
  const l = v3.len(g); if (l < 1e-6) return null; return v3.mul(g, -1 / l);
}
export function exitPoint(C, target, d) {
  const nm = C.meta.has_head ? 'head' : 'brain';
  let last = null;
  for (let s = 1; s < 170; s += 1) {
    const p = v3.add(target, v3.mul(d, s));
    if (!inVol(C, p)) break;
    const f = field(C, nm, p);
    if (f < 0.5) { // refine
      let a = s - 1, b = s; for (let k = 0; k < 6; k++) { const m = (a + b) / 2; if (field(C, nm, v3.add(target, v3.mul(d, m))) >= 0.5) a = m; else b = m; }
      return v3.add(target, v3.mul(d, a));
    }
    last = p;
  }
  return null;
}
export const RISK_W = 80, RISK_H = 40;
function riskColor(r, fail) {
  if (fail) return [229, 72, 77];
  const g = [62, 207, 110], a = [245, 184, 61], b = [229, 72, 77];
  if (r < 0.45) { const t = r / 0.45; return g.map((x, i) => x + (a[i] - x) * t); }
  const t = clamp((r - 0.45) / 0.4, 0, 1); return a.map((x, i) => x + (b[i] - x) * t);
}
export async function computeRiskMap(C, target, onProgress) {
  const data = new Uint8Array(RISK_W * RISK_H * 4); let best = null;
  for (let j = 0; j < RISK_H; j++) {
    const el = ((j + 0.5) / RISK_H - 0.5) * Math.PI;
    for (let i = 0; i < RISK_W; i++) {
      const az = ((i + 0.5) / RISK_W - 0.5) * 2 * Math.PI;
      const d = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
      const E = exitPoint(C, target, d); const o = (i + RISK_W * j) * 4;
      if (!E) { data[o + 3] = 0; continue; }
      const m = evalPath(C, E, target, true);
      const col = riskColor(m.risk, m.fail.length > 0);
      data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = m.fail.length ? 70 : 215;
      const score = m.risk + m.L * 0.0015;
      if (!m.fail.length && (!best || score < best.score)) best = { score, E, m };
    }
    if ((j & 7) === 7) { onProgress && onProgress(j / RISK_H); await new Promise(r => setTimeout(r, 0)); }
  }
  // soften: 3x3 blur on colours of valid texels
  const out = new Uint8Array(data);
  for (let j = 1; j < RISK_H - 1; j++) for (let i = 0; i < RISK_W; i++) {
    const o = (i + RISK_W * j) * 4; if (!data[o + 3]) continue;
    for (let c = 0; c < 3; c++) { let s = 0, n = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = (i + di + RISK_W) % RISK_W, oo = (ii + RISK_W * (j + dj)) * 4; if (data[oo + 3]) { s += data[oo + c]; n++; } } out[o + c] = s / n; }
  }
  return { data: out, best };
}
export function computeFootprint(C, target, entry) {
  const N = v3.norm(v3.sub(entry, target));
  let a = Math.abs(N[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const U = v3.norm(v3.cross(a, N)), V = v3.cross(N, U);
  const head = C.meta.has_head, nm = head ? 'tumour' : 'tc';
  const Rr = 70, G = 160, M = new Float32Array(G * G);
  const e = gridExt(C), c = C.meta.metrics.centroid_vox;
  const r0 = 50;
  for (let z = Math.max(0, c[2] - r0); z < Math.min(e[2], c[2] + r0); z += 1) for (let y = Math.max(0, c[1] - r0); y < Math.min(e[1], c[1] + r0); y += 1) for (let x = Math.max(0, c[0] - r0); x < Math.min(e[0], c[0] + r0); x += 1) {
    const p = [x + 0.5, y + 0.5, z + 0.5];
    if (field(C, nm, p) < 0.5) continue;
    const q = v3.sub(p, target), u = v3.dot(q, U), v = v3.dot(q, V);
    const gi = Math.floor((u / Rr * 0.5 + 0.5) * G), gj = Math.floor((v / Rr * 0.5 + 0.5) * G);
    if (gi >= 0 && gj >= 0 && gi < G && gj < G) M[gi + G * gj] = 1;
  }
  // distance of each cell to silhouette (2D brute EDT via 3D routine with nz=1)
  const mask = new Uint8Array(G * G); for (let i = 0; i < G * G; i++) mask[i] = M[i] > 0 ? 1 : 0;
  const D = edt3d(mask, [G, G, 1]);
  const px = 2 * Rr / G, data = new Uint8Array(G * G * 4);
  let area = 0;
  for (let i = 0; i < G * G; i++) {
    const dmm = D[i] * px; const inside = mask[i];
    if (inside) area += px * px;
    data[i * 4] = inside ? 255 : 0;
    data[i * 4 + 1] = (Math.abs(dmm - 10) < 0.9 || (inside && D[i] === 0 && false)) ? 255 : 0;
    data[i * 4 + 3] = 255;
  }
  // silhouette outline
  for (let j = 1; j < G - 1; j++) for (let i = 1; i < G - 1; i++) { const k = i + G * j; if (mask[k] && (!mask[k - 1] || !mask[k + 1] || !mask[k - G] || !mask[k + G])) data[k * 4 + 1] = 200; }
  // craniotomy diameter estimate (silhouette + 10 mm margin)
  let wmax = 0; for (let i = 0; i < G * G; i++) if (D[i] * px <= 10) { const u = (i % G + 0.5) * px - Rr, v = (Math.floor(i / G) + 0.5) * px - Rr; wmax = Math.max(wmax, Math.hypot(u, v)); }
  return { data, G, frame: { O: target, U, V, N, R: Rr }, area, diam: wmax * 2 };
}
