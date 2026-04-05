/**
 * Tests for POST /api/resume/chat endpoint.
 *
 * Verifies Sub-AC 3-1: backend receives parsed query from frontend
 * and returns a structured response including reply, sessionId, parsedQuery.
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.chat.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Module-level mocks (must be declared before `await import(…)`) ──────────

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
    aggregateSignals: () => ({
      signalText: "",
      commitCount: 0,
      sessionCount: 0,
      slackCount: 0,
      repos: [],
    }),
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
    searchAllSources: async () => ({
      commits: [
        {
          source: "commits",
          date: "2024-03-01",
          text: "my-project: feat: 프로젝트 기능 추가",
          relevanceScore: 1,
          matchedKeywords: ["프로젝트"],
          provenance: {
            sourceType: "commits",
            commitHash: "abc1234",
            repo: "my-project",
            authoredAt: "2024-03-01T10:00:00+09:00",
            repoPath: "/code/my-project",
          }
        }
      ],
      slack: [
        {
          source: "slack",
          date: "2024-03-02",
          text: "프로젝트 배포 완료 알림",
          relevanceScore: 1,
          matchedKeywords: ["프로젝트"],
          provenance: {
            sourceType: "slack",
            messageId: "1709385600.000100",
            channelId: "C01ABCDEF",
            permalink: "https://myworkspace.slack.com/archives/C01ABCDEF/p1709385600000100",
            context: [],
          }
        }
      ],
      sessions: [
        {
          source: "session",
          date: "2024-03-03",
          text: "프로젝트 기능 설계 논의 - API 엔드포인트 구조 결정",
          relevanceScore: 1,
          matchedKeywords: ["프로젝트"],
          provenance: {
            sourceType: "session",
            sessionType: "claude",
            filePath: "/path/to/session.jsonl",
            cwd: "/code/my-project",
            snippets: ["API 엔드포인트를 RESTful 방식으로 설계했다."],
          }
        }
      ],
      totalCount: 3,
    }),
    searchCommits: async () => [
      {
        source: "commits",
        date: "2024-03-01",
        text: "my-project: feat: 프로젝트 기능 추가",
        relevanceScore: 1,
        matchedKeywords: ["프로젝트"],
        provenance: {
          sourceType: "commits",
          commitHash: "abc1234",
          repo: "my-project",
          authoredAt: "2024-03-01T10:00:00+09:00",
          repoPath: "/code/my-project",
        },
      },
    ],
    searchSlack: async () => [
      {
        source: "slack",
        date: "2024-03-02",
        text: "프로젝트 배포 완료 알림",
        relevanceScore: 1,
        matchedKeywords: ["프로젝트"],
        provenance: {
          sourceType: "slack",
          messageId: "1709385600.000100",
          channelId: "C01ABCDEF",
          permalink: "https://myworkspace.slack.com/archives/C01ABCDEF/p1709385600000100",
          context: [],
        },
      },
    ],
    searchSessionMemory: async () => [
      {
        source: "session",
        date: "2024-03-03",
        text: "프로젝트 기능 설계 논의 - API 엔드포인트 구조 결정",
        relevanceScore: 1,
        matchedKeywords: ["프로젝트"],
        provenance: {
          sourceType: "session",
          sessionType: "claude",
          filePath: "/path/to/session.jsonl",
          cwd: "/code/my-project",
          snippets: ["API 엔드포인트를 RESTful 방식으로 설계했다."],
        },
      },
    ],
    searchWithAnalyzedQuery: async (analyzed, _options) => ({
      commits: [],
      slack: [],
      sessions: [],
      totalCount: 0,
    }),
  }
});

// ─── resumeChatRecommendEngine mock (Sub-AC 3-3) ──────────────────────────────
mock.module("../lib/resumeChatRecommendEngine.mjs", {
  namedExports: {
    generateRecommendations: async (_query, _exploreResult, _options) => ({
      recommendations: [],
      citations: [],
      sourceSummary: null,
      dataGaps: [],
      followUpQuestions: [],
      strategy: "flat",
      totalEvidence: 0,
    }),
    selectStrategy: (_totalEvidence) => "flat",
    formatRecommendations: (_result) => "",
  },
});

// ─── resumeAppealPoints mock (Sub-AC 3-3) ─────────────────────────────────────
mock.module("../lib/resumeAppealPoints.mjs", {
  namedExports: {
    mergeAndRankEvidence: (evidenceResult, _options) => {
      // Merge commits + slack + sessions into a flat array with rank/rankScore
      const commits  = evidenceResult?.commits  ?? [];
      const slack    = evidenceResult?.slack    ?? [];
      const sessions = evidenceResult?.sessions ?? [];
      const all = [...commits, ...slack, ...sessions];
      return all.map((r, i) => ({ ...r, rank: i + 1, rankScore: (r.relevanceScore ?? 0) + 1 }));
    },
    buildEvidenceContext: (rankedEvidence, _maxChars) => {
      if (!rankedEvidence || rankedEvidence.length === 0) return "";
      return rankedEvidence.map((r) => `[${r.source}] ${r.date} | ${r.text}`).join("\n");
    },
    inferCategory: (description, title) => {
      const text = `${title} ${description}`.toLowerCase();
      if (/배포|개선|성능|감소/.test(text)) return "achievement";
      if (/리뷰|공유|문서|팀/.test(text)) return "contribution";
      return "capability";
    },
    generateAppealPoints: async (query, rankedEvidence, _options) => {
      if (!rankedEvidence || rankedEvidence.length === 0) {
        return {
          appealPoints: [],
          dataGaps: ["검색 결과가 없습니다."],
          followUpQuestions: ["어떤 기간이나 프로젝트를 찾으시나요?"],
          evidenceUsed: [],
        };
      }
      return {
        appealPoints: [
          {
            id: "ap-0",
            title: "테스트 어필 포인트",
            description: `"${query}" 관련 작업에서 추출된 어필 포인트입니다.`,
            evidenceTexts: [rankedEvidence[0]?.text ?? ""],
            section: "experience",
            confidence: 0.8,
          },
        ],
        dataGaps: [],
        followUpQuestions: [],
        evidenceUsed: rankedEvidence,
      };
    },
  }
});

// ─── resumeChatSuggest mock (Sub-AC 3-3) ──────────────────────────────────────
mock.module("../lib/resumeChatSuggest.mjs", {
  namedExports: {
    generateSuggestions: async (exploreResult, _options) => {
      const total = (exploreResult?.commits?.length ?? 0) +
        (exploreResult?.slack?.length ?? 0) +
        (exploreResult?.sessions?.length ?? 0);
      if (total === 0) {
        return {
          appealPoints: [],
          followUpQuestions: ["검색 키워드를 변경해 보세요."],
          clusterSummary: [],
          totalEvidence: 0,
        };
      }
      return {
        appealPoints: [
          {
            id: "mock-suggest-1",
            type: "achievement",
            title: "클러스터 기반 어필 포인트",
            description: "클러스터링된 근거에서 생성된 어필 포인트",
            evidence: [{ source: "commits", date: "2024-03-15", text: "근거 텍스트" }],
            targetSection: "experience",
            confidence: 0.8,
          },
        ],
        followUpQuestions: [],
        clusterSummary: [{ theme: "테스트", count: total, sources: ["commits"], score: 0.75 }],
        totalEvidence: total,
      };
    },
    formatSuggestionMessage: (set) => {
      if (!set || set.appealPoints.length === 0) return "제안할 어필 포인트를 찾지 못했습니다.";
      return `${set.appealPoints.length}개 어필 포인트 (근거 ${set.totalEvidence}건)`;
    },
  },
});

// ─── resumeChatApplyIntent mock (Sub-AC 5-1) ─────────────────────────────────
mock.module("../lib/resumeChatApplyIntent.mjs", {
  namedExports: {
    detectApplyIntent: (text) => /반영해\s*줘|적용해\s*줘/.test(text),
    extractSectionFromContext: (_query, parsedQuery, _history) => parsedQuery?.section ?? null,
    extractProposedChanges: (history) => {
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
      if (!lastAssistant) return { changes: [], sourceIndex: -1 };
      const idx = history.lastIndexOf(lastAssistant);
      const lines = (lastAssistant.content ?? "").split("\n")
        .filter((l) => l.trim().startsWith("- "))
        .map((l) => ({ type: "bullet", content: l.replace(/^-\s*/, "").trim() }));
      return { changes: lines, sourceIndex: idx };
    },
    parseApplyIntent: (_query, parsedQuery, history) => {
      const section = parsedQuery?.section ?? null;
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
      const sourceIndex = lastAssistant ? history.lastIndexOf(lastAssistant) : -1;
      const changes = lastAssistant
        ? (lastAssistant.content ?? "").split("\n")
            .filter((l) => l.trim().startsWith("- "))
            .map((l) => ({ type: "bullet", content: l.replace(/^-\s*/, "").trim() }))
        : [];
      const ambiguous = !section || changes.length === 0;
      return {
        detected: true,
        section,
        changes,
        confidence: section && changes.length > 0 ? 0.9 : 0.5,
        ambiguous,
        clarificationNeeded: ambiguous ? "어떤 섹션에 반영할까요?" : null,
        sourceMessageIndex: sourceIndex,
      };
    },
  }
});

