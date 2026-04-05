/**
 * Resume Bullet Similarity — semantic modification distance scoring.
 *
 * Computes how much a user-edited bullet diverges from the system-generated
 * original.  Used to track bullet quality: the "70%+ bullets usable with
 * <=50% semantic modification" acceptance criterion.
 *
 * Three independent metrics are provided and combined into a single score:
 *
 *   1. Normalized Levenshtein edit distance (character-level)
 *   2. Token-level Jaccard similarity (word overlap)
 *   3. Embedding cosine similarity (optional; delegates to embeddings.mjs)
 *
 * All scores are normalized to [0, 1] where:
 *   1.0 = identical (no modification)
 *   0.0 = completely different
 *
 * The "modification distance" is (1 - similarity).
 * A bullet with modificationDistance <= 0.5 is considered "usable".
 *
 * Design notes
 * ────────────
 * • Pure module — deterministic functions with no side effects (except the
 *   optional embedding path which delegates to embeddings.mjs).
 * • Embedding calls are isolated behind computeEmbeddingSimilarity() and
 *   never invoked by the default scoring path (which is fully offline).
 * • Reuses the existing embeddings.mjs for vector operations and API calls
 *   instead of duplicating that logic.
 * • The combined score uses a weighted blend that can be tuned.
 * • Compatible with the BulletProposal system — scores can be stored
 *   alongside proposal status for quality tracking.
 *
 * @module resumeBulletSimilarity
 */

import { randomUUID } from "node:crypto";
import {
  generateEmbeddings,
  cosineSimilarity as embeddingCosineSimilarity
} from "./embeddings.mjs";
import {
  readQualityTracking,
  saveQualityTracking,
} from "./blob.mjs";

// ─── Configuration ─────────────────────────────────────────────────────────────

/** Default weights for combining metrics into a single similarity score. */
export const DEFAULT_WEIGHTS = {
  levenshtein: 0.4,
  tokenJaccard: 0.6
};

/** Weights when embedding similarity is available. */
export const EMBEDDING_WEIGHTS = {
  levenshtein: 0.2,
  tokenJaccard: 0.3,
  embedding: 0.5
};

/** Modification distance threshold: bullets at or below this are "usable". */
export const USABLE_THRESHOLD = 0.5;

// ─── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a bullet string for comparison: lowercase, collapse whitespace,
 * strip leading bullet markers and trailing punctuation differences.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeBullet(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/^[\s\-•·▪▸►–—]+/, "")   // strip leading bullet chars
    .replace(/\s+/g, " ")               // collapse whitespace
    .replace(/[.,;:!]+$/, "")           // strip trailing punctuation
    .trim();
}

/**
 * Tokenize a normalized string into words for Jaccard comparison.
 * Removes stop words that add noise to similarity but not meaning.
 *
 * @param {string} text — already normalized
 * @returns {string[]}
 */
export function tokenize(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.filter((t) => !STOP_WORDS.has(t));
}

/** Minimal stop word set — just functional words, not domain terms. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "were", "are", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "that", "which",
  "who", "whom", "this", "these", "those", "it", "its", "as", "if",
  "not", "no", "so", "up", "out", "than", "into", "over", "also"
]);

// ─── Levenshtein Edit Distance ─────────────────────────────────────────────────

/**
 * Compute the Levenshtein edit distance between two strings using a
 * space-optimized single-row DP approach.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} — integer edit distance
 */
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Ensure a is the shorter string for space efficiency
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Single-row DP (O(min(m,n)) space)
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);

  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,      // insertion
        prev[i] + 1,          // deletion
        prev[i - 1] + cost    // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

/**
 * Normalized Levenshtein similarity: 1 - (distance / maxLength).
 * Returns 1.0 for identical strings, 0.0 for completely different strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} — [0, 1]
 */
export function levenshteinSimilarity(a, b) {
  const na = normalizeBullet(a);
  const nb = normalizeBullet(b);

  if (na === nb) return 1.0;

  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;

  const distance = levenshteinDistance(na, nb);
  return 1.0 - distance / maxLen;
}

// ─── Token Jaccard Similarity ──────────────────────────────────────────────────

/**
 * Jaccard similarity over word tokens: |intersection| / |union|.
 * Uses normalized, stop-word-filtered tokens.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} — [0, 1]
 */
