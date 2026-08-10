import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let attempted = false;

export function loadCodexProxyEnv() {
  if (attempted || process.env.WORK_LOG_USE_CODEX_PROXY === "0") return false;
  const underTest = process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
  if (underTest && process.env.WORK_LOG_USE_CODEX_PROXY !== "1") return false;
  attempted = true;

  const configPath = process.env.WORK_LOG_CODEX_CONFIG_PATH || path.join(os.homedir(), ".codex", "config.toml");
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return false;
  }

  const parsed = parseCodexProxyConfig(raw, process.env.WORK_LOG_CODEX_PROVIDER);
  if (!parsed) return false;
  if (!process.env.WORK_LOG_LLM_URL) process.env.WORK_LOG_LLM_URL = parsed.baseUrl;
  if (!process.env.WORK_LOG_LLM_BEARER_TOKEN) {
    process.env.WORK_LOG_LLM_BEARER_TOKEN = parsed.bearerToken;
  }
  return true;
}

export function parseCodexProxyConfig(raw, providerOverride) {
  const provider = providerOverride || readTomlString(raw, "model_provider");
  if (!provider || !provider.toLowerCase().includes("cliproxy")) return null;

  const header = `[model_providers.${provider}]`;
  const headerIndex = raw.indexOf(header);
  if (headerIndex === -1) return null;
  const tail = raw.slice(headerIndex + header.length);
  const nextSectionIndex = tail.search(/^\s*\[/m);
  const section = nextSectionIndex === -1 ? tail : tail.slice(0, nextSectionIndex);
  const baseUrl = readTomlString(section, "base_url");
  const wireApi = readTomlString(section, "wire_api");
  const directToken = readTomlString(section, "experimental_bearer_token");
  const envKey = readTomlString(section, "env_key");
  const bearerToken = directToken || (envKey ? process.env[envKey] : "");
  if (!baseUrl || wireApi !== "responses" || !bearerToken) return null;
  return { provider, baseUrl, bearerToken };
}

export function resetCodexProxyConfigForTests() {
  attempted = false;
}

function readTomlString(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^${escaped}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"));
  return match?.[1] || "";
}
