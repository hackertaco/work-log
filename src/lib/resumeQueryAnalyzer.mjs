/**
 * resumeQueryAnalyzer.mjs
 *
 * 사용자 자유 질의를 받아 의도를 파악하고, 커밋/슬랙/세션 메모리
 * 데이터 소스별로 관련 키워드·기간 등 검색 파라미터를 생성하는
 * 서버 사이드 쿼리 분석 모듈.
 *
 * ─── 설계 원칙 ──────────────────────────────────────────────────────────────
 *
 *   1. 규칙 기반(regex) 파싱을 기본으로 하되, LLM 보강 경로를 선택적으로 제공
 *   2. 프론트엔드 parseResumeQuery와 호환되는 출력 구조
 *   3. 데이터 소스별 독립 검색 파라미터 생성 (같은 키워드라도 소스별로 다르게 가공)
 *   4. 추가 의존성 없이 기존 스택(OpenAI fetch) 유지
 *
 * ─── 출력 구조: AnalyzedQuery ────────────────────────────────────────────────
 *
 *   {
 *     raw:         string,
 *     intent:      'apply_section' | 'search_evidence' | 'refine_section' | 'question' | 'general',
 *     keywords:    string[],
 *     section:     string | null,
 *     dateRange:   { from: string|null, to: string|null } | null,
 *     sourceParams: {
 *       commits:  { keywords: string[], dateRange, maxResults, enabled: boolean },
 *       slack:    { keywords: string[], dateRange, maxResults, enabled: boolean },
 *       sessions: { keywords: string[], dateRange, maxResults, enabled: boolean },
 *     },
 *     confidence:  number,    // 0.0–1.0 — 파싱 결과의 신뢰도
 *     needsClarification: boolean,  // true이면 사용자에게 보충 질문 필요
 *     clarificationHint:  string | null, // 보충 질문 힌트
 *   }
 *
 * ─── 사용 예시 ──────────────────────────────────────────────────────────────
 *
 *   import { analyzeQuery } from './resumeQueryAnalyzer.mjs';
 *
 *   const analyzed = analyzeQuery("작년에 Redis 캐싱 관련 작업 찾아줘");
 *   // → { intent: 'search_evidence', keywords: ['Redis', '캐싱', '작업'],
 *   //     dateRange: { from: '2025-01-01', to: '2025-12-31' },
 *   //     sourceParams: { commits: { keywords: ['Redis', '캐싱', 'cache', 'caching'], ... }, ... } }
 *
 *   // LLM 보강 분석 (선택)
 *   const enhanced = await analyzeQueryWithLLM("성능 최적화 경험을 어필하고 싶어");
 *   // → 더 정교한 키워드 확장 + 신뢰도 점수 포함
 */

// ─── Intent 분류 ────────────────────────────────────────────────────────────────

/**
 * 이력서 반영(apply) 패턴 — 제안된 내용을 이력서에 확정·저장하려는 의도
 */
const APPLY_SECTION_PATTERNS = [
  /반영해\s*줘/, /반영해\s*주세요/, /반영\s*해줘/, /반영\s*해주세요/,
  /이대로\s*반영/, /이걸로\s*반영/, /이\s*내용으로\s*반영/,
  /적용해\s*줘/, /적용해\s*주세요/, /적용\s*해줘/, /이대로\s*적용/,
  /이걸로\s*업데이트/, /이\s*내용으로\s*업데이트/, /이대로\s*업데이트/,
  /이걸\s*이력서에\s*넣/, /이걸\s*이력서에\s*반영/,
  /반영\s*부탁/, /적용\s*부탁/, /그대로\s*반영/, /그대로\s*적용/,
  /apply\s+this/i, /apply\s+it/i, /\bapply\b.*\bresume\b/i,
  /save\s+this/i, /use\s+this/i,
];

/** 증거/이력 검색 패턴 */
const SEARCH_EVIDENCE_PATTERNS = [
  /찾아/, /검색/, /관련.{0,10}내용/, /했던/, /한.{0,5}것/,
  /기록/, /이력/, /언제/, /어디서/, /어떤.{0,5}(작업|업무|프로젝트)/,
  /슬랙.*메시지/, /커밋/, /commit/i, /slack/i,
];

/** 섹션 수정 패턴 */
const REFINE_SECTION_PATTERNS = [
  /수정/, /바꿔/, /고쳐/, /변경/, /추가/, /개선/, /업데이트/,
  /작성/, /보완/, /다듬/, /edit/i, /update/i, /improve/i, /rewrite/i,
];

