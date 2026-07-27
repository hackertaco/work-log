import assert from "node:assert/strict";
import test, { mock } from "node:test";

test("skips users with no analysis; builds md for those with; commits once", async () => {
  const analyses = { seungah: { windowDays: 30, principles: [{ title: "P", description: "d" }], areas: [{ area: "a", promptCount: 5, judgments: [] }] }, empty: null };
  mock.module("./blob.mjs", { namedExports: { readWorkStyleAnalysis: async (id) => analyses[id] } });
  mock.module("./handoverSynthesis.mjs", { namedExports: { synthesizeHandover: async () => ({ oneLiner: "o", personaPrompt: "pp", howToWork: [], whatToAsk: [], strengths: [], heuristics: [] }) } });
  let committedFiles = null;
  mock.module("./kbCommit.mjs", { namedExports: { commitProfilesToKb: async ({ files }) => { committedFiles = files; return { committed: true, changed: files.map((f) => f.path), skipped: [], pr: 1, merged: true }; } } });
  mock.module("./slackNotify.mjs", { namedExports: { notifyMemberProfile: async () => true } });
  mock.module("./config.mjs", { namedExports: { loadConfig: () => ({ slackUserId: "" }) } });

  const saved = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = "t";
  const { runProfileExport } = await import("./profileExport.mjs?" + Math.random());
  const out = await runProfileExport({ userIds: ["seungah", "empty"], now: "2026-07-27T00:00:00Z" });
  assert.deepEqual(out.built, ["seungah"]);
  assert.equal(committedFiles.length, 1);
  assert.equal(committedFiles[0].path, "raw/people/seungah.md");
  assert.match(committedFiles[0].content, /seungah — 업무방식/);
  if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
});

test("does not notify when commit changed files but PR did not merge", async () => {
  mock.reset();
  const analyses = { seungah: { windowDays: 30, principles: [{ title: "P", description: "d" }], areas: [{ area: "a", promptCount: 5, judgments: [] }] } };
  mock.module("./blob.mjs", { namedExports: { readWorkStyleAnalysis: async (id) => analyses[id] } });
  mock.module("./handoverSynthesis.mjs", { namedExports: { synthesizeHandover: async () => ({ oneLiner: "o", personaPrompt: "pp", howToWork: [], whatToAsk: [], strengths: [], heuristics: [] }) } });
  mock.module("./kbCommit.mjs", { namedExports: { commitProfilesToKb: async () => ({ committed: true, changed: ["raw/people/x.md"], skipped: [], pr: 1, merged: false }) } });
  const notifySpy = mock.fn(async () => true);
  mock.module("./slackNotify.mjs", { namedExports: { notifyMemberProfile: notifySpy } });
  mock.module("./config.mjs", { namedExports: { loadConfig: () => ({ slackUserId: "" }) } });

  const saved = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = "t";
  const { runProfileExport } = await import("./profileExport.mjs?" + Math.random());
  await runProfileExport({ userIds: ["seungah"], now: "2026-07-27T00:00:00Z" });
  assert.equal(notifySpy.mock.callCount(), 0);
  if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
});
