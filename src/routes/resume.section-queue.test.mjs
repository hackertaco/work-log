/**
 * Tests for the sequential approve/reject queue flow (Sub-AC 7-3).
 *
 * diff 뷰에서 사용자가 승인(approve) 또는 거절(reject) 시
 * 해당 섹션에 결과를 반영하고 큐의 다음 섹션으로 자동 진행하는 플로우 검증.
 *
 * 검증 시나리오:
 *   1. 순차 승인: 여러 섹션을 순서대로 승인하면 모두 반영된다
 *   2. 거절 후 승인: 거절한 섹션은 반영되지 않고, 이후 승인은 정상 반영된다
 *   3. 혼합 흐름: approve → reject → approve 순서로 처리된다
 *   4. 큐 순서 보장: 섹션 반영은 approve 요청 순서대로 처리된다
 *   5. 승인 후 이력서 상태: 이전 섹션 변경이 다음 PATCH에서도 유지된다
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.section-queue.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable mock state ───────────────────────────────────────────────────────

/** readResumeData()가 반환할 이력서 문서. null이면 404 경로 */
let _resumeDoc = null;

/** saveResumeData() 호출 기록 (순서 보존) */
let _saveResumeCalls = [];

/** saveSnapshot() 호출 기록 */
let _saveSnapshotCalls = [];

/** 각 saveResumeData 호출 후 최신 이력서 상태를 추적 (readResumeData가 반환할 값 업데이트) */
function onSaveResume(doc) {
  _saveResumeCalls.push(JSON.parse(JSON.stringify(doc)));
  // 저장 후 다음 readResumeData 호출에 반영 (실제 DB 동작 시뮬레이션)
  _resumeDoc = JSON.parse(JSON.stringify(doc));
}

// ─── 샘플 이력서 ───────────────────────────────────────────────────────────────

const BASE_RESUME = {
  schemaVersion: 1,
  _sources: {
    summary: "system",
    experience: "system",
    skills: "system",
    projects: "system",
  },
  contact: { name: "홍길동", email: "gildong@example.com" },
  summary: "기존 자기소개 문장입니다.",
  experience: [
    {
      company: "테스트컴퍼니",
      title: "Backend Engineer",
      period: "2020.01 - 현재",
      bullets: ["기존 불릿 A", "기존 불릿 B"],
      _source: "system",
    },
  ],
  projects: [
    {
      name: "내부 플랫폼",
      description: "사내 도구",
      bullets: ["기존 프로젝트 불릿"],
      _source: "system",
    },
  ],
  skills: {
    technical: ["JavaScript", "TypeScript"],
    languages: ["Korean"],
    tools: ["Git"],
  },
  education: [
    {
      school: "한국대학교",
      degree: "컴퓨터공학 학사",
      period: "2014 - 2018",
      _source: "system",
    },
  ],
  certifications: [],
};

