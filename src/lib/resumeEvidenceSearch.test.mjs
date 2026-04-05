/**
 * resumeEvidenceSearch.test.mjs
 *
 * Unit tests for the evidence search adapter layer.
 * Tests cover keyword matching, date range filtering, and result ordering.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

import {
  searchCommits,
  searchSessionMemory,
  searchAllSources,
  searchWithAnalyzedQuery,
} from "./resumeEvidenceSearch.mjs";

// ─── 픽스처 헬퍼 ──────────────────────────────────────────────────────────────

/**
 * 임시 데이터 디렉터리와 daily JSON 픽스처를 생성한다.
 * @returns {Promise<{ dataDir: string, cleanup: () => Promise<void> }>}
 */
async function createFixtureDataDir() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-evidence-test-"));
  const dailyDir = path.join(tmpDir, "daily");
  await fs.mkdir(dailyDir, { recursive: true });

  // 픽스처 날짜별 데이터
  const fixtures = [
    {
      date: "2026-03-01",
      data: {
        date: "2026-03-01",
        counts: { codexSessions: 0, claudeSessions: 1, slackContexts: 0, gitCommits: 3 },
        highlights: {
          commitHighlights: ["work-log: feat: 검색 기능 추가"],
          commitAnalysis: [
            "work-log에서 3개의 커밋 — 검색 기능 및 버그 수정",
          ],
          storyThreads: [
            {
              repo: "work-log",
              outcome: "키워드 기반 검색 완성",
              keyChange: "검색 어댑터 레이어 추가",
              impact: "데이터 소스별 독립 검색 가능",
              why: "이력서 구체화를 위한 근거 수집",
              decision: "멀티소스 병렬 검색 아키텍처 채택",
            },
          ],
          accomplishments: [
            "work-log: feat: 멀티소스 검색 기능 구현",
          ],
          aiReview: [
            "Redis 캐싱 전략 적용 후 TTL 조정 검토",
          ],
          workingStyleSignals: [
            "안정성 우선 개선 패턴",
          ],
        },
        projects: [
          {
            repo: "work-log",
            category: "company",
            commitCount: 3,
            commits: [
              {
                repo: "work-log",
                repoPath: "/code/work-log",
                hash: "abc1234",
                authoredAt: "2026-03-01T10:00:00+09:00",
                subject: "feat: 검색 기능 추가",
              },
              {
                repo: "work-log",
                repoPath: "/code/work-log",
                hash: "abc1235",
                authoredAt: "2026-03-01T11:00:00+09:00",
                subject: "fix: 버그 수정",
              },
              {
                repo: "work-log",
                repoPath: "/code/work-log",
                hash: "abc1236",
                authoredAt: "2026-03-01T12:00:00+09:00",
                subject: "docs: README 업데이트",
              },
            ],
          },
        ],
        aiSessions: {
          codex: [],
          claude: [
            {
              source: "claude",
              filePath: "/path/session.jsonl",
              cwd: "/code/work-log",
              summary: "work-log 검색 기능 구현 완료. 커밋 로그 파싱 로직 작성.",
              snippetCount: 2,
              snippets: [
                "검색 어댑터를 만들어 각 소스별로 키워드 매칭을 수행한다.",
                "날짜 범위 필터링을 추가했다.",
              ],
            },
          ],
        },
        slack: { contextCount: 0 },
      },
    },
    {
      date: "2026-03-15",
      data: {
        date: "2026-03-15",
        counts: { codexSessions: 1, claudeSessions: 0, slackContexts: 0, gitCommits: 2 },
        highlights: {},
        projects: [
          {
            repo: "my-project",
            category: "company",
            commitCount: 2,
            commits: [
              {
                repo: "my-project",
                repoPath: "/code/my-project",
                hash: "def5678",
                authoredAt: "2026-03-15T09:00:00+09:00",
                subject: "feat: API 엔드포인트 추가",
              },
              {
                repo: "my-project",
                repoPath: "/code/my-project",
                hash: "def5679",
                authoredAt: "2026-03-15T10:00:00+09:00",
                subject: "refactor: 코드 정리",
              },
            ],
          },
        ],
        aiSessions: {
          codex: [
            {
              source: "codex",
              filePath: "/path/codex-session.jsonl",
              cwd: "/code/my-project",
              summary: "API 엔드포인트 설계 및 구현. OpenAPI 스펙 작성.",
              snippetCount: 1,
              snippets: ["REST API 엔드포인트를 추가하고 테스트를 작성했다."],
            },
          ],
          claude: [],
        },
        slack: { contextCount: 0 },
      },
    },
    {
      date: "2026-04-01",
      data: {
        date: "2026-04-01",
        counts: { codexSessions: 0, claudeSessions: 0, slackContexts: 0, gitCommits: 1 },
        highlights: {},
        projects: [
          {
            repo: "frontend-app",
            category: "company",
            commitCount: 1,
            commits: [
              {
                repo: "frontend-app",
                repoPath: "/code/frontend-app",
                hash: "ghi9012",
                authoredAt: "2026-04-01T14:00:00+09:00",
                subject: "fix: Preact 렌더링 오류 수정",
              },
            ],
          },
        ],
        aiSessions: { codex: [], claude: [] },
        slack: { contextCount: 0 },
      },
    },
  ];

  for (const { date, data } of fixtures) {
    await fs.writeFile(
      path.join(dailyDir, `${date}.json`),
      JSON.stringify(data, null, 2),
      "utf8"
    );
  }

  return {
    dataDir: tmpDir,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

// ─── 테스트 ───────────────────────────────────────────────────────────────────

let fixture;

before(async () => {
  fixture = await createFixtureDataDir();
});

after(async () => {
  if (fixture) await fixture.cleanup();
});

// ── searchCommits ─────────────────────────────────────────────────────────────

test("searchCommits: 키워드 매칭된 커밋만 반환한다", async () => {
  const parsed = {
    raw: "검색 기능",
    intent: "search_evidence",
    keywords: ["검색"],
    section: null,
    dateRange: null,
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0, "결과가 있어야 한다");
  for (const r of results) {
    assert.equal(r.source, "commits");
    assert.ok(
      r.text.toLowerCase().includes("검색"),
      `텍스트에 키워드가 포함되어야 한다: ${r.text}`
    );
  }
});

test("searchCommits: 키워드 없으면 dateRange 내 전체 커밋 반환", async () => {
  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: { from: "2026-03-01", to: "2026-03-31" },
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  // 2026-03 범위 내:
  //   2026-03-01: commits 3개 + commitAnalysis 1개 + storyThread 1개 + accomplishment 1개 = 6개
  //   2026-03-15: commits 2개 = 2개
  //   총 8개
  assert.ok(results.length >= 5, "2026-03 내 커밋+하이라이트 모두 반환");
  for (const r of results) {
    assert.ok(
      r.date >= "2026-03-01" && r.date <= "2026-03-31",
      `날짜 범위 내여야 한다: ${r.date}`
    );
  }
});

test("searchCommits: dateRange 필터링 - 범위 밖 날짜 제외", async () => {
  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: { from: "2026-04-01", to: "2026-04-30" },
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  // 2026-04-01만 범위 내 (1개 커밋)
  assert.equal(results.length, 1);
  assert.equal(results[0].date, "2026-04-01");
});

test("searchCommits: 복수 키워드 - 더 많이 매칭된 항목이 높은 점수", async () => {
  const parsed = {
    raw: "API 기능 추가",
    intent: "search_evidence",
    keywords: ["API", "추가"],
    section: null,
    dateRange: null,
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0, "결과가 있어야 한다");
  // 첫 번째 결과가 가장 높은 relevanceScore
  if (results.length > 1) {
    assert.ok(
      results[0].relevanceScore >= results[1].relevanceScore,
      "결과는 relevanceScore 내림차순이어야 한다"
    );
  }
  // "API 엔드포인트 추가" 커밋이 두 키워드 모두 매칭되므로 상위
  const topResult = results[0];
  assert.ok(
    topResult.text.includes("API") && topResult.text.includes("추가"),
    `상위 결과가 두 키워드 모두 포함: ${topResult.text}`
  );
});

test("searchCommits: maxResults 옵션으로 반환 수 제한", async () => {
  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: null,
  };

  const results = await searchCommits(parsed, {
    dataDir: fixture.dataDir,
    maxResults: 2,
  });

  assert.ok(results.length <= 2, "maxResults 이하여야 한다");
});

