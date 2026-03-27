/**
 * Conditional Re-clustering Pipeline (Sub-AC 17-3)
 *
 * Monitors the ratio of unclassified keywords — keywords present in the
 * resume or recent work logs that are NOT assigned to any existing display axis
 * — and automatically triggers a new LLM clustering pass when that ratio
 * exceeds a configurable threshold (default 30 %).
 *
 * The resulting new axes are merged with the existing set, respecting user
 * provenance: axes whose `_source === "user"` are never overwritten.
 *
 * Public API:
 *   reclusterPipeline(resume, workLogs, options)  → Promise<ReclusterResult>
 *   computeUnclassifiedRatio(allKeywords, axes)   → number   (0–1)
 *   shouldRecluster(allKeywords, axes, threshold) → boolean
 *   mergeAxes(existingAxes, newAxes)              → Axis[]
 *
 * Exported for unit-testing:
 *   _adaptWorkLogEntries(entries)  → { resumeBullets }[]
 *   _dedup(keywords)               → string[]
 *
 * @module resumeRecluster
 */

import {
  clusterKeywords,
  collectResumeKeywords,
  collectWorkLogKeywords
} from "./resumeKeywordClustering.mjs";
import {
  migrateAxes,
  normalizeKeywords,
  createAxis
} from "./resumeAxes.mjs";

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Default unclassified-ratio threshold (30 %).  Trigger when ratio > this value. */
export const DEFAULT_RECLUSTER_THRESHOLD = 0.3;

/** Maximum number of axes that may be stored after merging. */
const MAX_AXES = 6;

/**
 * Minimum Jaccard-like overlap score between an existing system axis and a new
 * axis for the two to be considered "matching" (and thus merged rather than
 * kept as separate entries).
 */
const OVERLAP_THRESHOLD = 0.25;

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Axis
 * @property {string}   id        — Stable UUID.
 * @property {string}   label     — Display name.
 * @property {string[]} keywords  — Characteristic keywords.
 * @property {string}   [_source] — "user" | "system".
 */

/**
 * @typedef {Object} KeywordAxis
 * @property {string}   label    — Short thematic label (2–4 words).
 * @property {string[]} keywords — Keywords belonging to this axis.
 */

/**
 * @typedef {Object} ReclusterResult
 * @property {boolean} triggered          — Whether re-clustering was performed.
 * @property {number}  ratio              — Unclassified ratio (0–1) before recluster.
 * @property {Axis[]}  axes               — Final merged (or unchanged) axis array.
 * @property {number}  totalKeywords      — Total keyword count.
 * @property {number}  unclassifiedCount  — Unclassified keyword count before recluster.
 */

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Full conditional re-clustering pipeline.
 *
 * Steps:
 *   1. Collect all keywords from the resume and recent work logs.
 *   2. Compute the unclassified ratio against the current display axes.
 *   3. If ratio > threshold (or force=true), call the LLM to cluster keywords.
 *   4. Merge the new axes with the existing set, respecting user provenance.
 *   5. Return a {@link ReclusterResult} describing what happened.
 *
 * The function does NOT persist the result; the caller is responsible for
 * saving `result.axes` back to the resume document when `result.triggered` is
 * true.
 *
 * Work-log entries may be supplied in either of two formats:
 *   a) `{ resumeBullets: string[] }` — as expected by collectWorkLogKeywords()
 *   b) `{ candidates, companyCandidates, openSourceCandidates }` — as returned
 *      by gatherWorkLogBullets() in resumeReconstruction.mjs
 * Both formats are normalised internally via `_adaptWorkLogEntries()`.
 *
 * @param {object}   resume          - Resume document.
 * @param {object[]} [workLogs=[]]   - Work-log summary objects (either format above).
 * @param {object}   [options={}]
 * @param {boolean}  [options.force=false]   - Skip threshold check; always recluster.
 * @param {number}   [options.threshold]     - Override default 0.3 threshold (0–1).
 * @returns {Promise<ReclusterResult>}
 */
