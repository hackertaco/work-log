/**
 * Tests for chat draft persistence and read interface (Sub-AC 2-3).
 *
 * Covers:
 *   POST /api/resume/chat/generate-draft — generate and persist draft
 *   GET  /api/resume/chat/generate-draft — read interface for chat sessions
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.chat.generate-draft.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable state for per-test mock configuration ───────────────────────────
// These variables are captured by closure in the module-level mocks,
// allowing each test to configure the mock behavior before making a request.

let _chatDraftResult = null;        // returned by readChatDraft()
let _saveChatDraftCalls = [];       // records calls to saveChatDraft()
let _chatDraftContextResult = null; // returned by readChatDraftContext()
let _saveChatDraftContextCalls = []; // records calls to saveChatDraftContext()
let _workLogs = [];                  // returned by loadWorkLogs()
let _generatedDraft = null;          // returned by generateResumeDraft()

/** Canonical sample draft for reuse across tests. */
const SAMPLE_DRAFT = {
  schemaVersion: 1,
  generatedAt: "2026-04-01T00:00:00.000Z",
  dateRange: { from: "2026-01-01", to: "2026-03-31" },
  sources: {
    dates: ["2026-03-31", "2026-03-30"],
    commitCount: 42,
    sessionCount: 10,
    slackCount: 5,
    repos: ["company-code/work-log"]
  },
  companyStories: [
    {
      id: "company-story-0",
      company: "work-log",
      role: "프로덕트 엔지니어",
      periodLabel: "2026.03 – 현재",
      narrative: "업무 기록을 이력서 초안과 근거 탐색으로 연결하는 제품 흐름을 설계하고 구현함.",
      projects: [
        {
          id: "company-story-0-project-0",
          title: "채팅 기반 이력서 초안 생성",
          oneLiner: "업무 로그에서 대표 프로젝트와 강점을 먼저 보여주는 채팅형 초안을 구축",
          problem: "기존 이력서는 근거 탐색 없이 bullet만 보여줘 맥락 이해가 어려웠다.",
          solution: [
            "ResumeChatPage와 초안 생성 파이프라인 연결",
            "근거 기반 강점/경험 요약 데이터 구조 설계"
          ],
          result: ["이력서 구체화 시작점을 더 빠르게 파악할 수 있게 됨"],
          stack: ["Preact", "Hono", "OpenAI"],
          capabilities: ["제품 흐름 설계", "LLM 기능 설계"],
          dates: ["2026-03-31"]
        }
      ],
      provenCapabilities: ["근거 기반 제품 설계", "채팅 UX 구현"],
      dates: ["2026-03-31"]
    }
  ],
  strengthCandidates: [
    {
      id: "str-cand-0",
      label: "운영 안정성 우선 개선",
      description: "에러 전파를 사전 격리하는 패턴이 반복됨",
      frequency: 5,
      behaviorCluster: ["에러 경계 설정", "fallback 처리"],
      evidenceExamples: ["2026-03-25: circuit breaker 추가"],
      dates: ["2026-03-25"]
    }
  ],
  experienceSummaries: [
    {
      company: "work-log",
      highlights: ["채팅 기반 이력서 기능 개발"],
      skills: ["Preact", "Hono", "OpenAI"],
      suggestedBullets: ["채팅 UI 구현으로 이력서 구체화 효율 30% 향상"],
      dates: ["2026-03-31"]
    }
  ],
  suggestedSummary: "풀스택 개발자로서 안정적인 시스템을 구축합니다.",
  dataGaps: []
};

/** Minimal work log that satisfies signal aggregation. */
const SAMPLE_WORK_LOG = {
  date: "2026-03-31",
  counts: { gitCommits: 5, codexSessions: 1, slackContexts: 0 },
  highlights: {
    businessOutcomes: ["이력서 채팅 기능 초안 완성"],
    keyChanges: ["ResumeChatPage 컴포넌트 추가"],
    storyThreads: [{ repo: "work-log", outcome: "chat draft 완성" }]
  }
};

