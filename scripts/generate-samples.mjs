/**
 * Synthesizes two realistic overnight room audio PCM WAV tapes for SnoreCenter:
 * 1. `samples/tuesday-baseline.wav` — Tuesday night recording containing the hallway
 *    radiator pipe clank (142Hz + 428Hz + 890Hz metallic harmonics), dog bark, and deep snore.
 * 2. `samples/last-night-highlight.wav` — Last night's 26-second compressed highlight tape
 *    containing five acoustically distinct events:
 *      - 01:02 AM Snore crescendo (sustained low-band rhythmic breathing rumble)
 *      - 02:14 AM Porch terrier ambush (3 sharp high-frequency impulsive barks)
 *      - 02:54 AM Hallway radiator clank (same metallic resonance with realistic night jitter -> ~0.95 cosine match)
 *      - 03:38 AM Midnight fridge raid (footstep thuds + door latch clicks + 60Hz compressor hum)
 *      - 04:36 AM Ambiguous sleep mumble (quiet mid-band vocal formant -> <70% Jev confidence -> "You call it")
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeWav } from "../src/dsp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, "..", "samples");
const SR = 16000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRoomFloor(durationSec, seed) {
  const rand = mulberry32(seed);
  const n = Math.round(durationSec * SR);
  const buf = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const white = rand() * 2 - 1;
    lp = 0.94 * lp + 0.06 * white;
    const hum = 0.0022 * Math.sin((2 * Math.PI * 60 * i) / SR);
    buf[i] = lp * 0.0055 + hum;
  }
  return buf;
}

/**
 * Low-frequency rhythmic snore rally (dominant energy 95-360Hz, strong 0.65Hz breath cycles).
 */
function addSnoreRally(buf, startSec, durationSec, amp = 0.68, seed = 11) {
  const rand = mulberry32(seed);
  const s0 = Math.floor(startSec * SR);
  const len = Math.floor(durationSec * SR);
  let breathLp = 0;
  for (let i = 0; i < len && s0 + i < buf.length; i++) {
    const t = i / SR;
    const cyclePos = (t % 1.45) / 1.45;
    const inhaleEnv = cyclePos < 0.68 ? Math.sin((cyclePos / 0.68) * Math.PI) : 0.02;
    const overallEnv = Math.min(1, t / 0.25) * Math.min(1, (durationSec - t) / 0.25);
    const rasp = 0.62 + 0.38 * Math.sin(2 * Math.PI * 26 * t);
    // Low-pass filtered breath turbulence (keeps spectral centroid firmly low)
    breathLp = 0.88 * breathLp + 0.12 * (rand() * 2 - 1);
    const fundamental =
      0.56 * Math.sin(2 * Math.PI * 108 * t) +
      0.34 * Math.sin(2 * Math.PI * 216 * t) +
      0.16 * Math.sin(2 * Math.PI * 324 * t) +
      0.14 * breathLp;
    buf[s0 + i] += amp * overallEnv * inhaleEnv * rasp * fundamental;
  }
}

/**
 * Sharp high-crest impulsive dog barks (high centroid 1100-2300Hz, staccato envelopes).
 */
function addDogBarks(buf, startSec, amp = 0.82, seed = 23, pitchShift = 1.0) {
  const rand = mulberry32(seed);
  const offsets = [0, 0.42, 0.88];
  for (let b = 0; b < offsets.length; b++) {
    const s0 = Math.floor((startSec + offsets[b]) * SR);
    const dur = 0.2;
    const len = Math.floor(dur * SR);
    for (let i = 0; i < len && s0 + i < buf.length; i++) {
      const t = i / SR;
      const env = Math.pow(Math.sin((t / dur) * Math.PI), 0.7) * Math.exp(-t * 5.2);
      const f0 = (680 - 240 * (t / dur)) * pitchShift;
      const sig =
        0.35 * Math.sin(2 * Math.PI * f0 * t) +
        0.42 * Math.sin(2 * Math.PI * f0 * 2.1 * t) +
        0.3 * Math.sin(2 * Math.PI * f0 * 3.4 * t) +
        0.22 * (rand() * 2 - 1);
      buf[s0 + i] += amp * env * sig;
    }
  }
}

/**
 * Metallic hallway radiator pipe clank (sharp resonant ring at 142Hz, 428Hz, 892Hz).
 */
function addRadiatorClank(buf, startSec, amp = 0.62, detune = 1.0) {
  const strikes = [0, 0.56];
  for (const off of strikes) {
    const s0 = Math.floor((startSec + off) * SR);
    const dur = 0.72;
    const len = Math.floor(dur * SR);
    for (let i = 0; i < len && s0 + i < buf.length; i++) {
      const t = i / SR;
      const attack = Math.min(1, t / 0.004);
      const decay = Math.exp(-t * 6.8);
      const metallic =
        0.44 * Math.sin(2 * Math.PI * 142 * detune * t) +
        0.4 * Math.sin(2 * Math.PI * 428 * detune * t) +
        0.26 * Math.sin(2 * Math.PI * 892 * detune * t) +
        0.1 * Math.sin(2 * Math.PI * 1340 * detune * t);
      buf[s0 + i] += amp * attack * decay * metallic;
    }
  }
}

