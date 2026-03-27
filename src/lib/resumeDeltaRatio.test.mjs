/**
 * Tests for resumeDeltaRatio.mjs
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/resumeDeltaRatio.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DELTA_THRESHOLD,
  countResumeItems,
  countDiffChanges,
  computeDeltaRatio,
  exceedsDeltaThreshold
} from "./resumeDeltaRatio.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal resume document with predictable item counts.
 * Default total addressable items:
 *   summary(1) + experience bullets(2+3=5) + education(1) +
 *   projects bullets(2) + certifications(1) + skills(2+1+1=4) +
 *   strength_keywords(2) = 16
 */
function makeResume(overrides = {}) {
  return {
    summary: "Experienced engineer.",
    experience: [
      {
        company: "Acme",
        title: "SWE",
        bullets: ["Led migration.", "Reduced latency by 30%."]
      },
      {
        company: "Beta Inc",
        title: "Lead SWE",
        bullets: ["Managed team.", "Shipped v2.", "Improved CI."]
      }
    ],
    education: [{ institution: "Seoul National University", degree: "B.S." }],
    projects: [
      { name: "OSS Tool", bullets: ["Wrote core parser.", "Added test suite."] }
    ],
    certifications: [{ name: "AWS SAA", issuer: "Amazon", date: "2023-06" }],
    skills: {
      technical: ["React", "Node.js"],
      languages: ["JavaScript"],
      tools: ["Docker"]
    },
    strength_keywords: ["backend", "performance"],
    ...overrides
  };
}

/** Build a ResumeDiff skeleton (all sections empty / unchanged). */
function makeEmptyDiff() {
  return {
    isEmpty: true,
    contact: { added: {}, modified: {}, deleted: {}, isEmpty: true },
    summary: { changed: false, prev: "", next: "" },
    experience: { added: [], modified: [], deleted: [] },
    education: { added: [], modified: [], deleted: [] },
    skills: {
      technical: { added: [], deleted: [] },
      languages: { added: [], deleted: [] },
      tools: { added: [], deleted: [] }
    },
    projects: { added: [], modified: [], deleted: [] },
    certifications: { added: [], modified: [], deleted: [] },
    strength_keywords: { added: [], deleted: [] },
    display_axes: { added: [], modified: [], deleted: [] }
  };
}

// ─── DELTA_THRESHOLD ──────────────────────────────────────────────────────────

describe("DELTA_THRESHOLD constant", () => {
  test("is 0.03 (3%)", () => {
    assert.strictEqual(DELTA_THRESHOLD, 0.03);
  });
});

// ─── countResumeItems ─────────────────────────────────────────────────────────

describe("countResumeItems", () => {
  test("returns 0 for null", () => {
    assert.strictEqual(countResumeItems(null), 0);
  });

  test("returns 0 for undefined", () => {
    assert.strictEqual(countResumeItems(undefined), 0);
  });

  test("returns 0 for non-object", () => {
    assert.strictEqual(countResumeItems("string"), 0);
    assert.strictEqual(countResumeItems(42), 0);
  });

  test("counts summary as 1 when non-empty", () => {
    assert.strictEqual(countResumeItems({ summary: "Hello" }), 1);
  });

  test("does not count empty string summary", () => {
    assert.strictEqual(countResumeItems({ summary: "  " }), 0);
  });

  test("counts experience bullets individually", () => {
    const doc = {
      experience: [
        { company: "A", bullets: ["b1", "b2"] },
        { company: "B", bullets: ["b3"] }
      ]
    };
    assert.strictEqual(countResumeItems(doc), 3);
  });

  test("counts experience entry as 1 when bullets array is empty", () => {
    const doc = {
      experience: [{ company: "A", bullets: [] }]
    };
    assert.strictEqual(countResumeItems(doc), 1);
  });

  test("counts experience entry as 1 when bullets is missing", () => {
    const doc = { experience: [{ company: "A" }] };
    assert.strictEqual(countResumeItems(doc), 1);
  });

  test("counts education entries (1 each)", () => {
    const doc = {
      education: [
        { institution: "MIT" },
        { institution: "Stanford" }
      ]
    };
    assert.strictEqual(countResumeItems(doc), 2);
  });

  test("counts project bullets individually", () => {
    const doc = {
      projects: [
        { name: "P1", bullets: ["x", "y", "z"] },
        { name: "P2", bullets: ["a"] }
      ]
    };
    assert.strictEqual(countResumeItems(doc), 4);
  });

  test("counts project as 1 when no bullets", () => {
    const doc = { projects: [{ name: "P1" }] };
    assert.strictEqual(countResumeItems(doc), 1);
  });

  test("counts certifications (1 each)", () => {
    const doc = {
      certifications: [{ name: "CKA" }, { name: "AWS" }]
    };
    assert.strictEqual(countResumeItems(doc), 2);
  });

  test("counts individual skills across all categories", () => {
    const doc = {
      skills: {
        technical: ["React", "Node"],
        languages: ["JS"],
        tools: ["Docker", "K8s"]
      }
    };
    assert.strictEqual(countResumeItems(doc), 5);
  });

  test("handles missing skill categories gracefully", () => {
    const doc = { skills: { technical: ["Go"] } };
    assert.strictEqual(countResumeItems(doc), 1);
  });

  test("counts strength_keywords", () => {
    const doc = { strength_keywords: ["backend", "perf", "scale"] };
    assert.strictEqual(countResumeItems(doc), 3);
  });

  test("full fixture returns expected total", () => {
    // summary(1) + exp bullets(2+3=5) + edu(1) + proj bullets(2) +
    // certs(1) + skills(4) + kw(2) = 16
    const resume = makeResume();
    assert.strictEqual(countResumeItems(resume), 16);
  });

  test("empty resume scaffold returns 0", () => {
    const doc = {
      experience: [],
      education: [],
      projects: [],
      certifications: [],
      skills: { technical: [], languages: [], tools: [] },
      strength_keywords: []
    };
    assert.strictEqual(countResumeItems(doc), 0);
  });
});

