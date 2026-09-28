/* ============================ K-SPACE SIMULATION ============================ */
import { $, clamp } from '../util.js';
import { S } from '../state.js';
import { gridExt, inVol, sampleLin } from '../io/volume.js';
import { currentSeq } from '../ui/panels.js';

function fft1(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function fft2(re, im, N, inv) {
  const r = new Float64Array(N), i_ = new Float64Array(N);
  for (let y = 0; y < N; y++) { for (let x = 0; x < N; x++) { r[x] = re[y * N + x]; i_[x] = im[y * N + x]; } fft1(r, i_, inv); for (let x = 0; x < N; x++) { re[y * N + x] = r[x]; im[y * N + x] = i_[x]; } }
  for (let x = 0; x < N; x++) { for (let y = 0; y < N; y++) { r[y] = re[y * N + x]; i_[y] = im[y * N + x]; } fft1(r, i_, inv); for (let y = 0; y < N; y++) { re[y * N + x] = r[y]; im[y * N + x] = i_[y]; } }
}
function fftshiftIdx(k, N) { return (k + N / 2) % N; }
export const KS = { N: 256, running: false, raf: 0 };
function sliceImage(C) {
  // current axial slice -> 256x256 (1 mm pixels, centred), in radiological display orientation
  const N = KS.N, e = gridExt(C), sq = currentSeq();
  const img = new Float64Array(N * N);
  const cx = e[0] / 2, cy = e[1] / 2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = cx + (N / 2 - i - 0.5) * 1.0, y = cy + (N / 2 - j - 0.5) * 1.0;   // screen right = patient left, top = anterior
    const p = [x, y, S.cross[2]];
    if (!inVol(C, p)) continue;
    img[j * N + i] = sq.ch < 0 ? sampleLin(C, 2, 2, p) : sampleLin(C, sq.tex, sq.ch, p);
  }
  return img;
}
function prepareAcquisition(C, opt) {
  const N = KS.N, img = sliceImage(C);
  const re = new Float64Array(img), im = new Float64Array(N * N);
  // gentle smooth phase (B0 / coil) so k-space is not perfectly Hermitian
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const ph = 0.9 * ((i - N / 2) / N) + 0.6 * ((j - N / 2) / N) ** 2; const v = re[j * N + i]; re[j * N + i] = v * Math.cos(ph); im[j * N + i] = v * Math.sin(ph); }
  fft2(re, im, N, false);
  // shift so centre of k-space is at N/2
  const Kr = new Float64Array(N * N), Ki = new Float64Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const s = fftshiftIdx(j, N) * N + fftshiftIdx(i, N); Kr[s] = re[j * N + i]; Ki[s] = im[j * N + i]; }
  let maxK = 0; for (let i = 0; i < N * N; i++) maxK = Math.max(maxK, Math.hypot(Kr[i], Ki[i]));
  let refMax = 0; for (let i = 0; i < N * N; i++) refMax = Math.max(refMax, img[i]);
  // order of phase-encode lines (ky rows)
  let order = [];
  if (opt.order === 'centric') { order.push(N / 2); for (let k = 1; k < N / 2; k++) { order.push(N / 2 + k); order.push(N / 2 - k); } order.push(0); }
  else for (let k = 0; k < N; k++) order.push(k);
  if (opt.pf) order = order.filter(k => k >= Math.round(N * 3 / 8));
  if (opt.r2) order = order.filter(k => k % 2 === 0);
  if (opt.lowres) order = order.filter(k => Math.abs(k - N / 2) < 32);
  // corruptions
  const rng = mulberry(7);
  const noiseSd = opt.noise * maxK * 0.0022;
  for (let idx = 0; idx < order.length; idx++) {
    const ky = order[idx];
    for (let kx = 0; kx < N; kx++) {
      const s = ky * N + kx;
      if (opt.lowres && Math.abs(kx - N / 2) >= 32) { Kr[s] = 0; Ki[s] = 0; continue; }
      if (opt.motion && idx > order.length * 0.45) {
        const dy = 5 + (rng() - 0.5) * 3, dx = (rng() - 0.5) * 1.5;
        const ph = -2 * Math.PI * ((ky - N / 2) * dy + (kx - N / 2) * dx) / N;
        const c = Math.cos(ph), sn = Math.sin(ph), r = Kr[s], ii = Ki[s];
        Kr[s] = r * c - ii * sn; Ki[s] = r * sn + ii * c;
      }
      if (noiseSd > 0) { Kr[s] += gauss(rng) * noiseSd; Ki[s] += gauss(rng) * noiseSd; }
    }
  }
  if (opt.spike) { const s = (N / 2 + 37) * N + (N / 2 - 58); Kr[s] += maxK * 0.35; Ki[s] += maxK * 0.1; if (!order.includes(N / 2 + 37)) order.push(N / 2 + 37); }
  return { Kr, Ki, order, maxK, refMax, img };
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gauss(r) { const u = Math.max(r(), 1e-9), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function reconstruct(A, mask) {
  const N = KS.N, re = new Float64Array(N * N), im = new Float64Array(N * N);
  for (let j = 0; j < N; j++) if (mask[j]) for (let i = 0; i < N; i++) { const s = j * N + i, d = fftshiftIdx(j, N) * N + fftshiftIdx(i, N); re[d] = A.Kr[s]; im[d] = A.Ki[s]; }
  fft2(re, im, N, true);
  const out = new Float64Array(N * N); for (let i = 0; i < N * N; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}
function paintGray(cv, arr, scale, gamma) {
  const N = KS.N, g = cv.getContext('2d'), id = g.createImageData(N, N);
  for (let i = 0; i < N * N; i++) { let v = arr[i] * scale; if (gamma) v = Math.pow(clamp(v, 0, 1), gamma); v = clamp(v, 0, 1) * 255; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  g.putImageData(id, 0, 0);
}
function paintK(cv, A, mask, cur) {
  const N = KS.N, g = cv.getContext('2d'), id = g.createImageData(N, N), lm = Math.log(1 + A.maxK);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const s = j * N + i, o = s * 4;
    if (!mask[j]) { id.data[o] = 10; id.data[o + 1] = 14; id.data[o + 2] = 18; id.data[o + 3] = 255; continue; }
    const v = Math.log(1 + Math.hypot(A.Kr[s], A.Ki[s])) / lm; const c = Math.pow(v, 1.4) * 255;
    id.data[o] = c * 0.62; id.data[o + 1] = c * 0.86; id.data[o + 2] = c; id.data[o + 3] = 255;
    if (j === cur) { id.data[o] = 255; id.data[o + 1] = 200; id.data[o + 2] = 90; }
  }
  g.putImageData(id, 0, 0);
}
function drawPSD(t, lineFrac, opt) {
  const cv = $('#psd'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const rows = ['RF', 'Gss', 'Gpe', 'Gro', 'ADC'], rh = H / rows.length;
  g.font = '11px "IBM Plex Mono", monospace'; g.textBaseline = 'middle';
  rows.forEach((r, i) => { g.fillStyle = '#6d7a85'; g.fillText(r, 8, rh * (i + 0.5)); g.strokeStyle = '#1d252c'; g.beginPath(); g.moveTo(44, rh * (i + 0.5)); g.lineTo(W - 8, rh * (i + 0.5)); g.stroke(); });
  const x0 = 50, x1 = W - 12, span = x1 - x0;
  const X = f => x0 + f * span;
  g.lineWidth = 1.5;
  // RF: excitation + refocusing sinc lobes
  const sinc = (cx, amp, w, col) => { g.strokeStyle = col; g.beginPath(); for (let k = -1; k <= 1; k += 0.02) { const x = cx + k * w, u = k * 3 * Math.PI, y = u === 0 ? 1 : Math.sin(u) / u; g.lineTo(x, rh * 0.5 - y * amp); } g.stroke(); };
  sinc(X(0.08), rh * 0.4, 18, '#dce3e8'); sinc(X(0.36), rh * 0.4, 18, '#dce3e8');
  const trap = (row, a, b, amp, col) => { const y = rh * (row + 0.5); g.strokeStyle = col; g.beginPath(); g.moveTo(X(a) - 4, y); g.lineTo(X(a), y - amp); g.lineTo(X(b), y - amp); g.lineTo(X(b) + 4, y); g.stroke(); };
  trap(1, 0.055, 0.105, rh * 0.3, '#9aa6b0'); trap(1, 0.335, 0.385, rh * 0.3, '#9aa6b0'); trap(1, 0.11, 0.15, -rh * 0.18, '#9aa6b0');
  // phase encode table
  for (let k = -4; k <= 4; k++) { const y = rh * 2.5 - k * rh * 0.08; g.strokeStyle = '#2e3842'; g.beginPath(); g.moveTo(X(0.18), y); g.lineTo(X(0.26), y); g.stroke(); }
  const cy = rh * 2.5 - (lineFrac - 0.5) * 2 * 4 * rh * 0.08; g.strokeStyle = '#ffc85a'; g.lineWidth = 2; g.beginPath(); g.moveTo(X(0.17), rh * 2.5); g.lineTo(X(0.18), cy); g.lineTo(X(0.26), cy); g.lineTo(X(0.27), rh * 2.5); g.stroke(); g.lineWidth = 1.5;
  trap(3, 0.18, 0.26, -rh * 0.22, '#9aa6b0'); trap(3, 0.52, 0.8, rh * 0.22, '#7fc4e6');
  g.fillStyle = 'rgba(127,196,230,.25)'; g.fillRect(X(0.53), rh * 4.2, X(0.79) - X(0.53), rh * 0.6);
  // echo
  g.strokeStyle = '#7fc4e6'; g.beginPath(); for (let k = 0; k <= 1; k += 0.01) { const x = X(0.53 + 0.26 * k), u = (k - 0.5) * 16; g.lineTo(x, rh * 4.5 - Math.cos(u * 1.3) * Math.exp(-u * u / 30) * rh * 0.35); } g.stroke();
  // playhead
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.moveTo(X(t), 2); g.lineTo(X(t), H - 2); g.stroke();
  g.fillStyle = '#6d7a85'; g.textAlign = 'right'; g.fillText('TE', X(0.66), 10); g.textAlign = 'left';
}
export function runAcquisition(C, opt) {
  cancelAnimationFrame(KS.raf);
  const A = prepareAcquisition(C, opt), N = KS.N;
  const mask = new Uint8Array(N); let idx = 0;
  const total = A.order.length, sq = currentSeq();
  const perFrame = Math.max(1, Math.round(total / (opt.speed * 60)));
  $('#acq').hidden = false;
  $('#acqTitle').textContent = `Acquiring axial slice · ${sq.name}`;
  $('#acqInfo').textContent = `${total} phase-encode lines · ${opt.order} ordering${opt.r2 ? ' · R=2 (no PI recon)' : ''}${opt.pf ? ' · partial Fourier 5/8' : ''}${opt.lowres ? ' · 64×64 matrix' : ''}${opt.motion ? ' · patient motion' : ''}${opt.spike ? ' · RF spike' : ''}`;
  const kc = $('#kcan'), rc = $('#rcan'); const sc = 1 / (A.refMax || 1);
  const t0 = performance.now();
  KS.running = true;
  const step = () => {
    let cur = -1;
    for (let k = 0; k < perFrame && idx < total; k++, idx++) { cur = A.order[idx]; mask[cur] = 1; }
    paintK(kc, A, mask, cur);
    const rec = reconstruct(A, mask); paintGray(rc, rec, sc * (opt.r2 ? 1.6 : 1));
    $('#acqLine').textContent = `line ${idx} / ${total}`;
    $('#acqTime').textContent = `${Math.round(idx / total * 100)}% of k-space`;
    drawPSD(((performance.now() - t0) / 900) % 1, cur / N, opt);
    if (idx < total) KS.raf = requestAnimationFrame(step); else { KS.running = false; drawPSD(0.66, 0.5, opt); }
  };
  step();
  $('#acqReplay').onclick = () => runAcquisition(C, opt);
}
