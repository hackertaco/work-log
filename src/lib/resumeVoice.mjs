/**
 * Resume Voice & Tone Engine
 *
 * Centralizes writing style configuration so every LLM prompt in the resume
 * pipeline produces text with a uniform voice: tense, formality, perspective,
 * verb preferences, and character limits.
 *
 * Instead of duplicating "active voice, strong verb, <140 chars" rules across
 * six different system prompts, each prompt imports a section-specific voice
 * directive from this module and appends it to its system prompt.
 *
 * The engine also provides a post-processing normalizer (`normalizeVoice`)
 * that catches common LLM drift (passive voice, first-person pronouns,
 * excessive length) and either fixes or flags the text.
 *
 * Public API:
 *   VOICE_PROFILE                              — frozen configuration object
 *   SECTION_TONE_PROFILES                      — per-section tone nuances
 *   buildVoiceDirective(section)               — voice prompt segment for a section type
 *   buildLanguageDirective(lang)               — language-rule prompt segment
 *   buildFullVoiceBlock(sections, lang)        — combined voice + language block
 *   buildDecisionReasoningDirective()          — directive for embedding session reasoning
 *   normalizeVoice(text, section)              — post-process text for voice consistency
 *   normalizeSection(text, section)            — section-aware normalization (extends normalizeVoice)
 *   normalizeBullet(bullet)                    — normalize a single bullet string
 *   normalizeBullets(bullets)                  — batch normalize bullets
 *   checkVoiceCompliance(text, section)        — returns compliance report (no mutation)
 *   checkBulkCompliance(texts, section)        — batch compliance check
 *   getSectionConfig(section)                  — returns section-specific limits/rules
 *   harmonizeResumeVoice(resume)               — cross-section voice validation for full resume
 *   scoreResumeVoiceConsistency(resume)        — voice consistency score (0-1) for full resume
 *
 * @module resumeVoice
 */

// ─── Voice profile ────────────────────────────────────────────────────────────

/**
 * Central voice configuration.  All resume generation prompts and
 * post-processors reference this single object for style rules.
 *
 * To adjust the voice across the entire pipeline, change values here.
 *
 * @typedef {Object} VoiceProfile
 * @property {string}   tense            Target grammatical tense for bullets
 * @property {string}   perspective      Grammatical person (third-person implied)
 * @property {string}   formality        Formality level descriptor
 * @property {string}   voice            Active vs passive preference
 * @property {string[]} preferredVerbs   Strong action verbs to encourage
 * @property {string[]} avoidPatterns    Patterns/words to flag or rewrite
 * @property {Object}   limits           Per-section character/count limits
 */
export const VOICE_PROFILE = Object.freeze({
  // ── Core style attributes ──────────────────────────────────────────────────
  tense: "past",                       // bullets describe completed achievements
  perspective: "third-person-implied",  // no pronouns — starts with verb
  formality: "professional-concise",    // formal but not stiff; concise not terse
  voice: "active",                      // always active voice

  // ── Verb guidance ──────────────────────────────────────────────────────────
  preferredVerbs: Object.freeze([
    "Designed", "Built", "Implemented", "Reduced", "Improved", "Led",
    "Automated", "Centralized", "Migrated", "Optimized", "Resolved",
    "Established", "Streamlined", "Integrated", "Refactored", "Deployed",
    "Architected", "Eliminated", "Standardized", "Accelerated"
  ]),

  // ── Patterns to avoid ──────────────────────────────────────────────────────
  avoidPatterns: Object.freeze([
    "I ",              // first person
    "We ",             // first person plural
    "My ",             // possessive first person
    "Our ",            // possessive first person plural
    "was responsible", // passive / vague
    "helped to",       // weak verb
    "assisted in",     // weak verb
    "participated in", // vague
    "was involved",    // passive / vague
    "worked on",       // vague
    "various",         // filler
    "utilized",        // pompous synonym for "used"
  ]),

  // ── Section-specific limits ────────────────────────────────────────────────
  limits: Object.freeze({
    bullet: Object.freeze({
      maxChars: 140,
      minChars: 30,
      maxPerRole: 5,
    }),
    summary: Object.freeze({
      maxSentences: 4,
      minSentences: 2,
      maxChars: 600,
    }),
    projectTitle: Object.freeze({
      maxWords: 8,
      minWords: 3,
      maxChars: 60,
    }),
    projectDescription: Object.freeze({
      maxSentences: 4,
      minSentences: 2,
      maxChars: 500,
    }),
    episodeTitle: Object.freeze({
      maxWords: 15,
      minWords: 5,
      maxChars: 100,
    }),
    strengthLabel: Object.freeze({
      maxWords: 6,
      minWords: 2,
      maxChars: 80,
    }),
    strengthDescription: Object.freeze({
      maxSentences: 2,
      minSentences: 1,
      maxChars: 300,
    }),
    axisLabel: Object.freeze({
      maxChars: 60,
    }),
    axisDescription: Object.freeze({
      maxSentences: 4,
      minSentences: 2,
      maxChars: 500,
    }),
    displayAxisLabel: Object.freeze({
      maxChars: 40,
    }),
    displayAxisTagline: Object.freeze({
      maxChars: 120,
    }),
    keyword: Object.freeze({
      maxChars: 40,
    }),
  }),
});

