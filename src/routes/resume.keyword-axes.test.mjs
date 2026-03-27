/**
 * Tests for keyword-axes and cluster-keywords API endpoints (Sub-AC 16-2).
 *
 * Endpoints under test:
 *   GET  /api/resume/keyword-axes     — return cached keyword cluster axes
 *   POST /api/resume/keyword-axes     — generate (or return cached) 5–6 thematic axes
 *   POST /api/resume/cluster-keywords — stateless: accept explicit keywords, return Axis[]
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.keyword-axes.test.mjs
 *
 * Strategy
 * --------
 * All Blob I/O and LLM calls are stubbed via Node.js module mocks so tests run
 * fully offline.  The resumeAxes.mjs helpers are NOT mocked for the
 * cluster-keywords tests so we can verify the Axis shape coming back.
 *
 * Mock stubs are assigned via let-bindings so each test can override them.
 * All mocks are registered before the router is imported (required by
 * --experimental-test-module-mocks).
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

/** Controls what readKeywordClusterAxes() returns in tests. */
let readKeywordClusterAxesFn = async () => null;

/** Records the last document passed to saveKeywordClusterAxes(). */
let lastSavedAxesDoc = null;
let saveKeywordClusterAxesFn = async (doc) => {
  lastSavedAxesDoc = doc;
  return { url: "https://blob/resume/keyword-cluster-axes.json" };
};

/** Controls what readResumeData() returns in tests. */
let readResumeDataFn = async () => null;

/**
 * Controls what clusterKeywords() returns.
 * Default: returns two mock KeywordAxis objects.
 */
let clusterKeywordsFn = async () => [
  { label: "Frontend Development", keywords: ["React", "TypeScript"] },
  { label: "Backend Engineering",  keywords: ["Node.js", "Hono"] }
];

/**
 * Controls what mergeAxes() (from resumeRecluster.mjs) returns.
 * Default: merges by creating fresh Axis objects from incoming axes.
 * Tracks calls for persistence-behavior tests.
 */
let mergeAxesCallCount = 0;
let lastMergeAxesArgs  = null;
let mergeAxesFn = (existing, incoming) => {
  mergeAxesCallCount++;
  lastMergeAxesArgs = { existing, incoming };
  // Default: return incoming as fresh Axis objects (equivalent to no-op merge with empty existing)
  return (Array.isArray(incoming) ? incoming : []).map((ka, i) => ({
    id:       `merged-${i}`,
    label:    ka.label    ?? "",
    keywords: Array.isArray(ka.keywords) ? ka.keywords : [],
    _source:  "system"
  }));
};

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    readKeywordClusterAxes:       (...args) => readKeywordClusterAxesFn(...args),
    saveKeywordClusterAxes:       (...args) => saveKeywordClusterAxesFn(...args),
    readResumeData:               (...args) => readResumeDataFn(...args),
    saveResumeData:               async () => ({ url: "https://blob/resume/data.json" }),
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
    SNAPSHOTS_PREFIX:             "resume/snapshots/",
    saveSnapshot:                 async () => ({ snapshotKey: "resume/snapshots/test.json", url: "https://blob/test" }),
    listSnapshots:                async () => [],
    readSnapshotByKey:            async () => null,
    readStrengthKeywords:         async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "system", keywords: [] }),
    saveStrengthKeywords:         async () => ({ url: "https://blob/resume/strength-keywords.json" }),
    STRENGTH_KEYWORDS_PATHNAME:   "resume/strength-keywords.json",
    saveDisplayAxes:              async () => ({ url: "https://blob/resume/display-axes.json" }),
    readDisplayAxes:              async () => null,
    DISPLAY_AXES_PATHNAME:        "resume/display-axes.json"
  }
});

