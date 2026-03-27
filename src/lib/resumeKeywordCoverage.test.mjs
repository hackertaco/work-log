/**
 * Unit tests for resumeKeywordCoverage.mjs
 *
 * Run with: node --test src/lib/resumeKeywordCoverage.test.mjs
 * (Node.js built-in test runner — no external dependencies)
 *
 * Coverage:
 *   - getUnclassifiedKeywords()       — pure helper
 *   - computeUnclassifiedRatio()      — pure helper
 *   - exceedsUnclassifiedThreshold()  — pure helper, threshold check
 *   - DEFAULT_UNCLASSIFIED_THRESHOLD  — constant value
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  getUnclassifiedKeywords,
  computeUnclassifiedRatio,
  exceedsUnclassifiedThreshold,
  DEFAULT_UNCLASSIFIED_THRESHOLD
} from "./resumeKeywordCoverage.mjs";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeAxes(overrides = []) {
  return [
    { id: "ax1", label: "Frontend", keywords: ["React", "TypeScript", "Vite"] },
    { id: "ax2", label: "Backend", keywords: ["Node.js", "Hono", "GraphQL"] },
    ...overrides
  ];
}

// ─── DEFAULT_UNCLASSIFIED_THRESHOLD ───────────────────────────────────────────

describe("DEFAULT_UNCLASSIFIED_THRESHOLD", () => {
  test("is a number", () => {
    assert.equal(typeof DEFAULT_UNCLASSIFIED_THRESHOLD, "number");
  });

  test("equals 0.3", () => {
    assert.equal(DEFAULT_UNCLASSIFIED_THRESHOLD, 0.3);
  });
});

// ─── getUnclassifiedKeywords — guard clauses ──────────────────────────────────

describe("getUnclassifiedKeywords — guard clauses", () => {
  test("returns [] when allKeywords is null", () => {
    assert.deepEqual(getUnclassifiedKeywords(null, makeAxes()), []);
  });

  test("returns [] when allKeywords is not an array", () => {
    assert.deepEqual(getUnclassifiedKeywords("React", makeAxes()), []);
  });

  test("returns [] when allKeywords is empty array", () => {
    assert.deepEqual(getUnclassifiedKeywords([], makeAxes()), []);
  });

  test("treats null axes as empty axes", () => {
    const result = getUnclassifiedKeywords(["React", "Docker"], null);
    // No axes → all keywords are unclassified
    assert.deepEqual(result, ["React", "Docker"]);
  });

  test("treats non-array axes as empty axes", () => {
    const result = getUnclassifiedKeywords(["React", "Docker"], "bad");
    assert.deepEqual(result, ["React", "Docker"]);
  });

  test("treats empty axes array as no coverage", () => {
    const result = getUnclassifiedKeywords(["React", "Docker"], []);
    assert.deepEqual(result, ["React", "Docker"]);
  });
});

// ─── getUnclassifiedKeywords — basic behaviour ────────────────────────────────

describe("getUnclassifiedKeywords — basic behaviour", () => {
  test("returns keywords not present in any axis", () => {
    const allKeywords = ["React", "Docker", "Kubernetes"];
    const axes = [{ keywords: ["React"] }];
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, ["Docker", "Kubernetes"]);
  });

  test("returns empty array when all keywords are classified", () => {
    const allKeywords = ["React", "Node.js"];
    const axes = makeAxes(); // React, TypeScript, Vite, Node.js, Hono, GraphQL
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, []);
  });

  test("returns all keywords when no axis has any of them", () => {
    const allKeywords = ["Rust", "Go", "Zig"];
    const axes = makeAxes(); // only React/TS/Vite/Node.js/Hono/GraphQL
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, ["Rust", "Go", "Zig"]);
  });

  test("comparison is case-insensitive (keyword in pool matches axis keyword)", () => {
    const allKeywords = ["react", "docker"];
    const axes = [{ keywords: ["React"] }]; // "React" covers "react"
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, ["docker"]);
  });

  test("comparison is case-insensitive (axis keyword matches pool keyword)", () => {
    const allKeywords = ["React", "Docker"];
    const axes = [{ keywords: ["REACT"] }]; // "REACT" covers "React"
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, ["Docker"]);
  });

  test("deduplicates input keywords before comparison", () => {
    const allKeywords = ["React", "react", "REACT", "Docker"];
    const axes = [{ keywords: ["Docker"] }];
    // "React" (first occurrence) is unclassified; duplicates are collapsed
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.equal(result.length, 1);
    assert.equal(result[0], "React"); // first occurrence preserved
  });

  test("preserves original casing from first occurrence", () => {
    const allKeywords = ["typeScript", "TypeScript", "TYPESCRIPT"];
    const result = getUnclassifiedKeywords(allKeywords, []);
    assert.equal(result.length, 1);
    assert.equal(result[0], "typeScript"); // first occurrence
  });

  test("skips non-string entries in allKeywords", () => {
    const allKeywords = ["React", null, 42, undefined, "Docker"];
    const axes = [{ keywords: ["React"] }];
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, ["Docker"]);
  });

  test("skips empty/whitespace-only strings in allKeywords", () => {
    const allKeywords = ["React", "", "  ", "Docker"];
    const axes = [{ keywords: ["React"] }];
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, ["Docker"]);
  });

  test("skips non-object or keywordless axis entries gracefully", () => {
    const allKeywords = ["React", "Docker"];
    const axes = [
      null,
      "bad-axis",
      { label: "No keywords" }, // missing keywords field
      { keywords: "not-array" },
      { keywords: ["React"] }
    ];
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, ["Docker"]);
  });

  test("keyword spread across multiple axes is fully classified", () => {
    const allKeywords = ["React", "Node.js", "Docker"];
    const axes = [
      { keywords: ["React"] },
      { keywords: ["Node.js"] },
      { keywords: ["Docker"] }
    ];
    const result = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(result, []);
  });
});

// ─── computeUnclassifiedRatio — guard clauses ─────────────────────────────────

describe("computeUnclassifiedRatio — guard clauses", () => {
  test("returns 0 when allKeywords is null", () => {
    assert.equal(computeUnclassifiedRatio(null, makeAxes()), 0);
  });

  test("returns 0 when allKeywords is not an array", () => {
    assert.equal(computeUnclassifiedRatio("React", makeAxes()), 0);
  });

  test("returns 0 when allKeywords is empty", () => {
    assert.equal(computeUnclassifiedRatio([], makeAxes()), 0);
  });
});

// ─── computeUnclassifiedRatio — basic behaviour ───────────────────────────────

describe("computeUnclassifiedRatio — basic behaviour", () => {
  test("returns 1.0 when all keywords are unclassified (no axes)", () => {
    const ratio = computeUnclassifiedRatio(["React", "Docker"], []);
    assert.equal(ratio, 1.0);
  });

  test("returns 0.0 when all keywords are classified", () => {
    const allKeywords = ["React", "Node.js"];
    const axes = makeAxes(); // React + Node.js both covered
    const ratio = computeUnclassifiedRatio(allKeywords, axes);
    assert.equal(ratio, 0.0);
  });

  test("returns correct ratio for partial coverage", () => {
    // 4 keywords total; 2 classified → ratio = 2/4 = 0.5
    const allKeywords = ["React", "Docker", "Kubernetes", "Node.js"];
    const axes = [{ keywords: ["React", "Node.js"] }];
    const ratio = computeUnclassifiedRatio(allKeywords, axes);
    assert.equal(ratio, 0.5);
  });

  test("deduplicates inputs before computing ratio", () => {
    // "react" + "React" + "REACT" → 1 unique keyword; "Docker" → 1 unique
    // Total = 2 unique; "React" covered → ratio = 1/2 = 0.5
    const allKeywords = ["react", "React", "REACT", "Docker"];
    const axes = [{ keywords: ["React"] }];
    const ratio = computeUnclassifiedRatio(allKeywords, axes);
    assert.equal(ratio, 0.5);
  });

  test("ratio is in [0, 1] for various inputs", () => {
    const keywords = ["A", "B", "C", "D", "E"];
    const axes = [{ keywords: ["A", "B"] }];
    const ratio = computeUnclassifiedRatio(keywords, axes);
    assert.ok(ratio >= 0 && ratio <= 1, `ratio ${ratio} out of [0,1]`);
    // 3 unclassified / 5 total = 0.6
    assert.equal(ratio, 0.6);
  });

  test("handles a single unclassified keyword out of one", () => {
    const ratio = computeUnclassifiedRatio(["Rust"], []);
    assert.equal(ratio, 1.0);
  });

  test("handles a single classified keyword out of one", () => {
    const ratio = computeUnclassifiedRatio(["Rust"], [{ keywords: ["Rust"] }]);
    assert.equal(ratio, 0.0);
  });

  test("case-insensitive axis lookup reduces classified count", () => {
    // "rust" in axes, "Rust" in pool → classified → ratio 0
    const ratio = computeUnclassifiedRatio(["Rust"], [{ keywords: ["rust"] }]);
    assert.equal(ratio, 0.0);
  });

  test("large keyword pool with partial coverage", () => {
    // 10 keywords, 3 classified → 7/10 = 0.7
    const allKeywords = Array.from({ length: 10 }, (_, i) => `kw${i}`);
    const axes = [{ keywords: ["kw0", "kw1", "kw2"] }];
    const ratio = computeUnclassifiedRatio(allKeywords, axes);
    assert.ok(Math.abs(ratio - 0.7) < 1e-9, `Expected 0.7, got ${ratio}`);
  });
});

// ─── exceedsUnclassifiedThreshold ────────────────────────────────────────────

describe("exceedsUnclassifiedThreshold — guard clauses and defaults", () => {
  test("returns false when allKeywords is empty (ratio is 0)", () => {
    assert.equal(exceedsUnclassifiedThreshold([], makeAxes()), false);
  });

  test("uses DEFAULT_UNCLASSIFIED_THRESHOLD (0.3) when threshold omitted", () => {
    // 2 out of 3 keywords are unclassified → ratio ≈ 0.667 > 0.3 → true
    const allKeywords = ["React", "Docker", "Kubernetes"];
    const axes = [{ keywords: ["React"] }];
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes), true);
  });

  test("uses DEFAULT_UNCLASSIFIED_THRESHOLD (0.3) when threshold is undefined", () => {
    const allKeywords = ["React"];
    const axes = [{ keywords: ["React"] }];
    // ratio = 0 → NOT > 0.3 → false
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes, undefined), false);
  });

  test("clamps invalid threshold (NaN) to DEFAULT", () => {
    // With NaN threshold → falls back to 0.3
    // ratio = 1.0 (all unclassified) > 0.3 → true
    assert.equal(exceedsUnclassifiedThreshold(["React"], [], NaN), true);
  });

  test("clamps negative threshold to 0 (always exceeds)", () => {
    // ratio = 0.5, threshold clamped to 0 → 0.5 > 0 → true
    const allKeywords = ["React", "Docker"];
    const axes = [{ keywords: ["React"] }];
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes, -0.5), true);
  });

  test("clamps threshold above 1 to 1 (never exceeds)", () => {
    // ratio can be at most 1.0, threshold clamped to 1 → 1.0 > 1 = false
    const allKeywords = ["React", "Docker"];
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, [], 1.5), false);
  });
});

describe("exceedsUnclassifiedThreshold — threshold boundary", () => {
  test("returns true when ratio STRICTLY exceeds 0.3", () => {
    // 2 unclassified / 5 total = 0.4 > 0.3 → true
    const allKeywords = ["A", "B", "C", "D", "E"];
    const axes = [{ keywords: ["A", "B", "C"] }]; // 3 classified, 2 unclassified
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes, 0.3), true);
  });

  test("returns false when ratio equals threshold (not STRICTLY greater)", () => {
    // 3 unclassified / 10 total = 0.3, threshold = 0.3 → NOT strictly > → false
    const allKeywords = Array.from({ length: 10 }, (_, i) => `kw${i}`);
    const axes = [{ keywords: ["kw0", "kw1", "kw2", "kw3", "kw4", "kw5", "kw6"] }];
    // 7 classified → 3 unclassified → ratio = 3/10 = 0.3
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes, 0.3), false);
  });

  test("returns false when ratio is below threshold", () => {
    // 1 unclassified / 10 total = 0.1, threshold = 0.3 → false
    const allKeywords = Array.from({ length: 10 }, (_, i) => `kw${i}`);
    const axes = [{ keywords: allKeywords.slice(0, 9) }]; // 9 classified
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes, 0.3), false);
  });

  test("custom threshold 0.5: returns true when ratio > 0.5", () => {
    // 3 unclassified / 5 total = 0.6 > 0.5 → true
    const allKeywords = ["A", "B", "C", "D", "E"];
    const axes = [{ keywords: ["A", "B"] }];
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes, 0.5), true);
  });

  test("custom threshold 0.5: returns false when ratio <= 0.5", () => {
    // 2 unclassified / 4 total = 0.5 → NOT strictly > → false
    const allKeywords = ["A", "B", "C", "D"];
    const axes = [{ keywords: ["A", "B"] }];
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes, 0.5), false);
  });

  test("threshold 0: always returns true when any keyword is unclassified", () => {
    const allKeywords = ["React"];
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, [], 0), true);
  });

  test("threshold 0: returns false when all keywords are classified", () => {
    const allKeywords = ["React"];
    const axes = [{ keywords: ["React"] }];
    // ratio = 0; 0 > 0 → false
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes, 0), false);
  });

  test("threshold 1: always returns false (ratio can never exceed 1)", () => {
    // Even when all keywords are unclassified, ratio = 1.0 which is NOT > 1
    const allKeywords = ["React", "Docker", "Kubernetes"];
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, [], 1), false);
  });
});

// ─── Integration: full pipeline ───────────────────────────────────────────────

describe("integration — full pipeline with realistic data", () => {
  test("no trigger when axes fully cover the keyword pool", () => {
    const allKeywords = ["React", "TypeScript", "Vite", "Node.js", "Hono", "GraphQL"];
    const axes = makeAxes(); // covers all of the above
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes), false);
    assert.equal(computeUnclassifiedRatio(allKeywords, axes), 0);
    assert.deepEqual(getUnclassifiedKeywords(allKeywords, axes), []);
  });

  test("trigger when new work-log keywords pour in and axes don't cover them", () => {
    // 6 existing keywords, 4 new ones → 4/10 = 0.4 > 0.3 → trigger
    const existingKeywords = ["React", "TypeScript", "Vite", "Node.js", "Hono", "GraphQL"];
    const newKeywords = ["Rust", "WASM", "Bun", "Deno"];
    const allKeywords = [...existingKeywords, ...newKeywords];
    const axes = makeAxes(); // covers only the original 6

    const ratio = computeUnclassifiedRatio(allKeywords, axes);
    assert.ok(Math.abs(ratio - 0.4) < 1e-9, `Expected 0.4, got ${ratio}`);
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes), true);

    const unclassified = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(unclassified, ["Rust", "WASM", "Bun", "Deno"]);
  });

  test("no trigger when new keywords stay below threshold", () => {
    // 9 existing classified + 2 new → 2/11 ≈ 0.18 < 0.3 → no trigger
    const existingKeywords = [
      "React", "TypeScript", "Vite", "Node.js", "Hono", "GraphQL",
      "Docker", "GitHub Actions", "Vercel"
    ];
    const newKeywords = ["Rust", "WASM"];
    const allKeywords = [...existingKeywords, ...newKeywords];
    const axes = [
      { keywords: existingKeywords }
    ];

    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes), false);
  });

  test("axis with mixed casing still classifies keywords correctly", () => {
    const allKeywords = ["react", "typescript", "docker"];
    const axes = [
      { keywords: ["React", "TypeScript"] } // different case from pool
    ];
    const unclassified = getUnclassifiedKeywords(allKeywords, axes);
    assert.deepEqual(unclassified, ["docker"]);

    const ratio = computeUnclassifiedRatio(allKeywords, axes);
    assert.ok(Math.abs(ratio - 1 / 3) < 1e-9);

    // 1/3 ≈ 0.333 > 0.3 → trigger
    assert.equal(exceedsUnclassifiedThreshold(allKeywords, axes), true);
  });
});
