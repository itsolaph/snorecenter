/**
 * End-to-end SnoreCenter broadcast pipeline:
 * Audio buffer -> DSP event slicing & 32-dim FFT -> Pinecone recurring match ->
 * TypeSafe AI Jev calibrated classification -> Ollama 2-anchor play-by-play ->
 * ElevenLabs highlight voice (when connected) -> SQLite ledger & Box export.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensurePcmWav, analyzeRecording } from "./dsp.mjs";
import {
  EVENT_LABELS,
  discoverConnectors,
  classifyEventWithJev,
  queryRecurringSound,
  upsertSoundToPinecone,
  generateCommentaryWithOllama,
  synthesizeHighlightAudio,
  archiveBreakfastToBox,
} from "./connectors.mjs";
import {
  saveSession,
  listSessions,
  getSession,
  getEventById,
  updateEventOverride,
  updateSessionCommentary,
  updateSessionBoxArchive,
  upsertMemorySignature,
  listMemorySignatures,
} from "./db.mjs";

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeSessionId(prefix = "night") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

export async function processAudioTape(db, wavBuffer, options = {}) {
  const {
    title = "Overnight Tape",
    nightDate = new Date().toISOString().slice(0, 10),
    mode,
    source = "upload",
    filename = "recording.wav",
    audioDir,
    seedLabels = null,
    skipVoice = false,
  } = options;

  const { wavBuffer: pcmWav, parsed, transcodedBy } = await ensurePcmWav(wavBuffer, filename);
  const analysis = analyzeRecording(parsed, { mode });

  const sessionId = makeSessionId(source === "tuesday-baseline" ? "tue" : "sc");
  const audioFilename = `${sessionId}.wav`;
  await fsp.mkdir(audioDir, { recursive: true });
  await fsp.writeFile(path.join(audioDir, audioFilename), pcmWav);

  const discovery = await discoverConnectors();
  const localSignatures = listMemorySignatures(db, sessionId);

  const classifiedEvents = [];
  for (let i = 0; i < analysis.events.length; i++) {
    const ev = analysis.events[i];
    const priorMatch = await queryRecurringSound(
      ev.vector,
      localSignatures,
      discovery.connectors.pinecone
    );

    const jev = await classifyEventWithJev(ev, priorMatch, discovery.connectors.typesafe);

    // Optional deterministic baseline notes when seeding Tuesday's reference night
    const seeded = seedLabels && seedLabels[i] ? seedLabels[i] : null;
    const finalLabel = seeded?.label || jev.label;
    const finalNote = seeded?.note || "";
    const finalNeedsHuman = seeded ? false : jev.needsHumanCall;
    const finalConfidence = seeded ? Math.max(0.92, jev.confidence) : jev.confidence;

    classifiedEvents.push({
      ...ev,
      label: finalLabel,
      originalLabel: finalLabel,
      dramaScore: jev.dramaScore,
      highlightWorthy: jev.highlightWorthy,
      confidence: finalConfidence,
      needsHumanCall: finalNeedsHuman,
      humanOverridden: Boolean(seeded),
      humanNote: finalNote,
      jevSource: jev.source,
      probabilities: jev.probabilities,
      pineconeMatch: priorMatch,
      createdAt: new Date().toISOString(),
    });
  }

  const draftSession = {
    id: sessionId,
    title,
    nightDate,
    mode: mode || (analysis.durationSec >= 20 ? "overnight" : "live"),
    source,
    audioFilename,
    highlightAudioFilename: null,
    durationSec: analysis.durationSec,
    ambientSplDb: analysis.ambientSplDb,
    boxScore: analysis.boxScore,
    waveform: analysis.waveform,
    spectrogram: analysis.spectrogram,
    createdAt: new Date().toISOString(),
  };

  const commentary = await generateCommentaryWithOllama(
    draftSession,
    classifiedEvents,
    discovery.connectors.ollama,
    discovery.connectors.openrouter
  );

  const voice = skipVoice
    ? { filename: null, source: "skipped-baseline" }
    : await synthesizeHighlightAudio(
        commentary.lines,
        audioDir,
        sessionId,
        discovery.connectors.elevenlabs
      );

  const fullSession = {
    ...draftSession,
    highlightAudioFilename: voice.filename || null,
    headline: commentary.headline,
    subhead: commentary.subhead,
    commentary: commentary.lines,
    connectorTrace: {
      transcodedBy,
      jev: classifiedEvents[0]?.jevSource || "local-acoustic-baseline",
      pinecone: discovery.connectors.pinecone.connected ? "pinecone-sprite-gateway" : "local-cosine-memory",
      ollama: commentary.source,
      elevenlabs: voice.source,
      box: discovery.connectors.box.connected ? "ready-sprite-gateway" : "local-export",
    },
  };

  saveSession(db, fullSession, classifiedEvents);

  // Upsert confident events into acoustic vector memory (SQLite + Pinecone)
  for (const ev of classifiedEvents) {
    if (!ev.needsHumanCall) {
      const sig = {
        id: `${sessionId}_${ev.index}`,
        sessionId,
        nightDate,
        clockLabel: ev.clockLabel,
        label: ev.label,
        note: ev.humanNote || "",
        vector: ev.vector,
        centroidHz: ev.metrics.centroidHz,
        splPeakDb: ev.metrics.splPeakDb,
        source: discovery.connectors.pinecone.connected ? "pinecone-sprite-gateway" : "local-cosine-memory",
        createdAt: fullSession.createdAt,
      };
      upsertMemorySignature(db, sig);
      await upsertSoundToPinecone(sig, discovery.connectors.pinecone);
    }
  }

  return getSession(db, sessionId);
}

/**
 * Apply human "You call it" override to an event, upsert its FFT vector into Pinecone
 * + SQLite memory so tomorrow night recognizes it, and refresh the broadcast commentary.
 */