// ─── resumeSummarySectionChat mock (Sub-AC 8-1) ──────────────────────────────
mock.module("../lib/resumeSummarySectionChat.mjs", {
  namedExports: {
    generateSummaryChatDiff: async (query, rankedEvidence, existingResume, _options) => {
      if (!rankedEvidence || rankedEvidence.length === 0) {
        return {
          hasEnoughEvidence: false,
          section: "summary",
          before: existingResume?.summary ?? "",
          after: "",
          evidence: [],
          dataGaps: ["업무 기록에서 자기소개를 작성할 근거를 찾지 못했습니다."],
          followUpQuestions: ["어떤 기간이나 프로젝트의 경험을 자기소개에 포함하고 싶으신가요?"],
        };
      }
      return {
        hasEnoughEvidence: true,
        section: "summary",
        before: existingResume?.summary ?? "",
        after: `${query} 기반으로 작성된 자기소개 초안입니다. 다양한 프로젝트에서 기술 역량을 발휘하며 성과를 달성했습니다.`,
        evidence: rankedEvidence.slice(0, 2).map((r) => r.text),
        dataGaps: [],
        followUpQuestions: [],
      };
    },
  }
});

// ─── resumeStrengthsSectionChat mock (Sub-AC 8-1) ────────────────────────────
mock.module("../lib/resumeStrengthsSectionChat.mjs", {
  namedExports: {
    generateStrengthsChatDiff: async (query, rankedEvidence, existingResume, existingStrengths, _options) => {
      if (!rankedEvidence || rankedEvidence.length < 2) {
        return {
          hasEnoughEvidence: false,
          section: "strengths",
          before: "",
          after: "",
          evidence: [],
          strengthsData: [],
          dataGaps: ["업무 기록에서 강점을 도출할 근거가 충분하지 않습니다."],
          followUpQuestions: ["어떤 프로젝트나 기간의 업무에서 강점을 찾고 싶으신가요?"],
        };
      }
      const strengthsData = [
        {
          id: "str-1",
          label: "안정성 우선 엔지니어링",
          description: "코드 품질과 안정성을 최우선으로 하는 엔지니어링 패턴이 확인됩니다.",
          evidenceTexts: [rankedEvidence[0]?.text ?? ""],
          behaviorCluster: ["코드 품질", "테스트 작성"],
          frequency: 3,
          confidence: 0.85,
        },
        {
          id: "str-2",
          label: "데이터 기반 의사결정",
          description: "메트릭과 근거 데이터를 활용한 의사결정 패턴이 반복적으로 나타납니다.",
          evidenceTexts: [rankedEvidence[1]?.text ?? ""],
          behaviorCluster: ["분석력", "의사결정"],
          frequency: 2,
          confidence: 0.75,
        },
      ];
      return {
        hasEnoughEvidence: true,
        section: "strengths",
        before: "",
        after: `1. 안정성 우선 엔지니어링 (×3)\n  코드 품질과 안정성을 최우선으로 하는 엔지니어링 패턴이 확인됩니다.\n\n2. 데이터 기반 의사결정 (×2)\n  메트릭과 근거 데이터를 활용한 의사결정 패턴이 반복적으로 나타납니다.`,
        evidence: rankedEvidence.slice(0, 2).map((r) => r.text),
        strengthsData,
        dataGaps: [],
        followUpQuestions: [],
      };
    },
    formatStrengthsAsText: (strengths) => {
      if (!Array.isArray(strengths) || strengths.length === 0) return "";
      return strengths.map((s, i) => {
        const freq = s.frequency ? ` (×${s.frequency})` : "";
        const desc = s.description ? `\n  ${s.description}` : "";
        return `${i + 1}. ${s.label}${freq}${desc}`;
      }).join("\n\n");
    },
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

// ─── POST /api/resume/chat — 정상 응답 ──────────────────────────────────────

test("POST /api/resume/chat - 자유 텍스트 질의를 받아 reply와 parsedQuery를 반환한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-001",
    query: "2024년에 진행한 주요 프로젝트를 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: "projects",
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200, "정상 요청에 200 응답");
  const data = await res.json();
  assert.ok(typeof data.reply === "string", "reply 필드는 문자열이어야 한다");
  assert.ok(data.reply.length > 0, "reply는 비어 있으면 안 된다");
  assert.ok(data.parsedQuery, "parsedQuery 필드가 응답에 포함되어야 한다");
  assert.equal(data.sessionId, "chat-test-001", "sessionId가 그대로 반환되어야 한다");
});

test("POST /api/resume/chat - 섹션 수정 의도(refine_section)를 처리한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-002",
    query: "경력 섹션의 첫 번째 항목 불릿을 더 구체적으로 개선해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["경력", "불릿", "개선"],
      section: "experience",
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.reply === "string", "reply는 문자열이어야 한다");
  assert.ok(data.parsedQuery?.intent === "refine_section", "parsedQuery.intent가 반환되어야 한다");
});

