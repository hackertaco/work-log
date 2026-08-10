import { loadCodexProxyEnv } from "./codexProxyConfig.mjs";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_MAX_CALLS_PER_PROCESS = 100;

let processCallCount = 0;

export class LlmGatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LlmGatewayError";
    this.code = code;
  }
}

export function isLlmDisabled() {
  return (
    process.env.WORK_LOG_DISABLE_LLM === "1" ||
    process.env.WORK_LOG_DISABLE_OPENAI === "1"
  );
}

export function getLlmBearerToken(override) {
  if (!process.env.WORK_LOG_LLM_BEARER_TOKEN) loadCodexProxyEnv();
  return override || process.env.WORK_LOG_LLM_BEARER_TOKEN || process.env.OPENAI_API_KEY || "";
}

export function getLlmModel(fallback = "gpt-5.4-mini") {
  return process.env.WORK_LOG_LLM_MODEL || process.env.WORK_LOG_OPENAI_MODEL || fallback;
}

export function getLlmAgentModel(fallback = "gpt-5.4") {
  return process.env.WORK_LOG_LLM_AGENT_MODEL || process.env.WORK_LOG_AGENT_MODEL || fallback;
}

export function getResponsesUrl({ allowInjectedFetchFallback = false } = {}) {
  if (!process.env.WORK_LOG_LLM_URL) loadCodexProxyEnv();
  const configured = process.env.WORK_LOG_LLM_URL || process.env.WORK_LOG_OPENAI_URL;
  if (!configured) {
    if (allowInjectedFetchFallback) return "http://localhost/v1/responses";
    throw new LlmGatewayError(
      "llm_url_missing",
      "LLM endpoint is not configured; set WORK_LOG_LLM_URL"
    );
  }

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new LlmGatewayError("llm_url_invalid", "WORK_LOG_LLM_URL must be an absolute URL");
  }

  if (url.pathname.replace(/\/$/, "").endsWith("/v1")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
  }

  const directOpenAi = url.hostname.toLowerCase() === "api.openai.com";
  if (directOpenAi && process.env.WORK_LOG_ALLOW_DIRECT_OPENAI !== "1") {
    throw new LlmGatewayError(
      "direct_openai_blocked",
      "Direct OpenAI billing is blocked; use WORK_LOG_LLM_URL for the CLI proxy"
    );
  }

  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new LlmGatewayError("llm_url_insecure", "Remote LLM endpoints must use HTTPS");
  }

  return url.toString();
}

export async function requestLlmResponse(
  payload,
  {
    fetchImpl = globalThis.fetch,
    apiKey,
    operation = "unknown",
    timeoutMs = numericEnv("WORK_LOG_LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    signal
  } = {}
) {
  if (isLlmDisabled()) {
    throw new LlmGatewayError("llm_disabled", "LLM integration is disabled");
  }

  const token = getLlmBearerToken(apiKey);
  if (!token) {
    throw new LlmGatewayError(
      "llm_bearer_missing",
      "LLM bearer token is not configured; set WORK_LOG_LLM_BEARER_TOKEN"
    );
  }

  const url = getResponsesUrl({
    allowInjectedFetchFallback: fetchImpl !== globalThis.fetch
  });
  const maxOutputTokens = Number(payload?.max_output_tokens);
  const configuredOutputCap = numericEnv(
    "WORK_LOG_LLM_MAX_OUTPUT_TOKENS",
    DEFAULT_MAX_OUTPUT_TOKENS
  );
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new LlmGatewayError(
      "llm_output_cap_missing",
      "Every LLM request must set a positive max_output_tokens value"
    );
  }
  if (maxOutputTokens > configuredOutputCap) {
    throw new LlmGatewayError(
      "llm_output_cap_exceeded",
      `Requested max_output_tokens exceeds the configured cap (${configuredOutputCap})`
    );
  }

  const callLimit = numericEnv(
    "WORK_LOG_LLM_MAX_CALLS_PER_PROCESS",
    DEFAULT_MAX_CALLS_PER_PROCESS
  );
  if (processCallCount >= callLimit) {
    throw new LlmGatewayError(
      "llm_process_budget_exhausted",
      `LLM process call budget exhausted (${callLimit})`
    );
  }
  processCallCount += 1;

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortFromParent();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new LlmGatewayError("llm_timeout", `LLM request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );

  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    console.info(`[llm-gateway] ${JSON.stringify({
      event: "llm_request",
      operation: safeLabel(operation),
      providerHost: new URL(url).hostname,
      model: safeLabel(payload?.model || "unknown"),
      maxOutputTokens,
      ok: false,
      latencyMs: Date.now() - startedAt,
      outcome: "network_error",
      errorCode: safeLabel(error?.code || error?.name || "unknown")
    })}`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromParent);
  }

  const telemetry = {
    event: "llm_request",
    operation: safeLabel(operation),
    providerHost: new URL(url).hostname,
    model: safeLabel(payload?.model || "unknown"),
    maxOutputTokens,
    status: response.status,
    ok: response.ok,
    latencyMs: Date.now() - startedAt,
    requestId:
      response.headers?.get?.("x-request-id") ||
      response.headers?.get?.("request-id") ||
      null
  };

  try {
    const data = await response.clone().json();
    telemetry.inputTokens = finiteOrNull(data?.usage?.input_tokens);
    telemetry.outputTokens = finiteOrNull(data?.usage?.output_tokens);
    telemetry.cachedInputTokens = finiteOrNull(data?.usage?.input_tokens_details?.cached_tokens);
  } catch {
    // Some proxy errors are not JSON. Status/latency telemetry is still useful.
  }
  console.info(`[llm-gateway] ${JSON.stringify(telemetry)}`);

  return response;
}

export function resetLlmGatewayForTests() {
  processCallCount = 0;
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function safeLabel(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._:/-]+/g, "_").slice(0, 120);
}