export async function reclassifyEvent(db, eventId, newLabel, humanNote = "") {
  const ev = getEventById(db, eventId);
  if (!ev) return null;

  const cleanLabel = EVENT_LABELS[newLabel] ? newLabel : "mystery_mumble";
  const cleanNote = String(humanNote || "").trim().slice(0, 80);

  updateEventOverride(db, eventId, {
    label: cleanLabel,
    note: cleanNote,
    dramaScore: Math.max(ev.dramaScore, 0.72),
    highlightWorthy: true,
    pineconeMatch: ev.pineconeMatch,
  });

  const session = getSession(db, ev.sessionId);
  const discovery = await discoverConnectors();

  const sig = {
    id: `human_${ev.id}`,
    sessionId: session.id,
    nightDate: session.nightDate,
    clockLabel: ev.clockLabel,
    label: cleanLabel,
    note: cleanNote,
    vector: ev.vector,
    centroidHz: ev.metrics.centroidHz,
    splPeakDb: ev.metrics.splPeakDb,
    source: discovery.connectors.pinecone.connected ? "pinecone-sprite-gateway" : "human-booth-memory",
    createdAt: new Date().toISOString(),
  };
  upsertMemorySignature(db, sig);
  const pcSync = await upsertSoundToPinecone(sig, discovery.connectors.pinecone);

  const refreshed = getSession(db, session.id);
  const commentary = await generateCommentaryWithOllama(
    refreshed,
    refreshed.events,
    discovery.connectors.ollama,
    discovery.connectors.openrouter
  );

  updateSessionCommentary(db, session.id, {
    headline: commentary.headline,
    subhead: commentary.subhead,
    commentary: commentary.lines,
    connectorTrace: {
      ...refreshed.connectorTrace,
      ollama: commentary.source,
      pineconeLastUpsert: pcSync.source,
    },
  });

  return getSession(db, session.id);
}

/**
 * Archive a session's Breakfast Box Score HTML card to Box Connector (or local export).
 */
export async function archiveSessionCard(db, sessionId, exportsDir) {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const discovery = await discoverConnectors();
  const html = renderBreakfastBoxScoreHtml(session);
  const receipt = await archiveBreakfastToBox(
    session,
    html,
    exportsDir,
    discovery.connectors.box
  );
  updateSessionBoxArchive(db, sessionId, receipt);
  return { session: getSession(db, sessionId), receipt };
}

/**
 * Seed Tuesday's baseline recording + Last Night's highlight tape through the REAL
 * DSP + FFT pipeline on first boot so the database is never empty or faked.
 */
