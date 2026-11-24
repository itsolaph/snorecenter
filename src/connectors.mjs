/**
 * Zero-key Fly.io Sprites Connectors client + honest local fallback.
 *
 * Inside a Fly.io Sprite, connectors are discovered dynamically via:
 *   GET https://api.sprites.dev/v1/gateway/list
 * and called through each connector's `gateway_base_url` with ZERO API keys
 * inside the Sprite environment.
 *
 * Outside a Sprite (local dev / offline tests), every call falls back cleanly
 * to deterministic acoustic / local-SQLite logic and tags its exact source
 * (`sprite-gateway` vs `local-baseline`) without ever faking a live connection.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cosineSimilarity } from "./fft.mjs";

const execFileAsync = promisify(execFile);

const SPRITE_API_BASE = process.env.SPRITES_GATEWAY_BASE || "https://api.sprites.dev";
const SPRITE_DIR = process.env.SPRITE_ROOT_DIR || "/.sprite";
const SPRITE_CHECKPOINTS_DIR = process.env.SPRITES_CHECKPOINTS_DIR || "/.sprite/checkpoints";

export const EVENT_LABELS = {
  snore_crescendo: "Snore Crescendo",
  pet_ambush: "Pet Ambush",
  appliance_clank: "Radiator / Pipe Clank",
  fridge_raid: "Fridge Raid",
  mystery_mumble: "Mystery Mumble",
};

const CONNECTOR_CATALOG = [
  { key: "typesafe", name: "TypeSafe AI (Jev)", role: "Calibrated sound classification, drama score & highlight gate", matchers: ["typesafe", "jev"] },
  { key: "pinecone", name: "Pinecone", role: "Recurring overnight sound fingerprint memory (32-dim FFT cosine)", matchers: ["pinecone"] },
  { key: "ollama", name: "Ollama Cloud", role: "Two-anchor morning sports play-by-play script synthesis", matchers: ["ollama"] },
  { key: "box", name: "Box", role: "Inbox (/NightWatch) and Box Score archive (/Highlights)", matchers: ["box"] },
  { key: "elevenlabs", name: "ElevenLabs", role: "Voiced broadcast commentary mix for morning highlight clips", matchers: ["elevenlabs", "eleven"] },
];

const SECRET_ENV_PATTERN = /(TYPESAFE|PINECONE|BOX_|OLLAMA|ELEVENLABS|OPENAI|ANTHROPIC|API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET_KEY)/i;

export function scanEnvForRawKeys() {
  const flagged = Object.keys(process.env).filter(
    (k) => SECRET_ENV_PATTERN.test(k) && String(process.env[k] || "").trim().length > 0
  );
  return {
    rawApiKeysInEnv: flagged.length,
    flaggedNames: flagged,
    zeroKeyVerified: flagged.length === 0,
  };
}

export function isInsideSprite() {
  if (process.env.SPRITES_FORCE_GATEWAY === "1") return true;
  return fs.existsSync(SPRITE_DIR) || fs.existsSync("/.sprite/api.sock");
}

function normalizeGatewayList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.connectors)) return payload.connectors;
  if (payload && Array.isArray(payload.connections)) return payload.connections;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

let cachedDiscovery = null;
let cachedDiscoveryAt = 0;

/**
 * Discover active Fly.io Sprites Connectors via GET /v1/gateway/list.
 */
