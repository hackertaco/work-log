/**
 * Tests for POST /api/resume/rollback (Sub-AC 20-3).
 *
 * Verifies the rollback pipeline:
 *   1. Validates snapshotKey (non-empty, scoped to SNAPSHOTS_PREFIX, ends in .json)
 *   2. Fetches target snapshot envelope via readSnapshotByKey
 *   3. Extracts resume document from envelope
 *   4. Saves pre-rollback safety snapshot of current state (best-effort)
 *   5. Overwrites resume/data.json with the restored document
 *   6. Saves the restored result as a new snapshot with trigger='rollback' (best-effort)
 *   7. Returns { ok, restoredFrom, preRollbackSnapshotKey, rollbackSnapshotKey, resume }
 *
 * Key invariants tested:
 *   1. Happy path: restores resume, pre-rollback + rollback snapshots both saved
 *   2. rollbackSnapshotKey is present in response with trigger='rollback'
 *   3. Pre-rollback snapshot failure is non-fatal (ok:true, preRollbackSnapshotKey:null)
 *   4. Post-rollback snapshot failure is non-fatal (ok:true, rollbackSnapshotKey:null)
 *   5. No pre-rollback backup when current resume is null (continues to restore)
 *   6. HTTP 400 when snapshotKey is missing
 *   7. HTTP 400 when snapshotKey is not a string
 *   8. HTTP 400 when snapshotKey is outside SNAPSHOTS_PREFIX namespace
 *   9. HTTP 400 when snapshotKey does not end in .json
 *  10. HTTP 400 when request body is not valid JSON
 *  11. HTTP 404 when target snapshot not found (readSnapshotByKey returns null)
 *  12. HTTP 422 when snapshot envelope has no `resume` field
 *  13. HTTP 502 when readSnapshotByKey throws
 *  14. HTTP 502 when saveResumeData throws
 *  15. HTTP 401 without valid authentication cookie
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.rollback.test.mjs
 *
 * All heavy I/O dependencies are stubbed via Node.js module mocks.
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ────────────────────────────────────────────────────────

let readResumeDataFn    = async () => null;
let saveResumeDataFn    = async () => ({ url: "https://blob/resume/data.json" });
let readSnapshotByKeyFn = async () => null;

// saveSnapshot is called twice during a happy-path rollback:
//   1. Pre-rollback safety backup of current resume
//   2. Post-rollback snapshot of the restored resume
// We track calls in order so tests can assert call-specific arguments.
let saveSnapshotCalls = [];
let saveSnapshotFn    = async (resumeDoc, meta = {}) => {
  const key = `resume/snapshots/test-${saveSnapshotCalls.length + 1}.json`;
  saveSnapshotCalls.push({ resumeDoc, meta, returnKey: key });
  return { snapshotKey: key, url: `https://blob/${key}` };
};

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
    saveSnapshot:                 (...args) => saveSnapshotFn(...args),
    listSnapshots:                async () => [],
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
    saveSession:                   async () => ({ url: "blob://session" }),
    readSession:                   async () => null,
    deleteSession:                 async () => {},
  }
});

mock.module("../lib/config.mjs", {
  namedExports: {
    loadConfig: async () => ({ dataDir: "/tmp/work-log-test" })
  }
});

mock.module("../lib/resumeReconstruction.mjs", {
  namedExports: {
    gatherWorkLogBullets:         async () => [],
    fullReconstructExtractCache:  async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] }),
    generateSectionBridges:       async () => [],
    validateResumeCoherence:      async () => ({ overallScore: 1, grade: "A", structuralFlow: 1, redundancy: 1, tonalConsistency: 1, issues: [], autoFixes: [] }),
    runNarrativeThreadingPipeline: async () => ({ strengths: [], axes: [], sectionBridges: [], extractionResults: [], threading: { totalAnnotations: 0, groundedRatio: 0, strengthCoverage: {}, axisCoverage: {} }, groundingReport: {} }),
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
    diffToSuggestions:             () => [],
    deduplicateWorkLogSuggestions: (_e, n) => n
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
    mergeAxes:                   (_existing, incoming) => (Array.isArray(incoming) ? incoming : []).map((ka, i) => ({
      id: `merged-${i}`, label: ka.label ?? "", keywords: Array.isArray(ka.keywords) ? ka.keywords : [], _source: "system"
    }))
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

mock.module("../lib/resumeBulletProposal.mjs", {
  namedExports: {
    applyBulletProposal: (resume) => resume,
    isBulletProposal:    () => false
  }
});

mock.module("../lib/resumeStrengthKeywords.mjs", {
  namedExports: {
    mergeKeywords:                    (doc, _kws) => doc,
    removeKeyword:                    (doc, _kw) => doc,
    replaceKeywords:                  (_doc, kws) => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "user", keywords: kws }),
    extractKeywordsArray:             () => [],
    initStrengthKeywordsFromBootstrap: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "bootstrap", keywords: [] })
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

/**
 * Build an authenticated POST request.
 */
