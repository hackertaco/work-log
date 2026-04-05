/**
 * Resume Bullet-Text Generator with Decision Reasoning Integration
 *
 * Generates high-quality resume bullet points that naturally embed extracted
 * decision reasoning from session conversations (Codex/Claude) using
 * contextual language patterns.
 *
 * This module bridges the gap between:
 *   - Raw evidence (commits, work-log bullets, episode summaries)
 *   - Extracted decision reasoning (from resumeDecisionExtractor.mjs)
 *   - Final resume-ready bullet text
 *
 * Rather than relying solely on the LLM to weave reasoning into text (which
 * it sometimes does poorly — appending parentheticals or metadata-style asides),
 * this module provides:
 *
 *   1. CONTEXTUAL LANGUAGE PATTERNS — templates that naturally embed decision
 *      reasoning using phrases like "after profiling showed...", "to eliminate...",
 *      "leveraging X over Y for..."
 *
 *   2. DECISION-BULLET MATCHING — maps extracted decisions to the evidence
 *      items they relate to, so each bullet can reference the right reasoning
 *
 *   3. LLM-ASSISTED GENERATION — sends evidence + matched decisions + patterns
 *      to the LLM for final bullet synthesis, with the contextual patterns
 *      constraining the output format
 *
 *   4. LOCAL POST-PROCESSING — validates and normalizes generated bullets
 *      using resumeVoice.mjs rules + decision-integration quality checks
 *
 * Pipeline position:
 *   resumeDecisionExtractor.mjs → extractDecisionPoints()
 *     → THIS MODULE → generateBulletTexts() / embedDecisionInBullet()
 *       → resumeRecluster.mjs → episode bullets / project bullets
 *       → resumeReconstruction.mjs → final resume bullets
 *
 * Public API:
 *   generateBulletTexts(evidence, options)           → Promise<GeneratedBullet[]>
 *   embedDecisionInBullet(baseBullet, decision)      → string
 *   composeMultiDecisionBullet(baseBullet, decisions) → string
 *   rankDecisionsForBullet(decisions, bulletText)     → RankedDecision[]
 *   matchDecisionsToEvidence(decisions, evidence)     → DecisionEvidenceMatch[]
 *   selectContextualPattern(decision, evidence)       → ContextualPattern
 *   buildBulletGenerationPrompt(evidence, decisions)  → string
 *   scoreBulletDecisionIntegration(bullet, decision)  → IntegrationScore
 *   batchGenerateBullets(episodes, decisions, options) → Promise<EpisodeBullets[]>
 *
 * Exported for testing:
 *   CONTEXTUAL_PATTERNS                               → ContextualPattern[]
 *   _matchTopicToEvidence(decision, evidenceItems)     → number (0-1)
 *   _selectBestPattern(decision)                       → ContextualPattern
 *   _validateDecisionIntegration(bullet, decision)     → boolean
 *
 * @module resumeBulletTextGenerator
 */

import {
  normalizeBullet,
  normalizeBullets,
  VOICE_PROFILE,
  buildDecisionReasoningDirective,
  buildVoiceDirective,
} from "./resumeVoice.mjs";

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/** Maximum bullets to generate per call */
const MAX_BULLETS_PER_CALL = 8;

/** Minimum topic-overlap score to consider a decision relevant to an evidence item */
const DECISION_MATCH_THRESHOLD = 0.25;

/** Maximum character length for a generated bullet */
const MAX_BULLET_CHARS = VOICE_PROFILE.limits.bullet.maxChars;

/** Minimum character length for a generated bullet */
const MIN_BULLET_CHARS = VOICE_PROFILE.limits.bullet.minChars;

// ─── Contextual Language Patterns ─────────────────────────────────────────────

/**
 * Contextual patterns for naturally embedding decision reasoning into bullets.
 *
 * Each pattern has:
 *   - id: stable identifier for the pattern
 *   - category: what type of decision it's best suited for
 *   - template: string template with {action}, {chosen}, {rationale}, {impact} placeholders
 *   - signals: keywords in the decision that suggest this pattern fits
 *   - example: a concrete example of the pattern in use
 *
 * The LLM uses these as structural guidance, not as rigid fill-in-the-blank
 * templates.  The goal is to constrain output toward natural reasoning
 * integration rather than metadata-style reasoning.
 *
 * @type {ContextualPattern[]}
 */
