import { useState } from 'preact/hooks';

/**
 * StrengthsSectionViewer — 강점(Strengths) 섹션 제안 표시 + approve/reject 컴포넌트 (Sub-AC 8-1)
 *
 * 어시스턴트가 강점 섹션 제안을 반환할 때 채팅 메시지에 삽입된다.
 * 기존 강점과 제안된 강점을 카드 형태로 나란히 표시하고,
 * 사용자가 approve 또는 reject 버튼으로 결정한다.
 *
 * Props:
 *   strengths     — StrengthItem[]  제안된 강점 목록
 *   before        — string          현재 강점 텍스트 표현 (비교용)
 *   evidence      — string[]        수정 근거 목록 (optional)
 *   onApprove     — () => void      승인 버튼 클릭 콜백
 *   onReject      — () => void      거절 버튼 클릭 콜백
 *   status        — 'pending' | 'queued' | 'approved' | 'rejected'  (기본값: 'pending')
 *
 * StrengthItem 구조:
 *   id              — string    "str-{index}"
 *   label           — string    강점 이름
 *   description     — string    행동 패턴 설명
 *   evidenceTexts   — string[]  뒷받침하는 근거 텍스트
 *   behaviorCluster — string[]  관련 행동 패턴 태그
 *   frequency       — number    근거 등장 빈도
 *   confidence      — number    0.0–1.0
 */
