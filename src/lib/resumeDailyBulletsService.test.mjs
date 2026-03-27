/**
 * Tests for resumeDailyBulletsService.mjs
 *
 * Verifies Sub-AC 14-2: cache read/write service logic for daily resume bullets.
 *
 *   - On a valid cache hit: serve the existing DailyBulletsDocument directly.
 *   - On a cache miss or stale schema: reconstruct from raw bullet cache and
 *     populate the primary cache.
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 *
 * Testable behaviours without live Blob:
 *   1. All expected symbols are exported with the correct types.
 *   2. BULLET_CACHE_HIT / BULLET_CACHE_RECONSTRUCTED / BULLET_CACHE_MISS are
 *      distinct non-empty strings.
 *   3. isBulletDocumentValid correctly classifies documents as valid or invalid.
 *   4. Without a BLOB_READ_WRITE_TOKEN (readDailyBullets throws, readBulletCache
 *      returns null), getOrReconstructDailyBullets returns BULLET_CACHE_MISS.
 *   5. The result shape contract is verified (source + doc fields).
 *
 * The full cache hit / reconstruction flow requires a real Vercel Blob token
 * and is verified in integration tests rather than unit tests.
 *
 * Run:
 *   node --test src/lib/resumeDailyBulletsService.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getOrReconstructDailyBullets,
  isBulletDocumentValid,
  BULLET_CACHE_HIT,
  BULLET_CACHE_RECONSTRUCTED,
  BULLET_CACHE_MISS
} from "./resumeDailyBulletsService.mjs";

import { DAILY_BULLETS_SCHEMA_VERSION } from "./resumeDailyBullets.mjs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a callback with BLOB_READ_WRITE_TOKEN removed from the environment,
 * restoring it afterwards.
 *
 * @param {() => unknown} fn
 */
async function withoutBlobToken(fn) {
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) {
      process.env.BLOB_READ_WRITE_TOKEN = saved;
    }
  }
}

// ─── Exports exist ────────────────────────────────────────────────────────────

describe("resumeDailyBulletsService exports", () => {
  test("getOrReconstructDailyBullets is exported as a function", () => {
    assert.strictEqual(typeof getOrReconstructDailyBullets, "function");
  });

  test("isBulletDocumentValid is exported as a function", () => {
    assert.strictEqual(typeof isBulletDocumentValid, "function");
  });

  test("BULLET_CACHE_HIT is a non-empty string", () => {
    assert.strictEqual(typeof BULLET_CACHE_HIT, "string");
    assert.ok(BULLET_CACHE_HIT.length > 0, "BULLET_CACHE_HIT must be non-empty");
  });

  test("BULLET_CACHE_RECONSTRUCTED is a non-empty string", () => {
    assert.strictEqual(typeof BULLET_CACHE_RECONSTRUCTED, "string");
    assert.ok(BULLET_CACHE_RECONSTRUCTED.length > 0, "BULLET_CACHE_RECONSTRUCTED must be non-empty");
  });

  test("BULLET_CACHE_MISS is a non-empty string", () => {
    assert.strictEqual(typeof BULLET_CACHE_MISS, "string");
    assert.ok(BULLET_CACHE_MISS.length > 0, "BULLET_CACHE_MISS must be non-empty");
  });
});

// ─── Cache result constants are distinct ─────────────────────────────────────

describe("cache result constants are pairwise distinct", () => {
  test("BULLET_CACHE_HIT !== BULLET_CACHE_RECONSTRUCTED", () => {
    assert.notStrictEqual(BULLET_CACHE_HIT, BULLET_CACHE_RECONSTRUCTED);
  });

  test("BULLET_CACHE_HIT !== BULLET_CACHE_MISS", () => {
    assert.notStrictEqual(BULLET_CACHE_HIT, BULLET_CACHE_MISS);
  });

  test("BULLET_CACHE_RECONSTRUCTED !== BULLET_CACHE_MISS", () => {
    assert.notStrictEqual(BULLET_CACHE_RECONSTRUCTED, BULLET_CACHE_MISS);
  });
});

