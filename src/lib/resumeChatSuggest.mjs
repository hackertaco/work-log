/**
 * resumeChatSuggest.mjs
 *
 * 탐색된 결과를 종합·랭킹하여 어필 포인트(성과/기여/역할)로 변환하고
 * 제안 형태로 포맷팅하는 제안 생성 모듈.
 *
 * ─── 개요 ─────────────────────────────────────────────────────────────────────
 *
 *   resumeChatExplore.mjs 의 ExploreResult 를 입력으로 받아 3단계 파이프라인을
 *   실행한다:
 *
 *   1. clusterEvidence(exploreResult)
 *      → 소스별 결과를 주제(theme) 단위로 클러스터링
 *      → 키워드 오버랩 + 날짜 근접도 기반 규칙 클러스터링
 *
 *   2. rankClusters(clusters)
 *      → 클러스터별 어필 강도를 다면 점수로 산출
 *      → 점수: 근거 수 × 소스 다양성 × 최신성 × 구체성
 *
 *   3. generateAppealPoints(rankedClusters, resume, options)
 *      → LLM 호출로 상위 클러스터를 어필 포인트(성과/기여/역할)로 변환
 *      → 근거가 부족하면 보충 질문 반환 (허구 생성 방지)
 *
 * ─── 핵심 타입 ─────────────────────────────────────────────────────────────────
 *
 *   EvidenceCluster — {
 *     theme:       string,              // 클러스터 주제 키워드
 *     records:     ChatEvidenceRecord[],// 클러스터에 속한 근거 레코드
 *     sources:     Set<string>,         // 포함된 소스 종류
 *     dateRange:   { from: string, to: string },
 *     keywords:    string[],            // 대표 키워드
 *   }
 *
 *   AppealPoint — {
 *     type:          "achievement" | "contribution" | "role",
 *     title:         string,            // 한 줄 어필 포인트 제목
 *     description:   string,            // 이력서 불릿 수준의 상세 설명
 *     evidence:      EvidenceCitation[],// 근거 인용 목록
 *     targetSection: string,            // 제안 대상 섹션 (experience, projects 등)
 *     confidence:    number,            // 0.0–1.0 근거 기반 신뢰도
 *     company?:      string,            // 해당 회사/프로젝트 (있을 경우)
 *   }
 *
 *   EvidenceCitation — {
 *     source:  "commits" | "slack" | "sessions",
 *     date:    string,
 *     text:    string,
 *   }
 *
 *   SuggestionSet — {
 *     appealPoints:      AppealPoint[],      // 랭킹된 어필 포인트
 *     followUpQuestions:  string[],           // 보충 질문 (데이터 부족 시)
 *     clusterSummary:    ClusterSummary[],   // 클러스터 요약 (디버그/표시용)
 *     totalEvidence:     number,             // 총 근거 수
 *   }
 *
 * ─── 환경변수 ─────────────────────────────────────────────────────────────────
 *
 *   OPENAI_API_KEY           — 필수
 *   WORK_LOG_OPENAI_URL      — 기본: https://api.openai.com/v1/responses
 *   WORK_LOG_OPENAI_MODEL    — 기본: gpt-5.4-mini
 *   WORK_LOG_DISABLE_OPENAI  — "1" 설정 시 비활성화 (규칙 기반 폴백)
 */

import { randomUUID } from "node:crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/** 클러스터 내 키워드 오버랩 최소 비율 */
const CLUSTER_KEYWORD_OVERLAP_THRESHOLD = 0.3;

/** 클러스터 내 날짜 근접도 최대 일수 (같은 클러스터로 묶을 수 있는 기간) */
const CLUSTER_DATE_PROXIMITY_DAYS = 14;

/** LLM 에 전달할 최대 클러스터 수 */
const MAX_CLUSTERS_FOR_LLM = 8;

/** LLM 에 전달할 클러스터당 최대 근거 수 */
const MAX_EVIDENCE_PER_CLUSTER = 6;

/** 어필 포인트로 변환할 최소 근거 수 */
const MIN_EVIDENCE_FOR_APPEAL = 1;

/** LLM 최대 출력 토큰 */
const APPEAL_GENERATION_MAX_TOKENS = 3000;

// ─── Public types (JSDoc) ─────────────────────────────────────────────────────

