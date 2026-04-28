import { useMemo, useState } from 'preact/hooks';
import { WorklogButton, WorklogCard, WorklogLinkButton, WorklogSectionHeader } from '../worklog/Primitives.jsx';

const DISCARD_REASON_OPTIONS = [
  { code: 'too_vague', label: '너무 모호함' },
  { code: 'inaccurate', label: '사실과 다름' },
  { code: 'duplicate', label: '중복' },
  { code: 'wrong_focus', label: '포인트가 다름' },
  { code: 'tone_off', label: '톤이 어색함' },
  { code: 'missing_metric', label: '수치가 없음' },
];

export function BatchSummaryFeed({
  summary,
  busyCandidateId = null,
  actionError = '',
  onApprove,
  onDiscard,
}) {
  const [discardTargetId, setDiscardTargetId] = useState(null);
  const followUp = summary?.candidateGeneration?.lastAction?.followUp ?? null;

  const sourceStats = useMemo(() => ([
    { label: '커밋', value: summary?.sourceCounts?.git커밋 ?? 0 },
    { label: '슬랙', value: summary?.sourceCounts?.slackContexts ?? 0 },
    { label: '세션', value: summary?.sourceCounts?.sessions ?? 0 },
    { label: '쉘', value: summary?.sourceCounts?.shellCommands ?? 0 },
  ]), [summary]);

  if (!summary) return null;

  return (
    <WorklogCard className="worklog-batch-summary" tone="soft">
      <WorklogSectionHeader
        kicker="업데이트 요약"
        title="오늘 모인 근거와 정리 결과"
        subtitle={`${summary.date} 기록에서 무엇이 모였고, 어떤 변화가 정리됐는지 바로 확인합니다.`}
        aside={
          <div class="worklog-batch-summary__status">
            <StatusPill kind={summary?.candidateGeneration?.status}>
              {summary?.candidateGeneration?.message || '이번 배치 결과를 정리했습니다.'}
            </StatusPill>
            <DraftStatus draft={summary?.draft} />
          </div>
        }
      />

      <div class="worklog-batch-summary__stats">
        {sourceStats.map((item) => (
          <article key={item.label} class="worklog-batch-summary__stat">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </div>

      <div class="worklog-batch-summary__body">
        <article class="worklog-batch-summary__panel">
          <p class="worklog-batch-summary__panel-kicker">정리 결과</p>
          <h3>이번 업데이트에서 {summary?.candidateGeneration?.generated ?? 0}개 변화 후보가 잡혔습니다</h3>
          <ul class="worklog-batch-summary__meta">
            <li>대기 중이던 기존 후보 교체: {summary?.candidateGeneration?.superseded ?? 0}개</li>
            {typeof summary?.candidateGeneration?.deltaRatio === 'number' ? (
              <li>변화 비율: {(summary.candidateGeneration.deltaRatio * 100).toFixed(1)}%</li>
            ) : null}
          </ul>
          {summary?.emptyState ? (
            <div class="worklog-batch-summary__empty">
              <strong>{summary.emptyState.title}</strong>
              <p>{summary.emptyState.body}</p>
            </div>
          ) : (
            <p class="worklog-batch-summary__hint">아래 후보를 바로 검토하거나, 채팅으로 더 다듬을 수 있습니다.</p>
          )}
        </article>

        <article class="worklog-batch-summary__panel">
          <p class="worklog-batch-summary__panel-kicker">후보 미리보기</p>
          <h3>지금 바로 검토할 수 있는 후보</h3>

          {actionError ? (
            <p class="worklog-batch-summary__error">{actionError}</p>
          ) : null}

          {Array.isArray(summary?.candidatePreview) && summary.candidatePreview.length ? (
            <div class="worklog-batch-summary__candidate-list">
              {summary.candidatePreview.map((item) => {
                const isBusy = busyCandidateId === item.id;
                const discardOpen = discardTargetId === item.id;

                return (
                  <article key={item.id} class="worklog-batch-summary__candidate">
                    <div class="worklog-batch-summary__candidate-head">
                      <span class="worklog-batch-summary__badge">{labelForSection(item.section)}</span>
                      <span class="worklog-batch-summary__action">{labelForAction(item.action)}</span>
                    </div>
                    <p class="worklog-batch-summary__candidate-copy">{item.description}</p>
                    <div class="worklog-batch-summary__candidate-actions">
                      <WorklogButton
                        type="button"
                        variant="secondary"
                        className="worklog-inline-action"
                        disabled={isBusy}
                        onClick={() => onApprove?.(item.id)}
                      >
                        {isBusy ? '처리 중…' : '승인'}
                      </WorklogButton>
                      <WorklogButton
                        type="button"
                        variant="quiet"
                        className="worklog-inline-action worklog-inline-action--secondary"
                        disabled={isBusy}
                        onClick={() => setDiscardTargetId(discardOpen ? null : item.id)}
                      >
                        버리기
                      </WorklogButton>
                      <WorklogLinkButton
                        variant="quiet"
                        className="worklog-inline-action worklog-inline-action--secondary"
                        href={`/resume/chat?candidateId=${encodeURIComponent(item.id)}`}
                      >
                        채팅으로 다듬기
                      </WorklogLinkButton>
                    </div>
                    {discardOpen ? (
                      <div class="worklog-batch-summary__reason-list">
                        {DISCARD_REASON_OPTIONS.map((option) => (
                          <button
                            key={option.code}
                            type="button"
                            class="worklog-reason-chip"
                            disabled={isBusy}
                            onClick={() => {
                              setDiscardTargetId(null);
                              onDiscard?.(item.id, option.code);
                            }}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <div class="worklog-batch-summary__empty">
              <strong>지금 바로 검토할 후보는 없습니다</strong>
              <p>대신 왜 후보가 없었는지, 아직 정리 중인 항목이 있는지는 위에서 바로 확인할 수 있습니다.</p>
            </div>
          )}
        </article>
      </div>

      {followUp ? (
        <article class="worklog-batch-summary__follow-up">
          <div class="worklog-batch-summary__follow-up-head">
            <div>
              <p class="worklog-batch-summary__panel-kicker">추가로 확인할 것</p>
              <h3>{followUp.title}</h3>
            </div>
            {followUp.note ? (
              <span class="worklog-batch-summary__follow-up-note">{followUp.note}</span>
            ) : null}
          </div>
          <p class="worklog-batch-summary__follow-up-body">{followUp.body}</p>
          {Array.isArray(followUp.questions) && followUp.questions.length ? (
            <ul class="worklog-batch-summary__follow-up-list">
              {followUp.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          ) : null}
          {Array.isArray(followUp.actions) && followUp.actions.length ? (
            <div class="worklog-batch-summary__follow-up-actions">
              {followUp.actions.map((action) => (
                <WorklogLinkButton
                  key={`${action.kind}-${action.href}`}
                  variant="secondary"
                  className="worklog-inline-action worklog-inline-action--link"
                  href={action.href}
                >
                  {action.label}
                </WorklogLinkButton>
              ))}
            </div>
          ) : null}
        </article>
      ) : null}

      <div class="worklog-batch-summary__footer">
        <WorklogLinkButton variant="secondary" className="worklog-back-link worklog-back-link--secondary" href="/resume/chat">채팅으로 이어서 정리하기</WorklogLinkButton>
      </div>
    </WorklogCard>
  );
}

function StatusPill({ kind, children }) {
  return <span class={`worklog-status-pill worklog-status-pill--${kind || 'default'}`}>{children}</span>;
}

function DraftStatus({ draft }) {
  const text = draft?.status === 'completed'
    ? '정리 초안 완료'
    : draft?.status === 'failed'
      ? '정리 초안 실패'
      : draft?.status === 'pending'
        ? '정리 초안 생성 중'
        : '정리 초안 없음';

  return <span class="worklog-batch-summary__draft">{text}</span>;
}

function labelForSection(section) {
  switch (section) {
    case 'summary':
      return '요약';
    case 'experience':
      return '경력';
    case 'projects':
      return '프로젝트';
    case 'skills':
      return '기술';
    default:
      return section || '기타';
  }
}

function labelForAction(action) {
  switch (action) {
    case 'append_bullet':
      return '불릿 추가';
    case 'update_summary':
      return '요약 수정';
    case 'add_skill':
      return '기술 추가';
    case 'add_experience':
      return '경력 추가';
    case 'delete_item':
      return '항목 정리';
    default:
      return action || '제안';
  }
}
