/**
 * resumeSummarySectionPrompt.mjs
 *
 * 자기소개(Summary) 및 강점(Strengths) 섹션 전용 LLM 프롬프트 템플릿 및 생성 로직.
 *
 * Sub-AC 8-1 구현
 *
 * ─── 주요 함수 ─────────────────────────────────────────────────────────────────
 *
 *   generateSectionRefinement(section, query, rankedEvidence, existingResume, options)
 *     summary 또는 strengths 섹션을 근거 데이터 기반으로 LLM을 통해 정제하고
 *     before/after diff 형태의 결과를 반환한다.
 *     → SectionRefinementResult
 *
 *   buildSummaryRefinementPayload(opts)
 *     자기소개 섹션 정제 LLM 페이로드를 구성한다 (공개, 테스트 가능).
 *     → OpenAI Responses API 요청 body
 *
 *   buildStrengthsRefinementPayload(opts)
 *     강점 키워드 섹션 정제 LLM 페이로드를 구성한다 (공개, 테스트 가능).
 *     → OpenAI Responses API 요청 body
 *
 * ─── 타입 ─────────────────────────────────────────────────────────────────────
 *
 *   SectionRefinementResult — {
 *     section:           'summary' | 'strengths',
 *     before:            string,    // 정제 전 텍스트
 *     after:             string,    // 정제 후 텍스트 (PATCH /api/resume/section content)
 *     reasoning:         string,    // 변경 이유 요약 (evidence 기반)
 *     followUpQuestions: string[],  // 데이터 부족 시 보충 질문
 *     dataGaps:          string[],  // 근거가 부족한 부분
 *     evidenceUsed:      number,    // 사용된 근거 건수
 *   }
 *
 * ─── 환경 변수 ────────────────────────────────────────────────────────────────
 *
 *   OPENAI_API_KEY           — 필수
 *   WORK_LOG_OPENAI_URL      — 기본값: https://api.openai.com/v1/responses
 *   WORK_LOG_OPENAI_MODEL    — 기본값: gpt-5.4-mini
 *   WORK_LOG_DISABLE_OPENAI  — "1" 이면 LLM 호출 비활성화 (heuristic 반환)
 */

import { buildEvidenceContext } from "./resumeAppealPoints.mjs";

// ─── 상수 ─────────────────────────────────────────────────────────────────────

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL =
  process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/** summary 정제 시 최대 토큰 수 */
const SUMMARY_MAX_OUTPUT_TOKENS = 800;

/** strengths 정제 시 최대 토큰 수 */
const STRENGTHS_MAX_OUTPUT_TOKENS = 600;

/** 최소 근거 건수 — 이 미만이면 followUpQuestions 만 반환하고 LLM 을 호출하지 않는다 */
const MIN_EVIDENCE_FOR_REFINEMENT = 1;

// ─── JSON 스키마 ──────────────────────────────────────────────────────────────

/** summary 정제 LLM 출력 스키마 */
const SUMMARY_REFINEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["after", "reasoning", "follow_up_questions", "data_gaps"],
  properties: {
    after: {
      type: "string",
      description: "정제된 자기소개 텍스트 (2–4 문장, 이력서에 바로 사용 가능한 형식)",
    },
    reasoning: {
      type: "string",
      description: "정제 이유 요약 (근거 데이터 기반, 1–2 문장)",
    },
    follow_up_questions: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 3,
      description: "데이터 부족 시 사용자에게 물어볼 보충 질문",
    },
    data_gaps: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 3,
      description: "근거가 부족한 영역",
    },
  },
};

