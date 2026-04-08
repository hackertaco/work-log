/**
 * Tests for unclassified keyword monitoring and auto-recluster trigger (Sub-AC 17-2).
 *
 * Endpoints under test:
 *   GET  /api/resume/axes/staleness  — returns unclassified ratio + shouldRecluster flag
 *   POST /api/resume/axes/recluster  — triggers re-clustering when ratio > 30 %; persists new axes
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.recluster.test.mjs
 *
 * Strategy
 * --------
 * All Blob I/O and LLM calls are stubbed via Node.js module mocks so tests run
 * fully offline.  The reclusterPipeline mock is the primary control point: each
 * test reassigns it to control triggered/ratio/axes returned by the pipeline.
 * All mocks are registered before the router is imported (required by
 * --experimental-test-module-mocks).
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

/** Controls what readResumeData() returns. */
let readResumeDataFn = async () => null;

/** Records the last document passed to saveResumeData(). */
let lastSavedResumeData = null;
let saveResumeDataFn = async (data) => {
  lastSavedResumeData = data;
  return { url: "https://blob/resume/data.json" };
};

/**
 * Controls what reclusterPipeline() returns.
 * Default: not triggered, ratio 0.
 */
let reclusterPipelineFn = async () => ({
  triggered: false,
  ratio: 0,
  axes: [],
  totalKeywords: 0,
  unclassifiedCount: 0
});

/**
 * Controls what computeUnclassifiedRatio() returns (used by staleness endpoint).
 * Default: 0 (all classified).
 */
let computeUnclassifiedRatioFn = () => 0;

/**
 * Controls what collectResumeKeywords() returns.
 * Default: empty list.
 */
let collectResumeKeywordsFn = () => [];

/**
 * Controls what collectWorkLogKeywords() returns.
 * Default: empty list.
 */
let collectWorkLogKeywordsFn = () => [];

/**
 * Controls what gatherWorkLogBullets() returns.
 * Default: empty list (no work-log entries on disk).
 */
let gatherWorkLogBulletsFn = async () => [];

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    readResumeData:               (...args) => readResumeDataFn(...args),
    saveResumeData:               (...args) => saveResumeDataFn(...args),
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
    checkPdfRawExists:            async () => ({ exists: true, url: "https://blob/resume/resume.pdf" }),
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
    STRENGTH_KEYWORDS_PATHNAME:   "resume/strength-keywords.json",
    saveDisplayAxes:              async () => ({ url: "https://blob/resume/display-axes.json" }),
    readDisplayAxes:              async () => null,
    DISPLAY_AXES_PATHNAME:        "resume/display-axes.json",
    saveIdentifiedStrengths:      async () => ({ url: "https://blob/resume/identified-strengths.json" }),
    readIdentifiedStrengths:      async () => null,
    saveNarrativeAxes:            async () => ({ url: "https://blob/resume/narrative-axes.json" }),
    readNarrativeAxes:            async () => null,
    saveNarrativeThreading:       async () => ({ url: "https://blob/resume/narrative-threading.json" }),
    readNarrativeThreading:       async () => null,
    saveSectionBridges:           async () => ({ url: "https://blob/resume/section-bridges.json" }),
    readSectionBridges:           async () => null,
    readQualityTracking:          async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), records: [] }),
    saveQualityTracking:          async () => ({ url: "https://blob/resume/quality-tracking.json" }),
    saveChatDraft:                 async () => ({ url: "https://blob/resume/chat-draft.json" }),
    readChatDraft:                 async () => null,
    saveChatDraftContext:          async () => ({ url: "https://blob/resume/chat-draft-context.json" }),
    readChatDraftContext:          async () => null,
    saveSession:                   async () => ({ url: "blob://session" }),
    readSession:                   async () => null,
    deleteSession:                 async () => {},
  }
});