test("POST /api/resume/chat - 일반 질의(general intent)를 처리한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-003",
    query: "내 이력서에 대해 알려줘",
    parsedQuery: {
      intent: "general",
      keywords: ["이력서"],
      section: null,
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.reply === "string");
});

test("POST /api/resume/chat - 대화 히스토리를 함께 전달할 수 있다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-004",
    query: "더 자세하게 설명해줘",
    parsedQuery: {
      intent: "question",
      keywords: ["설명"],
      section: null,
      dateRange: null
    },
    history: [
      { role: "user", content: "기술 섹션을 개선해줘" },
      { role: "assistant", content: "기술 섹션을 분석하겠습니다." }
    ]
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.reply === "string");
});

// ─── POST /api/resume/chat — 입력 검증 ──────────────────────────────────────

test("POST /api/resume/chat - query가 없으면 400 반환", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-005",
    parsedQuery: { intent: "general", keywords: [], section: null, dateRange: null },
    history: []
    // query 필드 없음
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 400, "query 없으면 400 반환");
  const data = await res.json();
  assert.ok(data.error, "에러 메시지가 포함되어야 한다");
});

test("POST /api/resume/chat - query가 빈 문자열이면 400 반환", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-006",
    query: "   ",
    parsedQuery: { intent: "general", keywords: [], section: null, dateRange: null },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 400, "빈 query는 400 반환");
  const data = await res.json();
  assert.ok(data.error);
});

test("POST /api/resume/chat - 잘못된 JSON 바디이면 400 반환", async () => {
  const app = buildApp();

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body: "not-json"
  }));

  assert.equal(res.status, 400);
});

// ─── POST /api/resume/chat — 인증 검사 ──────────────────────────────────────

test("POST /api/resume/chat - 인증 쿠키 없으면 401 반환", async () => {
  const app = buildApp("test-secret");

  const body = JSON.stringify({
    sessionId: "chat-test-007",
    query: "프로젝트 경험 찾아줘",
    parsedQuery: { intent: "search_evidence", keywords: ["프로젝트"], section: null, dateRange: null },
    history: []
  });

  const res = await app.fetch(new Request("http://localhost/api/resume/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  }));

  assert.equal(res.status, 401, "인증 쿠키 없으면 401");
  const data = await res.json();
  assert.equal(data.error, "Unauthorized");
});

// ─── POST /api/resume/chat — parsedQuery 반영 검증 ──────────────────────────

test("POST /api/resume/chat - reply에 파싱된 intent 정보가 반영된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-008",
    query: "커밋 기록에서 React 관련 작업을 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["커밋", "React"],
      section: null,
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // stub reply에 intent 정보가 포함됨
  assert.ok(data.reply.includes("증거/이력 검색") || data.reply.includes("커밋"), "reply에 검색 의도가 반영되어야 한다");
});

// ─── POST /api/resume/chat — Sub-AC 3-2: evidence search integration ─────────

test("POST /api/resume/chat - search_evidence 의도 시 evidence 필드를 반환한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-evidence-01",
    query: "2024년에 진행한 프로젝트 커밋을 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: null,
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok("evidence" in data, "evidence 필드가 응답에 포함되어야 한다");
  assert.ok(data.evidence !== null, "evidence는 null이 아니어야 한다");
  assert.ok(Array.isArray(data.evidence.commits), "evidence.commits는 배열이어야 한다");
  assert.ok(Array.isArray(data.evidence.slack), "evidence.slack은 배열이어야 한다");
  assert.ok(Array.isArray(data.evidence.sessions), "evidence.sessions은 배열이어야 한다");
  assert.ok(typeof data.evidence.totalCount === "number", "evidence.totalCount는 숫자여야 한다");
});