/**
 * @typedef {Object} EvidenceCluster
 * @property {string}   id          고유 ID
 * @property {string}   theme       클러스터 주제
 * @property {object[]} records     근거 레코드 배열
 * @property {string[]} sources     포함된 소스 종류 목록
 * @property {{ from: string, to: string }} dateRange  날짜 범위
 * @property {string[]} keywords    대표 키워드
 * @property {number}   score       랭킹 점수 (0.0–1.0)
 */

/**
 * @typedef {Object} AppealPoint
 * @property {string}   id             고유 ID
 * @property {"achievement"|"contribution"|"role"} type  어필 유형
 * @property {string}   title          한 줄 제목
 * @property {string}   description    이력서 불릿 수준 설명
 * @property {EvidenceCitation[]} evidence  근거 인용
 * @property {string}   targetSection  대상 이력서 섹션
 * @property {number}   confidence     0.0–1.0 신뢰도
 * @property {string}   [company]      대상 회사/프로젝트
 */

/**
 * @typedef {Object} EvidenceCitation
 * @property {"commits"|"slack"|"sessions"} source
 * @property {string} date
 * @property {string} text
 */

/**
 * @typedef {Object} SuggestionSet
 * @property {AppealPoint[]}    appealPoints      랭킹된 어필 포인트
 * @property {string[]}         followUpQuestions  보충 질문
 * @property {ClusterSummary[]} clusterSummary    클러스터 요약
 * @property {number}           totalEvidence     총 근거 수
 */

/**
 * @typedef {Object} ClusterSummary
 * @property {string}   theme       주제
 * @property {number}   count       근거 수
 * @property {string[]} sources     소스 종류
 * @property {number}   score       랭킹 점수
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * ExploreResult 를 입력으로 받아 어필 포인트 제안 세트를 생성한다.
 *
 * 전체 파이프라인:
 *   1. 근거 클러스터링 (규칙 기반)
 *   2. 클러스터 랭킹 (다면 점수)
 *   3. 어필 포인트 생성 (LLM 또는 규칙 기반 폴백)
 *
 * @param {import('./resumeChatExplore.mjs').ExploreResult} exploreResult
 * @param {Object} [options]
 * @param {object}  [options.existingResume]   현재 이력서 (맥락용)
 * @param {boolean} [options.skipLLM=false]    LLM 건너뛰기 (규칙 기반만 사용)
 * @param {string}  [options.userIntent]       사용자 의도 (추가 맥락)
 * @returns {Promise<SuggestionSet>}
 */
export async function generateSuggestions(exploreResult, options = {}) {
  const { existingResume, skipLLM = false, userIntent } = options;

  if (!exploreResult || exploreResult.totalCount === 0) {
    return _emptySuggestionSet(
      exploreResult?.followUpQuestion
        ? [exploreResult.followUpQuestion]
        : ["탐색 결과가 없습니다. 검색 키워드나 기간을 변경해 보세요."]
    );
  }

  // ── Step 1: 근거 통합 + 클러스터링 ──────────────────────────────────────────
  const allRecords = mergeExploreResults(exploreResult);
  const clusters = clusterEvidence(allRecords);

  // ── Step 2: 클러스터 랭킹 ─────────────────────────────────────────────────
  const rankedClusters = rankClusters(clusters);

  // 유의미한 클러스터가 없으면 보충 질문
  if (rankedClusters.length === 0) {
    return _emptySuggestionSet([
      "관련 근거가 충분하지 않습니다. 어떤 프로젝트나 기술에 대해 더 구체적으로 알려주시겠어요?",
    ]);
  }

  // ── Step 3: 어필 포인트 생성 ──────────────────────────────────────────────
  const shouldUseLLM = !skipLLM &&
    process.env.OPENAI_API_KEY &&
    process.env.WORK_LOG_DISABLE_OPENAI !== "1";

  let appealPoints;
  const followUpQuestions = [];

  if (shouldUseLLM) {
    try {
      appealPoints = await generateAppealPointsWithLLM(
        rankedClusters,
        existingResume,
        userIntent
      );
    } catch (err) {
      console.warn("[resumeChatSuggest] LLM appeal generation failed, falling back to rules:", err.message);
      appealPoints = generateAppealPointsWithRules(rankedClusters);
    }
  } else {
    appealPoints = generateAppealPointsWithRules(rankedClusters);
  }

  // 근거가 빈약한 클러스터에 대해 보충 질문 생성
  for (const cluster of rankedClusters) {
    if (cluster.records.length < 2 && cluster.sources.length < 2) {
      followUpQuestions.push(
        `"${cluster.theme}" 관련 작업에 대해 더 구체적인 성과나 수치가 있나요?`
      );
    }
  }

  if (exploreResult.followUpQuestion) {
    followUpQuestions.push(exploreResult.followUpQuestion);
  }

  return {
    appealPoints,
    followUpQuestions: [...new Set(followUpQuestions)],
    clusterSummary: rankedClusters.map((c) => ({
      theme: c.theme,
      count: c.records.length,
      sources: c.sources,
      score: c.score,
    })),
    totalEvidence: allRecords.length,
  };
}

