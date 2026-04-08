/**
 * Tests for the keyword-move endpoint (Sub-AC 18b).
 *
 * Verifies that:
 *   - PATCH /api/resume/keywords/:id/move moves a keyword from one display axis
 *     to another and persists the result.
 *   - PATCH /api/resume/keywords/:id/move operates on keyword-cluster axes when
 *     axisType="keyword".
 *   - Returns 200 + moved:false when the keyword is already in the destination.
 *   - Returns 400 on missing/invalid parameters.
 *   - Returns 404 when the resume/axes document does not exist.
 *   - Returns 422 when the keyword is not found in any axis.
 *   - Returns 502 on Blob read/write failure.
 *   - Returns 401 when not authenticated.
 *
 * Endpoints under test:
 *   PATCH /api/resume/keywords/:id/move
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.keyword-move.test.mjs
 *
 * Strategy
 * --------
 * All Blob I/O and resumeAxes calls are stubbed via Node.js module mocks so
 * tests run fully offline.  Mutable wrapper functions let each test control
 * what the stubs return.  All mocks are registered before the router is
 * imported (required by --experimental-test-module-mocks).
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

/** Controls what readResumeData() returns. */
let readResumeDataFn = async () => null;

/** Records the last data passed to saveResumeData(). */
let lastSavedResumeData = null;
let saveResumeDataFn = async (data) => {
  lastSavedResumeData = data;
  return { url: "https://blob/resume/data.json" };
};

/** Controls what readKeywordClusterAxes() returns. */
let readKeywordClusterAxesFn = async () => null;

/** Records the last doc passed to saveKeywordClusterAxes(). */
let lastSavedClusterAxesDoc = null;
let saveKeywordClusterAxesFn = async (doc) => {
  lastSavedClusterAxesDoc = doc;
  return { url: "https://blob/resume/keyword-cluster-axes.json" };
};

/**
 * Controls what moveKeywordBetweenAxes() returns.
 * Default: successful move of "Node.js" from "axis-1" to "axis-2".
 */
let moveKeywordBetweenAxesFn = (axes) => ({
  axes,
  moved: true,
  keyword: "Node.js",
  fromAxisId: "axis-1",
  toAxisId: "axis-2",
  error: null
});

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    // Display axes — inside resume/data.json
    readResumeData:               (...args) => readResumeDataFn(...args),
    saveResumeData:               (...args) => saveResumeDataFn(...args),

    // Independent display-axes blob (not used by keyword-move, but imported)
    readDisplayAxes:              async () => null,
    saveDisplayAxes:              async () => ({ url: "https://blob/resume/display-axes.json" }),
    DISPLAY_AXES_PATHNAME:        "resume/display-axes.json",

    // Keyword-cluster axes store
    readKeywordClusterAxes:       (...args) => readKeywordClusterAxesFn(...args),
    saveKeywordClusterAxes:       (...args) => saveKeywordClusterAxesFn(...args),

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
    checkPdfRawExists:            async () => ({ exists: true, url: "https://blob/resume/resume.pdf" }),
    PDF_RAW_PATHNAME:             "resume/resume.pdf",
    markResumeForReconstruction:  async () => {},
    clearReconstructionMarker:    async () => {},
    checkReconstructionMarker:    async () => ({ needsRebuild: false }),
    SNAPSHOTS_PREFIX:             "resume/snapshots/",
    saveSnapshot:                 async () => ({ snapshotKey: "resume/snapshots/test.json", url: "https://blob/test" }),
    listSnapshots:                async () => [],
    readSnapshotByKey:            async () => null,
    readStrengthKeywords:         async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "system", keywords: [] }),
    saveStrengthKeywords:         async () => ({ url: "https://blob/resume/strength-keywords.json" }),
    STRENGTH_KEYWORDS_PATHNAME:   "resume/strength-keywords.json",
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

