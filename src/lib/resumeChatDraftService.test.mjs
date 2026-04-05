/**
 * Tests for resumeChatDraftService.mjs — Chat-based Resume Draft Service.
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/resumeChatDraftService.test.mjs
 *
 * Coverage:
 *   - buildChatDraftContext: pipeline orchestration, empty data handling
 *   - refineSectionWithChat: API key guard, disabled-OpenAI guard, evidence filtering
 *   - searchEvidenceByKeywords: empty keywords guard
 *   - extractDraftContentForSection: per-section extraction
 *   - Internal helpers: keyword extraction, evidence deduplication, clarification questions
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

import {
  buildChatDraftContext,
  refineSectionWithChat,
  searchEvidenceByKeywords,
  extractDraftContentForSection,
} from "./resumeChatDraftService.mjs";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDraft(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-04-01T00:00:00.000Z",
    dateRange: { from: "2026-03-01", to: "2026-04-01" },
    sources: {
      dates: ["2026-03-01", "2026-03-15"],
      commitCount: 42,
      sessionCount: 8,
      slackCount: 5,
      repos: ["acme-api", "dashboard"],
    },
    strengthCandidates: [
      {
        id: "str-cand-0",
        label: "운영 안정성 우선 개선",
        description: "장애 예방을 위한 선제적 안전장치 구축 패턴",
        frequency: 5,
        behaviorCluster: ["모니터링 강화", "에러 핸들링 체계화"],
        evidenceExamples: ["retry 로직 추가로 장애 재발 방지"],
        dates: [],
      },
      {
        id: "str-cand-1",
        label: "온보딩 마찰 제거",
        description: "사용자 온보딩 경험 개선에 지속적으로 기여",
        frequency: 3,
        behaviorCluster: ["UX 간소화", "가이드 개선"],
        evidenceExamples: ["온보딩 플로우 단순화로 이탈율 15% 감소"],
        dates: [],
      },
    ],
    experienceSummaries: [
      {
        company: "Acme Corp",
        highlights: ["API 응답속도 20% 개선"],
        skills: ["Node.js", "Redis", "PostgreSQL"],
        suggestedBullets: [
          "Redis 캐싱 레이어 도입으로 API 평균 응답시간 20% 단축",
          "배포 파이프라인 안정화로 장애 복구 시간 50% 감소",
        ],
        dates: ["2026-03-01", "2026-03-15"],
      },
    ],
    suggestedSummary: "운영 안정성과 사용자 경험 개선에 강점을 가진 풀스택 엔지니어",
    dataGaps: ["팀 규모에 대한 정보 부족"],
    ...overrides,
  };
}

function makeResume() {
  return {
    meta: { language: "ko", schemaVersion: 1 },
    summary: "경험 많은 소프트웨어 엔지니어",
    experience: [
      {
        company: "Acme Corp",
        title: "Senior Engineer",
        start_date: "2024-01",
        end_date: null,
        bullets: ["기존 불릿 1", "기존 불릿 2"],
      },
    ],
    skills: {
      technical: ["JavaScript", "TypeScript"],
      languages: ["Korean", "English"],
      tools: ["VS Code"],
    },
    projects: [
      {
        name: "work-log",
        description: "업무 로그 자동화 도구",
        bullets: ["일일 업무 자동 수집"],
      },
    ],
  };
}

// ─── extractDraftContentForSection ───────────────────────────────────────────

describe("extractDraftContentForSection", () => {
  test("returns empty collections for null draft", () => {
    const result = extractDraftContentForSection(null, "experience");
    assert.deepEqual(result.strengths, []);
    assert.deepEqual(result.experiences, []);
    assert.equal(result.summary, "");
  });

  test("returns experiences for 'experience' section", () => {
    const draft = makeDraft();
    const result = extractDraftContentForSection(draft, "experience");
    assert.equal(result.experiences.length, 1);
    assert.equal(result.experiences[0].company, "Acme Corp");
    assert.deepEqual(result.strengths, []);
    assert.equal(result.summary, "");
  });

  test("returns summary for 'summary' section", () => {
    const draft = makeDraft();
    const result = extractDraftContentForSection(draft, "summary");
    assert.ok(result.summary.includes("풀스택 엔지니어"));
    assert.equal(result.strengths.length, 2); // also returns strengths for summary
  });

  test("returns strengths for 'strengths' section", () => {
    const draft = makeDraft();
    const result = extractDraftContentForSection(draft, "strengths");
    assert.equal(result.strengths.length, 2);
    assert.equal(result.strengths[0].label, "운영 안정성 우선 개선");
  });

  test("returns skills-focused experiences for 'skills' section", () => {
    const draft = makeDraft();
    const result = extractDraftContentForSection(draft, "skills");
    assert.equal(result.experiences.length, 1);
    // highlights and suggestedBullets should be cleared for skills focus
    assert.deepEqual(result.experiences[0].highlights, []);
    assert.deepEqual(result.experiences[0].suggestedBullets, []);
  });

  test("handles unknown section gracefully", () => {
    const draft = makeDraft();
    const result = extractDraftContentForSection(draft, "certifications");
    // Returns full content for unknown sections
    assert.equal(result.strengths.length, 2);
    assert.equal(result.experiences.length, 1);
  });
});

// ─── buildChatDraftContext ────────────────────────────────────────────────────

describe("buildChatDraftContext", () => {
  test("returns empty result for future date range with no data", async () => {
    const result = await buildChatDraftContext({
      fromDate: "2099-01-01",
      toDate: "2099-12-31",
      skipLLM: true,
    });
    assert.equal(result.draft, null);
    assert.deepEqual(result.evidencePool, []);
    assert.equal(result.sourceBreakdown.totalDates, 0);
    assert.ok(result.dataGaps.length > 0, "should report data gap");
  });

  test("collects evidence without LLM when skipLLM=true", async () => {
    // This test will pass even without actual data — it validates the pipeline structure
    const result = await buildChatDraftContext({
      fromDate: "2026-03-01",
      toDate: "2026-04-01",
      skipLLM: true,
    });

    // Result structure should always be valid
    assert.ok(Array.isArray(result.evidencePool), "evidencePool should be array");
    assert.ok(typeof result.sourceBreakdown === "object", "sourceBreakdown should be object");
    assert.ok(
      typeof result.sourceBreakdown.commits === "number",
      "commits count should be number"
    );
    assert.ok(
      typeof result.sourceBreakdown.slack === "number",
      "slack count should be number"
    );
    assert.ok(
      typeof result.sourceBreakdown.sessions === "number",
      "sessions count should be number"
    );
  });
});

// ─── searchEvidenceByKeywords ────────────────────────────────────────────────

describe("searchEvidenceByKeywords", () => {
  test("returns empty array for empty keywords", async () => {
    const result = await searchEvidenceByKeywords([]);
    assert.deepEqual(result, []);
  });

  test("returns empty array for null keywords", async () => {
    const result = await searchEvidenceByKeywords(null);
    assert.deepEqual(result, []);
  });

  test("returns array (may be empty) for valid keywords", async () => {
    const result = await searchEvidenceByKeywords(["API", "캐싱"]);
    assert.ok(Array.isArray(result), "should return array");
    // Each item should have the EvidenceItem shape
    for (const item of result) {
      assert.ok(["commits", "slack", "sessions"].includes(item.source));
      assert.ok(typeof item.text === "string");
      assert.ok(typeof item.score === "number");
    }
  });
});

// ─── refineSectionWithChat ──────────────────────────────────────────────────

describe("refineSectionWithChat", () => {
  test("throws when OPENAI_API_KEY is not set", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await assert.rejects(
        () =>
          refineSectionWithChat({
            section: "experience",
            userMessage: "경력 개선해줘",
          }),
        /OPENAI_API_KEY/
      );
    } finally {
      if (savedKey) process.env.OPENAI_API_KEY = savedKey;
    }
  });

  test("throws when WORK_LOG_DISABLE_OPENAI=1", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
    try {
      await assert.rejects(
        () =>
          refineSectionWithChat({
            section: "experience",
            userMessage: "경력 개선해줘",
          }),
        /WORK_LOG_DISABLE_OPENAI/
      );
    } finally {
      if (savedKey) {
        process.env.OPENAI_API_KEY = savedKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    }
  });

  test("returns clarifications when no evidence and no draft content", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    const savedDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.WORK_LOG_DISABLE_OPENAI;
    try {
      const result = await refineSectionWithChat({
        section: "experience",
        userMessage: "경력 개선해줘",
        draft: null,
        evidencePool: [],
      });
      assert.equal(result.section, "experience");
      assert.deepEqual(result.suggestions, []);
      assert.ok(result.clarifications.length > 0, "should return clarification questions");
    } finally {
      if (savedKey) {
        process.env.OPENAI_API_KEY = savedKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      if (savedDisable) {
        process.env.WORK_LOG_DISABLE_OPENAI = savedDisable;
      }
    }
  });

  test("returns section-specific clarifications for skills", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.WORK_LOG_DISABLE_OPENAI;
    try {
      const result = await refineSectionWithChat({
        section: "skills",
        userMessage: "스킬 개선해줘",
        draft: null,
        evidencePool: [],
      });
      assert.equal(result.section, "skills");
      assert.ok(
        result.clarifications.some((c) => c.includes("기술")),
        "should ask about technology areas"
      );
    } finally {
      if (savedKey) {
        process.env.OPENAI_API_KEY = savedKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  test("returns section-specific clarifications for summary", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.WORK_LOG_DISABLE_OPENAI;
    try {
      const result = await refineSectionWithChat({
        section: "summary",
        userMessage: "자기소개 수정해줘",
        draft: null,
        evidencePool: [],
      });
      assert.equal(result.section, "summary");
      assert.ok(result.clarifications.length > 0);
    } finally {
      if (savedKey) {
        process.env.OPENAI_API_KEY = savedKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });
});

// ─── Evidence collection from raw data sources (Sub-AC 2-2 enhancement) ─────

describe("buildChatDraftContext — raw data source evidence", () => {
  test("collects evidence from real work logs including raw commits", async () => {
    // Use actual data range where work logs exist
    const result = await buildChatDraftContext({
      fromDate: "2026-03-24",
      toDate: "2026-04-03",
      skipLLM: true,
    });

    // If work logs exist, evidence pool should be populated
    if (result.sourceBreakdown.totalDates > 0) {
      assert.ok(result.evidencePool.length > 0, "evidence pool should have items when data exists");

      // Verify all evidence items have correct shape
      for (const item of result.evidencePool) {
        assert.ok(["commits", "slack", "sessions"].includes(item.source), `invalid source: ${item.source}`);
        assert.ok(typeof item.text === "string" && item.text.length > 0, "evidence text must be non-empty");
        assert.ok(typeof item.score === "number" && item.score >= 0 && item.score <= 1, "score must be 0-1");
        assert.ok(typeof item.date === "string", "date must be string");
      }

      // Commit evidence should include raw commit subjects (from projects[].commits[])
      const commitEvidence = result.evidencePool.filter((e) => e.source === "commits");
      assert.ok(commitEvidence.length > 0, "should have commit-sourced evidence");

      // Session evidence should exist if any session data is available
      const sessionEvidence = result.evidencePool.filter((e) => e.source === "sessions");
      // sessionEvidence may be 0 if no AI sessions in the date range — that's ok
      assert.ok(Array.isArray(sessionEvidence));
    }
  });

  test("sourceBreakdown reflects actual evidence counts", async () => {
    const result = await buildChatDraftContext({
      fromDate: "2026-03-24",
      toDate: "2026-04-03",
      skipLLM: true,
    });

    const sb = result.sourceBreakdown;
    const actualCommits = result.evidencePool.filter((e) => e.source === "commits").length;
    const actualSlack = result.evidencePool.filter((e) => e.source === "slack").length;
    const actualSessions = result.evidencePool.filter((e) => e.source === "sessions").length;

    assert.strictEqual(sb.commits, actualCommits, "commits count must match evidence pool");
    assert.strictEqual(sb.slack, actualSlack, "slack count must match evidence pool");
    assert.strictEqual(sb.sessions, actualSessions, "sessions count must match evidence pool");
  });

  test("evidence pool is deduplicated (no duplicate source::text pairs)", async () => {
    const result = await buildChatDraftContext({
      fromDate: "2026-03-24",
      toDate: "2026-04-03",
      skipLLM: true,
    });

    const keys = new Set();
    for (const item of result.evidencePool) {
      const key = `${item.source}::${item.text.slice(0, 80)}`;
      assert.ok(!keys.has(key), `duplicate evidence: ${key}`);
      keys.add(key);
    }
  });

  test("evidence pool is sorted by score descending", async () => {
    const result = await buildChatDraftContext({
      fromDate: "2026-03-24",
      toDate: "2026-04-03",
      skipLLM: true,
    });

    for (let i = 1; i < result.evidencePool.length; i++) {
      assert.ok(
        result.evidencePool[i].score <= result.evidencePool[i - 1].score,
        `evidence pool not sorted at index ${i}: ${result.evidencePool[i].score} > ${result.evidencePool[i - 1].score}`
      );
    }
  });
});

// ─── Internal helper tests (via export behavior) ────────────────────────────

describe("edge cases", () => {
  test("extractDraftContentForSection handles draft with missing fields", () => {
    const emptyDraft = {
      schemaVersion: 1,
      generatedAt: "2026-04-01T00:00:00.000Z",
      dateRange: { from: "2026-03-01", to: "2026-04-01" },
      sources: { dates: [], commitCount: 0, sessionCount: 0, slackCount: 0, repos: [] },
      // Intentionally missing strengthCandidates, experienceSummaries, suggestedSummary
    };
    const result = extractDraftContentForSection(emptyDraft, "experience");
    assert.deepEqual(result.experiences, []);
  });

  test("extractDraftContentForSection for projects filters non-company entries", () => {
    const draft = makeDraft({
      experienceSummaries: [
        {
          company: "(주) 테스트",
          highlights: ["something"],
          skills: [],
          suggestedBullets: [],
          dates: [],
        },
        {
          company: "work-log",
          highlights: ["open source"],
          skills: [],
          suggestedBullets: ["오픈소스 기여"],
          dates: [],
        },
      ],
    });
    const result = extractDraftContentForSection(draft, "projects");
    // work-log (no (주)) should be included
    assert.ok(
      result.experiences.some((e) => e.company === "work-log"),
      "should include non-company projects"
    );
  });
});

// ─── Sub-AC 2-2: currentWorkLog injection ──────────────────────────────────

describe("buildChatDraftContext — currentWorkLog injection", () => {
  test("currentWorkLog is injected when its date is missing from loaded logs", async () => {
    // Use a future date that won't have a file on disk
    const futureDate = "2099-12-31";
    const mockWorkLog = {
      date: futureDate,
      counts: { gitCommits: 3, codexSessions: 1, claudeSessions: 0, slackContexts: 0 },
      highlights: {
        businessOutcomes: ["테스트 배포 자동화 구현"],
        storyThreads: [{ repo: "mock-repo", outcome: "자동화 완료" }],
      },
      projects: [
        {
          repo: "mock-repo",
          commits: [{ subject: "feat: 배포 자동화 파이프라인 추가", hash: "abc1234" }],
        },
      ],
    };

    const result = await buildChatDraftContext({
      fromDate: "2099-12-31",
      toDate: "2099-12-31",
      currentWorkLog: mockWorkLog,
      skipLLM: true,
    });

    // With the injected work log, we should get evidence even though no file exists
    assert.ok(result.evidencePool.length > 0, "evidence pool should contain items from injected workLog");
    assert.strictEqual(result.sourceBreakdown.totalDates, 1, "totalDates should be 1");
    assert.ok(
      result.evidencePool.some((e) => e.source === "commits"),
      "should have commit evidence from injected workLog"
    );
  });

  test("currentWorkLog is not duplicated when date already loaded", async () => {
    // Use a date range that may contain real data
    const result1 = await buildChatDraftContext({
      fromDate: "2026-03-24",
      toDate: "2026-04-03",
      skipLLM: true,
    });

    // Inject a workLog with a date that might already exist
    const existingDate = "2026-04-03";
    const result2 = await buildChatDraftContext({
      fromDate: "2026-03-24",
      toDate: "2026-04-03",
      currentWorkLog: { date: existingDate, counts: {}, highlights: {} },
      skipLLM: true,
    });

    // totalDates should be the same — no duplicate
    assert.strictEqual(
      result1.sourceBreakdown.totalDates,
      result2.sourceBreakdown.totalDates,
      "injecting an already-loaded date should not increase totalDates"
    );
  });

  test("currentWorkLog with no date is ignored gracefully", async () => {
    const result = await buildChatDraftContext({
      fromDate: "2099-01-01",
      toDate: "2099-01-31",
      currentWorkLog: { counts: {}, highlights: {} }, // no date field
      skipLLM: true,
    });

    // Should gracefully handle missing date — same as not passing currentWorkLog
    assert.strictEqual(result.draft, null);
    assert.ok(Array.isArray(result.evidencePool));
  });
});

// ─── Sub-AC 2-2: Direct Slack evidence collection (non-fatal) ───────────────

describe("buildChatDraftContext — direct Slack evidence collection", () => {
  test("Slack evidence collection is non-fatal when no token is set", async () => {
    // When SLACK_TOKEN is absent, collectDirectSlackEvidence should return []
    // and not throw. The pipeline should complete normally.
    const savedToken = process.env.SLACK_TOKEN;
    const savedUserToken = process.env.SLACK_USER_TOKEN;
    delete process.env.SLACK_TOKEN;
    delete process.env.SLACK_USER_TOKEN;

    try {
      const result = await buildChatDraftContext({
        fromDate: "2026-03-24",
        toDate: "2026-04-03",
        skipLLM: true,
      });

      // Should complete without error
      assert.ok(result !== null);
      assert.ok(Array.isArray(result.evidencePool));
      // sourceBreakdown should still be valid
      assert.ok(typeof result.sourceBreakdown.slack === "number");
    } finally {
      // Restore tokens
      if (savedToken !== undefined) process.env.SLACK_TOKEN = savedToken;
      if (savedUserToken !== undefined) process.env.SLACK_USER_TOKEN = savedUserToken;
    }
  });
});
