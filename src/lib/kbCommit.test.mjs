// src/lib/kbCommit.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { contentChanged, commitProfilesToKb } from "./kbCommit.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("contentChanged compares decoded base64 to new text", () => {
  assert.equal(contentChanged(b64("hello\n"), "hello\n"), false);
  assert.equal(contentChanged(b64("old"), "new"), true);
  assert.equal(contentChanged(null, "anything"), true); // no existing file
});

test("commitProfilesToKb is a no-op (no PR/merge) when all files unchanged", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/git/ref/")) return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
    if (url.includes("/contents/")) return new Response(JSON.stringify({ sha: "fsha", content: b64("same\n") }), { status: 200 });
    throw new Error("unexpected " + url);
  };
  const out = await commitProfilesToKb({ owner: "o", repo: "r", base: "main", branch: "profiles/auto",
    files: [{ path: "raw/people/x.md", content: "same\n" }], token: "t", fetchImpl });
  assert.equal(out.committed, false);
  assert.deepEqual(out.skipped, ["raw/people/x.md"]);
  assert.equal(calls.some((c) => c.startsWith("PUT")), false, "no PUT when unchanged");
  assert.equal(calls.some((c) => c.includes("/pulls")), false, "no PR when unchanged");
});

test("commitProfilesToKb PUTs changed file with prev sha, then opens+merges PR", async () => {
  const puts = [];
  const fetchImpl = async (url, init) => {
    const m = init?.method ?? "GET";
    if (url.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
    if (url.includes("/git/refs") && m === "POST") return new Response(JSON.stringify({}), { status: 201 });
    if (url.includes("/contents/") && m === "GET") return new Response(JSON.stringify({ sha: "oldsha", content: b64("old\n") }), { status: 200 });
    if (url.includes("/contents/") && m === "PUT") { puts.push(JSON.parse(init.body)); return new Response(JSON.stringify({}), { status: 200 }); }
    if (url.endsWith("/pulls") && m === "POST") return new Response(JSON.stringify({ number: 7 }), { status: 201 });
    if (url.includes("/pulls/7/merge") && m === "PUT") return new Response(JSON.stringify({ merged: true }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const out = await commitProfilesToKb({ owner: "o", repo: "r", base: "main", branch: "profiles/auto",
    files: [{ path: "raw/people/x.md", content: "new\n" }], token: "t", fetchImpl });
  assert.equal(out.committed, true);
  assert.deepEqual(out.changed, ["raw/people/x.md"]);
  assert.equal(out.pr, 7);
  assert.equal(out.merged, true);
  assert.equal(puts[0].sha, "oldsha", "PUT must carry the existing blob sha");
  assert.equal(Buffer.from(puts[0].content, "base64").toString("utf8"), "new\n");
  assert.equal(puts[0].branch, "profiles/auto");
});

test("commitProfilesToKb resets an existing work branch to base head", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const m = init?.method ?? "GET";
    calls.push({ method: m, url, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
    if (url.endsWith("/git/ref/heads/profiles/auto")) return new Response(JSON.stringify({ object: { sha: "stalebranchsha" } }), { status: 200 });
    if (url.includes("/git/refs/heads/profiles/auto") && m === "PATCH") return new Response(JSON.stringify({}), { status: 200 });
    if (url.includes("/contents/") && m === "GET") return new Response(JSON.stringify({ sha: "oldsha", content: b64("old\n") }), { status: 200 });
    if (url.includes("/contents/") && m === "PUT") return new Response(JSON.stringify({}), { status: 200 });
    if (url.endsWith("/pulls") && m === "POST") return new Response(JSON.stringify({ number: 9 }), { status: 201 });
    if (url.includes("/pulls/9/merge") && m === "PUT") return new Response(JSON.stringify({ merged: true }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const out = await commitProfilesToKb({ owner: "o", repo: "r", base: "main", branch: "profiles/auto",
    files: [{ path: "raw/people/x.md", content: "new\n" }], token: "t", fetchImpl });

  const patchIdx = calls.findIndex((c) => c.method === "PATCH" && c.url.includes("/git/refs/heads/profiles/auto"));
  const putIdx = calls.findIndex((c) => c.method === "PUT" && c.url.includes("/contents/"));
  assert.ok(patchIdx !== -1, "must reset the existing work branch");
  assert.deepEqual(calls[patchIdx].body, { sha: "basesha", force: true });
  assert.ok(patchIdx < putIdx, "branch reset must happen before the file PUT");
  assert.equal(out.committed, true);
  assert.deepEqual(out.changed, ["raw/people/x.md"]);
});