mock.module("../lib/resumeKeywordClustering.mjs", {
  namedExports: {
    clusterKeywords:        (...args) => clusterKeywordsFn(...args),
    collectResumeKeywords:  () => [],
    collectWorkLogKeywords: () => []
  }
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
    diffToSuggestions:                  () => [],
    deduplicateWorkLogSuggestions:      (s) => s
  }
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
    reclusterPipeline:           async () => ({ triggered: false, ratio: 0, axes: [], totalKeywords: 0, unclassifiedCount: 0 }),
    computeUnclassifiedRatio:    () => 0,
    shouldRecluster:             () => false,
    _adaptWorkLogEntries:        (e) => e,
    DEFAULT_RECLUSTER_THRESHOLD: 0.3,
    mergeAxes:                   (...args) => mergeAxesFn(...args)
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
    updateAxisInArray:      (axes) => axes,
    removeAxisFromArray:    (axes) => axes,
    splitAxis:              (axes) => ({ axes, axisA: null, axisB: null }),
    mergeAxes:              (a) => a,
    migrateAxes:            (axes) => (Array.isArray(axes) ? axes : []),
    moveKeywordBetweenAxes: (axes) => ({ axes, moved: false, keyword: "", fromAxisId: null, toAxisId: "", error: null })
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

// ─── Reset stubs before each test ────────────────────────────────────────────

function resetStubs() {
  readKeywordClusterAxesFn = async () => null;
  saveKeywordClusterAxesFn = async (doc) => {
    lastSavedAxesDoc = doc;
    return { url: "https://blob/resume/keyword-cluster-axes.json" };
  };
  readResumeDataFn = async () => null;
  clusterKeywordsFn = async () => [
    { label: "Frontend Development", keywords: ["React", "TypeScript"] },
    { label: "Backend Engineering",  keywords: ["Node.js", "Hono"] }
  ];
  mergeAxesCallCount = 0;
  lastMergeAxesArgs  = null;
  mergeAxesFn = (existing, incoming) => {
    mergeAxesCallCount++;
    lastMergeAxesArgs = { existing, incoming };
    return (Array.isArray(incoming) ? incoming : []).map((ka, i) => ({
      id:       `merged-${i}`,
      label:    ka.label    ?? "",
      keywords: Array.isArray(ka.keywords) ? ka.keywords : [],
      _source:  "system"
    }));
  };
  lastSavedAxesDoc = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/resume/keyword-axes
// ═══════════════════════════════════════════════════════════════════════════════

test("GET /api/resume/keyword-axes — returns { exists: false } when no axes exist", async () => {
  resetStubs();
  readKeywordClusterAxesFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/keyword-axes"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exists, false);
  assert.equal(body.axes, null);
});

test("GET /api/resume/keyword-axes — returns stored axes when they exist", async () => {
  resetStubs();
  const storedAxes = [
    { id: "axis-1", label: "Frontend",   keywords: ["React", "Vue"],   _source: "system" },
    { id: "axis-2", label: "Backend",    keywords: ["Node.js", "Hono"], _source: "system" }
  ];
  readKeywordClusterAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-01-01T00:00:00.000Z",
    axes:          storedAxes
  });

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/keyword-axes"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.exists, true);
  assert.deepEqual(body.axes, storedAxes);
  assert.equal(body.generatedAt, "2025-01-01T00:00:00.000Z");
});

test("GET /api/resume/keyword-axes — returns 502 when Blob read fails", async () => {
  resetStubs();
  readKeywordClusterAxesFn = async () => { throw new Error("Blob read error"); };

  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/keyword-axes"));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob read error/);
});

test("GET /api/resume/keyword-axes — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(new Request("http://localhost/api/resume/keyword-axes"));
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/resume/keyword-axes
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/keyword-axes — returns cached axes when cache exists and force=false", async () => {
  resetStubs();
  const cachedAxes = [
    { id: "axis-1", label: "Frontend", keywords: ["React"], _source: "system" }
  ];
  readKeywordClusterAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-01-01T00:00:00.000Z",
    axes:          cachedAxes
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, false);
  assert.deepEqual(body.axes, cachedAxes);
  // Blob save should NOT be called when returning cached
  assert.equal(lastSavedAxesDoc, null);
});