export const CONTEXTUAL_PATTERNS = Object.freeze([
  // ── Trade-off patterns ──────────────────────────────────────────────────────
  {
    id: "tradeoff-over",
    category: "tradeoff",
    template: "{action} over {alternative} {rationale_clause}",
    signals: ["over", "instead of", "rather than", "versus", "vs"],
    example: "Chose event-driven architecture over polling after profiling showed 3x lower CPU usage under sustained load",
  },
  {
    id: "tradeoff-for",
    category: "tradeoff",
    template: "{action}, prioritizing {quality} for {outcome}",
    signals: ["prioritiz", "focus", "emphasis", "prefer"],
    example: "Redesigned authentication flow, prioritizing security over convenience for enterprise compliance requirements",
  },

  // ── Causal reasoning patterns ───────────────────────────────────────────────
  {
    id: "causal-after",
    category: "causal",
    template: "{action} after {discovery} revealed {insight}",
    signals: ["after", "profiling", "analysis", "discovered", "found", "showed", "revealed"],
    example: "Migrated to connection pooling after load testing revealed 40% of latency came from connection establishment",
  },
  {
    id: "causal-to-eliminate",
    category: "causal",
    template: "{action} to eliminate {problem}",
    signals: ["eliminate", "remove", "fix", "resolve", "prevent", "avoid"],
    example: "Centralized policy rules into a single config to eliminate scattered rule conflicts across 5 files",
  },
  {
    id: "causal-reducing",
    category: "causal",
    template: "{action}, reducing {metric} by {amount}",
    signals: ["reduc", "improv", "cut", "lower", "decrease", "sav"],
    example: "Implemented structured caching layer, reducing API response time by 60% for repeated queries",
  },

  // ── Analysis-driven patterns ────────────────────────────────────────────────
  {
    id: "analysis-based-on",
    category: "analysis",
    template: "{action} based on {analysis} showing {finding}",
    signals: ["based on", "analysis", "data", "metrics", "benchmark", "measur"],
    example: "Implemented structured error boundaries rather than retry logic, based on analysis showing 80% of failures were non-transient",
  },
  {
    id: "analysis-leveraging",
    category: "analysis",
    template: "Leveraged {approach} for {benefit}, {supporting_evidence}",
    signals: ["leverag", "harness", "capitaliz", "exploit"],
    example: "Leveraged event sourcing for audit compliance, enabling full replay of state transitions across 12 microservices",
  },

  // ── Strategic choice patterns ───────────────────────────────────────────────
  {
    id: "strategic-adopted",
    category: "strategic",
    template: "Adopted {approach} to {goal}, enabling {outcome}",
    signals: ["adopt", "introduce", "establish", "standardiz", "implement"],
    example: "Adopted trunk-based development to accelerate delivery, enabling same-day deployments for 3 product teams",
  },
  {
    id: "strategic-replaced",
    category: "strategic",
    template: "Replaced {old} with {new} {rationale_clause}",
    signals: ["replac", "migrat", "switch", "transition", "upgrad", "mov"],
    example: "Replaced manual deployment scripts with CI/CD pipeline after repeated production incidents from human error",
  },

  // ── Design decision patterns ────────────────────────────────────────────────
  {
    id: "design-architected",
    category: "design",
    template: "Architected {system} with {approach} for {quality}",
    signals: ["architect", "design", "structur", "model", "schema", "pattern"],
    example: "Architected plugin system with dependency injection for testability, achieving 95% unit test coverage",
  },
  {
    id: "design-decomposed",
    category: "design",
    template: "Decomposed {complex_thing} into {simpler_parts}, {benefit}",
    signals: ["decompos", "split", "break", "modular", "separate", "extract"],
    example: "Decomposed monolithic batch processor into 4 focused microservices, improving fault isolation and independent scaling",
  },

  // ── Composite reasoning patterns (multiple decisions in one bullet) ─────────
  {
    id: "composite-dual-tradeoff",
    category: "composite",
    template: "{action}, choosing {chosen_a} over {alt_a} and {chosen_b} for {unified_rationale}",
    signals: ["both", "combination", "together", "dual", "combined"],
    example: "Redesigned ingestion layer, choosing streaming over batch processing and Protobuf over JSON for 5x throughput with 40% lower payload size",
  },
  {
    id: "composite-cascading",
    category: "composite",
    template: "{action} after {first_insight}, then {second_action} for {outcome}",
    signals: ["then", "subsequently", "which led", "cascad", "chain"],
    example: "Migrated to event sourcing after audit gaps surfaced in REST logs, then added CQRS for independent read scaling",
  },

  // ── Iterative discovery patterns ──────────────────────────────────────────
  {
    id: "iterative-evolved",
    category: "iterative",
    template: "Evolved {system} from {old_approach} to {new_approach} as {discovery} emerged",
    signals: ["evolv", "iterat", "pivot", "adapt", "shift", "adjust", "revis"],
    example: "Evolved caching strategy from TTL-based to event-driven invalidation as usage patterns revealed 70% of evictions were premature",
  },

  // ── Fallback pattern (when no specific match) ───────────────────────────────
  {
    id: "general-action-why",
    category: "general",
    template: "{action} {why_clause}",
    signals: [],
    example: "Built automated regression suite for critical payment flows, catching 3 breaking changes before production",
  },
]);

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ContextualPattern
 * @property {string}   id        Stable pattern identifier
 * @property {string}   category  Pattern category (tradeoff, causal, analysis, strategic, design, general)
 * @property {string}   template  Template with {placeholder} slots
 * @property {string[]} signals   Keywords that suggest this pattern fits
 * @property {string}   example   Concrete example of the pattern in use
 */

/**
 * @typedef {Object} EvidenceItem
 * @property {string}   text       Raw evidence text (commit subject, work-log bullet, etc.)
 * @property {string}   [date]     YYYY-MM-DD date
 * @property {string}   [type]     "commit" | "bullet" | "highlight" | "session"
 */

/**
 * @typedef {Object} DecisionEvidenceMatch
 * @property {object}   decision       The DecisionPoint being matched
 * @property {object[]} evidenceItems  Matched evidence items
 * @property {number}   score          Match confidence (0-1)
 * @property {ContextualPattern} pattern  Best-fit contextual pattern
 */

/**
 * @typedef {Object} GeneratedBullet
 * @property {string}   text           The generated bullet text
 * @property {string[]} sourceEvidence Evidence item texts that grounded this bullet
 * @property {string}   [decisionId]   ID/topic of the decision embedded (if any)
 * @property {string}   patternId      Which contextual pattern was used
 * @property {number}   integrationScore How well decision reasoning is integrated (0-1)
 */

/**
 * @typedef {Object} IntegrationScore
 * @property {number}  score             Overall integration quality (0-1)
 * @property {boolean} hasReasoningLanguage  Contains causal/trade-off language
 * @property {boolean} avoidsMetadataStyle   Doesn't use parenthetical asides
 * @property {boolean} mentionsChoice        References the chosen approach
 * @property {boolean} withinCharLimit       Within MAX_BULLET_CHARS
 * @property {string[]} issues               List of detected issues
 */

/**
 * @typedef {Object} EpisodeBullets
 * @property {string}            episodeId   Episode ID
 * @property {GeneratedBullet[]} bullets     Generated bullets for this episode
 */

// ─── Public API: Decision-Evidence Matching ──────────────────────────────────

/**
 * Match extracted decision points to evidence items based on topic similarity.
 *
 * This creates a mapping from decisions to the evidence they're most relevant
 * to, so bullet generation can pair the right reasoning with the right
 * evidence.
 *
 * @param {object[]} decisions     DecisionPoint[] from resumeDecisionExtractor
 * @param {EvidenceItem[]} evidence  Evidence items (commits, bullets, etc.)
 * @returns {DecisionEvidenceMatch[]}
 */
