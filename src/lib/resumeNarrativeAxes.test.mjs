/**
 * Tests for the narrative axes generation pipeline in resumeReconstruction.mjs.
 *
 * Coverage:
 *   - generateNarrativeAxes: empty input, single repo, cross-repo synthesis,
 *     session summaries, coverage metrics, auto-retry on low coverage
 *   - _normalizeNarrativeAxes: ID validation, repos derivation, label/desc truncation
 *   - _mergeNarrativeAxes: user edits preserved, system updates, cap at max
 *   - _buildNarrativeAxesUserMessage: message structure, session summaries, coverage target
 *   - _computeCoverage: project/strength coverage scoring
 *   - _computeComplementarity: pairwise overlap detection
 *
 * Run:
 *   node --test src/lib/resumeNarrativeAxes.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  generateNarrativeAxes,
  _normalizeNarrativeAxes,
  _mergeNarrativeAxes,
  _buildNarrativeAxesUserMessage,
  _computeCoverage,
  _computeComplementarity,
  TARGET_AXES_MIN,
  TARGET_AXES_MAX
} from "./resumeReconstruction.mjs";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeEpisode(id, title, opts = {}) {
  return {
    id,
    title,
    summary: opts.summary || `Summary of ${title}`,
    dates: opts.dates || ["2026-03-15"],
    commitSubjects: opts.commitSubjects || ["feat: initial commit"],
    bullets: opts.bullets || [`Implemented ${title}`],
    decisionReasoning: opts.decisionReasoning || null,
    topicTag: opts.topicTag || "general",
    moduleTag: opts.moduleTag || "general"
  };
}

function makeProject(id, repo, title, episodes, opts = {}) {
  return {
    id,
    repo,
    title,
    description: opts.description || `Description of ${title}`,
    episodes,
    bullets: opts.bullets || episodes.flatMap((ep) => ep.bullets),
    techTags: opts.techTags || ["TypeScript"],
    dateRange: opts.dateRange || "Mar 2026",
    _source: opts._source || "system"
  };
}

function makeStrength(id, label, opts = {}) {
  return {
    id,
    label,
    description: opts.description || `Description of ${label}`,
    frequency: opts.frequency || 2,
    evidenceIds: opts.evidenceIds || [],
    projectIds: opts.projectIds || [],
    repos: opts.repos || [],
    exampleBullets: opts.exampleBullets || [],
    _source: opts._source || "system"
  };
}

function makeExtractionResult(repo, projects) {
  return {
    repo,
    projects,
    episodeCount: projects.reduce(
      (sum, p) => sum + (p.episodes ? p.episodes.length : 0),
      0
    ),
    extractedAt: "2026-03-31T00:00:00.000Z"
  };
}

function makeNarrativeAxis(id, label, source = "system", overrides = {}) {
  return {
    id,
    label,
    description: overrides.description || `Description of axis: ${label}`,
    strengthIds: overrides.strengthIds || [],
    projectIds: overrides.projectIds || [],
    repos: overrides.repos || [],
    supportingBullets: overrides.supportingBullets || [],
    _source: source
  };
}

function makeSessionSummary(opts = {}) {
  return {
    date: opts.date || "2026-03-15",
    tool: opts.tool || "Claude",
    repo: opts.repo || "my-repo",
    summary: opts.summary || "Discussed architecture approach",
    reasoning: opts.reasoning || null,
    keyDecisions: opts.keyDecisions || [],
    tradeoffs: opts.tradeoffs || null
  };
}

// ─── generateNarrativeAxes ───────────────────────────────────────────────────

describe("generateNarrativeAxes", () => {
  it("returns empty result for no extraction results and no strengths", async () => {
    const result = await generateNarrativeAxes({
      extractionResults: [],
      strengths: [],
      existingAxes: []
    });

    assert.deepEqual(result.axes, []);
    assert.equal(result.totalProjects, 0);
    assert.equal(result.totalStrengths, 0);
    assert.ok(result.generatedAt);
    // Coverage metrics present even for empty
    assert.ok(result.coverage);
    assert.equal(result.coverage.overallCoverage, 0);
    assert.ok(result.complementarity);
    assert.equal(result.complementarity.isComplementary, true);
  });

  it("returns empty result for null/undefined input", async () => {
    const result = await generateNarrativeAxes({
      extractionResults: null,
      strengths: null,
      existingAxes: []
    });

    assert.deepEqual(result.axes, []);
  });

  it("preserves existing axes when no new evidence", async () => {
    const existing = [
      makeNarrativeAxis("naxis-0", "Reliability Engineer", "user")
    ];

    const result = await generateNarrativeAxes({
      extractionResults: [],
      strengths: [],
      existingAxes: existing
    });

    assert.equal(result.axes.length, 1);
    assert.equal(result.axes[0].label, "Reliability Engineer");
    assert.equal(result.axes[0]._source, "user");
  });

  it("calls LLM and returns normalized axes for valid input", async () => {
    const ep1 = makeEpisode("ep-repo-a-0", "Payment refactoring");
    const ep2 = makeEpisode("ep-repo-a-1", "Error handling");
    const projA = makeProject("proj-repo-a-0", "repo-a", "Payment System", [ep1, ep2], {
      bullets: ["Reduced payment errors by 40%", "Added retry logic"]
    });
    const extractionResult = makeExtractionResult("repo-a", [projA]);

    const str1 = makeStrength("str-0", "Reliability Engineering", {
      repos: ["repo-a"],
      exampleBullets: ["Added retry logic"]
    });

    const mockLlm = async () => [
      {
        label: "운영 안정성을 높이는 엔지니어",
        description: "결제 시스템에서 반복되는 장애를 체계적으로 제거하고 안정성을 개선",
        strengthIds: ["str-0"],
        projectIds: ["proj-repo-a-0"],
        supportingBullets: ["Reduced payment errors by 40%"]
      }
    ];

    const result = await generateNarrativeAxes(
      {
        extractionResults: [extractionResult],
        strengths: [str1],
        existingAxes: []
      },
      { llmFn: mockLlm }
    );

    assert.equal(result.axes.length, 1);
    assert.equal(result.axes[0].label, "운영 안정성을 높이는 엔지니어");
    assert.deepEqual(result.axes[0].strengthIds, ["str-0"]);
    assert.deepEqual(result.axes[0].projectIds, ["proj-repo-a-0"]);
    assert.deepEqual(result.axes[0].repos, ["repo-a"]);
    assert.equal(result.axes[0]._source, "system");
    assert.equal(result.totalProjects, 1);
    assert.equal(result.totalStrengths, 1);
    // Coverage metrics
    assert.equal(result.coverage.projectCoverage, 1);
    assert.equal(result.coverage.strengthCoverage, 1);
    assert.equal(result.coverage.overallCoverage, 1);
  });

  it("synthesizes cross-repo narrative axes", async () => {
    const ep1 = makeEpisode("ep-repo-a-0", "API stability");
    const ep2 = makeEpisode("ep-repo-b-0", "Service monitoring");
    const projA = makeProject("proj-repo-a-0", "repo-a", "API Platform", [ep1]);
    const projB = makeProject("proj-repo-b-0", "repo-b", "Monitoring System", [ep2]);
    const resultA = makeExtractionResult("repo-a", [projA]);
    const resultB = makeExtractionResult("repo-b", [projB]);

    const str1 = makeStrength("str-0", "System Reliability", { repos: ["repo-a", "repo-b"] });

    const mockLlm = async () => [
      {
        label: "Reliability-focused systems engineer",
        description: "Builds reliable systems across API and monitoring layers",
        strengthIds: ["str-0"],
        projectIds: ["proj-repo-a-0", "proj-repo-b-0"],
        supportingBullets: ["Improved API uptime to 99.9%"]
      },
      {
        label: "Cross-service architect",
        description: "Designs cohesive systems spanning multiple services",
        strengthIds: [],
        projectIds: ["proj-repo-a-0", "proj-repo-b-0"],
        supportingBullets: []
      }
    ];

    const result = await generateNarrativeAxes(
      {
        extractionResults: [resultA, resultB],
        strengths: [str1],
        existingAxes: []
      },
      { llmFn: mockLlm }
    );

    assert.equal(result.axes.length, 2);
    assert.ok(result.axes[0].repos.includes("repo-a"));
    assert.ok(result.axes[0].repos.includes("repo-b"));
  });

  it("merges with existing user-edited axes", async () => {
    const ep1 = makeEpisode("ep-repo-a-0", "Work");
    const proj = makeProject("proj-repo-a-0", "repo-a", "Project", [ep1]);
    const extractionResult = makeExtractionResult("repo-a", [proj]);

    const userAxis = makeNarrativeAxis("naxis-0", "Technical Leader", "user");

    const mockLlm = async () => [
      {
        label: "System Designer",
        description: "Designs complex systems",
        strengthIds: [],
        projectIds: ["proj-repo-a-0"],
        supportingBullets: []
      }
    ];

    const result = await generateNarrativeAxes(
      {
        extractionResults: [extractionResult],
        strengths: [],
        existingAxes: [userAxis]
      },
      { llmFn: mockLlm }
    );

    // User axis should be first
    assert.equal(result.axes[0].label, "Technical Leader");
    assert.equal(result.axes[0]._source, "user");
    // System axis appended
    assert.equal(result.axes[1].label, "System Designer");
    assert.equal(result.axes[1]._source, "system");
  });

  it("generates axes from strengths alone (no projects)", async () => {
    const str1 = makeStrength("str-0", "Debugging Expert", { repos: ["repo-a"] });
    const str2 = makeStrength("str-1", "Product Sense", { repos: ["repo-b"] });

    const mockLlm = async () => [
      {
        label: "Problem-solving engineer",
        description: "Combines debugging skill with product intuition",
        strengthIds: ["str-0", "str-1"],
        projectIds: [],
        supportingBullets: []
      }
    ];

    const result = await generateNarrativeAxes(
      {
        extractionResults: [],
        strengths: [str1, str2],
        existingAxes: []
      },
      { llmFn: mockLlm }
    );

    assert.equal(result.axes.length, 1);
    assert.deepEqual(result.axes[0].strengthIds, ["str-0", "str-1"]);
    assert.equal(result.totalStrengths, 2);
  });

  it("includes session summaries in LLM call context", async () => {
    const ep1 = makeEpisode("ep-repo-a-0", "Payment refactoring");
    const proj = makeProject("proj-repo-a-0", "repo-a", "Payment System", [ep1]);
    const extractionResult = makeExtractionResult("repo-a", [proj]);

    const session = makeSessionSummary({
      summary: "Discussed error boundary approach",
      keyDecisions: ["Chose structured error boundaries over retry-only"],
      reasoning: "Prioritized observability for long-term maintainability"
    });

    let capturedSessions = null;
    const mockLlm = async (_p, _s, _e, sessions) => {
      capturedSessions = sessions;
      return [
        {
          label: "Reliability Engineer",
          description: "Builds reliable systems",
          strengthIds: [],
          projectIds: ["proj-repo-a-0"],
          supportingBullets: []
        }
      ];
    };

    await generateNarrativeAxes(
      {
        extractionResults: [extractionResult],
        strengths: [],
        existingAxes: [],
        sessionSummaries: [session]
      },
      { llmFn: mockLlm }
    );

    assert.ok(capturedSessions);
    assert.equal(capturedSessions.length, 1);
    assert.equal(capturedSessions[0].summary, "Discussed error boundary approach");
  });

  it("returns coverage and complementarity metrics", async () => {
    const ep1 = makeEpisode("ep-repo-a-0", "Work A");
    const ep2 = makeEpisode("ep-repo-b-0", "Work B");
    const projA = makeProject("proj-repo-a-0", "repo-a", "Project A", [ep1]);
    const projB = makeProject("proj-repo-b-0", "repo-b", "Project B", [ep2]);
    const resultA = makeExtractionResult("repo-a", [projA]);
    const resultB = makeExtractionResult("repo-b", [projB]);

    const str1 = makeStrength("str-0", "Strength A", { repos: ["repo-a"] });
    const str2 = makeStrength("str-1", "Strength B", { repos: ["repo-b"] });

    const mockLlm = async () => [
      {
        label: "Axis One",
        description: "First axis",
        strengthIds: ["str-0"],
        projectIds: ["proj-repo-a-0"],
        supportingBullets: []
      },
      {
        label: "Axis Two",
        description: "Second axis",
        strengthIds: ["str-1"],
        projectIds: ["proj-repo-b-0"],
        supportingBullets: []
      }
    ];

    const result = await generateNarrativeAxes(
      {
        extractionResults: [resultA, resultB],
        strengths: [str1, str2],
        existingAxes: []
      },
      { llmFn: mockLlm }
    );

    // Full coverage
    assert.equal(result.coverage.projectCoverage, 1);
    assert.equal(result.coverage.strengthCoverage, 1);
    assert.equal(result.coverage.overallCoverage, 1);
    assert.deepEqual(result.coverage.uncoveredProjectIds, []);
    assert.deepEqual(result.coverage.uncoveredStrengthIds, []);

    // Complementary (no overlap)
    assert.equal(result.complementarity.isComplementary, true);
    assert.equal(result.complementarity.maxOverlap, 0);
  });

  it("retries LLM call when coverage is below threshold", async () => {
    const ep1 = makeEpisode("ep-repo-a-0", "Work A");
    const ep2 = makeEpisode("ep-repo-b-0", "Work B");
    const ep3 = makeEpisode("ep-repo-c-0", "Work C");
    const projA = makeProject("proj-repo-a-0", "repo-a", "Project A", [ep1]);
    const projB = makeProject("proj-repo-b-0", "repo-b", "Project B", [ep2]);
    const projC = makeProject("proj-repo-c-0", "repo-c", "Project C", [ep3]);
    const resultA = makeExtractionResult("repo-a", [projA]);
    const resultB = makeExtractionResult("repo-b", [projB]);
    const resultC = makeExtractionResult("repo-c", [projC]);

    let callCount = 0;
    const mockLlm = async () => {
      callCount++;
      if (callCount === 1) {
        // Low coverage — only covers 1 of 3 projects
        return [
          {
            label: "Narrow axis",
            description: "Only one project",
            strengthIds: [],
            projectIds: ["proj-repo-a-0"],
            supportingBullets: []
          }
        ];
      }
      // Better coverage on retry
      return [
        {
          label: "Broad axis",
          description: "All projects",
          strengthIds: [],
          projectIds: ["proj-repo-a-0", "proj-repo-b-0", "proj-repo-c-0"],
          supportingBullets: []
        }
      ];
    };

    const result = await generateNarrativeAxes(
      {
        extractionResults: [resultA, resultB, resultC],
        strengths: [],
        existingAxes: []
      },
      { llmFn: mockLlm }
    );

    // Should have retried
    assert.equal(callCount, 2);
    // Should use the better-coverage result
    assert.equal(result.coverage.projectCoverage, 1);
  });

  it("skips retry when skipRetry option is set", async () => {
    const ep1 = makeEpisode("ep-repo-a-0", "Work A");
    const ep2 = makeEpisode("ep-repo-b-0", "Work B");
    const ep3 = makeEpisode("ep-repo-c-0", "Work C");
    const projA = makeProject("proj-repo-a-0", "repo-a", "Project A", [ep1]);
    const projB = makeProject("proj-repo-b-0", "repo-b", "Project B", [ep2]);
    const projC = makeProject("proj-repo-c-0", "repo-c", "Project C", [ep3]);

    let callCount = 0;
    const mockLlm = async () => {
      callCount++;
      return [
        {
          label: "Narrow axis",
          description: "Only one project",
          strengthIds: [],
          projectIds: ["proj-repo-a-0"],
          supportingBullets: []
        }
      ];
    };

    await generateNarrativeAxes(
      {
        extractionResults: [
          makeExtractionResult("repo-a", [projA]),
          makeExtractionResult("repo-b", [projB]),
          makeExtractionResult("repo-c", [projC])
        ],
        strengths: [],
        existingAxes: []
      },
      { llmFn: mockLlm, skipRetry: true }
    );

    assert.equal(callCount, 1);
  });
});

// ─── _normalizeNarrativeAxes ─────────────────────────────────────────────────

describe("_normalizeNarrativeAxes", () => {
  const ep1 = makeEpisode("ep-repo-0", "Episode A");
  const proj = makeProject("proj-repo-0", "my-repo", "Project A", [ep1]);
  const str = makeStrength("str-0", "Strength A", { repos: ["my-repo", "other-repo"] });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(_normalizeNarrativeAxes(null, [proj], [str]), []);
    assert.deepEqual(_normalizeNarrativeAxes(undefined, [proj], [str]), []);
    assert.deepEqual(_normalizeNarrativeAxes("not array", [proj], [str]), []);
  });

  it("filters out axes without a label", () => {
    const raw = [
      { label: "", description: "no label", strengthIds: [], projectIds: [], supportingBullets: [] },
      { description: "missing label", strengthIds: [], projectIds: [], supportingBullets: [] }
    ];
    assert.deepEqual(_normalizeNarrativeAxes(raw, [proj], [str]), []);
  });

  it("caps at TARGET_AXES_MAX", () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      label: `Axis ${i}`,
      description: `Desc ${i}`,
      strengthIds: [],
      projectIds: [],
      supportingBullets: []
    }));
    const result = _normalizeNarrativeAxes(raw, [proj], [str]);
    assert.equal(result.length, TARGET_AXES_MAX);
  });

  it("validates project IDs against known projects", () => {
    const raw = [
      {
        label: "Test Axis",
        description: "Test",
        strengthIds: [],
        projectIds: ["proj-repo-0", "proj-nonexistent-99"],
        supportingBullets: []
      }
    ];
    const result = _normalizeNarrativeAxes(raw, [proj], [str]);
    assert.deepEqual(result[0].projectIds, ["proj-repo-0"]);
  });

  it("validates strength IDs against known strengths", () => {
    const raw = [
      {
        label: "Test Axis",
        description: "Test",
        strengthIds: ["str-0", "str-nonexistent"],
        projectIds: [],
        supportingBullets: []
      }
    ];
    const result = _normalizeNarrativeAxes(raw, [proj], [str]);
    assert.deepEqual(result[0].strengthIds, ["str-0"]);
  });

  it("derives repos from validated project IDs and strength repos", () => {
    const raw = [
      {
        label: "Cross-repo Axis",
        description: "Test",
        strengthIds: ["str-0"],
        projectIds: ["proj-repo-0"],
        supportingBullets: []
      }
    ];
    const result = _normalizeNarrativeAxes(raw, [proj], [str]);
    // Should include repos from both project and strength
    assert.ok(result[0].repos.includes("my-repo"));
    assert.ok(result[0].repos.includes("other-repo"));
  });

  it("assigns sequential IDs", () => {
    const raw = [
      { label: "A", description: "a", strengthIds: [], projectIds: [], supportingBullets: [] },
      { label: "B", description: "b", strengthIds: [], projectIds: [], supportingBullets: [] }
    ];
    const result = _normalizeNarrativeAxes(raw, [proj], [str]);
    assert.equal(result[0].id, "naxis-0");
    assert.equal(result[1].id, "naxis-1");
  });

  it("sets _source to system", () => {
    const raw = [
      { label: "Test", description: "test", strengthIds: [], projectIds: [], supportingBullets: [] }
    ];
    const result = _normalizeNarrativeAxes(raw, [proj], [str]);
    assert.equal(result[0]._source, "system");
  });

  it("truncates long labels and descriptions", () => {
    const raw = [
      {
        label: "A".repeat(200),
        description: "B".repeat(1000),
        strengthIds: [],
        projectIds: [],
        supportingBullets: []
      }
    ];
    const result = _normalizeNarrativeAxes(raw, [proj], [str]);
    assert.ok(result[0].label.length <= 60);
    assert.ok(result[0].description.length <= 600);
  });

  it("caps supportingBullets at 3 items", () => {
    const raw = [
      {
        label: "Test",
        description: "test",
        strengthIds: [],
        projectIds: [],
        supportingBullets: ["A", "B", "C", "D", "E"]
      }
    ];
    const result = _normalizeNarrativeAxes(raw, [proj], [str]);
    assert.equal(result[0].supportingBullets.length, 3);
  });
});

// ─── _mergeNarrativeAxes ─────────────────────────────────────────────────────

describe("_mergeNarrativeAxes", () => {
  it("returns fresh axes when no existing", () => {
    const fresh = [
      makeNarrativeAxis("naxis-0", "Reliability Engineer"),
      makeNarrativeAxis("naxis-1", "Product Builder")
    ];
    const result = _mergeNarrativeAxes([], fresh);
    assert.equal(result.length, 2);
    assert.equal(result[0].label, "Reliability Engineer");
  });

  it("preserves user-edited axes unchanged", () => {
    const user = makeNarrativeAxis("naxis-0", "My Career Theme", "user");
    const fresh = [
      makeNarrativeAxis("naxis-0", "My Career Theme", "system", {
        description: "New system description"
      })
    ];
    const result = _mergeNarrativeAxes([user], fresh);
    assert.equal(result[0]._source, "user");
    assert.equal(result[0].description, "Description of axis: My Career Theme");
  });

  it("preserves user_approved axes unchanged", () => {
    const approved = makeNarrativeAxis("naxis-0", "Approved Theme", "user_approved");
    const fresh = [makeNarrativeAxis("naxis-0", "Approved Theme", "system")];
    const result = _mergeNarrativeAxes([approved], fresh);
    assert.equal(result[0]._source, "user_approved");
  });

  it("updates existing system axes with matching labels", () => {
    const existing = [
      makeNarrativeAxis("naxis-0", "System Theme", "system", { description: "old" })
    ];
    const fresh = [
      makeNarrativeAxis("naxis-0", "System Theme", "system", { description: "new" })
    ];
    const result = _mergeNarrativeAxes(existing, fresh);
    assert.equal(result.length, 1);
    assert.equal(result[0].description, "new");
  });

  it("matches labels case-insensitively", () => {
    const existing = [
      makeNarrativeAxis("naxis-0", "Reliability Engineer", "system", { description: "old" })
    ];
    const fresh = [
      makeNarrativeAxis("naxis-0", "reliability engineer", "system", { description: "updated" })
    ];
    const result = _mergeNarrativeAxes(existing, fresh);
    assert.equal(result.length, 1);
    assert.equal(result[0].description, "updated");
  });

  it("appends new axes that don't match existing", () => {
    const existing = [makeNarrativeAxis("naxis-0", "Theme A", "system")];
    const fresh = [makeNarrativeAxis("naxis-1", "Theme B", "system")];
    const result = _mergeNarrativeAxes(existing, fresh);
    assert.equal(result.length, 2);
    assert.equal(result[0].label, "Theme A");
    assert.equal(result[1].label, "Theme B");
  });

  it("puts user axes first in order", () => {
    const existing = [
      makeNarrativeAxis("naxis-0", "System A", "system"),
      makeNarrativeAxis("naxis-1", "User B", "user")
    ];
    const fresh = [makeNarrativeAxis("naxis-2", "New C", "system")];
    const result = _mergeNarrativeAxes(existing, fresh);
    assert.equal(result[0].label, "User B"); // User first
  });

  it("caps total at TARGET_AXES_MAX", () => {
    const existing = [makeNarrativeAxis("naxis-0", "User A", "user")];
    const fresh = [
      makeNarrativeAxis("naxis-1", "B", "system"),
      makeNarrativeAxis("naxis-2", "C", "system"),
      makeNarrativeAxis("naxis-3", "D", "system"),
      makeNarrativeAxis("naxis-4", "E", "system")
    ];
    const result = _mergeNarrativeAxes(existing, fresh);
    assert.ok(result.length <= TARGET_AXES_MAX);
  });

  it("returns only user axes when user has 3+", () => {
    const userAxes = Array.from({ length: 4 }, (_, i) =>
      makeNarrativeAxis(`naxis-${i}`, `User ${i}`, "user")
    );
    const fresh = [makeNarrativeAxis("naxis-x", "System X", "system")];
    const result = _mergeNarrativeAxes(userAxes, fresh);
    assert.equal(result.length, TARGET_AXES_MAX);
    assert.ok(result.every((a) => a._source === "user"));
  });

  it("skips fresh axes whose label matches a user axis", () => {
    const existing = [makeNarrativeAxis("naxis-0", "My Theme", "user")];
    const fresh = [
      makeNarrativeAxis("naxis-1", "My Theme", "system", { description: "system version" })
    ];
    const result = _mergeNarrativeAxes(existing, fresh);
    assert.equal(result.length, 1);
    assert.equal(result[0]._source, "user");
  });
});

// ─── _buildNarrativeAxesUserMessage ──────────────────────────────────────────

describe("_buildNarrativeAxesUserMessage", () => {
  it("includes strengths, projects, and decision episodes in the message", () => {
    const ep = makeEpisode("ep-repo-0", "Test Episode", {
      bullets: ["Improved performance by 50%"],
      decisionReasoning: "Chose this approach for better reliability"
    });
    const proj = makeProject("proj-repo-0", "my-repo", "Test Project", [ep], {
      techTags: ["React", "Node.js"]
    });
    const str = makeStrength("str-0", "System Design", {
      repos: ["my-repo"],
      exampleBullets: ["Designed scalable API"]
    });

    const msg = _buildNarrativeAxesUserMessage([proj], [str], [ep]);

    // Should contain strength info
    assert.ok(msg.includes("IDENTIFIED STRENGTHS"));
    assert.ok(msg.includes("System Design"));
    assert.ok(msg.includes("str-0"));
    assert.ok(msg.includes("Designed scalable API"));

    // Should contain project info
    assert.ok(msg.includes("CORE PROJECTS"));
    assert.ok(msg.includes("Test Project"));
    assert.ok(msg.includes("proj-repo-0"));
    assert.ok(msg.includes("React, Node.js"));

    // Should contain decision reasoning
    assert.ok(msg.includes("KEY DECISION EPISODES"));
    assert.ok(msg.includes("Chose this approach for better reliability"));
  });

  it("handles empty arrays gracefully", () => {
    const msg = _buildNarrativeAxesUserMessage([], [], []);
    assert.equal(typeof msg, "string");
  });

  it("only includes episodes with decision reasoning in KEY DECISION section", () => {
    const epWithReasoning = makeEpisode("ep-0", "With reasoning", {
      decisionReasoning: "Chose X because Y"
    });
    const epWithout = makeEpisode("ep-1", "Without reasoning");

    const msg = _buildNarrativeAxesUserMessage([], [], [epWithReasoning, epWithout]);

    assert.ok(msg.includes("Chose X because Y"));
    assert.ok(msg.includes("KEY DECISION EPISODES (1)"));
  });

  it("limits decision episodes to 15", () => {
    const episodes = Array.from({ length: 20 }, (_, i) =>
      makeEpisode(`ep-${i}`, `Episode ${i}`, {
        decisionReasoning: `Reason ${i}`
      })
    );

    const msg = _buildNarrativeAxesUserMessage([], [], episodes);

    // Should include first 15 but not episode 15-19
    assert.ok(msg.includes("Reason 14"));
    assert.ok(!msg.includes("Reason 15"));
  });

  it("includes session summaries with key decisions and reasoning", () => {
    const session = makeSessionSummary({
      date: "2026-03-15",
      tool: "Claude",
      repo: "my-repo",
      summary: "Discussed error boundary approach",
      reasoning: "Prioritized observability",
      keyDecisions: ["Chose structured error boundaries"],
      tradeoffs: "Complexity vs. reliability"
    });

    const msg = _buildNarrativeAxesUserMessage([], [], [], [session]);

    assert.ok(msg.includes("AI SESSION CONVERSATIONS"));
    assert.ok(msg.includes("Discussed error boundary approach"));
    assert.ok(msg.includes("Prioritized observability"));
    assert.ok(msg.includes("Chose structured error boundaries"));
    assert.ok(msg.includes("Complexity vs. reliability"));
    assert.ok(msg.includes("Claude"));
    assert.ok(msg.includes("my-repo"));
  });

  it("limits session summaries to 10", () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      makeSessionSummary({ summary: `Session summary ${i}` })
    );

    const msg = _buildNarrativeAxesUserMessage([], [], [], sessions);

    assert.ok(msg.includes("Session summary 9"));
    assert.ok(!msg.includes("Session summary 10"));
  });

  it("filters out sessions without meaningful content", () => {
    const emptySession = { date: "2026-03-15", tool: "Claude" };
    const validSession = makeSessionSummary({
      summary: "Real discussion"
    });

    const msg = _buildNarrativeAxesUserMessage([], [], [], [emptySession, validSession]);

    assert.ok(msg.includes("AI SESSION CONVERSATIONS (1)"));
    assert.ok(msg.includes("Real discussion"));
  });

  it("includes coverage target section with project and strength IDs", () => {
    const proj = makeProject("proj-repo-0", "my-repo", "Project A", []);
    const str = makeStrength("str-0", "Strength A");

    const msg = _buildNarrativeAxesUserMessage([proj], [str], []);

    assert.ok(msg.includes("COVERAGE TARGET"));
    assert.ok(msg.includes("proj-repo-0"));
    assert.ok(msg.includes("str-0"));
  });
});

// ─── _computeCoverage ──────────────────────────────────────────────────────────

describe("_computeCoverage", () => {
  it("returns full coverage when all projects and strengths are referenced", () => {
    const axes = [
      makeNarrativeAxis("naxis-0", "A", "system", {
        projectIds: ["proj-0", "proj-1"],
        strengthIds: ["str-0"]
      }),
      makeNarrativeAxis("naxis-1", "B", "system", {
        projectIds: ["proj-2"],
        strengthIds: ["str-1"]
      })
    ];
    const projects = [{ id: "proj-0" }, { id: "proj-1" }, { id: "proj-2" }];
    const strengths = [{ id: "str-0" }, { id: "str-1" }];

    const result = _computeCoverage(axes, projects, strengths);

    assert.equal(result.projectCoverage, 1);
    assert.equal(result.strengthCoverage, 1);
    assert.equal(result.overallCoverage, 1);
    assert.deepEqual(result.uncoveredProjectIds, []);
    assert.deepEqual(result.uncoveredStrengthIds, []);
  });

  it("reports partial coverage with uncovered IDs", () => {
    const axes = [
      makeNarrativeAxis("naxis-0", "A", "system", {
        projectIds: ["proj-0"],
        strengthIds: ["str-0"]
      })
    ];
    const projects = [{ id: "proj-0" }, { id: "proj-1" }, { id: "proj-2" }];
    const strengths = [{ id: "str-0" }, { id: "str-1" }];

    const result = _computeCoverage(axes, projects, strengths);

    assert.ok(result.projectCoverage < 1);
    assert.ok(result.strengthCoverage < 1);
    assert.ok(result.overallCoverage < 1);
    assert.deepEqual(result.uncoveredProjectIds, ["proj-1", "proj-2"]);
    assert.deepEqual(result.uncoveredStrengthIds, ["str-1"]);
  });

  it("handles empty axes", () => {
    const result = _computeCoverage([], [{ id: "proj-0" }], [{ id: "str-0" }]);
    assert.equal(result.projectCoverage, 0);
    assert.equal(result.strengthCoverage, 0);
    assert.equal(result.overallCoverage, 0);
  });

  it("handles empty projects and strengths", () => {
    const result = _computeCoverage(
      [makeNarrativeAxis("naxis-0", "A")],
      [],
      []
    );
    assert.equal(result.projectCoverage, 1);
    assert.equal(result.strengthCoverage, 1);
    assert.equal(result.overallCoverage, 1);
  });

  it("counts projects referenced by multiple axes only once", () => {
    const axes = [
      makeNarrativeAxis("naxis-0", "A", "system", { projectIds: ["proj-0"] }),
      makeNarrativeAxis("naxis-1", "B", "system", { projectIds: ["proj-0"] })
    ];
    const projects = [{ id: "proj-0" }, { id: "proj-1" }];

    const result = _computeCoverage(axes, projects, []);
    assert.equal(result.projectCoverage, 0.5);
  });
});

// ─── _computeComplementarity ─────────────────────────────────────────────────

describe("_computeComplementarity", () => {
  it("returns complementary for a single axis", () => {
    const axes = [makeNarrativeAxis("naxis-0", "A")];
    const result = _computeComplementarity(axes);
    assert.equal(result.maxOverlap, 0);
    assert.equal(result.isComplementary, true);
    assert.deepEqual(result.overlapPairs, []);
  });

  it("returns complementary for non-overlapping axes", () => {
    const axes = [
      makeNarrativeAxis("naxis-0", "A", "system", {
        projectIds: ["proj-0"],
        strengthIds: ["str-0"]
      }),
      makeNarrativeAxis("naxis-1", "B", "system", {
        projectIds: ["proj-1"],
        strengthIds: ["str-1"]
      })
    ];
    const result = _computeComplementarity(axes);
    assert.equal(result.maxOverlap, 0);
    assert.equal(result.isComplementary, true);
  });

  it("detects overlap between axes sharing IDs", () => {
    const axes = [
      makeNarrativeAxis("naxis-0", "A", "system", {
        projectIds: ["proj-0", "proj-1"],
        strengthIds: ["str-0"]
      }),
      makeNarrativeAxis("naxis-1", "B", "system", {
        projectIds: ["proj-0", "proj-1"],
        strengthIds: ["str-0"]
      })
    ];
    const result = _computeComplementarity(axes);
    assert.equal(result.maxOverlap, 1); // 100% identical
    assert.equal(result.isComplementary, false);
  });

  it("computes partial overlap correctly", () => {
    const axes = [
      makeNarrativeAxis("naxis-0", "A", "system", {
        projectIds: ["proj-0", "proj-1"],
        strengthIds: []
      }),
      makeNarrativeAxis("naxis-1", "B", "system", {
        projectIds: ["proj-1", "proj-2"],
        strengthIds: []
      })
    ];
    const result = _computeComplementarity(axes);
    // Jaccard: intersection {proj-1} = 1, union {proj-0, proj-1, proj-2} = 3
    // 1/3 ≈ 0.33
    assert.ok(result.maxOverlap > 0.3 && result.maxOverlap < 0.4);
    assert.equal(result.isComplementary, true); // < 0.6
    assert.equal(result.overlapPairs.length, 1);
  });

  it("handles axes with empty ID sets", () => {
    const axes = [
      makeNarrativeAxis("naxis-0", "A", "system", {
        projectIds: [],
        strengthIds: []
      }),
      makeNarrativeAxis("naxis-1", "B", "system", {
        projectIds: [],
        strengthIds: []
      })
    ];
    const result = _computeComplementarity(axes);
    assert.equal(result.maxOverlap, 0);
    assert.equal(result.isComplementary, true);
  });

  it("evaluates all pairwise combinations for 3 axes", () => {
    const axes = [
      makeNarrativeAxis("naxis-0", "A", "system", {
        projectIds: ["proj-0"],
        strengthIds: []
      }),
      makeNarrativeAxis("naxis-1", "B", "system", {
        projectIds: ["proj-0", "proj-1"],
        strengthIds: []
      }),
      makeNarrativeAxis("naxis-2", "C", "system", {
        projectIds: ["proj-2"],
        strengthIds: []
      })
    ];
    const result = _computeComplementarity(axes);
    // Pair (A, B): intersection {proj-0} = 1, union {proj-0, proj-1} = 2 → 0.5
    // Pair (A, C): no overlap → 0
    // Pair (B, C): no overlap → 0
    assert.equal(result.maxOverlap, 0.5);
    assert.equal(result.isComplementary, true); // 0.5 < 0.6
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("narrative axes constants", () => {
  it("TARGET_AXES_MIN is 2", () => {
    assert.equal(TARGET_AXES_MIN, 2);
  });

  it("TARGET_AXES_MAX is 3", () => {
    assert.equal(TARGET_AXES_MAX, 3);
  });
});
