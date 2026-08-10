import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  LlmGatewayError,
  getResponsesUrl,
  requestLlmResponse,
  resetLlmGatewayForTests
} from "./llmGateway.mjs";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "WORK_LOG_ALLOW_DIRECT_OPENAI",
  "WORK_LOG_DISABLE_LLM",
  "WORK_LOG_DISABLE_OPENAI",
  "WORK_LOG_LLM_BEARER_TOKEN",
  "WORK_LOG_LLM_MAX_CALLS_PER_PROCESS",
  "WORK_LOG_LLM_MAX_OUTPUT_TOKENS",
  "WORK_LOG_LLM_TIMEOUT_MS",
  "WORK_LOG_LLM_URL",
  "WORK_LOG_OPENAI_URL"
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetLlmGatewayForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("blocks direct OpenAI billing unless explicitly allowed", () => {
  process.env.WORK_LOG_LLM_URL = "https://api.openai.com/v1/responses";
  assert.throws(
    () => getResponsesUrl(),
    (error) => error instanceof LlmGatewayError && error.code === "direct_openai_blocked"
  );
});

test("normalizes a CLI proxy /v1 base URL and uses its bearer token", async () => {
  process.env.WORK_LOG_LLM_URL = "https://proxy.example.test/v1";
  process.env.WORK_LOG_LLM_BEARER_TOKEN = "proxy-secret-token";
  let request;
  const response = await requestLlmResponse(
    { model: "gpt-test", max_output_tokens: 10, input: "test" },
    {
      operation: "unit-test",
      fetchImpl: async (url, init) => {
        request = { url, init };
        return new Response(JSON.stringify({ output_text: "ok", usage: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
  );

  assert.strictEqual(response.status, 200);
  assert.strictEqual(request.url, "https://proxy.example.test/v1/responses");
  assert.strictEqual(request.init.headers.Authorization, "Bearer proxy-secret-token");
});

test("disable switch prevents network calls", async () => {
  process.env.WORK_LOG_DISABLE_LLM = "1";
  let called = false;
  await assert.rejects(
    requestLlmResponse(
      { model: "gpt-test", max_output_tokens: 10 },
      { fetchImpl: async () => { called = true; } }
    ),
    (error) => error.code === "llm_disabled"
  );
  assert.strictEqual(called, false);
});

test("rejects missing and excessive output ceilings", async () => {
  process.env.WORK_LOG_LLM_URL = "https://proxy.example.test/v1";
  process.env.WORK_LOG_LLM_BEARER_TOKEN = "proxy-secret-token";
  process.env.WORK_LOG_LLM_MAX_OUTPUT_TOKENS = "20";

  await assert.rejects(
    requestLlmResponse({ model: "gpt-test" }),
    (error) => error.code === "llm_output_cap_missing"
  );
  await assert.rejects(
    requestLlmResponse({ model: "gpt-test", max_output_tokens: 21 }),
    (error) => error.code === "llm_output_cap_exceeded"
  );
});

test("times out through the shared abort signal", async () => {
  process.env.WORK_LOG_LLM_URL = "https://proxy.example.test/v1";
  process.env.WORK_LOG_LLM_BEARER_TOKEN = "proxy-secret-token";

  await assert.rejects(
    requestLlmResponse(
      { model: "gpt-test", max_output_tokens: 10 },
      {
        timeoutMs: 5,
        fetchImpl: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          })
      }
    ),
    (error) => error.code === "llm_timeout"
  );
});

test("telemetry never prints bearer tokens or request input", async () => {
  process.env.WORK_LOG_LLM_URL = "https://proxy.example.test/v1";
  process.env.WORK_LOG_LLM_BEARER_TOKEN = "do-not-log-this-secret";
  const lines = [];
  const originalInfo = console.info;
  console.info = (...args) => lines.push(args.join(" "));
  try {
    await requestLlmResponse(
      { model: "gpt-test", max_output_tokens: 10, input: "private prompt body" },
      {
        operation: "secret-redaction",
        fetchImpl: async () =>
          new Response(JSON.stringify({ output_text: "private answer", usage: {} }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      }
    );
  } finally {
    console.info = originalInfo;
  }

  const output = lines.join("\n");
  assert.doesNotMatch(output, /do-not-log-this-secret/);
  assert.doesNotMatch(output, /private prompt body/);
  assert.doesNotMatch(output, /private answer/);
});
