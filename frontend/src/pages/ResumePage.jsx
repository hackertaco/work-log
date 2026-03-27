import { useEffect, useState } from 'preact/hooks';
import { navigate } from '../App.jsx';
import { OnboardingView } from '../components/resume/OnboardingView.jsx';
import { ResumeLayout } from '../components/resume/ResumeLayout.jsx';
import { ResumeMainView } from '../components/resume/ResumeMainView.jsx';
import { SuggestionPanel } from '../components/resume/SuggestionPanel.jsx';
import { LinkedInSupplementPanel } from '../components/resume/LinkedInSupplementPanel.jsx';
import { CacheRebuildPanel } from '../components/resume/CacheRebuildPanel.jsx';
import { AxesPanel } from '../components/resume/AxesPanel.jsx';
import { AxisMergePanel } from '../components/resume/AxisMergePanel.jsx';
import { StrengthKeywordsPanel } from '../components/resume/StrengthKeywordsPanel.jsx';
import { DisplayAxesView } from '../components/resume/DisplayAxesView.jsx';

/**
 * /resume 라우트
 *
 * GET /api/resume/status (경량 존재 확인) 응답을 먼저 확인한 뒤,
 * 이력서 존재 여부에 따라 두 화면을 조건부 렌더링한다.
 *
 *  - { exists: false } → <OnboardingView> (PDF 업로드 + LinkedIn URL 입력)
 *  - { exists: true }  → GET /api/resume 로 전체 문서 로드 후 <ResumeMainView>
 *
 * 인증은 쿠키 기반 (credentials: 'include').
 * 401/403 응답이 오면 /login 으로 리디렉션한다.
 */
