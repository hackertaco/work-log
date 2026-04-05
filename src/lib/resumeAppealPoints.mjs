/**
 * resumeAppealPoints.mjs
 *
 * 검색 결과 통합·랭킹 및 어필 포인트 생성 (Sub-AC 3-3)
 *
 * 세 데이터 소스(커밋, 슬랙, 세션 메모리)의 검색 결과를 병합·랭킹하여
 * LLM 프롬프트에 근거로 주입하고, 이력서에 활용 가능한 어필 포인트 목록을
 * 생성해 채팅 응답으로 출력한다.
 *
 * ─── 주요 함수 ─────────────────────────────────────────────────────────────────
 *
 *   mergeAndRankEvidence(evidenceResult, options)
 *     세 소스의 EvidenceRecord[] 를 하나의 RankedEvidenceRecord[] 로 병합·랭킹.
 *     랭킹 점수 = relevanceScore × SOURCE_WEIGHT + recencyScore
 *     소스 다양성 보너스: 각 소스에서 최소 1건을 최상위에 유지.
 *
 *   buildEvidenceContext(rankedEvidence, maxChars)
 *     랭킹된 근거를 LLM 프롬프트 삽입용 텍스트 블록으로 변환.
 *     maxChars를 초과하면 낮은 순위부터 잘라낸다.
 *
 *   generateAppealPoints(query, rankedEvidence, options)
 *     근거 데이터를 LLM에 주입해 이력서에 쓸 어필 포인트 목록을 생성.
 *     근거가 부족하면 data_gaps / follow_up_questions 를 반환하고 LLM 호출을 건너뜀.
 *
 *   generateAppealPointsFromExploreResult(query, exploreResult, options)
 *     exploreWithQueryAnalysis() 결과를 받아 병합·랭킹 후 어필 포인트를 생성하는
 *     편의 함수. 탐색→추천 파이프라인을 단일 호출로 실행한다.
 *
 * ─── 타입 ─────────────────────────────────────────────────────────────────────
 *
 *   RankedEvidenceRecord — EvidenceRecord + rank + rankScore
 *
 *   AppealPoint — {
 *     id: string,
 *     title: string,
 *     description: string,
 *     evidenceTexts: string[],
 *     section: 'experience'|'skills'|'summary'|null,
 *     confidence: number          // 0.0–1.0
 *   }
 *
 *   AppealPointsResult — {
 *     appealPoints: AppealPoint[],
 *     dataGaps: string[],
 *     followUpQuestions: string[],
 *     evidenceUsed: RankedEvidenceRecord[]
 *   }
 *
 * ─── 환경 변수 ────────────────────────────────────────────────────────────────
 *
 *   OPENAI_API_KEY           — 필수
 *   WORK_LOG_OPENAI_URL      — 기본값: https://api.openai.com/v1/responses
 *   WORK_LOG_OPENAI_MODEL    — 기본값: gpt-5.4-mini
 *   WORK_LOG_DISABLE_OPENAI  — "1" 이면 LLM 호출 비활성화
 */

// ─── 상수 ─────────────────────────────────────────────────────────────────────

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL =
  process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/** 소스별 가중치 (relevanceScore 에 곱함) */
const SOURCE_WEIGHTS = {
  commits: 1.2,  // 커밋: 실제 작업 결과이므로 가장 높게
  slack:   1.0,  // 슬랙: 커뮤니케이션 근거
  session: 0.9,  // 세션: AI 작업 맥락
};

/** LLM 에 전달하는 근거 컨텍스트 최대 문자 수 */
const DEFAULT_EVIDENCE_CONTEXT_MAX_CHARS = 5_000;

/** 최소 근거 건수 — 이 미만이면 data_gaps 만 반환하고 LLM 을 호출하지 않는다 */
const MIN_EVIDENCE_FOR_LLM = 1;

/** 소스 다양성 보너스 점수 */
const DIVERSITY_BONUS = 0.5;

// ─── 공개 타입 (JSDoc) ────────────────────────────────────────────────────────

