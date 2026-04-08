import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { navigate } from '../App.jsx';
import { ResumeShell } from '../components/resume/ResumeShell.jsx';
import { ResumeChatInput } from '../components/resume/chat/ResumeChatInput.jsx';
import { ResumeChatMessages } from '../components/resume/chat/ResumeChatMessages.jsx';
import { DraftInsightMessages } from '../components/resume/chat/DraftInsightMessages.jsx';
import { ResumeJsonDiffViewer } from '../components/resume/ResumeJsonDiffViewer.jsx';
import { CoverageFollowUpPanel } from '../components/resume/chat/CoverageFollowUpPanel.jsx';
import { parseResumeQuery } from '../lib/resumeQueryParser.js';
import { useSectionApplyQueue } from '../hooks/useSectionApplyQueue.js';
import { useDraftContext } from '../hooks/useDraftContext.js';
import { useResumeChat } from '../hooks/useResumeChat.js';
import { useResumeAgent } from '../hooks/useResumeAgent.js';

/** 에이전트 모드 활성화 플래그 — window.__RESUME_AGENT_ENABLED가 truthy일 때 에이전트 사용 */
const AGENT_ENABLED = typeof window !== 'undefined' && window.__RESUME_AGENT_ENABLED;

/**
 * ResumeChatPage — 채팅 기반 이력서 구체화 페이지 (/resume/chat)
 *
 * 세션별 독립 대화 (MVP: 대화 지속성 없음)
 * 사용자가 자유 텍스트로 질의하면:
 *   1. parseResumeQuery()로 파싱 (ResumeChatInput 내부에서 처리)
 *   2. /api/resume/chat POST 전송
 *   3. 응답 메시지를 대화 목록에 추가
 *
 * 로딩 상태는 ResumeChatMessages의 ThinkingIndicator와
 * ResumeChatInput의 비활성화로 표시된다.
 *
 * Diff 흐름:
 *   어시스턴트 응답에 diff 필드가 포함되면 ResumeDiffViewer가 렌더링된다.
 *   사용자가 approve/reject 버튼을 클릭하면 handleDiffApprove/Reject가 호출된다.
 *   - approve: PATCH /api/resume/section 으로 섹션 변경을 저장하고 diffStatus를 'approved'로 변경
 *   - reject: diffStatus를 'rejected'로 변경 (서버 호출 없음)
 */
