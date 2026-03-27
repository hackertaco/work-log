/**
 * Tests for display-axes storage and retrieval (Sub-AC 16-3).
 *
 * Verifies that:
 *   - GET /api/resume/axes reads from the independent entity store
 *     (resume/display-axes.json) when it exists.
 *   - GET /api/resume/axes falls back to resume.display_axes inside the main
 *     resume document when the dedicated blob is absent.
 *   - GET /api/resume/axes returns 404 when neither the dedicated blob nor the
 *     resume exists.
 *   - POST /api/resume/axes saves the generated axes to the independent entity
 *     store (resume/display-axes.json) in addition to the main resume document.
 *   - POST /api/resume/axes returns the generatedAt timestamp alongside axes.
 *
 * Endpoints under test:
 *   GET  /api/resume/axes  — retrieve stored display axes
 *   POST /api/resume/axes  — (re)generate display axes via LLM and persist
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.axes.test.mjs
 *
 * Strategy
 * --------
 * All Blob I/O and LLM calls are stubbed via Node.js module mocks so tests run
 * fully offline.  Mutable wrapper functions let each test control what the
 * stubs return.  All mocks are registered before the router is imported
 * (required by --experimental-test-module-mocks).
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

/** Controls what readDisplayAxes() returns. */
let readDisplayAxesFn = async () => null;

/** Records the last document passed to saveDisplayAxes(). */
let lastSavedDisplayAxesDoc = null;
let saveDisplayAxesFn = async (doc) => {
  lastSavedDisplayAxesDoc = doc;
  return { url: "https://blob/resume/display-axes.json" };
};

/** Controls what readResumeData() returns. */
let readResumeDataFn = async () => null;

/** Records calls to saveResumeData(). */
let lastSavedResumeData = null;
let saveResumeDataFn = async (data) => {
  lastSavedResumeData = data;
  return { url: "https://blob/resume/data.json" };
};

/** Controls what generateDisplayAxes() returns. */
let generateDisplayAxesFn = async () => [
  { label: "Backend Engineer",  keywords: ["Node.js", "Hono"],   _source: "system" },
  { label: "Frontend Developer", keywords: ["React", "Preact"], _source: "system" }
];

/**
 * Controls what updateAxisInArray() returns.
 * Default: simulate "axis not found" (updated: null).
 * Override per-test to simulate a successful update.
 */
let updateAxisInArrayFn = (axes, _id, _updates) => ({ axes, updated: null });

/**
 * Controls what mergeAxes() returns (Sub-AC 18c).
 * Default: no-op success with no merged axis.
 * Override per-test to simulate real merge behaviour.
 */
let mergeAxesFn = (axes, _targetId, _sourceId, _newLabel) => ({ axes, merged: null, error: null });

/**
 * Controls what splitAxis() returns (Sub-AC 18c).
 * Default: simulate "axis not found" (axisA/axisB null).
 * Override per-test to simulate a real split.
 */
let splitAxisFn = (axes, _id, _labelA, _labelB, _kwB) => ({ axes, axisA: null, axisB: null });

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    // Display axes — the independent entity store (Sub-AC 16-3 target)
    readDisplayAxes:              (...args) => readDisplayAxesFn(...args),
    saveDisplayAxes:              (...args) => saveDisplayAxesFn(...args),
    DISPLAY_AXES_PATHNAME:        "resume/display-axes.json",

    // Resume data (fallback + dual-write target)
    readResumeData:               (...args) => readResumeDataFn(...args),
    saveResumeData:               (...args) => saveResumeDataFn(...args),

    // Remaining blob exports resume.mjs imports
    checkResumeExists:            async () => ({ exists: false }),
    readSuggestionsData:          async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] }),
    saveSuggestionsData:          async () => ({ url: "https://blob/resume/suggestions.json" }),
    saveDailyBullets:             async () => ({ url: "https://blob/resume/bullets/test.json" }),
    readDailyBullets:             async () => null,
    listBulletDates:              async () => [],
    deleteDailyBullets:           async () => {},
    savePdfText:                  async () => ({ url: "https://blob/resume/pdf-text.txt" }),
    readPdfText:                  async () => null,
    savePdfRaw:                   async () => ({ url: "https://blob/resume/resume.pdf" }),
    PDF_RAW_PATHNAME:             "resume/resume.pdf",
    markResumeForReconstruction:  async () => {},
    clearReconstructionMarker:    async () => {},
    checkReconstructionMarker:    async () => ({ needsRebuild: false }),
    saveKeywordClusterAxes:       async () => ({ url: "https://blob/resume/keyword-cluster-axes.json" }),
    readKeywordClusterAxes:       async () => null,
    SNAPSHOTS_PREFIX:             "resume/snapshots/",
    saveSnapshot:                 async () => ({ snapshotKey: "resume/snapshots/test.json", url: "https://blob/test" }),
    listSnapshots:                async () => [],
    readSnapshotByKey:            async () => null,
    readStrengthKeywords:         async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "system", keywords: [] }),
    saveStrengthKeywords:         async () => ({ url: "https://blob/resume/strength-keywords.json" }),
    STRENGTH_KEYWORDS_PATHNAME:   "resume/strength-keywords.json"
  }
});

