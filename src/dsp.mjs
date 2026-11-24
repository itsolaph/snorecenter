/**
 * Overnight audio DSP pipeline:
 * - Parses 16-bit / 24-bit / 32-bit float PCM WAV natively in Node.
 * - Falls back to `ffmpeg` / `sox` when non-WAV audio (mp3, webm, ogg, m4a) is uploaded.
 * - Slices audio into discrete acoustic events above dynamic room noise floor.
 * - Extracts per-event FFT signatures, waveform envelope, STFT spectrogram, and Box Score stats.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { computeSpectrogram, extractAcousticSignature } from "./fft.mjs";

const execFileAsync = promisify(execFile);

/**
 * Check if `ffmpeg` or `sox` binaries exist on PATH (available on Fly.io Sprites).
 */
export async function probeAudioBinaries() {
  const check = async (bin, args) => {
    try {
      const { stdout } = await execFileAsync(bin, args, { timeout: 3000 });
      return { available: true, version: stdout.split(/\r?\n/)[0].trim().slice(0, 80) };
    } catch {
      return { available: false, version: null };
    }
  };
  const [ffmpeg, sox] = await Promise.all([
    check("ffmpeg", ["-version"]),
    check("sox", ["--version"]),
  ]);
  return { ffmpeg, sox };
}

/**
 * Convert any audio buffer (webm, mp3, ogg, m4a, or odd WAV) into 16kHz mono 16-bit WAV
 * using ffmpeg when available. If already a standard PCM WAV, returns directly.
 */
export async function ensurePcmWav(buffer, filename = "upload.wav") {
  if (buffer.length >= 44 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    try {
      const parsed = parseWav(buffer);
      if (parsed.samples.length > 0) {
        return { wavBuffer: buffer, parsed, transcodedBy: "native-pcm" };
      }
    } catch {
      // Fall through to ffmpeg transcode
    }
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snorecenter-"));
  const ext = path.extname(filename).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
  const inPath = path.join(tmpDir, `in${ext}`);
  const outPath = path.join(tmpDir, "out.wav");
  try {
    await fs.writeFile(inPath, buffer);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", inPath, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-f", "wav", outPath],
      { timeout: 25000 }
    );
    const wavBuffer = await fs.readFile(outPath);
    const parsed = parseWav(wavBuffer);
    return { wavBuffer, parsed, transcodedBy: "ffmpeg" };
  } catch (err) {
    throw new Error(
      `Unsupported audio format or ffmpeg unavailable (${err.message}). Upload a PCM WAV file or run on a Sprite with ffmpeg installed.`
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pure PCM WAV parser (mono or multi-channel downmixed to mono Float32Array in [-1, 1]).
 */
export function parseWav(buf) {
  if (buf.length < 44) throw new Error("WAV buffer too short");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV header");
  }

  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16) {
      audioFormat = buf.readUInt16LE(bodyStart);
      numChannels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (chunkId === "data") {
      dataOffset = bodyStart;
      dataSize = Math.min(chunkSize, buf.length - bodyStart);
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) throw new Error("WAV data chunk missing");
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`Unsupported WAV audioFormat=${audioFormat} (expected PCM 1 or IEEE float 3)`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * numChannels;
  const frameCount = Math.floor(dataSize / frameBytes);
  const samples = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const pos = dataOffset + i * frameBytes + ch * bytesPerSample;
      let val = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        val = buf.readFloatLE(pos);
      } else if (bitsPerSample === 16) {
        val = buf.readInt16LE(pos) / 32768;
      } else if (bitsPerSample === 8) {
        val = (buf.readUInt8(pos) - 128) / 128;
      } else if (bitsPerSample === 24) {
        const b0 = buf[pos];
        const b1 = buf[pos + 1];
        const b2 = buf[pos + 2];
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        val = v / 8388608;
      } else if (bitsPerSample === 32) {
        val = buf.readInt32LE(pos) / 2147483648;
      }
      sum += val;
    }
    samples[i] = Math.max(-1, Math.min(1, sum / numChannels));
  }

  return { sampleRate, numChannels, bitsPerSample, durationSec: frameCount / sampleRate, samples };
}

