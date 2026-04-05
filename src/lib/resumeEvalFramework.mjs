/**
 * Resume Evaluation Framework
 *
 * 채팅 기반 이력서 구체화 기능(Sub-AC 10)의 평가 기준을 정의하고,
 * 기존 자동 생성 이력서와 채팅 개선 이력서를 비교하는 프레임워크.
 *
 * ─── 두 가지 핵심 지표 ────────────────────────────────────────────────────────
 *
 *   1. **구체성 (Specificity)** — 얼마나 구체적이고 검증 가능한 내용인가
 *      - numericMetrics   : %, 숫자, 단위 포함 여부
 *      - namedTechnologies: 특정 기술/도구 명시 여부
 *      - strongActionVerb : 강한 동사로 시작하는지
 *      - avoidsVagueness  : "worked on", "helped" 등 모호한 표현 회피
 *      - concreteScope    : 규모·범위 수치 포함 (팀 수, 서비스 수, 금액 등)
 *      - properNouns      : 시스템명·프로젝트명 등 고유명사 포함
 *
 *   2. **설득력 (Persuasiveness)** — 얼마나 임팩트 있고 설득력 있는 내용인가
 *      - outcomeStatement  : 행동 결과(impact)를 명시하는가
 *      - decisionRationale : 의사결정 이유를 포함하는가 (after profiling, based on...)
 *      - businessImpact    : 비즈니스 가치를 보여주는가 (비용, 시간, 사용자 수)
 *      - narrativeCoherence: 논리적 흐름 (context → action → result)
 *      - scaleOrMagnitude  : 작업의 규모나 영향력을 드러내는가
 *
 * ─── 주요 함수 ─────────────────────────────────────────────────────────────────
 *
 *   scoreBullet(text)
 *     단일 bullet 을 두 지표로 채점.
 *     Returns: { specificity: number(0–100), persuasiveness: number(0–100), details: {...} }
 *
 *   scoreBulletPair(before, after)
 *     기존 bullet vs 개선 bullet 을 비교 채점.
 *     Returns: { before: Score, after: Score, delta: Delta, improved: boolean }
 *
 *   scoreResumeSection(bullets)
 *     섹션(bullets 배열) 전체를 채점.
 *
 *   runEvaluation(pairs)
 *     샘플 쌍 배열을 모두 채점하여 요약 리포트 반환.
 *
 *   formatReport(evalResult)
 *     사람이 읽을 수 있는 리포트 문자열 반환.
 *
 * ─── 샘플 쌍 (SAMPLE_PAIRS) ───────────────────────────────────────────────────
 *
 *   기존 자동 생성(before)과 채팅 개선(after) 출력 쌍의 황금 세트.
 *   회귀 테스트 및 품질 게이트에 활용.
 *
 * @module resumeEvalFramework
 */

// ─── 상수: 강한 동사 목록 ────────────────────────────────────────────────────────

/** 이력서 bullets 에서 선호하는 강한 동사 (resumeVoice.mjs 와 동기화) */
export const STRONG_ACTION_VERBS = Object.freeze([
  "Designed", "Built", "Implemented", "Reduced", "Improved", "Led",
  "Automated", "Centralized", "Migrated", "Optimized", "Resolved",
  "Established", "Streamlined", "Integrated", "Refactored", "Deployed",
  "Architected", "Eliminated", "Standardized", "Accelerated", "Identified",
  "Launched", "Scaled", "Shipped", "Delivered", "Engineered", "Replaced",
  "Introduced", "Negotiated", "Drove", "Spearheaded", "Rewrote", "Developed",
  "Evaluated", "Chose", "Selected", "Defined", "Created", "Managed",
  "Coordinated", "Mentored", "Onboarded", "Diagnosed",
]);

/** 회피해야 할 모호한 패턴 */
export const VAGUE_PATTERNS = Object.freeze([
  /\bworked on\b/i,
  /\bhelped (to|with)?\b/i,
  /\bassisted (in|with)?\b/i,
  /\bparticipated in\b/i,
  /\bwas involved\b/i,
  /\bwas responsible\b/i,
  /\bvarious\b/i,
  /\bsome\b/i,
  /\bseveral\b/i,
  /\butilized\b/i,
  /\bcontributed to\b/i,
  /^I /i,
  /^We /i,
  /^My /i,
]);

/** 의사결정 근거를 나타내는 패턴 */
export const DECISION_RATIONALE_PATTERNS = Object.freeze([
  /\bafter\b/i,
  /\bbecause\b/i,
  /\bdue to\b/i,
  /\bbased on\b/i,
  /\bfollowing\b/i,
  /\binstead of\b/i,
  /\breplacing\b/i,
  /\bover\b.{0,30}\bwhen\b/i,
  /\bto (address|resolve|fix|avoid)\b/i,
  /\bidentified.{0,40}(risk|issue|bottleneck|problem)\b/i,
  /\bprofiling (showed|revealed)\b/i,
  /\banalysis (showed|revealed|identified)\b/i,
]);