export function StrengthsSectionViewer({
  strengths = [],
  before = '',
  evidence = [],
  onApprove,
  onReject,
  status = 'pending',
}) {
  const [showBefore, setShowBefore] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const isPending = status === 'pending';
  const isQueued = status === 'queued';
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';
  const isActive = isPending || isQueued;

  /* ─── 헤더 아이콘 ─── */
  function getHeaderIcon() {
    if (isApproved) return '✓';
    if (isRejected) return '✕';
    if (isQueued) return '⏳';
    return '◈';
  }

  /* ─── 상태 배지 ─── */
  function getStatusBadge() {
    if (isApproved) return { label: '승인됨', mod: 'approved' };
    if (isRejected) return { label: '거절됨', mod: 'rejected' };
    if (isQueued) return { label: '반영 대기', mod: 'queued' };
    return null;
  }

  const badge = getStatusBadge();
  const rootMod = isRejected ? 'rejected' : isApproved ? 'approved' : isQueued ? 'queued' : 'pending';

  return (
    <div class={`ssv-root ssv-root--${rootMod}`} aria-label="강점 섹션 제안">
      {/* ── 헤더 ── */}
      <div class="ssv-header">
        <span class="ssv-header-icon" aria-hidden="true">{getHeaderIcon()}</span>
        <span class="ssv-section-label">강점(Strengths) 섹션 제안</span>
        <span class="ssv-count-badge">{strengths.length}개</span>
        {badge && (
          <span class={`ssv-status-badge ssv-status-badge--${badge.mod}`}>
            {badge.label}
          </span>
        )}
      </div>

      {/* ── 강점 카드 목록 ── */}
      <div class="ssv-cards">
        {strengths.map((str, i) => (
          <StrengthCard key={str.id ?? i} strength={str} index={i} isActive={isActive} />
        ))}

        {strengths.length === 0 && (
          <p class="ssv-empty">(제안된 강점이 없습니다)</p>
        )}
      </div>

      {/* ── 현재 강점과 비교 ── */}
      {before && (
        <div class="ssv-compare-wrap">
          <button
            class="ssv-compare-toggle"
            type="button"
            onClick={() => setShowBefore(!showBefore)}
            aria-expanded={showBefore}
          >
            {showBefore ? '현재 강점 숨기기' : '현재 강점과 비교'}
            <span class="ssv-toggle-arrow" aria-hidden="true">
              {showBefore ? '▲' : '▼'}
            </span>
          </button>
          {showBefore && (
            <pre class="ssv-before-text">{before}</pre>
          )}
        </div>
      )}

      {/* ── 근거 섹션 ── */}
      {evidence.length > 0 && (
        <div class="ssv-evidence-wrap">
          <button
            class="ssv-evidence-toggle"
            type="button"
            onClick={() => setShowEvidence(!showEvidence)}
            aria-expanded={showEvidence}
          >
            {showEvidence ? '근거 숨기기' : `근거 보기 (${evidence.length}건)`}
            <span class="ssv-toggle-arrow" aria-hidden="true">
              {showEvidence ? '▲' : '▼'}
            </span>
          </button>
          {showEvidence && (
            <ul class="ssv-evidence-list" aria-label="강점 근거 목록">
              {evidence.map((ev, i) => (
                <li key={i} class="ssv-evidence-item">
                  <span class="ssv-evidence-dot" aria-hidden="true" />
                  <span>{ev}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Approve / Reject 버튼 ── */}
      {isPending && strengths.length > 0 && (
        <div class="ssv-actions" role="group" aria-label="강점 제안 결정">
          <button
            class="ssv-btn ssv-btn--approve"
            type="button"
            onClick={onApprove}
            aria-label="강점 제안 승인"
            title="이 강점 목록을 이력서에 반영합니다"
          >
            <span class="ssv-btn-icon" aria-hidden="true">✓</span>
            승인
          </button>
          <button
            class="ssv-btn ssv-btn--reject"
            type="button"
            onClick={onReject}
            aria-label="강점 제안 거절"
            title="이 제안을 무시합니다"
          >
            <span class="ssv-btn-icon" aria-hidden="true">✕</span>
            거절
          </button>
        </div>
      )}

      <style>{SSV_CSS}</style>
    </div>
  );
}

/* ── 개별 강점 카드 ──────────────────────────────────────────────────────────── */

/**
 * @param {{
 *   strength: import('./StrengthsSectionViewer.jsx').StrengthItem,
 *   index: number,
 *   isActive: boolean,
 * }} props
 */
function StrengthCard({ strength, index, isActive }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const { label, description, evidenceTexts = [], behaviorCluster = [], frequency, confidence } = strength;

  /* 신뢰도에 따른 별 표시 */
  const stars = confidence >= 0.8 ? '★★★' : confidence >= 0.5 ? '★★' : '★';

  return (
    <div class={`ssv-card${isActive ? ' ssv-card--active' : ''}`}>
      <div class="ssv-card-header">
        <span class="ssv-card-index" aria-hidden="true">{index + 1}</span>
        <span class="ssv-card-label">{label}</span>
        <span class="ssv-card-meta">
          {frequency > 1 && (
            <span class="ssv-freq-badge" title={`${frequency}건 이상의 근거`}>
              ×{frequency}
            </span>
          )}
          <span class="ssv-stars" title={`신뢰도: ${(confidence * 100).toFixed(0)}%`} aria-label={`신뢰도 ${stars}`}>
            {stars}
          </span>
        </span>
      </div>

      {description && (
        <p class="ssv-card-desc">{description}</p>
      )}

      {behaviorCluster.length > 0 && (
        <div class="ssv-behavior-chips" aria-label="행동 패턴 태그">
          {behaviorCluster.map((b, i) => (
            <span key={i} class="ssv-chip">{b}</span>
          ))}
        </div>
      )}

      {evidenceTexts.length > 0 && (
        <>
          <button
            class="ssv-evidence-toggle-card"
            type="button"
            onClick={() => setShowEvidence(!showEvidence)}
            aria-expanded={showEvidence}
          >
            {showEvidence ? '근거 숨기기' : `근거 보기 (${evidenceTexts.length}건)`}
          </button>
          {showEvidence && (
            <ul class="ssv-card-evidence-list">
              {evidenceTexts.map((ev, i) => (
                <li key={i} class="ssv-card-evidence-item">
                  <span class="ssv-card-evidence-dot" aria-hidden="true" />
                  {ev}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const SSV_CSS = `
  /* ─── Root ─── */
  .ssv-root {
    border-radius: var(--radius-md);
    border: 1px solid var(--line-strong);
    background: rgba(255, 255, 255, 0.97);
    overflow: hidden;
    font-size: 13px;
    margin: var(--space-2) 0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
    transition: box-shadow 0.15s, border-color 0.2s, background 0.2s;
  }

  .ssv-root--approved {
    border-color: #86efac;
    background: rgba(240, 253, 244, 0.95);
  }

  .ssv-root--rejected {
    border-color: #fca5a5;
    background: rgba(254, 242, 242, 0.95);
    opacity: 0.75;
  }

  .ssv-root--queued {
    border-color: #fcd34d;
    background: rgba(255, 251, 235, 0.95);
  }

  /* ─── 헤더 ─── */
  .ssv-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: rgba(248, 246, 242, 0.9);
    border-bottom: 1px solid var(--line);
  }

  .ssv-root--approved .ssv-header {
    background: rgba(220, 252, 231, 0.8);
    border-color: #86efac;
  }

  .ssv-root--rejected .ssv-header {
    background: rgba(254, 226, 226, 0.8);
    border-color: #fca5a5;
  }

  .ssv-root--queued .ssv-header {
    background: rgba(254, 243, 199, 0.8);
    border-color: #fcd34d;
  }

  .ssv-header-icon {
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    flex-shrink: 0;
    line-height: 1;
  }

  .ssv-root--approved .ssv-header-icon { color: #16a34a; }
  .ssv-root--rejected .ssv-header-icon { color: #dc2626; }
  .ssv-root--queued .ssv-header-icon   { color: #d97706; }

  .ssv-section-label {
    flex: 1;
    font-weight: 700;
    font-size: 12px;
    color: var(--ink-strong);
    letter-spacing: -0.01em;
  }

  .ssv-count-badge {
    font-size: 10px;
    font-weight: 700;
    color: var(--accent);
    background: rgba(30, 64, 175, 0.08);
    border-radius: 999px;
    padding: 2px 7px;
    flex-shrink: 0;
  }

  /* ─── 상태 배지 ─── */
  .ssv-status-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .ssv-status-badge--approved {
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
    border: 1px solid rgba(22, 163, 74, 0.3);
  }

  .ssv-status-badge--rejected {
    background: rgba(220, 38, 38, 0.1);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.25);
  }

  .ssv-status-badge--queued {
    background: rgba(217, 119, 6, 0.1);
    color: #d97706;
    border: 1px solid rgba(217, 119, 6, 0.3);
  }

  /* ─── 카드 목록 ─── */
  .ssv-cards {
    padding: var(--space-3) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .ssv-empty {
    padding: var(--space-2) var(--space-3);
    color: var(--muted);
    font-style: italic;
    margin: 0;
    text-align: center;
  }

  /* ─── 개별 강점 카드 ─── */
  .ssv-card {
    padding: var(--space-3) var(--space-4);
    background: rgba(248, 248, 252, 0.8);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    transition: box-shadow 0.12s, border-color 0.12s;
  }

  .ssv-card--active {
    border-color: rgba(30, 64, 175, 0.2);
    background: rgba(239, 246, 255, 0.5);
  }

  .ssv-root--approved .ssv-card {
    border-color: rgba(22, 163, 74, 0.2);
    background: rgba(240, 253, 244, 0.7);
  }

  .ssv-root--rejected .ssv-card {
    border-color: rgba(220, 38, 38, 0.15);
    background: rgba(254, 242, 242, 0.5);
  }

  .ssv-card-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .ssv-card-index {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .ssv-root--approved .ssv-card-index { background: #16a34a; }
  .ssv-root--rejected .ssv-card-index { background: #dc2626; }

  .ssv-card-label {
    flex: 1;
    font-size: 13px;
    font-weight: 700;
    color: var(--ink-strong);
    line-height: 1.4;
  }

  .ssv-card-meta {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .ssv-freq-badge {
    font-size: 10px;
    font-weight: 700;
    color: #1e40af;
    background: rgba(30, 64, 175, 0.1);
    border-radius: 999px;
    padding: 1px 6px;
  }

  .ssv-stars {
    font-size: 11px;
    color: #f59e0b;
    letter-spacing: -1px;
  }

  .ssv-card-desc {
    margin: 0;
    font-size: 12px;
    color: var(--ink);
    line-height: 1.65;
  }

  /* ─── 행동 패턴 태그 ─── */
  .ssv-behavior-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .ssv-chip {
    font-size: 10px;
    color: #1e40af;
    background: rgba(30, 64, 175, 0.08);
    border: 1px solid rgba(30, 64, 175, 0.15);
    border-radius: 999px;
    padding: 1px 7px;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }

  /* ─── 카드 내 근거 토글 ─── */
  .ssv-evidence-toggle-card {
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
    text-align: left;
    width: fit-content;
    transition: opacity 0.12s;
  }

  .ssv-evidence-toggle-card:hover { opacity: 0.75; }

  .ssv-card-evidence-list {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: rgba(248, 246, 240, 0.8);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }

  .ssv-card-evidence-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.55;
  }

  .ssv-card-evidence-dot {
    flex-shrink: 0;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 4px;
  }

  /* ─── 비교·근거 섹션 ─── */
  .ssv-compare-wrap,
  .ssv-evidence-wrap {
    border-top: 1px solid var(--line);
    padding: var(--space-2) var(--space-3);
  }

  .ssv-compare-toggle,
  .ssv-evidence-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
    transition: opacity 0.12s;
  }

  .ssv-compare-toggle:hover,
  .ssv-evidence-toggle:hover { opacity: 0.75; }

  .ssv-toggle-arrow {
    font-size: 9px;
    text-decoration: none;
  }

  .ssv-before-text {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) var(--space-3);
    background: rgba(248, 246, 240, 0.8);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
    font-family: inherit;
    font-size: 11px;
    color: var(--muted);
    white-space: pre-wrap;
    line-height: 1.6;
    max-height: 180px;
    overflow-y: auto;
  }

  .ssv-evidence-list {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) var(--space-3);
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: rgba(248, 246, 240, 0.8);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }

  .ssv-evidence-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.55;
  }

  .ssv-evidence-dot {
    flex-shrink: 0;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 4px;
  }

  /* ─── Actions ─── */
  .ssv-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--line);
    background: rgba(248, 248, 250, 0.8);
    justify-content: flex-end;
  }

  .ssv-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
    border: 1.5px solid transparent;
    cursor: pointer;
    transition: background 0.13s, border-color 0.13s, transform 0.1s;
    user-select: none;
  }

  .ssv-btn:active { transform: scale(0.97); }

  .ssv-btn-icon {
    font-size: 12px;
    line-height: 1;
    font-weight: 900;
  }

  .ssv-btn--approve {
    background: rgba(22, 163, 74, 0.1);
    border-color: rgba(22, 163, 74, 0.4);
    color: #166534;
  }

  .ssv-btn--approve:hover {
    background: #16a34a;
    border-color: #16a34a;
    color: #fff;
    box-shadow: 0 2px 8px rgba(22, 163, 74, 0.3);
  }

  .ssv-btn--reject {
    background: rgba(100, 100, 100, 0.06);
    border-color: rgba(100, 100, 100, 0.2);
    color: var(--muted);
  }

  .ssv-btn--reject:hover {
    background: rgba(220, 38, 38, 0.08);
    border-color: rgba(220, 38, 38, 0.3);
    color: #dc2626;
  }

  /* ─── 반응형 ─── */
  @media (max-width: 480px) {
    .ssv-actions { justify-content: stretch; }
    .ssv-btn { flex: 1; justify-content: center; }
  }
`;
