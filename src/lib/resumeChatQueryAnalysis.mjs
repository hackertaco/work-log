/**
 * resumeChatQueryAnalysis.mjs
 *
 * 사용자 자유 질의를 받아 의도를 파악하고, 커밋/슬랙/세션 메모리
 * 데이터 소스별로 관련 키워드·기간 등 검색 파라미터를 생성하는 쿼리 분석 모듈.
 *
 * ─── 개요 ─────────────────────────────────────────────────────────────────────
 *
 *   analyzeQuery(rawQuery, options?)
 *     사용자 자유 텍스트 질의 + 선택적 대화 히스토리를 받아
 *     LLM 기반 의도 분석 + 소스별 검색 파라미터를 반환한다.
 *     LLM 호출 실패 시 규칙 기반(regex) 폴백으로 자동 전환된다.
 *
 *   analyzeQueryWithRules(rawQuery)
 *     규칙 기반(regex) 분석만 수행한다. LLM 호출 없이 동기적으로 동작.
 *     프론트엔드 resumeQueryParser.js 의 로직을 서버사이드에서도 재현.
 *
 * ─── QueryAnalysisResult ──────────────────────────────────────────────────────
 *
 *   {
 *     raw:          string,                           // 원본 질의
 *     intent:       string,                           // 분류된 의도
 *     section:      string | null,                    // 대상 이력서 섹션
 *     confidence:   number,                           // 분석 신뢰도 (0.0–1.0)
 *     reasoning:    string,                           // 분석 근거 (디버그용)
 *     method:       'llm' | 'rules',                  // 사용된 분석 방법
 *     sourceParams: {
 *       commits:  SourceSearchParams,
 *       slack:    SourceSearchParams,
 *       sessions: SourceSearchParams,
 *     },
 *     followUpQuestion: string | null,                // 데이터 부족 시 보충 질문
 *   }
 *
 *   SourceSearchParams — {
 *     keywords:    string[],                          // 해당 소스에 최적화된 키워드
 *     dateRange:   { from: string|null, to: string|null } | null,
 *     maxResults:  number,
 *     priority:    'high' | 'medium' | 'low',        // 이 소스의 관련성 우선순위
 *   }
 *
 * ─── 환경변수 ─────────────────────────────────────────────────────────────────
 *
 *   OPENAI_API_KEY             — OpenAI API 키
 *   WORK_LOG_OPENAI_URL        — API URL (기본: https://api.openai.com/v1/responses)
 *   WORK_LOG_OPENAI_MODEL      — 모델 (기본: gpt-5.4-mini)
 *   WORK_LOG_DISABLE_OPENAI    — "1" 로 설정 시 LLM 호출 비활성화
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_LOOKBACK_DAYS = 90;

// ─── Intent 패턴 (규칙 기반 폴백용) ──────────────────────────────────────────

const APPLY_SECTION_PATTERNS = [
  /반영해\s*줘/, /반영해\s*주세요/, /반영\s*해줘/, /반영\s*해주세요/,
  /이대로\s*반영/, /이걸로\s*반영/, /적용해\s*줘/, /적용해\s*주세요/,
  /적용\s*해줘/, /이대로\s*적용/, /이걸로\s*업데이트/, /이대로\s*업데이트/,
  /그대로\s*반영/, /그대로\s*적용/, /apply\s+this/i, /apply\s+it/i,
  /save\s+this/i, /use\s+this/i,
];

const SEARCH_EVIDENCE_PATTERNS = [
  /찾아/, /검색/, /관련.{0,10}내용/, /했던/, /한.{0,5}것/, /기록/, /이력/,
  /언제/, /어디서/, /어떤.{0,5}(작업|업무|프로젝트)/, /슬랙.*메시지/, /커밋/,
  /commit/i, /slack/i,
];

const REFINE_SECTION_PATTERNS = [
  /수정/, /바꿔/, /고쳐/, /변경/, /추가/, /개선/, /업데이트/, /작성/,
  /보완/, /다듬/, /edit/i, /update/i, /improve/i, /rewrite/i,
];

const QUESTION_PATTERNS = [
  /\?$/, /뭐야/, /뭐에요/, /어때/, /어떤가/, /알려줘/, /설명해/,
  /어떻게/, /왜/, /무슨/,
];

// ─── Section 패턴 ────────────────────────────────────────────────────────────

const SECTION_PATTERNS = [
  { section: "experience", patterns: [/경험/, /경력/, /직장/, /회사/, /재직/, /근무/, /업무/, /experience/i, /work\s/i] },
  { section: "skills", patterns: [/기술/, /스킬/, /역량/, /능력/, /tool/, /언어/, /프레임워크/, /skills?/i, /tech/i] },
  { section: "summary", patterns: [/요약/, /자기소개/, /소개/, /프로필/, /summary/i, /profile/i] },
  { section: "education", patterns: [/학력/, /교육/, /졸업/, /대학/, /학교/, /education/i, /degree/i] },
  { section: "projects", patterns: [/프로젝트/, /project/i, /개발/, /구현/, /만든/] },
  { section: "strengths", patterns: [/강점/, /행동\s*패턴/, /강점\s*분석/, /핵심\s*강점/, /셀링\s*포인트/, /selling\s*point/i, /strengths?/i] },
];

// ─── Stopwords ───────────────────────────────────────────────────────────────

const KO_STOPWORDS = new Set([
  "에", "에서", "을", "를", "이", "가", "은", "는", "의", "와", "과", "도", "로",
  "으로", "에게", "한", "하다", "있다", "없다", "하고", "그리고", "하지만", "또는",
  "관련", "대한", "대해", "내용", "것", "수", "때", "등", "또", "및", "그", "이런",
  "저런", "어떤", "뭔가", "조금", "더", "좀", "그냥", "잠깐", "정말", "매우", "너무",
  "아주", "다시", "계속", "항상", "혹시", "제발", "좋은", "나쁜", "해줘", "해주세요",
  "알려줘", "알려주세요", "찾아줘", "찾아주세요", "보여줘", "보여주세요",
]);

const EN_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "shall", "can", "need", "dare", "ought", "used",
  "i", "me", "my", "we", "you", "he", "she", "it", "they", "them",
  "this", "that", "these", "those", "what", "which", "who", "how", "when", "where",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about",
  "and", "but", "or", "nor", "so", "yet", "both", "either", "neither", "not",
  "no", "nor", "too", "very", "just", "also", "more", "most", "some", "any", "all",
]);

// ─── Public types (JSDoc) ─────────────────────────────────────────────────────

/**
 * @typedef {Object} SourceSearchParams
 * @property {string[]}   keywords     해당 소스에 최적화된 검색 키워드
 * @property {{ from: string|null, to: string|null }|null} dateRange  날짜 범위
 * @property {number}     maxResults   최대 결과 수
 * @property {'high'|'medium'|'low'} priority   이 소스의 관련성 우선순위
 */

