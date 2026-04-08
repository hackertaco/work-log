import { useState, useRef, useEffect } from 'preact/hooks';

/**
 * InlineSourceBadge — 채팅 메시지 텍스트 내 인라인 출처 배지 컴포넌트
 *
 * 어시스턴트 응답 본문에서 근거 출처를 참조하는 마커(«cite:N»)가 있을 때,
 * 해당 위치에 작은 배지 형태로 출처 정보를 표시한다.
 *
 * Props:
 *   citation  — ChatCitation  출처 객체 (resumeChatCitations.mjs 의 ChatCitation)
 *   index     — number        1-based 인용 번호 (표시 순서)
 *
 * 동작:
 *   - 기본: 소스 아이콘 + 번호만 표시하는 작은 인라인 배지
 *   - 클릭(또는 호버): 팝오버로 상세 출처 정보 표시 (날짜, 텍스트 스니펫, 링크)
 *   - 키보드 포커스: Tab으로 배지에 도달하면 팝오버 표시
 *   - 슬랙 출처에 permalink가 있으면 외부 링크 제공
 *   - 커밋 출처에 hash가 있으면 해시 코드 표시
 *   - matchedKeywords가 있으면 팝오버에 키워드 태그 표시
 */
export function InlineSourceBadge({ citation, index }) {
  const [showPopover, setShowPopover] = useState(false);
  const rootRef = useRef(null);
  const popoverRef = useRef(null);

  if (!citation) return null;

  const { source } = citation;
  const badgeClass = `isb-badge isb-badge--${source === 'commits' ? 'commit' : source === 'slack' ? 'slack' : 'session'}`;
  const icon = source === 'commits' ? '⌥' : source === 'slack' ? '#' : '🤖';
  const label = source === 'commits' ? '커밋' : source === 'slack' ? '슬랙' : '세션';

  // 팝오버가 화면 밖으로 벗어나지 않도록 위치 보정
  useEffect(() => {
    if (!showPopover || !popoverRef.current || !rootRef.current) return;
    const popEl = popoverRef.current;
    const rect = popEl.getBoundingClientRect();
    // 좌측 잘림
    if (rect.left < 8) {
      popEl.style.left = '0';
      popEl.style.transform = 'translateX(0)';
    }
    // 우측 잘림
    if (rect.right > window.innerWidth - 8) {
      popEl.style.left = 'auto';
      popEl.style.right = '0';
      popEl.style.transform = 'translateX(0)';
    }
    // 상단 잘림 → 팝오버를 아래에 표시
    if (rect.top < 8) {
      popEl.style.bottom = 'auto';
      popEl.style.top = 'calc(100% + 6px)';
    }
  }, [showPopover]);

  return (
    <span
      class="isb-root"
      ref={rootRef}
      onMouseEnter={() => setShowPopover(true)}
      onMouseLeave={() => setShowPopover(false)}
    >
      <button
        class={badgeClass}
        type="button"
        aria-label={`출처 ${index}: ${label}`}
        aria-expanded={showPopover}
        aria-haspopup="true"
        onClick={(e) => {
          e.stopPropagation();
          setShowPopover((v) => !v);
        }}
        onFocus={() => setShowPopover(true)}
        onBlur={() => setShowPopover(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setShowPopover(false);
            e.stopPropagation();
          }
        }}
      >
        <span class="isb-icon" aria-hidden="true">{icon}</span>
        <span class="isb-num">{index}</span>
      </button>

      {showPopover && (
        <CitationPopover popoverRef={popoverRef} citation={citation} index={index} />
      )}

      <style>{ISB_CSS}</style>
    </span>
  );
}

/**
 * parseInlineCitations — 메시지 본문에서 인라인 citation 마커를 파싱한다.
 *
 * 마커 형식: «cite:N» (N은 1-based 인덱스, citations 배열 매핑)
 *
 * @param {string} content  메시지 본문 텍스트
 * @param {Array} citations  ChatCitation[] 배열
 * @returns {Array<{ type: 'text', value: string } | { type: 'cite', index: number, citation: object }>}
 *   텍스트와 인라인 citation 조각으로 분할된 배열
 */
export function parseInlineCitations(content, citations) {
  if (!content || !Array.isArray(citations) || citations.length === 0) {
    return [{ type: 'text', value: content || '' }];
  }

  const parts = [];
  // «cite:N» 또는 [cite:N] 형식 매칭
  const pattern = /(?:«cite:(\d+)»|\[cite:(\d+)\])/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    // 마커 앞의 텍스트
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }

    const idx = parseInt(match[1] ?? match[2], 10);
    const citation = idx >= 1 && idx <= citations.length ? citations[idx - 1] : null;

    if (citation) {
      parts.push({ type: 'cite', index: idx, citation });
    } else {
      // 유효하지 않은 인덱스는 텍스트로 유지
      parts.push({ type: 'text', value: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  // 마지막 남은 텍스트
  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: content }];
}