export function matchDecisionsToEvidence(decisions, evidence) {
  if (!Array.isArray(decisions) || !Array.isArray(evidence)) return [];

  const matches = [];

  for (const decision of decisions) {
    if (!decision || !decision.topic) continue;

    const matched = [];
    for (const item of evidence) {
      if (!item || !item.text) continue;
      const score = _matchTopicToEvidence(decision, item);
      if (score >= DECISION_MATCH_THRESHOLD) {
        matched.push({ item, score });
      }
    }

    // Sort by match score descending
    matched.sort((a, b) => b.score - a.score);

    const pattern = selectContextualPattern(decision);

    matches.push({
      decision,
      evidenceItems: matched.map(m => m.item),
      score: matched.length > 0
        ? matched.reduce((sum, m) => sum + m.score, 0) / matched.length
        : 0,
      pattern,
    });
  }

  return matches;
}

/**
 * Select the best contextual language pattern for a given decision.
 *
 * Examines the decision's topic, rationale, and chosen fields to find
 * the pattern whose signals best match the decision language.
 *
 * @param {object} decision  DecisionPoint from resumeDecisionExtractor
 * @param {EvidenceItem} [evidence]  Optional evidence item for additional context
 * @returns {ContextualPattern}
 */
export function selectContextualPattern(decision, evidence = null) {
  if (!decision) return CONTEXTUAL_PATTERNS[CONTEXTUAL_PATTERNS.length - 1];
  return _selectBestPattern(decision, evidence);
}

// ─── Public API: Bullet Generation ───────────────────────────────────────────

/**
 * Generate resume bullet texts from evidence items with decision reasoning
 * naturally embedded using contextual language patterns.
 *
 * This is the main entry point for bullet generation.  It:
 *   1. Matches decisions to evidence items
 *   2. Selects contextual patterns for each decision
 *   3. Calls the LLM with evidence + decisions + pattern guidance
 *   4. Post-processes and validates the output
 *
 * @param {Object}   evidence
 * @param {EvidenceItem[]} evidence.items        Evidence items to generate bullets from
 * @param {object[]}       [evidence.decisions]  DecisionPoint[] from session analysis
 * @param {string}         [evidence.repo]       Repository name for context
 * @param {string}         [evidence.episodeTitle] Episode title for context
 * @param {string}         [evidence.episodeSummary] Episode summary for context
 * @param {Object}   [options={}]
 * @param {number}   [options.maxBullets=4]      Maximum bullets to generate
 * @param {Function} [options.llmFn]             Override LLM call for testing
 * @returns {Promise<GeneratedBullet[]>}
 */
export async function generateBulletTexts(evidence, options = {}) {
  const {
    items = [],
    decisions = [],
    repo = "",
    episodeTitle = "",
    episodeSummary = "",
  } = evidence || {};

  const maxBullets = Math.min(
    options.maxBullets || 4,
    MAX_BULLETS_PER_CALL
  );

  if (items.length === 0) return [];

  // Step 1: Match decisions to evidence
  const decisionMatches = matchDecisionsToEvidence(decisions, items);

  // Step 2: Build the generation prompt with pattern guidance
  const prompt = buildBulletGenerationPrompt(
    { items, repo, episodeTitle, episodeSummary },
    decisionMatches,
    maxBullets
  );

  // Step 3: Call LLM for generation
  const llmFn = options.llmFn || _callLlmForBullets;
  const rawBullets = await llmFn(prompt, maxBullets);

  // Step 4: Post-process and score
  const generated = [];
  for (const raw of rawBullets) {
    const text = normalizeBullet(typeof raw === "string" ? raw : raw.text || "");
    if (!text || text.length < MIN_BULLET_CHARS) continue;

    // Find the best-matching decision for this bullet
    const bestMatch = _findBestDecisionMatch(text, decisionMatches);

    const integrationScore = bestMatch
      ? scoreBulletDecisionIntegration(text, bestMatch.decision)
      : { score: 0, hasReasoningLanguage: false, avoidsMetadataStyle: true,
          mentionsChoice: false, withinCharLimit: text.length <= MAX_BULLET_CHARS, issues: [] };

    generated.push({
      text,
      sourceEvidence: _extractSourceEvidence(text, items),
      decisionId: bestMatch?.decision?.topic || null,
      patternId: bestMatch?.pattern?.id || "general-action-why",
      integrationScore: integrationScore.score,
    });
  }

  return generated;
}

/**
 * Embed decision reasoning into an existing base bullet using contextual
 * language patterns.  This is a local (non-LLM) operation suitable for
 * quick enrichment of existing bullets.
 *
 * If the bullet already contains reasoning language, it is returned as-is.
 * If the decision doesn't meaningfully relate to the bullet, the original
 * is returned unchanged.
 *
 * @param {string} baseBullet  Existing bullet text (e.g., from an episode)
 * @param {object} decision    DecisionPoint to embed
 * @returns {string}  Enriched bullet text (or original if no enrichment possible)
 */
export function embedDecisionInBullet(baseBullet, decision) {
  if (!baseBullet || typeof baseBullet !== "string") return "";
  if (!decision || !decision.topic || !decision.rationale) return baseBullet;

  const trimmed = baseBullet.trim();

  // Skip if bullet already has reasoning language
  if (_hasReasoningLanguage(trimmed)) return trimmed;

  // Check if the decision is relevant to this bullet
  const relevance = _matchTopicToEvidence(decision, { text: trimmed });
  if (relevance < DECISION_MATCH_THRESHOLD) return trimmed;

  // Select the best pattern for this decision
  const pattern = _selectBestPattern(decision, { text: trimmed });

  // Build the enriched bullet using the pattern as structural guidance
  const enriched = _applyPatternToBullet(trimmed, decision, pattern);

  // Validate length and voice compliance
  const normalized = normalizeBullet(enriched);
  if (!normalized || normalized.length > MAX_BULLET_CHARS) {
    // If enriched version is too long, try a shorter form
    const compact = _compactEnrichedBullet(trimmed, decision, pattern);
    const compactNormalized = normalizeBullet(compact);
    if (compactNormalized && compactNormalized.length <= MAX_BULLET_CHARS) {
      return compactNormalized;
    }
    return trimmed; // Fall back to original if enrichment makes it too long
  }

  return normalized;
}