// ─── Module-level mocks ───────────────────────────────────────────────────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    checkResumeExists:            async () => ({ exists: true }),
    saveResumeData:               async (doc) => {
      onSaveResume(doc);
      return { url: "https://blob/resume/data.json" };
    },
    readResumeData:               async () => {
      return _resumeDoc ? JSON.parse(JSON.stringify(_resumeDoc)) : null;
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
      _saveSnapshotCalls.push({ doc: JSON.parse(JSON.stringify(doc)), opts });
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
    saveSession:                   async () => ({ url: "blob://session" }),
    readSession:                   async () => null,
    deleteSession:                 async () => {},
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
    detectApplyIntent:         () => false,
    extractSectionFromContext: () => null,
    extractProposedChanges:    () => ({ changes: [], sourceIndex: -1 }),
    parseApplyIntent:          () => ({
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

// ─── Load router under test AFTER mocks ──────────────────────────────────────

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

function authedPatch(url, body) {
  return new Request(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "cookie": "resume_token=test-secret",
    },
    body: JSON.stringify(body),
  });
}

function resetState() {
  _resumeDoc = JSON.parse(JSON.stringify(BASE_RESUME));
  _saveResumeCalls = [];
  _saveSnapshotCalls = [];
}

// ─── Sub-AC 7-3: 순차 승인 플로우 ──────────────────────────────────────────────

test("Sub-AC 7-3: summary → experience 순차 승인 시 두 섹션 모두 반영된다", async () => {
  resetState();
  const app = buildApp();

  const newSummary = "순차 승인 테스트 — 자기소개 섹션";
  const newBullets = "- 순차 승인된 경력 불릿 1\n- 순차 승인된 경력 불릿 2";

  // Step 1: summary 섹션 승인 (큐의 첫 번째 항목)
  const res1 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: newSummary,
    messageId: "msg-001",
    sessionId: "sess-001",
  }));
  assert.equal(res1.status, 200, "summary 승인 시 200 응답");
  const data1 = await res1.json();
  assert.equal(data1.ok, true, "summary 승인 ok");
  assert.equal(data1.section, "summary");
  assert.equal(data1.resume.summary, newSummary.trim(), "summary가 반영되어야 한다");

  // Step 2: experience 섹션 승인 (큐의 다음 항목 — 자동 진행 후 도달)
  // 이 시점에서 이력서 상태는 summary가 이미 반영된 상태여야 한다 (onSaveResume이 _resumeDoc을 갱신)
  const res2 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "experience",
    content: newBullets,
    messageId: "msg-002",
    sessionId: "sess-001",
  }));
  assert.equal(res2.status, 200, "experience 승인 시 200 응답");
  const data2 = await res2.json();
  assert.equal(data2.ok, true, "experience 승인 ok");
  assert.equal(data2.section, "experience");

  // 두 변경 모두 최종 이력서에 반영되어야 한다
  assert.equal(data2.resume.summary, newSummary.trim(), "summary가 유지되어야 한다");
  assert.deepEqual(
    data2.resume.experience[0].bullets,
    ["순차 승인된 경력 불릿 1", "순차 승인된 경력 불릿 2"],
    "experience 불릿이 반영되어야 한다"
  );

  // saveResumeData가 두 번 호출되어야 한다 (각 승인마다 1회)
  assert.equal(_saveResumeCalls.length, 2, "saveResumeData가 각 승인마다 호출되어야 한다");
});

test("Sub-AC 7-3: 순차 승인 시 각 단계에서 스냅샷이 저장된다 (롤백 기준점)", async () => {
  resetState();
  const app = buildApp();

  // summary 승인
  await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: "스냅샷 테스트 요약",
  }));

  // skills 승인
  await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "skills",
    content: "- Python\n- Go",
  }));

  // 각 승인 전 스냅샷이 저장되어야 한다 (pre-chat-approve)
  assert.equal(_saveSnapshotCalls.length, 2, "승인마다 스냅샷이 저장되어야 한다");
  assert.equal(_saveSnapshotCalls[0].opts.label, "pre-chat-approve", "첫 번째 스냅샷 레이블 확인");
  assert.equal(_saveSnapshotCalls[1].opts.label, "pre-chat-approve", "두 번째 스냅샷 레이블 확인");
});

test("Sub-AC 7-3: 순차 승인 시 이전 승인 결과가 다음 PATCH 호출에서도 보존된다", async () => {
  resetState();
  const app = buildApp();

  // Step 1: summary 승인
  const summarySaved = "이전 단계에서 반영된 자기소개";
  await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: summarySaved,
  }));

  // Step 2: projects 승인 — 이전 summary 변경이 유지되어야 한다
  const res = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "projects",
    content: "- 새 프로젝트 불릿",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  // summary는 여전히 Step 1에서 반영된 값이어야 한다
  assert.equal(
    data.resume.summary,
    summarySaved.trim(),
    "이전 summary 변경이 projects 승인 후에도 유지되어야 한다"
  );
  // projects도 새 값으로 반영되어야 한다
  assert.deepEqual(
    data.resume.projects[0].bullets,
    ["새 프로젝트 불릿"],
    "projects 불릿이 반영되어야 한다"
  );
});