export async function discoverConnectors(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedDiscovery && now - cachedDiscoveryAt < 15000) {
    return cachedDiscovery;
  }

  const insideSprite = isInsideSprite();
  const envAudit = scanEnvForRawKeys();
  let gatewayItems = [];
  let gatewayReachable = false;
  let gatewayError = null;

  if (insideSprite || process.env.SPRITES_GATEWAY_BASE) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${SPRITE_API_BASE.replace(/\/$/, "")}/v1/gateway/list`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json();
        gatewayItems = normalizeGatewayList(json);
        gatewayReachable = true;
      } else {
        gatewayError = `HTTP ${res.status}`;
      }
    } catch (err) {
      gatewayError = err.name === "AbortError" ? "gateway timeout" : err.message;
    }
  }

  const connectors = {};
  for (const spec of CONNECTOR_CATALOG) {
    const matched = gatewayItems.find((item) => {
      const hay = [
        item.provider,
        item.connector,
        item.slug,
        item.name,
        item.id,
        item.gateway_base_url,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return spec.matchers.some((m) => hay.includes(m));
    });

    if (matched) {
      const baseUrl =
        matched.gateway_base_url ||
        matched.base_url ||
        (matched.provider && matched.connection_id
          ? `${SPRITE_API_BASE.replace(/\/$/, "")}/v1/gateway/${matched.provider}/${matched.connection_id}`
          : null);
      connectors[spec.key] = {
        key: spec.key,
        name: spec.name,
        role: spec.role,
        connected: Boolean(baseUrl),
        mode: baseUrl ? "sprite-gateway" : "pending-setup",
        gatewayBaseUrl: baseUrl,
        connectionId: matched.connection_id || matched.id || null,
        provider: matched.provider || spec.key,
        scopes: matched.scopes || [],
        setupUrl: matched.setup_url || null,
      };
    } else {
      connectors[spec.key] = {
        key: spec.key,
        name: spec.name,
        role: spec.role,
        connected: false,
        mode: insideSprite ? "not-configured" : "local-baseline",
        gatewayBaseUrl: null,
        connectionId: null,
        provider: spec.key,
        scopes: [],
        setupUrl: null,
      };
    }
  }

  const connectedCount = Object.values(connectors).filter((c) => c.connected).length;
  cachedDiscovery = {
    checkedAt: new Date().toISOString(),
    insideSprite,
    gatewayReachable,
    gatewayError,
    connectedCount,
    totalCatalog: CONNECTOR_CATALOG.length,
    envAudit,
    connectors,
  };
  cachedDiscoveryAt = now;
  return cachedDiscovery;
}

/**
 * Deterministic calibrated acoustic classifier used when TypeSafe AI Jev Connector
 * is offline/unconfigured. Computes real softmax probabilities from FFT metrics so
 * ambiguous low-energy formants genuinely drop below 0.70 confidence and route to
 * the "You call it" human desk.
 */
export function localAcousticClassify(event, priorMatch = null) {
  const m = event.metrics;
  const logits = {
    snore_crescendo: 0.25,
    pet_ambush: 0.25,
    appliance_clank: 0.25,
    fridge_raid: 0.25,
    mystery_mumble: 0.3,
  };

  // Snore crescendo: sustained (>2.4s), strong low band, low-mid centroid, rhythmic breathing modulation
  if (m.durationSec >= 2.4 && m.lowRatio >= 0.42 && m.centroidHz <= 700) logits.snore_crescendo += 3.1;
  if (m.modulation >= 0.4 && m.lowRatio >= 0.45 && m.highRatio < 0.2 && m.centroidHz <= 720) logits.snore_crescendo += 1.6;
  if (m.splPeakDb >= 68 && m.centroidHz < 520 && m.durationSec >= 2.0) logits.snore_crescendo += 1.1;

  // Pet ambush: sharp impulsive bursts, high centroid (>1300Hz), high crest factor, compact duration
  if (m.centroidHz >= 1200 && m.crestFactor >= 3.2 && m.durationSec <= 2.2 && m.splPeakDb >= 68) logits.pet_ambush += 3.1;
  if (m.highRatio >= 0.22 && m.zcr >= 0.08 && m.splPeakDb >= 68) logits.pet_ambush += 1.8;

  // Appliance / radiator clank: metallic resonant decay, mid-band concentration, compact duration (<=1.9s)
  if (m.centroidHz >= 400 && m.centroidHz <= 1350 && m.durationSec <= 1.9 && m.splPeakDb >= 64) {
    logits.appliance_clank += 2.6;
  }
  if (m.midRatio >= 0.34 && m.crestFactor >= 2.6 && m.durationSec <= 1.8 && m.splPeakDb >= 66) {
    logits.appliance_clank += 1.5;
  }

  // Fridge raid: multi-phase broadband sound (footsteps + bright latch clicks + low compressor hum)
  if (m.durationSec >= 2.0 && m.highRatio >= 0.2 && m.lowRatio >= 0.24 && m.splPeakDb >= 66) logits.fridge_raid += 2.9;
  if (m.zcr >= 0.05 && m.crestFactor >= 3.8 && m.durationSec >= 2.0 && m.splPeakDb >= 66) logits.fridge_raid += 1.8;

  // Mystery mumble: quieter (<66.5 dB), softer crest, blended mid-low formant -> intentionally tight split (<70%)
  if (m.splPeakDb < 66.5 && m.durationSec <= 2.3) {
    logits.mystery_mumble += 1.95;
    logits.fridge_raid += 1.2;
    logits.snore_crescendo += 0.9;
    logits.appliance_clank -= 0.4;
    logits.pet_ambush -= 0.6;
  }

  // Prior vector memory reinforcement (for confident recurring room culprits)
  if (priorMatch && priorMatch.score >= 0.9 && logits[priorMatch.label] !== undefined && m.splPeakDb >= 66) {
    logits[priorMatch.label] += 1.4;
  }

  // Softmax calibration
  const keys = Object.keys(logits);
  const maxL = Math.max(...keys.map((k) => logits[k]));
  const exps = {};
  let sum = 0;
  for (const k of keys) {
    exps[k] = Math.exp(logits[k] - maxL);
    sum += exps[k];
  }
  const probabilities = {};
  let bestKey = keys[0];
  let bestProb = -1;
  for (const k of keys) {
    const p = Number((exps[k] / sum).toFixed(4));
    probabilities[k] = p;
    if (p > bestProb) {
      bestProb = p;
      bestKey = k;
    }
  }

  const energyFactor = Math.max(0, Math.min(1, (m.splPeakDb - 50) / 30));
  const durFactor = Math.max(0, Math.min(1, m.durationSec / 4.5));
  const dramaScore = Number(Math.max(0.22, Math.min(0.98, 0.28 + 0.52 * energyFactor + 0.2 * durFactor)).toFixed(2));
  const highlightWorthy = dramaScore >= 0.55 || bestProb < 0.7;

  return {
    label: bestKey,
    probabilities,
    confidence: Number(bestProb.toFixed(3)),
    dramaScore,
    highlightWorthy,
    needsHumanCall: bestProb < 0.7,
    source: "local-acoustic-baseline",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Classify an acoustic event through TypeSafe AI Jev Sprite Connector (`POST /v1/decide`),
 * returning calibrated probabilities, drama score, and highlight gate.
 */
export async function classifyEventWithJev(event, priorMatch, connector) {
  if (connector?.connected && connector.gatewayBaseUrl) {
    const payload = {
      model: process.env.TYPESAFE_JEV_MODEL || "jev-latest",
      state: JSON.stringify({
        clock: event.clockLabel,
        duration_sec: event.durationSec,
        spl_peak_db: event.metrics.splPeakDb,
        spl_avg_db: event.metrics.splAvgDb,
        spectral_centroid_hz: event.metrics.centroidHz,
        zero_crossing_rate: event.metrics.zcr,
        crest_factor: event.metrics.crestFactor,
        envelope_modulation: event.metrics.modulation,
        band_energy: {
          low: event.metrics.lowRatio,
          mid: event.metrics.midRatio,
          high: event.metrics.highRatio,
        },
        spectral_flux: event.metrics.spectralFlux,
        prior_memory_match: priorMatch
          ? { label: priorMatch.label, nightDate: priorMatch.nightDate, cosine: priorMatch.score }
          : null,
      }),
      questions: {
        event_type: {
          type: "choice",
          instructions: "Classify this overnight room sound from acoustic DSP features into one category.",
          criteria: {
            snore_crescendo: "Sustained low-frequency rhythmic breathing rumble with strong low-band energy and modulation.",
            pet_ambush: "Sharp impulsive mid-high bursts with high crest factor such as dog barks or cat cries.",
            appliance_clank: "Metallic pipe or radiator clang with sharp transient and tonal mid-low ring.",
            fridge_raid: "Footstep thuds with broad-spectrum door latch rattle and refrigerator hum.",
            mystery_mumble: "Quiet or ambiguous voice formant, pillow rustle, or uncertain sound needing human confirmation.",
          },
        },
        drama_score: {
          type: "score",
          instructions: "Score highlight drama from 0.0 (quiet background) to 1.0 (morning Top-10 broadcast centerpiece).",
        },
        highlight_worthy: {
          type: "noul",
          instructions: "Should this event be included in the morning 60-second highlight show?",
        },
      },
    };

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${connector.gatewayBaseUrl.replace(/\/$/, "")}/v1/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        const ans = data.answers || {};
        const evChoice = ans.event_type || {};
        const choice = EVENT_LABELS[evChoice.choice] ? evChoice.choice : "mystery_mumble";
        const probs = evChoice.probabilities || { [choice]: evChoice.confidence ?? 0.75 };
        const confidence = Number(
          (evChoice.confidence ?? probs[choice] ?? 0.75).toFixed(3)
        );
        const dramaScore = Number(
          Math.max(0, Math.min(1, Number(ans.drama_score?.score ?? 0.65))).toFixed(2)
        );
        const highlightWorthy =
          ans.highlight_worthy?.noul === true ||
          ans.highlight_worthy?.choice === "yes" ||
          dramaScore >= 0.6;

        return {
          label: choice,
          probabilities: probs,
          confidence,
          dramaScore,
          highlightWorthy,
          needsHumanCall: confidence < 0.7,
          source: "typesafe-jev-gateway",
          model: data.model || payload.model,
          usage: data.usage || { input_tokens: 0, output_tokens: 0 },
        };
      }
    } catch (err) {
      const fallback = localAcousticClassify(event, priorMatch);
      return { ...fallback, gatewayFallbackReason: err.message };
    }
  }

  return localAcousticClassify(event, priorMatch);
}

/**
 * Query recurring sound fingerprints across prior nights via Pinecone Sprite Connector
 * (when configured) plus local SQLite 32-dim cosine mirror.
 */
export async function queryRecurringSound(vector, localSignatures, connector) {
  let pineconeResult = null;

  if (connector?.connected && connector.gatewayBaseUrl) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const namespace = process.env.PINECONE_NAMESPACE || "nightwatch";
      const res = await fetch(`${connector.gatewayBaseUrl.replace(/\/$/, "")}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          vector,
          topK: 3,
          includeMetadata: true,
          namespace,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const top = (data.matches || [])[0];
        if (top && top.score >= 0.85) {
          pineconeResult = {
            id: top.id,
            label: top.metadata?.label || "appliance_clank",
            labelDisplay: EVENT_LABELS[top.metadata?.label] || top.metadata?.label || "Recurring Sound",
            nightDate: top.metadata?.nightDate || "Prior Night",
            clockLabel: top.metadata?.clockLabel || "",
            note: top.metadata?.note || "",
            score: Number(top.score.toFixed(3)),
            source: "pinecone-sprite-gateway",
          };
        }
      }
    } catch {
      // Fall through to local cosine mirror
    }
  }

  if (pineconeResult) return pineconeResult;

  // Local SQLite 32-dim cosine index
  let best = null;
  for (const sig of localSignatures) {
    const score = cosineSimilarity(vector, sig.vector);
    if (!best || score > best.score) {
      best = {
        id: sig.id,
        label: sig.label,
        labelDisplay: EVENT_LABELS[sig.label] || sig.label,
        nightDate: sig.nightDate,
        clockLabel: sig.clockLabel,
        note: sig.note || "",
        score: Number(score.toFixed(3)),
        source: connector?.connected ? "pinecone-local-mirror" : "local-cosine-memory",
      };
    }
  }

  return best && best.score >= 0.88 ? best : null;
}