/**
 * @typedef {Object} QueryAnalysisResult
 * @property {string}        raw              원본 질의
 * @property {string}        intent           분류된 의도
 * @property {string|null}   section          대상 이력서 섹션
 * @property {number}        confidence       분석 신뢰도 (0.0–1.0)
 * @property {string}        reasoning        분석 근거 (디버그용)
 * @property {'llm'|'rules'} method           사용된 분석 방법
 * @property {{ commits: SourceSearchParams, slack: SourceSearchParams, sessions: SourceSearchParams }} sourceParams
 * @property {string|null}   followUpQuestion 데이터 부족 시 보충 질문
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * 사용자 자유 텍스트 질의를 분석하여 의도와 소스별 검색 파라미터를 생성한다.
 *
 * LLM 호출에 성공하면 정밀한 소스별 키워드를 반환하고,
 * 실패 시 규칙 기반 폴백으로 자동 전환된다.
 *
 * @param {string} rawQuery - 사용자 원본 질의
 * @param {Object} [options]
 * @param {{ role: string, content: string }[]} [options.history]  대화 히스토리
 * @param {string|null} [options.currentResumeContext]  현재 이력서 요약 (선택)
 * @returns {Promise<QueryAnalysisResult>}
 */
export async function analyzeQuery(rawQuery, options = {}) {
  const trimmed = (rawQuery || "").trim();
  if (!trimmed) {
    return _emptyResult();
  }

  // LLM 사용 가능 여부 확인
  const apiKey = process.env.OPENAI_API_KEY;
  const disabled = process.env.WORK_LOG_DISABLE_OPENAI === "1";

  if (!apiKey || disabled) {
    return analyzeQueryWithRules(trimmed);
  }

  // LLM 기반 분석 시도
  try {
    const result = await _analyzeWithLLM(trimmed, options);
    return result;
  } catch (err) {
    console.warn(
      "[resumeChatQueryAnalysis] LLM analysis failed, falling back to rules:",
      err.message
    );
    return analyzeQueryWithRules(trimmed);
  }
}

