/**
 * Cache read/write service layer for daily resume bullets.
 *
 * Implements Sub-AC 14-2: on resume bullet request, serve from the primary
 * DailyBulletsDocument cache when valid; on a cache miss or stale schema,
 * trigger reconstruction from the raw batch summarization cache and repopulate
 * the primary cache.
 *
 * Cache hierarchy
 * ───────────────
 *   Primary cache:        resume/bullets/{date}.json     — DailyBulletsDocument
 *   Reconstruction source: cache/bullets/{date}.json     — raw batch summarization result
 *
 * The primary cache is considered valid when the document exists AND its
 * `schemaVersion` matches the current `DAILY_BULLETS_SCHEMA_VERSION`.  A
 * schema mismatch means the document was written by an incompatible schema
 * revision and must be rebuilt from the reconstruction source.
 *
 * Cache result signals (exported constants)
 * ─────────────────────────────────────────
 *   BULLET_CACHE_HIT          — valid primary cache served as-is
 *   BULLET_CACHE_RECONSTRUCTED — rebuilt from raw batch cache; primary cache repopulated
 *   BULLET_CACHE_MISS          — neither primary cache nor raw batch result available
 *
 * Design decisions
 * ────────────────
 *   • The function never throws — errors are caught internally and cause a
 *     graceful MISS so the caller always receives a structured result.
 *   • When a stale-schema document is present, its user-applied statuses
 *     (promoted/dismissed bullets) are preserved via a merge before the
 *     reconstructed document is saved.  User actions always survive reconstruction.
 *   • Cache write on reconstruction is fire-and-forget — a failed write logs a
 *     warning but does not prevent the caller from receiving the reconstructed doc.
 *
 * Environment variable:
 *   BLOB_READ_WRITE_TOKEN — required by Vercel Blob; without it both
 *                           readDailyBullets and readBulletCache will return
 *                           null/throw, resulting in a MISS.
 *
 * @module resumeDailyBulletsService
 */

import { readDailyBullets, saveDailyBullets } from "./blob.mjs";
import { readBulletCache } from "./bulletCache.mjs";
import {
  buildDailyBulletsDocument,
  mergeDailyBulletsDocuments,
  DAILY_BULLETS_SCHEMA_VERSION
} from "./resumeDailyBullets.mjs";

// ─── Cache result source constants ────────────────────────────────────────────

/**
 * Indicates the result was served directly from the valid DailyBulletsDocument
 * already stored in Vercel Blob (primary cache hit — no reconstruction needed).
 *
 * @type {string}
 */
export const BULLET_CACHE_HIT = "cache_hit";

/**
 * Indicates the DailyBulletsDocument was absent or had a stale schema and was
 * rebuilt from the raw batch summarization result stored in the bullet cache.
 * The rebuilt document has been asynchronously persisted back to Blob so future
 * requests will hit the primary cache directly.
 *
 * @type {string}
 */
export const BULLET_CACHE_RECONSTRUCTED = "reconstructed";

/**
 * Indicates that no usable data is available for the requested date:
 *   - The primary DailyBulletsDocument is absent or has a stale schema, AND
 *   - No raw batch summarization result exists to reconstruct from.
 *
 * Callers should treat this as "no data for this date" (404).
 *
 * @type {string}
 */
export const BULLET_CACHE_MISS = "miss";

// ─── Pure validation helper ────────────────────────────────────────────────────

/**
 * Determine whether a DailyBulletsDocument is valid for serving without
 * reconstruction.
 *
 * A document is valid when it is non-null and its `schemaVersion` matches the
 * current `DAILY_BULLETS_SCHEMA_VERSION`.  Any mismatch — including a missing
 * `schemaVersion` field — is treated as stale and triggers reconstruction.
 *
 * This is a pure function with no I/O and is exported for use in unit tests
 * and by callers that have already fetched a document and need to re-validate.
 *
 * @param {object|null|undefined} doc  Candidate DailyBulletsDocument
 * @returns {boolean}  true when the document can be served as-is
 */
export function isBulletDocumentValid(doc) {
  return doc != null && doc.schemaVersion === DAILY_BULLETS_SCHEMA_VERSION;
}

