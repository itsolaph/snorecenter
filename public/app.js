/**
 * SnoreCenter browser controller:
 * - Renders real STFT spectrogram + interactive event markers synced to HTML5 Audio.
 * - Captures real 8-second live PCM WAV audio from the user's microphone.
 * - Handles "You call it" native <dialog closedby="any"> booth review & Pinecone sync.
 * - Includes Modern Web Guidance Safari fallback for dialog[closedby="any"].
 */

const state = {
  activeSession: null,
  sessions: [],
  season: null,
  eventLabels: {},
  connectors: null,
  checkpoints: [],
  slowMo: false,
  clipStopAt: null,
  rafId: null,
  recording: false,
  editingEventId: null,
};

const el = {
  heroPlay: document.getElementById("btn-play-hero"),
  heroRecord: document.getElementById("btn-record-hero"),
  fileInput: document.getElementById("audio-file-input"),
  uploadStatus: document.getElementById("upload-status"),
  headline: document.getElementById("broadcast-headline"),
  subhead: document.getElementById("broadcast-subhead"),
  canvas: document.getElementById("spectrogram-canvas"),
  audio: document.getElementById("tape-audio"),
  btnPlay: document.getElementById("btn-play-toggle"),
  btnSlowMo: document.getElementById("btn-slowmo"),
  btnRerun: document.getElementById("btn-rerun-sample"),
  clock: document.getElementById("deck-clock"),
  micStatus: document.getElementById("mic-status"),
  micMeter: document.getElementById("mic-meter"),
  boothGrid: document.getElementById("booth-grid"),
  boxScoreDate: document.getElementById("box-score-date"),
  statPeakDb: document.getElementById("stat-peak-db"),
  statPeakClock: document.getElementById("stat-peak-clock"),
  statRally: document.getElementById("stat-rally"),
  statRallyClock: document.getElementById("stat-rally-clock"),
  statPause: document.getElementById("stat-pause"),
  statEvents: document.getElementById("stat-events"),
  statAmbient: document.getElementById("stat-ambient"),
  filmTbody: document.getElementById("film-tbody"),
  seasonSummary: document.getElementById("season-summary"),
  sessionsList: document.getElementById("sessions-list"),
  checkpointsList: document.getElementById("checkpoints-list"),
  connectorsList: document.getElementById("connectors-list"),
  rawKeyCount: document.getElementById("raw-key-count"),
  runtimeModeNote: document.getElementById("runtime-mode-note"),
  btnArchiveBox: document.getElementById("btn-archive-box"),
  btnCheckpoint: document.getElementById("btn-checkpoint"),
  archiveFeedback: document.getElementById("archive-feedback"),
  linkCard: document.getElementById("link-card"),
  footerCardLink: document.getElementById("footer-card-link"),
  recallDialog: document.getElementById("recall-dialog"),
  btnDialogClose: document.getElementById("btn-dialog-close"),
  recallMeta: document.getElementById("recall-meta"),
  recallProbs: document.getElementById("recall-probs"),
  recallForm: document.getElementById("recall-form"),
  recallSelect: document.getElementById("recall-label-select"),
  recallNote: document.getElementById("recall-note-input"),
};

// Modern Web Guidance mandatory fallback for Safari where <dialog closedby="any"> is unsupported
if (!("closedBy" in HTMLDialogElement.prototype)) {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener("pointerup", (e) => {
      if (pressedOutside && outside(e, dialog)) dialog.close();
    });
  }
}

