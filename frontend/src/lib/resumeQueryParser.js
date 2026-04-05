/**
 * resumeQueryParser.js
 *
 * 사용자의 자유 텍스트 질의를 구조화된 검색 쿼리로 파싱한다.
 *
 * 반환 구조:
 *   raw        — 원본 입력 (trimmed)
 *   intent     — 'apply_section' | 'search_evidence' | 'refine_section' | 'question' | 'general'
 *   keywords   — 검색에 사용할 핵심 키워드 배열
 *   section    — 'experience' | 'skills' | 'summary' | 'education' | 'projects' | null
 *   dateRange  — { from: string|null, to: string|null } | null
 */

// ── Intent 분류 ───────────────────────────────────────────────────────────────

/**
 * 이력서 반영(apply) 패턴 — 대화에서 제안된 내용을 이력서에 직접 적용하려는 의도
 *
 * 주요 패턴:
 *   - "반영해줘" / "반영해주세요" / "이대로 반영해줘"
 *   - "적용해줘" / "적용해주세요"
 *   - "이걸로 바꿔줘" / "이 내용으로 업데이트해줘"
 *   - "이렇게 수정해서 반영해줘"
 *   - "이력서에 넣어줘" / "이력서에 추가해줘" (구체적 반영 컨텍스트)
 *   - "apply" / "apply this"
 *
 * refine_section 과의 차이:
 *   - refine_section: "더 구체적으로 개선해줘" → 아직 제안 단계, LLM이 새 내용 생성
 *   - apply_section:  "반영해줘" → 이미 제안된 내용을 이력서에 확정·저장
 */
const APPLY_SECTION_PATTERNS = [
  /반영해\s*줘/,
  /반영해\s*주세요/,
  /반영\s*해줘/,
  /반영\s*해주세요/,
  /이대로\s*반영/,
  /이걸로\s*반영/,
  /이내용으로\s*반영/,
  /이\s*내용으로\s*반영/,
  /적용해\s*줘/,
  /적용해\s*주세요/,
  /적용\s*해줘/,
  /이대로\s*적용/,
  /이걸로\s*업데이트/,
  /이\s*내용으로\s*업데이트/,
  /이대로\s*업데이트/,
  /이걸\s*이력서에\s*넣/,
  /이걸\s*이력서에\s*반영/,
  /이걸\s*추가해\s*줘/,
  /이\s*내용\s*넣어줘/,
  /이\s*내용\s*추가해줘/,
  /반영\s*부탁/,
  /적용\s*부탁/,
  /그대로\s*반영/,
  /그대로\s*적용/,
  /apply\s+this/i,
  /apply\s+it/i,
  /\bapply\b.*\bresume\b/i,
  /save\s+this/i,
  /use\s+this/i,
];

/** 증거/이력 검색 패턴 */
const SEARCH_EVIDENCE_PATTERNS = [
  /찾아/,
  /검색/,
  /관련.{0,10}내용/,
  /했던/,
  /한.{0,5}것/,
  /기록/,
  /이력/,
  /언제/,
  /어디서/,
  /어떤.{0,5}(작업|업무|프로젝트)/,
  /슬랙.*메시지/,
  /커밋/,
  /commit/i,
  /slack/i,
];

/** 섹션 수정 패턴 */
const REFINE_SECTION_PATTERNS = [
  /수정/,
  /바꿔/,
  /고쳐/,
  /변경/,
  /추가/,
  /개선/,
  /업데이트/,
  /작성/,
  /보완/,
  /다듬/,
  /edit/i,
  /update/i,
  /improve/i,
  /rewrite/i,
];

/** 질문 패턴 */
const QUESTION_PATTERNS = [
  /\?$/,
  /뭐야/,
  /뭐에요/,
  /어때/,
  /어떤가/,
  /알려줘/,
  /설명해/,
  /어떻게/,
  /왜/,
  /무슨/,
];

/**
 * 질의 의도를 분류한다.
 *
 * 우선순위:
 *   1. apply_section  — "반영해줘"처럼 이미 제안된 내용을 확정·저장하는 의도 (가장 구체적)
 *   2. refine_section — 섹션을 개선·수정하는 의도
 *   3. search_evidence — 증거/이력을 검색하는 의도
 *   4. question       — 질문
 *   5. general        — 기타
 *
 * @param {string} text
 * @returns {'apply_section'|'search_evidence'|'refine_section'|'question'|'general'}
 */
