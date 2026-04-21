/**
 * Tests for Sub-AC 7-3: diff 뷰 approve/reject → 섹션 반영 → 큐 자동 진행 플로우
 *
 * 큐 기반 순차 섹션 승인 흐름을 검증한다:
 *   1. 여러 섹션을 순서대로 승인(approve)하면 각각 PATCH 로 반영된다
 *   2. 각 반영은 직전 반영 결과를 기반으로 누적된다 (이력서 상태 누적)
 *   3. 중간에 reject 가 있어도 승인된 섹션만 반영된다
 *   4. 동일 세션 내 여러 섹션이 순서대로 처리되면 최종 이력서에 모두 반영된다
 *
 * 이 테스트는 백엔드 PATCH /api/resume/section 엔드포인트가
 * 순차 호출 시 올바르게 동작함을 보장한다.
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.section.queue.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable mock state ───────────────────────────────────────────────────────

/** PATCH 요청마다 저장된 이력서 상태를 추적 — 순차 처리를 검증하기 위해 배열로 보관 */
let _savedResumes = [];

/** 현재 이력서 상태 — readResumeData() 는 이 값을 반환하고, saveResumeData() 는 이를 갱신한다 */
let _currentResume = null;

/** saveSnapshot() 호출 기록 */
let _snapshotCount = 0;

/** readResumeData() 강제 실패 */
let _readShouldFail = false;

// ─── 초기 이력서 픽스처 ────────────────────────────────────────────────────────

const BASE_RESUME = {
  schemaVersion: 1,
  meta: { language: "ko", source: "pdf", generatedAt: "2024-01-01T00:00:00.000Z" },
  contact: { name: "홍길동", email: "hong@example.com" },
  summary: "기존 자기소개입니다.",
  experience: [
    {
      _source: "system",
      company: "테스트 회사",
      title: "백엔드 개발자",
      start_date: "2022-01",
      end_date: "present",
      bullets: ["기존 경력 불릿 1", "기존 경력 불릿 2"],
    },
  ],
  education: [
    {
      _source: "system",
      institution: "한국대학교",
      degree: "컴퓨터공학 학사",
      field: "컴퓨터공학",
    },
  ],
  skills: {
    technical: ["JavaScript", "TypeScript"],
    languages: ["Korean"],
    tools: ["Git"],
  },
  projects: [
    {
      _source: "system",
      name: "테스트 프로젝트",
      description: "프로젝트 설명",
      bullets: ["기존 프로젝트 불릿"],
    },
  ],
  certifications: [],
};

// ─── Module-level mocks ───────────────────────────────────────────────────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: true }),
    saveResumeData:               async (doc) => {
      // saveResumeData는 _currentResume을 갱신하고 호출 기록을 남긴다
      _currentResume = JSON.parse(JSON.stringify(doc)); // deep copy
      _savedResumes.push(JSON.parse(JSON.stringify(doc)));
      return { url: "https://blob/resume/data.json" };
    },
    readResumeData:               async () => {
      if (_readShouldFail) throw new Error("Blob read error");
      return _currentResume ? JSON.parse(JSON.stringify(_currentResume)) : null;
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
    saveSnapshot:                 async () => {
      _snapshotCount++;
      return { snapshotKey: `resume/snapshots/test-${_snapshotCount}.json`, url: "https://blob/test" };
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
    saveChatDraft:                 async () => ({ url: "https://blob/resume/chat-draft.json" }),
    readChatDraft:                 async () => null,
    saveChatDraftContext:          async () => ({ url: "https://blob/resume/chat-draft-context.json" }),
    readChatDraftContext:          async () => null,
    saveSession:                   async () => ({ url: "blob://session" }),
    readSession:                   async () => null,
    deleteSession:                 async () => {},
  }
});

// ─── 기타 필수 mock (resume.mjs 의존성) ─────────────────────────────────────────

