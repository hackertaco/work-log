import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

const putCalls = [];
const getCalls = [];
const store = new Map();

mock.module("@vercel/blob", {
  namedExports: {
    get: async (pathname, options) => {
      getCalls.push([pathname, options]);
      const body = store.get(pathname);
      if (body === undefined) return null;
      return { stream: new Blob([body]).stream() };
    },
    put: async (...args) => {
      putCalls.push(args);
      store.set(args[0], args[1]);
      return { url: "https://blob.test/cache-entry.json" };
    }
  }
});

const {
  invalidateBulletCache,
  invalidateExtractCache,
  readBulletCache,
  readExtractCache,
  writeBulletCache,
  writeExtractCache
} = await import(`./bulletCache.mjs?private-store-test=${Date.now()}`);

const originalFetch = globalThis.fetch;
const originalToken = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  putCalls.length = 0;
  getCalls.length = 0;
  store.clear();
  process.env.BLOB_READ_WRITE_TOKEN = "test-private-blob-token";
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
  await writeBulletCache("2026-08-10", { summary: "cached" });
  await invalidateBulletCache("2026-08-10", "test");

  await writeExtractCache("2026-08-10", { experienceUpdates: [] });
  await invalidateExtractCache("2026-08-10", "test");

  assert.strictEqual(putCalls.length, 4);
  for (const [, , options] of putCalls.slice(-2)) {
    assert.strictEqual(options.access, "private");
  }
});

test("private cache reads use authenticated Blob get and round-trip values", async () => {
  const context = {
    userId: "seungah",
    model: "gpt-test",
    input: { date: "2026-08-10", commits: ["abc"] }
  };
  await writeBulletCache("2026-08-10", { summary: "cached" }, context);
  await writeExtractCache("2026-08-10", { experienceUpdates: [] }, context);

  assert.deepStrictEqual(
    await readBulletCache("2026-08-10", context),
    { summary: "cached" }
  );
  assert.deepStrictEqual(
    await readExtractCache("2026-08-10", context),
    { experienceUpdates: [] }
  );
  assert.strictEqual(getCalls.length, 2);
  for (const [, options] of getCalls) {
    assert.strictEqual(options.access, "private");
    assert.strictEqual(options.token, "test-private-blob-token");
    assert.strictEqual(options.useCache, false);
  }
});

test("cache identity separates users, models, and input hashes", async () => {
  const base = { userId: "seungah", model: "gpt-test", input: { commits: ["a"] } };
  await writeBulletCache("2026-08-10", { summary: "cached" }, base);

  assert.strictEqual(
    await readBulletCache("2026-08-10", { ...base, userId: "other" }),
    null
  );
  assert.strictEqual(
    await readBulletCache("2026-08-10", { ...base, model: "gpt-other" }),
    null
  );
  assert.strictEqual(
    await readBulletCache("2026-08-10", { ...base, input: { commits: ["b"] } }),
    null
  );
});

test("production cache reads fail closed when Blob credentials are missing", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      readBulletCache("2026-08-10"),
      /BLOB_READ_WRITE_TOKEN is required/
    );
    await assert.rejects(
      readExtractCache("2026-08-10"),
      /BLOB_READ_WRITE_TOKEN is required/
    );
  } finally {
    process.env.BLOB_READ_WRITE_TOKEN = "test-private-blob-token";
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
