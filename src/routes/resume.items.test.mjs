/**
 * Tests for PATCH /api/resume/items — unified bullet direct-edit endpoint.
 *
 * Sub-AC 8-1: Backend direct-edit API
 *   • op="add"    — appends a bullet to an experience/projects item
 *   • op="update" — replaces a bullet at bulletIndex with new text
 *   • op="delete" — removes a bullet at bulletIndex
 *   • _source is always set to "user" on the mutated item
 *   • mergeCandidates / suggestions document is never touched
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.items.test.mjs
 *
 * Strategy
 * --------
 * All heavy I/O dependencies are stubbed via Node.js module mocks.
 * Mutable wrapper functions let each test control stub return values.
 * The router is loaded via a top-level `await import()` AFTER all mocks are
 * registered (required by --experimental-test-module-mocks).
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

let readResumeDataFn  = async () => null;
let saveResumeDataFn  = async () => ({ url: "https://blob/resume/data.json" });

/** Tracks calls to saveSuggestionsData to verify it is NEVER invoked. */
let saveSuggestionsCallCount = 0;

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: false }),
    saveResumeData:               (...args) => saveResumeDataFn(...args),
    readResumeData:               (...args) => readResumeDataFn(...args),
    readSuggestionsData:          async () => ({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      suggestions: []
    }),
    saveSuggestionsData:          async (...args) => {
      saveSuggestionsCallCount += 1;
      return { url: "https://blob/resume/suggestions.json" };
    },
    saveDailyBullets:             async () => ({ url: "https://blob/resume/bullets/test.json" }),
    readDailyBullets:             async () => null,
    listBulletDates:              async () => [],
    deleteDailyBullets:           async () => {},
    savePdfText:                  async () => ({ url: "https://blob/resume/pdf-text.txt" }),
    readPdfText:                  async () => null,
    savePdfRaw:                   async () => ({ url: "https://blob/resume/resume.pdf" }),
    checkPdfRawExists:            async () => false,
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
    readStrengthKeywords:         async () => ({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      source: "system",
      keywords: []
    }),
    saveStrengthKeywords:         async () => ({ url: "https://blob/resume/strength-keywords.json" }),
    STRENGTH_KEYWORDS_PATHNAME:   "resume/strength-keywords.json",
    saveLinkedInImport:           async () => ({ url: "https://blob/resume/linkedin.json" }),
    readLinkedInImport:           async () => null,
    clearLinkedInImport:          async () => {},
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
  namedExports: {
    generateResumeFromText: async () => ({
      resumeData: {
        meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
        _sources: { summary: "system", contact: "system", skills: "system" },
        contact: { name: "Test", email: null, phone: null, location: null, website: null, linkedin: null },
        summary: "",
        experience: [],
        education: [],
        skills: { technical: [], languages: [], tools: [] },
        projects: [],
        certifications: []
      },
      strengthKeywords: [],
      displayAxes: []
    })
  }
});