mock.module("../lib/resumeAxisClustering.mjs", {
  namedExports: { generateDisplayAxes: (...args) => generateDisplayAxesFn(...args) }
});

mock.module("../lib/resumeLlm.mjs", {
  namedExports: { extractPdfText: async () => "pdf text" }
});

mock.module("../lib/resumeBootstrap.mjs", {
  namedExports: {
    generateResumeFromText: async () => ({
      resumeData:       { contact: { name: "Test" }, experience: [], education: [], skills: { technical: [], languages: [], tools: [] }, projects: [], certifications: [] },
      strengthKeywords: [],
      displayAxes:      []
    })
  }
});

mock.module("../lib/resumeReconstruction.mjs", {
  namedExports: {
    gatherWorkLogBullets:         async () => [],
    fullReconstructExtractCache:  async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] }),
    reconstructResumeFromSources: async () => ({ contact: { name: "Test" } }),
    mergeWithUserEdits:           (r) => r,
    isResumeStale:                () => false
  }
});

mock.module("../lib/resumeGapAnalysis.mjs", {
  namedExports: { analyzeGaps: () => ({ gaps: [], summary: { total: 0 } }) }
});

mock.module("../lib/resumeSuggestions.mjs", {
  namedExports: { gapItemsToSuggestions: () => [] }
});

mock.module("../lib/resumeDailyBullets.mjs", {
  namedExports: {
    DAILY_BULLETS_SCHEMA_VERSION:   1,
    BULLET_CATEGORIES:              ["company", "opensource", "other"],
    BULLET_SUGGESTED_SECTIONS:      ["experience", "skills", "projects"],
    BULLET_STATUSES:                ["pending", "promoted", "dismissed"],
    buildDailyBulletsDocument:      async () => ({ bullets: [] }),
    mergeDailyBulletsDocuments:     (a) => a,
    promoteBullet:                  (doc) => doc,
    dismissBullet:                  (doc) => doc,
    editBullet:                     (doc) => doc,
    getPendingBullets:              (doc) => (doc?.bullets ?? []).filter((b) => b.status === "pending"),
    invalidateDailyBulletsDocument: (doc, reason = "mock") => ({ ...doc, invalidatedAt: new Date().toISOString(), invalidationReason: reason })
  }
});

mock.module("../lib/resumeWorkLogExtract.mjs", {
  namedExports: { extractResumeUpdatesFromWorkLog: async () => ({}) }
});

mock.module("../lib/resumeWorkLogMerge.mjs", {
  namedExports: { mergeWorkLogIntoResume: () => ({}) }
});

mock.module("../lib/resumeDiff.mjs", {
  namedExports: { diffResume: () => [] }
});

mock.module("../lib/resumeDiffToSuggestions.mjs", {
  namedExports: {
    diffToSuggestions:             () => [],
    deduplicateWorkLogSuggestions: (s) => s
  }
});

mock.module("../lib/resumeDeltaRatio.mjs", {
  namedExports: {
    computeDeltaRatio:     () => 0,
    exceedsDeltaThreshold: () => false,
    DELTA_THRESHOLD:       0.03
  }
});

mock.module("../lib/resumeRecluster.mjs", {
  namedExports: {
    reclusterPipeline:           async () => ({ triggered: false, ratio: 0, axes: [], totalKeywords: 0, unclassifiedCount: 0 }),
    computeUnclassifiedRatio:    () => 0,
    shouldRecluster:             () => false,
    _adaptWorkLogEntries:        (e) => e,
    DEFAULT_RECLUSTER_THRESHOLD: 0.3,
    mergeAxes:                   (_existing, incoming) => (Array.isArray(incoming) ? incoming : []).map((ka, i) => ({ id: `merged-${i}`, label: ka.label ?? "", keywords: Array.isArray(ka.keywords) ? ka.keywords : [], _source: "system" }))
  }
});

mock.module("../lib/resumeKeywordClustering.mjs", {
  namedExports: {
    clusterKeywords:        async () => [],
    collectResumeKeywords:  () => [],
    collectWorkLogKeywords: () => []
  }
});

mock.module("../lib/bulletCache.mjs", {
  namedExports: {
    readBulletCache:   async () => null,
    writeBulletCache:  async () => {},
    readExtractCache:  async () => null,
    writeExtractCache: async () => {}
  }
});

mock.module("../lib/resumeDailyBulletsService.mjs", {
  namedExports: {
    getOrReconstructDailyBullets: async () => ({ source: "miss", doc: null }),
    BULLET_CACHE_HIT:             "cache_hit",
    BULLET_CACHE_RECONSTRUCTED:   "reconstructed",
    BULLET_CACHE_MISS:            "miss",
    isBulletDocumentValid:        () => false
  }
});

