/**
 * resumeLogParser.mjs — PR/branch mention parser for work-log text.
 *
 * Detects PR references (PR #N, pull request #N, GitHub PR URLs, GitHub
 * commit-keyword references) and branch mentions (feature/*, fix/*, etc.)
 * in free-form log text.  Attempts to extract a project name from each
 * match where possible.
 *
 * Pure functions — no external dependencies, no I/O.
 *
 * Recognised patterns
 * ───────────────────
 * PR patterns:
 *   • "PR #123" / "PR#123"             (case-insensitive)
 *   • "pull request #123" / "pull request 123"
 *   • GitHub URL  github.com/org/repo/pull/123
 *   • "closes #123" / "fixes #42" / "resolves #7" (GitHub commit keywords)
 *
 * Branch patterns (conventional Git-flow / trunk-based prefixes):
 *   • feature/*, feat/*
 *   • fix/*, bugfix/*, hotfix/*
 *   • chore/*, refactor/*, docs/*, doc/*
 *   • test/*, tests/*, style/*, ci/*, cd/*
 *   • perf/*, release/*, build/*, revert/*
 *   • deps/*, infra/*, security/*
 *   • experiment/*, exp/*
 *
 * Project name extraction rules (applied to branch slugs):
 *   1. Sub-path slug  "org-name/ticket"  → "org-name"
 *   2. JIRA-style ticket  "PROJ-123-desc"  → "PROJ"
 *   3. All-uppercase prefix  "BACKEND-add-auth"  → "BACKEND"
 *   4. Otherwise → null
 *
 * For GitHub PR URLs the project is "org/repo".
 */

// ─── Branch prefix list ────────────────────────────────────────────────────────

/** Conventional Git-flow / trunk-based branch prefixes. */
const BRANCH_PREFIXES = [
  "feature",
  "feat",
  "fix",
  "bugfix",
  "hotfix",
  "chore",
  "refactor",
  "docs",
  "doc",
  "test",
  "tests",
  "style",
  "ci",
  "cd",
  "perf",
  "release",
  "build",
  "revert",
  "deps",
  "infra",
  "security",
  "experiment",
  "exp"
];

// Sorted longest-first to avoid partial matches (e.g. "feat" before "feature")
const SORTED_PREFIXES = [...BRANCH_PREFIXES].sort((a, b) => b.length - a.length);
const BRANCH_PREFIX_ALT = SORTED_PREFIXES.join("|");

// Branch slug: starts with alnum, allows alphanum, underscore, dot, slash, hyphen
const SLUG_CHARS = "[A-Za-z0-9][A-Za-z0-9_./-]*";

/** Regex source for a conventional branch (type/slug). */
const BRANCH_SOURCE = `\\b(${BRANCH_PREFIX_ALT})/(${SLUG_CHARS})`;

// ─── Pattern sources (stateless; callers create new RegExp instances) ──────────

const PR_HASH_SOURCE = "\\bpr\\s*#(\\d+)\\b";
const PR_WORD_SOURCE = "\\bpull\\s+request\\s+#?(\\d+)\\b";
const GITHUB_PR_URL_SOURCE =
  "https?://(?:www\\.)?github\\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/(\\d+)";
const GH_KEYWORD_SOURCE =
  "\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref(?:erence[sd]?)?)\\s+#(\\d+)\\b";

// ─── Public types (JSDoc) ──────────────────────────────────────────────────────

/**
 * @typedef {Object} PrMention
 * @property {'pr'} type
 * @property {string}      raw        Original matched text
 * @property {number}      prNumber   Pull-request number
 * @property {string|null} project    "org/repo" for GitHub URL matches, otherwise null
 * @property {number}      offset     Character offset in the source text
 */

/**
 * @typedef {Object} BranchMention
 * @property {'branch'} type
 * @property {string}      raw         Full branch string e.g. "feature/add-login"
 * @property {string}      branchType  Conventional prefix e.g. "feature", "fix"
 * @property {string}      branchSlug  Slug after the slash e.g. "add-login"
 * @property {string|null} project     Extracted project name, or null
 * @property {number}      offset      Character offset in the source text
 */

/** @typedef {PrMention|BranchMention} LogMention */

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse free-form work-log text and return all PR/branch mentions found.
 *
 * Results are sorted by first appearance (offset ascending).  Overlapping
 * matches are deduplicated — the first (leftmost) match wins.
 *
 * @param {string} text  Free-form work-log text
 * @returns {LogMention[]}
 */
export function parseLogMentions(text) {
  if (typeof text !== "string" || !text.trim()) return [];

  /** @type {Array<LogMention & {_end: number}>} */
  const raw = [];

  _collectGithubPrUrls(text, raw);
  _collectPrHashMentions(text, raw);
  _collectPrWordMentions(text, raw);
  _collectGhKeywordMentions(text, raw);
  _collectBranchMentions(text, raw);

  // Sort by offset ascending, then remove overlapping ranges
  raw.sort((a, b) => a.offset - b.offset || a._end - b._end);
  return _deduplicateByRange(raw);
}

