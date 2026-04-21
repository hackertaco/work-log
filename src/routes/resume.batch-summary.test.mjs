import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

let latestBatchSummaryFn = async () => null;
let readBatchSummaryFn = async () => null;
let listBatchSummariesFn = async () => [];
let draftStateFn = () => ({ status: "idle", taskId: null, triggeredBy: null });

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: true }),
    saveResumeData:               async () => ({ url: "https://blob/resume/data.json" }),
    readResumeData:               async () => null,
    readSuggestionsData:          async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] }),
    saveSuggestionsData:          async () => ({ url: "https://blob/resume/suggestions.json" }),
    saveBatchSummary:             async () => ({ url: "https://blob/resume/batch-summaries/2026-04-21.json" }),
    readBatchSummary:             (...args) => readBatchSummaryFn(...args),
    readLatestBatchSummary:       (...args) => latestBatchSummaryFn(...args),
    listBatchSummaries:           (...args) => listBatchSummariesFn(...args),
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
    saveChatDraft:                async () => ({ url: "https://blob/resume/chat-draft.json" }),
    readChatDraft:                async () => null,
    saveChatDraftContext:         async () => ({ url: "https://blob/resume/chat-draft-context.json" }),
    readChatDraftContext:         async () => null,
    saveSession:                  async () => ({ url: "blob://session" }),
    readSession:                  async () => null,
    deleteSession:                async () => {},
  }
});

mock.module("../lib/draftGenerationState.mjs", {
  namedExports: {
    getDraftGenerationState: (...args) => draftStateFn(...args),
    markDraftGenerationPending: () => "draft-task",
    markDraftGenerationCompleted: () => {},
    markDraftGenerationFailed: () => {},
    updateDraftGenerationProgress: () => {},
    isDraftGenerationInProgress: () => false,
    resetDraftGenerationState: () => {},
  }
});

mock.module("../lib/resumeLlm.mjs", { namedExports: { extractPdfText: async () => "pdf text" } });
mock.module("../lib/resumeBootstrap.mjs", { namedExports: { generateResumeFromText: async () => ({ contact: { name: "Test" } }) } });
mock.module("../lib/resumeReconstruction.mjs", {
  namedExports: {
    gatherWorkLogBullets: async () => [],
    fullReconstructExtractCache: async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] }),
    generateSectionBridges: async () => [],
    validateResumeCoherence: async () => ({ overallScore: 1, grade: "A", structuralFlow: 1, redundancy: 1, tonalConsistency: 1, issues: [], autoFixes: [] }),
    runNarrativeThreadingPipeline: async () => ({ strengths: [], axes: [], sectionBridges: [], extractionResults: [], threading: { totalAnnotations: 0, groundedRatio: 0, strengthCoverage: {}, axisCoverage: {} }, groundingReport: {} }),
    reconstructResumeFromSources: async () => ({ contact: { name: "Test" } }),
    mergeWithUserEdits: (r) => r,
    isResumeStale: () => false,
  }
});
mock.module("../lib/resumeGapAnalysis.mjs", { namedExports: { analyzeGaps: () => ({ gaps: [], summary: { total: 0 } }) } });
mock.module("../lib/resumeSuggestions.mjs", { namedExports: { gapItemsToSuggestions: () => [] } });
mock.module("../lib/resumeDailyBullets.mjs", {
  namedExports: {
    buildDailyBulletsDocument: async () => ({ bullets: [] }),
    mergeDailyBulletsDocuments: (a) => a,
    promoteBullet: (doc) => doc,
    dismissBullet: (doc) => doc,
    editBullet: (doc) => doc,
  }
});
mock.module("../lib/resumeWorkLogExtract.mjs", { namedExports: { extractResumeUpdatesFromWorkLog: async () => ({}) } });
mock.module("../lib/resumeWorkLogMerge.mjs", { namedExports: { mergeWorkLogIntoResume: () => ({}) } });
mock.module("../lib/resumeDiff.mjs", { namedExports: { diffResume: () => ({ isEmpty: true }) } });
mock.module("../lib/resumeDiffToSuggestions.mjs", { namedExports: { diffToSuggestions: () => [] } });
mock.module("../lib/resumeDeltaRatio.mjs", {
  namedExports: {
    computeDeltaRatio: () => 0,
    exceedsDeltaThreshold: () => false,
    DELTA_THRESHOLD: 0.03,
  }
});
mock.module("../lib/resumeAxisClustering.mjs", { namedExports: { generateDisplayAxes: async () => [] } });
mock.module("../lib/resumeRecluster.mjs", {
  namedExports: {
    reclusterPipeline: async () => ({ axes: [], triggered: false, ratio: 0, totalKeywords: 0, unclassifiedCount: 0 }),
    computeUnclassifiedRatio: () => 0,
    _adaptWorkLogEntries: (e) => e,
    DEFAULT_RECLUSTER_THRESHOLD: 0.3,
    mergeAxes: (_existing, incoming) => (Array.isArray(incoming) ? incoming : []).map((ka, i) => ({ id: `merged-${i}`, label: ka.label ?? "", keywords: Array.isArray(ka.keywords) ? ka.keywords : [], _source: "system" })),
  }
});
mock.module("../lib/bulletCache.mjs", {
  namedExports: {
    readBulletCache: async () => null,
    writeBulletCache: async () => {},
    readExtractCache: async () => null,
    writeExtractCache: async () => {},
  }
});
mock.module("../lib/resumeDailyBulletsService.mjs", {
  namedExports: {
    getOrReconstructDailyBullets: async () => ({ source: "miss", doc: null }),
    BULLET_CACHE_HIT: "cache_hit",
    BULLET_CACHE_RECONSTRUCTED: "reconstructed",
    BULLET_CACHE_MISS: "miss",
    isBulletDocumentValid: () => false,
  }
});
mock.module("../lib/resumeAxes.mjs", {
  namedExports: {
    createAxis: (_label, _kw, _src) => ({ id: `ax-${Date.now()}`, label: _label, keywords: _kw ?? [], _source: _src ?? "system" }),
    updateAxisInArray: (axes) => axes,
    removeAxisFromArray: (axes) => axes,
    splitAxis: (axes) => [axes],
    mergeAxes: (axes) => ({ axes, merged: axes[0] }),
    migrateAxes: (axes) => axes,
    moveKeywordBetweenAxes: (axes) => axes,
  }
});
mock.module("../lib/resumeKeywordClustering.mjs", {
  namedExports: {
    clusterKeywords: async () => [],
    collectResumeKeywords: () => [],
    collectWorkLogKeywords: () => [],
  }
});
mock.module("../lib/config.mjs", { namedExports: { loadConfig: async () => ({ dataDir: "/tmp/work-log-test", openaiApiKey: null }) } });

