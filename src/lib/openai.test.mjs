import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildSummaryPayload } from "./openai.mjs";

describe("buildSummaryPayload", () => {
  test("includes slack contexts in the user payload", () => {
    const payload = buildSummaryPayload({
      date: "2026-03-31",
      heuristic_themes: ["workflow improvement"],
      git_commits: [],
      shell_commands: [],
      codex_sessions: [],
      claude_sessions: [],
      slack_contexts: [
        {
          text: "AI Native Camp 운영 전에 팀 기대치를 맞추려고 사전 설문을 먼저 돌리고 싶다.",
          context: [
            "혹시 오픈클로는 미포함인가요?!",
            "아아 시리즈로 되는군요? 감사합니다!"
          ]
        }
      ]
    });

    const userText = payload.input[1].content[0].text;
    assert.match(userText, /slack_contexts/);
    assert.match(userText, /AI Native Camp 운영 전에 팀 기대치를 맞추려고/);
    assert.match(userText, /사전 설문/);
  });

  test("system prompt treats Slack as behavior signal rather than shipped-work evidence", () => {
    const payload = buildSummaryPayload({
      date: "2026-03-31",
      heuristic_themes: [],
      git_commits: [],
      shell_commands: [],
      codex_sessions: [],
      claude_sessions: [],
      slack_contexts: []
    });

    const systemText = payload.input[0].content[0].text;
    assert.match(systemText, /Slack are not the source of shipped work/);
    assert.match(systemText, /behavior signals/);
    assert.match(systemText, /working style, intent, and judgment/);
  });
});
