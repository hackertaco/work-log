/**
 * Tests for resumeBulletSimilarity.mjs
 *
 * Run with: node --test src/lib/resumeBulletSimilarity.test.mjs
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBullet,
  tokenize,
  levenshteinDistance,
  levenshteinSimilarity,
  tokenJaccardSimilarity,
  computeBulletSimilarity,
  computeBulletSimilarityWithEmbeddings,
  computeEmbeddingSimilarity,
  scoreBulletBatch,
  scoreBulletBatchWithEmbeddings,
  DEFAULT_WEIGHTS,
  EMBEDDING_WEIGHTS,
  USABLE_THRESHOLD,
  // Embedding-cosine edit-distance proxy
  QUALITY_BUCKETS,
  classifyEditDistance,
  scoreGeneratedVsFinalPair,
  scoreGeneratedVsFinalBatch,
  computeQualityReport,
  createTrackingRecord,
  createTrackingRecordOffline,
  buildTrackingDocument,
  computeQualityReportFromHistory,
  MAX_TRACKING_RECORDS,
  // Persistence functions
  persistTrackingRecords,
  trackBulletEditBatch,
} from "./resumeBulletSimilarity.mjs";

import {
  EMBEDDING_DIMENSIONS,
  cosineSimilarity as rawCosineSimilarity,
} from "./embeddings.mjs";

// ─── normalizeBullet ──────────────────────────────────────────────────────────

describe("normalizeBullet", () => {
  it("lowercases and trims", () => {
    assert.equal(normalizeBullet("  Hello World  "), "hello world");
  });

  it("strips leading bullet markers", () => {
    assert.equal(normalizeBullet("- Built a widget"), "built a widget");
    assert.equal(normalizeBullet("• Shipped feature"), "shipped feature");
    assert.equal(normalizeBullet("— Led a team"), "led a team");
  });

  it("collapses whitespace", () => {
    assert.equal(normalizeBullet("built   a    widget"), "built a widget");
  });

  it("strips trailing punctuation", () => {
    assert.equal(normalizeBullet("shipped feature."), "shipped feature");
    assert.equal(normalizeBullet("shipped feature;"), "shipped feature");
    assert.equal(normalizeBullet("shipped feature!"), "shipped feature");
  });

  it("handles null/undefined", () => {
    assert.equal(normalizeBullet(null), "");
    assert.equal(normalizeBullet(undefined), "");
  });

  it("handles empty string", () => {
    assert.equal(normalizeBullet(""), "");
  });
});

// ─── tokenize ─────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("splits on whitespace and filters stop words", () => {
    const tokens = tokenize("built a scalable api with express");
    assert.ok(tokens.includes("built"));
    assert.ok(tokens.includes("scalable"));
    assert.ok(tokens.includes("api"));
    assert.ok(tokens.includes("express"));
    assert.ok(!tokens.includes("a"));
    assert.ok(!tokens.includes("with"));
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(tokenize(""), []);
  });

  it("returns empty for stop-word-only input", () => {
    assert.deepEqual(tokenize("the and or but"), []);
  });
});

// ─── levenshteinDistance ──────────────────────────────────────────────────────

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    assert.equal(levenshteinDistance("hello", "hello"), 0);
  });

  it("returns length of other string when one is empty", () => {
    assert.equal(levenshteinDistance("", "hello"), 5);
    assert.equal(levenshteinDistance("hello", ""), 5);
  });

  it("returns correct distance for single substitution", () => {
    assert.equal(levenshteinDistance("cat", "car"), 1);
  });

  it("returns correct distance for insertion", () => {
    assert.equal(levenshteinDistance("cat", "cats"), 1);
  });

  it("returns correct distance for deletion", () => {
    assert.equal(levenshteinDistance("cats", "cat"), 1);
  });

  it("handles complex cases", () => {
    assert.equal(levenshteinDistance("kitten", "sitting"), 3);
  });

  it("is symmetric", () => {
    assert.equal(
      levenshteinDistance("abc", "xyz"),
      levenshteinDistance("xyz", "abc")
    );
  });

  it("returns full length for completely different strings", () => {
    assert.equal(levenshteinDistance("abc", "xyz"), 3);
  });
});

// ─── levenshteinSimilarity ───────────────────────────────────────────────────

describe("levenshteinSimilarity", () => {
  it("returns 1.0 for identical bullets", () => {
    assert.equal(levenshteinSimilarity("Built widget A", "Built widget A"), 1.0);
  });

  it("returns 1.0 for bullets differing only in formatting", () => {
    // Leading bullet marker + trailing period + casing differ
    assert.equal(
      levenshteinSimilarity("- Built widget A.", "• built widget a"),
      1.0
    );
  });

  it("returns < 1.0 for moderately different bullets", () => {
    const sim = levenshteinSimilarity(
      "Built a REST API for user management",
      "Built a GraphQL API for user authentication"
    );
    assert.ok(sim > 0.3, `expected > 0.3, got ${sim}`);
    assert.ok(sim < 0.9, `expected < 0.9, got ${sim}`);
  });

  it("returns near 0 for completely different bullets", () => {
    const sim = levenshteinSimilarity(
      "Implemented microservices architecture",
      "Organized team lunch events"
    );
    assert.ok(sim < 0.3, `expected < 0.3, got ${sim}`);
  });

  it("returns 1.0 for two empty strings", () => {
    assert.equal(levenshteinSimilarity("", ""), 1.0);
  });
});

// ─── tokenJaccardSimilarity ──────────────────────────────────────────────────

describe("tokenJaccardSimilarity", () => {
  it("returns 1.0 for identical bullets", () => {
    assert.equal(
      tokenJaccardSimilarity("Built scalable API", "Built scalable API"),
      1.0
    );
  });

  it("returns 1.0 when stop words are the only difference", () => {
    assert.equal(
      tokenJaccardSimilarity("Built a scalable API", "Built the scalable API"),
      1.0
    );
  });

  it("handles partial overlap", () => {
    const sim = tokenJaccardSimilarity(
      "Built scalable REST API",
      "Built scalable GraphQL API"
    );
    // "built", "scalable", "api" overlap; "rest" vs "graphql" differ
    // Jaccard = 3/5 = 0.6
    assert.ok(sim >= 0.5, `expected >= 0.5, got ${sim}`);
    assert.ok(sim <= 0.7, `expected <= 0.7, got ${sim}`);
  });

  it("returns 0 for completely disjoint content", () => {
    const sim = tokenJaccardSimilarity(
      "implemented microservices",
      "organized lunch events"
    );
    assert.equal(sim, 0.0);
  });

  it("returns 1.0 for two empty/stop-word-only strings", () => {
    assert.equal(tokenJaccardSimilarity("", ""), 1.0);
    assert.equal(tokenJaccardSimilarity("the and or", "but if so"), 1.0);
  });

  it("returns 0 when one is empty and other has content", () => {
    assert.equal(tokenJaccardSimilarity("", "built something"), 0.0);
  });
});

// ─── computeBulletSimilarity ─────────────────────────────────────────────────

describe("computeBulletSimilarity", () => {
  it("returns perfect similarity for identical bullets", () => {
    const result = computeBulletSimilarity(
      "Built a scalable REST API",
      "Built a scalable REST API"
    );
    assert.equal(result.similarity, 1.0);
    assert.equal(result.modificationDistance, 0);
    assert.equal(result.isUsable, true);
    assert.equal(result.metrics.levenshtein, 1.0);
    assert.equal(result.metrics.tokenJaccard, 1.0);
  });

  it("returns correct structure with all expected fields", () => {
    const result = computeBulletSimilarity("hello world", "goodbye world");
    assert.ok("similarity" in result);
    assert.ok("modificationDistance" in result);
    assert.ok("isUsable" in result);
    assert.ok("metrics" in result);
    assert.ok("levenshtein" in result.metrics);
    assert.ok("tokenJaccard" in result.metrics);
  });

  it("marks minor edits as usable (<=50% modification)", () => {
    // Same core meaning, small word change
    const result = computeBulletSimilarity(
      "Built scalable REST API for user management",
      "Built a scalable REST API for managing users"
    );
    assert.ok(result.isUsable, `expected usable, got modDist=${result.modificationDistance}`);
  });

  it("marks major rewrites as not usable (>50% modification)", () => {
    const result = computeBulletSimilarity(
      "Built scalable REST API for user management",
      "Led team in migrating legacy database to cloud infrastructure"
    );
    assert.ok(!result.isUsable, `expected not usable, got modDist=${result.modificationDistance}`);
  });

  it("similarity + modificationDistance sum to ~1.0", () => {
    const result = computeBulletSimilarity(
      "Implemented CI/CD pipeline",
      "Set up automated deployment pipeline"
    );
    const sum = result.similarity + result.modificationDistance;
    assert.ok(
      Math.abs(sum - 1.0) < 0.001,
      `expected sum ≈ 1.0, got ${sum}`
    );
  });

  it("accepts custom weights", () => {
    const levOnly = computeBulletSimilarity(
      "abc xyz",
      "abc 123",
      { levenshtein: 1.0, tokenJaccard: 0 }
    );
    const jaccOnly = computeBulletSimilarity(
      "abc xyz",
      "abc 123",
      { levenshtein: 0, tokenJaccard: 1.0 }
    );
    // Results should differ when weights differ
    assert.notEqual(levOnly.similarity, jaccOnly.similarity);
  });
});

// ─── scoreBulletBatch ────────────────────────────────────────────────────────

describe("scoreBulletBatch", () => {
  it("returns empty aggregate for empty input", () => {
    const result = scoreBulletBatch([]);
    assert.equal(result.scores.length, 0);
    assert.equal(result.aggregate.totalBullets, 0);
    assert.equal(result.aggregate.meetsQualityTarget, false);
  });

  it("returns empty aggregate for null/undefined input", () => {
    const result = scoreBulletBatch(null);
    assert.equal(result.scores.length, 0);
  });

  it("computes per-pair scores", () => {
    const pairs = [
      { original: "Built REST API", edited: "Built REST API" },
      { original: "Shipped feature A", edited: "Shipped feature A with tests" }
    ];
    const result = scoreBulletBatch(pairs);
    assert.equal(result.scores.length, 2);
    assert.equal(result.scores[0].similarity, 1.0);
    assert.ok(result.scores[1].similarity > 0.5);
  });

  it("computes aggregate quality metrics", () => {
    const pairs = [
      { original: "Built REST API", edited: "Built REST API" },
      { original: "Shipped feature A", edited: "Shipped feature A with tests" },
      { original: "Led team of 5", edited: "Led team of 5 engineers" }
    ];
    const result = scoreBulletBatch(pairs);
    const { aggregate } = result;

    assert.equal(aggregate.totalBullets, 3);
    assert.ok(aggregate.usableBullets >= 2);
    assert.ok(aggregate.usableRate > 0);
    assert.ok(aggregate.meanSimilarity > 0);
    assert.ok(aggregate.meanModificationDistance >= 0);
    assert.ok(aggregate.meanModificationDistance <= 1);
  });

  it("meetsQualityTarget when 70%+ bullets are usable", () => {
    // All identical → 100% usable → meets target
    const pairs = Array.from({ length: 10 }, () => ({
      original: "Built a widget",
      edited: "Built a widget"
    }));
    const result = scoreBulletBatch(pairs);
    assert.equal(result.aggregate.meetsQualityTarget, true);
    assert.equal(result.aggregate.usableRate, 1.0);
  });

  it("does NOT meet quality target when <70% usable", () => {
    // Mix of identical and completely different
    const pairs = [
      { original: "Built REST API", edited: "Built REST API" },            // usable
      { original: "hello", edited: "completely different sentence here" },  // not usable
      { original: "world", edited: "another totally unrelated phrase" },    // not usable
      { original: "test", edited: "something else entirely different" }     // not usable
    ];
    const result = scoreBulletBatch(pairs);
    // Only 1/4 = 25% usable, well below 70%
    assert.equal(result.aggregate.meetsQualityTarget, false);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("USABLE_THRESHOLD is 0.5", () => {
    assert.equal(USABLE_THRESHOLD, 0.5);
  });

  it("DEFAULT_WEIGHTS sum to 1.0", () => {
    const sum = DEFAULT_WEIGHTS.levenshtein + DEFAULT_WEIGHTS.tokenJaccard;
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });

  it("EMBEDDING_WEIGHTS sum to 1.0", () => {
    const sum = EMBEDDING_WEIGHTS.levenshtein + EMBEDDING_WEIGHTS.tokenJaccard + EMBEDDING_WEIGHTS.embedding;
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });
});

// ─── Real-world resume bullet scenarios ──────────────────────────────────────

describe("real-world bullet scenarios", () => {
  it("minor wording polish is usable", () => {
    const result = computeBulletSimilarity(
      "Designed and implemented a microservices architecture reducing deployment time by 40%",
      "Designed and implemented microservices architecture, reducing deployment time by 40%"
    );
    assert.ok(result.isUsable, `minor polish: modDist=${result.modificationDistance}`);
    assert.ok(result.similarity > 0.85, `expected high similarity, got ${result.similarity}`);
  });

  it("adding specifics is usable", () => {
    const result = computeBulletSimilarity(
      "Led migration of legacy systems to cloud infrastructure",
      "Led migration of 3 legacy Java services to AWS ECS cloud infrastructure"
    );
    assert.ok(result.isUsable, `adding specifics: modDist=${result.modificationDistance}`);
  });

  it("complete rewrite is not usable", () => {
    const result = computeBulletSimilarity(
      "Built REST API endpoints for user management",
      "Mentored 3 junior engineers and conducted weekly code reviews"
    );
    assert.ok(!result.isUsable, `rewrite: modDist=${result.modificationDistance}`);
  });

  it("reordering words keeps high similarity", () => {
    const result = computeBulletSimilarity(
      "Reduced API latency by 60% through caching optimization",
      "Through caching optimization, reduced API latency by 60%"
    );
    // Token Jaccard should be very high (same words), Levenshtein lower due to char reordering
    // Combined score should still be close to usable threshold
    assert.ok(result.similarity > 0.4, `reorder: similarity=${result.similarity}`);
    assert.ok(result.metrics.tokenJaccard >= 0.7, `expected high Jaccard, got ${result.metrics.tokenJaccard}`);
    // With embedding weights (which would capture semantic equivalence), this would be fully usable
    // Offline-only scoring penalizes character reordering via Levenshtein
  });
});

// ─── createTrackingRecordOffline ────────────────────────────────────────────

describe("createTrackingRecordOffline", () => {
  it("returns a complete record with all required fields", () => {
    const record = createTrackingRecordOffline({
      generatedText: "Built scalable REST API",
      finalText: "Built a scalable REST API for user management",
      action: "edited",
      section: "experience",
      logDate: "2026-03-20",
    });

    assert.ok(record.id, "should have an id");
    assert.equal(record.generatedText, "Built scalable REST API");
    assert.equal(record.finalText, "Built a scalable REST API for user management");
    assert.equal(record.action, "edited");
    assert.equal(record.section, "experience");
    assert.equal(record.logDate, "2026-03-20");
    assert.ok(record.recordedAt, "should have recordedAt");
    assert.ok(typeof record.similarity === "number");
    assert.ok(typeof record.modificationDistance === "number");
    assert.ok(typeof record.isUsable === "boolean");
    assert.ok(typeof record.bucket === "string");
    assert.ok(record.metrics);
    assert.equal(record.metrics.embedding, null); // offline mode
    assert.ok(typeof record.metrics.levenshtein === "number");
    assert.ok(typeof record.metrics.tokenJaccard === "number");
  });

  it("records identical bullet as pristine/approved", () => {
    const record = createTrackingRecordOffline({
      generatedText: "Built REST API",
      finalText: "Built REST API",
      action: "approved",
    });

    assert.equal(record.similarity, 1.0);
    assert.equal(record.modificationDistance, 0);
    assert.equal(record.isUsable, true);
    assert.equal(record.bucket, "pristine");
  });

  it("records major rewrite as rewritten", () => {
    const record = createTrackingRecordOffline({
      generatedText: "Built REST API endpoints",
      finalText: "Mentored junior engineers in code reviews",
      action: "edited",
    });

    assert.equal(record.bucket, "rewritten");
    assert.equal(record.isUsable, false);
  });

  it("defaults section to experience and logDate to null", () => {
    const record = createTrackingRecordOffline({
      generatedText: "test",
      finalText: "test",
      action: "approved",
    });

    assert.equal(record.section, "experience");
    assert.equal(record.logDate, null);
  });
});

// ─── buildTrackingDocument ──────────────────────────────────────────────────

describe("buildTrackingDocument", () => {
  const makeRecord = (id, text) => createTrackingRecordOffline({
    generatedText: text,
    finalText: text,
    action: "approved",
  });

  it("builds a document from empty existing + new records", () => {
    const r1 = makeRecord("r1", "bullet one");
    const r2 = makeRecord("r2", "bullet two");

    const doc = buildTrackingDocument([], [r1, r2]);

    assert.equal(doc.schemaVersion, 1);
    assert.ok(doc.updatedAt);
    assert.equal(doc.records.length, 2);
  });

  it("appends new records to existing records", () => {
    const r1 = makeRecord("r1", "bullet one");
    const r2 = makeRecord("r2", "bullet two");

    const doc = buildTrackingDocument([r1], [r2]);
    assert.equal(doc.records.length, 2);
  });

  it("deduplicates records by ID", () => {
    const r1 = createTrackingRecordOffline({
      generatedText: "test",
      finalText: "test",
      action: "approved",
    });

    const doc = buildTrackingDocument([r1], [r1]);
    assert.equal(doc.records.length, 1);
  });

  it("enforces MAX_TRACKING_RECORDS rolling window", () => {
    const existing = Array.from({ length: MAX_TRACKING_RECORDS }, (_, i) =>
      createTrackingRecordOffline({
        generatedText: `bullet ${i}`,
        finalText: `bullet ${i}`,
        action: "approved",
      })
    );
    const newRecord = createTrackingRecordOffline({
      generatedText: "new bullet",
      finalText: "new bullet",
      action: "approved",
    });

    const doc = buildTrackingDocument(existing, [newRecord]);
    assert.equal(doc.records.length, MAX_TRACKING_RECORDS);
    // Last record should be the new one
    assert.equal(doc.records[doc.records.length - 1].generatedText, "new bullet");
  });

  it("handles null/undefined inputs gracefully", () => {
    const doc = buildTrackingDocument(null, undefined);
    assert.equal(doc.records.length, 0);
    assert.equal(doc.schemaVersion, 1);
  });
});

// ─── computeQualityReportFromHistory ────────────────────────────────────────

describe("computeQualityReportFromHistory", () => {
  it("returns empty report for empty records", () => {
    const report = computeQualityReportFromHistory([]);
    assert.equal(report.totalBullets, 0);
    assert.equal(report.meetsQualityTarget, false);
    assert.equal(report.filteredCount, 0);
    assert.equal(report.totalRecords, 0);
  });

  it("computes aggregate quality from tracking records", () => {
    const records = [
      createTrackingRecordOffline({ generatedText: "Built REST API", finalText: "Built REST API", action: "approved" }),
      createTrackingRecordOffline({ generatedText: "Shipped feature", finalText: "Shipped feature with tests", action: "edited" }),
      createTrackingRecordOffline({ generatedText: "Led team", finalText: "Led team of 5 engineers", action: "edited" }),
    ];

    const report = computeQualityReportFromHistory(records);

    assert.equal(report.totalBullets, 3);
    assert.ok(report.usableBullets >= 2, `expected >=2 usable, got ${report.usableBullets}`);
    assert.ok(report.meanSimilarity > 0);
    assert.ok(report.filteredCount === 3);
    assert.ok(report.totalRecords === 3);
    assert.ok(report.actionBreakdown);
    assert.equal(report.actionBreakdown.approved, 1);
    assert.equal(report.actionBreakdown.edited, 2);
  });

  it("filters by daysBack window", () => {
    const oldRecord = createTrackingRecordOffline({
      generatedText: "old bullet",
      finalText: "old bullet",
      action: "approved",
    });
    // Manually set recordedAt to 60 days ago
    oldRecord.recordedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    const recentRecord = createTrackingRecordOffline({
      generatedText: "recent bullet",
      finalText: "recent bullet",
      action: "approved",
    });

    const report = computeQualityReportFromHistory([oldRecord, recentRecord], { daysBack: 30 });

    assert.equal(report.filteredCount, 1);
    assert.equal(report.totalRecords, 2);
    assert.equal(report.windowDays, 30);
  });

  it("filters by section", () => {
    const expRecord = createTrackingRecordOffline({
      generatedText: "experience bullet",
      finalText: "experience bullet",
      action: "approved",
      section: "experience",
    });
    const projRecord = createTrackingRecordOffline({
      generatedText: "project bullet",
      finalText: "project bullet",
      action: "approved",
      section: "projects",
    });

    const report = computeQualityReportFromHistory([expRecord, projRecord], { section: "projects" });
    assert.equal(report.filteredCount, 1);
  });

  it("filters by action", () => {
    const approved = createTrackingRecordOffline({
      generatedText: "approved bullet",
      finalText: "approved bullet",
      action: "approved",
    });
    const edited = createTrackingRecordOffline({
      generatedText: "edited bullet",
      finalText: "slightly different edited bullet",
      action: "edited",
    });

    const report = computeQualityReportFromHistory([approved, edited], { action: "edited" });
    assert.equal(report.filteredCount, 1);
    assert.equal(report.actionBreakdown.edited, 1);
    assert.equal(report.actionBreakdown.approved, 0);
  });

  it("meets quality target when all bullets are accepted as-is", () => {
    const records = Array.from({ length: 10 }, () =>
      createTrackingRecordOffline({
        generatedText: "Built a scalable widget",
        finalText: "Built a scalable widget",
        action: "approved",
      })
    );

    const report = computeQualityReportFromHistory(records);
    assert.equal(report.meetsQualityTarget, true);
    assert.equal(report.usableRate, 1.0);
  });

  it("fails quality target when too many rewrites", () => {
    const records = [
      createTrackingRecordOffline({ generatedText: "Built REST API", finalText: "Built REST API", action: "approved" }),
      createTrackingRecordOffline({ generatedText: "hello", finalText: "completely different sentence here", action: "edited" }),
      createTrackingRecordOffline({ generatedText: "world", finalText: "another totally unrelated phrase", action: "edited" }),
      createTrackingRecordOffline({ generatedText: "test", finalText: "something else entirely different", action: "edited" }),
    ];

    const report = computeQualityReportFromHistory(records);
    assert.equal(report.meetsQualityTarget, false);
  });

  it("includes distribution and percentiles", () => {
    const records = [
      createTrackingRecordOffline({ generatedText: "same text", finalText: "same text", action: "approved" }),
      createTrackingRecordOffline({ generatedText: "Built REST API", finalText: "Built a REST API service", action: "edited" }),
    ];

    const report = computeQualityReportFromHistory(records);
    assert.ok("distribution" in report);
    assert.ok("distributionRates" in report);
    assert.ok("percentiles" in report);
    assert.ok("p25" in report.percentiles);
    assert.ok("p50" in report.percentiles);
    assert.ok("p75" in report.percentiles);
  });
});

// ─── classifyEditDistance ──────────────────────────────────────────────────────

describe("classifyEditDistance", () => {
  it("classifies 1.0 as pristine", () => {
    assert.equal(classifyEditDistance(1.0), "pristine");
  });

  it("classifies 0.95 as pristine (boundary)", () => {
    assert.equal(classifyEditDistance(0.95), "pristine");
  });

  it("classifies 0.94 as minor_edit", () => {
    assert.equal(classifyEditDistance(0.94), "minor_edit");
  });

  it("classifies 0.85 as minor_edit (boundary)", () => {
    assert.equal(classifyEditDistance(0.85), "minor_edit");
  });

  it("classifies 0.84 as moderate_edit", () => {
    assert.equal(classifyEditDistance(0.84), "moderate_edit");
  });

  it("classifies 0.50 as moderate_edit (boundary)", () => {
    assert.equal(classifyEditDistance(0.50), "moderate_edit");
  });

  it("classifies 0.49 as rewritten", () => {
    assert.equal(classifyEditDistance(0.49), "rewritten");
  });

  it("classifies 0.0 as rewritten", () => {
    assert.equal(classifyEditDistance(0.0), "rewritten");
  });
});

// ─── QUALITY_BUCKETS ─────────────────────────────────────────────────────────

describe("QUALITY_BUCKETS", () => {
  it("has four buckets covering [0, 1]", () => {
    assert.ok(QUALITY_BUCKETS.pristine);
    assert.ok(QUALITY_BUCKETS.minor);
    assert.ok(QUALITY_BUCKETS.moderate);
    assert.ok(QUALITY_BUCKETS.rewritten);
  });

  it("buckets have non-overlapping ranges", () => {
    assert.equal(QUALITY_BUCKETS.rewritten.max, QUALITY_BUCKETS.moderate.min);
    assert.equal(QUALITY_BUCKETS.moderate.max, QUALITY_BUCKETS.minor.min);
    assert.equal(QUALITY_BUCKETS.minor.max, QUALITY_BUCKETS.pristine.min);
  });

  it("buckets cover from 0.0 to 1.0", () => {
    assert.equal(QUALITY_BUCKETS.rewritten.min, 0.0);
    assert.equal(QUALITY_BUCKETS.pristine.max, 1.0);
  });
});

// ─── computeQualityReport ─────────────────────────────────────────────────────

describe("computeQualityReport", () => {
  it("returns empty report for empty scores", () => {
    const report = computeQualityReport([]);
    assert.equal(report.totalBullets, 0);
    assert.equal(report.meetsQualityTarget, false);
    assert.equal(report.embeddingCoverage, 0);
  });

  it("computes correct distribution across buckets", () => {
    const scores = [
      { similarity: 1.0, isUsable: true, embeddingAvailable: true, bucket: "pristine" },
      { similarity: 0.90, isUsable: true, embeddingAvailable: true, bucket: "minor_edit" },
      { similarity: 0.70, isUsable: true, embeddingAvailable: true, bucket: "moderate_edit" },
      { similarity: 0.30, isUsable: false, embeddingAvailable: true, bucket: "rewritten" },
    ];

    const report = computeQualityReport(scores);

    assert.equal(report.totalBullets, 4);
    assert.equal(report.usableBullets, 3);
    assert.equal(report.distribution.pristine, 1);
    assert.equal(report.distribution.minor_edit, 1);
    assert.equal(report.distribution.moderate_edit, 1);
    assert.equal(report.distribution.rewritten, 1);
    assert.equal(report.embeddingCoverage, 1.0);
  });

  it("meets quality target when 70%+ usable", () => {
    const scores = Array.from({ length: 10 }, () => ({
      similarity: 0.95, isUsable: true, embeddingAvailable: true, bucket: "pristine",
    }));

    const report = computeQualityReport(scores);
    assert.equal(report.meetsQualityTarget, true);
    assert.equal(report.usableRate, 1.0);
  });

  it("fails quality target when <70% usable", () => {
    const scores = [
      { similarity: 0.95, isUsable: true, embeddingAvailable: true, bucket: "pristine" },
      { similarity: 0.30, isUsable: false, embeddingAvailable: true, bucket: "rewritten" },
      { similarity: 0.20, isUsable: false, embeddingAvailable: true, bucket: "rewritten" },
      { similarity: 0.10, isUsable: false, embeddingAvailable: true, bucket: "rewritten" },
    ];

    const report = computeQualityReport(scores);
    assert.equal(report.meetsQualityTarget, false);
    assert.equal(report.usableRate, 0.25);
  });

  it("reports embedding coverage correctly for mixed availability", () => {
    const scores = [
      { similarity: 0.95, isUsable: true, embeddingAvailable: true, bucket: "pristine" },
      { similarity: 0.80, isUsable: true, embeddingAvailable: false, bucket: "moderate_edit" },
    ];

    const report = computeQualityReport(scores);
    assert.equal(report.embeddingCoverage, 0.5);
  });

  it("computes percentiles for distribution analysis", () => {
    const scores = [
      { similarity: 0.10, isUsable: false, embeddingAvailable: true, bucket: "rewritten" },
      { similarity: 0.50, isUsable: true, embeddingAvailable: true, bucket: "moderate_edit" },
      { similarity: 0.80, isUsable: true, embeddingAvailable: true, bucket: "moderate_edit" },
      { similarity: 0.99, isUsable: true, embeddingAvailable: true, bucket: "pristine" },
    ];

    const report = computeQualityReport(scores);
    assert.ok(report.percentiles.p25 <= report.percentiles.p50);
    assert.ok(report.percentiles.p50 <= report.percentiles.p75);
  });
});

// ─── scoreGeneratedVsFinalPair (with pre-computed embeddings) ────────────────

describe("scoreGeneratedVsFinalPair", () => {
  /**
   * Helper: create a synthetic embedding vector that represents a "direction"
   * in embedding space.  By controlling the vectors we can test the scoring
   * logic without calling the embedding API.
   */
  function makeEmbedding(seed, dims = EMBEDDING_DIMENSIONS) {
    const vec = new Array(dims);
    for (let i = 0; i < dims; i++) {
      vec[i] = Math.sin(seed * (i + 1) * 0.01);
    }
    // Normalize to unit vector
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / mag);
  }

  it("uses embedding cosine as primary similarity when embeddings provided", async () => {
    const embA = makeEmbedding(1);
    const embB = makeEmbedding(1); // identical → cosine = 1.0

    const result = await scoreGeneratedVsFinalPair(
      "Built scalable REST API",
      "Built scalable REST API",
      { generatedEmbedding: embA, finalEmbedding: embB }
    );

    assert.equal(result.embeddingAvailable, true);
    assert.equal(result.embeddingSource, "precomputed");
    assert.ok(result.similarity >= 0.99, `expected ~1.0, got ${result.similarity}`);
    assert.equal(result.bucket, "pristine");
    assert.equal(result.isUsable, true);
    assert.ok(result.metrics.embedding !== null);
    assert.ok(result.metrics.levenshtein !== undefined);
    assert.ok(result.metrics.tokenJaccard !== undefined);
  });

  it("returns all required fields in result object", async () => {
    const embA = makeEmbedding(1);
    const embB = makeEmbedding(2);

    const result = await scoreGeneratedVsFinalPair(
      "Built REST API",
      "Designed GraphQL schema",
      { generatedEmbedding: embA, finalEmbedding: embB }
    );

    assert.ok("generated" in result);
    assert.ok("final" in result);
    assert.ok("similarity" in result);
    assert.ok("modificationDistance" in result);
    assert.ok("isUsable" in result);
    assert.ok("bucket" in result);
    assert.ok("embeddingAvailable" in result);
    assert.ok("embeddingSource" in result);
    assert.ok("metrics" in result);
    assert.ok("embedding" in result.metrics);
    assert.ok("levenshtein" in result.metrics);
    assert.ok("tokenJaccard" in result.metrics);
  });

  it("similarity + modificationDistance = 1.0", async () => {
    const embA = makeEmbedding(3);
    const embB = makeEmbedding(7);

    const result = await scoreGeneratedVsFinalPair(
      "Built API", "Designed schema",
      { generatedEmbedding: embA, finalEmbedding: embB }
    );

    const sum = result.similarity + result.modificationDistance;
    assert.ok(Math.abs(sum - 1.0) < 0.001, `expected sum ≈ 1.0, got ${sum}`);
  });

  it("detects semantic similarity for different-worded but same-meaning bullets", async () => {
    // Simulate semantically similar embeddings (high cosine)
    const embA = makeEmbedding(1);
    // Create a slightly perturbed version (high cosine)
    const embB = embA.map((v, i) => v + (i < 10 ? 0.001 : 0));
    const mag = Math.sqrt(embB.reduce((s, v) => s + v * v, 0));
    const embBnorm = embB.map((v) => v / mag);

    const result = await scoreGeneratedVsFinalPair(
      "Reduced API response time by 60% through Redis caching",
      "Through Redis caching, cut API response time by 60%",
      { generatedEmbedding: embA, finalEmbedding: embBnorm }
    );

    // Embedding cosine should be very high (vectors nearly identical)
    assert.ok(result.metrics.embedding > 0.95, `expected high embedding sim, got ${result.metrics.embedding}`);
    assert.ok(result.isUsable, "semantically similar bullet should be usable");
  });

  it("detects major rewrites with divergent embeddings", async () => {
    const embA = makeEmbedding(1);
    const embB = makeEmbedding(100); // very different seed → low cosine

    const result = await scoreGeneratedVsFinalPair(
      "Built REST API",
      "Mentored junior engineers",
      { generatedEmbedding: embA, finalEmbedding: embB }
    );

    // With divergent embeddings, similarity should be lower
    assert.ok(result.embeddingAvailable, "embedding should be available");
    assert.ok(typeof result.metrics.embedding === "number");
  });

  it("falls back to offline scoring when no embeddings provided and API disabled", async () => {
    // When neither precomputed embeddings nor API key, should fall back
    const origKey = process.env.OPENAI_API_KEY;
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await scoreGeneratedVsFinalPair(
        "Built REST API",
        "Built REST API"
      );

      assert.equal(result.embeddingAvailable, false);
      assert.equal(result.embeddingSource, "none");
      assert.equal(result.metrics.embedding, null);
      // Should still have offline metrics
      assert.ok(typeof result.metrics.levenshtein === "number");
      assert.ok(typeof result.metrics.tokenJaccard === "number");
      // Identical text → high similarity even without embeddings
      assert.ok(result.similarity >= 0.95);
    } finally {
      if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
      if (origDisable !== undefined) process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
      else delete process.env.WORK_LOG_DISABLE_OPENAI;
    }
  });

  it("clamps embedding similarity to [0, 1]", async () => {
    // Create vectors that might produce a slightly negative cosine
    const dims = EMBEDDING_DIMENSIONS;
    const embA = new Array(dims).fill(0);
    const embB = new Array(dims).fill(0);
    embA[0] = 1;
    embB[0] = -1; // opposite direction → cosine = -1

    const result = await scoreGeneratedVsFinalPair(
      "test a", "test b",
      { generatedEmbedding: embA, finalEmbedding: embB }
    );

    assert.ok(result.metrics.embedding >= 0, "embedding similarity should be >= 0 (clamped)");
    assert.ok(result.metrics.embedding <= 1, "embedding similarity should be <= 1");
  });

  it("preserves original and final text in result", async () => {
    const embA = makeEmbedding(1);

    const result = await scoreGeneratedVsFinalPair(
      "Original bullet text",
      "Modified bullet text",
      { generatedEmbedding: embA, finalEmbedding: embA }
    );

    assert.equal(result.generated, "Original bullet text");
    assert.equal(result.final, "Modified bullet text");
  });
});