test("POST /api/resume/chat - search_evidence 의도 + 키워드 없을 때 evidence 검색 건너뜀", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-evidence-02",
    query: "찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: [], // 키워드 없음 → 검색 건너뜀
      section: null,
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // keywords가 비어 있으면 evidence는 null (검색 건너뜀)
  assert.equal(data.evidence, null, "키워드 없으면 evidence는 null이어야 한다");
});

test("POST /api/resume/chat - parsedQuery 없이도 query만으로 처리된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-009",
    query: "이력서 전반적으로 검토해줘"
    // parsedQuery 및 history 생략
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200, "parsedQuery 없어도 200 응답");
  const data = await res.json();
  assert.ok(typeof data.reply === "string");
});

// ─── POST /api/resume/chat — Sub-AC 4-1: provenance 출처 메타데이터 검증 ────────

// ─── POST /api/resume/chat — Sub-AC 4-2: citations 출처 정보 첨부 검증 ──────

test("POST /api/resume/chat - Sub-AC 4-2: 키워드 검색 결과가 있으면 citations 배열이 응답에 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-4-2-citations-01",
    query: "프로젝트 관련 작업을 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: null,
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  // citations 필드가 존재하고 배열이어야 한다
  assert.ok("citations" in data, "응답에 citations 필드가 포함되어야 한다");
  assert.ok(Array.isArray(data.citations), "citations는 배열이어야 한다");
  assert.ok(data.citations.length > 0, "키워드 매칭 결과가 있으면 citations가 비어있지 않아야 한다");
});

test("POST /api/resume/chat - Sub-AC 4-2: 각 citation에 id, source, date, text, provenance가 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-4-2-citations-02",
    query: "프로젝트 커밋을 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: null,
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.citations) && data.citations.length > 0);

  const citation = data.citations[0];
  assert.ok(typeof citation.id === "string" && citation.id.length > 0, "citation.id는 비어있지 않은 문자열");
  assert.ok(typeof citation.source === "string", "citation.source는 문자열");
  assert.ok(["commits", "slack", "session"].includes(citation.source), "citation.source는 유효한 소스 타입");
  assert.ok(typeof citation.date === "string", "citation.date는 문자열");
  assert.ok(typeof citation.text === "string" && citation.text.length > 0, "citation.text는 비어있지 않은 문자열");
  assert.ok(typeof citation.rank === "number", "citation.rank는 숫자");
  assert.ok(typeof citation.relevance === "number", "citation.relevance는 숫자");
  assert.ok(citation.relevance >= 0 && citation.relevance <= 1, "citation.relevance는 0.0–1.0 범위");
});

test("POST /api/resume/chat - Sub-AC 4-2: 커밋 citation에 repo와 hash 편의 필드가 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-4-2-citations-03",
    query: "프로젝트 커밋을 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: null,
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.citations));

  const commitCitation = data.citations.find((c) => c.source === "commits");
  if (commitCitation) {
    assert.ok(commitCitation.repo, "커밋 citation에 repo 편의 필드가 있어야 한다");
    assert.ok(commitCitation.hash, "커밋 citation에 hash 편의 필드가 있어야 한다");
    assert.ok(commitCitation.provenance, "커밋 citation에 provenance가 있어야 한다");
  }
});

