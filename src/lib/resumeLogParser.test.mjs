/**
 * Tests for resumeLogParser.mjs
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/resumeLogParser.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseLogMentions,
  extractPrNumbers,
  extractBranchNames,
  extractProjects
} from "./resumeLogParser.mjs";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return only the subset of fields that are easy to assert on in most tests.
 * Strips `offset` unless the test specifically needs it.
 *
 * @param {import('./resumeLogParser.mjs').LogMention[]} mentions
 * @returns {object[]}
 */
function slim(mentions) {
  return mentions.map(({ type, raw, ...rest }) => {
    const out = { type, raw };
    if (type === "pr") out.prNumber = rest.prNumber;
    if (type === "branch") {
      out.branchType = rest.branchType;
      out.branchSlug = rest.branchSlug;
    }
    out.project = rest.project;
    return out;
  });
}

// ─── parseLogMentions ─────────────────────────────────────────────────────────

describe("parseLogMentions", () => {
  // ── Empty / trivial input ──────────────────────────────────────────────────

  it("returns [] for empty string", () => {
    assert.deepEqual(parseLogMentions(""), []);
  });

  it("returns [] for whitespace-only string", () => {
    assert.deepEqual(parseLogMentions("   \n\t  "), []);
  });

  it("returns [] for non-string input (null)", () => {
    assert.deepEqual(parseLogMentions(null), []);
  });

  it("returns [] for non-string input (undefined)", () => {
    assert.deepEqual(parseLogMentions(undefined), []);
  });

  it("returns [] for text with no mentions", () => {
    assert.deepEqual(parseLogMentions("Had a great standup today."), []);
  });

  // ── PR #N patterns ─────────────────────────────────────────────────────────

  it("detects 'PR #123'", () => {
    const result = slim(parseLogMentions("Merged PR #123 into main."));
    assert.deepEqual(result, [
      { type: "pr", raw: "PR #123", prNumber: 123, project: null }
    ]);
  });

  it("detects 'PR#456' (no space before hash)", () => {
    const result = slim(parseLogMentions("Reviewed PR#456 today."));
    assert.deepEqual(result, [
      { type: "pr", raw: "PR#456", prNumber: 456, project: null }
    ]);
  });

  it("detects 'pr #7' (lowercase)", () => {
    const result = slim(parseLogMentions("Opened pr #7 for review."));
    assert.deepEqual(result, [
      { type: "pr", raw: "pr #7", prNumber: 7, project: null }
    ]);
  });

  it("detects 'Pr #99' (mixed case)", () => {
    const result = slim(parseLogMentions("See Pr #99."));
    assert.deepEqual(result, [
      { type: "pr", raw: "Pr #99", prNumber: 99, project: null }
    ]);
  });

  // ── pull request patterns ──────────────────────────────────────────────────

  it("detects 'pull request #42'", () => {
    const result = slim(parseLogMentions("Created pull request #42."));
    assert.deepEqual(result, [
      { type: "pr", raw: "pull request #42", prNumber: 42, project: null }
    ]);
  });

  it("detects 'pull request 42' (no hash)", () => {
    const result = slim(parseLogMentions("See pull request 42 for details."));
    assert.deepEqual(result, [
      { type: "pr", raw: "pull request 42", prNumber: 42, project: null }
    ]);
  });

  it("detects 'Pull Request #10' (capitalized)", () => {
    const result = slim(parseLogMentions("Submitted Pull Request #10."));
    assert.deepEqual(result, [
      { type: "pr", raw: "Pull Request #10", prNumber: 10, project: null }
    ]);
  });

  // ── GitHub PR URL patterns ─────────────────────────────────────────────────

  it("detects GitHub PR URL and extracts org/repo as project", () => {
    const url =
      "https://github.com/my-org/work-log/pull/55";
    const result = slim(parseLogMentions(`Reviewed ${url} today.`));
    assert.deepEqual(result, [
      {
        type: "pr",
        raw: url,
        prNumber: 55,
        project: "my-org/work-log"
      }
    ]);
  });

  it("detects GitHub PR URL with http://", () => {
    const url = "http://github.com/acme/backend/pull/200";
    const result = slim(parseLogMentions(url));
    assert.deepEqual(result, [
      { type: "pr", raw: url, prNumber: 200, project: "acme/backend" }
    ]);
  });

  it("detects GitHub PR URL with www.", () => {
    const url = "https://www.github.com/org/repo/pull/1";
    const result = slim(parseLogMentions(url));
    assert.deepEqual(result, [
      { type: "pr", raw: url, prNumber: 1, project: "org/repo" }
    ]);
  });

  // ── GitHub commit keyword patterns ────────────────────────────────────────

  it("detects 'closes #88'", () => {
    const result = slim(parseLogMentions("closes #88"));
    assert.deepEqual(result, [
      { type: "pr", raw: "closes #88", prNumber: 88, project: null }
    ]);
  });

  it("detects 'fixes #7'", () => {
    const result = slim(parseLogMentions("fixes #7"));
    assert.deepEqual(result, [
      { type: "pr", raw: "fixes #7", prNumber: 7, project: null }
    ]);
  });

  it("detects 'Resolves #300' (capitalized)", () => {
    const result = slim(parseLogMentions("Resolves #300"));
    assert.deepEqual(result, [
      { type: "pr", raw: "Resolves #300", prNumber: 300, project: null }
    ]);
  });

  it("detects 'fixed #12'", () => {
    const result = slim(parseLogMentions("fixed #12"));
    assert.deepEqual(result, [
      { type: "pr", raw: "fixed #12", prNumber: 12, project: null }
    ]);
  });

  it("detects 'closed #5'", () => {
    const result = slim(parseLogMentions("closed #5"));
    assert.deepEqual(result, [
      { type: "pr", raw: "closed #5", prNumber: 5, project: null }
    ]);
  });

  it("detects 'resolved #99'", () => {
    const result = slim(parseLogMentions("resolved #99"));
    assert.deepEqual(result, [
      { type: "pr", raw: "resolved #99", prNumber: 99, project: null }
    ]);
  });

  // ── Branch patterns — feature/* ───────────────────────────────────────────

  it("detects 'feature/add-login'", () => {
    const result = slim(parseLogMentions("Worked on feature/add-login today."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "feature/add-login",
        branchType: "feature",
        branchSlug: "add-login",
        project: null
      }
    ]);
  });

  it("detects 'feature/PROJ-123-add-login' and extracts PROJ as project", () => {
    const result = slim(
      parseLogMentions("Pushed to feature/PROJ-123-add-login.")
    );
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "feature/PROJ-123-add-login",
        branchType: "feature",
        branchSlug: "PROJ-123-add-login",
        project: "PROJ"
      }
    ]);
  });

  it("detects 'feature/work-log/resume-panel' and extracts 'work-log' as project", () => {
    const result = slim(
      parseLogMentions("Created feature/work-log/resume-panel branch.")
    );
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "feature/work-log/resume-panel",
        branchType: "feature",
        branchSlug: "work-log/resume-panel",
        project: "work-log"
      }
    ]);
  });

  // ── Branch patterns — fix/* ───────────────────────────────────────────────

  it("detects 'fix/login-redirect'", () => {
    const result = slim(parseLogMentions("Pushed fix/login-redirect."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "fix/login-redirect",
        branchType: "fix",
        branchSlug: "login-redirect",
        project: null
      }
    ]);
  });

  it("detects 'hotfix/critical-db-issue'", () => {
    const result = slim(
      parseLogMentions("Deployed hotfix/critical-db-issue to prod.")
    );
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "hotfix/critical-db-issue",
        branchType: "hotfix",
        branchSlug: "critical-db-issue",
        project: null
      }
    ]);
  });

  it("detects 'bugfix/AUTH-55-session-expiry' and extracts AUTH as project", () => {
    const result = slim(
      parseLogMentions("Working on bugfix/AUTH-55-session-expiry.")
    );
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "bugfix/AUTH-55-session-expiry",
        branchType: "bugfix",
        branchSlug: "AUTH-55-session-expiry",
        project: "AUTH"
      }
    ]);
  });

  // ── Branch patterns — other types ────────────────────────────────────────

  it("detects 'chore/update-deps'", () => {
    const result = slim(parseLogMentions("Merged chore/update-deps."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "chore/update-deps",
        branchType: "chore",
        branchSlug: "update-deps",
        project: null
      }
    ]);
  });

  it("detects 'refactor/extract-utils'", () => {
    const result = slim(parseLogMentions("Started refactor/extract-utils."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "refactor/extract-utils",
        branchType: "refactor",
        branchSlug: "extract-utils",
        project: null
      }
    ]);
  });

  it("detects 'docs/api-reference'", () => {
    const result = slim(parseLogMentions("Updated docs/api-reference."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "docs/api-reference",
        branchType: "docs",
        branchSlug: "api-reference",
        project: null
      }
    ]);
  });

  it("detects 'release/v2.0.0'", () => {
    const result = slim(parseLogMentions("Cut release/v2.0.0 branch."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "release/v2.0.0",
        branchType: "release",
        branchSlug: "v2.0.0",
        project: null
      }
    ]);
  });

  it("detects 'ci/add-lint-step'", () => {
    const result = slim(parseLogMentions("Pushed ci/add-lint-step."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "ci/add-lint-step",
        branchType: "ci",
        branchSlug: "add-lint-step",
        project: null
      }
    ]);
  });

  it("detects 'perf/cache-layer'", () => {
    const result = slim(parseLogMentions("Opened PR from perf/cache-layer."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "perf/cache-layer",
        branchType: "perf",
        branchSlug: "cache-layer",
        project: null
      }
    ]);
  });

  it("detects 'security/patch-jwt'", () => {
    const result = slim(parseLogMentions("Deployed security/patch-jwt fix."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "security/patch-jwt",
        branchType: "security",
        branchSlug: "patch-jwt",
        project: null
      }
    ]);
  });

  it("detects 'experiment/new-algo'", () => {
    const result = slim(
      parseLogMentions("Testing experiment/new-algo branch.")
    );
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "experiment/new-algo",
        branchType: "experiment",
        branchSlug: "new-algo",
        project: null
      }
    ]);
  });

  it("detects 'feat/short-alias' (feat alias)", () => {
    const result = slim(parseLogMentions("Merged feat/short-alias."));
    assert.deepEqual(result, [
      {
        type: "branch",
        raw: "feat/short-alias",
        branchType: "feat",
        branchSlug: "short-alias",
        project: null
      }
    ]);
  });

  // ── Uppercase-prefix project extraction ──────────────────────────────────

  it("extracts uppercase prefix 'BACKEND' from 'feature/BACKEND-search'", () => {
    const result = slim(parseLogMentions("feature/BACKEND-search"));
    assert.equal(result[0].project, "BACKEND");
  });

  it("does NOT extract project from all-lowercase slug 'feature/add-search'", () => {
    const result = slim(parseLogMentions("feature/add-search"));
    assert.equal(result[0].project, null);
  });

  // ── Trailing punctuation trimming ─────────────────────────────────────────

  it("trims trailing period from branch slug", () => {
    const result = slim(parseLogMentions("Worked on feature/add-login."));
    assert.equal(result[0].raw, "feature/add-login");
    assert.equal(result[0].branchSlug, "add-login");
  });

  it("trims trailing comma from branch slug", () => {
    const result = slim(
      parseLogMentions("Branches: feature/add-login, fix/bug-1.")
    );
    assert.equal(result[0].raw, "feature/add-login");
    assert.equal(result[1].raw, "fix/bug-1");
  });

  it("trims trailing ')' from branch slug in parentheses context", () => {
    const result = slim(
      parseLogMentions("(see feature/add-login)")
    );
    assert.equal(result[0].raw, "feature/add-login");
  });

  // ── Mixed text with multiple mentions ─────────────────────────────────────

  it("detects both PR and branch in same sentence", () => {
    const text =
      "Opened PR #42 from feature/PROJ-123-new-ui to main.";
    const result = slim(parseLogMentions(text));
    assert.equal(result.length, 2);
    assert.equal(result[0].type, "pr");
    assert.equal(result[0].prNumber, 42);
    assert.equal(result[1].type, "branch");
    assert.equal(result[1].raw, "feature/PROJ-123-new-ui");
    assert.equal(result[1].project, "PROJ");
  });

  it("detects multiple branches in same text, sorted by offset", () => {
    const text =
      "Today I worked on feature/add-login and fix/session-bug.";
    const result = slim(parseLogMentions(text));
    assert.equal(result.length, 2);
    assert.equal(result[0].raw, "feature/add-login");
    assert.equal(result[1].raw, "fix/session-bug");
  });

  it("detects multiple PRs in same text", () => {
    const text = "Reviewed PR #10 and PR #20 this morning.";
    const result = slim(parseLogMentions(text));
    assert.equal(result.length, 2);
    assert.equal(result[0].prNumber, 10);
    assert.equal(result[1].prNumber, 20);
  });

  it("deduplicates identical branch mentioned twice", () => {
    const branches = extractBranchNames(
      "feature/add-login (feature/add-login) is now merged."
    );
    assert.deepEqual(branches, ["feature/add-login"]);
  });

  it("handles multi-line log text", () => {
    const text = [
      "Morning: reviewed PR #5.",
      "Afternoon: pushed feature/add-export.",
      "Evening: merged fix/null-check."
    ].join("\n");
    const result = slim(parseLogMentions(text));
    assert.equal(result.length, 3);
    assert.equal(result[0].prNumber, 5);
    assert.equal(result[1].raw, "feature/add-export");
    assert.equal(result[2].raw, "fix/null-check");
  });

  // ── Overlapping match deduplication ──────────────────────────────────────

  it("does not double-count a GitHub PR URL as both URL and PR #N", () => {
    // The URL contains /pull/55, which should NOT also emit a separate PR#55 match
    const url = "https://github.com/my-org/repo/pull/55";
    const result = parseLogMentions(url);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, "pr");
    assert.equal(result[0].prNumber, 55);
    assert.equal(result[0].project, "my-org/repo");
  });

  // ── Offset field ──────────────────────────────────────────────────────────

  it("sets offset to correct character index", () => {
    const text = "See PR #42.";
    const result = parseLogMentions(text);
    assert.equal(result[0].offset, text.indexOf("PR #42"));
  });

  it("sets offset=0 when mention is at start of string", () => {
    const result = parseLogMentions("PR #1 is important.");
    assert.equal(result[0].offset, 0);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("does not match 'apr' as 'pr' (word boundary check)", () => {
    const result = parseLogMentions("apr #10 is a month.");
    assert.equal(result.length, 0);
  });

  it("does not match 'features/foo' (pluralised — not in BRANCH_PREFIXES)", () => {
    const result = parseLogMentions("See features/foo in the repo.");
    assert.equal(result.length, 0);
  });

  it("handles branch slug with dots (e.g. version tag)", () => {
    const result = slim(parseLogMentions("release/1.2.3 is tagged."));
    assert.equal(result[0].branchSlug, "1.2.3");
  });

  it("handles branch slug with underscores", () => {
    const result = slim(parseLogMentions("feature/my_new_feature works."));
    assert.equal(result[0].branchSlug, "my_new_feature");
  });
});

