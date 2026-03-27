/**
 * Resume document migration utilities.
 *
 * Ensures that resume documents loaded from Vercel Blob conform to the
 * current data model.  Specifically:
 *
 *   1. `_sources` map is present with valid ItemSource values for the three
 *      core scalar sections (summary, contact, skills).
 *   2. All array items in experience, education, projects, and certifications
 *      carry a valid `_source` provenance tag.
 *
 * This migration is necessary because:
 *   - Documents bootstrapped before the _source field was introduced lack it.
 *   - Snapshot restores may load documents from any prior schema snapshot.
 *   - The bootstrap LLM output may occasionally omit _source when fed
 *     legacy JSON that predates the field.
 *
 * Design principles:
 *   • Pure function — no I/O, no external API calls.
 *   • Non-destructive — never changes the semantic content of a document;
 *     only adds missing metadata fields.
 *   • Idempotent — safe to call multiple times on the same document.
 *   • User-edit-preserving — "user" and "user_approved" _source values are
 *     always kept unchanged; only missing or unknown values default to "system".
 *   • Priority: user > user_approved > system  (highest to lowest protection).
 */

import { ITEM_SOURCE_VALUES } from "./resumeTypes.mjs";

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Migrate a raw resume document to the current schema.
 *
 * Called automatically by `readResumeData()` (blob.mjs) so that all
 * consumers of the living-resume document always receive a fully-normalised
 * structure regardless of when the document was originally saved.
 *
 * What this function does:
 *   1. Ensures `_sources` map exists; fills missing keys with "system".
 *   2. Preserves any extra `_sources` keys (e.g. display_axes, strength_keywords).
 *   3. Iterates experience / education / projects / certifications and sets
 *      `_source: "system"` on any item that lacks a valid provenance tag.
 *   4. Never modifies items whose `_source` is already "user" or "user_approved".
 *
 * @param {object|null} rawDoc  Resume document as parsed from Vercel Blob JSON
 * @returns {object|null}       Migrated document (new object) or the original
 *                              value unchanged when null / non-object input.
 */
export function migrateResumeDocument(rawDoc) {
  if (rawDoc === null || rawDoc === undefined) return rawDoc;
  if (typeof rawDoc !== "object" || Array.isArray(rawDoc)) return rawDoc;

  // Fast-path: skip allocation when nothing needs changing
  if (!needsMigration(rawDoc)) return rawDoc;

  const doc = { ...rawDoc };

  // ── 1. Ensure _sources map has valid core keys ────────────────────────────
  const prevSources =
    doc._sources &&
    typeof doc._sources === "object" &&
    !Array.isArray(doc._sources)
      ? { ...doc._sources }
      : {};

  doc._sources = {
    // Preserve any extra keys first (display_axes, strength_keywords, etc.)
    ...prevSources,
    // Override / fill the three mandatory core keys with validated values
    summary: _normalizeItemSource(prevSources.summary),
    contact: _normalizeItemSource(prevSources.contact),
    skills:  _normalizeItemSource(prevSources.skills)
  };

  // ── 2. Ensure _source on all array section items ──────────────────────────
  for (const section of _ARRAY_SECTIONS) {
    if (Array.isArray(doc[section])) {
      doc[section] = doc[section].map(_ensureItemSource);
    }
  }

  return doc;
}

/**
 * Determine whether a resume document requires migration.
 *
 * Useful for callers that want to detect schema gaps without allocating a
 * new object (e.g. logging or monitoring).
 *
 * @param {object|null} rawDoc
 * @returns {boolean}  true when migration is necessary; false when already canonical
 */
export function needsMigration(rawDoc) {
  if (!rawDoc || typeof rawDoc !== "object" || Array.isArray(rawDoc)) {
    return false;
  }

  // Missing or invalid _sources map
  if (!rawDoc._sources || typeof rawDoc._sources !== "object" || Array.isArray(rawDoc._sources)) {
    return true;
  }
  if (!ITEM_SOURCE_VALUES.includes(rawDoc._sources.summary)) return true;
  if (!ITEM_SOURCE_VALUES.includes(rawDoc._sources.contact)) return true;
  if (!ITEM_SOURCE_VALUES.includes(rawDoc._sources.skills))  return true;

  // Array section items missing _source
  for (const section of _ARRAY_SECTIONS) {
    const items = rawDoc[section];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (!ITEM_SOURCE_VALUES.includes(item._source)) return true;
    }
  }

  return false;
}

// ─── Private helpers ────────────────────────────────────────────────────────────

/**
 * Resume sections whose items carry individual `_source` tags.
 * @type {readonly string[]}
 */
const _ARRAY_SECTIONS = /** @type {const} */ ([
  "experience",
  "education",
  "projects",
  "certifications"
]);

/**
 * Normalise a raw `_source` value.
 *
 * "user" and "user_approved" survive unchanged (user edits always win).
 * Any other value — including undefined, null, or unknown strings — falls
 * back to "system".
 *
 * @param {unknown} src
 * @returns {"user"|"system"|"user_approved"}
 */
function _normalizeItemSource(src) {
  if (src === "user" || src === "user_approved") return src;
  return "system";
}

/**
 * Ensure a resume array item has a valid `_source` field.
 *
 * Returns the item unchanged (same reference) when `_source` is already
 * a recognised value — avoids unnecessary object allocations on hot paths.
 *
 * Non-object values (null, strings) are passed through untouched so that
 * malformed arrays do not cause errors.
 *
 * @param {unknown} item
 * @returns {unknown}
 */
function _ensureItemSource(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  // Already valid — no allocation needed
  if (ITEM_SOURCE_VALUES.includes(/** @type {any} */ (item)._source)) return item;
  return { .../** @type {object} */ (item), _source: _normalizeItemSource(/** @type {any} */ (item)._source) };
}
