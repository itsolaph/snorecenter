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
  { key: "openrouter", name: "OpenRouter", role: "Zero-key LLM broadcast desk fallback through Sprites Gateway", matchers: ["openrouter"] },
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
      const connId = matched.connection_id || matched.id || null;
      const providerSlug = matched.provider || spec.key;
      const baseUrl =
        matched.gateway_base_url ||
        matched.base_url ||
        (providerSlug && connId
          ? `${SPRITE_API_BASE.replace(/\/$/, "")}/v1/gateway/${providerSlug}/${connId}`
          : null);
      connectors[spec.key] = {
        key: spec.key,
        name: spec.name,
        role: spec.role,
        connected: Boolean(baseUrl),
        mode: baseUrl ? "sprite-gateway" : "pending-setup",
        gatewayBaseUrl: baseUrl,
        connectionId: connId,
        provider: providerSlug,
        scopes: Array.isArray(matched.scopes)
          ? matched.scopes
          : typeof matched.scopes === "string" && matched.scopes.trim()
            ? matched.scopes.split(",").map((s) => s.trim())
            : [],
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

let cachedPineconeIndex = null;
let cachedPineconeIndexAt = 0;

async function resolvePineconeIndexName(connector) {
  if (process.env.PINECONE_INDEX) return process.env.PINECONE_INDEX;
  const now = Date.now();
  if (cachedPineconeIndex && now - cachedPineconeIndexAt < 30000) return cachedPineconeIndex;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${connector.gatewayBaseUrl.replace(/\/$/, "")}/indexes`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const list = data.indexes || [];
      const exact = list.find((idx) => idx.name === "snorecenter-acoustic" || idx.dimension === 32);
      if (exact?.name) {
        cachedPineconeIndex = exact.name;
        cachedPineconeIndexAt = now;
        return exact.name;
      }
    }
  } catch {
    // Fall back to default name
  }
  return "snorecenter-acoustic";
}

/**
 * Query recurring sound fingerprints across prior nights via Pinecone Sprite Connector:
 * 1. If a 32-dim serverless index exists (`GET /indexes`), queries `/indexes/<name>/query`.
 * 2. Combines local 32-dim FFT cosine top candidates with live Pinecone Inference `/rerank`
 *    (`bge-reranker-v2-m3`) through the zero-key Sprites Connector gateway (works with zero
 *    pre-created indexes and proves real Pinecone Connector round-trips on every run).
 */
export async function queryRecurringSound(vector, localSignatures, connector, eventContext = null) {
  let pineconeResult = null;

  if (connector?.connected && connector.gatewayBaseUrl) {
    const base = connector.gatewayBaseUrl.replace(/\/$/, "");
    try {
      const indexName = await resolvePineconeIndexName(connector);
      if (indexName) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const namespace = process.env.PINECONE_NAMESPACE || "nightwatch";
        const res = await fetch(
          `${base}/indexes/${encodeURIComponent(indexName)}/query`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              vector,
              topK: 3,
              includeMetadata: true,
              namespace,
            }),
            signal: ctrl.signal,
          }
        );
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
      }
    } catch {
      // Continue to Pinecone Inference /rerank + local FFT cosine mirror
    }
  }

  if (pineconeResult) return pineconeResult;

  // Compute local SQLite 32-dim FFT cosine similarity shortlist
  const ranked = localSignatures
    .map((sig) => ({
      sig,
      score: Number(cosineSimilarity(vector, sig.vector).toFixed(3)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  const best = ranked[0];
  if (!best || best.score < 0.88) return null;

  // Cross-verify shortlist via live Pinecone Inference /rerank through zero-key Sprites Gateway
  if (connector?.connected && connector.gatewayBaseUrl && ranked.length >= 1) {
    try {
      const base = connector.gatewayBaseUrl.replace(/\/$/, "");
      const m = eventContext?.metrics || {};
      const queryText = `Overnight room sound ${m.centroidHz || 0} Hz peak ${m.splPeakDb || 0} dB duration ${m.durationSec || 0}s low=${m.lowRatio || 0} mid=${m.midRatio || 0} high=${m.highRatio || 0}`;
      const documents = ranked.map((r) => ({
        id: r.sig.id,
        text: `${r.sig.nightDate} ${r.sig.note || EVENT_LABELS[r.sig.label] || r.sig.label} ${r.sig.centroidHz} Hz peak ${r.sig.splPeakDb} dB`,
      }));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const rres = await fetch(`${base}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Pinecone-API-Version": "2025-04",
        },
        body: JSON.stringify({
          model: "bge-reranker-v2-m3",
          query: queryText,
          top_n: Math.min(2, documents.length),
          documents,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (rres.ok) {
        const rdata = await rres.json();
        const topRerank = rdata.data?.[0];
        const chosen =
          (topRerank && ranked.find((r) => r.sig.id === topRerank.document?.id)) || best;
        return {
          id: chosen.sig.id,
          label: chosen.sig.label,
          labelDisplay: EVENT_LABELS[chosen.sig.label] || chosen.sig.label,
          nightDate: chosen.sig.nightDate,
          clockLabel: chosen.sig.clockLabel,
          note: chosen.sig.note || "",
          score: chosen.score,
          rerankScore: topRerank ? Number(Number(topRerank.score || 0).toFixed(3)) : null,
          source: "pinecone-sprite-gateway (bge-reranker-v2-m3)",
        };
      }
    } catch {
      // Fall back cleanly to local cosine mirror
    }
  }

  return {
    id: best.sig.id,
    label: best.sig.label,
    labelDisplay: EVENT_LABELS[best.sig.label] || best.sig.label,
    nightDate: best.sig.nightDate,
    clockLabel: best.sig.clockLabel,
    note: best.sig.note || "",
    score: best.score,
    source: connector?.connected ? "pinecone-local-mirror" : "local-cosine-memory",
  };
}