/**
 * Compose a single bullet from multiple related decisions.
 *
 * When two or more decisions relate to the same evidence cluster, this
 * function weaves them into a single cohesive bullet using composite
 * contextual patterns rather than producing separate bullets.
 *
 * Priority is determined by decision confidence — higher-confidence
 * decisions provide the main clause, lower-confidence ones contribute
 * subordinate clauses.
 *
 * Falls back to the highest-confidence single decision if composition
 * would exceed the character limit.
 *
 * @param {string}   baseBullet   Base bullet text to enrich
 * @param {object[]} decisions    2+ DecisionPoints, sorted by confidence desc
 * @returns {string}  Composed bullet with multi-decision reasoning
 */
export function composeMultiDecisionBullet(baseBullet, decisions) {
  if (!baseBullet || typeof baseBullet !== "string") return "";
  if (!Array.isArray(decisions) || decisions.length === 0) return baseBullet;

  const trimmed = baseBullet.trim();

  // Skip if already has reasoning
  if (_hasReasoningLanguage(trimmed)) return trimmed;

  // Single decision — delegate to embedDecisionInBullet
  if (decisions.length === 1) return embedDecisionInBullet(trimmed, decisions[0]);

  // Sort by confidence descending
  const sorted = [...decisions]
    .filter(d => d && d.topic && d.rationale)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  if (sorted.length === 0) return trimmed;
  if (sorted.length === 1) return embedDecisionInBullet(trimmed, sorted[0]);

  // Primary decision drives the main clause
  const primary = sorted[0];
  const secondary = sorted[1];

  // Check relevance of both
  const primaryRelevance = _matchTopicToEvidence(primary, { text: trimmed });
  const secondaryRelevance = _matchTopicToEvidence(secondary, { text: trimmed });

  if (primaryRelevance < DECISION_MATCH_THRESHOLD) return trimmed;

  // If secondary isn't relevant, just use primary
  if (secondaryRelevance < DECISION_MATCH_THRESHOLD) {
    return embedDecisionInBullet(trimmed, primary);
  }

  // Build composite: "{action}, choosing {primary} and {secondary_rationale}"
  const composed = _composeWithGrammaticalJoin(trimmed, primary, secondary);
  const normalized = normalizeBullet(composed);

  if (!normalized || normalized.length > MAX_BULLET_CHARS) {
    // Fall back to single-decision enrichment with the stronger decision
    return embedDecisionInBullet(trimmed, primary);
  }

  return normalized;
}

/**
 * Rank a list of decisions by their fitness for a specific bullet, using
 * a weighted combination of topic relevance and extraction confidence.
 *
 * Returns a new array sorted by weighted score descending.
 * Useful when multiple decisions compete for the same bullet slot.
 *
 * @param {object[]} decisions     DecisionPoint[]
 * @param {string}   bulletText    The bullet text to rank against
 * @param {object}   [weights]     Optional weight overrides
 * @param {number}   [weights.relevance=0.6]  Weight for topic relevance
 * @param {number}   [weights.confidence=0.4] Weight for extraction confidence
 * @returns {Array<{decision: object, weightedScore: number}>}
 */
export function rankDecisionsForBullet(decisions, bulletText, weights = {}) {
  const wRelevance = weights.relevance ?? 0.6;
  const wConfidence = weights.confidence ?? 0.4;

  if (!Array.isArray(decisions) || !bulletText) return [];

  return decisions
    .filter(d => d && d.topic)
    .map(d => {
      const relevance = _matchTopicToEvidence(d, { text: bulletText });
      const confidence = d.confidence || 0;
      return {
        decision: d,
        weightedScore: relevance * wRelevance + confidence * wConfidence,
      };
    })
    .sort((a, b) => b.weightedScore - a.weightedScore);
}

/**
 * Score how well a bullet integrates decision reasoning.
 *
 * Returns a detailed score object examining whether the bullet naturally
 * embeds reasoning or treats it as metadata/afterthought.
 *
 * @param {string} bullet     The bullet text to score
 * @param {object} decision   The decision that should be embedded
 * @returns {IntegrationScore}
 */