/**
 * Upsert a confirmed or human-labeled acoustic vector into Pinecone Sprite Connector.
 */
export async function upsertSoundToPinecone(signature, connector) {
  if (!connector?.connected || !connector.gatewayBaseUrl) {
    return { synced: false, source: "local-sqlite-only" };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const namespace = process.env.PINECONE_NAMESPACE || "nightwatch";
    const res = await fetch(`${connector.gatewayBaseUrl.replace(/\/$/, "")}/vectors/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        namespace,
        vectors: [
          {
            id: signature.id,
            values: signature.vector,
            metadata: {
              label: signature.label,
              nightDate: signature.nightDate,
              clockLabel: signature.clockLabel,
              note: signature.note || "",
              centroidHz: signature.centroidHz,
              splPeakDb: signature.splPeakDb,
            },
          },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      return { synced: true, source: "pinecone-sprite-gateway" };
    }
    return { synced: false, source: "local-sqlite-only", error: `HTTP ${res.status}` };
  } catch (err) {
    return { synced: false, source: "local-sqlite-only", error: err.message };
  }
}

/**
 * Deterministic, human-voiced ESPN breakfast desk commentary grounded 100% in real DSP facts.
 */
function buildDeterministicCommentary(session, events) {
  const loudest = events.reduce(
    (a, b) => (b.metrics.splPeakDb > a.metrics.splPeakDb ? b : a),
    events[0]
  );
  const longest = events.reduce(
    (a, b) => (b.durationSec > a.durationSec ? b : a),
    events[0]
  );
  const recurring = events.find((e) => e.pineconeMatch && e.pineconeMatch.score >= 0.88);
  const uncertain = events.find((e) => e.needsHumanCall);
  const overridden = events.find((e) => e.humanOverridden);

  const loudestTitle = EVENT_LABELS[loudest.label] || loudest.label;
  const headline = `${loudest.metrics.splPeakDb.toFixed(1)} DB ${loudestTitle.toUpperCase()} STEALS THE OVERNIGHT TAPE`;
  const subhead = `${events.length} room events logged across ${session.durationSec.toFixed(1)}s of tape, topped by a ${longest.durationSec.toFixed(1)}s rally at ${longest.clockLabel}.`;

  const lines = [
    {
      speaker: "Rex Vance",
      role: "Play-by-play",
      clock: loudest.clockLabel,
      startSec: loudest.startSec,
      text: `Good morning from the nightstand booth. The headline play hits at ${loudest.clockLabel}: a ${loudestTitle.toLowerCase()} peaking at ${loudest.metrics.splPeakDb.toFixed(1)} dB around ${loudest.metrics.centroidHz} Hz, ${Math.round(loudest.metrics.splPeakDb - session.ambientSplDb)} dB clear of the ${session.ambientSplDb.toFixed(0)} dB room floor.`,
    },
    {
      speaker: "Margo Hale",
      role: "Acoustic analyst",
      clock: longest.clockLabel,
      startSec: longest.startSec,
      text: `Stamina mattered just as much as volume. The longest rally ran ${longest.durationSec.toFixed(1)} seconds starting at ${longest.clockLabel}, with a ${session.boxScore.longestDramaticPauseSec.toFixed(1)}-second Longest Dramatic Pause setting up the late-night finish.`,
    },
  ];

  if (recurring) {
    const matchName = recurring.pineconeMatch.note || recurring.pineconeMatch.labelDisplay;
    lines.push({
      speaker: "Margo Hale",
      role: "Acoustic analyst",
      clock: recurring.clockLabel,
      startSec: recurring.startSec,
      text: `Look at the vector board at ${recurring.clockLabel}. That ${recurring.metrics.centroidHz} Hz ring matched ${recurring.pineconeMatch.nightDate}'s ${matchName} at ${recurring.pineconeMatch.score.toFixed(2)} cosine similarity. Same culprit, new night.`,
    });
  }

  if (overridden) {
    lines.push({
      speaker: "Rex Vance",
      role: "Play-by-play",
      clock: overridden.clockLabel,
      startSec: overridden.startSec,
      text: `Booth review is official at ${overridden.clockLabel}: you called it ${EVENT_LABELS[overridden.label] || overridden.label}${overridden.humanNote ? ` (${overridden.humanNote})` : ""}. Vector memory updated for tomorrow morning's tape.`,
    });
  } else if (uncertain) {
    lines.push({
      speaker: "Rex Vance",
      role: "Play-by-play",
      clock: uncertain.clockLabel,
      startSec: uncertain.startSec,
      text: `One play still sits under review. At ${uncertain.clockLabel}, Jev split its probabilities with ${(uncertain.confidence * 100).toFixed(0)}% top confidence. Open the film table and make the call yourself.`,
    });
  }

  return { headline, subhead, lines, source: "local-broadcast-desk" };
}

