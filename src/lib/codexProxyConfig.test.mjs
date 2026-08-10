import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCodexProxyConfig } from "./codexProxyConfig.mjs";

test("reads the active Responses-compatible CLIProxy provider", () => {
  const parsed = parseCodexProxyConfig(`
model_provider = "cliproxy-family"
model = "gpt-test"

[model_providers.other]
base_url = "https://other.example/v1"
wire_api = "responses"
experimental_bearer_token = "wrong"

[model_providers.cliproxy-family]
base_url = "https://proxy.example/v1"
wire_api = "responses"
experimental_bearer_token = "proxy-secret"
`);

  assert.deepStrictEqual(parsed, {
    provider: "cliproxy-family",
    baseUrl: "https://proxy.example/v1",
    bearerToken: "proxy-secret"
  });
});

test("rejects non-Responses and non-CLIProxy providers", () => {
  assert.strictEqual(
    parseCodexProxyConfig(`
model_provider = "openai"
[model_providers.openai]
base_url = "https://api.openai.com/v1"
wire_api = "responses"
experimental_bearer_token = "secret"
`),
    null
  );
  assert.strictEqual(
    parseCodexProxyConfig(`
model_provider = "cliproxy-family"
[model_providers.cliproxy-family]
base_url = "https://proxy.example/v1"
wire_api = "chat"
experimental_bearer_token = "secret"
`),
    null
  );
});
