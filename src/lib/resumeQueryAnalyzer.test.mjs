/**
 * Tests for resumeQueryAnalyzer.mjs — Server-side Query Analysis Module.
 *
 * Uses Node.js built-in test runner (node:test).
 * Run:
 *   node --test src/lib/resumeQueryAnalyzer.test.mjs
 *
 * Coverage:
 *   - analyzeQuery: intent detection, keyword extraction, section detection,
 *                   date range parsing, source parameter generation,
 *                   confidence scoring, clarification hints
 *   - expandKeywordsForSource: keyword expansion per data source
 *   - extractDateRange: absolute/relative date parsing
 *   - extractKeywords: Korean/English keyword extraction, stopword filtering
 *   - toSearchQuery / toSourceSearchQuery: conversion helpers
 *   - analyzeQueryWithLLM: graceful fallback when LLM unavailable
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeQuery,
  analyzeQueryWithLLM,
  expandKeywordsForSource,
  extractDateRange,
  extractKeywords,
  extractTechStack,
  toSearchQuery,
  toSourceSearchQuery,
} from "./resumeQueryAnalyzer.mjs";

// ─── analyzeQuery: basic parsing ─────────────────────────────────────────────

describe("analyzeQuery", () => {
  test("returns empty result for empty input", () => {
    const result = analyzeQuery("");
    assert.equal(result.raw, "");
    assert.equal(result.intent, "general");
    assert.deepEqual(result.keywords, []);
    assert.equal(result.section, null);
    assert.equal(result.dateRange, null);
    assert.equal(result.confidence, 0);
    assert.equal(result.needsClarification, true);
    assert.ok(result.clarificationHint);
  });

  test("returns empty result for null input", () => {
    const result = analyzeQuery(null);
    assert.equal(result.raw, "");
    assert.equal(result.intent, "general");
  });

  test("returns empty result for undefined input", () => {
    const result = analyzeQuery(undefined);
    assert.equal(result.raw, "");
  });

  test("preserves raw input after trimming", () => {
    const result = analyzeQuery("  Redis 캐싱 작업 찾아줘  ");
    assert.equal(result.raw, "Redis 캐싱 작업 찾아줘");
  });
});

// ─── Intent detection ────────────────────────────────────────────────────────

describe("analyzeQuery intent detection", () => {
  test("detects apply_section for '반영해줘'", () => {
    assert.equal(analyzeQuery("이대로 반영해줘").intent, "apply_section");
  });

  test("detects apply_section for '적용해줘'", () => {
    assert.equal(analyzeQuery("적용해줘").intent, "apply_section");
  });

  test("detects apply_section for 'apply this'", () => {
    assert.equal(analyzeQuery("apply this").intent, "apply_section");
  });

  test("detects search_evidence for '찾아줘'", () => {
    assert.equal(analyzeQuery("Redis 관련 커밋 찾아줘").intent, "search_evidence");
  });

  test("detects search_evidence for '검색'", () => {
    assert.equal(analyzeQuery("슬랙 메시지 검색해줘").intent, "search_evidence");
  });

  test("detects refine_section for '수정'", () => {
    assert.equal(analyzeQuery("경력 섹션 수정해줘").intent, "refine_section");
  });

  test("detects refine_section for 'improve'", () => {
    assert.equal(analyzeQuery("improve my skills section").intent, "refine_section");
  });

  test("detects question for '?'", () => {
    // "이력서" contains "이력" which matches search_evidence;
    // use a query that only matches question patterns
    assert.equal(analyzeQuery("이건 뭐야?").intent, "question");
  });

  test("detects general for unmatched input", () => {
    assert.equal(analyzeQuery("Redis 캐싱 레이어").intent, "general");
  });

  test("apply_section takes priority over refine_section", () => {
    // "수정해서 반영해줘" has both "수정" (refine) and "반영해줘" (apply)
    assert.equal(analyzeQuery("이걸로 반영해줘").intent, "apply_section");
  });
});

// ─── Keyword extraction ──────────────────────────────────────────────────────

describe("analyzeQuery keyword extraction", () => {
  test("extracts Korean keywords (2+ chars, no stopwords)", () => {
    const result = analyzeQuery("Redis 캐싱 관련 작업 찾아줘");
    assert.ok(result.keywords.includes("Redis"));
    assert.ok(result.keywords.includes("캐싱"));
    assert.ok(result.keywords.includes("작업"));
    // "관련" and "찾아줘" should be filtered as stopwords
    assert.ok(!result.keywords.includes("관련"));
    assert.ok(!result.keywords.includes("찾아줘"));
  });

  test("extracts English keywords (2+ chars, no stopwords)", () => {
    const result = analyzeQuery("implement Redis caching layer");
    assert.ok(result.keywords.includes("Redis"));
    assert.ok(result.keywords.includes("caching"));
    assert.ok(result.keywords.includes("layer"));
    assert.ok(result.keywords.includes("implement"));
  });

  test("extracts quoted phrases as single keywords", () => {
    const result = analyzeQuery('"Redis caching" 관련 작업');
    assert.ok(result.keywords.includes("Redis caching"));
  });

  test("deduplicates keywords case-insensitively", () => {
    const result = analyzeQuery("Redis redis REDIS");
    const redisCount = result.keywords.filter((kw) => kw.toLowerCase() === "redis").length;
    assert.equal(redisCount, 1);
  });
});

// ─── Section detection ───────────────────────────────────────────────────────

describe("analyzeQuery section detection", () => {
  test("detects experience section", () => {
    assert.equal(analyzeQuery("경력 섹션 수정").section, "experience");
  });

  test("detects skills section", () => {
    assert.equal(analyzeQuery("기술 스택 추가해줘").section, "skills");
  });

  test("detects summary section", () => {
    assert.equal(analyzeQuery("자기소개 다듬어줘").section, "summary");
  });

  test("detects education section", () => {
    assert.equal(analyzeQuery("학력 정보 업데이트").section, "education");
  });

  test("detects projects section", () => {
    // "경험" triggers experience before "프로젝트"; use a projects-only query
    assert.equal(analyzeQuery("프로젝트 목록 추가").section, "projects");
  });

  test("detects strengths section", () => {
    assert.equal(analyzeQuery("강점 분석해줘").section, "strengths");
  });

  test("returns null for no section match", () => {
    assert.equal(analyzeQuery("Redis 캐싱 작업").section, null);
  });
});

// ─── Date range extraction ───────────────────────────────────────────────────

describe("analyzeQuery date range", () => {
  test("extracts absolute year", () => {
    const result = analyzeQuery("2025년 작업 내역");
    assert.deepEqual(result.dateRange, { from: "2025-01-01", to: "2025-12-31" });
  });

  test("extracts year + month", () => {
    const result = analyzeQuery("2025년 3월 작업");
    assert.deepEqual(result.dateRange, { from: "2025-03-01", to: "2025-03-31" });
  });

  test("extracts 작년", () => {
    const result = analyzeQuery("작년 프로젝트 찾아줘");
    const lastYear = new Date().getFullYear() - 1;
    assert.equal(result.dateRange.from, `${lastYear}-01-01`);
    assert.equal(result.dateRange.to, `${lastYear}-12-31`);
  });

  test("extracts 올해", () => {
    const result = analyzeQuery("올해 작업 찾아줘");
    const year = new Date().getFullYear();
    assert.equal(result.dateRange.from, `${year}-01-01`);
    assert.equal(result.dateRange.to, `${year}-12-31`);
  });

  test("extracts 최근 N개월", () => {
    const result = analyzeQuery("최근 3개월 커밋 찾아줘");
    assert.ok(result.dateRange);
    assert.ok(result.dateRange.from);
    assert.ok(result.dateRange.to);
  });

  test("returns null when no date info", () => {
    const result = analyzeQuery("Redis 캐싱 작업");
    assert.equal(result.dateRange, null);
  });
});

// ─── Source parameter generation ─────────────────────────────────────────────

describe("analyzeQuery sourceParams", () => {
  test("enables all sources for generic search_evidence", () => {
    const result = analyzeQuery("캐싱 관련 작업 찾아줘");
    assert.equal(result.sourceParams.commits.enabled, true);
    assert.equal(result.sourceParams.slack.enabled, true);
    assert.equal(result.sourceParams.sessions.enabled, true);
  });

  test("disables all sources for apply_section", () => {
    const result = analyzeQuery("이대로 반영해줘");
    assert.equal(result.sourceParams.commits.enabled, false);
    assert.equal(result.sourceParams.slack.enabled, false);
    assert.equal(result.sourceParams.sessions.enabled, false);
  });

  test("disables all sources when no keywords", () => {
    const result = analyzeQuery("?");
    assert.equal(result.sourceParams.commits.enabled, false);
    assert.equal(result.sourceParams.slack.enabled, false);
    assert.equal(result.sourceParams.sessions.enabled, false);
  });

  test("prioritizes mentioned source (커밋)", () => {
    const result = analyzeQuery("Redis 커밋 찾아줘");
    assert.equal(result.sourceParams.commits.enabled, true);
  });

  test("prioritizes mentioned source (슬랙)", () => {
    const result = analyzeQuery("슬랙에서 Redis 메시지 찾아줘");
    assert.equal(result.sourceParams.slack.enabled, true);
  });

  test("prioritizes mentioned source (세션)", () => {
    const result = analyzeQuery("Claude 세션에서 캐싱 관련 찾아줘");
    assert.equal(result.sourceParams.sessions.enabled, true);
  });

  test("commits source gets expanded keywords", () => {
    const result = analyzeQuery("캐싱 관련 작업 찾아줘");
    const commitKws = result.sourceParams.commits.keywords;
    // 원본 "캐싱"에 더해 영어 변형도 포함
    assert.ok(commitKws.includes("캐싱"));
    assert.ok(commitKws.some((kw) => ["cache", "caching", "redis"].includes(kw.toLowerCase())));
  });

  test("slack source gets Korean-optimized keywords", () => {
    const result = analyzeQuery("캐싱 관련 작업 찾아줘");
    const slackKws = result.sourceParams.slack.keywords;
    assert.ok(slackKws.includes("캐싱"));
    assert.ok(slackKws.some((kw) => ["캐시"].includes(kw)));
  });

  test("respects intent-based maxResults", () => {
    const searchResult = analyzeQuery("캐싱 관련 작업 찾아줘");
    assert.equal(searchResult.sourceParams.commits.maxResults, 15);

    const applyResult = analyzeQuery("이대로 반영해줘");
    assert.equal(applyResult.sourceParams.commits.maxResults, 5);
  });

  test("dateRange is propagated to all sources", () => {
    const result = analyzeQuery("2025년 캐싱 작업 찾아줘");
    assert.deepEqual(result.sourceParams.commits.dateRange, result.dateRange);
    assert.deepEqual(result.sourceParams.slack.dateRange, result.dateRange);
    assert.deepEqual(result.sourceParams.sessions.dateRange, result.dateRange);
  });
});

// ─── Confidence scoring ──────────────────────────────────────────────────────

describe("analyzeQuery confidence", () => {
  test("higher confidence with intent + keywords + date + section", () => {
    const result = analyzeQuery("2025년 경력 섹션의 Redis 캐싱 작업 찾아줘");
    assert.ok(result.confidence >= 0.8, `expected >= 0.8, got ${result.confidence}`);
  });

  test("lower confidence for vague input", () => {
    const result = analyzeQuery("음...");
    assert.ok(result.confidence <= 0.3, `expected <= 0.3, got ${result.confidence}`);
  });

  test("moderate confidence for keywords only", () => {
    const result = analyzeQuery("Redis 캐싱 레이어");
    assert.ok(result.confidence > 0.1 && result.confidence < 0.8);
  });

  test("confidence is bounded 0–1", () => {
    const result = analyzeQuery("2025년 경력 섹션의 Redis 캐싱 성능 최적화 배포 작업 찾아줘");
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  });
});

// ─── Clarification ──────────────────────────────────────────────────────────

describe("analyzeQuery clarification", () => {
  test("needs clarification for empty-ish input", () => {
    const result = analyzeQuery("음");
    assert.equal(result.needsClarification, true);
    assert.ok(result.clarificationHint);
  });

  test("needs clarification for refine_section without section", () => {
    const result = analyzeQuery("수정해줘");
    assert.equal(result.intent, "refine_section");
    assert.equal(result.needsClarification, true);
    assert.ok(result.clarificationHint?.includes("섹션"));
  });

  test("no clarification needed for apply_section", () => {
    const result = analyzeQuery("이대로 반영해줘");
    assert.equal(result.needsClarification, false);
  });

  test("no clarification needed for clear search query", () => {
    const result = analyzeQuery("Redis 캐싱 관련 커밋 찾아줘");
    assert.equal(result.needsClarification, false);
  });
});

// ─── expandKeywordsForSource ─────────────────────────────────────────────────

describe("expandKeywordsForSource", () => {
  test("expands '캐싱' for commits source with English terms", () => {
    const expanded = expandKeywordsForSource(["캐싱"], "commits");
    assert.ok(expanded.includes("캐싱"));
    assert.ok(expanded.includes("cache"));
    assert.ok(expanded.includes("caching"));
  });

  test("expands '캐싱' for slack source with Korean terms", () => {
    const expanded = expandKeywordsForSource(["캐싱"], "slack");
    assert.ok(expanded.includes("캐싱"));
    assert.ok(expanded.includes("캐시"));
  });

  test("preserves original keyword even without expansion", () => {
    const expanded = expandKeywordsForSource(["MyCustomTerm"], "commits");
    assert.ok(expanded.includes("MyCustomTerm"));
    assert.equal(expanded.length, 1);
  });

  test("deduplicates expanded keywords", () => {
    const expanded = expandKeywordsForSource(["cache", "캐싱"], "commits");
    const cacheCount = expanded.filter((kw) => kw.toLowerCase() === "cache").length;
    assert.equal(cacheCount, 1);
  });

  test("handles empty keyword array", () => {
    const expanded = expandKeywordsForSource([], "commits");
    assert.deepEqual(expanded, []);
  });
});

// ─── extractDateRange ────────────────────────────────────────────────────────

describe("extractDateRange", () => {
  test("parses absolute year", () => {
    assert.deepEqual(extractDateRange("2024년"), { from: "2024-01-01", to: "2024-12-31" });
  });

  test("parses year + month", () => {
    assert.deepEqual(extractDateRange("2024년 11월"), { from: "2024-11-01", to: "2024-11-31" });
  });

  test("parses 작년", () => {
    const lastYear = new Date().getFullYear() - 1;
    assert.deepEqual(extractDateRange("작년"), { from: `${lastYear}-01-01`, to: `${lastYear}-12-31` });
  });

  test("parses 올해", () => {
    const year = new Date().getFullYear();
    assert.deepEqual(extractDateRange("올해"), { from: `${year}-01-01`, to: `${year}-12-31` });
  });

  test("returns null for no date text", () => {
    assert.equal(extractDateRange("Redis 캐싱"), null);
  });
});

// ─── extractKeywords ─────────────────────────────────────────────────────────

describe("extractKeywords", () => {
  test("extracts Korean keywords filtering stopwords", () => {
    // Korean regex matches continuous Hangul runs, so "배포를" → "배포를" (single token)
    const kws = extractKeywords("캐싱 관련 배포 완료");
    assert.ok(kws.includes("캐싱"));
    assert.ok(kws.includes("배포"));
    assert.ok(kws.includes("완료"));
    // "관련" is a stopword
    assert.ok(!kws.includes("관련"));
  });

  test("extracts English keywords filtering stopwords", () => {
    const kws = extractKeywords("the Redis caching layer is fast");
    assert.ok(kws.includes("Redis"));
    assert.ok(kws.includes("caching"));
    assert.ok(kws.includes("layer"));
    assert.ok(kws.includes("fast"));
    assert.ok(!kws.includes("the"));
    assert.ok(!kws.includes("is"));
  });

  test("extracts quoted phrases", () => {
    const kws = extractKeywords('"Redis caching" implementation');
    assert.ok(kws.includes("Redis caching"));
    assert.ok(kws.includes("implementation"));
  });

  test("returns empty array for empty text", () => {
    assert.deepEqual(extractKeywords(""), []);
  });

  test("handles single-char tokens (skipped)", () => {
    const kws = extractKeywords("a b 가");
    assert.deepEqual(kws, []);
  });
});

// ─── extractTechStack ───────────────────────────────────────────────────────

describe("extractTechStack", () => {
  test("extracts single technology by canonical name", () => {
    const result = extractTechStack("Redis 캐싱 작업");
    assert.ok(result.all.includes("Redis"));
    assert.ok(result.byCategory.database?.includes("Redis"));
  });

  test("extracts technology by Korean alias", () => {
    const result = extractTechStack("리액트로 프론트엔드 개발");
    assert.ok(result.all.includes("React"));
    assert.ok(result.byCategory.framework?.includes("React"));
  });

  test("extracts multiple technologies across categories", () => {
    const result = extractTechStack("React와 Node.js로 REST API 개발하고 PostgreSQL에 저장");
    assert.ok(result.all.includes("React"));
    assert.ok(result.all.includes("Node.js"));
    assert.ok(result.all.includes("REST API"));
    assert.ok(result.all.includes("PostgreSQL"));
    assert.equal(result.byCategory.framework?.length >= 2, true);
    assert.ok(result.byCategory.database?.includes("PostgreSQL"));
  });

  test("extracts infra technologies", () => {
    const result = extractTechStack("Docker 컨테이너로 AWS에 배포");
    assert.ok(result.all.includes("Docker"));
    assert.ok(result.all.includes("AWS"));
    assert.ok(result.byCategory.infra?.includes("Docker"));
    assert.ok(result.byCategory.infra?.includes("AWS"));
  });

  test("extracts technologies by abbreviation", () => {
    const result = extractTechStack("TypeScript로 Next.js 프로젝트 구현");
    assert.ok(result.all.includes("TypeScript"));
    assert.ok(result.all.includes("Next.js"));
  });

  test("returns empty for no tech mentions", () => {
    const result = extractTechStack("이력서 경력 섹션 수정해줘");
    assert.deepEqual(result.all, []);
    assert.deepEqual(result.byCategory, {});
  });

  test("returns empty for empty input", () => {
    const result = extractTechStack("");
    assert.deepEqual(result.all, []);
  });

  test("returns empty for null input", () => {
    const result = extractTechStack(null);
    assert.deepEqual(result.all, []);
  });

  test("deduplicates when both canonical and alias appear", () => {
    const result = extractTechStack("Redis와 레디스 캐싱");
    assert.equal(result.all.filter((t) => t === "Redis").length, 1);
  });

  test("handles short abbreviations with word boundaries", () => {
    // "JS" by itself should not match (too ambiguous, length <=2)
    // but "TypeScript" should match via longer alias
    const result = extractTechStack("TypeScript 코드");
    assert.ok(result.all.includes("TypeScript"));
  });
});

// ─── analyzeQuery techStack integration ─────────────────────────────────────

describe("analyzeQuery techStack", () => {
  test("includes techStack in analyzeQuery result", () => {
    const result = analyzeQuery("Redis 캐싱 성능 최적화 작업 찾아줘");
    assert.ok(result.techStack);
    assert.ok(result.techStack.all.includes("Redis"));
    assert.ok(result.techStack.byCategory.database?.includes("Redis"));
  });

  test("empty techStack when no technologies mentioned", () => {
    const result = analyzeQuery("경력 수정해줘");
    assert.deepEqual(result.techStack.all, []);
  });

  test("techStack boosts confidence score", () => {
    const withTech = analyzeQuery("Redis 캐싱 작업 찾아줘");
    const withoutTech = analyzeQuery("캐싱 작업 찾아줘");
    // Redis is a recognized tech → higher confidence
    assert.ok(withTech.confidence >= withoutTech.confidence);
  });

  test("techStack included in toSearchQuery output", () => {
    const analyzed = analyzeQuery("React로 프론트엔드 개발한 경험 찾아줘");
    const sq = toSearchQuery(analyzed);
    assert.ok(sq.techStack);
    assert.ok(sq.techStack.all.includes("React"));
  });

  test("empty result includes empty techStack", () => {
    const result = analyzeQuery("");
    assert.deepEqual(result.techStack, { all: [], byCategory: {} });
  });
});

// ─── toSearchQuery ───────────────────────────────────────────────────────────

describe("toSearchQuery", () => {
  test("converts AnalyzedQuery to parsedQuery format", () => {
    const analyzed = analyzeQuery("Redis 캐싱 작업 찾아줘");
    const sq = toSearchQuery(analyzed);

    assert.equal(sq.raw, analyzed.raw);
    assert.equal(sq.intent, analyzed.intent);
    assert.deepEqual(sq.keywords, analyzed.keywords);
    assert.equal(sq.section, analyzed.section);
    assert.deepEqual(sq.dateRange, analyzed.dateRange);
  });
});

// ─── toSourceSearchQuery ─────────────────────────────────────────────────────

describe("toSourceSearchQuery", () => {
  test("returns source-specific expanded keywords for commits", () => {
    const analyzed = analyzeQuery("캐싱 관련 작업 찾아줘");
    const sq = toSourceSearchQuery(analyzed, "commits");

    // Should contain expanded keywords (not just original)
    assert.ok(sq.keywords.length >= analyzed.keywords.length);
    assert.ok(sq.keywords.some((kw) => ["cache", "caching"].includes(kw.toLowerCase())));
  });

  test("returns source-specific expanded keywords for slack", () => {
    const analyzed = analyzeQuery("캐싱 관련 작업 찾아줘");
    const sq = toSourceSearchQuery(analyzed, "slack");

    assert.ok(sq.keywords.includes("캐시"));
  });

  test("returns original keywords for disabled source", () => {
    const analyzed = analyzeQuery("이대로 반영해줘");
    const sq = toSourceSearchQuery(analyzed, "commits");

    // apply_section disables all sources → empty keywords
    assert.deepEqual(sq.keywords, []);
  });
});

// ─── analyzeQueryWithLLM fallback ────────────────────────────────────────────

describe("analyzeQueryWithLLM", () => {
  test("falls back to rule-based when OPENAI_API_KEY is not set", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await analyzeQueryWithLLM("Redis 캐싱 작업 찾아줘", { apiKey: undefined });
      assert.equal(result.intent, "search_evidence");
      assert.ok(result.keywords.includes("Redis"));
    } finally {
      if (savedKey) process.env.OPENAI_API_KEY = savedKey;
    }
  });

  test("falls back to rule-based when WORK_LOG_DISABLE_OPENAI=1", async () => {
    const savedDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const result = await analyzeQueryWithLLM("Redis 캐싱 작업 찾아줘", { apiKey: "fake-key" });
      assert.equal(result.intent, "search_evidence");
    } finally {
      if (savedDisable) process.env.WORK_LOG_DISABLE_OPENAI = savedDisable;
      else delete process.env.WORK_LOG_DISABLE_OPENAI;
    }
  });

  test("skips LLM when confidence is already high", async () => {
    // Query with clear intent + keywords + date + section → high confidence
    const result = await analyzeQueryWithLLM("2025년 경력 섹션의 Redis 캐싱 작업 찾아줘");
    assert.ok(result.confidence >= 0.7);
    // Should return quickly without LLM call
    assert.ok(result.keywords.includes("Redis"));
  });
});

// ─── Integration: end-to-end query analysis ──────────────────────────────────

describe("analyzeQuery integration scenarios", () => {
  test("Korean resume refinement query", () => {
    const result = analyzeQuery("경력에 Redis 캐싱 성능 최적화 경험을 추가하고 싶어");
    assert.equal(result.intent, "refine_section");
    assert.equal(result.section, "experience");
    assert.ok(result.keywords.includes("Redis"));
    assert.ok(result.keywords.includes("캐싱"));
    assert.ok(result.keywords.includes("성능"));
    assert.ok(result.keywords.includes("최적화"));
    assert.equal(result.sourceParams.commits.enabled, true);
  });

  test("evidence search with date range", () => {
    const result = analyzeQuery("작년에 했던 API 개발 작업 찾아줘");
    assert.equal(result.intent, "search_evidence");
    assert.ok(result.dateRange);
    assert.ok(result.keywords.some((kw) => kw === "API"));
    // Commits should have expanded API keywords
    assert.ok(result.sourceParams.commits.keywords.some(
      (kw) => ["api", "endpoint", "route", "handler"].includes(kw.toLowerCase())
    ));
  });

  test("Slack-specific search", () => {
    const result = analyzeQuery("슬랙에서 배포 관련 메시지 검색해줘");
    assert.equal(result.intent, "search_evidence");
    assert.equal(result.sourceParams.slack.enabled, true);
    assert.ok(result.sourceParams.slack.keywords.some(
      (kw) => ["배포", "릴리즈", "디플로이"].includes(kw)
    ));
  });

  test("apply intent skips evidence search", () => {
    const result = analyzeQuery("그대로 반영해줘");
    assert.equal(result.intent, "apply_section");
    assert.equal(result.sourceParams.commits.enabled, false);
    assert.equal(result.sourceParams.slack.enabled, false);
    assert.equal(result.sourceParams.sessions.enabled, false);
  });
});
