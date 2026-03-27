import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * AxisSplitModal
 *
 * 하나의 표시 축(Axis)을 두 개의 새로운 축으로 분리하는 모달 다이얼로그.
 *
 * UI 흐름:
 *   1. 원본 축의 키워드 목록을 체크박스로 표시
 *   2. 체크된 키워드 → 두 번째 새 축(axisB), 나머지 → 첫 번째 새 축(axisA)
 *   3. 두 축의 새 이름 입력 (labelA, labelB)
 *   4. 저장 → POST /api/resume/axes/:id/split
 *
 * props:
 *   axis      — 분리 대상 Axis 객체 { id, label, keywords[], _source? }
 *   onSplit   — 분리 성공 시 호출 콜백 (axisA, axisB, axes 전달)
 *   onClose   — 모달 닫기 콜백
 */
export function AxisSplitModal({ axis, onSplit, onClose }) {
  // 체크된 키워드 = axisB로 이동할 키워드
  const [checkedB, setCheckedB] = useState(/** @type {Set<string>} */ (new Set()));
  const [labelA, setLabelA] = useState(axis.label + ' (1)');
  const [labelB, setLabelB] = useState(axis.label + ' (2)');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const dialogRef = useRef(null);
  const firstInputRef = useRef(null);

  // 모달 열릴 때 첫 입력에 포커스
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  // ESC 키로 닫기
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 모달 외부 클릭으로 닫기
  function handleBackdropClick(e) {
    if (e.target === dialogRef.current) onClose();
  }

  function toggleKeyword(kw) {
    setCheckedB((prev) => {
      const next = new Set(prev);
      if (next.has(kw)) next.delete(kw);
      else next.add(kw);
      return next;
    });
    setError('');
  }

  // 파생 상태: 분리 결과 미리보기
  const keywordsA = (axis.keywords ?? []).filter((kw) => !checkedB.has(kw));
  const keywordsB = (axis.keywords ?? []).filter((kw) => checkedB.has(kw));
  const canSave =
    labelA.trim() &&
    labelB.trim() &&
    keywordsA.length > 0 &&
    keywordsB.length > 0 &&
    !saving;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSave) return;

    setSaving(true);
    setError('');

    try {
      const res = await fetch(`/api/resume/axes/${encodeURIComponent(axis.id)}/split`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          labelA: labelA.trim(),
          labelB: labelB.trim(),
          keywordsB: Array.from(checkedB),
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      onSplit?.(data.axisA, data.axisB, data.axes);
    } catch (err) {
      setError(err.message || '분리에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      class="asm-backdrop"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="축 분리"
      onClick={handleBackdropClick}
    >
      <div class="asm-dialog">
        {/* ── 헤더 ── */}
        <div class="asm-header">
          <h2 class="asm-title">축 분리: <em>{axis.label}</em></h2>
          <button
            type="button"
            class="asm-close-btn"
            aria-label="닫기"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <form class="asm-form" onSubmit={handleSubmit}>
          {/* ── 키워드 선택 섹션 ── */}
          <section class="asm-section">
            <p class="asm-section-desc">
              체크한 키워드는 <strong>두 번째 축</strong>으로 이동합니다.
              나머지 키워드는 <strong>첫 번째 축</strong>에 남습니다.
              두 축 모두 최소 1개의 키워드가 있어야 합니다.
            </p>

            <fieldset class="asm-kw-fieldset">
              <legend class="asm-kw-legend">키워드 배분</legend>
              <div class="asm-kw-grid">
                {(axis.keywords ?? []).map((kw) => {
                  const isB = checkedB.has(kw);
                  return (
                    <label key={kw} class={`asm-kw-chip ${isB ? 'asm-kw-chip--b' : 'asm-kw-chip--a'}`}>
                      <input
                        type="checkbox"
                        class="asm-kw-checkbox"
                        checked={isB}
                        onChange={() => toggleKeyword(kw)}
                      />
                      <span class="asm-kw-text">{kw}</span>
                      <span class="asm-kw-badge">{isB ? '2' : '1'}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </section>

          {/* ── 미리보기 ── */}
          <section class="asm-preview">
            <div class={`asm-preview-half ${keywordsA.length === 0 ? 'asm-preview-half--empty' : ''}`}>
              <div class="asm-preview-label">
                축 1 ({keywordsA.length}개)
                {keywordsA.length === 0 && <span class="asm-warn"> — 비어 있음</span>}
              </div>
              <div class="asm-preview-chips">
                {keywordsA.map((kw) => (
                  <span key={kw} class="asm-preview-chip">{kw}</span>
                ))}
              </div>
            </div>
            <div class="asm-preview-sep" aria-hidden="true">→</div>
            <div class={`asm-preview-half ${keywordsB.length === 0 ? 'asm-preview-half--empty' : ''}`}>
              <div class="asm-preview-label">
                축 2 ({keywordsB.length}개)
                {keywordsB.length === 0 && <span class="asm-warn"> — 비어 있음</span>}
              </div>
              <div class="asm-preview-chips">
                {keywordsB.map((kw) => (
                  <span key={kw} class="asm-preview-chip asm-preview-chip--b">{kw}</span>
                ))}
              </div>
            </div>
          </section>

          {/* ── 이름 입력 ── */}
          <section class="asm-section">
            <div class="asm-field">
              <label class="asm-field-label" for="asm-labelA">
                첫 번째 축 이름
              </label>
              <input
                id="asm-labelA"
                ref={firstInputRef}
                type="text"
                class="asm-field-input"
                value={labelA}
                onInput={(e) => { setLabelA(e.currentTarget.value); setError(''); }}
                maxLength={100}
                required
                placeholder="예: 백엔드 엔지니어"
                disabled={saving}
              />
              {keywordsA.length > 0 && (
                <p class="asm-field-hint">
                  포함 키워드: {keywordsA.join(', ')}
                </p>
              )}
            </div>

            <div class="asm-field">
              <label class="asm-field-label" for="asm-labelB">
                두 번째 축 이름
              </label>
              <input
                id="asm-labelB"
                type="text"
                class="asm-field-input"
                value={labelB}
                onInput={(e) => { setLabelB(e.currentTarget.value); setError(''); }}
                maxLength={100}
                required
                placeholder="예: 오픈소스 기여자"
                disabled={saving}
              />
              {keywordsB.length > 0 && (
                <p class="asm-field-hint">
                  포함 키워드: {keywordsB.join(', ')}
                </p>
              )}
            </div>
          </section>

          {/* ── 오류 메시지 ── */}
          {error && (
            <p class="asm-error" role="alert">{error}</p>
          )}

          {/* ── 액션 버튼 ── */}
          <div class="asm-actions">
            <button
              type="button"
              class="asm-btn asm-btn--cancel"
              onClick={onClose}
              disabled={saving}
            >
              취소
            </button>
            <button
              type="submit"
              class="asm-btn asm-btn--submit"
              disabled={!canSave}
              aria-busy={saving}
            >
              {saving ? '분리 중…' : '축 분리'}
            </button>
          </div>
        </form>
      </div>

      <style>{ASM_CSS}</style>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── */
/* Styles                                                     */
/* ────────────────────────────────────────────────────────── */

const ASM_CSS = `
  /* ─── Backdrop ─── */
  .asm-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: var(--space-4);
  }

  /* ─── Dialog ─── */
  .asm-dialog {
    background: var(--bg, #fff);
    border-radius: var(--radius-lg, 12px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
    width: 100%;
    max-width: 580px;
    max-height: 90vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  /* ─── Header ─── */
  .asm-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--line, #e5e7eb);
    position: sticky;
    top: 0;
    background: var(--bg, #fff);
    z-index: 1;
  }

  .asm-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--ink, #111);
  }

  .asm-title em {
    font-style: normal;
    color: var(--muted, #6b7280);
  }

  .asm-close-btn {
    background: none;
    border: none;
    padding: 4px 8px;
    font-size: 16px;
    color: var(--muted, #6b7280);
    cursor: pointer;
    border-radius: var(--radius-sm, 4px);
    transition: background 0.12s;
  }

  .asm-close-btn:hover {
    background: var(--surface, #f3f4f6);
    color: var(--ink, #111);
  }

  /* ─── Form sections ─── */
  .asm-form {
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .asm-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .asm-section-desc {
    margin: 0;
    font-size: 13px;
    color: var(--muted, #6b7280);
    line-height: 1.5;
  }

  /* ─── Keyword fieldset ─── */
  .asm-kw-fieldset {
    border: 1px solid var(--line, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    padding: var(--space-3) var(--space-4);
    margin: 0;
  }

  .asm-kw-legend {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted, #6b7280);
    padding: 0 6px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .asm-kw-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: var(--space-2);
  }

  /* ─── Keyword chips (checkbox labels) ─── */
  .asm-kw-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px 4px 6px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.12s, box-shadow 0.12s;
    user-select: none;
    border: 1.5px solid transparent;
  }

  .asm-kw-chip--a {
    background: var(--surface, #f3f4f6);
    color: var(--ink, #111);
    border-color: var(--line, #e5e7eb);
  }

  .asm-kw-chip--a:hover {
    background: #e0e7ff;
    border-color: #818cf8;
  }

  .asm-kw-chip--b {
    background: #dbeafe;
    color: #1d4ed8;
    border-color: #93c5fd;
  }

  .asm-kw-chip--b:hover {
    background: #bfdbfe;
  }

  .asm-kw-checkbox {
    width: 14px;
    height: 14px;
    accent-color: #3b82f6;
    flex-shrink: 0;
  }

  .asm-kw-text {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .asm-kw-badge {
    font-size: 10px;
    font-weight: 700;
    background: rgba(0,0,0,0.08);
    border-radius: 999px;
    padding: 1px 5px;
    min-width: 16px;
    text-align: center;
  }

  /* ─── Preview ─── */
  .asm-preview {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    background: var(--surface, #f9fafb);
    border: 1px solid var(--line, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    padding: var(--space-3) var(--space-4);
  }

  .asm-preview-half {
    flex: 1;
    min-width: 0;
  }

  .asm-preview-half--empty .asm-preview-chips {
    min-height: 24px;
  }

  .asm-preview-label {
    font-size: 11px;
    font-weight: 700;
    color: var(--muted, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }

  .asm-warn {
    color: #dc2626;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
  }

  .asm-preview-sep {
    align-self: center;
    font-size: 18px;
    color: var(--muted, #6b7280);
    flex-shrink: 0;
    padding: 0 var(--space-1);
  }

  .asm-preview-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .asm-preview-chip {
    font-size: 12px;
    padding: 2px 8px;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 999px;
    color: var(--ink, #111);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 120px;
  }

  .asm-preview-chip--b {
    background: #dbeafe;
    border-color: #93c5fd;
    color: #1d4ed8;
  }

  /* ─── Fields ─── */
  .asm-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .asm-field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink, #111);
  }

  .asm-field-input {
    padding: 8px 12px;
    border: 1px solid var(--line-strong, #d1d5db);
    border-radius: var(--radius-md, 8px);
    font-size: 14px;
    color: var(--ink, #111);
    background: var(--bg, #fff);
    transition: border-color 0.12s, box-shadow 0.12s;
    outline: none;
  }

  .asm-field-input:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
  }

  .asm-field-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .asm-field-hint {
    margin: 0;
    font-size: 11px;
    color: var(--muted, #6b7280);
    line-height: 1.4;
  }

  /* ─── Error ─── */
  .asm-error {
    margin: 0;
    padding: 8px 12px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: var(--radius-md, 8px);
    font-size: 13px;
    color: #dc2626;
  }

  /* ─── Actions ─── */
  .asm-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line, #e5e7eb);
  }

  .asm-btn {
    padding: 8px 18px;
    font-size: 14px;
    font-weight: 600;
    border-radius: var(--radius-md, 8px);
    cursor: pointer;
    transition: opacity 0.12s, background 0.12s;
    border: none;
  }

  .asm-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .asm-btn--cancel {
    background: var(--surface, #f3f4f6);
    color: var(--ink, #111);
    border: 1px solid var(--line-strong, #d1d5db);
  }

  .asm-btn--cancel:hover:not(:disabled) {
    background: var(--line, #e5e7eb);
  }

  .asm-btn--submit {
    background: var(--ink, #111);
    color: #fff;
  }

  .asm-btn--submit:hover:not(:disabled) {
    opacity: 0.82;
  }

  /* ─── Mobile ─── */
  @media (max-width: 600px) {
    .asm-preview {
      flex-direction: column;
    }

    .asm-preview-sep {
      transform: rotate(90deg);
      align-self: center;
    }
  }
`;