function detectIntent(text) {
  // apply_section 을 가장 먼저 검사: "반영해줘"는 refine_section 패턴("고쳐")과 겹칠 수 있다
  if (APPLY_SECTION_PATTERNS.some((p) => p.test(text))) {
    return 'apply_section';
  }
  // search_evidence 를 refine_section 보다 먼저 검사:
  // "찾아줘"가 있으면 검색 의도가 우선 ("안정성 개선 어필 포인트를 찾아줘"에서 "개선"이 refine에 매칭되는 문제 방지)
  if (SEARCH_EVIDENCE_PATTERNS.some((p) => p.test(text))) {
    return 'search_evidence';
  }
  if (REFINE_SECTION_PATTERNS.some((p) => p.test(text))) {
    return 'refine_section';
  }
  if (QUESTION_PATTERNS.some((p) => p.test(text))) {
    return 'question';
  }
  return 'general';
}

// ── 섹션 감지 ──────────────────────────────────────────────────────────────────

const SECTION_PATTERNS = [
  { section: 'experience', patterns: [/경험/, /경력/, /직장/, /회사/, /재직/, /근무/, /업무/, /experience/i, /work/i] },
  { section: 'skills', patterns: [/기술/, /스킬/, /역량/, /능력/, /tool/, /언어/, /프레임워크/, /skills?/i, /tech/i] },
  { section: 'summary', patterns: [/요약/, /자기소개/, /소개/, /프로필/, /summary/i, /profile/i] },
  { section: 'education', patterns: [/학력/, /교육/, /졸업/, /대학/, /학교/, /education/i, /degree/i] },
  { section: 'projects', patterns: [/프로젝트/, /project/i, /개발/, /구현/, /만든/] },
  // Sub-AC 8-1: 강점(Strengths) 섹션 — strength_keywords 및 identified-strengths 매핑
  { section: 'strengths', patterns: [/강점/, /강점\s*섹션/, /행동\s*패턴/, /강점\s*분석/, /핵심\s*강점/, /나의\s*강점/, /셀링\s*포인트/, /selling\s*point/i, /강점\s*키워드/, /strength\s*keyword/i, /core\s*strength/i, /strengths?/i, /behavioral\s*strength/i] },
];

/**
 * 질의에서 대상 섹션을 추출한다.
 * @param {string} text
 * @returns {'experience'|'skills'|'summary'|'education'|'projects'|'strengths'|null}
 */
function detectSection(text) {
  for (const { section, patterns } of SECTION_PATTERNS) {
    if (patterns.some((p) => p.test(text))) {
      return section;
    }
  }
  return null;
}

// ── 날짜 범위 추출 ─────────────────────────────────────────────────────────────

/**
 * 연도 및 월 패턴을 파싱하여 날짜 범위를 반환한다.
 * 예: "2024년 3월", "작년", "지난달", "올해"
 * @param {string} text
 * @returns {{ from: string|null, to: string|null }|null}
 */
function extractDateRange(text) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // 절대 연도 패턴: "2023년", "2024년"
  const yearMatch = text.match(/(\d{4})년/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    // 월 패턴 함께 있으면 해당 월만
    const monthMatch = text.match(/(\d{1,2})월/);
    if (monthMatch) {
      const month = monthMatch[1].padStart(2, '0');
      return { from: `${year}-${month}-01`, to: `${year}-${month}-31` };
    }
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  // 상대 시간 패턴
  if (/올해/.test(text)) {
    return { from: `${currentYear}-01-01`, to: `${currentYear}-12-31` };
  }
  if (/작년/.test(text)) {
    return { from: `${currentYear - 1}-01-01`, to: `${currentYear - 1}-12-31` };
  }
  if (/지난달/.test(text)) {
    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    return {
      from: `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-01`,
      to: `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-31`,
    };
  }
  if (/이번달|이달/.test(text)) {
    return {
      from: `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`,
      to: `${currentYear}-${String(currentMonth).padStart(2, '0')}-31`,
    };
  }
  if (/최근\s*(\d+)\s*개?월/.test(text)) {
    const monthsMatch = text.match(/최근\s*(\d+)\s*개?월/);
    const months = parseInt(monthsMatch[1], 10);
    const fromDate = new Date(now);
    fromDate.setMonth(fromDate.getMonth() - months);
    return {
      from: fromDate.toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
    };
  }

  return null;
}

// ── 키워드 추출 ───────────────────────────────────────────────────────────────

