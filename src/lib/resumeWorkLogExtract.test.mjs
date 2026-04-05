/**
 * Tests for resumeWorkLogExtract.mjs (Sub-AC 12b — diff-context LLM mode).
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/resumeWorkLogExtract.test.mjs
 *
 * Coverage:
 *   - buildWorkLogDiff: deduplication, company extraction, priority projects
 *   - extractResumeUpdatesFromWorkLog: short-circuit, API key guard, disabled guard
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkLogDiff,
  extractResumeUpdatesFromWorkLog
} from "./resumeWorkLogExtract.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeResume(overrides = {}) {
  return {
    meta: { language: "en", schemaVersion: 1, generatedAt: "2024-01-01T00:00:00Z" },
    contact: { name: "Alice Kim", email: "alice@example.com", phone: null, location: "Seoul", website: null, linkedin: null },
    summary: "Experienced software engineer.",
    experience: [
      {
        _source: "user",
        company: "Acme Corp",
        title: "Senior Engineer",
        start_date: "2022-01",
        end_date: "present",
        location: "Seoul",
        bullets: [
          "Led migration to microservices.",
          "Reduced deploy time by 40%."
        ]
      },
      {
        _source: "system",
        company: "Beta Labs",
        title: "Engineer",
        start_date: "2019-03",
        end_date: "2021-12",
        location: null,
        bullets: [
          "Built REST API serving 10k users."
        ]
      }
    ],
    education: [],
    skills: { technical: ["React", "Node.js"], languages: ["JavaScript", "TypeScript"], tools: ["Docker"] },
    projects: [
      {
        _source: "system",
        name: "OpenSource CLI",
        description: "CLI tool",
        url: null,
        bullets: ["Built plugin architecture."]
      }
    ],
    certifications: [],
    strength_keywords: ["cloud", "devops"],
    display_axes: [],
    ...overrides
  };
}

function makeWorkLog(overrides = {}) {
  return {
    date: "2024-06-15",
    highlights: {
      businessOutcomes: ["Shipped new authentication module to production."],
      keyChanges: ["Migrated login flow to OAuth 2.0."],
      accomplishments: ["Fixed critical XSS vulnerability.", "Reviewed 5 PRs."],
      commitHighlights: []
    },
    resume: {
      candidates: ["Improved security posture by implementing OAuth 2.0."],
      companyCandidates: ["Shipped auth module for Acme Corp."],
      openSourceCandidates: []
    },
    prBranchSignals: {
      projectWeights: {
        "acme/auth-service": 1.0,
        "acme/frontend": 0.5,
        "acme/legacy": 0.1
      }
    },
    ...overrides
  };
}

// ─── buildWorkLogDiff tests ────────────────────────────────────────────────────

describe("buildWorkLogDiff", () => {
  test("returns genuinely new candidates not in existing resume", () => {
    const resume = makeResume();
    const workLog = makeWorkLog();
    const diff = buildWorkLogDiff(workLog, resume);

    // "Led migration to microservices." is already in the resume — should be excluded
    // New strings like "Shipped new authentication module to production." should be included
    assert.ok(Array.isArray(diff.rawCandidates), "rawCandidates must be an array");
    assert.ok(diff.rawCandidates.length > 0, "should have at least one new candidate");

    // Verify no existing resume bullets leaked through
    for (const bullet of diff.rawCandidates) {
      assert.notStrictEqual(bullet, "Led migration to microservices.");
      assert.notStrictEqual(bullet, "Reduced deploy time by 40%.");
      assert.notStrictEqual(bullet, "Built REST API serving 10k users.");
      assert.notStrictEqual(bullet, "Built plugin architecture.");
    }
  });

  test("returns empty rawCandidates when all work log content is already in resume", () => {
    const resume = makeResume();
    // Work log candidates exactly match existing resume bullets
    const workLog = makeWorkLog({
      highlights: {
        businessOutcomes: [],
        keyChanges: [],
        accomplishments: [],
        commitHighlights: []
      },
      resume: {
        candidates: ["Led migration to microservices."],
        companyCandidates: ["Reduced deploy time by 40%."],
        openSourceCandidates: ["Built plugin architecture."]
      }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    assert.strictEqual(diff.rawCandidates.length, 0,
      "all candidates already in resume → rawCandidates must be empty");
  });

  test("deduplicates candidates within the same work log batch", () => {
    const resume = makeResume();
    const workLog = makeWorkLog({
      highlights: {
        businessOutcomes: ["Unique achievement from today."],
        keyChanges: ["Unique achievement from today."], // duplicate
        accomplishments: [],
        commitHighlights: []
      },
      resume: { candidates: [], companyCandidates: [], openSourceCandidates: [] }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    const count = diff.rawCandidates.filter(
      (s) => s === "Unique achievement from today."
    ).length;
    assert.strictEqual(count, 1, "duplicate candidates within batch must be deduplicated");
  });

  test("returns existingCompanies with correct shape", () => {
    const resume = makeResume();
    const workLog = makeWorkLog();
    const diff = buildWorkLogDiff(workLog, resume);

    assert.ok(Array.isArray(diff.existingCompanies), "existingCompanies must be an array");
    assert.strictEqual(diff.existingCompanies.length, 2, "should have 2 experience entries");

    const acme = diff.existingCompanies.find((e) => e.company === "Acme Corp");
    assert.ok(acme, "Acme Corp should be in existingCompanies");
    assert.strictEqual(acme.title, "Senior Engineer");
    assert.strictEqual(acme.isCurrentRole, true, "end_date=present → isCurrentRole=true");

    const beta = diff.existingCompanies.find((e) => e.company === "Beta Labs");
    assert.ok(beta, "Beta Labs should be in existingCompanies");
    assert.strictEqual(beta.isCurrentRole, false, "past role → isCurrentRole=false");
  });

  test("returns priority projects with weight >= 0.25, excludes < 0.25", () => {
    const resume = makeResume();
    const workLog = makeWorkLog({
      prBranchSignals: {
        projectWeights: {
          "repo/high": 1.0,
          "repo/mid": 0.5,
          "repo/low": 0.1 // below threshold
        }
      }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    assert.strictEqual(diff.priorityProjects.length, 2, "should have 2 priority projects (0.1 excluded)");
    const repos = diff.priorityProjects.map((p) => p.repo);
    assert.ok(repos.includes("repo/high"), "high weight repo should be included");
    assert.ok(repos.includes("repo/mid"), "mid weight repo should be included");
    assert.ok(!repos.includes("repo/low"), "low weight repo should be excluded");
  });

  test("assigns correct signal labels for priority projects", () => {
    const resume = makeResume();
    const workLog = makeWorkLog({
      prBranchSignals: {
        projectWeights: {
          "repo/merged": 1.0,
          "repo/referenced": 0.75,
          "repo/branch-created": 0.5,
          "repo/branch-activity": 0.25
        }
      }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    const byRepo = Object.fromEntries(diff.priorityProjects.map((p) => [p.repo, p.signal]));
    assert.strictEqual(byRepo["repo/merged"], "PR merged");
    assert.strictEqual(byRepo["repo/referenced"], "PR referenced");
    assert.strictEqual(byRepo["repo/branch-created"], "branch created");
    assert.strictEqual(byRepo["repo/branch-activity"], "branch activity");
  });

  test("handles empty work log gracefully", () => {
    const resume = makeResume();
    const diff = buildWorkLogDiff({}, resume);

    assert.deepStrictEqual(diff.rawCandidates, []);
    assert.strictEqual(diff.existingCompanies.length, 2);
    assert.deepStrictEqual(diff.priorityProjects, []);
    assert.strictEqual(diff.date, null);
  });

  test("handles null/undefined workLog and resume", () => {
    const diff1 = buildWorkLogDiff(null, null);
    assert.deepStrictEqual(diff1.rawCandidates, []);
    assert.deepStrictEqual(diff1.existingCompanies, []);
    assert.deepStrictEqual(diff1.priorityProjects, []);

    const diff2 = buildWorkLogDiff(undefined, undefined);
    assert.deepStrictEqual(diff2.rawCandidates, []);
    assert.deepStrictEqual(diff2.existingCompanies, []);
  });

  test("forwards work log date correctly", () => {
    const diff = buildWorkLogDiff({ date: "2024-06-15" }, {});
    assert.strictEqual(diff.date, "2024-06-15");
  });

  test("deduplication is case-insensitive and punctuation-normalised", () => {
    const resume = makeResume({
      experience: [
        {
          company: "Acme Corp",
          title: "Engineer",
          start_date: "2022-01",
          end_date: "present",
          bullets: ["Led migration to micro-services."]
        }
      ]
    });
    const workLog = makeWorkLog({
      highlights: {
        businessOutcomes: [],
        keyChanges: [],
        accomplishments: ["LED MIGRATION TO MICRO SERVICES"],
        commitHighlights: []
      },
      resume: { candidates: [], companyCandidates: [], openSourceCandidates: [] }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    // The normalisation collapses punctuation and lower-cases, so this should
    // be considered a duplicate of the existing bullet.
    assert.strictEqual(
      diff.rawCandidates.filter((s) =>
        s.toLowerCase().includes("migration")
      ).length,
      0,
      "near-duplicate (case/punctuation variant) must be filtered out"
    );
  });

  test("limits accomplishments to 8 items", () => {
    const resume = makeResume({ experience: [], projects: [] });
    const workLog = makeWorkLog({
      highlights: {
        businessOutcomes: [],
        keyChanges: [],
        accomplishments: Array.from({ length: 15 }, (_, i) => `Achievement ${i + 1}`),
        commitHighlights: []
      },
      resume: { candidates: [], companyCandidates: [], openSourceCandidates: [] }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    // accomplishments are sliced to 8; total rawCandidates ≤ 8
    assert.ok(diff.rawCandidates.length <= 8,
      "accomplishments should be capped at 8");
  });

  test("clusters related micro-changes into broader resume-worthy candidates", () => {
    const resume = makeResume({ experience: [], projects: [] });
    const workLog = makeWorkLog({
      highlights: {
        businessOutcomes: [],
        keyChanges: [
          "Android 15 대응으로 하단 SafeArea를 적용해 edge-to-edge 충돌을 보완했습니다.",
          "Flutter WebView Dart 타입 에러를 Sentry 필터에 추가해 집계 노이즈를 줄였습니다.",
          "버전 1.15.21+180으로 릴리스 준비를 마무리했습니다.",
        ],
        accomplishments: [],
        commitHighlights: []
      },
      resume: { candidates: [], companyCandidates: [], openSourceCandidates: [] }
    });

    const diff = buildWorkLogDiff(workLog, resume);

    assert.equal(diff.rawCandidates.length, 1, "related mobile stability items should collapse into one candidate cluster");
    assert.match(diff.rawCandidates[0], /Resume theme:/);
    assert.match(diff.rawCandidates[0], /mobile stability/i);
  });

  test("experience entries with no company are excluded from existingCompanies", () => {
    const resume = makeResume({
      experience: [
        { company: "Acme Corp", title: "Engineer", start_date: "2022-01", end_date: "present", bullets: [] },
        { company: "", title: "Freelancer", start_date: "2020-01", end_date: "2021-12", bullets: [] },
        { title: "Consultant", start_date: "2019-01", end_date: "2019-12", bullets: [] }
      ]
    });
    const diff = buildWorkLogDiff({}, resume);
    assert.strictEqual(diff.existingCompanies.length, 1, "entries without company must be excluded");
    assert.strictEqual(diff.existingCompanies[0].company, "Acme Corp");
  });

  // ── Sub-AC 11b: pipeline weight sorting ──────────────────────────────────

  test("priority projects are sorted by pipelineWeights when provided (Sub-AC 11b)", () => {
    const resume = makeResume();
    // Two repos with same maxWeight (0.75) but different pipeline weights
    // due to mention counts: repo-b has pipelineWeight > repo-a
    const workLog = makeWorkLog({
      prBranchSignals: {
        projectWeights: { "repo-a": 0.75, "repo-b": 0.75 },
        // repo-b has 3 mentions → 0.75 × 1.5 = 1.125; repo-a has 1 mention → 0.75
        pipelineWeights: { "repo-a": 0.75, "repo-b": 1.125 },
        mentionCounts: { "repo-a": 1, "repo-b": 3 }
      }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    assert.strictEqual(diff.priorityProjects.length, 2);
    assert.strictEqual(diff.priorityProjects[0].repo, "repo-b",
      "repo-b (higher pipeline weight) should rank first");
    assert.strictEqual(diff.priorityProjects[1].repo, "repo-a");
  });

  test("falls back to computing pipeline weight from maxWeight + mentionCounts when pipelineWeights absent", () => {
    const resume = makeResume();
    // Same maxWeight but different mention counts; no pipelineWeights supplied
    const workLog = makeWorkLog({
      prBranchSignals: {
        projectWeights: { "repo-x": 0.5, "repo-y": 0.5 },
        mentionCounts: { "repo-x": 1, "repo-y": 4 }
        // pipelineWeights intentionally absent — backward-compat path
      }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    assert.strictEqual(diff.priorityProjects.length, 2);
    assert.strictEqual(diff.priorityProjects[0].repo, "repo-y",
      "repo-y (4 mentions → higher computed pipeline weight) should rank first");
    assert.strictEqual(diff.priorityProjects[1].repo, "repo-x");
  });

  test("filter threshold still uses maxWeight (not pipelineWeight) — low-maxWeight repo excluded", () => {
    const resume = makeResume();
    // repo-low has maxWeight 0.1 (below 0.25 threshold) but many mentions
    // The filter should still exclude it because maxWeight < 0.25
    const workLog = makeWorkLog({
      prBranchSignals: {
        projectWeights: { "repo-high": 0.75, "repo-low": 0.1 },
        pipelineWeights: { "repo-high": 1.5, "repo-low": 2.0 }, // pipeline weight boosted by count
        mentionCounts: { "repo-high": 2, "repo-low": 20 }
      }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    assert.strictEqual(diff.priorityProjects.length, 1, "repo-low must be excluded (maxWeight 0.1 < 0.25)");
    assert.strictEqual(diff.priorityProjects[0].repo, "repo-high");
  });

  test("priority projects sorted by pipeline weight with mixed maxWeights", () => {
    const resume = makeResume();
    // repo-c: maxWeight=1.0, 1 mention → pipelineWeight=1.0
    // repo-d: maxWeight=0.5, 4 mentions → pipelineWeight=0.5×2=1.0 (tie, then stable)
    // repo-e: maxWeight=0.75, 2 mentions → pipelineWeight=0.75×1.5=1.125
    const workLog = makeWorkLog({
      prBranchSignals: {
        projectWeights: { "repo-c": 1.0, "repo-d": 0.5, "repo-e": 0.75 },
        pipelineWeights: { "repo-c": 1.0, "repo-d": 1.0, "repo-e": 1.125 },
        mentionCounts: { "repo-c": 1, "repo-d": 4, "repo-e": 2 }
      }
    });
    const diff = buildWorkLogDiff(workLog, resume);

    assert.strictEqual(diff.priorityProjects.length, 3);
    assert.strictEqual(diff.priorityProjects[0].repo, "repo-e",
      "repo-e (pipelineWeight=1.125) should rank first");
    // repo-c and repo-d both have pipelineWeight=1.0; stable sort preserves object entry order
    const second = diff.priorityProjects[1].repo;
    const third = diff.priorityProjects[2].repo;
    assert.ok(
      (second === "repo-c" && third === "repo-d") || (second === "repo-d" && third === "repo-c"),
      `Expected repo-c and repo-d as 2nd/3rd (in any order), got ${second}, ${third}`
    );
  });
});

// ─── extractResumeUpdatesFromWorkLog guard tests ───────────────────────────────

describe("extractResumeUpdatesFromWorkLog — guards", () => {
  test("throws when OPENAI_API_KEY is missing", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await assert.rejects(
        () => extractResumeUpdatesFromWorkLog(makeWorkLog(), makeResume()),
        /OPENAI_API_KEY is not set/
      );
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    }
  });

  test("throws when WORK_LOG_DISABLE_OPENAI=1", async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    const savedDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
    try {
      await assert.rejects(
        () => extractResumeUpdatesFromWorkLog(makeWorkLog(), makeResume()),
        /OpenAI integration is disabled/
      );
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
      else delete process.env.OPENAI_API_KEY;
      if (savedDisable !== undefined) process.env.WORK_LOG_DISABLE_OPENAI = savedDisable;
      else delete process.env.WORK_LOG_DISABLE_OPENAI;
    }
  });

  test("returns empty extract (no LLM call) when no new candidates exist", async () => {
    // When all work log content is already in the resume, the function should
    // short-circuit and return an empty extract without making an LLM call.
    const resume = makeResume();
    const workLog = makeWorkLog({
      highlights: {
        businessOutcomes: [],
        keyChanges: [],
        accomplishments: [],
        commitHighlights: []
      },
      resume: {
        candidates: ["Led migration to microservices."], // already in resume
        companyCandidates: [],
        openSourceCandidates: []
      }
    });

    // Even with an API key set, if buildWorkLogDiff returns no raw candidates,
    // extractResumeUpdatesFromWorkLog must return empty without LLM call.
    const savedKey = process.env.OPENAI_API_KEY;
    const savedDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.OPENAI_API_KEY = "test-key-for-short-circuit";
    delete process.env.WORK_LOG_DISABLE_OPENAI;

    try {
      const result = await extractResumeUpdatesFromWorkLog(workLog, resume);

      // Must return the canonical empty shape — no error, no LLM call attempted
      assert.deepStrictEqual(result.experienceUpdates, []);
      assert.deepStrictEqual(result.newSkills, {
        technical: [],
        languages: [],
        tools: []
      });
      assert.strictEqual(result.summaryUpdate, null);
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
      else delete process.env.OPENAI_API_KEY;
      if (savedDisable !== undefined) process.env.WORK_LOG_DISABLE_OPENAI = savedDisable;
      else delete process.env.WORK_LOG_DISABLE_OPENAI;
    }
  });
});
