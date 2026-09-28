/* ---------- overlay drawing ---------- */
import { $, $$, fmt, v3 } from '../util.js';
import { S } from '../state.js';
import { gridExt, worldOf } from '../io/volume.js';
import { BUNDLE_COL, BUNDLE_ORDER, tractMask } from '../gl/renderer.js';
import { VIEW_DEF, cellView, mm2s, planeOf, trajBasis } from './views.js';
import { currentSeq } from './panels.js';

export function drawOverlays(rects) {
  const cv = $('#ov'), dpr = S.dpr; const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
  const host = $('#viewer').getBoundingClientRect();
  for (const el of $$('.vp')) {
    if (el.offsetParent === null && S.layout === 'solo' && !el.classList.contains('main')) continue;
    const r = el.getBoundingClientRect(); if (r.width < 4) continue;
    const v = cellView(el.dataset.cell);
    g.save(); g.setTransform(dpr, 0, 0, dpr, (r.left - host.left) * dpr, (r.top - host.top) * dpr);
    g.beginPath(); g.rect(0, 0, r.width, r.height); g.clip();
    if (v === '3d') draw3DOverlay(g, r); else { const pl = planeOf(v, r.width, r.height); if (pl) draw2DOverlay(g, v, pl, r); else noTrajMsg(g, r); }
    g.restore();
  }
}
function noTrajMsg(g, r) { g.fillStyle = '#6d7a85'; g.font = '13px ' + getComputedStyle(document.body).fontFamily; g.textAlign = 'center'; g.fillText('Set an entry point to see trajectory views', r.width / 2, r.height / 2); }
const MONO = '11px "IBM Plex Mono", ui-monospace, monospace';
function draw2DOverlay(g, v, pl, r) {
  const C = S.C, def = VIEW_DEF[v], w = r.width, h = r.height;
  // tracts near the plane
  if (C.tracts && S.ov.tracts && S.three.layers.tracts) drawTractDots(g, pl);
  // crosshair
  if (S.ov.cross && !def.oblique) {
    const c = mm2s(pl, S.cross), gap = 9;
    const lines = { ax: [['co', 'h'], ['sa', 'v']], co: [['ax', 'h'], ['sa', 'v']], sa: [['ax', 'h'], ['co', 'v']] }[v];
    g.lineWidth = 1;
    for (const [o, dir] of lines) {
      g.strokeStyle = VIEW_DEF[o].col; g.globalAlpha = 0.85; g.beginPath();
      if (dir === 'h') { g.moveTo(0, c[1] + .5); g.lineTo(c[0] - gap, c[1] + .5); g.moveTo(c[0] + gap, c[1] + .5); g.lineTo(w, c[1] + .5); }
      else { g.moveTo(c[0] + .5, 0); g.lineTo(c[0] + .5, c[1] - gap); g.moveTo(c[0] + .5, c[1] + gap); g.lineTo(c[0] + .5, h); }
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  // trajectory
  drawTrajectory2D(g, v, pl);
  // RANO calipers
  if (S.rano && v === 'ax') drawRano(g, pl);
  // ruler
  if (S.ruler && S.ruler.v === v) {
    const a = mm2s(pl, S.ruler.a), b = mm2s(pl, S.ruler.b), d = v3.dist(S.ruler.a, S.ruler.b);
    g.strokeStyle = '#ffe07a'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    for (const q of [a, b]) { g.beginPath(); g.arc(q[0], q[1], 3, 0, 7); g.fillStyle = '#ffe07a'; g.fill(); }
    label(g, `${fmt(d, 1)} mm`, (a[0] + b[0]) / 2 + 8, (a[1] + b[1]) / 2 - 8, '#ffe07a');
  }
  // orientation letters
  g.font = '600 12px "IBM Plex Sans Condensed", sans-serif'; g.fillStyle = 'rgba(220,227,232,.75)';
  if (!def.oblique) {
    g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(def.ori[0], 8, h / 2);
    g.textAlign = 'right'; g.fillText(def.ori[1], w - 8, h / 2);
    g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(def.ori[2], w / 2, 34);
    g.textBaseline = 'bottom'; g.fillText(def.ori[3], w / 2, h - 8);
  }
  // corner info
  g.font = MONO; g.textBaseline = 'top'; g.textAlign = 'right'; g.fillStyle = 'rgba(200,210,218,.78)';
  const sq = currentSeq();
  const pos = def.oblique ? (v === 'pe' ? `depth ${fmt(S.plan.depth, 1)} mm · ${fmt(trajBasis().len - S.plan.depth, 1)} to target` : 'contains trajectory') :
    `${['x', 'y', 'z'][def.k]} ${fmt(worldOf(C, S.cross)[def.k], 1)} mm · ${Math.floor(S.cross[def.k]) + 1}/${Math.round(gridExt(C)[def.k])}`;
  if (w > 250) { g.fillText(sq.name, w - 10, 10); g.fillText(pos, w - 10, 25); }
  // scale bar (1 cm)
  const px10 = 10 / pl.mm;
  if (px10 > 12 && w > 180) {
    const x1 = w - 12, x0 = x1 - px10, y = h - 12;
    g.strokeStyle = 'rgba(220,227,232,.8)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, y - 4); g.lineTo(x0, y); g.lineTo(x1, y); g.lineTo(x1, y - 4); g.stroke();
    g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText('1 cm', x0 - 6, y + 4);
  }
  if (v === 'pe') drawProbeEye(g, pl);
}
function label(g, t, x, y, col) {
  g.font = MONO; const m = g.measureText(t).width;
  g.fillStyle = 'rgba(7,9,11,.78)'; g.fillRect(x - 3, y - 11, m + 6, 15);
  g.fillStyle = col || '#dce3e8'; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(t, x, y);
}
let TRACT_PTS = null;
export function prepTractPoints(C) {
  TRACT_PTS = null; if (!C.tracts) return;
  const P = [], B = [], D = [];
  BUNDLE_ORDER.forEach((k, bi) => {
    for (const s of C.tracts[k] || []) {
      const n = s.length / 3;
      for (let i = 0; i < n; i++) {
        const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
        const t = v3.norm([s[b * 3] - s[a * 3], s[b * 3 + 1] - s[a * 3 + 1], s[b * 3 + 2] - s[a * 3 + 2]]);
        P.push(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]); B.push(bi); D.push(Math.abs(t[0]), Math.abs(t[1]), Math.abs(t[2]));
      }
    }
  });
  TRACT_PTS = { P: new Float32Array(P), B: new Uint8Array(B), D: new Float32Array(D) };
}
function drawTractDots(g, pl) {
  if (!TRACT_PTS) return;
  const { P, B, D } = TRACT_PTS, n = B.length, N = pl.N, c = pl.center, thr = 0.9, mask = tractMask();
  const off = v3.dot(c, N), r = Math.max(1.3, 0.9 / pl.mm); const only = S.ov.tracts2d === 'cst' ? 3 : 0xffff;
  const useB = S.three.tractColor === 'bundle';
  for (let i = 0; i < n; i++) {
    if (!((mask >> B[i]) & 1) || !((only >> B[i]) & 1)) continue;
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const dn = x * N[0] + y * N[1] + z * N[2] - off; if (dn > thr || dn < -thr) continue;
    const s = mm2s(pl, [x, y, z]);
    if (useB) g.fillStyle = BUNDLE_COL[BUNDLE_ORDER[B[i]]];
    else { const dx = D[i * 3], dy = D[i * 3 + 1], dz = D[i * 3 + 2], m = Math.max(dx, dy, dz); g.fillStyle = `rgb(${40 + 215 * dx / m | 0},${40 + 215 * dy / m | 0},${40 + 215 * dz / m | 0})`; }
    g.fillRect(s[0] - r / 2, s[1] - r / 2, r, r);
  }
}
function drawTrajectory2D(g, v, pl) {
  const P = S.plan; if (!P.target) return;
  const t = mm2s(pl, P.target);
  if (P.entry) {
    const e = mm2s(pl, P.entry);
    g.setLineDash(Math.abs(e[2]) > 2 || Math.abs(t[2]) > 2 ? [5, 4] : []); g.strokeStyle = 'rgba(140,224,255,.9)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(e[0], e[1]); g.lineTo(t[0], t[1]); g.stroke(); g.setLineDash([]);
    // intersection with this plane
    const dn = v3.dot(v3.sub(P.target, P.entry), pl.N);
    if (Math.abs(dn) > 1e-6) {
      const k = v3.dot(v3.sub(pl.center, P.entry), pl.N) / dn;
      if (k >= 0 && k <= 1) { const q = mm2s(pl, v3.lerp(P.entry, P.target, k)); g.beginPath(); g.arc(q[0], q[1], 4, 0, 7); g.fillStyle = '#8ce0ff'; g.fill(); }
    }
    if (Math.abs(e[2]) < 30) { g.beginPath(); g.arc(e[0], e[1], 5, 0, 7); g.strokeStyle = '#8ce0ff'; g.lineWidth = 2; g.stroke(); }
    if (P.probe || P.flying) { const b = trajBasis(); const tip = mm2s(pl, v3.add(P.entry, v3.mul(b.d, P.depth))); if (!VIEW_DEF[v].oblique || v !== 'pe') { g.beginPath(); g.arc(tip[0], tip[1], 3.5, 0, 7); g.fillStyle = '#fff'; g.fill(); } }
  }
  if (Math.abs(t[2]) < 25) { g.beginPath(); g.arc(t[0], t[1], 5.5, 0, 7); g.strokeStyle = '#ffdc50'; g.lineWidth = 2; g.stroke(); g.beginPath(); g.moveTo(t[0] - 9, t[1]); g.lineTo(t[0] + 9, t[1]); g.moveTo(t[0], t[1] - 9); g.lineTo(t[0], t[1] + 9); g.lineWidth = 1; g.stroke(); }
}
function drawProbeEye(g, pl) {
  const cx = pl.w / 2, cy = pl.h / 2;
  g.strokeStyle = 'rgba(140,224,255,.95)'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(cx, cy, 1.1 / pl.mm, 0, 7); g.stroke();
  g.setLineDash([3, 4]); g.strokeStyle = 'rgba(140,224,255,.55)';
  for (const r of [5, 10]) { g.beginPath(); g.arc(cx, cy, r / pl.mm, 0, 7); g.stroke(); }
  g.setLineDash([]);
  g.font = MONO; g.fillStyle = 'rgba(140,224,255,.8)'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText('5 mm', cx + 5 / pl.mm + 4, cy); g.fillText('10 mm', cx + 10 / pl.mm + 4, cy + 12);
}
function drawRano(g, pl) {
  const r = S.C.meta.metrics.rano; if (!r) return;
  const z = r.slice + 0.5; if (Math.abs(S.cross[2] - z) > 0.6) return;
  const P = pt => mm2s(pl, [pt[0] + 0.5, pt[1] + 0.5, z]);
  const seg = (a, b, col, t) => { const A = P(a), B = P(b); g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke(); for (const q of [A, B]) { g.beginPath(); g.arc(q[0], q[1], 3, 0, 7); g.fillStyle = col; g.fill(); } label(g, t, Math.max(A[0], B[0]) + 6, (A[1] + B[1]) / 2, col); };
  seg(r.ld_pts[0], r.ld_pts[1], '#ffe07a', `${fmt(r.ld, 1)} mm`);
  if (r.pd_pts) seg(r.pd_pts[0], r.pd_pts[1], '#9fe3ff', `${fmt(r.pd, 1)} mm`);
}
function draw3DOverlay(g, r) {
  // orientation triad
  const cam = S.cam3; if (!cam) return;
  const o = [48, r.height - 48], L = 26;
  const axes = [[[1, 0, 0], 'R', '#e0525a'], [[0, 1, 0], 'A', '#5dbb6f'], [[0, 0, 1], 'S', '#7fc4e6']];
  g.lineWidth = 2; g.font = '600 11px "IBM Plex Sans Condensed", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const proj = a => [v3.dot(a, cam.R), -v3.dot(a, cam.U), v3.dot(a, cam.F)];
  axes.map(a => [proj(a[0]), a[1], a[2]]).sort((a, b) => b[0][2] - a[0][2]).forEach(([p, t, c]) => {
    g.strokeStyle = c; g.globalAlpha = p[2] > 0 ? 0.45 : 1; g.beginPath(); g.moveTo(o[0], o[1]); g.lineTo(o[0] + p[0] * L, o[1] + p[1] * L); g.stroke();
    g.fillStyle = c; g.fillText(t, o[0] + p[0] * (L + 9), o[1] + p[1] * (L + 9));
  });
  g.globalAlpha = 1;
  g.font = MONO; g.fillStyle = 'rgba(200,210,218,.6)'; g.textAlign = 'right'; g.textBaseline = 'bottom';
  if (r.width > 300) g.fillText(S.three.preset === 'mip' ? `MIP · ${currentSeq().name}` : 'drag rotate · wheel zoom · double-click to pick', r.width - 10, r.height - 8);
}
