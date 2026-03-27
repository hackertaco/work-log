/**
 * Resume Strength Keywords — data model, schema constants, and initialization logic.
 *
 * Strength keywords are an unstructured list (flat string array) that captures
 * marketable skills and traits extracted from the user's resume at bootstrap time
 * and incrementally updated as work logs are processed.
 *
 * Storage:
 *   Primary:   `resume/strength-keywords.json` in Vercel Blob (dedicated file)
 *   Secondary: `strength_keywords: string[]` field in `resume/data.json`
 *
 * The dedicated file allows keyword reads without fetching the full resume
 * document.  Both copies are kept in sync by the routes that mutate keywords.
 *
 * Schema (StrengthKeywordsDocument):
 *   {
 *     schemaVersion: 1,
 *     updatedAt:     ISO 8601 string,
 *     source:        "bootstrap" | "user" | "system",
 *     keywords:      string[]          // ordered, deduplicated, non-empty strings
 *   }
 *
 * Design notes:
 *   - Comparison and deduplication are always case-insensitive.
 *   - Insertion order is preserved; duplicates (case-insensitive) are dropped silently.
 *   - Each keyword is trimmed of surrounding whitespace before storage.
 *   - An empty list is valid — it means no keywords have been identified yet.
 *   - No per-keyword metadata (source, timestamp) is tracked on Day 1.
 *   - `source` in the document header reflects the most recent bulk operation:
 *       "bootstrap" — populated by the initial LLM bootstrap call
 *       "user"      — user added/removed keywords directly
 *       "system"    — system-generated update (e.g. work-log extraction)
 *
 * Public API:
 *   STRENGTH_KEYWORDS_SCHEMA_VERSION  — number constant (1)
 *   MAX_KEYWORD_LENGTH                — character limit per keyword (80)
 *   MAX_KEYWORDS                      — maximum list size (50)
 *
 *   createEmptyStrengthKeywordsDoc()                → StrengthKeywordsDocument
 *   initStrengthKeywordsFromBootstrap(raw)          → StrengthKeywordsDocument
 *   mergeKeywords(existing, incoming)               → string[]
 *   removeKeyword(existing, keyword)                → string[]
 *   replaceKeywords(newKeywords, source?)           → StrengthKeywordsDocument
 *   normalizeKeyword(kw)                            → string | null
 *   validateStrengthKeywordsDoc(doc)                → boolean
 *   extractKeywordsArray(doc)                       → string[]
 *
 * @module resumeStrengthKeywords
 */

// ─── Schema version ────────────────────────────────────────────────────────────

/**
 * Current schema version for the StrengthKeywordsDocument stored in Vercel Blob.
 * Increment when a breaking field change requires a migration.
 * @type {1}
 */
export const STRENGTH_KEYWORDS_SCHEMA_VERSION = 1;

// ─── Limits ───────────────────────────────────────────────────────────────────

/**
 * Maximum character length allowed for a single keyword (post-trim).
 * Keywords exceeding this length are silently dropped during normalization.
 * @type {80}
 */
export const MAX_KEYWORD_LENGTH = 80;

/**
 * Maximum number of keywords the list may contain.
 * When adding keywords would exceed this limit, the incoming keywords are
 * appended up to the cap and any extras are silently dropped.
 * @type {50}
 */
export const MAX_KEYWORDS = 50;

// ─── Initialization ────────────────────────────────────────────────────────────

/**
 * Create an empty StrengthKeywordsDocument.
 *
 * Used when initializing storage for the first time (before any bootstrap)
 * or when resetting the keyword list.
 *
 * @returns {import("./resumeTypes.mjs").StrengthKeywordsDocument}
 */
export function createEmptyStrengthKeywordsDoc() {
  return {
    schemaVersion: STRENGTH_KEYWORDS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    source: "system",
    keywords: []
  };
}

/**
 * Initialize a StrengthKeywordsDocument from the raw LLM bootstrap output.
 *
 * Accepts the `strengthKeywords` array returned by `resumeBootstrap.mjs`
 * (or any raw string array) and produces a validated, normalized document
 * suitable for storage in Vercel Blob.
 *
 * Steps:
 *   1. Accept `raw` as any value — arrays, null, undefined are all handled.
 *   2. Normalize each element: trim whitespace, enforce MAX_KEYWORD_LENGTH.
 *   3. Deduplicate case-insensitively, preserving first-occurrence order.
 *   4. Truncate to MAX_KEYWORDS.
 *
 * @param {unknown} raw  Raw keyword array from LLM output (may be null/undefined).
 * @returns {import("./resumeTypes.mjs").StrengthKeywordsDocument}
 */
export function initStrengthKeywordsFromBootstrap(raw) {
  const normalized = _normalizeAndDedup(raw);
  return {
    schemaVersion: STRENGTH_KEYWORDS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    source: "bootstrap",
    keywords: normalized
  };
}

// ─── Mutation helpers ──────────────────────────────────────────────────────────

