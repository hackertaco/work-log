/**
 * Resume Draft Generation — Chat-based Resume Refinement Bootstrap.
 *
 * Aggregates work log data (commits / Slack / session memory) across a date range
 * and uses the LLM to extract:
 *   1. Strength candidates — behavioral patterns backed by concrete evidence
 *   2. Experience summaries — per-company/role highlights with suggested bullets
 *   3. A suggested professional summary
 *
 * This output is the starting context for the chat-based resume refinement UI.
 * It answers "what can we reliably say about this person?" before any
 * free-form chat starts, ensuring the LLM does not hallucinate unsupported claims.
 *
 * Pipeline:
 *   1. loadWorkLogs(dateRange)
 *      → Reads data/daily/{date}.json files for the specified range
 *   2. aggregateSignals(workLogs)
 *      → Flattens commits, session notes, Slack contexts, highlights
 *   3. callLLM(aggregatedSignals, existingResume?)
 *      → Single LLM call → strengthCandidates + experienceSummaries + suggestedSummary
 *   4. Returns ResumeDraft (JSON, stored in Vercel Blob at resume/chat-draft.json)
 *
 * Environment variables:
 *   OPENAI_API_KEY           — required
 *   WORK_LOG_OPENAI_URL      — optional override (default: /v1/responses)
 *   WORK_LOG_OPENAI_MODEL    — optional override (default: gpt-5.4-mini)
 *   WORK_LOG_DISABLE_OPENAI  — set "1" to disable
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { fileExists } from "./utils.mjs";

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

// Max work log dates to aggregate in a single draft generation call.
// ~90 days ≈ one quarter of work; beyond this the prompt grows too large.
const MAX_DATES = 90;

// Max characters forwarded to the LLM for the aggregated signals.
// Stays well within gpt-5.4-mini's context window while covering typical 30-day ranges.
const SIGNAL_TEXT_LIMIT = 20_000;

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A single draft strength candidate — a behavioral pattern surfaced from work evidence.
 *
 * @typedef {Object} DraftStrengthCandidate
 * @property {string}   id              Stable id — "str-cand-{index}"
 * @property {string}   label           Short behavioral pattern name (2-6 words)
 * @property {string}   description     1-2 sentence explanation of how this manifests
 * @property {number}   frequency       Approximate number of evidence occurrences
 * @property {string[]} behaviorCluster 2-4 micro-behaviors clustered into this strength
 * @property {string[]} evidenceExamples 1-3 concrete evidence snippets from work logs
 * @property {string[]} dates           Work log dates that contributed evidence
 */

/**
 * A per-company/role experience summary extracted from work logs.
 *
 * @typedef {Object} DraftExperienceSummary
 * @property {string}   company         Company or repo name
 * @property {string[]} highlights      2-4 key outcome statements (achievement-oriented)
 * @property {string[]} skills          Skills/tools demonstrated in this context
 * @property {string[]} suggestedBullets 2-5 resume-ready bullet candidates
 * @property {string[]} dates           Work log dates with activity for this company
 */

/**
 * A generated resume draft from aggregated work log data.
 *
 * @typedef {Object} ResumeDraft
 * @property {1}                      schemaVersion   Always 1
 * @property {string}                 generatedAt     ISO 8601 datetime
 * @property {{ from: string, to: string }} dateRange Inclusive date range analyzed
 * @property {DraftSourceMeta}        sources         Aggregation metadata
 * @property {DraftStrengthCandidate[]} strengthCandidates Behavioral strength patterns
 * @property {DraftExperienceSummary[]} experienceSummaries Per-company summaries
 * @property {string}                 suggestedSummary    Proposed professional summary
 * @property {string[]}               dataGaps        Areas where more evidence is needed
 */

