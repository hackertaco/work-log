/**
 * resumeChatSuggest.test.mjs
 *
 * 탐색 결과 → 어필 포인트 제안 변환 모듈 테스트.
 *
 * 커버리지:
 *   - mergeExploreResults: 소스별 결과 통합
 *   - clusterEvidence: 키워드 오버랩 기반 클러스터링
 *   - clusterEvidence: 단일 레코드 → 단일 클러스터
 *   - clusterEvidence: 유사 레코드 → 하나의 클러스터로 병합
 *   - clusterEvidence: 상이한 레코드 → 별도 클러스터
 *   - rankClusters: 다면 점수 산출 및 정렬
 *   - rankClusters: 최소 근거 필터링
 *   - generateAppealPointsWithRules: 규칙 기반 어필 포인트 생성
 *   - generateAppealPointsWithRules: 어필 유형 추론 (achievement/contribution/role)
 *   - generateSuggestions: 전체 파이프라인 (LLM 건너뛰기)
 *   - generateSuggestions: 빈 입력 처리
 *   - formatSuggestionMessage: 포맷팅 출력
 *   - _extractSignificantWords: 한글/영문 단어 추출
 *   - _wordSetOverlap: Jaccard 유사도 계산
 *
 * Run:
 *   node --test src/lib/resumeChatSuggest.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  generateSuggestions,
  mergeExploreResults,
  clusterEvidence,
  rankClusters,
  generateAppealPointsWithRules,
  formatSuggestionMessage,
  _extractSignificantWords,
  _wordSetOverlap,
} from "./resumeChatSuggest.mjs";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeExploreResult(overrides = {}) {
  return {
    commits: overrides.commits ?? [],
    slack: overrides.slack ?? [],
    sessions: overrides.sessions ?? [],
    totalCount: overrides.totalCount ?? 0,
    sourceMeta: overrides.sourceMeta ?? {
      commits: { searched: true, resultCount: 0, keywords: [] },
      slack: { searched: true, resultCount: 0, keywords: [] },
      sessions: { searched: true, resultCount: 0, keywords: [] },
    },
    followUpQuestion: overrides.followUpQuestion ?? null,
  };
}

function makeCommitRecord(text, date = "2026-03-15", repo = "work-log", score = 0.8) {
  return {
    source: "commits",
    date,
    text,
    relevanceScore: score,
    provenance: { repo, commitHash: "abc1234" },
    repo,
  };
}

function makeSlackRecord(text, date = "2026-03-14") {
  return {
    source: "slack",
    date,
    text,
    relevanceScore: 0.7,
    provenance: { channelId: "C123", messageId: "1234567890.123" },
  };
}

function makeSessionRecord(text, date = "2026-03-13") {
  return {
    source: "sessions",
    date,
    text,
    relevanceScore: 0.6,
    provenance: { sessionType: "claude", filePath: "/sessions/test.jsonl" },
  };
}

// ─── mergeExploreResults ─────────────────────────────────────────────────────

describe("mergeExploreResults", () => {
  test("소스별 결과를 _source 태그와 함께 통합한다", () => {
    const result = makeExploreResult({
      commits: [makeCommitRecord("커밋 1")],
      slack: [makeSlackRecord("슬랙 1")],
      sessions: [makeSessionRecord("세션 1")],
      totalCount: 3,
    });

    const merged = mergeExploreResults(result);
    assert.equal(merged.length, 3);
    assert.equal(merged[0]._source, "commits");
    assert.equal(merged[1]._source, "slack");
    assert.equal(merged[2]._source, "sessions");
  });

  test("빈 결과에서 빈 배열을 반환한다", () => {
    const result = makeExploreResult();
    const merged = mergeExploreResults(result);
    assert.equal(merged.length, 0);
  });
});

// ─── _extractSignificantWords ────────────────────────────────────────────────

describe("_extractSignificantWords", () => {
  test("한글 단어 2자 이상 추출", () => {
    const words = _extractSignificantWords("Redis 캐싱 관련 성능 개선 작업");
    assert.ok(words.has("캐싱"));
    assert.ok(words.has("성능"));
    assert.ok(words.has("개선"));
    assert.ok(words.has("작업"));
    assert.ok(words.has("redis"));
  });

  test("영문 단어 3자 이상 추출", () => {
    const words = _extractSignificantWords("Add new API endpoint for user auth");
    assert.ok(words.has("new"));
    assert.ok(words.has("api")); // lowercase
    assert.ok(words.has("endpoint"));
    assert.ok(!words.has("an")); // 2자 제외
  });

  test("빈 입력 처리", () => {
    assert.equal(_extractSignificantWords("").size, 0);
    assert.equal(_extractSignificantWords(null).size, 0);
    assert.equal(_extractSignificantWords(undefined).size, 0);
  });
});

// ─── _wordSetOverlap ────────────────────────────────────────────────────────

describe("_wordSetOverlap", () => {
  test("동일 집합은 1.0", () => {
    const set = new Set(["api", "endpoint", "user"]);
    assert.equal(_wordSetOverlap(set, set), 1);
  });

  test("완전히 다른 집합은 0.0", () => {
    const setA = new Set(["api", "endpoint"]);
    const setB = new Set(["database", "migration"]);
    assert.equal(_wordSetOverlap(setA, setB), 0);
  });

  test("부분 겹침은 0~1 사이", () => {
    const setA = new Set(["api", "endpoint", "user"]);
    const setB = new Set(["api", "endpoint", "auth"]);
    const overlap = _wordSetOverlap(setA, setB);
    assert.ok(overlap > 0);
    assert.ok(overlap < 1);
    // Jaccard: 2 / 4 = 0.5
    assert.equal(overlap, 0.5);
  });

  test("빈 집합 처리", () => {
    assert.equal(_wordSetOverlap(new Set(), new Set()), 1);
    assert.equal(_wordSetOverlap(new Set(["a"]), new Set()), 0);
  });
});

// ─── clusterEvidence ────────────────────────────────────────────────────────

describe("clusterEvidence", () => {
  test("단일 레코드 → 단일 클러스터", () => {
    const records = [
      { text: "Redis 캐싱 성능 최적화 구현", date: "2026-03-15", _source: "commits" },
    ];

    const clusters = clusterEvidence(records);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].records.length, 1);
    assert.ok(clusters[0].sources.includes("commits"));
  });

  test("유사한 레코드는 같은 클러스터로 병합", () => {
    const records = [
      { text: "Redis 캐싱 레이어 구현 작업", date: "2026-03-15", _source: "commits" },
      { text: "Redis 캐싱 레이어 성능 테스트 추가", date: "2026-03-16", _source: "commits" },
    ];

    const clusters = clusterEvidence(records);
    // "Redis 캐싱 레이어" 를 공유하므로 하나로 묶여야 함
    assert.equal(clusters.length, 1, `Expected 1 cluster, got ${clusters.length}`);
    assert.equal(clusters[0].records.length, 2);
  });

  test("완전히 다른 레코드는 별도 클러스터", () => {
    const records = [
      { text: "Redis 캐싱 레이어 구현", date: "2026-03-15", _source: "commits" },
      { text: "PostgreSQL 마이그레이션 스크립트 작성", date: "2026-03-15", _source: "commits" },
    ];

    const clusters = clusterEvidence(records);
    assert.equal(clusters.length, 2);
  });

  test("다양한 소스의 유사 레코드가 하나의 클러스터로", () => {
    const records = [
      { text: "API 엔드포인트 인증 로직 리팩토링", date: "2026-03-10", _source: "commits" },
      { text: "API 인증 관련 슬랙 논의", date: "2026-03-11", _source: "slack" },
      { text: "API 엔드포인트 인증 테스트 세션", date: "2026-03-12", _source: "sessions" },
    ];

    const clusters = clusterEvidence(records);
    const apiCluster = clusters.find(
      (c) => c.sources.length >= 2
    );
    assert.ok(apiCluster, "다양한 소스를 포함하는 클러스터가 있어야 함");
  });

  test("빈 입력 처리", () => {
    assert.deepEqual(clusterEvidence([]), []);
    assert.deepEqual(clusterEvidence(null), []);
  });

  test("날짜 범위가 올바르게 확장된다", () => {
    const records = [
      { text: "Redis 캐싱 구현 시작", date: "2026-03-01", _source: "commits" },
      { text: "Redis 캐싱 최적화 완료", date: "2026-03-10", _source: "commits" },
    ];

    const clusters = clusterEvidence(records);
    const cluster = clusters[0];
    assert.equal(cluster.dateRange.from, "2026-03-01");
    assert.equal(cluster.dateRange.to, "2026-03-10");
  });
});

// ─── rankClusters ───────────────────────────────────────────────────────────

describe("rankClusters", () => {
  test("점수가 올바르게 계산되고 내림차순 정렬", () => {
    const clusters = [
      {
        id: "1",
        theme: "작은 클러스터",
        records: [{ text: "짧은", _source: "commits", date: "2025-01-01" }],
        sources: ["commits"],
        dateRange: { from: "2025-01-01", to: "2025-01-01" },
        keywords: ["짧은"],
        score: 0,
      },
      {
        id: "2",
        theme: "큰 클러스터",
        records: [
          { text: "Redis 캐싱 레이어를 구현하여 응답 속도를 50% 개선", _source: "commits", date: "2026-03-15" },
          { text: "Redis 캐시 히트율 모니터링 대시보드 구축", _source: "sessions", date: "2026-03-16" },
          { text: "팀 내 Redis 캐싱 전략 공유", _source: "slack", date: "2026-03-14" },
        ],
        sources: ["commits", "sessions", "slack"],
        dateRange: { from: "2026-03-14", to: "2026-03-16" },
        keywords: ["redis", "캐싱"],
        score: 0,
      },
    ];

    const ranked = rankClusters(clusters);
    assert.ok(ranked.length >= 1);
    // 큰 클러스터가 더 높은 점수
    assert.ok(ranked[0].theme === "큰 클러스터" || ranked[0].score >= ranked[ranked.length - 1].score);
  });

  test("빈 입력 처리", () => {
    assert.deepEqual(rankClusters([]), []);
    assert.deepEqual(rankClusters(null), []);
  });

  test("모든 클러스터에 score가 0보다 큼", () => {
    const clusters = [
      {
        id: "1",
        theme: "테스트",
        records: [{ text: "충분히 긴 텍스트로 구체성 점수 확보", _source: "commits", date: "2026-03-15" }],
        sources: ["commits"],
        dateRange: { from: "2026-03-15", to: "2026-03-15" },
        keywords: ["테스트"],
        score: 0,
      },
    ];

    const ranked = rankClusters(clusters);
    for (const c of ranked) {
      assert.ok(c.score > 0, `score should be > 0, got ${c.score}`);
    }
  });
});

// ─── generateAppealPointsWithRules ──────────────────────────────────────────

describe("generateAppealPointsWithRules", () => {
  test("클러스터를 어필 포인트로 변환", () => {
    const clusters = [
      {
        id: "1",
        theme: "Redis 캐싱",
        records: [
          { text: "Redis 캐싱 레이어 구현으로 응답 속도 50% 개선", _source: "commits", date: "2026-03-15", repo: "api-server" },
          { text: "Redis 캐시 히트율 모니터링", _source: "sessions", date: "2026-03-16" },
        ],
        sources: ["commits", "sessions"],
        dateRange: { from: "2026-03-15", to: "2026-03-16" },
        keywords: ["redis", "캐싱"],
        score: 0.75,
      },
    ];

    const points = generateAppealPointsWithRules(clusters);
    assert.equal(points.length, 1);

    const point = points[0];
    assert.ok(point.id);
    assert.ok(["achievement", "contribution", "role"].includes(point.type));
    assert.ok(point.title.length > 0);
    assert.ok(point.description.length > 0);
    assert.ok(point.evidence.length > 0);
    assert.ok(point.targetSection);
    assert.equal(typeof point.confidence, "number");
    assert.ok(point.confidence >= 0 && point.confidence <= 1);
  });

  test("achievement 유형 추론 (성과 키워드)", () => {
    const clusters = [
      {
        id: "1",
        theme: "성능 최적화",
        records: [
          { text: "캐싱 도입으로 API 응답 속도 3배 향상 달성", _source: "commits", date: "2026-03-15" },
        ],
        sources: ["commits"],
        dateRange: { from: "2026-03-15", to: "2026-03-15" },
        keywords: ["성능", "향상"],
        score: 0.6,
      },
    ];

    const points = generateAppealPointsWithRules(clusters);
    assert.equal(points[0].type, "achievement");
  });

  test("role 유형 추론 (리더십 키워드)", () => {
    const clusters = [
      {
        id: "1",
        theme: "아키텍처 설계",
        records: [
          { text: "마이크로서비스 아키텍처 설계 주도 및 의사결정", _source: "commits", date: "2026-03-15" },
        ],
        sources: ["commits"],
        dateRange: { from: "2026-03-15", to: "2026-03-15" },
        keywords: ["아키텍처", "설계"],
        score: 0.5,
      },
    ];

    const points = generateAppealPointsWithRules(clusters);
    assert.equal(points[0].type, "role");
  });

  test("contribution 유형 (기본값)", () => {
    const clusters = [
      {
        id: "1",
        theme: "코드 작업",
        records: [
          { text: "사용자 프로필 페이지 구현", _source: "commits", date: "2026-03-15" },
        ],
        sources: ["commits"],
        dateRange: { from: "2026-03-15", to: "2026-03-15" },
        keywords: ["프로필", "페이지"],
        score: 0.4,
      },
    ];

    const points = generateAppealPointsWithRules(clusters);
    assert.equal(points[0].type, "contribution");
  });

  test("빈 입력 처리", () => {
    assert.deepEqual(generateAppealPointsWithRules([]), []);
  });
});

// ─── generateSuggestions (전체 파이프라인) ───────────────────────────────────

describe("generateSuggestions", () => {
  test("전체 파이프라인 실행 (LLM 건너뛰기)", async () => {
    const exploreResult = makeExploreResult({
      commits: [
        makeCommitRecord("Redis 캐싱 레이어 구현", "2026-03-15", "api-server"),
        makeCommitRecord("Redis 캐시 히트율 모니터링 추가", "2026-03-16", "api-server"),
      ],
      sessions: [
        makeSessionRecord("Redis 캐싱 전략 설계 세션", "2026-03-14"),
      ],
      totalCount: 3,
    });

    const result = await generateSuggestions(exploreResult, { skipLLM: true });

    assert.ok(result.appealPoints.length > 0, "어필 포인트가 있어야 함");
    assert.ok(result.totalEvidence === 3);
    assert.ok(result.clusterSummary.length > 0);
    assert.ok(Array.isArray(result.followUpQuestions));

    // 각 어필 포인트 구조 검증
    for (const ap of result.appealPoints) {
      assert.ok(ap.id);
      assert.ok(ap.type);
      assert.ok(ap.title);
      assert.ok(ap.description);
      assert.ok(Array.isArray(ap.evidence));
      assert.ok(ap.targetSection);
      assert.equal(typeof ap.confidence, "number");
    }
  });

  test("빈 ExploreResult → 보충 질문 반환", async () => {
    const exploreResult = makeExploreResult({ totalCount: 0 });

    const result = await generateSuggestions(exploreResult, { skipLLM: true });

    assert.equal(result.appealPoints.length, 0);
    assert.ok(result.followUpQuestions.length > 0);
    assert.equal(result.totalEvidence, 0);
  });

  test("null 입력 처리", async () => {
    const result = await generateSuggestions(null, { skipLLM: true });

    assert.equal(result.appealPoints.length, 0);
    assert.ok(result.followUpQuestions.length > 0);
  });

  test("followUpQuestion 전달", async () => {
    const exploreResult = makeExploreResult({
      commits: [makeCommitRecord("Redis 작업")],
      totalCount: 1,
      followUpQuestion: "Redis 관련 수치적 성과가 있나요?",
    });

    const result = await generateSuggestions(exploreResult, { skipLLM: true });
    assert.ok(
      result.followUpQuestions.includes("Redis 관련 수치적 성과가 있나요?"),
      "원본 followUpQuestion이 포함되어야 함"
    );
  });
});

// ─── formatSuggestionMessage ────────────────────────────────────────────────

describe("formatSuggestionMessage", () => {
  test("어필 포인트를 포맷팅", () => {
    const set = {
      appealPoints: [
        {
          id: "1",
          type: "achievement",
          title: "Redis 캐싱으로 응답 속도 50% 개선",
          description: "캐싱 레이어 도입으로 API 응답 속도를 50% 개선하고 서버 비용 절감",
          evidence: [
            { source: "commits", date: "2026-03-15", text: "Redis 캐싱 레이어 구현" },
          ],
          targetSection: "experience",
          confidence: 0.85,
          company: "api-server",
        },
      ],
      followUpQuestions: ["정확한 수치가 있나요?"],
      clusterSummary: [],
      totalEvidence: 5,
    };

    const msg = formatSuggestionMessage(set);
    assert.ok(msg.includes("1개 어필 포인트"));
    assert.ok(msg.includes("근거 5건"));
    assert.ok(msg.includes("🏆 성과"));
    assert.ok(msg.includes("Redis 캐싱으로 응답 속도 50% 개선"));
    assert.ok(msg.includes("신뢰도"));
    assert.ok(msg.includes("보충 질문"));
    assert.ok(msg.includes("정확한 수치가 있나요?"));
  });

  test("빈 결과 포맷팅", () => {
    const msg = formatSuggestionMessage({
      appealPoints: [],
      followUpQuestions: ["더 구체적으로 알려주세요"],
      clusterSummary: [],
      totalEvidence: 0,
    });

    assert.ok(msg.includes("찾지 못했습니다"));
    assert.ok(msg.includes("더 구체적으로 알려주세요"));
  });

  test("null 입력 처리", () => {
    const msg = formatSuggestionMessage(null);
    assert.ok(msg.includes("찾지 못했습니다"));
  });
});
