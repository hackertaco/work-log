/**
 * resumeChatCitations.mjs
 *
 * 채팅 응답에 첨부할 출처 정보(citations)를 구성하는 유틸리티 모듈.
 *
 * 데이터 소스 조회 결과(ChatEvidenceResult, RankedEvidenceRecord[])에서
 * 프론트엔드가 즉시 렌더링할 수 있는 정규화된 ChatCitation[] 배열을 생성한다.
 *
 * ─── 주요 함수 ─────────────────────────────────────────────────────────────────
 *
 *   buildChatCitations(rankedEvidence, appealPoints?)
 *     랭킹된 근거 목록과 어필 포인트의 sourceRefs를 병합하여
 *     중복 제거된 ChatCitation[] 배열을 반환한다.
 *
 *   buildCitationFromEvidence(record)
 *     단일 ChatEvidenceRecord / RankedEvidenceRecord를 ChatCitation으로 변환한다.
 *
 *   buildCitationsFromEvidenceResult(evidenceResult)
 *     ChatEvidenceResult (searchAllSources 출력)를 직접 ChatCitation[]으로 변환한다.
 *
 *   buildSourceSummary(citations)
 *     ChatCitation[]에서 소스별 건수 요약 객체를 생성한다.
 *
 * ─── ChatCitation 타입 ─────────────────────────────────────────────────────────
 *
 *   {
 *     id:          string,       // 고유 식별자 (source-date-hash/ts/index 기반)
 *     source:      'commits' | 'slack' | 'session',
 *     date:        string,       // YYYY-MM-DD
 *     text:        string,       // 출처 텍스트 스니펫 (최대 200자)
 *     rank:        number,       // 관련도 순위 (1-based, 0 = unranked)
 *     relevance:   number,       // 0.0–1.0 관련도 점수
 *     provenance:  CommitProvenance | SlackProvenance | SessionProvenance,
 *     // 소스별 편의 필드 (프론트엔드 렌더링용)
 *     repo?:        string,      // commits only
 *     hash?:        string,      // commits only (short hash)
 *     channelId?:   string,      // slack only
 *     permalink?:   string,      // slack only
 *     sessionType?: string,      // session only (codex/claude/aiReview)
 *   }
 *
 * No I/O — 순수 변환 함수만 포함.
 */

// ─── 상수 ────────────────────────────────────────────────────────────────────

/** 스니펫 최대 길이 (바이트가 아닌 문자 수) */
const SNIPPET_MAX_LENGTH = 200;

/** 반환 최대 citation 수 */
const DEFAULT_MAX_CITATIONS = 20;

// ─── Public types (JSDoc) ────────────────────────────────────────────────────

/**
 * @typedef {Object} ChatCitation
 * @property {string}  id          Stable identifier for deduplication and keying
 * @property {"commits"|"slack"|"session"} source  Data source discriminator
 * @property {string}  date        YYYY-MM-DD work-log date
 * @property {string}  text        Source text snippet (max 200 chars)
 * @property {number}  rank        1-based relevance rank (0 = unranked)
 * @property {number}  relevance   0.0–1.0 relevance score
 * @property {import('./resumeTypes.mjs').CommitProvenance|import('./resumeTypes.mjs').SlackProvenance|import('./resumeTypes.mjs').SessionProvenance} provenance
 *   Full source-specific metadata for deep linking
 * @property {string}  [repo]        Repository name (commits only)
 * @property {string}  [hash]        Short commit hash (commits only)
 * @property {string}  [channelId]   Slack channel ID (slack only)
 * @property {string}  [permalink]   Slack permalink URL (slack only)
 * @property {string}  [sessionType] Session tool type (session only)
 */

/**
 * @typedef {Object} CitationSourceSummary
 * @property {number} commits   Number of commit citations
 * @property {number} slack     Number of Slack citations
 * @property {number} sessions  Number of session citations
 * @property {number} total     Total citation count
 * @property {string[]} repos   Unique repository names from commit citations
 * @property {string[]} dateRange  [earliest, latest] YYYY-MM-DD (1 or 2 elements)
 */

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * 랭킹된 근거 목록과 (선택적) 어필 포인트의 sourceRefs를 병합하여
 * 프론트엔드 렌더링에 최적화된 ChatCitation[] 배열을 반환한다.
 *
 * 병합 전략:
 *   1. rankedEvidence의 모든 레코드를 ChatCitation으로 변환
 *   2. appealPoints의 sourceRefs에서 rankedEvidence에 없는 레코드 추가
 *   3. (source, date, text) 기준으로 중복 제거
 *   4. rank 오름차순 정렬 (unranked는 뒤로)
 *
 * @param {Array<object>} rankedEvidence  mergeAndRankEvidence() 출력 (RankedEvidenceRecord[])
 * @param {object|null} [appealPointsResult]  generateAppealPoints() 출력 (AppealPointsResult)
 * @param {{ maxCitations?: number }} [options]
 * @returns {ChatCitation[]}
 */
