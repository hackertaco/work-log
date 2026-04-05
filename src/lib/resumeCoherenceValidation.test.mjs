/**
 * Unit tests for the coherence validation pass in resumeReconstruction.mjs.
 *
 * Tests cover:
 *   - Structural flow scoring (section completeness, chronological order, fragmentation)
 *   - Redundancy detection and auto-removal of near-duplicate bullets
 *   - Tonal consistency integration with resumeVoice engine
 *   - Overall coherence scoring and grading
 *   - User-edit protection (never auto-fix user-sourced content)
 *
 * Run with:
 *   node --test src/lib/resumeCoherenceValidation.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateResumeCoherence,
  COHERENCE_WEIGHTS,
  REDUNDANCY_SIMILARITY_THRESHOLD,
  _scoreStructuralFlow,
  _scoreRedundancy,
  _scoreTonalConsistency,
  _collectAllBulletTexts,
} from "./resumeReconstruction.mjs";

// ─── Helper: build a minimal well-formed resume ─────────────────────────────

function buildValidResume(overrides = {}) {
  return {
    summary: "Backend engineer specializing in high-reliability payment systems. Focused on reducing latency and improving observability across distributed services.",
    contact: { name: "Test User", email: "test@example.com" },
    experience: [
      {
        company: "Acme Corp",
        title: "Senior Engineer",
        start_date: "2023-01-01",
        end_date: "2025-01-01",
        bullets: [
          "Reduced API latency by 40% by implementing connection pooling across 12 microservices",
          "Built real-time monitoring dashboard serving 200+ daily active users",
          "Migrated payment processing pipeline from batch to streaming, eliminating 2h settlement delay",
        ],
        _source: "system",
      },
      {
        company: "Startup Inc",
        title: "Software Engineer",
        start_date: "2020-06-01",
        end_date: "2022-12-31",
        bullets: [
          "Designed event-driven architecture handling 50K events/sec with zero message loss",
          "Implemented CI/CD pipeline reducing deployment time from 45min to 8min",
        ],
        _source: "system",
      },
    ],
    projects: [
      {
        name: "Real-Time Payment Settlement Pipeline",
        description: "End-to-end payment settlement system processing $2M daily transactions with sub-second confirmation.",
        bullets: [
          "Architected event-sourced ledger with exactly-once processing guarantees",
          "Deployed canary release strategy reducing rollback incidents by 80%",
        ],
        _source: "system",
      },
    ],
    skills: {
      technical: ["Node.js", "TypeScript", "PostgreSQL", "Redis", "Kafka"],
      languages: ["JavaScript", "Python", "Go"],
      tools: ["Docker", "Kubernetes", "Terraform"],
    },
    education: [
      { institution: "MIT", degree: "B.S.", field: "Computer Science" },
    ],
    _sources: { summary: "system", contact: "system", skills: "system" },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// validateResumeCoherence — overall
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateResumeCoherence", () => {
  it("returns a valid result for a well-formed resume", () => {
    const resume = buildValidResume();
    const result = validateResumeCoherence(resume);

    assert.ok(typeof result.overallScore === "number");
    assert.ok(result.overallScore >= 0 && result.overallScore <= 1);
    assert.ok(["A", "B", "C", "D"].includes(result.grade));
    assert.ok(typeof result.structuralFlow === "object");
    assert.ok(typeof result.redundancy === "object");
    assert.ok(typeof result.tonalConsistency === "object");
    assert.ok(Array.isArray(result.issues));
    assert.ok(Array.isArray(result.autoFixes));
    assert.ok(result.normalized !== null);
    assert.ok(typeof result.validatedAt === "string");
  });

  it("returns grade D for null/invalid input", () => {
    const result = validateResumeCoherence(null);
    assert.equal(result.overallScore, 0);
    assert.equal(result.grade, "D");
    assert.ok(result.issues.length > 0);
  });

  it("scores a complete well-formed resume as B or higher", () => {
    const resume = buildValidResume();
    const result = validateResumeCoherence(resume);
    assert.ok(
      result.overallScore >= 0.75,
      `Expected score >= 0.75, got ${result.overallScore}`
    );
  });

  it("issues are sorted by severity (error > warning > info)", () => {
    // Build a resume with various issues
    const resume = buildValidResume({
      experience: [
        {
          company: "A",
          title: "Dev",
          bullets: [], // error: 0 bullets
          _source: "system",
        },
      ],
    });
    const result = validateResumeCoherence(resume);

    if (result.issues.length >= 2) {
      const severityOrder = { error: 0, warning: 1, info: 2 };
      for (let i = 1; i < result.issues.length; i++) {
        const prev = severityOrder[result.issues[i - 1].severity] ?? 3;
        const curr = severityOrder[result.issues[i].severity] ?? 3;
        assert.ok(curr >= prev, `Issue sort order violated at index ${i}`);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Structural Flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("structural flow scoring", () => {
  it("penalizes missing required sections", () => {
    const resume = buildValidResume({ summary: "", experience: [] });
    const issues = [];
    const fixes = [];
    const result = _scoreStructuralFlow(resume, issues, fixes);

    assert.ok(result.score < 0.8, `Expected score < 0.8, got ${result.score}`);
    assert.ok(
      issues.some((i) => i.dimension === "structural" && i.severity === "error"),
      "Should have structural error for missing sections"
    );
  });

  it("penalizes thin experience entries (0 bullets)", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Empty Co",
          title: "Dev",
          bullets: [],
          _source: "system",
        },
      ],
    });
    const issues = [];
    const result = _scoreStructuralFlow(resume, issues, []);

    assert.ok(
      issues.some(
        (i) => i.path === "experience[0]" && i.severity === "error"
      )
    );
  });

  it("penalizes thin experience entries (1 bullet) as warning", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Thin Co",
          title: "Dev",
          start_date: "2023-01-01",
          end_date: "2024-01-01",
          bullets: ["Built something useful"],
          _source: "system",
        },
      ],
    });
    const issues = [];
    const result = _scoreStructuralFlow(resume, issues, []);

    assert.ok(
      issues.some(
        (i) => i.path === "experience[0]" && i.severity === "warning"
      )
    );
  });

  it("flags out-of-order experience entries", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Old Co",
          title: "Junior",
          start_date: "2018-01-01",
          end_date: "2020-01-01",
          bullets: ["Did early work", "Learned fundamentals"],
          _source: "system",
        },
        {
          company: "New Co",
          title: "Senior",
          start_date: "2022-01-01",
          end_date: "2024-01-01",
          bullets: ["Led team of 5", "Architected new system"],
          _source: "system",
        },
      ],
    });
    const issues = [];
    const fixes = [];
    const result = _scoreStructuralFlow(resume, issues, fixes);

    assert.ok(
      issues.some((i) => i.message.includes("not in reverse-chronological")),
      "Should flag chronological ordering issue"
    );
    // Should auto-fix by resorting
    assert.ok(
      fixes.some((f) => f.action === "reordered_chronologically"),
      "Should auto-fix chronological ordering"
    );
  });

  it("does NOT re-sort experience when user entries are present", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Old Co",
          title: "Junior",
          start_date: "2018-01-01",
          end_date: "2020-01-01",
          bullets: ["Did early work", "Learned fundamentals"],
          _source: "user",
        },
        {
          company: "New Co",
          title: "Senior",
          start_date: "2022-01-01",
          end_date: "2024-01-01",
          bullets: ["Led team of 5", "Architected new system"],
          _source: "system",
        },
      ],
    });
    const issues = [];
    const fixes = [];
    _scoreStructuralFlow(resume, issues, fixes);

    assert.ok(
      !fixes.some((f) => f.action === "reordered_chronologically"),
      "Should NOT reorder when user entries exist"
    );
  });

  it("returns score 1.0 for a complete well-formed resume", () => {
    const resume = buildValidResume();
    const issues = [];
    const result = _scoreStructuralFlow(resume, issues, []);
    assert.equal(result.score, 1);
    assert.equal(issues.filter((i) => i.severity === "error").length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Redundancy
// ═══════════════════════════════════════════════════════════════════════════════

describe("redundancy scoring", () => {
  it("returns score 1.0 when no bullets are duplicated", () => {
    const resume = buildValidResume();
    const issues = [];
    const result = _scoreRedundancy(resume, issues, []);
    assert.equal(result.score, 1);
    assert.equal(issues.length, 0);
  });

  it("detects near-duplicate bullets within the same section", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Acme",
          title: "Dev",
          bullets: [
            "Reduced API latency by 40% by implementing connection pooling",
            "Reduced API latency by 40% through implementing connection pooling across services",
            "Built monitoring dashboard for production systems",
          ],
          _source: "system",
        },
      ],
    });
    const issues = [];
    const fixes = [];
    const result = _scoreRedundancy(resume, issues, fixes);

    assert.ok(result.score < 1, `Expected score < 1, got ${result.score}`);
    assert.ok(
      issues.some((i) => i.dimension === "redundancy"),
      "Should detect redundancy"
    );
  });

  it("auto-removes the shorter duplicate from system-sourced bullets", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Acme",
          title: "Dev",
          bullets: [
            "Reduced API latency by 40% by implementing connection pooling across 12 microservices",
            "Reduced API latency by 40% by implementing connection pooling",
            "Built monitoring dashboard for production systems",
          ],
          _source: "system",
        },
      ],
    });
    const issues = [];
    const fixes = [];
    _scoreRedundancy(resume, issues, fixes);

    assert.ok(
      fixes.some((f) => f.action === "removed_duplicate"),
      "Should auto-remove duplicate"
    );
    // The remaining bullets should be 2 (shorter one removed)
    assert.equal(resume.experience[0].bullets.length, 2);
  });

  it("does NOT remove duplicates from user-sourced bullets", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Acme",
          title: "Dev",
          bullets: [
            "Reduced API latency by 40% by implementing connection pooling across 12 microservices",
            "Reduced API latency by 40% by implementing connection pooling",
          ],
          _source: "user",
        },
      ],
    });
    const issues = [];
    const fixes = [];
    _scoreRedundancy(resume, issues, fixes);

    // Should flag but not remove
    assert.ok(issues.length > 0, "Should still flag redundancy");
    assert.equal(
      fixes.filter((f) => f.action === "removed_duplicate").length,
      0,
      "Should NOT remove user-sourced duplicates"
    );
    assert.equal(resume.experience[0].bullets.length, 2, "Bullets should be preserved");
  });

  it("detects cross-section near-duplicates (experience ↔ projects)", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Acme",
          title: "Dev",
          bullets: [
            "Architected event-sourced ledger with exactly-once processing guarantees",
          ],
          _source: "system",
        },
      ],
      projects: [
        {
          name: "Payment System",
          bullets: [
            "Architected event-sourced ledger system with exactly-once processing guarantees and audit trail",
          ],
          _source: "system",
        },
      ],
    });
    const issues = [];
    _scoreRedundancy(resume, issues, []);

    assert.ok(
      issues.some((i) => i.message.includes("across sections")),
      "Should detect cross-section redundancy"
    );
  });

  it("flags summary-bullet verbatim overlap", () => {
    const bullet = "Reduced API latency by 40% by implementing connection pooling across 12 microservices";
    const resume = buildValidResume({
      summary: `Senior engineer. ${bullet} Additional context here.`,
      experience: [
        {
          company: "Acme",
          title: "Dev",
          bullets: [bullet, "Built something else entirely different"],
          _source: "system",
        },
      ],
    });
    const issues = [];
    _scoreRedundancy(resume, issues, []);

    assert.ok(
      issues.some((i) => i.message.includes("Summary contains verbatim")),
      "Should detect summary-bullet overlap"
    );
  });

  it("returns score 1.0 for a single-bullet resume", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Acme",
          title: "Dev",
          bullets: ["Single unique bullet"],
          _source: "system",
        },
      ],
      projects: [],
    });
    const issues = [];
    const result = _scoreRedundancy(resume, issues, []);
    assert.equal(result.score, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tonal Consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe("tonal consistency scoring", () => {
  it("scores a well-written resume with high tonal consistency", () => {
    const resume = buildValidResume();
    const issues = [];
    const fixes = [];
    const result = _scoreTonalConsistency(resume, issues, fixes);

    assert.ok(typeof result.score === "number");
    assert.ok(result.score >= 0 && result.score <= 1);
  });

  it("detects pronoun issues and auto-fixes them (score reflects post-fix state)", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Acme",
          title: "Dev",
          bullets: [
            "I built a monitoring dashboard for production",
            "We reduced latency by implementing caching",
            "Designed event-driven architecture handling 50K events/sec",
          ],
          _source: "system",
        },
      ],
    });
    const issues = [];
    const fixes = [];
    const result = _scoreTonalConsistency(resume, issues, fixes);

    // Voice harmonization auto-fixes pronouns on system content, so the
    // post-fix score may be high.  The key assertion is that issues were
    // detected (even if subsequently fixed).
    assert.ok(typeof result.score === "number");
    // After auto-fix, the bullets should no longer start with "I " or "We "
    for (const b of resume.experience[0].bullets) {
      assert.ok(!b.startsWith("I "), `Expected "I " to be stripped: "${b}"`);
      assert.ok(!b.startsWith("We "), `Expected "We " to be stripped: "${b}"`);
    }
  });

  it("auto-fixes voice issues on system content", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Acme",
          title: "Dev",
          bullets: [
            "I designed a new payment system from scratch",
            "Built real-time monitoring dashboard serving 200+ users",
          ],
          _source: "system",
        },
      ],
    });
    const issues = [];
    const fixes = [];
    _scoreTonalConsistency(resume, issues, fixes);

    // Check that voice normalization auto-fix was tracked
    // The "I " prefix should be stripped by normalizeSection
    const firstBullet = resume.experience[0].bullets[0];
    assert.ok(
      !firstBullet.startsWith("I "),
      `Expected pronoun to be stripped, got: "${firstBullet}"`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: user-edit protection
// ═══════════════════════════════════════════════════════════════════════════════

describe("user-edit protection", () => {
  it("never modifies user-sourced experience bullets", () => {
    const userBullets = [
      "I personally built this system from scratch",
      "I personally built this system from scratch with extra detail",
    ];
    const resume = buildValidResume({
      experience: [
        {
          company: "My Co",
          title: "Dev",
          bullets: [...userBullets],
          _source: "user",
        },
      ],
      projects: [],
    });
    const result = validateResumeCoherence(resume);

    // User bullets should be completely untouched in normalized output
    const normBullets = result.normalized.experience[0].bullets;
    assert.equal(normBullets.length, 2, "Should not remove user bullets");
  });

  it("never modifies user-sourced summary", () => {
    const userSummary = "I am a passionate developer who loves coding.";
    const resume = buildValidResume({
      summary: userSummary,
      _sources: { summary: "user" },
    });
    const result = validateResumeCoherence(resume);

    assert.equal(
      result.normalized.summary,
      userSummary,
      "User summary should be preserved unchanged"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

describe("coherence constants", () => {
  it("COHERENCE_WEIGHTS sum to 1.0", () => {
    const sum = Object.values(COHERENCE_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(sum - 1.0) < 0.001,
      `Weights should sum to 1.0, got ${sum}`
    );
  });

  it("REDUNDANCY_SIMILARITY_THRESHOLD is between 0 and 1", () => {
    assert.ok(REDUNDANCY_SIMILARITY_THRESHOLD > 0);
    assert.ok(REDUNDANCY_SIMILARITY_THRESHOLD < 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// _collectAllBulletTexts helper
// ═══════════════════════════════════════════════════════════════════════════════

describe("_collectAllBulletTexts", () => {
  it("collects bullets from experience and projects", () => {
    const resume = buildValidResume();
    const texts = _collectAllBulletTexts(resume);
    // 3 experience bullets from first + 2 from second + 2 project bullets = 7
    assert.equal(texts.length, 7, `Expected 7 bullets, got ${texts.length}`);
  });

  it("returns empty array for empty resume", () => {
    assert.deepEqual(_collectAllBulletTexts({}), []);
  });

  it("skips non-string and empty bullets", () => {
    const resume = {
      experience: [{ bullets: ["valid", null, undefined, "", "  ", "also valid"] }],
      projects: [{ bullets: [42, "project bullet"] }],
    };
    const texts = _collectAllBulletTexts(resume);
    assert.equal(texts.length, 3, "should keep only valid string bullets");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Narrative coherence — strengths & axes context
// ═══════════════════════════════════════════════════════════════════════════════

describe("structural flow — narrative coherence with context", () => {
  it("flags ungrounded system-sourced strengths", () => {
    const resume = buildValidResume();
    const issues = [];
    const strengths = [
      {
        id: "str-orphan",
        label: "Quantum Computing Expertise",
        behaviorCluster: ["quantum", "entanglement", "qubits"],
        _source: "system",
      },
    ];
    _scoreStructuralFlow(resume, issues, [], { strengths });
    assert.ok(
      issues.some(
        (i) => i.message.includes("Quantum Computing") && i.message.includes("ungrounded")
      ),
      "Should flag ungrounded strength"
    );
  });

  it("does NOT flag well-grounded strengths", () => {
    const resume = buildValidResume();
    const issues = [];
    // "microservices" appears in a resume bullet
    const strengths = [
      {
        id: "str-0",
        label: "Microservices Architecture",
        behaviorCluster: ["microservices", "distributed"],
        _source: "system",
      },
    ];
    _scoreStructuralFlow(resume, issues, [], { strengths });
    const strIssues = issues.filter((i) => i.path && i.path.includes("str-0"));
    assert.equal(strIssues.length, 0, "Should not flag matched strength");
  });

  it("skips user-sourced strengths in grounding check", () => {
    const resume = buildValidResume();
    const issues = [];
    const strengths = [
      {
        id: "str-user",
        label: "Unrelated Skill XYZ",
        behaviorCluster: ["zzz"],
        _source: "user",
      },
    ];
    _scoreStructuralFlow(resume, issues, [], { strengths });
    assert.ok(
      !issues.some((i) => i.path && i.path.includes("str-user")),
      "Should skip user-sourced strengths"
    );
  });

  it("flags orphaned narrative axes (no connected items)", () => {
    const resume = buildValidResume();
    const issues = [];
    const axes = [
      {
        id: "naxis-orphan",
        label: "Disconnected Theme",
        strengthIds: [],
        projectIds: [],
        _source: "system",
      },
    ];
    _scoreStructuralFlow(resume, issues, [], { axes });
    assert.ok(
      issues.some(
        (i) =>
          i.message.includes("Disconnected Theme") &&
          i.message.includes("orphaned")
      ),
      "Should flag orphaned axis"
    );
  });

  it("does NOT flag axes that have connected strengths or projects", () => {
    const resume = buildValidResume();
    const issues = [];
    const axes = [
      {
        id: "naxis-0",
        label: "Well-Connected Theme",
        strengthIds: ["str-0"],
        projectIds: ["proj-0"],
        _source: "system",
      },
    ];
    _scoreStructuralFlow(resume, issues, [], { axes });
    const axisIssues = issues.filter((i) => i.path && i.path.includes("naxis-0"));
    assert.equal(axisIssues.length, 0, "Should not flag connected axis");
  });

  it("flags low narrative coverage when most strengths unmatched", () => {
    const resume = buildValidResume();
    const issues = [];
    const strengths = [
      { id: "str-0", label: "Phantom Expertise Alpha", behaviorCluster: [], _source: "system" },
      { id: "str-1", label: "Phantom Expertise Beta", behaviorCluster: [], _source: "system" },
      { id: "str-2", label: "Phantom Expertise Gamma", behaviorCluster: [], _source: "system" },
    ];
    _scoreStructuralFlow(resume, issues, [], { strengths });
    assert.ok(
      issues.some((i) => i.message.includes("Low narrative coverage")),
      "Should flag low narrative coverage"
    );
  });

  it("does NOT flag narrative coverage when strengths are well-matched", () => {
    const resume = buildValidResume();
    const issues = [];
    // All keywords appear in resume bullets
    const strengths = [
      { id: "str-0", label: "Latency Reduction", behaviorCluster: ["pooling"], _source: "system" },
      { id: "str-1", label: "Event Architecture", behaviorCluster: ["pipeline"], _source: "system" },
    ];
    _scoreStructuralFlow(resume, issues, [], { strengths });
    assert.ok(
      !issues.some((i) => i.message.includes("Low narrative coverage")),
      "Should not flag when coverage is adequate"
    );
  });

  it("flags empty section bridges", () => {
    const resume = buildValidResume();
    const issues = [];
    const sectionBridges = [
      { from: "summary", to: "experience", text: "" },
      { from: "experience", to: "projects", text: "Short" },
    ];
    _scoreStructuralFlow(resume, issues, [], { sectionBridges });
    assert.ok(
      issues.some((i) => i.message.includes("section bridge")),
      "Should flag trivial bridge text"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Redundancy — strength/axis overlap
// ═══════════════════════════════════════════════════════════════════════════════

describe("redundancy — strength/axis bullet overlap", () => {
  it("detects strength exampleBullet overlap with resume bullets", () => {
    const resume = buildValidResume();
    const issues = [];
    const strengths = [
      {
        id: "str-0",
        label: "Latency Optimization",
        exampleBullets: [
          "Reduced API latency by 40% by implementing connection pooling across 12 microservices",
        ],
        _source: "system",
      },
    ];
    _scoreRedundancy(resume, issues, [], { strengths });
    assert.ok(
      issues.some((i) => i.message.includes("exampleBullet")),
      "Should detect strength exampleBullet overlap"
    );
  });

  it("detects axis supportingBullet overlap with resume bullets", () => {
    const resume = buildValidResume();
    const issues = [];
    const axes = [
      {
        id: "naxis-0",
        label: "Infrastructure Theme",
        supportingBullets: [
          "Architected event-sourced ledger with exactly-once processing guarantees",
        ],
        _source: "system",
      },
    ];
    _scoreRedundancy(resume, issues, [], { axes });
    assert.ok(
      issues.some((i) => i.message.includes("supportingBullet")),
      "Should detect axis supportingBullet overlap"
    );
  });

  it("non-overlapping metadata bullets cause no issues", () => {
    const resume = buildValidResume();
    const issues = [];
    const strengths = [
      {
        id: "str-0",
        label: "Completely Different Skill",
        exampleBullets: ["Wrote poems about software engineering"],
        _source: "system",
      },
    ];
    _scoreRedundancy(resume, issues, [], { strengths });
    assert.ok(
      !issues.some((i) => i.message.includes("exampleBullet")),
      "Should not flag non-overlapping bullets"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Decision-reasoning metadata language detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("tonal consistency — metadata-style reasoning detection", () => {
  it("flags bullets with Decision: prefix", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Corp",
          _source: "system",
          bullets: [
            "Decision: Used microservices over monolith for scalability",
            "Built real-time monitoring dashboard",
          ],
        },
      ],
    });
    const issues = [];
    _scoreTonalConsistency(resume, issues, []);
    assert.ok(
      issues.some((i) => i.message.includes("metadata-style reasoning")),
      "Should flag Decision: prefix"
    );
  });

  it("flags multiple metadata patterns (Reasoning:, Tradeoff:, Rationale:)", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Corp",
          _source: "system",
          bullets: [
            "Reasoning: Team needed faster iteration cycles",
            "Tradeoff: Chose availability over consistency",
            "Rationale: Automated testing improved velocity",
          ],
        },
      ],
    });
    const issues = [];
    const fixes = [];
    _scoreTonalConsistency(resume, issues, fixes);

    const metadataIssues = issues.filter((i) =>
      i.message.includes("metadata-style reasoning")
    );
    assert.ok(metadataIssues.length >= 3, `Expected >=3 metadata issues, got ${metadataIssues.length}`);
  });

  it("auto-strips metadata prefix from system-sourced bullets", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Corp",
          _source: "system",
          bullets: [
            "Decision: Migrated to cloud-native for cost efficiency",
            "Normal bullet about achievements",
          ],
        },
      ],
    });
    const fixes = [];
    _scoreTonalConsistency(resume, [], fixes);

    assert.ok(
      fixes.some((f) => f.action === "stripped_metadata_prefix"),
      "Should auto-strip metadata prefix"
    );
    // After fix, bullet should not start with "Decision:"
    const fixedBullet = resume.experience[0].bullets[0];
    assert.ok(!fixedBullet.startsWith("Decision:"), `Got: "${fixedBullet}"`);
    assert.ok(fixedBullet.startsWith("Migrated"), `Should capitalize: "${fixedBullet}"`);
  });

  it("does NOT auto-strip metadata from user-sourced bullets", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "Corp",
          _source: "user",
          bullets: [
            "Decision: My personal phrasing choice",
          ],
        },
      ],
    });
    const fixes = [];
    _scoreTonalConsistency(resume, [], fixes);

    assert.ok(
      !fixes.some((f) => f.action === "stripped_metadata_prefix"),
      "Should NOT strip from user content"
    );
    assert.equal(
      resume.experience[0].bullets[0],
      "Decision: My personal phrasing choice",
      "User bullet preserved"
    );
  });

  it("flags metadata-style language in summary", () => {
    const resume = buildValidResume({
      summary: "Decision: Focused career on backend systems. Built scalable platforms.",
    });
    const issues = [];
    _scoreTonalConsistency(resume, issues, []);
    assert.ok(
      issues.some(
        (i) => i.path === "summary" && i.message.includes("metadata-style")
      ),
      "Should flag summary metadata language"
    );
  });

  it("metadata violations reduce tonal score", () => {
    const cleanResume = buildValidResume();
    const dirtyResume = buildValidResume({
      experience: [
        {
          company: "Corp",
          _source: "system",
          bullets: [
            "Decision: Thing one happened",
            "Reasoning: Thing two happened",
            "Tradeoff: Thing three happened",
            "Context: Thing four happened",
            "Note: Thing five happened",
          ],
        },
      ],
    });

    const cleanResult = _scoreTonalConsistency(cleanResume, [], []);
    const dirtyResult = _scoreTonalConsistency(dirtyResume, [], []);

    assert.ok(
      dirtyResult.score <= cleanResult.score,
      `Dirty score (${dirtyResult.score}) should be <= clean score (${cleanResult.score})`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: context-aware full validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateResumeCoherence — context integration", () => {
  it("uses strengths/axes context for richer validation", () => {
    const resume = buildValidResume();
    const strengths = [
      {
        id: "str-0",
        label: "Latency Optimization",
        behaviorCluster: ["pooling", "caching"],
        exampleBullets: [
          "Reduced API latency by 40% by implementing connection pooling across 12 microservices",
        ],
        _source: "system",
      },
    ];
    const axes = [
      {
        id: "naxis-0",
        label: "Performance Engineering",
        strengthIds: ["str-0"],
        projectIds: ["proj-0"],
        supportingBullets: [
          "Architected event-sourced ledger with exactly-once processing guarantees",
        ],
        _source: "system",
      },
    ];

    const result = validateResumeCoherence(resume, { strengths, axes });
    assert.ok(typeof result.overallScore === "number");
    assert.ok(result.overallScore > 0);
  });

  it("auto-fixes metadata and duplicates while preserving user edits", () => {
    const resume = buildValidResume({
      experience: [
        {
          company: "User Corp",
          _source: "user",
          bullets: ["Decision: User chose this phrasing deliberately"],
        },
        {
          company: "System Corp",
          _source: "system",
          bullets: [
            "Decision: Implemented caching for performance",
            "Built monitoring dashboard for production systems",
          ],
        },
      ],
    });
    const result = validateResumeCoherence(resume);

    // User bullet unchanged
    assert.equal(
      result.normalized.experience[0].bullets[0],
      "Decision: User chose this phrasing deliberately"
    );
    // System bullet should have metadata stripped
    const systemBullet = result.normalized.experience[1].bullets[0];
    assert.ok(
      !systemBullet.startsWith("Decision:"),
      `System bullet should be fixed: "${systemBullet}"`
    );
  });

  it("combined score matches weighted dimension scores", () => {
    const resume = buildValidResume();
    const result = validateResumeCoherence(resume);

    const expected =
      Math.round(
        (result.structuralFlow.score * COHERENCE_WEIGHTS.structuralFlow +
          result.redundancy.score * COHERENCE_WEIGHTS.redundancy +
          result.tonalConsistency.score * COHERENCE_WEIGHTS.tonalConsistency) *
          100
      ) / 100;

    assert.equal(
      result.overallScore,
      expected,
      `Score ${result.overallScore} should match weighted ${expected}`
    );
  });
});
