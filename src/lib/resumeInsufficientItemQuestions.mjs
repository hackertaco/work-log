/**
 * resumeInsufficientItemQuestions.mjs
 *
 * 이력서 커버리지 분석에서 부족한 항목에 대해 구체적인 보충 질문을 생성한다.
 *
 * Sub-AC 9-2: 부족한 항목에 대해 사용자에게 구체적인 보충 질문을 생성
 *
 * 설계 원칙:
 *   - LLM 호출 없음 — 완전한 규칙 기반(rule-based) 질문 생성
 *   - I/O 없음 — 순수 함수, 테스트 용이
 *   - 섹션별 맞춤형 질문 (경험/스킬/요약/프로젝트)
 *   - 중복 방지 (같은 회사, 같은 스킬은 최대 1개 질문)
 *   - 심각도(severity) 우선 정렬
 *
 * @module resumeInsufficientItemQuestions
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * 보충 질문 항목.
 *
 * @typedef {Object} FollowUpQuestion
 * @property {string}  id        — 고유 식별자 (결정론적 해시 기반)
 * @property {string}  question  — 보충 질문 텍스트 (사용자에게 표시)
 * @property {'experience'|'skills'|'summary'|'projects'} section — 관련 이력서 섹션
 * @property {string}  [company]  — experience 섹션일 때 회사명
 * @property {string}  itemText   — 부족 항목 텍스트 미리보기 (최대 50자)
 * @property {'high'|'medium'|'low'} severity — 부족 심각도
 */

// ─── 상수 ─────────────────────────────────────────────────────────────────────

/** 기본 최대 질문 수 */
const DEFAULT_MAX_QUESTIONS = 5;

/** 회사당 최대 질문 수 */
const MAX_QUESTIONS_PER_COMPANY = 1;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * InsufficientItem 목록에서 구체적인 보충 질문을 생성한다.
 *
 * 처리 순서:
 *   1. 심각도(severity) 내림차순 정렬 (high → medium → low)
 *   2. 섹션별 그룹화하여 중복 방지
 *   3. 각 항목에 대해 섹션 타입에 맞는 질문 텍스트 생성
 *   4. 최대 maxQuestions 개 반환
 *
 * @param {import('./resumeDataSourceCoverage.mjs').InsufficientItem[]} insufficientItems
 * @param {{ maxQuestions?: number }} [options]
 * @returns {FollowUpQuestion[]}
 */
export function generateFollowUpQuestions(insufficientItems, options = {}) {
  const maxQuestions = options.maxQuestions ?? DEFAULT_MAX_QUESTIONS;

  if (!Array.isArray(insufficientItems) || insufficientItems.length === 0) {
    return [];
  }

  // 심각도 우선 정렬
  const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
  const sorted = [...insufficientItems].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2)
  );

  const questions = [];
  /** @type {Map<string, number>} 회사명 → 이미 생성된 질문 수 */
  const companyCount = new Map();
  /** @type {Set<string>} 이미 처리한 스킬 텍스트 */
  const seenSkills = new Set();
  let summaryQuestionDone = false;

  for (const item of sorted) {
    if (questions.length >= maxQuestions) break;

    const q = _generateQuestion(item, {
      companyCount,
      seenSkills,
      summaryQuestionDone,
    });

    if (!q) continue;

    // 중복 방지 상태 업데이트
    if (item.section === "summary") summaryQuestionDone = true;
    if (item.section === "experience" && item.company) {
      companyCount.set(item.company, (companyCount.get(item.company) ?? 0) + 1);
    }
    if (item.section === "skills" || item.section === "projects") {
      seenSkills.add(item.text);
    }

    questions.push(q);
  }

  return questions;
}

/**
 * 부족 항목을 채팅에 표시할 시스템 메시지로 변환한다.
 *
 * 질문이 없으면 null을 반환한다.
 *
 * @param {FollowUpQuestion[]} followUpQuestions
 * @param {{ coverageRatio?: number, insufficientCount?: number }} [meta]
 * @returns {string|null}
 */
export function buildCoverageNoticeMessage(followUpQuestions, meta = {}) {
  if (!Array.isArray(followUpQuestions) || followUpQuestions.length === 0) {
    return null;
  }

  const { coverageRatio, insufficientCount } = meta;
  const lines = [];

  // 도입부
  if (typeof insufficientCount === "number" && insufficientCount > 0) {
    const pct =
      typeof coverageRatio === "number"
        ? ` (충족도 ${Math.round(coverageRatio * 100)}%)`
        : "";
    lines.push(
      `📊 **이력서 항목 분석 결과**: ${insufficientCount}개 항목에 대한 업무 기록이 부족합니다${pct}.`
    );
  } else {
    lines.push("📊 **이력서 항목 분석 결과**: 일부 항목에 대한 업무 기록이 부족합니다.");
  }

  lines.push("");
  lines.push("아래 질문에 답하시면 더 풍부한 이력서를 만들 수 있습니다:");

  return lines.join("\n");
}

// ─── 내부 질문 생성 함수 ────────────────────────────────────────────────────────