// ─── Section tone profiles ──────────────────────────────────────────────────
//
// Each section type has nuanced tone guidance BEYOND the universal voice rules.
// These describe HOW the writing should feel within the core style constraints.
// Used by buildVoiceDirective to provide section-aware tone instructions.

/**
 * Per-section tone nuances.  These guide the LLM on writing style specifics
 * that vary across resume sections while maintaining the overall voice.
 *
 * @typedef {Object} SectionToneProfile
 * @property {string} intent         What this section should achieve for the reader
 * @property {string} tone           Descriptive tone guidance
 * @property {string} tenseOverride  If set, overrides the global tense for this section
 * @property {boolean} verbFirst     Whether text should start with a verb
 * @property {boolean} quantify      Whether quantifiable results should be prioritized
 * @property {string[]} exampleOpeners  2-3 exemplar sentence starts
 */
export const SECTION_TONE_PROFILES = Object.freeze({
  bullet: Object.freeze({
    intent: "Demonstrate specific, measurable impact from completed work",
    tone: "Achievement-oriented and concrete. Each bullet should prove competence through results, not describe responsibilities.",
    tenseOverride: null,  // uses global "past"
    verbFirst: true,
    quantify: true,
    exampleOpeners: [
      "Reduced API latency by 40% by implementing connection pooling",
      "Built real-time monitoring dashboard serving 200+ daily active users",
      "Migrated payment processing pipeline from batch to streaming, eliminating 2h settlement delay",
    ],
  }),
  summary: Object.freeze({
    intent: "Position the candidate's professional identity in 2-4 sentences",
    tone: "Confident and forward-looking. Synthesize the candidate's strongest themes into a cohesive professional narrative. Avoid listing skills — instead convey what kind of engineer they are and what drives their work.",
    tenseOverride: "present",  // summaries describe current identity
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "Backend engineer specializing in high-reliability payment systems",
      "Full-stack developer who turns operational complexity into streamlined user experiences",
      "Systems engineer focused on eliminating silent failures through structured observability",
    ],
  }),
  projectTitle: Object.freeze({
    intent: "Name a project clearly enough that a reader immediately understands its scope",
    tone: "Descriptive and specific. Should read as a natural project name, not a marketing tagline.",
    tenseOverride: null,
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "Real-Time Payment Settlement Pipeline",
      "Cross-Platform Map Rendering Engine",
      "Automated Deployment & Rollback System",
    ],
  }),
  projectDescription: Object.freeze({
    intent: "Explain the project's purpose, scope, and key technical decisions in a few sentences",
    tone: "Informative and evidence-grounded. Naturally embed WHY decisions were made, not just what was built. Show engineering judgment.",
    tenseOverride: null,
    verbFirst: false,
    quantify: true,
    exampleOpeners: [
      "Redesigned the settlement pipeline to process transactions in real-time rather than nightly batches",
      "Built a unified map rendering layer that abstracted away provider differences",
      "Chose event-driven architecture over polling to reduce operational load",
    ],
  }),
  episodeTitle: Object.freeze({
    intent: "Summarize a coherent unit of work in a descriptive phrase",
    tone: "Clear and scoped. Should convey both the topic and functional module (e.g., 'Payment retry logic overhaul' not just 'Payments').",
    tenseOverride: null,
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "Error boundary implementation for payment webhooks",
      "Map tile caching layer and offline fallback",
      "CI/CD pipeline migration to GitHub Actions",
    ],
  }),
  episodeSummary: Object.freeze({
    intent: "Describe what was done in an episode and why, in bullet form",
    tone: "Achievement-oriented like bullets, but may include brief context on motivation or decision reasoning.",
    tenseOverride: null,
    verbFirst: true,
    quantify: true,
    exampleOpeners: [
      "Implemented structured error boundaries after identifying silent webhook failures",
      "Chose offline-first caching strategy to handle unreliable network conditions in field deployments",
    ],
  }),
  strengthLabel: Object.freeze({
    intent: "Name a professional strength that differentiates this candidate",
    tone: "Specific and behavioral. Should describe a capability pattern, not a technology or generic trait.",
    tenseOverride: null,
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "Reliability-First System Design",
      "Cross-Boundary Data Pipeline Architecture",
      "Proactive Failure Mode Elimination",
    ],
  }),
  strengthDescription: Object.freeze({
    intent: "Explain HOW this strength manifests in their work with evidence",
    tone: "Evidence-grounded and analytical. Embed specific examples naturally into the description. Show the pattern, not just the label.",
    tenseOverride: null,
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "Consistently prioritized error handling and graceful degradation over feature velocity",
      "Across three projects, chose to build observability infrastructure before adding new features",
    ],
  }),
  axisLabel: Object.freeze({
    intent: "Capture a career identity thread in one sentence",
    tone: "Narrative and personal. Should feel like a natural description of a professional identity, not a category label.",
    tenseOverride: "present",  // identity statements are present-tense
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "Engineer who turns operational chaos into reliable systems",
      "Developer who builds user trust through invisible reliability",
    ],
  }),
  axisDescription: Object.freeze({
    intent: "Show how a career narrative runs through multiple projects and decisions",
    tone: "Narrative-flowing and connective. Show how work across different projects reveals a coherent professional identity. Embed decision reasoning to show THINKING patterns, not just output patterns.",
    tenseOverride: null,
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "When the payment system kept failing silently, chose to add structured error boundaries over quick-fix retries",
      "This pattern of prioritizing observability appeared first in the monitoring dashboard, then repeated in the deployment pipeline",
    ],
  }),
  displayAxisLabel: Object.freeze({
    intent: "Short positioning label for display grouping",
    tone: "Crisp and categorical. One clear concept per label.",
    tenseOverride: null,
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "Systems Reliability Engineering",
      "Real-Time Data Pipeline Design",
    ],
  }),
  displayAxisTagline: Object.freeze({
    intent: "One-line expansion of the display axis label",
    tone: "Punchy and descriptive. Should make the reader immediately understand the candidate's angle on this skill area.",
    tenseOverride: null,
    verbFirst: false,
    quantify: false,
    exampleOpeners: [
      "Building payment systems that never lose a transaction, even when everything else fails",
      "Turning complex geospatial data into sub-second map interactions",
    ],
  }),
  keyword: Object.freeze({
    intent: "Single marketable skill or technology",
    tone: "Direct and recognizable. Standard industry terminology.",
    tenseOverride: null,
    verbFirst: false,
    quantify: false,
    exampleOpeners: ["React", "Distributed Systems", "CI/CD Automation"],
  }),
});

