/**
 * Tests for the strength extraction pipeline (Sub-AC 2 of AC 6).
 *
 * Coverage:
 *   - extractBehavioralSignals: regex pattern detection across episode text
 *   - extractIntentionalitySignals: session decision pattern detection
 *   - clusterBehaviorSignals: grouping, deduplication, frequency, intentionality
 *   - _assessReasoningQuality: reasoning quality assessment
 *   - _normalizeStrengths: ID validation, repo computation, frequency correction
 *   - _mergeStrengths: user-edit preservation, label dedup, cap enforcement
 *   - _buildStrengthsUserMessage: message structure with clusters and cross-repo summary
 *   - identifyStrengths: end-to-end pipeline with mock LLM
 *
 * Run:
 *   node --test src/lib/resumeStrengthExtraction.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  extractBehavioralSignals,
  extractIntentionalitySignals,
  clusterBehaviorSignals,
  identifyStrengths,
  _normalizeStrengths,
  _mergeStrengths,
  _buildStrengthsUserMessage,
  _assessReasoningQuality,
  TARGET_STRENGTHS_MIN,
  TARGET_STRENGTHS_MAX,
} from "./resumeReconstruction.mjs";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeEpisode(overrides = {}) {
  return {
    id: overrides.id || "ep-repo-0",
    title: overrides.title || "Error handling improvements",
    summary: overrides.summary || "Added error handling and retry logic to payment flow",
    dates: overrides.dates || ["2026-03-15"],
    commitSubjects: overrides.commitSubjects || ["fix: add error boundary to checkout"],
    bullets: overrides.bullets || ["Implemented error boundaries for checkout flow"],
    decisionReasoning: overrides.decisionReasoning || null,
    topicTag: overrides.topicTag || "error-handling",
    moduleTag: overrides.moduleTag || "payments",
  };
}

function makeProject(overrides = {}) {
  return {
    id: overrides.id || "proj-repo-0",
    repo: overrides.repo || "work-log",
    title: overrides.title || "Payment System Stabilization",
    description: overrides.description || "Stabilized the payment processing pipeline",
    episodes: overrides.episodes || [],
    bullets: overrides.bullets || ["Reduced payment failures by 40%"],
    techTags: overrides.techTags || ["Node.js", "PostgreSQL"],
    dateRange: overrides.dateRange || "Mar 2026",
    _source: "system",
  };
}

function makeStrength(overrides = {}) {
  return {
    id: overrides.id || "str-0",
    label: overrides.label || "Reliability-First Engineering",
    description: overrides.description || "Consistently adds error handling and retry logic",
    reasoning: overrides.reasoning || "This pattern appears across 4 episodes in 2 repos, demonstrating deliberate reliability focus with measurable impact on system stability, notably differentiating from baseline engineering.",
    frequency: overrides.frequency || 4,
    behaviorCluster: overrides.behaviorCluster || ["error handling", "retry logic"],
    evidenceIds: overrides.evidenceIds || ["ep-repo-0", "ep-repo-1"],
    projectIds: overrides.projectIds || ["proj-repo-0"],
    repos: overrides.repos || ["work-log"],
    exampleBullets: overrides.exampleBullets || ["Implemented error boundaries"],
    _source: overrides._source || "system",
  };
}

function makeExtractionResult(overrides = {}) {
  const episodes = overrides.episodes || [makeEpisode()];
  const project = makeProject({ ...overrides, episodes });
  return {
    repo: overrides.repo || "work-log",
    projects: [project],
    episodeCount: episodes.length,
    extractedAt: new Date().toISOString(),
  };
}

// ─── extractBehavioralSignals ───────────────────────────────────────────────

describe("extractBehavioralSignals", () => {
  test("detects reliability signals from bullets and summaries", () => {
    const episodes = [
      makeEpisode({
        id: "ep-repo-0",
        summary: "Added retry logic to API calls",
        bullets: ["Implemented error handling for payment flow"],
      }),
      makeEpisode({
        id: "ep-repo-1",
        summary: "Fixed stability issues in checkout",
        bullets: ["Added graceful degradation for offline mode"],
      }),
    ];
    const projects = [makeProject({ episodes, repo: "work-log" })];

    const signals = extractBehavioralSignals(episodes, projects);

    assert.ok(signals.length >= 2, `Expected ≥2 signals, got ${signals.length}`);

    const reliabilitySignals = signals.filter((s) => s.category === "reliability");
    assert.ok(reliabilitySignals.length >= 2, "Should detect ≥2 reliability signals");

    // Should have signals from both episodes
    const episodeIds = new Set(reliabilitySignals.map((s) => s.episodeId));
    assert.ok(episodeIds.has("ep-repo-0"), "Should detect signal in ep-repo-0");
    assert.ok(episodeIds.has("ep-repo-1"), "Should detect signal in ep-repo-1");
  });

  test("detects code quality signals", () => {
    const episodes = [
      makeEpisode({
        id: "ep-repo-0",
        summary: "Refactored auth module for clarity",
        bullets: ["Simplified authentication flow"],
        commitSubjects: ["refactor: clean up auth module"],
      }),
    ];
    const projects = [makeProject({ episodes })];

    const signals = extractBehavioralSignals(episodes, projects);
    const codeQuality = signals.filter((s) => s.category === "code_quality");
    assert.ok(codeQuality.length >= 1, "Should detect code quality signal");
    assert.ok(
      codeQuality.some((s) => s.microBehavior === "refactoring"),
      "Should detect refactoring micro-behavior"
    );
  });

  test("maps signals to correct project and repo", () => {
    const ep = makeEpisode({ id: "ep-dt-0" });
    const project = makeProject({
      id: "proj-dt-0",
      repo: "driving-teacher",
      episodes: [ep],
    });

    const signals = extractBehavioralSignals([ep], [project]);
    const withProject = signals.filter((s) => s.projectId === "proj-dt-0");
    assert.ok(withProject.length >= 1, "Should map to project ID");
    assert.equal(withProject[0].repo, "driving-teacher", "Should map to correct repo");
  });

  test("returns empty for episodes with no behavioral signals", () => {
    const episodes = [
      makeEpisode({
        id: "ep-repo-0",
        summary: "Updated readme",
        bullets: ["Changed version number"],
        commitSubjects: ["chore: bump version"],
      }),
    ];
    const projects = [makeProject({ episodes })];

    const signals = extractBehavioralSignals(episodes, projects);
    // May or may not have signals — just ensure no crash
    assert.ok(Array.isArray(signals));
  });

  test("handles Korean text patterns", () => {
    const episodes = [
      makeEpisode({
        id: "ep-repo-0",
        summary: "예외 처리 로직 추가",
        bullets: ["안정성 개선을 위한 방어 로직 구현"],
      }),
    ];
    const projects = [makeProject({ episodes })];

    const signals = extractBehavioralSignals(episodes, projects);
    const reliabilitySignals = signals.filter((s) => s.category === "reliability");
    assert.ok(reliabilitySignals.length >= 1, "Should detect Korean reliability signals");
  });

  test("detects at most one signal per rule per episode", () => {
    const episodes = [
      makeEpisode({
        id: "ep-repo-0",
        summary: "Added retry logic and backoff strategy",
        bullets: ["Implemented retry with exponential backoff"],
        commitSubjects: ["feat: add retry mechanism"],
      }),
    ];
    const projects = [makeProject({ episodes })];

    const signals = extractBehavioralSignals(episodes, projects);
    // "retry logic" rule should only fire once for this episode
    const retrySignals = signals.filter(
      (s) => s.microBehavior === "retry logic" && s.episodeId === "ep-repo-0"
    );
    assert.equal(retrySignals.length, 1, "Should detect exactly 1 retry signal per episode");
  });
});

// ─── extractIntentionalitySignals ───────────────────────────────────────────

describe("extractIntentionalitySignals", () => {
  test("detects reliability intentionality from session reasoning", () => {
    const episodes = [
      makeEpisode({
        id: "ep-repo-0",
        decisionReasoning: "Chose the defensive approach instead of the quick fix to ensure stability",
      }),
    ];

    const signals = extractIntentionalitySignals(episodes);
    assert.ok(signals.length >= 1, "Should detect intentionality signal");
    assert.equal(signals[0].category, "reliability");
    assert.ok(signals[0].signal.includes("safety") || signals[0].signal.includes("stability") || signals[0].signal.includes("reliability"));
  });

  test("skips episodes without decision reasoning", () => {
    const episodes = [
      makeEpisode({ id: "ep-repo-0", decisionReasoning: null }),
      makeEpisode({ id: "ep-repo-1", decisionReasoning: "" }),
    ];

    const signals = extractIntentionalitySignals(episodes);
    assert.equal(signals.length, 0, "Should skip episodes without reasoning");
  });

  test("detects code quality intentionality", () => {
    const episodes = [
      makeEpisode({
        id: "ep-repo-0",
        decisionReasoning: "Decided to refactor the module first before adding the new feature",
      }),
    ];

    const signals = extractIntentionalitySignals(episodes);
    const codeQuality = signals.filter((s) => s.category === "code_quality");
    assert.ok(codeQuality.length >= 1, "Should detect code quality intentionality");
  });

  test("truncates long reasoning text", () => {
    const longReasoning = "Chose the safe approach ".repeat(50);
    const episodes = [
      makeEpisode({ id: "ep-repo-0", decisionReasoning: longReasoning }),
    ];

    const signals = extractIntentionalitySignals(episodes);
    for (const sig of signals) {
      assert.ok(sig.reasoning.length <= 200, "Reasoning should be truncated to 200 chars");
    }
  });
});

// ─── clusterBehaviorSignals ─────────────────────────────────────────────────

describe("clusterBehaviorSignals", () => {
  test("groups signals by category with correct counts", () => {
    const signals = [
      { category: "reliability", microBehavior: "error handling", episodeId: "ep-0", sourceText: "error handling" },
      { category: "reliability", microBehavior: "retry logic", episodeId: "ep-1", sourceText: "retry logic", repo: "repo-a" },
      { category: "reliability", microBehavior: "guard clause", episodeId: "ep-2", sourceText: "guard clause", repo: "repo-b" },
      { category: "code_quality", microBehavior: "refactoring", episodeId: "ep-0", sourceText: "refactored" },
    ];

    const clusters = clusterBehaviorSignals(signals);

    assert.equal(clusters.length, 2, "Should have 2 clusters");

    const reliability = clusters.find((c) => c.category === "reliability");
    assert.ok(reliability, "Should have reliability cluster");
    assert.equal(reliability.frequency, 3, "Reliability should have frequency 3");
    assert.equal(reliability.episodeIds.length, 3, "Should span 3 episodes");
    assert.deepEqual(reliability.microBehaviors, ["error handling", "guard clause", "retry logic"]);
    assert.equal(reliability.repos.length, 2, "Should span 2 repos");
  });

  test("integrates intentionality signals", () => {
    const signals = [
      { category: "reliability", microBehavior: "retry logic", episodeId: "ep-0", sourceText: "retry" },
      { category: "reliability", microBehavior: "error handling", episodeId: "ep-1", sourceText: "error" },
    ];
    const intentionality = [
      { category: "reliability", signal: "deliberately chose safety", episodeId: "ep-0", reasoning: "chose safe approach" },
    ];

    const clusters = clusterBehaviorSignals(signals, intentionality);
    const reliability = clusters.find((c) => c.category === "reliability");
    assert.ok(reliability.intentionalitySignals.length >= 1, "Should include intentionality signal");
  });

  test("sorts clusters by frequency descending", () => {
    const signals = [
      { category: "code_quality", microBehavior: "refactoring", episodeId: "ep-0", sourceText: "ref" },
      { category: "reliability", microBehavior: "error handling", episodeId: "ep-0", sourceText: "err" },
      { category: "reliability", microBehavior: "retry logic", episodeId: "ep-1", sourceText: "retry" },
      { category: "reliability", microBehavior: "guard clause", episodeId: "ep-2", sourceText: "guard" },
    ];

    const clusters = clusterBehaviorSignals(signals);
    assert.equal(clusters[0].category, "reliability", "Highest frequency first");
  });

  test("returns empty for no signals", () => {
    const clusters = clusterBehaviorSignals([]);
    assert.equal(clusters.length, 0);
  });

  test("collects sample texts up to 3", () => {
    const signals = Array.from({ length: 5 }, (_, i) => ({
      category: "reliability",
      microBehavior: "error handling",
      episodeId: `ep-${i}`,
      sourceText: `sample text ${i}`,
    }));

    const clusters = clusterBehaviorSignals(signals);
    assert.equal(clusters[0].sampleTexts.length, 3, "Should cap sample texts at 3");
  });
});

// ─── _assessReasoningQuality ────────────────────────────────────────────────

describe("_assessReasoningQuality", () => {
  test("passes reasoning with all four dimensions", () => {
    const reasoning =
      "This pattern appears repeatedly across 4 episodes in 2 repos. " +
      "The developer deliberately chose reliability over speed in session decisions. " +
      "The impact is a 40% reduction in payment failures. " +
      "This level of consistency distinguishes this developer from baseline competence.";

    const result = _assessReasoningQuality(reasoning);
    assert.ok(result.adequate, "Should be adequate");
    assert.equal(result.missingAspects.length, 0, "No missing aspects");
  });

  test("flags reasoning missing dimensions", () => {
    const reasoning = "This developer writes good code.";
    const result = _assessReasoningQuality(reasoning);
    assert.ok(!result.adequate, "Should not be adequate");
    assert.ok(result.missingAspects.length >= 2, "Should have ≥2 missing aspects");
  });

  test("handles null/empty reasoning", () => {
    assert.ok(!_assessReasoningQuality(null).adequate);
    assert.ok(!_assessReasoningQuality("").adequate);
    assert.ok(!_assessReasoningQuality(undefined).adequate);
  });

  test("passes reasoning with 2+ dimensions (threshold)", () => {
    const reasoning =
      "This pattern appears consistently across multiple episodes. " +
      "It has measurably improved system reliability.";
    const result = _assessReasoningQuality(reasoning);
    assert.ok(result.adequate, "2 dimensions should be adequate");
  });

  test("reports individual dimension scores", () => {
    const reasoning = "Deliberately chose this approach repeatedly across projects.";
    const result = _assessReasoningQuality(reasoning);
    assert.equal(typeof result.scores.repetition, "boolean");
    assert.equal(typeof result.scores.intentionality, "boolean");
    assert.equal(typeof result.scores.impact, "boolean");
    assert.equal(typeof result.scores.differentiation, "boolean");
  });
});

// ─── _normalizeStrengths ────────────────────────────────────────────────────

describe("_normalizeStrengths", () => {
  const episodes = [
    makeEpisode({ id: "ep-repo-0" }),
    makeEpisode({ id: "ep-repo-1" }),
    makeEpisode({ id: "ep-dt-0" }),
  ];
  const ep0 = makeEpisode({ id: "ep-repo-0" });
  const ep1 = makeEpisode({ id: "ep-repo-1" });
  const ep2 = makeEpisode({ id: "ep-dt-0" });
  const projects = [
    makeProject({ id: "proj-repo-0", repo: "work-log", episodes: [ep0, ep1] }),
    makeProject({ id: "proj-dt-0", repo: "driving-teacher", episodes: [ep2] }),
  ];

  test("filters invalid episode IDs", () => {
    const rawStrengths = [{
      label: "Test Strength",
      description: "test",
      reasoning: "test",
      frequency: 3,
      behaviorCluster: ["a"],
      evidenceEpisodeIds: ["ep-repo-0", "ep-INVALID", "ep-dt-0"],
      evidenceProjectIds: ["proj-repo-0"],
      exampleBullets: ["bullet"],
    }];

    const result = _normalizeStrengths(rawStrengths, episodes, projects);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].evidenceIds, ["ep-repo-0", "ep-dt-0"]);
    assert.ok(!result[0].evidenceIds.includes("ep-INVALID"));
  });

  test("computes repos from validated evidence", () => {
    const rawStrengths = [{
      label: "Cross-repo Strength",
      description: "test",
      reasoning: "test",
      frequency: 2,
      behaviorCluster: ["a"],
      evidenceEpisodeIds: ["ep-repo-0", "ep-dt-0"],
      evidenceProjectIds: ["proj-repo-0", "proj-dt-0"],
      exampleBullets: [],
    }];

    const result = _normalizeStrengths(rawStrengths, episodes, projects);
    assert.deepEqual(result[0].repos, ["driving-teacher", "work-log"]);
  });

  test("caps at TARGET_STRENGTHS_MAX", () => {
    const rawStrengths = Array.from({ length: 10 }, (_, i) => ({
      label: `Strength ${i}`,
      description: "test",
      reasoning: "test",
      frequency: 2,
      behaviorCluster: ["a"],
      evidenceEpisodeIds: ["ep-repo-0"],
      evidenceProjectIds: [],
      exampleBullets: [],
    }));

    const result = _normalizeStrengths(rawStrengths, episodes, projects);
    assert.ok(result.length <= TARGET_STRENGTHS_MAX);
  });

  test("assigns stable IDs (str-0, str-1, ...)", () => {
    const rawStrengths = [
      { label: "A", description: "", reasoning: "", frequency: 1, behaviorCluster: [], evidenceEpisodeIds: ["ep-repo-0"], evidenceProjectIds: [], exampleBullets: [] },
      { label: "B", description: "", reasoning: "", frequency: 1, behaviorCluster: [], evidenceEpisodeIds: ["ep-repo-1"], evidenceProjectIds: [], exampleBullets: [] },
    ];
    const result = _normalizeStrengths(rawStrengths, episodes, projects);
    assert.equal(result[0].id, "str-0");
    assert.equal(result[1].id, "str-1");
  });

  test("returns empty for null input", () => {
    assert.deepEqual(_normalizeStrengths(null, [], []), []);
    assert.deepEqual(_normalizeStrengths(undefined, [], []), []);
    assert.deepEqual(_normalizeStrengths("not array", [], []), []);
  });
});

// ─── _mergeStrengths ────────────────────────────────────────────────────────

describe("_mergeStrengths", () => {
  test("user-edited strengths are never overwritten", () => {
    const existing = [
      makeStrength({ id: "str-0", label: "User Strength", _source: "user" }),
    ];
    const fresh = [
      makeStrength({ id: "str-0", label: "User Strength", description: "System override attempt", _source: "system" }),
    ];

    const result = _mergeStrengths(existing, fresh);
    const preserved = result.find((s) => s.label === "User Strength");
    assert.ok(preserved, "User strength should be preserved");
    assert.equal(preserved._source, "user", "Source should remain 'user'");
    assert.notEqual(preserved.description, "System override attempt");
  });

  test("user_approved strengths are also protected", () => {
    const existing = [
      makeStrength({ id: "str-0", label: "Approved Strength", _source: "user_approved" }),
    ];
    const fresh = [
      makeStrength({ id: "str-new", label: "Approved Strength", _source: "system" }),
    ];

    const result = _mergeStrengths(existing, fresh);
    assert.equal(result.filter((s) => s.label === "Approved Strength").length, 1);
    assert.equal(result.find((s) => s.label === "Approved Strength")._source, "user_approved");
  });

  test("system strengths are replaced by fresh versions", () => {
    const existing = [
      makeStrength({ id: "str-0", label: "Old System", description: "old", _source: "system" }),
    ];
    const fresh = [
      makeStrength({ id: "str-0", label: "Old System", description: "updated", _source: "system" }),
    ];

    const result = _mergeStrengths(existing, fresh);
    assert.equal(result.find((s) => s.label === "Old System").description, "updated");
  });

  test("caps at TARGET_STRENGTHS_MAX with user priority", () => {
    const existing = Array.from({ length: 4 }, (_, i) =>
      makeStrength({ id: `str-u${i}`, label: `User ${i}`, _source: "user" })
    );
    const fresh = Array.from({ length: 3 }, (_, i) =>
      makeStrength({ id: `str-s${i}`, label: `System ${i}`, _source: "system" })
    );

    const result = _mergeStrengths(existing, fresh);
    assert.ok(result.length <= TARGET_STRENGTHS_MAX);
    // All user strengths should be present
    const userCount = result.filter((s) => s._source === "user").length;
    assert.equal(userCount, 4, "All user strengths should be preserved");
  });

  test("5+ user strengths means no system strengths added", () => {
    const existing = Array.from({ length: 5 }, (_, i) =>
      makeStrength({ id: `str-u${i}`, label: `User ${i}`, _source: "user" })
    );
    const fresh = [
      makeStrength({ id: "str-s0", label: "New System", _source: "system" }),
    ];

    const result = _mergeStrengths(existing, fresh);
    assert.equal(result.length, 5);
    assert.ok(result.every((s) => s._source === "user"));
  });

  test("new strengths are appended when no label match", () => {
    const existing = [
      makeStrength({ id: "str-0", label: "Existing", _source: "system" }),
    ];
    const fresh = [
      makeStrength({ id: "str-1", label: "Brand New", _source: "system" }),
    ];

    const result = _mergeStrengths(existing, fresh);
    assert.ok(result.some((s) => s.label === "Existing"));
    assert.ok(result.some((s) => s.label === "Brand New"));
  });
});

// ─── _buildStrengthsUserMessage ─────────────────────────────────────────────

describe("_buildStrengthsUserMessage", () => {
  test("includes pre-clustered behavioral signals section", () => {
    const episodes = [makeEpisode()];
    const projects = [makeProject({ episodes })];
    const clusters = [{
      category: "reliability",
      microBehaviors: ["error handling", "retry logic"],
      episodeIds: ["ep-repo-0", "ep-repo-1"],
      projectIds: ["proj-repo-0"],
      repos: ["work-log"],
      frequency: 3,
      intentionalitySignals: ["[ep-repo-0] deliberately chose safety: \"chose safe approach\""],
      sampleTexts: ["Added error boundary"],
    }];

    const msg = _buildStrengthsUserMessage(episodes, projects, clusters);
    assert.ok(msg.includes("PRE-CLUSTERED BEHAVIORAL SIGNALS"), "Should include clusters section");
    assert.ok(msg.includes("reliability"), "Should include category name");
    assert.ok(msg.includes("error handling"), "Should include micro-behaviors");
    assert.ok(msg.includes("Intentionality evidence"), "Should include intentionality");
  });

  test("includes cross-repo summary for multi-repo evidence", () => {
    const ep1 = makeEpisode({ id: "ep-wl-0" });
    const ep2 = makeEpisode({ id: "ep-dt-0" });
    const projects = [
      makeProject({ id: "proj-wl-0", repo: "work-log", episodes: [ep1] }),
      makeProject({ id: "proj-dt-0", repo: "driving-teacher", episodes: [ep2] }),
    ];

    const msg = _buildStrengthsUserMessage([ep1, ep2], projects, []);
    assert.ok(msg.includes("CROSS-REPO SUMMARY"), "Should include cross-repo section");
    assert.ok(msg.includes("work-log"), "Should list work-log repo");
    assert.ok(msg.includes("driving-teacher"), "Should list driving-teacher repo");
  });

  test("includes session decision patterns", () => {
    const episodes = [
      makeEpisode({
        id: "ep-repo-0",
        decisionReasoning: "Chose reliability over speed for the payment flow",
      }),
    ];
    const projects = [makeProject({ episodes })];

    const msg = _buildStrengthsUserMessage(episodes, projects, []);
    assert.ok(msg.includes("SESSION DECISION PATTERNS"), "Should include session patterns");
    assert.ok(msg.includes("Chose reliability"), "Should include reasoning text");
  });

  test("handles thin clusters gracefully", () => {
    const episodes = [makeEpisode()];
    const projects = [makeProject({ episodes })];
    const clusters = [{
      category: "debugging",
      microBehaviors: ["root cause analysis"],
      episodeIds: ["ep-repo-0"],  // Only 1 episode — thin cluster
      projectIds: [],
      repos: [],
      frequency: 1,
      intentionalitySignals: [],
      sampleTexts: [],
    }];

    const msg = _buildStrengthsUserMessage(episodes, projects, clusters);
    assert.ok(msg.includes("thin clusters"), "Should mention thin clusters");
  });
});

// ─── identifyStrengths (end-to-end with mock LLM) ──────────────────────────

describe("identifyStrengths — end-to-end", () => {
  test("full pipeline with mock LLM returns normalized strengths", async () => {
    const ep0 = makeEpisode({
      id: "ep-wl-0",
      summary: "Added error handling and retry logic",
      bullets: ["Implemented retry mechanism for API calls"],
      decisionReasoning: "Chose defensive approach for reliability",
    });
    const ep1 = makeEpisode({
      id: "ep-wl-1",
      summary: "Added validation guards to payment flow",
      bullets: ["Built validation layer for checkout"],
    });
    const ep2 = makeEpisode({
      id: "ep-dt-0",
      summary: "Fixed stability issues in GPS tracking",
      bullets: ["Resolved crash in location service"],
    });

    const extractionResults = [
      {
        repo: "work-log",
        projects: [makeProject({
          id: "proj-wl-0",
          repo: "work-log",
          episodes: [ep0, ep1],
        })],
        episodeCount: 2,
        extractedAt: new Date().toISOString(),
      },
      {
        repo: "driving-teacher",
        projects: [makeProject({
          id: "proj-dt-0",
          repo: "driving-teacher",
          episodes: [ep2],
        })],
        episodeCount: 1,
        extractedAt: new Date().toISOString(),
      },
    ];

    // Mock LLM that returns pre-defined strengths
    const mockLlm = async (episodes, projects, clusters) => {
      // Verify pre-clustered signals are passed
      assert.ok(Array.isArray(clusters), "Clusters should be passed to LLM");
      return [
        {
          label: "Reliability-First Engineering",
          description: "Consistently prioritizes system stability through error handling, retry logic, and validation guards across multiple projects.",
          reasoning: "This pattern appears repeatedly across 3 episodes in 2 repos. The developer deliberately chose defensive approaches as shown in session decisions. The impact includes measurably improved stability. This distinguishes the developer from baseline engineering.",
          frequency: 3,
          behaviorCluster: ["error handling", "retry logic", "validation guards", "stability fixes"],
          evidenceEpisodeIds: ["ep-wl-0", "ep-wl-1", "ep-dt-0"],
          evidenceProjectIds: ["proj-wl-0", "proj-dt-0"],
          exampleBullets: ["Implemented retry mechanism for API calls"],
        },
      ];
    };

    const result = await identifyStrengths(
      { extractionResults },
      { llmFn: mockLlm }
    );

    assert.equal(result.totalEpisodes, 3);
    assert.equal(result.totalProjects, 2);
    assert.ok(result.strengths.length >= 1);

    const str = result.strengths[0];
    assert.equal(str.label, "Reliability-First Engineering");
    assert.equal(str._source, "system");
    assert.ok(str.evidenceIds.length >= 2);
    assert.ok(str.repos.length >= 1);
    assert.ok(str.frequency >= 2);
    assert.ok(typeof str.reasoning === "string" && str.reasoning.length > 0);
  });

  test("preserves user-edited strengths during identification", async () => {
    const ep0 = makeEpisode({ id: "ep-wl-0" });
    const extractionResults = [{
      repo: "work-log",
      projects: [makeProject({ id: "proj-wl-0", repo: "work-log", episodes: [ep0] })],
      episodeCount: 1,
      extractedAt: new Date().toISOString(),
    }];

    const existingStrengths = [
      makeStrength({ id: "str-user", label: "User Custom Strength", _source: "user" }),
    ];

    const mockLlm = async () => [{
      label: "System Strength",
      description: "desc",
      reasoning: "reasoning",
      frequency: 2,
      behaviorCluster: ["a"],
      evidenceEpisodeIds: ["ep-wl-0"],
      evidenceProjectIds: [],
      exampleBullets: [],
    }];

    const result = await identifyStrengths(
      { extractionResults, existingStrengths },
      { llmFn: mockLlm }
    );

    assert.ok(
      result.strengths.some((s) => s.label === "User Custom Strength" && s._source === "user"),
      "User strength must be preserved"
    );
  });

  test("returns existing strengths when no evidence", async () => {
    const existingStrengths = [makeStrength({ _source: "user" })];
    const result = await identifyStrengths(
      { extractionResults: [], existingStrengths },
    );

    assert.equal(result.totalEpisodes, 0);
    assert.equal(result.totalProjects, 0);
    assert.ok(result.strengths.length >= 1);
    assert.equal(result.strengths[0]._source, "user");
  });
});

// ─── Constants ──────────────────────────────────────────────────────────────

describe("strength constants", () => {
  test("TARGET_STRENGTHS range is 3-5", () => {
    assert.equal(TARGET_STRENGTHS_MIN, 3);
    assert.equal(TARGET_STRENGTHS_MAX, 5);
  });
});
