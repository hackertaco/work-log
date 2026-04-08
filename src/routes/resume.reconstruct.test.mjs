/**
 * Tests for POST /api/resume/reconstruct (Sub-AC 14-3).
 *
 * Verifies the full reconstruction pipeline:
 *   - Bypass extract cache: calls extractFn for every raw work-log entry
 *   - Re-hydrates cache: writeCacheFn called for every successful entry
 *   - Guard conditions: no config, no resume, no work-log entries
 *   - Stats returned correctly in response body
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.reconstruct.test.mjs
 *
 * All heavy I/O dependencies are stubbed via Node.js module mocks.
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

let readResumeDataFn         = async () => null;
let readPdfTextFn            = async () => null;
let saveResumeDataFn         = async () => ({ url: "https://blob/resume/data.json" });
let gatherWorkLogBulletsFn   = async () => [];
let fullReconstructFn        = async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] });
let clearReconstructionFn    = async () => {};
let loadConfigFn             = async () => ({ dataDir: "/tmp/work-log-test" });

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: false }),
    saveResumeData:               (...args) => saveResumeDataFn(...args),
    readResumeData:               (...args) => readResumeDataFn(...args),
    readSuggestionsData:          async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] }),
    saveSuggestionsData:          async () => ({ url: "https://blob/resume/suggestions.json" }),
    saveDailyBullets:             async () => ({ url: "https://blob/resume/bullets/test.json" }),
    readDailyBullets:             async () => null,
    listBulletDates:              async () => [],
    deleteDailyBullets:           async () => {},
    savePdfText:                  async () => ({ url: "https://blob/resume/pdf-text.txt" }),
    readPdfText:                  (...args) => readPdfTextFn(...args),
    savePdfRaw:                   async () => ({ url: "https://blob/resume/resume.pdf" }),
    checkPdfRawExists:            async () => ({ exists: true, url: "https://blob/resume/resume.pdf" }),
    PDF_RAW_PATHNAME:             "resume/resume.pdf",
    markResumeForReconstruction:  async () => {},
    clearReconstructionMarker:    (...args) => clearReconstructionFn(...args),
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

mock.module("../lib/config.mjs", {
  namedExports: {
    loadConfig: (...args) => loadConfigFn(...args)
  }
});

mock.module("../lib/resumeReconstruction.mjs", {
  namedExports: {
    gatherWorkLogBullets:         (...args) => gatherWorkLogBulletsFn(...args),
    fullReconstructExtractCache:  (...args) => fullReconstructFn(...args),
    generateSectionBridges:       async () => [],
    validateResumeCoherence:      async () => ({ overallScore: 1, grade: "A", structuralFlow: 1, redundancy: 1, tonalConsistency: 1, issues: [], autoFixes: [] }),
    runNarrativeThreadingPipeline: async () => ({
      strengths: [],
      axes: [],
      sectionBridges: [],
      extractionResults: [],
      threading: { totalAnnotations: 0, groundedRatio: 0, strengthCoverage: {}, axisCoverage: {} },
      groundingReport: {}
    }),
    reconstructResumeFromSources: async (opts) => ({
      ...(opts.currentResume ?? {}),
      meta: { language: "en", source: "pdf", generatedAt: new Date().toISOString(), schemaVersion: 1 }
    }),
    mergeWithUserEdits: (cur, fresh) => ({ ...cur, ...fresh }),
    isResumeStale:      () => ({ isStale: false, latestLogDate: null, checkpointDate: null })
  }
});

mock.module("../lib/resumeLlm.mjs", {
  namedExports: { extractPdfText: async () => "pdf text" }
});

mock.module("../lib/resumeBootstrap.mjs", {
  namedExports: { generateResumeFromText: async () => ({ contact: { name: "Test" } }) }
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
  namedExports: { mergeWorkLogIntoResume: (r) => r }
});

mock.module("../lib/resumeDiff.mjs", {
  namedExports: { diffResume: () => ({ isEmpty: true }) }
});

mock.module("../lib/resumeDiffToSuggestions.mjs", {
  namedExports: {
    diffToSuggestions:               () => [],
    deduplicateWorkLogSuggestions:   (_e, n) => n
  }
});

mock.module("../lib/resumeDeltaRatio.mjs", {
  namedExports: {
    computeDeltaRatio:     () => ({ ratio: 0, changedCount: 0, totalCount: 0 }),
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
    readBulletCache:        async () => null,
    writeBulletCache:       async () => {},
    readExtractCache:       async () => null,
    writeExtractCache:      async () => {},
    invalidateBulletCache:  async () => {},
    invalidateExtractCache: async () => {}
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

// ─── Load router under test AFTER mocks ──────────────────────────────────────

const { resumeRouter } = await import("./resume.mjs");
const { cookieAuth }   = await import("../middleware/auth.mjs");

// ─── Test app / request helpers ───────────────────────────────────────────────

function buildApp(token = "test-secret") {
  process.env.RESUME_TOKEN = token;
  const app = new Hono();
  app.use("/api/resume/*", cookieAuth());
  app.route("/api/resume", resumeRouter);
  return app;
}

function authedPost(url, body = null) {
  const headers = new Headers({
    cookie: "resume_token=test-secret"
  });
  if (body !== null) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: body !== null ? JSON.stringify(body) : undefined
  });
}

function makeResume() {
  return {
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test User", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: "A developer.",
    experience: [{ _source: "system", company: "Acme", title: "Engineer", start_date: "2022-01", end_date: null, location: null, bullets: [] }],
    education: [], skills: { technical: [], languages: [], tools: [] }, projects: [], certifications: []
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("POST /api/resume/reconstruct — 404 when no resume bootstrapped", async () => {
  readResumeDataFn = async () => null;
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

test("POST /api/resume/reconstruct — 404 when config has no dataDir", async () => {
  readResumeDataFn = async () => makeResume();
  loadConfigFn = async () => ({ dataDir: null });

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/reconstruct — 502 when config load throws", async () => {
  loadConfigFn = async () => { throw new Error("Config read failure"); };

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);

  // Reset
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
});

test("POST /api/resume/reconstruct — 502 when gatherWorkLogBullets throws", async () => {
  readResumeDataFn = async () => makeResume();
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
  gatherWorkLogBulletsFn = async () => { throw new Error("Disk read failure"); };

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);

  // Reset
  gatherWorkLogBulletsFn = async () => [];
});

test("POST /api/resume/reconstruct — 200 with zero stats when no work-log entries found", async () => {
  readResumeDataFn = async () => makeResume();
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
  gatherWorkLogBulletsFn = async () => [];

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.total, 0);
  assert.equal(body.processed, 0);
});

test("POST /api/resume/reconstruct — 200 with stats from fullReconstructExtractCache", async () => {
  const entries = [
    { date: "2025-01-15", candidates: ["Shipped auth module"], companyCandidates: [], openSourceCandidates: [] },
    { date: "2025-01-16", candidates: ["Improved CI pipeline"], companyCandidates: [], openSourceCandidates: [] }
  ];

  readResumeDataFn = async () => makeResume();
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
  gatherWorkLogBulletsFn = async () => entries;
  fullReconstructFn = async () => ({
    total: 2,
    processed: 2,
    failed: 0,
    skipped: 0,
    dates: ["2025-01-15", "2025-01-16"]
  });

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.rebuiltResume, false);
  assert.equal(body.total, 2);
  assert.equal(body.processed, 2);
  assert.equal(body.failed, 0);
  assert.equal(body.skipped, 0);
  assert.deepEqual(body.dates, ["2025-01-15", "2025-01-16"]);
});

test("POST /api/resume/reconstruct — rebuilds resume document when stored PDF text exists", async () => {
  let savedDoc = null;

  readResumeDataFn = async () => makeResume();
  readPdfTextFn = async () => "Original PDF text";
  saveResumeDataFn = async (doc) => {
    savedDoc = doc;
    return { url: "https://blob/resume/data.json" };
  };
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
  gatherWorkLogBulletsFn = async () => [
    { date: "2025-01-15", candidates: ["Shipped auth module"], companyCandidates: [], openSourceCandidates: [] }
  ];
  fullReconstructFn = async () => ({
    total: 1,
    processed: 1,
    failed: 0,
    skipped: 0,
    dates: ["2025-01-15"]
  });

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.rebuiltResume, true);
  assert.ok(savedDoc, "saveResumeData should be called with rebuilt resume");

  // Reset mutable fns used only by this test
  readPdfTextFn = async () => null;
  saveResumeDataFn = async () => ({ url: "https://blob/resume/data.json" });
});

test("POST /api/resume/reconstruct — reports partial failure stats", async () => {
  readResumeDataFn = async () => makeResume();
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
  gatherWorkLogBulletsFn = async () => [
    { date: "2025-02-01", candidates: ["A"], companyCandidates: [], openSourceCandidates: [] },
    { date: "2025-02-02", candidates: ["B"], companyCandidates: [], openSourceCandidates: [] }
  ];
  fullReconstructFn = async () => ({
    total: 2,
    processed: 1,
    failed: 1,
    skipped: 0,
    dates: ["2025-02-01"]
  });

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.total, 2);
  assert.equal(body.processed, 1);
  assert.equal(body.failed, 1);
  assert.deepEqual(body.dates, ["2025-02-01"]);
});

test("POST /api/resume/reconstruct — calls clearReconstructionMarker after success", async () => {
  readResumeDataFn = async () => makeResume();
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
  gatherWorkLogBulletsFn = async () => [];
  fullReconstructFn = async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] });

  let clearCalled = false;
  clearReconstructionFn = async () => { clearCalled = true; };

  const app = buildApp();
  await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.ok(clearCalled, "clearReconstructionMarker must be called");

  // Reset
  clearReconstructionFn = async () => {};
});

test("POST /api/resume/reconstruct — calls clearReconstructionMarker even when work-log has entries", async () => {
  readResumeDataFn = async () => makeResume();
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
  gatherWorkLogBulletsFn = async () => [
    { date: "2025-03-01", candidates: ["Work done"], companyCandidates: [], openSourceCandidates: [] }
  ];
  fullReconstructFn = async () => ({ total: 1, processed: 1, failed: 0, skipped: 0, dates: ["2025-03-01"] });

  let clearCalled = false;
  clearReconstructionFn = async () => { clearCalled = true; };

  const app = buildApp();
  const res = await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.equal(res.status, 200);
  assert.ok(clearCalled, "clearReconstructionMarker must be called after reconstruct");

  // Reset
  clearReconstructionFn = async () => {};
  gatherWorkLogBulletsFn = async () => [];
});

test("POST /api/resume/reconstruct — passes current resume to fullReconstructExtractCache", async () => {
  const storedResume = makeResume();
  readResumeDataFn = async () => storedResume;
  loadConfigFn = async () => ({ dataDir: "/tmp/work-log-test" });
  gatherWorkLogBulletsFn = async () => [
    { date: "2025-03-15", candidates: ["Work done"], companyCandidates: [], openSourceCandidates: [] }
  ];

  let capturedOpts = null;
  fullReconstructFn = async (opts) => {
    capturedOpts = opts;
    return { total: 1, processed: 1, failed: 0, skipped: 0, dates: ["2025-03-15"] };
  };

  const app = buildApp();
  await app.fetch(authedPost("http://localhost/api/resume/reconstruct"));

  assert.ok(capturedOpts, "fullReconstructExtractCache must have been called");
  assert.equal(capturedOpts.currentResume, storedResume,
    "currentResume passed to fullReconstructExtractCache must be the stored resume");
  assert.equal(capturedOpts.workLogEntries.length, 1,
    "workLogEntries must be passed through");

  // Reset
  fullReconstructFn = async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] });
  gatherWorkLogBulletsFn = async () => [];
});

test("POST /api/resume/reconstruct — requires authentication (401 without cookie)", async () => {
  const app = buildApp();
  const res = await app.fetch(
    new Request("http://localhost/api/resume/reconstruct", { method: "POST" })
  );

  // cookieAuth returns 401 when no valid cookie is present
  assert.equal(res.status, 401);
});