mock.module("../lib/resumeAxes.mjs", {
  namedExports: {
    createAxis:             (label, kws, source) => ({
      id:       `mock-${label.replace(/\s+/g, "-").toLowerCase()}`,
      label,
      keywords: Array.isArray(kws) ? kws : [],
      _source:  source ?? "system"
    }),
    updateAxisInArray:      (...args) => updateAxisInArrayFn(...args),
    removeAxisFromArray:    (axes) => ({ axes, removed: false }),
    splitAxis:              (...args) => splitAxisFn(...args),
    mergeAxes:              (...args) => mergeAxesFn(...args),
    migrateAxes:            (axes) => (Array.isArray(axes) ? axes : []),
    moveKeywordBetweenAxes: (axes) => ({ axes, moved: false, keyword: "", fromAxisId: null, toAxisId: "", error: null }),
    AXIS_SCHEMA_VERSION:    "1"
  }
});

mock.module("../lib/config.mjs", {
  namedExports: {
    loadConfig: async () => ({ dataDir: "/tmp/work-log-test", openaiApiKey: null })
  }
});

// ─── Load router under test AFTER mocks are registered ───────────────────────

const { resumeRouter } = await import("./resume.mjs");
const { cookieAuth }   = await import("../middleware/auth.mjs");

// ─── Test app builder ─────────────────────────────────────────────────────────

function buildApp(resumeToken = "test-secret") {
  process.env.RESUME_TOKEN = resumeToken;
  const app = new Hono();
  app.use("/api/resume/*", cookieAuth());
  app.route("/api/resume", resumeRouter);
  return app;
}

/** Build a Request pre-authenticated with the test token cookie. */
function authedReq(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("cookie", "resume_token=test-secret");
  return new Request(url, { ...options, headers });
}

/** Build a JSON-body Request with auth cookie. */
function authedJsonReq(url, method, body) {
  return authedReq(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function _storedResume(displayAxes = []) {
  return {
    meta: {
      language: "en",
      source: "pdf",
      generatedAt: "2025-01-01T00:00:00.000Z",
      schemaVersion: 1
    },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test User", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: "A developer.",
    experience: [],
    education: [],
    skills: { technical: ["JavaScript"], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: ["JavaScript"],
    display_axes: displayAxes
  };
}

// ─── Reset stubs before each test ────────────────────────────────────────────

function resetStubs() {
  readDisplayAxesFn = async () => null;
  saveDisplayAxesFn = async (doc) => {
    lastSavedDisplayAxesDoc = doc;
    return { url: "https://blob/resume/display-axes.json" };
  };
  readResumeDataFn = async () => null;
  saveResumeDataFn = async (data) => {
    lastSavedResumeData = data;
    return { url: "https://blob/resume/data.json" };
  };
  generateDisplayAxesFn = async () => [
    { label: "Backend Engineer",   keywords: ["Node.js", "Hono"],   _source: "system" },
    { label: "Frontend Developer", keywords: ["React", "Preact"],   _source: "system" }
  ];
  updateAxisInArrayFn = (axes, _id, _updates) => ({ axes, updated: null });
  mergeAxesFn = (axes, _targetId, _sourceId, _newLabel) => ({ axes, merged: null, error: null });
  splitAxisFn = (axes, _id, _labelA, _labelB, _kwB) => ({ axes, axisA: null, axisB: null });
  lastSavedDisplayAxesDoc = null;
  lastSavedResumeData = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/resume/axes — independent entity store (Sub-AC 16-3)
// ═══════════════════════════════════════════════════════════════════════════════

test("GET /api/resume/axes — returns axes from dedicated blob when available", async () => {
  resetStubs();
  const storedAxes = [
    { id: "axis-1", label: "Backend Engineer",   keywords: ["Node.js"], _source: "system" },
    { id: "axis-2", label: "Frontend Developer", keywords: ["React"],   _source: "user"   }
  ];
  readDisplayAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-06-01T10:00:00.000Z",
    axes:          storedAxes
  });

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.axes, storedAxes, "axes should match the dedicated blob");
  assert.equal(body.generatedAt, "2025-06-01T10:00:00.000Z", "generatedAt should be returned");
});

test("GET /api/resume/axes — does NOT load full resume when dedicated blob exists", async () => {
  resetStubs();
  let resumeWasLoaded = false;
  readDisplayAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-06-01T10:00:00.000Z",
    axes:          [{ id: "axis-1", label: "DevOps", keywords: ["Docker"], _source: "system" }]
  });
  readResumeDataFn = async () => {
    resumeWasLoaded = true;
    return _storedResume();
  };

  const app = buildApp();
  await app.fetch(authedReq("http://localhost/api/resume/axes"));

  assert.equal(resumeWasLoaded, false, "readResumeData should NOT be called when dedicated blob provides the axes");
});

test("GET /api/resume/axes — falls back to resume.display_axes when dedicated blob is null", async () => {
  resetStubs();
  const legacyAxes = [
    { id: "axis-legacy", label: "Legacy Axis", keywords: ["Python"], _source: "user" }
  ];
  readDisplayAxesFn = async () => null;
  readResumeDataFn  = async () => _storedResume(legacyAxes);

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.axes, legacyAxes, "axes should come from resume.display_axes as fallback");
  assert.equal(body.generatedAt, null, "generatedAt is null for legacy fallback");
});