/**
 * @typedef {Object} EvidenceRecord
 * @property {'commits'|'slack'|'session'} source
 * @property {string}  date            YYYY-MM-DD
 * @property {string}  text            검색에 히트한 주요 텍스트
 * @property {number}  relevanceScore  키워드 매칭 횟수
 * @property {object}  metadata        소스별 메타데이터
 */

/**
 * @typedef {EvidenceRecord & { rank: number, rankScore: number }} RankedEvidenceRecord
 */

/**
 * @typedef {Object} AppealPoint
 * @property {string}   id             "ap-{index}"
 * @property {string}   title          짧은 제목 (2–8 단어)
 * @property {string}   description    성취 지향적 설명 (1–2 문장)
 * @property {string[]} evidenceTexts  근거 텍스트 목록 (1–3건)
 * @property {'experience'|'skills'|'summary'|null} section  이력서 대상 섹션
 * @property {'achievement'|'contribution'|'capability'} category
 *   어필 포인트의 유형:
 *     achievement  — 성과: 정량적/정성적 결과 (배포, 성능 개선, 버그 수정 등)
 *     contribution — 기여: 팀/조직에 대한 기여 (코드 리뷰, 온보딩, 문서화 등)
 *     capability   — 역량: 기술적/행동적 역량 (설계 능력, 문제 해결력 등)
 * @property {number}   confidence     자신감 점수 0.0–1.0
 * @property {import('./resumeTypes.mjs').SourceRef[]} sourceRefs
 *   출처 참조 목록 — 이 어필 포인트를 뒷받침하는 각 근거 레코드의
 *   출처 메타데이터(커밋 해시, 슬랙 메시지 ID 등)를 포함한다.
 *   mergeAndRankEvidence() 결과에서 evidence_ranks 로 역참조하여 채운다.
 *   LLM 이 evidence_ranks 를 반환하지 않은 경우 빈 배열일 수 있다.
 */

/**
 * @typedef {Object} AppealPointsResult
 * @property {AppealPoint[]}           appealPoints       생성된 어필 포인트 목록
 * @property {string[]}               dataGaps           근거 부족 영역 (보충 질문 후보)
 * @property {string[]}               followUpQuestions  사용자에게 물어볼 추가 질문
 * @property {RankedEvidenceRecord[]} evidenceUsed       실제로 활용된 근거 목록
 */

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 세 소스의 검색 결과를 병합하고 복합 점수로 랭킹한다.
 *
 * 랭킹 점수 계산:
 *   rankScore = relevanceScore × SOURCE_WEIGHTS[source] + recencyScore
 *
 * recencyScore 는 검색 결과 내에서 날짜가 가장 최근인 레코드에 1.0 을 부여하고,
 * 가장 오래된 레코드는 0.0 으로 정규화한다.
 *
 * 소스 다양성 보너스:
 *   각 소스에서 최소 1건씩 top-N 에 포함되도록 첫 번째 고유 소스 레코드에
 *   DIVERSITY_BONUS 를 추가한다.
 *
 * @param {{
 *   commits:  EvidenceRecord[],
 *   slack:    EvidenceRecord[],
 *   sessions: EvidenceRecord[],
 *   totalCount: number
 * }} evidenceResult  searchAllSources() 반환값
 * @param {{ topN?: number }} [options]
 * @returns {RankedEvidenceRecord[]}
 */
