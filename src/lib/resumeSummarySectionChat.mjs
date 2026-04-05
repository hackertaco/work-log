/**
 * resumeSummarySectionChat.mjs
 *
 * 자기소개(Summary) 섹션 채팅 기반 구체화 모듈 (Sub-AC 8-1).
 *
 * 사용자가 채팅에서 자기소개 섹션 수정을 요청할 때,
 * 커밋/슬랙/세션 메모리 근거를 바탕으로 전문적인 자기소개 문단을 제안한다.
 *
 * 핵심 원칙:
 *   - 근거 없이 허구를 생성하지 않는다
 *   - 데이터 부족 시 사용자에게 보충 질문을 반환한다
 *   - 기존 자기소개(before)와 제안(after)의 diff 형태로 반환한다
 *
 * 공개 API:
 *   generateSummaryChatDiff(query, rankedEvidence, existingResume, options)
 *     → Promise<SummaryChatDiffResult>
 *
 * SummaryChatDiffResult:
 *   {
 *     hasEnoughEvidence: boolean,
 *     section: 'summary',
 *     before: string,              // 현재 자기소개 (없으면 빈 문자열)
 *     after: string,               // 제안된 자기소개
 *     evidence: string[],          // 사용된 근거 텍스트 목록
 *     followUpQuestions: string[], // 보충 질문 (데이터 부족 시)
 *     dataGaps: string[],          // 근거 부족 영역
 *   }
 *
 * 환경 변수:
 *   OPENAI_API_KEY           — 필수 (없으면 heuristic fallback)
 *   WORK_LOG_OPENAI_URL      — 기본값: https://api.openai.com/v1/responses
 *   WORK_LOG_OPENAI_MODEL    — 기본값: gpt-5.4-mini
 *   WORK_LOG_DISABLE_OPENAI  — "1" 이면 LLM 호출 비활성화
 */

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL =
  process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/** 자기소개 생성에 필요한 최소 근거 건수 */
const MIN_EVIDENCE_FOR_SUMMARY = 1;

/** 자기소개 최대 길이 (characters) */
const MAX_SUMMARY_CHARS = 800;

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 랭킹된 근거를 바탕으로 자기소개 섹션 diff를 생성한다.
 *
 * 근거가 MIN_EVIDENCE_FOR_SUMMARY 건 미만이면 LLM을 호출하지 않고
 * followUpQuestions만 포함한 결과를 반환한다.
 *
 * @param {string} query  사용자 원본 질의
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @param {object|null} existingResume  현재 이력서 문서 (현재 요약 추출용)
 * @param {{
 *   lang?: 'ko' | 'en',
 *   maxEvidenceItems?: number,
 * }} [options]
 * @returns {Promise<SummaryChatDiffResult>}
 */
export async function generateSummaryChatDiff(query, rankedEvidence, existingResume, options = {}) {
  const { lang = "ko", maxEvidenceItems = 10 } = options;

  const currentSummary = typeof existingResume?.summary === "string"
    ? existingResume.summary.trim()
    : "";

  // ── 근거 부족 시 조기 반환 ──────────────────────────────────────────────────
  if (!rankedEvidence || rankedEvidence.length < MIN_EVIDENCE_FOR_SUMMARY) {
    return {
      hasEnoughEvidence: false,
      section: "summary",
      before: currentSummary,
      after: "",
      evidence: [],
      dataGaps: ["업무 기록에서 자기소개를 작성할 근거를 찾지 못했습니다."],
      followUpQuestions: [
        "어떤 기간이나 프로젝트의 경험을 자기소개에 포함하고 싶으신가요?",
        "자기소개에서 특별히 강조하고 싶은 역할이나 기술이 있나요?",
        "현재 자기소개의 어떤 부분을 개선하고 싶으신가요?",
      ],
    };
  }

  // ── OpenAI 비활성화 시 heuristic 결과 반환 ─────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return buildHeuristicSummaryDiff(query, rankedEvidence, currentSummary);
  }

  // ── LLM 호출 ───────────────────────────────────────────────────────────────
  const evidenceContext = _buildEvidenceContext(rankedEvidence.slice(0, maxEvidenceItems));
  const systemPrompt = _buildSystemPrompt(lang);
  const userMessage = _buildUserMessage({ query, evidenceContext, currentSummary, lang });

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "summary_diff_result",
        strict: true,
        schema: SUMMARY_DIFF_SCHEMA,
      },
    },
    max_output_tokens: 1000,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }],
      },
    ],
  };

  let data;
  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Summary LLM call failed: ${response.status} ${errText.slice(0, 400)}`);
    }

    data = await response.json();
  } catch (err) {
    console.warn("[resumeSummarySectionChat] LLM call failed, using heuristic:", err.message);
    return buildHeuristicSummaryDiff(query, rankedEvidence, currentSummary);
  }

  const rawText = data?.output_text || _extractOutputText(data);
  if (!rawText) {
    console.warn("[resumeSummarySectionChat] LLM returned empty output, using heuristic");
    return buildHeuristicSummaryDiff(query, rankedEvidence, currentSummary);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.warn("[resumeSummarySectionChat] Failed to parse LLM JSON, using heuristic");
    return buildHeuristicSummaryDiff(query, rankedEvidence, currentSummary);
  }

  return _normalizeSummaryResult(parsed, currentSummary, rankedEvidence);
}

// ─── LLM 페이로드 빌더 ────────────────────────────────────────────────────────

/**
 * @param {'ko'|'en'} lang
 */
function _buildSystemPrompt(lang) {
  const isKorean = lang === "ko";
  return `\