test("GET /api/resume/axes — falls back to empty axes when resume has no display_axes", async () => {
  resetStubs();
  readDisplayAxesFn = async () => null;
  readResumeDataFn  = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.axes, [], "empty axes should be returned when no axes stored anywhere");
});

test("GET /api/resume/axes — returns 404 when neither dedicated blob nor resume exists", async () => {
  resetStubs();
  readDisplayAxesFn = async () => null;
  readResumeDataFn  = async () => null;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes"));

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("GET /api/resume/axes — continues to resume fallback when dedicated blob read fails", async () => {
  resetStubs();
  readDisplayAxesFn = async () => { throw new Error("Blob temporarily unavailable"); };
  const fallbackAxes = [
    { id: "axis-1", label: "Backend", keywords: ["Node.js"], _source: "system" }
  ];
  readResumeDataFn = async () => _storedResume(fallbackAxes);

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes"));

  // Should gracefully fall back to resume.display_axes, not 502
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.axes, fallbackAxes, "fallback axes should be returned when blob read fails");
});

test("GET /api/resume/axes — returns 502 when resume read fails (blob also null)", async () => {
  resetStubs();
  readDisplayAxesFn = async () => null;
  readResumeDataFn  = async () => { throw new Error("Storage unavailable"); };

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes"));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Storage unavailable/);
});

test("GET /api/resume/axes — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(new Request("http://localhost/api/resume/axes"));
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/resume/axes — saves to independent entity store (Sub-AC 16-3)
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/axes — saves generated axes to dedicated blob", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, true);

  // saveDisplayAxes should have been called
  assert.ok(lastSavedDisplayAxesDoc !== null, "saveDisplayAxes must be called");
  assert.equal(lastSavedDisplayAxesDoc.schemaVersion, 1, "schemaVersion should be 1");
  assert.ok(typeof lastSavedDisplayAxesDoc.generatedAt === "string", "generatedAt should be a string");
  assert.ok(Array.isArray(lastSavedDisplayAxesDoc.axes), "axes should be an array");
  assert.equal(lastSavedDisplayAxesDoc.axes.length, 2, "two axes should be saved");
});

test("POST /api/resume/axes — response includes generatedAt timestamp", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.generatedAt === "string", "generatedAt should be present in response");
  // The generatedAt in the response must match what was saved to blob
  assert.equal(body.generatedAt, lastSavedDisplayAxesDoc?.generatedAt);
});

test("POST /api/resume/axes — also saves axes to main resume document (dual-write)", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes", "POST", {})
  );

  // saveResumeData should also be called (backward-compat dual-write)
  assert.ok(lastSavedResumeData !== null, "saveResumeData must also be called (dual-write)");
  assert.ok(Array.isArray(lastSavedResumeData.display_axes), "resume.display_axes should be updated");
  assert.equal(
    lastSavedResumeData.display_axes.length,
    lastSavedDisplayAxesDoc.axes.length,
    "same axes written to both blob and resume"
  );
});

test("POST /api/resume/axes — saved display-axes document has correct shape", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes", "POST", {})
  );

  const doc = lastSavedDisplayAxesDoc;
  assert.ok(doc !== null, "saveDisplayAxes must be called");
  assert.equal(typeof doc.schemaVersion, "number", "schemaVersion must be a number");
  assert.equal(doc.schemaVersion, 1, "schemaVersion must be 1");
  assert.ok(typeof doc.generatedAt === "string", "generatedAt must be an ISO string");
  assert.ok(!Number.isNaN(Date.parse(doc.generatedAt)), "generatedAt must be a valid ISO date");
  assert.ok(Array.isArray(doc.axes), "axes must be an array");
  for (const axis of doc.axes) {
    assert.ok(typeof axis.label === "string", "each axis must have a label");
    assert.ok(Array.isArray(axis.keywords), "each axis must have a keywords array");
  }
});

test("POST /api/resume/axes — returns cached axes from resume when force=false and display_axes exist", async () => {
  resetStubs();
  const cachedAxes = [
    { id: "axis-cached", label: "Cached Axis", keywords: ["Go"], _source: "user" }
  ];
  readResumeDataFn = async () => _storedResume(cachedAxes);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, false, "regenerated should be false for cached result");
  assert.deepEqual(body.axes, cachedAxes);
  // saveDisplayAxes should NOT be called when returning cached
  assert.equal(lastSavedDisplayAxesDoc, null, "saveDisplayAxes must NOT be called for cached result");
});

