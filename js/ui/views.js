/* ============================ VIEWS ============================ */
import { $, $$, clamp, esc, fmt, m4, v3 } from '../util.js';
import { S, markDirty } from '../state.js';
import { atlasName, field, gridExt, inVol, sampleLin, sampleNear, worldOf } from '../io/volume.js';
import { camera3D } from '../gl/renderer.js';
import { currentSeq, handlePick, syncDepth } from './panels.js';
import { resizeAll, syncRulerBtn } from '../main.js';

export const VIEW_DEF = {
  ax: { name: 'Axial', col: '#e0525a', U: [-1, 0, 0], V: [0, 1, 0], N: [0, 0, 1], ori: ['R', 'L', 'A', 'P'], k: 2 },
  co: { name: 'Coronal', col: '#5dbb6f', U: [-1, 0, 0], V: [0, 0, 1], N: [0, 1, 0], ori: ['R', 'L', 'S', 'I'], k: 1 },
  sa: { name: 'Sagittal', col: '#e3c443', U: [0, -1, 0], V: [0, 0, 1], N: [1, 0, 0], ori: ['A', 'P', 'S', 'I'], k: 0 },
  pe: { name: "Probe's eye", col: '#8fe0ff', oblique: true },
  i1: { name: 'Trajectory A', col: '#8fe0ff', oblique: true },
  i2: { name: 'Trajectory B', col: '#8fe0ff', oblique: true },
  '3d': { name: '3D', col: '#7fc4e6' }
};
const CELLS = ['ax', '3d', 'co', 'sa'];
export function cellView(cell) {
  if (S.plan.probe) return { ax: 'pe', co: 'i1', sa: 'i2', '3d': '3d' }[cell];
  return cell;
}
export function vstate(v) { return S.views[v] || (S.views[v] = { zoom: 1, pan: [0, 0] }); }
export function trajBasis() {
  const pl = S.plan; if (!pl.entry || !pl.target) return null;
  const d = v3.norm(v3.sub(pl.target, pl.entry));
  let a = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = v3.norm(v3.cross(d, a)), w = v3.cross(u, d);
  return { d, u, w, len: v3.dist(pl.entry, pl.target) };
}
export function planeOf(v, w, h) {
  const C = S.C, e = gridExt(C), vs = vstate(v), def = VIEW_DEF[v];
  let U, V, N, center, extU, extV;
  if (!def.oblique) {
    U = def.U; V = def.V; N = def.N;
    center = [e[0] / 2, e[1] / 2, e[2] / 2]; center[def.k] = S.cross[def.k];
    extU = Math.abs(v3.dot(U, e)); extV = Math.abs(v3.dot(V, e));
  } else {
    const b = trajBasis(); if (!b) return null;
    const tip = v3.add(S.plan.entry, v3.mul(b.d, S.plan.depth));
    if (v === 'pe') { U = b.u; V = b.w; N = b.d; center = tip; extU = extV = 64; }
    else if (v === 'i1') { U = b.u; V = v3.mul(b.d, -1); N = b.w; center = v3.lerp(S.plan.entry, S.plan.target, 0.5); extU = extV = b.len + 50; }
    else { U = b.w; V = v3.mul(b.d, -1); N = b.u; center = v3.lerp(S.plan.entry, S.plan.target, 0.5); extU = extV = b.len + 50; }
  }
  center = v3.add(center, v3.add(v3.mul(U, vs.pan[0]), v3.mul(V, vs.pan[1])));
  const mm = Math.max(extU / w, extV / h) * 1.04 / vs.zoom;
  return { U, V, N, center, mm, w, h, v };
}
function s2mm(pl, sx, sy) { return v3.add(pl.center, v3.add(v3.mul(pl.U, (sx - pl.w / 2) * pl.mm), v3.mul(pl.V, (pl.h / 2 - sy) * pl.mm))); }
export function mm2s(pl, p) { const d = v3.sub(p, pl.center); return [pl.w / 2 + v3.dot(d, pl.U) / pl.mm, pl.h / 2 - v3.dot(d, pl.V) / pl.mm, v3.dot(d, pl.N)]; }