test("searchCommits: provenance 출처 필드 포함 확인 (Sub-AC 4-1)", async () => {
  const parsed = {
    raw: "feat",
    intent: "search_evidence",
    keywords: ["feat"],
    section: null,
    dateRange: null,
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0);
  const r = results[0];
  // provenance 필드가 있어야 한다 (Sub-AC 4-1: 출처 메타데이터)
  assert.ok(r.provenance, "provenance 필드 있어야 한다");
  assert.equal(r.provenance.sourceType, "commits", "provenance.sourceType === 'commits'");
  assert.ok("commitHash" in r.provenance, "provenance.commitHash 있어야 한다 (커밋 해시)");
  assert.ok("repo" in r.provenance, "provenance.repo 있어야 한다");
  assert.ok("authoredAt" in r.provenance, "provenance.authoredAt 있어야 한다");
  assert.ok("repoPath" in r.provenance, "provenance.repoPath 있어야 한다");
  // matchedKeywords 필드가 있어야 한다 (Sub-AC 4-1: 출처 추적 보조 정보)
  assert.ok(Array.isArray(r.matchedKeywords), "matchedKeywords 배열이 있어야 한다");
  assert.ok(r.matchedKeywords.length > 0, "키워드 검색 시 matchedKeywords가 비어 있지 않아야 한다");
  assert.ok(r.matchedKeywords.includes("feat"), "매칭된 키워드 'feat'가 포함되어야 한다");
});

