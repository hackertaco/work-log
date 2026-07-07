import assert from "node:assert/strict";
import { mock, test } from "node:test";

let stored = null;
let priorAnalysis = null;
let extractCalls = [];

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
    extractWorkStyleForArea: async (g) => {
      extractCalls.push(g.area);
      return { area: g.area, did: ["did-" + g.area], judgments: [{ text: "j", evidence: "e" }] };
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
  // 8 days before a fixed, well-in-the-past instant — avoids relying on "now" drifting.
  priorAnalysis = { llmGeneratedAt: "2020-01-01T00:00:00.000Z", areas: [] };

  const rows = [
    { text: "work-log 리팩토링 관련 질문", project_path: "/Users/x/company-code/work-log", source: "claude", kst_date: "2026-06-01" },
    { text: "work-log 배포 관련 질문", project_path: "/Users/x/company-code/work-log", source: "claude", kst_date: "2026-06-02" },
    { text: "knowledge-base 문서 정리", project_path: "/Users/x/company-code/knowledge-base", source: "codex", kst_date: "2026-06-03" }
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
  } finally {
    restoreFetch();
    clearClickHouseEnv();
  }
});

test("FRESH: prior <7d old reuses prior did/judgments and llmRefreshed:false", async () => {
  setClickHouseEnv();
  stored = null;
  extractCalls = [];
  const recentIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  priorAnalysis = {
    llmGeneratedAt: recentIso,
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
    { text: "work-log 관련 프롬프트", project_path: "/Users/x/company-code/work-log", source: "claude", kst_date: "2026-06-01" }
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

    // FRESH path only refreshes counts — the extractor must not be called
    assert.equal(extractCalls.length, 0);
  } finally {
    restoreFetch();
    clearClickHouseEnv();
  }
});