/**
 * Generate 2-anchor morning highlight commentary via Ollama Cloud Sprite Connector.
 */
export async function generateCommentaryWithOllama(session, events, connector) {
  if (connector?.connected && connector.gatewayBaseUrl) {
    const facts = {
      nightDate: session.nightDate,
      ambientSplDb: session.ambientSplDb,
      boxScore: session.boxScore,
      events: events.map((e) => ({
        clock: e.clockLabel,
        startSec: e.startSec,
        durationSec: e.durationSec,
        label: EVENT_LABELS[e.label] || e.label,
        splPeakDb: e.metrics.splPeakDb,
        centroidHz: e.metrics.centroidHz,
        confidence: e.confidence,
        needsHumanCall: e.needsHumanCall,
        humanOverridden: e.humanOverridden,
        humanNote: e.humanNote || null,
        recurringMatch: e.pineconeMatch
          ? `${e.pineconeMatch.nightDate} ${e.pineconeMatch.note || e.pineconeMatch.labelDisplay} (${e.pineconeMatch.score})`
          : null,
      })),
    };

    const prompt = [
      "You are the morning breakfast highlight desk for SnoreCenter.",
      "Write dead-serious, witty sports broadcast commentary between Rex Vance (Play-by-play) and Margo Hale (Acoustic analyst).",
      "RULES:",
      "1. Cite ONLY exact clocks, dB values, Hz values, durations, and recurring matches from the JSON facts.",
      "2. Strictly entertainment: NEVER mention sleep apnea, medical diagnoses, or health advice. Use 'Longest Dramatic Pause' for silence gaps.",
      "3. Return strict JSON: { \"headline\": string (<=10 words, crisp), \"subhead\": string (1 sentence), \"lines\": [ { \"speaker\": \"Rex Vance\"|\"Margo Hale\", \"role\": string, \"clock\": string, \"startSec\": number, \"text\": string (1-2 sharp sentences) } ] } with 3 to 4 lines.",
      `FACTS:\n${JSON.stringify(facts)}`,
    ].join("\n");

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 14000);
      const model = process.env.OLLAMA_MODEL || "llama3.3";
      const res = await fetch(`${connector.gatewayBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || "";
        const parsed = JSON.parse(content);
        if (parsed.headline && Array.isArray(parsed.lines) && parsed.lines.length >= 2) {
          // Guardrail: reject any stray medical phrasing
          const blob = JSON.stringify(parsed).toLowerCase();
          if (!/(apnea|diagnos|hypopnea|disorder|clinical)/.test(blob)) {
            return {
              headline: String(parsed.headline).slice(0, 96),
              subhead: String(parsed.subhead || "").slice(0, 180),
              lines: parsed.lines.slice(0, 4).map((l) => ({
                speaker: l.speaker === "Margo Hale" ? "Margo Hale" : "Rex Vance",
                role: l.speaker === "Margo Hale" ? "Acoustic analyst" : "Play-by-play",
                clock: String(l.clock || events[0].clockLabel),
                startSec: Number.isFinite(Number(l.startSec)) ? Number(l.startSec) : 0,
                text: String(l.text || "").slice(0, 320),
              })),
              source: `ollama-sprite-gateway (${model})`,
            };
          }
        }
      }
    } catch (err) {
      const fallback = buildDeterministicCommentary(session, events);
      return { ...fallback, gatewayFallbackReason: err.message };
    }
  }

  return buildDeterministicCommentary(session, events);
}

/**
 * Synthesize dual-anchor voiced broadcast commentary (Rex Vance + Margo Hale)
 * via ElevenLabs Sprite Connector. Concatenates per-line MP3 clips cleanly with zero
 * local API keys; degrades honestly to native room WAV replay when offline.
 */
export async function synthesizeHighlightAudio(lines, audioDir, sessionId, connector) {
  if (!connector?.connected || !connector.gatewayBaseUrl) {
    return {
      filename: null,
      source: "native-room-replay",
      note: "Room WAV plays directly in browser; attach ElevenLabs Sprite Connector for voiced dual-anchor mix.",
    };
  }

  const rexVoice = process.env.ELEVENLABS_REX_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
  const margoVoice = process.env.ELEVENLABS_MARGO_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
  const base = connector.gatewayBaseUrl.replace(/\/$/, "");

  try {
    const mp3Buffers = [];
    for (const line of (lines || []).slice(0, 4)) {
      const voiceId = line.speaker === "Margo Hale" ? margoVoice : rexVoice;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 18000);
      const res = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: String(line.text || "").slice(0, 360),
          model_id: modelId,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return { filename: null, source: "native-room-replay", error: `HTTP ${res.status}` };
      }
      mp3Buffers.push(Buffer.from(await res.arrayBuffer()));
    }

    if (mp3Buffers.length === 0) {
      return { filename: null, source: "native-room-replay" };
    }

    const combined = Buffer.concat(mp3Buffers);
    const filename = `${sessionId}-broadcast.mp3`;
    await fsp.mkdir(audioDir, { recursive: true });
    await fsp.writeFile(path.join(audioDir, filename), combined);
    return {
      filename,
      source: "elevenlabs-sprite-gateway (dual-anchor)",
      bytes: combined.length,
      linesVoiced: mp3Buffers.length,
    };
  } catch (err) {
    return { filename: null, source: "native-room-replay", error: err.message };
  }
}

/**
 * Archive Breakfast Box Score HTML + JSON to Box Sprite Connector (/Highlights/),
 * or write local self-contained export when Box Connector is offline.
 */
export async function archiveBreakfastToBox(session, htmlCard, exportsDir, connector) {
  await fsp.mkdir(exportsDir, { recursive: true });
  const localFile = `breakfast-${session.id}.html`;
  const localPath = path.join(exportsDir, localFile);
  await fsp.writeFile(localPath, htmlCard, "utf8");

  if (connector?.connected && connector.gatewayBaseUrl) {
    try {
      const base = connector.gatewayBaseUrl.replace(/\/$/, "");
      // Find or create Highlights folder under Box root (0)
      let folderId = process.env.BOX_HIGHLIGHTS_FOLDER_ID || "0";
      const listRes = await fetch(`${base}/2.0/folders/0/items?limit=50`, {
        headers: { Accept: "application/json" },
      });
      if (listRes.ok) {
        const listData = await listRes.json();
        const existing = (listData.entries || []).find(
          (e) => e.type === "folder" && e.name.toLowerCase() === "highlights"
        );
        if (existing) {
          folderId = existing.id;
        } else {
          const mkRes = await fetch(`${base}/2.0/folders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Highlights", parent: { id: "0" } }),
          });
          if (mkRes.ok) {
            const mk = await mkRes.json();
            folderId = mk.id;
          }
        }
      }

      const form = new FormData();
      const fileName = `SnoreCenter-${session.nightDate}-${session.id.slice(-6)}.html`;
      form.append("attributes", JSON.stringify({ name: fileName, parent: { id: folderId } }));
      form.append("file", new Blob([htmlCard], { type: "text/html" }), fileName);

      const uploadRes = await fetch(`${base}/2.0/files/content`, {
        method: "POST",
        body: form,
      });

      if (uploadRes.ok) {
        const uploaded = await uploadRes.json();
        const entry = uploaded.entries?.[0] || uploaded;
        return {
          archivedAt: new Date().toISOString(),
          mode: "box-sprite-gateway",
          folder: "/Highlights",
          fileId: entry.id || null,
          fileName,
          localCardUrl: `/api/sessions/${encodeURIComponent(session.id)}/card`,
        };
      }
      return {
        archivedAt: new Date().toISOString(),
        mode: "local-export-fallback",
        folder: "/Highlights (pending Box upload)",
        fileName: localFile,
        localCardUrl: `/api/sessions/${encodeURIComponent(session.id)}/card`,
        error: `Box upload HTTP ${uploadRes.status}`,
      };
    } catch (err) {
      return {
        archivedAt: new Date().toISOString(),
        mode: "local-export-fallback",
        folder: "local/exports",
        fileName: localFile,
        localCardUrl: `/api/sessions/${encodeURIComponent(session.id)}/card`,
        error: err.message,
      };
    }
  }

  return {
    archivedAt: new Date().toISOString(),
    mode: "local-export",
    folder: "data/exports",
    fileName: localFile,
    localCardUrl: `/api/sessions/${encodeURIComponent(session.id)}/card`,
  };
}

