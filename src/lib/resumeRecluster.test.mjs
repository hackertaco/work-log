/**
 * Unit tests for resumeRecluster.mjs (Sub-AC 17-3)
 *
 * Run with:
 *   node --test src/lib/resumeRecluster.test.mjs
 */

import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Helpers & stubs ───────────────────────────────────────────────────────────

/**
 * Build a minimal resume document used across tests.
 */
function makeResume(overrides = {}) {
  return {
    strength_keywords: ["React", "TypeScript", "Node.js"],
    skills: {
      technical: ["GraphQL", "PostgreSQL"],
      languages: ["JavaScript", "Python"],
      tools: ["Docker", "Kubernetes"]
    },
    display_axes: [],
    ...overrides
  };
}

/**
 * Build a minimal Axis object (already-migrated / has id).
 */
function makeAxis(id, label, keywords, source = "system") {
  return { id, label, keywords, _source: source };
}

// ─── Import after stubs are in place ──────────────────────────────────────────

import {
  computeUnclassifiedRatio,
  shouldRecluster,
  mergeAxes,
  reclusterPipeline,
  _adaptWorkLogEntries,
  _dedup,
  DEFAULT_RECLUSTER_THRESHOLD,
  buildRepoWorkContext,
  groupEvidenceEpisodes,
  extractCoreProjects,
  TARGET_PROJECTS_PER_REPO
} from "./resumeRecluster.mjs";

// ─── computeUnclassifiedRatio ──────────────────────────────────────────────────

describe("computeUnclassifiedRatio", () => {
  it("returns 0 when allKeywords is empty", () => {
    const ratio = computeUnclassifiedRatio([], []);
    assert.equal(ratio, 0);
  });

  it("returns 0 when allKeywords is not an array", () => {
    assert.equal(computeUnclassifiedRatio(null, []), 0);
    assert.equal(computeUnclassifiedRatio(undefined, []), 0);
  });

  it("returns 1 when no axes exist (all unclassified)", () => {
    const kws = ["React", "TypeScript", "Docker"];
    const ratio = computeUnclassifiedRatio(kws, []);
    assert.equal(ratio, 1);
  });

  it("returns 0 when every keyword is classified", () => {
    const kws = ["React", "TypeScript"];
    const axes = [makeAxis("a1", "Frontend", ["React", "TypeScript"])];
    const ratio = computeUnclassifiedRatio(kws, axes);
    assert.equal(ratio, 0);
  });

  it("returns the correct partial ratio", () => {
    // 3 keywords total, 1 classified → ratio = 2/3
    const kws = ["React", "TypeScript", "Docker"];
    const axes = [makeAxis("a1", "Frontend", ["React"])];
    const ratio = computeUnclassifiedRatio(kws, axes);
    assert.ok(Math.abs(ratio - 2 / 3) < 1e-9, `Expected ~0.667, got ${ratio}`);
  });

  it("is case-insensitive when checking classified set", () => {
    const kws = ["react", "typescript"];
    const axes = [makeAxis("a1", "Frontend", ["React", "TypeScript"])];
    const ratio = computeUnclassifiedRatio(kws, axes);
    assert.equal(ratio, 0, "Matching should be case-insensitive");
  });

  it("handles axes with no keywords array gracefully", () => {
    const kws = ["React", "Docker"];
    const axes = [{ id: "a1", label: "Empty" }]; // no keywords field
    const ratio = computeUnclassifiedRatio(kws, axes);
    assert.equal(ratio, 1, "Axis with no keywords contributes nothing to classified set");
  });

  it("handles axes = null gracefully", () => {
    const ratio = computeUnclassifiedRatio(["React"], null);
    assert.equal(ratio, 1);
  });
});

// ─── shouldRecluster ──────────────────────────────────────────────────────────

describe("shouldRecluster", () => {
  it("returns false when allKeywords is empty", () => {
    assert.equal(shouldRecluster([], []), false);
  });

  it("returns false when ratio ≤ threshold (exactly equal)", () => {
    // ratio = 0.3 (3 of 10 unclassified), threshold = 0.3 → must be STRICTLY greater
    const kws = Array.from({ length: 10 }, (_, i) => `kw${i}`);
    const axes = [makeAxis("a1", "Group", kws.slice(0, 7))]; // 7 classified, 3 unclassified → 30 %
    assert.equal(shouldRecluster(kws, axes, 0.3), false, "Equal to threshold should not trigger");
  });

  it("returns true when ratio > threshold", () => {
    // 4 of 10 unclassified → ratio = 0.4 > 0.3
    const kws = Array.from({ length: 10 }, (_, i) => `kw${i}`);
    const axes = [makeAxis("a1", "Group", kws.slice(0, 6))]; // 6 classified, 4 unclassified → 40 %
    assert.equal(shouldRecluster(kws, axes, 0.3), true);
  });

  it("uses DEFAULT_RECLUSTER_THRESHOLD when none provided", () => {
    // All unclassified → ratio = 1 > 0.3
    assert.equal(shouldRecluster(["React"], [], ), true);
  });

  it("respects a custom threshold of 0 (always recluster when keywords exist)", () => {
    // Even 1 unclassified out of 10 → ratio = 0.1 > 0
    const kws = Array.from({ length: 10 }, (_, i) => `kw${i}`);
    const axes = [makeAxis("a1", "Group", kws.slice(0, 9))]; // 9 classified
    assert.equal(shouldRecluster(kws, axes, 0), true);
  });

  it("respects a threshold of 1 (never recluster unless all unclassified)", () => {
    const kws = ["React", "TypeScript", "Docker"];
    const axes = [makeAxis("a1", "Group", ["React"])]; // 2/3 unclassified
    assert.equal(shouldRecluster(kws, axes, 1), false, "ratio=0.67 should not exceed threshold=1");
  });
});