// ─── Module-level mocks ───────────────────────────────────────────────────────

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
    // ── Chat draft — closures over mutable state ──────────────────────────────
    saveChatDraft: async (draft) => {
      _saveChatDraftCalls.push(draft);
      return { url: "https://blob/resume/chat-draft.json" };
    },
    readChatDraft: async () => _chatDraftResult,
    // ── Chat draft context — closures over mutable state ─────────────────────
    saveChatDraftContext: async (context) => {
      _saveChatDraftContextCalls.push(context);
      return { url: "https://blob/resume/chat-draft-context.json" };
    },
    readChatDraftContext: async () => _chatDraftContextResult,
    CHAT_DRAFT_CONTEXT_PATHNAME: "resume/chat-draft-context.json",
    saveSession:                  async () => ({ url: "blob://session" }),
    readSession:                  async () => null,
    deleteSession:                async () => {},
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
    gatherWorkLogBullets:          async () => [],
    fullReconstructExtractCache:   async () => ({ total: 0, processed: 0, failed: 0, skipped: 0, dates: [] }),
    generateSectionBridges:        async () => [],
    validateResumeCoherence:       async () => ({ overallScore: 1, grade: "A", structuralFlow: 1, redundancy: 1, tonalConsistency: 1, issues: [], autoFixes: [] }),
    runNarrativeThreadingPipeline: async () => ({ strengths: [], axes: [], sectionBridges: [], extractionResults: [], threading: { totalAnnotations: 0, groundedRatio: 0, strengthCoverage: {}, axisCoverage: {} }, groundingReport: {} }),
    reconstructResumeFromSources:  async () => ({ contact: { name: "Test" } }),
    mergeWithUserEdits:            (r) => r,
    isResumeStale:                 () => false
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

mock.module("../lib/resumeKeywordCoverage.mjs", {
  namedExports: { getUnclassifiedKeywords: () => [] }
});

mock.module("../lib/config.mjs", {
  namedExports: {
    loadConfig: async () => ({ dataDir: "/tmp/work-log-test", openaiApiKey: null })
  }
});

mock.module("../lib/resumeStrengthKeywords.mjs", {
  namedExports: {
    mergeKeywords:                    (kw) => kw,
    removeKeyword:                    (kw) => kw,
    replaceKeywords:                  (kw) => kw,
    extractKeywordsArray:             () => [],
    initStrengthKeywordsFromBootstrap: () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "system", keywords: [] })
  }
});

mock.module("../lib/pdfExtract.mjs", {
  namedExports: { extractTextFromBuffer: async () => "extracted text" }
});

mock.module("../lib/resumeBulletProposal.mjs", {
  namedExports: {
    applyBulletProposal: (doc) => doc,
    isBulletProposal:    () => false
  }
});

mock.module("../lib/resumeSnapshotDelta.mjs", {
  namedExports: { deltaFromLastApproved: async () => ({ delta: 0, lastApproved: null }) }
});

mock.module("../lib/resumeBulletSimilarity.mjs", {
  namedExports: {
    trackBulletEdit:                  async () => {},
    trackBulletEditBatch:             async () => {},
    classifyEditDistance:             () => "minor",
    computeBulletSimilarity:          () => 1,
    loadQualityHistory:               async () => [],
    computeQualityReportFromHistory:  () => ({ usabilityRate: 0, avgSimilarity: 0, records: [] }),
    scoreGeneratedVsFinalBatch:       async () => [],
    persistTrackingRecords:           async () => {},
    createTrackingRecordOffline:      () => ({})
  }
});

mock.module("../lib/resumeSuggestionCompression.mjs", {
  namedExports: { compressWorkLogSuggestions: (s) => s }
});

// ── resumeDraftGeneration mock with closure state ─────────────────────────────
mock.module("../lib/resumeDraftGeneration.mjs", {
  namedExports: {
    generateResumeDraft: async () => {
      if (_generatedDraft === null) throw new Error("Draft generation failed");
      return _generatedDraft;
    },
    loadWorkLogs: async () => _workLogs,
    aggregateSignals: (workLogs) => ({
      signalText: "",
      commitCount: 0,
      sessionCount: 0,
      slackCount: 0,
      repos: [],
    }),
  }
});

