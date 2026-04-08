import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { navigate } from '../App.jsx';

/**
 * useDraftContext — 채팅 세션용 이력서 초안 컨텍스트 로더 + 비동기 생성 (Sub-AC 2-3)
 *
 * 채팅 화면 진입 시:
 *   1. GET /api/resume/chat/generate-draft → 캐시된 초안 조회
 *   2. 캐시 없음(404) → POST /api/resume/chat/generate-draft (async=true) → 백그라운드 생성 시작
 *   3. GET /api/resume/chat/generate-draft/status → 폴링으로 진행 상태 추적
 *   4. 완료 시 GET /api/resume/chat/generate-draft → 결과 로드
 *
 * 반환값:
 *   draft         — ResumeDraft | null  초안 데이터
 *   evidencePool  — EvidenceItem[]      소스별 근거 풀
 *   sourceBreakdown — object | null     소스별 통계
 *   dataGaps      — string[]            데이터 부족 영역
 *   status        — 'idle' | 'loading' | 'generating' | 'ready' | 'error'
 *   loading       — boolean             로딩 중 여부
 *   generating    — boolean             생성 중 여부
 *   error         — string | null       에러 메시지
 *   progress      — object | null       생성 진행 상태 (stage, datesLoaded, commitCount 등)
 *   taskId        — string | null       현재 백그라운드 작업 ID
 *   reload        — () => Promise<void> 캐시 재조회
 *   generate      — (opts?) => Promise<void> 강제 재생성
 *   clearError    — () => void          에러 상태 초기화
 *
 * 옵션:
 *   autoGenerate  — boolean (기본 true)
 *   fromDate      — string | undefined
 *   toDate        — string | undefined
 *   pollInterval  — number (기본 2000ms)  폴링 간격
 *
 * @typedef {Object} ResumeDraft
 * @property {1}      schemaVersion
 * @property {string} generatedAt         ISO 8601
 * @property {{ from: string, to: string }} dateRange
 * @property {{ dates: string[], commitCount: number, sessionCount: number, slackCount: number, repos: string[] }} sources
 * @property {Array}  strengthCandidates
 * @property {Array}  experienceSummaries
 * @property {string} suggestedSummary
 * @property {string[]} dataGaps
 */

const DEFAULT_POLL_INTERVAL = 2000;