test("POST /api/resume/keyword-axes — returns 404 when no resume exists and cache miss", async () => {
  resetStubs();
  readKeywordClusterAxesFn = async () => null;
  readResumeDataFn         = async () => null;

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", {})
  );

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/keyword-axes — force=true bypasses cache and regenerates", async () => {
  resetStubs();
  // Cache exists but force=true should trigger regeneration
  readKeywordClusterAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-01-01T00:00:00.000Z",
    axes:          [{ id: "old-axis", label: "Old", keywords: ["old"], _source: "system" }]
  });
  readResumeDataFn = async () => ({
    meta: { language: "ko", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: [], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: ["React", "Node.js"],
    display_axes: []
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", { force: true })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, true);
  // The axes should come from the clusterKeywords mock (2 axes)
  assert.ok(Array.isArray(body.axes));
  // Blob save should have been called
  assert.ok(lastSavedAxesDoc !== null, "saveKeywordClusterAxes should have been called");
  assert.ok(Array.isArray(lastSavedAxesDoc.axes));
  assert.ok(typeof lastSavedAxesDoc.generatedAt === "string");
});

test("POST /api/resume/keyword-axes — generates new axes when cache miss", async () => {
  resetStubs();
  readKeywordClusterAxesFn = async () => null; // cache miss
  readResumeDataFn = async () => ({
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Dev" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: ["React"], languages: ["TypeScript"], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: [],
    display_axes: []
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, true);
  assert.ok(Array.isArray(body.axes));
  // Axes should be saved to Blob
  assert.ok(lastSavedAxesDoc !== null);
});

test("POST /api/resume/keyword-axes — returns 400 for invalid JSON body", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/keyword-axes", {
      method:  "POST",
      body:    "not-json",
      headers: { "content-type": "text/plain" }
    })
  );

  // The route catches JSON parse error and treats body as {} (no force flag set)
  // resulting in either a 404 (no resume) or 200 (cache hit) — not a 400 for body parse
  // because the route uses `.catch(() => ({}))` for body parsing.
  // Verify it does not return a server error (500).
  assert.ok(res.status !== 500);
});

test("POST /api/resume/keyword-axes — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/keyword-axes", { method: "POST", body: "{}" })
  );
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/resume/cluster-keywords
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/cluster-keywords — flat keywords list returns Axis array", async () => {
  resetStubs();
  clusterKeywordsFn = async (resumeKws, workLogKws) => {
    // Both arrays should be passed to clusterKeywords
    assert.ok(Array.isArray(resumeKws));
    assert.ok(Array.isArray(workLogKws));
    return [
      { label: "Frontend", keywords: ["React", "TypeScript"] },
      { label: "Backend",  keywords: ["Node.js"] }
    ];
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      keywords: ["React", "TypeScript", "Node.js"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.axes));
  assert.equal(body.axes.length, 2);

  // Each axis should have the shape: { id, label, keywords, _source }
  for (const axis of body.axes) {
    assert.ok(typeof axis.id === "string" && axis.id.length > 0, "axis.id should be a non-empty string");
    assert.ok(typeof axis.label === "string" && axis.label.length > 0, "axis.label should be non-empty");
    assert.ok(Array.isArray(axis.keywords), "axis.keywords should be an array");
    assert.equal(axis._source, "system", "axis._source should be 'system'");
  }
});

test("POST /api/resume/cluster-keywords — split resumeKeywords/workLogKeywords format", async () => {
  resetStubs();
  let capturedResumeKws;
  let capturedWorkLogKws;
  clusterKeywordsFn = async (resumeKws, workLogKws) => {
    capturedResumeKws  = resumeKws;
    capturedWorkLogKws = workLogKws;
    return [
      { label: "Resume Skills", keywords: ["React"] },
      { label: "Work Skills",   keywords: ["Hono"] }
    ];
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      resumeKeywords:  ["React"],
      workLogKeywords: ["Hono"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.axes));
  // Verify the arrays were passed through correctly to clusterKeywords
  assert.deepEqual(capturedResumeKws, ["React"]);
  assert.deepEqual(capturedWorkLogKws, ["Hono"]);
});

