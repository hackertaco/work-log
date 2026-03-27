/**
 * Resume Keyword Coverage — unclassified keyword ratio tracking (Sub-AC 17-2)
 *
 * Tracks what fraction of the total keyword pool has NOT yet been assigned to
 * any existing display axis.  When that fraction exceeds 30 % the system should
 * trigger a "suggest new axis" workflow.
 *
 * Design:
 *   • Pure functions — no side effects, no I/O, no mutations of inputs.
 *   • Case-insensitive comparisons (same convention as resumeAxes.mjs /
 *     resumeKeywordClustering.mjs).
 *   • Handles all edge cases (empty arrays, null/undefined, duplicate keywords).
 *
 * Public API:
 *   getUnclassifiedKeywords(allKeywords, axes)           → string[]
 *   computeUnclassifiedRatio(allKeywords, axes)          → number   (0.0 – 1.0)
 *   exceedsUnclassifiedThreshold(allKeywords, axes, threshold?) → boolean
 *
 * @module resumeKeywordCoverage
 */

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Default threshold for triggering a "suggest new axis" workflow (30 %). */
export const DEFAULT_UNCLASSIFIED_THRESHOLD = 0.3;

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the subset of `allKeywords` that does not appear in any axis's
 * keyword list.  Comparison is case-insensitive.
 *
 * Rules:
 *   - `allKeywords` is deduplicated (case-insensitive) before comparison so
 *     duplicate entries in the input are counted only once.
 *   - An axis entry that is not a plain object or whose `keywords` field is not
 *     an array is skipped gracefully.
 *
 * @param {string[]} allKeywords  Full keyword pool (from resume + work logs).
 * @param {object[]} axes         Current display axes (each has a `keywords` array).
 * @returns {string[]}            Keywords present in `allKeywords` but absent
 *                                from every axis.  Order matches the input order.
 */
export function getUnclassifiedKeywords(allKeywords, axes) {
  const pool = _deduplicateLower(allKeywords);
  if (pool.length === 0) return [];

  const classifiedLower = _collectAxisKeywordsLower(axes);

  return pool.filter(({ original, lower }) => !classifiedLower.has(lower))
    .map(({ original }) => original);
}

/**
 * Computes the ratio of unclassified keywords to the total (unique) keyword
 * pool size.
 *
 * Returns:
 *   - `0`   when `allKeywords` is empty (no keywords → nothing unclassified)
 *   - `1.0` when all keywords are unclassified
 *   - `0.0` when every keyword is covered by at least one axis
 *
 * @param {string[]} allKeywords  Full keyword pool.
 * @param {object[]} axes         Current display axes.
 * @returns {number}              Ratio in the range [0, 1].
 */
export function computeUnclassifiedRatio(allKeywords, axes) {
  const pool = _deduplicateLower(allKeywords);
  if (pool.length === 0) return 0;

  const classifiedLower = _collectAxisKeywordsLower(axes);
  const unclassifiedCount = pool.filter(({ lower }) => !classifiedLower.has(lower)).length;

  return unclassifiedCount / pool.length;
}

/**
 * Returns `true` when the unclassified keyword ratio strictly exceeds the
 * given threshold, signalling that a "suggest new axis" workflow should be
 * triggered.
 *
 * @param {string[]} allKeywords          Full keyword pool.
 * @param {object[]} axes                 Current display axes.
 * @param {number}   [threshold=0.3]      Ratio threshold (0 – 1 inclusive).
 *                                        Defaults to DEFAULT_UNCLASSIFIED_THRESHOLD.
 * @returns {boolean}  `true` when ratio > threshold, `false` otherwise.
 */
export function exceedsUnclassifiedThreshold(
  allKeywords,
  axes,
  threshold = DEFAULT_UNCLASSIFIED_THRESHOLD
) {
  const safeThreshold =
    typeof threshold === "number" && isFinite(threshold)
      ? Math.max(0, Math.min(1, threshold))
      : DEFAULT_UNCLASSIFIED_THRESHOLD;

  return computeUnclassifiedRatio(allKeywords, axes) > safeThreshold;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Deduplicate a raw string array case-insensitively, preserving the first
 * occurrence's original casing and order.
 *
 * @param {unknown} raw
 * @returns {{ original: string, lower: string }[]}
 */
function _deduplicateLower(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const result = [];

  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push({ original: trimmed, lower });
  }

  return result;
}

/**
 * Collect all lowercase keyword strings from an axes array.
 *
 * @param {unknown} axes
 * @returns {Set<string>}
 */
function _collectAxisKeywordsLower(axes) {
  const set = new Set();

  if (!Array.isArray(axes)) return set;

  for (const axis of axes) {
    if (!axis || typeof axis !== "object") continue;
    if (!Array.isArray(axis.keywords)) continue;

    for (const kw of axis.keywords) {
      if (typeof kw === "string" && kw.trim()) {
        set.add(kw.trim().toLowerCase());
      }
    }
  }

  return set;
}