mock.module("../lib/resumeReconstruction.mjs", {
  namedExports: {
    gatherWorkLogBullets:         async () => [],
    fullReconstructExtractCache:  async () => ({ contact: { name: "Test" } }),
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

mock.module("../lib/resumeAxes.mjs", {
  namedExports: {
    createAxis:             (label, kws, source) => ({ id: "new", label, keywords: kws ?? [], _source: source ?? "system" }),
    updateAxisInArray:      (axes) => axes,
    removeAxisFromArray:    (axes) => axes,
    splitAxis:              (axes) => axes,
    mergeAxes:              (a) => a,
    migrateAxes:            (axes) => axes,
    moveKeywordBetweenAxes: (axes) => axes
  }
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

mock.module("../lib/resumeStrengthKeywords.mjs", {
  namedExports: {
    mergeKeywords:        (doc, kws) => ({ ...doc, keywords: [...(doc?.keywords ?? []), ...kws] }),
    removeKeyword:        (doc, kw) => doc,
    replaceKeywords:      (kws, source) => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: source ?? "user", keywords: kws }),
    extractKeywordsArray: (doc) => doc?.keywords ?? [],
    initStrengthKeywordsFromBootstrap: (kws) => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "bootstrap", keywords: kws ?? [] })
  }
});

mock.module("../lib/resumeSnapshotDelta.mjs", {
  namedExports: {
    computeSnapshotDelta:   () => ({ changed: false }),
    computeProfileDelta:    () => ({ rate: 0, changedUnits: 0, totalUnits: 0, isEmpty: true, breakdown: {} }),
    getLastApprovedSnapshot: async () => null,
    deltaFromLastApproved:  async () => ({ snapshot: null, delta: { rate: 0, changedUnits: 0, totalUnits: 0, isEmpty: true, breakdown: {} } })
  }
});

mock.module("../lib/resumeWorkLogDiff.mjs", {
  namedExports: {
    buildWorkLogDiff:    () => ({ newBullets: [], changedBullets: [] }),
    isWorkLogDiffEmpty:  () => true
  }
});

// ─── Load router under test AFTER mocks are registered ───────────────────────

const { resumeRouter } = await import("./resume.mjs");
const { cookieAuth }   = await import("../middleware/auth.mjs");

// ─── Test app builder ─────────────────────────────────────────────────────────

/**
 * Build a minimal Hono app mirroring production mount:
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

/** Authenticated request with cookie. */
function authedReq(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("cookie", "resume_token=test-secret");
  return new Request(url, { ...options, headers });
}

/** Authenticated JSON-body request. */
function authedJsonReq(url, body) {
  return authedReq(url, {
    method:  "PATCH",
    body:    JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Minimal stored resume with one experience item (two bullets) and one project. */
function storedResume() {
  return {
    meta: {
      language: "en",
      source: "pdf",
      generatedAt: "2025-01-01T00:00:00.000Z",
      schemaVersion: 1
    },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: "A developer.",
    experience: [
      {
        _source: "system",
        company: "Acme Corp",
        title: "Software Engineer",
        start_date: "2022-01",
        end_date: null,
        location: null,
        bullets: ["Wrote code", "Fixed bugs"]
      }
    ],
    education: [],
    skills: { technical: ["JavaScript"], languages: [], tools: [] },
    projects: [
      {
        _source: "system",
        name: "Cool Project",
        description: "A demo",
        url: null,
        bullets: ["Built the thing"]
      }
    ],
    certifications: []
  };
}

/** Reset mutable stubs and counters before each test. */
function resetStubs() {
  readResumeDataFn       = async () => null;
  saveResumeDataFn       = async () => ({ url: "https://blob/resume/data.json" });
  saveSuggestionsCallCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Input validation — returns 400
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items — 400 when body is not JSON", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/items", {
    method: "PATCH",
    body: "not-json",
    headers: { "content-type": "application/json" }
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/items — 400 when op is missing", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      section: "experience", itemIndex: 0, text: "new bullet"
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /op/);
});

test("PATCH /api/resume/items — 400 when op is invalid value", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "upsert", section: "experience", itemIndex: 0, text: "x"
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /op/);
});

test("PATCH /api/resume/items — 400 when section is invalid", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "education", itemIndex: 0, text: "new bullet"
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /section/);
});

test("PATCH /api/resume/items — 400 when itemIndex is negative", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: -1, text: "x"
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /itemIndex/);
});

test("PATCH /api/resume/items — 400 when itemIndex is not an integer", async () => {
  resetStubs();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 1.5, text: "x"
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/items — 400 when op=update and bulletIndex missing", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "update", section: "experience", itemIndex: 0, text: "updated"
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /bulletIndex/);
});

test("PATCH /api/resume/items — 400 when op=delete and bulletIndex missing", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "delete", section: "experience", itemIndex: 0
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /bulletIndex/);
});