// ── resumeChatDraftService mock ───────────────────────────────────────────────
mock.module("../lib/resumeChatDraftService.mjs", {
  namedExports: {
    buildChatDraftContext: async ({ fromDate, toDate, existingResume }) => {
      if (_workLogs.length === 0) {
        return {
          draft: null,
          evidencePool: [],
          sourceBreakdown: { commits: 0, slack: 0, sessions: 0, totalDates: 0 },
          dataGaps: ["분석할 업무 로그 데이터가 없습니���."],
        };
      }
      if (_generatedDraft === null) throw new Error("Draft generation failed");
      return {
        draft: _generatedDraft,
        evidencePool: [],
        sourceBreakdown: { commits: 10, slack: 3, sessions: 5, totalDates: _workLogs.length },
        dataGaps: _generatedDraft?.dataGaps ?? [],
      };
    },
    refineSectionWithChat: async () => ({
      section: "experience",
      suggestions: [],
      evidenceCited: [],
      clarifications: [],
    }),
    searchEvidenceByKeywords: async () => [],
    extractDraftContentForSection: (draft, section) => ({
      strengths: [],
      experiences: [],
      summary: "",
    }),
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

function authedRequest(url, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("cookie", "resume_token=test-secret");
  if (options.body) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(url, { ...options, headers });
}

/** Reset mutable mock state before each test */
function resetState() {
  _chatDraftResult = null;
  _saveChatDraftCalls = [];
  _chatDraftContextResult = null;
  _saveChatDraftContextCalls = [];
  _workLogs = [];
  _generatedDraft = null;
}

// ─── GET /api/resume/chat/generate-draft ─────────────────────────────────────

test("GET /api/resume/chat/generate-draft - draft가 존재하면 200과 draft를 반환한다", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT;

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));

  assert.equal(res.status, 200, "draft 존재 시 200 응답");
  const data = await res.json();
  assert.ok(data.draft, "draft 필드가 응답에 포함되어야 한다");
  assert.equal(data.draft.schemaVersion, 1, "schemaVersion이 1이어야 한다");
  assert.ok(data.draft.dateRange, "dateRange가 포함되어야 한다");
  assert.ok(Array.isArray(data.draft.companyStories), "companyStories가 포함되어야 한다");
  assert.ok(data.draft.strengthCandidates, "strengthCandidates가 포함되어야 한다");
  assert.ok(data.draft.experienceSummaries, "experienceSummaries가 포함되어야 한다");
  assert.equal(typeof data.draft.suggestedSummary, "string", "suggestedSummary는 문자열이어야 한다");
});

test("GET /api/resume/chat/generate-draft - draft가 없으면 404와 exists:false를 반환한다", async () => {
  resetState();
  _chatDraftResult = null; // 이미 null이지만 명시적으로 설정

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));

  assert.equal(res.status, 404, "draft 없으면 404 응답");
  const data = await res.json();
  assert.equal(data.exists, false, "exists 필드가 false여야 한다");
});

test("GET /api/resume/chat/generate-draft - 인증 없으면 401 반환", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT;

  const app = buildApp("test-secret");
  const res = await app.fetch(new Request("http://localhost/api/resume/chat/generate-draft"));

  assert.equal(res.status, 401, "인증 쿠키 없으면 401");
  const data = await res.json();
  assert.equal(data.error, "Unauthorized");
});

test("GET /api/resume/chat/generate-draft - draft의 dateRange 필드가 올바르게 반환된다", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT;

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.draft.dateRange.from, "2026-01-01");
  assert.equal(data.draft.dateRange.to, "2026-03-31");
});

test("GET /api/resume/chat/generate-draft - sources 메타데이터(commitCount 등)가 포함된다", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT;

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));

  assert.equal(res.status, 200);
  const data = await res.json();
  const sources = data.draft.sources;
  assert.ok(sources, "sources 필드가 있어야 한다");
  assert.equal(typeof sources.commitCount, "number", "commitCount는 숫자여야 한다");
  assert.ok(Array.isArray(sources.dates), "dates는 배열이어야 한다");
  assert.ok(Array.isArray(sources.repos), "repos는 배열이어야 한다");
});

// ─── POST /api/resume/chat/generate-draft ────────────────────────────────────

test("POST /api/resume/chat/generate-draft - async 모드(기본)로 202와 taskId를 반환한다", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true })
  }));

  assert.equal(res.status, 202, "비동기 모드 기본값으로 202 반환");
  const data = await res.json();
  assert.ok(data.taskId, "taskId가 응답에 있어야 한다");
  assert.equal(data.status, "pending", "status가 pending이어야 한다");
});

test("POST /api/resume/chat/generate-draft - sync 모드(async:false)로 201을 반환한다", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true, async: false })
  }));

  assert.equal(res.status, 201, "sync 모드로 201 반환");
  const data = await res.json();
  assert.ok(data.draft, "draft 필드가 응답에 있어야 한다");
  assert.equal(data.cached, false, "cached는 false여야 한다");
});

