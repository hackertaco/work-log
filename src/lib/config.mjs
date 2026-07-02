import fs from "node:fs/promises";
import path from "node:path";

import { expandHome, fileExists, projectRoot } from "./utils.mjs";
import { getAuthUsers, sanitizeUserId } from "./authUsers.mjs";
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

  const fileUserOverrides = materializeUserOverrides(loaded?.users && typeof loaded.users === "object" ? loaded.users[userId] || {} : {});
  const envUser = getAuthUsers().find((user) => user.id === userId);
  const envUserOverrides = materializeUserOverrides(envUser?.sources || {});
  const merged = { ...defaults, ...loaded, ...fileUserOverrides, ...envUserOverrides };
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
    repoRoots: merged.repoRoots.map(resolveProjectPath),
    slackToken: merged.slackToken || process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN || "",
    slackUserId: merged.slackUserId || process.env.SLACK_USER_ID || process.env.WORK_LOG_SLACK_USER_ID || "",
    slackChannelIds: normalizeStringArray(merged.slackChannelIds ?? parseCsv(process.env.SLACK_CHANNEL_IDS || process.env.WORK_LOG_SLACK_CHANNEL_IDS || ""))
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

function materializeUserOverrides(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const sources = input.sources && typeof input.sources === "object" ? input.sources : input;
  const slack = sources.slack && typeof sources.slack === "object" ? sources.slack : {};

  const overrides = { ...input };
  delete overrides.sources;

  if (sources.includeSlack !== undefined) overrides.includeSlack = sources.includeSlack;
  if (sources.includeSessionLogs !== undefined) overrides.includeSessionLogs = sources.includeSessionLogs;
  if (Array.isArray(sources.repoRoots)) overrides.repoRoots = sources.repoRoots;
  if (Array.isArray(sources.includeRepos)) overrides.includeRepos = sources.includeRepos;
  if (Array.isArray(sources.excludeRepos)) overrides.excludeRepos = sources.excludeRepos;

  if (typeof slack.token === "string") overrides.slackToken = slack.token;
  if (typeof slack.userId === "string") overrides.slackUserId = slack.userId;
  if (Array.isArray(slack.channelIds)) overrides.slackChannelIds = slack.channelIds;

  return overrides;
}

function parseCsv(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeStringArray(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}