/**
 * 단일 InsufficientItem에 대한 FollowUpQuestion을 생성한다.
 * 중복 여부는 호출자가 판단해 전달한다.
 *
 * @param {import('./resumeDataSourceCoverage.mjs').InsufficientItem} item
 * @param {{
 *   companyCount: Map<string, number>,
 *   seenSkills: Set<string>,
 *   summaryQuestionDone: boolean,
 * }} context
 * @returns {FollowUpQuestion|null}
 */
function _generateQuestion(item, context) {
  const { section, text, company, severity } = item;

  switch (section) {
    case "experience":
      return _buildExperienceQuestion(item, context);

    case "skills":
      if (context.seenSkills.has(text)) return null;
      return _buildSkillQuestion(item);

    case "projects":
      if (context.seenSkills.has(text)) return null;
      return _buildProjectQuestion(item);

    case "summary":
      if (context.summaryQuestionDone) return null;
      return _buildSummaryQuestion(item);

    default:
      return null;
  }
}

/**
 * 경험(experience) 섹션 불릿에 대한 보충 질문을 생성한다.
 *
 * @param {import('./resumeDataSourceCoverage.mjs').InsufficientItem} item
 * @param {{ companyCount: Map<string, number> }} context
 * @returns {FollowUpQuestion|null}
 */
function _buildExperienceQuestion(item, context) {
  const { text, company, unmatchedTokens = [], severity } = item;

  // 같은 회사에 대해 최대 MAX_QUESTIONS_PER_COMPANY 개까지만 생성
  const count = company ? (context.companyCount.get(company) ?? 0) : 0;
  if (count >= MAX_QUESTIONS_PER_COMPANY) return null;

  const companyLabel = company ? `${company}에서의 ` : "";
  const excerpt = _truncate(text, 50);

  let question;
  if (unmatchedTokens.length > 0) {
    const topToken = unmatchedTokens[0];
    question = `${companyLabel}업무 중 **"${topToken}"** 관련 구체적인 성과나 사례를 알려주세요`;
  } else {
    question = `${companyLabel}**"${excerpt}"** 내용을 뒷받침하는 구체적인 성과나 수치를 알려주세요`;
  }

  return {
    id: `fq-exp-${_hash(text)}`,
    question,
    section: "experience",
    company: company ?? undefined,
    itemText: excerpt,
    severity,
  };
}

/**
 * 스킬(skills) 항목에 대한 보충 질문을 생성한다.
 *
 * @param {import('./resumeDataSourceCoverage.mjs').InsufficientItem} item
 * @returns {FollowUpQuestion}
 */
function _buildSkillQuestion(item) {
  const { text, severity } = item;
  const excerpt = _truncate(text, 30);

  return {
    id: `fq-skill-${_hash(text)}`,
    question: `**"${excerpt}"** 기술을 실제로 활용한 프로젝트나 업무 경험을 구체적으로 설명해주세요`,
    section: "skills",
    itemText: excerpt,
    severity,
  };
}

/**
 * 프로젝트(projects) 항목에 대한 보충 질문을 생성한다.
 *
 * @param {import('./resumeDataSourceCoverage.mjs').InsufficientItem} item
 * @returns {FollowUpQuestion}
 */
function _buildProjectQuestion(item) {
  const { text, unmatchedTokens = [], severity } = item;
  const excerpt = _truncate(text, 50);

  let question;
  if (unmatchedTokens.length > 0) {
    const topToken = unmatchedTokens[0];
    question = `프로젝트에서 **"${topToken}"** 관련 달성한 구체적인 성과나 기여를 알려주세요`;
  } else {
    question = `**"${excerpt}"** 항목에서 달성한 구체적인 성과나 역할을 알려주세요`;
  }

  return {
    id: `fq-proj-${_hash(text)}`,
    question,
    section: "projects",
    itemText: excerpt,
    severity,
  };
}

/**
 * 자기소개(summary) 섹션에 대한 보충 질문을 생성한다.
 *
 * @param {import('./resumeDataSourceCoverage.mjs').InsufficientItem} item
 * @returns {FollowUpQuestion}
 */
function _buildSummaryQuestion(item) {
  const { text, unmatchedTokens = [], severity } = item;

  let question;
  if (unmatchedTokens.length > 0) {
    const topToken = unmatchedTokens[0];
    question = `자기소개의 **"${topToken}"** 역량을 뒷받침하는 대표 프로젝트나 성과를 알려주세요`;
  } else {
    question = `자기소개 내용을 뒷받침하는 구체적인 프로젝트 경험이나 성과를 알려주세요`;
  }

  return {
    id: `fq-summary-${_hash(text)}`,
    question,
    section: "summary",
    itemText: _truncate(text, 40),
    severity,
  };
}

// ─── 유틸리티 ─────────────────────────────────────────────────────────────────

/**
 * 텍스트를 maxLen 이하로 잘라내고 초과 시 "…"을 붙인다.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function _truncate(text, maxLen) {
  if (!text) return "";
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "…";
}

/**
 * 문자열에서 결정론적 짧은 해시를 생성한다.
 * 질문 ID 생성에 사용 (충돌 가능성 있지만 MVP에서는 허용).
 *
 * @param {string} text
 * @returns {string}  — 6자 이내 영소문자+숫자 조합
 */
function _hash(text) {
  if (!text) return "000000";
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 6).padStart(6, "0");
}
