import { useState } from 'preact/hooks';

/**
 * DraftInsightMessages — 회사별 대표 프로젝트, 강점 후보, 경력별 주요 경험 요약을
 * 채팅 메시지 형태로 즉시 표시하는 UI 컴포넌트 (Sub-AC 3)
 *
 * ResumeDraftPanel이 로딩·패널 형태로 초안을 표시하는 반면,
 * 이 컴포넌트는 초안 데이터를 채팅 대화 흐름(AI 메시지) 안에
 * 인라인으로 렌더링해 사용자가 자연스럽게 읽고 후속 질문을 이어갈 수 있게 한다.
 *
 * Props:
 *   draft               — ResumeDraft | null  초안 데이터 (useDraftContext 결과)
 *   status              — 'loading' | 'generating' | 'ready' | 'error'  초안 상태
 *   error               — string | null       에러 메시지
 *   onRetry             — () => void          재시도 콜백
 *   onCompanyClick      — (companyStory) => void  회사 카드 클릭 콜백
 *   onProjectClick      — (companyStory, project) => void 프로젝트 클릭 콜백
 *   onCapabilityClick   — (companyStory, capability) => void 역량 클릭 콜백
 *   onStrengthClick     — (strength) => void      강점 항목 클릭 콜백
 *   onExperienceClick   — (experience) => void    경력 항목 클릭 콜백
 *
 * ResumeDraft 구조 (관련 필드만):
 *   companyStories       — Array<{ company, narrative, projects[], provenCapabilities[] }>
 *   strengthCandidates   — Array<{ id, label, description, frequency, behaviorCluster[], evidenceExamples[] }>
 *   experienceSummaries  — Array<{ company, highlights[], skills[], suggestedBullets[], dates[] }>
 *   suggestedSummary     — string
 *   dataGaps             — string[]
 *   sources              — { commitCount, sessionCount, slackCount, repos[] }
 *   dateRange            — { from, to }
 */
