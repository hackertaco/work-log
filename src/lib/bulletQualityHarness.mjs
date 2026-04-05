/**
 * Bullet Quality Evaluation Harness
 *
 * Runs generated resume bullets against reference/golden bullets and reports
 * the percentage meeting the ≤50% modification threshold.  This is the
 * automated quality gate for the "70%+ bullets usable with ≤50% semantic
 * modification" acceptance criterion.
 *
 * The harness operates in two modes:
 *
 *   1. **Offline** — uses Levenshtein + Token Jaccard similarity (no API).
 *      Fast, deterministic, suitable for CI and unit tests.
 *
 *   2. **Embedding** — adds OpenAI embedding cosine similarity as the primary
 *      metric.  More accurate semantic measurement but requires API key.
 *      Falls back to offline mode when the API is unavailable.
 *
 * A "golden set" of reference bullet pairs ships with the module for
 * regression testing.  External callers can also supply their own pairs.
 *
 * Integration points:
 *   - CI / pre-commit: `runOfflineEvaluation()` with the built-in golden set
 *   - Post-regeneration: `runEvaluation()` with freshly generated bullets
 *   - Dashboard: `formatReport()` for human-readable output
 *
 * @module bulletQualityHarness
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  computeBulletSimilarity,
  scoreGeneratedVsFinalBatch,
  computeQualityReport,
  USABLE_THRESHOLD,
  classifyEditDistance,
  normalizeBullet,
} from "./resumeBulletSimilarity.mjs";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Target: 70% of bullets must be usable (modificationDistance ≤ 0.5). */
export const QUALITY_TARGET_RATE = 0.7;

/** Default modification distance threshold for "usable". */
export const MODIFICATION_THRESHOLD = USABLE_THRESHOLD; // 0.5

// ─── Golden Bullet Fixture Set ──────────────────────────────────────────────
//
// Each entry represents a (generated, reference) pair where `reference` is
// the golden/ideal bullet that a human would accept.  The generated text
// simulates what the LLM pipeline produces; the reference text simulates
// what a user would keep (possibly with light edits).
//
// These pairs cover a range of quality levels to ensure the harness correctly
// identifies usable vs. rewritten bullets.
// ────────────────────────────────────────────────────────────────────────────