export function mergeAndRankEvidence(evidenceResult, options = {}) {
  const topN = options.topN ?? 15;

  // sessions 키도 허용 (searchAllSources 반환 구조)
  const commits  = Array.isArray(evidenceResult.commits)  ? evidenceResult.commits  : [];
  const slack    = Array.isArray(evidenceResult.slack)    ? evidenceResult.slack    : [];
  const sessions = Array.isArray(evidenceResult.sessions) ? evidenceResult.sessions
    : Array.isArray(evidenceResult.session) ? evidenceResult.session : [];

  const all = [
    ...commits.map((r) => ({ ...r, source: "commits" })),
    ...slack.map((r)   => ({ ...r, source: "slack" })),
    ...sessions.map((r) => ({
      ...r,
      // EvidenceRecord from searchAllSources uses "session" (singular)
      source: r.source === "session" ? "session" : "sessions",
    })),
  ];

  if (all.length === 0) return [];

  // ── Compute recency scores ──────────────────────────────────────────────────
  const dates = all.map((r) => r.date ?? "").filter(Boolean);
  const minDate = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : "";
  const maxDate = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : "";
  const dateSpanMs = minDate && maxDate && minDate !== maxDate
    ? new Date(maxDate).getTime() - new Date(minDate).getTime()
    : 0;

  // ── Assign base rankScore ───────────────────────────────────────────────────
  const withScores = all.map((r) => {
    const sourceKey = r.source === "session" ? "session" : r.source;
    const weight = SOURCE_WEIGHTS[sourceKey] ?? 1.0;
    const recencyScore = dateSpanMs > 0 && r.date
      ? (new Date(r.date).getTime() - new Date(minDate).getTime()) / dateSpanMs
      : 0;
    return {
      ...r,
      rankScore: (r.relevanceScore ?? 0) * weight + recencyScore,
    };
  });

  // ── Sort by rankScore DESC ──────────────────────────────────────────────────
  withScores.sort((a, b) => b.rankScore - a.rankScore || (b.date ?? "").localeCompare(a.date ?? ""));

  // ── Diversity boost: ensure first occurrence of each source appears early ──
  const sourceSeen = new Set();
  for (const r of withScores) {
    const srcKey = r.source;
    if (!sourceSeen.has(srcKey)) {
      r.rankScore += DIVERSITY_BONUS;
      sourceSeen.add(srcKey);
    }
  }

  // Re-sort after diversity boost
  withScores.sort((a, b) => b.rankScore - a.rankScore || (b.date ?? "").localeCompare(a.date ?? ""));

  // ── Assign 1-based rank and return top-N ───────────────────────────────────
  return withScores.slice(0, topN).map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * 랭킹된 근거 목록을 LLM 프롬프트에 삽입할 텍스트 블록으로 변환한다.
 *
 * 출력 형식 (rank 인덱스 포함):
 *   [1][커밋] 2024-03-01 | my-project: feat: 기능 추가  (hash:abc1234, repo:my-project)
 *   [2][슬랙] 2024-03-02 | 배포 완료 공유  (msgId:1710000000.000, ch:C001)
 *   [3][세션] 2024-03-03 | circuit breaker 패턴 검토 중  (tool:claude)
 *
 * rank 인덱스([N])는 LLM 이 evidence_ranks 배열에서 참조할 근거 번호이다.
 * provenance 힌트는 LLM 이 출처를 인식하도록 부가하며 citation 품질을 높인다.
 *
 * maxChars 를 초과하면 낮은 순위(끝)부터 잘라낸다.
 *
 * @param {RankedEvidenceRecord[]} rankedEvidence
 * @param {number} [maxChars]
 * @returns {string}
 */
export function buildEvidenceContext(rankedEvidence, maxChars = DEFAULT_EVIDENCE_CONTEXT_MAX_CHARS) {
  if (!rankedEvidence || rankedEvidence.length === 0) return "";

  const SOURCE_LABELS = {
    commits: "커밋",
    slack:   "슬랙",
    session: "세션",
    sessions: "세션",
  };

  const lines = rankedEvidence.map((r, i) => {
    const rankIdx = r.rank ?? (i + 1);
    const label = SOURCE_LABELS[r.source] ?? r.source;
    const date  = r.date ?? "?";
    const text  = (r.text ?? "").trim().slice(0, 200); // 개별 항목 최대 200자

    // 출처 힌트 — provenance 에서 핵심 식별자를 추출
    const provenanceHint = _buildProvenanceHint(r);
    const hintSuffix = provenanceHint ? `  (${provenanceHint})` : "";

    return `[${rankIdx}][${label}] ${date} | ${text}${hintSuffix}`;
  });

  // maxChars 제한: 끝에서부터 제거
  let result = lines.join("\n");
  if (result.length <= maxChars) return result;

  let truncated = [];
  let totalChars = 0;
  for (const line of lines) {
    if (totalChars + line.length + 1 > maxChars) break;
    truncated.push(line);
    totalChars += line.length + 1;
  }

  if (truncated.length < lines.length) {
    truncated.push(`... (${lines.length - truncated.length}건 생략)`);
  }

  return truncated.join("\n");
}

/**
 * 랭킹된 근거를 LLM 에 주입해 이력서 어필 포인트를 생성한다.
 *
 * 근거가 MIN_EVIDENCE_FOR_LLM 건 미만이면 LLM 을 호출하지 않고
 * followUpQuestions 만 포함한 결과를 반환한다.
 *
 * @param {string} query               사용자 원본 질의
 * @param {RankedEvidenceRecord[]} rankedEvidence  mergeAndRankEvidence() 결과
 * @param {{
 *   existingResume?: object,
 *   lang?: 'ko' | 'en',
 *   maxPoints?: number
 * }} [options]
 * @returns {Promise<AppealPointsResult>}
 */
export async function generateAppealPoints(query, rankedEvidence, options = {}) {
  const { existingResume, lang = "ko", maxPoints = 5 } = options;

  // ── 근거 부족 시 조기 반환 ──────────────────────────────────────────────────
  if (!rankedEvidence || rankedEvidence.length < MIN_EVIDENCE_FOR_LLM) {
    return {
      appealPoints: [],
      dataGaps: ["검색 결과가 없어 어필 포인트를 생성할 수 없습니다."],
      followUpQuestions: [
        "어떤 기간이나 프로젝트에 대해 알아보고 싶으신가요?",
        "구체적인 기술 스택이나 역할을 입력해 주시면 더 잘 찾을 수 있습니다.",
      ],
      evidenceUsed: [],
    };
  }

  // ── OpenAI 비활성화 시 heuristic 결과 반환 ─────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return buildHeuristicAppealPoints(query, rankedEvidence, maxPoints);
  }

  // ── LLM 호출 ───────────────────────────────────────────────────────────────
  const evidenceContext = buildEvidenceContext(rankedEvidence);
  const payload = buildAppealPointsPayload({
    query,
    evidenceContext,
    existingResume,
    lang,
    maxPoints,
  });

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
        `Appeal points LLM call failed: ${response.status} ${errorText.slice(0, 400)}`
      );
    }

    data = await response.json();
  } catch (err) {
    // LLM 오류 시 heuristic 으로 fallback
    console.warn("[resumeAppealPoints] LLM call failed, using heuristic fallback:", err.message);
    return buildHeuristicAppealPoints(query, rankedEvidence, maxPoints);
  }

  const rawText = data?.output_text || extractOutputText(data);
  if (!rawText) {
    console.warn("[resumeAppealPoints] LLM returned empty output, using heuristic fallback");
    return buildHeuristicAppealPoints(query, rankedEvidence, maxPoints);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.warn("[resumeAppealPoints] Failed to parse LLM JSON output, using heuristic fallback");
    return buildHeuristicAppealPoints(query, rankedEvidence, maxPoints);
  }

  return normalizeAppealPointsResult(parsed, rankedEvidence);
}

