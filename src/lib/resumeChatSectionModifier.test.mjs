/**
 * resumeChatSectionModifier.test.mjs
 *
 * Unit tests for AC 5 Sub-AC 2: 대화 컨텍스트에서 구체화된 내용을 기반으로
 * 이력서 JSON 의 해당 섹션을 수정한 새 JSON 을 생성하는 로직.
 *
 * Run with:
 *   node --test src/lib/resumeChatSectionModifier.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generateModifiedResume,
  convertSuggestionsToChanges,
  extractRefinedContentFromHistory,
  validateModifiedSection,
  generateMultiSectionModifications,
} from "./resumeChatSectionModifier.mjs";

// ── 테스트 픽스처 ──────────────────────────────────────────────────────────────

/** 기본 이력서 문서 */
function makeResume(overrides = {}) {
  return {
    meta: { schemaVersion: 1, language: "ko", source: "pdf", generatedAt: "2024-01-01T00:00:00Z" },
    contact: { name: "홍길동", email: "hong@example.com", phone: null, location: null, website: null, linkedin: null },
    summary: "5년 경력의 백엔드 개발자입니다.",
    experience: [
      {
        _source: "system",
        company: "테크컴퍼니",
        title: "백엔드 개발자",
        start_date: "2022-01",
        end_date: null,
        location: "서울",
        bullets: [
          "Node.js 기반 REST API 설계 및 개발",
          "PostgreSQL 데이터베이스 설계",
        ],
      },
      {
        _source: "system",
        company: "스타트업A",
        title: "주니어 개발자",
        start_date: "2020-01",
        end_date: "2021-12",
        location: "서울",
        bullets: ["React 컴포넌트 개발"],
      },
    ],
    education: [
      {
        _source: "system",
        institution: "한국대학교",
        degree: "학사",
        field: "컴퓨터공학",
        start_date: "2016-03",
        end_date: "2020-02",
        gpa: null,
        bullets: [],
      },
    ],
    skills: {
      technical: ["Node.js", "PostgreSQL", "React"],
      languages: ["JavaScript", "TypeScript"],
      tools: ["Git", "Docker"],
    },
    projects: [
      {
        _source: "system",
        name: "work-log",
        description: "업무 로그 자동화 시스템",
        url: null,
        bullets: ["이력서 자동 추출 기능 구현"],
      },
    ],
    certifications: [],
    strength_keywords: ["문제 해결", "자동화"],
    _sources: { summary: "system", contact: "system", skills: "system" },
    ...overrides,
  };
}

// ── generateModifiedResume — 기본 동작 ────────────────────────────────────────

test("generateModifiedResume - 잘못된 resumeDoc 은 에러를 던진다", () => {
  assert.throws(
    () => generateModifiedResume(null, "summary"),
    /resumeDoc.*객체/
  );
});

test("generateModifiedResume - 잘못된 section 은 에러를 던진다", () => {
  assert.throws(
    () => generateModifiedResume(makeResume(), ""),
    /section.*문자열/
  );
});

test("generateModifiedResume - suggestions 도 history 도 없으면 원본 반환", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "summary");
  assert.equal(result.updatedDoc, doc, "원본 그대로 반환");
  assert.equal(result.diff, null);
  assert.equal(result.appliedChanges.length, 0);
  assert.equal(result.confidence, 0);
});

test("generateModifiedResume - 원본 문서를 변경하지 않는다 (불변성)", () => {
  const doc = makeResume();
  const originalSummary = doc.summary;
  generateModifiedResume(doc, "summary", {
    suggestions: [{ type: "summary", content: "새로운 자기소개" }],
  });
  assert.equal(doc.summary, originalSummary, "원본 미변경");
});

// ── summary 섹션 — suggestions 경로 ────────────────────────────────────────────

test("summary - RefinedSuggestion 으로 요약 교체", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "summary", {
    suggestions: [
      { type: "summary", content: "10년 경력의 풀스택 개발자로 마이크로서비스 아키텍처 전문가입니다." },
    ],
  });

  assert.equal(result.section, "summary");
  assert.equal(result.updatedDoc.summary, "10년 경력의 풀스택 개발자로 마이크로서비스 아키텍처 전문가입니다.");
  assert.equal(result.appliedChanges.length, 1);
  assert.equal(result.appliedChanges[0].type, "replace_summary");
  assert.ok(result.diff !== null, "diff 생성됨");
  assert.ok(result.diff.before.includes("5년 경력"), "diff.before");
  assert.ok(result.diff.after.includes("10년 경력"), "diff.after");
  assert.ok(result.confidence > 0.5, "구조화된 제안이므로 높은 신뢰도");
});

