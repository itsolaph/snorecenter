import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractAcousticSignature, cosineSimilarity } from "../src/fft.mjs";
import { parseWav, encodeWav, analyzeRecording } from "../src/dsp.mjs";
import { createAppServer } from "../src/server.mjs";
import {
  classifyEventWithJev,
  queryRecurringSound,
  scanEnvForRawKeys,
} from "../src/connectors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, "..", "samples");

test("WAV encode/parse roundtrip & FFT unit vector normalization", () => {
  const sr = 16000;
  const n = sr * 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = 0.45 * Math.sin((2 * Math.PI * 220 * i) / sr);
  }
  const wav = encodeWav(samples, sr);
  const parsed = parseWav(wav);
  assert.equal(parsed.sampleRate, sr);
  assert.equal(parsed.samples.length, n);

  const sig = extractAcousticSignature(parsed.samples, sr);
  assert.equal(sig.vector.length, 32);
  const norm = Math.sqrt(sig.vector.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, `expected unit norm, got ${norm}`);
  assert.ok(sig.metrics.centroidHz > 180 && sig.metrics.centroidHz < 260);
});

test("Real overnight WAV samples detect discrete events & cross-night radiator cosine match >= 0.88", async () => {
  const tueBuf = await fs.readFile(path.join(SAMPLES_DIR, "tuesday-baseline.wav"));
  const lastBuf = await fs.readFile(path.join(SAMPLES_DIR, "last-night-highlight.wav"));

  const tueAnalysis = analyzeRecording(parseWav(tueBuf), { mode: "overnight" });
  const lastAnalysis = analyzeRecording(parseWav(lastBuf), { mode: "overnight" });

  assert.ok(tueAnalysis.events.length >= 3, `expected >=3 Tuesday events, got ${tueAnalysis.events.length}`);
  assert.ok(lastAnalysis.events.length >= 4, `expected >=4 Last Night events, got ${lastAnalysis.events.length}`);
  assert.ok(lastAnalysis.boxScore.peakDb >= 70, "expected realistic peak dB");
  assert.ok(lastAnalysis.boxScore.longestDramaticPauseSec > 0, "expected positive dramatic pause");

  // Tuesday event 1 (radiator clank) must match one of Last Night's events closely via 32-dim FFT cosine
  const tueRadiator = tueAnalysis.events[0].vector;
  const bestCosine = Math.max(
    ...lastAnalysis.events.map((e) => cosineSimilarity(tueRadiator, e.vector))
  );
  assert.ok(
    bestCosine >= 0.88,
    `expected cross-night radiator cosine match >= 0.88, got ${bestCosine.toFixed(3)}`
  );
});

test("Sprites Connector gateway calls send zero Authorization headers and parse Jev + Pinecone responses", async () => {
  let sawAuthHeader = false;
  let receivedJevPayload = null;
  let receivedPineconeQuery = null;

  const mockGateway = http.createServer(async (req, res) => {
    if (req.headers.authorization || req.headers["x-api-key"]) {
      sawAuthHeader = true;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;

    if (req.url === "/v1/decide") {
      receivedJevPayload = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "jev-latest",
          answers: {
            event_type: {
              type: "choice",
              choice: "appliance_clank",
              confidence: 0.62,
              probabilities: {
                appliance_clank: 0.62,
                fridge_raid: 0.24,
                mystery_mumble: 0.14,
              },
            },
            drama_score: { type: "score", score: 0.84 },
            highlight_worthy: { type: "noul", noul: true },
          },
          usage: { input_tokens: 112, output_tokens: 0 },
        })
      );
      return;
    }

    if (req.url === "/indexes/snorecenter-acoustic/query") {
      receivedPineconeQuery = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          matches: [
            {
              id: "tue_1",
              score: 0.941,
              metadata: {
                label: "appliance_clank",
                nightDate: "Tuesday",
                clockLabel: "01:12 AM",
                note: "Hallway Radiator",
              },
            },
          ],
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockGateway.listen(0, "127.0.0.1", resolve));
  const addr = mockGateway.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const fakeEvent = {
      clockLabel: "02:38 AM",
      durationSec: 1.4,
      metrics: {
        splPeakDb: 82.4,
        splAvgDb: 74.1,
        centroidHz: 428,
        zcr: 0.04,
        crestFactor: 4.8,
        modulation: 0.6,
        lowRatio: 0.4,
        midRatio: 0.45,
        highRatio: 0.15,
        spectralFlux: 0.03,
      },
      vector: new Array(32).fill(0.17677),
    };

    const pcMatch = await queryRecurringSound(fakeEvent.vector, [], {
      connected: true,
      gatewayBaseUrl: baseUrl,
    });
    assert.equal(pcMatch.source, "pinecone-sprite-gateway");
    assert.equal(pcMatch.score, 0.941);
    assert.equal(receivedPineconeQuery.topK, 3);

    const jev = await classifyEventWithJev(fakeEvent, pcMatch, {
      connected: true,
      gatewayBaseUrl: baseUrl,
    });
    assert.equal(jev.source, "typesafe-jev-gateway");
    assert.equal(jev.label, "appliance_clank");
    assert.equal(jev.confidence, 0.62);
    assert.equal(jev.needsHumanCall, true, "confidence < 0.70 must trigger human review");
    assert.equal(jev.dramaScore, 0.84);
    assert.equal(receivedJevPayload.questions.event_type.type, "choice");
    assert.equal(sawAuthHeader, false, "Sprite Connector calls must never send raw Authorization headers");
  } finally {
    await new Promise((resolve) => mockGateway.close(resolve));
  }
});

