/**
 * Unit tests for resumeVoice.mjs — Voice & Tone Engine
 *
 * Run with:
 *   node --test src/lib/resumeVoice.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  VOICE_PROFILE,
  SECTION_TONE_PROFILES,
  buildVoiceDirective,
  buildLanguageDirective,
  buildFullVoiceBlock,
  buildDecisionReasoningDirective,
  normalizeVoice,
  normalizeSection,
  normalizeBullet,
  normalizeBullets,
  checkVoiceCompliance,
  checkBulkCompliance,
  getSectionConfig,
  harmonizeResumeVoice,
  scoreResumeVoiceConsistency,
} from "./resumeVoice.mjs";

// ─── VOICE_PROFILE ────────────────────────────────────────────────────────────

describe("VOICE_PROFILE", () => {
  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(VOICE_PROFILE));
    assert.ok(Object.isFrozen(VOICE_PROFILE.preferredVerbs));
    assert.ok(Object.isFrozen(VOICE_PROFILE.avoidPatterns));
    assert.ok(Object.isFrozen(VOICE_PROFILE.limits));
    assert.ok(Object.isFrozen(VOICE_PROFILE.limits.bullet));
  });

  it("has required core style attributes", () => {
    assert.equal(VOICE_PROFILE.tense, "past");
    assert.equal(VOICE_PROFILE.perspective, "third-person-implied");
    assert.equal(VOICE_PROFILE.formality, "professional-concise");
    assert.equal(VOICE_PROFILE.voice, "active");
  });

  it("has non-empty preferred verbs", () => {
    assert.ok(VOICE_PROFILE.preferredVerbs.length >= 10);
    assert.ok(VOICE_PROFILE.preferredVerbs.includes("Designed"));
    assert.ok(VOICE_PROFILE.preferredVerbs.includes("Built"));
  });

  it("has non-empty avoid patterns", () => {
    assert.ok(VOICE_PROFILE.avoidPatterns.length >= 5);
    assert.ok(VOICE_PROFILE.avoidPatterns.includes("I "));
    assert.ok(VOICE_PROFILE.avoidPatterns.includes("was responsible"));
  });

  it("has bullet limits with consistent maxChars = 140", () => {
    assert.equal(VOICE_PROFILE.limits.bullet.maxChars, 140);
  });

  it("has section limits for all key sections", () => {
    const expectedSections = [
      "bullet", "summary", "projectTitle", "projectDescription",
      "episodeTitle", "strengthLabel", "strengthDescription",
      "axisLabel", "axisDescription", "displayAxisLabel",
      "displayAxisTagline", "keyword"
    ];
    for (const section of expectedSections) {
      assert.ok(VOICE_PROFILE.limits[section], `Missing limits for "${section}"`);
    }
  });
});

// ─── buildVoiceDirective ─────────────────────────────────────────────────────

describe("buildVoiceDirective", () => {
  it("returns a non-empty string for a single section", () => {
    const result = buildVoiceDirective("bullet");
    assert.ok(result.length > 0);
    assert.ok(result.includes("VOICE & TONE"));
  });

  it("includes tense, voice, perspective, and formality", () => {
    const result = buildVoiceDirective("bullet");
    assert.ok(result.includes("Tense:"), "Missing tense directive");
    assert.ok(result.includes("Voice:"), "Missing voice directive");
    assert.ok(result.includes("Perspective:"), "Missing perspective directive");
    assert.ok(result.includes("Formality:"), "Missing formality directive");
  });

  it("includes avoid-patterns guidance", () => {
    const result = buildVoiceDirective("bullet");
    assert.ok(result.includes("Avoid:"));
    assert.ok(result.includes("was responsible"));
  });

  it("includes section-specific limits for bullets", () => {
    const result = buildVoiceDirective("bullet");
    assert.ok(result.includes("140 characters"));
    assert.ok(result.includes("Bullets:"));
  });

  it("includes preferred verbs for bullet sections", () => {
    const result = buildVoiceDirective("bullet");
    assert.ok(result.includes("Preferred opening verbs:"));
    assert.ok(result.includes("Designed"));
  });

  it("does NOT include preferred verbs for non-bullet sections", () => {
    const result = buildVoiceDirective("axisLabel");
    assert.ok(!result.includes("Preferred opening verbs:"));
  });

  it("accepts an array of sections", () => {
    const result = buildVoiceDirective(["bullet", "summary", "projectTitle"]);
    assert.ok(result.includes("Bullets:"));
    assert.ok(result.includes("Summary:"));
    assert.ok(result.includes("Project titles:"));
  });

  it("handles unknown sections gracefully", () => {
    const result = buildVoiceDirective("nonexistent");
    assert.ok(result.includes("VOICE & TONE"));
    // Should not crash, just omit section-specific limits
  });
});

// ─── buildLanguageDirective ──────────────────────────────────────────────────

describe("buildLanguageDirective", () => {
  it("includes auto-detect instructions when no language specified", () => {
    const result = buildLanguageDirective();
    assert.ok(result.includes("LANGUAGE RULE"));
    assert.ok(result.includes("Detect"));
    assert.ok(result.includes("ISO 639-1"));
  });

  it("includes specific language when provided", () => {
    const result = buildLanguageDirective("ko");
    assert.ok(result.includes("LANGUAGE RULE"));
    assert.ok(result.includes('"ko"'));
    assert.ok(!result.includes("Detect"));
  });

  it("handles null explicitly as auto-detect", () => {
    const result = buildLanguageDirective(null);
    assert.ok(result.includes("Detect"));
  });
});

// ─── buildFullVoiceBlock ─────────────────────────────────────────────────────

describe("buildFullVoiceBlock", () => {
  it("combines voice and language directives", () => {
    const result = buildFullVoiceBlock("bullet", "en");
    assert.ok(result.includes("VOICE & TONE"));
    assert.ok(result.includes("LANGUAGE RULE"));
    assert.ok(result.includes('"en"'));
  });

  it("uses auto-detect when no language given", () => {
    const result = buildFullVoiceBlock("summary");
    assert.ok(result.includes("VOICE & TONE"));
    assert.ok(result.includes("Detect"));
  });
});

// ─── getSectionConfig ────────────────────────────────────────────────────────

describe("getSectionConfig", () => {
  it("returns config for known sections", () => {
    const config = getSectionConfig("bullet");
    assert.ok(config);
    assert.equal(config.maxChars, 140);
  });

  it("returns null for unknown sections", () => {
    assert.equal(getSectionConfig("nonexistent"), null);
  });
});

// ─── normalizeVoice ──────────────────────────────────────────────────────────

describe("normalizeVoice", () => {
  it("trims whitespace", () => {
    assert.equal(normalizeVoice("  Built API  ", "bullet"), "Built API");
  });

  it("returns empty string for null/undefined", () => {
    assert.equal(normalizeVoice(null, "bullet"), "");
    assert.equal(normalizeVoice(undefined, "bullet"), "");
  });

  it("strips leading pronouns for bullet sections", () => {
    assert.equal(normalizeVoice("I designed the API", "bullet"), "designed the API");
    assert.equal(normalizeVoice("We built the system", "bullet"), "built the system");
  });

  it("does NOT strip pronouns for non-verb-first sections", () => {
    assert.equal(
      normalizeVoice("I am an experienced engineer", "summary"),
      "I am an experienced engineer"
    );
  });

  it("truncates text exceeding maxChars with ellipsis", () => {
    const longText = "A".repeat(150);
    const result = normalizeVoice(longText, "bullet");
    assert.ok(result.length <= 140);
    assert.ok(result.endsWith("\u2026"));
  });

  it("does not truncate text within limit", () => {
    const text = "Built a scalable API gateway";
    assert.equal(normalizeVoice(text, "bullet"), text);
  });
});

// ─── normalizeBullet ─────────────────────────────────────────────────────────

describe("normalizeBullet", () => {
  it("trims whitespace", () => {
    assert.equal(normalizeBullet("  Built API  "), "Built API");
  });

  it("strips leading dash markers", () => {
    assert.equal(normalizeBullet("- Built API"), "Built API");
    assert.equal(normalizeBullet("• Built API"), "Built API");
    assert.equal(normalizeBullet("— Built API"), "Built API");
  });

  it("strips leading pronouns", () => {
    assert.equal(normalizeBullet("I designed the API"), "Designed the API");
  });

  it("capitalizes first character", () => {
    assert.equal(normalizeBullet("built the API"), "Built the API");
  });

  it("removes trailing period", () => {
    assert.equal(normalizeBullet("Built the API."), "Built the API");
  });

  it("enforces 140 char limit", () => {
    const longBullet = "A".repeat(150);
    const result = normalizeBullet(longBullet);
    assert.ok(result.length <= 140);
    assert.ok(result.endsWith("\u2026"));
  });

  it("returns empty string for null/undefined", () => {
    assert.equal(normalizeBullet(null), "");
    assert.equal(normalizeBullet(undefined), "");
    assert.equal(normalizeBullet(""), "");
  });

  it("handles combined issues: dash + pronoun + trailing period", () => {
    assert.equal(normalizeBullet("- I built the API."), "Built the API");
  });
});

// ─── normalizeBullets ────────────────────────────────────────────────────────

describe("normalizeBullets", () => {
  it("normalizes an array of bullets", () => {
    const result = normalizeBullets([
      "- I built the API.",
      "• Deployed to production",
      "  Automated tests  "
    ]);
    assert.deepEqual(result, [
      "Built the API",
      "Deployed to production",
      "Automated tests"
    ]);
  });

  it("filters out empty results", () => {
    const result = normalizeBullets(["", null, "Built API"]);
    assert.deepEqual(result, ["Built API"]);
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(normalizeBullets(null), []);
    assert.deepEqual(normalizeBullets("not an array"), []);
  });
});

// ─── checkVoiceCompliance ────────────────────────────────────────────────────

describe("checkVoiceCompliance", () => {
  it("returns compliant for good bullet", () => {
    const report = checkVoiceCompliance("Designed scalable API gateway handling 10K req/s", "bullet");
    assert.ok(report.compliant);
    assert.equal(report.issues.length, 0);
  });

  it("flags text exceeding maxChars", () => {
    const report = checkVoiceCompliance("A".repeat(150), "bullet");
    assert.ok(!report.compliant);
    assert.ok(report.details.tooLong);
    assert.ok(report.issues.some(i => i.includes("char limit")));
  });

  it("flags text below minChars", () => {
    const report = checkVoiceCompliance("Short", "bullet");
    assert.ok(!report.compliant);
    assert.ok(report.details.tooShort);
  });

  it("flags leading pronouns in bullet sections", () => {
    const report = checkVoiceCompliance("I built the API", "bullet");
    assert.ok(!report.compliant);
    assert.ok(report.details.hasPronouns);
  });

  it("does NOT flag pronouns in summary section", () => {
    const report = checkVoiceCompliance("I am an experienced engineer with 10 years in backend systems", "summary");
    assert.ok(!report.details.hasPronouns);
  });

  it("flags weak verbs", () => {
    const report = checkVoiceCompliance("Was responsible for the API design and deployment system", "bullet");
    assert.ok(!report.compliant);
    assert.ok(report.details.hasWeakVerbs);
  });

  it("flags passive voice", () => {
    const report = checkVoiceCompliance("The system was redesigned to handle more requests efficiently", "bullet");
    assert.ok(report.details.hasPassiveVoice);
  });

  it("handles empty/null input", () => {
    const report = checkVoiceCompliance("", "bullet");
    assert.ok(!report.compliant);

    const reportNull = checkVoiceCompliance(null, "bullet");
    assert.ok(!reportNull.compliant);
  });
});

// ─── checkBulkCompliance ─────────────────────────────────────────────────────

describe("checkBulkCompliance", () => {
  it("reports correct counts for mixed compliance", () => {
    const texts = [
      "Designed scalable API gateway handling 10K requests per second",
      "I built the thing",
      "Reduced deployment time by 40% through CI/CD pipeline automation",
    ];
    const result = checkBulkCompliance(texts, "bullet");
    assert.equal(result.total, 3);
    // "I built the thing" fails (pronoun + too short)
    assert.ok(result.issues.length >= 1);
    assert.ok(result.compliant <= 2);
  });

  it("returns zero counts for non-array input", () => {
    const result = checkBulkCompliance(null, "bullet");
    assert.equal(result.total, 0);
    assert.equal(result.compliant, 0);
  });

  it("returns all compliant for good bullets", () => {
    const texts = [
      "Designed scalable API gateway handling 10K requests per second",
      "Reduced deployment time by 40% through CI/CD automation pipeline",
    ];
    const result = checkBulkCompliance(texts, "bullet");
    assert.equal(result.compliant, 2);
    assert.equal(result.issues.length, 0);
  });
});

// ─── Voice directive consistency ─────────────────────────────────────────────

describe("cross-section directive consistency", () => {
  it("all directives share the same core voice attributes", () => {
    const sections = ["bullet", "summary", "projectTitle", "axisLabel", "strengthLabel"];
    for (const section of sections) {
      const directive = buildVoiceDirective(section);
      assert.ok(directive.includes("active voice"), `${section} directive missing active voice`);
      assert.ok(directive.includes("past tense") || directive.includes("Past") || directive.includes("Tense:"),
        `${section} directive missing tense guidance`);
    }
  });

  it("language directive is independent of voice directive", () => {
    const voice = buildVoiceDirective("bullet");
    const lang = buildLanguageDirective("ko");
    // Voice should not contain language rules
    assert.ok(!voice.includes("LANGUAGE RULE"));
    // Language should not contain voice rules
    assert.ok(!lang.includes("VOICE & TONE"));
  });
});

// ─── SECTION_TONE_PROFILES ──────────────────────────────────────────────────

describe("SECTION_TONE_PROFILES", () => {
  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(SECTION_TONE_PROFILES));
    assert.ok(Object.isFrozen(SECTION_TONE_PROFILES.bullet));
  });

  it("has profiles for all known sections", () => {
    const expectedSections = [
      "bullet", "summary", "projectTitle", "projectDescription",
      "episodeTitle", "episodeSummary", "strengthLabel", "strengthDescription",
      "axisLabel", "axisDescription", "displayAxisLabel", "displayAxisTagline",
      "keyword"
    ];
    for (const section of expectedSections) {
      assert.ok(SECTION_TONE_PROFILES[section], `Missing tone profile for "${section}"`);
    }
  });

  it("each profile has required fields", () => {
    for (const [section, profile] of Object.entries(SECTION_TONE_PROFILES)) {
      assert.ok(typeof profile.intent === "string", `${section}.intent missing`);
      assert.ok(typeof profile.tone === "string", `${section}.tone missing`);
      assert.ok(typeof profile.verbFirst === "boolean", `${section}.verbFirst missing`);
      assert.ok(typeof profile.quantify === "boolean", `${section}.quantify missing`);
      assert.ok(Array.isArray(profile.exampleOpeners), `${section}.exampleOpeners missing`);
      assert.ok(profile.exampleOpeners.length >= 1, `${section}.exampleOpeners is empty`);
    }
  });

  it("bullet and episodeSummary are verb-first", () => {
    assert.ok(SECTION_TONE_PROFILES.bullet.verbFirst);
    assert.ok(SECTION_TONE_PROFILES.episodeSummary.verbFirst);
  });

  it("summary and axisLabel use present tense override", () => {
    assert.equal(SECTION_TONE_PROFILES.summary.tenseOverride, "present");
    assert.equal(SECTION_TONE_PROFILES.axisLabel.tenseOverride, "present");
  });

  it("bullet sections prioritize quantification", () => {
    assert.ok(SECTION_TONE_PROFILES.bullet.quantify);
    assert.ok(SECTION_TONE_PROFILES.projectDescription.quantify);
  });
});

// ─── buildDecisionReasoningDirective ────────────────────────────────────────

describe("buildDecisionReasoningDirective", () => {
  it("returns a non-empty string", () => {
    const result = buildDecisionReasoningDirective();
    assert.ok(result.length > 0);
  });

  it("includes the directive header", () => {
    const result = buildDecisionReasoningDirective();
    assert.ok(result.includes("DECISION REASONING INTEGRATION"));
  });

  it("includes good and bad examples", () => {
    const result = buildDecisionReasoningDirective();
    assert.ok(result.includes("GOOD"), "Missing good example section");
    assert.ok(result.includes("BAD"), "Missing bad example section");
  });

  it("warns against fabricating reasoning", () => {
    const result = buildDecisionReasoningDirective();
    assert.ok(result.includes("never fabricate"));
  });
});

// ─── buildFullVoiceBlock with decision reasoning ────────────────────────────

describe("buildFullVoiceBlock with decision reasoning option", () => {
  it("includes decision reasoning when option is set", () => {
    const result = buildFullVoiceBlock("bullet", null, { includeDecisionReasoning: true });
    assert.ok(result.includes("VOICE & TONE"));
    assert.ok(result.includes("LANGUAGE RULE"));
    assert.ok(result.includes("DECISION REASONING INTEGRATION"));
  });

  it("omits decision reasoning by default", () => {
    const result = buildFullVoiceBlock("bullet", "en");
    assert.ok(result.includes("VOICE & TONE"));
    assert.ok(!result.includes("DECISION REASONING INTEGRATION"));
  });

  it("is backward-compatible with 2-arg calls", () => {
    const result = buildFullVoiceBlock("bullet", "ko");
    assert.ok(result.includes("VOICE & TONE"));
    assert.ok(result.includes('"ko"'));
  });
});

// ─── buildVoiceDirective with tone profiles ─────────────────────────────────

describe("buildVoiceDirective tone profile integration", () => {
  it("includes tone guidance for bullet sections", () => {
    const result = buildVoiceDirective("bullet");
    assert.ok(result.includes("tone:"), "Missing tone guidance for bullet");
  });

  it("includes tense override guidance for summary", () => {
    const result = buildVoiceDirective("summary");
    assert.ok(result.includes("present tense"), "Missing tense override for summary");
  });

  it("includes quantification guidance for bullet", () => {
    const result = buildVoiceDirective("bullet");
    assert.ok(result.includes("Quantify"), "Missing quantification guidance");
  });

  it("includes tone for multiple sections", () => {
    const result = buildVoiceDirective(["bullet", "axisLabel"]);
    assert.ok(result.includes("Bullets"));
    assert.ok(result.includes("Narrative axis labels"));
  });
});

// ─── normalizeSection ───────────────────────────────────────────────────────

describe("normalizeSection", () => {
  it("returns empty string for null/undefined", () => {
    assert.equal(normalizeSection(null, "bullet"), "");
    assert.equal(normalizeSection(undefined, "bullet"), "");
  });

  it("trims whitespace", () => {
    assert.equal(normalizeSection("  Built API  ", "bullet"), "Built API");
  });

  it("strips pronouns for verb-first sections", () => {
    assert.equal(normalizeSection("I designed the API", "bullet"), "Designed the API");
    assert.equal(normalizeSection("We built the system", "episodeSummary"), "Built the system");
  });

  it("does NOT strip pronouns for non-verb-first sections", () => {
    const result = normalizeSection("I am an experienced engineer", "summary");
    assert.equal(result, "I am an experienced engineer");
  });

  it("strips bullet markers for verb-first sections", () => {
    assert.equal(normalizeSection("- Built API", "bullet"), "Built API");
    assert.equal(normalizeSection("• Shipped feature", "bullet"), "Shipped feature");
  });

  it("capitalizes first character", () => {
    assert.equal(normalizeSection("built the API", "bullet"), "Built the API");
    assert.equal(normalizeSection("payment systems engineer", "summary"), "Payment systems engineer");
  });

  it("removes trailing period for bullet/episodeSummary", () => {
    assert.equal(normalizeSection("Built the API.", "bullet"), "Built the API");
    assert.equal(normalizeSection("Implemented error boundaries.", "episodeSummary"), "Implemented error boundaries");
  });

  it("keeps trailing period for summary and description sections", () => {
    assert.equal(normalizeSection("Backend engineer specializing in payments.", "summary"), "Backend engineer specializing in payments.");
  });

  it("enforces character limits", () => {
    const longBullet = "A".repeat(150);
    const result = normalizeSection(longBullet, "bullet");
    assert.ok(result.length <= 140);
    assert.ok(result.endsWith("\u2026"));
  });

  it("handles combined normalization", () => {
    assert.equal(normalizeSection("- I built the API.", "bullet"), "Built the API");
  });
});

// ─── harmonizeResumeVoice ───────────────────────────────────────────────────

describe("harmonizeResumeVoice", () => {
  it("returns result for null input", () => {
    const { normalized, report } = harmonizeResumeVoice(null);
    assert.equal(normalized, null);
    assert.ok(report.issues.length > 0);
  });

  it("returns result for empty resume", () => {
    const { normalized, report } = harmonizeResumeVoice({});
    assert.equal(report.sectionsChecked, 0);
    assert.equal(report.sectionsCompliant, 0);
  });

  it("checks summary compliance", () => {
    const resume = { summary: "A".repeat(700) };
    const { report } = harmonizeResumeVoice(resume);
    assert.ok(report.sectionsChecked >= 1);
    assert.ok(report.issues.some(i => i.includes("summary")));
  });

  it("normalizes system-generated bullets", () => {
    const resume = {
      experience: [
        { company: "Acme", _source: "system", bullets: ["I built the API"] }
      ]
    };
    const { normalized } = harmonizeResumeVoice(resume);
    assert.equal(normalized.experience[0].bullets[0], "Built the API");
  });

  it("does NOT normalize user-edited bullets", () => {
    const resume = {
      experience: [
        { company: "Acme", _source: "user", bullets: ["I built the API"] }
      ]
    };
    const { normalized } = harmonizeResumeVoice(resume);
    assert.equal(normalized.experience[0].bullets[0], "I built the API");
  });

  it("detects cross-section pronoun leakage on user-protected items", () => {
    // User items are NOT normalized, so pronoun leakage persists and is detected
    const resume = {
      experience: [
        { company: "A", _source: "user", bullets: ["I designed the API", "We built the system"] }
      ]
    };
    const { report } = harmonizeResumeVoice(resume);
    assert.ok(report.issues.some(i => i.includes("pronouns") || i.includes("cross-section")));
  });

  it("normalizes project bullets and checks titles", () => {
    const resume = {
      projects: [
        {
          name: "Test Project",
          description: "A test project description",
          _source: "system",
          bullets: ["- I wrote the tests."]
        }
      ]
    };
    const { normalized } = harmonizeResumeVoice(resume);
    assert.equal(normalized.projects[0].bullets[0], "Wrote the tests");
  });
});

// ─── scoreResumeVoiceConsistency ────────────────────────────────────────────

describe("scoreResumeVoiceConsistency", () => {
  it("returns perfect score for compliant resume", () => {
    const resume = {
      summary: "Backend engineer with 5 years building payment systems and APIs for fintech products.",
      experience: [
        { company: "Acme", _source: "system", bullets: [
          "Designed scalable API gateway handling 10K requests per second",
          "Reduced deployment time by 40% through CI/CD pipeline automation",
        ]}
      ]
    };
    const result = scoreResumeVoiceConsistency(resume);
    assert.ok(result.score >= 0.7);
    assert.ok(result.score <= 1.0);
    assert.ok(["A", "B"].includes(result.grade));
  });

  it("returns lower score for non-compliant resume", () => {
    const resume = {
      summary: "I am a coder",
      experience: [
        { company: "A", _source: "system", bullets: [
          "I worked on things",
          "We helped to build stuff",
          "Was responsible for various systems",
        ]}
      ]
    };
    const result = scoreResumeVoiceConsistency(resume);
    assert.ok(result.score < 0.8);
    assert.ok(result.topIssues.length > 0);
  });

  it("returns correct structure", () => {
    const result = scoreResumeVoiceConsistency({});
    assert.ok(typeof result.score === "number");
    assert.ok(typeof result.sectionScore === "number");
    assert.ok(typeof result.crossSectionScore === "number");
    assert.ok(Array.isArray(result.topIssues));
    assert.ok(typeof result.grade === "string");
  });

  it("grades correctly", () => {
    // Empty resume should get perfect score (nothing to fail)
    const result = scoreResumeVoiceConsistency({});
    assert.equal(result.grade, "A");
  });
});
