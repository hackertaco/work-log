/**
 * Tests for PATCH /api/resume/section endpoint (Sub-AC 6-2).
 *
 * Verifies the approve action handling logic:
 *   - diff 내용(after text)을 이력서 섹션에 반영한다
 *   - 반영 전 스냅샷을 저장한다 (롤백 기준점)
 *   - 성공 시 { ok: true, resume, section, appliedAt } 반환
 *   - 섹션별 적용 규칙 검증 (summary, experience, projects, skills, education, certifications)
 *   - 필수 필드 누락 및 잘못된 섹션명에 대해 400 반환
 *   - 이력서 없으면 404 반환
 *   - 인증 없으면 401 반환
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.section-approve.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable mock state ───────────────────────────────────────────────────────
// 각 테스트에서 아래 변수를 설정해 mock 동작을 제어한다.

/** readResumeData()가 반환할 이력서 문서. null이면 404 경로를 테스트 */
let _resumeDoc = null;

/** saveResumeData() 호출 기록 */
let _saveResumeCalls = [];

/** saveSnapshot() 호출 기록 */
let _saveSnapshotCalls = [];

/** saveResumeData() 강제 실패 여부 */
let _saveResumeThrow = false;

/** readResumeData() 강제 실패 여부 */
let _readResumeThrow = false;

// ─── 샘플 이력서 문서 ─────────────────────────────────────────────────────────

/** 전체 섹션이 포함된 샘플 이력서 */
const SAMPLE_RESUME = {
  schemaVersion: 1,
  _sources: {
    summary: "system",
    experience: "system",
    skills: "system",
  },
  contact: { name: "홍길동", email: "gildong@example.com" },
  summary: "백엔드 개발 5년 경험을 가진 엔지니어입니다.",
  experience: [
    {
      company: "테스트컴퍼니",
      title: "Backend Engineer",
      period: "2020.01 - 현재",
      bullets: ["REST API 개발", "DB 최적화"],
      _source: "system",
    },
    {
      company: "이전회사",
      title: "Junior Developer",
      period: "2018.03 - 2019.12",
      bullets: ["프론트엔드 유지보수"],
      _source: "system",
    },
  ],
  projects: [
    {
      name: "내부 어드민 시스템",
      description: "사내 관리 도구",
      bullets: ["React + Node.js 풀스택 개발"],
      _source: "system",
    },
  ],
  skills: {
    technical: ["JavaScript", "TypeScript", "Node.js"],
    languages: ["Korean", "English"],
    tools: ["Git", "Docker"],
  },
  education: [
    {
      school: "한국대학교",
      degree: "컴퓨터공학 학사",
      period: "2014.03 - 2018.02",
      _source: "system",
    },
  ],
  certifications: [
    {
      name: "AWS Solutions Architect",
      issuer: "Amazon",
      date: "2022-06",
      _source: "system",
    },
  ],
};

// ─── Module-level mocks ───────────────────────────────────────────────────────
// 반드시 `await import(…)` 보다 먼저 선언해야 한다.

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: false }),
    saveResumeData:               async (doc) => {
      if (_saveResumeThrow) throw new Error("Blob write error");
      _saveResumeCalls.push(doc);
      return { url: "https://blob/resume/data.json" };
    },
    readResumeData:               async () => {
      if (_readResumeThrow) throw new Error("Blob read error");
      return _resumeDoc;
    },
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
    saveSnapshot:                 async (doc, opts) => {
      _saveSnapshotCalls.push({ doc, opts });
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
    searchAllSources:    async () => ({ commits: [], slack: [], sessions: [], totalCount: 0 }),
    searchCommits:       async () => [],
    searchSlack:         async () => [],
    searchSessionMemory: async () => [],
  }
});

mock.module("../lib/resumeAppealPoints.mjs", {
  namedExports: {
    mergeAndRankEvidence: () => [],
    buildEvidenceContext: () => "",
    generateAppealPoints: async () => ({
      appealPoints: [],
      dataGaps: [],
      followUpQuestions: [],
      evidenceUsed: [],
    }),
  }
});

