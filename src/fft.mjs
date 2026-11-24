/**
 * Pure-JS Radix-2 Cooley-Tukey FFT, STFT spectrogram, and 32-dim acoustic
 * signature extractor. Zero external runtime dependencies; deterministic.
 */

export function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

/**
 * In-place iterative Radix-2 FFT. `re` and `im` must have power-of-two length.
 */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error(`FFT length must be a power of 2, got ${n}`);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextRe;
      }
    }
  }
}

/**
 * Compute magnitude spectrum for one windowed frame.
 */
export function frameSpectrum(samples, offset, fftSize, window) {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const idx = offset + i;
    re[i] = idx < samples.length ? samples[idx] * window[i] : 0;
  }
  fft(re, im);
  const bins = fftSize >> 1;
  const mag = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    mag[i] = Math.hypot(re[i], im[i]) / fftSize;
  }
  return mag;
}

/**
 * Compute log-spaced band energies (32 bins across 40Hz..6500Hz) for one spectrum.
 */
export function logBandEnergies(mag, sampleRate, numBands = 32) {
  const fftSize = mag.length * 2;
  const fMin = 40;
  const fMax = Math.min(6500, sampleRate / 2 - 1);
  const ratio = Math.pow(fMax / fMin, 1 / numBands);
  const out = new Float64Array(numBands);

  for (let b = 0; b < numBands; b++) {
    const lo = fMin * Math.pow(ratio, b);
    const hi = lo * ratio;
    const binLo = Math.max(1, Math.floor((lo * fftSize) / sampleRate));
    const binHi = Math.min(mag.length - 1, Math.max(binLo, Math.ceil((hi * fftSize) / sampleRate)));
    let sum = 0;
    let count = 0;
    for (let k = binLo; k <= binHi; k++) {
      sum += mag[k] * mag[k];
      count++;
    }
    out[b] = count > 0 ? Math.sqrt(sum / count) : 0;
  }
  return out;
}

/**
 * Compute compact STFT spectrogram for browser canvas visualization.
 * Returns { cols, rows, data } where data is cols*rows integers in [0..255].
 */
export function computeSpectrogram(samples, sampleRate, targetCols = 160, numBands = 32) {
  const fftSize = 512;
  const window = hannWindow(fftSize);
  const maxStart = Math.max(1, samples.length - fftSize);
  const cols = Math.min(targetCols, Math.max(16, Math.floor(samples.length / 256)));
  const step = maxStart / cols;
  const raw = new Float64Array(cols * numBands);
  let maxDb = -90;
  let minDb = -75;

  for (let c = 0; c < cols; c++) {
    const start = Math.floor(c * step);
    const mag = frameSpectrum(samples, start, fftSize, window);
    const bands = logBandEnergies(mag, sampleRate, numBands);
    for (let b = 0; b < numBands; b++) {
      const db = 20 * Math.log10(bands[b] + 1e-7);
      raw[c * numBands + b] = db;
      if (db > maxDb) maxDb = db;
    }
  }

  const floor = Math.max(minDb, maxDb - 58);
  const span = Math.max(12, maxDb - floor);
  const data = new Array(cols * numBands);
  for (let i = 0; i < raw.length; i++) {
    const norm = Math.max(0, Math.min(1, (raw[i] - floor) / span));
    data[i] = Math.round(norm * 255);
  }
  return { cols, rows: numBands, data };
}

/**
 * Extract a unit-normalized 32-dim acoustic embedding vector for a slice of PCM audio.
 * Combines 24 log-frequency spectral band averages + 8 temporal/tonal descriptors so
 * recurring room noises (e.g. a 142Hz radiator clank or 60Hz fridge hum) match cleanly
 * via cosine similarity in Pinecone or local fallback.
 */