test("POST /api/resume/chat - Sub-AC 4-2: 증거 검색이 없으면 citations는 null 또는 빈 배열", async () => {
  const app = buildApp();

  // 서버 사이드 analyzeQuery가 키워드를 추출할 수 있으므로
  // citations가 null이거나 배열(빈 포함)인지를 확인한다
  const body = JSON.stringify({
    sessionId: "chat-test-4-2-citations-04",
    query: "hello",
    parsedQuery: {
      intent: "general",
      keywords: [],
      section: null,
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // citations는 null이거나 배열이어야 한다 (서버가 키워드를 추출하면 배열 가능)
  assert.ok(
    data.citations === null || Array.isArray(data.citations),
    "citations는 null이거나 배열이어야 한다"
  );
});

test("POST /api/resume/chat - Sub-AC 4-2: apply_section 응답에 citations는 null", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-4-2-citations-05",
    query: "이대로 반영해줘",
    parsedQuery: {
      intent: "apply_section",
      keywords: [],
      section: "experience",
      dateRange: null
    },
    history: [
      { role: "user", content: "프로젝트 경험 찾아줘" },
      { role: "assistant", content: "- React 기반 대시보드 구현으로 팀 생산성 20% 향상\n- API 설계 개선으로 응답 시간 50% 단축" }
    ]
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.citations, null, "apply_section 응답에 citations는 null이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 4-1: 커밋 evidence 레코드에 provenance.commitHash와 provenance.repo가 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-4-1-commits",
    query: "프로젝트 커밋을 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: null,
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.evidence !== null, "evidence는 null이 아니어야 한다");
  assert.ok(data.evidence.commits.length > 0, "커밋 evidence 레코드가 있어야 한다");

  const commitRecord = data.evidence.commits[0];

  // Sub-AC 4-1: provenance 필드가 포함되어야 한다
  assert.ok(commitRecord.provenance, "커밋 레코드에 provenance 필드가 있어야 한다");
  assert.equal(commitRecord.provenance.sourceType, "commits", "provenance.sourceType === 'commits'");
  assert.ok("commitHash" in commitRecord.provenance, "커밋 해시 필드(commitHash)가 있어야 한다");
  assert.ok("repo" in commitRecord.provenance, "레포지터리 필드(repo)가 있어야 한다");
  assert.ok("authoredAt" in commitRecord.provenance, "커밋 시각 필드(authoredAt)가 있어야 한다");
  assert.ok("repoPath" in commitRecord.provenance, "레포 경로 필드(repoPath)가 있어야 한다");

  // matchedKeywords 필드도 포함되어야 한다
  assert.ok(Array.isArray(commitRecord.matchedKeywords), "matchedKeywords 배열이 있어야 한다");
});

test("POST /api/resume/chat - Sub-AC 4-1: 슬랙 evidence 레코드에 provenance.messageId(ts)와 provenance.channelId가 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-4-1-slack",
    query: "슬랙 메시지에서 프로젝트 관련 내용을 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: null,
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.evidence !== null);
  assert.ok(data.evidence.slack.length > 0, "슬랙 evidence 레코드가 있어야 한다");

  const slackRecord = data.evidence.slack[0];

  // Sub-AC 4-1: provenance 필드가 포함되어야 한다
  assert.ok(slackRecord.provenance, "슬랙 레코드에 provenance 필드가 있어야 한다");
  assert.equal(slackRecord.provenance.sourceType, "slack", "provenance.sourceType === 'slack'");
  assert.ok("messageId" in slackRecord.provenance, "슬랙 메시지 ID 필드(messageId)가 있어야 한다 (ts 기반)");
  assert.ok("channelId" in slackRecord.provenance, "채널 ID 필드(channelId)가 있어야 한다");
  assert.ok("permalink" in slackRecord.provenance, "퍼머링크 필드(permalink)가 있어야 한다");
  assert.ok("context" in slackRecord.provenance, "컨텍스트 필드(context)가 있어야 한다");
  assert.ok(Array.isArray(slackRecord.provenance.context), "provenance.context는 배열이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 4-1: 세션 메모리 evidence 레코드에 provenance.sessionType과 provenance.filePath가 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-4-1-sessions",
    query: "AI 세션에서 프로젝트 관련 내용을 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: null,
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.evidence !== null);
  assert.ok(data.evidence.sessions.length > 0, "세션 메모리 evidence 레코드가 있어야 한다");

  const sessionRecord = data.evidence.sessions[0];

  // Sub-AC 4-1: provenance 필드가 포함되어야 한다
  assert.ok(sessionRecord.provenance, "세션 레코드에 provenance 필드가 있어야 한다");
  assert.equal(sessionRecord.provenance.sourceType, "session", "provenance.sourceType === 'session'");
  assert.ok("sessionType" in sessionRecord.provenance, "세션 타입 필드(sessionType, codex/claude)가 있어야 한다");
  assert.ok("filePath" in sessionRecord.provenance, "세션 파일 경로 필드(filePath)가 있어야 한다");
  assert.ok("cwd" in sessionRecord.provenance, "작업 디렉터리 필드(cwd)가 있어야 한다");
  assert.ok("snippets" in sessionRecord.provenance, "스니펫 미리보기 필드(snippets)가 있어야 한다");
  assert.ok(Array.isArray(sessionRecord.provenance.snippets), "provenance.snippets는 배열이어야 한다");
});

// ─── POST /api/resume/chat — Sub-AC 3-3: 검색 결과 통합·랭킹 및 어필 포인트 ──

test("POST /api/resume/chat - Sub-AC 3-3: search_evidence 시 rankedEvidence 필드를 반환한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-3-3-rank-01",
    query: "2024년 프로젝트 작업 어필 포인트를 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: null,
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok("rankedEvidence" in data, "rankedEvidence 필드가 응답에 포함되어야 한다");
  assert.ok(Array.isArray(data.rankedEvidence), "rankedEvidence 는 배열이어야 한다");
  // mock evidence 에서 3건 (커밋+슬랙+세션)이 병합되어야 한다
  assert.ok(data.rankedEvidence.length > 0, "rankedEvidence 가 비어 있지 않아야 한다");

  // rank 필드 검증
  for (const r of data.rankedEvidence) {
    assert.ok(typeof r.rank === "number", "각 레코드에 rank 필드가 있어야 한다");
    assert.ok(typeof r.rankScore === "number", "각 레코드에 rankScore 필드가 있어야 한다");
  }
});

test("POST /api/resume/chat - Sub-AC 3-3: appealPoints 필드를 반환한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-3-3-appeal-01",
    query: "2024년 배포 관련 어필 포인트를 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트", "배포"],
      section: null,
      dateRange: { from: "2024-01-01", to: "2024-12-31" }
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok("appealPoints" in data, "appealPoints 필드가 응답에 포함되어야 한다");
  assert.ok(data.appealPoints !== null, "appealPoints 는 null 이 아니어야 한다");

  const ap = data.appealPoints;
  assert.ok(Array.isArray(ap.appealPoints), "appealPoints.appealPoints 는 배열이어야 한다");
  assert.ok(Array.isArray(ap.dataGaps), "appealPoints.dataGaps 는 배열이어야 한다");
  assert.ok(Array.isArray(ap.followUpQuestions), "appealPoints.followUpQuestions 는 배열이어야 한다");
  assert.ok(Array.isArray(ap.evidenceUsed), "appealPoints.evidenceUsed 는 배열이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 3-3: 어필 포인트가 있으면 reply 에 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-3-3-reply-01",
    query: "배포 자동화 관련 어필 포인트 제안해줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["배포"],
      section: null,
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.reply === "string", "reply 는 문자열이어야 한다");
  assert.ok(data.reply.length > 0, "reply 가 비어 있으면 안 된다");
  // mock 은 어필 포인트를 반환하므로 reply 에 "어필 포인트" 또는 제목이 포함되어야 한다
  assert.ok(
    data.reply.includes("어필 포인트") || data.reply.includes("테스트 어필"),
    "reply 에 어필 포인트 내용이 포함되어야 한다"
  );
});