export function buildChatCitations(rankedEvidence, appealPointsResult = null, options = {}) {
  const maxCitations = options.maxCitations ?? DEFAULT_MAX_CITATIONS;
  const seen = new Set();
  const citations = [];

  // 1. rankedEvidence → ChatCitation
  if (Array.isArray(rankedEvidence)) {
    for (const record of rankedEvidence) {
      const citation = buildCitationFromEvidence(record);
      if (!citation) continue;

      const dedup = _dedupKey(citation);
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      citations.push(citation);
    }
  }

  // 2. appealPoints.sourceRefs → 추가 ChatCitation (중복 제거)
  if (appealPointsResult && Array.isArray(appealPointsResult.appealPoints)) {
    for (const ap of appealPointsResult.appealPoints) {
      if (!Array.isArray(ap.sourceRefs)) continue;
      for (const ref of ap.sourceRefs) {
        const citation = buildCitationFromEvidence(ref);
        if (!citation) continue;

        const dedup = _dedupKey(citation);
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        citations.push(citation);
      }
    }
  }

  // 3. rank 오름차순 정렬 (unranked=0 은 뒤로)
  citations.sort((a, b) => {
    if (a.rank === 0 && b.rank !== 0) return 1;
    if (a.rank !== 0 && b.rank === 0) return -1;
    return a.rank - b.rank;
  });

  return citations.slice(0, maxCitations);
}

/**
 * 단일 evidence record (ChatEvidenceRecord / RankedEvidenceRecord / SourceRef)를
 * ChatCitation 형태로 정규화한다.
 *
 * provenance 필드에서 소스별 편의 필드를 추출하여 최상위에 배치한다.
 * 프론트엔드에서 provenance 내부를 직접 파고들 필요 없이 바로 사용할 수 있다.
 *
 * @param {object} record  Evidence record (any variant)
 * @returns {ChatCitation|null}  null if record is invalid
 */
export function buildCitationFromEvidence(record) {
  if (!record || typeof record !== "object") return null;

  const source = _normalizeSource(record.source);
  if (!source) return null;

  const date = typeof record.date === "string" ? record.date : "";
  const rawText = typeof record.text === "string" ? record.text : "";
  const text = rawText.length > SNIPPET_MAX_LENGTH
    ? rawText.slice(0, SNIPPET_MAX_LENGTH - 1) + "…"
    : rawText;

  const rank = typeof record.rank === "number" ? record.rank : 0;
  const relevance = _computeRelevance(record);
  const provenance = record.provenance ?? null;

  const id = _buildCitationId(source, date, record);

  /** @type {ChatCitation} */
  const citation = {
    id,
    source,
    date,
    text,
    rank,
    relevance,
    provenance,
  };

  // 소스별 편의 필드 추출
  if (source === "commits" && provenance) {
    if (provenance.repo) citation.repo = provenance.repo;
    if (provenance.commitHash) citation.hash = provenance.commitHash;
  } else if (source === "slack" && provenance) {
    if (provenance.channelId) citation.channelId = provenance.channelId;
    if (provenance.permalink) citation.permalink = provenance.permalink;
  } else if (source === "session" && provenance) {
    if (provenance.sessionType) citation.sessionType = provenance.sessionType;
  }

  return citation;
}

/**
 * ChatEvidenceResult (searchAllSources 출력)를 직접 ChatCitation[]으로 변환한다.
 * mergeAndRankEvidence를 거치지 않은 raw evidence를 직접 변환할 때 사용한다.
 *
 * @param {import('./resumeTypes.mjs').ChatEvidenceResult|null} evidenceResult
 * @param {{ maxCitations?: number }} [options]
 * @returns {ChatCitation[]}
 */
export function buildCitationsFromEvidenceResult(evidenceResult, options = {}) {
  if (!evidenceResult) return [];
  const maxCitations = options.maxCitations ?? DEFAULT_MAX_CITATIONS;

  const all = [
    ...(evidenceResult.commits ?? []),
    ...(evidenceResult.slack ?? []),
    ...(evidenceResult.sessions ?? []),
  ];

  // relevanceScore 내림차순 → 날짜 내림차순 정렬
  all.sort((a, b) =>
    (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0) ||
    (b.date ?? "").localeCompare(a.date ?? "")
  );

  const seen = new Set();
  const citations = [];

  for (const record of all) {
    const citation = buildCitationFromEvidence(record);
    if (!citation) continue;

    const dedup = _dedupKey(citation);
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    citations.push(citation);

    if (citations.length >= maxCitations) break;
  }

  return citations;
}