const { resumeRouter } = await import("./resume.mjs");
const { cookieAuth } = await import("../middleware/auth.mjs");

function buildApp(resumeToken = "test-secret") {
  process.env.RESUME_TOKEN = resumeToken;
  const app = new Hono();
  app.use("/api/resume/*", cookieAuth());
  app.route("/api/resume", resumeRouter);
  return app;
}

function authedRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Cookie", `resume_token=${process.env.RESUME_TOKEN || "test-secret"}`);
  return new Request(url, { ...init, headers });
}

test("GET /api/resume/batch-summary/latest returns stored summary with live draft state", async () => {
  latestBatchSummaryFn = async () => ({
    date: "2026-04-21",
    draft: { status: "pending", triggered: true, triggeredBy: "batch" },
    candidateGeneration: { status: "generated", generated: 2, superseded: 0, message: "ok" },
    candidatePreview: [],
    sourceCounts: { gitCommits: 4, slackContexts: 1, sessions: 1, shellCommands: 2 },
  });
  draftStateFn = () => ({ status: "completed", taskId: "draft-task", triggeredBy: "batch" });

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/batch-summary/latest"));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.summary.draft.status, "completed");
});

test("GET /api/resume/batch-summary/:date returns 404 when summary missing", async () => {
  readBatchSummaryFn = async () => null;
  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/batch-summary/2026-04-21"));
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.equal(body.exists, false);
});

test("GET /api/resume/batch-summary lists summaries with limit", async () => {
  listBatchSummariesFn = async (limit) => {
    assert.equal(limit, 2);
    return [
      { date: "2026-04-21", draft: { status: "pending", triggered: true, triggeredBy: "batch" }, candidateGeneration: { status: "generated", generated: 1, superseded: 0, message: "one" }, candidatePreview: [], sourceCounts: { gitCommits: 1, slackContexts: 0, sessions: 0, shellCommands: 0 } },
      { date: "2026-04-20", draft: { status: "not_started", triggered: false, triggeredBy: null }, candidateGeneration: { status: "below_threshold", generated: 0, superseded: 0, message: "two" }, candidatePreview: [], sourceCounts: { gitCommits: 2, slackContexts: 1, sessions: 0, shellCommands: 0 } },
    ];
  };

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/batch-summary?limit=2"));
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.total, 2);
  assert.equal(body.summaries[0].date, "2026-04-21");
});
