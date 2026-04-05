/**
 * resumeExperienceSectionChat.mjs
 *
 * 경력(Experience) 섹션 채팅 기반 구체화 모듈 (Sub-AC 8-2).
 *
 * 사용자가 채팅에서 경력 섹션 수정을 요청할 때,
 * 커밋/슬랙/세션 메모리 근거를 바탕으로 경력 항목의 불릿(업무 성과)을 제안하거나
 * 새로운 경력 항목을 생성한다.
 *
 * 핵심 원칙:
 *   - 근거 없이 허구를 생성하지 않는다
 *   - 데이터 부족 시 사용자에게 보충 질문을 반환한다
 *   - 기존 경력(before)과 제안(after)의 diff 형태로 반환한다
 *   - 기존 경력 항목의 회사명을 기준으로 근거를 매핑한다
 *   - 기존 항목이 없거나 새 회사면 create_entry 제안을 반환한다
 *
 * 공개 API:
 *   generateExperienceChatDiff(query, rankedEvidence, existingResume, options)
 *     → Promise<ExperienceChatDiffResult>
 *   formatExperienceAsText(experience)
 *     → string  (경력 목록을 사람이 읽을 수 있는 텍스트로 변환)
 *
 * ExperienceChatDiffResult:
 *   {
 *     hasEnoughEvidence: boolean,
 *     section: 'experience',
 *     before: string,                    // 현재 경력의 텍스트 표현
 *     after: string,                     // 제안된 변경의 JSON 직렬화
 *     evidence: string[],                // 사용된 근거 텍스트 목록
 *     experienceData: ExperienceChange[], // 구조화된 변경 목록 (UI 렌더링용)
 *     followUpQuestions: string[],       // 보충 질문 (데이터 부족 시)
 *     dataGaps: string[],               // 근거 부족 영역
 *   }
 *
 * ExperienceChange:
 *   {
 *     id: string,                  // "exp-{index}"
 *     company: string,             // 회사명
 *     title: string,               // 직책
 *     startDate: string|null,      // YYYY-MM
 *     endDate: string|null,        // YYYY-MM | "present"
 *     action: 'add_bullets' | 'create_entry',
 *     bullets: string[],           // 추가할 불릿 목록
 *     confidence: number,          // 0.0–1.0
 *     evidenceTexts: string[],     // 근거 텍스트 (1–3건)
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

/** 경력 항목 생성에 필요한 최소 근거 건수 */
const MIN_EVIDENCE_FOR_EXPERIENCE = 1;

/** 경력 항목당 최대 불릿 수 */
const MAX_BULLETS_PER_ENTRY = 6;

/** 최대 경력 변경 항목 수 */
const MAX_EXPERIENCE_CHANGES = 4;

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 랭킹된 근거를 바탕으로 경력 섹션 diff를 생성한다.
 *
 * 근거가 MIN_EVIDENCE_FOR_EXPERIENCE 건 미만이면 LLM을 호출하지 않고
 * followUpQuestions만 포함한 결과를 반환한다.
 *
 * @param {string} query  사용자 원본 질의
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @param {object|null} existingResume  현재 이력서 문서
 * @param {{
 *   lang?: 'ko' | 'en',
 *   maxEvidenceItems?: number,
 * }} [options]
 * @returns {Promise<ExperienceChatDiffResult>}
 */
export async function generateExperienceChatDiff(query, rankedEvidence, existingResume, options = {}) {
  const { lang = "ko", maxEvidenceItems = 12 } = options;

  // 현재 경력 항목 추출 및 텍스트 표현
  const currentExperience = Array.isArray(existingResume?.experience)
    ? existingResume.experience
    : [];
  const currentExpText = formatExperienceAsText(currentExperience);

  // ── 근거 부족 시 조기 반환 ──────────────────────────────────────────────────
  if (!rankedEvidence || rankedEvidence.length < MIN_EVIDENCE_FOR_EXPERIENCE) {
    return {
      hasEnoughEvidence: false,
      section: "experience",
      before: currentExpText,
      after: "",
      evidence: [],
      experienceData: [],
      dataGaps: ["업무 기록에서 경력 항목을 작성할 근거를 찾지 못했습니다."],
      followUpQuestions: [
        "어떤 회사 또는 프로젝트의 경력을 구체화하고 싶으신가요?",
        "어떤 기간이나 기술 스택과 관련된 경력 내용을 추가하고 싶으신가요?",
        "업무에서 달성한 주요 성과나 기여한 기능이 있으면 알려주세요.",
      ],
    };
  }

  // ── OpenAI 비활성화 시 heuristic 결과 반환 ─────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return buildHeuristicExperienceDiff(query, rankedEvidence, currentExpText, currentExperience);
  }

  // ── LLM 호출 ───────────────────────────────────────────────────────────────
  const evidenceContext = _buildEvidenceContext(rankedEvidence.slice(0, maxEvidenceItems));
  const systemPrompt = _buildSystemPrompt(lang);
  const userMessage = _buildUserMessage({ query, evidenceContext, currentExperience, lang });

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "experience_diff_result",
        strict: true,
        schema: EXPERIENCE_DIFF_SCHEMA,
      },
    },
    max_output_tokens: 2000,
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
      throw new Error(`Experience LLM call failed: ${response.status} ${errText.slice(0, 400)}`);
    }

    data = await response.json();
  } catch (err) {
    console.warn("[resumeExperienceSectionChat] LLM call failed, using heuristic:", err.message);
    return buildHeuristicExperienceDiff(query, rankedEvidence, currentExpText, currentExperience);
  }

  const rawText = data?.output_text || _extractOutputText(data);
  if (!rawText) {
    console.warn("[resumeExperienceSectionChat] LLM returned empty output, using heuristic");
    return buildHeuristicExperienceDiff(query, rankedEvidence, currentExpText, currentExperience);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.warn("[resumeExperienceSectionChat] Failed to parse LLM JSON, using heuristic");
    return buildHeuristicExperienceDiff(query, rankedEvidence, currentExpText, currentExperience);
  }

  return _normalizeExperienceResult(parsed, currentExpText, rankedEvidence);
}