mock.module("../lib/resumeBootstrap.mjs", {
  namedExports: {
    bootstrapFromPdf: async () => ({ schemaVersion: 1, contact: {}, summary: "", experience: [], skills: {}, education: [], projects: [] }),
    pdfToResumeDocument: async () => ({ schemaVersion: 1 }),
  }
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

mock.module("../lib/profile.mjs", {
  namedExports: { buildProfile: async () => null }
});

mock.module("../lib/workLog.mjs", {
  namedExports: { readWorkLogEntries: async () => [] }
});

mock.module("../lib/linkedinFileParser.mjs", {
  namedExports: { parseLinkedInProfileFile: async () => null }
});

mock.module("../lib/resumeReconstruction.mjs", {
  namedExports: {
    reconstructResume:        async (resume) => resume,
    reconstructResumePartial: async (resume) => resume,
  }
});

mock.module("../lib/resumeWorkLogExtract.mjs", {
  namedExports: {
    resumeWorkLogExtract: async () => ({}),
    buildWorkLogDiff:     () => [],
    applyDiffToResume:    (resume) => resume,
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

mock.module("../lib/openai.mjs", {
  namedExports: {
    openaiChat: async () => "AI 응답",
    OPENAI_MODEL: "gpt-4o-mini",
  }
});

// ─── Load router under test AFTER mocks are registered ───────────────────────

const { resumeRouter } = await import("./resume.mjs");
const { cookieAuth }   = await import("../middleware/auth.mjs");

// ─── Test helpers ─────────────────────────────────────────────────────────────

function buildApp() {
  process.env.RESUME_TOKEN = "test-secret";
  const app = new Hono();
  app.use("/api/resume/*", cookieAuth());
  app.route("/api/resume", resumeRouter);
  return app;
}

function authedPatch(body) {
  const headers = new Headers();
  headers.set("cookie", "resume_token=test-secret");
  headers.set("Content-Type", "application/json");
  return new Request("http://localhost/api/resume/section", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

function resetState() {
  _savedResumes = [];
  _currentResume = JSON.parse(JSON.stringify(BASE_RESUME));
  _snapshotCount = 0;
  _readShouldFail = false;
}

// ─── Sub-AC 7-3: 순차 섹션 승인 (큐 자동 진행) ───────────────────────────────────

/**
 * 큐 자동 진행 시나리오:
 *   summary → experience → skills 순서로 PATCH 요청이 순차적으로 도착한다.
 *   각 요청은 직전 요청의 결과(갱신된 이력서)를 기반으로 처리된다.
 *   최종 이력서에는 세 섹션 모두의 변경이 누적되어 있어야 한다.
 */

test("Sub-AC 7-3: summary → experience → skills 순서로 3개 섹션을 순차 승인하면 각각 반영된다", async () => {
  resetState();
  const app = buildApp();
  const sessionId = "sess-queue-7-3";

  // ── 1단계: summary 섹션 승인 ─────────────────────────────────────────────
  const newSummary = "백엔드 엔지니어로 7년간 핀테크 서비스를 설계·운영했습니다.";
  const res1 = await app.fetch(authedPatch({
    section: "summary",
    content: newSummary,
    messageId: "msg-summary-001",
    sessionId,
  }));

  assert.equal(res1.status, 200, "1단계 summary 반영이 200이어야 한다");
  const data1 = await res1.json();
  assert.equal(data1.ok, true, "ok 필드가 true여야 한다");
  assert.equal(data1.resume.summary, newSummary, "summary 가 새 텍스트로 교체되어야 한다");

  // ── 2단계: experience 섹션 승인 (누적 상태 기반) ─────────────────────────
  const newExperienceBullets = [
    "• REST API 설계 및 마이크로서비스 아키텍처 전환 (트래픽 3배 증가 대응)",
    "• Kubernetes 기반 컨테이너 오케스트레이션 도입 (배포 시간 80% 단축)",
  ].join("\n");
  const res2 = await app.fetch(authedPatch({
    section: "experience",
    content: newExperienceBullets,
    messageId: "msg-exp-001",
    sessionId,
  }));

  assert.equal(res2.status, 200, "2단계 experience 반영이 200이어야 한다");
  const data2 = await res2.json();
  assert.equal(data2.ok, true, "ok 필드가 true여야 한다");

  // 누적 확인: summary 는 1단계에서 반영된 값이 유지되어야 한다
  assert.equal(data2.resume.summary, newSummary,
    "2단계 이후에도 summary 는 1단계에서 반영된 값을 유지해야 한다");

  // experience 첫 번째 항목의 bullets 가 교체되었는지 확인
  const expBullets = data2.resume.experience[0].bullets;
  assert.ok(Array.isArray(expBullets), "experience[0].bullets 가 배열이어야 한다");
  assert.ok(expBullets.some(b => b.includes("REST API")), "새 experience 불릿이 포함되어야 한다");

  // ── 3단계: skills 섹션 승인 (누적 상태 기반) ─────────────────────────────
  const newSkills = "Node.js, TypeScript, React, Kubernetes, PostgreSQL, Redis";
  const res3 = await app.fetch(authedPatch({
    section: "skills",
    content: newSkills,
    messageId: "msg-skills-001",
    sessionId,
  }));

  assert.equal(res3.status, 200, "3단계 skills 반영이 200이어야 한다");
  const data3 = await res3.json();
  assert.equal(data3.ok, true, "ok 필드가 true여야 한다");

  // 누적 확인: summary 와 experience 는 이전 단계에서 반영된 값이 유지되어야 한다
  assert.equal(data3.resume.summary, newSummary,
    "3단계 이후에도 summary 는 1단계 값을 유지해야 한다");
  const finalExpBullets = data3.resume.experience[0].bullets;
  assert.ok(finalExpBullets.some(b => b.includes("REST API")),
    "3단계 이후에도 experience 불릿은 2단계 값을 유지해야 한다");

  // skills 에 새 기술이 추가되었는지 확인
  const technical = data3.resume.skills.technical;
  assert.ok(Array.isArray(technical), "skills.technical 이 배열이어야 한다");
  assert.ok(technical.some(s => s.toLowerCase().includes("kubernetes")),
    "Kubernetes 가 기술 목록에 추가되어야 한다");

  // ── 최종 saveResumeData 호출 횟수 확인 ───────────────────────────────────
  // 3번의 PATCH 요청 → 3번의 저장
  assert.equal(_savedResumes.length, 3,
    "3개 섹션 승인에 대해 saveResumeData 가 정확히 3번 호출되어야 한다");
});

test("Sub-AC 7-3: 각 섹션 승인마다 스냅샷이 독립적으로 저장된다 (롤백 기준점)", async () => {
  resetState();
  const app = buildApp();
  const sessionId = "sess-snapshot-7-3";

  // summary 승인
  await app.fetch(authedPatch({ section: "summary", content: "첫 번째 자기소개", messageId: "msg-a", sessionId }));
  // skills 승인
  await app.fetch(authedPatch({ section: "skills", content: "Python, Django", messageId: "msg-b", sessionId }));

  // 각 PATCH 마다 스냅샷이 저장된다
  assert.equal(_snapshotCount, 2,
    "2개 섹션 승인에 대해 각각 스냅샷이 저장되어야 한다 (롤백 기준점)");
});

test("Sub-AC 7-3: 첫 번째 섹션 승인 후 두 번째 섹션이 거절된 경우 — 첫 번째 변경만 최종 이력서에 반영된다", async () => {
  resetState();
  const app = buildApp();
  const sessionId = "sess-reject-7-3";

  // ── 1단계: summary 승인 ───────────────────────────────────────────────────
  const approvedSummary = "승인된 자기소개 문장입니다.";
  const res1 = await app.fetch(authedPatch({
    section: "summary",
    content: approvedSummary,
    messageId: "msg-approve",
    sessionId,
  }));
  assert.equal(res1.status, 200, "summary 승인이 200이어야 한다");

  // ── 2단계: experience 거절 (프론트엔드에서 PATCH 를 호출하지 않음) ─────────
  // reject 는 서버 호출 없이 클라이언트에서 diffStatus 만 'rejected' 로 변경한다.
  // 따라서 이 테스트는 PATCH 를 호출하지 않고 이력서 상태를 직접 확인한다.

  // ── 최종 확인: 저장된 이력서가 1건 (summary 만 반영됨) ─────────────────────
  assert.equal(_savedResumes.length, 1,
    "거절된 섹션은 PATCH 를 호출하지 않으므로 저장 횟수는 1이어야 한다");
  assert.equal(_currentResume.summary, approvedSummary,
    "최종 이력서에는 승인된 summary 가 반영되어야 한다");

  // experience 는 BASE_RESUME 의 원래 값이 유지되어야 한다
  const finalExperience = _currentResume.experience;
  assert.ok(
    finalExperience[0].bullets.includes("기존 경력 불릿 1"),
    "거절된 experience 는 원래 값이 유지되어야 한다"
  );
});

test("Sub-AC 7-3: 승인→거절→승인 패턴으로 큐가 진행되면 승인된 섹션만 반영된다", async () => {
  resetState();
  const app = buildApp();
  const sessionId = "sess-pattern-7-3";

  // summary 승인 (1번째 승인)
  const res1 = await app.fetch(authedPatch({
    section: "summary",
    content: "새 자기소개",
    messageId: "msg-1",
    sessionId,
  }));
  assert.equal(res1.status, 200, "summary 승인이 200이어야 한다");

  // experience 는 거절됨 → PATCH 없음

  // skills 승인 (2번째 승인)
  const res3 = await app.fetch(authedPatch({
    section: "skills",
    content: "Go, Rust, Python",
    messageId: "msg-3",
    sessionId,
  }));
  assert.equal(res3.status, 200, "skills 승인이 200이어야 한다");

  // 총 저장 횟수: 2 (summary + skills)
  assert.equal(_savedResumes.length, 2, "승인된 2개 섹션에 대해 저장이 2번 이루어져야 한다");

  // summary 는 새 값으로 교체됨
  assert.equal(_currentResume.summary, "새 자기소개",
    "승인된 summary 가 반영되어야 한다");

  // skills 에 Go 추가됨
  const tech = _currentResume.skills.technical;
  assert.ok(tech.some(s => s === "Go" || s.toLowerCase().includes("go")),
    "승인된 skills 에 Go 가 포함되어야 한다");

  // experience 는 원래 값 유지
  assert.ok(
    _currentResume.experience[0].bullets.includes("기존 경력 불릿 1"),
    "거절된 experience 는 원래 값이 유지되어야 한다"
  );
});

test("Sub-AC 7-3: 동일 세션에서 동일 섹션을 두 번 승인하면 두 번째 승인이 최종 값이 된다", async () => {
  resetState();
  const app = buildApp();
  const sessionId = "sess-double-7-3";

  // summary 첫 번째 승인
  await app.fetch(authedPatch({
    section: "summary",
    content: "첫 번째 자기소개",
    messageId: "msg-first",
    sessionId,
  }));

  // summary 두 번째 승인 (큐에서 자동으로 처리됨)
  const res2 = await app.fetch(authedPatch({
    section: "summary",
    content: "두 번째 자기소개 (최종)",
    messageId: "msg-second",
    sessionId,
  }));

  assert.equal(res2.status, 200, "두 번째 summary 승인이 200이어야 한다");

  // 최종 이력서에는 두 번째 승인 값이 반영되어야 한다
  assert.equal(_currentResume.summary, "두 번째 자기소개 (최종)",
    "동일 섹션의 두 번째 승인 값이 최종 이력서에 반영되어야 한다");

  // 저장 횟수: 2
  assert.equal(_savedResumes.length, 2, "두 번의 승인에 대해 2번 저장되어야 한다");
});

test("Sub-AC 7-3: 섹션 승인 응답에는 현재 세션 섹션명(section)과 반영 시각(appliedAt)이 포함된다", async () => {
  resetState();
  const app = buildApp();
  const sessionId = "sess-response-7-3";

  const res = await app.fetch(authedPatch({
    section: "summary",
    content: "응답 구조 확인용 자기소개",
    messageId: "msg-resp",
    sessionId,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  // 응답 구조 검증
  assert.equal(data.ok, true, "ok 필드가 true여야 한다");
  assert.equal(data.section, "summary", "응답의 section 필드가 요청 섹션명과 일치해야 한다");
  assert.ok(typeof data.appliedAt === "string", "appliedAt 필드가 문자열이어야 한다");
  assert.ok(!isNaN(Date.parse(data.appliedAt)), "appliedAt 은 유효한 ISO8601 날짜 문자열이어야 한다");
  assert.ok(data.resume && typeof data.resume === "object", "resume 객체가 응답에 포함되어야 한다");
});
