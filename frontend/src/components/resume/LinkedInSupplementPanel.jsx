import { useMemo } from 'preact/hooks';
import { CandidateCard, CANDIDATE_CARD_CSS, SECTION_LABELS } from './CandidateCard.jsx';

/**
 * LinkedInSupplementPanel — LinkedIn 기반 보충/검증 제안 패널
 *
 * props:
 *   suggestions          — 부모가 보유한 제안 목록
 *   loading              — 제안 목록 로딩 여부
 *   fetchError           — 제안 목록 로딩 오류
 *   onRefreshSuggestions — 제안 목록 새로고침
 *   onSuggestionResolved — 승인/제외 후 공통 suggestion 상태 갱신
 *   onResumePatched      — 승인 응답 resume 객체를 직접 수신해 GET 없이 갱신 (낙관적 업데이트)
 *   onResumeUpdated      — 승인으로 이력서가 변경됐을 때 재조회 요청 (onResumePatched 폴백)
 */
export function LinkedInSupplementPanel({
  suggestions = [],
  loading = false,
  fetchError = '',
  onRefreshSuggestions,
  onSuggestionResolved,
  onResumePatched,
  onResumeUpdated,
}) {

  // ── Callbacks from CandidateCard ──────────────────────────────────────────

  /** Called when a CandidateCard approve API call succeeds. */
  function handleCardApproved(id) {
    onSuggestionResolved?.(id, 'approved');
  }

  /** Called when a CandidateCard discard API call succeeds. */
  function handleCardDiscarded(id) {
    onSuggestionResolved?.(id, 'rejected');
  }

  const visible = useMemo(
    () => suggestions.filter((s) => s.source === 'linkedin' && s.status === 'pending'),
    [suggestions]
  );

  const pendingCount = visible.length;

  // Group visible suggestions by section for structured display
  const grouped = groupBySection(visible);
  const SECTION_ORDER = [
    'contact',
    'summary',
    'experience',
    'education',
    'skills',
    'certifications',
  ];
  const orderedSections = SECTION_ORDER.filter((s) => (grouped[s] ?? []).length > 0);

  return (
    <div class="lisp-root">
      {/* ── Header ── */}
      <div class="lisp-header">
        <div class="lisp-title-group">
          <span class="lisp-li-icon" aria-hidden="true">in</span>
          <p class="lisp-title">LinkedIn 보충 제안</p>
          {!loading && pendingCount > 0 && (
            <span
              class="lisp-badge"
              aria-label={`미처리 LinkedIn 보충 제안 ${pendingCount}건`}
            >
              {pendingCount}
            </span>
          )}
        </div>
        {!loading && onRefreshSuggestions && (
          <button
            class="lisp-refresh-btn"
            onClick={onRefreshSuggestions}
            aria-label="LinkedIn 보충 제안 새로고침"
            title="새로고침"
          >
            ↺
          </button>
        )}
      </div>

      {/* ── Loading state ── */}
      {loading && (
        <div class="lisp-state">
          <span class="lisp-spinner" aria-label="불러오는 중" />
        </div>
      )}

      {/* ── Fetch error state ── */}
      {!loading && fetchError && (
        <div class="lisp-state lisp-state--error">
          <p class="lisp-error-msg">{fetchError}</p>
          <button class="lisp-retry-btn" onClick={onRefreshSuggestions}>
            다시 시도
          </button>
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !fetchError && visible.length === 0 && (
        <p class="lisp-empty">
          LinkedIn 프로필과 이력서가
          <br />
          일치하거나 이미 모두 반영됐습니다.
        </p>
      )}

      {/* ── Grouped card list ── */}
      {!loading && !fetchError && visible.length > 0 && (
        <div class="lisp-sections">
          {orderedSections.map((section) => (
            <div key={section} class="lisp-section">
              <p class="lisp-section-label">
                {SECTION_LABELS[section] ?? section}
              </p>
              <ul
                class="lisp-list"
                aria-label={`${SECTION_LABELS[section] ?? section} 보충 제안`}
              >
                {grouped[section].map((s) => (
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
            </div>
          ))}
        </div>
      )}

      {/* Panel-level + CandidateCard styles injected once at panel root */}
      <style>{LISP_CSS + CANDIDATE_CARD_CSS}</style>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Group an array of suggestions by their `section` property.
 *
 * @param {object[]} suggestions
 * @returns {Record<string, object[]>}
 */
function groupBySection(suggestions) {
  return suggestions.reduce((acc, s) => {
    const sec = s.section ?? 'other';
    if (!acc[sec]) acc[sec] = [];
    acc[sec].push(s);
    return acc;
  }, {});
}

// ── Styles ────────────────────────────────────────────────────────────────────

const LISP_CSS = `
  /* ─── Root panel ─── */
  .lisp-root {
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
  .lisp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .lisp-title-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* LinkedIn "in" icon */
  .lisp-li-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: #0a66c2;
    color: #fff;
    font-size: 9px;
    font-weight: 800;
    border-radius: 3px;
    letter-spacing: 0;
    line-height: 1;
    font-style: normal;
    flex-shrink: 0;
  }

  .lisp-title {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* Pending-count badge (LinkedIn blue) */
  .lisp-badge {
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
    background: #0a66c2;
    color: #fff;
    letter-spacing: 0;
    text-transform: none;
  }

  .lisp-refresh-btn {
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

  .lisp-refresh-btn:hover {
    color: var(--ink);
    background: rgba(17, 24, 39, 0.07);
  }

  /* ─── Loading / Error / Empty states ─── */
  .lisp-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) 0;
  }

  .lisp-spinner {
    display: block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: lisp-spin 0.7s linear infinite;
  }

  @keyframes lisp-spin {
    to { transform: rotate(360deg); }
  }

  .lisp-state--error {
    align-items: flex-start;
  }

  .lisp-error-msg {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
    line-height: 1.5;
  }

  .lisp-retry-btn {
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

  .lisp-retry-btn:hover { opacity: 0.75; }

  .lisp-empty {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.7;
  }

  /* ─── Grouped section list ─── */
  .lisp-sections {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .lisp-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* Section divider label */
  .lisp-section-label {
    margin: 0;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    padding-bottom: var(--space-1);
    border-bottom: 1px solid var(--line);
  }

  .lisp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* ─── Print: hide entire panel ─── */
  @media print {
    .lisp-root { display: none !important; }
  }
`;