test("POST /api/resume/axes — force=true bypasses cache and regenerates", async () => {
  resetStubs();
  const cachedAxes = [
    { id: "axis-old", label: "Old Axis", keywords: ["Ruby"], _source: "system" }
  ];
  readResumeDataFn = async () => _storedResume(cachedAxes);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes", "POST", { force: true })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, true, "regenerated should be true when force=true");
  // New axes from mock (not the cached "Old Axis")
  assert.ok(body.axes.some((a) => a.label === "Backend Engineer"), "new axes should be generated");
  // saveDisplayAxes MUST be called when regenerating
  assert.ok(lastSavedDisplayAxesDoc !== null, "saveDisplayAxes must be called when regenerating");
});

test("POST /api/resume/axes — returns 502 when saveDisplayAxes fails", async () => {
  resetStubs();
  readResumeDataFn  = async () => _storedResume([]);
  saveDisplayAxesFn = async () => { throw new Error("Blob write failed"); };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes", "POST", {})
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob write failed/);
});

test("POST /api/resume/axes — returns 404 when no resume exists", async () => {
  resetStubs();
  readResumeDataFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes", "POST", {})
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/axes", {
      method:  "POST",
      body:    JSON.stringify({}),
      headers: { "content-type": "application/json" }
    })
  );
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/resume/axes/merge — axis merge (Sub-AC 18c)
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/axes/merge — merges two axes and returns merged axis", async () => {
  resetStubs();
  const axisA = { id: "axis-1", label: "Backend", keywords: ["Node.js", "Hono"], _source: "user" };
  const axisB = { id: "axis-2", label: "API",     keywords: ["REST", "GraphQL"], _source: "system" };
  const merged = { id: "axis-1", label: "Backend & API", keywords: ["Node.js", "Hono", "REST", "GraphQL"], _source: "user" };
  const updatedAxes = [merged];

  readResumeDataFn = async () => _storedResume([axisA, axisB]);
  mergeAxesFn = (_axes, targetId, sourceId, newLabel) => {
    if (targetId === "axis-1" && sourceId === "axis-2") {
      return { axes: updatedAxes, merged, error: null };
    }
    return { axes: _axes, merged: null, error: "not found" };
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", {
      targetId: "axis-1",
      sourceId: "axis-2",
      label: "Backend & API"
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.merged, merged, "merged axis should be returned");
  assert.deepEqual(body.axes, updatedAxes, "full updated axes array should be returned");
});

test("POST /api/resume/axes/merge — saves merged axes to dedicated display-axes blob", async () => {
  resetStubs();
  const axisA = { id: "axis-1", label: "Backend", keywords: ["Node.js"], _source: "user" };
  const axisB = { id: "axis-2", label: "API",     keywords: ["REST"],    _source: "system" };
  const merged = { id: "axis-1", label: "Backend", keywords: ["Node.js", "REST"], _source: "user" };
  const updatedAxes = [merged];

  readResumeDataFn = async () => _storedResume([axisA, axisB]);
  mergeAxesFn = () => ({ axes: updatedAxes, merged, error: null });

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", {
      targetId: "axis-1",
      sourceId: "axis-2"
    })
  );

  // saveDisplayAxes must be called with the updated axes
  assert.ok(lastSavedDisplayAxesDoc !== null, "saveDisplayAxes must be called after merge");
  assert.equal(lastSavedDisplayAxesDoc.schemaVersion, 1, "schemaVersion should be 1");
  assert.ok(typeof lastSavedDisplayAxesDoc.generatedAt === "string", "generatedAt should be set");
  assert.deepEqual(lastSavedDisplayAxesDoc.axes, updatedAxes, "saved axes should match merged result");
});

test("POST /api/resume/axes/merge — also syncs to main resume document", async () => {
  resetStubs();
  const axisA = { id: "axis-1", label: "Backend", keywords: ["Node.js"], _source: "user" };
  const axisB = { id: "axis-2", label: "API",     keywords: ["REST"],    _source: "system" };
  const merged = { id: "axis-1", label: "Backend", keywords: ["Node.js", "REST"], _source: "user" };
  const updatedAxes = [merged];

  readResumeDataFn = async () => _storedResume([axisA, axisB]);
  mergeAxesFn = () => ({ axes: updatedAxes, merged, error: null });

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", {
      targetId: "axis-1",
      sourceId: "axis-2"
    })
  );

  // saveResumeData should also be called (backward-compat sync)
  assert.ok(lastSavedResumeData !== null, "saveResumeData must also be called (sync)");
  assert.deepEqual(lastSavedResumeData.display_axes, updatedAxes, "resume.display_axes should reflect the merge");
  assert.equal(lastSavedResumeData._sources.display_axes, "user", "_source should be 'user' after merge");
});

test("POST /api/resume/axes/merge — returns 400 when targetId is missing", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", { sourceId: "axis-2" })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("POST /api/resume/axes/merge — returns 400 when sourceId is missing", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", { targetId: "axis-1" })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/merge — returns 400 when targetId equals sourceId", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", {
      targetId: "axis-1",
      sourceId: "axis-1"
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/merge — returns 404 when no resume exists", async () => {
  resetStubs();
  readResumeDataFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", {
      targetId: "axis-1",
      sourceId: "axis-2"
    })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/merge — returns 404 when mergeAxes reports not found", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);
  mergeAxesFn = (axes) => ({ axes, merged: null, error: "Target axis not found: axis-1" });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", {
      targetId: "axis-1",
      sourceId: "axis-2"
    })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /not found/i);
});

