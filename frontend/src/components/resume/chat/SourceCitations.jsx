import { useState } from 'preact/hooks';

/**
 * SourceCitations — 응답 메시지 하단의 출처 정보 표시 컴포넌트
 *
 * 채팅 어시스턴트 응답에서 사용된 근거(커밋, 슬랙 메시지, 세션 메모리)의
 * 출처 정보를 시각적으로 표시한다.
 *
 * Props:
 *   citations — RankedEvidenceRecord[]  rankedEvidence 배열 (API 응답)
 *   maxVisible — number  접기 전 최대 표시 건수 (기본값: 3)
 *
 * RankedEvidenceRecord 구조 (소스별):
 *   공통: { source, date, text, rank, rankScore, matchedKeywords, score }
 *
 *   commits  → { hash, repo, authoredAt, ... }
 *   slack    → { channelId, ts, permalink?, context, ... }
 *   sessions → { sessionSource, filePath?, cwd?, ... }
 */
export function SourceCitations({ citations = [], maxVisible = 3 }) {
  const [expanded, setExpanded] = useState(false);

  if (!citations || citations.length === 0) return null;

  const visible = expanded ? citations : citations.slice(0, maxVisible);
  const hiddenCount = citations.length - maxVisible;

  return (
    <div class="sc-root" aria-label="출처 정보">
      <div class="sc-header">
        <span class="sc-header-icon" aria-hidden="true">📎</span>
        <span class="sc-header-label">근거 출처 {citations.length}건</span>
      </div>

      <ul class="sc-list" role="list">
        {visible.map((citation, i) => (
          <CitationItem key={`${citation.source}-${citation.date}-${i}`} citation={citation} />
        ))}
      </ul>

      {hiddenCount > 0 && (
        <button
          class="sc-toggle"
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded
            ? '접기 ▲'
            : `+${hiddenCount}건 더 보기 ▼`}
        </button>
      )}

      <style>{SC_CSS}</style>
    </div>
  );
}

/* ── 개별 출처 항목 ──────────────────────────────────────────────────────────── */

function CitationItem({ citation }) {
  const [showPreview, setShowPreview] = useState(false);

  const { source } = citation;

  if (source === 'commits') {
    return <CommitCitation citation={citation} showPreview={showPreview} onToggle={() => setShowPreview((v) => !v)} />;
  }
  if (source === 'slack') {
    return <SlackCitation citation={citation} showPreview={showPreview} onToggle={() => setShowPreview((v) => !v)} />;
  }
  // sessions / aiReview
  return <SessionCitation citation={citation} showPreview={showPreview} onToggle={() => setShowPreview((v) => !v)} />;
}

/* ── 커밋 출처 ──────────────────────────────────────────────────────────────── */

function CommitCitation({ citation, showPreview, onToggle }) {
  const hash = citation.hash || citation.provenance?.commitHash || '';
  const repo = citation.repo || citation.provenance?.repo || '';
  const date = citation.date || '';
  const text = citation.text || '';
  const keywords = Array.isArray(citation.matchedKeywords) ? citation.matchedKeywords : [];
  const relevance = resolveRelevance(citation);

  const shortHash = hash ? hash.slice(0, 7) : '';
  const shortText = text.length > 72 ? text.slice(0, 72) + '…' : text;

  return (
    <li class="sc-item sc-item--commit">
      <div class="sc-item-row">
        <span class="sc-source-badge sc-source-badge--commit" aria-label="커밋">
          <span aria-hidden="true">⌥</span> 커밋
        </span>
        {repo && <span class="sc-repo">{repo}</span>}
        {shortHash && (
          <code class="sc-hash" title={hash}>
            {shortHash}
          </code>
        )}
        {keywords.length > 0 && (
          <span class="sc-keywords">
            {keywords.map((kw, ki) => (
              <span key={ki} class="sc-keyword-tag">{kw}</span>
            ))}
          </span>
        )}
        {relevance !== null && <RelevanceChip value={relevance} />}
        {date && <span class="sc-date">{date}</span>}
        {text && (
          <button
            class="sc-preview-toggle"
            type="button"
            aria-expanded={showPreview}
            aria-label="내용 미리보기"
            onClick={onToggle}
          >
            {showPreview ? '▲' : '▼'}
          </button>
        )}
      </div>

      {showPreview && text && (
        <p class="sc-preview">{shortText}</p>
      )}
    </li>
  );
}

