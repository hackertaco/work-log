/**
 * Work Log → Resume Update Extraction (LLM — diff-context mode).
 *
 * Takes a daily work log summary object (output of runDailyBatch / GET /api/day/:date)
 * and the current resume document, then calls the LLM to identify which parts of
 * today's work are worth adding to the resume.
 *
 * PROMPT STRATEGY (Sub-AC 12b):
 *   Instead of sending the full resume to the LLM, we first perform a rule-based
 *   pre-computation ("diff build") to identify candidate strings that are
 *   genuinely new — not yet present in the existing resume.  Only this compact
 *   diff is sent as LLM context, together with the list of existing company names
 *   (for bullet assignment).  This removes the large "do NOT repeat existing
 *   content" burden from the LLM and shrinks the context to the minimum needed.
 *
 *   Pipeline:
 *     1. buildWorkLogDiff(workLog, existingResume)
 *        → collect all raw candidate strings from the work log
 *        → deduplicate against every existing resume bullet (rule-based set check)
 *        → return only genuinely new strings + company names for assignment
 *     2. Short-circuit: if no new candidates exist, return empty extract (no LLM call)
 *     3. LLM call with the diff as sole context:
 *        → assigns refined bullets to matching experience entries
 *        → rewrites in achievement-oriented active voice
 *        → extracts any newly demonstrated skills
 *        → optionally proposes a summary update
 *
 * Output shape:
 *   {
 *     experienceUpdates: [{ company: string, bullets: string[] }],
 *     newSkills: { technical: string[], languages: string[], tools: string[] },
 *     summaryUpdate: string | null   // null = no change; non-empty = proposed new summary
 *   }
 *
 * The output is consumed by mergeWorkLogIntoResume() in resumeWorkLogMerge.mjs,
 * which applies these patches to produce a "proposed" resume document that is
 * then diffed against the current document.
 *
 * Environment variables:
 *   OPENAI_API_KEY           — required
 *   WORK_LOG_OPENAI_URL      — optional override (default: OpenAI Responses API)
 *   WORK_LOG_OPENAI_MODEL    — optional override (default: gpt-5.4-mini)
 *   WORK_LOG_DISABLE_OPENAI  — set "1" to disable (throws instead of calling API)
 */

import { computePipelineWeight } from "./resumePrBranchParser.mjs";

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WorkLogExtract
 * @property {{ company: string, bullets: string[] }[]} experienceUpdates
 *   NEW bullets to append to existing experience entries (matched by company name).
 *   The LLM has seen all genuinely-new candidates and assigned them to companies.
 * @property {{ technical: string[], languages: string[], tools: string[] }} newSkills
 *   New skills to add to the resume skills section (not already present).
 * @property {string | null} summaryUpdate
 *   Proposed updated professional summary, or null when no summary change is warranted.
 */

/**
 * @typedef {Object} WorkLogDiff
 * @property {string[]} rawCandidates
 *   Candidate strings from the work log that are NOT already present in the resume
 *   (after rule-based deduplication against all existing bullets).
 * @property {{ company: string, title: string|null, isCurrentRole: boolean }[]} existingCompanies
 *   All experience entries from the existing resume, name-only, for LLM assignment.
 * @property {{ repo: string, signal: string }[]} priorityProjects
 *   Top-weight projects from PR/branch activity signals (weight ≥ 0.25).
 * @property {string|null} date
 *   Work log date (YYYY-MM-DD), forwarded for logging.
 */

/**
 * Pre-compute a diff between work log candidates and the existing resume.
 *
 * This is a pure, rule-based function — no LLM call.
 * It collects all resume-worthy strings from the work log and removes any that
 * are already present (exact or near-exact) in the existing resume, so the LLM
 * context only contains genuinely novel information.
 *
 * @param {object} workLog         Daily summary document (output of runDailyBatch)
 * @param {object} existingResume  Current resume document from Vercel Blob
 * @returns {WorkLogDiff}
 */
