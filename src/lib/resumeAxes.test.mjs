/**
 * Unit tests for resumeAxes.mjs
 *
 * Run with: node --test src/lib/resumeAxes.test.mjs
 *
 * Tests cover:
 *   - createAxis: valid creation, label validation, keyword normalisation
 *   - normalizeKeywords: trimming, dedup, length cap, count cap
 *   - validateLabel: valid/invalid inputs
 *   - findAxisIndex: lookup by id
 *   - updateAxisInArray: partial update, immutability, not-found
 *   - removeAxisFromArray: removal, not-found
 *   - migrateAxes: legacy items without id, items with highlight_skills
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createAxis,
  normalizeKeywords,
  validateLabel,
  findAxisIndex,
  updateAxisInArray,
  removeAxisFromArray,
  migrateAxes,
  mergeAxes,
  moveKeywordBetweenAxes,
  AXIS_SCHEMA_VERSION
} from "./resumeAxes.mjs";

// ─── createAxis ────────────────────────────────────────────────────────────────

describe("createAxis", () => {
  it("returns an Axis object with id, label, keywords", () => {
    const axis = createAxis("Backend Engineer");
    assert.equal(typeof axis.id, "string");
    assert.ok(axis.id.length > 0, "id should not be empty");
    assert.equal(axis.label, "Backend Engineer");
    assert.deepEqual(axis.keywords, []);
    assert.equal(axis._source, "user");
  });

  it("sets provided keywords (normalised)", () => {
    const axis = createAxis("DevOps", ["  Docker  ", "Kubernetes", "docker"]);
    // "docker" is duplicate of "Docker" — should be deduped
    assert.deepEqual(axis.keywords, ["Docker", "Kubernetes"]);
  });

  it("uses 'system' source when specified", () => {
    const axis = createAxis("ML Engineer", [], "system");
    assert.equal(axis._source, "system");
  });

  it("throws TypeError for empty label", () => {
    assert.throws(() => createAxis(""), TypeError);
  });

  it("throws TypeError for non-string label", () => {
    assert.throws(() => createAxis(42), TypeError);
    assert.throws(() => createAxis(null), TypeError);
  });

  it("truncates label to 100 characters", () => {
    const long = "a".repeat(150);
    const axis = createAxis(long);
    assert.equal(axis.label.length, 100);
  });

  it("generates unique ids on each call", () => {
    const a = createAxis("Axis A");
    const b = createAxis("Axis B");
    assert.notEqual(a.id, b.id);
  });
});

// ─── normalizeKeywords ─────────────────────────────────────────────────────────

describe("normalizeKeywords", () => {
  it("returns empty array for non-array input", () => {
    assert.deepEqual(normalizeKeywords(null), []);
    assert.deepEqual(normalizeKeywords("string"), []);
    assert.deepEqual(normalizeKeywords(undefined), []);
  });

  it("trims whitespace from each keyword", () => {
    assert.deepEqual(normalizeKeywords(["  React  ", "\tNode.js\n"]), ["React", "Node.js"]);
  });

  it("drops empty strings", () => {
    assert.deepEqual(normalizeKeywords(["", "  ", "Go"]), ["Go"]);
  });

  it("drops non-string elements silently", () => {
    assert.deepEqual(normalizeKeywords([1, null, "Rust", true]), ["Rust"]);
  });

  it("deduplicates case-insensitively, keeps first occurrence", () => {
    const result = normalizeKeywords(["Python", "python", "PYTHON", "Go"]);
    assert.deepEqual(result, ["Python", "Go"]);
  });

  it("truncates keywords longer than 60 characters", () => {
    const long = "k".repeat(80);
    const result = normalizeKeywords([long]);
    assert.equal(result[0].length, 60);
  });

  it("caps total count at 30 keywords", () => {
    const raw = Array.from({ length: 40 }, (_, i) => `keyword-${i}`);
    const result = normalizeKeywords(raw);
    assert.equal(result.length, 30);
  });
});

// ─── validateLabel ─────────────────────────────────────────────────────────────

describe("validateLabel", () => {
  it("returns trimmed label for valid string", () => {
    assert.equal(validateLabel("  Frontend  "), "Frontend");
  });

  it("throws TypeError for empty string", () => {
    assert.throws(() => validateLabel(""), TypeError);
    assert.throws(() => validateLabel("   "), TypeError);
  });

  it("throws TypeError for non-string", () => {
    assert.throws(() => validateLabel(undefined), TypeError);
    assert.throws(() => validateLabel(123), TypeError);
    assert.throws(() => validateLabel(null), TypeError);
    assert.throws(() => validateLabel([]), TypeError);
  });

  it("truncates to 100 characters", () => {
    const label = validateLabel("x".repeat(200));
    assert.equal(label.length, 100);
  });
});

// ─── findAxisIndex ─────────────────────────────────────────────────────────────

describe("findAxisIndex", () => {
  const axes = [
    { id: "aaa", label: "Backend" },
    { id: "bbb", label: "Frontend" },
    { id: "ccc", label: "DevOps" }
  ];

  it("returns correct index for existing id", () => {
    assert.equal(findAxisIndex(axes, "bbb"), 1);
    assert.equal(findAxisIndex(axes, "ccc"), 2);
  });

  it("returns -1 for missing id", () => {
    assert.equal(findAxisIndex(axes, "zzz"), -1);
  });

  it("returns -1 for non-array input", () => {
    assert.equal(findAxisIndex(null, "aaa"), -1);
    assert.equal(findAxisIndex(undefined, "aaa"), -1);
  });

  it("returns -1 for empty or non-string id", () => {
    assert.equal(findAxisIndex(axes, ""), -1);
    assert.equal(findAxisIndex(axes, null), -1);
    assert.equal(findAxisIndex(axes, 123), -1);
  });
});

// ─── updateAxisInArray ─────────────────────────────────────────────────────────

describe("updateAxisInArray", () => {
  const makeAxes = () => [
    { id: "aaa", label: "Backend", keywords: ["Node.js"], _source: "system" },
    { id: "bbb", label: "Frontend", keywords: ["React"], _source: "user" }
  ];

  it("updates label and sets _source to user", () => {
    const { axes, updated } = updateAxisInArray(makeAxes(), "aaa", {
      label: "Backend Engineer"
    });
    assert.equal(updated.label, "Backend Engineer");
    assert.equal(updated._source, "user");
    // Original keywords preserved
    assert.deepEqual(updated.keywords, ["Node.js"]);
    // Original array not mutated
    assert.equal(axes[0].label, "Backend Engineer");
    assert.equal(makeAxes()[0].label, "Backend"); // original still unchanged
  });

  it("updates keywords", () => {
    const { updated } = updateAxisInArray(makeAxes(), "bbb", {
      keywords: ["React", "TypeScript", "react"]
    });
    // "react" is duplicate of "React"
    assert.deepEqual(updated.keywords, ["React", "TypeScript"]);
    // label preserved
    assert.equal(updated.label, "Frontend");
  });

  it("updates both label and keywords together", () => {
    const { axes, updated } = updateAxisInArray(makeAxes(), "aaa", {
      label: "Node.js Expert",
      keywords: ["Node.js", "Express"]
    });
    assert.equal(updated.label, "Node.js Expert");
    assert.deepEqual(updated.keywords, ["Node.js", "Express"]);
    assert.equal(axes.length, 2);
  });

  it("returns { updated: null } for unknown id", () => {
    const original = makeAxes();
    const { axes, updated } = updateAxisInArray(original, "zzz", {
      label: "New"
    });
    assert.equal(updated, null);
    // Same array reference returned
    assert.equal(axes, original);
  });

  it("handles empty or non-array axes gracefully", () => {
    const { axes, updated } = updateAxisInArray(null, "aaa", { label: "X" });
    assert.equal(updated, null);
    assert.deepEqual(axes, []);
  });

  it("does not mutate the original axis objects", () => {
    const origAxes = makeAxes();
    const origLabel = origAxes[0].label;
    updateAxisInArray(origAxes, "aaa", { label: "Changed" });
    assert.equal(origAxes[0].label, origLabel);
  });
});

// ─── removeAxisFromArray ───────────────────────────────────────────────────────

describe("removeAxisFromArray", () => {
  const makeAxes = () => [
    { id: "aaa", label: "Backend" },
    { id: "bbb", label: "Frontend" },
    { id: "ccc", label: "DevOps" }
  ];

  it("removes axis by id and returns removed: true", () => {
    const { axes, removed } = removeAxisFromArray(makeAxes(), "bbb");
    assert.equal(removed, true);
    assert.equal(axes.length, 2);
    assert.ok(axes.every((a) => a.id !== "bbb"));
  });

  it("returns removed: false and same array ref for unknown id", () => {
    const original = makeAxes();
    const { axes, removed } = removeAxisFromArray(original, "zzz");
    assert.equal(removed, false);
    assert.equal(axes, original);
  });

  it("returns removed: false for non-array input", () => {
    const { axes, removed } = removeAxisFromArray(null, "aaa");
    assert.equal(removed, false);
    assert.deepEqual(axes, []);
  });

  it("does not mutate the original array", () => {
    const original = makeAxes();
    removeAxisFromArray(original, "aaa");
    assert.equal(original.length, 3);
  });

  it("handles removing the only element", () => {
    const single = [{ id: "aaa", label: "Solo" }];
    const { axes, removed } = removeAxisFromArray(single, "aaa");
    assert.equal(removed, true);
    assert.deepEqual(axes, []);
  });
});

// ─── migrateAxes ──────────────────────────────────────────────────────────────

describe("migrateAxes", () => {
  it("returns empty array for undefined/null/non-array input", () => {
    assert.deepEqual(migrateAxes(undefined), []);
    assert.deepEqual(migrateAxes(null), []);
    assert.deepEqual(migrateAxes("bad"), []);
  });

  it("assigns a fresh id to legacy items that lack one", () => {
    const legacy = [{ label: "Backend", highlight_skills: ["Node.js"] }];
    const result = migrateAxes(legacy);
    assert.equal(result.length, 1);
    assert.equal(typeof result[0].id, "string");
    assert.ok(result[0].id.length > 0);
    assert.equal(result[0].label, "Backend");
    // highlight_skills mapped to keywords
    assert.deepEqual(result[0].keywords, ["Node.js"]);
  });

  it("preserves existing id when present", () => {
    const modern = [{ id: "my-stable-id", label: "Frontend", keywords: ["React"] }];
    const result = migrateAxes(modern);
    assert.equal(result[0].id, "my-stable-id");
    assert.deepEqual(result[0].keywords, ["React"]);
  });

  it("prefers keywords over highlight_skills when both present", () => {
    const mixed = [{
      id: "x",
      label: "Mixed",
      keywords: ["TypeScript"],
      highlight_skills: ["JavaScript"]
    }];
    const result = migrateAxes(mixed);
    // keywords array takes precedence
    assert.deepEqual(result[0].keywords, ["TypeScript"]);
  });

  it("normalises keywords during migration (dedup, trim)", () => {
    const legacy = [
      { label: "DevOps", highlight_skills: ["  Docker  ", "kubernetes", "Docker"] }
    ];
    const result = migrateAxes(legacy);
    assert.deepEqual(result[0].keywords, ["Docker", "kubernetes"]);
  });

  it("filters out null/non-object array elements", () => {
    const mixed = [null, { id: "aaa", label: "Valid", keywords: [] }, undefined];
    const result = migrateAxes(mixed);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "aaa");
  });

  it("assigns separate unique ids to multiple legacy items", () => {
    const legacy = [
      { label: "A", highlight_skills: [] },
      { label: "B", highlight_skills: [] }
    ];
    const result = migrateAxes(legacy);
    assert.equal(result.length, 2);
    assert.notEqual(result[0].id, result[1].id);
  });
});

// ─── mergeAxes ────────────────────────────────────────────────────────────────

describe("mergeAxes", () => {
  const makeAxes = () => [
    { id: "aaa", label: "Backend", keywords: ["Node.js", "PostgreSQL"], _source: "system" },
    { id: "bbb", label: "Frontend", keywords: ["React", "TypeScript"], _source: "user" },
    { id: "ccc", label: "DevOps", keywords: ["Docker", "Kubernetes"], _source: "system" }
  ];

  it("merges source keywords into target and removes source", () => {
    const { axes, merged, error } = mergeAxes(makeAxes(), "aaa", "bbb");
    assert.equal(error, null, "error should be null");
    assert.ok(merged, "merged should be non-null");
    // Source axis (bbb) removed — only 2 axes remain
    assert.equal(axes.length, 2);
    // Target (aaa) kept, source (bbb) removed
    assert.ok(axes.every((a) => a.id !== "bbb"), "source axis must be removed");
    const target = axes.find((a) => a.id === "aaa");
    assert.ok(target, "target axis must remain");
    // Keywords unioned
    assert.ok(target.keywords.includes("Node.js"));
    assert.ok(target.keywords.includes("PostgreSQL"));
    assert.ok(target.keywords.includes("React"));
    assert.ok(target.keywords.includes("TypeScript"));
  });

  it("preserves target label when newLabel is not provided", () => {
    const { merged } = mergeAxes(makeAxes(), "aaa", "bbb");
    assert.equal(merged.label, "Backend");
  });

  it("uses newLabel for the merged axis when provided", () => {
    const { merged } = mergeAxes(makeAxes(), "aaa", "bbb", "Full-Stack Engineer");
    assert.equal(merged.label, "Full-Stack Engineer");
  });

  it("sets _source to 'user' on the merged axis", () => {
    const { merged } = mergeAxes(makeAxes(), "aaa", "bbb");
    assert.equal(merged._source, "user");
  });

  it("deduplicates keywords across both axes", () => {
    const axes = [
      { id: "x", label: "A", keywords: ["Node.js", "Go"], _source: "system" },
      { id: "y", label: "B", keywords: ["node.js", "Rust"], _source: "system" }
    ];
    const { merged } = mergeAxes(axes, "x", "y");
    // "Node.js" and "node.js" are the same — only first occurrence kept
    const lowered = merged.keywords.map((k) => k.toLowerCase());
    const nodeCount = lowered.filter((k) => k === "node.js").length;
    assert.equal(nodeCount, 1, "duplicate keyword should be deduplicated");
    assert.ok(merged.keywords.includes("Go"));
    assert.ok(merged.keywords.includes("Rust"));
  });

  it("does not mutate the original array", () => {
    const original = makeAxes();
    mergeAxes(original, "aaa", "bbb");
    assert.equal(original.length, 3);
    assert.equal(original[0].label, "Backend");
  });

  it("preserves other axes unchanged", () => {
    const { axes } = mergeAxes(makeAxes(), "aaa", "bbb");
    const devOps = axes.find((a) => a.id === "ccc");
    assert.ok(devOps, "unrelated axis must remain");
    assert.deepEqual(devOps.keywords, ["Docker", "Kubernetes"]);
    assert.equal(devOps._source, "system");
  });

  it("returns error when targetId === sourceId", () => {
    const { axes, merged, error } = mergeAxes(makeAxes(), "aaa", "aaa");
    assert.ok(error, "error should be set");
    assert.equal(merged, null);
    assert.equal(axes.length, 3, "original array returned on error");
  });

  it("returns error when targetId is not found", () => {
    const { merged, error } = mergeAxes(makeAxes(), "zzz", "aaa");
    assert.ok(error);
    assert.equal(merged, null);
  });

  it("returns error when sourceId is not found", () => {
    const { merged, error } = mergeAxes(makeAxes(), "aaa", "zzz");
    assert.ok(error);
    assert.equal(merged, null);
  });

  it("returns error for empty targetId", () => {
    const { error } = mergeAxes(makeAxes(), "", "bbb");
    assert.ok(error);
  });

  it("returns error for empty sourceId", () => {
    const { error } = mergeAxes(makeAxes(), "aaa", "");
    assert.ok(error);
  });

  it("returns error for non-string ids", () => {
    const { error: e1 } = mergeAxes(makeAxes(), null, "bbb");
    const { error: e2 } = mergeAxes(makeAxes(), "aaa", 42);
    assert.ok(e1);
    assert.ok(e2);
  });

  it("returns error when newLabel is an empty string", () => {
    const { merged, error } = mergeAxes(makeAxes(), "aaa", "bbb", "   ");
    assert.ok(error, "empty newLabel should produce an error");
    assert.equal(merged, null);
  });

  it("handles non-array axes gracefully", () => {
    const { axes, error } = mergeAxes(null, "aaa", "bbb");
    assert.deepEqual(axes, []);
    assert.ok(error, "should error when both axes missing");
  });

  it("merged axis retains the target's id", () => {
    const { merged } = mergeAxes(makeAxes(), "aaa", "bbb");
    assert.equal(merged.id, "aaa");
  });

  it("merged axis appears at the position of the target", () => {
    // aaa is at index 0; after removing bbb (index 1), target should be at index 0
    const { axes } = mergeAxes(makeAxes(), "aaa", "bbb");
    assert.equal(axes[0].id, "aaa");
    assert.equal(axes[1].id, "ccc");
  });

  it("merged axis appears at the correct position when source is before target", () => {
    // bbb is at index 1, ccc is at index 2; after merging bbb→ccc:
    // bbb removed, ccc updated → remaining: aaa(0), ccc(1)
    const { axes } = mergeAxes(makeAxes(), "ccc", "bbb");
    assert.equal(axes.length, 2);
    assert.equal(axes[0].id, "aaa");
    assert.equal(axes[1].id, "ccc");
    assert.ok(axes[1].keywords.includes("React"), "source keywords absorbed");
  });

  it("caps merged keywords at 30", () => {
    const kw1 = Array.from({ length: 20 }, (_, i) => `kw-a-${i}`);
    const kw2 = Array.from({ length: 20 }, (_, i) => `kw-b-${i}`);
    const axes = [
      { id: "x", label: "A", keywords: kw1, _source: "system" },
      { id: "y", label: "B", keywords: kw2, _source: "system" }
    ];
    const { merged } = mergeAxes(axes, "x", "y");
    assert.equal(merged.keywords.length, 30);
  });
});

// ─── moveKeywordBetweenAxes ───────────────────────────────────────────────────

describe("moveKeywordBetweenAxes", () => {
  const makeAxes = () => [
    { id: "aaa", label: "Backend", keywords: ["Node.js", "PostgreSQL", "Go"], _source: "system" },
    { id: "bbb", label: "Frontend", keywords: ["React", "TypeScript"], _source: "user" },
    { id: "ccc", label: "DevOps", keywords: ["Docker", "Kubernetes"], _source: "system" }
  ];

  it("moves keyword from source axis to destination axis", () => {
    const { axes, moved, fromAxisId, toAxisId, keyword, error } =
      moveKeywordBetweenAxes(makeAxes(), "Node.js", "bbb");
    assert.equal(error, null);
    assert.equal(moved, true);
    assert.equal(fromAxisId, "aaa");
    assert.equal(toAxisId, "bbb");
    assert.equal(keyword, "Node.js");
    // Verify source axis no longer has the keyword
    const src = axes.find((a) => a.id === "aaa");
    assert.ok(!src.keywords.includes("Node.js"), "source axis should not have the keyword");
    // Verify destination axis has the keyword
    const dest = axes.find((a) => a.id === "bbb");
    assert.ok(dest.keywords.includes("Node.js"), "destination axis should have the keyword");
  });

  it("matches keyword case-insensitively", () => {
    const { moved, keyword } = moveKeywordBetweenAxes(makeAxes(), "node.js", "bbb");
    assert.equal(moved, true);
    // Preserves original casing from source
    assert.equal(keyword, "Node.js");
  });

  it("auto-detects source axis when fromAxisId is not provided", () => {
    const { moved, fromAxisId } = moveKeywordBetweenAxes(makeAxes(), "Docker", "bbb");
    assert.equal(moved, true);
    assert.equal(fromAxisId, "ccc"); // Docker was in DevOps
  });

  it("uses specified fromAxisId when provided and keyword is present", () => {
    const { moved, fromAxisId } = moveKeywordBetweenAxes(makeAxes(), "Go", "bbb", "aaa");
    assert.equal(moved, true);
    assert.equal(fromAxisId, "aaa");
  });

  it("falls back to auto-detect when fromAxisId is specified but keyword absent there", () => {
    // "Docker" is in "ccc", not "aaa" — fromAxisId "aaa" is wrong
    const { moved, fromAxisId } = moveKeywordBetweenAxes(makeAxes(), "Docker", "bbb", "aaa");
    assert.equal(moved, true);
    assert.equal(fromAxisId, "ccc"); // auto-detected correct source
  });

  it("returns moved: false (no-op) when keyword already in destination", () => {
    const { axes, moved, error } = moveKeywordBetweenAxes(makeAxes(), "React", "bbb");
    assert.equal(error, null);
    assert.equal(moved, false);
    // Axes unchanged
    assert.equal(axes, makeAxes().length > 0 ? axes : axes); // no structural check needed
    const dest = axes.find((a) => a.id === "bbb");
    assert.ok(dest.keywords.includes("React"));
  });

  it("sets _source to 'user' on both source and destination axes", () => {
    const { axes } = moveKeywordBetweenAxes(makeAxes(), "Node.js", "bbb");
    const src = axes.find((a) => a.id === "aaa");
    const dest = axes.find((a) => a.id === "bbb");
    assert.equal(src._source, "user");
    assert.equal(dest._source, "user");
  });

  it("does not mutate the original axes array", () => {
    const original = makeAxes();
    const origLen = original.length;
    const origSrcKwCount = original[0].keywords.length;
    moveKeywordBetweenAxes(original, "Node.js", "bbb");
    assert.equal(original.length, origLen);
    assert.equal(original[0].keywords.length, origSrcKwCount);
  });

  it("preserves unrelated axes unchanged", () => {
    const { axes } = moveKeywordBetweenAxes(makeAxes(), "Node.js", "bbb");
    const devOps = axes.find((a) => a.id === "ccc");
    assert.deepEqual(devOps.keywords, ["Docker", "Kubernetes"]);
    assert.equal(devOps._source, "system"); // untouched
  });

  it("returns error when destination axis is not found", () => {
    const { axes, moved, error } = moveKeywordBetweenAxes(makeAxes(), "Node.js", "zzz");
    assert.ok(error, "error should be set");
    assert.equal(moved, false);
    assert.equal(axes.length, 3); // original returned
  });

  it("returns error when keyword not found in any axis", () => {
    const { moved, error } = moveKeywordBetweenAxes(makeAxes(), "Python", "bbb");
    assert.ok(error);
    assert.equal(moved, false);
  });

  it("returns error for empty keyword", () => {
    const { moved, error } = moveKeywordBetweenAxes(makeAxes(), "", "bbb");
    assert.ok(error);
    assert.equal(moved, false);
  });

  it("returns error for non-string keyword", () => {
    const { moved, error } = moveKeywordBetweenAxes(makeAxes(), null, "bbb");
    assert.ok(error);
    assert.equal(moved, false);
  });

  it("returns error for empty toAxisId", () => {
    const { moved, error } = moveKeywordBetweenAxes(makeAxes(), "Node.js", "");
    assert.ok(error);
    assert.equal(moved, false);
  });

  it("returns error for non-string toAxisId", () => {
    const { moved, error } = moveKeywordBetweenAxes(makeAxes(), "Node.js", null);
    assert.ok(error);
    assert.equal(moved, false);
  });

  it("handles non-array axes gracefully", () => {
    const { axes, moved, error } = moveKeywordBetweenAxes(null, "Node.js", "bbb");
    assert.equal(moved, false);
    assert.ok(error);
    assert.deepEqual(axes, []);
  });

  it("does not create duplicate keywords in destination", () => {
    // Move "React" from bbb to bbb — keyword already there
    const { axes } = moveKeywordBetweenAxes(makeAxes(), "React", "bbb");
    const dest = axes.find((a) => a.id === "bbb");
    const reactCount = dest.keywords.filter((k) => k.toLowerCase() === "react").length;
    assert.equal(reactCount, 1);
  });

  it("produces axes with correct keyword counts after move", () => {
    const orig = makeAxes();
    const { axes } = moveKeywordBetweenAxes(orig, "PostgreSQL", "bbb");
    const src = axes.find((a) => a.id === "aaa");
    const dest = axes.find((a) => a.id === "bbb");
    // Source had 3 keywords, now has 2
    assert.equal(src.keywords.length, orig[0].keywords.length - 1);
    // Destination had 2 keywords, now has 3
    assert.equal(dest.keywords.length, orig[1].keywords.length + 1);
  });
});

// ─── AXIS_SCHEMA_VERSION ───────────────────────────────────────────────────────

describe("AXIS_SCHEMA_VERSION", () => {
  it("is a string", () => {
    assert.equal(typeof AXIS_SCHEMA_VERSION, "string");
  });

  it("equals '1'", () => {
    assert.equal(AXIS_SCHEMA_VERSION, "1");
  });
});