/**
 * ExploreResult 의 소스별 배열을 하나의 통합 레코드 배열로 병합한다.
 *
 * @param {import('./resumeChatExplore.mjs').ExploreResult} exploreResult
 * @returns {object[]}
 */
export function mergeExploreResults(exploreResult) {
  const records = [];

  for (const r of exploreResult.commits ?? []) {
    records.push({ ...r, _source: "commits" });
  }
  for (const r of exploreResult.slack ?? []) {
    records.push({ ...r, _source: "slack" });
  }
  for (const r of exploreResult.sessions ?? []) {
    records.push({ ...r, _source: "sessions" });
  }

  return records;
}

/**
 * 근거 레코드를 주제별로 클러스터링한다.
 *
 * 규칙 기반 클러스터링:
 *   - 키워드 오버랩이 CLUSTER_KEYWORD_OVERLAP_THRESHOLD 이상이면 같은 클러스터
 *   - 텍스트에서 추출한 유의미 단어의 Jaccard 유사도 기반
 *   - 날짜 근접도도 고려 (CLUSTER_DATE_PROXIMITY_DAYS 이내)
 *
 * @param {object[]} records  통합 근거 레코드
 * @returns {EvidenceCluster[]}
 */
export function clusterEvidence(records) {
  if (!records || records.length === 0) return [];

  const clusters = [];

  for (const record of records) {
    const text = record.text ?? "";
    const recordWords = _extractSignificantWords(text);
    const recordDate = record.date ?? "";
    const source = record._source ?? record.source ?? "unknown";

    let bestCluster = null;
    let bestOverlap = 0;

    // 기존 클러스터 중 가장 유사한 것을 찾는다
    for (const cluster of clusters) {
      const overlap = _wordSetOverlap(recordWords, cluster._wordSet);
      const dateProximity = _isDateProximate(recordDate, cluster.dateRange);

      // 키워드 오버랩이 임계값 이상이고 날짜가 근접하면 후보
      if (overlap >= CLUSTER_KEYWORD_OVERLAP_THRESHOLD && dateProximity) {
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestCluster = cluster;
        }
      }
    }

    if (bestCluster) {
      // 기존 클러스터에 추가
      bestCluster.records.push(record);
      if (!bestCluster.sources.includes(source)) {
        bestCluster.sources.push(source);
      }
      // 날짜 범위 확장
      if (recordDate && recordDate < bestCluster.dateRange.from) {
        bestCluster.dateRange.from = recordDate;
      }
      if (recordDate && recordDate > bestCluster.dateRange.to) {
        bestCluster.dateRange.to = recordDate;
      }
      // 단어셋 확장
      for (const w of recordWords) {
        bestCluster._wordSet.add(w);
      }
    } else {
      // 새 클러스터 생성
      clusters.push({
        id: randomUUID(),
        theme: _extractTheme(text),
        records: [record],
        sources: [source],
        dateRange: {
          from: recordDate || "9999-12-31",
          to: recordDate || "0000-01-01",
        },
        keywords: [...recordWords].slice(0, 5),
        _wordSet: recordWords,
        score: 0,
      });
    }
  }

  // 키워드 최종 정리 (내부 _wordSet 제거)
  for (const cluster of clusters) {
    cluster.keywords = [...cluster._wordSet].slice(0, 8);
    cluster.theme = _refineTheme(cluster);
    delete cluster._wordSet;
  }

  return clusters;
}

