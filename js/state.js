/* ============================ STATE ============================ */
export const CASES = [
  { id: 'pat03', label: 'Meningioma', hint: 'Full head · DTI tractography' },
  { id: 'brats011', label: 'Glioblastoma', hint: 'FLAIR · T1 · T1+Gd · T2 + expert labels' }
];
export const S = {
  caseId: null, C: null,           // loaded case {meta, tex:[{dims,spacing,ext,data}], tracts}
  cross: [0, 0, 0], seq: null, wl: {},
  layout: 'quad', mainView: 'ax',
  views: {}, hotView: null,
  ov: { seg: true, tracts: true, atlas: true, cross: true },
  three: { preset: 'brain', yaw: 0, pitch: 0.5, dist: 420, target: [0, 0, 0], layers: {}, tractColor: 'dec', cut: true },
  tractOn: {}, plan: { target: null, entry: null, depth: 0, probe: false, risk: true, foot: false, riskTex: null, footTex: null, metrics: null },
  ruler: null, rulerMode: false, rano: false, hover: null,
  dirty: { v2: true, v3: true, ov: true }, lowRes: false, lastInteract: 0
};
export function markDirty(which) { if (!which || which === 'all') { S.dirty.v2 = S.dirty.v3 = S.dirty.ov = true; } else S.dirty[which] = true; }