test("POST /api/resume/chat/generate-draft - sync 모드로 생성 후 draft가 Blob에 저장된다", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  const app = buildApp();
  await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true, async: false })
  }));

  assert.equal(_saveChatDraftCalls.length, 1, "saveChatDraft가 정확히 1번 호출되어야 한다");
  assert.equal(_saveChatDraftCalls[0].schemaVersion, 1, "저장된 draft의 schemaVersion이 1이어야 한다");
});

test("POST /api/resume/chat/generate-draft - force=false이고 캐시가 있으면 200과 cached:true를 반환한다", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT;
  // _workLogs는 비어있어도 됨 — 캐시 히트이므로 로드 안 함

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: false })
  }));

  assert.equal(res.status, 200, "캐시 히트 시 200 반환");
  const data = await res.json();
  assert.ok(data.draft, "draft가 응답에 있어야 한다");
  assert.equal(data.cached, true, "cached는 true여야 한다");
  assert.equal(_saveChatDraftCalls.length, 0, "캐시 히트 시 saveChatDraft는 호출되지 않아야 한다");
});

test("POST /api/resume/chat/generate-draft - force=true sync 모드에서 캐시가 있어도 새로 생성한다", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT; // 캐시 존재
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = { ...SAMPLE_DRAFT, generatedAt: "2026-04-04T00:00:00.000Z" };

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true, async: false })
  }));

  assert.equal(res.status, 201, "force=true sync 모드 시 201 반환");
  const data = await res.json();
  assert.equal(data.cached, false, "force=true면 cached는 false여야 한다");
  assert.equal(_saveChatDraftCalls.length, 1, "새 draft가 저장되어야 한다");
});

test("POST /api/resume/chat/generate-draft - sync 모드에서 업무 로그가 없으면 400 반환", async () => {
  resetState();
  _workLogs = []; // 빈 배열

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true, async: false })
  }));

  assert.equal(res.status, 400, "업무 로그 없으면 400 반환");
  const data = await res.json();
  assert.ok(data.error, "에러 메시지가 포함되어야 한다");
});

test("POST /api/resume/chat/generate-draft - from_date 형식이 잘못되면 400 반환", async () => {
  resetState();

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ from_date: "2026/01/01" }) // 잘못된 형식
  }));

  assert.equal(res.status, 400, "잘못된 from_date 형식은 400 반환");
  const data = await res.json();
  assert.ok(data.error.includes("from_date"), "에러 메시지에 from_date가 포함되어야 한다");
});

test("POST /api/resume/chat/generate-draft - to_date 형식이 잘못되면 400 반환", async () => {
  resetState();

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ to_date: "invalid-date" })
  }));

  assert.equal(res.status, 400, "잘못된 to_date 형식은 400 반환");
  const data = await res.json();
  assert.ok(data.error.includes("to_date"), "에러 메시지에 to_date가 포함되어야 한다");
});

test("POST /api/resume/chat/generate-draft - from_date가 to_date보다 늦으면 400 반환", async () => {
  resetState();

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ from_date: "2026-12-31", to_date: "2026-01-01" })
  }));

  assert.equal(res.status, 400, "from_date > to_date면 400 반환");
  const data = await res.json();
  assert.ok(data.error, "에러 메시지가 있어야 한다");
});

test("POST /api/resume/chat/generate-draft - 인증 없으면 401 반환", async () => {
  resetState();

  const app = buildApp("test-secret");
  const res = await app.fetch(new Request("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  }));

  assert.equal(res.status, 401, "인증 없으면 401");
  const data = await res.json();
  assert.equal(data.error, "Unauthorized");
});

test("POST /api/resume/chat/generate-draft - sync 모드에서 유효한 날짜 범위를 전달하면 반영된다", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = {
    ...SAMPLE_DRAFT,
    dateRange: { from: "2026-01-01", to: "2026-03-31" }
  };

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({
      from_date: "2026-01-01",
      to_date: "2026-03-31",
      force: true,
      async: false
    })
  }));

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.draft, "draft가 반환되어야 한다");
});

// ─── 퍼시스트 → 읽기 통합 플로우 ────────────────────────────────────────────

