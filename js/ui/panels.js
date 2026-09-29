/* ============================ PANELS ============================ */
import { $, $$, clamp, esc, fmt, v3 } from '../util.js';
import { CASES, S, markDirty } from '../state.js';
import { atlasName, sampleNear, worldOf } from '../io/volume.js';
import { BUNDLE_COL, BUNDLE_ORDER, R, updateTex2D } from '../gl/renderer.js';
import { interactiveHint, refreshCellTitles, setCross, setStatus, trajBasis, vstate } from './views.js';
import { RISK_H, RISK_W, computeFootprint, computeRiskMap, evalPath, exitPoint } from '../analysis/planning.js';
import { runAcquisition } from '../analysis/kspace.js';
import { septumY } from './ask.js';
import { openCase } from '../main.js';

export function currentSeq() { return S.C.meta.sequences.find(s => s.id === S.seq) || S.C.meta.sequences[0]; }
export function buildTopbar() {
  const cs = $('#caseSeg'); cs.innerHTML = '';
  for (const c of CASES) {
    const b = document.createElement('button'); b.textContent = c.label; b.title = c.hint; b.setAttribute('aria-pressed', S.caseId === c.id);
    b.onclick = () => { if (S.caseId !== c.id) openCase(c.id); };
    cs.appendChild(b);
  }
  const oc = $('#ovChips'); oc.innerHTML = '';
  const ovs = [['seg', S.C.meta.fields.seg ? 'Labels' : 'Tumour', 'Segmentation outline and fill'], ['tracts', 'Tracts', 'Tract positions on slices'], ['atlas', 'Atlas', 'Highlight the atlas region under the cursor'], ['ruler', 'Measure', 'Drag on a slice to measure (M)']];
  for (const [k, nm, t] of ovs) {
    if (k === 'tracts' && !S.C.tracts) continue;
    const b = document.createElement('button'); b.className = 'chip ovchip'; b.textContent = nm; b.title = t; b.dataset.ov = k;
    b.setAttribute('aria-pressed', k === 'ruler' ? !!S.rulerMode : !!S.ov[k]);
    b.onclick = () => { if (k === 'ruler') { S.rulerMode = !S.rulerMode; if (!S.rulerMode) S.ruler = null; } else S.ov[k] = !S.ov[k]; syncOvChips(); markDirty(); setStatus(null); };
    oc.appendChild(b);
  }
  const ch = $('#seqChips'); ch.innerHTML = '';
  for (const s of S.C.meta.sequences) {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = s.name; b.title = s.params; b.setAttribute('aria-pressed', S.seq === s.id);
    b.onclick = () => { S.seq = s.id; $$('.chip', ch).forEach(x => x.setAttribute('aria-pressed', x === b)); markDirty(); setStatus(S.hover && S.hover.p); };
    ch.appendChild(b);
  }
}
export function syncOvChips() { $$('#ovChips .chip').forEach(b => b.setAttribute('aria-pressed', b.dataset.ov === 'ruler' ? !!S.rulerMode : !!S.ov[b.dataset.ov])); }
function tile(k, v, unit, n, dot) { return `<div class="tile"><div class="k">${k}</div><div class="v">${dot ? `<span class="dot" style="background:${dot}"></span>` : ''}${v}${unit ? `<small>${unit}</small>` : ''}</div>${n ? `<div class="n">${n}</div>` : ''}</div>`; }
export function buildFindings() {
  const C = S.C, m = C.meta, M = m.metrics, el = $('#tab-findings');
  let h = `<h2>${esc(m.title)}</h2><div class="sub">${esc(m.patient.label)}${m.patient.age ? ` · ${m.patient.age} ${m.patient.sex}` : ''} · ${esc(m.patient.dx)}</div>
    <div class="meta-line" style="margin-top:6px">${esc(m.scanner)}</div>`;
  if (m.id === 'brats011') {
    const V = M.vol, R = M.rano;
    h += `<h3>Tumour burden · expert segmentation</h3><div class="tiles">
      ${tile('Enhancing tumour', fmt(V.et), 'cm³', '', 'var(--et)')}${tile('Necrosis / NET', fmt(V.ncr), 'cm³', '', 'var(--ncr)')}
      ${tile('Oedema / infiltration', fmt(V.ed), 'cm³', '', 'var(--ed)')}${tile('Whole tumour', fmt(V.wt), 'cm³', `core ${fmt(V.tc)} cm³`)}
      ${tile('RANO bidimensional', `${fmt(R.ld, 1)}×${fmt(R.pd, 1)}`, 'mm', `SPD ${fmt(R.ld * R.pd / 100, 1)} cm² · axial ${R.slice + 1}`)}
      ${tile('Midline shift', M.midline_shift_mm < 1.5 ? '&lt;1' : fmt(M.midline_shift_mm), 'mm', 'septum vs falx, foramen of Monro')}</div>
      <div class="stack">${[['et', V.et], ['ncr', V.ncr], ['ed', V.ed]].map(([k, v]) => `<i style="flex:${v};background:var(--${k})" title="${v} cm³"></i>`).join('')}</div>
      <div class="legend"><span><span class="sw" style="background:var(--et)"></span>Enhancing ${Math.round(V.et / V.wt * 100)}%</span><span><span class="sw" style="background:var(--ncr)"></span>Necrotic core ${Math.round(V.ncr / V.wt * 100)}%</span><span><span class="sw" style="background:var(--ed)"></span>Oedema ${Math.round(V.ed / V.wt * 100)}%</span></div>
      <div class="links"><button class="linkbtn" data-act="rano">Show RANO measurement</button><button class="linkbtn" data-act="centre">Centre on tumour</button><button class="linkbtn" data-act="septum">Septum pellucidum</button></div>
      <h3>Location · Harvard–Oxford atlas, tumour core</h3>${locList(M.loc_tc.map(x => ({ name: x.name, pct: x.pct })))}
      <h3>Draft read</h3><div class="report">
      <p><b>Findings.</b> Intra-axial mass in the left frontal lobe, centred in subcortical white matter beneath the supplementary motor area and precentral gyrus and extending medially towards the anterior cingulate gyrus. Thick, irregular, nodular peripheral enhancement (${fmt(V.et)} cm³) surrounds a central non-enhancing necrotic core (${fmt(V.ncr)} cm³); enhancing tissue makes up ${Math.round(M.et_fraction_of_tc * 100)}% of the tumour core. Surrounding T2/FLAIR hyperintensity measures ${fmt(V.ed)} cm³ (whole-tumour extent ${fmt(V.wt)} cm³). Bidimensional product ${fmt(R.ld, 1)} × ${fmt(R.pd, 1)} mm on axial slice ${R.slice + 1}. Local mass effect with sulcal effacement and compression of the body of the left lateral ventricle; the septum pellucidum lies within 1 mm of the falcine line at the foramen of Monro.</p>
      <p><b>Impression.</b> Appearances typical of glioblastoma. A solitary metastasis is the main differential; lymphoma is less favoured given the central necrosis. Diffusion imaging is not part of this dataset, so abscess cannot be excluded on these sequences. The enhancing margin reaches the atlas-defined left SMA and precentral gyrus, so functional mapping and tractography would matter for resection planning.</p></div>
      <div class="note">Volumes, RANO product, midline and atlas location are computed live from the released expert segmentation and images. The read is a draft written by Claude from those measurements, not a clinical report. Laterality follows the NIfTI header.</div>`;
  } else {
    const T = M.tracts;
    h += `<h3>Quantitative</h3><div class="tiles">
      ${tile('Tumour volume', fmt(M.volume_cc), 'cm³', `dataset report ${m.patient.dataset_volume_cc} cm³`, 'var(--tum)')}${tile('Dimensions', M.extent_mm.join('×'), 'mm', 'LR × AP × SI')}
      ${tile('Bidimensional', `${fmt(M.rano.ld, 0)}×${fmt(M.rano.pd, 0)}`, 'mm', `axial ${M.rano.slice + 1}`)}${tile('Midline shift', fmt(M.midline_shift_mm), 'mm', 'leftward · septum vs falx')}
      ${tile('Tumour ADC', fmt(M.adc_tumour * 1000, 2), '×10⁻³ mm²/s', 'mean over mask')}${tile('R CST ↔ tumour', fmt(T.CST_R.p5_min_dist_mm), 'mm', '5th percentile, per streamline')}</div>
      <div class="links"><button class="linkbtn" data-act="rano">Show measurement</button><button class="linkbtn" data-act="centre">Centre on tumour</button><button class="linkbtn" data-act="septum">Septum pellucidum</button></div>
      <h3>Corticospinal tract FA · brainstem → cortex</h3>
      <div class="chart" id="faChart"></div>
      <details style="margin-top:6px"><summary class="lbl" style="cursor:pointer">Values</summary><div id="faTable" class="meta-line"></div></details>
      <h3>Tractography · CSD, ${Object.values(T).reduce((a, b) => a + b.n, 0).toLocaleString()} streamlines selected</h3>
      <div class="tractlist" id="tractList"></div>
      <h3>Location · Harvard–Oxford atlas, tissue abutting the tumour</h3>${locList(locFromVox(M.loc))}
      <h3>Draft read</h3><div class="report">
      <p><b>Findings.</b> Large, well-circumscribed extra-axial mass at the right parietal parasagittal convexity, ${fmt(M.volume_cc)} cm³ (${M.extent_mm.join(' × ')} mm). On non-contrast T1 it is mildly hypointense to grey matter (median signal about 83% of cortex), and it indents the right pericentral and superior parietal cortex, abutting the falx. Mean ADC ${fmt(M.adc_tumour * 1000, 2)} × 10⁻³ mm²/s. Mass effect displaces the septum pellucidum ${fmt(M.midline_shift_mm)} mm to the left at the foramen of Monro.</p>
      <p><b>Tractography.</b> With an identical peduncle-seeded protocol on both sides, the right corticospinal tract is displaced and attenuated, running anteromedial to the tumour; 5th-percentile tract–tumour distance ${fmt(T.CST_R.p5_min_dist_mm)} mm (left CST ${fmt(T.CST_L.p5_min_dist_mm)} mm from the medial margin). Mean FA along the right CST is ${fmt(M.fa_cst.R, 2)} against ${fmt(M.fa_cst.L, 2)} on the left, with the largest deficit in the mid-portion of the tract. Right-sided streamline yield was ${T.CST_R.n.toLocaleString()} against ${T.CST_L.n.toLocaleString()}.</p>
      <p><b>Impression.</b> Right parietal parasagittal meningioma (WHO grade I in the dataset) with mass effect on the pericentral cortex and anteromedial displacement of the right corticospinal tract. Corridors from the posterior-superior convexity stay clear of the displaced tract; see the Plan tab heat-map.</p></div>
      <div class="note">Tractography, DTI maps, atlas labels and every number above were computed for this patient in this build (dipy CSD tractography, ICBM152 → subject SyN registration, Harvard–Oxford atlas). The read is a draft written by Claude, not a clinical report.</div>`;
  }
  el.innerHTML = h;
  el.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'rano') { const r = M.rano; S.rano = true; S.cross = [S.cross[0], S.cross[1], r.slice + 0.5]; const c = r.ld_pts[0], d = r.ld_pts[1]; S.cross[0] = (c[0] + d[0]) / 2 + 0.5; S.cross[1] = (c[1] + d[1]) / 2 + 0.5; markDirty(); }
    if (a === 'centre') { const c = M.centroid_vox; setCross([c[0] + 0.5, c[1] + 0.5, c[2] + 0.5]); S.three.target = S.cross.slice(); markDirty(); }
    if (a === 'septum' && M.septum) { const zz = M.septum.z + 0.5; const yy = septumY(C); setCross([M.septum.x + 0.5, yy, zz]); vstate('ax').zoom = 2.2; vstate('ax').pan = [0, 0]; markDirty(); }
  };
  if (m.has_head) { buildFAChart(); buildTractList(); }
}
export function locFromVox(loc) { const tot = loc.reduce((a, b) => a + b.vox, 0); return loc.map(x => ({ name: x.name, pct: 100 * x.vox / tot })); }
function locList(items) {
  return `<div class="loc">${items.slice(0, 7).map(x => `<span>${esc(x.name.replace('Cerebral white matter', 'white matter'))}</span><span class="p">${fmt(x.pct, 0)}%</span><span class="b"><i style="width:${Math.min(100, x.pct * 1.6)}%"></i></span>`).join('')}</div>`;
}
function buildTractList() {
  const C = S.C, el = $('#tractList'); if (!el) return;
  el.innerHTML = BUNDLE_ORDER.filter(k => C.tracts[k] && C.tracts[k].length).map(k => {
    const st = C.meta.metrics.tracts[k];
    return `<label><input type="checkbox" data-b="${k}" ${S.tractOn[k] ? 'checked' : ''}><span class="sw" style="background:${BUNDLE_COL[k]}"></span><span>${esc(C.meta.tract_names[k])}</span><span class="c">${st.n.toLocaleString()}</span></label>`;
  }).join('');
  el.onchange = e => { const k = e.target.dataset.b; if (k) { S.tractOn[k] = e.target.checked; markDirty(); } };
}
function buildFAChart() {
  const P = S.C.meta.metrics.fa_profile, el = $('#faChart'); if (!P || !el) return;
  const W = 330, H = 176, m = { l: 34, r: 40, t: 22, b: 30 }, n = P.L.median.length;
  const X = i => m.l + i / (n - 1) * (W - m.l - m.r), Y = v => m.t + (1 - v / 0.8) * (H - m.t - m.b);
  const line = a => a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const band = (q1, q3) => q3.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('') + q1.slice().reverse().map((v, j) => `L${X(n - 1 - j).toFixed(1)},${Y(v).toFixed(1)}`).join('') + 'Z';
  const grid = [0, 0.2, 0.4, 0.6, 0.8].map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#222a32"/><text x="${m.l - 6}" y="${Y(v) + 3.5}" text-anchor="end" fill="#6d7a85" font-size="10" font-family="IBM Plex Mono, monospace">${v.toFixed(1)}</text>`).join('');
  const endL = P.L.median[n - 1], endR = P.R.median[n - 1];
  let yL = Y(endL), yR = Y(endR); if (Math.abs(yL - yR) < 12) { const mid = (yL + yR) / 2; if (endL >= endR) { yL = mid - 6; yR = mid + 6; } else { yL = mid + 6; yR = mid - 6; } }
  el.innerHTML = `<div class="legend" style="margin-bottom:4px"><span><span class="sw" style="background:var(--s1)"></span>Left CST (n=${P.L.n.toLocaleString()})</span><span><span class="sw" style="background:var(--s2)"></span>Right CST, tumour side (n=${P.R.n})</span><span class="dim" style="color:var(--text3)">median, band = IQR</span></div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="FA profile along the left and right corticospinal tracts">
    ${grid}
    <path d="${band(P.L.q1, P.L.q3)}" fill="#3987e5" opacity=".13"/><path d="${band(P.R.q1, P.R.q3)}" fill="#d95926" opacity=".16"/>
    <path d="${line(P.L.median)}" fill="none" stroke="#3987e5" stroke-width="2" stroke-linejoin="round"/>
    <path d="${line(P.R.median)}" fill="none" stroke="#d95926" stroke-width="2" stroke-linejoin="round"/>
    <text x="${X(n - 1) + 6}" y="${yL + 3.5}" fill="#a1adb7" font-size="10.5" font-family="IBM Plex Sans Condensed, sans-serif">Left</text>
    <text x="${X(n - 1) + 6}" y="${yR + 3.5}" fill="#a1adb7" font-size="10.5" font-family="IBM Plex Sans Condensed, sans-serif">Right</text>
    <text x="${m.l}" y="${H - 8}" fill="#6d7a85" font-size="10.5" font-family="IBM Plex Sans Condensed, sans-serif">brainstem</text>
    <text x="${W - m.r}" y="${H - 8}" fill="#6d7a85" font-size="10.5" text-anchor="end" font-family="IBM Plex Sans Condensed, sans-serif">cortex</text>
    <text x="${m.l - 26}" y="${m.t - 9}" fill="#6d7a85" font-size="10" font-family="IBM Plex Mono, monospace">FA</text>
    <line id="faX" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="#6d7a85" stroke-width="1" visibility="hidden"/>
    <circle id="faDL" r="4" fill="#3987e5" stroke="#12171c" stroke-width="2" visibility="hidden"/><circle id="faDR" r="4" fill="#d95926" stroke="#12171c" stroke-width="2" visibility="hidden"/>
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="faHit"/>
  </svg><div class="tip" id="faTip" hidden></div>`;
  const svg = el.querySelector('svg'), tip = $('#faTip'), hit = $('#faHit');
  const show = e => {
    const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) / r.width * W;
    const i = clamp(Math.round((sx - m.l) / (W - m.l - m.r) * (n - 1)), 0, n - 1), x = X(i);
    $('#faX').setAttribute('x1', x); $('#faX').setAttribute('x2', x); $('#faX').setAttribute('visibility', 'visible');
    for (const [id, s] of [['faDL', 'L'], ['faDR', 'R']]) { const c = $('#' + id); c.setAttribute('cx', x); c.setAttribute('cy', Y(P[s].median[i])); c.setAttribute('visibility', 'visible'); }
    tip.hidden = false; tip.style.left = (x / W * r.width) + 'px'; tip.style.top = (Y(Math.max(P.L.median[i], P.R.median[i])) / H * r.height) + 'px';
    tip.innerHTML = `${Math.round(i / (n - 1) * 100)}% along tract<br><span style="color:#6da7ec">Left</span> ${P.L.median[i].toFixed(2)} · <span style="color:#ec835a">Right</span> ${P.R.median[i].toFixed(2)}`;
  };
  hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; ['faX', 'faDL', 'faDR'].forEach(id => $('#' + id).setAttribute('visibility', 'hidden')); });
  $('#faTable').innerHTML = `<table style="border-collapse:collapse;width:100%"><tr><th align="left">% along</th><th align="right">Left</th><th align="right">Right</th></tr>${P.L.median.map((v, i) => i % 4 === 0 || i === n - 1 ? `<tr><td>${Math.round(i / (n - 1) * 100)}</td><td align="right">${v.toFixed(2)}</td><td align="right">${P.R.median[i].toFixed(2)}</td></tr>` : '').join('')}</table>`;
}