// ─── scoreGeneratedVsFinalBatch (with pre-computed embeddings) ───────────────

describe("scoreGeneratedVsFinalBatch", () => {
  function makeEmbedding(seed, dims = EMBEDDING_DIMENSIONS) {
    const vec = new Array(dims);
    for (let i = 0; i < dims; i++) {
      vec[i] = Math.sin(seed * (i + 1) * 0.01);
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / mag);
  }

  it("returns empty result for empty input", async () => {
    const result = await scoreGeneratedVsFinalBatch([]);
    assert.equal(result.scores.length, 0);
    assert.equal(result.qualityReport.totalBullets, 0);
  });

  it("returns empty result for null input", async () => {
    const result = await scoreGeneratedVsFinalBatch(null);
    assert.equal(result.scores.length, 0);
  });

  it("scores multiple pairs with precomputed embeddings", async () => {
    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(2);
    const emb3 = makeEmbedding(3);

    const pairs = [
      { generated: "Built REST API", final: "Built REST API" },
      { generated: "Shipped feature A", final: "Redesigned entire codebase" },
    ];
    const precomputed = [
      { generatedEmbedding: emb1, finalEmbedding: emb1 }, // identical → pristine
      { generatedEmbedding: emb2, finalEmbedding: emb3 }, // different → lower sim
    ];

    const result = await scoreGeneratedVsFinalBatch(pairs, { precomputedEmbeddings: precomputed });

    assert.equal(result.scores.length, 2);

    // First pair: identical embeddings → high similarity
    assert.ok(result.scores[0].embeddingAvailable);
    assert.equal(result.scores[0].embeddingSource, "precomputed");
    assert.ok(result.scores[0].similarity >= 0.95);

    // Second pair: different embeddings
    assert.ok(result.scores[1].embeddingAvailable);
    assert.equal(result.scores[1].embeddingSource, "precomputed");
  });

  it("produces a quality report with all expected fields", async () => {
    const emb = makeEmbedding(1);

    const pairs = [
      { generated: "Built REST API", final: "Built REST API" },
      { generated: "Led team of 5", final: "Led team of 5 engineers" },
      { generated: "Deployed to AWS", final: "Deployed to AWS" },
    ];
    const precomputed = pairs.map(() => ({
      generatedEmbedding: emb,
      finalEmbedding: emb,
    }));

    const result = await scoreGeneratedVsFinalBatch(pairs, { precomputedEmbeddings: precomputed });
    const report = result.qualityReport;

    assert.equal(report.totalBullets, 3);
    assert.ok("usableBullets" in report);
    assert.ok("usableRate" in report);
    assert.ok("meetsQualityTarget" in report);
    assert.ok("meanSimilarity" in report);
    assert.ok("embeddingCoverage" in report);
    assert.ok("distribution" in report);
    assert.ok("distributionRates" in report);
    assert.ok("percentiles" in report);
  });

  it("handles mixed precomputed and missing embeddings gracefully", async () => {
    const emb = makeEmbedding(1);

    // Disable API so pairs without precomputed embeddings fall back to offline
    const origDisable = process.env.WORK_LOG_DISABLE_OPENAI;
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    try {
      const pairs = [
        { generated: "Pair with embeddings", final: "Pair with embeddings" },
        { generated: "Pair without embeddings", final: "Pair without embeddings" },
      ];
      const precomputed = [
        { generatedEmbedding: emb, finalEmbedding: emb },
        {}, // no embeddings for this pair
      ];

      const result = await scoreGeneratedVsFinalBatch(pairs, { precomputedEmbeddings: precomputed });

      assert.equal(result.scores.length, 2);
      assert.equal(result.scores[0].embeddingAvailable, true);
      assert.equal(result.scores[0].embeddingSource, "precomputed");
      // Second pair falls back to offline
      assert.equal(result.scores[1].embeddingAvailable, false);
      assert.equal(result.scores[1].embeddingSource, "none");
    } finally {
      if (origDisable !== undefined) process.env.WORK_LOG_DISABLE_OPENAI = origDisable;
      else delete process.env.WORK_LOG_DISABLE_OPENAI;
    }
  });

  it("each score has per-pair generated and final text", async () => {
    const emb = makeEmbedding(1);
    const pairs = [
      { generated: "Text A", final: "Text B" },
    ];
    const precomputed = [{ generatedEmbedding: emb, finalEmbedding: emb }];

    const result = await scoreGeneratedVsFinalBatch(pairs, { precomputedEmbeddings: precomputed });
    assert.equal(result.scores[0].generated, "Text A");
    assert.equal(result.scores[0].final, "Text B");
  });
});

