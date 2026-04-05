/**
 * resumeChatExplore.mjs
 *
 * 쿼리 분석 결과를 기반으로 커밋/슬랙/세션 메모리 데이터 소스를
 * 검색·필터링하는 탐색 로직 통합 모듈.
 *
 * ─── 개요 ─────────────────────────────────────────────────────────────────────
 *
 *   두 가지 쿼리 분석기 출력을 모두 수용하여 데이터 소스를 탐색한다:
 *
 *   1. AnalyzedQuery (resumeQueryAnalyzer.mjs)
 *      — sourceParams.{source}.enabled: boolean
 *      — sourceParams.{source}.keywords: string[]
 *
 *   2. QueryAnalysisResult (resumeChatQueryAnalysis.mjs)
 *      — sourceParams.{source}.priority: 'high' | 'medium' | 'low'
 *      — sourceParams.{source}.keywords: string[]
 *
 *   exploreWithQueryAnalysis() 는 두 형식을 자동 감지하여 적절한 탐색 전략을 적용한다.
 *
 * ─── 탐색 전략 ────────────────────────────────────────────────────────────────
 *
 *   Priority → maxResults 매핑:
 *     high   → 소스 원래 maxResults (보통 15–25)
 *     medium → 소스 원래 maxResults의 60% (최소 5)
 *     low    → 소스 원래 maxResults의 30% (최소 3), confidence < 0.3 이면 건너뜀
 *
 *   Enabled flag (AnalyzedQuery 형식):
 *     enabled === false → 건너뜀
 *     enabled === true  → maxResults 그대로 적용
 *
 * ─── 결과 구조 ────────────────────────────────────────────────────────────────
 *
 *   ExploreResult = {
 *     commits:    ChatEvidenceRecord[],
 *     slack:      ChatEvidenceRecord[],
 *     sessions:   ChatEvidenceRecord[],
 *     totalCount: number,
 *     sourceMeta: {
 *       commits:  { searched: boolean, resultCount: number, keywords: string[] },
 *       slack:    { searched: boolean, resultCount: number, keywords: string[] },
 *       sessions: { searched: boolean, resultCount: number, keywords: string[] },
 *     },
 *     followUpQuestion: string | null,
 *   }
 *
 * ─── 사용 예시 ────────────────────────────────────────────────────────────────
 *
 *   import { exploreWithQueryAnalysis } from './resumeChatExplore.mjs';
 *   import { analyzeQuery } from './resumeChatQueryAnalysis.mjs';
 *
 *   const analysis = await analyzeQuery("Redis 캐싱 관련 작업 찾아줘");
 *   const result = await exploreWithQueryAnalysis(analysis);
 *   // → { commits: [...], slack: [...], sessions: [...], totalCount: 12, sourceMeta: {...} }
 */

import {
  searchCommits,
  searchSlack,
  searchSessionMemory,
} from "./resumeEvidenceSearch.mjs";

import { loadConfig } from "./config.mjs";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_LOOKBACK_DAYS = 90;

/**
 * Priority → maxResults 비율 매핑
 * @type {Record<string, number>}
 */
const PRIORITY_RATIO = {
  high: 1.0,
  medium: 0.6,
  low: 0.3,
};

/** Priority별 최소 maxResults */
const PRIORITY_MIN_RESULTS = {
  high: 10,
  medium: 5,
  low: 3,
};

/** 이 confidence 미만 & low priority인 소스는 건너뛴다 */
const LOW_PRIORITY_SKIP_THRESHOLD = 0.3;

// ─── Public types (JSDoc) ─────────────────────────────────────────────────────

/**
 * 소스별 탐색 메타데이터
 *
 * @typedef {Object} SourceMeta
 * @property {boolean}   searched     이 소스를 실제로 검색했는지
 * @property {number}    resultCount  반환된 결과 수
 * @property {string[]}  keywords     검색에 사용된 키워드
 * @property {string}    [priority]   소스 우선순위 (priority 모드 시)
 * @property {string}    [skipReason] 건너뛴 이유 (미검색 시)
 */