mock.module("../lib/resumeAxes.mjs", {
  namedExports: {
    createAxis:             (label, kws, source) => ({
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
    moveKeywordBetweenAxes: (...args) => moveKeywordBetweenAxesFn(...args),
    AXIS_SCHEMA_VERSION:    "1"
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
    mergeAxes:                   (existing, next) => (Array.isArray(next) ? next : existing ?? []),
    DEFAULT_RECLUSTER_THRESHOLD: 0.3
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

/** Build a JSON-body PATCH request with auth cookie. */
function authedPatch(url, body) {
  return authedReq(url, {
    method: "PATCH",
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

function _sampleDisplayAxes() {
  return [
    { id: "axis-1", label: "Backend",  keywords: ["Node.js", "Python"], _source: "system" },
    { id: "axis-2", label: "Frontend", keywords: ["React", "Preact"],   _source: "system" }
  ];
}

function _sampleClusterAxesDoc() {
  return {
    schemaVersion: "1",
    generatedAt: "2025-01-01T00:00:00.000Z",
    axes: [
      { id: "axis-c1", label: "Core Skills",  keywords: ["TypeScript", "Node.js"], _source: "system" },
      { id: "axis-c2", label: "Cloud",        keywords: ["AWS", "Docker"],         _source: "system" }
    ]
  };
}

// ─── Reset stubs before each test ────────────────────────────────────────────

function resetStubs() {
  readResumeDataFn = async () => null;
  saveResumeDataFn = async (data) => {
    lastSavedResumeData = data;
    return { url: "https://blob/resume/data.json" };
  };
  readKeywordClusterAxesFn = async () => null;
  saveKeywordClusterAxesFn = async (doc) => {
    lastSavedClusterAxesDoc = doc;
    return { url: "https://blob/resume/keyword-cluster-axes.json" };
  };
  moveKeywordBetweenAxesFn = (axes) => ({
    axes,
    moved: true,
    keyword: "Node.js",
    fromAxisId: "axis-1",
    toAxisId: "axis-2",
    error: null
  });
  lastSavedResumeData = null;
  lastSavedClusterAxesDoc = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/resume/keywords/:id/move — display axes (axisType="display")
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/keywords/:id/move — successfully moves keyword in display axes", async () => {
  resetStubs();
  const axes = _sampleDisplayAxes();
  readResumeDataFn = async () => _storedResume(axes);

  const movedAxes = [
    { id: "axis-1", label: "Backend",  keywords: ["Python"],                _source: "user" },
    { id: "axis-2", label: "Frontend", keywords: ["React", "Preact", "Node.js"], _source: "user" }
  ];
  moveKeywordBetweenAxesFn = () => ({
    axes: movedAxes,
    moved: true,
    keyword: "Node.js",
    fromAxisId: "axis-1",
    toAxisId: "axis-2",
    error: null
  });

  const app = buildApp();
  const res = await app.fetch(
    authedPatch(
      "http://localhost/api/resume/keywords/Node.js/move",
      { toAxisId: "axis-2", fromAxisId: "axis-1" }
    )
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.moved, true);
  assert.equal(body.keyword, "Node.js");
  assert.equal(body.fromAxisId, "axis-1");
  assert.equal(body.toAxisId, "axis-2");
  assert.ok(Array.isArray(body.axes), "axes should be an array");
  assert.deepEqual(body.axes, movedAxes);
});

test("PATCH /api/resume/keywords/:id/move — persists updated resume via saveResumeData", async () => {
  resetStubs();
  const axes = _sampleDisplayAxes();
  readResumeDataFn = async () => _storedResume(axes);

  const movedAxes = [
    { id: "axis-1", label: "Backend",  keywords: ["Python"],                _source: "user" },
    { id: "axis-2", label: "Frontend", keywords: ["React", "Preact", "Node.js"], _source: "user" }
  ];
  moveKeywordBetweenAxesFn = () => ({
    axes: movedAxes, moved: true, keyword: "Node.js",
    fromAxisId: "axis-1", toAxisId: "axis-2", error: null
  });

  const app = buildApp();
  await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", { toAxisId: "axis-2" })
  );

  assert.ok(lastSavedResumeData !== null, "saveResumeData must be called");
  assert.deepEqual(
    lastSavedResumeData.display_axes,
    movedAxes,
    "saved display_axes must be the updated axes"
  );
  assert.equal(
    lastSavedResumeData._sources?.display_axes,
    "user",
    "display_axes source must be marked as 'user'"
  );
});

test("PATCH /api/resume/keywords/:id/move — URL-encodes multi-word keywords correctly", async () => {
  resetStubs();
  const axes = [
    { id: "axis-1", label: "Frontend", keywords: ["React Native"], _source: "system" },
    { id: "axis-2", label: "Mobile",   keywords: [],               _source: "system" }
  ];
  readResumeDataFn = async () => _storedResume(axes);

  let capturedKeyword = null;
  moveKeywordBetweenAxesFn = (_axes, kw) => {
    capturedKeyword = kw;
    return { axes: _axes, moved: true, keyword: kw, fromAxisId: "axis-1", toAxisId: "axis-2", error: null };
  };

  const app = buildApp();
  const res = await app.fetch(
    authedPatch(
      "http://localhost/api/resume/keywords/React%20Native/move",
      { toAxisId: "axis-2" }
    )
  );

  assert.equal(res.status, 200);
  assert.equal(capturedKeyword, "React Native", "keyword should be URL-decoded");
});

test("PATCH /api/resume/keywords/:id/move — returns moved:false when keyword already in destination", async () => {
  resetStubs();
  const axes = _sampleDisplayAxes();
  readResumeDataFn = async () => _storedResume(axes);

  moveKeywordBetweenAxesFn = () => ({
    axes,
    moved: false,
    keyword: "Node.js",
    fromAxisId: "axis-1",
    toAxisId: "axis-1",
    error: null
  });

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", { toAxisId: "axis-1" })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.moved, false, "moved should be false for no-op");
  // saveResumeData must NOT be called in the no-op case
  assert.equal(lastSavedResumeData, null, "saveResumeData must NOT be called for no-op move");
});

test("PATCH /api/resume/keywords/:id/move — defaults to axisType='display' when omitted", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_sampleDisplayAxes());

  let resumeWasRead = false;
  readResumeDataFn = async () => {
    resumeWasRead = true;
    return _storedResume(_sampleDisplayAxes());
  };

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", { toAxisId: "axis-2" })
  );

  // Should have gone through the display path (readResumeData called)
  assert.equal(resumeWasRead, true, "readResumeData must be called for display path");
  assert.equal(res.status, 200);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/resume/keywords/:id/move — keyword cluster axes (axisType="keyword")
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/keywords/:id/move — moves keyword in keyword-cluster axes", async () => {
  resetStubs();
  const doc = _sampleClusterAxesDoc();
  readKeywordClusterAxesFn = async () => doc;

  const movedAxes = [
    { id: "axis-c1", label: "Core Skills", keywords: ["TypeScript"],          _source: "user" },
    { id: "axis-c2", label: "Cloud",       keywords: ["AWS", "Docker", "Node.js"], _source: "user" }
  ];
  moveKeywordBetweenAxesFn = () => ({
    axes: movedAxes, moved: true, keyword: "Node.js",
    fromAxisId: "axis-c1", toAxisId: "axis-c2", error: null
  });

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", {
      toAxisId: "axis-c2",
      fromAxisId: "axis-c1",
      axisType: "keyword"
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.moved, true);
  assert.equal(body.keyword, "Node.js");
  assert.deepEqual(body.axes, movedAxes);
});

test("PATCH /api/resume/keywords/:id/move — persists updated keyword-cluster axes", async () => {
  resetStubs();
  readKeywordClusterAxesFn = async () => _sampleClusterAxesDoc();

  const movedAxes = [
    { id: "axis-c1", label: "Core Skills", keywords: ["TypeScript"],          _source: "user" },
    { id: "axis-c2", label: "Cloud",       keywords: ["AWS", "Docker", "Node.js"], _source: "user" }
  ];
  moveKeywordBetweenAxesFn = () => ({
    axes: movedAxes, moved: true, keyword: "Node.js",
    fromAxisId: "axis-c1", toAxisId: "axis-c2", error: null
  });

  const app = buildApp();
  await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", {
      toAxisId: "axis-c2",
      axisType: "keyword"
    })
  );

  assert.ok(lastSavedClusterAxesDoc !== null, "saveKeywordClusterAxes must be called");
  assert.deepEqual(lastSavedClusterAxesDoc.axes, movedAxes);
  assert.ok(
    typeof lastSavedClusterAxesDoc.updatedAt === "string",
    "updatedAt must be set on keyword-cluster save"
  );
});