/**
 * @typedef {Object} DraftSourceMeta
 * @property {string[]} dates        All work log dates included
 * @property {number}   commitCount  Total git commits analyzed
 * @property {number}   sessionCount Total AI session snippets included
 * @property {number}   slackCount   Total Slack messages included
 * @property {string[]} repos        Distinct repositories referenced
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a resume draft from aggregated work log data.
 *
 * @param {Object} options
 * @param {string}  [options.fromDate]      Oldest date to include (YYYY-MM-DD). Defaults to 90 days ago.
 * @param {string}  [options.toDate]        Newest date to include (YYYY-MM-DD). Defaults to today.
 * @param {object}  [options.existingResume] Existing resume document for context (optional).
 * @returns {Promise<ResumeDraft>}
 */
export async function generateResumeDraft({ fromDate, toDate, existingResume } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set — cannot generate resume draft");
  }
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    throw new Error("OpenAI integration is disabled (WORK_LOG_DISABLE_OPENAI=1)");
  }

  // ── Step 1: Load work logs for the date range ─────────────────────────────
  const workLogs = await loadWorkLogs({ fromDate, toDate });
  if (workLogs.length === 0) {
    throw new Error("No work log data found for the specified date range");
  }

  // ── Step 2: Aggregate signals ─────────────────────────────────────────────
  const aggregated = aggregateSignals(workLogs);

  // ── Step 3: LLM call ──────────────────────────────────────────────────────
  const lang = existingResume?.meta?.language || "ko";
  const payload = buildDraftGenerationPayload(aggregated, existingResume, lang);

  console.info(
    `[resumeDraftGeneration] Calling LLM: model=${OPENAI_MODEL}` +
    ` dates=${workLogs.length}` +
    ` commits=${aggregated.commitCount}` +
    ` sessions=${aggregated.sessionCount}` +
    ` slack=${aggregated.slackCount}` +
    ` signalChars=${aggregated.signalText.length}`
  );

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
      `Resume draft generation LLM call failed: ${response.status} ${errorText.slice(0, 400)}`
    );
  }

  const data = await response.json();
  const rawText = data.output_text || extractOutputText(data);
  if (!rawText) {
    throw new Error("Resume draft generation LLM call returned empty output");
  }

  const parsed = JSON.parse(rawText);

  // ── Step 4: Shape the result ──────────────────────────────────────────────
  const now = new Date().toISOString();
  const dates = workLogs.map((wl) => wl.date);

  /** @type {ResumeDraft} */
  const draft = {
    schemaVersion: 1,
    generatedAt: now,
    dateRange: {
      from: dates[dates.length - 1],
      to: dates[0]
    },
    sources: {
      dates,
      commitCount: aggregated.commitCount,
      sessionCount: aggregated.sessionCount,
      slackCount: aggregated.slackCount,
      repos: aggregated.repos
    },
    strengthCandidates: normalizeCandidates(parsed.strength_candidates ?? []),
    experienceSummaries: normalizeExperienceSummaries(
      parsed.experience_summaries ?? [],
      workLogs
    ),
    suggestedSummary: String(parsed.suggested_summary ?? "").trim(),
    dataGaps: Array.isArray(parsed.data_gaps)
      ? parsed.data_gaps.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
      : []
  };

  return draft;
}

// ─── Work log loading ─────────────────────────────────────────────────────────

/**
 * Load daily work log JSON files from data/daily/ for the given date range.
 *
 * Files are loaded in descending date order (newest first).
 * Missing files are silently skipped.
 *
 * @param {Object} opts
 * @param {string} [opts.fromDate]  Oldest date (YYYY-MM-DD). Defaults to 90 days ago.
 * @param {string} [opts.toDate]    Newest date (YYYY-MM-DD). Defaults to today.
 * @returns {Promise<object[]>}     Array of parsed daily work log objects
 */