/**
 * 탐색 결과
 *
 * @typedef {Object} ExploreResult
 * @property {import('./resumeTypes.mjs').ChatEvidenceRecord[]} commits   커밋 소스 결과
 * @property {import('./resumeTypes.mjs').ChatEvidenceRecord[]} slack     슬랙 소스 결과
 * @property {import('./resumeTypes.mjs').ChatEvidenceRecord[]} sessions  세션 소스 결과
 * @property {number}    totalCount   전체 결과 수
 * @property {{ commits: SourceMeta, slack: SourceMeta, sessions: SourceMeta }} sourceMeta
 * @property {string|null} followUpQuestion  보충 질문 (데이터 부족 시)
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * 쿼리 분석 결과를 기반으로 세 데이터 소스를 탐색한다.
 *
 * AnalyzedQuery (enabled 필드) 와 QueryAnalysisResult (priority 필드)
 * 두 형식을 모두 수용한다. 형식 자동 감지:
 *   - sourceParams.commits.enabled 필드가 있으면 → AnalyzedQuery 형식
 *   - sourceParams.commits.priority 필드가 있으면 → QueryAnalysisResult 형식
 *   - 둘 다 있으면 enabled 우선
 *
 * @param {object} analysis  analyzeQuery() 또는 analyzeQueryWithRules() 출력
 * @param {{ dataDir?: string }} [options]
 * @returns {Promise<ExploreResult>}
 */
export async function exploreWithQueryAnalysis(analysis, options = {}) {
  if (!analysis || !analysis.sourceParams) {
    return _emptyResult("분석 결과 없음");
  }

  const config = await loadConfig();
  const dataDir = options.dataDir ?? config.dataDir;
  const confidence = analysis.confidence ?? 0;
  const followUpQuestion = analysis.followUpQuestion ?? analysis.clarificationHint ?? null;

  // 소스별 탐색 계획을 수립한다
  const plans = {
    commits: _buildSourcePlan("commits", analysis, confidence),
    slack: _buildSourcePlan("slack", analysis, confidence),
    sessions: _buildSourcePlan("sessions", analysis, confidence),
  };

  // 하나도 검색할 소스가 없으면 즉시 반환
  const hasAnySearch = plans.commits.search || plans.slack.search || plans.sessions.search;
  if (!hasAnySearch) {
    return _emptyResult(followUpQuestion);
  }

  // 소스별 독립 검색을 병렬 실행한다
  const [commits, slack, sessions] = await Promise.all([
    _executeSourceSearch("commits", plans.commits, analysis, dataDir),
    _executeSourceSearch("slack", plans.slack, analysis, dataDir),
    _executeSourceSearch("sessions", plans.sessions, analysis, dataDir),
  ]);

  // 결과 메타데이터 구성
  const sourceMeta = {
    commits: _buildSourceMeta(plans.commits, commits),
    slack: _buildSourceMeta(plans.slack, slack),
    sessions: _buildSourceMeta(plans.sessions, sessions),
  };

  const totalCount = commits.length + slack.length + sessions.length;

  // 결과가 모두 비어있고 키워드가 있었으면 보충 질문 생성
  const effectiveFollowUp = totalCount === 0 && _hasAnyKeywords(analysis)
    ? followUpQuestion ?? "검색 결과가 없습니다. 다른 키워드나 기간으로 다시 시도해 보시겠어요?"
    : followUpQuestion;

  return {
    commits,
    slack,
    sessions,
    totalCount,
    sourceMeta,
    followUpQuestion: effectiveFollowUp,
  };
}

/**
 * 단순 키워드 기반 탐색 (분석 없이 키워드만으로 검색).
 *
 * 모든 소스를 동일 키워드로 검색한다. 분석 모듈 없이 빠르게 검색할 때 사용.
 *
 * @param {{ keywords: string[], dateRange?: { from: string, to: string }, maxResults?: number }} query
 * @param {{ dataDir?: string }} [options]
 * @returns {Promise<ExploreResult>}
 */