/**
 * Upsert a confirmed or human-labeled acoustic vector into Pinecone Sprite Connector
 * under `/indexes/<index>/vectors/upsert`.
 */
export async function upsertSoundToPinecone(signature, connector) {
  if (!connector?.connected || !connector.gatewayBaseUrl) {
    return { synced: false, source: "local-sqlite-only" };
  }
  try {
    const indexName = await resolvePineconeIndexName(connector);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const namespace = process.env.PINECONE_NAMESPACE || "nightwatch";
    const res = await fetch(
      `${connector.gatewayBaseUrl.replace(/\/$/, "")}/indexes/${encodeURIComponent(indexName)}/vectors/upsert`,
      {
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
      }
    );
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
 * Generate 2-anchor morning highlight commentary via Ollama Cloud Sprite Connector
 * (or OpenRouter Sprite Connector when Ollama is not attached yet), zero raw keys.
 */
export async function generateCommentaryWithOllama(session, events, connector, openrouterConnector = null) {
  const activeConn =
    connector?.connected && connector.gatewayBaseUrl
      ? { ...connector, kind: "ollama" }
      : openrouterConnector?.connected && openrouterConnector.gatewayBaseUrl
        ? { ...openrouterConnector, kind: "openrouter" }
        : null;

  if (activeConn) {
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
      "Write deadpan, dry-witted ESPN SportsCenter commentary between Rex Vance (Play-by-play) and Margo Hale (Acoustic analyst).",
      "STYLE: Treat ordinary bedroom noises like Game 7 film study. Zero exclamation-mark hype, zero buzzwords like 'electrifying' or 'game-changer'. Crisp, understated broadcast voice.",
      "RULES:",
      "1. Cite ONLY exact clocks, dB values, Hz values, durations, and recurring matches from the JSON facts.",
      "2. Strictly entertainment: NEVER mention sleep apnea, medical diagnoses, or health advice. Use 'Longest Dramatic Pause' for silence gaps.",
      "3. Return strict JSON: { \"headline\": string (<=9 words, punchy sports desk title citing peak dB), \"subhead\": string (1 crisp sentence), \"lines\": [ { \"speaker\": \"Rex Vance\"|\"Margo Hale\", \"role\": string, \"clock\": string, \"startSec\": number, \"text\": string (1-2 dry, punchy sentences) } ] } with 3 to 4 lines alternating speakers.",
      `FACTS:\n${JSON.stringify(facts)}`,
    ].join("\n");

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 18000);
      const model =
        activeConn.kind === "ollama"
          ? process.env.OLLAMA_MODEL || "llama3.3"
          : process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
      const res = await fetch(`${activeConn.gatewayBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
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
              source: `${activeConn.kind}-sprite-gateway (${model})`,
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
 * via ElevenLabs Sprite Connector OR OpenRouter Sprite Connector (`elevenlabs/eleven-v4`),
 * with zero raw API keys inside the Sprite.
 */
export async function synthesizeHighlightAudio(lines, audioDir, sessionId, connector, openrouterConnector = null) {
  const usableLines = (lines || []).slice(0, 4);
  if (usableLines.length === 0) {
    return { filename: null, source: "native-room-replay" };
  }

  // Path 1: Direct ElevenLabs Sprite Connector
  if (connector?.connected && connector.gatewayBaseUrl) {
    const rexVoice = process.env.ELEVENLABS_REX_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
    const margoVoice = process.env.ELEVENLABS_MARGO_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
    const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
    const base = connector.gatewayBaseUrl.replace(/\/$/, "");

    try {
      const mp3Buffers = [];
      for (const line of usableLines) {
        const voiceId = line.speaker === "Margo Hale" ? margoVoice : rexVoice;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 18000);
        const res = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text: String(line.text || "").slice(0, 360), model_id: modelId }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          return { filename: null, source: "native-room-replay", error: `HTTP ${res.status}` };
        }
        mp3Buffers.push(Buffer.from(await res.arrayBuffer()));
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

  // Path 2: OpenRouter Sprite Connector -> ElevenLabs v4 dual-anchor TTS (24kHz s16le PCM -> ffmpeg MP3)
  if (openrouterConnector?.connected && openrouterConnector.gatewayBaseUrl) {
    const base = openrouterConnector.gatewayBaseUrl.replace(/\/$/, "");
    const model = process.env.OPENROUTER_TTS_MODEL || "elevenlabs/eleven-v4";
    const pausePcm = Buffer.alloc(24000 * 2 * 0.28); // 280ms studio breath between anchors

    try {
      const pcmChunks = [];
      for (let i = 0; i < usableLines.length; i++) {
        const line = usableLines[i];
        const voice = line.speaker === "Margo Hale" ? "jessica" : "chris";
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 22000);
        const res = await fetch(`${base}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            voice,
            input: String(line.text || "").slice(0, 320),
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          return { filename: null, source: "native-room-replay", error: `OpenRouter TTS HTTP ${res.status}` };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0) {
          pcmChunks.push(buf);
          if (i < usableLines.length - 1) pcmChunks.push(pausePcm);
        }
      }

      if (pcmChunks.length === 0) {
        return { filename: null, source: "native-room-replay" };
      }

      const mergedPcm = Buffer.concat(pcmChunks);
      await fsp.mkdir(audioDir, { recursive: true });
      const tmpPcm = path.join(audioDir, `${sessionId}-booth.pcm`);
      const mp3Name = `${sessionId}-broadcast.mp3`;
      const mp3Path = path.join(audioDir, mp3Name);
      await fsp.writeFile(tmpPcm, mergedPcm);

      try {
        await execFileAsync(
          "ffmpeg",
          ["-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", tmpPcm, "-codec:a", "libmp3lame", "-b:a", "128k", mp3Path],
          { timeout: 25000 }
        );
        await fsp.rm(tmpPcm, { force: true }).catch(() => {});
        const stat = await fsp.stat(mp3Path);
        return {
          filename: mp3Name,
          source: `openrouter-sprite-gateway (${model}, chris+jessica)`,
          bytes: stat.size,
          linesVoiced: usableLines.length,
        };
      } catch {
        // Fallback: wrap raw s16le 24kHz PCM in a standard WAV header if ffmpeg unavailable
        await fsp.rm(tmpPcm, { force: true }).catch(() => {});
        const wavName = `${sessionId}-broadcast.wav`;
        const wavBuf = Buffer.alloc(44 + mergedPcm.length);
        wavBuf.write("RIFF", 0, "ascii");
        wavBuf.writeUInt32LE(36 + mergedPcm.length, 4);
        wavBuf.write("WAVE", 8, "ascii");
        wavBuf.write("fmt ", 12, "ascii");
        wavBuf.writeUInt32LE(16, 16);
        wavBuf.writeUInt16LE(1, 20);
        wavBuf.writeUInt16LE(1, 22);
        wavBuf.writeUInt32LE(24000, 24);
        wavBuf.writeUInt32LE(48000, 28);
        wavBuf.writeUInt16LE(2, 32);
        wavBuf.writeUInt16LE(16, 34);
        wavBuf.write("data", 36, "ascii");
        wavBuf.writeUInt32LE(mergedPcm.length, 40);
        mergedPcm.copy(wavBuf, 44);
        await fsp.writeFile(path.join(audioDir, wavName), wavBuf);
        return {
          filename: wavName,
          source: `openrouter-sprite-gateway (${model}, chris+jessica)`,
          bytes: wavBuf.length,
          linesVoiced: usableLines.length,
        };
      }
    } catch (err) {
      return { filename: null, source: "native-room-replay", error: err.message };
    }
  }

  return {
    filename: null,
    source: "native-room-replay",
    note: "Room WAV plays directly in browser; attach ElevenLabs or OpenRouter Sprite Connector for voiced dual-anchor mix.",
  };
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

