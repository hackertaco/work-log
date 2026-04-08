import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let savedBlobs = {};
mock.module("./blob.mjs", {
  namedExports: {
    saveSession: async (id, data) => {
      savedBlobs[id] = JSON.parse(JSON.stringify(data));
      return { url: `blob://${id}` };
    },
    readSession: async (id) => savedBlobs[id] || null,
    deleteSession: async (id) => { delete savedBlobs[id]; },
  },
});

const { createSession, loadSession, updateSession } = await import("./resumeSessionStore.mjs");

describe("resumeSessionStore", () => {
  beforeEach(() => { savedBlobs = {}; });

  test("createSession returns a new session with version 1", async () => {
    const session = await createSession("user-1");
    assert.ok(session.sessionId.startsWith("agent-"));
    assert.equal(session.version, 1);
    assert.equal(session.userId, "user-1");
    assert.deepEqual(session.messages, []);
    assert.ok(session.agentState);
  });

  test("loadSession returns null for unknown session", async () => {
    const session = await loadSession("nonexistent");
    assert.equal(session, null);
  });

  test("loadSession returns saved session", async () => {
    const created = await createSession("user-1");
    const loaded = await loadSession(created.sessionId);
    assert.equal(loaded.sessionId, created.sessionId);
  });

  test("updateSession increments version", async () => {
    const session = await createSession("user-1");
    const updated = await updateSession(session.sessionId, session.version, (s) => {
      s.messages.push({ role: "user", content: "hello", timestamp: Date.now() });
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.messages.length, 1);
  });

  test("updateSession rejects stale version", async () => {
    const session = await createSession("user-1");
    await updateSession(session.sessionId, session.version, (s) => {
      s.messages.push({ role: "user", content: "first", timestamp: Date.now() });
    });
    await assert.rejects(
      () => updateSession(session.sessionId, 1, (s) => {
        s.messages.push({ role: "user", content: "stale", timestamp: Date.now() });
      }),
      { message: /version conflict/i }
    );
  });

  test("session schema has required fields", async () => {
    const session = await createSession("user-1");
    assert.ok(session.sessionId);
    assert.ok(session.userId);
    assert.ok(session.createdAt);
    assert.ok(session.updatedAt);
    assert.ok(Array.isArray(session.messages));
    assert.ok(session.agentState);
    assert.ok(Array.isArray(session.agentState.pendingDiffs));
    assert.ok(Array.isArray(session.agentState.pendingSuggestions));
    assert.ok(Array.isArray(session.agentState.completedSuggestions));
  });
});