export function useDraftContext({
  autoGenerate = true,
  fromDate,
  toDate,
  pollInterval = DEFAULT_POLL_INTERVAL,
} = {}) {
  const [draft, setDraft] = useState(null);
  const [evidencePool, setEvidencePool] = useState([]);
  const [sourceBreakdown, setSourceBreakdown] = useState(null);
  const [dataGaps, setDataGaps] = useState([]);
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'generating' | 'ready' | 'error'
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [taskId, setTaskId] = useState(null);

  /** 중복 호출 방지 — 마운트 시 한 번만 실행 */
  const initializedRef = useRef(false);

  /** 컴포넌트 언마운트 후 상태 업데이트 방지 */
  const mountedRef = useRef(true);
  const pollTimerRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      _stopPolling();
    };
  }, []);

  /** Stop the polling timer */
  function _stopPolling() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  /**
   * 캐시된 초안을 GET으로 조회한다.
   * 404면 null을 반환하고, 200이면 draft를 반환한다.
   *
   * @returns {Promise<{ draft: object | null, cached: boolean } | null>}
   *   null — 인증 실패로 리다이렉트됨
   */
  const fetchCachedDraft = useCallback(async () => {
    const res = await fetch('/api/resume/chat/generate-draft', {
      credentials: 'include',
    });

    if (res.status === 401 || res.status === 403) {
      navigate('/login');
      return null;
    }

    if (res.status === 404) {
      return { draft: null, cached: false, evidencePool: [], sourceBreakdown: null, dataGaps: [] };
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `초안 조회 실패: HTTP ${res.status}`);
    }

    const data = await res.json();
    return {
      draft: data.draft ?? null,
      cached: true,
      evidencePool: data.evidencePool ?? [],
      sourceBreakdown: data.sourceBreakdown ?? null,
      dataGaps: data.dataGaps ?? [],
    };
  }, []);

  /**
   * POST로 비동기 초안 생성을 시작한다 (Sub-AC 2-3).
   * async=true이므로 즉시 반환하며, 폴링으로 진행 상태를 추적한다.
   *
   * @param {{ force?: boolean, fromDate?: string, toDate?: string }} [opts]
   * @returns {Promise<{ started: boolean, taskId?: string, draft?: object } | null>}
   */
  const requestAsyncGeneration = useCallback(async (opts = {}) => {
    const body = { async: true };
    if (opts.force) body.force = true;
    if (opts.fromDate) body.from_date = opts.fromDate;
    if (opts.toDate) body.to_date = opts.toDate;

    const res = await fetch('/api/resume/chat/generate-draft', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 401 || res.status === 403) {
      navigate('/login');
      return null;
    }

    const data = await res.json().catch(() => ({}));

    // 202: generation started in background
    if (res.status === 202) {
      return { started: true, taskId: data.taskId };
    }

    // 200: cached draft returned directly (no generation needed)
    if (res.ok && data.draft) {
      return { started: false, draft: data };
    }

    // 409: already in progress — join existing poll
    if (res.status === 409) {
      return { started: true, taskId: data.taskId, alreadyRunning: true };
    }

    throw new Error(data.error || data.detail || `초안 생성 요청 실패: HTTP ${res.status}`);
  }, []);

  /**
   * 백그라운드 생성 상태를 폴링한다.
   *
   * @returns {Promise<object|null>}  서버 상태 또는 null (네트워크 오류)
   */
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/resume/chat/generate-draft/status', {
        credentials: 'include',
      });

      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  /**
   * 폴링을 시작하여 백그라운드 생성 완료를 감지한다 (Sub-AC 2-3).
   */
  const startPolling = useCallback((currentTaskId) => {
    _stopPolling();

    async function schedulePoll() {
      if (!mountedRef.current) return;

      const state = await pollStatus();
      if (!state || !mountedRef.current) {
        // Schedule next tick even on transient network error
        pollTimerRef.current = setTimeout(schedulePoll, pollInterval);
        return;
      }

      // Update progress for UI feedback
      if (state.progress) {
        setProgress(state.progress);
      }

      if (state.status === 'completed') {
        pollTimerRef.current = null;

        // Generation done — fetch the result
        try {
          const cached = await fetchCachedDraft();
          if (!mountedRef.current) return;

          if (cached && cached.draft) {
            setDraft(cached.draft);
            setEvidencePool(cached.evidencePool || []);
            setSourceBreakdown(cached.sourceBreakdown || null);
            setDataGaps(cached.dataGaps || []);
            setStatus('ready');
            setProgress(null);
            setTaskId(null);
          } else {
            setStatus('ready');
            setProgress(null);
          }
        } catch (err) {
          if (!mountedRef.current) return;
          setError(err.message);
          setStatus('error');
          setProgress(null);
        }

        // Reset server-side state (best-effort, non-blocking)
        fetch('/api/resume/chat/generate-draft/reset', {
          method: 'POST',
          credentials: 'include',
        }).catch(() => {});

        return;
      }

      if (state.status === 'failed') {
        pollTimerRef.current = null;
        if (!mountedRef.current) return;
        setError(state.error || '초안 생성 실패');
        setStatus('error');
        setProgress(null);
        setTaskId(null);

        // Reset server-side state
        fetch('/api/resume/chat/generate-draft/reset', {
          method: 'POST',
          credentials: 'include',
        }).catch(() => {});
        return;
      }

      // status === 'pending' — schedule next poll after interval
      pollTimerRef.current = setTimeout(schedulePoll, pollInterval);
    }

    pollTimerRef.current = setTimeout(schedulePoll, pollInterval);
  }, [pollInterval, pollStatus, fetchCachedDraft]);

  /**
   * 초안 로드 + 비동기 생성 파이프라인 (Sub-AC 2-3).
   *
   * 1. GET으로 캐시 조회
   * 2. 캐시 없고 autoGenerate=true이면 POST (async=true)로 백그라운드 생성 시작
   * 3. 폴링으로 완료 감지 후 결과 로드
   */
  const loadAndGenerate = useCallback(async () => {
    if (!mountedRef.current) return;

    setStatus('loading');
    setError(null);
    setProgress(null);

    try {
      // Step 1: 캐시된 초안 조회
      const cached = await fetchCachedDraft();
      if (!cached) return; // 인증 실패로 리다이렉트됨
      if (!mountedRef.current) return;

      if (cached.draft) {
        // 캐시 있음 — 즉시 ready
        setDraft(cached.draft);
        setEvidencePool(cached.evidencePool || []);
        setSourceBreakdown(cached.sourceBreakdown || null);
        setDataGaps(cached.dataGaps || []);
        setStatus('ready');
        return;
      }

      // Step 2: 캐시 없음 — 자동 생성 여부 확인
      if (!autoGenerate) {
        setDraft(null);
        setStatus('ready');
        return;
      }

      // Step 3: 비동기 생성 시작 (Sub-AC 2-3 — 메인 스레드 블로킹 없음)
      setStatus('generating');

      const result = await requestAsyncGeneration({ fromDate, toDate });
      if (!mountedRef.current) return;

      if (result === null) {
        // 인증 실패 — 이미 navigate됨
        setStatus('idle');
        return;
      }

      // Cached draft returned directly (no async generation needed)
      if (!result.started && result.draft) {
        const d = result.draft;
        setDraft(d.draft ?? null);
        setEvidencePool(d.evidencePool ?? []);
        setSourceBreakdown(d.sourceBreakdown ?? null);
        setDataGaps(d.dataGaps ?? []);
        setStatus('ready');
        return;
      }

      // Background generation started — poll for completion
      if (result.taskId) {
        setTaskId(result.taskId);
        startPolling(result.taskId);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err.message);
      setStatus('error');
    }
  }, [autoGenerate, fromDate, toDate, fetchCachedDraft, requestAsyncGeneration, startPolling]);

  /**
   * 캐시만 다시 조회한다 (생성 없이 GET만).
   * ResumeDraftPanel의 "새로고침" 등에서 사용.
   */
  const reload = useCallback(async () => {
    if (!mountedRef.current) return;

    setStatus('loading');
    setError(null);
    setProgress(null);

    try {
      const cached = await fetchCachedDraft();
      if (!cached || !mountedRef.current) return;

      setDraft(cached.draft);
      setEvidencePool(cached.evidencePool || []);
      setSourceBreakdown(cached.sourceBreakdown || null);
      setDataGaps(cached.dataGaps || []);
      setStatus('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err.message);
      setStatus('error');
    }
  }, [fetchCachedDraft]);

  /**
   * 강제 재생성 (비동기 모드 — Sub-AC 2-3).
   * 기존 캐시를 무시하고 새로 생성한다.
   *
   * @param {{ fromDate?: string, toDate?: string }} [opts]
   */
  const generate = useCallback(async (opts = {}) => {
    if (!mountedRef.current) return;

    _stopPolling();
    setStatus('generating');
    setError(null);
    setProgress(null);

    try {
      const result = await requestAsyncGeneration({
        force: true,
        fromDate: opts.fromDate || fromDate,
        toDate: opts.toDate || toDate,
      });
      if (!mountedRef.current) return;

      if (result === null) {
        setStatus('idle');
        return;
      }

      // Cached draft returned
      if (!result.started && result.draft) {
        const d = result.draft;
        setDraft(d.draft ?? null);
        setEvidencePool(d.evidencePool ?? []);
        setSourceBreakdown(d.sourceBreakdown ?? null);
        setDataGaps(d.dataGaps ?? []);
        setStatus('ready');
        return;
      }

      // Background generation started
      if (result.taskId) {
        setTaskId(result.taskId);
        startPolling(result.taskId);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err.message);
      setStatus('error');
    }
  }, [fromDate, toDate, requestAsyncGeneration, startPolling]);

  const clearError = useCallback(() => {
    setError(null);
    if (status === 'error') setStatus('idle');
  }, [status]);

  // 마운트 시 자동 로드
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    loadAndGenerate();
  }, [loadAndGenerate]);

  return {
    draft,
    evidencePool,
    sourceBreakdown,
    dataGaps,
    status,
    loading: status === 'loading',
    generating: status === 'generating',
    error,
    progress,
    taskId,
    reload,
    generate,
    clearError,
  };
}
