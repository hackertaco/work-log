/**
 * Tests for bulletQualityHarness.mjs
 *
 * Run with: node --test src/lib/bulletQualityHarness.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  GOLDEN_BULLET_PAIRS,
  QUALITY_TARGET_RATE,
  MODIFICATION_THRESHOLD,
  runOfflineEvaluation,
  runGoldenSetEvaluation,
  runFullEvaluation,
  formatReport,
  formatReportJSON,
  loadLiveBulletPairs,
  loadCandidateVsResumePairs,
  runCLI,
  _testing,
} from "./bulletQualityHarness.mjs";

// ─── Golden Bullet Pairs ────────────────────────────────────────────────────

describe("GOLDEN_BULLET_PAIRS", () => {
  it("contains at least 10 pairs", () => {
    assert.ok(
      GOLDEN_BULLET_PAIRS.length >= 10,
      `Expected >=10 golden pairs, got ${GOLDEN_BULLET_PAIRS.length}`
    );
  });

  it("contains episode-based pairs with decision reasoning", () => {
    const episodePairs = GOLDEN_BULLET_PAIRS.filter(
      (p) => p.id >= "golden-13" && p.id <= "golden-17"
    );
    assert.ok(
      episodePairs.length >= 4,
      `Expected >=4 episode-based pairs, got ${episodePairs.length}`
    );
  });

  it("each pair has required fields", () => {
    for (const pair of GOLDEN_BULLET_PAIRS) {
      assert.ok(pair.id, `Pair missing id`);
      assert.ok(pair.generated, `${pair.id}: missing generated text`);
      assert.ok(pair.reference, `${pair.id}: missing reference text`);
      assert.ok(typeof pair.expectedUsable === "boolean", `${pair.id}: expectedUsable must be boolean`);
    }
  });

  it("has a mix of usable and not-usable pairs", () => {
    const usable = GOLDEN_BULLET_PAIRS.filter((p) => p.expectedUsable);
    const notUsable = GOLDEN_BULLET_PAIRS.filter((p) => !p.expectedUsable);
    assert.ok(usable.length >= 3, `Need at least 3 usable pairs, got ${usable.length}`);
    assert.ok(notUsable.length >= 2, `Need at least 2 not-usable pairs, got ${notUsable.length}`);
  });

  it("includes diverse categories", () => {
    const categories = new Set(GOLDEN_BULLET_PAIRS.map((p) => p.category));
    assert.ok(categories.has("pristine"), "Missing pristine category");
    assert.ok(categories.has("minor_edit"), "Missing minor_edit category");
    assert.ok(categories.has("moderate_edit"), "Missing moderate_edit category");
    assert.ok(categories.has("rewritten"), "Missing rewritten category");
  });
});

// ─── Configuration Constants ────────────────────────────────────────────────

describe("configuration", () => {
  it("quality target rate is 0.7 (70%)", () => {
    assert.equal(QUALITY_TARGET_RATE, 0.7);
  });

  it("modification threshold is 0.5 (50%)", () => {
    assert.equal(MODIFICATION_THRESHOLD, 0.5);
  });
});

// ─── runOfflineEvaluation ───────────────────────────────────────────────────

describe("runOfflineEvaluation", () => {
  it("runs on golden set by default when no pairs provided", () => {
    const { scores, report, passed } = runOfflineEvaluation();
    assert.equal(scores.length, GOLDEN_BULLET_PAIRS.length);
    assert.ok(typeof report === "object");
    assert.ok(typeof passed === "boolean");
  });

  it("returns correct structure for each score", () => {
    const { scores } = runOfflineEvaluation();
    for (const score of scores) {
      assert.ok("id" in score);
      assert.ok("generated" in score);
      assert.ok("reference" in score);
      assert.ok("similarity" in score);
      assert.ok("modificationDistance" in score);
      assert.ok("isUsable" in score);
      assert.ok("bucket" in score);
      assert.ok("metrics" in score);
      assert.ok("classificationCorrect" in score);

      // Similarity is in [0, 1]
      assert.ok(score.similarity >= 0 && score.similarity <= 1,
        `similarity ${score.similarity} out of range`);
      assert.ok(score.modificationDistance >= 0 && score.modificationDistance <= 1,
        `modificationDistance ${score.modificationDistance} out of range`);

      // modificationDistance = 1 - similarity
      assert.ok(
        Math.abs(score.modificationDistance - (1 - score.similarity)) < 0.001,
        `modificationDistance should equal 1 - similarity`
      );
    }
  });

  it("report has all required fields", () => {
    const { report } = runOfflineEvaluation();
    assert.ok("totalBullets" in report);
    assert.ok("usableBullets" in report);
    assert.ok("usableRate" in report);
    assert.ok("qualityTargetRate" in report);
    assert.ok("modificationThreshold" in report);
    assert.ok("passed" in report);
    assert.ok("meanSimilarity" in report);
    assert.ok("meanModificationDistance" in report);
    assert.ok("percentiles" in report);
    assert.ok("distribution" in report);
    assert.ok("distributionRates" in report);
    assert.ok("classificationAccuracy" in report);
    assert.ok("failedBullets" in report);
  });

  it("correctly classifies identical bullets as usable", () => {
    const pairs = [
      {
        generated: "Built a REST API for user management",
        reference: "Built a REST API for user management",
        expectedUsable: true,
      },
    ];
    const { scores } = runOfflineEvaluation(pairs);
    assert.equal(scores[0].similarity, 1.0);
    assert.equal(scores[0].modificationDistance, 0);
    assert.ok(scores[0].isUsable);
  });

  it("correctly classifies completely different bullets as not usable", () => {
    const pairs = [
      {
        generated: "Fixed a typo in the README",
        reference: "Architected a distributed event-driven microservices platform handling 100K requests per second with automatic failover",
        expectedUsable: false,
      },
    ];
    const { scores } = runOfflineEvaluation(pairs);
    assert.ok(scores[0].modificationDistance > MODIFICATION_THRESHOLD,
      `Expected modification distance > ${MODIFICATION_THRESHOLD}, got ${scores[0].modificationDistance}`);
    assert.ok(!scores[0].isUsable);
  });

  it("passes with 100% usable pairs", () => {
    const pairs = [
      { generated: "Built API", reference: "Built API" },
      { generated: "Shipped feature X", reference: "Shipped feature X" },
      { generated: "Led team of 5", reference: "Led team of 5" },
    ];
    const { passed, report } = runOfflineEvaluation(pairs);
    assert.ok(passed);
    assert.equal(report.usableRate, 1.0);
  });

  it("fails when usable rate is below target", () => {
    const pairs = [
      // 1 usable
      { generated: "Built API", reference: "Built API" },
      // 3 not usable (completely different)
      { generated: "Task A", reference: "Architected distributed system with event sourcing and CQRS" },
      { generated: "Task B", reference: "Designed ML pipeline for real-time fraud detection at scale" },
      { generated: "Task C", reference: "Built automated compliance monitoring for financial regulations" },
    ];
    const { passed, report } = runOfflineEvaluation(pairs);
    assert.ok(!passed, `Expected fail with usable rate ${report.usableRate}`);
  });

  it("supports custom quality target rate", () => {
    const pairs = [
      { generated: "Built API", reference: "Built API" },
      { generated: "Task A", reference: "Completely different thing about something else entirely" },
    ];
    // 50% usable rate — passes with 0.4 target, fails with 0.7
    const passResult = runOfflineEvaluation(pairs, { qualityTargetRate: 0.4 });
    assert.ok(passResult.passed);

    const failResult = runOfflineEvaluation(pairs, { qualityTargetRate: 0.7 });
    assert.ok(!failResult.passed);
  });

  it("reports classification accuracy for golden set pairs", () => {
    const { report } = runOfflineEvaluation();
    assert.ok(report.classificationAccuracy !== null);
    assert.ok(report.classifiedCount > 0);
    assert.equal(report.classifiedCount, GOLDEN_BULLET_PAIRS.length);
  });

  it("reports failed bullets list", () => {
    const { report } = runOfflineEvaluation();
    // The golden set has rewritten pairs that should fail
    assert.ok(report.failedBullets.length >= 1,
      "Expected at least 1 failed bullet from golden set");
    for (const fb of report.failedBullets) {
      assert.ok(fb.modificationDistance > MODIFICATION_THRESHOLD);
      assert.ok(fb.generated);
      assert.ok(fb.reference);
    }
  });

  it("distribution counts sum to total", () => {
    const { report } = runOfflineEvaluation();
    const total =
      report.distribution.pristine +
      report.distribution.minor_edit +
      report.distribution.moderate_edit +
      report.distribution.rewritten;
    assert.equal(total, report.totalBullets);
  });

  it("percentiles are in ascending order", () => {
    const { report } = runOfflineEvaluation();
    assert.ok(report.percentiles.p25 <= report.percentiles.p50);
    assert.ok(report.percentiles.p50 <= report.percentiles.p75);
  });
});

// ─── runGoldenSetEvaluation ─────────────────────────────────────────────────

describe("runGoldenSetEvaluation", () => {
  it("returns passed, summary string, and report", async () => {
    const result = await runGoldenSetEvaluation();
    assert.ok(typeof result.passed === "boolean");
    assert.ok(typeof result.summary === "string");
    assert.ok(result.summary.length > 0);
    assert.ok(typeof result.report === "object");
    assert.ok(Array.isArray(result.scores));
  });
});

// ─── formatReport ───────────────────────────────────────────────────────────

describe("formatReport", () => {
  it("produces human-readable output", () => {
    const { report } = runOfflineEvaluation();
    const text = formatReport(report);
    assert.ok(text.includes("Bullet Quality Evaluation Report"));
    assert.ok(text.includes("Usable rate:"));
    assert.ok(text.includes("Quality target"));
    assert.ok(text.includes("Mean similarity:"));
    assert.ok(text.includes("Quality Distribution"));
  });

  it("shows PASSED when quality target met", () => {
    const pairs = [
      { generated: "Built API", reference: "Built API" },
      { generated: "Shipped feature", reference: "Shipped feature" },
    ];
    const { report } = runOfflineEvaluation(pairs);
    const text = formatReport(report);
    assert.ok(text.includes("PASSED"));
  });

  it("shows FAILED when quality target not met", () => {
    const pairs = [
      { generated: "A", reference: "Completely different long bullet about enterprise architecture and distributed systems" },
    ];
    const { report } = runOfflineEvaluation(pairs);
    const text = formatReport(report);
    assert.ok(text.includes("FAILED"));
  });

  it("includes classification accuracy for golden set", () => {
    const { report } = runOfflineEvaluation();
    const text = formatReport(report);
    assert.ok(text.includes("Classification accuracy"));
  });

  it("includes failed bullets section when present", () => {
    const { report } = runOfflineEvaluation();
    if (report.failedBullets.length > 0) {
      const text = formatReport(report);
      assert.ok(text.includes("Failed Bullets"));
    }
  });
});

// ─── formatReportJSON ──────────────────────────────────────────────────────

describe("formatReportJSON", () => {
  it("produces valid JSON", () => {
    const result = runOfflineEvaluation();
    const json = formatReportJSON(result);
    const parsed = JSON.parse(json);
    assert.ok(typeof parsed === "object");
  });

  it("includes required CI fields", () => {
    const result = runOfflineEvaluation();
    const parsed = JSON.parse(formatReportJSON(result));

    assert.ok("passed" in parsed);
    assert.ok("timestamp" in parsed);
    assert.ok("qualityTarget" in parsed);
    assert.ok("modificationThreshold" in parsed);
    assert.ok("summary" in parsed);
    assert.ok("distribution" in parsed);
    assert.ok("percentiles" in parsed);

    assert.equal(parsed.qualityTarget, QUALITY_TARGET_RATE);
    assert.equal(parsed.modificationThreshold, MODIFICATION_THRESHOLD);
    assert.ok(typeof parsed.summary.totalBullets === "number");
    assert.ok(typeof parsed.summary.usableBullets === "number");
    assert.ok(typeof parsed.summary.usableRate === "number");
  });

  it("includes per-bullet scores when requested", () => {
    const result = runOfflineEvaluation();
    const parsed = JSON.parse(formatReportJSON(result, { includeScores: true }));

    assert.ok(Array.isArray(parsed.scores));
    assert.equal(parsed.scores.length, GOLDEN_BULLET_PAIRS.length);
    for (const score of parsed.scores) {
      assert.ok("id" in score);
      assert.ok("similarity" in score);
      assert.ok("modificationDistance" in score);
      assert.ok("isUsable" in score);
      assert.ok("bucket" in score);
    }
  });

  it("excludes scores by default", () => {
    const result = runOfflineEvaluation();
    const parsed = JSON.parse(formatReportJSON(result));
    assert.ok(!("scores" in parsed));
  });

  it("supports pretty printing", () => {
    const result = runOfflineEvaluation();
    const compact = formatReportJSON(result);
    const pretty = formatReportJSON(result, { pretty: true });
    assert.ok(pretty.includes("\n"));
    assert.ok(pretty.length > compact.length);
  });

  it("handles full evaluation results with combined/live/candidate fields", () => {
    // Simulate a full evaluation result
    const golden = runOfflineEvaluation();
    const fullResult = {
      golden: { passed: golden.passed, report: golden.report, scores: golden.scores },
      combined: { totalBullets: 17, usableBullets: 12, usableRate: 0.7059, passed: true },
      live: { pairsFound: 3, report: { usableRate: 0.667 } },
      candidates: { pairsFound: 2, report: { usableRate: 0.5 } },
    };
    const parsed = JSON.parse(formatReportJSON(fullResult));
    assert.ok(parsed.combined);
    assert.ok(parsed.live);
    assert.ok(parsed.candidates);
    assert.equal(parsed.combined.totalBullets, 17);
    assert.equal(parsed.live.pairsFound, 3);
    assert.equal(parsed.candidates.pairsFound, 2);
  });
});

// ─── _normalizePairs ────────────────────────────────────────────────────────

describe("_normalizePairs", () => {
  const { _normalizePairs } = _testing;

  it("defaults to golden set when null/empty", () => {
    const result = _normalizePairs(null);
    assert.equal(result.length, GOLDEN_BULLET_PAIRS.length);
  });

  it("defaults to golden set for empty array", () => {
    const result = _normalizePairs([]);
    assert.equal(result.length, GOLDEN_BULLET_PAIRS.length);
  });

  it("normalizes custom pairs with auto-generated IDs", () => {
    const pairs = [
      { generated: "A", reference: "B" },
      { generated: "C", reference: "D" },
    ];
    const result = _normalizePairs(pairs);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "pair-1");
    assert.equal(result[1].id, "pair-2");
    assert.equal(result[0].generated, "A");
    assert.equal(result[0].reference, "B");
  });

  it("preserves explicit IDs", () => {
    const pairs = [{ id: "my-id", generated: "A", reference: "B" }];
    const result = _normalizePairs(pairs);
    assert.equal(result[0].id, "my-id");
  });

  it("accepts 'final' as alias for 'reference'", () => {
    const pairs = [{ generated: "A", final: "B" }];
    const result = _normalizePairs(pairs);
    assert.equal(result[0].reference, "B");
  });

  it("accepts 'edited' as alias for 'reference'", () => {
    const pairs = [{ generated: "A", edited: "B" }];
    const result = _normalizePairs(pairs);
    assert.equal(result[0].reference, "B");
  });
});

// ─── _buildEvalReport ───────────────────────────────────────────────────────

describe("_buildEvalReport", () => {
  const { _buildEvalReport } = _testing;

  it("returns empty report for zero scores", () => {
    const report = _buildEvalReport([], 0.7, 0.5);
    assert.equal(report.totalBullets, 0);
    assert.equal(report.passed, false);
  });

  it("correctly computes usable rate", () => {
    const scores = [
      { similarity: 1.0, modificationDistance: 0, isUsable: true, bucket: "pristine", classificationCorrect: true },
      { similarity: 0.8, modificationDistance: 0.2, isUsable: true, bucket: "moderate_edit", classificationCorrect: true },
      { similarity: 0.3, modificationDistance: 0.7, isUsable: false, bucket: "rewritten", classificationCorrect: true },
    ];
    const report = _buildEvalReport(scores, 0.7, 0.5);
    assert.equal(report.totalBullets, 3);
    assert.equal(report.usableBullets, 2);
    // 2/3 ≈ 0.6667
    assert.ok(Math.abs(report.usableRate - 0.6667) < 0.001);
    assert.ok(!report.passed); // 66.7% < 70%
  });

  it("passes when usable rate meets target", () => {
    const scores = [
      { similarity: 1.0, modificationDistance: 0, isUsable: true, bucket: "pristine", classificationCorrect: true },
      { similarity: 0.9, modificationDistance: 0.1, isUsable: true, bucket: "minor_edit", classificationCorrect: true },
      { similarity: 0.6, modificationDistance: 0.4, isUsable: true, bucket: "moderate_edit", classificationCorrect: true },
    ];
    const report = _buildEvalReport(scores, 0.7, 0.5);
    assert.ok(report.passed); // 100% >= 70%
  });
});

// ─── Live Data Loading Helpers ──────────────────────────────────────────────

describe("_extractBulletsWithSource", () => {
  const { _extractBulletsWithSource } = _testing;

  it("extracts bullets from experience section", () => {
    const snapshot = {
      experience: [
        {
          bullets: [
            { text: "Built API", _source: "system" },
            { text: "Led team of 5", _source: "user" },
          ],
        },
      ],
    };
    const bullets = _extractBulletsWithSource(snapshot);
    assert.equal(bullets.length, 2);
    assert.equal(bullets[0].text, "Built API");
    assert.equal(bullets[0].source, "system");
    assert.equal(bullets[1].source, "user");
  });

  it("extracts string-only bullets as system-sourced", () => {
    const snapshot = {
      experience: [{ bullets: ["Simple string bullet"] }],
    };
    const bullets = _extractBulletsWithSource(snapshot);
    assert.equal(bullets.length, 1);
    assert.equal(bullets[0].text, "Simple string bullet");
    assert.equal(bullets[0].source, "system");
  });

  it("extracts from projects section", () => {
    const snapshot = {
      projects: [
        { bullets: [{ text: "Built feature X", _source: "user" }] },
      ],
    };
    const bullets = _extractBulletsWithSource(snapshot);
    assert.equal(bullets.length, 1);
    assert.equal(bullets[0].source, "user");
  });

  it("handles empty/missing sections gracefully", () => {
    assert.deepEqual(_extractBulletsWithSource({}), []);
    assert.deepEqual(_extractBulletsWithSource({ experience: null }), []);
    assert.deepEqual(_extractBulletsWithSource({ experience: [] }), []);
  });
});

describe("_findClosestSystemBullet", () => {
  const { _findClosestSystemBullet } = _testing;

  it("finds the closest matching system bullet", () => {
    const bullets = [
      { text: "Built a REST API for user management", source: "system" },
      { text: "Led team of 5 engineers", source: "system" },
      { text: "Deployed to production", source: "user" },
    ];
    const match = _findClosestSystemBullet("Built a REST API for user authentication", bullets);
    assert.ok(match);
    assert.ok(match.text.includes("REST API"));
    assert.ok(match.similarity > 0.5);
  });

  it("ignores user-sourced bullets", () => {
    const bullets = [
      { text: "Exact match text here", source: "user" },
      { text: "Something else entirely", source: "system" },
    ];
    const match = _findClosestSystemBullet("Exact match text here", bullets);
    assert.ok(match);
    assert.equal(match.text, "Something else entirely");
  });

  it("returns null when no system bullets exist", () => {
    const bullets = [{ text: "Only user bullet", source: "user" }];
    const match = _findClosestSystemBullet("test", bullets);
    assert.equal(match, null);
  });
});

// ─── loadLiveBulletPairs ────────────────────────────────────────────────────

describe("loadLiveBulletPairs", () => {
  let tmpDir;

  function setup() {
    tmpDir = join(tmpdir(), `bqh-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  }

  function cleanup() {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("returns empty array for nonexistent directory", () => {
    const pairs = loadLiveBulletPairs({ resumeDir: "/nonexistent/path" });
    assert.deepEqual(pairs, []);
  });

  it("returns empty array when fewer than 2 snapshots", () => {
    setup();
    try {
      writeFileSync(join(tmpDir, "2026-03-30.json"), JSON.stringify({ experience: [] }));
      const pairs = loadLiveBulletPairs({ resumeDir: tmpDir });
      assert.deepEqual(pairs, []);
    } finally {
      cleanup();
    }
  });

  it("detects system→user edits across consecutive snapshots", () => {
    setup();
    try {
      const snap1 = {
        experience: [{
          bullets: [
            { text: "Built automated CI/CD pipeline with GitHub Actions for the frontend monorepo", _source: "system" },
            { text: "Led migration of REST API to GraphQL", _source: "system" },
          ],
        }],
      };
      const snap2 = {
        experience: [{
          bullets: [
            { text: "Built CI/CD pipeline with GitHub Actions for the frontend monorepo, cutting deploy time to 12 minutes", _source: "user" },
            { text: "Led migration of REST API to GraphQL", _source: "system" },
          ],
        }],
      };
      writeFileSync(join(tmpDir, "2026-03-29.json"), JSON.stringify(snap1));
      writeFileSync(join(tmpDir, "2026-03-30.json"), JSON.stringify(snap2));

      const pairs = loadLiveBulletPairs({ resumeDir: tmpDir });
      assert.ok(pairs.length >= 1, `Expected at least 1 pair, got ${pairs.length}`);
      assert.equal(pairs[0].category, "live_edit");
      assert.ok(pairs[0].id.startsWith("live-"));
    } finally {
      cleanup();
    }
  });

  it("respects maxPairs limit", () => {
    setup();
    try {
      const bullets = Array.from({ length: 20 }, (_, i) => ({
        text: `System bullet number ${i} about feature ${i}`,
        _source: "system",
      }));
      const editedBullets = bullets.map((b, i) => ({
        text: `User edited bullet number ${i} about feature ${i} with improvements`,
        _source: "user",
      }));
      writeFileSync(join(tmpDir, "2026-03-29.json"), JSON.stringify({ experience: [{ bullets }] }));
      writeFileSync(join(tmpDir, "2026-03-30.json"), JSON.stringify({ experience: [{ bullets: editedBullets }] }));

      const pairs = loadLiveBulletPairs({ resumeDir: tmpDir, maxPairs: 3 });
      assert.ok(pairs.length <= 3, `Expected <=3 pairs, got ${pairs.length}`);
    } finally {
      cleanup();
    }
  });
});

// ─── loadCandidateVsResumePairs ─────────────────────────────────────────────

describe("loadCandidateVsResumePairs", () => {
  let tmpResumeDir;
  let tmpDailyDir;

  function setup() {
    const base = join(tmpdir(), `bqh-cand-${randomUUID()}`);
    tmpResumeDir = join(base, "resume");
    tmpDailyDir = join(base, "daily");
    mkdirSync(tmpResumeDir, { recursive: true });
    mkdirSync(tmpDailyDir, { recursive: true });
  }

  function cleanup() {
    const base = join(tmpResumeDir, "..");
    if (existsSync(base)) {
      rmSync(base, { recursive: true, force: true });
    }
  }

  it("returns empty array for nonexistent directories", () => {
    const pairs = loadCandidateVsResumePairs({
      dailyDir: "/nonexistent",
      resumeDir: "/nonexistent",
    });
    assert.deepEqual(pairs, []);
  });

  it("finds pairs between daily candidates and resume bullets", () => {
    setup();
    try {
      const resume = {
        experience: [{
          bullets: [
            { text: "Built CI/CD pipeline with GitHub Actions for the frontend monorepo, reducing deploy time from 45 to 12 minutes", _source: "user" },
          ],
        }],
      };
      const daily = {
        candidates: [
          "Built automated CI/CD pipeline with GitHub Actions for the frontend monorepo, reducing deploy time from 45 to 12 minutes",
        ],
      };
      writeFileSync(join(tmpResumeDir, "2026-03-30.json"), JSON.stringify(resume));
      writeFileSync(join(tmpDailyDir, "2026-03-30.json"), JSON.stringify(daily));

      const pairs = loadCandidateVsResumePairs({
        resumeDir: tmpResumeDir,
        dailyDir: tmpDailyDir,
      });
      assert.ok(pairs.length >= 1, `Expected >=1 pair, got ${pairs.length}`);
      assert.equal(pairs[0].category, "candidate_vs_final");
    } finally {
      cleanup();
    }
  });

  it("skips short candidates (< 15 chars)", () => {
    setup();
    try {
      const resume = { experience: [{ bullets: [{ text: "Long bullet text about building something", _source: "system" }] }] };
      const daily = { candidates: ["Too short"] };
      writeFileSync(join(tmpResumeDir, "2026-03-30.json"), JSON.stringify(resume));
      writeFileSync(join(tmpDailyDir, "2026-03-30.json"), JSON.stringify(daily));

      const pairs = loadCandidateVsResumePairs({ resumeDir: tmpResumeDir, dailyDir: tmpDailyDir });
      assert.equal(pairs.length, 0);
    } finally {
      cleanup();
    }
  });
});

// ─── runFullEvaluation ──────────────────────────────────────────────────────

describe("runFullEvaluation", () => {
  it("always includes golden set results", async () => {
    const result = await runFullEvaluation({ includeLive: false, includeCandidates: false });
    assert.ok(result.golden);
    assert.ok(typeof result.golden.passed === "boolean");
    assert.ok(result.golden.report);
    assert.ok(Array.isArray(result.golden.scores));
  });

  it("includes combined summary", async () => {
    const result = await runFullEvaluation({ includeLive: false, includeCandidates: false });
    assert.ok(result.combined);
    assert.ok(typeof result.combined.totalBullets === "number");
    assert.ok(typeof result.combined.usableBullets === "number");
    assert.ok(typeof result.combined.usableRate === "number");
    assert.ok(typeof result.combined.passed === "boolean");
  });

  it("gracefully handles missing live/candidate data directories", async () => {
    const result = await runFullEvaluation({
      resumeDir: "/nonexistent/path",
      dailyDir: "/nonexistent/path",
    });
    assert.ok(result.golden); // golden set always works
    assert.ok(!result.live);  // no live data found
    assert.ok(!result.candidates); // no candidate data found
  });
});

// ─── runCLI ─────────────────────────────────────────────────────────────────

describe("runCLI", () => {
  it("runs with default args (golden set offline)", async () => {
    const result = await runCLI(["--quiet"]);
    assert.ok(result);
    assert.ok(typeof result.passed === "boolean");
  });

  it("supports --json flag", async () => {
    // Capture console output
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      await runCLI(["--json"]);
      assert.ok(logs.length > 0);
      const parsed = JSON.parse(logs[0]);
      assert.ok("passed" in parsed);
      assert.ok("summary" in parsed);
    } finally {
      console.log = origLog;
    }
  });

  it("supports --full flag", async () => {
    const result = await runCLI(["--full", "--quiet"]);
    // runCLI with --full returns full evaluation result (or null on error)
    // The quiet flag suppresses output
    assert.ok(result === null || typeof result === "object");
  });
});

// ─── Integration: Golden set quality gate ───────────────────────────────────

describe("golden set quality gate (offline)", () => {
  it("golden set usable pairs are scored as usable by offline metrics", () => {
    const { scores } = runOfflineEvaluation();
    const usableExpected = scores.filter((s) => s.expectedUsable === true);
    const correctlyUsable = usableExpected.filter((s) => s.isUsable);

    // At least 80% of expected-usable pairs should be correctly classified
    const accuracy = correctlyUsable.length / usableExpected.length;
    assert.ok(
      accuracy >= 0.8,
      `Expected >=80% of usable pairs to be classified correctly, got ${(accuracy * 100).toFixed(1)}%`
    );
  });

  it("golden set rewritten pairs are scored as not usable by offline metrics", () => {
    const { scores } = runOfflineEvaluation();
    const rewrittenExpected = scores.filter((s) => s.expectedUsable === false);
    const correctlyRewritten = rewrittenExpected.filter((s) => !s.isUsable);

    // All rewritten pairs should be classified correctly
    assert.equal(
      correctlyRewritten.length,
      rewrittenExpected.length,
      `Some rewritten pairs were incorrectly classified as usable`
    );
  });

  it("reports the usable percentage meeting the ≤50% modification threshold", () => {
    const { report } = runOfflineEvaluation();

    // The report must contain the percentage
    assert.ok(typeof report.usableRate === "number");
    assert.ok(report.usableRate >= 0 && report.usableRate <= 1);

    // Log the result for visibility
    const pct = (report.usableRate * 100).toFixed(1);
    const target = (report.qualityTargetRate * 100).toFixed(0);
    console.log(
      `  [Quality Gate] ${report.usableBullets}/${report.totalBullets} bullets usable (${pct}%) — target: ${target}%`
    );
  });

  it("episode-based golden pairs with decision reasoning are correctly classified", () => {
    // Run only the episode-based pairs (golden-13 through golden-17)
    const episodePairs = GOLDEN_BULLET_PAIRS.filter(
      (p) => p.id >= "golden-13" && p.id <= "golden-17"
    );
    const { scores, report } = runOfflineEvaluation(episodePairs);

    // Verify usable/not-usable classification
    for (const score of scores) {
      if (score.expectedUsable !== null) {
        assert.equal(
          score.isUsable,
          score.expectedUsable,
          `${score.id}: expected ${score.expectedUsable ? "usable" : "not usable"} but got ${score.isUsable ? "usable" : "not usable"} (similarity: ${score.similarity})`
        );
      }
    }

    console.log(
      `  [Episode Pairs] ${report.usableBullets}/${report.totalBullets} usable (${(report.usableRate * 100).toFixed(1)}%)`
    );
  });
});