function fmtSec(sec) {
  const s = Math.max(0, Number(sec || 0));
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  return `${String(mins).padStart(2, "0")}:${rem.toFixed(1).padStart(4, "0")}`;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function drawSpectrogram(session, currentTimeSec = 0) {
  const canvas = el.canvas;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Dark ink studio floor
  ctx.fillStyle = "#12151f";
  ctx.fillRect(0, 0, w, h);

  if (!session || !session.spectrogram) return;
  const { cols, rows, data } = session.spectrogram;
  const cellW = w / cols;
  const cellH = h / rows;

  // Render real STFT log-frequency heatmap in Piste cobalt & snow ramp
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const v = data[c * rows + r] || 0;
      if (v < 18) continue;
      const t = v / 255;
      const rr = Math.round(28 + t * t * 218);
      const gg = Math.round(62 + t * 184);
      const bb = Math.round(180 + t * 75);
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      const y = h - (r + 1) * cellH;
      ctx.fillRect(Math.floor(c * cellW), Math.floor(y), Math.ceil(cellW + 0.5), Math.ceil(cellH + 0.5));
    }
  }

  // Event bracket overlays
  const dur = Math.max(0.1, session.durationSec || 1);
  for (const ev of session.events || []) {
    const x1 = (ev.startSec / dur) * w;
    const x2 = Math.max(x1 + 3, (ev.endSec / dur) * w);
    ctx.fillStyle = ev.needsHumanCall ? "rgba(232, 92, 54, 0.22)" : "rgba(247, 249, 255, 0.12)";
    ctx.fillRect(x1, 0, x2 - x1, h);

    ctx.fillStyle = ev.needsHumanCall ? "#e85c36" : "#f7f9ff";
    ctx.fillRect(x1, 0, 2, h);

    ctx.font = '500 13px "Barlow", sans-serif';
    ctx.fillStyle = "#f7f9ff";
    const tag = `${ev.clockLabel} ${ev.metrics.splPeakDb.toFixed(0)}dB`;
    const labelX = Math.min(w - 130, x1 + 6);
    ctx.fillText(tag, labelX, 20);
  }

  // Subtle frequency scale ruler along right edge
  ctx.font = '400 11px "JetBrains Mono", monospace';
  ctx.fillStyle = "rgba(247, 249, 255, 0.65)";
  ctx.fillText("6 kHz", w - 46, 18);
  ctx.fillText("1 kHz", w - 46, Math.round(h * 0.5));
  ctx.fillText("80 Hz", w - 46, h - 10);

  // Live playhead cursor
  const px = Math.min(w - 2, Math.max(0, (currentTimeSec / dur) * w));
  ctx.fillStyle = "#f7f9ff";
  ctx.fillRect(px, 0, 2, h);
}

function drawMicMeter(level = 0) {
  const canvas = el.micMeter;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#12151f";
  ctx.fillRect(0, 0, w, h);

  const bars = 22;
  const active = Math.round(Math.min(1, level) * bars);
  const gap = 3;
  const barW = (w - gap * (bars + 1)) / bars;
  for (let i = 0; i < bars; i++) {
    ctx.fillStyle = i < active ? (i > 17 ? "#e85c36" : "#f7f9ff") : "#2a3350";
    ctx.fillRect(gap + i * (barW + gap), 5, barW, h - 10);
  }
}