test("PATCH /api/resume/items — 400 when op=add and text is empty string", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: "   "
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /text/);
});

test("PATCH /api/resume/items — 400 when op=update and text is empty string", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "update", section: "experience", itemIndex: 0, bulletIndex: 0, text: ""
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /text/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 404 — no resume / out-of-bounds
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items — 404 when no resume stored (bootstrap first)", async () => {
  resetStubs();
  // readResumeDataFn returns null by default
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: "new bullet"
    })
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/items — 404 when itemIndex is out of bounds", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 99, text: "new bullet"
    })
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /없습니다/);
});

test("PATCH /api/resume/items — 404 when bulletIndex is out of bounds for update", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "update", section: "experience", itemIndex: 0, bulletIndex: 99, text: "updated"
    })
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/items — 404 when bulletIndex is out of bounds for delete", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "delete", section: "experience", itemIndex: 0, bulletIndex: 99
    })
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// op="add" — happy paths
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items (add) — appends bullet to experience item", async () => {
  resetStubs();
  const resume = storedResume();
  readResumeDataFn = async () => resume;
  let savedResume;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: "  Led the migration  "
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // bullet was appended (trimmed)
  assert.equal(body.resume.experience[0].bullets.length, 3);
  assert.equal(body.resume.experience[0].bullets[2], "Led the migration");

  // _source was set to "user"
  assert.equal(body.resume.experience[0]._source, "user");

  // saveResumeData was called
  assert.ok(savedResume, "saveResumeData should have been called");
  assert.equal(savedResume.experience[0].bullets[2], "Led the migration");
});

test("PATCH /api/resume/items (add) — appends bullet to projects item", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "projects", itemIndex: 0, text: "Shipped v2"
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.resume.projects[0].bullets.length, 2);
  assert.equal(body.resume.projects[0].bullets[1], "Shipped v2");
  assert.equal(body.resume.projects[0]._source, "user");
});

test("PATCH /api/resume/items (add) — text is capped at 500 chars", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const longText = "x".repeat(600);
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: longText
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const addedBullet = body.resume.experience[0].bullets[2];
  assert.equal(addedBullet.length, 500);
});

test("PATCH /api/resume/items (add) — other items in section are unchanged", async () => {
  resetStubs();
  // Add a second experience item
  const resume = storedResume();
  resume.experience.push({
    _source: "system",
    company: "OtherCo",
    title: "Dev",
    start_date: "2020-01",
    end_date: "2022-01",
    location: null,
    bullets: ["Did stuff"]
  });
  readResumeDataFn = async () => resume;
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: "New bullet"
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // itemIndex=1 is untouched
  assert.equal(body.resume.experience[1]._source, "system");
  assert.equal(body.resume.experience[1].bullets.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// op="update" — happy paths
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items (update) — replaces bullet text at bulletIndex", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  let savedResume;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "update", section: "experience", itemIndex: 0, bulletIndex: 1, text: "Resolved 50+ incidents"
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // bullet[0] unchanged, bullet[1] replaced
  assert.equal(body.resume.experience[0].bullets[0], "Wrote code");
  assert.equal(body.resume.experience[0].bullets[1], "Resolved 50+ incidents");
  assert.equal(body.resume.experience[0].bullets.length, 2);

  // _source set to "user"
  assert.equal(body.resume.experience[0]._source, "user");

  // persisted
  assert.ok(savedResume);
  assert.equal(savedResume.experience[0].bullets[1], "Resolved 50+ incidents");
});

test("PATCH /api/resume/items (update) — text is trimmed", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "update", section: "experience", itemIndex: 0, bulletIndex: 0, text: "  Refactored everything  "
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resume.experience[0].bullets[0], "Refactored everything");
});

test("PATCH /api/resume/items (update) — updates projects bullet", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "update", section: "projects", itemIndex: 0, bulletIndex: 0, text: "Delivered v2 on time"
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resume.projects[0].bullets[0], "Delivered v2 on time");
  assert.equal(body.resume.projects[0]._source, "user");
});