// ─── LLM 페이로드 빌더 ───────────────────────────────────────────────────────

/**
 * @param {{ query: string, evidenceContext: string, existingResume?: object, lang: string, maxPoints: number }} opts
 */
function buildAppealPointsPayload({ query, evidenceContext, existingResume, lang, maxPoints }) {
  const systemPrompt = buildSystemPrompt(lang);
  const userMessage  = buildUserMessage({ query, evidenceContext, existingResume, lang, maxPoints });

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "appeal_points_result",
        strict: true,
        schema: APPEAL_POINTS_OUTPUT_SCHEMA,
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
}

function buildSystemPrompt(lang) {
  const isKorean = lang === "ko";
  return `\
You extract resume appeal points from work evidence (git commits, Slack messages, AI session notes).

━━━ YOUR ROLE ━━━
You receive:
1. A user's query about their work history
2. Ranked evidence records from their actual work data (commits, Slack, sessions)

Your job is to produce:
1. APPEAL POINTS — concrete, evidence-backed resume-ready claims
2. DATA GAPS — areas where evidence is insufficient to make a claim
3. FOLLOW-UP QUESTIONS — questions to ask the user to fill evidence gaps

━━━ STRICT RULES ━━━
• Only generate claims DIRECTLY supported by the evidence provided.
• Each appeal point MUST cite 1–3 actual evidence texts from the input.
• For evidence_ranks: use the [N] index numbers shown at the start of each evidence line
  (e.g., if you use the line starting "[2][슬랙]", include 2 in evidence_ranks).
• evidence_ranks and evidence_texts must refer to the SAME evidence records.
• If evidence is sparse, list data_gaps and follow_up_questions instead.
• Do NOT invent outcomes, metrics, or project names not in the evidence.
• ${isKorean ? "Output all text fields in Korean." : "Output all text fields in English."}
• Title: 2–8 words, action-oriented (e.g., "배포 자동화로 팀 효율 개선").
• Description: 1–2 sentences, achievement-oriented: outcome + method + impact.
• Confidence: 1.0 if multiple corroborating evidence records; 0.5 if only one.

━━━ SECTION ASSIGNMENT ━━━
Assign section based on content:
  "experience" — work achievements, project outcomes, technical decisions
  "skills"     — technology stack, tools, methodologies demonstrated
  "summary"    — cross-cutting behavioral strengths, professional identity

━━━ CATEGORY ASSIGNMENT ━━━
Assign category based on the nature of the appeal point:
  "achievement"  — 성과: quantifiable/qualifiable outcomes (deployment, performance gain, bug fix, feature launch, SLA improvement)
  "contribution" — 기여: team/org-level contributions (code review, onboarding, documentation, process improvement, mentoring)
  "capability"   — 역량: demonstrated technical or behavioral skills (system design, problem-solving, cross-functional communication)

━━━ APPEAL POINT CRITERIA ━━━
A point qualifies when:
  - It is backed by ≥1 evidence record
  - It describes a concrete outcome (not just activity)
  - It can be phrased as: "[action] + [result/impact]"

━━━ DATA GAPS ━━━
List these when:
  - The query asks about something not in the evidence
  - Evidence mentions a topic but lacks outcome/impact details

━━━ FOLLOW-UP QUESTIONS ━━━
Ask targeted questions to fill evidence gaps. Examples:
  - "X 기능 배포 후 어떤 효과가 있었나요?"
  - "해당 프로젝트의 팀 규모와 역할이 어떻게 되나요?"`;
}

