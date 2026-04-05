/**
 * DiffAction — diff 항목별 approve/reject 버튼 UI 컴포넌트
 *
 * 이력서 섹션 수정 제안에 대해 승인(approve) 또는 거절(reject) 결정을 내리는
 * 재사용 가능한 액션 버튼 그룹.
 *
 * 상태별 렌더링:
 *   - pending:    승인/거절 버튼 활성화
 *   - queued:     큐 대기 인디케이터 + 취소 버튼
 *   - processing: 반영 중 스피너 애니메이션
 *   - approved:   승인됨 배지 (비활성)
 *   - rejected:   거절됨 배지 (비활성)
 *
 * Props:
 *   status               — 'pending' | 'queued' | 'approved' | 'rejected'
 *   section              — string        섹션 이름 (접근성 레이블용)
 *   onApprove            — () => void    승인 콜백
 *   onReject             — () => void    거절 콜백
 *   queuePosition        — number | null 큐 순서 (1-based)
 *   isCurrentlyProcessing — boolean      현재 처리 중 여부
 *   compact              — boolean       컴팩트 모드 (아이콘만 표시)
 */
export function DiffAction({
  status = 'pending',
  section = '',
  onApprove,
  onReject,
  queuePosition = null,
  isCurrentlyProcessing = false,
  compact = false,
}) {
  const isPending = status === 'pending';
  const isQueued = status === 'queued';
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';

  /* ── 핸들러 ── */
  function handleApprove() {
    if (!isPending) return;
    onApprove?.();
  }

  function handleReject() {
    if (!isPending && !isQueued) return;
    onReject?.();
  }

  /* ── 큐 상태 레이블 ── */
  function getQueuedLabel() {
    if (isCurrentlyProcessing) {
      return section ? `"${section}" 섹션 반영 중…` : '반영 중…';
    }
    if (queuePosition != null && queuePosition > 1) {
      return `${queuePosition}번째 대기 중 — 이전 섹션 완료 후 순서대로 반영됩니다`;
    }
    return '이전 섹션 처리 후 순서대로 반영됩니다…';
  }

  /* ── 상태 배지 레이블 ── */
  function getStatusBadgeLabel() {
    if (isApproved) return '승인됨';
    if (isRejected) return '거절됨';
    if (isQueued && isCurrentlyProcessing) return '반영 중';
    if (isQueued) return queuePosition != null ? `${queuePosition}번째 대기` : '반영 대기 중';
    return null;
  }

  const badgeLabel = getStatusBadgeLabel();
  const badgeStatus = isQueued && isCurrentlyProcessing ? 'processing' : status;

  return (
    <div class="da-root" data-status={badgeStatus}>
      {/* ── 큐 상태 인디케이터 ── */}
      {isQueued && (
        <div
          class={[
            'da-queued',
            isCurrentlyProcessing ? 'da-queued--processing' : '',
          ].filter(Boolean).join(' ')}
          role="status"
          aria-live="polite"
        >
          <span
            class={isCurrentlyProcessing ? 'da-spinner da-spinner--fast' : 'da-spinner'}
            aria-hidden="true"
          />
          <span class="da-queued-label">{getQueuedLabel()}</span>
          {!isCurrentlyProcessing && onReject && (
            <button
              class="da-btn-cancel"
              type="button"
              onClick={handleReject}
              aria-label={section ? `${section} 반영 대기 취소` : '반영 대기 취소'}
              title="대기 중인 반영을 취소합니다"
            >
              취소
            </button>
          )}
        </div>
      )}

      {/* ── Approve / Reject 버튼 (pending 일 때만) ── */}
      {isPending && (
        <div class={`da-actions${compact ? ' da-actions--compact' : ''}`} role="group" aria-label="수정 제안 결정">
          <button
            class="da-btn da-btn--approve"
            type="button"
            onClick={handleApprove}
            aria-label={section ? `${section} 수정 승인` : '수정 승인'}
            title="이 수정 내용을 이력서에 반영합니다"
          >
            <span class="da-btn-icon" aria-hidden="true">✓</span>
            {!compact && <span>승인</span>}
          </button>
          <button
            class="da-btn da-btn--reject"
            type="button"
            onClick={handleReject}
            aria-label={section ? `${section} 수정 거절` : '수정 거절'}
            title="이 수정 제안을 무시합니다"
          >
            <span class="da-btn-icon" aria-hidden="true">✕</span>
            {!compact && <span>거절</span>}
          </button>
        </div>
      )}

      {/* ── 결정 완료 상태 배지 ── */}
      {(isApproved || isRejected) && badgeLabel && (
        <div class="da-result">
          <span class={`da-badge da-badge--${status}`} aria-label={badgeLabel}>
            <span class="da-badge-icon" aria-hidden="true">
              {isApproved ? '✓' : '✕'}
            </span>
            {badgeLabel}
          </span>
        </div>
      )}

      <style>{DA_CSS}</style>
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const DA_CSS = `
  /* ─── Root ─── */
  .da-root {
    font-size: 13px;
  }

  /* ─── Actions (Approve / Reject) ─── */
  .da-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border-top: 1px solid var(--line, rgba(15, 23, 42, 0.08));
    background: rgba(248, 248, 250, 0.8);
    justify-content: flex-end;
  }

  .da-actions--compact {
    padding: var(--space-1, 4px) var(--space-2, 8px);
    gap: var(--space-1, 4px);
  }

  .da-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1, 4px);
    padding: 6px 14px;
    border-radius: var(--radius-sm, 8px);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
    border: 1.5px solid transparent;
    cursor: pointer;
    transition: background 0.13s, border-color 0.13s, transform 0.1s, box-shadow 0.13s;
    user-select: none;
    line-height: 1;
  }

  .da-btn:active {
    transform: scale(0.97);
  }

  .da-btn:focus-visible {
    outline: 2px solid var(--accent, #1e40af);
    outline-offset: 2px;
  }

  .da-btn-icon {
    font-size: 12px;
    line-height: 1;
    font-weight: 900;
  }

  .da-actions--compact .da-btn {
    padding: 4px 10px;
    font-size: 11px;
  }

  .da-actions--compact .da-btn-icon {
    font-size: 11px;
  }

  /* Approve 버튼 — 초록 계열 */
  .da-btn--approve {
    background: rgba(22, 163, 74, 0.1);
    border-color: rgba(22, 163, 74, 0.4);
    color: #166534;
  }

  .da-btn--approve:hover {
    background: #16a34a;
    border-color: #16a34a;
    color: #fff;
    box-shadow: 0 2px 8px rgba(22, 163, 74, 0.3);
  }

  /* Reject 버튼 — 회색 계열 (거절은 약한 강조) */
  .da-btn--reject {
    background: rgba(100, 100, 100, 0.06);
    border-color: rgba(100, 100, 100, 0.2);
    color: var(--muted, #64748b);
  }

  .da-btn--reject:hover {
    background: rgba(220, 38, 38, 0.08);
    border-color: rgba(220, 38, 38, 0.3);
    color: #dc2626;
  }

  /* ─── 큐 상태 ─── */
  .da-queued {
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border-top: 1px solid #fcd34d;
    background: rgba(254, 243, 199, 0.6);
    font-size: 11px;
    color: #92400e;
  }

  .da-queued--processing {
    border-top-color: #93c5fd;
    background: rgba(219, 234, 254, 0.6);
    color: #1d4ed8;
  }

  .da-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(217, 119, 6, 0.3);
    border-top-color: #d97706;
    border-radius: 50%;
    animation: da-spin 0.9s linear infinite;
    flex-shrink: 0;
  }

  .da-spinner--fast {
    border-color: rgba(37, 99, 235, 0.25);
    border-top-color: #2563eb;
    animation-duration: 0.55s;
  }

  @keyframes da-spin {
    to { transform: rotate(360deg); }
  }

  .da-queued-label {
    flex: 1;
    font-style: italic;
    opacity: 0.9;
  }

  .da-btn-cancel {
    flex-shrink: 0;
    background: none;
    border: 1px solid rgba(180, 83, 9, 0.35);
    border-radius: var(--radius-sm, 8px);
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
    color: #b45309;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    white-space: nowrap;
    line-height: 1.5;
  }

  .da-btn-cancel:hover {
    background: rgba(180, 83, 9, 0.08);
    border-color: #b45309;
  }

  .da-btn-cancel:focus-visible {
    outline: 2px solid #b45309;
    outline-offset: 2px;
  }

  /* ─── 결정 완료 배지 ─── */
  .da-result {
    display: flex;
    justify-content: flex-end;
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border-top: 1px solid var(--line, rgba(15, 23, 42, 0.08));
    background: rgba(248, 248, 250, 0.5);
  }

  .da-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 999px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .da-badge-icon {
    font-size: 10px;
    font-weight: 900;
    line-height: 1;
  }

  .da-badge--approved {
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
    border: 1px solid rgba(22, 163, 74, 0.3);
  }

  .da-badge--rejected {
    background: rgba(220, 38, 38, 0.1);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.25);
  }

  /* ─── 반응형 ─── */
  @media (max-width: 480px) {
    .da-actions {
      justify-content: stretch;
    }

    .da-btn {
      flex: 1;
      justify-content: center;
    }
  }
`;