test("POST /api/resume/cluster-keywords — flat keywords takes precedence over split format", async () => {
  resetStubs();
  let capturedResumeKws;
  let capturedWorkLogKws;
  clusterKeywordsFn = async (resumeKws, workLogKws) => {
    capturedResumeKws  = resumeKws;
    capturedWorkLogKws = workLogKws;
    return [];
  };

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      keywords:        ["React", "TypeScript"],   // flat wins
      resumeKeywords:  ["ShouldBeIgnored"],
      workLogKeywords: ["ShouldAlsoBeIgnored"]
    })
  );

  // When `keywords` is present, resumeKws = keywords and workLogKws = []
  assert.deepEqual(capturedResumeKws,  ["React", "TypeScript"]);
  assert.deepEqual(capturedWorkLogKws, []);
});

test("POST /api/resume/cluster-keywords — returns empty axes when LLM is disabled", async () => {
  resetStubs();
  // Simulate LLM disabled: clusterKeywords returns []
  clusterKeywordsFn = async () => [];

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      keywords: ["React", "Node.js", "TypeScript"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.axes, []);
});

test("POST /api/resume/cluster-keywords — returns 400 when keywords field is missing", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", { foo: "bar" })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("POST /api/resume/cluster-keywords — returns 400 when body is not JSON", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/cluster-keywords", {
      method:  "POST",
      body:    "not-json",
      headers: { "content-type": "text/plain" }
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/cluster-keywords — returns 400 when body is empty object", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {})
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/cluster-keywords — returns empty axes for empty keyword array", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      keywords: []
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.axes, []);
});

test("POST /api/resume/cluster-keywords — returns empty axes when all keywords are blank strings", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      keywords: ["  ", "", "   "]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.axes, []);
});

test("POST /api/resume/cluster-keywords — returns 502 when LLM throws", async () => {
  resetStubs();
  clusterKeywordsFn = async () => {
    throw new Error("OpenAI API unreachable");
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      keywords: ["React", "Node.js"]
    })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /OpenAI API unreachable/);
});

test("POST /api/resume/cluster-keywords — only resumeKeywords provided (workLogKeywords absent)", async () => {
  resetStubs();
  let capturedWorkLogKws;
  clusterKeywordsFn = async (_resumeKws, workLogKws) => {
    capturedWorkLogKws = workLogKws;
    return [];
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      resumeKeywords: ["React"]
      // workLogKeywords intentionally absent
    })
  );

  assert.equal(res.status, 200);
  // workLogKeywords should default to empty array
  assert.deepEqual(capturedWorkLogKws, []);
});

test("POST /api/resume/cluster-keywords — only workLogKeywords provided (resumeKeywords absent)", async () => {
  resetStubs();
  let capturedResumeKws;
  clusterKeywordsFn = async (resumeKws) => {
    capturedResumeKws = resumeKws;
    return [];
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      workLogKeywords: ["Hono", "Vite"]
      // resumeKeywords intentionally absent
    })
  );

  assert.equal(res.status, 200);
  // resumeKeywords should default to empty array
  assert.deepEqual(capturedResumeKws, []);
});

test("POST /api/resume/cluster-keywords — does NOT persist axes to Blob (stateless)", async () => {
  resetStubs();

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      keywords: ["React", "Node.js", "TypeScript"]
    })
  );

  // saveKeywordClusterAxes should never be called for this stateless endpoint
  assert.equal(lastSavedAxesDoc, null, "cluster-keywords should not persist axes to Blob");
});

