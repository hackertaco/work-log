/**
 * Tests for Sub-AC 24b: indirect causality (profileDelta → mergeCandidates)
 * and displayAxes→resume content boundary verification.
 *
 * Covers two related concerns:
 *
 *   1. POST /api/resume/profile-delta-trigger — indirect causality gate
 *      The endpoint computes profileDelta (current resume vs last approved
 *      snapshot).  Candidate generation fires only when delta.rate ≥ 3 %.
 *      displayAxes changes DO NOT directly trigger candidates — they only
 *      accumulate in the profileDelta and are mediated by this endpoint.
 *
 *      Verified behaviours:
 *        • 400 when date is missing or malformed
 *        • 404 when no resume is bootstrapped
 *        • 502 when Blob or delta computation fails
 *        • triggered=false when no snapshot exists (no baseline)
 *        • triggered=false when delta.rate < DELTA_THRESHOLD (3 %)
 *        • triggered=true, generated=0 when delta ≥ threshold but no workLog
 *        • triggered=true, generated=0 when diff is empty after pipeline
 *        • triggered=true, generated=0 when diff produces no actionable suggestions
 *        • triggered=true, generated=N when delta ≥ threshold + workLog + diff
 *        • existing pending candidates are superseded (AC 13 semantics)
 *        • 502 when suggestions save fails
 *
 *   2. displayAxes→resume content boundary (no direct modification path)
 *      Axis operations (PATCH/DELETE/merge/split) update only the
 *      `display_axes` metadata field.  Content sections — experience, skills,
 *      projects, education, summary, certifications — are never touched.
 *
 *      Verified for each axis operation:
 *        • PATCH  /api/resume/axes/:id  — experience unchanged, skills unchanged
 *        • DELETE /api/resume/axes/:id  — experience unchanged, skills unchanged
 *        • POST   /api/resume/axes/merge — experience unchanged, skills unchanged
 *        • POST   /api/resume/axes/:id/split — experience unchanged, skills unchanged
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.profile-delta.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

// blob stubs
let readResumeDataFn      = async () => null;
let readSuggestionsDataFn = async () => _emptySuggestionsDoc();
let saveSuggestionsDataFn = async () => ({ url: "https://blob/resume/suggestions.json" });

/** Tracks calls to saveResumeData for boundary-verification assertions. */
let lastSavedResumeDoc = null;
let saveResumeDataFn   = async (doc) => { lastSavedResumeDoc = doc; return { url: "https://blob/resume/data.json" }; };

/** Tracks what was persisted by saveSuggestionsData. */
let lastSavedSuggestionsDoc = null;

// resumeSnapshotDelta stubs
let deltaFromLastApprovedFn = async () => ({
  snapshot: null,
  delta: { rate: 0, changedUnits: 0, totalUnits: 0, isEmpty: true, breakdown: {} }
});

// Pipeline stubs (extract → merge → diff → suggestions)
let extractResumeUpdatesFn = async () => ({});
let mergeWorkLogFn         = (r) => r;
let diffResumeFn           = () => ({ isEmpty: true });
let diffToSuggestionsFn    = () => [];
let readExtractCacheFn     = async () => null;

// resumeAxes stubs
let updateAxisInArrayFn = (axes, _id, _updates) => ({ axes, updated: null });
let removeAxisFromArrayFn = (axes, id) => {
  const removed = axes.find((a) => a.id === id) ?? null;
  const remaining = axes.filter((a) => a.id !== id);
  return { axes: remaining, removed };
};
let mergeAxesFn = (axes, _targetId, _sourceId, _newLabel) => ({ axes, merged: null, error: null });
let splitAxisFn = (axes, _id, _labelA, _labelB, _kwB) => ({ axes, axisA: null, axisB: null });

// readDisplayAxes / saveDisplayAxes stubs
let readDisplayAxesFn = async () => null;

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: true }),
    readResumeData:               (...args) => readResumeDataFn(...args),
    saveResumeData:               (...args) => saveResumeDataFn(...args),
    readSuggestionsData:          (...args) => readSuggestionsDataFn(...args),
    saveSuggestionsData:          (...args) => {
      lastSavedSuggestionsDoc = args[0];
      return saveSuggestionsDataFn(...args);
    },
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
    readDisplayAxes:              (...args) => readDisplayAxesFn(...args),
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

