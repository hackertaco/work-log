import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * DisplayAxesView — 프로필 분석 전용 뷰
 *
 * 표시 축(display axes)을 프로필 강점 분석 관점에서 시각화하는 컴포넌트.
 *
 * ── 상태 분리 원칙 (Sub-AC 24a) ────────────────────────────────────────────
 *
 *   이 컴포넌트는 resume 상태와 **완전히 분리**된 독립 뷰다.
 *
 *   1. props 없음 — resume 객체를 받지 않고, resume를 수정하는 콜백
 *      (onResumePatched, setResume 등)도 받지 않는다.
 *
 *   2. 모든 데이터는 자체 fetch로 로드한다:
 *        GET /api/resume/axes          → 표시 축 목록
 *        GET /api/resume/axes/staleness → 미분류 키워드 비율
 *
 *   3. 축 변경 이벤트(재클러스터링)는 API 호출로만 처리된다:
 *        POST /api/resume/axes/recluster
 *      응답 결과를 로컬 상태(axes, staleness)로만 반영하며,
 *      상위 resume 상태(ResumePage.resume)를 직접 수정하지 않는다.
 *
 *   4. 단방향 데이터 흐름 보장:
 *        API 응답 → 로컬 상태(axes / staleness) → 렌더링
 *      이벤트가 역방향으로 resume 데이터를 변경하는 경로가 없다.
 *
 * ── 표시 내용 ───────────────────────────────────────────────────────────────
 *
 *   - 각 축의 이름(label)과 연관 키워드(keywords) 태그 목록
 *   - 축별 키워드 수 배지
 *   - 미분류 키워드 비율이 임계값(30%) 초과 시 재클러스터링 안내 배너
 *   - 재클러스터링 버튼 (POST /api/resume/axes/recluster)
 *   - 전체 키워드 커버리지 요약 (총 키워드 수, 미분류 수)
 *
 * props: 없음 (독립 컴포넌트 — resume 상태와 결합 없음)
 */