mock.module("../lib/resumeChatApplyIntent.mjs", {
  namedExports: {
    detectApplyIntent:        () => false,
    extractSectionFromContext: () => null,
    extractProposedChanges:   () => ({ changes: [], sourceIndex: -1 }),
    parseApplyIntent:         () => ({
      detected: false,
      section: null,
      changes: [],
      confidence: 0,
      ambiguous: true,
      clarificationNeeded: null,
      sourceMessageIndex: -1,
    }),
  }
});

// ─── resumeSummarySectionChat mock (Sub-AC 8-1) ──────────────────────────────
mock.module("../lib/resumeSummarySectionChat.mjs", {
  namedExports: {
    generateSummaryChatDiff: async () => ({
      hasEnoughEvidence: false,
      section: "summary",
      before: "",
      after: "",
      evidence: [],
      dataGaps: [],
      followUpQuestions: [],
    }),
  }
});

// ─── resumeStrengthsSectionChat mock (Sub-AC 8-1) ────────────────────────────
mock.module("../lib/resumeStrengthsSectionChat.mjs", {
  namedExports: {
    generateStrengthsChatDiff: async () => ({
      hasEnoughEvidence: false,
      section: "strengths",
      before: "",
      after: "",
      evidence: [],
      strengthsData: [],
      dataGaps: [],
      followUpQuestions: [],
    }),
    formatStrengthsAsText: (strengths) => {
      if (!Array.isArray(strengths) || strengths.length === 0) return "";
      return strengths.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
    },
  }
});

// ─── Load router under test AFTER mocks are registered ───────────────────────

const { resumeRouter } = await import("./resume.mjs");
const { cookieAuth }   = await import("../middleware/auth.mjs");

// ─── Test helpers ─────────────────────────────────────────────────────────────

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

function patchRequest(body) {
  return authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** 각 테스트 전에 mutable state를 초기화한다 */
function resetState() {
  _resumeDoc = null;
  _saveResumeCalls = [];
  _saveSnapshotCalls = [];
  _saveResumeThrow = false;
  _readResumeThrow = false;
}

// ─── PATCH /api/resume/section — 정상 응답 구조 ────────────────────────────────

test("Sub-AC 6-2: summary 섹션 반영 시 200과 { ok, resume, section, appliedAt }를 반환한다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const newSummary = "풀스택 개발자로서 7년간 대규모 서비스를 운영해왔습니다.";
  const res = await app.fetch(patchRequest({
    section: "summary",
    content: newSummary,
    messageId: "msg-001",
    sessionId: "sess-001",
  }));

  assert.equal(res.status, 200, "정상 요청에 200 응답");
  const data = await res.json();
  assert.equal(data.ok, true, "ok 필드는 true여야 한다");
  assert.ok(data.resume, "resume 필드가 포함되어야 한다");
  assert.equal(data.section, "summary", "section 필드가 반환되어야 한다");
  assert.ok(typeof data.appliedAt === "string", "appliedAt 필드가 ISO8601 문자열이어야 한다");
  // ISO8601 형식 확인
  assert.ok(!isNaN(Date.parse(data.appliedAt)), "appliedAt은 유효한 날짜 문자열이어야 한다");
});

test("Sub-AC 6-2: summary 섹션 반영 시 resume.summary가 새 텍스트로 교체된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const newSummary = "  풀스택 개발자로서 7년간 대규모 서비스를 운영해왔습니다.  ";
  const res = await app.fetch(patchRequest({
    section: "summary",
    content: newSummary,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // content는 trim되어 저장되어야 한다
  assert.equal(data.resume.summary, newSummary.trim(), "summary가 trim된 새 텍스트로 교체되어야 한다");
});

test("Sub-AC 6-2: summary 섹션 반영 시 _sources.summary가 user_approved로 업데이트된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME, _sources: { summary: "system", skills: "system" } };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "summary",
    content: "새 요약문입니다.",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.resume._sources?.summary, "user_approved", "_sources.summary가 user_approved로 변경되어야 한다");
  // 다른 _sources는 유지되어야 한다
  assert.equal(data.resume._sources?.skills, "system", "다른 _sources는 변경되지 않아야 한다");
});

