/**
 * Resume Axis Clustering — LLM-based career narrative axis generation.
 *
 * Given an existing resume document, this module derives (or re-derives)
 * 2–4 "display axes" — distinct career-narrative lenses through which the
 * resume can be positioned (e.g. "Full-Stack Engineer", "Engineering Manager").
 *
 * Each axis contains:
 *   label            — short title for the career angle
 *   tagline          — one sentence describing the person's value from this angle
 *   highlight_skills — 3–6 skills from the resume most relevant to this axis
 *
 * The generated language follows the resume's own language (resume.meta.language).
 *
 * Environment variables (same as resumeBootstrap.mjs):
 *   OPENAI_API_KEY           — required
 *   WORK_LOG_OPENAI_URL      — optional (default: https://api.openai.com/v1/responses)
 *   WORK_LOG_OPENAI_MODEL    — optional (default: gpt-5.4-mini)
 *   WORK_LOG_DISABLE_OPENAI  — set "1" to skip LLM call (throws instead)
 */

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

// Max characters of resume context forwarded to the LLM per section.
const SUMMARY_LIMIT    = 600;
const BULLETS_LIMIT    = 3_000;
const SKILLS_LIMIT     = 800;
const KEYWORDS_LIMIT   = 600;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate (or regenerate) 2–4 display axes for the given resume document
 * using a single focused LLM call.
 *
 * The caller is responsible for persisting the returned axes back into the
 * resume document and saving to Vercel Blob.
 *
 * @param {object} resumeDoc
 *   The full resume document as stored in Vercel Blob (resume/data.json).
 *   Must at least contain `meta`, `summary`, `experience`, and `skills`.
 * @returns {Promise<DisplayAxis[]>}
 *   An array of 2–4 normalised DisplayAxis objects.
 * @throws {Error}
 *   If OPENAI_API_KEY is not set, the LLM call fails, or the output cannot
 *   be parsed.
 */