/* ── 팝오버 ─────────────────────────────────────────────────────────────────── */

/**
 * CitationPopover — 인라인 출처 배지 클릭/호버 시 표시되는 상세 팝오버
 *
 * 표시 정보:
 *   - 소스 유형 아이콘 + 레이블 + 날짜
 *   - 소스별 메타데이터 (커밋 해시, 슬랙 채널/링크, 세션 유형)
 *   - matchedKeywords: 검색 키워드 매칭 태그 (하이라이트)
 *   - 텍스트 스니펫 (접기/펼치기 가능)
 *   - 관련도(relevance) 바
 *   - rankScore가 있을 경우 순위 점수 표시
 *   - 스니펫 복사 버튼
 *
 * Sub-AC 3 개선:
 *   - 120자 이상 텍스트의 펼치기/접기 토글
 *   - 스니펫 클립보드 복사 버튼
 *   - 호버 시 SourceCitations 내 해당 항목 하이라이트 (CSS 클래스 연동)
 *   - 접근성: role="dialog" (인터랙티브 요소 포함)
 */
function CitationPopover({ citation, index, popoverRef }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const { source, date, text, hash, repo, channelId, permalink,
    sessionType, sessionSource, matchedKeywords, rankScore, score } = citation;

  // sessionSource / sessionType 양쪽 호환
  const resolvedSessionType = sessionType || sessionSource || null;
  const sourceLabel = source === 'commits' ? '커밋' : source === 'slack' ? '슬랙' : '세션';
  const isLong = text && text.length > 120;
  const displayText = expanded || !isLong ? text : text.slice(0, 120) + '…';
  const keywords = Array.isArray(matchedKeywords) ? matchedKeywords : [];
  // relevance: citation.relevance 또는 score 또는 rankScore (0~1 범위)
  const relevance = typeof citation.relevance === 'number' ? citation.relevance
    : typeof score === 'number' ? score
    : typeof rankScore === 'number' ? rankScore
    : null;

  /** 스니펫을 클립보드에 복사한다 */
  const handleCopy = (e) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* 비치명적 — 클립보드 접근 실패 시 무시 */ });
  };

  return (
    <div class="isb-popover" role="dialog" aria-label={`출처 ${index} 상세`} ref={popoverRef}>
      <div class="isb-popover-header">
        <SourceIcon source={source} />
        <span class="isb-popover-source">{sourceLabel}</span>
        {date && <span class="isb-popover-date">{date}</span>}
      </div>

      {/* 소스별 메타데이터 */}
      <div class="isb-popover-meta">
        {source === 'commits' && (
          <>
            {repo && <span class="isb-meta-chip">{repo}</span>}
            {hash && <code class="isb-meta-hash">{typeof hash === 'string' && hash.length > 7 ? hash.slice(0, 7) : hash}</code>}
          </>
        )}
        {source === 'slack' && (
          <>
            {channelId && <span class="isb-meta-chip">{channelId}</span>}
            {permalink && (
              <a
                class="isb-meta-link"
                href={permalink}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                열기 ↗
              </a>
            )}
          </>
        )}
        {(source === 'session' || source === 'sessions') && resolvedSessionType && (
          <span class="isb-meta-chip">
            {{ codex: 'Codex', claude: 'Claude', aiReview: 'AI 리뷰' }[resolvedSessionType] ?? resolvedSessionType}
          </span>
        )}
      </div>

      {/* 매칭 키워드 태그 */}
      {keywords.length > 0 && (
        <div class="isb-keywords" aria-label="매칭 키워드">
          {keywords.map((kw, ki) => (
            <span key={ki} class="isb-keyword-tag">{kw}</span>
          ))}
        </div>
      )}

      {/* 텍스트 스니펫 — 펼치기/접기 + 복사 버튼 */}
      {displayText && (
        <div class="isb-popover-text-wrap">
          <p class={`isb-popover-text${expanded ? ' isb-popover-text--expanded' : ''}`}>{displayText}</p>
          <div class="isb-popover-text-actions">
            {isLong && (
              <button
                class="isb-text-toggle"
                type="button"
                onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
                aria-label={expanded ? '텍스트 접기' : '전체 텍스트 보기'}
              >
                {expanded ? '접기 ▲' : '더 보기 ▼'}
              </button>
            )}
            {text && (
              <button
                class="isb-copy-btn"
                type="button"
                onClick={handleCopy}
                aria-label="스니펫 복사"
                title="스니펫 복사"
              >
                {copied ? '✓ 복사됨' : '📋 복사'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 관련도 표시 */}
      {typeof relevance === 'number' && relevance > 0 && (
        <div class="isb-popover-relevance">
          <div
            class="isb-relevance-bar"
            style={{ width: `${Math.round(relevance * 100)}%` }}
          />
          <span class="isb-relevance-label">관련도 {Math.round(relevance * 100)}%</span>
        </div>
      )}
    </div>
  );
}

function SourceIcon({ source }) {
  const icon = source === 'commits' ? '⌥' : source === 'slack' ? '#' : '🤖';
  return <span class="isb-popover-icon" aria-hidden="true">{icon}</span>;
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const ISB_CSS = `
  /* ─── Root (inline wrapper) ─── */
  .isb-root {
    position: relative;
    display: inline;
    vertical-align: baseline;
  }

  /* ─── Badge button ─── */
  .isb-badge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 5px;
    margin: 0 1px;
    height: 18px;
    border: none;
    border-radius: 9px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    vertical-align: middle;
    transition: transform 0.1s, box-shadow 0.15s;
    position: relative;
    top: -1px;
  }

  .isb-badge:hover {
    transform: scale(1.08);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }

  .isb-badge:focus-visible {
    outline: 2px solid var(--accent, #2563eb);
    outline-offset: 1px;
  }

  /* ─── Badge variants ─── */
  .isb-badge--commit {
    background: #dbeafe;
    color: #1e40af;
  }

  .isb-badge--slack {
    background: #fef3c7;
    color: #92400e;
  }

  .isb-badge--session {
    background: #d1fae5;
    color: #065f46;
  }

  .isb-icon {
    font-size: 9px;
    line-height: 1;
  }

  .isb-num {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.03em;
    font-variant-numeric: tabular-nums;
  }

  /* ─── Popover ─── */
  .isb-popover {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    width: 280px;
    max-width: 320px;
    padding: 10px 12px;
    background: #fff;
    border: 1px solid var(--line, #e2e8f0);
    border-radius: var(--radius-md, 12px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06);
    font-size: 11px;
    color: var(--ink, #1e293b);
    line-height: 1.5;
    pointer-events: auto;
    animation: isb-fade-in 0.15s ease forwards;
  }

  @keyframes isb-fade-in {
    from { opacity: 0; transform: translateX(-50%) translateY(4px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  /* 팝오버 아래 삼각형 화살표 */
  .isb-popover::after {
    content: '';
    position: absolute;
    bottom: -5px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 8px;
    height: 8px;
    background: #fff;
    border-right: 1px solid var(--line, #e2e8f0);
    border-bottom: 1px solid var(--line, #e2e8f0);
  }

  /* ─── Popover header ─── */
  .isb-popover-header {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 6px;
  }

  .isb-popover-icon {
    font-size: 12px;
    line-height: 1;
  }

  .isb-popover-source {
    font-weight: 600;
    font-size: 11px;
    color: var(--ink-strong, #0f172a);
  }

  .isb-popover-date {
    margin-left: auto;
    font-size: 10px;
    color: var(--muted, #94a3b8);
    flex-shrink: 0;
  }

  /* ─── Popover meta ─── */
  .isb-popover-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }

  .isb-popover-meta:empty {
    display: none;
  }

  .isb-meta-chip {
    display: inline-block;
    padding: 1px 6px;
    background: rgba(15, 23, 42, 0.06);
    border-radius: 4px;
    font-size: 10px;
    color: var(--ink, #1e293b);
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .isb-meta-hash {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 10px;
    background: rgba(15, 23, 42, 0.07);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--ink, #1e293b);
    letter-spacing: 0.04em;
  }

  .isb-meta-link {
    font-size: 10px;
    color: var(--accent, #2563eb);
    text-decoration: none;
    padding: 1px 4px;
    border-radius: 3px;
    transition: background 0.1s;
  }

  .isb-meta-link:hover {
    background: rgba(30, 64, 175, 0.08);
    text-decoration: underline;
  }

  /* ─── Popover text snippet ─── */
  .isb-popover-text {
    margin: 0;
    padding: 5px 7px;
    font-size: 10px;
    line-height: 1.55;
    color: var(--ink, #1e293b);
    opacity: 0.8;
    background: rgba(15, 23, 42, 0.03);
    border-radius: var(--radius-sm, 8px);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 80px;
    overflow-y: auto;
  }

  /* ─── Relevance bar ─── */
  .isb-popover-relevance {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    height: 14px;
  }

  .isb-relevance-bar {
    height: 3px;
    min-width: 8px;
    background: linear-gradient(90deg, #60a5fa, #2563eb);
    border-radius: 2px;
    transition: width 0.2s ease;
  }

  .isb-relevance-label {
    font-size: 9px;
    color: var(--muted, #94a3b8);
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ─── Matched keywords ─── */
  .isb-keywords {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-bottom: 6px;
  }

  .isb-keywords:empty {
    display: none;
  }

  .isb-keyword-tag {
    display: inline-block;
    padding: 1px 6px;
    background: rgba(99, 102, 241, 0.1);
    color: var(--accent-subtle, #6366f1);
    border-radius: 4px;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* ─── Print ─── */
  @media print {
    .isb-badge {
      display: none;
    }
    .isb-popover {
      display: none;
    }
  }
`;