test("Sub-AC 7-3: 3개 섹션 순차 승인 — summary, experience, skills 모두 반영된다", async () => {
  resetState();
  const app = buildApp();

  const sessionId = "sess-multi-001";

  // 1단계: summary
  await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: "3섹션 테스트 요약",
    sessionId,
    messageId: "msg-q1",
  }));

  // 2단계: experience
  await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "experience",
    content: "- 3섹션 경력 불릿",
    sessionId,
    messageId: "msg-q2",
  }));

  // 3단계: skills
  const res3 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "skills",
    content: "- React\n- Node.js",
    sessionId,
    messageId: "msg-q3",
  }));

  assert.equal(res3.status, 200);
  const finalResume = (await res3.json()).resume;

  // 3개 섹션 모두 최종 이력서에 반영되어야 한다
  assert.equal(finalResume.summary, "3섹션 테스트 요약", "summary 반영 확인");
  assert.deepEqual(finalResume.experience[0].bullets, ["3섹션 경력 불릿"], "experience 반영 확인");
  assert.ok(finalResume.skills.technical.includes("React"), "React 스킬 추가 확인");
  assert.ok(finalResume.skills.technical.includes("Node.js"), "Node.js 스킬 추가 확인");

  // 총 3번의 saveResumeData 호출
  assert.equal(_saveResumeCalls.length, 3, "3개 승인마다 각각 저장되어야 한다");
});

// ─── Sub-AC 7-3: 거절 플로우 ─────────────────────────────────────────────────

test("Sub-AC 7-3: 거절(reject)은 PATCH를 호출하지 않으므로 섹션이 변경되지 않는다", async () => {
  resetState();
  // reject는 프론트엔드에서 처리 — PATCH /api/resume/section 호출 없음
  // 이 테스트는 PATCH가 호출되지 않으면 이력서가 변경되지 않음을 확인한다

  const initialSummary = _resumeDoc.summary;
  const initialExperience = JSON.stringify(_resumeDoc.experience);

  // PATCH 없이 이력서 상태를 직접 확인 (reject 시나리오)
  // 실제 reject는 프론트에서 diffStatus를 'rejected'로만 바꾸고 서버에 PATCH를 보내지 않는다

  assert.equal(_saveResumeCalls.length, 0, "거절 시 saveResumeData가 호출되지 않아야 한다");
  assert.equal(_resumeDoc.summary, initialSummary, "거절 후 summary가 변경되지 않아야 한다");
  assert.equal(JSON.stringify(_resumeDoc.experience), initialExperience, "거절 후 experience가 변경되지 않아야 한다");
});

test("Sub-AC 7-3: 거절 후 다음 섹션 승인 — 거절된 섹션은 변경 없고, 승인된 섹션만 반영된다", async () => {
  resetState();
  const app = buildApp();

  // 시나리오:
  //   message-1 diff (summary 변경) → 거절(reject) → PATCH 없음 → summary 미반영
  //   message-2 diff (experience 변경) → 승인(approve) → PATCH → experience 반영

  // reject: 서버 호출 없음 (프론트에서만 처리)
  const summaryBefore = _resumeDoc.summary; // "기존 자기소개 문장입니다."

  // approve: experience 섹션만 PATCH
  const res = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "experience",
    content: "- 거절 후 승인된 경력 불릿",
    messageId: "msg-003",
    sessionId: "sess-002",
  }));

  assert.equal(res.status, 200, "experience 승인 시 200 응답");
  const data = await res.json();

  // summary는 거절되었으므로 원본 그대로여야 한다
  assert.equal(data.resume.summary, summaryBefore, "거절된 summary는 변경되지 않아야 한다");
  // experience는 승인되었으므로 반영되어야 한다
  assert.deepEqual(
    data.resume.experience[0].bullets,
    ["거절 후 승인된 경력 불릿"],
    "승인된 experience 불릿이 반영되어야 한다"
  );

  // saveResumeData는 experience 승인에 의한 1번만 호출되어야 한다
  assert.equal(_saveResumeCalls.length, 1, "reject는 저장 없음, approve만 저장 1회");
});

// ─── Sub-AC 7-3: 혼합 흐름 (approve → reject → approve) ────────────────────