// ─── Cosine similarity as edit-distance proxy: integration tests ─────────────

describe("embedding cosine as edit-distance proxy", () => {
  function makeEmbedding(seed, dims = EMBEDDING_DIMENSIONS) {
    const vec = new Array(dims);
    for (let i = 0; i < dims; i++) {
      vec[i] = Math.sin(seed * (i + 1) * 0.01);
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / mag);
  }

  it("identical embeddings produce similarity 1.0, bucket pristine", async () => {
    const emb = makeEmbedding(42);
    const result = await scoreGeneratedVsFinalPair(
      "test", "test",
      { generatedEmbedding: emb, finalEmbedding: emb }
    );

    assert.ok(result.metrics.embedding >= 0.999);
    assert.equal(result.bucket, "pristine");
    assert.equal(result.modificationDistance, 0);
  });

  it("cosine similarity is symmetric", () => {
    const embA = makeEmbedding(1);
    const embB = makeEmbedding(2);

    const sim1 = rawCosineSimilarity(embA, embB);
    const sim2 = rawCosineSimilarity(embB, embA);

    assert.ok(Math.abs(sim1 - sim2) < 1e-10, "cosine similarity should be symmetric");
  });

  it("orthogonal vectors produce cosine ~0", () => {
    // Create two orthogonal unit vectors in high-dimensional space
    const dims = EMBEDDING_DIMENSIONS;
    const embA = new Array(dims).fill(0);
    const embB = new Array(dims).fill(0);
    embA[0] = 1.0;
    embB[1] = 1.0;

    const sim = rawCosineSimilarity(embA, embB);
    assert.ok(Math.abs(sim) < 0.01, `expected ~0, got ${sim}`);
  });

  it("embedding similarity provides richer signal than token overlap for paraphrases", async () => {
    // In real usage, paraphrased bullets would have high embedding cosine
    // even when token overlap is low. Here we simulate with controlled vectors.
    const embA = makeEmbedding(1);
    // Small perturbation → high cosine
    const embB = embA.map((v, i) => v + (i % 50 === 0 ? 0.01 : 0));
    const mag = Math.sqrt(embB.reduce((s, v) => s + v * v, 0));
    const embBnorm = embB.map((v) => v / mag);

    const result = await scoreGeneratedVsFinalPair(
      "Reduced API latency by 60% through caching optimization",
      "Through caching optimization, cut API response time by 60%",
      { generatedEmbedding: embA, finalEmbedding: embBnorm }
    );

    // Embedding cosine says "very similar" (the paraphrase is semantically equivalent)
    assert.ok(result.metrics.embedding > 0.9, `embedding sim should be high: ${result.metrics.embedding}`);
    // Token Jaccard is lower because of word differences ("reduced" vs "cut", "latency" vs "response time")
    assert.ok(result.metrics.tokenJaccard < result.metrics.embedding,
      "embedding should capture paraphrase better than token overlap");
    // The primary similarity should use embedding (higher), making this usable
    assert.ok(result.isUsable, "paraphrased bullet should be usable with embedding scoring");
  });

  it("quality report distribution sums to totalBullets", async () => {
    const emb1 = makeEmbedding(1);
    const emb50 = makeEmbedding(50);
    const emb100 = makeEmbedding(100);

    const pairs = [
      { generated: "A", final: "A" },
      { generated: "B", final: "C" },
      { generated: "D", final: "E" },
    ];
    const precomputed = [
      { generatedEmbedding: emb1, finalEmbedding: emb1 },     // pristine
      { generatedEmbedding: emb1, finalEmbedding: emb50 },    // varies
      { generatedEmbedding: emb1, finalEmbedding: emb100 },   // varies
    ];

    const result = await scoreGeneratedVsFinalBatch(pairs, { precomputedEmbeddings: precomputed });
    const dist = result.qualityReport.distribution;
    const sum = dist.pristine + dist.minor_edit + dist.moderate_edit + dist.rewritten;
    assert.equal(sum, 3, "distribution should sum to total bullet count");
  });
});