export const GOLDEN_BULLET_PAIRS = [
  // ── Pristine / near-identical pairs (expected: usable) ──────────────────
  {
    id: "golden-01",
    category: "pristine",
    generated:
      "Designed and implemented a real-time notification system using WebSockets, reducing latency by 40%",
    reference:
      "Designed and implemented a real-time notification system using WebSockets, reducing latency by 40%",
    expectedUsable: true,
    notes: "Exact match — perfect generation",
  },
  {
    id: "golden-02",
    category: "minor_edit",
    generated:
      "Led migration of legacy REST API endpoints to GraphQL, improving query efficiency by 60%",
    reference:
      "Led migration of legacy REST API to GraphQL, improving query efficiency by 60%",
    expectedUsable: true,
    notes: "Minor trimming — removed 'endpoints'",
  },
  {
    id: "golden-03",
    category: "minor_edit",
    generated:
      "Built automated CI/CD pipeline with GitHub Actions for the frontend monorepo, reducing deploy time from 45 to 12 minutes",
    reference:
      "Built CI/CD pipeline with GitHub Actions for the frontend monorepo, cutting deploy time from 45 to 12 minutes",
    expectedUsable: true,
    notes: "Minor rewording — 'automated' removed, 'reducing' → 'cutting'",
  },

  // ── Moderate edit pairs (expected: usable) ──────────────────────────────
  {
    id: "golden-04",
    category: "moderate_edit",
    generated:
      "Refactored authentication module to use OAuth 2.0 with PKCE flow, replacing legacy session-based authentication across 3 microservices",
    reference:
      "Migrated authentication to OAuth 2.0 + PKCE, replacing session-based auth across 3 microservices",
    expectedUsable: true,
    notes: "Moderate condensing — still semantically aligned",
  },
  {
    id: "golden-05",
    category: "moderate_edit",
    generated:
      "Implemented comprehensive error handling and retry logic for the payment processing service, reducing failed transaction rate by 35%",
    reference:
      "Added error handling and retry logic to the payment service, reducing failed transactions by 35%",
    expectedUsable: true,
    notes: "Moderate simplification — 'comprehensive' and 'processing' trimmed",
  },
  {
    id: "golden-06",
    category: "moderate_edit",
    generated:
      "Designed a caching layer using Redis for frequently accessed API endpoints, improving p95 response time from 800ms to 120ms",
    reference:
      "Designed Redis caching layer for high-traffic API endpoints, improving p95 latency from 800ms to 120ms",
    expectedUsable: true,
    notes: "Rewording with preserved metrics",
  },
  {
    id: "golden-07",
    category: "moderate_edit",
    generated:
      "Collaborated with the design team to implement an accessible component library following WCAG 2.1 AA standards, adopted by 4 product teams",
    reference:
      "Built accessible component library (WCAG 2.1 AA) with design team, adopted by 4 product teams",
    expectedUsable: true,
    notes: "Condensed but meaning preserved",
  },

  // ── Rewritten pairs (expected: NOT usable) ──────────────────────────────
  {
    id: "golden-08",
    category: "rewritten",
    generated:
      "Worked on various backend tasks and helped improve system performance",
    reference:
      "Architected distributed event processing pipeline handling 50K events/sec with sub-100ms latency, reducing infrastructure costs by 30%",
    expectedUsable: false,
    notes: "Completely different — vague generated vs. specific reference",
  },
  {
    id: "golden-09",
    category: "rewritten",
    generated:
      "Contributed to the machine learning infrastructure project and supported model deployment workflows",
    reference:
      "Built real-time feature store serving 200M daily predictions with <5ms p99 latency, enabling ML team to deploy 3x more models per quarter",
    expectedUsable: false,
    notes: "Completely rewritten — different specificity and scope",
  },
  {
    id: "golden-10",
    category: "rewritten",
    generated:
      "Helped improve the testing framework and code quality processes",
    reference:
      "Designed property-based testing framework for the trading engine, catching 12 edge-case bugs missed by unit tests and preventing $2M in potential losses",
    expectedUsable: false,
    notes: "Completely different content and specificity",
  },

  // ── Edge cases ──────────────────────────────────────────────────────────
  {
    id: "golden-11",
    category: "minor_edit",
    generated:
      "Optimized database queries for the user analytics dashboard, reducing page load time by 70%",
    reference:
      "Optimized SQL queries for the analytics dashboard, reducing page load by 70%",
    expectedUsable: true,
    notes: "Small synonym swap — 'database' → 'SQL', 'user' dropped",
  },
  {
    id: "golden-12",
    category: "moderate_edit",
    generated:
      "Developed and maintained a Kubernetes-based deployment platform for 15 production services with automated scaling and health monitoring capabilities",
    reference:
      "Built Kubernetes deployment platform for 15 production services with auto-scaling and health monitoring",
    expectedUsable: true,
    notes: "Condensed verbose phrasing",
  },

  // ── Episode-based bullets with decision reasoning (new pipeline) ────────
  {
    id: "golden-13",
    category: "minor_edit",
    generated:
      "Chose WebSocket over polling after profiling showed 200ms round-trip overhead, reducing notification latency by 40% across the real-time dashboard",
    reference:
      "Chose WebSocket over polling after profiling 200ms overhead, cutting notification latency 40% on the real-time dashboard",
    expectedUsable: true,
    notes: "Minor condensing — decision reasoning preserved",
  },
  {
    id: "golden-14",
    category: "moderate_edit",
    generated:
      "Evaluated three caching strategies and selected Redis with write-through invalidation for payment endpoints, improving p95 latency from 800ms to 120ms",
    reference:
      "Selected Redis write-through caching for payment endpoints after evaluating three strategies, improving p95 latency from 800ms to 120ms",
    expectedUsable: true,
    notes: "Reordered with reasoning embedded — moderate restructure, meaning intact",
  },
  {
    id: "golden-15",
    category: "moderate_edit",
    generated:
      "Migrated OAuth flow to PKCE after session analysis revealed token interception risk in mobile app, securing auth across 3 microservices",
    reference:
      "Migrated to OAuth 2.0 + PKCE after identifying token interception risk in mobile, securing auth across 3 microservices",
    expectedUsable: true,
    notes: "Condensed reasoning context — decision rationale still present",
  },
  {
    id: "golden-16",
    category: "rewritten",
    generated:
      "Investigated session data and worked on improving the authentication system for better security",
    reference:
      "Identified token interception vulnerability via session replay analysis, migrated 3 services to PKCE-based OAuth reducing auth incidents by 85%",
    expectedUsable: false,
    notes: "Vague generated vs. specific with reasoning and metrics",
  },
  {
    id: "golden-17",
    category: "pristine",
    generated:
      "Designed event-driven pipeline after load testing revealed synchronous bottleneck at 10K req/s, achieving 50K events/sec throughput with sub-100ms latency",
    reference:
      "Designed event-driven pipeline after load testing revealed synchronous bottleneck at 10K req/s, achieving 50K events/sec throughput with sub-100ms latency",
    expectedUsable: true,
    notes: "Exact match — episode-derived bullet with embedded reasoning accepted as-is",
  },
];