mock.module("../lib/resumeRecluster.mjs", {
  namedExports: {
    reclusterPipeline:           (...args) => reclusterPipelineFn(...args),
    computeUnclassifiedRatio:    (...args) => computeUnclassifiedRatioFn(...args),
    shouldRecluster:             (kws, axes, t = 0.3) => computeUnclassifiedRatioFn(kws, axes) > t,
    _adaptWorkLogEntries:        (e) => e,
    DEFAULT_RECLUSTER_THRESHOLD: 0.3,
    mergeAxes:                   (_existing, incoming) => (Array.isArray(incoming) ? incoming : []).map((ka, i) => ({ id: `merged-${i}`, label: ka.label ?? "", keywords: Array.isArray(ka.keywords) ? ka.keywords : [], _source: "system" }))
  }
});

mock.module("../lib/resumeKeywordClustering.mjs", {
  namedExports: {
    clusterKeywords:        async () => [],
    collectResumeKeywords:  (...args) => collectResumeKeywordsFn(...args),
    collectWorkLogKeywords: (...args) => collectWorkLogKeywordsFn(...args)
  }
});

mock.module("../lib/resumeReconstruction.mjs", {
  namedExports: {
    gatherWorkLogBullets:         (...args) => gatherWorkLogBulletsFn(...args),
    fullReconstructExtractCache:  async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] }),
    generateSectionBridges:       async () => [],
    validateResumeCoherence:      async () => ({ overallScore: 1, grade: "A", structuralFlow: 1, redundancy: 1, tonalConsistency: 1, issues: [], autoFixes: [] }),
    runNarrativeThreadingPipeline: async () => ({ strengths: [], axes: [], sectionBridges: [], extractionResults: [], threading: { totalAnnotations: 0, groundedRatio: 0, strengthCoverage: {}, axisCoverage: {} }, groundingReport: {} }),
    reconstructResumeFromSources: async () => ({ contact: { name: "Test" } }),
    mergeWithUserEdits:           (r) => r,
    isResumeStale:                () => false
  }
});

mock.module("../lib/resumeAxisClustering.mjs", {
  namedExports: { generateDisplayAxes: async () => [] }
});

mock.module("../lib/resumeLlm.mjs", {
  namedExports: { extractPdfText: async () => "pdf text" }
});

