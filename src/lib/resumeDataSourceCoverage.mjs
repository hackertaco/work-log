/**
 * resumeDataSourceCoverage.mjs
 *
 * 데이터 소스(커밋/슬랙/세션) 기반 이력서 항목 정보 충족도 평가 모듈.
 *
 * 업무 로그(data/daily/*.json)에서 수집된 커밋 메시지, 세션 메모리, 슬랙
 * 컨텍스트를 신호 코퍼스(signal corpus)로 합산하고, 이를 이력서의 각 항목
 * (경험 불릿, 스킬, 요약 등)과 비교하여 증거가 충분한지 평가한다.
 *
 * 주요 API:
 *   buildSignalCorpus(workLogs)
 *     → 업무 로그 배열에서 신호 텍스트 코퍼스를 구축한다 (순수 함수).
 *
 *   evaluateItemCoverage(itemText, signalCorpus)
 *     → 단일 이력서 항목의 충족도 점수와 레벨을 반환한다 (순수 함수).
 *
 *   analyzeDataSourceCoverage(resumeDoc, signalCorpus)
 *     → 이력서 전체의 항목별 충족도를 분석하고 부족 항목을 감지한다 (순수 함수).
 *
 * 설계 원칙:
 *   - LLM 호출 없음 — 완전한 규칙 기반(rule-based) 분석
 *   - I/O 없음 — 순수 함수, 테스트 용이
 *   - 한국어/영어 혼합 텍스트 지원
 *   - 기존 resumeGapAnalysis.mjs, resumeDraftGeneration.mjs와 독립적
 *
 * 충족도 레벨:
 *   high   — score >= 0.5 : 핵심 키워드의 절반 이상이 데이터에서 확인됨
 *   medium — score >= 0.2 : 일부 키워드가 확인됨
 *   low    — score >= 0.05: 극소수 키워드만 확인됨 → 부족(insufficient)
 *   none   — score == 0   : 증거 없음 → 부족(insufficient)
 *
 * 부족 기준(isInsufficient):
 *   score < INSUFFICIENT_THRESHOLD (0.2) → 해당 항목을 부족으로 판정
 *   단, 빈 항목(텍스트 없음)과 의미 없는 항목은 평가에서 제외한다.
 */

// ─── 상수 ────────────────────────────────────────────────────────────────────────

/**
 * 이 점수 미만이면 "정보 부족(insufficient)" 판정.
 * 0 ~ 1 범위; 기본값 0.2 (20%).
 */
const INSUFFICIENT_THRESHOLD = 0.2;

/**
 * 항목 텍스트에서 추출된 의미 있는 토큰이 이 개수 미만이면
 * "분석 불가(unanalyzable)" 처리하고 isInsufficient=false로 넘긴다.
 * 너무 짧은 항목(한 단어 등)은 커버리지 분석 대상에서 제외.
 */
const MIN_MEANINGFUL_TOKENS = 2;

// ─── 한국어/영어 불용어(stop words) ───────────────────────────────────────────

/** 한국어 조사, 어미, 접속사 등 의미 없는 토큰 집합 */
const KOREAN_STOP_TOKENS = new Set([
  // 조사
  "을", "를", "이", "가", "은", "는", "에", "의", "과", "와", "로", "으로",
  "에서", "에게", "으로서", "에서는", "에는",
  // 서술어 어미 — "구현했습니다", "완료했습니다" 등 동사 어미 결합형
  "이다", "입니다", "했습니다", "합니다", "했다", "한다",
  "되었다", "되었습니다", "됩니다", "됬습니다",
  "하여서", "하고", "하여", "하는", "했으며",
  // 구현·개발 관련 서술 어미 결합형 (이 형태들은 의미 없이 동작만 나타냄)
  "구현했습니다", "구현하였습니다", "구현해", "구현하여",
  "개발했습니다", "개발하였습니다", "개발해", "개발하여",
  "설계했습니다", "설계하였습니다", "설계해", "설계하여",
  "개선했습니다", "개선하였습니다", "개선해", "개선하여",
  "도입했습니다", "도입하였습니다", "도입해", "도입하여",
  "사용했습니다", "사용하였습니다", "사용해", "사용하여",
  "완료했습니다", "완료하였습니다", "달성했습니다",
  // 접속사·부사
  "통해", "위해", "대한", "대해", "등을", "등의", "등이", "및", "또는",
  "그리고", "하지만", "또한", "즉", "더불어", "따라서", "그러나", "위한",
  "통한", "이를", "이로써"
]);