/* ---------- DOM cells ---------- */
export function buildCells() {
  const grid = $('#grid'); grid.innerHTML = '';
  for (const c of CELLS) {
    const el = document.createElement('div'); el.className = 'vp'; el.dataset.cell = c; el.tabIndex = 0;
    el.innerHTML = `<div class="vp-head"><span class="vp-title" title="Double-click to enlarge"><i></i><span class="nm"></span></span><div class="vp-tools"></div></div>`;
    grid.appendChild(el);
    attachInteraction(el);
  }
  build3DTools();
  refreshCellTitles();
}
export function refreshCellTitles() {
  for (const el of $$('.vp')) {
    const v = cellView(el.dataset.cell), def = VIEW_DEF[v];
    el.querySelector('.nm').textContent = def.name; el.querySelector('.vp-title i').style.background = def.col;
    el.classList.toggle('main', el.dataset.cell === S.mainView);
  }
}
export function setLayout(mode, main) {
  S.layout = mode; if (main) S.mainView = main;
  const g = $('#grid'); g.className = 'grid' + (mode === 'focus' ? ' focus' : mode === 'solo' ? ' solo' : '');
  // reorder so the main view comes first in focus layout
  const cells = $$('.vp', g);
  if (mode === 'focus') { const m = cells.find(c => c.dataset.cell === S.mainView); g.prepend(m); }
  else CELLS.forEach(c => g.appendChild(cells.find(x => x.dataset.cell === c)));
  $('#lay-quad').setAttribute('aria-pressed', mode === 'quad'); $('#lay-focus').setAttribute('aria-pressed', mode !== 'quad');
  refreshCellTitles(); requestAnimationFrame(() => { resizeAll(); markDirty(); });
}

