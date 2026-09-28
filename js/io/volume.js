/* ============================ VOLUME ACCESS (CPU) ============================ */
import { clamp } from '../util.js';

function chanRef(C, name) { const f = C.meta.fields[name]; return f ? { t: f[0], c: f[1] } : null; }
export function sampleLin(C, t, c, p) {
  const T = C.tex[t], s = T.spacing[0], d = T.dims, D = T.data;
  let fx = p[0] / s - 0.5, fy = p[1] / s - 0.5, fz = p[2] / s - 0.5;
  if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > d[0] - 0.5 || fy > d[1] - 0.5 || fz > d[2] - 0.5) return 0;
  fx = clamp(fx, 0, d[0] - 1.001); fy = clamp(fy, 0, d[1] - 1.001); fz = clamp(fz, 0, d[2] - 1.001);
  const x0 = fx | 0, y0 = fy | 0, z0 = fz | 0, ax = fx - x0, ay = fy - y0, az = fz - z0;
  const x1 = Math.min(x0 + 1, d[0] - 1), y1 = Math.min(y0 + 1, d[1] - 1), z1 = Math.min(z0 + 1, d[2] - 1);
  const I = (x, y, z) => D[(x + d[0] * (y + d[1] * z)) * 3 + c];
  const c00 = I(x0, y0, z0) * (1 - ax) + I(x1, y0, z0) * ax, c10 = I(x0, y1, z0) * (1 - ax) + I(x1, y1, z0) * ax;
  const c01 = I(x0, y0, z1) * (1 - ax) + I(x1, y0, z1) * ax, c11 = I(x0, y1, z1) * (1 - ax) + I(x1, y1, z1) * ax;
  return ((c00 * (1 - ay) + c10 * ay) * (1 - az) + (c01 * (1 - ay) + c11 * ay) * az) / 255;
}
export function sampleNear(C, t, c, p) {
  const T = C.tex[t], s = T.spacing[0], d = T.dims;
  const x = Math.floor(p[0] / s), y = Math.floor(p[1] / s), z = Math.floor(p[2] / s);
  if (x < 0 || y < 0 || z < 0 || x >= d[0] || y >= d[1] || z >= d[2]) return 0;
  return T.data[(x + d[0] * (y + d[1] * z)) * 3 + c];
}
export function field(C, name, p) { const r = chanRef(C, name); return r ? sampleLin(C, r.t, r.c, p) : 0; }
export function gridExt(C) { return C.tex[0].ext; }
export function inVol(C, p) { const e = gridExt(C); return p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] <= e[0] && p[1] <= e[1] && p[2] <= e[2]; }
// grid mm -> scanner / volume coordinates for display
export function worldOf(C, p) {
  const g = C.meta.grid, A = g.affine, o = g.origin_vox;
  const i = o[0] + p[0] - 0.5, j = o[1] + p[1] - 0.5, k = o[2] + p[2] - 0.5;
  return [A[0][0] * i + A[0][1] * j + A[0][2] * k + A[0][3], A[1][0] * i + A[1][1] * j + A[1][2] * k + A[1][3], A[2][0] * i + A[2][1] * j + A[2][2] * k + A[2][3]];
}
export function atlasName(C, code) {
  if (!code) return null;
  const n = C.meta.atlas_names[String(code & 127)]; if (!n) return null;
  return ((code & 128) ? 'Right ' : 'Left ') + n.charAt(0).toLowerCase() + n.slice(1);
}
function hemiName(code) { return (code & 128) ? 'R' : 'L'; }