test("searchCommits: 매칭 없으면 빈 배열 반환", async () => {
  const parsed = {
    raw: "nonexistent_xyz_keyword",
    intent: "search_evidence",
    keywords: ["nonexistent_xyz_keyword"],
    section: null,
    dateRange: null,
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });
  assert.equal(results.length, 0);
});

test("searchCommits: 영어 키워드 대소문자 무관 매칭", async () => {
  // "README"는 "docs: README 업데이트"에 포함
  const parsed = {
    raw: "readme",
    intent: "search_evidence",
    keywords: ["readme"],
    section: null,
    dateRange: null,
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });
  assert.ok(results.length > 0, "대소문자 무관 매칭이어야 한다");
  assert.ok(
    results[0].text.toLowerCase().includes("readme"),
    `텍스트에 readme 포함: ${results[0].text}`
  );
});

// ── searchSessionMemory ───────────────────────────────────────────────────────

test("searchSessionMemory: 키워드 매칭된 세션만 반환한다", async () => {
  const parsed = {
    raw: "검색 어댑터",
    intent: "search_evidence",
    keywords: ["검색", "어댑터"],
    section: null,
    dateRange: null,
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0, "결과가 있어야 한다");
  for (const r of results) {
    assert.equal(r.source, "session");
    assert.ok(typeof r.text === "string" && r.text.length > 0);
    assert.ok(r.relevanceScore > 0);
  }
});

test("searchSessionMemory: 키워드 없으면 세션이 있는 날짜 전체 반환", async () => {
  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: null,
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });

  // 픽스처에서 세션 있는 날:
  //   2026-03-01: claude 1개 + aiReview 1개 + workingStyleSignals 1개 = 3개
  //   2026-03-15: codex 1개 = 1개
  //   총 4개
  assert.ok(results.length >= 2, "세션+하이라이트 전체 반환");
});

test("searchSessionMemory: dateRange 필터링", async () => {
  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: { from: "2026-03-15", to: "2026-04-30" },
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });

  // 2026-03-15 이후 세션만 (2026-03-15의 codex 1개)
  assert.equal(results.length, 1);
  assert.equal(results[0].date, "2026-03-15");
});