You are a professional resume writer specializing in crafting compelling professional summaries (자기소개).

━━━ YOUR TASK ━━━
Generate a professional summary paragraph for a resume, based ONLY on provided work evidence.

━━━ STRICT RULES ━━━
• Only include claims DIRECTLY supported by the provided evidence.
• Do NOT invent job titles, company names, metrics, or achievements not in the evidence.
• If evidence is insufficient, list data_gaps and follow_up_questions instead.
• The summary must be 2–4 sentences (${isKorean ? "Korean" : "English"}).
• Focus on: core expertise, key achievements, professional identity.
• Use active, achievement-oriented language.
• ${isKorean ? "Write all text in Korean." : "Write all text in English."}

━━━ PROFESSIONAL SUMMARY CRITERIA ━━━
A good summary:
  - Opens with a strong professional identity statement
  - Highlights 1–2 key technical strengths backed by evidence
  - Mentions a notable impact or outcome
  - Closes with career goal or value proposition

━━━ DATA GAPS ━━━
If evidence lacks: job title, key technology, company context, or impact metrics,
list these as data_gaps and ask targeted follow-up questions.

━━━ OUTPUT FORMAT ━━━
Return JSON matching the schema provided. If enough evidence exists, set has_enough_evidence=true
and provide proposed_summary. Otherwise set has_enough_evidence=false and fill data_gaps.`;
}

/**
 * @param {{ query: string, evidenceContext: string, currentSummary: string, lang: string }} opts
 */
function _buildUserMessage({ query, evidenceContext, currentSummary, lang }) {
  const parts = [];

  parts.push(`# 사용자 요청\n${query}\n`);

  if (currentSummary) {
    parts.push(`# 기존 자기소개\n${currentSummary}\n`);
  } else {
    parts.push("# 기존 자기소개\n(없음 — 신규 작성)\n");
  }

  parts.push(`# 업무 기록 근거 데이터 (랭킹 순)\n${evidenceContext || "(근거 없음)"}\n`);

  parts.push(
    lang === "ko"
      ? "위 근거 데이터를 바탕으로 전문적인 자기소개를 작성해 주세요.\n" +
        "근거가 부족한 부분은 data_gaps와 follow_up_questions에 기재해 주세요."
      : "Based on the evidence above, write a professional summary.\n" +
        "List any gaps in evidence as data_gaps and follow_up_questions."
  );

  return parts.join("\n");
}

// ─── 출력 스키마 ──────────────────────────────────────────────────────────────

const SUMMARY_DIFF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["has_enough_evidence", "proposed_summary", "evidence_texts", "data_gaps", "follow_up_questions"],
  properties: {
    has_enough_evidence: { type: "boolean" },
    proposed_summary: { type: "string" },
    evidence_texts: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 5,
    },
    data_gaps: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 5,
    },
    follow_up_questions: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 3,
    },
  },
};

// ─── 결과 정규화 ──────────────────────────────────────────────────────────────

/**
 * @param {object} parsed  LLM JSON output
 * @param {string} currentSummary
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @returns {SummaryChatDiffResult}
 */
