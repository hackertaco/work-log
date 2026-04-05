/**
 * Unit tests for anti-fragmentation logic (AC 5)
 *
 * Tests that sections are not over-fragmented to the point of wholesale deletion.
 * Covers episode consolidation, project consolidation, and experience/project
 * thin-section handling in reconstruction.
 *
 * Run with:
 *   node --test src/lib/resumeAntiFragmentation.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  _consolidateEpisodes,
  _consolidateProjects,
  MIN_EPISODE_COMMITS,
  MIN_PROJECT_BULLETS,
  MAX_EPISODES_PER_REPO,
} from "./resumeRecluster.mjs";

import {
  consolidateThinExperience,
  consolidateThinProjects,
} from "./resumeReconstruction.mjs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEpisode(overrides = {}) {
  return {
    id: "ep-test-0",
    title: "Test episode",
    summary: "A test episode",
    dates: ["2025-01-01"],
    commitSubjects: ["feat: initial commit", "fix: bug fix"],
    bullets: ["Implemented feature X", "Fixed critical bug Y"],
    decisionReasoning: null,
    topicTag: "general",
    moduleTag: "general",
    ...overrides,
  };
}

function makeThinEpisode(overrides = {}) {
  return makeEpisode({
    commitSubjects: ["fix: typo"],
    bullets: ["Fixed a typo"],
    ...overrides,
  });
}

function makeProject(overrides = {}) {
  return {
    id: "proj-test-0",
    repo: "test-repo",
    title: "Test Project",
    description: "A test project",
    episodes: [],
    bullets: ["Designed system X", "Implemented feature Y"],
    techTags: ["React", "Node.js"],
    dateRange: "Jan 2025",
    _source: "system",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Episode Consolidation
// ═══════════════════════════════════════════════════════════════════════════════

describe("_consolidateEpisodes", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(_consolidateEpisodes([], "repo"), []);
  });

  it("returns single episode unchanged", () => {
    const ep = makeEpisode({ id: "ep-repo-0" });
    const result = _consolidateEpisodes([ep], "repo");
    assert.equal(result.length, 1);
    assert.equal(result[0].title, ep.title);
  });

  it("merges thin episode into substantial sibling with same topicTag", () => {
    const substantial = makeEpisode({
      id: "ep-repo-0",
      topicTag: "auth",
      commitSubjects: ["feat: auth flow", "fix: token refresh"],
      bullets: ["Built auth flow", "Fixed token refresh"],
    });
    const thin = makeThinEpisode({
      id: "ep-repo-1",
      topicTag: "auth",
      commitSubjects: ["fix: auth typo"],
      bullets: ["Fixed auth typo"],
    });

    const result = _consolidateEpisodes([substantial, thin], "repo");
    assert.equal(result.length, 1, "Thin episode should be merged");
    assert.ok(
      result[0].commitSubjects.length >= 2,
      "Merged episode should have combined commits"
    );
    assert.ok(
      result[0].bullets.length >= 2,
      "Merged episode should have combined bullets"
    );
  });

  it("keeps thin episode when no substantial siblings exist", () => {
    const thin1 = makeThinEpisode({ id: "ep-repo-0", topicTag: "a" });
    const thin2 = makeThinEpisode({ id: "ep-repo-1", topicTag: "b" });

    const result = _consolidateEpisodes([thin1, thin2], "repo");
    // All thin → returned as-is (nothing substantial to merge into triggers fallback)
    assert.ok(result.length >= 1);
  });

  it("does not merge substantial episodes", () => {
    const ep1 = makeEpisode({ id: "ep-repo-0", topicTag: "auth" });
    const ep2 = makeEpisode({ id: "ep-repo-1", topicTag: "payments" });

    const result = _consolidateEpisodes([ep1, ep2], "repo");
    assert.equal(result.length, 2, "Both substantial episodes should remain");
  });

  it("enforces MAX_EPISODES_PER_REPO by merging thinnest", () => {
    // Create MAX + 2 substantial episodes
    const episodes = [];
    for (let i = 0; i < MAX_EPISODES_PER_REPO + 2; i++) {
      episodes.push(
        makeEpisode({
          id: `ep-repo-${i}`,
          topicTag: `topic-${i}`,
          commitSubjects: [`feat: commit ${i}`, `fix: fix ${i}`],
          bullets: [`Built feature ${i}`, `Fixed issue ${i}`],
        })
      );
    }

    const result = _consolidateEpisodes(episodes, "repo");
    assert.ok(
      result.length <= MAX_EPISODES_PER_REPO,
      `Should have at most ${MAX_EPISODES_PER_REPO} episodes, got ${result.length}`
    );
  });

  it("re-indexes episode IDs after consolidation", () => {
    const substantial = makeEpisode({
      id: "ep-repo-5",
      topicTag: "auth",
    });
    const thin = makeThinEpisode({
      id: "ep-repo-9",
      topicTag: "auth",
    });

    const result = _consolidateEpisodes([substantial, thin], "repo");
    assert.equal(result[0].id, "ep-repo-0", "IDs should be re-indexed");
  });

  it("deduplicates bullets when merging", () => {
    const substantial = makeEpisode({
      topicTag: "auth",
      bullets: ["Built auth flow"],
    });
    const thin = makeThinEpisode({
      topicTag: "auth",
      bullets: ["Built auth flow"], // Duplicate
    });

    const result = _consolidateEpisodes([substantial, thin], "repo");
    assert.equal(result.length, 1);
    // Should not have duplicate bullets
    const bulletSet = new Set(result[0].bullets.map((b) => b.toLowerCase()));
    assert.equal(bulletSet.size, result[0].bullets.length, "No duplicate bullets");
  });

  it("merges thin episode into nearest by moduleTag when topicTag differs", () => {
    const ep1 = makeEpisode({
      id: "ep-repo-0",
      topicTag: "auth",
      moduleTag: "backend/api",
    });
    const ep2 = makeEpisode({
      id: "ep-repo-1",
      topicTag: "payments",
      moduleTag: "backend/payments",
    });
    const thin = makeThinEpisode({
      id: "ep-repo-2",
      topicTag: "config",
      moduleTag: "backend/api", // Matches ep1's moduleTag
    });

    const result = _consolidateEpisodes([ep1, ep2, thin], "repo");
    assert.equal(result.length, 2, "Thin should be merged, leaving 2 episodes");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Project Consolidation (recluster pipeline)
// ═══════════════════════════════════════════════════════════════════════════════

describe("_consolidateProjects", () => {
  it("returns empty for empty input", () => {
    assert.deepEqual(_consolidateProjects([], "repo"), []);
  });

  it("returns single project unchanged", () => {
    const proj = makeProject({ bullets: ["One bullet"] });
    const result = _consolidateProjects([proj], "repo");
    assert.equal(result.length, 1);
  });

  it("merges single-bullet project into substantial sibling", () => {
    const strong = makeProject({
      id: "proj-repo-0",
      bullets: ["Built system X", "Deployed to prod"],
      techTags: ["React"],
    });
    const weak = makeProject({
      id: "proj-repo-1",
      bullets: ["Fixed minor UI bug"],
      techTags: ["React"],
    });

    const result = _consolidateProjects([strong, weak], "repo");
    assert.equal(result.length, 1, "Weak project should be merged");
    assert.ok(
      result[0].bullets.length >= 3,
      "Merged project should have combined bullets"
    );
  });

  it("merges all thin projects into strongest when none are substantial", () => {
    const p1 = makeProject({ bullets: ["Bullet A"] });
    const p2 = makeProject({ bullets: ["Bullet B"] });
    const p3 = makeProject({ bullets: ["Bullet C"] });

    const result = _consolidateProjects([p1, p2, p3], "repo");
    assert.equal(result.length, 1, "All thin projects should merge into one");
    assert.ok(result[0].bullets.length >= 3);
  });

  it("re-indexes project IDs after consolidation", () => {
    const strong = makeProject({ id: "proj-repo-5" });
    const weak = makeProject({
      id: "proj-repo-9",
      bullets: ["One bullet"],
    });

    const result = _consolidateProjects([strong, weak], "repo");
    assert.equal(result[0].id, "proj-repo-0");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Experience Consolidation (reconstruction)
// ═══════════════════════════════════════════════════════════════════════════════

describe("consolidateThinExperience", () => {
  it("returns empty for empty input", () => {
    assert.deepEqual(consolidateThinExperience([]), []);
  });

  it("removes experience entries with zero bullets", () => {
    const entries = [
      { company: "Acme", title: "Engineer", bullets: [] },
      { company: "Beta", title: "Dev", bullets: ["Built feature X", "Deployed Y"] },
    ];
    const result = consolidateThinExperience(entries);
    assert.equal(result.length, 1);
    assert.equal(result[0].company, "Beta");
  });

  it("merges single-bullet entries at same company into strongest entry", () => {
    const entries = [
      {
        company: "Acme Corp",
        title: "Senior Engineer",
        bullets: ["Led team of 5", "Built microservices", "Improved latency 40%"],
        _source: "system",
      },
      {
        company: "Acme Corp",
        title: "Engineer",
        bullets: ["Fixed a deployment bug"],
        _source: "system",
      },
    ];
    const result = consolidateThinExperience(entries);
    assert.equal(result.length, 1, "Single-bullet entry should be merged");
    assert.ok(
      result[0].bullets.length >= 4,
      "Merged entry should have combined bullets"
    );
  });

  it("keeps multi-bullet entries at same company separate", () => {
    const entries = [
      {
        company: "Acme Corp",
        title: "Senior Engineer",
        bullets: ["Led team", "Built systems"],
      },
      {
        company: "Acme Corp",
        title: "Junior Engineer",
        bullets: ["Wrote tests", "Fixed bugs"],
      },
    ];
    const result = consolidateThinExperience(entries);
    assert.equal(result.length, 2, "Both multi-bullet entries should remain");
  });

  it("preserves ordering from original input", () => {
    const entries = [
      { company: "First Co", title: "Dev", bullets: ["A", "B"] },
      { company: "Second Co", title: "Dev", bullets: ["C", "D"] },
      { company: "Third Co", title: "Dev", bullets: ["E", "F"] },
    ];
    const result = consolidateThinExperience(entries);
    assert.equal(result[0].company, "First Co");
    assert.equal(result[1].company, "Second Co");
    assert.equal(result[2].company, "Third Co");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Project Consolidation (reconstruction)
// ═══════════════════════════════════════════════════════════════════════════════

describe("consolidateThinProjects (reconstruction)", () => {
  it("returns empty for empty input", () => {
    assert.deepEqual(consolidateThinProjects([]), []);
  });

  it("removes projects with zero bullets", () => {
    const projects = [
      { name: "Project A", bullets: [] },
      { name: "Project B", bullets: ["Built X", "Deployed Y"] },
    ];
    const result = consolidateThinProjects(projects);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Project B");
  });

  it("merges single-bullet project into most related sibling", () => {
    const projects = [
      { name: "API Gateway", bullets: ["Designed gateway", "Implemented caching"] },
      { name: "API Monitor", bullets: ["Added health check"] },
    ];
    const result = consolidateThinProjects(projects);
    assert.equal(result.length, 1, "Single-bullet project should be merged");
    // "API" is the matching word
    assert.ok(result[0].bullets.length >= 3);
  });

  it("returns single project unchanged even if thin", () => {
    const projects = [{ name: "Solo", bullets: ["One bullet"] }];
    const result = consolidateThinProjects(projects);
    assert.equal(result.length, 1);
  });

  it("does not merge substantial projects", () => {
    const projects = [
      { name: "Frontend", bullets: ["Built UI", "Added tests"] },
      { name: "Backend", bullets: ["Built API", "Added auth"] },
    ];
    const result = consolidateThinProjects(projects);
    assert.equal(result.length, 2);
  });
});
