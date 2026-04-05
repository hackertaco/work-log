import { useState, useEffect } from 'preact/hooks';
import { useDraftContext } from '../../../hooks/useDraftContext.js';

/**
 * ResumeDraftPanel — 채팅 화면 진입 시 초안 생성 결과를 표시하는 패널
 *
 * useDraftContext 훅을 사용해 초안 로딩 및 자동 생성을 관리한다:
 *   1. GET /api/resume/chat/generate-draft → 캐시된 초안 조회
 *   2. 캐시 없으면(404) POST /api/resume/chat/generate-draft → 신규 생성
 * 결과:
 *   - strengthCandidates: 강점 후보 카드 목록
 *   - experienceSummaries: 경력별 요약 카드 목록
 *   - suggestedSummary: 직업 요약 제안
 *   - dataGaps: 보충 필요 항목
 *
 * Props:
 *   onDraftReady  — (draft: ResumeDraft) => void  초안 로딩 완료 콜백
 */
/** 파이프라인 단계 → 한국어 레이블 매핑 */
const STAGE_LABELS = {
  initializing: '초기화',
  loading_resume: '기존 이력서 로딩',
  building_context: '업무 로그 분석',
  loading_work_logs: '업무 로그 로딩',
  calling_llm: 'AI 분석 중',
  saving: '저장 중',
  done: '완료',
};