/** 비즈니스 임팩트를 나타내는 패턴 */
export const BUSINESS_IMPACT_PATTERNS = Object.freeze([
  /\$[\d,]+[KMB]?\b/,                        // 금액: $2M, $50K
  /\b\d+[\s]*(user|customer|engineer|team|client)s?\b/i,  // 사용자·팀 규모
  /\bsaving\b|\bsaved\b/i,                    // 비용 절감
  /\bincident(s)?\b/i,                        // 장애
  /\bdowntime\b/i,                            // 다운타임
  /\brevenue\b/i,                             // 매출
  /\bcost\b/i,                                // 비용
  /\bsla\b|\bslo\b/i,                         // SLA/SLO
  /\bdeploy(ment|ing)?\b.{0,40}\b(time|cycle|frequency)\b/i, // 배포 주기
]);

/** 수치 지표 패턴 */
export const NUMERIC_METRIC_PATTERNS = Object.freeze([
  /\d+\s*%/,                                  // 백분율: 40%, 3%
  /\d+\s*(ms|s|sec|min|hour|hr|day)\b/i,      // 시간 단위
  /\d+\s*(KB|MB|GB|TB)\b/i,                   // 크기
  /\d+[Xx]\b/,                                // 배수: 3x, 10x
  /\d+K\s*(req|event|message|record|rps|tps)/i, // 처리량
  /\d+\s*(req|event|message|record)s?\/(sec|s|min)\b/i, // 처리율
  /\b(from|reduced|improved|cut|increased).{1,40}\b(to|by)\b.{0,20}\d+/i,  // 개선폭
  /\b\d{1,3}(,\d{3})+\b/,                     // 쉼표 포함 큰 수: 50,000
  /\$[\d,]+/,                                 // 금액
]);

/** 규모·범위 수치 패턴 */
export const SCOPE_PATTERNS = Object.freeze([
  /\b\d+\s*(service|microservice|repo|component|team|engineer|system|endpoint|table|node|cluster|region|country)s?\b/i,
  /\b(production|prod)\b/i,
  /\b\d+\s*(million|billion|thousand|hundred)\b/i,
  /\b(all|entire|whole|across\s+(the\s+)?(company|org|team|platform))\b/i,
]);

// ─── 가중치 설정 ─────────────────────────────────────────────────────────────────

/** 구체성 하위 지표 가중치 (합산 1.0) */
export const SPECIFICITY_WEIGHTS = Object.freeze({
  numericMetrics:    0.30,   // 수치 있으면 바로 구체성↑
  namedTechnologies: 0.20,   // 기술 명칭
  strongActionVerb:  0.15,   // 강한 동사
  avoidsVagueness:   0.20,   // 모호 표현 없음
  concreteScope:     0.10,   // 규모·범위
  properNouns:       0.05,   // 고유명사
});

/** 설득력 하위 지표 가중치 (합산 1.0) */
export const PERSUASIVENESS_WEIGHTS = Object.freeze({
  outcomeStatement:  0.30,   // 결과 서술
  decisionRationale: 0.25,   // 의사결정 근거
  businessImpact:    0.25,   // 비즈니스 임팩트
  narrativeCoherence:0.10,   // 논리 흐름
  scaleOrMagnitude:  0.10,   // 규모·영향력
});

// ─── 품질 목표 ────────────────────────────────────────────────────────────────

/** 채팅 개선 후 달성해야 할 구체성 목표 점수 */
export const SPECIFICITY_TARGET = 70;

/** 채팅 개선 후 달성해야 할 설득력 목표 점수 */
export const PERSUASIVENESS_TARGET = 65;

/** 개선으로 인정받으려면 두 지표 모두 이 델타 이상 올라야 함 */
export const MIN_IMPROVEMENT_DELTA = 10;

// ─── 기술 명칭 감지 ───────────────────────────────────────────────────────────

/**
 * 일반적인 기술 스택 키워드 목록.
 * (이 목록에 있어야만 인정하는 것이 아니라, 잘 알려진 것들을 먼저 체크)
 */
const KNOWN_TECH_TERMS = new Set([
  "redis", "kafka", "postgresql", "mysql", "mongodb", "elasticsearch",
  "kubernetes", "k8s", "docker", "terraform", "aws", "gcp", "azure",
  "react", "preact", "vue", "angular", "nextjs", "node", "nodejs",
  "graphql", "grpc", "rest", "websocket", "webhook",
  "typescript", "javascript", "python", "go", "rust", "java", "kotlin",
  "github", "gitlab", "jenkins", "circleci", "github actions",
  "prometheus", "grafana", "datadog", "sentry", "opentelemetry",
  "oauth", "jwt", "pkce", "tls", "ssl",
  "openai", "llm", "gpt", "embedding", "rag",
  "ci/cd", "cicd", "pipeline", "microservice",
  "hono", "fastapi", "express", "rails", "django",
  "vercel", "supabase", "firebase", "lambda",
]);

