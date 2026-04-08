/**
 * Tests for source metadata auto-assignment (Sub-AC 9b).
 *
 * Verifies that every resume-mutating API endpoint stamps the correct
 * `_source` / `_sources` value on resume items and sections:
 *
 *   • Direct user creation / editing  → _source: "user"
 *   • AI / system generation          → _source: "system"
 *   • User approval of a suggestion   → _source: "user_approved"
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.source.test.mjs
 *
 * Strategy
 * --------
 * All heavy I/O dependencies are stubbed via Node.js module mocks.
 * Mutable wrapper functions let each test control what the stubs return.
 * The router is loaded via a top-level `await import()` AFTER all mocks
 * are registered (required by --experimental-test-module-mocks).
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

let readResumeDataFn     = async () => null;
let saveResumeDataFn     = async () => ({ url: "https://blob/resume/data.json" });
let readSuggestionsDataFn = async () => ({
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  suggestions: []
});
let saveSuggestionsDataFn = async () => ({ url: "https://blob/resume/suggestions.json" });
let generateResumeFromTextFn = async () => _defaultBootstrapResult();
let extractPdfTextFn     = async () => "sample pdf text";

// ─── Default fixture helpers ──────────────────────────────────────────────────

/**
 * A minimal stored resume with one system-generated experience item.
 */
function _storedResume() {
  return {
    meta: {
      language: "en",
      source: "pdf",
      generatedAt: "2025-01-01T00:00:00.000Z",
      schemaVersion: 1,
      pdf_name: "resume.pdf",
      linkedin_url: null
    },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test User", email: null, phone: null, location: null, website: null, linkedin: null },
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
    projects: [],
    certifications: [],
    strength_keywords: [],
    display_axes: []
  };
}

/**
 * Bootstrap result where experience items intentionally have NO _source field —
 * this simulates a LLM result that bypasses normalizeBootstrapResult's stamping.
 * assembleBlobDocument must defensively stamp _source: "system" in this case.
 */
function _defaultBootstrapResult() {
  return {
    resumeData: {
      meta: {
        language: "en",
        source: "pdf",
        generatedAt: "2025-01-01T00:00:00.000Z",
        schemaVersion: 1
      },
      _sources: { summary: "system", contact: "system", skills: "system" },
      contact: { name: "Test User", email: null, phone: null, location: null, website: null, linkedin: null },
      summary: "A developer.",
      // ⚠ No _source on items — defensive stamping in assembleBlobDocument must add it
      experience: [
        {
          company: "Acme Corp",
          title: "Software Engineer",
          start_date: "2022-01",
          end_date: null,
          location: null,
          bullets: ["Built systems"]
        }
      ],
      education: [
        {
          institution: "State University",
          degree: "BSc",
          field: "Computer Science",
          start_date: null,
          end_date: null,
          gpa: null
        }
      ],
      skills: { technical: ["JavaScript"], languages: [], tools: [] },
      projects: [
        {
          name: "Open Source Widget",
          description: "A useful widget",
          url: null,
          tech_stack: [],
          bullets: ["Published on npm"]
        }
      ],
      certifications: [
        {
          name: "AWS Certified Developer",
          issuer: "Amazon",
          date: "2024-06"
        }
      ]
    },
    strengthKeywords: ["JavaScript"],
    displayAxes: []
  };
}

/**
 * A single pending "append_bullet" suggestion targeting Acme Corp.
 */
function _pendingSuggestions() {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id: "sug-001",
        type: "work_log_update",
        section: "experience",
        action: "append_bullet",
        description: "Acme Corp: deployed microservices",
        detail: "2025-01-15 업무 로그 기반",
        patch: { company: "Acme Corp", bullet: "Deployed microservices to Kubernetes" },
        source: "work_log",
        logDate: "2025-01-15",
        createdAt: new Date().toISOString(),
        status: "pending"
      }
    ]
  };
}

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: false }),
    saveResumeData:               (...args) => saveResumeDataFn(...args),
    readResumeData:               (...args) => readResumeDataFn(...args),
    readSuggestionsData:          (...args) => readSuggestionsDataFn(...args),
    saveSuggestionsData:          (...args) => saveSuggestionsDataFn(...args),
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
  namedExports: {
    extractPdfText: (...args) => extractPdfTextFn(...args)
  }
});

