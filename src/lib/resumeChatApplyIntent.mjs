/**
 * resumeChatApplyIntent.mjs
 *
 * 채팅 대화 컨텍스트에서 "반영해줘" 의도를 감지하고,
 * 수정할 이력서 섹션과 변경 내용을 파싱하는 인텐트 핸들러.
 *
 * Sub-AC 5-1 구현
 *
 * ─── 주요 함수 ─────────────────────────────────────────────────────────────────
 *
 *   detectApplyIntent(text)
 *     단일 텍스트에서 "반영해줘" 패턴을 검사한다.
 *     → boolean
 *
 *   extractSectionFromContext(query, parsedQuery, history)
 *     현재 query와 대화 히스토리에서 대상 섹션을 추론한다.
 *     → 'experience'|'skills'|'summary'|'education'|'projects'|null
 *
 *   extractProposedChanges(history)
 *     가장 최근 어시스턴트 메시지에서 이력서에 반영할 변경 내용을 파싱한다.
 *     → ProposedChange[]
 *
 *   parseApplyIntent(query, parsedQuery, history)
 *     전체 파이프라인을 실행하여 구조화된 ApplyIntentResult 를 반환한다.
 *     → ApplyIntentResult
 *
 * ─── 타입 ─────────────────────────────────────────────────────────────────────
 *
 *   ProposedChange — {
 *     type: 'bullet' | 'text' | 'summary',
 *     content: string,          // 반영할 실제 텍스트
 *     context?: string,         // 원본 컨텍스트 (어느 항목에 추가할지 힌트)
 *   }
 *
 *   ApplyIntentResult — {
 *     detected:              boolean,          // apply_section 의도가 감지됐는지
 *     section:               string|null,      // 대상 섹션
 *     changes:               ProposedChange[], // 파싱된 변경 목록
 *     confidence:            number,           // 0.0–1.0 (섹션·변경 추론 신뢰도)
 *     ambiguous:             boolean,          // 섹션이나 변경 내용이 불명확한 경우
 *     clarificationNeeded:   string|null,      // 보충 질문 (ambiguous 일 때)
 *     sourceMessageIndex:    number,           // 근거 어시스턴트 메시지의 history 인덱스 (-1이면 없음)
 *   }
 */

// ── 패턴 상수 ─────────────────────────────────────────────────────────────────

/**
 * "반영해줘" 의도를 나타내는 패턴 목록.
 * frontend/src/lib/resumeQueryParser.js 의 APPLY_SECTION_PATTERNS 와 동기화 유지.
 */
const APPLY_INTENT_PATTERNS = [
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

/**
 * 섹션 감지 패턴 (backend 버전).
 * frontend resumeQueryParser.js 의 SECTION_PATTERNS 와 동기화 유지.
 */
const SECTION_PATTERNS = [
  {
    section: 'experience',
    // /work\s/ : "work " 뒤에 공백이 있어야 match (work-log 같은 프로젝트명 제외)
    patterns: [/경험/, /경력/, /직장/, /회사/, /재직/, /근무/, /업무/, /experience/i, /\bwork\s/i, /직무/],
  },
  {
    section: 'skills',
    patterns: [/기술/, /스킬/, /역량/, /능력/, /tool/, /언어/, /프레임워크/, /skills?/i, /tech/i],
  },
  {
    section: 'summary',
    patterns: [/요약/, /자기소개/, /소개/, /프로필/, /summary/i, /profile/i, /한\s*줄\s*소개/, /직무\s*요약/],
  },
  {
    section: 'education',
    patterns: [/학력/, /교육/, /졸업/, /대학/, /학교/, /education/i, /degree/i],
  },
  {
    section: 'projects',
    patterns: [/프로젝트/, /project/i, /개발/, /구현/, /만든/, /사이드\s*프로젝트/],
  },
  // Sub-AC 8-1: 강점(Strengths) 섹션 — strength_keywords 및 identified-strengths 매핑
  {
    section: 'strengths',
    patterns: [
      /강점/,
      /강점\s*섹션/,
      /행동\s*패턴/,
      /강점\s*분석/,
      /핵심\s*강점/,
      /나의\s*강점/,
      /셀링\s*포인트/,
      /selling\s*point/i,
      /강점\s*키워드/,
      /strength\s*keyword/i,
      /core\s*strength/i,
      /\bstrengths?\b/i,
      /behavioral\s*strength/i,
    ],
  },
];

/**
 * 어시스턴트 응답에서 "이력서 적용 가능한 내용"을 나타내는 패턴.
 * - 번호 목록: "1. ..." / "1) ..."
 * - 불릿 목록: "- ..." / "• ..." / "* ..."
 * - 굵게 강조된 제목 라인: "**제목**"
 * - 코드 블록 없는 일반 텍스트 단락
 */
const BULLET_LINE_PATTERN = /^(?:\s*(?:[-•*]|\d+[.)]\s))\s*(.+)$/;

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 단일 텍스트에서 "반영해줘" 의도 패턴을 검사한다.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectApplyIntent(text) {
  if (!text || typeof text !== 'string') return false;
  return APPLY_INTENT_PATTERNS.some((p) => p.test(text));
}