/**
 * List read-only Fly.io Sprite checkpoints mounted at `/.sprite/checkpoints/`,
 * plus local SQLite snapshots when outside a Sprite.
 */
export async function listCheckpoints(localCheckpointsDir) {
  const results = [];

  if (fs.existsSync(SPRITE_CHECKPOINTS_DIR)) {
    try {
      const entries = await fsp.readdir(SPRITE_CHECKPOINTS_DIR, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const full = path.join(SPRITE_CHECKPOINTS_DIR, ent.name);
        const stat = await fsp.stat(full);
        results.push({
          id: ent.name,
          mountPath: full,
          mode: "sprite-cow-checkpoint",
          createdAt: stat.mtime.toISOString(),
          readOnly: true,
        });
      }
    } catch {
      // Ignore permission errors
    }
  }

  if (fs.existsSync(localCheckpointsDir)) {
    try {
      const entries = await fsp.readdir(localCheckpointsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
        const raw = await fsp.readFile(path.join(localCheckpointsDir, ent.name), "utf8");
        results.push(JSON.parse(raw));
      }
    } catch {
      // Ignore malformed local checkpoints
    }
  }

  return results.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
}

/**
 * Create a non-interrupting CoW Sprite checkpoint (`sprite-env checkpoint create`),
 * or a local SQLite snapshot file when outside a Sprite.
 */