/* ---------- plan panel ---------- */
export function buildPlan() {
  const C = S.C, el = $('#tab-plan'), head = C.meta.has_head;
  el.innerHTML = `<h2>Trajectory planning</h2>
    <div class="sub">A straight corridor from entry to target, checked against this patient's ventricles, sulci and atlas-defined eloquent cortex${C.tracts ? ', and the corticospinal tracts from tractography' : ''}.</div>
    <h3>Target & entry</h3>
    <dl class="kv" id="planCoords"></dl>
    <div class="row" style="margin-top:10px"><button class="primary" id="autoPlan">Find safest entry</button><button class="linkbtn" id="pickEntry">Pick entry</button><button class="linkbtn" id="pickTarget">Pick target</button></div>
    <div class="meta-line" id="riskProg" style="margin-top:6px"></div>
    <h3>Display</h3>
    <div class="checks" style="gap:4px">
      <label class="opt"><input type="checkbox" id="optRisk" ${S.plan.risk ? 'checked' : ''}>Entry-risk heat map on the ${head ? 'scalp' : 'cortical surface'}</label>
      <label class="opt"><input type="checkbox" id="optFoot" ${S.plan.foot ? 'checked' : ''}>Tumour footprint along the trajectory, with a 1 cm margin</label>
      <label class="opt"><input type="checkbox" id="optProbe" ${S.plan.probe ? 'checked' : ''}>Probe's-eye and in-line views</label>
    </div>
    <div class="field"><label for="depth">Probe depth along the trajectory</label><input type="range" id="depth" min="-10" max="100" step="0.5" value="0"><div class="row" style="justify-content:space-between"><span class="meta-line" id="depthVal"></span><button class="linkbtn" id="fly">Fly along trajectory</button></div></div>
    <h3>Corridor checks</h3><div class="checks" id="planChecks"></div>
    <div class="meta-line" id="footInfo" style="margin-top:8px"></div>
    <div class="note">Vessels are not segmented because neither dataset includes angiography. Check any corridor against CTA or MRA. Motor and language areas come from atlas registration, which approximates their position under mass effect.</div>`;
  $('#autoPlan').onclick = () => autoPlan(true);
  $('#pickEntry').onclick = () => setPickMode('entry');
  $('#pickTarget').onclick = () => setPickMode('target');
  $('#optRisk').onchange = e => { S.plan.risk = e.target.checked; if (S.plan.risk && !S.plan.riskReady) autoPlan(false); markDirty('v3'); };
  $('#optFoot').onchange = e => { S.plan.foot = e.target.checked; updateFootprint(); markDirty('v3'); };
  $('#optProbe').onchange = e => { S.plan.probe = e.target.checked; refreshCellTitles(); markDirty(); };
  $('#depth').oninput = e => { S.plan.depth = +e.target.value; syncDepth(); interactiveHint(); markDirty(); };
  $('#fly').onclick = flyThrough;
  syncPlanUI();
}
function setPickMode(m) { S.pickMode = S.pickMode === m ? null : m; $('#pickEntry').setAttribute('aria-pressed', S.pickMode === 'entry'); $('#pickTarget').setAttribute('aria-pressed', S.pickMode === 'target'); setStatus(null); }
export function handlePick(p, v) {
  const C = S.C;
  if (S.pickMode === 'target') { S.plan.target = p; S.plan.targetIsDefault = false; S.plan.riskReady = false; S.pickMode = null; if (S.plan.risk) autoPlan(false); }
  else if (S.pickMode === 'entry') {
    // snap to the surface along the line from the target
    const d = v3.norm(v3.sub(p, S.plan.target)); const E = exitPoint(C, S.plan.target, d) || p;
    S.plan.entry = E; S.pickMode = null;
  }
  S.plan.depth = 0; syncPlanUI(); updateFootprint(); markDirty();
}
export async function autoPlan(setEntry) {
  const C = S.C, pl = S.plan; if (!pl.target) return;
  const tag = $('#riskProg'); if (tag) tag.textContent = 'Evaluating 3,200 candidate corridors…';
  const res = await computeRiskMap(C, pl.target, f => { if (tag) tag.textContent = `Evaluating 3,200 candidate corridors… ${Math.round(f * 100)}%`; });
  updateTex2D(R.riskTex, RISK_W, RISK_H, res.data, R.gl.REPEAT); pl.riskReady = true;
  if ((setEntry || !pl.entry) && res.best) { pl.entry = res.best.E; pl.depth = 0; }
  if (tag) tag.textContent = res.best ? `Best corridor: risk ${fmt(res.best.m.risk, 2)} · ${fmt(res.best.m.L, 0)} mm` : 'No safe corridor found';
  syncPlanUI(); updateFootprint(); markDirty();
}
export function updateFootprint() {
  const pl = S.plan; if (!pl.foot || !pl.entry || !pl.target) { pl.footReady = false; $('#footInfo') && ($('#footInfo').textContent = ''); return; }
  const f = computeFootprint(S.C, pl.target, pl.entry);
  updateTex2D(R.footTex, f.G, f.G, f.data, R.gl.CLAMP_TO_EDGE); pl.footFrame = f.frame; pl.footReady = true;
  $('#footInfo').textContent = `Footprint along the trajectory: ${fmt(f.area / 100, 1)} cm² · with a 1 cm margin the opening spans about ${fmt(f.diam / 10, 1)} cm`;
}
export function syncDepth() {
  const b = trajBasis(); if (!b) return;
  const d = $('#depth'); if (d) { d.min = -10; d.max = Math.ceil(b.len + 10); d.value = S.plan.depth; }
  const dv = $('#depthVal'); if (dv) dv.textContent = `${fmt(S.plan.depth, 1)} mm from entry · ${fmt(b.len - S.plan.depth, 1)} mm to target`;
}
function chk(state, t, d, m) { return `<div class="check"><span class="pill ${state}">${{ ok: 'PASS', warn: 'CAUTION', bad: 'FAIL', na: 'N/A' }[state]}</span><div><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ''}</div><span class="m">${m || ''}</span></div>`; }
export function syncPlanUI() {
  const C = S.C, pl = S.plan, kv = $('#planCoords'); if (!kv) return;
  const wc = p => p ? worldOf(C, p).map(x => fmt(x, 1)).join(', ') : '—';
  const tl = pl.target ? atlasName(C, sampleNear(C, C.meta.fields.atlas[0], C.meta.fields.atlas[1], pl.target)) : null;
  kv.innerHTML = `<dt>Target</dt><dd>${wc(pl.target)}${tl ? ` · ${esc(tl)}` : ''}${pl.targetIsDefault ? ' · lesion centre' : ''}</dd><dt>Entry</dt><dd>${wc(pl.entry)}</dd>`;
  syncDepth();
  const ch = $('#planChecks'); if (!pl.entry || !pl.target) { ch.innerHTML = '<div class="sub">Find or pick an entry point to evaluate the corridor.</div>'; return; }
  const m = evalPath(C, pl.entry, pl.target, false); pl.metrics = m;
  const d = v3.norm(v3.sub(pl.target, pl.entry));
  const sag = Math.atan2(-d[1], -d[2]) * 180 / Math.PI, cor = Math.atan2(-d[0], -d[2]) * 180 / Math.PI;
  let h = '';
  h += chk(m.vent ? 'bad' : 'ok', 'Ventricular system', m.vent ? 'Corridor crosses the lateral ventricle' : 'Corridor avoids the lateral ventricles', m.vent ? 'breach' : 'clear');
  h += chk(m.eloq ? (m.eloq[1] >= 0.4 ? 'bad' : 'warn') : 'ok', 'Cortical entry', m.cortexEntry ? (atlasName(C, m.entryCode) || 'Cortex') : 'No cortex traversed (extra-axial corridor)', m.eloq ? m.eloq[0] : '');
  h += chk(m.sulci === 0 ? 'ok' : (m.sulci === 1 ? 'warn' : 'bad'), 'Sulci crossed', 'Sulcal CSF along the corridor (sulcal vessels)', String(m.sulci));
  if (m.cstMin !== null) h += chk(m.cstMin >= 10 ? 'ok' : (m.cstMin >= 5 ? 'warn' : 'bad'), 'Corticospinal tract clearance', 'Minimum distance from corridor to CST streamlines', `${fmt(m.cstMin, 1)} mm`);
  else h += chk('na', 'Corticospinal tract clearance', 'No diffusion imaging in this dataset', '');
  h += chk(m.brainMM < 25 ? 'ok' : (m.brainMM < 45 ? 'warn' : 'bad'), 'Brain parenchyma traversed', 'Normal-appearing brain along the corridor', `${fmt(m.brainMM, 0)} mm`);
  h += chk(m.ang < 30 ? 'ok' : (m.ang < 50 ? 'warn' : 'bad'), 'Entry angle', `Relative to the ${C.meta.has_head ? 'skull' : 'cortical'} surface normal`, `${fmt(m.ang, 0)}°`);
  h += `<dl class="kv" style="margin-top:6px"><dt>Length</dt><dd>${fmt(m.L, 1)} mm (${fmt(m.tumourMM, 0)} mm in tumour)</dd><dt>Angles</dt><dd>sagittal ${fmt(sag, 0)}° · coronal ${fmt(cor, 0)}° from vertical</dd><dt>Risk index</dt><dd>${fmt(m.risk, 2)} (0 = lowest)</dd></dl>`;
  ch.innerHTML = h;
}
let FLY = 0;
function flyThrough() {
  const b = trajBasis(); if (!b) return;
  if (!S.plan.probe) { S.plan.probe = true; $('#optProbe').checked = true; refreshCellTitles(); }
  cancelAnimationFrame(FLY); S.plan.flying = true;
  const t0 = performance.now(), dur = 7000, a = -8, z = b.len + 4;
  const step = () => {
    const f = clamp((performance.now() - t0) / dur, 0, 1);
    S.plan.depth = a + (z - a) * (0.5 - 0.5 * Math.cos(Math.PI * f)); syncDepth(); S.lowRes = f < 1; markDirty();
    if (f < 1) FLY = requestAnimationFrame(step); else { S.plan.flying = false; S.lowRes = false; markDirty('v3'); }
  };
  step();
}

