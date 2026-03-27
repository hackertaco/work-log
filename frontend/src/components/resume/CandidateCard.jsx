import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * CandidateCard — 이력서 갱신 후보 카드 (자체 상태 관리)
 *
 * 각 제안(suggestion)을 카드로 표시하며 승인·제외·인라인 편집 기능을 제공한다.
 * 카드 레벨에서 로컬 상태(pending/approved/discarded)를 직접 관리하며
 * 낙관적 UI(optimistic update)로 즉시 상태를 반영한다.
 *
 * 승인 시 API 응답에 포함된 resume 객체를 onResumePatched로 직접 주입해
 * 추가 GET 요청 없이 이력서 본문을 즉시 갱신한다(낙관적 업데이트).
 * resume 응답이 없을 경우 onResumeUpdated 폴백으로 전체 재조회한다.
 *
 * API 호출:
 *   POST  /api/resume/suggestions/:id/approve  — 승인 (응답에 resume 포함)
 *   POST  /api/resume/suggestions/:id/reject   — 제외
 *   PATCH /api/resume/suggestions/:id          — 인라인 편집 저장
 *
 * @param {{
 *   suggestion:        SuggestionItem,
 *   onApproved?:       (id: string) => void,
 *   onDiscarded?:      (id: string) => void,
 *   onResumePatched?:  (resume: object) => void,
 *   onResumeUpdated?:  () => void,
 * }} props
 */
