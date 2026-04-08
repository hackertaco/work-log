/**
 * resumeAgent.mjs — ReAct loop orchestrator for the resume agent.
 *
 * Calls the LLM, dispatches tools, and manages conversation flow
 * with interrupt signals for user-facing actions (ask_user, update_section).
 */

import { TOOL_DEFINITIONS, executeTool, isInterruptTool } from "./resumeAgentTools.mjs";

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const AGENT_MODEL = process.env.WORK_LOG_AGENT_MODEL || "gpt-5.4";

const SYSTEM_PROMPT_TEMPLATE = `너는 이력서 개선을 도와주는 친근한 동료야.
워크로그 데이터(커밋, 슬랙, AI 세션)를 기반으로 이력서를 분석하고 개선안을 제안해.

행동 원칙:
1. 먼저 분석하고 제안해 — 사용자가 요청하기 전에 개선점을 찾아
2. 모든 제안에 근거를 달아 — "커밋 3건에서 확인" 식으로
3. 이력서 수정은 반드시 update_section 도구로 diff를 만들어 승인받아
4. 데이터가 부족하면 ask_user 도구로 솔직히 보충 질문해
5. 검색에 실패하면 솔직히 알려줘 — 빈 결과와 에러를 구분해
6. 친근하게, 하지만 전문적으로 — "오 이거 좋네요!" + 구체적 이유

{resumeSummary}`;

const ALLOWED_TOOLS = new Set(TOOL_DEFINITIONS.map((t) => t.name));

/**
 * Run the ReAct agent loop.
 *
 * @param {object} opts
 * @param {Array} opts.messages        Conversation messages (OpenAI format)
 * @param {string} [opts.resumeSummary] Resume context to inject into system prompt
 * @param {function} [opts.onEvent]    Event callback ({ type, ... })
 * @param {number} [opts.maxIterations] Max tool-call iterations (default 10)
 * @param {object} [opts._deps]       Internal: dependency overrides for testing
 * @returns {Promise<void>}
 */
export async function runAgentLoop({
  messages,
  resumeSummary = "",
  onEvent = () => {},
  maxIterations = 10,
  _deps = {},
}) {
  // Resolve dependencies (allow test overrides)
  const _executeTool = _deps.executeTool || executeTool;
  const _isInterruptTool = _deps.isInterruptTool || isInterruptTool;
  const _callLlm = _deps.callLlm || callLlm;
  const _allowedTools = _deps.allowedTools || ALLOWED_TOOLS;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    onEvent({ type: "message", content: "OpenAI API key가 설정되지 않았습니다." });
    return;
  }

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace(
    "{resumeSummary}",
    resumeSummary ? `\n현재 이력서 요약:\n${resumeSummary}` : "",
  );

  // Build running input: system + conversation + tool observations
  const input = [
    { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
    ...messages,
  ];

  // Track repeated failures: key = "toolName:argsJSON" → count
  const failureTracker = new Map();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    onEvent({ type: "progress", iteration, step: "llm_call" });

    let data;
    try {
      data = await _callLlm(input, apiKey);
    } catch (err) {
      onEvent({
        type: "message",
        content: `LLM 호출 중 오류가 발생했습니다: ${err.message}`,
      });
      return;
    }

    const outputs = data.output || [];

    // Find function_call items
    const functionCalls = outputs.filter((o) => o.type === "function_call");

    // If no function calls → text response, we're done
    if (functionCalls.length === 0) {
      const text = extractOutputText(outputs);
      onEvent({ type: "message", content: text || "응답을 생성하지 못했습니다." });
      return;
    }

    // Process the first function call
    const fc = functionCalls[0];
    const toolName = fc.name;
    const callId = fc.call_id;

    // Validate tool name
    if (!_allowedTools.has(toolName)) {
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
      });
      continue;
    }

    // Parse arguments
    let args;
    try {
      args = JSON.parse(fc.arguments || "{}");
    } catch {
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ error: "Invalid JSON in tool arguments" }),
      });
      continue;
    }

    onEvent({ type: "progress", iteration, step: "tool_call", toolName });

    // Execute tool
    let result;
    try {
      result = await _executeTool(toolName, args);
    } catch (err) {
      const failKey = `${toolName}:${fc.arguments}`;
      const count = (failureTracker.get(failKey) || 0) + 1;
      failureTracker.set(failKey, count);

      if (count >= 2) {
        onEvent({
          type: "message",
          content: `도구 '${toolName}' 실행이 반복 실패했습니다: ${err.message}`,
        });
        return;
      }

      input.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ error: err.message }),
      });
      continue;
    }

    // Handle interrupt tools
    if (_isInterruptTool(toolName)) {
      if (toolName === "ask_user") {
        onEvent({
          type: "ask_user",
          question: result.question,
          context: result.context,
        });
      } else if (toolName === "update_section") {
        onEvent({
          type: "diff",
          section: result.diff.section,
          operation: result.diff.operation,
          payload: result.diff.payload,
          evidence: result.diff.evidence,
          messageId: result.messageId,
        });
      }
      return;
    }

    // Normal tool — feed result back as observation, continue loop
    input.push({
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(result),
    });
  }

  // maxIterations reached
  onEvent({
    type: "message",
    content: "최대 반복 횟수에 도달했습니다. 질문을 더 구체적으로 해주시면 도움이 될 거예요.",
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function callLlm(input, apiKey) {
  const payload = {
    model: AGENT_MODEL,
    input,
    tools: TOOL_DEFINITIONS,
    max_output_tokens: 4000,
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${response.status} ${errText.slice(0, 400)}`);
  }

  return response.json();
}

function extractOutputText(outputs) {
  const texts = [];
  for (const item of outputs) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && part?.text) {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}