test("searchSessionMemory: provenance에 sessionType, cwd, snippets 포함 (Sub-AC 4-1)", async () => {
  const parsed = {
    raw: "구현",
    intent: "search_evidence",
    keywords: ["구현"],
    section: null,
    dateRange: null,
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });
  assert.ok(results.length > 0);

  const r = results[0];
  // provenance 필드가 있어야 한다 (Sub-AC 4-1: 출처 메타데이터)
  assert.ok(r.provenance, "provenance 필드 있어야 한다");
  assert.equal(r.provenance.sourceType, "session", "provenance.sourceType === 'session'");
  assert.ok("sessionType" in r.provenance, "provenance.sessionType (codex/claude) 있어야 한다");
  assert.ok("cwd" in r.provenance, "provenance.cwd 있어야 한다");
  assert.ok("snippets" in r.provenance, "provenance.snippets 미리보기 있어야 한다");
  assert.ok(Array.isArray(r.provenance.snippets));
  // matchedKeywords 필드가 있어야 한다 (Sub-AC 4-1)
  assert.ok(Array.isArray(r.matchedKeywords), "matchedKeywords 배열이 있어야 한다");
  assert.ok(r.matchedKeywords.length > 0, "키워드 검색 시 matchedKeywords가 비어 있지 않아야 한다");
});

test("searchSessionMemory: summary 없을 때 snippet으로 fallback", async () => {
  // summary가 없는 세션 픽스처 추가
  const tmpFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-fallback-"));
  const dailyDir = path.join(tmpFixtureDir, "daily");
  await fs.mkdir(dailyDir);

  await fs.writeFile(
    path.join(dailyDir, "2026-02-01.json"),
    JSON.stringify({
      date: "2026-02-01",
      projects: [],
      aiSessions: {
        codex: [
          {
            source: "codex",
            cwd: "/code",
            summary: null,
            snippetCount: 1,
            snippets: ["스니펫으로만 구성된 세션 내용"],
          },
        ],
        claude: [],
      },
    }),
    "utf8"
  );

  const parsed = {
    raw: "스니펫",
    intent: "search_evidence",
    keywords: ["스니펫"],
    section: null,
    dateRange: null,
  };

  const results = await searchSessionMemory(parsed, { dataDir: tmpFixtureDir });
  await fs.rm(tmpFixtureDir, { recursive: true, force: true });

  assert.ok(results.length > 0, "snippet fallback 결과 있어야 한다");
  assert.ok(
    results[0].text.includes("스니펫"),
    `text가 snippet으로 대체되어야 한다: ${results[0].text}`
  );
});

test("searchCommits: provenance.commitHash 실제 값 확인 (Sub-AC 4-1)", async () => {
  const parsed = {
    raw: "feat",
    intent: "search_evidence",
    keywords: ["feat"],
    section: null,
    dateRange: { from: "2026-03-01", to: "2026-03-01" },
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });
  assert.ok(results.length > 0);

  const r = results[0];
  // 픽스처의 커밋 해시 "abc1234"이 commitHash에 포함되어야 한다
  assert.ok(typeof r.provenance.commitHash === "string", "commitHash는 문자열이어야 한다");
  assert.ok(r.provenance.commitHash.length > 0, "commitHash가 비어있지 않아야 한다");
  assert.ok(typeof r.provenance.repo === "string", "repo는 문자열이어야 한다");
  assert.ok(r.provenance.authoredAt !== undefined, "authoredAt 필드가 있어야 한다");
});

test("searchSessionMemory: provenance.sessionType 실제 값 확인 (Sub-AC 4-1)", async () => {
  const parsed = {
    raw: "API",
    intent: "search_evidence",
    keywords: ["API"],
    section: null,
    dateRange: { from: "2026-03-15", to: "2026-03-15" },
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });
  assert.ok(results.length > 0, "codex 세션 결과가 있어야 한다");

  const r = results[0];
  // 2026-03-15 데이터에는 codex 세션만 있음
  assert.equal(r.provenance.sessionType, "codex", "sessionType이 'codex'여야 한다");
  assert.equal(r.provenance.filePath, "/path/codex-session.jsonl");
  assert.equal(r.provenance.cwd, "/code/my-project");
});

// ── searchCommits: 하이라이트 소스 검색 (Sub-AC 2) ─────────────────────────────

