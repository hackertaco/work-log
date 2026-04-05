import { useState } from 'preact/hooks';

/**
 * CoverageFollowUpPanel — 이력서 커버리지 부족 항목 보충 질문 패널
 *
 * Sub-AC 9-2: 부족한 항목에 대해 사용자에게 구체적인 보충 질문을 생성하고
 * 채팅 UI에 표시하는 기능.
 *
 * Props:
 *   noticeMessage    — string         — 안내 메시지 (buildCoverageNoticeMessage 결과)
 *   followUpQuestions — FollowUpQuestion[] — 보충 질문 목록
 *   onQuestionClick  — (questionText: string) => void — 질문 클릭 시 채팅에 전송
 *   onDismiss        — () => void     — 패널 닫기
 *
 * FollowUpQuestion 구조 (from resumeInsufficientItemQuestions.mjs):
 *   id:        string
 *   question:  string
 *   section:   'experience'|'skills'|'summary'|'projects'
 *   company?:  string
 *   itemText:  string
 *   severity:  'high'|'medium'|'low'
 */
export function CoverageFollowUpPanel({
  noticeMessage,
  followUpQuestions = [],
  onQuestionClick,
  onDismiss,
}) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || followUpQuestions.length === 0) return null;

  function handleDismiss() {
    setDismissed(true);
    onDismiss?.();
  }

  function handleClick(question) {
    // 마크다운 볼드(**...**) 제거하여 깔끔한 질문 텍스트로 전달
    const cleanQuestion = question.replace(/\*\*([^*]+)\*\*/g, '$1');
    onQuestionClick?.(cleanQuestion);
  }

  return (
    <div class="cfp-root" role="region" aria-label="이력서 보충 질문">
      {/* 헤더 */}
      <div class="cfp-header">
        <span class="cfp-icon" aria-hidden="true">📊</span>
        <p class="cfp-notice">
          {noticeMessage
            ? _stripMarkdownBold(noticeMessage)
            : '이력서 일부 항목에 업무 기록이 부족합니다. 아래 질문에 답하시면 더 풍부한 이력서를 만들 수 있습니다.'}
        </p>
        <button
          class="cfp-dismiss"
          onClick={handleDismiss}
          aria-label="보충 질문 패널 닫기"
          title="닫기"
        >
          ✕
        </button>
      </div>

      {/* 질문 버튼 목록 */}
      <div class="cfp-questions" role="list" aria-label="보충 질문 목록">
        {followUpQuestions.map((fq) => (
          <button
            key={fq.id}
            class={`cfp-question cfp-question--${fq.severity}`}
            role="listitem"
            type="button"
            title={fq.itemText}
            onClick={() => handleClick(fq.question)}
            aria-label={`보충 질문: ${_stripMarkdownBold(fq.question)}`}
          >
            <span class="cfp-section-badge">{_sectionLabel(fq.section)}</span>
            <span class="cfp-question-text">
              {_renderQuestionWithBold(fq.question)}
            </span>
          </button>
        ))}
      </div>

      <style>{CFP_CSS}</style>
    </div>
  );
}

/* ── 내부 헬퍼 ────────────────────────────────────────────────────────────────── */

/** 섹션 라벨 */
function _sectionLabel(section) {
  const labels = {
    experience: '경력',
    skills: '스킬',
    summary: '자기소개',
    projects: '프로젝트',
  };
  return labels[section] ?? section;
}

/** 마크다운 볼드(**...**) 제거 */
function _stripMarkdownBold(text) {
  return text ? text.replace(/\*\*([^*]+)\*\*/g, '$1') : '';
}

/**
 * 마크다운 볼드(**...**) 를 강조 span으로 렌더링한다.
 * @param {string} text
 */
function _renderQuestionWithBold(text) {
  if (!text) return null;
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const CFP_CSS = `
  .cfp-root {
    margin: var(--space-3) var(--space-6);
    border: 1.5px solid #dbeafe;
    border-radius: var(--radius-lg);
    background: linear-gradient(135deg, #eff6ff 0%, #fff 100%);
    overflow: hidden;
    box-shadow: var(--shadow-sm);
    animation: cfp-slide-in 0.25s ease;
  }

  @keyframes cfp-slide-in {
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ─── Header ─── */
  .cfp-header {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid #dbeafe;
    background: rgba(219, 234, 254, 0.3);
  }

  .cfp-icon {
    font-size: 16px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .cfp-notice {
    flex: 1;
    margin: 0;
    font-size: 12.5px;
    color: #1e40af;
    line-height: 1.6;
    font-weight: 500;
  }

  .cfp-dismiss {
    flex-shrink: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    color: #93c5fd;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
    transition: color 0.15s, background 0.15s;
    line-height: 1;
  }

  .cfp-dismiss:hover {
    color: #1e40af;
    background: rgba(219, 234, 254, 0.6);
  }

  /* ─── Question list ─── */
  .cfp-questions {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: var(--space-2) 0;
  }

  /* ─── Question button ─── */
  .cfp-question {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: none;
    border: none;
    border-bottom: 1px solid rgba(219, 234, 254, 0.5);
    cursor: pointer;
    text-align: left;
    transition: background 0.12s;
    width: 100%;
  }

  .cfp-question:last-child {
    border-bottom: none;
  }

  .cfp-question:hover {
    background: rgba(219, 234, 254, 0.4);
  }

  .cfp-question:active {
    background: rgba(219, 234, 254, 0.7);
  }

  /* ─── Severity indicators ─── */
  .cfp-question--high .cfp-section-badge {
    background: #fecaca;
    color: #991b1b;
  }

  .cfp-question--medium .cfp-section-badge {
    background: #fed7aa;
    color: #92400e;
  }

  .cfp-question--low .cfp-section-badge {
    background: #d1fae5;
    color: #065f46;
  }

  /* ─── Section badge ─── */
  .cfp-section-badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 10px;
    letter-spacing: 0.02em;
    margin-top: 2px;
    white-space: nowrap;
  }

  /* ─── Question text ─── */
  .cfp-question-text {
    font-size: 12.5px;
    color: #1e3a8a;
    line-height: 1.55;
    flex: 1;
  }

  .cfp-question-text strong {
    color: #1d4ed8;
    font-weight: 600;
  }
`;
