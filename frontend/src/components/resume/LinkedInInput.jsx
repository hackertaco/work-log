import { useState, useCallback } from 'preact/hooks';

/**
 * LinkedInInput
 *
 * LinkedIn URL 입력 + 가져오기 버튼 + 상태 처리 컴포넌트.
 *
 * 동작 흐름:
 *  1. 사용자가 LinkedIn URL 입력 → "가져오기" 클릭
 *  2. POST /api/resume/linkedin 호출 (loading 상태)
 *  3a. 성공(ok: true) → 성공 메시지 + 프로필 미리보기 표시
 *  3b. 데이터 부족(ok: false, error: "insufficient_data") → 경고 + 붙여넣기 폴백 표시
 *  3c. 가져오기 실패(네트워크/서버 오류) → 오류 메시지 + 붙여넣기 폴백 표시
 *
 * Props:
 *  - onData(result): 데이터 확정 시 호출
 *      result.source === 'fetch' → { source, url, data } (LinkedIn API 결과)
 *      result.source === 'paste' → { source, text }     (수동 붙여넣기)
 *  - onSkip(): 사용자가 이 단계를 건너뜀
 *  - disabled: PDF 업로드 진행 중 등 외부 비활성화 상태
 *
 * @param {{ onData: Function, onSkip: Function, disabled?: boolean }} props
 */