/**
 * 클러스터를 다면 점수로 랭킹한다.
 *
 * 점수 구성 (각 0.0–1.0, 가중 합):
 *   - evidenceCount (30%): 근거 레코드 수 (log scale, cap 10)
 *   - sourceDiversity (25%): 포함된 소스 종류 수 / 3
 *   - recency (25%): 최근 날짜까지의 거리 (90일 기준 감쇠)
 *   - specificity (20%): 평균 텍스트 길이 기반 구체성 (50자 이상 = 1.0)
 *
 * @param {EvidenceCluster[]} clusters
 * @returns {EvidenceCluster[]}  score 가 채워진 클러스터 (내림차순 정렬)
 */
export function rankClusters(clusters) {
  if (!clusters || clusters.length === 0) return [];

  const today = new Date().toISOString().slice(0, 10);

  for (const cluster of clusters) {
    // 근거 수 점수 (log scale, cap at 10)
    const evidenceScore = Math.min(1.0, Math.log2(cluster.records.length + 1) / Math.log2(11));

    // 소스 다양성 점수
    const diversityScore = Math.min(1.0, cluster.sources.length / 3);

    // 최신성 점수 (90일 기준 선형 감쇠)
    const latestDate = cluster.dateRange.to || "0000-01-01";
    const daysSinceLast = _daysBetween(latestDate, today);
    const recencyScore = Math.max(0, 1.0 - daysSinceLast / 90);

    // 구체성 점수 (평균 텍스트 길이)
    const avgTextLen = cluster.records.reduce(
      (sum, r) => sum + (r.text?.length ?? 0), 0
    ) / Math.max(1, cluster.records.length);
    const specificityScore = Math.min(1.0, avgTextLen / 50);

    cluster.score = (
      evidenceScore * 0.30 +
      diversityScore * 0.25 +
      recencyScore * 0.25 +
      specificityScore * 0.20
    );
  }

  // 점수 내림차순 정렬
  clusters.sort((a, b) => b.score - a.score);

  // 최소 근거 수 미만 클러스터 제거
  return clusters.filter((c) => c.records.length >= MIN_EVIDENCE_FOR_APPEAL);
}

/**
 * LLM 을 사용하여 랭킹된 클러스터를 어필 포인트로 변환한다.
 *
 * 근거 기반으로만 생성하며, 근거가 부족한 경우 해당 클러스터는 건너뛴다.
 *
 * @param {EvidenceCluster[]} rankedClusters  랭킹된 클러스터 (상위 MAX_CLUSTERS_FOR_LLM 개 사용)
 * @param {object} [existingResume]           현재 이력서 (맥락용)
 * @param {string} [userIntent]               사용자 의도
 * @returns {Promise<AppealPoint[]>}
 */
export async function generateAppealPointsWithLLM(rankedClusters, existingResume, userIntent) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const topClusters = rankedClusters.slice(0, MAX_CLUSTERS_FOR_LLM);
  const clustersPayload = topClusters.map((c) => ({
    theme: c.theme,
    keywords: c.keywords,
    dateRange: c.dateRange,
    sources: c.sources,
    score: Math.round(c.score * 100) / 100,
    evidence: c.records.slice(0, MAX_EVIDENCE_PER_CLUSTER).map((r) => ({
      source: r._source ?? r.source ?? "unknown",
      date: r.date ?? "",
      text: (r.text ?? "").slice(0, 200),
    })),
  }));

  // 기존 이력서에서 회사/프로젝트 목록 추출
  const resumeContext = _extractResumeContext(existingResume);

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "medium" },
    text: {
      format: {
        type: "json_schema",
        name: "appeal_points",
        strict: true,
        schema: _appealPointsSchema(),
      },
    },
    max_output_tokens: APPEAL_GENERATION_MAX_TOKENS,
    input: [
      {
        role: "system",
        content: _buildSystemPrompt(resumeContext),
      },
      {
        role: "user",
        content: _buildUserPrompt(clustersPayload, userIntent),
      },
    ],
  };

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
      `Appeal generation LLM call failed: ${response.status} ${errorText.slice(0, 400)}`
    );
  }

  const data = await response.json();
  const rawText = data.output_text || _extractOutputText(data);
  if (!rawText) {
    throw new Error("Appeal generation LLM call returned empty output");
  }

  const parsed = JSON.parse(rawText);
  return _normalizeAppealPoints(parsed, topClusters);
}