/** strengths 정제 LLM 출력 스키마 */
const STRENGTHS_REFINEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["keywords", "reasoning", "follow_up_questions", "data_gaps"],
  properties: {
    keywords: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 20,
      description: "정제된 강점 키워드 목록 (각 항목은 1–4 단어, 이력서에 바로 사용 가능)",
    },
    reasoning: {
      type: "string",
      description: "키워드 선택 이유 요약 (근거 데이터 기반, 1–2 문장)",
    },
    follow_up_questions: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 3,
    },
    data_gaps: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 3,
    },
  },
};

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 자기소개(summary) 또는 강점(strengths) 섹션을 근거 데이터를 기반으로 정제하고
 * before/after diff 형태의 결과를 반환한다.
 *
 * 근거가 MIN_EVIDENCE_FOR_REFINEMENT 건 미만이면 LLM 을 호출하지 않고
 * followUpQuestions 만 포함한 결과를 반환한다.
 *
 * @param {'summary'|'strengths'} section
 * @param {string} query  사용자 원본 질의
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @param {object|null} existingResume
 * @param {{ lang?: 'ko'|'en' }} [options]
 * @returns {Promise<SectionRefinementResult>}
 */
export async function generateSectionRefinement(
  section,
  query,
  rankedEvidence,
  existingResume,
  options = {}
) {
  const { lang = "ko" } = options;

  // ── before 텍스트 추출 ─────────────────────────────────────────────────────
  const before = _extractCurrentSectionText(section, existingResume);

  // ── 근거 부족 시 조기 반환 ──────────────────────────────────────────────────
  if (!rankedEvidence || rankedEvidence.length < MIN_EVIDENCE_FOR_REFINEMENT) {
    const sectionLabel = section === "summary" ? "자기소개" : "강점";
    return {
      section,
      before,
      after: before,
      reasoning: "",
      followUpQuestions: [
        `${sectionLabel} 섹션을 개선하려면 관련 근거가 필요합니다. 어떤 키워드로 검색할까요?`,
        "구체적인 프로젝트, 기술, 또는 기간을 입력해 주시면 관련 기록을 찾아드립니다.",
      ],
      dataGaps: [`${sectionLabel} 섹션을 뒷받침할 근거 데이터가 없습니다.`],
      evidenceUsed: 0,
    };
  }

  // ── OpenAI 비활성화 시 heuristic 반환 ─────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return _buildHeuristicRefinement(section, before, rankedEvidence);
  }

  // ── LLM 호출 ──────────────────────────────────────────────────────────────
  const evidenceContext = buildEvidenceContext(rankedEvidence, 4_000);

  let payload;
  if (section === "summary") {
    payload = buildSummaryRefinementPayload({
      query,
      evidenceContext,
      existingResume,
      lang,
    });
  } else {
    payload = buildStrengthsRefinementPayload({
      query,
      evidenceContext,
      existingResume,
      lang,
    });
  }

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
      const errorText = await response.text();
      throw new Error(
        `Section refinement LLM call failed: ${response.status} ${errorText.slice(0, 400)}`
      );
    }

    data = await response.json();
  } catch (err) {
    console.warn(
      `[resumeSummarySectionPrompt] LLM call failed for section=${section}, using heuristic fallback:`,
      err.message
    );
    return _buildHeuristicRefinement(section, before, rankedEvidence);
  }

  const rawText = _extractOutputText(data);
  if (!rawText) {
    console.warn(
      `[resumeSummarySectionPrompt] LLM returned empty output for section=${section}, using heuristic fallback`
    );
    return _buildHeuristicRefinement(section, before, rankedEvidence);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.warn(
      `[resumeSummarySectionPrompt] Failed to parse LLM JSON for section=${section}, using heuristic fallback`
    );
    return _buildHeuristicRefinement(section, before, rankedEvidence);
  }

  return _normalizeResult(section, before, parsed, rankedEvidence.length);
}

/**
 * 자기소개 섹션 정제 LLM 페이로드를 구성한다.
 *
 * @param {{
 *   query: string,
 *   evidenceContext: string,
 *   existingResume?: object | null,
 *   lang?: 'ko' | 'en',
 * }} opts
 * @returns {object}  OpenAI Responses API 요청 body
 */