/**
 * 텍스트에 기술 명칭이 포함되었는지 감지한다.
 * - KNOWN_TECH_TERMS 목록 우선 체크
 * - 추가로 대문자 약어 패턴 (API, SQL, SDK 등) 체크
 *
 * @param {string} text
 * @returns {{ found: boolean, terms: string[] }}
 */
function detectTechnologies(text) {
  const lower = text.toLowerCase();
  const foundKnown = [...KNOWN_TECH_TERMS].filter(term => lower.includes(term));

  // 대문자 약어: 2자 이상 연속 대문자 (SLA, API, SQL, RDS 등)
  const acronymMatches = (text.match(/\b[A-Z]{2,}\b/g) || [])
    .filter(m => !["I", "A", "AN", "THE"].includes(m));

  const terms = [...new Set([...foundKnown, ...acronymMatches])];
  return { found: terms.length > 0, terms };
}

/**
 * 고유명사(ProperNoun) 감지 — 대문자로 시작하는 단어 (동사 제외).
 *
 * @param {string} text
 * @returns {{ found: boolean, count: number }}
 */
function detectProperNouns(text) {
  // 첫 단어와 문장 첫 단어는 제외하고 중간에 대문자로 시작하는 단어
  const words = text.split(/\s+/);
  const properNouns = words.slice(1).filter(w => /^[A-Z][a-z]+/.test(w) && w.length > 2);
  return { found: properNouns.length > 0, count: properNouns.length };
}

// ─── 핵심 채점 함수 ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} SpecificityDetail
 * @property {boolean} numericMetrics   - 수치 지표 존재 여부
 * @property {boolean} namedTechnologies - 기술 명칭 존재 여부
 * @property {boolean} strongActionVerb - 강한 동사 존재 여부
 * @property {boolean} avoidsVagueness  - 모호 표현 없음 여부
 * @property {boolean} concreteScope    - 규모·범위 수치 존재 여부
 * @property {boolean} properNouns      - 고유명사 존재 여부
 * @property {string[]} techTerms       - 발견된 기술 명칭 목록
 * @property {string[]} vagueMatches    - 발견된 모호 표현 목록
 */

/**
 * @typedef {Object} PersuasivenessDetail
 * @property {boolean} outcomeStatement   - 결과 서술 존재 여부
 * @property {boolean} decisionRationale  - 의사결정 근거 존재 여부
 * @property {boolean} businessImpact     - 비즈니스 임팩트 존재 여부
 * @property {boolean} narrativeCoherence - 논리 흐름 존재 여부
 * @property {boolean} scaleOrMagnitude   - 규모·영향력 존재 여부
 */

/**
 * @typedef {Object} BulletScore
 * @property {number} specificity     - 구체성 점수 (0–100)
 * @property {number} persuasiveness  - 설득력 점수 (0–100)
 * @property {number} combined        - 종합 점수 (0–100), 두 점수의 평균
 * @property {SpecificityDetail} specificityDetails
 * @property {PersuasivenessDetail} persuasivenessDetails
 */

/**
 * 단일 bullet 텍스트를 구체성·설득력 지표로 채점한다.
 *
 * @param {string} text - 이력서 bullet 텍스트
 * @returns {BulletScore}
 */
export function scoreBullet(text) {
  if (!text || typeof text !== "string") {
    return {
      specificity: 0,
      persuasiveness: 0,
      combined: 0,
      specificityDetails: _emptySpecificityDetails(),
      persuasivenessDetails: _emptyPersuasivenessDetails(),
    };
  }

  const specificityDetails = _computeSpecificityDetails(text);
  const persuasivenessDetails = _computePersuasivenessDetails(text);

  const specificity = _aggregateSpecificity(specificityDetails);
  const persuasiveness = _aggregatePersuasiveness(persuasivenessDetails);
  const combined = Math.round((specificity + persuasiveness) / 2);

  return { specificity, persuasiveness, combined, specificityDetails, persuasivenessDetails };
}

/**
 * @typedef {Object} PairDelta
 * @property {number} specificity     - 구체성 변화량 (after - before)
 * @property {number} persuasiveness  - 설득력 변화량 (after - before)
 * @property {number} combined        - 종합 변화량 (after - before)
 */