export function tokenJaccardSimilarity(a, b) {
  const tokensA = tokenize(normalizeBullet(a));
  const tokensB = tokenize(normalizeBullet(b));

  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

// ─── Embedding Cosine Similarity (Optional) ────────────────────────────────────

/**
 * Compute embedding-based cosine similarity between two bullet strings.
 * Delegates to the shared embeddings.mjs module for vector generation and
 * cosine computation.
 *
 * Returns null if embeddings are unavailable (API key missing, network error, etc.)
 *
 * @param {string} original — system-generated bullet
 * @param {string} edited   — user-edited bullet
 * @returns {Promise<number|null>} — similarity [0, 1] or null
 */
export async function computeEmbeddingSimilarity(original, edited) {
  const embeddings = await generateEmbeddings([
    normalizeBullet(original),
    normalizeBullet(edited)
  ]);

  if (!embeddings || embeddings.length < 2) return null;

  const similarity = embeddingCosineSimilarity(embeddings[0], embeddings[1]);
  // Clamp to [0, 1] since text embeddings can occasionally produce tiny negatives
  return Math.max(0, Math.min(1, similarity));
}

// ─── Combined Scoring ──────────────────────────────────────────────────────────

/**
 * Compute the combined similarity score between two bullet strings using
 * offline metrics only (no API calls).
 *
 * @param {string} original — system-generated bullet
 * @param {string} edited   — user-edited bullet
 * @param {object} [weights] — optional weight overrides
 * @returns {object} — { similarity, modificationDistance, isUsable, metrics }
 */
export function computeBulletSimilarity(original, edited, weights = DEFAULT_WEIGHTS) {
  const levSim = levenshteinSimilarity(original, edited);
  const jaccardSim = tokenJaccardSimilarity(original, edited);

  const wLev = weights.levenshtein ?? DEFAULT_WEIGHTS.levenshtein;
  const wJac = weights.tokenJaccard ?? DEFAULT_WEIGHTS.tokenJaccard;
  const totalWeight = wLev + wJac;

  const similarity = totalWeight > 0
    ? (wLev * levSim + wJac * jaccardSim) / totalWeight
    : 0;

  const modificationDistance = 1.0 - similarity;

  return {
    similarity: _round(similarity),
    modificationDistance: _round(modificationDistance),
    isUsable: modificationDistance <= USABLE_THRESHOLD,
    metrics: {
      levenshtein: _round(levSim),
      tokenJaccard: _round(jaccardSim)
    }
  };
}

/**
 * Compute the combined similarity score with optional embedding similarity.
 * Falls back to offline-only scoring if embeddings are unavailable.
 *
 * @param {string} original — system-generated bullet
 * @param {string} edited   — user-edited bullet
 * @returns {Promise<object>} — { similarity, modificationDistance, isUsable, metrics }
 */
export async function computeBulletSimilarityWithEmbeddings(original, edited) {
  const levSim = levenshteinSimilarity(original, edited);
  const jaccardSim = tokenJaccardSimilarity(original, edited);
  const embeddingSim = await computeEmbeddingSimilarity(original, edited);

  if (embeddingSim !== null) {
    const w = EMBEDDING_WEIGHTS;
    const totalWeight = w.levenshtein + w.tokenJaccard + w.embedding;
    const similarity = (
      w.levenshtein * levSim +
      w.tokenJaccard * jaccardSim +
      w.embedding * embeddingSim
    ) / totalWeight;

    const modificationDistance = 1.0 - similarity;

    return {
      similarity: _round(similarity),
      modificationDistance: _round(modificationDistance),
      isUsable: modificationDistance <= USABLE_THRESHOLD,
      metrics: {
        levenshtein: _round(levSim),
        tokenJaccard: _round(jaccardSim),
        embedding: _round(embeddingSim)
      }
    };
  }

  // Fallback to offline-only scoring
  return computeBulletSimilarity(original, edited);
}

// ─── Batch Scoring ─────────────────────────────────────────────────────────────

/**
 * Score an array of bullet pairs (original, edited) and compute aggregate
 * quality metrics.
 *
 * @param {Array<{original: string, edited: string}>} pairs
 * @returns {object} — { scores, aggregate }
 */
export function scoreBulletBatch(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return {
      scores: [],
      aggregate: _emptyAggregate()
    };
  }

  const scores = pairs.map(({ original, edited }) =>
    computeBulletSimilarity(original, edited)
  );

  return { scores, aggregate: _computeAggregate(scores) };
}

/**
 * Score a batch with embedding similarity included. Fetches embeddings in a
 * single batch call for efficiency, then computes per-pair scores.
 *
 * @param {Array<{original: string, edited: string}>} pairs
 * @returns {Promise<object>} — { scores, aggregate }
 */
