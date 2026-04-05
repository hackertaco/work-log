/**
 * Vercel Blob-backed cache for daily resume bullet generation results.
 *
 * This module provides two independent caches:
 *
 * 1. BULLET CACHE (`cache/bullets/{date}.json`)
 *    Stores the full summarization result returned by `summarizeWithOpenAI`
 *    for a given date (batch pipeline output).
 *
 * 2. EXTRACT CACHE (`cache/extract/{date}.json`)
 *    Stores the WorkLogExtract result returned by `extractResumeUpdatesFromWorkLog`
 *    for a given date (generate-candidates pipeline output).
 *
 * Both caches prevent redundant LLM calls when the same date is reprocessed
 * (e.g. running the batch twice for the same day, or calling generate-candidates
 * multiple times for the same work log date).
 *
 * Design decisions:
 *   - Cache key = date string (YYYY-MM-DD).  For a given date the input
 *     corpus is effectively stable (git commits, shell history, sessions
 *     don't change retroactively once the batch has run), so keying on
 *     date alone is sufficient and avoids the cost of hashing large payloads.
 *   - If BLOB_READ_WRITE_TOKEN is absent (local dev without Blob), reads
 *     return null and writes are silently skipped — the caller falls back
 *     to a live LLM call as normal.
 *   - schemaVersion guards against stale entries from incompatible schema
 *     changes; a mismatch causes a cache miss (re-generate + overwrite).
 *   - The two caches use separate path prefixes so they never collide,
 *     even though both are keyed by date.
 *
 * Environment variable:
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token (optional; cache is no-op without it)
 */

import { list, put } from "@vercel/blob";

// ─── Bullet cache (batch summarization results) ───────────────────────────────

const CACHE_PREFIX = "cache/bullets/";
const CACHE_SCHEMA_VERSION = 2;

// ─── Extract cache (WorkLogExtract results for generate-candidates) ───────────

const EXTRACT_CACHE_PREFIX = "cache/extract/";

/**
 * Schema version for the extract cache entries.
 *
 * Increment this constant when the WorkLogExtract shape changes in a
 * backward-incompatible way — existing cached entries will then be treated as
 * misses and re-generated automatically.
 */
const EXTRACT_CACHE_SCHEMA_VERSION = 1;

/**
 * Derive the canonical Blob pathname for a given date's bullet cache entry.
 *
 * @param {string} date  ISO date string (YYYY-MM-DD)
 * @returns {string}
 */
function cachePathname(date) {
  return `${CACHE_PREFIX}${date}.json`;
}

/**
 * Read a cached bullet-generation result for the given date.
 *
 * Returns `null` on cache miss, Blob unavailability, fetch errors,
 * schema-version mismatches, or when the entry has been explicitly invalidated.
 * The caller should treat null as "re-generate".
 *
 * @param {string} date  ISO date string (YYYY-MM-DD)
 * @returns {Promise<object|null>}  The cached summarization result, or null
 */
export async function readBulletCache(date) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;

  const pathname = cachePathname(date);

  let match;
  try {
    const { blobs } = await list({
      prefix: pathname,
      limit: 1,
      token
    });
    match = blobs.find((b) => b.pathname === pathname);
  } catch (err) {
    console.warn(`[bulletCache] list failed for date=${date}:`, err.message ?? String(err));
    return null;
  }

  if (!match) return null;

  let data;
  try {
    const response = await fetch(match.url);
    if (!response.ok) return null;
    data = await response.json();
  } catch (err) {
    console.warn(`[bulletCache] fetch failed for date=${date}:`, err.message ?? String(err));
    return null;
  }

  if (data?.schemaVersion !== CACHE_SCHEMA_VERSION) {
    console.info(`[bulletCache] schema mismatch for date=${date}, treating as miss`);
    return null;
  }

  // Treat explicitly invalidated entries as cache misses.
  if (data?.invalidatedAt) {
    console.info(
      `[bulletCache] entry invalidated for date=${date} at ${data.invalidatedAt}` +
        (data.invalidationReason ? ` (reason: ${data.invalidationReason})` : "")
    );
    return null;
  }

  console.info(`[bulletCache] HIT for date=${date}, cachedAt=${data.cachedAt}`);
  return data.result ?? null;
}

/**
 * Write a bullet-generation result to the cache for the given date.
 *
 * Overwrites any existing entry.  Errors are logged and silently swallowed
 * so a cache write failure never breaks the batch pipeline.
 *
 * @param {string} date             ISO date string (YYYY-MM-DD)
 * @param {object} result           The summarization result object from summarizeWithOpenAI
 * @param {string} [sourceEntryId]  The work-log entry identifier that triggered generation.
 *                                  Defaults to `date` when omitted (the date is the canonical
 *                                  work-log entry key).
 * @returns {Promise<void>}
 */
