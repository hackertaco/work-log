import { useState, useRef, useEffect } from 'preact/hooks';
import styles from './LinkedInStep.module.css';

/** Minimum character count for manual paste to be considered submittable. */
const MANUAL_MIN_CHARS = 50;

/** How long to display the success confirmation before auto-advancing (ms). */
const SUCCESS_ADVANCE_DELAY_MS = 1800;

/**
 * LinkedInStep
 *
 * Onboarding step 1: attempts to fetch a LinkedIn public profile and extract
 * structured data. Implements Sub-AC 3b — LinkedIn fetch UI with conditional
 * paste-input fallback.
 *
 * Flow:
 *   1. User enters a LinkedIn profile URL and submits the form.
 *   2. The component POSTs to /api/resume/linkedin (fetching state).
 *   3a. Success → displays profile name/headline briefly, then auto-advances.
 *   3b. Fetch failed (network error, HTTP 502, etc.) or insufficient data →
 *       transitions to a paste-input fallback so the user can manually provide
 *       profile text (conditional rendering of the fallback textarea).
 *   3c. Invalid URL (400 invalid_url) → shows error inline in the URL form;
 *       the paste fallback is NOT shown because the user just needs to fix the URL.
 *
 * State machine
 * ─────────────
 *   idle          Initial state — shows the LinkedIn URL input form
 *   fetching      POST /api/resume/linkedin is in-flight; spinner shown
 *   success       Profile data received — shows confirmation, auto-advances after delay
 *   failed        Network / HTTP error — shows paste fallback textarea
 *   insufficient  Page loaded but data too sparse — shows paste fallback textarea
 *
 * Props
 * ─────
 *   onComplete({ source, data?, text?, url? }) — called when the step finishes
 *     source === 'fetch'         → { url, data: ProfileData }
 *     source === 'paste'         → { text }         (fallback)
 *   onSkip() — optional; called when the user skips the entire LinkedIn step
 */