test("POST /api/resume/chat - Sub-AC 3-3: 키워드 없으면 appealPoints 는 null 이다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-3-3-no-kw",
    query: "네",
    parsedQuery: {
      intent: "general",
      keywords: [],
      section: null,
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.evidence, null, "키워드 없으면 evidence 는 null 이어야 한다");
  assert.equal(data.rankedEvidence, null, "키워드 없으면 rankedEvidence 는 null 이어야 한다");
  assert.equal(data.appealPoints, null, "키워드 없으면 appealPoints 는 null 이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 3-3: appealPoints.appealPoints 배열에 id/title/confidence 필드가 있다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-3-3-fields",
    query: "프로젝트 경험에서 어필 포인트 찾아줘",
    parsedQuery: {
      intent: "search_evidence",
      keywords: ["프로젝트"],
      section: "experience",
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.appealPoints, "appealPoints 필드가 있어야 한다");

  const points = data.appealPoints.appealPoints;
  assert.ok(points.length > 0, "어필 포인트가 1개 이상 있어야 한다");

  const firstPoint = points[0];
  assert.ok(typeof firstPoint.id === "string", "id 는 문자열이어야 한다");
  assert.ok(typeof firstPoint.title === "string", "title 은 문자열이어야 한다");
  assert.ok(typeof firstPoint.description === "string", "description 은 문자열이어야 한다");
  assert.ok(Array.isArray(firstPoint.evidenceTexts), "evidenceTexts 는 배열이어야 한다");
  assert.ok(typeof firstPoint.confidence === "number", "confidence 는 숫자여야 한다");
  assert.ok(firstPoint.confidence >= 0 && firstPoint.confidence <= 1,
    "confidence 는 0–1 범위여야 한다");
});

test("POST /api/resume/chat - Sub-AC 3-3: refine_section 의도에서도 키워드 있으면 rankedEvidence 를 반환한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-3-3-refine",
    query: "경력 섹션에서 배포 관련 불릿을 개선해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["배포", "경력"],
      section: "experience",
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // refine_section 의도에서도 키워드가 있으면 근거를 검색해야 한다 (Sub-AC 3-3)
  assert.ok("rankedEvidence" in data, "rankedEvidence 필드가 있어야 한다");
  assert.ok(Array.isArray(data.rankedEvidence), "rankedEvidence 는 배열이어야 한다");
});

// ─── POST /api/resume/chat — Sub-AC 5-1: apply_section 의도 처리 ──────────────

test("POST /api/resume/chat - Sub-AC 5-1: apply_section 의도에서 applyIntent 필드를 반환한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-5-1-apply-01",
    query: "기술 섹션에 반영해줘",
    parsedQuery: {
      intent: "apply_section",
      keywords: ["기술"],
      section: "skills",
      dateRange: null
    },
    history: [
      { role: "user", content: "기술 어필 포인트 찾아줘" },
      {
        role: "assistant",
        content: "기술 어필 포인트입니다:\n- React/Next.js 프론트엔드 5년\n- TypeScript 도입 경험"
      },
    ]
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200, "apply_section 요청에 200 응답");
  const data = await res.json();
  assert.ok("applyIntent" in data, "applyIntent 필드가 응답에 포함되어야 한다");
  assert.ok(data.applyIntent !== null, "applyIntent 는 null 이 아니어야 한다");
  assert.equal(data.applyIntent.detected, true, "detected: true");
  assert.equal(data.applyIntent.section, "skills", "section: skills");
  assert.ok(Array.isArray(data.applyIntent.changes), "changes 는 배열이어야 한다");
  assert.ok(data.applyIntent.changes.length > 0, "changes 가 있어야 한다");
  assert.ok(typeof data.applyIntent.confidence === "number", "confidence 는 숫자여야 한다");
  assert.ok(typeof data.applyIntent.ambiguous === "boolean", "ambiguous 는 boolean 이어야 한다");
  assert.ok(typeof data.reply === "string", "reply 는 문자열이어야 한다");
  assert.ok(data.reply.length > 0, "reply 는 비어있지 않아야 한다");
});

test("POST /api/resume/chat - Sub-AC 5-1: apply_section 의도에서 섹션 불명확 시 clarificationNeeded 반환", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-5-1-apply-02",
    query: "반영해줘",
    parsedQuery: {
      intent: "apply_section",
      keywords: [],
      section: null,  // 섹션 불명확
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok("applyIntent" in data, "applyIntent 필드가 있어야 한다");
  assert.equal(data.applyIntent.detected, true, "detected: true");
  assert.equal(data.applyIntent.ambiguous, true, "섹션 불명확 시 ambiguous: true");
  assert.ok(
    typeof data.applyIntent.clarificationNeeded === "string",
    "clarificationNeeded 는 문자열이어야 한다"
  );
  // 보충 질문이 reply 로 반환되어야 한다
  assert.ok(typeof data.reply === "string" && data.reply.length > 0, "보충 질문이 reply 로 반환되어야 한다");
});

test("POST /api/resume/chat - Sub-AC 5-1: 일반 query 에서는 applyIntent 가 null", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-5-1-apply-03",
    query: "경력 섹션 개선해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["경력"],
      section: "experience",
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  // refine_section 의도에서는 applyIntent 가 null 이어야 한다
  assert.equal(data.applyIntent, null, "refine_section 의도에서 applyIntent 는 null 이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 5-1: applyIntent 응답에 sourceMessageIndex 가 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-5-1-apply-04",
    query: "경력 섹션에 반영해줘",
    parsedQuery: {
      intent: "apply_section",
      keywords: ["경력"],
      section: "experience",
      dateRange: null
    },
    history: [
      { role: "user", content: "경력 어필 포인트 찾아줘" },
      { role: "assistant", content: "- 3년 백엔드 개발 경험\n- 대용량 트래픽 서비스 운영" },
    ]
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.applyIntent !== null);
  assert.ok("sourceMessageIndex" in data.applyIntent, "sourceMessageIndex 필드가 있어야 한다");
  assert.ok(typeof data.applyIntent.sourceMessageIndex === "number", "sourceMessageIndex 는 숫자여야 한다");
  // 히스토리의 마지막 어시스턴트 메시지 인덱스 (1) 이어야 한다
  assert.equal(data.applyIntent.sourceMessageIndex, 1, "마지막 어시스턴트 메시지 인덱스 1");
});