/* ---------- scan panel ---------- */
export function buildScan() {
  const el = $('#tab-scan');
  el.innerHTML = `<h2>k-space acquisition</h2>
    <div class="sub">Every MR image is reconstructed from k-space. This takes the current real axial slice, transforms it back into k-space and re-acquires it one phase-encode line at a time, so you can watch the image form and see where common artefacts come from.</div>
    <h3>Acquisition</h3>
    <div class="field"><span class="lbl">Line ordering</span><div class="seg" id="kOrder"><button aria-pressed="true" data-v="linear">Linear</button><button aria-pressed="false" data-v="centric">Centric</button></div></div>
    <div class="field"><label for="kSpeed">Duration of the animation</label><input type="range" id="kSpeed" min="2" max="12" step="1" value="5"><span class="meta-line" id="kSpeedV">5 s</span></div>
    <div class="field"><label for="kNoise">Noise</label><input type="range" id="kNoise" min="0" max="10" step="1" value="1"></div>
    <h3>Artefacts</h3>
    <div class="checks" style="gap:4px">
      <label class="opt"><input type="checkbox" id="kMotion">Patient motion half-way through: ghosting along the phase-encode axis</label>
      <label class="opt"><input type="checkbox" id="kSpike">RF spike: one corrupt k-space point gives herringbone stripes</label>
      <label class="opt"><input type="checkbox" id="kR2">Skip every other line (R = 2, no parallel reconstruction): fold-over</label>
      <label class="opt"><input type="checkbox" id="kPF">Partial Fourier 5/8, zero-filled: blurring</label>
      <label class="opt"><input type="checkbox" id="kLow">64 × 64 matrix: truncation (Gibbs) ringing</label>
    </div>
    <div class="row" style="margin-top:14px"><button class="primary" id="kGo">Acquire current axial slice</button></div>
    <div class="note">The forward transform, line-by-line sampling and inverse FFT run in your browser on the slice you are viewing, for any sequence. Corruptions are applied in k-space exactly as they occur on a scanner.</div>`;
  const ord = $('#kOrder'); ord.onclick = e => { const b = e.target.closest('button'); if (!b) return; $$('button', ord).forEach(x => x.setAttribute('aria-pressed', x === b)); };
  $('#kSpeed').oninput = e => $('#kSpeedV').textContent = e.target.value + ' s';
  $('#kGo').onclick = () => {
    const opt = { order: $('#kOrder [aria-pressed="true"]').dataset.v, speed: +$('#kSpeed').value, noise: +$('#kNoise').value, motion: $('#kMotion').checked, spike: $('#kSpike').checked, r2: $('#kR2').checked, pf: $('#kPF').checked, lowres: $('#kLow').checked };
    runAcquisition(S.C, opt);
  };
}