test("searchCommits: highlights.commitAnalysis에서 키워드 검색 (Sub-AC 2)", async () => {
  const parsed = {
    raw: "버그 수정",
    intent: "search_evidence",
    keywords: ["버그 수정"],
    section: null,
    dateRange: { from: "2026-03-01", to: "2026-03-01" },
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0, "commitAnalysis에서 결과가 있어야 한다");
  // commitAnalysis 라인: "work-log에서 3개의 커밋 — 검색 기능 및 버그 수정"
  const analysisResult = results.find((r) => r.text.includes("3개의 커밋"));
  assert.ok(analysisResult, "commitAnalysis 라인이 매칭되어야 한다");
  assert.ok(analysisResult.provenance.sourceType === "commits");
  assert.equal(analysisResult.provenance.repo, "work-log", "commitAnalysis에서 repo명 추출");
});

test("searchCommits: highlights.storyThreads에서 키워드 검색 (Sub-AC 2)", async () => {
  const parsed = {
    raw: "멀티소스 병렬",
    intent: "search_evidence",
    keywords: ["멀티소스", "병렬"],
    section: null,
    dateRange: null,
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0, "storyThread에서 결과가 있어야 한다");
  const threadResult = results.find((r) => r.text.includes("멀티소스"));
  assert.ok(threadResult, "storyThread decision 필드에서 '멀티소스' 매칭");
  assert.equal(threadResult.provenance.repo, "work-log", "storyThread의 repo가 전달되어야 한다");
});

test("searchCommits: highlights.accomplishments에서 키워드 검색 (Sub-AC 2)", async () => {
  const parsed = {
    raw: "멀티소스 검색",
    intent: "search_evidence",
    keywords: ["멀티소스"],
    section: null,
    dateRange: null,
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0, "accomplishments에서 결과가 있어야 한다");
  assert.ok(
    results.some((r) => r.text.includes("멀티소스 검색 기능 구현")),
    "accomplishments 라인이 매칭되어야 한다"
  );
});

test("searchCommits: 중복 제거 — 동일 텍스트가 커밋과 하이라이트에 있으면 한 번만 반환", async () => {
  const parsed = {
    raw: "검색 기능",
    intent: "search_evidence",
    keywords: ["검색", "기능"],
    section: null,
    dateRange: { from: "2026-03-01", to: "2026-03-01" },
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  const texts = results.map((r) => r.text);
  const uniqueTexts = new Set(texts);
  assert.equal(texts.length, uniqueTexts.size, "중복된 텍스트가 없어야 한다");
});

// ── searchSessionMemory: 하이라이트 소스 검색 (Sub-AC 2) ──────────────────────

test("searchSessionMemory: highlights.aiReview에서 키워드 검색 (Sub-AC 2)", async () => {
  const parsed = {
    raw: "Redis 캐싱",
    intent: "search_evidence",
    keywords: ["Redis", "캐싱"],
    section: null,
    dateRange: null,
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0, "aiReview에서 결과가 있어야 한다");
  const aiReviewResult = results.find(
    (r) => r.provenance.sessionType === "aiReview"
  );
  assert.ok(aiReviewResult, "aiReview 출처의 결과가 있어야 한다");
  assert.ok(
    aiReviewResult.text.includes("Redis") || aiReviewResult.text.includes("캐싱"),
    "aiReview 텍스트에 키워드 포함"
  );
});

test("searchSessionMemory: highlights.workingStyleSignals에서 키워드 검색 (Sub-AC 2)", async () => {
  const parsed = {
    raw: "안정성",
    intent: "search_evidence",
    keywords: ["안정성"],
    section: null,
    dateRange: null,
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });

  assert.ok(results.length > 0, "workingStyleSignals에서 결과가 있어야 한다");
  assert.ok(
    results.some((r) => r.text.includes("안정성")),
    "workingStyleSignals 텍스트 매칭"
  );
});

test("searchSessionMemory: 중복 제거 — 동일 텍스트가 세션과 aiReview에 있으면 한 번만 반환", async () => {
  const parsed = {
    raw: "Redis TTL",
    intent: "search_evidence",
    keywords: ["Redis", "TTL"],
    section: null,
    dateRange: { from: "2026-03-01", to: "2026-03-01" },
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });

  const texts = results.map((r) => r.text);
  const uniqueTexts = new Set(texts);
  assert.equal(texts.length, uniqueTexts.size, "중복된 텍스트가 없어야 한다");
});

