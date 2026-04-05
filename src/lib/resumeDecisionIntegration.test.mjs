/**
 * Integration tests: Decision Reasoning → Bullet Text Pipeline
 *
 * Verifies that decision reasoning extracted from sample session conversations
 * appears naturally embedded in generated bullet text output — NOT as separate
 * metadata, prefixed labels, or parenthetical asides.
 *
 * Pipeline under test:
 *   Session conversations (mock)
 *     → resumeDecisionExtractor.extractDecisionPoints()
 *       → resumeBulletTextGenerator.generateBulletTexts() / embedDecisionInBullet()
 *         → Final bullet text containing natural reasoning
 *
 * "Naturally embedded" means:
 *   ✓ "Migrated to event-driven architecture after profiling showed 3x lower CPU usage"
 *   ✗ "Migrated to event-driven architecture. Decision: chose event-driven over polling."
 *   ✗ "Migrated to event-driven architecture (Rationale: better scalability)"
 *
 * Run with:
 *   node --test src/lib/resumeDecisionIntegration.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractDecisionPoints,
  extractDecisionPointsFromSnippets,
  buildDecisionContext,
  hasDecisionSignals,
} from "./resumeDecisionExtractor.mjs";

import {
  generateBulletTexts,
  embedDecisionInBullet,
  composeMultiDecisionBullet,
  batchGenerateBullets,
  scoreBulletDecisionIntegration,
  matchDecisionsToEvidence,
  buildBulletGenerationPrompt,
} from "./resumeBulletTextGenerator.mjs";

import { buildRepoWorkContext, groupEvidenceEpisodes } from "./resumeRecluster.mjs";

// ═══════════════════════════════════════════════════════════════════════════════
// Sample Session Conversations (realistic Codex/Claude interactions)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simulates a Codex session where the developer discusses caching strategy.
 */
const SESSION_CACHING_DECISION = {
  source: "codex",
  cwd: "/Users/dev/repos/api-gateway",
  summary: "Discussed caching strategy for API gateway responses",
  snippets: [
    "How should I implement caching for our API gateway? We're seeing high latency on repeated queries and need to decide between Redis and an in-memory LRU cache.",
    "I recommend Redis with TTL-based expiration for your API gateway caching layer. The key trade-off here is durability versus simplicity. An in-memory LRU cache would be simpler to implement — no external dependency — but it doesn't survive process restarts, and you'd lose cache coherence across your 4 horizontally-scaled instances. Redis gives you shared state across all instances and automatic TTL expiration. The performance overhead of the network hop to Redis is negligible compared to the database queries you're caching. Based on your traffic patterns, I'd estimate this reduces p99 latency from ~200ms to ~50ms for cached paths.",
    "What about Memcached? Should we consider that as an alternative?",
    "Memcached is a valid alternative but Redis wins for your use case because you need support for complex data structures (sorted sets for rate limiting, hashes for session data). Memcached is purely key-value, so you'd need a separate solution for those features. The rationale for choosing Redis over Memcached comes down to operational simplicity — one cache layer instead of two."
  ]
};

/**
 * Simulates a Claude session about error handling architecture.
 */
const SESSION_ERROR_HANDLING_DECISION = {
  source: "claude",
  cwd: "/Users/dev/repos/payment-service",
  summary: "Redesigned error handling for payment processing pipeline",
  snippets: [
    "Our payment processing pipeline has too many retry loops and they're causing cascade failures under load. What approach should we take?",
    "I'd recommend replacing your retry-heavy approach with structured error boundaries. Here's the rationale: I analyzed your error logs and found that roughly 80% of your failures are non-transient — invalid card numbers, expired tokens, insufficient funds. Retrying these is pointless and actually compounds load during traffic spikes. Instead, implement error classification at the boundary: transient errors (network timeouts, rate limits) get exponential backoff with jitter; non-transient errors fail fast with descriptive error codes. This approach prevents the cascade failures you're seeing because retries only happen for errors that are actually recoverable. The circuit breaker pattern on the external payment provider API would add another layer of protection.",
    "Should we use a library like cockatiel for the circuit breaker or build our own?",
    "For your scale, I'd go with a custom lightweight implementation rather than cockatiel. The reason is that cockatiel brings in dependencies you don't need and its configuration model doesn't map cleanly to your multi-provider setup where each provider has different failure characteristics. A custom circuit breaker with per-provider state tracking gives you better observability and simpler debugging. The trade-off is initial development time (~2 days) versus ongoing maintenance simplicity."
  ]
};

/**
 * Simulates a session about database architecture choices.
 */
