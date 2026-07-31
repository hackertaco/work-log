import assert from "node:assert/strict";
import test from "node:test";

import { aggregateSignals, collectBehaviorSignals, emptySummary } from "./behaviorSignals.mjs";

const CH_KEYS = ["CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD", "WORK_LOG_ZEUDE_EMAIL"];

function setEnv() {
  process.env.CLICKHOUSE_URL = "https://clickhouse.test";
  process.env.CLICKHOUSE_USER = "u";
  process.env.CLICKHOUSE_PASSWORD = "p";
  process.env.WORK_LOG_ZEUDE_EMAIL = "user@example.com";
}
function clearEnv() {
  for (const k of CH_KEYS) delete process.env[k];
}

test("emptySummary: 수치는 전부 null, 세션 0", () => {
  assert.deepEqual(emptySummary(), {
    sessionCount: 0,
    avgFrustration: null,
    frustrationDensity: null,
    retryRate: null,
    efficiency: null,
    verificationRatio: null,
    topTools: []
  });
});

test("aggregateSignals: 세션을 영역별로 묶고 좌절 평균·검증비율·상위툴을 낸다", () => {
  const sessionArea = new Map([
    ["s1", "work-log"],
    ["s2", "work-log"],
    ["s3", "knowledge-base"]
  ]);
  const frustrationRows = [
    { session_id: "s1", requests: "10", score: "0.2", density: "0.02" },
    { session_id: "s2", requests: "10", score: "0.4", density: "0.04" },
    { session_id: "s3", requests: "5", score: "0.9", density: "0.18" }
  ];
  const toolRows = [
    { session_id: "s1", tool_name: "Read", is_verification: 1, use_count: "30" },
    { session_id: "s1", tool_name: "Edit", is_verification: 0, use_count: "10" },
    { session_id: "s3", tool_name: "Bash", is_verification: 0, use_count: "5" }
  ];

  const r = aggregateSignals({ sessionArea, frustrationRows, toolRows });

  const wl = r.byArea.get("work-log");
  assert.equal(wl.sessionCount, 2);
  assert.equal(wl.avgFrustration, 0.3);
  assert.equal(wl.verificationRatio, 0.75); // Read 30 / (30+10)
  assert.deepEqual(wl.topTools, [
    { tool: "Read", count: 30, isVerification: true },
    { tool: "Edit", count: 10, isVerification: false }
  ]);

  const kb = r.byArea.get("knowledge-base");
  assert.equal(kb.sessionCount, 1);
  assert.equal(kb.avgFrustration, 0.9);
  assert.equal(kb.verificationRatio, 0);

  // overall 은 영역 구분 없이 전체
  assert.equal(r.overall.sessionCount, 3);
  assert.equal(r.overall.topTools[0].tool, "Read");
  assert.equal(r.meta.fallback, false);
  assert.equal(r.meta.joinRatio, 1);

  // 아직 안 붙인 지표는 null 로 남아야 한다 (Task 6)
  assert.equal(wl.retryRate, null);
  assert.equal(wl.efficiency, null);
});

test("aggregateSignals: 세션 조인이 빈약하면 fallback=true, byArea 는 비운다", () => {
  const sessionArea = new Map([["s1", "work-log"]]);
  const frustrationRows = [
    { session_id: "zzz-1", requests: "10", score: "0.5", density: "0.05" },
    { session_id: "zzz-2", requests: "10", score: "0.5", density: "0.05" },
    { session_id: "zzz-3", requests: "10", score: "0.5", density: "0.05" },
    { session_id: "zzz-4", requests: "10", score: "0.5", density: "0.05" },
    { session_id: "zzz-5", requests: "10", score: "0.5", density: "0.05" }
  ];

  const r = aggregateSignals({ sessionArea, frustrationRows, toolRows: [] });

  assert.equal(r.meta.fallback, true);
  assert.equal(r.byArea.size, 0);
  // 조인이 안 붙어도 유저 전체 신호는 살아 있어야 한다
  assert.equal(r.overall.sessionCount, 5);
  assert.equal(r.overall.avgFrustration, 0.5);
});