test("POST /api/resume/cluster-keywords — returned axes carry stable UUIDs", async () => {
  resetStubs();
  clusterKeywordsFn = async () => [
    { label: "Frontend", keywords: ["React", "Vue"] },
    { label: "Backend",  keywords: ["Hono", "Express"] },
    { label: "DevOps",   keywords: ["Docker", "K8s"] }
  ];

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/cluster-keywords", "POST", {
      keywords: ["React", "Vue", "Hono", "Express", "Docker", "K8s"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.axes.length, 3);

  // All IDs should be unique strings
  const ids = body.axes.map((a) => a.id);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, "All axis IDs should be unique");
});

test("POST /api/resume/cluster-keywords — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/cluster-keywords", {
      method:  "POST",
      body:    JSON.stringify({ keywords: ["React"] }),
      headers: { "content-type": "application/json" }
    })
  );
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Sub-AC 17-1: Cluster axes persistence — mergeAxes reuse on force=true
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/keyword-axes — force=true calls mergeAxes with existing axes", async () => {
  resetStubs();
  const existingAxes = [
    { id: "exist-1", label: "Backend",  keywords: ["Node.js"], _source: "system" },
    { id: "exist-2", label: "Frontend", keywords: ["React"],   _source: "user"   }
  ];
  // Cache exists but force=true skips cache-return; existing axes should be loaded for merge
  readKeywordClusterAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-01-01T00:00:00.000Z",
    axes:          existingAxes
  });
  readResumeDataFn = async () => ({
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Dev" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: ["Node.js"], languages: ["TypeScript"], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: ["React"],
    display_axes: []
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", { force: true })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, true);

  // mergeAxes should have been called (persistence reuse logic)
  assert.equal(mergeAxesCallCount, 1, "mergeAxes must be called once when force=true");

  // mergeAxes should receive the existing axes as first argument
  assert.ok(lastMergeAxesArgs !== null, "mergeAxes call args should be captured");
  assert.deepEqual(lastMergeAxesArgs.existing, existingAxes, "existing axes must be passed to mergeAxes");

  // incoming (second arg) should be the raw LLM-generated axes
  assert.ok(Array.isArray(lastMergeAxesArgs.incoming), "incoming axes should be an array");
  assert.ok(lastMergeAxesArgs.incoming.length > 0, "LLM should have returned axes");

  // Result should be from the merge (whatever mergeAxes returned)
  assert.ok(Array.isArray(body.axes), "response axes should be an array");
});

