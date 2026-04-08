# Resume Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace rule-based intent classification with a ReAct agent loop that proactively suggests resume improvements and executes them via tool calling.

**Architecture:** 2-pass ReAct agent (analysis pass on init, execution pass on user input) with 4 tools, Vercel Blob session storage, SSE streaming, and Hono router. Existing search/draft logic is wrapped as tools, not rewritten.

**Tech Stack:** Hono (HTTP/SSE), OpenAI Responses API (gpt-5.4, tool_use), Vercel Blob (sessions), node:test (testing), Preact (frontend)

**Spec:** `docs/superpowers/specs/2026-04-08-resume-agent-architecture-design.md`

---

## File Structure

| File | Responsibility | Status |
|------|---------------|--------|
| `src/lib/resumeSessionStore.mjs` | Vercel Blob session CRUD + optimistic locking | Create |
| `src/lib/resumeSessionStore.test.mjs` | Session store unit tests | Create |
| `src/lib/resumeAgentTools.mjs` | 4 tool definitions + parsedQuery adapter | Create |
| `src/lib/resumeAgentTools.test.mjs` | Tool wrapper unit tests | Create |
| `src/lib/resumeAgent.mjs` | ReAct loop orchestrator + LLM calling | Create |
| `src/lib/resumeAgent.test.mjs` | Agent loop unit tests | Create |
| `src/routes/resume.agent.mjs` | POST /api/resume/agent SSE endpoint | Create |
| `src/routes/resume.agent.test.mjs` | Endpoint integration tests | Create |
| `frontend/src/hooks/useResumeAgent.js` | SSE client hook | Create |
| `frontend/src/pages/ResumeChatPage.jsx` | Wire up useResumeAgent | Modify |
| `src/lib/resumeEvidenceSearch.mjs` | Fix .catch(()=>[]) error propagation | Modify |
| `src/lib/blob.mjs` | Add session blob helpers | Modify |
| `src/routes/resume.mjs` | Mount agent router | Modify |
| `src/server.mjs` | Register agent route | Modify |

---

### Task 1: Session Store (Vercel Blob)

**Files:**
- Create: `src/lib/resumeSessionStore.mjs`
- Create: `src/lib/resumeSessionStore.test.mjs`
- Modify: `src/lib/blob.mjs` (add session blob helpers)

- [ ] **Step 1: Add session blob helpers to blob.mjs**

Add at the end of `src/lib/blob.mjs`:

```javascript
// ── Session storage ─────────────────────────────────────────────────────

const SESSION_PREFIX = "resume/sessions/";

export async function saveSession(sessionId, data) {
  const pathname = `${SESSION_PREFIX}${sessionId}.json`;
  const json = JSON.stringify(data);
  const result = await put(pathname, json, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return { url: result.url };
}

export async function readSession(sessionId) {
  const pathname = `${SESSION_PREFIX}${sessionId}.json`;
  return readPrivateJsonBlob(pathname);
}

export async function deleteSession(sessionId) {
  const pathname = `${SESSION_PREFIX}${sessionId}.json`;
  return deleteBlob(pathname);
}
```

- [ ] **Step 2: Write failing tests for session store**

Create `src/lib/resumeSessionStore.test.mjs`:

```javascript
import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Mock blob.mjs before importing session store
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
    // Try to update with stale version 1
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test src/lib/resumeSessionStore.test.mjs`
Expected: FAIL — module `./resumeSessionStore.mjs` not found

- [ ] **Step 4: Implement session store**

Create `src/lib/resumeSessionStore.mjs`:

```javascript
import { saveSession, readSession } from "./blob.mjs";

/**
 * Create a new agent session.
 * @param {string} userId
 * @returns {Promise<Object>} session
 */
export async function createSession(userId) {
  const sessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const session = {
    sessionId,
    userId,
    version: 1,
    createdAt: now,
    updatedAt: now,
    messages: [],
    agentState: {
      pendingDiffs: [],
      pendingSuggestions: [],
      completedSuggestions: [],
      resumeVersion: 0,
    },
  };
  await saveSession(sessionId, session);
  return session;
}

/**
 * Load a session by ID. Returns null if not found or corrupt.
 * @param {string} sessionId
 * @returns {Promise<Object|null>}
 */
export async function loadSession(sessionId) {
  const data = await readSession(sessionId);
  if (!data) return null;
  if (!data.sessionId || !Array.isArray(data.messages) || !data.agentState) {
    console.error(`[SessionStore] Corrupt session ${sessionId}, missing required fields`);
    await saveSession(`${sessionId}.corrupt`, data);
    return null;
  }
  return data;
}

/**
 * Update a session with optimistic locking.
 * @param {string} sessionId
 * @param {number} expectedVersion - version the caller last read
 * @param {function} mutator - (session) => void, mutates in place
 * @returns {Promise<Object>} updated session
 */
export async function updateSession(sessionId, expectedVersion, mutator) {
  const session = await readSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.version !== expectedVersion) {
    throw new Error(
      `Version conflict: expected ${expectedVersion}, got ${session.version}. ` +
      `Another request may have modified this session.`
    );
  }
  mutator(session);
  session.version += 1;
  session.updatedAt = new Date().toISOString();
  await saveSession(sessionId, session);
  return session;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/resumeSessionStore.test.mjs`