test("POST /api/resume/axes/merge — returns 502 when saveDisplayAxes fails", async () => {
  resetStubs();
  const axisA = { id: "axis-1", label: "Backend", keywords: ["Node.js"], _source: "user" };
  const merged = { id: "axis-1", label: "Backend", keywords: ["Node.js"], _source: "user" };

  readResumeDataFn = async () => _storedResume([axisA]);
  mergeAxesFn = () => ({ axes: [merged], merged, error: null });
  saveDisplayAxesFn = async () => { throw new Error("Blob unavailable"); };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/merge", "POST", {
      targetId: "axis-1",
      sourceId: "axis-2"
    })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/merge — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/axes/merge", {
      method:  "POST",
      body:    JSON.stringify({ targetId: "axis-1", sourceId: "axis-2" }),
      headers: { "content-type": "application/json" }
    })
  );
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/resume/axes/:id/split — axis split (Sub-AC 18c)
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/axes/:id/split — splits an axis and returns two new axes", async () => {
  resetStubs();
  const original = { id: "axis-1", label: "Tech", keywords: ["Node.js", "React", "Docker"], _source: "system" };
  const axisA = { id: "new-a", label: "Backend", keywords: ["Node.js", "Docker"], _source: "user" };
  const axisB = { id: "new-b", label: "Frontend", keywords: ["React"], _source: "user" };
  const updatedAxes = [axisA, axisB];

  readResumeDataFn = async () => _storedResume([original]);
  splitAxisFn = (_axes, id, labelA, labelB, _kwB) => {
    if (id === "axis-1" && labelA === "Backend" && labelB === "Frontend") {
      return { axes: updatedAxes, axisA, axisB };
    }
    return { axes: _axes, axisA: null, axisB: null };
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelA: "Backend",
      labelB: "Frontend",
      keywordsB: ["React"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.axisA, axisA, "axisA should be the remainder axis");
  assert.deepEqual(body.axisB, axisB, "axisB should be the selection axis");
  assert.deepEqual(body.axes, updatedAxes, "full updated axes array should be returned");
});

test("POST /api/resume/axes/:id/split — saves split axes to dedicated display-axes blob", async () => {
  resetStubs();
  const original = { id: "axis-1", label: "Tech", keywords: ["Node.js", "React"], _source: "system" };
  const axisA = { id: "new-a", label: "Backend",  keywords: ["Node.js"], _source: "user" };
  const axisB = { id: "new-b", label: "Frontend", keywords: ["React"],   _source: "user" };
  const updatedAxes = [axisA, axisB];

  readResumeDataFn = async () => _storedResume([original]);
  splitAxisFn = () => ({ axes: updatedAxes, axisA, axisB });

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelA: "Backend",
      labelB: "Frontend",
      keywordsB: ["React"]
    })
  );

  // saveDisplayAxes must be called with the updated axes
  assert.ok(lastSavedDisplayAxesDoc !== null, "saveDisplayAxes must be called after split");
  assert.equal(lastSavedDisplayAxesDoc.schemaVersion, 1, "schemaVersion should be 1");
  assert.ok(typeof lastSavedDisplayAxesDoc.generatedAt === "string", "generatedAt should be set");
  assert.deepEqual(lastSavedDisplayAxesDoc.axes, updatedAxes, "saved axes should match split result");
});

test("POST /api/resume/axes/:id/split — also syncs to main resume document", async () => {
  resetStubs();
  const original = { id: "axis-1", label: "Tech", keywords: ["Node.js", "React"], _source: "system" };
  const axisA = { id: "new-a", label: "Backend",  keywords: ["Node.js"], _source: "user" };
  const axisB = { id: "new-b", label: "Frontend", keywords: ["React"],   _source: "user" };
  const updatedAxes = [axisA, axisB];

  readResumeDataFn = async () => _storedResume([original]);
  splitAxisFn = () => ({ axes: updatedAxes, axisA, axisB });

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelA: "Backend",
      labelB: "Frontend",
      keywordsB: ["React"]
    })
  );

  // saveResumeData should also be called (backward-compat sync)
  assert.ok(lastSavedResumeData !== null, "saveResumeData must also be called (sync)");
  assert.deepEqual(lastSavedResumeData.display_axes, updatedAxes, "resume.display_axes should reflect the split");
  assert.equal(lastSavedResumeData._sources.display_axes, "user", "_source should be 'user' after split");
});