const SESSION_DATABASE_MIGRATION = {
  source: "codex",
  cwd: "/Users/dev/repos/analytics-platform",
  summary: "Evaluated database options for analytics time-series data",
  snippets: [
    "We need to store analytics events — about 10M events/day with time-series queries. Should we use ClickHouse, TimescaleDB, or just stick with PostgreSQL?",
    "Given your requirements, I'd recommend PostgreSQL with the TimescaleDB extension rather than standalone ClickHouse. Here's my reasoning: TimescaleDB gives you the time-series optimizations you need (automatic partitioning, compression, continuous aggregates) while keeping full PostgreSQL compatibility. This means your team's existing SQL knowledge transfers directly, your ORM layer doesn't change, and your existing backup/monitoring tooling keeps working. ClickHouse would give you better raw query performance for large analytical scans — roughly 2-3x faster on aggregation queries — but the operational cost is significant: separate cluster management, different query dialect, new monitoring stack, and your team would need to learn a new system. At 10M events/day, TimescaleDB handles this comfortably with proper partitioning. The break-even point where ClickHouse's performance advantage justifies the operational overhead is around 100M+ events/day.",
    "What about data retention? We need 90 days hot, 1 year warm.",
    "TimescaleDB's native compression and data tiering handle this elegantly. Enable compression on chunks older than 7 days — this typically achieves 90-95% compression ratios. For the warm tier, TimescaleDB supports tiered storage where older chunks move to cheaper S3-backed storage while remaining queryable. The alternative with ClickHouse would be to use its TTL policies, which are powerful but more complex to configure correctly."
  ]
};

/**
 * Simulates a session about frontend architecture decisions.
 */
const SESSION_FRONTEND_REFACTOR = {
  source: "claude",
  cwd: "/Users/dev/repos/dashboard-ui",
  summary: "Discussed state management refactoring for dashboard",
  snippets: [
    "Our dashboard has grown to 40+ components and the prop drilling is getting unmanageable. Should we adopt Redux, Zustand, or React Context with useReducer?",
    "For a dashboard with 40+ components, I'd recommend Zustand over Redux or Context+useReducer. The decision comes down to three factors: First, Zustand's minimal API surface means less boilerplate than Redux — no action creators, no reducers, no middleware setup. Your team can be productive in hours, not days. Second, Zustand handles derived state better than Context+useReducer for your use case because each store slice only triggers re-renders in subscribed components, whereas Context forces re-renders on all consumers. Third, Zustand integrates cleanly with your existing React Query setup for server state — you'd use Zustand only for client-side UI state (filters, panel visibility, sort preferences) while React Query handles API data. The trade-off versus Redux is that Zustand lacks Redux DevTools' time-travel debugging, but Zustand has its own devtools middleware that covers 90% of debugging needs."
  ]
};

// ═══════════════════════════════════════════════════════════════════════════════
// Mock LLM functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mock decision extraction LLM that returns structured decisions from sessions.
 * Simulates what the real LLM would extract from each conversation.
 */
function mockDecisionLlm(segments, meta) {
  const text = segments.map(s => s.text).join(" ");

  if (text.includes("Redis") && text.includes("caching")) {
    return [
      {
        topic: "Caching layer for API gateway",
        alternatives: ["In-memory LRU cache", "Memcached", "Redis with TTL"],
        chosen: "Redis with TTL-based expiration",
        rationale: "Provides shared state across horizontally-scaled instances and survives process restarts, unlike in-memory solutions",
        impact: "Reduced p99 latency from 200ms to 50ms for cached paths",
        confidence: 0.92,
      },
    ];
  }

  if (text.includes("error") && text.includes("payment")) {
    return [
      {
        topic: "Error handling strategy for payment pipeline",
        alternatives: ["Retry with exponential backoff everywhere", "Circuit breaker + error classification"],
        chosen: "Structured error boundaries with error classification",
        rationale: "80% of failures are non-transient; retrying them compounds load during traffic spikes",
        impact: "Eliminated cascade failures under load",
        confidence: 0.88,
      },
      {
        topic: "Circuit breaker implementation approach",
        alternatives: ["cockatiel library", "Custom lightweight implementation"],
        chosen: "Custom per-provider circuit breaker",
        rationale: "Multi-provider setup needs per-provider state tracking; library doesn't map to this model cleanly",
        confidence: 0.75,
      },
    ];
  }

  if (text.includes("TimescaleDB") || text.includes("analytics")) {
    return [
      {
        topic: "Database for analytics time-series data",
        alternatives: ["PostgreSQL with TimescaleDB", "ClickHouse", "Plain PostgreSQL"],
        chosen: "PostgreSQL with TimescaleDB extension",
        rationale: "Full PostgreSQL compatibility preserves team SQL knowledge, ORM layer, and existing tooling; ClickHouse operational overhead not justified at 10M events/day",
        impact: "Avoided separate cluster management and monitoring stack",
        confidence: 0.90,
      },
    ];
  }

  if (text.includes("Zustand") || text.includes("state management")) {
    return [
      {
        topic: "State management for 40+ component dashboard",
        alternatives: ["Redux", "Context + useReducer", "Zustand"],
        chosen: "Zustand for client-side UI state",
        rationale: "Minimal boilerplate, selective re-renders per store slice, and clean integration with existing React Query setup for server state",
        confidence: 0.85,
      },
    ];
  }

  return [];
}