export async function loadWorkLogs({ fromDate, toDate } = {}) {
  const config = await loadConfig();
  const dailyDir = path.join(config.dataDir, "daily");

  if (!(await fileExists(dailyDir))) return [];

  const entries = await fs.readdir(dailyDir);
  const allDates = entries
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .reverse(); // newest first

  // Apply date range filter
  const effectiveTo = toDate || _todayISO();
  const effectiveFrom = fromDate || _daysAgoISO(MAX_DATES);

  const filtered = allDates
    .filter((d) => d >= effectiveFrom && d <= effectiveTo)
    .slice(0, MAX_DATES);

  const workLogs = [];
  for (const date of filtered) {
    const filePath = path.join(dailyDir, `${date}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      workLogs.push(parsed);
    } catch {
      // Silently skip corrupt/missing files
    }
  }

  return workLogs;
}

// ─── Signal aggregation ────────────────────────────────────────────────────────

/**
 * Aggregate signals from multiple work log records into a compact text block
 * suitable for LLM processing.
 *
 * @param {object[]} workLogs  Array of daily work log records
 * @returns {{ signalText: string, commitCount: number, sessionCount: number, slackCount: number, repos: string[] }}
 */
export function aggregateSignals(workLogs) {
  let commitCount = 0;
  let sessionCount = 0;
  let slackCount = 0;
  const repoSet = new Set();
  const parts = [];

  for (const wl of workLogs) {
    const date = wl.date ?? "unknown";
    const highlights = wl.highlights ?? {};
    const counts = wl.counts ?? {};

    commitCount += counts.gitCommits ?? 0;
    sessionCount += (counts.codexSessions ?? 0) + (counts.claudeSessions ?? 0);
    slackCount += counts.slackContexts ?? 0;

    // Collect repo names from story threads and commit analysis
    const storyThreads = highlights.storyThreads ?? [];
    for (const t of storyThreads) {
      if (t.repo) repoSet.add(t.repo);
    }

    // Build compact signal block for this date
    const dateParts = [`## ${date}`];

    // Business outcomes (most valuable signal)
    const outcomes = highlights.businessOutcomes ?? highlights.mainWork ?? [];
    if (outcomes.length > 0) {
      dateParts.push(`결과: ${outcomes.slice(0, 3).join(" | ")}`);
    }

    // Key changes
    const changes = highlights.keyChanges ?? [];
    if (changes.length > 0) {
      dateParts.push(`변경: ${changes.slice(0, 3).join(" | ")}`);
    }

    // Working style signals (behavioral evidence)
    const styleSignals = highlights.workingStyleSignals ?? [];
    if (styleSignals.length > 0) {
      dateParts.push(`작업스타일: ${styleSignals.slice(0, 3).join(" | ")}`);
    }

    // Story threads (per-repo context)
    for (const t of storyThreads.slice(0, 3)) {
      if (t.repo && (t.outcome || t.keyChange)) {
        const line = [`[${t.repo}]`];
        if (t.outcome) line.push(`결과: ${t.outcome}`);
        if (t.keyChange) line.push(`변경: ${t.keyChange}`);
        if (t.why) line.push(`이유: ${t.why}`);
        if (t.decision) line.push(`결정: ${t.decision}`);
        dateParts.push(line.join(" "));
      }
    }

    // Commit analysis
    const commitAnalysis = highlights.commitAnalysis ?? [];
    if (commitAnalysis.length > 0) {
      dateParts.push(`커밋분석: ${commitAnalysis.slice(0, 2).join(" | ")}`);
    }

    // Impact
    const impact = highlights.impact ?? [];
    if (impact.length > 0) {
      dateParts.push(`임팩트: ${impact.slice(0, 2).join(" | ")}`);
    }

    // AI review (session memory)
    const aiReview = highlights.aiReview ?? [];
    if (aiReview.length > 0) {
      dateParts.push(`세션메모: ${aiReview.slice(0, 2).join(" | ")}`);
      sessionCount += aiReview.length; // approximate session content count
    }

    // Resume candidates from batch (pre-extracted bullet candidates)
    const resume = wl.resume ?? {};
    const candidates = [
      ...(resume.candidates ?? []).slice(0, 3),
      ...(resume.companyCandidates ?? []).slice(0, 3)
    ];
    if (candidates.length > 0) {
      dateParts.push(`이력서후보: ${candidates.join(" | ")}`);
    }

    // Raw commit subjects (per-project, detailed work evidence)
    const projects = wl.projects ?? [];
    for (const project of projects.slice(0, 3)) {
      const repo = project.repo ?? "";
      const commitSubjects = (project.commits ?? [])
        .slice(0, 4)
        .map((c) => c.subject ?? "")
        .filter((s) => s.length >= 10);
      if (commitSubjects.length > 0) {
        dateParts.push(`[${repo}] 커밋: ${commitSubjects.join(" | ")}`);
      }
    }

    parts.push(dateParts.join("\n"));
  }

  // Truncate to stay within limit
  let signalText = parts.join("\n\n");
  if (signalText.length > SIGNAL_TEXT_LIMIT) {
    signalText = signalText.slice(0, SIGNAL_TEXT_LIMIT) + "\n[...이하 생략]";
  }

  return {
    signalText,
    commitCount,
    sessionCount,
    slackCount,
    repos: Array.from(repoSet)
  };
}

// ─── LLM payload builder ──────────────────────────────────────────────────────

/**
 * Build the LLM request payload for draft generation.
 */
function buildDraftGenerationPayload(aggregated, existingResume, lang) {
  const systemPrompt = buildSystemPrompt(lang);
  const userMessage = buildUserMessage(aggregated, existingResume, lang);

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "resume_draft",
        strict: true,
        schema: DRAFT_OUTPUT_SCHEMA
      }
    },
    max_output_tokens: 3000,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }]
      }
    ]
  };
}

