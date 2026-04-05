import { useState, useRef, useEffect } from 'preact/hooks';

/**
 * BulletProposalChip — 불릿 단위 제안을 이력서 본문에 인라인으로 표시하는 컴포넌트.
 *
 * 이 컴포넌트는 SuggestionPanel / CandidateCard 와 달리 이력서 본문 내에서
 * 해당 불릿 바로 아래(또는 옆)에 렌더링된다. 사용자는 패널을 오가지 않고도
 * 불릿 맥락 안에서 바로 승인·제외·편집할 수 있다.
 *
 * 두 가지 제안 형식을 지원한다:
 *
 * ① 레거시 SuggestionItem 형식 (기존 diff 파이프라인):
 *   { action: 'append_bullet', patch: { company, bullet }, ... }
 *   { action: 'replace_bullet', patch: { section, itemIndex, bulletIndex, oldText, newText }, ... }
 *   { action: 'delete_bullet', patch: { section, itemIndex, bulletIndex, text }, ... }
 *
 * ② 신규 BulletProposal 형식 (resumeBulletProposal.mjs):
 *   { kind: 'bullet', op: 'add', target: { section, itemIndex }, payload: { text }, ... }
 *   { kind: 'bullet', op: 'replace', target: { section, itemIndex, bulletIndex }, payload: { text }, ... }
 *   { kind: 'bullet', op: 'delete', target: { section, itemIndex, bulletIndex }, ... }
 *
 * 인라인 텍스트 편집 (새 replace 제안 없이 내용 수정):
 *   "편집" 버튼 → textarea로 제안 텍스트 수정 → "저장"
 *   이 흐름은 새 replace 제안을 생성하지 않고, 기존 제안의 patch/payload를 직접 업데이트한다.
 *   PATCH /api/resume/suggestions/:id → { patch: { bullet: '수정된 내용' } }
 *   또는 BulletProposal: PATCH /api/resume/suggestions/:id → { payload: { text: '수정된 내용' } }
 *
 * API:
 *   POST  /api/resume/suggestions/:id/approve  — 승인
 *   POST  /api/resume/suggestions/:id/reject   — 제외
 *   PATCH /api/resume/suggestions/:id          — 인라인 편집 저장 (텍스트만 변경)
 *
 * @param {{
 *   proposal:         SuggestionItem | BulletProposal,
 *   onApproved?:      (id: string) => void,
 *   onRejected?:      (id: string) => void,
 *   onResumeUpdated?: () => void,
 * }} props
 */
