/**
 * resumeChatApplySections.test.mjs
 *
 * Unit tests for Sub-AC 5-2: 파싱된 변경 내용을 이력서 JSON 섹션에 적용하는 로직.
 *
 * Run with:
 *   node --test src/lib/resumeChatApplySections.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyChatChangesToResume,
  buildSectionDiff,
} from "./resumeChatApplySections.mjs";

// ── 테스트 픽스처 ──────────────────────────────────────────────────────────────

/** 기본 이력서 문서 (테스트용) */
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
    _sources: { summary: "system", contact: "system" },
    ...overrides,
  };
}

// ── applyChatChangesToResume — 기본 동작 ─────────────────────────────────────

test("applyChatChangesToResume - section 이 null 이면 원본 그대로 반환", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    detected: true,
    section: null,
    changes: [{ type: "bullet", content: "새로운 내용" }],
    confidence: 0.5,
    ambiguous: true,
    clarificationNeeded: "어떤 섹션에 반영할까요?",
    sourceMessageIndex: -1,
  });
  assert.equal(result.updatedDoc, doc, "원본 문서 그대로 반환");
  assert.equal(result.diff, null, "diff 없음");
  assert.equal(result.appliedChanges.length, 0, "appliedChanges 없음");
  assert.equal(result.skippedChanges.length, 1, "skippedChanges 1개");
  assert.ok(result.skippedChanges[0].reason.includes("섹션"), "사유에 섹션 언급");
});

test("applyChatChangesToResume - changes 가 빈 배열이면 원본 그대로 반환", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    detected: true,
    section: "experience",
    changes: [],
    confidence: 0.9,
    ambiguous: false,
    clarificationNeeded: null,
    sourceMessageIndex: -1,
  });
  assert.equal(result.updatedDoc, doc);
  assert.equal(result.diff, null);
  assert.equal(result.appliedChanges.length, 0);
});

test("applyChatChangesToResume - 원본 문서를 변경하지 않는다 (불변성)", () => {
  const doc = makeResume();
  const originalSummary = doc.summary;
  applyChatChangesToResume(doc, {
    detected: true,
    section: "summary",
    changes: [{ type: "text", content: "새로운 자기소개" }],
    confidence: 0.9,
    ambiguous: false,
    clarificationNeeded: null,
    sourceMessageIndex: -1,
  });
  assert.equal(doc.summary, originalSummary, "원본 문서가 변경되지 않아야 한다");
});

test("applyChatChangesToResume - 잘못된 resumeDoc 은 에러를 던진다", () => {
  assert.throws(
    () => applyChatChangesToResume(null, { section: "summary", changes: [] }),
    /resumeDoc.*객체/
  );
});

// ── summary 섹션 ─────────────────────────────────────────────────────────────

test("summary - 텍스트 변경이 요약을 교체한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "summary",
    changes: [{ type: "text", content: "10년 경력의 풀스택 개발자입니다." }],
  });

  assert.equal(result.updatedDoc.summary, "10년 경력의 풀스택 개발자입니다.", "요약 교체");
  assert.equal(result.updatedDoc._sources.summary, "user_approved", "_sources.summary user_approved");
  assert.equal(result.appliedChanges.length, 1);
  assert.equal(result.appliedChanges[0].type, "replace_summary");
  assert.ok(result.diff !== null, "diff 생성");
  assert.equal(result.diff.section, "summary");
  assert.ok(result.diff.before.includes("5년 경력"), "diff.before 에 기존 요약 포함");
  assert.ok(result.diff.after.includes("10년 경력"), "diff.after 에 새 요약 포함");
});

test("summary - 여러 변경은 줄바꿈으로 합친다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "summary",
    changes: [
      { type: "bullet", content: "10년 경력의 풀스택 개발자" },
      { type: "bullet", content: "스타트업 CTO 경험 보유" },
    ],
  });

  assert.ok(result.updatedDoc.summary.includes("10년 경력"), "첫 번째 내용 포함");
  assert.ok(result.updatedDoc.summary.includes("CTO"), "두 번째 내용 포함");
});

// ── skills 섹션 ──────────────────────────────────────────────────────────────