// ─── extractPrNumbers ────────────────────────────────────────────────────────

describe("extractPrNumbers", () => {
  it("returns [] for empty string", () => {
    assert.deepEqual(extractPrNumbers(""), []);
  });

  it("returns a single PR number", () => {
    assert.deepEqual(extractPrNumbers("Merged PR #42."), [42]);
  });

  it("returns multiple PR numbers in order", () => {
    assert.deepEqual(
      extractPrNumbers("PR #10 and pull request #20 were reviewed."),
      [10, 20]
    );
  });

  it("deduplicates repeated PR number", () => {
    assert.deepEqual(extractPrNumbers("PR #5 (see PR #5)"), [5]);
  });

  it("returns [] when only branch mentions exist", () => {
    assert.deepEqual(extractPrNumbers("feature/add-login"), []);
  });

  it("extracts PR number from GitHub URL", () => {
    assert.deepEqual(
      extractPrNumbers("https://github.com/org/repo/pull/77"),
      [77]
    );
  });

  it("extracts PR number from 'closes #34'", () => {
    assert.deepEqual(extractPrNumbers("closes #34"), [34]);
  });
});

// ─── extractBranchNames ──────────────────────────────────────────────────────

describe("extractBranchNames", () => {
  it("returns [] for empty string", () => {
    assert.deepEqual(extractBranchNames(""), []);
  });

  it("returns a single branch name", () => {
    assert.deepEqual(
      extractBranchNames("Pushed to feature/add-login."),
      ["feature/add-login"]
    );
  });

  it("returns multiple branch names in order", () => {
    const names = extractBranchNames(
      "feature/add-login and fix/session-bug are merged."
    );
    assert.deepEqual(names, ["feature/add-login", "fix/session-bug"]);
  });

  it("deduplicates repeated branch name", () => {
    const names = extractBranchNames(
      "feature/add-login, PR for feature/add-login."
    );
    assert.deepEqual(names, ["feature/add-login"]);
  });

  it("returns [] when only PR mentions exist", () => {
    assert.deepEqual(extractBranchNames("PR #5 is merged."), []);
  });

  it("lowercases the branch type", () => {
    // The parser canonicalises the type to lowercase
    const names = extractBranchNames("Feature/Add-Login merged.");
    assert.deepEqual(names, ["feature/Add-Login"]);
  });
});

