/**
 * resumeChatRecommendEngine.mjs
 *
 * 탐색된 데이터를 종합하여 이력서에 활용할 수 있는 어필 포인트(성과·기여·역량)를
 * 생성하고 근거와 함께 제안하는 통합 추천 엔진.
 *
 * ─── 개요 ─────────────────────────────────────────────────────────────────────
 *
 *   두 가지 어필 포인트 생성 전략을 통합한다:
 *
 *   1. Flat Ranking (resumeAppealPoints.mjs)
 *      → 소스별 가중치 + 최신성으로 전체 근거를 단일 리스트로 병합·랭킹
 *      → LLM 에 근거 컨텍스트를 주입해 개별 어필 포인트 생성
 *      → 빠르고 단순; 소수 근거에서도 잘 동작
 *
 *   2. Cluster-Based Suggestions (resumeChatSuggest.mjs)
 *      → 키워드 오버랩 + 날짜 근접도로 근거를 주제별 클러스터링
 *      → 클러스터별 다면 점수(근거 수 × 소스 다양성 × 최신성 × 구체성) 산출
 *      → 상위 클러스터를 LLM 으로 어필 포인트로 변환
 *      → 근거가 풍부할 때 주제 중심의 구조화된 제안 가능
 *
 *   추천 엔진은 근거 수에 따라 적절한 전략을 자동 선택하고,
 *   결과를 정규화된 Recommendation[] 형태로 반환한다.
 *
 * ─── 파이프라인 ────────────────────────────────────────────────────────────────
 *
 *   1. ExploreResult 수신 (resumeChatExplore.mjs 출력)
 *   2. 전략 결정: 총 근거 ≤ CLUSTER_THRESHOLD → flat ranking / > → clustering
 *   3. 선택된 전략으로 어필 포인트 생성
 *   4. 결과를 Recommendation[] 로 정규화
 *   5. ChatCitation[] 생성 (resumeChatCitations.mjs)
 *   6. 데이터 갭 분석 + 보충 질문 병합
 *
 * ─── 핵심 타입 ────────────────────────────────────────────────────────────────
 *
 *   Recommendation — {
 *     id:            string,
 *     title:         string,           // 2–8 단어 요약
 *     description:   string,           // 이력서 불릿 수준 상세
 *     category:      'achievement' | 'contribution' | 'capability',
 *     section:       string,           // 대상 이력서 섹션
 *     confidence:    number,           // 0.0–1.0
 *     evidence:      EvidenceCitation[],
 *     sourceRefs:    SourceRef[],
 *     company?:      string,
 *   }
 *
 *   RecommendResult — {
 *     recommendations:   Recommendation[],
 *     citations:         ChatCitation[],
 *     sourceSummary:     CitationSourceSummary,
 *     dataGaps:          string[],
 *     followUpQuestions: string[],
 *     strategy:          'flat' | 'cluster',
 *     totalEvidence:     number,
 *   }
 *
 * ─── 사용 예시 ────────────────────────────────────────────────────────────────
 *
 *   import { generateRecommendations } from './resumeChatRecommendEngine.mjs';
 *   import { exploreWithQueryAnalysis } from './resumeChatExplore.mjs';
 *
 *   const exploreResult = await exploreWithQueryAnalysis(analysis);
 *   const result = await generateRecommendations(query, exploreResult, {
 *     existingResume,
 *     lang: 'ko',
 *   });
 *   // → { recommendations: [...], citations: [...], ... }
 */

import {
  mergeAndRankEvidence,
  buildEvidenceContext,
  generateAppealPoints,
  inferCategory,
} from "./resumeAppealPoints.mjs";

import {
  generateSuggestions,
  clusterEvidence,
  rankClusters,
  mergeExploreResults,
} from "./resumeChatSuggest.mjs";

import {
  buildChatCitations,
  buildSourceSummary,
} from "./resumeChatCitations.mjs";

// ─── 상수 ────────────────────────────────────────────────────────────────────

/**
 * 총 근거 수가 이 임계값 이하이면 flat ranking 전략,
 * 초과하면 cluster-based 전략을 사용한다.
 */
const CLUSTER_THRESHOLD = 5;

/** flat ranking 에서 상위 N 건만 사용 */
const FLAT_TOP_N = 15;

/** 최대 추천 어필 포인트 수 */
const MAX_RECOMMENDATIONS = 8;

/** 카테고리 매핑: resumeChatSuggest 의 type → 표준 category */
const SUGGEST_TYPE_TO_CATEGORY = {
  achievement: "achievement",
  contribution: "contribution",
  role: "capability",
};

// ─── 공개 타입 (JSDoc) ──────────────────────────────────────────────────────

/**
 * @typedef {Object} EvidenceCitation
 * @property {"commits"|"slack"|"sessions"} source
 * @property {string} date
 * @property {string} text
 */

