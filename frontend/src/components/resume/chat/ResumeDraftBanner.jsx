/**
 * ResumeDraftBanner — 채팅 세션의 초안 컨텍스트 표시 배너 (Sub-AC 2-3 진행 상태 지원)
 *
 * 저장된 이력서 초안(ResumeDraft)이 존재할 때 채팅 상단에 표시된다.
 * 초안의 날짜 범위, 분석된 커밋 수, 강점 후보 수를 요약해 보여주며
 * 사용자가 초안 유무를 한눈에 파악할 수 있게 한다.
 *
 * 백그라운드 생성 중일 때는 진행 단계(stage)와 데이터 소스 통계를 실시간으로 보여준다.
 *
 * Props:
 *   draft     — ResumeDraft | null  로드된 초안 (null이면 렌더링 안 함)
 *   loading   — boolean             로딩 중 여부
 *   generating — boolean            백그라운드 생성 중 여부 (Sub-AC 2-3)
 *   error     — string | null       에러 메시지
 *   progress  — object | null       생성 진행 상태 { stage, datesLoaded, commitCount, ... } (Sub-AC 2-3)
 *   onDismiss — () => void          배너를 닫는 콜백 (선택)
 */

/** 진행 단계 → 사용자 친화적 레이블 매핑 */
const STAGE_LABELS = {
  initializing: '초기화 중…',
  loading_resume: '이력서 로드 중…',
  building_context: '업무 데이터 수집 및 분석 중…',
  loading_work_logs: '업무 로그 불러오는 중…',
  aggregating_signals: '시그널 취합 중…',
  calling_llm: 'AI가 초안 생성 중…',
  saving: '결과 저장 중…',
  done: '완료!',
  failed: '실패',
};

export function ResumeDraftBanner({ draft, loading, generating, error, progress, onDismiss }) {
  // 백그라운드 생성 중 (Sub-AC 2-3)
  if (generating) {
    const stageLabel = progress?.stage ? (STAGE_LABELS[progress.stage] || progress.stage) : '초안 생성 중…';
    const hasStats = progress && (progress.datesLoaded || progress.commitCount);

    return (
      <div class="rdb-root rdb-root--generating" role="status" aria-label="초안 생성 중">
        <div class="rdb-gen-header">
          <span class="rdb-spinner" aria-hidden="true" />
          <span class="rdb-gen-text">{stageLabel}</span>
        </div>
        {hasStats && (
          <div class="rdb-gen-stats">
            {progress.datesLoaded > 0 && (
              <span class="rdb-gen-stat">{progress.datesLoaded}일치 로드</span>
            )}
            {progress.commitCount > 0 && (
              <span class="rdb-gen-stat">커밋 {progress.commitCount}개</span>
            )}
            {progress.slackCount > 0 && (
              <span class="rdb-gen-stat">슬랙 {progress.slackCount}개</span>
            )}
            {progress.sessionCount > 0 && (
              <span class="rdb-gen-stat">세션 {progress.sessionCount}개</span>
            )}
          </div>
        )}
        <style>{RDB_CSS}</style>
      </div>
    );
  }

  if (loading) {
    return (
      <div class="rdb-root rdb-root--loading" role="status" aria-label="초안 로딩 중">
        <span class="rdb-spinner" aria-hidden="true" />
        <span class="rdb-loading-text">업무 기록에서 이력서 초안을 불러오는 중…</span>
        <style>{RDB_CSS}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div class="rdb-root rdb-root--error" role="alert">
        <span class="rdb-icon" aria-hidden="true">⚠️</span>
        <span class="rdb-error-text">초안 로드 실패: {error}</span>
        <style>{RDB_CSS}</style>
      </div>
    );
  }

  if (!draft) {
    return (
      <div class="rdb-root rdb-root--empty">
        <span class="rdb-icon" aria-hidden="true">📋</span>
        <span class="rdb-empty-text">
          저장된 초안이 없습니다.{' '}
          <a href="/resume/chat" class="rdb-generate-link" data-generate="true">
            초안 생성하기 →
          </a>
        </span>
        <style>{RDB_CSS}</style>
      </div>
    );
  }

  const { dateRange, sources, strengthCandidates = [], dataGaps = [] } = draft;
  const fromLabel = dateRange?.from ?? '?';
  const toLabel = dateRange?.to ?? '?';
  const commitCount = sources?.commitCount ?? 0;
  const candidateCount = strengthCandidates.length;
  const gapCount = dataGaps.length;

  return (
    <div class="rdb-root rdb-root--loaded" role="complementary" aria-label="이력서 초안 컨텍스트">
      <div class="rdb-header">
        <span class="rdb-icon" aria-hidden="true">✅</span>
        <span class="rdb-title">이력서 초안 로드됨</span>
        <span class="rdb-date-range">
          {fromLabel} ~ {toLabel}
        </span>
        {onDismiss && (
          <button
            class="rdb-dismiss"
            type="button"
            onClick={onDismiss}
            aria-label="배너 닫기"
          >
            ×
          </button>
        )}
      </div>

      <div class="rdb-stats">
        <StatChip
          label="커밋"
          value={commitCount}
          suffix="개"
          aria="분석된 커밋 수"
        />
        <StatChip
          label="강점 후보"
          value={candidateCount}
          suffix="개"
          aria="발견된 강점 후보 수"
        />
        {gapCount > 0 && (
          <StatChip
            label="보충 필요"
            value={gapCount}
            suffix="항목"
            aria="데이터 보충이 필요한 항목 수"
            warn
          />
        )}
      </div>

      {dataGaps.length > 0 && (
        <ul class="rdb-gaps" aria-label="데이터 보충 필요 항목">
          {dataGaps.slice(0, 2).map((gap, i) => (
            <li key={i} class="rdb-gap-item">
              <span class="rdb-gap-icon" aria-hidden="true">❓</span>
              {gap}
            </li>
          ))}
          {dataGaps.length > 2 && (
            <li class="rdb-gap-more">…외 {dataGaps.length - 2}개</li>
          )}
        </ul>
      )}

      <style>{RDB_CSS}</style>
    </div>
  );
}