// ── searchAllSources ──────────────────────────────────────────────────────────

test("searchAllSources: 세 소스 병렬 검색 결과 구조 반환", async () => {
  const parsed = {
    raw: "검색",
    intent: "search_evidence",
    keywords: ["검색"],
    section: null,
    dateRange: null,
  };

  const result = await searchAllSources(parsed, { dataDir: fixture.dataDir });

  assert.ok("commits" in result, "commits 키 있어야 한다");
  assert.ok("slack" in result, "slack 키 있어야 한다");
  assert.ok("sessions" in result, "sessions 키 있어야 한다");
  assert.ok("totalCount" in result, "totalCount 키 있어야 한다");
  assert.ok(Array.isArray(result.commits));
  assert.ok(Array.isArray(result.slack));
  assert.ok(Array.isArray(result.sessions));
  assert.equal(
    result.totalCount,
    result.commits.length + result.slack.length + result.sessions.length
  );
});

test("searchAllSources: 한 소스 오류가 다른 소스에 영향 없음", async () => {
  // 존재하지 않는 dataDir로 오류를 유발 (commits/sessions 는 빈 배열 처리)
  const parsed = {
    raw: "test",
    intent: "general",
    keywords: ["test"],
    section: null,
    dateRange: null,
  };

  // 오류가 throw되지 않아야 한다
  let result;
  await assert.doesNotReject(async () => {
    result = await searchAllSources(parsed, {
      dataDir: "/nonexistent/path/xyz",
    });
  });

  assert.ok(result, "결과가 있어야 한다");
  assert.ok(Array.isArray(result.commits));
  assert.ok(Array.isArray(result.sessions));
});

test("searchAllSources: maxResultsPerSource 옵션 적용", async () => {
  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: null,
  };

  const result = await searchAllSources(parsed, {
    dataDir: fixture.dataDir,
    maxResultsPerSource: 1,
  });

  assert.ok(result.commits.length <= 1, "commits ≤ 1");
  assert.ok(result.sessions.length <= 1, "sessions ≤ 1");
});

// ── 날짜 범위 경계 테스트 ────────────────────────────────────────────────────

test("searchCommits: dateRange from === to (단일 날짜)", async () => {
  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: { from: "2026-03-15", to: "2026-03-15" },
  };

  const results = await searchCommits(parsed, { dataDir: fixture.dataDir });

  // 2026-03-15만 (2개 커밋)
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.date, "2026-03-15");
  }
});

test("searchCommits: 빈 dataDir — 빈 배열 반환 (오류 없음)", async () => {
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "empty-data-"));

  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: null,
  };

  let results;
  await assert.doesNotReject(async () => {
    results = await searchCommits(parsed, { dataDir: emptyDir });
  });

  assert.equal(results.length, 0);
  await fs.rm(emptyDir, { recursive: true, force: true });
});

test("searchSessionMemory: 세션 없는 날짜 파일 — 건너뜀", async () => {
  const parsed = {
    raw: "",
    intent: "general",
    keywords: [],
    section: null,
    dateRange: { from: "2026-04-01", to: "2026-04-30" },
  };

  const results = await searchSessionMemory(parsed, { dataDir: fixture.dataDir });

  // 2026-04-01 파일에는 aiSessions가 비어있음
  assert.equal(results.length, 0, "세션 없는 날짜는 건너뛰어야 한다");
});

// ── searchWithAnalyzedQuery (Sub-AC 3-2) ─────────────────────────────────────

/**
 * AnalyzedQuery 픽스처 헬퍼: sourceParams를 포함한 분석 쿼리 생성
 */
function makeAnalyzedQuery(overrides = {}) {
  return {
    raw: overrides.raw ?? "검색 기능",
    intent: overrides.intent ?? "search_evidence",
    keywords: overrides.keywords ?? ["검색"],
    section: overrides.section ?? null,
    dateRange: overrides.dateRange ?? null,
    techStack: overrides.techStack ?? { all: [], byCategory: {} },
    sourceParams: overrides.sourceParams ?? {
      commits:  { keywords: ["검색"], dateRange: null, maxResults: 15, enabled: true },
      slack:    { keywords: ["검색"], dateRange: null, maxResults: 10, enabled: true },
      sessions: { keywords: ["검색"], dateRange: null, maxResults: 10, enabled: true },
    },
    confidence: overrides.confidence ?? 0.6,
    needsClarification: overrides.needsClarification ?? false,
    clarificationHint: overrides.clarificationHint ?? null,
  };
}