function renderActiveSession() {
  const s = state.activeSession;
  if (!s) return;

  el.headline.textContent = s.headline;
  el.subhead.textContent = s.subhead;
  el.boxScoreDate.textContent = `${s.title} (${s.nightDate}), ${s.durationSec.toFixed(1)}s tape, ${s.ambientSplDb.toFixed(0)} dB room floor.`;

  el.statPeakDb.textContent = `${s.boxScore.peakDb.toFixed(1)} dB`;
  el.statPeakClock.textContent = `Logged at ${s.boxScore.peakClock}`;
  el.statRally.textContent = `${s.boxScore.longestRallySec.toFixed(1)}s`;
  el.statRallyClock.textContent = `Started at ${s.boxScore.longestRallyClock}`;
  el.statPause.textContent = `${s.boxScore.longestDramaticPauseSec.toFixed(1)}s`;
  el.statEvents.textContent = String(s.boxScore.totalEvents);
  el.statAmbient.textContent = `Ambient floor ${s.ambientSplDb.toFixed(0)} dB`;

  const cardUrl = `/api/sessions/${encodeURIComponent(s.id)}/card`;
  el.linkCard.href = cardUrl;
  el.footerCardLink.href = cardUrl;

  if (el.audio.dataset.sessionId !== s.id) {
    el.audio.src = s.audioUrl;
    el.audio.dataset.sessionId = s.id;
    el.audio.playbackRate = state.slowMo ? 0.65 : 1.0;
    el.btnPlay.textContent = "Play tape";
  }

  el.clock.textContent = `${fmtSec(el.audio.currentTime || 0)} / ${fmtSec(s.durationSec)}`;
  drawSpectrogram(s, el.audio.currentTime || 0);

  // Render booth commentary
  clearNode(el.boothGrid);
  for (const line of s.commentary || []) {
    const item = document.createElement("article");
    item.className = "booth-line";

    const meta = document.createElement("div");
    meta.className = "booth-line__meta";

    const speaker = document.createElement("span");
    speaker.className = "booth-speaker";
    speaker.textContent = `${line.speaker} (${line.role})`;

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "booth-jump";
    jump.textContent = `Jump ${line.clock}`;
    jump.addEventListener("click", () => playSegment(line.startSec, null));

    meta.append(speaker, jump);

    const body = document.createElement("p");
    body.className = "booth-text";
    body.textContent = line.text;

    item.append(meta, body);
    el.boothGrid.append(item);
  }

  // Render responsive Event Film Ledger table
  clearNode(el.filmTbody);
  for (const ev of s.events || []) {
    const tr = document.createElement("tr");
    tr.dataset.uncertain = ev.needsHumanCall ? "true" : "false";

    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = ev.clockLabel;

    const tdCall = document.createElement("td");
    const primary = document.createElement("span");
    primary.className = "call-primary";
    primary.textContent = state.eventLabels[ev.label] || ev.label;
    tdCall.append(primary);
    if (ev.humanOverridden) {
      const note = document.createElement("span");
      note.className = "call-note";
      note.textContent = ev.humanNote ? `Booth call: ${ev.humanNote}` : "Confirmed by booth review";
      tdCall.append(note);
    }

    const tdPeak = document.createElement("td");
    tdPeak.className = "metric-num";
    tdPeak.textContent = `${ev.metrics.splPeakDb.toFixed(1)} dB`;

    const tdTone = document.createElement("td");
    tdTone.className = "metric-num";
    tdTone.textContent = `${ev.metrics.centroidHz} Hz (${ev.durationSec.toFixed(1)}s)`;

    const tdConf = document.createElement("td");
    const confBlock = document.createElement("div");
    confBlock.className = "conf-block";
    const confPct = document.createElement("span");
    confPct.className = "metric-num";
    confPct.textContent = `${Math.round(ev.confidence * 100)}%`;
    const meter = document.createElement("div");
    meter.className = "conf-meter";
    const fill = document.createElement("div");
    fill.className = "conf-meter__fill";
    fill.style.width = `${Math.round(ev.confidence * 100)}%`;
    meter.append(fill);
    confBlock.append(confPct, meter);
    if (ev.needsHumanCall) {
      const flag = document.createElement("span");
      flag.className = "conf-flag";
      flag.textContent = "Needs your call";
      confBlock.append(flag);
    }
    tdConf.append(confBlock);

    const tdMem = document.createElement("td");
    if (ev.pineconeMatch) {
      const hit = document.createElement("span");
      hit.className = "memory-hit";
      const matchName = ev.pineconeMatch.note || ev.pineconeMatch.labelDisplay;
      hit.textContent = `Matches ${ev.pineconeMatch.nightDate} ${matchName} (${ev.pineconeMatch.score.toFixed(2)})`;
      tdMem.append(hit);
    } else {
      const miss = document.createElement("span");
      miss.className = "memory-miss";
      miss.textContent = "New acoustic signature";
      tdMem.append(miss);
    }

    const tdAct = document.createElement("td");
    const acts = document.createElement("div");
    acts.className = "row-actions";

    const btnClip = document.createElement("button");
    btnClip.type = "button";
    btnClip.className = "btn btn--secondary btn--compact";
    btnClip.textContent = "Play clip";
    btnClip.addEventListener("click", () => {
      playSegment(ev.startSec, ev.endSec + 0.25);
      document.getElementById("broadcast-desk").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    const btnCall = document.createElement("button");
    btnCall.type = "button";
    btnCall.className = ev.needsHumanCall ? "btn btn--primary btn--compact" : "btn btn--secondary btn--compact";
    btnCall.textContent = ev.needsHumanCall ? "You call it" : "Override";
    btnCall.addEventListener("click", () => openRecallDialog(ev));

    acts.append(btnClip, btnCall);
    tdAct.append(acts);

    tr.append(th, tdCall, tdPeak, tdTone, tdConf, tdMem, tdAct);
    el.filmTbody.append(tr);
  }
}

function renderLedgerAndProof() {
  if (state.season) {
    el.seasonSummary.textContent = `${state.season.nightsLogged} nights logged, season high ${state.season.seasonPeakDb.toFixed(1)} dB, ${state.season.acousticSignaturesIndexed} acoustic fingerprints indexed.`;
  }

  clearNode(el.sessionsList);
  for (const s of state.sessions || []) {
    const li = document.createElement("li");
    li.className = "ruled-item";

    const main = document.createElement("div");
    main.className = "ruled-item__main";
    const title = document.createElement("span");
    title.className = "ruled-item__title";
    title.textContent = s.title;
    const meta = document.createElement("span");
    meta.className = "ruled-item__meta";
    meta.textContent = `${s.nightDate}, peak ${s.boxScore.peakDb.toFixed(1)} dB, ${s.boxScore.totalEvents} events`;
    main.append(title, meta);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--secondary btn--compact";
    btn.textContent = state.activeSession?.id === s.id ? "Loaded" : "Load tape";
    btn.disabled = state.activeSession?.id === s.id;
    btn.addEventListener("click", () => loadSession(s.id));

    li.append(main, btn);
    el.sessionsList.append(li);
  }

  clearNode(el.checkpointsList);
  if (!state.checkpoints || state.checkpoints.length === 0) {
    const li = document.createElement("li");
    li.className = "ruled-item";
    const meta = document.createElement("span");
    meta.className = "ruled-item__meta";
    meta.textContent = "No snapshots saved yet. Click Save checkpoint to capture the current SQLite ledger.";
    li.append(meta);
    el.checkpointsList.append(li);
  } else {
    for (const cp of state.checkpoints) {
      const li = document.createElement("li");
      li.className = "ruled-item";
      const main = document.createElement("div");
      main.className = "ruled-item__main";
      const t = document.createElement("span");
      t.className = "ruled-item__title";
      t.textContent = cp.id;
      const m = document.createElement("span");
      m.className = "ruled-item__meta";
      m.textContent = `${cp.mode}, ${cp.comment || "Read-only snapshot"}`;
      main.append(t, m);
      li.append(main);
      el.checkpointsList.append(li);
    }
  }

  if (state.connectors) {
    el.rawKeyCount.textContent = String(state.connectors.envAudit.rawApiKeysInEnv);
    el.runtimeModeNote.textContent = state.connectors.insideSprite
      ? `Fly.io Sprite live gateway (${state.connectors.connectedCount}/${state.connectors.totalCatalog} active)`
      : `Local preview mode (${state.connectors.connectedCount}/${state.connectors.totalCatalog} Sprite gateways)`;

    clearNode(el.connectorsList);
    for (const c of Object.values(state.connectors.connectors)) {
      const li = document.createElement("li");
      li.className = "ruled-item";
      const main = document.createElement("div");
      main.className = "ruled-item__main";
      const t = document.createElement("span");
      t.className = "ruled-item__title";
      t.textContent = c.name;
      const m = document.createElement("span");
      m.className = "ruled-item__meta";
      m.textContent = c.role;
      main.append(t, m);

      const status = document.createElement("span");
      status.className = c.connected ? "memory-hit" : "ruled-item__meta";
      status.textContent = c.connected ? "Sprite Gateway" : "Local baseline";

      li.append(main, status);
      el.connectorsList.append(li);
    }
  }
}

async function fetchState(sessionId = null) {
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  const res = await fetch(`/api/state${q}`);
  const data = await res.json();
  state.activeSession = data.activeSession;
  state.sessions = data.sessions;
  state.season = data.season;
  state.eventLabels = data.eventLabels;
  state.connectors = data.connectors;
  state.checkpoints = data.checkpoints;
  renderActiveSession();
  renderLedgerAndProof();
}

async function loadSession(sessionId) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) return;
  state.activeSession = await res.json();
  renderActiveSession();
  renderLedgerAndProof();
  document.getElementById("broadcast-desk").scrollIntoView({ behavior: "smooth", block: "start" });
}