function buildUserMessage({ query, evidenceContext, existingResume, lang, maxPoints }) {
  const parts = [];

  parts.push(`# 사용자 질의\n${query}\n`);
  parts.push(`# 검색된 근거 데이터 (랭킹 순)\n${evidenceContext || "(근거 없음)"}\n`);

  if (existingResume) {
    parts.push("# 기존 이력서 컨텍스트 (참고용)");
    const companies = (existingResume.experience ?? [])
      .map((e) => `${e.company} (${e.title ?? ""}): ${e.start_date ?? "?"}~${e.end_date ?? "현재"}`)
      .join("\n");
    if (companies) parts.push(`경력:\n${companies}`);
    if (existingResume.summary) parts.push(`기존 요약: ${existingResume.summary}`);
  }

  parts.push(
    `\n위 근거 데이터에서 이력서에 활용할 어필 포인트를 최대 ${maxPoints}개 생성해 주세요.` +
    `\n근거가 부족한 부분은 data_gaps 와 follow_up_questions 에 기재해 주세요.`
  );

  return parts.join("\n");
}

// ─── 출력 스키마 ──────────────────────────────────────────────────────────────

const APPEAL_POINTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["appeal_points", "data_gaps", "follow_up_questions"],
  properties: {
    appeal_points: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "description",
          "evidence_texts",
          "evidence_ranks",
          "section",
          "category",
          "confidence",
        ],
        properties: {
          title:          { type: "string" },
          description:    { type: "string" },
          evidence_texts: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 3,
          },
          /**
           * evidence_ranks: 이 어필 포인트를 뒷받침하는 근거 레코드의 rank 번호 목록.
           * buildEvidenceContext 출력의 [N] 인덱스를 그대로 사용한다.
           * 1-based integer (rankedEvidence 배열의 rank 필드).
           */
          evidence_ranks: {
            type: "array",
            items: { type: "integer" },
            minItems: 0,
            maxItems: 3,
          },
          section: {
            type: "string",
            enum: ["experience", "skills", "summary"],
          },
          /**
           * category: 어필 포인트의 유형 분류.
           *   achievement  — 성과: 정량적/정성적 결과 (배포, 성능 개선, 버그 수정 등)
           *   contribution — 기여: 팀/조직에 대한 기여 (코드 리뷰, 온보딩, 문서화 등)
           *   capability   — 역량: 기술적/행동적 역량 (설계 능력, 문제 해결력 등)
           */
          category: {
            type: "string",
            enum: ["achievement", "contribution", "capability"],
          },
          confidence: { type: "number" },
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
      maxItems: 5,
    },
  },
};

