/**
 * Tests for resumeChatQueryAnalysis.mjs
 *
 * 사용자 자유 질의를 받아 의도를 파악하고, 커밋/슬랙/세션 메모리
 * 데이터 소스별로 관련 키워드·기간 등 검색 파라미터를 생성하는
 * 쿼리 분석 모듈 테스트.
 *
 * Run with:
 *   node --test src/lib/resumeChatQueryAnalysis.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  analyzeQuery,
  analyzeQueryWithRules,
  extractKeywords,
  toSearchQuery,
  toUnifiedSearchQuery,
} from "./resumeChatQueryAnalysis.mjs";

// ── analyzeQueryWithRules: 기본 동작 ────────────────────────────────────────

describe("analyzeQueryWithRules", () => {
  test("빈 입력은 빈 결과를 반환한다", () => {
    const result = analyzeQueryWithRules("");
    assert.equal(result.raw, "");
    assert.equal(result.intent, "general");
    assert.equal(result.section, null);
    assert.equal(result.confidence, 0);
    assert.equal(result.method, "rules");
    assert.deepEqual(result.sourceParams.commits.keywords, []);
    assert.deepEqual(result.sourceParams.slack.keywords, []);
    assert.deepEqual(result.sourceParams.sessions.keywords, []);
  });

  test("null 입력은 빈 결과를 반환한다", () => {
    const result = analyzeQueryWithRules(null);
    assert.equal(result.raw, "");
    assert.equal(result.intent, "general");
  });
});

// ── Intent 분류 ─────────────────────────────────────────────────────────────

describe("Intent 분류", () => {
  test("apply_section: '반영해줘' 패턴을 감지한다", () => {
    const result = analyzeQueryWithRules("이대로 반영해줘");
    assert.equal(result.intent, "apply_section");
  });

  test("apply_section: 'apply this' 패턴을 감지한다", () => {
    const result = analyzeQueryWithRules("apply this to my resume");
    assert.equal(result.intent, "apply_section");
  });

  test("search_evidence: '찾아' 패턴을 감지한다", () => {
    const result = analyzeQueryWithRules("결제 관련 작업 기록을 찾아줘");
    assert.equal(result.intent, "search_evidence");
  });

  test("search_evidence: '커밋' 키워드를 감지한다", () => {
    const result = analyzeQueryWithRules("최근 커밋 내용 보여줘");
    assert.equal(result.intent, "search_evidence");
  });

  test("refine_section: '수정' 패턴을 감지한다", () => {
    const result = analyzeQueryWithRules("경력 섹션 좀 수정해줘");
    assert.equal(result.intent, "refine_section");
  });

  test("refine_section: '개선' 패턴을 감지한다", () => {
    const result = analyzeQueryWithRules("자기소개를 개선해줘");
    assert.equal(result.intent, "refine_section");
  });

  test("question: '?' 로 끝나는 질의를 감지한다", () => {
    const result = analyzeQueryWithRules("이 프로젝트에서 내가 뭘 했지?");
    assert.equal(result.intent, "question");
  });

  test("general: 기타 입력은 general 로 분류한다", () => {
    const result = analyzeQueryWithRules("안녕하세요");
    assert.equal(result.intent, "general");
  });
});

// ── Section 감지 ────────────────────────────────────────────────────────────

describe("Section 감지", () => {
  test("경력/경험 섹션을 감지한다", () => {
    const result = analyzeQueryWithRules("경력 섹션에 추가해줘");
    assert.equal(result.section, "experience");
  });

  test("기술 섹션을 감지한다", () => {
    const result = analyzeQueryWithRules("기술 스택을 업데이트해줘");
    assert.equal(result.section, "skills");
  });

  test("자기소개 섹션을 감지한다", () => {
    const result = analyzeQueryWithRules("자기소개를 다듬어줘");
    assert.equal(result.section, "summary");
  });

  test("강점 섹션을 감지한다", () => {
    const result = analyzeQueryWithRules("나의 강점을 분석해줘");
    assert.equal(result.section, "strengths");
  });

  test("프로젝트 섹션을 감지한다", () => {
    const result = analyzeQueryWithRules("사이드 프로젝트 목록을 보여줘");
    assert.equal(result.section, "projects");
  });

  test("섹션이 없는 질의는 null 을 반환한다", () => {
    const result = analyzeQueryWithRules("뭔가 보여줘");
    assert.equal(result.section, null);
  });
});

// ── 날짜 범위 추출 ──────────────────────────────────────────────────────────

describe("날짜 범위 추출", () => {
  test("절대 연도: '2024년'", () => {
    const result = analyzeQueryWithRules("2024년에 한 작업 보여줘");
    assert.deepEqual(result.sourceParams.commits.dateRange, {
      from: "2024-01-01",
      to: "2024-12-31",
    });
  });

  test("절대 연도+월: '2024년 3월'", () => {
    const result = analyzeQueryWithRules("2024년 3월에 한 작업 보여줘");
    assert.deepEqual(result.sourceParams.commits.dateRange, {
      from: "2024-03-01",
      to: "2024-03-31",
    });
  });

  test("상대: '올해'", () => {
    const currentYear = new Date().getFullYear();
    const result = analyzeQueryWithRules("올해 작업 목록 보여줘");
    assert.equal(result.sourceParams.commits.dateRange.from, `${currentYear}-01-01`);
    assert.equal(result.sourceParams.commits.dateRange.to, `${currentYear}-12-31`);
  });

  test("상대: '지난주'", () => {
    const result = analyzeQueryWithRules("지난주에 작업한 것 찾아줘");
    assert.ok(result.sourceParams.commits.dateRange);
    assert.ok(result.sourceParams.commits.dateRange.from);
    assert.ok(result.sourceParams.commits.dateRange.to);
  });

  test("상대: '최근 3개월'", () => {
    const result = analyzeQueryWithRules("최근 3개월간 작업 보여줘");
    assert.ok(result.sourceParams.commits.dateRange);
    assert.ok(result.sourceParams.commits.dateRange.from);
  });

  test("날짜 없는 질의는 dateRange 가 null", () => {
    const result = analyzeQueryWithRules("React 관련 작업");
    assert.equal(result.sourceParams.commits.dateRange, null);
  });
});

// ── 키워드 추출 ─────────────────────────────────────────────────────────────

describe("extractKeywords", () => {
  test("한글 키워드를 추출한다", () => {
    const keywords = extractKeywords("결제 기능 리팩토링 작업");
    assert.ok(keywords.includes("결제"));
    assert.ok(keywords.includes("기능"));
    assert.ok(keywords.includes("리팩토링"));
    assert.ok(keywords.includes("작업"));
  });

  test("영어 키워드를 추출한다", () => {
    const keywords = extractKeywords("React Native migration");
    assert.ok(keywords.includes("React"));
    assert.ok(keywords.includes("Native"));
    assert.ok(keywords.includes("migration"));
  });

  test("불용어를 제거한다", () => {
    const keywords = extractKeywords("결제에 관련된 내용을 찾아줘");
    assert.ok(!keywords.includes("관련"));
    assert.ok(!keywords.includes("찾아줘"));
  });

  test("따옴표 구문을 하나의 키워드로 처리한다", () => {
    const keywords = extractKeywords('"결제 API" 관련 작업');
    assert.ok(keywords.includes("결제 API"));
  });

  test("중복을 제거한다", () => {
    const keywords = extractKeywords("React react REACT");
    const reactCount = keywords.filter(
      (kw) => kw.toLowerCase() === "react"
    ).length;
    assert.equal(reactCount, 1);
  });

  test("1글자 단어를 제외한다", () => {
    const keywords = extractKeywords("a b cd ef");
    assert.ok(!keywords.includes("a"));
    assert.ok(!keywords.includes("b"));
    assert.ok(keywords.includes("cd"));
    assert.ok(keywords.includes("ef"));
  });
});

// ── 소스별 검색 파라미터 차별화 ──────────────────────────────────────────────

describe("소스별 검색 파라미터", () => {
  test("커밋 언급 시 커밋 소스 우선순위가 high", () => {
    const result = analyzeQueryWithRules("최근 커밋에서 결제 관련 변경 찾아줘");
    assert.equal(result.sourceParams.commits.priority, "high");
  });

  test("슬랙 언급 시 슬랙 소스 우선순위가 high", () => {
    const result = analyzeQueryWithRules("슬랙에서 결제 논의 찾아줘");
    assert.equal(result.sourceParams.slack.priority, "high");
  });

  test("세션 언급 시 세션 소스 우선순위가 high", () => {
    const result = analyzeQueryWithRules("AI 세션에서 디버깅 관련 내용 찾아줘");
    assert.equal(result.sourceParams.sessions.priority, "high");
  });

  test("특정 소스 언급 없으면 모든 소스가 medium", () => {
    const result = analyzeQueryWithRules("결제 기능 작업 기록 찾아줘");
    assert.equal(result.sourceParams.commits.priority, "medium");
    assert.equal(result.sourceParams.slack.priority, "medium");
    assert.equal(result.sourceParams.sessions.priority, "medium");
  });

  test("high 우선순위 소스의 maxResults 가 더 크다", () => {
    const result = analyzeQueryWithRules("최근 커밋에서 결제 관련 변경 찾아줘");
    assert.ok(result.sourceParams.commits.maxResults > result.sourceParams.slack.maxResults);
  });

  test("기술 용어가 커밋 키워드에 추가된다", () => {
    const result = analyzeQueryWithRules("React.memo 관련 작업");
    // 점 표기법이 커밋 키워드에 포함되어야 함
    assert.ok(
      result.sourceParams.commits.keywords.some((kw) => kw.includes("React.memo")),
      "커밋 키워드에 React.memo가 포함되어야 함"
    );
  });

  test("모든 소스에 동일 날짜 범위가 적용된다", () => {
    const result = analyzeQueryWithRules("2024년 결제 관련 작업 찾아줘");
    const dr = { from: "2024-01-01", to: "2024-12-31" };
    assert.deepEqual(result.sourceParams.commits.dateRange, dr);
    assert.deepEqual(result.sourceParams.slack.dateRange, dr);
    assert.deepEqual(result.sourceParams.sessions.dateRange, dr);
  });
});

// ── 보충 질문 생성 ──────────────────────────────────────────────────────────

describe("보충 질문 (followUpQuestion)", () => {
  test("키워드 없으면 보충 질문을 생성한다", () => {
    // "보여줘" 는 검색 의도지만 키워드가 없음
    const result = analyzeQueryWithRules("보여줘");
    assert.ok(result.followUpQuestion);
    assert.ok(result.followUpQuestion.length > 0);
  });

  test("섹션 수정 의도인데 섹션이 불명확하면 보충 질문", () => {
    const result = analyzeQueryWithRules("좀 수정해줘");
    assert.equal(result.intent, "refine_section");
    assert.equal(result.section, null);
    assert.ok(result.followUpQuestion);
    assert.ok(result.followUpQuestion.includes("섹션"));
  });

  test("키워드 충분하면 보충 질문 없음", () => {
    const result = analyzeQueryWithRules("결제 기능 리팩토링 작업 기록 찾아줘");
    assert.equal(result.followUpQuestion, null);
  });
});

// ── 신뢰도 계산 ─────────────────────────────────────────────────────────────

describe("신뢰도 (confidence)", () => {
  test("키워드+의도+섹션 모두 있으면 높은 신뢰도", () => {
    const result = analyzeQueryWithRules("경력 섹션에 결제 API 개발 경험 추가해줘");
    assert.ok(result.confidence >= 0.7, `confidence: ${result.confidence}`);
  });

  test("키워드만 있으면 중간 신뢰도", () => {
    const result = analyzeQueryWithRules("결제 시스템");
    assert.ok(result.confidence >= 0.4 && result.confidence < 0.8, `confidence: ${result.confidence}`);
  });

  test("빈 질의는 신뢰도 0", () => {
    const result = analyzeQueryWithRules("");
    assert.equal(result.confidence, 0);
  });
});

// ── toSearchQuery 변환 ──────────────────────────────────────────────────────

describe("toSearchQuery", () => {
  test("commits 소스의 SearchQuery 를 올바르게 변환한다", () => {
    const analysis = analyzeQueryWithRules("2024년 결제 관련 커밋 찾아줘");
    const sq = toSearchQuery(analysis, "commits");
    assert.ok(sq.keywords.length > 0);
    assert.ok(sq.dateRange);
    assert.equal(sq.dateRange.from, "2024-01-01");
    assert.equal(sq.dateRange.to, "2024-12-31");
  });

  test("slack 소스의 SearchQuery 를 올바르게 변환한다", () => {
    const analysis = analyzeQueryWithRules("결제 관련 슬랙 메시지 찾아줘");
    const sq = toSearchQuery(analysis, "slack");
    assert.ok(sq.keywords.length > 0);
  });

  test("dateRange 가 없으면 SearchQuery 에 dateRange 가 없다", () => {
    const analysis = analyzeQueryWithRules("결제 관련 작업 찾아줘");
    const sq = toSearchQuery(analysis, "commits");
    assert.equal(sq.dateRange, undefined);
  });
});

// ── toUnifiedSearchQuery 변환 ────────────────────────────────────────────────

describe("toUnifiedSearchQuery", () => {
  test("모든 소스 키워드를 합집합으로 결합한다", () => {
    const analysis = analyzeQueryWithRules("결제 API 개발 커밋 찾아줘");
    const sq = toUnifiedSearchQuery(analysis);
    assert.ok(sq.keywords.length > 0);
    // 기술 용어가 커밋에만 추가되더라도 통합 쿼리에 포함
    const allSourceKeywords = new Set([
      ...analysis.sourceParams.commits.keywords,
      ...analysis.sourceParams.slack.keywords,
      ...analysis.sourceParams.sessions.keywords,
    ]);
    assert.equal(sq.keywords.length, allSourceKeywords.size);
  });
});

// ── analyzeQuery (LLM 비활성화 시 폴백) ─────────────────────────────────────

describe("analyzeQuery (LLM 비활성화)", () => {
  test("OPENAI_API_KEY 없으면 rules 폴백", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await analyzeQuery("결제 기능 작업 찾아줘");
      assert.equal(result.method, "rules");
      assert.ok(result.sourceParams.commits.keywords.length > 0);
    } finally {
      if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    }
  });

  test("WORK_LOG_DISABLE_OPENAI=1 이면 rules 폴백", async () => {
    const originalDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
    try {
      const result = await analyzeQuery("결제 기능 작업 찾아줘");
      assert.equal(result.method, "rules");
    } finally {
      if (originalDisable) {
        process.env.WORK_LOG_DISABLE_OPENAI = originalDisable;
      } else {
        delete process.env.WORK_LOG_DISABLE_OPENAI;
      }
    }
  });
});

// ── 복합 시나리오 ───────────────────────────────────────────────────────────

describe("복합 시나리오", () => {
  test("'지난달 React 프로젝트 경력에 추가해줘' — 의도+섹션+기간+키워드 모두 추출", () => {
    const result = analyzeQueryWithRules("지난달 React 프로젝트 경력에 추가해줘");
    assert.equal(result.intent, "refine_section");
    assert.equal(result.section, "experience");
    assert.ok(result.sourceParams.commits.dateRange);
    assert.ok(
      result.sourceParams.commits.keywords.some(
        (kw) => kw.toLowerCase() === "react"
      )
    );
  });

  test("'2024년 3월 결제 시스템 리팩토링 관련 슬랙 메시지 검색' — 소스 특화", () => {
    const result = analyzeQueryWithRules(
      "2024년 3월 결제 시스템 리팩토링 관련 슬랙 메시지 검색"
    );
    assert.equal(result.intent, "search_evidence");
    assert.equal(result.sourceParams.slack.priority, "high");
    assert.deepEqual(result.sourceParams.commits.dateRange, {
      from: "2024-03-01",
      to: "2024-03-31",
    });
    assert.ok(
      result.sourceParams.slack.keywords.some(
        (kw) => kw === "결제"
      )
    );
  });

  test("'이대로 적용해줘' — apply_section 의도, 보충 질문 없음", () => {
    const result = analyzeQueryWithRules("이대로 적용해줘");
    assert.equal(result.intent, "apply_section");
    assert.equal(result.followUpQuestion, null);
  });

  test("'강점 분석해줘' — strengths 섹션 감지", () => {
    const result = analyzeQueryWithRules("나의 강점을 분석해줘");
    assert.equal(result.section, "strengths");
  });
});