export async function scoreBulletBatchWithEmbeddings(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return scoreBulletBatch(pairs);
  }

  // Batch all texts for a single embedding API call
  const allTexts = [];
  for (const { original, edited } of pairs) {
    allTexts.push(normalizeBullet(original));
    allTexts.push(normalizeBullet(edited));
  }

  const embeddings = await generateEmbeddings(allTexts);

  const scores = pairs.map(({ original, edited }, i) => {
    const levSim = levenshteinSimilarity(original, edited);
    const jaccardSim = tokenJaccardSimilarity(original, edited);

    if (embeddings && embeddings.length >= (i + 1) * 2) {
      const embeddingSim = Math.max(
        0,
        Math.min(1, embeddingCosineSimilarity(embeddings[i * 2], embeddings[i * 2 + 1]))
      );

      const w = EMBEDDING_WEIGHTS;
      const totalWeight = w.levenshtein + w.tokenJaccard + w.embedding;
      const similarity = (
        w.levenshtein * levSim +
        w.tokenJaccard * jaccardSim +
        w.embedding * embeddingSim
      ) / totalWeight;
      const modificationDistance = 1.0 - similarity;

      return {
        similarity: _round(similarity),
        modificationDistance: _round(modificationDistance),
        isUsable: modificationDistance <= USABLE_THRESHOLD,
        metrics: {
          levenshtein: _round(levSim),
          tokenJaccard: _round(jaccardSim),
          embedding: _round(embeddingSim)
        }
      };
    }

    // Fallback for this pair if embeddings unavailable
    return computeBulletSimilarity(original, edited);
  });

  return { scores, aggregate: _computeAggregate(scores) };
}

// ─── Embedding Cosine Similarity as Edit-Distance Proxy ───────────────────────
//
// These functions treat embedding cosine similarity as the PRIMARY metric for
// measuring how much a user changed a system-generated bullet.  The cosine
// similarity of their embeddings is a continuous proxy for semantic edit
// distance: 1.0 = no meaningful change, 0.0 = completely rewritten.
//
// Unlike the combined scoring above (which blends Levenshtein + Jaccard +
// optional embeddings with tunable weights), these functions use embedding
// cosine similarity as the authoritative signal and fall back to the combined
// offline scoring only when the embedding API is unavailable.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Quality distribution buckets for classifying bullet similarity scores.
 * Each bucket captures a semantically meaningful range of edit distance.
 */
export const QUALITY_BUCKETS = {
  /** Virtually unchanged — cosmetic edits only (>=0.95 similarity) */
  pristine:  { min: 0.95, max: 1.0,  label: "pristine" },
  /** Minor rewording — meaning fully preserved (0.85–0.95) */
  minor:     { min: 0.85, max: 0.95, label: "minor_edit" },
  /** Moderate edit — meaning mostly preserved (0.50–0.85) */
  moderate:  { min: 0.50, max: 0.85, label: "moderate_edit" },
  /** Major rewrite — substantial semantic change (<0.50) */
  rewritten: { min: 0.0,  max: 0.50, label: "rewritten" },
};

/**
 * Classify a similarity score into a quality bucket label.
 *
 * @param {number} similarity — [0, 1]
 * @returns {string} — one of "pristine", "minor_edit", "moderate_edit", "rewritten"
 */
export function classifyEditDistance(similarity) {
  if (similarity >= QUALITY_BUCKETS.pristine.min)  return QUALITY_BUCKETS.pristine.label;
  if (similarity >= QUALITY_BUCKETS.minor.min)     return QUALITY_BUCKETS.minor.label;
  if (similarity >= QUALITY_BUCKETS.moderate.min)   return QUALITY_BUCKETS.moderate.label;
  return QUALITY_BUCKETS.rewritten.label;
}

/**
 * Score a single generated-vs-final bullet pair using embedding cosine
 * similarity as the primary edit-distance proxy.
 *
 * When embeddings are available, the returned `similarity` field uses the
 * embedding cosine value directly.  Offline metrics (Levenshtein, Jaccard)
 * are always included for comparison and fallback.
 *
 * Supports pre-computed embeddings to avoid redundant API calls when the
 * caller has already embedded the text (e.g. for episode grouping).
 *
 * @param {string} generated — system-generated bullet text
 * @param {string} final_    — user-final bullet text (after any edits)
 * @param {object} [options]
 * @param {number[]|null} [options.generatedEmbedding] — pre-computed embedding
 * @param {number[]|null} [options.finalEmbedding]     — pre-computed embedding
 * @returns {Promise<object>} — detailed similarity result
 */
