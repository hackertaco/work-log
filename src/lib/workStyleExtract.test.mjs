import assert from "node:assert/strict";
import test from "node:test";

import { extractWorkStyleForArea } from "./workStyleExtract.mjs";

test("no-op without OpenAI key", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await extractWorkStyleForArea({ area: "dt-frontend", prompts: ["a", "b"] }, () => { throw new Error("no fetch"); });
  assert.deepEqual(r, { area: "dt-frontend", did: [], judgments: [] });
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});

test("parses did + judgments from OpenAI json output", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  const fetchImpl = async (url, init) => {
    assert.ok(String(url).includes("/responses") || String(url).length > 0);
    const payload = JSON.parse(init.body);
    // 프롬프트 근거가 실제로 모델에 전달되는지 확인
    assert.ok(JSON.stringify(payload).includes("번역체"));
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        did: ["예약 변경 플로우", "UI 다듬기"],
        judgments: [
          { text: "번역체 카피를 실제 표현으로 바꾸는 걸 품질 기준으로 삼음", evidence: "표현이 너무 번역체야" }
        ]
      })
    }), { status: 200 });
  };

  const r = await extractWorkStyleForArea(
    { area: "dt-frontend", prompts: ["표현이 너무 번역체야 우리나라 표현으로", "엣지케이스 e2e 맞아?"] },
    fetchImpl
  );

  assert.equal(r.area, "dt-frontend");
  assert.deepEqual(r.did, ["예약 변경 플로우", "UI 다듬기"]);
  assert.equal(r.judgments.length, 1);
  assert.equal(r.judgments[0].evidence, "표현이 너무 번역체야");

  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

test("returns empty on OpenAI error (non-fatal)", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const fetchImpl = async () => new Response("boom", { status: 500 });
  const r = await extractWorkStyleForArea({ area: "x", prompts: ["a"] }, fetchImpl);
  assert.deepEqual(r, { area: "x", did: [], judgments: [] });
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});