/**
 * 현재 query, parsedQuery, 그리고 대화 히스토리에서 대상 섹션을 추론한다.
 *
 * 섹션 추론 우선순위:
 *   1. parsedQuery.section (프론트엔드 파서가 이미 추출한 값)
 *   2. 현재 query 텍스트에서 직접 감지
 *   3. 가장 최근 히스토리 메시지들을 역순으로 탐색하여 섹션 언급 찾기
 *
 * @param {string} query
 * @param {{ section?: string|null } | null} parsedQuery
 * @param {{ role: string, content: string }[]} history
 * @returns {'experience'|'skills'|'summary'|'education'|'projects'|'strengths'|null}
 */
export function extractSectionFromContext(query, parsedQuery, history) {
  // 1. parsedQuery 에 이미 섹션이 있으면 그것을 쓴다
  if (parsedQuery?.section) return parsedQuery.section;

  // 2. 현재 query 에서 직접 감지
  const sectionFromQuery = _detectSectionInText(query);
  if (sectionFromQuery) return sectionFromQuery;

  // 3. 히스토리를 역순으로 탐색 (최근 10개 메시지만 검사)
  if (Array.isArray(history) && history.length > 0) {
    const recent = history.slice(-10).reverse();
    for (const msg of recent) {
      const text = typeof msg?.content === 'string' ? msg.content : '';
      const section = _detectSectionInText(text);
      if (section) return section;
    }
  }

  return null;
}

/**
 * 대화 히스토리에서 가장 최근 어시스턴트 메시지를 찾아
 * 이력서에 반영할 변경 내용(불릿/텍스트)을 파싱한다.
 *
 * 파싱 전략:
 *   - 번호·불릿 목록 라인 → type: 'bullet'
 *   - **굵게** 강조된 제목이 있는 단락 → type: 'text'
 *   - 어필 포인트 블록 (## 이력서 어필 포인트) → type: 'bullet'
 *   - 어필 포인트가 없으면 마지막 어시스턴트 메시지 전체를 하나의 'text' 로 반환
 *
 * @param {{ role: string, content: string }[]} history  — 현재 메시지 전송 전 히스토리
 * @returns {{ changes: ProposedChange[], sourceIndex: number }}
 */
export function extractProposedChanges(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return { changes: [], sourceIndex: -1 };
  }

  // 가장 최근 어시스턴트 메시지를 찾는다 (역순 탐색)
  let sourceIndex = -1;
  let sourceContent = '';
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'assistant') {
      sourceIndex = i;
      sourceContent = history[i].content ?? '';
      break;
    }
  }

  if (sourceIndex === -1 || !sourceContent.trim()) {
    return { changes: [], sourceIndex: -1 };
  }

  const changes = _parseProposedChangesFromText(sourceContent);
  return { changes, sourceIndex };
}