mock.module("../lib/resumeSnapshotDelta.mjs", {
  namedExports: {
    deltaFromLastApproved:   (...args) => deltaFromLastApprovedFn(...args),
    computeProfileDelta:     () => ({ rate: 0, changedUnits: 0, totalUnits: 0, isEmpty: true, breakdown: {} }),
    getLastApprovedSnapshot: async () => null
  }
});

mock.module("../lib/resumeWorkLogExtract.mjs", {
  namedExports: {
    extractResumeUpdatesFromWorkLog: (...args) => extractResumeUpdatesFn(...args)
  }
});

mock.module("../lib/resumeWorkLogMerge.mjs", {
  namedExports: { mergeWorkLogIntoResume: (...args) => mergeWorkLogFn(...args) }
});

mock.module("../lib/resumeDiff.mjs", {
  namedExports: { diffResume: (...args) => diffResumeFn(...args) }
});

mock.module("../lib/resumeDiffToSuggestions.mjs", {
  namedExports: {
    diffToSuggestions:             (...args) => diffToSuggestionsFn(...args),
    deduplicateWorkLogSuggestions: (_e, n) => n
  }
});

mock.module("../lib/resumeDeltaRatio.mjs", {
  namedExports: {
    computeDeltaRatio:     () => ({ ratio: 0.05, changedCount: 5, totalCount: 100 }),
    exceedsDeltaThreshold: () => false,
    DELTA_THRESHOLD:       0.03
  }
});

mock.module("../lib/bulletCache.mjs", {
  namedExports: {
    readBulletCache:   async () => null,
    writeBulletCache:  async () => {},
    readExtractCache:  (...args) => readExtractCacheFn(...args),
    writeExtractCache: async () => {}
  }
});

mock.module("../lib/resumeLlm.mjs", {
  namedExports: { extractPdfText: async () => "pdf text" }
});

