/**
 * Living Resume — LLM-based resume generation.
 *
 * Two responsibilities:
 *   1. extractPdfText(buffer)          — parse a PDF Buffer → plain text (pdf-parse)
 *   2. generateResumeFromPdf(params)   — call OpenAI Responses API → structured resume JSON
 *
 * Fixed minimum schema sections (Day 1; no custom sections):
 *   basics, experience, education, skills, projects, certifications,
 *   strength_keywords, display_axes
 *
 * When OpenAI is unavailable (missing key or WORK_LOG_DISABLE_OPENAI=1),
 * a minimal skeleton is assembled from any LinkedIn data provided.
 */

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/** Resume document schema version stored in every blob. */
export const RESUME_SCHEMA_VERSION = "1";

// ─── PDF Text Extraction ───────────────────────────────────────────────────────

/**
 * Extract plain text from a PDF Buffer using pdf-parse (CJS module).
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractPdfText(buffer) {
  const pdfParseModule = _require("pdf-parse");

  if (typeof pdfParseModule === "function") {
    const result = await pdfParseModule(buffer);
    return (result.text ?? "").trim();
  }

  if (typeof pdfParseModule?.default === "function") {
    const result = await pdfParseModule.default(buffer);
    return (result.text ?? "").trim();
  }

  if (typeof pdfParseModule?.PDFParse === "function") {
    const parser = new pdfParseModule.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return (result?.text ?? "").trim();
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  throw new Error("Unsupported pdf-parse module shape");
}

// ─── Resume Generation ─────────────────────────────────────────────────────────

/**
 * Generate a structured resume document from PDF text + optional LinkedIn data.
 *
 * @param {{
 *   pdfText: string,
 *   pdfName: string,
 *   linkedinUrl?: string|null,
 *   linkedinData?: object|null,
 *   linkedinText?: string|null,
 * }} params
 * @returns {Promise<object>} Resume document conforming to RESUME_SCHEMA_VERSION
 */
export async function generateResumeFromPdf({
  pdfText,
  pdfName,
  linkedinUrl = null,
  linkedinData = null,
  linkedinText = null
}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return buildFallbackResume({ pdfText, pdfName, linkedinUrl, linkedinData, linkedinText });
  }

  try {
    const llmOutput = await callLlm({
      pdfText,
      linkedinData,
      linkedinText,
      linkedinUrl,
      apiKey
    });
    return assembleResumeDocument(llmOutput, { pdfName, linkedinUrl });
  } catch (err) {
    console.error("[resumeLlm] LLM call failed, using fallback:", err.message);
    return buildFallbackResume({ pdfText, pdfName, linkedinUrl, linkedinData, linkedinText });
  }
}

// ─── LLM Call ─────────────────────────────────────────────────────────────────

async function callLlm({ pdfText, linkedinData, linkedinText, apiKey }) {
  const contextParts = [
    `=== PDF CONTENT ===\n${pdfText.slice(0, 12000)}`
  ];

  if (linkedinData) {
    contextParts.push(
      `=== LINKEDIN PROFILE ===\n${JSON.stringify(linkedinData, null, 2).slice(0, 4000)}`
    );
  } else if (linkedinText) {
    contextParts.push(`=== LINKEDIN TEXT ===\n${linkedinText.slice(0, 3000)}`);
  }

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "resume_structure",
        strict: true,
        schema: buildLlmSchema()
      }
    },
    max_output_tokens: 4000,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: buildSystemPrompt() }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: contextParts.join("\n\n") }]
      }
    ]
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM failed: ${response.status} ${errText.slice(0, 400)}`);
  }

  const data = await response.json();
  const text = data.output_text ?? extractOutputText(data);
  if (!text) throw new Error("LLM returned empty output");
  return JSON.parse(text);
}

function extractOutputText(data) {
  const outputs = data.output ?? [];
  const texts = [];
  for (const item of outputs) {
    for (const part of item?.content ?? []) {
      if (part?.type === "output_text" && part?.text) texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
}

// ─── System Prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are a professional resume parser and career analyst.
Extract structured data from the provided PDF resume content and optional LinkedIn profile.

Rules:
- language: detect the primary language of the resume ("ko" for Korean, "en" for English, ISO 639-1 code)
- basics.headline: concise 1-line professional title (max 100 chars)
- basics.summary: 2-3 sentence professional summary in the resume's own language
- experience: sorted newest-first; use end="" for current positions
- skills: flat list of technical skills, tools, languages, frameworks (deduplicated)
- strength_keywords: 5–10 keywords capturing the person's key strengths and differentiators
- display_axes.primary: the person's core professional identity/trajectory (max 60 chars)
- display_axes.secondary: secondary area of expertise or working style (max 60 chars)
- Use empty string "" for missing text fields, empty array [] for missing array fields
- Do NOT invent information not present in the source material`;
}

// ─── JSON Schema for LLM output ───────────────────────────────────────────────