mock.module("../lib/pdfExtract.mjs", {
  namedExports: {
    extractTextFromBuffer: (...args) => extractPdfTextFn(...args)
  }
});

mock.module("../lib/resumeBootstrap.mjs", {
  namedExports: {
    generateResumeFromText: (...args) => generateResumeFromTextFn(...args)
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
    reclusterPipeline:           async () => ({ axes: [] }),
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

function authed(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("cookie", "resume_token=test-secret");
  return new Request(url, { ...options, headers });
}

function jsonBody(obj) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj)
  };
}

// ─── Helpers to build minimal multipart PDF requests ─────────────────────────

function buildPdfFormData(extraFields = {}) {
  const formData = new FormData();
  // Minimal PDF: starts with %PDF- magic bytes
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
  const pdfFile  = new File([pdfBytes], "test-resume.pdf", { type: "application/pdf" });
  formData.append("pdf", pdfFile);
  for (const [k, v] of Object.entries(extraFields)) {
    formData.append(k, v);
  }
  return formData;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. BOOTSTRAP  →  _source: "system"
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/bootstrap — experience items receive _source:'system' even when LLM result has no _source", async () => {
  // Arrange: LLM returns experience items WITHOUT _source field
  const bootstrapResult = _defaultBootstrapResult();
  // Confirm the test fixture has no _source on experience items
  assert.ok(!("_source" in bootstrapResult.resumeData.experience[0]),
    "Test fixture must not pre-stamp _source so we can verify assembleBlobDocument adds it");

  generateResumeFromTextFn = async () => bootstrapResult;

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const formData = buildPdfFormData();
  const headers = new Headers({ cookie: "resume_token=test-secret" });

  const res = await app.fetch(
    new Request("http://localhost/api/resume/bootstrap", {
      method: "POST",
      body: formData,
      headers
    })
  );

  assert.equal(res.status, 201, `Expected 201 but got ${res.status}: ${await res.text()}`);
  assert.ok(savedResume, "saveResumeData must have been called");
  assert.ok(Array.isArray(savedResume.experience) && savedResume.experience.length > 0,
    "experience must be non-empty");

  // Core assertion: defensive stamp must supply _source: "system"
  for (const item of savedResume.experience) {
    assert.equal(item._source, "system",
      `experience item "_source" must be "system", got "${item._source}"`);
  }
});

test("POST /api/resume/bootstrap — education items receive _source:'system' even when LLM result has no _source", async () => {
  const bootstrapResult = _defaultBootstrapResult();
  assert.ok(!("_source" in bootstrapResult.resumeData.education[0]));

  generateResumeFromTextFn = async () => bootstrapResult;

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const formData = buildPdfFormData();
  const headers = new Headers({ cookie: "resume_token=test-secret" });

  const res = await app.fetch(
    new Request("http://localhost/api/resume/bootstrap", {
      method: "POST",
      body: formData,
      headers
    })
  );

  assert.equal(res.status, 201);
  assert.ok(savedResume?.education?.length > 0, "education must be non-empty");
  for (const item of savedResume.education) {
    assert.equal(item._source, "system",
      `education item "_source" must be "system", got "${item._source}"`);
  }
});