test("POST 후 GET: sync 모드로 생성된 draft를 이후 GET으로 조회할 수 있다 (퍼시스트 → 읽기 인터페이스)", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  const app = buildApp();

  // Step 1: POST로 draft 생성 (sync 모드 — 내부적으로 saveChatDraft 호출)
  const postRes = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true, async: false })
  }));
  assert.equal(postRes.status, 201, "sync 모드 초안 생성 시 201 반환");
  assert.equal(_saveChatDraftCalls.length, 1, "draft가 저장되어야 한다");

  // Step 2: 저장된 draft를 readChatDraft가 반환하도록 설정 (실제 Blob 동작 시뮬레이션)
  _chatDraftResult = _saveChatDraftCalls[0];

  // Step 3: GET으로 조회 — 이후 채팅 세션에서 draft를 읽을 수 있어야 한다
  const getRes = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));
  assert.equal(getRes.status, 200, "저장된 draft를 GET으로 조회할 수 있어야 한다");

  const getData = await getRes.json();
  assert.ok(getData.draft, "draft가 응답에 있어야 한다");
  assert.equal(getData.draft.schemaVersion, 1, "schemaVersion이 올바르게 보존되어야 한다");
  assert.equal(getData.draft.generatedAt, SAMPLE_DRAFT.generatedAt, "generatedAt이 보존되어야 한다");
  assert.deepEqual(getData.draft.dateRange, SAMPLE_DRAFT.dateRange, "dateRange가 보존되어야 한다");
  assert.equal(
    getData.draft.strengthCandidates.length,
    SAMPLE_DRAFT.strengthCandidates.length,
    "strengthCandidates가 보존되어야 한다"
  );
});

test("캐시 히트: 동일 범위의 draft가 있으면 force=false로 조회 시 재생성하지 않는다", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT;

  const app = buildApp();

  // force=false (기본) — 캐시가 범위를 커버하므로 재생성하지 않아야 한다
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: false })
  }));

  assert.equal(res.status, 200, "캐시 히트 시 200 반환");
  const data = await res.json();
  assert.equal(data.cached, true);

  // saveChatDraft가 호출되지 않았어야 한다 (재생성 없음)
  assert.equal(_saveChatDraftCalls.length, 0, "캐시 히트 시 저장하지 않아야 한다");
});

// ─── Sub-AC 2-3: 초안 컨텍스트 퍼시스트 + 조회 ─────────────────────────────

test("POST /api/resume/chat/generate-draft - sync 모드에서 draft 생성 시 full context도 함께 Blob에 저장된다", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true, async: false })
  }));

  assert.equal(res.status, 201);
  assert.equal(_saveChatDraftCalls.length, 1, "saveChatDraft가 호출되어야 한다");
  assert.equal(_saveChatDraftContextCalls.length, 1, "saveChatDraftContext가 호출되어야 한다");

  const ctx = _saveChatDraftContextCalls[0];
  assert.equal(ctx.schemaVersion, 1, "context schemaVersion이 1이어야 한다");
  assert.ok(ctx.draft, "context에 draft가 포함되어야 한다");
  assert.ok(Array.isArray(ctx.evidencePool), "context에 evidencePool 배열이 있어야 한다");
  assert.ok(ctx.sourceBreakdown, "context에 sourceBreakdown이 있어야 한다");
  assert.ok(Array.isArray(ctx.dataGaps), "context에 dataGaps 배열이 있어야 한다");
});

test("GET /api/resume/chat/generate-draft - context가 있으면 evidencePool과 sourceBreakdown을 함께 반환한다", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT;
  _chatDraftContextResult = {
    schemaVersion: 1,
    generatedAt: SAMPLE_DRAFT.generatedAt,
    draft: SAMPLE_DRAFT,
    evidencePool: [
      { source: "commits", date: "2026-03-31", text: "feat: add chat draft", score: 0.8 },
      { source: "slack", date: "2026-03-30", text: "이력서 기능 논의", score: 0.6 },
    ],
    sourceBreakdown: { commits: 10, slack: 3, sessions: 5, totalDates: 7 },
    dataGaps: ["프로젝트 성과 수치가 부족합니다"],
  };

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.draft, "draft가 있어야 한다");
  assert.ok(Array.isArray(data.evidencePool), "evidencePool이 배열이어야 한다");
  assert.equal(data.evidencePool.length, 2, "evidencePool에 2개 항목이 있어야 한다");
  assert.equal(data.sourceBreakdown.commits, 10, "sourceBreakdown.commits가 올바르게 반환되어야 한다");
  assert.equal(data.sourceBreakdown.totalDates, 7, "sourceBreakdown.totalDates가 올바르게 반환되어야 한다");
  assert.ok(Array.isArray(data.dataGaps), "dataGaps가 배열이어야 한다");
  assert.equal(data.dataGaps.length, 1, "dataGaps에 1개 항목이 있어야 한다");
});

