import { useState, useRef, useEffect } from 'preact/hooks';
import { parseResumeQuery, isQueryEmpty } from '../../../lib/resumeQueryParser.js';

/**
 * ResumeChatInput — 채팅 기반 이력서 질의 입력 컴포넌트
 *
 * Props:
 *   onSubmit    — (parsedQuery: object) => void  질의 제출 콜백
 *   loading     — boolean  검색/처리 중 여부 (입력 비활성화)
 *   placeholder — string   입력란 플레이스홀더 (기본값 제공)
 *   disabled    — boolean  컴포넌트 전체 비활성화
 *
 * 동작:
 *   - textarea 자동 높이 조절 (최대 120px)
 *   - Enter 제출 (Shift+Enter = 줄바꿈)
 *   - 빈 쿼리 제출 차단
 *   - 로딩 중 입력/제출 비활성화
 *   - parseResumeQuery()로 파싱 후 부모에 전달
 */
export function ResumeChatInput({
  onSubmit,
  loading = false,
  placeholder = '이력서에 대해 자유롭게 질문하거나 수정을 요청하세요.\n예: "2024년 프로젝트 경험 찾아줘" / "경력 섹션 두 번째 항목 개선해줘"',
  disabled = false,
}) {
  const [value, setValue] = useState('');
  const textareaRef = useRef(null);
  const isDisabled = disabled || loading;

  // textarea 높이 자동 조절
  function adjustHeight() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  useEffect(() => {
    adjustHeight();
  }, [value]);

  // 로딩 완료 후 입력 필드에 포커스
  useEffect(() => {
    if (!loading && !disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [loading, disabled]);

  function handleInput(e) {
    setValue(e.target.value);
  }

  function handleKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleSubmit() {
    if (isDisabled) return;
    const trimmed = value.trim();
    if (!trimmed) return;

    const parsed = parseResumeQuery(trimmed);
    if (isQueryEmpty(parsed)) return;

    onSubmit?.(parsed);
    setValue('');
  }

  const hasValue = value.trim().length > 0;

  return (
    <div class={`rci-root${isDisabled ? ' rci-root--disabled' : ''}`}>
      <div class="rci-inner">
        <textarea
          ref={textareaRef}
          class="rci-textarea"
          value={value}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isDisabled}
          rows={1}
          aria-label="이력서 질의 입력"
          aria-multiline="true"
        />
        <button
          class={`rci-submit${hasValue && !isDisabled ? ' rci-submit--active' : ''}`}
          onClick={handleSubmit}
          disabled={isDisabled || !hasValue}
          aria-label={loading ? '처리 중' : '질의 전송'}
          title={loading ? '처리 중...' : '전송 (Enter)'}
        >
          {loading ? (
            <span class="rci-spinner" aria-hidden="true" />
          ) : (
            <svg
              class="rci-send-icon"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
              width="16"
              height="16"
            >
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          )}
        </button>
      </div>
      <p class="rci-hint">
        Enter로 전송 · Shift+Enter로 줄바꿈
      </p>
      <style>{RCI_CSS}</style>
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const RCI_CSS = `
  .rci-root {
    width: 100%;
    padding: 14px 28px 18px;
    background: linear-gradient(180deg, rgba(248, 250, 252, 0.54), rgba(255, 255, 255, 0.92));
    border-top: 1px solid rgba(148, 163, 184, 0.18);
    backdrop-filter: blur(10px);
  }

  .rci-root--disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .rci-inner {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    background: rgba(255, 255, 255, 0.9);
    border: 1.5px solid var(--line-strong);
    border-radius: 18px;
    padding: var(--space-2) var(--space-3);
    transition: border-color 0.15s, box-shadow 0.15s;
    box-shadow: 0 8px 26px rgba(15, 23, 42, 0.04);
  }

  .rci-root:not(.rci-root--disabled) .rci-inner:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(30, 64, 175, 0.1);
  }

  .rci-textarea {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    resize: none;
    font-size: 14px;
    line-height: 1.6;
    color: var(--ink);
    min-height: 24px;
    max-height: 120px;
    overflow-y: auto;
    padding: 2px 0;
  }

  .rci-textarea::placeholder {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .rci-textarea:disabled {
    cursor: not-allowed;
  }

  .rci-submit {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    border: none;
    background: var(--line-strong);
    color: var(--muted);
    transition: background 0.15s, color 0.15s, transform 0.1s;
    padding: 0;
    margin-bottom: 1px;
  }

  .rci-submit--active {
    background: var(--accent);
    color: #fff;
  }

  .rci-submit--active:hover {
    background: #1e3a8a;
    transform: scale(1.05);
  }

  .rci-submit:disabled {
    cursor: default;
  }

  .rci-send-icon {
    display: block;
  }

  .rci-spinner {
    display: block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: rci-spin 0.65s linear infinite;
  }

  @keyframes rci-spin {
    to { transform: rotate(360deg); }
  }

  .rci-hint {
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--muted);
    opacity: 0.7;
    text-align: right;
  }

  @media (max-width: 900px) {
    .rci-root {
      padding: 12px 16px 16px;
    }
  }
`;