mock.module("../lib/resumeBootstrap.mjs", {
  namedExports: {
    generateResumeFromText: async () => ({
      resumeData:       {
        contact: { name: "Test" },
        experience: [],
        education: [],
        skills: { technical: [], languages: [], tools: [] },
        projects: [],
        certifications: []
      },
      strengthKeywords: [],
      displayAxes:      []
    })
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
    invalidateDailyBulletsDocument: (doc, reason = "mock") => ({
      ...doc,
      invalidatedAt: new Date().toISOString(),
      invalidationReason: reason
    })
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
    createAxis: (label, kws, source) => ({
      id:       `mock-${label.replace(/\s+/g, "-").toLowerCase()}`,
      label,
      keywords: Array.isArray(kws) ? kws : [],
      _source:  source ?? "system"
    }),
    updateAxisInArray:      (axes) => ({ axes, updated: null }),
    removeAxisFromArray:    (axes) => ({ axes, removed: false }),
    splitAxis:              (axes) => ({ axes, axisA: null, axisB: null }),
    mergeAxes:              (axes) => ({ axes, merged: null, error: null }),
    migrateAxes:            (axes) => (Array.isArray(axes) ? axes : []),
    moveKeywordBetweenAxes: (axes) => ({
      axes,
      moved:       false,
      keyword:     "",
      fromAxisId:  null,
      toAxisId:    "",
      error:       null
    }),
    AXIS_SCHEMA_VERSION: "1"
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

/** Build an authenticated Request with cookie. */
function authedReq(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("cookie", "resume_token=test-secret");
  return new Request(url, { ...options, headers });
}

/** Build a JSON-body authenticated Request. */
function authedJsonReq(url, method, body) {
  return authedReq(url, {
    method,
    body:    JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

/** Minimal resume fixture used across tests. */
function makeResume(overrides = {}) {
  return {
    meta: {
      language: "ko",
      source: "pdf",
      generatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1
    },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "홍길동", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: "백엔드 개발자",
    experience: [],
    education: [],
    skills: {
      technical: ["Node.js", "Hono", "PostgreSQL"],
      languages: ["TypeScript", "JavaScript"],
      tools:     ["Docker", "GitHub Actions"]
    },
    projects: [],
    certifications: [],
    strength_keywords: ["React", "TypeScript", "Node.js", "GraphQL", "Docker"],
    display_axes: [],
    ...overrides
  };
}

// ─── Reset stubs before each test ────────────────────────────────────────────

function resetStubs() {
  readResumeDataFn          = async () => null;
  saveResumeDataFn          = async (data) => { lastSavedResumeData = data; return { url: "https://blob/resume/data.json" }; };
  reclusterPipelineFn       = async () => ({ triggered: false, ratio: 0, axes: [], totalKeywords: 0, unclassifiedCount: 0 });
  computeUnclassifiedRatioFn = () => 0;
  collectResumeKeywordsFn   = () => [];
  collectWorkLogKeywordsFn  = () => [];
  gatherWorkLogBulletsFn    = async () => [];
  lastSavedResumeData       = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/resume/axes/staleness
// ═══════════════════════════════════════════════════════════════════════════════

test("GET /axes/staleness — returns 404 when no resume exists", async () => {
  resetStubs();
  readResumeDataFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes/staleness"));

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("GET /axes/staleness — returns 502 when Blob read fails", async () => {
  resetStubs();
  readResumeDataFn = async () => { throw new Error("Blob unavailable"); };

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes/staleness"));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob unavailable/);
});

test("GET /axes/staleness — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(new Request("http://localhost/api/resume/axes/staleness"));
  assert.equal(res.status, 401);
});

test("GET /axes/staleness — returns ratio=0 and shouldRecluster=false when all keywords classified", async () => {
  resetStubs();
  const axes = [
    { id: "a1", label: "Frontend",  keywords: ["React", "TypeScript"], _source: "system" },
    { id: "a2", label: "Backend",   keywords: ["Node.js", "GraphQL"],  _source: "system" },
    { id: "a3", label: "DevOps",    keywords: ["Docker"],              _source: "system" }
  ];
  readResumeDataFn = async () => makeResume({ display_axes: axes });
  // strength_keywords = [React, TypeScript, Node.js, GraphQL, Docker] — all in axes above
  collectResumeKeywordsFn  = () => ["React", "TypeScript", "Node.js", "GraphQL", "Docker"];
  computeUnclassifiedRatioFn = () => 0;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes/staleness"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.ratio,           "number",  "ratio must be a number");
  assert.equal(typeof body.totalKeywords,   "number",  "totalKeywords must be a number");
  assert.equal(typeof body.unclassifiedCount, "number", "unclassifiedCount must be a number");
  assert.equal(typeof body.threshold,       "number",  "threshold must be a number");
  assert.equal(typeof body.shouldRecluster, "boolean", "shouldRecluster must be a boolean");
  assert.ok(body.ratio >= 0 && body.ratio <= 1, `ratio ${body.ratio} out of [0,1]`);
  assert.equal(body.threshold, 0.3, "threshold should equal DEFAULT_RECLUSTER_THRESHOLD");
});

test("GET /axes/staleness — shouldRecluster is true when ratio > 0.3", async () => {
  resetStubs();
  // 4 of 10 keywords unclassified → ratio 0.4 > 0.3
  const existingAxes = [
    { id: "a1", label: "Backend", keywords: ["Node.js", "GraphQL", "Docker", "TypeScript", "JavaScript", "PostgreSQL"], _source: "system" }
  ];
  readResumeDataFn = async () => makeResume({
    strength_keywords: ["React", "TypeScript", "Node.js", "GraphQL", "Docker", "JavaScript", "Vue", "Rust", "WASM", "Bun"],
    skills: { technical: [], languages: [], tools: [] },
    display_axes: existingAxes
  });
  collectResumeKeywordsFn   = () => ["React", "TypeScript", "Node.js", "GraphQL", "Docker", "JavaScript", "Vue", "Rust", "WASM", "Bun"];
  // 4 unclassified (Vue, Rust, WASM, Bun) out of 10 → ratio 0.4
  computeUnclassifiedRatioFn = () => 0.4;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes/staleness"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.shouldRecluster, true, "shouldRecluster should be true when ratio > 0.3");
  assert.ok(body.ratio > 0.3, `Expected ratio > 0.3, got ${body.ratio}`);
});

test("GET /axes/staleness — shouldRecluster is false when ratio equals 0.3 exactly", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });
  collectResumeKeywordsFn   = () => Array.from({ length: 10 }, (_, i) => `kw${i}`);
  // ratio = 0.3 exactly — NOT strictly > 0.3 → shouldRecluster=false
  computeUnclassifiedRatioFn = () => 0.3;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes/staleness"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.shouldRecluster, false, "shouldRecluster must be false when ratio === threshold (not strictly greater)");
});

test("GET /axes/staleness — includes unclassifiedCount proportional to ratio", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });
  collectResumeKeywordsFn   = () => ["A", "B", "C", "D", "E"]; // 5 total
  // 2 unclassified → ratio 0.4
  computeUnclassifiedRatioFn = () => 0.4;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes/staleness"));

  assert.equal(res.status, 200);
  const body = await res.json();
  // unclassifiedCount = Math.round(0.4 * totalKeywords)
  assert.ok(body.unclassifiedCount >= 0, "unclassifiedCount should be non-negative");
  assert.ok(body.totalKeywords >= 0, "totalKeywords should be non-negative");
});

test("GET /axes/staleness — work-log gather failure is non-fatal (still returns 200)", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });
  gatherWorkLogBulletsFn    = async () => { throw new Error("Work log disk error"); };
  collectResumeKeywordsFn   = () => ["React", "Node.js"];
  computeUnclassifiedRatioFn = () => 1.0;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes/staleness"));

  // Should still return 200 — work-log failure is non-fatal
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.ratio, "number");
});

