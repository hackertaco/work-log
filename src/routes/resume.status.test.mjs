/**
 * Tests for GET /api/resume/status endpoint and /resume page route.
 *
 * Verifies Sub-AC 1: /resume route and resume existence-check API.
 *
 * Run with: node --experimental-test-module-mocks --test src/routes/resume.status.test.mjs
 *
 * Strategy
 * --------
 * The resume router imports `checkResumeExists` directly from blob.mjs.
 * We stub blob.mjs (and every other heavy dependency of resume.mjs) using
 * Node.js built-in module mocks so the tests run fully offline.
 *
 * `mock.module()` must be called before `import()` of the module under test,
 * which is why all mocks are set at the top of this file and the router is
 * loaded via a top-level `await import()`.
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub for checkResumeExists ──────────────────────────────────────
// Each test can reassign `checkResumeExistsFn` to control what the mock returns.

let checkResumeExistsFn = async () => ({ exists: false });

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            (...args) => checkResumeExistsFn(...args),
    saveResumeData:               async () => ({ url: "https://blob/resume/data.json" }),
    readResumeData:               async () => null,
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

mock.module("../lib/resumeLlm.mjs", {
  namedExports: { extractPdfText: async () => "pdf text" }
});

mock.module("../lib/resumeBootstrap.mjs", {
  namedExports: { generateResumeFromText: async () => ({ contact: { name: "Test" } }) }
});

mock.module("../lib/resumeReconstruction.mjs", {
  namedExports: {
    gatherWorkLogBullets:         async () => [],
    fullReconstructExtractCache:  async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] }),
    generateSectionBridges:       async () => [],
    validateResumeCoherence:      async () => ({ overallScore: 1, grade: "A", structuralFlow: 1, redundancy: 1, tonalConsistency: 1, issues: [], autoFixes: [] }),
    runNarrativeThreadingPipeline: async () => ({ strengths: [], axes: [], sectionBridges: [], extractionResults: [], threading: { totalAnnotations: 0, groundedRatio: 0, strengthCoverage: {}, axisCoverage: {} }, groundingReport: {} }),
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
    buildDailyBulletsDocument:  async () => ({ bullets: [] }),
    mergeDailyBulletsDocuments: (a) => a,
    promoteBullet:              (doc) => doc,
    dismissBullet:              (doc) => doc,
    editBullet:                 (doc) => doc
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
  namedExports: { diffToSuggestions: () => [] }
});

mock.module("../lib/resumeDeltaRatio.mjs", {
  namedExports: {
    computeDeltaRatio:     () => 0,
    exceedsDeltaThreshold: () => false,
    DELTA_THRESHOLD:       0.03
  }
});

mock.module("../lib/resumeAxisClustering.mjs", {
  namedExports: { generateDisplayAxes: async () => [] }
});

mock.module("../lib/resumeRecluster.mjs", {
  namedExports: {
    reclusterPipeline:           async () => ({ axes: [], triggered: false, ratio: 0, totalKeywords: 0, unclassifiedCount: 0 }),
    computeUnclassifiedRatio:    () => 0,
    _adaptWorkLogEntries:        (e) => e,
    DEFAULT_RECLUSTER_THRESHOLD: 0.3,
    mergeAxes:                   (_existing, incoming) => (Array.isArray(incoming) ? incoming : []).map((ka, i) => ({ id: `merged-${i}`, label: ka.label ?? "", keywords: Array.isArray(ka.keywords) ? ka.keywords : [], _source: "system" }))
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
    createAxis:             (_label, _kw, _src) => ({ id: `ax-${Date.now()}`, label: _label, keywords: _kw ?? [], _source: _src ?? "system" }),
    updateAxisInArray:      (axes) => axes,
    removeAxisFromArray:    (axes) => axes,
    splitAxis:              (axes) => [axes],
    mergeAxes:              (axes) => ({ axes, merged: axes[0] }),
    migrateAxes:            (axes) => axes,
    moveKeywordBetweenAxes: (axes) => axes
  }
});

mock.module("../lib/resumeKeywordClustering.mjs", {
  namedExports: {
    clusterKeywords:        async () => [],
    collectResumeKeywords:  () => [],
    collectWorkLogKeywords: () => []
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

/**
 * Build a minimal Hono app that mirrors the production setup in server.mjs:
 *   app.use("/api/resume/*", cookieAuth())
 *   app.route("/api/resume", resumeRouter)
 */
