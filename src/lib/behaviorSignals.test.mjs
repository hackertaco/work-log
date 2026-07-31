import assert from "node:assert/strict";
import test from "node:test";

import { aggregateSignals, behaviorByArea, behaviorForArea, collectBehaviorSignals, emptySummary } from "./behaviorSignals.mjs";

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
    if (q.includes("FROM retry_analysis")) {
      return new Response(JSON.stringify({ data: [{ session_id: "s1", rate: "0.2" }] }), { status: 200 });
    }
    if (q.includes("FROM efficiency_metrics_daily")) {
      // 이 테이블엔 session_id 가 없다 — 유저 전체 한 줄만 온다
      return new Response(JSON.stringify({ data: [{ efficiency: "0.9" }] }), { status: 200 });
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

    // retry 는 세션이 있어 영역에 붙는다
    assert.equal(wl.retryRate, 0.2);
    // efficiency 는 세션이 없어 영역엔 안 붙고 유저 전체에만 반영된다
    assert.equal(wl.efficiency, null);
    assert.equal(r.overall.efficiency, 0.9);
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

// ─── behaviorForArea / behaviorByArea ────────────────────────────────────────

const SUMMARY_A = { ...emptySummary(), sessionCount: 3, avgFrustration: 0.2 };
const SUMMARY_ALL = { ...emptySummary(), sessionCount: 9, avgFrustration: 0.5 };

test("behaviorForArea: 영역 신호가 있으면 그걸 쓴다", () => {
  const signals = {
    byArea: new Map([["work-log", SUMMARY_A]]),
    overall: SUMMARY_ALL,
    meta: { fallback: false }
  };
  assert.deepEqual(behaviorForArea(signals, "work-log"), SUMMARY_A);
});

test("behaviorForArea: 폴백이면 모든 영역이 유저 전체 신호를 쓴다", () => {
  const signals = { byArea: new Map(), overall: SUMMARY_ALL, meta: { fallback: true } };
  assert.deepEqual(behaviorForArea(signals, "work-log"), SUMMARY_ALL);
  assert.deepEqual(behaviorForArea(signals, "knowledge-base"), SUMMARY_ALL);
});

test("behaviorForArea: 신호가 아예 없으면 null (v1 동작)", () => {
  assert.equal(behaviorForArea(null, "work-log"), null);
  assert.equal(
    behaviorForArea({ byArea: new Map(), overall: emptySummary(), meta: { fallback: true } }, "work-log"),
    null
  );
});

test("behaviorForArea: 폴백 아닌데 그 영역 신호가 없으면 null", () => {
  const signals = { byArea: new Map([["work-log", SUMMARY_A]]), overall: SUMMARY_ALL, meta: { fallback: false } };
  assert.equal(behaviorForArea(signals, "neo-fetch"), null);
});

test("behaviorByArea: 값 있는 영역만 객체로 모은다", () => {
  const signals = { byArea: new Map([["work-log", SUMMARY_A]]), overall: SUMMARY_ALL, meta: { fallback: false } };
  assert.deepEqual(behaviorByArea(signals, ["work-log", "neo-fetch"]), { "work-log": SUMMARY_A });
  assert.deepEqual(behaviorByArea(null, ["work-log"]), {});
});

// ─── retry / efficiency ──────────────────────────────────────────────────────

test("aggregateSignals: 재시도율·효율을 영역별로 평균한다", () => {
  const sessionArea = new Map([["s1", "work-log"], ["s2", "work-log"]]);
  const r = aggregateSignals({
    sessionArea,
    frustrationRows: [{ session_id: "s1", score: "0.1", density: "0.01" }],
    toolRows: [],
    retryRows: [
      { session_id: "s1", rate: "0.1" },
      { session_id: "s2", rate: "0.3" }
    ],
    efficiencyRows: [
      { session_id: "s1", efficiency: "0.8" },
      { session_id: "s2", efficiency: "0.6" }
    ]
  });

  const wl = r.byArea.get("work-log");
  assert.equal(wl.retryRate, 0.2);
  assert.equal(wl.efficiency, 0.7);
  assert.equal(r.overall.retryRate, 0.2);
});

test("aggregateSignals: 세션 없는 효율 행은 전체에만 쌓이고 조인율을 깎지 않는다", () => {
  const r = aggregateSignals({
    sessionArea: new Map([["s1", "work-log"]]),
    frustrationRows: [{ session_id: "s1", score: "0.1", density: "0.01" }],
    efficiencyRows: [{ session_id: "", efficiency: "0.9" }]
  });

  assert.equal(r.meta.joinRatio, 1, "세션 없는 행은 조인율 분모에서 빠져야 한다");
  assert.equal(r.meta.fallback, false);
  assert.equal(r.byArea.get("work-log").efficiency, null);
  assert.equal(r.overall.efficiency, 0.9);
});

test("aggregateSignals: 재시도·효율 행이 없으면 두 지표는 null", () => {
  const r = aggregateSignals({
    sessionArea: new Map([["s1", "work-log"]]),
    frustrationRows: [{ session_id: "s1", score: "0.1", density: "0.01" }],
    toolRows: []
  });
  assert.equal(r.byArea.get("work-log").retryRate, null);
  assert.equal(r.byArea.get("work-log").efficiency, null);
});

test("aggregateSignals: 명시적 null 행 배열을 넘겨도 던지지 않는다", () => {
  assert.doesNotThrow(() =>
    aggregateSignals({
      sessionArea: new Map(),
      frustrationRows: null,
      toolRows: null,
      retryRows: null,
      efficiencyRows: null
    })
  );
  assert.doesNotThrow(() => aggregateSignals());
});