/**
 * Encode mono Float32Array [-1, 1] into a 16-bit PCM WAV Buffer.
 */
export function encodeWav(samples, sampleRate = 16000) {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * Map a sample offset inside a compressed overnight recording (or live short clip)
 * to a broadcast clock label (e.g. "01:14 AM" for overnight tapes, or "00:04.2" for live clips).
 */
function formatClockStamp(startSec, durationSec, mode, recordedAtIso) {
  if (mode === "overnight") {
    // Map compressed demo overnight timeline across 00:45 -> 05:15 AM
    const startMin = 45;
    const spanMin = 270;
    const ratio = durationSec > 0 ? startSec / durationSec : 0;
    const totalMin = Math.round(startMin + ratio * spanMin);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} AM`;
  }
  const d = recordedAtIso ? new Date(recordedAtIso) : new Date();
  const base = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${base} +${startSec.toFixed(1)}s`;
}

/**
 * Full DSP analysis of an audio recording:
 * 1. Computes dynamic noise floor (20th percentile 50ms RMS energy).
 * 2. Detects active acoustic events with hysteresis + hangover merge.
 * 3. Extracts per-event 32-dim FFT acoustic vector + spectral descriptors.
 * 4. Builds waveform envelope + STFT spectrogram for browser playback & instant replay.
 * 5. Computes non-medical nightly sports Box Score stats.
 */
export function analyzeRecording(parsed, options = {}) {
  const { samples, sampleRate } = parsed;
  const durationSec = samples.length / sampleRate;
  const mode = options.mode || (durationSec >= 20 ? "overnight" : "live");
  const recordedAt = options.recordedAt || new Date().toISOString();

  // 50ms frames for envelope and event slicing
  const frameLen = Math.max(160, Math.round(sampleRate * 0.05));
  const numFrames = Math.max(1, Math.floor(samples.length / frameLen));
  const frameDb = new Float64Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameLen;
    const end = Math.min(samples.length, start + frameLen);
    let sq = 0;
    for (let i = start; i < end; i++) sq += samples[i] * samples[i];
    const rms = Math.sqrt(sq / Math.max(1, end - start));
    frameDb[f] = 20 * Math.log10(rms + 1e-7);
  }

  // Estimate room ambient noise floor using 25th percentile
  const sorted = Array.from(frameDb).sort((a, b) => a - b);
  const noiseFloorDb = sorted[Math.floor(sorted.length * 0.25)] ?? -60;
  const maxFrameDb = sorted[sorted.length - 1] ?? -20;

  // Dynamic trigger threshold above ambient floor
  const dynamicSpan = maxFrameDb - noiseFloorDb;
  const triggerDb = noiseFloorDb + Math.max(6.5, Math.min(13, dynamicSpan * 0.28));
  const releaseDb = noiseFloorDb + Math.max(3.5, Math.min(8, dynamicSpan * 0.16));

  // Hysteresis segmenter with 0.55s merge gap
  const mergeGapFrames = Math.round(0.55 / 0.05);
  const minEventFrames = Math.round(0.25 / 0.05);
  const rawSegments = [];
  let inEvent = false;
  let segStart = 0;
  let quietCount = 0;

  for (let f = 0; f < numFrames; f++) {
    if (!inEvent) {
      if (frameDb[f] >= triggerDb) {
        inEvent = true;
        segStart = Math.max(0, f - 1);
        quietCount = 0;
      }
    } else {
      if (frameDb[f] < releaseDb) {
        quietCount++;
        if (quietCount >= mergeGapFrames) {
          const segEnd = f - quietCount + 2;
          if (segEnd - segStart >= minEventFrames) {
            rawSegments.push([segStart, Math.min(numFrames, segEnd)]);
          }
          inEvent = false;
          quietCount = 0;
        }
      } else {
        quietCount = 0;
      }
    }
  }
  if (inEvent) {
    const segEnd = numFrames;
    if (segEnd - segStart >= minEventFrames) {
      rawSegments.push([segStart, segEnd]);
    }
  }

  // Guarantee at least 1 event if a very quiet live clip was recorded
  if (rawSegments.length === 0 && numFrames >= 4) {
    let bestIdx = 0;
    for (let f = 1; f < numFrames; f++) {
      if (frameDb[f] > frameDb[bestIdx]) bestIdx = f;
    }
    rawSegments.push([Math.max(0, bestIdx - 8), Math.min(numFrames, bestIdx + 12)]);
  }

  // Cap at 16 most energetic events so fanout stays fast & focused
  const rankedSegments = rawSegments
    .map(([s, e]) => {
      let peak = -120;
      for (let f = s; f < e; f++) if (frameDb[f] > peak) peak = frameDb[f];
      return { startFrame: s, endFrame: e, peak };
    })
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 16)
    .sort((a, b) => a.startFrame - b.startFrame);

  const events = rankedSegments.map((seg, idx) => {
    const startSample = seg.startFrame * frameLen;
    const endSample = Math.min(samples.length, seg.endFrame * frameLen);
    const slice = samples.subarray(startSample, endSample);
    const startSec = Number((startSample / sampleRate).toFixed(2));
    const endSec = Number((endSample / sampleRate).toFixed(2));
    const sig = extractAcousticSignature(slice, sampleRate);
    const clipSpec = computeSpectrogram(slice, sampleRate, 64, 24);

    return {
      id: `evt_${idx + 1}_${crypto.randomBytes(3).toString("hex")}`,
      index: idx + 1,
      startSec,
      endSec,
      durationSec: Number((endSec - startSec).toFixed(2)),
      clockLabel: formatClockStamp(startSec, durationSec, mode, recordedAt),
      metrics: sig.metrics,
      vector: sig.vector,
      spectrogram: clipSpec,
    };
  });

  // Compute waveform envelope (240 bars) for timeline scrubber
  const envBins = 240;
  const waveform = new Array(envBins);
  const binStep = samples.length / envBins;
  for (let i = 0; i < envBins; i++) {
    const s = Math.floor(i * binStep);
    const e = Math.min(samples.length, Math.max(s + 1, Math.floor((i + 1) * binStep)));
    let maxA = 0;
    for (let k = s; k < e; k++) {
      const a = Math.abs(samples[k]);
      if (a > maxA) maxA = a;
    }
    waveform[i] = Number(maxA.toFixed(4));
  }

  const spectrogram = computeSpectrogram(samples, sampleRate, 240, 40);

  // Compute Box Score stats (strictly non-medical entertainment metrics)
  let loudestEvent = events[0];
  let longestRally = events[0];
  let totalActiveSec = 0;
  let longestPauseSec = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    totalActiveSec += ev.durationSec;
    if (ev.metrics.splPeakDb > loudestEvent.metrics.splPeakDb) loudestEvent = ev;
    if (ev.durationSec > longestRally.durationSec) longestRally = ev;
    if (i > 0) {
      const gap = ev.startSec - events[i - 1].endSec;
      if (gap > longestPauseSec) longestPauseSec = gap;
    }
  }

  const ambientSplDb = Number(Math.max(29, Math.min(62, 78 + noiseFloorDb)).toFixed(1));

  return {
    sampleRate,
    durationSec: Number(durationSec.toFixed(2)),
    ambientSplDb,
    noiseFloorDbfs: Number(noiseFloorDb.toFixed(1)),
    eventCount: events.length,
    waveform,
    spectrogram,
    boxScore: {
      peakDb: loudestEvent ? loudestEvent.metrics.splPeakDb : ambientSplDb,
      peakClock: loudestEvent ? loudestEvent.clockLabel : "--",
      longestRallySec: longestRally ? longestRally.durationSec : 0,
      longestRallyClock: longestRally ? longestRally.clockLabel : "--",
      longestDramaticPauseSec: Number(longestPauseSec.toFixed(2)),
      totalEvents: events.length,
      totalActiveSec: Number(totalActiveSec.toFixed(2)),
    },
    events,
  };
}