/* ---------- 3D toolbar ---------- */
export function build3DTools() {
  const el = $('.vp[data-cell="3d"] .vp-tools'); if (!el) return;
  el.innerHTML = '';
  const presets = S.C && S.C.meta.has_head ? [['head', 'Head'], ['brain', 'Brain'], ['glass', 'Glass'], ['mip', 'MIP']] : [['brain', 'Brain'], ['glass', 'Glass'], ['mip', 'MIP']];
  for (const [id, nm] of presets) {
    const b = document.createElement('button'); b.className = 'tbtn'; b.textContent = nm; b.dataset.preset = id;
    b.setAttribute('aria-pressed', S.three.preset === id);
    b.onclick = () => { applyPreset(id); };
    el.appendChild(b);
  }
  const lb = document.createElement('button'); lb.className = 'tbtn'; lb.textContent = 'Layers'; lb.setAttribute('aria-expanded', 'false');
  lb.onclick = e => { e.stopPropagation(); toggleLayerMenu(lb); };
  el.appendChild(lb);
}
export function applyPreset(id) {
  const L = S.three.layers, head = S.C.meta.has_head;
  S.three.preset = id;
  if (id === 'head' && S.three.dist < 500) S.three.dist = 520;
  if (id !== 'head' && S.three.dist > 470) S.three.dist = 410;
  if (id === 'head') Object.assign(L, { skin: true, skinOp: 1, cortex: true, cortexOp: 1, vent: true, tumour: true, edema: false, caps: true, tracts: true }), S.three.cut = true;
  if (id === 'brain') Object.assign(L, { skin: false, cortex: true, cortexOp: 1, vent: true, tumour: true, edema: !head, caps: true, tracts: true }), S.three.cut = true;
  if (id === 'glass') Object.assign(L, { skin: head, skinOp: 0.16, cortex: true, cortexOp: 0.2, vent: true, tumour: true, edema: !head, caps: false, tracts: true }), S.three.cut = false;
  if (id === 'mip') S.three.cut = false;
  $$('.vp[data-cell="3d"] .tbtn[data-preset]').forEach(b => b.setAttribute('aria-pressed', b.dataset.preset === id));
  closeMenus(); markDirty('v3');
}
export function closeMenus() { $$('.menu').forEach(m => m.remove()); }
function toggleLayerMenu(btn) {
  if ($('.menu')) { closeMenus(); return; }
  const C = S.C, L = S.three.layers, head = C.meta.has_head;
  const m = document.createElement('div'); m.className = 'menu';
  const item = (key, label, sw, obj = L) => `<label><input type="checkbox" data-k="${key}" ${obj[key] ? 'checked' : ''}>${sw ? `<span class="sw" style="background:${sw}"></span>` : ''}${label}</label>`;
  m.innerHTML = `<h4>Surfaces</h4>${head ? item('skin', 'Skin', '#d6b8a0') : ''}${item('cortex', 'Cortex', '#dbc2b8')}${item('eloq', 'Motor / sensory cortex (atlas)', '#b873f9')}${item('vent', 'Lateral ventricles', '#5aa9e6')}
    ${item('tumour', head ? 'Tumour' : 'Enhancing tumour / necrosis', '#ffba40')}${head ? '' : item('edema', 'Oedema', '#4ac9a4')}
    <h4>Display</h4>${item('caps', 'MR slices on cut faces')}<label><input type="checkbox" data-cut ${S.three.cut ? 'checked' : ''}>Octant cutaway at crosshair</label>
    ${C.tracts ? `${item('tracts', 'Tractography')}<label><input type="checkbox" data-tc ${S.three.tractColor === 'bundle' ? 'checked' : ''}>Colour tracts by bundle</label><label><input type="checkbox" data-t2 ${S.ov.tracts2d === 'all' ? 'checked' : ''}>All bundles on 2D slices (default: CST)</label>` : ''}`;
  m.addEventListener('pointerdown', e => e.stopPropagation());
  m.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.k) { L[t.dataset.k] = t.checked; if (t.dataset.k === 'skin' && t.checked && !L.skinOp) L.skinOp = 1; }
    if (t.hasAttribute('data-cut')) S.three.cut = t.checked;
    if (t.hasAttribute('data-tc')) S.three.tractColor = t.checked ? 'bundle' : 'dec';
    if (t.hasAttribute('data-t2')) S.ov.tracts2d = t.checked ? 'all' : 'cst';
    markDirty();
  });
  btn.closest('.vp').appendChild(m);
}
document.addEventListener('pointerdown', () => closeMenus());

