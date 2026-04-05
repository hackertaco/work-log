/**
 * resumeChatRecommendEngine.test.mjs
 *
 * 통합 추천 엔진 테스트 (Sub-AC 3 of AC 3)
 *
 * 커버리지:
 *   - selectStrategy: 근거 수에 따른 전략 선택
 *   - generateRecommendations (flat): 소수 근거 → flat ranking 어필 포인트
 *   - generateRecommendations (cluster): 다수 근거 → cluster-based 어필 포인트
 *   - generateRecommendations: 빈 입력 → followUpQuestions
 *   - generateRecommendations: forceStrategy 옵션
 *   - Recommendation 정규화: category, confidence, evidence, sourceRefs
 *   - citations / sourceSummary 생성
 *   - dataGaps 분석
 *   - formatRecommendations: Markdown 포맷팅
 *
 * Run:
 *   node --test src/lib/resumeChatRecommendEngine.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  generateRecommendations,
  selectStrategy,
  formatRecommendations,
} from "./resumeChatRecommendEngine.mjs";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const COMMIT_RECORD = {
  source: "commits",
  date: "2024-03-15",
  text: "my-repo: feat: add CI/CD pipeline for faster deployments",
  relevanceScore: 2,
  score: 0.8,
  matchedKeywords: ["CI/CD", "pipeline"],
  provenance: {
    sourceType: "commits",
    commitHash: "abc1234",
    repo: "my-repo",
  },
};

const SLACK_RECORD = {
  source: "slack",
  date: "2024-03-14",
  text: "배포 자동화 완료, 팀 전체 공유했습니다",
  relevanceScore: 1,
  score: 0.6,
  matchedKeywords: ["배포"],
  provenance: {
    sourceType: "slack",
    messageId: "1710000000.000",
    channelId: "C001",
  },
};

const SESSION_RECORD = {
  source: "sessions",
  date: "2024-03-13",
  text: "CI/CD 파이프라인 설계 검토 중 — GitHub Actions 활용",
  relevanceScore: 2,
  score: 0.7,
  matchedKeywords: ["CI/CD"],
  provenance: {
    sourceType: "session",
    sessionType: "claude",
  },
};

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

function makeSmallExploreResult() {
  return makeExploreResult({
    commits: [COMMIT_RECORD],
    slack: [SLACK_RECORD],
    sessions: [SESSION_RECORD],
    totalCount: 3,
    sourceMeta: {
      commits: { searched: true, resultCount: 1, keywords: ["CI/CD"] },
      slack: { searched: true, resultCount: 1, keywords: ["배포"] },
      sessions: { searched: true, resultCount: 1, keywords: ["CI/CD"] },
    },
  });
}

function makeLargeExploreResult() {
  const commits = Array.from({ length: 6 }, (_, i) => ({
    ...COMMIT_RECORD,
    date: `2024-03-${String(i + 1).padStart(2, "0")}`,
    text: `repo-${i % 3}: feat: feature ${i} implementation with optimization`,
    relevanceScore: i + 1,
    score: 0.5 + i * 0.1,
    matchedKeywords: ["feature", "optimization"],
  }));

  return makeExploreResult({
    commits,
    slack: [SLACK_RECORD, { ...SLACK_RECORD, date: "2024-03-10", text: "성능 개선 결과 공유" }],
    sessions: [SESSION_RECORD],
    totalCount: commits.length + 3,
    sourceMeta: {
      commits: { searched: true, resultCount: commits.length, keywords: ["feature"] },
      slack: { searched: true, resultCount: 2, keywords: ["성능"] },
      sessions: { searched: true, resultCount: 1, keywords: ["CI/CD"] },
    },
  });
}

// ─── selectStrategy ──────────────────────────────────────────────────────────

describe("selectStrategy", () => {
  test("근거 5건 이하이면 flat 전략을 선택한다", () => {
    assert.equal(selectStrategy(0), "flat");
    assert.equal(selectStrategy(1), "flat");
    assert.equal(selectStrategy(5), "flat");
  });

  test("근거 6건 이상이면 cluster 전략을 선택한다", () => {
    assert.equal(selectStrategy(6), "cluster");
    assert.equal(selectStrategy(20), "cluster");
    assert.equal(selectStrategy(100), "cluster");
  });
});

// ─── generateRecommendations: 빈 입력 ────────────────────────────────────────

describe("generateRecommendations - 빈 입력", () => {
  test("null exploreResult → 빈 결과 + 보충 질문", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations("찾아줘", null);

      assert.ok(result, "결과가 있어야 한다");
      assert.deepEqual(result.recommendations, [], "빈 추천");
      assert.ok(result.followUpQuestions.length > 0, "보충 질문이 있어야 한다");
      assert.equal(result.totalEvidence, 0);
      assert.equal(result.strategy, "flat");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("totalCount=0 exploreResult → 빈 결과", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "찾아줘",
        makeExploreResult({ totalCount: 0 })
      );

      assert.deepEqual(result.recommendations, []);
      assert.ok(result.followUpQuestions.length > 0);
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("exploreResult.followUpQuestion 이 결과에 포함된다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "찾아줘",
        makeExploreResult({
          totalCount: 0,
          followUpQuestion: "다른 키워드로 시도해 보세요.",
        })
      );

      assert.ok(
        result.followUpQuestions.includes("다른 키워드로 시도해 보세요."),
        "탐색 결과의 followUpQuestion 이 포함되어야 한다"
      );
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });
});

// ─── generateRecommendations: flat 전략 ────────────────────────────────────

describe("generateRecommendations - flat 전략", () => {
  test("소수 근거(≤5) → flat 전략으로 어필 포인트 생성", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "CI/CD 관련 어필 포인트",
        makeSmallExploreResult()
      );

      assert.ok(result, "결과가 있어야 한다");
      assert.equal(result.strategy, "flat", "flat 전략이 선택되어야 한다");
      assert.ok(Array.isArray(result.recommendations), "recommendations 는 배열");
      assert.ok(result.totalEvidence === 3, "totalEvidence 는 3");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("flat 전략 결과의 Recommendation 필드가 올바르다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "CI/CD 찾아줘",
        makeSmallExploreResult()
      );

      for (const rec of result.recommendations) {
        assert.ok(typeof rec.id === "string", "id 는 문자열");
        assert.ok(typeof rec.title === "string", "title 은 문자열");
        assert.ok(typeof rec.description === "string", "description 은 문자열");
        assert.ok(
          ["achievement", "contribution", "capability"].includes(rec.category),
          `category 는 유효한 값 (got: ${rec.category})`
        );
        assert.ok(typeof rec.section === "string", "section 은 문자열");
        assert.ok(
          typeof rec.confidence === "number" &&
          rec.confidence >= 0 && rec.confidence <= 1,
          "confidence 는 0–1 범위"
        );
        assert.ok(Array.isArray(rec.evidence), "evidence 는 배열");
        assert.ok(Array.isArray(rec.sourceRefs), "sourceRefs 는 배열");
      }
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("forceStrategy='flat' 으로 강제 가능하다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "기능 구현",
        makeLargeExploreResult(),
        { forceStrategy: "flat" }
      );

      assert.equal(result.strategy, "flat", "forceStrategy='flat' 이면 flat");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });
});

// ─── generateRecommendations: cluster 전략 ──────────────────────────────────

describe("generateRecommendations - cluster 전략", () => {
  test("다수 근거(>5) → cluster 전략으로 어필 포인트 생성", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "기능 구현 관련 어필 포인트",
        makeLargeExploreResult()
      );

      assert.ok(result, "결과가 있어야 한다");
      assert.equal(result.strategy, "cluster", "cluster 전략이 선택되어야 한다");
      assert.ok(Array.isArray(result.recommendations), "recommendations 는 배열");
      assert.ok(result.totalEvidence > 5, "totalEvidence 가 5 초과");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("forceStrategy='cluster' 로 강제 가능하다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "CI/CD 찾아줘",
        makeSmallExploreResult(),
        { forceStrategy: "cluster" }
      );

      assert.equal(result.strategy, "cluster", "forceStrategy='cluster' 이면 cluster");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("cluster 전략 결과의 Recommendation 필드가 올바르다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "기능 구현",
        makeLargeExploreResult()
      );

      for (const rec of result.recommendations) {
        assert.ok(typeof rec.id === "string", "id 는 문자열");
        assert.ok(typeof rec.title === "string" && rec.title.length > 0, "title 은 비어있지 않은 문자열");
        assert.ok(typeof rec.description === "string", "description 은 문자열");
        assert.ok(
          ["achievement", "contribution", "capability"].includes(rec.category),
          `category 는 유효한 값 (got: ${rec.category})`
        );
        assert.ok(typeof rec.confidence === "number", "confidence 는 숫자");
        assert.ok(rec.confidence >= 0 && rec.confidence <= 1, "confidence 는 0–1 범위");
        assert.ok(Array.isArray(rec.evidence), "evidence 는 배열");
      }
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });
});

// ─── citations / sourceSummary ───────────────────────────────────────────────

describe("citations and sourceSummary", () => {
  test("결과에 citations 배열이 포함된다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "CI/CD",
        makeSmallExploreResult()
      );

      assert.ok(Array.isArray(result.citations), "citations 는 배열");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("결과에 sourceSummary 가 포함된다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "CI/CD",
        makeSmallExploreResult()
      );

      assert.ok(result.sourceSummary, "sourceSummary 가 있어야 한다");
      assert.ok(typeof result.sourceSummary.total === "number", "total 은 숫자");
      assert.ok(Array.isArray(result.sourceSummary.repos), "repos 는 배열");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("빈 결과의 sourceSummary.total 은 0이다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations("찾아줘", null);

      assert.equal(result.sourceSummary.total, 0);
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });
});

// ─── dataGaps 분석 ───────────────────────────────────────────────────────────

describe("dataGaps", () => {
  test("검색 결과가 있으면 dataGaps 배열을 반환한다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "CI/CD",
        makeSmallExploreResult()
      );

      assert.ok(Array.isArray(result.dataGaps), "dataGaps 는 배열");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("검색 결과가 없으면 dataGaps 에 부족 메시지가 포함된다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "찾아줘",
        makeExploreResult({ totalCount: 0 })
      );

      assert.ok(result.dataGaps.length > 0, "dataGaps 가 비어있지 않아야 한다");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });
});

// ─── formatRecommendations ──────────────────────────────────────────────────

describe("formatRecommendations", () => {
  test("추천이 있으면 Markdown 형식의 문자열을 반환한다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "CI/CD 관련 어필 포인트",
        makeSmallExploreResult()
      );

      const message = formatRecommendations(result);

      assert.ok(typeof message === "string", "결과는 문자열");
      assert.ok(message.length > 0, "결과는 비어있지 않음");
      if (result.recommendations.length > 0) {
        assert.ok(message.includes("어필 포인트"), "제목에 어필 포인트 포함");
      }
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("빈 추천이면 안내 메시지를 반환한다", () => {
    const result = {
      recommendations: [],
      citations: [],
      sourceSummary: { commits: 0, slack: 0, sessions: 0, total: 0, repos: [], dateRange: [] },
      dataGaps: [],
      followUpQuestions: ["다른 키워드로 시도해 보세요."],
      strategy: "flat",
      totalEvidence: 0,
    };

    const message = formatRecommendations(result);

    assert.ok(message.includes("찾지 못했습니다"), "안내 메시지 포함");
    assert.ok(message.includes("다른 키워드"), "보충 질문 포함");
  });

  test("null 결과에서 안전하게 처리된다", () => {
    const message = formatRecommendations(null);
    assert.ok(typeof message === "string", "결과는 문자열");
    assert.ok(message.includes("찾지 못했습니다"), "안내 메시지 포함");
  });
});

// ─── 통합 파이프라인 ─────────────────────────────────────────────────────────

describe("통합 파이프라인", () => {
  test("소수 근거에서 full pipeline 실행 가능", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const exploreResult = makeSmallExploreResult();
      const result = await generateRecommendations(
        "CI/CD 관련 어필 포인트",
        exploreResult
      );

      // 기본 구조 검증
      assert.ok(result.recommendations !== undefined);
      assert.ok(result.citations !== undefined);
      assert.ok(result.sourceSummary !== undefined);
      assert.ok(result.dataGaps !== undefined);
      assert.ok(result.followUpQuestions !== undefined);
      assert.equal(result.totalEvidence, 3);

      // 포맷팅도 가능
      const message = formatRecommendations(result);
      assert.ok(typeof message === "string");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("다수 근거에서 full pipeline 실행 가능", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const exploreResult = makeLargeExploreResult();
      const result = await generateRecommendations(
        "기능 구현 및 성능 개선",
        exploreResult
      );

      assert.ok(result.recommendations !== undefined);
      assert.ok(result.citations !== undefined);
      assert.ok(result.totalEvidence > 5);
      assert.equal(result.strategy, "cluster");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });

  test("maxPoints 옵션이 적용된다", async () => {
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await generateRecommendations(
        "기능 구현",
        makeLargeExploreResult(),
        { maxPoints: 2 }
      );

      assert.ok(result.recommendations.length <= 2, "maxPoints=2 이면 추천 2개 이하");
    } finally {
      if (origDisable === undefined) delete process.env.WORK_LOG_DISABLE_OPENAI;
      else process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
    }
  });
});