// ═══════════════════════════════════════════════════════════════════════════════
// op="delete" — happy paths
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items (delete) — removes bullet at bulletIndex", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  let savedResume;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "delete", section: "experience", itemIndex: 0, bulletIndex: 0
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  // only one bullet remains
  assert.equal(body.resume.experience[0].bullets.length, 1);
  assert.equal(body.resume.experience[0].bullets[0], "Fixed bugs");

  // _source set to "user"
  assert.equal(body.resume.experience[0]._source, "user");

  // persisted
  assert.ok(savedResume);
  assert.equal(savedResume.experience[0].bullets.length, 1);
});

test("PATCH /api/resume/items (delete) — removes last bullet leaving empty array", async () => {
  resetStubs();
  const resume = storedResume();
  resume.experience[0].bullets = ["Only bullet"];
  readResumeDataFn = async () => resume;
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "delete", section: "experience", itemIndex: 0, bulletIndex: 0
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.resume.experience[0].bullets, []);
  assert.equal(body.resume.experience[0]._source, "user");
});

test("PATCH /api/resume/items (delete) — removes correct index (middle bullet)", async () => {
  resetStubs();
  const resume = storedResume();
  resume.experience[0].bullets = ["A", "B", "C"];
  readResumeDataFn = async () => resume;
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "delete", section: "experience", itemIndex: 0, bulletIndex: 1
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.resume.experience[0].bullets, ["A", "C"]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// source=user constraint
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items — _source is always 'user' even when item was 'system'", async () => {
  resetStubs();
  const resume = storedResume();
  assert.equal(resume.experience[0]._source, "system");
  readResumeDataFn = async () => resume;
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: "New bullet"
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resume.experience[0]._source, "user");
});

test("PATCH /api/resume/items — _source is always 'user' even when item was 'user_approved'", async () => {
  resetStubs();
  const resume = storedResume();
  resume.experience[0]._source = "user_approved";
  readResumeDataFn = async () => resume;
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "update", section: "experience", itemIndex: 0, bulletIndex: 0, text: "Overriding approved item"
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resume.experience[0]._source, "user");
});

// ═══════════════════════════════════════════════════════════════════════════════
// mergeCandidates bypass — saveSuggestionsData must never be called
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items — saveSuggestionsData is never called (bypasses mergeCandidates)", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();

  // op=add
  await app.fetch(authedJsonReq("http://localhost/api/resume/items", {
    op: "add", section: "experience", itemIndex: 0, text: "New bullet A"
  }));

  // op=update
  await app.fetch(authedJsonReq("http://localhost/api/resume/items", {
    op: "update", section: "experience", itemIndex: 0, bulletIndex: 0, text: "Updated bullet"
  }));

  // op=delete
  await app.fetch(authedJsonReq("http://localhost/api/resume/items", {
    op: "delete", section: "experience", itemIndex: 0, bulletIndex: 0
  }));

  assert.equal(
    saveSuggestionsCallCount,
    0,
    `saveSuggestionsData should never be called but was called ${saveSuggestionsCallCount} time(s)`
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 500 — Blob storage failure
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items — 500 when saveResumeData throws", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  saveResumeDataFn = async () => { throw new Error("Blob write timeout"); };
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: "Should fail"
    })
  );
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /저장/);
});

test("PATCH /api/resume/items — 500 when readResumeData throws", async () => {
  resetStubs();
  readResumeDataFn = async () => { throw new Error("Blob read error"); };
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: "Should fail"
    })
  );
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Response shape
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/items — response includes full resume document", async () => {
  resetStubs();
  readResumeDataFn = async () => storedResume();
  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/items", {
      op: "add", section: "experience", itemIndex: 0, text: "New bullet"
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.resume, "response must include resume document");
  assert.ok(body.resume.experience, "resume must have experience section");
  assert.ok(body.resume.meta, "resume must have meta");
});