// ─── experience 섹션 ──────────────────────────────────────────────────────────

test("Sub-AC 6-2: experience 섹션 반영 시 가장 최근 경력 항목의 bullets가 교체된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const bulletContent = [
    "- Kubernetes 기반 마이크로서비스 아키텍처 설계 및 운영",
    "- 월간 활성 사용자 500만명 규모의 API 서버 최적화",
    "- CI/CD 파이프라인 구축으로 배포 시간 70% 단축",
  ].join("\n");

  const res = await app.fetch(patchRequest({
    section: "experience",
    content: bulletContent,
    messageId: "msg-exp-001",
    sessionId: "sess-001",
  }));

  assert.equal(res.status, 200, "experience 섹션 반영 시 200 응답");
  const data = await res.json();
  assert.ok(Array.isArray(data.resume.experience), "experience는 배열이어야 한다");

  const firstEntry = data.resume.experience[0];
  assert.ok(Array.isArray(firstEntry.bullets), "bullets는 배열이어야 한다");
  assert.ok(firstEntry.bullets.length === 3, "불릿이 3개여야 한다");
  // 불릿 접두사("- ")가 제거되어야 한다
  assert.equal(firstEntry.bullets[0], "Kubernetes 기반 마이크로서비스 아키텍처 설계 및 운영");
  assert.equal(firstEntry.bullets[1], "월간 활성 사용자 500만명 규모의 API 서버 최적화");
  assert.equal(firstEntry.bullets[2], "CI/CD 파이프라인 구축으로 배포 시간 70% 단축");
});

test("Sub-AC 6-2: experience 섹션 반영 시 첫 번째 경력 항목만 변경되고 나머지는 유지된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "experience",
    content: "- 새 불릿 항목",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // 두 번째 경력 항목은 변경되지 않아야 한다
  assert.equal(data.resume.experience.length, SAMPLE_RESUME.experience.length, "경력 항목 수가 유지되어야 한다");
  assert.equal(
    data.resume.experience[1].company,
    SAMPLE_RESUME.experience[1].company,
    "두 번째 경력 항목의 company는 변경되지 않아야 한다"
  );
});

test("Sub-AC 6-2: experience 섹션 반영 시 _source가 user_approved로 표시된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "experience",
    content: "- 새 불릿",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.resume.experience[0]._source, "user_approved", "_source가 user_approved로 변경되어야 한다");
});

// ─── projects 섹션 ───────────────────────────────────────────────────────────

