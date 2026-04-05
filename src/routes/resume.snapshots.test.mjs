/**
 * Tests for GET /api/resume/snapshots endpoint.
 *
 * Verifies Sub-AC 20-2: Blob 목록을 조회하여 키, 타임스탬프, trigger 메타데이터를
 * 배열로 반환하는 GET /api/resume/snapshots 엔드포인트.
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.snapshots.test.mjs
 *
 * Strategy
 * --------
 * The snapshot route calls listSnapshots() for the Blob-level index and then
 * parallel-fetches each envelope via readSnapshotByKey() for trigger metadata.
 * Both are stubbed via Node.js built-in module mocks so tests run fully offline.
 *
 * Mutable stub functions (listSnapshotsFn / readSnapshotByKeyFn) let each test
 * override the blob layer without re-registering mocks.
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stubs ───────────────────────────────────────────────────────────

let listSnapshotsFn     = async () => [];
let readSnapshotByKeyFn = async () => null;

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: false }),
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
    listSnapshots:                (...args) => listSnapshotsFn(...args),
    readSnapshotByKey:            (...args) => readSnapshotByKeyFn(...args),
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
  namedExports: {
    diffToSuggestions:                () => [],
    deduplicateWorkLogSuggestions:    (s) => s
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

mock.module("../lib/resumeStrengthKeywords.mjs", {
  namedExports: {
    mergeKeywords:                     (doc) => doc,
    removeKeyword:                     (doc) => doc,
    replaceKeywords:                   (doc) => doc,
    extractKeywordsArray:              (doc) => (doc?.keywords ?? []),
    initStrengthKeywordsFromBootstrap: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "bootstrap", keywords: [] })
  }
});

// ─── Load router under test AFTER mocks are registered ───────────────────────

const { resumeRouter } = await import("./resume.mjs");
const { cookieAuth }   = await import("../middleware/auth.mjs");

// ─── Test app builder ─────────────────────────────────────────────────────────

/**
 * Build a minimal Hono app that mirrors the production setup in server.mjs.
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

// ─── Sample fixture data ──────────────────────────────────────────────────────

const SNAPSHOT_KEY_1 = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
const SNAPSHOT_KEY_2 = "resume/snapshots/2026-03-26T08-30-00.000Z.json";

const BLOB_ENTRY_1 = {
  snapshotKey: SNAPSHOT_KEY_1,
  url:         "https://blob.example.com/" + SNAPSHOT_KEY_1,
  uploadedAt:  "2026-03-27T12:00:00.000Z",
  size:        5120
};

const BLOB_ENTRY_2 = {
  snapshotKey: SNAPSHOT_KEY_2,
  url:         "https://blob.example.com/" + SNAPSHOT_KEY_2,
  uploadedAt:  "2026-03-26T08:30:00.000Z",
  size:        4800
};

const ENVELOPE_1 = {
  schemaVersion: 1,
  snapshotKey:   SNAPSHOT_KEY_1,
  snapshotAt:    "2026-03-27T12:00:00.000Z",
  label:         "pre-approve",
  triggeredBy:   "approve",
  resume:        { contact: { name: "Alice" }, meta: { schemaVersion: 1 } }
};

const ENVELOPE_2 = {
  schemaVersion: 1,
  snapshotKey:   SNAPSHOT_KEY_2,
  snapshotAt:    "2026-03-26T08:30:00.000Z",
  label:         "pre-approve",
  triggeredBy:   "candidates-patch",
  resume:        { contact: { name: "Alice" }, meta: { schemaVersion: 1 } }
};

// ─── GET /api/resume/snapshots — Happy paths ─────────────────────────────────

test("GET /api/resume/snapshots - returns empty array when no snapshots exist", async () => {
  listSnapshotsFn     = async () => [];
  readSnapshotByKeyFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/snapshots"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true,  "ok must be true");
  assert.deepEqual(body.snapshots, [], "snapshots must be empty array");
});

test("GET /api/resume/snapshots - returns single snapshot enriched with trigger metadata", async () => {
  listSnapshotsFn     = async () => [BLOB_ENTRY_1];
  readSnapshotByKeyFn = async (key) => {
    assert.equal(key, SNAPSHOT_KEY_1, "readSnapshotByKey must be called with correct key");
    return ENVELOPE_1;
  };

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/snapshots"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.snapshots.length, 1);

  const s = body.snapshots[0];
  assert.equal(s.snapshotKey,  SNAPSHOT_KEY_1,               "snapshotKey must match Blob entry");
  assert.equal(s.url,          BLOB_ENTRY_1.url,             "url must come from Blob entry");
  assert.equal(s.uploadedAt,   "2026-03-27T12:00:00.000Z",  "uploadedAt must come from Blob entry");
  assert.equal(s.size,         5120,                         "size must come from Blob entry");
  assert.equal(s.snapshotAt,   "2026-03-27T12:00:00.000Z",  "snapshotAt must come from envelope");
  assert.equal(s.label,        "pre-approve",                "label must come from envelope");
  assert.equal(s.triggeredBy,  "approve",                    "triggeredBy must come from envelope");
});

test("GET /api/resume/snapshots - returns multiple snapshots with correct trigger metadata each", async () => {
  listSnapshotsFn     = async () => [BLOB_ENTRY_1, BLOB_ENTRY_2];
  readSnapshotByKeyFn = async (key) => {
    if (key === SNAPSHOT_KEY_1) return ENVELOPE_1;
    if (key === SNAPSHOT_KEY_2) return ENVELOPE_2;
    return null;
  };

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/snapshots"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.snapshots.length, 2);

  const s1 = body.snapshots.find((s) => s.snapshotKey === SNAPSHOT_KEY_1);
  const s2 = body.snapshots.find((s) => s.snapshotKey === SNAPSHOT_KEY_2);

  assert.ok(s1, "snapshot 1 must be present");
  assert.equal(s1.triggeredBy, "approve",           "snapshot 1 triggeredBy");
  assert.equal(s1.label,       "pre-approve",       "snapshot 1 label");
  assert.equal(s1.snapshotAt,  "2026-03-27T12:00:00.000Z");

  assert.ok(s2, "snapshot 2 must be present");
  assert.equal(s2.triggeredBy, "candidates-patch",  "snapshot 2 triggeredBy");
  assert.equal(s2.label,       "pre-approve",       "snapshot 2 label");
  assert.equal(s2.snapshotAt,  "2026-03-26T08:30:00.000Z");
});

// ─── GET /api/resume/snapshots — Per-item fetch failure (graceful degradation) ──

test("GET /api/resume/snapshots - yields null trigger metadata when envelope fetch throws", async () => {
  listSnapshotsFn     = async () => [BLOB_ENTRY_1];
  readSnapshotByKeyFn = async () => {
    throw new Error("network error reading envelope");
  };

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/snapshots"));

  // Request must still succeed — partial failure is non-fatal
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.snapshots.length, 1);

  const s = body.snapshots[0];
  assert.equal(s.snapshotKey, SNAPSHOT_KEY_1, "snapshotKey must be preserved");
  assert.equal(s.uploadedAt,  BLOB_ENTRY_1.uploadedAt);
  assert.equal(s.size,        BLOB_ENTRY_1.size);
  assert.equal(s.snapshotAt,  null, "snapshotAt must be null on fetch failure");
  assert.equal(s.label,       null, "label must be null on fetch failure");
  assert.equal(s.triggeredBy, null, "triggeredBy must be null on fetch failure");
});

test("GET /api/resume/snapshots - yields null metadata when envelope has no relevant fields", async () => {
  listSnapshotsFn     = async () => [BLOB_ENTRY_1];
  // Envelope missing label/triggeredBy/snapshotAt (e.g. older schema)
  readSnapshotByKeyFn = async () => ({ schemaVersion: 1, resume: {} });

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/snapshots"));

  assert.equal(res.status, 200);
  const body = await res.json();
  const s = body.snapshots[0];
  assert.equal(s.snapshotAt,  null);
  assert.equal(s.label,       null);
  assert.equal(s.triggeredBy, null);
});

test("GET /api/resume/snapshots - mixed: one envelope ok, one fails — both returned", async () => {
  listSnapshotsFn = async () => [BLOB_ENTRY_1, BLOB_ENTRY_2];
  readSnapshotByKeyFn = async (key) => {
    if (key === SNAPSHOT_KEY_1) return ENVELOPE_1;
    throw new Error("fetch failed for snapshot 2");
  };

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/snapshots"));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.snapshots.length, 2);

  const s1 = body.snapshots.find((s) => s.snapshotKey === SNAPSHOT_KEY_1);
  const s2 = body.snapshots.find((s) => s.snapshotKey === SNAPSHOT_KEY_2);

  assert.equal(s1.triggeredBy, "approve",        "good envelope: triggeredBy present");
  assert.equal(s1.label,       "pre-approve",    "good envelope: label present");
  assert.equal(s2.triggeredBy, null,             "failed envelope: triggeredBy null");
  assert.equal(s2.label,       null,             "failed envelope: label null");
  assert.equal(s2.snapshotAt,  null,             "failed envelope: snapshotAt null");
  // Blob-level fields still present for failed entry
  assert.equal(s2.uploadedAt, BLOB_ENTRY_2.uploadedAt);
  assert.equal(s2.size,       BLOB_ENTRY_2.size);
});

// ─── GET /api/resume/snapshots — Blob list failure ───────────────────────────

test("GET /api/resume/snapshots - returns 502 when listSnapshots throws", async () => {
  listSnapshotsFn     = async () => { throw new Error("Blob storage unavailable"); };
  readSnapshotByKeyFn = async () => null;

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/snapshots"));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok,    false, "ok must be false on 502");
  assert.ok(body.error,          "error field must be present");
  assert.ok(body.detail,         "detail field must be present");
  assert.match(body.detail, /Blob storage unavailable/, "detail must contain original error message");
});

// ─── GET /api/resume/snapshots — Authentication guard ────────────────────────

test("GET /api/resume/snapshots - returns 401 when no auth cookie is provided", async () => {
  listSnapshotsFn     = async () => [];
  readSnapshotByKeyFn = async () => null;

  const app = buildApp("test-secret");
  const res = await app.fetch(new Request("http://localhost/api/resume/snapshots"));

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "Unauthorized");
});

test("GET /api/resume/snapshots - returns 401 when wrong auth token is provided", async () => {
  listSnapshotsFn     = async () => [];
  readSnapshotByKeyFn = async () => null;

  const app = buildApp("correct-secret");
  const headers = new Headers();
  headers.set("cookie", "resume_token=wrong-secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/snapshots", { headers })
  );

  assert.equal(res.status, 401);
});