export function LinkedInStep({ onComplete, onSkip }) {
  // ── URL input phase ────────────────────────────────────────────────────
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [status, setStatus] = useState('idle'); // idle|fetching|success|failed|insufficient

  // ── Success phase ─────────────────────────────────────────────────────
  /** Fetched profile data stored for the success display and auto-advance. */
  const [profileData, setProfileData] = useState(/** @type {object|null} */ (null));
  /**
   * The full payload to pass to onComplete — stored here so the auto-advance
   * useEffect can access it without capturing a stale closure.
   */
  const successPayloadRef = useRef(/** @type {object|null} */ (null));
  // Keep a stable ref to onComplete to avoid adding it to useEffect deps
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // Auto-advance after SUCCESS_ADVANCE_DELAY_MS when status becomes 'success'
  useEffect(() => {
    if (status !== 'success') return;
    const timer = setTimeout(() => {
      if (successPayloadRef.current) {
        onCompleteRef.current(successPayloadRef.current);
      }
    }, SUCCESS_ADVANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // ── Fallback textarea phase (failed / insufficient states) ───────────
  const [failureInfo, setFailureInfo] = useState(
    /** @type {{ error: string, message: string, hint: string|null }|null} */ (null)
  );
  const [manualText, setManualText] = useState('');
  const [manualError, setManualError] = useState('');

  // ── LinkedIn fetch ─────────────────────────────────────────────────────

  async function handleLinkedInSubmit(e) {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setUrlError('LinkedIn 프로필 URL을 입력해 주세요.');
      return;
    }

    setUrlError('');
    setStatus('fetching');

    try {
      const res = await fetch('/api/resume/linkedin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: trimmedUrl }),
      });

      // Auth failure: let the parent redirect to login
      if (res.status === 401 || res.status === 403) {
        window.location.href = '/login';
        return;
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        // ✓ Success — sufficient data extracted from LinkedIn.
        // Store the payload and show a confirmation state before auto-advancing.
        const payload = { source: 'fetch', url: data.url, data: data.data };
        successPayloadRef.current = payload;
        setProfileData(data.data ?? null);
        setStatus('success');
        return;
      }

      // ─── Invalid URL — show error inline, stay in URL input form ─────
      // The paste fallback is only for LinkedIn being unreachable or returning
      // too little data; a bad URL is a simple input error the user can fix.
      if (data.error === 'invalid_url') {
        setUrlError(
          data.message ?? 'LinkedIn 프로필 URL 형식이 올바르지 않습니다.'
        );
        setStatus('idle');
        return;
      }

      // ─── Fallback activation ────────────────────────────────────────────
      // Shown when LinkedIn is reachable but returns too little data, or when
      // the fetch itself fails (network error, 502, etc.).
      if (data.error === 'insufficient_data') {
        setFailureInfo({
          error: 'insufficient_data',
          message:
            data.message ??
            'LinkedIn에서 충분한 프로필 데이터를 가져오지 못했습니다.',
          hint:
            data.hint ??
            '프로필이 비공개이거나 데이터가 너무 적습니다. 아래에 직접 붙여넣어 주세요.',
        });
        setStatus('insufficient');
      } else {
        setFailureInfo({
          error: data.error ?? 'fetch_failed',
          message:
            data.message ??
            'LinkedIn 프로필을 가져오는 중 오류가 발생했습니다.',
          hint:
            data.hint ??
            'LinkedIn이 요청을 차단했을 수 있습니다. 아래에 직접 붙여넣어 주세요.',
        });
        setStatus('failed');
      }
    } catch {
      setFailureInfo({
        error: 'network_error',
        message: '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
        hint: null,
      });
      setStatus('failed');
    }
  }

  // ── Manual paste submit ────────────────────────────────────────────────

  function handleManualSubmit(e) {
    e.preventDefault();
    const trimmed = manualText.trim();

    if (trimmed.length < MANUAL_MIN_CHARS) {
      setManualError(
        `최소 ${MANUAL_MIN_CHARS}자 이상 입력해 주세요. (현재: ${trimmed.length}자)`
      );
      return;
    }

    setManualError('');
    onComplete({ source: 'paste', text: trimmed });
  }

  function handleRetry() {
    setStatus('idle');
    setFailureInfo(null);
    setManualText('');
    setManualError('');
  }

  // ── Skip LinkedIn entirely (goes directly to PDF upload) ──────────────

  function handleSkipToManual() {
    setFailureInfo({
      error: 'skipped',
      message: 'LinkedIn 가져오기를 건너뛰었습니다.',
      hint: '아래에 프로필 텍스트를 붙여넣거나, 이 단계를 건너뛸 수 있습니다.',
    });
    setStatus('failed');
  }

  // ── Render: success confirmation ──────────────────────────────────────
  //
  // Shown when status === 'success'. Displays profile name/headline briefly,
  // then auto-advances to the next step via the useEffect above.

  if (status === 'success') {
    return (
      <div class={styles.wrapper}>
        <div class={styles.successBox} role="status" aria-live="polite">
          <span class={styles.successIcon} aria-hidden="true">✓</span>
          <div class={styles.successBody}>
            {profileData?.name ? (
              <>
                <p class={styles.successName}>{profileData.name}</p>
                {profileData.headline && (
                  <p class={styles.successHeadline}>{profileData.headline}</p>
                )}
              </>
            ) : (
              <p class={styles.successName}>LinkedIn 프로필 가져오기 완료</p>
            )}
            <p class={styles.successNote}>
              이력서 초기화에 활용됩니다. 잠시 후 다음 단계로 이동합니다…
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: fallback textarea (paste fallback) ────────────────────────
  //
  // Shown when status === 'failed' or status === 'insufficient'.
  // The paste fallback is conditionally rendered here — it only appears after
  // a real fetch failure or insufficient data, not for invalid URL inputs.
  // The user can paste their LinkedIn export text or any free-form profile
  // text, retry the URL input, or skip this step entirely.

  if (status === 'failed' || status === 'insufficient') {
    const isInsufficient = status === 'insufficient';
    const isSkipped = failureInfo?.error === 'skipped';

    return (
      <div class={styles.wrapper}>
        {/* ── Failure notice ─────────────────────────────────────────── */}
        {!isSkipped && (
          <div
            class={[
              styles.notice,
              isInsufficient ? styles.noticeWarn : styles.noticeError,
            ].join(' ')}
            role="alert"
          >
            <span class={styles.noticeIcon} aria-hidden="true">
              {isInsufficient ? '⚠' : '✕'}
            </span>
            <div class={styles.noticeBody}>
              <p class={styles.noticeMessage}>{failureInfo.message}</p>
              {failureInfo.hint && (
                <p class={styles.noticeHint}>{failureInfo.hint}</p>
              )}
            </div>
          </div>
        )}

        {/* ── Manual paste textarea ──────────────────────────────────── */}
        <form class={styles.form} onSubmit={handleManualSubmit} noValidate>
          <div class={styles.field}>
            <label class={styles.label} htmlFor="linkedin-manual-input">
              프로필 텍스트 직접 붙여넣기
            </label>
            <p class={styles.fieldDesc}>
              LinkedIn 프로필 페이지의 내용을 복사하거나,{' '}
              <a
                href="https://www.linkedin.com/psettings/member-data"
                target="_blank"
                rel="noopener noreferrer"
                class={styles.externalLink}
              >
                LinkedIn 데이터 내보내기
              </a>
              에서 받은 파일의 내용을 붙여넣어 주세요.
            </p>

            <textarea
              id="linkedin-manual-input"
              class={[
                styles.textarea,
                manualError ? styles.textareaError : '',
              ]
                .filter(Boolean)
                .join(' ')}
              rows={10}
              placeholder={
                '이름, 직책, 경력, 학력, 기술 등 프로필 정보를 붙여넣으세요.\n\n예)\n홍길동\nSoftware Engineer · Acme Corp\n서울, 대한민국\n\n경력\nAcme Corp — Software Engineer (2022–현재)\n…'
              }
              value={manualText}
              onInput={(e) => {
                setManualText(e.currentTarget.value);
                if (manualError) setManualError('');
              }}
              spellcheck={false}
              // autofocus so user can paste immediately after the notice appears
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autofocus
            />

            {manualError && (
              <p class={styles.errorMsg} role="alert">
                {manualError}
              </p>
            )}

            <p class={styles.charCount}>
              {manualText.trim().length}자
              {manualText.trim().length < MANUAL_MIN_CHARS && (
                <span class={styles.charMin}>
                  {' '}(최소 {MANUAL_MIN_CHARS}자)
                </span>
              )}
            </p>
          </div>

          <div class={styles.actions}>
            <button
              type="submit"
              class={styles.btnPrimary}
              disabled={manualText.trim().length < MANUAL_MIN_CHARS}
            >
              텍스트로 계속하기
            </button>

            <div class={styles.secondaryActions}>
              <button
                type="button"
                class={styles.btnGhost}
                onClick={handleRetry}
              >
                LinkedIn URL 다시 시도
              </button>

              {onSkip && (
                <button
                  type="button"
                  class={styles.btnGhost}
                  onClick={onSkip}
                >
                  이 단계 건너뛰기
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    );
  }

  // ── Render: LinkedIn URL input form ───────────────────────────────────

  return (
    <div class={styles.wrapper}>
      <form class={styles.form} onSubmit={handleLinkedInSubmit} noValidate>
        <div class={styles.field}>
          <label class={styles.label} htmlFor="linkedin-url-input">
            LinkedIn 프로필 URL
          </label>
          <p class={styles.fieldDesc}>
            공개 프로필 URL을 입력하면 기본 정보를 자동으로 가져옵니다.
          </p>

          <input
            id="linkedin-url-input"
            class={[styles.input, urlError ? styles.inputError : '']
              .filter(Boolean)
              .join(' ')}
            type="url"
            placeholder="https://www.linkedin.com/in/your-profile"
            value={url}
            onInput={(e) => {
              setUrl(e.currentTarget.value);
              if (urlError) setUrlError('');
            }}
            disabled={status === 'fetching'}
            autocomplete="off"
            spellcheck={false}
          />

          {urlError && (
            <p class={styles.errorMsg} role="alert">
              {urlError}
            </p>
          )}
        </div>

        <div class={styles.actions}>
          <button
            type="submit"
            class={styles.btnPrimary}
            disabled={status === 'fetching' || !url.trim()}
          >
            {status === 'fetching' ? (
              <>
                <span class={styles.spinner} aria-hidden="true" />
                가져오는 중…
              </>
            ) : (
              '프로필 가져오기'
            )}
          </button>

          {/* Subtle hint during fetch — LinkedIn can take several seconds */}
          {status === 'fetching' && (
            <p class={styles.fetchingHint} role="status" aria-live="polite">
              LinkedIn 페이지를 분석하고 있습니다. 잠시 기다려 주세요…
            </p>
          )}
        </div>
      </form>

      {/* Secondary options */}
      <div class={styles.altOptions}>
        <button
          type="button"
          class={styles.btnLink}
          disabled={status === 'fetching'}
          onClick={handleSkipToManual}
        >
          직접 텍스트 붙여넣기
        </button>
        {onSkip && (
          <>
            <span class={styles.altSep} aria-hidden="true">·</span>
            <button
              type="button"
              class={styles.btnLink}
              disabled={status === 'fetching'}
              onClick={onSkip}
            >
              이 단계 건너뛰기
            </button>
          </>
        )}
      </div>
    </div>
  );
}
