import { useEffect, useRef, useState } from 'preact/hooks';
import { useAuthSession } from '../hooks/useAuthSession.js';
import './worklog.css';

const SEOUL_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

const STRENGTH_COPY = {
  'Reliability engineering': {
    label: '안정성·운영 신뢰',
    description: '오류를 줄이고 예외 상황을 막는 작업이 반복해서 잡힌 신호',
  },
  'Product judgment': {
    label: '제품 판단력',
    description: '기능보다 사용자 흐름과 운영 맥락까지 같이 본 흔적',
  },
  'Developer tooling': {
    label: '개발 도구화',
    description: '반복 작업을 줄이기 위한 자동화·설치·도구 개선 신호',
  },
  'System thinking': {
    label: '구조적 사고',
    description: '개별 기능보다 흐름·상태·구조를 함께 다룬 흔적',
  },
  Debugging: {
    label: '문제 추적·진단',
    description: '원인 파악, 재현, 추적, 캐시·로그 정리 같은 디버깅 신호',
  },
};

const TECH_SIGNAL_COPY = {
  'React / Next.js': {
    label: '웹 프론트엔드',
    description: '화면, 라우팅, UI 흐름 쪽 작업이 많이 잡힌 영역',
  },
  TypeScript: {
    label: '타입 안정성',
    description: '타입, 스키마, 구조 명세를 다룬 작업 비중',
  },
  'Maps / Location': {
    label: '지도·위치',
    description: '지도, GPS, 경로, 셔틀 같은 위치 기반 도메인 신호',
  },
  'Payments / Operations': {
    label: '운영·정산',
    description: '예약, 환불, 정산, 운영 처리 쪽 업무 신호',
  },
  'AI pipeline': {
    label: 'AI 파이프라인',
    description: 'LLM, 검증, 생성 흐름, 제어 로직 관련 작업 신호',
  },
  'Agent systems': {
    label: '에이전트 시스템',
    description: '에이전트 루프, 툴링, 자동화 오케스트레이션 신호',
  },
};

const TODAY_STRENGTH_RULES = [
  { label: 'Reliability engineering', patterns: [/fix/i, /guard/i, /error/i, /crash/i, /resume/i, /retry/i, /stability/i, /안정/i, /예외/i] },
  { label: 'Product judgment', patterns: [/ux/i, /ui/i, /flow/i, /rollout/i, /리브랜딩/i, /운영/i, /가시성/i] },
  { label: 'System thinking', patterns: [/pipeline/i, /state/i, /causal/i, /architecture/i, /loop/i, /구조/i, /파이프라인/i] },
  { label: 'Debugging', patterns: [/debug/i, /trace/i, /diagn/i, /sentry/i, /qa/i, /gps/i, /cache/i] },
  { label: 'Developer tooling', patterns: [/install/i, /mcp/i, /hooks/i, /automation/i, /tool/i, /codex/i, /claude/i] },
];

const TODAY_TECH_RULES = [
  { label: 'React / Next.js', patterns: [/web/i, /getstaticprops/i, /router/i, /dialog/i, /lottie/i, /ui/i] },
  { label: 'TypeScript', patterns: [/type/i, /types/i, /schema/i] },
  { label: 'Maps / Location', patterns: [/gps/i, /map/i, /kakao/i, /route/i, /shuttle/i] },
  { label: 'Payments / Operations', patterns: [/payment/i, /refund/i, /merchant/i, /deposit/i, /admission/i, /예약/i, /환불/i] },
  { label: 'AI pipeline', patterns: [/causal/i, /deterministic/i, /scene/i, /plot/i, /validator/i, /llm/i] },
  { label: 'Agent systems', patterns: [/mcp/i, /loop/i, /resume/i, /install/i, /agent/i, /ouroboros/i] },
];

