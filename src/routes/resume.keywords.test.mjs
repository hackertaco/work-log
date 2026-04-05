/**
 * Tests for strength-keywords CRUD endpoints.
 *
 * Sub-AC 15-2: Strength Keyword CRUD API — add, query, delete endpoints with
 * duplicate handling logic.
 *
 * Endpoints under test:
 *   GET    /api/resume/strength-keywords          — list current keywords
 *   POST   /api/resume/strength-keywords          — add keyword(s) (additive, dedup)
 *   DELETE /api/resume/strength-keywords/:keyword — remove a single keyword
 *   PATCH  /api/resume/strength-keywords          — replace full keyword list
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.keywords.test.mjs
 *
 * Strategy
 * --------
 * All Blob I/O is stubbed via Node.js module mocks so tests run fully offline.
 * The resumeStrengthKeywords.mjs library is NOT mocked — it is pure business
 * logic with no I/O and its deduplication behaviour is part of what we verify.
 *
 * Mock stubs are assigned via let-bindings so each test can override them.
 * All mocks are registered before the router is imported (required by
 * --experimental-test-module-mocks).
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

/** Controls what readStrengthKeywords() returns in tests. */
let readStrengthKeywordsFn = async () => ({
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  source: "system",
  keywords: []
});

/** Records the last document passed to saveStrengthKeywords(). */
let lastSavedKeywordsDoc = null;
let saveStrengthKeywordsFn = async (doc) => {
  lastSavedKeywordsDoc = doc;
  return { url: "https://blob/resume/strength-keywords.json" };
};

/** Controls what readResumeData() returns (used for secondary sync). */
let readResumeDataFn = async () => null;

/** Records save calls for resume data.json sync checks. */
let lastSavedResumeData = null;
let saveResumeDataFn = async (data) => {
  lastSavedResumeData = data;
  return { url: "https://blob/resume/data.json" };
};

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    // Strength keywords (primary storage for keyword endpoints)
    readStrengthKeywords:         (...args) => readStrengthKeywordsFn(...args),
    saveStrengthKeywords:         (...args) => saveStrengthKeywordsFn(...args),
    STRENGTH_KEYWORDS_PATHNAME:   "resume/strength-keywords.json",

    // Resume data (used by secondary sync in POST/DELETE/PATCH)
    readResumeData:               (...args) => readResumeDataFn(...args),
    saveResumeData:               (...args) => saveResumeDataFn(...args),

    // Remaining blob exports that resume.mjs imports
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
    reclusterPipeline:           async () => [],
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
    createAxis:             (label, kws) => ({ id: "new", label, keywords: kws ?? [] }),
    updateAxisInArray:      (axes) => axes,
    removeAxisFromArray:    (axes) => axes,
    splitAxis:              (axes) => axes,
    mergeAxes:              (a, b) => a,
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
 * Build a minimal Hono app that mirrors the production setup:
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

// ─── Helper to reset mutable stubs before each test ──────────────────────────

function resetStubs() {
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "system",
    keywords: []
  });
  saveStrengthKeywordsFn = async (doc) => {
    lastSavedKeywordsDoc = doc;
    return { url: "https://blob/resume/strength-keywords.json" };
  };
  readResumeDataFn  = async () => null;
  saveResumeDataFn  = async (data) => { lastSavedResumeData = data; return { url: "https://blob/resume/data.json" }; };
  lastSavedKeywordsDoc = null;
  lastSavedResumeData  = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/resume/strength-keywords
// ═══════════════════════════════════════════════════════════════════════════════

test("GET /api/resume/strength-keywords — returns empty list when no keywords stored", async () => {
  resetStubs();
  // readStrengthKeywords already returns [] by default
  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/strength-keywords"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.keywords, []);
});

test("GET /api/resume/strength-keywords — returns stored keyword list", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: "2025-01-01T00:00:00.000Z",
    source: "bootstrap",
    keywords: ["React", "TypeScript", "Node.js"]
  });
  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/strength-keywords"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.keywords, ["React", "TypeScript", "Node.js"]);
});

test("GET /api/resume/strength-keywords — returns 502 when Blob throws", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => {
    throw new Error("Blob connection refused");
  };
  const app = buildApp();
  const res = await app.fetch(authedReq("http://localhost/api/resume/strength-keywords"));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.ok(body.ok === false);
  assert.match(body.detail, /Blob connection refused/);
});

