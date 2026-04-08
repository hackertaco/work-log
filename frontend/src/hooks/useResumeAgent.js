import { useState, useCallback, useRef } from 'preact/hooks';

/**
 * useResumeAgent — SSE 스트리밍 기반 에이전트 통신 훅.
 *
 * POST /api/resume/agent 엔드포인트로 요청을 보내고
 * ReadableStream reader로 SSE 이벤트를 읽어 상태를 갱신한다.
 *
 * 반환값:
 *   messages     — 대화 메시지 배열 (role, content, timestamp, isQuestion?)
 *   loading      — 에이전트 요청 처리 중 여부
 *   progress     — 현재 진행 단계 (예: "searching_evidence") 또는 null
 *   sessionId    — 에이전트 세션 ID
 *   pendingDiff  — 승인 대기 중인 diff 제안 또는 null
 *   initSession  — 세션 초기화 함수
 *   sendMessage  — 사용자 메시지 전송 함수
 *   approveDiff  — diff 승인 함수
 *   rejectDiff   — diff 거절 함수
 *   reviseDiff   — diff 수정 요청 함수
 */
export function useResumeAgent() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [pendingDiff, setPendingDiff] = useState(null);
  const [progress, setProgress] = useState(null);

  // sessionId를 ref로도 보관하여 콜백 내에서 최신 값을 참조한다.
  const sessionIdRef = useRef(null);

  /**
   * POST /api/resume/agent 로 요청을 보내고 SSE 스트림을 읽는다.
   *
   * @param {Object} body — 요청 본문 (action, sessionId, text 등)
   */
  const postAgent = useCallback(async (body) => {
    setLoading(true);
    setProgress(null);

    try {
      const response = await fetch('/api/resume/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: err.error || '오류가 발생했어요.',
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      // ReadableStream reader로 SSE 스트림 읽기
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            // 세션 ID가 포함되어 있으면 저장
            if (event.sessionId && !sessionIdRef.current) {
              sessionIdRef.current = event.sessionId;
              setSessionId(event.sessionId);
            }

            switch (event.type) {
              case 'progress':
                setProgress(event.step);
                break;

              case 'message':
                setMessages((prev) => [
                  ...prev,
                  {
                    role: 'assistant',
                    content: event.content,
                    timestamp: Date.now(),
                  },
                ]);
                setProgress(null);
                break;

              case 'diff':
                setPendingDiff({
                  messageId: event.messageId,
                  section: event.section,
                  operation: event.operation,
                  payload: event.payload,
                  evidence: event.evidence,
                });
                break;

              case 'ask_user':
                setMessages((prev) => [
                  ...prev,
                  {
                    role: 'assistant',
                    content: event.question,
                    isQuestion: true,
                    timestamp: Date.now(),
                  },
                ]);
                setProgress(null);
                break;
            }
          } catch {
            /* malformed JSON — skip */
          }
        }
      }
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, []);

  /** 에이전트 세션 초기화 */
  const initSession = useCallback(
    () => postAgent({ action: 'init' }),
    [postAgent]
  );

  /** 사용자 메시지를 전송한다. 로컬 메시지 목록에 먼저 추가한 뒤 에이전트에 전달. */
  const sendMessage = useCallback(
    (text) => {
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: text, timestamp: Date.now() },
      ]);
      return postAgent({
        action: 'message',
        sessionId: sessionIdRef.current,
        text,
      });
    },
    [postAgent]
  );

  /** diff 승인 */
  const approveDiff = useCallback(
    async (messageId) => {
      const res = await fetch('/api/resume/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve_diff',
          sessionId: sessionIdRef.current,
          messageId,
        }),
      });
      if (res.ok) setPendingDiff(null);
    },
    []
  );

  /** diff 거절 */
  const rejectDiff = useCallback(
    async (messageId) => {
      const res = await fetch('/api/resume/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reject_diff',
          sessionId: sessionIdRef.current,
          messageId,
        }),
      });
      if (res.ok) setPendingDiff(null);
    },
    []
  );

  /** diff 수정 요청 — 피드백과 함께 에이전트에 재요청 */
  const reviseDiff = useCallback(
    (messageId, feedback) => {
      setPendingDiff(null);
      return postAgent({
        action: 'revise_diff',
        sessionId: sessionIdRef.current,
        messageId,
        feedback,
      });
    },
    [postAgent]
  );

  return {
    messages,
    loading,
    progress,
    sessionId,
    pendingDiff,
    initSession,
    sendMessage,
    approveDiff,
    rejectDiff,
    reviseDiff,
  };
}