export function buildSummaryRefinementPayload({ query, evidenceContext, existingResume, lang = "ko" }) {
  const systemPrompt = _buildSummarySystemPrompt(lang);
  const userMessage = _buildSummaryUserMessage({
    query,
    evidenceContext,
    existingResume,
    lang,
  });

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "summary_refinement_result",
        strict: true,
        schema: SUMMARY_REFINEMENT_SCHEMA,
      },
    },
    max_output_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
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
}

/**
 * 강점 키워드 섹션 정제 LLM 페이로드를 구성한다.
 *
 * @param {{
 *   query: string,
 *   evidenceContext: string,
 *   existingResume?: object | null,
 *   lang?: 'ko' | 'en',
 * }} opts
 * @returns {object}  OpenAI Responses API 요청 body
 */
export function buildStrengthsRefinementPayload({ query, evidenceContext, existingResume, lang = "ko" }) {
  const systemPrompt = _buildStrengthsSystemPrompt(lang);
  const userMessage = _buildStrengthsUserMessage({
    query,
    evidenceContext,
    existingResume,
    lang,
  });

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "strengths_refinement_result",
        strict: true,
        schema: STRENGTHS_REFINEMENT_SCHEMA,
      },
    },
    max_output_tokens: STRENGTHS_MAX_OUTPUT_TOKENS,
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
}

// ─── 프롬프트 빌더 ────────────────────────────────────────────────────────────

function _buildSummarySystemPrompt(lang) {
  const isKorean = lang === "ko";
  return `\
You are a professional resume writer specializing in Korean tech industry resumes.
Your task: refine the professional summary section based on real work evidence.

━━━ YOUR ROLE ━━━
You receive:
1. The current professional summary (may be empty)
2. Ranked evidence records from real work data (commits, Slack, AI sessions)
3. The user's refinement request

Your job:
1. REFINED SUMMARY — a concise, evidence-backed professional summary (2–4 sentences)
2. REASONING — brief explanation of changes (1–2 sentences)
3. DATA GAPS — areas where evidence is insufficient
4. FOLLOW-UP QUESTIONS — questions to fill evidence gaps

━━━ STRICT RULES ━━━
• Only make claims DIRECTLY supported by the evidence provided.
• Do NOT invent job titles, companies, or accomplishments not in the evidence.
• ${isKorean ? "Output all text fields in Korean." : "Output all text fields in English."}
• The refined summary must be suitable for direct use in a resume.
• If evidence is sparse, explain what's missing and ask follow-up questions.

━━━ SUMMARY STRUCTURE ━━━
A strong professional summary includes:
  1. Professional identity (role + years of experience if available)
  2. Core technical strengths (backed by evidence)
  3. Key achievement or impact pattern (backed by evidence)
  4. Career direction (optional, if evident from evidence)

━━━ FORMAT ━━━
  - 2–4 sentences, first-person omitted (e.g., "백엔드 엔지니어로서…")
  - Professional, achievement-oriented language
  - Specific technologies only if backed by evidence
  - Korean: 한국어 이력서 표준 문체 사용`;
}

function _buildSummaryUserMessage({ query, evidenceContext, existingResume, lang }) {
  const parts = [];

  parts.push(`# 사용자 요청\n${query}\n`);

  if (existingResume?.summary) {
    parts.push(`# 현재 자기소개\n${existingResume.summary}\n`);
  } else {
    parts.push(`# 현재 자기소개\n(아직 작성되지 않음)\n`);
  }

  // 이력서 컨텍스트 (회사명, 직책 등)
  if (existingResume) {
    const companies = (existingResume.experience ?? [])
      .slice(0, 3)
      .map((e) => `  - ${e.company} (${e.title ?? "?"}, ${e.start_date ?? "?"}~${e.end_date ?? "현재"})`)
      .join("\n");
    if (companies) {
      parts.push(`# 경력 컨텍스트 (참고용)\n${companies}\n`);
    }

    const strengthKeywords = existingResume.strength_keywords;
    if (Array.isArray(strengthKeywords) && strengthKeywords.length > 0) {
      parts.push(`# 기존 강점 키워드 (참고용)\n${strengthKeywords.slice(0, 15).join(", ")}\n`);
    }
  }

  parts.push(`# 근거 데이터 (랭킹 순)\n${evidenceContext || "(근거 없음)"}\n`);

  parts.push(
    `위 근거 데이터를 바탕으로 자기소개(Professional Summary)를 정제해 주세요.\n` +
    `근거 없이 내용을 만들지 마세요. 근거가 부족하면 data_gaps와 follow_up_questions를 채워주세요.`
  );

  return parts.join("\n");
}