test("POST /api/resume/bootstrap — projects items receive _source:'system' even when LLM result has no _source", async () => {
  const bootstrapResult = _defaultBootstrapResult();

  generateResumeFromTextFn = async () => bootstrapResult;

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const formData = buildPdfFormData();
  const headers = new Headers({ cookie: "resume_token=test-secret" });

  const res = await app.fetch(
    new Request("http://localhost/api/resume/bootstrap", {
      method: "POST",
      body: formData,
      headers
    })
  );

  assert.equal(res.status, 201);
  // projects may be empty or populated depending on fixture
  for (const item of (savedResume?.projects ?? [])) {
    assert.equal(item._source, "system",
      `project item "_source" must be "system", got "${item._source}"`);
  }
});

test("POST /api/resume/bootstrap — pre-stamped _source:'user' on items is preserved", async () => {
  // Items that already have _source: "user" (e.g. from a prior merge) must NOT
  // be overwritten with "system".
  const bootstrapResult = _defaultBootstrapResult();
  bootstrapResult.resumeData.experience[0]._source = "user";

  generateResumeFromTextFn = async () => bootstrapResult;

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const formData = buildPdfFormData();
  const headers = new Headers({ cookie: "resume_token=test-secret" });

  const res = await app.fetch(
    new Request("http://localhost/api/resume/bootstrap", {
      method: "POST",
      body: formData,
      headers
    })
  );

  assert.equal(res.status, 201);
  // _source: "user" must be preserved (not overwritten with "system")
  assert.equal(savedResume.experience[0]._source, "user",
    "pre-existing _source:'user' must not be overwritten by the defensive stamp");
});

test("POST /api/resume/bootstrap — certifications items receive _source:'system'", async () => {
  const bootstrapResult = _defaultBootstrapResult();

  generateResumeFromTextFn = async () => bootstrapResult;

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const formData = buildPdfFormData();
  const headers = new Headers({ cookie: "resume_token=test-secret" });

  const res = await app.fetch(
    new Request("http://localhost/api/resume/bootstrap", {
      method: "POST",
      body: formData,
      headers
    })
  );

  assert.equal(res.status, 201);
  for (const item of (savedResume?.certifications ?? [])) {
    assert.equal(item._source, "system",
      `certification item "_source" must be "system", got "${item._source}"`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DIRECT USER EDIT (PATCH /api/resume)  →  _source: "user"
// ═══════════════════════════════════════════════════════════════════════════════

test("PATCH /api/resume — experience items in the payload receive _source:'user'", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: {
          experience: [
            {
              company: "New Corp",
              title: "Lead Engineer",
              start_date: "2023-01",
              end_date: null,
              location: null,
              bullets: ["Shipped new features"]
            }
          ]
        }
      })
    })
  );

  assert.equal(res.status, 200, `Unexpected status: ${await res.text()}`);
  assert.ok(savedResume, "saveResumeData must have been called");
  assert.ok(savedResume.experience.length > 0);

  for (const item of savedResume.experience) {
    assert.equal(item._source, "user",
      `experience item must have _source:'user', got '${item._source}'`);
  }
});

test("PATCH /api/resume — sets _sources.experience:'user' at the section level", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  await app.fetch(
    authed("http://localhost/api/resume", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: {
          experience: [{ company: "Corp", title: "Dev", start_date: null, end_date: null, location: null, bullets: [] }]
        }
      })
    })
  );

  assert.equal(savedResume._sources.experience, "user",
    "_sources.experience must be 'user' after PATCH");
});

test("PATCH /api/resume — sets _sources.summary:'user' when summary is provided", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  await app.fetch(
    authed("http://localhost/api/resume", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume: { summary: "Updated professional summary." } })
    })
  );

  assert.equal(savedResume._sources.summary, "user",
    "_sources.summary must be 'user' after PATCH");
  assert.equal(savedResume.summary, "Updated professional summary.");
});

test("PATCH /api/resume — education items receive _source:'user'", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  await app.fetch(
    authed("http://localhost/api/resume", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: {
          education: [{ institution: "MIT", degree: "BS", field: "CS", start_date: null, end_date: null, gpa: null }]
        }
      })
    })
  );

  for (const item of savedResume.education) {
    assert.equal(item._source, "user",
      `education item must have _source:'user', got '${item._source}'`);
  }
  assert.equal(savedResume._sources.education, "user");
});