// ─── Evaluation Core ────────────────────────────────────────────────────────

/**
 * Run the bullet quality evaluation using offline metrics only (no API calls).
 *
 * Scores each pair, classifies usability, and produces an aggregate report
 * including the pass/fail status against the 70% quality target.
 *
 * @param {Array<{generated: string, reference: string}>} [pairs] — bullet pairs
 *   to evaluate.  Defaults to the built-in golden set if omitted.
 * @param {object} [options]
 * @param {number} [options.qualityTargetRate] — override the 70% target
 * @param {number} [options.modificationThreshold] — override the 0.5 threshold
 * @returns {object} — { scores, report, passed }
 */
export function runOfflineEvaluation(pairs, options = {}) {
  const evalPairs = _normalizePairs(pairs);
  const targetRate = options.qualityTargetRate ?? QUALITY_TARGET_RATE;
  const modThreshold = options.modificationThreshold ?? MODIFICATION_THRESHOLD;

  const scores = evalPairs.map((pair) => {
    const result = computeBulletSimilarity(pair.generated, pair.reference);
    const isUsable = result.modificationDistance <= modThreshold;
    const bucket = classifyEditDistance(result.similarity);

    return {
      id: pair.id || null,
      category: pair.category || null,
      generated: pair.generated,
      reference: pair.reference,
      similarity: result.similarity,
      modificationDistance: result.modificationDistance,
      isUsable,
      bucket,
      expectedUsable: pair.expectedUsable ?? null,
      classificationCorrect:
        pair.expectedUsable != null ? isUsable === pair.expectedUsable : null,
      metrics: result.metrics,
    };
  });

  const report = _buildEvalReport(scores, targetRate, modThreshold);
  return { scores, report, passed: report.passed };
}

/**
 * Run the bullet quality evaluation with embedding similarity (API-backed).
 *
 * Uses `scoreGeneratedVsFinalBatch` for efficient batched embedding calls.
 * Falls back to offline metrics when the embedding API is unavailable.
 *
 * @param {Array<{generated: string, reference: string}>} [pairs] — bullet pairs.
 *   Defaults to the built-in golden set if omitted.
 * @param {object} [options]
 * @param {number} [options.qualityTargetRate] — override the 70% target
 * @param {number} [options.modificationThreshold] — override the 0.5 threshold
 * @returns {Promise<object>} — { scores, report, passed }
 */
export async function runEvaluation(pairs, options = {}) {
  const evalPairs = _normalizePairs(pairs);
  const targetRate = options.qualityTargetRate ?? QUALITY_TARGET_RATE;
  const modThreshold = options.modificationThreshold ?? MODIFICATION_THRESHOLD;

  // Map to the format expected by scoreGeneratedVsFinalBatch
  const batchPairs = evalPairs.map((p) => ({
    generated: p.generated,
    final: p.reference,
  }));

  const { scores: rawScores } = await scoreGeneratedVsFinalBatch(batchPairs);

  const scores = rawScores.map((raw, i) => {
    const pair = evalPairs[i];
    const isUsable = raw.modificationDistance <= modThreshold;

    return {
      id: pair.id || null,
      category: pair.category || null,
      generated: pair.generated,
      reference: pair.reference,
      similarity: raw.similarity,
      modificationDistance: raw.modificationDistance,
      isUsable,
      bucket: raw.bucket,
      embeddingAvailable: raw.embeddingAvailable,
      expectedUsable: pair.expectedUsable ?? null,
      classificationCorrect:
        pair.expectedUsable != null ? isUsable === pair.expectedUsable : null,
      metrics: raw.metrics,
    };
  });

  const report = _buildEvalReport(scores, targetRate, modThreshold);
  return { scores, report, passed: report.passed };
}

/**
 * Run evaluation on the built-in golden set and return a summary suitable
 * for CI output or logging.
 *
 * @param {object} [options]
 * @param {boolean} [options.useEmbeddings=false] — whether to call embedding API
 * @returns {Promise<object>} — { passed, summary, report }
 */
