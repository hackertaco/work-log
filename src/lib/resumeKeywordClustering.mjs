/**
 * LLM Keyword Clustering Service (Sub-AC 16-2)
 *
 * Takes keywords collected from a resume document and recent work logs,
 * forwards them to the LLM, and returns 5–6 thematic axes, each with a
 * short label and the keywords that belong to it.
 *
 * Public API:
 *   clusterKeywords(resumeKeywords, workLogKeywords)  → Promise<KeywordAxis[]>
 *   collectResumeKeywords(resume)                     → string[]
 *   collectWorkLogKeywords(workLogs)                  → string[]
 *
 * Exported for unit-testing:
 *   normalizeAxes(rawAxes, originalKeywords)          → KeywordAxis[]
 *   deduplicateKeywords(keywords)                     → string[]
 *
 * Environment variables:
 *   OPENAI_API_KEY           — required for LLM calls
 *   WORK_LOG_OPENAI_URL      — optional URL override (default: OpenAI Responses API)
 *   WORK_LOG_OPENAI_MODEL    — optional model override (default: gpt-5.4-mini)
 *   WORK_LOG_DISABLE_OPENAI  — set "1" to disable LLM (returns [] instead of calling API)
 */

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} KeywordAxis
 * @property {string}   label    - Short thematic label (2–4 words)
 * @property {string[]} keywords - Keywords belonging to this axis
 */

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Clusters the combined keyword pool into 5–6 thematic axes using the LLM.
 *
 * Returns an empty array when:
 *   - No keywords are provided
 *   - OPENAI_API_KEY is absent
 *   - WORK_LOG_DISABLE_OPENAI=1 is set
 *
 * Throws when:
 *   - The HTTP request to the LLM API fails
 *   - The LLM response cannot be parsed
 *
 * @param {string[]} resumeKeywords   - Keywords from the resume document
 * @param {string[]} workLogKeywords  - Keywords extracted from recent work logs
 * @returns {Promise<KeywordAxis[]>}
 */
export async function clusterKeywords(resumeKeywords, workLogKeywords) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return [];
  }

  const allKeywords = deduplicateKeywords([
    ...(Array.isArray(resumeKeywords) ? resumeKeywords : []),
    ...(Array.isArray(workLogKeywords) ? workLogKeywords : [])
  ]);

  if (allKeywords.length === 0) {
    return [];
  }

  const payload = _buildClusterPayload(allKeywords);
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
      `OpenAI clustering failed: ${response.status} ${errorText.slice(0, 400)}`
    );
  }

  const data = await response.json();
  const text = data.output_text || _extractOutputText(data);
  if (!text) {
    throw new Error("OpenAI clustering failed: empty output");
  }

  const parsed = JSON.parse(text);
  return normalizeAxes(parsed.axes, allKeywords);
}

/**
 * Collects all unique keywords from a resume document.
 *
 * Sources:
 *   - resume.strength_keywords
 *   - resume.skills.technical
 *   - resume.skills.languages
 *   - resume.skills.tools
 *
 * @param {object} resume - Resume document
 * @returns {string[]}    - Deduplicated list of keywords (preserves first case)
 */
export function collectResumeKeywords(resume) {
  if (!resume || typeof resume !== "object") return [];

  const raw = [];

  if (Array.isArray(resume.strength_keywords)) {
    raw.push(...resume.strength_keywords);
  }

  const skills = resume.skills && typeof resume.skills === "object"
    ? resume.skills
    : {};
  if (Array.isArray(skills.technical)) raw.push(...skills.technical);
  if (Array.isArray(skills.languages)) raw.push(...skills.languages);
  if (Array.isArray(skills.tools)) raw.push(...skills.tools);

  return deduplicateKeywords(raw);
}

/**
 * Collects keywords from an array of daily work-log summary objects.
 *
 * Sources per work-log entry:
 *   - entry.keywords      (string[]) — direct keyword list if present
 *   - entry.resumeBullets (string[]) — bullets from the LLM summariser;
 *                                      CamelCase / acronym / hyphenated tokens
 *                                      are treated as candidate keywords
 *
 * @param {object[]} workLogs - Array of daily work-log summary objects
 * @returns {string[]}        - Deduplicated list of keywords
 */
export function collectWorkLogKeywords(workLogs) {
  if (!Array.isArray(workLogs)) return [];

  const raw = [];

  for (const log of workLogs) {
    if (!log || typeof log !== "object") continue;

    if (Array.isArray(log.keywords)) {
      raw.push(...log.keywords.filter((k) => typeof k === "string"));
    }

    if (Array.isArray(log.resumeBullets)) {
      for (const bullet of log.resumeBullets) {
        if (typeof bullet === "string") {
          raw.push(..._extractTechTokens(bullet));
        }
      }
    }
  }

  return deduplicateKeywords(raw);
}

