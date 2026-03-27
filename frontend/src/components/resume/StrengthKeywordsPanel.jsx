import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * StrengthKeywordsPanel — 강점 키워드 관리 패널
 *
 * GET /api/resume/strength-keywords 로 현재 강점 키워드 목록을 불러와
 * 태그 형태로 표시하며, 개별 삭제 및 직접 입력 추가 기능을 제공한다.
 *
 * 추가 흐름:
 *   1. 텍스트 인풋에 키워드 입력 (콤마로 복수 입력 가능)
 *   2. Enter 키 또는 "+" 버튼 클릭 → POST /api/resume/strength-keywords
 *   3. 서버 응답의 keywords 배열로 상태 갱신 (낙관적 업데이트)
 *
 * 삭제 흐름:
 *   1. 태그의 "×" 버튼 클릭 → DELETE /api/resume/strength-keywords/:keyword
 *   2. 서버 응답의 keywords 배열로 상태 갱신 (낙관적 업데이트)
 *
 * props: 없음 (독립 패널)
 */
export function StrengthKeywordsPanel() {
  /** @type {[string[]|null, function]} */
  const [keywords, setKeywords] = useState(null);
  const [fetchError, setFetchError] = useState('');
  const [loading, setLoading] = useState(true);

  // 입력 중인 키워드 텍스트
  const [inputValue, setInputValue] = useState('');
  // 추가 요청 진행 중 여부
  const [adding, setAdding] = useState(false);
  // 추가 오류 메시지
  const [addError, setAddError] = useState('');
  // 삭제 진행 중인 키워드 Set (여러 개 동시 삭제 방지용)
  const [deletingSet, setDeletingSet] = useState(/** @type {Set<string>} */ () => new Set());
  // 키워드별 삭제 오류
  const [deleteErrors, setDeleteErrors] = useState(/** @type {Record<string,string>} */ ({}));

  const mountedRef = useRef(true);
  const inputRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    fetchKeywords();
  }, []);

  // ── 데이터 로드 ──────────────────────────────────────────────────────────────

  async function fetchKeywords() {
    setLoading(true);
    setFetchError('');
    try {
      const res = await fetch('/api/resume/strength-keywords', { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (mountedRef.current) {
        setKeywords(Array.isArray(data.keywords) ? data.keywords : []);
      }
    } catch (err) {
      if (mountedRef.current) {
        setFetchError(err.message);
        setKeywords([]);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  // ── 키워드 추가 ──────────────────────────────────────────────────────────────

  /**
   * 입력값을 콤마로 분리해 각각 trim한 뒤 빈 값 제거.
   * POST /api/resume/strength-keywords — keywords 배열 전송.
   */
  async function addKeywords() {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    // 콤마 구분 다중 입력 지원
    const newKeywords = trimmed
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (newKeywords.length === 0) return;

    setAdding(true);
    setAddError('');

    try {
      const res = await fetch('/api/resume/strength-keywords', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: newKeywords }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      if (mountedRef.current) {
        // 서버가 반환한 최신 keywords 배열로 상태 갱신
        if (Array.isArray(data.keywords)) {
          setKeywords(data.keywords);
        }
        setInputValue('');
      }
    } catch (err) {
      if (mountedRef.current) {
        setAddError(err.message);
      }
    } finally {
      if (mountedRef.current) setAdding(false);
    }
  }

  /** 입력 필드에서 Enter 키 처리 */
  function handleInputKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addKeywords();
    } else if (e.key === 'Escape') {
      setInputValue('');
      setAddError('');
    }
  }

  // ── 키워드 삭제 ──────────────────────────────────────────────────────────────

  /** DELETE /api/resume/strength-keywords/:keyword */
  async function deleteKeyword(keyword) {
    // 이미 삭제 중이면 무시
    if (deletingSet.has(keyword)) return;

    setDeletingSet((prev) => new Set([...prev, keyword]));
    setDeleteErrors((prev) => ({ ...prev, [keyword]: '' }));

    try {
      const res = await fetch(
        `/api/resume/strength-keywords/${encodeURIComponent(keyword)}`,
        { method: 'DELETE', credentials: 'include' },
      );

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      if (mountedRef.current) {
        // 서버가 반환한 최신 keywords 배열로 상태 갱신
        if (Array.isArray(data.keywords)) {
          setKeywords(data.keywords);
        } else {
          // fallback: 로컬에서 제거
          setKeywords((prev) => (prev ?? []).filter((k) => k !== keyword));
        }
        // 삭제 오류 클리어
        setDeleteErrors((prev) => {
          const next = { ...prev };
          delete next[keyword];
          return next;
        });
      }
    } catch (err) {
      if (mountedRef.current) {
        setDeleteErrors((prev) => ({ ...prev, [keyword]: err.message }));
      }
    } finally {
      if (mountedRef.current) {
        setDeletingSet((prev) => {
          const next = new Set(prev);
          next.delete(keyword);
          return next;
        });
      }
    }
  }

  // ── 렌더 ─────────────────────────────────────────────────────────────────────

  return (
    <section class="skp-root" aria-label="강점 키워드">
      <header class="skp-header">
        <h3 class="skp-title">강점 키워드</h3>
        {!loading && !fetchError && (
          <button
            class="skp-refresh-btn"
            type="button"
            onClick={fetchKeywords}
            title="키워드 목록 새로고침"
            aria-label="새로고침"
          >
            ↻
          </button>
        )}
      </header>

      {/* ── 로딩 상태 ── */}
      {loading && (
        <div class="skp-state">
          <span class="skp-spinner" aria-label="불러오는 중" />
          <span class="skp-state-msg">불러오는 중…</span>
        </div>
      )}

      {/* ── 조회 오류 ── */}
      {!loading && fetchError && (
        <div class="skp-state skp-state--error">
          <p class="skp-error-msg">{fetchError}</p>
          <button class="skp-retry-btn" type="button" onClick={fetchKeywords}>
            다시 시도
          </button>
        </div>
      )}

      {/* ── 키워드 태그 목록 ── */}
      {!loading && !fetchError && keywords !== null && (
        <>
          {keywords.length === 0 ? (
            <p class="skp-empty">아직 강점 키워드가 없습니다.</p>
          ) : (
            <div class="skp-tags" role="list" aria-label="강점 키워드 목록">
              {keywords.map((kw) => {
                const isDeleting = deletingSet.has(kw);
                const deleteErr = deleteErrors[kw] || '';
                return (
                  <span
                    key={kw}
                    role="listitem"
                    class={`skp-tag${isDeleting ? ' skp-tag--deleting' : ''}`}
                    title={deleteErr || undefined}
                  >
                    <span class="skp-tag-text">{kw}</span>
                    <button
                      class={`skp-tag-remove${deleteErr ? ' skp-tag-remove--error' : ''}`}
                      type="button"
                      disabled={isDeleting}
                      aria-label={`"${kw}" 키워드 삭제`}
                      title={deleteErr ? `오류: ${deleteErr}` : `"${kw}" 삭제`}
                      onClick={() => deleteKeyword(kw)}
                    >
                      {isDeleting ? (
                        <span class="skp-tag-deleting-dot" aria-hidden="true" />
                      ) : (
                        '×'
                      )}
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* ── 키워드 추가 입력 ── */}
          <div class="skp-add-row">
            <input
              ref={inputRef}
              class="skp-add-input"
              type="text"
              value={inputValue}
              placeholder="키워드 입력 (콤마로 복수 입력)"
              maxLength={200}
              disabled={adding}
              aria-label="새 강점 키워드 입력"
              onInput={(e) => {
                setInputValue(e.target.value);
                if (addError) setAddError('');
              }}
              onKeyDown={handleInputKeyDown}
            />
            <button
              class="skp-add-btn"
              type="button"
              disabled={adding || !inputValue.trim()}
              aria-label="키워드 추가"
              title="키워드 추가 (Enter)"
              onClick={addKeywords}
            >
              {adding ? <span class="skp-adding-dot" aria-hidden="true" /> : '+'}
            </button>
          </div>

          {/* ── 추가 오류 메시지 ── */}
          {addError && (
            <p class="skp-add-error" role="alert">{addError}</p>
          )}
        </>
      )}

      <style>{SKP_CSS}</style>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Styles                                                               */
/* ──────────────────────────────────────────────────────────────────── */

const SKP_CSS = `
  .skp-root {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* ─── Header ─── */
  .skp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .skp-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink);
  }

  .skp-refresh-btn {
    padding: 2px 6px;
    font-size: 16px;
    line-height: 1;
    color: var(--muted);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .skp-refresh-btn:hover {
    color: var(--ink);
    background: var(--surface);
  }

  /* ─── State messages ─── */
  .skp-state {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
  }

  .skp-state--error {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .skp-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: skp-spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes skp-spin {
    to { transform: rotate(360deg); }
  }

  .skp-state-msg {
    font-size: 13px;
    color: var(--muted);
  }

  .skp-error-msg {
    margin: 0;
    font-size: 13px;
    color: #e53e3e;
  }

  .skp-retry-btn {
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background 0.15s;
  }

  .skp-retry-btn:hover {
    background: var(--line);
  }

  /* ─── Empty state ─── */
  .skp-empty {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    padding: var(--space-1) 0;
  }

  /* ─── Tag cloud ─── */
  .skp-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .skp-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px 4px 10px;
    font-size: 12px;
    font-weight: 500;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    transition: border-color 0.15s, background 0.15s, opacity 0.15s;
    max-width: 100%;
  }

  .skp-tag:hover {
    border-color: color-mix(in srgb, var(--ink) 30%, transparent);
    background: var(--panel);
  }

  .skp-tag--deleting {
    opacity: 0.45;
    pointer-events: none;
  }

  .skp-tag-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  .skp-tag-remove {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    font-size: 13px;
    line-height: 1;
    color: var(--muted);
    background: transparent;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }

  .skp-tag-remove:hover:not(:disabled) {
    color: #e53e3e;
    background: #fff5f5;
  }

  .skp-tag-remove:disabled {
    cursor: default;
  }

  .skp-tag-remove--error {
    color: #e53e3e;
  }

  /* Deleting spinner inside tag remove button */
  .skp-tag-deleting-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border: 1.5px solid var(--line-strong);
    border-top-color: var(--muted);
    border-radius: 50%;
    animation: skp-spin 0.7s linear infinite;
  }

  /* ─── Add row (input + button) ─── */
  .skp-add-row {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .skp-add-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    font-size: 13px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .skp-add-input:focus {
    border-color: var(--ink);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 12%, transparent);
  }

  .skp-add-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .skp-add-input::placeholder {
    color: var(--muted);
    font-size: 12px;
  }

  .skp-add-btn {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 400;
    line-height: 1;
    color: #fff;
    background: var(--ink);
    border: none;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: opacity 0.15s;
    padding: 0;
  }

  .skp-add-btn:hover:not(:disabled) {
    opacity: 0.82;
  }

  .skp-add-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* Spinner inside add button while adding */
  .skp-adding-dot {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: skp-spin 0.7s linear infinite;
  }

  /* ─── Add error ─── */
  .skp-add-error {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
  }

  /* ─── Print: hide panel ─── */
  @media print {
    .skp-root {
      display: none !important;
    }
  }
`;
