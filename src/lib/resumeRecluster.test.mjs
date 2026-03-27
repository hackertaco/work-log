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
  DEFAULT_RECLUSTER_THRESHOLD
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