export async function seedInitialTapesIfEmpty(db, samplesDir, audioDir) {
  const existing = listSessions(db, 1);
  if (existing.length > 0) return;

  const tuePath = path.join(samplesDir, "tuesday-baseline.wav");
  const lastNightPath = path.join(samplesDir, "last-night-highlight.wav");

  if (fs.existsSync(tuePath)) {
    const buf = await fsp.readFile(tuePath);
    await processAudioTape(db, buf, {
      title: "Tuesday Baseline Tape",
      nightDate: "Tuesday",
      mode: "overnight",
      source: "tuesday-baseline",
      filename: "tuesday-baseline.wav",
      audioDir,
      skipVoice: true,
      seedLabels: [
        { label: "appliance_clank", note: "Hallway Radiator" },
        { label: "pet_ambush", note: "Porch Terrier" },
        { label: "snore_crescendo", note: "Deep Rally" },
      ],
    });
  }

  if (fs.existsSync(lastNightPath)) {
    const buf = await fsp.readFile(lastNightPath);
    await processAudioTape(db, buf, {
      title: "Last Night's Morning Edition",
      nightDate: "Last Night",
      mode: "overnight",
      source: "sample-overnight",
      filename: "last-night-highlight.wav",
      audioDir,
      skipVoice: true,
    });
  }
}

/**
 * Render a standalone, print-clean Breakfast Box Score HTML report for Box /Highlights/.
 */
export function renderBreakfastBoxScoreHtml(session) {
  const rows = session.events
    .map((ev) => {
      const matchText = ev.pineconeMatch
        ? `${ev.pineconeMatch.nightDate}: ${ev.pineconeMatch.note || ev.pineconeMatch.labelDisplay} (${ev.pineconeMatch.score.toFixed(2)})`
        : "New signature";
      return `<tr>
        <td>${escapeHtml(ev.clockLabel)}</td>
        <td><strong>${escapeHtml(EVENT_LABELS[ev.label] || ev.label)}</strong>${ev.humanNote ? ` (${escapeHtml(ev.humanNote)})` : ""}</td>
        <td>${ev.metrics.splPeakDb.toFixed(1)} dB</td>
        <td>${ev.metrics.centroidHz} Hz</td>
        <td>${Math.round(ev.confidence * 100)}%</td>
        <td>${escapeHtml(matchText)}</td>
      </tr>`;
    })
    .join("\n");

  const lines = session.commentary
    .map(
      (l) =>
        `<p><strong>${escapeHtml(l.speaker)} (${escapeHtml(l.clock)}):</strong> ${escapeHtml(l.text)}</p>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SnoreCenter Breakfast Box Score — ${escapeHtml(session.nightDate)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 820px; margin: 40px auto; padding: 0 24px; color: #1d2026; background: #f9fafc; }
  h1 { font-size: 38px; text-transform: uppercase; letter-spacing: -0.01em; margin: 0 0 8px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; border-top: 2px solid #1d2026; padding: 16px 0; margin: 24px 0; }
  .fig { font-size: 36px; font-weight: 800; color: #2448e5; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  th { text-align: left; border-bottom: 2px solid #1d2026; padding: 8px 6px; font-size: 13px; }
  td { border-bottom: 1px solid #d9dde5; padding: 10px 6px; font-size: 14px; }
  .note { margin-top: 24px; font-size: 12px; color: #5c6370; }
</style>
</head>
<body>
  <p>SnoreCenter Morning Report / ${escapeHtml(session.nightDate)}</p>
  <h1>${escapeHtml(session.headline)}</h1>
  <p>${escapeHtml(session.subhead)}</p>
  <div class="stats">
    <div><div class="fig">${session.boxScore.peakDb.toFixed(1)} dB</div><div>Peak loudness (${escapeHtml(session.boxScore.peakClock)})</div></div>
    <div><div class="fig">${session.boxScore.longestRallySec.toFixed(1)}s</div><div>Longest rally</div></div>
    <div><div class="fig">${session.boxScore.longestDramaticPauseSec.toFixed(1)}s</div><div>Longest Dramatic Pause</div></div>
    <div><div class="fig">${session.boxScore.totalEvents}</div><div>Events logged</div></div>
  </div>
  <h2>Booth play-by-play</h2>
  ${lines}
  <h2>Event film ledger</h2>
  <table>
    <thead><tr><th>Clock</th><th>Call</th><th>Peak</th><th>Tone</th><th>Conf.</th><th>Memory match</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">Entertainment broadcast generated from room acoustics only. Not a medical device or sleep-apnea assessment.</p>
</body>
</html>`;
}
