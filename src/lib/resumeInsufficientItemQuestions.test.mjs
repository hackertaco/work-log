/**
 * Unit tests for resumeInsufficientItemQuestions.mjs
 *
 * Sub-AC 9-2: 부족한 항목에 대한 보충 질문 생성 로직 테스트.
 *
 * Run with:  node --test src/lib/resumeInsufficientItemQuestions.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generateFollowUpQuestions,
  buildCoverageNoticeMessage,
} from "./resumeInsufficientItemQuestions.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** 경험 섹션 부족 항목 생성 */
function expItem(overrides = {}) {
  return {
    section: "experience",
    company: "테스트 주식회사",
    text: "React와 TypeScript를 사용하여 프론트엔드 성능을 개선했습니다",
    score: 0.1,
    level: "low",
    severity: "high",
    reason: "업무 로그에서 관련 근거를 찾을 수 없습니다.",
    unmatchedTokens: ["typescript", "프론트엔드", "성능"],
    ...overrides,
  };
}

/** 스킬 섹션 부족 항목 생성 */
function skillItem(overrides = {}) {
  return {
    section: "skills",
    text: "Kubernetes",
    score: 0,
    level: "none",
    severity: "low",
    reason: '"Kubernetes" 스킬 사용 사례가 업무 로그에서 확인되지 않습니다.',
    unmatchedTokens: ["kubernetes"],
    ...overrides,
  };
}

/** 자기소개 섹션 부족 항목 생성 */
function summaryItem(overrides = {}) {
  return {
    section: "summary",
    text: "데이터 기반 의사결정으로 서비스 품질을 높이는 엔지니어입니다",
    score: 0.1,
    level: "low",
    severity: "medium",
    reason: "일부 키워드에 대한 업무 근거가 부족합니다.",
    unmatchedTokens: ["데이터", "의사결정"],
    ...overrides,
  };
}

/** 프로젝트 섹션 부족 항목 생성 */
function projItem(overrides = {}) {
  return {
    section: "projects",
    text: "실시간 대시보드 구축으로 모니터링 효율 30% 향상",
    score: 0,
    level: "none",
    severity: "medium",
    reason: "업무 로그에서 관련 근거를 찾을 수 없습니다.",
    unmatchedTokens: ["대시보드", "모니터링"],
    ...overrides,
  };
}

// ─── generateFollowUpQuestions ─────────────────────────────────────────────────

describe("generateFollowUpQuestions — 빈 입력", () => {
  it("빈 배열 → 빈 배열 반환", () => {
    assert.deepEqual(generateFollowUpQuestions([]), []);
  });

  it("null → 빈 배열 반환", () => {
    assert.deepEqual(generateFollowUpQuestions(null), []);
  });

  it("undefined → 빈 배열 반환", () => {
    assert.deepEqual(generateFollowUpQuestions(undefined), []);
  });
});

describe("generateFollowUpQuestions — 경험 섹션", () => {
  it("경험 항목에 대해 질문을 생성한다", () => {
    const items = [expItem()];
    const questions = generateFollowUpQuestions(items);
    assert.ok(questions.length > 0, "질문이 1개 이상 생성되어야 한다");
    const q = questions[0];
    assert.equal(q.section, "experience");
    assert.ok(typeof q.id === "string" && q.id.length > 0, "id가 있어야 한다");
    assert.ok(typeof q.question === "string" && q.question.length > 0, "question이 있어야 한다");
    assert.ok(typeof q.itemText === "string" && q.itemText.length > 0, "itemText가 있어야 한다");
    assert.ok(
      q.severity === "high" || q.severity === "medium" || q.severity === "low",
      "severity가 유효한 값이어야 한다"
    );
  });

  it("unmatchedTokens가 있으면 첫 번째 토큰을 질문에 포함한다", () => {
    const item = expItem({ unmatchedTokens: ["kubernetes", "devops"] });
    const [q] = generateFollowUpQuestions([item]);
    assert.ok(q.question.includes("kubernetes"), "질문에 첫 번째 미매칭 토큰이 포함되어야 한다");
  });

  it("같은 회사에 대해 최대 1개 질문만 생성한다", () => {
    const items = [
      expItem({ text: "불릿 A", unmatchedTokens: ["token1"] }),
      expItem({ text: "불릿 B", unmatchedTokens: ["token2"] }),
      expItem({ text: "불릿 C", unmatchedTokens: ["token3"] }),
    ];
    const questions = generateFollowUpQuestions(items);
    const expQs = questions.filter((q) => q.section === "experience");
    assert.ok(expQs.length <= 1, "같은 회사에 대해 1개 질문 이하여야 한다");
  });

  it("company 필드가 있을 때 question에 회사명이 포함된다", () => {
    const item = expItem({ company: "멋진 회사" });
    const [q] = generateFollowUpQuestions([item]);
    assert.ok(q.question.includes("멋진 회사"), "질문에 회사명이 포함되어야 한다");
    assert.equal(q.company, "멋진 회사");
  });
});

