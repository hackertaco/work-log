import { useEffect, useRef, useState } from 'preact/hooks';
import { AxisSplitModal } from './AxisSplitModal.jsx';

/**
 * AxesPanel — 표시 축 관리 패널
 *
 * GET /api/resume/axes 로 현재 표시 축 목록을 불러와 리스트로 표시하며,
 * 각 축의 이름(label)을 인라인 편집(inline edit)할 수 있다.
 *
 * 인라인 편집 흐름:
 *   1. 축 이름 클릭 → 텍스트 인풋으로 전환
 *   2. Enter / 포커스 이탈(blur) → PATCH /api/resume/axes/:id 로 저장
 *   3. Escape → 취소, 원래 값 복원
 *   4. 저장 중(saving) 상태 표시 → 완료 후 업데이트된 label 반영
 *
 * 축 분리 흐름:
 *   1. 각 축 카드의 "분리" 버튼 클릭 → AxisSplitModal 열기
 *   2. 모달에서 키워드 체크박스 선택 후 두 새 축 이름 입력
 *   3. POST /api/resume/axes/:id/split → 성공 시 목록 갱신
 *
 * 현재는 키워드 이동보다 축 이름/추가/분리를 우선한다.
 * props: 없음 (독립 패널)
 */
export function AxesPanel() {
  const [axes, setAxes] = useState(/** @type {Axis[]|null} */ (null));
  const [fetchError, setFetchError] = useState('');
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // 현재 편집 중인 축 id
  const [editingId, setEditingId] = useState(/** @type {string|null} */ (null));
  // 편집 중인 임시 label 값
  const [draftLabel, setDraftLabel] = useState('');
  // 저장 중인 축 id
  const [savingId, setSavingId] = useState(/** @type {string|null} */ (null));
  // 축별 저장 오류
  const [saveErrors, setSaveErrors] = useState(/** @type {Record<string,string>} */ ({}));
  // 분리 모달을 열 대상 축 id (null이면 모달 닫힘)
  const [splitTargetId, setSplitTargetId] = useState(/** @type {string|null} */ (null));
  const mountedRef = useRef(true);
  const inputRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    fetchAxes();
  }, []);

  // 편집 모드 진입 시 인풋에 포커스
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // ── 데이터 로드 ──────────────────────────────────────────────────────────────

  async function fetchAxes() {
    setLoading(true);
    setFetchError('');
    try {
      const res = await fetch('/api/resume/axes', { credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (mountedRef.current) {
        setAxes(data.axes ?? []);
      }
    } catch (err) {
      if (mountedRef.current) {
        setFetchError(err.message);
        setAxes([]);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  // ── 인라인 편집 ──────────────────────────────────────────────────────────────

  /** 편집 모드 진입 */
  function startEdit(axis) {
    if (savingId) return; // 저장 중에는 편집 불가
    setEditingId(axis.id);
    setDraftLabel(axis.label);
    setSaveErrors(prev => ({ ...prev, [axis.id]: '' }));
  }

  /** 편집 취소 */
  function cancelEdit() {
    setEditingId(null);
    setDraftLabel('');
  }

  /** PATCH /api/resume/axes/:id — label 저장 */
  async function saveLabel(axisId) {
    const trimmed = draftLabel.trim();

    // 빈 값이면 취소
    if (!trimmed) {
      cancelEdit();
      return;
    }

    // 변경 없으면 취소
    const current = axes?.find(a => a.id === axisId);
    if (current && current.label === trimmed) {
      cancelEdit();
      return;
    }

    setEditingId(null);
    setSavingId(axisId);
    setSaveErrors(prev => ({ ...prev, [axisId]: '' }));

    try {
      const res = await fetch(`/api/resume/axes/${encodeURIComponent(axisId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trimmed }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // 낙관적 업데이트: 서버 응답 반영
      if (mountedRef.current && data.axis) {
        setAxes(prev =>
          (prev ?? []).map(a => (a.id === axisId ? data.axis : a))
        );
      }
    } catch (err) {
      if (mountedRef.current) {
        setSaveErrors(prev => ({ ...prev, [axisId]: err.message }));
        // 실패 시 편집 모드 복원
        const original = axes?.find(a => a.id === axisId);
        if (original) {
          setEditingId(axisId);
          setDraftLabel(trimmed); // 사용자가 입력한 값 유지
        }
      }
    } finally {
      if (mountedRef.current) setSavingId(null);
    }
  }

  /** 키보드 이벤트 처리 */
  function handleKeyDown(e, axisId) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveLabel(axisId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  async function createAxisManually() {
    const label = newLabel.trim();
    if (!label) {
      setCreateError('축 이름을 입력해 주세요.');
      return;
    }

    setCreating(true);
    setCreateError('');
    try {
      const keywords = newKeywords
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      const res = await fetch('/api/resume/axes/manual', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, keywords }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      if (mountedRef.current) {
        setAxes(data.axes ?? []);
        setNewLabel('');
        setNewKeywords('');
      }
    } catch (err) {
      if (mountedRef.current) {
        setCreateError(err.message);
      }
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  }

  // ── 분리 ─────────────────────────────────────────────────────────────────────

  /** 분리 모달 열기 */
  function openSplitModal(axisId) {
    // 편집/저장 중에는 모달 열기 불가
    if (editingId || savingId) return;
    setSplitTargetId(axisId);
  }

  /** 분리 모달 닫기 */
  function closeSplitModal() {
    setSplitTargetId(null);
  }

  /** 분리 성공 콜백: 서버에서 반환된 전체 축 목록으로 상태 갱신 */
  function handleSplitDone(_axisA, _axisB, updatedAxes) {
    setSplitTargetId(null);
    if (mountedRef.current && Array.isArray(updatedAxes)) {
      setAxes(updatedAxes);
    }
  }

  // ── 렌더 ─────────────────────────────────────────────────────────────────────

  return (
    <section class="axp-root" aria-label="표시 축 목록">
      <header class="axp-header">
        <h3 class="axp-title">표시 축</h3>
        {!loading && !fetchError && (
          <button
            class="axp-refresh-btn"
            type="button"
            onClick={fetchAxes}
            title="축 목록 새로고침"
            aria-label="새로고침"
          >
            ↻
          </button>
        )}
      </header>

      <div class="axp-create">
        <div class="axp-create-fields">
          <input
            class="axp-create-input"
            type="text"
            placeholder="새 축 이름"
            value={newLabel}
            maxLength={100}
            onInput={(e) => setNewLabel(e.target.value)}
          />
          <input
            class="axp-create-input"
            type="text"
            placeholder="키워드 (쉼표로 구분, 선택)"
            value={newKeywords}
            onInput={(e) => setNewKeywords(e.target.value)}
          />
        </div>
        <button
          class="axp-create-btn"
          type="button"
          onClick={createAxisManually}
          disabled={creating}
        >
          {creating ? '추가 중…' : '새 축 추가'}
        </button>
        {createError && <p class="axp-create-error" role="alert">{createError}</p>}
      </div>

      {loading && (
        <div class="axp-state">
          <span class="axp-spinner" aria-label="불러오는 중" />
          <span class="axp-state-msg">불러오는 중…</span>
        </div>
      )}

      {!loading && fetchError && (
        <div class="axp-state axp-state--error">
          <p class="axp-error-msg">{fetchError}</p>
          <button class="axp-retry-btn" type="button" onClick={fetchAxes}>
            다시 시도
          </button>
        </div>
      )}

      {!loading && !fetchError && axes !== null && axes.length === 0 && (
        <p class="axp-empty">
          아직 표시 축이 없습니다.
        </p>
      )}

      {!loading && !fetchError && axes !== null && axes.length > 0 && (
        <ul class="axp-list" role="list">
          {axes.map(axis => {
            const isEditing = editingId === axis.id;
            const isSaving = savingId === axis.id;
            const saveErr = saveErrors[axis.id] || '';

            return (
              <li
                key={axis.id}
                class={`axp-item${isSaving ? ' axp-item--saving' : ''}`}
              >
                <div class="axp-item-row">
                  {isEditing ? (
                    /* ─ 편집 모드 ─ */
                    <input
                      ref={inputRef}
                      class="axp-label-input"
                      type="text"
                      value={draftLabel}
                      maxLength={100}
                      aria-label="축 이름 편집"
                      onInput={e => setDraftLabel(e.target.value)}
                      onKeyDown={e => handleKeyDown(e, axis.id)}
                      onBlur={() => saveLabel(axis.id)}
                    />
                  ) : (
                    /* ─ 보기 모드 ─ */
                    <button
                      class="axp-label-btn"
                      type="button"
                      title="클릭하여 이름 편집"
                      disabled={isSaving || savingId !== null}
                      onClick={() => startEdit(axis)}
                    >
                      {isSaving ? (
                        <span class="axp-saving-indicator" aria-label="저장 중">
                          {axis.label}
                          <span class="axp-saving-dot" />
                        </span>
                      ) : (
                        axis.label
                      )}
                    </button>
                  )}

                  {isEditing && (
                    <div class="axp-edit-actions">
                      <button
                        class="axp-action-btn axp-action-btn--save"
                        type="button"
                        onClick={() => saveLabel(axis.id)}
                        aria-label="저장"
                        title="저장 (Enter)"
                      >
                        ✓
                      </button>
                      <button
                        class="axp-action-btn axp-action-btn--cancel"
                        type="button"
                        onClick={cancelEdit}
                        aria-label="취소"
                        title="취소 (Esc)"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>

                {/* 저장 오류 */}
                {saveErr && (
                  <p class="axp-save-error" role="alert">{saveErr}</p>
                )}

                {/* 분리 버튼 (키워드가 2개 이상일 때만 활성) */}
                {!isEditing && (
                  <div class="axp-split-row">
                    <button
                      class="axp-split-btn"
                      type="button"
                      disabled={
                        isSaving ||
                        savingId !== null ||
                        (axis.keywords ?? []).length < 2
                      }
                      title={
                        (axis.keywords ?? []).length < 2
                          ? '축을 분리하려면 최소 2개 이상의 관련 키워드가 필요합니다'
                          : '이 축을 두 개의 더 구체적인 축으로 분리합니다'
                      }
                      onClick={() => openSplitModal(axis.id)}
                    >
                      축 분리
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* 분리 모달 */}
      {splitTargetId && (() => {
        const target = (axes ?? []).find(a => a.id === splitTargetId);
        return target ? (
          <AxisSplitModal
            axis={target}
            onSplit={handleSplitDone}
            onClose={closeSplitModal}
          />
        ) : null;
      })()}

      <style>{AXP_CSS}</style>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Styles                                                               */
/* ──────────────────────────────────────────────────────────────────── */

const AXP_CSS = `
  .axp-root {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .axp-create {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .axp-create-fields {
    display: grid;
    gap: 8px;
  }

  .axp-create-input {
    width: 100%;
    padding: 8px 10px;
    font-size: 12px;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    outline: none;
  }

  .axp-create-input:focus {
    border-color: var(--ink);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 12%, transparent);
  }

  .axp-create-btn {
    align-self: flex-start;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .axp-create-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .axp-create-error {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
  }

  /* ─── Header ─── */
  .axp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .axp-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink);
  }

  .axp-refresh-btn {
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

  .axp-refresh-btn:hover {
    color: var(--ink);
    background: var(--surface);
  }

  /* ─── State messages ─── */
  .axp-state {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
  }

  .axp-state--error {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .axp-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: axp-spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes axp-spin {
    to { transform: rotate(360deg); }
  }

  .axp-state-msg {
    font-size: 13px;
    color: var(--muted);
  }

  .axp-error-msg {
    margin: 0;
    font-size: 13px;
    color: #e53e3e;
  }

  .axp-retry-btn {
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

  .axp-retry-btn:hover {
    background: var(--line);
  }

  .axp-empty {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    padding: var(--space-2) 0;
  }

  /* ─── List ─── */
  .axp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .axp-item {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    transition: border-color 0.15s;
  }

  .axp-item:hover {
    border-color: var(--line-strong);
  }

  .axp-item--saving {
    opacity: 0.7;
  }

  /* ─── Item row (label + edit actions) ─── */
  .axp-item-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 28px;
  }

  /* ─── Label as button (view mode) ─── */
  .axp-label-btn {
    flex: 1;
    min-width: 0;
    text-align: left;
    padding: 3px 6px;
    margin: -3px -6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: text;
    transition: background 0.15s, border-color 0.15s;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .axp-label-btn:hover:not(:disabled) {
    background: var(--panel);
    border-color: var(--line-strong);
  }

  .axp-label-btn:disabled {
    cursor: default;
    opacity: 0.8;
  }

  /* ─── Saving indicator inside label button ─── */
  .axp-saving-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .axp-saving-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border: 1.5px solid var(--muted);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: axp-spin 0.7s linear infinite;
  }

  /* ─── Label input (edit mode) ─── */
  .axp-label-input {
    flex: 1;
    min-width: 0;
    padding: 3px 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--ink);
    border-radius: var(--radius-sm);
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 15%, transparent);
  }

  .axp-label-input:focus {
    border-color: var(--ink);
  }

  /* ─── Edit action buttons (✓ ✕) ─── */
  .axp-edit-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .axp-action-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: var(--surface);
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    padding: 0;
    line-height: 1;
  }

  .axp-action-btn--save {
    color: #2f855a;
    border-color: #c6f6d5;
    background: #f0fff4;
  }

  .axp-action-btn--save:hover {
    background: #c6f6d5;
    border-color: #2f855a;
  }

  .axp-action-btn--cancel {
    color: var(--muted);
  }

  .axp-action-btn--cancel:hover {
    color: #e53e3e;
    border-color: #fed7d7;
    background: #fff5f5;
  }

  /* ─── Save error ─── */
  .axp-save-error {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
  }

  /* ─── Split button row ─── */
  .axp-split-row {
    display: flex;
    justify-content: flex-end;
  }

  .axp-split-btn {
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 600;
    color: #1d4ed8;
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }

  .axp-split-btn:hover:not(:disabled) {
    background: #dbeafe;
    border-color: #93c5fd;
  }

  .axp-split-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ─── Print: hide panel ─── */
  @media print {
    .axp-root {
      display: none !important;
    }
  }
`;
