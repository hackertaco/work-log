/**
 * Tests for Section Bridge Generation (Sub-AC 3 of AC 4)
 *
 * Covers:
 *   - generateSectionBridges: main entry point with user-edit preservation
 *   - _identifyActiveSectionPairs: active section pair detection
 *   - _normalizeBridges: raw LLM output normalization
 *   - _buildBridgesUserMessage: LLM prompt construction
 *   - BRIDGE_SECTION_PAIRS: section pair definitions
 *   - User-edited bridge preservation across regeneration
 *   - Graceful degradation on LLM failure
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  generateSectionBridges,
  _identifyActiveSectionPairs,
  _normalizeBridges,
  _buildBridgesUserMessage,
  BRIDGE_SECTION_PAIRS
} from "./resumeReconstruction.mjs";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeResume(overrides = {}) {
  return {
    summary: overrides.summary ?? "A skilled engineer.",
    experience: overrides.experience ?? [
      { company: "Acme", title: "Engineer", bullets: ["Built APIs"] }
    ],
    projects: overrides.projects ?? [
      { name: "SideProject", description: "Open source tool", bullets: ["Led dev"] }
    ],
    education: overrides.education ?? [
      { institution: "MIT", degree: "BS", field: "CS" }
    ],
    skills: overrides.skills ?? {
      technical: ["JavaScript", "Python"],
      languages: [],
      tools: ["Docker"]
    },
    ...overrides
  };
}

// ─── BRIDGE_SECTION_PAIRS ───────────────────────────────────────────────────

describe("BRIDGE_SECTION_PAIRS", () => {
  test("defines expected transition pairs", () => {
    assert.ok(Array.isArray(BRIDGE_SECTION_PAIRS));
    assert.ok(BRIDGE_SECTION_PAIRS.length >= 3, "should have at least 3 pairs");

    // Must include summary → experience
    const summaryToExp = BRIDGE_SECTION_PAIRS.find(
      (p) => p.from === "summary" && p.to === "experience"
    );
    assert.ok(summaryToExp, "should include summary → experience pair");

    // Must include experience → projects
    const expToProj = BRIDGE_SECTION_PAIRS.find(
      (p) => p.from === "experience" && p.to === "projects"
    );
    assert.ok(expToProj, "should include experience → projects pair");
  });

  test("each pair has from, to, label", () => {
    for (const pair of BRIDGE_SECTION_PAIRS) {
      assert.ok(typeof pair.from === "string" && pair.from.length > 0);
      assert.ok(typeof pair.to === "string" && pair.to.length > 0);
      assert.ok(typeof pair.label === "string" && pair.label.length > 0);
    }
  });
});

// ─── _identifyActiveSectionPairs ────────────────────────────────────────────

describe("_identifyActiveSectionPairs", () => {
  test("returns pairs where both sections have content", () => {
    const resume = makeResume();
    const pairs = _identifyActiveSectionPairs(resume);
    assert.ok(pairs.length > 0);
    // summary + experience + projects + education + skills all present
    const keys = pairs.map((p) => `${p.from}→${p.to}`);
    assert.ok(keys.includes("summary→experience"));
    assert.ok(keys.includes("experience→projects"));
  });

  test("excludes pairs where one section is empty", () => {
    const resume = makeResume({ projects: [], education: [] });
    const pairs = _identifyActiveSectionPairs(resume);
    const keys = pairs.map((p) => `${p.from}→${p.to}`);
    assert.ok(!keys.includes("experience→projects"), "no projects → no bridge");
    assert.ok(!keys.includes("projects→education"), "no projects or education → no bridge");
  });

  test("returns empty for empty resume", () => {
    const pairs = _identifyActiveSectionPairs({});
    assert.deepStrictEqual(pairs, []);
  });
});

// ─── _normalizeBridges ─────────────────────────────────────────────────────

describe("_normalizeBridges", () => {
  const validPairs = [
    { from: "summary", to: "experience" },
    { from: "experience", to: "projects" }
  ];

  test("normalizes valid bridge objects", () => {
    const raw = [
      { from: "summary", to: "experience", text: "Building on years of backend experience..." },
      { from: "experience", to: "projects", text: "Beyond professional roles..." }
    ];
    const result = _normalizeBridges(raw, validPairs);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].from, "summary");
    assert.strictEqual(result[0].to, "experience");
    assert.strictEqual(result[0]._source, "system");
  });

  test("filters out invalid pairs not in validPairs", () => {
    const raw = [
      { from: "summary", to: "experience", text: "Valid bridge" },
      { from: "skills", to: "certifications", text: "Invalid pair" }
    ];
    const result = _normalizeBridges(raw, validPairs);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].from, "summary");
  });

  test("handles empty text bridges", () => {
    const raw = [
      { from: "summary", to: "experience", text: "" },
      { from: "experience", to: "projects", text: "  " }
    ];
    const result = _normalizeBridges(raw, validPairs);
    // Empty-text bridges are still returned (caller decides whether to use)
    assert.strictEqual(result.length, 2);
  });

  test("handles null and malformed input", () => {
    assert.deepStrictEqual(_normalizeBridges(null, validPairs), []);
    assert.deepStrictEqual(_normalizeBridges(undefined, validPairs), []);
    assert.deepStrictEqual(_normalizeBridges([null, 42, "bad"], validPairs), []);
  });

  test("trims whitespace from fields", () => {
    const raw = [
      { from: "  summary  ", to: "  experience  ", text: "  Some bridge text  " }
    ];
    const result = _normalizeBridges(raw, validPairs);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].from, "summary");
    assert.strictEqual(result[0].to, "experience");
    assert.strictEqual(result[0].text, "Some bridge text");
  });
});

// ─── _buildBridgesUserMessage ───────────────────────────────────────────────

describe("_buildBridgesUserMessage", () => {
  test("includes resume content sections", () => {
    const resume = makeResume();
    const msg = _buildBridgesUserMessage(
      resume, [], [], [],
      [{ from: "summary", to: "experience" }]
    );
    assert.ok(msg.includes("RESUME SUMMARY"), "should include summary heading");
    assert.ok(msg.includes("EXPERIENCE"), "should include experience heading");
    assert.ok(msg.includes("PROJECTS"), "should include projects heading");
  });

  test("includes narrative axes when provided", () => {
    const resume = makeResume();
    const axes = [{ label: "Full-Stack Craft", description: "End-to-end systems" }];
    const msg = _buildBridgesUserMessage(
      resume, [], axes, [],
      [{ from: "summary", to: "experience" }]
    );
    assert.ok(msg.includes("Full-Stack Craft"));
    assert.ok(msg.includes("NARRATIVE AXES"));
  });

  test("includes strengths when provided", () => {
    const resume = makeResume();
    const strengths = [{ label: "API Design", description: "Clean REST interfaces" }];
    const msg = _buildBridgesUserMessage(
      resume, strengths, [], [],
      [{ from: "summary", to: "experience" }]
    );
    assert.ok(msg.includes("API Design"));
    assert.ok(msg.includes("IDENTIFIED STRENGTHS"));
  });

  test("includes section pairs at the end", () => {
    const resume = makeResume();
    const pairs = [
      { from: "summary", to: "experience" },
      { from: "experience", to: "projects" }
    ];
    const msg = _buildBridgesUserMessage(resume, [], [], [], pairs);
    assert.ok(msg.includes('"summary"'));
    assert.ok(msg.includes('"experience"'));
    assert.ok(msg.includes("SECTION PAIRS NEEDING BRIDGE TEXT"));
  });
});

// ─── generateSectionBridges ─────────────────────────────────────────────────

describe("generateSectionBridges", () => {
  test("returns empty for null resume", async () => {
    const result = await generateSectionBridges({ resume: null });
    assert.deepStrictEqual(result.bridges, []);
    assert.strictEqual(result.pairCount, 0);
    assert.strictEqual(result.generatedCount, 0);
  });

  test("preserves user-edited bridges", async () => {
    const resume = makeResume();
    const existingBridges = [
      { from: "summary", to: "experience", text: "My custom bridge", _source: "user" }
    ];
    // Mock LLM that would generate different text
    const mockLlm = async () => [
      { from: "summary", to: "experience", text: "LLM generated bridge" },
      { from: "experience", to: "projects", text: "Another LLM bridge" }
    ];

    const result = await generateSectionBridges(
      { resume, existingBridges },
      { llmFn: mockLlm }
    );

    // User bridge must be preserved
    const userBridge = result.bridges.find(
      (b) => b.from === "summary" && b.to === "experience"
    );
    assert.ok(userBridge);
    assert.strictEqual(userBridge.text, "My custom bridge");
    assert.strictEqual(userBridge._source, "user");
  });

  test("user_approved bridges are also preserved", async () => {
    const resume = makeResume();
    const existingBridges = [
      { from: "summary", to: "experience", text: "Approved bridge", _source: "user_approved" }
    ];
    const mockLlm = async () => [
      { from: "summary", to: "experience", text: "New text" }
    ];

    const result = await generateSectionBridges(
      { resume, existingBridges },
      { llmFn: mockLlm }
    );

    const bridge = result.bridges.find(
      (b) => b.from === "summary" && b.to === "experience"
    );
    assert.strictEqual(bridge.text, "Approved bridge");
  });

  test("generates system bridges for pairs without user edits", async () => {
    const resume = makeResume();
    const mockLlm = async () => [
      { from: "summary", to: "experience", text: "Generated bridge 1" },
      { from: "experience", to: "projects", text: "Generated bridge 2" }
    ];

    const result = await generateSectionBridges(
      { resume },
      { llmFn: mockLlm }
    );

    assert.ok(result.bridges.length >= 2);
    const sys = result.bridges.filter((b) => b._source === "system");
    assert.ok(sys.length >= 2);
  });

  test("gracefully degrades on LLM failure", async () => {
    const resume = makeResume();
    const existingBridges = [
      { from: "summary", to: "experience", text: "Existing", _source: "system" }
    ];
    const failingLlm = async () => {
      throw new Error("API unavailable");
    };

    const result = await generateSectionBridges(
      { resume, existingBridges },
      { llmFn: failingLlm }
    );

    // Should return existing bridges without crashing
    assert.ok(Array.isArray(result.bridges));
    assert.strictEqual(result.generatedCount, 0);
  });

  test("skips generation when all pairs have user bridges", async () => {
    const resume = makeResume({ projects: [], education: [] });
    // Only summary→experience pair is active
    const existingBridges = [
      { from: "summary", to: "experience", text: "User bridge", _source: "user" }
    ];
    let llmCalled = false;
    const mockLlm = async () => {
      llmCalled = true;
      return [];
    };

    await generateSectionBridges(
      { resume, existingBridges },
      { llmFn: mockLlm }
    );

    assert.ok(!llmCalled, "LLM should not be called when all pairs have user bridges");
  });

  test("result includes generatedAt timestamp", async () => {
    const resume = makeResume();
    const mockLlm = async () => [];
    const result = await generateSectionBridges(
      { resume },
      { llmFn: mockLlm }
    );
    assert.ok(result.generatedAt);
    // Should be a valid ISO date
    assert.ok(!isNaN(Date.parse(result.generatedAt)));
  });
});