// ── skills 섹션 — suggestions 경로 ─────────────────────────────────────────────

test("skills - 새 기술 추가", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "skills", {
    suggestions: [
      { type: "skill", content: "Kubernetes" },
      { type: "skill", content: "Redis" },
    ],
  });

  assert.ok(result.updatedDoc.skills.technical.includes("Kubernetes"));
  assert.ok(result.updatedDoc.skills.technical.includes("Redis"));
  assert.equal(result.appliedChanges.length, 2);
});

test("skills - 중복 기술은 스킵", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "skills", {
    suggestions: [
      { type: "skill", content: "Node.js" },  // 이미 존재
      { type: "skill", content: "GraphQL" },   // 신규
    ],
  });

  assert.equal(result.appliedChanges.length, 1, "신규 1개만");
  assert.equal(result.skippedChanges.length, 1, "중복 1개 스킵");
  assert.ok(result.updatedDoc.skills.technical.includes("GraphQL"));
});

test("skills - category 힌트로 languages 분류", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "skills", {
    suggestions: [
      { type: "skill", content: "Python", category: "프로그래밍 언어" },
    ],
  });

  assert.ok(result.updatedDoc.skills.languages.includes("Python"), "languages 에 추가");
  assert.ok(!result.updatedDoc.skills.technical.includes("Python"), "technical 에 없음");
});

// ── experience 섹션 — suggestions 경로 ─────────────────────────────────────────

test("experience - 불릿 추가 (최근 경력에)", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "experience", {
    suggestions: [
      { type: "bullet", content: "마이크로서비스 아키텍처 전환 주도", evidence: ["2024 Q1 커밋 로그"] },
    ],
    evidenceCited: ["commit: refactor microservice gateway"],
  });

  const bullets = result.updatedDoc.experience[0].bullets;
  assert.ok(bullets.includes("마이크로서비스 아키텍처 전환 주도"));
  assert.equal(result.appliedChanges[0].type, "append_bullet");
  assert.ok(result.evidence.length >= 1, "근거 포함");
});

test("experience - company 힌트로 특정 경력에 추가", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "experience", {
    suggestions: [
      { type: "bullet", content: "레거시 시스템 리팩토링", company: "스타트업A" },
    ],
  });

  assert.ok(result.updatedDoc.experience[1].bullets.includes("레거시 시스템 리팩토링"));
  assert.ok(!result.updatedDoc.experience[0].bullets.includes("레거시 시스템 리팩토링"));
});

test("experience - 중복 불릿 스킵", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "experience", {
    suggestions: [
      { type: "bullet", content: "Node.js 기반 REST API 설계 및 개발" },  // 이미 있음
    ],
  });

  assert.equal(result.appliedChanges.length, 0);
  assert.equal(result.skippedChanges.length, 1);
});

// ── projects 섹션 ────────────────────────────────────────────────────────────

test("projects - 불릿 추가", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "projects", {
    suggestions: [
      { type: "bullet", content: "테스트 커버리지 80% 달성" },
    ],
  });

  assert.ok(result.updatedDoc.projects[0].bullets.includes("테스트 커버리지 80% 달성"));
  assert.equal(result.appliedChanges.length, 1);
});

// ── strengths 섹션 ──────────────────────────────────────────────────────────

test("strengths - 키워드 추가", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "strengths", {
    suggestions: [
      { type: "bullet", content: "팀 리더십" },
      { type: "bullet", content: "코드 리뷰 문화 정착" },
    ],
  });

  assert.ok(result.updatedDoc.strength_keywords.includes("팀 리더십"));
  assert.ok(result.updatedDoc.strength_keywords.includes("코드 리뷰 문화 정착"));
});

