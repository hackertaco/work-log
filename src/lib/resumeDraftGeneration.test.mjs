/**
 * Tests for resumeDraftGeneration.mjs — Chat-based Resume Draft Bootstrap.
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/resumeDraftGeneration.test.mjs
 *
 * Coverage:
 *   - aggregateSignals: signal extraction, counting, truncation
 *   - loadWorkLogs: date-range filtering, missing-file tolerance
 *   - generateResumeDraft: API key guard, disabled-OpenAI guard, empty-data guard
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateSignals,
  loadWorkLogs,
  generateResumeDraft
} from "./resumeDraftGeneration.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Build a minimal daily work log record with controllable fields. */
function makeWorkLog(date, overrides = {}) {
  return {
    date,
    counts: {
      gitCommits: 5,
      codexSessions: 1,
      claudeSessions: 1,
      slackContexts: 2,
      ...(overrides.counts ?? {})
    },
    highlights: {
      businessOutcomes: ["온보딩 마찰을 줄였다", "배포 안정성을 높였다"],
      keyChanges: ["retry 설정 추가", "태블릿 레이아웃 개선"],
      workingStyleSignals: ["안정성 우선", "마찰 제거 중심"],
      storyThreads: [
        {
          repo: "acme-api",
          outcome: "응답 속도 20% 개선",
          keyChange: "캐싱 레이어 추가",
          why: "DB 부하 감소",
          decision: "Redis 도입"
        }
      ],
      commitAnalysis: ["acme-api에서 5개 커밋 — 안정화"],
      impact: ["사용자 이탈율 감소"],
      aiReview: ["캐싱 전략 검토 후 TTL 조정"],
      ...(overrides.highlights ?? {})
    },
    resume: {
      candidates: ["캐싱 도입으로 응답속도 20% 개선"],
      companyCandidates: ["Acme API 운영 안정화"],
      ...(overrides.resume ?? {})
    },
    ...(overrides.root ?? {})
  };
}

// ─── aggregateSignals ─────────────────────────────────────────────────────────

