/**
 * Tests for server-side daily collection (serverCollect.mjs).
 *
 * Covers:
 *   - collectGithubCommits: search-result mapping into the local commit shape
 *   - collectZeudePrompts: KST window params + row mapping + missing-config no-op
 *   - seoulDate: KST formatting
 *
 * Run:
 *   node --experimental-test-module-mocks --test src/lib/serverCollect.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { collectGithubCommits, collectZeudePrompts, seoulDate } from "./serverCollect.mjs";

test("seoulDate formats as YYYY-MM-DD", () => {
  assert.match(seoulDate(), /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(seoulDate(-1), seoulDate(0));
});

test("collectGithubCommits maps search results into the local commit shape", async () => {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/user")) {
      return new Response(JSON.stringify({ login: "hackertaco" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        total_count: 2,
        items: [
          {
            sha: "abcdef1234567",
            repository: { name: "work-log" },
            commit: { message: "Sync work logs to Blob\n\nbody", author: { date: "2026-07-02T10:00:00Z" } }
          },
          {
            sha: "1234567abcdef",
            repository: { name: "driving-teacher-frontend" },
            commit: { message: "Fix reservation flow", author: { date: "2026-07-02T11:00:00Z" } }
          }
        ]
      }),
      { status: 200 }
    );
  };

  const commits = await collectGithubCommits("2026-07-02", fetchImpl);

  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    repo: "work-log",
    repoPath: "/Documents/company-code/work-log",
    hash: "abcdef1",
    authoredAt: "2026-07-02T10:00:00Z",
    subject: "Sync work logs to Blob"
  });
  assert.ok(calls.some((u) => u.includes("author%3Ahackertaco") || u.includes("author:hackertaco")));
  assert.ok(calls.some((u) => u.includes("committer-date%3A2026-07-02") || u.includes("committer-date:2026-07-02")));

  if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
});

test("collectGithubCommits returns empty without a token", async () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  assert.deepEqual(await collectGithubCommits("2026-07-02", () => { throw new Error("must not fetch"); }), []);
  if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
});

test("collectZeudePrompts maps rows and passes the KST date window params", async () => {
  const saved = { url: process.env.CLICKHOUSE_URL, user: process.env.CLICKHOUSE_USER, pw: process.env.CLICKHOUSE_PASSWORD, email: process.env.WORK_LOG_ZEUDE_EMAIL };
  process.env.CLICKHOUSE_URL = "http://ch.example:8123";
  process.env.CLICKHOUSE_USER = "default";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  process.env.WORK_LOG_ZEUDE_EMAIL = "seungah.jung@tgsociety.co.kr";

  let capturedUrl = "";
  let capturedBody = "";
  const fetchImpl = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = init.body;
    return new Response(
      JSON.stringify({
        data: [
          { source: "claude", text: "work-log 서버 수집기 만들어줘" },
          { source: "codex", text: "예약 대시보드 버그 고쳐줘" }
        ]
      }),
      { status: 200 }
    );
  };

  const prompts = await collectZeudePrompts("2026-07-02", {}, fetchImpl);

  assert.deepEqual(prompts, [
    { source: "claude", text: "work-log 서버 수집기 만들어줘" },
    { source: "codex", text: "예약 대시보드 버그 고쳐줘" }
  ]);
  assert.ok(capturedUrl.includes("param_email=seungah.jung%40tgsociety.co.kr"));
  assert.ok(capturedUrl.includes("param_date=2026-07-02"));
  assert.ok(capturedBody.includes("INTERVAL 9 HOUR"), "KST window must shift by 9 hours");

  for (const [k, v] of [["CLICKHOUSE_URL", saved.url], ["CLICKHOUSE_USER", saved.user], ["CLICKHOUSE_PASSWORD", saved.pw], ["WORK_LOG_ZEUDE_EMAIL", saved.email]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("collectZeudePrompts is a no-op without ClickHouse config", async () => {
  const saved = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  assert.deepEqual(await collectZeudePrompts("2026-07-02", {}, () => { throw new Error("must not fetch"); }), []);
  if (saved !== undefined) process.env.CLICKHOUSE_URL = saved;
});
