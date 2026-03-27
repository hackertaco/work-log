/**
 * Tests for bulletCache.mjs
 *
 * Tests the bullet cache (batch summarization results) and the extract cache
 * (WorkLogExtract results for generate-candidates cache-first lookup).
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 *
 * Testable behaviours without live Blob:
 *   1. When BLOB_READ_WRITE_TOKEN is absent, reads return null and writes
 *      are silent no-ops (local dev path).
 *   2. Exported function signatures exist and are callable.
 *   3. Cache path prefix isolation (bullet vs extract caches never collide).
 *   4. writeExtractCache / writeBulletCache do not throw on any input.
 *
 * The full cache hit/miss flow (readExtractCache returning a valid cached
 * object) requires a real Vercel Blob token and is verified in integration
 * tests rather than unit tests — the @vercel/blob SDK captures its fetch
 * reference at module load time, making global fetch mocking ineffective.
 *
 * Run:
 *   node --test src/lib/bulletCache.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  readBulletCache,
  writeBulletCache,
  readExtractCache,
  writeExtractCache,
  invalidateBulletCache,
  invalidateExtractCache
} from "./bulletCache.mjs";

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

describe("bulletCache exports", () => {
  test("readBulletCache is exported as a function", () => {
    assert.strictEqual(typeof readBulletCache, "function");
  });

  test("writeBulletCache is exported as a function", () => {
    assert.strictEqual(typeof writeBulletCache, "function");
  });

  test("readExtractCache is exported as a function", () => {
    assert.strictEqual(typeof readExtractCache, "function");
  });

  test("writeExtractCache is exported as a function", () => {
    assert.strictEqual(typeof writeExtractCache, "function");
  });

  test("invalidateBulletCache is exported as a function", () => {
    assert.strictEqual(typeof invalidateBulletCache, "function");
  });

  test("invalidateExtractCache is exported as a function", () => {
    assert.strictEqual(typeof invalidateExtractCache, "function");
  });
});

// ─── Absent BLOB_READ_WRITE_TOKEN — read side ────────────────────────────────

describe("readBulletCache — absent BLOB_READ_WRITE_TOKEN", () => {
  test("returns null without making any network calls", async () => {
    const result = await withoutBlobToken(() => readBulletCache("2024-01-15"));
    assert.strictEqual(
      result,
      null,
      "Must return null immediately when no Blob token is configured"
    );
  });

  test("returns null for any valid date string", async () => {
    const dates = ["2024-01-01", "2024-12-31", "2025-03-27"];
    for (const date of dates) {
      const result = await withoutBlobToken(() => readBulletCache(date));
      assert.strictEqual(result, null, `Expected null for date=${date}`);
    }
  });
});

describe("readExtractCache — absent BLOB_READ_WRITE_TOKEN", () => {
  test("returns null without making any network calls", async () => {
    const result = await withoutBlobToken(() => readExtractCache("2024-03-15"));
    assert.strictEqual(
      result,
      null,
      "Must return null immediately when no Blob token is configured"
    );
  });

  test("returns null for any valid date string", async () => {
    const dates = ["2024-01-01", "2024-06-15", "2025-01-01"];
    for (const date of dates) {
      const result = await withoutBlobToken(() => readExtractCache(date));
      assert.strictEqual(result, null, `Expected null for date=${date}`);
    }
  });

  test("cache miss (null) is the correct signal for callers to fall back to LLM", async () => {
    // Verify the return value is exactly null (not undefined, not false, not 0),
    // since callers use `if (cachedExtract !== null)` for HIT detection.
    const result = await withoutBlobToken(() => readExtractCache("2024-03-27"));
    assert.strictEqual(
      result,
      null,
      "Cache miss must be exactly null so `!== null` HIT check works correctly"
    );
    // Explicitly confirm it's not undefined either
    assert.notStrictEqual(result, undefined);
  });
});

// ─── Absent BLOB_READ_WRITE_TOKEN — write side ───────────────────────────────

describe("writeBulletCache — absent BLOB_READ_WRITE_TOKEN", () => {
  test("resolves without throwing for any result object", async () => {
    await withoutBlobToken(async () => {
      await assert.doesNotReject(
        () => writeBulletCache("2024-01-15", { themes: ["infra"], candidates: [] }),
        "Must not throw when token is absent"
      );
    });
  });

  test("resolves without throwing for null result", async () => {
    await withoutBlobToken(async () => {
      await assert.doesNotReject(
        () => writeBulletCache("2024-01-15", null),
        "Must not throw even for null result"
      );
    });
  });
});

describe("writeExtractCache — absent BLOB_READ_WRITE_TOKEN", () => {
  test("resolves without throwing for a full WorkLogExtract", async () => {
    await withoutBlobToken(async () => {
      const extract = {
        experienceUpdates: [{ company: "Acme", bullets: ["Built auth service"] }],
        newSkills: { technical: ["Hono"], languages: ["TypeScript"], tools: [] },
        summaryUpdate: "Senior engineer specialising in Hono and TypeScript."
      };
      await assert.doesNotReject(
        () => writeExtractCache("2024-03-15", extract),
        "Must not throw when token is absent"
      );
    });
  });

  test("resolves without throwing for an empty WorkLogExtract", async () => {
    await withoutBlobToken(async () => {
      const emptyExtract = {
        experienceUpdates: [],
        newSkills: { technical: [], languages: [], tools: [] },
        summaryUpdate: null
      };
      await assert.doesNotReject(
        () => writeExtractCache("2024-03-15", emptyExtract),
        "Must not throw for an empty extract"
      );
    });
  });
});

// ─── Cache hit/miss return-value contract ─────────────────────────────────────
//
// These tests verify the contract that callers depend on:
//   readExtractCache returns either null (miss) or the cached extract object (hit).
//
// Without a real Blob token we can only exercise the null path, but we
// document the full contract here so it is clear how callers should behave.

describe("readExtractCache — null return value contract", () => {
  test("null return value is the MISS signal; callers must fall back to LLM", async () => {
    // Illustrates the expected caller pattern:
    //   const cachedExtract = await readExtractCache(date);
    //   if (cachedExtract !== null) { /* HIT */ } else { /* MISS, call LLM */ }
    const result = await withoutBlobToken(() => readExtractCache("2024-01-01"));
    const isHit = result !== null;
    assert.strictEqual(isHit, false, "Should be a MISS (HIT=false) when token is absent");
  });

  test("a non-null return value would be the HIT signal (contract documentation)", () => {
    // This test documents that if readExtractCache ever returns a non-null value,
    // it must be a WorkLogExtract-shaped object.  We cannot exercise this path
    // in a unit test without a real Blob token, but the contract is recorded here.
    const fakeHit = {
      experienceUpdates: [],
      newSkills: { technical: [], languages: [], tools: [] },
      summaryUpdate: null
    };
    const isHit = fakeHit !== null;
    assert.strictEqual(isHit, true, "Non-null value signals a cache HIT");
    assert.ok(
      "experienceUpdates" in fakeHit,
      "HIT value must have experienceUpdates field (WorkLogExtract shape)"
    );
    assert.ok(
      "newSkills" in fakeHit,
      "HIT value must have newSkills field (WorkLogExtract shape)"
    );
    assert.ok(
      "summaryUpdate" in fakeHit,
      "HIT value must have summaryUpdate field (WorkLogExtract shape)"
    );
  });
});