Expected: All 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/blob.mjs src/lib/resumeSessionStore.mjs src/lib/resumeSessionStore.test.mjs
git commit -m "feat: add Vercel Blob session store with optimistic locking"
```

---

### Task 2: Fix Error Propagation in Evidence Search

**Files:**
- Modify: `src/lib/resumeEvidenceSearch.mjs`

- [ ] **Step 1: Identify all .catch(() => []) patterns**

Search `src/lib/resumeEvidenceSearch.mjs` for bare catch patterns. Key locations:
- `searchAllSources()` — three `.catch(() => [])` on parallel searches
- `searchWithAnalyzedQuery()` — similar pattern
- `listDailyFiles()` — bare catch returning `[]`
- `readDailyFile()` — bare catch returning `null`
- `searchSlack()` — bare catch with `continue`

- [ ] **Step 2: Update searchAllSources to propagate errors**

In `searchAllSources()`, change the three parallel search catches to capture errors:

```javascript
// Before:
const [commitResults, slackResults, sessionResults] = await Promise.all([
  searchCommits(parsedQuery, options).catch(() => []),
  searchSlack(parsedQuery, options).catch(() => []),
  searchSessionMemory(parsedQuery, options).catch(() => []),
]);

// After:
const errors = [];
const [commitResults, slackResults, sessionResults] = await Promise.all([
  searchCommits(parsedQuery, options).catch((err) => {
    console.error("[EvidenceSearch] commits search failed:", err.message);
    errors.push(`commits: ${err.message}`);
    return [];
  }),
  searchSlack(parsedQuery, options).catch((err) => {
    console.error("[EvidenceSearch] slack search failed:", err.message);
    errors.push(`slack: ${err.message}`);
    return [];
  }),
  searchSessionMemory(parsedQuery, options).catch((err) => {
    console.error("[EvidenceSearch] sessions search failed:", err.message);
    errors.push(`sessions: ${err.message}`);
    return [];
  }),
]);
```

Then include `errors` in the return value:

```javascript
return { ranked, totalCount: ranked.length, errors };
```

- [ ] **Step 3: Apply same pattern to searchWithAnalyzedQuery**

Same change in `searchWithAnalyzedQuery()` — wrap catches with error logging and collection.

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `node --experimental-test-module-mocks --test src/routes/resume.chat.generate-draft.test.mjs`
Expected: All existing tests PASS (error field is additive, doesn't break existing callers)

- [ ] **Step 5: Commit**

```bash
git add src/lib/resumeEvidenceSearch.mjs
git commit -m "fix: propagate search errors instead of silently swallowing"
```

---

### Task 3: Agent Tools

**Files:**
- Create: `src/lib/resumeAgentTools.mjs`
- Create: `src/lib/resumeAgentTools.test.mjs`

- [ ] **Step 1: Write failing tests for tool definitions**

Create `src/lib/resumeAgentTools.test.mjs`:

```javascript
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("./resumeEvidenceSearch.mjs", {
  namedExports: {
    searchAllSources: async () => ({
      ranked: [{ id: "c1", text: "Redis cache", relevanceScore: 0.9, source: "commits" }],
      totalCount: 1,
      errors: [],
    }),
    analyzeQuery: (query) => ({
      intent: "search_evidence",
      keywords: [query],
      section: null,
      dateRange: null,
      sourceParams: {},
    }),
  },
});

mock.module("./blob.mjs", {
  namedExports: {
    readChatDraft: async () => ({
      strengthCandidates: [{ id: "s1", label: "Problem Solving" }],
      companyStories: [{ id: "cs1", company: "Acme" }],
      dataGaps: ["education section"],
    }),
    readChatDraftContext: async () => ({
      dateRange: { from: "2026-01-01", to: "2026-03-31" },
    }),
  },
});

const { TOOL_DEFINITIONS, executeTool } = await import("./resumeAgentTools.mjs");