/**
 * ChatCitation[]에서 소스별 건수 요약 객체를 생성한다.
 *
 * @param {ChatCitation[]} citations
 * @returns {CitationSourceSummary}
 */
export function buildSourceSummary(citations) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return { commits: 0, slack: 0, sessions: 0, total: 0, repos: [], dateRange: [] };
  }

  let commits = 0;
  let slack = 0;
  let sessions = 0;
  const repoSet = new Set();
  const dates = [];

  for (const c of citations) {
    if (c.source === "commits") {
      commits++;
      if (c.repo) repoSet.add(c.repo);
    } else if (c.source === "slack") {
      slack++;
    } else if (c.source === "session") {
      sessions++;
    }
    if (c.date) dates.push(c.date);
  }

  dates.sort();
  const dateRange = dates.length === 0
    ? []
    : dates.length === 1 || dates[0] === dates[dates.length - 1]
      ? [dates[0]]
      : [dates[0], dates[dates.length - 1]];

  return {
    commits,
    slack,
    sessions,
    total: citations.length,
    repos: [...repoSet],
    dateRange,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * source 문자열을 정규화한다.
 * "sessions" → "session" (단수형 통일)
 *
 * @param {string} source
 * @returns {"commits"|"slack"|"session"|null}
 */
function _normalizeSource(source) {
  if (source === "commits") return "commits";
  if (source === "slack") return "slack";
  if (source === "session" || source === "sessions") return "session";
  return null;
}

/**
 * 중복 제거용 키를 생성한다.
 *
 * @param {ChatCitation} citation
 * @returns {string}
 */
function _dedupKey(citation) {
  return `${citation.source}::${citation.date}::${citation.text}`;
}

/**
 * record에서 0.0–1.0 범위의 관련도 점수를 추출한다.
 *
 * - rankScore (mergeAndRankEvidence 출력): 이미 정규화되어 있지 않으므로 0.0–1.0 으로 clamping
 * - relevanceScore (searchAllSources 출력): 키워드 매칭 횟수이므로 정규화 필요
 * - relevance: 이미 0.0–1.0 범위
 *
 * @param {object} record
 * @returns {number}
 */
function _computeRelevance(record) {
  // 이미 정규화된 relevance 필드 우선
  if (typeof record.relevance === "number") {
    return Math.max(0, Math.min(1, record.relevance));
  }
  // rankScore: mergeAndRankEvidence 출력 — 상대적이므로 0.5 기본
  if (typeof record.rankScore === "number") {
    // rankScore는 가중합이므로 직접적인 0–1 변환은 불가. 상대적 지표로 0.5–1.0 범위 매핑
    return Math.max(0, Math.min(1, 0.5 + record.rankScore * 0.1));
  }
  // relevanceScore: 키워드 매칭 횟수 기반. 1 이상이면 0.5+ 로 매핑
  if (typeof record.relevanceScore === "number") {
    if (record.relevanceScore <= 0) return 0;
    return Math.min(1, 0.4 + record.relevanceScore * 0.2);
  }
  return 0;
}

/**
 * citation의 안정적 ID를 생성한다.
 * 소스별 고유 식별자를 활용하여 같은 레코드는 같은 ID를 갖도록 한다.
 *
 * @param {"commits"|"slack"|"session"} source
 * @param {string} date
 * @param {object} record
 * @returns {string}
 */
function _buildCitationId(source, date, record) {
  const prov = record.provenance;

  if (source === "commits" && prov?.commitHash) {
    return `cite-commit-${date}-${prov.commitHash}`;
  }
  if (source === "slack" && prov?.messageId) {
    return `cite-slack-${date}-${prov.messageId}`;
  }
  if (source === "session" && prov?.sessionType) {
    const suffix = prov.filePath
      ? prov.filePath.replace(/[^a-zA-Z0-9]/g, "").slice(-12)
      : (record.text ?? "").slice(0, 20).replace(/[^a-zA-Z0-9가-힣]/g, "");
    return `cite-session-${date}-${prov.sessionType}-${suffix}`;
  }

  // 폴백: 텍스트 해시 기반
  const textHash = (record.text ?? "")
    .slice(0, 40)
    .replace(/[^a-zA-Z0-9가-힣]/g, "");
  return `cite-${source}-${date}-${textHash}`;
}