/**
 * Merge `incoming` keywords into `existing` keyword list.
 *
 * Semantics:
 *   - Case-insensitive deduplication: a keyword already present in `existing`
 *     (case-insensitively) is not added again.
 *   - The order of `existing` keywords is preserved; new keywords are appended.
 *   - The combined list is truncated to MAX_KEYWORDS.
 *   - Invalid entries (non-strings, empty after trim, over MAX_KEYWORD_LENGTH)
 *     are silently dropped.
 *
 * @param {string[]} existing  Current keyword list (already normalized).
 * @param {unknown}  incoming  New keywords to add (may be a single string or array).
 * @returns {string[]}         Merged, deduplicated list (≤ MAX_KEYWORDS entries).
 */
export function mergeKeywords(existing, incoming) {
  const safeExisting = Array.isArray(existing) ? existing : [];
  const incomingArr = Array.isArray(incoming)
    ? incoming
    : typeof incoming === "string"
    ? [incoming]
    : [];

  // Build a Set of lowercase existing for O(1) dedup lookup.
  const seen = new Set(safeExisting.map((k) => (typeof k === "string" ? k.toLowerCase() : "")));
  const result = [...safeExisting];

  for (const kw of incomingArr) {
    if (result.length >= MAX_KEYWORDS) break;
    const normalized = normalizeKeyword(kw);
    if (normalized === null) continue;
    const lower = normalized.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(normalized);
  }

  return result;
}

/**
 * Remove a single keyword from the existing list (case-insensitive match).
 *
 * Returns a new array without the matched keyword.  All other keywords are
 * preserved in their original order and casing.
 *
 * @param {string[]} existing  Current keyword list.
 * @param {string}   keyword   Keyword to remove.
 * @returns {string[]}         List with the keyword removed (if it was present).
 */
export function removeKeyword(existing, keyword) {
  if (!Array.isArray(existing)) return [];
  if (typeof keyword !== "string") return [...existing];
  const lower = keyword.trim().toLowerCase();
  return existing.filter((k) => typeof k === "string" && k.toLowerCase() !== lower);
}

/**
 * Replace the entire keyword list with a new set of keywords.
 *
 * Normalizes and deduplicates the incoming array, then wraps it in a
 * new StrengthKeywordsDocument envelope with the given `source` tag.
 *
 * @param {unknown}  newKeywords  Replacement keyword list (any input shape).
 * @param {string}   [source="user"]  Provenance tag for this replacement.
 * @returns {import("./resumeTypes.mjs").StrengthKeywordsDocument}
 */
export function replaceKeywords(newKeywords, source = "user") {
  const normalized = _normalizeAndDedup(newKeywords);
  return {
    schemaVersion: STRENGTH_KEYWORDS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    source: typeof source === "string" && source ? source : "user",
    keywords: normalized
  };
}

// ─── Normalization ─────────────────────────────────────────────────────────────

/**
 * Normalize a single keyword string.
 *
 * Returns `null` when the input is:
 *   - not a string
 *   - empty or whitespace-only after trimming
 *   - longer than MAX_KEYWORD_LENGTH characters after trimming
 *
 * @param {unknown} kw  Raw keyword value.
 * @returns {string | null}  Trimmed keyword, or null if invalid.
 */
export function normalizeKeyword(kw) {
  if (typeof kw !== "string") return null;
  const trimmed = kw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_KEYWORD_LENGTH) return null;
  return trimmed;
}

// ─── Validation ────────────────────────────────────────────────────────────────

/**
 * Type guard: returns `true` when `doc` is a valid StrengthKeywordsDocument.
 *
 * Checks:
 *   - `doc` is a non-null plain object
 *   - `doc.schemaVersion` is a positive integer
 *   - `doc.keywords` is an array of strings
 *   - `doc.updatedAt` is a non-empty string
 *
 * Does NOT enforce MAX_KEYWORDS or MAX_KEYWORD_LENGTH — those limits apply
 * at write time only, not during reads.
 *
 * @param {unknown} doc
 * @returns {boolean}
 */
export function validateStrengthKeywordsDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  if (typeof doc.schemaVersion !== "number" || doc.schemaVersion <= 0) return false;
  if (!Array.isArray(doc.keywords)) return false;
  if (typeof doc.updatedAt !== "string" || !doc.updatedAt) return false;
  // Ensure every element in keywords is a string (best-effort check).
  for (const kw of doc.keywords) {
    if (typeof kw !== "string") return false;
  }
  return true;
}

/**
 * Extract the flat keyword array from a StrengthKeywordsDocument.
 *
 * Returns an empty array when `doc` is null/undefined or invalid.
 * Safe to call with any value — never throws.
 *
 * @param {unknown} doc
 * @returns {string[]}
 */
export function extractKeywordsArray(doc) {
  if (!doc || typeof doc !== "object") return [];
  if (!Array.isArray(doc.keywords)) return [];
  return doc.keywords.filter((kw) => typeof kw === "string");
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a raw input value into a deduplicated, truncated string array.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function _normalizeAndDedup(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const result = [];

  for (const kw of arr) {
    if (result.length >= MAX_KEYWORDS) break;
    const normalized = normalizeKeyword(kw);
    if (normalized === null) continue;
    const lower = normalized.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(normalized);
  }

  return result;
}