export async function generateDisplayAxes(resumeDoc) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set — cannot generate display axes"
    );
  }
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    throw new Error(
      "OpenAI integration is disabled (WORK_LOG_DISABLE_OPENAI=1)"
    );
  }

  if (!resumeDoc || typeof resumeDoc !== "object") {
    throw new Error("generateDisplayAxes: resumeDoc must be a non-null object");
  }

  const language = resumeDoc?.meta?.language || "en";

  console.info(
    `[resumeAxisClustering] Calling LLM: model=${OPENAI_MODEL}` +
    ` language=${language}`
  );

  const payload = buildClusteringPayload(resumeDoc, language);

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
      `Axis clustering LLM call failed: ${response.status} ${errorText.slice(0, 400)}`
    );
  }

  const data = await response.json();
  const rawText = data.output_text || _extractOutputText(data);
  if (!rawText) {
    throw new Error("Axis clustering LLM call returned empty output");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Axis clustering LLM returned non-JSON output: ${rawText.slice(0, 200)}`
    );
  }

  const axes = _normalizeDisplayAxes(parsed?.display_axes);
  console.info(
    `[resumeAxisClustering] LLM succeeded: axes=${axes.length}`
  );
  return axes;
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

/** JSON Schema for the axes-only structured output. */
const AXIS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["display_axes"],
  properties: {
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

/**
 * Build the LLM request payload for axis generation.
 *
 * @param {object} resumeDoc  Full resume document.
 * @param {string} language   ISO 639-1 language code.
 * @returns {object}  Payload object suitable for the OpenAI Responses API.
 */
function buildClusteringPayload(resumeDoc, language) {
  return {
    model: OPENAI_MODEL,
    reasoning: {
      effort: "low"
    },
    text: {
      format: {
        type: "json_schema",
        name: "resume_axes",
        strict: true,
        schema: AXIS_OUTPUT_SCHEMA
      }
    },
    max_output_tokens: 1024,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: _buildSystemPrompt(language)
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: _buildUserMessage(resumeDoc)
          }
        ]
      }
    ]
  };
}

/**
 * Build the system prompt, injecting the target language.
 *
 * @param {string} language  ISO 639-1 code (e.g. "ko", "en").
 * @returns {string}
 */
function _buildSystemPrompt(language) {
  return `\
You are an expert career coach specializing in resume positioning and personal branding.

Your task is to derive 2–4 distinct career narrative lenses ("display axes") from a \
candidate's resume. These axes represent different angles through which the same resume \
can be positioned — e.g. one role that fits a "Full-Stack Engineer" frame may also be \
compelling as a "Product-minded Engineer" or "Technical Lead" story.

━━━ LANGUAGE RULE ━━━
The resume language code is: ${language}.
Write ALL generated text (taglines) in that SAME language. \
Do not mix languages unless the source itself does.

━━━ DISPLAY AXES RULES ━━━
• Generate exactly 2–4 distinct career narrative lenses.
• Each axis must have:
    - label: Short title for the angle (e.g. "Full-Stack Engineer", \
"Frontend Specialist", "Engineering Manager"). Under 40 characters.
    - tagline: One sentence (max 120 characters) describing what makes this person \
compelling from this angle. Written in the same language as the resume (${language}).
    - highlight_skills: 3–6 skills from the resume that are most relevant to this axis. \
Take skills only from the skills section or bullets already in the resume — do not invent skills.
• Axes must be meaningfully different — not just synonym labels or minor variations.
• Prioritise angles supported by direct evidence (job titles, bullets, skills listed). \
Do not fabricate a leadership axis unless the resume clearly contains management evidence.`;
}

/**
 * Build the user message containing a compact representation of the resume.
 *
 * @param {object} resumeDoc  Full resume document.
 * @returns {string}
 */
function _buildUserMessage(resumeDoc) {
  const parts = [];

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = String(resumeDoc.summary || "").trim().slice(0, SUMMARY_LIMIT);
  if (summary) {
    parts.push("=== SUMMARY ===");
    parts.push(summary);
  }

  // ── Experience titles & bullets ───────────────────────────────────────────
  const experience = Array.isArray(resumeDoc.experience) ? resumeDoc.experience : [];
  if (experience.length > 0) {
    parts.push("");
    parts.push("=== EXPERIENCE ===");
    let bulletsAccum = 0;
    for (const exp of experience) {
      const role = [exp.title, exp.company].filter(Boolean).join(" @ ");
      parts.push(role);
      const bullets = Array.isArray(exp.bullets) ? exp.bullets : [];
      for (const bullet of bullets) {
        const trimmed = String(bullet || "").trim();
        if (!trimmed) continue;
        bulletsAccum += trimmed.length;
        if (bulletsAccum > BULLETS_LIMIT) {
          parts.push("  [... truncated ...]");
          break;
        }
        parts.push(`  • ${trimmed}`);
      }
      if (bulletsAccum > BULLETS_LIMIT) break;
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  const skills = resumeDoc.skills || {};
  const allSkills = [
    ...(Array.isArray(skills.technical) ? skills.technical : []),
    ...(Array.isArray(skills.languages) ? skills.languages : []),
    ...(Array.isArray(skills.tools)     ? skills.tools     : [])
  ].filter(Boolean);
  if (allSkills.length > 0) {
    const skillsStr = allSkills.join(", ").slice(0, SKILLS_LIMIT);
    parts.push("");
    parts.push("=== SKILLS ===");
    parts.push(skillsStr);
  }

  // ── Strength keywords ─────────────────────────────────────────────────────
  const keywords = Array.isArray(resumeDoc.strength_keywords)
    ? resumeDoc.strength_keywords
    : [];
  if (keywords.length > 0) {
    const kwStr = keywords.join(", ").slice(0, KEYWORDS_LIMIT);
    parts.push("");
    parts.push("=== STRENGTH KEYWORDS ===");
    parts.push(kwStr);
  }

  return parts.join("\n") || "(empty resume)";
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Validate and normalise the raw `display_axes` array from the LLM response.
 *
 * @param {unknown} arr  Raw parsed value from JSON.
 * @returns {DisplayAxis[]}  Clean array of 2–4 axes.
 */
function _normalizeDisplayAxes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item) => item && typeof item === "object" && item.label && item.tagline)
    .slice(0, 4)
    .map((item) => ({
      label: String(item.label || "").trim(),
      tagline: String(item.tagline || "").trim(),
      highlight_skills: _normalizeStringArray(item.highlight_skills, 60, 6)
    }));
}

/**
 * Normalize an array of strings: ensure non-empty strings, trim whitespace,
 * cap individual length, cap total count.
 *
 * @param {unknown} value
 * @param {number}  maxItemLength
 * @param {number}  maxItems
 * @returns {string[]}
 */
function _normalizeStringArray(value, maxItemLength = 200, maxItems = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => item.slice(0, maxItemLength))
    .slice(0, maxItems);
}

// ---------------------------------------------------------------------------
// Response extraction helper (mirrors openai.mjs / resumeBootstrap.mjs)
// ---------------------------------------------------------------------------

/**
 * Extract text from the output array of an OpenAI Responses API response.
 * Fallback when `data.output_text` is absent.
 *
 * @param {object} data  Parsed JSON response from the Responses API.
 * @returns {string}
 */
function _extractOutputText(data) {
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
// JSDoc type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DisplayAxis
 * @property {string}   label             Short title for the career narrative angle.
 * @property {string}   tagline           One sentence describing the person's value from this angle.
 * @property {string[]} highlight_skills  3–6 skills most relevant to this axis.
 */
