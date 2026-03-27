import { useState, useEffect, useRef } from 'preact/hooks';
import { ResumeBody } from './ResumeBody.jsx';
import { ResumeEditor } from './ResumeEditor.jsx';
import { useResumeActions } from '../../hooks/useResumeActions.js';

/**
 * ResumeMainView
 *
 * 이력서 본문 영역 컴포넌트.
 * 보기(view) 모드와 편집(edit) 모드를 토글한다.
 *
 * 모드 전환:
 *   - 보기 모드: <ResumeBody> 렌더링 + "편집" 버튼 표시
 *   - 편집 모드: <ResumeEditor> 렌더링 (저장/취소 버튼 내장)
 *
 * 불릿 단위 제안 인라인 표시:
 *   - GET /api/resume/suggestions 에서 pending 제안을 가져와
 *     action이 'append_bullet' | 'replace_bullet' | 'delete_bullet'인 것만
 *     ResumeBody 에 bulletProposals 로 전달한다.
 *   - 승인·제외 후 resume과 proposals를 동시에 갱신한다.
 *   - proposals 패널(SuggestionPanel)은 별도로 오른쪽 패널에 존재하며,
 *     이 inline view는 그것과 독립적으로 동작한다.
 *
 * 2-column 레이아웃은 상위 ResumeLayout 이 담당한다.
 *
 * props:
 *   resume          — GET /api/resume 응답에서 꺼낸 resume 문서 객체
 *   onRefresh       — 이력서 재조회 콜백 (편집 저장 완료 후 호출)
 *   onResumePatched — (선택) API 응답 resume 객체로 로컬 상태 즉시 갱신 콜백.
 *                     제공 시 bullet 추가/편집/삭제 후 GET 재조회를 생략하고
 *                     응답 resume으로 직접 상태를 갱신한다.
 */
export function ResumeMainView({ resume, onRefresh, onResumePatched }) {
  const [mode, setMode] = useState('view'); // 'view' | 'edit'

  // ── Bullet action handlers (Sub-AC 8-3) ───────────────────────────────────
  /**
   * useResumeActions provides addBullet / editBullet / deleteBullet.
   * Each handler calls the corresponding API endpoint and immediately updates
   * the top-level resume state via onResumePatched, bypassing a full re-fetch.
   * Falls back to onRefresh when the server response lacks a resume object.
   */
  const { addBullet, editBullet, deleteBullet } = useResumeActions({
    onResumePatch: onResumePatched,
    onFallbackRefresh: onRefresh,
  });

  // ── Bullet-level proposals state ─────────────────────────────────────────
  /** @type {[object[], function]} */
  const [proposals, setProposals] = useState([]);
  /** @type {[Set<string>, function]} */
  const [removedProposalIds, setRemovedProposalIds] = useState(() => new Set());

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch bullet-level proposals on mount and when resume changes
  useEffect(() => {
    fetchBulletProposals();
  }, []);

  async function fetchBulletProposals() {
    try {
      const res = await fetch('/api/resume/suggestions', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        setProposals(data.suggestions ?? []);
        setRemovedProposalIds(new Set());
      }
    } catch {
      // Non-critical: inline proposals simply won't show if fetch fails
    }
  }

  // Bullet-level action types for legacy SuggestionItem format
  const BULLET_LEGACY_ACTIONS = ['append_bullet', 'replace_bullet', 'delete_bullet'];

  // Filter to pending, bullet-level proposals not yet acted on locally.
  // Supports both:
  //   - Legacy SuggestionItem: { action: 'append_bullet'|'replace_bullet'|'delete_bullet', ... }
  //   - New BulletProposal:    { kind: 'bullet', op: 'add'|'replace'|'delete', ... }
  const bulletProposals = proposals.filter(
    (p) =>
      p.status === 'pending' &&
      !removedProposalIds.has(p.id) &&
      (p.kind === 'bullet' || BULLET_LEGACY_ACTIONS.includes(p.action)),
  );

  // ── Callbacks from BulletProposalChip ────────────────────────────────────

  /** Called when a bullet proposal is approved. */
  function handleProposalApproved(id) {
    if (!mountedRef.current) return;
    setRemovedProposalIds((prev) => new Set([...prev, id]));
    // Re-fetch resume (server has applied the patch)
    onRefresh?.();
    // Re-fetch proposals to sync state with server
    // Use a short delay to let the server finish writing
    setTimeout(fetchBulletProposals, 800);
  }

  /** Called when a bullet proposal is rejected. */
  function handleProposalRejected(id) {
    if (!mountedRef.current) return;
    setRemovedProposalIds((prev) => new Set([...prev, id]));
  }

  function enterEdit() {
    setMode('edit');
  }

  function handleSaved() {
    setMode('view');
    onRefresh?.();
  }

  function handleCancel() {
    setMode('view');
  }

  return (
    <div class="rmv-root">
      {mode === 'view' && (
        <>
          {/* 편집 진입 버튼 */}
          <div class="rmv-toolbar">
            <button
              class="rmv-edit-btn"
              type="button"
              onClick={enterEdit}
            >
              이력서 편집
            </button>
          </div>
          <ResumeBody
            resume={resume}
            onBulletAdded={onRefresh}
            onBulletAdd={addBullet}
            onBulletEdit={editBullet}
            onBulletDelete={deleteBullet}
            bulletProposals={bulletProposals}
            onProposalApproved={handleProposalApproved}
            onProposalRejected={handleProposalRejected}
            onResumeUpdated={onRefresh}
          />
        </>
      )}

      {mode === 'edit' && (
        <ResumeEditor
          resume={resume}
          onSaved={handleSaved}
          onCancel={handleCancel}
        />
      )}

      <style>{RMV_CSS}</style>
    </div>
  );
}

const RMV_CSS = `
  .rmv-root {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* ─── 편집 버튼 툴바 ─── */
  .rmv-toolbar {
    display: flex;
    justify-content: flex-end;
  }

  .rmv-edit-btn {
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }

  .rmv-edit-btn:hover {
    color: var(--ink);
    border-color: var(--ink);
    background: var(--surface);
  }

  /* ─── 인쇄 시 편집 버튼 숨김 ─── */
  @media print {
    .rmv-toolbar {
      display: none;
    }
  }
`;