/**
 * 규칙 기반으로 랭킹된 클러스터를 어필 포인트로 변환한다.
 *
 * LLM 없이 규칙 기반으로 제목, 유형, 설명을 생성한다.
 * LLM 폴백 또는 WORK_LOG_DISABLE_OPENAI 설정 시 사용.
 *
 * @param {EvidenceCluster[]} rankedClusters
 * @returns {AppealPoint[]}
 */
export function generateAppealPointsWithRules(rankedClusters) {
  return rankedClusters.slice(0, MAX_CLUSTERS_FOR_LLM).map((cluster) => {
    const type = _inferAppealType(cluster);
    const title = _generateTitle(cluster);
    const description = _generateDescription(cluster);
    const evidence = cluster.records.slice(0, MAX_EVIDENCE_PER_CLUSTER).map((r) => ({
      source: r._source ?? r.source ?? "unknown",
      date: r.date ?? "",
      text: (r.text ?? "").slice(0, 200),
    }));
    const targetSection = _inferTargetSection(cluster);
    const company = _inferCompany(cluster);

    return {
      id: randomUUID(),
      type,
      title,
      description,
      evidence,
      targetSection,
      confidence: Math.round(cluster.score * 100) / 100,
      ...(company ? { company } : {}),
    };
  });
}

/**
 * 제안 세트를 사용자 표시용 메시지로 포맷팅한다.
 *
 * @param {SuggestionSet} suggestionSet
 * @returns {string}
 */
export function formatSuggestionMessage(suggestionSet) {
  if (!suggestionSet || suggestionSet.appealPoints.length === 0) {
    const questions = suggestionSet?.followUpQuestions ?? [];
    return questions.length > 0
      ? `제안할 어필 포인트를 찾지 못했습니다.\n\n${questions.map((q) => `💡 ${q}`).join("\n")}`
      : "제안할 어필 포인트를 찾지 못했습니다.";
  }

  const { appealPoints, followUpQuestions, totalEvidence } = suggestionSet;

  const TYPE_LABELS = {
    achievement: "🏆 성과",
    contribution: "🤝 기여",
    role: "👤 역할",
  };

  const lines = [
    `📋 **${appealPoints.length}개 어필 포인트** (근거 ${totalEvidence}건 기반)\n`,
  ];

  for (let i = 0; i < appealPoints.length; i++) {
    const ap = appealPoints[i];
    const typeLabel = TYPE_LABELS[ap.type] || ap.type;
    const confidenceBar = _confidenceBar(ap.confidence);

    lines.push(`### ${i + 1}. ${typeLabel}: ${ap.title}`);
    lines.push(`${ap.description}`);
    lines.push(`신뢰도: ${confidenceBar} | 대상: ${ap.targetSection}${ap.company ? ` (${ap.company})` : ""}`);

    if (ap.evidence.length > 0) {
      lines.push(`근거:`);
      for (const e of ap.evidence.slice(0, 3)) {
        lines.push(`  - [${e.source}/${e.date}] ${e.text.slice(0, 100)}`);
      }
    }
    lines.push("");
  }

  if (followUpQuestions.length > 0) {
    lines.push("---");
    lines.push("💡 **보충 질문:**");
    for (const q of followUpQuestions) {
      lines.push(`  - ${q}`);
    }
  }

  return lines.join("\n");
}

// ─── Internal: Clustering helpers ─────────────────────────────────────────────

/**
 * 텍스트에서 유의미 단어를 추출한다 (길이 2 이상, 한글/영문 지원).
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function _extractSignificantWords(text) {
  if (!text) return new Set();

  // 한글 단어 (2자 이상) + 영문 단어 (3자 이상)
  const words = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => {
      if (!w) return false;
      // 한글은 2자 이상, 영문은 3자 이상
      const isKorean = /[\uAC00-\uD7AF]/.test(w);
      return isKorean ? w.length >= 2 : w.length >= 3;
    });

  return new Set(words);
}

/**
 * 두 단어 집합의 Jaccard 유사도를 계산한다.
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} 0.0–1.0
 */
export function _wordSetOverlap(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }

  // Jaccard: intersection / union
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 날짜가 클러스터의 날짜 범위와 근접한지 확인한다.
 *
 * @param {string} date  YYYY-MM-DD
 * @param {{ from: string, to: string }} dateRange
 * @returns {boolean}
 */