/**
 * @typedef {Object} BulletPairScore
 * @property {string} before
 * @property {string} after
 * @property {BulletScore} beforeScore
 * @property {BulletScore} afterScore
 * @property {PairDelta} delta
 * @property {boolean} improved  - 두 지표 모두 MIN_IMPROVEMENT_DELTA 이상 향상됐는가
 * @property {boolean} meetsTarget - 개선 후 두 지표 모두 목표를 달성했는가
 */

/**
 * 기존 bullet(before)과 채팅으로 개선된 bullet(after)을 비교 채점한다.
 *
 * @param {string} before - 기존 자동 생성 bullet
 * @param {string} after  - 채팅 기반 개선 bullet
 * @returns {BulletPairScore}
 */
export function scoreBulletPair(before, after) {
  const beforeScore = scoreBullet(before);
  const afterScore = scoreBullet(after);

  const delta = {
    specificity:    afterScore.specificity    - beforeScore.specificity,
    persuasiveness: afterScore.persuasiveness - beforeScore.persuasiveness,
    combined:       afterScore.combined       - beforeScore.combined,
  };

  const improved =
    delta.specificity    >= MIN_IMPROVEMENT_DELTA &&
    delta.persuasiveness >= MIN_IMPROVEMENT_DELTA;

  const meetsTarget =
    afterScore.specificity    >= SPECIFICITY_TARGET &&
    afterScore.persuasiveness >= PERSUASIVENESS_TARGET;

  return { before, after, beforeScore, afterScore, delta, improved, meetsTarget };
}

/**
 * @typedef {Object} SectionScore
 * @property {number} avgSpecificity      - 섹션 평균 구체성 점수
 * @property {number} avgPersuasiveness   - 섹션 평균 설득력 점수
 * @property {number} avgCombined         - 섹션 평균 종합 점수
 * @property {number} bulletCount         - 채점된 bullet 수
 * @property {BulletScore[]} bulletScores - 개별 bullet 점수
 * @property {number} bulletsAboveTarget  - 두 지표 모두 목표 이상인 bullet 수
 * @property {number} targetPassRate      - 목표 달성 비율 (0–1)
 */

/**
 * 이력서 섹션(bullet 배열)을 채점한다.
 *
 * @param {string[]} bullets
 * @returns {SectionScore}
 */
export function scoreResumeSection(bullets) {
  if (!Array.isArray(bullets) || bullets.length === 0) {
    return {
      avgSpecificity: 0,
      avgPersuasiveness: 0,
      avgCombined: 0,
      bulletCount: 0,
      bulletScores: [],
      bulletsAboveTarget: 0,
      targetPassRate: 0,
    };
  }

  const bulletScores = bullets.map(b => scoreBullet(b));
  const n = bulletScores.length;

  const avgSpecificity    = Math.round(bulletScores.reduce((s, b) => s + b.specificity,    0) / n);
  const avgPersuasiveness = Math.round(bulletScores.reduce((s, b) => s + b.persuasiveness, 0) / n);
  const avgCombined       = Math.round(bulletScores.reduce((s, b) => s + b.combined,       0) / n);

  const bulletsAboveTarget = bulletScores.filter(
    b => b.specificity >= SPECIFICITY_TARGET && b.persuasiveness >= PERSUASIVENESS_TARGET
  ).length;
  const targetPassRate = n > 0 ? bulletsAboveTarget / n : 0;

  return {
    avgSpecificity,
    avgPersuasiveness,
    avgCombined,
    bulletCount: n,
    bulletScores,
    bulletsAboveTarget,
    targetPassRate,
  };
}

// ─── 샘플 출력 쌍 (황금 세트) ────────────────────────────────────────────────────
//
// 각 항목: { id, category, before, after, context, expectedImproved }
//
//   before   — 기존 자동 생성 bullet (vague, generic)
//   after    — 채팅 기반 개선 bullet (specific, evidence-backed)
//   context  — 어떤 데이터 소스로 근거를 찾아 개선했는지 (설명용)
//   category — "experience" | "summary" | "skills" | "project"
//   expectedImproved — true: 개선됐어야 함, false: 이미 충분히 좋았음
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {Object} SamplePair
 * @property {string} id
 * @property {string} category
 * @property {string} before
 * @property {string} after
 * @property {string} context
 * @property {boolean} expectedImproved
 * @property {string} [notes]
 */

/**
 * 기존 자동 생성 이력서 vs 채팅 기반 개선 이력서의 샘플 출력 쌍.
 * 회귀 테스트·품질 게이트·UI 시연에 활용한다.
 *
 * @type {SamplePair[]}
 */