export function ResumePage() {
  const [phase, setPhase] = useState('loading'); // 'loading' | 'onboarding' | 'main' | 'error'
  const [resume, setResume] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  /**
   * pending 후보 수 — 헤더 배지 표시용.
   * 두 패널(LinkedInSupplementPanel, SuggestionPanel)의 pending 수를 합산해 표시한다.
   */
  const [linkedinPendingCount, setLinkedinPendingCount] = useState(0);
  const [worklogPendingCount, setWorklogPendingCount] = useState(0);
  const pendingCount = linkedinPendingCount + worklogPendingCount;

  /**
   * 두 단계로 이력서를 로드한다.
   *
   * 1단계: GET /api/resume/status — Blob 존재 여부만 확인 (문서 본문 다운로드 없음)
   *   • { exists: false } → onboarding 단계로 전환
   *   • { exists: true }  → 2단계로 진행
   *
   * 2단계: GET /api/resume — 전체 이력서 문서를 내려받아 상태에 저장
   */
  async function fetchResume() {
    setPhase('loading');
    setErrorMsg('');

    try {
      // ── 1단계: 경량 존재 확인 ──────────────────────────────────────────────
      const statusRes = await fetch('/api/resume/status', { credentials: 'include' });

      if (statusRes.status === 401 || statusRes.status === 403) {
        navigate('/login');
        return;
      }

      if (!statusRes.ok) {
        throw new Error(`서버 오류: HTTP ${statusRes.status}`);
      }

      const status = await statusRes.json();

      // 이력서가 없으면 온보딩 화면으로 전환
      if (!status.exists) {
        setResume(null);
        setPhase('onboarding');
        return;
      }

      // ── 2단계: 전체 문서 로드 ─────────────────────────────────────────────
      const resumeRes = await fetch('/api/resume', { credentials: 'include' });

      if (resumeRes.status === 401 || resumeRes.status === 403) {
        navigate('/login');
        return;
      }

      if (resumeRes.status === 404) {
        // status=exists 지만 문서가 없는 경합 상태 → 온보딩으로 폴백
        setResume(null);
        setPhase('onboarding');
        return;
      }

      if (!resumeRes.ok) {
        throw new Error(`서버 오류: HTTP ${resumeRes.status}`);
      }

      const data = await resumeRes.json();
      // API returns { exists: true, resume: { ...document } }
      // Extract the inner document so components receive the resume object directly.
      setResume(data.resume ?? data);
      setPhase('main');
    } catch (err) {
      setErrorMsg(err.message);
      setPhase('error');
    }
  }

  useEffect(() => {
    fetchResume();
  }, []);

  if (phase === 'loading') {
    return <LoadingScreen />;
  }

  if (phase === 'error') {
    return <ErrorScreen message={errorMsg} onRetry={fetchResume} />;
  }

  if (phase === 'onboarding') {
    // 온보딩 컴포넌트들은 자체 전체 페이지 레이아웃을 가짐
    return <OnboardingView onComplete={fetchResume} />;
  }

  // phase === 'main' — 이력서 본문 + 제안 패널 2-column 레이아웃
  return (
    <ResumeShell pendingCount={pendingCount}>
      <ResumeLayout
        body={
          <ResumeMainView
            resume={resume}
            onRefresh={fetchResume}
            onResumePatched={setResume}
          />
        }
        panel={
          <>
            {/*
             * LinkedInSupplementPanel — LinkedIn 기반 보충/검증 제안 패널 (Sub-AC 4-3).
             * 온보딩 시 수집된 LinkedIn 데이터와 이력서 간 gap에서 생성된
             * source='linkedin' pending 제안을 섹션별로 표시한다.
             * 항목별 승인·편집·제외 UI를 제공하며, 승인 시 이력서에 즉시 반영된다.
             */}
            <LinkedInSupplementPanel
              onResumePatched={setResume}
              onResumeUpdated={fetchResume}
              onPendingCountChange={setLinkedinPendingCount}
            />

            {/*
             * SuggestionPanel — 업무 로그 기반 갱신 제안 패널.
             * source='work_log' 제안만 표시 (LinkedIn 제안은 위 패널에서 처리).
             * onResumePatched: 서버 응답 resume 객체를 직접 수신해 추가 GET 없이 갱신.
             * onResumeUpdated: fallback — 서버 응답에 resume 없을 때 재조회.
             * onPendingCountChange: pending 수 변경 시 헤더 배지 갱신.
             */}
            {/*
             * StrengthKeywordsPanel — 강점 키워드 관리 패널 (Sub-AC 15-3).
             * 이력서에 저장된 강점 키워드를 태그로 표시하며
             * 직접 입력 추가 및 삭제 기능을 제공한다.
             */}
            <StrengthKeywordsPanel />
            {/*
             * DisplayAxesView — 프로필 분석 전용 뷰 (Sub-AC 24a).
             * resume 상태와 완전히 분리된 독립 컴포넌트:
             *   - props 없음 (resume 객체 수신 없음)
             *   - 축 변경 이벤트가 resume 데이터를 직접 수정하지 않음
             *   - 단방향 데이터 흐름: API → 로컬 상태 → 렌더링
             * AxesPanel(편집 패널)과 역할 분리: 이 컴포넌트는 읽기/분석 전용.
             */}
            <DisplayAxesView />
            <AxesPanel />
            <AxisMergePanel />
            <SuggestionPanel
              onResumePatched={setResume}
              onResumeUpdated={fetchResume}
              onPendingCountChange={setWorklogPendingCount}
            />
            <CacheRebuildPanel />
          </>
        }
      />
    </ResumeShell>
  );
}

/* ──────────────────────────────────────────── */
/* Shell: 페이지 공통 레이아웃 (헤더 포함)    */
/* ──────────────────────────────────────────── */

/**
 * ResumeShell — 페이지 공통 레이아웃 (헤더 포함)
 *
 * pendingCount: pending 후보 수. 1 이상이면 "LIVING RESUME" 옆에 숫자 배지를 표시한다.
 */
function ResumeShell({ children, pendingCount = 0 }) {
  return (
    <div class="resume-shell">
      <header class="resume-header">
        <div class="resume-header-inner">
          <div class="resume-wordmark">
            <span class="resume-wordmark-label">WORK LOG</span>
            <span class="resume-wordmark-sep">·</span>
            <span class="resume-wordmark-page">LIVING RESUME</span>
            {pendingCount > 0 && (
              <span
                class="resume-pending-badge"
                aria-label={`미처리 갱신 제안 ${pendingCount}건`}
                title={`갱신 제안 ${pendingCount}건 대기 중`}
              >
                {pendingCount}
              </span>
            )}
          </div>
          <nav class="resume-nav">
            <a href="/" class="resume-nav-link">업무 로그</a>
            <button class="resume-nav-print" onClick={() => window.print()}>
              인쇄 / PDF 저장
            </button>
          </nav>
        </div>
      </header>

      <main class="resume-main">{children}</main>

      <style>{SHELL_CSS}</style>
    </div>
  );
}