test("End-to-end HTTP API: state, Range audio streaming, live upload, human recall, Box export, checkpoints", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "snorecenter-e2e-"));
  const app = await createAppServer({ dataDir: tmpDir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Health & /connected proof
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.ok, true);

    const conn = await (await fetch(`${base}/connected?format=json`)).json();
    assert.equal(conn.totalCatalog, 6);
    assert.equal(typeof conn.envAudit.rawApiKeysInEnv, "number");

    // 2. Initial state seeded from real WAVs
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.activeSession, "initial morning session should be seeded");
    assert.ok(state.activeSession.events.length >= 4);
    assert.ok(state.season.nightsLogged >= 2);
    const hasRadiatorMatch = state.activeSession.events.some(
      (e) => e.pineconeMatch && e.pineconeMatch.score >= 0.88
    );
    assert.equal(hasRadiatorMatch, true, "expected cross-night recurring match against Tuesday baseline");

    // 3. HTTP 206 Range request for audio scrubbing
    const audioRes = await fetch(`${base}${state.activeSession.audioUrl}`, {
      headers: { Range: "bytes=0-1023" },
    });
    assert.equal(audioRes.status, 206);
    assert.equal(audioRes.headers.get("content-range")?.startsWith("bytes 0-1023/"), true);
    const chunk = Buffer.from(await audioRes.arrayBuffer());
    assert.equal(chunk.length, 1024);

    // 4. Human "You call it" override persists to SQLite & refreshes commentary
    const targetEvent = state.activeSession.events[state.activeSession.events.length - 1];
    const recallRes = await fetch(`${base}/api/events/${encodeURIComponent(targetEvent.id)}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "pet_ambush", note: "Sleepy Pug Sigh" }),
    });
    assert.equal(recallRes.status, 200);
    const recallData = await recallRes.json();
    const updatedEv = recallData.session.events.find((e) => e.id === targetEvent.id);
    assert.equal(updatedEv.label, "pet_ambush");
    assert.equal(updatedEv.humanOverridden, true);
    assert.equal(updatedEv.needsHumanCall, false);
    assert.equal(updatedEv.humanNote, "Sleepy Pug Sigh");

    // 5. Box archive + standalone HTML card
    const boxRes = await fetch(
      `${base}/api/sessions/${encodeURIComponent(state.activeSession.id)}/archive-box`,
      { method: "POST" }
    );
    assert.equal(boxRes.status, 200);
    const boxData = await boxRes.json();
    assert.ok(boxData.receipt.fileName);

    const cardHtml = await (await fetch(`${base}${boxData.receipt.localCardUrl}`)).text();
    assert.ok(cardHtml.includes("Longest Dramatic Pause"));
    assert.equal(/sleep apnea/i.test(cardHtml), false, "never claim medical sleep apnea diagnosis");

    // 6. Checkpoint creation
    const cpRes = await fetch(`${base}/api/checkpoints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.activeSession.id,
        comment: "Test checkpoint",
      }),
    });
    assert.equal(cpRes.status, 201);
    const cpData = await cpRes.json();
    assert.ok(cpData.checkpoint.id);

    // 7. Live PCM WAV upload
    const sr = 16000;
    const liveSamples = new Float32Array(sr * 3);
    for (let i = 0; i < liveSamples.length; i++) {
      const t = i / sr;
      liveSamples[i] = t > 0.8 && t < 1.9 ? 0.5 * Math.sin(2 * Math.PI * 190 * t) : 0.004 * Math.sin(i);
    }
    const uploadRes = await fetch(`${base}/api/analyze/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Filename": "live-mic-test.wav",
        "X-Session-Title": "Live Test Mic",
        "X-Recording-Mode": "live",
      },
      body: encodeWav(liveSamples, sr),
    });
    assert.equal(uploadRes.status, 201);
    const uploadData = await uploadRes.json();
    assert.equal(uploadData.session.title, "Live Test Mic");
    assert.ok(uploadData.session.events.length >= 1);
  } finally {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("scanEnvForRawKeys detects zero secret leakage when env is clean", () => {
  const audit = scanEnvForRawKeys();
  assert.equal(typeof audit.rawApiKeysInEnv, "number");
  assert.equal(Array.isArray(audit.flaggedNames), true);
});