function authedPost(url, body = null) {
  const headers = new Headers({ cookie: "resume_token=test-secret" });
  if (body !== null) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: body !== null ? JSON.stringify(body) : undefined
  });
}

/**
 * Build an unauthenticated POST request.
 */
function unauthedPost(url, body = null) {
  const headers = new Headers();
  if (body !== null) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: body !== null ? JSON.stringify(body) : undefined
  });
}

/**
 * Minimal stored resume fixture.
 */
function makeResume(overrides = {}) {
  return {
    meta: {
      language: "ko",
      source: "pdf",
      generatedAt: "2025-01-01T00:00:00.000Z",
      schemaVersion: 1,
      pdf_name: "resume.pdf",
      linkedin_url: null
    },
    _sources: { summary: "user", contact: "user", skills: "system" },
    contact: { name: "Kim Test", email: "test@example.com", phone: null, location: "Seoul", website: null, linkedin: null },
    summary: "A seasoned developer.",
    experience: [
      {
        _source: "user",
        company: "Example Corp",
        title: "Senior Engineer",
        start_date: "2022-01",
        end_date: null,
        location: null,
        bullets: ["Led platform migration", "Improved deployment speed by 40%"]
      }
    ],
    education: [],
    skills: { technical: ["TypeScript", "Node.js"], languages: [], tools: [] },
    projects: [],
    certifications: [],
    ...overrides
  };
}

/**
 * Build a valid snapshot envelope containing the given resume.
 */
function makeSnapshotEnvelope(resume, meta = {}) {
  return {
    schemaVersion: 1,
    snapshotKey: meta.snapshotKey ?? "resume/snapshots/2025-01-01T00-00-00.000Z.json",
    snapshotAt: meta.snapshotAt ?? "2025-01-01T00:00:00.000Z",
    label: meta.label ?? "pre-approve",
    triggeredBy: meta.triggeredBy ?? "approve",
    resume
  };
}

/** Reset per-test mutable state. */
function resetStubs() {
  readResumeDataFn    = async () => makeResume();
  saveResumeDataFn    = async () => ({ url: "https://blob/resume/data.json" });
  readSnapshotByKeyFn = async () => null;
  saveSnapshotCalls   = [];
  saveSnapshotFn      = async (resumeDoc, meta = {}) => {
    const key = `resume/snapshots/test-${saveSnapshotCalls.length + 1}.json`;
    saveSnapshotCalls.push({ resumeDoc, meta, returnKey: key });
    return { snapshotKey: key, url: `https://blob/${key}` };
  };
}

const VALID_KEY = "resume/snapshots/2025-01-01T00-00-00.000Z.json";
const ROLLBACK_URL = "http://localhost/api/resume/rollback";

// ─── Tests ────────────────────────────────────────────────────────────────────

test("POST /api/resume/rollback — 401 without authentication cookie", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(unauthedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  assert.equal(res.status, 401);
});

test("POST /api/resume/rollback — 400 when snapshotKey is missing from body", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(authedPost(ROLLBACK_URL, {}));

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error field must be present");
});

test("POST /api/resume/rollback — 400 when snapshotKey is empty string", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: "  " }));

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/rollback — 400 when request body is not valid JSON", async () => {
  resetStubs();
  const app = buildApp();
  const req = new Request(ROLLBACK_URL, {
    method: "POST",
    headers: {
      cookie: "resume_token=test-secret",
      "content-type": "application/json"
    },
    body: "not-json-at-all"
  });

  const res = await app.fetch(req);

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/rollback — 400 when snapshotKey does not start with SNAPSHOTS_PREFIX", async () => {
  resetStubs();
  const app = buildApp();
  // Try to point rollback at the live resume document — must be rejected.
  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: "resume/data.json" }));

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error.includes("resume/snapshots/"), "error should mention the required prefix");
});