function StatChip({ label, value, suffix = '', aria, warn = false }) {
  return (
    <span
      class={`rdb-chip${warn ? ' rdb-chip--warn' : ''}`}
      aria-label={`${aria ?? label}: ${value}${suffix}`}
    >
      <span class="rdb-chip-label">{label}</span>
      <span class="rdb-chip-value">{value}{suffix}</span>
    </span>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const RDB_CSS = `
  .rdb-root {
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    background: rgba(30, 64, 175, 0.04);
    flex-shrink: 0;
  }

  .rdb-root--loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--muted);
  }

  /* Sub-AC 2-3: background generation progress styles */
  .rdb-root--generating {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: rgba(59, 130, 246, 0.06);
    border-color: rgba(59, 130, 246, 0.2);
  }

  .rdb-gen-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .rdb-gen-text {
    font-size: 12px;
    font-weight: 500;
    color: #2563eb;
    line-height: 1.4;
  }

  .rdb-gen-stats {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding-left: 22px;
  }

  .rdb-gen-stat {
    font-size: 11px;
    color: var(--muted);
    background: rgba(59, 130, 246, 0.08);
    padding: 1px 6px;
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
  }

  .rdb-root--error {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: #fef2f2;
    border-color: #fecaca;
  }

  .rdb-root--empty {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--muted);
    background: var(--surface);
  }

  .rdb-root--loaded {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* Loading spinner */
  .rdb-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: rdb-spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes rdb-spin {
    to { transform: rotate(360deg); }
  }

  .rdb-loading-text,
  .rdb-error-text,
  .rdb-empty-text {
    font-size: 12px;
    line-height: 1.4;
  }

  .rdb-error-text { color: #dc2626; }

  .rdb-generate-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }

  .rdb-generate-link:hover { text-decoration: underline; }

  /* Header row */
  .rdb-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .rdb-icon { flex-shrink: 0; line-height: 1; }

  .rdb-title {
    font-weight: 600;
    color: #1e40af;
    font-size: 12px;
    letter-spacing: 0.02em;
  }

  .rdb-date-range {
    font-size: 11px;
    color: var(--muted);
    background: var(--line);
    padding: 1px 6px;
    border-radius: 10px;
    font-variant-numeric: tabular-nums;
  }

  .rdb-dismiss {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    transition: color 0.12s;
  }

  .rdb-dismiss:hover { color: var(--ink); }

  /* Stats row */
  .rdb-stats {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .rdb-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(30, 64, 175, 0.08);
    border: 1px solid rgba(30, 64, 175, 0.2);
    border-radius: 10px;
    padding: 2px 8px;
    font-size: 11px;
  }

  .rdb-chip--warn {
    background: rgba(234, 179, 8, 0.1);
    border-color: rgba(234, 179, 8, 0.3);
  }

  .rdb-chip-label {
    color: var(--muted);
  }

  .rdb-chip-value {
    font-weight: 600;
    color: #1e40af;
    font-variant-numeric: tabular-nums;
  }

  .rdb-chip--warn .rdb-chip-value {
    color: #a16207;
  }

  /* Data gaps */
  .rdb-gaps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .rdb-gap-item {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    font-size: 11px;
    color: #a16207;
    line-height: 1.4;
  }

  .rdb-gap-icon { flex-shrink: 0; font-size: 10px; margin-top: 1px; }

  .rdb-gap-more {
    font-size: 11px;
    color: var(--muted);
    padding-left: 17px;
  }
`;