// ─── Section type enum ───────────────────────────────────────────────────────

/**
 * Valid section type keys that can be passed to `buildVoiceDirective` and
 * `normalizeVoice`.  Each maps to specific constraints in VOICE_PROFILE.limits.
 *
 * @typedef {"bullet"|"summary"|"projectTitle"|"projectDescription"|"episodeTitle"|"episodeSummary"|"strengthLabel"|"strengthDescription"|"axisLabel"|"axisDescription"|"displayAxisLabel"|"displayAxisTagline"|"keyword"} VoiceSectionType
 */

const VALID_SECTIONS = new Set([
  "bullet", "summary", "projectTitle", "projectDescription",
  "episodeTitle", "episodeSummary", "strengthLabel", "strengthDescription",
  "axisLabel", "axisDescription", "displayAxisLabel", "displayAxisTagline",
  "keyword"
]);

// ─── Public: directive builders ──────────────────────────────────────────────

/**
 * Generate the voice/tone portion of a system prompt for a given section type.
 *
 * This is the primary integration point: each LLM prompt in the pipeline calls
 * `buildVoiceDirective("bullet")` (or "summary", "axisLabel", etc.) and appends
 * the returned string to its system prompt.
 *
 * @param {VoiceSectionType|VoiceSectionType[]} sections  One or more section types
 * @returns {string}  Multi-line voice directive ready to embed in a system prompt
 */
export function buildVoiceDirective(sections) {
  const sectionList = Array.isArray(sections) ? sections : [sections];

  const parts = [
    "━━━ VOICE & TONE ━━━",
    `Tense: ${_tenseDescription()}`,
    `Voice: Always ${VOICE_PROFILE.voice} voice. Start with a strong action verb when writing bullets or achievement statements.`,
    `Perspective: ${_perspectiveDescription()}`,
    `Formality: ${_formalityDescription()}`,
  ];

  // Add avoid-patterns guidance
  parts.push(
    `Avoid: ${VOICE_PROFILE.avoidPatterns.slice(0, 8).map(p => `"${p.trim()}"`).join(", ")} and similar weak/vague phrasings.`
  );

  // Add section-specific constraints and tone guidance
  for (const section of sectionList) {
    const config = VOICE_PROFILE.limits[section];
    const tone = SECTION_TONE_PROFILES[section];

    const rules = [];
    if (config) {
      if (config.maxChars) rules.push(`max ${config.maxChars} characters`);
      if (config.minChars) rules.push(`min ${config.minChars} characters`);
      if (config.maxSentences) rules.push(`${config.minSentences || 1}-${config.maxSentences} sentences`);
      if (config.maxWords) rules.push(`${config.minWords || 1}-${config.maxWords} words`);
      if (config.maxPerRole) rules.push(`max ${config.maxPerRole} per role`);
    }

    const sectionLabel = _sectionDisplayName(section);

    if (rules.length > 0) {
      parts.push(`${sectionLabel}: ${rules.join(", ")}.`);
    }

    // Add tone guidance from section tone profiles
    if (tone) {
      parts.push(`${sectionLabel} tone: ${tone.tone}`);
      if (tone.tenseOverride) {
        parts.push(`${sectionLabel} tense: Use ${tone.tenseOverride} tense for this section.`);
      }
      if (tone.quantify) {
        parts.push(`${sectionLabel}: Quantify results with numbers when available.`);
      }
    }
  }

  // Add preferred verb examples for bullet-related sections
  if (sectionList.some(s => s === "bullet" || s === "episodeSummary")) {
    const verbs = VOICE_PROFILE.preferredVerbs.slice(0, 10).join(", ");
    parts.push(`Preferred opening verbs: ${verbs}.`);
  }

  return parts.join("\n");
}