export const SAMPLE_PAIRS = [
  // ── Experience bullets: vague → specific ────────────────────────────────
  {
    id: "sp-01",
    category: "experience",
    before: "Worked on improving system performance and backend reliability.",
    after:  "Reduced API p95 latency from 800ms to 120ms by adding Redis write-through cache across 3 high-traffic endpoints.",
    context: "커밋 로그에서 Redis 캐싱 PR 발견 → 슬랙에서 'p95 latency 800ms → 120ms' 수치 확인",
    expectedImproved: true,
    notes: "가장 전형적인 개선 패턴: 모호한 성과 서술 → 수치 + 기술명 + 범위",
  },
  {
    id: "sp-02",
    category: "experience",
    before: "Helped migrate the authentication system to a more secure approach.",
    after:  "Migrated 3 microservices from session-based auth to OAuth 2.0 + PKCE after identifying token interception risk via session replay analysis, reducing auth incidents by 85%.",
    context: "커밋 로그에서 OAuth PKCE PR 확인 → 세션 메모리에서 보안 취약점 분석 내용 추출",
    expectedImproved: true,
    notes: "의사결정 근거(after identifying) + 기술명 + 결과 수치 포함",
  },
  {
    id: "sp-03",
    category: "experience",
    before: "Contributed to improving the deployment process and CI/CD pipeline.",
    after:  "Built GitHub Actions CI/CD pipeline for the frontend monorepo, cutting deployment time from 45 minutes to 8 minutes and eliminating manual release steps.",
    context: "커밋 히스토리에서 GitHub Actions 워크플로 파일 변경 확인 → 슬랙 #deployments 채널에서 배포 시간 수치 확인",
    expectedImproved: true,
    notes: "추상적 기여 → 구체적 도구 + 수치 + 제거된 고통",
  },
  {
    id: "sp-04",
    category: "experience",
    before: "Worked on various backend tasks and helped improve system performance.",
    after:  "Architected event-driven processing pipeline handling 50K events/sec with sub-100ms latency, replacing synchronous polling that caused timeouts under load.",
    context: "커밋 메시지에서 Kafka 도입 PR 확인 → 세션 메모리에서 성능 테스트 결과 추출",
    expectedImproved: true,
    notes: "완전한 변환: 가장 모호한 표현 → 가장 구체적인 성과",
  },
  {
    id: "sp-05",
    category: "experience",
    before: "Participated in the development of a new feature for the data pipeline.",
    after:  "Designed and shipped real-time feature store serving 200M daily predictions with <5ms p99 latency, enabling the ML team to deploy 3x more models per quarter.",
    context: "커밋 로그에서 feature store 관련 대규모 PR 확인 → 슬랙 #ml-infra에서 예측 처리량 수치 확인",
    expectedImproved: true,
    notes: "참여 서술 → 설계·출시 주도자로, 비즈니스 임팩트(3x 더 빠른 모델 배포) 포함",
  },

  // ── Already-good bullets (should score high before AND after) ───────────
  {
    id: "sp-06",
    category: "experience",
    before: "Designed property-based testing framework for the trading engine, catching 12 edge-case bugs missed by unit tests and preventing $2M in potential losses.",
    after:  "Designed property-based testing framework for the trading engine, catching 12 edge-case bugs missed by unit tests and preventing $2M in potential losses.",
    context: "이미 충분히 구체적·설득력 있음 — 개선 불필요",
    expectedImproved: false,
    notes: "황금 기준: 개선 전에도 이미 목표 수준에 도달한 bullet",
  },
  {
    id: "sp-07",
    category: "experience",
    before: "Chose WebSocket over polling after profiling showed 200ms round-trip overhead, reducing notification latency by 40% across the real-time dashboard.",
    after:  "Chose WebSocket over polling after profiling showed 200ms round-trip overhead, reducing notification latency by 40% across the real-time dashboard.",
    context: "이미 충분히 구체적·설득력 있음 — 개선 불필요",
    expectedImproved: false,
    notes: "의사결정 근거(after profiling) + 수치 + 기술명이 이미 완전함",
  },

  // ── Summary section ────────────────────────────────────────────────────
  {
    id: "sp-08",
    category: "summary",
    before: "Experienced backend engineer with strong skills in various technologies. Good at problem solving and working with teams.",
    after:  "Backend engineer specializing in high-reliability distributed systems, with a track record of reducing latency and improving deployment velocity across 15+ production services.",
    context: "이력서 경험 섹션 데이터 + 슬랙 검색으로 반복된 성과 패턴 추출",
    expectedImproved: true,
    notes: "요약 섹션: 일반적 설명 → 전문 영역 + 반복된 성과 패턴",
  },
  {
    id: "sp-09",
    category: "summary",
    before: "Software engineer with experience in frontend and backend development. Passionate about technology and learning new things.",
    after:  "Full-stack engineer with 5+ years building data-intensive applications; specializes in Preact/Node.js performance optimization and developer tooling that ships on Vercel.",
    context: "경력 이력 + 기술 스택 커밋 빈도 분석으로 전문성 패턴 추출",
    expectedImproved: true,
    notes: "'passionate about' 제거, 연차 + 기술 스택 + 플랫폼으로 대체",
  },

  // ── Skills section ─────────────────────────────────────────────────────
  {
    id: "sp-10",
    category: "skills",
    before: "Good at using databases and caching systems.",
    after:  "PostgreSQL (query optimization, indexing), Redis (cache invalidation, pub/sub), Elasticsearch (full-text search, aggregations).",
    context: "커밋 히스토리에서 사용한 DB 기술 목록 추출",
    expectedImproved: true,
    notes: "기술 스킬: 추상적 서술 → 구체적 기술명 + 활용 영역",
  },

  // ── Project description ────────────────────────────────────────────────
  {
    id: "sp-11",
    category: "project",
    before: "Built a system to process data in real-time.",
    after:  "Real-time payment settlement pipeline processing $2M daily transactions with sub-second confirmation, built on Kafka + PostgreSQL with exactly-once semantics.",
    context: "커밋 로그에서 Kafka + PostgreSQL 도입, 슬랙에서 '일 거래량 $2M' 언급 추출",
    expectedImproved: true,
    notes: "프로젝트 설명: 추상적 기능 서술 → 도메인 + 규모 + 기술 스택",
  },
  {
    id: "sp-12",
    category: "project",
    before: "Helped with various backend improvements for the application.",
    after:  "Led backend reliability initiative across 8 microservices: introduced distributed tracing (OpenTelemetry), reduced P99 error rate from 0.8% to 0.05%, and halved mean time to recovery (MTTR) from 45 to 22 minutes.",
    context: "커밋 로그 6개월치에서 OpenTelemetry 도입 PR + 장애 대응 문서 추출",
    expectedImproved: true,
    notes: "단순 참여 → 주도한 이니셔티브, 범위 + 기술 + 복수 수치 포함",
  },
];