test("GET /api/resume/chat/generate-draft - context가 없어도 draft만 정상 반환한다", async () => {
  resetState();
  _chatDraftResult = SAMPLE_DRAFT;
  _chatDraftContextResult = null; // context 없음

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.draft, "draft가 있어야 한다");
  assert.equal(data.evidencePool, undefined, "context 없을 때 evidencePool은 없어야 한다");
  assert.equal(data.sourceBreakdown, undefined, "context 없을 때 sourceBreakdown은 없어야 한다");
});

test("POST → GET 통합: sync 모드로 생성된 context가 GET에서 정확히 조회된다", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  const app = buildApp();

  // Step 1: POST (sync 모드)로 draft + context 생성
  const postRes = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true, async: false })
  }));
  assert.equal(postRes.status, 201);
  assert.equal(_saveChatDraftContextCalls.length, 1, "context가 저장되어야 한다");

  // Step 2: 저장된 데이터를 readChatDraft/readChatDraftContext가 반환하도록 설정
  _chatDraftResult = _saveChatDraftCalls[0];
  _chatDraftContextResult = _saveChatDraftContextCalls[0];

  // Step 3: GET으로 draft + context 조회
  const getRes = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));
  assert.equal(getRes.status, 200);

  const getData = await getRes.json();
  assert.ok(getData.draft, "draft가 응답에 있어야 한다");
  assert.ok(Array.isArray(getData.evidencePool), "evidencePool이 응답에 있어야 한다");
  assert.ok(getData.sourceBreakdown, "sourceBreakdown이 응답에 있어야 한다");
  assert.equal(getData.sourceBreakdown.commits, 10, "sourceBreakdown.commits가 보존되어야 한다");
});

// ─── 비동기 모드 (Sub-AC 2-3) ────────────────────────────────────────────────

test("POST /api/resume/chat/generate-draft - async 모드에서 백그라운드 생성 후 status 폴링으로 완료 확인", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  const app = buildApp();

  // Step 1: POST (async 기본값) → 202 반환
  const postRes = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true })
  }));
  assert.equal(postRes.status, 202, "비동기 모드에서 202 반환");
  const postData = await postRes.json();
  assert.ok(postData.taskId, "taskId가 있어야 한다");
  assert.equal(postData.status, "pending", "상태가 pending이어야 한다");

  // Step 2: 백그라운드 처리 완료 대기 (mock은 동기적으로 즉시 완료)
  await new Promise((r) => setTimeout(r, 200));

  // Step 3: 상태 폴링 → completed
  const statusRes = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft/status"));
  assert.equal(statusRes.status, 200, "상태 폴링 200 반환");
  const statusData = await statusRes.json();
  assert.equal(statusData.status, "completed", "상태가 completed여야 한다");
});

test("GET /api/resume/chat/generate-draft/status - 초기 상태는 idle이다", async () => {
  resetState();
  // draftGenerationState를 idle로 리셋
  const { resetDraftGenerationState } = await import("../lib/draftGenerationState.mjs");
  resetDraftGenerationState();

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft/status"));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "idle", "초기 상태는 idle이어야 한다");
});

test("POST /api/resume/chat/generate-draft/reset - 상태를 idle로 초기화한다", async () => {
  resetState();

  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft/reset", {
    method: "POST"
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "idle", "리셋 후 idle 상태여야 한다");
});

test("POST /api/resume/chat/generate-draft - async 모드에서 생성 완료 후 GET으로 draft 조회 가능", async () => {
  resetState();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  const app = buildApp();

  // Step 1: POST (async) → 백그라운드 생성 시작
  const postRes = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true })
  }));
  assert.equal(postRes.status, 202);

  // Step 2: 백그라운드 완료 대기
  await new Promise((r) => setTimeout(r, 200));

  // Step 3: 저장된 draft mock 설정 (백그라운드에서 saveChatDraft 호출됨)
  if (_saveChatDraftCalls.length > 0) {
    _chatDraftResult = _saveChatDraftCalls[0];
    _chatDraftContextResult = _saveChatDraftContextCalls[0] ?? null;
  }

  // Step 4: GET으로 draft 조회
  const getRes = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft"));
  assert.equal(getRes.status, 200, "백그라운드 생성 후 GET으로 draft 조회 가능");
  const getData = await getRes.json();
  assert.ok(getData.draft, "draft가 응답에 포함되어야 한다");
});

