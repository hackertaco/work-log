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

  test("system prompt counts prompts as evidence of work, but not of shipping", () => {
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
    // 커밋만 근거로 치면 AI 로 일한 날이 통째로 빈손이 된다 — 2026-08-03 은 커밋 2건에
    // 프롬프트 91건이었고, 스토리가 "핵심 흐름을 정리하고 개선함" 으로 떨어졌다.
    assert.match(systemText, /first-class evidence of what was worked on/);
    assert.doesNotMatch(systemText, /Slack are not the source of shipped work/);
    // 다만 "출시했다"는 주장은 여전히 커밋이 있어야 한다
    assert.match(systemText, /cannot establish on their own is that something SHIPPED/);
    assert.match(systemText, /resume_bullets must stay strictly commit-backed/);
    assert.match(systemText, /behavior signals/);
    assert.match(systemText, /working style, intent, and judgment/);
  });
});

test("open_threads 는 기록에 열려 있던 것만 — 내일 할 일 예측이 아니다", () => {
  const payload = buildSummaryPayload({
    date: "2026-08-04",
    heuristic_themes: [],
    git_commits: [],
    shell_commands: [],
    codex_sessions: [],
    claude_sessions: [],
    slack_contexts: []
  });

  const systemText = payload.input[0].content[0].text;
  assert.match(systemText, /open_threads is what the record shows was left open/);
  // 없으면 그럴듯한 다음 단계를 지어내지 말라는 지시가 핵심이다
  assert.match(systemText, /return an empty array rather than inventing plausible next steps/);
  assert.match(systemText, /NOT a prediction of tomorrow/);

  const schema = payload.text.format.schema;
  assert.ok(schema.required.includes("open_threads"));
  assert.equal(schema.properties.open_threads.minItems, 0, "열린 게 없는 날도 있어야 한다");
});