// ─── 전체 평가 실행 ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PairEvalResult
 * @property {string} id
 * @property {string} category
 * @property {string} before
 * @property {string} after
 * @property {BulletPairScore} pairScore
 * @property {boolean} expectedImproved
 * @property {boolean|null} classificationCorrect  - expectedImproved 와 actual improved 가 일치하는가
 * @property {string} [notes]
 */

/**
 * @typedef {Object} EvalReport
 * @property {number} totalPairs          - 평가된 쌍 수
 * @property {number} improvedCount       - improved === true 인 쌍 수
 * @property {number} meetsTargetCount    - meetsTarget === true 인 쌍 수
 * @property {number} improvementRate     - improvedCount / totalPairs (0–1)
 * @property {number} targetPassRate      - meetsTargetCount / totalPairs (0–1)
 * @property {number} classificationAccuracy - expectedImproved 와 일치한 비율 (0–1)
 * @property {number} avgBeforeSpecificity
 * @property {number} avgAfterSpecificity
 * @property {number} avgBeforePersuasiveness
 * @property {number} avgAfterPersuasiveness
 * @property {number} avgDeltaSpecificity
 * @property {number} avgDeltaPersuasiveness
 * @property {boolean} passed             - improvementRate ≥ EVAL_IMPROVEMENT_TARGET_RATE
 * @property {PairEvalResult[]} results
 */

/** 평가 통과 기준: 개선이 필요한 쌍 중 이 비율 이상이 improved===true 여야 함 */
export const EVAL_IMPROVEMENT_TARGET_RATE = 0.80;

/**
 * 샘플 쌍(또는 외부 쌍) 배열을 모두 채점하여 평가 리포트를 반환한다.
 *
 * @param {SamplePair[]} [pairs] - 평가할 쌍 배열. 생략 시 SAMPLE_PAIRS 사용.
 * @returns {EvalReport}
 */