export async function scoreGeneratedVsFinalPair(generated, final_, options = {}) {
  const normGen = normalizeBullet(generated);
  const normFin = normalizeBullet(final_);

  // Always compute offline metrics
  const levSim     = levenshteinSimilarity(generated, final_);
  const jaccardSim = tokenJaccardSimilarity(generated, final_);

  // Compute embedding similarity (primary metric)
  let embeddingSim = null;
  let embeddingSource = "none";

  if (options.generatedEmbedding && options.finalEmbedding) {
    // Use pre-computed embeddings
    embeddingSim = embeddingCosineSimilarity(options.generatedEmbedding, options.finalEmbedding);
    embeddingSim = Math.max(0, Math.min(1, embeddingSim));
    embeddingSource = "precomputed";
  } else {
    // Fetch fresh embeddings
    const embeddings = await generateEmbeddings([normGen, normFin]);
    if (embeddings && embeddings.length >= 2) {
      embeddingSim = embeddingCosineSimilarity(embeddings[0], embeddings[1]);
      embeddingSim = Math.max(0, Math.min(1, embeddingSim));
      embeddingSource = "api";
    }
  }

  // Primary similarity: embedding when available, combined fallback otherwise
  const primarySimilarity = embeddingSim !== null
    ? embeddingSim
    : _combinedOffline(levSim, jaccardSim);

  const modificationDistance = 1.0 - primarySimilarity;
  const isUsable = modificationDistance <= USABLE_THRESHOLD;
  const bucket = classifyEditDistance(primarySimilarity);

  return {
    generated,
    final: final_,
    similarity: _round(primarySimilarity),
    modificationDistance: _round(modificationDistance),
    isUsable,
    bucket,
    embeddingAvailable: embeddingSim !== null,
    embeddingSource,
    metrics: {
      embedding:    embeddingSim !== null ? _round(embeddingSim) : null,
      levenshtein:  _round(levSim),
      tokenJaccard: _round(jaccardSim),
    },
  };
}

/**
 * Score a batch of generated-vs-final bullet pairs using a single embedding
 * API call for efficiency.  Returns per-pair scores plus an aggregate
 * quality report with distribution buckets and percentiles.
 *
 * @param {Array<{generated: string, final: string}>} pairs
 * @param {object} [options]
 * @param {Array<{generatedEmbedding?: number[], finalEmbedding?: number[]}>} [options.precomputedEmbeddings]
 *   — optional parallel array of pre-computed embeddings (one entry per pair)
 * @returns {Promise<object>} — { scores, qualityReport }
 */
export async function scoreGeneratedVsFinalBatch(pairs, options = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return {
      scores: [],
      qualityReport: _emptyQualityReport(),
    };
  }

  const precomputed = options.precomputedEmbeddings || [];

  // Determine which pairs need fresh embeddings
  const textsToEmbed = [];
  const embedIndexMap = []; // maps pair index → start index in textsToEmbed (or null)
  for (let i = 0; i < pairs.length; i++) {
    const pre = precomputed[i];
    if (pre?.generatedEmbedding && pre?.finalEmbedding) {
      embedIndexMap.push(null); // already have embeddings
    } else {
      embedIndexMap.push(textsToEmbed.length);
      textsToEmbed.push(normalizeBullet(pairs[i].generated));
      textsToEmbed.push(normalizeBullet(pairs[i].final));
    }
  }

  // Single batch API call for all texts needing embeddings
  const freshEmbeddings = textsToEmbed.length > 0
    ? await generateEmbeddings(textsToEmbed)
    : null;

  // Score each pair
  const scores = pairs.map((pair, i) => {
    const levSim     = levenshteinSimilarity(pair.generated, pair.final);
    const jaccardSim = tokenJaccardSimilarity(pair.generated, pair.final);

    let embeddingSim = null;
    let embeddingSource = "none";

    const pre = precomputed[i];
    if (pre?.generatedEmbedding && pre?.finalEmbedding) {
      embeddingSim = embeddingCosineSimilarity(pre.generatedEmbedding, pre.finalEmbedding);
      embeddingSim = Math.max(0, Math.min(1, embeddingSim));
      embeddingSource = "precomputed";
    } else if (freshEmbeddings && embedIndexMap[i] !== null) {
      const base = embedIndexMap[i];
      if (freshEmbeddings[base] && freshEmbeddings[base + 1]) {
        embeddingSim = embeddingCosineSimilarity(freshEmbeddings[base], freshEmbeddings[base + 1]);
        embeddingSim = Math.max(0, Math.min(1, embeddingSim));
        embeddingSource = "api";
      }
    }

    const primarySimilarity = embeddingSim !== null
      ? embeddingSim
      : _combinedOffline(levSim, jaccardSim);

    const modificationDistance = 1.0 - primarySimilarity;
    const isUsable = modificationDistance <= USABLE_THRESHOLD;
    const bucket = classifyEditDistance(primarySimilarity);

    return {
      generated: pair.generated,
      final: pair.final,
      similarity: _round(primarySimilarity),
      modificationDistance: _round(modificationDistance),
      isUsable,
      bucket,
      embeddingAvailable: embeddingSim !== null,
      embeddingSource,
      metrics: {
        embedding:    embeddingSim !== null ? _round(embeddingSim) : null,
        levenshtein:  _round(levSim),
        tokenJaccard: _round(jaccardSim),
      },
    };
  });

  const qualityReport = computeQualityReport(scores);
  return { scores, qualityReport };
}