/**
 * 규칙 기반(regex) 분석만 수행한다. LLM 호출 없이 동기적으로 동작.
 *
 * @param {string} rawQuery - 사용자 원본 질의
 * @returns {QueryAnalysisResult}
 */
export function analyzeQueryWithRules(rawQuery) {
  const raw = (rawQuery || "").trim();
  if (!raw) return _emptyResult();

  const intent = _detectIntent(raw);
  const section = _detectSection(raw);
  const dateRange = _extractDateRange(raw);
  const keywords = _extractKeywords(raw);

  // 소스별 검색 파라미터 생성 — 동일 키워드를 소스 우선순위만 다르게 배분
  const sourceParams = _buildSourceParamsFromRules(raw, keywords, dateRange, intent);

  // 신뢰도 계산
  const confidence = _computeRulesConfidence(intent, keywords, section);

  // 키워드가 부족하면 보충 질문 생성
  const followUpQuestion = _generateFollowUpQuestion(intent, keywords, section);

  return {
    raw,
    intent,
    section,
    confidence,
    reasoning: `규칙 기반 분석: intent=${intent}, keywords=${keywords.length}개, section=${section || "없음"}`,
    method: "rules",
    sourceParams,
    followUpQuestion,
  };
}

/**
 * QueryAnalysisResult 에서 searchAllSources 호환 SearchQuery 를 추출한다.
 * (기존 resumeChatSearch.mjs 와의 연동 편의 함수)
 *
 * @param {QueryAnalysisResult} analysis
 * @param {'commits'|'slack'|'sessions'} source
 * @returns {{ keywords: string[], dateRange?: { from: string, to: string }, maxResults: number }}
 */
export function toSearchQuery(analysis, source) {
  const params = analysis.sourceParams[source];
  if (!params) {
    return { keywords: [], maxResults: DEFAULT_MAX_RESULTS };
  }

  const query = {
    keywords: params.keywords,
    maxResults: params.maxResults,
  };

  if (params.dateRange && (params.dateRange.from || params.dateRange.to)) {
    query.dateRange = {
      from: params.dateRange.from || _daysAgoISO(DEFAULT_LOOKBACK_DAYS),
      to: params.dateRange.to || _todayISO(),
    };
  }

  return query;
}

/**
 * QueryAnalysisResult 에서 통합 SearchQuery (모든 소스 공용) 를 생성한다.
 * 세 소스의 키워드를 합집합으로 결합한다.
 *
 * @param {QueryAnalysisResult} analysis
 * @returns {{ keywords: string[], dateRange?: { from: string, to: string }, maxResults: number }}
 */
export function toUnifiedSearchQuery(analysis) {
  const allKeywords = new Set();
  let dateRange = null;
  let maxResults = DEFAULT_MAX_RESULTS;

  for (const source of ["commits", "slack", "sessions"]) {
    const params = analysis.sourceParams[source];
    if (!params) continue;

    for (const kw of params.keywords) allKeywords.add(kw);
    if (params.dateRange) dateRange = dateRange || params.dateRange;
    maxResults = Math.max(maxResults, params.maxResults);
  }

  const query = {
    keywords: [...allKeywords],
    maxResults,
  };

  if (dateRange && (dateRange.from || dateRange.to)) {
    query.dateRange = {
      from: dateRange.from || _daysAgoISO(DEFAULT_LOOKBACK_DAYS),
      to: dateRange.to || _todayISO(),
    };
  }

  return query;
}

// ─── LLM 기반 분석 ───────────────────────────────────────────────────────────

/**
 * OpenAI LLM 을 호출하여 정밀한 쿼리 분석을 수행한다.
 *
 * @param {string} query
 * @param {Object} options
 * @returns {Promise<QueryAnalysisResult>}
 */
