// src/lib/memberProfile.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { renderMemberProfile } from "./memberProfile.mjs";

const ANALYSIS = {
  windowDays: 30,
  principles: [{ title: "검증되지 않은 것은 완료가 아니다", description: "테스트부터" }],
  areas: [{ area: "koreans-love-stock", promptCount: 94, judgments: [] }, { area: "neo-fetch", promptCount: 12, judgments: [] }]
};
const HANDOVER = {
  oneLiner: "검증 우선주의자", personaPrompt: "① 검증 ② 사용자 ③ 근본원인",
  howToWork: ["PR엔 테스트를"], whatToAsk: ["어떻게 검증?"], strengths: ["집요함"],
  heuristics: [{ principle: "검증 먼저", whenApplies: "확장 전", example: "with-tests 브랜치", howToApply: "통과부터" }]
};

test("renders headline, honesty marker, persona block, 4-layer heuristics, areas", () => {
  const md = renderMemberProfile({ name: "seungah", analysis: ANALYSIS, handover: HANDOVER, generatedAt: "2026-07-27T00:00:00Z", windowDays: 30 });
  assert.match(md, /^# seungah — 업무방식/m);
  assert.match(md, /관찰된 패턴/);            // honesty marker
  assert.match(md, /행세가 아니라|학습|참고/);   // framing
  assert.match(md, /이 사람처럼 판단하기/);       // persona block heading
  assert.match(md, /① 검증 ② 사용자 ③ 근본원인/); // persona content
  assert.match(md, /검증 먼저/);                 // heuristic principle
  assert.match(md, /확장 전/);                   // whenApplies
  assert.match(md, /with-tests 브랜치/);         // example
  assert.match(md, /koreans-love-stock.*94/);    // area + count
});

test("tolerates null handover (analysis-only, no throw)", () => {
  const md = renderMemberProfile({ name: "x", analysis: ANALYSIS, handover: null, generatedAt: "2026-07-27T00:00:00Z", windowDays: 30 });
  assert.match(md, /# x — 업무방식/);
  assert.match(md, /검증되지 않은 것은 완료가 아니다/); // principle still shown
});
