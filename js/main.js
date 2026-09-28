/* ============================ MAIN ============================ */
import { $, $$, v3 } from './util.js';
import { CASES, S, markDirty } from './state.js';
import { loadCase } from './io/loader.js';
import { gridExt } from './io/volume.js';
import { BUNDLE_ORDER, R, draw3D, drawSlice, initGL, uploadCase, viewportRect } from './gl/renderer.js';
import { applyPreset, build3DTools, buildCells, cellView, closeMenus, planeOf, refreshCellTitles, setLayout, setStatus } from './ui/views.js';
import { drawOverlays, prepTractPoints } from './ui/overlays.js';
import { defaultTarget, prepPlanning } from './analysis/planning.js';
import { KS } from './analysis/kspace.js';
import { autoPlan, buildAbout, buildFindings, buildPlan, buildScan, buildTopbar, syncOvChips, syncPlanUI } from './ui/panels.js';
import { ASK, buildAsk, initAsk } from './ui/ask.js';

export function resizeAll() {
  const cv = $('#gl'), ov = $('#ov'), host = $('#viewer');
  const dpr = Math.min(window.devicePixelRatio || 1, 2); S.dpr = dpr;
  const r = host.getBoundingClientRect();
  const W = Math.max(2, Math.round(r.width * dpr)), H = Math.max(2, Math.round(r.height * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; ov.width = W; ov.height = H; markDirty(); }
}
function render() {
  const C = S.C; if (!C || !R.gl) return;
  const gl = R.gl, host = $('#viewer'), H = $('#gl').height;
  // Settle to full resolution shortly after interaction ends
  if (S.lowRes && performance.now() - S.lastInteract > 220 && !$$('.vp').some(v => v.matches(':active'))) { /* keep until pointerup */ }
  const any = S.dirty.v2 || S.dirty.v3 || S.dirty.ov;
  if (!any) return;
  gl.enable(gl.SCISSOR_TEST);
  if (S.dirty.full !== false && (S.dirty.v2 && S.dirty.v3)) { gl.disable(gl.SCISSOR_TEST); gl.viewport(0, 0, $('#gl').width, H); gl.clearColor(0.133, 0.165, 0.196, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.SCISSOR_TEST); }
  for (const el of $$('.vp')) {
    if (getComputedStyle(el).display === 'none') continue;
    const v = cellView(el.dataset.cell), vp = viewportRect(el, host, S.dpr, H);
    if (vp.w < 2 || vp.h < 2) continue;
    if (v === '3d') { if (S.dirty.v3) { S.cam3 = draw3D(C, vp); } }
    else if (S.dirty.v2) {
      const pl = planeOf(v, vp.cssW, vp.cssH);
      if (pl) drawSlice(C, vp, pl);
      else { gl.viewport(vp.x, vp.y, vp.w, vp.h); gl.scissor(vp.x, vp.y, vp.w, vp.h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    }
  }
  drawOverlays();
  S.dirty.v2 = S.dirty.v3 = S.dirty.ov = false;
  if (S.plan.entry && $('#planChecks') && S._planKey !== [S.plan.entry, S.plan.target].join()) { S._planKey = [S.plan.entry, S.plan.target].join(); syncPlanUI(); }
}
function loop() { try { render(); } catch (e) { console.error(e); showError(e); } requestAnimationFrame(loop); }
function showError(e) {
  const l = $('#loading'); l.hidden = false;
  $('#loadMsg').textContent = 'Something went wrong'; $('#loadPct').textContent = '';
  $('#loadLog').textContent = String(e && e.message || e);
}
function logLoad(msg) { const el = $('#loadLog'); const lines = el.textContent.split('\n').filter(Boolean); lines.push(msg); el.textContent = lines.slice(-5).join('\n'); }
export async function openCase(id) {
  const l = $('#loading'); l.hidden = false; $('#loadMsg').textContent = 'Loading ' + (CASES.find(c => c.id === id).label.toLowerCase()) + ' case'; $('#loadLog').textContent = '';
  const setP = (f, msg) => { $('#loadBar').style.width = (f * 100).toFixed(0) + '%'; $('#loadPct').textContent = (f * 100).toFixed(0) + '%'; if (msg) logLoad(msg); };
  cancelAnimationFrame(KS.raf); $('#acq').hidden = true;
  let C;
  try { C = await loadCase(id, setP); } catch (e) { showError(e); return; }
  S.caseId = id; S.C = C;
  const m = C.meta;
  S.seq = m.sequences[id === 'brats011' ? 2 : 0].id;
  S.wl = {}; m.sequences.forEach(s => S.wl[s.id] = s.wl.slice());
  const c = m.metrics.centroid_vox; S.cross = [c[0] + 0.5, c[1] + 0.5, c[2] + 0.5];
  S.views = {}; S.hover = null; S.rano = false; S.ruler = null; S.pickMode = null;
  S.tractOn = {}; BUNDLE_ORDER.forEach(k => S.tractOn[k] = ['CST_L', 'CST_R', 'AF_L', 'AF_R', 'CC'].includes(k) && C.tracts && C.tracts[k] && C.tracts[k].length > 0); S.ov.tracts2d = 'cst';
  if (C.tracts) S.tractOn.OR_R = S.tractOn.OR_L = false;
  S.three.layers = { skin: !!m.has_head, skinOp: 1, cortex: true, cortexOp: 1, vent: true, tumour: true, edema: false, caps: true, tracts: true, eloq: true, traj: true };
  { const e = gridExt(C); S.three.target = v3.lerp([e[0] / 2, e[1] / 2, e[2] * (m.has_head ? 0.55 : 0.5)], S.cross, 0.35); } S.three.dist = m.has_head ? 410 : 380;
  if (m.has_head) { S.three.yaw = -0.62; S.three.pitch = 0.58; } else { S.three.yaw = Math.PI - 0.85; S.three.pitch = 0.55; }
  S.plan = { target: null, entry: null, depth: 0, probe: false, risk: true, foot: false, riskReady: false, footReady: false };
  setP(0.95, 'Uploading volumes to the GPU');
  uploadCase(C);
  prepTractPoints(C);
  setP(0.97, 'Preparing planning maps');
  await new Promise(r => setTimeout(r, 0));
  prepPlanning(C);
  S.plan.target = defaultTarget(C); S.plan.targetIsDefault = true;
  buildTopbar(); build3DTools(); applyPreset('brain');
  buildFindings(); buildPlan(); buildScan();
  refreshCellTitles(); resizeAll(); markDirty(); setStatus(null);
  l.hidden = true;
  if (ASK.sample) { ASK.turns = []; buildAsk(); }
  autoPlan(true);
}
function initTabs() {
  $$('.tabs button').forEach(b => b.onclick = () => {
    $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
    ['findings', 'plan', 'scan', 'ask'].forEach(t => $('#tab-' + t).hidden = t !== b.dataset.tab);
    S.tab = b.dataset.tab; markDirty('v3');
  });
}
export function syncRulerBtn() { if (typeof syncOvChips === 'function') syncOvChips(); }
async function boot() {
  S.q3 = location.hash.includes('lowgpu') ? 0.3 : 1; { const m = location.hash.match(/q(\d+)/); if (m) S.q3 = +m[1] / 100; }
  try { initGL($('#gl')); } catch (e) { showError(e); return; }
  buildCells(); initTabs(); buildAbout();
  $('#lay-quad').onclick = () => setLayout('quad');
  $('#lay-focus').onclick = () => setLayout('focus', S.mainView === '3d' ? '3d' : '3d');
  $('#aboutBtn').onclick = () => { $('#about').hidden = false; };
  $('#acqClose').onclick = () => { cancelAnimationFrame(KS.raf); $('#acq').hidden = true; };
  window.addEventListener('resize', () => { resizeAll(); markDirty(); });
  new ResizeObserver(() => { resizeAll(); markDirty(); }).observe($('#viewer'));
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'Escape') { S.pickMode = null; S.rulerMode = false; closeMenus(); $('#about').hidden = true; setStatus(null); }
    if (e.key === 'm' || e.key === 'M') { S.rulerMode = !S.rulerMode; syncRulerBtn(); setStatus(null); }
  });
  resizeAll();
  requestAnimationFrame(loop);
  await openCase('pat03');
  initAsk();
}
boot();
