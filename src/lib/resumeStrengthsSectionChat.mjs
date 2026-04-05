/**
 * resumeStrengthsSectionChat.mjs
 *
 * 강점(Strengths) 섹션 채팅 기반 구체화 모듈 (Sub-AC 8-1).
 *
 * 사용자가 채팅에서 강점 섹션 분석·구체화를 요청할 때,
 * 커밋/슬랙/세션 메모리 근거를 바탕으로 행동 패턴 기반의 강점을 제안한다.
 *
 * 핵심 원칙:
 *   - 강점은 기술 키워드가 아닌 행동 패턴 (behavioral pattern)이다
 *     예: "TypeScript" 아님 → "안정성 우선 엔지니어링" (행동+결과)
 *   - 근거 없이 허구를 생성하지 않는다
 *   - 데이터 부족 시 사용자에게 보충 질문을 반환한다
 *   - 기존 강점(before)과 제안(after)의 구조화된 diff 형태로 반환한다
 *
 * 공개 API:
 *   generateStrengthsChatDiff(query, rankedEvidence, existingResume, options)
 *     → Promise<StrengthsChatDiffResult>
 *   formatStrengthsAsText(strengths)
 *     → string  (강점 목록을 사람이 읽을 수 있는 텍스트로 변환)
 *
 * StrengthsChatDiffResult:
 *   {
 *     hasEnoughEvidence: boolean,
 *     section: 'strengths',
 *     before: string,                 // 현재 강점의 텍스트 표현
 *     after: string,                  // 제안된 강점의 텍스트 표현
 *     evidence: string[],             // 사용된 근거 텍스트 목록
 *     strengthsData: StrengthItem[],  // 구조화된 강점 목록 (UI 렌더링용)
 *     followUpQuestions: string[],    // 보충 질문 (데이터 부족 시)
 *     dataGaps: string[],             // 근거 부족 영역
 *   }
 *
 * StrengthItem:
 *   {
 *     id: string,             // "str-{index}"
 *     label: string,          // 강점 이름 (2–8 단어)
 *     description: string,    // 행동 패턴 설명 (1–3 문장)
 *     evidenceTexts: string[], // 뒷받침하는 근거 텍스트 (1–3건)
 *     behaviorCluster: string[], // 관련 행동 패턴 태그
 *     frequency: number,      // 근거 등장 빈도
 *     confidence: number,     // 0.0–1.0
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

/** 강점 생성에 필요한 최소 근거 건수 */
const MIN_EVIDENCE_FOR_STRENGTHS = 2;

/** 최대 강점 개수 */
const MAX_STRENGTHS = 5;

/** 최소 강점 개수 */
const MIN_STRENGTHS = 2;

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 랭킹된 근거를 바탕으로 강점 섹션 diff를 생성한다.
 *
 * 근거가 MIN_EVIDENCE_FOR_STRENGTHS 건 미만이면 LLM을 호출하지 않고
 * followUpQuestions만 포함한 결과를 반환한다.
 *
 * @param {string} query  사용자 원본 질의
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @param {object|null} existingResume  현재 이력서 문서
 * @param {object|null} existingStrengths  현재 식별된 강점 문서 (StrengthsDocument)
 * @param {{
 *   lang?: 'ko' | 'en',
 *   maxEvidenceItems?: number,
 *   maxStrengths?: number,
 * }} [options]
 * @returns {Promise<StrengthsChatDiffResult>}
 */
