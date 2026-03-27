import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * AxisMergePanel — 두 개의 축을 하나로 합치는 UI 패널
 *
 * GET /api/resume/axes 에서 현재 축 목록을 불러와
 * 드롭다운으로 target(유지), source(흡수) 두 축을 선택한 뒤
 * POST /api/resume/axes/merge 를 호출한다.
 *
 * 병합 결과:
 *   - target 축의 키워드가 source 키워드와 합쳐진다 (중복 제거)
 *   - source 축은 삭제된다
 *   - 선택적으로 병합 축의 새 이름을 지정할 수 있다
 *
 * props:
 *   onMerged — 병합 완료 시 서버에서 반환된 최신 axes 배열을 전달
 */
export function AxisMergePanel({ onMerged }) {
  /** @type {[Axis[]|null, Function]} */
  const [axes, setAxes] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  // Form state
  const [targetId, setTargetId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [newLabel, setNewLabel] = useState('');

  // Submission state
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [mergeSuccess, setMergeSuccess] = useState('');

  // Track open/close state of the panel (collapsed by default)
  const [open, setOpen] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function fetchAxes() {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch('/api/resume/axes', { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (mountedRef.current) {
        setAxes(data.axes ?? []);
        // Reset selections when axes reload
        setTargetId('');
        setSourceId('');
        setNewLabel('');
      }
    } catch (err) {
      if (mountedRef.current) {
        setLoadError(err.message);
        setAxes([]);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (open) fetchAxes();
  }, [open]);

  async function handleMerge(e) {
    e.preventDefault();
    if (!targetId || !sourceId) return;
    if (targetId === sourceId) {
      setMergeError('합칠 대상 축 두 개를 각각 다르게 선택해 주세요.');
      return;
    }

    setMerging(true);
    setMergeError('');
    setMergeSuccess('');

    try {
      const body = { targetId, sourceId };
      if (newLabel.trim()) body.label = newLabel.trim();

      const res = await fetch('/api/resume/axes/merge', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      if (mountedRef.current) {
        const targetLabel = axes.find((a) => a.id === targetId)?.label ?? targetId;
        const sourceLabel = axes.find((a) => a.id === sourceId)?.label ?? sourceId;
        setMergeSuccess(
          `"${sourceLabel}" 축이 "${data.merged.label}" 축에 병합되었습니다. ` +
          `키워드 ${data.merged.keywords.length}개로 통합됨.`
        );
        // Refresh axes list with the returned array
        setAxes(data.axes ?? []);
        setTargetId('');
        setSourceId('');
        setNewLabel('');
        onMerged?.(data.axes);
      }
    } catch (err) {
      if (mountedRef.current) {
        setMergeError(`병합 실패: ${err.message}`);
      }
    } finally {
      if (mountedRef.current) setMerging(false);
    }
  }

  // Target and source must differ; filter available options accordingly
  const targetOptions = axes ?? [];
  const sourceOptions = (axes ?? []).filter((a) => a.id !== targetId);

  // Preview: show what keywords will be in the merged axis
  const targetAxis = (axes ?? []).find((a) => a.id === targetId);
  const sourceAxis = (axes ?? []).find((a) => a.id === sourceId);
  const previewKeywords = targetAxis && sourceAxis
    ? deduplicateKeywords([
        ...(targetAxis.keywords ?? []),
        ...(sourceAxis.keywords ?? []),
      ])
    : null;

  return (
    <div class="amp-root">
      {/* ── Toggle header ── */}
      <button
        class="amp-toggle"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span class="amp-toggle-label">축 병합</span>
        <span class="amp-toggle-icon" aria-hidden="true">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div class="amp-body">
          {/* ── Loading ── */}
          {loading && (
            <div class="amp-state">
              <span class="amp-spinner" aria-label="불러오는 중" />
            </div>
          )}

          {/* ── Load error ── */}
          {!loading && loadError && (
            <div class="amp-state amp-state--error">
              <p class="amp-error-msg">{loadError}</p>
              <button class="amp-retry-btn" type="button" onClick={fetchAxes}>
                다시 시도
              </button>
            </div>
          )}

          {/* ── No axes ── */}
          {!loading && !loadError && (axes ?? []).length < 2 && (
            <p class="amp-hint">
              축이 2개 이상 있어야 병합할 수 있습니다.
            </p>
          )}

          {/* ── Merge form ── */}
          {!loading && !loadError && (axes ?? []).length >= 2 && (
            <form class="amp-form" onSubmit={handleMerge}>
              {/* Target axis (to keep) */}
              <div class="amp-field">
                <label class="amp-label" for="amp-target">
                  유지할 축 <span class="amp-required">*</span>
                </label>
                <select
                  id="amp-target"
                  class="amp-select"
                  value={targetId}
                  onChange={(e) => {
                    setTargetId(e.target.value);
                    setMergeError('');
                    setMergeSuccess('');
                  }}
                  disabled={merging}
                  required
                >
                  <option value="">— 선택 —</option>
                  {targetOptions.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
                {targetAxis && (
                  <p class="amp-axis-hint">
                    키워드: {targetAxis.keywords.slice(0, 5).join(', ')}
                    {targetAxis.keywords.length > 5 && ` 외 ${targetAxis.keywords.length - 5}개`}
                  </p>
                )}
              </div>

              {/* Source axis (to absorb) */}
              <div class="amp-field">
                <label class="amp-label" for="amp-source">
                  흡수할 축 <span class="amp-required">*</span>
                </label>
                <select
                  id="amp-source"
                  class="amp-select"
                  value={sourceId}
                  onChange={(e) => {
                    setSourceId(e.target.value);
                    setMergeError('');
                    setMergeSuccess('');
                  }}
                  disabled={merging || !targetId}
                  required
                >
                  <option value="">— 선택 —</option>
                  {sourceOptions.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
                {sourceAxis && (
                  <p class="amp-axis-hint">
                    키워드: {sourceAxis.keywords.slice(0, 5).join(', ')}
                    {sourceAxis.keywords.length > 5 && ` 외 ${sourceAxis.keywords.length - 5}개`}
                  </p>
                )}
              </div>

              {/* Optional new label */}
              <div class="amp-field">
                <label class="amp-label" for="amp-label">
                  병합 후 새 이름 <span class="amp-optional">(선택)</span>
                </label>
                <input
                  id="amp-label"
                  class="amp-input"
                  type="text"
                  placeholder={targetAxis?.label ?? '유지할 축의 이름 그대로 사용'}
                  value={newLabel}
                  onInput={(e) => setNewLabel(e.target.value)}
                  disabled={merging}
                  maxLength={100}
                />
              </div>

              {/* Keyword preview */}
              {previewKeywords && (
                <div class="amp-preview">
                  <p class="amp-preview-label">병합 후 키워드 미리보기 ({previewKeywords.length}개)</p>
                  <p class="amp-preview-kws">
                    {previewKeywords.slice(0, 10).join(' · ')}
                    {previewKeywords.length > 10 && ` · +${previewKeywords.length - 10}개`}
                  </p>
                </div>
              )}

              {/* Error / success messages */}
              {mergeError && <p class="amp-msg amp-msg--error">{mergeError}</p>}
              {mergeSuccess && <p class="amp-msg amp-msg--success">{mergeSuccess}</p>}

              {/* Submit button */}
              <button
                class="amp-submit"
                type="submit"
                disabled={merging || !targetId || !sourceId}
              >
                {merging ? '병합 중…' : '두 축 병합'}
              </button>
            </form>
          )}
        </div>
      )}

      <style>{AMP_CSS}</style>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deduplicate keywords case-insensitively, preserving first-occurrence casing.
 * @param {string[]} kws
 * @returns {string[]}
 */
function deduplicateKeywords(kws) {
  const seen = new Set();
  const result = [];
  for (const kw of kws) {
    if (typeof kw !== 'string') continue;
    const lower = kw.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(kw);
    if (result.length >= 30) break;
  }
  return result;
}

// ─── JSDoc types ─────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   keywords: string[],
 *   _source?: 'user' | 'system'
 * }} Axis
 */

// ─── Styles ──────────────────────────────────────────────────────────────────

const AMP_CSS = `
  /* ─── Root card ─── */
  .amp-root {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    backdrop-filter: blur(10px);
    overflow: hidden;
  }

  /* ─── Collapsible toggle header ─── */
  .amp-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-5);
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    transition: color 0.15s, background 0.15s;
    text-align: left;
  }

  .amp-toggle:hover {
    color: var(--ink);
    background: rgba(17, 24, 39, 0.04);
  }

  .amp-toggle-label {
    flex: 1;
  }

  .amp-toggle-icon {
    font-size: 9px;
    margin-left: var(--space-2);
    line-height: 1;
  }

  /* ─── Collapsible body ─── */
  .amp-body {
    padding: 0 var(--space-5) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border-top: 1px solid var(--line);
  }

  /* ─── Loading / Error / Hint states ─── */
  .amp-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) 0;
  }

  .amp-spinner {
    display: block;
    width: 18px;
    height: 18px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: amp-spin 0.7s linear infinite;
  }

  @keyframes amp-spin {
    to { transform: rotate(360deg); }
  }

  .amp-state--error { align-items: flex-start; }

  .amp-error-msg {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
    line-height: 1.5;
  }

  .amp-retry-btn {
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .amp-retry-btn:hover { opacity: 0.75; }

  .amp-hint {
    margin: var(--space-3) 0 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.6;
  }

  /* ─── Form ─── */
  .amp-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-2);
  }

  .amp-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .amp-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .amp-required { color: #e53e3e; }
  .amp-optional {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  .amp-select,
  .amp-input {
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.5;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: #fff;
    color: var(--ink);
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
  }

  .amp-select:focus,
  .amp-input:focus {
    outline: none;
    border-color: var(--ink);
  }

  .amp-select:disabled,
  .amp-input:disabled {
    background: rgba(17, 24, 39, 0.04);
    color: var(--muted);
    cursor: default;
  }

  .amp-axis-hint {
    margin: 0;
    font-size: 10px;
    color: var(--muted);
    line-height: 1.5;
  }

  /* ─── Keyword preview ─── */
  .amp-preview {
    background: rgba(17, 24, 39, 0.03);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
  }

  .amp-preview-label {
    margin: 0 0 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .amp-preview-kws {
    margin: 0;
    font-size: 11px;
    color: var(--ink);
    line-height: 1.6;
    word-break: break-word;
  }

  /* ─── Feedback messages ─── */
  .amp-msg {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
  }

  .amp-msg--error { color: #e53e3e; }
  .amp-msg--success { color: #38a169; }

  /* ─── Submit button ─── */
  .amp-submit {
    padding: 7px 12px;
    font-size: 12px;
    font-weight: 600;
    background: var(--ink);
    color: #fff;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity 0.15s;
    align-self: flex-start;
  }

  .amp-submit:hover:not(:disabled) {
    opacity: 0.82;
  }

  .amp-submit:disabled {
    cursor: default;
    opacity: 0.45;
  }

  /* ─── Print: hide ─── */
  @media print {
    .amp-root { display: none !important; }
  }
`;