// ─── Heuristic fallback ───────────────────────────────────────────────────────

/**
 * OpenAI 가 비활성화된 환경에서 근거 텍스트 기반으로 어필 포인트를 생성한다.
 * 각 소스에서 최상위 레코드 1건씩을 어필 포인트로 직접 변환한다.
 * sourceRefs 는 해당 레코드의 provenance 에서 직접 구성한다.
 *
 * @param {string} query
 * @param {RankedEvidenceRecord[]} rankedEvidence
 * @param {number} maxPoints
 * @returns {AppealPointsResult}
 */
function buildHeuristicAppealPoints(query, rankedEvidence, maxPoints) {
  const points = rankedEvidence
    .slice(0, maxPoints)
    .map((r, i) => ({
      id: `ap-${i}`,
      title: truncateTitle(r.text),
      description: r.text.trim().slice(0, 200),
      evidenceTexts: [r.text.trim().slice(0, 200)],
      section: inferSection(r),
      category: inferCategory(r.text, ""),
      confidence: Math.min(1.0, (r.relevanceScore ?? 0) > 0 ? 0.7 : 0.5),
      sourceRefs: [_buildSourceRef(r)],
    }));

  return {
    appealPoints: points,
    dataGaps: points.length === 0
      ? ["검색된 근거가 없어 어필 포인트를 생성할 수 없습니다."]
      : [],
    followUpQuestions: points.length === 0
      ? ["어떤 기간이나 프로젝트에 대해 알아보고 싶으신가요?"]
      : [],
    evidenceUsed: rankedEvidence.slice(0, maxPoints),
  };
}

/**
 * LLM 출력을 정규화된 AppealPointsResult 로 변환한다.
 *
 * evidence_ranks 배열을 이용하여 각 AppealPoint 의 sourceRefs 를 채운다.
 * rank 는 mergeAndRankEvidence() 가 부여한 1-based 정수이다.
 *
 * @param {object} parsed
 * @param {RankedEvidenceRecord[]} rankedEvidence
 * @returns {AppealPointsResult}
 */