// ─── DEFAULT_RECLUSTER_THRESHOLD ──────────────────────────────────────────────

describe("DEFAULT_RECLUSTER_THRESHOLD", () => {
  it("is 0.3", () => {
    assert.equal(DEFAULT_RECLUSTER_THRESHOLD, 0.3);
  });
});

// ─── mergeAxes ────────────────────────────────────────────────────────────────

describe("mergeAxes", () => {
  it("returns empty array when both inputs are empty", () => {
    assert.deepEqual(mergeAxes([], []), []);
  });

  it("preserves user axes unchanged when no new axes provided", () => {
    const userAxis = makeAxis("u1", "My Career", ["Leadership"], "user");
    const result = mergeAxes([userAxis], []);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], userAxis);
  });

  it("appends new axes that have no overlap with existing system axes", () => {
    const systemAxis = makeAxis("s1", "Backend", ["Node.js", "PostgreSQL"]);
    const newAxis = { label: "Frontend", keywords: ["React", "TypeScript"] };

    const result = mergeAxes([systemAxis], [newAxis]);

    assert.equal(result.length, 2);
    // First should be the existing system axis (no overlap with newAxis)
    assert.equal(result[0].id, "s1");
    // Second should be the new axis (appended)
    assert.equal(result[1].label, "Frontend");
    assert.equal(result[1]._source, "system");
    assert.ok(result[1].id, "New axis should have a generated id");
  });

  it("merges an overlapping new axis into an existing system axis (keyword union)", () => {
    // Jaccard overlap: intersection={React}/union={React,TypeScript,Vue}=1/3>0.25
    const systemAxis = makeAxis("s1", "Frontend", ["React", "TypeScript"]);
    const newAxis = { label: "UI Engineering", keywords: ["React", "Vue"] };

    const result = mergeAxes([systemAxis], [newAxis]);

    assert.equal(result.length, 1, "Should merge into one axis");
    assert.equal(result[0].id, "s1", "Should keep existing id");
    assert.equal(result[0].label, "Frontend", "Should keep existing label");
    // Keywords should be the union
    const kwSet = new Set(result[0].keywords.map((k) => k.toLowerCase()));
    assert.ok(kwSet.has("react"));
    assert.ok(kwSet.has("typescript"));
    assert.ok(kwSet.has("vue"));
  });

  it("user axes are never overwritten even when a new axis has high keyword overlap", () => {
    const userAxis = makeAxis("u1", "My Custom Axis", ["React", "TypeScript"], "user");
    const newAxis = { label: "Frontend Replacement", keywords: ["React", "TypeScript"] };

    const result = mergeAxes([userAxis], [newAxis]);

    // User axis is preserved unchanged; new axis is appended (no system axis to merge into)
    assert.equal(result.length, 2, "User axis + appended new axis");
    assert.deepEqual(result[0], userAxis, "User axis unchanged");
    assert.equal(result[1].label, "Frontend Replacement", "New axis appended");
  });

  it("caps total axes at 6", () => {
    // 5 existing system axes + 3 new non-overlapping axes → should cap at 6
    const existing = Array.from({ length: 5 }, (_, i) =>
      makeAxis(`s${i}`, `System ${i}`, [`kw_s${i}`])
    );
    const incoming = Array.from({ length: 3 }, (_, i) => ({
      label: `New ${i}`,
      keywords: [`kw_n${i}`]
    }));

    const result = mergeAxes(existing, incoming);
    assert.ok(result.length <= 6, `Expected ≤ 6 axes, got ${result.length}`);
  });

  it("handles non-array inputs gracefully", () => {
    assert.deepEqual(mergeAxes(null, null), []);

    // Non-array existing axes: new axis should be appended with a generated id
    const result = mergeAxes(undefined, [{ label: "X", keywords: ["a"] }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].label, "X");
    assert.deepEqual(result[0].keywords, ["a"]);
    assert.equal(result[0]._source, "system");
    assert.ok(typeof result[0].id === "string" && result[0].id.length > 0, "Generated id should be a non-empty string");
  });

  it("preserves both user and system axes when new axes bring no overlap", () => {
    const userAxis   = makeAxis("u1", "User Axis",   ["Leadership"],   "user");
    const systemAxis = makeAxis("s1", "System Axis", ["Node.js"],      "system");
    const newAxis    = { label: "Data Engineering", keywords: ["Spark", "Kafka"] };

    const result = mergeAxes([userAxis, systemAxis], [newAxis]);

    assert.equal(result.length, 3);
    assert.equal(result[0]._source, "user");
    assert.equal(result[0].id, "u1");
    assert.equal(result[1].id, "s1");
    assert.equal(result[2].label, "Data Engineering");
  });
});