function buildSystemPrompt(lang) {
  const isKorean = lang === "ko";
  return `\
You analyze developer work logs to extract strength candidates and experience summaries for resume refinement.

━━━ YOUR ROLE ━━━
You receive aggregated signals from a developer's work logs (git commits, AI session notes, Slack messages).
Your job is to identify:
1. BEHAVIORAL STRENGTHS — recurring patterns that show professional capability (NOT skill keywords)
2. EXPERIENCE SUMMARIES — per-company/project highlights with achievement-oriented bullets
3. A PROFESSIONAL SUMMARY — 2-3 sentence synthesis of the developer's professional identity

━━━ STRICT RULES ━━━
• Only state what is DIRECTLY supported by the evidence provided.
• If evidence is sparse for a claim, list it in data_gaps instead.
• Strengths must be BEHAVIORAL (e.g. "안정성 우선 설계" not "React").
• Each strength must appear in ≥2 distinct work log entries to qualify.
• Bullets must be achievement-oriented: outcome + method + impact.
• ${isKorean ? "Output all text in Korean." : "Output all text in English."}
• Do NOT invent company names, projects, or outcomes not in the evidence.

━━━ STRENGTH IDENTIFICATION CRITERIA ━━━
A strength qualifies when:
  - It appears across multiple dates (frequency ≥ 2)
  - It describes a behavior/pattern, not a technology
  - It can be backed by 1-3 concrete evidence snippets

Examples of valid strength labels:
  - "운영 안정성 우선 개선" (not "Redis" or "Kubernetes")
  - "온보딩 마찰 체계적 제거"
  - "실패 지점 선제적 격리"

━━━ DATA GAPS ━━━
List areas where you lack evidence to make reliable claims. Examples:
  - "X 회사에서의 팀 규모나 영향 범위에 대한 정보가 없음"
  - "기술적 결정의 배경 이유가 불충분"

These gaps will be surfaced to the user as conversation prompts.`;
}

function buildUserMessage(aggregated, existingResume, lang) {
  const parts = [];

  parts.push("# 업무 로그 데이터\n");
  parts.push(aggregated.signalText);

  if (existingResume) {
    parts.push("\n\n# 기존 이력서 컨텍스트 (참고용)");
    const companies = (existingResume.experience ?? [])
      .map((e) => `${e.company} (${e.title || ""}): ${e.start_date || "?"}~${e.end_date || "현재"}`)
      .join("\n");
    if (companies) parts.push(`경력:\n${companies}`);
    if (existingResume.summary) parts.push(`기존 요약: ${existingResume.summary}`);
  }

  parts.push(
    "\n\n위 업무 로그 데이터에서 이력서 초안 생성에 필요한 강점 후보와 경력별 경험 요약을 추출해 주세요."
  );

  return parts.join("\n");
}