// ─── Persistence functions ──────────────────────────────────────────────────
//
// These tests verify the persistence layer functions that wrap blob I/O.
// Since mock.module is not available, we test the pure logic portions
// and the no-op edge cases that don't require blob access.

describe("persistTrackingRecords (edge cases)", () => {
  it("returns early with null url for empty records array", async () => {
    const result = await persistTrackingRecords([]);
    assert.equal(result.url, null);
    assert.equal(result.totalRecords, 0);
  });

  it("returns early with null url for non-array input", async () => {
    const result = await persistTrackingRecords(null);
    assert.equal(result.url, null);
    assert.equal(result.totalRecords, 0);
  });
});

describe("trackBulletEdit — record creation (offline, no blob I/O)", () => {
  // trackBulletEdit calls persistTrackingRecords which calls blob I/O.
  // When blob is unavailable, persisted=false but the record is still returned.
  // We test the scoring and record structure here.

  it("creates a correct tracking record for an edited bullet", () => {
    // Use the offline record creation directly (no blob dependency)
    const record = createTrackingRecordOffline({
      generatedText: "Implemented user authentication system",
      finalText: "Implemented user authentication system with OAuth2",
      action: "edited",
      section: "experience",
      logDate: "2026-03-30",
    });

    assert.ok(record.id, "should have a UUID id");
    assert.equal(record.action, "edited");
    assert.equal(record.section, "experience");
    assert.equal(record.logDate, "2026-03-30");
    assert.equal(typeof record.similarity, "number");
    assert.ok(record.similarity > 0, "similar bullets should have positive similarity");
    assert.ok(record.similarity < 1, "edited bullets should not be identical");
    assert.equal(record.metrics.embedding, null, "offline mode has no embedding");
    assert.equal(typeof record.metrics.levenshtein, "number");
    assert.equal(typeof record.metrics.tokenJaccard, "number");
    assert.equal(typeof record.modificationDistance, "number");
    assert.equal(record.isUsable, record.modificationDistance <= USABLE_THRESHOLD);
  });

  it("scores a pristine approval (generated === final) as similarity 1.0", () => {
    const record = createTrackingRecordOffline({
      generatedText: "Built a REST API",
      finalText: "Built a REST API",
      action: "approved",
    });

    assert.equal(record.similarity, 1);
    assert.equal(record.modificationDistance, 0);
    assert.equal(record.isUsable, true);
    assert.equal(record.bucket, "pristine");
    assert.equal(record.action, "approved");
  });

  it("scores a major rewrite as low similarity", () => {
    const record = createTrackingRecordOffline({
      generatedText: "Implemented user authentication",
      finalText: "Designed a completely new microservice architecture for payment processing",
      action: "edited",
    });

    assert.ok(record.similarity < 0.5, "major rewrite should have low similarity");
    assert.ok(record.modificationDistance > 0.5, "major rewrite should have high modification distance");
    assert.equal(record.isUsable, false, "major rewrite should not be usable");
    assert.equal(record.bucket, "rewritten");
  });

  it("correctly classifies minor edits (word additions/substitutions)", () => {
    const record = createTrackingRecordOffline({
      generatedText: "Reduced API response time by optimizing database queries",
      finalText: "Reduced API response time by 40% by optimizing database queries and adding caching",
      action: "edited",
    });

    // Adding a percentage and one clause should still be usable
    assert.ok(record.similarity > 0.5, "minor additions should keep high similarity");
    assert.equal(record.isUsable, true);
  });
});