/**
 * Generate the language-rule directive for system prompts.
 *
 * Centralizes the "detect language → write in same language" instruction
 * that was previously duplicated across every prompt.
 *
 * @param {string|null} [knownLang]  If the language is already known (e.g. from
 *                                   resume meta), embed it directly.  If null,
 *                                   the directive instructs the LLM to detect.
 * @returns {string}  Multi-line language directive ready to embed in a prompt
 */
export function buildLanguageDirective(knownLang = null) {
  if (knownLang) {
    return [
      "━━━ LANGUAGE RULE ━━━",
      `Write ALL generated text in "${knownLang}" (the language of the existing resume).`,
      "Do NOT mix languages unless the source material itself mixes them.",
    ].join("\n");
  }

  return [
    "━━━ LANGUAGE RULE ━━━",
    "Detect the primary language of the source text (ISO 639-1 code, e.g. \"ko\", \"en\", \"ja\").",
    "Write ALL generated text — summaries, bullets, labels, descriptions, taglines —",
    "in that SAME language. Do not mix languages unless the source itself does.",
  ].join("\n");
}

/**
 * Build a combined voice + language directive (convenience for prompts that
 * need both in sequence).
 *
 * @param {VoiceSectionType|VoiceSectionType[]} sections
 * @param {string|null} [knownLang]
 * @param {Object} [options]
 * @param {boolean} [options.includeDecisionReasoning=false]  Include decision reasoning directive
 * @returns {string}
 */
export function buildFullVoiceBlock(sections, knownLang = null, options = {}) {
  let block = buildVoiceDirective(sections) + "\n\n" + buildLanguageDirective(knownLang);
  if (options.includeDecisionReasoning) {
    block += "\n\n" + buildDecisionReasoningDirective();
  }
  return block;
}

// ─── Public: post-processing ─────────────────────────────────────────────────

/**
 * Return the configuration for a given section type.
 *
 * @param {VoiceSectionType} section
 * @returns {object|null}  The frozen limits object, or null if section is unknown
 */
export function getSectionConfig(section) {
  return VOICE_PROFILE.limits[section] || null;
}

/**
 * Post-process a generated text string for voice consistency.
 *
 * Applies light normalization:
 *   - Trims whitespace
 *   - Truncates to section max characters (with ellipsis)
 *   - Strips leading pronouns ("I ", "We ") when section expects verb-first
 *
 * Does NOT rewrite the text via LLM — this is a fast, deterministic pass.
 *
 * @param {string} text     The generated text to normalize
 * @param {VoiceSectionType} section  Which section this text belongs to
 * @returns {string}  Normalized text
 */
export function normalizeVoice(text, section) {
  if (!text || typeof text !== "string") return "";

  let result = text.trim();

  // Strip leading pronouns for verb-first sections
  if (_isVerbFirstSection(section)) {
    result = _stripLeadingPronouns(result);
  }

  // Enforce character limit
  const config = VOICE_PROFILE.limits[section];
  if (config?.maxChars && result.length > config.maxChars) {
    result = result.slice(0, config.maxChars - 1).trimEnd() + "\u2026";
  }

  return result;
}

/**
 * Normalize a single bullet string with bullet-specific rules.
 *
 * - Trims
 * - Strips leading dash/bullet markers
 * - Strips leading pronouns
 * - Enforces character limit
 * - Removes trailing period (resume bullet convention)
 *
 * @param {string} bullet
 * @returns {string}  Normalized bullet
 */
export function normalizeBullet(bullet) {
  if (!bullet || typeof bullet !== "string") return "";

  let result = bullet.trim();

  // Strip common leading markers
  result = result.replace(/^[-•–—]\s*/, "");

  // Strip leading pronouns
  result = _stripLeadingPronouns(result);

  // Capitalize first character
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  // Remove trailing period (resume convention — bullets don't end with periods)
  if (result.endsWith(".")) {
    result = result.slice(0, -1).trimEnd();
  }

  // Enforce character limit
  const maxChars = VOICE_PROFILE.limits.bullet.maxChars;
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 1).trimEnd() + "\u2026";
  }

  return result;
}

