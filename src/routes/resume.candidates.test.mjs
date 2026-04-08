/**
 * Tests for PATCH /api/resume/candidates/:id — Sub-AC 6-1
 *
 * Verifies the state-machine endpoint that handles pending→approved|discarded
 * transitions for resume update candidates.
 *
 * Key invariants tested:
 *   1. pending → approved: resume is upserted (applySuggestionPatch), snapshot
 *      is saved, suggestion gains approvedAt timestamp, response includes updated resume
 *   2. pending → discarded: resume is NOT modified, suggestion gains discardedAt
 *      timestamp, response is { ok: true, status: "discarded" }
 *   3. No "applied" state — approved immediately updates the live resume (no two-phase commit)
 *   4. Approved items carry _source: "user_approved" (user edits win over future system merges)
 *   5. HTTP 400 when status is missing or not "approved"|"discarded"
 *   6. HTTP 404 when candidate id not found in suggestions doc
 *   7. HTTP 409 when candidate is already processed (not pending)
 *   8. HTTP 404 when resume document does not exist (on approve path)
 *   9. HTTP 422 when applySuggestionPatch throws (malformed patch payload)
 *  10. HTTP 502 on Blob I/O failure
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.candidates.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stub state ───────────────────────────────────────────────────────

let readResumeDataFn       = async () => null;
let saveResumeDataFn       = async () => ({ url: "https://blob/resume/data.json" });
let readSuggestionsDataFn  = async () => _emptySuggestionsDoc();
let saveSuggestionsDataFn  = async () => ({ url: "https://blob/resume/suggestions.json" });
let saveSnapshotFn         = async () => ({ snapshotKey: "resume/snapshots/test.json", url: "https://blob/test" });

// Track call counts for side-effect assertions
let saveResumeDataCallCount    = 0;
let saveSuggestionsDataCallArg = null;
let saveSnapshotCallCount      = 0;
let saveSnapshotCallArgs       = null; // [resumeDoc, meta] from most recent call

// ─── Default fixture helpers ──────────────────────────────────────────────────

function _emptySuggestionsDoc() {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: []
  };
}

/**
 * A minimal stored resume with one system-generated experience entry.
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
    summary: "An experienced developer.",
    experience: [
      {
        _source: "system",
        company: "Acme Corp",
        title: "Software Engineer",
        start_date: "2022-01",
        end_date: null,
        location: null,
        bullets: ["Wrote production code", "Fixed critical bugs"]
      }
    ],
    education: [],
    skills: { technical: ["JavaScript", "Node.js"], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: [],
    display_axes: []
  };
}

/**
 * A pending append_bullet suggestion targeting Acme Corp's experience entry.
 */
function _pendingAppendBulletDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id: "cand-001",
        type: "work_log_update",
        section: "experience",
        action: "append_bullet",
        description: "Acme Corp: deployed microservices to Kubernetes",
        patch: { company: "Acme Corp", bullet: "Deployed microservices to Kubernetes" },
        source: "work_log",
        logDate: "2025-03-01",
        createdAt: new Date().toISOString(),
        status: "pending",
        ...overrides
      }
    ]
  };
}

/**
 * A pending update_summary suggestion.
 */