export async function exploreWithKeywords(query, options = {}) {
  const { keywords = [], dateRange, maxResults = DEFAULT_MAX_RESULTS } = query;

  if (keywords.length === 0) {
    return _emptyResult("키워드가 없습니다. 어떤 내용을 찾을까요?");
  }

  const config = await loadConfig();
  const dataDir = options.dataDir ?? config.dataDir;

  const parsedQuery = {
    raw: keywords.join(" "),
    intent: "search_evidence",
    keywords,
    section: null,
    dateRange: dateRange ?? null,
  };

  const adapterOptions = { dataDir, maxResults };

  const [commits, slack, sessions] = await Promise.all([
    searchCommits(parsedQuery, adapterOptions).catch(() => []),
    searchSlack(parsedQuery, adapterOptions).catch(() => []),
    searchSessionMemory(parsedQuery, adapterOptions).catch(() => []),
  ]);

  const sourceMeta = {
    commits: { searched: true, resultCount: commits.length, keywords },
    slack: { searched: true, resultCount: slack.length, keywords },
    sessions: { searched: true, resultCount: sessions.length, keywords },
  };

  const totalCount = commits.length + slack.length + sessions.length;

  return {
    commits,
    slack,
    sessions,
    totalCount,
    sourceMeta,
    followUpQuestion: totalCount === 0
      ? "검색 결과가 없습니다. 다른 키워드나 기간으로 다시 시도해 보시겠어요?"
      : null,
  };
}

/**
 * 특정 소스 하나만 탐색한다.
 *
 * 사용자가 명시적으로 "커밋에서 찾아줘" 등 단일 소스를 지정했을 때 사용.
 *
 * @param {"commits"|"slack"|"sessions"} source
 * @param {{ keywords: string[], dateRange?: { from: string, to: string }|null, maxResults?: number }} query
 * @param {{ dataDir?: string }} [options]
 * @returns {Promise<import('./resumeTypes.mjs').ChatEvidenceRecord[]>}
 */
export async function exploreSingleSource(source, query, options = {}) {
  const { keywords = [], dateRange = null, maxResults = DEFAULT_MAX_RESULTS } = query;
  if (keywords.length === 0) return [];

  const config = await loadConfig();
  const dataDir = options.dataDir ?? config.dataDir;

  const parsedQuery = {
    raw: keywords.join(" "),
    intent: "search_evidence",
    keywords,
    section: null,
    dateRange,
  };

  const adapterOptions = { dataDir, maxResults };

  switch (source) {
    case "commits":
      return searchCommits(parsedQuery, adapterOptions).catch(() => []);
    case "slack":
      return searchSlack(parsedQuery, adapterOptions).catch(() => []);
    case "sessions":
      return searchSessionMemory(parsedQuery, adapterOptions).catch(() => []);
    default:
      return [];
  }
}

// ─── Source plan building ─────────────────────────────────────────────────────

/**
 * @typedef {Object} SourcePlan
 * @property {boolean}   search       이 소스를 검색할지
 * @property {string[]}  keywords     검색에 사용할 키워드
 * @property {number}    maxResults   최대 결과 수
 * @property {string}    [priority]   우선순위 ('high'|'medium'|'low')
 * @property {string}    [skipReason] 건너뛰는 이유
 * @property {{ from: string|null, to: string|null }|null} dateRange
 */

/**
 * 분석 결과에서 소스별 탐색 계획을 수립한다.
 *
 * @param {"commits"|"slack"|"sessions"} source
 * @param {object} analysis
 * @param {number} confidence
 * @returns {SourcePlan}
 */