function normalizeAppealPointsResult(parsed, rankedEvidence) {
  // rank → record 인덱스 맵 (O(1) lookup)
  const rankMap = new Map(rankedEvidence.map((r) => [r.rank, r]));

  const rawPoints = Array.isArray(parsed.appeal_points) ? parsed.appeal_points : [];

  const appealPoints = rawPoints
    .filter((p) => p && typeof p.title === "string" && p.title.trim())
    .map((p, i) => {
      const evidenceTexts = Array.isArray(p.evidence_texts)
        ? p.evidence_texts
            .filter((t) => typeof t === "string" && t.trim())
            .map((t) => t.trim())
            .slice(0, 3)
        : [];

      // evidence_ranks: LLM 이 반환한 rank 번호 목록 (1-based)
      const evidenceRanks = Array.isArray(p.evidence_ranks)
        ? p.evidence_ranks.filter((n) => Number.isInteger(n) && n >= 1)
        : [];

      // sourceRefs: evidenceRanks 를 rankedEvidence 에 조회하여 출처 메타데이터 포함
      const sourceRefs = evidenceRanks
        .map((rank) => rankMap.get(rank))
        .filter(Boolean)
        .map((r) => _buildSourceRef(r));

      return {
        id: `ap-${i}`,
        title: String(p.title).trim(),
        description: String(p.description ?? "").trim(),
        evidenceTexts,
        section: ["experience", "skills", "summary"].includes(p.section)
          ? p.section
          : null,
        category: ["achievement", "contribution", "capability"].includes(p.category)
          ? p.category
          : inferCategory(String(p.description ?? ""), String(p.title ?? "")),
        confidence: typeof p.confidence === "number"
          ? Math.max(0, Math.min(1, p.confidence))
          : 0.5,
        sourceRefs,
      };
    });

  const dataGaps = Array.isArray(parsed.data_gaps)
    ? parsed.data_gaps.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
    : [];

  const followUpQuestions = Array.isArray(parsed.follow_up_questions)
    ? parsed.follow_up_questions
        .filter((s) => typeof s === "string" && s.trim())
        .map((s) => s.trim())
    : [];

  return {
    appealPoints,
    dataGaps,
    followUpQuestions,
    evidenceUsed: rankedEvidence,
  };
}

// ─── 유틸리티 ─────────────────────────────────────────────────────────────────

/**
 * 소스 타입과 메타데이터를 기반으로 이력서 섹션을 추론한다.
 *
 * @param {EvidenceRecord} record
 * @returns {'experience'|'skills'|'summary'}
 */
function inferSection(record) {
  if (record.source === "commits") return "experience";
  if (record.source === "slack")   return "experience";
  // session: 기술 스택 언급이 있으면 skills, 없으면 experience
  return "experience";
}

/**
 * 텍스트 기반 규칙으로 어필 포인트의 카테고리를 추론한다.
 *
 * 카테고리:
 *   achievement  — 성과: 정량적/정성적 결과
 *   contribution — 기여: 팀/조직 기여
 *   capability   — 역량: 기술적/행동적 역량
 *
 * @param {string} description  어필 포인트 설명
 * @param {string} title        어필 포인트 제목
 * @returns {'achievement'|'contribution'|'capability'}
 */
export function inferCategory(description, title) {
  const text = `${title} ${description}`.toLowerCase();

  // 성과(achievement) 키워드: 결과·수치·배포·개선 지향적 표현
  const achievementPatterns = [
    /\d+%/, /\d+배/, /\d+건/, /\d+개/,                     // 수치 포함
    /배포/, /출시/, /런칭/, /launch/i, /deploy/i, /release/i,
    /개선/, /향상/, /감소/, /단축/, /절감/,                    // 개선 지향
    /improve/i, /reduce/i, /increase/i, /decrease/i,
    /해결/, /수정/, /fix/i, /resolve/i, /bug/i,
    /성능/, /performance/i, /속도/, /안정성/, /reliability/i,
    /완료/, /구축/, /구현/, /implement/i, /build/i, /complete/i,
  ];

  // 기여(contribution) 키워드: 팀·협업·프로세스 지향적 표현
  const contributionPatterns = [
    /리뷰/, /review/i, /온보딩/, /onboard/i,
    /문서/, /document/i, /가이드/, /guide/i,
    /공유/, /share/i, /전파/, /전달/,
    /멘토/, /mentor/i, /교육/, /training/i,
    /프로세스/, /process/i, /워크플로/, /workflow/i,
    /팀/, /team/i, /협업/, /collaborat/i,
    /표준/, /standard/i, /컨벤션/, /convention/i,
  ];

  // 역량(capability) 키워드: 설계·기술·분석 지향적 표현
  const capabilityPatterns = [
    /설계/, /design/i, /아키텍처/, /architect/i,
    /분석/, /analy/i, /진단/, /diagnos/i,
    /패턴/, /pattern/i, /전략/, /strategy/i,
    /역량/, /능력/, /숙련/, /proficien/i, /expert/i,
    /기술/, /tech/i, /스택/, /stack/i,
    /이해/, /학습/, /습득/, /learn/i,
  ];

  const achievementScore = achievementPatterns.filter((p) => p.test(text)).length;
  const contributionScore = contributionPatterns.filter((p) => p.test(text)).length;
  const capabilityScore = capabilityPatterns.filter((p) => p.test(text)).length;

  if (achievementScore >= contributionScore && achievementScore >= capabilityScore) {
    return "achievement";
  }
  if (contributionScore >= capabilityScore) {
    return "contribution";
  }
  return "capability";
}