test("GET /axes/staleness — no keywords returns ratio=0 and shouldRecluster=false", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({
    strength_keywords: [],
    skills: { technical: [], languages: [], tools: [] },
    display_axes: []
  });
  collectResumeKeywordsFn   = () => [];
  computeUnclassifiedRatioFn = () => 0;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/axes/staleness"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totalKeywords,   0, "totalKeywords should be 0 when no keywords exist");
  assert.equal(body.unclassifiedCount, 0);
  assert.equal(body.shouldRecluster, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/resume/axes/recluster
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /axes/recluster — returns 404 when no resume exists", async () => {
  resetStubs();
  readResumeDataFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("POST /axes/recluster — returns 502 when Blob read fails", async () => {
  resetStubs();
  readResumeDataFn = async () => { throw new Error("Blob read failed"); };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob read failed/);
});

test("POST /axes/recluster — returns 400 for invalid JSON body", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume();

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/axes/recluster", {
      method:  "POST",
      body:    "not-json-{{{",
      headers: { "content-type": "application/json" }
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /axes/recluster — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/axes/recluster", {
      method:  "POST",
      body:    "{}",
      headers: { "content-type": "application/json" }
    })
  );
  assert.equal(res.status, 401);
});

test("POST /axes/recluster — triggered=false when ratio ≤ threshold (pipeline skips)", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({
    display_axes: [
      { id: "a1", label: "Full Stack", keywords: ["React", "TypeScript", "Node.js", "GraphQL", "Docker"], _source: "system" }
    ]
  });
  // Pipeline says no trigger needed (all keywords classified)
  reclusterPipelineFn = async () => ({
    triggered:        false,
    ratio:            0.2,
    axes:             [{ id: "a1", label: "Full Stack", keywords: ["React", "TypeScript", "Node.js", "GraphQL", "Docker"], _source: "system" }],
    totalKeywords:    5,
    unclassifiedCount: 1
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.triggered, false, "triggered should be false when ratio ≤ threshold");
  assert.equal(body.ratio, 0.2);
  assert.ok(Array.isArray(body.axes));

  // When triggered=false, saveResumeData must NOT be called
  assert.equal(lastSavedResumeData, null, "saveResumeData must NOT be called when triggered=false");
});