// ─── extractProjects ─────────────────────────────────────────────────────────

describe("extractProjects", () => {
  it("returns [] for empty string", () => {
    assert.deepEqual(extractProjects(""), []);
  });

  it("returns [] when no project can be extracted", () => {
    assert.deepEqual(
      extractProjects("feature/add-login and PR #5."),
      []
    );
  });

  it("extracts project from JIRA-style branch", () => {
    assert.deepEqual(
      extractProjects("feature/PROJ-42-new-ui was merged."),
      ["PROJ"]
    );
  });

  it("extracts project from sub-path branch", () => {
    assert.deepEqual(
      extractProjects("Created feature/work-log/resume-panel."),
      ["work-log"]
    );
  });

  it("extracts project from GitHub PR URL", () => {
    assert.deepEqual(
      extractProjects(
        "See https://github.com/my-org/backend/pull/10 for details."
      ),
      ["my-org/backend"]
    );
  });

  it("deduplicates same project extracted from two mentions", () => {
    const text =
      "feature/PROJ-1-foo and feature/PROJ-2-bar were both merged.";
    assert.deepEqual(extractProjects(text), ["PROJ"]);
  });

  it("returns multiple distinct projects", () => {
    const text =
      "feature/PROJ-1-foo and feature/work-log/bar and https://github.com/org/repo/pull/1";
    const projects = extractProjects(text);
    assert.ok(projects.includes("PROJ"));
    assert.ok(projects.includes("work-log"));
    assert.ok(projects.includes("org/repo"));
    assert.equal(projects.length, 3);
  });
});
