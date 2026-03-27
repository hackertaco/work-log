/**
 * KeywordMovePanel
 *
 * 키워드 이동 패널 컴포넌트.
 *
 * 현재 이력서에 설정된 Display Axes 또는 Keyword Cluster Axes를 나타내며,
 * 사용자가 특정 축의 키워드를 다른 축으로 옮길 수 있는 UI를 제공한다.
 *
 * 지원하는 이동 방식:
 *   1. 셀렉트 UI  — 키워드 chip을 클릭하면 "이동 대상" 드롭다운이 나타남
 *   2. 드래그&드롭 — HTML5 Drag and Drop API로 키워드 chip을 원하는 축 카드로 드래그
 *
 * Props:
 *   axisType  — "display" | "keyword"   어느 축 저장소를 사용할지 (default: "display")
 *   onChanged — () => void              이동 성공 후 부모에 알리는 콜백 (선택)
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchAxes(axisType) {
  const url = axisType === 'keyword'
    ? '/api/resume/keyword-axes'
    : '/api/resume/axes';
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // display axes: { axes: [] }
  // keyword axes: { exists: bool, axes: [] | null }
  return Array.isArray(data.axes) ? data.axes : [];
}

async function moveKeyword({ keyword, toAxisId, fromAxisId, axisType }) {
  const encoded = encodeURIComponent(keyword);
  const res = await fetch(`/api/resume/keywords/${encoded}/move`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toAxisId, fromAxisId, axisType })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ─── Sub-component: KeywordChip ───────────────────────────────────────────────

/**
 * 키워드 chip 하나를 렌더링한다.
 * 클릭하면 이동 팝오버(select UI)가 나타나고,
 * 드래그 시작 시 drag state를 설정한다.
 */
function KeywordChip({
  keyword,
  axisId,
  allAxes,
  axisType,
  onMoveStart,    // (keyword, fromAxisId) → void
  onMoveSuccess,  // (updatedAxes) → void
  onError         // (msg) → void
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const popoverRef = useRef(null);

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return;
    function handleClick(e) {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [popoverOpen]);

  async function handleMoveTo(toAxisId) {
    setPopoverOpen(false);
    setMoving(true);
    try {
      const result = await moveKeyword({ keyword, toAxisId, fromAxisId: axisId, axisType });
      onMoveSuccess(result.axes);
    } catch (err) {
      onError(err.message);
    } finally {
      setMoving(false);
    }
  }

  const otherAxes = allAxes.filter((a) => a.id !== axisId);

  return (
    <span class="kmp-chip-wrap" ref={popoverRef}>
      <span
        class={`kmp-chip${moving ? ' kmp-chip--moving' : ''}`}
        draggable={!moving}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', JSON.stringify({ keyword, fromAxisId: axisId }));
          e.dataTransfer.effectAllowed = 'move';
          onMoveStart(keyword, axisId);
        }}
        onClick={() => !moving && setPopoverOpen((v) => !v)}
        title="클릭: 이동 대상 선택 / 드래그: 다른 축으로 이동"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && !moving && setPopoverOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={popoverOpen}
      >
        {moving ? '⏳' : keyword}
      </span>

      {popoverOpen && otherAxes.length > 0 && (
        <div class="kmp-popover" role="listbox" aria-label="이동 대상 축 선택">
          <p class="kmp-popover-label">이동할 축 선택</p>
          {otherAxes.map((axis) => (
            <button
              key={axis.id}
              class="kmp-popover-item"
              type="button"
              role="option"
              onClick={() => handleMoveTo(axis.id)}
            >
              {axis.label}
            </button>
          ))}
        </div>
      )}

      {popoverOpen && otherAxes.length === 0 && (
        <div class="kmp-popover" role="status">
          <p class="kmp-popover-label">이동 가능한 다른 축이 없습니다.</p>
        </div>
      )}
    </span>
  );
}

// ─── Sub-component: AxisCard ──────────────────────────────────────────────────

/**
 * 하나의 축(Axis)을 카드 형태로 렌더링한다.
 * 드롭 대상으로 동작한다.
 */