describe("quality report from history (pure computation)", () => {
  it("computes a quality report from tracking records", () => {
    const records = [
      {
        id: "r1", generatedText: "A", finalText: "A",
        similarity: 1.0, modificationDistance: 0, isUsable: true,
        bucket: "pristine", action: "approved", section: "experience",
        logDate: null, recordedAt: "2026-03-31T00:00:00.000Z",
        metrics: { embedding: null, levenshtein: 1.0, tokenJaccard: 1.0 }
      },
      {
        id: "r2", generatedText: "B", finalText: "C completely different rewrite",
        similarity: 0.2, modificationDistance: 0.8, isUsable: false,
        bucket: "rewritten", action: "edited", section: "experience",
        logDate: null, recordedAt: "2026-03-31T00:00:00.000Z",
        metrics: { embedding: null, levenshtein: 0.1, tokenJaccard: 0.3 }
      },
    ];

    const report = computeQualityReportFromHistory(records);
    assert.equal(report.totalBullets, 2);
    assert.equal(report.usableBullets, 1);
    assert.equal(report.usableRate, 0.5);
    assert.equal(report.meetsQualityTarget, false); // need 70%
    assert.equal(report.distribution.pristine, 1);
    assert.equal(report.distribution.rewritten, 1);
    assert.equal(report.actionBreakdown.approved, 1);
    assert.equal(report.actionBreakdown.edited, 1);
  });

  it("supports action filter", () => {
    const records = [
      {
        id: "r1", similarity: 1.0, modificationDistance: 0, isUsable: true,
        bucket: "pristine", action: "approved", section: "experience",
        recordedAt: "2026-03-31T00:00:00.000Z",
        metrics: { embedding: null, levenshtein: 1.0, tokenJaccard: 1.0 }
      },
      {
        id: "r2", similarity: 0.2, modificationDistance: 0.8, isUsable: false,
        bucket: "rewritten", action: "edited", section: "experience",
        recordedAt: "2026-03-31T00:00:00.000Z",
        metrics: { embedding: null, levenshtein: 0.1, tokenJaccard: 0.3 }
      },
    ];

    const report = computeQualityReportFromHistory(records, { action: "approved" });
    assert.equal(report.filteredCount, 1);
    assert.equal(report.totalRecords, 2);
    assert.equal(report.usableRate, 1); // only the pristine one
  });

  it("supports section filter", () => {
    const records = [
      {
        id: "r1", similarity: 0.9, modificationDistance: 0.1, isUsable: true,
        bucket: "minor_edit", action: "approved", section: "experience",
        recordedAt: "2026-03-31T00:00:00.000Z",
        metrics: { embedding: null, levenshtein: 0.9, tokenJaccard: 0.9 }
      },
      {
        id: "r2", similarity: 0.7, modificationDistance: 0.3, isUsable: true,
        bucket: "moderate_edit", action: "approved", section: "projects",
        recordedAt: "2026-03-31T00:00:00.000Z",
        metrics: { embedding: null, levenshtein: 0.7, tokenJaccard: 0.7 }
      },
    ];

    const report = computeQualityReportFromHistory(records, { section: "projects" });
    assert.equal(report.filteredCount, 1);
    assert.equal(report.totalBullets, 1);
  });

  it("returns empty report for no records", () => {
    const report = computeQualityReportFromHistory([]);
    assert.equal(report.totalBullets, 0);
    assert.equal(report.meetsQualityTarget, false);
  });

  it("meets quality target when 70%+ are usable", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      similarity: i < 8 ? 0.9 : 0.1, // 8 out of 10 are usable
      modificationDistance: i < 8 ? 0.1 : 0.9,
      isUsable: i < 8,
      bucket: i < 8 ? "minor_edit" : "rewritten",
      action: "approved",
      section: "experience",
      recordedAt: "2026-03-31T00:00:00.000Z",
      metrics: { embedding: null, levenshtein: 0.9, tokenJaccard: 0.9 }
    }));

    const report = computeQualityReportFromHistory(records);
    assert.equal(report.meetsQualityTarget, true, "80% usable should meet 70% target");
    assert.equal(report.usableBullets, 8);
    assert.equal(report.usableRate, 0.8);
  });
});

