import assert from "node:assert/strict";
import test from "node:test";

import { crossCheckPlugins, estimateDialSavings, scoreUsage } from "./usageAudit.mjs";

const basePerson = (person, over = {}) => ({
  person,
  reqs: 1000,
  tokens: 1e9,
  usd: 1000,
  avg_ctx: 300000,
  p95_ctx: 500000,
  discarded_cache_usd: 0,
  empty_reqs: 30,
  cache_reuse: 40,
  huge_ctx_reqs: 0,
  ...over
});

test("강도 절감은 같은 사람·같은 모델의 high 단가와만 비교한다", () => {
  const savings = estimateDialSavings([
    { person: "a", model: "claude-opus-4-8", effort: "xhigh", reqs: 1000, avg_usd: 0.3, avg_output: 1300 },
    { person: "a", model: "claude-opus-4-8", effort: "high", reqs: 100, avg_usd: 0.2, avg_output: 1090 },
    // 다른 모델의 high 는 비교 대상이 아니다 — 단가 자체가 다르다
    { person: "a", model: "claude-sonnet-5", effort: "high", reqs: 500, avg_usd: 0.09, avg_output: 1000 }
  ]);

  assert.equal(Math.round(savings.get("a").effortSavings), 100); // (0.3-0.2)*1000
});

test("high 단가를 모르면 강도 절감을 추정하지 않는다 — 지어내지 않는다", () => {
  const savings = estimateDialSavings([
    { person: "a", model: "claude-opus-5", effort: "xhigh", reqs: 1000, avg_usd: 0.3, avg_output: 1300 }
  ]);

  assert.equal(savings.get("a").effortSavings, 0);
  assert.equal(savings.get("a").highEffortReqs, 1000); // 비중 보고는 그대로 한다
});

test("프리미엄 모델 절감은 기준 모델을 함께 쓸 때만 계산한다", () => {
  const both = estimateDialSavings([
    { person: "a", model: "claude-fable-5", effort: "high", reqs: 1000, avg_usd: 0.5, avg_output: 1000 },
    { person: "a", model: "claude-opus-5", effort: "high", reqs: 1000, avg_usd: 0.28, avg_output: 900 }
  ]);
  assert.equal(Math.round(both.get("a").premiumSavings), 220);

  const onlyPremium = estimateDialSavings([
    { person: "a", model: "claude-fable-5", effort: "high", reqs: 1000, avg_usd: 0.5, avg_output: 1000 }
  ]);
  assert.equal(onlyPremium.get("a").premiumSavings, 0);
});

test("지표가 전부 정상이면 조치 후보를 만들지 않는다", () => {
  const { findings } = scoreUsage({
    base: [basePerson("clean@x.com")],
    dials: [{ person: "clean@x.com", model: "claude-sonnet-5", effort: "high", reqs: 1000, avg_usd: 0.09, avg_output: 1000 }],
    limits: [], bursts: [], mixes: [], coordination: [], unkeyed: []
  });

  assert.deepEqual(findings, []);
});

test("사람을 실제로 멈춘 사용한도(400)는 재시도되는 429와 따로 센다", () => {
  const { people, findings } = scoreUsage({
    base: [basePerson("p@x.com")],
    dials: [],
    limits: [
      { person: "p@x.com", kind: "rate_limit", c: 94 },
      { person: "p@x.com", kind: "hard_stop", c: 6 }
    ],
    bursts: [], mixes: [], coordination: [], unkeyed: []
  });

  assert.equal(people[0].rateLimits, 94);
  assert.equal(people[0].hardStops, 6);
  // 429 만으로는 조치 후보가 되지 않는다 — 자동 재시도되므로 사람을 막지 않는다
  const kinds = findings.map((f) => f.kind);
  assert.ok(kinds.includes("hard-stop"));
  assert.ok(!kinds.includes("rate-limit"));
});

test("조율 비용은 건수가 아니라 글자 양으로 재고, 갈린 이메일은 합친다", () => {
  // 건수로 보면 기계 잡음이 커 보이지만 양으로는 인계 문서가 압도한다 — 2026-08-04 에 이걸로 오진했다.
  const { people, findings } = scoreUsage({
    base: [basePerson("limjaee@gmail.com")],
    dials: [],
    limits: [], bursts: [{ person: "limjaee@gmail.com", max_concurrent: 5, peak_tokens_per_min: 1e6, mins_over_5m: 0 }],
    mixes: [],
    coordination: [
      { email: "limjaee@gmail.com", prompts: 900, total_chars: 1000000, handoff_chars: 100000, handoff_prompts: 10, machine_chars: 800000 },
      { email: "limjaee@tgsociety.co.kr", prompts: 100, total_chars: 9000000, handoff_chars: 8000000, handoff_prompts: 60, machine_chars: 200000 }
    ],
    unkeyed: []
  });

  assert.equal(people[0].handoffPct, 81); // (100000+8000000)/10000000
  assert.equal(people[0].machinePct, 10);
  const handoff = findings.find((f) => f.kind === "handoff-volume");
  assert.ok(handoff, "양 기준으로 인계 문서가 잡혀야 한다");
  assert.match(handoff.detail, /10쌍/); // 동시 5개 → 5*4/2
  assert.match(handoff.detail, /워크트리는 파일 충돌/); // 잘못된 처방을 반복하지 않도록 못박는다
});

test("절감액이 큰 항목이 먼저 온다", () => {
  const { findings } = scoreUsage({
    base: [basePerson("a@x.com", { usd: 10000, discarded_cache_usd: 3000 })],
    dials: [
      { person: "a@x.com", model: "claude-opus-4-8", effort: "xhigh", reqs: 10000, avg_usd: 0.3, avg_output: 1300 },
      { person: "a@x.com", model: "claude-opus-4-8", effort: "high", reqs: 500, avg_usd: 0.2, avg_output: 1090 }
    ],
    limits: [], bursts: [], mixes: [], coordination: [], unkeyed: []
  });

  assert.equal(findings[0].kind, "effort-dial"); // high 등급이 medium 보다 먼저
  assert.equal(findings[0].savingsUsd, 1000);
});

test("꺼둔 플러그인은 매번 그대로 보고한다 — 끈 걸 잊는 걸 막는 게 목적이다", () => {
  const p = crossCheckPlugins({
    enabledPlugins: {
      "vercel-plugin@vercel": true,
      "ralph-loop@official": false,
      "feature-dev@official": true,
      "code-review@official": false
    },
    usage: [
      { plugin: "vercel-plugin", actually_used: 1783 },
      { plugin: "feature-dev", actually_used: 0 }   // 올라오기만 함
    ],
    ownerEmail: "me@x.com"
  });

  assert.deepEqual(p.disabled, ["code-review", "ralph-loop"]);
  assert.deepEqual(p.enabledUnused, ["feature-dev"]);
  assert.deepEqual(p.enabledUsed.map((x) => x.name), ["vercel-plugin"]);
});

test("설정이 없으면 플러그인 절을 만들지 않는다 — 팀 리포트로만 쓸 때", () => {
  assert.equal(crossCheckPlugins({ enabledPlugins: null, usage: [], ownerEmail: null }), null);
});

test("사용 기록이 아예 없는 플러그인도 '안 쓴 것'으로 센다", () => {
  const p = crossCheckPlugins({
    enabledPlugins: { "never-logged@x": true },
    usage: [],
    ownerEmail: "me@x.com"
  });
  assert.deepEqual(p.enabledUnused, ["never-logged"]);
});