/**
 * 경력 항목 배열을 사람이 읽을 수 있는 텍스트로 변환한다.
 *
 * @param {Array<{company: string, title: string, start_date?: string, end_date?: string, bullets?: string[]}>} experience
 * @returns {string}
 */
export function formatExperienceAsText(experience) {
  if (!Array.isArray(experience) || experience.length === 0) return "";

  return experience.map((exp, i) => {
    const company = exp.company ?? `회사 ${i + 1}`;
    const title = exp.title ?? "";
    const period = _formatPeriod(exp.start_date, exp.end_date);
    const header = [company, title, period].filter(Boolean).join(" | ");
    const bullets = Array.isArray(exp.bullets) && exp.bullets.length > 0
      ? exp.bullets.map((b) => `  - ${b}`).join("\n")
      : "  (불릿 없음)";
    return `${header}\n${bullets}`;
  }).join("\n\n");
}

// ─── LLM 페이로드 빌더 ────────────────────────────────────────────────────────

/**
 * @param {'ko'|'en'} lang
 */
function _buildSystemPrompt(lang) {
  const isKorean = lang === "ko";
  return `\
You are a professional resume writer specializing in crafting compelling experience section bullet points.

━━━ YOUR TASK ━━━
Generate achievement-oriented bullet points for the experience section of a resume,
based ONLY on provided work evidence (commits, Slack messages, session notes).

━━━ STRICT RULES ━━━
• Only include claims DIRECTLY supported by the provided evidence.
• Do NOT invent company names, technologies, metrics, or achievements not in the evidence.
• If evidence is insufficient for a specific claim, list it as a data_gap.
• Bullet points must follow the CAR format: Context → Action → Result.
• Each bullet: 1–2 sentences, action verb first (Implemented, Reduced, Improved, Led...).
• If the evidence clearly belongs to an existing company, use action="add_bullets".
• If evidence suggests work not covered by existing entries, use action="create_entry".
• ${isKorean ? "Write all bullet points in Korean." : "Write all bullet points in English."}

━━━ BULLET QUALITY CRITERIA ━━━
✗ BAD:  "다양한 기능을 개발했습니다"  (vague)
✗ BAD:  "TypeScript를 사용했습니다"   (tool mention without result)
✓ GOOD: "결제 모듈 API 오류율을 42% 감소시켜 사용자 결제 실패 경험 최소화"
✓ GOOD: "팀 배포 주기를 주 1회에서 일 2회로 단축하기 위한 CI/CD 파이프라인 구축"
✓ GOOD: "레거시 REST 엔드포인트를 GraphQL로 마이그레이션해 평균 응답 시간 30% 단축"

━━━ COMPANY MATCHING RULES ━━━
• Match evidence to an existing company when the repo names or commit context align with
  that company's work period (start_date to end_date).
• If no existing company matches, use action="create_entry" and infer company from evidence.
• "create_entry" requires: company name inferred from context, and plausible title.

━━━ DATA GAPS ━━━
Report as data_gaps when:
  - Evidence mentions a feature/outcome but lacks quantitative metrics
  - Evidence context is ambiguous (can't determine which project/company)
  - Evidence shows a technology but not the impact

Return JSON matching the provided schema.`;
}

/**
 * @param {{
 *   query: string,
 *   evidenceContext: string,
 *   currentExperience: object[],
 *   lang: string,
 * }} opts
 */