// ─── Output schema ────────────────────────────────────────────────────────────

const DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "strength_candidates",
    "experience_summaries",
    "suggested_summary",
    "data_gaps"
  ],
  properties: {
    strength_candidates: {
      type: "array",
      minItems: 0,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "description", "frequency", "behavior_cluster", "evidence_examples"],
        properties: {
          label: { type: "string" },
          description: { type: "string" },
          frequency: { type: "number" },
          behavior_cluster: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 5
          },
          evidence_examples: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 3
          }
        }
      }
    },
    experience_summaries: {
      type: "array",
      minItems: 0,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company", "highlights", "skills", "suggested_bullets"],
        properties: {
          company: { type: "string" },
          highlights: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 4
          },
          skills: {
            type: "array",
            items: { type: "string" },
            minItems: 0,
            maxItems: 10
          },
          suggested_bullets: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 5
          }
        }
      }
    },
    suggested_summary: { type: "string" },
    data_gaps: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 5
    }
  }
};

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize LLM-returned strength candidates into typed DraftStrengthCandidate objects.
 *
 * @param {object[]} raw
 * @returns {DraftStrengthCandidate[]}
 */
function normalizeCandidates(raw) {
  return raw
    .filter((c) => c && typeof c.label === "string" && c.label.trim())
    .map((c, i) => ({
      id: `str-cand-${i}`,
      label: String(c.label).trim(),
      description: String(c.description ?? "").trim(),
      frequency: typeof c.frequency === "number" ? Math.round(c.frequency) : 1,
      behaviorCluster: Array.isArray(c.behavior_cluster)
        ? c.behavior_cluster.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
        : [],
      evidenceExamples: Array.isArray(c.evidence_examples)
        ? c.evidence_examples.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
        : [],
      dates: []
    }));
}

/**
 * Normalize LLM-returned experience summaries into typed DraftExperienceSummary objects.
 * Associates dates from work logs that mention each company/repo.
 *
 * @param {object[]} raw
 * @param {object[]} workLogs
 * @returns {DraftExperienceSummary[]}
 */
function normalizeExperienceSummaries(raw, workLogs) {
  return raw
    .filter((s) => s && typeof s.company === "string" && s.company.trim())
    .map((s) => {
      const company = String(s.company).trim();

      // Find dates where this company/repo was active
      const dates = workLogs
        .filter((wl) => {
          const threads = wl.highlights?.storyThreads ?? [];
          const commitAnalysis = wl.highlights?.commitAnalysis ?? [];
          const text = JSON.stringify({ threads, commitAnalysis }).toLowerCase();
          return text.includes(company.toLowerCase());
        })
        .map((wl) => wl.date)
        .filter(Boolean);

      return {
        company,
        highlights: Array.isArray(s.highlights)
          ? s.highlights.filter((h) => typeof h === "string" && h.trim()).map((h) => h.trim())
          : [],
        skills: Array.isArray(s.skills)
          ? s.skills.filter((sk) => typeof sk === "string" && sk.trim()).map((sk) => sk.trim())
          : [],
        suggestedBullets: Array.isArray(s.suggested_bullets)
          ? s.suggested_bullets.filter((b) => typeof b === "string" && b.trim()).map((b) => b.trim())
          : [],
        dates
      };
    });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function _todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function _daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function extractOutputText(data) {
  if (data?.output_text) return data.output_text;
  if (Array.isArray(data?.output)) {
    for (const block of data.output) {
      if (block?.type === "message" && Array.isArray(block?.content)) {
        for (const part of block.content) {
          if (part?.type === "output_text" && part?.text) return part.text;
          if (part?.type === "text" && part?.text) return part.text;
        }
      }
    }
  }
  return null;
}