function buildApp(resumeToken = "test-secret") {
  process.env.RESUME_TOKEN = resumeToken;
  const app = new Hono();
  app.use("/api/resume/*", cookieAuth());
  app.route("/api/resume", resumeRouter);
  return app;
}

/** Build a Request with the valid auth cookie pre-attached. */
function authedRequest(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("cookie", "resume_token=test-secret");
  return new Request(url, { ...options, headers });
}

// ─── GET /api/resume/status — Happy paths ────────────────────────────────────

test("GET /api/resume/status - returns { exists: false } when Blob has no resume", async () => {
  checkResumeExistsFn = async () => ({ exists: false });
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/status"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { exists: false });
});

test("GET /api/resume/status - returns { exists: true, url, uploadedAt, size } when resume found", async () => {
  const fakeUploadedAt = "2025-03-01T10:00:00.000Z";
  checkResumeExistsFn = async () => ({
    exists:     true,
    url:        "https://blob.vercel-storage.com/resume/data.json",
    uploadedAt: fakeUploadedAt,
    size:       4321
  });

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/status"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exists,     true,            "exists must be true");
  assert.equal(body.uploadedAt, fakeUploadedAt,  "uploadedAt must match");
  assert.equal(body.size,       4321,            "size must match");
  assert.ok(body.url.startsWith("https://"),     "url must be an HTTPS URL");
});

// ─── GET /api/resume/status — Error paths ────────────────────────────────────

test("GET /api/resume/status - returns 502 when Blob throws", async () => {
  checkResumeExistsFn = async () => {
    throw new Error("Blob connection refused");
  };
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/status"));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.ok(body.error,  "Response must contain an error field");
  assert.ok(body.detail, "Response must contain a detail field");
  assert.match(body.detail, /Blob connection refused/);
});

// ─── GET /api/resume/status — Authentication guard ───────────────────────────

test("GET /api/resume/status - returns 401 when no auth cookie provided", async () => {
  const app = buildApp("test-secret");

  // No cookie header
  const res = await app.fetch(new Request("http://localhost/api/resume/status"));

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "Unauthorized");
});

test("GET /api/resume/status - returns 401 when wrong auth token provided", async () => {
  const app = buildApp("correct-secret");

  const headers = new Headers();
  headers.set("cookie", "resume_token=wrong-secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/status", { headers })
  );

  assert.equal(res.status, 401);
});

test("GET /api/resume/status - returns 500 when RESUME_TOKEN env var is unset", async () => {
  delete process.env.RESUME_TOKEN;

  const app = new Hono();
  app.use("/api/resume/*", cookieAuth());
  app.route("/api/resume", resumeRouter);

  const res = await app.fetch(authedRequest("http://localhost/api/resume/status"));

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /not configured/i);

  // Restore for subsequent tests
  process.env.RESUME_TOKEN = "test-secret";
});

// ─── /resume page route — Authentication guard ───────────────────────────────

test("/resume page route - redirects unauthenticated browser visitors to /login", async () => {
  process.env.RESUME_TOKEN = "test-secret";

  const app = new Hono();
  // Mirror the exact guard registration from server.mjs:
  app.use("/resume",   cookieAuth());
  app.use("/resume/*", cookieAuth());
  app.get("/resume",   (c) => c.text("Resume SPA"));

  // No cookie → should redirect
  const res = await app.fetch(new Request("http://localhost/resume"));

  assert.equal(res.status, 302, "Must redirect unauthenticated browser visitor");
  const location = res.headers.get("Location");
  assert.ok(location, "Location header must be present");
  assert.match(location, /\/login/,      "Must redirect to /login");
  assert.match(location, /next=%2Fresume/, "Must encode /resume as the ?next= param");
});

test("/resume page route - serves the SPA page for authenticated users", async () => {
  process.env.RESUME_TOKEN = "test-secret";

  const app = new Hono();
  app.use("/resume",   cookieAuth());
  app.use("/resume/*", cookieAuth());
  app.get("/resume",   (c) => c.text("Resume SPA loaded"));

  const headers = new Headers();
  headers.set("cookie", "resume_token=test-secret");
  const res = await app.fetch(new Request("http://localhost/resume", { headers }));

  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Resume SPA loaded/);
});