export function scoreBulletDecisionIntegration(bullet, decision) {
  if (!bullet || !decision) {
    return {
      score: 0,
      hasReasoningLanguage: false,
      avoidsMetadataStyle: true,
      mentionsChoice: false,
      withinCharLimit: true,
      issues: ["missing bullet or decision"],
    };
  }

  const issues = [];
  const lower = bullet.toLowerCase();

  // 1. Check for reasoning language (causal connectors, trade-off language)
  const hasReasoningLanguage = _hasReasoningLanguage(bullet);
  if (!hasReasoningLanguage) {
    issues.push("no reasoning language detected");
  }

  // 2. Check it avoids metadata-style reasoning
  const metadataPatterns = [
    /\((?:reason|decision|rationale|because):/i,
    /\.\s*(?:Decision|Reason|Rationale):/i,
    /\s+—\s+(?:reason|decision):/i,
    /\[(?:reason|decision|why)\]/i,
  ];
  const avoidsMetadataStyle = !metadataPatterns.some(p => p.test(bullet));
  if (!avoidsMetadataStyle) {
    issues.push("uses metadata-style reasoning (parenthetical or labeled)");
  }

  // 3. Check if the chosen approach is referenced
  const chosenWords = (decision.chosen || "").toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const mentionsChoice = chosenWords.length === 0 ||
    chosenWords.some(w => lower.includes(w));
  if (!mentionsChoice) {
    issues.push("does not reference the chosen approach");
  }

  // 4. Check character limit
  const withinCharLimit = bullet.length <= MAX_BULLET_CHARS;
  if (!withinCharLimit) {
    issues.push(`exceeds ${MAX_BULLET_CHARS} character limit (${bullet.length})`);
  }

  // Compute composite score
  let score = 0;
  if (hasReasoningLanguage) score += 0.35;
  if (avoidsMetadataStyle) score += 0.25;
  if (mentionsChoice) score += 0.25;
  if (withinCharLimit) score += 0.15;

  return {
    score: Math.round(score * 100) / 100,
    hasReasoningLanguage,
    avoidsMetadataStyle,
    mentionsChoice,
    withinCharLimit,
    issues,
  };
}

/**
 * Build the LLM prompt for bullet generation with pattern guidance.
 *
 * This prompt combines evidence, matched decisions, and contextual patterns
 * into a structured prompt that guides the LLM toward natural reasoning
 * integration.
 *
 * @param {Object}   evidence          Evidence context
 * @param {DecisionEvidenceMatch[]} decisionMatches  Matched decisions
 * @param {number}   maxBullets        Target number of bullets
 * @returns {string}  Complete user message for the LLM
 */
export function buildBulletGenerationPrompt(evidence, decisionMatches, maxBullets = 4) {
  const parts = [];

  // Context
  if (evidence.repo) {
    parts.push(`Repository: ${evidence.repo}`);
  }
  if (evidence.episodeTitle) {
    parts.push(`Episode: ${evidence.episodeTitle}`);
  }
  if (evidence.episodeSummary) {
    parts.push(`Context: ${evidence.episodeSummary}`);
  }
  parts.push("");

  // Evidence items
  parts.push(`=== EVIDENCE (${evidence.items.length} items) ===`);
  for (const item of (evidence.items || []).slice(0, 30)) {
    const prefix = item.type ? `[${item.type}]` : "";
    const datePrefix = item.date ? `[${item.date}]` : "";
    parts.push(`${datePrefix} ${prefix} ${item.text}`.trim());
  }

  // Decision reasoning with pattern guidance
  if (decisionMatches && decisionMatches.length > 0) {
    const significantMatches = decisionMatches.filter(m => m.score > 0 || m.decision.confidence >= 0.6);

    if (significantMatches.length > 0) {
      parts.push("");
      parts.push(`=== DECISION REASONING TO EMBED (${significantMatches.length}) ===`);
      parts.push("Integrate these decisions NATURALLY into bullets using the suggested patterns.");
      parts.push("Do NOT treat reasoning as separate metadata or parenthetical asides.");
      parts.push("");

      for (const match of significantMatches) {
        const d = match.decision;
        parts.push(`DECISION: ${d.topic}`);
        if (d.alternatives && d.alternatives.length > 0) {
          parts.push(`  Alternatives considered: ${d.alternatives.join(" | ")}`);
        }
        parts.push(`  Chosen: ${d.chosen}`);
        parts.push(`  Rationale: ${d.rationale}`);
        if (d.impact) {
          parts.push(`  Impact: ${d.impact}`);
        }

        // Pattern guidance
        const p = match.pattern;
        if (p && p.id !== "general-action-why") {
          parts.push(`  Suggested pattern: "${p.template}"`);
          parts.push(`  Example: "${p.example}"`);
        }
        parts.push("");
      }
    }
  }

  // Generation instruction
  parts.push(`=== TASK ===`);
  parts.push(`Generate exactly ${maxBullets} resume bullet points from the evidence above.`);
  parts.push("Each bullet must:");
  parts.push("  1. Start with a strong past-tense action verb");
  parts.push("  2. Be 30-140 characters");
  parts.push("  3. Embed decision reasoning NATURALLY into the sentence flow");
  parts.push("  4. Never use parenthetical asides like '(Reason: ...)' or labels like 'Decision:'");
  parts.push("  5. Show engineering judgment, not just engineering output");
  parts.push("When no decision reasoning is available, write clear achievement bullets without fabricating reasoning.");

  return parts.join("\n");
}

/**
 * Batch-generate bullets for multiple episodes, reusing the same LLM
 * context for efficiency.
 *
 * @param {object[]} episodes     EvidenceEpisode[] with bullets, commitSubjects, etc.
 * @param {object[]} decisions    DecisionPoint[] from session analysis
 * @param {Object}   [options={}]
 * @param {string}   [options.repo]        Repository name
 * @param {number}   [options.maxBulletsPerEpisode=3]  Target bullets per episode
 * @param {Function} [options.llmFn]       Override LLM call for testing
 * @returns {Promise<EpisodeBullets[]>}
 */
export async function batchGenerateBullets(episodes, decisions, options = {}) {
  if (!Array.isArray(episodes) || episodes.length === 0) return [];

  const repo = options.repo || "";
  const maxPerEpisode = options.maxBulletsPerEpisode || 3;
  const results = [];

  for (const episode of episodes) {
    if (!episode) continue;

    // Build evidence items from the episode
    const items = _episodeToEvidenceItems(episode);

    // Filter decisions relevant to this episode (by date overlap + topic)
    const relevantDecisions = _filterDecisionsForEpisode(decisions, episode);

    const bullets = await generateBulletTexts(
      {
        items,
        decisions: relevantDecisions,
        repo,
        episodeTitle: episode.title || "",
        episodeSummary: episode.summary || "",
      },
      {
        maxBullets: maxPerEpisode,
        llmFn: options.llmFn,
      }
    );

    results.push({
      episodeId: episode.id || `ep-${repo}-unknown`,
      bullets,
    });
  }

  return results;
}

// ─── Internal: Topic matching ───────────────────────────────────────────────

/**
 * Compute relevance score between a decision and an evidence item.
 *
 * Uses a combination of:
 *   - Word overlap between decision topic/chosen/rationale and evidence text
 *   - Technology/concept keyword matching
 *   - Date proximity (if both have dates)
 *
 * @param {object}       decision  DecisionPoint
 * @param {EvidenceItem} evidence  Evidence item
 * @returns {number}  Relevance score (0-1)
 */
export function _matchTopicToEvidence(decision, evidence) {
  if (!decision || !evidence || !evidence.text) return 0;

  const decisionText = [
    decision.topic || "",
    decision.chosen || "",
    decision.rationale || "",
    ...(decision.alternatives || []),
  ].join(" ").toLowerCase();

  const evidenceText = evidence.text.toLowerCase();

  // Extract meaningful words (3+ chars, no stop words)
  const decisionWords = _extractMeaningfulWords(decisionText);
  const evidenceWords = _extractMeaningfulWords(evidenceText);

  if (decisionWords.size === 0 || evidenceWords.size === 0) return 0;

  // Compute overlap
  let overlap = 0;
  for (const w of decisionWords) {
    if (evidenceWords.has(w)) overlap++;
  }

  // Jaccard-like but weighted toward decision coverage
  // (we care more about "does the evidence relate to this decision"
  //  than "does the decision cover all the evidence")
  const decisionCoverage = decisionWords.size > 0 ? overlap / decisionWords.size : 0;
  const bidirectional = (decisionWords.size + evidenceWords.size) > 0
    ? (2 * overlap) / (decisionWords.size + evidenceWords.size)
    : 0;

  // Weight decision coverage more heavily (0.6) vs bidirectional (0.4)
  return Math.min(1, decisionCoverage * 0.6 + bidirectional * 0.4);
}

// ─── Internal: Pattern selection ─────────────────────────────────────────────

/**
 * Select the best contextual pattern for a decision, optionally considering
 * evidence context.
 *
 * @param {object}       decision   DecisionPoint
 * @param {EvidenceItem} [evidence] Optional evidence for additional context
 * @returns {ContextualPattern}
 */
export function _selectBestPattern(decision, evidence = null) {
  if (!decision) return CONTEXTUAL_PATTERNS[CONTEXTUAL_PATTERNS.length - 1];

  const searchText = [
    decision.topic || "",
    decision.rationale || "",
    decision.chosen || "",
    decision.impact || "",
    ...(decision.alternatives || []),
    evidence?.text || "",
  ].join(" ").toLowerCase();

  let bestPattern = null;
  let bestScore = 0;

  for (const pattern of CONTEXTUAL_PATTERNS) {
    if (pattern.signals.length === 0) continue; // Skip fallback

    let score = 0;
    for (const signal of pattern.signals) {
      if (searchText.includes(signal.toLowerCase())) {
        score += 1;
      }
    }

    // Normalize by number of signals (patterns with fewer signals
    // need fewer matches to score highly)
    const normalizedScore = pattern.signals.length > 0
      ? score / Math.sqrt(pattern.signals.length)
      : 0;

    if (normalizedScore > bestScore) {
      bestScore = normalizedScore;
      bestPattern = pattern;
    }
  }

  // Fall back to general pattern if no good match
  return bestPattern || CONTEXTUAL_PATTERNS[CONTEXTUAL_PATTERNS.length - 1];
}

// ─── Internal: Reasoning language detection ─────────────────────────────────

/**
 * Check whether text contains natural reasoning language (causal connectors,
 * trade-off phrases, analysis references).
 *
 * @param {string} text
 * @returns {boolean}
 */
function _hasReasoningLanguage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  const reasoningMarkers = [
    // Causal connectors
    /\bafter\s+(?:profiling|testing|analysis|benchmarking|discovering|observing|measuring)/i,
    /\bbased on\b/i,
    /\bto (?:eliminate|prevent|reduce|improve|ensure|enable|support|achieve)\b/i,
    /\b(?:reducing|improving|enabling|achieving|preventing|eliminating)\b/i,

    // Trade-off language
    /\bover\s+\w+/i,  // "X over Y"
    /\binstead of\b/i,
    /\brather than\b/i,
    /\bprioritizing\b/i,

    // Result/impact language
    /\b(?:resulting in|leading to|cutting|saving|accelerating)\b/i,
    /\bfor\s+(?:better|improved|faster|reliable|scalable|maintainable)\b/i,

    // Analysis language
    /\bafter\s+\w+\s+(?:showed|revealed|indicated|demonstrated)\b/i,
    /\bwhen\s+\w+\s+(?:showed|revealed|found|exposed)\b/i,

    // Korean reasoning markers
    /(?:위해|이후|기반으로|대신|통해|결과)/,
  ];

  return reasoningMarkers.some(pattern => pattern.test(text));
}