export function runEvaluation(pairs) {
  const evalPairs = Array.isArray(pairs) && pairs.length > 0 ? pairs : SAMPLE_PAIRS;

  const results = evalPairs.map((pair) => {
    const pairScore = scoreBulletPair(pair.before, pair.after);
    const classificationCorrect =
      pair.expectedImproved != null
        ? pair.expectedImproved === pairScore.improved
        : null;

    return {
      id:    pair.id   ?? null,
      category: pair.category ?? null,
      before: pair.before,
      after:  pair.after,
      pairScore,
      expectedImproved: pair.expectedImproved ?? null,
      classificationCorrect,
      notes: pair.notes ?? null,
    };
  });

  const n = results.length;
  const improvedCount    = results.filter(r => r.pairScore.improved).length;
  const meetsTargetCount = results.filter(r => r.pairScore.meetsTarget).length;
  const improvementRate  = n > 0 ? improvedCount / n : 0;
  const targetPassRate   = n > 0 ? meetsTargetCount / n : 0;

  const withExpected = results.filter(r => r.classificationCorrect !== null);
  const classificationAccuracy =
    withExpected.length > 0
      ? withExpected.filter(r => r.classificationCorrect).length / withExpected.length
      : 1;

  const avgBeforeSpecificity    = _avg(results.map(r => r.pairScore.beforeScore.specificity));
  const avgAfterSpecificity     = _avg(results.map(r => r.pairScore.afterScore.specificity));
  const avgBeforePersuasiveness = _avg(results.map(r => r.pairScore.beforeScore.persuasiveness));
  const avgAfterPersuasiveness  = _avg(results.map(r => r.pairScore.afterScore.persuasiveness));
  const avgDeltaSpecificity     = _avg(results.map(r => r.pairScore.delta.specificity));
  const avgDeltaPersuasiveness  = _avg(results.map(r => r.pairScore.delta.persuasiveness));

  // 개선이 필요한(expectedImproved===true) 쌍만 기준으로 통과 판정
  const shouldImproveResults = results.filter(r => r.expectedImproved === true);
  const actuallyImproved = shouldImproveResults.filter(r => r.pairScore.improved).length;
  const improvementTargetRate = shouldImproveResults.length > 0
    ? actuallyImproved / shouldImproveResults.length
    : 1;

  const passed = improvementTargetRate >= EVAL_IMPROVEMENT_TARGET_RATE;

  return {
    totalPairs: n,
    improvedCount,
    meetsTargetCount,
    improvementRate,
    targetPassRate,
    classificationAccuracy,
    avgBeforeSpecificity,
    avgAfterSpecificity,
    avgBeforePersuasiveness,
    avgAfterPersuasiveness,
    avgDeltaSpecificity,
    avgDeltaPersuasiveness,
    passed,
    results,
  };
}

// ─── 리포트 포맷터 ────────────────────────────────────────────────────────────

/**
 * 평가 결과를 사람이 읽을 수 있는 문자열로 변환한다.
 *
 * @param {EvalReport} evalResult
 * @returns {string}
 */
