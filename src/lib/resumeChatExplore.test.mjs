/**
 * resumeChatExplore.test.mjs
 *
 * 쿼리 분석 기반 데이터 소스 탐색 로직 테스트.
 *
 * 커버리지:
 *   - exploreWithQueryAnalysis: AnalyzedQuery 형식 (enabled 플래그)
 *   - exploreWithQueryAnalysis: QueryAnalysisResult 형식 (priority 필드)
 *   - exploreWithQueryAnalysis: priority별 maxResults 조정
 *   - exploreWithQueryAnalysis: low priority + 낮은 confidence 건너뜀
 *   - exploreWithQueryAnalysis: 보충 질문 생성
 *   - exploreWithKeywords: 단순 키워드 검색
 *   - exploreSingleSource: 단일 소스 검색
 *   - 소스별 독립 실패 처리
 *   - 결과 구조 (sourceMeta 포함)
 *
 * Run:
 *   node --test src/lib/resumeChatExplore.test.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

import {
  exploreWithQueryAnalysis,
  exploreWithKeywords,
  exploreSingleSource,
} from "./resumeChatExplore.mjs";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * 임시 데이터 디렉터리와 daily JSON 픽스처를 생성한다.
 */
async function createFixtureDataDir() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "explore-test-"));
  const dailyDir = path.join(tmpDir, "daily");
  await fs.mkdir(dailyDir, { recursive: true });

  const fixtures = [
    {
      date: "2026-03-01",
      data: {
        date: "2026-03-01",
        counts: { codexSessions: 0, claudeSessions: 1, slackContexts: 0, gitCommits: 3 },
        highlights: {},
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
                subject: "feat: Redis 캐싱 레이어 추가",
              },
              {
                repo: "work-log",
                repoPath: "/code/work-log",
                hash: "abc1235",
                authoredAt: "2026-03-01T11:00:00+09:00",
                subject: "fix: cache TTL 계산 오류 수정",
              },
              {
                repo: "work-log",
                repoPath: "/code/work-log",
                hash: "abc1236",
                authoredAt: "2026-03-01T12:00:00+09:00",
                subject: "docs: API 문서 업데이트",
              },
            ],
          },
        ],
        aiSessions: {
          codex: [],
          claude: [
            {
              source: "claude",
              filePath: "/path/session-1.jsonl",
              cwd: "/code/work-log",
              summary: "Redis 캐싱 전략 검토 및 구현 방향 결정",
              snippetCount: 2,
              snippets: [
                "캐시 키 네임스페이스 설계로 충돌 방지",
                "TTL 5분 설정으로 데이터 신선도 유지",
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
                subject: "feat: API endpoint 추가",
              },
              {
                repo: "my-project",
                repoPath: "/code/my-project",
                hash: "def5679",
                authoredAt: "2026-03-15T10:00:00+09:00",
                subject: "refactor: 성능 최적화",
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
              summary: "API 엔드포인트 설계 및 구현. 성능 테스트 수행.",
              snippetCount: 1,
              snippets: ["REST API 엔드포인트를 추가하고 부하 테스트를 작성했다."],
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

// ─── Setup / teardown ────────────────────────────────────────────────────────

let fixture;

before(async () => {
  fixture = await createFixtureDataDir();
});

after(async () => {
  if (fixture) await fixture.cleanup();
});

// ─── Helper: AnalyzedQuery 형식 (enabled 필드) ──────────────────────────────

function makeAnalyzedQuery(overrides = {}) {
  return {
    raw: overrides.raw ?? "Redis 캐싱",
    intent: overrides.intent ?? "search_evidence",
    keywords: overrides.keywords ?? ["Redis", "캐싱"],
    section: overrides.section ?? null,
    dateRange: overrides.dateRange ?? null,
    techStack: overrides.techStack ?? { all: [], byCategory: {} },
    sourceParams: overrides.sourceParams ?? {
      commits:  { keywords: ["Redis", "cache", "캐싱"], dateRange: null, maxResults: 15, enabled: true },
      slack:    { keywords: ["Redis", "캐싱", "캐시"], dateRange: null, maxResults: 10, enabled: true },
      sessions: { keywords: ["Redis", "캐싱"], dateRange: null, maxResults: 10, enabled: true },
    },
    confidence: overrides.confidence ?? 0.6,
    needsClarification: overrides.needsClarification ?? false,
    clarificationHint: overrides.clarificationHint ?? null,
  };
}

// ─── Helper: QueryAnalysisResult 형식 (priority 필드) ────────────────────────

function makeQueryAnalysisResult(overrides = {}) {
  return {
    raw: overrides.raw ?? "Redis 캐싱 관련 작업 찾아줘",
    intent: overrides.intent ?? "search_evidence",
    section: overrides.section ?? null,
    confidence: overrides.confidence ?? 0.7,
    reasoning: overrides.reasoning ?? "규칙 기반",
    method: overrides.method ?? "rules",
    sourceParams: overrides.sourceParams ?? {
      commits:  { keywords: ["Redis", "cache", "caching"], dateRange: null, maxResults: 20, priority: "high" },
      slack:    { keywords: ["Redis", "캐싱", "캐시"], dateRange: null, maxResults: 20, priority: "medium" },
      sessions: { keywords: ["Redis", "캐싱"], dateRange: null, maxResults: 20, priority: "low" },
    },
    followUpQuestion: overrides.followUpQuestion ?? null,
  };
}

// ─── exploreWithQueryAnalysis: AnalyzedQuery (enabled) ───────────────────────

test("exploreWithQueryAnalysis: AnalyzedQuery — enabled 소스만 검색한다", async () => {
  const analyzed = makeAnalyzedQuery({
    sourceParams: {
      commits:  { keywords: ["Redis", "cache"], dateRange: null, maxResults: 15, enabled: true },
      slack:    { keywords: ["Redis"], dateRange: null, maxResults: 10, enabled: false },
      sessions: { keywords: ["Redis"], dateRange: null, maxResults: 10, enabled: false },
    },
  });

  const result = await exploreWithQueryAnalysis(analyzed, { dataDir: fixture.dataDir });

  assert.ok(result.commits.length > 0, "enabled 커밋 소스에서 결과 있어야 한다");
  assert.equal(result.slack.length, 0, "disabled 슬랙은 빈 배열");
  assert.equal(result.sessions.length, 0, "disabled 세션은 빈 배열");
  assert.ok(result.sourceMeta.commits.searched, "커밋 searched === true");
  assert.ok(!result.sourceMeta.slack.searched, "슬랙 searched === false");
  assert.ok(!result.sourceMeta.sessions.searched, "세션 searched === false");
});

test("exploreWithQueryAnalysis: AnalyzedQuery — 모든 소스 enabled시 병렬 검색", async () => {
  const analyzed = makeAnalyzedQuery();

  const result = await exploreWithQueryAnalysis(analyzed, { dataDir: fixture.dataDir });

  assert.ok("commits" in result && Array.isArray(result.commits));
  assert.ok("slack" in result && Array.isArray(result.slack));
  assert.ok("sessions" in result && Array.isArray(result.sessions));
  assert.ok(typeof result.totalCount === "number");
  assert.equal(
    result.totalCount,
    result.commits.length + result.slack.length + result.sessions.length
  );
});

test("exploreWithQueryAnalysis: AnalyzedQuery — 소스별 키워드 다르게 적용", async () => {
  const analyzed = makeAnalyzedQuery({
    sourceParams: {
      commits:  { keywords: ["Redis", "cache"], dateRange: null, maxResults: 15, enabled: true },
      slack:    { keywords: ["Redis"], dateRange: null, maxResults: 10, enabled: false },
      sessions: { keywords: ["캐싱", "전략"], dateRange: null, maxResults: 10, enabled: true },
    },
  });

  const result = await exploreWithQueryAnalysis(analyzed, { dataDir: fixture.dataDir });

  // 커밋: "Redis"+"cache" 키워드로 검색 → "Redis 캐싱 레이어 추가", "cache TTL" 매칭
  assert.ok(result.commits.length > 0, "커밋 결과 있어야 한다");
  // 세션: "캐싱"+"전략" 키워드로 검색 → "Redis 캐싱 전략 검토" 매칭
  assert.ok(result.sessions.length > 0, "세션 결과 있어야 한다");

  // sourceMeta에 사용된 키워드가 정확히 기록되어야 한다
  assert.deepEqual(result.sourceMeta.commits.keywords, ["Redis", "cache"]);
  assert.deepEqual(result.sourceMeta.sessions.keywords, ["캐싱", "전략"]);
});

// ─── exploreWithQueryAnalysis: QueryAnalysisResult (priority) ────────────────

test("exploreWithQueryAnalysis: QueryAnalysisResult — priority별 maxResults 조정", async () => {
  const analysis = makeQueryAnalysisResult({
    sourceParams: {
      commits:  { keywords: ["feat"], dateRange: null, maxResults: 20, priority: "high" },
      slack:    { keywords: ["feat"], dateRange: null, maxResults: 20, priority: "medium" },
      sessions: { keywords: ["feat"], dateRange: null, maxResults: 20, priority: "low" },
    },
  });

  const result = await exploreWithQueryAnalysis(analysis, { dataDir: fixture.dataDir });

  // 모든 소스가 검색되어야 한다 (confidence 0.7 > 0.3이므로 low도 검색)
  assert.ok(result.sourceMeta.commits.searched, "high priority 검색됨");
  assert.ok(result.sourceMeta.slack.searched, "medium priority 검색됨");
  assert.ok(result.sourceMeta.sessions.searched, "low priority 검색됨 (confidence >= 0.3)");
});

test("exploreWithQueryAnalysis: QueryAnalysisResult — low priority + 낮은 confidence 건너뜀", async () => {
  const analysis = makeQueryAnalysisResult({
    confidence: 0.2,  // LOW_PRIORITY_SKIP_THRESHOLD (0.3) 미만
    sourceParams: {
      commits:  { keywords: ["Redis"], dateRange: null, maxResults: 20, priority: "high" },
      slack:    { keywords: ["Redis"], dateRange: null, maxResults: 20, priority: "medium" },
      sessions: { keywords: ["Redis"], dateRange: null, maxResults: 20, priority: "low" },
    },
  });

  const result = await exploreWithQueryAnalysis(analysis, { dataDir: fixture.dataDir });

  assert.ok(result.sourceMeta.commits.searched, "high priority는 검색");
  assert.ok(result.sourceMeta.slack.searched, "medium priority는 검색");
  assert.ok(!result.sourceMeta.sessions.searched, "low + confidence < 0.3은 건너뜀");
  assert.ok(
    result.sourceMeta.sessions.skipReason?.includes("low priority"),
    "skipReason에 low priority 언급"
  );
});

test("exploreWithQueryAnalysis: QueryAnalysisResult — 결과에 sourceMeta 포함", async () => {
  const analysis = makeQueryAnalysisResult();

  const result = await exploreWithQueryAnalysis(analysis, { dataDir: fixture.dataDir });

  assert.ok("sourceMeta" in result, "sourceMeta 필드 있어야 한다");
  for (const source of ["commits", "slack", "sessions"]) {
    const meta = result.sourceMeta[source];
    assert.ok("searched" in meta, `${source}.searched 있어야 한다`);
    assert.ok("resultCount" in meta, `${source}.resultCount 있어야 한다`);
    assert.ok("keywords" in meta, `${source}.keywords 있어야 한다`);
    assert.ok(typeof meta.searched === "boolean");
    assert.ok(typeof meta.resultCount === "number");
    assert.ok(Array.isArray(meta.keywords));
  }
});

// ─── 보충 질문 생성 ──────────────────────────────────────────────────────────

test("exploreWithQueryAnalysis: 결과 0건 + 키워드 있을 때 보충 질문 생성", async () => {
  const analysis = makeAnalyzedQuery({
    raw: "존재하지않는키워드xyz123",
    keywords: ["존재하지않는키워드xyz123"],
    sourceParams: {
      commits:  { keywords: ["존재하지않는키워드xyz123"], dateRange: null, maxResults: 10, enabled: true },
      slack:    { keywords: ["존재하지않는키워드xyz123"], dateRange: null, maxResults: 10, enabled: false },
      sessions: { keywords: ["존재하지않는키워드xyz123"], dateRange: null, maxResults: 10, enabled: true },
    },
  });

  const result = await exploreWithQueryAnalysis(analysis, { dataDir: fixture.dataDir });

  assert.equal(result.totalCount, 0);
  assert.ok(result.followUpQuestion, "결과 없을 때 followUpQuestion 있어야 한다");
  assert.ok(typeof result.followUpQuestion === "string");
});

test("exploreWithQueryAnalysis: analysis의 followUpQuestion을 전달한다", async () => {
  const analysis = makeQueryAnalysisResult({
    confidence: 0.2,
    followUpQuestion: "어떤 프로젝트인지 알려주세요.",
    sourceParams: {
      commits:  { keywords: [], dateRange: null, maxResults: 10, priority: "low" },
      slack:    { keywords: [], dateRange: null, maxResults: 10, priority: "low" },
      sessions: { keywords: [], dateRange: null, maxResults: 10, priority: "low" },
    },
  });

  const result = await exploreWithQueryAnalysis(analysis, { dataDir: fixture.dataDir });

  assert.equal(result.followUpQuestion, "어떤 프로젝트인지 알려주세요.");
});

test("exploreWithQueryAnalysis: clarificationHint도 followUpQuestion으로 전달", async () => {
  const analysis = makeAnalyzedQuery({
    clarificationHint: "날짜를 지정해 주세요.",
    sourceParams: {
      commits:  { keywords: [], dateRange: null, maxResults: 10, enabled: false },
      slack:    { keywords: [], dateRange: null, maxResults: 10, enabled: false },
      sessions: { keywords: [], dateRange: null, maxResults: 10, enabled: false },
    },
  });

  const result = await exploreWithQueryAnalysis(analysis, { dataDir: fixture.dataDir });

  assert.equal(result.followUpQuestion, "날짜를 지정해 주세요.");
});

// ─── 빈 입력 / null 처리 ────────────────────────────────────────────────────

test("exploreWithQueryAnalysis: null analysis → 빈 결과", async () => {
  const result = await exploreWithQueryAnalysis(null, { dataDir: fixture.dataDir });

  assert.equal(result.totalCount, 0);
  assert.ok(result.followUpQuestion, "빈 분석 시 followUpQuestion 있어야 한다");
});

test("exploreWithQueryAnalysis: sourceParams 없는 analysis → 빈 결과", async () => {
  const result = await exploreWithQueryAnalysis(
    { raw: "test", intent: "general" },
    { dataDir: fixture.dataDir }
  );

  assert.equal(result.totalCount, 0);
});

test("exploreWithQueryAnalysis: 모든 소스 disabled → 빈 결과", async () => {
  const analyzed = makeAnalyzedQuery({
    sourceParams: {
      commits:  { keywords: ["Redis"], dateRange: null, maxResults: 10, enabled: false },
      slack:    { keywords: ["Redis"], dateRange: null, maxResults: 10, enabled: false },
      sessions: { keywords: ["Redis"], dateRange: null, maxResults: 10, enabled: false },
    },
  });

  const result = await exploreWithQueryAnalysis(analyzed, { dataDir: fixture.dataDir });

  assert.equal(result.totalCount, 0);
  assert.equal(result.commits.length, 0);
  assert.equal(result.slack.length, 0);
  assert.equal(result.sessions.length, 0);
});

// ─── dateRange 필터링 ────────────────────────────────────────────────────────

test("exploreWithQueryAnalysis: dateRange가 소스별로 전달된다", async () => {
  const analyzed = makeAnalyzedQuery({
    dateRange: { from: "2026-03-15", to: "2026-03-31" },
    sourceParams: {
      commits:  { keywords: ["feat"], dateRange: { from: "2026-03-15", to: "2026-03-31" }, maxResults: 20, enabled: true },
      slack:    { keywords: ["feat"], dateRange: { from: "2026-03-15", to: "2026-03-31" }, maxResults: 10, enabled: false },
      sessions: { keywords: ["설계"], dateRange: { from: "2026-03-15", to: "2026-03-31" }, maxResults: 10, enabled: true },
    },
  });

  const result = await exploreWithQueryAnalysis(analyzed, { dataDir: fixture.dataDir });

  // 2026-03-15 범위 내 커밋만 반환
  for (const c of result.commits) {
    assert.ok(c.date >= "2026-03-15" && c.date <= "2026-03-31", `커밋 날짜 범위 내: ${c.date}`);
  }
});

// ─── exploreWithKeywords ─────────────────────────────────────────────────────

test("exploreWithKeywords: 단순 키워드 검색", async () => {
  const result = await exploreWithKeywords(
    { keywords: ["Redis", "cache"] },
    { dataDir: fixture.dataDir }
  );

  assert.ok(result.commits.length > 0, "커밋 결과 있어야 한다");
  assert.ok(result.totalCount > 0);
  assert.ok(result.sourceMeta.commits.searched);
  assert.ok(result.sourceMeta.sessions.searched);
});

test("exploreWithKeywords: 빈 키워드 → 보충 질문", async () => {
  const result = await exploreWithKeywords(
    { keywords: [] },
    { dataDir: fixture.dataDir }
  );

  assert.equal(result.totalCount, 0);
  assert.ok(result.followUpQuestion, "키워드 없으면 보충 질문");
});

test("exploreWithKeywords: dateRange 적용", async () => {
  const result = await exploreWithKeywords(
    {
      keywords: ["feat"],
      dateRange: { from: "2026-04-01", to: "2026-04-30" },
    },
    { dataDir: fixture.dataDir }
  );

  for (const c of result.commits) {
    assert.ok(c.date >= "2026-04-01", `날짜 범위 내: ${c.date}`);
  }
});

test("exploreWithKeywords: maxResults 제한", async () => {
  const result = await exploreWithKeywords(
    { keywords: ["feat"], maxResults: 1 },
    { dataDir: fixture.dataDir }
  );

  assert.ok(result.commits.length <= 1, "maxResults=1 제한");
});

// ─── exploreSingleSource ─────────────────────────────────────────────────────

test("exploreSingleSource: 커밋 소스만 검색", async () => {
  const results = await exploreSingleSource(
    "commits",
    { keywords: ["Redis"] },
    { dataDir: fixture.dataDir }
  );

  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0, "커밋 결과 있어야 한다");
  for (const r of results) {
    assert.equal(r.source, "commits");
  }
});

test("exploreSingleSource: 세션 소스만 검색", async () => {
  const results = await exploreSingleSource(
    "sessions",
    { keywords: ["캐싱"] },
    { dataDir: fixture.dataDir }
  );

  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0, "세션 결과 있어야 한다");
  for (const r of results) {
    assert.equal(r.source, "session");
  }
});

test("exploreSingleSource: 빈 키워드 → 빈 배열", async () => {
  const results = await exploreSingleSource(
    "commits",
    { keywords: [] },
    { dataDir: fixture.dataDir }
  );

  assert.deepEqual(results, []);
});

test("exploreSingleSource: 알 수 없는 소스 → 빈 배열", async () => {
  const results = await exploreSingleSource(
    "unknown_source",
    { keywords: ["Redis"] },
    { dataDir: fixture.dataDir }
  );

  assert.deepEqual(results, []);
});

// ─── 결과 구조 검증 ──────────────────────────────────────────────────────────

test("exploreWithQueryAnalysis: 반환 구조가 ExploreResult와 일치한다", async () => {
  const analyzed = makeAnalyzedQuery();
  const result = await exploreWithQueryAnalysis(analyzed, { dataDir: fixture.dataDir });

  // 최상위 필드 확인
  assert.ok("commits" in result && Array.isArray(result.commits));
  assert.ok("slack" in result && Array.isArray(result.slack));
  assert.ok("sessions" in result && Array.isArray(result.sessions));
  assert.ok(typeof result.totalCount === "number");
  assert.ok("sourceMeta" in result);
  assert.ok("followUpQuestion" in result);

  // totalCount 일관성
  assert.equal(
    result.totalCount,
    result.commits.length + result.slack.length + result.sessions.length
  );

  // 각 레코드의 기본 필드 확인
  for (const r of [...result.commits, ...result.sessions]) {
    assert.ok(["commits", "slack", "session"].includes(r.source), `유효한 source: ${r.source}`);
    assert.ok(typeof r.date === "string", "date는 문자열");
    assert.ok(typeof r.text === "string", "text는 문자열");
    assert.ok(typeof r.relevanceScore === "number", "relevanceScore는 숫자");
    assert.ok(r.provenance, "provenance 필드 있어야 한다");
  }
});

test("exploreWithQueryAnalysis: sourceMeta에 priority 정보 포함 (priority 모드)", async () => {
  const analysis = makeQueryAnalysisResult();
  const result = await exploreWithQueryAnalysis(analysis, { dataDir: fixture.dataDir });

  assert.equal(result.sourceMeta.commits.priority, "high");
  assert.equal(result.sourceMeta.slack.priority, "medium");
  assert.equal(result.sourceMeta.sessions.priority, "low");
});

// ─── 소스별 독립 실패 처리 ───────────────────────────────────────────────────

test("exploreWithQueryAnalysis: 존재하지 않는 dataDir에도 오류 없이 빈 결과", async () => {
  const analyzed = makeAnalyzedQuery();

  let result;
  await assert.doesNotReject(async () => {
    result = await exploreWithQueryAnalysis(analyzed, {
      dataDir: "/nonexistent/path/xyz",
    });
  });

  assert.ok(result, "결과가 있어야 한다");
  assert.equal(result.commits.length, 0);
  assert.equal(result.sessions.length, 0);
});