describe("resumeAgentTools", () => {
  test("TOOL_DEFINITIONS has 4 tools", () => {
    assert.equal(TOOL_DEFINITIONS.length, 4);
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    assert.ok(names.includes("search_evidence"));
    assert.ok(names.includes("read_draft_context"));
    assert.ok(names.includes("update_section"));
    assert.ok(names.includes("ask_user"));
  });

  test("each tool has name, description, parameters schema", () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.name, "tool must have name");
      assert.ok(tool.description, "tool must have description");
      assert.ok(tool.parameters, "tool must have parameters schema");
      assert.equal(tool.parameters.type, "object");
    }
  });

  test("search_evidence executes and returns results with errors field", async () => {
    const result = await executeTool("search_evidence", { query: "Redis" });
    assert.ok(Array.isArray(result.results));
    assert.equal(result.totalCount, 1);
    assert.ok(Array.isArray(result.errors));
  });

  test("read_draft_context returns cached draft", async () => {
    const result = await executeTool("read_draft_context", {});
    assert.ok(result.draft);
    assert.ok(result.draft.strengthCandidates);
    assert.ok(result.draft.companyStories);
  });

  test("read_draft_context returns null draft when no cache", async () => {
    // This test would need a separate mock — skip for now, test in integration
  });

  test("ask_user returns loop_interrupt signal", async () => {
    const result = await executeTool("ask_user", { question: "어떤 기간?" });
    assert.equal(result._interrupt, true);
    assert.equal(result.question, "어떤 기간?");
  });

  test("executeTool throws for unknown tool", async () => {
    await assert.rejects(
      () => executeTool("nonexistent_tool", {}),
      { message: /unknown tool/i }
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test src/lib/resumeAgentTools.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement tool definitions**

Create `src/lib/resumeAgentTools.mjs`:

```javascript
import { searchAllSources, analyzeQuery } from "./resumeEvidenceSearch.mjs";
import { readChatDraft, readChatDraftContext } from "./blob.mjs";

/**
 * OpenAI tool definitions for the resume agent.
 * Format: OpenAI Responses API function tool schema.
 */
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "search_evidence",
    description:
      "워크로그(커밋, 슬랙, AI 세션)에서 이력서 근거를 검색합니다. " +
      "키워드, 소스 필터, 날짜 범위를 지정할 수 있습니다.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색 키워드 (예: 'Redis 캐시 최적화')" },
        sources: {
          type: "array",
          items: { type: "string", enum: ["commits", "slack", "sessions"] },
          description: "검색할 소스 (생략 시 전체)",
        },
        dateRange: {
          type: "object",
          properties: {
            from: { type: "string", description: "시작일 YYYY-MM-DD" },
            to: { type: "string", description: "종료일 YYYY-MM-DD" },
          },
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_draft_context",
    description:
      "캐시된 이력서 초안 데이터를 읽습니다. " +
      "회사별 프로젝트, 강점 후보, 데이터 부족 영역 등을 포함합니다.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "update_section",
    description:
      "이력서 섹션 수정안을 생성합니다. 사용자 승인 후 적용됩니다. " +
      "반드시 검색 근거를 기반으로 수정안을 만드세요.",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["experience", "skills", "summary", "education", "projects"],
          description: "수정할 섹션",
        },
        operation: {
          type: "string",
          enum: ["add_bullet", "edit_bullet", "replace_summary", "add_skill", "add_project"],
          description: "수정 유형",
        },
        payload: {
          type: "object",
          description: "수정 내용 (operation별 구조)",
        },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string" },
              text: { type: "string" },
              relevanceScore: { type: "number" },
            },
          },
          description: "수정 근거",
        },
      },
      required: ["section", "operation", "payload"],
    },
  },
  {
    type: "function",
    name: "ask_user",
    description:
      "사용자에게 보충 질문을 합니다. 데이터가 부족하거나 " +
      "선택이 필요할 때 사용하세요.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "사용자에게 할 질문" },
        context: { type: "string", description: "질문 배경 설명 (선택)" },
      },
      required: ["question"],
    },
  },
];

/** Tool name allowlist for validation. */
const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name));

/**
 * Execute a tool by name.
 * @param {string} name
 * @param {Object} args
 * @returns {Promise<Object>} tool result
 */
export async function executeTool(name, args) {
  if (!TOOL_NAMES.has(name)) {
    throw new Error(`Unknown tool: "${name}". Available: ${[...TOOL_NAMES].join(", ")}`);
  }

  switch (name) {
    case "search_evidence":
      return executeSearchEvidence(args);
    case "read_draft_context":
      return executeReadDraftContext(args);
    case "update_section":
      return executeUpdateSection(args);
    case "ask_user":
      return { _interrupt: true, question: args.question, context: args.context };
  }
}

/** @returns {boolean} true if this tool call should interrupt the loop */
export function isInterruptTool(name) {
  return name === "ask_user" || name === "update_section";
}

// ── Tool implementations ────────────────────────────────────────────────

async function executeSearchEvidence({ query, sources, dateRange }) {
  const analyzed = analyzeQuery(query);
  if (sources) {
    // Filter sourceParams to only requested sources
    for (const key of Object.keys(analyzed.sourceParams || {})) {
      if (!sources.includes(key)) delete analyzed.sourceParams[key];
    }
  }
  if (dateRange) {
    analyzed.dateRange = dateRange;
  }
  const { ranked, totalCount, errors } = await searchAllSources(analyzed, {});
  return {
    results: ranked.slice(0, 15).map((r) => ({
      id: r.id,
      source: r.source || r._source,
      text: r.text || r.summary || r.message,
      relevanceScore: r.relevanceScore,
      date: r.date,
    })),
    totalCount,
    errors: errors || [],
  };
}

async function executeReadDraftContext() {
  const draft = await readChatDraft();
  if (!draft) return { draft: null, reason: "no_cache" };
  const context = await readChatDraftContext();
  return {
    draft: {
      companyStories: draft.companyStories || [],
      strengthCandidates: draft.strengthCandidates || [],
      experienceSummaries: draft.experienceSummaries || [],
      suggestedSummary: draft.suggestedSummary || "",
      dataGaps: draft.dataGaps || [],
    },
    cachedAt: draft.generatedAt || null,
    dateRange: context?.dateRange || null,
  };
}

async function executeUpdateSection({ section, operation, payload, evidence }) {
  // This tool returns the proposed change as a structured diff.
  // Actual application happens after user approval via the endpoint.
  const messageId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    _interrupt: true,
    diff: { section, operation, payload, evidence: evidence || [] },
    messageId,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/resumeAgentTools.test.mjs`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/resumeAgentTools.mjs src/lib/resumeAgentTools.test.mjs
git commit -m "feat: add agent tool definitions with search adapter and interrupt signals"
```

---

### Task 4: ReAct Loop Orchestrator

**Files:**
- Create: `src/lib/resumeAgent.mjs`
- Create: `src/lib/resumeAgent.test.mjs`

- [ ] **Step 1: Write failing tests for the agent loop**

Create `src/lib/resumeAgent.test.mjs`:

```javascript
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// Mock OpenAI
let llmCalls = [];
let llmResponses = [];
mock.module("./openai.mjs", {
  namedExports: {
    OPENAI_URL: "http://mock/v1/responses",
    OPENAI_MODEL: "gpt-5.4",
    getApiKey: () => "test-key",
  },
});

// Mock tools
mock.module("./resumeAgentTools.mjs", {
  namedExports: {
    TOOL_DEFINITIONS: [
      { type: "function", name: "search_evidence", description: "search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { type: "function", name: "ask_user", description: "ask", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
    ],
    executeTool: async (name, args) => {
      if (name === "search_evidence") return { results: [{ text: "Redis commit" }], totalCount: 1, errors: [] };
      if (name === "ask_user") return { _interrupt: true, question: args.question };
      throw new Error(`Unknown tool: ${name}`);
    },
    isInterruptTool: (name) => name === "ask_user" || name === "update_section",
  },
});

// Mock fetch for LLM calls
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (url === "http://mock/v1/responses") {
    llmCalls.push(JSON.parse(opts.body));
    const resp = llmResponses.shift() || { output: [{ content: [{ type: "output_text", text: "에이전트 응답" }] }] };
    return { ok: true, json: async () => resp, text: async () => JSON.stringify(resp) };
  }
  return originalFetch(url, opts);
};

const { runAgentLoop } = await import("./resumeAgent.mjs");

describe("resumeAgent", () => {
  test("text-only response terminates loop in 1 iteration", async () => {
    llmCalls = [];
    llmResponses = [
      { output: [{ content: [{ type: "output_text", text: "안녕하세요!" }] }] },
    ];

    const events = [];
    await runAgentLoop({
      messages: [{ role: "user", content: "안녕" }],
      resumeSummary: "이력서 요약",
      onEvent: (e) => events.push(e),
    });

    assert.equal(llmCalls.length, 1);
    const textEvents = events.filter((e) => e.type === "message");
    assert.equal(textEvents.length, 1);
    assert.equal(textEvents[0].content, "안녕하세요!");
  });

  test("tool call executes and feeds observation back", async () => {
    llmCalls = [];
    llmResponses = [
      // First response: tool call
      {
        output: [{
          type: "function_call",
          name: "search_evidence",
          arguments: JSON.stringify({ query: "Redis" }),
          call_id: "call-1",
        }],
      },
      // Second response: text after observation
      { output: [{ content: [{ type: "output_text", text: "Redis 커밋 1건 찾았어요!" }] }] },
    ];

    const events = [];
    await runAgentLoop({
      messages: [{ role: "user", content: "Redis 경험 찾아줘" }],
      resumeSummary: "",
      onEvent: (e) => events.push(e),
    });

    assert.equal(llmCalls.length, 2);
    const progressEvents = events.filter((e) => e.type === "progress");
    assert.ok(progressEvents.length > 0);
  });

  test("interrupt tool stops loop", async () => {
    llmCalls = [];
    llmResponses = [
      {
        output: [{
          type: "function_call",
          name: "ask_user",
          arguments: JSON.stringify({ question: "어떤 기간?" }),
          call_id: "call-1",
        }],
      },
    ];

    const events = [];
    await runAgentLoop({
      messages: [{ role: "user", content: "교육 추가해줘" }],
      resumeSummary: "",
      onEvent: (e) => events.push(e),
    });

    assert.equal(llmCalls.length, 1); // No second LLM call
    const askEvents = events.filter((e) => e.type === "ask_user");
    assert.equal(askEvents.length, 1);
    assert.equal(askEvents[0].question, "어떤 기간?");
  });

  test("max iterations stops loop with fallback message", async () => {
    llmCalls = [];
    // Return tool calls forever
    llmResponses = Array.from({ length: 12 }, () => ({
      output: [{
        type: "function_call",
        name: "search_evidence",
        arguments: JSON.stringify({ query: "loop" }),
        call_id: `call-${Math.random()}`,
      }],
    }));

    const events = [];
    await runAgentLoop({
      messages: [{ role: "user", content: "무한루프" }],
      resumeSummary: "",
      onEvent: (e) => events.push(e),
      maxIterations: 3, // Override for test speed
    });

    assert.ok(llmCalls.length <= 4); // 3 iterations + possible extra
    const msgEvents = events.filter((e) => e.type === "message");
    assert.ok(msgEvents.some((e) => e.content.includes("완료하지 못했")));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test src/lib/resumeAgent.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the ReAct loop**

Create `src/lib/resumeAgent.mjs`:

```javascript
import { OPENAI_URL, OPENAI_MODEL, getApiKey } from "./openai.mjs";
import { TOOL_DEFINITIONS, executeTool, isInterruptTool } from "./resumeAgentTools.mjs";

const MAX_ITERATIONS = 10;

const SYSTEM_PROMPT = `너는 이력서 개선을 도와주는 친근한 동료야.
워크로그 데이터(커밋, 슬랙, AI 세션)를 기반으로 이력서를 분석하고 개선안을 제안해.

행동 원칙:
1. 먼저 분석하고 제안해 — 사용자가 요청하기 전에 개선점을 찾아
2. 모든 제안에 근거를 달아 — "커밋 3건에서 확인" 식으로
3. 이력서 수정은 반드시 update_section 도구로 diff를 만들어 승인받아
4. 데이터가 부족하면 ask_user 도구로 솔직히 보충 질문해
5. 검색에 실패하면 솔직히 알려줘 — 빈 결과와 에러를 구분해
6. 친근하게, 하지만 전문적으로 — "오 이거 좋네요!" + 구체적 이유`;

/**
 * Run the ReAct agent loop.
 *
 * @param {Object} opts
 * @param {Array}  opts.messages     - conversation history (role/content objects)
 * @param {string} opts.resumeSummary - current resume summary for system prompt
 * @param {function} opts.onEvent    - (event) => void, SSE event emitter
 * @param {number} [opts.maxIterations] - override MAX_ITERATIONS (for testing)
 * @returns {Promise<{ messages: Array, toolOutputs: Array }>}
 */
export async function runAgentLoop({
  messages,
  resumeSummary = "",
  onEvent,
  maxIterations = MAX_ITERATIONS,
}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    onEvent({ type: "message", content: "LLM API 키가 설정되지 않았어요." });
    return { messages, toolOutputs: [] };
  }

  const systemContent = resumeSummary
    ? `${SYSTEM_PROMPT}\n\n현재 이력서 요약:\n${resumeSummary}`
    : SYSTEM_PROMPT;

  const allToolOutputs = [];
  let iteration = 0;

  // Build input for LLM
  const input = [
    { role: "system", content: [{ type: "input_text", text: systemContent }] },
    ...messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
    })),
  ];

  const tools = TOOL_DEFINITIONS.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  while (iteration < maxIterations) {
    iteration++;
    onEvent({ type: "progress", iteration, step: `생각하는 중... (${iteration}/${maxIterations})` });

    // Call LLM
    let data;
    try {
      const response = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input,
          tools,
          max_output_tokens: 4000,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`LLM failed: ${response.status} ${errText.slice(0, 400)}`);
      }
      data = await response.json();
    } catch (err) {
      // Retry once
      if (iteration === 1) {
        console.error("[Agent] LLM call failed, retrying:", err.message);
        continue;
      }
      onEvent({ type: "message", content: "잠시 문제가 생겼어요. 다시 시도할까요?" });
      return { messages, toolOutputs: allToolOutputs };
    }

    // Parse LLM output
    const outputs = data.output ?? [];
    const functionCalls = outputs.filter((o) => o.type === "function_call");
    const textParts = [];

    for (const item of outputs) {
      if (item.type === "function_call") continue;
      for (const part of item?.content ?? []) {
        if (part?.type === "output_text" && part?.text) textParts.push(part.text);
      }
    }

    // Case 1: Text-only response — loop done
    if (functionCalls.length === 0 && textParts.length > 0) {
      const text = textParts.join("\n").trim();
      onEvent({ type: "message", content: text });
      return { messages: [...messages, { role: "assistant", content: text }], toolOutputs: allToolOutputs };
    }

    // Case 2: No output at all — unexpected, terminate
    if (functionCalls.length === 0 && textParts.length === 0) {
      onEvent({ type: "message", content: "응답을 생성하지 못했어요. 다시 말씀해주시겠어요?" });
      return { messages, toolOutputs: allToolOutputs };
    }

    // Case 3: Tool calls — execute and observe
    for (const call of functionCalls) {
      const { name, arguments: argsStr, call_id } = call;

      // Validate tool name
      if (!TOOL_DEFINITIONS.some((t) => t.name === name)) {
        // Re-prompt LLM with error
        input.push({
          role: "user",
          content: [{ type: "input_text", text: `Error: Unknown tool "${name}". Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}` }],
        });
        continue;
      }

      let args;
      try {
        args = JSON.parse(argsStr);
      } catch {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: `Error: Invalid JSON arguments for tool "${name}": ${argsStr}` }],
        });
        continue;
      }

      onEvent({ type: "progress", iteration, step: `${name} 실행 중...` });

      // Execute tool
      let result;
      try {
        result = await executeTool(name, args);
      } catch (err) {
        console.error(`[Agent] Tool ${name} failed:`, err.message);
        result = { error: err.message };
      }

      allToolOutputs.push({ name, args, result });

      // Check for interrupt (ask_user / update_section)
      if (result._interrupt) {
        if (name === "ask_user") {
          onEvent({ type: "ask_user", question: result.question, context: result.context });
          return { messages, toolOutputs: allToolOutputs };
        }
        if (name === "update_section") {
          onEvent({ type: "diff", ...result.diff, messageId: result.messageId });
          // Also emit any text the LLM generated alongside the tool call
          if (textParts.length > 0) {
            onEvent({ type: "message", content: textParts.join("\n").trim() });
          }
          return { messages, toolOutputs: allToolOutputs };
        }
      }

      // Feed observation back to LLM
      input.push({
        role: "user",
        content: [{ type: "input_text", text: `[Tool Result: ${name}]\n${JSON.stringify(result)}` }],
      });
    }
  }

  // Max iterations reached
  onEvent({
    type: "message",
    content: "한번에 처리하기 어려운 요청이에요. 좀 더 구체적으로 말씀해주시겠어요?",
  });
  return { messages, toolOutputs: allToolOutputs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/lib/resumeAgent.test.mjs`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/resumeAgent.mjs src/lib/resumeAgent.test.mjs
git commit -m "feat: add ReAct loop orchestrator with max iterations and interrupt signals"
```

---

### Task 5: SSE Endpoint

**Files:**
- Create: `src/routes/resume.agent.mjs`
- Create: `src/routes/resume.agent.test.mjs`
- Modify: `src/routes/resume.mjs` (mount agent router)

- [ ] **Step 1: Write failing tests for the endpoint**

Create `src/routes/resume.agent.test.mjs`:

```javascript
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// Mock session store
let sessions = {};
mock.module("../lib/resumeSessionStore.mjs", {
  namedExports: {
    createSession: async (userId) => {
      const s = { sessionId: "test-session", userId, version: 1, messages: [], agentState: { pendingDiffs: [], pendingSuggestions: [], completedSuggestions: [], resumeVersion: 0 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      sessions[s.sessionId] = s;
      return s;
    },
    loadSession: async (id) => sessions[id] || null,
    updateSession: async (id, ver, mutator) => {
      const s = sessions[id];
      if (!s) throw new Error("not found");
      mutator(s);
      s.version++;
      sessions[id] = s;
      return s;
    },
  },
});

// Mock agent
mock.module("../lib/resumeAgent.mjs", {
  namedExports: {
    runAgentLoop: async ({ messages, onEvent }) => {
      onEvent({ type: "message", content: "에이전트 응답" });
      return { messages: [...messages, { role: "assistant", content: "에이전트 응답" }], toolOutputs: [] };
    },
  },
});

// Mock blob for resume summary
mock.module("../lib/blob.mjs", {
  namedExports: {
    readResumeData: async () => ({ summary: "요약 텍스트", experience: [] }),
    readChatDraft: async () => null,
    readChatDraftContext: async () => null,
    saveSession: async () => ({}),
    readSession: async () => null,
    deleteSession: async () => {},
  },
});

const { agentRouter } = await import("./resume.agent.mjs");

describe("POST /api/resume/agent", () => {
  test("returns 400 for missing action", async () => {
    const req = new Request("http://localhost/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await agentRouter.fetch(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  test("returns 400 for unknown action", async () => {
    const req = new Request("http://localhost/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "fly", sessionId: "x" }),
    });
    const res = await agentRouter.fetch(req);
    assert.equal(res.status, 400);
  });

  test("init action creates session and returns SSE", async () => {
    sessions = {};
    const req = new Request("http://localhost/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "init" }),
    });
    const res = await agentRouter.fetch(req);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
  });

  test("message action requires sessionId", async () => {
    const req = new Request("http://localhost/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "message", text: "hello" }),
    });
    const res = await agentRouter.fetch(req);
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-test-module-mocks --test src/routes/resume.agent.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SSE endpoint**

Create `src/routes/resume.agent.mjs`:

```javascript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createSession, loadSession, updateSession } from "../lib/resumeSessionStore.mjs";
import { runAgentLoop } from "../lib/resumeAgent.mjs";
import { readResumeData } from "../lib/blob.mjs";

export const agentRouter = new Hono();

const VALID_ACTIONS = new Set(["init", "message", "approve_diff", "reject_diff", "revise_diff"]);

agentRouter.post("/agent", async (c) => {
  const body = await c.req.json();
  const { action, sessionId, text, messageId, feedback } = body;

  // ── Validate action ─────────────────────────────────────────────────────
  if (!action) {
    return c.json({ error: "action 필드가 필요합니다." }, 400);
  }
  if (!VALID_ACTIONS.has(action)) {
    return c.json({ error: `알 수 없는 action: "${action}". 허용: ${[...VALID_ACTIONS].join(", ")}` }, 400);
  }

  // ── Action: init ────────────────────────────────────────────────────────
  if (action === "init") {
    const userId = "default-user"; // TODO: extract from auth when multi-user
    const session = await createSession(userId);

    return streamSSE(c, async (stream) => {
      // Build resume summary for system prompt
      const resume = await readResumeData();
      const resumeSummary = resume ? buildResumeSummary(resume) : "";

      await runAgentLoop({
        messages: [{ role: "user", content: "[시스템] 새 세션이 시작되었습니다. 이력서를 분석하고 개선안을 제안해주세요." }],
        resumeSummary,
        onEvent: async (event) => {
          await stream.writeSSE({ data: JSON.stringify({ ...event, sessionId: session.sessionId }) });
        },
      });

      // Save the init messages to session
      await updateSession(session.sessionId, session.version, (s) => {
        s.messages.push({ role: "system", content: "세션 시작", timestamp: Date.now() });
      });
    });
  }

  // ── Validate sessionId for non-init actions ─────────────────────────────
  if (!sessionId) {
    return c.json({ error: "sessionId가 필요합니다." }, 400);
  }

  const session = await loadSession(sessionId);
  if (!session) {
    return c.json({ error: "세션을 찾을 수 없습니다. 새로고침해주세요." }, 404);
  }

  // ── Action: message ─────────────────────────────────────────────────────
  if (action === "message") {
    if (!text) return c.json({ error: "text가 필요합니다." }, 400);

    return streamSSE(c, async (stream) => {
      const resume = await readResumeData();
      const resumeSummary = resume ? buildResumeSummary(resume) : "";

      const updatedMessages = [
        ...session.messages.filter((m) => m.role !== "system"),
        { role: "user", content: text },
      ];

      const { messages: newMessages, toolOutputs } = await runAgentLoop({
        messages: updatedMessages,
        resumeSummary,
        onEvent: async (event) => {
          await stream.writeSSE({ data: JSON.stringify({ ...event, sessionId }) });
        },
      });

      // Save to session
      await updateSession(sessionId, session.version, (s) => {
        s.messages.push({ role: "user", content: text, timestamp: Date.now() });
        // Save tool outputs as summaries
        for (const to of toolOutputs) {
          s.messages.push({
            role: "tool_summary",
            name: to.name,
            summary: summarizeToolOutput(to),
            timestamp: Date.now(),
          });
        }
        // Save assistant response (last message if assistant)
        const last = newMessages[newMessages.length - 1];
        if (last?.role === "assistant") {
          s.messages.push({ role: "assistant", content: last.content, timestamp: Date.now() });
        }
      });
    });
  }

  // ── Action: approve_diff ────────────────────────────────────────────────
  if (action === "approve_diff") {
    if (!messageId) return c.json({ error: "messageId가 필요합니다." }, 400);

    const pending = session.agentState.pendingDiffs.find((d) => d.messageId === messageId);
    if (!pending) return c.json({ error: "해당 diff를 찾을 수 없습니다." }, 404);

    // Check if diff has expired (30 min TTL)
    if (pending.expiresAt && new Date(pending.expiresAt) < new Date()) {
      return c.json({ error: "수정안이 만료되었어요. 다시 만들까요?" }, 410);
    }

    // Check baseVersion to prevent stale diff application
    const resume = await readResumeData();
    if (resume?._version && pending.baseVersion && resume._version !== pending.baseVersion) {
      return c.json({ error: "이력서가 변경되었어요. 수정안을 다시 만들어야 합니다." }, 409);
    }

    // Apply the diff via existing resume PATCH endpoint (internal call)
    // For now, return success and let frontend handle the PATCH
    await updateSession(sessionId, session.version, (s) => {
      s.agentState.pendingDiffs = s.agentState.pendingDiffs.filter((d) => d.messageId !== messageId);
      s.messages.push({ role: "system", content: `diff ${messageId} 승인됨`, timestamp: Date.now() });
    });

    return c.json({ ok: true, messageId });
  }

  // ── Action: reject_diff ─────────────────────────────────────────────────
  if (action === "reject_diff") {
    if (!messageId) return c.json({ error: "messageId가 필요합니다." }, 400);

    await updateSession(sessionId, session.version, (s) => {
      s.agentState.pendingDiffs = s.agentState.pendingDiffs.filter((d) => d.messageId !== messageId);
      s.messages.push({ role: "system", content: `diff ${messageId} 거절됨`, timestamp: Date.now() });
    });

    return c.json({ ok: true, messageId });
  }

  // ── Action: revise_diff ─────────────────────────────────────────────────
  if (action === "revise_diff") {
    if (!messageId || !feedback) return c.json({ error: "messageId와 feedback이 필요합니다." }, 400);

    // Treat as a new message with context about the revision
    return streamSSE(c, async (stream) => {
      const resume = await readResumeData();
      const resumeSummary = resume ? buildResumeSummary(resume) : "";

      const reviseMessage = `[수정 요청] diff ${messageId}에 대한 피드백: ${feedback}`;
      const updatedMessages = [
        ...session.messages.filter((m) => m.role !== "system"),
        { role: "user", content: reviseMessage },
      ];

      await runAgentLoop({
        messages: updatedMessages,
        resumeSummary,
        onEvent: async (event) => {
          await stream.writeSSE({ data: JSON.stringify({ ...event, sessionId }) });
        },
      });

      await updateSession(sessionId, session.version, (s) => {
        s.agentState.pendingDiffs = s.agentState.pendingDiffs.filter((d) => d.messageId !== messageId);
        s.messages.push({ role: "user", content: reviseMessage, timestamp: Date.now() });
      });
    });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────

function buildResumeSummary(resume) {
  const parts = [];
  if (resume.summary) parts.push(`요약: ${resume.summary}`);
  if (resume.experience?.length) {
    parts.push(`경력: ${resume.experience.map((e) => `${e.company} (${e.title})`).join(", ")}`);
  }
  if (resume.skills?.length) {
    parts.push(`스킬: ${resume.skills.map((s) => s.name || s).join(", ")}`);
  }
  return parts.join("\n");
}

function summarizeToolOutput(toolOutput) {
  const { name, result } = toolOutput;
  if (name === "search_evidence") {
    return `검색 결과 ${result.totalCount}건${result.errors?.length ? `, 에러: ${result.errors.join("; ")}` : ""}`;
  }
  if (name === "read_draft_context") {
    return result.draft ? `초안 로드 완료 (${result.draft.companyStories?.length || 0}개 회사)` : "초안 없음";
  }
  return JSON.stringify(result).slice(0, 200);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-test-module-mocks --test src/routes/resume.agent.test.mjs`
Expected: All 4 tests PASS

- [ ] **Step 5: Mount agent router in resume.mjs**

Add to the end of `src/routes/resume.mjs`:

```javascript
import { agentRouter } from "./resume.agent.mjs";

// Mount after existing routes
resumeRouter.route("/", agentRouter);
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/resume.agent.mjs src/routes/resume.agent.test.mjs src/routes/resume.mjs
git commit -m "feat: add SSE agent endpoint with init/message/approve/reject/revise actions"
```

---

### Task 6: Frontend Hook (useResumeAgent)

**Files:**
- Create: `frontend/src/hooks/useResumeAgent.js`

- [ ] **Step 1: Implement SSE client hook**

Create `frontend/src/hooks/useResumeAgent.js`:

```javascript
import { useState, useCallback, useRef } from "preact/hooks";

/**
 * Hook for communicating with the resume agent endpoint via SSE.
 *
 * @returns {{
 *   messages: Array,
 *   loading: boolean,
 *   sessionId: string|null,
 *   pendingDiff: Object|null,
 *   initSession: () => Promise<void>,
 *   sendMessage: (text: string) => Promise<void>,
 *   approveDiff: (messageId: string) => Promise<void>,
 *   rejectDiff: (messageId: string) => Promise<void>,
 *   reviseDiff: (messageId: string, feedback: string) => Promise<void>,
 * }}
 */
export function useResumeAgent() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [pendingDiff, setPendingDiff] = useState(null);
  const [progress, setProgress] = useState(null);
  const abortRef = useRef(null);

  const postAgent = useCallback(async (body) => {
    setLoading(true);
    setProgress(null);

    try {
      const response = await fetch("/api/resume/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: err.error || "오류가 발생했어요.", timestamp: Date.now() },
        ]);
        return;
      }

      // Read SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            // Capture sessionId from first event
            if (event.sessionId && !sessionId) {
              setSessionId(event.sessionId);
            }

            switch (event.type) {
              case "progress":
                setProgress(event.step);
                break;

              case "message":
                setMessages((prev) => [
                  ...prev,
                  { role: "assistant", content: event.content, timestamp: Date.now() },
                ]);
                setProgress(null);
                break;

              case "diff":
                setPendingDiff({
                  messageId: event.messageId,
                  section: event.section,
                  operation: event.operation,
                  payload: event.payload,
                  evidence: event.evidence,
                });
                break;

              case "ask_user":
                setMessages((prev) => [
                  ...prev,
                  { role: "assistant", content: event.question, isQuestion: true, timestamp: Date.now() },
                ]);
                setProgress(null);
                break;

              case "suggestions":
                setMessages((prev) => [
                  ...prev,
                  { role: "assistant", content: event.content, suggestions: event.items, timestamp: Date.now() },
                ]);
                setProgress(null);
                break;
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [sessionId]);

  const initSession = useCallback(async () => {
    await postAgent({ action: "init" });
  }, [postAgent]);

  const sendMessage = useCallback(async (text) => {
    setMessages((prev) => [...prev, { role: "user", content: text, timestamp: Date.now() }]);
    await postAgent({ action: "message", sessionId, text });
  }, [postAgent, sessionId]);

  const approveDiff = useCallback(async (messageId) => {
    const res = await fetch("/api/resume/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve_diff", sessionId, messageId }),
    });
    if (res.ok) setPendingDiff(null);
  }, [sessionId]);

  const rejectDiff = useCallback(async (messageId) => {
    const res = await fetch("/api/resume/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject_diff", sessionId, messageId }),
    });
    if (res.ok) setPendingDiff(null);
  }, [sessionId]);

  const reviseDiff = useCallback(async (messageId, feedback) => {
    setPendingDiff(null);
    await postAgent({ action: "revise_diff", sessionId, messageId, feedback });
  }, [postAgent, sessionId]);

  return {
    messages,
    loading,
    progress,
    sessionId,
    pendingDiff,
    initSession,
    sendMessage,
    approveDiff,
    rejectDiff,
    reviseDiff,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useResumeAgent.js
git commit -m "feat: add useResumeAgent SSE hook for agent communication"
```

---

### Task 7: Wire Frontend to Agent

**Files:**
- Modify: `frontend/src/pages/ResumeChatPage.jsx`

- [ ] **Step 1: Read current ResumeChatPage.jsx to understand wiring points**

Read `frontend/src/pages/ResumeChatPage.jsx` and identify:
- Where `useResumeChat` (or current chat hook) is called
- Where messages are rendered
- Where input submission happens

- [ ] **Step 2: Add agent mode toggle behind env var**

At the top of `ResumeChatPage.jsx`, add:

```javascript
import { useResumeAgent } from "../hooks/useResumeAgent.js";

const AGENT_ENABLED = typeof window !== "undefined" && window.__RESUME_AGENT_ENABLED;
```

- [ ] **Step 3: Conditionally use agent hook**

Replace the existing chat hook usage with a conditional:

```javascript
// Inside ResumeChatPage component:
const agentHook = useResumeAgent();
const legacyHook = useResumeChat(); // existing hook

// Pick which one to use
const chat = AGENT_ENABLED ? {
  messages: agentHook.messages,
  loading: agentHook.loading,
  sendMessage: agentHook.sendMessage,
  // ... map remaining props
} : legacyHook;
```

- [ ] **Step 4: Add agent init on mount**

```javascript
useEffect(() => {
  if (AGENT_ENABLED && !agentHook.sessionId) {
    agentHook.initSession();
  }
}, [AGENT_ENABLED]);
```

- [ ] **Step 5: Add progress indicator for agent**

In the messages area, add a progress display:

```javascript
{AGENT_ENABLED && agentHook.progress && (
  <div class="rcp-progress-indicator">
    <span class="rcp-progress-spinner" />
    <span>{agentHook.progress}</span>
  </div>
)}
```

- [ ] **Step 6: Add diff approval UI for agent**

```javascript
{AGENT_ENABLED && agentHook.pendingDiff && (
  <div class="rcp-diff-approval">
    <div class="rcp-diff-section">{agentHook.pendingDiff.section}</div>
    <pre class="rcp-diff-content">{JSON.stringify(agentHook.pendingDiff.payload, null, 2)}</pre>
    <div class="rcp-diff-actions">
      <button onClick={() => agentHook.approveDiff(agentHook.pendingDiff.messageId)}>승인</button>
      <button onClick={() => agentHook.rejectDiff(agentHook.pendingDiff.messageId)}>거절</button>
    </div>
  </div>
)}
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/ResumeChatPage.jsx
git commit -m "feat: wire ResumeChatPage to agent hook with env var toggle"
```

---

### Task 8: Integration Test & Server Registration

**Files:**
- Modify: `src/server.mjs` (ensure agent route is registered)

- [ ] **Step 1: Verify agent route is accessible through server**

Check `src/server.mjs` to confirm that `resumeRouter` is mounted under `/api/resume`. Since `agentRouter` is already mounted on `resumeRouter` in Task 5, the full path `/api/resume/agent` should work automatically.

If not already mounted, add to `src/server.mjs`:

```javascript
// Should already be there from existing code:
app.route("/api/resume", resumeRouter);
```

- [ ] **Step 2: Run all tests**

Run: `node --experimental-test-module-mocks --test 'src/lib/*.test.mjs' 'src/routes/*.test.mjs'`
Expected: All tests PASS (existing + new)

- [ ] **Step 3: Manual smoke test**

Start the dev server and test the agent endpoint:

```bash
curl -X POST http://localhost:3000/api/resume/agent \
  -H "Content-Type: application/json" \
  -d '{"action":"init"}' \
  --no-buffer
```

Expected: SSE events streaming back with suggestions.

- [ ] **Step 4: Commit**

```bash
git add src/server.mjs
git commit -m "feat: register agent route and verify integration"
```

---

### Task 9: Environment Variable Toggle (Migration Phase B)

**Files:**
- Modify: `src/server.mjs` or `src/routes/resume.mjs`
- Modify: Frontend HTML template (inject `__RESUME_AGENT_ENABLED`)

- [ ] **Step 1: Add RESUME_AGENT_ENABLED env var check to server**

In the HTML template that serves the frontend (check `src/server.mjs` for the HTML serving logic), inject:

```javascript
<script>window.__RESUME_AGENT_ENABLED = ${process.env.RESUME_AGENT_ENABLED === "1"};</script>
```

- [ ] **Step 2: Test with env var off (default)**

Start server without env var. Frontend should use legacy chat hook.

- [ ] **Step 3: Test with env var on**

```bash
RESUME_AGENT_ENABLED=1 node src/server.mjs
```

Frontend should use agent hook, show SSE progress, diff approval UI.

- [ ] **Step 4: Commit**

```bash
git add src/server.mjs
git commit -m "feat: add RESUME_AGENT_ENABLED env var toggle for agent migration"
```

---

## Post-Implementation Checklist

After all tasks are complete:

- [ ] All tests pass: `node --experimental-test-module-mocks --test 'src/lib/*.test.mjs' 'src/routes/*.test.mjs'`
- [ ] Agent endpoint responds to `action: "init"` with SSE suggestions
- [ ] Agent endpoint responds to `action: "message"` with SSE tool execution + response
- [ ] Diff approval flow works (approve/reject/revise)
- [ ] Session persists across page refresh
- [ ] `RESUME_AGENT_ENABLED=0` falls back to legacy chat
- [ ] No regressions in existing chat functionality
