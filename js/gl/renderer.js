/* ============================ WEBGL RENDERER ============================ */
import { m4, v3 } from '../util.js';
import { S } from '../state.js';
import { gridExt } from '../io/volume.js';
import { FS_COMP, FS_LINE, FS_SLICE, FS_SPH, FS_TRACT, VS_LINE, VS_QUAD, VS_SPH, VS_TRACT, fs3D } from './shaders.js';
import { currentSeq } from '../ui/panels.js';

export const R = { gl: null, prog: {}, tex: [], fbo: null, fboW: 0, fboH: 0, tractBuf: null, trajBuf: null, riskTex: null, footTex: null, lineBuf: null };

function glCompile(type, src) {
  const gl = R.gl, s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(log, src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}
function glProgram(vs, fs) {
  const gl = R.gl, p = gl.createProgram();
  gl.attachShader(p, glCompile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, glCompile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(p));
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
  const a = {}, na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, u, a };
}
export function initGL(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: false, depth: true, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  R.gl = gl;
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  R.vao = gl.createVertexArray();
  R.prog.slice = glProgram(VS_QUAD, FS_SLICE);
  R.prog.comp = glProgram(VS_QUAD, FS_COMP);
  R.prog.tract = glProgram(VS_TRACT, FS_TRACT);
  R.prog.sph = glProgram(VS_SPH, FS_SPH);
  R.prog.line = glProgram(VS_LINE, FS_LINE);
  R.riskTex = makeTex2D(4, 4, null); R.footTex = makeTex2D(4, 4, null);
}
function makeTex2D(w, h, data) {
  const gl = R.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data || new Uint8Array(w * h * 4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
export function updateTex2D(t, w, h, data, wrapS) {
  const gl = R.gl; gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS || gl.REPEAT);
}
export function uploadCase(C) {
  const gl = R.gl;
  R.tex.forEach(t => gl.deleteTexture(t)); R.tex = [];
  for (const T of C.tex) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, T.dims[0], T.dims[1], T.dims[2], 0, gl.RGB, gl.UNSIGNED_BYTE, T.data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    R.tex.push(t);
  }
  while (R.tex.length < 4) R.tex.push(R.tex[0]);
  if (R.prog.ray) gl.deleteProgram(R.prog.ray.p);
  R.prog.ray = glProgram(VS_QUAD, fs3D(C));
  buildTractGeometry(C);
}
function bindVolume(P, C) {
  const gl = R.gl;
  for (let i = 0; i < 4; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_3D, R.tex[i]); gl.uniform1i(P.u['uT' + i], i); }
  const E = [], D = [], Sp = [];
  for (let i = 0; i < 4; i++) { const T = C.tex[Math.min(i, C.tex.length - 1)]; E.push(...T.ext); D.push(...T.dims); Sp.push(T.spacing[0]); }
  gl.uniform3fv(P.u.uE, E); gl.uniform3iv(P.u.uD, D); gl.uniform1fv(P.u.uSp, Sp);
  gl.uniform3fv(P.u.uBox, gridExt(C));
  const sq = currentSeq(), wl = S.wl[sq.id];
  gl.uniform1i(P.u.uSeqT, sq.tex); gl.uniform1i(P.u.uSeqC, Math.max(sq.ch, 0)); gl.uniform1i(P.u.uSeqMode, sq.ch < 0 ? 1 : 0);
  const fa = C.meta.sequences.find(s => s.id === 'FA');
  gl.uniform1i(P.u.uFAT, fa ? fa.tex : 0); gl.uniform1i(P.u.uFAC, fa ? fa.ch : 0); gl.uniform1f(P.u.uGain, wl ? 255 / wl[0] * 1.6 : 1.6);
  gl.uniform2f(P.u.uWL, wl[0] / 255, wl[1] / 255);
  const seg = C.meta.fields.seg, tum = C.meta.fields.tumour;
  if (seg && S.ov.seg) { gl.uniform1i(P.u.uSegMode, 1); gl.uniform1i(P.u.uSegT, seg[0]); gl.uniform1i(P.u.uSegC, seg[1]); }
  else if (tum && S.ov.seg && P.u.uSegMode) { gl.uniform1i(P.u.uSegMode, P === R.prog.slice ? 0 : 2); gl.uniform1i(P.u.uSegT, tum[0]); gl.uniform1i(P.u.uSegC, tum[1]); }
  else gl.uniform1i(P.u.uSegMode, 0);
  const cols = [0, 0, 0]; const items = C.meta.labels.items;
  for (let i = 1; i <= 3; i++) { const it = items.find(x => (x.v || 1) === i) || items[0]; cols.push(...it.color.map(v => v / 255)); }
  gl.uniform3fv(P.u.uSegCol, cols); gl.uniform1f(P.u.uSegA, P === R.prog.slice ? 0.2 : 0.3);
  const at = C.meta.fields.atlas; gl.uniform1i(P.u.uAtT, at[0]); gl.uniform1i(P.u.uAtC, at[1]);
}
export function viewportRect(el, host, dpr, H) {
  const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
  const x = Math.round((r.left - h.left) * dpr), y = Math.round((r.top - h.top) * dpr), w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
  return { x, y: H - y - hh, w, h: hh, cssW: r.width, cssH: r.height };
}
export function drawSlice(C, vp, pl) {
  const gl = R.gl, P = R.prog.slice;
  gl.useProgram(P.p); gl.bindVertexArray(R.vao);
  gl.viewport(vp.x, vp.y, vp.w, vp.h); gl.scissor(vp.x, vp.y, vp.w, vp.h);
  gl.disable(gl.DEPTH_TEST);
  bindVolume(P, C);
  gl.uniform3fv(P.u.uO, pl.center);
  gl.uniform3fv(P.u.uU, v3.mul(pl.U, pl.mm * vp.cssW / 2));
  gl.uniform3fv(P.u.uV, v3.mul(pl.V, pl.mm * vp.cssH / 2));
  gl.uniform2f(P.u.uPx, pl.mm * vp.cssW / vp.w, pl.mm * vp.cssH / vp.h);
  const tum = C.meta.fields.tumour;
  gl.uniform1i(P.u.uTumOn, tum && S.ov.seg ? 1 : 0);
  if (tum) { gl.uniform1i(P.u.uTumT, tum[0]); gl.uniform1i(P.u.uTumC, tum[1]); gl.uniform3f(P.u.uTumCol, 1, 0.73, 0.25); }
  gl.uniform1i(P.u.uHover, S.ov.atlas && S.hover && S.hover.code ? S.hover.code : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function ensureFBO(w, h) {
  const gl = R.gl;
  if (R.fbo && R.fboW === w && R.fboH === h) return;
  if (R.fbo) { gl.deleteFramebuffer(R.fbo); gl.deleteTexture(R.fboC); gl.deleteTexture(R.fboZ); }
  R.fboC = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, R.fboC);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  R.fboZ = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, R.fboZ);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  R.fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, R.fboC, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, R.fboZ, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  R.fboW = w; R.fboH = h;
}
export function camera3D(C, vp) {
  const T = S.three, t = T.target;
  const eye = [t[0] + T.dist * Math.cos(T.pitch) * Math.cos(T.yaw), t[1] + T.dist * Math.cos(T.pitch) * Math.sin(T.yaw), t[2] + T.dist * Math.sin(T.pitch)];
  const view = m4.lookAt(eye, t, [0, 0, 1]);
  const proj = m4.persp(26 * Math.PI / 180, vp.cssW / Math.max(vp.cssH, 1), 5, 2000);
  const vpm = m4.mul(proj, view);
  const F = v3.norm(v3.sub(t, eye)), Rr = v3.norm(v3.cross(F, [0, 0, 1])), U = v3.cross(Rr, F);
  const light = v3.norm(v3.add(v3.add(v3.mul(U, 0.75), v3.mul(Rr, -0.45)), v3.mul(F, -0.55)));
  return { eye, view, proj, vp: vpm, inv: m4.inv(vpm), F, R: Rr, U, light };
}
function layerState(C) {
  const L = S.three.layers, head = C.meta.has_head;
  const op = [head && L.skin ? L.skinOp : 0, L.cortex ? L.cortexOp : 0, L.vent ? 0.92 : 0, L.tumour ? 1 : 0, (L.tumour && !head) ? 1 : 0, L.edema ? 0.34 : 0];
  const col = [[0.84, 0.72, 0.63], [0.86, 0.76, 0.72], [0.35, 0.66, 0.9], head ? [1.0, 0.72, 0.25] : [1.0, 0.72, 0.25], [0.92, 0.37, 0.52], [0.29, 0.79, 0.64]];
  return { op, col };
}
export function draw3D(C, vp) {
  const gl = R.gl, cam = camera3D(C, vp);
  const scale = (S.lowRes ? 0.5 : 1) * (S.q3 || 1);
  const fw = Math.max(2, Math.round(vp.w * scale)), fh = Math.max(2, Math.round(vp.h * scale));
  ensureFBO(fw, fh);
  // --- ray march into FBO ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbo);
  gl.viewport(0, 0, fw, fh); gl.disable(gl.SCISSOR_TEST);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const P = R.prog.ray; gl.useProgram(P.p); gl.bindVertexArray(R.vao);
  bindVolume(P, C);
  gl.uniformMatrix4fv(P.u.uInvVP, false, cam.inv); gl.uniformMatrix4fv(P.u.uVP, false, cam.vp);
  gl.uniform3fv(P.u.uEye, cam.eye); gl.uniform3fv(P.u.uLight, cam.light);
  gl.uniform3fv(P.u.uCross, S.cross);
  const cd = [Math.sign(cam.eye[0] - S.cross[0]) || 1, Math.sign(cam.eye[1] - S.cross[1]) || 1, Math.sign(cam.eye[2] - S.cross[2]) || 1];
  gl.uniform3fv(P.u.uCutDir, cd); gl.uniform1i(P.u.uCut, S.three.cut ? 1 : 0);
  gl.uniform1f(P.u.uStep, (S.lowRes ? 0.85 : 0.5) / Math.min(1, (S.q3 || 1) * 1.6));
  const ls = layerState(C);
  gl.uniform1fv(P.u.uOp, ls.op); gl.uniform3fv(P.u.uCol, ls.col.flat());
  gl.uniform1i(P.u.uCaps, S.three.layers.caps ? 1 : 0); gl.uniform1i(P.u.uClipTum, S.three.clipTum ? 1 : 0);
  gl.uniform1i(P.u.uEloq, S.three.layers.eloq && !(S.tab === 'plan' && S.plan.risk && S.plan.riskReady) ? 1 : 0);
  const pl = S.plan;
  gl.uniform1i(P.u.uRisk, pl.risk && pl.riskReady && pl.target && S.tab === 'plan' ? 1 : 0);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, R.riskTex); gl.uniform1i(P.u.uRiskTex, 4);
  gl.uniform3fv(P.u.uTarget, pl.target || [0, 0, 0]);
  gl.uniform1i(P.u.uFoot, pl.foot && pl.footReady ? 1 : 0);
  gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, R.footTex); gl.uniform1i(P.u.uFootTex, 5);
  if (pl.footFrame) { const f = pl.footFrame; gl.uniform3fv(P.u.uFootO, f.O); gl.uniform3fv(P.u.uFootU, f.U); gl.uniform3fv(P.u.uFootV, f.V); gl.uniform3fv(P.u.uFootN, f.N); gl.uniform1f(P.u.uFootR, f.R); }
  gl.uniform1i(P.u.uMip, S.three.preset === 'mip' ? 1 : 0);
  gl.uniform3f(P.u.uBgA, 0.055, 0.07, 0.085); gl.uniform3f(P.u.uBgB, 0.012, 0.016, 0.02);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  // --- composite ---
  gl.enable(gl.SCISSOR_TEST);
  gl.viewport(vp.x, vp.y, vp.w, vp.h); gl.scissor(vp.x, vp.y, vp.w, vp.h);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  const Q = R.prog.comp; gl.useProgram(Q.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.fboC); gl.uniform1i(Q.u.uC, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.fboZ); gl.uniform1i(Q.u.uZ, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // --- geometry ---
  gl.depthFunc(gl.LESS);
  if (S.three.preset !== 'mip') { drawTracts(C, cam); drawTrajectory3D(C, cam); }
  gl.disable(gl.DEPTH_TEST);
  return cam;
}
/* ---------- tract geometry ---------- */
export const BUNDLE_ORDER = ['CST_L', 'CST_R', 'AF_L', 'AF_R', 'OR_L', 'OR_R', 'CC', 'IFOF_L', 'IFOF_R'];
export const BUNDLE_COL = { CST_L: '#3987e5', CST_R: '#d95926', AF_L: '#1baf7a', AF_R: '#c98500', OR_L: '#9085e9', OR_R: '#d55181', CC: '#e8e6df', IFOF_L: '#5fb8c9', IFOF_R: '#b7a34a' };
function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
function buildTractGeometry(C) {
  const gl = R.gl;
  if (R.tractBuf) { gl.deleteBuffer(R.tractBuf.vb); gl.deleteBuffer(R.tractBuf.ib); gl.deleteVertexArray(R.tractBuf.vao); R.tractBuf = null; }
  if (!C.tracts) return;
  let nv = 0, ni = 0;
  for (const k of BUNDLE_ORDER) for (const s of (C.tracts[k] || [])) { const n = s.length / 3; nv += n * 2; ni += (n - 1) * 6; }
  const V = new Float32Array(nv * 14), I = new Uint32Array(ni);
  let vo = 0, io = 0, base = 0;
  BUNDLE_ORDER.forEach((k, bi) => {
    const bc = hex2rgb(BUNDLE_COL[k]);
    for (const s of (C.tracts[k] || [])) {
      const n = s.length / 3;
      for (let i = 0; i < n; i++) {
        const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
        let tx = s[b * 3] - s[a * 3], ty = s[b * 3 + 1] - s[a * 3 + 1], tz = s[b * 3 + 2] - s[a * 3 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        const dc = [Math.abs(tx), Math.abs(ty), Math.abs(tz)];
        const m = Math.max(dc[0], dc[1], dc[2]);
        const dec = dc.map(v => Math.min(1, 0.12 + 0.95 * v / m * (0.55 + 0.45 * m)));
        for (const side of [-1, 1]) {
          V.set([s[i * 3], s[i * 3 + 1], s[i * 3 + 2], tx, ty, tz, side, dec[0], dec[1], dec[2], bi, bc[0], bc[1], bc[2]], vo); vo += 14;
        }
      }
      for (let i = 0; i < n - 1; i++) { const o = base + i * 2; I.set([o, o + 1, o + 2, o + 1, o + 3, o + 2], io); io += 6; }
      base += n * 2;
    }
  });
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, V, gl.STATIC_DRAW);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
  const P = R.prog.tract, st = 14 * 4;
  const at = (name, size, off) => { const l = P.a[name]; if (l === undefined || l < 0) return; gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, st, off * 4); };
  at('aPos', 3, 0); at('aTan', 3, 3); at('aSide', 1, 6); at('aCol', 3, 7); at('aB', 1, 10);
  // second VAO with bundle colours
  const vao2 = gl.createVertexArray(); gl.bindVertexArray(vao2); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  at('aPos', 3, 0); at('aTan', 3, 3); at('aSide', 1, 6); at('aCol', 3, 11); at('aB', 1, 10);
  gl.bindVertexArray(null);
  R.tractBuf = { vao, vao2, vb, ib, count: ni };
}
export function tractMask() { let m = 0; BUNDLE_ORDER.forEach((k, i) => { if (S.tractOn[k]) m |= 1 << i; }); return m; }
function drawTracts(C, cam) {
  if (!R.tractBuf || !S.three.layers.tracts) return;
  const gl = R.gl, P = R.prog.tract; gl.useProgram(P.p);
  gl.bindVertexArray(S.three.tractColor === 'bundle' ? R.tractBuf.vao2 : R.tractBuf.vao);
  gl.uniformMatrix4fv(P.u.uVP, false, cam.vp); gl.uniform3fv(P.u.uEye, cam.eye); gl.uniform1f(P.u.uR, 0.42);
  gl.uniform1i(P.u.uMask, tractMask()); gl.uniform3fv(P.u.uLight, cam.light); gl.uniform1i(P.u.uOverride, 0);
  gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_3D, R.tex[0]); gl.uniform1i(P.u.uBrainT, 6); gl.uniform3fv(P.u.uBrainE, C.tex[0].ext); gl.uniform1i(P.u.uClip, 1);
  gl.drawElements(gl.TRIANGLES, R.tractBuf.count, gl.UNSIGNED_INT, 0);
  gl.bindVertexArray(null);
}
function ribbonBuffer(pts, col) {
  const gl = R.gl; const n = pts.length; const V = new Float32Array(n * 2 * 14); const I = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)]; const t = v3.norm(v3.sub(b, a));
    for (const side of [-1, 1]) V.set([...pts[i], ...t, side, ...col, 0, ...col], (i * 2 + (side > 0 ? 1 : 0)) * 14);
  }
  for (let i = 0; i < n - 1; i++) { const o = i * 2; I.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, V, gl.DYNAMIC_DRAW);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(I), gl.DYNAMIC_DRAW);
  const P = R.prog.tract, st = 56;
  const at = (name, size, off) => { const l = P.a[name]; if (l === undefined || l < 0) return; gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, st, off * 4); };
  at('aPos', 3, 0); at('aTan', 3, 3); at('aSide', 1, 6); at('aCol', 3, 7); at('aB', 1, 10);
  gl.bindVertexArray(null);
  return { vao, vb, ib, count: I.length };
}
function drawSphere(cam, c, r, col, ring) {
  const gl = R.gl, P = R.prog.sph; gl.useProgram(P.p); gl.bindVertexArray(R.vao);
  gl.uniformMatrix4fv(P.u.uVP, false, cam.vp); gl.uniform3fv(P.u.uC, c); gl.uniform1f(P.u.uR, r);
  gl.uniform3fv(P.u.uCamR, cam.R); gl.uniform3fv(P.u.uCamU, cam.U); gl.uniform3fv(P.u.uCamF, cam.F);
  gl.uniform3fv(P.u.uLight, cam.light); gl.uniform3fv(P.u.uColr, col); gl.uniform1i(P.u.uRing, ring ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
function drawTrajectory3D(C, cam) {
  const pl = S.plan; if (!pl.target) return;
  const gl = R.gl;
  if (pl.entry && S.three.layers.traj !== false) {
    const d = v3.norm(v3.sub(pl.target, pl.entry)), ext = v3.add(pl.entry, v3.mul(d, -25));
    const key = [...pl.entry, ...pl.target].join(',');
    if (!R.trajBuf || R.trajBuf.key !== key) {
      if (R.trajBuf) { gl.deleteBuffer(R.trajBuf.vb); gl.deleteBuffer(R.trajBuf.ib); gl.deleteVertexArray(R.trajBuf.vao); }
      R.trajBuf = ribbonBuffer([ext, pl.entry, pl.target], [0.55, 0.9, 1]); R.trajBuf.key = key;
    }
    const P = R.prog.tract; gl.useProgram(P.p); gl.bindVertexArray(R.trajBuf.vao);
    gl.uniformMatrix4fv(P.u.uVP, false, cam.vp); gl.uniform3fv(P.u.uEye, cam.eye); gl.uniform1f(P.u.uR, 1.1);
    gl.uniform1i(P.u.uOverride, 1); gl.uniform3f(P.u.uOCol, 0.55, 0.88, 1.0); gl.uniform3fv(P.u.uLight, cam.light); gl.uniform1i(P.u.uClip, 0);
    gl.drawElements(gl.TRIANGLES, R.trajBuf.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    drawSphere(cam, pl.entry, 3.2, [0.55, 0.88, 1.0], true);
    if (S.plan.probe || S.plan.flying) { const tip = v3.add(pl.entry, v3.mul(d, S.plan.depth)); drawSphere(cam, tip, 2.0, [1, 1, 1], false); }
  }
  drawSphere(cam, pl.target, 3.0, [1.0, 0.86, 0.3], false);
}
function drawPlaneFrames(C, cam) {
  if (!S.ov.cross) return;
  const gl = R.gl, e = gridExt(C), c = S.cross;
  const L = [];
  const push = (a, b, col) => { L.push(...a, ...col, ...b, ...col); };
  const ax = [0.88, 0.32, 0.35], co = [0.36, 0.73, 0.44], sa = [0.89, 0.77, 0.26];
  const rect = (pts, col) => { for (let i = 0; i < 4; i++) push(pts[i], pts[(i + 1) % 4], col); };
  rect([[0, 0, c[2]], [e[0], 0, c[2]], [e[0], e[1], c[2]], [0, e[1], c[2]]], ax);
  rect([[0, c[1], 0], [e[0], c[1], 0], [e[0], c[1], e[2]], [0, c[1], e[2]]], co);
  rect([[c[0], 0, 0], [c[0], e[1], 0], [c[0], e[1], e[2]], [c[0], 0, e[2]]], sa);
  const data = new Float32Array(L);
  if (!R.lineBuf) { R.lineBuf = { vao: gl.createVertexArray(), vb: gl.createBuffer() }; gl.bindVertexArray(R.lineBuf.vao); gl.bindBuffer(gl.ARRAY_BUFFER, R.lineBuf.vb);
    const P = R.prog.line; gl.enableVertexAttribArray(P.a.aPos); gl.vertexAttribPointer(P.a.aPos, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(P.a.aCol); gl.vertexAttribPointer(P.a.aCol, 3, gl.FLOAT, false, 24, 12); }
  gl.bindVertexArray(R.lineBuf.vao); gl.bindBuffer(gl.ARRAY_BUFFER, R.lineBuf.vb); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  const P = R.prog.line; gl.useProgram(P.p); gl.uniformMatrix4fv(P.u.uVP, false, cam.vp);
  gl.drawArrays(gl.LINES, 0, L.length / 6);
  gl.bindVertexArray(null);
}