// ─── Sub-AC 2-3: 409 Conflict — 중복 생성 방지 ─────────────────────────────

const {
  markDraftGenerationPending: _markDGPending,
  markDraftGenerationCompleted: _markDGCompleted,
  markDraftGenerationFailed: _markDGFailed,
  updateDraftGenerationProgress: _updateDGProgress,
  resetDraftGenerationState: _resetDG,
} = await import("../lib/draftGenerationState.mjs");

test("POST /api/resume/chat/generate-draft - 생성이 진행 중일 때 409와 기존 taskId를 반환한다", async () => {
  resetState();
  _resetDG();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  // pending 상태를 직접 설정 (실제로는 이전 POST가 설정)
  const existingTaskId = _markDGPending("api");
  _updateDGProgress(existingTaskId, { stage: "calling_llm", commitCount: 42 });

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true })
  }));

  assert.equal(res.status, 409, "이미 생성 중일 때 409 반환");
  const data = await res.json();
  assert.ok(data.error, "에러 메시지가 있어야 한다");
  assert.equal(data.taskId, existingTaskId, "진행 중인 taskId가 반환되어야 한다");
  assert.equal(data.status, "pending", "진행 중인 상태가 반환되어야 한다");
  assert.ok(data.startedAt, "시작 시간이 포함되어야 한다");
  assert.ok(data.progress, "진행 상황이 포함되어야 한다");

  _resetDG(); // cleanup
});

test("POST /api/resume/chat/generate-draft - completed 상태에서는 새 생성이 가능하다", async () => {
  resetState();
  _resetDG();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  // completed 상태를 설정
  const taskId = _markDGPending("api");
  _markDGCompleted(taskId);

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true })
  }));

  // completed는 in-progress가 아니므로 409가 아닌 202를 반환해야 한다
  assert.equal(res.status, 202, "완료된 후 새 요청은 202 반환");
  const data = await res.json();
  assert.ok(data.taskId, "새 taskId가 반환되어야 한다");
  assert.notEqual(data.taskId, taskId, "새 taskId는 이전 것과 달라야 한다");

  _resetDG(); // cleanup
});

test("POST /api/resume/chat/generate-draft - failed 상태에서는 새 생성이 가능하다", async () => {
  resetState();
  _resetDG();
  _workLogs = [SAMPLE_WORK_LOG];
  _generatedDraft = SAMPLE_DRAFT;

  // failed 상태를 설정
  const taskId = _markDGPending("api");
  _markDGFailed(taskId, "previous failure");

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft", {
    method: "POST",
    body: JSON.stringify({ force: true })
  }));

  assert.equal(res.status, 202, "실패 후 새 요청은 202 반환");

  _resetDG(); // cleanup
});

test("GET /api/resume/chat/generate-draft/status - pending 중 progress 메타데이터를 정확히 반환한다", async () => {
  resetState();
  _resetDG();

  const taskId = _markDGPending("batch");
  _updateDGProgress(taskId, {
    stage: "collecting_evidence",
    datesLoaded: 30,
    commitCount: 85,
    slackCount: 12,
    sessionCount: 7,
  });

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft/status"));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "pending");
  assert.equal(data.triggeredBy, "batch");
  assert.equal(data.progress.stage, "collecting_evidence");
  assert.equal(data.progress.datesLoaded, 30);
  assert.equal(data.progress.commitCount, 85);
  assert.equal(data.progress.slackCount, 12);
  assert.equal(data.progress.sessionCount, 7);

  _resetDG(); // cleanup
});

test("GET /api/resume/chat/generate-draft/status - failed 상태에서 에러 메시지를 정확히 반환한다", async () => {
  resetState();
  _resetDG();

  const taskId = _markDGPending("manual");
  _markDGFailed(taskId, "OPENAI_API_KEY is not set");

  const app = buildApp();
  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat/generate-draft/status"));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "failed");
  assert.equal(data.triggeredBy, "manual");
  assert.equal(data.error, "OPENAI_API_KEY is not set");
  assert.ok(data.completedAt, "completedAt이 있어야 한다");
  assert.equal(data.progress.stage, "failed");

  _resetDG(); // cleanup
});