test("POST /api/resume/rollback — 400 when snapshotKey does not end in .json", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(
    authedPost(ROLLBACK_URL, { snapshotKey: "resume/snapshots/2025-01-01T00-00-00.000Z.pdf" })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/rollback — 404 when target snapshot not found", async () => {
  resetStubs();
  readSnapshotByKeyFn = async () => null; // snapshot missing
  const app = buildApp();

  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error.includes(VALID_KEY), "error should mention the missing key");
});

test("POST /api/resume/rollback — 422 when snapshot envelope has no resume field", async () => {
  resetStubs();
  readSnapshotByKeyFn = async () => ({
    schemaVersion: 1,
    snapshotKey: VALID_KEY,
    snapshotAt: "2025-01-01T00:00:00.000Z",
    label: "pre-approve",
    triggeredBy: "approve"
    // No `resume` field
  });
  const app = buildApp();

  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/rollback — 422 when snapshot.resume is not an object", async () => {
  resetStubs();
  readSnapshotByKeyFn = async () => ({
    schemaVersion: 1,
    snapshotKey: VALID_KEY,
    snapshotAt: "2025-01-01T00:00:00.000Z",
    label: "pre-approve",
    triggeredBy: "approve",
    resume: "not-an-object"
  });
  const app = buildApp();

  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/rollback — 502 when readSnapshotByKey throws", async () => {
  resetStubs();
  readSnapshotByKeyFn = async () => { throw new Error("Blob I/O error"); };
  const app = buildApp();

  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error field must be present");
});

test("POST /api/resume/rollback — 502 when saveResumeData throws", async () => {
  resetStubs();
  const targetResume = makeResume({ summary: "Older version" });
  readSnapshotByKeyFn = async () => makeSnapshotEnvelope(targetResume);
  saveResumeDataFn    = async () => { throw new Error("Blob write failure"); };
  const app = buildApp();

  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/rollback — happy path: restores resume and creates both snapshots", async () => {
  resetStubs();

  const currentResume = makeResume({ summary: "Current version" });
  const targetResume  = makeResume({ summary: "Older target version" });
  const snapshotKey   = "resume/snapshots/2025-01-01T00-00-00.000Z.json";

  readResumeDataFn    = async () => currentResume;
  readSnapshotByKeyFn = async () => makeSnapshotEnvelope(targetResume, { snapshotKey });

  let saveResumeDataCalledWith = null;
  saveResumeDataFn = async (doc) => {
    saveResumeDataCalledWith = doc;
    return { url: "https://blob/resume/data.json" };
  };

  const app = buildApp();
  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // ── Response fields ─────────────────────────────────────────────────────────
  assert.equal(body.restoredFrom, snapshotKey, "restoredFrom must match requested snapshotKey");
  assert.ok(body.preRollbackSnapshotKey, "preRollbackSnapshotKey must be present");
  assert.ok(body.rollbackSnapshotKey, "rollbackSnapshotKey must be present for trigger=rollback");
  assert.deepEqual(body.resume, targetResume, "response must contain the restored resume");

  // ── saveResumeData called with restored doc ────────────────────────────────
  assert.deepEqual(
    saveResumeDataCalledWith,
    targetResume,
    "saveResumeData must be called with the restored (target) resume"
  );

  // ── Two saveSnapshot calls ─────────────────────────────────────────────────
  assert.equal(saveSnapshotCalls.length, 2, "saveSnapshot must be called exactly twice");

  // First call: pre-rollback safety backup of the CURRENT state
  const preRollbackCall = saveSnapshotCalls[0];
  assert.deepEqual(
    preRollbackCall.resumeDoc,
    currentResume,
    "first saveSnapshot call must use the current (pre-rollback) resume"
  );
  assert.equal(preRollbackCall.meta.label, "pre-rollback");
  assert.equal(preRollbackCall.meta.triggeredBy, "rollback");

  // Second call: post-rollback snapshot of the RESTORED state
  const postRollbackCall = saveSnapshotCalls[1];
  assert.deepEqual(
    postRollbackCall.resumeDoc,
    targetResume,
    "second saveSnapshot call must use the restored (target) resume"
  );
  assert.equal(postRollbackCall.meta.label, "rollback");
  assert.equal(postRollbackCall.meta.triggeredBy, "rollback");
});