async function _analyzeWithLLM(query, options = {}) {
  const { history = [], currentResumeContext = null } = options;

  const systemPrompt = _buildSystemPrompt(currentResumeContext);
  const userPrompt = _buildUserPrompt(query, history);

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "query_analysis",
        strict: true,
        schema: _getAnalysisJsonSchema(),
      },
    },
    max_output_tokens: 600,
  };

  const apiKey = process.env.OPENAI_API_KEY;
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
    throw new Error(`OpenAI query analysis failed: ${response.status} ${errorText.slice(0, 400)}`);
  }

  const data = await response.json();
  const text = data.output_text || _extractOutputText(data);

  if (!text) {
    throw new Error("OpenAI query analysis: empty output");
  }

  const parsed = JSON.parse(text);
  return _mapLLMResponseToResult(query, parsed);
}

/**
 * LLM 시스템 프롬프트를 생성한다.
 *
 * @param {string|null} currentResumeContext
 * @returns {string}
 */
function _buildSystemPrompt(currentResumeContext) {
  let prompt = `당신은 이력서 구체화 도우미의 쿼리 분석 엔진입니다.
사용자의 자유 텍스트 질의를 분석하여 의도를 파악하고,
세 가지 데이터 소스(커밋 로그, 슬랙 메시지, AI 세션 메모리)별로
최적화된 검색 파라미터를 생성하세요.

## 데이터 소스 특성

1. **커밋 로그(commits)**: git 커밋 메시지, 코드 변경 요약, 스토리 스레드.
   - 기술적 키워드, 프로젝트명, 라이브러리명이 효과적
   - 예: "React", "결제 API", "리팩토링", "마이그레이션"

2. **슬랙 메시지(slack)**: 팀 커뮤니케이션, 의사결정 기록, 리뷰 논의.
   - 비즈니스 용어, 프로젝트 코드명, 팀/사람 이름이 효과적
   - 예: "출시", "리뷰", "장애 대응", "성능 개선"

3. **AI 세션 메모리(sessions)**: 코딩 어시스턴트 세션, AI 리뷰 노트, 작업 스타일 신호.
   - 기술 문제 해결, 아키텍처 논의, 디버깅 관련 키워드가 효과적
   - 예: "디버깅", "설계", "아키텍처", "최적화", "테스트"

## 의도(intent) 분류

- **apply_section**: 이전 대화에서 제안된 내용을 이력서에 반영하려는 의도
- **search_evidence**: 특정 작업/프로젝트의 증거를 데이터 소스에서 검색
- **refine_section**: 이력서의 특정 섹션을 개선/수정
- **question**: 이력서 관련 질문
- **general**: 일반적인 대화

## 소스 우선순위(priority) 기준

- **high**: 해당 질의에 가장 관련 높은 소스
- **medium**: 보조적으로 유용한 소스
- **low**: 관련성이 낮지만 혹시 모를 소스

## 핵심 규칙

- 근거 없이 허구를 생성하지 마세요
- 키워드가 부족하면 followUpQuestion 으로 보충 질문을 생성하세요
- 각 소스에 맞는 다른 키워드를 생성하세요 (동일 키워드가 아닌 소스 특성에 맞게)
- 날짜 관련 표현이 있으면 dateRange 를 설정하세요`;

  if (currentResumeContext) {
    prompt += `\n\n## 현재 이력서 컨텍스트\n${currentResumeContext}`;
  }

  return prompt;
}

/**
 * LLM 사용자 프롬프트를 생성한다.
 *
 * @param {string} query
 * @param {{ role: string, content: string }[]} history
 * @returns {string}
 */
function _buildUserPrompt(query, history) {
  let prompt = `질의: "${query}"`;

  if (history.length > 0) {
    const recentHistory = history.slice(-6);
    const historyText = recentHistory
      .map((msg) => `[${msg.role}] ${(msg.content || "").slice(0, 200)}`)
      .join("\n");
    prompt += `\n\n최근 대화 히스토리:\n${historyText}`;
  }

  prompt += "\n\n위 질의를 분석하여 JSON 으로 응답하세요.";

  return prompt;
}

/**
 * LLM JSON 스키마를 반환한다.
 * @returns {object}
 */
