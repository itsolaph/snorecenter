/**
 * Physics-based overnight room audio synthesizer.
 * Produces real, playable, acoustically distinct 16kHz mono PCM WAV files so
 * SnoreCenter's DSP slicer, FFT spectrogram, TypeSafe Jev scorer, and Pinecone
 * acoustic vector memory run on genuine audio signals (zero mock JSON).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeWav } from "../src/dsp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, "..", "samples");
const SR = 16000;

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s & 0xfffffff) / 0x10000000;
  };
}

function addRoomNoise(buf, amp, rng) {
  let lp = 0;
  for (let i = 0; i < buf.length; i++) {
    const white = rng() * 2 - 1;
    lp = lp * 0.86 + white * 0.14;
    buf[i] += lp * amp;
  }
}

/**
 * Rhythmic low-frequency snore crescendo (3 respiratory cycles with soft palate flutter).
 */
function addSnoreRally(buf, startSec, cycles, peakAmp, rng) {
  const cycleDur = 1.65;
  for (let c = 0; c < cycles; c++) {
    const t0 = startSec + c * cycleDur;
    const dur = 1.15;
    const intensity = peakAmp * (0.58 + 0.42 * (c / Math.max(1, cycles - 1)));
    const startIdx = Math.floor(t0 * SR);
    const len = Math.floor(dur * SR);
    let phase1 = 0;
    let phase2 = 0;
    let breathLp = 0;
    for (let i = 0; i < len && startIdx + i < buf.length; i++) {
      const u = i / len;
      const env = Math.sin(Math.PI * u) ** 1.35;
      // Soft-palate flutter ~32Hz modulating a 115-155Hz rasp
      const flutter = 0.65 + 0.35 * Math.sin(2 * Math.PI * 31 * (i / SR));
      const f0 = 112 + 34 * Math.sin(Math.PI * u) + c * 6;
      phase1 += (2 * Math.PI * f0) / SR;
      phase2 += (2 * Math.PI * f0 * 2.02) / SR;
      const rasp = Math.sin(phase1) * 0.62 + Math.sin(phase2) * 0.28 + Math.sin(phase1 * 3) * 0.12;
      const noise = rng() * 2 - 1;
      breathLp = breathLp * 0.72 + noise * 0.28;
      buf[startIdx + i] += (rasp * 0.72 + breathLp * 0.42) * flutter * env * intensity;
    }
  }
}

/**
 * Two sharp mid-band dog barks (impulsive 480-950Hz harmonic bursts).
 */
function addDogBarks(buf, startSec, amp, rng) {
  const offsets = [0, 0.48, 0.92];
  for (let b = 0; b < offsets.length; b++) {
    const startIdx = Math.floor((startSec + offsets[b]) * SR);
    const len = Math.floor(0.24 * SR);
    let p = 0;
    for (let i = 0; i < len && startIdx + i < buf.length; i++) {
      const u = i / len;
      const env = u < 0.12 ? u / 0.12 : Math.exp(-5.2 * (u - 0.12));
      const freq = 690 - 290 * u + (b === 1 ? 65 : 0);
      p += (2 * Math.PI * freq) / SR;
      const tone = Math.sin(p) * 0.55 + Math.sin(p * 1.98) * 0.35 + Math.sin(p * 3.04) * 0.18;
      const grit = (rng() * 2 - 1) * 0.22;
      buf[startIdx + i] += (tone + grit) * env * amp;
    }
  }
}

/**
 * Metallic radiator clank (142Hz fundamental + 428Hz & 1190Hz damped metallic overtones).
 * Used in BOTH Tuesday's archive and Last Night so Pinecone matches it at high cosine similarity!
 */
function addRadiatorClank(buf, startSec, amp, rng) {
  const hits = [0, 0.62];
  for (const off of hits) {
    const startIdx = Math.floor((startSec + off) * SR);
    const len = Math.floor(0.55 * SR);
    for (let i = 0; i < len && startIdx + i < buf.length; i++) {
      const t = i / SR;
      const strike = Math.exp(-26 * t) * (rng() * 2 - 1) * 0.4;
      const ring =
        Math.sin(2 * Math.PI * 142 * t) * Math.exp(-6.5 * t) * 0.55 +
        Math.sin(2 * Math.PI * 428 * t) * Math.exp(-9.0 * t) * 0.38 +
        Math.sin(2 * Math.PI * 1190 * t) * Math.exp(-13.5 * t) * 0.24;
      buf[startIdx + i] += (strike + ring) * amp;
    }
  }
}

/**
 * 03:12 AM Fridge raid: rubber seal thump + 60Hz compressor hum + glass bottle clink + door shut.
 */