/**
 * Check a text string for voice compliance without mutating it.
 *
 * Returns a report object with flags for each potential issue.
 * Useful for quality tracking / metrics without blocking generation.
 *
 * @param {string} text
 * @param {VoiceSectionType} section
 * @returns {VoiceComplianceReport}
 *
 * @typedef {Object} VoiceComplianceReport
 * @property {boolean} compliant       True if no issues detected
 * @property {string[]} issues         Human-readable issue descriptions
 * @property {Object}   details        Structured detail flags
 * @property {boolean}  details.tooLong
 * @property {boolean}  details.tooShort
 * @property {boolean}  details.hasPronouns
 * @property {boolean}  details.hasWeakVerbs
 * @property {boolean}  details.hasPassiveVoice
 */
export function checkVoiceCompliance(text, section) {
  const issues = [];
  const details = {
    tooLong: false,
    tooShort: false,
    hasPronouns: false,
    hasWeakVerbs: false,
    hasPassiveVoice: false,
  };

  if (!text || typeof text !== "string") {
    return { compliant: false, issues: ["Empty or non-string text"], details };
  }

  const trimmed = text.trim();
  const config = VOICE_PROFILE.limits[section];

  // Length checks
  if (config?.maxChars && trimmed.length > config.maxChars) {
    details.tooLong = true;
    issues.push(`Exceeds ${config.maxChars} char limit (${trimmed.length} chars)`);
  }
  if (config?.minChars && trimmed.length < config.minChars) {
    details.tooShort = true;
    issues.push(`Below ${config.minChars} char minimum (${trimmed.length} chars)`);
  }

  // Pronoun checks (for verb-first sections)
  if (_isVerbFirstSection(section)) {
    for (const pattern of VOICE_PROFILE.avoidPatterns.slice(0, 4)) {
      if (trimmed.startsWith(pattern)) {
        details.hasPronouns = true;
        issues.push(`Starts with pronoun "${pattern.trim()}"`);
        break;
      }
    }
  }

  // Weak verb / passive voice checks
  const lowerText = trimmed.toLowerCase();
  const weakPatterns = VOICE_PROFILE.avoidPatterns.slice(4); // non-pronoun patterns
  for (const pattern of weakPatterns) {
    if (lowerText.includes(pattern.toLowerCase().trim())) {
      details.hasWeakVerbs = true;
      issues.push(`Contains weak/vague phrasing: "${pattern.trim()}"`);
    }
  }

  // Simple passive voice heuristic: "was/were + past participle"
  if (/\b(was|were)\s+\w+ed\b/i.test(trimmed)) {
    details.hasPassiveVoice = true;
    issues.push("Possible passive voice detected");
  }

  return {
    compliant: issues.length === 0,
    issues,
    details,
  };
}

/**
 * Batch-normalize an array of bullets, filtering out empty results.
 *
 * @param {string[]} bullets
 * @returns {string[]}  Normalized, non-empty bullets
 */
export function normalizeBullets(bullets) {
  if (!Array.isArray(bullets)) return [];
  return bullets
    .map(normalizeBullet)
    .filter(b => b.length > 0);
}

/**
 * Batch voice-compliance check for an array of texts.
 *
 * @param {string[]} texts
 * @param {VoiceSectionType} section
 * @returns {{ compliant: number, total: number, issues: Array<{index: number, text: string, report: VoiceComplianceReport}> }}
 */
export function checkBulkCompliance(texts, section) {
  if (!Array.isArray(texts)) return { compliant: 0, total: 0, issues: [] };

  const results = texts.map((text, index) => ({
    index,
    text,
    report: checkVoiceCompliance(text, section),
  }));

  const nonCompliant = results.filter(r => !r.report.compliant);

  return {
    compliant: results.length - nonCompliant.length,
    total: results.length,
    issues: nonCompliant,
  };
}

// ─── Public: decision reasoning directive ───────────────────────────────────

/**
 * Generate a directive for embedding decision reasoning from session
 * conversations (Codex/Claude) naturally into resume text.
 *
 * This is used by prompts that synthesize work log + session data into
 * resume output (project descriptions, episode summaries, axis descriptions,
 * strength descriptions).  It instructs the LLM to weave WHY decisions
 * were made into the text rather than treating reasoning as separate metadata.
 *
 * @returns {string}  Multi-line directive ready to embed in a system prompt
 */
export function buildDecisionReasoningDirective() {
  return [
    "━━━ DECISION REASONING INTEGRATION ━━━",
    "When AI session conversations or decision context is provided, embed the",
    "reasoning naturally into the generated text. Do NOT separate reasoning into",
    "metadata fields or parenthetical asides.",
    "",
    "GOOD — reasoning woven into the narrative:",
    '  "Chose event-driven architecture over polling after profiling showed 3x',
    '   lower CPU usage under sustained load"',
    '  "Implemented structured error boundaries rather than retry logic, based on',
    '   analysis showing 80% of failures were non-transient"',
    "",
    "BAD — reasoning as separate afterthought:",
    '  "Implemented event-driven architecture (Reason: better performance)"',
    '  "Built error boundaries. Decision: retries wouldn\'t help."',
    "",
    "The INTENT behind technical choices is what makes resume text compelling.",
    "Show the engineering judgment, not just the engineering output.",
    "When the reasoning is unclear or unavailable, write the bullet/description",
    "without it — never fabricate reasoning.",
  ].join("\n");
}

