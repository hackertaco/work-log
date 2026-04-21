import { useState } from 'preact/hooks';
import { HealthCheckCard } from './HealthCheckCard.jsx';
import { LinkedInStep } from './LinkedInStep.jsx';
import { PdfUploadOnboarding } from './PdfUploadOnboarding.jsx';

/**
 * OnboardingView
 *
 * 이력서가 없을 때 표시되는 온보딩 오케스트레이터.
 * 두 단계로 구성된다:
 *
 *  Step 1 — LinkedIn 프로필 수집 (LinkedInStep)
 *    LinkedIn URL 입력 → 성공 시 데이터 수집
 *    실패(네트워크 오류, insufficient_data) 시 → 텍스트 직접 입력 (Sub-AC 3c)
 *    건너뛰기 → 다음 단계로 이동
 *
 *  Step 2 — PDF 이력서 업로드 (PdfUploadOnboarding)
 *    기존 이력서 PDF를 업로드하면 Living Resume 시스템이 초기화됨
 *    완료 후 상위 컴포넌트(ResumePage)의 onComplete() 호출 → 이력서 재조회
 *
 * @param {{ onComplete: () => void }} props
 *   onComplete — 온보딩 완료 후 ResumePage 에서 이력서를 재조회하는 콜백
 */
export function OnboardingView({ onComplete, healthCheck = null, onHealthAction = null }) {
  const [step, setStep] = useState('linkedin'); // 'linkedin' | 'pdf'
  /**
   * LinkedIn 단계에서 수집된 프로필 데이터.
   * null이면 LinkedIn 단계를 건너뛴 것.
   * @type {[object|null, Function]}
   */
  const [linkedinProfile, setLinkedinProfile] = useState(null);

  // ── Step 2: PDF upload ─────────────────────────────────────────────────
  if (step === 'pdf') {
    return (
      <PdfUploadOnboarding
        linkedinProfile={linkedinProfile}
        onComplete={(resumeData) => {
          window.sessionStorage.setItem('resume_onboarding_completed', '1');
          onComplete?.(resumeData);
        }}
        onBack={() => {
          setStep('linkedin');
          setLinkedinProfile(null);
        }}
      />
    );
  }

  // ── Step 1: LinkedIn fetch + fallback textarea (Sub-AC 3c) ─────────────
  return (
    <div class="onboarding-shell">
      <div class="onboarding-card">
        {/* Header */}
        <div class="onboarding-header">
          <div class="onboarding-logo">WL</div>
          <h1 class="onboarding-title">이력서 시작하기</h1>
          <p class="onboarding-subtitle">
            LinkedIn 프로필과 기존 PDF를 연결하면 기본 이력서를 만들고, 이후 기록/제안/채팅 흐름이 열립니다.
          </p>
        </div>

        {healthCheck ? (
          <HealthCheckCard
            healthCheck={healthCheck}
            title="시작 전에 지금 상태 확인"
            compact
            onAction={onHealthAction}
          />
        ) : null}

        {/* Step indicator */}
        <div class="onboarding-steps" aria-label="온보딩 단계">
          <span class="onboarding-step onboarding-step--active">
            1. LinkedIn
          </span>
          <span class="onboarding-step-sep" aria-hidden="true">→</span>
          <span class="onboarding-step onboarding-step--pending">
            2. PDF 업로드
          </span>
        </div>

        {/* LinkedInStep handles both URL input and fallback textarea (Sub-AC 3c) */}
        <LinkedInStep
          onComplete={(profile) => {
            setLinkedinProfile(profile);
            setStep('pdf');
          }}
          onSkip={() => {
            setLinkedinProfile(null);
            setStep('pdf');
          }}
        />
      </div>

      <style>{ONBOARDING_CSS}</style>
    </div>
  );
}

/* ─── Shell styles ───────────────────────────────────────────────────────── */

const ONBOARDING_CSS = `
  .onboarding-shell {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-7) var(--space-4);
    min-height: 70vh;
  }

  .onboarding-card {
    width: 100%;
    max-width: 520px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow);
    backdrop-filter: blur(10px);
    padding: 40px 40px 36px;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .onboarding-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    text-align: center;
  }

  .onboarding-logo {
    width: 48px;
    height: 48px;
    border-radius: var(--radius-md);
    background: var(--ink);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.05em;
    margin-bottom: var(--space-1);
  }

  .onboarding-title {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    color: var(--ink);
    letter-spacing: -0.02em;
  }

  .onboarding-subtitle {
    margin: 0;
    font-size: 14px;
    color: var(--muted);
    line-height: 1.55;
  }

  .onboarding-steps {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .onboarding-step {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
  }

  .onboarding-step--active {
    background: var(--ink);
    color: #fff;
  }

  .onboarding-step--pending {
    color: var(--muted);
  }

  .onboarding-step-sep {
    color: var(--muted);
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  @media (max-width: 560px) {
    .onboarding-card {
      padding: 32px 20px 24px;
    }
    .onboarding-title {
      font-size: 20px;
    }
  }
`;