export function CandidateCard({ suggestion, onApproved, onDiscarded, onResumePatched, onResumeUpdated }) {
  const { id, section, action, description, detail, source, logDate, patch } = suggestion;

  // ── Local status — drives optimistic UI ──────────────────────────────────
  /** @type {'pending'|'approved'|'discarded'} */
  const [localStatus, setLocalStatus] = useState('pending');

  // Which action is currently in-flight (null = idle)
  /** @type {null|'approving'|'discarding'|'saving'} */
  const [loadingAction, setLoadingAction] = useState(null);

  // ── Edit-mode state ───────────────────────────────────────────────────────
  const [isEditing, setIsEditing] = useState(false);
  // Primary textarea content — action-specific text extracted from patch
  const [editText, setEditText] = useState(() => extractPrimaryText(action, patch));
  // Editable card description (optional override)
  const [editDesc, setEditDesc] = useState(description ?? '');
  // Currently displayed description (updated on successful save)
  const [displayDesc, setDisplayDesc] = useState(description ?? '');

  const [error, setError] = useState(/** @type {string|null} */ (null));

  // Guard against state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Approve ───────────────────────────────────────────────────────────────
  async function handleApprove() {
    if (loadingAction || localStatus !== 'pending') return;
    // Optimistic: show approved state immediately (badge appears before API returns)
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
      // API returns { ok: true, resume: updatedDocument }.
      // Inject the returned resume directly into parent state (onResumePatched)
      // to avoid an extra GET /api/resume round-trip and eliminate the loading flash.
      // Fall back to onResumeUpdated (full refetch) only when resume is absent.
      const data = await res.json().catch(() => ({}));
      if (mountedRef.current) {
        if (data.resume && onResumePatched) {
          onResumePatched(data.resume); // optimistic: direct state injection
        } else {
          onResumeUpdated?.();          // fallback: full refetch
        }
        onApproved?.(id); // prompt parent to remove card from list
      }
    } catch (err) {
      // Revert optimistic update on failure
      if (mountedRef.current) {
        setLocalStatus('pending');
        setError(`승인 실패: ${err.message}`);
      }
    } finally {
      if (mountedRef.current) setLoadingAction(null);
    }
  }

  // ── Discard ───────────────────────────────────────────────────────────────
  async function handleDiscard() {
    if (loadingAction || localStatus !== 'pending') return;
    // Optimistic: show discarded state immediately
    setLocalStatus('discarded');
    setLoadingAction('discarding');
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
        onDiscarded?.(id); // prompt parent to remove card from list
      }
    } catch (err) {
      // Revert optimistic update
      if (mountedRef.current) {
        setLocalStatus('pending');
        setError(`제외 실패: ${err.message}`);
      }
    } finally {
      if (mountedRef.current) setLoadingAction(null);
    }
  }

  // ── Save inline edit ──────────────────────────────────────────────────────
  async function handleSaveEdit() {
    if (loadingAction) return;
    setLoadingAction('saving');
    setError(null);
    try {
      const newPatch = buildEditedPatch(action, patch, editText);
      const reqBody = { patch: newPatch };
      const trimmedDesc = editDesc.trim();
      if (trimmedDesc && trimmedDesc !== displayDesc) {
        reqBody.description = trimmedDesc;
      }
      const res = await fetch(`/api/resume/suggestions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });
      if (!res.ok) {
        const bd = await res.json().catch(() => ({}));
        throw new Error(bd.error || `HTTP ${res.status}`);
      }
      if (mountedRef.current) {
        // Reflect saved description in view mode
        if (trimmedDesc) setDisplayDesc(trimmedDesc);
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
    // Re-initialise draft from current patch when entering edit mode
    setEditText(extractPrimaryText(action, patch));
    setEditDesc(displayDesc);
    setIsEditing(true);
    setError(null);
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setError(null);
  }

  const busy = loadingAction !== null;

  // ── Approved state — inline status badge + description preview ───────────
  // Shown optimistically as soon as the user clicks "승인"; persists until
  // the parent removes the card from the visible list (via onApproved callback).
  if (localStatus === 'approved') {
    return (
      <li class="cc-card cc-card--approved" aria-live="polite" aria-label="승인된 제안">
        <div class="cc-meta">
          <span class="cc-badge">{SECTION_LABELS[section] ?? section}</span>
          <span class="cc-status-badge cc-status-badge--approved">✓ 승인됨</span>
        </div>
        <p class="cc-desc cc-desc--faded">{displayDesc}</p>
      </li>
    );
  }

  // ── Discarded state — inline status badge + description preview ───────────
  // Shown optimistically as soon as the user clicks "제외"; persists until
  // the parent removes the card from the visible list (via onDiscarded callback).
  if (localStatus === 'discarded') {
    return (
      <li class="cc-card cc-card--discarded" aria-live="polite" aria-label="제외된 제안">
        <div class="cc-meta">
          <span class="cc-badge">{SECTION_LABELS[section] ?? section}</span>
          <span class="cc-status-badge cc-status-badge--discarded">제외됨</span>
        </div>
        <p class="cc-desc cc-desc--faded">{displayDesc}</p>
      </li>
    );
  }

  // ── Pending state (default view) ─────────────────────────────────────────
  const cardClass = [
    'cc-card',
    busy ? 'cc-card--busy' : '',
    isEditing ? 'cc-card--editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li class={cardClass} aria-live="polite">
      {/* ── Badges ── */}
      <div class="cc-meta">
        <span class="cc-badge">{SECTION_LABELS[section] ?? section}</span>
        {source === 'work_log' && logDate && (
          <span class="cc-log-date">{formatLogDate(logDate)}</span>
        )}
        {source === 'linkedin' && (
          <span class="cc-source-badge cc-source-badge--linkedin">LinkedIn</span>
        )}
        {source === 'manual' && (
          <span class="cc-source-badge cc-source-badge--manual">수동</span>
        )}
      </div>

      {/* ── View mode: description + detail ── */}
      {/* Clicking the description text enters inline edit mode (텍스트 클릭→편집 모드) */}
      {!isEditing && (
        <p
          class={`cc-desc${!busy ? ' cc-desc--editable' : ''}`}
          onClick={!busy ? handleStartEdit : undefined}
          role={!busy ? 'button' : undefined}
          tabIndex={!busy ? 0 : undefined}
          onKeyDown={!busy ? (e) => e.key === 'Enter' && handleStartEdit() : undefined}
          title={!busy ? '클릭하여 편집' : undefined}
          aria-label={!busy ? `${displayDesc} (클릭하여 편집)` : undefined}
        >
          {displayDesc}
        </p>
      )}
      {!isEditing && detail && <p class="cc-detail">{detail}</p>}

      {/* ── Error (API failure, shows after optimistic revert) ── */}
      {error && (
        <p class="cc-error" role="alert">
          {error}
        </p>
      )}

      {/* ── Inline edit form: textarea toggle ── */}
      {isEditing && (
        <div class="cc-edit-form">
          {/* Primary textarea (the "textarea 토글" element) */}
          <div class="cc-edit-field">
            <label class="cc-edit-label">
              {PRIMARY_TEXT_LABELS[action] ?? '내용'}
            </label>
            <textarea
              class="cc-edit-textarea"
              rows={primaryTextRows(action)}
              value={editText}
              onInput={(e) => setEditText(e.target.value)}
              placeholder={PRIMARY_TEXT_PLACEHOLDERS[action] ?? '내용을 입력하세요'}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
            />
          </div>

          {/* Optional description override */}
          <div class="cc-edit-field">
            <label class="cc-edit-label">설명 (선택)</label>
            <input
              class="cc-edit-input"
              type="text"
              value={editDesc}
              onInput={(e) => setEditDesc(e.target.value)}
              placeholder="카드에 표시되는 설명"
            />
          </div>

          {/* Edit action row */}
          <div class="cc-edit-actions">
            <button
              class="cc-btn cc-btn--save"
              onClick={handleSaveEdit}
              disabled={busy}
              aria-busy={loadingAction === 'saving'}
            >
              {loadingAction === 'saving' ? '저장 중…' : '저장'}
            </button>
            <button
              class="cc-btn cc-btn--cancel"
              onClick={handleCancelEdit}
              disabled={busy}
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* ── Action buttons: ✓ 승인 / ✗ 제외 (hidden while editing) ── */}
      {/* Inline editing is triggered by clicking the description text above. */}
      {!isEditing && (
        <div class="cc-actions">
          <button
            class="cc-btn cc-btn--approve"
            onClick={handleApprove}
            disabled={busy}
            aria-busy={loadingAction === 'approving'}
            aria-label="제안 승인"
            title="이력서에 반영합니다"
          >
            {loadingAction === 'approving' ? '적용 중…' : '✓ 승인'}
          </button>
          <button
            class="cc-btn cc-btn--discard"
            onClick={handleDiscard}
            disabled={busy}
            aria-busy={loadingAction === 'discarding'}
            aria-label="제안 제외"
            title="이 제안을 제외합니다"
          >
            {loadingAction === 'discarding' ? '처리 중…' : '✗ 제외'}
          </button>
        </div>
      )}
    </li>
  );
}

/* ── extractPrimaryText ─────────────────────────────────────────────────── */

/**
 * Returns the main editable text for a given action type + patch.
 * Used to populate the textarea when edit mode is toggled on.
 *
 * @param {string} action
 * @param {object} patch
 * @returns {string}
 */
function extractPrimaryText(action, patch) {
  if (!patch || typeof patch !== 'object') return '';
  switch (action) {
    case 'update_summary':
      return patch.text ?? '';
    case 'append_bullet':
      return patch.bullet ?? '';
    case 'add_skills':
      return Array.isArray(patch.skills) ? patch.skills.join(', ') : '';
    case 'add_strength_keyword':
      return patch.keyword ?? '';
    case 'add_skill':
      return patch.skill ?? '';
    case 'update_field':
      return String(patch.value ?? '');
    case 'update_experience_title':
      return patch.value ?? '';
    case 'add_experience':
      return Array.isArray(patch.entry?.bullets)
        ? patch.entry.bullets.join('\n')
        : '';
    case 'add_education':
      return patch.entry?.institution ?? '';
    case 'add_certification':
      return patch.entry?.name ?? '';
    default:
      return '';
  }
}

/* ── buildEditedPatch ────────────────────────────────────────────────────── */

/**
 * Merges the edited textarea text back into the original patch.
 * Preserves all other fields in the original patch unchanged.
 *
 * @param {string} action
 * @param {object} originalPatch
 * @param {string} editText
 * @returns {object}
 */
function buildEditedPatch(action, originalPatch, editText) {
  const base = originalPatch ?? {};
  switch (action) {
    case 'update_summary':
      return { ...base, text: editText };

    case 'append_bullet':
      return { ...base, bullet: editText };

    case 'add_skills': {
      const skills = editText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return { ...base, skills };
    }

    case 'add_strength_keyword':
      return { ...base, keyword: editText.trim() };

    case 'add_skill':
      return { ...base, skill: editText.trim() };

    case 'update_field':
      return { ...base, value: editText };

    case 'update_experience_title':
      return { ...base, value: editText };

    case 'add_experience': {
      const bullets = editText
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean);
      return { ...base, entry: { ...(base.entry ?? {}), bullets } };
    }

    case 'add_education':
      return { ...base, entry: { ...(base.entry ?? {}), institution: editText } };

    case 'add_certification':
      return { ...base, entry: { ...(base.entry ?? {}), name: editText } };

    default:
      return base;
  }
}

/* ── primaryTextRows ────────────────────────────────────────────────────── */

function primaryTextRows(action) {
  switch (action) {
    case 'update_summary':
      return 5;
    case 'add_experience':
      return 4;
    case 'append_bullet':
    case 'add_skills':
      return 3;
    default:
      return 2;
  }
}

/* ── Constants ──────────────────────────────────────────────────────────── */

/** @type {Record<string, string>} */
export const SECTION_LABELS = {
  summary: '개요',
  experience: '경력',
  skills: '기술',
  projects: '프로젝트',
  education: '학력',
  certifications: '자격증',
  contact: '연락처',
};

/** @type {Record<string, string>} */
const PRIMARY_TEXT_LABELS = {
  update_summary: '개요 텍스트',
  append_bullet: '불릿 내용',
  add_skills: '기술 목록 (쉼표로 구분)',
  add_strength_keyword: '강점 키워드',
  add_skill: '기술 이름',
  update_field: '값',
  update_experience_title: '새 직함',
  add_experience: '주요 불릿 (줄바꿈으로 구분)',
  add_education: '학교명',
  add_certification: '자격증명',
};

/** @type {Record<string, string>} */
const PRIMARY_TEXT_PLACEHOLDERS = {
  update_summary: '이력서 개요 내용을 입력하세요',
  append_bullet: '추가할 경력 불릿 내용',
  add_skills: 'React, TypeScript, Node.js',
  add_strength_keyword: '강점 키워드 입력',
  add_skill: '기술 이름',
  update_field: '새 값',
  update_experience_title: '새 직함 입력',
  add_experience: '주요 성과나 업무를 한 줄씩 입력',
  add_education: '대학교명',
  add_certification: '자격증 이름',
};

/* ── formatLogDate ──────────────────────────────────────────────────────── */

/**
 * Format an ISO date string to a short Korean locale string.
 * @param {string} iso
 * @returns {string}
 */
export function formatLogDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/* ── initDraft / buildPatch — exported for SuggestionPanel compatibility ── */

/**
 * Initialise a flat draft object from the suggestion's current patch.
 * Used by the legacy SuggestionPanel edit flow (multi-field form).
 *
 * @param {string} action
 * @param {object} patch
 * @returns {object}
 */
export function initDraft(action, patch) {
  if (!patch || typeof patch !== 'object') return {};

  switch (action) {
    case 'update_summary':
      return { text: patch.text ?? '' };

    case 'append_bullet':
      return { company: patch.company ?? '', bullet: patch.bullet ?? '' };

    case 'add_skills':
      return { skills: Array.isArray(patch.skills) ? [...patch.skills] : [] };

    case 'update_field':
      return {
        section: patch.section ?? '',
        field: patch.field ?? '',
        value: patch.value ?? '',
      };

    case 'add_experience':
      return {
        entry: {
          company: patch.entry?.company ?? '',
          title: patch.entry?.title ?? '',
          start_date: patch.entry?.start_date ?? null,
          end_date: patch.entry?.end_date ?? null,
          location: patch.entry?.location ?? null,
          bullets: Array.isArray(patch.entry?.bullets) ? [...patch.entry.bullets] : [],
        },
      };

    case 'add_education':
      return {
        entry: {
          institution: patch.entry?.institution ?? '',
          degree: patch.entry?.degree ?? null,
          field: patch.entry?.field ?? null,
          start_date: patch.entry?.start_date ?? null,
          end_date: patch.entry?.end_date ?? null,
          gpa: patch.entry?.gpa ?? null,
        },
      };

    case 'update_experience_title':
      return {
        company: patch.company ?? '',
        field: patch.field ?? 'title',
        value: patch.value ?? '',
        previousValue: patch.previousValue ?? null,
      };

    case 'add_certification':
      return {
        entry: {
          name: patch.entry?.name ?? '',
          issuer: patch.entry?.issuer ?? null,
          date: patch.entry?.date ?? null,
        },
      };

    case 'add_skill':
      return {
        skill: patch.skill ?? '',
        category: patch.category ?? 'technical',
      };

    case 'add_strength_keyword':
      return { keyword: patch.keyword ?? '' };

    default:
      return { ...patch };
  }
}

/**
 * Build the patch object from the local draft.
 * Returns null if validation fails (caller should guard).
 *
 * @param {string} action
 * @param {object} draft
 * @returns {object|null}
 */
export function buildPatch(action, draft) {
  switch (action) {
    case 'update_summary':
      return { text: draft.text ?? '' };

    case 'append_bullet':
      return { company: draft.company ?? '', bullet: draft.bullet ?? '' };

    case 'add_skills':
      return { skills: Array.isArray(draft.skills) ? draft.skills : [] };

    case 'update_field':
      return {
        section: draft.section ?? '',
        field: draft.field ?? '',
        value: draft.value ?? '',
      };

    case 'add_experience':
      return { entry: { ...draft.entry } };

    case 'add_education':
      return { entry: { ...draft.entry } };

    case 'update_experience_title':
      return {
        company: draft.company ?? '',
        field: 'title',
        value: draft.value ?? '',
        previousValue: draft.previousValue ?? null,
      };

    case 'add_certification':
      return { entry: { ...draft.entry } };

    case 'add_skill':
      return {
        skill: draft.skill ?? '',
        category: draft.category ?? 'technical',
      };

    case 'add_strength_keyword':
      return { keyword: draft.keyword ?? '' };

    default:
      return { ...draft };
  }
}

/* ── JSDoc type ─────────────────────────────────────────────────────────── */

/**
 * @typedef {{
 *   id: string,
 *   createdAt: string,
 *   status: 'pending'|'approved'|'rejected',
 *   section: string,
 *   action: string,
 *   description: string,
 *   detail?: string,
 *   patch: object,
 *   source: 'work_log'|'linkedin'|'manual',
 *   logDate?: string,
 * }} SuggestionItem
 */

/* ── CSS (injected by SuggestionPanel into the shared <style> block) ──────
 *
 * CandidateCard renders as <li> elements inside SuggestionPanel's <ul>.
 * The panel is responsible for injecting this CSS string to avoid duplicate
 * <style> elements from multiple card instances.
 */
export const CANDIDATE_CARD_CSS = `
  /* ─── Card shell ─── */
  .cc-card {
    background: rgba(17, 24, 39, 0.03);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    transition: opacity 0.2s;
    list-style: none;
  }

  .cc-card--busy {
    opacity: 0.6;
    pointer-events: none;
  }

  .cc-card--editing {
    border-color: var(--ink);
    background: rgba(17, 24, 39, 0.05);
  }

  /* Approved: subtle green tint while server confirms */
  .cc-card--approved {
    background: rgba(34, 197, 94, 0.06);
    border-color: rgba(34, 197, 94, 0.3);
    padding: var(--space-2) var(--space-3);
  }

  /* Discarded: faded while server confirms */
  .cc-card--discarded {
    opacity: 0.4;
    padding: var(--space-2) var(--space-3);
  }

  /* ─── Badges ─── */
  .cc-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .cc-badge {
    padding: 2px 7px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: rgba(17, 24, 39, 0.08);
    border-radius: var(--radius-sm);
    color: var(--ink);
  }

  .cc-log-date {
    font-size: 10px;
    color: var(--muted);
  }

  .cc-source-badge {
    padding: 2px 6px;
    font-size: 10px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    letter-spacing: 0.04em;
  }

  .cc-source-badge--linkedin {
    background: #e8f0fe;
    color: #1a56db;
    border: 1px solid #c3d3f9;
  }

  .cc-source-badge--manual {
    background: rgba(17, 24, 39, 0.07);
    color: var(--ink);
    border: 1px solid var(--line-strong);
  }

  /* ─── Text content ─── */
  .cc-desc {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink);
  }

  /* Clickable description text —텍스트 클릭→편집 모드 */
  .cc-desc--editable {
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background 0.12s, color 0.12s;
    padding: 1px 2px;
    margin: 0 -2px;
  }

  .cc-desc--editable:hover {
    background: rgba(17, 24, 39, 0.06);
    text-decoration: underline;
    text-decoration-color: var(--muted);
    text-underline-offset: 2px;
  }

  .cc-desc--editable:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }

  .cc-detail {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
    word-break: break-word;
  }

  .cc-error {
    margin: 0;
    font-size: 11px;
    color: #e53e3e;
    line-height: 1.5;
  }

  /* ─── Status badges (pending/approved/discarded inline indicator) ─── */
  /* Displayed in the .cc-meta row alongside the section badge.           */
  /* 'pending' is the default state — no explicit badge (no visual noise) */
  .cc-status-badge {
    padding: 2px 7px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    border-radius: var(--radius-sm);
    line-height: 1.4;
  }

  /* Approved: green fill */
  .cc-status-badge--approved {
    background: rgba(34, 197, 94, 0.15);
    color: #15803d;
    border: 1px solid rgba(34, 197, 94, 0.35);
  }

  /* Discarded: muted grey */
  .cc-status-badge--discarded {
    background: rgba(17, 24, 39, 0.06);
    color: var(--muted);
    border: 1px solid var(--line-strong);
  }

  /* Faded description text in approved/discarded transition states */
  .cc-desc--faded {
    opacity: 0.55;
  }

  /* ─── Action buttons row ─── */
  .cc-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: 2px;
  }

  .cc-btn {
    flex: 1;
    padding: 5px 8px;
    font-size: 12px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity 0.15s;
    white-space: nowrap;
  }

  .cc-btn:disabled {
    cursor: default;
    opacity: 0.55;
  }

  /* Approve — filled dark */
  .cc-btn--approve {
    background: var(--ink);
    color: #fff;
    border: 1px solid transparent;
  }

  .cc-btn--approve:hover:not(:disabled) {
    opacity: 0.82;
  }

  /* Discard — ghost */
  .cc-btn--discard {
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    border: 1px solid var(--line-strong);
  }

  .cc-btn--discard:hover:not(:disabled) {
    opacity: 0.7;
  }

  /* ─── Inline edit form ─── */
  .cc-edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .cc-edit-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cc-edit-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .cc-edit-input {
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.5;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: #fff;
    color: var(--ink);
    width: 100%;
    box-sizing: border-box;
  }

  .cc-edit-input:focus {
    outline: none;
    border-color: var(--ink);
  }

  /* The primary textarea (the "textarea 토글" element) */
  .cc-edit-textarea {
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.6;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    background: #fff;
    color: var(--ink);
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font-family: inherit;
  }

  .cc-edit-textarea:focus {
    outline: none;
    border-color: var(--ink);
  }

  .cc-edit-actions {
    display: flex;
    gap: var(--space-2);
  }

  /* Save — filled dark */
  .cc-btn--save {
    background: var(--ink);
    color: #fff;
    border: 1px solid transparent;
    flex: 1;
  }

  .cc-btn--save:hover:not(:disabled) {
    opacity: 0.82;
  }

  /* Cancel — ghost */
  .cc-btn--cancel {
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    border: 1px solid var(--line-strong);
    flex: 1;
  }

  .cc-btn--cancel:hover:not(:disabled) {
    opacity: 0.7;
  }
`;