function startPlayheadLoop() {
  cancelAnimationFrame(state.rafId);
  const step = () => {
    const s = state.activeSession;
    if (!s) return;
    const t = el.audio.currentTime || 0;
    if (state.clipStopAt !== null && t >= state.clipStopAt) {
      el.audio.pause();
      state.clipStopAt = null;
      el.btnPlay.textContent = "Play tape";
    }
    el.clock.textContent = `${fmtSec(t)} / ${fmtSec(s.durationSec)}`;
    drawSpectrogram(s, t);
    if (!el.audio.paused) {
      state.rafId = requestAnimationFrame(step);
    }
  };
  state.rafId = requestAnimationFrame(step);
}

function playSegment(startSec, endSec) {
  if (!state.activeSession) return;
  state.clipStopAt = endSec;
  el.audio.currentTime = Math.max(0, startSec || 0);
  el.audio.playbackRate = state.slowMo ? 0.65 : 1.0;
  el.audio.play().catch(() => {});
  el.btnPlay.textContent = "Pause";
  startPlayheadLoop();
}

function openRecallDialog(ev) {
  state.editingEventId = ev.id;
  el.recallMeta.textContent = `${ev.clockLabel}, peak ${ev.metrics.splPeakDb.toFixed(1)} dB, dominant ${ev.metrics.centroidHz} Hz, duration ${ev.durationSec.toFixed(2)}s.`;

  clearNode(el.recallProbs);
  const entries = Object.entries(ev.probabilities || {}).sort((a, b) => b[1] - a[1]);
  for (const [key, prob] of entries) {
    const li = document.createElement("li");
    li.className = "prob-row";
    const name = document.createElement("span");
    name.textContent = state.eventLabels[key] || key;
    const pct = document.createElement("span");
    pct.className = "metric-num";
    pct.textContent = `${Math.round(Number(prob) * 100)}%`;
    li.append(name, pct);
    el.recallProbs.append(li);
  }

  el.recallSelect.value = ev.label;
  el.recallNote.value = ev.humanNote || "";
  el.recallDialog.showModal();
}

