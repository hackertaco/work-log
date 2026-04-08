/**
 * Tests for resumeAgent.mjs — ReAct loop orchestrator.
 *
 * Uses dependency injection via _deps to mock LLM calls and tool execution.
 * Run:
 *   node --test src/lib/resumeAgent.test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { runAgentLoop } from "./resumeAgent.mjs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_TOOLS = new Set(["search_evidence", "read_draft_context", "ask_user", "update_section"]);

function makeTextResponse(text) {
  return {
    output: [{ content: [{ type: "output_text", text }] }],
  };
}

function makeToolCallResponse(name, args, callId = "call-1") {
  return {
    output: [
      {
        type: "function_call",
        name,
        arguments: JSON.stringify(args),
        call_id: callId,
      },
    ],
  };
}

function isInterruptTool(name) {
  return name === "ask_user" || name === "update_section";
}

function baseMessages() {
  return [{ role: "user", content: [{ type: "input_text", text: "test" }] }];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runAgentLoop", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("text-only response terminates in 1 iteration", async () => {
    let llmCalls = 0;
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => ({}),
        callLlm: async () => {
          llmCalls++;
          return makeTextResponse("안녕하세요!");
        },
      },
    });

    assert.equal(llmCalls, 1);
    const msgEvent = events.find((e) => e.type === "message");
    assert.ok(msgEvent);
    assert.equal(msgEvent.content, "안녕하세요!");
  });

  it("tool call executes and feeds observation back", async () => {
    let llmCalls = 0;
    let toolCalls = 0;
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async (name, args) => {
          toolCalls++;
          assert.equal(name, "search_evidence");
          return { results: [{ id: "1", text: "Redis cache" }] };
        },
        callLlm: async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return makeToolCallResponse("search_evidence", { query: "Redis" });
          }
          return makeTextResponse("Redis 관련 커밋 3건을 찾았습니다.");
        },
      },
    });

    assert.equal(llmCalls, 2);
    assert.equal(toolCalls, 1);

    const msgEvent = events.find((e) => e.type === "message");
    assert.ok(msgEvent);
    assert.equal(msgEvent.content, "Redis 관련 커밋 3건을 찾았습니다.");
  });

  it("interrupt tool (ask_user) stops loop", async () => {
    let llmCalls = 0;
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => ({
          _interrupt: true,
          question: "어떤 직무를 목표로 하시나요?",
          context: "이력서 방향 설정",
        }),
        callLlm: async () => {
          llmCalls++;
          return makeToolCallResponse("ask_user", {
            question: "어떤 직무를 목표로 하시나요?",
            context: "이력서 방향 설정",
          });
        },
      },
    });

    assert.equal(llmCalls, 1);

    const askEvent = events.find((e) => e.type === "ask_user");
    assert.ok(askEvent);
    assert.equal(askEvent.question, "어떤 직무를 목표로 하시나요?");
    assert.equal(askEvent.context, "이력서 방향 설정");

    // No message event
    assert.ok(!events.find((e) => e.type === "message"));
  });

  it("interrupt tool (update_section) stops loop with diff", async () => {
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => ({
          _interrupt: true,
          diff: {
            section: "experience",
            operation: "replace",
            payload: { before: "old", after: "new" },
            evidence: [{ id: "e1" }],
          },
          messageId: "diff-123",
        }),
        callLlm: async () =>
          makeToolCallResponse("update_section", {
            section: "experience",
            operation: "replace",
            payload: { before: "old", after: "new" },
            evidence: [{ id: "e1" }],
          }),
      },
    });

    const diffEvent = events.find((e) => e.type === "diff");
    assert.ok(diffEvent);
    assert.equal(diffEvent.section, "experience");
    assert.equal(diffEvent.operation, "replace");
    assert.equal(diffEvent.messageId, "diff-123");
  });

  it("max iterations stops with fallback message", async () => {
    let llmCalls = 0;
    let toolCalls = 0;
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      maxIterations: 3,
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => {
          toolCalls++;
          return { results: [] };
        },
        callLlm: async () => {
          llmCalls++;
          return makeToolCallResponse("search_evidence", { query: "loop" }, `call-${llmCalls}`);
        },
      },
    });

    assert.equal(llmCalls, 3);
    assert.equal(toolCalls, 3);

    const msgEvents = events.filter((e) => e.type === "message");
    assert.equal(msgEvents.length, 1);
    assert.ok(msgEvents[0].content.includes("최대 반복 횟수"));
  });

  it("emits error message when LLM call fails", async () => {
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => ({}),
        callLlm: async () => {
          throw new Error("Network timeout");
        },
      },
    });

    const msgEvent = events.find((e) => e.type === "message");
    assert.ok(msgEvent);
    assert.ok(msgEvent.content.includes("오류"));
    assert.ok(msgEvent.content.includes("Network timeout"));
  });

  it("handles unknown tool name gracefully", async () => {
    let llmCalls = 0;
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => ({}),
        callLlm: async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return makeToolCallResponse("nonexistent_tool", {}, "call-bad");
          }
          return makeTextResponse("알겠습니다.");
        },
      },
    });

    // Loop continued after unknown tool error
    assert.equal(llmCalls, 2);
    const msgEvent = events.find((e) => e.type === "message");
    assert.equal(msgEvent.content, "알겠습니다.");
  });

  it("handles invalid JSON args gracefully", async () => {
    let llmCalls = 0;
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => ({}),
        callLlm: async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return {
              output: [
                {
                  type: "function_call",
                  name: "search_evidence",
                  arguments: "not-valid-json{{{",
                  call_id: "call-bad-json",
                },
              ],
            };
          }
          return makeTextResponse("다시 시도할게요.");
        },
      },
    });

    assert.equal(llmCalls, 2);
    const msgEvent = events.find((e) => e.type === "message");
    assert.equal(msgEvent.content, "다시 시도할게요.");
  });

  it("repeated tool failure terminates loop", async () => {
    let llmCalls = 0;
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => {
          throw new Error("DB connection failed");
        },
        callLlm: async () => {
          llmCalls++;
          return makeToolCallResponse("search_evidence", { query: "fail" });
        },
      },
    });

    // First failure: error fed back. Second failure with same args: terminate.
    assert.equal(llmCalls, 2);
    const msgEvent = events.find((e) => e.type === "message");
    assert.ok(msgEvent);
    assert.ok(msgEvent.content.includes("반복 실패"));
  });

  it("emits message when no API key", async () => {
    delete process.env.OPENAI_API_KEY;

    const events = [];
    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => ({}),
        callLlm: async () => makeTextResponse("should not reach"),
      },
    });

    const msgEvent = events.find((e) => e.type === "message");
    assert.ok(msgEvent);
    assert.ok(msgEvent.content.includes("API key"));
  });

  it("emits progress events for each iteration", async () => {
    let llmCalls = 0;
    const events = [];

    await runAgentLoop({
      messages: baseMessages(),
      onEvent: (e) => events.push(e),
      _deps: {
        allowedTools: ALLOWED_TOOLS,
        isInterruptTool,
        executeTool: async () => ({ results: [] }),
        callLlm: async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return makeToolCallResponse("search_evidence", { query: "test" });
          }
          return makeTextResponse("완료");
        },
      },
    });

    const progressEvents = events.filter((e) => e.type === "progress");
    // iteration 0: llm_call, tool_call; iteration 1: llm_call
    assert.ok(progressEvents.length >= 3);
    assert.equal(progressEvents[0].step, "llm_call");
    assert.equal(progressEvents[0].iteration, 0);
    assert.equal(progressEvents[1].step, "tool_call");
    assert.equal(progressEvents[1].toolName, "search_evidence");
  });
});