// ─── isBulletDocumentValid — pure validation logic ────────────────────────────

describe("isBulletDocumentValid", () => {
  test("returns false for null", () => {
    assert.strictEqual(isBulletDocumentValid(null), false);
  });

  test("returns false for undefined", () => {
    assert.strictEqual(isBulletDocumentValid(undefined), false);
  });

  test("returns false for empty object (no schemaVersion)", () => {
    assert.strictEqual(isBulletDocumentValid({}), false);
  });

  test("returns false when schemaVersion is 0", () => {
    assert.strictEqual(isBulletDocumentValid({ schemaVersion: 0 }), false);
  });

  test("returns false when schemaVersion is a future unknown version", () => {
    assert.strictEqual(
      isBulletDocumentValid({ schemaVersion: DAILY_BULLETS_SCHEMA_VERSION + 99 }),
      false
    );
  });

  test("returns false when schemaVersion is a string instead of number", () => {
    assert.strictEqual(
      isBulletDocumentValid({ schemaVersion: String(DAILY_BULLETS_SCHEMA_VERSION) }),
      false
    );
  });

  test("returns true for a document with the current schema version", () => {
    const doc = {
      schemaVersion: DAILY_BULLETS_SCHEMA_VERSION,
      date: "2025-03-27",
      generatedAt: new Date().toISOString(),
      sourceType: "work_log_batch",
      bullets: []
    };
    assert.strictEqual(isBulletDocumentValid(doc), true);
  });

  test("returns true for minimal valid document (only schemaVersion set)", () => {
    assert.strictEqual(
      isBulletDocumentValid({ schemaVersion: DAILY_BULLETS_SCHEMA_VERSION }),
      true
    );
  });
});

// ─── getOrReconstructDailyBullets — no-token behaviour ───────────────────────
//
// Without BLOB_READ_WRITE_TOKEN:
//   - readDailyBullets will throw (list() fails without auth token)
//   - readBulletCache returns null immediately (it guards on token absence)
//   Both are caught or short-circuited — result is always BULLET_CACHE_MISS.

describe("getOrReconstructDailyBullets — absent BLOB_READ_WRITE_TOKEN", () => {
  test("returns an object with source and doc fields", async () => {
    const result = await withoutBlobToken(() =>
      getOrReconstructDailyBullets("2025-03-27")
    );
    assert.ok(result !== null, "result must not be null");
    assert.strictEqual(typeof result, "object");
    assert.ok("source" in result, "result must have a source field");
    assert.ok("doc" in result, "result must have a doc field");
  });

  test("returns BULLET_CACHE_MISS when no blob token is configured", async () => {
    const result = await withoutBlobToken(() =>
      getOrReconstructDailyBullets("2025-03-27")
    );
    assert.strictEqual(
      result.source,
      BULLET_CACHE_MISS,
      `Expected source="${BULLET_CACHE_MISS}" but got source="${result.source}"`
    );
  });

  test("doc is null on MISS", async () => {
    const result = await withoutBlobToken(() =>
      getOrReconstructDailyBullets("2025-03-27")
    );
    assert.strictEqual(result.doc, null, "doc must be null on a MISS");
  });

  test("never throws — always resolves", async () => {
    await withoutBlobToken(async () => {
      await assert.doesNotReject(
        () => getOrReconstructDailyBullets("2025-01-01"),
        "getOrReconstructDailyBullets must not throw"
      );
    });
  });

  test("returns MISS for any valid date string without token", async () => {
    const dates = ["2024-01-01", "2024-12-31", "2025-03-27"];
    for (const date of dates) {
      const result = await withoutBlobToken(() =>
        getOrReconstructDailyBullets(date)
      );
      assert.strictEqual(
        result.source,
        BULLET_CACHE_MISS,
        `Expected MISS for date=${date} but got source="${result.source}"`
      );
    }
  });
});

// ─── Result shape contract ────────────────────────────────────────────────────