function _isDateProximate(date, dateRange) {
  if (!date || date === "unknown") return true; // 날짜 정보 없으면 허용

  const daysFromRange = Math.min(
    Math.abs(_daysBetween(date, dateRange.from)),
    Math.abs(_daysBetween(date, dateRange.to))
  );

  return daysFromRange <= CLUSTER_DATE_PROXIMITY_DAYS;
}

/**
 * 텍스트에서 주제를 추출한다 (규칙 기반).
 *
 * @param {string} text
 * @returns {string}
 */
function _extractTheme(text) {
  if (!text) return "기타";

  // 리포지토리 이름 패턴 ([repo] ...)
  const repoMatch = text.match(/\[([^\]]+)\]/);
  if (repoMatch) return repoMatch[1];

  // 첫 번째 유의미 구문 (콜론이나 하이픈 앞)
  const prefixMatch = text.match(/^([^:—\-–]+)[:—\-–]/);
  if (prefixMatch) return prefixMatch[1].trim().slice(0, 30);

  // 첫 단어 조합
  const words = text.split(/\s+/).filter(Boolean).slice(0, 3);
  return words.join(" ").slice(0, 30) || "기타";
}

/**
 * 클러스터 내 모든 레코드를 참고하여 주제를 정제한다.
 *
 * @param {EvidenceCluster} cluster
 * @returns {string}
 */
function _refineTheme(cluster) {
  // 리포지토리 이름이 공통이면 리포지토리 이름 사용
  const repos = new Set();
  for (const r of cluster.records) {
    const repo = r.repo ?? r.provenance?.repo;
    if (repo) repos.add(repo);
  }
  if (repos.size === 1) {
    return [...repos][0];
  }

  // 가장 빈도 높은 키워드 3개로 주제 구성
  const wordFreq = new Map();
  for (const r of cluster.records) {
    for (const w of _extractSignificantWords(r.text ?? "")) {
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }
  }

  const topWords = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);

  return topWords.length > 0 ? topWords.join(" / ") : cluster.theme;
}

// ─── Internal: Ranking helpers ────────────────────────────────────────────────

/**
 * 두 날짜 사이의 일수를 계산한다.
 *
 * @param {string} dateA  YYYY-MM-DD
 * @param {string} dateB  YYYY-MM-DD
 * @returns {number}
 */
function _daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return 999;
  try {
    const a = new Date(dateA);
    const b = new Date(dateB);
    return Math.round(Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return 999;
  }
}

// ─── Internal: Appeal point generation (rules) ───────────────────────────────

/**
 * 클러스터에서 어필 유형을 추론한다.
 *
 * @param {EvidenceCluster} cluster
 * @returns {"achievement"|"contribution"|"role"}
 */
function _inferAppealType(cluster) {
  const allText = cluster.records.map((r) => r.text ?? "").join(" ").toLowerCase();

  // 성과 키워드
  if (/개선|향상|최적화|성능|감소|증가|성과|달성|완료|배포|출시|런칭/.test(allText)) {
    return "achievement";
  }

  // 역할 키워드
  if (/리드|설계|아키텍처|주도|멘토|코드 리뷰|의사결정|방향/.test(allText)) {
    return "role";
  }

  // 기본: 기여
  return "contribution";
}

/**
 * 클러스터에서 어필 포인트 제목을 생성한다 (규칙 기반).
 *
 * @param {EvidenceCluster} cluster
 * @returns {string}
 */
function _generateTitle(cluster) {
  // 가장 높은 점수의 근거 텍스트를 제목으로 사용
  const bestRecord = cluster.records.reduce(
    (best, r) => ((r.relevanceScore ?? r.score ?? 0) > (best.relevanceScore ?? best.score ?? 0) ? r : best),
    cluster.records[0]
  );

  const text = bestRecord?.text ?? cluster.theme;

  // 콜론/하이픈 이전의 접두사 + 핵심 내용
  const cleaned = text
    .replace(/\[([^\]]*)\]\s*/, "") // [repo] 제거
    .replace(/^(feat|fix|chore|refactor|docs|style|test|ci)[\s(:]+/i, "") // 커밋 접두어 제거
    .trim();

  return cleaned.length > 80 ? cleaned.slice(0, 77) + "…" : cleaned;
}