export async function generateStrengthsChatDiff(query, rankedEvidence, existingResume, existingStrengths, options = {}) {
  const { lang = "ko", maxEvidenceItems = 12, maxStrengths = MAX_STRENGTHS } = options;

  // 현재 강점 텍스트 표현 구성
  const currentStrengthsItems = existingStrengths?.strengths ?? [];
  const currentStrengthsText = formatStrengthsAsText(currentStrengthsItems);

  // ── 근거 부족 시 조기 반환 ──────────────────────────────────────────────────
  if (!rankedEvidence || rankedEvidence.length < MIN_EVIDENCE_FOR_STRENGTHS) {
    return {
      hasEnoughEvidence: false,
      section: "strengths",
      before: currentStrengthsText,
      after: "",
      evidence: [],
      strengthsData: [],
      dataGaps: ["업무 기록에서 강점을 도출할 근거가 충분하지 않습니다."],
      followUpQuestions: [
        "어떤 프로젝트나 기간의 업무에서 강점을 찾고 싶으신가요?",
        "특별히 강조하고 싶은 역할이나 행동 패턴이 있나요?",
        "팀에서 어떤 부분을 자주 담당하거나 칭찬받으셨나요?",
      ],
    };
  }

  // ── OpenAI 비활성화 시 heuristic 결과 반환 ─────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return buildHeuristicStrengthsDiff(query, rankedEvidence, currentStrengthsText, currentStrengthsItems);
  }

  // ── LLM 호출 ───────────────────────────────────────────────────────────────
  const evidenceContext = _buildEvidenceContext(rankedEvidence.slice(0, maxEvidenceItems));
  const systemPrompt = _buildSystemPrompt(lang, maxStrengths);
  const userMessage = _buildUserMessage({ query, evidenceContext, currentStrengthsText, existingResume, lang, maxStrengths });

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "strengths_diff_result",
        strict: true,
        schema: STRENGTHS_DIFF_SCHEMA,
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
      throw new Error(`Strengths LLM call failed: ${response.status} ${errText.slice(0, 400)}`);
    }

    data = await response.json();
  } catch (err) {
    console.warn("[resumeStrengthsSectionChat] LLM call failed, using heuristic:", err.message);
    return buildHeuristicStrengthsDiff(query, rankedEvidence, currentStrengthsText, currentStrengthsItems);
  }

  const rawText = data?.output_text || _extractOutputText(data);
  if (!rawText) {
    console.warn("[resumeStrengthsSectionChat] LLM returned empty output, using heuristic");
    return buildHeuristicStrengthsDiff(query, rankedEvidence, currentStrengthsText, currentStrengthsItems);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.warn("[resumeStrengthsSectionChat] Failed to parse LLM JSON, using heuristic");
    return buildHeuristicStrengthsDiff(query, rankedEvidence, currentStrengthsText, currentStrengthsItems);
  }

  return _normalizeStrengthsResult(parsed, currentStrengthsText, rankedEvidence);
}

/**
 * 강점 아이템 배열을 사람이 읽을 수 있는 텍스트로 변환한다.
 *
 * @param {Array<{label: string, description?: string, frequency?: number}>} strengths
 * @returns {string}
 */
export function formatStrengthsAsText(strengths) {
  if (!Array.isArray(strengths) || strengths.length === 0) return "";

  return strengths.map((s, i) => {
    const freq = s.frequency ? ` (×${s.frequency})` : "";
    const desc = s.description ? `\n  ${s.description}` : "";
    return `${i + 1}. ${s.label}${freq}${desc}`;
  }).join("\n\n");
}

// ─── LLM 페이로드 빌더 ────────────────────────────────────────────────────────

/**
 * @param {'ko'|'en'} lang
 * @param {number} maxStrengths
 */
function _buildSystemPrompt(lang, maxStrengths) {
  const isKorean = lang === "ko";
  return `\
You are a professional career coach specializing in identifying behavioral strengths from work evidence.

━━━ YOUR TASK ━━━
Identify ${MIN_STRENGTHS}–${maxStrengths} behavioral strengths (행동 패턴) from work evidence.

━━━ WHAT IS A BEHAVIORAL STRENGTH? ━━━
A behavioral strength is a PATTERN OF BEHAVIOR demonstrated repeatedly, NOT a technology keyword.
  ✗ BAD:  "TypeScript", "React", "Git"  (these are skills/tools, not behavioral patterns)
  ✓ GOOD: "안정성 우선 엔지니어링" — consistently adds error handling, validation, tests
  ✓ GOOD: "데이터 기반 의사결정" — uses metrics and evidence before making architectural changes
  ✓ GOOD: "점진적 개선 문화" — refactors incrementally rather than big-bang rewrites

━━━ STRICT RULES ━━━
• Only identify strengths DIRECTLY supported by ≥2 evidence records showing the SAME pattern.
• Each strength MUST cite 1–3 actual evidence texts from the input.
• Do NOT invent behaviors, outcomes, or patterns not demonstrated in the evidence.
• If evidence is sparse, list data_gaps and follow_up_questions instead.
• ${isKorean ? "Write all text in Korean." : "Write all text in English."}
• strength label: 3–8 words, pattern-oriented (e.g. "배포 자동화 주도", "코드 품질 우선주의")
• description: 2–3 sentences explaining the pattern, with evidence examples.
• frequency: count of distinct evidence records showing this pattern.

━━━ QUALITY CRITERIA ━━━
A strength qualifies when:
  - Pattern appears in ≥2 different evidence records
  - Pattern describes HOW the person works, not WHAT tools they use
  - Pattern can be phrased as: "[repeated action] → [consistent outcome/value]"

━━━ DATA GAPS ━━━
List these when:
  - Evidence shows only one instance of a behavior (not a proven pattern)
  - Evidence mentions a topic but lacks enough context to identify a pattern

━━━ BEHAVIOR CLUSTERS ━━━
For each strength, provide 2–4 short behavior cluster tags that characterize the pattern.
Examples: ["코드 품질", "테스트 작성", "안정성"], ["아키텍처 설계", "성능 최적화"]`;
}

