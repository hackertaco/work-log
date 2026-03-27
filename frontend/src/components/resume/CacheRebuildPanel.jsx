import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * CacheRebuildPanel — 불릿 캐시 재구성 패널
 *
 * 업무 로그 원본 파일을 기준으로 일별 불릿 캐시(resume/bullets/{date}.json)를
 * 재구성하는 UI 패널이다.
 *
 * 기능:
 *   1. 마운트 시 GET /api/resume/daily-bullets/staleness 를 호출하여
 *      캐시가 없는 날짜(uncachedDates)가 있는지 확인한다.
 *   2. isStale=true 이면 "새 로그 감지됨" 배지를 표시하고
 *      자동으로 캐시 갱신을 권장한다.
 *   3. "불릿 재구성" 버튼 클릭 시 POST /api/resume/daily-bullets/rebuild-all
 *      (force=false) 을 호출하여 미캐시 날짜만 재구성한다.
 *   4. "전체 강제 재구성" 버튼으로 force=true 전송하여 모든 날짜를 재구성한다.
 *   5. 결과(rebuilt, skipped, failed)를 인라인으로 표시한다.
 *
 * 사용자 수정 보존:
 *   서버의 mergeDailyBulletsDocuments() 가 기존 promoted/dismissed 상태를
 *   항상 보존하므로, 재구성 후에도 사용자 액션은 유실되지 않는다.
 *
 * props: 없음 (독립 패널)
 */