/**
 * 클러스터에서 이력서 불릿 수준의 설명을 생성한다 (규칙 기반).
 *
 * @param {EvidenceCluster} cluster
 * @returns {string}
 */
function _generateDescription(cluster) {
  const parts = [];

  // 날짜 범위
  if (cluster.dateRange.from && cluster.dateRange.to && cluster.dateRange.from !== "9999-12-31") {
    if (cluster.dateRange.from === cluster.dateRange.to) {
      parts.push(`${cluster.dateRange.from}:`);
    } else {
      parts.push(`${cluster.dateRange.from} ~ ${cluster.dateRange.to}:`);
    }
  }

  // 상위 2개 근거 텍스트를 조합
  const topTexts = cluster.records
    .slice(0, 2)
    .map((r) => {
      const text = (r.text ?? "").replace(/\[([^\]]*)\]\s*/, "").trim();
      return text.length > 100 ? text.slice(0, 97) + "…" : text;
    })
    .filter(Boolean);

  parts.push(topTexts.join("; "));

  // 추가 근거 수
  if (cluster.records.length > 2) {
    parts.push(`(외 ${cluster.records.length - 2}건)`);
  }

  return parts.join(" ");
}

/**
 * 클러스터에서 대상 이력서 섹션을 추론한다.
 *
 * @param {EvidenceCluster} cluster
 * @returns {string}
 */
function _inferTargetSection(cluster) {
  const allText = cluster.records.map((r) => r.text ?? "").join(" ").toLowerCase();

  if (/스킬|기술|언어|프레임워크|라이브러리|tool/.test(allText)) return "skills";
  if (/프로젝트|사이드|오픈소스|개인/.test(allText)) return "projects";

  return "experience";
}

/**
 * 클러스터에서 관련 회사/프로젝트 이름을 추론한다.
 *
 * @param {EvidenceCluster} cluster
 * @returns {string|null}
 */
function _inferCompany(cluster) {
  // 리포지토리 이름에서 추론
  const repos = new Set();
  for (const r of cluster.records) {
    const repo = r.repo ?? r.provenance?.repo;
    if (repo) repos.add(repo);
  }

  return repos.size === 1 ? [...repos][0] : null;
}

// ─── Internal: LLM prompt building ───────────────────────────────────────────

/**
 * 시스템 프롬프트를 생성한다.
 *
 * @param {string} resumeContext
 * @returns {string}
 */
function _buildSystemPrompt(resumeContext) {
  return `당신은 이력서 어필 포인트 전문가입니다.

주어진 근거 클러스터를 분석하여 이력서에 넣을 수 있는 어필 포인트(성과/기여/역할)로 변환합니다.

규칙:
1. 반드시 제공된 근거만 사용하세요. 근거에 없는 내용을 만들어내지 마세요.
2. 각 어필 포인트는 구체적인 수치나 기술명을 포함해야 합니다.
3. "~했음" 보다 "~하여 ~를 달성/개선/구축" 형태의 성과 중심 문장을 작성하세요.
4. 어필 유형을 정확히 분류하세요:
   - achievement: 측정 가능한 성과 (성능 개선, 비용 절감, 사용자 증가 등)
   - contribution: 팀/프로젝트에 대한 기여 (코드 리뷰, 문서화, 프로세스 개선 등)
   - role: 역할/리더십 (설계 주도, 기술 방향 설정, 멘토링 등)
5. targetSection은 experience, projects, skills, summary 중 하나입니다.
6. confidence는 근거의 충분성에 따라 0.0~1.0 사이로 설정하세요:
   - 1.0: 구체적 수치와 다수의 근거가 있음
   - 0.7: 근거가 있지만 수치가 부족
   - 0.4: 근거가 적고 추론이 필요함

${resumeContext ? `현재 이력서 맥락:\n${resumeContext}` : ""}`;
}

/**
 * 사용자 프롬프트를 생성한다.
 *
 * @param {object[]} clustersPayload
 * @param {string} [userIntent]
 * @returns {string}
 */