/* ---------- interaction ---------- */
function attachInteraction(el) {
  const ptrs = new Map(); let mode = null, last = null, pinch = null;
  const getPl = () => { const r = el.getBoundingClientRect(); return planeOf(cellView(el.dataset.cell), r.width, r.height); };
  const local = e => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.querySelector('.vp-title').addEventListener('dblclick', e => { e.stopPropagation(); const c = el.dataset.cell; if (S.layout === 'focus' && S.mainView === c) setLayout('quad'); else setLayout('focus', c); });
  el.querySelector('.vp-title').addEventListener('click', e => { if (matchMedia('(max-width: 860px)').matches) { const c = el.dataset.cell; if (S.layout === 'solo' && S.mainView === c) setLayout('quad'); else setLayout('solo', c); } });
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.vp-tools') || e.target.closest('.menu') || e.target.closest('.vp-title')) return;
    el.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, local(e)); el.focus({ preventScroll: true });
    const v = cellView(el.dataset.cell), p = local(e);
    S.lastInteract = performance.now();
    if (ptrs.size === 2) { const a = [...ptrs.values()]; pinch = { d: Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]), mid: [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2] }; mode = 'pinch'; return; }
    if (v === '3d') {
      mode = (e.button === 2 || e.shiftKey || e.button === 1) ? 'pan3' : 'rot'; S._dragging = true;
      last = p; S.lowRes = true; return;
    }
    const pl = getPl(); if (!pl) return;
    if (e.button === 2) { mode = 'wl'; last = p; return; }
    if (e.button === 1 || e.shiftKey) { mode = 'pan'; last = p; return; }
    const mm = s2mm(pl, p[0], p[1]);
    if (S.pickMode) { handlePick(mm, v); return; }
    if (S.rulerMode) { S.ruler = { a: mm, b: mm, v }; mode = 'ruler'; markDirty('ov'); return; }
    mode = 'nav'; S._dragging = true; setCrossFromView(v, mm);
  });
  el.addEventListener('pointermove', e => {
    const p = local(e);
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
    const v = cellView(el.dataset.cell);
    if (!mode) { if (v !== '3d') hoverAt(v, p, getPl()); return; }
    S.lastInteract = performance.now();
    if (mode === 'pinch' && ptrs.size === 2) {
      const a = [...ptrs.values()]; const d = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]);
      const f = d / Math.max(pinch.d, 1); pinch.d = d;
      if (v === '3d') { S.three.dist = clamp(S.three.dist / f, 120, 1400); S.lowRes = true; markDirty('v3'); }
      else { const vs = vstate(v); vs.zoom = clamp(vs.zoom * f, 0.5, 12); markDirty('v2'); markDirty('ov'); }
      return;
    }
    const dx = p[0] - (last ? last[0] : p[0]), dy = p[1] - (last ? last[1] : p[1]); last = p;
    if (mode === 'rot') { S.three.yaw -= dx * 0.008; S.three.pitch = clamp(S.three.pitch + dy * 0.008, -1.45, 1.45); markDirty('v3'); markDirty('ov'); }
    else if (mode === 'pan3') { const cam = S.cam3 || camera3D(S.C, { cssW: 1, cssH: 1 }); const k = S.three.dist * 0.0012; S.three.target = v3.add(S.three.target, v3.add(v3.mul(cam.R, -dx * k), v3.mul(cam.U, dy * k))); markDirty('v3'); }
    else if (mode === 'wl') { const sq = currentSeq(), wl = S.wl[sq.id]; wl[0] = clamp(wl[0] + dx * 1.2, 4, 400); wl[1] = clamp(wl[1] - dy * 1.0, -60, 320); markDirty(); updateStatusWL(); }
    else if (mode === 'pan') { const pl = getPl(); const vs = vstate(v); vs.pan[0] -= dx * pl.mm; vs.pan[1] += dy * pl.mm; markDirty('v2'); markDirty('ov'); }
    else if (mode === 'nav') { const pl = getPl(); if (pl) setCrossFromView(v, s2mm(pl, p[0], p[1])); hoverAt(v, p, pl); }
    else if (mode === 'ruler') { const pl = getPl(); S.ruler.b = s2mm(pl, p[0], p[1]); markDirty('ov'); }
  });
  const end = e => {
    ptrs.delete(e.pointerId);
    if (mode === 'ruler') { S.rulerMode = false; syncRulerBtn(); }
    if (ptrs.size === 0) { mode = null; pinch = null; S._dragging = false; if (S.lowRes) { S.lowRes = false; markDirty('v3'); } }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => { if (!mode) { S.hover = null; markDirty('v2'); setStatus(null); } });
  el.addEventListener('wheel', e => {
    e.preventDefault(); const v = cellView(el.dataset.cell);
    S.lastInteract = performance.now();
    if (v === '3d') { S.three.dist = clamp(S.three.dist * Math.exp(e.deltaY * 0.0012), 120, 1400); S.lowRes = true; markDirty('v3'); markDirty('ov'); clearTimeout(S._wt); S._wt = setTimeout(() => { S.lowRes = false; markDirty('v3'); }, 180); return; }
    const pl = getPl(); if (!pl) return;
    if (e.ctrlKey || e.metaKey) {
      const vs = vstate(v), p = local(e), before = s2mm(pl, p[0], p[1]);
      vs.zoom = clamp(vs.zoom * Math.exp(-e.deltaY * 0.002), 0.5, 12);
      const pl2 = getPl(), after = s2mm(pl2, p[0], p[1]); const d = v3.sub(before, after);
      vs.pan[0] += v3.dot(d, pl.U); vs.pan[1] += v3.dot(d, pl.V);
      markDirty('v2'); markDirty('ov'); return;
    }
    const step = (e.deltaY > 0 ? -1 : 1) * (Math.abs(e.deltaY) > 60 ? 2 : 1);
    if (VIEW_DEF[v].oblique) { if (v === 'pe') { const b = trajBasis(); S.plan.depth = clamp(S.plan.depth + step, -20, b.len + 15); syncDepth(); markDirty(); } return; }
    const c = S.cross.slice(); c[VIEW_DEF[v].k] = clamp(c[VIEW_DEF[v].k] + step, 0.5, gridExt(S.C)[VIEW_DEF[v].k] - 0.5); setCross(c);
  }, { passive: false });
  el.addEventListener('dblclick', e => {
    const v = cellView(el.dataset.cell); if (v !== '3d' || e.target.closest('.vp-head')) return;
    const r = el.getBoundingClientRect(); const hit = pick3D((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2, r);
    if (!hit) return;
    if (S.pickMode) handlePick(hit.p, '3d'); else setCross(hit.p);
  });
  el.addEventListener('keydown', e => {
    const v = cellView(el.dataset.cell); if (v === '3d' || VIEW_DEF[v].oblique) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault(); const k = VIEW_DEF[v].k, c = S.cross.slice(); c[k] = clamp(c[k] + (e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : -1), 0.5, gridExt(S.C)[k] - 0.5); setCross(c);
    }
  });
}
function setCrossFromView(v, mm) {
  if (VIEW_DEF[v].oblique) { const c = mm.map((x, i) => clamp(x, 0.5, gridExt(S.C)[i] - 0.5)); setCross(c); return; }
  const c = S.cross.slice(); const k = VIEW_DEF[v].k;
  for (let i = 0; i < 3; i++) if (i !== k) c[i] = clamp(mm[i], 0.5, gridExt(S.C)[i] - 0.5);
  setCross(c);
}
export function setCross(c) { S.cross = c; interactiveHint(); markDirty(); }
export function interactiveHint() { S.lowRes = true; clearTimeout(S._lr); S._lr = setTimeout(() => { if (!S._dragging) { S.lowRes = false; markDirty('v3'); } }, 220); }