/** 질문 패턴 */
const QUESTION_PATTERNS = [
  /\?$/, /뭐야/, /뭐에요/, /어때/, /어떤가/, /알려줘/,
  /설명해/, /어떻게/, /왜/, /무슨/,
];

/**
 * 질의 의도를 분류한다.
 *
 * 우선순위: apply_section > refine_section > search_evidence > question > general
 *
 * @param {string} text
 * @returns {'apply_section'|'search_evidence'|'refine_section'|'question'|'general'}
 */
function detectIntent(text) {
  if (APPLY_SECTION_PATTERNS.some((p) => p.test(text))) return "apply_section";
  if (REFINE_SECTION_PATTERNS.some((p) => p.test(text))) return "refine_section";
  if (SEARCH_EVIDENCE_PATTERNS.some((p) => p.test(text))) return "search_evidence";
  if (QUESTION_PATTERNS.some((p) => p.test(text))) return "question";
  return "general";
}

// ── 섹션 감지 ───────────────────────────────────────────────────────────────────

const SECTION_PATTERNS = [
  { section: "summary", patterns: [/요약/, /자기소개/, /소개/, /프로필/, /summary/i, /profile/i] },
  { section: "experience", patterns: [/경험/, /경력/, /직장/, /회사/, /재직/, /근무/, /업무(?!\s*(?:기록|로그|일지|데이터))/, /experience/i, /work/i] },
  { section: "skills", patterns: [/기술/, /스킬/, /역량/, /능력/, /tool/, /언어/, /프레임워크/, /skills?/i, /tech/i] },
  { section: "education", patterns: [/학력/, /교육/, /졸업/, /대학/, /학교/, /education/i, /degree/i] },
  { section: "projects", patterns: [/프로젝트/, /project/i, /개발/, /구현/, /만든/] },
  { section: "strengths", patterns: [/강점/, /행동\s*패턴/, /셀링\s*포인트/, /selling\s*point/i, /core\s*strength/i, /strengths?/i] },
];

/**
 * @param {string} text
 * @returns {string|null}
 */
function detectSection(text) {
  for (const { section, patterns } of SECTION_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return section;
  }
  return null;
}

// ── 날짜 범위 추출 ──────────────────────────────────────────────────────────────

/**
 * 텍스트에서 날짜 범위를 파싱한다.
 * @param {string} text
 * @returns {{ from: string|null, to: string|null }|null}
 */
export function extractDateRange(text) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // 절대 연도: "2024년 3월"
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

  // 상대 시간 패턴
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
  if (/최근\s*(\d+)\s*개?월/.test(text)) {
    const m = text.match(/최근\s*(\d+)\s*개?월/);
    const months = parseInt(m[1], 10);
    const fromDate = new Date(now);
    fromDate.setMonth(fromDate.getMonth() - months);
    return { from: fromDate.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
  }

  return null;
}

// ── 키워드 추출 ─────────────────────────────────────────────────────────────────

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
  "no", "too", "very", "just", "also", "more", "most", "some", "any", "all",
]);

/**
 * 텍스트에서 의미 있는 키워드를 추출한다.
 * @param {string} text
 * @returns {string[]}
 */