describe("aggregateSignals", () => {
  test("returns zero counts and empty text for empty input", () => {
    const result = aggregateSignals([]);
    assert.equal(result.commitCount, 0);
    assert.equal(result.sessionCount, 0);
    assert.equal(result.slackCount, 0);
    assert.deepEqual(result.repos, []);
    assert.equal(result.signalText, "");
  });

  test("counts commits from each work log", () => {
    const logs = [
      makeWorkLog("2026-01-01", { counts: { gitCommits: 10 } }),
      makeWorkLog("2026-01-02", { counts: { gitCommits: 7 } })
    ];
    const result = aggregateSignals(logs);
    assert.equal(result.commitCount, 17);
  });

  test("counts sessions (codex + claude) from each work log", () => {
    // Note: aggregateSignals also increments sessionCount for each aiReview item.
    // makeWorkLog provides 1 aiReview entry per log by default, so each log adds +1.
    const logs = [
      makeWorkLog("2026-01-01", { counts: { codexSessions: 3, claudeSessions: 2, gitCommits: 0 } }),
      makeWorkLog("2026-01-02", { counts: { codexSessions: 1, claudeSessions: 0, gitCommits: 0 } })
    ];
    const result = aggregateSignals(logs);
    // 3+2 = 5 from log1 counts, 1+0 = 1 from log2 counts,
    // + 1 aiReview item per log (aiReview.length added per log) = 5+1+1+1 = 8
    assert.ok(result.sessionCount >= 6, `sessionCount should be at least 6, got ${result.sessionCount}`);
  });

  test("counts slack contexts", () => {
    const logs = [
      makeWorkLog("2026-01-01", { counts: { slackContexts: 3, gitCommits: 0 } }),
      makeWorkLog("2026-01-02", { counts: { slackContexts: 5, gitCommits: 0 } })
    ];
    const result = aggregateSignals(logs);
    assert.equal(result.slackCount, 8);
  });

  test("extracts repo names from storyThreads", () => {
    const logs = [
      makeWorkLog("2026-01-01"),
      makeWorkLog("2026-01-02", {
        highlights: {
          storyThreads: [{ repo: "other-repo", outcome: "테스트" }]
        }
      })
    ];
    const result = aggregateSignals(logs);
    assert.ok(result.repos.includes("acme-api"), "should include acme-api");
    assert.ok(result.repos.includes("other-repo"), "should include other-repo");
  });

  test("produces signalText with date headers", () => {
    const logs = [
      makeWorkLog("2026-01-01"),
      makeWorkLog("2026-01-02")
    ];
    const result = aggregateSignals(logs);
    assert.ok(result.signalText.includes("## 2026-01-01"), "should include date header");
    assert.ok(result.signalText.includes("## 2026-01-02"), "should include date header");
  });

  test("includes businessOutcomes in signal text", () => {
    const log = makeWorkLog("2026-01-01");
    const result = aggregateSignals([log]);
    assert.ok(result.signalText.includes("온보딩 마찰을 줄였다"), "should include outcome");
  });

  test("includes workingStyleSignals in signal text", () => {
    const log = makeWorkLog("2026-01-01");
    const result = aggregateSignals([log]);
    assert.ok(result.signalText.includes("작업스타일"), "should include workingStyleSignals header");
    assert.ok(result.signalText.includes("안정성 우선"), "should include style signal text");
  });

  test("includes resume candidates in signal text", () => {
    const log = makeWorkLog("2026-01-01");
    const result = aggregateSignals([log]);
    assert.ok(result.signalText.includes("이력서후보"), "should include resume candidates header");
    assert.ok(result.signalText.includes("캐싱 도입으로 응답속도 20% 개선"), "should include candidate text");
  });

  test("truncates signal text when it exceeds 20,000 characters", () => {
    // aggregateSignals slices each field to 3 items max, so we need many dates to accumulate
    // enough text.  Each log contributes ~300–400 chars. 100 dates × ~400 chars = 40k chars.
    const logs = Array.from({ length: 100 }, (_, i) => {
      const date = `2026-01-${String(i + 1).padStart(2, "0")}`;
      return makeWorkLog(date, {
        highlights: {
          businessOutcomes: ["A".repeat(200), "B".repeat(200), "C".repeat(200)],
          keyChanges: ["D".repeat(200), "E".repeat(200), "F".repeat(200)],
          workingStyleSignals: ["G".repeat(200), "H".repeat(200)],
          storyThreads: [],
          commitAnalysis: ["I".repeat(200)],
          impact: ["J".repeat(200)],
          aiReview: ["K".repeat(200)]
        }
      });
    });
    const result = aggregateSignals(logs);
    assert.ok(result.signalText.length <= 20_500, "should not significantly exceed 20k limit");
    assert.ok(result.signalText.includes("[...이하 생략]"), "should include truncation marker");
  });

  test("handles work logs missing highlights field gracefully", () => {
    const log = { date: "2026-01-01", counts: {}, highlights: {} };
    const result = aggregateSignals([log]);
    assert.equal(typeof result.signalText, "string");
    assert.ok(result.signalText.includes("## 2026-01-01"));
  });

  test("handles missing date field gracefully", () => {
    const log = { counts: {}, highlights: {} }; // no date
    const result = aggregateSignals([log]);
    assert.ok(result.signalText.includes("## unknown"));
  });

  test("includes raw commit subjects from projects in signal text", () => {
    const log = makeWorkLog("2026-01-01", {
      root: {
        projects: [
          {
            repo: "my-api",
            commits: [
              { subject: "feat: 새로운 결제 플로우 추가" },
              { subject: "fix: 타임아웃 에러 핸들링 개선" },
            ],
          },
          {
            repo: "my-frontend",
            commits: [
              { subject: "feat: 대시보드 차트 컴포넌트 구현" },
            ],
          },
        ],
      },
    });
    const result = aggregateSignals([log]);
    assert.ok(result.signalText.includes("[my-api] 커밋:"), "should include repo-prefixed commit section");
    assert.ok(result.signalText.includes("새로운 결제 플로우"), "should include commit subject text");
    assert.ok(result.signalText.includes("[my-frontend] 커밋:"), "should include second repo");
  });

  test("filters out short commit subjects (< 10 chars)", () => {
    const log = makeWorkLog("2026-01-01", {
      root: {
        projects: [
          {
            repo: "my-api",
            commits: [
              { subject: "fix typo" },  // 8 chars, should be excluded
              { subject: "feat: 새로운 기능을 추가하여 사용자 경험 개선" },  // long enough
            ],
          },
        ],
      },
    });
    const result = aggregateSignals([log]);
    // "fix typo" is < 10 chars, should not appear
    assert.ok(!result.signalText.includes("fix typo"), "should not include short commit subjects");
    assert.ok(result.signalText.includes("새로운 기능을 추가"), "should include long commit subject");
  });

  test("limits raw commit subjects per project to 4", () => {
    const log = makeWorkLog("2026-01-01", {
      root: {
        projects: [
          {
            repo: "my-api",
            commits: Array.from({ length: 10 }, (_, i) => ({
              subject: `feat: 기능 변경 ${i + 1}번 — 상세 설명 추가`,
            })),
          },
        ],
      },
    });
    const result = aggregateSignals([log]);
    // Count commit subjects in the signal text for this repo
    const commitLine = result.signalText.split("\n").find((l) => l.includes("[my-api] 커밋:"));
    assert.ok(commitLine, "should have commit line for my-api");
    const subjects = commitLine.split(" | ");
    assert.ok(subjects.length <= 4, `should have at most 4 subjects, got ${subjects.length}`);
  });
});

// ─── loadWorkLogs ─────────────────────────────────────────────────────────────

