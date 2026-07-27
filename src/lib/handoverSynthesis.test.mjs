import assert from "node:assert/strict";
import test from "node:test";
import { buildHandoverPayload, synthesizeHandover } from "./handoverSynthesis.mjs";

const ANALYSIS = {
  windowDays: 30,
  principles: [{ title: "검증되지 않은 것은 완료가 아니다", description: "테스트부터 세운다" }],
  areas: [{ area: "koreans-love-stock", promptCount: 94, judgments: [{ text: "테스트 먼저", evidence: "with-tests 브랜치 만들어줘" }] }]
};

test("buildHandoverPayload targets Responses API with strict json_schema and 3000 tokens", () => {
  const p = buildHandoverPayload(ANALYSIS);
  assert.equal(p.max_output_tokens, 3000);
  assert.equal(p.text.format.type, "json_schema");
  assert.equal(p.text.format.strict, true);
  assert.deepEqual(p.text.format.schema.required, ["oneLiner", "personaPrompt", "howToWork", "whatToAsk", "strengths", "heuristics"]);
});

test("synthesizeHandover parses model output into the Handover shape", async () => {
  const saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "k";
  const body = {
    oneLiner: "검증 우선주의자",
    personaPrompt: "① 검증 경로부터 ② 사용자 문장 기준 ③ 근본원인까지",
    howToWork: ["PR엔 테스트를 붙여라"], whatToAsk: ["이거 어떻게 검증하지?"], strengths: ["집요한 검증"],
    heuristics: [{ principle: "검증 먼저", whenApplies: "기능 넓히기 전", example: "with-tests 브랜치", howToApply: "확장 전 통과부터" }]
  };
  const fetchImpl = async () => new Response(JSON.stringify({ output_text: JSON.stringify(body) }), { status: 200 });
  const out = await synthesizeHandover(ANALYSIS, fetchImpl);
  assert.equal(out.oneLiner, "검증 우선주의자");
  assert.equal(out.heuristics[0].whenApplies, "기능 넓히기 전");
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

test("synthesizeHandover returns null when disabled or key missing", async () => {
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  assert.equal(await synthesizeHandover(ANALYSIS, () => { throw new Error("no fetch"); }), null);
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});