export function BulletProposalChip({ proposal, onApproved, onRejected, onResumeUpdated }) {
  const { id } = proposal;

  // Normalise both proposal formats into a common view
  const normalised = normaliseProposal(proposal);
  const { opType, bulletText, oldText, source, logDate, canEditText } = normalised;

  // ── Local status — drives optimistic UI ─────────────────────────────────
  /** @type {'pending'|'approved'|'rejected'} */
  const [localStatus, setLocalStatus] = useState('pending');

  /** @type {null|'approving'|'rejecting'|'saving'} */
  const [loadingAction, setLoadingAction] = useState(null);

  // ── Inline edit state ────────────────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  // editText is initialised from the normalised bulletText
  const [editText, setEditText] = useState(bulletText);
  // Track whether user has saved edits in this session (to show updated text)
  const [savedEditText, setSavedEditText] = useState(/** @type {string|null} */ (null));
  const [error, setError] = useState(/** @type {string|null} */ (null));

  // Guard against state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const busy = loadingAction !== null;

  // ── Approve ──────────────────────────────────────────────────────────────
  async function handleApprove() {
    if (busy || localStatus !== 'pending') return;
    setLocalStatus('approved');
    setLoadingAction('approving');
    setError(null);
    try {
      const res = await fetch(
        `/api/resume/suggestions/${encodeURIComponent(id)}/approve`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      if (mountedRef.current) {
        onResumeUpdated?.();
        onApproved?.(id);
      }
    } catch (err) {
      if (mountedRef.current) {
        setLocalStatus('pending');
        setError(`승인 실패: ${err.message}`);
      }
    } finally {
      if (mountedRef.current) setLoadingAction(null);
    }
  }

  // ── Reject ───────────────────────────────────────────────────────────────
  async function handleReject() {
    if (busy || localStatus !== 'pending') return;
    setLocalStatus('rejected');
    setLoadingAction('rejecting');
    setError(null);
    try {
      const res = await fetch(
        `/api/resume/suggestions/${encodeURIComponent(id)}/reject`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      if (mountedRef.current) {
        onRejected?.(id);
      }
    } catch (err) {
      if (mountedRef.current) {
        setLocalStatus('pending');
        setError(`제외 실패: ${err.message}`);
      }
    } finally {
      if (mountedRef.current) setLoadingAction(null);
    }
  }

  // ── Save inline edit ─────────────────────────────────────────────────────
  // This modifies the proposal's patch/payload text directly (via PATCH suggestions/:id).
  // It does NOT create a new replace proposal — the user just fine-tunes the
  // proposed bullet content before approving it.
  async function handleSaveEdit() {
    if (busy) return;
    const trimmed = editText.trim();
    if (!trimmed) {
      setError('내용을 입력하세요.');
      return;
    }
    setLoadingAction('saving');
    setError(null);
    try {
      // Build the update body based on proposal format
      const updateBody = buildSaveBody(proposal, trimmed);
      const res = await fetch(`/api/resume/suggestions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      if (mountedRef.current) {
        // Show the saved text in the chip after closing edit mode
        setSavedEditText(trimmed);
        setIsEditing(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(`저장 실패: ${err.message}`);
      }
    } finally {
      if (mountedRef.current) setLoadingAction(null);
    }
  }

  function handleStartEdit() {
    // Re-init from saved text if user edited before, else from original
    setEditText(savedEditText ?? bulletText);
    setIsEditing(true);
    setError(null);
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setError(null);
  }

  // ── Approved state: brief confirmation ───────────────────────────────────
  if (localStatus === 'approved') {
    return (
      <div class="bpc bpc--approved" aria-live="polite">
        <span class="bpc-done">✓ 승인됨</span>
      </div>
    );
  }

  // ── Rejected state: disappear (parent removes from list) ─────────────────
  if (localStatus === 'rejected') return null;

  // ── Pending state ────────────────────────────────────────────────────────
  const chipClass = [
    'bpc',
    `bpc--${opType}`,
    busy ? 'bpc--busy' : '',
    isEditing ? 'bpc--editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const actionLabel = OP_LABELS[opType] ?? '제안';
  // Display the saved edit text if the user has saved edits in this session
  const displayText = savedEditText ?? bulletText;

  return (
    <div class={chipClass} aria-live="polite" role="region" aria-label={`${actionLabel} 제안`}>
      {/* ── Badge row ── */}
      <div class="bpc-header">
        <span class={`bpc-badge bpc-badge--${opType}`}>{actionLabel}</span>
        {source === 'work_log' && logDate && (
          <span class="bpc-date">{formatLogDate(logDate)}</span>
        )}
        {source === 'linkedin' && (
          <span class="bpc-source">LinkedIn</span>
        )}
      </div>

      {/* ── Diff-style preview ── */}
      {!isEditing && opType === 'replace' && oldText && (
        <div class="bpc-diff" aria-label="교체 diff">
          <div class="bpc-diff-row bpc-diff-row--old" title="현재 bullet 내용">
            <span class="bpc-diff-label">현재</span>
            <span class="bpc-diff-text bpc-diff-text--old">{oldText}</span>
          </div>
          <div class="bpc-diff-row bpc-diff-row--new" title="제안된 bullet 내용">
            <span class="bpc-diff-label">제안</span>
            <span class="bpc-diff-text">{displayText}</span>
          </div>
        </div>
      )}

      {!isEditing && opType === 'add' && (
        <div class="bpc-diff" aria-label="추가 diff">
          <div class="bpc-diff-row bpc-diff-row--new" title="추가 제안">
            <span class="bpc-diff-label">추가</span>
            <span class="bpc-diff-text">{displayText}</span>
          </div>
        </div>
      )}

      {!isEditing && opType === 'delete' && (
        <div class="bpc-diff" aria-label="삭제 diff">
          <div class="bpc-diff-row bpc-diff-row--old" title="삭제 대상 bullet">
            <span class="bpc-diff-label">삭제</span>
            <span class="bpc-diff-text bpc-diff-text--old">{displayText}</span>
          </div>
        </div>
      )}

      {/* ── Proposed text or inline edit textarea ── */}
      {isEditing ? (
        <textarea
          class="bpc-edit-textarea"
          value={editText}
          onInput={(e) => setEditText(e.target.value)}
          rows={2}
          disabled={busy}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          aria-label="제안 불릿 텍스트 편집"
          placeholder="제안 내용을 수정하세요"
        />
      ) : null}

      {!isEditing && !['replace', 'add', 'delete'].includes(opType) && (
        <span class="bpc-text" aria-label="제안 불릿 내용">
          {displayText}
        </span>
      )}

      {/* ── Error message ── */}
      {error && (
        <p class="bpc-error" role="alert">{error}</p>
      )}

      {/* ── Action buttons ── */}
      <div class="bpc-actions">
        {!isEditing && (
          <>
            <button
              class="bpc-btn bpc-btn--approve"
              type="button"
              onClick={handleApprove}
              disabled={busy}
              aria-busy={loadingAction === 'approving'}
              aria-label="제안 승인"
            >
              {loadingAction === 'approving' ? '적용 중…' : '승인'}
            </button>
            {canEditText && (
              <button
                class="bpc-btn bpc-btn--edit"
                type="button"
                onClick={handleStartEdit}
                disabled={busy}
                aria-label="제안 내용 편집"
                title="승인 전 내용을 수정합니다 (새 제안을 생성하지 않습니다)"
              >
                편집
              </button>
            )}
            <button
              class="bpc-btn bpc-btn--reject"
              type="button"
              onClick={handleReject}
              disabled={busy}
              aria-busy={loadingAction === 'rejecting'}
              aria-label="제안 제외"
            >
              {loadingAction === 'rejecting' ? '처리 중…' : '제외'}
            </button>
          </>
        )}
        {isEditing && (
          <>
            <button
              class="bpc-btn bpc-btn--save"
              type="button"
              onClick={handleSaveEdit}
              disabled={busy || !editText.trim()}
              aria-busy={loadingAction === 'saving'}
            >
              {loadingAction === 'saving' ? '저장 중…' : '저장'}
            </button>
            <button
              class="bpc-btn bpc-btn--cancel"
              type="button"
              onClick={handleCancelEdit}
              disabled={busy}
            >
              취소
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Normalisation ───────────────────────────────────────────────────────── */

/**
 * Normalise both legacy SuggestionItem and new BulletProposal into a common view
 * so the render logic only needs to handle one shape.
 *
 * Returns:
 *   opType       — 'add' | 'replace' | 'delete'
 *   bulletText   — proposed bullet text (empty string for delete)
 *   oldText      — current text being replaced (replace only; may be undefined)
 *   source       — 'work_log' | 'linkedin' | 'manual'
 *   logDate      — ISO date string (work_log only; may be undefined)
 *   canEditText  — true when text editing is meaningful (add/replace only)
 *
 * @param {object} proposal  — SuggestionItem or BulletProposal
 * @returns {{ opType: string, bulletText: string, oldText?: string,
 *             source: string, logDate?: string, canEditText: boolean }}
 */
function normaliseProposal(proposal) {
  const { source, logDate } = proposal;

  // ── New BulletProposal format (kind: 'bullet') ──────────────────────────
  if (proposal.kind === 'bullet') {
    const { op, payload } = proposal;
    return {
      opType: op,           // 'add' | 'replace' | 'delete'
      bulletText: payload?.text ?? '',
      oldText: undefined,   // BulletProposal doesn't carry the old text (resolved at apply time)
      source: source ?? 'manual',
      logDate,
      canEditText: op !== 'delete',
    };
  }

  // ── Legacy SuggestionItem format (action-based) ─────────────────────────
  const { action, patch = {} } = proposal;
  switch (action) {
    case 'append_bullet':
      return {
        opType: 'add',
        bulletText: patch.bullet ?? '',
        oldText: undefined,
        source: source ?? 'manual',
        logDate,
        canEditText: true,
      };
    case 'replace_bullet':
      return {
        opType: 'replace',
        bulletText: patch.newText ?? patch.bullet ?? '',
        oldText: patch.oldText,
        source: source ?? 'manual',
        logDate,
        canEditText: true,
      };
    case 'delete_bullet':
      return {
        opType: 'delete',
        bulletText: patch.text ?? patch.bullet ?? '',
        oldText: undefined,
        source: source ?? 'manual',
        logDate,
        canEditText: false,
      };
    default:
      return {
        opType: 'add',
        bulletText: '',
        oldText: undefined,
        source: source ?? 'manual',
        logDate,
        canEditText: true,
      };
  }
}

/**
 * Build the PATCH request body for saving an inline edit.
 * Handles both legacy SuggestionItem (uses 'patch') and BulletProposal (uses 'payload').
 *
 * @param {object} proposal    — original proposal object
 * @param {string} editedText  — the user's edited text
 * @returns {object}           — body to send to PATCH /api/resume/suggestions/:id
 */
function buildSaveBody(proposal, editedText) {
  if (proposal.kind === 'bullet') {
    // BulletProposal: update the payload.text field
    return {
      payload: { ...proposal.payload, text: editedText },
    };
  }

  // Legacy SuggestionItem: update the relevant field in patch
  const { action, patch = {} } = proposal;
  switch (action) {
    case 'append_bullet':
      return { patch: { ...patch, bullet: editedText } };
    case 'replace_bullet':
      return { patch: { ...patch, newText: editedText } };
    default:
      return { patch };
  }
}

/**
 * Format ISO date to short Korean locale (e.g., "3월 15일").
 * @param {string} iso
 * @returns {string}
 */
function formatLogDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('ko-KR', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/* ── Constants ──────────────────────────────────────────────────────────── */

/** Human-readable labels for each normalised operation type. */
const OP_LABELS = {
  add: '+ 추가 제안',
  replace: '교체 제안',
  delete: '삭제 제안',
};

/* ── CSS ─────────────────────────────────────────────────────────────────── */

/**
 * Styles for BulletProposalChip (.bpc-*).
 * Exported so consumers can inject into a single <style> block to avoid duplicates.
 */
export const BULLET_PROPOSAL_CSS = `
  /* ─── Chip shell ─── */
  .bpc {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    border: 1.5px dashed var(--line-strong);
    background: rgba(17, 24, 39, 0.02);
    margin-top: 4px;
    transition: opacity 0.15s;
    /* Prevent proposals from appearing in print view */
    print-color-adjust: exact;
  }

  @media print {
    .bpc { display: none !important; }
  }

  .bpc--busy {
    opacity: 0.6;
    pointer-events: none;
  }

  .bpc--editing {
    border-style: solid;
    border-color: var(--ink);
    background: rgba(17, 24, 39, 0.03);
  }

  /* Approved: brief green confirmation */
  .bpc--approved {
    border-style: solid;
    border-color: rgba(34, 197, 94, 0.4);
    background: rgba(34, 197, 94, 0.05);
    padding: 5px 10px;
  }

  /* Per-operation tint on left border */
  .bpc--add {
    border-left-color: rgba(37, 99, 235, 0.4);
  }

  .bpc--replace {
    border-left-color: rgba(217, 119, 6, 0.4);
  }

  .bpc--delete {
    border-left-color: rgba(220, 38, 38, 0.3);
  }

  /* ─── Header: badge + date ─── */
  .bpc-header {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .bpc-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 3px;
  }

  .bpc-badge--add {
    background: rgba(37, 99, 235, 0.1);
    color: #1d4ed8;
  }

  .bpc-badge--replace {
    background: rgba(217, 119, 6, 0.12);
    color: #92400e;
  }

  .bpc-badge--delete {
    background: rgba(220, 38, 38, 0.08);
    color: #b91c1c;
  }

  .bpc-date {
    font-size: 10px;
    color: var(--muted);
  }

  .bpc-source {
    font-size: 9px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    background: #e8f0fe;
    color: #1a56db;
    border: 1px solid #c3d3f9;
    letter-spacing: 0.04em;
  }

  /* ─── Text content ─── */
  .bpc-old-text {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.5;
    text-decoration: line-through;
    text-decoration-color: rgba(220, 38, 38, 0.5);
  }

  .bpc-old-label {
    font-weight: 600;
    text-decoration: none;
    display: inline;
  }

  .bpc-diff {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .bpc-diff-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 7px 9px;
    border-radius: 8px;
  }

  .bpc-diff-row--old {
    background: rgba(148, 163, 184, 0.09);
    border: 1px solid rgba(148, 163, 184, 0.18);
  }

  .bpc-diff-row--new {
    background: rgba(34, 197, 94, 0.08);
    border: 1px solid rgba(34, 197, 94, 0.16);
  }

  .bpc-diff-label {
    flex: 0 0 auto;
    min-width: 28px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  .bpc-diff-text {
    font-size: 12px;
    line-height: 1.55;
    color: var(--ink);
    word-break: break-word;
  }

  .bpc-diff-text--old {
    color: var(--muted);
    text-decoration: line-through;
    text-decoration-color: rgba(220, 38, 38, 0.45);
  }

  .bpc-text {
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink);
    word-break: break-word;
  }

  /* ─── Inline edit textarea ─── */
  .bpc-edit-textarea {
    width: 100%;
    box-sizing: border-box;
    font-size: 12px;
    line-height: 1.6;
    padding: 5px 7px;
    border: 1px solid var(--line-strong);
    border-radius: 4px;
    background: #fff;
    color: var(--ink);
    resize: vertical;
    font-family: inherit;
  }

  .bpc-edit-textarea:focus {
    outline: none;
    border-color: var(--ink);
  }

  .bpc-edit-textarea:disabled {
    opacity: 0.6;
    background: var(--bg);
  }

  /* ─── Error ─── */
  .bpc-error {
    margin: 0;
    font-size: 11px;
    color: #dc2626;
    line-height: 1.4;
  }

  /* ─── Done message ─── */
  .bpc-done {
    font-size: 11px;
    font-weight: 600;
    color: #16a34a;
  }

  /* ─── Action buttons row ─── */
  .bpc-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .bpc-btn {
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 4px;
    cursor: pointer;
    transition: opacity 0.15s;
    white-space: nowrap;
    line-height: 1.4;
  }

  .bpc-btn:disabled {
    cursor: default;
    opacity: 0.5;
  }

  /* Approve — filled dark */
  .bpc-btn--approve {
    background: var(--ink);
    color: #fff;
    border: 1px solid transparent;
  }

  .bpc-btn--approve:hover:not(:disabled) {
    opacity: 0.82;
  }

  /* Edit — ghost */
  .bpc-btn--edit {
    background: rgba(17, 24, 39, 0.05);
    color: var(--ink);
    border: 1px solid var(--line-strong);
  }

  .bpc-btn--edit:hover:not(:disabled) {
    background: rgba(17, 24, 39, 0.1);
  }

  /* Reject — ghost muted */
  .bpc-btn--reject {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line);
  }

  .bpc-btn--reject:hover:not(:disabled) {
    opacity: 0.7;
  }

  /* Save — filled dark */
  .bpc-btn--save {
    background: var(--ink);
    color: #fff;
    border: 1px solid transparent;
  }

  .bpc-btn--save:hover:not(:disabled) {
    opacity: 0.82;
  }

  /* Cancel — ghost muted */
  .bpc-btn--cancel {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line);
  }

  .bpc-btn--cancel:hover:not(:disabled) {
    opacity: 0.7;
  }
`;