function _getAnalysisJsonSchema() {
  const sourceParamsSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      keywords: {
        type: "array",
        items: { type: "string" },
        minItems: 0,
        maxItems: 10,
      },
      date_from: { type: ["string", "null"] },
      date_to: { type: ["string", "null"] },
      max_results: { type: "number" },
      priority: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["keywords", "date_from", "date_to", "max_results", "priority"],
  };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      intent: {
        type: "string",
        enum: [
          "apply_section",
          "search_evidence",
          "refine_section",
          "question",
          "general",
        ],
      },
      section: {
        type: ["string", "null"],
        enum: [
          "experience", "skills", "summary", "education",
          "projects", "strengths", null,
        ],
      },
      confidence: { type: "number" },
      reasoning: { type: "string" },
      commits: sourceParamsSchema,
      slack: sourceParamsSchema,
      sessions: sourceParamsSchema,
      follow_up_question: { type: ["string", "null"] },
    },
    required: [
      "intent", "section", "confidence", "reasoning",
      "commits", "slack", "sessions", "follow_up_question",
    ],
  };
}

/**
 * LLM 응답을 QueryAnalysisResult 로 매핑한다.
 *
 * @param {string} rawQuery
 * @param {object} parsed
 * @returns {QueryAnalysisResult}
 */
function _mapLLMResponseToResult(rawQuery, parsed) {
  const mapSource = (src) => ({
    keywords: Array.isArray(src?.keywords) ? src.keywords.filter(Boolean) : [],
    dateRange: (src?.date_from || src?.date_to)
      ? { from: src.date_from || null, to: src.date_to || null }
      : null,
    maxResults: typeof src?.max_results === "number" ? src.max_results : DEFAULT_MAX_RESULTS,
    priority: ["high", "medium", "low"].includes(src?.priority) ? src.priority : "medium",
  });

  return {
    raw: rawQuery,
    intent: parsed.intent || "general",
    section: parsed.section || null,
    confidence: typeof parsed.confidence === "number"
      ? Math.min(1.0, Math.max(0.0, parsed.confidence))
      : 0.5,
    reasoning: parsed.reasoning || "",
    method: "llm",
    sourceParams: {
      commits: mapSource(parsed.commits),
      slack: mapSource(parsed.slack),
      sessions: mapSource(parsed.sessions),
    },
    followUpQuestion: parsed.follow_up_question || null,
  };
}

// ─── 규칙 기반 분석 유틸 ─────────────────────────────────────────────────────

/**
 * 규칙 기반 intent 분류.
 * @param {string} text
 * @returns {string}
 */
function _detectIntent(text) {
  if (APPLY_SECTION_PATTERNS.some((p) => p.test(text))) return "apply_section";
  if (REFINE_SECTION_PATTERNS.some((p) => p.test(text))) return "refine_section";
  if (SEARCH_EVIDENCE_PATTERNS.some((p) => p.test(text))) return "search_evidence";
  if (QUESTION_PATTERNS.some((p) => p.test(text))) return "question";
  return "general";
}

/**
 * 규칙 기반 섹션 감지.
 * @param {string} text
 * @returns {string|null}
 */
function _detectSection(text) {
  for (const { section, patterns } of SECTION_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return section;
  }
  return null;
}

/**
 * 규칙 기반 날짜 범위 추출.
 * @param {string} text
 * @returns {{ from: string|null, to: string|null }|null}
 */