test("skills - 새 기술을 technical 에 추가한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "skills",
    changes: [{ type: "bullet", content: "Python" }],
  });

  assert.ok(result.updatedDoc.skills.technical.includes("Python"), "Python 추가");
  assert.equal(result.updatedDoc._sources.skills, "user_approved");
  assert.equal(result.appliedChanges.length, 1);
  assert.equal(result.appliedChanges[0].type, "add_technical_skill");
  assert.ok(result.diff !== null, "diff 생성");
  assert.ok(result.diff.after.includes("Python"), "diff.after 에 Python 포함");
});

test("skills - 이미 존재하는 기술은 skipped 처리한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "skills",
    changes: [{ type: "bullet", content: "Node.js" }],  // 이미 있음
  });

  assert.equal(result.appliedChanges.length, 0, "변경 없음");
  assert.equal(result.skippedChanges.length, 1, "스킵 1개");
  assert.ok(result.skippedChanges[0].reason.includes("이미"), "중복 사유");
});

test("skills - 중복 검사는 대소문자를 무시한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "skills",
    changes: [{ type: "bullet", content: "node.js" }],  // 소문자
  });

  assert.equal(result.appliedChanges.length, 0, "대소문자 무시 중복");
  assert.equal(result.skippedChanges.length, 1);
});

test("skills - 쉼표로 구분된 여러 기술을 한번에 추가한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "skills",
    changes: [{ type: "bullet", content: "Python, Go, Rust" }],
  });

  assert.equal(result.appliedChanges.length, 3, "3개 기술 추가");
  assert.ok(result.updatedDoc.skills.technical.includes("Python"));
  assert.ok(result.updatedDoc.skills.technical.includes("Go"));
  assert.ok(result.updatedDoc.skills.technical.includes("Rust"));
});

test("skills - context 에 '언어' 가 있으면 languages 로 분류한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "skills",
    changes: [{ type: "bullet", content: "Python", context: "프로그래밍 언어" }],
  });

  assert.ok(result.updatedDoc.skills.languages.includes("Python"), "languages 에 추가");
  assert.ok(!result.updatedDoc.skills.technical.includes("Python"), "technical 에 없음");
  assert.equal(result.appliedChanges[0].type, "add_languages_skill");
});

test("skills - context 에 'tool' 이 있으면 tools 로 분류한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "skills",
    changes: [{ type: "bullet", content: "Figma", context: "디자인 tool" }],
  });

  assert.ok(result.updatedDoc.skills.tools.includes("Figma"), "tools 에 추가");
  assert.equal(result.appliedChanges[0].type, "add_tools_skill");
});

// ── experience 섹션 ──────────────────────────────────────────────────────────

test("experience - 불릿을 가장 최근 경력 항목에 추가한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "experience",
    changes: [{ type: "bullet", content: "마이크로서비스 아키텍처 도입" }],
  });

  const exp = result.updatedDoc.experience;
  assert.ok(exp[0].bullets.includes("마이크로서비스 아키텍처 도입"), "가장 최근 항목에 추가");
  assert.equal(exp[0]._source, "user_approved", "_source user_approved");
  assert.equal(result.appliedChanges.length, 1);
  assert.equal(result.appliedChanges[0].type, "append_bullet");
  assert.ok(result.appliedChanges[0].targetHint?.includes("테크컴퍼니"), "회사명 포함");
});

test("experience - context 로 회사를 지정하면 해당 항목에 추가한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "experience",
    changes: [{ type: "bullet", content: "레거시 코드 리팩토링", context: "스타트업A" }],
  });

  const exp = result.updatedDoc.experience;
  assert.ok(exp[1].bullets.includes("레거시 코드 리팩토링"), "스타트업A 항목에 추가");
  assert.ok(!exp[0].bullets.includes("레거시 코드 리팩토링"), "테크컴퍼니에는 추가되지 않음");
});

test("experience - context 가 매칭 안 되면 가장 최근(index 0) 항목에 추가한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "experience",
    changes: [{ type: "bullet", content: "새로운 불릿", context: "없는회사" }],
  });

  assert.ok(result.updatedDoc.experience[0].bullets.includes("새로운 불릿"));
});