/* ---------- 3D picking (CPU ray march) ---------- */
function pick3D(nx, ny, r) {
  const C = S.C, cam = camera3D(C, { cssW: r.width, cssH: r.height });
  const a = m4.xf(cam.inv, [nx, ny, -1]), b = m4.xf(cam.inv, [nx, ny, 1]);
  const d = v3.norm(v3.sub(b, a)); const e = gridExt(C);
  const L = S.three.layers, head = C.meta.has_head;
  const cd = [Math.sign(cam.eye[0] - S.cross[0]) || 1, Math.sign(cam.eye[1] - S.cross[1]) || 1, Math.sign(cam.eye[2] - S.cross[2]) || 1];
  const inCut = p => S.three.cut && (p[0] - S.cross[0]) * cd[0] > 0 && (p[1] - S.cross[1]) * cd[1] > 0 && (p[2] - S.cross[2]) * cd[2] > 0;
  let prevCut = true;
  for (let t = 0; t < 2400; t += 0.6) {
    const p = v3.add(a, v3.mul(d, t));
    if (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] > e[0] || p[1] > e[1] || p[2] > e[2]) { prevCut = true; continue; }
    const cut = inCut(p);
    if (!cut && prevCut && L.caps && S.three.cut) { const m = head ? field(C, 'head', p) : field(C, 'brain', p); if (m > 0.5) return { p, kind: 'cap' }; }
    if (!cut && head && L.skin && L.skinOp > 0.5 && field(C, 'head', p) > 0.5) return { p, kind: 'skin' };
    if (!cut && L.cortex && L.cortexOp > 0.5 && field(C, 'cortex', p) > 0.5) return { p, kind: 'cortex' };
    if (L.tumour && (field(C, head ? 'tumour' : 'tc', p) > 0.5)) return { p, kind: 'tumour' };
    prevCut = cut;
  }
  return null;
}