// ─── countDiffChanges ─────────────────────────────────────────────────────────

describe("countDiffChanges", () => {
  test("returns 0 for null", () => {
    assert.strictEqual(countDiffChanges(null), 0);
  });

  test("returns 0 for undefined", () => {
    assert.strictEqual(countDiffChanges(undefined), 0);
  });

  test("returns 0 for empty diff (isEmpty: true)", () => {
    assert.strictEqual(countDiffChanges(makeEmptyDiff()), 0);
  });

  test("counts summary change as 1", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      summary: { changed: true, prev: "old", next: "new" }
    };
    assert.strictEqual(countDiffChanges(diff), 1);
  });

  test("does not count unchanged summary", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      summary: { changed: false, prev: "same", next: "same" }
    };
    assert.strictEqual(countDiffChanges(diff), 0);
  });

  test("counts added experience entry by its bullet count", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [{ company: "New Co", bullets: ["Built X.", "Shipped Y."] }],
        modified: [],
        deleted: []
      }
    };
    assert.strictEqual(countDiffChanges(diff), 2);
  });

  test("counts added experience entry with no bullets as 1", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [{ company: "New Co", bullets: [] }],
        modified: [],
        deleted: []
      }
    };
    assert.strictEqual(countDiffChanges(diff), 1);
  });

  test("counts modified experience entry: bullet adds + deletes", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [],
        modified: [
          {
            key: "acme::swe",
            fieldDiffs: {
              bullets: { added: ["New bullet 1.", "New bullet 2."], deleted: ["Old bullet."] }
            }
          }
        ],
        deleted: []
      }
    };
    // 2 added + 1 deleted = 3
    assert.strictEqual(countDiffChanges(diff), 3);
  });

  test("counts modified experience entry: scalar field changes", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [],
        modified: [
          {
            key: "acme::swe",
            fieldDiffs: {
              title: { prev: "SWE", next: "Senior SWE" },
              end_date: { prev: "2023-01", next: "present" }
            }
          }
        ],
        deleted: []
      }
    };
    // 2 scalar fields changed
    assert.strictEqual(countDiffChanges(diff), 2);
  });

  test("counts modified experience: scalar + bullet changes combined", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [],
        modified: [
          {
            key: "acme::swe",
            fieldDiffs: {
              title: { prev: "SWE", next: "Senior SWE" },
              bullets: { added: ["New bullet."], deleted: [] }
            }
          }
        ],
        deleted: []
      }
    };
    // 1 scalar + 1 bullet added = 2
    assert.strictEqual(countDiffChanges(diff), 2);
  });

  test("counts deleted experience entry by its bullet count", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [],
        modified: [],
        deleted: [{ company: "Old Co", bullets: ["a", "b", "c"] }]
      }
    };
    assert.strictEqual(countDiffChanges(diff), 3);
  });

  test("counts deleted experience entry with no bullets as 1", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [],
        modified: [],
        deleted: [{ company: "Old Co" }]
      }
    };
    assert.strictEqual(countDiffChanges(diff), 1);
  });

  test("counts education added/modified/deleted as 1 each", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      education: {
        added: [{ institution: "MIT" }],
        modified: [{ key: "snu", fieldDiffs: { gpa: { prev: null, next: "3.9" } } }],
        deleted: [{ institution: "Old School" }]
      }
    };
    assert.strictEqual(countDiffChanges(diff), 3);
  });

  test("counts project modified bullets", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      projects: {
        added: [],
        modified: [
          {
            key: "oss tool",
            fieldDiffs: {
              bullets: { added: ["Added feature X."], deleted: [] }
            }
          }
        ],
        deleted: []
      }
    };
    assert.strictEqual(countDiffChanges(diff), 1);
  });

  test("counts project added by bullet count", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      projects: {
        added: [{ name: "New Project", bullets: ["b1", "b2", "b3"] }],
        modified: [],
        deleted: []
      }
    };
    assert.strictEqual(countDiffChanges(diff), 3);
  });

  test("counts certification added/modified/deleted as 1 each", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      certifications: {
        added: [{ name: "CKA" }],
        modified: [],
        deleted: [{ name: "Old Cert" }]
      }
    };
    assert.strictEqual(countDiffChanges(diff), 2);
  });

  test("counts skill additions and deletions across categories", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      skills: {
        technical: { added: ["Rust", "Go"], deleted: [] },
        languages: { added: [], deleted: ["PHP"] },
        tools: { added: ["K8s"], deleted: ["Vagrant"] }
      }
    };
    // technical:2 + languages:1 + tools:2 = 5
    assert.strictEqual(countDiffChanges(diff), 5);
  });

  test("counts strength_keyword additions and deletions", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      strength_keywords: { added: ["distributed-systems"], deleted: ["php"] }
    };
    assert.strictEqual(countDiffChanges(diff), 2);
  });

  test("accumulates across multiple changed sections", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      summary: { changed: true, prev: "old", next: "new" },
      experience: {
        added: [{ company: "New", bullets: ["b1"] }],
        modified: [],
        deleted: []
      },
      skills: {
        technical: { added: ["Rust"], deleted: [] },
        languages: { added: [], deleted: [] },
        tools: { added: [], deleted: [] }
      }
    };
    // summary(1) + exp bullet(1) + skill(1) = 3
    assert.strictEqual(countDiffChanges(diff), 3);
  });
});