function _buildUserMessage({ query, evidenceContext, currentExperience, lang }) {
  const parts = [];

  parts.push(`# 사용자 요청\n${query}\n`);

  if (currentExperience.length > 0) {
    const expSummary = currentExperience.map((exp, i) => {
      const period = _formatPeriod(exp.start_date, exp.end_date);
      const bulletCount = Array.isArray(exp.bullets) ? exp.bullets.length : 0;
      return `${i + 1}. ${exp.company ?? "(회사명 없음)"} — ${exp.title ?? "(직책 없음)"} ${period ? `(${period})` : ""} [불릿 ${bulletCount}개]`;
    }).join("\n");
    parts.push(`# 기존 경력 항목\n${expSummary}\n`);
  } else {
    parts.push("# 기존 경력 항목\n(없음 — 새 경력 항목 생성 필요)\n");
  }

  parts.push(`# 업무 기록 근거 데이터 (랭킹 순)\n${evidenceContext || "(근거 없음)"}\n`);

  parts.push(
    lang === "ko"
      ? "위 근거 데이터를 바탕으로 경력 불릿 포인트를 작성해 주세요.\n" +
        "기존 경력 항목에 불릿을 추가하거나, 근거에 새 회사가 명확하면 새 항목을 생성해 주세요.\n" +
        "근거가 부족한 부분은 data_gaps와 follow_up_questions에 기재해 주세요."
      : "Based on the evidence above, write achievement-oriented bullet points for the experience section.\n" +
        "Add bullets to existing entries or suggest creating a new entry if evidence shows a different company.\n" +
        "List any gaps as data_gaps and follow_up_questions."
  );

  return parts.join("\n");
}

// ─── 출력 스키마 ──────────────────────────────────────────────────────────────