export function LinkedInInput({ onData, onSkip, disabled = false }) {
  /** @type {['idle'|'fetching'|'success'|'insufficient'|'error', Function]} */
  const [fetchStatus, setFetchStatus] = useState('idle');

  /** URL 입력 값 */
  const [url, setUrl] = useState('');

  /** 마지막으로 가져온 프로필 데이터 (성공 시) */
  const [profileData, setProfileData] = useState(null);

  /** 오류 또는 부족 안내 메시지 */
  const [message, setMessage] = useState('');

  /** 붙여넣기 폴백 텍스트 */
  const [pasteText, setPasteText] = useState('');

  /** 붙여넣기 폴백 영역 표시 여부 */
  const showPasteFallback =
    fetchStatus === 'insufficient' || fetchStatus === 'error';

  // ──────────────────────────────────────────────
  // URL 가져오기
  // ──────────────────────────────────────────────

  const handleFetch = useCallback(async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;

    setFetchStatus('fetching');
    setMessage('');
    setProfileData(null);

    try {
      const res = await fetch('/api/resume/linkedin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: trimmedUrl }),
      });

      const body = await res.json().catch(() => ({}));

      if (res.ok && body.ok === true) {
        // 성공: 유용한 프로필 데이터가 있음
        setProfileData(body.data ?? null);
        setFetchStatus('success');
        // 데이터를 즉시 부모에 전달 (사용자가 별도 확인 없이 다음으로 진행)
        onData({ source: 'fetch', url: body.url ?? trimmedUrl, data: body.data ?? {} });
        return;
      }

      if (body.error === 'insufficient_data') {
        // 페이지는 열렸지만 데이터가 부족함
        setFetchStatus('insufficient');
        setMessage(
          body.message ??
            'LinkedIn 공개 프로필에서 충분한 데이터를 가져오지 못했습니다. ' +
              '프로필이 비공개이거나 LinkedIn이 접근을 제한했을 수 있습니다.',
        );
        return;
      }

      if (body.error === 'invalid_url') {
        // URL 형식 오류 — 폴백 없이 오류만 표시
        setFetchStatus('error');
        setMessage(body.message ?? 'LinkedIn 프로필 URL 형식이 올바르지 않습니다.');
        return;
      }

      // fetch_failed, 서버 오류 등
      setFetchStatus('error');
      setMessage(
        body.message ??
          'LinkedIn 페이지를 가져올 수 없습니다. ' +
            '네트워크 오류이거나 LinkedIn이 접근을 차단했을 수 있습니다.',
      );
    } catch {
      setFetchStatus('error');
      setMessage(
        '서버와 통신할 수 없습니다. 네트워크 연결을 확인하거나 잠시 후 다시 시도해 주세요.',
      );
    }
  }, [url, onData]);

  // ──────────────────────────────────────────────
  // 붙여넣기 폴백 제출
  // ──────────────────────────────────────────────

  const handlePasteSubmit = useCallback(() => {
    const text = pasteText.trim();
    if (!text) return;
    onData({ source: 'paste', text });
  }, [pasteText, onData]);

  // ──────────────────────────────────────────────
  // 재시도 (URL 입력 상태로 되돌아감)
  // ──────────────────────────────────────────────

  const handleRetry = useCallback(() => {
    setFetchStatus('idle');
    setMessage('');
    setProfileData(null);
    setPasteText('');
  }, []);

  // ──────────────────────────────────────────────
  // 렌더링
  // ──────────────────────────────────────────────

  const isFetching = fetchStatus === 'fetching';
  const isExternallyDisabled = disabled;
  const inputDisabled = isFetching || isExternallyDisabled;

  return (
    <div class="li-wrap">
      {/* ── 제목 ── */}
      <div class="li-header">
        <p class="li-eyebrow">STEP 2 · 선택</p>
        <h2 class="li-title">LinkedIn 프로필 연결</h2>
        <p class="li-desc">
          LinkedIn URL을 입력하면 이력서 누락 항목을 보완하는 데 활용됩니다.
          <br />
          온보딩 완료 후에는 더 이상 참조하지 않습니다.
        </p>
      </div>

      {/* ── URL 입력 영역 ── */}
      {fetchStatus !== 'success' && (
        <div class="li-input-row">
          <input
            id="linkedin-url"
            class={`li-url-input${fetchStatus === 'error' ? ' li-url-input--error' : ''}`}
            type="url"
            placeholder="https://linkedin.com/in/username"
            value={url}
            onInput={(e) => {
              setUrl(e.currentTarget.value);
              // URL이 바뀌면 이전 오류 상태 초기화
              if (fetchStatus === 'error' || fetchStatus === 'insufficient') {
                setFetchStatus('idle');
                setMessage('');
              }
            }}
            disabled={inputDisabled}
            autocomplete="url"
            aria-label="LinkedIn 프로필 URL"
          />
          <button
            type="button"
            class={`li-fetch-btn${isFetching ? ' li-fetch-btn--loading' : ''}`}
            onClick={handleFetch}
            disabled={inputDisabled || !url.trim()}
            aria-busy={isFetching}
          >
            {isFetching ? (
              <>
                <span class="li-spinner" aria-hidden="true" />
                가져오는 중…
              </>
            ) : (
              '가져오기'
            )}
          </button>
        </div>
      )}

      {/* ── 상태 메시지 ── */}
      {fetchStatus === 'fetching' && (
        <p class="li-status li-status--loading" role="status">
          LinkedIn 페이지를 분석하고 있습니다…
        </p>
      )}

      {fetchStatus === 'success' && profileData && (
        <div class="li-success-box" role="status" aria-live="polite">
          <span class="li-success-icon" aria-hidden="true">✓</span>
          <div class="li-success-copy">
            <p class="li-success-name">{profileData.name ?? 'LinkedIn 프로필'}</p>
            {profileData.headline && (
              <p class="li-success-headline">{profileData.headline}</p>
            )}
            <p class="li-success-note">이력서 보완에 활용됩니다.</p>
          </div>
        </div>
      )}

      {fetchStatus === 'success' && !profileData && (
        <div class="li-success-box" role="status" aria-live="polite">
          <span class="li-success-icon" aria-hidden="true">✓</span>
          <p class="li-success-note">LinkedIn 데이터를 가져왔습니다.</p>
        </div>
      )}

      {(fetchStatus === 'insufficient' || fetchStatus === 'error') && message && (
        <div
          class={`li-alert${fetchStatus === 'insufficient' ? ' li-alert--warn' : ' li-alert--error'}`}
          role="alert"
        >
          <span class="li-alert-icon" aria-hidden="true">
            {fetchStatus === 'insufficient' ? '⚠' : '✕'}
          </span>
          <p class="li-alert-msg">{message}</p>
        </div>
      )}

      {/* ── 붙여넣기 폴백 ── */}
      {showPasteFallback && (
        <div class="li-paste-fallback">
          <div class="li-paste-header">
            <p class="li-paste-title">직접 붙여넣기로 계속하기</p>
            <p class="li-paste-hint">
              LinkedIn 프로필 페이지에서 텍스트를 복사해 아래에 붙여넣으세요.
            </p>
          </div>
          <textarea
            class="li-paste-area"
            placeholder="이름, 직함, 경력, 학력 등을 LinkedIn에서 복사해 붙여넣으세요…"
            value={pasteText}
            onInput={(e) => setPasteText(e.currentTarget.value)}
            rows={7}
            disabled={isExternallyDisabled}
            aria-label="LinkedIn 프로필 붙여넣기"
          />
          <div class="li-paste-actions">
            <button
              type="button"
              class="li-paste-submit"
              onClick={handlePasteSubmit}
              disabled={isExternallyDisabled || !pasteText.trim()}
            >
              붙여넣기 내용 적용
            </button>
            <button
              type="button"
              class="li-paste-retry"
              onClick={handleRetry}
              disabled={isExternallyDisabled}
            >
              URL로 다시 시도
            </button>
          </div>
        </div>
      )}

      {/* ── 건너뛰기 ── */}
      {fetchStatus !== 'success' && (
        <button
          type="button"
          class="li-skip"
          onClick={onSkip}
          disabled={isExternallyDisabled}
        >
          건너뛰기 — LinkedIn 없이 계속
        </button>
      )}

      <style>{LI_CSS}</style>
    </div>
  );
}