export function extractKeywords(text) {
  const keywords = [];

  // 따옴표로 묶인 구문 먼저 추출
  const quotedMatches = text.matchAll(/["'"'](.+?)["'"']/g);
  for (const m of quotedMatches) {
    const phrase = m[1].trim();
    if (phrase.length > 1) keywords.push(phrase);
  }

  const stripped = text.replace(/["'"'].+?["'"']/g, " ");

  // 한글 단어 추출 (2글자 이상, 불용어 제외)
  const koreanWords = stripped.match(/[가-힣]+/g) || [];
  for (const word of koreanWords) {
    if (word.length >= 2 && !KO_STOPWORDS.has(word)) keywords.push(word);
  }

  // 영어/숫자 단어 추출 (2글자 이상, 불용어 제외)
  const englishWords = stripped.match(/[a-zA-Z][a-zA-Z0-9_.-]*/g) || [];
  for (const word of englishWords) {
    if (word.length >= 2 && !EN_STOPWORDS.has(word.toLowerCase())) keywords.push(word);
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

// ── 기술스택 추출 ──────────────────────────────────────────────────────────────

/**
 * 기술스택 사전: 카테고리별로 기술 이름과 별칭을 매핑한다.
 * 키: 정규화된 이름 (canonical), 값: { category, aliases }
 *
 * @type {Array<{ canonical: string, category: string, aliases: string[] }>}
 */
const TECH_STACK_DICTIONARY = [
  // ── Languages ──
  { canonical: "JavaScript",  category: "language",   aliases: ["javascript", "js", "자바스크립트"] },
  { canonical: "TypeScript",  category: "language",   aliases: ["typescript", "ts", "타입스크립트"] },
  { canonical: "Python",      category: "language",   aliases: ["python", "파이썬"] },
  { canonical: "Java",        category: "language",   aliases: ["java", "자바"] },
  { canonical: "Go",          category: "language",   aliases: ["golang", "go lang"] },
  { canonical: "Rust",        category: "language",   aliases: ["rust", "러스트"] },
  { canonical: "C++",         category: "language",   aliases: ["c++", "cpp", "씨플플"] },
  { canonical: "C#",          category: "language",   aliases: ["c#", "csharp", "씨샵"] },
  { canonical: "Kotlin",      category: "language",   aliases: ["kotlin", "코틀린"] },
  { canonical: "Swift",       category: "language",   aliases: ["swift", "스위프트"] },
  { canonical: "Ruby",        category: "language",   aliases: ["ruby", "루비"] },
  { canonical: "PHP",         category: "language",   aliases: ["php"] },
  { canonical: "Scala",       category: "language",   aliases: ["scala", "스칼라"] },
  { canonical: "SQL",         category: "language",   aliases: ["sql"] },
  // ── Frontend Frameworks ──
  { canonical: "React",       category: "framework",  aliases: ["react", "reactjs", "react.js", "리액트"] },
  { canonical: "Preact",      category: "framework",  aliases: ["preact", "프리액트"] },
  { canonical: "Vue",         category: "framework",  aliases: ["vue", "vuejs", "vue.js", "뷰"] },
  { canonical: "Angular",     category: "framework",  aliases: ["angular", "앵귤러"] },
  { canonical: "Svelte",      category: "framework",  aliases: ["svelte", "스벨트"] },
  { canonical: "Next.js",     category: "framework",  aliases: ["next", "nextjs", "next.js", "넥스트"] },
  { canonical: "Nuxt",        category: "framework",  aliases: ["nuxt", "nuxtjs", "nuxt.js"] },
  { canonical: "Tailwind CSS",category: "framework",  aliases: ["tailwind", "tailwindcss", "테일윈드"] },
  // ── Backend Frameworks ──
  { canonical: "Node.js",     category: "framework",  aliases: ["node", "nodejs", "node.js", "노드"] },
  { canonical: "Express",     category: "framework",  aliases: ["express", "expressjs", "익스프레스"] },
  { canonical: "Hono",        category: "framework",  aliases: ["hono", "호노"] },
  { canonical: "FastAPI",     category: "framework",  aliases: ["fastapi", "fast-api"] },
  { canonical: "Django",      category: "framework",  aliases: ["django", "장고"] },
  { canonical: "Spring",      category: "framework",  aliases: ["spring", "springboot", "spring boot", "스프링"] },
  { canonical: "NestJS",      category: "framework",  aliases: ["nestjs", "nest.js", "nest"] },
  // ── Databases ──
  { canonical: "PostgreSQL",  category: "database",   aliases: ["postgresql", "postgres", "pg", "포스트그레스"] },
  { canonical: "MySQL",       category: "database",   aliases: ["mysql", "마이에스큐엘"] },
  { canonical: "MongoDB",     category: "database",   aliases: ["mongodb", "mongo", "몽고"] },
  { canonical: "Redis",       category: "database",   aliases: ["redis", "레디스"] },
  { canonical: "DynamoDB",    category: "database",   aliases: ["dynamodb", "dynamo"] },
  { canonical: "SQLite",      category: "database",   aliases: ["sqlite"] },
  { canonical: "Elasticsearch",category: "database",  aliases: ["elasticsearch", "elastic", "es", "엘라스틱서치"] },
  // ── Infrastructure / DevOps ──
  { canonical: "Docker",      category: "infra",      aliases: ["docker", "도커", "컨테이너", "container"] },
  { canonical: "Kubernetes",  category: "infra",      aliases: ["kubernetes", "k8s", "쿠버네티스"] },
  { canonical: "AWS",         category: "infra",      aliases: ["aws", "amazon web services"] },
  { canonical: "GCP",         category: "infra",      aliases: ["gcp", "google cloud"] },
  { canonical: "Azure",       category: "infra",      aliases: ["azure", "애저"] },
  { canonical: "Vercel",      category: "infra",      aliases: ["vercel", "버셀"] },
  { canonical: "Terraform",   category: "infra",      aliases: ["terraform", "테라폼"] },
  { canonical: "GitHub Actions",category: "infra",    aliases: ["github actions", "github-actions", "gh actions"] },
  { canonical: "Jenkins",     category: "infra",      aliases: ["jenkins", "젠킨스"] },
  { canonical: "Nginx",       category: "infra",      aliases: ["nginx", "엔진엑스"] },
  // ── Tools / Libraries ──
  { canonical: "GraphQL",     category: "tool",       aliases: ["graphql", "gql", "그래프큐엘"] },
  { canonical: "REST API",    category: "tool",       aliases: ["rest", "rest api", "restful"] },
  { canonical: "gRPC",        category: "tool",       aliases: ["grpc"] },
  { canonical: "Kafka",       category: "tool",       aliases: ["kafka", "카프카"] },
  { canonical: "RabbitMQ",    category: "tool",       aliases: ["rabbitmq", "rabbit"] },
  { canonical: "Vite",        category: "tool",       aliases: ["vite", "비트"] },
  { canonical: "Webpack",     category: "tool",       aliases: ["webpack", "웹팩"] },
  { canonical: "Jest",        category: "tool",       aliases: ["jest", "제스트"] },
  { canonical: "Vitest",      category: "tool",       aliases: ["vitest"] },
  { canonical: "Git",         category: "tool",       aliases: ["git", "깃"] },
  { canonical: "OpenAI",      category: "tool",       aliases: ["openai", "gpt", "chatgpt"] },
  { canonical: "LangChain",   category: "tool",       aliases: ["langchain", "랭체인"] },
  { canonical: "Prisma",      category: "tool",       aliases: ["prisma", "프리즈마"] },
  { canonical: "Storybook",   category: "tool",       aliases: ["storybook", "스토리북"] },
];

/**
 * 쿼리 텍스트에서 기술스택을 추출한다.
 *
 * 사전 기반으로 매칭하며, 별칭(alias)을 통해 한국어·영어 약어 모두 인식한다.
 * 결과는 카테고리별로 그룹핑된 정규화 이름 배열을 반환한다.
 *
 * @param {string} text  원본 쿼리 텍스트
 * @returns {{ all: string[], byCategory: Record<string, string[]> }}
 */
export function extractTechStack(text) {
  if (!text) return { all: [], byCategory: {} };

  const lowerText = text.toLowerCase();
  const matched = new Map(); // canonical → category (중복 방지)

  for (const { canonical, category, aliases } of TECH_STACK_DICTIONARY) {
    for (const alias of aliases) {
      // 단어 경계 근사: alias가 2글자 이하면 정확한 단어 매칭,
      // 그 이상이면 부분 문자열 매칭
      if (alias.length <= 2) {
        // 정확한 단어 경계 필요 (예: "go", "js", "pg", "es")
        const wordBoundaryPattern = new RegExp(`(?:^|[\\s,;:.()/\\-])${escapeRegExp(alias)}(?:$|[\\s,;:.()/\\-])`, "i");
        if (wordBoundaryPattern.test(text)) {
          matched.set(canonical, category);
          break;
        }
      } else if (lowerText.includes(alias.toLowerCase())) {
        matched.set(canonical, category);
        break;
      }
    }
  }

  // 카테고리별 그룹핑
  const byCategory = {};
  const all = [];
  for (const [canonical, category] of matched) {
    all.push(canonical);
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push(canonical);
  }

  return { all, byCategory };
}

/**
 * 정규식 특수문자 이스케이프
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── 키워드 확장 (소스별 동의어·변형) ────────────────────────────────────────────

/**
 * 기술 키워드에 대한 소스별 동의어/변형을 제공한다.
 * 커밋 메시지에서 쓰이는 영어 약어와 슬랙에서 쓰이는 한국어 용어를 매핑한다.
 *
 * @type {Record<string, { commits: string[], slack: string[], sessions: string[] }>}
 */
const KEYWORD_EXPANSION_MAP = {
  // 캐싱 관련
  "캐싱":    { commits: ["cache", "caching", "redis", "memcached"],  slack: ["캐시", "캐싱"],  sessions: ["cache", "캐싱", "캐시"] },
  "cache":   { commits: ["cache", "caching", "redis"],               slack: ["캐시", "캐싱", "cache"],  sessions: ["cache", "caching", "캐시"] },
  "redis":   { commits: ["redis", "cache"],                          slack: ["Redis", "레디스", "캐시"],  sessions: ["redis", "Redis"] },
  // 성능 관련
  "성능":    { commits: ["perf", "performance", "optimize", "speed"], slack: ["성능", "속도", "최적화"], sessions: ["performance", "성능", "optimize"] },
  "최적화":  { commits: ["optimize", "perf", "improvement"],         slack: ["최적화", "개선", "성능"], sessions: ["optimize", "최적화"] },
  // 인프라 관련
  "배포":    { commits: ["deploy", "release", "ci", "cd"],           slack: ["배포", "릴리즈", "디플로이"], sessions: ["deploy", "배포"] },
  "CI":      { commits: ["ci", "pipeline", "github-actions"],        slack: ["CI", "파이프라인", "빌드"], sessions: ["CI", "ci", "pipeline"] },
  // API 관련
  "API":     { commits: ["api", "endpoint", "route", "handler"],     slack: ["API", "엔드포인트", "접근"], sessions: ["api", "API", "endpoint"] },
  // 테스트 관련
  "테스트":  { commits: ["test", "spec", "jest", "vitest"],          slack: ["테스트", "QA", "검증"], sessions: ["test", "테스트"] },
  // DB 관련
  "데이터베이스": { commits: ["db", "database", "sql", "migration"], slack: ["DB", "데이터베이스", "마이그레이션"], sessions: ["database", "DB", "데이터베이스"] },
  "DB":      { commits: ["db", "database", "sql", "migration"],      slack: ["DB", "데이터베이스"],  sessions: ["DB", "database"] },
  // 리팩토링 관련
  "리팩토링": { commits: ["refactor", "cleanup", "restructure"],     slack: ["리팩토링", "리팩터링", "정리"], sessions: ["refactor", "리팩토링"] },
  "refactor": { commits: ["refactor", "cleanup", "restructure"],     slack: ["리팩토링", "리팩터링"],  sessions: ["refactor", "리팩토링"] },
};

/**
 * 소스별로 키워드를 확장한다.
 * 원본 키워드에 동의어/변형을 추가하여 검색 재현율을 높인다.
 *
 * @param {string[]} keywords  원본 키워드 목록
 * @param {"commits"|"slack"|"sessions"} source  대상 데이터 소스
 * @returns {string[]}  확장된 키워드 (중복 제거)
 */
export function expandKeywordsForSource(keywords, source) {
  const expanded = new Set();

  for (const kw of keywords) {
    expanded.add(kw);

    // 직접 매핑 확인 (대소문자 무시)
    const lowerKw = kw.toLowerCase();
    for (const [key, expansions] of Object.entries(KEYWORD_EXPANSION_MAP)) {
      if (key.toLowerCase() === lowerKw) {
        for (const exp of expansions[source] ?? []) {
          expanded.add(exp);
        }
        break;
      }
    }
  }

  return [...expanded];
}

// ── 소스별 검색 파라미터 생성 ───────────────────────────────────────────────────

/**
 * @typedef {Object} SourceSearchParams
 * @property {string[]}  keywords    소스에 맞게 확장된 키워드
 * @property {{ from: string|null, to: string|null }|null} dateRange 검색 날짜 범위
 * @property {number}    maxResults  소스별 최대 결과 수
 * @property {boolean}   enabled     이 소스를 검색할지 여부
 */

/**
 * @typedef {Object} AnalyzedQuery
 * @property {string}    raw            원본 입력 (trimmed)
 * @property {'apply_section'|'search_evidence'|'refine_section'|'question'|'general'} intent
 * @property {string[]}  keywords       원본 키워드
 * @property {string|null} section      대상 섹션
 * @property {{ from: string|null, to: string|null }|null} dateRange
 * @property {{ commits: SourceSearchParams, slack: SourceSearchParams, sessions: SourceSearchParams }} sourceParams
 * @property {{ all: string[], byCategory: Record<string, string[]> }} techStack 추출된 기술스택
 * @property {number}    confidence     0.0–1.0 파싱 신뢰도
 * @property {boolean}   needsClarification  보충 질문 필요 여부
 * @property {string|null} clarificationHint 보충 질문 힌트
 */

/** 의도에 따른 기본 소스별 maxResults */
const INTENT_MAX_RESULTS = {
  apply_section:   { commits: 5,  slack: 3,  sessions: 3 },
  search_evidence: { commits: 15, slack: 10, sessions: 10 },
  refine_section:  { commits: 10, slack: 5,  sessions: 5 },
  question:        { commits: 5,  slack: 5,  sessions: 5 },
  general:         { commits: 10, slack: 5,  sessions: 5 },
};

/**
 * 의도(intent)와 키워드 특성에 기반해 소스 활성화 여부를 결정한다.
 *
 * @param {string} intent
 * @param {string[]} keywords
 * @param {string} raw  원본 텍스트
 * @returns {{ commits: boolean, slack: boolean, sessions: boolean }}
 */
function determineSourceEnablement(intent, keywords, raw) {
  // apply_section은 이미 제안된 내용 확정 — 검색 불필요
  if (intent === "apply_section") {
    return { commits: false, slack: false, sessions: false };
  }

  // 키워드가 없으면 일반 질문으로 취급 — 모든 소스 검색 불필요
  if (keywords.length === 0) {
    return { commits: false, slack: false, sessions: false };
  }

  // 특정 소스를 지목한 경우 해당 소스 우선
  const mentionsSlack = /슬랙|slack/i.test(raw);
  const mentionsCommit = /커밋|commit|git/i.test(raw);
  const mentionsSession = /세션|session|ai|claude|codex/i.test(raw);

  // 아무 것도 지목하지 않으면 모든 소스 활성화
  if (!mentionsSlack && !mentionsCommit && !mentionsSession) {
    return { commits: true, slack: true, sessions: true };
  }

  return {
    commits: mentionsCommit || (!mentionsSlack && !mentionsSession),
    slack: mentionsSlack || (!mentionsCommit && !mentionsSession),
    sessions: mentionsSession || (!mentionsCommit && !mentionsSlack),
  };
}

/**
 * 파싱 결과의 신뢰도를 계산한다.
 *
 * 신뢰도가 낮으면 LLM 보강이나 사용자 보충 질문을 권장한다.
 *
 * @param {string} intent
 * @param {string[]} keywords
 * @param {{ from: string|null, to: string|null }|null} dateRange
 * @param {string|null} section
 * @param {{ all: string[] }} [techStack]  추출된 기술스택
 * @returns {number}  0.0–1.0
 */
function computeConfidence(intent, keywords, dateRange, section, techStack) {
  let score = 0;

  // 의도 파악 여부 (general이면 낮음)
  if (intent !== "general") score += 0.3;
  else score += 0.1;

  // 키워드 존재 및 수량
  if (keywords.length >= 3) score += 0.25;
  else if (keywords.length >= 1) score += 0.15;
  // 키워드 0개면 +0

  // 기술스택 감지 — 기술 이름이 명시되면 검색 정밀도가 높아짐
  if (techStack?.all?.length > 0) score += 0.15;

  // 날짜 범위 존재
  if (dateRange) score += 0.15;

  // 섹션 식별
  if (section) score += 0.15;

  return Math.min(score, 1.0);
}

/**
 * 보충 질문이 필요한 경우 힌트를 생성한다.
 *
 * @param {string} intent
 * @param {string[]} keywords
 * @param {{ from: string|null, to: string|null }|null} dateRange
 * @param {string|null} section
 * @returns {{ needsClarification: boolean, hint: string|null }}
 */
function checkClarificationNeeded(intent, keywords, dateRange, section) {
  // apply_section은 이전 대화 맥락에서 처리 — 보충 불필요
  if (intent === "apply_section") {
    return { needsClarification: false, hint: null };
  }

  // 키워드가 없고 의도도 불분명하면 보충 필요
  if (keywords.length === 0 && intent === "general") {
    return {
      needsClarification: true,
      hint: "어떤 기술이나 프로젝트에 대해 이력서에 반영하고 싶으신지 구체적으로 알려주세요.",
    };
  }

  // 날짜 범위 없이 검색 의도 → 최근 90일로 기본 설정하되, 범위 확인 권장
  if (intent === "search_evidence" && !dateRange && keywords.length > 0) {
    return {
      needsClarification: false, // 기본 범위 적용하므로 차단은 안 함
      hint: "날짜 범위가 지정되지 않아 최근 90일 내 기록을 검색합니다.",
    };
  }

  // refine_section인데 섹션이 불명확
  if (intent === "refine_section" && !section) {
    return {
      needsClarification: true,
      hint: "어떤 섹션을 수정하고 싶으신지 알려주세요 (예: 경력, 기술, 자기소개, 프로젝트).",
    };
  }

  return { needsClarification: false, hint: null };
}

// ── 메인 API ─────────────────────────────────────────────────────────────────────

/**
 * 사용자 자유 질의를 분석하여 소스별 검색 파라미터를 생성한다.
 *
 * 규칙 기반(regex) 파싱만 사용하여 동기적으로 즉시 반환한다.
 * LLM이 필요한 경우 analyzeQueryWithLLM()을 사용한다.
 *
 * @param {string} rawInput  사용자 원본 입력
 * @returns {AnalyzedQuery}
 */
export function analyzeQuery(rawInput) {
  const raw = (rawInput || "").trim();

  if (!raw) {
    return {
      raw: "",
      intent: "general",
      keywords: [],
      section: null,
      dateRange: null,
      techStack: { all: [], byCategory: {} },
      sourceParams: {
        commits:  { keywords: [], dateRange: null, maxResults: 10, enabled: false },
        slack:    { keywords: [], dateRange: null, maxResults: 5,  enabled: false },
        sessions: { keywords: [], dateRange: null, maxResults: 5,  enabled: false },
      },
      confidence: 0,
      needsClarification: true,
      clarificationHint: "어떤 기술이나 프로젝트에 대해 이력서에 반영하고 싶으신지 구체적으로 알려주세요.",
    };
  }

  const intent = detectIntent(raw);
  const keywords = extractKeywords(raw);
  const section = detectSection(raw);
  const dateRange = extractDateRange(raw);
  const techStack = extractTechStack(raw);

  const enablement = determineSourceEnablement(intent, keywords, raw);
  const maxResults = INTENT_MAX_RESULTS[intent] ?? INTENT_MAX_RESULTS.general;

  const sourceParams = {
    commits: {
      keywords: enablement.commits ? expandKeywordsForSource(keywords, "commits") : [],
      dateRange,
      maxResults: maxResults.commits,
      enabled: enablement.commits,
    },
    slack: {
      keywords: enablement.slack ? expandKeywordsForSource(keywords, "slack") : [],
      dateRange,
      maxResults: maxResults.slack,
      enabled: enablement.slack,
    },
    sessions: {
      keywords: enablement.sessions ? expandKeywordsForSource(keywords, "sessions") : [],
      dateRange,
      maxResults: maxResults.sessions,
      enabled: enablement.sessions,
    },
  };

  const confidence = computeConfidence(intent, keywords, dateRange, section, techStack);
  const { needsClarification, hint } = checkClarificationNeeded(intent, keywords, dateRange, section);

  return {
    raw,
    intent,
    keywords,
    section,
    dateRange,
    techStack,
    sourceParams,
    confidence,
    needsClarification,
    clarificationHint: hint,
  };
}

// ── LLM 보강 분석 (선택적) ──────────────────────────────────────────────────────

const OPENAI_URL = process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/**
 * LLM을 사용하여 보다 정교한 쿼리 분석을 수행한다.
 *
 * 규칙 기반 파싱 결과를 기반으로 LLM에 키워드 확장, 의도 확인,
 * 보충 질문 생성을 요청한다.
 *
 * 비용/지연 고려 사항:
 *   - LLM 호출은 선택적이며, 규칙 기반 결과의 confidence가 낮을 때만 권장
 *   - effort: "low" + max_output_tokens: 400으로 비용/지연 최소화
 *   - LLM 실패 시 규칙 기반 결과를 그대로 반환 (graceful fallback)
 *
 * @param {string} rawInput  사용자 원본 입력
 * @param {{ apiKey?: string }} [options]
 * @returns {Promise<AnalyzedQuery>}
 */
export async function analyzeQueryWithLLM(rawInput, options = {}) {
  // 먼저 규칙 기반으로 파싱
  const ruleResult = analyzeQuery(rawInput);

  // confidence가 충분히 높으면 LLM 호출 생략
  if (ruleResult.confidence >= 0.7) {
    return ruleResult;
  }

  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return ruleResult;
  }

  try {
    const payload = {
      model: OPENAI_MODEL,
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "query_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              intent: {
                type: "string",
                enum: ["apply_section", "search_evidence", "refine_section", "question", "general"],
              },
              keywords: {
                type: "array",
                items: { type: "string" },
                maxItems: 10,
              },
              commit_keywords: {
                type: "array",
                items: { type: "string" },
                maxItems: 10,
              },
              slack_keywords: {
                type: "array",
                items: { type: "string" },
                maxItems: 10,
              },
              session_keywords: {
                type: "array",
                items: { type: "string" },
                maxItems: 10,
              },
              section: {
                type: ["string", "null"],
              },
              clarification: {
                type: ["string", "null"],
              },
            },
            required: ["intent", "keywords", "commit_keywords", "slack_keywords", "session_keywords", "section", "clarification"],
          },
        },
      },
      max_output_tokens: 400,
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: `You analyze a Korean/English user query about their resume. The user wants to refine their resume using work log data (git commits, Slack messages, AI coding session logs).

Given the user query, extract:
- intent: classify the query intent
- keywords: core search keywords (mixed Korean/English OK)
- commit_keywords: keywords optimized for git commit message search (prefer English technical terms: "cache", "api", "refactor", etc.)
- slack_keywords: keywords optimized for Slack message search (prefer Korean conversational terms)
- session_keywords: keywords for AI coding session search (technical terms used in pair programming)
- section: target resume section if mentioned (experience/skills/summary/education/projects/strengths), null otherwise
- clarification: if the query is too vague to search meaningfully, suggest a follow-up question in Korean. null if the query is clear enough.

Rule-based parse produced: intent=${ruleResult.intent}, keywords=[${ruleResult.keywords.join(",")}], section=${ruleResult.section}`,
          }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: rawInput }],
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
      return ruleResult; // graceful fallback
    }

    const data = await response.json();
    const text = data.output_text || extractOutputText(data);
    if (!text) return ruleResult;

    const parsed = JSON.parse(text);

    // LLM 결과를 규칙 기반 결과와 병합
    const mergedKeywords = deduplicateKeywords([
      ...ruleResult.keywords,
      ...(parsed.keywords ?? []),
    ]);

    const mergedIntent = parsed.intent || ruleResult.intent;
    const mergedSection = parsed.section || ruleResult.section;

    const enablement = determineSourceEnablement(mergedIntent, mergedKeywords, rawInput);
    const maxResults = INTENT_MAX_RESULTS[mergedIntent] ?? INTENT_MAX_RESULTS.general;

    return {
      ...ruleResult,
      intent: mergedIntent,
      keywords: mergedKeywords,
      section: mergedSection,
      techStack: ruleResult.techStack,
      sourceParams: {
        commits: {
          keywords: enablement.commits
            ? deduplicateKeywords([...expandKeywordsForSource(mergedKeywords, "commits"), ...(parsed.commit_keywords ?? [])])
            : [],
          dateRange: ruleResult.dateRange,
          maxResults: maxResults.commits,
          enabled: enablement.commits,
        },
        slack: {
          keywords: enablement.slack
            ? deduplicateKeywords([...expandKeywordsForSource(mergedKeywords, "slack"), ...(parsed.slack_keywords ?? [])])
            : [],
          dateRange: ruleResult.dateRange,
          maxResults: maxResults.slack,
          enabled: enablement.slack,
        },
        sessions: {
          keywords: enablement.sessions
            ? deduplicateKeywords([...expandKeywordsForSource(mergedKeywords, "sessions"), ...(parsed.session_keywords ?? [])])
            : [],
          dateRange: ruleResult.dateRange,
          maxResults: maxResults.sessions,
          enabled: enablement.sessions,
        },
      },
      confidence: Math.min(ruleResult.confidence + 0.2, 1.0),
      needsClarification: !!parsed.clarification,
      clarificationHint: parsed.clarification || ruleResult.clarificationHint,
    };
  } catch {
    // LLM 실패 시 규칙 기반 결과를 그대로 반환
    return ruleResult;
  }
}

