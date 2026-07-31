import assert from "node:assert/strict";
import { mock, test } from "node:test";

let stored = null;
let priorAnalysis = null;
let extractCalls = [];
// 영역명으로 키를 잡는다 — 아래 STALE 테스트가 extractCalls 를 제자리 정렬(.sort())하므로
// 배열 인덱스로 짝을 맞추면 어긋난다.
let extractBehaviorFor = {};
let synthesizeCalls = [];
let synthesizeBehavior = null;

mock.module("./blob.mjs", {
  namedExports: {
    saveWorkStyleAnalysis: async (data) => { stored = data; return { url: "blob://x" }; },
    readWorkStyleAnalysis: async () => priorAnalysis,
    readWorklogDaily: async () => null,
    saveWorklogDaily: async () => ({ url: "" }),
    saveWorklogProfile: async () => ({ url: "" }),
    listWorklogDates: async () => [],
    // batch.mjs (imported transitively via serverCollect.mjs) also pulls from
    // ./blob.mjs; mock.module replaces the whole module namespace for every
    // importer in the process, so its imports must be stubbed here too even
    // though this test never exercises them directly.
    readSuggestionsData: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] }),
    saveBatchSummary: async () => ({ url: "" })
  }
});
mock.module("./workStyleExtract.mjs", {
  namedExports: {
    extractWorkStyleForArea: async (g, behavior) => {
      extractCalls.push(g.area);
      extractBehaviorFor[g.area] = behavior;
      return { area: g.area, did: ["did-" + g.area], judgments: [{ text: "j", evidence: "e" }] };
    },
    synthesizeWorkStylePrinciples: async (areas, behaviorByArea) => {
      synthesizeCalls.push(areas.map((a) => a.area));
      synthesizeBehavior = behaviorByArea;
      return [{ title: "원칙-A", description: "설명-A" }];
    }
  }
});
mock.module("./behaviorSignals.mjs", {
  namedExports: {
    collectBehaviorSignals: async () => ({
      byArea: new Map([["work-log", { sessionCount: 4, avgFrustration: 0.2, topTools: [] }]]),
      overall: { sessionCount: 6, avgFrustration: 0.3, topTools: [] },
      meta: { fallback: false, sessions: 6 }
    }),
    behaviorForArea: (signals, area) => signals?.byArea?.get(area) ?? null,
    behaviorByArea: (signals, names) => {
      const out = {};
      for (const n of names ?? []) {
        const b = signals?.byArea?.get(n);
        if (b) out[n] = b;
      }
      return out;
    }
  }
});

const { runWorkStyleAnalysis } = await import("./serverCollect.mjs");

const CLICKHOUSE_ENV_KEYS = ["CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD", "WORK_LOG_ZEUDE_EMAIL"];

function setClickHouseEnv() {
  process.env.CLICKHOUSE_URL = "https://clickhouse.test";
  process.env.CLICKHOUSE_USER = "u";
  process.env.CLICKHOUSE_PASSWORD = "p";
  process.env.WORK_LOG_ZEUDE_EMAIL = "user@example.com";
}

function clearClickHouseEnv() {
  for (const key of CLICKHOUSE_ENV_KEYS) delete process.env[key];
}

function mockFetchWithRows(rows) {
  const original = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ data: rows }), { status: 200 });
  return () => { global.fetch = original; };
}

test("skips when no prompts", async () => {
  const saved = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  const r = await runWorkStyleAnalysis({ userId: "default" });
  assert.equal(r.skipped, true);
  if (saved !== undefined) process.env.CLICKHOUSE_URL = saved;
});

test("STALE: prior >7d old triggers LLM re-extract and llmRefreshed:true", async () => {
  setClickHouseEnv();
  stored = null;
  extractCalls = [];
  extractBehaviorFor = {};
  synthesizeCalls = [];
  synthesizeBehavior = null;
  // 8 days before a fixed, well-in-the-past instant — avoids relying on "now" drifting.
  priorAnalysis = { llmGeneratedAt: "2020-01-01T00:00:00.000Z", areas: [] };

  const rows = [
    { text: "work-log 리팩토링 관련 질문", proj_path: "/Users/x/company-code/work-log", source: "claude", kst_date: "2026-06-01" },
    { text: "work-log 배포 관련 질문", proj_path: "/Users/x/company-code/work-log", source: "claude", kst_date: "2026-06-02" },
    { text: "knowledge-base 문서 정리", proj_path: "/Users/x/company-code/knowledge-base", source: "codex", kst_date: "2026-06-03" }
  ];
  const restoreFetch = mockFetchWithRows(rows);

  try {
    const r = await runWorkStyleAnalysis({ userId: "default" });
    assert.equal(r.skipped, false);
    assert.equal(r.llmRefreshed, true);

    assert.ok(stored, "saveWorkStyleAnalysis should have been called");
    assert.ok(stored.areas.length > 0);
    for (const a of stored.areas) {
      assert.deepEqual(a.did, ["did-" + a.area]);
      assert.deepEqual(a.judgments, [{ text: "j", evidence: "e" }]);
    }
    // extractor should have been invoked once per grouped area
    assert.deepEqual(extractCalls.sort(), stored.areas.map((a) => a.area).sort());
    // synthesis runs on the STALE path and its principles are saved
    assert.equal(synthesizeCalls.length, 1);
    assert.deepEqual(stored.principles, [{ title: "원칙-A", description: "설명-A" }]);
    assert.equal(r.principleCount, 1);

    // 행동신호가 영역별로 추출기에 전달돼야 한다
    assert.equal(extractBehaviorFor["work-log"]?.sessionCount, 4);
    // 신호 없는 영역은 null 로 넘어간다 (v1 동작)
    assert.equal(extractBehaviorFor["knowledge-base"], null);
    // 합성에도 영역별 신호가 전달된다
    assert.equal(synthesizeBehavior?.["work-log"]?.sessionCount, 4);
    // 운영 관측용 카운트
    assert.equal(r.behaviorSessions, 6);
  } finally {
    restoreFetch();
    clearClickHouseEnv();
  }
});