function _buildStrengthsSystemPrompt(lang) {
  const isKorean = lang === "ko";
  return `\
You are a professional resume writer specializing in Korean tech industry resumes.
Your task: identify and refine strength keywords based on real work evidence.

━━━ YOUR ROLE ━━━
You receive:
1. The current strength keyword list (may be empty)
2. Ranked evidence records from real work data (commits, Slack, AI sessions)
3. The user's refinement request

Your job:
1. REFINED KEYWORDS — an updated list of marketable strength keywords
2. REASONING — brief explanation of changes (1–2 sentences)
3. DATA GAPS — areas where evidence is insufficient
4. FOLLOW-UP QUESTIONS — questions to fill evidence gaps

━━━ STRICT RULES ━━━
• Only add keywords DIRECTLY supported by the evidence provided.
• Do NOT invent skills, behaviors, or traits not in the evidence.
• ${isKorean ? "Output all text fields in Korean." : "Output all text fields in English."}
• Each keyword must be 1–4 words, marketable, and specific.
• Preserve existing keywords that are still valid (don't remove without good reason).
• Merge or refine keywords when evidence supports consolidation.
• If evidence is sparse, ask follow-up questions.

━━━ KEYWORD CATEGORIES ━━━
Good strength keywords include:
  - Technical patterns: "분산 시스템 설계", "TypeScript", "CI/CD 구축"
  - Behavioral patterns: "코드 품질 개선", "시스템 안정성", "팀 협업"
  - Domain expertise: "핀테크 도메인", "백엔드 아키텍처"

Avoid:
  - Generic filler: "열정", "성실함"
  - Overly broad: "개발", "프로그래밍"
  - Unsupported claims

━━━ OUTPUT FORMAT ━━━
Return keywords as a clean list (no bullets, no numbers in the array itself).
Each item should be a concise phrase ready to display as a keyword tag.`;
}

function _buildStrengthsUserMessage({ query, evidenceContext, existingResume, lang }) {
  const parts = [];

  parts.push(`# 사용자 요청\n${query}\n`);

  const strengthKeywords = existingResume?.strength_keywords;
  if (Array.isArray(strengthKeywords) && strengthKeywords.length > 0) {
    parts.push(`# 현재 강점 키워드\n${strengthKeywords.join(", ")}\n`);
  } else {
    parts.push(`# 현재 강점 키워드\n(아직 없음)\n`);
  }

  // 이력서 컨텍스트 — 기술 스택과 경력
  if (existingResume) {
    const skills = existingResume.skills;
    if (skills) {
      const allSkills = [
        ...(Array.isArray(skills.technical) ? skills.technical : []),
        ...(Array.isArray(skills.languages) ? skills.languages : []),
        ...(Array.isArray(skills.tools) ? skills.tools : []),
      ];
      if (allSkills.length > 0) {
        parts.push(`# 기술 스택 (참고용)\n${allSkills.slice(0, 20).join(", ")}\n`);
      }
    }
    if (existingResume.summary) {
      parts.push(`# 자기소개 (참고용)\n${existingResume.summary}\n`);
    }
  }

  parts.push(`# 근거 데이터 (랭킹 순)\n${evidenceContext || "(근거 없음)"}\n`);

  parts.push(
    `위 근거 데이터를 바탕으로 강점 키워드 목록을 정제해 주세요.\n` +
    `근거 없는 키워드는 추가하지 마세요. 기존 키워드는 근거가 있으면 유지하고, 새로 발견된 강점은 추가해 주세요.\n` +
    `근거가 부족하면 data_gaps와 follow_up_questions를 채워주세요.`
  );

  return parts.join("\n");
}