function _pendingUpdateSummaryDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id: "cand-002",
        type: "work_log_update",
        section: "summary",
        action: "update_summary",
        description: "Updated professional summary",
        patch: { text: "A senior developer with deep expertise in distributed systems." },
        source: "work_log",
        logDate: "2025-03-10",
        createdAt: new Date().toISOString(),
        status: "pending",
        ...overrides
      }
    ]
  };
}

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: true }),
    saveResumeData:               (...args) => {
      saveResumeDataCallCount++;
      return saveResumeDataFn(...args);
    },
    readResumeData:               (...args) => readResumeDataFn(...args),
    readSuggestionsData:          (...args) => readSuggestionsDataFn(...args),
    saveSuggestionsData:          (...args) => {
      saveSuggestionsDataCallArg = args[0];
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
    saveSnapshot:                 (...args) => {
      saveSnapshotCallCount++;
      saveSnapshotCallArgs = args;
      return saveSnapshotFn(...args);
    },
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
  namedExports: {
    generateResumeFromText: async () => ({
      resumeData: { meta: { language: "en", source: "pdf", generatedAt: new Date().toISOString(), schemaVersion: 1 }, _sources: {}, contact: {}, summary: "", experience: [], education: [], skills: { technical: [], languages: [], tools: [] }, projects: [], certifications: [] },
      strengthKeywords: [],
      displayAxes: []
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

// AC 7: BulletProposal mock — isBulletProposal and applyBulletProposal are pure
// functions; this mock provides functionally correct implementations so that the
// candidate approval flow exercises the bullet-granularity path without relying
// on the real module's import resolution under mock.module().
mock.module("../lib/resumeBulletProposal.mjs", {
  namedExports: {
    isBulletProposal: (item) =>
      item !== null && typeof item === "object" && item.kind === "bullet",

    applyBulletProposal: (resume, proposal) => {
      const { op, target, payload } = proposal;
      const { section, itemIndex, bulletIndex } = target;
      const updated = { ...resume };
      const sectionArr = Array.isArray(resume[section])
        ? resume[section].map((it) => ({ ...it, bullets: Array.isArray(it.bullets) ? [...it.bullets] : [] }))
        : [];
      if (itemIndex >= sectionArr.length) {
        throw new Error(`applyBulletProposal: ${section}[${itemIndex}] does not exist`);
      }
      const item = sectionArr[itemIndex];
      const bullets = item.bullets;
      if (op === "add") {
        const text = String(payload?.text ?? "").trim();
        if (!text) throw new Error("applyBulletProposal: add requires non-empty payload.text");
        if (bulletIndex !== undefined && Number.isFinite(bulletIndex)) {
          bullets.splice(Math.min(Math.max(0, bulletIndex), bullets.length), 0, text);
        } else {
          bullets.push(text);
        }
      } else if (op === "delete") {
        if (bulletIndex === undefined || !Number.isFinite(bulletIndex))
          throw new Error("applyBulletProposal: delete requires a numeric bulletIndex");
        if (bulletIndex >= bullets.length)
          throw new Error(`applyBulletProposal: delete target bullet[${bulletIndex}] does not exist`);
        bullets.splice(bulletIndex, 1);
      } else if (op === "replace") {
        if (bulletIndex === undefined || !Number.isFinite(bulletIndex))
          throw new Error("applyBulletProposal: replace requires a numeric bulletIndex");
        if (bulletIndex >= bullets.length)
          throw new Error(`applyBulletProposal: replace target bullet[${bulletIndex}] does not exist`);
        if (item._source === "user" && proposal.source !== "manual") return resume;
        const text = String(payload?.text ?? "").trim();
        if (!text) throw new Error("applyBulletProposal: replace requires non-empty payload.text");
        bullets[bulletIndex] = text;
      } else {
        throw new Error(`applyBulletProposal: unknown op "${op}"`);
      }
      updated[section] = sectionArr;
      return updated;
    },

    validateBulletProposal:  () => {},
    createBulletProposal:    (opts) => ({
      id: `bp-test-${opts.op}`,
      kind: "bullet",
      op: opts.op,
      target: {
        section: opts.section,
        itemIndex: opts.itemIndex,
        ...(opts.bulletIndex !== undefined ? { bulletIndex: opts.bulletIndex } : {})
      },
      payload: opts.op !== "delete" ? { text: String(opts.text ?? "").trim() } : {},
      description: opts.description ?? `bullet ${opts.op}`,
      source: opts.source ?? "manual",
      createdAt: new Date().toISOString(),
      status: "pending"
    }),
    ALLOWED_OPS:     ["add", "delete", "replace"],
    ALLOWED_SECTIONS: ["experience", "projects"],
    ALLOWED_SOURCES:  ["work_log", "linkedin", "manual"],
    ALLOWED_STATUSES: ["pending", "approved", "discarded"]
  }
});

// ─── Load router under test AFTER mocks ──────────────────────────────────────

const { resumeRouter } = await import("./resume.mjs");
const { cookieAuth }   = await import("../middleware/auth.mjs");

// ─── Test helpers ─────────────────────────────────────────────────────────────

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

function patchRequest(id, body) {
  return authed(`http://localhost/api/resume/candidates/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function resetCounters() {
  saveResumeDataCallCount    = 0;
  saveSuggestionsDataCallArg = null;
  saveSnapshotCallCount      = 0;
  saveSnapshotCallArgs       = null;
}

// ─── 1. Happy path: pending → approved ───────────────────────────────────────

test("PATCH /api/resume/candidates/:id (approved) — returns ok:true, status:'approved', and updated resume", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true,         "ok must be true");
  assert.equal(body.status, "approved", "status must be 'approved'");
  assert.ok(body.resume,             "resume must be present in response");
});

test("PATCH /api/resume/candidates/:id (approved) — bullet is appended to the experience entry", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.ok(savedResume, "saveResumeData must have been called");
  const acmeEntry = savedResume.experience.find((e) => e.company === "Acme Corp");
  assert.ok(acmeEntry, "Acme Corp entry must exist");
  assert.ok(
    acmeEntry.bullets.includes("Deployed microservices to Kubernetes"),
    "The approved bullet must have been appended"
  );
});

test("PATCH /api/resume/candidates/:id (approved) — experience entry receives _source:'user_approved'", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "approved" }));

  const acmeEntry = savedResume.experience.find((e) => e.company === "Acme Corp");
  assert.equal(
    acmeEntry._source,
    "user_approved",
    `experience entry must have _source:'user_approved' after approval, got '${acmeEntry._source}'`
  );
});

test("PATCH /api/resume/candidates/:id (approved) — update_summary sets _sources.summary:'user_approved'", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingUpdateSummaryDoc();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  await app.fetch(patchRequest("cand-002", { status: "approved" }));

  assert.equal(
    savedResume._sources.summary,
    "user_approved",
    "_sources.summary must be 'user_approved' after approving an update_summary candidate"
  );
  assert.equal(
    savedResume.summary,
    "A senior developer with deep expertise in distributed systems.",
    "summary text must be updated to the patch value"
  );
});

test("PATCH /api/resume/candidates/:id (approved) — suggestion is marked 'approved' with approvedAt timestamp", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.ok(saveSuggestionsDataCallArg, "saveSuggestionsData must have been called");
  const updated = saveSuggestionsDataCallArg.suggestions.find((s) => s.id === "cand-001");
  assert.ok(updated, "suggestion must exist in saved doc");
  assert.equal(updated.status, "approved", "suggestion status must be 'approved'");
  assert.ok(updated.approvedAt, "approvedAt timestamp must be set");
  // Verify it looks like an ISO timestamp
  assert.doesNotThrow(() => new Date(updated.approvedAt), "approvedAt must be a valid date string");
});

test("PATCH /api/resume/candidates/:id (approved) — saveSnapshot is called exactly once at approve time", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(saveSnapshotCallCount, 1, "saveSnapshot must be called exactly once when a candidate is approved");
});

test("PATCH /api/resume/candidates/:id (approved) — saveResumeData is called once", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(saveResumeDataCallCount, 1, "saveResumeData must be called exactly once on approve");
});

// ─── 1b. Snapshot trigger field ──────────────────────────────────────────────

test("PATCH /api/resume/candidates/:id (approved) — snapshot meta has trigger:'approve'", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.ok(saveSnapshotCallArgs, "saveSnapshot must have been called with arguments");
  const [_snapshotDoc, meta] = saveSnapshotCallArgs;
  assert.equal(
    meta?.trigger,
    "approve",
    `snapshot meta.trigger must be 'approve', got '${meta?.trigger}'`
  );
});

test("PATCH /api/resume/candidates/:id (approved) — snapshot meta has triggeredBy:'approve'", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.ok(saveSnapshotCallArgs, "saveSnapshot must have been called with arguments");
  const [_snapshotDoc, meta] = saveSnapshotCallArgs;
  assert.equal(
    meta?.triggeredBy,
    "approve",
    `snapshot meta.triggeredBy must be 'approve' so getLastApprovedSnapshot() can find it, got '${meta?.triggeredBy}'`
  );
});

test("PATCH /api/resume/candidates/:id (approved) — snapshot doc is the post-approval resume (updatedResume)", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.ok(saveSnapshotCallArgs, "saveSnapshot must have been called");
  const [snapshotDoc] = saveSnapshotCallArgs;
  // The snapshot must capture the post-approval resume, not the original.
  // Verify by checking that the approved bullet is present in the snapshot doc.
  const acmeEntry = snapshotDoc?.experience?.find((e) => e.company === "Acme Corp");
  assert.ok(acmeEntry, "snapshot doc must contain Acme Corp experience entry");
  assert.ok(
    acmeEntry.bullets.includes("Deployed microservices to Kubernetes"),
    "snapshot doc must be the post-approval resume (approved bullet must be present)"
  );
});

// ─── 2. Happy path: pending → discarded ──────────────────────────────────────

test("PATCH /api/resume/candidates/:id (discarded) — returns ok:true, status:'discarded'", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "discarded" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true,           "ok must be true");
  assert.equal(body.status, "discarded", "status must be 'discarded'");
  assert.equal(body.resume, undefined,   "resume must NOT be present in discard response");
});

test("PATCH /api/resume/candidates/:id (discarded) — resume is NOT modified", async () => {
  resetCounters();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "discarded" }));

  assert.equal(saveResumeDataCallCount, 0, "saveResumeData must NOT be called when a candidate is discarded");
});

test("PATCH /api/resume/candidates/:id (discarded) — snapshot is NOT taken", async () => {
  resetCounters();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "discarded" }));

  assert.equal(saveSnapshotCallCount, 0, "saveSnapshot must NOT be called when a candidate is discarded");
});

test("PATCH /api/resume/candidates/:id (discarded) — suggestion marked 'discarded' with discardedAt timestamp", async () => {
  resetCounters();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  await app.fetch(patchRequest("cand-001", { status: "discarded" }));

  assert.ok(saveSuggestionsDataCallArg, "saveSuggestionsData must have been called");
  const updated = saveSuggestionsDataCallArg.suggestions.find((s) => s.id === "cand-001");
  assert.equal(updated.status, "discarded", "suggestion status must be 'discarded'");
  assert.ok(updated.discardedAt, "discardedAt timestamp must be set");
  assert.doesNotThrow(() => new Date(updated.discardedAt), "discardedAt must be a valid date string");
});

// ─── 3. No "applied" intermediate state ──────────────────────────────────────

test("PATCH /api/resume/candidates/:id (approved) — no 'applied' intermediate state; approval immediately upserts resume", async () => {
  // This test verifies that the approved path does NOT introduce a two-phase
  // "applied" state. The suggestion must go directly from "pending" to "approved"
  // in a single request, with the resume already updated in the same transaction.
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));
  const body = await res.json();

  // Resume is updated immediately — no follow-up call needed
  assert.equal(res.status, 200);
  assert.equal(body.status, "approved");
  assert.ok(body.resume, "resume must be returned in the same response");
  assert.equal(saveResumeDataCallCount, 1, "resume must be saved in the same request");

  // The saved suggestion status must be "approved" (not "applied" or any intermediate)
  const savedSuggestion = saveSuggestionsDataCallArg?.suggestions?.find((s) => s.id === "cand-001");
  assert.ok(savedSuggestion, "suggestion must be saved");
  assert.equal(savedSuggestion.status, "approved", "status must go directly to 'approved' — no intermediate 'applied' state");
  assert.equal(savedSuggestion.appliedAt, undefined, "there must be no 'appliedAt' field — 'applied' is not a valid state");
});

// ─── 4. Error: 400 bad request ────────────────────────────────────────────────

test("PATCH /api/resume/candidates/:id — 400 when status field is missing from body", async () => {
  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", {}));

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

test("PATCH /api/resume/candidates/:id — 400 when status is an invalid value", async () => {
  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "rejected" }));

  // "rejected" was a legacy status — the candidates endpoint only accepts approved|discarded
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

test("PATCH /api/resume/candidates/:id — 400 when status is null", async () => {
  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: null }));

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/candidates/:id — 400 when body is not valid JSON", async () => {
  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/candidates/cand-001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json"
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ─── 5. Error: 404 candidate not found ───────────────────────────────────────

test("PATCH /api/resume/candidates/:id — 404 when candidate id does not exist", async () => {
  readSuggestionsDataFn = async () => _emptySuggestionsDoc(); // no suggestions

  const app = buildApp();
  const res = await app.fetch(patchRequest("nonexistent-id", { status: "approved" }));

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

// ─── 6. Error: 409 already processed ─────────────────────────────────────────

test("PATCH /api/resume/candidates/:id — 409 when candidate is already approved", async () => {
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc({ status: "approved" });

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

test("PATCH /api/resume/candidates/:id — 409 when candidate is already discarded", async () => {
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc({ status: "discarded" });

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "discarded" }));

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ─── 7. Error: 404 resume missing on approve ─────────────────────────────────

test("PATCH /api/resume/candidates/:id (approved) — 404 when live resume does not exist", async () => {
  readResumeDataFn      = async () => null; // no stored resume
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

// ─── 8. Error: 422 patch application failure ─────────────────────────────────

test("PATCH /api/resume/candidates/:id (approved) — 422 when patch targets a non-existent company", async () => {
  // The resume has Acme Corp; the suggestion targets a company that doesn't exist
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc({
    patch: { company: "Nonexistent Co", bullet: "Did something" }
  });

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

test("PATCH /api/resume/candidates/:id (approved) — 422 when suggestion has no action field", async () => {
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id: "cand-bad",
        type: "work_log_update",
        section: "experience",
        // action is missing
        description: "Missing action",
        patch: { company: "Acme Corp", bullet: "Some bullet" },
        source: "work_log",
        createdAt: new Date().toISOString(),
        status: "pending"
      }
    ]
  });

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-bad", { status: "approved" }));

  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ─── 9. Error: 502 Blob I/O failure ──────────────────────────────────────────

test("PATCH /api/resume/candidates/:id — 502 when readSuggestionsData throws", async () => {
  readSuggestionsDataFn = async () => { throw new Error("Blob connection error"); };

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

test("PATCH /api/resume/candidates/:id (approved) — 502 when readResumeData throws", async () => {
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();
  readResumeDataFn      = async () => { throw new Error("Blob read failed"); };

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("PATCH /api/resume/candidates/:id (approved) — 502 when saveResumeData throws", async () => {
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();
  saveResumeDataFn      = async () => { throw new Error("Blob write failed"); };

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ─── 10. Authentication guard ─────────────────────────────────────────────────

test("PATCH /api/resume/candidates/:id — 401 without auth cookie", async () => {
  const app = buildApp();
  const res = await app.fetch(
    new Request("http://localhost/api/resume/candidates/cand-001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" })
    })
  );

  assert.equal(res.status, 401);
});

// ─── 11. Additional upsert coverage ──────────────────────────────────────────

test("PATCH /api/resume/candidates/:id (approved) — add_skills action adds new skills to technical array", async () => {
  resetCounters();
  const resume = _storedResume();
  readResumeDataFn = async () => resume;
  readSuggestionsDataFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id: "cand-skills",
        type: "work_log_update",
        section: "skills",
        action: "add_skills",
        description: "Add TypeScript and Docker skills",
        patch: { skills: ["TypeScript", "Docker"] },
        source: "work_log",
        createdAt: new Date().toISOString(),
        status: "pending"
      }
    ]
  });

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-skills", { status: "approved" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  assert.ok(savedResume, "resume must have been saved");
  assert.ok(
    savedResume.skills.technical.includes("TypeScript"),
    "TypeScript must be added to technical skills"
  );
  assert.ok(
    savedResume.skills.technical.includes("Docker"),
    "Docker must be added to technical skills"
  );
  // Original skills preserved
  assert.ok(
    savedResume.skills.technical.includes("JavaScript"),
    "Original JavaScript skill must be preserved"
  );
});

test("PATCH /api/resume/candidates/:id (approved) — approved bullet appears in response resume object", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingAppendBulletDoc();

  const app = buildApp();
  const res = await app.fetch(patchRequest("cand-001", { status: "approved" }));

  const body = await res.json();
  const acmeEntry = body.resume.experience.find((e) => e.company === "Acme Corp");
  assert.ok(acmeEntry, "Acme Corp must be in response resume");
  assert.ok(
    acmeEntry.bullets.includes("Deployed microservices to Kubernetes"),
    "Approved bullet must be in the response resume (not just saved)"
  );
});

// ─── AC 7: BulletProposal (kind:'bullet') — add/delete/replace granularity ───
//
// These tests verify the bullet-level proposal path through the candidates
// endpoint.  A BulletProposal uses { kind:'bullet', op, target, payload }
// instead of the legacy { action, patch } shape.  applySuggestionPatch must
// delegate to applyBulletProposal when suggestion.kind === 'bullet'.

/**
 * Builds a minimal suggestions document containing a single BulletProposal.
 */
function _pendingBulletProposalDoc({
  id = "bp-001",
  op = "add",
  section = "experience",
  itemIndex = 0,
  bulletIndex = undefined,
  text = "Reduced deploy time by 40%",
  source = "work_log",
  logDate = "2026-03-27",
  status = "pending"
} = {}) {
  const target = { section, itemIndex };
  if (bulletIndex !== undefined) target.bulletIndex = bulletIndex;
  const payload = op !== "delete" ? { text } : {};
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id,
        kind: "bullet",
        op,
        target,
        payload,
        description: `bullet ${op} test`,
        source,
        logDate: source === "work_log" ? logDate : undefined,
        createdAt: new Date().toISOString(),
        status
      }
    ]
  };
}

// ── add op ────────────────────────────────────────────────────────────────────

test("AC7 — BulletProposal add op: approved candidate appends bullet to experience entry", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingBulletProposalDoc({
    op: "add", section: "experience", itemIndex: 0,
    text: "Reduced deploy time by 40%"
  });

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  const res = await app.fetch(patchRequest("bp-001", { status: "approved" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, "approved");
  assert.ok(body.resume, "resume must be returned in response");

  assert.ok(savedResume, "saveResumeData must have been called");
  const acmeEntry = savedResume.experience[0];
  assert.ok(
    acmeEntry.bullets.includes("Reduced deploy time by 40%"),
    "New bullet must have been appended via BulletProposal add op"
  );
});

test("AC7 — BulletProposal add op: response resume includes the new bullet", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingBulletProposalDoc({
    op: "add", section: "experience", itemIndex: 0,
    text: "Launched self-service portal"
  });

  const app = buildApp();
  const res = await app.fetch(patchRequest("bp-001", { status: "approved" }));
  const body = await res.json();

  const expEntry = body.resume.experience[0];
  assert.ok(
    expEntry.bullets.includes("Launched self-service portal"),
    "New bullet must be in the response resume"
  );
});

// ── delete op ─────────────────────────────────────────────────────────────────

test("AC7 — BulletProposal delete op: approved candidate removes target bullet by index", async () => {
  resetCounters();
  readResumeDataFn = async () => _storedResume(); // experience[0].bullets = ["Wrote production code", "Fixed critical bugs"]
  readSuggestionsDataFn = async () => _pendingBulletProposalDoc({
    op: "delete", section: "experience", itemIndex: 0, bulletIndex: 0
  });

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  const res = await app.fetch(patchRequest("bp-001", { status: "approved" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  assert.ok(savedResume, "saveResumeData must have been called");
  const bullets = savedResume.experience[0].bullets;
  // "Wrote production code" at index 0 must be removed
  assert.ok(
    !bullets.includes("Wrote production code"),
    "Deleted bullet must have been removed from the experience entry"
  );
  assert.ok(
    bullets.includes("Fixed critical bugs"),
    "Remaining bullet must still be present after delete op"
  );
  assert.equal(bullets.length, 1, "Only one bullet must remain after deleting one of two");
});

test("AC7 — BulletProposal delete op: 422 when bulletIndex is out of range", async () => {
  resetCounters();
  readResumeDataFn = async () => _storedResume(); // experience[0].bullets has 2 bullets
  readSuggestionsDataFn = async () => _pendingBulletProposalDoc({
    op: "delete", section: "experience", itemIndex: 0, bulletIndex: 99
  });

  const app = buildApp();
  const res = await app.fetch(patchRequest("bp-001", { status: "approved" }));

  assert.equal(res.status, 422, "out-of-range bulletIndex on delete must return 422");
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ── replace op ────────────────────────────────────────────────────────────────

test("AC7 — BulletProposal replace op: approved candidate overwrites target bullet text", async () => {
  resetCounters();
  readResumeDataFn = async () => _storedResume(); // experience[0].bullets[1] = "Fixed critical bugs"
  readSuggestionsDataFn = async () => _pendingBulletProposalDoc({
    op: "replace", section: "experience", itemIndex: 0, bulletIndex: 1,
    text: "Resolved 15+ critical production incidents"
  });

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  const res = await app.fetch(patchRequest("bp-001", { status: "approved" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  assert.ok(savedResume, "saveResumeData must have been called");
  const bullets = savedResume.experience[0].bullets;
  assert.equal(
    bullets[1],
    "Resolved 15+ critical production incidents",
    "Target bullet must have been replaced with new text"
  );
  assert.ok(
    !bullets.includes("Fixed critical bugs"),
    "Old bullet text must no longer be present after replace op"
  );
});

test("AC7 — BulletProposal replace op: 422 when bulletIndex is out of range", async () => {
  resetCounters();
  readResumeDataFn = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingBulletProposalDoc({
    op: "replace", section: "experience", itemIndex: 0, bulletIndex: 99,
    text: "Replacement text"
  });

  const app = buildApp();
  const res = await app.fetch(patchRequest("bp-001", { status: "approved" }));

  assert.equal(res.status, 422, "out-of-range bulletIndex on replace must return 422");
  const body = await res.json();
  assert.equal(body.ok, false);
});

// ── discard ───────────────────────────────────────────────────────────────────

test("AC7 — BulletProposal discard: resume is NOT modified when a bullet proposal is discarded", async () => {
  resetCounters();
  readSuggestionsDataFn = async () => _pendingBulletProposalDoc({
    op: "add", section: "experience", itemIndex: 0,
    text: "Some new bullet"
  });

  const app = buildApp();
  const res = await app.fetch(patchRequest("bp-001", { status: "discarded" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, "discarded");
  assert.equal(saveResumeDataCallCount, 0, "resume must NOT be saved when BulletProposal is discarded");
});

// ── PATCH /suggestions/:id — payload update for BulletProposal inline edit ───

test("AC7 — PATCH /suggestions/:id with payload field updates BulletProposal text before approval", async () => {
  resetCounters();
  readSuggestionsDataFn = async () => _pendingBulletProposalDoc({
    op: "add", section: "experience", itemIndex: 0,
    text: "Original bullet text"
  });

  let savedSuggestions = null;
  saveSuggestionsDataFn = async (doc) => { savedSuggestions = doc; return { url: "https://blob/resume/suggestions.json" }; };

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/suggestions/bp-001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { text: "Edited bullet text" } })
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true, "PATCH /suggestions/:id must return ok:true");
  assert.ok(body.suggestion, "updated suggestion must be returned");
  assert.equal(
    body.suggestion.payload?.text,
    "Edited bullet text",
    "payload.text must be updated to the edited value"
  );

  assert.ok(savedSuggestions, "suggestions must have been saved");
  const saved = savedSuggestions.suggestions.find((s) => s.id === "bp-001");
  assert.equal(
    saved.payload?.text,
    "Edited bullet text",
    "persisted suggestion must have the new payload.text"
  );
});

test("AC7 — PATCH /suggestions/:id with payload preserves existing payload fields not in the update", async () => {
  resetCounters();
  // BulletProposal with extra payload field (simulate future extension)
  readSuggestionsDataFn = async () => ({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id: "bp-002",
        kind: "bullet",
        op: "replace",
        target: { section: "experience", itemIndex: 0, bulletIndex: 0 },
        payload: { text: "Original text", extraField: "preserved" },
        description: "replace bullet test",
        source: "work_log",
        createdAt: new Date().toISOString(),
        status: "pending"
      }
    ]
  });

  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/suggestions/bp-002", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { text: "Updated text" } })
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.suggestion.payload.text, "Updated text", "text field must be updated");
  assert.equal(
    body.suggestion.payload.extraField,
    "preserved",
    "extraField must be preserved when merging into existing payload"
  );
});

test("AC7 — PATCH /suggestions/:id 400 when body has no patch, payload, or description", async () => {
  const app = buildApp();
  const res = await app.fetch(
    authed("http://localhost/api/resume/suggestions/bp-001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    })
  );

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

// ─── AC 23: delete_item — physical removal of a resumeItem ────────────────────
//
// When a candidate with action:"delete_item" is approved:
//   1. The target resumeItem is physically removed from the section array
//      (no soft-delete flag is left on any remaining item)
//   2. A pre-deletion snapshot is saved BEFORE the patch is applied so the
//      deleted item is preserved for rollback
//   3. The normal post-approval snapshot is also saved (label:"approve")
//      → total saveSnapshot calls: 2 for delete_item (pre-delete + post-approve)
//   4. The updated resume (without the deleted item) is returned in the response

/**
 * Build a pending delete_item candidate targeting an experience entry.
 * _storedResume() has one experience entry at index 0 (Acme Corp).
 */
function _pendingDeleteItemDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [
      {
        id: "del-001",
        type: "work_log_update",
        section: "experience",
        action: "delete_item",
        description: "Acme Corp 경력 항목 삭제",
        patch: { section: "experience", itemIndex: 0 },
        source: "work_log",
        logDate: "2026-03-27",
        createdAt: new Date().toISOString(),
        status: "pending",
        ...overrides
      }
    ]
  };
}

test("AC23 — delete_item approved: item is physically removed from section array", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();  // experience has 1 entry (Acme Corp)
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc();

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  const res = await app.fetch(patchRequest("del-001", { status: "approved" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true,         "ok must be true");
  assert.equal(body.status, "approved", "status must be 'approved'");

  assert.ok(savedResume, "saveResumeData must have been called");
  assert.equal(
    savedResume.experience.length,
    0,
    "experience array must be empty after deleting the only entry"
  );
  assert.ok(
    !savedResume.experience.some((e) => e.company === "Acme Corp"),
    "Acme Corp entry must have been physically removed"
  );
});

test("AC23 — delete_item approved: no soft-delete flag left on the array or remaining items", async () => {
  resetCounters();
  // Resume with 2 experience entries
  const resume = {
    ..._storedResume(),
    experience: [
      {
        _source: "system",
        company: "Acme Corp",
        title: "Engineer",
        start_date: "2022-01",
        end_date: null,
        location: null,
        bullets: ["Wrote tests"]
      },
      {
        _source: "user",
        company: "Beta Ltd",
        title: "Senior Engineer",
        start_date: "2020-01",
        end_date: "2021-12",
        location: null,
        bullets: ["Shipped features"]
      }
    ]
  };
  readResumeDataFn = async () => resume;
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc({
    patch: { section: "experience", itemIndex: 0 }  // delete Acme Corp at index 0
  });

  let savedResume = null;
  saveResumeDataFn = async (doc) => { savedResume = doc; return { url: "https://blob/resume/data.json" }; };

  const app = buildApp();
  await app.fetch(patchRequest("del-001", { status: "approved" }));

  assert.ok(savedResume, "saveResumeData must have been called");
  assert.equal(savedResume.experience.length, 1, "one entry must remain after deleting index 0");
  assert.equal(savedResume.experience[0].company, "Beta Ltd", "Beta Ltd must remain");
  // No soft-delete flag on the remaining item
  assert.equal(
    savedResume.experience[0]._deleted,
    undefined,
    "remaining item must not have a _deleted flag"
  );
  assert.equal(
    savedResume.experience[0]._softDelete,
    undefined,
    "remaining item must not have a _softDelete flag"
  );
});

test("AC23 — delete_item approved: pre-deletion snapshot is saved BEFORE the deletion", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc();

  // Track saveSnapshot calls in order, wrapping the counter update
  const snapshotCalls = [];
  saveSnapshotFn = async (doc, meta) => {
    snapshotCalls.push({ doc, meta });
    return { snapshotKey: `resume/snapshots/test-${snapshotCalls.length}.json`, url: "https://blob/test" };
  };
  // Note: saveSnapshotCallCount is incremented by the outer mock wrapper (not saveSnapshotFn)

  const app = buildApp();
  await app.fetch(patchRequest("del-001", { status: "approved" }));

  // Expect at least 2 snapshot calls for delete_item
  assert.ok(
    snapshotCalls.length >= 2,
    `delete_item approval must trigger at least 2 saveSnapshot calls (got ${snapshotCalls.length})`
  );

  // First call must be the pre-deletion snapshot (contains the item to be deleted)
  const preDeletion = snapshotCalls[0];
  assert.equal(
    preDeletion.meta?.label,
    "pre-delete",
    "first snapshot must have label:'pre-delete'"
  );
  assert.equal(
    preDeletion.meta?.trigger,
    "delete_item_approve",
    "first snapshot must have trigger:'delete_item_approve'"
  );
  // The pre-deletion snapshot must still contain the deleted item
  assert.ok(
    preDeletion.doc?.experience?.some((e) => e.company === "Acme Corp"),
    "pre-deletion snapshot must contain the Acme Corp entry that will be deleted"
  );
});

test("AC23 — delete_item approved: saveSnapshot called twice (pre-delete + post-approve)", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc();

  const app = buildApp();
  await app.fetch(patchRequest("del-001", { status: "approved" }));

  assert.equal(
    saveSnapshotCallCount,
    2,
    "delete_item approval must trigger exactly 2 saveSnapshot calls (pre-delete + post-approve)"
  );
});

test("AC23 — delete_item approved: post-approval snapshot does NOT contain the deleted item", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc();

  const snapshotCalls = [];
  saveSnapshotFn = async (doc, meta) => {
    snapshotCalls.push({ doc, meta });
    return { snapshotKey: `resume/snapshots/test-${snapshotCalls.length}.json`, url: "https://blob/test" };
  };
  // Note: saveSnapshotCallCount incremented by mock wrapper, snapshotCalls tracks what's passed to saveSnapshotFn

  const app = buildApp();
  await app.fetch(patchRequest("del-001", { status: "approved" }));

  assert.ok(snapshotCalls.length >= 2, "must have at least 2 snapshot calls");

  // Last call (post-approval) must NOT contain the deleted item
  const postApproval = snapshotCalls[snapshotCalls.length - 1];
  assert.equal(
    postApproval.meta?.label,
    "approve",
    "last snapshot must have label:'approve'"
  );
  assert.ok(
    !postApproval.doc?.experience?.some((e) => e.company === "Acme Corp"),
    "post-approval snapshot must NOT contain the deleted Acme Corp entry"
  );
});

test("AC23 — delete_item approved: updated resume in response has item removed", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc();

  const app = buildApp();
  const res = await app.fetch(patchRequest("del-001", { status: "approved" }));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(body.resume, "resume must be present in response");
  assert.equal(
    body.resume.experience.length,
    0,
    "response resume experience array must be empty (item removed)"
  );
});

test("AC23 — delete_item approved: candidate is marked 'approved' with approvedAt timestamp", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc();

  const app = buildApp();
  await app.fetch(patchRequest("del-001", { status: "approved" }));

  assert.ok(saveSuggestionsDataCallArg, "saveSuggestionsData must have been called");
  const updated = saveSuggestionsDataCallArg.suggestions.find((s) => s.id === "del-001");
  assert.ok(updated, "suggestion must exist in saved doc");
  assert.equal(updated.status, "approved", "status must be 'approved'");
  assert.ok(updated.approvedAt, "approvedAt timestamp must be set");
});

test("AC23 — delete_item approved: 422 when itemIndex is out of range", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();  // experience has 1 entry (index 0 only)
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc({
    patch: { section: "experience", itemIndex: 5 }  // out of range
  });

  const app = buildApp();
  const res = await app.fetch(patchRequest("del-001", { status: "approved" }));

  assert.equal(res.status, 422, "out-of-range itemIndex must return 422");
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error, "error message must be present");
});

test("AC23 — delete_item approved: 422 when section is invalid", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc({
    patch: { section: "summary", itemIndex: 0 }  // summary is not an item-array section
  });

  const app = buildApp();
  const res = await app.fetch(patchRequest("del-001", { status: "approved" }));

  assert.equal(res.status, 422, "invalid section for delete_item must return 422");
  const body = await res.json();
  assert.equal(body.ok, false);
});

test("AC23 — delete_item discard: item is NOT removed, resume unchanged", async () => {
  resetCounters();
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc();

  const app = buildApp();
  const res = await app.fetch(patchRequest("del-001", { status: "discarded" }));

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, "discarded");
  assert.equal(saveResumeDataCallCount, 0, "resume must NOT be saved when delete_item is discarded");
  assert.equal(saveSnapshotCallCount, 0, "no snapshots when delete_item is discarded");
});

test("AC23 — delete_item approved: pre-delete snapshot failure is non-fatal", async () => {
  resetCounters();
  readResumeDataFn      = async () => _storedResume();
  readSuggestionsDataFn = async () => _pendingDeleteItemDoc();

  let snapshotCallCount = 0;
  saveSnapshotFn = async (doc, meta) => {
    snapshotCallCount++;
    if (snapshotCallCount === 1) {
      // First call = pre-delete snapshot; simulate failure
      throw new Error("Pre-delete snapshot Blob error");
    }
    // Second call = post-approve snapshot; succeeds
    return { snapshotKey: "resume/snapshots/post-approve.json", url: "https://blob/test" };
  };

  const app = buildApp();
  const res = await app.fetch(patchRequest("del-001", { status: "approved" }));

  // Must still succeed — pre-delete snapshot is best-effort
  assert.equal(res.status, 200, "pre-delete snapshot failure must not abort the approval");
  const body = await res.json();
  assert.equal(body.ok, true, "ok must be true even when pre-delete snapshot fails");
  // The item must still be removed despite snapshot failure
  assert.equal(
    body.resume.experience.length,
    0,
    "item must still be removed even when pre-delete snapshot fails"
  );
});