/** 영어 불용어 집합 */
const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "need",
  "it", "its", "this", "that", "these", "those", "i", "we", "you", "he",
  "she", "they", "my", "our", "your", "his", "her", "their", "which",
  "who", "what", "when", "where", "how", "all", "not", "no", "so", "if",
  "than", "then", "up", "out", "more", "also", "into", "through", "across",
  "via", "new", "within"
]);

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * 충족도 레벨.
 *
 * @typedef {'high'|'medium'|'low'|'none'} CoverageLevel
 */

/**
 * 단일 이력서 항목의 충족도 평가 결과.
 *
 * @typedef {Object} ItemCoverageResult
 * @property {string}         text             — 원본 항목 텍스트
 * @property {number}         score            — 0–1 사이 충족도 점수
 * @property {CoverageLevel}  level            — 충족도 레벨
 * @property {boolean}        isInsufficient   — true이면 보충 질문 또는 사용자 입력이 필요
 * @property {string[]}       matchedTokens    — 코퍼스에서 확인된 토큰 목록
 * @property {string[]}       unmatchedTokens  — 코퍼스에서 확인되지 않은 토큰 목록
 * @property {string|null}    reason           — isInsufficient=true일 때 사람이 읽을 수 있는 이유
 */

/**
 * 경험(experience) 항목의 충족도 분석 결과.
 *
 * @typedef {Object} ExperienceCoverageItem
 * @property {string}              company       — 회사명
 * @property {string}              title         — 직함
 * @property {number}              coverageScore — 0–1 회사 전체 평균 점수
 * @property {ItemCoverageResult[]} bullets       — 불릿별 충족도
 * @property {boolean}             isInsufficient — 불릿 중 하나라도 insufficient이면 true
 */

/**
 * 스킬 항목의 충족도 분석 결과.
 *
 * @typedef {Object} SkillCoverageItem
 * @property {string}  skill          — 스킬명
 * @property {number}  score          — 0–1 충족도 점수
 * @property {CoverageLevel} level    — 충족도 레벨
 * @property {boolean} isInsufficient — 충족도 부족 여부
 */

/**
 * 이력서 전체의 충족도 분석 결과.
 *
 * @typedef {Object} DataSourceCoverageResult
 * @property {ExperienceCoverageItem[]} experience   — 경험 섹션별 충족도
 * @property {{
 *   technical: SkillCoverageItem[],
 *   languages: SkillCoverageItem[],
 *   tools:     SkillCoverageItem[]
 * }} skills                                        — 스킬 섹션별 충족도
 * @property {{ score: number, level: CoverageLevel, isInsufficient: boolean }} summary
 *                                                  — 요약 섹션 충족도
 * @property {InsufficientItem[]} insufficientItems — 부족 항목 평탄화 목록
 * @property {CoverageSummary}    coverageSummary   — 전체 통계
 */

/**
 * 부족으로 판정된 이력서 항목.
 *
 * @typedef {Object} InsufficientItem
 * @property {'experience'|'skills'|'summary'|'projects'} section — 이력서 섹션
 * @property {string}  [company]   — experience 섹션일 때 회사명
 * @property {string}  [skillCategory] — skills 섹션일 때 카테고리 ('technical'|'languages'|'tools')
 * @property {string}  text        — 부족 항목 텍스트
 * @property {number}  score       — 충족도 점수 (0–1)
 * @property {CoverageLevel} level — 충족도 레벨
 * @property {'high'|'medium'|'low'} severity — 부족 심각도
 * @property {string}  reason      — 부족 이유 설명
 * @property {string[]} unmatchedTokens — 데이터에서 확인되지 않은 키워드
 */

/**
 * 전체 커버리지 통계.
 *
 * @typedef {Object} CoverageSummary
 * @property {number} totalItems         — 평가한 전체 항목 수
 * @property {number} insufficientCount  — 부족 항목 수
 * @property {number} coverageRatio      — (totalItems - insufficientCount) / totalItems (0–1)
 * @property {number} avgScore           — 전체 항목 평균 충족도 점수
 */