/**
 * Compute an aggregate quality report from an array of scored bullet pairs.
 * Includes distribution buckets, percentiles, and the 70% usability target.
 *
 * Can be called independently on any array of score objects that have
 * `similarity`, `isUsable`, `embeddingAvailable`, and `bucket` fields.
 *
 * @param {Array<object>} scores — scored bullet results (from scoreGeneratedVsFinal*)
 * @returns {object} — quality report
 */
export function computeQualityReport(scores) {
  if (!Array.isArray(scores) || scores.length === 0) {
    return _emptyQualityReport();
  }

  const total = scores.length;
  const usableCount = scores.filter((s) => s.isUsable).length;
  const embeddingCount = scores.filter((s) => s.embeddingAvailable).length;
  const totalSim = scores.reduce((sum, s) => sum + s.similarity, 0);

  // Distribution across quality buckets
  const distribution = { pristine: 0, minor_edit: 0, moderate_edit: 0, rewritten: 0 };
  for (const s of scores) {
    distribution[s.bucket] = (distribution[s.bucket] || 0) + 1;
  }

  // Compute percentiles for deeper analysis
  const sorted = scores.map((s) => s.similarity).sort((a, b) => a - b);
  const p25 = sorted[Math.floor(total * 0.25)] ?? 0;
  const p50 = sorted[Math.floor(total * 0.50)] ?? 0;
  const p75 = sorted[Math.floor(total * 0.75)] ?? 0;

  return {
    totalBullets: total,
    usableBullets: usableCount,
    usableRate: _round(usableCount / total),
    meetsQualityTarget: usableCount / total >= 0.7,
    meanSimilarity: _round(totalSim / total),
    meanModificationDistance: _round(1.0 - totalSim / total),
    embeddingCoverage: _round(embeddingCount / total),
    distribution,
    distributionRates: {
      pristine:      _round(distribution.pristine / total),
      minor_edit:    _round(distribution.minor_edit / total),
      moderate_edit: _round(distribution.moderate_edit / total),
      rewritten:     _round(distribution.rewritten / total),
    },
    percentiles: {
      p25: _round(p25),
      p50: _round(p50),
      p75: _round(p75),
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function _round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Combined offline similarity using default weights. */
function _combinedOffline(levSim, jaccardSim) {
  const wLev = DEFAULT_WEIGHTS.levenshtein;
  const wJac = DEFAULT_WEIGHTS.tokenJaccard;
  const total = wLev + wJac;
  return total > 0 ? (wLev * levSim + wJac * jaccardSim) / total : 0;
}

function _emptyAggregate() {
  return {
    totalBullets: 0,
    usableBullets: 0,
    usableRate: 0,
    meanSimilarity: 0,
    meanModificationDistance: 0,
    meetsQualityTarget: false
  };
}

function _computeAggregate(scores) {
  const usableCount = scores.filter((s) => s.isUsable).length;
  const totalSim = scores.reduce((sum, s) => sum + s.similarity, 0);

  return {
    totalBullets: scores.length,
    usableBullets: usableCount,
    usableRate: _round(usableCount / scores.length),
    meanSimilarity: _round(totalSim / scores.length),
    meanModificationDistance: _round(1.0 - totalSim / scores.length),
    /** True when >=70% of bullets have modificationDistance <= 0.5 */
    meetsQualityTarget: usableCount / scores.length >= 0.7
  };
}

/** Build an empty quality report for zero-pair inputs. */
function _emptyQualityReport() {
  return {
    totalBullets: 0,
    usableBullets: 0,
    usableRate: 0,
    meetsQualityTarget: false,
    meanSimilarity: 0,
    meanModificationDistance: 0,
    embeddingCoverage: 0,
    distribution: { pristine: 0, minor_edit: 0, moderate_edit: 0, rewritten: 0 },
    distributionRates: { pristine: 0, minor_edit: 0, moderate_edit: 0, rewritten: 0 },
    percentiles: { p25: 0, p50: 0, p75: 0 },
  };
}

// ─── Quality Tracking Persistence ─────────────────────────────────────────────
//
// Records bullet edit events over time so the "70%+ bullets usable with ≤50%
// semantic modification" quality target can be measured longitudinally.
//
// Storage: Vercel Blob at resume/quality-tracking.json.  The document is
// append-only (up to a configurable max window) and never deletes entries
// that were created by earlier recording calls.
//
// Integration: callers (e.g. suggestion approval routes) call
// `trackBulletEdit()` when a user approves or edits a system-generated
// bullet.  `loadQualityHistory()` and `computeQualityReportFromHistory()`
// then aggregate the data for dashboarding.
// ──────────────────────────────────────────────────────────────────────────────

/** Schema version for the quality tracking document. */
const QUALITY_TRACKING_SCHEMA_VERSION = 1;

/** Maximum number of tracking records to retain (rolling window). */
export const MAX_TRACKING_RECORDS = 500;

/**
 * @typedef {Object} QualityTrackingRecord
 * @property {string} id             — UUID
 * @property {string} generatedText  — original system-generated bullet
 * @property {string} finalText      — user-final bullet (may equal generated if accepted as-is)
 * @property {number} similarity     — primary similarity score [0, 1]
 * @property {number} modificationDistance — 1 - similarity
 * @property {boolean} isUsable      — modificationDistance <= USABLE_THRESHOLD
 * @property {string} bucket         — quality bucket label
 * @property {string} action         — "approved" | "edited" | "discarded"
 * @property {string} section        — resume section ("experience" | "projects")
 * @property {string|null} logDate   — source work-log date (YYYY-MM-DD)
 * @property {string} recordedAt     — ISO timestamp
 * @property {object} metrics        — { embedding, levenshtein, tokenJaccard }
 */

/**
 * Create a quality tracking record from a generated-vs-final bullet pair.
 *
 * This is a pure function — it computes similarity scores and returns a
 * record object without performing any I/O.  Use `persistTrackingRecords()`
 * to write records to blob storage.
 *
 * @param {object} params
 * @param {string} params.generatedText  — system-generated bullet
 * @param {string} params.finalText      — user-final bullet
 * @param {string} params.action         — "approved" | "edited" | "discarded"
 * @param {string} [params.section]      — "experience" | "projects"
 * @param {string|null} [params.logDate] — source work-log date
 * @returns {Promise<QualityTrackingRecord>}
 */
export async function createTrackingRecord({
  generatedText,
  finalText,
  action,
  section = "experience",
  logDate = null,
}) {
  const scoreResult = await scoreGeneratedVsFinalPair(generatedText, finalText);

  return {
    id: randomUUID(),
    generatedText,
    finalText,
    similarity: scoreResult.similarity,
    modificationDistance: scoreResult.modificationDistance,
    isUsable: scoreResult.isUsable,
    bucket: scoreResult.bucket,
    action,
    section,
    logDate,
    recordedAt: new Date().toISOString(),
    metrics: scoreResult.metrics,
  };
}

/**
 * Create a tracking record using offline-only scoring (no embedding API call).
 * Useful when you want to avoid API latency/cost in hot paths.
 *
 * @param {object} params — same as createTrackingRecord
 * @returns {QualityTrackingRecord}
 */
export function createTrackingRecordOffline({
  generatedText,
  finalText,
  action,
  section = "experience",
  logDate = null,
}) {
  const result = computeBulletSimilarity(generatedText, finalText);

  return {
    id: randomUUID(),
    generatedText,
    finalText,
    similarity: result.similarity,
    modificationDistance: result.modificationDistance,
    isUsable: result.isUsable,
    bucket: classifyEditDistance(result.similarity),
    action,
    section,
    logDate,
    recordedAt: new Date().toISOString(),
    metrics: {
      embedding: null,
      levenshtein: result.metrics.levenshtein,
      tokenJaccard: result.metrics.tokenJaccard,
    },
  };
}

/**
 * Build a quality tracking document from an array of records.
 * Enforces the rolling window by keeping only the most recent
 * MAX_TRACKING_RECORDS entries.
 *
 * @param {QualityTrackingRecord[]} existingRecords — previously stored records
 * @param {QualityTrackingRecord[]} newRecords — new records to append
 * @returns {object} — QualityTrackingDocument ready for blob storage
 */
export function buildTrackingDocument(existingRecords, newRecords) {
  const existing = Array.isArray(existingRecords) ? existingRecords : [];
  const incoming = Array.isArray(newRecords) ? newRecords : [];

  // Deduplicate by ID (in case of retry)
  const idSet = new Set(existing.map((r) => r.id));
  const deduped = incoming.filter((r) => !idSet.has(r.id));

  // Combine and enforce rolling window (keep most recent)
  const combined = [...existing, ...deduped];
  const trimmed = combined.length > MAX_TRACKING_RECORDS
    ? combined.slice(combined.length - MAX_TRACKING_RECORDS)
    : combined;

  return {
    schemaVersion: QUALITY_TRACKING_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    records: trimmed,
  };
}

/**
 * Compute a longitudinal quality report from a history of tracking records.
 *
 * Supports optional time-window filtering (e.g. "last 30 days") and
 * section filtering.
 *
 * @param {QualityTrackingRecord[]} records — raw tracking records
 * @param {object} [options]
 * @param {number} [options.daysBack]   — only include records from the last N days
 * @param {string} [options.section]    — filter by section ("experience" | "projects")
 * @param {string} [options.action]     — filter by action ("approved" | "edited" | "discarded")
 * @returns {object} — quality report with temporal and aggregate data
 */
export function computeQualityReportFromHistory(records, options = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      ..._emptyQualityReport(),
      windowDays: options.daysBack ?? null,
      filteredCount: 0,
      totalRecords: 0,
    };
  }

  let filtered = records;

  // Time window filter
  if (options.daysBack && options.daysBack > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - options.daysBack);
    const cutoffISO = cutoff.toISOString();
    filtered = filtered.filter((r) => r.recordedAt >= cutoffISO);
  }

  // Section filter
  if (options.section) {
    filtered = filtered.filter((r) => r.section === options.section);
  }

  // Action filter
  if (options.action) {
    filtered = filtered.filter((r) => r.action === options.action);
  }

  if (filtered.length === 0) {
    return {
      ..._emptyQualityReport(),
      windowDays: options.daysBack ?? null,
      filteredCount: 0,
      totalRecords: records.length,
    };
  }

  // Reuse computeQualityReport for the core aggregation
  const coreReport = computeQualityReport(
    filtered.map((r) => ({
      similarity: r.similarity,
      isUsable: r.isUsable,
      embeddingAvailable: r.metrics?.embedding !== null,
      bucket: r.bucket,
    }))
  );

  // Add action breakdown
  const actionBreakdown = { approved: 0, edited: 0, discarded: 0 };
  for (const r of filtered) {
    if (r.action in actionBreakdown) {
      actionBreakdown[r.action]++;
    }
  }

  return {
    ...coreReport,
    windowDays: options.daysBack ?? null,
    filteredCount: filtered.length,
    totalRecords: records.length,
    actionBreakdown,
  };
}