export async function reclusterPipeline(resume, workLogs = [], options = {}) {
  const threshold =
    typeof options.threshold === "number"
      ? Math.max(0, Math.min(1, options.threshold))
      : DEFAULT_RECLUSTER_THRESHOLD;
  const force = Boolean(options.force);

  // 1. Collect keywords from resume
  const resumeKws = collectResumeKeywords(resume);

  // 2. Adapt + collect keywords from work logs
  const adaptedLogs = _adaptWorkLogEntries(Array.isArray(workLogs) ? workLogs : []);
  const workLogKws = collectWorkLogKeywords(adaptedLogs);

  // Combined, deduplicated keyword pool
  const allKeywords = _dedup([...resumeKws, ...workLogKws]);

  // 3. Migrate and normalise existing axes
  const existingAxes = migrateAxes(
    Array.isArray(resume?.display_axes) ? resume.display_axes : []
  );

  // 4. Compute unclassified ratio
  const ratio = computeUnclassifiedRatio(allKeywords, existingAxes);
  const unclassifiedCount = Math.round(ratio * allKeywords.length);

  // 5. Decide whether to recluster
  if (!force && !shouldRecluster(allKeywords, existingAxes, threshold)) {
    return {
      triggered: false,
      ratio,
      axes: existingAxes,
      totalKeywords: allKeywords.length,
      unclassifiedCount
    };
  }

  // 6. Run LLM clustering on the full keyword pool
  let newClusteredAxes;
  try {
    newClusteredAxes = await clusterKeywords(resumeKws, workLogKws);
  } catch (err) {
    throw new Error(`LLM clustering failed: ${err.message ?? String(err)}`);
  }

  // 7. Merge new axes with existing (user axes preserved)
  const mergedAxes = mergeAxes(existingAxes, newClusteredAxes);

  return {
    triggered: true,
    ratio,
    axes: mergedAxes,
    totalKeywords: allKeywords.length,
    unclassifiedCount
  };
}

/**
 * Compute the fraction of keywords (from `allKeywords`) that are not assigned
 * to any axis in `axes`.
 *
 * A keyword is considered "classified" when it appears (case-insensitively) in
 * the `keywords` array of at least one existing axis.
 *
 * @param {string[]} allKeywords - Flat list of all candidate keywords.
 * @param {Axis[]}   axes        - Current display axes.
 * @returns {number}             - Value in [0, 1].  0 = all classified; 1 = none classified.
 */
export function computeUnclassifiedRatio(allKeywords, axes) {
  if (!Array.isArray(allKeywords) || allKeywords.length === 0) return 0;

  // Build a lower-cased set of all keywords that are assigned to some axis
  const classified = new Set();
  if (Array.isArray(axes)) {
    for (const axis of axes) {
      if (!axis || !Array.isArray(axis.keywords)) continue;
      for (const kw of axis.keywords) {
        if (typeof kw === "string" && kw.trim()) {
          classified.add(kw.trim().toLowerCase());
        }
      }
    }
  }

  let unclassifiedCount = 0;
  for (const kw of allKeywords) {
    if (typeof kw !== "string") {
      unclassifiedCount++;
      continue;
    }
    if (!classified.has(kw.trim().toLowerCase())) {
      unclassifiedCount++;
    }
  }

  return unclassifiedCount / allKeywords.length;
}

/**
 * Returns true when re-clustering should be triggered.
 *
 * Re-clustering is warranted when:
 *   - At least 1 keyword exists in the pool, AND
 *   - The unclassified ratio strictly exceeds `threshold`.
 *
 * @param {string[]} allKeywords
 * @param {Axis[]}   axes
 * @param {number}   [threshold=DEFAULT_RECLUSTER_THRESHOLD]
 * @returns {boolean}
 */
export function shouldRecluster(
  allKeywords,
  axes,
  threshold = DEFAULT_RECLUSTER_THRESHOLD
) {
  if (!Array.isArray(allKeywords) || allKeywords.length === 0) return false;
  const ratio = computeUnclassifiedRatio(allKeywords, axes);
  return ratio > threshold;
}

/**
 * Merge a freshly-clustered set of axes into the existing axis set.
 *
 * Merge rules (applied in priority order):
 *   1. **User-edited axes** (`_source === "user"`) are always preserved unchanged.
 *   2. **Existing system axes** that overlap with a new axis (Jaccard score ≥
 *      OVERLAP_THRESHOLD) are updated: their keywords are replaced with the
 *      union of both axes' keywords (capped at 30); the label is preserved.
 *   3. **New axes** that do not overlap with any existing system axis are
 *      appended as new system-sourced axes.
 *   4. Total axis count is capped at MAX_AXES (6).
 *
 * Each new axis is matched to at most one existing axis (greedy, best-score
 * first), and each existing axis absorbs at most one new axis.
 *
 * @param {Axis[]}        existingAxes  - Current axes (may include migrated items).
 * @param {KeywordAxis[]} newAxes       - Freshly clustered axes from the LLM.
 * @returns {Axis[]}                    - Merged axis array (new instances; no mutations).
 */