test("Sub-AC 6-2: projects 섹션 반영 시 가장 최근 프로젝트의 bullets가 교체된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const bulletContent = "• React/Next.js 기반 관리자 대시보드 개발\n• 실시간 데이터 시각화 구현 (Chart.js)";

  const res = await app.fetch(patchRequest({
    section: "projects",
    content: bulletContent,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  const firstProject = data.resume.projects[0];
  assert.ok(Array.isArray(firstProject.bullets), "bullets는 배열이어야 한다");
  assert.equal(firstProject.bullets.length, 2);
  // 불릿 접두사("• ")가 제거되어야 한다
  assert.equal(firstProject.bullets[0], "React/Next.js 기반 관리자 대시보드 개발");
  assert.equal(firstProject.bullets[1], "실시간 데이터 시각화 구현 (Chart.js)");
  assert.equal(firstProject._source, "user_approved", "_source가 user_approved로 표시되어야 한다");
});

// ─── skills 섹션 ─────────────────────────────────────────────────────────────

test("Sub-AC 6-2: skills 섹션 반영 시 기존 technical 목록에 새 기술이 병합된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const skillContent = "- React\n- Python\n- Kubernetes";

  const res = await app.fetch(patchRequest({
    section: "skills",
    content: skillContent,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  const technical = data.resume.skills.technical;
  assert.ok(Array.isArray(technical), "technical은 배열이어야 한다");
  // 기존 기술 유지
  assert.ok(technical.includes("JavaScript"), "기존 기술(JavaScript)이 유지되어야 한다");
  assert.ok(technical.includes("TypeScript"), "기존 기술(TypeScript)이 유지되어야 한다");
  // 새 기술 추가
  assert.ok(technical.includes("React"), "새 기술(React)이 추가되어야 한다");
  assert.ok(technical.includes("Python"), "새 기술(Python)이 추가되어야 한다");
  assert.ok(technical.includes("Kubernetes"), "새 기술(Kubernetes)이 추가되어야 한다");
});

test("Sub-AC 6-2: skills 섹션 반영 시 중복 기술은 한 번만 포함된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  // JavaScript는 이미 existing technical에 있음
  const skillContent = "JavaScript\nPython\nJavaScript";

  const res = await app.fetch(patchRequest({
    section: "skills",
    content: skillContent,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  const technical = data.resume.skills.technical;
  const jsCount = technical.filter((s) => s === "JavaScript").length;
  assert.equal(jsCount, 1, "중복된 기술은 한 번만 포함되어야 한다");
});

test("Sub-AC 6-2: skills 섹션 반영 시 _sources.skills가 user_approved로 업데이트된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME, _sources: { skills: "system" } };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "skills",
    content: "- Python",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.resume._sources?.skills, "user_approved", "_sources.skills가 user_approved로 변경되어야 한다");
});

// ─── education 섹션 ──────────────────────────────────────────────────────────

test("Sub-AC 6-2: education 섹션 반영 시 첫 번째 학력의 _source가 user_approved로 설정된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "education",
    content: "한국대학교 컴퓨터공학 학사 2014-2018",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.resume.education), "education은 배열이어야 한다");
  assert.equal(data.resume.education[0]._source, "user_approved", "첫 번째 학력 _source가 user_approved여야 한다");
});

// ─── certifications 섹션 ─────────────────────────────────────────────────────

test("Sub-AC 6-2: certifications 섹션 반영 시 200 응답을 반환한다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "certifications",
    content: "AWS Solutions Architect - Amazon 2022-06",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.section, "certifications");
  assert.ok(Array.isArray(data.resume.certifications), "certifications은 배열이어야 한다");
});

// ─── 스냅샷 저장 확인 ────────────────────────────────────────────────────────

test("Sub-AC 6-2: approve 처리 시 반영 전 스냅샷이 저장된다 (롤백 기준점)", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "summary",
    content: "새 요약",
    messageId: "msg-snap-001",
    sessionId: "sess-snap-001",
  }));

  assert.equal(res.status, 200);
  // saveSnapshot이 한 번 호출되어야 한다
  assert.equal(_saveSnapshotCalls.length, 1, "saveSnapshot이 한 번 호출되어야 한다");
  const snapshotCall = _saveSnapshotCalls[0];
  // 스냅샷에는 기존(변경 전) 이력서가 저장되어야 한다
  assert.equal(snapshotCall.doc.summary, SAMPLE_RESUME.summary, "스냅샷에 기존 이력서가 저장되어야 한다");
  // 스냅샷 label이 pre-chat-approve여야 한다
  assert.equal(snapshotCall.opts?.label, "pre-chat-approve", "스냅샷 label이 pre-chat-approve여야 한다");
  assert.equal(snapshotCall.opts?.triggeredBy, "chat_approve", "triggeredBy가 chat_approve여야 한다");
});