/* ──────────────────────────────────────────── */
/* 전체화면 로딩 / 오류 상태 (쉘 없음)        */
/* ──────────────────────────────────────────── */

function LoadingScreen() {
  return (
    <div class="rs-fullscreen">
      <div class="resume-spinner" aria-label="불러오는 중" />
      <p class="resume-state-msg">이력서 불러오는 중…</p>
      <style>{`
        .rs-fullscreen {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-4);
        }
      `}</style>
    </div>
  );
}

function ErrorScreen({ message, onRetry }) {
  return (
    <div class="rs-fullscreen">
      <p class="resume-state-error">{message}</p>
      <button class="resume-retry-btn" onClick={onRetry}>
        다시 시도
      </button>
      <style>{`
        .rs-fullscreen {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-4);
        }
      `}</style>
    </div>
  );
}

/* ──────────────────────────────────────────── */
/* Styles                                       */
/* ──────────────────────────────────────────── */

const SHELL_CSS = `
  .resume-shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* ─── Header ─── */
  .resume-header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    backdrop-filter: blur(10px);
  }

  .resume-header-inner {
    max-width: 1100px;
    margin: 0 auto;
    padding: var(--space-4) var(--space-5);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .resume-wordmark {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink);
    user-select: none;
  }

  .resume-wordmark-sep {
    color: var(--muted);
    font-weight: 400;
  }

  .resume-wordmark-page {
    color: var(--muted);
  }

  /* Pending-count badge next to "LIVING RESUME" in the header */
  .resume-pending-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0;
    text-transform: none;
    background: #2563eb;
    color: #fff;
    /* Align with the wordmark baseline */
    vertical-align: middle;
    margin-top: -1px;
  }

  @media print {
    .resume-pending-badge { display: none; }
  }

  .resume-nav {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .resume-nav-link {
    font-size: 13px;
    font-weight: 500;
    color: var(--muted);
    transition: color 0.15s;
  }

  .resume-nav-link:hover {
    color: var(--ink);
  }

  .resume-nav-print {
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 600;
    background: var(--ink);
    color: #fff;
    border: none;
    border-radius: var(--radius-md);
    transition: opacity 0.15s;
  }

  .resume-nav-print:hover {
    opacity: 0.82;
  }

  @media print {
    .resume-header { display: none; }
  }

  /* ─── Main ─── */
  .resume-main {
    flex: 1;
    max-width: 1100px;
    width: 100%;
    margin: 0 auto;
    padding: var(--space-7) var(--space-5);
  }

  @media print {
    /* Remove page chrome: the @page rule already supplies margins */
    .resume-shell {
      min-height: auto;
      display: block;
    }

    .resume-main {
      padding: 0;
      max-width: 100%;
      margin: 0;
      width: 100%;
    }
  }

  /* ─── Loading / Error ─── */
  .resume-state-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    min-height: 40vh;
  }

  .resume-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: rs-spin 0.7s linear infinite;
  }

  @keyframes rs-spin {
    to { transform: rotate(360deg); }
  }

  .resume-state-msg {
    margin: 0;
    font-size: 14px;
    color: var(--muted);
  }

  .resume-state-error {
    margin: 0;
    font-size: 14px;
    color: #e53e3e;
    text-align: center;
    max-width: 360px;
  }

  .resume-retry-btn {
    padding: 8px 20px;
    font-size: 14px;
    font-weight: 600;
    background: var(--ink);
    color: #fff;
    border: none;
    border-radius: var(--radius-md);
    transition: opacity 0.15s;
  }

  .resume-retry-btn:hover {
    opacity: 0.82;
  }
`;