export function mergeAxes(existingAxes, newAxes) {
  const existing = Array.isArray(existingAxes) ? existingAxes : [];
  const incoming = Array.isArray(newAxes) ? newAxes : [];

  // Split existing axes by provenance
  const userAxes   = existing.filter((a) => a?._source === "user");
  const systemAxes = existing.filter((a) => a?._source !== "user");

  // Track which incoming axes have already been merged into a system axis
  const mergedNewIndices = new Set();

  // For each system axis, attempt to find the best-matching incoming axis
  const updatedSystemAxes = systemAxes.map((sysAxis) => {
    const matchIdx = _findBestMatchIndex(sysAxis, incoming, mergedNewIndices);
    if (matchIdx === -1) return sysAxis; // No qualifying match — keep unchanged

    mergedNewIndices.add(matchIdx);
    const matchedNew = incoming[matchIdx];

    // Merge keywords: union of both sets (normalizeKeywords handles dedup + cap)
    const mergedKeywords = normalizeKeywords([
      ...sysAxis.keywords,
      ...matchedNew.keywords
    ]);

    return { ...sysAxis, keywords: mergedKeywords, _source: "system" };
  });

  // Incoming axes that didn't match any existing system axis → append as new
  const appendedAxes = incoming
    .filter((_, idx) => !mergedNewIndices.has(idx))
    .map((na) => createAxis(na.label, na.keywords, "system"));

  // Final order: user axes (highest priority) → updated system axes → new axes
  const combined = [...userAxes, ...updatedSystemAxes, ...appendedAxes];

  // Cap total axes at MAX_AXES
  return combined.slice(0, MAX_AXES);
}

// ─── Exported internal helpers (for unit-testing) ──────────────────────────────

/**
 * Adapt work-log entries to the format expected by `collectWorkLogKeywords`.
 *
 * `collectWorkLogKeywords` (from resumeKeywordClustering.mjs) expects each
 * entry to have an optional `keywords` string[] and/or `resumeBullets` string[].
 *
 * `gatherWorkLogBullets` (from resumeReconstruction.mjs) returns entries shaped
 * as `{ date, candidates, companyCandidates, openSourceCandidates }`.
 *
 * This adapter handles both shapes transparently — if an entry already has a
 * `resumeBullets` field it is passed through unchanged; if it has the
 * gatherWorkLogBullets shape, its candidate arrays are flattened into
 * `resumeBullets`.
 *
 * @param {object[]} entries  - Work-log entries in either shape.
 * @returns {{ resumeBullets?: string[], keywords?: string[] }[]}
 */
export function _adaptWorkLogEntries(entries) {
  if (!Array.isArray(entries)) return [];

  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return {};

    // Already in the collectWorkLogKeywords format — pass through
    if (Array.isArray(entry.resumeBullets)) return entry;

    // gatherWorkLogBullets format → flatten all candidate arrays into resumeBullets
    const bullets = [
      ...(Array.isArray(entry.candidates)          ? entry.candidates          : []),
      ...(Array.isArray(entry.companyCandidates)   ? entry.companyCandidates   : []),
      ...(Array.isArray(entry.openSourceCandidates)? entry.openSourceCandidates: [])
    ].filter((s) => typeof s === "string" && s.trim());

    const result = { resumeBullets: bullets };
    if (Array.isArray(entry.keywords)) result.keywords = entry.keywords;
    return result;
  });
}

/**
 * Case-insensitive deduplication, preserving first-occurrence casing.
 *
 * @param {string[]} keywords
 * @returns {string[]}
 */
export function _dedup(keywords) {
  if (!Array.isArray(keywords)) return [];
  const seen = new Set();
  const result = [];
  for (const k of keywords) {
    if (typeof k !== "string") continue;
    const t = k.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(t);
  }
  return result;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Find the index in `newAxes` whose keyword set has the highest Jaccard-like
 * overlap with `existingAxis.keywords`, requiring the score to exceed
 * OVERLAP_THRESHOLD.
 *
 * Already-merged indices (in `usedIndices`) are skipped.
 *
 * Jaccard score = |intersection| / |union|
 *
 * @param {Axis}          existingAxis
 * @param {KeywordAxis[]} newAxes
 * @param {Set<number>}   usedIndices
 * @returns {number}  Index into newAxes, or -1 if no qualifying match found.
 */
function _findBestMatchIndex(existingAxis, newAxes, usedIndices) {
  const existLower = new Set(
    (Array.isArray(existingAxis.keywords) ? existingAxis.keywords : [])
      .map((k) => k.toLowerCase())
  );
  if (existLower.size === 0) return -1;

  let bestIdx   = -1;
  let bestScore = OVERLAP_THRESHOLD; // Must strictly exceed threshold to qualify

  for (let i = 0; i < newAxes.length; i++) {
    if (usedIndices.has(i)) continue;
    const na = newAxes[i];
    if (!na || !Array.isArray(na.keywords) || na.keywords.length === 0) continue;

    const naLower     = na.keywords.map((k) => String(k).toLowerCase());
    const intersection = naLower.filter((k) => existLower.has(k)).length;

    // |union| = |A| + |B| - |intersection|
    const union = existLower.size + naLower.length - intersection;
    if (union <= 0) continue;

    const score = intersection / union;
    if (score > bestScore) {
      bestScore = score;
      bestIdx   = i;
    }
  }

  return bestIdx;
}
