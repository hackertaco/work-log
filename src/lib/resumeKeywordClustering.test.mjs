/**
 * Unit tests for resumeKeywordClustering.mjs
 *
 * Run with:  node --test src/lib/resumeKeywordClustering.test.mjs
 * (Node.js built-in test runner — no external dependencies)
 *
 * Coverage:
 *   - deduplicateKeywords()         — pure helper, no I/O
 *   - collectResumeKeywords()       — pure helper, no I/O
 *   - collectWorkLogKeywords()      — pure helper, no I/O
 *   - normalizeAxes()               — pure helper, no I/O
 *   - clusterKeywords()             — LLM path tested via WORK_LOG_DISABLE_OPENAI=1
 *                                     (returns [] when LLM is disabled)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  clusterKeywords,
  collectResumeKeywords,
  collectWorkLogKeywords,
  normalizeAxes,
  deduplicateKeywords
} from "./resumeKeywordClustering.mjs";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeResume(overrides = {}) {
  return {
    meta: { schemaVersion: 1 },
    contact: { name: "Dev Kim" },
    summary: "Full-stack engineer.",
    experience: [],
    education: [],
    skills: {
      technical: ["React", "Node.js", "GraphQL"],
      languages: ["JavaScript", "TypeScript"],
      tools: ["Docker", "GitHub Actions"]
    },
    projects: [],
    certifications: [],
    strength_keywords: ["cloud", "devops", "microservices"],
    display_axes: [],
    ...overrides
  };
}

// ─── deduplicateKeywords ───────────────────────────────────────────────────────

describe("deduplicateKeywords — basic", () => {
  test("returns empty array for empty input", () => {
    assert.deepEqual(deduplicateKeywords([]), []);
  });

  test("returns empty array for null input", () => {
    assert.deepEqual(deduplicateKeywords(null), []);
  });

  test("returns empty array for non-array input", () => {
    assert.deepEqual(deduplicateKeywords("React"), []);
  });

  test("preserves order of first occurrences", () => {
    const result = deduplicateKeywords(["React", "Node.js", "Docker"]);
    assert.deepEqual(result, ["React", "Node.js", "Docker"]);
  });

  test("removes exact duplicates", () => {
    const result = deduplicateKeywords(["React", "React", "Node.js"]);
    assert.deepEqual(result, ["React", "Node.js"]);
  });

  test("case-insensitive deduplication preserves first casing", () => {
    const result = deduplicateKeywords(["react", "React", "REACT"]);
    assert.deepEqual(result, ["react"]);
  });

  test("trims whitespace before comparing", () => {
    const result = deduplicateKeywords(["  React  ", "React"]);
    assert.deepEqual(result, ["React"]);
  });

  test("filters out non-string entries", () => {
    const result = deduplicateKeywords(["React", 42, null, undefined, "Node.js"]);
    assert.deepEqual(result, ["React", "Node.js"]);
  });

  test("filters out empty-string entries", () => {
    const result = deduplicateKeywords(["React", "", "  ", "Node.js"]);
    assert.deepEqual(result, ["React", "Node.js"]);
  });

  test("handles mixed case across resume + worklog keywords", () => {
    const result = deduplicateKeywords(["TypeScript", "typescript", "TYPESCRIPT"]);
    assert.deepEqual(result, ["TypeScript"]);
  });
});

// ─── collectResumeKeywords ─────────────────────────────────────────────────────

describe("collectResumeKeywords — guard clauses", () => {
  test("returns [] for null resume", () => {
    assert.deepEqual(collectResumeKeywords(null), []);
  });

  test("returns [] for non-object resume", () => {
    assert.deepEqual(collectResumeKeywords("not-an-object"), []);
  });

  test("returns [] for empty resume object", () => {
    assert.deepEqual(collectResumeKeywords({}), []);
  });
});

describe("collectResumeKeywords — sources", () => {
  test("collects strength_keywords", () => {
    const result = collectResumeKeywords({ strength_keywords: ["cloud", "devops"] });
    assert.deepEqual(result, ["cloud", "devops"]);
  });

  test("collects skills.technical", () => {
    const result = collectResumeKeywords({
      skills: { technical: ["React", "Node.js"], languages: [], tools: [] }
    });
    assert.ok(result.includes("React"));
    assert.ok(result.includes("Node.js"));
  });

  test("collects skills.languages", () => {
    const result = collectResumeKeywords({
      skills: { technical: [], languages: ["JavaScript", "TypeScript"], tools: [] }
    });
    assert.ok(result.includes("JavaScript"));
    assert.ok(result.includes("TypeScript"));
  });

  test("collects skills.tools", () => {
    const result = collectResumeKeywords({
      skills: { technical: [], languages: [], tools: ["Docker", "Kubernetes"] }
    });
    assert.ok(result.includes("Docker"));
    assert.ok(result.includes("Kubernetes"));
  });

  test("collects from all sources together", () => {
    const resume = makeResume();
    const result = collectResumeKeywords(resume);
    // strength_keywords
    assert.ok(result.includes("cloud"));
    assert.ok(result.includes("devops"));
    assert.ok(result.includes("microservices"));
    // technical
    assert.ok(result.includes("React"));
    assert.ok(result.includes("Node.js"));
    // languages
    assert.ok(result.includes("JavaScript"));
    // tools
    assert.ok(result.includes("Docker"));
  });

  test("deduplicates across sources", () => {
    const resume = makeResume({
      strength_keywords: ["React"],
      skills: {
        technical: ["React", "Node.js"],
        languages: [],
        tools: []
      }
    });
    const result = collectResumeKeywords(resume);
    const reactCount = result.filter((k) => k.toLowerCase() === "react").length;
    assert.equal(reactCount, 1);
  });

  test("ignores non-array skills fields gracefully", () => {
    const result = collectResumeKeywords({
      skills: { technical: "not-an-array", languages: null, tools: undefined }
    });
    assert.deepEqual(result, []);
  });

  test("ignores null skills object", () => {
    const result = collectResumeKeywords({ skills: null });
    assert.deepEqual(result, []);
  });
});

// ─── collectWorkLogKeywords ────────────────────────────────────────────────────

describe("collectWorkLogKeywords — guard clauses", () => {
  test("returns [] for null input", () => {
    assert.deepEqual(collectWorkLogKeywords(null), []);
  });

  test("returns [] for non-array input", () => {
    assert.deepEqual(collectWorkLogKeywords("not-array"), []);
  });

  test("returns [] for empty array", () => {
    assert.deepEqual(collectWorkLogKeywords([]), []);
  });
});

describe("collectWorkLogKeywords — sources", () => {
  test("collects from entry.keywords array", () => {
    const logs = [{ keywords: ["Hono", "Preact"] }];
    const result = collectWorkLogKeywords(logs);
    assert.ok(result.includes("Hono"));
    assert.ok(result.includes("Preact"));
  });

  test("extracts CamelCase tokens from resumeBullets", () => {
    const logs = [{ resumeBullets: ["Migrated to Hono framework for API routing"] }];
    const result = collectWorkLogKeywords(logs);
    // "Hono" has uppercase — should be extracted
    assert.ok(result.includes("Hono"), `Expected Hono in ${result}`);
  });

  test("extracts acronym-style tokens from resumeBullets", () => {
    const logs = [{ resumeBullets: ["Integrated REST API with OAuth2 authentication"] }];
    const result = collectWorkLogKeywords(logs);
    assert.ok(result.includes("REST"), `Expected REST in ${result}`);
    assert.ok(result.includes("API"), `Expected API in ${result}`);
    assert.ok(result.includes("OAuth2"), `Expected OAuth2 in ${result}`);
  });

  test("ignores pure-lowercase tokens from bullets (likely plain words)", () => {
    const logs = [{ resumeBullets: ["built a new feature"] }];
    const result = collectWorkLogKeywords(logs);
    // "built", "a", "new", "feature" are all lowercase — excluded
    assert.deepEqual(result, []);
  });

  test("deduplicates across multiple log entries", () => {
    const logs = [
      { keywords: ["React"] },
      { keywords: ["React", "Node.js"] },
      { resumeBullets: ["Used React and Node.js"] }
    ];
    const result = collectWorkLogKeywords(logs);
    const reactCount = result.filter((k) => k.toLowerCase() === "react").length;
    assert.equal(reactCount, 1);
  });

  test("skips null/non-object entries gracefully", () => {
    const logs = [null, undefined, 42, { keywords: ["Docker"] }];
    const result = collectWorkLogKeywords(logs);
    assert.ok(result.includes("Docker"));
  });

  test("skips non-string keyword entries", () => {
    const logs = [{ keywords: ["React", null, 42, undefined, "Node.js"] }];
    const result = collectWorkLogKeywords(logs);
    assert.ok(result.includes("React"));
    assert.ok(result.includes("Node.js"));
    assert.equal(result.length, 2);
  });
});

// ─── normalizeAxes ─────────────────────────────────────────────────────────────

describe("normalizeAxes — guard clauses", () => {
  test("returns [] for null rawAxes", () => {
    assert.deepEqual(normalizeAxes(null, ["React"]), []);
  });

  test("returns [] for non-array rawAxes", () => {
    assert.deepEqual(normalizeAxes("not-array", ["React"]), []);
  });

  test("returns [] for empty rawAxes", () => {
    assert.deepEqual(normalizeAxes([], ["React"]), []);
  });
});

describe("normalizeAxes — filtering", () => {
  test("keeps axes with valid label and non-empty keywords", () => {
    const originals = ["React", "Node.js"];
    const rawAxes = [
      { label: "Frontend", keywords: ["React"] },
      { label: "Backend", keywords: ["Node.js"] }
    ];
    const result = normalizeAxes(rawAxes, originals);
    assert.equal(result.length, 2);
    assert.equal(result[0].label, "Frontend");
    assert.deepEqual(result[0].keywords, ["React"]);
  });

  test("discards axis with empty label", () => {
    const originals = ["React"];
    const rawAxes = [
      { label: "", keywords: ["React"] }
    ];
    const result = normalizeAxes(rawAxes, originals);
    assert.equal(result.length, 0);
  });

  test("discards axis when all keywords filtered out", () => {
    const originals = ["React"];
    const rawAxes = [
      { label: "Frontend", keywords: ["Angular"] } // Angular not in originals
    ];
    const result = normalizeAxes(rawAxes, originals);
    assert.equal(result.length, 0);
  });

  test("discards keywords not in the original set (hallucinated keywords)", () => {
    const originals = ["React", "Node.js"];
    const rawAxes = [
      { label: "Frontend", keywords: ["React", "SvelteKit"] }
    ];
    const result = normalizeAxes(rawAxes, originals);
    assert.equal(result[0].keywords.length, 1);
    assert.equal(result[0].keywords[0], "React");
  });

  test("keyword filtering is case-insensitive", () => {
    const originals = ["react", "node.js"];
    const rawAxes = [
      { label: "Frontend", keywords: ["React", "Node.js"] }
    ];
    const result = normalizeAxes(rawAxes, originals);
    // React (capital) matches "react" in originals
    assert.equal(result[0].keywords.length, 2);
  });

  test("prevents same keyword appearing in multiple axes", () => {
    const originals = ["React", "Node.js"];
    const rawAxes = [
      { label: "Frontend", keywords: ["React"] },
      { label: "Backend", keywords: ["React", "Node.js"] } // React already assigned
    ];
    const result = normalizeAxes(rawAxes, originals);
    // "React" appears only in the first axis
    const allKeywords = result.flatMap((a) => a.keywords);
    const reactCount = allKeywords.filter(
      (k) => k.toLowerCase() === "react"
    ).length;
    assert.equal(reactCount, 1);
    // Node.js still appears in the second axis
    assert.ok(allKeywords.includes("Node.js"));
  });

  test("trims whitespace from labels and keywords", () => {
    const originals = ["React"];
    const rawAxes = [
      { label: "  Frontend  ", keywords: ["  React  "] }
    ];
    const result = normalizeAxes(rawAxes, originals);
    assert.equal(result[0].label, "Frontend");
    assert.equal(result[0].keywords[0], "React");
  });

  test("caps output at 6 axes", () => {
    const originals = ["a", "b", "c", "d", "e", "f", "g"];
    const rawAxes = Array.from({ length: 8 }, (_, i) => ({
      label: `Axis ${i + 1}`,
      keywords: [originals[i] ?? "a"]
    }));
    // Re-use keywords after original set exhausted — they'll be filtered.
    // Build axes that each consume one valid keyword.
    const rawAxes7 = originals.slice(0, 7).map((k, i) => ({
      label: `Axis ${i + 1}`,
      keywords: [k]
    }));
    const result = normalizeAxes(rawAxes7, originals);
    assert.ok(result.length <= 6);
  });

  test("skips non-object entries in rawAxes", () => {
    const originals = ["React"];
    const rawAxes = [null, "bad", 42, { label: "Frontend", keywords: ["React"] }];
    const result = normalizeAxes(rawAxes, originals);
    assert.equal(result.length, 1);
    assert.equal(result[0].label, "Frontend");
  });
});

// ─── clusterKeywords — LLM-disabled path ──────────────────────────────────────

describe("clusterKeywords — LLM disabled (WORK_LOG_DISABLE_OPENAI=1)", () => {
  // Set the env var for this describe block; restore after each test.
  test("returns [] when WORK_LOG_DISABLE_OPENAI=1", async () => {
    const prev = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
    try {
      const result = await clusterKeywords(["React", "Node.js"], ["Docker"]);
      assert.deepEqual(result, []);
    } finally {
      if (prev === undefined) {
        delete process.env.WORK_LOG_DISABLE_OPENAI;
      } else {
        process.env.WORK_LOG_DISABLE_OPENAI = prev;
      }
    }
  });

  test("returns [] when OPENAI_API_KEY is absent", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    const prevDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    delete process.env.OPENAI_API_KEY;
    delete process.env.WORK_LOG_DISABLE_OPENAI;
    try {
      const result = await clusterKeywords(["React", "Node.js"], ["Docker"]);
      assert.deepEqual(result, []);
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
      if (prevDisable !== undefined)
        process.env.WORK_LOG_DISABLE_OPENAI = prevDisable;
    }
  });

  test("returns [] when both keyword arrays are empty", async () => {
    const prev = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
    try {
      const result = await clusterKeywords([], []);
      assert.deepEqual(result, []);
    } finally {
      if (prev === undefined) {
        delete process.env.WORK_LOG_DISABLE_OPENAI;
      } else {
        process.env.WORK_LOG_DISABLE_OPENAI = prev;
      }
    }
  });

  test("returns [] when inputs are null/undefined", async () => {
    const prev = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
    try {
      const result = await clusterKeywords(null, undefined);
      assert.deepEqual(result, []);
    } finally {
      if (prev === undefined) {
        delete process.env.WORK_LOG_DISABLE_OPENAI;
      } else {
        process.env.WORK_LOG_DISABLE_OPENAI = prev;
      }
    }
  });
});

// ─── Integration: collect + normalise pipeline ────────────────────────────────

describe("integration — collect helpers + normalizeAxes pipeline", () => {
  test("full pipeline: resume → keywords → axes", () => {
    const resume = makeResume();
    const workLogs = [
      { keywords: ["Hono", "Vercel", "Vite"] }
    ];

    const resumeKws = collectResumeKeywords(resume);
    const workLogKws = collectWorkLogKeywords(workLogs);

    // Both helpers should return non-empty arrays
    assert.ok(resumeKws.length > 0, "resumeKws should be non-empty");
    assert.ok(workLogKws.length > 0, "workLogKws should be non-empty");

    // Simulate what the LLM would return and validate normalisation
    const allKws = deduplicateKeywords([...resumeKws, ...workLogKws]);
    const mockLlmAxes = [
      { label: "Frontend", keywords: ["React", "Vite", "Preact"] },
      { label: "Backend", keywords: ["Node.js", "Hono"] },
      { label: "DevOps", keywords: ["Docker", "GitHub Actions", "Vercel"] },
      { label: "Languages", keywords: ["JavaScript", "TypeScript"] },
      { label: "Architecture", keywords: ["microservices", "GraphQL"] }
    ];
    // Remove any axis keyword that is not actually in allKws to simulate LLM adding fake ones
    const result = normalizeAxes(mockLlmAxes, allKws);

    assert.ok(result.length >= 1, "Should produce at least 1 axis");
    for (const axis of result) {
      assert.ok(typeof axis.label === "string" && axis.label.length > 0);
      assert.ok(Array.isArray(axis.keywords) && axis.keywords.length > 0);
    }
  });

  test("normalizeAxes preserves all keywords from originals once", () => {
    const originals = ["React", "Node.js", "Docker", "TypeScript", "Kubernetes"];
    const rawAxes = [
      { label: "Frontend", keywords: ["React", "TypeScript"] },
      { label: "Backend", keywords: ["Node.js"] },
      { label: "Infrastructure", keywords: ["Docker", "Kubernetes"] }
    ];
    const result = normalizeAxes(rawAxes, originals);

    const allAssigned = result.flatMap((a) => a.keywords.map((k) => k.toLowerCase()));
    const originalLower = originals.map((k) => k.toLowerCase());

    // Every original keyword should appear exactly once
    for (const kw of originalLower) {
      const count = allAssigned.filter((k) => k === kw).length;
      assert.equal(count, 1, `Keyword "${kw}" should appear exactly once`);
    }
  });

  test("collectResumeKeywords + collectWorkLogKeywords combined dedup", () => {
    const resume = makeResume({
      strength_keywords: ["React"],
      skills: { technical: ["React", "Node.js"], languages: [], tools: [] }
    });
    const workLogs = [{ keywords: ["React", "TypeScript"] }];

    const resumeKws = collectResumeKeywords(resume);
    const workLogKws = collectWorkLogKeywords(workLogs);
    const combined = deduplicateKeywords([...resumeKws, ...workLogKws]);

    const reactCount = combined.filter((k) => k.toLowerCase() === "react").length;
    assert.equal(reactCount, 1, "React should appear only once in combined set");
    assert.ok(combined.includes("TypeScript"));
  });
});