export function DraftInsightMessages({
  draft,
  status = 'loading',
  error = null,
  onRetry,
  onCompanyClick,
  onProjectClick,
  onCapabilityClick,
  onStrengthClick,
  onExperienceClick,
}) {
  // 로딩·생성 중
  if (status === 'loading' || status === 'generating') {
    return (
      <div class="dim-root">
        <InsightLoadingMessage isGenerating={status === 'generating'} />
        <style>{DIM_CSS}</style>
      </div>
    );
  }

  // 오류
  if (status === 'error') {
    return (
      <div class="dim-root">
        <InsightErrorMessage error={error} onRetry={onRetry} />
        <style>{DIM_CSS}</style>
      </div>
    );
  }

  // 데이터 없음
  if (!draft) return null;

  const {
    companyStories = [],
    strengthCandidates = [],
    experienceSummaries = [],
    suggestedSummary = '',
    dataGaps = [],
    sources = {},
    dateRange = {},
  } = draft;

  const hasContent =
    companyStories.length > 0 ||
    strengthCandidates.length > 0 ||
    experienceSummaries.length > 0;
  if (!hasContent) return null;

  return (
    <div class="dim-root">
      {/* ── 분석 요약 메시지 ── */}
      <InsightHeaderMessage
        sources={sources}
        dateRange={dateRange}
        companyCount={companyStories.length}
        strengthCount={strengthCandidates.length}
        experienceCount={experienceSummaries.length}
      />

      {/* ── 직업 요약 제안 ── */}
      {suggestedSummary && (
        <InsightBubble>
          <div class="dim-summary-block">
            <span class="dim-section-icon" aria-hidden="true">📝</span>
            <span class="dim-section-label">직업 요약 제안</span>
          </div>
          <blockquote class="dim-summary-quote">{suggestedSummary}</blockquote>
        </InsightBubble>
      )}

      {/* ── 회사별 대표 프로젝트 / 역량 ── */}
      {companyStories.length > 0 && (
        <InsightBubble>
          <div class="dim-section-header">
            <span class="dim-section-icon" aria-hidden="true">🏢</span>
            <span class="dim-section-label">회사별 대표 프로젝트</span>
            <span class="dim-count-badge">{companyStories.length}개 회사</span>
          </div>
          <div class="dim-company-list">
            {companyStories.map((story, i) => (
              <CompanyStoryCard
                key={story.id ?? `${story.company}-${i}`}
                companyStory={story}
                onCompanyClick={onCompanyClick}
                onProjectClick={onProjectClick}
                onCapabilityClick={onCapabilityClick}
              />
            ))}
          </div>
        </InsightBubble>
      )}

      {/* ── 강점 후보 카드 목록 ── */}
      {strengthCandidates.length > 0 && (
        <InsightBubble>
          <div class="dim-section-header">
            <span class="dim-section-icon" aria-hidden="true">💪</span>
            <span class="dim-section-label">공통 강점 후보</span>
            <span class="dim-count-badge">{strengthCandidates.length}건</span>
          </div>
          <div class="dim-strength-list">
            {strengthCandidates.map((cand, i) => (
              <StrengthCandidateChip
                key={cand.id ?? `str-${i}`}
                candidate={cand}
                index={i}
                onClick={onStrengthClick}
              />
            ))}
          </div>
        </InsightBubble>
      )}

      {/* ── 경력별 주요 경험 요약 ── */}
      {experienceSummaries.length > 0 && (
        <InsightBubble>
          <div class="dim-section-header">
            <span class="dim-section-icon" aria-hidden="true">🗂️</span>
            <span class="dim-section-label">보조 경력 요약</span>
            <span class="dim-count-badge">{experienceSummaries.length}개 회사</span>
          </div>
          <div class="dim-exp-list">
            {experienceSummaries.map((exp, i) => (
              <ExperienceSummaryChip
                key={`${exp.company}-${i}`}
                summary={exp}
                onClick={onExperienceClick}
              />
            ))}
          </div>
        </InsightBubble>
      )}

      {/* ── 보충 질문 권장 (데이터 부족 시) ── */}
      {dataGaps.length > 0 && (
        <InsightBubble variant="warning">
          <div class="dim-section-header">
            <span class="dim-section-icon" aria-hidden="true">❓</span>
            <span class="dim-section-label">보충이 필요한 항목</span>
            <span class="dim-count-badge dim-count-badge--warn">{dataGaps.length}건</span>
          </div>
          <ul class="dim-gap-list">
            {dataGaps.map((gap, i) => (
              <li key={i} class="dim-gap-item">
                <span class="dim-gap-dot" aria-hidden="true" />
                {gap}
              </li>
            ))}
          </ul>
        </InsightBubble>
      )}

      <style>{DIM_CSS}</style>
    </div>
  );
}

/* ── 내부 컴포넌트 ──────────────────────────────────────────────────────────── */