function addFridgeRaid(buf, startSec, amp, rng) {
  const startIdx = Math.floor(startSec * SR);
  const len = Math.floor(2.9 * SR);
  for (let i = 0; i < len && startIdx + i < buf.length; i++) {
    const t = i / SR;
    let sig = 0;
    // Opening suction pop at t=0.05..0.22
    if (t < 0.22) {
      sig += Math.sin(2 * Math.PI * (95 + 140 * t) * t) * Math.exp(-12 * t) * 0.55;
    }
    // Exposed 60Hz + 120Hz fridge compressor hum while door is open
    if (t > 0.15 && t < 2.55) {
      const hEnv = Math.min(1, (t - 0.15) * 4) * Math.min(1, (2.55 - t) * 4);
      sig += (Math.sin(2 * Math.PI * 60 * t) * 0.28 + Math.sin(2 * Math.PI * 120 * t) * 0.22) * hEnv;
    }
    // Glass bottle clinks at t=1.05 and t=1.62
    for (const ct of [1.05, 1.62]) {
      if (t >= ct && t < ct + 0.35) {
        const dt = t - ct;
        sig +=
          (Math.sin(2 * Math.PI * 2420 * dt) * 0.45 + Math.sin(2 * Math.PI * 3890 * dt) * 0.28) *
          Math.exp(-16 * dt);
      }
    }
    // Door shut thud at t=2.48
    if (t >= 2.48 && t < 2.75) {
      const dt = t - 2.48;
      sig += (Math.sin(2 * Math.PI * 78 * dt) * 0.72 + (rng() * 2 - 1) * 0.18) * Math.exp(-14 * dt);
    }
    buf[startIdx + i] += sig * amp;
  }
}

/**
 * Ambiguous sleep mumble / pillow rustle: soft mid-band formant bursts intentionally near
 * the classification boundary so TypeSafe Jev triggers a "You call it" human review chip.
 */
function addSleepMumble(buf, startSec, amp, rng) {
  const startIdx = Math.floor(startSec * SR);
  const len = Math.floor(1.45 * SR);
  let lp = 0;
  for (let i = 0; i < len && startIdx + i < buf.length; i++) {
    const t = i / SR;
    const syllables = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.8 * t);
    const env = Math.sin((Math.PI * i) / len) * syllables;
    const voice =
      Math.sin(2 * Math.PI * (185 + 22 * Math.sin(6 * t)) * t) * 0.38 +
      Math.sin(2 * Math.PI * 520 * t) * 0.22 +
      Math.sin(2 * Math.PI * 1340 * t) * 0.12;
    const rustle = rng() * 2 - 1;
    lp = lp * 0.65 + rustle * 0.35;
    buf[startIdx + i] += (voice * 0.6 + lp * 0.55) * env * amp;
  }
}

async function main() {
  await fs.mkdir(SAMPLES_DIR, { recursive: true });

  // 1. Tuesday Archive Baseline (14s) — seeds Pinecone & SQLite prior night memory
  const rngTue = seededRandom(20261122);
  const tue = new Float32Array(14 * SR);
  addRoomNoise(tue, 0.0045, rngTue);
  addRadiatorClank(tue, 2.2, 0.48, rngTue);
  addDogBarks(tue, 6.8, 0.52, rngTue);
  addSnoreRally(tue, 9.6, 2, 0.44, rngTue);
  await fs.writeFile(path.join(SAMPLES_DIR, "tuesday-baseline.wav"), encodeWav(tue, SR));

  // 2. Last Night Main Highlight Tape (26s) — 5 vivid events across the night
  const rngLast = seededRandom(20261124);
  const last = new Float32Array(26 * SR);
  addRoomNoise(last, 0.0042, rngLast);
  addSnoreRally(last, 1.4, 3, 0.72, rngLast);       // ~01:00 AM Championship Snore Rally
  addDogBarks(last, 8.2, 0.62, rngLast);            // ~02:10 AM Back-Alley Bark
  addRadiatorClank(last, 12.1, 0.51, rngLast);      // ~02:51 AM Recurring Tuesday Radiator Clank!
  addFridgeRaid(last, 16.4, 0.68, rngLast);         // ~03:36 AM Late-Night Fridge Raid
  addSleepMumble(last, 22.1, 0.22, rngLast);        // ~04:35 AM Ambiguous Sleep Mumble (Jev "You call it")
  await fs.writeFile(path.join(SAMPLES_DIR, "last-night-highlight.wav"), encodeWav(last, SR));

  console.log("Generated real acoustic WAV fixtures in", SAMPLES_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