/**
 * @param {{
 *   query: string,
 *   evidenceContext: string,
 *   currentStrengthsText: string,
 *   existingResume: object|null,
 *   lang: string,
 *   maxStrengths: number,
 * }} opts
 */
function _buildUserMessage({ query, evidenceContext, currentStrengthsText, existingResume, lang, maxStrengths }) {
  const parts = [];

  parts.push(`# 사용자 요청\n${query}\n`);

  if (currentStrengthsText) {
    parts.push(`# 현재 식별된 강점\n${currentStrengthsText}\n`);
  }

  if (existingResume?.summary) {
    parts.push(`# 기존 자기소개 (참고)\n${existingResume.summary}\n`);
  }

  parts.push(`# 업무 기록 근거 데이터 (랭킹 순)\n${evidenceContext || "(근거 없음)"}\n`);

  parts.push(
    lang === "ko"
      ? `위 근거 데이터에서 반복적으로 나타나는 행동 패턴을 ${MIN_STRENGTHS}–${maxStrengths}개 찾아주세요.\n` +
        "근거가 부족한 부분은 data_gaps와 follow_up_questions에 기재해 주세요."
      : `Find ${MIN_STRENGTHS}–${maxStrengths} behavioral patterns from the evidence above.\n` +
        "List any gaps as data_gaps and follow_up_questions."
  );

  return parts.join("\n");
}

// ─── 출력 스키마 ──────────────────────────────────────────────────────────────