/**
 * 정규화된 추천 어필 포인트
 *
 * @typedef {Object} Recommendation
 * @property {string}   id            고유 ID
 * @property {string}   title         짧은 제목 (2–8 단어)
 * @property {string}   description   이력서 불릿 수준 설명
 * @property {'achievement'|'contribution'|'capability'} category
 * @property {string}   section       대상 이력서 섹션 (experience, skills, summary, projects)
 * @property {number}   confidence    0.0–1.0
 * @property {EvidenceCitation[]} evidence  근거 인용 목록
 * @property {import('./resumeTypes.mjs').SourceRef[]} sourceRefs  출처 참조
 * @property {string}   [company]     대상 회사/프로젝트
 */

/**
 * 추천 엔진 결과
 *
 * @typedef {Object} RecommendResult
 * @property {Recommendation[]}   recommendations   정규화된 어필 포인트 목록
 * @property {import('./resumeChatCitations.mjs').ChatCitation[]} citations
 *   프론트엔드 렌더링용 정규화된 인용 목록
 * @property {import('./resumeChatCitations.mjs').CitationSourceSummary} sourceSummary
 *   소스별 건수 요약
 * @property {string[]}           dataGaps           데이터 부족 영역
 * @property {string[]}           followUpQuestions   보충 질문
 * @property {'flat'|'cluster'}   strategy           사용된 전략
 * @property {number}             totalEvidence      총 근거 수
 */

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 탐색 결과에서 이력서 어필 포인트 추천을 생성한다.
 *
 * 근거 수에 따라 flat ranking 또는 cluster-based 전략을 자동 선택하고,
 * 결과를 정규화된 RecommendResult 로 반환한다.
 *
 * @param {string} query  사용자 원본 질의
 * @param {import('./resumeChatExplore.mjs').ExploreResult} exploreResult
 *   exploreWithQueryAnalysis() 또는 exploreWithKeywords() 출력
 * @param {{
 *   existingResume?: object,
 *   lang?: 'ko' | 'en',
 *   maxPoints?: number,
 *   forceStrategy?: 'flat' | 'cluster',
 * }} [options]
 * @returns {Promise<RecommendResult>}
 */
export async function generateRecommendations(query, exploreResult, options = {}) {
  const {
    existingResume,
    lang = "ko",
    maxPoints = MAX_RECOMMENDATIONS,
    forceStrategy,
  } = options;

  // ── 빈 결과 처리 ──────────────────────────────────────────────────────────
  if (!exploreResult || exploreResult.totalCount === 0) {
    return _emptyResult(
      exploreResult?.followUpQuestion
        ? [exploreResult.followUpQuestion]
        : ["탐색 결과가 없습니다. 검색 키워드나 기간을 변경해 보세요."]
    );
  }

  // ── 전략 선택 ──────────────────────────────────────────────────────────────
  const totalEvidence = exploreResult.totalCount;
  const strategy = forceStrategy ?? (totalEvidence <= CLUSTER_THRESHOLD ? "flat" : "cluster");

  let recommendations;
  let rankedEvidence = [];
  let dataGaps = [];
  let followUpQuestions = [];

  try {
    if (strategy === "cluster") {
      const result = await _executeClusterStrategy(
        query, exploreResult, existingResume, maxPoints
      );
      recommendations = result.recommendations;
      rankedEvidence = result.rankedEvidence;
      dataGaps = result.dataGaps;
      followUpQuestions = result.followUpQuestions;
    } else {
      const result = await _executeFlatStrategy(
        query, exploreResult, existingResume, lang, maxPoints
      );
      recommendations = result.recommendations;
      rankedEvidence = result.rankedEvidence;
      dataGaps = result.dataGaps;
      followUpQuestions = result.followUpQuestions;
    }
  } catch (err) {
    // 전략 실패 시 빈 결과 + 에러 메시지
    console.warn(`[resumeChatRecommendEngine] ${strategy} strategy failed:`, err.message);
    return _emptyResult([
      `추천 생성 중 오류가 발생했습니다: ${err.message}`,
      "다시 시도하거나 다른 키워드로 검색해 보세요.",
    ]);
  }

  // ── 탐색 결과의 followUpQuestion 병합 ─────────────────────────────────────
  if (exploreResult.followUpQuestion) {
    followUpQuestions = _dedupStrings([
      ...followUpQuestions,
      exploreResult.followUpQuestion,
    ]);
  }

  // ── 인용 및 요약 생성 ─────────────────────────────────────────────────────
  const appealPointsResult = recommendations.length > 0
    ? { appealPoints: recommendations }
    : null;
  const citations = buildChatCitations(rankedEvidence, appealPointsResult);
  const sourceSummary = buildSourceSummary(citations);

  return {
    recommendations,
    citations,
    sourceSummary,
    dataGaps,
    followUpQuestions,
    strategy,
    totalEvidence,
  };
}