const EXPERIENCE_DIFF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["has_enough_evidence", "experience_changes", "data_gaps", "follow_up_questions"],
  properties: {
    has_enough_evidence: { type: "boolean" },
    experience_changes: {
      type: "array",
      minItems: 0,
      maxItems: MAX_EXPERIENCE_CHANGES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["company", "title", "action", "bullets", "evidence_texts", "confidence"],
        properties: {
          company:        { type: "string" },
          title:          { type: "string" },
          start_date:     { type: "string" },
          end_date:       { type: "string" },
          action: {
            type: "string",
            enum: ["add_bullets", "create_entry"],
          },
          bullets: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_BULLETS_PER_ENTRY,
          },
          evidence_texts: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 3,
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
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
 * @param {string} currentExpText
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @returns {ExperienceChatDiffResult}
 */
function _normalizeExperienceResult(parsed, currentExpText, rankedEvidence) {
  const hasEnough = parsed.has_enough_evidence === true;
  const rawChanges = Array.isArray(parsed.experience_changes) ? parsed.experience_changes : [];

  if (!hasEnough || rawChanges.length === 0) {
    return {
      hasEnoughEvidence: false,
      section: "experience",
      before: currentExpText,
      after: "",
      evidence: [],
      experienceData: [],
      dataGaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps.filter(Boolean) : [],
      followUpQuestions: Array.isArray(parsed.follow_up_questions)
        ? parsed.follow_up_questions.filter(Boolean)
        : [],
    };
  }

  // Normalize to ExperienceChange[]
  const experienceData = rawChanges.map((ch, i) => ({
    id: `exp-${i + 1}`,
    company:  typeof ch.company === "string"  ? ch.company.trim()  : `회사 ${i + 1}`,
    title:    typeof ch.title   === "string"  ? ch.title.trim()    : "",
    startDate: typeof ch.start_date === "string" ? ch.start_date.trim() : null,
    endDate:   typeof ch.end_date   === "string" ? ch.end_date.trim()   : null,
    action:    ch.action === "create_entry" ? "create_entry" : "add_bullets",
    bullets:   Array.isArray(ch.bullets) ? ch.bullets.filter(Boolean).slice(0, MAX_BULLETS_PER_ENTRY) : [],
    confidence: typeof ch.confidence === "number" ? Math.min(1, Math.max(0, ch.confidence)) : 0.7,
    evidenceTexts: Array.isArray(ch.evidence_texts) ? ch.evidence_texts.filter(Boolean).slice(0, 3) : [],
  })).filter((ch) => ch.bullets.length > 0);

  if (experienceData.length === 0) {
    return {
      hasEnoughEvidence: false,
      section: "experience",
      before: currentExpText,
      after: "",
      evidence: [],
      experienceData: [],
      dataGaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps.filter(Boolean) : [],
      followUpQuestions: Array.isArray(parsed.follow_up_questions)
        ? parsed.follow_up_questions.filter(Boolean)
        : [],
    };
  }

  // after = JSON.stringify(experienceData) — PATCH /api/resume/section 에서 파싱
  const afterText = JSON.stringify(experienceData);

  // Collect all unique evidence texts
  const allEvidence = experienceData.flatMap((ch) => ch.evidenceTexts);
  const uniqueEvidence = [...new Set(allEvidence)].slice(0, 8);

  return {
    hasEnoughEvidence: true,
    section: "experience",
    before: currentExpText,
    after: afterText,
    evidence: uniqueEvidence,
    experienceData,
    dataGaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps.filter(Boolean) : [],
    followUpQuestions: Array.isArray(parsed.follow_up_questions)
      ? parsed.follow_up_questions.filter(Boolean)
      : [],
  };
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────

/**
 * OpenAI 비활성화 또는 LLM 오류 시 사용하는 heuristic 결과.
 * 근거 텍스트를 단순 조합해 경력 불릿 초안을 생성한다.
 *
 * @param {string} query
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @param {string} currentExpText
 * @param {object[]} currentExperience
 * @returns {ExperienceChatDiffResult}
 */
export function buildHeuristicExperienceDiff(query, rankedEvidence, currentExpText, currentExperience) {
  const topItems = rankedEvidence.slice(0, 3);
  const evidenceTexts = topItems.map((r) => r.text).filter(Boolean);

  if (evidenceTexts.length === 0) {
    return {
      hasEnoughEvidence: false,
      section: "experience",
      before: currentExpText,
      after: "",
      evidence: [],
      experienceData: [],
      dataGaps: ["업무 기록에서 경력 불릿을 생성할 근거가 없습니다."],
      followUpQuestions: ["OpenAI API 키를 설정하면 더 정확한 경력 항목 생성이 가능합니다."],
    };
  }

  // 가장 최근 경력 항목에 근거 기반 불릿을 추가한다
  const targetCompany = currentExperience.length > 0
    ? currentExperience[0].company ?? "최근 직장"
    : "직장";

  // 근거를 단순 bullet 형태로 변환 (100자 이내로 자름)
  const bullets = evidenceTexts.map((text) => {
    const trimmed = text.trim().slice(0, 100);
    // 이미 불릿 형식이 아니면 동사로 시작하는 형태로 변환
    return trimmed.endsWith(".")
      ? trimmed
      : `${trimmed}.`;
  });

  const experienceData = [{
    id: "exp-1",
    company: targetCompany,
    title: currentExperience.length > 0 ? (currentExperience[0].title ?? "") : "",
    startDate: currentExperience.length > 0 ? (currentExperience[0].start_date ?? null) : null,
    endDate:   currentExperience.length > 0 ? (currentExperience[0].end_date   ?? null) : null,
    action: currentExperience.length > 0 ? "add_bullets" : "create_entry",
    bullets,
    confidence: 0.5,
    evidenceTexts,
  }];

  return {
    hasEnoughEvidence: true,
    section: "experience",
    before: currentExpText,
    after: JSON.stringify(experienceData),
    evidence: evidenceTexts,
    experienceData,
    dataGaps: [],
    followUpQuestions: [
      "LLM 없이 생성된 초안입니다. 내용을 검토하고 수정해 주세요.",
      "OpenAI API 키를 설정하면 더 정확한 경력 불릿 생성이 가능합니다.",
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
 * 경력 항목의 기간을 포맷팅한다.
 * @param {string|null} startDate
 * @param {string|null} endDate
 * @returns {string}
 */
function _formatPeriod(startDate, endDate) {
  if (!startDate && !endDate) return "";
  const start = startDate ?? "?";
  const end = endDate === "present" ? "현재" : (endDate ?? "?");
  return `${start} ~ ${end}`;
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
 * @typedef {Object} ExperienceChange
 * @property {string}   id            "exp-{index}"
 * @property {string}   company       회사명
 * @property {string}   title         직책
 * @property {string|null} startDate  시작 날짜 (YYYY-MM)
 * @property {string|null} endDate    종료 날짜 (YYYY-MM | "present")
 * @property {'add_bullets'|'create_entry'} action  변경 유형
 * @property {string[]} bullets       추가할 불릿 목록
 * @property {number}   confidence    0.0–1.0 확신도
 * @property {string[]} evidenceTexts 뒷받침하는 근거 텍스트 (1–3건)
 */

/**
 * @typedef {Object} ExperienceChatDiffResult
 * @property {boolean}          hasEnoughEvidence  근거 충분 여부
 * @property {'experience'}     section            항상 'experience'
 * @property {string}           before             현재 경력의 텍스트 표현
 * @property {string}           after              제안된 변경의 JSON 직렬화 (ExperienceChange[])
 * @property {string[]}         evidence           사용된 근거 텍스트 목록
 * @property {ExperienceChange[]} experienceData   구조화된 변경 목록 (UI 렌더링용)
 * @property {string[]}         dataGaps           근거 부족 영역
 * @property {string[]}         followUpQuestions  보충 질문 목록
 */
