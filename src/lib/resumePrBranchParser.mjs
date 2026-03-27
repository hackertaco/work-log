/**
 * PR/Branch Mention Parser — Batch Pipeline Input Stage (Sub-AC 11a/11b).
 *
 * Scans work-log data sources (git commits, shell history, session snippets)
 * for PR and branch mentions and produces per-project priority weights.
 *
 * Weights are consumed by the batch pipeline input-configuration stage
 * (batch.mjs + resumeWorkLogExtract.mjs) to surface high-activity projects
 * first in the LLM extraction prompt, improving resume-update accuracy for
 * days when a developer opened/merged PRs or worked on feature branches.
 *
 * ── Weight Scale ───────────────────────────────────────────────────────────────
 *   1.00 — direct PR-merge commit detected (e.g. "Merge pull request #N")
 *   0.75 — explicit PR number mentioned in commit subject or shell command
 *   0.50 — branch creation detected (git checkout -b / switch -c / gh pr create)
 *   0.25 — feature-branch name pattern in commit subject (feat/, fix/, hotfix/)
 *   0.10 — PR/branch keyword in session snippet (lowest-signal, heuristic)
 *
 * A project's final weight is the MAX of all individual mention weights for
 * that project (not a sum), preventing activity-burst inflation.
 *
 * ── Public API ─────────────────────────────────────────────────────────────────
 *   parsePRBranchMentions(text) → { prs, branches, projects }   (Sub-AC 11a)
 *   detectPrBranchMentions(opts) → PrBranchSignals
 *   computePipelineWeight(maxWeight, mentionCount) → combined weight (Sub-AC 11b)
 *   sortProjectsByPrWeight(projects, weights) → sorted copy
 */

import {
  extractPrNumbers,
  extractBranchNames,
  extractProjects
} from "./resumeLogParser.mjs";

// ── parsePRBranchMentions — Sub-AC 11a public API ──────────────────────────────

/**
 * @typedef {Object} PrBranchParseResult
 * @property {number[]}  prs      PR numbers found in `text`, deduplicated, in order of
 *                                first appearance.
 * @property {string[]}  branches Conventional branch names (type/slug) found in `text`,
 *                                deduplicated, in order of first appearance.
 * @property {string[]}  projects Project names inferred from branch slugs or GitHub PR
 *                                URLs, deduplicated, in order of first appearance.
 */

/**
 * Parse free-form work-log text for PR and branch mentions.
 *
 * This is the primary entry point for Sub-AC 11a.  It accepts a single string
 * (e.g. a daily log entry body) and returns structured arrays so that the batch
 * pipeline can rank projects and build richer LLM prompts without any external
 * API calls.
 *
 * Recognised PR patterns:
 *   "PR #123", "PR#123", "pull request #42", "pull request 42",
 *   "closes #5", "fixes #7", "resolves #300",
 *   https://github.com/org/repo/pull/N
 *
 * Recognised branch patterns (conventional Git-flow / trunk-based):
 *   feat/*, fix/*, hotfix/*, feature/*, release/*, chore/*, refactor/*,
 *   perf/*, test/*, tests/*, docs/*, doc/*, style/*, ci/*, cd/*, build/*,
 *   revert/*, deps/*, infra/*, security/*, experiment/*, exp/*
 *
 * Project name extraction rules (applied to branch slugs):
 *   1. Sub-path "org-name/ticket" → "org-name"
 *   2. JIRA-style ticket "PROJ-123-desc" → "PROJ"
 *   3. All-uppercase prefix "BACKEND-auth" → "BACKEND"
 *   4. GitHub PR URL → "org/repo"
 *
 * Pure function — no I/O, no external dependencies.
 *
 * @param {string} text  Free-form work-log entry text
 * @returns {PrBranchParseResult}
 */
export function parsePRBranchMentions(text) {
  return {
    prs: extractPrNumbers(text),
    branches: extractBranchNames(text),
    projects: extractProjects(text)
  };
}

// ── Mention-count boost configuration (Sub-AC 11b) ─────────────────────────────