export function extractAcousticSignature(samples, sampleRate) {
  const fftSize = 512;
  const hop = 256;
  const window = hannWindow(fftSize);
  const bandAvg = new Float64Array(24);
  let frames = 0;
  let centroidSum = 0;
  let fluxSum = 0;
  let prevBands = null;
  let peakAmp = 0;
  let energySq = 0;
  let zcrCount = 0;
  const rmsSeries = [];

  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    const av = Math.abs(v);
    if (av > peakAmp) peakAmp = av;
    energySq += v * v;
    if (i > 0 && ((samples[i - 1] >= 0 && v < 0) || (samples[i - 1] < 0 && v >= 0))) {
      zcrCount++;
    }
  }

  for (let pos = 0; pos + fftSize <= samples.length; pos += hop) {
    const mag = frameSpectrum(samples, pos, fftSize, window);
    const bands = logBandEnergies(mag, sampleRate, 24);
    let fRms = 0;
    for (let i = 0; i < fftSize; i++) {
      const s = samples[pos + i];
      fRms += s * s;
    }
    rmsSeries.push(Math.sqrt(fRms / fftSize));

    let wSum = 0;
    let mSum = 0;
    for (let k = 1; k < mag.length; k++) {
      const freq = (k * sampleRate) / fftSize;
      wSum += freq * mag[k];
      mSum += mag[k];
    }
    if (mSum > 1e-8) centroidSum += wSum / mSum;

    for (let b = 0; b < 24; b++) {
      bandAvg[b] += Math.log1p(bands[b] * 80);
      if (prevBands) {
        const diff = bands[b] - prevBands[b];
        if (diff > 0) fluxSum += diff;
      }
    }
    prevBands = bands;
    frames++;
  }

  const invFrames = frames > 0 ? 1 / frames : 1;
  const vec = new Array(32).fill(0);
  for (let b = 0; b < 24; b++) {
    vec[b] = bandAvg[b] * invFrames;
  }

  const rms = Math.sqrt(energySq / Math.max(1, samples.length));
  const crest = peakAmp / (rms + 1e-6);
  const zcr = zcrCount / Math.max(1, samples.length);
  const centroidHz = centroidSum * invFrames;
  const durationSec = samples.length / sampleRate;

  // Compute low/mid/high ratios
  let low = 0, mid = 0, high = 0;
  for (let b = 0; b < 8; b++) low += vec[b];
  for (let b = 8; b < 16; b++) mid += vec[b];
  for (let b = 16; b < 24; b++) high += vec[b];
  const bandTotal = low + mid + high + 1e-6;

  // Envelope modulation (distinguishes rhythmic snore cycles vs steady hum vs sharp clank)
  let rmsMean = 0;
  for (const r of rmsSeries) rmsMean += r;
  rmsMean /= Math.max(1, rmsSeries.length);
  let rmsVar = 0;
  for (const r of rmsSeries) rmsVar += (r - rmsMean) ** 2;
  const modulation = Math.sqrt(rmsVar / Math.max(1, rmsSeries.length)) / (rmsMean + 1e-6);

  vec[24] = Math.min(1, centroidHz / 3000);
  vec[25] = Math.min(1, zcr * 5);
  vec[26] = Math.min(1, crest / 12);
  vec[27] = Math.min(1, modulation * 1.5);
  vec[28] = low / bandTotal;
  vec[29] = mid / bandTotal;
  vec[30] = high / bandTotal;
  vec[31] = Math.min(1, Math.log1p(durationSec) / 3);

  // L2 normalize for cosine similarity
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const unit = vec.map((v) => Number((v / norm).toFixed(6)));

  return {
    vector: unit,
    metrics: {
      rmsDb: Number((20 * Math.log10(rms + 1e-7)).toFixed(1)),
      peakDb: Number((20 * Math.log10(peakAmp + 1e-7)).toFixed(1)),
      splPeakDb: Number(Math.max(32, Math.min(89, 78 + 20 * Math.log10(peakAmp + 1e-7))).toFixed(1)),
      splAvgDb: Number(Math.max(30, Math.min(85, 78 + 20 * Math.log10(rms + 1e-7))).toFixed(1)),
      centroidHz: Math.round(centroidHz),
      zcr: Number(zcr.toFixed(4)),
      crestFactor: Number(crest.toFixed(2)),
      modulation: Number(modulation.toFixed(3)),
      lowRatio: Number((low / bandTotal).toFixed(3)),
      midRatio: Number((mid / bandTotal).toFixed(3)),
      highRatio: Number((high / bandTotal).toFixed(3)),
      spectralFlux: Number((fluxSum * invFrames).toFixed(4)),
      durationSec: Number(durationSec.toFixed(2)),
    },
  };
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