/**
 * 전략 선택 로직만 분리한 유틸리티.
 * 근거 수에 따라 어떤 전략이 선택되는지 외부에서 확인할 수 있다.
 *
 * @param {number} totalEvidence
 * @returns {'flat' | 'cluster'}
 */
export function selectStrategy(totalEvidence) {
  return totalEvidence <= CLUSTER_THRESHOLD ? "flat" : "cluster";
}

/**
 * 추천 결과를 사용자 표시용 Markdown 메시지로 포맷팅한다.
 *
 * @param {RecommendResult} result
 * @returns {string}
 */
export function formatRecommendations(result) {
  if (!result || result.recommendations.length === 0) {
    const questions = result?.followUpQuestions ?? [];
    if (questions.length > 0) {
      return `추천할 어필 포인트를 찾지 못했습니다.\n\n${questions.map((q) => `💡 ${q}`).join("\n")}`;
    }
    return "추천할 어필 포인트를 찾지 못했습니다.";
  }

  const { recommendations, followUpQuestions, totalEvidence, strategy } = result;

  const CATEGORY_LABELS = {
    achievement: "🏆 성과",
    contribution: "🤝 기여",
    capability: "💡 역량",
  };

  const lines = [
    `📋 **${recommendations.length}개 어필 포인트 추천** (근거 ${totalEvidence}건 분석)\n`,
  ];

  for (let i = 0; i < recommendations.length; i++) {
    const rec = recommendations[i];
    const catLabel = CATEGORY_LABELS[rec.category] || rec.category;
    const confidenceBar = _confidenceBar(rec.confidence);

    lines.push(`### ${i + 1}. ${catLabel}: ${rec.title}`);
    lines.push(rec.description);
    lines.push(
      `신뢰도: ${confidenceBar} | 대상: ${rec.section}${rec.company ? ` (${rec.company})` : ""}`
    );

    if (rec.evidence.length > 0) {
      lines.push("근거:");
      for (const e of rec.evidence.slice(0, 3)) {
        lines.push(`  - [${e.source}/${e.date}] ${e.text.slice(0, 120)}`);
      }
    }
    lines.push("");
  }

  if (result.dataGaps.length > 0) {
    lines.push("---");
    lines.push("⚠️ **데이터 부족 영역:**");
    for (const gap of result.dataGaps) {
      lines.push(`  - ${gap}`);
    }
    lines.push("");
  }

  if (followUpQuestions.length > 0) {
    lines.push("---");
    lines.push("💬 **보충 질문:**");
    for (const q of followUpQuestions) {
      lines.push(`  - ${q}`);
    }
  }

  return lines.join("\n");
}

// ─── Flat ranking 전략 ──────────────────────────────────────────────────────

/**
 * @param {string} query
 * @param {object} exploreResult
 * @param {object|undefined} existingResume
 * @param {string} lang
 * @param {number} maxPoints
 * @returns {Promise<{ recommendations: Recommendation[], rankedEvidence: object[], dataGaps: string[], followUpQuestions: string[] }>}
 */
async function _executeFlatStrategy(query, exploreResult, existingResume, lang, maxPoints) {
  // 1. 병합·랭킹
  const rankedEvidence = mergeAndRankEvidence(exploreResult, { topN: FLAT_TOP_N });

  // 2. 어필 포인트 생성
  const result = await generateAppealPoints(query, rankedEvidence, {
    existingResume,
    lang,
    maxPoints,
  });

  // 3. AppealPoint → Recommendation 변환
  const recommendations = (result.appealPoints ?? []).map((ap) => ({
    id: ap.id,
    title: ap.title,
    description: ap.description,
    category: ap.category ?? "achievement",
    section: ap.section ?? "experience",
    confidence: ap.confidence,
    evidence: (ap.evidenceTexts ?? []).map((text) => ({
      source: "commits",
      date: "",
      text,
    })),
    sourceRefs: ap.sourceRefs ?? [],
    ...(ap.company ? { company: ap.company } : {}),
  }));

  return {
    recommendations,
    rankedEvidence,
    dataGaps: result.dataGaps ?? [],
    followUpQuestions: result.followUpQuestions ?? [],
  };
}

// ─── Cluster-based 전략 ──────────────────────────────────────────────────────

/**
 * @param {string} query
 * @param {object} exploreResult
 * @param {object|undefined} existingResume
 * @param {number} maxPoints
 * @returns {Promise<{ recommendations: Recommendation[], rankedEvidence: object[], dataGaps: string[], followUpQuestions: string[] }>}
 */