/**
 * Logarithmic mention-count boost factor applied in computePipelineWeight().
 *
 * A value of 0.5 yields the following multipliers:
 *   1  mention → 1.00× (log2(1) = 0)
 *   2  mentions → 1.50×
 *   4  mentions → 2.00×
 *   8  mentions → 2.50×
 *
 * Logarithmic scaling prevents a burst of low-weight session mentions from
 * dominating a single high-weight PR-merge commit.
 */
const MENTION_BOOST_FACTOR = 0.5;

// ── Detection patterns ──────────────────────────────────────────────────────────

/** "Merge pull request #N" — highest-confidence PR signal */
const PR_MERGE_PATTERN = /\bmerge pull request\b/i;

/**
 * Explicit PR number references: "#123", "PR 456", "PR#789",
 * "pull request 12", "pull request #12"
 */
const PR_NUMBER_PATTERN = /(?:^|[\s(,;])(?:PR\s*#?|pull\s+request\s*#?)(\d{1,6})\b/i;

/** gh CLI PR commands: "gh pr create", "gh pr merge", "gh pr view", etc. */
const GH_PR_PATTERN = /\bgh\s+pr\s+(?:create|merge|view|review|checkout|close|edit|list)\b/i;

/**
 * Branch creation commands:
 *   git checkout -b <branch>
 *   git -C /path checkout -b <branch>
 *   git switch -c <branch>
 *   git switch --create <branch>
 *
 * The optional `(?:\s+-C\s+[\w/.-]+)?` group handles `git -C <path>` prefix.
 */
const BRANCH_CREATE_PATTERN =
  /\bgit(?:\s+-C\s+[\w/.-]+)?\s+(?:checkout\s+-b|switch\s+(?:-c|--create))\s+([\w/.-]+)/i;

/**
 * Conventional-commit branch name prefix in a commit subject or snippet.
 * Matches: feat/..., fix/..., hotfix/..., feature/..., release/...,
 *          chore/..., refactor/..., perf/..., test/...
 */
const BRANCH_NAME_PATTERN =
  /\b(?:feat|fix|hotfix|feature|release|chore|refactor|perf|test)\/[\w/-]+/i;

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PrBranchMention
 * @property {string}           repo    - Repository basename (e.g. "work-log")
 * @property {string}           text    - Truncated source text that triggered the match
 * @property {'pr'|'branch'}    type    - Signal category
 * @property {number}           weight  - Individual mention weight (0.10 – 1.00)
 * @property {'commit'|'shell'|'session'} source - Data source that produced the mention
 */

/**
 * @typedef {Object} PrBranchSignals
 * @property {Object.<string, number>} projectWeights
 *   Map of repo name → max signal weight (0–1).
 *   Only repos with ≥1 mention are present; absent repos have implicit weight 0.
 *   This is the RAW max weight (not mention-count-boosted) — used for the
 *   priority-project filter threshold (≥ 0.25).
 * @property {Object.<string, number>} pipelineWeights
 *   Map of repo name → combined pipeline weight (maxWeight × mention-count boost).
 *   Used for SORTING priority projects and work-log projects in the batch pipeline.
 *   Always ≥ corresponding projectWeights entry.
 * @property {Object.<string, number>} mentionCounts
 *   Map of repo name → total mention count across all data sources.
 *   "unknown" repos are excluded.
 * @property {PrBranchMention[]} mentions
 *   All individual mention records (useful for logging / debugging).
 */

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Detect PR and branch mentions across all work-log data sources.
 *
 * All parameters default to empty arrays, so the function is safe to call
 * with partial data (e.g. when session logs are not collected).
 *
 * @param {object} opts
 * @param {{ repo: string, repoPath?: string, subject: string }[]} [opts.gitCommits=[]]
 * @param {{ timestamp: string, command: string }[]}               [opts.shellHistory=[]]
 * @param {{ cwd?: string, snippets?: string[], summary?: string }[]} [opts.codexSessions=[]]
 * @param {{ cwd?: string, snippets?: string[], summary?: string }[]} [opts.claudeSessions=[]]
 * @returns {PrBranchSignals}
 */
export function detectPrBranchMentions({
  gitCommits = [],
  shellHistory = [],
  codexSessions = [],
  claudeSessions = []
} = {}) {
  /** @type {PrBranchMention[]} */
  const mentions = [];

  // ── Source 1: Git commit subjects ────────────────────────────────────────────
  for (const commit of gitCommits) {
    const repo = String(commit.repo || "unknown").trim();
    const subject = String(commit.subject || "").trim();
    if (!subject) continue;

    if (PR_MERGE_PATTERN.test(subject)) {
      // e.g. "Merge pull request #42 from owner/feat/login"
      mentions.push({ repo, text: _truncate(subject), type: "pr", weight: 1.0, source: "commit" });
    } else if (PR_NUMBER_PATTERN.test(subject)) {
      // e.g. "Fix login flow (PR #38)"
      mentions.push({ repo, text: _truncate(subject), type: "pr", weight: 0.75, source: "commit" });
    } else if (BRANCH_NAME_PATTERN.test(subject)) {
      // e.g. "feat/login: add OAuth2 callback"
      mentions.push({ repo, text: _truncate(subject), type: "branch", weight: 0.25, source: "commit" });
    }
  }

  // ── Source 2: Shell history ───────────────────────────────────────────────────
  // Shell commands are not always repo-specific; we try to infer the repo
  // from --repo flags or -C flags; fall back to "unknown" if absent.
  for (const entry of shellHistory) {
    const command = String(entry.command || "").trim();
    if (!command) continue;

    const repo = _inferRepoFromCommand(command);

    if (GH_PR_PATTERN.test(command)) {
      // e.g. "gh pr create --title ..." or "gh pr merge 42"
      mentions.push({ repo, text: _truncate(command), type: "pr", weight: 0.75, source: "shell" });
    } else if (BRANCH_CREATE_PATTERN.test(command)) {
      // e.g. "git checkout -b feat/new-feature"
      mentions.push({ repo, text: _truncate(command), type: "branch", weight: 0.5, source: "shell" });
    } else if (PR_NUMBER_PATTERN.test(command)) {
      // e.g. "git fetch origin pull/42/head"
      mentions.push({ repo, text: _truncate(command), type: "pr", weight: 0.75, source: "shell" });
    }
  }

  // ── Source 3: AI session snippets ────────────────────────────────────────────
  // Session snippets are free-form text; we look for any PR/branch keyword.
  // Weight is low (0.10) because these are least-reliable signals.
  // We add at most ONE mention per session to avoid over-counting chatter.
  const allSessions = [...codexSessions, ...claudeSessions];
  for (const session of allSessions) {
    const repo = _inferRepoFromCwd(session.cwd);
    const texts = [
      ...(Array.isArray(session.snippets) ? session.snippets : []),
      typeof session.summary === "string" ? session.summary : ""
    ].filter(Boolean);

    let matched = false;
    for (const text of texts) {
      if (matched) break;
      if (PR_NUMBER_PATTERN.test(text) || GH_PR_PATTERN.test(text) || PR_MERGE_PATTERN.test(text)) {
        mentions.push({ repo, text: _truncate(text), type: "pr", weight: 0.1, source: "session" });
        matched = true;
      } else if (BRANCH_CREATE_PATTERN.test(text) || BRANCH_NAME_PATTERN.test(text)) {
        mentions.push({ repo, text: _truncate(text), type: "branch", weight: 0.1, source: "session" });
        matched = true;
      }
    }
  }

  // ── Aggregate: max weight and mention count per repo ─────────────────────────
  // "unknown" repos are excluded from all weight maps (they would pollute sorting).
  /** @type {Object.<string, number>} */
  const projectWeights = {};
  /** @type {Object.<string, number>} */
  const mentionCounts = {};

  for (const mention of mentions) {
    const { repo, weight } = mention;
    if (!repo || repo === "unknown") continue;

    // Max weight (unchanged from original behaviour)
    if (projectWeights[repo] === undefined || weight > projectWeights[repo]) {
      projectWeights[repo] = weight;
    }

    // Total mention count (Sub-AC 11b: used for pipeline-weight computation)
    mentionCounts[repo] = (mentionCounts[repo] ?? 0) + 1;
  }

  // ── Compute pipeline weights: max weight × mention-count boost (Sub-AC 11b) ──
  //
  // pipelineWeight is used for SORTING projects in the batch pipeline input
  // construction stage.  It boosts projects with repeated PR/branch mentions
  // above same-max-weight projects that only appeared once.
  //
  // The filter threshold (0.25) still uses projectWeights (max weight) to
  // avoid promoting low-signal repos based on mention volume alone.
  /** @type {Object.<string, number>} */
  const pipelineWeights = {};
  for (const [repo, maxWeight] of Object.entries(projectWeights)) {
    pipelineWeights[repo] = computePipelineWeight(maxWeight, mentionCounts[repo] ?? 1);
  }

  return { projectWeights, pipelineWeights, mentionCounts, mentions };
}

/**
 * Return a copy of `projects` sorted by PR/branch weight (descending).
 *
 * Projects without a weight entry in `projectWeights` are placed last,
 * maintaining their original relative order among themselves (stable sort).
 *
 * @param {Array<{ repo: string }>} projects      Array of project objects (must have .repo)
 * @param {Object.<string, number>} projectWeights Weight map from detectPrBranchMentions
 * @returns {Array<{ repo: string }>}
 */
export function sortProjectsByPrWeight(projects, projectWeights) {
  if (!Array.isArray(projects) || projects.length === 0) return projects ?? [];
  if (!projectWeights || Object.keys(projectWeights).length === 0) return [...projects];

  return [...projects].sort((a, b) => {
    const wa = projectWeights[a.repo] ?? 0;
    const wb = projectWeights[b.repo] ?? 0;
    // Descending weight; equal-weight projects maintain stable original order
    return wb - wa;
  });
}

/**
 * Compute a combined pipeline weight from a project's max signal weight and
 * its total mention count across all data sources (Sub-AC 11b).
 *
 * Formula:
 *   pipelineWeight = maxWeight × (1 + log2(max(1, mentionCount)) × MENTION_BOOST_FACTOR)
 *
 * This scales the weight proportionally to mention count with logarithmic
 * diminishing returns, so a repo that appears many times gets a meaningful
 * boost without dominating over a genuine high-weight signal (e.g. a PR merge).
 *
 * Examples (MENTION_BOOST_FACTOR = 0.5):
 *   maxWeight=1.00, mentionCount=1  → 1.00  (no boost for single mention)
 *   maxWeight=0.75, mentionCount=2  → 0.75 × 1.50 = 1.125
 *   maxWeight=0.50, mentionCount=4  → 0.50 × 2.00 = 1.000
 *   maxWeight=0.25, mentionCount=8  → 0.25 × 2.50 = 0.625
 *
 * @param {number} maxWeight    Max signal weight from detectPrBranchMentions (0–1)
 * @param {number} mentionCount Total mention count for this repo (≥ 1)
 * @returns {number}  Combined pipeline weight (≥ 0)
 */
export function computePipelineWeight(maxWeight, mentionCount) {
  if (typeof maxWeight !== "number" || maxWeight <= 0) return 0;
  const count =
    typeof mentionCount === "number" && mentionCount >= 1 ? mentionCount : 1;
  return maxWeight * (1 + Math.log2(count) * MENTION_BOOST_FACTOR);
}

// ── Internal helpers ────────────────────────────────────────────────────────────

/**
 * Truncate a string to 200 characters for storage in mention records.
 *
 * @param {string} text
 * @returns {string}
 */
function _truncate(text) {
  const s = String(text || "");
  return s.length > 200 ? s.slice(0, 197) + "..." : s;
}

/**
 * Infer a repository name from a shell command by looking for common patterns:
 *   gh pr create --repo owner/repo
 *   git -C /path/to/repo ...
 *
 * Returns "unknown" when no repo can be extracted.
 *
 * @param {string} command
 * @returns {string}
 */
function _inferRepoFromCommand(command) {
  // gh --repo owner/repo or --repo repo
  const repoFlag = command.match(/(?:--repo|-R)\s+([\w.-]+\/[\w.-]+|[\w.-]+)/);
  if (repoFlag) {
    const parts = repoFlag[1].split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }

  // git -C /absolute/path
  const dashC = command.match(/git\s+-C\s+([\w/.-]+)/);
  if (dashC) {
    const parts = dashC[1].replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }

  return "unknown";
}

/**
 * Infer a repository name from a session's working-directory path.
 * Returns the last path component (the directory name).
 *
 * @param {string|undefined} cwd
 * @returns {string}
 */
function _inferRepoFromCwd(cwd) {
  if (!cwd) return "unknown";
  const parts = String(cwd).replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}