/* ── 슬랙 출처 ──────────────────────────────────────────────────────────────── */

function SlackCitation({ citation, showPreview, onToggle }) {
  const channelId = citation.channelId || citation.provenance?.channelId || '';
  const permalink = citation.permalink || citation.provenance?.permalink || null;
  const date = citation.date || '';
  const text = citation.text || '';
  const keywords = Array.isArray(citation.matchedKeywords) ? citation.matchedKeywords : [];
  const relevance = resolveRelevance(citation);

  const shortText = text.length > 72 ? text.slice(0, 72) + '…' : text;

  return (
    <li class="sc-item sc-item--slack">
      <div class="sc-item-row">
        <span class="sc-source-badge sc-source-badge--slack" aria-label="슬랙">
          <span aria-hidden="true">#</span> 슬랙
        </span>
        {channelId && (
          <span class="sc-channel" title={channelId}>
            {channelId.slice(0, 10)}
          </span>
        )}
        {keywords.length > 0 && (
          <span class="sc-keywords">
            {keywords.map((kw, ki) => (
              <span key={ki} class="sc-keyword-tag">{kw}</span>
            ))}
          </span>
        )}
        {relevance !== null && <RelevanceChip value={relevance} />}
        {date && <span class="sc-date">{date}</span>}
        {permalink ? (
          <a
            class="sc-link"
            href={permalink}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="슬랙 메시지 열기"
          >
            링크 ↗
          </a>
        ) : null}
        {text && (
          <button
            class="sc-preview-toggle"
            type="button"
            aria-expanded={showPreview}
            aria-label="내용 미리보기"
            onClick={onToggle}
          >
            {showPreview ? '▲' : '▼'}
          </button>
        )}
      </div>

      {showPreview && text && (
        <p class="sc-preview">{shortText}</p>
      )}
    </li>
  );
}

/* ── 세션 출처 ──────────────────────────────────────────────────────────────── */

function SessionCitation({ citation, showPreview, onToggle }) {
  const sessionSource = citation.sessionSource || citation.sessionType || citation.provenance?.sessionType || 'AI';
  const date = citation.date || '';
  const text = citation.text || '';
  const keywords = Array.isArray(citation.matchedKeywords) ? citation.matchedKeywords : [];
  const relevance = resolveRelevance(citation);

  const sessionLabel = {
    codex: 'Codex',
    claude: 'Claude',
    aiReview: 'AI 리뷰',
  }[sessionSource] ?? sessionSource;

  const shortText = text.length > 72 ? text.slice(0, 72) + '…' : text;

  return (
    <li class="sc-item sc-item--session">
      <div class="sc-item-row">
        <span class="sc-source-badge sc-source-badge--session" aria-label="세션 메모리">
          <span aria-hidden="true">🤖</span> {sessionLabel}
        </span>
        {keywords.length > 0 && (
          <span class="sc-keywords">
            {keywords.map((kw, ki) => (
              <span key={ki} class="sc-keyword-tag">{kw}</span>
            ))}
          </span>
        )}
        {relevance !== null && <RelevanceChip value={relevance} />}
        {date && <span class="sc-date">{date}</span>}
        {text && (
          <button
            class="sc-preview-toggle"
            type="button"
            aria-expanded={showPreview}
            aria-label="내용 미리보기"
            onClick={onToggle}
          >
            {showPreview ? '▲' : '▼'}
          </button>
        )}
      </div>

      {showPreview && text && (
        <p class="sc-preview">{shortText}</p>
      )}
    </li>
  );
}

/* ── 관련도 헬퍼 ───────────────────────────────────────────────────────────── */

/**
 * citation에서 relevance/score/rankScore를 0~1 범위로 추출한다.
 * @param {object} citation
 * @returns {number|null}
 */
function resolveRelevance(citation) {
  if (typeof citation.relevance === 'number') return citation.relevance;
  if (typeof citation.score === 'number') return citation.score;
  if (typeof citation.rankScore === 'number') return citation.rankScore;
  return null;
}

/**
 * RelevanceChip — 관련도를 간결한 칩 형태로 표시한다.
 * @param {{ value: number }} props  0~1 범위의 관련도 점수
 */