test("aggregateSignals: 입력이 비면 빈 요약", () => {
  const r = aggregateSignals({ sessionArea: new Map(), frustrationRows: [], toolRows: [] });
  assert.deepEqual(r.overall, emptySummary());
  assert.equal(r.byArea.size, 0);
  assert.equal(r.meta.fallback, true);
});

test("collectBehaviorSignals: env 미설정이면 조회 없이 빈 결과", async () => {
  clearEnv();
  const r = await collectBehaviorSignals({
    userId: "default",
    fetchImpl: () => { throw new Error("should not fetch"); }
  });
  assert.equal(r.byArea.size, 0);
  assert.deepEqual(r.overall, emptySummary());
  assert.equal(r.meta.fallback, true);
});

test("collectBehaviorSignals: 브리지 → 신호 조회를 이어 붙여 영역별 요약을 만든다", async () => {
  setEnv();
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(String(init.body));
    const q = String(init.body);
    if (q.includes("FROM ai_prompts")) {
      return new Response(JSON.stringify({ data: [
        { session_id: "s1", user_id: "uid-1", project_path: "/Users/x/company-code/work-log" },
        { session_id: "s2", user_id: "uid-1", project_path: "/Users/x/company-code/work-log/src" }
      ] }), { status: 200 });
    }
    if (q.includes("FROM frustration_analysis")) {
      return new Response(JSON.stringify({ data: [
        { session_id: "s1", requests: "8", score: "0.1", density: "0.01" },
        { session_id: "s2", requests: "8", score: "0.3", density: "0.03" }
      ] }), { status: 200 });
    }
    if (q.includes("FROM tool_usage_daily")) {
      return new Response(JSON.stringify({ data: [
        { session_id: "s1", tool_name: "Read", is_verification: 1, use_count: "20" }
      ] }), { status: 200 });
    }
    throw new Error(`unexpected query: ${q.slice(0, 60)}`);
  };

  try {
    const r = await collectBehaviorSignals({ userId: "default", days: 30, fetchImpl });

    // 브리지가 먼저 불려야 한다 (user_id 를 얻어야 신호를 조회할 수 있음)
    assert.ok(bodies[0].includes("FROM ai_prompts"));
    // 신호 조회는 브리지에서 얻은 user_id 로 좁힌다
    assert.ok(bodies.slice(1).every((b) => b.includes("user_id IN")));

    // project_path 의 하위 폴더도 같은 영역으로 접힌다 (areaKey)
    const wl = r.byArea.get("work-log");
    assert.equal(wl.sessionCount, 2);
    assert.equal(wl.avgFrustration, 0.2);
    assert.equal(wl.verificationRatio, 1);
    assert.equal(r.meta.fallback, false);
  } finally {
    clearEnv();
  }
});

test("collectBehaviorSignals: ClickHouse 오류는 비치명적 — 빈 결과 + meta.error", async () => {
  setEnv();
  try {
    const r = await collectBehaviorSignals({
      userId: "default",
      fetchImpl: async () => new Response("boom", { status: 500 })
    });
    assert.equal(r.byArea.size, 0);
    assert.deepEqual(r.overall, emptySummary());
    assert.equal(r.meta.fallback, true);
    assert.ok(r.meta.error);
  } finally {
    clearEnv();
  }
});

test("collectBehaviorSignals: 브리지가 비면 신호 조회를 하지 않는다", async () => {
  setEnv();
  let calls = 0;
  try {
    const r = await collectBehaviorSignals({
      userId: "default",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
    });
    assert.equal(calls, 1);
    assert.deepEqual(r.overall, emptySummary());
  } finally {
    clearEnv();
  }
});