export function buildWorkLogDiff(workLog, existingResume) {
  const wl = workLog ?? {};
  const highlights = wl.highlights ?? {};
  const resumeSection = wl.resume ?? {};

  // ── Collect all raw candidate strings from the work log ──────────────────
  const rawStrings = [
    ...(highlights.businessOutcomes ?? []),
    ...(highlights.keyChanges ?? []),
    ...(highlights.accomplishments ?? []).slice(0, 8),
    ...(resumeSection.candidates ?? []).slice(0, 6),
    ...(resumeSection.companyCandidates ?? []).slice(0, 8),
    ...(resumeSection.openSourceCandidates ?? []).slice(0, 6)
  ]
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim());

  // ── Build normalised set of ALL existing resume bullets for O(1) dedup ───
  const existingBulletsNorm = new Set();
  for (const exp of existingResume?.experience ?? []) {
    for (const bullet of exp.bullets ?? []) {
      const norm = _normalizeStr(bullet);
      if (norm) existingBulletsNorm.add(norm);
    }
  }
  for (const proj of existingResume?.projects ?? []) {
    for (const bullet of proj.bullets ?? []) {
      const norm = _normalizeStr(bullet);
      if (norm) existingBulletsNorm.add(norm);
    }
  }

  // ── Keep only strings that are genuinely new (not in existing resume) ────
  // Deduplication uses the same normalizer as resumeDiff.mjs so results are
  // consistent with the downstream diff step.
  const seen = new Set();
  const genuinelyNew = [];
  for (const s of rawStrings) {
    const norm = _normalizeStr(s);
    if (!norm) continue;
    if (seen.has(norm)) continue; // dedup within this batch
    seen.add(norm);
    if (!existingBulletsNorm.has(norm)) {
      genuinelyNew.push(s);
    }
  }

  // ── Extract existing experience entries (company names only) for LLM ─────
  const existingCompanies = (existingResume?.experience ?? [])
    .filter((e) => e && typeof e.company === "string" && e.company.trim())
    .map((e) => ({
      company: e.company.trim(),
      title: typeof e.title === "string" && e.title.trim() ? e.title.trim() : null,
      isCurrentRole: !e.end_date || String(e.end_date).toLowerCase() === "present"
    }));

  // ── Extract priority projects from PR/branch signals (Sub-AC 11b) ─────────
  //
  // Filtering: use raw max signal weight (threshold ≥ 0.25) to decide which
  // projects qualify.  This prevents low-signal repos from being promoted to
  // priority status based on mention volume alone.
  //
  // Sorting: use the combined pipeline weight (maxWeight × mention-count boost)
  // so that a project mentioned many times ranks above a project with the same
  // max weight but fewer mentions.
  //
  // For backward compatibility with older work logs that only set projectWeights
  // (no pipelineWeights/mentionCounts), we fall back to computing the pipeline
  // weight on-the-fly from projectWeights + mentionCounts.
  const prBranchSignals = wl.prBranchSignals ?? {};
  const priorityWeights = prBranchSignals.projectWeights ?? {};
  const pipelineWeights = prBranchSignals.pipelineWeights ?? {};
  const mentionCounts = prBranchSignals.mentionCounts ?? {};
  const priorityProjects = Object.entries(priorityWeights)
    .filter(([, w]) => w >= 0.25)
    .sort((a, b) => {
      // Sort by combined pipeline weight; compute on-the-fly when absent.
      const pa =
        pipelineWeights[a[0]] ??
        computePipelineWeight(a[1], mentionCounts[a[0]] ?? 1);
      const pb =
        pipelineWeights[b[0]] ??
        computePipelineWeight(b[1], mentionCounts[b[0]] ?? 1);
      return pb - pa;
    })
    .slice(0, 5)
    .map(([repo, weight]) => ({
      repo,
      signal:
        weight >= 1.0
          ? "PR merged"
          : weight >= 0.75
          ? "PR referenced"
          : weight >= 0.5
          ? "branch created"
          : "branch activity"
    }));

  return {
    rawCandidates: genuinelyNew,
    existingCompanies,
    priorityProjects,
    date: typeof wl.date === "string" ? wl.date : null
  };
}

/**
 * Extract new resume-worthy content from a daily work log summary.
 *
 * Step 1 — rule-based diff: identifies candidate strings genuinely not in the resume.
 * Step 2 — short-circuit: if no new candidates exist, returns an empty extract
 *           immediately without an LLM call (saves cost and latency).
 * Step 3 — LLM call: passes only the diff as context (not the full resume) so the
 *           model can assign and refine candidates with a much smaller prompt.
 *
 * @param {object} workLog         Daily summary document (output of runDailyBatch)
 * @param {object} existingResume  Current resume document from Vercel Blob
 * @returns {Promise<WorkLogExtract>}
 * @throws {Error} If the API key is missing or the LLM call fails
 */