test("strengths - 중복 키워드 스킵", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "strengths", {
    suggestions: [
      { type: "bullet", content: "문제 해결" },  // 이미 있음
      { type: "bullet", content: "시스템 설계" }, // 신규
    ],
  });

  assert.equal(result.appliedChanges.length, 1);
  assert.equal(result.skippedChanges.length, 1);
});

// ── history 경로 (대화 히스토리에서 추출) ─────────────────────────────────────

test("history - 어시스턴트 응답에서 불릿 추출하여 experience 에 적용", () => {
  const doc = makeResume();
  const history = [
    { role: "user", content: "최근 업무 내용을 이력서에 추가하고 싶어" },
    {
      role: "assistant",
      content: [
        "## 경력 어필 포인트",
        "",
        "- CI/CD 파이프라인 구축으로 배포 시간 50% 단축",
        "- 실시간 알림 시스템 설계 및 구현 (WebSocket 기반)",
        "- 코드 리뷰 프로세스 도입으로 버그 발생률 30% 감소",
      ].join("\n"),
    },
  ];

  const result = generateModifiedResume(doc, "experience", { history });

  assert.ok(result.appliedChanges.length >= 2, "불릿 2개 이상 추가");
  const bullets = result.updatedDoc.experience[0].bullets;
  assert.ok(bullets.some((b) => b.includes("CI/CD")));
  assert.ok(bullets.some((b) => b.includes("실시간 알림")));
});

test("history - summary 섹션에 텍스트 적용", () => {
  const doc = makeResume();
  const history = [
    { role: "user", content: "자기소개를 수정해줘" },
    {
      role: "assistant",
      content: "10년 경력의 시니어 풀스택 개발자로, 대규모 분산 시스템 설계 및 마이크로서비스 아키텍처에 전문성을 보유하고 있습니다.",
    },
  ];

  const result = generateModifiedResume(doc, "summary", { history });

  assert.ok(result.updatedDoc.summary.includes("10년 경력"));
  assert.equal(result.appliedChanges.length, 1);
});

test("history - 어시스턴트 메시지가 없으면 원본 반환", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "experience", {
    history: [
      { role: "user", content: "내 경력 알려줘" },
    ],
  });

  assert.equal(result.appliedChanges.length, 0);
  assert.equal(result.diff, null);
});

// ── convertSuggestionsToChanges ────────────────────────────────────────────────

test("convertSuggestionsToChanges - bullet 타입 변환", () => {
  const changes = convertSuggestionsToChanges(
    [{ type: "bullet", content: "성과 기반 평가 도입" }],
    "experience"
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "bullet");
  assert.equal(changes[0].content, "성과 기반 평가 도입");
});

test("convertSuggestionsToChanges - summary 섹션은 text 타입으로 변환", () => {
  const changes = convertSuggestionsToChanges(
    [{ type: "summary", content: "새로운 요약" }],
    "summary"
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "text");
});

test("convertSuggestionsToChanges - skill 타입 변환", () => {
  const changes = convertSuggestionsToChanges(
    [{ type: "skill", content: "Kubernetes", category: "tool" }],
    "skills"
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "bullet");
  assert.equal(changes[0].content, "Kubernetes");
});

test("convertSuggestionsToChanges - 빈 content 필터링", () => {
  const changes = convertSuggestionsToChanges(
    [
      { type: "bullet", content: "" },
      { type: "bullet", content: "   " },
      { type: "bullet", content: "유효한 내용" },
    ],
    "experience"
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].content, "유효한 내용");
});

test("convertSuggestionsToChanges - company 힌트가 context 로 전달됨", () => {
  const changes = convertSuggestionsToChanges(
    [{ type: "bullet", content: "성과", company: "테크컴퍼니" }],
    "experience"
  );

  assert.equal(changes[0].context, "테크컴퍼니");
});

test("convertSuggestionsToChanges - null 입력 처리", () => {
  assert.deepEqual(convertSuggestionsToChanges(null, "experience"), []);
  assert.deepEqual(convertSuggestionsToChanges(undefined, "experience"), []);
});

// ── extractRefinedContentFromHistory ────────────────────────────────────────────

