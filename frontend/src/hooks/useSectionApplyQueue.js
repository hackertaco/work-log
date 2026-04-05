import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { navigate } from '../App.jsx';

/**
 * useSectionApplyQueue — 이력서 섹션 반영 요청 큐(Queue) 상태 관리 훅
 *
 * 여러 섹션 반영 요청(diff approve)을 순서대로 처리하는 큐 자료구조를 제공한다.
 *
 * 큐 아이템 구조:
 * ```
 * {
 *   id:          string,     // 큐 아이템 고유 ID
 *   messageId:   string,     // 연관된 채팅 메시지 ID
 *   section:     string,     // 이력서 섹션 이름 (예: 'experience', 'skills')
 *   content:     string,     // 반영할 섹션 내용 (diff after)
 *   status:      'waiting' | 'processing' | 'done' | 'error' | 'skipped',
 *   error?:      string,     // 오류 메시지 (status === 'error' 시)
 *   enqueuedAt:  number,     // 큐에 추가된 타임스탬프
 *   startedAt?:  number,     // 처리 시작 타임스탬프
 *   completedAt? number,     // 처리 완료 타임스탬프
 * }
 * ```
 *
 * 처리 흐름:
 *   1. `enqueue(item)` 호출 → 큐에 추가
 *   2. 처리 중인 아이템이 없으면 즉시 처리 시작
 *   3. 처리 완료(done/error/skipped) 시 다음 waiting 아이템 자동 처리
 *   4. `currentIndex`는 현재 처리 중인 아이템의 큐 내 인덱스를 추적
 *
 * 콜백:
 *   onItemStart(queueItem)   — 아이템 처리 시작 시 호출 (waiting → processing 전환)
 *   onItemDone(queueItem)    — 아이템 처리 완료 시 호출
 *   onItemError(queueItem)   — 아이템 처리 실패 시 호출
 *   onAllDone()              — 큐의 모든 아이템 처리 완료 시 호출
 *
 * @param {Object} [opts]
 * @param {string} [opts.sessionId]  — 채팅 세션 ID (PATCH 요청에 포함)
 * @param {(item: QueueItem) => void} [opts.onItemStart]
 * @param {(item: QueueItem) => void} [opts.onItemDone]
 * @param {(item: QueueItem) => void} [opts.onItemError]
 * @param {() => void}               [opts.onAllDone]
 *
 * @returns {{
 *   queue:          QueueItem[],
 *   currentIndex:   number,   // 현재 처리 중인 아이템 인덱스 (-1이면 처리 없음)
 *   isProcessing:   boolean,
 *   pendingCount:   number,   // 대기 중인 아이템 수
 *   enqueue:        (item: EnqueueInput) => string,  // 큐에 추가, 생성된 ID 반환
 *   skip:           (id: string) => void,            // 특정 아이템 건너뛰기
 *   clearWaiting:   () => void,                      // waiting 아이템 전체 제거
 *   reset:          () => void,                      // 큐 초기화
 *   getQueuePosition: (messageId: string) => number, // 특정 메시지의 큐 대기 순번 (1-based, -1이면 없음)
 * }}
 */