/** 한국어 불용어 (검색 키워드에서 제외) */
const KO_STOPWORDS = new Set([
  '에', '에서', '을', '를', '이', '가', '은', '는', '의', '와', '과', '도', '로',
  '으로', '에게', '한', '하다', '있다', '없다', '하고', '그리고', '하지만', '또는',
  '관련', '대한', '대해', '내용', '것', '수', '때', '등', '또', '및', '그', '이런',
  '저런', '어떤', '뭔가', '조금', '더', '좀', '그냥', '잠깐', '정말', '매우', '너무',
  '아주', '다시', '계속', '항상', '혹시', '제발', '좋은', '나쁜', '해줘', '해주세요',
  '알려줘', '알려주세요', '찾아줘', '찾아주세요', '보여줘', '보여주세요',
]);

/** 영어 불용어 */
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'i', 'me', 'my', 'we', 'you', 'he', 'she', 'it', 'they', 'them',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'how', 'when', 'where',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'not',
  'no', 'nor', 'too', 'very', 'just', 'also', 'more', 'most', 'some', 'any', 'all',
]);

/**
 * 텍스트에서 의미 있는 키워드를 추출한다.
 * - 한글/영어 단어를 분리하고 불용어·단음절을 제거한다.
 * - 따옴표로 묶인 구문은 하나의 키워드로 처리한다.
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  const keywords = [];

  // 따옴표로 묶인 구문 먼저 추출
  const quotedMatches = text.matchAll(/["'"'](.+?)["'"']/g);
  for (const m of quotedMatches) {
    const phrase = m[1].trim();
    if (phrase.length > 1) keywords.push(phrase);
  }

  // 따옴표 구문 제거 후 나머지 처리
  const stripped = text.replace(/["'"'].+?["'"']/g, ' ');

  // 한글 단어 추출 (2글자 이상, 불용어 제외)
  const koreanWords = stripped.match(/[가-힣]+/g) || [];
  for (const word of koreanWords) {
    if (word.length >= 2 && !KO_STOPWORDS.has(word)) {
      keywords.push(word);
    }
  }

  // 영어/숫자 단어 추출 (2글자 이상, 불용어 제외)
  const englishWords = stripped.match(/[a-zA-Z][a-zA-Z0-9_-]*/g) || [];
  for (const word of englishWords) {
    const lower = word.toLowerCase();
    if (word.length >= 2 && !EN_STOPWORDS.has(lower)) {
      keywords.push(word);
    }
  }

  // 중복 제거 (대소문자 구분 없이)
  const seen = new Set();
  return keywords.filter((kw) => {
    const key = kw.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 메인 파서 ─────────────────────────────────────────────────────────────────

/**
 * 사용자 자유 텍스트 질의를 구조화된 검색 쿼리로 파싱한다.
 *
 * @param {string} rawInput — 사용자가 입력한 원본 텍스트
 * @returns {{
 *   raw: string,
 *   intent: 'apply_section'|'search_evidence'|'refine_section'|'question'|'general',
 *   keywords: string[],
 *   section: 'experience'|'skills'|'summary'|'education'|'projects'|'strengths'|null,
 *   dateRange: { from: string|null, to: string|null }|null,
 * }}
 */
export function parseResumeQuery(rawInput) {
  const raw = (rawInput || '').trim();

  if (!raw) {
    return { raw: '', intent: 'general', keywords: [], section: null, dateRange: null };
  }

  return {
    raw,
    intent: detectIntent(raw),
    keywords: extractKeywords(raw),
    section: detectSection(raw),
    dateRange: extractDateRange(raw),
  };
}

/**
 * 파싱된 쿼리가 비어 있거나 유효하지 않은지 확인한다.
 * @param {ReturnType<typeof parseResumeQuery>} parsed
 * @returns {boolean}
 */
export function isQueryEmpty(parsed) {
  return !parsed || !parsed.raw || parsed.raw.length === 0;
}

/**
 * 파싱된 쿼리를 사람이 읽을 수 있는 형태로 요약한다 (디버그/표시용).
 * @param {ReturnType<typeof parseResumeQuery>} parsed
 * @returns {string}
 */
export function summarizeParsedQuery(parsed) {
  if (!parsed || !parsed.raw) return '';
  const parts = [];
  if (parsed.section) {
    const labels = {
      experience: '경험/경력',
      skills: '기술',
      summary: '자기소개',
      education: '학력',
      projects: '프로젝트',
      strengths: '강점',
    };
    parts.push(`섹션: ${labels[parsed.section] || parsed.section}`);
  }
  if (parsed.keywords.length > 0) {
    parts.push(`키워드: ${parsed.keywords.slice(0, 5).join(', ')}`);
  }
  if (parsed.dateRange) {
    const { from, to } = parsed.dateRange;
    if (from && to) parts.push(`기간: ${from} ~ ${to}`);
  }
  return parts.join(' · ');
}
