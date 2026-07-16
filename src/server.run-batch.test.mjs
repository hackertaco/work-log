/**
 * Tests for POST /api/run-batch (Task 6 review finding: no test coverage).
 *
 * Covers:
 *   (a) Vercel branch (process.env.VERCEL set): runServerCollection is called
 *       for the requesting user/date and the response is 200 (not an error).
 *   (b) Rate limit: a second call for the SAME user+date within the 30s
 *       window returns 429 and does NOT invoke the underlying batch runner
 *       a second time.
 *   (c) Sanitize: when WORK_LOG_ENABLE_RESUME is unset, a `resume` field
 *       present on the underlying result is stripped from the JSON response.
 *
 * `runServerCollection`/`runWorkStyleAnalysis` (./lib/serverCollect.mjs) and
 * `runDailyBatch` (./lib/batch.mjs) are mocked via node's experimental
 * module-mocking support so no real ClickHouse/network/local-batch work runs.
 * `readDailySummary` (used on the Vercel branch to build the response body)
 * is a private, unexported function inside server.mjs and cannot be mocked
 * directly — see the note on case (a) below for how this is handled.
 *
 * `lastRunBatchAt` is module-scope state inside server.mjs with no reset
 * hook and persists across tests in this file (and across process.env.VERCEL
 * toggles), so every test below uses a distinct `date` key to avoid
 * cross-test interference. Only the resolveRequestUser fallback token is
 * configured here, so every request resolves to the same `default` user id.
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/server.run-batch.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";

// ─── Mutable stub state ────────────────────────────────────────────────────

let runServerCollectionCalls = [];
let runServerCollectionFn = async (args) => {
  runServerCollectionCalls.push(args);
  return { collected: true };
};

let runDailyBatchCalls = [];
let runDailyBatchFn = async (date, options) => {
  runDailyBatchCalls.push({ date, options });
  return { date, ok: true };
};

// ─── Module-level mocks (must be declared before `await import(...)`) ─────

mock.module("./lib/serverCollect.mjs", {
  namedExports: {
    runServerCollection: (...args) => runServerCollectionFn(...args),
    runWorkStyleAnalysis: async () => ({})
  }
});

mock.module("./lib/batch.mjs", {
  namedExports: {
    runDailyBatch: (...args) => runDailyBatchFn(...args)
  }
});

const { createApp } = await import("./server.mjs");

// ─── Test helpers ───────────────────────────────────────────────────────────

const RUN_BATCH_URL = "http://localhost/api/run-batch";

function resetStubs() {
  runServerCollectionCalls = [];
  runServerCollectionFn = async (args) => {
    runServerCollectionCalls.push(args);
    return { collected: true };
  };
  runDailyBatchCalls = [];
  runDailyBatchFn = async (date, options) => {
    runDailyBatchCalls.push({ date, options });
    return { date, ok: true };
  };
}

/** Build an authenticated POST /api/run-batch request with a JSON body. */
function authedRunBatch(body) {
  return new Request(RUN_BATCH_URL, {
    method: "POST",
    headers: {
      cookie: "resume_token=test-run-batch-token",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("POST /api/run-batch — Vercel branch: proceeds via runServerCollection, status 200", async () => {
  resetStubs();
  process.env.RESUME_TOKEN = "test-run-batch-token";
  delete process.env.WORK_LOG_ENABLE_RESUME;
  process.env.VERCEL = "1";

  const date = "2099-01-01";
  try {
    const app = createApp();
    const res = await app.fetch(authedRunBatch({ date }));

    // Not an error status — the Vercel branch ran to completion.
    assert.equal(res.status, 200);

    // The Vercel branch must call runServerCollection for THIS user/date,
    // and must NOT fall through to the local runDailyBatch path.
    assert.equal(runServerCollectionCalls.length, 1, "runServerCollection must be called exactly once");
    assert.deepEqual(runServerCollectionCalls[0], { userId: "default", dates: [date] });
    assert.equal(runDailyBatchCalls.length, 0, "runDailyBatch (local path) must not be called on Vercel");

    // Body-shape note: readDailySummary() (called after runServerCollection
    // to build the response) is a private function inside server.mjs that
    // reads local disk then falls back to ./lib/blob.mjs. It is not mocked
    // here (mocking the ~90-export blob.mjs surface for every transitive
    // importer of server.mjs was judged too fragile per review guidance), so
    // in this test environment it resolves to `{ missing: true, date }`
    // (no local file for this future date, and Blob is unconfigured — the
    // read is caught and treated as absent). This is still a genuine,
    // non-throwing 200 response proving the Vercel branch executed
    // end-to-end. The `resume`-field sanitize behavior is asserted below on
    // the fully-controlled local path (case c), where the underlying
    // result's shape is not at the mercy of real disk/Blob state.
    const body = await res.json();
    assert.equal(typeof body, "object");
  } finally {
    delete process.env.VERCEL;
    delete process.env.RESUME_TOKEN;
  }
});

test("POST /api/run-batch — rate limit: second call within 30s for same user+date returns 429 and does not re-run", async () => {
  resetStubs();
  process.env.RESUME_TOKEN = "test-run-batch-token";
  delete process.env.WORK_LOG_ENABLE_RESUME;
  delete process.env.VERCEL; // local path — fully controlled via runDailyBatch spy

  const date = "2099-01-02";
  try {
    const app = createApp();

    const first = await app.fetch(authedRunBatch({ date }));
    assert.equal(first.status, 200);
    assert.equal(runDailyBatchCalls.length, 1, "first call must invoke runDailyBatch");

    const second = await app.fetch(authedRunBatch({ date }));
    assert.equal(second.status, 429);
    const secondBody = await second.json();
    assert.ok(secondBody.error, "429 response must include an error field");

    // The underlying runner must not have been invoked a second time.
    assert.equal(runDailyBatchCalls.length, 1, "runDailyBatch must still have been called only once");
  } finally {
    delete process.env.RESUME_TOKEN;
  }
});

test("POST /api/run-batch — sanitize: resume field is stripped from the response when resume is disabled", async () => {
  resetStubs();
  process.env.RESUME_TOKEN = "test-run-batch-token";
  delete process.env.WORK_LOG_ENABLE_RESUME; // resume disabled (v1 default)
  delete process.env.VERCEL; // local path — runDailyBatch return value fully controlled

  const date = "2099-01-03";
  runDailyBatchFn = async (runDate, options) => {
    runDailyBatchCalls.push({ date: runDate, options });
    return {
      date: runDate,
      workLog: { commits: 3 },
      resume: { note: "should never reach the client while resume is disabled" }
    };
  };

  try {
    const app = createApp();
    const res = await app.fetch(authedRunBatch({ date }));

    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal("resume" in body, false, "response body must not contain a resume field");
    assert.deepEqual(body.workLog, { commits: 3 }, "non-resume fields must survive sanitize untouched");
    assert.equal(body.date, date);
  } finally {
    delete process.env.RESUME_TOKEN;
  }
});