export async function extractResumeUpdatesFromWorkLog(workLog, existingResume) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set — cannot extract resume updates from work log"
    );
  }
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    throw new Error(
      "OpenAI integration is disabled (WORK_LOG_DISABLE_OPENAI=1)"
    );
  }

  // ── Step 1: rule-based pre-computation — build the work log diff ──────────
  const workLogDiff = buildWorkLogDiff(workLog, existingResume);

  // ── Step 2: short-circuit when no genuinely new candidates exist ──────────
  //
  // If the rule-based diff finds nothing new, skip the LLM call entirely.
  // The only reason to still call the LLM is when new candidates exist that
  // need assignment (to a company) and quality refinement.
  if (workLogDiff.rawCandidates.length === 0) {
    return {
      experienceUpdates: [],
      newSkills: { technical: [], languages: [], tools: [] },
      summaryUpdate: null
    };
  }

  // ── Step 3: LLM call with diff context only (not full resume) ────────────
  const lang =
    existingResume?.meta?.language || existingResume?.language || "en";
  const payload = buildDiffExtractionPayload(workLogDiff, lang);

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
      `Work log resume extraction LLM call failed: ${response.status} ${errorText.slice(0, 400)}`
    );
  }

  const data = await response.json();
  const rawText = data.output_text || _extractOutputText(data);
  if (!rawText) {
    throw new Error("Work log resume extraction LLM call returned empty output");
  }

  const parsed = JSON.parse(rawText);
  return normalizeExtract(parsed);
}

// ─── Diff-based payload builder ────────────────────────────────────────────────

/**
 * Build the LLM request payload using the pre-computed work log diff as context.
 *
 * Only the diff is provided (genuinely-new candidate strings + company names),
 * NOT the full resume.  This keeps the prompt small and focused:
 * the LLM's role is to assign and refine already-screened candidates, not to
 * scan the full resume for duplicates.
 *
 * @param {WorkLogDiff} workLogDiff  Output of buildWorkLogDiff()
 * @param {string} lang              Resume language code ("ko" | "en" | ...)
 * @returns {object}  OpenAI Responses API payload
 */
function buildDiffExtractionPayload(workLogDiff, lang) {
  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "work_log_resume_patch",
        strict: true,
        schema: EXTRACTION_OUTPUT_SCHEMA
      }
    },
    max_output_tokens: 1600,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: buildDiffSystemPrompt(lang)
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildDiffUserMessage(workLogDiff, lang)
          }
        ]
      }
    ]
  };
}

// ─── System prompt (diff-context mode) ────────────────────────────────────────

/**
 * Build the system prompt for diff-context extraction.
 *
 * In this mode the LLM does NOT receive the full resume.  Instead it receives
 * a compact diff: the raw candidate strings that have already been confirmed
 * as genuinely new (not in the resume) plus the list of existing company names
 * it can assign bullets to.  The LLM's only jobs are:
 *   1. Assign each raw candidate to the right experience entry.
 *   2. Rewrite it in achievement-oriented active voice.
 *   3. Extract any newly demonstrated skills.
 *   4. Optionally propose a summary update for major career shifts.
 *
 * @param {string} lang  Resume language code
 * @returns {string}
 */
function buildDiffSystemPrompt(lang) {
  return `\
You assign and refine proposed resume update candidates from a developer's work log.

━━━ LANGUAGE RULE ━━━
Write ALL generated text in "${lang}" (the same language as the existing resume).
Do NOT mix languages.

━━━ CONTEXT ━━━
You are given:
1. Raw candidate strings that have already been verified as NOT present in the
   existing resume (pre-screened by a rule-based diff step).
2. The available experience entries in the resume — company names only — so you
   can assign each candidate to the right role.
3. Priority projects (from commit/PR activity) for additional assignment context.

━━━ TASK ━━━
Assign and refine the raw candidates into a minimal resume patch.

Return three things:

1. experience_updates — refined bullets assigned to experience entries.
   • Assign each raw candidate to the most relevant experience entry by company name.
   • Use the EXACT company name as listed under "Available Experience Entries".
   • Rewrite each bullet in achievement-oriented active voice. Start with a strong verb.
   • Each bullet: 1–2 sentences, ≤ 130 chars.
   • Omit any bullet that is vague, not achievement-worthy, or cannot be confidently assigned.
   • Return an empty array when no raw candidates are assignable.

2. new_skills — skills/tools/languages inferred from the raw candidates.
   • Extract only skills clearly demonstrated in the raw candidates.
   • Be conservative — if in doubt, omit.
   • Return empty arrays when nothing new is evident.

3. summary_update — a revised professional summary, or empty string for no change.
   • Set to a non-empty string ONLY when the raw candidates contain a major
     achievement that materially shifts the candidate's professional narrative
     (e.g., first work in a new domain, significant leadership milestone).
   • If in doubt, return "".
   • When set, the new summary must be 2–4 sentences, written in "${lang}".

━━━ RULES ━━━
• Do NOT invent information not present in the raw candidates.
• Do NOT remove any existing resume content.
• Prefer adding nothing over adding low-quality content.`;
}

// ─── User message builder (diff-context mode) ─────────────────────────────────