export async function runGoldenSetEvaluation(options = {}) {
  const result = options.useEmbeddings
    ? await runEvaluation(GOLDEN_BULLET_PAIRS)
    : runOfflineEvaluation(GOLDEN_BULLET_PAIRS);

  const summary = formatReport(result.report);
  return { passed: result.passed, summary, report: result.report, scores: result.scores };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

/**
 * Format an evaluation report as a human-readable string.
 *
 * @param {object} report — from runOfflineEvaluation or runEvaluation
 * @returns {string} — multi-line report
 */
export function formatReport(report) {
  const lines = [
    "╔══════════════════════════════════════════════════════╗",
    "║         Bullet Quality Evaluation Report            ║",
    "╚══════════════════════════════════════════════════════╝",
    "",
    `  Total bullets evaluated:     ${report.totalBullets}`,
    `  Usable (≤${(report.modificationThreshold * 100).toFixed(0)}% modification): ${report.usableBullets} / ${report.totalBullets}`,
    `  Usable rate:                 ${(report.usableRate * 100).toFixed(1)}%`,
    `  Quality target (≥${(report.qualityTargetRate * 100).toFixed(0)}%):     ${report.passed ? "✓ PASSED" : "✗ FAILED"}`,
    "",
    "  ── Similarity Statistics ──",
    `  Mean similarity:             ${(report.meanSimilarity * 100).toFixed(1)}%`,
    `  Mean modification distance:  ${(report.meanModificationDistance * 100).toFixed(1)}%`,
    `  Median similarity (p50):     ${(report.percentiles.p50 * 100).toFixed(1)}%`,
    `  p25 similarity:              ${(report.percentiles.p25 * 100).toFixed(1)}%`,
    `  p75 similarity:              ${(report.percentiles.p75 * 100).toFixed(1)}%`,
    "",
    "  ── Quality Distribution ──",
    `  Pristine  (≥95%):  ${report.distribution.pristine} (${(report.distributionRates.pristine * 100).toFixed(1)}%)`,
    `  Minor     (85-95%): ${report.distribution.minor_edit} (${(report.distributionRates.minor_edit * 100).toFixed(1)}%)`,
    `  Moderate  (50-85%): ${report.distribution.moderate_edit} (${(report.distributionRates.moderate_edit * 100).toFixed(1)}%)`,
    `  Rewritten (<50%):  ${report.distribution.rewritten} (${(report.distributionRates.rewritten * 100).toFixed(1)}%)`,
  ];

  if (report.classificationAccuracy != null) {
    lines.push(
      "",
      "  ── Golden Set Classification ──",
      `  Correctly classified:  ${report.correctlyClassified} / ${report.classifiedCount}`,
      `  Classification accuracy: ${(report.classificationAccuracy * 100).toFixed(1)}%`,
    );
  }

  if (report.embeddingCoverage != null && report.embeddingCoverage > 0) {
    lines.push(
      "",
      `  Embedding coverage:    ${(report.embeddingCoverage * 100).toFixed(1)}%`,
    );
  }

  if (report.failedBullets && report.failedBullets.length > 0) {
    lines.push("", "  ── Failed Bullets (not usable) ──");
    for (const fb of report.failedBullets.slice(0, 10)) {
      lines.push(
        `  [${fb.id || "?"}] sim=${(fb.similarity * 100).toFixed(1)}% mod=${(fb.modificationDistance * 100).toFixed(1)}%`,
        `    Generated:  ${_truncate(fb.generated, 80)}`,
        `    Reference:  ${_truncate(fb.reference, 80)}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize input pairs to a standard format.
 * Accepts golden set pairs (generated/reference) or batch pairs.
 * Defaults to GOLDEN_BULLET_PAIRS when no pairs provided.
 */
function _normalizePairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return GOLDEN_BULLET_PAIRS.map((p) => ({
      id: p.id,
      category: p.category,
      generated: p.generated,
      reference: p.reference,
      expectedUsable: p.expectedUsable,
    }));
  }

  return pairs.map((p, i) => ({
    id: p.id || `pair-${i + 1}`,
    category: p.category || null,
    generated: p.generated,
    reference: p.reference || p.final || p.edited || "",
    expectedUsable: p.expectedUsable ?? null,
  }));
}

/**
 * Build the aggregate evaluation report from scored pairs.
 */
function _buildEvalReport(scores, targetRate, modThreshold) {
  const total = scores.length;
  if (total === 0) {
    return {
      totalBullets: 0,
      usableBullets: 0,
      usableRate: 0,
      qualityTargetRate: targetRate,
      modificationThreshold: modThreshold,
      passed: false,
      meanSimilarity: 0,
      meanModificationDistance: 0,
      percentiles: { p25: 0, p50: 0, p75: 0 },
      distribution: { pristine: 0, minor_edit: 0, moderate_edit: 0, rewritten: 0 },
      distributionRates: { pristine: 0, minor_edit: 0, moderate_edit: 0, rewritten: 0 },
      embeddingCoverage: 0,
      classificationAccuracy: null,
      correctlyClassified: 0,
      classifiedCount: 0,
      failedBullets: [],
    };
  }

  const usable = scores.filter((s) => s.isUsable);
  const usableRate = usable.length / total;
  const passed = usableRate >= targetRate;

  const totalSim = scores.reduce((sum, s) => sum + s.similarity, 0);
  const meanSim = totalSim / total;

  // Percentiles
  const sorted = scores.map((s) => s.similarity).sort((a, b) => a - b);
  const p25 = sorted[Math.floor(total * 0.25)] ?? 0;
  const p50 = sorted[Math.floor(total * 0.50)] ?? 0;
  const p75 = sorted[Math.floor(total * 0.75)] ?? 0;

  // Distribution
  const distribution = { pristine: 0, minor_edit: 0, moderate_edit: 0, rewritten: 0 };
  for (const s of scores) {
    distribution[s.bucket] = (distribution[s.bucket] || 0) + 1;
  }

  // Embedding coverage
  const embeddingCount = scores.filter((s) => s.embeddingAvailable).length;

  // Classification accuracy (only for pairs with expectedUsable)
  const classified = scores.filter((s) => s.classificationCorrect != null);
  const correct = classified.filter((s) => s.classificationCorrect).length;

  // Failed bullets for debugging
  const failedBullets = scores
    .filter((s) => !s.isUsable)
    .map((s) => ({
      id: s.id,
      generated: s.generated,
      reference: s.reference,
      similarity: s.similarity,
      modificationDistance: s.modificationDistance,
      bucket: s.bucket,
    }));

  return {
    totalBullets: total,
    usableBullets: usable.length,
    usableRate: _round(usableRate),
    qualityTargetRate: targetRate,
    modificationThreshold: modThreshold,
    passed,
    meanSimilarity: _round(meanSim),
    meanModificationDistance: _round(1.0 - meanSim),
    percentiles: {
      p25: _round(p25),
      p50: _round(p50),
      p75: _round(p75),
    },
    distribution,
    distributionRates: {
      pristine: _round(distribution.pristine / total),
      minor_edit: _round(distribution.minor_edit / total),
      moderate_edit: _round(distribution.moderate_edit / total),
      rewritten: _round(distribution.rewritten / total),
    },
    embeddingCoverage: _round(embeddingCount / total),
    classificationAccuracy:
      classified.length > 0 ? _round(correct / classified.length) : null,
    correctlyClassified: correct,
    classifiedCount: classified.length,
    failedBullets,
  };
}

function _round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function _truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen - 3) + "..." : str;
}

// ─── Live Data Loading ─────────────────────────────────────────────────────
//
// Loads bullet pairs from resume snapshot files, comparing system-generated
// bullets against user-edited versions.  When a bullet has _source:"user" in
// a later snapshot but existed as _source:"system" in an earlier one, we
// treat that as a generated→reference pair for quality measurement.
//
// Also supports loading generated candidates from daily work-log files and
// comparing them against the bullets that ended up in the canonical resume.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Default path to the data/resume directory (relative to project root).
 * Can be overridden by passing a custom path to the loading functions.
 */
const DEFAULT_RESUME_DATA_DIR = "data/resume";
const DEFAULT_DAILY_DATA_DIR = "data/daily";

/**
 * Load bullet pairs from resume snapshot files by comparing consecutive
 * snapshots to find system→user edits.
 *
 * A "pair" is detected when a bullet existed in snapshot N with _source:"system"
 * and appears in snapshot N+1 with _source:"user" (meaning the user edited it).
 * The system version becomes `generated` and the user version becomes `reference`.
 *
 * @param {object} [options]
 * @param {string} [options.resumeDir] — path to data/resume directory
 * @param {number} [options.maxPairs]  — maximum pairs to return (default: 100)
 * @returns {Array<{id: string, generated: string, reference: string, category: string, sourceDate: string}>}
 */
export function loadLiveBulletPairs(options = {}) {
  const resumeDir = options.resumeDir || _resolveDataDir(DEFAULT_RESUME_DATA_DIR);
  const maxPairs = options.maxPairs ?? 100;

  if (!existsSync(resumeDir)) {
    return [];
  }

  // List and sort snapshot files chronologically
  const files = readdirSync(resumeDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length < 2) return [];

  const pairs = [];

  for (let i = 0; i < files.length - 1 && pairs.length < maxPairs; i++) {
    const prevSnap = _loadJsonSafe(join(resumeDir, files[i]));
    const currSnap = _loadJsonSafe(join(resumeDir, files[i + 1]));
    if (!prevSnap || !currSnap) continue;

    const prevBullets = _extractBulletsWithSource(prevSnap);
    const currBullets = _extractBulletsWithSource(currSnap);

    // Find bullets that were "system" in prev and "user" in curr (user edited)
    for (const curr of currBullets) {
      if (curr.source !== "user") continue;

      // Find closest match in previous snapshot's system bullets
      const match = _findClosestSystemBullet(curr.text, prevBullets);
      if (match && match.similarity > 0.3 && match.similarity < 0.98) {
        pairs.push({
          id: `live-${files[i]}-${pairs.length}`,
          generated: match.text,
          reference: curr.text,
          category: "live_edit",
          sourceDate: files[i + 1].replace(".json", ""),
        });
        if (pairs.length >= maxPairs) break;
      }
    }
  }

  return pairs;
}

/**
 * Load candidate bullets from daily work-log files and pair them with
 * the nearest matching bullet in the latest resume snapshot.
 *
 * This measures how well the daily candidate generation produces bullets
 * that end up in the final resume (possibly with edits).
 *
 * @param {object} [options]
 * @param {string} [options.dailyDir]  — path to data/daily directory
 * @param {string} [options.resumeDir] — path to data/resume directory
 * @param {number} [options.maxPairs]  — maximum pairs (default: 50)
 * @returns {Array<{id: string, generated: string, reference: string, category: string, sourceDate: string}>}
 */
export function loadCandidateVsResumePairs(options = {}) {
  const dailyDir = options.dailyDir || _resolveDataDir(DEFAULT_DAILY_DATA_DIR);
  const resumeDir = options.resumeDir || _resolveDataDir(DEFAULT_RESUME_DATA_DIR);
  const maxPairs = options.maxPairs ?? 50;

  if (!existsSync(dailyDir) || !existsSync(resumeDir)) {
    return [];
  }

  // Load the latest resume snapshot
  const resumeFiles = readdirSync(resumeDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (resumeFiles.length === 0) return [];

  const latestResume = _loadJsonSafe(join(resumeDir, resumeFiles[resumeFiles.length - 1]));
  if (!latestResume) return [];

  const resumeBullets = _extractAllBulletTexts(latestResume);
  if (resumeBullets.length === 0) return [];

  // Load daily candidates
  const dailyFiles = readdirSync(dailyDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const pairs = [];

  for (const file of dailyFiles) {
    if (pairs.length >= maxPairs) break;

    const daily = _loadJsonSafe(join(dailyDir, file));
    if (!daily || !Array.isArray(daily.candidates)) continue;

    for (const candidate of daily.candidates) {
      if (pairs.length >= maxPairs) break;
      if (!candidate || typeof candidate !== "string" || candidate.length < 15) continue;

      // Find the closest resume bullet for this candidate
      const match = _findClosestBullet(candidate, resumeBullets);
      if (match && match.similarity > 0.2) {
        pairs.push({
          id: `candidate-${file.replace(".json", "")}-${pairs.length}`,
          generated: candidate,
          reference: match.text,
          category: "candidate_vs_final",
          sourceDate: file.replace(".json", ""),
        });
      }
    }
  }

  return pairs;
}

/**
 * Run the full evaluation including both golden set and live data.
 *
 * First evaluates the golden set (regression gate), then optionally
 * evaluates live bullet pairs from resume snapshots if available.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeLive=true]      — include live data pairs
 * @param {boolean} [options.includeCandidates=true] — include candidate-vs-resume pairs
 * @param {boolean} [options.useEmbeddings=false]    — use embedding API
 * @param {string}  [options.resumeDir]              — path to resume data dir
 * @param {string}  [options.dailyDir]               — path to daily data dir
 * @returns {Promise<object>} — { golden, live?, candidates?, combined }
 */
export async function runFullEvaluation(options = {}) {
  const {
    includeLive = true,
    includeCandidates = true,
    useEmbeddings = false,
    resumeDir,
    dailyDir,
  } = options;

  // 1. Golden set evaluation (always runs)
  const goldenResult = useEmbeddings
    ? await runEvaluation(GOLDEN_BULLET_PAIRS)
    : runOfflineEvaluation(GOLDEN_BULLET_PAIRS);

  const result = {
    golden: {
      passed: goldenResult.passed,
      report: goldenResult.report,
      scores: goldenResult.scores,
    },
  };

  // 2. Live data evaluation (optional)
  if (includeLive) {
    const livePairs = loadLiveBulletPairs({ resumeDir });
    if (livePairs.length > 0) {
      const liveResult = useEmbeddings
        ? await runEvaluation(livePairs)
        : runOfflineEvaluation(livePairs);
      result.live = {
        pairsFound: livePairs.length,
        report: liveResult.report,
        scores: liveResult.scores,
      };
    }
  }

  // 3. Candidate-vs-resume evaluation (optional)
  if (includeCandidates) {
    const candidatePairs = loadCandidateVsResumePairs({ dailyDir, resumeDir });
    if (candidatePairs.length > 0) {
      const candidateResult = useEmbeddings
        ? await runEvaluation(candidatePairs)
        : runOfflineEvaluation(candidatePairs);
      result.candidates = {
        pairsFound: candidatePairs.length,
        report: candidateResult.report,
        scores: candidateResult.scores,
      };
    }
  }

  // 4. Combined summary
  const allScores = [
    ...goldenResult.scores,
    ...(result.live?.scores || []),
    ...(result.candidates?.scores || []),
  ];
  const totalUsable = allScores.filter((s) => s.isUsable).length;
  result.combined = {
    totalBullets: allScores.length,
    usableBullets: totalUsable,
    usableRate: allScores.length > 0 ? _round(totalUsable / allScores.length) : 0,
    passed: allScores.length > 0 && totalUsable / allScores.length >= QUALITY_TARGET_RATE,
  };

  return result;
}

// ─── JSON Output ──────────────────────────────────────────────────────────

/**
 * Format an evaluation result as a JSON string suitable for CI output.
 *
 * Returns a compact JSON object with pass/fail status, key metrics,
 * and optionally full score details.
 *
 * @param {object} evalResult — from runOfflineEvaluation, runEvaluation, or runFullEvaluation
 * @param {object} [options]
 * @param {boolean} [options.includeScores=false] — include per-bullet score details
 * @param {boolean} [options.pretty=false]        — pretty-print the JSON
 * @returns {string} — JSON string
 */
export function formatReportJSON(evalResult, options = {}) {
  const { includeScores = false, pretty = false } = options;

  // Handle both single evaluation and full evaluation results
  const report = evalResult.report || evalResult.golden?.report;
  const scores = evalResult.scores || evalResult.golden?.scores;
  const passed = evalResult.passed ?? evalResult.golden?.passed ?? evalResult.combined?.passed;

  const output = {
    passed,
    timestamp: new Date().toISOString(),
    qualityTarget: QUALITY_TARGET_RATE,
    modificationThreshold: MODIFICATION_THRESHOLD,
    summary: {
      totalBullets: report?.totalBullets ?? 0,
      usableBullets: report?.usableBullets ?? 0,
      usableRate: report?.usableRate ?? 0,
      meanSimilarity: report?.meanSimilarity ?? 0,
      meanModificationDistance: report?.meanModificationDistance ?? 0,
    },
    distribution: report?.distribution ?? {},
    percentiles: report?.percentiles ?? {},
    classificationAccuracy: report?.classificationAccuracy ?? null,
  };

  // Include combined metrics for full evaluation results
  if (evalResult.combined) {
    output.combined = evalResult.combined;
  }

  // Include live data summary if present
  if (evalResult.live) {
    output.live = {
      pairsFound: evalResult.live.pairsFound,
      usableRate: evalResult.live.report?.usableRate ?? 0,
    };
  }

  // Include candidate data summary if present
  if (evalResult.candidates) {
    output.candidates = {
      pairsFound: evalResult.candidates.pairsFound,
      usableRate: evalResult.candidates.report?.usableRate ?? 0,
    };
  }

  if (includeScores && scores) {
    output.scores = scores.map((s) => ({
      id: s.id,
      similarity: s.similarity,
      modificationDistance: s.modificationDistance,
      isUsable: s.isUsable,
      bucket: s.bucket,
      classificationCorrect: s.classificationCorrect,
    }));
  }

  return JSON.stringify(output, null, pretty ? 2 : 0);
}

// ─── Live Data Helpers ──────────────────────────────────────────────────────

/**
 * Resolve data directory path relative to project root.
 * Tries both CWD-relative and __dirname-relative paths.
 */
function _resolveDataDir(relPath) {
  // Try CWD first (common for CLI usage)
  const cwdPath = resolve(process.cwd(), relPath);
  if (existsSync(cwdPath)) return cwdPath;

  // Try relative to this file's location (src/lib/ → project root)
  const filePath = resolve(new URL(".", import.meta.url).pathname, "../..", relPath);
  if (existsSync(filePath)) return filePath;

  return cwdPath; // fallback to CWD path
}

/**
 * Load and parse a JSON file, returning null on any error.
 */
function _loadJsonSafe(filePath) {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extract bullet texts with their _source from a resume snapshot.
 * Walks experience, projects, and any section with bullet items.
 */
function _extractBulletsWithSource(snapshot) {
  const bullets = [];

  // Experience sections
  const experience = snapshot.experience || snapshot.work_experience || [];
  for (const entry of (Array.isArray(experience) ? experience : [])) {
    const items = entry.bullets || entry.items || entry.highlights || [];
    for (const item of items) {
      if (typeof item === "string") {
        bullets.push({ text: item, source: "system" });
      } else if (item && typeof item === "object") {
        const text = item.text || item.bullet || item.description || "";
        const source = item._source || "system";
        if (text) bullets.push({ text, source });
      }
    }
  }

  // Projects
  const projects = snapshot.projects || [];
  for (const proj of (Array.isArray(projects) ? projects : [])) {
    const items = proj.bullets || proj.items || proj.highlights || [];
    for (const item of items) {
      if (typeof item === "string") {
        bullets.push({ text: item, source: "system" });
      } else if (item && typeof item === "object") {
        const text = item.text || item.bullet || item.description || "";
        const source = item._source || "system";
        if (text) bullets.push({ text, source });
      }
    }
  }

  return bullets;
}

/**
 * Extract all bullet texts (flat) from a resume snapshot, regardless of source.
 */
function _extractAllBulletTexts(snapshot) {
  return _extractBulletsWithSource(snapshot).map((b) => b.text);
}

/**
 * Find the closest system-sourced bullet to a given text using offline similarity.
 */
function _findClosestSystemBullet(text, bullets) {
  let best = null;
  let bestSim = 0;

  for (const b of bullets) {
    if (b.source !== "system") continue;
    const result = computeBulletSimilarity(text, b.text);
    if (result.similarity > bestSim) {
      bestSim = result.similarity;
      best = { text: b.text, similarity: result.similarity };
    }
  }

  return best;
}

/**
 * Find the closest bullet text from a flat list using offline similarity.
 */
function _findClosestBullet(text, bulletTexts) {
  let best = null;
  let bestSim = 0;

  for (const t of bulletTexts) {
    const result = computeBulletSimilarity(text, t);
    if (result.similarity > bestSim) {
      bestSim = result.similarity;
      best = { text: t, similarity: result.similarity };
    }
  }

  return best;
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────

/**
 * Run the harness from the command line.
 *
 * Usage:
 *   node src/lib/bulletQualityHarness.mjs [--json] [--full] [--embeddings] [--scores]
 *
 * Flags:
 *   --json       — output JSON instead of human-readable text
 *   --full       — include live data and candidate comparisons
 *   --embeddings — use OpenAI embedding API (requires OPENAI_API_KEY)
 *   --scores     — include per-bullet score details in output
 *   --quiet      — only output pass/fail exit code (no text)
 */
export async function runCLI(argv = process.argv.slice(2)) {
  const flags = new Set(argv);
  const useJson = flags.has("--json");
  const useFull = flags.has("--full");
  const useEmbeddings = flags.has("--embeddings");
  const includeScores = flags.has("--scores");
  const quiet = flags.has("--quiet");

  try {
    let result;
    if (useFull) {
      result = await runFullEvaluation({ useEmbeddings });
      if (quiet) {
        process.exitCode = result.combined.passed ? 0 : 1;
        return result;
      }
      if (useJson) {
        console.log(formatReportJSON(result, { includeScores, pretty: true }));
      } else {
        console.log(formatReport(result.golden.report));
        if (result.live) {
          console.log("\n  ── Live Data Evaluation ──");
          console.log(`  Pairs found: ${result.live.pairsFound}`);
          console.log(formatReport(result.live.report));
        }
        if (result.candidates) {
          console.log("\n  ── Candidate vs. Resume Evaluation ──");
          console.log(`  Pairs found: ${result.candidates.pairsFound}`);
          console.log(formatReport(result.candidates.report));
        }
        console.log("\n  ── Combined Summary ──");
        console.log(`  Total: ${result.combined.totalBullets} bullets`);
        console.log(`  Usable: ${result.combined.usableBullets} (${(result.combined.usableRate * 100).toFixed(1)}%)`);
        console.log(`  Overall: ${result.combined.passed ? "✓ PASSED" : "✗ FAILED"}`);
      }
      process.exitCode = result.combined.passed ? 0 : 1;
    } else {
      result = useEmbeddings
        ? await runEvaluation(GOLDEN_BULLET_PAIRS)
        : runOfflineEvaluation(GOLDEN_BULLET_PAIRS);

      if (quiet) {
        process.exitCode = result.passed ? 0 : 1;
        return result;
      }
      if (useJson) {
        console.log(formatReportJSON(result, { includeScores, pretty: true }));
      } else {
        console.log(formatReport(result.report));
      }
      process.exitCode = result.passed ? 0 : 1;
    }
    return result;
  } catch (err) {
    console.error("Bullet quality evaluation failed:", err.message);
    process.exitCode = 2;
    return null;
  }
}

// Auto-run when executed directly
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("bulletQualityHarness.mjs") ||
   process.argv[1].includes("bulletQualityHarness"));

if (isMainModule) {
  runCLI();
}

// ─── Exports for testing ────────────────────────────────────────────────────
export const _testing = {
  _normalizePairs,
  _buildEvalReport,
  _extractBulletsWithSource,
  _extractAllBulletTexts,
  _findClosestSystemBullet,
  _findClosestBullet,
  _loadJsonSafe,
  _resolveDataDir,
};