// ─── _adaptWorkLogEntries ─────────────────────────────────────────────────────

describe("_adaptWorkLogEntries", () => {
  it("returns empty array for non-array input", () => {
    assert.deepEqual(_adaptWorkLogEntries(null), []);
    assert.deepEqual(_adaptWorkLogEntries(undefined), []);
  });

  it("passes through entries that already have resumeBullets", () => {
    const entry = { resumeBullets: ["Built CI/CD pipeline"], keywords: ["CI/CD"] };
    const result = _adaptWorkLogEntries([entry]);
    assert.deepEqual(result[0], entry);
  });

  it("converts gatherWorkLogBullets-shaped entries", () => {
    const entry = {
      date: "2026-03-20",
      candidates: ["Implemented React component"],
      companyCandidates: ["Led sprint planning"],
      openSourceCandidates: ["Fixed TypeScript bug"]
    };
    const result = _adaptWorkLogEntries([entry]);
    assert.ok(Array.isArray(result[0].resumeBullets));
    assert.equal(result[0].resumeBullets.length, 3);
    assert.ok(result[0].resumeBullets.includes("Implemented React component"));
    assert.ok(result[0].resumeBullets.includes("Led sprint planning"));
    assert.ok(result[0].resumeBullets.includes("Fixed TypeScript bug"));
  });

  it("filters empty/non-string candidates", () => {
    const entry = {
      candidates: ["Valid bullet", "", null, 42],
      companyCandidates: [],
      openSourceCandidates: []
    };
    const result = _adaptWorkLogEntries([entry]);
    assert.deepEqual(result[0].resumeBullets, ["Valid bullet"]);
  });

  it("handles null/non-object entries gracefully", () => {
    const result = _adaptWorkLogEntries([null, undefined, 42, "string"]);
    assert.equal(result.length, 4);
    result.forEach((r) => assert.deepEqual(r, {}));
  });
});

// ─── _dedup ───────────────────────────────────────────────────────────────────

describe("_dedup", () => {
  it("returns empty array for non-array input", () => {
    assert.deepEqual(_dedup(null), []);
  });

  it("deduplicates case-insensitively, preserving first occurrence", () => {
    const result = _dedup(["React", "react", "REACT", "TypeScript"]);
    assert.deepEqual(result, ["React", "TypeScript"]);
  });

  it("removes empty strings and trims whitespace", () => {
    const result = _dedup(["  React  ", "", "  ", "Node.js"]);
    assert.deepEqual(result, ["React", "Node.js"]);
  });

  it("skips non-string items", () => {
    const result = _dedup([42, null, "React", undefined, "Node.js"]);
    assert.deepEqual(result, ["React", "Node.js"]);
  });
});

// ─── reclusterPipeline (integration — LLM disabled) ───────────────────────────