/**
 * Build the user message from the work log diff.
 *
 * Sends ONLY:
 *   1. Genuinely-new raw candidate strings (pre-screened against existing resume)
 *   2. Existing experience company names (for bullet assignment)
 *   3. Priority projects context (from PR/branch signals)
 *
 * Does NOT send the full resume, avoiding large context and letting the LLM
 * focus entirely on assignment and quality refinement.
 *
 * @param {WorkLogDiff} diff
 * @param {string} lang
 * @returns {string}
 */
function buildDiffUserMessage(diff, lang) {
  const parts = [];

  // ── Priority projects ──────────────────────────────────────────────────────
  if (diff.priorityProjects.length > 0) {
    parts.push("Priority projects (active PR/branch work — prefer assigning bullets here):");
    for (const p of diff.priorityProjects) {
      parts.push(`  - ${p.repo} [${p.signal}]`);
    }
    parts.push("");
  }

  // ── Raw candidates (the diff — pre-screened, genuinely new) ───────────────
  parts.push(
    `=== RAW CANDIDATES (${diff.rawCandidates.length} new strings — not yet in resume) ===`
  );
  parts.push("");
  if (diff.rawCandidates.length === 0) {
    // Should not happen (short-circuit above catches this), but defensive:
    parts.push("(none)");
  } else {
    for (const s of diff.rawCandidates) {
      parts.push(`  - ${s}`);
    }
  }
  parts.push("");

  // ── Existing company names for assignment ──────────────────────────────────
  parts.push("=== AVAILABLE EXPERIENCE ENTRIES (assign bullets using exact company names) ===");
  parts.push("");
  if (diff.existingCompanies.length === 0) {
    parts.push("  (no experience entries in resume yet)");
  } else {
    for (const exp of diff.existingCompanies) {
      const current = exp.isCurrentRole ? " [current role]" : "";
      const titlePart = exp.title ? ` / ${exp.title}` : "";
      parts.push(`  - ${exp.company}${titlePart}${current}`);
    }
  }
  parts.push("");

  return parts.join("\n");
}

// ─── JSON Schema for structured output ────────────────────────────────────────

/**
 * Output schema for the minimal resume patch (unchanged from Sub-AC 12a).
 *
 * Keys:
 *   experience_updates — bullets to append, per company (assigned by LLM)
 *   new_skills         — new technical/language/tool skills extracted from candidates
 *   summary_update     — empty string = no change; non-empty = proposed new summary
 */
const EXTRACTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["experience_updates", "new_skills", "summary_update"],
  properties: {
    experience_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company", "bullets"],
        properties: {
          company: { type: "string" },
          bullets: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    new_skills: {
      type: "object",
      additionalProperties: false,
      required: ["technical", "languages", "tools"],
      properties: {
        technical: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "string" } }
      }
    },
    /**
     * Proposed updated professional summary.
     * Empty string ("") means no change is needed.
     * Non-empty string means the LLM proposes this as a replacement summary.
     *
     * Using string (not null) for strict-mode OpenAI schema compatibility.
     */
    summary_update: { type: "string" }
  }
};

// ─── Output normalisation ──────────────────────────────────────────────────────

/**
 * Validate and clean the LLM output into the WorkLogExtract shape.
 *
 * @param {object} parsed  Raw parsed JSON from the LLM
 * @returns {WorkLogExtract}
 */
function normalizeExtract(parsed) {
  const experienceUpdates = Array.isArray(parsed.experience_updates)
    ? parsed.experience_updates
        .filter(
          (e) => e && typeof e.company === "string" && e.company.trim()
        )
        .map((e) => ({
          company: e.company.trim(),
          bullets: _normalizeStringArray(e.bullets, 130, 5)
        }))
        .filter((e) => e.bullets.length > 0)
    : [];

  const rawSkills =
    parsed.new_skills && typeof parsed.new_skills === "object"
      ? parsed.new_skills
      : {};

  const newSkills = {
    technical: _normalizeStringArray(rawSkills.technical, 60, 15),
    languages: _normalizeStringArray(rawSkills.languages, 40, 10),
    tools: _normalizeStringArray(rawSkills.tools, 60, 15)
  };

  // Normalize summary_update: empty string or whitespace-only → null
  const rawSummary =
    typeof parsed.summary_update === "string" ? parsed.summary_update.trim() : "";
  const summaryUpdate = rawSummary.length > 0 ? rawSummary : null;

  return { experienceUpdates, newSkills, summaryUpdate };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalise a string for identity comparison (mirrors resumeDiff.mjs behaviour).
 * Lower-case, trim, collapse whitespace, strip common punctuation variants.
 *
 * @param {unknown} val
 * @returns {string}
 */
function _normalizeStr(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .toLowerCase()
    .trim()
    .replace(/[.,\-–—&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _normalizeStringArray(arr, maxItemLength = 200, maxItems = 20) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .map((s) => s.slice(0, maxItemLength))
    .slice(0, maxItems);
}

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
