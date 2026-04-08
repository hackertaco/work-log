import { useMemo } from 'preact/hooks';
import { CandidateCard, CANDIDATE_CARD_CSS } from './CandidateCard.jsx';

/**
 * SuggestionPanel — 이력서 갱신 제안 패널 (B형)
 *
 * props:
 *   suggestions         — 부모가 보유한 제안 목록
 *   loading             — 제안 목록 로딩 여부
 *   fetchError          — 제안 목록 로딩 오류
 *   onRefreshSuggestions — 제안 목록 새로고침
 *   onSuggestionResolved — 승인/제외 후 공통 suggestion 상태 갱신
 *   onResumePatched      — (하위 호환) approve 응답 resume 객체를 직접 수신할 때 사용
 *   onResumeUpdated      — 승인으로 이력서가 변경됐을 때 재조회 요청 (부모에 위임)
 */
export function SuggestionPanel({
  suggestions = [],
  loading = false,
  fetchError = '',
  onRefreshSuggestions,
  onSuggestionResolved,
  onResumePatched,
  onResumeUpdated,
}) {

  // ── Callbacks from CandidateCard ──────────────────────────────────────────

  /** Called by CandidateCard when the approve API call succeeds. */
  function handleCardApproved(id) {
    onSuggestionResolved?.(id, 'approved');
  }

  /** Called by CandidateCard when the discard API call succeeds. */
  function handleCardDiscarded(id) {
    onSuggestionResolved?.(id, 'rejected');
  }

  // Visible = pending work-log suggestions not yet acted on locally.
  // LinkedIn-sourced suggestions are shown separately in LinkedInSupplementPanel,
  // so we exclude them here to avoid duplication.
  const visible = useMemo(
    () =>
      suggestions.filter(
        (s) => s.status === 'pending' && s.source !== 'linkedin',
      ),
    [suggestions]
  );

  const pendingCount = visible.length;

  return (
    <div class="sp-root">
      {/* ── Header ── */}
      <div class="sp-header">
        <div class="sp-title-group">
          <p class="sp-title">갱신 제안</p>
          {!loading && pendingCount > 0 && (
            <span class="sp-badge" aria-label={`미처리 제안 ${pendingCount}건`}>
              {pendingCount}
            </span>
          )}
        </div>
        {!loading && onRefreshSuggestions && (
          <button
            class="sp-refresh-btn"
            onClick={onRefreshSuggestions}
            aria-label="제안 목록 새로고침"
            title="새로고침"
          >
            ↺
          </button>
        )}
      </div>

      {/* ── Loading state ── */}
      {loading && (
        <div class="sp-state">
          <span class="sp-spinner" aria-label="불러오는 중" />
        </div>
      )}

      {/* ── Fetch error state ── */}
      {!loading && fetchError && (
        <div class="sp-state sp-state--error">
          <p class="sp-error-msg">{fetchError}</p>
          {onRefreshSuggestions && (
            <button class="sp-retry-btn" onClick={onRefreshSuggestions}>
              다시 시도
            </button>
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !fetchError && visible.length === 0 && (
        <p class="sp-empty">
          업무 로그에서 자동으로
          <br />
          갱신 제안이 생성되면
          <br />
          여기에 표시됩니다.
        </p>
      )}

      {/* ── CandidateCard list ── */}
      {!loading && !fetchError && visible.length > 0 && (
        <ul class="sp-list" aria-label="갱신 제안 목록">
          {visible.map((s) => (
            <CandidateCard
              key={s.id}
              suggestion={s}
              onApproved={handleCardApproved}
              onDiscarded={handleCardDiscarded}
              onResumePatched={onResumePatched}
              onResumeUpdated={onResumeUpdated}
            />
          ))}
        </ul>
      )}

      {/* Panel-level + CandidateCard styles, injected once at the panel root */}
      <style>{SP_CSS + CANDIDATE_CARD_CSS}</style>
    </div>
  );
}

/* ── JSDoc type ─────────────────────────────────────────────────────────── */

/**
 * @typedef {{
 *   id: string,
 *   createdAt: string,
 *   status: 'pending'|'approved'|'rejected',
 *   section: string,
 *   action: string,
 *   description: string,
 *   detail?: string,
 *   patch: object,
 *   source: 'work_log'|'linkedin'|'manual',
 *   logDate?: string,
 * }} SuggestionItem
 */

/* ── Styles ─────────────────────────────────────────────────────────────── */

/**
 * Panel-level styles only (.sp-*).
 * Card-level styles (.cc-*) come from CANDIDATE_CARD_CSS in CandidateCard.jsx
 * and are concatenated in the <style> block above.
 */
const SP_CSS = `
  /* ─── Root panel ─── */
  .sp-root {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-4) var(--space-5);
    backdrop-filter: blur(10px);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* ─── Header ─── */
  .sp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .sp-title-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .sp-title {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* Pending-count badge in the panel header */
  .sp-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    background: #2563eb;
    color: #fff;
    letter-spacing: 0;
    text-transform: none;
  }

  .sp-refresh-btn {
    background: none;
    border: none;
    padding: 2px 4px;
    font-size: 14px;
    color: var(--muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: color 0.15s, background 0.15s;
    line-height: 1;
  }

  .sp-refresh-btn:hover {
    color: var(--ink);
    background: rgba(17, 24, 39, 0.07);
  }

  /* ─── Loading / Error / Empty states ─── */
  .sp-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) 0;
  }

  .sp-spinner {
    display: block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: sp-spin 0.7s linear infinite;
  }

  @keyframes sp-spin {
    to { transform: rotate(360deg); }
  }

  .sp-state--error {
    align-items: flex-start;
  }

  .sp-error-msg {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
    line-height: 1.5;
  }

  .sp-retry-btn {
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .sp-retry-btn:hover { opacity: 0.75; }

  .sp-empty {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.7;
  }

  /* ─── Card list ─── */
  .sp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* ─── Print: hide entire suggestion panel ─── */
  @media print {
    .sp-root { display: none !important; }
  }
`;