// ─── Persistence — Blob-backed quality tracking I/O ─────────────────────────
//
// These functions complete the tracking pipeline by reading/writing the
// quality tracking document in Vercel Blob storage.  They are intentionally
// separated from the pure scoring functions above so that callers can choose
// between:
//   • Pure scoring (computeBulletSimilarity, scoreGeneratedVsFinalPair, etc.)
//   • Full tracking with persistence (trackBulletEdit, loadQualityHistory)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Load the full quality tracking history from Blob storage.
 *
 * Returns an empty `records` array when no tracking data exists yet.
 * The returned document always has `{ schemaVersion, updatedAt, records }`.
 *
 * @returns {Promise<{ schemaVersion: number, updatedAt: string, records: QualityTrackingRecord[] }>}
 */
export async function loadQualityHistory() {
  return readQualityTracking();
}

/**
 * Persist an array of new tracking records to Blob storage.
 *
 * Loads the existing document, merges new records via `buildTrackingDocument`
 * (which deduplicates by ID and enforces the rolling window), and saves the
 * result back to Blob.
 *
 * @param {QualityTrackingRecord[]} newRecords — records to append
 * @returns {Promise<{ url: string, totalRecords: number }>}
 */
export async function persistTrackingRecords(newRecords) {
  if (!Array.isArray(newRecords) || newRecords.length === 0) {
    return { url: null, totalRecords: 0 };
  }

  const existing = await loadQualityHistory();
  const doc = buildTrackingDocument(existing.records, newRecords);
  const { url } = await saveQualityTracking(doc);

  return { url, totalRecords: doc.records.length };
}

