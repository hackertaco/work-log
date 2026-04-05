/**
 * Tests for Narrative Threading Pipeline (Sub-AC 2 of AC 4)
 *
 * Covers:
 *   - weaveNarrativeThreads: end-to-end threading
 *   - _buildEvidenceIndex: index construction
 *   - _collectResumeBullets: bullet collection from resume sections
 *   - _annotateBullet: single bullet annotation with multi-signal scoring
 *   - _buildSectionSummaries: section-level theme aggregation
 *   - _computeStrengthCoverage / _computeAxisCoverage: coverage computation
 *   - _extractTokens / _normalizeBulletText / _textSimilarity: text utilities
 *   - Evidence grounding: ungrounded strengths/axes detection
 *   - User-edit neutrality: threading never mutates source data
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  weaveNarrativeThreads,
  _buildEvidenceIndex,
  _collectResumeBullets,
  _annotateBullet,
  _buildSectionSummaries,
  _computeStrengthCoverage,
  _computeAxisCoverage,
  _extractTokens,
  _normalizeBulletText,
  _textSimilarity,
  THREAD_CONFIDENCE_THRESHOLD
} from "./resumeReconstruction.mjs";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeEpisode(id, title, overrides = {}) {
  return {
    id, title,
    summary: overrides.summary ?? "",
    topicTag: overrides.topicTag ?? "topic",
    moduleTag: overrides.moduleTag ?? "module",
    bullets: overrides.bullets ?? [],
    decisionReasoning: overrides.decisionReasoning ?? null,
    dates: overrides.dates ?? [],
    commitSubjects: []
  };
}

function makeProject(id, repo, title, overrides = {}) {
  return {
    id, repo, title,
    description: overrides.description ?? "",
    episodes: overrides.episodes ?? [],
    bullets: overrides.bullets ?? [],
    techTags: overrides.techTags ?? [],
    dateRange: overrides.dateRange ?? "",
    _source: overrides._source ?? "system"
  };
}

function makeStrength(id, label, overrides = {}) {
  return {
    id, label,
    description: overrides.description ?? "",
    frequency: overrides.frequency ?? 2,
    evidenceIds: overrides.evidenceIds ?? [],
    projectIds: overrides.projectIds ?? [],
    repos: overrides.repos ?? [],
    exampleBullets: overrides.exampleBullets ?? [],
    _source: overrides._source ?? "system"
  };
}

function makeAxis(id, label, overrides = {}) {
  return {
    id, label,
    description: overrides.description ?? "",
    strengthIds: overrides.strengthIds ?? [],
    projectIds: overrides.projectIds ?? [],
    repos: overrides.repos ?? [],
    supportingBullets: overrides.supportingBullets ?? [],
    _source: overrides._source ?? "system"
  };
}

function makeResume(overrides = {}) {
  return {
    meta: { language: "en", source: "pdf", generatedAt: "2026-01-01T00:00:00Z", schemaVersion: 1 },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test User", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: "A test developer.",
    experience: overrides.experience ?? [],
    education: [],
    skills: { technical: [], languages: [], tools: [] },
    projects: overrides.projects ?? [],
    certifications: []
  };
}

function makeExtractionResult(repo, projects) {
  return {
    repo,
    projects,
    episodeCount: projects.reduce((sum, p) => sum + (p.episodes?.length || 0), 0),
    extractedAt: "2026-01-01T00:00:00Z"
  };
}

// ─── _extractTokens ─────────────────────────────────────────────────────────

describe("_extractTokens", () => {
  test("extracts lowercase tokens from English text", () => {
    const tokens = _extractTokens("Built a Payment Processing system");
    assert.ok(tokens.includes("built"));
    assert.ok(tokens.includes("payment"));
    assert.ok(tokens.includes("processing"));
    assert.ok(tokens.includes("system"));
  });

  test("handles Korean text", () => {
    const tokens = _extractTokens("결제 시스템 에러 핸들링 구현");
    assert.ok(tokens.includes("결제"));
    assert.ok(tokens.includes("시스템"));
    assert.ok(tokens.includes("에러"));
  });

  test("strips punctuation", () => {
    const tokens = _extractTokens("error-handling, monitoring (dashboard)");
    assert.ok(tokens.includes("error"));
    assert.ok(tokens.includes("handling"));
    assert.ok(tokens.includes("monitoring"));
    assert.ok(tokens.includes("dashboard"));
  });

  test("returns empty array for empty input", () => {
    assert.deepStrictEqual(_extractTokens(""), []);
    assert.deepStrictEqual(_extractTokens(null), []);
    assert.deepStrictEqual(_extractTokens(undefined), []);
  });

  test("deduplicates tokens", () => {
    const tokens = _extractTokens("error error error handling");
    const errorCount = tokens.filter((t) => t === "error").length;
    assert.strictEqual(errorCount, 1);
  });

  test("filters tokens shorter than 2 chars", () => {
    const tokens = _extractTokens("I am a good developer");
    assert.ok(!tokens.includes("a"));
    assert.ok(tokens.includes("am"));
    assert.ok(tokens.includes("good"));
  });
});

// ─── _normalizeBulletText ───────────────────────────────────────────────────

describe("_normalizeBulletText", () => {
  test("lowercases and strips punctuation", () => {
    assert.strictEqual(
      _normalizeBulletText("Built error-handling for payments."),
      "built error handling for payments"
    );
  });

  test("collapses whitespace", () => {
    assert.strictEqual(
      _normalizeBulletText("  multiple   spaces   here  "),
      "multiple spaces here"
    );
  });

  test("handles empty/null input", () => {
    assert.strictEqual(_normalizeBulletText(""), "");
    assert.strictEqual(_normalizeBulletText(null), "");
  });
});

// ─── _textSimilarity ────────────────────────────────────────────────────────

describe("_textSimilarity", () => {
  test("identical texts return 1.0", () => {
    assert.strictEqual(_textSimilarity("hello world", "hello world"), 1);
  });

  test("completely different texts return 0", () => {
    assert.strictEqual(_textSimilarity("alpha beta", "gamma delta"), 0);
  });

  test("partial overlap returns intermediate score", () => {
    const score = _textSimilarity("error handling payment", "error handling monitoring");
    assert.ok(score > 0);
    assert.ok(score < 1);
  });

  test("handles empty inputs", () => {
    assert.strictEqual(_textSimilarity("", "hello"), 0);
    assert.strictEqual(_textSimilarity("hello", ""), 0);
    assert.strictEqual(_textSimilarity("", ""), 0);
  });
});

// ─── _collectResumeBullets ──────────────────────────────────────────────────

describe("_collectResumeBullets", () => {
  test("collects bullets from experience and projects", () => {
    const resume = makeResume({
      experience: [
        { _source: "system", company: "ACME", title: "Dev", bullets: ["Built API", "Fixed bugs"] },
        { _source: "user", company: "BigCo", title: "Lead", bullets: ["Led team"] }
      ],
      projects: [
        { _source: "system", name: "OpenLib", bullets: ["Created library"] }
      ]
    });

    const bullets = _collectResumeBullets(resume);
    assert.strictEqual(bullets.length, 4);
    assert.deepStrictEqual(bullets[0], { text: "Built API", section: "experience", itemIndex: 0, bulletIndex: 0 });
    assert.deepStrictEqual(bullets[3], { text: "Created library", section: "projects", itemIndex: 0, bulletIndex: 0 });
  });

  test("handles empty resume", () => {
    assert.deepStrictEqual(_collectResumeBullets(null), []);
    assert.deepStrictEqual(_collectResumeBullets({}), []);
  });

  test("skips empty/non-string bullets", () => {
    const resume = makeResume({
      experience: [{ bullets: ["Valid", "", null, "  ", "Also valid"] }]
    });
    const bullets = _collectResumeBullets(resume);
    assert.strictEqual(bullets.length, 2);
  });
});

// ─── _buildEvidenceIndex ────────────────────────────────────────────────────

describe("_buildEvidenceIndex", () => {
  test("indexes strength tokens and example bullets", () => {
    const strength = makeStrength("str-0", "Error Handling", {
      description: "Systematic approach to error boundaries",
      exampleBullets: ["Built structured error handling for payment system"]
    });

    const index = _buildEvidenceIndex([strength], [], [], []);
    assert.ok(index.strengthTokenMap.get("error")?.has("str-0"));
    assert.ok(index.strengthTokenMap.get("handling")?.has("str-0"));
    assert.strictEqual(index.strengthBulletMap.size, 1);
  });

  test("indexes axis-strength and axis-project relationships", () => {
    const axis = makeAxis("naxis-0", "Reliability Engineer", {
      strengthIds: ["str-0", "str-1"],
      projectIds: ["proj-0"]
    });

    const index = _buildEvidenceIndex([], [axis], [], []);
    assert.ok(index.axisStrengthMap.get("str-0")?.has("naxis-0"));
    assert.ok(index.axisStrengthMap.get("str-1")?.has("naxis-0"));
    assert.ok(index.axisProjectMap.get("proj-0")?.has("naxis-0"));
  });

  test("indexes episode bullets and tokens", () => {
    const episode = makeEpisode("ep-repo-0", "Payment Error Handling", {
      summary: "Refactored payment error flow",
      topicTag: "payment-errors",
      moduleTag: "api/payments",
      bullets: ["Added retry logic for payment failures"]
    });

    const index = _buildEvidenceIndex([], [], [episode], []);
    assert.ok(index.episodeTokenMap.get("payment")?.has("ep-repo-0"));
    assert.strictEqual(index.episodeBulletMap.size, 1);
  });

  test("builds project-episode mapping", () => {
    const ep = makeEpisode("ep-0", "Test");
    const proj = makeProject("proj-0", "repo", "Project", { episodes: [ep] });

    const index = _buildEvidenceIndex([], [], [ep], [proj]);
    assert.ok(index.projectEpisodeMap.get("proj-0")?.has("ep-0"));
  });
});

// ─── _annotateBullet ────────────────────────────────────────────────────────

describe("_annotateBullet", () => {
  test("matches bullet to strength via direct bullet text match", () => {
    const strength = makeStrength("str-0", "Error Handling", {
      description: "systematic error handling",
      exampleBullets: ["Built structured error handling for payment system"]
    });

    const index = _buildEvidenceIndex([strength], [], [], []);
    const bullet = {
      text: "Built structured error handling for payment system",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 0
    };

    const annotation = _annotateBullet(bullet, index);
    assert.ok(annotation !== null);
    assert.ok(annotation.strengthIds.includes("str-0"));
    assert.ok(annotation.confidence > 0.5);
  });

  test("matches bullet to axis via supporting bullet match", () => {
    const axis = makeAxis("naxis-0", "Reliability Engineer", {
      description: "turns chaos into reliable systems",
      supportingBullets: ["Implemented circuit breaker pattern for microservices"]
    });

    const index = _buildEvidenceIndex([], [axis], [], []);
    const bullet = {
      text: "Implemented circuit breaker pattern for microservices",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 0
    };

    const annotation = _annotateBullet(bullet, index);
    assert.ok(annotation !== null);
    assert.ok(annotation.axisIds.includes("naxis-0"));
  });

  test("matches bullet to strength via token overlap", () => {
    const strength = makeStrength("str-0", "Payment System Reliability", {
      description: "Ensures payment error handling and retry mechanisms are robust"
    });

    const index = _buildEvidenceIndex([strength], [], [], []);
    const bullet = {
      text: "Added payment error retry with exponential backoff for robust handling",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 0
    };

    const annotation = _annotateBullet(bullet, index);
    assert.ok(annotation !== null);
    assert.ok(annotation.strengthIds.includes("str-0"));
  });

  test("inherits axis via transitive strength connection", () => {
    const strength = makeStrength("str-0", "Error Handling Mastery", {
      description: "Error handling and retry patterns",
      exampleBullets: ["Built error retry for payment service"]
    });
    const axis = makeAxis("naxis-0", "Reliability Engineer", {
      strengthIds: ["str-0"],
      description: "reliability through error handling"
    });

    const index = _buildEvidenceIndex([strength], [axis], [], []);
    const bullet = {
      text: "Built error retry for payment service",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 0
    };

    const annotation = _annotateBullet(bullet, index);
    assert.ok(annotation !== null);
    assert.ok(annotation.strengthIds.includes("str-0"));
    // Axis should be inherited via transitive str-0 → naxis-0
    assert.ok(annotation.axisIds.includes("naxis-0"));
  });

  test("matches episode bullets", () => {
    const ep = makeEpisode("ep-0", "Payment Refactor", {
      summary: "refactored payment flow",
      bullets: ["Added structured error boundaries to payment API"]
    });

    const index = _buildEvidenceIndex([], [], [ep], []);
    const bullet = {
      text: "Added structured error boundaries to payment API",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 0
    };

    const annotation = _annotateBullet(bullet, index);
    assert.ok(annotation !== null);
    assert.ok(annotation.episodeIds.includes("ep-0"));
  });
});

// ─── _buildSectionSummaries ─────────────────────────────────────────────────

describe("_buildSectionSummaries", () => {
  test("aggregates dominant strengths and axes per section item", () => {
    const resume = makeResume({
      experience: [
        { company: "ACME", title: "Dev", bullets: ["Bullet A", "Bullet B", "Bullet C"] }
      ]
    });

    const annotations = [
      { section: "experience", itemIndex: 0, bulletIndex: 0, strengthIds: ["str-0", "str-1"], axisIds: ["naxis-0"], episodeIds: [] },
      { section: "experience", itemIndex: 0, bulletIndex: 1, strengthIds: ["str-0"], axisIds: ["naxis-0"], episodeIds: [] },
      { section: "experience", itemIndex: 0, bulletIndex: 2, strengthIds: ["str-1"], axisIds: ["naxis-1"], episodeIds: [] }
    ];

    const summaries = _buildSectionSummaries(resume, annotations);
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].itemLabel, "ACME");
    assert.strictEqual(summaries[0].threadedBulletCount, 3);
    assert.strictEqual(summaries[0].totalBulletCount, 3);
    assert.ok(summaries[0].dominantStrengthIds.includes("str-0"));
    assert.ok(summaries[0].dominantStrengthIds.includes("str-1"));
    assert.ok(summaries[0].dominantAxisIds.includes("naxis-0"));
  });

  test("handles empty resume", () => {
    assert.deepStrictEqual(_buildSectionSummaries(null, []), []);
    assert.deepStrictEqual(_buildSectionSummaries({}, []), []);
  });

  test("skips items with no bullets", () => {
    const resume = makeResume({
      experience: [{ company: "Empty", title: "Dev", bullets: [] }]
    });
    const summaries = _buildSectionSummaries(resume, []);
    assert.strictEqual(summaries.length, 0);
  });
});

// ─── Coverage computation ───────────────────────────────────────────────────

describe("_computeStrengthCoverage", () => {
  test("counts bullets per strength and tracks sections", () => {
    const strengths = [
      makeStrength("str-0", "A"),
      makeStrength("str-1", "B")
    ];

    const annotations = [
      { strengthIds: ["str-0"], axisIds: ["naxis-0"], section: "experience" },
      { strengthIds: ["str-0"], axisIds: [], section: "projects" },
      { strengthIds: ["str-1"], axisIds: ["naxis-0"], section: "experience" }
    ];

    const coverage = _computeStrengthCoverage(strengths, annotations);
    assert.strictEqual(coverage["str-0"].bulletCount, 2);
    assert.ok(coverage["str-0"].sections.includes("experience"));
    assert.ok(coverage["str-0"].sections.includes("projects"));
    assert.strictEqual(coverage["str-1"].bulletCount, 1);
  });

  test("reports zero coverage for unmatched strengths", () => {
    const strengths = [makeStrength("str-0", "Unmatched")];
    const coverage = _computeStrengthCoverage(strengths, []);
    assert.strictEqual(coverage["str-0"].bulletCount, 0);
  });
});

describe("_computeAxisCoverage", () => {
  test("counts bullets per axis and tracks co-occurring strengths", () => {
    const axes = [makeAxis("naxis-0", "Theme A")];

    const annotations = [
      { axisIds: ["naxis-0"], strengthIds: ["str-0"], section: "experience" },
      { axisIds: ["naxis-0"], strengthIds: ["str-1"], section: "experience" }
    ];

    const coverage = _computeAxisCoverage(axes, annotations);
    assert.strictEqual(coverage["naxis-0"].bulletCount, 2);
    assert.ok(coverage["naxis-0"].strengthIds.includes("str-0"));
    assert.ok(coverage["naxis-0"].strengthIds.includes("str-1"));
  });
});

// ─── weaveNarrativeThreads (end-to-end) ─────────────────────────────────────

describe("weaveNarrativeThreads", () => {
  test("returns empty result for null/empty input", () => {
    const result = weaveNarrativeThreads(null);
    assert.deepStrictEqual(result.bulletAnnotations, []);
    assert.deepStrictEqual(result.sectionSummaries, []);
    assert.strictEqual(result.totalAnnotations, 0);
    assert.strictEqual(result.groundedRatio, 1); // vacuously true
    assert.ok(result.threadedAt);
  });

  test("returns empty result for resume with no bullets", () => {
    const result = weaveNarrativeThreads({
      resume: makeResume(),
      strengths: [makeStrength("str-0", "Test")],
      axes: [makeAxis("naxis-0", "Theme")]
    });
    assert.deepStrictEqual(result.bulletAnnotations, []);
    assert.ok(result.ungroundedStrengthIds.includes("str-0"));
    assert.ok(result.ungroundedAxisIds.includes("naxis-0"));
    assert.strictEqual(result.groundedRatio, 0);
  });

  test("threads bullets through strengths and axes with evidence grounding", () => {
    const ep = makeEpisode("ep-repo-0", "Payment Error Handling", {
      summary: "Built error handling for payment flow",
      topicTag: "payment-errors",
      moduleTag: "api/payments",
      bullets: ["Added retry logic with exponential backoff for payment failures"],
      decisionReasoning: "Chose structured error boundaries over quick-fix retries"
    });

    const proj = makeProject("proj-repo-0", "work-log", "Payment System Reliability", {
      description: "Comprehensive error handling for payment processing",
      episodes: [ep],
      bullets: ["Added retry logic with exponential backoff for payment failures"],
      techTags: ["Node.js", "Express"]
    });

    const strength = makeStrength("str-0", "Reliability-First Engineering", {
      description: "Systematic approach to error handling and retry mechanisms in payment systems",
      frequency: 3,
      evidenceIds: ["ep-repo-0"],
      projectIds: ["proj-repo-0"],
      repos: ["work-log"],
      exampleBullets: ["Added retry logic with exponential backoff for payment failures"]
    });

    const axis = makeAxis("naxis-0", "Engineer who turns chaos into reliable systems", {
      description: "Repeatedly builds error handling and retry patterns to stabilize payment and operational systems",
      strengthIds: ["str-0"],
      projectIds: ["proj-repo-0"],
      repos: ["work-log"],
      supportingBullets: ["Added retry logic with exponential backoff for payment failures"]
    });

    const resume = makeResume({
      experience: [{
        _source: "system",
        company: "TechCo",
        title: "Backend Engineer",
        bullets: [
          "Added retry logic with exponential backoff for payment failures",
          "Designed user authentication with OAuth2"
        ]
      }]
    });

    const result = weaveNarrativeThreads({
      resume,
      strengths: [strength],
      axes: [axis],
      extractionResults: [makeExtractionResult("work-log", [proj])]
    });

    assert.ok(result.totalAnnotations > 0, "should have at least 1 annotation");

    const paymentAnnotation = result.bulletAnnotations.find(
      (a) => a.bulletText.includes("retry logic")
    );
    assert.ok(paymentAnnotation, "payment bullet should be annotated");
    assert.ok(paymentAnnotation.strengthIds.includes("str-0"), "should link to strength");
    assert.ok(paymentAnnotation.episodeIds.includes("ep-repo-0"), "should link to episode");

    assert.ok(result.strengthCoverage["str-0"].bulletCount > 0, "strength should be grounded");

    assert.ok(result.sectionSummaries.length > 0, "should have section summaries");
    const expSummary = result.sectionSummaries.find((s) => s.section === "experience");
    assert.ok(expSummary, "should have experience summary");
    assert.strictEqual(expSummary.itemLabel, "TechCo");
  });

  test("detects ungrounded strengths and axes", () => {
    const resume = makeResume({
      experience: [{
        company: "ACME",
        title: "Dev",
        bullets: ["Built a user authentication system with OAuth2 and JWT tokens"]
      }]
    });

    const unmatchedStrength = makeStrength("str-99", "Machine Learning Optimization", {
      description: "Optimizing neural network training pipelines for large-scale deployments"
    });

    const unmatchedAxis = makeAxis("naxis-99", "AI/ML Pioneer", {
      description: "Pushing boundaries of machine learning in production environments",
      strengthIds: ["str-99"]
    });

    const result = weaveNarrativeThreads({
      resume,
      strengths: [unmatchedStrength],
      axes: [unmatchedAxis]
    });

    assert.ok(result.ungroundedStrengthIds.includes("str-99"), "ML strength should be ungrounded");
    assert.ok(result.ungroundedAxisIds.includes("naxis-99"), "ML axis should be ungrounded");
    assert.strictEqual(result.groundedRatio, 0);
  });

  test("user-edited bullets are annotated without mutation", () => {
    const strength = makeStrength("str-0", "API Design Excellence", {
      description: "Clean API design with proper error handling",
      exampleBullets: ["Designed RESTful API with comprehensive error responses"]
    });

    const resume = makeResume({
      experience: [{
        _source: "user",
        company: "UserCo",
        title: "Dev",
        bullets: ["Designed RESTful API with comprehensive error responses"]
      }]
    });

    const resumeCopy = JSON.parse(JSON.stringify(resume));

    const result = weaveNarrativeThreads({
      resume,
      strengths: [strength],
      axes: []
    });

    assert.ok(result.bulletAnnotations.length > 0, "user bullets should be threaded");
    assert.deepStrictEqual(resume, resumeCopy, "resume should not be mutated");
  });

  test("handles cross-section threading", () => {
    const strength = makeStrength("str-0", "Error Handling", {
      description: "Building robust error handling across systems",
      exampleBullets: [
        "Added error boundaries to payment processing",
        "Implemented error tracking for open source library"
      ]
    });

    const resume = makeResume({
      experience: [{
        company: "WorkCo",
        title: "Dev",
        bullets: ["Added error boundaries to payment processing"]
      }],
      projects: [{
        name: "OSS Lib",
        bullets: ["Implemented error tracking for open source library"]
      }]
    });

    const result = weaveNarrativeThreads({
      resume,
      strengths: [strength],
      axes: []
    });

    const coverage = result.strengthCoverage["str-0"];
    assert.strictEqual(coverage.bulletCount, 2);
    assert.ok(coverage.sections.includes("experience"));
    assert.ok(coverage.sections.includes("projects"));
  });

  test("confidence threshold is 0.3", () => {
    assert.strictEqual(THREAD_CONFIDENCE_THRESHOLD, 0.3);
  });

  test("groundedRatio is 1.0 when all strengths and axes have annotations", () => {
    const strength = makeStrength("str-0", "Payment Reliability", {
      description: "payment error retry handling",
      exampleBullets: ["Built payment retry system"]
    });
    const axis = makeAxis("naxis-0", "Reliability Theme", {
      description: "payment reliability pattern",
      strengthIds: ["str-0"],
      supportingBullets: ["Built payment retry system"]
    });

    const resume = makeResume({
      experience: [{
        company: "Co",
        title: "Dev",
        bullets: ["Built payment retry system"]
      }]
    });

    const result = weaveNarrativeThreads({
      resume,
      strengths: [strength],
      axes: [axis]
    });

    assert.strictEqual(result.groundedRatio, 1);
    assert.deepStrictEqual(result.ungroundedStrengthIds, []);
    assert.deepStrictEqual(result.ungroundedAxisIds, []);
  });
});