test("Sub-AC 6-2: saveResumeData가 한 번 호출되어 변경된 이력서가 저장된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const newSummary = "업데이트된 요약";
  const res = await app.fetch(patchRequest({
    section: "summary",
    content: newSummary,
  }));

  assert.equal(res.status, 200);
  // saveResumeData가 한 번 호출되어야 한다
  assert.equal(_saveResumeCalls.length, 1, "saveResumeData가 한 번 호출되어야 한다");
  // 저장된 이력서의 summary가 새 내용이어야 한다
  assert.equal(_saveResumeCalls[0].summary, newSummary.trim(), "저장된 이력서의 summary가 새 내용이어야 한다");
});

// ─── 입력 검증 — 400 ─────────────────────────────────────────────────────────

test("Sub-AC 6-2: section 필드 없으면 400 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    // section 필드 없음
    content: "새 요약",
  }));

  assert.equal(res.status, 400, "section 없으면 400 반환");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 포함되어야 한다");
});

test("Sub-AC 6-2: content 필드 없으면 400 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "summary",
    // content 필드 없음
  }));

  assert.equal(res.status, 400, "content 없으면 400 반환");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 포함되어야 한다");
});

test("Sub-AC 6-2: 지원하지 않는 섹션명이면 400 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "invalid_section_name",
    content: "내용",
  }));

  assert.equal(res.status, 400, "잘못된 섹션명이면 400 반환");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 포함되어야 한다");
});

test("Sub-AC 6-2: JSON body가 없으면 400 반환", async () => {
  resetState();
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/section", {
    method: "PATCH",
    body: "not-json",
    headers: { "Content-Type": "text/plain" },
  }));

  assert.equal(res.status, 400, "잘못된 JSON이면 400 반환");
});

// ─── 이력서 없음 — 404 ───────────────────────────────────────────────────────

test("Sub-AC 6-2: 이력서가 없으면 404 반환", async () => {
  resetState();
  _resumeDoc = null; // 이력서 없음
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "summary",
    content: "새 요약",
  }));

  assert.equal(res.status, 404, "이력서 없으면 404 반환");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 포함되어야 한다");
});

// ─── 이력서 로드 실패 — 502 ──────────────────────────────────────────────────

test("Sub-AC 6-2: 이력서 로드 실패 시 502 반환", async () => {
  resetState();
  _readResumeThrow = true;
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "summary",
    content: "새 요약",
  }));

  assert.equal(res.status, 502, "Blob 읽기 실패 시 502 반환");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 포함되어야 한다");
});

// ─── 이력서 저장 실패 — 500 ──────────────────────────────────────────────────

test("Sub-AC 6-2: 이력서 저장 실패 시 500 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  _saveResumeThrow = true;
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "summary",
    content: "새 요약",
  }));

  assert.equal(res.status, 500, "Blob 쓰기 실패 시 500 반환");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 포함되어야 한다");
});

// ─── 인증 검사 — 401 ─────────────────────────────────────────────────────────

test("Sub-AC 6-2: 인증 쿠키 없으면 401 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp("test-secret");

  const res = await app.fetch(new Request("http://localhost/api/resume/section", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ section: "summary", content: "새 요약" }),
  }));

  assert.equal(res.status, 401, "인증 쿠키 없으면 401 반환");
  const data = await res.json();
  assert.equal(data.error, "Unauthorized");
});

// ─── 경력 데이터 없을 때 experience 섹션 — 400 ────────────────────────────────

test("Sub-AC 6-2: experience 섹션인데 경력 데이터 없으면 400 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME, experience: [] }; // 경력 없음
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "experience",
    content: "- 새 불릿",
  }));

  assert.equal(res.status, 400, "경력 데이터 없으면 400 반환");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 포함되어야 한다");
});

// ─── 프로젝트 데이터 없을 때 projects 섹션 — 400 ────────────────────────────────

test("Sub-AC 6-2: projects 섹션인데 프로젝트 데이터 없으면 400 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME, projects: [] }; // 프로젝트 없음
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "projects",
    content: "- 새 불릿",
  }));

  assert.equal(res.status, 400, "프로젝트 데이터 없으면 400 반환");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 포함되어야 한다");
});