/**
 * Track a single bullet edit event end-to-end: score the pair, create a
 * tracking record, and persist it to Blob storage.
 *
 * This is the primary integration point for route handlers (e.g. suggestion
 * approval, inline edit) that need to record quality data with a single call.
 *
 * @param {object} params
 * @param {string} params.generatedText  — system-generated bullet
 * @param {string} params.finalText      — user-final bullet (after any edits)
 * @param {string} params.action         — "approved" | "edited" | "discarded"
 * @param {string} [params.section]      — "experience" | "projects"
 * @param {string|null} [params.logDate] — source work-log date (YYYY-MM-DD)
 * @param {boolean} [params.useEmbeddings=true] — whether to call embedding API
 * @returns {Promise<{ record: QualityTrackingRecord, persisted: boolean }>}
 */
export async function trackBulletEdit({
  generatedText,
  finalText,
  action,
  section = "experience",
  logDate = null,
  useEmbeddings = true,
}) {
  // Create the tracking record (with or without embeddings)
  const record = useEmbeddings
    ? await createTrackingRecord({ generatedText, finalText, action, section, logDate })
    : createTrackingRecordOffline({ generatedText, finalText, action, section, logDate });

  // ── Automatic similarity score reporting ──────────────────────────────────
  // Log every tracked comparison for observability.  This enables operators to
  // monitor bullet quality in real-time via structured logs without querying
  // the Blob-backed quality history.
  console.info(
    `[quality-tracking] action=${record.action} section=${record.section} ` +
    `similarity=${record.similarity} bucket=${record.bucket} ` +
    `isUsable=${record.isUsable} ` +
    `lev=${record.metrics.levenshtein} jac=${record.metrics.tokenJaccard} ` +
    `emb=${record.metrics.embedding ?? "n/a"} ` +
    `generated="${(record.generatedText ?? "").slice(0, 60)}…" ` +
    `final="${(record.finalText ?? "").slice(0, 60)}…"`
  );

  // Persist to Blob — non-fatal on failure (log and continue)
  let persisted = false;
  try {
    await persistTrackingRecords([record]);
    persisted = true;
  } catch (err) {
    console.warn("[resumeBulletSimilarity/trackBulletEdit] persist failed (non-fatal):", err);
  }

  return { record, persisted };
}

