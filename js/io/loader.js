/* ============================ LOADING ============================ */
async function fetchOK(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('Could not load ' + url + ' (' + r.status + ')');
  return r;
}
async function fetchJSON(url) { return (await fetchOK(url)).json(); }
async function fetchBitmap(url) {
  const blob = await (await fetchOK(url)).blob();
  try { return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); }
  catch (e) {
    return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(blob); });
  }
}
function decodeMosaic(bmp, t) {
  const [nx, ny, nz] = t.dims, cols = t.cols;
  const W = bmp.width, H = bmp.height;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  const px = cx.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(nx * ny * nz * 3);
  for (let k = 0; k < nz; k++) {
    const r = Math.floor(k / cols), c = k % cols;
    for (let y = 0; y < ny; y++) {
      let i = ((r * ny + y) * W + c * nx) * 4, o = (nx * (y + ny * k)) * 3;
      for (let x = 0; x < nx; x++, i += 4, o += 3) { out[o] = px[i]; out[o + 1] = px[i + 1]; out[o + 2] = px[i + 2]; }
    }
  }
  cv.width = cv.height = 1;
  return out;
}
export async function loadCase(id, progress) {
  const base = 'cases/' + id + '/';
  progress(0.02, 'Reading case description');
  const meta = await fetchJSON(base + 'meta.json');
  const n = meta.textures.length + 1; let done = 0;
  const tex = await Promise.all(meta.textures.map(async (t, i) => {
    const bmp = await fetchBitmap(base + t.file);
    progress((++done) / n * 0.85, 'Decoded ' + t.channels.join(' / ') + ' (' + t.dims.join('×') + ')');
    await new Promise(r => setTimeout(r, 0));
    const data = decodeMosaic(bmp, t);
    return { dims: t.dims, spacing: t.spacing, ext: t.dims.map((d, k) => d * t.spacing[k]), data, channels: t.channels };
  }));
  let tracts = null;
  if (meta.tract_names) {
    progress(0.9, 'Loading tractography');
    tracts = {};
    // Packed form: index {bundle: [len, …]} + little-endian int16 coordinates ×10
    const [L, buf] = await Promise.all([fetchJSON(base + 'tracts.idx'), fetchOK(base + 'tracts.i16').then(r => r.arrayBuffer())]);
    const dv = new DataView(buf); let o = 0;
    for (const k in L) tracts[k] = L[k].map(n => { const f = new Float32Array(n); for (let i = 0; i < n; i++, o += 2) f[i] = dv.getInt16(o, true) / 10; return f; });
  }
  progress(1, 'Ready');
  return { meta, tex, tracts, id };
}