// ─── Exported helpers (for unit testing) ──────────────────────────────────────

/**
 * Normalises raw LLM axes output:
 *   - Filters to valid objects with label (string) + keywords (string[])
 *   - Discards keywords that are not in the original input set (case-insensitive)
 *   - Prevents the same keyword appearing in more than one axis
 *   - Trims whitespace
 *   - Caps at 6 axes
 *
 * @param {unknown}  rawAxes        - Parsed LLM output (expected array)
 * @param {string[]} originalKeywords - The full deduplicated keyword pool sent to the LLM
 * @returns {KeywordAxis[]}
 */
export function normalizeAxes(rawAxes, originalKeywords) {
  if (!Array.isArray(rawAxes)) return [];

  const lowerOriginal = new Set(
    (Array.isArray(originalKeywords) ? originalKeywords : []).map((k) =>
      String(k).toLowerCase()
    )
  );
  const seen = new Set();

  const axes = rawAxes
    .filter(
      (axis) =>
        axis &&
        typeof axis === "object" &&
        typeof axis.label === "string" &&
        Array.isArray(axis.keywords)
    )
    .map((axis) => {
      const label = axis.label.trim();
      const keywords = axis.keywords
        .filter((k) => typeof k === "string" && k.trim().length > 0)
        .map((k) => k.trim())
        .filter((k) => {
          const lower = k.toLowerCase();
          if (!lowerOriginal.has(lower)) return false; // not in original set
          if (seen.has(lower)) return false; // already assigned to another axis
          seen.add(lower);
          return true;
        });
      return { label, keywords };
    })
    .filter((axis) => axis.label.length > 0 && axis.keywords.length > 0);

  return axes.slice(0, 6);
}

/**
 * Case-insensitive deduplication that preserves the original casing of the
 * first occurrence of each keyword.
 *
 * @param {unknown[]} keywords - Raw keyword candidates
 * @returns {string[]}
 */
export function deduplicateKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  const seen = new Set();
  const result = [];
  for (const k of keywords) {
    if (typeof k !== "string") continue;
    const trimmed = k.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(trimmed);
  }
  return result;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Builds the OpenAI Responses API payload for keyword clustering.
 * Uses strict JSON schema to guarantee 5–6 axes in the output.
 *
 * @param {string[]} keywords - Deduplicated keyword pool
 */
function _buildClusterPayload(keywords) {
  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "keyword_clustering",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            axes: {
              type: "array",
              minItems: 5,
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: { type: "string" },
                  keywords: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string" }
                  }
                },
                required: ["label", "keywords"]
              }
            }
          },
          required: ["axes"]
        }
      }
    },
    max_output_tokens: 600,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "You are a career analyst. Given a flat list of professional keywords",
              "from a developer's resume and work logs, cluster them into 5–6 thematic",
              "axes that represent distinct professional strengths or focus areas.",
              "Each axis needs a concise label (2–4 English words) and lists the",
              "keywords that belong to it. Every keyword in the input must appear",
              "in exactly one axis. Use the original keyword strings verbatim.",
              "If the input contains fewer distinct themes than 5, merge the smallest",
              "clusters to reach exactly 5 axes."
            ].join(" ")
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({ keywords }, null, 2)
          }
        ]
      }
    ]
  };
}

/**
 * Extracts the text portion from the OpenAI Responses API output structure
 * as a fallback when `data.output_text` is absent.
 *
 * @param {object} data - Parsed API response
 * @returns {string}
 */
function _extractOutputText(data) {
  const outputs = Array.isArray(data.output) ? data.output : [];
  const texts = [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

/**
 * Extracts likely technology keyword tokens from a free-form text string.
 * Accepts tokens that are CamelCase, ALL_CAPS, hyphenated, or dot-separated
 * (e.g. "React", "Node.js", "CI/CD", "REST-API") — typical patterns for
 * technology names in resume bullets.
 *
 * @param {string} text
 * @returns {string[]}
 */
function _extractTechTokens(text) {
  const tokens = text.split(/[\s,;:()\[\]{}\/|]+/);
  return tokens.filter((t) => {
    if (t.length < 2 || t.length > 40) return false;
    // Reject tokens that are pure lowercase (likely plain words, not tech names)
    if (!/[A-Z0-9]/.test(t)) return false;
    // Reject tokens that look like URL fragments or numbers only
    if (/^https?/.test(t)) return false;
    if (/^\d+$/.test(t)) return false;
    return true;
  });
}