export async function createCheckpoint(comment, dbPath, localCheckpointsDir) {
  const safeComment = String(comment || "SnoreCenter morning snapshot").slice(0, 80);

  if (isInsideSprite()) {
    try {
      const { stdout } = await execFileAsync(
        "sprite-env",
        ["checkpoint", "create", "--comment", safeComment],
        { timeout: 15000 }
      );
      const idMatch = stdout.match(/(v\d+|[a-zA-Z0-9_-]{6,})/);
      return {
        id: idMatch ? idMatch[1] : `cp_${Date.now()}`,
        comment: safeComment,
        mode: "sprite-cow-checkpoint",
        createdAt: new Date().toISOString(),
        rawOutput: stdout.trim().slice(0, 160),
      };
    } catch (err) {
      // Fall through to local snapshot with explicit reason
      const snap = await createLocalSnapshot(safeComment, dbPath, localCheckpointsDir, err.message);
      return snap;
    }
  }

  return createLocalSnapshot(safeComment, dbPath, localCheckpointsDir);
}

async function createLocalSnapshot(comment, dbPath, localCheckpointsDir, spriteError = null) {
  await fsp.mkdir(localCheckpointsDir, { recursive: true });
  const id = `snap-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const dbCopy = path.join(localCheckpointsDir, `${id}.sqlite`);
  if (fs.existsSync(dbPath)) {
    await fsp.copyFile(dbPath, dbCopy);
  }
  const meta = {
    id,
    comment,
    mode: "local-sqlite-snapshot",
    createdAt: new Date().toISOString(),
    readOnly: true,
    spriteError: spriteError || undefined,
  };
  await fsp.writeFile(path.join(localCheckpointsDir, `${id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}
