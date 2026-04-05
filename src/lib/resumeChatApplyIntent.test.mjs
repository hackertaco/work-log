/**
 * resumeChatApplyIntent.test.mjs
 *
 * Unit tests for Sub-AC 5-1: "반영해줘" 의도 감지 및 컨텍스트 파싱.
 *
 * Run with:
 *   node --test src/lib/resumeChatApplyIntent.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectApplyIntent,
  extractSectionFromContext,
  extractProposedChanges,
  parseApplyIntent,
} from "./resumeChatApplyIntent.mjs";

// ─── detectApplyIntent ───────────────────────────────────────────────────────

test("detectApplyIntent - '반영해줘' 감지", () => {
  assert.equal(detectApplyIntent("반영해줘"), true);
  assert.equal(detectApplyIntent("이대로 반영해줘"), true);
  assert.equal(detectApplyIntent("반영해주세요"), true);
  assert.equal(detectApplyIntent("이 내용으로 반영해줘"), true);
});

test("detectApplyIntent - '적용해줘' 감지", () => {
  assert.equal(detectApplyIntent("적용해줘"), true);
  assert.equal(detectApplyIntent("적용해주세요"), true);
  assert.equal(detectApplyIntent("이대로 적용해줘"), true);
});

test("detectApplyIntent - '이걸로 업데이트' 패턴 감지", () => {
  assert.equal(detectApplyIntent("이걸로 업데이트해줘"), true);
  assert.equal(detectApplyIntent("이 내용으로 업데이트해줘"), true);
});

test("detectApplyIntent - 영어 apply 패턴 감지", () => {
  assert.equal(detectApplyIntent("apply this to my resume"), true);
  assert.equal(detectApplyIntent("apply it"), true);
  assert.equal(detectApplyIntent("please apply this"), true);
});

test("detectApplyIntent - 다른 의도는 false 반환", () => {
  assert.equal(detectApplyIntent("경력 섹션을 개선해줘"), false, "refine_section 패턴");
  assert.equal(detectApplyIntent("2024년 커밋 찾아줘"), false, "search_evidence 패턴");
  assert.equal(detectApplyIntent("이력서 어때?"), false, "question 패턴");
  assert.equal(detectApplyIntent(""), false, "빈 문자열");
  assert.equal(detectApplyIntent(null), false, "null 입력");
});

test("detectApplyIntent - '그대로 반영' / '반영 부탁' 패턴", () => {
  assert.equal(detectApplyIntent("그대로 반영해줘"), true);
  assert.equal(detectApplyIntent("반영 부탁해"), true);
  assert.equal(detectApplyIntent("적용 부탁합니다"), true);
});

// ─── extractSectionFromContext ────────────────────────────────────────────────

test("extractSectionFromContext - parsedQuery.section 이 있으면 우선 사용", () => {
  const result = extractSectionFromContext(
    "반영해줘",
    { section: "experience" },
    []
  );
  assert.equal(result, "experience");
});

test("extractSectionFromContext - 현재 query 에서 섹션 감지", () => {
  const result = extractSectionFromContext(
    "경력 섹션 반영해줘",
    { section: null },
    []
  );
  assert.equal(result, "experience");
});

test("extractSectionFromContext - 히스토리에서 섹션 감지 (최근 메시지 우선)", () => {
  const history = [
    { role: "user", content: "기술 섹션 보여줘" },
    { role: "assistant", content: "기술 역량 목록입니다: React, Node.js, TypeScript" },
    { role: "user", content: "반영해줘" },
  ];
  const result = extractSectionFromContext("반영해줘", null, history);
  assert.equal(result, "skills");
});

test("extractSectionFromContext - 히스토리에서 projects 섹션 감지", () => {
  const history = [
    { role: "user", content: "프로젝트 경험 찾아줘" },
    { role: "assistant", content: "work-log 프로젝트 개발을 진행했습니다." },
  ];
  const result = extractSectionFromContext("반영해줘", null, history);
  assert.equal(result, "projects");
});

test("extractSectionFromContext - 섹션을 감지하지 못하면 null 반환", () => {
  const result = extractSectionFromContext("반영해줘", null, []);
  assert.equal(result, null);
});

// ─── extractProposedChanges ───────────────────────────────────────────────────

test("extractProposedChanges - 빈 히스토리는 빈 배열 반환", () => {
  const { changes, sourceIndex } = extractProposedChanges([]);
  assert.deepEqual(changes, []);
  assert.equal(sourceIndex, -1);
});

test("extractProposedChanges - 어시스턴트 메시지 없으면 빈 배열", () => {
  const history = [
    { role: "user", content: "찾아줘" },
  ];
  const { changes, sourceIndex } = extractProposedChanges(history);
  assert.deepEqual(changes, []);
  assert.equal(sourceIndex, -1);
});

test("extractProposedChanges - 불릿 목록 파싱", () => {
  const history = [
    { role: "user", content: "프로젝트 경험 찾아줘" },
    {
      role: "assistant",
      content: [
        "## 이력서 어필 포인트",
        "1. **분산 시스템 설계** ★★★",
        "   마이크로서비스 아키텍처를 도입하여 처리량을 3배 향상시켰습니다.",
        "",
        "2. **CI/CD 자동화** ★★",
        "   배포 파이프라인을 구축하여 배포 시간을 70% 단축했습니다.",
      ].join("\n"),
    },
  ];
  const { changes, sourceIndex } = extractProposedChanges(history);
  assert.equal(sourceIndex, 1, "마지막 어시스턴트 메시지 인덱스");
  assert.ok(changes.length > 0, "변경 내용이 추출되어야 한다");
  // 어필 포인트 제목들이 추출되는지 확인
  const contents = changes.map((c) => c.content);
  assert.ok(
    contents.some((c) => c.includes("분산 시스템 설계") || c.includes("CI/CD")),
    "어필 포인트 제목이 포함되어야 한다"
  );
});

test("extractProposedChanges - 일반 불릿 목록 파싱", () => {
  const history = [
    { role: "user", content: "기술 스택 어필 포인트 알려줘" },
    {
      role: "assistant",
      content: [
        "기술 역량 어필 포인트입니다:",
        "- React/Next.js를 활용한 프론트엔드 개발 5년 경력",
        "- Node.js 기반 REST API 설계 및 운영",
        "• TypeScript 도입으로 코드 품질 30% 향상",
      ].join("\n"),
    },
  ];
  const { changes, sourceIndex } = extractProposedChanges(history);
  assert.equal(sourceIndex, 1);
  assert.equal(changes.length, 3, "불릿 3개가 추출되어야 한다");
  assert.ok(changes.every((c) => c.type === "bullet"));
  assert.ok(changes[0].content.includes("React"));
});

test("extractProposedChanges - 가장 최근 어시스턴트 메시지를 사용", () => {
  const history = [
    { role: "assistant", content: "- 이전 제안입니다" },
    { role: "user", content: "다시 해줘" },
    { role: "assistant", content: "- 최신 제안입니다" },
  ];
  const { changes, sourceIndex } = extractProposedChanges(history);
  assert.equal(sourceIndex, 2, "마지막(index 2) 어시스턴트 메시지가 선택되어야 한다");
  assert.ok(changes[0].content.includes("최신 제안"));
});

test("extractProposedChanges - 텍스트만 있을 때 type: text 반환", () => {
  const history = [
    { role: "user", content: "자기소개를 써줘" },
    {
      role: "assistant",
      content:
        "5년 경력의 풀스택 개발자로서 스타트업부터 대기업까지 다양한 환경에서 서비스를 개발한 경험이 있습니다.",
    },
  ];
  const { changes, sourceIndex } = extractProposedChanges(history);
  assert.equal(sourceIndex, 1);
  // 불릿이 없으면 전체 텍스트가 type: 'text' 로 반환된다
  assert.ok(changes.length > 0);
  // 불릿 형식이 없으므로 text 타입이거나 내용에 '풀스택'이 포함되어야 한다
  const hasContent = changes.some((c) => c.content.includes("풀스택") || c.content.includes("개발자"));
  assert.ok(hasContent, "내용이 올바르게 추출되어야 한다");
});

// ─── parseApplyIntent ─────────────────────────────────────────────────────────

test("parseApplyIntent - apply_section 의도가 아니면 detected: false", () => {
  const result = parseApplyIntent("경력 섹션 개선해줘", { intent: "refine_section" }, []);
  assert.equal(result.detected, false);
  assert.equal(result.changes.length, 0);
  assert.equal(result.confidence, 0);
});

test("parseApplyIntent - 반영해줘 + 섹션 + 변경 내용 있을 때 완전한 결과", () => {
  const history = [
    { role: "user", content: "기술 스택 어필 포인트 찾아줘" },
    {
      role: "assistant",
      content: [
        "기술 어필 포인트:",
        "- React/Next.js 프론트엔드 5년",
        "- TypeScript 도입 경험",
      ].join("\n"),
    },
  ];
  const result = parseApplyIntent(
    "기술 섹션에 반영해줘",
    { intent: "apply_section", section: "skills", keywords: ["기술"] },
    history
  );
  assert.equal(result.detected, true, "감지되어야 한다");
  assert.equal(result.section, "skills", "섹션이 skills 이어야 한다");
  assert.ok(result.changes.length > 0, "변경 내용이 있어야 한다");
  assert.ok(result.confidence > 0.5, "신뢰도가 높아야 한다");
  assert.equal(result.ambiguous, false, "모호하지 않아야 한다");
  assert.equal(result.clarificationNeeded, null, "보충 질문이 없어야 한다");
  assert.equal(result.sourceMessageIndex, 1, "마지막 어시스턴트 메시지 인덱스");
});

test("parseApplyIntent - 섹션 불명확 시 ambiguous: true, clarificationNeeded 포함", () => {
  const history = [
    { role: "user", content: "찾아줘" },
    { role: "assistant", content: "- 어떤 항목입니다" },
  ];
  const result = parseApplyIntent("반영해줘", { intent: "apply_section", section: null }, history);
  assert.equal(result.detected, true);
  assert.equal(result.section, null, "섹션이 없어야 한다");
  assert.equal(result.ambiguous, true, "모호해야 한다");
  assert.ok(
    typeof result.clarificationNeeded === "string" && result.clarificationNeeded.length > 0,
    "보충 질문이 있어야 한다"
  );
});

test("parseApplyIntent - 히스토리 없고 변경 내용 없을 때 ambiguous: true", () => {
  const result = parseApplyIntent("반영해줘", { intent: "apply_section" }, []);
  assert.equal(result.detected, true);
  assert.equal(result.ambiguous, true);
  assert.ok(result.clarificationNeeded, "보충 질문이 있어야 한다");
  assert.equal(result.sourceMessageIndex, -1);
});

test("parseApplyIntent - parsedQuery.intent 가 apply_section 이어도 감지", () => {
  const result = parseApplyIntent(
    "이대로 적용해줘",
    { intent: "apply_section", section: "summary" },
    [
      { role: "assistant", content: "- 5년 경력 풀스택 개발자" },
    ]
  );
  assert.equal(result.detected, true);
  assert.equal(result.section, "summary");
});

test("parseApplyIntent - 히스토리에서 섹션 추론 가능", () => {
  const history = [
    { role: "user", content: "프로젝트 섹션 어필 포인트 찾아줘" },
    { role: "assistant", content: "- work-log 프로젝트 개발 완료\n- API 성능 50% 향상" },
  ];
  const result = parseApplyIntent(
    "반영해줘",
    { intent: "apply_section", section: null },
    history
  );
  assert.equal(result.detected, true);
  // "프로젝트"가 히스토리에 있으므로 섹션이 projects 로 추론되어야 한다
  assert.equal(result.section, "projects");
  assert.equal(result.changes.length, 2, "불릿 2개가 추출되어야 한다");
});