test("PATCH /api/resume/keywords/:id/move — keyword type: no-op (moved:false) does not save", async () => {
  resetStubs();
  const doc = _sampleClusterAxesDoc();
  readKeywordClusterAxesFn = async () => doc;

  moveKeywordBetweenAxesFn = () => ({
    axes: doc.axes, moved: false, keyword: "Node.js",
    fromAxisId: "axis-c1", toAxisId: "axis-c1", error: null
  });

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", {
      toAxisId: "axis-c1",
      axisType: "keyword"
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.moved, false);
  assert.equal(lastSavedClusterAxesDoc, null, "saveKeywordClusterAxes must NOT be called for no-op");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Validation errors — 400
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/keywords/:id/move — returns 400 when toAxisId is missing", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_sampleDisplayAxes());

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", {})
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("PATCH /api/resume/keywords/:id/move — returns 400 when axisType is invalid", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_sampleDisplayAxes());

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", {
      toAxisId: "axis-2",
      axisType: "invalid-type"
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/keywords/:id/move — returns 400 when request body is not valid JSON", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/keywords/Node.js/move", {
      method: "PATCH",
      body: "not-json",
      headers: { "content-type": "application/json" }
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Not-found errors — 404
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/keywords/:id/move — returns 404 when resume does not exist (display)", async () => {
  resetStubs();
  readResumeDataFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", { toAxisId: "axis-2" })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/keywords/:id/move — returns 404 when axis store does not exist (keyword)", async () => {
  resetStubs();
  readKeywordClusterAxesFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", {
      toAxisId: "axis-c2",
      axisType: "keyword"
    })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/keywords/:id/move — returns 404 when destination axis not found", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_sampleDisplayAxes());

  moveKeywordBetweenAxesFn = (axes) => ({
    axes, moved: false, keyword: "Node.js", fromAxisId: null, toAxisId: "missing-axis",
    error: "Destination axis not found: missing-axis"
  });

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", { toAxisId: "missing-axis" })
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Unprocessable Entity — 422
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/keywords/:id/move — returns 422 when keyword not found in any axis", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_sampleDisplayAxes());

  moveKeywordBetweenAxesFn = (axes) => ({
    axes, moved: false, keyword: "Ghost", fromAxisId: null, toAxisId: "axis-2",
    error: "Keyword not found in any axis: Ghost"
  });

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Ghost/move", { toAxisId: "axis-2" })
  );

  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Blob errors — 502
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/keywords/:id/move — returns 502 when readResumeData throws", async () => {
  resetStubs();
  readResumeDataFn = async () => { throw new Error("Blob unavailable"); };

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", { toAxisId: "axis-2" })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob unavailable/);
});