// ── 내부 헬퍼 ───────────────────────────────────────────────────────────────────

/**
 * OpenAI Responses API에서 output_text를 추출한다.
 * @param {object} data
 * @returns {string}
 */
function extractOutputText(data) {
  const outputs = data.output || [];
  const texts = [];
  for (const item of outputs) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && part?.text) texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * 키워드 배열의 중복을 제거한다 (대소문자 무시).
 * @param {string[]} keywords
 * @returns {string[]}
 */
function deduplicateKeywords(keywords) {
  const seen = new Set();
  return keywords.filter((kw) => {
    if (!kw) return false;
    const key = kw.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * AnalyzedQuery에서 resumeEvidenceSearch / resumeChatSearch가
 * 기대하는 parsedQuery 형식으로 변환한다.
 *
 * @param {AnalyzedQuery} analyzed
 * @returns {{ raw: string, intent: string, keywords: string[], section: string|null, dateRange: { from: string|null, to: string|null }|null, techStack: { all: string[], byCategory: Record<string, string[]> } }}
 */
export function toSearchQuery(analyzed) {
  return {
    raw: analyzed.raw,
    intent: analyzed.intent,
    keywords: analyzed.keywords,
    section: analyzed.section,
    dateRange: analyzed.dateRange,
    techStack: analyzed.techStack,
  };
}

/**
 * AnalyzedQuery에서 특정 소스용 검색 쿼리를 추출한다.
 * 소스별 확장 키워드가 포함된다.
 *
 * @param {AnalyzedQuery} analyzed
 * @param {"commits"|"slack"|"sessions"} source
 * @returns {{ raw: string, intent: string, keywords: string[], section: string|null, dateRange: { from: string|null, to: string|null }|null }}
 */
export function toSourceSearchQuery(analyzed, source) {
  const params = analyzed.sourceParams[source];
  return {
    raw: analyzed.raw,
    intent: analyzed.intent,
    keywords: params?.keywords ?? analyzed.keywords,
    section: analyzed.section,
    dateRange: params?.dateRange ?? analyzed.dateRange,
  };
}