export async function writeBulletCache(date, result, sourceEntryId = date) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;

  const pathname = cachePathname(date);
  const entry = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    date,
    cachedAt: new Date().toISOString(),
    sourceEntryId: String(sourceEntryId),
    invalidatedAt: null,
    invalidationReason: null,
    result
  };

  try {
    await put(pathname, JSON.stringify(entry), {
      access: "public",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
      token
    });
    console.info(`[bulletCache] WRITE for date=${date}, sourceEntryId=${sourceEntryId}`);
  } catch (err) {
    console.warn(`[bulletCache] write failed for date=${date}:`, err.message ?? String(err));
  }
}

// ─── Extract cache (WorkLogExtract results) ───────────────────────────────────

/**
 * Derive the canonical Blob pathname for a given date's extract cache entry.
 *
 * @param {string} date  ISO date string (YYYY-MM-DD)
 * @returns {string}
 */
function extractCachePathname(date) {
  return `${EXTRACT_CACHE_PREFIX}${date}.json`;
}

/**
 * Read a cached WorkLogExtract result for the given date.
 *
 * This is the cache-first lookup used by the `generate-candidates` route before
 * calling `extractResumeUpdatesFromWorkLog`.  When the same date is processed
 * more than once (e.g. the user re-triggers generation, or the server restarts
 * mid-flight), the expensive LLM call is skipped and the cached extract is
 * returned immediately.
 *
 * Cache hit/miss semantics:
 *   HIT  — a valid entry exists with a matching schemaVersion.
 *           Returns the cached WorkLogExtract object.
 *   MISS — the entry is absent, the fetch failed, or the schema version does
 *           not match.  Returns null so the caller falls back to a live LLM call.
 *
 * @param {string} date  ISO date string (YYYY-MM-DD)
 * @returns {Promise<object|null>}  Cached WorkLogExtract, or null on miss
 */
export async function readExtractCache(date) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;

  const pathname = extractCachePathname(date);

  let match;
  try {
    const { blobs } = await list({
      prefix: pathname,
      limit: 1,
      token
    });
    match = blobs.find((b) => b.pathname === pathname);
  } catch (err) {
    console.warn(
      `[bulletCache/extract] list failed for date=${date}:`,
      err.message ?? String(err)
    );
    return null;
  }

  if (!match) {
    console.info(`[bulletCache/extract] MISS for date=${date} — no cached entry`);
    return null;
  }

  let data;
  try {
    const response = await fetch(match.url);
    if (!response.ok) return null;
    data = await response.json();
  } catch (err) {
    console.warn(
      `[bulletCache/extract] fetch failed for date=${date}:`,
      err.message ?? String(err)
    );
    return null;
  }

  if (data?.schemaVersion !== EXTRACT_CACHE_SCHEMA_VERSION) {
    console.info(
      `[bulletCache/extract] schema mismatch for date=${date}, treating as miss`
    );
    return null;
  }

  // Treat explicitly invalidated entries as cache misses.
  if (data?.invalidatedAt) {
    console.info(
      `[bulletCache/extract] entry invalidated for date=${date} at ${data.invalidatedAt}` +
        (data.invalidationReason ? ` (reason: ${data.invalidationReason})` : "")
    );
    return null;
  }

  console.info(
    `[bulletCache/extract] HIT for date=${date}, cachedAt=${data.cachedAt}`
  );
  return data.extract ?? null;
}

/**
 * Write a WorkLogExtract result to the extract cache for the given date.
 *
 * Overwrites any existing entry.  Errors are logged and silently swallowed
 * so a cache write failure never breaks the generate-candidates pipeline.
 *
 * Callers should invoke this AFTER a successful LLM extraction:
 *
 *   const extract = await extractResumeUpdatesFromWorkLog(workLog, resume);
 *   writeExtractCache(date, extract).catch(() => {}); // fire-and-forget
 *
 * @param {string} date             ISO date string (YYYY-MM-DD)
 * @param {object} extract          WorkLogExtract object from extractResumeUpdatesFromWorkLog
 * @param {string} [sourceEntryId]  The work-log entry identifier that triggered generation.
 *                                  Defaults to `date` when omitted.
 * @returns {Promise<void>}
 */