describe("generateFollowUpQuestions — 스킬 섹션", () => {
  it("스킬 항목에 대해 질문을 생성한다", () => {
    const items = [skillItem()];
    const questions = generateFollowUpQuestions(items);
    assert.ok(questions.length > 0, "질문이 생성되어야 한다");
    assert.equal(questions[0].section, "skills");
    assert.ok(questions[0].question.includes("Kubernetes"), "스킬명이 질문에 포함되어야 한다");
  });

  it("같은 스킬에 대해 중복 질문이 생성되지 않는다", () => {
    const items = [
      skillItem({ text: "Go", unmatchedTokens: ["go"] }),
      skillItem({ text: "Go", unmatchedTokens: ["go"] }), // 중복
    ];
    const questions = generateFollowUpQuestions(items);
    const goQs = questions.filter((q) => q.section === "skills" && q.itemText.includes("Go"));
    assert.ok(goQs.length <= 1, "같은 스킬에 대해 1개 질문 이하여야 한다");
  });
});

describe("generateFollowUpQuestions — 자기소개 섹션", () => {
  it("자기소개 항목에 대해 질문을 생성한다", () => {
    const items = [summaryItem()];
    const questions = generateFollowUpQuestions(items);
    assert.ok(questions.length > 0, "질문이 생성되어야 한다");
    assert.equal(questions[0].section, "summary");
  });

  it("자기소개 질문은 최대 1개만 생성된다", () => {
    const items = [
      summaryItem({ text: "데이터 기반 엔지니어링 전문가입니다" }),
      summaryItem({ text: "사용자 중심 개발을 지향합니다" }),
    ];
    const questions = generateFollowUpQuestions(items);
    const summaryQs = questions.filter((q) => q.section === "summary");
    assert.ok(summaryQs.length <= 1, "자기소개 질문은 1개 이하여야 한다");
  });

  it("unmatchedTokens가 있으면 첫 번째 토큰을 질문에 포함한다", () => {
    const item = summaryItem({ unmatchedTokens: ["의사결정", "데이터"] });
    const [q] = generateFollowUpQuestions([item]);
    assert.ok(q.question.includes("의사결정"), "첫 번째 미매칭 토큰이 포함되어야 한다");
  });
});

describe("generateFollowUpQuestions — 프로젝트 섹션", () => {
  it("프로젝트 항목에 대해 질문을 생성한다", () => {
    const items = [projItem()];
    const questions = generateFollowUpQuestions(items);
    assert.ok(questions.length > 0, "질문이 생성되어야 한다");
    assert.equal(questions[0].section, "projects");
  });
});