/**
 * "반영해줘" 의도 처리 파이프라인 전체를 실행한다.
 *
 * @param {string} query                                    — 현재 사용자 입력
 * @param {{ intent?: string, section?: string|null, keywords?: string[] } | null} parsedQuery  — 프론트엔드 파서 결과
 * @param {{ role: string, content: string }[]} history    — 현재 메시지 전송 전 히스토리
 * @returns {ApplyIntentResult}
 */
export function parseApplyIntent(query, parsedQuery, history) {
  const detected = detectApplyIntent(query) || parsedQuery?.intent === 'apply_section';

  if (!detected) {
    return {
      detected: false,
      section: null,
      changes: [],
      confidence: 0,
      ambiguous: false,
      clarificationNeeded: null,
      sourceMessageIndex: -1,
    };
  }

  // ── 섹션 추론 ────────────────────────────────────────────────────────────────
  const section = extractSectionFromContext(query, parsedQuery, history);

  // ── 변경 내용 파싱 ────────────────────────────────────────────────────────────
  const { changes, sourceIndex } = extractProposedChanges(history);

  // ── 신뢰도 및 모호성 계산 ────────────────────────────────────────────────────
  const { confidence, ambiguous, clarificationNeeded } = _computeConfidence(
    section,
    changes,
    history.length
  );

  return {
    detected: true,
    section,
    changes,
    confidence,
    ambiguous,
    clarificationNeeded,
    sourceMessageIndex: sourceIndex,
  };
}

// ── 내부 유틸 ─────────────────────────────────────────────────────────────────

/**
 * 텍스트에서 대상 섹션 키워드를 감지한다.
 *
 * @param {string} text
 * @returns {'experience'|'skills'|'summary'|'education'|'projects'|'strengths'|null}
 */
function _detectSectionInText(text) {
  if (!text) return null;
  for (const { section, patterns } of SECTION_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return section;
  }
  return null;
}

/**
 * 마크다운 서식을 plain text로 변환한다.
 * - `**bold**` → `bold`
 * - `★★★` 등 별점 제거
 * - `_italic_` → `italic`
 * @param {string} s
 * @returns {string}
 */
function _stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
    .replace(/\*(.+?)\*/g, '$1')       // *italic* → italic
    .replace(/_(.+?)_/g, '$1')         // _italic_ → italic
    .replace(/\s*★{1,3}\s*/g, '')      // ★★★ 제거
    .trim();
}

/**
 * 어시스턴트 응답 텍스트에서 이력서 반영 후보 변경 내용을 추출한다.
 * "보충이 필요한 부분" / "추가로 알려주시면" 섹션은 이력서 불릿이 아니므로 제외한다.
 *
 * @param {string} text
 * @returns {ProposedChange[]}
 */
