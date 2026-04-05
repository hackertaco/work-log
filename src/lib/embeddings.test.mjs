/**
 * Unit tests for embeddings.mjs
 *
 * Run with:
 *   node --test src/lib/embeddings.test.mjs
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

import {
  generateEmbedding,
  generateEmbeddings,
  cosineSimilarity,
  isMinorEdit,
  EMBEDDING_DIMENSIONS,
  _testing,
} from "./embeddings.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a fake embedding vector of the given dimension. */
function fakeVector(dim, seed = 1) {
  const v = [];
  for (let i = 0; i < dim; i++) {
    v.push(Math.sin(seed * (i + 1)) * 0.5);
  }
  return v;
}

/** Build the JSON body OpenAI would return for N inputs. */
function fakeApiResponse(count, dim = EMBEDDING_DIMENSIONS) {
  return {
    object: "list",
    model: "text-embedding-3-small",
    data: Array.from({ length: count }, (_, i) => ({
      index: i,
      object: "embedding",
      embedding: fakeVector(dim, i + 1),
    })),
    usage: { prompt_tokens: count * 5, total_tokens: count * 5 },
  };
}

// ─── cosineSimilarity (pure math, no API) ────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
  });

  it("returns -1 for opposite vectors", () => {
    const v = [1, 0, 0];
    const w = [-1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(v, w) - -1) < 1e-9);
  });

  it("returns 0 for orthogonal vectors", () => {
    const v = [1, 0];
    const w = [0, 1];
    assert.ok(Math.abs(cosineSimilarity(v, w)) < 1e-9);
  });

  it("returns 0 for mismatched lengths", () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });

  it("returns 0 for null/undefined inputs", () => {
    assert.equal(cosineSimilarity(null, [1]), 0);
    assert.equal(cosineSimilarity([1], undefined), 0);
  });

  it("returns 0 for zero vector", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
  });
});

// ─── isMinorEdit ─────────────────────────────────────────────────────────────

describe("isMinorEdit", () => {
  it("returns true when vectors are identical", () => {
    const v = [1, 2, 3];
    assert.equal(isMinorEdit(v, v), true);
  });

  it("returns false when vectors are orthogonal", () => {
    assert.equal(isMinorEdit([1, 0], [0, 1]), false);
  });

  it("respects custom threshold", () => {
    // Cosine similarity of these is ~0.9998
    const a = [1, 2, 3];
    const b = [1, 2, 3.01];
    assert.equal(isMinorEdit(a, b, 0.999), true);
    // But not exactly 1
    assert.equal(isMinorEdit(a, b, 1.0), false);
  });
});

// ─── generateEmbedding / generateEmbeddings (with mocked fetch) ──────────────

describe("generateEmbedding", () => {
  const originalEnv = {};

  before(() => {
    originalEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    originalEnv.WORK_LOG_DISABLE_OPENAI = process.env.WORK_LOG_DISABLE_OPENAI;
  });

  after(() => {
    process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY || "";
    process.env.WORK_LOG_DISABLE_OPENAI =
      originalEnv.WORK_LOG_DISABLE_OPENAI || "";
  });

  it("returns null when API key is missing", async () => {
    process.env.OPENAI_API_KEY = "";
    const result = await generateEmbedding("hello");
    assert.equal(result, null);
  });

  it("returns null when OpenAI is disabled", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
    const result = await generateEmbedding("hello");
    assert.equal(result, null);
    process.env.WORK_LOG_DISABLE_OPENAI = "";
  });

  it("returns null for empty/null input", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    assert.equal(await generateEmbedding(""), null);
    assert.equal(await generateEmbedding(null), null);
    assert.equal(await generateEmbedding(undefined), null);
  });

  it("returns a vector when fetch succeeds", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.WORK_LOG_DISABLE_OPENAI = "";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => fakeApiResponse(1),
    });

    try {
      const vec = await generateEmbedding("build the login page");
      assert.ok(Array.isArray(vec));
      assert.equal(vec.length, EMBEDDING_DIMENSIONS);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("generateEmbeddings", () => {
  const originalEnv = {};

  before(() => {
    originalEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    originalEnv.WORK_LOG_DISABLE_OPENAI = process.env.WORK_LOG_DISABLE_OPENAI;
  });

  after(() => {
    process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY || "";
    process.env.WORK_LOG_DISABLE_OPENAI =
      originalEnv.WORK_LOG_DISABLE_OPENAI || "";
  });

  it("returns null for empty array", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.WORK_LOG_DISABLE_OPENAI = "";
    assert.equal(await generateEmbeddings([]), null);
  });

  it("handles mixed empty and non-empty texts", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.WORK_LOG_DISABLE_OPENAI = "";

    // Only 2 non-empty inputs → API called with 2 texts
    const originalFetch = globalThis.fetch;
    let capturedBody = null;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => fakeApiResponse(capturedBody.input.length),
      };
    };

    try {
      const result = await generateEmbeddings(["hello", "", "world"]);
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 3);
      // Non-empty texts should have real vectors
      assert.equal(result[0].length, EMBEDDING_DIMENSIONS);
      assert.equal(result[2].length, EMBEDDING_DIMENSIONS);
      // Empty text gets zero vector
      assert.ok(result[1].every((v) => v === 0));
      // API should have been called with 2 texts, not 3
      assert.equal(capturedBody.input.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on API error", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.WORK_LOG_DISABLE_OPENAI = "";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    try {
      await assert.rejects(
        () => generateEmbeddings(["hello"]),
        (err) => {
          assert.ok(err.message.includes("429"));
          return true;
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends correct model in payload", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.WORK_LOG_DISABLE_OPENAI = "";

    const originalFetch = globalThis.fetch;
    let capturedBody = null;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => fakeApiResponse(1),
      };
    };

    try {
      await generateEmbeddings(["test"]);
      assert.equal(capturedBody.model, _testing.EMBEDDING_MODEL);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── EMBEDDING_DIMENSIONS constant ───────────────────────────────────────────

describe("EMBEDDING_DIMENSIONS", () => {
  it("is 1536 for text-embedding-3-small", () => {
    assert.equal(EMBEDDING_DIMENSIONS, 1536);
  });
});
