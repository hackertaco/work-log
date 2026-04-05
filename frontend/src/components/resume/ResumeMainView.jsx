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
export function ResumeMainView({
  resume,
  onRefresh,
  onResumePatched,
  suggestions = [],
  onSuggestionResolved,
}) {
  const [mode, setMode] = useState('view'); // 'view' | 'edit'

  // ── Section bridges state ─────────────────────────────────────────────────
  const [sectionBridges, setSectionBridges] = useState([]);

  // ── Identified strengths state ────────────────────────────────────────────
  const [identifiedStrengths, setIdentifiedStrengths] = useState([]);
  const [narrativeAxes, setNarrativeAxes] = useState([]);
  const [threadingData, setThreadingData] = useState(null);

  // ── Coherence validation report state ───────────────────────────────────
  const [coherenceReport, setCoherenceReport] = useState(null);

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

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch analysis/supporting data on mount
  useEffect(() => {
    fetchSectionBridges();
    fetchIdentifiedStrengths();
    fetchNarrativeAxes();
    fetchThreadingData();
    fetchCoherenceReport();
  }, []);

  // Bullet-level action types for legacy SuggestionItem format
  const BULLET_LEGACY_ACTIONS = ['append_bullet', 'replace_bullet', 'delete_bullet'];

  // Filter to pending, bullet-level proposals not yet acted on locally.
  // Supports both:
  //   - Legacy SuggestionItem: { action: 'append_bullet'|'replace_bullet'|'delete_bullet', ... }
  //   - New BulletProposal:    { kind: 'bullet', op: 'add'|'replace'|'delete', ... }
  const bulletProposals = suggestions.filter(
    (p) =>
      p.status === 'pending' &&
      (p.kind === 'bullet' || BULLET_LEGACY_ACTIONS.includes(p.action)),
  );

  // ── Callbacks from BulletProposalChip ────────────────────────────────────

  /** Called when a bullet proposal is approved. */
  function handleProposalApproved(id) {
    onSuggestionResolved?.(id, 'approved');
    onRefresh?.();
    setTimeout(() => {
      fetchThreadingData();
      fetchCoherenceReport();
    }, 800);
  }

  /** Called when a bullet proposal is rejected. */
  function handleProposalRejected(id) {
    onSuggestionResolved?.(id, 'rejected');
  }

  // ── Section bridges ──────────────────────────────────────────────────────

  async function fetchSectionBridges() {
    try {
      const res = await fetch('/api/resume/section-bridges', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        setSectionBridges(data.bridges ?? []);
      }
    } catch {
      // Non-critical: bridges simply won't show if fetch fails
    }
  }

  // ── Identified strengths ─────────────────────────────────────────────────

  async function fetchIdentifiedStrengths() {
    try {
      const res = await fetch('/api/resume/identified-strengths', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        setIdentifiedStrengths(Array.isArray(data.strengths) ? data.strengths : []);
      }
    } catch {
      // Non-critical: strengths section simply won't show if fetch fails
    }
  }

  async function fetchNarrativeAxes() {
    try {
      const res = await fetch('/api/resume/narrative-axes', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        setNarrativeAxes(Array.isArray(data.axes) ? data.axes : []);
      }
    } catch {
      // Non-critical: project view can still render without axis labels
    }
  }

  async function fetchThreadingData() {
    try {
      const res = await fetch('/api/resume/narrative-threading', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        setThreadingData(data?.ok === false ? null : data);
      }
    } catch {
      // Non-critical: project view can still render without threading annotations
    }
  }

  // ── Coherence validation report ───────────────────────────────────────────

  async function fetchCoherenceReport() {
    try {
      const res = await fetch('/api/resume/coherence-validation', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current && data.ok) {
        setCoherenceReport({
          overallScore: data.overallScore,
          grade: data.grade,
          structuralFlow: data.structuralFlow,
          redundancy: data.redundancy,
          tonalConsistency: data.tonalConsistency,
          issues: data.issues ?? [],
          autoFixes: data.autoFixes ?? [],
        });
      }
    } catch {
      // Non-critical: coherence badge simply won't show if fetch fails
    }
  }

  /** Edit a bridge's text — marks it as user-edited server-side. */
  async function handleBridgeEdit(from, to, text) {
    const res = await fetch(`/api/resume/section-bridges/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      // Optimistically update local state
      setSectionBridges((prev) => {
        const idx = prev.findIndex((b) => b.from === from && b.to === to);
        const updated = { from, to, text, _source: 'user' };
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updated;
          return next;
        }
        return [...prev, updated];
      });
    }
  }

  /** Dismiss (delete) a bridge — user doesn't want this transition. */
  async function handleBridgeDismiss(from, to) {
    const res = await fetch(`/api/resume/section-bridges/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (res.ok) {
      setSectionBridges((prev) => prev.filter((b) => !(b.from === from && b.to === to)));
    }
  }

  function enterEdit() {
    setMode('edit');
  }

  function handleSaved(updatedResume) {
    setMode('view');
    if (updatedResume && onResumePatched) {
      onResumePatched(updatedResume);
    } else {
      onRefresh?.();
    }
  }

  function handleCancel() {
    setMode('view');
  }

  return (
    <div class="rmv-root">
      {mode === 'view' && (
        <>
          {/* 툴바: 편집 화면 안내 + 분석 이동 */}
          <div class="rmv-toolbar">
            <div class="rmv-context">
              <span class="rmv-context-kicker">Resume Editor</span>
              <h2 class="rmv-context-title">이력서 본문과 제안 승인에 집중합니다.</h2>
            </div>

            <div class="rmv-toolbar-actions">
              <button
                class="rmv-edit-btn"
                type="button"
                onClick={enterEdit}
              >
                이력서 편집
              </button>
            </div>
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
            threadingData={threadingData}
            strengths={identifiedStrengths}
            narrativeAxes={narrativeAxes}
            sectionBridges={sectionBridges}
            onBridgeEdit={handleBridgeEdit}
            onBridgeDismiss={handleBridgeDismiss}
            coherenceReport={coherenceReport}
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

  /* ─── 툴바: 편집 화면 안내 + 액션 ─── */
  .rmv-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
  }

  .rmv-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .rmv-context {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .rmv-context-kicker {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .rmv-context-title {
    margin: 0;
    font-size: 18px;
    line-height: 1.3;
    color: var(--ink);
  }

  .rmv-analysis-link,
  .rmv-edit-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-md);
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    text-decoration: none;
  }

  .rmv-analysis-link:hover,
  .rmv-edit-btn:hover {
    color: var(--ink);
    border-color: var(--ink);
    background: var(--surface);
  }

  /* ─── 인쇄 시 툴바 숨김 ─── */
  @media print {
    .rmv-toolbar {
      display: none;
    }
  }

  @media (max-width: 900px) {
    .rmv-toolbar {
      flex-direction: column;
      align-items: flex-start;
    }

    .rmv-toolbar-actions {
      width: 100%;
      flex-wrap: wrap;
      justify-content: flex-start;
    }
  }
`;