export function useSectionApplyQueue({
  sessionId = '',
  onItemStart,
  onItemDone,
  onItemError,
  onAllDone,
} = {}) {
  /** @type {[QueueItem[], Function]} */
  const [queue, setQueue] = useState([]);

  /**
   * 현재 처리 중인 아이템의 큐 내 인덱스.
   * -1이면 처리 중인 아이템이 없음.
   */
  const [currentIndex, setCurrentIndex] = useState(-1);

  /** 처리 루프가 실행 중인지 추적하는 ref (re-render 불필요) */
  const isRunningRef = useRef(false);

  /** 최신 큐 상태를 비동기 처리 루프에서 읽을 수 있도록 ref로도 유지 */
  const queueRef = useRef([]);

  /** 외부 콜백을 ref로 보관 (stale closure 방지) */
  const onItemStartRef = useRef(onItemStart);
  const onItemDoneRef = useRef(onItemDone);
  const onItemErrorRef = useRef(onItemError);
  const onAllDoneRef = useRef(onAllDone);

  useEffect(() => { onItemStartRef.current = onItemStart; }, [onItemStart]);
  useEffect(() => { onItemDoneRef.current = onItemDone; }, [onItemDone]);
  useEffect(() => { onItemErrorRef.current = onItemError; }, [onItemError]);
  useEffect(() => { onAllDoneRef.current = onAllDone; }, [onAllDone]);

  /* ── 내부 헬퍼: 큐 상태를 state + ref 양쪽에 반영 ─── */
  const setQueueSync = useCallback((updater) => {
    setQueue((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      queueRef.current = next;
      return next;
    });
  }, []);

  /* ── 내부: 큐에서 다음 waiting 아이템의 인덱스를 반환 ─── */
  function nextWaitingIndex(q) {
    return q.findIndex((item) => item.status === 'waiting');
  }

  /* ── 내부: 단일 아이템 처리 (PATCH API 호출) ─── */
  async function processItem(idx) {
    const item = queueRef.current[idx];
    if (!item) return;

    // 상태를 'processing'으로 전환
    setCurrentIndex(idx);
    setQueueSync((prev) =>
      prev.map((it, i) =>
        i === idx
          ? { ...it, status: 'processing', startedAt: Date.now() }
          : it
      )
    );

    // onItemStart 콜백 호출 — 처리 시작을 알려 UI를 'processing' 상태로 전환
    const startItem = { ...item, status: 'processing', startedAt: Date.now() };
    onItemStartRef.current?.(startItem);

    try {
      const res = await fetch('/api/resume/section', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section: item.section,
          content: item.content,
          messageId: item.messageId,
          sessionId,
        }),
      });

      if (res.status === 401 || res.status === 403) {
        navigate('/login');
        // 현재 아이템을 error로 표시하고 처리 중단
        const errorItem = markError(idx, '인증이 만료되었습니다. 다시 로그인해주세요.');
        onItemErrorRef.current?.(errorItem);
        isRunningRef.current = false;
        setCurrentIndex(-1);
        return;
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const errorMsg = errBody.error || `HTTP ${res.status}`;
        const errorItem = markError(idx, errorMsg);
        onItemErrorRef.current?.(errorItem);
      } else {
        const doneItem = markDone(idx);
        onItemDoneRef.current?.(doneItem);
      }
    } catch (err) {
      const errorItem = markError(idx, err.message);
      onItemErrorRef.current?.(errorItem);
    }

    // 다음 waiting 아이템 처리
    const updatedQueue = queueRef.current;
    const nextIdx = nextWaitingIndex(updatedQueue);

    if (nextIdx === -1) {
      // 더 이상 처리할 아이템 없음
      isRunningRef.current = false;
      setCurrentIndex(-1);
      onAllDoneRef.current?.();
    } else {
      await processItem(nextIdx);
    }
  }

  /* ── 내부: 아이템을 'done'으로 마킹하고 반환 ─── */
  function markDone(idx) {
    // queueRef.current 는 setQueueSync 에 의해 항상 최신 상태를 동기적으로 반영한다.
    // setState 업데이터 클로저 변수에 의존하는 대신 ref 에서 직접 읽어
    // Preact/React 배칭 환경에서도 undefined 가 반환되지 않도록 보장한다.
    const original = queueRef.current[idx];
    if (!original) return undefined;
    const doneItem = { ...original, status: 'done', completedAt: Date.now() };
    setQueueSync((prev) =>
      prev.map((it, i) => (i === idx ? doneItem : it))
    );
    return doneItem;
  }

  /* ── 내부: 아이템을 'error'로 마킹하고 반환 ─── */
  function markError(idx, errorMsg) {
    // 동일한 이유로 queueRef.current 에서 직접 읽어 errorItem 을 구성한다.
    const original = queueRef.current[idx];
    if (!original) return undefined;
    const errorItem = { ...original, status: 'error', error: errorMsg, completedAt: Date.now() };
    setQueueSync((prev) =>
      prev.map((it, i) => (i === idx ? errorItem : it))
    );
    return errorItem;
  }

  /* ── 공개 API: enqueue ─── */

  /**
   * 섹션 반영 요청을 큐에 추가한다.
   *
   * @param {{ messageId: string, section: string, content: string }} input
   * @returns {string} 생성된 큐 아이템 ID
   */
  const enqueue = useCallback((input) => {
    const id = `sq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newItem = {
      id,
      messageId: input.messageId,
      section: input.section,
      content: input.content,
      status: 'waiting',
      error: undefined,
      enqueuedAt: Date.now(),
      startedAt: undefined,
      completedAt: undefined,
    };

    setQueueSync((prev) => {
      const next = [...prev, newItem];
      // 처리 루프가 실행 중이 아니면 즉시 시작
      if (!isRunningRef.current) {
        isRunningRef.current = true;
        // 다음 마이크로태스크에서 처리 시작 (state 업데이트 후)
        Promise.resolve().then(() => {
          const idx = nextWaitingIndex(queueRef.current);
          if (idx !== -1) processItem(idx);
        });
      }
      return next;
    });

    return id;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /* ── 공개 API: skip ─── */

  /**
   * 특정 아이템을 건너뛴다 (waiting 상태의 아이템만 가능).
   * @param {string} id 건너뛸 아이템 ID
   */
  const skip = useCallback((id) => {
    setQueueSync((prev) =>
      prev.map((it) =>
        it.id === id && it.status === 'waiting'
          ? { ...it, status: 'skipped', completedAt: Date.now() }
          : it
      )
    );
  }, [setQueueSync]);

  /* ── 공개 API: clearWaiting ─── */

  /**
   * 대기 중인(waiting) 아이템을 모두 제거한다.
   * 현재 처리 중(processing)인 아이템은 영향받지 않는다.
   */
  const clearWaiting = useCallback(() => {
    setQueueSync((prev) => prev.filter((it) => it.status !== 'waiting'));
  }, [setQueueSync]);

  /* ── 공개 API: reset ─── */

  /**
   * 큐 전체를 초기화한다.
   * 주의: 처리 중인 API 요청은 취소되지 않으며 응답이 오면 무시된다.
   */
  const reset = useCallback(() => {
    isRunningRef.current = false;
    queueRef.current = [];
    setQueue([]);
    setCurrentIndex(-1);
  }, []);

  /* ── 파생 상태 ─── */
  const isProcessing = currentIndex !== -1;
  const pendingCount = queue.filter((it) => it.status === 'waiting').length;

  /**
   * 특정 메시지 ID에 해당하는 큐 아이템의 대기 순번을 반환한다.
   * waiting 아이템 중에서의 1-based 순번이며, 해당 아이템이 없으면 -1을 반환한다.
   *
   * @param {string} messageId
   * @returns {number} 1-based 대기 순번 (-1이면 대기 중인 아이템 없음)
   */
  const getQueuePosition = useCallback((messageId) => {
    const waitingItems = queue.filter((it) => it.status === 'waiting');
    const idx = waitingItems.findIndex((it) => it.messageId === messageId);
    return idx === -1 ? -1 : idx + 1;
  }, [queue]);

  return {
    queue,
    currentIndex,
    isProcessing,
    pendingCount,
    enqueue,
    skip,
    clearWaiting,
    reset,
    getQueuePosition,
  };
}
