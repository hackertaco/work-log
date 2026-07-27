import assert from "node:assert/strict";
import test from "node:test";
import { notifyMemberProfile } from "./slackNotify.mjs";

test("returns false without token or slackUserId (no fetch)", async () => {
  assert.equal(await notifyMemberProfile({ slackUserId: "", url: "u", token: "", fetchImpl: () => { throw new Error("x"); } }), false);
  assert.equal(await notifyMemberProfile({ slackUserId: "U1", url: "u", token: "", fetchImpl: () => { throw new Error("x"); } }), false);
});

test("opens DM channel then posts message", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes("conversations.open")) return new Response(JSON.stringify({ ok: true, channel: { id: "D1" } }), { status: 200 });
    if (url.includes("chat.postMessage")) { const b = JSON.parse(init.body); assert.equal(b.channel, "D1"); assert.match(b.text, /업무방식/); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    throw new Error("unexpected");
  };
  assert.equal(await notifyMemberProfile({ slackUserId: "U1", url: "https://kb/x", token: "t", fetchImpl }), true);
  assert.ok(calls.some((c) => c.includes("conversations.open")) && calls.some((c) => c.includes("chat.postMessage")));
});