test("PATCH /api/resume — skills section gets _sources.skills:'user'", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  await app.fetch(
    authed("http://localhost/api/resume", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: {
          skills: { technical: ["React"], languages: ["TypeScript"], tools: ["Docker"] }
        }
      })
    })
  );

  assert.equal(savedResume._sources.skills, "user",
    "_sources.skills must be 'user' after PATCH");
});

test("PATCH /api/resume — certifications items receive _source:'user'", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  await app.fetch(
    authed("http://localhost/api/resume", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: {
          certifications: [{ name: "AWS Dev", issuer: "Amazon", date: "2024-01" }]
        }
      })
    })
  );

  for (const item of savedResume.certifications) {
    assert.equal(item._source, "user",
      `certification item must have _source:'user', got '${item._source}'`);
  }
  assert.equal(savedResume._sources.certifications, "user");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. USER APPROVAL  →  _source: "user_approved"
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/suggestions/:id/approve — appended bullet's parent item receives _source:'user_approved'", async () => {
  const stored = _storedResume();
  readResumeDataFn     = async () => stored;
  readSuggestionsDataFn = async () => _pendingSuggestions();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/suggestions/sug-001/approve", {
      method: "POST"
    })
  );

  assert.equal(res.status, 200, `Unexpected status: ${await res.text()}`);
  assert.ok(savedResume, "saveResumeData must have been called");

  const acmeEntry = savedResume.experience.find((e) => e.company === "Acme Corp");
  assert.ok(acmeEntry, "Acme Corp experience entry must exist");
  assert.equal(acmeEntry._source, "user_approved",
    `experience entry must have _source:'user_approved' after approval, got '${acmeEntry._source}'`);
  assert.ok(acmeEntry.bullets.includes("Deployed microservices to Kubernetes"),
    "approved bullet must have been appended");
});

test("POST /api/resume/suggestions/:id/approve — update_summary sets _sources.summary:'user_approved'", async () => {
  const stored = _storedResume();
  readResumeDataFn = async () => stored;
  readSuggestionsDataFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id: "sug-002",
        type: "work_log_update",
        section: "summary",
        action: "update_summary",
        description: "개요 업데이트",
        detail: "2025-01-15 업무 로그 기반",
        patch: { text: "Experienced engineer with microservices expertise." },
        source: "work_log",
        logDate: "2025-01-15",
        createdAt: new Date().toISOString(),
        status: "pending"
      }
    ]
  });

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/suggestions/sug-002/approve", {
      method: "POST"
    })
  );

  assert.equal(res.status, 200);
  assert.equal(savedResume._sources.summary, "user_approved",
    "_sources.summary must be 'user_approved' after approving an update_summary suggestion");
  assert.equal(savedResume.summary, "Experienced engineer with microservices expertise.");
});

// ─── PATCH /api/resume/candidates/:id (approved) ────────────────────────────

test("PATCH /api/resume/candidates/:id (approved) — appended bullet's parent item receives _source:'user_approved'", async () => {
  const stored = _storedResume();
  readResumeDataFn      = async () => stored;
  readSuggestionsDataFn = async () => _pendingSuggestions();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/candidates/sug-001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" })
    })
  );

  assert.equal(res.status, 200, `Unexpected status: ${await res.text()}`);
  assert.ok(savedResume, "saveResumeData must have been called");

  const acmeEntry = savedResume.experience.find((e) => e.company === "Acme Corp");
  assert.ok(acmeEntry);
  assert.equal(acmeEntry._source, "user_approved",
    `experience entry must have _source:'user_approved' after candidate approval, got '${acmeEntry._source}'`);
});