/**
 * exploreWithQueryAnalysis() 결과에서 직접 어필 포인트를 생성하는 편의 함수.
 *
 * 탐색 결과(ExploreResult)를 받아 병합·랭킹 후 LLM 기반 어필 포인트를
 * 생성하는 전체 파이프라인을 단일 호출로 실행한다.
 *
 * @param {string} query  사용자 원본 질의
 * @param {{
 *   commits:    object[],
 *   slack:      object[],
 *   sessions:   object[],
 *   totalCount: number,
 *   sourceMeta?: object,
 * }} exploreResult  exploreWithQueryAnalysis() 반환값
 * @param {{
 *   existingResume?: object,
 *   lang?:           'ko' | 'en',
 *   maxPoints?:      number,
 *   topN?:           number,
 * }} [options]
 * @returns {Promise<AppealPointsResult & { rankedEvidence: RankedEvidenceRecord[] }>}
 */
export async function generateAppealPointsFromExploreResult(query, exploreResult, options = {}) {
  const { topN = 15, ...appealOptions } = options;

  // Step 1: 병합·랭킹
  const rankedEvidence = mergeAndRankEvidence(exploreResult, { topN });

  // Step 2: 어필 포인트 생성
  const result = await generateAppealPoints(query, rankedEvidence, appealOptions);

  return {
    ...result,
    rankedEvidence,
  };
}

/**
 * RankedEvidenceRecord 에서 SourceRef 를 생성한다.
 *
 * provenance 의 핵심 식별자(commitHash, messageId 등)를 포함하며,
 * UI 가 인라인 인용을 렌더링하거나 사용자가 원본 출처를 추적하는 데 사용한다.
 *
 * @param {RankedEvidenceRecord} r
 * @returns {import('./resumeTypes.mjs').SourceRef}
 */
function _buildSourceRef(r) {
  return {
    source: r.source,
    date: r.date ?? "",
    text: (r.text ?? "").trim().slice(0, 200),
    rank: r.rank ?? 0,
    provenance: r.provenance ?? null,
  };
}

/**
 * provenance 에서 LLM 컨텍스트에 표시할 짧은 식별자 힌트 문자열을 생성한다.
 *
 * 예시:
 *   커밋 → "hash:abc1234, repo:work-log"
 *   슬랙 → "msgId:1710000000.000, ch:C001"
 *   세션 → "tool:claude"
 *
 * @param {EvidenceRecord & { provenance?: object }} r
 * @returns {string}
 */
function _buildProvenanceHint(r) {
  const p = r.provenance;
  if (!p) return "";

  if (r.source === "commits") {
    const parts = [];
    if (p.commitHash) parts.push(`hash:${p.commitHash}`);
    if (p.repo)       parts.push(`repo:${p.repo}`);
    return parts.join(", ");
  }

  if (r.source === "slack") {
    const parts = [];
    if (p.messageId) parts.push(`msgId:${p.messageId}`);
    if (p.channelId) parts.push(`ch:${p.channelId}`);
    return parts.join(", ");
  }

  if (r.source === "session" || r.source === "sessions") {
    if (p.sessionType) return `tool:${p.sessionType}`;
  }

  return "";
}

/**
 * 텍스트에서 짧은 제목을 추출한다 (최대 50자).
 *
 * @param {string} text
 * @returns {string}
 */
function truncateTitle(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= 50) return clean;
  return clean.slice(0, 47) + "...";
}

/**
 * LLM 응답에서 output_text 를 추출한다.
 *
 * @param {object} data
 * @returns {string|null}
 */
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
