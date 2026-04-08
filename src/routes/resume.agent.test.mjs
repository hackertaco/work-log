/**
 * Tests for POST /api/resume/agent SSE endpoint.
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.agent.test.mjs
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { Hono } from "hono";

// ─── Module-level mocks ────────────────────────────────────────────────────────

const mockCreateSession = mock.fn(async (userId) => ({
  sessionId: "agent-test-123",
  userId,
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messages: [],
  agentState: { pendingDiffs: [], pendingSuggestions: [], completedSuggestions: [], resumeVersion: 0 },
}));

const mockLoadSession = mock.fn(async () => null);

const mockUpdateSession = mock.fn(async (id, version, mutator) => {
  const session = {
    sessionId: id,
    version,
    updatedAt: new Date().toISOString(),
    messages: [],
    agentState: { pendingDiffs: [], pendingSuggestions: [], completedSuggestions: [], resumeVersion: 0 },
  };
  mutator(session);
  session.version += 1;
  return session;
});

mock.module("../lib/resumeSessionStore.mjs", {
  namedExports: {
    createSession: mockCreateSession,
    loadSession: mockLoadSession,
    updateSession: mockUpdateSession,
  },
});

const mockRunAgentLoop = mock.fn(async ({ onEvent }) => {
  onEvent({ type: "message", content: "Hello from agent" });
});

mock.module("../lib/resumeAgent.mjs", {
  namedExports: {
    runAgentLoop: mockRunAgentLoop,
  },
});

mock.module("../lib/blob.mjs", {
  namedExports: {
    readResumeData: async () => ({ contact: { name: "Test User" } }),
    checkResumeExists: async () => ({ exists: false }),
    saveResumeData: async () => ({ url: "https://blob/resume/data.json" }),
    readSuggestionsData: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] }),
    saveSuggestionsData: async () => ({ url: "https://blob/resume/suggestions.json" }),
    saveDailyBullets: async () => ({ url: "https://blob/resume/bullets/test.json" }),
    readDailyBullets: async () => null,
    listBulletDates: async () => [],
    deleteDailyBullets: async () => {},
    savePdfText: async () => ({ url: "https://blob/resume/pdf-text.txt" }),
    readPdfText: async () => null,
    savePdfRaw: async () => ({ url: "https://blob/resume/resume.pdf" }),
    checkPdfRawExists: async () => ({ exists: true, url: "https://blob/resume/resume.pdf" }),
    PDF_RAW_PATHNAME: "resume/resume.pdf",
    markResumeForReconstruction: async () => {},
    clearReconstructionMarker: async () => {},
    checkReconstructionMarker: async () => ({ needsRebuild: false }),
    saveKeywordClusterAxes: async () => ({ url: "https://blob/resume/keyword-cluster-axes.json" }),
    readKeywordClusterAxes: async () => null,
    SNAPSHOTS_PREFIX: "resume/snapshots/",
    saveSnapshot: async () => ({ snapshotKey: "resume/snapshots/test.json", url: "https://blob/test" }),
    listSnapshots: async () => [],
    readSnapshotByKey: async () => null,
    readStrengthKeywords: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "system", keywords: [] }),
    saveStrengthKeywords: async () => ({ url: "https://blob/resume/strength-keywords.json" }),
    STRENGTH_KEYWORDS_PATHNAME: "resume/strength-keywords.json",
    saveDisplayAxes: async () => ({ url: "https://blob/resume/display-axes.json" }),
    readDisplayAxes: async () => null,
    DISPLAY_AXES_PATHNAME: "resume/display-axes.json",
    saveIdentifiedStrengths: async () => ({ url: "https://blob/resume/identified-strengths.json" }),
    readIdentifiedStrengths: async () => null,
    saveNarrativeAxes: async () => ({ url: "https://blob/resume/narrative-axes.json" }),
    readNarrativeAxes: async () => null,
    saveNarrativeThreading: async () => ({ url: "https://blob/resume/narrative-threading.json" }),
    readNarrativeThreading: async () => null,
    saveSectionBridges: async () => ({ url: "https://blob/resume/section-bridges.json" }),
    readSectionBridges: async () => null,
    readQualityTracking: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), records: [] }),
    saveQualityTracking: async () => ({ url: "https://blob/resume/quality-tracking.json" }),
    saveChatDraft: async () => ({ url: "https://blob/resume/chat-draft.json" }),
    readChatDraft: async () => null,
    saveChatDraftContext: async () => ({ url: "https://blob/resume/chat-draft-context.json" }),
    readChatDraftContext: async () => null,
    saveSession: async () => ({ url: "https://blob/resume/session.json" }),
    readSession: async () => null,
  },
});

// ─── Dynamic import after mocks ────────────────────────────────────────────────

const { agentRouter } = await import("./resume.agent.mjs");

const app = new Hono();
app.route("/api/resume", agentRouter);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function post(path, body) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readSSEEvents(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.replace("data: ", "")));
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test("missing action → 400", async () => {
  const res = await post("/api/resume/agent", {});
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Missing action/);
});

test("unknown action → 400", async () => {
  const res = await post("/api/resume/agent", { action: "dance" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Unknown action/);
});

test("message without sessionId → 400", async () => {
  const res = await post("/api/resume/agent", { action: "message", text: "hello" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Missing sessionId/);
});

test("message without text → 400", async () => {
  const res = await post("/api/resume/agent", { action: "message", sessionId: "s1" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Missing text/);
});

test("approve_diff without messageId → 400", async () => {
  const res = await post("/api/resume/agent", { action: "approve_diff", sessionId: "s1" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Missing messageId/);
});

test("reject_diff without sessionId → 400", async () => {
  const res = await post("/api/resume/agent", { action: "reject_diff", messageId: "m1" });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Missing sessionId/);
});

test("init creates session and returns SSE stream", async () => {
  mockCreateSession.mock.resetCalls();
  mockRunAgentLoop.mock.resetCalls();

  const res = await post("/api/resume/agent", { action: "init" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/event-stream");

  const events = await readSSEEvents(res);
  // First event should be session creation
  const sessionEvent = events.find((e) => e.type === "session");
  assert.ok(sessionEvent, "should have session event");
  assert.equal(sessionEvent.sessionId, "agent-test-123");

  // Should have a message from agent
  const msgEvent = events.find((e) => e.type === "message");
  assert.ok(msgEvent, "should have message event");

  // Should have done event
  const doneEvent = events.find((e) => e.type === "done");
  assert.ok(doneEvent, "should have done event");

  assert.equal(mockCreateSession.mock.callCount(), 1);
  assert.equal(mockRunAgentLoop.mock.callCount(), 1);
});

test("approve_diff with session not found → 404", async () => {
  mockLoadSession.mock.resetCalls();
  // loadSession returns null by default
  const res = await post("/api/resume/agent", {
    action: "approve_diff",
    sessionId: "nonexistent",
    messageId: "m1",
  });
  assert.equal(res.status, 404);
});

test("reject_diff with session not found → 404", async () => {
  mockLoadSession.mock.resetCalls();
  const res = await post("/api/resume/agent", {
    action: "reject_diff",
    sessionId: "nonexistent",
    messageId: "m1",
  });
  assert.equal(res.status, 404);
});

test("revise_diff without messageId → 400", async () => {
  const res = await post("/api/resume/agent", {
    action: "revise_diff",
    sessionId: "s1",
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Missing messageId/);
});