export function DisplayAxesView() {
  // ── 표시 축 상태 ─────────────────────────────────────────────────────────
  /** @type {[import('./AxesPanel').Axis[]|null, function]} */
  const [axes, setAxes] = useState(null);
  const [axesLoading, setAxesLoading] = useState(true);
  const [axesError, setAxesError] = useState('');

  // ── 신선도(staleness) 상태 ───────────────────────────────────────────────
  /**
   * @type {[{
   *   ratio: number,
   *   totalKeywords: number,
   *   unclassifiedCount: number,
   *   threshold: number,
   *   shouldRecluster: boolean
   * }|null, function]}
   */
  const [staleness, setStaleness] = useState(null);
  const [stalenessLoading, setStalenessLoading] = useState(false);
  const [stalenessError, setStalenessError] = useState('');

  // ── 재클러스터링 상태 ────────────────────────────────────────────────────
  const [reclustering, setReclustering] = useState(false);
  const [reclusterError, setReclusterError] = useState('');
  const [reclusterSuccess, setReclusterSuccess] = useState(false);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 마운트 시 축 목록 + 신선도 동시 로드
  useEffect(() => {
    fetchAxes();
    fetchStaleness();
  }, []);

  // ── 데이터 로드 ──────────────────────────────────────────────────────────

  /**
   * GET /api/resume/axes — 표시 축 목록 로드
   *
   * 단방향 흐름: API → axes 로컬 상태 → 렌더링
   * resume 상태를 건드리지 않는다.
   */
  async function fetchAxes() {
    setAxesLoading(true);
    setAxesError('');
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
        setAxesError(err.message);
        setAxes([]);
      }
    } finally {
      if (mountedRef.current) setAxesLoading(false);
    }
  }

  /**
   * GET /api/resume/axes/staleness — 미분류 키워드 비율 확인
   *
   * 단방향 흐름: API → staleness 로컬 상태 → 배너 렌더링
   * 결과가 shouldRecluster=true여도 resume 상태를 변경하지 않는다.
   */
  async function fetchStaleness() {
    setStalenessLoading(true);
    setStalenessError('');
    try {
      const res = await fetch('/api/resume/axes/staleness', { credentials: 'include' });
      if (!res.ok) {
        // 404 = 아직 이력서 없음, 무시
        if (res.status === 404) {
          if (mountedRef.current) setStaleness(null);
          return;
        }
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (mountedRef.current) {
        setStaleness(data);
      }
    } catch (err) {
      if (mountedRef.current) {
        setStalenessError(err.message);
      }
    } finally {
      if (mountedRef.current) setStalenessLoading(false);
    }
  }

  // ── 재클러스터링 ─────────────────────────────────────────────────────────

  /**
   * POST /api/resume/axes/recluster — 미분류 키워드 비율 초과 시 재클러스터링 실행
   *
   * 축 변경 이벤트 처리 원칙:
   *   - API 호출 결과를 로컬 axes 상태로만 반영한다.
   *   - 상위 resume 상태(ResumePage.resume)를 직접 수정하지 않는다.
   *   - 단방향 흐름: 버튼 클릭 → POST API → 로컬 axes/staleness 갱신 → 재렌더링
   *
   * @param {boolean} [force=false] 임계값 무시하고 강제 재클러스터링
   */
  async function triggerRecluster(force = false) {
    setReclustering(true);
    setReclusterError('');
    setReclusterSuccess(false);
    try {
      const res = await fetch('/api/resume/axes/recluster', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (mountedRef.current) {
        // API 결과를 로컬 상태에만 반영 (resume 상태 수정 없음)
        if (Array.isArray(data.axes)) {
          setAxes(data.axes);
        } else {
          // 서버가 axes를 반환하지 않으면 재조회
          await fetchAxes();
        }
        setReclusterSuccess(true);
        // staleness 재확인
        fetchStaleness();
        // 3초 후 성공 메시지 숨기기
        setTimeout(() => {
          if (mountedRef.current) setReclusterSuccess(false);
        }, 3000);
      }
    } catch (err) {
      if (mountedRef.current) {
        setReclusterError(err.message);
      }
    } finally {
      if (mountedRef.current) setReclustering(false);
    }
  }

  // ── 렌더 ─────────────────────────────────────────────────────────────────

  const totalKeywords = staleness?.totalKeywords ?? 0;
  const unclassifiedCount = staleness?.unclassifiedCount ?? 0;
  const ratioPct = staleness ? Math.round(staleness.ratio * 100) : 0;
  const shouldRecluster = staleness?.shouldRecluster ?? false;

  return (
    <section class="dav-root" aria-label="프로필 분석">
      {/* 헤더 */}
      <header class="dav-header">
        <div class="dav-header-left">
          <h3 class="dav-title">프로필 분석</h3>
          {staleness && (
            <span
              class={`dav-coverage-badge${shouldRecluster ? ' dav-coverage-badge--warn' : ''}`}
              title={`전체 ${totalKeywords}개 키워드 중 ${unclassifiedCount}개(${ratioPct}%) 미분류`}
            >
              {totalKeywords > 0
                ? `${totalKeywords - unclassifiedCount}/${totalKeywords}`
                : '0/0'}
            </span>
          )}
        </div>
        <button
          class="dav-refresh-btn"
          type="button"
          onClick={() => { fetchAxes(); fetchStaleness(); }}
          title="프로필 분석 새로고침"
          aria-label="새로고침"
          disabled={axesLoading}
        >
          ↻
        </button>
      </header>

      {/* 재클러스터링 권고 배너 */}
      {shouldRecluster && !reclustering && (
        <div class="dav-recluster-banner" role="alert">
          <span class="dav-banner-msg">
            미분류 키워드가 {ratioPct}%로 임계값을 초과했습니다.
          </span>
          <button
            class="dav-recluster-btn"
            type="button"
            onClick={() => triggerRecluster(false)}
            disabled={reclustering}
          >
            축 재편성
          </button>
        </div>
      )}

      {/* 재클러스터링 진행 중 */}
      {reclustering && (
        <div class="dav-state">
          <span class="dav-spinner" aria-label="재편성 중" />
          <span class="dav-state-msg">프로필 축 재편성 중…</span>
        </div>
      )}

      {/* 재클러스터링 성공 메시지 */}
      {reclusterSuccess && (
        <p class="dav-recluster-success" role="status">
          프로필 축이 업데이트되었습니다.
        </p>
      )}

      {/* 재클러스터링 오류 */}
      {reclusterError && (
        <p class="dav-recluster-error" role="alert">{reclusterError}</p>
      )}

      {/* 로딩 */}
      {axesLoading && !reclustering && (
        <div class="dav-state">
          <span class="dav-spinner" aria-label="불러오는 중" />
          <span class="dav-state-msg">불러오는 중…</span>
        </div>
      )}

      {/* 오류 */}
      {!axesLoading && axesError && (
        <div class="dav-state dav-state--error">
          <p class="dav-error-msg">{axesError}</p>
          <button class="dav-retry-btn" type="button" onClick={fetchAxes}>
            다시 시도
          </button>
        </div>
      )}

      {/* 빈 상태 */}
      {!axesLoading && !axesError && axes !== null && axes.length === 0 && (
        <div class="dav-empty">
          <p class="dav-empty-msg">아직 프로필 축이 없습니다.</p>
          <p class="dav-empty-hint">
            이력서 PDF를 업로드하면 강점 키워드로부터 프로필 축이 자동 생성됩니다.
          </p>
        </div>
      )}

      {/* 축 목록 — 프로필 분석 뷰 (읽기 전용) */}
      {!axesLoading && !axesError && axes !== null && axes.length > 0 && (
        <ol class="dav-axes-list" role="list">
          {axes.map((axis, idx) => {
            const kwCount = (axis.keywords ?? []).length;
            return (
              <li key={axis.id} class="dav-axis-item">
                <div class="dav-axis-header">
                  {/* 축 번호 */}
                  <span class="dav-axis-index" aria-hidden="true">
                    {idx + 1}
                  </span>
                  {/* 축 이름 */}
                  <span class="dav-axis-label">{axis.label}</span>
                  {/* 키워드 수 배지 */}
                  <span
                    class="dav-kw-count"
                    title={`${kwCount}개 키워드`}
                    aria-label={`키워드 ${kwCount}개`}
                  >
                    {kwCount}
                  </span>
                </div>

                {/* 키워드 태그 */}
                {kwCount > 0 && (
                  <div class="dav-keywords" aria-label={`${axis.label} 관련 키워드`}>
                    {(axis.keywords ?? []).map((kw, ki) => (
                      <span key={ki} class="dav-kw-tag">{kw}</span>
                    ))}
                  </div>
                )}

                {kwCount === 0 && (
                  <p class="dav-no-keywords">키워드 없음</p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/* 신선도 요약 — 전체 커버리지 수치 */}
      {!stalenessLoading && staleness && axes !== null && axes.length > 0 && (
        <footer class="dav-summary">
          <span class="dav-summary-text">
            총 {totalKeywords}개 키워드 · 분류됨 {totalKeywords - unclassifiedCount}개
            {unclassifiedCount > 0 && (
              <> · <span class="dav-summary-warn">미분류 {unclassifiedCount}개 ({ratioPct}%)</span></>
            )}
          </span>
          {!shouldRecluster && (
            <button
              class="dav-force-recluster-btn"
              type="button"
              onClick={() => triggerRecluster(true)}
              disabled={reclustering}
              title="임계값과 무관하게 축을 강제 재편성합니다"
            >
              강제 재편성
            </button>
          )}
        </footer>
      )}

      {/* 신선도 오류 (비치명적, 축 목록 표시에 영향 없음) */}
      {stalenessError && (
        <p class="dav-staleness-error" role="alert">
          신선도 확인 실패: {stalenessError}
        </p>
      )}

      <style>{DAV_CSS}</style>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────── */
/* Styles                                                               */
/* ──────────────────────────────────────────────────────────────────── */

const DAV_CSS = `
  .dav-root {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* ─── Header ─── */
  .dav-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .dav-header-left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .dav-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink);
    white-space: nowrap;
  }

  /* 전체 커버리지 배지 (헤더 우측) */
  .dav-coverage-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 1px 7px;
    font-size: 11px;
    font-weight: 600;
    color: #2f855a;
    background: #f0fff4;
    border: 1px solid #c6f6d5;
    border-radius: 999px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .dav-coverage-badge--warn {
    color: #c05621;
    background: #fffaf0;
    border-color: #fbd38d;
  }

  .dav-refresh-btn {
    padding: 2px 6px;
    font-size: 16px;
    line-height: 1;
    color: var(--muted);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }

  .dav-refresh-btn:hover:not(:disabled) {
    color: var(--ink);
    background: var(--surface);
  }

  .dav-refresh-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ─── Recluster banner ─── */
  .dav-recluster-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: #fffaf0;
    border: 1px solid #fbd38d;
    border-radius: var(--radius-md);
  }

  .dav-banner-msg {
    font-size: 12px;
    color: #c05621;
    flex: 1;
    min-width: 0;
  }

  .dav-recluster-btn {
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 600;
    color: #c05621;
    background: #feebcb;
    border: 1px solid #fbd38d;
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.12s, border-color 0.12s;
  }

  .dav-recluster-btn:hover:not(:disabled) {
    background: #fbd38d;
    border-color: #ed8936;
  }

  .dav-recluster-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ─── Status messages ─── */
  .dav-state {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
  }

  .dav-state--error {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .dav-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--line-strong);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: dav-spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes dav-spin {
    to { transform: rotate(360deg); }
  }

  .dav-state-msg {
    font-size: 13px;
    color: var(--muted);
  }

  .dav-error-msg {
    margin: 0;
    font-size: 13px;
    color: #e53e3e;
  }

  .dav-retry-btn {
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

  .dav-retry-btn:hover {
    background: var(--line);
  }

  .dav-recluster-success {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: 12px;
    font-weight: 600;
    color: #2f855a;
    background: #f0fff4;
    border: 1px solid #c6f6d5;
    border-radius: var(--radius-md);
  }

  .dav-recluster-error {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
  }

  .dav-staleness-error {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    font-style: italic;
  }

  /* ─── Empty state ─── */
  .dav-empty {
    padding: var(--space-3) 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .dav-empty-msg {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  .dav-empty-hint {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    opacity: 0.7;
  }

  /* ─── Axes list (profile analysis view) ─── */
  .dav-axes-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    counter-reset: none;
  }

  .dav-axis-item {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    transition: border-color 0.15s;
  }

  .dav-axis-item:hover {
    border-color: var(--line-strong);
  }

  .dav-axis-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 22px;
  }

  /* 순서 번호 */
  .dav-axis-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 50%;
    flex-shrink: 0;
    user-select: none;
  }

  /* 축 이름 — 읽기 전용 텍스트 (편집 불가) */
  .dav-axis-label {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 키워드 수 배지 */
  .dav-kw-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 18px;
    padding: 0 5px;
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 999px;
    flex-shrink: 0;
    user-select: none;
  }

  /* ─── Keywords ─── */
  .dav-keywords {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .dav-kw-tag {
    display: inline-block;
    padding: 2px 7px;
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 999px;
    white-space: nowrap;
  }

  .dav-no-keywords {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    font-style: italic;
  }

  /* ─── Summary footer ─── */
  .dav-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .dav-summary-text {
    font-size: 11px;
    color: var(--muted);
    flex: 1;
    min-width: 0;
  }

  .dav-summary-warn {
    color: #c05621;
    font-weight: 600;
  }

  .dav-force-recluster-btn {
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }

  .dav-force-recluster-btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink);
    background: var(--surface);
  }

  .dav-force-recluster-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ─── Print: hide from printed resume ─── */
  @media print {
    .dav-root {
      display: none !important;
    }
  }
`;