test("POST /api/resume/rollback — pre-rollback snapshot failure is non-fatal", async () => {
  resetStubs();

  const targetResume = makeResume({ summary: "Target version" });
  readSnapshotByKeyFn = async () => makeSnapshotEnvelope(targetResume);
  readResumeDataFn    = async () => makeResume({ summary: "Current version" });

  let snapshotCallCount = 0;
  saveSnapshotFn = async (resumeDoc, meta = {}) => {
    snapshotCallCount++;
    if (snapshotCallCount === 1) {
      // First call = pre-rollback backup; simulate failure
      throw new Error("Pre-rollback backup Blob error");
    }
    // Second call = post-rollback snapshot; succeeds
    const key = "resume/snapshots/post-rollback.json";
    saveSnapshotCalls.push({ resumeDoc, meta, returnKey: key });
    return { snapshotKey: key, url: `https://blob/${key}` };
  };

  const app = buildApp();
  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  // Should still succeed — pre-rollback backup is best-effort
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.preRollbackSnapshotKey, null, "preRollbackSnapshotKey must be null when backup fails");
  assert.ok(body.rollbackSnapshotKey, "rollbackSnapshotKey must still be present");
  assert.deepEqual(body.resume, targetResume);
});

test("POST /api/resume/rollback — post-rollback snapshot failure is non-fatal", async () => {
  resetStubs();

  const targetResume = makeResume({ summary: "Target" });
  readSnapshotByKeyFn = async () => makeSnapshotEnvelope(targetResume);
  readResumeDataFn    = async () => makeResume({ summary: "Current" });

  let snapshotCallCount = 0;
  saveSnapshotFn = async (resumeDoc, meta = {}) => {
    snapshotCallCount++;
    if (snapshotCallCount === 1) {
      // First call = pre-rollback; succeeds
      const key = "resume/snapshots/pre-rollback.json";
      saveSnapshotCalls.push({ resumeDoc, meta, returnKey: key });
      return { snapshotKey: key, url: `https://blob/${key}` };
    }
    // Second call = post-rollback; simulate failure
    throw new Error("Post-rollback snapshot Blob error");
  };

  const app = buildApp();
  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  // Should still succeed — post-rollback snapshot is best-effort
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.preRollbackSnapshotKey, "preRollbackSnapshotKey must be present");
  assert.equal(body.rollbackSnapshotKey, null, "rollbackSnapshotKey must be null when snapshot fails");
  assert.deepEqual(body.resume, targetResume);
});

test("POST /api/resume/rollback — no pre-rollback backup when current resume is null", async () => {
  resetStubs();

  const targetResume = makeResume({ summary: "Target" });
  readSnapshotByKeyFn = async () => makeSnapshotEnvelope(targetResume);
  readResumeDataFn    = async () => null; // No current resume

  const app = buildApp();
  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey: VALID_KEY }));

  // Should still succeed — pre-rollback snapshot is only created when there is a current resume
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.preRollbackSnapshotKey, null, "no pre-rollback snapshot when resume was empty");
  assert.ok(body.rollbackSnapshotKey, "rollbackSnapshotKey must be present for restored result");
  assert.deepEqual(body.resume, targetResume);

  // Only the post-rollback snapshot should have been saved (pre-rollback skipped)
  assert.equal(saveSnapshotCalls.length, 1, "saveSnapshot called once (post-rollback only)");
  assert.equal(saveSnapshotCalls[0].meta.triggeredBy, "rollback");
  assert.equal(saveSnapshotCalls[0].meta.label, "rollback");
});

test("POST /api/resume/rollback — response contains restoredFrom echoing requested key", async () => {
  resetStubs();

  const snapshotKey  = "resume/snapshots/2025-06-15T10-30-00.000Z.json";
  const targetResume = makeResume();
  readSnapshotByKeyFn = async (key) => {
    assert.equal(key, snapshotKey, "readSnapshotByKey must be called with the requested key");
    return makeSnapshotEnvelope(targetResume, { snapshotKey });
  };

  const app = buildApp();
  const res = await app.fetch(authedPost(ROLLBACK_URL, { snapshotKey }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.restoredFrom, snapshotKey);
});