test("FRESH: prior <7d old reuses prior did/judgments and llmRefreshed:false", async () => {
  setClickHouseEnv();
  stored = null;
  extractCalls = [];
  extractBehaviorFor = {};
  synthesizeCalls = [];
  synthesizeBehavior = null;
  const recentIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  priorAnalysis = {
    llmGeneratedAt: recentIso,
    principles: [{ title: "이전-원칙", description: "이전-설명" }],
    areas: [
      {
        area: "work-log",
        promptCount: 1,
        firstDate: "2026-05-01",
        lastDate: "2026-05-02",
        did: ["prior-did"],
        judgments: [{ text: "prior-judgment", evidence: "prior-evidence" }]
      }
    ]
  };

  const rows = [
    { text: "work-log 관련 프롬프트", proj_path: "/Users/x/company-code/work-log", source: "claude", kst_date: "2026-06-01" }
  ];
  const restoreFetch = mockFetchWithRows(rows);

  try {
    const r = await runWorkStyleAnalysis({ userId: "default" });
    assert.equal(r.skipped, false);
    assert.equal(r.llmRefreshed, false);

    assert.ok(stored, "saveWorkStyleAnalysis should have been called");
    const area = stored.areas.find((a) => a.area === "work-log");
    assert.ok(area, "grouped area should match the prior area by name");
    assert.deepEqual(area.did, ["prior-did"]);
    assert.deepEqual(area.judgments, [{ text: "prior-judgment", evidence: "prior-evidence" }]);

    // FRESH path only refreshes counts — extractor and synthesis must not run
    assert.equal(extractCalls.length, 0);
    assert.equal(synthesizeCalls.length, 0);
    // principles are carried over from the prior analysis unchanged
    assert.deepEqual(stored.principles, [{ title: "이전-원칙", description: "이전-설명" }]);

    // FRESH 경로는 신호를 아예 수집하지 않는다 (불필요한 ClickHouse 조회 금지)
    assert.equal(r.behaviorSessions, null);
  } finally {
    restoreFetch();
    clearClickHouseEnv();
  }
});

test("경로 없는 프롬프트는 원칙 합성에만 들어가고 영역 목록엔 안 남는다", async () => {
  setClickHouseEnv();
  stored = null;
  extractCalls = [];
  extractBehaviorFor = {};
  synthesizeCalls = [];
  synthesizeBehavior = null;
  priorAnalysis = { llmGeneratedAt: "2020-01-01T00:00:00.000Z", areas: [] };

  const rows = [
    { text: "work-log 관련 질문입니다", proj_path: "/Users/x/company-code/work-log", source: "claude", kst_date: "2026-07-30" },
    { text: "폴더 없는 코덱스 질문", proj_path: "", source: "codex", kst_date: "2026-07-30" },
    { text: "폴더 없는 코덱스 질문 둘", proj_path: "", source: "codex", kst_date: "2026-07-31" }
  ];
  const restoreFetch = mockFetchWithRows(rows);

  try {
    const r = await runWorkStyleAnalysis({ userId: "default" });

    // 저장되는 영역 목록엔 경로 있는 것만 남는다
    assert.deepEqual(stored.areas.map((a) => a.area), ["work-log"]);
    // 추출기는 "영역 미상" 묶음에도 한 번 불린다
    assert.ok(extractCalls.includes("영역 미상"));
    // 그 판단이 합성 입력에는 들어간다
    assert.ok(synthesizeCalls[0].includes("영역 미상"));
    // 운영 관측용 카운트
    assert.equal(r.arealessCount, 2);
  } finally {
    restoreFetch();
    clearClickHouseEnv();
  }
});