function _normalizeSummaryResult(parsed, currentSummary, rankedEvidence) {
  const hasEnough = parsed.has_enough_evidence === true;
  const proposedSummary = typeof parsed.proposed_summary === "string"
    ? parsed.proposed_summary.trim().slice(0, MAX_SUMMARY_CHARS)
    : "";

  if (!hasEnough || !proposedSummary) {
    return {
      hasEnoughEvidence: false,
      section: "summary",
      before: currentSummary,
      after: "",
      evidence: [],
      dataGaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps.filter(Boolean) : [],
      followUpQuestions: Array.isArray(parsed.follow_up_questions)
        ? parsed.follow_up_questions.filter(Boolean)
        : [],
    };
  }

  const evidenceTexts = Array.isArray(parsed.evidence_texts)
    ? parsed.evidence_texts.filter(Boolean).slice(0, 5)
    : [];

  return {
    hasEnoughEvidence: true,
    section: "summary",
    before: currentSummary,
    after: proposedSummary,
    evidence: evidenceTexts,
    dataGaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps.filter(Boolean) : [],
    followUpQuestions: Array.isArray(parsed.follow_up_questions)
      ? parsed.follow_up_questions.filter(Boolean)
      : [],
  };
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────

/**
 * OpenAI 비활성화 또는 LLM 오류 시 사용하는 heuristic 결과.
 * 근거 텍스트를 단순 조합해 초안 자기소개를 생성한다.
 *
 * @param {string} query
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @param {string} currentSummary
 * @returns {SummaryChatDiffResult}
 */
function buildHeuristicSummaryDiff(query, rankedEvidence, currentSummary) {
  const topItems = rankedEvidence.slice(0, 3);
  const evidenceTexts = topItems.map((r) => r.text).filter(Boolean);

  // 단순 heuristic: 근거를 나열한 요약 초안
  const proposedSummary = evidenceTexts.length > 0
    ? `다양한 프로젝트에서 기술 역량을 발휘하며 성과를 달성했습니다. ` +
      `${evidenceTexts[0].slice(0, 100)}${evidenceTexts.length > 1 ? " 등 여러 업무를 수행했습니다." : "."}`
    : currentSummary;

  return {
    hasEnoughEvidence: evidenceTexts.length > 0,
    section: "summary",
    before: currentSummary,
    after: proposedSummary,
    evidence: evidenceTexts,
    dataGaps: [],
    followUpQuestions: [
      "이 초안을 더 구체적으로 개선하고 싶은 부분이 있으신가요?",
    ],
  };
}

// ─── 유틸리티 ─────────────────────────────────────────────────────────────────

/**
 * 랭킹된 근거를 LLM 프롬프트용 텍스트로 변환한다.
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @returns {string}
 */
function _buildEvidenceContext(rankedEvidence) {
  if (!rankedEvidence || rankedEvidence.length === 0) return "";

  const SOURCE_LABELS = { commits: "커밋", slack: "슬랙", session: "세션", sessions: "세션" };

  return rankedEvidence.map((r, i) => {
    const rankIdx = r.rank ?? (i + 1);
    const label = SOURCE_LABELS[r.source] ?? r.source;
    const date = r.date ?? "?";
    const text = (r.text ?? "").trim().slice(0, 200);
    return `[${rankIdx}][${label}] ${date} | ${text}`;
  }).join("\n");
}

/**
 * OpenAI Responses API 출력에서 텍스트를 추출한다.
 * @param {object} data
 * @returns {string|null}
 */
function _extractOutputText(data) {
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === "output_text" && typeof part.text === "string") {
            return part.text;
          }
        }
      }
    }
  }
  return null;
}

// ─── JSDoc 타입 ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SummaryChatDiffResult
 * @property {boolean}  hasEnoughEvidence  근거 충분 여부
 * @property {'summary'} section           항상 'summary'
 * @property {string}   before             현재 자기소개 (없으면 빈 문자열)
 * @property {string}   after              제안된 자기소개 (hasEnoughEvidence=false 시 빈 문자열)
 * @property {string[]} evidence           사용된 근거 텍스트 목록
 * @property {string[]} dataGaps           근거 부족 영역
 * @property {string[]} followUpQuestions  보충 질문 목록
 */