/** 채팅 AI 버블 래퍼 — 어시스턴트 메시지와 동일한 외형 */
function InsightBubble({ children, variant = 'default' }) {
  return (
    <div class="dim-row">
      <div class="dim-avatar" aria-hidden="true">AI</div>
      <div class="dim-bubble-wrap">
        <div class={`dim-bubble${variant === 'warning' ? ' dim-bubble--warning' : ''}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** 로딩 메시지 */
function InsightLoadingMessage({ isGenerating }) {
  return (
    <div class="dim-row">
      <div class="dim-avatar" aria-hidden="true">AI</div>
      <div class="dim-bubble-wrap">
        <div class="dim-bubble dim-bubble--loading" aria-busy="true">
          <span class="dim-loading-spinner" aria-hidden="true" />
          <span class="dim-loading-text">
            {isGenerating
              ? '업무 로그에서 강점·경력 초안 생성 중… (최대 30초)'
              : '초안 데이터 불러오는 중…'}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 오류 메시지 */
function InsightErrorMessage({ error, onRetry }) {
  return (
    <div class="dim-row">
      <div class="dim-avatar" aria-hidden="true">AI</div>
      <div class="dim-bubble-wrap">
        <div class="dim-bubble dim-bubble--error" role="alert">
          <span class="dim-error-icon" aria-hidden="true">⚠</span>
          <span>초안 생성 실패: {error || '알 수 없는 오류'}</span>
          {onRetry && (
            <button class="dim-retry-btn" onClick={onRetry} type="button">
              다시 시도
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 분석 완료 헤더 메시지 — 소스 메타 정보 표시 */
function InsightHeaderMessage({ sources, dateRange, companyCount, strengthCount, experienceCount }) {
  const { commitCount = 0, sessionCount = 0, slackCount = 0 } = sources;
  const dateFrom = dateRange?.from ?? '';
  const dateTo = dateRange?.to ?? '';

  const parts = [];
  if (commitCount > 0) parts.push(`커밋 ${commitCount}개`);
  if (slackCount > 0) parts.push(`슬랙 ${slackCount}건`);
  if (sessionCount > 0) parts.push(`세션 ${sessionCount}개`);

  const datePart = dateFrom && dateTo ? `${dateFrom} ~ ${dateTo}` : '';

  return (
    <div class="dim-row">
      <div class="dim-avatar" aria-hidden="true">AI</div>
      <div class="dim-bubble-wrap">
        <div class="dim-bubble">
          <p class="dim-header-text">
            업무 기록을 분석했습니다.{' '}
            {datePart && <span class="dim-header-date">{datePart}</span>}{' '}
            기간 동안{' '}
            {parts.length > 0 && (
              <span class="dim-header-sources">{parts.join(', ')}</span>
            )}
            에서{' '}
            <strong>회사 스토리 {companyCount}건</strong>,{' '}
            <strong>강점 {strengthCount}건</strong>,{' '}
            <strong>경력 요약 {experienceCount}건</strong>을 추출했습니다.
          </p>
          <p class="dim-header-hint">
            아래 항목을 클릭하면 해당 내용으로 채팅을 이어갈 수 있습니다.
          </p>
        </div>
      </div>
    </div>
  );
}

function CompanyStoryCard({ companyStory, onCompanyClick, onProjectClick, onCapabilityClick }) {
  const {
    company,
    role = '',
    periodLabel = '',
    narrative = '',
    projects = [],
    provenCapabilities = [],
  } = companyStory;
  const [expanded, setExpanded] = useState(false);
  const visibleProjects = expanded ? projects : projects.slice(0, 2);

  function handleCompanyClick() {
    onCompanyClick?.(companyStory);
  }

  return (
    <div
      class="dim-company-card"
      role="button"
      tabIndex={0}
      onClick={handleCompanyClick}
      onKeyDown={(e) => { if (e.key === 'Enter') handleCompanyClick(); }}
    >
      <div class="dim-company-top">
        <div class="dim-company-meta">
          <span class="dim-company-name">{company}</span>
          {(role || periodLabel) && (
            <span class="dim-company-role">
              {[role, periodLabel].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        <span class="dim-company-count">{projects.length}개 프로젝트</span>
      </div>

      {narrative && <p class="dim-company-narrative">{narrative}</p>}

      <div class="dim-company-projects">
        {visibleProjects.map((project, index) => (
          <ProjectStoryCard
            key={project.id ?? `${project.title}-${index}`}
            project={project}
            index={index}
            onClick={() => onProjectClick?.(companyStory, project)}
          />
        ))}
      </div>

      {projects.length > 2 && (
        <button
          class="dim-evidence-toggle"
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded((prev) => !prev); }}
          aria-expanded={expanded}
        >
          {expanded ? '대표 프로젝트 접기' : `대표 프로젝트 더 보기 (${projects.length}개)`}
        </button>
      )}

      {provenCapabilities.length > 0 && (
        <div class="dim-company-capabilities">
          <p class="dim-company-capability-label">이 회사에서 증명된 역량</p>
          <div class="dim-chip-row">
            {provenCapabilities.map((capability, index) => (
              <button
                key={`${capability}-${index}`}
                class="dim-chip-button"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCapabilityClick?.(companyStory, capability);
                }}
              >
                {capability}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectStoryCard({ project, index, onClick }) {
  const {
    title,
    oneLiner = '',
    problem = '',
    solution = [],
    result = [],
    stack = [],
    capabilities = [],
  } = project;

  return (
    <button
      class="dim-project-card"
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <div class="dim-project-top">
        <span class="dim-project-index">{index + 1}</span>
        <div class="dim-project-heading">
          <span class="dim-project-title">{title}</span>
          {oneLiner && <span class="dim-project-oneliner">{oneLiner}</span>}
        </div>
      </div>

      {problem && (
        <div class="dim-project-block">
          <span class="dim-project-label">문제</span>
          <p class="dim-project-copy">{problem}</p>
        </div>
      )}

      {solution.length > 0 && (
        <div class="dim-project-block">
          <span class="dim-project-label">해결</span>
          <ul class="dim-project-list">
            {solution.slice(0, 3).map((item, itemIndex) => (
              <li key={itemIndex}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {result.length > 0 && (
        <div class="dim-project-block">
          <span class="dim-project-label">결과</span>
          <ul class="dim-project-list dim-project-list--result">
            {result.slice(0, 3).map((item, itemIndex) => (
              <li key={itemIndex}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {(stack.length > 0 || capabilities.length > 0) && (
        <div class="dim-project-foot">
          {stack.length > 0 && (
            <div class="dim-chip-row">
              {stack.slice(0, 6).map((item, itemIndex) => (
                <span key={itemIndex} class="dim-chip dim-chip--skill">{item}</span>
              ))}
            </div>
          )}
          {capabilities.length > 0 && (
            <div class="dim-chip-row">
              {capabilities.slice(0, 4).map((item, itemIndex) => (
                <span key={itemIndex} class="dim-chip dim-chip--capability">{item}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </button>
  );
}

/** 강점 후보 칩 — 클릭하면 해당 강점에 대한 채팅 질의를 트리거 */
function StrengthCandidateChip({ candidate, index, onClick }) {
  const { label, description, frequency, behaviorCluster = [], evidenceExamples = [] } = candidate;
  const [expanded, setExpanded] = useState(false);

  function handleClick() {
    if (onClick) onClick(candidate);
  }

  return (
    <div class="dim-str-card" role="button" tabIndex={0} onClick={handleClick} onKeyDown={(e) => { if (e.key === 'Enter') handleClick(); }}>
      <div class="dim-str-top">
        <span class="dim-str-index" aria-hidden="true">{index + 1}</span>
        <span class="dim-str-label">{label}</span>
        <span class="dim-str-meta">
          {frequency > 1 && (
            <span class="dim-freq-badge" title={`${frequency}회 이상 등장`}>×{frequency}</span>
          )}
        </span>
      </div>

      {description && <p class="dim-str-desc">{description}</p>}

      {behaviorCluster.length > 0 && (
        <div class="dim-chip-row">
          {behaviorCluster.slice(0, 4).map((b, i) => (
            <span key={i} class="dim-chip">{b}</span>
          ))}
          {behaviorCluster.length > 4 && (
            <span class="dim-chip dim-chip--more">+{behaviorCluster.length - 4}</span>
          )}
        </div>
      )}

      {evidenceExamples.length > 0 && (
        <button
          class="dim-evidence-toggle"
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          aria-expanded={expanded}
        >
          {expanded ? '근거 숨기기' : `근거 보기 (${evidenceExamples.length}건)`}
        </button>
      )}

      {expanded && evidenceExamples.length > 0 && (
        <ul class="dim-evidence-list">
          {evidenceExamples.map((ex, i) => (
            <li key={i} class="dim-evidence-item">
              <span class="dim-evidence-dot" aria-hidden="true" />
              {ex}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 경력별 요약 칩 — 클릭하면 해당 경력에 대한 채팅 질의를 트리거 */
function ExperienceSummaryChip({ summary, onClick }) {
  const { company, highlights = [], skills = [], suggestedBullets = [], dates = [] } = summary;
  const [showBullets, setShowBullets] = useState(false);

  function handleClick() {
    if (onClick) onClick(summary);
  }

  return (
    <div class="dim-exp-card" role="button" tabIndex={0} onClick={handleClick} onKeyDown={(e) => { if (e.key === 'Enter') handleClick(); }}>
      <div class="dim-exp-top">
        <span class="dim-exp-company">{company}</span>
        {dates.length > 0 && (
          <span class="dim-exp-dates">{dates.length}일간 활동</span>
        )}
      </div>

      {highlights.length > 0 && (
        <ul class="dim-exp-highlights">
          {highlights.slice(0, 3).map((h, i) => (
            <li key={i} class="dim-exp-hl-item">{h}</li>
          ))}
          {highlights.length > 3 && (
            <li class="dim-exp-hl-more">+{highlights.length - 3}건 더</li>
          )}
        </ul>
      )}

      {skills.length > 0 && (
        <div class="dim-chip-row">
          {skills.slice(0, 5).map((sk, i) => (
            <span key={i} class="dim-chip dim-chip--skill">{sk}</span>
          ))}
          {skills.length > 5 && (
            <span class="dim-chip dim-chip--more">+{skills.length - 5}</span>
          )}
        </div>
      )}

      {suggestedBullets.length > 0 && (
        <button
          class="dim-evidence-toggle"
          type="button"
          onClick={(e) => { e.stopPropagation(); setShowBullets(!showBullets); }}
          aria-expanded={showBullets}
        >
          {showBullets ? '불릿 후보 숨기기' : `불릿 후보 보기 (${suggestedBullets.length}건)`}
        </button>
      )}

      {showBullets && suggestedBullets.length > 0 && (
        <ul class="dim-bullet-list">
          {suggestedBullets.map((b, i) => (
            <li key={i} class="dim-bullet-item">
              <span class="dim-bullet-dot" aria-hidden="true">•</span>
              {b}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const DIM_CSS = `
  /* ─── Root ─── */
  .dim-root {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    animation: dim-fade-in 0.35s ease;
  }

  @keyframes dim-fade-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ─── Row (채팅 메시지 행) ─── */
  .dim-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    max-width: 920px;
    width: 100%;
    align-self: flex-start;
  }

  /* ─── Avatar ─── */
  .dim-avatar {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #1e40af;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
    user-select: none;
  }

  /* ─── Bubble wrap ─── */
  .dim-bubble-wrap {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }

  /* ─── Bubble ─── */
  .dim-bubble {
    padding: var(--space-3) var(--space-4);
    border-radius: 16px;
    border-bottom-left-radius: 4px;
    font-size: 14px;
    line-height: 1.65;
    max-width: 860px;
    word-break: break-word;
    background: rgba(255, 255, 255, 0.92);
    color: var(--ink);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-sm);
  }

  .dim-bubble--warning {
    background: rgba(255, 251, 235, 0.95);
    border-color: rgba(251, 191, 36, 0.35);
  }

  .dim-bubble--loading {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-style: dashed;
  }

  .dim-bubble--error {
    background: #fef2f2;
    border-color: #fecaca;
    color: #dc2626;
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* ─── Loading spinner ─── */
  .dim-loading-spinner {
    display: block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: dim-spin 0.75s linear infinite;
    flex-shrink: 0;
  }

  @keyframes dim-spin {
    to { transform: rotate(360deg); }
  }

  .dim-loading-text {
    font-size: 13px;
    color: var(--muted);
    font-style: italic;
  }

  /* ─── Error ─── */
  .dim-error-icon {
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .dim-retry-btn {
    font-size: 11px;
    font-weight: 600;
    color: #dc2626;
    background: none;
    border: 1px solid #fecaca;
    border-radius: var(--radius-sm);
    padding: 3px 10px;
    cursor: pointer;
    transition: background 0.12s;
    margin-left: auto;
  }

  .dim-retry-btn:hover {
    background: #fee2e2;
  }

  /* ─── Header text ─── */
  .dim-header-text {
    margin: 0;
    font-size: 13px;
    line-height: 1.7;
    color: var(--ink);
  }

  .dim-header-date {
    font-weight: 600;
    color: var(--accent);
  }

  .dim-header-sources {
    color: var(--muted);
    font-size: 12px;
  }

  .dim-header-hint {
    margin: var(--space-2) 0 0;
    font-size: 11px;
    color: var(--muted);
    font-style: italic;
  }

  /* ─── Section header ─── */
  .dim-section-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .dim-summary-block {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .dim-section-icon {
    font-size: 14px;
    line-height: 1;
    flex-shrink: 0;
  }

  .dim-section-label {
    font-size: 12px;
    font-weight: 700;
    color: var(--ink-strong);
    letter-spacing: -0.01em;
  }

  .dim-count-badge {
    font-size: 10px;
    font-weight: 700;
    color: var(--accent);
    background: rgba(30, 64, 175, 0.08);
    border-radius: 999px;
    padding: 2px 7px;
    flex-shrink: 0;
  }

  .dim-count-badge--warn {
    color: #d97706;
    background: rgba(217, 119, 6, 0.1);
  }

  /* ─── Summary quote ─── */
  .dim-summary-quote {
    margin: 0;
    font-size: 13px;
    line-height: 1.7;
    color: var(--ink);
    font-style: italic;
    border-left: 3px solid var(--accent);
    padding-left: var(--space-3);
  }

  /* ─── Strength list ─── */
  .dim-company-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .dim-company-card {
    padding: var(--space-3);
    background: linear-gradient(180deg, rgba(247, 250, 255, 0.96), rgba(255, 255, 255, 0.98));
    border: 1px solid rgba(30, 64, 175, 0.14);
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    cursor: pointer;
    transition: box-shadow 0.14s, border-color 0.14s, transform 0.12s;
  }

  .dim-company-card:hover {
    border-color: rgba(30, 64, 175, 0.28);
    box-shadow: 0 10px 24px rgba(30, 64, 175, 0.08);
    transform: translateY(-1px);
  }

  .dim-company-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .dim-company-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .dim-company-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .dim-company-name {
    font-size: 15px;
    font-weight: 800;
    color: var(--ink-strong);
    letter-spacing: -0.02em;
  }

  .dim-company-role {
    font-size: 11px;
    color: var(--muted);
  }

  .dim-company-count {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    color: var(--accent);
    background: rgba(30, 64, 175, 0.08);
    padding: 3px 8px;
    border-radius: 999px;
  }

  .dim-company-narrative {
    margin: 0;
    font-size: 12px;
    color: var(--ink);
    line-height: 1.6;
  }

  .dim-company-projects {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .dim-project-card {
    width: 100%;
    border: 1px solid rgba(148, 163, 184, 0.18);
    background: rgba(255, 255, 255, 0.92);
    border-radius: 14px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.14s, box-shadow 0.14s, background 0.14s;
  }

  .dim-project-card:hover {
    border-color: rgba(30, 64, 175, 0.24);
    box-shadow: 0 8px 18px rgba(15, 23, 42, 0.06);
    background: rgba(248, 250, 255, 0.96);
  }

  .dim-project-top {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .dim-project-index {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: rgba(30, 64, 175, 0.12);
    color: var(--accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
  }

  .dim-project-heading {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .dim-project-title {
    font-size: 13px;
    font-weight: 800;
    color: var(--ink-strong);
    line-height: 1.45;
  }

  .dim-project-oneliner {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.5;
  }

  .dim-project-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .dim-project-label {
    font-size: 10px;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .dim-project-copy {
    margin: 0;
    font-size: 11px;
    color: var(--ink);
    line-height: 1.55;
  }

  .dim-project-list {
    margin: 0;
    padding-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--ink);
    line-height: 1.55;
  }

  .dim-project-list--result li {
    color: #1e3a8a;
    font-weight: 600;
  }

  .dim-project-foot {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .dim-company-capabilities {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .dim-company-capability-label {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--ink-strong);
  }

  .dim-strength-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .dim-str-card {
    padding: var(--space-2) var(--space-3);
    background: rgba(248, 250, 255, 0.8);
    border: 1px solid rgba(30, 64, 175, 0.12);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    cursor: pointer;
    transition: box-shadow 0.12s, border-color 0.15s, background 0.12s;
  }

  .dim-str-card:hover {
    border-color: rgba(30, 64, 175, 0.3);
    box-shadow: 0 2px 8px rgba(30, 64, 175, 0.1);
    background: rgba(239, 246, 255, 0.9);
  }

  .dim-str-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .dim-str-top {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dim-str-index {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
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

  .dim-str-label {
    flex: 1;
    font-size: 13px;
    font-weight: 700;
    color: var(--ink-strong);
    line-height: 1.4;
  }

  .dim-str-meta {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex-shrink: 0;
  }

  .dim-freq-badge {
    font-size: 10px;
    font-weight: 700;
    color: #1e40af;
    background: rgba(30, 64, 175, 0.1);
    border-radius: 999px;
    padding: 1px 6px;
  }

  .dim-str-desc {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.55;
  }

  /* ─── Chips ─── */
  .dim-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  .dim-chip {
    font-size: 9px;
    color: var(--muted);
    background: var(--line);
    border-radius: 999px;
    padding: 1px 7px;
    line-height: 1.5;
    letter-spacing: 0.02em;
  }

  .dim-chip--skill {
    color: #1e40af;
    background: rgba(30, 64, 175, 0.08);
  }

  .dim-chip--capability {
    color: #0f766e;
    background: rgba(15, 118, 110, 0.1);
  }

  .dim-chip--more {
    color: var(--accent);
    font-weight: 600;
  }

  .dim-chip-button {
    border: 1px solid rgba(15, 118, 110, 0.18);
    background: rgba(240, 253, 250, 0.92);
    color: #0f766e;
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    transition: border-color 0.14s, background 0.14s, transform 0.12s;
  }

  .dim-chip-button:hover {
    border-color: rgba(15, 118, 110, 0.36);
    background: rgba(204, 251, 241, 0.92);
    transform: translateY(-1px);
  }

  /* ─── Evidence toggle ─── */
  .dim-evidence-toggle {
    background: none;
    border: none;
    padding: 0;
    font-size: 10px;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
    text-align: left;
    width: fit-content;
    transition: opacity 0.12s;
  }

  .dim-evidence-toggle:hover { opacity: 0.75; }

  /* ─── Evidence list ─── */
  .dim-evidence-list {
    margin: 0;
    padding: var(--space-1) var(--space-2);
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: rgba(248, 246, 240, 0.8);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }

  .dim-evidence-item {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    font-size: 10px;
    color: var(--muted);
    line-height: 1.5;
  }

  .dim-evidence-dot {
    flex-shrink: 0;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 4px;
  }

  /* ─── Experience list ─── */
  .dim-exp-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .dim-exp-card {
    padding: var(--space-2) var(--space-3);
    background: rgba(255, 255, 255, 0.95);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    cursor: pointer;
    transition: box-shadow 0.12s, border-color 0.15s;
  }

  .dim-exp-card:hover {
    border-color: rgba(30, 64, 175, 0.25);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
  }

  .dim-exp-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .dim-exp-top {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .dim-exp-company {
    font-size: 13px;
    font-weight: 700;
    color: var(--ink-strong);
    flex: 1;
  }

  .dim-exp-dates {
    font-size: 10px;
    color: var(--muted);
    background: var(--line);
    padding: 1px 7px;
    border-radius: 999px;
  }

  .dim-exp-highlights {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .dim-exp-hl-item {
    font-size: 11px;
    color: var(--ink);
    line-height: 1.5;
    padding-left: 12px;
    position: relative;
  }

  .dim-exp-hl-item::before {
    content: '→';
    position: absolute;
    left: 0;
    color: var(--accent);
    font-size: 10px;
    top: 1px;
  }

  .dim-exp-hl-more {
    font-size: 10px;
    color: var(--accent);
    padding-left: 12px;
  }

  /* ─── Bullet list ─── */
  .dim-bullet-list {
    margin: 0;
    padding: var(--space-1) var(--space-2);
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: rgba(248, 250, 255, 0.9);
    border-radius: var(--radius-sm);
    border: 1px solid rgba(30, 64, 175, 0.12);
  }

  .dim-bullet-item {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    font-size: 11px;
    color: var(--ink);
    line-height: 1.5;
  }

  .dim-bullet-dot {
    color: var(--accent);
    flex-shrink: 0;
    font-size: 12px;
    line-height: 1.3;
  }

  /* ─── Gap list ─── */
  .dim-gap-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .dim-gap-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    color: var(--ink);
    line-height: 1.55;
  }

  .dim-gap-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #d97706;
    margin-top: 5px;
  }

  /* ─── Responsive ─── */
  @media (max-width: 600px) {
    .dim-bubble {
      max-width: 100%;
    }

    .dim-company-card,
    .dim-project-card,
    .dim-str-card,
    .dim-exp-card {
      padding: var(--space-2);
    }

    .dim-company-top {
      flex-direction: column;
      align-items: flex-start;
    }
  }
`;