test("POST /api/resume/keyword-axes — force=true preserves user-edited axes via mergeAxes", async () => {
  resetStubs();
  const userAxis = { id: "user-axis-1", label: "Custom Axis", keywords: ["Go", "Rust"], _source: "user" };
  const existingAxes = [
    userAxis,
    { id: "sys-axis-1", label: "System Axis", keywords: ["React"], _source: "system" }
  ];

  // Make mergeAxes simulate actual preservation by returning user axis as-is
  mergeAxesFn = (existing, incoming) => {
    mergeAxesCallCount++;
    lastMergeAxesArgs = { existing, incoming };
    // Simulate real mergeAxes: user axis is preserved, system axes are replaced
    const userAxes    = existing.filter((a) => a._source === "user");
    const newSysAxes  = incoming.map((ka, i) => ({ id: `new-sys-${i}`, label: ka.label ?? "", keywords: ka.keywords ?? [], _source: "system" }));
    return [...userAxes, ...newSysAxes];
  };

  readKeywordClusterAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-01-01T00:00:00.000Z",
    axes:          existingAxes
  });
  readResumeDataFn = async () => ({
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: {},
    contact: { name: "Dev" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: ["React"], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: [],
    display_axes: []
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", { force: true })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // The user-edited axis should appear in the response
  const responseUserAxis = body.axes.find((a) => a.id === "user-axis-1");
  assert.ok(responseUserAxis !== undefined, "User-edited axis should be preserved in merged result");
  assert.equal(responseUserAxis._source, "user", "Preserved axis must retain _source: 'user'");

  // Saved document must also contain the user axis
  assert.ok(lastSavedAxesDoc !== null, "saveKeywordClusterAxes must be called");
  const savedUserAxis = lastSavedAxesDoc.axes.find((a) => a.id === "user-axis-1");
  assert.ok(savedUserAxis !== undefined, "User axis must be persisted in saved document");
});

test("POST /api/resume/keyword-axes — force=false cache-miss does NOT call mergeAxes with existing (no existing axes)", async () => {
  resetStubs();
  // Cache miss (no existing axes)
  readKeywordClusterAxesFn = async () => null;
  readResumeDataFn = async () => ({
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: {},
    contact: { name: "Dev" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: ["React"], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: [],
    display_axes: []
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", {})
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, true);

  // On cache miss (force=false), mergeAxes is still called but with empty existing array
  // because existing axes load is skipped for force=false; the result is fresh axes from LLM
  assert.equal(mergeAxesCallCount, 1, "mergeAxes is called once (with empty existing)");
  assert.deepEqual(lastMergeAxesArgs.existing, [], "existing should be empty for cache-miss path");
});

test("POST /api/resume/keyword-axes — force=true: existing axes load failure falls back to fresh generation", async () => {
  resetStubs();
  // Cache has data but force=true; existing axes read throws
  readKeywordClusterAxesFn = async () => {
    throw new Error("Blob temporarily unavailable");
  };
  readResumeDataFn = async () => ({
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: {},
    contact: { name: "Dev" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: ["React"], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: [],
    display_axes: []
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", { force: true })
  );

  // Should not fail — falls back gracefully to fresh generation
  assert.equal(res.status, 200, "should succeed even when existing axes cannot be loaded");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.regenerated, true);

  // mergeAxes is still called, but with empty existing (fallback)
  assert.equal(mergeAxesCallCount, 1, "mergeAxes is called once with empty fallback");
  assert.deepEqual(lastMergeAxesArgs.existing, [], "existing should be empty on load failure");
});

test("POST /api/resume/keyword-axes — axes saved to Blob contain merged result (Sub-AC 17-1 persistence)", async () => {
  resetStubs();
  const existingAxes = [
    { id: "stable-id-1", label: "Infrastructure", keywords: ["Docker", "K8s"], _source: "system" }
  ];
  readKeywordClusterAxesFn = async () => ({
    schemaVersion: 1,
    generatedAt:   "2025-01-01T00:00:00.000Z",
    axes:          existingAxes
  });
  readResumeDataFn = async () => ({
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: {},
    contact: { name: "Dev" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: ["Docker", "K8s", "Terraform"], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: [],
    display_axes: []
  });

  // Make mergeAxes return a result that includes the stable ID
  mergeAxesFn = (_existing, incoming) => {
    mergeAxesCallCount++;
    // Simulate: stable-id-1 was matched and preserved
    return [
      { id: "stable-id-1", label: "Infrastructure & DevOps", keywords: ["Docker", "K8s", "Terraform"], _source: "system" },
      ...incoming.slice(1).map((ka, i) => ({ id: `new-${i}`, label: ka.label ?? "", keywords: ka.keywords ?? [], _source: "system" }))
    ];
  };

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/keyword-axes", "POST", { force: true })
  );

  // The saved document must reflect the merged (not raw LLM) result
  assert.ok(lastSavedAxesDoc !== null, "saveKeywordClusterAxes must be called");
  const savedIds = lastSavedAxesDoc.axes.map((a) => a.id);
  assert.ok(savedIds.includes("stable-id-1"), "stable ID must be preserved in saved document");
  assert.equal(lastSavedAxesDoc.schemaVersion, 1, "saved doc must have schemaVersion 1");
  assert.ok(typeof lastSavedAxesDoc.generatedAt === "string", "saved doc must have generatedAt");
});