test("PATCH /api/resume/candidates/:id (discarded) — resume is NOT modified", async () => {
  const stored = _storedResume();
  readResumeDataFn      = async () => stored;
  readSuggestionsDataFn = async () => _pendingSuggestions();

  let saveCallCount = 0;
  saveResumeDataFn = async (doc) => { saveCallCount++; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/candidates/sug-001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "discarded" })
    })
  );

  assert.equal(res.status, 200);
  assert.equal(saveCallCount, 0,
    "saveResumeData must NOT be called when a candidate is discarded");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. DIRECT BULLET OPERATIONS  →  _source: "user"
// ═══════════════════════════════════════════════════════════════════════════════

test("POST /api/resume/section-bullet — parent item receives _source:'user'", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/section-bullet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ section: "experience", itemIndex: 0, bullet: "Automated CI/CD pipeline" })
    })
  );

  assert.equal(res.status, 200, `Unexpected status: ${await res.text()}`);
  assert.ok(savedResume, "saveResumeData must have been called");

  const acmeEntry = savedResume.experience[0];
  assert.equal(acmeEntry._source, "user",
    `experience entry must have _source:'user' after direct bullet add, got '${acmeEntry._source}'`);
  assert.ok(acmeEntry.bullets.includes("Automated CI/CD pipeline"),
    "new bullet must be appended");
});

test("PATCH /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex — parent item receives _source:'user'", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/sections/experience/0/bullets/0", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Wrote highly efficient code" })
    })
  );

  assert.equal(res.status, 200, `Unexpected status: ${await res.text()}`);
  assert.ok(savedResume);

  assert.equal(savedResume.experience[0]._source, "user",
    `experience entry must have _source:'user' after bullet PATCH, got '${savedResume.experience[0]._source}'`);
  assert.equal(savedResume.experience[0].bullets[0], "Wrote highly efficient code",
    "bullet text must have been updated");
});

test("DELETE /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex — parent item receives _source:'user'", async () => {
  readResumeDataFn = async () => _storedResume();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/sections/experience/0/bullets/0", {
      method: "DELETE"
    })
  );

  assert.equal(res.status, 200, `Unexpected status: ${await res.text()}`);
  assert.ok(savedResume);

  assert.equal(savedResume.experience[0]._source, "user",
    `experience entry must have _source:'user' after bullet DELETE, got '${savedResume.experience[0]._source}'`);
  assert.equal(savedResume.experience[0].bullets.length, 1,
    "one bullet must remain after deleting the first of two");
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. SOURCE VALUE INVARIANTS
// ═══════════════════════════════════════════════════════════════════════════════

test("User _source:'user' is preserved across PATCH /api/resume — not overwritten with 'system'", async () => {
  // If the stored resume already has a user-edited item, re-PATCHing that section
  // should keep _source:'user' (not downgrade it).
  const stored = _storedResume();
  stored.experience[0]._source = "user";  // already user-edited
  readResumeDataFn = async () => stored;

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  await app.fetch(
    authed("http://localhost/api/resume", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resume: {
          experience: [
            { company: "Acme Corp", title: "Senior Engineer", start_date: "2022-01", end_date: null, location: null, bullets: [] }
          ]
        }
      })
    })
  );

  // After PATCH, the item _source should be "user" (PATCH always marks as "user")
  assert.equal(savedResume.experience[0]._source, "user",
    "_source must remain 'user' after re-editing a user-edited item");
});

test("_source:'user_approved' is preserved after a second PATCH to a different section", async () => {
  // Editing the summary should NOT touch the experience item's _source.
  const stored = _storedResume();
  stored.experience[0]._source = "user_approved";
  readResumeDataFn = async () => stored;

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/r.json" }; };

  const app = buildApp();
  await app.fetch(
    authed("http://localhost/api/resume", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // Only update summary — not experience
      body: JSON.stringify({ resume: { summary: "New summary." } })
    })
  );

  // experience[0]._source must remain unchanged
  assert.equal(savedResume.experience[0]._source, "user_approved",
    "experience item _source must not be changed when a different section is PATCHed");
});
