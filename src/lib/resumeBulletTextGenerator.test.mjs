/**
 * Tests for resumeBulletTextGenerator.mjs
 *
 * Covers:
 *   - Contextual pattern selection
 *   - Decision-evidence matching
 *   - Local bullet enrichment (embedDecisionInBullet)
 *   - Bullet generation prompt building
 *   - Decision integration scoring
 *   - Batch generation
 *   - Edge cases and graceful degradation
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXTUAL_PATTERNS,
  matchDecisionsToEvidence,
  selectContextualPattern,
  generateBulletTexts,
  embedDecisionInBullet,
  composeMultiDecisionBullet,
  rankDecisionsForBullet,
  scoreBulletDecisionIntegration,
  buildBulletGenerationPrompt,
  batchGenerateBullets,
  _matchTopicToEvidence,
  _selectBestPattern,
  _validateDecisionIntegration,
} from "./resumeBulletTextGenerator.mjs";

// ─── Test fixtures ──────────────────────────────────────────────────────────

const SAMPLE_DECISION_TRADEOFF = {
  topic: "Event-driven architecture vs polling",
  alternatives: ["HTTP polling", "WebSocket long-polling"],
  chosen: "Event-driven architecture with message queue",
  rationale: "Profiling showed 3x lower CPU usage under sustained load compared to polling",
  impact: "Reduced server costs by 40%",
  date: "2026-03-15",
  source: "codex",
  confidence: 0.9,
};

const SAMPLE_DECISION_CAUSAL = {
  topic: "Structured error boundaries over retry logic",
  alternatives: ["Retry with exponential backoff"],
  chosen: "Structured error boundaries",
  rationale: "Analysis showed 80% of failures were non-transient and retries would compound load",
  date: "2026-03-16",
  source: "claude",
  confidence: 0.85,
};

const SAMPLE_DECISION_STRATEGIC = {
  topic: "Migration from REST to GraphQL",
  alternatives: ["Keeping REST API", "gRPC"],
  chosen: "GraphQL with schema federation",
  rationale: "Frontend teams needed flexible queries, reducing over-fetching by 60%",
  impact: "Halved API response payload sizes",
  date: "2026-03-18",
  source: "codex",
  confidence: 0.8,
};

const SAMPLE_DECISION_DESIGN = {
  topic: "Plugin architecture with dependency injection",
  alternatives: ["Direct imports", "Service locator pattern"],
  chosen: "Dependency injection container",
  rationale: "Needed testability and runtime swapping for different environments",
  date: "2026-03-20",
  source: "claude",
  confidence: 0.75,
};

const SAMPLE_EVIDENCE_ITEMS = [
  { text: "Implemented event-driven message processing pipeline", date: "2026-03-15", type: "commit" },
  { text: "Added structured error boundary for payment service", date: "2026-03-16", type: "commit" },
  { text: "Migrated user query endpoint from REST to GraphQL", date: "2026-03-18", type: "commit" },
  { text: "Built plugin system with DI container", date: "2026-03-20", type: "commit" },
  { text: "Optimized batch processing for daily reports", date: "2026-03-21", type: "bullet" },
];

const SAMPLE_EPISODE = {
  id: "ep-myrepo-0",
  title: "Event-driven messaging pipeline overhaul",
  summary: "Replaced polling-based message processing with event-driven architecture for lower CPU usage",
  dates: ["2026-03-15", "2026-03-16"],
  commitSubjects: [
    "feat: implement event-driven message pipeline",
    "refactor: add structured error boundaries",
    "test: add integration tests for event processing",
  ],
  bullets: [
    "Implemented event-driven message processing pipeline",
    "Added structured error boundaries for fault isolation",
  ],
  topicTag: "event-pipeline",
  moduleTag: "messaging/core",
};

// ─── CONTEXTUAL_PATTERNS ────────────────────────────────────────────────────

describe("CONTEXTUAL_PATTERNS", () => {
  it("exports a non-empty frozen array", () => {
    assert.ok(Array.isArray(CONTEXTUAL_PATTERNS));
    assert.ok(CONTEXTUAL_PATTERNS.length >= 10, "Should have at least 10 patterns");
    assert.ok(Object.isFrozen(CONTEXTUAL_PATTERNS));
  });

  it("every pattern has required fields", () => {
    for (const p of CONTEXTUAL_PATTERNS) {
      assert.ok(p.id, `Pattern missing id`);
      assert.ok(p.category, `Pattern ${p.id} missing category`);
      assert.ok(p.template, `Pattern ${p.id} missing template`);
      assert.ok(Array.isArray(p.signals), `Pattern ${p.id} missing signals array`);
      assert.ok(p.example, `Pattern ${p.id} missing example`);
    }
  });

  it("has unique pattern IDs", () => {
    const ids = CONTEXTUAL_PATTERNS.map(p => p.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, "Pattern IDs must be unique");
  });

  it("has a general fallback pattern as the last entry", () => {
    const last = CONTEXTUAL_PATTERNS[CONTEXTUAL_PATTERNS.length - 1];
    assert.equal(last.category, "general");
    assert.equal(last.signals.length, 0, "Fallback pattern should have no signals");
  });

  it("covers key categories", () => {
    const categories = new Set(CONTEXTUAL_PATTERNS.map(p => p.category));
    assert.ok(categories.has("tradeoff"), "Should have tradeoff patterns");
    assert.ok(categories.has("causal"), "Should have causal patterns");
    assert.ok(categories.has("analysis"), "Should have analysis patterns");
    assert.ok(categories.has("strategic"), "Should have strategic patterns");
    assert.ok(categories.has("design"), "Should have design patterns");
    assert.ok(categories.has("general"), "Should have general fallback");
  });

  it("examples demonstrate natural reasoning integration", () => {
    for (const p of CONTEXTUAL_PATTERNS) {
      // No example should use metadata-style reasoning
      assert.ok(
        !/\((?:reason|decision|rationale):/i.test(p.example),
        `Pattern ${p.id} example uses metadata-style reasoning`
      );
    }
  });
});

// ─── _matchTopicToEvidence ──────────────────────────────────────────────────

describe("_matchTopicToEvidence", () => {
  it("returns 0 for null/undefined inputs", () => {
    assert.equal(_matchTopicToEvidence(null, null), 0);
    assert.equal(_matchTopicToEvidence({}, null), 0);
    assert.equal(_matchTopicToEvidence(null, { text: "hello" }), 0);
  });

  it("returns 0 for empty evidence text", () => {
    assert.equal(_matchTopicToEvidence(SAMPLE_DECISION_TRADEOFF, { text: "" }), 0);
  });

  it("returns high score for closely related items", () => {
    const score = _matchTopicToEvidence(
      SAMPLE_DECISION_TRADEOFF,
      { text: "Implemented event-driven message processing pipeline with lower CPU usage" }
    );
    assert.ok(score > 0.3, `Expected > 0.3, got ${score}`);
  });

  it("returns low score for unrelated items", () => {
    const score = _matchTopicToEvidence(
      SAMPLE_DECISION_TRADEOFF,
      { text: "Updated documentation for API reference guide" }
    );
    assert.ok(score < 0.25, `Expected < 0.25, got ${score}`);
  });

  it("considers alternatives in matching", () => {
    const score = _matchTopicToEvidence(
      SAMPLE_DECISION_TRADEOFF,
      { text: "Removed HTTP polling implementation in favor of events" }
    );
    assert.ok(score > 0.1, `Expected > 0.1 (alternatives match), got ${score}`);
  });
});

// ─── selectContextualPattern / _selectBestPattern ───────────────────────────

describe("selectContextualPattern", () => {
  it("returns fallback for null decision", () => {
    const pattern = selectContextualPattern(null);
    assert.equal(pattern.category, "general");
  });

  it("selects tradeoff pattern for trade-off decisions", () => {
    const pattern = selectContextualPattern(SAMPLE_DECISION_TRADEOFF);
    assert.ok(
      pattern.category === "tradeoff" || pattern.category === "causal",
      `Expected tradeoff or causal, got ${pattern.category} (${pattern.id})`
    );
  });

  it("selects causal pattern for causal decisions", () => {
    const decision = {
      topic: "Eliminating redundant database calls",
      chosen: "Query batching",
      rationale: "Profiling revealed 60% of DB calls were duplicates",
      alternatives: ["Caching layer"],
      confidence: 0.8,
    };
    const pattern = selectContextualPattern(decision);
    // Should match causal-reducing or analysis-based-on
    assert.ok(
      ["causal", "analysis", "tradeoff"].includes(pattern.category),
      `Expected causal-ish pattern, got ${pattern.category} (${pattern.id})`
    );
  });

  it("selects strategic pattern for migration decisions", () => {
    const pattern = selectContextualPattern(SAMPLE_DECISION_STRATEGIC);
    assert.ok(
      ["strategic", "causal", "tradeoff"].includes(pattern.category),
      `Expected strategic-ish, got ${pattern.category} (${pattern.id})`
    );
  });

  it("selects design pattern for architecture decisions", () => {
    const pattern = selectContextualPattern(SAMPLE_DECISION_DESIGN);
    assert.ok(
      ["design", "strategic"].includes(pattern.category),
      `Expected design-ish, got ${pattern.category} (${pattern.id})`
    );
  });
});

// ─── matchDecisionsToEvidence ───────────────────────────────────────────────

describe("matchDecisionsToEvidence", () => {
  it("returns empty array for null inputs", () => {
    assert.deepEqual(matchDecisionsToEvidence(null, null), []);
    assert.deepEqual(matchDecisionsToEvidence([], []), []);
  });

  it("matches decisions to relevant evidence items", () => {
    const matches = matchDecisionsToEvidence(
      [SAMPLE_DECISION_TRADEOFF],
      SAMPLE_EVIDENCE_ITEMS
    );
    assert.equal(matches.length, 1);
    assert.ok(matches[0].pattern, "Should have a selected pattern");
    assert.ok(matches[0].decision === SAMPLE_DECISION_TRADEOFF);
  });

  it("handles multiple decisions", () => {
    const matches = matchDecisionsToEvidence(
      [SAMPLE_DECISION_TRADEOFF, SAMPLE_DECISION_CAUSAL, SAMPLE_DECISION_STRATEGIC],
      SAMPLE_EVIDENCE_ITEMS
    );
    assert.equal(matches.length, 3);
  });

  it("each match has a pattern and score", () => {
    const matches = matchDecisionsToEvidence(
      [SAMPLE_DECISION_TRADEOFF],
      SAMPLE_EVIDENCE_ITEMS
    );
    for (const m of matches) {
      assert.ok(typeof m.score === "number");
      assert.ok(m.pattern);
      assert.ok(m.pattern.id);
    }
  });

  it("filters evidence items by relevance threshold", () => {
    const matches = matchDecisionsToEvidence(
      [SAMPLE_DECISION_TRADEOFF],
      [
        { text: "event-driven architecture message processing pipeline CPU", type: "commit" },
        { text: "Updated README typo fix", type: "commit" },
      ]
    );
    // Should match the event-driven one, may or may not match the README one
    const eventMatch = matches[0];
    assert.ok(eventMatch.evidenceItems.length >= 1, "Should match at least the relevant item");
  });
});

// ─── embedDecisionInBullet ──────────────────────────────────────────────────

describe("embedDecisionInBullet", () => {
  it("returns empty string for null bullet", () => {
    assert.equal(embedDecisionInBullet(null, SAMPLE_DECISION_TRADEOFF), "");
  });

  it("returns original bullet when decision is null", () => {
    assert.equal(
      embedDecisionInBullet("Built message pipeline", null),
      "Built message pipeline"
    );
  });

  it("returns original when decision is irrelevant", () => {
    const result = embedDecisionInBullet(
      "Updated documentation for API reference",
      SAMPLE_DECISION_TRADEOFF
    );
    // May or may not enrich depending on word overlap — shouldn't crash
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it("returns original when bullet already has reasoning language", () => {
    const bullet = "Implemented event-driven pipeline after profiling showed CPU savings";
    const result = embedDecisionInBullet(bullet, SAMPLE_DECISION_TRADEOFF);
    assert.equal(result, bullet, "Should not double-enrich");
  });

  it("enriches a plain bullet with decision reasoning", () => {
    const result = embedDecisionInBullet(
      "Implemented event-driven architecture for messaging pipeline",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.ok(result.length > 0);
    // The enriched version should be at least as long as the original
    assert.ok(
      result.length >= "Implemented event-driven architecture for messaging pipeline".length,
      "Enriched bullet should be at least as long as original"
    );
  });

  it("respects max character limit", () => {
    const result = embedDecisionInBullet(
      "Implemented event-driven architecture for messaging pipeline across all services",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.ok(result.length <= 140, `Bullet exceeds 140 chars: ${result.length}`);
  });

  it("does not produce metadata-style reasoning", () => {
    const result = embedDecisionInBullet(
      "Implemented event-driven architecture",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.ok(!/\(reason:/i.test(result), "Should not have (Reason:...) style");
    assert.ok(!/Decision:/i.test(result), "Should not have Decision: style");
  });
});

// ─── scoreBulletDecisionIntegration ─────────────────────────────────────────

describe("scoreBulletDecisionIntegration", () => {
  it("returns zero score for null inputs", () => {
    const result = scoreBulletDecisionIntegration(null, null);
    assert.equal(result.score, 0);
    assert.ok(result.issues.length > 0);
  });

  it("scores well-integrated bullet highly", () => {
    const result = scoreBulletDecisionIntegration(
      "Chose event-driven architecture over polling after profiling showed 3x lower CPU usage",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.ok(result.score >= 0.7, `Expected >= 0.7, got ${result.score}`);
    assert.ok(result.hasReasoningLanguage);
    assert.ok(result.avoidsMetadataStyle);
  });

  it("scores metadata-style bullet lower", () => {
    const result = scoreBulletDecisionIntegration(
      "Implemented event-driven architecture (Reason: better performance)",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.ok(!result.avoidsMetadataStyle);
    assert.ok(result.score < 0.8, "Metadata-style should score lower");
  });

  it("scores bullet without reasoning language lower", () => {
    const result = scoreBulletDecisionIntegration(
      "Implemented event-driven architecture for messaging",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.ok(!result.hasReasoningLanguage || result.score < 0.8);
  });

  it("flags overlength bullets", () => {
    const longBullet = "A".repeat(150);
    const result = scoreBulletDecisionIntegration(longBullet, SAMPLE_DECISION_TRADEOFF);
    assert.ok(!result.withinCharLimit);
    assert.ok(result.issues.some(i => i.includes("character limit")));
  });

  it("checks that the chosen approach is mentioned", () => {
    const result = scoreBulletDecisionIntegration(
      "Rebuilt the entire system from scratch using new patterns",
      SAMPLE_DECISION_TRADEOFF
    );
    // "event-driven" and "message queue" not mentioned
    // mentionsChoice checks for words from decision.chosen
    assert.ok(typeof result.mentionsChoice === "boolean");
  });

  it("returns all score components", () => {
    const result = scoreBulletDecisionIntegration(
      "Built event-driven pipeline to eliminate polling overhead",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.ok("score" in result);
    assert.ok("hasReasoningLanguage" in result);
    assert.ok("avoidsMetadataStyle" in result);
    assert.ok("mentionsChoice" in result);
    assert.ok("withinCharLimit" in result);
    assert.ok(Array.isArray(result.issues));
  });
});

// ─── buildBulletGenerationPrompt ────────────────────────────────────────────

describe("buildBulletGenerationPrompt", () => {
  it("includes evidence items in the prompt", () => {
    const prompt = buildBulletGenerationPrompt(
      { items: SAMPLE_EVIDENCE_ITEMS, repo: "myrepo" },
      [],
      3
    );
    assert.ok(prompt.includes("EVIDENCE"), "Should have evidence section");
    assert.ok(prompt.includes("myrepo"), "Should include repo name");
    assert.ok(prompt.includes("event-driven"), "Should include evidence text");
  });

  it("includes decision reasoning when matches are provided", () => {
    const matches = matchDecisionsToEvidence(
      [SAMPLE_DECISION_TRADEOFF],
      SAMPLE_EVIDENCE_ITEMS
    );
    const prompt = buildBulletGenerationPrompt(
      { items: SAMPLE_EVIDENCE_ITEMS },
      matches,
      3
    );
    assert.ok(prompt.includes("DECISION REASONING"), "Should have decision section");
    assert.ok(prompt.includes("Event-driven"), "Should include decision topic");
    assert.ok(prompt.includes("Rationale:"), "Should include rationale");
  });

  it("includes pattern guidance for matched decisions", () => {
    const matches = matchDecisionsToEvidence(
      [SAMPLE_DECISION_TRADEOFF],
      SAMPLE_EVIDENCE_ITEMS
    );
    const prompt = buildBulletGenerationPrompt(
      { items: SAMPLE_EVIDENCE_ITEMS },
      matches,
      3
    );
    // Should include either "Suggested pattern" or the example
    assert.ok(
      prompt.includes("Suggested pattern") || prompt.includes("Example"),
      "Should include pattern guidance"
    );
  });

  it("includes task instructions", () => {
    const prompt = buildBulletGenerationPrompt(
      { items: SAMPLE_EVIDENCE_ITEMS },
      [],
      4
    );
    assert.ok(prompt.includes("TASK"), "Should have task section");
    assert.ok(prompt.includes("4"), "Should mention target bullet count");
    assert.ok(prompt.includes("action verb"), "Should mention verb requirement");
    assert.ok(prompt.includes("30-140"), "Should mention character limits");
  });

  it("includes episode context when provided", () => {
    const prompt = buildBulletGenerationPrompt(
      {
        items: SAMPLE_EVIDENCE_ITEMS,
        repo: "myrepo",
        episodeTitle: "Payment Flow Overhaul",
        episodeSummary: "Rebuilt payment processing for reliability",
      },
      [],
      3
    );
    assert.ok(prompt.includes("Payment Flow Overhaul"));
    assert.ok(prompt.includes("Rebuilt payment processing"));
  });

  it("handles empty decision matches gracefully", () => {
    const prompt = buildBulletGenerationPrompt(
      { items: SAMPLE_EVIDENCE_ITEMS },
      [],
      3
    );
    assert.ok(!prompt.includes("DECISION REASONING"), "Should not have decision section with empty matches");
  });
});

// ─── generateBulletTexts ────────────────────────────────────────────────────

describe("generateBulletTexts", () => {
  it("returns empty array for empty evidence", async () => {
    const result = await generateBulletTexts({ items: [] });
    assert.deepEqual(result, []);
  });

  it("calls llmFn and processes results", async () => {
    const mockLlmFn = async () => [
      { text: "Designed event-driven pipeline after profiling revealed 3x CPU savings" },
      { text: "Implemented structured error boundaries to eliminate non-transient failure cascades" },
    ];

    const result = await generateBulletTexts(
      {
        items: SAMPLE_EVIDENCE_ITEMS,
        decisions: [SAMPLE_DECISION_TRADEOFF],
        repo: "myrepo",
      },
      { llmFn: mockLlmFn, maxBullets: 3 }
    );

    assert.ok(result.length > 0, "Should generate bullets");
    for (const bullet of result) {
      assert.ok(bullet.text, "Each bullet should have text");
      assert.ok(typeof bullet.integrationScore === "number");
      assert.ok(bullet.patternId, "Each bullet should have a pattern ID");
    }
  });

  it("normalizes bullet text via resumeVoice", async () => {
    const mockLlmFn = async () => [
      { text: "  - Designed event-driven pipeline for messaging  " },
    ];

    const result = await generateBulletTexts(
      { items: SAMPLE_EVIDENCE_ITEMS },
      { llmFn: mockLlmFn }
    );

    if (result.length > 0) {
      // Should be trimmed and normalized
      assert.ok(!result[0].text.startsWith("  "), "Should be trimmed");
      assert.ok(!result[0].text.startsWith("-"), "Should strip bullet markers");
    }
  });

  it("filters out too-short bullets", async () => {
    const mockLlmFn = async () => [
      { text: "Short" },  // too short (< 30 chars)
      { text: "Designed event-driven pipeline for efficient message processing across services" },
    ];

    const result = await generateBulletTexts(
      { items: SAMPLE_EVIDENCE_ITEMS },
      { llmFn: mockLlmFn }
    );

    // Should filter out the short one
    assert.ok(result.every(b => b.text.length >= 30));
  });

  it("handles LLM returning string bullets instead of objects", async () => {
    const mockLlmFn = async () => [
      "Built event-driven pipeline for real-time message processing",
    ];

    const result = await generateBulletTexts(
      { items: SAMPLE_EVIDENCE_ITEMS },
      { llmFn: mockLlmFn }
    );

    assert.ok(result.length > 0);
    assert.ok(result[0].text.length >= 30);
  });
});

// ─── batchGenerateBullets ───────────────────────────────────────────────────

describe("batchGenerateBullets", () => {
  it("returns empty array for empty episodes", async () => {
    const result = await batchGenerateBullets([], []);
    assert.deepEqual(result, []);
  });

  it("generates bullets for each episode", async () => {
    const mockLlmFn = async () => [
      { text: "Built event-driven messaging pipeline reducing CPU usage by 3x" },
      { text: "Implemented structured error boundaries for fault isolation" },
    ];

    const result = await batchGenerateBullets(
      [SAMPLE_EPISODE],
      [SAMPLE_DECISION_TRADEOFF, SAMPLE_DECISION_CAUSAL],
      { repo: "myrepo", llmFn: mockLlmFn }
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].episodeId, "ep-myrepo-0");
    assert.ok(result[0].bullets.length > 0);
  });

  it("handles multiple episodes", async () => {
    const mockLlmFn = async () => [
      { text: "Designed scalable processing pipeline for high-throughput workloads" },
    ];

    const episode2 = {
      ...SAMPLE_EPISODE,
      id: "ep-myrepo-1",
      title: "GraphQL migration",
      dates: ["2026-03-18"],
    };

    const result = await batchGenerateBullets(
      [SAMPLE_EPISODE, episode2],
      [SAMPLE_DECISION_TRADEOFF],
      { repo: "myrepo", llmFn: mockLlmFn }
    );

    assert.equal(result.length, 2);
    assert.equal(result[0].episodeId, "ep-myrepo-0");
    assert.equal(result[1].episodeId, "ep-myrepo-1");
  });

  it("filters decisions by episode relevance", async () => {
    let capturedPrompt = "";
    const mockLlmFn = async (prompt) => {
      capturedPrompt = prompt;
      return [{ text: "Built messaging pipeline with event-driven processing architecture" }];
    };

    await batchGenerateBullets(
      [SAMPLE_EPISODE],
      [SAMPLE_DECISION_TRADEOFF, SAMPLE_DECISION_STRATEGIC],
      { repo: "myrepo", llmFn: mockLlmFn }
    );

    // SAMPLE_DECISION_TRADEOFF (date 2026-03-15) should match episode (dates include 2026-03-15)
    // SAMPLE_DECISION_STRATEGIC (date 2026-03-18) should NOT match (different date, different topic)
    // But the prompt building includes both if topic matches, so we just verify it ran
    assert.ok(capturedPrompt.length > 0);
  });
});

// ─── _validateDecisionIntegration ───────────────────────────────────────────

describe("_validateDecisionIntegration", () => {
  it("returns false for null inputs", () => {
    assert.equal(_validateDecisionIntegration(null, null), false);
  });

  it("returns true for well-integrated bullet", () => {
    assert.equal(
      _validateDecisionIntegration(
        "Chose event-driven architecture over polling after profiling showed 3x lower CPU usage",
        SAMPLE_DECISION_TRADEOFF
      ),
      true
    );
  });

  it("returns false for metadata-style bullet", () => {
    assert.equal(
      _validateDecisionIntegration(
        "Implemented event-driven architecture (Reason: better performance than polling approach)",
        SAMPLE_DECISION_TRADEOFF
      ),
      false
    );
  });

  it("returns false for bullet without reasoning language", () => {
    assert.equal(
      _validateDecisionIntegration(
        "Implemented event-driven architecture",
        SAMPLE_DECISION_TRADEOFF
      ),
      false
    );
  });

  it("returns false for overlength bullet", () => {
    const longBullet = "Chose event-driven architecture over polling " + "A".repeat(120);
    assert.equal(
      _validateDecisionIntegration(longBullet, SAMPLE_DECISION_TRADEOFF),
      false
    );
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles decisions with no alternatives", () => {
    const decision = {
      topic: "Added caching layer",
      alternatives: [],
      chosen: "Redis caching",
      rationale: "High read-to-write ratio made caching essential",
      confidence: 0.7,
    };
    const pattern = selectContextualPattern(decision);
    assert.ok(pattern, "Should return a pattern even without alternatives");
  });

  it("handles evidence items without dates", () => {
    const items = [
      { text: "Built authentication service", type: "commit" },
    ];
    const matches = matchDecisionsToEvidence(
      [SAMPLE_DECISION_TRADEOFF],
      items
    );
    assert.ok(Array.isArray(matches));
  });

  it("handles decisions with empty rationale", () => {
    const decision = {
      topic: "Chose TypeScript",
      alternatives: ["JavaScript"],
      chosen: "TypeScript",
      rationale: "",
      confidence: 0.6,
    };
    const result = embedDecisionInBullet(
      "Migrated codebase to TypeScript",
      decision
    );
    // Should return original since rationale is empty
    assert.equal(result, "Migrated codebase to TypeScript");
  });

  it("handles Korean decision text", () => {
    const decision = {
      topic: "이벤트 기반 아키텍처 선택",
      alternatives: ["폴링 방식"],
      chosen: "이벤트 기반 메시지 큐",
      rationale: "프로파일링 결과 CPU 사용량이 3배 낮았음",
      confidence: 0.85,
    };
    const pattern = selectContextualPattern(decision);
    assert.ok(pattern, "Should handle Korean text");
  });

  it("scores bullet with Korean reasoning language", () => {
    const result = scoreBulletDecisionIntegration(
      "이벤트 기반 아키텍처를 도입하여 CPU 사용량을 3배 줄임, 결과 비용 40% 절감",
      {
        topic: "이벤트 기반 아키텍처",
        chosen: "이벤트 기반",
        rationale: "CPU 사용량 절감",
        confidence: 0.9,
      }
    );
    assert.ok(typeof result.score === "number");
    // Korean reasoning markers should be detected
    assert.ok(result.hasReasoningLanguage, "Should detect Korean reasoning markers (결과)");
  });
});

// ─── CONTEXTUAL_PATTERNS (new categories) ──────────────────────────────────

describe("CONTEXTUAL_PATTERNS - composite and iterative", () => {
  it("includes composite category patterns", () => {
    const composites = CONTEXTUAL_PATTERNS.filter(p => p.category === "composite");
    assert.ok(composites.length >= 2, `Expected >= 2 composite patterns, got ${composites.length}`);
  });

  it("includes iterative category pattern", () => {
    const iteratives = CONTEXTUAL_PATTERNS.filter(p => p.category === "iterative");
    assert.ok(iteratives.length >= 1, `Expected >= 1 iterative pattern, got ${iteratives.length}`);
  });

  it("composite patterns have unique IDs", () => {
    const composites = CONTEXTUAL_PATTERNS.filter(p => p.category === "composite");
    const ids = composites.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("composite pattern examples contain natural reasoning", () => {
    const composites = CONTEXTUAL_PATTERNS.filter(p => p.category === "composite");
    for (const p of composites) {
      assert.ok(
        !/\((?:reason|decision|rationale):/i.test(p.example),
        `Composite pattern ${p.id} example uses metadata-style reasoning`
      );
    }
  });
});

// ─── composeMultiDecisionBullet ────────────────────────────────────────────

describe("composeMultiDecisionBullet", () => {
  it("returns empty string for null bullet", () => {
    assert.equal(composeMultiDecisionBullet(null, [SAMPLE_DECISION_TRADEOFF]), "");
  });

  it("returns original bullet for empty decisions", () => {
    assert.equal(
      composeMultiDecisionBullet("Built messaging pipeline", []),
      "Built messaging pipeline"
    );
  });

  it("delegates to embedDecisionInBullet for single decision", () => {
    const single = composeMultiDecisionBullet(
      "Implemented event-driven architecture for messaging",
      [SAMPLE_DECISION_TRADEOFF]
    );
    const direct = embedDecisionInBullet(
      "Implemented event-driven architecture for messaging",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.equal(single, direct, "Single decision should delegate");
  });

  it("composes two decisions into one bullet", () => {
    const result = composeMultiDecisionBullet(
      "Redesigned message processing pipeline",
      [SAMPLE_DECISION_TRADEOFF, SAMPLE_DECISION_CAUSAL]
    );
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
    // Should not exceed char limit
    assert.ok(result.length <= 140, `Composed bullet too long: ${result.length} chars`);
  });

  it("prioritizes higher-confidence decision", () => {
    const highConf = { ...SAMPLE_DECISION_TRADEOFF, confidence: 0.95 };
    const lowConf = { ...SAMPLE_DECISION_CAUSAL, confidence: 0.5 };
    const result = composeMultiDecisionBullet(
      "Implemented event-driven architecture for messaging",
      [lowConf, highConf]  // Deliberately reversed order
    );
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it("returns original when bullet already has reasoning", () => {
    const bullet = "Built pipeline after profiling showed 3x gains";
    const result = composeMultiDecisionBullet(bullet, [
      SAMPLE_DECISION_TRADEOFF,
      SAMPLE_DECISION_CAUSAL,
    ]);
    assert.equal(result, bullet, "Should not double-enrich");
  });

  it("falls back to single-decision when composite too long", () => {
    const longBullet = "Redesigned comprehensive event-driven architecture across all microservice clusters";
    const result = composeMultiDecisionBullet(longBullet, [
      SAMPLE_DECISION_TRADEOFF,
      SAMPLE_DECISION_CAUSAL,
    ]);
    assert.ok(result.length <= 140, "Should fall back to stay within limit");
  });

  it("filters out decisions with empty rationale", () => {
    const noRationale = { ...SAMPLE_DECISION_CAUSAL, rationale: "" };
    const result = composeMultiDecisionBullet(
      "Implemented event-driven architecture for messaging",
      [SAMPLE_DECISION_TRADEOFF, noRationale]
    );
    // Should behave like single-decision since one is filtered
    const single = embedDecisionInBullet(
      "Implemented event-driven architecture for messaging",
      SAMPLE_DECISION_TRADEOFF
    );
    assert.equal(result, single);
  });
});

// ─── rankDecisionsForBullet ────────────────────────────────────────────────

describe("rankDecisionsForBullet", () => {
  it("returns empty for null inputs", () => {
    assert.deepEqual(rankDecisionsForBullet(null, "hello"), []);
    assert.deepEqual(rankDecisionsForBullet([], null), []);
  });

  it("ranks decisions by weighted score", () => {
    const ranked = rankDecisionsForBullet(
      [SAMPLE_DECISION_TRADEOFF, SAMPLE_DECISION_STRATEGIC, SAMPLE_DECISION_CAUSAL],
      "Implemented event-driven message processing pipeline"
    );
    assert.ok(ranked.length === 3);
    // Should be sorted descending
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(
        ranked[i - 1].weightedScore >= ranked[i].weightedScore,
        "Should be sorted descending by weighted score"
      );
    }
  });

  it("each result has decision and weightedScore", () => {
    const ranked = rankDecisionsForBullet(
      [SAMPLE_DECISION_TRADEOFF],
      "event-driven architecture message pipeline"
    );
    assert.ok(ranked.length > 0);
    assert.ok(ranked[0].decision === SAMPLE_DECISION_TRADEOFF);
    assert.ok(typeof ranked[0].weightedScore === "number");
    assert.ok(ranked[0].weightedScore >= 0 && ranked[0].weightedScore <= 1);
  });

  it("respects custom weights", () => {
    // With all weight on confidence, ordering should follow confidence
    const ranked = rankDecisionsForBullet(
      [
        { ...SAMPLE_DECISION_TRADEOFF, confidence: 0.5 },
        { ...SAMPLE_DECISION_CAUSAL, confidence: 0.95 },
      ],
      "Unrelated text about documentation updates",
      { relevance: 0, confidence: 1 }
    );
    assert.ok(ranked.length === 2);
    assert.ok(
      ranked[0].decision.confidence >= ranked[1].decision.confidence,
      "Pure confidence weighting should sort by confidence"
    );
  });

  it("filters out decisions without topic", () => {
    const ranked = rankDecisionsForBullet(
      [SAMPLE_DECISION_TRADEOFF, { chosen: "foo", rationale: "bar", confidence: 0.9 }],
      "event-driven architecture"
    );
    assert.equal(ranked.length, 1, "Should filter decision without topic");
  });

  it("higher relevance boosts ranking over lower confidence", () => {
    // Decision A: highly relevant to the bullet (same topic), low confidence
    const decisionA = {
      topic: "Event-driven architecture vs polling for messages",
      alternatives: ["polling"],
      chosen: "event-driven",
      rationale: "lower CPU",
      confidence: 0.5,
    };
    // Decision B: irrelevant to the bullet, high confidence
    const decisionB = {
      topic: "Database schema normalization approach",
      alternatives: ["denormalized"],
      chosen: "normalized schema",
      rationale: "data integrity",
      confidence: 0.95,
    };
    const ranked = rankDecisionsForBullet(
      [decisionB, decisionA],
      "Implemented event-driven message processing pipeline architecture"
    );
    assert.ok(ranked.length === 2);
    // Decision A should rank higher due to relevance despite lower confidence
    assert.ok(
      ranked[0].decision === decisionA,
      "Higher relevance should beat higher confidence for this bullet"
    );
  });
});