function AxisCard({
  axis,
  allAxes,
  axisType,
  draggingKeyword,  // { keyword, fromAxisId } | null
  onMoveStart,
  onMoveSuccess,
  onError
}) {
  const [dragOver, setDragOver] = useState(false);

  function handleDragOver(e) {
    // Accept drops only when a keyword from a different axis is being dragged
    if (draggingKeyword && draggingKeyword.fromAxisId !== axis.id) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOver(true);
    }
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  async function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    let payload;
    try {
      payload = JSON.parse(e.dataTransfer.getData('text/plain'));
    } catch {
      return;
    }
    const { keyword, fromAxisId } = payload;
    if (!keyword || fromAxisId === axis.id) return;

    try {
      const result = await moveKeyword({ keyword, toAxisId: axis.id, fromAxisId, axisType });
      onMoveSuccess(result.axes);
    } catch (err) {
      onError(err.message);
    }
  }

  const isEmpty = !axis.keywords || axis.keywords.length === 0;

  return (
    <div
      class={`kmp-axis-card${dragOver ? ' kmp-axis-card--dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label={`축: ${axis.label}`}
    >
      <div class="kmp-axis-header">
        <span class="kmp-axis-label">{axis.label}</span>
        <span class="kmp-axis-count">
          {axis.keywords?.length ?? 0}개
        </span>
      </div>

      <div class="kmp-chip-list">
        {isEmpty ? (
          <span class="kmp-empty-hint">키워드 없음</span>
        ) : (
          axis.keywords.map((kw) => (
            <KeywordChip
              key={kw}
              keyword={kw}
              axisId={axis.id}
              allAxes={allAxes}
              axisType={axisType}
              onMoveStart={onMoveStart}
              onMoveSuccess={onMoveSuccess}
              onError={onError}
            />
          ))
        )}
        {/* Drop zone hint when dragging over */}
        {dragOver && (
          <span class="kmp-drop-hint" aria-hidden="true">
            여기에 드롭
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main component: KeywordMovePanel ─────────────────────────────────────────

export function KeywordMovePanel({ axisType = 'display', onChanged }) {
  const [axes, setAxes] = useState(null);       // null = loading, [] = empty
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(null); // { keyword, fromAxisId }
  const [successMsg, setSuccessMsg] = useState(null);

  // Load axes on mount and when axisType changes
  useEffect(() => {
    let cancelled = false;
    setAxes(null);
    setError(null);
    fetchAxes(axisType)
      .then((data) => { if (!cancelled) setAxes(data); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [axisType]);

  const handleMoveStart = useCallback((keyword, fromAxisId) => {
    setDragging({ keyword, fromAxisId });
  }, []);

  const handleMoveSuccess = useCallback((updatedAxes) => {
    setAxes(updatedAxes);
    setDragging(null);
    setSuccessMsg('키워드를 이동했습니다.');
    onChanged?.();
    setTimeout(() => setSuccessMsg(null), 2500);
  }, [onChanged]);

  const handleError = useCallback((msg) => {
    setError(msg);
    setDragging(null);
  }, []);

  // Clear drag state when drag ends (also covers drop outside valid target)
  function handleDragEnd() {
    setDragging(null);
  }

  if (axes === null) {
    return (
      <div class="kmp-root">
        <p class="kmp-loading">축 목록 불러오는 중…</p>
        <style>{KMP_CSS}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div class="kmp-root">
        <p class="kmp-error" role="alert">오류: {error}</p>
        <button
          class="kmp-retry-btn"
          type="button"
          onClick={() => {
            setError(null);
            setAxes(null);
            fetchAxes(axisType).then(setAxes).catch((e) => setError(e.message));
          }}
        >
          다시 시도
        </button>
        <style>{KMP_CSS}</style>
      </div>
    );
  }

  if (axes.length === 0) {
    return (
      <div class="kmp-root">
        <p class="kmp-empty">
          {axisType === 'keyword'
            ? '키워드 클러스터 축이 없습니다. 먼저 /keyword-axes를 생성하세요.'
            : '표시 축이 없습니다. 먼저 이력서 축을 생성하세요.'}
        </p>
        <style>{KMP_CSS}</style>
      </div>
    );
  }

  return (
    <div
      class="kmp-root"
      onDragEnd={handleDragEnd}
      aria-label="키워드 이동 패널"
    >
      {/* Header */}
      <div class="kmp-header">
        <h3 class="kmp-title">키워드 이동</h3>
        <p class="kmp-hint">
          키워드를 클릭하거나 다른 축으로 드래그해서 이동하세요.
        </p>
      </div>

      {/* Success toast */}
      {successMsg && (
        <p class="kmp-success" role="status">{successMsg}</p>
      )}

      {/* Error toast */}
      {error && (
        <p class="kmp-error" role="alert">
          {error}
          <button
            class="kmp-dismiss"
            type="button"
            onClick={() => setError(null)}
            aria-label="오류 닫기"
          >
            ✕
          </button>
        </p>
      )}

      {/* Axis cards */}
      <div class="kmp-axes-grid">
        {axes.map((axis) => (
          <AxisCard
            key={axis.id}
            axis={axis}
            allAxes={axes}
            axisType={axisType}
            draggingKeyword={dragging}
            onMoveStart={handleMoveStart}
            onMoveSuccess={handleMoveSuccess}
            onError={handleError}
          />
        ))}
      </div>

      <style>{KMP_CSS}</style>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const KMP_CSS = `
  .kmp-root {
    display: flex;
    flex-direction: column;
    gap: var(--space-4, 1rem);
  }

  /* ── Header ── */
  .kmp-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .kmp-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--ink, #111);
  }

  .kmp-hint {
    margin: 0;
    font-size: 12px;
    color: var(--muted, #6b7280);
  }

  /* ── Status messages ── */
  .kmp-loading,
  .kmp-empty {
    font-size: 13px;
    color: var(--muted, #6b7280);
    margin: 0;
  }

  .kmp-success {
    margin: 0;
    padding: 6px 10px;
    font-size: 12px;
    color: #166534;
    background: #dcfce7;
    border-radius: var(--radius-md, 6px);
  }

  .kmp-error {
    margin: 0;
    padding: 6px 10px;
    font-size: 12px;
    color: #991b1b;
    background: #fee2e2;
    border-radius: var(--radius-md, 6px);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .kmp-dismiss {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 11px;
    color: #991b1b;
    padding: 0;
    line-height: 1;
  }

  .kmp-retry-btn {
    align-self: flex-start;
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--line-strong, #d1d5db);
    border-radius: var(--radius-md, 6px);
    background: transparent;
    cursor: pointer;
    color: var(--ink, #111);
  }

  .kmp-retry-btn:hover {
    background: var(--surface, #f9fafb);
  }

  /* ── Axes grid ── */
  .kmp-axes-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.75rem);
  }

  /* ── Axis card ── */
  .kmp-axis-card {
    padding: 10px 12px;
    border: 1.5px solid var(--line-strong, #e5e7eb);
    border-radius: var(--radius-lg, 8px);
    background: var(--bg, #fff);
    transition: border-color 0.15s, background 0.15s;
    min-height: 56px;
    position: relative;
  }

  .kmp-axis-card--dragover {
    border-color: var(--accent, #6366f1);
    background: #f5f3ff;
  }

  .kmp-axis-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    gap: 8px;
  }

  .kmp-axis-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink, #111);
  }

  .kmp-axis-count {
    font-size: 11px;
    color: var(--muted, #6b7280);
    white-space: nowrap;
  }

  /* ── Keyword chips ── */
  .kmp-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 24px;
  }

  .kmp-chip-wrap {
    position: relative;
    display: inline-block;
  }

  .kmp-chip {
    display: inline-block;
    padding: 3px 10px;
    font-size: 12px;
    border: 1px solid var(--line-strong, #d1d5db);
    border-radius: 9999px;
    background: var(--surface, #f9fafb);
    color: var(--ink, #111);
    cursor: grab;
    user-select: none;
    transition: background 0.12s, border-color 0.12s;
    white-space: nowrap;
  }

  .kmp-chip:hover {
    background: var(--accent-soft, #ede9fe);
    border-color: var(--accent, #6366f1);
  }

  .kmp-chip:active {
    cursor: grabbing;
  }

  .kmp-chip--moving {
    opacity: 0.5;
    cursor: wait;
  }

  .kmp-empty-hint {
    font-size: 12px;
    color: var(--muted, #9ca3af);
    font-style: italic;
  }

  .kmp-drop-hint {
    font-size: 12px;
    color: var(--accent, #6366f1);
    font-weight: 600;
    padding: 2px 8px;
    border: 1.5px dashed var(--accent, #6366f1);
    border-radius: 9999px;
    animation: kmp-pulse 0.8s ease-in-out infinite alternate;
  }

  @keyframes kmp-pulse {
    from { opacity: 0.5; }
    to   { opacity: 1; }
  }

  /* ── Select popover ── */
  .kmp-popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 100;
    min-width: 160px;
    background: #fff;
    border: 1px solid var(--line-strong, #e5e7eb);
    border-radius: var(--radius-md, 6px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    padding: 6px 0;
  }

  .kmp-popover-label {
    margin: 0;
    padding: 4px 12px 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--line-light, #f3f4f6);
  }

  .kmp-popover-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    font-size: 13px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--ink, #111);
    transition: background 0.1s;
  }

  .kmp-popover-item:hover {
    background: var(--surface, #f9fafb);
  }

  /* ── Print: hide entire panel ── */
  @media print {
    .kmp-root {
      display: none !important;
    }
  }
`;