function _parseProposedChangesFromText(text) {
  if (!text || typeof text !== 'string') return [];

  const changes = [];

  // ── 전처리: 코드 블록 제거 (반영 대상이 아님) ──────────────────────────────
  const withoutCodeBlocks = text.replace(/```[\s\S]*?```/g, '');

  const lines = withoutCodeBlocks.split('\n');

  let inAppealPointsSection = false;
  let inExcludedSection = false;  // "보충이 필요한 부분" / "추가로 알려주시면" 등은 이력서 불릿이 아님
  let currentBulletContext = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) {
      currentBulletContext = null;
      continue;
    }

    // ── "## 이력서 어필 포인트" 블록 진입 감지 ─────────────────────────────────
    if (/^##?\s*(이력서\s*어필\s*포인트|어필\s*포인트|appeal\s*points?)/i.test(line)) {
      inAppealPointsSection = true;
      inExcludedSection = false;
      continue;
    }

    // ── "보충이 필요한 부분" / "추가로 알려주시면" 등은 이력서 불릿이 아니므로 제외 ──
    if (/^#{1,3}\s*(보충|추가로\s*알려|도움이\s*될\s*질문|follow.?up)/i.test(line)) {
      inExcludedSection = true;
      inAppealPointsSection = false;
      continue;
    }

    // ── 다른 섹션 헤더가 나오면 상태 리셋 ───────────────────────────────────────
    if (/^#{1,3}\s+/.test(line)) {
      if (inAppealPointsSection) inAppealPointsSection = false;
      if (inExcludedSection) inExcludedSection = false;
    }

    // ── 제외 섹션 내의 라인은 건너뛴다 ────────────────────────────────────────
    if (inExcludedSection) continue;

    // ── 굵은 제목 (앞뒤 **) → 불릿 컨텍스트로 저장 ────────────────────────────
    const boldTitleMatch = line.match(/^\*\*(.+?)\*\*\s*(?:★{0,3})?$/);
    if (boldTitleMatch) {
      currentBulletContext = boldTitleMatch[1].trim();
      continue;
    }

    // ── 번호 / 불릿 목록 라인 ───────────────────────────────────────────────────
    const bulletMatch = line.match(BULLET_LINE_PATTERN);
    if (bulletMatch) {
      const content = _stripMarkdown(bulletMatch[1].trim());
      if (content.length >= 5) {  // 너무 짧은 라인은 제외
        changes.push({
          type: 'bullet',
          content,
          context: currentBulletContext ?? undefined,
        });
      }
      continue;
    }

    // ── 어필 포인트 섹션에서 번호 패턴 "1. **제목** ★★" ────────────────────────
    if (inAppealPointsSection) {
      // "1. **타이틀** ★★" 형식의 어필 포인트 항목
      const appealMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*/);
      if (appealMatch) {
        const title = appealMatch[1].trim();
        // 다음 들여쓰기 라인이 설명이면 같이 수집
        const nextLine = lines[i + 1]?.trim() ?? '';
        const description = nextLine && !nextLine.match(/^\d+\./) ? nextLine : '';
        changes.push({
          type: 'bullet',
          content: _stripMarkdown(description
            ? `${title}: ${description}`
            : title),
          context: '어필 포인트',
        });
        if (description) i++; // 설명 라인 건너뜀
        continue;
      }
    }
  }

  // 목록에서 아무것도 추출되지 않으면 전체 텍스트를 하나의 'text'로 보관
  if (changes.length === 0) {
    const plainText = text.trim();
    if (plainText.length >= 10) {
      changes.push({ type: 'text', content: plainText });
    }
  }

  return changes;
}

/**
 * 섹션, 변경 목록, 히스토리 길이를 기반으로 신뢰도와 모호성을 계산한다.
 *
 * @param {string|null} section
 * @param {ProposedChange[]} changes
 * @param {number} historyLength
 * @returns {{ confidence: number, ambiguous: boolean, clarificationNeeded: string|null }}
 */
function _computeConfidence(section, changes, historyLength) {
  let confidence = 0.5; // 기본값
  let ambiguous = false;
  let clarificationNeeded = null;

  // 섹션이 감지되면 신뢰도 +0.25
  if (section) confidence += 0.25;
  else ambiguous = true;

  // 변경 내용이 있으면 신뢰도 +0.25
  if (changes.length > 0) confidence += 0.25;
  else ambiguous = true;

  // 히스토리가 있으면 맥락 신뢰도 약간 상승
  if (historyLength >= 2) confidence = Math.min(1.0, confidence + 0.05);

  // 모호한 경우 보충 질문 생성
  if (ambiguous) {
    if (!section && changes.length === 0) {
      clarificationNeeded = '어떤 섹션의 내용을 반영할까요? (예: 경력, 기술, 자기소개, 강점, 프로젝트)';
    } else if (!section) {
      clarificationNeeded = '어떤 섹션에 반영할까요? (예: 경력, 기술, 자기소개, 강점, 프로젝트)';
    } else if (changes.length === 0) {
      clarificationNeeded = '반영할 내용이 대화에 없습니다. 먼저 어필 포인트를 검색하거나 내용을 제안해주세요.';
    }
  }

  return { confidence: Math.min(1.0, confidence), ambiguous, clarificationNeeded };
}