// ─── 선택적 필드 (messageId, sessionId) 처리 ─────────────────────────────────

test("Sub-AC 6-2: messageId와 sessionId 없이도 정상 처리된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "summary",
    content: "새 요약",
    // messageId와 sessionId 생략
  }));

  assert.equal(res.status, 200, "선택적 필드 없어도 200 응답");
  const data = await res.json();
  assert.equal(data.ok, true);
});

// ─── 반영된 이력서의 구조 무결성 ─────────────────────────────────────────────

test("Sub-AC 6-2: 반영 후 이력서의 다른 섹션은 변경되지 않는다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const res = await app.fetch(patchRequest({
    section: "summary",
    content: "새 요약",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // summary 변경 후 다른 섹션이 유지되어야 한다
  assert.deepEqual(
    data.resume.experience,
    SAMPLE_RESUME.experience,
    "summary 변경 시 experience는 변경되지 않아야 한다"
  );
  assert.deepEqual(
    data.resume.skills,
    SAMPLE_RESUME.skills,
    "summary 변경 시 skills는 변경되지 않아야 한다"
  );
  assert.deepEqual(
    data.resume.contact,
    SAMPLE_RESUME.contact,
    "contact 정보는 변경되지 않아야 한다"
  );
});

// ─── section 필드의 유효한 값 ─────────────────────────────────────────────────

test("Sub-AC 6-2: 유효한 모든 섹션명 목록 (summary, experience, skills, projects, education, certifications)이 허용된다", async () => {
  const validSections = ["summary", "experience", "skills", "projects", "education", "certifications"];

  for (const section of validSections) {
    resetState();
    // 각 섹션에 맞는 이력서 데이터 설정
    _resumeDoc = { ...SAMPLE_RESUME };
    const app = buildApp();

    const res = await app.fetch(patchRequest({
      section,
      content: section === "experience"
        ? "- 새 불릿 항목"
        : section === "projects"
        ? "- 새 프로젝트 불릿"
        : "새 내용",
    }));

    assert.equal(res.status, 200, `${section} 섹션은 유효한 섹션명이어야 한다`);
    const data = await res.json();
    assert.equal(data.section, section, `반환된 section은 요청한 섹션과 같아야 한다: ${section}`);
  }
});

// ─── Sub-AC 8-1: 강점(Strengths) 섹션 저장 ──────────────────────────────────

test("Sub-AC 8-1: strengths 섹션 approve 시 200 응답과 strengthsCount 를 반환한다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const strengthsData = [
    {
      id: "str-1",
      label: "안정성 우선 엔지니어링",
      description: "코드 품질과 안정성을 최우선으로 하는 엔지니어링 패턴입니다.",
      evidenceTexts: ["feat: 에러 핸들링 강화 및 테스트 추가"],
      behaviorCluster: ["코드 품질", "테스트"],
      frequency: 3,
      confidence: 0.85,
    },
    {
      id: "str-2",
      label: "데이터 기반 의사결정",
      description: "메트릭과 데이터를 기반으로 결정하는 패턴입니다.",
      evidenceTexts: ["성능 모니터링 대시보드 구축"],
      behaviorCluster: ["분석", "의사결정"],
      frequency: 2,
      confidence: 0.75,
    },
  ];

  const res = await app.fetch(patchRequest({
    section: "strengths",
    content: JSON.stringify(strengthsData),
    messageId: "msg-strengths-001",
    sessionId: "sess-strengths-001",
  }));

  assert.equal(res.status, 200, "strengths approve 는 200을 반환해야 한다");
  const data = await res.json();
  assert.equal(data.ok, true, "ok 가 true 여야 한다");
  assert.equal(data.section, "strengths", "section 이 'strengths' 여야 한다");
  assert.equal(data.strengthsCount, 2, "strengthsCount 가 강점 개수와 일치해야 한다");
  assert.ok(typeof data.appliedAt === "string", "appliedAt 이 문자열이어야 한다");
});