const STRENGTHS_DIFF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["has_enough_evidence", "strengths", "data_gaps", "follow_up_questions"],
  properties: {
    has_enough_evidence: { type: "boolean" },
    strengths: {
      type: "array",
      minItems: 0,
      maxItems: MAX_STRENGTHS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "description", "evidence_texts", "behavior_cluster", "frequency", "confidence"],
        properties: {
          label:           { type: "string" },
          description:     { type: "string" },
          evidence_texts: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 3,
          },
          behavior_cluster: {
            type: "array",
            items: { type: "string" },
            minItems: 0,
            maxItems: 4,
          },
          frequency:   { type: "integer", minimum: 1 },
          confidence:  { type: "number", minimum: 0, maximum: 1 },
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
 * @param {string} currentStrengthsText
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @returns {StrengthsChatDiffResult}
 */
function _normalizeStrengthsResult(parsed, currentStrengthsText, rankedEvidence) {
  const hasEnough = parsed.has_enough_evidence === true;
  const rawStrengths = Array.isArray(parsed.strengths) ? parsed.strengths : [];

  if (!hasEnough || rawStrengths.length === 0) {
    return {
      hasEnoughEvidence: false,
      section: "strengths",
      before: currentStrengthsText,
      after: "",
      evidence: [],
      strengthsData: [],
      dataGaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps.filter(Boolean) : [],
      followUpQuestions: Array.isArray(parsed.follow_up_questions)
        ? parsed.follow_up_questions.filter(Boolean)
        : [],
    };
  }

  // Normalize to StrengthItem[]
  const strengthsData = rawStrengths.map((s, i) => ({
    id: `str-${i + 1}`,
    label: typeof s.label === "string" ? s.label.trim() : `강점 ${i + 1}`,
    description: typeof s.description === "string" ? s.description.trim() : "",
    evidenceTexts: Array.isArray(s.evidence_texts) ? s.evidence_texts.filter(Boolean).slice(0, 3) : [],
    behaviorCluster: Array.isArray(s.behavior_cluster) ? s.behavior_cluster.filter(Boolean).slice(0, 4) : [],
    frequency: typeof s.frequency === "number" ? Math.max(1, s.frequency) : 1,
    confidence: typeof s.confidence === "number" ? Math.min(1, Math.max(0, s.confidence)) : 0.7,
  }));

  const afterText = formatStrengthsAsText(strengthsData);

  // Collect all unique evidence texts
  const allEvidence = strengthsData.flatMap((s) => s.evidenceTexts);
  const uniqueEvidence = [...new Set(allEvidence)].slice(0, 8);

  return {
    hasEnoughEvidence: true,
    section: "strengths",
    before: currentStrengthsText,
    after: afterText,
    evidence: uniqueEvidence,
    strengthsData,
    dataGaps: Array.isArray(parsed.data_gaps) ? parsed.data_gaps.filter(Boolean) : [],
    followUpQuestions: Array.isArray(parsed.follow_up_questions)
      ? parsed.follow_up_questions.filter(Boolean)
      : [],
  };
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────

/**
 * OpenAI 비활성화 또는 LLM 오류 시 사용하는 heuristic 결과.
 * 근거 텍스트를 단순 분류해 강점 목록을 생성한다.
 *
 * @param {string} query
 * @param {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]} rankedEvidence
 * @param {string} currentStrengthsText
 * @param {object[]} currentStrengths
 * @returns {StrengthsChatDiffResult}
 */
function buildHeuristicStrengthsDiff(query, rankedEvidence, currentStrengthsText, currentStrengths) {
  // 기존 강점이 있으면 그대로 반환 (heuristic은 개선 불가)
  if (currentStrengths.length > 0) {
    return {
      hasEnoughEvidence: true,
      section: "strengths",
      before: currentStrengthsText,
      after: currentStrengthsText,
      evidence: rankedEvidence.slice(0, 3).map((r) => r.text).filter(Boolean),
      strengthsData: currentStrengths.map((s, i) => ({
        id: `str-${i + 1}`,
        label: s.label ?? s.name ?? `강점 ${i + 1}`,
        description: s.description ?? "",
        evidenceTexts: s.evidenceExamples ?? s.evidenceTexts ?? [],
        behaviorCluster: s.behaviorCluster ?? [],
        frequency: s.frequency ?? 1,
        confidence: s.confidence ?? 0.7,
      })),
      dataGaps: [],
      followUpQuestions: ["LLM 없이는 강점을 자동으로 개선할 수 없습니다. OpenAI API 키를 설정해 주세요."],
    };
  }

  // 기존 강점이 없으면 근거에서 간단한 강점 생성
  const topItems = rankedEvidence.slice(0, MIN_EVIDENCE_FOR_STRENGTHS);
  const strengthsData = [{
    id: "str-1",
    label: "업무 성과 달성",
    description: `업무 기록에서 ${topItems.length}건 이상의 성과가 확인되었습니다. LLM API 키 설정 시 더 정확한 강점 분석이 가능합니다.`,
    evidenceTexts: topItems.map((r) => r.text).filter(Boolean),
    behaviorCluster: [],
    frequency: topItems.length,
    confidence: 0.5,
  }];

  const afterText = formatStrengthsAsText(strengthsData);

  return {
    hasEnoughEvidence: true,
    section: "strengths",
    before: currentStrengthsText,
    after: afterText,
    evidence: topItems.map((r) => r.text).filter(Boolean),
    strengthsData,
    dataGaps: [],
    followUpQuestions: ["OpenAI API 키를 설정하면 더 정확한 강점 분석이 가능합니다."],
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
 * @typedef {Object} StrengthItem
 * @property {string}   id              "str-{index}"
 * @property {string}   label           강점 이름 (3–8 단어)
 * @property {string}   description     행동 패턴 설명 (2–3 문장)
 * @property {string[]} evidenceTexts   뒷받침하는 근거 텍스트 (1–3건)
 * @property {string[]} behaviorCluster 관련 행동 패턴 태그 (0–4개)
 * @property {number}   frequency       근거 등장 빈도 (최소 1)
 * @property {number}   confidence      0.0–1.0 확신도
 */

/**
 * @typedef {Object} StrengthsChatDiffResult
 * @property {boolean}       hasEnoughEvidence  근거 충분 여부
 * @property {'strengths'}   section            항상 'strengths'
 * @property {string}        before             현재 강점의 텍스트 표현
 * @property {string}        after              제안된 강점의 텍스트 표현
 * @property {string[]}      evidence           사용된 근거 텍스트 목록
 * @property {StrengthItem[]} strengthsData     구조화된 강점 목록 (UI 렌더링용)
 * @property {string[]}      dataGaps           근거 부족 영역
 * @property {string[]}      followUpQuestions  보충 질문 목록
 */