export function formatReport(evalResult) {
  const lines = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  이력서 품질 평가 리포트 (Resume Evaluation Framework)");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // 요약
  lines.push("【 요약 】");
  lines.push(`  평가된 쌍 수    : ${evalResult.totalPairs}`);
  lines.push(`  개선된 쌍 수    : ${evalResult.improvedCount} / ${evalResult.totalPairs}`);
  lines.push(`  목표 달성 쌍 수 : ${evalResult.meetsTargetCount} / ${evalResult.totalPairs}`);
  lines.push(`  분류 정확도     : ${(evalResult.classificationAccuracy * 100).toFixed(1)}%`);
  lines.push(`  통과 여부       : ${evalResult.passed ? "✅ PASSED" : "❌ FAILED"}`);
  lines.push("");

  // 평균 점수 비교
  lines.push("【 평균 점수 비교 】");
  lines.push(`  구체성   : ${evalResult.avgBeforeSpecificity.toFixed(1)} → ${evalResult.avgAfterSpecificity.toFixed(1)}  (Δ ${evalResult.avgDeltaSpecificity >= 0 ? "+" : ""}${evalResult.avgDeltaSpecificity.toFixed(1)})`);
  lines.push(`  설득력   : ${evalResult.avgBeforePersuasiveness.toFixed(1)} → ${evalResult.avgAfterPersuasiveness.toFixed(1)}  (Δ ${evalResult.avgDeltaPersuasiveness >= 0 ? "+" : ""}${evalResult.avgDeltaPersuasiveness.toFixed(1)})`);
  lines.push(`  목표     : 구체성 ≥ ${SPECIFICITY_TARGET}, 설득력 ≥ ${PERSUASIVENESS_TARGET}`);
  lines.push("");

  // 개별 결과
  lines.push("【 개별 결과 】");
  for (const r of evalResult.results) {
    const { pairScore, id, category } = r;
    const bs = pairScore.beforeScore;
    const as_ = pairScore.afterScore;
    const improved = pairScore.improved ? "↑ 개선됨" : "─ 미개선";
    const target   = pairScore.meetsTarget ? "✓ 목표달성" : "✗ 미달";
    const correct  = r.classificationCorrect === true ? "✓" :
                     r.classificationCorrect === false ? "✗" : "-";

    lines.push(`  [${id ?? "-"}] (${category ?? "?"})`);
    lines.push(`    Before  : 구체성=${bs.specificity.toString().padStart(3)} 설득력=${bs.persuasiveness.toString().padStart(3)} 종합=${bs.combined.toString().padStart(3)}`);
    lines.push(`    After   : 구체성=${as_.specificity.toString().padStart(3)} 설득력=${as_.persuasiveness.toString().padStart(3)} 종합=${as_.combined.toString().padStart(3)}`);
    lines.push(`    결과    : ${improved}  ${target}  분류=${correct}`);
    if (r.notes) lines.push(`    비고    : ${r.notes}`);
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

/** @private */
function _computeSpecificityDetails(text) {
  // 수치 지표
  const numericMetrics = NUMERIC_METRIC_PATTERNS.some(p => p.test(text));

  // 기술 명칭
  const { found: namedTechnologies, terms: techTerms } = detectTechnologies(text);

  // 강한 동사 (첫 단어 또는 문장 내 강한 동사 포함)
  const firstWord = text.trim().split(/\s+/)[0];
  const strongActionVerb =
    STRONG_ACTION_VERBS.some(v => v.toLowerCase() === firstWord.toLowerCase()) ||
    STRONG_ACTION_VERBS.some(v => text.includes(v));

  // 모호한 표현 없음
  const vagueMatches = VAGUE_PATTERNS
    .filter(p => p.test(text))
    .map(p => p.toString());
  const avoidsVagueness = vagueMatches.length === 0;

  // 규모·범위 수치
  const concreteScope = SCOPE_PATTERNS.some(p => p.test(text));

  // 고유명사
  const { found: properNouns } = detectProperNouns(text);

  return { numericMetrics, namedTechnologies, strongActionVerb, avoidsVagueness, concreteScope, properNouns, techTerms, vagueMatches };
}

/** @private */
function _computePersuasivenessDetails(text) {
  // 결과 서술: 수치 있으면서 개선·감소·증가 패턴
  const outcomeStatement =
    NUMERIC_METRIC_PATTERNS.some(p => p.test(text)) &&
    /\b(reduc|improv|increas|cut|eliminat|accelerat|decreas|lower|higher|faster|slower|halv)/i.test(text);

  // 의사결정 근거
  const decisionRationale = DECISION_RATIONALE_PATTERNS.some(p => p.test(text));

  // 비즈니스 임팩트
  const businessImpact = BUSINESS_IMPACT_PATTERNS.some(p => p.test(text));

  // 논리 흐름: [동사]+[결과어] 패턴이 있고 30자 이상
  const narrativeCoherence =
    text.length >= 30 &&
    STRONG_ACTION_VERBS.some(v => text.includes(v)) &&
    (outcomeStatement || businessImpact || /\b(enabling|allowing|resulting in|so that)\b/i.test(text));

  // 규모·영향력: 수치 기반
  const scaleOrMagnitude =
    SCOPE_PATTERNS.some(p => p.test(text)) ||
    NUMERIC_METRIC_PATTERNS.some(p => p.test(text));

  return { outcomeStatement, decisionRationale, businessImpact, narrativeCoherence, scaleOrMagnitude };
}

/** @private */
function _aggregateSpecificity(d) {
  const raw =
    (d.numericMetrics    ? 1 : 0) * SPECIFICITY_WEIGHTS.numericMetrics    +
    (d.namedTechnologies ? 1 : 0) * SPECIFICITY_WEIGHTS.namedTechnologies +
    (d.strongActionVerb  ? 1 : 0) * SPECIFICITY_WEIGHTS.strongActionVerb  +
    (d.avoidsVagueness   ? 1 : 0) * SPECIFICITY_WEIGHTS.avoidsVagueness   +
    (d.concreteScope     ? 1 : 0) * SPECIFICITY_WEIGHTS.concreteScope     +
    (d.properNouns       ? 1 : 0) * SPECIFICITY_WEIGHTS.properNouns;
  return Math.round(raw * 100);
}

/** @private */
function _aggregatePersuasiveness(d) {
  const raw =
    (d.outcomeStatement   ? 1 : 0) * PERSUASIVENESS_WEIGHTS.outcomeStatement   +
    (d.decisionRationale  ? 1 : 0) * PERSUASIVENESS_WEIGHTS.decisionRationale  +
    (d.businessImpact     ? 1 : 0) * PERSUASIVENESS_WEIGHTS.businessImpact     +
    (d.narrativeCoherence ? 1 : 0) * PERSUASIVENESS_WEIGHTS.narrativeCoherence +
    (d.scaleOrMagnitude   ? 1 : 0) * PERSUASIVENESS_WEIGHTS.scaleOrMagnitude;
  return Math.round(raw * 100);
}

/** @private */
function _emptySpecificityDetails() {
  return {
    numericMetrics: false, namedTechnologies: false, strongActionVerb: false,
    avoidsVagueness: false, concreteScope: false, properNouns: false,
    techTerms: [], vagueMatches: [],
  };
}

/** @private */
function _emptyPersuasivenessDetails() {
  return {
    outcomeStatement: false, decisionRationale: false, businessImpact: false,
    narrativeCoherence: false, scaleOrMagnitude: false,
  };
}

/** @private */
function _avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 10) / 10;
}