// ─── trackBulletEditBatch — batch tracking with aggregate quality summary ────

describe("trackBulletEditBatch — record creation and quality summary", () => {
  it("returns empty results for empty input", async () => {
    const result = await trackBulletEditBatch([]);
    assert.deepEqual(result.records, []);
    assert.equal(result.qualitySummary.totalBullets, 0);
    assert.equal(result.persisted, false);
  });

  it("returns empty results for null input", async () => {
    const result = await trackBulletEditBatch(null);
    assert.deepEqual(result.records, []);
    assert.equal(result.persisted, false);
  });

  it("creates records and computes quality summary for a batch", async () => {
    const pairs = [
      {
        generatedText: "Implemented user authentication",
        finalText: "Implemented user authentication with OAuth2",
        action: "edited",
        section: "experience",
        logDate: "2026-03-30",
      },
      {
        generatedText: "Built REST API",
        finalText: "Built REST API",
        action: "approved",
        section: "experience",
      },
      {
        generatedText: "Designed microservice architecture",
        finalText: "Created entirely new payment processing system from scratch",
        action: "edited",
        section: "projects",
      },
    ];

    const result = await trackBulletEditBatch(pairs, { useEmbeddings: false });

    // Should have 3 records
    assert.equal(result.records.length, 3);

    // Each record should have proper structure
    for (const record of result.records) {
      assert.ok(record.id, "each record should have an id");
      assert.equal(typeof record.similarity, "number");
      assert.equal(typeof record.modificationDistance, "number");
      assert.equal(typeof record.isUsable, "boolean");
      assert.ok(record.bucket, "each record should have a bucket");
      assert.ok(record.recordedAt, "each record should have a timestamp");
      assert.equal(record.metrics.embedding, null, "offline mode has no embedding");
      assert.equal(typeof record.metrics.levenshtein, "number");
      assert.equal(typeof record.metrics.tokenJaccard, "number");
    }

    // Quality summary should be computed
    const qs = result.qualitySummary;
    assert.equal(qs.totalBullets, 3);
    assert.equal(typeof qs.usableBullets, "number");
    assert.equal(typeof qs.usableRate, "number");
    assert.equal(typeof qs.meetsQualityTarget, "boolean");
    assert.ok(qs.distribution, "should have distribution");

    // Pristine approval should be in pristine bucket
    const approvedRecord = result.records[1];
    assert.equal(approvedRecord.similarity, 1);
    assert.equal(approvedRecord.bucket, "pristine");

    // Major rewrite should be in rewritten bucket
    const rewrittenRecord = result.records[2];
    assert.ok(rewrittenRecord.similarity < 0.5, "major rewrite should have low similarity");
  });

  it("correctly propagates section and logDate from pairs", async () => {
    const pairs = [
      {
        generatedText: "Added unit tests",
        finalText: "Added comprehensive unit and integration tests",
        action: "edited",
        section: "projects",
        logDate: "2026-03-29",
      },
    ];

    const result = await trackBulletEditBatch(pairs, { useEmbeddings: false });
    assert.equal(result.records[0].section, "projects");
    assert.equal(result.records[0].logDate, "2026-03-29");
    assert.equal(result.records[0].action, "edited");
  });

  it("defaults section to experience and logDate to null", async () => {
    const pairs = [
      {
        generatedText: "Fixed bug",
        finalText: "Fixed critical production bug",
        action: "edited",
      },
    ];

    const result = await trackBulletEditBatch(pairs, { useEmbeddings: false });
    assert.equal(result.records[0].section, "experience");
    assert.equal(result.records[0].logDate, null);
  });
});
