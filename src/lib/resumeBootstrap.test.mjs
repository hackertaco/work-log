/**
 * Unit tests for resumeBootstrap.mjs
 *
 * Tests cover all parsing and normalization logic without making real LLM API calls.
 * The public `generateResumeFromText` is tested only for synchronous error paths
 * (missing API key, disabled OpenAI) where no network call is required.
 *
 * Run with: node --test src/lib/resumeBootstrap.test.mjs
 *
 * Functions under test (all exported from resumeBootstrap.mjs):
 *   - generateResumeFromText   — error paths only (no live API)
 *   - deriveSource             — source tag inference
 *   - buildUserMessage         — user message construction
 *   - normalizeBootstrapResult — main response parsing/assembly
 *   - normalizeLanguageCode    — ISO 639-1 code normalization
 *   - normalizeContact         — contact block normalization
 *   - normalizeExperience      — experience array normalization
 *   - normalizeEducation       — education array normalization
 *   - normalizeSkills          — skills object normalization
 *   - normalizeProjects        — projects array normalization
 *   - normalizeCertifications  — certifications array normalization
 *   - normalizeDisplayAxes     — display axes array normalization
 *   - normalizeStringArray     — generic string array normalization
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  generateResumeFromText,
  deriveSource,
  buildUserMessage,
  normalizeBootstrapResult,
  normalizeLanguageCode,
  normalizeContact,
  normalizeExperience,
  normalizeEducation,
  normalizeSkills,
  normalizeProjects,
  normalizeCertifications,
  normalizeDisplayAxes,
  normalizeStringArray
} from "./resumeBootstrap.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal valid LLM output (parsed object). */
function makeParsedOutput(overrides = {}) {
  return {
    resume: {
      language: "en",
      contact: {
        name: "Jane Doe",
        email: "jane@example.com",
        phone: "+1-555-0100",
        location: "San Francisco, CA",
        website: "https://janedoe.dev",
        linkedin: "https://linkedin.com/in/janedoe"
      },
      summary: "Experienced software engineer with expertise in distributed systems.",
      experience: [
        {
          company: "Acme Corp",
          title: "Senior Engineer",
          start_date: "2021-03",
          end_date: "present",
          location: "Remote",
          bullets: ["Led platform migration.", "Reduced latency by 40%."]
        }
      ],
      education: [
        {
          institution: "MIT",
          degree: "B.S.",
          field: "Computer Science",
          start_date: "2014-09",
          end_date: "2018-06",
          gpa: "3.8"
        }
      ],
      skills: {
        technical: ["React", "Node.js", "GraphQL"],
        languages: ["TypeScript", "Python"],
        tools: ["Docker", "AWS", "GitHub Actions"]
      },
      projects: [
        {
          name: "OpenMetrics",
          description: "Open-source metrics aggregator.",
          url: "https://github.com/janedoe/openmetrics",
          bullets: ["Built the core aggregation pipeline."]
        }
      ],
      certifications: [
        {
          name: "AWS Solutions Architect",
          issuer: "Amazon",
          date: "2023-04"
        }
      ]
    },
    strength_keywords: [
      "Distributed Systems",
      "TypeScript",
      "System Design",
      "Technical Leadership"
    ],
    display_axes: [
      {
        label: "Full-Stack Engineer",
        tagline: "Builds end-to-end features from database to UI.",
        highlight_skills: ["React", "Node.js", "TypeScript"]
      },
      {
        label: "Backend Specialist",
        tagline: "Designs reliable, scalable backend services.",
        highlight_skills: ["GraphQL", "Docker", "AWS"]
      }
    ],
    ...overrides
  };
}

/** Minimal valid input to normalizeBootstrapResult. */
function makeInput(overrides = {}) {
  return { pdfText: "some pdf text", source: "pdf", ...overrides };
}

// ─── generateResumeFromText — error paths ─────────────────────────────────────