mock.module("../lib/resumeBootstrap.mjs", {
  namedExports: {
    generateResumeFromText: async () => ({
      resumeData:       _storedResume(),
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
    reconstructResumeFromSources: async (opts) => (opts.currentResume ?? {}),
    mergeWithUserEdits:           (r) => r,
    isResumeStale:                () => ({ isStale: false, latestLogDate: null, checkpointDate: null })
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

mock.module("../lib/resumeDailyBulletsService.mjs", {
  namedExports: {
    getOrReconstructDailyBullets: async () => ({ source: "miss", doc: null }),
    BULLET_CACHE_HIT:             "cache_hit",
    BULLET_CACHE_RECONSTRUCTED:   "reconstructed",
    BULLET_CACHE_MISS:            "miss",
    isBulletDocumentValid:        () => false
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
    mergeAxes:                   (_existing, incoming) =>
      (Array.isArray(incoming) ? incoming : []).map((ka, i) => ({
        id: `merged-${i}`, label: ka.label ?? "", keywords: Array.isArray(ka.keywords) ? ka.keywords : [], _source: "system"
      }))
  }
});

mock.module("../lib/resumeKeywordClustering.mjs", {
  namedExports: {
    clusterKeywords:        async () => [],
    collectResumeKeywords:  () => [],
    collectWorkLogKeywords: () => []
  }
});

mock.module("../lib/resumeAxes.mjs", {
  namedExports: {
    createAxis:             (label, kws, src) => ({
      id:       `ax-mock-${label.toLowerCase().replace(/\s+/g, "-")}`,
      label,
      keywords: Array.isArray(kws) ? kws : [],
      _source:  src ?? "system"
    }),
    updateAxisInArray:      (...args) => updateAxisInArrayFn(...args),
    removeAxisFromArray:    (...args) => removeAxisFromArrayFn(...args),
    splitAxis:              (...args) => splitAxisFn(...args),
    mergeAxes:              (...args) => mergeAxesFn(...args),
    migrateAxes:            (axes) => (Array.isArray(axes) ? axes : []),
    moveKeywordBetweenAxes: (axes) => ({ axes, moved: false, keyword: "", fromAxisId: null, toAxisId: "", error: null }),
    AXIS_SCHEMA_VERSION:    "1"
  }
});

mock.module("../lib/resumeStrengthKeywords.mjs", {
  namedExports: {
    mergeKeywords:                    (doc, kws) => ({ ...doc, keywords: [...(doc?.keywords ?? []), ...kws] }),
    removeKeyword:                    (doc, kw)  => ({ ...doc, keywords: (doc?.keywords ?? []).filter((k) => k !== kw) }),
    replaceKeywords:                  (doc, kws) => ({ ...doc, keywords: kws }),
    extractKeywordsArray:             (doc) => doc?.keywords ?? [],
    initStrengthKeywordsFromBootstrap: (kws) => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "bootstrap", keywords: kws ?? [] })
  }
});

mock.module("../lib/resumeBulletProposal.mjs", {
  namedExports: {
    applyBulletProposal: (resume, _suggestion) => resume,
    isBulletProposal:    () => false
  }
});

mock.module("../lib/config.mjs", {
  namedExports: {
    loadConfig: async () => ({ dataDir: "/tmp/work-log-test", openaiApiKey: null })
  }
});

// ─── Load the router AFTER mocks are registered ───────────────────────────────

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

/** Build an authenticated JSON POST request. */
function authedPost(url, body) {
  return authedReq(url, {
    method:  "POST",
    body:    JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

/** Build an authenticated JSON PATCH request. */
function authedPatch(url, body) {
  return authedReq(url, {
    method:  "PATCH",
    body:    JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

/** Build an authenticated DELETE request. */
function authedDelete(url) {
  return authedReq(url, { method: "DELETE" });
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function _emptySuggestionsDoc() {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] };
}

/**
 * A minimal resume with non-trivial content sections.
 * Used to verify that axis operations do not touch experience/skills/projects.
 */
function _storedResume(displayAxes = []) {
  return {
    meta: {
      language:      "en",
      source:        "pdf",
      generatedAt:   "2025-01-01T00:00:00.000Z",
      schemaVersion: 1
    },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact:  { name: "Alice Dev", email: "alice@example.com", phone: null, location: null, website: null, linkedin: null },
    summary:  "A senior full-stack developer with 8 years of experience.",
    experience: [
      {
        _source:    "system",
        company:    "Acme Corp",
        title:      "Senior Engineer",
        start_date: "2020-01",
        end_date:   null,
        location:   null,
        bullets:    ["Built the distributed payment pipeline", "Reduced p99 latency by 40%"]
      }
    ],
    education: [
      { _source: "system", institution: "MIT", degree: "B.Sc.", field: "Computer Science", start_date: "2012", end_date: "2016" }
    ],
    skills: { technical: ["JavaScript", "TypeScript", "Node.js"], languages: ["Korean", "English"], tools: ["Docker", "Kubernetes"] },
    projects: [
      { _source: "system", name: "OpenTracer", bullets: ["Open-source distributed tracing library"] }
    ],
    certifications: [
      { _source: "system", name: "AWS Solutions Architect", issuer: "Amazon", date: "2023-06" }
    ],
    strength_keywords: ["distributed systems", "performance engineering"],
    display_axes: displayAxes
  };
}

/** Minimal display axes fixture. */
function _twoAxes() {
  return [
    { id: "axis-1", label: "Backend Engineering", keywords: ["Node.js", "TypeScript"], _source: "system" },
    { id: "axis-2", label: "Cloud & DevOps",       keywords: ["Docker", "Kubernetes"], _source: "system" }
  ];
}

/** A fake DeltaReport returned by deltaFromLastApproved when delta is above threshold. */
function _highDelta() {
  return {
    rate:         0.12,
    changedUnits: 12,
    totalUnits:   100,
    isEmpty:      false,
    breakdown: {
      contact:         { changed: 0 },
      summary:         { changed: 1 },
      experience:      { changed: 4 },
      education:       { changed: 0 },
      skillsTechnical: { changed: 3 },
      skillsLanguages: { changed: 0 },
      skillsTools:     { changed: 2 },
      projects:        { changed: 1 },
      certifications:  { changed: 0 },
      strengthKeywords:{ changed: 1 },
      displayAxes:     { changed: 0 }
    }
  };
}

/** A fake DeltaReport returned when delta is below threshold (< 3 %). */
function _lowDelta() {
  return {
    rate:         0.01,
    changedUnits: 1,
    totalUnits:   100,
    isEmpty:      false,
    breakdown: {
      contact:         { changed: 0 },
      summary:         { changed: 0 },
      experience:      { changed: 0 },
      education:       { changed: 0 },
      skillsTechnical: { changed: 1 },
      skillsLanguages: { changed: 0 },
      skillsTools:     { changed: 0 },
      projects:        { changed: 0 },
      certifications:  { changed: 0 },
      strengthKeywords:{ changed: 0 },
      displayAxes:     { changed: 0 }
    }
  };
}

/** A fake snapshot envelope returned by deltaFromLastApproved. */
function _snapshotEnvelope() {
  return {
    snapshotKey: "resume/snapshots/2026-01-01T00-00-00.000Z.json",
    label:       "approve",
    triggeredBy: "approve",
    createdAt:   "2026-01-01T00:00:00.000Z",
    resume:      _storedResume()
  };
}

/** A minimal pending SuggestionItem. */
function _pendingSuggestion(id = "s-001") {
  return {
    id,
    type:        "work_log_update",
    section:     "experience",
    action:      "append_bullet",
    description: "Added bullet to experience",
    patch:       { company: "Acme Corp", bullet: "Migrated monolith to microservices" },
    source:      "work_log",
    logDate:     "2026-03-20",
    createdAt:   new Date().toISOString(),
    status:      "pending"
  };
}

// ─── Stub reset ───────────────────────────────────────────────────────────────

function resetStubs() {
  readResumeDataFn      = async () => null;
  readSuggestionsDataFn = async () => _emptySuggestionsDoc();
  saveSuggestionsDataFn = async () => ({ url: "https://blob/resume/suggestions.json" });
  lastSavedResumeDoc    = null;
  saveResumeDataFn      = async (doc) => { lastSavedResumeDoc = doc; return { url: "https://blob/resume/data.json" }; };
  lastSavedSuggestionsDoc = null;

  deltaFromLastApprovedFn = async () => ({
    snapshot: null,
    delta: { rate: 0, changedUnits: 0, totalUnits: 0, isEmpty: true, breakdown: {} }
  });

  extractResumeUpdatesFn = async () => ({});
  mergeWorkLogFn         = (r) => r;
  diffResumeFn           = () => ({ isEmpty: true });
  diffToSuggestionsFn    = () => [];
  readExtractCacheFn     = async () => null;

  updateAxisInArrayFn   = (axes, _id, _updates) => ({ axes, updated: null });
  removeAxisFromArrayFn = (axes, id) => {
    const removed  = axes.find((a) => a.id === id) ?? null;
    const remaining = axes.filter((a) => a.id !== id);
    return { axes: remaining, removed };
  };
  mergeAxesFn = (axes, _targetId, _sourceId, _newLabel) => ({ axes, merged: null, error: null });
  splitAxisFn = (axes, _id, _labelA, _labelB, _kwB) => ({ axes, axisA: null, axisB: null });
  readDisplayAxesFn = async () => null;
}

// ─── POST /api/resume/profile-delta-trigger — indirect causality ──────────────

describe("POST /api/resume/profile-delta-trigger", () => {
  // ── Input validation ─────────────────────────────────────────────────────────

  test("returns 400 when date is missing from body", async () => {
    resetStubs();
    const app = buildApp();
    const res = await app.fetch(authedPost("http://localhost/api/resume/profile-delta-trigger", {}));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(body.error, "error field must be present");
  });

  test("returns 400 when date format is invalid (not YYYY-MM-DD)", async () => {
    resetStubs();
    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", { date: "2026/03/27" })
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  test("returns 401 when not authenticated", async () => {
    resetStubs();
    const app = buildApp("secret");
    const res = await app.fetch(
      new Request("http://localhost/api/resume/profile-delta-trigger", {
        method:  "POST",
        body:    JSON.stringify({ date: "2026-03-27" }),
        headers: { "content-type": "application/json" }
      })
    );
    assert.equal(res.status, 401);
  });

  // ── Resume not found ─────────────────────────────────────────────────────────

  test("returns 404 when no resume is bootstrapped", async () => {
    resetStubs();
    readResumeDataFn = async () => null; // no resume
    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", { date: "2026-03-27" })
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  test("returns 502 when Blob read fails for resume", async () => {
    resetStubs();
    readResumeDataFn = async () => { throw new Error("Blob unavailable"); };
    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", { date: "2026-03-27" })
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  test("returns 502 when deltaFromLastApproved throws", async () => {
    resetStubs();
    readResumeDataFn        = async () => _storedResume();
    deltaFromLastApprovedFn = async () => { throw new Error("Snapshot Blob error"); };
    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", { date: "2026-03-27" })
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  // ── No baseline snapshot ─────────────────────────────────────────────────────

  test("returns triggered=false when no approved snapshot exists (no baseline)", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    // deltaFromLastApproved returns snapshot:null (default)
    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", { date: "2026-03-27" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.triggered, false, "triggered must be false when no snapshot exists");
    assert.equal(body.snapshotKey, null, "snapshotKey must be null");
    assert.equal(body.generated, 0);
  });

  // ── Below threshold ──────────────────────────────────────────────────────────

  test("returns triggered=false when profileDelta < DELTA_THRESHOLD (3%)", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _lowDelta() // rate=0.01 (1%) < 3%
    });
    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", { date: "2026-03-27" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.triggered, false, "triggered must be false when delta below threshold");
    assert.equal(body.generated, 0, "no candidates must be generated");
    assert.ok(body.delta, "delta report must be returned");
    assert.equal(body.delta.rate, 0.01, "delta.rate must reflect the low delta");
  });

  test("delta.rate exactly equal to DELTA_THRESHOLD (3%) triggers candidate generation", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta: {
        rate:         0.03, // exactly at threshold
        changedUnits: 3,
        totalUnits:   100,
        isEmpty:      false,
        breakdown:    {}
      }
    });
    // diff.isEmpty → true, so generated=0 but triggered=true
    diffResumeFn = () => ({ isEmpty: true });

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", {
        date:    "2026-03-27",
        workLog: { candidates: [] }
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.triggered, true, "triggered must be true at exactly threshold");
  });

  // ── Threshold exceeded, no workLog ──────────────────────────────────────────

  test("returns triggered=true, generated=0 when delta >= threshold but no workLog", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _highDelta()
    });
    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", { date: "2026-03-27" })
      // No workLog field
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.triggered, true, "triggered must be true when delta >= threshold");
    assert.equal(body.generated, 0, "no candidates without workLog");
    assert.ok(body.delta, "delta report must be returned");
    assert.ok(body.snapshotKey, "snapshotKey must be returned");
  });

  // ── Full pipeline execution ──────────────────────────────────────────────────

  test("returns triggered=true, generated=0 when diff is empty after pipeline", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _highDelta()
    });
    diffResumeFn = () => ({ isEmpty: true }); // no changes in work log

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", {
        date:    "2026-03-27",
        workLog: { candidates: ["Fixed bug in auth"] }
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.triggered, true);
    assert.equal(body.generated, 0, "no candidates when diff is empty");
  });

  test("returns triggered=true, generated=0 when diff produces no actionable suggestions", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _highDelta()
    });
    diffResumeFn        = () => ({ isEmpty: false, experience: { added: [], modified: [], deleted: [] } });
    diffToSuggestionsFn = () => []; // pipeline produces no suggestions

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", {
        date:    "2026-03-27",
        workLog: { candidates: ["Refactored module"] }
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.triggered, true);
    assert.equal(body.generated, 0);
  });

  test("generates N candidates and saves suggestions when delta >= threshold + workLog + diff", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _highDelta()
    });
    diffResumeFn        = () => ({ isEmpty: false });
    diffToSuggestionsFn = () => [_pendingSuggestion("new-001"), _pendingSuggestion("new-002")];

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", {
        date:    "2026-03-27",
        workLog: { candidates: ["Implemented CI/CD pipeline"] }
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.triggered, true);
    assert.equal(body.generated, 2, "two new candidates must be generated");
    assert.ok(Array.isArray(body.suggestions), "suggestions array must be returned");
    assert.equal(body.suggestions.length, 2);
  });

  test("persists new candidates to Blob when triggered", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _highDelta()
    });
    diffResumeFn        = () => ({ isEmpty: false });
    diffToSuggestionsFn = () => [_pendingSuggestion("save-001")];

    const app = buildApp();
    await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", {
        date:    "2026-03-27",
        workLog: { candidates: ["Optimized query performance"] }
      })
    );

    assert.ok(lastSavedSuggestionsDoc !== null, "saveSuggestionsData must be called");
    assert.ok(
      Array.isArray(lastSavedSuggestionsDoc.suggestions),
      "saved doc must have suggestions array"
    );
    assert.equal(lastSavedSuggestionsDoc.schemaVersion, 1, "schemaVersion must be 1");
  });

  test("supersedes existing pending candidates when new candidates are generated (AC 13 semantics)", async () => {
    resetStubs();
    const existing = _pendingSuggestion("old-pending");
    readResumeDataFn      = async () => _storedResume();
    readSuggestionsDataFn = async () => ({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      suggestions: [existing]
    });
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _highDelta()
    });
    diffResumeFn        = () => ({ isEmpty: false });
    diffToSuggestionsFn = () => [_pendingSuggestion("new-cand")];

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", {
        date:    "2026-03-27",
        workLog: { candidates: ["Deployed new service"] }
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.superseded, 1, "one existing pending must be superseded");

    // Verify in the saved doc that the old suggestion is now discarded
    const savedSuggestions = lastSavedSuggestionsDoc?.suggestions ?? [];
    const supersededOld = savedSuggestions.find((s) => s.id === "old-pending");
    assert.ok(supersededOld, "old suggestion must still be in saved doc");
    assert.equal(supersededOld.status, "discarded", "old pending must be set to discarded");
    assert.equal(supersededOld.discardReason, "superseded", "discardReason must be 'superseded'");

    const newCand = savedSuggestions.find((s) => s.id === "new-cand");
    assert.ok(newCand, "new candidate must be in saved doc");
    assert.equal(newCand.status, "pending", "new candidate must remain pending");
  });

  test("returns 502 when saving suggestions fails", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _highDelta()
    });
    diffResumeFn        = () => ({ isEmpty: false });
    diffToSuggestionsFn = () => [_pendingSuggestion()];
    saveSuggestionsDataFn = async () => { throw new Error("Blob write failure"); };

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", {
        date:    "2026-03-27",
        workLog: { candidates: ["Added tests"] }
      })
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  test("uses extract cache on cache hit, skipping LLM", async () => {
    resetStubs();
    let llmCallCount = 0;
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _highDelta()
    });
    readExtractCacheFn     = async () => ({ experience: [] }); // cache hit
    extractResumeUpdatesFn = async () => { llmCallCount++; return {}; }; // should NOT be called
    diffResumeFn           = () => ({ isEmpty: false });
    diffToSuggestionsFn    = () => [_pendingSuggestion()];

    const app = buildApp();
    await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", {
        date:    "2026-03-27",
        workLog: { candidates: ["Reviewed PRs"] }
      })
    );

    assert.equal(llmCallCount, 0, "LLM must NOT be called on cache hit");
  });

  test("response includes delta report in all triggered=false cases", async () => {
    resetStubs();
    readResumeDataFn = async () => _storedResume();
    deltaFromLastApprovedFn = async () => ({
      snapshot: _snapshotEnvelope(),
      delta:    _lowDelta()
    });

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/profile-delta-trigger", { date: "2026-03-27" })
    );
    const body = await res.json();
    assert.ok(body.delta, "delta must be present in response");
    assert.equal(typeof body.delta.rate, "number");
    assert.equal(typeof body.delta.changedUnits, "number");
    assert.equal(typeof body.delta.totalUnits, "number");
    assert.equal(typeof body.delta.isEmpty, "boolean");
  });
});