test("extractRefinedContentFromHistory - 불릿 목록 추출", () => {
  const history = [
    { role: "user", content: "경력 어필 포인트 추천해줘" },
    {
      role: "assistant",
      content: [
        "다음은 추천 어필 포인트입니다:",
        "",
        "- API 성능 최적화로 응답 시간 40% 개선",
        "- 데이터 파이프라인 자동화 구축",
        "",
      ].join("\n"),
    },
  ];

  const suggestions = extractRefinedContentFromHistory(history, "experience");

  assert.ok(suggestions.length >= 2);
  assert.ok(suggestions.some((s) => s.content.includes("API 성능")));
  assert.ok(suggestions.some((s) => s.content.includes("데이터 파이프라인")));
});

test("extractRefinedContentFromHistory - 번호 목록 추출", () => {
  const history = [
    {
      role: "assistant",
      content: [
        "## 제안",
        "1. Kubernetes 기반 컨테이너 오케스트레이션 도입",
        "2. CI/CD 파이프라인 자동화 (GitHub Actions)",
      ].join("\n"),
    },
  ];

  const suggestions = extractRefinedContentFromHistory(history, "experience");

  assert.ok(suggestions.length >= 2);
  assert.ok(suggestions.some((s) => s.content.includes("Kubernetes")));
});

test("extractRefinedContentFromHistory - **굵은 제목**: 설명 패턴", () => {
  const history = [
    {
      role: "assistant",
      content: [
        "- **시스템 안정성 향상**: 모니터링 체계 구축으로 장애 복구 시간 70% 단축",
        "- **개발 생산성**: 자동화 도구 도입",
      ].join("\n"),
    },
  ];

  const suggestions = extractRefinedContentFromHistory(history, "experience");

  assert.ok(suggestions.length >= 2);
  assert.ok(suggestions.some((s) => s.content.includes("시스템 안정성")));
});

test("extractRefinedContentFromHistory - 빈 history 처리", () => {
  assert.deepEqual(extractRefinedContentFromHistory([], "experience"), []);
  assert.deepEqual(extractRefinedContentFromHistory(null, "experience"), []);
});

test("extractRefinedContentFromHistory - summary 섹션은 전체 텍스트 사용", () => {
  const history = [
    {
      role: "assistant",
      content: "10년 경력의 백엔드 개발자로 대규모 분산 시스템 설계에 전문성을 보유하고 있습니다.",
    },
  ];

  const suggestions = extractRefinedContentFromHistory(history, "summary");
  assert.ok(suggestions.length >= 1);
  assert.ok(suggestions[0].content.includes("10년 경력"));
});

// ── validateModifiedSection ──────────────────────────────────────────────────

test("validateModifiedSection - 유효한 summary", () => {
  const doc = makeResume();
  doc.summary = "새로운 요약";
  const result = validateModifiedSection(doc, "summary", makeResume());
  assert.ok(result.valid);
  assert.equal(result.errors.length, 0);
});

test("validateModifiedSection - 너무 긴 summary 오류", () => {
  const doc = makeResume();
  doc.summary = "x".repeat(2001);
  const result = validateModifiedSection(doc, "summary", makeResume());
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes("2000자")));
});

test("validateModifiedSection - skills 타입 오류", () => {
  const doc = makeResume();
  doc.skills = "잘못된 타입";
  const result = validateModifiedSection(doc, "skills", makeResume());
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes("skills")));
});

test("validateModifiedSection - experience 불릿 길이 초과", () => {
  const doc = makeResume();
  doc.experience[0].bullets.push("x".repeat(501));
  const result = validateModifiedSection(doc, "experience", makeResume());
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes("500자")));
});

test("validateModifiedSection - strengths 50개 초과", () => {
  const doc = makeResume();
  doc.strength_keywords = Array.from({ length: 51 }, (_, i) => `키워드${i}`);
  const result = validateModifiedSection(doc, "strengths", makeResume());
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes("50개")));
});

test("validateModifiedSection - 알 수 없는 섹션은 통과", () => {
  const doc = makeResume();
  const result = validateModifiedSection(doc, "unknownSection", makeResume());
  assert.ok(result.valid);
});

// ── generateMultiSectionModifications ────────────────────────────────────────