function _extractDateRange(text) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // 절대 연도 + 월 패턴
  const yearMatch = text.match(/(\d{4})년/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    const monthMatch = text.match(/(\d{1,2})월/);
    if (monthMatch) {
      const month = monthMatch[1].padStart(2, "0");
      return { from: `${year}-${month}-01`, to: `${year}-${month}-31` };
    }
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  // 상대 기간 패턴
  if (/올해/.test(text)) return { from: `${currentYear}-01-01`, to: `${currentYear}-12-31` };
  if (/작년/.test(text)) return { from: `${currentYear - 1}-01-01`, to: `${currentYear - 1}-12-31` };
  if (/지난달/.test(text)) {
    const m = currentMonth === 1 ? 12 : currentMonth - 1;
    const y = currentMonth === 1 ? currentYear - 1 : currentYear;
    return { from: `${y}-${String(m).padStart(2, "0")}-01`, to: `${y}-${String(m).padStart(2, "0")}-31` };
  }
  if (/이번달|이달/.test(text)) {
    return {
      from: `${currentYear}-${String(currentMonth).padStart(2, "0")}-01`,
      to: `${currentYear}-${String(currentMonth).padStart(2, "0")}-31`,
    };
  }

  const recentMonths = text.match(/최근\s*(\d+)\s*개?월/);
  if (recentMonths) {
    const months = parseInt(recentMonths[1], 10);
    const fromDate = new Date(now);
    fromDate.setMonth(fromDate.getMonth() - months);
    return { from: fromDate.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
  }

  // "지난주" 패턴
  if (/지난\s*주/.test(text)) {
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - 7);
    return { from: fromDate.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
  }

  // "최근 N일" 패턴
  const recentDays = text.match(/최근\s*(\d+)\s*일/);
  if (recentDays) {
    const days = parseInt(recentDays[1], 10);
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - days);
    return { from: fromDate.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
  }

  return null;
}

/**
 * 텍스트에서 의미 있는 키워드를 추출한다.
 * @param {string} text
 * @returns {string[]}
 */
export function extractKeywords(text) {
  const keywords = [];

  // 따옴표 구문 먼저 추출
  const quotedMatches = text.matchAll(/["'"'](.+?)["'"']/g);
  for (const m of quotedMatches) {
    const phrase = m[1].trim();
    if (phrase.length > 1) keywords.push(phrase);
  }

  const stripped = text.replace(/["'"'].+?["'"']/g, " ");

  // 한글 단어 (2글자 이상, 불용어 제외)
  const koreanWords = stripped.match(/[가-힣]+/g) || [];
  for (const word of koreanWords) {
    if (word.length >= 2 && !KO_STOPWORDS.has(word)) keywords.push(word);
  }

  // 영어/숫자 단어 (2글자 이상, 불용어 제외)
  const englishWords = stripped.match(/[a-zA-Z][a-zA-Z0-9_.-]*/g) || [];
  for (const word of englishWords) {
    if (word.length >= 2 && !EN_STOPWORDS.has(word.toLowerCase())) keywords.push(word);
  }

  // 중복 제거
  const seen = new Set();
  return keywords.filter((kw) => {
    const key = kw.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── _extractKeywords 내부 전용 별칭 ─────────────────────────────────────────
const _extractKeywords = extractKeywords;

/**
 * 규칙 기반에서 소스별 검색 파라미터를 생성한다.
 *
 * 소스 특성에 따라 키워드와 우선순위를 차별화한다:
 * - 커밋: 기술 키워드 우선, 코드 관련 용어 추가
 * - 슬랙: 비즈니스/프로젝트 키워드 우선, 대화체 용어 추가
 * - 세션: 문제 해결/학습 키워드 우선
 *
 * @param {string} rawText
 * @param {string[]} keywords
 * @param {{ from: string|null, to: string|null }|null} dateRange
 * @param {string} intent
 * @returns {{ commits: SourceSearchParams, slack: SourceSearchParams, sessions: SourceSearchParams }}
 */
function _buildSourceParamsFromRules(rawText, keywords, dateRange, intent) {
  // 소스 우선순위 결정 — 질의 텍스트에 소스 힌트가 있는지 확인
  const mentionsCommit = /커밋|commit|깃|git|코드|개발/i.test(rawText);
  const mentionsSlack = /슬랙|slack|메시지|대화|논의|리뷰/i.test(rawText);
  const mentionsSession = /세션|session|ai|코딩\s*어시스턴트|디버깅|설계/i.test(rawText);

  // 기본: 모든 소스 medium, 언급된 소스는 high
  const commitPriority = mentionsCommit ? "high" : (mentionsSlack || mentionsSession ? "low" : "medium");
  const slackPriority = mentionsSlack ? "high" : (mentionsCommit || mentionsSession ? "low" : "medium");
  const sessionPriority = mentionsSession ? "high" : (mentionsCommit || mentionsSlack ? "low" : "medium");

  // 소스별 키워드 확장
  const commitKeywords = [...keywords];
  const slackKeywords = [...keywords];
  const sessionKeywords = [...keywords];

  // 커밋 특화: 기술 용어 강조 (이미 키워드에 있는 것 제외)
  const techTerms = _extractTechTerms(rawText);
  for (const term of techTerms) {
    if (!commitKeywords.some((kw) => kw.toLowerCase() === term.toLowerCase())) {
      commitKeywords.push(term);
    }
  }

  // 세션 특화: 문제 해결/학습 관련 동의어 추가
  const sessionSynonyms = _extractSessionSynonyms(rawText);
  for (const syn of sessionSynonyms) {
    if (!sessionKeywords.some((kw) => kw.toLowerCase() === syn.toLowerCase())) {
      sessionKeywords.push(syn);
    }
  }

  return {
    commits: {
      keywords: commitKeywords,
      dateRange,
      maxResults: commitPriority === "high" ? 25 : DEFAULT_MAX_RESULTS,
      priority: commitPriority,
    },
    slack: {
      keywords: slackKeywords,
      dateRange,
      maxResults: slackPriority === "high" ? 25 : DEFAULT_MAX_RESULTS,
      priority: slackPriority,
    },
    sessions: {
      keywords: sessionKeywords,
      dateRange,
      maxResults: sessionPriority === "high" ? 25 : DEFAULT_MAX_RESULTS,
      priority: sessionPriority,
    },
  };
}

/**
 * 텍스트에서 기술 용어를 추출한다 (커밋 검색 강화용).
 * @param {string} text
 * @returns {string[]}
 */
function _extractTechTerms(text) {
  const terms = [];
  // CamelCase / PascalCase 패턴
  const camelCase = text.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)+/g) || [];
  terms.push(...camelCase);

  // 점 표기법: "React.memo", "Next.js"
  const dotNotation = text.match(/[a-zA-Z]+\.[a-zA-Z]+/g) || [];
  terms.push(...dotNotation);

  // 하이픈 표기법: "server-side", "type-safe"
  const hyphenated = text.match(/[a-zA-Z]+-[a-zA-Z]+/g) || [];
  terms.push(...hyphenated);

  return terms;
}

/**
 * 세션 검색에 적합한 동의어를 추출한다.
 * @param {string} text
 * @returns {string[]}
 */
function _extractSessionSynonyms(text) {
  const synonymMap = {
    "성능": ["최적화", "performance", "optimization"],
    "버그": ["디버깅", "에러", "오류", "fix", "bug"],
    "테스트": ["testing", "단위 테스트", "unit test"],
    "설계": ["아키텍처", "architecture", "design"],
    "리팩토링": ["refactor", "개선", "정리"],
    "배포": ["deploy", "릴리스", "release"],
    "API": ["엔드포인트", "endpoint", "인터페이스"],
    "마이그레이션": ["migration", "이전", "전환"],
  };

  const synonyms = [];
  for (const [trigger, syns] of Object.entries(synonymMap)) {
    if (text.toLowerCase().includes(trigger.toLowerCase())) {
      synonyms.push(...syns);
    }
  }

  return synonyms;
}

/**
 * 규칙 기반 분석의 신뢰도를 계산한다.
 * @param {string} intent
 * @param {string[]} keywords
 * @param {string|null} section
 * @returns {number}
 */
function _computeRulesConfidence(intent, keywords, section) {
  let confidence = 0.4;

  if (intent !== "general") confidence += 0.15;
  if (keywords.length > 0) confidence += 0.15;
  if (keywords.length >= 3) confidence += 0.1;
  if (section) confidence += 0.15;

  return Math.min(1.0, confidence);
}

/**
 * 키워드 부족 등의 경우 보충 질문을 생성한다.
 * @param {string} intent
 * @param {string[]} keywords
 * @param {string|null} section
 * @returns {string|null}
 */
function _generateFollowUpQuestion(intent, keywords, section) {
  if (intent === "apply_section") return null; // apply 는 별도 처리

  if (keywords.length === 0) {
    return "어떤 프로젝트나 작업에 대해 찾아볼까요? 구체적인 키워드나 기간을 알려주시면 더 정확한 결과를 찾을 수 있습니다.";
  }

  if (intent === "refine_section" && !section) {
    return "이력서의 어떤 섹션을 수정할까요? (예: 경력, 기술, 자기소개, 강점, 프로젝트)";
  }

  return null;
}

// ─── 공용 유틸 ───────────────────────────────────────────────────────────────

/**
 * 빈 결과를 반환한다.
 * @returns {QueryAnalysisResult}
 */
function _emptyResult() {
  const emptyParams = {
    keywords: [],
    dateRange: null,
    maxResults: DEFAULT_MAX_RESULTS,
    priority: "low",
  };
  return {
    raw: "",
    intent: "general",
    section: null,
    confidence: 0,
    reasoning: "빈 질의",
    method: "rules",
    sourceParams: {
      commits: { ...emptyParams },
      slack: { ...emptyParams },
      sessions: { ...emptyParams },
    },
    followUpQuestion: null,
  };
}

/**
 * OpenAI Responses API 에서 output_text 를 추출한다.
 * @param {object} data
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

function _todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function _daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