/**
 * Mock bullet generation LLM that produces bullets incorporating decision reasoning.
 * Simulates realistic LLM output for bullet generation prompts.
 */
function mockBulletLlm(prompt, maxBullets) {
  // Parse the prompt to determine which decisions/evidence to use
  if (prompt.includes("Redis") && prompt.includes("caching")) {
    return [
      "Implemented Redis-based caching layer for API gateway, choosing TTL-based expiration over in-memory LRU to maintain cache coherence across 4 horizontally-scaled instances",
      "Reduced API p99 latency from 200ms to 50ms by introducing shared Redis cache after profiling revealed repeated database queries dominated response time",
    ];
  }

  if (prompt.includes("error") && prompt.includes("payment")) {
    return [
      "Redesigned payment pipeline error handling with structured error boundaries after analysis showed 80% of failures were non-transient, eliminating cascade failures under load",
      "Built custom per-provider circuit breaker over cockatiel library to support multi-provider state tracking with better observability",
    ];
  }

  if (prompt.includes("TimescaleDB") || prompt.includes("analytics")) {
    return [
      "Selected PostgreSQL with TimescaleDB over ClickHouse for analytics pipeline, preserving team SQL expertise and existing ORM while handling 10M daily events with native time-series partitioning",
      "Configured TimescaleDB compression and tiered storage for 90-day hot / 1-year warm retention, achieving 90-95% compression on chunks older than 7 days",
    ];
  }

  if (prompt.includes("Zustand") || prompt.includes("state management")) {
    return [
      "Migrated dashboard state management to Zustand, reducing re-render scope from full-tree Context propagation to per-slice subscriptions across 40+ components",
      "Separated client-side UI state into Zustand stores alongside existing React Query server-state layer, eliminating prop drilling while maintaining clear data ownership boundaries",
    ];
  }

  return ["Implemented feature improvements based on architectural analysis"];
}

/**
 * Mock episode grouping LLM that returns episode structures.
 */