test("POST /api/resume/axes/:id/split — returns 400 when labelA is missing", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelB: "Frontend",
      keywordsB: ["React"]
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/:id/split — returns 400 when labelB is missing", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelA: "Backend",
      keywordsB: ["React"]
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/:id/split — returns 400 when keywordsB is not an array", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelA: "Backend",
      labelB: "Frontend",
      keywordsB: "React"
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/:id/split — returns 404 when axis id not found", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([]);
  splitAxisFn = (axes) => ({ axes, axisA: null, axisB: null });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/nonexistent/split", "POST", {
      labelA: "Backend",
      labelB: "Frontend",
      keywordsB: ["React"]
    })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/:id/split — returns 400 when splitAxis throws RangeError", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume([{ id: "axis-1", label: "Tech", keywords: ["Node.js"], _source: "system" }]);
  splitAxisFn = () => { throw new RangeError("두 번째 분리 축에 최소 1개의 키워드가 있어야 합니다."); };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelA: "Backend",
      labelB: "Frontend",
      keywordsB: []
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /키워드/);
});

test("POST /api/resume/axes/:id/split — returns 404 when no resume exists", async () => {
  resetStubs();
  readResumeDataFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelA: "Backend",
      labelB: "Frontend",
      keywordsB: ["React"]
    })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/:id/split — returns 502 when saveDisplayAxes fails", async () => {
  resetStubs();
  const original = { id: "axis-1", label: "Tech", keywords: ["Node.js", "React"], _source: "system" };
  const axisA = { id: "new-a", label: "Backend",  keywords: ["Node.js"], _source: "user" };
  const axisB = { id: "new-b", label: "Frontend", keywords: ["React"],   _source: "user" };

  readResumeDataFn = async () => _storedResume([original]);
  splitAxisFn = () => ({ axes: [axisA, axisB], axisA, axisB });
  saveDisplayAxesFn = async () => { throw new Error("Blob write failed"); };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1/split", "POST", {
      labelA: "Backend",
      labelB: "Frontend",
      keywordsB: ["React"]
    })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/axes/:id/split — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/axes/axis-1/split", {
      method:  "POST",
      body:    JSON.stringify({ labelA: "Backend", labelB: "Frontend", keywordsB: ["React"] }),
      headers: { "content-type": "application/json" }
    })
  );
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/resume/axes/:id — rename / update axis (Sub-AC 18a)
// ═══════════════════════════════════════════════════════════════════════════════

/** Fixture: two stored axes */
function _twoAxes() {
  return [
    { id: "axis-1", label: "Backend Engineer",   keywords: ["Node.js", "Hono"],  _source: "system" },
    { id: "axis-2", label: "Frontend Developer", keywords: ["React", "Preact"],  _source: "system" }
  ];
}

/** Override updateAxisInArrayFn so that the given axisId is found and updated. */
function setUpdateSuccess(axisId) {
  updateAxisInArrayFn = (axes, id, updates) => {
    if (id !== axisId) return { axes, updated: null };
    const original = axes.find(a => a.id === id);
    if (!original) return { axes, updated: null };
    const updated = { ...original, ...updates };
    const newAxes = axes.map(a => (a.id === id ? updated : a));
    return { axes: newAxes, updated };
  };
}

test("PATCH /api/resume/axes/:id — successfully renames axis label", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_twoAxes());
  setUpdateSuccess("axis-1");

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "Senior Backend Engineer" })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.axis, "response must include the updated axis");
  assert.equal(body.axis.id, "axis-1");
  assert.equal(body.axis.label, "Senior Backend Engineer");
});

test("PATCH /api/resume/axes/:id — saves to main resume (saveResumeData called)", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_twoAxes());
  setUpdateSuccess("axis-1");

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "New Label" })
  );

  assert.ok(lastSavedResumeData !== null, "saveResumeData must be called");
  assert.ok(Array.isArray(lastSavedResumeData.display_axes), "resume.display_axes should be updated");
  assert.equal(lastSavedResumeData._sources?.display_axes, "user", "_sources.display_axes should be 'user'");
});

test("PATCH /api/resume/axes/:id — dual-writes to display-axes.json when blob exists", async () => {
  resetStubs();
  const axesDoc = {
    schemaVersion: 1,
    generatedAt:   "2025-06-01T10:00:00.000Z",
    axes:          _twoAxes()
  };
  readDisplayAxesFn = async () => axesDoc;
  readResumeDataFn  = async () => _storedResume(_twoAxes());
  setUpdateSuccess("axis-1");

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "Renamed Axis" })
  );

  assert.equal(res.status, 200);
  assert.ok(lastSavedDisplayAxesDoc !== null, "saveDisplayAxes must be called when blob exists");
  assert.equal(lastSavedDisplayAxesDoc.schemaVersion, 1, "schemaVersion preserved in dual-write");
  assert.equal(
    lastSavedDisplayAxesDoc.generatedAt,
    axesDoc.generatedAt,
    "generatedAt preserved in dual-write"
  );
  assert.ok(Array.isArray(lastSavedDisplayAxesDoc.axes), "axes array must be present");
});

test("PATCH /api/resume/axes/:id — does NOT call saveDisplayAxes when blob is null", async () => {
  resetStubs();
  readDisplayAxesFn = async () => null;
  readResumeDataFn  = async () => _storedResume(_twoAxes());
  setUpdateSuccess("axis-1");

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "New Label" })
  );

  assert.equal(lastSavedDisplayAxesDoc, null, "saveDisplayAxes must NOT be called when no blob exists");
});

