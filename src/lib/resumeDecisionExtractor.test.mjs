/**
 * Unit tests for resumeDecisionExtractor.mjs
 *
 * Run with:
 *   node --test src/lib/resumeDecisionExtractor.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasDecisionSignals,
  _segmentConversation,
  _buildExtractionPrompt,
  _DECISION_SIGNAL_PATTERNS,
  extractDecisionPoints,
  extractDecisionPointsFromSnippets,
  buildDecisionContext,
  enrichSessionSnippetsWithDecisions
} from "./resumeDecisionExtractor.mjs";

// ─── hasDecisionSignals ──────────────────────────────────────────────────────

describe("hasDecisionSignals", () => {
  it("returns false for null/undefined/empty", () => {
    assert.equal(hasDecisionSignals(null), false);
    assert.equal(hasDecisionSignals(undefined), false);
    assert.equal(hasDecisionSignals(""), false);
  });

  it("returns false for very short text", () => {
    assert.equal(hasDecisionSignals("chose X"), false);
    assert.equal(hasDecisionSignals("ok"), false);
  });

  it("returns false for non-string input", () => {
    assert.equal(hasDecisionSignals(42), false);
    assert.equal(hasDecisionSignals({}), false);
  });

  it("returns false for mundane implementation text", () => {
    // Single signal word is not enough
    assert.equal(
      hasDecisionSignals("Fixed the login button styling to match the design system and updated the test"),
      false
    );
  });

  it("returns true for English text with multiple decision signals", () => {
    assert.equal(
      hasDecisionSignals(
        "I decided to use event-driven architecture instead of polling because it provides better scalability"
      ),
      true
    );
  });

  it("returns true for text with trade-off discussion", () => {
    assert.equal(
      hasDecisionSignals(
        "Considered using Redis for caching but chose in-memory LRU because the trade-off favors simplicity for our scale"
      ),
      true
    );
  });

  it("returns true for Korean decision text", () => {
    assert.equal(
      hasDecisionSignals(
        "폴링 대신 이벤트 기반 아키텍처를 선택했습니다. 이유는 확장성이 더 좋기 때문입니다."
      ),
      true
    );
  });

  it("returns true for alternative comparison text", () => {
    assert.equal(
      hasDecisionSignals(
        "Compared PostgreSQL versus MongoDB for this use case, and opted for PostgreSQL because of its better support for complex queries"
      ),
      true
    );
  });

  it("returns true for refactoring rationale text", () => {
    assert.equal(
      hasDecisionSignals(
        "Chose to refactor the payment module rather than patching it, because the existing approach was becoming unmaintainable"
      ),
      true
    );
  });
});

// ─── _DECISION_SIGNAL_PATTERNS ──────────────────────────────────────────────

describe("_DECISION_SIGNAL_PATTERNS", () => {
  it("is a non-empty array of RegExp", () => {
    assert.ok(Array.isArray(_DECISION_SIGNAL_PATTERNS));
    assert.ok(_DECISION_SIGNAL_PATTERNS.length > 0);
    for (const p of _DECISION_SIGNAL_PATTERNS) {
      assert.ok(p instanceof RegExp, `Expected RegExp, got ${typeof p}`);
    }
  });

  it("includes English decision patterns", () => {
    const text = "decided to use X instead of Y because of better performance";
    const matches = _DECISION_SIGNAL_PATTERNS.filter(p => p.test(text));
    assert.ok(matches.length >= 2, "Should match multiple English decision patterns");
  });

  it("includes Korean decision patterns", () => {
    const text = "이벤트 기반 방식으로 전환한 이유는 성능 때문입니다";
    const matches = _DECISION_SIGNAL_PATTERNS.filter(p => p.test(text));
    assert.ok(matches.length >= 1, "Should match Korean decision patterns");
  });
});

// ─── _segmentConversation ───────────────────────────────────────────────────

describe("_segmentConversation", () => {
  it("returns empty array for null/undefined/non-array", () => {
    assert.deepEqual(_segmentConversation(null), []);
    assert.deepEqual(_segmentConversation(undefined), []);
    assert.deepEqual(_segmentConversation("not an array"), []);
  });

  it("returns empty array for empty snippets", () => {
    assert.deepEqual(_segmentConversation([]), []);
  });

  it("filters out short snippets", () => {
    const result = _segmentConversation(["ok", "yes", "done"]);
    assert.equal(result.length, 0);
  });

  it("classifies question-like text as user role", () => {
    const result = _segmentConversation([
      "How should I implement the caching layer for the API service?"
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, "user");
  });

  it("classifies long explanatory text as assistant role", () => {
    const longText = "I recommend using Redis for the caching layer. Here's why: " +
      "Redis provides excellent performance for key-value lookups and supports " +
      "TTL-based expiration out of the box. The main alternative would be Memcached, " +
      "but Redis has better support for complex data structures. " +
      "For your use case with approximately 10k requests per second, " +
      "Redis can handle this easily with a single instance. " +
      "The implementation would involve wrapping your database queries " +
      "with a cache-aside pattern using ioredis as the client library.";
    const result = _segmentConversation([longText]);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, "assistant");
  });

  it("preserves order with sequential indices", () => {
    const result = _segmentConversation([
      "What approach should we take for the database migration strategy?",
      "I recommend doing a blue-green deployment approach for the database migration. " +
        "This minimizes downtime and provides a safe rollback path if issues arise. " +
        "The alternative would be a direct cutover, but that carries more risk."
    ]);
    assert.equal(result.length, 2);
    assert.equal(result[0].index, 0);
    assert.equal(result[1].index, 1);
  });

  it("handles Korean user messages", () => {
    const result = _segmentConversation([
      "어떻게 캐싱 레이어를 구현해야 할까요? Redis vs Memcached 비교해줘"
    ]);
    assert.equal(result.length, 1);
    // Korean question patterns should be detected
    assert.equal(result[0].role, "user");
  });
});

// ─── _buildExtractionPrompt ─────────────────────────────────────────────────

describe("_buildExtractionPrompt", () => {
  it("includes repo and date when provided", () => {
    const segments = [
      { role: "user", text: "Should we use REST or GraphQL for the new API?", index: 0 }
    ];
    const result = _buildExtractionPrompt(segments, { repo: "my-app", date: "2025-06-15" });
    assert.ok(result.includes("my-app"));
    assert.ok(result.includes("2025-06-15"));
  });

  it("includes CONVERSATION header", () => {
    const segments = [
      { role: "user", text: "How should we handle error retry logic in the pipeline?", index: 0 }
    ];
    const result = _buildExtractionPrompt(segments);
    assert.ok(result.includes("=== CONVERSATION ==="));
  });

  it("labels user and assistant messages correctly", () => {
    const segments = [
      { role: "user", text: "What database should we use for the analytics feature?", index: 0 },
      { role: "assistant", text: "I recommend PostgreSQL with TimescaleDB extension because it provides excellent time-series support.", index: 1 }
    ];
    const result = _buildExtractionPrompt(segments);
    assert.ok(result.includes("[USER]"));
    assert.ok(result.includes("[ASSISTANT]"));
  });

  it("truncates individual messages at 2000 chars", () => {
    const longText = "x".repeat(5000);
    const segments = [
      { role: "assistant", text: longText, index: 0 }
    ];
    const result = _buildExtractionPrompt(segments);
    // The prompt should not contain the full 5000 chars
    assert.ok(result.length < 5000 + 500); // some overhead for headers
  });

  it("includes extraction instruction at the end", () => {
    const segments = [
      { role: "user", text: "Which approach should we take for the API versioning strategy?", index: 0 }
    ];
    const result = _buildExtractionPrompt(segments);
    assert.ok(result.includes("Extract all engineering decision points"));
  });
});

// ─── extractDecisionPoints ──────────────────────────────────────────────────

describe("extractDecisionPoints", () => {
  // Mock LLM function that returns predictable decisions
  function mockLlmFn(segments, meta) {
    return [
      {
        topic: "Caching strategy for API layer",
        alternatives: ["Redis with TTL", "In-memory LRU cache", "No caching"],
        chosen: "Redis with TTL",
        rationale: "Better durability across restarts and shared state across instances",
        impact: "Reduced p99 latency from 200ms to 50ms",
        confidence: 0.9
      },
      {
        topic: "Error handling approach",
        alternatives: ["Retry with backoff", "Circuit breaker", "Fail-fast"],
        chosen: "Circuit breaker",
        rationale: "Prevents cascade failures under sustained load",
        confidence: 0.7
      }
    ];
  }

  it("returns empty array for null/empty sessions", async () => {
    const result = await extractDecisionPoints(null);
    assert.deepEqual(result, []);

    const result2 = await extractDecisionPoints([]);
    assert.deepEqual(result2, []);
  });

  it("skips sessions without snippets", async () => {
    const sessions = [{ source: "codex" }]; // no snippets
    const result = await extractDecisionPoints(sessions, { llmFn: mockLlmFn });
    assert.deepEqual(result, []);
  });

  it("skips sessions without decision signals", async () => {
    let llmCalled = false;
    const sessions = [{
      source: "codex",
      cwd: "/repos/my-app",
      summary: "Fixed a typo in the README",
      snippets: ["Updated the README file with correct installation instructions and formatting"]
    }];
    const result = await extractDecisionPoints(sessions, {
      llmFn: () => { llmCalled = true; return []; }
    });
    assert.equal(llmCalled, false, "LLM should not be called for non-decision sessions");
    assert.deepEqual(result, []);
  });

  it("extracts decisions from sessions with decision signals", async () => {
    const sessions = [{
      source: "claude",
      cwd: "/repos/my-app",
      summary: "Discussed caching strategy",
      snippets: [
        "Should we use Redis or Memcached? I need to decide between these alternatives for the caching layer because performance is critical.",
        "I recommend Redis with TTL-based expiration. The rationale is that Redis provides better durability across restarts and shared state across multiple instances. The alternative of in-memory LRU would be simpler but doesn't survive restarts."
      ]
    }];

    const result = await extractDecisionPoints(sessions, {
      date: "2025-06-15",
      repo: "my-app",
      llmFn: mockLlmFn
    });

    assert.ok(result.length >= 1);
    assert.equal(result[0].topic, "Caching strategy for API layer");
    assert.equal(result[0].date, "2025-06-15");
    assert.equal(result[0].source, "claude");
    assert.ok(result[0].alternatives.length > 0);
    assert.ok(result[0].rationale.length > 0);
  });

  it("filters out low-confidence decisions", async () => {
    function lowConfLlm() {
      return [
        { topic: "Minor thing", alternatives: ["A"], chosen: "A", rationale: "Whatever", confidence: 0.1 },
        { topic: "Important choice between REST and GraphQL", alternatives: ["REST", "GraphQL"], chosen: "GraphQL", rationale: "Better client flexibility", confidence: 0.8 }
      ];
    }

    const sessions = [{
      source: "claude",
      cwd: "/repos/api",
      snippets: [
        "I chose to use GraphQL instead of REST because of the flexibility. The decision was based on comparing both alternatives for our use case."
      ]
    }];

    const result = await extractDecisionPoints(sessions, { llmFn: lowConfLlm });
    assert.equal(result.length, 1);
    assert.equal(result[0].topic, "Important choice between REST and GraphQL");
  });

  it("deduplicates similar decisions", async () => {
    function dupLlm() {
      return [
        { topic: "Caching strategy for API", alternatives: ["Redis"], chosen: "Redis", rationale: "Fast", confidence: 0.8 },
        { topic: "Caching strategy for the API layer", alternatives: ["Redis"], chosen: "Redis", rationale: "Fast and reliable", confidence: 0.9 }
      ];
    }

    const sessions = [{
      source: "codex",
      cwd: "/repos/my-app",
      snippets: [
        "We decided to use Redis for caching instead of Memcached because of better data structure support and the rationale for this decision was performance."
      ]
    }];

    const result = await extractDecisionPoints(sessions, { llmFn: dupLlm });
    // Should deduplicate, keeping the higher confidence one
    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, 0.9);
  });

  it("extracts repo name from cwd", async () => {
    let capturedMeta;
    const sessions = [{
      source: "codex",
      cwd: "/Users/dev/repos/payment-service",
      snippets: [
        "I decided to refactor the payment module instead of patching it, because the existing approach was becoming unmaintainable and the alternative would have been worse."
      ]
    }];

    await extractDecisionPoints(sessions, {
      llmFn: (segments, meta) => {
        capturedMeta = meta;
        return [];
      }
    });

    assert.equal(capturedMeta.repo, "payment-service");
  });
});

// ─── extractDecisionPointsFromSnippets ──────────────────────────────────────

describe("extractDecisionPointsFromSnippets", () => {
  it("returns empty array for null/empty", async () => {
    assert.deepEqual(await extractDecisionPointsFromSnippets(null), []);
    assert.deepEqual(await extractDecisionPointsFromSnippets([]), []);
  });

  it("groups snippets by date and extracts decisions", async () => {
    const callDates = [];
    function trackingLlm(segments, meta) {
      callDates.push(meta.date);
      return [{
        topic: `Decision on ${meta.date}`,
        alternatives: ["A", "B"],
        chosen: "A",
        rationale: "Better fit",
        confidence: 0.8
      }];
    }

    const snippets = [
      { date: "2025-06-15", text: "We chose approach A instead of B. The decision was because of better scalability and performance trade-offs." },
      { date: "2025-06-15", text: "Also considered C but decided against it because of maintenance cost compared to approach A." },
      { date: "2025-06-16", text: "Opted for event-driven instead of polling because the rationale favors lower CPU usage in our performance testing." }
    ];

    const result = await extractDecisionPointsFromSnippets(snippets, { llmFn: trackingLlm });
    assert.ok(result.length >= 1);
  });

  it("skips snippets without decision signals", async () => {
    let called = false;
    const snippets = [
      { date: "2025-06-15", text: "Updated the README with installation instructions and fixed some typos." }
    ];
    const result = await extractDecisionPointsFromSnippets(snippets, {
      llmFn: () => { called = true; return []; }
    });
    assert.equal(called, false);
    assert.deepEqual(result, []);
  });
});

// ─── buildDecisionContext ───────────────────────────────────────────────────

describe("buildDecisionContext", () => {
  it("returns empty string for null/empty decisions", () => {
    assert.equal(buildDecisionContext(null), "");
    assert.equal(buildDecisionContext([]), "");
  });

  it("filters out low-confidence decisions", () => {
    const decisions = [
      {
        topic: "Low confidence decision",
        alternatives: ["A"],
        chosen: "A",
        rationale: "Unclear",
        date: "2025-06-15",
        source: "claude",
        confidence: 0.3
      }
    ];
    const result = buildDecisionContext(decisions);
    assert.equal(result, "");
  });

  it("includes high-confidence decisions with full structure", () => {
    const decisions = [
      {
        topic: "Database choice for analytics",
        alternatives: ["PostgreSQL", "MongoDB", "ClickHouse"],
        chosen: "PostgreSQL with TimescaleDB",
        rationale: "Best balance of time-series support and familiar tooling",
        impact: "Reduced query time by 60%",
        date: "2025-06-15",
        source: "claude",
        confidence: 0.9
      }
    ];
    const result = buildDecisionContext(decisions);
    assert.ok(result.includes("EXTRACTED DECISION POINTS"));
    assert.ok(result.includes("Database choice for analytics"));
    assert.ok(result.includes("PostgreSQL | MongoDB | ClickHouse"));
    assert.ok(result.includes("PostgreSQL with TimescaleDB"));
    assert.ok(result.includes("Best balance of"));
    assert.ok(result.includes("Reduced query time by 60%"));
  });

  it("sorts by confidence descending", () => {
    const decisions = [
      { topic: "Low priority", alternatives: [], chosen: "A", rationale: "OK", date: "2025-06-15", source: "claude", confidence: 0.6 },
      { topic: "High priority", alternatives: [], chosen: "B", rationale: "Better", date: "2025-06-15", source: "claude", confidence: 0.95 }
    ];
    const result = buildDecisionContext(decisions);
    const highIdx = result.indexOf("High priority");
    const lowIdx = result.indexOf("Low priority");
    assert.ok(highIdx < lowIdx, "High confidence should appear first");
  });
});

// ─── enrichSessionSnippetsWithDecisions ─────────────────────────────────────

describe("enrichSessionSnippetsWithDecisions", () => {
  it("returns empty array for null/empty", async () => {
    assert.deepEqual(await enrichSessionSnippetsWithDecisions(null), []);
    assert.deepEqual(await enrichSessionSnippetsWithDecisions([]), []);
  });

  it("preserves original snippet text", async () => {
    const snippets = [
      { date: "2025-06-15", text: "We chose Redis instead of Memcached for caching because it supports complex data structures and the alternative lacked persistence." }
    ];

    function mockLlm() {
      return [{
        topic: "Cache provider",
        alternatives: ["Redis", "Memcached"],
        chosen: "Redis",
        rationale: "Complex data structure support",
        confidence: 0.9
      }];
    }

    const result = await enrichSessionSnippetsWithDecisions(snippets, { llmFn: mockLlm });
    assert.equal(result.length, 1);
    assert.equal(result[0].text, snippets[0].text);
    assert.equal(result[0].date, "2025-06-15");
  });

  it("attaches decisions to matching dates", async () => {
    const snippets = [
      { date: "2025-06-15", text: "Decided to use TypeScript instead of JavaScript because type safety reduces bugs. The rationale was based on comparing both alternatives." },
      { date: "2025-06-16", text: "Updated linting configuration and fixed warnings in the test suite." }
    ];

    function mockLlm(segments, meta) {
      if (meta.date === "2025-06-15") {
        return [{
          topic: "Language choice",
          alternatives: ["TypeScript", "JavaScript"],
          chosen: "TypeScript",
          rationale: "Type safety",
          confidence: 0.9
        }];
      }
      return [];
    }

    const result = await enrichSessionSnippetsWithDecisions(snippets, { llmFn: mockLlm });
    assert.equal(result.length, 2);
    assert.ok(result[0].decisions.length >= 1, "First snippet should have decisions");
    assert.equal(result[1].decisions.length, 0, "Second snippet should have no decisions");
  });
});