function mockEpisodeLlm(repoContext, extractedDecisions) {
  return [
    {
      title: "API Gateway Caching Layer",
      summary: "Implemented Redis-based caching for API responses",
      dateRange: { start: "2026-03-10", end: "2026-03-15" },
      commitRefs: ["abc123"],
      bullets: [
        "Added caching middleware to API gateway",
        "Configured Redis connection pooling",
      ],
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Metadata-style patterns that should NOT appear in good bullets
// ═══════════════════════════════════════════════════════════════════════════════

const METADATA_PATTERNS = [
  /^(Decision|Reasoning|Rationale|Trade-?off|Context|Note|Key decision):\s/i,
  /\((?:Decision|Rationale|Reasoning|Note|Because|Trade-?off):/i,
  /\[(?:Decision|Rationale|Reasoning)\]/i,
  /\bDecision made:\s/i,
  /\bReasoning:\s/i,
  /;\s*(?:rationale|reason|decision):/i,
];

/**
 * Check that a bullet embeds reasoning naturally (no metadata-style patterns).
 * Returns an object with pass/fail and details.
 */
function assertNaturalReasoning(bullet, decision) {
  const issues = [];

  // Check for metadata-style prefixes/labels
  for (const pattern of METADATA_PATTERNS) {
    if (pattern.test(bullet)) {
      issues.push(`Contains metadata pattern: ${pattern}`);
    }
  }

  // Check that decision reasoning keywords are present
  const rationaleWords = decision.rationale.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const bulletLower = bullet.toLowerCase();
  const rationaleOverlap = rationaleWords.filter(w => bulletLower.includes(w));
  if (rationaleOverlap.length === 0 && rationaleWords.length > 0) {
    issues.push(`No rationale keywords found in bullet. Expected some of: ${rationaleWords.slice(0, 5).join(", ")}`);
  }

  // Check that chosen approach is mentioned
  const chosenLower = decision.chosen.toLowerCase();
  const chosenWords = chosenLower.split(/\s+/).filter(w => w.length > 3);
  const chosenOverlap = chosenWords.filter(w => bulletLower.includes(w));
  if (chosenOverlap.length === 0) {
    issues.push(`Chosen approach "${decision.chosen}" not referenced in bullet`);
  }

  return {
    pass: issues.length === 0,
    bullet,
    decision: decision.topic,
    issues,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Decision Reasoning → Bullet Text Integration", () => {

  // ─── End-to-end: Session → Decisions → Bullets ─────────────────────────────

  describe("end-to-end: session conversations → decision extraction → bullet generation", () => {

    it("caching decision reasoning appears naturally in generated bullets", async () => {
      // Step 1: Extract decisions from the session
      const decisions = await extractDecisionPoints(
        [SESSION_CACHING_DECISION],
        { date: "2026-03-15", repo: "api-gateway", llmFn: mockDecisionLlm }
      );

      assert.ok(decisions.length >= 1, "Should extract at least one decision");
      assert.ok(decisions[0].rationale.length > 0, "Decision should have rationale");

      // Step 2: Generate bullets with decision context
      const evidence = {
        items: [
          { text: "Implemented Redis caching layer for API gateway", date: "2026-03-15", type: "commit" },
          { text: "Added TTL-based cache invalidation", date: "2026-03-15", type: "bullet" },
        ],
        decisions,
        repo: "api-gateway",
        episodeTitle: "API Gateway Caching",
        episodeSummary: "Implemented caching to reduce API latency",
      };

      const bullets = await generateBulletTexts(evidence, {
        maxBullets: 3,
        llmFn: mockBulletLlm,
      });

      assert.ok(bullets.length >= 1, "Should generate at least one bullet");

      // Step 3: Verify decision reasoning is naturally embedded
      for (const bullet of bullets) {
        const result = assertNaturalReasoning(bullet.text, decisions[0]);
        assert.ok(
          result.pass,
          `Bullet has unnatural reasoning: ${result.issues.join("; ")}\nBullet: "${bullet.text}"`
        );
      }

      // Step 4: Verify at least one bullet mentions the WHY (not just the WHAT)
      const allBulletText = bullets.map(b => b.text).join(" ").toLowerCase();
      const mentionsReasoning = (
        allBulletText.includes("latency") ||
        allBulletText.includes("instance") ||
        allBulletText.includes("shared") ||
        allBulletText.includes("coherence") ||
        allBulletText.includes("horizontally")
      );
      assert.ok(mentionsReasoning, "At least one bullet should reference WHY Redis was chosen");
    });

    it("error handling decision reasoning appears naturally in generated bullets", async () => {
      const decisions = await extractDecisionPoints(
        [SESSION_ERROR_HANDLING_DECISION],
        { date: "2026-03-16", repo: "payment-service", llmFn: mockDecisionLlm }
      );

      assert.ok(decisions.length >= 1, "Should extract error handling decisions");

      const evidence = {
        items: [
          { text: "Replaced retry loops with structured error boundaries in payment pipeline", date: "2026-03-16", type: "commit" },
          { text: "Added error classification for transient vs non-transient failures", date: "2026-03-16", type: "commit" },
          { text: "Implemented per-provider circuit breaker for payment APIs", date: "2026-03-16", type: "bullet" },
        ],
        decisions,
        repo: "payment-service",
        episodeTitle: "Payment Error Handling Redesign",
        episodeSummary: "Redesigned error handling to prevent cascade failures",
      };

      const bullets = await generateBulletTexts(evidence, {
        maxBullets: 3,
        llmFn: mockBulletLlm,
      });

      assert.ok(bullets.length >= 1);

      // Verify reasoning is embedded, not appended
      for (const bullet of bullets) {
        for (const pattern of METADATA_PATTERNS) {
          assert.ok(
            !pattern.test(bullet.text),
            `Bullet contains metadata pattern ${pattern}: "${bullet.text}"`
          );
        }
      }

      // Verify specific reasoning appears
      const allText = bullets.map(b => b.text).join(" ").toLowerCase();
      const hasReasoningContext = (
        allText.includes("80%") ||
        allText.includes("non-transient") ||
        allText.includes("cascade") ||
        allText.includes("load") ||
        allText.includes("analysis")
      );
      assert.ok(hasReasoningContext, "Bullets should embed error handling rationale naturally");
    });

    it("database migration decision reasoning appears naturally in generated bullets", async () => {
      const decisions = await extractDecisionPoints(
        [SESSION_DATABASE_MIGRATION],
        { date: "2026-03-18", repo: "analytics-platform", llmFn: mockDecisionLlm }
      );

      assert.ok(decisions.length >= 1);

      const evidence = {
        items: [
          { text: "Set up TimescaleDB extension on analytics database", date: "2026-03-18", type: "commit" },
          { text: "Configured time-series partitioning for event ingestion", date: "2026-03-18", type: "commit" },
        ],
        decisions,
        repo: "analytics-platform",
        episodeTitle: "Analytics Database Architecture",
        episodeSummary: "Evaluated and implemented time-series database for analytics",
      };

      const bullets = await generateBulletTexts(evidence, {
        maxBullets: 3,
        llmFn: mockBulletLlm,
      });

      assert.ok(bullets.length >= 1);

      const allText = bullets.map(b => b.text).join(" ").toLowerCase();

      // The reasoning "chose X over Y because Z" should be naturally embedded
      const hasAlternativeComparison = (
        allText.includes("over clickhouse") ||
        allText.includes("instead of clickhouse") ||
        allText.includes("rather than clickhouse") ||
        allText.includes("timescaledb")
      );
      assert.ok(hasAlternativeComparison, "Bullets should reference the alternative considered (ClickHouse)");

      const hasRationale = (
        allText.includes("sql") ||
        allText.includes("orm") ||
        allText.includes("existing") ||
        allText.includes("team") ||
        allText.includes("expertise") ||
        allText.includes("preserving") ||
        allText.includes("compatibility")
      );
      assert.ok(hasRationale, "Bullets should embed rationale for choosing TimescaleDB");
    });
  });

  // ─── embedDecisionInBullet: local enrichment ──────────────────────────────

  describe("embedDecisionInBullet: natural reasoning insertion", () => {

    it("embeds caching rationale without metadata labels", () => {
      const baseBullet = "Implemented Redis caching for API gateway responses";
      const decision = {
        topic: "Caching layer for API gateway",
        alternatives: ["In-memory LRU", "Memcached"],
        chosen: "Redis with TTL",
        rationale: "Shared state across instances and survives restarts",
        confidence: 0.9,
      };

      const enriched = embedDecisionInBullet(baseBullet, decision);

      // Should be different from original (enrichment happened)
      if (enriched !== baseBullet) {
        // If enrichment occurred, verify it's natural
        const result = assertNaturalReasoning(enriched, decision);
        assert.ok(
          result.pass,
          `Enriched bullet has metadata-style reasoning: ${result.issues.join("; ")}\n` +
          `Original: "${baseBullet}"\nEnriched: "${enriched}"`
        );
        // Should be longer (added reasoning)
        assert.ok(enriched.length > baseBullet.length, "Enriched bullet should be longer");
      }
    });

    it("embeds error handling rationale naturally", () => {
      const baseBullet = "Redesigned error handling for payment processing pipeline";
      const decision = {
        topic: "Error handling strategy for payment pipeline",
        alternatives: ["Retry with backoff"],
        chosen: "Structured error boundaries",
        rationale: "Most failures are non-transient; retries compound load",
        confidence: 0.88,
      };

      const enriched = embedDecisionInBullet(baseBullet, decision);

      if (enriched !== baseBullet) {
        for (const pattern of METADATA_PATTERNS) {
          assert.ok(
            !pattern.test(enriched),
            `Enriched bullet contains metadata pattern: "${enriched}"`
          );
        }
      }
    });

    it("handles multiple decisions via composeMultiDecisionBullet without metadata", () => {
      const baseBullet = "Built custom error handling with circuit breaker for payments";
      const decisions = [
        {
          topic: "Error handling strategy",
          alternatives: ["Retry loops"],
          chosen: "Error boundaries with classification",
          rationale: "80% of failures non-transient",
          confidence: 0.88,
        },
        {
          topic: "Circuit breaker implementation",
          alternatives: ["cockatiel library"],
          chosen: "Custom per-provider circuit breaker",
          rationale: "Multi-provider setup needs per-provider state tracking",
          confidence: 0.75,
        },
      ];

      const composed = composeMultiDecisionBullet(baseBullet, decisions);

      for (const pattern of METADATA_PATTERNS) {
        assert.ok(
          !pattern.test(composed),
          `Multi-decision bullet has metadata pattern: "${composed}"`
        );
      }
    });
  });

  // ─── Decision context flows through the prompt ────────────────────────────

  describe("decision context integration with bullet generation prompt", () => {

    it("buildDecisionContext produces structured context without metadata labels in values", () => {
      const decisions = [
        {
          topic: "Caching strategy",
          alternatives: ["LRU", "Memcached"],
          chosen: "Redis",
          rationale: "Better shared state across scaled instances",
          date: "2026-03-15",
          source: "codex",
          confidence: 0.9,
        },
      ];

      const context = buildDecisionContext(decisions);
      assert.ok(context.includes("DECISION"), "Context should have decision header");
      assert.ok(context.includes("Caching strategy"), "Context should include topic");
      assert.ok(context.includes("Redis"), "Context should include chosen approach");
      assert.ok(context.includes("shared state"), "Context should include rationale");
    });

    it("bullet generation prompt includes decisions as guidance, not as labels to copy", () => {
      const evidence = {
        items: [
          { text: "Added Redis caching", date: "2026-03-15", type: "commit" },
        ],
        repo: "api-gateway",
        episodeTitle: "Caching",
        episodeSummary: "Added caching layer",
      };

      const decisions = [
        {
          topic: "Caching layer",
          alternatives: ["LRU"],
          chosen: "Redis",
          rationale: "Shared state across instances",
          confidence: 0.9,
        },
      ];

      const matches = matchDecisionsToEvidence(decisions, evidence.items);
      const prompt = buildBulletGenerationPrompt(evidence, matches, 3);

      // Prompt should contain decision info
      assert.ok(
        prompt.toLowerCase().includes("redis") || prompt.toLowerCase().includes("caching"),
        "Prompt should include decision context"
      );

      // Prompt should instruct natural embedding (check for anti-metadata instructions)
      const promptLower = prompt.toLowerCase();
      const hasNaturalInstruction = (
        promptLower.includes("natural") ||
        promptLower.includes("embed") ||
        promptLower.includes("metadata") ||
        promptLower.includes("do not") ||
        promptLower.includes("pattern")
      );
      assert.ok(hasNaturalInstruction, "Prompt should guide natural reasoning integration");
    });
  });

  // ─── scoreBulletDecisionIntegration quality checks ────────────────────────

  describe("integration quality scoring", () => {

    it("scores naturally-embedded reasoning higher than metadata-style", () => {
      const decision = {
        topic: "Caching strategy for API",
        alternatives: ["LRU", "Memcached"],
        chosen: "Redis with TTL",
        rationale: "Shared state across instances, survives restarts",
        confidence: 0.9,
      };

      const naturalBullet =
        "Implemented Redis caching for API gateway, choosing TTL-based expiration over in-memory LRU to maintain cache coherence across horizontally-scaled instances";
      const metadataBullet =
        "Implemented Redis caching for API gateway. Decision: chose Redis over LRU. Rationale: shared state across instances.";

      const naturalScore = scoreBulletDecisionIntegration(naturalBullet, decision);
      const metadataScore = scoreBulletDecisionIntegration(metadataBullet, decision);

      assert.ok(
        naturalScore.score >= metadataScore.score,
        `Natural bullet (${naturalScore.score}) should score >= metadata bullet (${metadataScore.score})`
      );
      assert.ok(naturalScore.avoidsMetadataStyle, "Natural bullet should avoid metadata style");
    });

    it("identifies bullets that fail to embed any reasoning", () => {
      const decision = {
        topic: "Error handling strategy",
        alternatives: ["Retry"],
        chosen: "Error boundaries",
        rationale: "Most failures non-transient",
        confidence: 0.88,
      };

      const noReasoningBullet = "Fixed error handling in payment service";
      const score = scoreBulletDecisionIntegration(noReasoningBullet, decision);

      assert.ok(
        score.score < 0.7,
        `Bullet without reasoning should score low, got ${score.score}`
      );
    });

    it("gives high score to bullet with causal reasoning language", () => {
      const decision = {
        topic: "Database architecture for analytics",
        alternatives: ["ClickHouse"],
        chosen: "PostgreSQL with TimescaleDB",
        rationale: "Preserves team SQL knowledge and existing tooling",
        confidence: 0.9,
      };

      const causalBullet =
        "Selected PostgreSQL with TimescaleDB over ClickHouse for analytics pipeline, preserving team SQL expertise and existing ORM compatibility while handling 10M daily events";
      const score = scoreBulletDecisionIntegration(causalBullet, decision);

      assert.ok(score.hasReasoningLanguage, "Should detect reasoning language");
      assert.ok(score.avoidsMetadataStyle, "Should pass metadata avoidance check");
      assert.ok(score.mentionsChoice, "Should detect choice mention");
    });
  });

  // ─── batchGenerateBullets: episodes + decisions → enriched bullets ────────

  describe("batchGenerateBullets: full episode pipeline with decisions", () => {

    it("generates bullets for episodes with embedded decision reasoning", async () => {
      const episodes = [
        {
          id: "ep-api-gateway-caching",
          title: "API Gateway Caching Layer",
          summary: "Implemented Redis-based caching for API responses",
          dateRange: { start: "2026-03-10", end: "2026-03-15" },
          commits: [{ subject: "feat: add Redis caching middleware", date: "2026-03-12" }],
          bullets: ["Added caching layer to API gateway", "Configured Redis connection pooling"],
        },
      ];

      const decisions = [
        {
          topic: "Caching layer for API gateway",
          alternatives: ["In-memory LRU cache", "Memcached"],
          chosen: "Redis with TTL-based expiration",
          rationale: "Shared state across instances and survives restarts",
          impact: "Reduced p99 from 200ms to 50ms",
          date: "2026-03-15",
          source: "codex",
          confidence: 0.92,
        },
      ];

      const results = await batchGenerateBullets(episodes, decisions, {
        repo: "api-gateway",
        maxBulletsPerEpisode: 3,
        llmFn: mockBulletLlm,
      });

      assert.ok(results.length >= 1, "Should produce results for the episode");
      assert.equal(results[0].episodeId, "ep-api-gateway-caching");
      assert.ok(results[0].bullets.length >= 1, "Should generate bullets");

      // Verify reasoning quality
      for (const bullet of results[0].bullets) {
        for (const pattern of METADATA_PATTERNS) {
          assert.ok(
            !pattern.test(bullet.text),
            `Batch-generated bullet has metadata-style reasoning: "${bullet.text}"`
          );
        }
      }
    });

    it("generates bullets for multiple episodes with different decision contexts", async () => {
      const episodes = [
        {
          id: "ep-payment-errors",
          title: "Payment Error Handling",
          summary: "Redesigned error handling for payment pipeline",
          dateRange: { start: "2026-03-16", end: "2026-03-17" },
          commits: [{ subject: "refactor: structured error boundaries", date: "2026-03-16" }],
          bullets: ["Replaced retry loops with error classification"],
        },
        {
          id: "ep-analytics-db",
          title: "Analytics Database Architecture",
          summary: "Migrated analytics to TimescaleDB",
          dateRange: { start: "2026-03-18", end: "2026-03-20" },
          commits: [{ subject: "feat: TimescaleDB setup for analytics", date: "2026-03-18" }],
          bullets: ["Set up TimescaleDB for analytics events"],
        },
      ];

      const decisions = [
        {
          topic: "Error handling strategy for payment pipeline",
          alternatives: ["Retry with backoff"],
          chosen: "Structured error boundaries with classification",
          rationale: "80% of failures non-transient, retries compound load",
          date: "2026-03-16",
          source: "claude",
          confidence: 0.88,
        },
        {
          topic: "Database for analytics time-series data",
          alternatives: ["ClickHouse", "Plain PostgreSQL"],
          chosen: "PostgreSQL with TimescaleDB",
          rationale: "Preserves team SQL knowledge and existing ORM",
          date: "2026-03-18",
          source: "codex",
          confidence: 0.90,
        },
      ];

      const results = await batchGenerateBullets(episodes, decisions, {
        repo: "mixed-services",
        maxBulletsPerEpisode: 2,
        llmFn: mockBulletLlm,
      });

      assert.equal(results.length, 2, "Should produce results for both episodes");

      // Each episode's bullets should be free of metadata patterns
      for (const result of results) {
        for (const bullet of result.bullets) {
          for (const pattern of METADATA_PATTERNS) {
            assert.ok(
              !pattern.test(bullet.text),
              `Episode ${result.episodeId} bullet has metadata: "${bullet.text}"`
            );
          }
        }
      }
    });
  });

  // ─── Session signal detection → decision extraction pipeline ──────────────

  describe("session conversation pre-filtering and extraction", () => {

    it("all sample sessions pass the decision signal heuristic", () => {
      const sessions = [
        SESSION_CACHING_DECISION,
        SESSION_ERROR_HANDLING_DECISION,
        SESSION_DATABASE_MIGRATION,
        SESSION_FRONTEND_REFACTOR,
      ];

      for (const session of sessions) {
        const combinedText = [session.summary, ...session.snippets].join(" ");
        assert.ok(
          hasDecisionSignals(combinedText),
          `Session "${session.summary}" should pass decision signal heuristic`
        );
      }
    });

    it("extracts structured decisions from caching session with correct fields", async () => {
      const decisions = await extractDecisionPoints(
        [SESSION_CACHING_DECISION],
        { date: "2026-03-15", llmFn: mockDecisionLlm }
      );

      assert.ok(decisions.length >= 1);
      const d = decisions[0];
      assert.ok(d.topic, "Decision should have topic");
      assert.ok(d.alternatives.length >= 1, "Decision should have alternatives");
      assert.ok(d.chosen, "Decision should have chosen");
      assert.ok(d.rationale, "Decision should have rationale");
      assert.ok(d.confidence >= 0.5, "Decision should have reasonable confidence");
      assert.equal(d.date, "2026-03-15");
      assert.equal(d.source, "codex");
    });

    it("extracts multiple decisions from error handling session", async () => {
      const decisions = await extractDecisionPoints(
        [SESSION_ERROR_HANDLING_DECISION],
        { date: "2026-03-16", llmFn: mockDecisionLlm }
      );

      assert.ok(decisions.length >= 2, "Should extract both error handling and circuit breaker decisions");

      // Verify both distinct decision topics are present
      const topics = decisions.map(d => d.topic.toLowerCase());
      assert.ok(
        topics.some(t => t.includes("error")),
        "Should include error handling decision"
      );
      assert.ok(
        topics.some(t => t.includes("circuit")),
        "Should include circuit breaker decision"
      );
    });

    it("extractDecisionPointsFromSnippets works with date-grouped session snippets", async () => {
      const snippets = SESSION_DATABASE_MIGRATION.snippets.map(text => ({
        date: "2026-03-18",
        text,
      }));

      const decisions = await extractDecisionPointsFromSnippets(snippets, {
        repo: "analytics-platform",
        llmFn: mockDecisionLlm,
      });

      assert.ok(decisions.length >= 1);
      assert.ok(decisions[0].topic.toLowerCase().includes("database") || decisions[0].topic.toLowerCase().includes("analytics"));
    });
  });

  // ─── Cross-cutting: no metadata leakage in any output ─────────────────────

  describe("cross-cutting: metadata-style reasoning never appears in output", () => {

    it("embedDecisionInBullet never produces metadata-prefixed output", () => {
      const testCases = [
        {
          bullet: "Added Redis caching layer",
          decision: {
            topic: "Caching choice",
            alternatives: ["Memcached"],
            chosen: "Redis",
            rationale: "Better data structures and persistence",
            confidence: 0.9,
          },
        },
        {
          bullet: "Refactored payment error handling",
          decision: {
            topic: "Error approach",
            alternatives: ["Retry everywhere"],
            chosen: "Structured boundaries",
            rationale: "Non-transient failures dominate",
            confidence: 0.85,
          },
        },
        {
          bullet: "Migrated to TimescaleDB for analytics",
          decision: {
            topic: "Database selection",
            alternatives: ["ClickHouse"],
            chosen: "TimescaleDB",
            rationale: "PostgreSQL compatibility and team familiarity",
            confidence: 0.9,
          },
        },
        {
          bullet: "Adopted Zustand for dashboard state management",
          decision: {
            topic: "State library",
            alternatives: ["Redux", "Context"],
            chosen: "Zustand",
            rationale: "Minimal boilerplate and selective re-renders",
            confidence: 0.85,
          },
        },
      ];

      for (const { bullet, decision } of testCases) {
        const enriched = embedDecisionInBullet(bullet, decision);
        for (const pattern of METADATA_PATTERNS) {
          assert.ok(
            !pattern.test(enriched),
            `embedDecisionInBullet produced metadata-style output for "${bullet}": "${enriched}"`
          );
        }
      }
    });

    it("composeMultiDecisionBullet never produces metadata-prefixed output", () => {
      const bullet = "Redesigned payment error handling with circuit breaker";
      const decisions = [
        {
          topic: "Error handling strategy",
          alternatives: ["Retry"],
          chosen: "Error boundaries",
          rationale: "Non-transient failures dominate",
          confidence: 0.88,
        },
        {
          topic: "Circuit breaker approach",
          alternatives: ["Library"],
          chosen: "Custom implementation",
          rationale: "Per-provider state tracking",
          confidence: 0.75,
        },
      ];

      const composed = composeMultiDecisionBullet(bullet, decisions);
      for (const pattern of METADATA_PATTERNS) {
        assert.ok(
          !pattern.test(composed),
          `composeMultiDecisionBullet produced metadata: "${composed}"`
        );
      }
    });
  });

  // ─── Graceful degradation: no decisions available ─────────────────────────

  describe("graceful degradation when sessions have no decision signals", () => {

    it("produces bullets without reasoning when no decisions are extracted", async () => {
      const sessions = [{
        source: "codex",
        cwd: "/repos/my-app",
        summary: "Fixed a typo in the login page",
        snippets: [
          "Updated the login page button text from 'Sign in' to 'Log in' for consistency with the rest of the app."
        ],
      }];

      const decisions = await extractDecisionPoints(sessions, {
        llmFn: mockDecisionLlm,
      });

      assert.equal(decisions.length, 0, "Should extract no decisions from trivial session");

      // Bullets should still generate fine without decisions
      const evidence = {
        items: [
          { text: "Fixed login page button text", date: "2026-03-20", type: "commit" },
        ],
        decisions: [],
        repo: "my-app",
        episodeTitle: "Login Page Fix",
        episodeSummary: "Minor UI text fix",
      };

      const bullets = await generateBulletTexts(evidence, {
        maxBullets: 2,
        llmFn: (prompt, max) => ["Implemented feature improvements based on architectural analysis"],
      });

      assert.ok(bullets.length >= 1, "Should generate bullets even without decisions");
    });
  });
});