test("PATCH /api/resume/axes/:id — prefers display-axes.json as axis source", async () => {
  resetStubs();
  const blobAxes   = [{ id: "axis-blob",   label: "Blob Axis",   keywords: ["Go"],   _source: "user" }];
  const resumeAxes = [{ id: "axis-resume", label: "Resume Axis", keywords: ["Java"], _source: "system" }];
  let capturedSourceId = null;

  readDisplayAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-01-01T00:00:00.000Z",
    axes:          blobAxes
  });
  readResumeDataFn = async () => _storedResume(resumeAxes);
  updateAxisInArrayFn = (axes, id, _updates) => {
    capturedSourceId = axes[0]?.id ?? null;
    return { axes, updated: null };
  };

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-blob", "PATCH", { label: "New Name" })
  );

  assert.equal(
    capturedSourceId,
    "axis-blob",
    "updateAxisInArray should receive axes from display-axes.json, not main resume"
  );
});

test("PATCH /api/resume/axes/:id — returns 400 when body has neither label nor keywords", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_twoAxes());

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", {})
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("PATCH /api/resume/axes/:id — returns 400 when label is blank", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_twoAxes());

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "   " })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/axes/:id — returns 400 when keywords is not an array", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_twoAxes());

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { keywords: "not-an-array" })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/axes/:id — returns 400 when body is not JSON", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/axes/axis-1", {
      method:  "PATCH",
      body:    "not json ;;;",
      headers: { "content-type": "text/plain" }
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/axes/:id — returns 404 when resume does not exist", async () => {
  resetStubs();
  readResumeDataFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "New Label" })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/axes/:id — returns 404 when axis id is not found", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_twoAxes());
  // updateAxisInArrayFn default returns updated: null (axis not found)

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/nonexistent-id", "PATCH", { label: "New Label" })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /nonexistent-id/);
});

test("PATCH /api/resume/axes/:id — returns 502 when readResumeData fails", async () => {
  resetStubs();
  readResumeDataFn = async () => { throw new Error("Blob unavailable"); };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "New Label" })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob unavailable/);
});

test("PATCH /api/resume/axes/:id — returns 502 when saveResumeData fails", async () => {
  resetStubs();
  readResumeDataFn  = async () => _storedResume(_twoAxes());
  saveResumeDataFn  = async () => { throw new Error("Write error"); };
  setUpdateSuccess("axis-1");

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "New Label" })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /저장 실패/);
});

test("PATCH /api/resume/axes/:id — returns 502 when saveDisplayAxes fails", async () => {
  resetStubs();
  readDisplayAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-01-01T00:00:00.000Z",
    axes:          _twoAxes()
  });
  readResumeDataFn  = async () => _storedResume(_twoAxes());
  saveDisplayAxesFn = async () => { throw new Error("Blob write error"); };
  setUpdateSuccess("axis-1");

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "New Label" })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /블롭 저장 실패/);
});

test("PATCH /api/resume/axes/:id — falls back gracefully when readDisplayAxes throws", async () => {
  resetStubs();
  readDisplayAxesFn = async () => { throw new Error("Blob temporarily unavailable"); };
  readResumeDataFn  = async () => _storedResume(_twoAxes());
  setUpdateSuccess("axis-1");

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { label: "New Label" })
  );

  // Should still succeed using main resume as fallback
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // saveDisplayAxes must NOT be called because axesDoc remained null after the throw
  assert.equal(
    lastSavedDisplayAxesDoc,
    null,
    "saveDisplayAxes must NOT be called when readDisplayAxes failed"
  );
});

test("PATCH /api/resume/axes/:id — URL-decodes axis id from route parameter", async () => {
  resetStubs();
  const specialId  = "axis/special id";
  const axisArray  = [{ id: specialId, label: "Special", keywords: [], _source: "user" }];
  readResumeDataFn = async () => _storedResume(axisArray);
  let capturedId   = null;
  updateAxisInArrayFn = (axes, id, _updates) => {
    capturedId = id;
    return { axes, updated: null };
  };

  const app = buildApp();
  await app.fetch(
    authedJsonReq(
      `http://localhost/api/resume/axes/${encodeURIComponent(specialId)}`,
      "PATCH",
      { label: "New Label" }
    )
  );

  assert.equal(capturedId, specialId, "axis id must be URL-decoded before lookup");
});

test("PATCH /api/resume/axes/:id — allows updating keywords only (no label)", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_twoAxes());
  setUpdateSuccess("axis-1");

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/axis-1", "PATCH", { keywords: ["Rust", "Go"] })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.axis, "response must include the updated axis");
});

test("PATCH /api/resume/axes/:id — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/axes/axis-1", {
      method:  "PATCH",
      body:    JSON.stringify({ label: "New Label" }),
      headers: { "content-type": "application/json" }
    })
  );
  assert.equal(res.status, 401);
});