/**
 * Track a batch of bullet edit events and emit an aggregate quality summary.
 *
 * Useful after reconstruction or recluster pipelines that produce many
 * bullet changes at once.  Creates tracking records for each pair and
 * persists them in a single write, then logs an aggregate quality summary.
 *
 * @param {Array<{generatedText: string, finalText: string, action: string, section?: string, logDate?: string|null}>} pairs
 * @param {object} [options]
 * @param {boolean} [options.useEmbeddings=false] — whether to call embedding API
 * @returns {Promise<{ records: QualityTrackingRecord[], qualitySummary: object, persisted: boolean }>}
 */
export async function trackBulletEditBatch(pairs, options = {}) {
  const { useEmbeddings = false } = options;

  if (!Array.isArray(pairs) || pairs.length === 0) {
    return { records: [], qualitySummary: _emptyQualityReport(), persisted: false };
  }

  // Create records (offline by default for batch hot paths)
  const records = [];
  for (const pair of pairs) {
    const record = useEmbeddings
      ? await createTrackingRecord({
          generatedText: pair.generatedText,
          finalText: pair.finalText,
          action: pair.action,
          section: pair.section ?? "experience",
          logDate: pair.logDate ?? null,
        })
      : createTrackingRecordOffline({
          generatedText: pair.generatedText,
          finalText: pair.finalText,
          action: pair.action,
          section: pair.section ?? "experience",
          logDate: pair.logDate ?? null,
        });
    records.push(record);
  }

  // Compute aggregate quality summary from the batch
  const qualitySummary = computeQualityReport(
    records.map((r) => ({
      similarity: r.similarity,
      isUsable: r.isUsable,
      embeddingAvailable: r.metrics?.embedding !== null,
      bucket: r.bucket,
    }))
  );

  // ── Automatic batch quality summary reporting ─────────────────────────────
  console.info(
    `[quality-tracking/batch] tracked=${records.length} ` +
    `usableRate=${qualitySummary.usableRate} ` +
    `meetsTarget=${qualitySummary.meetsQualityTarget} ` +
    `meanSimilarity=${qualitySummary.meanSimilarity} ` +
    `distribution: pristine=${qualitySummary.distribution.pristine} ` +
    `minor=${qualitySummary.distribution.minor_edit} ` +
    `moderate=${qualitySummary.distribution.moderate_edit} ` +
    `rewritten=${qualitySummary.distribution.rewritten}`
  );

  // Persist all records in a single write
  let persisted = false;
  try {
    await persistTrackingRecords(records);
    persisted = true;
  } catch (err) {
    console.warn("[resumeBulletSimilarity/trackBulletEditBatch] persist failed (non-fatal):", err);
  }

  return { records, qualitySummary, persisted };
}

/**
 * Get the current quality report from stored tracking history.
 *
 * Convenience wrapper that loads history and computes the report in one call.
 *
 * @param {object} [options] — forwarded to computeQualityReportFromHistory
 * @param {number} [options.daysBack]
 * @param {string} [options.section]
 * @param {string} [options.action]
 * @returns {Promise<object>} — quality report
 */
export async function getQualityReport(options = {}) {
  const { records } = await loadQualityHistory();
  return computeQualityReportFromHistory(records, options);
}