function buildLlmSchema() {
  const strField = { type: "string" };
  const strArray = { type: "array", items: { type: "string" } };

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "language",
      "basics",
      "experience",
      "education",
      "skills",
      "projects",
      "certifications",
      "strength_keywords",
      "display_axes"
    ],
    properties: {
      language: strField,
      basics: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "phone", "location", "headline", "summary"],
        properties: {
          name: strField,
          email: strField,
          phone: strField,
          location: strField,
          headline: strField,
          summary: strField
        }
      },
      experience: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["company", "title", "start", "end", "description", "bullets"],
          properties: {
            company: strField,
            title: strField,
            start: strField,
            end: strField,
            description: strField,
            bullets: strArray
          }
        }
      },
      education: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["institution", "degree", "field", "start", "end"],
          properties: {
            institution: strField,
            degree: strField,
            field: strField,
            start: strField,
            end: strField
          }
        }
      },
      skills: strArray,
      projects: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "description", "url"],
          properties: {
            name: strField,
            description: strField,
            url: strField
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
            name: strField,
            issuer: strField,
            date: strField
          }
        }
      },
      strength_keywords: strArray,
      display_axes: {
        type: "object",
        additionalProperties: false,
        required: ["primary", "secondary"],
        properties: {
          primary: strField,
          secondary: strField
        }
      }
    }
  };
}

// ─── Document Assembly ─────────────────────────────────────────────────────────

/**
 * Wrap LLM output in the full resume document envelope with metadata.
 *
 * @param {object} llmOutput  Parsed LLM JSON response
 * @param {{ pdfName: string, linkedinUrl: string|null }} meta
 * @returns {object} Complete resume document
 */
function assembleResumeDocument(llmOutput, { pdfName, linkedinUrl }) {
  return {
    schema_version: RESUME_SCHEMA_VERSION,
    language: String(llmOutput.language ?? "en"),
    bootstrapped_at: new Date().toISOString(),
    source: {
      pdf_name: String(pdfName ?? ""),
      linkedin_url: linkedinUrl ?? null
    },
    basics: sanitizeBasics(llmOutput.basics),
    experience: (llmOutput.experience ?? []).map(sanitizeExperience),
    education: (llmOutput.education ?? []).map(sanitizeEducation),
    skills: sanitizeStringArray(llmOutput.skills),
    projects: (llmOutput.projects ?? []).map(sanitizeProject),
    certifications: (llmOutput.certifications ?? []).map(sanitizeCertification),
    strength_keywords: sanitizeStringArray(llmOutput.strength_keywords),
    display_axes: sanitizeDisplayAxes(llmOutput.display_axes)
  };
}

// ─── Fallback (no LLM) ────────────────────────────────────────────────────────

/**
 * Build a minimal resume skeleton when LLM is unavailable.
 * Populated from LinkedIn structured data if provided, otherwise returns
 * an empty scaffold so the user can fill it in manually.
 *
 * @param {{ pdfName: string, linkedinUrl: string|null, linkedinData: object|null }} params
 * @returns {object} Resume document
 */
function buildFallbackResume({ pdfName, linkedinUrl, linkedinData }) {
  const ld = linkedinData ?? {};

  return assembleResumeDocument(
    {
      language: "en",
      basics: {
        name: ld.name ?? "",
        email: "",
        phone: "",
        location: ld.location ?? "",
        headline: ld.headline ?? "",
        summary: ld.about ?? ""
      },
      experience: (ld.experience ?? []).map((e) => ({
        company: e.company ?? "",
        title: e.title ?? "",
        start: "",
        end: "",
        description: e.description ?? "",
        bullets: []
      })),
      education: (ld.education ?? []).map((e) => ({
        institution: e.school ?? "",
        degree: e.degree ?? "",
        field: e.field ?? "",
        start: (e.years ?? "").split(/[-–]/)[0]?.trim() ?? "",
        end: (e.years ?? "").split(/[-–]/)[1]?.trim() ?? ""
      })),
      skills: ld.skills ?? [],
      projects: [],
      certifications: [],
      strength_keywords: (ld.skills ?? []).slice(0, 8),
      display_axes: { primary: "", secondary: "" }
    },
    { pdfName, linkedinUrl }
  );
}

// ─── Field Sanitizers ─────────────────────────────────────────────────────────

function sanitizeBasics(b) {
  const d = b ?? {};
  return {
    name: String(d.name ?? ""),
    email: String(d.email ?? ""),
    phone: String(d.phone ?? ""),
    location: String(d.location ?? ""),
    headline: String(d.headline ?? ""),
    summary: String(d.summary ?? "")
  };
}

function sanitizeExperience(e) {
  return {
    company: String(e?.company ?? ""),
    title: String(e?.title ?? ""),
    start: String(e?.start ?? ""),
    end: String(e?.end ?? ""),
    description: String(e?.description ?? ""),
    bullets: sanitizeStringArray(e?.bullets)
  };
}

function sanitizeEducation(e) {
  return {
    institution: String(e?.institution ?? ""),
    degree: String(e?.degree ?? ""),
    field: String(e?.field ?? ""),
    start: String(e?.start ?? ""),
    end: String(e?.end ?? "")
  };
}

function sanitizeProject(p) {
  return {
    name: String(p?.name ?? ""),
    description: String(p?.description ?? ""),
    url: String(p?.url ?? "")
  };
}

function sanitizeCertification(c) {
  return {
    name: String(c?.name ?? ""),
    issuer: String(c?.issuer ?? ""),
    date: String(c?.date ?? "")
  };
}

function sanitizeDisplayAxes(d) {
  return {
    primary: String(d?.primary ?? ""),
    secondary: String(d?.secondary ?? "")
  };
}

function sanitizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);
}
