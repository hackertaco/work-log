import assert from "node:assert/strict";
import test from "node:test";

import { extractWorkStyleForArea, synthesizeWorkStylePrinciples } from "./workStyleExtract.mjs";

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

test("falls back to nested output[].content[] text when output_text is absent", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  did: ["레거시 배치 정리"],
                  judgments: [{ text: "실패를 조용히 삼키지 않고 로그로 드러냄", evidence: "에러 나면 로그 남겨야지" }]
                })
              }
            ]
          }
        ]
      }),
      { status: 200 }
    );

  const r = await extractWorkStyleForArea({ area: "dt-backend", prompts: ["에러 나면 로그 남겨야지"] }, fetchImpl);

  assert.equal(r.area, "dt-backend");
  assert.deepEqual(r.did, ["레거시 배치 정리"]);
  assert.equal(r.judgments.length, 1);
  assert.equal(r.judgments[0].evidence, "에러 나면 로그 남겨야지");

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

// ─── synthesizeWorkStylePrinciples ───────────────────────────────────────────

test("synthesis: no-op without OpenAI key", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await synthesizeWorkStylePrinciples(
    [{ area: "a", judgments: [{ text: "t", evidence: "e" }] }],
    () => { throw new Error("no fetch"); }
  );
  assert.deepEqual(r, []);
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});

test("synthesis: no-op when there are no judgments to synthesize", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const r = await synthesizeWorkStylePrinciples(
    [{ area: "a", judgments: [] }, { area: "b", judgments: [] }],
    () => { throw new Error("no fetch"); }
  );
  assert.deepEqual(r, []);
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

test("synthesis: distills cross-area principles from judgments", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body);
    // 영역별 판단이 실제로 모델에 전달되는지 확인
    assert.ok(JSON.stringify(payload).includes("성장팀"));
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        principles: [
          { title: "공유·합의 가능성을 품질 기준으로 둔다", description: "내부에서만 통하는 정의가 아니라 다른 팀과 합의 가능한 형태로 만들려 함." },
          { title: "구현보다 정의·상태를 먼저 정리한다", description: "기능 전에 용어·상태값·기준부터 명확히." }
        ]
      })
    }), { status: 200 });
  };

  const r = await synthesizeWorkStylePrinciples([
    { area: "dt-frontend", judgments: [{ text: "성장팀과 합의 가능한 세그먼트 기준이 필요", evidence: "성장팀이랑 얼라인" }] },
    { area: "neo-fetch", judgments: [{ text: "상태값 먼저 명확히", evidence: "지금 꼬여있어" }] }
  ], fetchImpl);

  assert.equal(r.length, 2);
  assert.equal(r[0].title, "공유·합의 가능성을 품질 기준으로 둔다");
  assert.ok(r[0].description.length > 0);
});

test("synthesis: returns empty on OpenAI error (non-fatal)", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const r = await synthesizeWorkStylePrinciples(
    [{ area: "a", judgments: [{ text: "t", evidence: "e" }] }],
    async () => new Response("boom", { status: 500 })
  );
  assert.deepEqual(r, []);
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});
