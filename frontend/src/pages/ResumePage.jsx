import { useEffect, useState } from 'preact/hooks';
import { navigate } from '../App.jsx';
import { OnboardingView } from '../components/resume/OnboardingView.jsx';
import { ResumeLayout } from '../components/resume/ResumeLayout.jsx';
import { ResumeMainView } from '../components/resume/ResumeMainView.jsx';
import { ResumeShell } from '../components/resume/ResumeShell.jsx';
import { SuggestionPanel } from '../components/resume/SuggestionPanel.jsx';
import { LinkedInSupplementPanel } from '../components/resume/LinkedInSupplementPanel.jsx';

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
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState('');

  const pendingCount = suggestions.filter((s) => s.status === 'pending').length;

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

  useEffect(() => {
    if (phase === 'main') {
      fetchSuggestions();
      return;
    }
    setSuggestions([]);
    setSuggestionsError('');
    setSuggestionsLoading(false);
  }, [phase]);

  async function fetchSuggestions() {
    setSuggestionsLoading(true);
    setSuggestionsError('');
    try {
      const res = await fetch('/api/resume/suggestions', { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        navigate('/login');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSuggestions(data.suggestions ?? []);
    } catch (err) {
      setSuggestions([]);
      setSuggestionsError(err.message || '제안 목록을 불러오지 못했습니다.');
    } finally {
      setSuggestionsLoading(false);
    }
  }

  function markSuggestionResolved(id, nextStatus) {
    setSuggestions((prev) =>
      prev.map((item) => (item.id === id ? { ...item, status: nextStatus } : item))
    );
  }

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
    <ResumeShell pendingCount={pendingCount} activePage="resume">
      <ResumeLayout
        body={
          <ResumeMainView
            resume={resume}
            onRefresh={fetchResume}
            onResumePatched={setResume}
            suggestions={suggestions}
            onSuggestionResolved={markSuggestionResolved}
          />
        }
        panel={
          <>
            <LinkedInSupplementPanel
              suggestions={suggestions}
              loading={suggestionsLoading}
              fetchError={suggestionsError}
              onRefreshSuggestions={fetchSuggestions}
              onSuggestionResolved={markSuggestionResolved}
              onResumePatched={setResume}
              onResumeUpdated={fetchResume}
            />
            <SuggestionPanel
              suggestions={suggestions}
              loading={suggestionsLoading}
              fetchError={suggestionsError}
              onRefreshSuggestions={fetchSuggestions}
              onSuggestionResolved={markSuggestionResolved}
              onResumePatched={setResume}
              onResumeUpdated={fetchResume}
            />
          </>
        }
      />
    </ResumeShell>
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