// ─── computeDeltaRatio ────────────────────────────────────────────────────────

describe("computeDeltaRatio", () => {
  test("returns { ratio, changedCount, totalCount } shape", () => {
    const resume = makeResume();
    const diff = makeEmptyDiff();
    const result = computeDeltaRatio(diff, resume);
    assert.ok(typeof result.ratio === "number");
    assert.ok(typeof result.changedCount === "number");
    assert.ok(typeof result.totalCount === "number");
  });

  test("ratio is 0 for empty diff", () => {
    const resume = makeResume();
    const diff = makeEmptyDiff();
    const { ratio, changedCount } = computeDeltaRatio(diff, resume);
    assert.strictEqual(changedCount, 0);
    assert.strictEqual(ratio, 0);
  });

  test("totalCount matches countResumeItems for same resume", () => {
    const resume = makeResume();
    const expected = countResumeItems(resume); // 16
    const { totalCount } = computeDeltaRatio(makeEmptyDiff(), resume);
    assert.strictEqual(totalCount, expected);
  });

  test("ratio = changedCount / totalCount", () => {
    const resume = makeResume(); // total = 16
    // Add one bullet to experience → changedCount = 1
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [],
        modified: [
          {
            key: "acme::swe",
            fieldDiffs: {
              bullets: { added: ["New bullet."], deleted: [] }
            }
          }
        ],
        deleted: []
      }
    };
    const { ratio, changedCount, totalCount } = computeDeltaRatio(diff, resume);
    assert.strictEqual(changedCount, 1);
    assert.strictEqual(totalCount, 16);
    assert.ok(Math.abs(ratio - 1 / 16) < 1e-9);
  });

  test("does not throw on empty resume (denominator clamp to 1)", () => {
    const emptyResume = {};
    const diff = makeEmptyDiff();
    const { ratio, totalCount } = computeDeltaRatio(diff, emptyResume);
    assert.strictEqual(totalCount, 0);
    assert.strictEqual(ratio, 0); // 0 / max(0, 1) = 0
  });

  test("ratio can exceed 1.0 when changes > total (edge case with deletions)", () => {
    // resume has 1 item, diff removes it and adds 2 → changedCount = 3, total = 1
    const resume = { experience: [{ company: "A", bullets: ["b1"] }] };
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [{ company: "B", bullets: ["x", "y"] }],
        modified: [],
        deleted: [{ company: "A", bullets: ["b1"] }]
      }
    };
    const { ratio } = computeDeltaRatio(diff, resume);
    assert.ok(ratio > 1.0);
  });

  test("handles null diff gracefully", () => {
    const resume = makeResume();
    const { changedCount } = computeDeltaRatio(null, resume);
    assert.strictEqual(changedCount, 0);
  });

  test("handles null resume gracefully", () => {
    const diff = makeEmptyDiff();
    const { totalCount } = computeDeltaRatio(diff, null);
    assert.strictEqual(totalCount, 0);
  });
});

