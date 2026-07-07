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
    return new Response(JSON.stringify({
      data: [
        { text: "카피 번역체 고쳐", project_path: "/x/dt-frontend", source: "claude", kst_date: "2026-06-26" },
        { text: "검정 데이터 저장", project_path: "/x/neo-fetch", source: "codex", kst_date: "2026-06-27" }
      ]
    }), { status: 200 });
  };

  const rows = await collectZeudePromptWindow("default", 30, fetchImpl);

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

test("no-op without ClickHouse config", async () => {
  const saved = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  assert.deepEqual(await collectZeudePromptWindow("default", 30, () => { throw new Error("must not fetch"); }), []);
  if (saved !== undefined) process.env.CLICKHOUSE_URL = saved;
});