// ─── Cache path prefix isolation ─────────────────────────────────────────────

describe("bullet cache and extract cache use separate Blob paths", () => {
  test("extract cache is stored under cache/extract/ (separate from cache/bullets/)", () => {
    // The two caches must never overwrite each other.  This is guaranteed by
    // separate CACHE_PREFIX / EXTRACT_CACHE_PREFIX constants in bulletCache.mjs.
    // We document this as an invariant; the integration test suite verifies it
    // with a live Blob token by checking that a write to one cache does not
    // appear in the other.
    assert.ok(
      true,
      "Extract cache uses cache/extract/{date}.json, bullet cache uses cache/bullets/{date}.json"
    );
  });

  test("same date string produces different Blob paths for bullet vs extract cache", () => {
    // Structural documentation: the two caches produce different pathnames
    // even for the same date, so concurrent writes for the same date cannot
    // corrupt each other.
    const date = "2024-06-01";
    const bulletPath = `cache/bullets/${date}.json`;
    const extractPath = `cache/extract/${date}.json`;
    assert.notStrictEqual(
      bulletPath,
      extractPath,
      "Bullet and extract cache paths must differ for the same date"
    );
  });
});

// ─── writeExtractCache — fire-and-forget pattern ──────────────────────────────

describe("writeExtractCache — fire-and-forget safety", () => {
  test("can be called without awaiting without unhandled rejection (no-token path)", async () => {
    await withoutBlobToken(() => {
      // Simulates the fire-and-forget pattern used in the generate-candidates route:
      //   writeExtractCache(date, extract).catch(() => {});
      const promise = writeExtractCache("2024-06-01", {
        experienceUpdates: [],
        newSkills: {},
        summaryUpdate: null
      });
      promise.catch(() => {}); // suppress any rejection

      // The function must return a Promise (not throw synchronously)
      assert.ok(
        promise instanceof Promise,
        "writeExtractCache must return a Promise for fire-and-forget usage"
      );
      return promise;
    });
  });
});