/**
 * 업무 로그 배열에서 신호 텍스트 코퍼스를 구축한다.
 *
 * 포함되는 데이터:
 *   - projects[].commits[].subject  (커밋 메시지)
 *   - aiSessions.codex[].summary + .snippets[]  (Codex 세션)
 *   - aiSessions.claude[].summary + .snippets[] (Claude 세션)
 *   - highlights.businessOutcomes[]  (비즈니스 결과)
 *   - highlights.keyChanges[]        (주요 변경사항)
 *   - highlights.commitAnalysis[]    (커밋 분석)
 *   - highlights.impact[]            (임팩트)
 *   - highlights.workingStyleSignals[] (업무 스타일 신호)
 *   - highlights.storyThreads[].outcome + .keyChange (스토리 스레드)
 *   - resume.candidates[]            (이력서 후보)
 *   - resume.companyCandidates[]     (회사별 이력서 후보)
 *   - slackContexts[].text           (슬랙 컨텍스트, 있을 경우)
 *
 * @param {object[]} workLogs — data/daily/*.json 파일 배열
 * @returns {string}          — 합산된 신호 코퍼스 (소문자 정규화됨)
 */
export function buildSignalCorpus(workLogs) {
  if (!Array.isArray(workLogs) || workLogs.length === 0) return "";

  const parts = [];

  for (const wl of workLogs) {
    if (!wl || typeof wl !== "object") continue;

    const highlights = wl.highlights ?? {};
    const resume = wl.resume ?? {};

    // ── 커밋 메시지 ────────────────────────────────────────────────────────
    const projects = Array.isArray(wl.projects) ? wl.projects : [];
    for (const project of projects) {
      const commits = Array.isArray(project?.commits) ? project.commits : [];
      for (const commit of commits) {
        if (commit?.subject) parts.push(String(commit.subject));
        if (commit?.repo) parts.push(String(commit.repo));
      }
    }

    // ── AI 세션 메모리 ──────────────────────────────────────────────────────
    const aiSessions = wl.aiSessions ?? {};
    const allSessions = [
      ...(Array.isArray(aiSessions.codex) ? aiSessions.codex : []),
      ...(Array.isArray(aiSessions.claude) ? aiSessions.claude : [])
    ];
    for (const session of allSessions) {
      if (session?.summary) parts.push(String(session.summary));
      if (Array.isArray(session?.snippets)) {
        for (const snippet of session.snippets) {
          if (snippet) parts.push(String(snippet));
        }
      }
    }

    // ── 하이라이트 ─────────────────────────────────────────────────────────
    for (const field of [
      "businessOutcomes",
      "keyChanges",
      "commitAnalysis",
      "impact",
      "workingStyleSignals",
      "accomplishments",
      "mainWork"
    ]) {
      const arr = highlights[field];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item) parts.push(String(item));
        }
      }
    }

    // ── 스토리 스레드 ──────────────────────────────────────────────────────
    const storyThreads = Array.isArray(highlights.storyThreads)
      ? highlights.storyThreads
      : [];
    for (const thread of storyThreads) {
      if (thread?.outcome) parts.push(String(thread.outcome));
      if (thread?.keyChange) parts.push(String(thread.keyChange));
      if (thread?.why) parts.push(String(thread.why));
      if (thread?.decision) parts.push(String(thread.decision));
      if (thread?.repo) parts.push(String(thread.repo));
    }

    // ── 이력서 후보 ────────────────────────────────────────────────────────
    for (const field of ["candidates", "companyCandidates", "openSourceCandidates"]) {
      const arr = resume[field];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item) parts.push(String(item));
        }
      }
    }

    // ── 슬랙 컨텍스트 (일부 daily 파일에 포함될 경우) ─────────────────────
    const slackContexts = Array.isArray(wl.slackContexts)
      ? wl.slackContexts
      : [];
    for (const ctx of slackContexts) {
      if (ctx?.text) parts.push(String(ctx.text));
    }
  }

  // 모든 텍스트를 소문자로 합산
  return parts
    .filter((p) => p && p.trim())
    .join(" ")
    .toLowerCase();
}