test("PATCH /api/resume/keywords/:id/move — returns 502 when saveResumeData throws", async () => {
  resetStubs();
  readResumeDataFn = async () => _storedResume(_sampleDisplayAxes());
  saveResumeDataFn = async () => { throw new Error("Write failed"); };

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", { toAxisId: "axis-2" })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/keywords/:id/move — returns 502 when readKeywordClusterAxes throws", async () => {
  resetStubs();
  readKeywordClusterAxesFn = async () => { throw new Error("Cluster blob read error"); };

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", {
      toAxisId: "axis-c2",
      axisType: "keyword"
    })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Cluster blob read error/);
});

test("PATCH /api/resume/keywords/:id/move — returns 502 when saveKeywordClusterAxes throws", async () => {
  resetStubs();
  readKeywordClusterAxesFn = async () => _sampleClusterAxesDoc();
  saveKeywordClusterAxesFn = async () => { throw new Error("Cluster blob write error"); };

  const app = buildApp();
  const res = await app.fetch(
    authedPatch("http://localhost/api/resume/keywords/Node.js/move", {
      toAxisId: "axis-c2",
      axisType: "keyword"
    })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Authentication
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/keywords/:id/move — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/keywords/Node.js/move", {
      method: "PATCH",
      body: JSON.stringify({ toAxisId: "axis-2" }),
      headers: { "content-type": "application/json" }
    })
  );

  assert.equal(res.status, 401);
});

test("PATCH /api/resume/keywords/:id/move — returns 401 with wrong token", async () => {
  resetStubs();
  const app = buildApp("correct-secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/keywords/Node.js/move", {
      method: "PATCH",
      body: JSON.stringify({ toAxisId: "axis-2" }),
      headers: {
        "content-type": "application/json",
        "cookie": "resume_token=wrong-secret"
      }
    })
  );

  assert.equal(res.status, 401);
});