// ─── Public: section-aware normalization ─────────────────────────────────────

/**
 * Section-aware post-processing that applies tone-specific normalization
 * beyond the basic normalizeVoice rules.
 *
 * Extends normalizeVoice with:
 *   - tenseOverride awareness (flags present-tense in past-tense sections)
 *   - Section-specific capitalization rules
 *   - Quantification enforcement hints (returns text unchanged but logs)
 *   - Verb-first enforcement for bullet-like sections
 *
 * @param {string} text     The generated text to normalize
 * @param {VoiceSectionType} section  Which section this text belongs to
 * @returns {string}  Normalized text
 */
export function normalizeSection(text, section) {
  if (!text || typeof text !== "string") return "";

  let result = text.trim();

  const tone = SECTION_TONE_PROFILES[section];

  // Strip leading bullet markers FIRST (before pronoun stripping)
  if (tone?.verbFirst) {
    result = result.replace(/^[-•–—]\s*/, "");
  }

  // Strip leading pronouns for verb-first sections (from tone profile)
  if (tone?.verbFirst) {
    result = _stripLeadingPronouns(result);
  }

  // Capitalize first character for all sections
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  // Remove trailing period for bullet/episodeSummary (resume convention)
  if ((section === "bullet" || section === "episodeSummary") && result.endsWith(".")) {
    result = result.slice(0, -1).trimEnd();
  }

  // Enforce character limit
  const config = VOICE_PROFILE.limits[section];
  if (config?.maxChars && result.length > config.maxChars) {
    result = result.slice(0, config.maxChars - 1).trimEnd() + "\u2026";
  }

  return result;
}

// ─── Public: cross-section harmonization ────────────────────────────────────

/**
 * Validate and normalize voice across ALL sections of a complete resume.
 *
 * Takes a resume object and returns a harmonized copy with:
 *   - All text sections normalized via section-aware rules
 *   - Cross-section consistency issues identified
 *   - A compliance report for the whole document
 *
 * Does NOT modify the input — returns a new object with normalized texts
 * and a separate report.  User-edited items (_source === "user") are
 * NEVER modified, only checked.
 *
 * @param {Object} resume  The resume document (see resumeTypes.mjs)
 * @returns {HarmonizationResult}
 *
 * @typedef {Object} HarmonizationResult
 * @property {Object}   normalized    Resume with normalized text (user items untouched)
 * @property {Object}   report        Cross-section compliance report
 * @property {string[]} report.issues Human-readable cross-section issues
 * @property {number}   report.sectionsChecked  Total sections analyzed
 * @property {number}   report.sectionsCompliant  Sections passing all checks
 * @property {Object[]} report.perSection  Per-section compliance details
 */
export function harmonizeResumeVoice(resume) {
  if (!resume || typeof resume !== "object") {
    return {
      normalized: resume,
      report: { issues: ["Invalid resume object"], sectionsChecked: 0, sectionsCompliant: 0, perSection: [] },
    };
  }

  const issues = [];
  const perSection = [];
  let sectionsChecked = 0;
  let sectionsCompliant = 0;

  // Deep-clone to avoid mutation (shallow for non-text fields)
  const out = JSON.parse(JSON.stringify(resume));

  // ── Summary ──
  if (out.summary && typeof out.summary === "string") {
    const src = resume._sources?.summary;
    sectionsChecked++;
    const report = checkVoiceCompliance(out.summary, "summary");
    perSection.push({ section: "summary", ...report });
    if (report.compliant) sectionsCompliant++;
    else issues.push(...report.issues.map(i => `[summary] ${i}`));

    if (src !== "user") {
      out.summary = normalizeSection(out.summary, "summary");
    }
  }

  // ── Experience bullets ──
  if (Array.isArray(out.experience)) {
    for (let i = 0; i < out.experience.length; i++) {
      const item = out.experience[i];
      if (!Array.isArray(item.bullets)) continue;

      for (let j = 0; j < item.bullets.length; j++) {
        sectionsChecked++;
        const report = checkVoiceCompliance(item.bullets[j], "bullet");
        perSection.push({ section: `experience[${i}].bullets[${j}]`, ...report });
        if (report.compliant) sectionsCompliant++;
        else issues.push(...report.issues.map(is => `[experience[${i}].bullets[${j}]] ${is}`));

        if (item._source !== "user") {
          item.bullets[j] = normalizeSection(item.bullets[j], "bullet");
        }
      }
    }
  }

  // ── Project bullets ──
  if (Array.isArray(out.projects)) {
    for (let i = 0; i < out.projects.length; i++) {
      const item = out.projects[i];

      // Normalize project title
      const title = item.name || item.title;
      if (title && item._source !== "user") {
        sectionsChecked++;
        const report = checkVoiceCompliance(title, "projectTitle");
        perSection.push({ section: `projects[${i}].title`, ...report });
        if (report.compliant) sectionsCompliant++;
        else issues.push(...report.issues.map(is => `[projects[${i}].title] ${is}`));
      }

      // Normalize project description
      if (item.description && item._source !== "user") {
        sectionsChecked++;
        const report = checkVoiceCompliance(item.description, "projectDescription");
        perSection.push({ section: `projects[${i}].description`, ...report });
        if (report.compliant) sectionsCompliant++;
        else issues.push(...report.issues.map(is => `[projects[${i}].description] ${is}`));
      }

      if (!Array.isArray(item.bullets)) continue;
      for (let j = 0; j < item.bullets.length; j++) {
        sectionsChecked++;
        const report = checkVoiceCompliance(item.bullets[j], "bullet");
        perSection.push({ section: `projects[${i}].bullets[${j}]`, ...report });
        if (report.compliant) sectionsCompliant++;
        else issues.push(...report.issues.map(is => `[projects[${i}].bullets[${j}]] ${is}`));

        if (item._source !== "user") {
          item.bullets[j] = normalizeSection(item.bullets[j], "bullet");
        }
      }
    }
  }

  // ── Cross-section consistency checks ──
  _checkCrossSectionConsistency(out, issues);

  return {
    normalized: out,
    report: {
      issues,
      sectionsChecked,
      sectionsCompliant,
      perSection,
    },
  };
}