function RelevanceChip({ value }) {
  const pct = Math.round(value * 100);
  // 관련도에 따른 색상 변화: 높을수록 진한 파랑
  const cls = pct >= 70 ? 'sc-relevance--high' : pct >= 40 ? 'sc-relevance--mid' : 'sc-relevance--low';
  return (
    <span class={`sc-relevance ${cls}`} title={`관련도 ${pct}%`} aria-label={`관련도 ${pct}%`}>
      {pct}%
    </span>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const SC_CSS = `
  /* ─── Root ─── */
  .sc-root {
    margin-top: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: rgba(15, 23, 42, 0.03);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    font-size: 11px;
    color: var(--muted);
  }

  /* ─── Header ─── */
  .sc-header {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
    font-weight: 600;
    font-size: 11px;
    color: var(--ink);
    opacity: 0.7;
    letter-spacing: 0.03em;
  }

  .sc-header-icon {
    font-size: 12px;
    line-height: 1;
  }

  /* ─── List ─── */
  .sc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* ─── Item ─── */
  .sc-item {
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .sc-item-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 3px 4px;
    border-radius: var(--radius-sm);
    transition: background 0.1s;
  }

  .sc-item-row:hover {
    background: rgba(15, 23, 42, 0.04);
  }

  /* ─── Source badge ─── */
  .sc-source-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .sc-source-badge--commit {
    background: #dbeafe;
    color: #1e40af;
  }

  .sc-source-badge--slack {
    background: #fef3c7;
    color: #92400e;
  }

  .sc-source-badge--session {
    background: #d1fae5;
    color: #065f46;
  }

  /* ─── Matched keywords ─── */
  .sc-keywords {
    display: inline-flex;
    gap: 3px;
    flex-shrink: 1;
    min-width: 0;
    flex-wrap: wrap;
  }

  .sc-keyword-tag {
    display: inline-block;
    padding: 0 5px;
    background: rgba(99, 102, 241, 0.1);
    color: var(--accent-subtle, #6366f1);
    border-radius: 3px;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ─── Metadata chips ─── */
  .sc-hash {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 10px;
    background: rgba(15, 23, 42, 0.07);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--ink);
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .sc-repo {
    font-size: 10px;
    color: var(--ink);
    opacity: 0.8;
    font-weight: 500;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sc-channel {
    font-size: 10px;
    color: var(--ink);
    opacity: 0.7;
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    flex-shrink: 0;
  }

  .sc-date {
    font-size: 10px;
    color: var(--muted);
    flex-shrink: 0;
    margin-left: auto;
  }

  /* ─── Link ─── */
  .sc-link {
    font-size: 10px;
    color: var(--accent);
    text-decoration: none;
    flex-shrink: 0;
    padding: 1px 4px;
    border-radius: 3px;
    transition: background 0.1s;
  }

  .sc-link:hover {
    background: rgba(30, 64, 175, 0.08);
    text-decoration: underline;
  }

  /* ─── Preview toggle ─── */
  .sc-preview-toggle {
    background: none;
    border: none;
    padding: 1px 4px;
    font-size: 10px;
    color: var(--muted);
    cursor: pointer;
    border-radius: 3px;
    line-height: 1;
    transition: background 0.1s, color 0.1s;
    flex-shrink: 0;
  }

  .sc-preview-toggle:hover {
    background: rgba(15, 23, 42, 0.07);
    color: var(--ink);
  }

  /* ─── Preview text ─── */
  .sc-preview {
    margin: 0;
    padding: 4px 6px;
    font-size: 10px;
    line-height: 1.5;
    color: var(--ink);
    opacity: 0.75;
    background: rgba(15, 23, 42, 0.03);
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ─── Expand/collapse toggle ─── */
  .sc-toggle {
    display: block;
    width: 100%;
    margin-top: var(--space-2);
    padding: 3px 0;
    background: none;
    border: none;
    border-top: 1px solid var(--line);
    font-size: 10px;
    color: var(--accent);
    cursor: pointer;
    text-align: center;
    letter-spacing: 0.02em;
    transition: background 0.1s;
  }

  .sc-toggle:hover {
    background: rgba(30, 64, 175, 0.04);
  }

  /* ─── Relevance chip ─── */
  .sc-relevance {
    display: inline-block;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .sc-relevance--high {
    background: rgba(30, 64, 175, 0.12);
    color: #1e40af;
  }

  .sc-relevance--mid {
    background: rgba(99, 102, 241, 0.1);
    color: #6366f1;
  }

  .sc-relevance--low {
    background: rgba(148, 163, 184, 0.12);
    color: #94a3b8;
  }
`;