/* ---------- about ---------- */
export function buildAbout() {
  $('#aboutCard').innerHTML = `<button class="ghost x" id="aboutClose">Close</button><h2>About the data</h2>
  <p>Every image voxel in this workstation is real, de-identified patient MRI from open research datasets. Nothing in the images is synthesised. Surfaces, labels, tracts and measurements are computed from those images, and each place they appear says so.</p>
  <h3>Cases</h3>
  <ul><li><b>Meningioma</b>: BTC pre-operative dataset, subject PAT03 (60 F, WHO grade I, right parietal). Siemens Trio 3T: 1 mm MPRAGE and 101-direction multi-shell diffusion (b = 700/1200/2800). <a href="https://openneuro.org/datasets/ds001226" target="_blank" rel="noopener">OpenNeuro ds001226</a>, CC0. Aerts H, Marinazzo D et al., eNeuro 2018 and NeuroImage 2020.</li>
  <li><b>Glioblastoma</b>: Medical Segmentation Decathlon Task01 BrainTumour, case BRATS_011, from the BraTS 2016/2017 challenges. FLAIR, T1, T1+Gd and T2 at 1 mm, with the released expert segmentation. <a href="http://medicaldecathlon.com/" target="_blank" rel="noopener">medicaldecathlon.com</a>, CC BY-SA 4.0. Antonelli M et al., Nat Commun 2022; Menze BH et al., IEEE TMI 2015; Bakas S et al., Sci Data 2017.</li></ul>
  <h3>What was computed for this build</h3>
  <ul><li>Diffusion tensor fit (b ≤ 1200) for FA, ADC and colour maps. Constrained spherical deconvolution (b = 2800) with deterministic whole-brain tracking, plus probabilistic tracking seeded in each cerebral peduncle for the corticospinal tracts. Named bundles were selected with atlas regions. Diffusion was registered rigidly to T1 (mutual information).</li>
  <li>The ICBM152 2009a template was registered to each patient (affine, then symmetric diffeomorphic), and the Harvard–Oxford cortical and subcortical atlases were carried across for anatomical labels and motor-cortex highlighting.</li>
  <li>Cortical and scalp surfaces come from image intensities, ventricles from atlas prior plus CSF signal, and tumour surfaces from the expert or published masks. Midline shift was measured from the septum pellucidum against the falcine line fitted through the interhemispheric fissure.</li>
  <li>In the browser: WebGL2 ray-marched rendering with octant cut-away, slice reformatting, trajectory risk evaluation over 3,200 candidate corridors, and the k-space simulator with its FFTs.</li></ul>
  <h3>Limits</h3>
  <p>This is a demonstration, not a medical device and not for clinical use. Diffusion data were not corrected for EPI distortion, atlas labels are approximate under mass effect, vessels are not segmented, and the written reads are drafts generated from the measurements.</p>
  <p class="meta-line">Built end to end by Claude Opus 5.5: finding and fetching the data, registration, tractography, analysis, and this workstation.</p>`;
  $('#aboutClose').onclick = () => $('#about').hidden = true;
  $('#about').onclick = e => { if (e.target.id === 'about') $('#about').hidden = true; };
}