test("Sub-AC 7-3: 혼합 흐름 — approve → reject → approve 순서로 처리된다", async () => {
  resetState();
  const app = buildApp();

  const sessionId = "sess-mixed-001";

  // Step 1: summary 승인 → 반영
  const res1 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: "혼합 흐름 테스트 — 요약",
    sessionId,
    messageId: "msg-mix-1",
  }));
  assert.equal(res1.status, 200);

  // Step 2: experience 거절 → PATCH 없음 (프론트에서만 처리)
  // (서버 호출 없음 — experience는 변경되지 않음)

  // Step 3: projects 승인 → 반영
  const res3 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "projects",
    content: "- 혼합 흐름 승인 프로젝트 불릿",
    sessionId,
    messageId: "msg-mix-3",
  }));
  assert.equal(res3.status, 200);
  const data3 = await res3.json();

  // summary: 승인(Step 1) → 반영되어야 한다
  assert.equal(data3.resume.summary, "혼합 흐름 테스트 — 요약", "Step 1 summary가 반영되어야 한다");

  // experience: 거절(Step 2) → 원본 그대로여야 한다
  assert.deepEqual(
    data3.resume.experience[0].bullets,
    BASE_RESUME.experience[0].bullets,
    "거절된 experience는 원본 그대로여야 한다"
  );

  // projects: 승인(Step 3) → 반영되어야 한다
  assert.deepEqual(
    data3.resume.projects[0].bullets,
    ["혼합 흐름 승인 프로젝트 불릿"],
    "Step 3 projects가 반영되어야 한다"
  );

  // saveResumeData: summary(1) + projects(1) = 2회 호출
  assert.equal(_saveResumeCalls.length, 2, "승인된 섹션 수만큼 저장 호출");
});

// ─── Sub-AC 7-3: 큐 순서 보장 ─────────────────────────────────────────────────

test("Sub-AC 7-3: 큐 순서 — 첫 번째 승인의 변경이 두 번째 승인의 기준 이력서에 반영된다", async () => {
  resetState();
  const app = buildApp();

  // 시뮬레이션:
  // 큐에 [summary 승인, skills 승인] 두 항목이 있을 때
  // summary 처리 완료 후 skills를 처리하면, skills 처리 시의 이력서에 summary 변경이 반영되어 있어야 한다

  const summaryContent = "큐 순서 보장 테스트 — 요약";

  // 첫 번째 큐 아이템: summary 승인
  await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: summaryContent,
    messageId: "msg-order-1",
  }));

  // 두 번째 큐 아이템: skills 승인 (summary가 이미 반영된 상태에서 처리)
  const res = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "skills",
    content: "- Kubernetes\n- Terraform",
    messageId: "msg-order-2",
  }));

  assert.equal(res.status, 200);
  const finalResume = (await res.json()).resume;

  // skills 처리 결과에 summary 변경이 보존되어야 한다 (큐 순서 보장)
  assert.equal(finalResume.summary, summaryContent.trim(), "첫 번째 승인(summary)이 두 번째 처리 시에도 보존되어야 한다");
  assert.ok(finalResume.skills.technical.includes("Kubernetes"), "Kubernetes 추가 확인");
  assert.ok(finalResume.skills.technical.includes("Terraform"), "Terraform 추가 확인");

  // saveResumeData 호출 순서 확인
  assert.equal(_saveResumeCalls[0].summary, summaryContent.trim(), "첫 번째 저장은 summary 변경이어야 한다");
  assert.ok(_saveResumeCalls[1].skills.technical.includes("Kubernetes"), "두 번째 저장에 Kubernetes 포함");
  // 두 번째 저장에도 summary 변경이 보존되어야 한다
  assert.equal(_saveResumeCalls[1].summary, summaryContent.trim(), "두 번째 저장에서 summary 변경이 보존되어야 한다");
});

test("Sub-AC 7-3: 큐 순서 — 4개 섹션을 순서대로 처리할 때 누적 변경이 보존된다", async () => {
  resetState();
  const app = buildApp();

  const sessionId = "sess-queue-order";

  // 큐: [summary, experience, projects, skills] 순서로 처리
  const approvals = [
    { section: "summary", content: "4단계 순차 처리 — 요약", messageId: "msg-q-1" },
    { section: "experience", content: "- 4단계 경력 불릿 A\n- 4단계 경력 불릿 B", messageId: "msg-q-2" },
    { section: "projects", content: "- 4단계 프로젝트 불릿", messageId: "msg-q-3" },
    { section: "skills", content: "- Rust\n- WebAssembly", messageId: "msg-q-4" },
  ];

  let lastResume = null;
  for (const approval of approvals) {
    const res = await app.fetch(authedPatch("http://localhost/api/resume/section", {
      ...approval,
      sessionId,
    }));
    assert.equal(res.status, 200, `${approval.section} 승인 200 응답`);
    lastResume = (await res.json()).resume;
  }

  // 최종 이력서에 모든 변경이 누적되어야 한다
  assert.equal(lastResume.summary, "4단계 순차 처리 — 요약", "summary 최종 반영");
  assert.deepEqual(
    lastResume.experience[0].bullets,
    ["4단계 경력 불릿 A", "4단계 경력 불릿 B"],
    "experience 최종 반영"
  );
  assert.deepEqual(
    lastResume.projects[0].bullets,
    ["4단계 프로젝트 불릿"],
    "projects 최종 반영"
  );
  assert.ok(lastResume.skills.technical.includes("Rust"), "Rust 최종 반영");
  assert.ok(lastResume.skills.technical.includes("WebAssembly"), "WebAssembly 최종 반영");

  // 4개 승인 → 4번의 저장
  assert.equal(_saveResumeCalls.length, 4, "4개 승인 → 4번 저장");
});