// ─── Main service ──────────────────────────────────────────────────────────────

/**
 * Return the DailyBulletsDocument for a specific work-log date, using a
 * cache-first strategy with automatic reconstruction on miss or staleness.
 *
 * Pipeline:
 *   1. Read the DailyBulletsDocument from `resume/bullets/{date}.json`.
 *      → Valid (exists + correct schemaVersion): return immediately as HIT.
 *      → Invalid (absent or stale schema): fall through to step 2.
 *   2. Read the raw batch summarization result from `cache/bullets/{date}.json`
 *      via readBulletCache.
 *      → Not found: return { source: BULLET_CACHE_MISS, doc: null }.
 *   3. Build a fresh DailyBulletsDocument from the raw batch result
 *      (via buildDailyBulletsDocument).  If a stale-schema document was present
 *      in step 1, merge it with the fresh one so that user-applied statuses
 *      (promoted/dismissed bullets) are preserved.
 *   4. Persist the reconstructed document back to Blob (fire-and-forget).
 *   5. Return { source: BULLET_CACHE_RECONSTRUCTED, doc }.
 *
 * @param {string} date  ISO date string YYYY-MM-DD
 * @returns {Promise<{
 *   source: "cache_hit"|"reconstructed"|"miss",
 *   doc:    object|null
 * }>}
 *   source — BULLET_CACHE_HIT | BULLET_CACHE_RECONSTRUCTED | BULLET_CACHE_MISS
 *   doc    — DailyBulletsDocument for HIT/RECONSTRUCTED; null for MISS
 */
export async function getOrReconstructDailyBullets(date) {
  const tag = `[dailyBulletsService date="${date}"]`;

  // ── Step 1: Try primary cache (DailyBulletsDocument) ────────────────────────

  let existingDoc = null;
  try {
    existingDoc = await readDailyBullets(date);
  } catch (err) {
    console.warn(
      `${tag} primary cache read failed (non-fatal):`,
      err.message ?? String(err)
    );
    // existingDoc remains null; fall through to reconstruction
  }

  if (isBulletDocumentValid(existingDoc)) {
    console.info(`${tag} primary cache HIT`);
    return { source: BULLET_CACHE_HIT, doc: existingDoc };
  }

  if (existingDoc != null) {
    // Document present but schemaVersion does not match — it is stale.
    console.info(
      `${tag} stale schema (v${existingDoc.schemaVersion} ≠ expected v${DAILY_BULLETS_SCHEMA_VERSION}) — triggering reconstruction`
    );
  } else {
    console.info(`${tag} primary cache MISS — attempting reconstruction`);
  }

  // ── Step 2: Try raw batch summarization cache (reconstruction source) ────────

  let rawResult = null;
  try {
    rawResult = await readBulletCache(date);
  } catch (err) {
    console.warn(
      `${tag} raw bullet cache read failed (non-fatal):`,
      err.message ?? String(err)
    );
  }

  // The raw result must have a `resume` sub-object with the candidate arrays
  // expected by buildDailyBulletsDocument.
  if (!rawResult || !rawResult.resume) {
    console.info(`${tag} no raw batch result available — MISS`);
    return { source: BULLET_CACHE_MISS, doc: null };
  }

  // ── Step 3: Reconstruct DailyBulletsDocument from raw batch result ───────────

  const freshDoc = buildDailyBulletsDocument(date, rawResult.resume);

  // If a stale-schema doc was present, merge it with the fresh one.
  // mergeDailyBulletsDocuments preserves promote/dismiss statuses from the
  // existing document, so user actions survive a schema-triggered rebuild.
  const docToSave =
    existingDoc != null
      ? mergeDailyBulletsDocuments(existingDoc, freshDoc)
      : freshDoc;

  // ── Step 4: Persist reconstructed document (fire-and-forget) ────────────────

  saveDailyBullets(date, docToSave).catch((err) => {
    console.warn(
      `${tag} failed to persist reconstructed document (non-fatal):`,
      err.message ?? String(err)
    );
  });

  console.info(
    `${tag} reconstruction complete — ${docToSave.bullets.length} bullet(s)`
  );

  return { source: BULLET_CACHE_RECONSTRUCTED, doc: docToSave };
}
