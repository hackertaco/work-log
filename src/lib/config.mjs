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
    slackChannelIds: normalizeStringArray(merged.slackChannelIds ?? parseCsv(process.env.SLACK_CHANNEL_IDS || process.env.WORK_LOG_SLACK_CHANNEL_IDS || "")),
    zeudeEmail: merged.zeudeEmail || process.env.WORK_LOG_ZEUDE_EMAIL || "",
    // 한 사람이 도구별로 다른 이메일을 쓸 수 있다 — Claude Code 훅은 회사 이메일로,
    // Codex 로거는 개인 계정 이메일로 기록하는 경우가 실제로 있다(2026-07-31 확인).
    // 프로필이 반으로 쪼개지지 않도록 별칭을 모두 모아 조회한다.
    zeudeEmails: [...new Set(
      normalizeStringArray([
        merged.zeudeEmail || process.env.WORK_LOG_ZEUDE_EMAIL || "",
        ...(Array.isArray(merged.zeudeEmails) ? merged.zeudeEmails : []),
        ...parseCsv(process.env.WORK_LOG_ZEUDE_EMAILS || "")
      ]).map((e) => e.toLowerCase())
    )]
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

  // Zeude(ClickHouse) 프롬프트를 유저별 이메일로 조회하기 위한 매핑
  if (typeof sources.zeudeEmail === "string") overrides.zeudeEmail = sources.zeudeEmail;
  // 같은 사람의 다른 도구 계정(예: Codex 개인 계정) 이메일
  if (Array.isArray(sources.zeudeEmails)) overrides.zeudeEmails = sources.zeudeEmails;

  return overrides;
}

function parseCsv(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * 이 사람이 Zeude 에 남기는 모든 이메일을 모은다.
 *
 * 한 사람이 도구마다 다른 계정을 쓰는 일이 실제로 있다 — Claude Code 훅은 회사 이메일로,
 * Codex 로거는 개인 계정 이메일로 기록한다(2026-07-31 확인: 한 사람의 Codex 기록 4376건이
 * 개인 gmail 로 쌓여 프로필에서 통째로 빠져 있었다). 별칭을 모두 조회해야 프로필이
 * 반으로 쪼개지지 않는다. 비교는 소문자로 맞춘다.
 *
 * @returns {string[]} 소문자 이메일 목록 (중복 제거). 미설정이면 빈 배열.
 */
export function zeudeEmailsOf(config = {}) {
  const list = Array.isArray(config.zeudeEmails) && config.zeudeEmails.length
    ? config.zeudeEmails
    : [config.zeudeEmail || process.env.WORK_LOG_ZEUDE_EMAIL || ""];
  return [...new Set(list.map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean))];
}

function normalizeStringArray(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}