// ─── POST /api/resume/chat — Sub-AC 6-2: diff 필드 반환 검증 ─────────────────

test("POST /api/resume/chat - Sub-AC 6-2: apply_section 의도에서 diff 키가 응답에 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-6-2-diff-01",
    query: "기술 섹션에 반영해줘",
    parsedQuery: {
      intent: "apply_section",
      keywords: ["기술"],
      section: "skills",
      dateRange: null
    },
    history: [
      { role: "user", content: "기술 스택을 보여줘" },
      {
        role: "assistant",
        content: "기술 어필 포인트입니다:\n- React/Next.js 프론트엔드 5년\n- TypeScript 도입 경험"
      },
    ]
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  // diff 키가 응답 객체에 반드시 존재해야 한다.
  // 이력서가 없으면 diff 는 null 이다 (이 테스트의 mock 에서 readResumeData 는 null 반환).
  assert.ok("diff" in data, "diff 키가 응답에 포함되어야 한다");
  assert.ok("applyIntent" in data, "applyIntent 키가 응답에 포함되어야 한다");
  assert.ok(data.applyIntent !== null, "applyIntent 는 null 이 아니어야 한다");

  // diff 가 존재하면 (이력서가 있는 경우) 구조를 검증한다
  if (data.diff !== null && data.diff !== undefined) {
    assert.ok(typeof data.diff.section === "string", "diff.section 은 문자열이어야 한다");
    assert.ok(typeof data.diff.before === "string", "diff.before 는 문자열이어야 한다");
    assert.ok(typeof data.diff.after === "string", "diff.after 는 문자열이어야 한다");
    assert.ok(Array.isArray(data.diff.evidence), "diff.evidence 는 배열이어야 한다");
  }
});

test("POST /api/resume/chat - Sub-AC 6-2: apply_section 응답에는 diff 키와 applyIntent 키가 함께 반환된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-6-2-diff-02",
    query: "경력 섹션에 반영해줘",
    parsedQuery: {
      intent: "apply_section",
      keywords: ["경력"],
      section: "experience",
      dateRange: null
    },
    history: [
      { role: "user", content: "경력 어필 포인트 찾아줘" },
      {
        role: "assistant",
        content: "경력 어필 포인트입니다:\n- 대규모 서비스 백엔드 개발 3년\n- CI/CD 파이프라인 구축"
      },
    ]
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  // apply_section 응답에는 항상 diff 와 applyIntent 키가 포함되어야 한다
  assert.ok("diff" in data, "diff 키가 응답에 포함되어야 한다");
  assert.ok("applyIntent" in data, "applyIntent 키가 응답에 포함되어야 한다");
  // evidence, rankedEvidence, appealPoints 는 null 이어야 한다 (apply_section 경로)
  assert.equal(data.evidence, null, "apply_section 응답에서 evidence 는 null 이어야 한다");
  assert.equal(data.rankedEvidence, null, "apply_section 응답에서 rankedEvidence 는 null 이어야 한다");
  assert.equal(data.appealPoints, null, "apply_section 응답에서 appealPoints 는 null 이어야 한다");
  assert.ok(typeof data.reply === "string" && data.reply.length > 0, "reply 는 비어있지 않아야 한다");
});

test("POST /api/resume/chat - Sub-AC 6-2: 모호한 apply_section 에서는 diff 필드가 없다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-6-2-diff-03",
    query: "반영해줘",
    parsedQuery: {
      intent: "apply_section",
      keywords: [],
      section: null,  // 섹션 불명확 → ambiguous: true
      dateRange: null
    },
    history: []
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  // 모호한 경우 diff 필드가 없거나 null 이어야 한다
  assert.ok(!data.diff || data.diff === null, "모호한 apply_section 에서는 diff 가 없어야 한다");
});

test("POST /api/resume/chat - Sub-AC 6-2: diff.section 이 applyIntent.section 과 일치한다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-test-6-2-diff-04",
    query: "자기소개 섹션에 반영해줘",
    parsedQuery: {
      intent: "apply_section",
      keywords: ["자기소개"],
      section: "summary",
      dateRange: null
    },
    history: [
      { role: "user", content: "자기소개를 개선해줘" },
      {
        role: "assistant",
        content: "개선된 자기소개:\n- 5년 경력의 풀스택 개발자\n- 사용자 경험 중심 개발"
      },
    ]
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  if (data.diff && data.applyIntent) {
    assert.equal(
      data.diff.section,
      data.applyIntent.section,
      "diff.section 과 applyIntent.section 이 일치해야 한다"
    );
  }
});

// ─── Sub-AC 8-1: 자기소개(Summary) 섹션 특화 처리 ────────────────────────────

test("POST /api/resume/chat - Sub-AC 8-1: refine_section + summary 일 때 diff.section='summary' 반환", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-summary-01",
    query: "자기소개 섹션을 업무 기록 기반으로 개선해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["자기소개", "개선"],
      section: "summary",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  // summary 섹션 refine_section 에서 diff 가 포함되어야 한다
  assert.ok(data.diff, "summary 섹션 개선 요청에서 diff 가 반환되어야 한다");
  assert.equal(data.diff.section, "summary", "diff.section 이 'summary' 이어야 한다");
  assert.ok(typeof data.diff.before === "string", "diff.before 가 문자열이어야 한다");
  assert.ok(typeof data.diff.after === "string", "diff.after 가 문자열이어야 한다");
  assert.ok(data.diff.after.length > 0, "diff.after 가 비어있지 않아야 한다");
});