export function ResumeChatPage() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  /* ─── 에이전트 모드 (AGENT_ENABLED 플래그 뒤) ─────────────────────────────────
   *
   * 훅은 항상 호출해야 하므로 조건부 호출은 하지 않는다.
   * AGENT_ENABLED일 때만 agent 훅의 값을 실제로 사용한다.
   */
  const agent = useResumeAgent();

  /** 에이전트 모드: 마운트 시 세션 초기화 */
  useEffect(() => {
    if (AGENT_ENABLED) {
      agent.initSession();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 초안 로딩 완료 시 드래프트 객체를 보관한다 (향후 채팅 컨텍스트에 활용) */
  const [draft, setDraft] = useState(null);

  /* ─── Sub-AC 3: 초안 데이터를 채팅 메시지 형태로 표시 ────────────────────────
   *
   * useDraftContext를 직접 사용하여 DraftInsightMessages에 상태를 전달한다.
   * 강점/경력 항목 클릭 시 해당 내용에 대한 채팅 질의를 자동으로 트리거한다.
   */
  const {
    draft: insightDraft,
    status: insightStatus,
    generating: insightGenerating,
    error: insightError,
    progress: insightProgress,
    generate: insightRetry,
  } = useDraftContext({ autoGenerate: true });

  /** insightDraft가 준비되면 draft 상태에도 반영 (기존 ResumeDraftPanel 호환) */
  useEffect(() => {
    if (insightStatus === 'ready' && insightDraft) {
      setDraft(insightDraft);
    }
  }, [insightStatus, insightDraft]);

  /** Sub-AC 3: 강점 항목 클릭 → 해당 강점에 대한 어필 포인트 검색 트리거 */
  const handleStrengthClick = useCallback((strength) => {
    const query = `"${strength.label}" 강점에 대한 어필 포인트를 찾아줘`;
    const parsed = parseResumeQuery(query);
    handleSubmitRef.current?.(parsed);
  }, []);

  /** Sub-AC 3: 경력 항목 클릭 → 해당 경력에 대한 어필 포인트 검색 트리거 */
  const handleExperienceClick = useCallback((experience) => {
    const query = `${experience.company} 경력의 주요 성과 어필 포인트를 찾아줘`;
    const parsed = parseResumeQuery(query);
    handleSubmitRef.current?.(parsed);
  }, []);

  const handleCompanyClick = useCallback((companyStory) => {
    const query = `${companyStory.company}에서 내가 주도한 대표 프로젝트와 증명된 역량을 정리해줘`;
    const parsed = parseResumeQuery(query);
    handleSubmitRef.current?.(parsed);
  }, []);

  const handleProjectClick = useCallback((companyStory, project) => {
    const query = `${companyStory.company}의 "${project.title}" 프로젝트를 문제-해결-결과 중심으로 이력서용으로 정리해줘`;
    const parsed = parseResumeQuery(query);
    handleSubmitRef.current?.(parsed);
  }, []);

  const handleCapabilityClick = useCallback((companyStory, capability) => {
    const query = `${companyStory.company} 경험에서 "${capability}" 역량이 드러나는 근거를 정리해줘`;
    const parsed = parseResumeQuery(query);
    handleSubmitRef.current?.(parsed);
  }, []);

  /** handleSubmit의 최신 버전을 보관하는 ref (클릭 핸들러에서 참조) */
  const handleSubmitRef = useRef(null);

  /* ─── 이력서 JSON diff 검토 상태 (Sub-AC 5-3) ──────────────────────────────
   *
   * 세션 시작 시 이력서 JSON을 로드해 initialResume에 저장하고,
   * 섹션 승인 완료 후 최신 이력서를 가져와 ResumeJsonDiffViewer로 변경 내용을 표시한다.
   */
  const [initialResume, setInitialResume] = useState(null);
  const [currentResume, setCurrentResume] = useState(null);
  const [showDiffPanel, setShowDiffPanel] = useState(false);
  const [approvedCount, setApprovedCount] = useState(0);
  const initialResumeFetched = useRef(false);

  /** 배치 처리에서 성공적으로 반영된 섹션 수를 추적하는 ref (onAllDone에서 알림 표시에 사용) */
  const approvedInBatchRef = useRef(0);

  /**
   * scrollToFirstPendingDiff 의 최신 버전을 보관하는 ref.
   *
   * useSectionApplyQueue onAllDone 콜백은 빈 의존성 배열([])로 생성되므로
   * 렌더 시점의 messages 클로저를 직접 참조할 수 없다.
   * useEffect 로 최신 함수를 여기에 동기화한 뒤, onAllDone 에서 ref 를 통해 호출한다.
   */
  const scrollToFirstPendingDiffRef = useRef(null);

  /** 세션 시작 시 현재 이력서 JSON을 로드해 diff 기준점으로 보관한다 */
  useEffect(() => {
    if (initialResumeFetched.current) return;
    initialResumeFetched.current = true;

    fetch('/api/resume', { credentials: 'include' })
      .then((res) => {
        if (res.ok) return res.json();
        return null;
      })
      .then((data) => {
        if (data) setInitialResume(data);
      })
      .catch(() => { /* 비치명적 — diff 기능만 비활성화됨 */ });
  }, []);

  /**
   * 최신 이력서를 서버에서 가져와 currentResume을 갱신한다.
   * 섹션 승인 완료 후 호출된다.
   */
  const refreshCurrentResume = useCallback(async () => {
    try {
      const res = await fetch('/api/resume', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCurrentResume(data);
        setApprovedCount((c) => c + 1);
      }
    } catch {
      /* 비치명적 */
    }
  }, []);

  /**
   * 고유 메시지 ID 생성
   */
  function makeId() {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /* ─── 섹션 반영 큐 ───────────────────────────────────────────────────────────
   *
   * 사용자가 여러 diff를 approve할 때 요청을 순서대로 처리하기 위한 큐.
   *
   * onItemDone: 아이템 처리 완료 시 해당 메시지의 diffStatus를 'approved'로 갱신
   * onItemError: 아이템 처리 실패 시 diffStatus를 'pending'으로 롤백 + 오류 메시지 추가
   */
  const {
    queue: applyQueue,
    currentIndex: applyQueueCurrentIndex,
    isProcessing: isApplying,
    pendingCount: applyPendingCount,
    enqueue: enqueueApply,
    skip: skipApply,
    clearWaiting: clearWaitingApply,
    getQueuePosition,
  } = useSectionApplyQueue({
    sessionId,
    onItemStart: useCallback((_item) => {
      // 처리 시작 콜백: diffStatus는 'queued'를 유지하고
      // isCurrentlyProcessing 은 getQueueMeta() 에서 파생된다.
      // (applyQueueCurrentIndex 가 갱신되면 ResumeChatMessages가 자동으로 재렌더링됨)
    }, []),
    onItemDone: useCallback((item) => {
      // 처리 완료: 해당 메시지의 diffStatus를 'approved'로 갱신
      setMessages((prev) =>
        prev.map((m) =>
          m.id === item.messageId ? { ...m, diffStatus: 'approved' } : m
        )
      );
      // 이 배치에서 처리 완료된 섹션 수를 누적한다 (onAllDone에서 사용)
      approvedInBatchRef.current += 1;
      // 최신 이력서를 가져와 diff 비교에 활용한다 (Sub-AC 5-3)
      refreshCurrentResume();
    }, [refreshCurrentResume]),
    onItemError: useCallback((item) => {
      // 처리 실패: diffStatus를 'pending'으로 롤백 + 오류 메시지 추가
      setMessages((prev) => [
        ...prev.map((m) =>
          m.id === item.messageId ? { ...m, diffStatus: 'pending' } : m
        ),
        {
          id: `msg-${Date.now()}-err`,
          role: 'system',
          content: `섹션 저장 실패 (${item.section}): ${item.error || '알 수 없는 오류'}`,
          timestamp: Date.now(),
          error: true,
        },
      ]);
    }, []),
    onAllDone: useCallback(() => {
      // 큐의 모든 섹션 처리 완료 — 성공적으로 반영된 섹션 수를 시스템 메시지로 표시한다.
      const count = approvedInBatchRef.current;
      approvedInBatchRef.current = 0; // 다음 배치를 위해 초기화
      if (count > 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-alldone`,
            role: 'system',
            content: `✓ ${count}개 섹션이 이력서에 반영되었습니다.`,
            timestamp: Date.now(),
          },
        ]);
      }

      // 큐 처리 완료 후 아직 검토하지 않은 diff 가 남아있으면 해당 메시지로 안내한다.
      // setTimeout 으로 setMessages 상태 업데이트가 완전히 적용된 뒤 탐색한다.
      setTimeout(() => {
        scrollToFirstPendingDiffRef.current?.();
      }, 150);
    }, []),
  });

  /**
   * 사용자 메시지를 목록에 추가하고 API 호출을 시작한다.
   * @param {ReturnType<import('../lib/resumeQueryParser.js').parseResumeQuery>} parsedQuery
   */
  const handleSubmit = useCallback(async (parsedQuery) => {
    if (loading) return;

    // 사용자 메시지를 즉시 추가
    const userMessage = {
      id: makeId(),
      role: 'user',
      content: parsedQuery.raw,
      parsedQuery,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);

    try {
      const res = await fetch('/api/resume/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          query: parsedQuery.raw,
          parsedQuery: {
            intent: parsedQuery.intent,
            keywords: parsedQuery.keywords,
            section: parsedQuery.section,
            dateRange: parsedQuery.dateRange,
          },
          history: messages.map((m) => ({ role: m.role, content: m.content })),
          // 초안 컨텍스트를 함께 전달해 LLM이 업무 로그 근거를 활용할 수 있게 한다.
          // draft가 없으면 null — 서버는 null draft를 무시한다.
          draftContext: draft
            ? {
                dateRange: draft.dateRange,
                companyStories: draft.companyStories,
                strengthCandidates: draft.strengthCandidates,
                experienceSummaries: draft.experienceSummaries,
                suggestedSummary: draft.suggestedSummary,
                dataGaps: draft.dataGaps,
              }
            : null,
        }),
      });

      if (res.status === 401 || res.status === 403) {
        navigate('/login');
        return;
      }

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || `서버 오류: HTTP ${res.status}`);
      }

      const data = await res.json();

      const assistantMessage = {
        id: makeId(),
        role: 'assistant',
        content: data.reply ?? data.message ?? '응답을 받았습니다.',
        timestamp: Date.now(),
        // diff 제안이 있으면 포함한다: { section, before, after, evidence? }
        diff: data.diff ?? null,
        // diff가 있으면 기본 상태는 'pending', 없으면 null
        diffStatus: data.diff ? 'pending' : null,
        // 전체 JSON diff 제안이 있으면 포함한다: { original, modified, evidence? }
        // 이력서 전체 변경을 한 번에 보여줄 때 사용 (ResumeJsonDiffViewer 렌더링)
        jsonDiff: data.jsonDiff ?? null,
        jsonDiffStatus: data.jsonDiff ? 'pending' : null,
        // Sub-AC 3: 백엔드 정규화된 citations 우선, 폴백으로 rankedEvidence
        citations:
          Array.isArray(data.citations) && data.citations.length > 0
            ? data.citations
            : Array.isArray(data.rankedEvidence) && data.rankedEvidence.length > 0
              ? data.rankedEvidence
              : null,
        // "반영해줘" 의도 파싱 결과 (Sub-AC 5-1).
        // section, changes, confidence, ambiguous, clarificationNeeded, sourceMessageIndex 포함.
        // 후속 AC에서 approve/reject UI 렌더링에 활용한다.
        applyIntent: data.applyIntent ?? null,
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      const errorMessage = {
        id: makeId(),
        role: 'assistant',
        content: `오류가 발생했습니다: ${err.message}`,
        timestamp: Date.now(),
        error: true,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  }, [loading, messages, sessionId]);

  /** Sub-AC 3: handleSubmit ref를 항상 최신 버전으로 동기화
   *  에이전트 모드에서도 클릭 핸들러가 올바른 submit을 사용하도록
   *  effectiveSubmit이 아닌 handleSubmit을 사용한다 (effectiveSubmit은 아직 정의 전).
   *  effectiveSubmit 정의 후 아래에서 다시 동기화한다.
   */
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  /* ─── 자동 스크롤 (Sub-AC 7-3) ──────────────────────────────────────────────────
   *
   * approve/reject 직후 다음 검토 대상 diff로 자동 스크롤하는 함수들.
   * 큐의 다음 섹션으로 자동 진행하는 플로우의 핵심 UX 요소이다.
   */

  /**
   * 메시지 ID에 해당하는 DOM 요소로 부드럽게 스크롤한다.
   *
   * block: 'start' 를 사용해 diff 뷰어의 상단이 스크롤 컨테이너 상단에
   * 위치하도록 하여 사용자가 diff 내용 전체를 즉시 확인할 수 있게 한다.
   *
   * @param {string} messageId 스크롤 대상 메시지 ID
   */
  const scrollToMessage = useCallback((messageId) => {
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-message-id="${messageId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }, []);

  /**
   * 현재 메시지 이후에 있는 다음 pending diff 메시지로 부드럽게 스크롤한다.
   *
   * approve/reject 직후 사용자가 다음 검토 대상을 즉시 확인할 수 있도록
   * 자동으로 스크롤 위치를 이동시킨다.
   *
   * DOM 탐색은 `data-message-id` 속성(ResumeChatMessages의 MessageBubble에 추가됨)을
   * 사용해 메시지 요소를 찾는다.
   *
   * @param {string} currentMessageId  방금 처리(승인/거절)한 메시지 ID
   */
  const scrollToNextPendingDiff = useCallback((currentMessageId) => {
    const currentIdx = messages.findIndex((m) => m.id === currentMessageId);
    if (currentIdx === -1) return;

    // 현재 메시지 이후에 있는 첫 번째 pending diff 메시지를 탐색한다.
    const nextPending = messages.find(
      (m, idx) => idx > currentIdx && m.diff && m.diffStatus === 'pending'
    );
    if (!nextPending) return;

    // block: 'start' — diff 뷰어 상단이 스크롤 컨테이너 상단에 위치해 내용 전체가 바로 보인다.
    scrollToMessage(nextPending.id);
  }, [messages, scrollToMessage]);

  /**
   * 메시지 목록에서 첫 번째 pending diff 메시지로 스크롤한다.
   *
   * 큐 처리 완료(onAllDone) 후 아직 검토하지 않은 diff 가 남아있을 때
   * 사용자를 해당 diff 로 안내한다.
   *
   * @returns {boolean} 스크롤 대상을 찾아 스크롤을 예약했으면 true, 없으면 false
   */
  const scrollToFirstPendingDiff = useCallback(() => {
    const firstPending = messages.find((m) => m.diff && m.diffStatus === 'pending');
    if (!firstPending) return false;

    scrollToMessage(firstPending.id);
    return true;
  }, [messages, scrollToMessage]);

  /** scrollToFirstPendingDiff ref 를 항상 최신 버전으로 동기화한다 */
  useEffect(() => {
    scrollToFirstPendingDiffRef.current = scrollToFirstPendingDiff;
  }, [scrollToFirstPendingDiff]);

  /**
   * Diff 승인 처리 — 섹션 반영 요청을 큐에 추가한다.
   *
   * 큐가 처리 중이 아니면 즉시 처리를 시작하고,
   * 처리 중이면 대기열 끝에 추가하여 순서대로 처리된다.
   *
   * 처리 결과는 useSectionApplyQueue의 onItemDone/onItemError 콜백에서 처리된다:
   *   - 성공 시: diffStatus → 'approved'
   *   - 실패 시: diffStatus → 'pending' 롤백 + 오류 메시지 추가
   *
   * 승인 후 다음 pending diff가 있으면 해당 메시지로 자동 스크롤한다.
   *
   * @param {string} messageId 승인할 메시지의 ID
   */
  const handleDiffApprove = useCallback((messageId) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || !msg.diff || msg.diffStatus !== 'pending') return;

    // 다음 pending diff로 자동 스크롤 (상태 변경 전에 호출해 현재 messages 기준으로 탐색)
    scrollToNextPendingDiff(messageId);

    // 낙관적 UI: 즉시 'queued' 상태로 표시 (처리 완료 전 중복 클릭 방지)
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, diffStatus: 'queued' } : m
      )
    );

    // 큐에 추가 — 큐가 비어있으면 즉시 처리 시작
    enqueueApply({
      messageId,
      section: msg.diff.section,
      content: msg.diff.after,
    });
  }, [messages, enqueueApply, scrollToNextPendingDiff]);

  /**
   * Diff 거절 처리 — diff를 폐기하고 이전 상태로 복원하며 UI를 초기화한다.
   *
   * pending 상태: 서버 호출 없이 메시지 상태만 'rejected'로 변경한다.
   *               이력서는 diff 적용 전 상태 그대로이므로 별도 복원 불필요.
   * queued 상태:  큐에서 아이템을 제거(skip)한 뒤 'rejected'로 변경한다.
   *               - waiting 아이템: skip → 'rejected'
   *               - processing 아이템: 이미 반영 중 → 거절 불가 (무시)
   *               - 아이템 없음(clearWaiting으로 이미 제거됨): 'rejected'로만 변경
   *
   * 어떤 경우에도 서버(이력서 저장) 호출은 발생하지 않는다.
   * diff 데이터(before/after/evidence)는 사용자 참고용으로 유지된다.
   *
   * 거절 후 다음 pending diff가 있으면 해당 메시지로 자동 스크롤한다.
   *
   * @param {string} messageId 거절할 메시지의 ID
   */
  const handleDiffReject = useCallback((messageId) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || !msg.diff) return;

    // pending / queued 상태만 거절 가능
    if (msg.diffStatus !== 'pending' && msg.diffStatus !== 'queued') return;

    // queued 상태인 경우 — 큐에서 해당 아이템을 처리한다.
    if (msg.diffStatus === 'queued') {
      const waitingItem = applyQueue.find(
        (it) => it.messageId === messageId && it.status === 'waiting'
      );

      if (waitingItem) {
        // waiting 아이템이 있으면 큐에서 제거(skip)한다.
        skipApply(waitingItem.id);
      } else {
        // waiting 아이템 없음 — processing 중이면 취소 불가(무시)
        const isProcessingNow = applyQueue.some(
          (it) => it.messageId === messageId && it.status === 'processing'
        );
        if (isProcessingNow) return;
        // clearWaiting으로 이미 제거된 경우: diffStatus만 'rejected'로 갱신한다.
      }
    }

    // 다음 pending diff로 자동 스크롤 (상태 변경 전에 호출해 현재 messages 기준으로 탐색)
    scrollToNextPendingDiff(messageId);

    // diffStatus를 'rejected'로 설정하여 UI를 초기화한다.
    // 이력서는 diff가 한 번도 반영되지 않은 상태(before)이므로 별도 복원 없음.
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, diffStatus: 'rejected' } : m
      )
    );
  }, [messages, applyQueue, skipApply, scrollToNextPendingDiff]);

  /**
   * 큐 전체 취소 처리 — QueueStatusBar의 "취소" 버튼 클릭 시 호출된다.
   *
   * clearWaiting()은 큐에서 waiting 아이템을 제거하지만 메시지의 diffStatus는
   * 변경하지 않으므로, waiting 아이템과 연결된 메시지의 diffStatus를 동시에
   * 'rejected'로 갱신해 UI 불일치를 방지한다.
   *
   * 처리 흐름:
   *   1. 현재 waiting 상태인 큐 아이템의 messageId를 수집한다.
   *   2. 해당 messageId의 메시지 diffStatus를 'rejected'로 갱신한다.
   *   3. clearWaiting()으로 큐에서 waiting 아이템을 제거한다.
   */
  const handleClearWaiting = useCallback(() => {
    // waiting 아이템에 연결된 메시지 ID 수집
    const waitingMessageIds = new Set(
      applyQueue
        .filter((it) => it.status === 'waiting')
        .map((it) => it.messageId)
    );

    if (waitingMessageIds.size > 0) {
      // 해당 메시지의 diffStatus를 'rejected'로 갱신 (UI 초기화)
      setMessages((prev) =>
        prev.map((m) =>
          waitingMessageIds.has(m.id) ? { ...m, diffStatus: 'rejected' } : m
        )
      );
    }

    // 큐에서 waiting 아이템 제거
    clearWaitingApply();
  }, [applyQueue, clearWaitingApply]);

  /**
   * 각 메시지의 큐 메타 정보를 반환한다.
   *
   * ResumeChatMessages → MessageBubble → ResumeDiffViewer로 전달되어
   * diff 뷰어에 큐 상태(대기 순서, 처리 중 여부)를 표시한다.
   *
   * 반환 구조:
   *   position    — number | null   큐에서의 1-based 순서 (없으면 null)
   *   isProcessing — boolean        현재 이 메시지의 섹션이 처리 중인지 여부
   *
   * @param {string} messageId
   * @returns {{ position: number|null, isProcessing: boolean }}
   */
  const getQueueMeta = useCallback((messageId) => {
    if (!applyQueue.length) return { position: null, isProcessing: false };

    // 현재 처리 중인 아이템이 이 메시지인지 확인
    const currentItem = applyQueueCurrentIndex >= 0 ? applyQueue[applyQueueCurrentIndex] : null;
    const isProcessing = !!(currentItem && currentItem.messageId === messageId);

    // 큐에서 이 메시지가 대기 중인 위치 계산
    // (waiting + processing 상태 아이템 중 순서, 1-based)
    const activeItems = applyQueue.filter(
      (it) => it.status === 'waiting' || it.status === 'processing'
    );
    const idx = activeItems.findIndex((it) => it.messageId === messageId);
    const position = idx >= 0 ? idx + 1 : null;

    return { position, isProcessing };
  }, [applyQueue, applyQueueCurrentIndex]);

  /**
   * 이력서 전체 JSON diff 승인 처리 — 전체 변경 사항을 이력서에 반영한다.
   *
   * PATCH /api/resume/json-diff-apply 로 서버에 수정된 JSON을 전달하고
   * jsonDiffStatus를 'approved'로 갱신한다.
   * 처리 실패 시 'pending'으로 롤백하고 오류 메시지를 추가한다.
   *
   * @param {string} messageId 승인할 메시지의 ID
   */
  const handleJsonDiffApprove = useCallback(async (messageId) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || !msg.jsonDiff || msg.jsonDiffStatus !== 'pending') return;

    // 낙관적 UI: 즉시 승인 상태로 표시 (중복 클릭 방지)
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, jsonDiffStatus: 'approved' } : m
      )
    );

    try {
      const res = await fetch('/api/resume/json-diff-apply', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modified: msg.jsonDiff.modified }),
      });

      if (res.status === 401 || res.status === 403) {
        navigate('/login');
        return;
      }

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || `서버 오류: HTTP ${res.status}`);
      }
    } catch (err) {
      // 실패 시 롤백 + 오류 메시지 추가
      setMessages((prev) => [
        ...prev.map((m) =>
          m.id === messageId ? { ...m, jsonDiffStatus: 'pending' } : m
        ),
        {
          id: `msg-${Date.now()}-err`,
          role: 'system',
          content: `이력서 JSON 반영 실패: ${err.message}`,
          timestamp: Date.now(),
          error: true,
        },
      ]);
    }
  }, [messages]);

  /**
   * 이력서 전체 JSON diff 거절 처리 — 변경 사항을 폐기한다.
   * 서버 호출 없이 메시지 상태만 'rejected'로 변경한다.
   *
   * @param {string} messageId 거절할 메시지의 ID
   */
  const handleJsonDiffReject = useCallback((messageId) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || !msg.jsonDiff || msg.jsonDiffStatus !== 'pending') return;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, jsonDiffStatus: 'rejected' } : m
      )
    );
  }, [messages]);

  /**
   * 예시 질의 버튼 클릭 처리 — 환영 메시지의 예시 버튼을 클릭하면
   * 해당 텍스트를 입력창에 채워넣는 대신 바로 제출한다.
   */
  function handleExampleClick(e) {
    const btn = e.target.closest('[data-example]');
    if (!btn) return;
    const exampleText = btn.dataset.example;
    if (!exampleText) return;

    const parsed = parseResumeQuery(exampleText);
    handleSubmit(parsed);
  }

  /**
   * 에이전트 모드에서 사용할 submit 핸들러.
   * AGENT_ENABLED일 때 기존 handleSubmit 대신 agent.sendMessage를 호출한다.
   * parsedQuery.raw 텍스트를 에이전트에 전달한다.
   */
  const handleSubmitForAgent = useCallback((parsedQuery) => {
    if (AGENT_ENABLED) {
      return agent.sendMessage(parsedQuery.raw);
    }
    return handleSubmit(parsedQuery);
  }, [agent.sendMessage, handleSubmit]);

  /** 실제로 사용할 submit 핸들러 — 에이전트 모드 여부에 따라 분기 */
  const effectiveSubmit = AGENT_ENABLED ? handleSubmitForAgent : handleSubmit;

  /** 에이전트 모드에서도 클릭 핸들러(강점/경력)가 올바른 submit을 호출하도록 ref를 재동기화 */
  useEffect(() => {
    handleSubmitRef.current = effectiveSubmit;
  }, [effectiveSubmit]);
  /** 실제로 표시할 메시지 — 에이전트 모드이면 agent.messages를 우선 사용 */
  const effectiveMessages = AGENT_ENABLED ? agent.messages : messages;
  /** 실제 로딩 상태 */
  const effectiveLoading = AGENT_ENABLED ? agent.loading : loading;

  return (
    <ResumeShell activePage="chat">
      <div class="rcp-root" onClick={handleExampleClick}>
        {/* ── 메시지 목록 (초안 패널 + 대화 기록) ── */}
        <div class="rcp-messages-area">
          {/* Sub-AC 3: 강점 후보·경력별 경험 요약을 채팅 메시지 형태로 즉시 표시 */}
          <DraftInsightMessages
            draft={insightDraft}
            status={insightStatus}
            error={insightError}
            onRetry={insightRetry}
            onCompanyClick={handleCompanyClick}
            onProjectClick={handleProjectClick}
            onCapabilityClick={handleCapabilityClick}
            onStrengthClick={handleStrengthClick}
            onExperienceClick={handleExperienceClick}
          />

          <ResumeChatMessages
            messages={effectiveMessages}
            loading={effectiveLoading}
            hasDraft={!!draft}
            onDiffApprove={handleDiffApprove}
            onDiffReject={handleDiffReject}
            onJsonDiffApprove={handleJsonDiffApprove}
            onJsonDiffReject={handleJsonDiffReject}
            getQueueMeta={getQueueMeta}
          />
        </div>

        {/* ── 섹션 반영 큐 상태 표시줄 ──
         *  큐에 대기 중이거나 처리 중인 아이템이 있을 때만 표시된다.
         *  큐 아이템 목록(applyQueue)에서 현재 처리 중인 아이템(currentIndex)을
         *  직접 참조해 진행 중인 섹션 이름을 표시한다.
         */}
        {(isApplying || applyPendingCount > 0) && (
          <QueueStatusBar
            queue={applyQueue}
            currentIndex={applyQueueCurrentIndex}
            pendingCount={applyPendingCount}
            isProcessing={isApplying}
            onClearWaiting={handleClearWaiting}
          />
        )}

        {/* ── 이력서 변경 내용 검토 패널 (Sub-AC 5-3) ──
         *  세션 중 섹션이 승인(approved)된 경우 표시된다.
         *  initialResume(세션 시작 시 로드)과 currentResume(최신)을 ResumeJsonDiffViewer로 비교한다.
         */}
        {approvedCount > 0 && initialResume && currentResume && (
          <div class="rcp-diff-bar">
            <span class="rcp-diff-bar-icon" aria-hidden="true">⇄</span>
            <span class="rcp-diff-bar-text">
              이 세션에서 {approvedCount}개 섹션이 반영됐습니다
            </span>
            <button
              class="rcp-diff-bar-btn"
              type="button"
              onClick={() => setShowDiffPanel(!showDiffPanel)}
              aria-expanded={showDiffPanel}
              aria-label={showDiffPanel ? '변경 내용 닫기' : '변경 내용 보기'}
            >
              {showDiffPanel ? '닫기' : '변경 내용 보기'}
            </button>
          </div>
        )}

        {/* ── 변경 내용 diff 패널 ── */}
        {showDiffPanel && initialResume && currentResume && (
          <div class="rcp-diff-panel">
            <ResumeJsonDiffViewer
              beforeJson={initialResume}
              afterJson={currentResume}
              title="세션 중 변경된 이력서 내용"
            />
          </div>
        )}

        {/* ── 에이전트 진행 상태 표시 (AGENT_ENABLED) ── */}
        {AGENT_ENABLED && agent.progress && (
          <AgentProgressBar step={agent.progress} />
        )}

        {/* ── 에이전트 diff 승인 UI (AGENT_ENABLED) ── */}
        {AGENT_ENABLED && agent.pendingDiff && (
          <AgentDiffApproval
            diff={agent.pendingDiff}
            onApprove={() => agent.approveDiff(agent.pendingDiff.messageId)}
            onReject={() => agent.rejectDiff(agent.pendingDiff.messageId)}
            onRevise={(feedback) => agent.reviseDiff(agent.pendingDiff.messageId, feedback)}
          />
        )}

        {/* ── 입력창 ── */}
        <ResumeChatInput
          onSubmit={effectiveSubmit}
          loading={effectiveLoading}
        />
      </div>

      <style>{RCP_CSS}</style>
    </ResumeShell>
  );
}

/* ── QueueStatusBar 컴포넌트 ────────────────────────────────────────────────── */

/**
 * QueueStatusBar — 섹션 반영 큐의 처리 현황을 입력창 바로 위에 표시하는 컴포넌트.
 *
 * 큐에 대기 중이거나 처리 중인 아이템이 있을 때만 ResumeChatPage에 의해 렌더링된다.
 *
 * Props:
 *   queue         — QueueItem[]   전체 큐 배열
 *   currentIndex  — number        현재 처리 중인 아이템 인덱스 (-1이면 처리 없음)
 *   pendingCount  — number        대기 중(waiting) 아이템 수
 *   isProcessing  — boolean       처리 중 여부
 *   onClearWaiting — () => void   대기 목록 전체 취소 콜백
 */
function QueueStatusBar({ queue, currentIndex, pendingCount, isProcessing, onClearWaiting }) {
  const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;
  const total = pendingCount + (isProcessing ? 1 : 0);

  return (
    <div class="rcp-queue-bar" role="status" aria-live="polite" aria-label="섹션 반영 큐 상태">
      {/* 스피너 + 진행 메시지 */}
      <div class="rcp-queue-bar-info">
        <span class="rcp-queue-spinner" aria-hidden="true" />
        <span class="rcp-queue-bar-text">
          {isProcessing && currentItem
            ? `"${currentItem.section}" 섹션 반영 중…`
            : `${pendingCount}개 섹션 반영 대기 중`}
        </span>
        {total > 1 && (
          <span class="rcp-queue-bar-count" aria-label={`${total}개 항목 대기`}>
            {total}개
          </span>
        )}
      </div>

      {/* 대기 취소 버튼 — 대기 아이템이 있을 때만 표시 */}
      {pendingCount > 0 && (
        <button
          class="rcp-queue-bar-cancel"
          type="button"
          onClick={onClearWaiting}
          title="대기 중인 섹션 반영 모두 취소"
          aria-label="대기 중인 섹션 반영 모두 취소"
        >
          취소
        </button>
      )}
    </div>
  );
}

/* ── AgentProgressBar 컴포넌트 ─────────────────────────────────────────────── */

/** 에이전트 진행 단계를 표시하는 바. AGENT_ENABLED일 때만 렌더링된다. */
const AGENT_STEP_LABELS = {
  searching_evidence: '근거 자료 검색 중…',
  analyzing: '분석 중…',
  generating_diff: '변경 사항 생성 중…',
  thinking: '생각 중…',
};

function AgentProgressBar({ step }) {
  const label = AGENT_STEP_LABELS[step] || `${step}…`;
  return (
    <div class="rcp-agent-progress" role="status" aria-live="polite">
      <span class="rcp-queue-spinner" aria-hidden="true" />
      <span class="rcp-agent-progress-text">{label}</span>
    </div>
  );
}

/* ── AgentDiffApproval 컴포넌트 ────────────────────────────────────────────── */

/**
 * AgentDiffApproval — 에이전트가 제안한 diff를 승인/거절/수정할 수 있는 패널.
 *
 * Props:
 *   diff      — { messageId, section, operation, payload, evidence }
 *   onApprove — () => void
 *   onReject  — () => void
 *   onRevise  — (feedback: string) => void
 */
function AgentDiffApproval({ diff, onApprove, onReject, onRevise }) {
  const [reviseMode, setReviseMode] = useState(false);
  const [feedback, setFeedback] = useState('');

  const handleReviseSubmit = () => {
    if (!feedback.trim()) return;
    onRevise(feedback.trim());
    setReviseMode(false);
    setFeedback('');
  };

  return (
    <div class="rcp-agent-diff" role="region" aria-label="에이전트 변경 제안">
      <div class="rcp-agent-diff-header">
        <span class="rcp-agent-diff-section">{diff.section}</span>
        <span class="rcp-agent-diff-op">{diff.operation}</span>
      </div>

      {diff.payload && (
        <pre class="rcp-agent-diff-payload">{
          typeof diff.payload === 'string' ? diff.payload : JSON.stringify(diff.payload, null, 2)
        }</pre>
      )}

      {diff.evidence && (
        <div class="rcp-agent-diff-evidence">
          <span class="rcp-agent-diff-evidence-label">근거:</span> {diff.evidence}
        </div>
      )}

      {reviseMode ? (
        <div class="rcp-agent-diff-revise">
          <input
            class="rcp-agent-diff-revise-input"
            type="text"
            placeholder="수정 요청 사항을 입력하세요…"
            value={feedback}
            onInput={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleReviseSubmit()}
          />
          <button class="rcp-agent-diff-btn rcp-agent-diff-btn--revise" type="button" onClick={handleReviseSubmit}>
            전송
          </button>
          <button class="rcp-agent-diff-btn rcp-agent-diff-btn--cancel" type="button" onClick={() => { setReviseMode(false); setFeedback(''); }}>
            취소
          </button>
        </div>
      ) : (
        <div class="rcp-agent-diff-actions">
          <button class="rcp-agent-diff-btn rcp-agent-diff-btn--approve" type="button" onClick={onApprove}>
            승인
          </button>
          <button class="rcp-agent-diff-btn rcp-agent-diff-btn--reject" type="button" onClick={onReject}>
            거절
          </button>
          <button class="rcp-agent-diff-btn rcp-agent-diff-btn--revise" type="button" onClick={() => setReviseMode(true)}>
            수정 요청
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const RCP_CSS = `
  .rcp-root {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 92px); /* 헤더 + 상하 여백 */
    overflow: hidden;
    margin: 0;
    padding: 0;
    width: 100%;
    max-width: 1080px;
    margin-left: auto;
    margin-right: auto;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.9));
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 28px;
    box-shadow:
      0 20px 44px rgba(15, 23, 42, 0.08),
      inset 0 1px 0 rgba(255, 255, 255, 0.55);
  }

  /* 채팅 페이지 전용 main 영역 재정의 */
  .resume-shell .resume-main:has(.rcp-root) {
    padding: 10px 0 28px;
    width: 100%;
    max-width: 100%;
  }

  /*
   * 메시지 영역 — 초안 패널 + 대화 기록을 함께 스크롤하는 컨테이너.
   * ResumeChatMessages(.rcm-root)가 내부에서 flex:1 을 가지므로
   * 이 래퍼는 flex:1 + overflow-y:auto 로 설정한다.
   */
  .rcp-messages-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    scroll-behavior: smooth;
    padding-top: 10px;
    padding-bottom: 8px;
  }

  /*
   * ResumeChatMessages 는 기본적으로 flex:1 + overflow-y:auto 이지만
   * rcp-messages-area 안에서는 스크롤을 부모에게 위임하므로
   * overflow 를 visible 로 재정의한다.
   */
  .rcp-messages-area .rcm-root {
    flex: 1;
    overflow-y: visible;
    min-height: 0;
  }

  .rcp-messages-area .rcm-root.rcm-empty {
    flex: 1;
    justify-content: center;
    align-items: center;
  }

  @media (max-width: 900px) {
    .rcp-root {
      height: calc(100vh - 78px);
      border-radius: 20px;
    }

    .resume-shell .resume-main:has(.rcp-root) {
      padding: 0;
    }
  }

  /* ─── 큐 상태 표시줄 ─── */
  .rcp-queue-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 6px var(--space-4);
    background: rgba(254, 243, 199, 0.95);
    border-top: 1px solid #fcd34d;
    border-bottom: 1px solid #fde68a;
    font-size: 12px;
    color: #92400e;
    flex-shrink: 0;
    animation: rcp-queue-bar-fadein 0.2s ease;
  }

  @keyframes rcp-queue-bar-fadein {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .rcp-queue-bar-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .rcp-queue-spinner {
    display: inline-block;
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(217, 119, 6, 0.25);
    border-top-color: #d97706;
    border-radius: 50%;
    animation: rcp-spin 0.8s linear infinite;
  }

  @keyframes rcp-spin {
    to { transform: rotate(360deg); }
  }

  .rcp-queue-bar-text {
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rcp-queue-bar-count {
    padding: 1px 7px;
    border-radius: 999px;
    background: rgba(217, 119, 6, 0.15);
    border: 1px solid rgba(217, 119, 6, 0.3);
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
    color: #b45309;
  }

  .rcp-queue-bar-cancel {
    flex-shrink: 0;
    background: none;
    border: 1px solid rgba(180, 83, 9, 0.35);
    border-radius: var(--radius-sm);
    padding: 2px 10px;
    font-size: 11px;
    font-weight: 600;
    color: #b45309;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    white-space: nowrap;
  }

  .rcp-queue-bar-cancel:hover {
    background: rgba(180, 83, 9, 0.08);
    border-color: #b45309;
  }

  /* ─── 이력서 변경 내용 알림 바 (Sub-AC 5-3) ─── */
  .rcp-diff-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px var(--space-4);
    background: rgba(239, 246, 255, 0.95);
    border-top: 1px solid #bfdbfe;
    border-bottom: 1px solid #dbeafe;
    font-size: 12px;
    color: #1e3a8a;
    flex-shrink: 0;
    animation: rcp-queue-bar-fadein 0.2s ease;
  }

  .rcp-diff-bar-icon {
    font-size: 13px;
    flex-shrink: 0;
    opacity: 0.7;
  }

  .rcp-diff-bar-text {
    flex: 1;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rcp-diff-bar-btn {
    flex-shrink: 0;
    background: none;
    border: 1px solid rgba(30, 64, 175, 0.35);
    border-radius: var(--radius-sm);
    padding: 2px 10px;
    font-size: 11px;
    font-weight: 600;
    color: #1e40af;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    white-space: nowrap;
  }

  .rcp-diff-bar-btn:hover {
    background: rgba(30, 64, 175, 0.08);
    border-color: #1e40af;
  }

  /* ─── 변경 내용 diff 패널 ─── */
  .rcp-diff-panel {
    flex-shrink: 0;
    overflow-y: auto;
    max-height: 320px;
    padding: var(--space-2) var(--space-4);
    background: rgba(245, 247, 255, 0.8);
    border-bottom: 1px solid #dbeafe;
    animation: rcp-queue-bar-fadein 0.2s ease;
  }

  .rcp-diff-panel .rjdv-root {
    margin: 0;
  }

  /* ─── 에이전트 진행 상태 바 ─── */
  .rcp-agent-progress {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px var(--space-4);
    background: rgba(236, 253, 245, 0.95);
    border-top: 1px solid #a7f3d0;
    border-bottom: 1px solid #d1fae5;
    font-size: 12px;
    color: #065f46;
    flex-shrink: 0;
    animation: rcp-queue-bar-fadein 0.2s ease;
  }

  .rcp-agent-progress-text {
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  /* ─── 에이전트 diff 승인 패널 ─── */
  .rcp-agent-diff {
    flex-shrink: 0;
    padding: var(--space-3) var(--space-4);
    background: rgba(245, 247, 255, 0.95);
    border-top: 1px solid #c7d2fe;
    border-bottom: 1px solid #e0e7ff;
    animation: rcp-queue-bar-fadein 0.2s ease;
  }

  .rcp-agent-diff-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .rcp-agent-diff-section {
    font-weight: 700;
    font-size: 13px;
    color: #312e81;
  }

  .rcp-agent-diff-op {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: rgba(99, 102, 241, 0.12);
    color: #4338ca;
    font-weight: 600;
  }

  .rcp-agent-diff-payload {
    font-size: 12px;
    line-height: 1.5;
    background: rgba(255, 255, 255, 0.7);
    border: 1px solid #e0e7ff;
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-2);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
    color: #1e1b4b;
  }

  .rcp-agent-diff-evidence {
    font-size: 11px;
    color: #6366f1;
    margin-bottom: var(--space-2);
  }

  .rcp-agent-diff-evidence-label {
    font-weight: 700;
  }

  .rcp-agent-diff-actions,
  .rcp-agent-diff-revise {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .rcp-agent-diff-btn {
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 4px 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }

  .rcp-agent-diff-btn--approve {
    background: #059669;
    color: #fff;
    border-color: #047857;
  }
  .rcp-agent-diff-btn--approve:hover {
    background: #047857;
  }

  .rcp-agent-diff-btn--reject {
    background: none;
    color: #dc2626;
    border-color: rgba(220, 38, 38, 0.35);
  }
  .rcp-agent-diff-btn--reject:hover {
    background: rgba(220, 38, 38, 0.06);
    border-color: #dc2626;
  }

  .rcp-agent-diff-btn--revise {
    background: none;
    color: #4338ca;
    border-color: rgba(67, 56, 202, 0.35);
  }
  .rcp-agent-diff-btn--revise:hover {
    background: rgba(67, 56, 202, 0.06);
    border-color: #4338ca;
  }

  .rcp-agent-diff-btn--cancel {
    background: none;
    color: #64748b;
    border-color: rgba(100, 116, 139, 0.35);
  }
  .rcp-agent-diff-btn--cancel:hover {
    background: rgba(100, 116, 139, 0.06);
  }

  .rcp-agent-diff-revise-input {
    flex: 1;
    border: 1px solid #c7d2fe;
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font-size: 12px;
    outline: none;
    background: #fff;
    color: #1e1b4b;
  }
  .rcp-agent-diff-revise-input:focus {
    border-color: #6366f1;
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
  }

  @media print {
    .rcp-root { display: none !important; }
  }
`;
