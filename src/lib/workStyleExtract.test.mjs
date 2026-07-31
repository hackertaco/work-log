import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExtractPayload,
  buildSynthesisPayload,
  extractWorkStyleForArea,
  formatBehaviorContext,
  synthesizeWorkStylePrinciples
} from "./workStyleExtract.mjs";

test("no-op without OpenAI key", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await extractWorkStyleForArea({ area: "dt-frontend", prompts: ["a", "b"] }, null, () => { throw new Error("no fetch"); });
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
    null,
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

  const r = await extractWorkStyleForArea({ area: "dt-backend", prompts: ["에러 나면 로그 남겨야지"] }, null, fetchImpl);

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
  const r = await extractWorkStyleForArea({ area: "x", prompts: ["a"] }, null, fetchImpl);
  assert.deepEqual(r, { area: "x", did: [], judgments: [] });
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

// ─── synthesizeWorkStylePrinciples ───────────────────────────────────────────

test("synthesis: no-op without OpenAI key", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await synthesizeWorkStylePrinciples(
    [{ area: "a", judgments: [{ text: "t", evidence: "e" }] }],
    null,
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
    null,
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
  ], null, fetchImpl);

  assert.equal(r.length, 2);
  assert.equal(r[0].title, "공유·합의 가능성을 품질 기준으로 둔다");
  assert.ok(r[0].description.length > 0);
});

test("synthesis: returns empty on OpenAI error (non-fatal)", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const r = await synthesizeWorkStylePrinciples(
    [{ area: "a", judgments: [{ text: "t", evidence: "e" }] }],
    null,
    async () => new Response("boom", { status: 500 })
  );
  assert.deepEqual(r, []);
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

// ─── 행동신호 주입 ────────────────────────────────────────────────────────────

const BEHAVIOR = {
  sessionCount: 12,
  avgFrustration: 0.34,
  frustrationDensity: 0.08,
  retryRate: 0.12,
  efficiency: 0.71,
  verificationRatio: 0.41,
  topTools: [
    { tool: "Read", count: 120, isVerification: true },
    { tool: "Bash", count: 88, isVerification: false }
  ]
};

test("formatBehaviorContext: 신호를 사람이 읽는 줄로 만든다", () => {
  const text = formatBehaviorContext(BEHAVIOR);
  assert.ok(text.includes("세션 12"));
  assert.ok(text.includes("0.34"));
  assert.ok(text.includes("41%"));
  assert.ok(text.includes("12%"));
  assert.ok(text.includes("Read"));
  assert.ok(text.includes("검증"));
});

test("formatBehaviorContext: 신호 없으면 빈 문자열", () => {
  assert.equal(formatBehaviorContext(null), "");
  assert.equal(formatBehaviorContext({ sessionCount: 0 }), "");
});

test("formatBehaviorContext: null 지표는 줄을 만들지 않는다", () => {
  const text = formatBehaviorContext({ ...BEHAVIOR, retryRate: null, efficiency: null });
  assert.ok(!text.includes("재시도"));
  assert.ok(!text.includes("효율"));
  assert.ok(text.includes("검증"));
});

test("buildExtractPayload: behavior 없으면 v1 페이로드와 완전히 동일", () => {
  const a = buildExtractPayload("work-log", ["p1", "p2"]);
  const b = buildExtractPayload("work-log", ["p1", "p2"], null);
  assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes("행동신호"));
});

test("buildExtractPayload: behavior 있으면 행동 근거와 사용 지침이 들어간다", () => {
  const payload = buildExtractPayload("work-log", ["p1"], BEHAVIOR);
  const serialized = JSON.stringify(payload);
  assert.ok(serialized.includes("행동신호"));
  assert.ok(serialized.includes("0.34"));
  // 수치 나열 금지 지침이 반드시 함께 가야 한다 (프로필에 지표 섹션이 생기면 안 됨)
  assert.ok(payload.input[0].content.includes("수치를 그대로 나열하지 말"));
  // 스키마·예산은 그대로
  assert.equal(payload.max_output_tokens, 3000);
  assert.equal(payload.text.format.name, "workstyle_area");
});

test("buildSynthesisPayload: behaviorByArea 없으면 v1 과 동일", () => {
  const items = [{ area: "a", text: "t" }];
  assert.deepEqual(buildSynthesisPayload(items), buildSynthesisPayload(items, null));
});

test("buildSynthesisPayload: 영역별 행동 요약이 붙는다", () => {
  const payload = buildSynthesisPayload([{ area: "work-log", text: "판단1" }], { "work-log": BEHAVIOR });
  const serialized = JSON.stringify(payload);
  assert.ok(serialized.includes("work-log"));
  assert.ok(serialized.includes("행동신호"));
  assert.equal(payload.text.format.name, "workstyle_principles");
});

test("extractWorkStyleForArea: behavior 를 페이로드까지 실어 보낸다", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  let seen = "";
  const fetchImpl = async (_url, init) => {
    seen = String(init.body);
    return new Response(JSON.stringify({
      output_text: JSON.stringify({ did: ["d"], judgments: [{ text: "t", evidence: "e" }] })
    }), { status: 200 });
  };

  const r = await extractWorkStyleForArea({ area: "work-log", prompts: ["p"] }, BEHAVIOR, fetchImpl);
  assert.equal(r.judgments.length, 1);
  assert.ok(seen.includes("행동신호"));

  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});
