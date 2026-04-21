import { navigate } from '../../App.jsx';

export function HealthCheckCard({
  healthCheck,
  title = '지금 상태 확인',
  compact = false,
  onAction,
}) {
  if (!healthCheck) return null;

  const handleAction = (action) => {
    if (!action) return;
    if (onAction) {
      onAction(action);
      return;
    }
    navigate(action.href);
  };

  return (
    <section class={`resume-health-card${compact ? ' resume-health-card--compact' : ''}`}>
      <header class="resume-health-card__header">
        <div>
          <p class="resume-health-card__eyebrow">HEALTH CHECK</p>
          <h2>{title}</h2>
          <p>{healthCheck.headline}</p>
        </div>
      </header>

      <p class="resume-health-card__body">{healthCheck.body}</p>

      <div class="resume-health-card__grid">
        {[healthCheck.resume, healthCheck.batch, healthCheck.draft].map((item) => (
          <article key={item.label} class={`resume-health-card__item resume-health-card__item--${item.status}`}>
            <span>{item.label}</span>
            <strong>{statusLabel(item.status)}</strong>
            <p>{item.detail}</p>
          </article>
        ))}
      </div>

      <div class="resume-health-card__actions">
        <button type="button" class="resume-health-card__primary" onClick={() => handleAction(healthCheck.primaryAction)}>
          {healthCheck.primaryAction.label}
        </button>
        <div class="resume-health-card__secondary">
          {healthCheck.secondaryActions.map((action) => (
            <button key={action.kind} type="button" class="resume-health-card__secondary-btn" onClick={() => handleAction(action)}>
              {action.label}
            </button>
          ))}
        </div>
      </div>

      <style>{HEALTH_CHECK_CSS}</style>
    </section>
  );
}

function statusLabel(status) {
  switch (status) {
    case 'ready':
      return '준비됨';
    case 'pending':
      return '진행 중';
    case 'failed':
      return '다시 시도 필요';
    default:
      return '아직 없음';
  }
}

export const HEALTH_CHECK_CSS = `
  .resume-health-card {
    padding: 22px;
    border-radius: 24px;
    border: 1px solid rgba(148, 163, 184, 0.2);
    background: rgba(255, 255, 255, 0.84);
    box-shadow: 0 14px 32px rgba(15, 23, 42, 0.06);
    display: grid;
    gap: 16px;
  }

  .resume-health-card--compact {
    padding: 18px;
  }

  .resume-health-card__header h2,
  .resume-health-card__header p,
  .resume-health-card__item p,
  .resume-health-card__body {
    margin: 0;
  }

  .resume-health-card__eyebrow {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.18em;
    color: var(--muted);
  }

  .resume-health-card__body {
    color: var(--muted);
    line-height: 1.7;
  }

  .resume-health-card__grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }

  .resume-health-card__item {
    border-radius: 18px;
    border: 1px solid rgba(148, 163, 184, 0.18);
    background: rgba(255, 255, 255, 0.9);
    padding: 14px;
    display: grid;
    gap: 6px;
  }

  .resume-health-card__item span {
    font-size: 12px;
    color: var(--muted);
  }

  .resume-health-card__item strong {
    font-size: 16px;
  }

  .resume-health-card__item--ready strong {
    color: #166534;
  }

  .resume-health-card__item--pending strong {
    color: #92400e;
  }

  .resume-health-card__item--failed strong {
    color: #b91c1c;
  }

  .resume-health-card__actions,
  .resume-health-card__secondary {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }

  .resume-health-card__primary,
  .resume-health-card__secondary-btn {
    border-radius: 999px;
    padding: 10px 14px;
    border: 1px solid rgba(148, 163, 184, 0.24);
    cursor: pointer;
    font-weight: 600;
  }

  .resume-health-card__primary {
    background: rgba(17, 24, 39, 0.95);
    color: #fff;
    border-color: rgba(17, 24, 39, 0.95);
  }

  .resume-health-card__secondary-btn {
    background: rgba(255, 255, 255, 0.9);
    color: var(--text-strong);
  }

  @media (max-width: 860px) {
    .resume-health-card__grid {
      grid-template-columns: 1fr;
    }
  }
`;