async function _executeClusterStrategy(query, exploreResult, existingResume, maxPoints) {
  // 1. 클러스터 기반 제안 생성
  const suggestionSet = await generateSuggestions(exploreResult, {
    existingResume,
    userIntent: query,
  });

  // 2. 병렬로 flat ranking 도 실행 (citation 용)
  const rankedEvidence = mergeAndRankEvidence(exploreResult, { topN: FLAT_TOP_N });

  // 3. SuggestionSet → Recommendation[] 변환
  const recommendations = (suggestionSet.appealPoints ?? [])
    .slice(0, maxPoints)
    .map((ap, i) => _normalizeSuggestAppealPoint(ap, i));

  // 4. 보충 질문 수집
  const followUpQuestions = _dedupStrings(
    suggestionSet.followUpQuestions ?? []
  );

  // 5. 데이터 갭 분석
  const dataGaps = _analyzeDataGaps(
    recommendations,
    exploreResult,
    suggestionSet
  );

  return {
    recommendations,
    rankedEvidence,
    dataGaps,
    followUpQuestions,
  };
}

// ─── 정규화 함수 ─────────────────────────────────────────────────────────────

/**
 * resumeChatSuggest 의 AppealPoint 를 Recommendation 으로 변환한다.
 *
 * @param {import('./resumeChatSuggest.mjs').AppealPoint} ap
 * @param {number} index
 * @returns {Recommendation}
 */
function _normalizeSuggestAppealPoint(ap, index) {
  const category = SUGGEST_TYPE_TO_CATEGORY[ap.type] || inferCategory(
    ap.description || "",
    ap.title || ""
  );

  const evidence = (ap.evidence ?? []).map((e) => ({
    source: e.source || "commits",
    date: e.date || "",
    text: (e.text || "").slice(0, 200),
  }));

  // sourceRefs: evidence 에서 최소한의 출처 정보 구성
  const sourceRefs = evidence.map((e) => ({
    source: e.source,
    date: e.date,
    text: e.text,
    rank: 0,
    provenance: null,
  }));

  return {
    id: ap.id || `rec-${index}`,
    title: ap.title || "",
    description: ap.description || "",
    category,
    section: ap.targetSection || "experience",
    confidence: typeof ap.confidence === "number"
      ? Math.max(0, Math.min(1, ap.confidence))
      : 0.5,
    evidence,
    sourceRefs,
    ...(ap.company ? { company: ap.company } : {}),
  };
}

/**
 * 추천 결과와 탐색 결과에서 데이터 갭을 분석한다.
 *
 * @param {Recommendation[]} recommendations
 * @param {object} exploreResult
 * @param {object} suggestionSet
 * @returns {string[]}
 */
function _analyzeDataGaps(recommendations, exploreResult, suggestionSet) {
  const gaps = [];

  // 소스별 검색 결과가 0건인 소스 확인
  const meta = exploreResult.sourceMeta ?? {};
  if (meta.commits?.searched && meta.commits.resultCount === 0) {
    gaps.push("커밋 이력에서 관련 데이터를 찾지 못했습니다.");
  }
  if (meta.slack?.searched && meta.slack.resultCount === 0) {
    gaps.push("슬랙 메시지에서 관련 데이터를 찾지 못했습니다.");
  }
  if (meta.sessions?.searched && meta.sessions.resultCount === 0) {
    gaps.push("세션 메모리에서 관련 데이터를 찾지 못했습니다.");
  }

  // 신뢰도가 낮은 추천이 있으면 보충 필요 표시
  const lowConfidence = recommendations.filter((r) => r.confidence < 0.5);
  if (lowConfidence.length > 0) {
    gaps.push(
      `${lowConfidence.length}건의 어필 포인트가 근거 부족으로 신뢰도가 낮습니다. 추가 정보를 제공해 주세요.`
    );
  }

  return gaps;
}

// ─── 유틸리티 ─────────────────────────────────────────────────────────────────

/**
 * 빈 추천 결과를 반환한다.
 *
 * @param {string[]} followUpQuestions
 * @returns {RecommendResult}
 */
function _emptyResult(followUpQuestions = []) {
  return {
    recommendations: [],
    citations: [],
    sourceSummary: { commits: 0, slack: 0, sessions: 0, total: 0, repos: [], dateRange: [] },
    dataGaps: followUpQuestions.length > 0
      ? ["관련 근거 데이터가 부족합니다."]
      : [],
    followUpQuestions,
    strategy: "flat",
    totalEvidence: 0,
  };
}

/**
 * 문자열 배열을 중복 제거한다.
 *
 * @param {string[]} arr
 * @returns {string[]}
 */
function _dedupStrings(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/**
 * 신뢰도를 시각적 바로 표현한다.
 *
 * @param {number} confidence  0.0–1.0
 * @returns {string}
 */
function _confidenceBar(confidence) {
  const filled = Math.round(confidence * 5);
  return "█".repeat(filled) + "░".repeat(5 - filled) + ` ${Math.round(confidence * 100)}%`;
}