test("experience - 중복 불릿은 skipped 처리한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "experience",
    changes: [{ type: "bullet", content: "Node.js 기반 REST API 설계 및 개발" }],  // 이미 있음
  });

  assert.equal(result.appliedChanges.length, 0, "변경 없음");
  assert.equal(result.skippedChanges.length, 1, "스킵 1개");
  assert.ok(result.skippedChanges[0].reason.includes("이미"), "중복 사유");
});

test("experience - 항목이 없으면 모두 skipped 처리한다", () => {
  const doc = makeResume({ experience: [] });
  const result = applyChatChangesToResume(doc, {
    section: "experience",
    changes: [{ type: "bullet", content: "새로운 불릿" }],
  });

  assert.equal(result.appliedChanges.length, 0);
  assert.equal(result.skippedChanges.length, 1);
  assert.ok(result.skippedChanges[0].reason.includes("항목이 없습니다"), "사유 확인");
});

test("experience - diff 에 before/after 텍스트가 포함된다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "experience",
    changes: [{ type: "bullet", content: "클라우드 마이그레이션" }],
  });

  assert.ok(result.diff !== null);
  assert.equal(result.diff.section, "experience");
  assert.ok(result.diff.before.includes("테크컴퍼니"), "before 에 회사명 포함");
  assert.ok(result.diff.after.includes("클라우드 마이그레이션"), "after 에 새 불릿 포함");
});

// ── projects 섹션 ────────────────────────────────────────────────────────────

test("projects - 불릿을 가장 최근 프로젝트에 추가한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "projects",
    changes: [{ type: "bullet", content: "API 응답 시간 40% 단축" }],
  });

  assert.ok(result.updatedDoc.projects[0].bullets.includes("API 응답 시간 40% 단축"));
  assert.equal(result.updatedDoc.projects[0]._source, "user_approved");
});

test("projects - context 로 프로젝트명 지정", () => {
  const doc = makeResume({
    projects: [
      { _source: "system", name: "work-log", bullets: ["기능 A"] },
      { _source: "system", name: "portfolio", bullets: ["기능 B"] },
    ],
  });
  const result = applyChatChangesToResume(doc, {
    section: "projects",
    changes: [{ type: "bullet", content: "새 기능", context: "portfolio" }],
  });

  assert.ok(result.updatedDoc.projects[1].bullets.includes("새 기능"), "portfolio 에 추가");
  assert.ok(!result.updatedDoc.projects[0].bullets.includes("새 기능"), "work-log 에 없음");
});

// ── education 섹션 ───────────────────────────────────────────────────────────

test("education - 불릿을 첫 번째 학력 항목에 추가한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "education",
    changes: [{ type: "bullet", content: "졸업논문 우수상 수상" }],
  });

  assert.ok(result.updatedDoc.education[0].bullets.includes("졸업논문 우수상 수상"));
  assert.equal(result.updatedDoc.education[0]._source, "user_approved");
});

// ── buildSectionDiff ─────────────────────────────────────────────────────────

test("buildSectionDiff - null 입력 처리", () => {
  assert.equal(buildSectionDiff(null, "summary", []), null);
  assert.equal(buildSectionDiff(makeResume(), null, []), null);
  assert.equal(buildSectionDiff(makeResume(), "summary", []), null);
});

test("buildSectionDiff - summary diff 반환", () => {
  const doc = makeResume();
  const diff = buildSectionDiff(doc, "summary", [
    { type: "text", content: "새로운 요약 텍스트" },
  ]);

  assert.ok(diff !== null);
  assert.equal(diff.section, "summary");
  assert.ok(typeof diff.before === "string");
  assert.ok(typeof diff.after === "string");
  assert.ok(diff.before.includes("5년 경력"), "before 기존 요약");
  assert.ok(diff.after.includes("새로운 요약"), "after 새 요약");
});

test("buildSectionDiff - skills diff 에 after 텍스트 포함", () => {
  const doc = makeResume();
  const diff = buildSectionDiff(doc, "skills", [
    { type: "bullet", content: "Kubernetes" },
  ]);

  assert.ok(diff !== null);
  assert.ok(diff.after.includes("Kubernetes"), "after 에 새 기술 포함");
});