export function CacheRebuildPanel() {
  /** @type {'idle'|'checking'|'rebuilding'|'done'|'error'} */
  const [phase, setPhase] = useState('idle');
  const [staleness, setStaleness] = useState(/** @type {StalenessInfo|null} */ (null));
  const [result, setResult] = useState(/** @type {RebuildResult|null} */ (null));
  const [errorMsg, setErrorMsg] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── 마운트 시 staleness 확인 ──────────────────────────────────────────────
  useEffect(() => {
    checkStaleness();
  }, []);

  async function checkStaleness() {
    setPhase('checking');
    setErrorMsg('');
    setResult(null);
    try {
      const res = await fetch('/api/resume/daily-bullets/staleness', {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (mountedRef.current) {
        setStaleness(data);
        setPhase('idle');
      }
    } catch (err) {
      if (mountedRef.current) {
        // Staleness check failure is non-critical; degrade silently.
        setStaleness(null);
        setPhase('idle');
        console.warn('[CacheRebuildPanel] staleness check failed:', err.message);
      }
    }
  }

  async function handleRebuild(force) {
    setPhase('rebuilding');
    setErrorMsg('');
    setResult(null);
    try {
      const res = await fetch('/api/resume/daily-bullets/rebuild-all', {
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
        setResult(data);
        setPhase('done');
        // Re-check staleness after rebuild to update badge.
        checkStaleness();
      }
    } catch (err) {
      if (mountedRef.current) {
        setErrorMsg(err.message);
        setPhase('error');
      }
    }
  }

  const isChecking = phase === 'checking';
  const isRebuilding = phase === 'rebuilding';
  const busy = isChecking || isRebuilding;

  return (
    <div class="crp-root">
      {/* ── Header ── */}
      <div class="crp-header">
        <p class="crp-title">불릿 캐시</p>
        <button
          class="crp-refresh-btn"
          onClick={checkStaleness}
          disabled={busy}
          aria-label="캐시 상태 새로고침"
          title="캐시 상태 확인"
        >
          ↺
        </button>
      </div>

      {/* ── Staleness badge ── */}
      {staleness && (
        <div class="crp-status">
          <span
            class={`crp-badge ${staleness.isStale ? 'crp-badge--stale' : 'crp-badge--ok'}`}
          >
            {staleness.isStale
              ? `새 로그 ${staleness.uncachedDates.length}일`
              : '최신'}
          </span>
          <span class="crp-status-detail">
            {staleness.cachedDates} / {staleness.totalWorkLogDates}일 캐시됨
          </span>
        </div>
      )}

      {/* ── Result ── */}
      {phase === 'done' && result && (
        <div class="crp-result">
          <p class="crp-result-msg">
            {result.rebuilt > 0
              ? `${result.rebuilt}일 재구성 완료`
              : result.message ?? '변경 없음'}
            {result.failed > 0 && (
              <span class="crp-result-warn"> · {result.failed}일 실패</span>
            )}
          </p>
        </div>
      )}

      {/* ── Error ── */}
      {phase === 'error' && errorMsg && (
        <p class="crp-error">{errorMsg}</p>
      )}

      {/* ── Actions ── */}
      <div class="crp-actions">
        <button
          class="crp-btn crp-btn--primary"
          onClick={() => handleRebuild(false)}
          disabled={busy}
          aria-busy={isRebuilding}
          title="미캐시 날짜만 재구성"
        >
          {isRebuilding ? '재구성 중…' : '불릿 재구성'}
        </button>
        <button
          class="crp-btn crp-btn--secondary"
          onClick={() => handleRebuild(true)}
          disabled={busy}
          aria-busy={isRebuilding}
          title="모든 날짜 강제 재구성 (기존 캐시 덮어쓰기)"
        >
          전체 강제
        </button>
      </div>

      <style>{CRP_CSS}</style>
    </div>
  );
}

/* ──────────────────────────────────────────── */
/* Types (JSDoc only)                           */
/* ──────────────────────────────────────────── */

/**
 * @typedef {{
 *   ok: boolean,
 *   totalWorkLogDates: number,
 *   cachedDates: number,
 *   uncachedDates: string[],
 *   isStale: boolean,
 * }} StalenessInfo
 *
 * @typedef {{
 *   ok: boolean,
 *   rebuilt: number,
 *   failed: number,
 *   skipped: number,
 *   dates: string[],
 *   uncachedDates: string[],
 *   message?: string,
 * }} RebuildResult
 */

/* ──────────────────────────────────────────── */
/* Styles                                       */
/* ──────────────────────────────────────────── */

const CRP_CSS = `
  /* ─── Root card ─── */
  .crp-root {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    padding: var(--space-4) var(--space-5);
    backdrop-filter: blur(10px);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* ─── Header ─── */
  .crp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .crp-title {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .crp-refresh-btn {
    background: none;
    border: none;
    padding: 2px 4px;
    font-size: 14px;
    color: var(--muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: color 0.15s, background 0.15s;
    line-height: 1;
  }

  .crp-refresh-btn:hover:not(:disabled) {
    color: var(--ink);
    background: rgba(17, 24, 39, 0.07);
  }

  .crp-refresh-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* ─── Staleness status ─── */
  .crp-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .crp-badge {
    padding: 2px 7px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }

  .crp-badge--ok {
    background: #d1fae5;
    color: #065f46;
    border: 1px solid #a7f3d0;
  }

  .crp-badge--stale {
    background: #fef3c7;
    color: #92400e;
    border: 1px solid #fde68a;
  }

  .crp-status-detail {
    font-size: 11px;
    color: var(--muted);
  }

  /* ─── Result ─── */
  .crp-result {
    background: rgba(17, 24, 39, 0.03);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
  }

  .crp-result-msg {
    margin: 0;
    font-size: 12px;
    color: var(--ink);
    line-height: 1.5;
  }

  .crp-result-warn {
    color: #d97706;
  }

  /* ─── Error ─── */
  .crp-error {
    margin: 0;
    font-size: 12px;
    color: #e53e3e;
    line-height: 1.5;
  }

  /* ─── Action buttons ─── */
  .crp-actions {
    display: flex;
    gap: var(--space-2);
  }

  .crp-btn {
    flex: 1;
    padding: 5px 8px;
    font-size: 12px;
    font-weight: 600;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: opacity 0.15s;
    white-space: nowrap;
  }

  .crp-btn:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .crp-btn--primary {
    background: var(--ink);
    color: #fff;
    border: 1px solid transparent;
  }

  .crp-btn--primary:hover:not(:disabled) {
    opacity: 0.82;
  }

  .crp-btn--secondary {
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    border: 1px solid var(--line-strong);
    flex: 0 0 auto;
    padding: 5px 10px;
  }

  .crp-btn--secondary:hover:not(:disabled) {
    background: rgba(17, 24, 39, 0.1);
  }

  @media print {
    .crp-root { display: none !important; }
  }
`;
