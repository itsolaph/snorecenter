/**
 * SQLite persistence layer using Node's built-in `node:sqlite` (Node >= 22.5).
 * Stores nightly sessions, sliced acoustic events, recurring 32-dim FFT signatures,
 * Box archive receipts, and Sprite checkpoint references.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      night_date TEXT NOT NULL,
      mode TEXT NOT NULL,
      source TEXT NOT NULL,
      audio_filename TEXT NOT NULL,
      highlight_audio_filename TEXT,
      duration_sec REAL NOT NULL,
      ambient_spl_db REAL NOT NULL,
      peak_db REAL NOT NULL,
      peak_clock TEXT NOT NULL,
      longest_rally_sec REAL NOT NULL,
      longest_rally_clock TEXT NOT NULL,
      longest_pause_sec REAL NOT NULL,
      total_events INTEGER NOT NULL,
      total_active_sec REAL NOT NULL,
      headline TEXT NOT NULL,
      subhead TEXT NOT NULL,
      commentary_json TEXT NOT NULL,
      waveform_json TEXT NOT NULL,
      spectrogram_json TEXT NOT NULL,
      connector_trace_json TEXT NOT NULL,
      box_archive_json TEXT,
      checkpoint_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      duration_sec REAL NOT NULL,
      clock_label TEXT NOT NULL,
      label TEXT NOT NULL,
      original_label TEXT NOT NULL,
      drama_score REAL NOT NULL,
      highlight_worthy INTEGER NOT NULL,
      confidence REAL NOT NULL,
      needs_human_call INTEGER NOT NULL,
      human_overridden INTEGER NOT NULL DEFAULT 0,
      human_note TEXT,
      jev_source TEXT NOT NULL,
      probabilities_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      spectrogram_json TEXT NOT NULL,
      pinecone_match_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, idx);

    CREATE TABLE IF NOT EXISTS memory_signatures (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      night_date TEXT NOT NULL,
      clock_label TEXT NOT NULL,
      label TEXT NOT NULL,
      note TEXT,
      vector_json TEXT NOT NULL,
      centroid_hz INTEGER NOT NULL,
      spl_peak_db REAL NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_label ON memory_signatures(label);
  `);

  return db;
}

function hydrateEvent(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    index: row.idx,
    startSec: row.start_sec,
    endSec: row.end_sec,
    durationSec: row.duration_sec,
    clockLabel: row.clock_label,
    label: row.label,
    originalLabel: row.original_label,
    dramaScore: row.drama_score,
    highlightWorthy: Boolean(row.highlight_worthy),
    confidence: row.confidence,
    needsHumanCall: Boolean(row.needs_human_call),
    humanOverridden: Boolean(row.human_overridden),
    humanNote: row.human_note || "",
    jevSource: row.jev_source,
    probabilities: JSON.parse(row.probabilities_json),
    metrics: JSON.parse(row.metrics_json),
    vector: JSON.parse(row.vector_json),
    spectrogram: JSON.parse(row.spectrogram_json),
    pineconeMatch: row.pinecone_match_json ? JSON.parse(row.pinecone_match_json) : null,
    createdAt: row.created_at,
  };
}

function hydrateSessionSummary(row) {
  return {
    id: row.id,
    title: row.title,
    nightDate: row.night_date,
    mode: row.mode,
    source: row.source,
    audioFilename: row.audio_filename,
    audioUrl: `/audio/${encodeURIComponent(row.audio_filename)}`,
    highlightAudioFilename: row.highlight_audio_filename || null,
    highlightAudioUrl: row.highlight_audio_filename
      ? `/audio/${encodeURIComponent(row.highlight_audio_filename)}`
      : null,
    durationSec: row.duration_sec,
    ambientSplDb: row.ambient_spl_db,
    boxScore: {
      peakDb: row.peak_db,
      peakClock: row.peak_clock,
      longestRallySec: row.longest_rally_sec,
      longestRallyClock: row.longest_rally_clock,
      longestDramaticPauseSec: row.longest_pause_sec,
      totalEvents: row.total_events,
      totalActiveSec: row.total_active_sec,
    },
    headline: row.headline,
    subhead: row.subhead,
    boxArchive: row.box_archive_json ? JSON.parse(row.box_archive_json) : null,
    checkpointId: row.checkpoint_id || null,
    createdAt: row.created_at,
  };
}

export function saveSession(db, session, events) {
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, title, night_date, mode, source, audio_filename, highlight_audio_filename,
      duration_sec, ambient_spl_db, peak_db, peak_clock, longest_rally_sec,
      longest_rally_clock, longest_pause_sec, total_events, total_active_sec,
      headline, subhead, commentary_json, waveform_json, spectrogram_json,
      connector_trace_json, box_archive_json, checkpoint_id, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (
      id, session_id, idx, start_sec, end_sec, duration_sec, clock_label,
      label, original_label, drama_score, highlight_worthy, confidence,
      needs_human_call, human_overridden, human_note, jev_source,
      probabilities_json, metrics_json, vector_json, spectrogram_json,
      pinecone_match_json, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `);

  db.exec("BEGIN");
  try {
    insertSession.run(
      session.id,
      session.title,
      session.nightDate,
      session.mode,
      session.source,
      session.audioFilename,
      session.highlightAudioFilename || null,
      session.durationSec,
      session.ambientSplDb,
      session.boxScore.peakDb,
      session.boxScore.peakClock,
      session.boxScore.longestRallySec,
      session.boxScore.longestRallyClock,
      session.boxScore.longestDramaticPauseSec,
      session.boxScore.totalEvents,
      session.boxScore.totalActiveSec,
      session.headline,
      session.subhead,
      JSON.stringify(session.commentary),
      JSON.stringify(session.waveform),
      JSON.stringify(session.spectrogram),
      JSON.stringify(session.connectorTrace || {}),
      session.boxArchive ? JSON.stringify(session.boxArchive) : null,
      session.checkpointId || null,
      session.createdAt
    );

    for (const ev of events) {
      insertEvent.run(
        ev.id,
        session.id,
        ev.index,
        ev.startSec,
        ev.endSec,
        ev.durationSec,
        ev.clockLabel,
        ev.label,
        ev.originalLabel || ev.label,
        ev.dramaScore,
        ev.highlightWorthy ? 1 : 0,
        ev.confidence,
        ev.needsHumanCall ? 1 : 0,
        ev.humanOverridden ? 1 : 0,
        ev.humanNote || null,
        ev.jevSource,
        JSON.stringify(ev.probabilities),
        JSON.stringify(ev.metrics),
        JSON.stringify(ev.vector),
        JSON.stringify(ev.spectrogram),
        ev.pineconeMatch ? JSON.stringify(ev.pineconeMatch) : null,
        ev.createdAt || session.createdAt
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function listSessions(db, limit = 20) {
  const rows = db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?")
    .all(limit);
  return rows.map(hydrateSessionSummary);
}

export function getSession(db, sessionId) {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!row) return null;
  const eventRows = db
    .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY idx ASC")
    .all(sessionId);
  return {
    ...hydrateSessionSummary(row),
    commentary: JSON.parse(row.commentary_json),
    waveform: JSON.parse(row.waveform_json),
    spectrogram: JSON.parse(row.spectrogram_json),
    connectorTrace: JSON.parse(row.connector_trace_json),
    events: eventRows.map(hydrateEvent),
  };
}

export function getEventById(db, eventId) {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
  return row ? hydrateEvent(row) : null;
}

export function updateEventOverride(db, eventId, { label, note, dramaScore, highlightWorthy, pineconeMatch }) {
  db.prepare(`
    UPDATE events
    SET label = ?,
        human_overridden = 1,
        needs_human_call = 0,
        confidence = 1.0,
        human_note = ?,
        drama_score = COALESCE(?, drama_score),
        highlight_worthy = COALESCE(?, highlight_worthy),
        pinecone_match_json = COALESCE(?, pinecone_match_json)
    WHERE id = ?
  `).run(
    label,
    note || null,
    dramaScore ?? null,
    highlightWorthy == null ? null : highlightWorthy ? 1 : 0,
    pineconeMatch ? JSON.stringify(pineconeMatch) : null,
    eventId
  );
}

export function updateSessionCommentary(db, sessionId, { headline, subhead, commentary, connectorTrace }) {
  db.prepare(`
    UPDATE sessions
    SET headline = ?, subhead = ?, commentary_json = ?, connector_trace_json = ?
    WHERE id = ?
  `).run(
    headline,
    subhead,
    JSON.stringify(commentary),
    JSON.stringify(connectorTrace),
    sessionId
  );
}

export function updateSessionBoxArchive(db, sessionId, boxArchive) {
  db.prepare("UPDATE sessions SET box_archive_json = ? WHERE id = ?").run(
    JSON.stringify(boxArchive),
    sessionId
  );
}

export function updateSessionCheckpoint(db, sessionId, checkpointId) {
  db.prepare("UPDATE sessions SET checkpoint_id = ? WHERE id = ?").run(
    checkpointId,
    sessionId
  );
}

export function upsertMemorySignature(db, sig) {
  db.prepare(`
    INSERT OR REPLACE INTO memory_signatures (
      id, session_id, night_date, clock_label, label, note,
      vector_json, centroid_hz, spl_peak_db, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sig.id,
    sig.sessionId,
    sig.nightDate,
    sig.clockLabel,
    sig.label,
    sig.note || null,
    JSON.stringify(sig.vector),
    sig.centroidHz,
    sig.splPeakDb,
    sig.source,
    sig.createdAt
  );
}

export function listMemorySignatures(db, excludeSessionId = null) {
  const rows = excludeSessionId
    ? db
        .prepare("SELECT * FROM memory_signatures WHERE session_id != ? ORDER BY created_at DESC LIMIT 200")
        .all(excludeSessionId)
    : db
        .prepare("SELECT * FROM memory_signatures ORDER BY created_at DESC LIMIT 200")
        .all();
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    nightDate: r.night_date,
    clockLabel: r.clock_label,
    label: r.label,
    note: r.note || "",
    vector: JSON.parse(r.vector_json),
    centroidHz: r.centroid_hz,
    splPeakDb: r.spl_peak_db,
    source: r.source,
    createdAt: r.created_at,
  }));
}

export function getSeasonStats(db) {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS nights_logged,
        MAX(peak_db) AS season_peak_db,
        MAX(longest_rally_sec) AS season_longest_rally_sec,
        MAX(longest_pause_sec) AS season_longest_pause_sec,
        SUM(total_events) AS season_total_events
      FROM sessions
    `)
    .get();
  const sigCount = db.prepare("SELECT COUNT(*) AS c FROM memory_signatures").get();
  return {
    nightsLogged: Number(row?.nights_logged || 0),
    seasonPeakDb: Number(row?.season_peak_db || 0),
    seasonLongestRallySec: Number(row?.season_longest_rally_sec || 0),
    seasonLongestPauseSec: Number(row?.season_longest_pause_sec || 0),
    seasonTotalEvents: Number(row?.season_total_events || 0),
    acousticSignaturesIndexed: Number(sigCount?.c || 0),
  };
}
