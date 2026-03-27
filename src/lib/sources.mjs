import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  compactSummary,
  fileExists,
  isPathInsideRoots,
  isNoiseSnippet,
  isTimestampOnDate,
  looksLikeQuestion,
  readJsonLines,
  scoreSummaryCandidate,
  uniqueStrings,
  walk,
  ymdParts
} from "./utils.mjs";

export async function collectCodexSessions(config, date) {
  const { year, month, day } = ymdParts(date);
  const baseDir = path.join(config.codexSessionsDir, year, month, day);
  if (!(await fileExists(baseDir))) return [];

  const files = await walk(baseDir, {
    maxDepth: 3,
    include: (fullPath) => fullPath.endsWith(".jsonl")
  });

  const sessions = [];
  for (const filePath of files) {
    const rows = await readJsonLines(filePath);
    const sessionCwd = rows.find((row) => row?.type === "session_meta")?.payload?.cwd;
    if (sessionCwd && !isPathInsideRoots(sessionCwd, config.repoRoots)) continue;

    const userTexts = rows
      .filter((row) => row?.type === "response_item" && row?.payload?.type === "message" && row?.payload?.role === "user")
      .flatMap((row) => extractCodexContent(row));
    const assistantTexts = rows
      .filter((row) => row?.type === "response_item" && row?.payload?.type === "message" && row?.payload?.role === "assistant")
      .flatMap((row) => extractCodexContent(row));
    const finalTexts = rows
      .filter((row) => row?.type === "event_msg" && row?.payload?.type === "task_complete")
      .map((row) => row?.payload?.last_agent_message)
      .filter(Boolean);

    const snippets = uniqueStrings(
      [...finalTexts, ...assistantTexts, ...userTexts]
        .filter((text) => !isNoiseSnippet(text))
    );
    const summary = selectSessionSummary({
      source: "codex",
      userTexts,
      assistantTexts,
      finalTexts
    });
    if (!snippets.length && !summary) continue;
    sessions.push({
      source: "codex",
      filePath,
      cwd: sessionCwd,
      summary,
      snippetCount: snippets.length,
      snippets
    });
  }
  return sessions;
}

export async function collectClaudeSessions(config, date) {
  if (!(await fileExists(config.claudeProjectsDir))) return [];
  const files = await walk(config.claudeProjectsDir, {
    maxDepth: 6,
    include: (fullPath) => fullPath.endsWith(".jsonl")
  });

  const sessions = [];
  for (const filePath of files) {
    if (filePath.includes("claude-mem-observer") || filePath.includes("/subagents/")) continue;
    const rows = await readJsonLines(filePath);
    const datedRows = rows.filter((row) => {
      if (row?.timestamp && isTimestampOnDate(row.timestamp, date)) return true;
      if (row?.ts && isTimestampOnDate(row.ts * 1000, date)) return true;
      return false;
    });
    if (!datedRows.length) continue;

    const sessionCwd = datedRows.find((row) => typeof row?.cwd === "string")?.cwd;
    if (sessionCwd && !isPathInsideRoots(sessionCwd, config.repoRoots)) continue;

    const userTexts = datedRows
      .filter((row) => row?.type === "user")
      .flatMap(extractClaudeMessageTexts);
    const assistantTexts = datedRows
      .filter((row) => row?.type === "assistant")
      .flatMap(extractClaudeMessageTexts);
    const snippets = uniqueStrings(
      [...assistantTexts, ...userTexts]
        .filter((text) => !isNoiseSnippet(text))
    );
    const summary = selectSessionSummary({
      source: "claude",
      userTexts,
      assistantTexts,
      finalTexts: []
    });
    if (!snippets.length && !summary) continue;
    sessions.push({
      source: "claude",
      filePath,
      cwd: sessionCwd,
      summary,
      snippetCount: snippets.length,
      snippets
    });
  }
  return sessions;
}