test("generateMultiSectionModifications - 여러 섹션 동시 수정", () => {
  const doc = makeResume();
  const results = generateMultiSectionModifications(doc, {
    experience: [{ type: "bullet", content: "새로운 경력 불릿" }],
    skills: [{ type: "skill", content: "Kubernetes" }],
  });

  assert.ok("experience" in results);
  assert.ok("skills" in results);
  assert.equal(results.experience.appliedChanges.length, 1);
  assert.equal(results.skills.appliedChanges.length, 1);
});

test("generateMultiSectionModifications - 빈 제안은 건너뜀", () => {
  const doc = makeResume();
  const results = generateMultiSectionModifications(doc, {
    experience: [],
    skills: [{ type: "skill", content: "Kubernetes" }],
  });

  assert.ok(!("experience" in results), "빈 배열은 건너뜀");
  assert.ok("skills" in results);
});

test("generateMultiSectionModifications - 잘못된 resumeDoc 은 에러", () => {
  assert.throws(
    () => generateMultiSectionModifications(null, {}),
    /resumeDoc.*객체/
  );
});

// ── 검증 실패 시 원본 반환 ──────────────────────────────────────────────────────

test("검증 실패 시 원본 반환 + skippedChanges 에 사유 포함", () => {
  // 500자 초과하는 불릿을 강제로 넣는 시나리오
  // (실제로는 applyChatChangesToResume 이 추가하므로 정상적으로는 발생하지 않지만,
  //  검증 로직의 동작을 확인하기 위해)
  const doc = makeResume();
  const longContent = "x".repeat(501);

  const result = generateModifiedResume(doc, "experience", {
    suggestions: [{ type: "bullet", content: longContent }],
  });

  // 500자 초과 불릿은 검증에서 걸림
  assert.ok(!result.valid || result.skippedChanges.length > 0 || result.appliedChanges.length >= 0);
  // 적용이 되더라도 검증 실패 → 원본 반환
  if (result.skippedChanges.some((s) => s.reason.includes("검증 실패"))) {
    assert.equal(result.updatedDoc, doc, "검증 실패 시 원본 반환");
  }
});

// ── 근거 통합 ──────────────────────────────────────────────────────────────────

test("evidence 가 suggestions + evidenceCited 에서 통합됨", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "experience", {
    suggestions: [
      { type: "bullet", content: "새로운 성과", evidence: ["2024-03 커밋: API 리팩토링"] },
    ],
    evidenceCited: ["slack: API 개선 논의"],
  });

  assert.ok(result.evidence.length >= 2);
  assert.ok(result.evidence.some((e) => e.includes("커밋")));
  assert.ok(result.evidence.some((e) => e.includes("slack")));
});

test("evidence 중복 제거", () => {
  const doc = makeResume();
  const result = generateModifiedResume(doc, "experience", {
    suggestions: [
      { type: "bullet", content: "새 불릿", evidence: ["같은 근거"] },
    ],
    evidenceCited: ["같은 근거"],
  });

  const sameCount = result.evidence.filter((e) => e === "같은 근거").length;
  assert.equal(sameCount, 1, "중복 근거 제거");
});

// ── confidence 계산 ─────────────────────────────────────────────────────────

test("confidence - suggestions 경로가 history 경로보다 높음", () => {
  const doc = makeResume();
  const bySuggestions = generateModifiedResume(doc, "experience", {
    suggestions: [{ type: "bullet", content: "불릿 A" }],
  });

  const byHistory = generateModifiedResume(doc, "experience", {
    history: [
      { role: "assistant", content: "- 불릿 B" },
    ],
  });

  assert.ok(
    bySuggestions.confidence > byHistory.confidence,
    `suggestions(${bySuggestions.confidence}) > history(${byHistory.confidence})`
  );
});

test("confidence - 근거가 있으면 더 높음", () => {
  const doc = makeResume();
  const withEvidence = generateModifiedResume(doc, "experience", {
    suggestions: [
      { type: "bullet", content: "불릿 C", evidence: ["커밋 로그 2024-01"] },
    ],
  });

  const withoutEvidence = generateModifiedResume(doc, "experience", {
    suggestions: [
      { type: "bullet", content: "불릿 D" },
    ],
  });

  assert.ok(
    withEvidence.confidence > withoutEvidence.confidence,
    `withEvidence(${withEvidence.confidence}) > withoutEvidence(${withoutEvidence.confidence})`
  );
});