/**
 * 한국어 조사 접미사 목록 — 토큰 끝에서 제거를 시도한다.
 * 긴 것부터 짧은 것 순으로 정렬 (탐욕적 매칭 방지).
 *
 * @type {string[]}
 */
const KOREAN_PARTICLE_SUFFIXES = [
  "에서는", "으로서", "에서의", "이라는",
  "에서", "에게", "에는", "으로", "이라",
  "을", "를", "이", "가", "은", "는",
  "에", "의", "과", "와", "로", "서"
];

/**
 * 토큰 끝에 붙은 한국어 조사 접미사를 제거한다.
 * 제거 후 길이가 2 미만이면 원본 토큰을 반환한다.
 *
 * @param {string} token — 소문자 정규화된 토큰
 * @returns {string}
 */
function stripKoreanParticle(token) {
  for (const suffix of KOREAN_PARTICLE_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 2) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

/**
 * 텍스트에서 의미 있는 토큰(키워드)을 추출한다.
 *
 * 처리 순서:
 *   1. 공백·구두점·특수문자로 분리
 *   2. 한국어 조사 접미사 제거 (예: "API를" → "api")
 *   3. 2자 미만 토큰 제거
 *   4. 한국어 불용어 / 영어 불용어 제거
 *   5. 중복 제거 (Set)
 *
 * @param {string} text — 분석할 텍스트
 * @returns {string[]}  — 소문자 정규화된 의미 토큰 배열
 */
export function extractMeaningfulTokens(text) {
  if (!text || typeof text !== "string") return [];

  // 구두점·특수문자·숫자 단독 토큰 제거 후 공백 분리
  const rawTokens = text
    .toLowerCase()
    .replace(/[.,\-–—·:;!?()[\]{}"'`~@#$%^&*+=|\\/<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const seen = new Set();
  const meaningful = [];

  for (let token of rawTokens) {
    // 한국어 조사 접미사 제거 시도 (예: "api를" → "api")
    token = stripKoreanParticle(token);

    // 2자 미만 제거
    if (token.length < 2) continue;

    // 숫자만으로 이루어진 토큰 제거 (날짜, 버전 번호 등)
    if (/^\d+$/.test(token)) continue;

    // 한국어 불용어 제거 (조사 제거 후 재확인)
    if (KOREAN_STOP_TOKENS.has(token)) continue;

    // 영어 불용어 제거
    if (ENGLISH_STOP_WORDS.has(token)) continue;

    if (seen.has(token)) continue;
    seen.add(token);
    meaningful.push(token);
  }

  return meaningful;
}

/**
 * 단일 이력서 항목 텍스트의 데이터 소스 충족도를 평가한다.
 *
 * 알고리즘:
 *   1. 항목 텍스트에서 의미 있는 토큰 추출
 *   2. 각 토큰이 신호 코퍼스에 포함되어 있는지 확인
 *   3. score = matchedCount / totalTokens
 *   4. score 기준으로 레벨 및 isInsufficient 판정
 *
 * 특수 케이스:
 *   - 텍스트가 비어있으면 score=0, isInsufficient=false (평가 불가)
 *   - 의미 토큰이 MIN_MEANINGFUL_TOKENS 미만이면 isInsufficient=false (텍스트 너무 짧음)
 *
 * @param {string} itemText      — 이력서 항목 텍스트
 * @param {string} signalCorpus  — buildSignalCorpus()로 구축한 코퍼스 (소문자)
 * @returns {ItemCoverageResult}
 */
export function evaluateItemCoverage(itemText, signalCorpus) {
  const text = typeof itemText === "string" ? itemText.trim() : "";

  // 빈 텍스트 처리
  if (!text) {
    return {
      text: "",
      score: 0,
      level: "none",
      isInsufficient: false,
      matchedTokens: [],
      unmatchedTokens: [],
      reason: null
    };
  }

  const tokens = extractMeaningfulTokens(text);

  // 의미 토큰이 너무 적으면 분석 불가 처리
  if (tokens.length < MIN_MEANINGFUL_TOKENS) {
    return {
      text,
      score: 0,
      level: "none",
      isInsufficient: false, // 텍스트가 너무 짧아 판단 불가
      matchedTokens: [],
      unmatchedTokens: tokens,
      reason: null
    };
  }

  // 코퍼스 비어있으면 전부 unmatched
  if (!signalCorpus) {
    return {
      text,
      score: 0,
      level: "none",
      isInsufficient: true,
      matchedTokens: [],
      unmatchedTokens: tokens,
      reason: "업무 로그 데이터가 없어 이 항목을 검증할 수 없습니다."
    };
  }

  // 토큰별 매칭 확인
  const matchedTokens = [];
  const unmatchedTokens = [];

  for (const token of tokens) {
    if (signalCorpus.includes(token)) {
      matchedTokens.push(token);
    } else {
      unmatchedTokens.push(token);
    }
  }

  const score = matchedTokens.length / tokens.length;
  const level = scoreToLevel(score);
  const isInsufficient = score < INSUFFICIENT_THRESHOLD;

  let reason = null;
  if (isInsufficient) {
    if (score === 0) {
      reason = `이 항목과 관련된 업무 기록을 찾을 수 없습니다. 구체적인 프로젝트나 상황을 알려주시면 보강할 수 있습니다.`;
    } else {
      const unmatched = unmatchedTokens.slice(0, 3).join(", ");
      reason = `일부 키워드(${unmatched} 등)에 대한 업무 근거가 부족합니다. 관련 경험을 구체적으로 설명해 주세요.`;
    }
  }

  return {
    text,
    score,
    level,
    isInsufficient,
    matchedTokens,
    unmatchedTokens,
    reason
  };
}

/**
 * 이력서 전체 문서의 데이터 소스 충족도를 분석한다.
 *
 * 평가 섹션:
 *   - experience: 각 회사의 불릿(2개 이상 있을 때 평가)
 *   - skills.technical / languages / tools: 각 스킬
 *   - summary: 요약 텍스트 (있을 때만)
 *   - projects: 각 프로젝트의 불릿
 *
 * @param {object} resumeDoc     — 이력서 문서 (resumeBootstrap 스키마 v1)
 * @param {string} signalCorpus  — buildSignalCorpus()로 구축한 코퍼스
 * @returns {DataSourceCoverageResult}
 */
export function analyzeDataSourceCoverage(resumeDoc, signalCorpus) {
  if (!resumeDoc || typeof resumeDoc !== "object") {
    return _emptyResult();
  }

  const corpus = typeof signalCorpus === "string" ? signalCorpus : "";

  /** @type {InsufficientItem[]} */
  const insufficientItems = [];

  // ── Experience 섹션 분석 ──────────────────────────────────────────────────
  const experience = _analyzeExperience(resumeDoc.experience, corpus, insufficientItems);

  // ── Skills 섹션 분석 ──────────────────────────────────────────────────────
  const skills = _analyzeSkills(resumeDoc.skills, corpus, insufficientItems);

  // ── Summary 분석 ──────────────────────────────────────────────────────────
  const summary = _analyzeSummary(resumeDoc.summary, corpus, insufficientItems);

  // ── Projects 분석 ─────────────────────────────────────────────────────────
  _analyzeProjects(resumeDoc.projects, corpus, insufficientItems);

  // ── 전체 통계 산출 ────────────────────────────────────────────────────────
  const coverageSummary = _buildCoverageSummary(experience, skills, summary);

  return {
    experience,
    skills,
    summary,
    insufficientItems,
    coverageSummary
  };
}

// ─── 내부 분석 함수 ────────────────────────────────────────────────────────────

/**
 * experience 섹션 분석.
 *
 * @param {object[]|undefined}  expArr         — 이력서 경험 배열
 * @param {string}              corpus         — 신호 코퍼스
 * @param {InsufficientItem[]}  insufficientItems — 부족 항목 축적 배열 (mutable)
 * @returns {ExperienceCoverageItem[]}
 */
function _analyzeExperience(expArr, corpus, insufficientItems) {
  if (!Array.isArray(expArr)) return [];

  return expArr
    .filter((exp) => exp && typeof exp === "object" && exp.company)
    .map((exp) => {
      const company = String(exp.company).trim();
      const title = String(exp.title ?? "").trim();
      const bullets = Array.isArray(exp.bullets) ? exp.bullets : [];

      const bulletResults = bullets
        .filter((b) => typeof b === "string" && b.trim())
        .map((bullet) => {
          const result = evaluateItemCoverage(bullet, corpus);

          if (result.isInsufficient) {
            insufficientItems.push({
              section: "experience",
              company,
              text: bullet,
              score: result.score,
              level: result.level,
              severity: _scoreSeverity(result.score),
              reason: result.reason ?? "업무 로그에서 관련 근거를 찾을 수 없습니다.",
              unmatchedTokens: result.unmatchedTokens
            });
          }

          return result;
        });

      const avgScore =
        bulletResults.length > 0
          ? bulletResults.reduce((sum, r) => sum + r.score, 0) / bulletResults.length
          : 0;

      return {
        company,
        title,
        coverageScore: avgScore,
        bullets: bulletResults,
        isInsufficient: bulletResults.some((r) => r.isInsufficient)
      };
    });
}

/**
 * skills 섹션 분석.
 *
 * @param {object|undefined}    skillsObj      — 이력서 스킬 객체
 * @param {string}              corpus         — 신호 코퍼스
 * @param {InsufficientItem[]}  insufficientItems — 부족 항목 축적 배열
 * @returns {{ technical: SkillCoverageItem[], languages: SkillCoverageItem[], tools: SkillCoverageItem[] }}
 */
function _analyzeSkills(skillsObj, corpus, insufficientItems) {
  const result = {
    technical: [],
    languages: [],
    tools: []
  };

  if (!skillsObj || typeof skillsObj !== "object") return result;

  for (const category of /** @type {Array<'technical'|'languages'|'tools'>} */ (["technical", "languages", "tools"])) {
    const arr = Array.isArray(skillsObj[category]) ? skillsObj[category] : [];
    result[category] = arr
      .filter((s) => typeof s === "string" && s.trim())
      .map((skill) => {
        const skillText = skill.trim();
        // 스킬은 단어 자체가 코퍼스에 포함되는지 확인 (부분 매칭)
        const normalizedSkill = skillText.toLowerCase();
        const corpusHasSkill = corpus.includes(normalizedSkill);
        const score = corpusHasSkill ? 1.0 : 0.0;
        const level = scoreToLevel(score);
        const isInsufficient = !corpusHasSkill;

        if (isInsufficient) {
          insufficientItems.push({
            section: "skills",
            skillCategory: category,
            text: skillText,
            score,
            level,
            severity: "low", // 스킬 누락은 상대적으로 낮은 심각도
            reason: `"${skillText}" 스킬 사용 사례가 업무 로그에서 확인되지 않습니다. 실제로 사용한 프로젝트가 있다면 구체적으로 설명해 주세요.`,
            unmatchedTokens: [normalizedSkill]
          });
        }

        return { skill: skillText, score, level, isInsufficient };
      });
  }

  return result;
}

/**
 * summary 섹션 분석.
 *
 * @param {string|undefined}    summaryText    — 이력서 요약 텍스트
 * @param {string}              corpus         — 신호 코퍼스
 * @param {InsufficientItem[]}  insufficientItems — 부족 항목 축적 배열
 * @returns {{ score: number, level: CoverageLevel, isInsufficient: boolean }}
 */
function _analyzeSummary(summaryText, corpus, insufficientItems) {
  if (!summaryText || typeof summaryText !== "string" || !summaryText.trim()) {
    return { score: 0, level: "none", isInsufficient: false };
  }

  const result = evaluateItemCoverage(summaryText, corpus);

  if (result.isInsufficient) {
    insufficientItems.push({
      section: "summary",
      text: summaryText,
      score: result.score,
      level: result.level,
      severity: _scoreSeverity(result.score),
      reason: result.reason ?? "요약 내용을 뒷받침하는 업무 근거가 부족합니다.",
      unmatchedTokens: result.unmatchedTokens
    });
  }

  return {
    score: result.score,
    level: result.level,
    isInsufficient: result.isInsufficient
  };
}

/**
 * projects 섹션 분석 (insufficientItems 축적용; 별도 반환값 없음).
 *
 * @param {object[]|undefined}  projectsArr    — 이력서 프로젝트 배열
 * @param {string}              corpus         — 신호 코퍼스
 * @param {InsufficientItem[]}  insufficientItems — 부족 항목 축적 배열
 */
function _analyzeProjects(projectsArr, corpus, insufficientItems) {
  if (!Array.isArray(projectsArr)) return;

  for (const project of projectsArr) {
    if (!project || typeof project !== "object") continue;
    const projectName = String(project.name ?? "").trim();
    const bullets = Array.isArray(project.bullets) ? project.bullets : [];

    for (const bullet of bullets) {
      if (typeof bullet !== "string" || !bullet.trim()) continue;

      const result = evaluateItemCoverage(bullet, corpus);
      if (result.isInsufficient) {
        insufficientItems.push({
          section: "projects",
          company: projectName, // 프로젝트명을 company 필드에 저장 (재활용)
          text: bullet,
          score: result.score,
          level: result.level,
          severity: _scoreSeverity(result.score),
          reason: result.reason ?? "프로젝트 내용을 뒷받침하는 업무 근거가 부족합니다.",
          unmatchedTokens: result.unmatchedTokens
        });
      }
    }
  }
}

// ─── 통계 산출 ────────────────────────────────────────────────────────────────

/**
 * 전체 커버리지 통계를 산출한다.
 *
 * @param {ExperienceCoverageItem[]}  experience
 * @param {{ technical: SkillCoverageItem[], languages: SkillCoverageItem[], tools: SkillCoverageItem[] }} skills
 * @param {{ score: number, level: CoverageLevel, isInsufficient: boolean }} summary
 * @returns {CoverageSummary}
 */
function _buildCoverageSummary(experience, skills, summary) {
  const allScores = [];
  let insufficientCount = 0;

  // Experience bullets
  for (const exp of experience) {
    for (const bullet of exp.bullets) {
      if (bullet.text) { // 평가 가능한 항목만 포함
        allScores.push(bullet.score);
        if (bullet.isInsufficient) insufficientCount++;
      }
    }
  }

  // Skills
  for (const category of ["technical", "languages", "tools"]) {
    for (const skill of skills[category]) {
      allScores.push(skill.score);
      if (skill.isInsufficient) insufficientCount++;
    }
  }

  // Summary (있을 때만)
  if (summary.score > 0 || summary.level !== "none") {
    allScores.push(summary.score);
    if (summary.isInsufficient) insufficientCount++;
  }

  const totalItems = allScores.length;
  const avgScore =
    totalItems > 0
      ? allScores.reduce((sum, s) => sum + s, 0) / totalItems
      : 0;
  const coverageRatio =
    totalItems > 0 ? (totalItems - insufficientCount) / totalItems : 1;

  return {
    totalItems,
    insufficientCount,
    coverageRatio,
    avgScore
  };
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

/**
 * 충족도 점수를 레벨로 변환한다.
 *
 * @param {number} score — 0–1
 * @returns {CoverageLevel}
 */
export function scoreToLevel(score) {
  if (score >= 0.5) return "high";
  if (score >= 0.2) return "medium";
  if (score > 0) return "low";
  return "none";
}

/**
 * 충족도 점수를 심각도로 변환한다.
 * isInsufficient=true인 항목에 대해서만 의미가 있다.
 *
 * @param {number} score — 0–1
 * @returns {'high'|'medium'|'low'}
 */
function _scoreSeverity(score) {
  if (score === 0) return "high";   // 전혀 근거 없음
  if (score < 0.1) return "high";  // 거의 근거 없음
  return "low";                     // 일부 근거 있으나 불충분
}

/**
 * 빈 결과 객체를 반환한다 (입력이 유효하지 않을 때).
 *
 * @returns {DataSourceCoverageResult}
 */
function _emptyResult() {
  return {
    experience: [],
    skills: { technical: [], languages: [], tools: [] },
    summary: { score: 0, level: "none", isInsufficient: false },
    insufficientItems: [],
    coverageSummary: {
      totalItems: 0,
      insufficientCount: 0,
      coverageRatio: 1,
      avgScore: 0
    }
  };
}