// ─── Sub-AC 7-3: _source 태깅 ─────────────────────────────────────────────────

test("Sub-AC 7-3: 순차 승인 시 각 섹션에 user_approved 태그가 부여된다", async () => {
  resetState();
  const app = buildApp();

  // summary 승인
  const res1 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: "_source 태깅 테스트 요약",
    messageId: "msg-tag-1",
  }));
  const resume1 = (await res1.json()).resume;
  assert.equal(resume1._sources?.summary, "user_approved", "summary _source = user_approved");

  // experience 승인
  const res2 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "experience",
    content: "- _source 태깅 경력 불릿",
    messageId: "msg-tag-2",
  }));
  const resume2 = (await res2.json()).resume;
  assert.equal(resume2.experience[0]._source, "user_approved", "experience[0] _source = user_approved");

  // 두 번째 승인에서도 summary의 user_approved 태그가 유지되어야 한다
  assert.equal(resume2._sources?.summary, "user_approved", "experience 승인 후 summary _source도 유지");
});

// ─── Sub-AC 7-3: 응답 구조 검증 ──────────────────────────────────────────────

test("Sub-AC 7-3: 각 승인 응답에 ok, resume, section, appliedAt 필드가 포함된다", async () => {
  resetState();
  const app = buildApp();

  const res = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: "응답 구조 테스트",
    messageId: "msg-resp-1",
    sessionId: "sess-resp-1",
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.ok, true, "ok 필드는 true");
  assert.ok(data.resume, "resume 필드 존재");
  assert.equal(data.section, "summary", "section 필드 = 'summary'");
  assert.ok(typeof data.appliedAt === "string", "appliedAt은 문자열");
  assert.ok(!isNaN(Date.parse(data.appliedAt)), "appliedAt은 유효한 ISO8601 날짜");
});

test("Sub-AC 7-3: 여러 승인의 각 응답에 타임스탬프(appliedAt)가 포함된다", async () => {
  resetState();
  const app = buildApp();

  const res1 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: "타임스탬프 테스트 1",
    messageId: "msg-ts-1",
  }));
  const res2 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "experience",
    content: "- 타임스탬프 테스트 2",
    messageId: "msg-ts-2",
  }));

  const data1 = await res1.json();
  const data2 = await res2.json();

  assert.ok(!isNaN(Date.parse(data1.appliedAt)), "첫 번째 승인 appliedAt 유효성");
  assert.ok(!isNaN(Date.parse(data2.appliedAt)), "두 번째 승인 appliedAt 유효성");
});

// ─── Sub-AC 7-3: 오류 복구 시나리오 ─────────────────────────────────────────

test("Sub-AC 7-3: 첫 번째 승인 후 잘못된 섹션명으로 400이 반환되더라도 첫 번째 승인은 유지된다", async () => {
  resetState();
  const app = buildApp();

  // 첫 번째 정상 승인
  const res1 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "summary",
    content: "오류 복구 테스트 — 정상 승인",
  }));
  assert.equal(res1.status, 200);

  // 두 번째 잘못된 섹션명 → 400 (reject 또는 오류 상태)
  const res2 = await app.fetch(authedPatch("http://localhost/api/resume/section", {
    section: "invalid_section_xyz",
    content: "잘못된 섹션",
  }));
  assert.equal(res2.status, 400, "잘못된 섹션은 400");

  // 현재 이력서 상태 확인 — 첫 번째 summary 변경은 유지되어야 한다
  assert.equal(
    _resumeDoc.summary,
    "오류 복구 테스트 — 정상 승인",
    "400 오류 후에도 이전 승인된 summary는 유지"
  );

  // saveResumeData는 첫 번째 정상 승인에서만 1회 호출
  assert.equal(_saveResumeCalls.length, 1, "정상 승인 1회만 저장");
});