export function WorkLogPage() {
  const [days, setDays] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [dateInput, setDateInput] = useState(SEOUL_DATE);
  const [dayPayload, setDayPayload] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileWindow, setProfileWindow] = useState('all');
  const [status, setStatus] = useState('불러오는 중...');
  const [error, setError] = useState('');
  const [isBooting, setIsBooting] = useState(true);
  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const selectedDateRef = useRef('');
  const archiveRef = useRef(null);
  const lastBatchRunAtRef = useRef(0);
  const BATCH_THROTTLE_MS = 8000;
  const { authenticated, userId, logout } = useAuthSession();

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    function handleOutsideClick(event) {
      if (!archiveRef.current?.contains(event.target)) {
        setArchiveOpen(false);
      }
    }

    document.addEventListener('click', handleOutsideClick);
    return () => document.removeEventListener('click', handleOutsideClick);
  }, []);

  async function bootstrap() {
    setIsBooting(true);
    setError('');

    try {
      const [daysRes, profileRes] = await Promise.all([
        fetch('/api/days'),
        fetchProfileSummary('all'),
      ]);

      if (handleAuthFailure(daysRes)) return;
      if (!daysRes.ok) {
        throw new Error(`업무로그 목록을 불러오지 못했습니다. HTTP ${daysRes.status}`);
      }

      const nextDays = await daysRes.json();
      setDays(Array.isArray(nextDays) ? nextDays : []);

      if (profileRes) {
        setProfile(profileRes);
      } else {
        setProfile(null);
      }

      if (!nextDays.length) {
        setSelectedDate('');
        selectedDateRef.current = '';
        setDayPayload(null);
        setStatus('아직 생성된 업무로그가 없습니다.');
        return;
      }

      const requestedDate = new URLSearchParams(window.location.search).get('date');
      const initialDate = nextDays.includes(requestedDate) ? requestedDate : nextDays[0];
      setSelectedDate(initialDate);
      selectedDateRef.current = initialDate;
      await loadDay(initialDate, { replaceUrl: true });
    } catch (err) {
      setError(err.message || '업무로그를 불러오지 못했습니다.');
      setStatus('불러오기 실패');
    } finally {
      setIsBooting(false);
    }
  }

  useEffect(() => {
    void refreshProfile(profileWindow);
  }, [profileWindow]);

  async function loadDay(date, { replaceUrl = false } = {}) {
    setStatus(`${date} 불러오는 중...`);
    setError('');

    try {
      const response = await fetch(`/api/day/${encodeURIComponent(date)}`);
      if (handleAuthFailure(response)) return;
      if (!response.ok) {
        throw new Error(`일별 업무로그를 불러오지 못했습니다. HTTP ${response.status}`);
      }

      const payload = await response.json();
      setDayPayload(payload);
      setSelectedDate(date);
      setDateInput(date);
      selectedDateRef.current = date;
      setArchiveOpen(false);
      syncDateInUrl(date, replaceUrl);
      setStatus(payload.missing ? `${date} 데이터가 없습니다.` : `${date} 로드됨`);
    } catch (err) {
      setError(err.message || '업무로그를 불러오지 못했습니다.');
      setStatus('불러오기 실패');
    }
  }

  async function handleRunBatch() {
    const now = Date.now();
    const remaining = BATCH_THROTTLE_MS - (now - lastBatchRunAtRef.current);
    if (isRunningBatch || remaining > 0) {
      setStatus(remaining > 0 ? `배치 재실행은 ${Math.ceil(remaining / 1000)}초 후 가능합니다.` : '배치 실행 중...');
      return;
    }

    lastBatchRunAtRef.current = now;
    setIsRunningBatch(true);
    setError('');
    setStatus(`${dateInput} 배치 실행 중...`);

    try {
      const response = await fetch('/api/run-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateInput }),
      });

      if (handleAuthFailure(response)) return;
      if (!response.ok) {
        throw new Error(`배치를 실행하지 못했습니다. HTTP ${response.status}`);
      }

      const payload = await response.json();
      setDayPayload(payload);
      setSelectedDate(payload.date);
      setDateInput(payload.date);
      selectedDateRef.current = payload.date;
      setStatus(`${payload.date} 배치 완료`);

      const daysRes = await fetch('/api/days');
      const nextDays = daysRes.ok ? await daysRes.json() : days;
      setDays(Array.isArray(nextDays) ? nextDays : days);

      if (payload.date) {
        syncDateInUrl(payload.date, false);
      }
    } catch (err) {
      setError(err.message || '배치를 실행하지 못했습니다.');
      setStatus('배치 실행 실패');
    } finally {
      setIsRunningBatch(false);
    }
  }

  const stories = dayPayload?.highlights?.storyThreads || [];
  const leadStory = stories[0] || null;
  const secondaryStories = stories.slice(1);
  const storyRepos = deriveStoryRepos(dayPayload);
  const companyProjects = dayPayload?.projectGroups?.company || [];
  const openSourceProjects = dayPayload?.projectGroups?.opensource || [];
  const breakdownSegments = buildWorkEstimateSegments(dayPayload);
  const shareSentence = dayPayload?.highlights?.shareableSentence || buildShareSentence(dayPayload, leadStory);

  function handleDateInput(event) {
    setDateInput(event.currentTarget.value);
  }

  async function refreshProfile(windowKey) {
    try {
      const nextProfile = await fetchProfileSummary(windowKey, handleAuthFailure);
      if (nextProfile) {
        setProfile(nextProfile);
      }
    } catch {
      // keep prior profile visible
    }
  }

  return (
    <div class="worklog-page">
      <main class="worklog-shell">
        <section class="worklog-hero">
          <div class="worklog-hero-copy">
            <p class="ds-kicker worklog-eyebrow">EDITORIAL DESK</p>
            <h1>Work Log</h1>
            <p class="worklog-lede">
              하루 동안 남긴 커밋과 판단을 한 장의 편집면처럼 읽는 개인 업무 저널.
            </p>
          </div>

          <div class="worklog-actions">
            {authenticated && userId ? (
              <div class="worklog-user-row">
                <span class="worklog-user-badge">사용자 · {userId}</span>
                <button type="button" class="worklog-user-logout" onClick={() => logout('/login')}>로그아웃</button>
              </div>
            ) : null}
            <p class="ds-kicker worklog-actions-kicker">Control Desk</p>
            <div class="worklog-action-grid">
              <div class="worklog-action-group">
                <label class="worklog-field-label" for="date-input">Generate</label>
                <input
                  id="date-input"
                  type="date"
                  value={dateInput}
                  onInput={handleDateInput}
                  onChange={handleDateInput}
                />
              </div>

              <div class="worklog-action-group">
                <label class="worklog-field-label" for="archive-select">Browse</label>
                <div class="worklog-archive-picker" ref={archiveRef}>
                  <button
                    id="archive-select"
                    class="worklog-archive-trigger"
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={archiveOpen ? 'true' : 'false'}
                    onClick={() => setArchiveOpen((open) => !open)}
                    disabled={!days.length}
                  >
                    <span>{selectedDate || '날짜 선택'}</span>
                  </button>

                  <div
                    class={`worklog-archive-menu${archiveOpen ? '' : ' is-hidden'}`}
                    role="listbox"
                    aria-label="Archive dates"
                  >
                    {days.map((day) => (
                      <button
                        key={day}
                        type="button"
                        class="worklog-archive-option"
                        role="option"
                        onClick={() => void loadDay(day)}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div class="worklog-action-row">
              <button class="worklog-primary-action" type="button" onClick={handleRunBatch} disabled={isRunningBatch}>
                {isRunningBatch ? 'Generating...' : 'Generate Record'}
              </button>
              <a class="worklog-back-link worklog-back-link--secondary" href="/resume">Living Resume</a>
            </div>
          </div>
        </section>

        <section class="worklog-panel">
          <div class="worklog-panel-topbar">
            <div class="worklog-status-wrap">
              <p class="worklog-status">{status}</p>
              {error ? <p class="worklog-error">{error}</p> : null}
            </div>
          </div>

          {isBooting ? <StateMessage message="업무로그를 불러오는 중..." /> : null}

          {!isBooting && !days.length ? (
            <StateMessage message="아직 생성된 업무로그가 없습니다." />
          ) : null}

          {!isBooting && dayPayload?.missing ? (
            <StateMessage message={`${selectedDateRef.current} 데이터가 없습니다.`} />
          ) : null}

          {!isBooting && dayPayload && !dayPayload.missing ? (
            <div class="worklog-view">
              <section class="worklog-stat-bar">
                <StatCard label="총 커밋" value={dayPayload.counts?.gitCommits || 0} primary />
                <StatCard label="회사" value={dayPayload.counts?.companyCommits || 0} />
                <StatCard label="오픈소스" value={dayPayload.counts?.openSourceCommits || 0} />
                <StatCard label="기준 날짜" value={dayPayload.date} />
              </section>

              <div class="worklog-divider" />

              <section class="worklog-story-layout">
                {leadStory ? (
                  <article class="worklog-lead-story">
                    <div class="worklog-story-meta">
                      <p class="ds-kicker worklog-section-kicker">Lead Story</p>
                      <span class="worklog-story-repo-text">{leadStory.repo || storyRepos[0] || 'repo 정보 없음'}</span>
                    </div>
                    <h2 class="worklog-story-title">{leadStory.outcome}</h2>
                    <p class="worklog-lead-deck">
                      {leadStory.impact || leadStory.why || leadStory.keyChange || '오늘의 핵심 변화가 아직 정리되지 않았습니다.'}
                    </p>
                    {leadStory.decision ? (
                      <div class="worklog-lead-aside">
                        <span class="worklog-story-label">Judgment</span>
                        <p>{leadStory.decision}</p>
                      </div>
                    ) : null}
                    <div class="worklog-lead-notes">
                      <LeadStoryFact label="Key change" value={leadStory.keyChange || '없음'} />
                      <LeadStoryFact label="Why it matters" value={leadStory.why || '없음'} />
                    </div>
                  </article>
                ) : null}

                <div class="worklog-story-column">
                  {secondaryStories.length ? secondaryStories.map((story, index) => (
                    <article key={`${story.outcome}-${index}`} class="worklog-compact-story">
                      <div class="worklog-story-meta">
                        <p class="ds-kicker worklog-section-kicker">Story {index + 2}</p>
                        <span class="worklog-story-repo-text">{story.repo || storyRepos[index + 1] || 'repo 정보 없음'}</span>
                      </div>
                      <h3 class="worklog-compact-title">{story.outcome}</h3>
                      <div class="worklog-story-grid worklog-story-grid--compact">
                        <StoryLine label="Key change" value={story.keyChange || '없음'} compact />
                        <StoryLine label="Impact" value={story.impact || '없음'} compact />
                        <StoryLine label="Why it matters" value={story.why || '없음'} compact />
                        {story.decision ? <StoryLine label="Judgment" value={story.decision} compact /> : null}
                      </div>
                    </article>
                  )) : (
                    <article class="worklog-compact-story worklog-compact-story-empty">
                      <p>추가 story 없음</p>
                    </article>
                  )}
                </div>
              </section>

              <div class="worklog-divider" />

              <section class="worklog-notes-layout worklog-notes-layout--feature">
                <AIJudgmentCard
                  sentence={shareSentence}
                  outcomes={dayPayload.highlights?.businessOutcomes}
                  whyItMatters={dayPayload.highlights?.whyItMatters}
                  keyChanges={dayPayload.highlights?.keyChanges || dayPayload.highlights?.supportingWork}
                  aiReview={dayPayload.highlights?.aiReview}
                  workingStyleSignals={dayPayload.highlights?.workingStyleSignals}
                />
              </section>

              <div class="worklog-divider" />

              <section class="worklog-insight-layout">
                <TodayBreakdownCard
                  dayPayload={dayPayload}
                  segments={breakdownSegments}
                  total={dayPayload.counts?.gitCommits || 0}
                />
                <SnapshotCard
                  profile={profile}
                  profileWindow={profileWindow}
                  onWindowChange={setProfileWindow}
                />
              </section>

              <div class="worklog-divider" />

              <section class="worklog-project-links">
                <p>
                  <strong>회사 프로젝트</strong> · {companyProjects.length} repo ·{' '}
                  {sumCommitCount(companyProjects)} commits ·{' '}
                  <a href={`/projects?date=${encodeURIComponent(dayPayload.date)}&group=company`}>
                    상세 보기
                  </a>
                </p>
                <p>
                  <strong>오픈소스 프로젝트</strong> · {openSourceProjects.length} repos ·{' '}
                  {sumCommitCount(openSourceProjects)} commits ·{' '}
                  <a href={`/projects?date=${encodeURIComponent(dayPayload.date)}&group=opensource`}>
                    상세 보기
                  </a>
                </p>
              </section>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function syncDateInUrl(date, replace = false) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('date', date);
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', nextUrl);
}

function sumCommitCount(projects) {
  return projects.reduce((sum, project) => sum + (project.commitCount || 0), 0);
}

function StateMessage({ message }) {
  return (
    <div class="worklog-state">
      <p>{message}</p>
    </div>
  );
}

function StatCard({ label, value, primary = false }) {
  const isNumeric = typeof value === 'number';
  return (
    <article class={`worklog-stat-card${primary ? ' is-primary' : ''}${!isNumeric ? ' is-text' : ''}${label === '기준 날짜' ? ' is-date' : ''}`}>
      <p class="worklog-stat-label">{label}</p>
      <p class="worklog-stat-value">{value}</p>
    </article>
  );
}

function StoryLine({ label, value, compact = false, lead = false }) {
  return (
    <div class={`worklog-story-line${compact ? ' is-compact' : ''}${lead ? ' is-lead' : ''}`}>
      <span class="worklog-story-label">{label}</span>
      <p>{value}</p>
    </div>
  );
}

function LeadStoryFact({ label, value }) {
  return (
    <div class="worklog-lead-fact">
      <span class="worklog-story-label">{label}</span>
      <p>{value}</p>
    </div>
  );
}

function CardHeader({ kicker, title, subtitle, aside = null, titleAside = null }) {
  return (
    <header class="worklog-card-header">
      <div>
        <p class="ds-kicker worklog-section-kicker">{kicker}</p>
        <div class="worklog-card-title-row">
          <h3 class="worklog-card-title">{title}</h3>
          {titleAside}
        </div>
        {subtitle ? <p class="ds-panel-subtitle worklog-panel-subtitle">{subtitle}</p> : null}
      </div>
      {aside}
    </header>
  );
}

function InfoCard({ kicker, title, subtitle, items, variant = 'list', maxItems }) {
  const list = Array.isArray(items) && items.length ? items : ['없음'];
  const visibleItems = typeof maxItems === 'number' ? list.slice(0, maxItems) : list;

  return (
    <article class="ds-card worklog-info-card">
      <CardHeader kicker={kicker} title={title} subtitle={subtitle} />
      {variant === 'prose' ? (
        <div class="worklog-prose-list">
          {visibleItems.map((item, index) => (
            <p key={`${title}-${index}`} class="worklog-prose-item">{item}</p>
          ))}
        </div>
      ) : (
        <ul class="worklog-list">
          {visibleItems.map((item, index) => (
            <li key={`${title}-${index}`}>{item}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AIJudgmentCard({ sentence, outcomes, whyItMatters, keyChanges, aiReview, workingStyleSignals }) {
  const rankedOutcomes = rankImpactTexts(outcomes);
  const extraOutcomes = rankedOutcomes.slice(1, 3);
  const whyLines = rankImpactTexts(whyItMatters).slice(0, 2);
  const changes = Array.isArray(keyChanges) && keyChanges.length ? keyChanges : ['아직 핵심 작업 정리가 없습니다.'];
  const notes = Array.isArray(aiReview) && aiReview.length ? aiReview : ['아직 평가 메모가 없습니다.'];
  const signals = Array.isArray(workingStyleSignals) && workingStyleSignals.length
    ? workingStyleSignals
    : ['아직 일하는 방식 신호가 없습니다.'];

  return (
    <article class="ds-card worklog-info-card worklog-judgment-card">
      <CardHeader
        kicker="AI Judgment"
        title="오늘의 작업과 판단"
        subtitle="무엇을 했는지와, 그 과정에서 어떤 판단 패턴이 드러났는지를 한 카드에서 읽습니다."
      />
      <div class="worklog-judgment-hero">
        <p class="worklog-worknotes-label">한 줄 요약</p>
        <p class="worklog-judgment-line">{sentence || '오늘의 핵심을 한 문장으로 아직 정리하지 못했습니다.'}</p>
        {extraOutcomes.length ? (
          <ul class="worklog-list worklog-list--compact">
            {extraOutcomes.map((item, index) => (
              <li key={`also-mention-${index}`}>{item}</li>
            ))}
          </ul>
        ) : null}
        {whyLines.length ? (
          <p class="worklog-judgment-why">{whyLines[0]}</p>
        ) : null}
      </div>
      <div class="worklog-judgment-layout">
        <section class="worklog-judgment-column">
          <p class="worklog-worknotes-label">오늘 한 일</p>
          <ul class="worklog-list worklog-list--compact">
            {changes.map((item, index) => (
              <li key={`work-change-${index}`}>{item}</li>
            ))}
          </ul>
        </section>
        <section class="worklog-judgment-column worklog-judgment-column--analysis">
          <p class="worklog-worknotes-label">AI의 판단</p>
          <div class="worklog-prose-list">
            {notes.map((item, index) => (
              <p key={`work-note-${index}`} class="worklog-prose-item worklog-prose-item--dense">{item}</p>
            ))}
          </div>
          <div class="worklog-judgment-signal-block">
            <p class="worklog-worknotes-label">드러난 작업 방식</p>
            <ul class="worklog-list worklog-list--compact">
              {signals.map((item, index) => (
                <li key={`work-signal-${index}`}>{item}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </article>
  );
}

function TodayBreakdownCard({ dayPayload, segments, total }) {
  const gradient = segments.length
    ? `conic-gradient(${segments.map((segment) => `${segment.color} ${segment.start}% ${segment.end}%`).join(', ')})`
    : 'conic-gradient(#e5e7eb 0% 100%)';

  return (
    <article class="ds-card worklog-info-card worklog-insight-card">
      <CardHeader
        kicker="Work Share Estimate"
        title="작업 비중 추정"
        subtitle="커밋 수와 대표 스토리를 함께 반영해 오늘의 분포를 요약합니다."
      />

      <div class="worklog-breakdown-layout">
        <div class="worklog-donut-wrap">
          <div class="worklog-donut" style={{ background: gradient }}>
            <div class="worklog-donut-hole">
              <strong>{total}</strong>
              <span>commits</span>
            </div>
          </div>
        </div>

        <div class="worklog-breakdown-list">
          {segments.map((segment) => (
            <div key={segment.label} class="worklog-breakdown-item">
              <div class="worklog-breakdown-head">
                <span class="worklog-breakdown-dot" style={{ background: segment.color }} />
                <strong>{segment.label}</strong>
              </div>
              <p>{segment.count} commits · {segment.percent}%</p>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function SnapshotCard({ profile, profileWindow, onWindowChange }) {
  const resumeDraft = profile?.resumeDraft || { headline: '', summary: '', strengthLabels: [] };
  const strengths = (profile?.strengths || []).slice(0, 3).map((item) => {
    const copy = STRENGTH_COPY[item.label] || { label: item.label };
    return copy.label;
  });
  const workStyle = (profile?.workStyle || []).slice(0, 3);
  const strengthCards = (profile?.strengths || []).slice(0, 4).map((item) => {
    const copy = STRENGTH_COPY[item.label] || { label: item.label, description: '' };
    return { label: copy.label, description: copy.description || '', score: item.score };
  });

  return (
    <article class="ds-card worklog-info-card worklog-insight-card">
      <header class="worklog-snapshot-header">
        <div class="worklog-snapshot-meta-row">
          <p class="ds-kicker worklog-section-kicker">Current Snapshot</p>
          <div class="worklog-toggle-group" role="tablist" aria-label="snapshot window">
            {[
              { id: '7', label: '최근 7일' },
              { id: '30', label: '최근 30일' },
              { id: 'all', label: '전체' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                class={`worklog-toggle${profileWindow === item.id ? ' is-active' : ''}`}
                onClick={() => onWindowChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <h3 class="worklog-card-title">이력서로 이어지는 현재 스냅샷</h3>
        <p class="ds-panel-subtitle worklog-panel-subtitle">
          {profile?.dayCount
            ? `${profile.dayCount}일치 기록을 바탕으로 지금 이력서에 남을 핵심만 추렸습니다.`
            : '아직 누적 스냅샷이 없습니다.'}
        </p>
      </header>

      <div class="worklog-snapshot-grid">
        <SnapshotSection title="요약 초안" items={[]} emptyText="">
          {resumeDraft.headline || resumeDraft.summary ? (
            <div class="worklog-resume-draft">
              {resumeDraft.headline ? <p class="worklog-resume-draft-headline">{resumeDraft.headline}</p> : null}
              {resumeDraft.summary ? <p class="worklog-resume-draft-body">{resumeDraft.summary}</p> : null}
            </div>
          ) : <p class="worklog-snapshot-empty">아직 요약 초안을 만들 데이터가 부족합니다.</p>}
        </SnapshotSection>
        <SnapshotSection title="주요 강점" items={[]} emptyText="">
          {strengthCards.length ? (
            <div class="worklog-strength-card-grid">
              {strengthCards.map((item) => (
                <article key={item.label} class="worklog-strength-card">
                  <div class="worklog-strength-card-head">
                    <p class="worklog-strength-card-title">{item.label}</p>
                    <span class="worklog-strength-card-score">{item.score}</span>
                  </div>
                  {item.description ? (
                    <p class="worklog-strength-card-copy">{item.description}</p>
                  ) : null}
                </article>
              ))}
            </div>
          ) : <p class="worklog-snapshot-empty">아직 누적 강점이 없습니다.</p>}
        </SnapshotSection>
        <SnapshotSection title="강점 후보" items={resumeDraft.strengthLabels || []} emptyText="아직 강점 후보가 없습니다." />
        <SnapshotSection title="이력서에 남는 작업 방식" items={workStyle} emptyText="아직 누적 작업 성향이 없습니다." tone="sentence" />
      </div>
    </article>
  );
}

function SnapshotSection({ title, items, emptyText, tone = 'chip', children }) {
  return (
    <section class="worklog-snapshot-section">
      <p class="worklog-snapshot-title">{title}</p>
      {children ? children : (
        items.length ? (
          tone === 'chip' ? (
            <div class="worklog-chip-group">
              {items.map((item) => <span key={item} class="ds-chip worklog-chip">{item}</span>)}
            </div>
          ) : (
            <ul class="worklog-list">
              {items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )
        ) : (
          <p class="worklog-snapshot-empty">{emptyText}</p>
        )
      )}
    </section>
  );
}

function buildWorkEstimateSegments(dayPayload) {
  const counts = dayPayload?.counts || {};
  const totalCommits = counts.gitCommits || 0;
  const company = counts.companyCommits || 0;
  const openSource = counts.openSourceCommits || 0;
  const total = totalCommits;
  const other = Math.max(total - company - openSource, 0);
  const storyCategories = deriveStoryCategories(dayPayload);

  const raw = [
    { key: 'company', label: '회사 프로젝트', count: company, color: '#334155' },
    { key: 'opensource', label: '오픈소스', count: openSource, color: '#6366f1' },
    { key: 'other', label: '기타', count: other, color: '#d1d5db' },
  ].filter((item) => item.count > 0);

  if (!total || !raw.length) return [];

  const weighted = raw.map((item) => {
    const storyBoost = storyCategories.reduce((sum, category, index) => {
      if (category !== item.key) return sum;
      return sum + (index === 0 ? 6 : 3);
    }, 0);
    return {
      ...item,
      weight: item.count + storyBoost,
    };
  });

  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = 0;
  return weighted.map((item) => {
    const percent = Math.round((item.weight / totalWeight) * 100);
    const start = cursor;
    const end = cursor + (item.weight / totalWeight) * 100;
    cursor = end;
    return {
      ...item,
      percent,
      start,
      end,
    };
  });
}

function deriveStoryRepos(dayPayload) {
  const company = dayPayload?.projectGroups?.company || [];
  const opensource = dayPayload?.projectGroups?.opensource || [];

  return [...company, ...opensource]
    .sort((left, right) => {
      const rank = (project) => (project.category === 'company' ? 0 : project.category === 'opensource' ? 1 : 2);
      return rank(left) - rank(right) || (right.commitCount || 0) - (left.commitCount || 0);
    })
    .slice(0, 3)
    .map((project) => project.repo);
}

function deriveStoryCategories(dayPayload) {
  const groups = dayPayload?.projectGroups || {};
  const allProjects = [...(groups.company || []), ...(groups.opensource || []), ...(groups.other || [])];
  const byRepo = new Map(allProjects.map((project) => [project.repo, project.category || 'other']));
  const stories = dayPayload?.highlights?.storyThreads || [];

  return stories
    .map((story, index) => story.repo || deriveStoryRepos(dayPayload)[index] || null)
    .map((repo) => byRepo.get(repo) || null)
    .filter(Boolean);
}

function buildTodaySnapshot(dayPayload) {
  const texts = collectTodayTexts(dayPayload);
  return {
    strengths: rankTodaySignals(TODAY_STRENGTH_RULES, texts, STRENGTH_COPY).slice(0, 3),
    techSignals: rankTodaySignals(TODAY_TECH_RULES, texts, TECH_SIGNAL_COPY).slice(0, 3),
  };
}

function collectTodayTexts(dayPayload) {
  const projectTexts = (dayPayload?.projects || []).flatMap((project) =>
    (project.commits || []).map((commit) => commit.subject).filter(Boolean)
  );
  return [
    ...(dayPayload?.highlights?.keyChanges || []),
    ...(dayPayload?.highlights?.commitAnalysis || []),
    ...(dayPayload?.highlights?.aiReview || []),
    ...projectTexts,
  ];
}

function rankTodaySignals(rules, texts, copyMap) {
  const scores = new Map();

  for (const text of texts) {
    const normalized = String(text || '');
    for (const rule of rules) {
      if (rule.patterns.some((pattern) => pattern.test(normalized))) {
        scores.set(rule.label, (scores.get(rule.label) || 0) + 1);
      }
    }
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([label]) => copyMap[label]?.label || label);
}

function buildShareSentence(dayPayload, leadStory) {
  const outcome = pickStrongestText([
    ...(dayPayload?.highlights?.businessOutcomes || []),
    leadStory?.outcome,
    leadStory?.impact,
  ]);
  const why = pickStrongestText([
    ...(dayPayload?.highlights?.whyItMatters || []),
    leadStory?.why,
    leadStory?.impact,
  ], [outcome]);
  const change = pickStrongestText([
    ...(dayPayload?.highlights?.keyChanges || []),
    leadStory?.keyChange,
    leadStory?.decision,
  ], [outcome, why]);
  const outcomeLine = normalizeSentence(outcome);
  const whyLine = normalizeSentence(why);
  const changeLine = normalizeSentence(change);

  if (outcomeLine && whyLine) {
    return `${outcomeLine} 덕분에 ${toSentenceBody(whyLine)}.`;
  }
  if (changeLine && outcomeLine) {
    return `${changeLine} 그 결과 ${toSentenceBody(outcomeLine)}.`;
  }
  return outcomeLine || changeLine || '';
}

function normalizeSentence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  return `${trimmed.replace(/[.!?]\s*$/, '')}.`;
}

function toSentenceBody(text) {
  return String(text || '').trim().replace(/[.!?]\s*$/, '');
}

function pickStrongestText(items, exclude = []) {
  const excluded = new Set(exclude.map((item) => String(item || '').trim()).filter(Boolean));
  return rankImpactTexts(items).find((item) => !excluded.has(String(item || '').trim())) || '';
}

function rankImpactTexts(items) {
  return [...new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
    .sort((left, right) => scoreImpactText(right) - scoreImpactText(left));
}

function scoreImpactText(text) {
  const normalized = String(text || '').toLowerCase();
  let score = 0;

  if (/(줄였|감소|방지|막았|개선|높였|증가|복구|안정|정확|누락|오류|리스크|전환|성능|속도|impact|reduce|improve|prevent|increase|stability|error|risk)/.test(normalized)) {
    score += 5;
  }
  if (/(고객|운영|결제|예약|체크인|환불|merchant|payment|refund|admission|cs)/.test(normalized)) {
    score += 3;
  }
  if (/\d|%/.test(normalized)) {
    score += 2;
  }

  score += Math.min(normalized.length / 24, 4);

  if (normalized.length < 14) score -= 2;
  if (normalized.length > 120) score -= 1;

  return score;
}

async function fetchProfileSummary(windowKey, onAuthFailure = null) {
  const query = windowKey && windowKey !== 'all' ? `?window=${windowKey}` : '';
  const response = await fetch(`/api/profile${query}`);
  if (typeof onAuthFailure === "function" && onAuthFailure(response)) return null;
  if (!response.ok) return null;
  return response.json();
}