function resolveSpriteEnvBin() {
  if (fs.existsSync("/.sprite/bin/sprite-env")) return "/.sprite/bin/sprite-env";
  return "sprite-env";
}

/**
 * List Fly.io Sprite CoW checkpoints (via `sprite-env checkpoint list` and
 * read-only mounts at `/.sprite/checkpoints/`), plus local SQLite snapshots.
 */
export async function listCheckpoints(localCheckpointsDir) {
  const byId = new Map();

  if (isInsideSprite()) {
    try {
      const { stdout } = await execFileAsync(
        resolveSpriteEnvBin(),
        ["checkpoint", "list"],
        { timeout: 6000 }
      );
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || !item.id || item.id === "Current") continue;
          byId.set(item.id, {
            id: item.id,
            comment: item.comment || "Fly.io Sprite CoW checkpoint",
            mode: "sprite-cow-checkpoint",
            createdAt: item.create_time || new Date().toISOString(),
            readOnly: true,
          });
        }
      }
    } catch {
      // Fall through to directory mount check
    }
  }

  if (fs.existsSync(SPRITE_CHECKPOINTS_DIR)) {
    try {
      const entries = await fsp.readdir(SPRITE_CHECKPOINTS_DIR, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || byId.has(ent.name)) continue;
        const full = path.join(SPRITE_CHECKPOINTS_DIR, ent.name);
        const stat = await fsp.stat(full);
        byId.set(ent.name, {
          id: ent.name,
          mountPath: full,
          comment: "Read-only checkpoint mount",
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
        const item = JSON.parse(raw);
        if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
      }
    } catch {
      // Ignore malformed local checkpoints
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 8);
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
        resolveSpriteEnvBin(),
        ["checkpoint", "create", "--comment", safeComment],
        { timeout: 15000 }
      );
      const idMatch = stdout.match(/\b(v\d+)\b/);
      return {
        id: idMatch ? idMatch[1] : `cp_${Date.now()}`,
        comment: safeComment,
        mode: "sprite-cow-checkpoint",
        createdAt: new Date().toISOString(),
        readOnly: true,
      };
    } catch (err) {
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