describe("generateResumeFromText", () => {
  let savedApiKey;
  let savedDisable;

  before(() => {
    savedApiKey = process.env.OPENAI_API_KEY;
    savedDisable = process.env.WORK_LOG_DISABLE_OPENAI;
  });

  after(() => {
    // Restore original env values
    if (savedApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = savedApiKey;
    }
    if (savedDisable === undefined) {
      delete process.env.WORK_LOG_DISABLE_OPENAI;
    } else {
      process.env.WORK_LOG_DISABLE_OPENAI = savedDisable;
    }
  });

  it("throws when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.WORK_LOG_DISABLE_OPENAI;

    await assert.rejects(
      () => generateResumeFromText({ pdfText: "hello" }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("OPENAI_API_KEY"),
          `Expected message to mention OPENAI_API_KEY, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("throws when WORK_LOG_DISABLE_OPENAI=1", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    process.env.WORK_LOG_DISABLE_OPENAI = "1";

    await assert.rejects(
      () => generateResumeFromText({ pdfText: "hello" }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("disabled"),
          `Expected message to mention 'disabled', got: ${err.message}`
        );
        return true;
      }
    );

    delete process.env.WORK_LOG_DISABLE_OPENAI;
  });
});

// ─── deriveSource ──────────────────────────────────────────────────────────────

describe("deriveSource", () => {
  it("returns 'pdf' when only pdfText is provided", () => {
    assert.equal(deriveSource({ pdfText: "some text" }), "pdf");
  });

  it("returns 'pdf' when linkedinText is empty string", () => {
    assert.equal(deriveSource({ pdfText: "text", linkedinText: "" }), "pdf");
  });

  it("returns 'pdf' when linkedinText is whitespace only", () => {
    assert.equal(deriveSource({ pdfText: "text", linkedinText: "   " }), "pdf");
  });

  it("returns 'linkedin' when only linkedinText is provided (no pdfText)", () => {
    assert.equal(deriveSource({ linkedinText: "linkedin profile" }), "linkedin");
  });

  it("returns 'linkedin' when only linkedinData is provided", () => {
    assert.equal(deriveSource({ linkedinData: { name: "Jane" } }), "linkedin");
  });

  it("returns 'pdf+linkedin' when both pdfText and linkedinText are provided", () => {
    assert.equal(
      deriveSource({ pdfText: "resume text", linkedinText: "profile text" }),
      "pdf+linkedin"
    );
  });

  it("returns 'pdf+linkedin' when pdfText and linkedinData are both present", () => {
    assert.equal(
      deriveSource({ pdfText: "resume text", linkedinData: { name: "Jane" } }),
      "pdf+linkedin"
    );
  });

  it("returns 'pdf' for empty input", () => {
    assert.equal(deriveSource({}), "pdf");
  });

  it("returns 'pdf' when pdfText is empty string and no linkedin", () => {
    assert.equal(deriveSource({ pdfText: "" }), "pdf");
  });
});

// ─── buildUserMessage ─────────────────────────────────────────────────────────

describe("buildUserMessage", () => {
  it("includes PDF text section header", () => {
    const msg = buildUserMessage({ pdfText: "My resume content" });
    assert.ok(msg.includes("=== PDF RESUME TEXT ==="));
    assert.ok(msg.includes("My resume content"));
  });

  it("shows (empty) when pdfText is empty", () => {
    const msg = buildUserMessage({ pdfText: "" });
    assert.ok(msg.includes("(empty)"));
  });

  it("truncates pdfText to 15000 characters and adds truncation notice", () => {
    const longText = "A".repeat(20_000);
    const msg = buildUserMessage({ pdfText: longText });
    // Should contain truncation message
    assert.ok(msg.includes("truncated"), `Expected truncation notice in: ${msg.slice(0, 200)}`);
    // The PDF section should not be longer than 15000 chars
    const pdfSectionStart = msg.indexOf("=== PDF RESUME TEXT ===") + "=== PDF RESUME TEXT ===\n".length;
    const pdfContent = msg.slice(pdfSectionStart, pdfSectionStart + 15_001);
    assert.ok(pdfContent.length <= 15_001);
  });

  it("does not add truncation notice when pdfText is within limit", () => {
    const shortText = "A".repeat(100);
    const msg = buildUserMessage({ pdfText: shortText });
    assert.ok(!msg.includes("truncated"));
  });

  it("includes LinkedIn structured data section when linkedinData is provided", () => {
    const msg = buildUserMessage({
      pdfText: "resume",
      linkedinData: { name: "Jane", title: "Engineer" }
    });
    assert.ok(msg.includes("=== LINKEDIN STRUCTURED DATA ==="));
    assert.ok(msg.includes('"name"'));
    assert.ok(msg.includes("Jane"));
  });

  it("includes LinkedIn text section when linkedinText is provided (no linkedinData)", () => {
    const msg = buildUserMessage({
      pdfText: "resume",
      linkedinText: "Jane Doe · Senior Engineer at Acme"
    });
    assert.ok(msg.includes("=== LINKEDIN PROFILE TEXT ==="));
    assert.ok(msg.includes("Senior Engineer at Acme"));
  });

  it("prefers linkedinData over linkedinText when both are provided", () => {
    const msg = buildUserMessage({
      pdfText: "resume",
      linkedinData: { name: "Jane" },
      linkedinText: "Jane Doe profile text"
    });
    assert.ok(msg.includes("=== LINKEDIN STRUCTURED DATA ==="));
    assert.ok(!msg.includes("=== LINKEDIN PROFILE TEXT ==="));
  });

  it("does not include LinkedIn section when neither linkedinData nor linkedinText is present", () => {
    const msg = buildUserMessage({ pdfText: "resume text" });
    assert.ok(!msg.includes("LINKEDIN"));
  });

  it("truncates LinkedIn JSON to 6000 chars and adds truncation notice", () => {
    // Create a large object that serializes to more than 6000 chars
    const largeData = { items: Array.from({ length: 500 }, (_, i) => ({ key: `value_${i}` })) };
    const msg = buildUserMessage({ pdfText: "pdf", linkedinData: largeData });
    assert.ok(msg.includes("=== LINKEDIN STRUCTURED DATA ==="));
    assert.ok(msg.includes("[... truncated ...]"));
  });

  it("truncates LinkedIn text to 3000 chars and adds truncation notice", () => {
    const longText = "B".repeat(4_000);
    const msg = buildUserMessage({ pdfText: "pdf", linkedinText: longText });
    assert.ok(msg.includes("=== LINKEDIN PROFILE TEXT ==="));
    assert.ok(msg.includes("[... truncated ...]"));
  });
});

// ─── normalizeLanguageCode ────────────────────────────────────────────────────

describe("normalizeLanguageCode", () => {
  it("returns 'en' for empty string", () => {
    assert.equal(normalizeLanguageCode(""), "en");
  });

  it("returns 'en' for undefined", () => {
    assert.equal(normalizeLanguageCode(undefined), "en");
  });

  it("returns 'en' for null", () => {
    assert.equal(normalizeLanguageCode(null), "en");
  });

  it("lowercases the code", () => {
    assert.equal(normalizeLanguageCode("EN"), "en");
    assert.equal(normalizeLanguageCode("Ko"), "ko");
  });

  it("trims whitespace", () => {
    assert.equal(normalizeLanguageCode("  en  "), "en");
  });

  it("passes through valid 2-letter codes", () => {
    assert.equal(normalizeLanguageCode("ko"), "ko");
    assert.equal(normalizeLanguageCode("ja"), "ja");
    assert.equal(normalizeLanguageCode("fr"), "fr");
  });

  it("truncates to 5 chars max (handles longer tags like 'zh-CN')", () => {
    assert.equal(normalizeLanguageCode("zh-CN"), "zh-cn");
    const long = "en-US-extra";
    assert.equal(normalizeLanguageCode(long).length, 5);
  });
});

// ─── normalizeContact ─────────────────────────────────────────────────────────

describe("normalizeContact", () => {
  it("returns empty contact for null input", () => {
    const contact = normalizeContact(null);
    assert.equal(contact.name, "");
    assert.equal(contact.email, null);
    assert.equal(contact.phone, null);
    assert.equal(contact.location, null);
    assert.equal(contact.website, null);
    assert.equal(contact.linkedin, null);
  });

  it("returns empty contact for undefined input", () => {
    const contact = normalizeContact(undefined);
    assert.equal(contact.name, "");
  });

  it("trims whitespace from name", () => {
    const contact = normalizeContact({ name: "  Jane Doe  ", email: null, phone: null, location: null, website: null, linkedin: null });
    assert.equal(contact.name, "Jane Doe");
  });

  it("converts empty email string to null", () => {
    const contact = normalizeContact({ name: "Jane", email: "", phone: null, location: null, website: null, linkedin: null });
    assert.equal(contact.email, null);
  });

  it("preserves non-empty email", () => {
    const contact = normalizeContact({ name: "Jane", email: "jane@example.com", phone: null, location: null, website: null, linkedin: null });
    assert.equal(contact.email, "jane@example.com");
  });

  it("converts whitespace-only phone to null", () => {
    const contact = normalizeContact({ name: "Jane", email: null, phone: "   ", location: null, website: null, linkedin: null });
    assert.equal(contact.phone, null);
  });

  it("preserves all fields in a full contact object", () => {
    const raw = {
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "+1-555-0100",
      location: "San Francisco",
      website: "https://jane.dev",
      linkedin: "https://linkedin.com/in/jane"
    };
    const contact = normalizeContact(raw);
    assert.equal(contact.name, "Jane Doe");
    assert.equal(contact.email, "jane@example.com");
    assert.equal(contact.phone, "+1-555-0100");
    assert.equal(contact.location, "San Francisco");
    assert.equal(contact.website, "https://jane.dev");
    assert.equal(contact.linkedin, "https://linkedin.com/in/jane");
  });
});

// ─── normalizeExperience ──────────────────────────────────────────────────────

describe("normalizeExperience", () => {
  it("returns empty array for null", () => {
    assert.deepEqual(normalizeExperience(null), []);
  });

  it("returns empty array for non-array", () => {
    assert.deepEqual(normalizeExperience("string"), []);
    assert.deepEqual(normalizeExperience(42), []);
  });

  it("filters out items without company", () => {
    const arr = [{ title: "Engineer" }, { company: "Acme", title: "SWE", bullets: [] }];
    const result = normalizeExperience(arr);
    assert.equal(result.length, 1);
    assert.equal(result[0].company, "Acme");
  });

  it("adds _source: 'system' when _source is absent", () => {
    const arr = [{ company: "Acme", title: "SWE", bullets: [] }];
    const result = normalizeExperience(arr);
    assert.equal(result[0]._source, "system");
  });

  it("preserves _source: 'user' from input", () => {
    const arr = [{ company: "Acme", title: "SWE", _source: "user", bullets: [] }];
    const result = normalizeExperience(arr);
    assert.equal(result[0]._source, "user");
  });

  it("preserves _source: 'user_approved' from input", () => {
    const arr = [{ company: "Acme", title: "SWE", _source: "user_approved", bullets: [] }];
    const result = normalizeExperience(arr);
    assert.equal(result[0]._source, "user_approved");
  });

  it("resets unknown _source values to 'system'", () => {
    const arr = [{ company: "Acme", title: "SWE", _source: "unknown", bullets: [] }];
    const result = normalizeExperience(arr);
    assert.equal(result[0]._source, "system");
  });

  it("normalizes nullable date fields to null when empty", () => {
    const arr = [{ company: "Acme", title: "SWE", start_date: "", end_date: "", location: "", bullets: [] }];
    const result = normalizeExperience(arr);
    assert.equal(result[0].start_date, null);
    assert.equal(result[0].end_date, null);
    assert.equal(result[0].location, null);
  });

  it("preserves valid dates as-is", () => {
    const arr = [{ company: "Acme", title: "SWE", start_date: "2021-03", end_date: "present", bullets: [] }];
    const result = normalizeExperience(arr);
    assert.equal(result[0].start_date, "2021-03");
    assert.equal(result[0].end_date, "present");
  });

  it("caps bullets at 8 items and trims", () => {
    const bullets = Array.from({ length: 12 }, (_, i) => `  Bullet ${i}.  `);
    const arr = [{ company: "Acme", title: "SWE", bullets }];
    const result = normalizeExperience(arr);
    assert.equal(result[0].bullets.length, 8);
    assert.ok(result[0].bullets[0].startsWith("Bullet 0."));
  });

  it("handles missing bullets (defaults to empty array)", () => {
    const arr = [{ company: "Acme", title: "SWE" }];
    const result = normalizeExperience(arr);
    assert.deepEqual(result[0].bullets, []);
  });
});

// ─── normalizeEducation ───────────────────────────────────────────────────────

describe("normalizeEducation", () => {
  it("returns empty array for null", () => {
    assert.deepEqual(normalizeEducation(null), []);
  });

  it("filters out items without institution", () => {
    const arr = [{ degree: "B.S." }, { institution: "MIT", degree: "B.S." }];
    const result = normalizeEducation(arr);
    assert.equal(result.length, 1);
    assert.equal(result[0].institution, "MIT");
  });

  it("adds _source: 'system' by default", () => {
    const arr = [{ institution: "MIT" }];
    assert.equal(normalizeEducation(arr)[0]._source, "system");
  });

  it("preserves _source: 'user'", () => {
    const arr = [{ institution: "MIT", _source: "user" }];
    assert.equal(normalizeEducation(arr)[0]._source, "user");
  });

  it("converts empty degree/field/gpa to null", () => {
    const arr = [{ institution: "MIT", degree: "", field: "", gpa: "" }];
    const result = normalizeEducation(arr);
    assert.equal(result[0].degree, null);
    assert.equal(result[0].field, null);
    assert.equal(result[0].gpa, null);
  });

  it("preserves non-null gpa", () => {
    const arr = [{ institution: "MIT", gpa: "3.9" }];
    assert.equal(normalizeEducation(arr)[0].gpa, "3.9");
  });
});

// ─── normalizeSkills ──────────────────────────────────────────────────────────

describe("normalizeSkills", () => {
  it("returns empty skill categories for null", () => {
    const skills = normalizeSkills(null);
    assert.deepEqual(skills, { technical: [], languages: [], tools: [] });
  });

  it("returns empty skill categories for undefined", () => {
    const skills = normalizeSkills(undefined);
    assert.deepEqual(skills, { technical: [], languages: [], tools: [] });
  });

  it("normalizes valid skills object", () => {
    const raw = {
      technical: ["React", "GraphQL"],
      languages: ["TypeScript", "Python"],
      tools: ["Docker"]
    };
    const skills = normalizeSkills(raw);
    assert.deepEqual(skills.technical, ["React", "GraphQL"]);
    assert.deepEqual(skills.languages, ["TypeScript", "Python"]);
    assert.deepEqual(skills.tools, ["Docker"]);
  });

  it("handles missing subcategories gracefully", () => {
    const raw = { technical: ["React"] };
    const skills = normalizeSkills(raw);
    assert.deepEqual(skills.technical, ["React"]);
    assert.deepEqual(skills.languages, []);
    assert.deepEqual(skills.tools, []);
  });

  it("caps technical and tools at 30 items", () => {
    const raw = {
      technical: Array.from({ length: 40 }, (_, i) => `Tech${i}`),
      languages: [],
      tools: Array.from({ length: 35 }, (_, i) => `Tool${i}`)
    };
    const skills = normalizeSkills(raw);
    assert.equal(skills.technical.length, 30);
    assert.equal(skills.tools.length, 30);
  });

  it("caps languages at 20 items", () => {
    const raw = {
      technical: [],
      languages: Array.from({ length: 25 }, (_, i) => `Lang${i}`),
      tools: []
    };
    const skills = normalizeSkills(raw);
    assert.equal(skills.languages.length, 20);
  });

  it("filters empty strings from skill arrays", () => {
    const raw = { technical: ["React", "", "  ", "Node.js"], languages: [], tools: [] };
    const skills = normalizeSkills(raw);
    assert.deepEqual(skills.technical, ["React", "Node.js"]);
  });
});

// ─── normalizeProjects ────────────────────────────────────────────────────────

describe("normalizeProjects", () => {
  it("returns empty array for null", () => {
    assert.deepEqual(normalizeProjects(null), []);
  });

  it("filters items without name", () => {
    const arr = [{ description: "No name" }, { name: "MyProject", description: "Good" }];
    assert.equal(normalizeProjects(arr).length, 1);
  });

  it("adds _source: 'system' by default", () => {
    const arr = [{ name: "Project", description: null, url: null, bullets: [] }];
    assert.equal(normalizeProjects(arr)[0]._source, "system");
  });

  it("preserves _source: 'user'", () => {
    const arr = [{ name: "Project", _source: "user", bullets: [] }];
    assert.equal(normalizeProjects(arr)[0]._source, "user");
  });

  it("converts empty description and url to null", () => {
    const arr = [{ name: "Project", description: "", url: "" }];
    const result = normalizeProjects(arr);
    assert.equal(result[0].description, null);
    assert.equal(result[0].url, null);
  });

  it("caps bullets at 6 items", () => {
    const arr = [{ name: "Proj", bullets: Array.from({ length: 10 }, (_, i) => `Bullet ${i}.`) }];
    assert.equal(normalizeProjects(arr)[0].bullets.length, 6);
  });
});

// ─── normalizeCertifications ──────────────────────────────────────────────────

describe("normalizeCertifications", () => {
  it("returns empty array for null", () => {
    assert.deepEqual(normalizeCertifications(null), []);
  });

  it("filters items without name", () => {
    const arr = [{ issuer: "Amazon" }, { name: "AWS SAA", issuer: "Amazon", date: "2023-04" }];
    assert.equal(normalizeCertifications(arr).length, 1);
  });

  it("adds _source: 'system' by default", () => {
    const arr = [{ name: "CKA" }];
    assert.equal(normalizeCertifications(arr)[0]._source, "system");
  });

  it("converts empty issuer and date to null", () => {
    const arr = [{ name: "CKA", issuer: "", date: "" }];
    const result = normalizeCertifications(arr);
    assert.equal(result[0].issuer, null);
    assert.equal(result[0].date, null);
  });
});

// ─── normalizeDisplayAxes ─────────────────────────────────────────────────────

describe("normalizeDisplayAxes", () => {
  it("returns empty array for null", () => {
    assert.deepEqual(normalizeDisplayAxes(null), []);
  });

  it("returns empty array for non-array", () => {
    assert.deepEqual(normalizeDisplayAxes("string"), []);
  });

  it("filters items missing label or tagline", () => {
    const arr = [
      { tagline: "Only tagline" },
      { label: "Only label" },
      { label: "Full Axis", tagline: "Complete axis with both fields.", highlight_skills: [] }
    ];
    const result = normalizeDisplayAxes(arr);
    assert.equal(result.length, 1);
    assert.equal(result[0].label, "Full Axis");
  });

  it("caps at 4 axes", () => {
    const arr = Array.from({ length: 6 }, (_, i) => ({
      label: `Axis ${i}`,
      tagline: `Tagline for axis ${i}.`,
      highlight_skills: []
    }));
    assert.equal(normalizeDisplayAxes(arr).length, 4);
  });

  it("trims label and tagline whitespace", () => {
    const arr = [{ label: "  Backend  ", tagline: "  Great backend skills.  ", highlight_skills: [] }];
    const result = normalizeDisplayAxes(arr);
    assert.equal(result[0].label, "Backend");
    assert.equal(result[0].tagline, "Great backend skills.");
  });

  it("caps highlight_skills at 6 items", () => {
    const arr = [{
      label: "Engineer",
      tagline: "Tagline.",
      highlight_skills: ["A", "B", "C", "D", "E", "F", "G", "H"]
    }];
    assert.equal(normalizeDisplayAxes(arr)[0].highlight_skills.length, 6);
  });

  it("handles missing highlight_skills (defaults to empty array)", () => {
    const arr = [{ label: "Engineer", tagline: "Tagline." }];
    assert.deepEqual(normalizeDisplayAxes(arr)[0].highlight_skills, []);
  });
});

// ─── normalizeStringArray ─────────────────────────────────────────────────────

describe("normalizeStringArray", () => {
  it("returns empty array for null", () => {
    assert.deepEqual(normalizeStringArray(null), []);
  });

  it("returns empty array for undefined", () => {
    assert.deepEqual(normalizeStringArray(undefined), []);
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(normalizeStringArray("string"), []);
    assert.deepEqual(normalizeStringArray(42), []);
  });

  it("trims whitespace from each string", () => {
    assert.deepEqual(normalizeStringArray(["  hello  ", "\tworld\n"]), ["hello", "world"]);
  });

  it("removes empty strings", () => {
    assert.deepEqual(normalizeStringArray(["a", "", "  ", "b"]), ["a", "b"]);
  });

  it("converts non-string elements to strings", () => {
    const result = normalizeStringArray([42, true, "hello"]);
    assert.equal(result[0], "42");
    assert.equal(result[1], "true");
    assert.equal(result[2], "hello");
  });

  it("uses default maxItemLength of 200", () => {
    const long = "A".repeat(250);
    const result = normalizeStringArray([long]);
    assert.equal(result[0].length, 200);
  });

  it("respects custom maxItemLength", () => {
    const long = "A".repeat(100);
    const result = normalizeStringArray([long], 50);
    assert.equal(result[0].length, 50);
  });

  it("uses default maxItems of 20", () => {
    const arr = Array.from({ length: 25 }, (_, i) => `item${i}`);
    assert.equal(normalizeStringArray(arr).length, 20);
  });

  it("respects custom maxItems", () => {
    const arr = Array.from({ length: 10 }, (_, i) => `item${i}`);
    assert.equal(normalizeStringArray(arr, 200, 5).length, 5);
  });

  it("applies length cap before item count cap", () => {
    const arr = Array.from({ length: 10 }, (_, i) => "A".repeat(100));
    const result = normalizeStringArray(arr, 30, 5);
    assert.equal(result.length, 5);
    assert.ok(result.every((s) => s.length === 30));
  });
});

// ─── normalizeBootstrapResult ─────────────────────────────────────────────────

describe("normalizeBootstrapResult", () => {
  it("returns { resumeData, strengthKeywords, displayAxes }", () => {
    const result = normalizeBootstrapResult(makeParsedOutput(), makeInput());
    assert.ok("resumeData" in result, "missing resumeData");
    assert.ok("strengthKeywords" in result, "missing strengthKeywords");
    assert.ok("displayAxes" in result, "missing displayAxes");
  });

  it("resumeData.meta has required fields", () => {
    const result = normalizeBootstrapResult(makeParsedOutput(), makeInput({ source: "pdf" }));
    const { meta } = result.resumeData;
    assert.equal(meta.source, "pdf");
    assert.equal(meta.schemaVersion, 1);
    assert.equal(typeof meta.generatedAt, "string");
    assert.ok(meta.generatedAt.length > 0);
    assert.equal(typeof meta.language, "string");
  });

  it("resumeData.meta.language is normalized from LLM output", () => {
    const parsed = makeParsedOutput();
    parsed.resume.language = "KO";
    const result = normalizeBootstrapResult(parsed, makeInput());
    assert.equal(result.resumeData.meta.language, "ko");
  });

  it("resumeData._sources has system provenance for new bootstrap", () => {
    const result = normalizeBootstrapResult(makeParsedOutput(), makeInput());
    assert.equal(result.resumeData._sources.summary, "system");
    assert.equal(result.resumeData._sources.contact, "system");
    assert.equal(result.resumeData._sources.skills, "system");
  });

  it("deriveSource is called when input.source is not explicitly set", () => {
    const input = { pdfText: "text", linkedinText: "linkedin" };
    const result = normalizeBootstrapResult(makeParsedOutput(), input);
    assert.equal(result.resumeData.meta.source, "pdf+linkedin");
  });

  it("resumeData.summary is trimmed", () => {
    const parsed = makeParsedOutput();
    parsed.resume.summary = "  Great engineer.  ";
    const result = normalizeBootstrapResult(parsed, makeInput());
    assert.equal(result.resumeData.summary, "Great engineer.");
  });

  it("resumeData.summary is empty string when missing from LLM output", () => {
    const parsed = makeParsedOutput();
    delete parsed.resume.summary;
    const result = normalizeBootstrapResult(parsed, makeInput());
    assert.equal(result.resumeData.summary, "");
  });

  it("strengthKeywords is an array of non-empty strings", () => {
    const result = normalizeBootstrapResult(makeParsedOutput(), makeInput());
    assert.ok(Array.isArray(result.strengthKeywords));
    assert.ok(result.strengthKeywords.every((k) => typeof k === "string" && k.length > 0));
  });

  it("strengthKeywords caps at 15 items and 40 chars each", () => {
    const parsed = makeParsedOutput();
    parsed.strength_keywords = Array.from({ length: 20 }, (_, i) => `Keyword ${"X".repeat(50)} ${i}`);
    const result = normalizeBootstrapResult(parsed, makeInput());
    assert.equal(result.strengthKeywords.length, 15);
    assert.ok(result.strengthKeywords.every((k) => k.length <= 40));
  });

  it("strengthKeywords is empty array when missing from parsed", () => {
    const parsed = makeParsedOutput();
    delete parsed.strength_keywords;
    const result = normalizeBootstrapResult(parsed, makeInput());
    assert.deepEqual(result.strengthKeywords, []);
  });

  it("displayAxes is an array", () => {
    const result = normalizeBootstrapResult(makeParsedOutput(), makeInput());
    assert.ok(Array.isArray(result.displayAxes));
  });

  it("displayAxes items have { label, tagline, highlight_skills }", () => {
    const result = normalizeBootstrapResult(makeParsedOutput(), makeInput());
    for (const axis of result.displayAxes) {
      assert.ok("label" in axis);
      assert.ok("tagline" in axis);
      assert.ok(Array.isArray(axis.highlight_skills));
    }
  });

  it("displayAxes is empty when missing from parsed", () => {
    const parsed = makeParsedOutput();
    delete parsed.display_axes;
    const result = normalizeBootstrapResult(parsed, makeInput());
    assert.deepEqual(result.displayAxes, []);
  });

  it("handles missing resume block in parsed output gracefully", () => {
    const result = normalizeBootstrapResult({}, makeInput());
    assert.ok(result.resumeData.meta);
    assert.equal(result.resumeData.summary, "");
    assert.deepEqual(result.resumeData.experience, []);
    assert.deepEqual(result.resumeData.education, []);
    assert.deepEqual(result.strengthKeywords, []);
    assert.deepEqual(result.displayAxes, []);
  });

  it("full round-trip: standard LLM output → BootstrapResult shape", () => {
    const parsed = makeParsedOutput();
    const input = makeInput({ source: "pdf+linkedin" });
    const result = normalizeBootstrapResult(parsed, input);

    // meta
    assert.equal(result.resumeData.meta.language, "en");
    assert.equal(result.resumeData.meta.source, "pdf+linkedin");
    assert.equal(result.resumeData.meta.schemaVersion, 1);

    // contact
    assert.equal(result.resumeData.contact.name, "Jane Doe");
    assert.equal(result.resumeData.contact.email, "jane@example.com");

    // summary
    assert.ok(result.resumeData.summary.length > 0);

    // experience
    assert.equal(result.resumeData.experience.length, 1);
    assert.equal(result.resumeData.experience[0].company, "Acme Corp");
    assert.equal(result.resumeData.experience[0]._source, "system");

    // education
    assert.equal(result.resumeData.education.length, 1);
    assert.equal(result.resumeData.education[0].institution, "MIT");

    // skills
    assert.ok(result.resumeData.skills.technical.includes("React"));
    assert.ok(result.resumeData.skills.languages.includes("TypeScript"));

    // projects
    assert.equal(result.resumeData.projects.length, 1);
    assert.equal(result.resumeData.projects[0].name, "OpenMetrics");

    // certifications
    assert.equal(result.resumeData.certifications.length, 1);
    assert.equal(result.resumeData.certifications[0].name, "AWS Solutions Architect");

    // strengthKeywords
    assert.ok(result.strengthKeywords.length >= 2);
    assert.ok(result.strengthKeywords.includes("TypeScript"));

    // displayAxes
    assert.equal(result.displayAxes.length, 2);
    assert.equal(result.displayAxes[0].label, "Full-Stack Engineer");
    assert.ok(result.displayAxes[0].highlight_skills.includes("React"));
  });

  it("Korean resume preserves 'ko' language code", () => {
    const parsed = makeParsedOutput();
    parsed.resume.language = "ko";
    parsed.resume.summary = "다양한 경험을 가진 소프트웨어 엔지니어입니다.";
    const result = normalizeBootstrapResult(parsed, makeInput());
    assert.equal(result.resumeData.meta.language, "ko");
    assert.ok(result.resumeData.summary.includes("소프트웨어"));
  });
});