// ─── 결과 정규화 ──────────────────────────────────────────────────────────────

/**
 * LLM 응답을 SectionRefinementResult 형태로 정규화한다.
 *
 * @param {'summary'|'strengths'} section
 * @param {string} before
 * @param {object} parsed   LLM 파싱된 JSON
 * @param {number} evidenceCount
 * @returns {SectionRefinementResult}
 */
function _normalizeResult(section, before, parsed, evidenceCount) {
  if (section === "summary") {
    const after = typeof parsed.after === "string" ? parsed.after.trim() : before;
    return {
      section,
      before,
      after,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "",
      followUpQuestions: Array.isArray(parsed.follow_up_questions)
        ? parsed.follow_up_questions.filter((q) => typeof q === "string" && q.trim())
        : [],
      dataGaps: Array.isArray(parsed.data_gaps)
        ? parsed.data_gaps.filter((g) => typeof g === "string" && g.trim())
        : [],
      evidenceUsed: evidenceCount,
    };
  }

  // strengths 섹션: keywords 배열을 불릿 텍스트로 변환
  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim())
    : [];
  const after = keywords.map((k) => `- ${k}`).join("\n");

  return {
    section,
    before,
    after,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "",
    followUpQuestions: Array.isArray(parsed.follow_up_questions)
      ? parsed.follow_up_questions.filter((q) => typeof q === "string" && q.trim())
      : [],
    dataGaps: Array.isArray(parsed.data_gaps)
      ? parsed.data_gaps.filter((g) => typeof g === "string" && g.trim())
      : [],
    evidenceUsed: evidenceCount,
  };
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────

/**
 * OpenAI 가 비활성화된 환경에서 근거 텍스트 기반으로 간단한 정제 결과를 반환한다.
 *
 * @param {'summary'|'strengths'} section
 * @param {string} before
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @returns {SectionRefinementResult}
 */
function _buildHeuristicRefinement(section, before, rankedEvidence) {
  const topTexts = rankedEvidence
    .slice(0, 3)
    .map((r) => r.text ?? "")
    .filter(Boolean);

  if (section === "summary") {
    const after = before || topTexts.slice(0, 2).join(" ").slice(0, 200);
    return {
      section,
      before,
      after,
      reasoning: `근거 데이터 ${rankedEvidence.length}건을 기반으로 요약을 생성했습니다.`,
      followUpQuestions: [],
      dataGaps: [],
      evidenceUsed: rankedEvidence.length,
    };
  }

  // strengths: 근거 텍스트에서 짧은 구문을 키워드로 추출
  const existingBefore = before
    ? before.split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean)
    : [];

  const after = existingBefore.length > 0 ? before : topTexts.slice(0, 5).map((t) => `- ${t.slice(0, 40)}`).join("\n");

  return {
    section,
    before,
    after,
    reasoning: `근거 데이터 ${rankedEvidence.length}건을 기반으로 강점 키워드를 제안했습니다.`,
    followUpQuestions: [],
    dataGaps: [],
    evidenceUsed: rankedEvidence.length,
  };
}

// ─── 내부 유틸 ────────────────────────────────────────────────────────────────

/**
 * 이력서 문서에서 섹션의 현재 텍스트를 추출한다.
 *
 * @param {'summary'|'strengths'} section
 * @param {object|null} existingResume
 * @returns {string}
 */
function _extractCurrentSectionText(section, existingResume) {
  if (!existingResume) return "";

  if (section === "summary") {
    return typeof existingResume.summary === "string" ? existingResume.summary : "";
  }

  if (section === "strengths") {
    const kw = Array.isArray(existingResume.strength_keywords)
      ? existingResume.strength_keywords
      : [];
    return kw.map((k) => `- ${k}`).join("\n");
  }

  return "";
}

/**
 * OpenAI Responses API 응답에서 텍스트 출력을 추출한다.
 *
 * @param {object} data
 * @returns {string|null}
 */
function _extractOutputText(data) {
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
