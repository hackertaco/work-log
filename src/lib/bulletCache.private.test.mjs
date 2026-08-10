import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

const putCalls = [];
let listedPathname = null;

mock.module("@vercel/blob", {
  namedExports: {
    list: async () => ({
      blobs: listedPathname
        ? [{ pathname: listedPathname, url: "https://blob.test/cache-entry.json" }]
        : []
    }),
    put: async (...args) => {
      putCalls.push(args);
      return { url: "https://blob.test/cache-entry.json" };
    }
  }
});

const {
  invalidateBulletCache,
  invalidateExtractCache,
  writeBulletCache,
  writeExtractCache
} = await import(`./bulletCache.mjs?private-store-test=${Date.now()}`);

const originalFetch = globalThis.fetch;
const originalToken = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  putCalls.length = 0;
  listedPathname = null;
  process.env.BLOB_READ_WRITE_TOKEN = "test-private-blob-token";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ schemaVersion: 1, result: {}, extract: {} })
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
});

test("cache writes target the configured private Blob store", async () => {
  await writeBulletCache("2026-08-10", { summary: "cached" });
  await writeExtractCache("2026-08-10", { experienceUpdates: [] });

  assert.strictEqual(putCalls.length, 2);
  for (const [, , options] of putCalls) {
    assert.strictEqual(options.access, "private");
  }
});

test("cache invalidation rewrites entries as private", async () => {
  listedPathname = "cache/bullets/2026-08-10.json";
  await invalidateBulletCache("2026-08-10", "test");

  listedPathname = "cache/extract/2026-08-10.json";
  await invalidateExtractCache("2026-08-10", "test");

  assert.strictEqual(putCalls.length, 2);
  for (const [, , options] of putCalls) {
    assert.strictEqual(options.access, "private");
  }
});