/**
 * Convenience: return unique PR numbers in order of first appearance.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function extractPrNumbers(text) {
  const seen = new Set();
  const out = [];
  for (const m of parseLogMentions(text)) {
    if (m.type === "pr" && !seen.has(m.prNumber)) {
      seen.add(m.prNumber);
      out.push(m.prNumber);
    }
  }
  return out;
}

/**
 * Convenience: return unique branch names (type/slug) in order of first appearance.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractBranchNames(text) {
  const seen = new Set();
  const out = [];
  for (const m of parseLogMentions(text)) {
    if (m.type === "branch" && !seen.has(m.raw)) {
      seen.add(m.raw);
      out.push(m.raw);
    }
  }
  return out;
}

/**
 * Convenience: return unique project names extracted from all mentions.
 * Returns only non-null values, deduplicated, in order of first appearance.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractProjects(text) {
  const seen = new Set();
  const out = [];
  for (const m of parseLogMentions(text)) {
    if (m.project && !seen.has(m.project)) {
      seen.add(m.project);
      out.push(m.project);
    }
  }
  return out;
}

// ─── Collectors ────────────────────────────────────────────────────────────────

/**
 * Collect GitHub PR URL matches.
 * project = "org/repo"
 *
 * @param {string} text
 * @param {Array<LogMention & {_end:number}>} out
 */
function _collectGithubPrUrls(text, out) {
  const re = new RegExp(GITHUB_PR_URL_SOURCE, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    const org = m[1];
    const repo = m[2];
    const prNumber = parseInt(m[3], 10);
    out.push({
      type: "pr",
      raw: m[0],
      prNumber,
      project: `${org}/${repo}`,
      offset: m.index,
      _end: m.index + m[0].length
    });
  }
}

/**
 * Collect "PR #123" / "PR#123" matches.
 *
 * @param {string} text
 * @param {Array<LogMention & {_end:number}>} out
 */
function _collectPrHashMentions(text, out) {
  const re = new RegExp(PR_HASH_SOURCE, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      type: "pr",
      raw: m[0],
      prNumber: parseInt(m[1], 10),
      project: null,
      offset: m.index,
      _end: m.index + m[0].length
    });
  }
}

/**
 * Collect "pull request #123" / "pull request 123" matches.
 *
 * @param {string} text
 * @param {Array<LogMention & {_end:number}>} out
 */
function _collectPrWordMentions(text, out) {
  const re = new RegExp(PR_WORD_SOURCE, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      type: "pr",
      raw: m[0],
      prNumber: parseInt(m[1], 10),
      project: null,
      offset: m.index,
      _end: m.index + m[0].length
    });
  }
}

/**
 * Collect GitHub commit keyword references: closes/fixes/resolves #N.
 *
 * @param {string} text
 * @param {Array<LogMention & {_end:number}>} out
 */
function _collectGhKeywordMentions(text, out) {
  const re = new RegExp(GH_KEYWORD_SOURCE, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      type: "pr",
      raw: m[0],
      prNumber: parseInt(m[1], 10),
      project: null,
      offset: m.index,
      _end: m.index + m[0].length
    });
  }
}

/**
 * Collect conventional branch mentions (type/slug).
 *
 * @param {string} text
 * @param {Array<LogMention & {_end:number}>} out
 */
function _collectBranchMentions(text, out) {
  const re = new RegExp(BRANCH_SOURCE, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    const branchType = m[1].toLowerCase();
    const rawSlug = m[2];
    const branchSlug = _trimSlug(rawSlug);
    if (!branchSlug) continue;
    const fullBranch = `${branchType}/${branchSlug}`;
    // _end is based on what we actually kept after trimming
    const _end = m.index + branchType.length + 1 + branchSlug.length;
    out.push({
      type: "branch",
      raw: fullBranch,
      branchType,
      branchSlug,
      project: _extractProjectFromBranch(branchSlug),
      offset: m.index,
      _end
    });
  }
}

// ─── Project extraction ────────────────────────────────────────────────────────

/**
 * Attempt to extract a project name from a branch slug.
 *
 * Rules (priority order):
 *  1. Sub-path: "my-project/ticket" → "my-project"
 *  2. JIRA-style ticket prefix: "PROJ-123-desc" → "PROJ"
 *  3. All-uppercase short prefix: "BACKEND-add-auth" → "BACKEND"
 *  4. Fallback: null
 *
 * @param {string} slug  Branch slug (everything after "type/")
 * @returns {string|null}
 */
function _extractProjectFromBranch(slug) {
  if (!slug) return null;

  // Rule 1: sub-path "my-project/ticket"
  const slashIdx = slug.indexOf("/");
  if (slashIdx > 0) {
    const candidate = slug.slice(0, slashIdx);
    if (candidate.length > 0) return candidate;
  }

  // Rule 2: JIRA-style ticket ID "PROJ-123" or "PROJ-123-description"
  // Prefix must be 2-10 uppercase letters/digits, starting with a letter
  const ticketMatch = slug.match(/^([A-Z][A-Z0-9]{1,9})-\d+/);
  if (ticketMatch) {
    return ticketMatch[1];
  }

  // Rule 3: All-uppercase prefix (2-10 chars) followed by a hyphen
  // e.g. "BACKEND-add-auth", "API-new-endpoint"
  const upperPrefixMatch = slug.match(/^([A-Z]{2,10})-/);
  if (upperPrefixMatch) {
    return upperPrefixMatch[1];
  }

  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Trim trailing punctuation from a branch slug captured by the greedy regex.
 * Branch names should not end with: . , ; : ) ] } ' " ! ?
 *
 * @param {string} slug
 * @returns {string}
 */
function _trimSlug(slug) {
  return slug.replace(/[.,;:)}\]'"!?]+$/, "").trim();
}

/**
 * Remove mentions whose character ranges overlap with an earlier match.
 * Input must be sorted by offset ascending.
 * Strips the internal `_end` field before returning.
 *
 * @param {Array<LogMention & {_end:number}>} mentions  Sorted by offset
 * @returns {LogMention[]}
 */
function _deduplicateByRange(mentions) {
  const out = [];
  let lastEnd = -1;
  for (const mention of mentions) {
    if (mention.offset >= lastEnd) {
      const { _end, ...clean } = mention;
      out.push(clean);
      lastEnd = _end;
    }
  }
  return out;
}