/**
 * 03:38 AM midnight fridge raid: heavy footsteps + bright gasket/latch clicks + 60Hz compressor hum.
 */
function addFridgeRaid(buf, startSec, amp = 0.52, seed = 47) {
  const rand = mulberry32(seed);
  const s0 = Math.floor(startSec * SR);
  const dur = 3.0;
  const len = Math.floor(dur * SR);
  for (let i = 0; i < len && s0 + i < buf.length; i++) {
    const t = i / SR;
    let v = 0;
    // Two floorboard footsteps
    for (const stepT of [0.12, 0.52]) {
      const dt = t - stepT;
      if (dt >= 0 && dt < 0.14) {
        v += 0.5 * Math.exp(-dt * 24) * Math.sin(2 * Math.PI * 85 * dt);
      }
    }
    // Broad-spectrum gasket seal pop & glass jar rattle (high band energy!)
    for (const clickT of [0.95, 1.42, 2.35]) {
      const dt = t - clickT;
      if (dt >= 0 && dt < 0.12) {
        const clickNoise = (rand() * 2 - 1) * Math.exp(-dt * 28);
        v += 0.65 * clickNoise + 0.3 * Math.exp(-dt * 32) * Math.sin(2 * Math.PI * 2850 * dt);
      }
    }
    // Refrigerator motor hum + subtle open-door hiss while open (0.95s..2.5s)
    if (t >= 0.95 && t <= 2.6) {
      v +=
        0.24 * Math.sin(2 * Math.PI * 60 * t) +
        0.16 * Math.sin(2 * Math.PI * 120 * t) +
        0.14 * (rand() * 2 - 1);
    }
    buf[s0 + i] += amp * v;
  }
}

/**
 * Quiet, ambiguous sleep mumble / pillow vocal formant (~550-750Hz smooth syllables).
 * Intentionally moderate amplitude & blended mid-low formants so Jev splits probabilities < 0.70.
 */
function addSleepMumble(buf, startSec, amp = 0.21, seed = 91) {
  const rand = mulberry32(seed);
  const s0 = Math.floor(startSec * SR);
  const dur = 1.75;
  const len = Math.floor(dur * SR);
  let lp = 0;
  for (let i = 0; i < len && s0 + i < buf.length; i++) {
    const t = i / SR;
    const syllables =
      0.5 + 0.5 * Math.sin(2 * Math.PI * 2.9 * t) * Math.sin((t / dur) * Math.PI);
    const f1 = 290 + 45 * Math.sin(2 * Math.PI * 1.4 * t);
    const f2 = 690 + 95 * Math.cos(2 * Math.PI * 2.1 * t);
    lp = 0.75 * lp + 0.25 * (rand() * 2 - 1);
    const sig =
      0.42 * Math.sin(2 * Math.PI * f1 * t) +
      0.32 * Math.sin(2 * Math.PI * f2 * t) +
      0.26 * lp;
    buf[s0 + i] += amp * syllables * sig;
  }
}

function clampBuffer(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0.95) buf[i] = 0.95;
    else if (buf[i] < -0.95) buf[i] = -0.95;
  }
  return buf;
}

async function main() {
  await fs.mkdir(SAMPLES_DIR, { recursive: true });

  // 1. Tuesday baseline recording (14s)
  const tue = makeRoomFloor(14, 101);
  addRadiatorClank(tue, 1.5, 0.58, 1.0);
  addDogBarks(tue, 5.2, 0.78, 102, 1.0);
  addSnoreRally(tue, 8.6, 3.8, 0.62, 103);
  clampBuffer(tue);
  await fs.writeFile(path.join(SAMPLES_DIR, "tuesday-baseline.wav"), encodeWav(tue, SR));

  // 2. Last night's compressed highlight tape (26s, 5 realistic distinct events)
  const lastNight = makeRoomFloor(26, 202);
  addSnoreRally(lastNight, 1.3, 4.4, 0.76, 203); // 00:59 AM Snore Crescendo (~75 dB)
  addDogBarks(lastNight, 8.2, 0.84, 204, 1.03); // 02:10 AM Pet Ambush (~77 dB)
  addRadiatorClank(lastNight, 12.1, 0.64, 1.018); // 02:50 AM Hallway Radiator (~74 dB, ~0.95 match!)
  addFridgeRaid(lastNight, 16.4, 0.54, 205); // 03:35 AM Fridge Raid (~70 dB)
  addSleepMumble(lastNight, 22.1, 0.22, 206); // 04:34 AM Ambiguous Mumble (~61 dB, <70% -> You call it!)
  clampBuffer(lastNight);
  await fs.writeFile(path.join(SAMPLES_DIR, "last-night-highlight.wav"), encodeWav(lastNight, SR));

  console.log("Generated realistic calibrated WAV samples in", SAMPLES_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
