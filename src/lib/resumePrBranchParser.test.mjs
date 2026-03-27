/**
 * Unit tests for resumePrBranchParser.mjs
 *
 * Run: node --test src/lib/resumePrBranchParser.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parsePRBranchMentions,
  detectPrBranchMentions,
  computePipelineWeight,
  sortProjectsByPrWeight
} from "./resumePrBranchParser.mjs";

// ── parsePRBranchMentions (Sub-AC 11a) ────────────────────────────────────────

describe("parsePRBranchMentions", () => {
  // ── Empty / trivial input ────────────────────────────────────────────────

  it("returns empty arrays for empty string", () => {
    const result = parsePRBranchMentions("");
    assert.deepEqual(result, { prs: [], branches: [], projects: [] });
  });

  it("returns empty arrays for non-string input (null coerced)", () => {
    const result = parsePRBranchMentions(null);
    assert.deepEqual(result, { prs: [], branches: [], projects: [] });
  });

  it("returns empty arrays for plain text with no PR/branch signals", () => {
    const result = parsePRBranchMentions("Had a great standup today.");
    assert.deepEqual(result, { prs: [], branches: [], projects: [] });
  });

  // ── PR patterns ──────────────────────────────────────────────────────────

  it("extracts PR number from 'PR #123'", () => {
    const result = parsePRBranchMentions("Merged PR #123 into main.");
    assert.deepEqual(result.prs, [123]);
    assert.deepEqual(result.branches, []);
  });

  it("extracts PR number from 'PR#456' (no space)", () => {
    const result = parsePRBranchMentions("Reviewed PR#456 today.");
    assert.deepEqual(result.prs, [456]);
  });

  it("extracts PR number from 'pull request #42'", () => {
    const result = parsePRBranchMentions("Created pull request #42.");
    assert.deepEqual(result.prs, [42]);
  });

  it("extracts PR number from 'pull request 42' (no hash)", () => {
    const result = parsePRBranchMentions("See pull request 42 for details.");
    assert.deepEqual(result.prs, [42]);
  });

  it("extracts PR number from 'closes #88'", () => {
    const result = parsePRBranchMentions("closes #88");
    assert.deepEqual(result.prs, [88]);
  });

  it("extracts PR number from 'fixes #7'", () => {
    const result = parsePRBranchMentions("fixes #7");
    assert.deepEqual(result.prs, [7]);
  });

  it("extracts PR number from 'Resolves #300'", () => {
    const result = parsePRBranchMentions("Resolves #300");
    assert.deepEqual(result.prs, [300]);
  });

  it("extracts PR number from GitHub PR URL", () => {
    const result = parsePRBranchMentions(
      "See https://github.com/my-org/work-log/pull/55 for details."
    );
    assert.deepEqual(result.prs, [55]);
    assert.deepEqual(result.projects, ["my-org/work-log"]);
  });

  it("deduplicates repeated PR number", () => {
    const result = parsePRBranchMentions("PR #5 (see PR #5) is merged.");
    assert.deepEqual(result.prs, [5]);
  });

  it("returns multiple PR numbers in order of appearance", () => {
    const result = parsePRBranchMentions(
      "Reviewed PR #10 and PR #20 this morning."
    );
    assert.deepEqual(result.prs, [10, 20]);
  });

  // ── Branch patterns ──────────────────────────────────────────────────────

  it("extracts 'feat/login' branch name", () => {
    const result = parsePRBranchMentions("Merged feat/login into main.");
    assert.deepEqual(result.branches, ["feat/login"]);
  });

  it("extracts 'fix/...' branch name", () => {
    const result = parsePRBranchMentions("Pushed fix/login-redirect.");
    assert.deepEqual(result.branches, ["fix/login-redirect"]);
  });

  it("extracts 'hotfix/...' branch name", () => {
    const result = parsePRBranchMentions("Deployed hotfix/prod-crash.");
    assert.deepEqual(result.branches, ["hotfix/prod-crash"]);
  });

  it("extracts 'feature/...' branch name", () => {
    const result = parsePRBranchMentions("feature/add-export is ready.");
    assert.deepEqual(result.branches, ["feature/add-export"]);
  });

  it("extracts 'release/...' branch name", () => {
    const result = parsePRBranchMentions("Cut release/v2.0.0 branch.");
    assert.deepEqual(result.branches, ["release/v2.0.0"]);
  });

  it("deduplicates repeated branch name", () => {
    const result = parsePRBranchMentions(
      "feature/add-login (feature/add-login) is merged."
    );
    assert.deepEqual(result.branches, ["feature/add-login"]);
  });

  it("returns multiple branch names in order of appearance", () => {
    const result = parsePRBranchMentions(
      "Today I worked on feature/add-login and fix/session-bug."
    );
    assert.deepEqual(result.branches, ["feature/add-login", "fix/session-bug"]);
  });

  // ── Project extraction ───────────────────────────────────────────────────

  it("returns empty projects when no extractable project names exist", () => {
    const result = parsePRBranchMentions("feature/add-login and PR #5.");
    assert.deepEqual(result.projects, []);
  });

  it("extracts project from JIRA-style branch 'feature/PROJ-123-ui'", () => {
    const result = parsePRBranchMentions("feature/PROJ-123-ui was merged.");
    assert.deepEqual(result.projects, ["PROJ"]);
  });

  it("extracts project from sub-path branch 'feature/work-log/resume-panel'", () => {
    const result = parsePRBranchMentions(
      "Created feature/work-log/resume-panel."
    );
    assert.deepEqual(result.projects, ["work-log"]);
  });

  it("extracts project from GitHub PR URL as 'org/repo'", () => {
    const result = parsePRBranchMentions(
      "See https://github.com/my-org/backend/pull/10."
    );
    assert.deepEqual(result.projects, ["my-org/backend"]);
  });

  it("deduplicates same project from two branch mentions", () => {
    const result = parsePRBranchMentions(
      "feature/PROJ-1-foo and feature/PROJ-2-bar were merged."
    );
    assert.deepEqual(result.projects, ["PROJ"]);
  });

  // ── Mixed patterns ───────────────────────────────────────────────────────

  it("extracts both PR numbers and branch names from same text", () => {
    const result = parsePRBranchMentions(
      "Opened PR #42 from feature/PROJ-123-new-ui to main."
    );
    assert.deepEqual(result.prs, [42]);
    assert.deepEqual(result.branches, ["feature/PROJ-123-new-ui"]);
    assert.deepEqual(result.projects, ["PROJ"]);
  });

  it("handles multi-line work-log entry", () => {
    const text = [
      "Morning: reviewed PR #5.",
      "Afternoon: pushed feature/add-export.",
      "Evening: merged fix/null-check."
    ].join("\n");
    const result = parsePRBranchMentions(text);
    assert.deepEqual(result.prs, [5]);
    assert.deepEqual(result.branches, ["feature/add-export", "fix/null-check"]);
    assert.deepEqual(result.projects, []);
  });

  it("returns only branches (no prs or projects) for branch-only text", () => {
    const result = parsePRBranchMentions(
      "feat/login: add OAuth2 callback"
    );
    assert.deepEqual(result.prs, []);
    assert.ok(result.branches.includes("feat/login"));
    assert.deepEqual(result.projects, []);
  });

  // ── Return shape ─────────────────────────────────────────────────────────

  it("always returns an object with prs, branches, projects keys", () => {
    const result = parsePRBranchMentions("no signals here");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "prs"));
    assert.ok(Object.prototype.hasOwnProperty.call(result, "branches"));
    assert.ok(Object.prototype.hasOwnProperty.call(result, "projects"));
    assert.ok(Array.isArray(result.prs));
    assert.ok(Array.isArray(result.branches));
    assert.ok(Array.isArray(result.projects));
  });

  it("prs array contains numbers (not strings)", () => {
    const result = parsePRBranchMentions("PR #99 is open.");
    assert.equal(typeof result.prs[0], "number");
  });
});

// ── detectPrBranchMentions ─────────────────────────────────────────────────────

describe("detectPrBranchMentions", () => {
  // ── No data ────────────────────────────────────────────────────────────────
  it("returns empty weights and mentions when called with no arguments", () => {
    const result = detectPrBranchMentions();
    assert.deepEqual(result.projectWeights, {});
    assert.deepEqual(result.mentions, []);
  });

  it("returns empty weights and mentions for empty arrays", () => {
    const result = detectPrBranchMentions({
      gitCommits: [],
      shellHistory: [],
      codexSessions: [],
      claudeSessions: []
    });
    assert.deepEqual(result.projectWeights, {});
    assert.deepEqual(result.mentions, []);
  });

  // ── Git commits — PR merge (weight 1.0) ────────────────────────────────────
  it("assigns weight 1.0 for a Merge pull request commit", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "my-repo", subject: "Merge pull request #42 from owner/feat/login" }
      ]
    });
    assert.equal(result.projectWeights["my-repo"], 1.0);
    assert.equal(result.mentions.length, 1);
    assert.equal(result.mentions[0].type, "pr");
    assert.equal(result.mentions[0].weight, 1.0);
    assert.equal(result.mentions[0].source, "commit");
  });

  it("is case-insensitive for merge pull request pattern", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "repo-a", subject: "MERGE PULL REQUEST #5 from owner/fix/bug" }
      ]
    });
    assert.equal(result.projectWeights["repo-a"], 1.0);
  });

  // ── Git commits — PR number (weight 0.75) ──────────────────────────────────
  it("assigns weight 0.75 for PR number in commit subject", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "repo-b", subject: "Fix auth flow (PR #38)" }
      ]
    });
    assert.equal(result.projectWeights["repo-b"], 0.75);
    assert.equal(result.mentions[0].type, "pr");
    assert.equal(result.mentions[0].weight, 0.75);
  });

  it("assigns weight 0.75 for pull request reference without #", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "repo-c", subject: "Review PR 123 comments" }
      ]
    });
    assert.equal(result.projectWeights["repo-c"], 0.75);
  });

  // ── Git commits — branch name pattern (weight 0.25) ───────────────────────
  it("assigns weight 0.25 for feat/ branch name in commit subject", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "repo-d", subject: "feat/user-auth: add OAuth2 callback" }
      ]
    });
    assert.equal(result.projectWeights["repo-d"], 0.25);
    assert.equal(result.mentions[0].type, "branch");
    assert.equal(result.mentions[0].weight, 0.25);
  });

  it("assigns weight 0.25 for fix/ branch name", () => {
    const result = detectPrBranchMentions({
      gitCommits: [{ repo: "repo-e", subject: "fix/login-redirect: handle missing token" }]
    });
    assert.equal(result.projectWeights["repo-e"], 0.25);
  });

  it("assigns weight 0.25 for hotfix/ branch name", () => {
    const result = detectPrBranchMentions({
      gitCommits: [{ repo: "repo-f", subject: "hotfix/prod-crash: fix null deref" }]
    });
    assert.equal(result.projectWeights["repo-f"], 0.25);
  });

  // ── Git commits — no match ─────────────────────────────────────────────────
  it("ignores plain commit subjects with no PR/branch signals", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "repo-g", subject: "refactor: extract auth helper" },
        { repo: "repo-g", subject: "fix typo in README" }
      ]
    });
    assert.equal(result.projectWeights["repo-g"], undefined);
    assert.equal(result.mentions.length, 0);
  });

  // ── Shell history — gh pr (weight 0.75) ────────────────────────────────────
  it("assigns weight 0.75 for gh pr create command", () => {
    const result = detectPrBranchMentions({
      shellHistory: [
        { timestamp: "2024-01-01T10:00:00Z", command: "gh pr create --title 'Add login'" }
      ]
    });
    // repo is unknown for shell without -C/--repo, so no weight entry
    assert.equal(result.mentions.length, 1);
    assert.equal(result.mentions[0].type, "pr");
    assert.equal(result.mentions[0].weight, 0.75);
    assert.equal(result.mentions[0].source, "shell");
  });

  it("infers repo from --repo flag in gh command", () => {
    const result = detectPrBranchMentions({
      shellHistory: [
        {
          timestamp: "2024-01-01T10:00:00Z",
          command: "gh pr create --repo owner/work-log --title 'feature'"
        }
      ]
    });
    assert.equal(result.projectWeights["work-log"], 0.75);
  });

  it("assigns weight 0.75 for gh pr merge", () => {
    const result = detectPrBranchMentions({
      shellHistory: [
        { command: "gh pr merge 42 --squash --repo owner/my-app" }
      ]
    });
    assert.equal(result.projectWeights["my-app"], 0.75);
  });

  // ── Shell history — branch create (weight 0.5) ─────────────────────────────
  it("assigns weight 0.5 for git checkout -b command", () => {
    const result = detectPrBranchMentions({
      shellHistory: [
        { command: "git -C /Users/dev/my-service checkout -b feat/new-api" }
      ]
    });
    assert.equal(result.projectWeights["my-service"], 0.5);
    assert.equal(result.mentions[0].type, "branch");
    assert.equal(result.mentions[0].weight, 0.5);
  });

  it("assigns weight 0.5 for git switch -c command", () => {
    const result = detectPrBranchMentions({
      shellHistory: [
        { command: "git -C /projects/backend switch -c fix/login-bug" }
      ]
    });
    assert.equal(result.projectWeights["backend"], 0.5);
  });

  it("assigns weight 0.5 for git switch --create command", () => {
    const result = detectPrBranchMentions({
      shellHistory: [
        { command: "git switch --create release/v2.0" }
      ]
    });
    assert.equal(result.mentions[0].weight, 0.5);
    assert.equal(result.mentions[0].type, "branch");
  });

  // ── Session snippets (weight 0.1) ──────────────────────────────────────────
  it("assigns weight 0.1 for PR number in session snippet", () => {
    const result = detectPrBranchMentions({
      codexSessions: [
        {
          cwd: "/Users/dev/frontend-app",
          snippets: ["Let me review PR #55 changes before merging"],
          summary: ""
        }
      ]
    });
    assert.equal(result.projectWeights["frontend-app"], 0.1);
    assert.equal(result.mentions[0].type, "pr");
    assert.equal(result.mentions[0].weight, 0.1);
    assert.equal(result.mentions[0].source, "session");
  });

  it("assigns weight 0.1 for branch name in session summary", () => {
    const result = detectPrBranchMentions({
      claudeSessions: [
        {
          cwd: "/Users/dev/api-service",
          snippets: [],
          summary: "Implemented feat/auth-refresh token rotation logic"
        }
      ]
    });
    assert.equal(result.projectWeights["api-service"], 0.1);
    assert.equal(result.mentions[0].type, "branch");
  });

  it("only adds one mention per session even if multiple matches exist", () => {
    const result = detectPrBranchMentions({
      codexSessions: [
        {
          cwd: "/dev/my-repo",
          snippets: [
            "Working on PR #10",
            "Also handling PR #11",
            "git checkout -b feat/x"
          ]
        }
      ]
    });
    // Only one mention for this session
    assert.equal(result.mentions.filter((m) => m.source === "session").length, 1);
  });

  // ── Max-weight aggregation ─────────────────────────────────────────────────
  it("takes the max weight across multiple mentions for the same repo", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "multi-repo", subject: "feat/x: add feature" },           // 0.25
        { repo: "multi-repo", subject: "Fix issue (PR #99)" },            // 0.75
        { repo: "multi-repo", subject: "Merge pull request #101 from b" } // 1.00
      ]
    });
    // Max should be 1.0
    assert.equal(result.projectWeights["multi-repo"], 1.0);
    assert.equal(result.mentions.filter((m) => m.repo === "multi-repo").length, 3);
  });

  it("does not include unknown repo in projectWeights", () => {
    const result = detectPrBranchMentions({
      shellHistory: [
        { command: "gh pr create --title 'test'" } // no --repo, inferred as unknown
      ]
    });
    assert.equal(result.projectWeights["unknown"], undefined);
    // mention should still be recorded
    assert.equal(result.mentions.length, 1);
    assert.equal(result.mentions[0].repo, "unknown");
  });

  // ── Truncation ─────────────────────────────────────────────────────────────
  it("truncates long commit subjects to 200 chars in mention text", () => {
    const longSubject = "feat/x: " + "a".repeat(300);
    const result = detectPrBranchMentions({
      gitCommits: [{ repo: "r", subject: longSubject }]
    });
    assert.ok(result.mentions[0].text.length <= 203); // 200 + "..." = 203
  });

  // ── Multiple sources ───────────────────────────────────────────────────────
  it("combines signals from commits, shell, and sessions for the same repo", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "combo-repo", subject: "feat/auth: initial scaffold" } // 0.25
      ],
      shellHistory: [
        { command: "git -C /projects/combo-repo checkout -b fix/edge-case" } // 0.5
      ],
      claudeSessions: [
        {
          cwd: "/projects/combo-repo",
          snippets: ["Reviewing PR #7 for combo-repo"] // 0.1
        }
      ]
    });
    // Max is 0.5 (branch create from shell)
    assert.equal(result.projectWeights["combo-repo"], 0.5);
    assert.equal(result.mentions.filter((m) => m.repo === "combo-repo").length, 3);
  });

  it("handles missing/undefined fields in commits gracefully", () => {
    assert.doesNotThrow(() => {
      detectPrBranchMentions({
        gitCommits: [
          { repo: undefined, subject: null },
          {},
          { repo: "ok-repo", subject: "Merge pull request #1" }
        ]
      });
    });
  });
});

// ── sortProjectsByPrWeight ─────────────────────────────────────────────────────

describe("sortProjectsByPrWeight", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(sortProjectsByPrWeight([], {}), []);
  });

  it("returns original array copy when weights are empty", () => {
    const projects = [{ repo: "a" }, { repo: "b" }];
    const result = sortProjectsByPrWeight(projects, {});
    assert.deepEqual(result, projects);
    // Should be a copy, not the same reference
    assert.notEqual(result, projects);
  });

  it("sorts projects descending by weight", () => {
    const projects = [
      { repo: "low" },
      { repo: "high" },
      { repo: "mid" }
    ];
    const weights = { low: 0.1, high: 1.0, mid: 0.5 };
    const result = sortProjectsByPrWeight(projects, weights);
    assert.equal(result[0].repo, "high");
    assert.equal(result[1].repo, "mid");
    assert.equal(result[2].repo, "low");
  });

  it("places projects without weight last", () => {
    const projects = [
      { repo: "unweighted" },
      { repo: "weighted" }
    ];
    const weights = { weighted: 0.25 };
    const result = sortProjectsByPrWeight(projects, weights);
    assert.equal(result[0].repo, "weighted");
    assert.equal(result[1].repo, "unweighted");
  });

  it("does not mutate the original array", () => {
    const projects = [{ repo: "a" }, { repo: "b" }];
    const original = [...projects];
    sortProjectsByPrWeight(projects, { b: 1.0 });
    assert.deepEqual(projects, original);
  });

  it("handles null/undefined gracefully", () => {
    assert.deepEqual(sortProjectsByPrWeight(null, {}), []);
    assert.deepEqual(sortProjectsByPrWeight(undefined, {}), []);
    const projects = [{ repo: "x" }];
    const result = sortProjectsByPrWeight(projects, null);
    assert.deepEqual(result, projects);
  });

  it("preserves relative order of projects with equal weight", () => {
    const projects = [
      { repo: "a", order: 1 },
      { repo: "b", order: 2 },
      { repo: "c", order: 3 }
    ];
    const weights = { a: 0.5, b: 0.5, c: 0.5 };
    const result = sortProjectsByPrWeight(projects, weights);
    // All same weight: order should be stable (a, b, c)
    // Note: JS Array.prototype.sort is stable in Node.js 12+
    assert.equal(result[0].order, 1);
    assert.equal(result[1].order, 2);
    assert.equal(result[2].order, 3);
  });
});

// ── computePipelineWeight (Sub-AC 11b) ─────────────────────────────────────────

describe("computePipelineWeight", () => {
  // ── Basic computation ─────────────────────────────────────────────────────
  it("returns maxWeight unchanged for a single mention (log2(1) = 0)", () => {
    const w = computePipelineWeight(1.0, 1);
    assert.equal(w, 1.0);
  });

  it("returns 0 when maxWeight is 0", () => {
    assert.equal(computePipelineWeight(0, 5), 0);
  });

  it("returns 0 when maxWeight is negative", () => {
    assert.equal(computePipelineWeight(-0.5, 3), 0);
  });

  it("returns 0 when maxWeight is not a number", () => {
    assert.equal(computePipelineWeight("0.75", 2), 0);
    assert.equal(computePipelineWeight(null, 2), 0);
    assert.equal(computePipelineWeight(undefined, 2), 0);
  });

  // ── Mention-count boost ───────────────────────────────────────────────────
  it("boosts weight for 2 mentions (log2(2) = 1 → multiplier 1.5)", () => {
    const w = computePipelineWeight(1.0, 2);
    // 1.0 × (1 + 1 × 0.5) = 1.5
    assert.equal(w, 1.5);
  });

  it("boosts weight for 4 mentions (log2(4) = 2 → multiplier 2.0)", () => {
    const w = computePipelineWeight(1.0, 4);
    // 1.0 × (1 + 2 × 0.5) = 2.0
    assert.equal(w, 2.0);
  });

  it("scales proportionally — maxWeight=0.75 with 2 mentions", () => {
    const w = computePipelineWeight(0.75, 2);
    // 0.75 × 1.5 = 1.125
    assert.equal(w, 0.75 * 1.5);
  });

  it("scales proportionally — maxWeight=0.5 with 4 mentions", () => {
    const w = computePipelineWeight(0.5, 4);
    // 0.5 × 2.0 = 1.0
    assert.equal(w, 1.0);
  });

  it("scales proportionally — maxWeight=0.25 with 8 mentions", () => {
    const w = computePipelineWeight(0.25, 8);
    // 0.25 × (1 + 3 × 0.5) = 0.25 × 2.5 = 0.625
    assert.ok(Math.abs(w - 0.625) < 1e-10, `expected ~0.625, got ${w}`);
  });

  // ── Edge cases for mentionCount ───────────────────────────────────────────
  it("treats mentionCount < 1 as 1 (no boost for fractional counts)", () => {
    const w0 = computePipelineWeight(0.5, 0);
    const w_neg = computePipelineWeight(0.5, -5);
    const w1 = computePipelineWeight(0.5, 1);
    assert.equal(w0, w1);
    assert.equal(w_neg, w1);
  });

  it("treats non-numeric mentionCount as 1", () => {
    const wStr = computePipelineWeight(0.5, "three");
    const w1 = computePipelineWeight(0.5, 1);
    assert.equal(wStr, w1);
  });

  it("pipelineWeight is always >= maxWeight for mentionCount >= 1", () => {
    for (const maxWeight of [0.1, 0.25, 0.5, 0.75, 1.0]) {
      for (const count of [1, 2, 4, 8, 16]) {
        const pw = computePipelineWeight(maxWeight, count);
        assert.ok(pw >= maxWeight, `expected pw >= ${maxWeight} for count=${count}, got ${pw}`);
      }
    }
  });

  it("is monotonically non-decreasing with mentionCount", () => {
    const maxWeight = 0.75;
    let prev = computePipelineWeight(maxWeight, 1);
    for (const count of [2, 4, 8, 16, 32]) {
      const curr = computePipelineWeight(maxWeight, count);
      assert.ok(curr >= prev, `expected non-decreasing: count=${count} gave ${curr} < prev ${prev}`);
      prev = curr;
    }
  });
});

// ── detectPrBranchMentions — mentionCounts and pipelineWeights (Sub-AC 11b) ───

describe("detectPrBranchMentions — mentionCounts and pipelineWeights (Sub-AC 11b)", () => {
  it("returns empty mentionCounts and pipelineWeights for no input", () => {
    const result = detectPrBranchMentions();
    assert.deepEqual(result.mentionCounts, {});
    assert.deepEqual(result.pipelineWeights, {});
  });

  it("returns mentionCounts=1 for a single commit mention", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "my-repo", subject: "Merge pull request #42 from owner/feat/login" }
      ]
    });
    assert.equal(result.mentionCounts["my-repo"], 1);
  });

  it("counts all individual mentions across sources for the same repo", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "multi", subject: "feat/x: add feature" },          // +1
        { repo: "multi", subject: "Fix issue (PR #99)" },           // +1
        { repo: "multi", subject: "Merge pull request #101 from b" } // +1
      ]
    });
    assert.equal(result.mentionCounts["multi"], 3);
  });

  it("combines mention counts across commits and shell for the same repo", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "combo", subject: "feat/auth: scaffold" }, // +1
        { repo: "combo", subject: "Merge pull request #5" } // +1
      ],
      shellHistory: [
        { command: "gh pr create --repo owner/combo --title 'feature'" } // +1
      ]
    });
    assert.equal(result.mentionCounts["combo"], 3);
  });

  it("does not count 'unknown' repo mentions in mentionCounts", () => {
    const result = detectPrBranchMentions({
      shellHistory: [
        { command: "gh pr create --title 'test'" } // unknown repo
      ]
    });
    assert.equal(result.mentionCounts["unknown"], undefined);
    // mention is still recorded but excluded from aggregation
    assert.equal(result.mentions.length, 1);
  });

  it("pipelineWeight for single mention equals maxWeight (log2(1)=0 → no boost)", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "repo-x", subject: "Merge pull request #1 from owner/feat" }
      ]
    });
    assert.equal(result.projectWeights["repo-x"], 1.0);
    assert.equal(result.pipelineWeights["repo-x"], 1.0);
  });

  it("pipelineWeight > maxWeight when mentionCount > 1", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "active-repo", subject: "Merge pull request #1" },  // weight 1.0
        { repo: "active-repo", subject: "feat/login: add feature" } // weight 0.25, count +1
      ]
    });
    const maxWeight = result.projectWeights["active-repo"]; // 1.0
    const pipelineWeight = result.pipelineWeights["active-repo"];
    assert.equal(maxWeight, 1.0);
    assert.ok(pipelineWeight > maxWeight, `expected pipelineWeight > ${maxWeight}, got ${pipelineWeight}`);
    // 2 mentions → 1.0 × (1 + 1 × 0.5) = 1.5
    assert.equal(pipelineWeight, 1.5);
  });

  it("pipelineWeights uses mention-count boost: 4 mentions → 2× maxWeight", () => {
    // 4 commits with branch-name pattern for the same repo
    const result = detectPrBranchMentions({
      gitCommits: [
        { repo: "busy-repo", subject: "feat/a: first" },
        { repo: "busy-repo", subject: "feat/b: second" },
        { repo: "busy-repo", subject: "feat/c: third" },
        { repo: "busy-repo", subject: "feat/d: fourth" }
      ]
    });
    const maxWeight = result.projectWeights["busy-repo"]; // 0.25 (all branch-name at 0.25)
    const pipelineWeight = result.pipelineWeights["busy-repo"];
    // 4 mentions → 0.25 × (1 + 2 × 0.5) = 0.25 × 2 = 0.5
    assert.equal(maxWeight, 0.25);
    assert.ok(Math.abs(pipelineWeight - 0.5) < 1e-10, `expected ~0.5, got ${pipelineWeight}`);
  });

  it("higher-mention repo ranks above lower-mention repo with same maxWeight", () => {
    const result = detectPrBranchMentions({
      gitCommits: [
        // repo-A: 1 mention at 0.75
        { repo: "repo-a", subject: "Fix bug (PR #5)" },
        // repo-B: 3 mentions at max 0.75 (but higher pipeline weight due to count)
        { repo: "repo-b", subject: "feat/x: add feature" },   // 0.25
        { repo: "repo-b", subject: "Fix edge case (PR #6)" }, // 0.75
        { repo: "repo-b", subject: "feat/y: refactor" }       // 0.25
      ]
    });
    // Both have maxWeight 0.75 but repo-b has 3 mentions vs repo-a's 1
    assert.equal(result.projectWeights["repo-a"], 0.75);
    assert.equal(result.projectWeights["repo-b"], 0.75);
    assert.ok(
      result.pipelineWeights["repo-b"] > result.pipelineWeights["repo-a"],
      "repo-b (3 mentions) should have higher pipeline weight than repo-a (1 mention)"
    );
  });
});