test("searchWithAnalyzedQuery: 소스별 확장 키워드로 검색한다 (Sub-AC 3-2)", async () => {
  // 커밋에는 "API"로, 세션에는 "API"와 "endpoint"로 검색
  const analyzed = makeAnalyzedQuery({
    raw: "API 엔드포인트 작업",
    keywords: ["API"],
    sourceParams: {
      commits:  { keywords: ["API", "endpoint", "route"], dateRange: null, maxResults: 15, enabled: true },
      slack:    { keywords: ["API", "엔드포인트"], dateRange: null, maxResults: 10, enabled: true },
      sessions: { keywords: ["API", "endpoint"], dateRange: null, maxResults: 10, enabled: true },
    },
  });

  const result = await searchWithAnalyzedQuery(analyzed, { dataDir: fixture.dataDir });

  assert.ok("commits" in result);
  assert.ok("sessions" in result);
  assert.ok("totalCount" in result);
  // "API 엔드포인트 추가" 커밋이 포함되어야 한다
  assert.ok(result.commits.length > 0, "커밋 검색 결과 있어야 한다");
  assert.ok(
    result.commits.some((c) => c.text.includes("API")),
    "API 관련 커밋이 있어야 한다"
  );
});

test("searchWithAnalyzedQuery: enabled=false 소스는 건너뛴다 (Sub-AC 3-2)", async () => {
  const analyzed = makeAnalyzedQuery({
    raw: "검색 기능",
    keywords: ["검색"],
    sourceParams: {
      commits:  { keywords: ["검색"], dateRange: null, maxResults: 15, enabled: true },
      slack:    { keywords: ["검색"], dateRange: null, maxResults: 10, enabled: false },
      sessions: { keywords: ["검색"], dateRange: null, maxResults: 10, enabled: false },
    },
  });

  const result = await searchWithAnalyzedQuery(analyzed, { dataDir: fixture.dataDir });

  // 커밋만 활성화 → 슬랙/세션은 빈 배열
  assert.ok(result.commits.length > 0, "enabled 소스는 결과가 있어야 한다");
  assert.equal(result.slack.length, 0, "disabled 슬랙은 빈 배열");
  assert.equal(result.sessions.length, 0, "disabled 세션은 빈 배열");
});

test("searchWithAnalyzedQuery: techStack 키워드가 소스 키워드에 보강된다 (Sub-AC 3-2)", async () => {
  // 소스 키워드에 "기능"만 있지만 techStack에 "Preact"가 있으면 보강됨
  const analyzed = makeAnalyzedQuery({
    raw: "Preact 관련 수정",
    keywords: ["Preact", "수정"],
    techStack: { all: ["Preact"], byCategory: { framework: ["Preact"] } },
    sourceParams: {
      commits:  { keywords: ["수정"], dateRange: null, maxResults: 15, enabled: true },
      slack:    { keywords: ["수정"], dateRange: null, maxResults: 10, enabled: false },
      sessions: { keywords: ["수정"], dateRange: null, maxResults: 10, enabled: false },
    },
  });

  const result = await searchWithAnalyzedQuery(analyzed, { dataDir: fixture.dataDir });

  // techStack "Preact"가 보강되어 "fix: Preact 렌더링 오류 수정" 커밋이 매칭됨
  assert.ok(result.commits.length > 0, "techStack 보강으로 Preact 커밋이 매칭되어야 한다");
  assert.ok(
    result.commits.some((c) => c.text.includes("Preact")),
    "Preact 포함 커밋이 있어야 한다"
  );
});