el.btnDialogClose.addEventListener("click", () => {
  el.recallDialog.close("cancel");
});

// Modern Web Guidance: read dialog.returnValue on close, then reset to ''
el.recallDialog.addEventListener("close", async () => {
  const action = el.recallDialog.returnValue;
  el.recallDialog.returnValue = "";
  if (action !== "save" || !state.editingEventId) return;

  const eventId = state.editingEventId;
  const label = el.recallSelect.value;
  const note = el.recallNote.value.trim();
  state.editingEventId = null;

  el.micStatus.textContent = "Saving booth ruling and updating vector memory...";
  const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, note }),
  });
  if (res.ok) {
    const data = await res.json();
    state.activeSession = data.session;
    state.season = data.season;
    renderActiveSession();
    renderLedgerAndProof();
    el.micStatus.textContent = "Booth ruling saved. Tomorrow night's scan will match this acoustic signature.";
  } else {
    el.micStatus.textContent = "Could not save booth ruling. Try again.";
  }
});

// Encode browser Float32 PCM chunks into a standard 16kHz mono 16-bit WAV ArrayBuffer
function encodeMonoWav(floatChunks, inputRate) {
  let totalLen = 0;
  for (const c of floatChunks) totalLen += c.length;
  const merged = new Float32Array(totalLen);
  let off = 0;
  for (const c of floatChunks) {
    merged.set(c, off);
    off += c.length;
  }

  // Linear downsample to 16000 Hz
  const targetRate = 16000;
  const ratio = inputRate / targetRate;
  const outLen = Math.max(1, Math.floor(merged.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(merged.length - 1, i0 + 1);
    const frac = srcIdx - i0;
    out[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
  }

  const dataBytes = out.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (pos, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return buf;
}

async function recordLiveEightSeconds() {
  if (state.recording) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    el.micStatus.textContent = "Microphone API unavailable in this browser context. Upload a WAV file instead.";
    return;
  }

  document.getElementById("broadcast-desk").scrollIntoView({ behavior: "smooth", block: "start" });
  state.recording = true;
  el.heroRecord.disabled = true;
  el.micStatus.textContent = "Requesting microphone permission for an 8-second live room test...";

  let stream;
  let audioCtx;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    const started = performance.now();

    processor.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(ch));
      let peak = 0;
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
      drawMicMeter(Math.min(1, peak * 2.5));
      const elapsed = (performance.now() - started) / 1000;
      const remain = Math.max(0, 8 - elapsed);
      el.micStatus.textContent = `Recording live room audio: ${remain.toFixed(1)}s left. Clap, whisper, or stage a snore.`;
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

    await new Promise((resolve) => setTimeout(resolve, 8000));

    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    const sampleRate = audioCtx.sampleRate;
    await audioCtx.close();
    drawMicMeter(0);

    el.micStatus.textContent = "Slicing live peaks and calling the broadcast desk...";
    const wavBuf = encodeMonoWav(chunks, sampleRate);
    const res = await fetch("/api/analyze/upload", {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Filename": "live-room-check.wav",
        "X-Session-Title": "Live 8s Room Check",
        "X-Recording-Mode": "live",
      },
      body: wavBuf,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    state.activeSession = data.session;
    state.sessions = data.sessions;
    state.season = data.season;
    renderActiveSession();
    renderLedgerAndProof();
    el.micStatus.textContent = `Live room broadcast ready: ${data.session.events.length} events logged at ${data.session.boxScore.peakDb.toFixed(1)} dB peak.`;
  } catch (err) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (audioCtx && audioCtx.state !== "closed") audioCtx.close().catch(() => {});
    drawMicMeter(0);
    el.micStatus.textContent = `Live mic cancelled: ${err.message}`;
  } finally {
    state.recording = false;
    el.heroRecord.disabled = false;
  }
}