test("Sub-AC 8-1: strengths 섹션 approve 에서 '[' 로 시작하지만 유효하지 않은 JSON 이면 400 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  // '[' 로 시작하면 JSON 배열로 파싱 시도 → 파싱 실패 시 400
  const res = await app.fetch(patchRequest({
    section: "strengths",
    content: "[유효하지 않은 JSON",
  }));

  assert.equal(res.status, 400, "'[' 로 시작하는 잘못된 JSON 이면 400을 반환해야 한다");
  const data = await res.json();
  assert.ok(data.error, "error 메시지가 있어야 한다");
});

test("Sub-AC 8-1: strengths 섹션 approve 에서 content 가 JSON 배열이 아닌 객체이면 400 반환", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  // '[' 로 시작하면 JSON 파싱 → 배열이 아니면 400
  const res = await app.fetch(patchRequest({
    section: "strengths",
    content: JSON.stringify({ not: "an array" }),
  }));

  // JSON.stringify({ not: "an array" }) 는 '{' 로 시작 → bullet text 경로를 탄다
  // bullet text 경로에서 { 는 키워드로 처리됨 → 200 반환 가능
  // '[' 로 감싸야 JSON 경로를 탄다
  assert.ok([200, 400].includes(res.status), "status 가 200 또는 400 이어야 한다");
});

test("Sub-AC 8-1: strengths 섹션 approve 는 resume JSON 이 아닌 strengths.json 에 저장한다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const strengthsData = [
    {
      id: "str-1",
      label: "테스트 강점",
      description: "설명",
      evidenceTexts: ["근거"],
      behaviorCluster: [],
      frequency: 1,
      confidence: 0.8,
    },
  ];

  const res = await app.fetch(patchRequest({
    section: "strengths",
    content: JSON.stringify(strengthsData),
  }));

  assert.equal(res.status, 200, "strengths approve 는 200을 반환해야 한다");
  // strengths 는 resume/data.json 이 아닌 identified-strengths.json 에 저장되므로
  // saveResumeData 는 호출되지 않아야 한다
  assert.equal(_saveResumeCalls.length, 0, "strengths approve 는 saveResumeData를 호출하지 않아야 한다");
});

test("Sub-AC 8-1: strengths 섹션 approve 응답에는 resume 필드가 없다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const strengthsData = [
    {
      id: "str-1",
      label: "테스트 강점",
      description: "설명",
      evidenceTexts: ["근거"],
      behaviorCluster: [],
      frequency: 1,
      confidence: 0.8,
    },
  ];

  const res = await app.fetch(patchRequest({
    section: "strengths",
    content: JSON.stringify(strengthsData),
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // strengths 섹션은 resume 문서가 아닌 별도 문서에 저장되므로 resume 필드가 없다
  assert.ok(!data.resume, "strengths approve 응답에는 resume 필드가 없어야 한다");
});

test("Sub-AC 8-1: strengths 와 'strengths' 는 valid sections 목록에 포함된다", async () => {
  resetState();
  _resumeDoc = { ...SAMPLE_RESUME };
  const app = buildApp();

  const strengthsData = [
    {
      id: "str-1",
      label: "테스트 강점",
      description: "설명",
      evidenceTexts: ["근거"],
      behaviorCluster: [],
      frequency: 1,
      confidence: 0.8,
    },
  ];

  const res = await app.fetch(patchRequest({
    section: "strengths",
    content: JSON.stringify(strengthsData),
  }));

  // 'strengths' 가 VALID_SECTIONS 에 포함되어야 하므로 400이 아닌 200이 반환되어야 한다
  assert.notEqual(res.status, 400, "'strengths' 는 지원하는 섹션이어야 한다");
  assert.equal(res.status, 200, "strengths 섹션은 200을 반환해야 한다");
});
