import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockSearchResult = { ranked: [], totalCount: 0, errors: [] };
let mockDraft = null;
let mockDraftContext = null;

mock.module("./resumeEvidenceSearch.mjs", {
  namedExports: {
    searchAllSources: async () => mockSearchResult,
  },
});

mock.module("./resumeQueryAnalyzer.mjs", {
  namedExports: {
    analyzeQuery: (query) => ({
      raw: query,
      intent: "search_evidence",
      keywords: query.split(/\s+/),
      section: null,
      dateRange: null,
      techStack: { all: [], byCategory: {} },
      sourceParams: {
        commits: { keywords: [], dateRange: null, maxResults: 10, enabled: true },
        slack: { keywords: [], dateRange: null, maxResults: 5, enabled: true },
        sessions: { keywords: [], dateRange: null, maxResults: 5, enabled: true },
      },
      confidence: 0.8,
      needsClarification: false,
    }),
  },
});

mock.module("./blob.mjs", {
  namedExports: {
    readChatDraft: async () => mockDraft,
    readChatDraftContext: async () => mockDraftContext,
  },
});

const { TOOL_DEFINITIONS, executeTool, isInterruptTool } = await import(
  "./resumeAgentTools.mjs"
);

// ─── TOOL_DEFINITIONS ───────────────────────────────────────────────────────

describe("TOOL_DEFINITIONS", () => {
  test("has 4 tools", () => {
    assert.equal(TOOL_DEFINITIONS.length, 4);
  });

  test("each tool has name, description, and parameters", () => {
    for (const tool of TOOL_DEFINITIONS) {
      assert.equal(tool.type, "function");
      assert.ok(typeof tool.name === "string" && tool.name.length > 0);
      assert.ok(typeof tool.description === "string" && tool.description.length > 0);
      assert.ok(tool.parameters && typeof tool.parameters === "object");
      assert.equal(tool.parameters.type, "object");
    }
  });

  test("tool names match expected set", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "ask_user",
      "read_draft_context",
      "search_evidence",
      "update_section",
    ]);
  });
});

// ─── isInterruptTool ────────────────────────────────────────────────────────

describe("isInterruptTool", () => {
  test("returns true for ask_user", () => {
    assert.equal(isInterruptTool("ask_user"), true);
  });

  test("returns true for update_section", () => {
    assert.equal(isInterruptTool("update_section"), true);
  });

  test("returns false for search_evidence", () => {
    assert.equal(isInterruptTool("search_evidence"), false);
  });

  test("returns false for read_draft_context", () => {
    assert.equal(isInterruptTool("read_draft_context"), false);
  });
});

// ─── search_evidence ────────────────────────────────────────────────────────

describe("search_evidence", () => {
  test("returns results with errors field", async () => {
    mockSearchResult = {
      ranked: [
        {
          id: "c1",
          source: "commits",
          text: "Implemented caching layer",
          relevanceScore: 0.9,
          date: "2025-03-01",
        },
        {
          id: "s1",
          _source: "slack",
          message: "Discussed caching strategy",
          relevanceScore: 0.7,
          date: "2025-03-02",
        },
      ],
      totalCount: 2,
      errors: ["sessions: timeout"],
    };

    const result = await executeTool("search_evidence", { query: "caching" });

    assert.ok(Array.isArray(result.results));
    assert.equal(result.results.length, 2);
    assert.equal(result.totalCount, 2);
    assert.deepEqual(result.errors, ["sessions: timeout"]);

    // Verify field mapping
    assert.equal(result.results[0].source, "commits");
    assert.equal(result.results[0].text, "Implemented caching layer");
    assert.equal(result.results[1].source, "slack");
    assert.equal(result.results[1].text, "Discussed caching strategy");
  });

  test("handles old array return format gracefully", async () => {
    mockSearchResult = [
      { id: "c1", source: "commits", summary: "Old format item", relevanceScore: 0.5, date: "2025-01-01" },
    ];

    const result = await executeTool("search_evidence", { query: "old format" });

    assert.ok(Array.isArray(result.results));
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].text, "Old format item");
    assert.equal(result.totalCount, 1);
    assert.deepEqual(result.errors, []);
  });

  test("limits results to 15", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: `item-${i}`,
      source: "commits",
      text: `Item ${i}`,
      relevanceScore: 1 - i * 0.01,
      date: "2025-01-01",
    }));
    mockSearchResult = { ranked: items, totalCount: 20, errors: [] };

    const result = await executeTool("search_evidence", { query: "many items" });
    assert.equal(result.results.length, 15);
    assert.equal(result.totalCount, 20);
  });
});

// ─── read_draft_context ─────────────────────────────────────────────────────

describe("read_draft_context", () => {
  test("returns cached draft when available", async () => {
    mockDraft = { strengths: ["teamwork"], cachedAt: "2025-03-01T00:00:00Z" };
    mockDraftContext = {
      draft: { strengths: ["teamwork"], experiences: [] },
      evidencePool: [{ id: "e1" }],
      sourceBreakdown: { commits: 5, slack: 2, sessions: 1 },
      cachedAt: "2025-03-01T00:00:00Z",
      dateRange: { from: "2025-01-01", to: "2025-03-01" },
    };

    const result = await executeTool("read_draft_context", {});

    assert.ok(result.draft);
    assert.deepEqual(result.draft.strengths, ["teamwork"]);
    assert.equal(result.cachedAt, "2025-03-01T00:00:00Z");
    assert.ok(result.dateRange);
  });

  test("returns no_cache when both draft and context are null", async () => {
    mockDraft = null;
    mockDraftContext = null;

    const result = await executeTool("read_draft_context", {});

    assert.equal(result.draft, null);
    assert.equal(result.reason, "no_cache");
  });
});

// ─── ask_user ───────────────────────────────────────────────────────────────

describe("ask_user", () => {
  test("returns _interrupt signal with question", async () => {
    const result = await executeTool("ask_user", {
      question: "어떤 프로젝트에 대해 작성하고 싶으세요?",
      context: "이력서 경력 섹션 작성 중",
    });

    assert.equal(result._interrupt, true);
    assert.equal(result.question, "어떤 프로젝트에 대해 작성하고 싶으세요?");
    assert.equal(result.context, "이력서 경력 섹션 작성 중");
  });

  test("context defaults to null when omitted", async () => {
    const result = await executeTool("ask_user", {
      question: "간단한 질문",
    });

    assert.equal(result._interrupt, true);
    assert.equal(result.context, null);
  });
});

// ─── update_section ─────────────────────────────────────────────────────────

describe("update_section", () => {
  test("returns _interrupt signal with diff and messageId", async () => {
    const result = await executeTool("update_section", {
      section: "experience",
      operation: "add",
      payload: { title: "Senior Engineer", bullets: ["Led caching project"] },
      evidence: [{ id: "c1", text: "caching commit" }],
    });

    assert.equal(result._interrupt, true);
    assert.ok(result.diff);
    assert.equal(result.diff.section, "experience");
    assert.equal(result.diff.operation, "add");
    assert.ok(result.messageId.startsWith("diff-"));
  });
});

// ─── executeTool error handling ─────────────────────────────────────────────

describe("executeTool", () => {
  test("throws for unknown tool name", async () => {
    await assert.rejects(
      () => executeTool("nonexistent_tool", {}),
      { message: "Unknown tool: nonexistent_tool" }
    );
  });
});