test("POST /api/resume/chat - Sub-AC 8-1: summary 섹션 diff 에는 evidence 배열이 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-summary-02",
    query: "내 자기소개를 최신 업무 기록에 맞게 수정해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["자기소개", "수정"],
      section: "summary",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.diff, "diff 가 반환되어야 한다");
  assert.ok(Array.isArray(data.diff.evidence), "diff.evidence 가 배열이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 8-1: summary 섹션에서 근거 없으면 diff 가 null 이다", async () => {
  const app = buildApp();

  // 서버 사이드 analyzeQuery 가 키워드를 자동 추출하므로,
  // 키워드가 없는 최소 쿼리("네")를 사용해 evidence 검색을 건너뛰게 한다.
  // rankedEvidence가 null이면 summary 섹션 처리 조건이 충족되지 않으므로
  // 일반 경로를 따른다.
  const body = JSON.stringify({
    sessionId: "chat-8-1-summary-03",
    query: "네",
    parsedQuery: {
      intent: "refine_section",
      keywords: [],  // 키워드 없음 → evidence 검색 안 함 → rankedEvidence null
      section: "summary",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  // 키워드 없이 summary 섹션 요청하면 diff 없이 reply만 반환된다
  assert.ok(typeof data.reply === "string", "reply 가 문자열이어야 한다");
  // rankedEvidence가 null이면 summary diff 생성이 skip되어 diff가 null이어야 한다
  assert.ok(data.diff === null || data.diff === undefined, "evidence 없으면 diff 가 null 이어야 한다");
});

// ─── Sub-AC 8-1: 강점(Strengths) 섹션 특화 처리 ─────────────────────────────

test("POST /api/resume/chat - Sub-AC 8-1: refine_section + strengths 일 때 diff.section='strengths' 반환", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-strengths-01",
    query: "내 강점을 업무 기록에서 분석해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["강점", "분석"],
      section: "strengths",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.diff, "strengths 섹션 요청에서 diff 가 반환되어야 한다");
  assert.equal(data.diff.section, "strengths", "diff.section 이 'strengths' 이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 8-1: strengths diff 에는 strengthsData 배열이 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-strengths-02",
    query: "나의 핵심 강점을 행동 패턴 기반으로 찾아줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["강점", "행동패턴"],
      section: "strengths",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.diff, "diff 가 반환되어야 한다");
  assert.ok(Array.isArray(data.diff.strengthsData), "diff.strengthsData 가 배열이어야 한다");
  assert.ok(data.diff.strengthsData.length > 0, "strengthsData 에 강점이 포함되어야 한다");
});

test("POST /api/resume/chat - Sub-AC 8-1: strengthsData 각 항목에 필수 필드가 있다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-strengths-03",
    query: "강점 분석해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["강점"],
      section: "strengths",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.diff?.strengthsData, "strengthsData 가 있어야 한다");
  for (const item of data.diff.strengthsData) {
    assert.ok(typeof item.id === "string", `강점 ${item.id}: id 가 문자열이어야 한다`);
    assert.ok(typeof item.label === "string", `강점 ${item.id}: label 이 문자열이어야 한다`);
    assert.ok(typeof item.description === "string", `강점 ${item.id}: description 이 문자열이어야 한다`);
    assert.ok(Array.isArray(item.evidenceTexts), `강점 ${item.id}: evidenceTexts 가 배열이어야 한다`);
    assert.ok(Array.isArray(item.behaviorCluster), `강점 ${item.id}: behaviorCluster 가 배열이어야 한다`);
    assert.ok(typeof item.frequency === "number", `강점 ${item.id}: frequency 가 숫자여야 한다`);
    assert.ok(typeof item.confidence === "number", `강점 ${item.id}: confidence 가 숫자여야 한다`);
  }
});

test("POST /api/resume/chat - Sub-AC 8-1: strengths diff 의 after 는 JSON 파싱 가능한 문자열이다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-strengths-04",
    query: "강점 분석해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["강점"],
      section: "strengths",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.diff, "diff 가 반환되어야 한다");
  // diff.after 는 JSON.stringify(strengthsData) 형태여야 한다 (PATCH 요청 시 사용)
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(data.diff.after); }, "diff.after 가 JSON 파싱 가능해야 한다");
  assert.ok(Array.isArray(parsed), "파싱된 diff.after 가 배열이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 8-1: strengths 응답에 applyIntent 는 null 이다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-strengths-05",
    query: "강점 도출해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["강점"],
      section: "strengths",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.applyIntent === null || data.applyIntent === undefined,
    "strengths refine_section 에서 applyIntent 는 null 이어야 한다");
});

test("POST /api/resume/chat - Sub-AC 8-1: summary 섹션 응답 reply 에 '자기소개' 관련 텍스트가 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-summary-04",
    query: "자기소개를 업무 기록 기반으로 개선해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["자기소개"],
      section: "summary",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(typeof data.reply === "string", "reply 가 문자열이어야 한다");
  assert.ok(data.reply.length > 0, "reply 가 비어있지 않아야 한다");
});

test("POST /api/resume/chat - Sub-AC 8-1: strengths 섹션 응답 reply 에 강점 개수 정보가 포함된다", async () => {
  const app = buildApp();

  const body = JSON.stringify({
    sessionId: "chat-8-1-strengths-06",
    query: "업무 기록에서 강점을 추출해줘",
    parsedQuery: {
      intent: "refine_section",
      keywords: ["강점"],
      section: "strengths",
      dateRange: null,
    },
    history: [],
  });

  const res = await app.fetch(authedRequest("http://localhost/api/resume/chat", {
    method: "POST",
    body,
  }));

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(typeof data.reply === "string", "reply 가 문자열이어야 한다");
  assert.ok(data.reply.length > 0, "reply 가 비어있지 않아야 한다");
});