/**
 * Check whether text uses metadata-style reasoning that should be avoided.
 *
 * @param {string} text
 * @returns {boolean}
 */
function _hasMetadataStyleReasoning(text) {
  if (!text) return false;

  const metadataPatterns = [
    /\((?:reason|decision|rationale|because|why|note):/i,
    /\.\s*(?:Decision|Reason|Rationale|Why):\s/,
    /\s+[-—]\s+(?:reason|decision|rationale):/i,
    /\[(?:reason|decision|why|note)\]/i,
    /;\s*(?:decision|reason):\s/i,
  ];

  return metadataPatterns.some(p => p.test(text));
}

// ─── Internal: Bullet enrichment (local, no LLM) ───────────────────────────

/**
 * Apply a contextual pattern to enrich a bullet with decision reasoning.
 * This is a heuristic local operation — not LLM-based.
 *
 * @param {string}            bullet    Base bullet text
 * @param {object}            decision  DecisionPoint
 * @param {ContextualPattern} pattern   Selected pattern
 * @returns {string}  Enriched bullet text
 */
function _applyPatternToBullet(bullet, decision, pattern) {
  const trimmed = bullet.trim().replace(/\.$/, "");

  switch (pattern.category) {
    case "tradeoff": {
      // Append trade-off clause
      const alt = decision.alternatives?.[0];
      if (alt) {
        return `${trimmed} over ${alt.toLowerCase()} for ${_extractCoreRationale(decision)}`;
      }
      return `${trimmed}, ${_extractCoreRationale(decision)}`;
    }

    case "causal": {
      // Append causal clause
      const rationale = _extractCoreRationale(decision);
      if (pattern.id === "causal-to-eliminate") {
        return `${trimmed} to ${rationale}`;
      }
      if (pattern.id === "causal-reducing") {
        const impact = decision.impact || rationale;
        return `${trimmed}, ${impact.toLowerCase().startsWith("reduc") ? impact.toLowerCase() : `reducing ${impact.toLowerCase()}`}`;
      }
      return `${trimmed} after ${rationale}`;
    }

    case "analysis": {
      const rationale = _extractCoreRationale(decision);
      return `${trimmed}, based on ${rationale}`;
    }

    case "strategic": {
      const rationale = _extractCoreRationale(decision);
      if (pattern.id === "strategic-replaced" && decision.alternatives?.[0]) {
        return `Replaced ${decision.alternatives[0].toLowerCase()} with ${decision.chosen.toLowerCase()}, ${rationale}`;
      }
      return `${trimmed}, enabling ${rationale}`;
    }

    case "design": {
      const rationale = _extractCoreRationale(decision);
      return `${trimmed} for ${rationale}`;
    }

    case "composite": {
      // For composite patterns, just use the primary rationale
      // (full composition is handled by composeMultiDecisionBullet)
      const rationale = _extractCoreRationale(decision);
      const alt = decision.alternatives?.[0];
      if (alt) {
        return `${trimmed}, choosing ${decision.chosen.toLowerCase()} over ${alt.toLowerCase()} for ${rationale}`;
      }
      return `${trimmed}, ${rationale}`;
    }

    case "iterative": {
      const rationale = _extractCoreRationale(decision);
      const alt = decision.alternatives?.[0];
      if (alt) {
        return `Evolved ${trimmed.charAt(0).toLowerCase() + trimmed.slice(1)} from ${alt.toLowerCase()} as ${rationale}`;
      }
      return `${trimmed} as ${rationale}`;
    }

    default: {
      const rationale = _extractCoreRationale(decision);
      return `${trimmed}, ${rationale}`;
    }
  }
}

/**
 * Compose a bullet from a base action with two decisions using grammatical
 * connectors that read naturally as a single sentence.
 *
 * @param {string} bullet     Base bullet text
 * @param {object} primary    Primary (higher confidence) decision
 * @param {object} secondary  Secondary decision
 * @returns {string}
 */
function _composeWithGrammaticalJoin(bullet, primary, secondary) {
  const trimmed = bullet.trim().replace(/\.$/, "");
  const primaryRationale = _extractCoreRationale(primary);
  const secondaryRationale = _extractCoreRationale(secondary);

  const primaryAlt = primary.alternatives?.[0];
  const secondaryAlt = secondary.alternatives?.[0];

  // Strategy 1: Both have alternatives → dual trade-off
  if (primaryAlt && secondaryAlt) {
    return `${trimmed}, choosing ${primary.chosen.toLowerCase()} over ${primaryAlt.toLowerCase()} and ${secondary.chosen.toLowerCase()} over ${secondaryAlt.toLowerCase()} for ${primaryRationale}`;
  }

  // Strategy 2: Primary has alternative → trade-off + supporting rationale
  if (primaryAlt) {
    return `${trimmed} over ${primaryAlt.toLowerCase()}, ${secondaryRationale}`;
  }

  // Strategy 3: Cascade — primary reason led to secondary insight
  if (secondary.impact) {
    return `${trimmed}, ${primaryRationale}, ${secondary.impact.charAt(0).toLowerCase() + secondary.impact.slice(1).replace(/\.$/, "")}`;
  }

  // Strategy 4: Simple conjunction — primary rationale while also addressing secondary
  return `${trimmed}, ${primaryRationale} while also ${secondaryRationale}`;
}

/**
 * Create a compact enriched bullet when the full enrichment is too long.
 */
function _compactEnrichedBullet(bullet, decision, _pattern) {
  const trimmed = bullet.trim().replace(/\.$/, "");
  const shortRationale = _extractCoreRationale(decision);

  // Try the shortest useful enrichment
  const compact = `${trimmed}, ${shortRationale}`;
  if (compact.length <= MAX_BULLET_CHARS) return compact;

  // If still too long, just return original
  return trimmed;
}

/**
 * Extract a short core rationale phrase from a decision.
 *
 * Simplifies the full rationale into a concise clause suitable for
 * appending to a bullet.
 *
 * @param {object} decision
 * @returns {string}  Short rationale phrase (no leading capital, no trailing period)
 */
function _extractCoreRationale(decision) {
  let rationale = decision.rationale || "";

  // If rationale is a full sentence, try to extract the core clause
  if (rationale.length > 60) {
    // Take the first clause before a comma, semicolon, or dash
    const clauseMatch = rationale.match(/^([^,;—]+)/);
    if (clauseMatch) {
      rationale = clauseMatch[1].trim();
    } else {
      rationale = rationale.slice(0, 60).trim();
    }
  }

  // Lowercase the first character for use in mid-sentence
  rationale = rationale.charAt(0).toLowerCase() + rationale.slice(1);

  // Remove trailing period
  rationale = rationale.replace(/\.$/, "").trim();

  return rationale;
}

// ─── Internal: LLM call ─────────────────────────────────────────────────────

const BULLET_GENERATION_SYSTEM_PROMPT = `\
You are an expert resume writer generating achievement-oriented resume bullets.

Your bullets MUST:
1. Start with a strong past-tense action verb (Designed, Built, Implemented, etc.)
2. Be 30-140 characters (strict limit)
3. Show engineering JUDGMENT — embed WHY decisions were made, not just WHAT was done
4. Use natural sentence flow — never metadata-style reasoning

${buildDecisionReasoningDirective()}

${buildVoiceDirective("bullet")}

CRITICAL RULES:
- Each bullet is a SINGLE sentence, no semicolons joining two sentences
- No first-person pronouns (I, We, My, Our)
- No filler words (various, utilized, leveraged without object)
- Quantify impact when evidence supports it (%, time saved, count)
- When decision reasoning is provided with pattern suggestions, USE the pattern
  structure as a guide for how to embed the reasoning naturally
- When no decision reasoning is available, write clear achievement bullets
  without fabricating any reasoning`;

const BULLET_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bullets"],
  properties: {
    bullets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string" },
        },
      },
    },
  },
};

