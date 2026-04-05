/**
 * Resume Bootstrap — LLM generation service.
 *
 * Takes extracted text (PDF + optional LinkedIn) and generates, via a SINGLE
 * LLM call, three outputs concurrently:
 *   1. resumeData   — structured resume JSON (fixed minimal-section schema)
 *   2. strengthKeywords — initial list of marketable skill/trait keywords
 *   3. displayAxes  — 2-4 career-narrative lenses for presenting the resume
 *
 * The generated content language follows the source document's language.
 *
 * Environment variables:
 *   OPENAI_API_KEY           — required (same key as openai.mjs)
 *   WORK_LOG_OPENAI_URL      — optional override (default: /v1/responses)
 *   WORK_LOG_OPENAI_MODEL    — optional override (default: gpt-5.4-mini)
 *   WORK_LOG_DISABLE_OPENAI  — set "1" to disable (throws instead of calling API)
 *
 * Resume JSON fixed sections (Day 1, no custom sections):
 *   meta · contact · summary · experience · education · skills · projects · certifications
 */

import {
  buildFullVoiceBlock,
  normalizeVoice,
  normalizeBullets,
} from "./resumeVoice.mjs";

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

// ---------------------------------------------------------------------------
// Input length limits (characters, not tokens)
// These guard against very large PDFs and LinkedIn payloads that would
// exceed the model's context window or inflate API costs.
// ---------------------------------------------------------------------------
/** Max chars of PDF text forwarded to the LLM (~10–15 pages of dense text). */
const PDF_TEXT_LIMIT = 15_000;
/** Max chars of LinkedIn structured JSON forwarded to the LLM. */
const LINKEDIN_JSON_LIMIT = 6_000;
/** Max chars of LinkedIn pasted text forwarded to the LLM. */
const LINKEDIN_TEXT_LIMIT = 3_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a structured resume document, strength keywords, and display axes
 * from previously-extracted text using a single LLM call.
 *
 * @param {Object} input
 * @param {string}  input.pdfText       Extracted plain text from the uploaded PDF resume.
 * @param {string}  [input.linkedinText] Optional LinkedIn profile text (paste fallback).
 * @param {Object}  [input.linkedinData] Optional structured LinkedIn profile data
 *                                       (from the /api/resume/linkedin route).
 * @param {string}  [input.source]       Source tag for meta ("pdf" | "pdf+linkedin" |
 *                                       "linkedin"). Defaults to "pdf".
 * @returns {Promise<BootstrapResult>}
 * @throws {Error} If the API key is missing, the API call fails, or the output
 *                 cannot be parsed.
 */
