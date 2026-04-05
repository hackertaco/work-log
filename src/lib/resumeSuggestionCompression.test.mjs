import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compressWorkLogSuggestions } from "./resumeSuggestionCompression.mjs";

function makeSuggestion(overrides = {}) {
  return {
    id: "s-1",
    type: "work_log_update",
    section: "experience",
    action: "append_bullet",
    description: "노드랩: 웹 Sentry 에러 필터와 리브랜딩 적용을 함께 정리해 운영 노이즈와 시각적 일관성을 높였다.",
    detail: "2026-03-31 업무 로그 기반",
    patch: {
      company: "노드랩",
      bullet: "웹 Sentry 에러 필터와 리브랜딩 적용을 함께 정리해 운영 노이즈와 시각적 일관성을 높였다."
    },
    source: "work_log",
    logDate: "2026-03-31",
    createdAt: "2026-04-02T09:05:53.046Z",
    status: "pending",
    ...overrides
  };
}

describe("compressWorkLogSuggestions", () => {
  test("keeps broader representative when cluster contains narrow implementation variants", () => {
    const compressed = compressWorkLogSuggestions([
      makeSuggestion({
        id: "narrow-1",
        description: "노드랩: Sentry beforeSend에 IndexedDB refusing to open 에러 필터를 추가해 반복 노이즈를 줄였다.",
        patch: {
          company: "노드랩",
          bullet: "Sentry beforeSend에 IndexedDB refusing to open 에러 필터를 추가해 반복 노이즈를 줄였다."
        }
      }),
      makeSuggestion({
        id: "narrow-2",
        description: "노드랩: 리브랜딩 CI를 적용해 웹 운영 화면과 브랜드 표현의 일관성을 개선했다.",
        patch: {
          company: "노드랩",
          bullet: "리브랜딩 CI를 적용해 웹 운영 화면과 브랜드 표현의 일관성을 개선했다."
        }
      }),
      makeSuggestion()
    ]);

    assert.equal(compressed.length, 1);
    assert.equal(compressed[0].id, "s-1");
  });

  test("caps append_bullet suggestions per company", () => {
    const compressed = compressWorkLogSuggestions([
      makeSuggestion({ id: "a", patch: { company: "티지소사이어티", bullet: "커리큘럼과 설문, 로드맵을 재정비해 학습 기대치와 실제 스킬을 정렬했다." }, description: "티지소사이어티: 커리큘럼과 설문, 로드맵을 재정비해 학습 기대치와 실제 스킬을 정렬했다." }),
      makeSuggestion({ id: "b", patch: { company: "티지소사이어티", bullet: "Phase 2 로드맵과 Week 4 스킬 소개를 반영해 숙제-스킬 정합성을 높였다." }, description: "티지소사이어티: Phase 2 로드맵과 Week 4 스킬 소개를 반영해 숙제-스킬 정합성을 높였다." }),
      makeSuggestion({ id: "c", patch: { company: "티지소사이어티", bullet: "목표·브랜드 디자인을 적용해 콘텐츠 구조를 정리하고 학습자 기대 오차를 줄였다." }, description: "티지소사이어티: 목표·브랜드 디자인을 적용해 콘텐츠 구조를 정리하고 학습자 기대 오차를 줄였다." }),
      makeSuggestion({ id: "d", patch: { company: "티지소사이어티", bullet: "드라이빙 teacher AI 네이티브 콘텐츠를 재구성해 학습자 기대와 실제 진행 흐름의 간극을 줄였다." }, description: "티지소사이어티: 드라이빙 teacher AI 네이티브 콘텐츠를 재구성해 학습자 기대와 실제 진행 흐름의 간극을 줄였다." }),
    ]);

    assert.equal(compressed.length, 2);
    assert.ok(compressed.every((item) => item.patch.company === "티지소사이어티"));
  });

  test("preserves non-append suggestions", () => {
    const compressed = compressWorkLogSuggestions([
      makeSuggestion({ id: "skills", section: "skills", action: "add_skills", patch: { skills: ["Sentry"] }, description: "기술 추가: Sentry", }),
      makeSuggestion({ id: "exp" }),
    ]);

    assert.ok(compressed.some((item) => item.id === "skills"));
    assert.ok(compressed.some((item) => item.id === "exp"));
  });
});
