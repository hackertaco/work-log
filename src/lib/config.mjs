import fs from "node:fs/promises";
import path from "node:path";

import { expandHome, fileExists, projectRoot } from "./utils.mjs";
import { sanitizeUserId } from "./authUsers.mjs";
import { getCurrentUserId } from "./requestContext.mjs";
import { scopeLocalDir } from "./userWorkspace.mjs";

const configPath = path.join(projectRoot, "work-log.config.json");
let envLoaded = false;

export async function loadConfig(options = {}) {
  await loadEnvFiles();

  const userId = sanitizeUserId(options.userId ?? getCurrentUserId());

  const defaults = {
    codexSessionsDir: "~/.codex/sessions",
    claudeProjectsDir: "~/.claude/projects",
    shellHistoryFile: "~/.zsh_history",
    vaultDir: "./vault",
    dataDir: "./data",
    includeSessionLogs: false,
    includeSlack: false,
    repoRoots: ["..", "../../opensource", "../../investment"],
    includeRepos: [],
    excludeRepos: ["work-log", "node_modules", ".git"]
  };

  let loaded = {};
  if (await fileExists(configPath)) {
    loaded = JSON.parse(await fs.readFile(configPath, "utf8"));
  }

  const userOverrides = loaded?.users && typeof loaded.users === "object" ? loaded.users[userId] || {} : {};
  const merged = { ...defaults, ...loaded, ...userOverrides };
  return {
    ...merged,
    includeSessionLogs: resolveBoolean(
      process.env.WORK_LOG_INCLUDE_SESSION_LOGS,
      merged.includeSessionLogs
    ),
    includeSlack: resolveBoolean(
      process.env.WORK_LOG_INCLUDE_SLACK,
      merged.includeSlack
    ),
    configPath,
    codexSessionsDir: resolveProjectPath(merged.codexSessionsDir),
    claudeProjectsDir: resolveProjectPath(merged.claudeProjectsDir),
    shellHistoryFile: resolveProjectPath(merged.shellHistoryFile),
    userId,
    vaultDir: scopeLocalDir(resolveProjectPath(merged.vaultDir), userId),
    dataDir: scopeLocalDir(resolveProjectPath(merged.dataDir), userId),
    repoRoots: merged.repoRoots.map(resolveProjectPath)
  };
}

async function loadEnvFiles() {
  if (envLoaded) return;
  envLoaded = true;

  for (const filename of [".env.local", ".env"]) {
    const filePath = path.join(projectRoot, filename);
    if (!(await fileExists(filePath))) continue;
    const raw = await fs.readFile(filePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (!key || process.env[key]) continue;
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function resolveBoolean(rawValue, fallback) {
  if (rawValue == null || rawValue === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(rawValue).toLowerCase());
}

function resolveProjectPath(inputPath) {
  const expanded = expandHome(inputPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}