describe("generateFollowUpQuestions — 정렬 및 상한", () => {
  it("심각도(severity) 우선 순서로 정렬된다", () => {
    const items = [
      skillItem({ severity: "low", text: "Terraform" }),
      expItem({ severity: "high", text: "불릿 high" }),
      summaryItem({ severity: "medium" }),
    ];
    const questions = generateFollowUpQuestions(items);
    // 첫 번째 질문은 severity=high인 experience 항목이어야 한다
    assert.ok(questions.length > 0, "질문이 생성되어야 한다");
    assert.equal(questions[0].severity, "high", "첫 번째 질문은 severity=high여야 한다");
  });

  it("maxQuestions 옵션을 초과하지 않는다", () => {
    const items = [
      expItem({ company: "A사", text: "불릿 A" }),
      expItem({ company: "B사", text: "불릿 B" }),
      skillItem({ text: "Go" }),
      skillItem({ text: "Terraform" }),
      projItem({ text: "프로젝트 A" }),
      summaryItem(),
    ];
    const questions = generateFollowUpQuestions(items, { maxQuestions: 3 });
    assert.ok(questions.length <= 3, `최대 3개까지 반환해야 하나 ${questions.length}개 반환됨`);
  });

  it("기본 maxQuestions(5)를 초과하지 않는다", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      expItem({ company: `회사${i}`, text: `불릿 ${i}` })
    );
    const questions = generateFollowUpQuestions(items);
    assert.ok(questions.length <= 5, `기본 5개 상한을 초과하면 안 된다 (got ${questions.length})`);
  });

  it("반환된 모든 질문은 id, question, section, itemText, severity 필드를 가진다", () => {
    const items = [expItem(), skillItem(), summaryItem()];
    const questions = generateFollowUpQuestions(items);
    for (const q of questions) {
      assert.ok(typeof q.id === "string", "id 필드가 문자열이어야 한다");
      assert.ok(typeof q.question === "string" && q.question.length > 0, "question 필드가 비어있지 않아야 한다");
      assert.ok(["experience", "skills", "summary", "projects"].includes(q.section), "section이 유효해야 한다");
      assert.ok(typeof q.itemText === "string", "itemText 필드가 문자열이어야 한다");
      assert.ok(["high", "medium", "low"].includes(q.severity), "severity가 유효해야 한다");
    }
  });
});

describe("generateFollowUpQuestions — 결정론적 ID", () => {
  it("같은 입력에 대해 항상 같은 ID를 생성한다", () => {
    const items = [expItem()];
    const q1 = generateFollowUpQuestions(items);
    const q2 = generateFollowUpQuestions(items);
    assert.equal(q1[0].id, q2[0].id, "같은 입력에 대해 ID가 동일해야 한다");
  });
});

// ─── buildCoverageNoticeMessage ────────────────────────────────────────────────

describe("buildCoverageNoticeMessage — 기본 동작", () => {
  it("질문이 없으면 null 반환", () => {
    assert.equal(buildCoverageNoticeMessage([]), null);
    assert.equal(buildCoverageNoticeMessage(null), null);
    assert.equal(buildCoverageNoticeMessage(undefined), null);
  });

  it("질문이 있으면 문자열 반환", () => {
    const questions = generateFollowUpQuestions([expItem()]);
    const msg = buildCoverageNoticeMessage(questions);
    assert.ok(typeof msg === "string" && msg.length > 0, "메시지가 문자열이어야 한다");
  });

  it("meta.insufficientCount가 있으면 메시지에 포함된다", () => {
    const questions = generateFollowUpQuestions([expItem()]);
    const msg = buildCoverageNoticeMessage(questions, { insufficientCount: 5, coverageRatio: 0.6 });
    assert.ok(msg.includes("5"), "불충분 항목 수가 포함되어야 한다");
    assert.ok(msg.includes("60%") || msg.includes("0.6") || msg.includes("60"), "커버리지 비율이 포함되어야 한다");
  });

  it("메시지에 '부족' 또는 분석 결과 관련 텍스트가 포함된다", () => {
    const questions = generateFollowUpQuestions([expItem()]);
    const msg = buildCoverageNoticeMessage(questions);
    assert.ok(
      msg.includes("부족") || msg.includes("분석") || msg.includes("항목"),
      "분석 관련 텍스트가 포함되어야 한다"
    );
  });
});