test("GET /api/resume/strength-keywords — returns 401 when not authenticated", async () => {
  resetStubs();
  const app = buildApp("secret");
  const res = await app.fetch(new Request("http://localhost/api/resume/strength-keywords"));
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/resume/strength-keywords
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/strength-keywords — adds new keywords and returns updated list", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "bootstrap",
    keywords: ["React"]
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "POST", {
      keywords: ["TypeScript", "Node.js"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.keywords, ["React", "TypeScript", "Node.js"]);
  assert.deepEqual(body.added,    ["TypeScript", "Node.js"]);
});

test("POST /api/resume/strength-keywords — deduplicates case-insensitively", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "user",
    keywords: ["react", "TypeScript"]
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "POST", {
      // "React" and "TYPESCRIPT" should be recognised as duplicates
      keywords: ["React", "TYPESCRIPT", "Node.js"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  // Only "Node.js" is genuinely new
  assert.deepEqual(body.added, ["Node.js"]);
  // "react" and "TypeScript" are preserved as-is; Node.js appended
  assert.ok(body.keywords.includes("Node.js"));
  assert.equal(body.keywords.length, 3);
});

test("POST /api/resume/strength-keywords — accepts single keyword via `keyword` string field", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "POST", {
      keyword: "Docker"
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.added, ["Docker"]);
  assert.deepEqual(body.keywords, ["Docker"]);
});

test("POST /api/resume/strength-keywords — returns ok:true with empty added when all duplicates", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "user",
    keywords: ["React", "TypeScript"]
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "POST", {
      keywords: ["REACT", "typescript"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.added, []);
  // No Blob write should occur when nothing was added
  assert.equal(lastSavedKeywordsDoc, null);
});

test("POST /api/resume/strength-keywords — returns 400 when body has neither keywords nor keyword field", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "POST", { foo: "bar" })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/strength-keywords — returns 400 when body is not JSON", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/strength-keywords", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" }
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/strength-keywords — returns 502 when Blob read fails", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => {
    throw new Error("Blob unavailable");
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "POST", {
      keywords: ["React"]
    })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob unavailable/);
});

test("POST /api/resume/strength-keywords — returns 502 when Blob save fails", async () => {
  resetStubs();
  saveStrengthKeywordsFn = async () => {
    throw new Error("Blob write error");
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "POST", {
      keywords: ["React"]
    })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("POST /api/resume/strength-keywords — syncs strength_keywords to resume data.json when resume exists", async () => {
  resetStubs();
  const storedResume = {
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: [], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: ["Existing"],
    display_axes: []
  };
  readResumeDataFn = async () => storedResume;

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "POST", {
      keywords: ["NewKeyword"]
    })
  );

  assert.equal(res.status, 200);
  // Verify that resume data.json was also updated
  assert.ok(lastSavedResumeData !== null, "saveResumeData should have been called");
  assert.ok(
    Array.isArray(lastSavedResumeData.strength_keywords) &&
    lastSavedResumeData.strength_keywords.includes("NewKeyword"),
    "Resume data.json should include the newly added keyword"
  );
  assert.equal(lastSavedResumeData._sources.strength_keywords, "user");
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/resume/strength-keywords/:keyword
// ═══════════════════════════════════════════════════════════════════════════════

test("DELETE /api/resume/strength-keywords/:keyword — removes existing keyword", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "user",
    keywords: ["React", "TypeScript", "Node.js"]
  });

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/strength-keywords/TypeScript", { method: "DELETE" })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok,      true);
  assert.equal(body.removed, true);
  assert.deepEqual(body.keywords, ["React", "Node.js"]);
});

test("DELETE /api/resume/strength-keywords/:keyword — case-insensitive match", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "user",
    keywords: ["React", "TypeScript"]
  });

  const app = buildApp();
  // Keyword stored as "React" but deleted as "react"
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/strength-keywords/react", { method: "DELETE" })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, true);
  assert.deepEqual(body.keywords, ["TypeScript"]);
});

test("DELETE /api/resume/strength-keywords/:keyword — returns removed:false when keyword not present", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "user",
    keywords: ["React", "TypeScript"]
  });

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/strength-keywords/Angular", { method: "DELETE" })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok,      true);
  assert.equal(body.removed, false);
  // Keywords unchanged
  assert.deepEqual(body.keywords, ["React", "TypeScript"]);
  // No Blob write should have occurred
  assert.equal(lastSavedKeywordsDoc, null);
});