describe("reclusterPipeline (WORK_LOG_DISABLE_OPENAI=1)", () => {
  before(() => {
    // Disable LLM so clusterKeywords() returns []
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
  });

  it("does not trigger when ratio ≤ threshold", async () => {
    // All keywords are already classified
    const resume = makeResume({
      display_axes: [
        makeAxis("a1", "Frontend",   ["React", "TypeScript", "JavaScript"]),
        makeAxis("a2", "Backend",    ["Node.js", "GraphQL", "PostgreSQL"]),
        makeAxis("a3", "Operations", ["Docker", "Kubernetes", "Python"])
      ]
    });
    const result = await reclusterPipeline(resume, [], { threshold: 0.3 });
    assert.equal(result.triggered, false);
    assert.ok(result.ratio <= 0.3, `Expected ratio ≤ 0.3, got ${result.ratio}`);
    assert.equal(result.axes.length, 3);
  });

  it("triggers when ratio > threshold but LLM disabled → returns existing axes unchanged", async () => {
    // No axes → ratio = 1.0 > 0.3
    const resume = makeResume({ display_axes: [] });
    const result = await reclusterPipeline(resume, [], { threshold: 0.3 });
    // triggered=true because ratio exceeded threshold; clusterKeywords returns []
    assert.equal(result.triggered, true);
    assert.equal(result.ratio, 1);
    // mergeAxes([], []) → []
    assert.deepEqual(result.axes, []);
  });

  it("force=true skips threshold check", async () => {
    // All keywords classified, ratio = 0
    const resume = makeResume({
      display_axes: [
        makeAxis("a1", "Group", ["React", "TypeScript", "Node.js", "GraphQL",
                                  "PostgreSQL", "JavaScript", "Python", "Docker", "Kubernetes"])
      ]
    });
    const result = await reclusterPipeline(resume, [], { force: true });
    assert.equal(result.triggered, true, "force=true should always trigger");
  });

  it("reports correct totalKeywords and unclassifiedCount", async () => {
    // 4 resume keywords, 3 classified → 1 unclassified
    const resume = makeResume({
      strength_keywords: ["React", "Node.js", "Docker", "Kubernetes"],
      skills: { technical: [], languages: [], tools: [] },
      display_axes: [
        makeAxis("a1", "Frontend", ["React", "Node.js", "Docker"])
      ]
    });
    const result = await reclusterPipeline(resume, [], { threshold: 0.3 });
    // ratio = 1/4 = 0.25 ≤ 0.3 → not triggered
    assert.equal(result.triggered, false);
    assert.equal(result.totalKeywords, 4);
    // Kubernetes is unclassified
    assert.equal(result.unclassifiedCount, 1);
  });

  it("adapts gatherWorkLogBullets-format work log entries", async () => {
    const resume = makeResume({ display_axes: [] });
    const workLogs = [
      {
        date: "2026-03-20",
        candidates: ["Built React components with TypeScript"],
        companyCandidates: [],
        openSourceCandidates: []
      }
    ];
    // Should not throw; gatherWorkLogBullets format should be adapted transparently
    const result = await reclusterPipeline(resume, workLogs, { threshold: 0.3 });
    assert.ok(typeof result.triggered === "boolean");
    assert.ok(typeof result.ratio === "number");
    assert.ok(result.ratio >= 0 && result.ratio <= 1);
  });

  it("returns axes in correct shape when existing user axes are present", async () => {
    const userAxis = makeAxis("u1", "My Custom Focus", ["Leadership", "Mentoring"], "user");
    const resume = makeResume({
      display_axes: [userAxis]
    });
    // ratio > 0.3 because resume keywords aren't in the user axis
    const result = await reclusterPipeline(resume, [], { threshold: 0.3 });

    if (result.triggered) {
      // User axis must appear first and be unchanged
      const u = result.axes.find((a) => a.id === "u1");
      assert.ok(u, "User axis should be preserved");
      assert.equal(u._source, "user");
      assert.deepEqual(u.keywords, userAxis.keywords);
    }
  });

  it("handles resume with no keywords gracefully (does not trigger)", async () => {
    const resume = { display_axes: [] }; // No strength_keywords or skills
    const result = await reclusterPipeline(resume, []);
    // 0 keywords → ratio = 0 → should not trigger
    assert.equal(result.triggered, false);
    assert.equal(result.totalKeywords, 0);
    assert.equal(result.ratio, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Core Projects Extraction Pipeline Tests
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Test fixtures ────────────────────────────────────────────────────────────

/**
 * Build a minimal daily entry for testing.
 */
function makeDailyEntry(overrides = {}) {
  return {
    date: "2026-03-28",
    projects: [
      {
        repo: "my-app",
        category: "company",
        commitCount: 2,
        commits: [
          {
            repo: "my-app",
            repoPath: "/Users/test/my-app",
            hash: "abc123",
            authoredAt: "2026-03-28T10:00:00+09:00",
            subject: "feat: add payment flow"
          },
          {
            repo: "my-app",
            repoPath: "/Users/test/my-app",
            hash: "def456",
            authoredAt: "2026-03-28T14:00:00+09:00",
            subject: "fix: handle edge case in payment validation"
          }
        ]
      }
    ],
    resume: {
      candidates: [
        "my-app: Added payment flow with Stripe integration",
        "my-app: Fixed edge cases in payment validation"
      ],
      companyCandidates: [
        "my-app: Implemented new payment processing pipeline"
      ],
      openSourceCandidates: []
    },
    aiSessions: {
      codex: [
        {
          source: "codex",
          cwd: "/Users/test/my-app",
          summary: "Worked on payment flow: decided to use Stripe webhooks for reliability",
          snippets: ["payment flow needs webhook verification"]
        }
      ],
      claude: []
    },
    highlights: {
      storyThreads: [
        {
          repo: "my-app",
          outcome: "Payment processing now handles edge cases",
          keyChange: "Added Stripe webhook verification",
          impact: "Reduced failed payments by catching validation errors",
          why: "Revenue protection — failed payments cost money",
          decision: "Chose webhooks over polling for reliability"
        }
      ],
      aiReview: [
        "Good pattern of testing edge cases before shipping"
      ],
      businessOutcomes: ["Improved payment reliability"],
      keyChanges: ["Added Stripe webhooks"]
    },
    ...overrides
  };
}

function makeDailyEntry2(overrides = {}) {
  return {
    date: "2026-03-27",
    projects: [
      {
        repo: "my-app",
        category: "company",
        commitCount: 1,
        commits: [
          {
            repo: "my-app",
            repoPath: "/Users/test/my-app",
            hash: "ghi789",
            authoredAt: "2026-03-27T11:00:00+09:00",
            subject: "feat: add user dashboard with analytics"
          }
        ]
      }
    ],
    resume: {
      candidates: [
        "my-app: Built user analytics dashboard with chart.js"
      ],
      companyCandidates: [],
      openSourceCandidates: []
    },
    aiSessions: {
      codex: [],
      claude: [
        {
          source: "claude",
          cwd: "/Users/test/my-app",
          summary: "Designed dashboard layout — chose chart.js over d3 for simplicity",
          snippets: ["chart.js is simpler for our use case than d3"]
        }
      ]
    },
    highlights: {
      storyThreads: [
        {
          repo: "my-app",
          outcome: "Users can now see usage analytics",
          keyChange: "Built dashboard with chart.js",
          impact: "Self-service analytics reduces support tickets",
          why: "Users were asking support for usage data",
          decision: ""
        }
      ],
      aiReview: [],
      businessOutcomes: ["User dashboard launched"],
      keyChanges: ["Chart.js dashboard"]
    },
    ...overrides
  };
}

// ─── buildRepoWorkContext ─────────────────────────────────────────────────────

describe("buildRepoWorkContext", () => {
  it("returns empty context when dailyEntries is null/empty", () => {
    const ctx = buildRepoWorkContext(null, "my-app");
    assert.equal(ctx.repo, "my-app");
    assert.deepEqual(ctx.dates, []);
    assert.deepEqual(ctx.commits, []);
    assert.deepEqual(ctx.bullets, []);
    assert.deepEqual(ctx.sessionSnippets, []);
    assert.deepEqual(ctx.highlights, []);
  });

  it("returns empty context when repo is empty", () => {
    const ctx = buildRepoWorkContext([makeDailyEntry()], "");
    assert.equal(ctx.repo, "");
    assert.deepEqual(ctx.commits, []);
  });

  it("collects commits for the target repo", () => {
    const ctx = buildRepoWorkContext([makeDailyEntry()], "my-app");
    assert.equal(ctx.commits.length, 2);
    assert.equal(ctx.commits[0].subject, "feat: add payment flow");
    assert.equal(ctx.commits[0].date, "2026-03-28");
    assert.equal(ctx.commits[1].hash, "def456");
  });

  it("filters out commits from other repos", () => {
    const entry = makeDailyEntry({
      projects: [
        ...makeDailyEntry().projects,
        {
          repo: "other-repo",
          commits: [{ repo: "other-repo", hash: "zzz", subject: "unrelated commit" }]
        }
      ]
    });
    const ctx = buildRepoWorkContext([entry], "my-app");
    assert.equal(ctx.commits.length, 2);
    assert.ok(ctx.commits.every((c) => c.subject !== "unrelated commit"));
  });

  it("collects bullet candidates mentioning the repo", () => {
    const ctx = buildRepoWorkContext([makeDailyEntry()], "my-app");
    assert.ok(ctx.bullets.length >= 2, `Expected ≥2 bullets, got ${ctx.bullets.length}`);
    assert.ok(ctx.bullets.every((b) => b.text.toLowerCase().includes("my-app")));
  });

  it("collects session snippets linked by cwd (date+repo heuristic)", () => {
    const ctx = buildRepoWorkContext([makeDailyEntry()], "my-app");
    assert.ok(ctx.sessionSnippets.length >= 1, `Expected ≥1 session snippet, got ${ctx.sessionSnippets.length}`);
    assert.ok(ctx.sessionSnippets[0].text.includes("payment flow"));
  });

  it("collects session snippets linked by content (date+repo heuristic)", () => {
    const entry = makeDailyEntry({
      aiSessions: {
        codex: [],
        claude: [
          {
            source: "claude",
            cwd: "/Users/test/some-other-path",
            summary: "Working on my-app authentication module",
            snippets: []
          }
        ]
      }
    });
    const ctx = buildRepoWorkContext([entry], "my-app");
    const sessionTexts = ctx.sessionSnippets.map((s) => s.text);
    assert.ok(
      sessionTexts.some((t) => t.includes("authentication")),
      "Should match session by content containing repo name"
    );
  });

  it("collects highlights (storyThreads) for the repo", () => {
    const ctx = buildRepoWorkContext([makeDailyEntry()], "my-app");
    assert.ok(ctx.highlights.length >= 1);
    assert.ok(ctx.highlights[0].text.includes("Payment processing"));
  });

  it("sorts dates ascending", () => {
    const entries = [makeDailyEntry(), makeDailyEntry2()];
    const ctx = buildRepoWorkContext(entries, "my-app");
    assert.deepEqual(ctx.dates, ["2026-03-27", "2026-03-28"]);
  });

  it("is case-insensitive for repo matching", () => {
    const ctx = buildRepoWorkContext([makeDailyEntry()], "My-App");
    assert.ok(ctx.commits.length > 0, "Should match case-insensitively");
  });

  it("handles entries with missing fields gracefully", () => {
    const entry = { date: "2026-03-28" }; // minimal entry with no projects/resume/sessions
    const ctx = buildRepoWorkContext([entry], "my-app");
    assert.equal(ctx.commits.length, 0);
    assert.equal(ctx.bullets.length, 0);
    assert.equal(ctx.sessionSnippets.length, 0);
    assert.equal(ctx.highlights.length, 0);
  });

  it("aggregates across multiple daily entries", () => {
    const entries = [makeDailyEntry(), makeDailyEntry2()];
    const ctx = buildRepoWorkContext(entries, "my-app");
    assert.equal(ctx.commits.length, 3); // 2 from day 1 + 1 from day 2
    assert.equal(ctx.dates.length, 2);
  });

  it("includes all bullets on single-repo days even without repo name mention", () => {
    const entry = {
      date: "2026-03-28",
      projects: [
        {
          repo: "my-app",
          commits: [{ hash: "a1", subject: "feat: add feature" }]
        }
        // Only one repo has commits → single-repo day
      ],
      resume: {
        candidates: [
          "Added new feature to improve user onboarding" // does NOT mention "my-app"
        ],
        companyCandidates: [],
        openSourceCandidates: []
      },
      aiSessions: { codex: [], claude: [] },
      highlights: {}
    };
    const ctx = buildRepoWorkContext([entry], "my-app");
    assert.equal(ctx.bullets.length, 1, "Single-repo day bullet should be included even without repo name");
    assert.ok(ctx.bullets[0].text.includes("onboarding"));
  });

  it("does NOT include non-matching bullets on multi-repo days", () => {
    const entry = {
      date: "2026-03-28",
      projects: [
        {
          repo: "my-app",
          commits: [{ hash: "a1", subject: "feat: add feature" }]
        },
        {
          repo: "other-repo",
          commits: [{ hash: "b1", subject: "fix: other fix" }]
        }
      ],
      resume: {
        candidates: [
          "Generic bullet without repo name" // doesn't mention any repo
        ],
        companyCandidates: [],
        openSourceCandidates: []
      },
      aiSessions: { codex: [], claude: [] },
      highlights: {}
    };
    const ctx = buildRepoWorkContext([entry], "my-app");
    assert.equal(ctx.bullets.length, 0, "Multi-repo day: generic bullet should NOT be attributed");
  });

  it("collects all session snippets (not just summary) for richer context", () => {
    const entry = {
      date: "2026-03-28",
      projects: [
        {
          repo: "my-app",
          commits: [{ hash: "a1", subject: "feat: add feature" }]
        }
      ],
      resume: { candidates: [], companyCandidates: [], openSourceCandidates: [] },
      aiSessions: {
        codex: [
          {
            source: "codex",
            cwd: "/Users/test/my-app",
            summary: "Session about auth",
            snippets: ["Decided JWT over session cookies for statelessness", "Need to add refresh token flow"]
          }
        ],
        claude: []
      },
      highlights: {}
    };
    const ctx = buildRepoWorkContext([entry], "my-app");
    assert.ok(ctx.sessionSnippets.length >= 1);
    // Combined text should include both summary and snippet content
    assert.ok(ctx.sessionSnippets[0].text.includes("auth"), "Should include summary");
    assert.ok(ctx.sessionSnippets[0].text.includes("JWT"), "Should include snippet details");
  });
});

// ─── groupEvidenceEpisodes ───────────────────────────────────────────────────

describe("groupEvidenceEpisodes", () => {
  it("returns empty array when repoContext has no commits", async () => {
    const ctx = { repo: "my-app", dates: [], commits: [], bullets: [], sessionSnippets: [], highlights: [] };
    const episodes = await groupEvidenceEpisodes(ctx);
    assert.deepEqual(episodes, []);
  });

  it("returns empty array when repoContext is null", async () => {
    const episodes = await groupEvidenceEpisodes(null);
    assert.deepEqual(episodes, []);
  });

  it("calls LLM and normalizes episode output", async () => {
    const ctx = buildRepoWorkContext([makeDailyEntry(), makeDailyEntry2()], "my-app");

    // Stub the LLM call
    const mockLlmFn = async (_ctx) => {
      return [
        {
          title: "Payment Flow Implementation",
          summary: "Implemented Stripe payment flow with webhook verification for reliability",
          dates: ["2026-03-28"],
          commitSubjects: ["feat: add payment flow", "fix: handle edge case in payment validation"],
          bullets: [
            "Implemented Stripe payment flow with webhook verification, reducing failed payments",
            "Added edge-case validation to catch malformed payment data before processing"
          ],
          topicTag: "payment-flow",
          moduleTag: "api/payments"
        },
        {
          title: "User Analytics Dashboard",
          summary: "Built analytics dashboard with Chart.js to reduce support tickets",
          dates: ["2026-03-27"],
          commitSubjects: ["feat: add user dashboard with analytics", "fix: dashboard responsive layout"],
          bullets: [
            "Built user analytics dashboard with Chart.js, enabling self-service usage insights",
            "Optimized dashboard responsive layout for mobile and tablet viewports"
          ],
          topicTag: "analytics-dashboard",
          moduleTag: "frontend/dashboard"
        }
      ];
    };

    const episodes = await groupEvidenceEpisodes(ctx, { llmFn: mockLlmFn });

    assert.equal(episodes.length, 2);

    // Check first episode
    assert.equal(episodes[0].id, "ep-my-app-0");
    assert.equal(episodes[0].title, "Payment Flow Implementation");
    assert.ok(episodes[0].summary.includes("Stripe"));
    assert.deepEqual(episodes[0].dates, ["2026-03-28"]);
    assert.equal(episodes[0].commitSubjects.length, 2);
    assert.equal(episodes[0].bullets.length, 2);
    assert.equal(episodes[0].decisionReasoning, null); // reasoning embedded in bullets by design
    assert.equal(episodes[0].topicTag, "payment-flow");
    assert.equal(episodes[0].moduleTag, "api/payments");

    // Check second episode
    assert.equal(episodes[1].id, "ep-my-app-1");
    assert.equal(episodes[1].title, "User Analytics Dashboard");
    assert.equal(episodes[1].topicTag, "analytics-dashboard");
  });

  it("filters out episodes with no title", async () => {
    const ctx = buildRepoWorkContext([makeDailyEntry()], "my-app");
    const mockLlmFn = async () => [
      { title: "Valid Episode", summary: "test", dates: [], commitSubjects: [], bullets: [], topicTag: "t", moduleTag: "m" },
      { title: "", summary: "invalid", dates: [], commitSubjects: [], bullets: [], topicTag: "t", moduleTag: "m" },
      { summary: "no title field", dates: [], commitSubjects: [], bullets: [], topicTag: "t", moduleTag: "m" }
    ];

    const episodes = await groupEvidenceEpisodes(ctx, { llmFn: mockLlmFn });
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].title, "Valid Episode");
  });

  it("truncates long fields", async () => {
    const ctx = buildRepoWorkContext([makeDailyEntry()], "my-app");
    const longTitle = "A".repeat(200);
    const longSummary = "B".repeat(600);
    const mockLlmFn = async () => [
      { title: longTitle, summary: longSummary, dates: ["2026-03-28"], commitSubjects: [], bullets: ["test bullet"], topicTag: "t", moduleTag: "m" }
    ];

    const episodes = await groupEvidenceEpisodes(ctx, { llmFn: mockLlmFn });
    assert.ok(episodes[0].title.length <= 120);
    assert.ok(episodes[0].summary.length <= 500);
  });
});

// ─── extractCoreProjects ─────────────────────────────────────────────────────

describe("extractCoreProjects", () => {
  it("returns empty projects when repo has no daily entries", async () => {
    const result = await extractCoreProjects({ repo: "my-app", dailyEntries: [] });
    assert.equal(result.repo, "my-app");
    assert.deepEqual(result.projects, []);
    assert.equal(result.episodeCount, 0);
    assert.ok(result.extractedAt);
  });

  it("returns empty projects when no commits found for repo", async () => {
    const entry = { date: "2026-03-28", projects: [], resume: { candidates: [] }, aiSessions: { codex: [], claude: [] }, highlights: {} };
    const result = await extractCoreProjects({ repo: "my-app", dailyEntries: [entry] });
    assert.deepEqual(result.projects, []);
  });

  it("extracts ~2 core projects from a repo with multiple episodes", async () => {
    const entries = [makeDailyEntry(), makeDailyEntry2()];

    const mockEpisodeLlmFn = async (_ctx) => [
      {
        title: "Payment Flow Implementation",
        summary: "Built payment processing with Stripe webhooks",
        dates: ["2026-03-28"],
        commitSubjects: ["feat: add payment flow", "fix: handle edge case in payment validation"],
        bullets: ["Implemented Stripe payment flow with webhook verification"],
        topicTag: "payment-flow",
        moduleTag: "api/payments"
      },
      {
        title: "User Analytics Dashboard",
        summary: "Built analytics dashboard with Chart.js",
        dates: ["2026-03-27"],
        commitSubjects: ["feat: add user dashboard with analytics", "fix: dashboard responsive layout"],
        bullets: ["Built user analytics dashboard enabling self-service insights", "Optimized dashboard responsive layout for mobile viewports"],
        topicTag: "analytics-dashboard",
        moduleTag: "frontend/dashboard"
      }
    ];

    const mockProjectLlmFn = async (_repo, _episodes, _ctx) => [
      {
        title: "Payment Processing Pipeline",
        description: "End-to-end payment flow with Stripe integration. Added webhook verification for reliability and edge-case validation to catch malformed data. Revenue protection was the key driver.",
        episodeIndices: [0],
        bullets: [
          "Built Stripe payment pipeline with webhook verification for reliable transaction processing",
          "Added payment validation edge-case handling, reducing failed transaction rate"
        ],
        techTags: ["Stripe", "Node.js", "Webhooks"]
      },
      {
        title: "Self-Service Analytics Dashboard",
        description: "User-facing analytics dashboard built with Chart.js. Chose Chart.js over D3 for faster iteration. Reduced support ticket volume by enabling self-service usage data access.",
        episodeIndices: [1],
        bullets: [
          "Launched user analytics dashboard with Chart.js, reducing support tickets for usage data",
          "Integrated self-service usage reports enabling users to track activity without contacting support"
        ],
        techTags: ["Chart.js", "React", "Analytics"]
      }
    ];

    const result = await extractCoreProjects(
      { repo: "my-app", dailyEntries: entries },
      { llmFn: mockEpisodeLlmFn, projectLlmFn: mockProjectLlmFn }
    );

    assert.equal(result.repo, "my-app");
    assert.equal(result.projects.length, 2);
    assert.equal(result.episodeCount, 2);

    // Check first project
    const proj1 = result.projects[0];
    assert.equal(proj1.id, "proj-my-app-0");
    assert.equal(proj1.repo, "my-app");
    assert.equal(proj1.title, "Payment Processing Pipeline");
    assert.ok(proj1.description.includes("Stripe"));
    assert.equal(proj1.episodes.length, 1);
    assert.equal(proj1.episodes[0].title, "Payment Flow Implementation");
    assert.ok(proj1.bullets.length >= 1);
    assert.ok(proj1.techTags.includes("Stripe"));
    assert.equal(proj1._source, "system");
    assert.equal(proj1.dateRange, "Mar 2026");

    // Check second project
    const proj2 = result.projects[1];
    assert.equal(proj2.id, "proj-my-app-1");
    assert.equal(proj2.title, "Self-Service Analytics Dashboard");
    assert.equal(proj2.episodes.length, 1);
    assert.ok(proj2.techTags.includes("Chart.js"));
  });

  it("caps projects at 4 per repo", async () => {
    const entries = [makeDailyEntry()];

    const mockEpisodeLlmFn = async () => [
      { title: "Ep1", summary: "s", dates: ["2026-03-28"], commitSubjects: ["c"], bullets: ["b"], topicTag: "t", moduleTag: "m" }
    ];

    const mockProjectLlmFn = async () => [
      { title: "P1", description: "d", episodeIndices: [0], bullets: ["b"], techTags: ["t"] },
      { title: "P2", description: "d", episodeIndices: [0], bullets: ["b"], techTags: ["t"] },
      { title: "P3", description: "d", episodeIndices: [0], bullets: ["b"], techTags: ["t"] },
      { title: "P4", description: "d", episodeIndices: [0], bullets: ["b"], techTags: ["t"] },
      { title: "P5", description: "d", episodeIndices: [0], bullets: ["b"], techTags: ["t"] }
    ];

    const result = await extractCoreProjects(
      { repo: "my-app", dailyEntries: entries },
      { llmFn: mockEpisodeLlmFn, projectLlmFn: mockProjectLlmFn }
    );

    assert.ok(result.projects.length <= 4, `Expected ≤4 projects, got ${result.projects.length}`);
  });

  it("handles episode indices out of range gracefully", async () => {
    const entries = [makeDailyEntry()];

    const mockEpisodeLlmFn = async () => [
      { title: "Ep1", summary: "s", dates: ["2026-03-28"], commitSubjects: ["c"], bullets: ["b"], topicTag: "t", moduleTag: "m" }
    ];

    const mockProjectLlmFn = async () => [
      {
        title: "P1",
        description: "d",
        episodeIndices: [0, 5, -1, 99], // 5, -1, 99 are out of range
        bullets: ["b"],
        techTags: ["t"]
      }
    ];

    const result = await extractCoreProjects(
      { repo: "my-app", dailyEntries: entries },
      { llmFn: mockEpisodeLlmFn, projectLlmFn: mockProjectLlmFn }
    );

    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].episodes.length, 1); // Only index 0 is valid
  });

  it("computes date range spanning multiple months", async () => {
    const entries = [
      makeDailyEntry({ date: "2026-01-15" }),
      makeDailyEntry2({ date: "2026-03-28" })
    ];
    // Override project entries to have proper dates
    entries[0].projects[0].commits[0].authoredAt = "2026-01-15T10:00:00+09:00";

    const mockEpisodeLlmFn = async () => [
      { title: "Ep1", summary: "s", dates: ["2026-01-15"], commitSubjects: ["c"], bullets: ["b"], topicTag: "t", moduleTag: "m" },
      { title: "Ep2", summary: "s", dates: ["2026-03-28"], commitSubjects: ["c"], bullets: ["b"], topicTag: "t", moduleTag: "m" }
    ];

    const mockProjectLlmFn = async () => [
      {
        title: "P1",
        description: "d",
        episodeIndices: [0, 1],
        bullets: ["b"],
        techTags: ["t"]
      }
    ];

    const result = await extractCoreProjects(
      { repo: "my-app", dailyEntries: entries },
      { llmFn: mockEpisodeLlmFn, projectLlmFn: mockProjectLlmFn }
    );

    assert.equal(result.projects[0].dateRange, "Jan–Mar 2026");
  });

  it("returns empty when episode grouping returns empty", async () => {
    const entries = [makeDailyEntry()];

    const mockEpisodeLlmFn = async () => []; // No episodes found

    const result = await extractCoreProjects(
      { repo: "my-app", dailyEntries: entries },
      { llmFn: mockEpisodeLlmFn }
    );

    assert.deepEqual(result.projects, []);
    assert.equal(result.episodeCount, 0);
  });
});

// ─── TARGET_PROJECTS_PER_REPO ────────────────────────────────────────────────

describe("TARGET_PROJECTS_PER_REPO", () => {
  it("is 2", () => {
    assert.equal(TARGET_PROJECTS_PER_REPO, 2);
  });
});