export function ResumeDraftPanel({ onDraftReady }) {
  const {
    draft,
    status: hookStatus,
    loading: isLoading,
    generating: isGenerating,
    progress,
    error: errorMsg,
    generate,
  } = useDraftContext({ autoGenerate: true });
  const [collapsed, setCollapsed] = useState(false);

  // 초안 로딩 완료 시 부모에게 알림
  useEffect(() => {
    if (hookStatus === 'ready' && draft) {
      onDraftReady?.(draft);
    }
  }, [hookStatus, draft, onDraftReady]);

  // hookStatus를 기존 status와 호환되도록 매핑
  const status = hookStatus === 'ready' ? 'loaded'
    : hookStatus === 'error' ? 'error'
    : 'loading'; // idle, loading, generating 모두 로딩으로 표시

  /** 재시도 — 강제 재생성 */
  function loadDraft() {
    generate();
  }

  /* ─── 로딩 상태 ─────────────────────────────────────────────────────────── */
  if (status === 'loading') {
    return (
      <div class="rdp-root rdp-root--loading" aria-busy="true" aria-label="초안 분석 중">
        <div class="rdp-loading-header">
          <span class="rdp-loading-spinner" aria-hidden="true" />
          <span class="rdp-loading-label">
            {isGenerating
              ? `업무 로그에서 강점·경력 초안 생성 중…${progress?.stage ? ` (${STAGE_LABELS[progress.stage] ?? progress.stage})` : ' (최대 30초)'}`
              : '초안 데이터 불러오는 중…'}
          </span>
        </div>
        <div class="rdp-skeleton-grid">
          <div class="rdp-skeleton rdp-skeleton--card" />
          <div class="rdp-skeleton rdp-skeleton--card" />
          <div class="rdp-skeleton rdp-skeleton--card rdp-skeleton--wide" />
        </div>
        <style>{RDP_CSS}</style>
      </div>
    );
  }

  /* ─── 오류 상태 ─────────────────────────────────────────────────────────── */
  if (status === 'error') {
    return (
      <div class="rdp-root rdp-root--error" role="alert">
        <p class="rdp-error-msg">
          <span class="rdp-error-icon" aria-hidden="true">⚠</span>
          초안 생성 실패: {errorMsg}
        </p>
        <button class="rdp-retry-btn" onClick={loadDraft} type="button">
          다시 시도
        </button>
        <style>{RDP_CSS}</style>
      </div>
    );
  }

  /* ─── 데이터 없음 ────────────────────────────────────────────────────────── */
  if (!draft) return null;

  const {
    strengthCandidates = [],
    experienceSummaries = [],
    suggestedSummary = '',
    dataGaps = [],
    sources = {},
    dateRange = {},
    generatedAt,
  } = draft;

  const { commitCount = 0, sessionCount = 0, slackCount = 0, repos = [] } = sources;
  const dateFrom = dateRange.from ?? '';
  const dateTo = dateRange.to ?? '';

  return (
    <div class={`rdp-root rdp-root--loaded${collapsed ? ' rdp-root--collapsed' : ''}`}>
      {/* ── 헤더 ── */}
      <div class="rdp-header">
        <div class="rdp-header-left">
          <span class="rdp-check-icon" aria-hidden="true">✦</span>
          <h2 class="rdp-title">이력서 초안 분석 완료</h2>
        </div>
        <div class="rdp-header-meta">
          {dateFrom && dateTo && (
            <span class="rdp-meta-chip">{dateFrom} ~ {dateTo}</span>
          )}
          {commitCount > 0 && (
            <span class="rdp-meta-chip">커밋 {commitCount}개</span>
          )}
          {sessionCount > 0 && (
            <span class="rdp-meta-chip">세션 {sessionCount}개</span>
          )}
          {slackCount > 0 && (
            <span class="rdp-meta-chip">슬랙 {slackCount}건</span>
          )}
        </div>
        <button
          class="rdp-collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? '초안 결과 펼치기' : '초안 결과 접기'}
          title={collapsed ? '펼치기' : '접기'}
        >
          <svg
            class={`rdp-collapse-icon${collapsed ? ' rdp-collapse-icon--up' : ''}`}
            viewBox="0 0 16 16"
            fill="currentColor"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path d="M4.293 5.293a1 1 0 011.414 0L8 7.586l2.293-2.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" />
          </svg>
        </button>
      </div>

      {/* ── 본문 (접히면 숨김) ── */}
      {!collapsed && (
        <div class="rdp-body">
          {/* 전문 요약 제안 */}
          {suggestedSummary && (
            <section class="rdp-section rdp-section--summary">
              <h3 class="rdp-section-title">직업 요약 제안</h3>
              <blockquote class="rdp-summary-quote">{suggestedSummary}</blockquote>
            </section>
          )}

          {/* 강점 후보 */}
          {strengthCandidates.length > 0 && (
            <section class="rdp-section">
              <h3 class="rdp-section-title">
                강점 후보
                <span class="rdp-section-count">{strengthCandidates.length}건</span>
              </h3>
              <div class="rdp-card-grid">
                {strengthCandidates.map((cand) => (
                  <StrengthCandidateCard key={cand.id} candidate={cand} />
                ))}
              </div>
            </section>
          )}

          {/* 경력별 요약 */}
          {experienceSummaries.length > 0 && (
            <section class="rdp-section">
              <h3 class="rdp-section-title">
                경력별 요약
                <span class="rdp-section-count">{experienceSummaries.length}개 회사</span>
              </h3>
              <div class="rdp-exp-list">
                {experienceSummaries.map((exp, i) => (
                  <ExperienceSummaryCard key={exp.company + i} summary={exp} />
                ))}
              </div>
            </section>
          )}

          {/* 보충 필요 항목 */}
          {dataGaps.length > 0 && (
            <section class="rdp-section rdp-section--gaps">
              <h3 class="rdp-section-title">
                보충 질문 권장
                <span class="rdp-section-count">{dataGaps.length}건</span>
              </h3>
              <ul class="rdp-gap-list">
                {dataGaps.map((gap, i) => (
                  <li key={i} class="rdp-gap-item">
                    <span class="rdp-gap-icon" aria-hidden="true">?</span>
                    {gap}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 생성 시각 */}
          {generatedAt && (
            <p class="rdp-footer-note">
              분석 기준:{' '}
              <time dateTime={generatedAt}>
                {new Date(generatedAt).toLocaleString('ko-KR', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              {' '}·{' '}
              <button class="rdp-refresh-btn" onClick={loadDraft} type="button">
                재분석
              </button>
            </p>
          )}
        </div>
      )}

      <style>{RDP_CSS}</style>
    </div>
  );
}

/* ── 강점 후보 카드 ────────────────────────────────────────────────────────── */

function StrengthCandidateCard({ candidate }) {
  const { label, description, frequency, behaviorCluster = [], evidenceExamples = [] } = candidate;
  const [showEvidence, setShowEvidence] = useState(false);

  return (
    <div class="rdp-str-card">
      <div class="rdp-str-top">
        <span class="rdp-str-label">{label}</span>
        <span class="rdp-freq-badge" title={`${frequency}회 이상 등장`}>
          ×{frequency}
        </span>
      </div>

      {description && <p class="rdp-str-desc">{description}</p>}

      {behaviorCluster.length > 0 && (
        <div class="rdp-behavior-chips">
          {behaviorCluster.map((b, i) => (
            <span key={i} class="rdp-chip">{b}</span>
          ))}
        </div>
      )}

      {evidenceExamples.length > 0 && (
        <>
          <button
            class="rdp-evidence-toggle"
            onClick={() => setShowEvidence(!showEvidence)}
            type="button"
            aria-expanded={showEvidence}
          >
            {showEvidence ? '근거 숨기기' : `근거 보기 (${evidenceExamples.length}건)`}
          </button>
          {showEvidence && (
            <ul class="rdp-evidence-list">
              {evidenceExamples.map((ex, i) => (
                <li key={i} class="rdp-evidence-item">
                  <span class="rdp-evidence-dot" aria-hidden="true" />
                  {ex}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/* ── 경력별 요약 카드 ──────────────────────────────────────────────────────── */

function ExperienceSummaryCard({ summary }) {
  const { company, highlights = [], skills = [], suggestedBullets = [], dates = [] } = summary;
  const [showBullets, setShowBullets] = useState(false);

  return (
    <div class="rdp-exp-card">
      <div class="rdp-exp-header">
        <span class="rdp-exp-company">{company}</span>
        {dates.length > 0 && (
          <span class="rdp-exp-dates">{dates.length}일간 활동</span>
        )}
      </div>

      {highlights.length > 0 && (
        <ul class="rdp-exp-highlights">
          {highlights.map((h, i) => (
            <li key={i} class="rdp-exp-highlight-item">{h}</li>
          ))}
        </ul>
      )}

      {skills.length > 0 && (
        <div class="rdp-skill-chips">
          {skills.map((sk, i) => (
            <span key={i} class="rdp-chip rdp-chip--skill">{sk}</span>
          ))}
        </div>
      )}

      {suggestedBullets.length > 0 && (
        <>
          <button
            class="rdp-evidence-toggle"
            onClick={() => setShowBullets(!showBullets)}
            type="button"
            aria-expanded={showBullets}
          >
            {showBullets ? '불릿 후보 숨기기' : `불릿 후보 보기 (${suggestedBullets.length}건)`}
          </button>
          {showBullets && (
            <ul class="rdp-bullet-list">
              {suggestedBullets.map((b, i) => (
                <li key={i} class="rdp-bullet-item">
                  <span class="rdp-bullet-dot" aria-hidden="true">•</span>
                  {b}
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

const RDP_CSS = `
  /* ─── 루트 컨테이너 ─── */
  .rdp-root {
    margin: var(--space-4) var(--space-2);
    border-radius: var(--radius-lg);
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    transition: box-shadow 0.15s;
  }

  .rdp-root--loading {
    padding: var(--space-5) var(--space-5);
    border-style: dashed;
  }

  .rdp-root--error {
    padding: var(--space-4) var(--space-5);
    border-color: #fecaca;
    background: #fef2f2;
  }

  /* ─── 로딩 ─── */
  .rdp-loading-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .rdp-loading-spinner {
    display: block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: rdp-spin 0.75s linear infinite;
    flex-shrink: 0;
  }

  @keyframes rdp-spin {
    to { transform: rotate(360deg); }
  }

  .rdp-loading-label {
    font-size: 13px;
    color: var(--muted);
    font-style: italic;
  }

  /* ─── 스켈레톤 ─── */
  .rdp-skeleton-grid {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .rdp-skeleton {
    height: 80px;
    border-radius: var(--radius-md);
    background: linear-gradient(90deg, var(--line) 25%, rgba(255,255,255,0.6) 50%, var(--line) 75%);
    background-size: 200% 100%;
    animation: rdp-shimmer 1.4s ease infinite;
    flex: 1;
    min-width: 140px;
  }

  .rdp-skeleton--card {
    flex: 1;
    min-width: 160px;
  }

  .rdp-skeleton--wide {
    flex: 2;
    min-width: 260px;
  }

  @keyframes rdp-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* ─── 오류 ─── */
  .rdp-error-msg {
    margin: 0 0 var(--space-3);
    font-size: 13px;
    color: #dc2626;
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .rdp-error-icon {
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .rdp-retry-btn {
    font-size: 12px;
    font-weight: 600;
    color: #dc2626;
    background: none;
    border: 1px solid #fecaca;
    border-radius: var(--radius-sm);
    padding: 4px 12px;
    cursor: pointer;
    transition: background 0.12s;
  }

  .rdp-retry-btn:hover {
    background: #fee2e2;
  }

  /* ─── 헤더 ─── */
  .rdp-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    background: rgba(248, 246, 242, 0.85);
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }

  .rdp-root--collapsed .rdp-header {
    border-bottom: none;
  }

  .rdp-header-left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
  }

  .rdp-check-icon {
    font-size: 14px;
    color: var(--accent);
    flex-shrink: 0;
  }

  .rdp-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--ink-strong);
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rdp-header-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .rdp-meta-chip {
    font-size: 10px;
    color: var(--muted);
    background: var(--line);
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  .rdp-collapse-btn {
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: var(--muted);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s, color 0.12s;
    flex-shrink: 0;
  }

  .rdp-collapse-btn:hover {
    background: var(--line);
    color: var(--ink);
  }

  .rdp-collapse-icon {
    display: block;
    transition: transform 0.2s;
    transform: rotate(0deg);
  }

  .rdp-collapse-icon--up {
    transform: rotate(180deg);
  }

  /* ─── 본문 ─── */
  .rdp-body {
    padding: var(--space-4) var(--space-5) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* ─── 섹션 ─── */
  .rdp-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .rdp-section-title {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .rdp-section-count {
    font-size: 10px;
    font-weight: 500;
    color: var(--accent);
    background: rgba(30, 64, 175, 0.08);
    padding: 1px 7px;
    border-radius: 999px;
    letter-spacing: 0.03em;
    text-transform: none;
  }

  /* ─── 직업 요약 ─── */
  .rdp-section--summary {
    background: rgba(30, 64, 175, 0.04);
    border: 1px solid rgba(30, 64, 175, 0.12);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }

  .rdp-section--summary .rdp-section-title {
    margin-bottom: var(--space-2);
  }

  .rdp-summary-quote {
    margin: 0;
    font-size: 13px;
    line-height: 1.7;
    color: var(--ink);
    font-style: italic;
    border-left: 3px solid var(--accent);
    padding-left: var(--space-3);
  }

  /* ─── 강점 후보 카드 그리드 ─── */
  .rdp-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--space-3);
  }

  .rdp-str-card {
    padding: var(--space-3) var(--space-4);
    background: rgba(255, 255, 255, 0.95);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    transition: box-shadow 0.12s;
  }

  .rdp-str-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  }

  .rdp-str-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .rdp-str-label {
    font-size: 13px;
    font-weight: 700;
    color: var(--ink-strong);
    line-height: 1.4;
    flex: 1;
  }

  .rdp-freq-badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    color: #1e40af;
    background: rgba(30, 64, 175, 0.1);
    border-radius: 999px;
    padding: 2px 7px;
    white-space: nowrap;
    letter-spacing: 0.04em;
  }

  .rdp-str-desc {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.6;
  }

  /* ─── 경력별 요약 카드 ─── */
  .rdp-exp-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .rdp-exp-card {
    padding: var(--space-3) var(--space-4);
    background: rgba(255, 255, 255, 0.95);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .rdp-exp-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .rdp-exp-company {
    font-size: 13px;
    font-weight: 700;
    color: var(--ink-strong);
    flex: 1;
  }

  .rdp-exp-dates {
    font-size: 10px;
    color: var(--muted);
    background: var(--line);
    padding: 2px 8px;
    border-radius: 999px;
  }

  .rdp-exp-highlights {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .rdp-exp-highlight-item {
    font-size: 12px;
    color: var(--ink);
    line-height: 1.55;
    padding-left: 14px;
    position: relative;
  }

  .rdp-exp-highlight-item::before {
    content: '→';
    position: absolute;
    left: 0;
    color: var(--accent);
    font-size: 10px;
    top: 2px;
  }

  /* ─── 칩 ─── */
  .rdp-behavior-chips,
  .rdp-skill-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .rdp-chip {
    font-size: 10px;
    color: var(--muted);
    background: var(--line);
    border-radius: 999px;
    padding: 2px 8px;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }

  .rdp-chip--skill {
    color: #1e40af;
    background: rgba(30, 64, 175, 0.08);
  }

  /* ─── 근거/불릿 토글 버튼 ─── */
  .rdp-evidence-toggle {
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

  .rdp-evidence-toggle:hover {
    opacity: 0.75;
  }

  /* ─── 근거 목록 ─── */
  .rdp-evidence-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-2) var(--space-3);
    background: rgba(248, 246, 240, 0.8);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }

  .rdp-evidence-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.55;
  }

  .rdp-evidence-dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
    margin-top: 4px;
  }

  /* ─── 불릿 목록 ─── */
  .rdp-bullet-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: var(--space-2) var(--space-3);
    background: rgba(248, 250, 255, 0.9);
    border-radius: var(--radius-sm);
    border: 1px solid rgba(30, 64, 175, 0.12);
  }

  .rdp-bullet-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    color: var(--ink);
    line-height: 1.55;
  }

  .rdp-bullet-dot {
    color: var(--accent);
    flex-shrink: 0;
    font-size: 14px;
    line-height: 1.3;
  }

  /* ─── 보충 필요 항목 ─── */
  .rdp-section--gaps {
    background: rgba(251, 191, 36, 0.06);
    border: 1px solid rgba(251, 191, 36, 0.25);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }

  .rdp-gap-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .rdp-gap-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: 12px;
    color: var(--ink);
    line-height: 1.55;
  }

  .rdp-gap-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: rgba(251, 191, 36, 0.3);
    color: #92400e;
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* ─── 하단 메타 ─── */
  .rdp-footer-note {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    opacity: 0.75;
    text-align: right;
  }

  .rdp-refresh-btn {
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .rdp-refresh-btn:hover {
    opacity: 0.75;
  }

  /* ─── 반응형 ─── */
  @media (max-width: 600px) {
    .rdp-card-grid {
      grid-template-columns: 1fr;
    }

    .rdp-header {
      padding: var(--space-3) var(--space-4);
    }

    .rdp-body {
      padding: var(--space-4);
    }
  }
`;