/* ---------- hover / status ---------- */
function hoverAt(v, sp, pl) {
  if (!pl) return;
  const p = s2mm(pl, sp[0], sp[1]);
  if (!inVol(S.C, p)) { S.hover = null; setStatus(null); return; }
  const C = S.C, at = C.meta.fields.atlas;
  const code = sampleNear(C, at[0], at[1], p);
  const changed = !S.hover || S.hover.code !== code;
  S.hover = { p, code, v };
  if (changed && S.ov.atlas) markDirty('v2');
  setStatus(p);
}
function seqReadout(C, p) {
  const sq = currentSeq();
  if (sq.ch < 0) { const fa = C.meta.sequences.find(s => s.id === 'FA'); const v = sampleLin(C, fa.tex, fa.ch, p); const d = [0, 1, 2].map(c => sampleLin(C, sq.tex, c, p)); return `FA ${fmt(v, 2)} · V1 [${d.map(x => fmt(x, 2)).join(', ')}]`; }
  const v = sampleLin(C, sq.tex, sq.ch, p);
  if (sq.unit === 'adc') return `ADC ${fmt(v * 3.2, 2)}×10⁻³ mm²/s`;
  if (sq.unit === 'fa') return `FA ${fmt(v, 2)}`;
  return `${sq.name} ${Math.round(v * 255)}`;
}
export function setStatus(p) {
  const el = $('#status'), C = S.C;
  if (!p || !C) { el.innerHTML = `<span class="dim">${S.pickMode ? 'Click an image or double-click the 3D view to place the ' + S.pickMode : 'Move over an image to read position, signal and anatomy'}</span><span class="spacer" style="flex:1"></span><span id="wlread"></span>`; updateStatusWL(); return; }
  const w = worldOf(C, p), at = C.meta.fields.atlas;
  const code = sampleNear(C, at[0], at[1], p);
  let tissue = '';
  if (C.meta.fields.seg) { const L = sampleNear(C, C.meta.fields.seg[0], C.meta.fields.seg[1], p); if (L) tissue = C.meta.labels.items.find(i => i.v === L).name; }
  else if (C.meta.fields.tumour && field(C, 'tumour', p) > 0.5) tissue = 'Tumour (meningioma)';
  if (!tissue && field(C, 'vent', p) > 0.5) tissue = 'Ventricular CSF';
  const an = atlasName(C, code);
  const coordLab = C.meta.has_head ? 'Scanner RAS' : 'Volume';
  el.innerHTML = `<span><span class="dim">${coordLab}</span> <b>${fmt(w[0], 1)}, ${fmt(w[1], 1)}, ${fmt(w[2], 1)}</b> mm</span><span>${seqReadout(C, p)}</span>` +
    (tissue ? `<span class="lab" style="color:var(--et)">${esc(tissue)}</span>` : '') + (an ? `<span class="lab">${esc(an)}</span>` : '') +
    `<span class="spacer" style="flex:1"></span><span id="wlread"></span>`;
  updateStatusWL();
}
function updateStatusWL() { const el = $('#wlread'); if (!el || !S.C) return; const sq = currentSeq(), wl = S.wl[sq.id]; el.textContent = sq.ch < 0 ? 'DEC gain' : `W ${Math.round(wl[0])} · L ${Math.round(wl[1])}`; }
