/* ============================ ASK CLAUDE (sample capability) ============================ */
import { $, esc, m4, v3 } from '../util.js';
import { S, markDirty } from '../state.js';
import { atlasName, field, gridExt, inVol, sampleLin, sampleNear, worldOf } from '../io/volume.js';
import { applyPreset, setCross, setLayout } from './views.js';
import { PLAN, cstDist, evalPath, exitPoint } from '../analysis/planning.js';
import { autoPlan, buildTopbar, currentSeq, locFromVox, syncOvChips, syncPlanUI, updateFootprint } from './panels.js';

export const ASK = { sample: null, tools: false, turns: [], ctl: null, busy: false };
export async function initAsk() {
  if (!window.claude || typeof window.claude.use !== 'function') return;
  let s = null; try { s = await window.claude.use('sample'); } catch (e) { s = null; }
  if (!s) return;
  ASK.sample = s;
  try { const lim = await s.limits(); ASK.tools = !!(lim && lim.tools); } catch (e) { ASK.tools = false; }
  $('#askTab').hidden = false;
  buildAsk();
}
function gridOf(C, w) {
  const A = C.meta.grid.affine, o = C.meta.grid.origin_vox;
  const M = [A[0][0], A[1][0], A[2][0], 0, A[0][1], A[1][1], A[2][1], 0, A[0][2], A[1][2], A[2][2], 0, A[0][3], A[1][3], A[2][3], 1];
  const idx = m4.xf(m4.inv(M), w);
  return [idx[0] - o[0] + 0.5, idx[1] - o[1] + 0.5, idx[2] - o[2] + 0.5];
}
function pointReport(C, p) {
  const out = { scanner_mm: worldOf(C, p).map(x => +x.toFixed(1)) };
  const at = C.meta.fields.atlas; out.atlas = atlasName(C, sampleNear(C, at[0], at[1], p)) || 'unlabelled';
  if (C.meta.fields.seg) { const L = sampleNear(C, C.meta.fields.seg[0], C.meta.fields.seg[1], p); out.segmentation = L ? C.meta.labels.items.find(i => i.v === L).name : 'none'; }
  if (C.meta.fields.tumour) out.tumour_probability = +field(C, 'tumour', p).toFixed(2);
  out.ventricle = field(C, 'vent', p) > 0.5;
  out.signal = {};
  for (const s of C.meta.sequences) {
    if (s.ch < 0) continue;
    const v = sampleLin(C, s.tex, s.ch, p);
    out.signal[s.name] = s.unit === 'adc' ? `${(v * 3.2).toFixed(2)}e-3 mm2/s` : (s.unit === 'fa' ? +v.toFixed(2) : Math.round(v * 255));
  }
  if (PLAN.cst) out.distance_to_CST_mm = +cstDist(p).toFixed(1);
  return out;
}
function caseContext() {
  const C = S.C, m = C.meta, M = m.metrics, pl = S.plan;
  const ctx = {
    case: m.title, dataset: m.patient.label, patient: m.patient.age ? `${m.patient.age} ${m.patient.sex}` : 'not provided', diagnosis_in_dataset: m.patient.dx,
    scanner: m.scanner, source: m.source.name + ' (' + m.source.license + ')',
    sequences: m.sequences.map(s => `${s.name} [${s.params}]`),
    coordinates: m.has_head ? 'scanner RAS, mm (x+ = patient right, y+ = anterior, z+ = superior)' : 'volume mm in SRI24-registered grid (x+ right, y+ anterior, z+ superior)',
    metrics: {}
  };
  if (m.id === 'brats011') Object.assign(ctx.metrics, { volumes_cm3: M.vol, rano_mm: [+M.rano.ld.toFixed(1), +M.rano.pd.toFixed(1)], rano_axial_slice: M.rano.slice + 1, extent_mm: M.extent_mm, enhancing_fraction_of_core: M.et_fraction_of_tc, midline_shift_mm: M.midline_shift_mm, atlas_composition_tumour_core: M.loc_tc.map(x => `${x.name} ${x.pct}%`), atlas_composition_whole_tumour: M.loc_wt.map(x => `${x.name} ${x.pct}%`), note: 'No DWI/DTI or angiography in this dataset. Segmentation labels are expert BraTS annotations.' });
  else Object.assign(ctx.metrics, { tumour_volume_cm3: M.volume_cc, dataset_reported_volume_cm3: m.patient.dataset_volume_cc, extent_mm_LR_AP_SI: M.extent_mm, bidimensional_mm: [+M.rano.ld.toFixed(1), +M.rano.pd.toFixed(1)], midline_shift_mm: M.midline_shift_mm + ' leftward', tumour_mean_ADC: (M.adc_tumour * 1000).toFixed(2) + 'e-3 mm2/s', T1_signal: 'tumour core median ~83% of cortical grey matter (mildly hypointense)', CST_mean_FA: M.fa_cst, tracts: Object.fromEntries(Object.entries(M.tracts).map(([k, v]) => [m.tract_names[k], { streamlines: v.n, p5_min_distance_to_tumour_mm: v.p5_min_dist_mm !== undefined ? +v.p5_min_dist_mm.toFixed(1) : undefined }])), atlas_regions_abutting_tumour: locFromVox(M.loc).map(x => `${x.name} ${x.pct.toFixed(0)}%`), CST_FA_profile_brainstem_to_cortex: { left: M.fa_profile.L.median.filter((_, i) => i % 4 === 0), right: M.fa_profile.R.median.filter((_, i) => i % 4 === 0) }, note: 'No contrast, FLAIR or angiography in this dataset. Tractography: CSD, probabilistic peduncle-seeded CST; EPI distortion not corrected.' });
  ctx.current_view = { sequence: currentSeq().name, crosshair: pointReport(C, S.cross), preset_3d: S.three.preset };
  if (pl.entry && pl.target) {
    const e = pl.metrics || evalPath(C, pl.entry, pl.target, false);
    ctx.current_plan = { target: worldOf(C, pl.target).map(x => +x.toFixed(1)), entry: worldOf(C, pl.entry).map(x => +x.toFixed(1)), length_mm: +e.L.toFixed(1), ventricle_breach: e.vent > 0, sulci_crossed: e.sulci, cortical_entry: e.cortexEntry ? atlasName(C, e.entryCode) : 'none (extra-axial corridor)', eloquent_entry: e.eloq ? e.eloq[0] : 'no', brain_traversed_mm: Math.round(e.brainMM), CST_clearance_mm: e.cstMin === null ? 'n/a' : +e.cstMin.toFixed(1), entry_angle_deg: Math.round(e.ang), risk_index: +e.risk.toFixed(2) };
  }
  return JSON.stringify(ctx);
}
const ASK_RULES = `You are the analysis assistant inside Gyrus, a browser neuro-imaging workstation showing REAL de-identified patient MRI from open research datasets. The person asking is likely a neurosurgeon. Answer as a precise, collegial neuroradiology / neurosurgical-planning colleague.
Rules:
- Ground every statement in the CASE DATA provided (measurements computed in the app from the images, expert segmentations, atlas registration, tractography). Distinguish measured facts from interpretation. If something is not in the data (e.g. no DWI, no angiography), say so plainly.
- This is a demonstration, not clinical care: do not give patient-specific treatment instructions as if for a real decision; frame surgical points as considerations.
- Be concise: short paragraphs or tight bullet points, British spelling, SI units. No headings bigger than bold text.
- When tools are available, use them to show the person what you mean (navigate to a structure, switch sequence or 3D preset, evaluate a corridor) and then say what you showed.`;
function askTools() {
  const C = S.C;
  return [
    { name: 'navigate', description: 'Move the crosshair (all 2D views and the 3D cut-away follow). Give either place (tumour_centre, rano_measurement, septum_pellucidum, plan_target, plan_entry) or x,y,z in the case coordinate system (mm). Returns what is at the new crosshair.',
      inputSchema: { type: 'object', properties: { place: { type: 'string', enum: ['tumour_centre', 'rano_measurement', 'septum_pellucidum', 'plan_target', 'plan_entry'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      execute(inp) {
        const M = C.meta.metrics; let p = null;
        const pl = String(inp.place || '');
        if (pl === 'tumour_centre') p = M.centroid_vox.map(v => v + 0.5);
        else if (pl === 'rano_measurement') { const r = M.rano; S.rano = true; p = [(r.ld_pts[0][0] + r.ld_pts[1][0]) / 2 + 0.5, (r.ld_pts[0][1] + r.ld_pts[1][1]) / 2 + 0.5, r.slice + 0.5]; }
        else if (pl === 'septum_pellucidum' && M.septum) p = [M.septum.x + 0.5, septumY(C), M.septum.z + 0.5];
        else if (pl === 'plan_target' && S.plan.target) p = S.plan.target.slice();
        else if (pl === 'plan_entry' && S.plan.entry) p = S.plan.entry.slice();
        else if (isFinite(+inp.x) && isFinite(+inp.y) && isFinite(+inp.z)) p = gridOf(C, [+inp.x, +inp.y, +inp.z]);
        if (!p) throw new Error('No such place in this case');
        if (!inVol(C, p)) throw new Error('Point is outside the imaged volume');
        setCross(p); S.three.target = v3.lerp(S.three.target, p, 0.5); markDirty();
        return pointReport(C, p);
      } },
    { name: 'set_display', description: 'Change what is displayed: sequence (one of ' + C.meta.sequences.map(s => s.id).join(', ') + '), 3D preset (' + (C.meta.has_head ? 'head, ' : '') + 'brain, glass, mip), layout (quad or focus_3d), tracts on/off. Returns the new state.',
      inputSchema: { type: 'object', properties: { sequence: { type: 'string' }, preset: { type: 'string' }, layout: { type: 'string', enum: ['quad', 'focus_3d'] }, tracts: { type: 'boolean' } } },
      execute(inp) {
        if (inp.sequence) { const s = C.meta.sequences.find(q => q.id.toLowerCase() === String(inp.sequence).toLowerCase() || q.name.toLowerCase() === String(inp.sequence).toLowerCase()); if (!s) throw new Error('Unknown sequence'); S.seq = s.id; buildTopbar(); }
        if (inp.preset) { const p = String(inp.preset).toLowerCase(); if (!['head', 'brain', 'glass', 'mip'].includes(p) || (p === 'head' && !C.meta.has_head)) throw new Error('Unknown preset'); applyPreset(p); }
        if (inp.layout) setLayout(inp.layout === 'focus_3d' ? 'focus' : 'quad', '3d');
        if (typeof inp.tracts === 'boolean') { S.three.layers.tracts = inp.tracts; S.ov.tracts = inp.tracts; syncOvChips(); }
        markDirty();
        return { sequence: currentSeq().name, preset: S.three.preset, layout: S.layout };
      } },
    { name: 'plan_corridor', description: 'Trajectory planning. mode "safest" searches 3,200 candidate entry points and picks the lowest-risk corridor to the current target; or give entry x,y,z (mm) to evaluate a specific entry. Returns the corridor checks.',
      inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['safest', 'entry'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      async execute(inp) {
        if (inp.mode === 'entry' && isFinite(+inp.x)) { const p = gridOf(C, [+inp.x, +inp.y, +inp.z]); const d = v3.norm(v3.sub(p, S.plan.target)); S.plan.entry = exitPoint(C, S.plan.target, d) || p; S.plan.depth = 0; syncPlanUI(); updateFootprint(); markDirty(); }
        else await autoPlan(true);
        const e = evalPath(C, S.plan.entry, S.plan.target, false);
        return { entry: worldOf(C, S.plan.entry).map(x => +x.toFixed(1)), target: worldOf(C, S.plan.target).map(x => +x.toFixed(1)), length_mm: +e.L.toFixed(1), ventricle_breach: e.vent > 0, sulci_crossed: e.sulci, cortical_entry: e.cortexEntry ? atlasName(C, e.entryCode) : 'none', eloquent_entry: e.eloq ? e.eloq[0] : 'no', brain_traversed_mm: Math.round(e.brainMM), CST_clearance_mm: e.cstMin === null ? 'n/a' : +e.cstMin.toFixed(1), risk_index: +e.risk.toFixed(2) };
      } },
    { name: 'probe_point', description: 'Read the image values, segmentation, atlas label and CST distance at x,y,z (mm) without moving the view.',
      inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
      execute(inp) { const p = gridOf(C, [+inp.x, +inp.y, +inp.z]); if (!inVol(C, p)) throw new Error('Point is outside the imaged volume'); return pointReport(C, p); } }
  ];
}
export function septumY(C) {
  const M = C.meta.metrics, z = M.septum.z + 0.5, x = M.septum.x + 0.5, e = gridExt(C);
  let best = null;
  for (let y = e[1] - 1; y > 1; y -= 1) { if (field(C, 'vent', [x - 4, y, z]) > 0.5 || field(C, 'vent', [x + 4, y, z]) > 0.5) { best = y; break; } }
  return best !== null ? best - 8 : S.cross[1];
}
function mdLite(s) {
  const lines = esc(s).split('\n'); let html = '', inList = false;
  for (let ln of lines) {
    ln = ln.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const li = ln.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (ln.replace(/^#+\s*/, '').trim()) html += `<p>${ln.replace(/^#+\s*(.*)$/, '<b>$1</b>')}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}
export function buildAsk() {
  const el = $('#tab-ask');
  const sugg = S.C.meta.has_head
    ? ['Summarise this case for a neuro-oncology MDT', 'Which approach keeps clear of the corticospinal tract? Show me.', 'What does the FA profile tell us about the right CST?', 'Show the tumour relative to the motor cortex in 3D']
    : ['Summarise this case for a neuro-oncology MDT', 'How eloquent is this location? Show me the relevant anatomy.', 'Find the safest biopsy corridor and explain it', 'Show me the vascular anatomy around the tumour'];
  el.innerHTML = `<h2>Ask Claude</h2><div class="sub">Questions about this case go to Claude with the measurements and your current view. ${ASK.tools ? 'Claude can move the views, switch sequences and run the corridor search to show you what it means.' : ''}</div>
    <div class="links" id="askSugg">${sugg.map(q => `<button class="linkbtn" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <div id="askLog" class="report" style="margin-top:14px"></div>
    <div class="field"><label for="askIn" class="lbl">Your question</label><textarea id="askIn" rows="3" style="width:100%;resize:vertical;background:var(--panel2);border:1px solid var(--line2);border-radius:5px;padding:8px;color:var(--text);font:inherit" placeholder="e.g. Would a posterior parietal approach put the leg area at risk?"></textarea></div>
    <div class="row"><button class="primary" id="askGo">Ask</button><button class="linkbtn" id="askStop" hidden>Stop</button><button class="linkbtn" id="askClear">New conversation</button></div>
    <div class="note">Uses your Claude account; the first question asks your permission. Answers are drafts for discussion, not clinical advice.</div>`;
  $('#askSugg').onclick = e => { const b = e.target.closest('[data-q]'); if (b) { $('#askIn').value = b.dataset.q; askSend(); } };
  $('#askGo').onclick = askSend;
  $('#askIn').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) askSend(); };
  $('#askStop').onclick = () => ASK.ctl && ASK.ctl.abort();
  $('#askClear').onclick = () => { ASK.turns = []; $('#askLog').innerHTML = ''; };
  renderAskLog();
}
function renderAskLog(live) {
  const log = $('#askLog'); if (!log) return;
  log.innerHTML = ASK.turns.map(t => t.role === 'user'
    ? `<div style="margin:12px 0 6px;color:var(--text2);font-size:12.5px;border-left:2px solid var(--accent);padding-left:8px">${esc(t.shown || t.content)}</div>`
    : `<div>${mdLite(t.content)}</div>`).join('') + (live !== undefined ? `<div id="askLive">${live ? mdLite(live) : '<p class="meta-line">Thinking…</p>'}</div>` : '');
}
async function askSend() {
  if (!ASK.sample || ASK.busy) return;
  const q = $('#askIn').value.trim(); if (!q) return;
  $('#askIn').value = '';
  ASK.busy = true; $('#askGo').disabled = true; $('#askStop').hidden = false;
  const ctx = caseContext();
  const turns = [{ role: 'user', content: ASK_RULES }].concat(ASK.turns.slice(-8).map(t => ({ role: t.role, content: t.content })));
  const content = `CASE DATA (JSON): ${ctx}\n\nQUESTION: ${q}`;
  turns.push({ role: 'user', content });
  ASK.turns.push({ role: 'user', content: `QUESTION: ${q}`, shown: q });
  renderAskLog('');
  ASK.ctl = new AbortController();
  const opts = { signal: ASK.ctl.signal, onText: ({ text }) => { const l = $('#askLive'); if (l) l.innerHTML = mdLite(text); } };
  if (ASK.tools) opts.tools = askTools(); else opts.cache = false;
  try {
    const r = await ASK.sample(turns, opts);
    ASK.turns.push({ role: 'assistant', content: r.text + (r.truncated ? '\n\n(Answer cut short.)' : '') });
    renderAskLog();
  } catch (e) {
    const keep = e && e.text ? e.text : '';
    if (keep) ASK.turns.push({ role: 'assistant', content: keep + '\n\n(Interrupted.)' });
    renderAskLog();
    const msg = { not_granted: 'Claude access was not allowed for this page.', sampling_disabled: 'Claude is not available for this account.', rate_limited: 'Too many questions at once. Try again in a moment.', session_expired: 'Please sign in to Claude again.', refused: 'Claude declined that question. Try rephrasing it.', prompt_too_large: 'The conversation got too long. Start a new conversation.', cancelled: '' }[e && e.code];
    const m = msg === undefined ? 'Something went wrong reaching Claude. Try again.' : msg;
    if (m) $('#askLog').insertAdjacentHTML('beforeend', `<div class="note">${esc(m)}</div>`);
    if (e && ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(e.code)) { $('#askGo').disabled = true; ASK.busy = true; $('#askStop').hidden = true; return; }
  }
  ASK.busy = false; $('#askGo').disabled = false; $('#askStop').hidden = true;
}
