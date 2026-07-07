import assert from "node:assert/strict";
import test from "node:test";

import { collectZeudePromptWindow } from "./serverCollect.mjs";

test("maps window rows and passes days param; returns local commit-window shape", async () => {
  const saved = {
    url: process.env.CLICKHOUSE_URL, user: process.env.CLICKHOUSE_USER,
    pw: process.env.CLICKHOUSE_PASSWORD, email: process.env.WORK_LOG_ZEUDE_EMAIL
  };
  process.env.CLICKHOUSE_URL = "http://ch.example:8123";
  process.env.CLICKHOUSE_USER = "default";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  process.env.WORK_LOG_ZEUDE_EMAIL = "seungah.jung@tgsociety.co.kr";

  let capturedBody = "";
  let capturedUrl = "";
  const fetchImpl = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = init.body;
    // ClickHouse 는 ORDER BY max(timestamp) DESC 로 최신순으로 반환한다
    return new Response(JSON.stringify({
      data: [
        { text: "검정 데이터 저장", project_path: "/x/neo-fetch", source: "codex", kst_date: "2026-06-27" },
        { text: "카피 번역체 고쳐", project_path: "/x/dt-frontend", source: "claude", kst_date: "2026-06-26" }
      ]
    }), { status: 200 });
  };

  const rows = await collectZeudePromptWindow("default", 30, fetchImpl);

  // 함수는 시간순(오래된→최신)으로 뒤집어 반환해야 한다
  assert.deepEqual(rows, [
    { text: "카피 번역체 고쳐", projectPath: "/x/dt-frontend", source: "claude", date: "2026-06-26" },
    { text: "검정 데이터 저장", projectPath: "/x/neo-fetch", source: "codex", date: "2026-06-27" }
  ]);
  assert.ok(capturedBody.includes("INTERVAL 30 DAY"));
  assert.ok(capturedUrl.includes("param_email=seungah.jung%40tgsociety.co.kr"));

  for (const [k, v] of [["CLICKHOUSE_URL", saved.url], ["CLICKHOUSE_USER", saved.user], ["CLICKHOUSE_PASSWORD", saved.pw], ["WORK_LOG_ZEUDE_EMAIL", saved.email]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("query orders by max(timestamp) DESC so LIMIT keeps the newest rows", async () => {
  const saved = {
    url: process.env.CLICKHOUSE_URL, user: process.env.CLICKHOUSE_USER,
    pw: process.env.CLICKHOUSE_PASSWORD, email: process.env.WORK_LOG_ZEUDE_EMAIL
  };
  process.env.CLICKHOUSE_URL = "http://ch.example:8123";
  process.env.CLICKHOUSE_USER = "default";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  process.env.WORK_LOG_ZEUDE_EMAIL = "seungah.jung@tgsociety.co.kr";

  let capturedBody = "";
  const fetchImpl = async (_url, init) => {
    capturedBody = init.body;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  await collectZeudePromptWindow("default", 30, fetchImpl);

  assert.ok(capturedBody.includes("ORDER BY max(timestamp) DESC"));

  for (const [k, v] of [["CLICKHOUSE_URL", saved.url], ["CLICKHOUSE_USER", saved.user], ["CLICKHOUSE_PASSWORD", saved.pw], ["WORK_LOG_ZEUDE_EMAIL", saved.email]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("reverses DESC rows back to chronological ascending order", async () => {
  const saved = {
    url: process.env.CLICKHOUSE_URL, user: process.env.CLICKHOUSE_USER,
    pw: process.env.CLICKHOUSE_PASSWORD, email: process.env.WORK_LOG_ZEUDE_EMAIL
  };
  process.env.CLICKHOUSE_URL = "http://ch.example:8123";
  process.env.CLICKHOUSE_USER = "default";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  process.env.WORK_LOG_ZEUDE_EMAIL = "seungah.jung@tgsociety.co.kr";

  // 서버가 LIMIT 2000 으로 잘라도 최신 데이터가 남도록 DESC(최신순)로 온다고 가정한 3행 fixture
  const fetchImpl = async () => new Response(JSON.stringify({
    data: [
      { text: "third newest", project_path: "/x/a", source: "claude", kst_date: "2026-06-28" },
      { text: "second", project_path: "/x/b", source: "claude", kst_date: "2026-06-27" },
      { text: "oldest", project_path: "/x/c", source: "codex", kst_date: "2026-06-26" }
    ]
  }), { status: 200 });

  const rows = await collectZeudePromptWindow("default", 30, fetchImpl);

  assert.deepEqual(rows.map((r) => r.date), ["2026-06-26", "2026-06-27", "2026-06-28"]);
  assert.deepEqual(rows.map((r) => r.text), ["oldest", "second", "third newest"]);

  for (const [k, v] of [["CLICKHOUSE_URL", saved.url], ["CLICKHOUSE_USER", saved.user], ["CLICKHOUSE_PASSWORD", saved.pw], ["WORK_LOG_ZEUDE_EMAIL", saved.email]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("throws when ClickHouse responds with a non-ok status", async () => {
  const saved = {
    url: process.env.CLICKHOUSE_URL, user: process.env.CLICKHOUSE_USER,
    pw: process.env.CLICKHOUSE_PASSWORD, email: process.env.WORK_LOG_ZEUDE_EMAIL
  };
  process.env.CLICKHOUSE_URL = "http://ch.example:8123";
  process.env.CLICKHOUSE_USER = "default";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  process.env.WORK_LOG_ZEUDE_EMAIL = "seungah.jung@tgsociety.co.kr";

  const fetchImpl = async () => new Response("boom", { status: 500 });

  await assert.rejects(() => collectZeudePromptWindow("default", 30, fetchImpl));

  for (const [k, v] of [["CLICKHOUSE_URL", saved.url], ["CLICKHOUSE_USER", saved.user], ["CLICKHOUSE_PASSWORD", saved.pw], ["WORK_LOG_ZEUDE_EMAIL", saved.email]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("no-op without ClickHouse config", async () => {
  const saved = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  assert.deepEqual(await collectZeudePromptWindow("default", 30, () => { throw new Error("must not fetch"); }), []);
  if (saved !== undefined) process.env.CLICKHOUSE_URL = saved;
});