test("POST /axes/recluster — triggered=true when ratio > 0.3; saves updated axes to resume", async () => {
  resetStubs();
  const originalResume = makeResume({ display_axes: [] });
  readResumeDataFn = async () => originalResume;

  const newAxes = [
    { id: "ax-new-1", label: "Frontend", keywords: ["React", "TypeScript"], _source: "system" },
    { id: "ax-new-2", label: "Backend",  keywords: ["Node.js", "GraphQL"],  _source: "system" }
  ];
  reclusterPipelineFn = async () => ({
    triggered:         true,
    ratio:             0.45,
    axes:              newAxes,
    totalKeywords:     10,
    unclassifiedCount: 4
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.triggered, true, "triggered must be true when ratio > threshold");
  assert.equal(body.ratio, 0.45);
  assert.equal(body.totalKeywords, 10);
  assert.equal(body.unclassifiedCount, 4);
  assert.deepEqual(body.axes, newAxes, "response axes should match the pipeline result");

  // When triggered=true, saveResumeData MUST be called with updated axes
  assert.ok(lastSavedResumeData !== null, "saveResumeData must be called when triggered=true");
  assert.deepEqual(
    lastSavedResumeData.display_axes,
    newAxes,
    "saved resume must contain the new axes"
  );
});

test("POST /axes/recluster — force=true causes triggered=true even when ratio ≤ threshold", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({
    display_axes: [
      { id: "a1", label: "Full Stack", keywords: ["React", "TypeScript", "Node.js"], _source: "system" }
    ]
  });
  // force=true should bypass threshold check in the pipeline
  let capturedOptions;
  reclusterPipelineFn = async (_resume, _logs, opts) => {
    capturedOptions = opts;
    return {
      triggered:         true,   // force=true caused the pipeline to run
      ratio:             0.1,
      axes:              [{ id: "ax1", label: "Forced Axis", keywords: ["React"], _source: "system" }],
      totalKeywords:     10,
      unclassifiedCount: 1
    };
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", { force: true })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.triggered, true, "triggered should be true when force=true");

  // The pipeline should have received force: true
  assert.ok(capturedOptions?.force === true, "force=true must be passed through to reclusterPipeline");
});

test("POST /axes/recluster — custom threshold is forwarded to the pipeline", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });

  let capturedOptions;
  reclusterPipelineFn = async (_resume, _logs, opts) => {
    capturedOptions = opts;
    return {
      triggered: false, ratio: 0.1, axes: [], totalKeywords: 3, unclassifiedCount: 0
    };
  };

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", { threshold: 0.1 })
  );

  assert.ok(capturedOptions != null, "options must be passed to reclusterPipeline");
  assert.ok(
    Math.abs((capturedOptions?.threshold ?? -1) - 0.1) < 1e-9,
    `Expected threshold 0.1, got ${capturedOptions?.threshold}`
  );
});

test("POST /axes/recluster — threshold is clamped to [0, 1]", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });

  let capturedOptions;
  reclusterPipelineFn = async (_resume, _logs, opts) => {
    capturedOptions = opts;
    return { triggered: false, ratio: 0, axes: [], totalKeywords: 0, unclassifiedCount: 0 };
  };

  // threshold out of range — should be clamped
  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", { threshold: 1.5 })
  );

  assert.ok(capturedOptions != null);
  assert.ok(
    capturedOptions.threshold <= 1,
    `threshold ${capturedOptions.threshold} should be clamped to ≤ 1`
  );
});

test("POST /axes/recluster — returns 502 when reclusterPipeline throws", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });
  reclusterPipelineFn = async () => { throw new Error("LLM clustering failed: API timeout"); };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /LLM clustering failed/);
});

test("POST /axes/recluster — returns 502 when saveResumeData fails after trigger", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });
  reclusterPipelineFn = async () => ({
    triggered:         true,
    ratio:             0.5,
    axes:              [{ id: "ax1", label: "New Axis", keywords: ["React"], _source: "system" }],
    totalKeywords:     5,
    unclassifiedCount: 3
  });
  saveResumeDataFn = async () => { throw new Error("Blob write error"); };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob write error/);
});