export async function generateResumeFromText(input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set — cannot generate resume from text"
    );
  }
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    throw new Error(
      "OpenAI integration is disabled (WORK_LOG_DISABLE_OPENAI=1)"
    );
  }

  const pdfLen = (input.pdfText || "").length;
  const hasLinkedin = Boolean(
    (input.linkedinData && typeof input.linkedinData === "object") ||
    (input.linkedinText && input.linkedinText.trim())
  );
  console.info(
    `[resumeBootstrap] Calling LLM: model=${OPENAI_MODEL}` +
    ` pdfChars=${pdfLen}` +
    ` linkedin=${hasLinkedin}` +
    ` source=${input.source ?? "pdf"}`
  );

  const payload = buildBootstrapPayload(input);

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Resume bootstrap LLM call failed: ${response.status} ${errorText.slice(0, 400)}`
    );
  }

  const data = await response.json();
  const rawText = data.output_text || extractOutputText(data);
  if (!rawText) {
    throw new Error("Resume bootstrap LLM call returned empty output");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(
      `Resume bootstrap LLM returned non-JSON output: ${rawText.slice(0, 200)}`
    );
  }

  const result = normalizeBootstrapResult(parsed, input);
  console.info(
    `[resumeBootstrap] LLM succeeded:` +
    ` exp=${result.resumeData?.experience?.length ?? 0}` +
    ` keywords=${result.strengthKeywords?.length ?? 0}` +
    ` axes=${result.displayAxes?.length ?? 0}`
  );
  return result;
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

function buildBootstrapPayload(input) {
  return {
    model: OPENAI_MODEL,
    reasoning: {
      effort: "medium"
    },
    text: {
      format: {
        type: "json_schema",
        name: "resume_bootstrap",
        strict: true,
        schema: BOOTSTRAP_OUTPUT_SCHEMA
      }
    },
    max_output_tokens: 8192,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: SYSTEM_PROMPT
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildUserMessage(input)
          }
        ]
      }
    ]
  };
}

export function buildUserMessage(input) {
  const parts = [];

  // ── PDF text ─────────────────────────────────────────────────────────────
  const rawPdf = (input.pdfText || "").trim();
  const pdfSnippet = rawPdf.slice(0, PDF_TEXT_LIMIT);
  parts.push("=== PDF RESUME TEXT ===");
  parts.push(pdfSnippet || "(empty)");
  if (rawPdf.length > PDF_TEXT_LIMIT) {
    parts.push(
      `[... truncated — showing first ${PDF_TEXT_LIMIT.toLocaleString()} of ` +
      `${rawPdf.length.toLocaleString()} characters ...]`
    );
  }

  // ── LinkedIn data (structured preferred over plain text) ─────────────────
  if (input.linkedinData && typeof input.linkedinData === "object") {
    const jsonStr = JSON.stringify(input.linkedinData, null, 2);
    const jsonSnippet = jsonStr.slice(0, LINKEDIN_JSON_LIMIT);
    parts.push("");
    parts.push("=== LINKEDIN STRUCTURED DATA ===");
    parts.push(jsonSnippet);
    if (jsonStr.length > LINKEDIN_JSON_LIMIT) {
      parts.push("[... truncated ...]");
    }
  } else if (input.linkedinText && input.linkedinText.trim()) {
    const rawLinkedin = input.linkedinText.trim();
    const linkedinSnippet = rawLinkedin.slice(0, LINKEDIN_TEXT_LIMIT);
    parts.push("");
    parts.push("=== LINKEDIN PROFILE TEXT ===");
    parts.push(linkedinSnippet);
    if (rawLinkedin.length > LINKEDIN_TEXT_LIMIT) {
      parts.push("[... truncated ...]");
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `\
You are an expert resume parser and career coach. Your job is to read raw resume \
text (and optionally LinkedIn profile data) and produce three things in one response:

1. A fully structured resume document (resume)
2. A list of strength keywords (strength_keywords)
3. A set of display axes — distinct career narrative lenses (display_axes)

━━━ RESUME STRUCTURE RULES ━━━
• contact: Extract name, email, phone, location, website, linkedin URL. Use null for \
  any field not found.
• summary: Write a 2–4 sentence professional summary that captures the person's \
  career level, core expertise, and key value proposition. If the source already has \
  a strong summary, refine it; otherwise synthesize one from the experience section. \
  Use the same language as the source.
• experience: List in reverse-chronological order. For each role:
    - start_date / end_date: YYYY-MM format when determinable; "present" for current \
      roles; null if not found.
    - bullets: 2–5 achievement-oriented bullets per role. Quantify results whenever \
      the source provides numbers.
• education: List in reverse-chronological order. gpa: include only if explicitly \
  stated; otherwise null.
• skills:
    - technical: Frameworks, libraries, paradigms, architectural patterns (e.g. React, \
      GraphQL, microservices).
    - languages: Programming/scripting languages only (e.g. TypeScript, Python, SQL).
    - tools: Dev tools, platforms, cloud services, CI/CD (e.g. Docker, AWS, GitHub Actions).
    Keep lists deduplicated and sorted roughly by relevance.
• projects: Side projects, open-source contributions, notable internal tools. Omit if \
  none found in source (return empty array).
• certifications: Professional certifications only. Omit if none (return empty array).

━━━ STRENGTH KEYWORDS RULES ━━━
• 5–15 short strings that represent the person's most marketable skills and traits.
• Mix hard skills (specific technologies) and soft/meta skills (e.g. "System Design", \
  "Technical Leadership", "Cross-functional Collaboration").
• These are shown as filter tags on the resume; keep each keyword under 40 characters.

━━━ DISPLAY AXES RULES ━━━
• 2–4 distinct career narrative lenses for how this resume can be positioned.
• Each axis has:
    - label: Short title for the angle (e.g. "Full-Stack Engineer", \
      "Frontend Specialist", "Engineering Manager").
    - tagline: One sentence describing what makes this person compelling from this \
      angle. Same language as the source.
    - highlight_skills: 3–6 skills from the resume that are most relevant to this axis.
• Axes should be meaningfully different — not just synonym labels.