function _buildUserPrompt(clustersPayload, userIntent) {
  let prompt = "다음 근거 클러스터를 어필 포인트로 변환해주세요:\n\n";

  for (let i = 0; i < clustersPayload.length; i++) {
    const c = clustersPayload[i];
    prompt += `## 클러스터 ${i + 1}: ${c.theme}\n`;
    prompt += `키워드: ${c.keywords.join(", ")}\n`;
    prompt += `기간: ${c.dateRange.from} ~ ${c.dateRange.to}\n`;
    prompt += `소스: ${c.sources.join(", ")} (점수: ${c.score})\n`;
    prompt += `근거:\n`;
    for (const e of c.evidence) {
      prompt += `  - [${e.source}/${e.date}] ${e.text}\n`;
    }
    prompt += "\n";
  }

  if (userIntent) {
    prompt += `\n사용자 의도: ${userIntent}\n`;
  }

  return prompt;
}

/**
 * LLM 응답 스키마를 반환한다.
 */
function _appealPointsSchema() {
  return {
    type: "object",
    properties: {
      appealPoints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["achievement", "contribution", "role"] },
            title: { type: "string" },
            description: { type: "string" },
            targetSection: { type: "string", enum: ["experience", "projects", "skills", "summary"] },
            confidence: { type: "number" },
            company: { type: "string" },
            clusterIndex: { type: "number" },
          },
          required: ["type", "title", "description", "targetSection", "confidence", "company", "clusterIndex"],
          additionalProperties: false,
        },
      },
    },
    required: ["appealPoints"],
    additionalProperties: false,
  };
}

/**
 * 이력서에서 LLM 맥락용 정보를 추출한다.
 *
 * @param {object} [resume]
 * @returns {string}
 */
function _extractResumeContext(resume) {
  if (!resume) return "";

  const parts = [];

  // 회사 목록
  const companies = (resume.experience ?? [])
    .map((e) => `${e.company} (${e.title})`)
    .filter(Boolean);
  if (companies.length > 0) {
    parts.push(`경력: ${companies.join(", ")}`);
  }

  // 프로젝트 목록
  const projects = (resume.projects ?? [])
    .map((p) => p.name)
    .filter(Boolean);
  if (projects.length > 0) {
    parts.push(`프로젝트: ${projects.join(", ")}`);
  }

  // 기술 스택
  const skills = resume.skills?.technical ?? [];
  if (skills.length > 0) {
    parts.push(`기술: ${skills.slice(0, 10).join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * LLM 응답에서 output_text 를 추출한다 (fallback).
 *
 * @param {object} data
 * @returns {string|null}
 */
function _extractOutputText(data) {
  if (!data?.output) return null;
  for (const block of data.output) {
    if (block.content) {
      for (const item of block.content) {
        if (item.type === "output_text" || item.type === "text") {
          return item.text;
        }
      }
    }
  }
  return null;
}

/**
 * LLM 응답을 정규화된 AppealPoint 배열로 변환한다.
 *
 * @param {object} parsed  LLM 파싱 결과
 * @param {EvidenceCluster[]} clusters  원본 클러스터 (근거 추출용)
 * @returns {AppealPoint[]}
 */
function _normalizeAppealPoints(parsed, clusters) {
  const raw = parsed?.appealPoints ?? [];

  return raw.map((ap) => {
    const clusterIdx = ap.clusterIndex ?? 0;
    const cluster = clusters[clusterIdx];

    // 클러스터에서 근거 인용 추출
    const evidence = cluster
      ? cluster.records.slice(0, MAX_EVIDENCE_PER_CLUSTER).map((r) => ({
          source: r._source ?? r.source ?? "unknown",
          date: r.date ?? "",
          text: (r.text ?? "").slice(0, 200),
        }))
      : [];

    return {
      id: randomUUID(),
      type: ap.type || "contribution",
      title: ap.title || "",
      description: ap.description || "",
      evidence,
      targetSection: ap.targetSection || "experience",
      confidence: Math.max(0, Math.min(1, ap.confidence ?? 0.5)),
      ...(ap.company ? { company: ap.company } : {}),
    };
  });
}

// ─── Internal: Formatting helpers ─────────────────────────────────────────────

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

/**
 * 빈 제안 세트를 반환한다.
 *
 * @param {string[]} followUpQuestions
 * @returns {SuggestionSet}
 */
function _emptySuggestionSet(followUpQuestions = []) {
  return {
    appealPoints: [],
    followUpQuestions,
    clusterSummary: [],
    totalEvidence: 0,
  };
}