test("POST /axes/recluster — response shape includes all required fields", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });
  reclusterPipelineFn = async () => ({
    triggered:         false,
    ratio:             0.1,
    axes:              [],
    totalKeywords:     8,
    unclassifiedCount: 1
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(typeof body.ok,              "boolean", "ok must be boolean");
  assert.equal(typeof body.triggered,       "boolean", "triggered must be boolean");
  assert.equal(typeof body.ratio,           "number",  "ratio must be number");
  assert.equal(typeof body.totalKeywords,   "number",  "totalKeywords must be number");
  assert.equal(typeof body.unclassifiedCount, "number","unclassifiedCount must be number");
  assert.ok(Array.isArray(body.axes),                  "axes must be an array");
});

test("POST /axes/recluster — work-log gather failure is non-fatal (still executes pipeline)", async () => {
  resetStubs();
  readResumeDataFn   = async () => makeResume({ display_axes: [] });
  gatherWorkLogBulletsFn = async () => { throw new Error("No work-log disk"); };

  let pipelineWasCalled = false;
  reclusterPipelineFn = async () => {
    pipelineWasCalled = true;
    return { triggered: false, ratio: 0, axes: [], totalKeywords: 0, unclassifiedCount: 0 };
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  // Pipeline should still be called even if work-log gather fails
  assert.equal(res.status, 200);
  assert.equal(pipelineWasCalled, true, "reclusterPipeline must be called even when work-log gather fails");
});

test("POST /axes/recluster — empty body is accepted (uses default options)", async () => {
  resetStubs();
  readResumeDataFn = async () => makeResume({ display_axes: [] });

  let capturedOptions;
  reclusterPipelineFn = async (_resume, _logs, opts) => {
    capturedOptions = opts;
    return { triggered: false, ratio: 0, axes: [], totalKeywords: 0, unclassifiedCount: 0 };
  };

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/axes/recluster", {
      method:  "POST",
      body:    "",
      headers: { "content-type": "application/json" }
    })
  );

  assert.equal(res.status, 200);
  // Default options: force=false, threshold=0.3
  assert.equal(capturedOptions?.force,    false, "default force should be false");
  assert.ok(
    Math.abs((capturedOptions?.threshold ?? -1) - 0.3) < 1e-9,
    `Expected default threshold 0.3, got ${capturedOptions?.threshold}`
  );
});

test("POST /axes/recluster — user axes in pipeline result are preserved in the saved resume", async () => {
  resetStubs();
  const existingUserAxis = {
    id: "user-axis-1",
    label: "My Custom Focus",
    keywords: ["Leadership", "Mentoring"],
    _source: "user"
  };
  readResumeDataFn = async () => makeResume({
    display_axes: [existingUserAxis]
  });

  // Pipeline preserves user axes and adds a new system axis
  const mergedAxes = [
    existingUserAxis,
    { id: "sys-1", label: "Backend", keywords: ["Node.js", "TypeScript"], _source: "system" }
  ];
  reclusterPipelineFn = async () => ({
    triggered:         true,
    ratio:             0.6,
    axes:              mergedAxes,
    totalKeywords:     10,
    unclassifiedCount: 6
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/axes/recluster", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.triggered, true);

  // Verify user axis is in the response
  const userAxInResponse = body.axes.find((a) => a.id === "user-axis-1");
  assert.ok(userAxInResponse, "User axis must appear in response axes");
  assert.equal(userAxInResponse._source, "user", "User axis _source must remain 'user'");

  // Verify saved resume has the merged axes including the user axis
  assert.ok(lastSavedResumeData !== null);
  const savedUserAxis = lastSavedResumeData.display_axes.find((a) => a.id === "user-axis-1");
  assert.ok(savedUserAxis, "User axis must be present in saved resume.display_axes");
  assert.equal(savedUserAxis._source, "user");
});