describe("loadWorkLogs", () => {
  test("returns an array (may be empty when no data dir)", async () => {
    const result = await loadWorkLogs({ fromDate: "2020-01-01", toDate: "2020-01-31" });
    assert.ok(Array.isArray(result), "should return array");
  });

  test("returns empty array for future date range with no data", async () => {
    const result = await loadWorkLogs({ fromDate: "2099-01-01", toDate: "2099-12-31" });
    assert.deepEqual(result, []);
  });

  test("each loaded log has a date property", async () => {
    const result = await loadWorkLogs({ fromDate: "2026-03-01" });
    for (const log of result) {
      assert.ok(
        typeof log.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(log.date),
        `log.date should be YYYY-MM-DD, got ${log.date}`
      );
    }
  });

  test("respects fromDate filter (no log older than fromDate)", async () => {
    const fromDate = "2026-03-28";
    const result = await loadWorkLogs({ fromDate });
    for (const log of result) {
      assert.ok(
        log.date >= fromDate,
        `log.date ${log.date} should be >= fromDate ${fromDate}`
      );
    }
  });

  test("respects toDate filter (no log newer than toDate)", async () => {
    const toDate = "2026-03-26";
    const result = await loadWorkLogs({ toDate });
    for (const log of result) {
      assert.ok(
        log.date <= toDate,
        `log.date ${log.date} should be <= toDate ${toDate}`
      );
    }
  });
});

// ─── generateResumeDraft (guard clauses only — no real LLM calls) ─────────────

describe("generateResumeDraft", () => {
  test("throws when OPENAI_API_KEY is not set", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await assert.rejects(
        () => generateResumeDraft({ fromDate: "2026-03-24" }),
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
        () => generateResumeDraft({ fromDate: "2026-03-24" }),
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

  test("throws when no work logs exist for the date range", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    const savedDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.WORK_LOG_DISABLE_OPENAI;
    try {
      await assert.rejects(
        () => generateResumeDraft({ fromDate: "2099-01-01", toDate: "2099-01-31" }),
        /No work log data found/
      );
    } finally {
      if (savedKey) {
        process.env.OPENAI_API_KEY = savedKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      if (savedDisable) {
        process.env.WORK_LOG_DISABLE_OPENAI = savedDisable;
      } else {
        delete process.env.WORK_LOG_DISABLE_OPENAI;
      }
    }
  });

  test("returns companyStories alongside legacy draft fields", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    const savedDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    const savedFetch = globalThis.fetch;

    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.WORK_LOG_DISABLE_OPENAI;

    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          output_text: JSON.stringify({
            company_stories: [
              {
                company: "브릿지코드",
                role: "선임 매니저",
                period_label: "2024.02 – 2025.11",
                narrative: "M&A 자동화와 AI 매칭 흐름을 제품화한 경험.",
                projects: [
                  {
                    title: "AI 기반 딜 자동 추천 시스템",
                    one_liner: "Claude와 Milvus로 제안 속도를 끌어올린 매칭 시스템",
                    problem: "딜 매칭이 수작업이라 속도와 품질 편차가 컸다.",
                    solution: [
                      "Claude 기반 조건 요약 설계",
                      "Milvus 벡터 검색 기반 자동 추천 구축"
                    ],
                    result: ["제안 속도 10배 향상"],
                    stack: ["Claude", "Milvus", "Python"],
                    capabilities: ["LLM 제품화", "RAG 설계"]
                  }
                ],
                proven_capabilities: ["AI 기반 문제 해결", "추천 시스템 설계"]
              }
            ],
            strength_candidates: [
              {
                label: "운영 안정성 우선 개선",
                description: "실패 가능성이 큰 지점을 먼저 줄이는 패턴.",
                frequency: 3,
                behavior_cluster: ["예외 처리", "호환성 보강"],
                evidence_examples: ["예외 처리 보강"]
              }
            ],
            experience_summaries: [
              {
                company: "브릿지코드",
                highlights: ["AI 자동 추천 시스템 구축"],
                skills: ["Claude", "Milvus"],
                suggested_bullets: ["AI 자동 추천으로 제안 속도 향상"]
              }
            ],
            suggested_summary: "AI와 자동화를 연결하는 프로덕트 엔지니어.",
            data_gaps: []
          })
        };
      }
    });

    try {
      const draft = await generateResumeDraft({
        fromDate: "2026-03-31",
        toDate: "2026-03-31",
        existingResume: {
          experience: [
            {
              company: "브릿지코드",
              title: "선임 매니저",
              start_date: "2024-02",
              end_date: "2025-11"
            }
          ]
        }
      });

      assert.ok(Array.isArray(draft.companyStories), "companyStories should be an array");
      assert.equal(draft.companyStories[0].company, "브릿지코드");
      assert.equal(draft.companyStories[0].role, "선임 매니저");
      assert.equal(draft.companyStories[0].projects[0].title, "AI 기반 딜 자동 추천 시스템");
      assert.deepEqual(draft.companyStories[0].projects[0].result, ["제안 속도 10배 향상"]);
      assert.ok(Array.isArray(draft.strengthCandidates), "legacy strengthCandidates should remain");
      assert.ok(Array.isArray(draft.experienceSummaries), "legacy experienceSummaries should remain");
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey) {
        process.env.OPENAI_API_KEY = savedKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      if (savedDisable) {
        process.env.WORK_LOG_DISABLE_OPENAI = savedDisable;
      } else {
        delete process.env.WORK_LOG_DISABLE_OPENAI;
      }
    }
  });
});