describe("result shape contract", () => {
  test("MISS result shape: { source: MISS, doc: null }", async () => {
    const result = await withoutBlobToken(() =>
      getOrReconstructDailyBullets("2025-03-27")
    );
    assert.strictEqual(result.source, BULLET_CACHE_MISS);
    assert.strictEqual(result.doc, null);
    // Verify the result has exactly these two fields (no extras)
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ["doc", "source"]);
  });

  test("HIT result shape contract (documentation): { source: HIT, doc: DailyBulletsDocument }", () => {
    // Documents the expected shape for a cache-hit result.
    // Exercised in integration tests with a real Blob token.
    const mockHitResult = {
      source: BULLET_CACHE_HIT,
      doc: {
        schemaVersion: DAILY_BULLETS_SCHEMA_VERSION,
        date: "2025-03-27",
        generatedAt: new Date().toISOString(),
        sourceType: "work_log_batch",
        bullets: []
      }
    };
    assert.strictEqual(mockHitResult.source, BULLET_CACHE_HIT);
    assert.ok(mockHitResult.doc != null, "doc must be non-null for HIT");
    assert.strictEqual(isBulletDocumentValid(mockHitResult.doc), true);
  });

  test("RECONSTRUCTED result shape contract (documentation): { source: RECONSTRUCTED, doc: DailyBulletsDocument }", () => {
    // Documents the expected shape for a reconstruction result.
    // Exercised in integration tests with a real Blob token + raw batch cache.
    const mockReconstructedResult = {
      source: BULLET_CACHE_RECONSTRUCTED,
      doc: {
        schemaVersion: DAILY_BULLETS_SCHEMA_VERSION,
        date: "2025-03-27",
        generatedAt: new Date().toISOString(),
        sourceType: "work_log_batch",
        bullets: [
          {
            id: "bullet-2025-03-27-0",
            text: "Migrated auth pipeline to Hono middleware",
            category: "company",
            suggestedSection: "experience",
            status: "pending",
            promotedSuggestionId: null,
            createdAt: new Date().toISOString()
          }
        ]
      }
    };
    assert.strictEqual(mockReconstructedResult.source, BULLET_CACHE_RECONSTRUCTED);
    assert.ok(mockReconstructedResult.doc != null, "doc must be non-null for RECONSTRUCTED");
    assert.strictEqual(isBulletDocumentValid(mockReconstructedResult.doc), true);
    assert.strictEqual(mockReconstructedResult.doc.bullets.length, 1);
  });
});

// ─── isBulletDocumentValid and DAILY_BULLETS_SCHEMA_VERSION alignment ─────────

describe("isBulletDocumentValid aligns with DAILY_BULLETS_SCHEMA_VERSION", () => {
  test("DAILY_BULLETS_SCHEMA_VERSION is a positive integer", () => {
    assert.strictEqual(typeof DAILY_BULLETS_SCHEMA_VERSION, "number");
    assert.ok(
      Number.isInteger(DAILY_BULLETS_SCHEMA_VERSION) && DAILY_BULLETS_SCHEMA_VERSION > 0,
      `DAILY_BULLETS_SCHEMA_VERSION must be a positive integer, got ${DAILY_BULLETS_SCHEMA_VERSION}`
    );
  });

  test("a document built with DAILY_BULLETS_SCHEMA_VERSION passes isBulletDocumentValid", () => {
    // Any document freshly built by buildDailyBulletsDocument will have
    // schemaVersion === DAILY_BULLETS_SCHEMA_VERSION; isBulletDocumentValid
    // must accept it.
    const builtDoc = { schemaVersion: DAILY_BULLETS_SCHEMA_VERSION, bullets: [] };
    assert.strictEqual(isBulletDocumentValid(builtDoc), true);
  });

  test("incrementing schemaVersion by 1 makes the document invalid", () => {
    const futureDoc = { schemaVersion: DAILY_BULLETS_SCHEMA_VERSION + 1, bullets: [] };
    assert.strictEqual(
      isBulletDocumentValid(futureDoc),
      false,
      "A document from a future schema version must be treated as stale"
    );
  });
});