test("buildSectionDiff - skills after 텍스트는 '- skill' 불릿 형식 (PATCH 호환)", () => {
  // '- skill' 형식이어야 PATCH /api/resume/section 의 _parseSkillLines 가
  // 올바르게 파싱한다. "technical: skill" 형식은 'technical: skill' 전체를
  // 하나의 기술명으로 잘못 해석하므로 사용하지 않는다.
  const doc = makeResume();
  const diff = buildSectionDiff(doc, "skills", [
    { type: "bullet", content: "Kubernetes" },
  ]);

  assert.ok(diff !== null);
  // 각 기술은 "- " 접두사로 시작해야 한다
  const afterLines = diff.after.split("\n").filter(Boolean);
  for (const line of afterLines) {
    assert.ok(line.startsWith("- "), `after 줄이 '- ' 로 시작해야 함: "${line}"`);
  }
  // 카테고리 접두사 ("technical:", "languages:", "tools:") 가 없어야 한다
  assert.ok(!diff.after.includes("technical:"), "카테고리 접두사 없음");
  assert.ok(!diff.after.includes("languages:"), "카테고리 접두사 없음");
  assert.ok(!diff.after.includes("tools:"), "카테고리 접두사 없음");
});

test("buildSectionDiff - evidence 배열은 context 에서 추출한다", () => {
  const doc = makeResume();
  const diff = buildSectionDiff(doc, "experience", [
    { type: "bullet", content: "마이크로서비스 도입", context: "2024년 Q1" },
    { type: "bullet", content: "성능 최적화", context: "2024년 Q1" },  // 중복 context
    { type: "bullet", content: "신규 기능 배포", context: "2024년 Q2" },
  ]);

  assert.ok(diff !== null);
  assert.ok(Array.isArray(diff.evidence));
  // 중복 context 가 제거되어야 한다
  const uniqueContexts = [...new Set(["2024년 Q1", "2024년 Q2"])];
  assert.equal(diff.evidence.length, uniqueContexts.length, "중복 context 제거");
  assert.ok(diff.evidence.includes("2024년 Q1"));
  assert.ok(diff.evidence.includes("2024년 Q2"));
});

// ── 복수 변경 적용 ────────────────────────────────────────────────────────────

test("experience - 여러 불릿을 한번에 추가한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "experience",
    changes: [
      { type: "bullet", content: "CI/CD 파이프라인 구축" },
      { type: "bullet", content: "테스트 커버리지 80% 달성" },
    ],
  });

  const bullets = result.updatedDoc.experience[0].bullets;
  assert.ok(bullets.includes("CI/CD 파이프라인 구축"), "첫 번째 불릿 추가");
  assert.ok(bullets.includes("테스트 커버리지 80% 달성"), "두 번째 불릿 추가");
  assert.equal(result.appliedChanges.length, 2);
});

test("experience - 일부 중복 + 일부 신규 혼재 시 신규만 추가된다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "experience",
    changes: [
      { type: "bullet", content: "Node.js 기반 REST API 설계 및 개발" },  // 중복
      { type: "bullet", content: "Kubernetes 클러스터 관리" },             // 신규
    ],
  });

  assert.equal(result.appliedChanges.length, 1, "신규 1개만 추가");
  assert.equal(result.skippedChanges.length, 1, "중복 1개 스킵");
  assert.ok(
    result.updatedDoc.experience[0].bullets.includes("Kubernetes 클러스터 관리")
  );
});

// ── 지원하지 않는 섹션 ────────────────────────────────────────────────────────

test("지원하지 않는 섹션은 모두 skipped 처리한다", () => {
  const doc = makeResume();
  const result = applyChatChangesToResume(doc, {
    section: "unknownSection",
    changes: [{ type: "bullet", content: "테스트" }],
  });

  assert.equal(result.appliedChanges.length, 0);
  assert.equal(result.skippedChanges.length, 1);
  assert.ok(result.skippedChanges[0].reason.includes("지원하지 않는 섹션"));
});
