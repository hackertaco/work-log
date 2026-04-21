import { HealthCheckCard } from './HealthCheckCard.jsx';

export function NextStepPanel({ healthCheck, onDismiss, onAction }) {
  if (!healthCheck) return null;

  return (
    <section class="resume-next-step-panel">
      <div class="resume-next-step-panel__top">
        <div>
          <p class="resume-next-step-panel__eyebrow">SETUP COMPLETE</p>
          <h2>기본 준비가 끝났습니다. 이제 다음 한 걸음만 고르면 됩니다.</h2>
          <p>
            가장 빠른 흐름은 “오늘 기록 생성 → 후보 확인 → 필요하면 채팅으로 다듬기”입니다.
          </p>
        </div>
        <button type="button" class="resume-next-step-panel__close" onClick={onDismiss}>닫기</button>
      </div>

      <HealthCheckCard
        healthCheck={healthCheck}
        title="지금 바로 추천하는 다음 단계"
        onAction={onAction}
      />

      <div class="resume-next-step-panel__examples">
        <strong>채팅에서 이렇게 시작할 수 있어요</strong>
        <ul>
          {healthCheck.chatExamples.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <style>{`
        .resume-next-step-panel {
          display: grid;
          gap: 16px;
          margin-bottom: 20px;
        }
        .resume-next-step-panel__top {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: start;
        }
        .resume-next-step-panel__top h2,
        .resume-next-step-panel__top p,
        .resume-next-step-panel__examples ul {
          margin: 0;
        }
        .resume-next-step-panel__eyebrow {
          margin: 0 0 6px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.18em;
          color: var(--muted);
        }
        .resume-next-step-panel__close {
          border: 0;
          background: transparent;
          color: var(--muted);
          cursor: pointer;
          font-weight: 600;
        }
        .resume-next-step-panel__examples {
          padding: 16px 18px;
          border-radius: 18px;
          background: rgba(255,255,255,0.72);
          border: 1px solid rgba(148,163,184,0.18);
        }
        .resume-next-step-panel__examples ul {
          margin-top: 8px;
          padding-left: 20px;
          display: grid;
          gap: 6px;
          color: var(--muted);
        }
      `}</style>
    </section>
  );
}