test("DELETE /api/resume/strength-keywords/:keyword — URL-decodes the keyword parameter", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "user",
    keywords: ["React Native", "TypeScript"]
  });

  const app = buildApp();
  // "React Native" URL-encoded as "React%20Native"
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/strength-keywords/React%20Native", { method: "DELETE" })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, true);
  assert.deepEqual(body.keywords, ["TypeScript"]);
});

test("DELETE /api/resume/strength-keywords/:keyword — returns 502 when Blob read fails", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => {
    throw new Error("Blob read error");
  };

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/strength-keywords/React", { method: "DELETE" })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.detail, /Blob read error/);
});

test("DELETE /api/resume/strength-keywords/:keyword — returns 502 when Blob save fails", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "user",
    keywords: ["React"]
  });
  saveStrengthKeywordsFn = async () => {
    throw new Error("Blob write error");
  };

  const app = buildApp();
  const res = await app.fetch(
    authedReq("http://localhost/api/resume/strength-keywords/React", { method: "DELETE" })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/resume/strength-keywords
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume/strength-keywords — replaces entire keyword list", async () => {
  resetStubs();
  readStrengthKeywordsFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: "user",
    keywords: ["OldKeyword1", "OldKeyword2"]
  });

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", {
      keywords: ["React", "TypeScript", "GraphQL"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.keywords, ["React", "TypeScript", "GraphQL"]);
});

test("PATCH /api/resume/strength-keywords — accepts empty array (clears list)", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", {
      keywords: []
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.keywords, []);
});

test("PATCH /api/resume/strength-keywords — deduplicates the incoming list case-insensitively", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", {
      keywords: ["React", "react", "REACT", "TypeScript"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  // "react" and "REACT" are duplicates of "React" — only first occurrence kept
  assert.equal(body.keywords.length, 2);
  assert.ok(body.keywords[0] === "React" || body.keywords[0].toLowerCase() === "react");
  assert.ok(body.keywords.some(k => k.toLowerCase() === "typescript"));
});

test("PATCH /api/resume/strength-keywords — silently drops non-string entries", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", {
      keywords: ["React", 42, null, undefined, "TypeScript"]
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  // Only the two valid strings survive
  assert.deepEqual(body.keywords, ["React", "TypeScript"]);
});

test("PATCH /api/resume/strength-keywords — saves to dedicated blob with source:'user'", async () => {
  resetStubs();

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", {
      keywords: ["React"]
    })
  );

  assert.ok(lastSavedKeywordsDoc !== null, "saveStrengthKeywords should have been called");
  assert.equal(lastSavedKeywordsDoc.source, "user");
  assert.deepEqual(lastSavedKeywordsDoc.keywords, ["React"]);
  assert.ok(typeof lastSavedKeywordsDoc.updatedAt === "string");
  assert.equal(lastSavedKeywordsDoc.schemaVersion, 1);
});

test("PATCH /api/resume/strength-keywords — syncs to resume data.json when resume exists", async () => {
  resetStubs();
  const storedResume = {
    meta: { language: "en", source: "pdf", generatedAt: "2025-01-01T00:00:00.000Z", schemaVersion: 1 },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test" },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: [], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: ["Old"],
    display_axes: []
  };
  readResumeDataFn = async () => storedResume;

  const app = buildApp();
  await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", {
      keywords: ["New1", "New2"]
    })
  );

  assert.ok(lastSavedResumeData !== null, "saveResumeData should be called for sync");
  assert.deepEqual(lastSavedResumeData.strength_keywords, ["New1", "New2"]);
  assert.equal(lastSavedResumeData._sources.strength_keywords, "user");
});

test("PATCH /api/resume/strength-keywords — returns 400 when keywords field is missing", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", { foo: "bar" })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/strength-keywords — returns 400 when keywords is not an array", async () => {
  resetStubs();

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", {
      keywords: "React"  // string instead of array
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/strength-keywords — returns 502 when Blob save fails", async () => {
  resetStubs();
  saveStrengthKeywordsFn = async () => {
    throw new Error("Blob write error");
  };

  const app = buildApp();
  const res = await app.fetch(
    authedJsonReq("http://localhost/api/resume/strength-keywords", "PATCH", {
      keywords: ["React"]
    })
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/strength-keywords — returns 401 when not authenticated", async () => {
  resetStubs();

  const app = buildApp("secret");
  const res = await app.fetch(
    new Request("http://localhost/api/resume/strength-keywords", {
      method: "PATCH",
      body: JSON.stringify({ keywords: ["React"] }),
      headers: { "content-type": "application/json" }
    })
  );

  assert.equal(res.status, 401);
});
