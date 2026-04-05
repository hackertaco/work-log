/**
 * Tests for PATCH /api/resume/section endpoint (Sub-AC 6-2).
 *
 * approve 액션 처리 로직 검증:
 *   - diff 내용을 이력서에 반영(적용)
 *   - 섹션별 적용 규칙 (summary, experience, skills, projects, education)
 *   - _source: "user_approved" 태깅
 *   - 스냅샷 저장 (pre-chat-approve)
 *   - 입력 검증 (section 필드, content 필드, 유효 섹션명)
 *   - 이력서 없을 때 404
 *   - 인증 없을 때 401
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.section.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── 테스트용 기본 이력서 픽스처 ────────────────────────────────────────────────

const BASE_RESUME = {
  schemaVersion: 1,
  meta: { language: "ko", source: "pdf", generatedAt: "2024-01-01T00:00:00.000Z" },
  contact: { name: "홍길동", email: "hong@example.com" },
  summary: "기존 자기소개 텍스트입니다.",
  experience: [
    {
      _source: "system",
      company: "테스트 회사",
      title: "백엔드 개발자",
      start_date: "2022-01",
      end_date: "present",
      bullets: ["기존 불릿 1", "기존 불릿 2"],
    },
  ],
  education: [
    {
      _source: "system",
      institution: "테스트 대학",
      degree: "학사",
      field: "컴퓨터공학",
    },
  ],
  skills: {
    technical: ["JavaScript", "TypeScript"],
    languages: ["Korean", "English"],
    tools: ["Git", "Docker"],
  },
  projects: [
    {
      _source: "system",
      name: "테스트 프로젝트",
      description: "프로젝트 설명",
      bullets: ["기존 프로젝트 불릿"],
    },
  ],
  certifications: [
    {
      _source: "system",
      name: "AWS 자격증",
      issuer: "Amazon",
      date: "2023-06",
    },
  ],
};

// ─── Module-level mocks ────────────────────────────────────────────────────────

// readResumeData 의 반환값을 테스트마다 제어하기 위한 변수
let mockResumeData = { ...BASE_RESUME };
let savedResumeData = null;
let snapshotSaved = false;

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: true }),
    saveResumeData:               async (doc) => {
      savedResumeData = doc;
      return { url: "https://blob/resume/data.json" };
    },
    readResumeData:               async () => mockResumeData,
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
    saveSnapshot:                 async () => {
      snapshotSaved = true;
      return { snapshotKey: "resume/snapshots/test.json", url: "https://blob/test" };
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
    saveChatDraft:                async () => ({ url: "https://blob/resume/chat-draft.json" }),
    readChatDraft:                async () => null,
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

mock.module("../lib/resumeDraftGeneration.mjs", {
  namedExports: {
    generateResumeDraft: async () => ({
      strengthCandidates: [],
      experienceSummaries: [],
      suggestedSummary: "Test summary",
      dataGaps: [],
      sources: [],
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    }),
    loadWorkLogs: async () => [],
    aggregateSignals: () => ({ signalText: "", commitCount: 0, sessionCount: 0, slackCount: 0, repos: [] }),
  }
});

mock.module("../lib/resumeChatDraftService.mjs", {
  namedExports: {
    buildChatDraftContext: async () => ({
      draft: null,
      evidencePool: [],
      sourceBreakdown: { commits: 0, slack: 0, sessions: 0, totalDates: 0 },
      dataGaps: [],
    }),
    refineSectionWithChat: async () => ({
      section: "experience",
      suggestions: [],
      evidenceCited: [],
      clarifications: [],
    }),
    searchEvidenceByKeywords: async () => [],
    extractDraftContentForSection: () => ({
      strengths: [],
      experiences: [],
      summary: "",
    }),
  }
});

mock.module("../lib/resumeEvidenceSearch.mjs", {
  namedExports: {
    searchAllSources: async () => ({ commits: [], slack: [], sessions: [], totalCount: 0 }),
    searchCommits:    async () => [],
    searchSlack:      async () => [],
    searchSessionMemory: async () => [],
  }
});

mock.module("../lib/resumeAppealPoints.mjs", {
  namedExports: {
    mergeAndRankEvidence: () => [],
    buildEvidenceContext: () => "",
    generateAppealPoints: async () => ({ appealPoints: [], dataGaps: [], followUpQuestions: [], evidenceUsed: [] }),
  }
});

mock.module("../lib/resumeChatApplyIntent.mjs", {
  namedExports: {
    detectApplyIntent:        (text) => /반영해\s*줘/.test(text),
    extractSectionFromContext: (_q, pq) => pq?.section ?? null,
    extractProposedChanges:   () => ({ changes: [], sourceIndex: -1 }),
    parseApplyIntent:         (_q, pq) => ({
      detected: true,
      section: pq?.section ?? null,
      changes: [],
      confidence: 0.5,
      ambiguous: true,
      clarificationNeeded: "어떤 섹션에 반영할까요?",
      sourceMessageIndex: -1,
    }),
  }
});

// ─── Load router under test AFTER mocks ──────────────────────────────────────

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

// 각 테스트 전에 mockResumeData 와 캡처 변수를 리셋한다.
function resetMocks() {
  mockResumeData = JSON.parse(JSON.stringify(BASE_RESUME));
  savedResumeData = null;
  snapshotSaved = false;
}

// ─── PATCH /api/resume/section — 정상 응답 ──────────────────────────────────

test("PATCH /api/resume/section - summary 섹션을 새 내용으로 교체한다", async () => {
  resetMocks();
  const app = buildApp();

  const newSummary = "새로운 자기소개 텍스트입니다. 개선된 내용입니다.";
  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "summary", content: newSummary }),
  }));

  assert.equal(res.status, 200, "200 응답이어야 한다");
  const data = await res.json();
  assert.equal(data.ok, true, "ok: true");
  assert.equal(data.section, "summary", "section 필드가 반환되어야 한다");
  assert.ok(typeof data.appliedAt === "string", "appliedAt 타임스탬프가 있어야 한다");
  assert.ok(data.resume, "resume 필드가 반환되어야 한다");

  // 저장된 resume 의 summary 가 새 내용으로 바뀌었는지 확인
  assert.equal(savedResumeData?.summary, newSummary.trim(), "summary 가 교체되어야 한다");
});

test("PATCH /api/resume/section - summary 적용 후 _source 가 user_approved 로 태깅된다", async () => {
  resetMocks();
  // _sources 필드를 가진 이력서로 테스트
  mockResumeData = {
    ...JSON.parse(JSON.stringify(BASE_RESUME)),
    _sources: { summary: "system", experience: "system" }
  };
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "summary", content: "Updated summary" }),
  }));

  assert.equal(res.status, 200);
  assert.equal(savedResumeData?._sources?.summary, "user_approved", "_sources.summary 가 user_approved 이어야 한다");
});

test("PATCH /api/resume/section - experience 섹션의 가장 최근 불릿을 교체한다", async () => {
  resetMocks();
  const app = buildApp();

  const newBullets = "- 신규 불릿 1\n- 신규 불릿 2\n- 신규 불릿 3";
  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "experience", content: newBullets }),
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.section, "experience");

  // 저장된 resume 의 experience[0] 불릿이 교체되었는지 확인
  const firstEntry = savedResumeData?.experience?.[0];
  assert.ok(firstEntry, "첫 번째 경력 항목이 있어야 한다");
  assert.deepEqual(
    firstEntry.bullets,
    ["신규 불릿 1", "신규 불릿 2", "신규 불릿 3"],
    "불릿이 새 내용으로 교체되어야 한다"
  );
  assert.equal(firstEntry._source, "user_approved", "_source 가 user_approved 이어야 한다");
});

test("PATCH /api/resume/section - experience 불릿에 • 와 * 접두사도 처리한다", async () => {
  resetMocks();
  const app = buildApp();

  const mixedBullets = "• 불릿 스타일 1\n* 불릿 스타일 2\n1. 번호 불릿 3";
  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "experience", content: mixedBullets }),
  }));

  assert.equal(res.status, 200);
  const firstEntry = savedResumeData?.experience?.[0];
  assert.deepEqual(
    firstEntry.bullets,
    ["불릿 스타일 1", "불릿 스타일 2", "번호 불릿 3"],
    "다양한 불릿 접두사가 제거되어야 한다"
  );
});

test("PATCH /api/resume/section - projects 섹션의 가장 최근 불릿을 교체한다", async () => {
  resetMocks();
  const app = buildApp();

  const newBullets = "- 프로젝트 불릿 A\n- 프로젝트 불릿 B";
  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "projects", content: newBullets }),
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.section, "projects");

  const firstProject = savedResumeData?.projects?.[0];
  assert.ok(firstProject, "첫 번째 프로젝트가 있어야 한다");
  assert.deepEqual(
    firstProject.bullets,
    ["프로젝트 불릿 A", "프로젝트 불릿 B"],
    "프로젝트 불릿이 교체되어야 한다"
  );
  assert.equal(firstProject._source, "user_approved");
});

test("PATCH /api/resume/section - skills 섹션에 신규 기술을 technical 에 추가한다", async () => {
  resetMocks();
  const app = buildApp();

  // diff.after 는 allExisting + new 로 전달된다:
  // allExisting = JavaScript, TypeScript (technical) + Korean, English (languages) + Git, Docker (tools)
  // + new: React, Node.js
  const content = [
    "- JavaScript",
    "- TypeScript",
    "- Korean",
    "- English",
    "- Git",
    "- Docker",
    "- React",
    "- Node.js",
  ].join("\n");

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "skills", content }),
  }));

  assert.equal(res.status, 200);
  const skills = savedResumeData?.skills;
  assert.ok(skills, "skills 필드가 있어야 한다");

  // 신규 기술(React, Node.js)만 technical 에 추가되어야 한다
  assert.ok(skills.technical.includes("JavaScript"), "기존 JavaScript 는 유지");
  assert.ok(skills.technical.includes("TypeScript"), "기존 TypeScript 는 유지");
  assert.ok(skills.technical.includes("React"), "신규 React 가 추가되어야 한다");
  assert.ok(skills.technical.includes("Node.js"), "신규 Node.js 가 추가되어야 한다");

  // languages 와 tools 는 technical 에 중복 추가되어서는 안 된다
  const technicalSet = new Set(skills.technical);
  assert.ok(!technicalSet.has("Korean"), "languages('Korean')는 technical 에 추가되지 않아야 한다");
  assert.ok(!technicalSet.has("English"), "languages('English')는 technical 에 추가되지 않아야 한다");
  assert.ok(!technicalSet.has("Git"), "tools('Git')는 technical 에 추가되지 않아야 한다");
  assert.ok(!technicalSet.has("Docker"), "tools('Docker')는 technical 에 추가되지 않아야 한다");

  // languages 와 tools 는 원래 그대로 유지되어야 한다
  assert.deepEqual(skills.languages, ["Korean", "English"], "languages 는 변경되지 않아야 한다");
  assert.deepEqual(skills.tools, ["Git", "Docker"], "tools 는 변경되지 않아야 한다");
});

test("PATCH /api/resume/section - skills: 이미 technical 에 있는 기술은 중복 추가되지 않는다", async () => {
  resetMocks();
  const app = buildApp();

  // 기존 기술만 포함한 content (신규 없음)
  const content = "- JavaScript\n- TypeScript";

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "skills", content }),
  }));

  assert.equal(res.status, 200);
  const technical = savedResumeData?.skills?.technical;
  const jsCount = technical.filter((s) => s === "JavaScript").length;
  assert.equal(jsCount, 1, "JavaScript 가 중복 없이 1개이어야 한다");
});

test("PATCH /api/resume/section - education 섹션 승인 시 _source 가 user_approved 로 업데이트된다", async () => {
  resetMocks();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "education", content: "" }),
  }));

  assert.equal(res.status, 200);
  const firstEdu = savedResumeData?.education?.[0];
  assert.ok(firstEdu, "첫 번째 학력 항목이 있어야 한다");
  assert.equal(firstEdu._source, "user_approved", "_source 가 user_approved 이어야 한다");
});

test("PATCH /api/resume/section - certifications 섹션을 처리한다", async () => {
  resetMocks();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "certifications", content: "" }),
  }));

  assert.equal(res.status, 200);
  assert.equal(savedResumeData?.certifications?.[0]?.name, "AWS 자격증", "인증서 항목이 유지되어야 한다");
});

test("PATCH /api/resume/section - 스냅샷이 저장된다 (pre-chat-approve)", async () => {
  resetMocks();
  const app = buildApp();

  await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "summary", content: "새 요약" }),
  }));

  assert.ok(snapshotSaved, "PATCH 실행 전 스냅샷이 저장되어야 한다");
});

test("PATCH /api/resume/section - messageId 와 sessionId 는 선택 필드이다", async () => {
  resetMocks();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({
      section: "summary",
      content: "새 요약",
      messageId: "msg-001",
      sessionId: "session-001",
    }),
  }));

  assert.equal(res.status, 200, "messageId/sessionId 포함 요청도 200 응답");
});

test("PATCH /api/resume/section - resume 응답에 업데이트된 내용이 포함된다", async () => {
  resetMocks();
  const app = buildApp();

  const newSummary = "응답 resume 검증용 요약";
  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "summary", content: newSummary }),
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.resume, "응답에 resume 객체가 포함되어야 한다");
  assert.equal(data.resume.summary, newSummary.trim(), "응답 resume.summary 가 업데이트되어야 한다");
  assert.ok(typeof data.appliedAt === "string", "appliedAt 이 ISO8601 문자열이어야 한다");
  // appliedAt 이 유효한 날짜인지 확인
  assert.ok(!isNaN(Date.parse(data.appliedAt)), "appliedAt 이 유효한 날짜여야 한다");
});

// ─── PATCH /api/resume/section — 입력 검증 (400) ────────────────────────────

test("PATCH /api/resume/section - section 필드 없으면 400 반환", async () => {
  resetMocks();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ content: "내용" }),
  }));

  assert.equal(res.status, 400, "section 없으면 400");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 있어야 한다");
});

test("PATCH /api/resume/section - content 필드 없으면 400 반환", async () => {
  resetMocks();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "summary" }),
  }));

  assert.equal(res.status, 400, "content 없으면 400");
  const data = await res.json();
  assert.ok(data.error);
});

test("PATCH /api/resume/section - 지원하지 않는 섹션 이름이면 400 반환", async () => {
  resetMocks();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "invalid_section", content: "내용" }),
  }));

  assert.equal(res.status, 400, "잘못된 섹션은 400");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 있어야 한다");
});

test("PATCH /api/resume/section - 빈 문자열 section 이면 400 반환", async () => {
  resetMocks();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "", content: "내용" }),
  }));

  assert.equal(res.status, 400, "빈 section 은 400");
});

test("PATCH /api/resume/section - 잘못된 JSON 바디이면 400 반환", async () => {
  resetMocks();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: "not-json",
  }));

  assert.equal(res.status, 400, "잘못된 JSON 은 400");
});

// ─── PATCH /api/resume/section — 이력서 없을 때 404 ─────────────────────────

test("PATCH /api/resume/section - 이력서가 없으면 404 반환", async () => {
  resetMocks();
  mockResumeData = null; // 이력서 없음
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "summary", content: "내용" }),
  }));

  assert.equal(res.status, 404, "이력서 없으면 404");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 있어야 한다");
});

// ─── PATCH /api/resume/section — 인증 검사 ──────────────────────────────────

test("PATCH /api/resume/section - 인증 쿠키 없으면 401 반환", async () => {
  resetMocks();
  const app = buildApp("test-secret");

  const res = await app.fetch(new Request("http://localhost/api/resume/section", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ section: "summary", content: "내용" }),
  }));

  assert.equal(res.status, 401, "인증 없으면 401");
  const data = await res.json();
  assert.equal(data.error, "Unauthorized");
});

// ─── PATCH /api/resume/section — experience 경계 조건 ───────────────────────

test("PATCH /api/resume/section - experience 항목이 없으면 400 반환", async () => {
  resetMocks();
  mockResumeData = { ...JSON.parse(JSON.stringify(BASE_RESUME)), experience: [] };
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "experience", content: "- 불릿" }),
  }));

  assert.equal(res.status, 400, "experience 항목 없으면 400");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 있어야 한다");
});

test("PATCH /api/resume/section - projects 항목이 없으면 400 반환", async () => {
  resetMocks();
  mockResumeData = { ...JSON.parse(JSON.stringify(BASE_RESUME)), projects: [] };
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "projects", content: "- 불릿" }),
  }));

  assert.equal(res.status, 400, "projects 항목 없으면 400");
});

// ─── PATCH /api/resume/section — diff 흐름 통합 검증 ────────────────────────

test("PATCH /api/resume/section - experience: 여러 항목이 있을 때 첫 번째(최근) 항목만 업데이트된다", async () => {
  resetMocks();
  mockResumeData = {
    ...JSON.parse(JSON.stringify(BASE_RESUME)),
    experience: [
      { _source: "system", company: "최근 회사", title: "개발자", bullets: ["원래 불릿"] },
      { _source: "system", company: "이전 회사", title: "개발자", bullets: ["다른 불릿"] },
    ],
  };
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({ section: "experience", content: "- 새 불릿" }),
  }));

  assert.equal(res.status, 200);
  const exp = savedResumeData?.experience;
  assert.equal(exp.length, 2, "항목 수는 유지되어야 한다");
  assert.deepEqual(exp[0].bullets, ["새 불릿"], "첫 번째 항목만 업데이트되어야 한다");
  assert.deepEqual(exp[1].bullets, ["다른 불릿"], "두 번째 항목은 변경되지 않아야 한다");
  assert.equal(exp[0]._source, "user_approved", "첫 번째 항목 _source: user_approved");
  assert.equal(exp[1]._source, "system", "두 번째 항목 _source: 변경 없음");
});

// ─── PATCH /api/resume/section — applyChatChangesToResume diff 적용 라운드트립 ──

test("PATCH /api/resume/section - applyChatChangesToResume diff.after 를 그대로 적용할 수 있다 (경력 섹션 라운드트립)", async () => {
  resetMocks();
  const app = buildApp();

  // applyChatChangesToResume 를 직접 호출해 diff.after 를 생성한다
  const { applyChatChangesToResume } = await import("../lib/resumeChatApplySections.mjs");

  const applyIntentResult = {
    detected: true,
    section: "experience",
    changes: [
      { type: "bullet", content: "대규모 트래픽 서비스 운영 경험", context: undefined },
      { type: "bullet", content: "Docker/Kubernetes 기반 배포 자동화", context: undefined },
    ],
    confidence: 0.9,
    ambiguous: false,
    clarificationNeeded: null,
    sourceMessageIndex: 1,
  };

  const applyResult = applyChatChangesToResume(BASE_RESUME, applyIntentResult);
  assert.ok(applyResult.diff, "applyChatChangesToResume 가 diff 를 반환해야 한다");

  // diff.after 를 PATCH /api/resume/section 의 content 로 사용한다
  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({
      section: applyResult.diff.section,
      content: applyResult.diff.after,  // diff.after 를 직접 content 로 사용
      messageId: "test-msg-001",
      sessionId: "test-session-001",
    }),
  }));

  assert.equal(res.status, 200, "diff.after 를 content 로 사용한 PATCH 가 성공해야 한다");
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.section, "experience");
  assert.ok(data.resume, "resume 가 반환되어야 한다");

  // 저장된 이력서에 새 불릿이 포함되어야 한다
  const firstEntry = savedResumeData?.experience?.[0];
  assert.ok(firstEntry, "첫 번째 경력 항목이 있어야 한다");
  assert.ok(
    firstEntry.bullets.includes("대규모 트래픽 서비스 운영 경험"),
    "새 불릿 1이 반영되어야 한다"
  );
  assert.ok(
    firstEntry.bullets.includes("Docker/Kubernetes 기반 배포 자동화"),
    "새 불릿 2가 반영되어야 한다"
  );
  assert.equal(firstEntry._source, "user_approved", "_source 가 user_approved 이어야 한다");
});

test("PATCH /api/resume/section - applyChatChangesToResume diff.after 를 적용할 수 있다 (기술 섹션 라운드트립)", async () => {
  resetMocks();
  const app = buildApp();

  const { applyChatChangesToResume } = await import("../lib/resumeChatApplySections.mjs");

  const applyIntentResult = {
    detected: true,
    section: "skills",
    changes: [
      { type: "bullet", content: "React", context: undefined },
      { type: "bullet", content: "Node.js", context: undefined },
    ],
    confidence: 0.9,
    ambiguous: false,
    clarificationNeeded: null,
    sourceMessageIndex: 1,
  };

  const applyResult = applyChatChangesToResume(BASE_RESUME, applyIntentResult);
  assert.ok(applyResult.diff, "diff 가 반환되어야 한다");
  assert.ok(applyResult.appliedChanges.length > 0, "적용된 변경이 있어야 한다");

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify({
      section: applyResult.diff.section,
      content: applyResult.diff.after,
    }),
  }));

  assert.equal(res.status, 200);
  const skills = savedResumeData?.skills;
  assert.ok(skills, "skills 필드가 있어야 한다");
  assert.ok(skills.technical.includes("React"), "React 가 technical 에 추가되어야 한다");
  assert.ok(skills.technical.includes("Node.js"), "Node.js 가 technical 에 추가되어야 한다");
  // 기존 technical 은 유지되어야 한다
  assert.ok(skills.technical.includes("JavaScript"), "기존 JavaScript 는 유지되어야 한다");
  assert.ok(skills.technical.includes("TypeScript"), "기존 TypeScript 는 유지되어야 한다");
  // languages 와 tools 는 변경되지 않아야 한다
  assert.deepEqual(skills.languages, ["Korean", "English"], "languages 는 유지");
  assert.deepEqual(skills.tools, ["Git", "Docker"], "tools 는 유지");
});