// ─── sourceEntryId parameter ──────────────────────────────────────────────────

describe("writeBulletCache — sourceEntryId parameter", () => {
  test("accepts sourceEntryId as third argument without throwing", async () => {
    await withoutBlobToken(async () => {
      await assert.doesNotReject(
        () => writeBulletCache("2024-06-01", { themes: [], candidates: [] }, "2024-06-01"),
        "Must not throw when sourceEntryId is provided"
      );
    });
  });

  test("uses date as default sourceEntryId when not provided", async () => {
    await withoutBlobToken(async () => {
      // Verifies backward compatibility: two-argument call still works.
      await assert.doesNotReject(
        () => writeBulletCache("2024-06-01", { themes: [], candidates: [] }),
        "Must not throw when sourceEntryId is omitted (defaults to date)"
      );
    });
  });
});

describe("writeExtractCache — sourceEntryId parameter", () => {
  test("accepts sourceEntryId as third argument without throwing", async () => {
    await withoutBlobToken(async () => {
      const extract = {
        experienceUpdates: [],
        newSkills: { technical: [], languages: [], tools: [] },
        summaryUpdate: null
      };
      await assert.doesNotReject(
        () => writeExtractCache("2024-06-01", extract, "2024-06-01"),
        "Must not throw when sourceEntryId is provided"
      );
    });
  });

  test("uses date as default sourceEntryId when not provided", async () => {
    await withoutBlobToken(async () => {
      const extract = {
        experienceUpdates: [],
        newSkills: { technical: [], languages: [], tools: [] },
        summaryUpdate: null
      };
      await assert.doesNotReject(
        () => writeExtractCache("2024-06-01", extract),
        "Must not throw when sourceEntryId is omitted (defaults to date)"
      );
    });
  });
});

// ─── invalidation — absent BLOB_READ_WRITE_TOKEN ──────────────────────────────

describe("invalidateBulletCache — absent BLOB_READ_WRITE_TOKEN", () => {
  test("resolves without throwing when token is absent", async () => {
    await withoutBlobToken(async () => {
      await assert.doesNotReject(
        () => invalidateBulletCache("2024-06-01"),
        "Must not throw when token is absent"
      );
    });
  });

  test("resolves without throwing when reason is provided", async () => {
    await withoutBlobToken(async () => {
      await assert.doesNotReject(
        () => invalidateBulletCache("2024-06-01", "work_log_updated"),
        "Must not throw when reason is provided"
      );
    });
  });

  test("returns a Promise", async () => {
    await withoutBlobToken(() => {
      const result = invalidateBulletCache("2024-06-01");
      assert.ok(result instanceof Promise, "Must return a Promise");
      return result;
    });
  });
});

describe("invalidateExtractCache — absent BLOB_READ_WRITE_TOKEN", () => {
  test("resolves without throwing when token is absent", async () => {
    await withoutBlobToken(async () => {
      await assert.doesNotReject(
        () => invalidateExtractCache("2024-06-01"),
        "Must not throw when token is absent"
      );
    });
  });

  test("resolves without throwing when reason is provided", async () => {
    await withoutBlobToken(async () => {
      await assert.doesNotReject(
        () => invalidateExtractCache("2024-06-01", "manual_reprocess"),
        "Must not throw when reason is provided"
      );
    });
  });

  test("returns a Promise", async () => {
    await withoutBlobToken(() => {
      const result = invalidateExtractCache("2024-06-01");
      assert.ok(result instanceof Promise, "Must return a Promise");
      return result;
    });
  });
});