${buildFullVoiceBlock(["bullet", "summary", "keyword", "displayAxisLabel", "displayAxisTagline"])}`;

// ---------------------------------------------------------------------------
// JSON Schema for structured output
// ---------------------------------------------------------------------------

/**
 * Strict JSON Schema consumed by the OpenAI Responses API (format.type = "json_schema").
 *
 * All nested objects carry additionalProperties: false and fully populated
 * required arrays, as mandated by the strict mode contract.
 *
 * Nullable optional fields use ["string", "null"] union types.
 */
const BOOTSTRAP_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["resume", "strength_keywords", "display_axes"],
  properties: {
    // ── 1. Structured resume document ──────────────────────────────────────
    resume: {
      type: "object",
      additionalProperties: false,
      required: [
        "language",
        "contact",
        "summary",
        "experience",
        "education",
        "skills",
        "projects",
        "certifications"
      ],
      properties: {
        /** ISO 639-1 language code detected from the source text. */
        language: { type: "string" },

        contact: {
          type: "object",
          additionalProperties: false,
          required: ["name", "email", "phone", "location", "website", "linkedin"],
          properties: {
            name: { type: "string" },
            email: { type: ["string", "null"] },
            phone: { type: ["string", "null"] },
            location: { type: ["string", "null"] },
            website: { type: ["string", "null"] },
            linkedin: { type: ["string", "null"] }
          }
        },

        /** 2-4 sentence professional summary in the source language. */
        summary: { type: "string" },

        experience: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "company",
              "title",
              "start_date",
              "end_date",
              "location",
              "bullets"
            ],
            properties: {
              company: { type: "string" },
              title: { type: "string" },
              /** YYYY-MM or null */
              start_date: { type: ["string", "null"] },
              /** YYYY-MM, "present", or null */
              end_date: { type: ["string", "null"] },
              location: { type: ["string", "null"] },
              bullets: {
                type: "array",
                items: { type: "string" }
              }
            }
          }
        },

        education: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "institution",
              "degree",
              "field",
              "start_date",
              "end_date",
              "gpa"
            ],
            properties: {
              institution: { type: "string" },
              degree: { type: ["string", "null"] },
              field: { type: ["string", "null"] },
              start_date: { type: ["string", "null"] },
              end_date: { type: ["string", "null"] },
              gpa: { type: ["string", "null"] }
            }
          }
        },

        skills: {
          type: "object",
          additionalProperties: false,
          required: ["technical", "languages", "tools"],
          properties: {
            /** Frameworks, libraries, patterns */
            technical: { type: "array", items: { type: "string" } },
            /** Programming / scripting languages */
            languages: { type: "array", items: { type: "string" } },
            /** Dev tools, platforms, cloud services */
            tools: { type: "array", items: { type: "string" } }
          }
        },

        projects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "description", "url", "bullets"],
            properties: {
              name: { type: "string" },
              description: { type: ["string", "null"] },
              url: { type: ["string", "null"] },
              bullets: {
                type: "array",
                items: { type: "string" }
              }
            }
          }
        },

        certifications: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "issuer", "date"],
            properties: {
              name: { type: "string" },
              issuer: { type: ["string", "null"] },
              /** YYYY-MM or null */
              date: { type: ["string", "null"] }
            }
          }
        }
      }
    },

    // ── 2. Strength keywords ────────────────────────────────────────────────
    /** 5–15 marketable skill/trait keywords. */
    strength_keywords: {
      type: "array",
      items: { type: "string" }
    },

    // ── 3. Display axes ─────────────────────────────────────────────────────
    /** 2–4 distinct career narrative lenses. */
    display_axes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "tagline", "highlight_skills"],
        properties: {
          label: { type: "string" },
          tagline: { type: "string" },
          highlight_skills: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Output normalisation
// ---------------------------------------------------------------------------

/**
 * Merge LLM output with application-level metadata and validate/clean each
 * array section.
 *
 * @param {Object} parsed   Raw JSON parsed from the LLM output string.
 * @param {Object} input    Original input object (provides source tag).
 * @returns {BootstrapResult}
 */
export function normalizeBootstrapResult(parsed, input) {
  const rawResume = parsed.resume || {};
  const source = input.source || deriveSource(input);

  // Build the final stored resume document with application-owned meta.
  // _sources tracks per-scalar-section provenance ("user" | "system").
  // Array items carry their own _source field added by the normalise helpers.
  const resumeData = {
    meta: {
      language: normalizeLanguageCode(rawResume.language),
      source,
      generatedAt: new Date().toISOString(),
      schemaVersion: 1
    },
    _sources: {
      summary: "system",
      contact: "system",
      skills: "system"
    },
    contact: normalizeContact(rawResume.contact),
    summary: normalizeVoice(typeof rawResume.summary === "string" ? rawResume.summary : "", "summary"),
    experience: normalizeExperience(rawResume.experience),
    education: normalizeEducation(rawResume.education),
    skills: normalizeSkills(rawResume.skills),
    projects: normalizeProjects(rawResume.projects),
    certifications: normalizeCertifications(rawResume.certifications)
  };

  const strengthKeywords = normalizeStringArray(
    parsed.strength_keywords,
    40,
    15
  );

  const displayAxes = normalizeDisplayAxes(parsed.display_axes);

  return { resumeData, strengthKeywords, displayAxes };
}

/** Infer source tag from what was provided in input. */
export function deriveSource(input) {
  const hasPdf = Boolean(input.pdfText && input.pdfText.trim());
  const hasLinkedin = Boolean(
    (input.linkedinData && typeof input.linkedinData === "object") ||
    (input.linkedinText && input.linkedinText.trim())
  );
  if (hasPdf && hasLinkedin) return "pdf+linkedin";
  if (hasLinkedin) return "linkedin";
  return "pdf";
}

export function normalizeLanguageCode(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "en";
  // Normalise to lowercase 2-letter ISO 639-1 code.
  return raw.trim().toLowerCase().slice(0, 5);
}

export function normalizeContact(raw) {
  if (!raw || typeof raw !== "object") {
    return { name: "", email: null, phone: null, location: null, website: null, linkedin: null };
  }
  return {
    name: String(raw.name || "").trim(),
    email: nullableString(raw.email),
    phone: nullableString(raw.phone),
    location: nullableString(raw.location),
    website: nullableString(raw.website),
    linkedin: nullableString(raw.linkedin)
  };
}

export function normalizeExperience(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && item.company)
    .map((item) => ({
      _source: _preserveItemSource(item._source),
      company: String(item.company || "").trim(),
      title: String(item.title || "").trim(),
      start_date: nullableString(item.start_date),
      end_date: nullableString(item.end_date),
      location: nullableString(item.location),
      bullets: normalizeBullets(normalizeStringArray(item.bullets, 160, 8))
    }));
}

export function normalizeEducation(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && item.institution)
    .map((item) => ({
      _source: _preserveItemSource(item._source),
      institution: String(item.institution || "").trim(),
      degree: nullableString(item.degree),
      field: nullableString(item.field),
      start_date: nullableString(item.start_date),
      end_date: nullableString(item.end_date),
      gpa: nullableString(item.gpa)
    }));
}

export function normalizeSkills(raw) {
  if (!raw || typeof raw !== "object") {
    return { technical: [], languages: [], tools: [] };
  }
  return {
    technical: normalizeStringArray(raw.technical, 60, 30),
    languages: normalizeStringArray(raw.languages, 40, 20),
    tools: normalizeStringArray(raw.tools, 60, 30)
  };
}

export function normalizeProjects(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && item.name)
    .map((item) => ({
      _source: _preserveItemSource(item._source),
      name: String(item.name || "").trim(),
      description: nullableString(item.description),
      url: nullableString(item.url),
      bullets: normalizeBullets(normalizeStringArray(item.bullets, 160, 6))
    }));
}

export function normalizeCertifications(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && item.name)
    .map((item) => ({
      _source: _preserveItemSource(item._source),
      name: String(item.name || "").trim(),
      issuer: nullableString(item.issuer),
      date: nullableString(item.date)
    }));
}

export function normalizeDisplayAxes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && item.label && item.tagline)
    .slice(0, 4)
    .map((item) => ({
      label: normalizeVoice(String(item.label || ""), "displayAxisLabel"),
      tagline: normalizeVoice(String(item.tagline || ""), "displayAxisTagline"),
      highlight_skills: normalizeStringArray(item.highlight_skills, 60, 6)
    }));
}

/**
 * Normalize an array of strings: ensure each element is a non-empty string,
 * trim whitespace, cap individual length, and cap total count.
 */
export function normalizeStringArray(value, maxItemLength = 200, maxItems = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => item.slice(0, maxItemLength))
    .slice(0, maxItems);
}

/**
 * Preserve the ItemSource value of a resume array item during normalisation.
 *
 * "user" and "user_approved" both represent human-confirmed content and must
 * survive a rebuild/normalise pass unchanged.  Anything else (including
 * undefined, null, or unknown strings) falls back to "system".
 *
 * @param {string|undefined|null} src
 * @returns {"user"|"system"|"user_approved"}
 */
function _preserveItemSource(src) {
  if (src === "user" || src === "user_approved") return src;
  return "system";
}

/** Returns trimmed string or null for falsy/empty values. */
function nullableString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

// ---------------------------------------------------------------------------
// Response extraction helper (mirrors openai.mjs)
// ---------------------------------------------------------------------------

function extractOutputText(data) {
  const outputs = data.output || [];
  const texts = [];
  for (const item of outputs) {
    const content = item?.content || [];
    for (const part of content) {
      if (part?.type === "output_text" && part?.text) {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

// ---------------------------------------------------------------------------
// JSDoc type definitions (for editor intelligence)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ResumeContact
 * @property {string} name
 * @property {string|null} email
 * @property {string|null} phone
 * @property {string|null} location
 * @property {string|null} website
 * @property {string|null} linkedin
 */

/**
 * Per-item source provenance.
 *   "system"        = generated/merged by LLM or automation.
 *   "user"          = explicitly created or edited directly by the human user.
 *   "user_approved" = generated by the system but explicitly approved by the
 *                     user via the suggestions/candidates UI.  Treated the same
 *                     as "user" for merge-priority purposes — system merges will
 *                     never overwrite a "user_approved" item.
 *
 * Priority order (highest → lowest): user > user_approved > system
 * @typedef {"user"|"system"|"user_approved"} ItemSource
 */

/**
 * @typedef {Object} ResumeExperienceItem
 * @property {ItemSource} _source   Provenance tag — "user" | "system" | "user_approved"
 * @property {string} company
 * @property {string} title
 * @property {string|null} start_date  YYYY-MM
 * @property {string|null} end_date    YYYY-MM | "present"
 * @property {string|null} location
 * @property {string[]} bullets
 */

/**
 * @typedef {Object} ResumeEducationItem
 * @property {ItemSource} _source   Provenance tag — "user" | "system" | "user_approved"
 * @property {string} institution
 * @property {string|null} degree
 * @property {string|null} field
 * @property {string|null} start_date
 * @property {string|null} end_date
 * @property {string|null} gpa
 */

/**
 * @typedef {Object} ResumeSkills
 * @property {string[]} technical
 * @property {string[]} languages
 * @property {string[]} tools
 */

/**
 * @typedef {Object} ResumeProjectItem
 * @property {ItemSource} _source   Provenance tag — "user" | "system" | "user_approved"
 * @property {string} name
 * @property {string|null} description
 * @property {string|null} url
 * @property {string[]} bullets
 */

/**
 * @typedef {Object} ResumeCertificationItem
 * @property {ItemSource} _source   Provenance tag — "user" | "system" | "user_approved"
 * @property {string} name
 * @property {string|null} issuer
 * @property {string|null} date  YYYY-MM
 */

/**
 * Document-level provenance map for scalar sections.
 * @typedef {Object} ResumeSources
 * @property {ItemSource} summary   Provenance of the summary paragraph
 * @property {ItemSource} contact   Provenance of the contact block
 * @property {ItemSource} skills    Provenance of the skills block
 */

/**
 * @typedef {Object} ResumeData
 * @property {{ language: string, source: string, generatedAt: string, schemaVersion: number }} meta
 * @property {ResumeSources} _sources   Per-section scalar provenance map
 * @property {ResumeContact} contact
 * @property {string} summary
 * @property {ResumeExperienceItem[]} experience
 * @property {ResumeEducationItem[]} education
 * @property {ResumeSkills} skills
 * @property {ResumeProjectItem[]} projects
 * @property {ResumeCertificationItem[]} certifications
 */

/**
 * @typedef {Object} DisplayAxis
 * @property {string} label
 * @property {string} tagline
 * @property {string[]} highlight_skills
 */

/**
 * @typedef {Object} BootstrapResult
 * @property {ResumeData}    resumeData
 * @property {string[]}      strengthKeywords
 * @property {DisplayAxis[]} displayAxes
 */