function _buildSourcePlan(source, analysis, confidence) {
  const params = analysis.sourceParams?.[source];
  if (!params) {
    return {
      search: false,
      keywords: [],
      maxResults: 0,
      skipReason: "sourceParams 없음",
      dateRange: null,
    };
  }

  const keywords = params.keywords ?? [];
  const dateRange = params.dateRange ?? analysis.dateRange ?? null;

  // AnalyzedQuery 형식: enabled 필드로 판단
  if ("enabled" in params) {
    if (!params.enabled) {
      return {
        search: false,
        keywords,
        maxResults: 0,
        skipReason: "비활성화 (enabled=false)",
        dateRange,
      };
    }
    return {
      search: keywords.length > 0 || analysis.intent === "general",
      keywords,
      maxResults: params.maxResults ?? DEFAULT_MAX_RESULTS,
      dateRange,
    };
  }

  // QueryAnalysisResult 형식: priority 필드로 판단
  const priority = params.priority ?? "medium";
  const baseMax = params.maxResults ?? DEFAULT_MAX_RESULTS;

  // low priority + 낮은 confidence → 건너뜀
  if (priority === "low" && confidence < LOW_PRIORITY_SKIP_THRESHOLD) {
    return {
      search: false,
      keywords,
      maxResults: 0,
      priority,
      skipReason: `low priority + confidence ${confidence.toFixed(2)} < ${LOW_PRIORITY_SKIP_THRESHOLD}`,
      dateRange,
    };
  }

  // 키워드가 없으면 검색 불필요
  if (keywords.length === 0) {
    return {
      search: false,
      keywords,
      maxResults: 0,
      priority,
      skipReason: "키워드 없음",
      dateRange,
    };
  }

  const ratio = PRIORITY_RATIO[priority] ?? 0.6;
  const minResults = PRIORITY_MIN_RESULTS[priority] ?? 5;
  const adjustedMax = Math.max(minResults, Math.round(baseMax * ratio));

  return {
    search: true,
    keywords,
    maxResults: adjustedMax,
    priority,
    dateRange,
  };
}

// ─── Source search execution ──────────────────────────────────────────────────

/**
 * 소스 계획에 따라 단일 소스를 검색한다.
 *
 * @param {"commits"|"slack"|"sessions"} source
 * @param {SourcePlan} plan
 * @param {object} analysis
 * @param {string} dataDir
 * @returns {Promise<import('./resumeTypes.mjs').ChatEvidenceRecord[]>}
 */
async function _executeSourceSearch(source, plan, analysis, dataDir) {
  if (!plan.search) return [];

  const parsedQuery = {
    raw: analysis.raw ?? "",
    intent: analysis.intent ?? "search_evidence",
    keywords: plan.keywords,
    section: analysis.section ?? null,
    dateRange: plan.dateRange,
  };

  const adapterOptions = {
    dataDir,
    maxResults: plan.maxResults,
  };

  try {
    switch (source) {
      case "commits":
        return await searchCommits(parsedQuery, adapterOptions);
      case "slack":
        return await searchSlack(parsedQuery, adapterOptions);
      case "sessions":
        return await searchSessionMemory(parsedQuery, adapterOptions);
      default:
        return [];
    }
  } catch (err) {
    // 소스별 독립 실패 — 다른 소스에 영향 주지 않음
    console.warn(`[resumeChatExplore] ${source} search failed (non-fatal):`, err.message);
    return [];
  }
}

// ─── Result building helpers ──────────────────────────────────────────────────

/**
 * 소스 메타데이터를 구성한다.
 *
 * @param {SourcePlan} plan
 * @param {import('./resumeTypes.mjs').ChatEvidenceRecord[]} results
 * @returns {SourceMeta}
 */
function _buildSourceMeta(plan, results) {
  /** @type {SourceMeta} */
  const meta = {
    searched: plan.search,
    resultCount: results.length,
    keywords: plan.keywords,
  };

  if (plan.priority) meta.priority = plan.priority;
  if (plan.skipReason) meta.skipReason = plan.skipReason;

  return meta;
}

/**
 * 분석 결과에 키워드가 하나라도 있는지 확인한다.
 *
 * @param {object} analysis
 * @returns {boolean}
 */
function _hasAnyKeywords(analysis) {
  if (analysis.keywords?.length > 0) return true;
  const sp = analysis.sourceParams;
  if (!sp) return false;
  return (
    sp.commits?.keywords?.length > 0 ||
    sp.slack?.keywords?.length > 0 ||
    sp.sessions?.keywords?.length > 0
  );
}

/**
 * 빈 탐색 결과를 반환한다.
 *
 * @param {string|null} followUpQuestion
 * @returns {ExploreResult}
 */
function _emptyResult(followUpQuestion = null) {
  const emptyMeta = { searched: false, resultCount: 0, keywords: [] };
  return {
    commits: [],
    slack: [],
    sessions: [],
    totalCount: 0,
    sourceMeta: {
      commits: { ...emptyMeta },
      slack: { ...emptyMeta },
      sessions: { ...emptyMeta },
    },
    followUpQuestion,
  };
}
