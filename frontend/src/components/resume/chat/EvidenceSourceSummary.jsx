/**
 * EvidenceSourceSummary — 근거 출처 요약 바 컴포넌트
 *
 * 어시스턴트 응답에 포함된 citations를 소스 유형별로 집계하여
 * 메시지 버블과 상세 SourceCitations 사이에 한 줄로 요약 표시한다.
 *
 * 표시 형태: "📎 커밋 3 · 슬랙 2 · 세션 1"
 *
 * Props:
 *   citations — Array  출처 배열 (SourceCitations와 동일한 데이터)
 *   compact   — boolean  (기본 true) 한 줄 모드. false면 약간 더 넓은 레이아웃.
 */
export function EvidenceSourceSummary({ citations = [], compact = true }) {
  if (!Array.isArray(citations) || citations.length === 0) return null;

  // 소스 유형별 집계
  const counts = { commits: 0, slack: 0, sessions: 0 };
  for (const c of citations) {
    const src = c.source || 'sessions';
    if (src === 'commits') counts.commits++;
    else if (src === 'slack') counts.slack++;
    else counts.sessions++;
  }

  const parts = [];
  if (counts.commits > 0) parts.push({ icon: '\u2325', label: '\ucee4\ubc0b', count: counts.commits, cls: 'ess-chip--commit' });
  if (counts.slack > 0) parts.push({ icon: '#', label: '\uc2ac\ub799', count: counts.slack, cls: 'ess-chip--slack' });
  if (counts.sessions > 0) parts.push({ icon: '\ud83e\udd16', label: '\uc138\uc158', count: counts.sessions, cls: 'ess-chip--session' });

  if (parts.length === 0) return null;

  return (
    <div class={`ess-root${compact ? ' ess-root--compact' : ''}`} aria-label={`근거 출처 ${citations.length}건 요약`}>
      <span class="ess-icon" aria-hidden="true">📎</span>
      <span class="ess-label">근거 {citations.length}건</span>
      <span class="ess-sep" aria-hidden="true">—</span>
      {parts.map((p, i) => (
        <span key={p.label} class={`ess-chip ${p.cls}`}>
          <span class="ess-chip-icon" aria-hidden="true">{p.icon}</span>
          <span class="ess-chip-label">{p.label}</span>
          <span class="ess-chip-count">{p.count}</span>
          {i < parts.length - 1 && <span class="ess-dot" aria-hidden="true">·</span>}
        </span>
      ))}
      <style>{ESS_CSS}</style>
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const ESS_CSS = `
  /* ─── Root ─── */
  .ess-root {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    margin-top: 4px;
    font-size: 11px;
    color: var(--muted, #64748b);
    border-radius: var(--radius-sm, 8px);
    background: rgba(15, 23, 42, 0.025);
    transition: background 0.12s;
    flex-wrap: wrap;
  }

  .ess-root:hover {
    background: rgba(15, 23, 42, 0.05);
  }

  .ess-root--compact {
    padding: 3px 6px;
    font-size: 10px;
    gap: 4px;
  }

  /* ─── Icon & label ─── */
  .ess-icon {
    font-size: 11px;
    line-height: 1;
    flex-shrink: 0;
  }

  .ess-root--compact .ess-icon {
    font-size: 10px;
  }

  .ess-label {
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--ink, #1e293b);
    opacity: 0.7;
    flex-shrink: 0;
  }

  .ess-sep {
    color: var(--line-strong, rgba(15, 23, 42, 0.14));
    font-size: 9px;
    flex-shrink: 0;
  }

  /* ─── Source chip ─── */
  .ess-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
  }

  .ess-chip-icon {
    font-size: 9px;
    line-height: 1;
  }

  .ess-chip-label {
    font-size: 10px;
    font-weight: 500;
  }

  .ess-root--compact .ess-chip-label {
    font-size: 9px;
  }

  .ess-chip-count {
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .ess-root--compact .ess-chip-count {
    font-size: 9px;
  }

  /* ─── Chip color variants ─── */
  .ess-chip--commit .ess-chip-label,
  .ess-chip--commit .ess-chip-count {
    color: #1e40af;
  }

  .ess-chip--slack .ess-chip-label,
  .ess-chip--slack .ess-chip-count {
    color: #92400e;
  }

  .ess-chip--session .ess-chip-label,
  .ess-chip--session .ess-chip-count {
    color: #065f46;
  }

  /* ─── Dot separator ─── */
  .ess-dot {
    color: var(--muted, #64748b);
    font-size: 12px;
    font-weight: 700;
    margin-left: 2px;
    opacity: 0.5;
  }

  /* ─── Print ─── */
  @media print {
    .ess-root {
      display: none;
    }
  }
`;
