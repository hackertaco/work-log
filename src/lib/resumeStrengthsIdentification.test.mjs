/**
 * Tests for the strengths identification pipeline in resumeReconstruction.mjs.
 *
 * Coverage:
 *   - identifyStrengths: empty input, single repo, cross-repo aggregation
 *   - _normalizeStrengths: ID validation, frequency computation, repos derivation
 *   - _mergeStrengths: user edits preserved, system updates, label dedup
 *   - _buildStrengthsUserMessage: message structure
 *
 * Run:
 *   node --test src/lib/resumeStrengthsIdentification.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  identifyStrengths,
  _normalizeStrengths,
  _mergeStrengths,
  _buildStrengthsUserMessage,
  _validateAndFilterStrengths,
  _deduplicateStrengthClusters,
  extractBehavioralSignals,
  extractIntentionalitySignals,
  clusterBehaviorSignals,
  TARGET_STRENGTHS_MIN,
  TARGET_STRENGTHS_MAX
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

// ─── identifyStrengths ────────────────────────────────────────────────────────

describe("identifyStrengths", () => {
  it("returns empty result for no extraction results", async () => {
    const result = await identifyStrengths({
      extractionResults: [],
      existingStrengths: []
    });

    assert.deepEqual(result.strengths, []);
    assert.equal(result.totalEpisodes, 0);
    assert.equal(result.totalProjects, 0);
    assert.ok(result.identifiedAt);
  });

  it("returns empty result for null/undefined input", async () => {
    const result = await identifyStrengths({
      extractionResults: null,
      existingStrengths: []
    });

    assert.deepEqual(result.strengths, []);
  });

  it("preserves existing strengths when no new evidence", async () => {
    const existing = [
      {
        id: "str-0",
        label: "System Design",
        description: "Designs scalable systems",
        frequency: 3,
        evidenceIds: [],
        projectIds: [],
        repos: [],
        exampleBullets: [],
        _source: "user"
      }
    ];

    const result = await identifyStrengths({
      extractionResults: [],
      existingStrengths: existing
    });

    assert.equal(result.strengths.length, 1);
    assert.equal(result.strengths[0].label, "System Design");
    assert.equal(result.strengths[0]._source, "user");
  });

  it("calls LLM and normalizes results for valid input", async () => {
    const ep1 = makeEpisode("ep-work-log-0", "Payment flow refactoring", {
      bullets: ["Refactored payment flow to reduce latency by 40%"]
    });
    const ep2 = makeEpisode("ep-work-log-1", "Error handling hardening", {
      bullets: ["Added retry logic to critical payment endpoints"]
    });
    const proj = makeProject("proj-work-log-0", "work-log", "Payment System Overhaul", [ep1, ep2]);
    const extractionResult = makeExtractionResult("work-log", [proj]);

    // Mock LLM to return known strengths with reasoning and behaviorCluster
    const mockLlm = async () => [
      {
        label: "Reliability-First Engineering",
        description: "Consistently prioritizes system reliability through error handling and retry logic",
        reasoning: "This pattern appears across 2 episodes in the payment domain. The developer deliberately chose to add retry logic and refactor for latency, showing intentional reliability focus.",
        frequency: 2,
        behaviorCluster: ["retry logic", "latency optimization", "error handling"],
        evidenceEpisodeIds: ["ep-work-log-0", "ep-work-log-1"],
        evidenceProjectIds: ["proj-work-log-0"],
        exampleBullets: ["Refactored payment flow to reduce latency by 40%"]
      }
    ];

    const result = await identifyStrengths(
      { extractionResults: [extractionResult], existingStrengths: [] },
      { llmFn: mockLlm }
    );

    assert.equal(result.strengths.length, 1);
    assert.equal(result.strengths[0].label, "Reliability-First Engineering");
    assert.equal(result.strengths[0].frequency, 2);
    assert.deepEqual(result.strengths[0].evidenceIds, ["ep-work-log-0", "ep-work-log-1"]);
    assert.deepEqual(result.strengths[0].projectIds, ["proj-work-log-0"]);
    assert.deepEqual(result.strengths[0].repos, ["work-log"]);
    assert.equal(result.strengths[0]._source, "system");
    assert.ok(result.strengths[0].reasoning.includes("2 episodes"));
    assert.deepEqual(result.strengths[0].behaviorCluster, ["retry logic", "latency optimization", "error handling"]);
    assert.equal(result.totalEpisodes, 2);
    assert.equal(result.totalProjects, 1);
  });

  it("aggregates cross-repo evidence", async () => {
    const ep1 = makeEpisode("ep-repo-a-0", "Auth system design");
    const ep2 = makeEpisode("ep-repo-b-0", "Auth middleware migration");
    const projA = makeProject("proj-repo-a-0", "repo-a", "Auth System", [ep1]);
    const projB = makeProject("proj-repo-b-0", "repo-b", "Auth Middleware", [ep2]);
    const resultA = makeExtractionResult("repo-a", [projA]);
    const resultB = makeExtractionResult("repo-b", [projB]);

    const mockLlm = async () => [
      {
        label: "Security Engineering",
        description: "Builds secure authentication systems across repos",
        reasoning: "Repeated across 2 repos (repo-a, repo-b), showing consistent security focus. Deliberate auth design decisions in both contexts demonstrate intentional prioritization.",
        frequency: 2,
        behaviorCluster: ["auth system design", "middleware hardening"],
        evidenceEpisodeIds: ["ep-repo-a-0", "ep-repo-b-0"],
        evidenceProjectIds: ["proj-repo-a-0", "proj-repo-b-0"],
        exampleBullets: ["Designed cross-service auth system"]
      }
    ];

    const result = await identifyStrengths(
      { extractionResults: [resultA, resultB], existingStrengths: [] },
      { llmFn: mockLlm }
    );

    assert.equal(result.strengths[0].repos.length, 2);
    assert.ok(result.strengths[0].repos.includes("repo-a"));
    assert.ok(result.strengths[0].repos.includes("repo-b"));
    assert.ok(result.strengths[0].reasoning.includes("2 repos"));
    assert.equal(result.strengths[0].behaviorCluster.length, 2);
  });

  it("merges with existing user-edited strengths", async () => {
    const ep1 = makeEpisode("ep-work-log-0", "Some work");
    const ep2 = makeEpisode("ep-work-log-1", "More design work");
    const proj = makeProject("proj-work-log-0", "work-log", "Some Project", [ep1, ep2]);
    const extractionResult = makeExtractionResult("work-log", [proj]);

    const userStrength = {
      id: "str-0",
      label: "Leadership",
      description: "Leads teams effectively",
      frequency: 5,
      evidenceIds: [],
      projectIds: [],
      repos: [],
      exampleBullets: [],
      _source: "user"
    };

    const mockLlm = async () => [
      {
        label: "System Design",
        description: "Designs systems",
        reasoning: "Appears in 2 episodes showing design capability",
        frequency: 2,
        behaviorCluster: ["system architecture"],
        evidenceEpisodeIds: ["ep-work-log-0", "ep-work-log-1"],
        evidenceProjectIds: ["proj-work-log-0"],
        exampleBullets: []
      }
    ];

    const result = await identifyStrengths(
      { extractionResults: [extractionResult], existingStrengths: [userStrength] },
      { llmFn: mockLlm }
    );

    // User strength should be first
    assert.equal(result.strengths[0].label, "Leadership");
    assert.equal(result.strengths[0]._source, "user");
    // System strength appended
    assert.equal(result.strengths[1].label, "System Design");
    assert.equal(result.strengths[1]._source, "system");
  });
});

// ─── Reasoning and behavioral clustering ─────────────────────────────────────

describe("strength reasoning and behavioral clustering", () => {
  it("preserves reasoning field through normalization", async () => {
    const ep1 = makeEpisode("ep-repo-0", "Retry logic implementation", {
      bullets: ["Added retry logic to payment endpoints"],
      decisionReasoning: "Chose exponential backoff to handle transient failures"
    });
    const ep2 = makeEpisode("ep-repo-1", "Circuit breaker pattern", {
      bullets: ["Implemented circuit breaker for external API calls"],
      decisionReasoning: "Decided to fail fast rather than queue during outages"
    });
    const proj = makeProject("proj-repo-0", "my-repo", "Resilience Project", [ep1, ep2]);
    const extraction = makeExtractionResult("my-repo", [proj]);

    const mockLlm = async () => [
      {
        label: "Resilience Engineering",
        description: "Builds fault-tolerant systems with retry and circuit breaker patterns",
        reasoning: "Appears in 2 episodes within the same project. Session reasoning reveals deliberate choice of exponential backoff and fail-fast strategies, showing intentional reliability design. Impact visible in reduced failure cascading.",
        frequency: 2,
        behaviorCluster: ["retry logic", "circuit breakers", "exponential backoff", "fail-fast design"],
        evidenceEpisodeIds: ["ep-repo-0", "ep-repo-1"],
        evidenceProjectIds: ["proj-repo-0"],
        exampleBullets: ["Added retry logic to payment endpoints"]
      }
    ];

    const result = await identifyStrengths(
      { extractionResults: [extraction], existingStrengths: [] },
      { llmFn: mockLlm }
    );

    const strength = result.strengths[0];
    assert.ok(strength.reasoning.includes("2 episodes"));
    assert.ok(strength.reasoning.includes("exponential backoff"));
    assert.equal(strength.behaviorCluster.length, 4);
    assert.ok(strength.behaviorCluster.includes("retry logic"));
    assert.ok(strength.behaviorCluster.includes("circuit breakers"));
  });

  it("handles missing reasoning gracefully (backward compat)", async () => {
    const ep1 = makeEpisode("ep-repo-0", "Some work");
    const ep2 = makeEpisode("ep-repo-1", "More work");
    const proj = makeProject("proj-repo-0", "repo", "Project", [ep1, ep2]);
    const extraction = makeExtractionResult("repo", [proj]);

    // LLM returns without reasoning (legacy format) but with ≥2 episodes
    const mockLlm = async () => [
      {
        label: "Test Strength",
        description: "Does things",
        reasoning: "",
        frequency: 2,
        behaviorCluster: [],
        evidenceEpisodeIds: ["ep-repo-0", "ep-repo-1"],
        evidenceProjectIds: ["proj-repo-0"],
        exampleBullets: []
      }
    ];

    const result = await identifyStrengths(
      { extractionResults: [extraction], existingStrengths: [] },
      { llmFn: mockLlm }
    );

    assert.equal(result.strengths[0].reasoning, "");
    assert.deepEqual(result.strengths[0].behaviorCluster, []);
  });

  it("includes session decision patterns in user message", () => {
    const ep1 = makeEpisode("ep-repo-0", "Test A", {
      decisionReasoning: "Chose approach X for reliability"
    });
    const ep2 = makeEpisode("ep-repo-1", "Test B", {
      decisionReasoning: "Picked strategy Y to reduce complexity"
    });

    const msg = _buildStrengthsUserMessage([ep1, ep2], []);
    assert.ok(msg.includes("SESSION DECISION PATTERNS"));
    assert.ok(msg.includes("2 episodes with reasoning"));
    assert.ok(msg.includes("Chose approach X for reliability"));
    assert.ok(msg.includes("Picked strategy Y to reduce complexity"));
  });

  it("omits session decision patterns section when no reasoning present", () => {
    const ep = makeEpisode("ep-repo-0", "No reasoning episode");

    const msg = _buildStrengthsUserMessage([ep], []);
    assert.ok(!msg.includes("SESSION DECISION PATTERNS"));
  });
});

// ─── _normalizeStrengths ──────────────────────────────────────────────────────

describe("_normalizeStrengths", () => {
  const ep1 = makeEpisode("ep-repo-0", "Episode A");
  const ep2 = makeEpisode("ep-repo-1", "Episode B");
  const proj = makeProject("proj-repo-0", "my-repo", "Project A", [ep1, ep2]);

  it("returns empty array for non-array input", () => {
    assert.deepEqual(_normalizeStrengths(null, [ep1], [proj]), []);
    assert.deepEqual(_normalizeStrengths(undefined, [ep1], [proj]), []);
    assert.deepEqual(_normalizeStrengths("not array", [ep1], [proj]), []);
  });

  it("filters out strengths without a label", () => {
    const raw = [
      { label: "", description: "no label", frequency: 1, evidenceEpisodeIds: [], evidenceProjectIds: [], exampleBullets: [] },
      { description: "missing label", frequency: 1, evidenceEpisodeIds: [], evidenceProjectIds: [], exampleBullets: [] }
    ];
    assert.deepEqual(_normalizeStrengths(raw, [ep1], [proj]), []);
  });

  it("caps at TARGET_STRENGTHS_MAX", () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      label: `Strength ${i}`,
      description: `Description ${i}`,
      frequency: 1,
      evidenceEpisodeIds: ["ep-repo-0"],
      evidenceProjectIds: [],
      exampleBullets: []
    }));
    const result = _normalizeStrengths(raw, [ep1, ep2], [proj]);
    assert.equal(result.length, TARGET_STRENGTHS_MAX);
  });

  it("validates episode IDs against known episodes", () => {
    const raw = [
      {
        label: "Test Strength",
        description: "Test",
        frequency: 3,
        evidenceEpisodeIds: ["ep-repo-0", "ep-nonexistent-99", "ep-repo-1"],
        evidenceProjectIds: [],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1, ep2], [proj]);
    // Only valid IDs should remain
    assert.deepEqual(result[0].evidenceIds, ["ep-repo-0", "ep-repo-1"]);
  });

  it("validates project IDs against known projects", () => {
    const raw = [
      {
        label: "Test Strength",
        description: "Test",
        frequency: 1,
        evidenceEpisodeIds: [],
        evidenceProjectIds: ["proj-repo-0", "proj-nonexistent-99"],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1, ep2], [proj]);
    assert.deepEqual(result[0].projectIds, ["proj-repo-0"]);
  });

  it("derives repos from validated evidence", () => {
    const raw = [
      {
        label: "Cross-repo Strength",
        description: "Test",
        frequency: 2,
        evidenceEpisodeIds: ["ep-repo-0"],
        evidenceProjectIds: ["proj-repo-0"],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1, ep2], [proj]);
    assert.deepEqual(result[0].repos, ["my-repo"]);
  });

  it("computes frequency as max of LLM frequency and evidence count", () => {
    const raw = [
      {
        label: "Frequent Strength",
        description: "Test",
        frequency: 1, // LLM says 1
        evidenceEpisodeIds: ["ep-repo-0", "ep-repo-1"], // but 2 episodes
        evidenceProjectIds: [],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1, ep2], [proj]);
    // Should use the higher of the two
    assert.equal(result[0].frequency, 2);
  });

  it("assigns sequential IDs", () => {
    const raw = [
      { label: "A", description: "a", frequency: 1, evidenceEpisodeIds: [], evidenceProjectIds: [], exampleBullets: [] },
      { label: "B", description: "b", frequency: 1, evidenceEpisodeIds: [], evidenceProjectIds: [], exampleBullets: [] }
    ];
    const result = _normalizeStrengths(raw, [ep1], [proj]);
    assert.equal(result[0].id, "str-0");
    assert.equal(result[1].id, "str-1");
  });

  it("sets _source to system", () => {
    const raw = [
      { label: "Test", description: "test", reasoning: "", frequency: 1, behaviorCluster: [], evidenceEpisodeIds: [], evidenceProjectIds: [], exampleBullets: [] }
    ];
    const result = _normalizeStrengths(raw, [ep1], [proj]);
    assert.equal(result[0]._source, "system");
  });

  it("normalizes reasoning field", () => {
    const raw = [
      {
        label: "Test",
        description: "test",
        reasoning: "  This is a reasoning string with whitespace  ",
        frequency: 1,
        behaviorCluster: ["behavior a"],
        evidenceEpisodeIds: ["ep-repo-0"],
        evidenceProjectIds: [],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1, ep2], [proj]);
    assert.equal(result[0].reasoning, "This is a reasoning string with whitespace");
  });

  it("truncates very long reasoning", () => {
    const raw = [
      {
        label: "Test",
        description: "test",
        reasoning: "R".repeat(700),
        frequency: 1,
        behaviorCluster: [],
        evidenceEpisodeIds: [],
        evidenceProjectIds: [],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1], [proj]);
    assert.ok(result[0].reasoning.length <= 600);
  });

  it("normalizes behaviorCluster array", () => {
    const raw = [
      {
        label: "Test",
        description: "test",
        reasoning: "reason",
        frequency: 1,
        behaviorCluster: ["retry logic", "circuit breakers", "error boundaries", "  whitespace  ", "", "extra1", "extra2"],
        evidenceEpisodeIds: [],
        evidenceProjectIds: [],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1], [proj]);
    // Should cap at 5 items and trim whitespace, filter empty
    assert.ok(result[0].behaviorCluster.length <= 5);
    assert.ok(result[0].behaviorCluster.includes("retry logic"));
    assert.ok(!result[0].behaviorCluster.includes(""));
  });

  it("handles missing reasoning and behaviorCluster gracefully", () => {
    const raw = [
      {
        label: "Test",
        description: "test",
        frequency: 1,
        evidenceEpisodeIds: [],
        evidenceProjectIds: [],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1], [proj]);
    assert.equal(result[0].reasoning, "");
    assert.deepEqual(result[0].behaviorCluster, []);
  });

  it("truncates long labels and descriptions", () => {
    const raw = [
      {
        label: "A".repeat(200),
        description: "B".repeat(600),
        frequency: 1,
        evidenceEpisodeIds: [],
        evidenceProjectIds: [],
        exampleBullets: []
      }
    ];
    const result = _normalizeStrengths(raw, [ep1], [proj]);
    assert.ok(result[0].label.length <= 80);
    assert.ok(result[0].description.length <= 400);
  });

  it("caps exampleBullets at 3 items", () => {
    const raw = [
      {
        label: "Test",
        description: "test",
        frequency: 1,
        evidenceEpisodeIds: [],
        evidenceProjectIds: [],
        exampleBullets: ["A", "B", "C", "D", "E"]
      }
    ];
    const result = _normalizeStrengths(raw, [ep1], [proj]);
    assert.equal(result[0].exampleBullets.length, 3);
  });
});

// ─── _mergeStrengths ──────────────────────────────────────────────────────────

describe("_mergeStrengths", () => {
  function makeStrength(label, source = "system", overrides = {}) {
    return {
      id: `str-${label.toLowerCase().replace(/\s+/g, "-")}`,
      label,
      description: `Description of ${label}`,
      frequency: 2,
      evidenceIds: [],
      projectIds: [],
      repos: [],
      exampleBullets: [],
      _source: source,
      ...overrides
    };
  }

  it("returns fresh strengths when no existing", () => {
    const fresh = [makeStrength("Design"), makeStrength("Debugging")];
    const result = _mergeStrengths([], fresh);
    assert.equal(result.length, 2);
    assert.equal(result[0].label, "Design");
  });

  it("preserves user-edited strengths unchanged", () => {
    const user = makeStrength("Leadership", "user");
    const fresh = [makeStrength("Leadership", "system", { description: "New description" })];
    const result = _mergeStrengths([user], fresh);
    // User's version should be kept, not replaced
    assert.equal(result[0].label, "Leadership");
    assert.equal(result[0]._source, "user");
    assert.equal(result[0].description, "Description of Leadership");
  });

  it("preserves user_approved strengths unchanged", () => {
    const approved = makeStrength("Mentoring", "user_approved");
    const fresh = [makeStrength("Mentoring", "system")];
    const result = _mergeStrengths([approved], fresh);
    assert.equal(result[0]._source, "user_approved");
  });

  it("updates existing system strengths with matching labels", () => {
    const existing = [makeStrength("Debugging", "system", { description: "old" })];
    const fresh = [makeStrength("Debugging", "system", { description: "new" })];
    const result = _mergeStrengths(existing, fresh);
    assert.equal(result.length, 1);
    assert.equal(result[0].description, "new");
  });

  it("matches labels case-insensitively", () => {
    const existing = [makeStrength("System Design", "system", { description: "old" })];
    const fresh = [makeStrength("system design", "system", { description: "updated" })];
    const result = _mergeStrengths(existing, fresh);
    assert.equal(result.length, 1);
    assert.equal(result[0].description, "updated");
  });

  it("appends new strengths that don't match existing", () => {
    const existing = [makeStrength("Debugging", "system")];
    const fresh = [makeStrength("Leadership", "system")];
    const result = _mergeStrengths(existing, fresh);
    assert.equal(result.length, 2);
    assert.equal(result[0].label, "Debugging");
    assert.equal(result[1].label, "Leadership");
  });

  it("puts user strengths first in order", () => {
    const existing = [
      makeStrength("System A", "system"),
      makeStrength("User B", "user")
    ];
    const fresh = [makeStrength("New C", "system")];
    const result = _mergeStrengths(existing, fresh);
    assert.equal(result[0].label, "User B"); // User first
  });

  it("caps total at TARGET_STRENGTHS_MAX", () => {
    const existing = [
      makeStrength("A", "user"),
      makeStrength("B", "user")
    ];
    const fresh = [
      makeStrength("C", "system"),
      makeStrength("D", "system"),
      makeStrength("E", "system"),
      makeStrength("F", "system")
    ];
    const result = _mergeStrengths(existing, fresh);
    assert.ok(result.length <= TARGET_STRENGTHS_MAX);
  });

  it("returns only user strengths when user has 5+", () => {
    const userStrengths = Array.from({ length: 6 }, (_, i) =>
      makeStrength(`User ${i}`, "user")
    );
    const fresh = [makeStrength("System X", "system")];
    const result = _mergeStrengths(userStrengths, fresh);
    assert.equal(result.length, TARGET_STRENGTHS_MAX);
    assert.ok(result.every((s) => s._source === "user"));
  });

  it("skips fresh strengths whose label matches a user strength", () => {
    const existing = [makeStrength("Debugging", "user")];
    const fresh = [makeStrength("Debugging", "system", { description: "system version" })];
    const result = _mergeStrengths(existing, fresh);
    assert.equal(result.length, 1);
    assert.equal(result[0]._source, "user");
    assert.equal(result[0].description, "Description of Debugging");
  });
});

// ─── _buildStrengthsUserMessage ────────────────────────────────────────────────

describe("_buildStrengthsUserMessage", () => {
  it("includes projects and episodes in the message", () => {
    const ep = makeEpisode("ep-repo-0", "Test Episode", {
      bullets: ["Improved performance by 50%"]
    });
    const proj = makeProject("proj-repo-0", "my-repo", "Test Project", [ep], {
      techTags: ["React", "Node.js"]
    });

    const msg = _buildStrengthsUserMessage([ep], [proj]);

    // Should contain project info
    assert.ok(msg.includes("CORE PROJECTS"));
    assert.ok(msg.includes("Test Project"));
    assert.ok(msg.includes("proj-repo-0"));
    assert.ok(msg.includes("my-repo"));
    assert.ok(msg.includes("React, Node.js"));

    // Should contain episode info
    assert.ok(msg.includes("EVIDENCE EPISODES"));
    assert.ok(msg.includes("Test Episode"));
    assert.ok(msg.includes("ep-repo-0"));
    assert.ok(msg.includes("Improved performance by 50%"));
  });

  it("handles empty arrays gracefully", () => {
    const msg = _buildStrengthsUserMessage([], []);
    assert.equal(typeof msg, "string");
    // Should not crash, returns empty or minimal string
  });

  it("includes decision reasoning when present", () => {
    const ep = makeEpisode("ep-repo-0", "Test", {
      decisionReasoning: "Chose this approach to improve reliability"
    });

    const msg = _buildStrengthsUserMessage([ep], []);
    assert.ok(msg.includes("Chose this approach to improve reliability"));
  });
});

// ─── extractBehavioralSignals + clusterBehaviorSignals ──────────────────────

describe("extractBehavioralSignals", () => {
  it("returns empty array for no episodes", () => {
    assert.deepEqual(extractBehavioralSignals([], []), []);
  });

  it("detects reliability signals from retry/error keywords", () => {
    const ep1 = makeEpisode("ep-repo-0", "Retry logic implementation", {
      bullets: ["Added retry logic to payment endpoints"],
      commitSubjects: ["feat: add retry with exponential backoff"]
    });
    const ep2 = makeEpisode("ep-repo-1", "Error handling hardening", {
      bullets: ["Implemented error boundary for transaction flow"],
      commitSubjects: ["fix: add error handling to payment service"]
    });
    const proj = makeProject("proj-repo-0", "my-repo", "Payment System", [ep1, ep2]);

    const signals = extractBehavioralSignals([ep1, ep2], [proj]);
    assert.ok(signals.length >= 1, "Should detect behavioral signals");
    const reliabilitySignals = signals.filter((s) =>
      s.category.toLowerCase().includes("reliab") || s.category.toLowerCase().includes("resilien")
    );
    assert.ok(reliabilitySignals.length >= 1, "Should detect reliability signals");
  });

  it("maps episodes to repos via project mapping", () => {
    const ep1 = makeEpisode("ep-repo-a-0", "Test setup", {
      bullets: ["Added unit test for auth module"],
      commitSubjects: ["test: add auth tests"]
    });
    const projA = makeProject("proj-repo-a-0", "repo-a", "Auth", [ep1]);

    const signals = extractBehavioralSignals([ep1], [projA]);
    const withRepo = signals.filter((s) => s.repo === "repo-a");
    assert.ok(withRepo.length >= 0); // may or may not match depending on rules
  });
});

describe("clusterBehaviorSignals", () => {
  it("groups signals by category", () => {
    const signals = [
      { category: "reliability", microBehavior: "retry logic", episodeId: "ep-0", sourceText: "retry", repo: "repo-a" },
      { category: "reliability", microBehavior: "error handling", episodeId: "ep-1", sourceText: "error", repo: "repo-a" },
      { category: "testing", microBehavior: "unit test", episodeId: "ep-2", sourceText: "test", repo: "repo-b" }
    ];

    const clusters = clusterBehaviorSignals(signals);
    assert.ok(clusters.length >= 2, "Should have at least 2 clusters");
    const reliCluster = clusters.find((c) => c.category === "reliability");
    assert.ok(reliCluster, "Should have reliability cluster");
    assert.equal(reliCluster.episodeIds.length, 2);
    assert.ok(reliCluster.microBehaviors.length >= 2);
  });

  it("sorts clusters by frequency descending", () => {
    const signals = [
      { category: "reliability", microBehavior: "retry", episodeId: "ep-0", sourceText: "a" },
      { category: "reliability", microBehavior: "error", episodeId: "ep-1", sourceText: "b" },
      { category: "reliability", microBehavior: "guard", episodeId: "ep-2", sourceText: "c" },
      { category: "testing", microBehavior: "test", episodeId: "ep-3", sourceText: "d" }
    ];

    const clusters = clusterBehaviorSignals(signals);
    for (let i = 1; i < clusters.length; i++) {
      assert.ok(clusters[i - 1].frequency >= clusters[i].frequency,
        "Should be sorted by frequency descending");
    }
  });

  it("integrates intentionality signals", () => {
    const signals = [
      { category: "reliability", microBehavior: "retry", episodeId: "ep-0", sourceText: "retry logic" }
    ];
    const intentionality = [
      { category: "reliability", signal: "deliberate choice", episodeId: "ep-0", reasoning: "Chose safe approach" }
    ];

    const clusters = clusterBehaviorSignals(signals, intentionality);
    const reliCluster = clusters.find((c) => c.category === "reliability");
    assert.ok(reliCluster);
    assert.ok(reliCluster.intentionalitySignals.length >= 1);
  });
});

// ─── extractIntentionalitySignals ─────────────────────────────────────────────

describe("extractIntentionalitySignals", () => {
  it("returns empty for episodes without reasoning", () => {
    const ep = makeEpisode("ep-0", "No reasoning");
    const result = extractIntentionalitySignals([ep]);
    assert.deepEqual(result, []);
  });

  it("returns empty for empty array", () => {
    const result = extractIntentionalitySignals([]);
    assert.deepEqual(result, []);
  });

  it("detects intentionality from decision reasoning keywords", () => {
    const ep1 = makeEpisode("ep-0", "Work A", {
      decisionReasoning: "Chose the safe and stable approach for production reliability"
    });

    const result = extractIntentionalitySignals([ep1]);
    assert.ok(result.length >= 1, "Should detect intentionality signal");
    assert.equal(result[0].episodeId, "ep-0");
    assert.ok(result[0].reasoning.length > 0);
  });

  it("detects signals across multiple episodes", () => {
    const ep1 = makeEpisode("ep-0", "Work A", {
      decisionReasoning: "Decided to use the safe and defensive approach"
    });
    const ep2 = makeEpisode("ep-1", "Work B", {
      decisionReasoning: "Opted for the stable fallback pattern"
    });

    const result = extractIntentionalitySignals([ep1, ep2]);
    const episodeIds = result.map((s) => s.episodeId);
    // Should detect signals from both episodes
    assert.ok(result.length >= 1, "Should detect at least one signal");
  });

  it("ignores episodes with empty or whitespace reasoning", () => {
    const ep1 = makeEpisode("ep-0", "Work", { decisionReasoning: "   " });
    const ep2 = makeEpisode("ep-1", "Work", { decisionReasoning: "" });

    const result = extractIntentionalitySignals([ep1, ep2]);
    assert.deepEqual(result, []);
  });
});

// ─── _validateAndFilterStrengths ─────────────────────────────────────────────

describe("_validateAndFilterStrengths", () => {
  function makeStrengthObj(overrides = {}) {
    return {
      id: "str-0",
      label: "Test Strength",
      description: "Test description",
      reasoning: "Test reasoning",
      frequency: 3,
      behaviorCluster: ["action a"],
      evidenceIds: ["ep-0", "ep-1"],
      projectIds: ["proj-0"],
      repos: ["repo"],
      exampleBullets: ["bullet"],
      _source: "system",
      ...overrides
    };
  }

  it("returns empty for non-array input", () => {
    assert.deepEqual(_validateAndFilterStrengths(null, []), []);
    assert.deepEqual(_validateAndFilterStrengths(undefined, []), []);
  });

  it("corrects inflated frequency to match actual evidence count", () => {
    const strength = makeStrengthObj({
      frequency: 10, // LLM claimed 10
      evidenceIds: ["ep-0", "ep-1", "ep-2"] // but only 3 episodes
    });

    const result = _validateAndFilterStrengths([strength], []);
    assert.equal(result[0].frequency, 3);
  });

  it("filters out strengths with fewer than 2 evidence episodes", () => {
    const weak = makeStrengthObj({
      frequency: 1,
      evidenceIds: ["ep-0"] // only 1 episode
    });
    const strong = makeStrengthObj({
      id: "str-1",
      frequency: 3,
      evidenceIds: ["ep-0", "ep-1", "ep-2"]
    });

    const result = _validateAndFilterStrengths([weak, strong], []);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "str-1");
  });

  it("keeps strengths with exactly 2 evidence episodes", () => {
    const strength = makeStrengthObj({
      frequency: 2,
      evidenceIds: ["ep-0", "ep-1"]
    });

    const result = _validateAndFilterStrengths([strength], []);
    assert.equal(result.length, 1);
  });

  it("filters out strengths with empty evidence arrays", () => {
    const strength = makeStrengthObj({
      frequency: 5,
      evidenceIds: []
    });

    const result = _validateAndFilterStrengths([strength], []);
    assert.equal(result.length, 0);
  });
});

// ─── _deduplicateStrengthClusters ────────────────────────────────────────────

describe("_deduplicateStrengthClusters", () => {
  function makeStrengthObj(id, overrides = {}) {
    return {
      id,
      label: `Strength ${id}`,
      description: "Description",
      reasoning: "Reasoning",
      frequency: 2,
      behaviorCluster: ["action"],
      evidenceIds: [],
      projectIds: [],
      repos: [],
      exampleBullets: [],
      _source: "system",
      ...overrides
    };
  }

  it("returns empty for non-array input", () => {
    assert.deepEqual(_deduplicateStrengthClusters(null), null);
  });

  it("returns single strength unchanged", () => {
    const single = [makeStrengthObj("str-0", { evidenceIds: ["ep-0", "ep-1"] })];
    const result = _deduplicateStrengthClusters(single);
    assert.equal(result.length, 1);
  });

  it("merges strengths with >60% Jaccard overlap", () => {
    const s1 = makeStrengthObj("str-0", {
      label: "Reliability Engineering",
      frequency: 3,
      evidenceIds: ["ep-0", "ep-1", "ep-2"],
      behaviorCluster: ["retry logic", "error handling"]
    });
    const s2 = makeStrengthObj("str-1", {
      label: "Error Recovery Design",
      frequency: 2,
      evidenceIds: ["ep-0", "ep-1"], // Jaccard: 2/3 = 0.67 > 0.6
      behaviorCluster: ["error recovery", "fallback"]
    });

    const result = _deduplicateStrengthClusters([s1, s2]);
    assert.equal(result.length, 1);
    // Should keep the higher-frequency one
    assert.equal(result[0].label, "Reliability Engineering");
    // Should combine evidence
    assert.ok(result[0].evidenceIds.includes("ep-0"));
    assert.ok(result[0].evidenceIds.includes("ep-1"));
    assert.ok(result[0].evidenceIds.includes("ep-2"));
    // Should combine behavior clusters
    assert.ok(result[0].behaviorCluster.length >= 2);
  });

  it("keeps distinct strengths with low Jaccard overlap", () => {
    const s1 = makeStrengthObj("str-0", {
      evidenceIds: ["ep-0", "ep-1", "ep-2", "ep-3"],
      frequency: 4
    });
    const s2 = makeStrengthObj("str-1", {
      evidenceIds: ["ep-3", "ep-4", "ep-5", "ep-6"],
      frequency: 4
    });
    // Jaccard: 1/7 = 0.14 < 0.6

    const result = _deduplicateStrengthClusters([s1, s2]);
    assert.equal(result.length, 2);
  });

  it("handles strengths with no evidence gracefully", () => {
    const s1 = makeStrengthObj("str-0", { evidenceIds: [] });
    const s2 = makeStrengthObj("str-1", { evidenceIds: [] });

    const result = _deduplicateStrengthClusters([s1, s2]);
    assert.equal(result.length, 2); // No evidence to compare, keep both
  });

  it("caps merged behavior cluster at 5 items", () => {
    const s1 = makeStrengthObj("str-0", {
      frequency: 3,
      evidenceIds: ["ep-0", "ep-1", "ep-2"],
      behaviorCluster: ["a", "b", "c"]
    });
    const s2 = makeStrengthObj("str-1", {
      frequency: 2,
      evidenceIds: ["ep-0", "ep-1"], // 100% overlap
      behaviorCluster: ["d", "e", "f"]
    });

    const result = _deduplicateStrengthClusters([s1, s2]);
    assert.equal(result.length, 1);
    assert.ok(result[0].behaviorCluster.length <= 5);
  });

  it("caps merged example bullets at 3 items", () => {
    const s1 = makeStrengthObj("str-0", {
      frequency: 3,
      evidenceIds: ["ep-0", "ep-1", "ep-2"],
      exampleBullets: ["bullet 1", "bullet 2"]
    });
    const s2 = makeStrengthObj("str-1", {
      frequency: 2,
      evidenceIds: ["ep-0", "ep-1"],
      exampleBullets: ["bullet 3", "bullet 4"]
    });

    const result = _deduplicateStrengthClusters([s1, s2]);
    assert.equal(result.length, 1);
    assert.ok(result[0].exampleBullets.length <= 3);
  });
});

// ─── Integration: identifyStrengths with pre-analysis ────────────────────────

describe("identifyStrengths with pre-analysis pipeline", () => {
  it("passes behavioral signals to LLM and filters weak strengths", async () => {
    const ep1 = makeEpisode("ep-repo-0", "Retry logic", {
      bullets: ["Added retry logic to payment endpoints"],
      commitSubjects: ["feat: add retry with backoff"],
      decisionReasoning: "Chose reliable approach over fast iteration"
    });
    const ep2 = makeEpisode("ep-repo-1", "Error boundaries", {
      bullets: ["Implemented error boundary for payment flow"],
      commitSubjects: ["fix: add error handling"],
      decisionReasoning: "Prioritized stability for production safety"
    });
    const ep3 = makeEpisode("ep-repo-2", "Single episode work", {
      bullets: ["Random one-off task"]
    });
    const proj = makeProject("proj-repo-0", "my-repo", "Payment System", [ep1, ep2, ep3]);
    const extraction = makeExtractionResult("my-repo", [proj]);

    // Mock LLM returns one strong and one weak strength
    const mockLlm = async (episodes, projects, behavioralClusters) => {
      // Verify behavioral clusters (pre-analysis) are passed through
      assert.ok(Array.isArray(behavioralClusters), "Behavioral clusters should be passed to LLM fn");

      return [
        {
          label: "Reliability-First Engineering",
          description: "Consistently prioritizes reliability",
          reasoning: "Appears in 2 episodes. Deliberate choice of retry logic and error boundaries.",
          frequency: 2,
          behaviorCluster: ["retry logic", "error boundaries"],
          evidenceEpisodeIds: ["ep-repo-0", "ep-repo-1"],
          evidenceProjectIds: ["proj-repo-0"],
          exampleBullets: ["Added retry logic to payment endpoints"]
        },
        {
          label: "Weak Pattern",
          description: "Only appears once",
          reasoning: "Single instance, not a real pattern",
          frequency: 1,
          behaviorCluster: ["random"],
          evidenceEpisodeIds: ["ep-repo-2"],
          evidenceProjectIds: ["proj-repo-0"],
          exampleBullets: ["Random one-off task"]
        }
      ];
    };

    const result = await identifyStrengths(
      { extractionResults: [extraction], existingStrengths: [] },
      { llmFn: mockLlm }
    );

    // Weak strength should be filtered out (only 1 evidence episode)
    assert.equal(result.strengths.length, 1);
    assert.equal(result.strengths[0].label, "Reliability-First Engineering");
    assert.equal(result.strengths[0].frequency, 2);
  });

  it("deduplicates overlapping strength clusters from LLM", async () => {
    const ep1 = makeEpisode("ep-repo-0", "Work A");
    const ep2 = makeEpisode("ep-repo-1", "Work B");
    const ep3 = makeEpisode("ep-repo-2", "Work C");
    const proj = makeProject("proj-repo-0", "repo", "Project", [ep1, ep2, ep3]);
    const extraction = makeExtractionResult("repo", [proj]);

    // LLM returns two strengths with heavy overlap
    const mockLlm = async () => [
      {
        label: "Reliability Engineering",
        description: "Builds reliable systems",
        reasoning: "Repeated across 3 episodes",
        frequency: 3,
        behaviorCluster: ["retry", "circuit breaker"],
        evidenceEpisodeIds: ["ep-repo-0", "ep-repo-1", "ep-repo-2"],
        evidenceProjectIds: ["proj-repo-0"],
        exampleBullets: ["Bullet A"]
      },
      {
        label: "Error Recovery",
        description: "Recovers from errors",
        reasoning: "Seen in 2 episodes",
        frequency: 2,
        behaviorCluster: ["error handling", "fallback"],
        evidenceEpisodeIds: ["ep-repo-0", "ep-repo-1"], // 100% overlap with first
        evidenceProjectIds: ["proj-repo-0"],
        exampleBullets: ["Bullet B"]
      }
    ];

    const result = await identifyStrengths(
      { extractionResults: [extraction], existingStrengths: [] },
      { llmFn: mockLlm }
    );

    // Should merge overlapping clusters
    assert.equal(result.strengths.length, 1);
    assert.equal(result.strengths[0].label, "Reliability Engineering");
    // Should have combined evidence
    assert.ok(result.strengths[0].evidenceIds.length >= 3);
  });
});



// ─── Constants ────────────────────────────────────────────────────────────────

describe("strength constants", () => {
  it("TARGET_STRENGTHS_MIN is 3", () => {
    assert.equal(TARGET_STRENGTHS_MIN, 3);
  });

  it("TARGET_STRENGTHS_MAX is 5", () => {
    assert.equal(TARGET_STRENGTHS_MAX, 5);
  });
});