// ─── exceedsDeltaThreshold ────────────────────────────────────────────────────

describe("exceedsDeltaThreshold", () => {
  test("returns false for empty diff (ratio = 0)", () => {
    const resume = makeResume();
    assert.strictEqual(exceedsDeltaThreshold(makeEmptyDiff(), resume), false);
  });

  test("returns false when ratio is below 3%", () => {
    // resume total = 16; need < 0.48 changes to stay below 3%
    const resume = makeResume(); // 16 items
    // Add 0 changes → ratio = 0 < 3%
    assert.strictEqual(exceedsDeltaThreshold(makeEmptyDiff(), resume), false);
  });

  test("returns false when ratio is exactly 2.9% (just below threshold)", () => {
    // Build a large enough resume and a diff with exactly 2.9% changes
    // totalCount = 100 items; changedCount = 2 → ratio = 2% < 3%
    const resume = {
      experience: Array.from({ length: 10 }, (_, i) => ({
        company: `Company${i}`,
        bullets: Array.from({ length: 9 }, (_, j) => `bullet ${i}-${j}`)
      })), // 90 bullets
      education: Array.from({ length: 10 }, (_, i) => ({
        institution: `Uni${i}`
      })) // 10 entries
      // total = 100
    };
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [],
        modified: [
          {
            key: "company0::undefined",
            fieldDiffs: {
              bullets: { added: ["One new bullet."], deleted: ["One old bullet."] }
            }
          }
        ],
        deleted: []
      }
    };
    // changedCount = 2; totalCount = 100; ratio = 0.02 < 0.03
    const { ratio } = computeDeltaRatio(diff, resume);
    assert.ok(ratio < 0.03, `expected ratio < 0.03 but got ${ratio}`);
    assert.strictEqual(exceedsDeltaThreshold(diff, resume), false);
  });

  test("returns true when ratio equals exactly 3%", () => {
    // totalCount = 100 (same resume as above); changedCount = 3 → ratio = 3%
    const resume = {
      experience: Array.from({ length: 10 }, (_, i) => ({
        company: `Company${i}`,
        bullets: Array.from({ length: 9 }, (_, j) => `bullet ${i}-${j}`)
      })),
      education: Array.from({ length: 10 }, (_, i) => ({
        institution: `Uni${i}`
      }))
      // total = 100
    };
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [],
        modified: [
          {
            key: "company0::undefined",
            fieldDiffs: {
              bullets: {
                added: ["Bullet A.", "Bullet B."],
                deleted: ["Old bullet."]
              }
            }
          }
        ],
        deleted: []
      }
    };
    // changedCount = 3; totalCount = 100; ratio = 0.03 ≥ 0.03
    const { ratio } = computeDeltaRatio(diff, resume);
    assert.ok(Math.abs(ratio - 0.03) < 1e-9, `expected ratio ~0.03 but got ${ratio}`);
    assert.strictEqual(exceedsDeltaThreshold(diff, resume), true);
  });

  test("returns true for a typical small diff on a medium resume", () => {
    // resume total = 16; add 1 new bullet to an experience entry → ratio = 1/16 ≈ 6.25%
    const resume = makeResume();
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      experience: {
        added: [{ company: "New Co", bullets: ["Shipped feature X."] }],
        modified: [],
        deleted: []
      }
    };
    // changedCount = 1 bullet; total = 16 → 6.25% ≥ 3%
    assert.strictEqual(exceedsDeltaThreshold(diff, resume), true);
  });

  test("accepts a custom threshold override", () => {
    const resume = makeResume(); // total = 16
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      summary: { changed: true, prev: "old", next: "new" }
    };
    // ratio = 1/16 ≈ 6.25%
    // default threshold 3% → true
    assert.strictEqual(exceedsDeltaThreshold(diff, resume), true);
    // custom threshold 10% → false
    assert.strictEqual(exceedsDeltaThreshold(diff, resume, 0.1), false);
    // custom threshold 6% → true (6.25 ≥ 6)
    assert.strictEqual(exceedsDeltaThreshold(diff, resume, 0.06), true);
  });

  test("returns false for null diff", () => {
    const resume = makeResume();
    assert.strictEqual(exceedsDeltaThreshold(null, resume), false);
  });

  test("returns false for null resume (total=0 → denominator clamp, ratio=0)", () => {
    const diff = {
      ...makeEmptyDiff(),
      isEmpty: false,
      summary: { changed: true, prev: "", next: "New summary." }
    };
    // changedCount=1, totalCount=0 → ratio = 1/1 = 1.0 ≥ 3% → true
    // (any change on an empty resume exceeds the threshold)
    assert.strictEqual(exceedsDeltaThreshold(diff, null), true);
  });
});
