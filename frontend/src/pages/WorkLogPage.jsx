import { useEffect, useRef, useState } from 'preact/hooks';
import { navigate } from '../App.jsx';
import { BatchSummaryFeed } from '../components/resume/BatchSummaryFeed.jsx';
import {
  WorklogButton,
  WorklogCard,
  WorklogMetaLine,
  WorklogMiniSection,
  WorklogSectionHeader,
  WorklogStatTile,
  WORKLOG_PRIMITIVES_CSS,
} from '../components/worklog/Primitives.jsx';
import { useResumeHealthCheck } from '../hooks/useResumeHealthCheck.js';
import { buildWorklogShareSentence, deriveStoryTitle, rankImpactTexts, sanitizeWorklogCopy, sanitizeWorklogList, splitCompactStoryHighlights } from '../lib/worklogCopy.js';
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
    description: '타입, 스키마, 구조 명세를 다룬 작업 구성',
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
  const [batchSummary, setBatchSummary] = useState(null);
  const [batchActionError, setBatchActionError] = useState('');
  const [busyCandidateId, setBusyCandidateId] = useState(null);
  const [isBooting, setIsBooting] = useState(true);
  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const selectedDateRef = useRef('');
  const archiveRef = useRef(null);
  const lastBatchRunAtRef = useRef(0);
  const BATCH_THROTTLE_MS = 8000;
  const { healthCheck, refresh: refreshHealthCheck } = useResumeHealthCheck();

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

  async function runBatchForDate(targetDate) {
    const now = Date.now();
    const remaining = BATCH_THROTTLE_MS - (now - lastBatchRunAtRef.current);
    if (isRunningBatch || remaining > 0) {
      setStatus(remaining > 0 ? `배치 재실행은 ${Math.ceil(remaining / 1000)}초 후 가능합니다.` : '배치 실행 중...');
      return;
    }

    lastBatchRunAtRef.current = now;
    setIsRunningBatch(true);
    setError('');
    setBatchActionError('');
    setStatus(`${targetDate} 배치 실행 중...`);

    try {
      const response = await fetch('/api/run-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: targetDate }),
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
      setBatchSummary(payload.batchSummary || null);
      void refreshHealthCheck();

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

  async function handleRunBatch() {
    await runBatchForDate(dateInput);
  }

  const stories = dayPayload?.highlights?.storyThreads || [];
  const leadStory = stories[0] || null;
  const secondaryStories = stories.slice(1);
  const storyRepos = deriveStoryRepos(dayPayload);
  const companyProjects = dayPayload?.projectGroups?.company || [];
  const openSourceProjects = dayPayload?.projectGroups?.opensource || [];
  const breakdownSegments = buildWorkEstimateSegments(dayPayload);
  const shareSentence = dayPayload?.highlights?.shareableSentence || buildWorklogShareSentence({
    outcomes: [...(dayPayload?.highlights?.businessOutcomes || []), leadStory?.outcome, leadStory?.impact],
    whyItMatters: [...(dayPayload?.highlights?.whyItMatters || []), leadStory?.why, leadStory?.impact],
    changes: [...(dayPayload?.highlights?.keyChanges || []), leadStory?.keyChange, leadStory?.decision],
  });
  const hasTodayMeaning = days.includes(SEOUL_DATE);
  const shouldShowTodayMeaningPrompt = !isBooting && !hasTodayMeaning;

  useEffect(() => {
    if (healthCheck?.batchSummary) {
      setBatchSummary(healthCheck.batchSummary);
    }
  }, [healthCheck?.batchSummary]);

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

  async function handleCandidateApprove(candidateId) {
    await updateCandidateStatus(candidateId, 'approved');
  }

  async function handleCandidateDiscard(candidateId, reasonCode) {
    await updateCandidateStatus(candidateId, 'discarded', { reasonCode });
  }

  async function updateCandidateStatus(candidateId, nextStatus, extra = {}) {
    setBusyCandidateId(candidateId);
    setBatchActionError('');

    try {
      const res = await fetch(`/api/resume/candidates/${encodeURIComponent(candidateId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus, ...extra }),
      });

      if (res.status === 401 || res.status === 403) {
        navigate(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `후보 상태를 저장하지 못했습니다. HTTP ${res.status}`);
      }

      setBatchSummary((prev) => {
        if (!prev) return prev;
        const nextLastAction = payload?.followUp
          ? {
              candidateId,
              status: nextStatus,
              actedAt: new Date().toISOString(),
              discardReasonCode: extra.reasonCode ?? null,
              discardNote: typeof extra.note === 'string' ? extra.note.trim() : null,
              followUp: payload.followUp,
            }
          : prev?.candidateGeneration?.lastAction ?? null;

        return {
          ...prev,
          candidateGeneration: {
            ...(prev.candidateGeneration || {}),
            ...(nextLastAction ? { lastAction: nextLastAction } : {}),
          },
          candidatePreview: (prev.candidatePreview || []).filter((item) => item.id !== candidateId),
        };
      });
      void refreshHealthCheck();
    } catch (err) {
      setBatchActionError(err.message || '후보 상태를 저장하지 못했습니다.');
    } finally {
      setBusyCandidateId(null);
    }
  }

  return (
    <div class="worklog-page">
      <main class="worklog-shell">
        <section class="worklog-hero">
          <div class="worklog-hero-copy">
            <p class="ds-kicker worklog-eyebrow">요약 보기</p>
            <h1>오늘 바뀐 것과 이어지는 흐름</h1>
            <p class="worklog-lede">
              커밋과 작업 흔적을 바탕으로 오늘의 변화, 이어지는 프로젝트, 반복되는 패턴을 함께 정리합니다.
            </p>
          </div>

          <div class="worklog-actions">
            <p class="ds-kicker worklog-actions-kicker">오늘 보기</p>
            <div class="worklog-action-grid">
              <div class="worklog-action-group">
                <label class="worklog-field-label" for="date-input">생성 날짜</label>
                <input
                  id="date-input"
                  type="date"
                  value={dateInput}
                  onInput={handleDateInput}
                  onChange={handleDateInput}
                  disabled={isRunningBatch}
                />
              </div>

              <div class="worklog-action-group">
                <label class="worklog-field-label" for="archive-select">기록 둘러보기</label>
                <div class="worklog-archive-picker" ref={archiveRef}>
                  <button
                    id="archive-select"
                    class="worklog-archive-trigger"
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={archiveOpen ? 'true' : 'false'}
                    onClick={() => setArchiveOpen((open) => !open)}
                    disabled={!days.length || isRunningBatch}
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
                        disabled={isRunningBatch}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div class="worklog-action-row">
              <WorklogButton type="button" onClick={handleRunBatch} disabled={isRunningBatch}>
                {isRunningBatch ? '의미를 다시 정리하는 중…' : '오늘 의미 업데이트'}
              </WorklogButton>
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

          {shouldShowTodayMeaningPrompt ? (
            <>
              <TodayMeaningSetupCard
                latestDate={days[0] || null}
                isRunningBatch={isRunningBatch}
                onGenerateToday={() => void runBatchForDate(SEOUL_DATE)}
              />
              <div class="worklog-divider" />
            </>
          ) : null}

          {isBooting ? <StateMessage message="업무로그를 불러오는 중..." /> : null}

          {!isBooting && !days.length ? (
            <StateMessage message="아직 정리된 work log가 없습니다. 오늘 기록을 한 번 생성하면 커밋과 근거가 쌓이기 시작합니다." />
          ) : null}

          {!isBooting && dayPayload?.missing ? (
            <StateMessage message={`${selectedDateRef.current} 데이터가 없습니다.`} />
          ) : null}

          {!isBooting && dayPayload && !dayPayload.missing ? (
            <div class="worklog-view">
              <section class="worklog-stat-bar">
                <StatCard label="오늘 커밋" value={dayPayload.counts?.gitCommits || 0} primary />
                <StatCard label="회사 작업" value={dayPayload.counts?.companyCommits || 0} />
                <StatCard label="개인/오픈소스" value={dayPayload.counts?.openSourceCommits || 0} />
                <StatCard label="정리 날짜" value={dayPayload.date} />
              </section>

              <div class="worklog-divider" />

              <section class="worklog-primary-meaning">
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

              <section class="worklog-secondary-grid">
                <SnapshotCard
                  profile={profile}
                  profileWindow={profileWindow}
                  onWindowChange={setProfileWindow}
                />
                <TodayBreakdownCard
                  dayPayload={dayPayload}
                  segments={breakdownSegments}
                  total={dayPayload.counts?.gitCommits || 0}
                />
              </section>

              <div class="worklog-divider" />

              <section class="worklog-story-layout">
                {leadStory ? (
                  <article class="worklog-lead-story">
                    <div class="worklog-story-meta">
                      <p class="ds-kicker worklog-section-kicker">대표 변화</p>
                      <span class="worklog-story-repo-text">{leadStory.repo || storyRepos[0] || '저장소 정보 없음'}</span>
                    </div>
                    <h2 class="worklog-story-title">{deriveStoryTitle({ outcome: leadStory.outcome, impact: leadStory.impact, why: leadStory.why, keyChange: leadStory.keyChange, repo: leadStory.repo || storyRepos[0] })}</h2>
                    <p class="worklog-lead-deck">
                      {sanitizeWorklogCopy(leadStory.impact || leadStory.why || leadStory.keyChange || '오늘의 핵심 변화가 아직 정리되지 않았습니다.', { maxLength: 160 })}
                    </p>
                    {leadStory.decision ? (
                      <div class="worklog-lead-aside">
                        <span class="worklog-story-label">판단</span>
                        <p>{leadStory.decision}</p>
                      </div>
                    ) : null}
                    <div class="worklog-lead-notes">
                      <LeadStoryFact label="핵심 변화" value={leadStory.keyChange || '없음'} />
                      <LeadStoryFact label="의미" value={leadStory.why || '없음'} />
                    </div>
                  </article>
                ) : null}

                <div class="worklog-story-column">
                  {secondaryStories.length ? secondaryStories.map((story, index) => (
                    <article key={`${story.outcome}-${index}`} class="worklog-compact-story">
                      <div class="worklog-story-meta">
                        <p class="ds-kicker worklog-section-kicker">추가 변화 {index + 2}</p>
                        <span class="worklog-story-repo-text">{story.repo || storyRepos[index + 1] || '저장소 정보 없음'}</span>
                      </div>
                      <h3 class="worklog-compact-title">{deriveStoryTitle({ outcome: story.outcome, impact: story.impact, why: story.why, keyChange: story.keyChange, repo: story.repo || storyRepos[index + 1] })}</h3>
                      <div class="worklog-story-grid worklog-story-grid--compact">
                        <CompactStoryHighlights label="핵심 변화" value={story.keyChange} />
                        <StoryLine label="영향" value={sanitizeWorklogCopy(story.impact || '없음', { maxLength: 96 })} compact />
                        <StoryLine label="의미" value={sanitizeWorklogCopy(story.why || '없음', { maxLength: 96 })} compact />
                        {story.decision ? <StoryLine label="판단" value={sanitizeWorklogCopy(story.decision, { maxLength: 96 })} compact /> : null}
                      </div>
                    </article>
                  )) : (
                    <article class="worklog-compact-story worklog-compact-story-empty">
                      <p>추가로 정리할 변화가 없습니다.</p>
                    </article>
                  )}
                </div>
              </section>

              <div class="worklog-divider" />

              {batchSummary ? (
                <>
                  <details class="worklog-batch-disclosure" open={Boolean(batchSummary?.candidateGeneration?.lastAction?.followUp)}>
                    <summary class="worklog-batch-disclosure__summary">
                      방금 정리한 업데이트 자세히 보기
                    </summary>
                    <div class="worklog-batch-disclosure__body">
                      <BatchSummaryFeed
                        summary={batchSummary}
                        busyCandidateId={busyCandidateId}
                        actionError={batchActionError}
                        onApprove={handleCandidateApprove}
                        onDiscard={handleCandidateDiscard}
                      />
                    </div>
                  </details>
                  <div class="worklog-divider" />
                </>
              ) : null}

              <section class="worklog-project-links">
                <p>
                  <strong>회사 작업</strong> · {companyProjects.length} 개 저장소 ·{' '}
                  {sumCommitCount(companyProjects)} 개 커밋 ·{' '}
                  <a href={`/projects?date=${encodeURIComponent(dayPayload.date)}&group=company`}>
                    상세 보기
                  </a>
                </p>
                <p>
                  <strong>개인/오픈소스 작업</strong> · {openSourceProjects.length} 개 저장소 ·{' '}
                  {sumCommitCount(openSourceProjects)} 개 커밋 ·{' '}
                  <a href={`/projects?date=${encodeURIComponent(dayPayload.date)}&group=opensource`}>
                    상세 보기
                  </a>
                </p>
              </section>
            </div>
          ) : null}
        </section>
      </main>
    <style>{WORKLOG_PRIMITIVES_CSS}</style>
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

function TodayMeaningSetupCard({ latestDate, isRunningBatch, onGenerateToday }) {
  return (
    <WorklogCard tone="soft" className="worklog-gap-card">
      <CardHeader
        kicker="오늘 아직 비어 있음"
        title="오늘 기록의 의미가 아직 정리되지 않았습니다"
        subtitle={
          latestDate
            ? `마지막으로 정리된 날짜는 ${latestDate}입니다. 오늘 기록을 생성하면 오늘의 핵심, 이어지는 프로젝트 흐름, 반복되는 작업 패턴이 함께 갱신됩니다.`
            : '오늘 기록을 생성하면 오늘의 핵심과 이어지는 흐름을 한 번에 정리할 수 있습니다.'
        }
      />
      <div class="worklog-action-row worklog-action-row--inline">
        <WorklogButton type="button" onClick={onGenerateToday} disabled={isRunningBatch}>
          {isRunningBatch ? '의미를 다시 정리하는 중…' : '오늘 의미 업데이트'}
        </WorklogButton>
      </div>
    </WorklogCard>
  );
}

function StatCard({ label, value, primary = false }) {
  const isNumeric = typeof value === 'number';
  return (
    <WorklogStatTile
      label={label}
      value={value}
      primary={primary}
      text={!isNumeric || label === '정리 날짜'}
    />
  );
}

function StoryLine({ label, value, compact = false, lead = false }) {
  return (
    <WorklogMetaLine label={label} value={value} compact={compact || lead} />
  );
}

function CompactStoryHighlights({ label, value }) {
  const highlights = splitCompactStoryHighlights(value);

  if (!highlights.length) {
    return <StoryLine label={label} value="없음" compact />;
  }

  if (highlights.length === 1 && highlights[0].length <= 120) {
    return <StoryLine label={label} value={highlights[0]} compact />;
  }

  const visible = highlights.slice(0, 3);
  const remaining = highlights.length - visible.length;

  return (
    <div class="worklog-story-highlights">
      <span class="wl-meta-label">{label}</span>
      <ul class="worklog-story-highlight-list">
        {visible.map((item, index) => (
          <li key={`${label}-${index}`}>{item}</li>
        ))}
      </ul>
      {remaining > 0 ? <p class="worklog-story-highlight-more">외 {remaining}개 변화</p> : null}
    </div>
  );
}

function LeadStoryFact({ label, value }) {
  return (
    <WorklogMetaLine label={label} value={value} />
  );
}

function CardHeader({ kicker, title, subtitle, aside = null, titleAside = null }) {
  return (
    <WorklogSectionHeader kicker={kicker} title={title} subtitle={subtitle} aside={aside} titleAside={titleAside} />
  );
}

function InfoCard({ kicker, title, subtitle, items, variant = 'list', maxItems }) {
  const list = Array.isArray(items) && items.length ? items : ['없음'];
  const visibleItems = typeof maxItems === 'number' ? list.slice(0, maxItems) : list;

  return (
    <WorklogCard tone="soft">
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
    </WorklogCard>
  );
}

function AIJudgmentCard({ sentence, outcomes, whyItMatters, keyChanges, aiReview, workingStyleSignals }) {
  const rankedOutcomes = rankImpactTexts((outcomes || []).map((item) => sanitizeWorklogCopy(item, { maxLength: 110 })));
  const extraOutcomes = rankedOutcomes.slice(1, 3);
  const whyLines = rankImpactTexts((whyItMatters || []).map((item) => sanitizeWorklogCopy(item, { maxLength: 110 }))).slice(0, 2);
  const changes = sanitizeWorklogList(keyChanges, { maxItems: 4, maxLength: 110 });
  const notes = sanitizeWorklogList(aiReview, { maxItems: 4, maxLength: 110 });
  const signals = sanitizeWorklogList(workingStyleSignals, { maxItems: 4, maxLength: 96 });

  const visibleChanges = changes.length ? changes : ['아직 핵심 작업 정리가 없습니다.'];
  const visibleNotes = notes.length ? notes : ['아직 평가 메모가 없습니다.'];
  const visibleSignals = signals.length ? signals : ['아직 일하는 방식 신호가 없습니다.'];

  return (
    <WorklogCard tone="primary" className="worklog-judgment-card">
      <CardHeader
        kicker="오늘의 핵심"
        title="오늘 가장 의미 있었던 변화"
        subtitle="무엇이 바뀌었는지와 그 과정에서 어떤 판단이 드러났는지를 한 번에 읽을 수 있게 정리했습니다."
      />
      <div class="worklog-judgment-hero">
        <p class="worklog-worknotes-label">오늘 한 줄 요약</p>
        <p class="worklog-judgment-line">{sentence || '오늘의 핵심을 아직 한 문장으로 정리하지 못했습니다.'}</p>
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
          <p class="worklog-worknotes-label">오늘 바뀐 것</p>
          <ul class="worklog-list worklog-list--compact">
            {visibleChanges.map((item, index) => (
              <li key={`work-change-${index}`}>{item}</li>
            ))}
          </ul>
        </section>
        <section class="worklog-judgment-column worklog-judgment-column--analysis">
          <p class="worklog-worknotes-label">해석</p>
          <div class="worklog-prose-list">
            {visibleNotes.map((item, index) => (
              <p key={`work-note-${index}`} class="worklog-prose-item worklog-prose-item--dense">{item}</p>
            ))}
          </div>
          <div class="worklog-judgment-signal-block">
            <p class="worklog-worknotes-label">드러난 패턴</p>
            <ul class="worklog-list worklog-list--compact">
              {visibleSignals.map((item, index) => (
                <li key={`work-signal-${index}`}>{item}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </WorklogCard>
  );
}

function TodayBreakdownCard({ dayPayload, segments, total }) {
  const gradient = segments.length
    ? `conic-gradient(${segments.map((segment) => `${segment.color} ${segment.start}% ${segment.end}%`).join(', ')})`
    : 'conic-gradient(#e5e7eb 0% 100%)';

  return (
    <WorklogCard className="worklog-insight-card">
      <CardHeader
        kicker="작업 구성"
        title="오늘 작업 구성"
        subtitle="커밋 수와 대표 변화를 함께 반영해 오늘의 작업 분포를 요약합니다."
      />

      <div class="worklog-breakdown-layout">
        <div class="worklog-donut-wrap">
          <div class="worklog-donut" style={{ background: gradient }}>
            <div class="worklog-donut-hole">
              <strong>{total}</strong>
              <span>커밋</span>
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
              <p>{segment.count} 개 커밋 · {segment.percent}%</p>
            </div>
          ))}
        </div>
      </div>
    </WorklogCard>
  );
}

function SnapshotCard({ profile, profileWindow, onWindowChange }) {
  const identityDraft = profile?.resumeDraft || { headline: '', summary: '', strengthLabels: [] };
  const strengths = (profile?.strengths || []).slice(0, 3).map((item) => {
    const copy = STRENGTH_COPY[item.label] || { label: item.label };
    return copy.label;
  });
  const personSignalCards = (profile?.personSignals || []).slice(0, 4).map((item) => {
    const copy = STRENGTH_COPY[item.label] || { label: item.label, description: item.description || '' };
    return { label: copy.label, description: item.description || copy.description || '', score: item.score ?? item.confidence ?? '' };
  });
  const workStyle = (profile?.workStyle || []).slice(0, 3);
  const projectArcs = (profile?.projectArcs || []).slice(0, 3);
  const strengthCards = (personSignalCards.length ? personSignalCards : (profile?.strengths || []).slice(0, 4).map((item) => {
    const copy = STRENGTH_COPY[item.label] || { label: item.label, description: '' };
    return { label: copy.label, description: copy.description || '', score: item.score };
  }));

  return (
    <WorklogCard className="worklog-insight-card">
      <header class="worklog-snapshot-header">
        <div class="worklog-snapshot-meta-row">
          <p class="ds-kicker worklog-section-kicker">누적 스냅샷</p>
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
        <h3 class="worklog-card-title">지금까지 쌓인 흐름</h3>
        <p class="ds-panel-subtitle worklog-panel-subtitle">
          {profile?.dayCount
            ? `${profile.dayCount}일치 기록을 바탕으로 지금 어떤 흐름이 이어지고 있는지 압축했습니다.`
            : '아직 누적 스냅샷이 없습니다.'}
        </p>
      </header>

      <div class="worklog-snapshot-grid">
        <SnapshotSection title="한 줄 소개" items={[]} emptyText="">
          {identityDraft.headline || identityDraft.summary ? (
            <div class="worklog-identity-draft">
              {identityDraft.headline ? <p class="worklog-identity-draft-headline">{identityDraft.headline}</p> : null}
              {identityDraft.summary ? <p class="worklog-identity-draft-body">{identityDraft.summary}</p> : null}
            </div>
          ) : <p class="worklog-snapshot-empty">아직 한 줄 소개를 만들 만큼 데이터가 충분하지 않습니다.</p>}
        </SnapshotSection>
        <SnapshotSection title="반복되는 강점" items={[]} emptyText="">
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
          ) : <p class="worklog-snapshot-empty">아직 뚜렷하게 반복된 작업 패턴이 없습니다.</p>}
        </SnapshotSection>
        <SnapshotSection title="이어지는 프로젝트" items={[]} emptyText="">
          {projectArcs.length ? (
            <ul class="worklog-list">
              {projectArcs.map((project) => (
                <li key={project.repo}>
                  <strong>{project.repo}</strong> · {project.summary}
                </li>
              ))}
            </ul>
          ) : <p class="worklog-snapshot-empty">아직 길게 이어지는 프로젝트 흐름이 선명하지 않습니다.</p>}
        </SnapshotSection>
        <SnapshotSection title="요약 라벨" items={identityDraft.strengthLabels || []} emptyText="아직 요약할 수 있는 라벨이 없습니다." />
        <SnapshotSection title="반복되는 작업 방식" items={workStyle} emptyText="아직 반복되는 작업 방식이 선명하지 않습니다." tone="sentence" />
      </div>
    </WorklogCard>
  );
}

function SnapshotSection({ title, items, emptyText, tone = 'chip', children }) {
  return (
    <WorklogMiniSection title={title} empty={emptyText}>
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
        ) : null
      )}
    </WorklogMiniSection>
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
    { key: 'company', label: '회사 작업', count: company, color: '#334155' },
    { key: 'opensource', label: '개인/오픈소스', count: openSource, color: '#6366f1' },
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
  const repoFallback = deriveStoryRepos(dayPayload);

  return stories
    .map((story, index) => story.repo || repoFallback[index] || null)
    .map((repo) => byRepo.get(repo) || null)
    .filter(Boolean);
}


async function fetchProfileSummary(windowKey, onAuthFailure = null) {
  const query = windowKey && windowKey !== 'all' ? `?window=${windowKey}` : '';
  const response = await fetch(`/api/profile${query}`);
  if (typeof onAuthFailure === "function" && onAuthFailure(response)) return null;
  if (!response.ok) return null;
  return response.json();
}