// Event listeners
el.heroPlay.addEventListener("click", () => {
  document.getElementById("broadcast-desk").scrollIntoView({ behavior: "smooth", block: "start" });
  playSegment(0, null);
});

el.heroRecord.addEventListener("click", () => {
  recordLiveEightSeconds();
});

el.fileInput.addEventListener("change", async () => {
  const file = el.fileInput.files?.[0];
  if (!file) return;
  el.uploadStatus.textContent = `Analyzing ${file.name}...`;
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch("/api/analyze/upload", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": file.name,
        "X-Session-Title": file.name.replace(/\.[^.]+$/, "").slice(0, 60),
      },
      body: buf,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.activeSession = data.session;
    state.sessions = data.sessions;
    state.season = data.season;
    renderActiveSession();
    renderLedgerAndProof();
    el.uploadStatus.textContent = `Loaded ${file.name}.`;
    document.getElementById("broadcast-desk").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    el.uploadStatus.textContent = `Upload failed: ${err.message}`;
  } finally {
    el.fileInput.value = "";
  }
});

el.btnPlay.addEventListener("click", () => {
  if (!state.activeSession) return;
  if (el.audio.paused) {
    state.clipStopAt = null;
    el.audio.playbackRate = state.slowMo ? 0.65 : 1.0;
    el.audio.play().catch(() => {});
    el.btnPlay.textContent = "Pause";
    startPlayheadLoop();
  } else {
    el.audio.pause();
    el.btnPlay.textContent = "Play tape";
  }
});

el.audio.addEventListener("ended", () => {
  el.btnPlay.textContent = "Play tape";
  state.clipStopAt = null;
  if (state.activeSession) drawSpectrogram(state.activeSession, 0);
});

el.btnSlowMo.addEventListener("click", () => {
  state.slowMo = !state.slowMo;
  el.btnSlowMo.setAttribute("aria-pressed", String(state.slowMo));
  el.btnSlowMo.textContent = state.slowMo ? "Slow-mo 0.65x ON" : "Slow-mo 0.65x";
  el.audio.playbackRate = state.slowMo ? 0.65 : 1.0;
});

el.btnRerun.addEventListener("click", async () => {
  el.btnRerun.disabled = true;
  el.micStatus.textContent = "Running fresh DSP slice and Connector pass on last night's sample tape...";
  try {
    const res = await fetch("/api/analyze/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample: "last-night" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.activeSession = data.session;
    state.sessions = data.sessions;
    state.season = data.season;
    renderActiveSession();
    renderLedgerAndProof();
    el.micStatus.textContent = "Fresh morning edition logged and added to the nightly ledger.";
  } catch (err) {
    el.micStatus.textContent = `Run failed: ${err.message}`;
  } finally {
    el.btnRerun.disabled = false;
  }
});

el.canvas.addEventListener("click", (e) => {
  if (!state.activeSession) return;
  const rect = el.canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const sec = ratio * state.activeSession.durationSec;
  playSegment(sec, null);
});

el.btnArchiveBox.addEventListener("click", async () => {
  if (!state.activeSession) return;
  el.btnArchiveBox.disabled = true;
  el.archiveFeedback.textContent = "Exporting Breakfast Box Score...";
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(state.activeSession.id)}/archive-box`, {
      method: "POST",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.activeSession = data.session;
    el.archiveFeedback.textContent = `Saved ${data.receipt.fileName} (${data.receipt.mode}).`;
  } catch (err) {
    el.archiveFeedback.textContent = `Archive failed: ${err.message}`;
  } finally {
    el.btnArchiveBox.disabled = false;
  }
});

el.btnCheckpoint.addEventListener("click", async () => {
  if (!state.activeSession) return;
  el.btnCheckpoint.disabled = true;
  el.archiveFeedback.textContent = "Creating snapshot checkpoint...";
  try {
    const res = await fetch("/api/checkpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.activeSession.id,
        comment: `Morning desk ${state.activeSession.nightDate}`,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.checkpoints = data.checkpoints;
    renderLedgerAndProof();
    el.archiveFeedback.textContent = `Checkpoint ${data.checkpoint.id} saved (${data.checkpoint.mode}).`;
  } catch (err) {
    el.archiveFeedback.textContent = `Checkpoint failed: ${err.message}`;
  } finally {
    el.btnCheckpoint.disabled = false;
  }
});

drawMicMeter(0);
fetchState();