/* ── 인라인 스타일 ── */
const LI_CSS = `
  .li-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /* ─── Header ─── */
  .li-eyebrow {
    margin: 0 0 var(--space-2);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.2em;
    color: var(--muted);
    text-transform: uppercase;
  }

  .li-title {
    margin: 0 0 var(--space-3);
    font-size: clamp(20px, 3.5vw, 28px);
    font-weight: 700;
    color: var(--ink);
    line-height: 1.2;
    letter-spacing: -0.02em;
  }

  .li-desc {
    margin: 0;
    font-size: 14px;
    color: var(--muted);
    line-height: 1.7;
  }

  /* ─── URL Input Row ─── */
  .li-input-row {
    display: flex;
    gap: var(--space-2);
    align-items: stretch;
  }

  .li-url-input {
    flex: 1;
    min-width: 0;
    padding: 10px 14px;
    font-size: 14px;
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-md);
    background: #fff;
    color: var(--ink);
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .li-url-input:focus {
    border-color: var(--ink);
    box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.08);
  }

  .li-url-input--error {
    border-color: #e53e3e;
  }

  .li-url-input--error:focus {
    box-shadow: 0 0 0 3px rgba(229, 62, 62, 0.12);
  }

  .li-url-input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  /* ─── Fetch Button ─── */
  .li-fetch-btn {
    flex-shrink: 0;
    padding: 10px 18px;
    font-size: 14px;
    font-weight: 600;
    background: var(--ink);
    color: #fff;
    border: none;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    transition: opacity 0.15s;
    white-space: nowrap;
  }

  .li-fetch-btn:hover:not(:disabled) {
    opacity: 0.85;
  }

  .li-fetch-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* ─── Spinner ─── */
  .li-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: li-spin 0.65s linear infinite;
    flex-shrink: 0;
  }

  @keyframes li-spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Status Messages ─── */
  .li-status {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  .li-status--loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* ─── Success Box ─── */
  .li-success-box {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4);
    background: rgba(16, 185, 129, 0.06);
    border: 1px solid rgba(16, 185, 129, 0.25);
    border-radius: var(--radius-md);
  }

  .li-success-icon {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #10b981;
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 1px;
  }

  .li-success-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .li-success-name {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }

  .li-success-headline {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  .li-success-note {
    margin: 0;
    font-size: 12px;
    color: #10b981;
    font-weight: 500;
  }

  /* ─── Alert ─── */
  .li-alert {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid;
  }

  .li-alert--warn {
    background: rgba(234, 179, 8, 0.06);
    border-color: rgba(234, 179, 8, 0.3);
    color: #92400e;
  }

  .li-alert--error {
    background: rgba(229, 62, 62, 0.06);
    border-color: rgba(229, 62, 62, 0.25);
    color: #9b1c1c;
  }

  .li-alert-icon {
    flex-shrink: 0;
    font-size: 15px;
    margin-top: 1px;
  }

  .li-alert-msg {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
  }

  /* ─── Paste Fallback ─── */
  .li-paste-fallback {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    background: var(--panel-2, rgba(248, 250, 253, 0.88));
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .li-paste-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .li-paste-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }

  .li-paste-hint {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
  }

  .li-paste-area {
    width: 100%;
    padding: 10px 14px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.6;
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-md);
    background: #fff;
    color: var(--ink);
    resize: vertical;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    min-height: 120px;
  }

  .li-paste-area:focus {
    border-color: var(--ink);
    box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.08);
  }

  .li-paste-area:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .li-paste-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .li-paste-submit {
    padding: 9px 18px;
    font-size: 14px;
    font-weight: 600;
    background: var(--ink);
    color: #fff;
    border: none;
    border-radius: var(--radius-md);
    transition: opacity 0.15s;
  }

  .li-paste-submit:hover:not(:disabled) {
    opacity: 0.85;
  }

  .li-paste-submit:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .li-paste-retry {
    padding: 9px 18px;
    font-size: 14px;
    font-weight: 500;
    background: transparent;
    color: var(--muted);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-md);
    transition: color 0.15s, border-color 0.15s;
  }

  .li-paste-retry:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink);
  }

  .li-paste-retry:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* ─── Skip ─── */
  .li-skip {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 0;
    font-size: 13px;
    color: var(--muted);
    text-decoration: underline;
    text-underline-offset: 3px;
    transition: color 0.15s;
  }

  .li-skip:hover:not(:disabled) {
    color: var(--ink);
  }

  .li-skip:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
`;