/**
 * Call the LLM to generate bullet texts.
 *
 * @param {string} userMessage  The assembled prompt
 * @param {number} maxBullets   Target bullet count
 * @returns {Promise<object[]>} Raw bullet objects from LLM
 */
async function _callLlmForBullets(userMessage, maxBullets) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") return [];

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "medium" },
    text: {
      format: {
        type: "json_schema",
        name: "bullet_generation",
        strict: true,
        schema: BULLET_OUTPUT_SCHEMA,
      },
    },
    max_output_tokens: 1500,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: BULLET_GENERATION_SYSTEM_PROMPT }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }],
      },
    ],
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[bulletTextGenerator] LLM call failed: ${response.status} ${errorText.slice(0, 200)}`);
    return [];
  }

  const data = await response.json();
  const rawText = data.output_text || _extractOutputText(data);
  if (!rawText) return [];

  try {
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed.bullets) ? parsed.bullets : [];
  } catch (err) {
    console.error(`[bulletTextGenerator] Failed to parse LLM output: ${err.message}`);
    return [];
  }
}

function _extractOutputText(data) {
  const outputs = data.output ?? [];
  const texts = [];
  for (const item of outputs) {
    for (const part of item?.content ?? []) {
      if (part?.type === "output_text" && part?.text) texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
}

// ─── Internal: Helper utilities ─────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "has", "had", "have", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "this", "that", "these", "those",
  "it", "its", "not", "no", "all", "each", "every", "both", "few",
  "more", "most", "some", "any", "other", "than", "then", "also",
  "just", "about", "into", "over", "after", "before", "between",
]);

/**
 * Extract meaningful words from text (3+ chars, no stop words).
 * @param {string} text
 * @returns {Set<string>}
 */
function _extractMeaningfulWords(text) {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,;:.!?()\[\]{}'"]+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

/**
 * Find the best-matching decision for a generated bullet.
 * @param {string} bulletText
 * @param {DecisionEvidenceMatch[]} matches
 * @returns {DecisionEvidenceMatch|null}
 */
function _findBestDecisionMatch(bulletText, matches) {
  if (!matches || matches.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const match of matches) {
    const score = _matchTopicToEvidence(match.decision, { text: bulletText });
    if (score > bestScore) {
      bestScore = score;
      best = match;
    }
  }

  return bestScore >= DECISION_MATCH_THRESHOLD ? best : null;
}

/**
 * Extract source evidence texts that are most relevant to a generated bullet.
 * @param {string} bulletText
 * @param {EvidenceItem[]} items
 * @returns {string[]}
 */
function _extractSourceEvidence(bulletText, items) {
  if (!items || items.length === 0) return [];

  const bulletWords = _extractMeaningfulWords(bulletText);
  const scored = items.map(item => {
    const itemWords = _extractMeaningfulWords(item.text);
    let overlap = 0;
    for (const w of bulletWords) {
      if (itemWords.has(w)) overlap++;
    }
    const score = bulletWords.size > 0 ? overlap / bulletWords.size : 0;
    return { text: item.text, score };
  });

  return scored
    .filter(s => s.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.text);
}

/**
 * Convert an episode object to evidence items.
 * @param {object} episode  EvidenceEpisode
 * @returns {EvidenceItem[]}
 */
function _episodeToEvidenceItems(episode) {
  const items = [];

  // Commit subjects as evidence
  if (Array.isArray(episode.commitSubjects)) {
    for (const subject of episode.commitSubjects) {
      items.push({ text: subject, type: "commit" });
    }
  }

  // Existing bullets as evidence
  if (Array.isArray(episode.bullets)) {
    for (const bullet of episode.bullets) {
      items.push({ text: bullet, type: "bullet" });
    }
  }

  // Episode summary as evidence
  if (episode.summary) {
    items.push({ text: episode.summary, type: "highlight" });
  }

  // Decision reasoning text as evidence (if stored on the episode)
  if (episode.decisionReasoning) {
    items.push({ text: episode.decisionReasoning, type: "session" });
  }

  return items;
}

/**
 * Filter decisions that are relevant to a specific episode.
 *
 * Uses date overlap and topic similarity.
 *
 * @param {object[]} allDecisions   All DecisionPoint[]
 * @param {object}   episode        EvidenceEpisode
 * @returns {object[]}  Filtered decisions
 */
function _filterDecisionsForEpisode(allDecisions, episode) {
  if (!Array.isArray(allDecisions) || allDecisions.length === 0) return [];
  if (!episode) return [];

  const episodeDates = new Set(Array.isArray(episode.dates) ? episode.dates : []);
  const episodeText = [
    episode.title || "",
    episode.summary || "",
    ...(episode.bullets || []),
    ...(episode.commitSubjects || []),
  ].join(" ");

  return allDecisions.filter(d => {
    // Date overlap check
    const dateMatch = d.date && episodeDates.has(d.date);

    // Topic relevance check
    const topicScore = _matchTopicToEvidence(d, { text: episodeText });

    // Include if date matches OR topic is highly relevant
    return dateMatch || topicScore >= 0.3;
  });
}

/**
 * Validate that a bullet has well-integrated decision reasoning
 * (not metadata-style).
 *
 * @param {string} bullet     Generated bullet text
 * @param {object} decision   DecisionPoint that was supposed to be embedded
 * @returns {boolean}
 */
export function _validateDecisionIntegration(bullet, decision) {
  if (!bullet || !decision) return false;

  // Must have reasoning language
  if (!_hasReasoningLanguage(bullet)) return false;

  // Must NOT have metadata-style reasoning
  if (_hasMetadataStyleReasoning(bullet)) return false;

  // Must be within character limits
  if (bullet.length > MAX_BULLET_CHARS || bullet.length < MIN_BULLET_CHARS) return false;

  return true;
}