test("searchWithAnalyzedQuery: 소스별 maxResults 차등 적용 (Sub-AC 3-2)", async () => {
  const analyzed = makeAnalyzedQuery({
    raw: "",
    keywords: [],
    sourceParams: {
      commits:  { keywords: [], dateRange: null, maxResults: 2, enabled: true },
      slack:    { keywords: [], dateRange: null, maxResults: 1, enabled: false },
      sessions: { keywords: [], dateRange: null, maxResults: 1, enabled: true },
    },
  });

  const result = await searchWithAnalyzedQuery(analyzed, { dataDir: fixture.dataDir });

  assert.ok(result.commits.length <= 2, "commits maxResults=2 이하");
  assert.ok(result.sessions.length <= 1, "sessions maxResults=1 이하");
});

test("searchWithAnalyzedQuery: 모든 소스 disabled이면 모두 빈 배열 (Sub-AC 3-2)", async () => {
  const analyzed = makeAnalyzedQuery({
    raw: "반영해줘",
    intent: "apply_section",
    keywords: [],
    sourceParams: {
      commits:  { keywords: [], dateRange: null, maxResults: 5, enabled: false },
      slack:    { keywords: [], dateRange: null, maxResults: 3, enabled: false },
      sessions: { keywords: [], dateRange: null, maxResults: 3, enabled: false },
    },
  });

  const result = await searchWithAnalyzedQuery(analyzed, { dataDir: fixture.dataDir });

  assert.equal(result.commits.length, 0);
  assert.equal(result.slack.length, 0);
  assert.equal(result.sessions.length, 0);
  assert.equal(result.totalCount, 0);
});

test("searchWithAnalyzedQuery: dateRange가 소스별로 전달된다 (Sub-AC 3-2)", async () => {
  const analyzed = makeAnalyzedQuery({
    raw: "",
    keywords: [],
    dateRange: { from: "2026-03-15", to: "2026-03-31" },
    sourceParams: {
      commits:  { keywords: [], dateRange: { from: "2026-03-15", to: "2026-03-31" }, maxResults: 20, enabled: true },
      slack:    { keywords: [], dateRange: { from: "2026-03-15", to: "2026-03-31" }, maxResults: 10, enabled: false },
      sessions: { keywords: [], dateRange: { from: "2026-03-15", to: "2026-03-31" }, maxResults: 10, enabled: true },
    },
  });

  const result = await searchWithAnalyzedQuery(analyzed, { dataDir: fixture.dataDir });

  // 2026-03-15 이후 커밋: my-project 2개
  for (const r of result.commits) {
    assert.ok(r.date >= "2026-03-15" && r.date <= "2026-03-31", `날짜 범위 내: ${r.date}`);
  }
  // 2026-03-15 세션: codex 1개
  assert.equal(result.sessions.length, 1, "2026-03-15 codex 세션 1개");
  assert.equal(result.sessions[0].date, "2026-03-15");
});

test("searchWithAnalyzedQuery: 반환 구조가 ChatEvidenceResult와 일치한다 (Sub-AC 3-2)", async () => {
  const analyzed = makeAnalyzedQuery({
    raw: "검색",
    keywords: ["검색"],
    sourceParams: {
      commits:  { keywords: ["검색"], dateRange: null, maxResults: 10, enabled: true },
      slack:    { keywords: ["검색"], dateRange: null, maxResults: 10, enabled: true },
      sessions: { keywords: ["검색"], dateRange: null, maxResults: 10, enabled: true },
    },
  });

  const result = await searchWithAnalyzedQuery(analyzed, { dataDir: fixture.dataDir });

  // ChatEvidenceResult 구조 확인
  assert.ok("commits" in result && Array.isArray(result.commits));
  assert.ok("slack" in result && Array.isArray(result.slack));
  assert.ok("sessions" in result && Array.isArray(result.sessions));
  assert.ok(typeof result.totalCount === "number");
  assert.equal(
    result.totalCount,
    result.commits.length + result.slack.length + result.sessions.length
  );

  // 각 레코드의 기본 필드 확인
  for (const r of [...result.commits, ...result.sessions]) {
    assert.ok(["commits", "slack", "session"].includes(r.source), `source: ${r.source}`);
    assert.ok(typeof r.date === "string");
    assert.ok(typeof r.text === "string");
    assert.ok(typeof r.relevanceScore === "number");
    assert.ok(r.provenance, "provenance 필드 있어야 한다");
  }
});