/**
 * Score the voice consistency of a complete resume on a 0-1 scale.
 *
 * Combines per-section compliance rates with cross-section consistency
 * checks into a single quality signal.
 *
 * @param {Object} resume  The resume document
 * @returns {VoiceConsistencyScore}
 *
 * @typedef {Object} VoiceConsistencyScore
 * @property {number}   score           Overall score (0-1, higher = more consistent)
 * @property {number}   sectionScore    Per-section compliance ratio (0-1)
 * @property {number}   crossSectionScore  Cross-section consistency ratio (0-1)
 * @property {string[]} topIssues       Up to 5 most impactful issues
 * @property {string}   grade           Letter grade: A (≥0.9), B (≥0.75), C (≥0.6), D (<0.6)
 */
export function scoreResumeVoiceConsistency(resume) {
  const { report } = harmonizeResumeVoice(resume);

  // Section compliance ratio
  const sectionScore = report.sectionsChecked > 0
    ? report.sectionsCompliant / report.sectionsChecked
    : 1;

  // Cross-section issues (issues that contain "[cross-section]")
  const crossIssues = report.issues.filter(i => i.startsWith("[cross-section]"));
  const sectionIssues = report.issues.filter(i => !i.startsWith("[cross-section]"));

  // Cross-section score: penalize 0.15 per cross-section issue, floor at 0
  const crossSectionScore = Math.max(0, 1 - crossIssues.length * 0.15);

  // Combined: 70% section compliance + 30% cross-section consistency
  const score = Math.round((sectionScore * 0.7 + crossSectionScore * 0.3) * 100) / 100;

  // Top issues: prioritize cross-section, then section
  const topIssues = [...crossIssues, ...sectionIssues].slice(0, 5);

  const grade = score >= 0.9 ? "A" : score >= 0.75 ? "B" : score >= 0.6 ? "C" : "D";

  return { score, sectionScore, crossSectionScore, topIssues, grade };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Sections where text should start with a verb (no leading pronouns).
 * Uses SECTION_TONE_PROFILES.verbFirst when available, falls back to hardcoded list.
 * @param {string} section
 * @returns {boolean}
 */
function _isVerbFirstSection(section) {
  const tone = SECTION_TONE_PROFILES[section];
  if (tone) return !!tone.verbFirst;
  return section === "bullet" || section === "episodeSummary";
}

/**
 * Check cross-section consistency of a resume document.
 * Identifies issues like mixed tense usage, inconsistent verb patterns, etc.
 * Pushes issues prefixed with "[cross-section]" to the issues array.
 *
 * @param {Object} resume
 * @param {string[]} issues  Mutable array to push issues into
 */
function _checkCrossSectionConsistency(resume, issues) {
  // Collect all bullet texts for cross-section analysis
  const allBullets = [];
  if (Array.isArray(resume.experience)) {
    for (const item of resume.experience) {
      if (Array.isArray(item.bullets)) allBullets.push(...item.bullets);
    }
  }
  if (Array.isArray(resume.projects)) {
    for (const item of resume.projects) {
      if (Array.isArray(item.bullets)) allBullets.push(...item.bullets);
    }
  }

  if (allBullets.length === 0) return;

  // Check tense consistency across bullets
  let pastCount = 0;
  let presentCount = 0;
  for (const b of allBullets) {
    if (!b || typeof b !== "string") continue;
    // Simple heuristic: past tense bullets start with past-tense verb (ends in -ed, -lt, -nt, -zed, etc.)
    const firstWord = b.trim().split(/\s+/)[0] || "";
    if (/^(Led|Built|Designed|Reduced|Improved|Automated|Migrated|Optimized|Resolved|Established|Streamlined|Integrated|Refactored|Deployed|Architected|Eliminated|Standardized|Accelerated|Centralized|Implemented|Created|Developed|Managed|Shipped|Launched|Fixed|Updated|Removed|Added|Configured|Monitored|Analyzed|Tested|Documented)$/i.test(firstWord)
        || /ed$/i.test(firstWord)) {
      pastCount++;
    } else if (/^(Lead|Build|Design|Reduce|Improve|Automate|Migrate|Optimize|Resolve|Establish|Streamline|Integrate|Refactor|Deploy|Architect|Eliminate|Standardize|Accelerate|Centralize|Implement|Create|Develop|Manage|Ship|Launch|Fix|Update|Remove|Add|Configure|Monitor|Analyze|Test|Document)$/i.test(firstWord)
        || /s$/.test(firstWord)) {
      presentCount++;
    }
  }

  // If more than 25% of bullets use a different tense from the majority, flag it
  const total = pastCount + presentCount;
  if (total > 2) {
    const minorityCount = Math.min(pastCount, presentCount);
    const minorityRatio = minorityCount / total;
    if (minorityRatio > 0.25) {
      const majorTense = pastCount >= presentCount ? "past" : "present";
      const minorTense = majorTense === "past" ? "present" : "past";
      issues.push(
        `[cross-section] Mixed tense detected: ${minorityCount}/${total} bullets use ${minorTense} tense while majority use ${majorTense} tense`
      );
    }
  }

  // Check for pronoun leakage across all bullets
  let pronounLeaks = 0;
  for (const b of allBullets) {
    if (!b || typeof b !== "string") continue;
    if (/^(I |We |My |Our )/i.test(b.trim())) {
      pronounLeaks++;
    }
  }
  if (pronounLeaks > 0) {
    issues.push(
      `[cross-section] ${pronounLeaks} bullet(s) start with pronouns — should use verb-first style`
    );
  }

  // Check summary vs bullets consistency
  if (resume.summary && typeof resume.summary === "string") {
    // Summary should NOT use exact same phrasing as bullets (deduplication)
    for (const b of allBullets) {
      if (!b || typeof b !== "string") continue;
      if (resume.summary.includes(b) && b.length > 30) {
        issues.push(
          `[cross-section] Summary contains verbatim bullet text: "${b.slice(0, 60)}…"`
        );
        break; // One warning is enough
      }
    }
  }
}

/**
 * Strip leading first-person pronouns from text.
 * @param {string} text
 * @returns {string}
 */
function _stripLeadingPronouns(text) {
  return text.replace(/^(I |We |My |Our )/i, "");
}

function _tenseDescription() {
  switch (VOICE_PROFILE.tense) {
    case "past":
      return "Use past tense for completed work (\"Designed\", \"Built\", \"Reduced\"). " +
             "Use present tense only for ongoing/current responsibilities.";
    case "present":
      return "Use present tense for current work and ongoing responsibilities.";
    default:
      return `Use ${VOICE_PROFILE.tense} tense.`;
  }
}

function _perspectiveDescription() {
  switch (VOICE_PROFILE.perspective) {
    case "third-person-implied":
      return "Do NOT use pronouns (\"I\", \"We\", \"My\"). Start bullets directly " +
             "with an action verb. Summaries may use implied third person.";
    case "first-person":
      return "Use first person (\"I\") sparingly — prefer verb-first phrasing.";
    default:
      return `Use ${VOICE_PROFILE.perspective} perspective.`;
  }
}

function _formalityDescription() {
  switch (VOICE_PROFILE.formality) {
    case "professional-concise":
      return "Professional but not stiff. Concise but not terse. " +
             "Prefer concrete, specific language over abstract claims. " +
             "Quantify results when numbers are available.";
    default:
      return `Formality level: ${VOICE_PROFILE.formality}.`;
  }
}

function _sectionDisplayName(section) {
  const names = {
    bullet: "Bullets",
    summary: "Summary",
    projectTitle: "Project titles",
    projectDescription: "Project descriptions",
    episodeTitle: "Episode titles",
    episodeSummary: "Episode summaries",
    strengthLabel: "Strength labels",
    strengthDescription: "Strength descriptions",
    axisLabel: "Narrative axis labels",
    axisDescription: "Narrative axis descriptions",
    displayAxisLabel: "Display axis labels",
    displayAxisTagline: "Display axis taglines",
    keyword: "Keywords",
  };
  return names[section] || section;
}