export async function writeExtractCache(date, extract, sourceEntryId = date) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;

  const pathname = extractCachePathname(date);
  const entry = {
    schemaVersion: EXTRACT_CACHE_SCHEMA_VERSION,
    date,
    cachedAt: new Date().toISOString(),
    sourceEntryId: String(sourceEntryId),
    invalidatedAt: null,
    invalidationReason: null,
    extract
  };

  try {
    await put(pathname, JSON.stringify(entry), {
      access: "public",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
      token
    });
    console.info(`[bulletCache/extract] WRITE for date=${date}, sourceEntryId=${sourceEntryId}`);
  } catch (err) {
    console.warn(
      `[bulletCache/extract] write failed for date=${date}:`,
      err.message ?? String(err)
    );
  }
}

// ─── Cache invalidation ───────────────────────────────────────────────────────

/**
 * Soft-invalidate the bullet cache entry for the given date.
 *
 * Marks the existing entry with `invalidatedAt` and `invalidationReason` so that
 * future reads return null (cache miss) without permanently deleting the data.
 * Useful when a work-log entry is re-processed and the cached summarization
 * result is known to be stale.
 *
 * If no entry exists for the date, this is a no-op.
 * Errors are logged and silently swallowed so invalidation never breaks callers.
 *
 * @param {string} date               ISO date string (YYYY-MM-DD)
 * @param {string} [reason="explicit"] Human-readable reason for invalidation
 * @returns {Promise<void>}
 */
export async function invalidateBulletCache(date, reason = "explicit") {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;

  const pathname = cachePathname(date);

  let match;
  try {
    const { blobs } = await list({ prefix: pathname, limit: 1, token });
    match = blobs.find((b) => b.pathname === pathname);
  } catch (err) {
    console.warn(
      `[bulletCache] invalidate list failed for date=${date}:`,
      err.message ?? String(err)
    );
    return;
  }

  if (!match) {
    console.info(`[bulletCache] invalidate no-op for date=${date} — entry not found`);
    return;
  }

  let data;
  try {
    const response = await fetch(match.url);
    if (!response.ok) return;
    data = await response.json();
  } catch (err) {
    console.warn(
      `[bulletCache] invalidate fetch failed for date=${date}:`,
      err.message ?? String(err)
    );
    return;
  }

  const invalidated = {
    ...data,
    invalidatedAt: new Date().toISOString(),
    invalidationReason: String(reason)
  };

  try {
    await put(pathname, JSON.stringify(invalidated), {
      access: "public",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
      token
    });
    console.info(`[bulletCache] INVALIDATED for date=${date}, reason=${reason}`);
  } catch (err) {
    console.warn(
      `[bulletCache] invalidate write failed for date=${date}:`,
      err.message ?? String(err)
    );
  }
}

/**
 * Soft-invalidate the extract cache entry for the given date.
 *
 * Marks the existing entry with `invalidatedAt` and `invalidationReason` so that
 * future reads return null (cache miss) without permanently deleting the data.
 * Useful when a work-log entry is re-processed and the cached WorkLogExtract
 * result is known to be stale.
 *
 * If no entry exists for the date, this is a no-op.
 * Errors are logged and silently swallowed so invalidation never breaks callers.
 *
 * @param {string} date               ISO date string (YYYY-MM-DD)
 * @param {string} [reason="explicit"] Human-readable reason for invalidation
 * @returns {Promise<void>}
 */
export async function invalidateExtractCache(date, reason = "explicit") {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;

  const pathname = extractCachePathname(date);

  let match;
  try {
    const { blobs } = await list({ prefix: pathname, limit: 1, token });
    match = blobs.find((b) => b.pathname === pathname);
  } catch (err) {
    console.warn(
      `[bulletCache/extract] invalidate list failed for date=${date}:`,
      err.message ?? String(err)
    );
    return;
  }

  if (!match) {
    console.info(`[bulletCache/extract] invalidate no-op for date=${date} — entry not found`);
    return;
  }

  let data;
  try {
    const response = await fetch(match.url);
    if (!response.ok) return;
    data = await response.json();
  } catch (err) {
    console.warn(
      `[bulletCache/extract] invalidate fetch failed for date=${date}:`,
      err.message ?? String(err)
    );
    return;
  }

  const invalidated = {
    ...data,
    invalidatedAt: new Date().toISOString(),
    invalidationReason: String(reason)
  };

  try {
    await put(pathname, JSON.stringify(invalidated), {
      access: "public",
      contentType: "application/json; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
      token
    });
    console.info(`[bulletCache/extract] INVALIDATED for date=${date}, reason=${reason}`);
  } catch (err) {
    console.warn(
      `[bulletCache/extract] invalidate write failed for date=${date}:`,
      err.message ?? String(err)
    );
  }
}