export async function collectShellHistory(config, date) {
  if (!(await fileExists(config.shellHistoryFile))) return [];
  const raw = await fs.readFile(config.shellHistoryFile, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^: (\d+):\d+;(.*)$/);
    if (!match) continue;
    const timestamp = new Date(Number(match[1]) * 1000);
    if (timestamp.toISOString().slice(0, 10) !== date) continue;
    const command = match[2]?.trim();
    if (!command) continue;
    entries.push({
      timestamp: timestamp.toISOString(),
      command
    });
  }
  return entries;
}

export async function collectGitCommits(config, date) {
  const repos = await discoverGitRepos(config);
  const commits = [];
  const workingTree = [];

  for (const repo of repos) {
    try {
      const output = execFileSync(
        "git",
        [
          "-C",
          repo,
          "log",
          "--all",
          "--since",
          `${date} 00:00:00`,
          "--until",
          `${date} 23:59:59`,
          "--pretty=format:%H%x1f%aI%x1f%s"
        ],
        { encoding: "utf8" }
      );
      if (output.trim()) {
        for (const line of output.trim().split("\n")) {
          const [hash, authoredAt, subject] = line.split("\u001f");
          if (!hash || !subject) continue;
          commits.push({
            repo: path.basename(repo),
            repoPath: repo,
            hash: hash.slice(0, 7),
            authoredAt,
            subject
          });
        }
      }
    } catch {
      // Keep going; working tree status may still be useful even if log lookup fails.
    }

    try {
      const statusOutput = execFileSync(
        "git",
        ["-C", repo, "status", "--short"],
        { encoding: "utf8" }
      );
      if (!statusOutput.trim()) continue;
      const changes = statusOutput
        .trimEnd()
        .split("\n")
        .map((line) => {
          const status = line.slice(0, 2).trim() || "??";
          const file = line.slice(3).trim();
          return { status, file };
        })
        .filter((entry) => entry.file);

      workingTree.push({
        repo: path.basename(repo),
        repoPath: repo,
        changes
      });
    } catch {
      continue;
    }
  }

  return { commits, workingTree };
}

function extractClaudeMessageTexts(row) {
  if (row?.type === "user" && typeof row?.message?.content === "string") {
    return [row.message.content];
  }

  if (row?.type === "assistant" && Array.isArray(row?.message?.content)) {
    return row.message.content
      .map((item) => item?.text)
      .filter(Boolean);
  }

  return [];
}

function extractCodexContent(row) {
  const content = row?.payload?.content ?? [];
  return content
    .map((item) => item?.text || item?.input_text || item?.output_text)
    .filter(Boolean);
}

function selectSessionSummary({ source, userTexts, assistantTexts, finalTexts }) {
  const sourceCandidates = source === "codex"
    ? [...finalTexts, ...assistantTexts]
    : [...assistantTexts];

  const candidates = sourceCandidates
    .map((value) => compactSummary(value))
    .filter(Boolean)
    .map((value) => ({ value, score: scoreSummaryCandidate(value) }))
    .sort((left, right) => right.score - left.score);

  const winner = candidates.find((candidate) => candidate.score >= 5)?.value;
  if (winner) return winner;

  const fallbackPool = source === "codex"
    ? [...finalTexts, ...assistantTexts]
    : [...assistantTexts];
  const fallback = fallbackPool
    .map((value) => compactSummary(value))
    .find((value) => value && !isNoiseSnippet(value) && !looksLikeQuestion(value));

  return fallback || null;
}

async function discoverGitRepos(config) {
  const discovered = new Set(config.includeRepos.map((repo) => path.resolve(repo)));

  for (const root of config.repoRoots) {
    const reposFromRoot = await findGitRepos(root, 3, config.excludeRepos);
    for (const repoPath of reposFromRoot) {
      const repoName = path.basename(repoPath);
      if (config.excludeRepos.includes(repoName)) continue;
      discovered.add(repoPath);
    }
  }

  return [...discovered];
}

async function findGitRepos(root, maxDepth, excludeRepos) {
  const found = [];

  async function visit(currentPath, depth) {
    if (depth > maxDepth) return;

    if (await fileExists(path.join(currentPath, ".git"))) {
      found.push(currentPath);
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (excludeRepos.includes(entry.name)) continue;
      await visit(path.join(currentPath, entry.name), depth + 1);
    }
  }

  await visit(root, 0);
  return found;
}