// ─── displayAxes→resume content boundary verification ─────────────────────────
//
// Each axis operation (PATCH, DELETE, merge, split) must only modify the
// `display_axes` metadata field in the resume document.  Content sections
// (experience, skills, projects, education, summary, certifications) must
// remain byte-for-byte identical to their original values.

describe("displayAxes→resume content boundary: axis operations must NOT modify content sections", () => {
  /**
   * Assert that the saved resume document has the same content sections
   * as the original resume.  Only `display_axes` (and `_sources.display_axes`)
   * are permitted to differ.
   */
  function assertContentSectionsUnchanged(originalResume) {
    assert.ok(lastSavedResumeDoc !== null, "saveResumeData must have been called");

    // Verify each content section is structurally identical
    assert.deepEqual(
      lastSavedResumeDoc.experience,
      originalResume.experience,
      "experience section must NOT be modified by axis operations"
    );
    assert.deepEqual(
      lastSavedResumeDoc.skills,
      originalResume.skills,
      "skills section must NOT be modified by axis operations"
    );
    assert.deepEqual(
      lastSavedResumeDoc.projects,
      originalResume.projects,
      "projects section must NOT be modified by axis operations"
    );
    assert.deepEqual(
      lastSavedResumeDoc.education,
      originalResume.education,
      "education section must NOT be modified by axis operations"
    );
    assert.equal(
      lastSavedResumeDoc.summary,
      originalResume.summary,
      "summary must NOT be modified by axis operations"
    );
    assert.deepEqual(
      lastSavedResumeDoc.certifications,
      originalResume.certifications,
      "certifications must NOT be modified by axis operations"
    );
    assert.deepEqual(
      lastSavedResumeDoc.contact,
      originalResume.contact,
      "contact must NOT be modified by axis operations"
    );
    assert.deepEqual(
      lastSavedResumeDoc.strength_keywords,
      originalResume.strength_keywords,
      "strength_keywords must NOT be modified by axis operations"
    );
  }

  // ── PATCH /api/resume/axes/:id ────────────────────────────────────────────

  test("PATCH /axes/:id — experience section is unchanged after axis rename", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;

    // Simulate successful axis update
    updateAxisInArrayFn = (axes, id, updates) => {
      const updated = axes.find((a) => a.id === id);
      if (!updated) return { axes, updated: null };
      const newAxis  = { ...updated, ...updates };
      const newAxes  = axes.map((a) => (a.id === id ? newAxis : a));
      return { axes: newAxes, updated: newAxis };
    };

    const app = buildApp();
    await app.fetch(
      authedPatch("http://localhost/api/resume/axes/axis-1", { label: "Senior Backend" })
    );

    assertContentSectionsUnchanged(original);
  });

  test("PATCH /axes/:id — skills section is unchanged after axis rename", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;
    updateAxisInArrayFn = (axes, id, updates) => {
      const updated = axes.find((a) => a.id === id);
      if (!updated) return { axes, updated: null };
      const newAxis = { ...updated, ...updates };
      return { axes: axes.map((a) => (a.id === id ? newAxis : a)), updated: newAxis };
    };

    const app = buildApp();
    await app.fetch(
      authedPatch("http://localhost/api/resume/axes/axis-2", { keywords: ["AWS", "GCP"] })
    );

    assertContentSectionsUnchanged(original);
  });

  test("PATCH /axes/:id — only display_axes and _sources.display_axes change in saved resume", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;
    updateAxisInArrayFn = (axes, id, updates) => {
      const updated = axes.find((a) => a.id === id);
      if (!updated) return { axes, updated: null };
      const newAxis = { ...updated, ...updates };
      return { axes: axes.map((a) => (a.id === id ? newAxis : a)), updated: newAxis };
    };

    const app = buildApp();
    await app.fetch(
      authedPatch("http://localhost/api/resume/axes/axis-1", { label: "Infra" })
    );

    assert.ok(lastSavedResumeDoc !== null, "resume must be saved");
    // display_axes IS allowed to change
    assert.ok(
      Array.isArray(lastSavedResumeDoc.display_axes),
      "display_axes must remain an array"
    );
    // _sources.display_axes must be 'user'
    assert.equal(
      lastSavedResumeDoc._sources?.display_axes,
      "user",
      "_sources.display_axes must be 'user' after user edit"
    );
    // But content sections must be untouched
    assertContentSectionsUnchanged(original);
  });

  // ── DELETE /api/resume/axes/:id ───────────────────────────────────────────

  test("DELETE /axes/:id — experience section is unchanged after axis deletion", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;
    // removeAxisFromArrayFn uses the default which filters the deleted axis

    const app = buildApp();
    await app.fetch(authedDelete("http://localhost/api/resume/axes/axis-1"));

    assertContentSectionsUnchanged(original);
  });

  test("DELETE /axes/:id — skills section is unchanged after axis deletion", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;

    const app = buildApp();
    await app.fetch(authedDelete("http://localhost/api/resume/axes/axis-2"));

    assertContentSectionsUnchanged(original);
  });

  test("DELETE /axes/:id — only display_axes shrinks in saved resume, content untouched", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;

    const app = buildApp();
    const res = await app.fetch(authedDelete("http://localhost/api/resume/axes/axis-1"));

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.removed, true, "removed must be true");

    // display_axes should have one fewer entry
    assert.equal(
      lastSavedResumeDoc.display_axes.length,
      1,
      "display_axes must have one entry after deletion of one axis"
    );
    assertContentSectionsUnchanged(original);
  });

  // ── POST /api/resume/axes/merge ───────────────────────────────────────────

  test("POST /axes/merge — experience section is unchanged after axis merge", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;
    mergeAxesFn = (axes, targetId, sourceId, newLabel) => {
      // Simple stub: merge source keywords into target
      const target = axes.find((a) => a.id === targetId);
      const source = axes.find((a) => a.id === sourceId);
      if (!target || !source) return { axes, merged: null, error: "not found" };
      const merged = {
        ...target,
        label:    newLabel ?? target.label,
        keywords: [...new Set([...target.keywords, ...source.keywords])]
      };
      const newAxes = axes.filter((a) => a.id !== sourceId).map((a) => (a.id === targetId ? merged : a));
      return { axes: newAxes, merged, error: null };
    };

    const app = buildApp();
    await app.fetch(
      authedPost("http://localhost/api/resume/axes/merge", {
        targetId: "axis-1",
        sourceId: "axis-2",
        newLabel: "Backend & DevOps"
      })
    );

    assertContentSectionsUnchanged(original);
  });

  test("POST /axes/merge — only display_axes changes in saved resume after merge", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;
    mergeAxesFn = (axes, targetId, sourceId, newLabel) => {
      const target = axes.find((a) => a.id === targetId);
      const source = axes.find((a) => a.id === sourceId);
      if (!target || !source) return { axes, merged: null, error: "not found" };
      const merged   = { ...target, label: newLabel ?? target.label, keywords: [...new Set([...target.keywords, ...source.keywords])] };
      const newAxes  = axes.filter((a) => a.id !== sourceId).map((a) => (a.id === targetId ? merged : a));
      return { axes: newAxes, merged, error: null };
    };

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/axes/merge", { targetId: "axis-1", sourceId: "axis-2" })
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // display_axes should now have 1 axis (merged)
    assert.equal(
      lastSavedResumeDoc.display_axes.length,
      1,
      "display_axes must have 1 axis after merge"
    );
    assertContentSectionsUnchanged(original);
  });

  // ── POST /api/resume/axes/:id/split ──────────────────────────────────────

  test("POST /axes/:id/split — experience section is unchanged after axis split", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;
    splitAxisFn = (axes, id, labelA, labelB, kwB) => {
      const src = axes.find((a) => a.id === id);
      if (!src) return { axes, axisA: null, axisB: null };
      const kwBSet  = new Set(Array.isArray(kwB) ? kwB : []);
      const kwAList = src.keywords.filter((k) => !kwBSet.has(k));
      const axisA   = { ...src, label: labelA ?? src.label, keywords: kwAList };
      const axisB   = { id: `${src.id}-b`, label: labelB ?? "Split B", keywords: Array.from(kwBSet), _source: "user" };
      const newAxes = axes.map((a) => (a.id === id ? axisA : a)).concat([axisB]);
      return { axes: newAxes, axisA, axisB };
    };

    const app = buildApp();
    await app.fetch(
      authedPost("http://localhost/api/resume/axes/axis-1/split", {
        labelA:   "Node.js Backend",
        labelB:   "TypeScript",
        keywordsB: ["TypeScript"]
      })
    );

    assertContentSectionsUnchanged(original);
  });

  test("POST /axes/:id/split — only display_axes expands in saved resume after split", async () => {
    resetStubs();
    const original = _storedResume(_twoAxes());
    readResumeDataFn = async () => original;
    splitAxisFn = (axes, id, labelA, labelB, kwB) => {
      const src = axes.find((a) => a.id === id);
      if (!src) return { axes, axisA: null, axisB: null };
      const kwBSet  = new Set(Array.isArray(kwB) ? kwB : []);
      const kwAList = src.keywords.filter((k) => !kwBSet.has(k));
      const axisA   = { ...src, label: labelA ?? src.label, keywords: kwAList };
      const axisB   = { id: `${src.id}-b`, label: labelB ?? "Split B", keywords: Array.from(kwBSet), _source: "user" };
      const newAxes = axes.map((a) => (a.id === id ? axisA : a)).concat([axisB]);
      return { axes: newAxes, axisA, axisB };
    };

    const app = buildApp();
    const res = await app.fetch(
      authedPost("http://localhost/api/resume/axes/axis-1/split", {
        labelA:    "Node.js Backend",
        labelB:    "TypeScript",
        keywordsB: ["TypeScript"]
      })
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // display_axes grew from 2 to 3 (split created a new axis)
    assert.equal(
      lastSavedResumeDoc.display_axes.length,
      3,
      "display_axes must have 3 axes after split (axis-1 split + axis-2 unchanged)"
    );
    assertContentSectionsUnchanged(original);
  });
});
