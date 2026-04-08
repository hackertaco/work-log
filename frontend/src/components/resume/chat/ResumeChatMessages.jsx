import { useState, useEffect, useRef } from 'preact/hooks';
import { summarizeParsedQuery } from '../../../lib/resumeQueryParser.js';
import { ResumeDiffViewer } from './ResumeDiffViewer.jsx';
import { ResumeJsonDiffViewer } from './ResumeJsonDiffViewer.jsx';
import { SourceCitations } from './SourceCitations.jsx';
// Sub-AC 2: 인라인 출처 배지
import { InlineSourceBadge, parseInlineCitations } from './InlineSourceBadge.jsx';
// Sub-AC 8-1: 강점 섹션 전용 뷰어
import { StrengthsSectionViewer } from './StrengthsSectionViewer.jsx';
// Sub-AC 3: 근거 출처 요약 바
import { EvidenceSourceSummary } from './EvidenceSourceSummary.jsx';

/**
 * ResumeChatMessages — 채팅 메시지 목록 컴포넌트
 *
 * Props:
 *   messages          — ChatMessage[]  대화 메시지 목록
 *   loading           — boolean        마지막 응답 대기 중 여부
 *   onDiffApprove     — (messageId: string) => void  섹션 텍스트 diff 승인 콜백 (optional)
 *   onDiffReject      — (messageId: string) => void  섹션 텍스트 diff 거절 콜백 (optional)
 *   onJsonDiffApprove — (messageId: string) => void  전체 JSON diff 승인 콜백 (optional)
 *   onJsonDiffReject  — (messageId: string) => void  전체 JSON diff 거절 콜백 (optional)
 *   getQueueMeta      — (messageId: string) => { position: number|null, isProcessing: boolean }
 *                       각 메시지의 큐 메타 정보를 반환하는 콜백 (optional)
 *                       position: 큐에서의 1-based 순서 (null이면 해당 없음)
 *                       isProcessing: 현재 이 항목이 처리 중인지 여부
 *
 * ChatMessage 구조:
 *   id              — string  고유 ID
 *   role            — 'user' | 'assistant' | 'system'
 *   content         — string  메시지 텍스트
 *   parsedQuery?    — ReturnType<parseResumeQuery>  사용자 메시지의 파싱 결과
 *   timestamp       — number  Unix timestamp (ms)
 *   error           — boolean (optional) 오류 메시지 여부
 *   diff            — ResumeDiffProposal (optional) 단일 섹션 텍스트 수정 제안
 *   diffStatus      — 'pending' | 'queued' | 'approved' | 'rejected' (optional)
 *   jsonDiff        — ResumeJsonDiffProposal (optional) 이력서 전체 JSON 비교 제안
 *   jsonDiffStatus  — 'pending' | 'approved' | 'rejected' (optional)
 *
 * ResumeDiffProposal 구조:
 *   section   — string    섹션 이름
 *   before    — string    기존 텍스트
 *   after     — string    수정 제안 텍스트
 *   evidence  — string[]  수정 근거 (optional)
 *
 * ResumeJsonDiffProposal 구조:
 *   original  — object    원본 이력서 JSON
 *   modified  — object    수정된 이력서 JSON
 *   evidence  — string[]  변경 근거 목록 (optional)
 */
export function ResumeChatMessages({
  messages = [],
  loading = false,
  hasDraft = false,
  onDiffApprove,
  onDiffReject,
  onJsonDiffApprove,
  onJsonDiffReject,
  getQueueMeta,
}) {
  const bottomRef = useRef(null);
  const scrollRef = useRef(null);

  // 마지막 사용자 메시지의 parsedQuery를 로딩 인디케이터에 전달한다.
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const loadingQuery = loading ? (lastUserMsg?.parsedQuery ?? null) : null;

  // 새 메시지가 추가되면 스크롤 아래로 이동
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, loading]);

  const showWelcome = messages.length === 0 && !hasDraft;

  if (showWelcome && !loading) {
    return (
      <div class="rcm-root rcm-empty">
        <WelcomeMessage />
        <style>{RCM_CSS}</style>
      </div>
    );
  }

  return (
    <div class="rcm-root" ref={scrollRef}>
      {showWelcome && <WelcomeMessage />}

      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onDiffApprove={onDiffApprove ? () => onDiffApprove(msg.id) : undefined}
          onDiffReject={onDiffReject ? () => onDiffReject(msg.id) : undefined}
          onJsonDiffApprove={onJsonDiffApprove ? () => onJsonDiffApprove(msg.id) : undefined}
          onJsonDiffReject={onJsonDiffReject ? () => onJsonDiffReject(msg.id) : undefined}
          queueMeta={getQueueMeta ? getQueueMeta(msg.id) : null}
        />
      ))}

      {/* 응답 대기 중 로딩 인디케이터 (파싱된 쿼리 컨텍스트 포함) */}
      {loading && <ThinkingIndicator parsedQuery={loadingQuery} />}

      {/* 스크롤 앵커 */}
      <div ref={bottomRef} style={{ height: 1 }} />

      <style>{RCM_CSS}</style>
    </div>
  );
}

/* ── 개별 메시지 버블 ────────────────────────────────────────────────────────── */

/**
 * @param {{
 *   message: object,
 *   onDiffApprove?: () => void,
 *   onDiffReject?: () => void,
 *   queueMeta?: { position: number|null, isProcessing: boolean } | null,
 * }} props
 */
function MessageBubble({ message, onDiffApprove, onDiffReject, onJsonDiffApprove, onJsonDiffReject, queueMeta }) {
  const { role, content, parsedQuery, timestamp, error, diff, diffStatus, citations, jsonDiff, jsonDiffStatus } = message;
  const isUser = role === 'user';
  const isSystem = role === 'system';

  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : '';

  const queryMeta = isUser && parsedQuery ? summarizeParsedQuery(parsedQuery) : '';

  return (
    <div
      class={`rcm-row rcm-row--${isUser ? 'user' : isSystem ? 'system' : 'assistant'}`}
      data-message-id={message.id}
    >
      {!isUser && !isSystem && (
        <div class="rcm-avatar rcm-avatar--assistant" aria-hidden="true">
          AI
        </div>
      )}

      <div class="rcm-bubble-wrap">
        <div
          class={[
            'rcm-bubble',
            `rcm-bubble--${isUser ? 'user' : isSystem ? 'system' : 'assistant'}`,
            error ? 'rcm-bubble--error' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {/* 메시지 본문 — 어시스턴트 메시지는 인라인 출처 배지 렌더링 */}
          <MessageContent content={content} citations={!isUser && !isSystem ? citations : null} />

          {/* 파싱된 쿼리 메타 (사용자 메시지에만) */}
          {queryMeta && (
            <p class="rcm-query-meta" aria-label="파싱된 쿼리 정보">
              {queryMeta}
            </p>
          )}
        </div>

        {/* diff 뷰어 — 어시스턴트 메시지에 diff 제안이 있을 때 버블 아래에 렌더링.
         *
         * Sub-AC 8-1:
         *   강점(strengths) 섹션인 경우 StrengthsSectionViewer 로 렌더링한다.
         *   다른 섹션(summary, experience 등)은 기존 ResumeDiffViewer 를 사용한다.
         */}
        {!isUser && diff && diff.section === 'strengths' && Array.isArray(diff.strengthsData) ? (
          <StrengthsSectionViewer
            strengths={diff.strengthsData}
            before={diff.before ?? ''}
            evidence={Array.isArray(diff.evidence) ? diff.evidence : []}
            onApprove={onDiffApprove}
            onReject={onDiffReject}
            status={diffStatus ?? 'pending'}
          />
        ) : !isUser && diff ? (
          <ResumeDiffViewer
            section={diff.section}
            before={diff.before}
            after={diff.after}
            evidence={diff.evidence}
            onApprove={onDiffApprove}
            onReject={onDiffReject}
            status={diffStatus ?? 'pending'}
            queuePosition={queueMeta?.position ?? null}
            isCurrentlyProcessing={queueMeta?.isProcessing ?? false}
          />
        ) : null}

        {/* JSON diff 뷰어 — 이력서 전체 JSON 비교 제안이 있을 때 버블 아래에 렌더링.
         *  jsonDiff: { original, modified, evidence? }
         *  jsonDiffStatus: 'pending' | 'approved' | 'rejected'
         */}
        {!isUser && jsonDiff && jsonDiff.original && jsonDiff.modified && (
          <ResumeJsonDiffViewer
            original={jsonDiff.original}
            modified={jsonDiff.modified}
            evidence={jsonDiff.evidence ?? []}
            onApprove={onJsonDiffApprove}
            onReject={onJsonDiffReject}
            status={jsonDiffStatus ?? 'pending'}
          />
        )}

        {/* Sub-AC 3: 근거 출처 요약 바 — 소스 유형별 집계를 한 줄로 표시 */}
        {!isUser && !isSystem && citations && citations.length > 0 && (
          <EvidenceSourceSummary citations={citations} compact />
        )}

        {/* 출처 정보 — 어시스턴트 메시지에 근거 데이터가 있을 때 버블 아래에 렌더링 */}
        {!isUser && !isSystem && citations && citations.length > 0 && (
          <SourceCitations citations={citations} maxVisible={3} />
        )}

        {/* 타임스탬프 */}
        {timeStr && (
          <time class="rcm-time" dateTime={new Date(timestamp).toISOString()}>
            {timeStr}
          </time>
        )}
      </div>

      {isUser && (
        <div class="rcm-avatar rcm-avatar--user" aria-hidden="true">
          나
        </div>
      )}
    </div>
  );
}

/**
 * 줄바꿈, 코드 블록, 인라인 출처 배지를 처리하는 텍스트 렌더러
 *
 * citations가 전달되면 본문 내 «cite:N» / [cite:N] 마커를
 * InlineSourceBadge 컴포넌트로 치환하여 렌더링한다.
 *
 * @param {{ content: string, citations?: Array|null }} props
 */
function MessageContent({ content, citations = null }) {
  if (!content) return null;

  // 코드 블록 (```...```) 처리
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const code = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
          return (
            <pre key={i} class="rcm-code">
              <code>{code.trim()}</code>
            </pre>
          );
        }

        // 인라인 citation이 있는 경우: 마커를 파싱하여 배지로 변환
        const hasCitations = Array.isArray(citations) && citations.length > 0;
        const citeParts = hasCitations
          ? parseInlineCitations(part, citations)
          : null;

        if (citeParts && citeParts.some((p) => p.type === 'cite')) {
          return (
            <span key={i} class="rcm-text">
              {citeParts.map((cp, ci) => {
                if (cp.type === 'cite') {
                  return (
                    <InlineSourceBadge
                      key={`cite-${ci}`}
                      citation={cp.citation}
                      index={cp.index}
                    />
                  );
                }
                // 텍스트 부분: 줄바꿈을 <br>로 변환
                return cp.value.split('\n').map((line, j) => (
                  j === 0 ? line : [<br key={`${ci}-br-${j}`} />, line]
                ));
              })}
            </span>
          );
        }

        // 일반 텍스트: 줄바꿈을 <br>로 변환
        return (
          <span key={i} class="rcm-text">
            {part.split('\n').map((line, j) => (
              j === 0 ? line : [<br key={j} />, line]
            ))}
          </span>
        );
      })}
    </>
  );
}

/* ── 로딩 인디케이터 ─────────────────────────────────────────────────────────── */

/**
 * 파싱된 쿼리의 intent + section으로 컨텍스트에 맞는 로딩 레이블을 반환한다.
 * @param {{ intent?: string, section?: string|null, keywords?: string[] }|null} parsedQuery
 * @returns {string}
 */
function getLoadingLabel(parsedQuery) {
  if (!parsedQuery) return '이력서 데이터 분석 중…';

  const { intent, section, keywords = [] } = parsedQuery;

  const sectionLabel = {
    experience: '경력',
    skills: '기술',
    summary: '자기소개',
    education: '학력',
    projects: '프로젝트',
    strengths: '강점',  // Sub-AC 8-1
  }[section] ?? null;

  if (intent === 'search_evidence') {
    const kw = keywords.slice(0, 2).join(', ');
    if (sectionLabel && kw) return `${sectionLabel} 섹션에서 "${kw}" 근거 검색 중…`;
    if (sectionLabel) return `${sectionLabel} 섹션 근거 검색 중…`;
    if (kw) return `"${kw}" 관련 커밋·슬랙 기록 검색 중…`;
    return '커밋·슬랙·업무 기록 검색 중…';
  }

  if (intent === 'apply_section') {
    if (sectionLabel) return `${sectionLabel} 섹션 반영 내용 파싱 중…`;
    return '이력서 반영 내용 파싱 중…';
  }

  if (intent === 'refine_section') {
    // Sub-AC 8-1: 자기소개·강점 섹션 전용 로딩 메시지
    if (section === 'summary') return '업무 기록에서 자기소개 초안 생성 중…';
    if (section === 'strengths') return '업무 기록에서 핵심 강점 분석 중…';
    if (sectionLabel) return `${sectionLabel} 섹션 수정 초안 생성 중…`;
    return '이력서 수정 초안 생성 중…';
  }

  if (intent === 'question') {
    return '이력서 데이터 분석 중…';
  }

  return '응답 생성 중…';
}

/**
 * @param {{ parsedQuery?: object|null }} props
 */
function ThinkingIndicator({ parsedQuery = null }) {
  const label = getLoadingLabel(parsedQuery);

  return (
    <div class="rcm-row rcm-row--assistant">
      <div class="rcm-avatar rcm-avatar--assistant" aria-hidden="true">
        AI
      </div>
      <div class="rcm-bubble-wrap">
        <div class="rcm-bubble rcm-bubble--assistant rcm-bubble--thinking">
          <span class="rcm-thinking-dots" aria-label="응답 생성 중">
            <span class="rcm-dot" />
            <span class="rcm-dot" />
            <span class="rcm-dot" />
          </span>
          <span class="rcm-thinking-label">{label}</span>
          <span class="rcm-sr-only">{label}</span>
        </div>
      </div>
    </div>
  );
}

/* ── 초기 환영 메시지 ────────────────────────────────────────────────────────── */

function WelcomeMessage() {
  return (
    <div class="rcm-welcome">
      <div class="rcm-welcome-icon" aria-hidden="true">💬</div>
      <h2 class="rcm-welcome-title">이력서 대화 도우미</h2>
      <p class="rcm-welcome-desc">
        커밋, 슬랙, 업무 메모에서 근거를 찾아 이력서를 함께 다듬어 드립니다.
      </p>
      <ul class="rcm-example-list" aria-label="질의 예시">
        <li class="rcm-example-item">
          <span class="rcm-example-prefix">🔍</span>
          <button
            class="rcm-example-btn"
            type="button"
            data-example="2024년에 진행한 주요 프로젝트를 찾아줘"
          >
            "2024년에 진행한 주요 프로젝트를 찾아줘"
          </button>
        </li>
        <li class="rcm-example-item">
          <span class="rcm-example-prefix">✏️</span>
          <button
            class="rcm-example-btn"
            type="button"
            data-example="내 업무 기록을 바탕으로 자기소개 섹션을 다듬어줘"
          >
            "내 업무 기록을 바탕으로 자기소개 섹션을 다듬어줘"
          </button>
        </li>
        <li class="rcm-example-item">
          <span class="rcm-example-prefix">💪</span>
          <button
            class="rcm-example-btn"
            type="button"
            data-example="업무 기록에서 내 핵심 강점을 분석해줘"
          >
            "업무 기록에서 내 핵심 강점을 분석해줘"
          </button>
        </li>
        <li class="rcm-example-item">
          <span class="rcm-example-prefix">❓</span>
          <button
            class="rcm-example-btn"
            type="button"
            data-example="내 기술 스택에서 가장 많이 언급된 기술은 뭐야?"
          >
            "내 기술 스택에서 가장 많이 언급된 기술은 뭐야?"
          </button>
        </li>
      </ul>
    </div>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const RCM_CSS = `
  /* ─── Root scroll container ─── */
  .rcm-root {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-5) 28px;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    scroll-behavior: smooth;
  }

  .rcm-root.rcm-empty {
    justify-content: center;
    align-items: center;
  }

  /* ─── Message row ─── */
  .rcm-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
    max-width: 920px;
    width: 100%;
  }

  .rcm-row--user {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .rcm-row--assistant {
    align-self: flex-start;
  }

  .rcm-row--system {
    align-self: center;
    justify-content: center;
  }

  /* ─── Avatar ─── */
  .rcm-avatar {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
    user-select: none;
  }

  .rcm-avatar--assistant {
    background: #1e40af;
    color: #fff;
  }

  .rcm-avatar--user {
    background: var(--line-strong);
    color: var(--ink);
  }

  /* ─── Bubble wrapper ─── */
  .rcm-bubble-wrap {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .rcm-row--user .rcm-bubble-wrap {
    align-items: flex-end;
  }

  /* ─── Bubble ─── */
  .rcm-bubble {
    padding: var(--space-3) var(--space-4);
    border-radius: 16px;
    font-size: 14px;
    line-height: 1.65;
    max-width: 780px;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .rcm-bubble--user {
    background: #1e40af;
    color: #fff;
    border-bottom-right-radius: 4px;
  }

  .rcm-bubble--assistant {
    background: rgba(255, 255, 255, 0.92);
    color: var(--ink);
    border: 1px solid var(--line);
    border-bottom-left-radius: 4px;
    box-shadow: var(--shadow-sm);
  }

  .rcm-bubble--system {
    background: var(--line);
    color: var(--muted);
    font-size: 12px;
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    text-align: center;
  }

  .rcm-bubble--error {
    background: #fef2f2;
    border-color: #fecaca;
    color: #dc2626;
  }

  /* ─── Thinking animation ─── */
  .rcm-bubble--thinking {
    padding: var(--space-3) var(--space-4);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .rcm-thinking-dots {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .rcm-dot {
    width: 6px;
    height: 6px;
    background: var(--muted);
    border-radius: 50%;
    animation: rcm-bounce 1.2s ease-in-out infinite;
  }

  .rcm-dot:nth-child(2) { animation-delay: 0.2s; }
  .rcm-dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes rcm-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-6px); opacity: 1; }
  }

  .rcm-thinking-label {
    font-size: 12px;
    color: var(--muted);
    font-style: italic;
    letter-spacing: 0.01em;
    animation: rcm-fade-in 0.3s ease;
  }

  @keyframes rcm-fade-in {
    from { opacity: 0; transform: translateX(-4px); }
    to { opacity: 1; transform: translateX(0); }
  }

  /* ─── Query metadata (under user bubble) ─── */
  .rcm-query-meta {
    margin: 4px 0 0;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.7);
    letter-spacing: 0.03em;
    text-align: right;
    padding-right: 2px;
  }

  /* ─── Time ─── */
  .rcm-time {
    font-size: 10px;
    color: var(--muted);
    opacity: 0.75;
    white-space: nowrap;
  }

  /* ─── Code block ─── */
  .rcm-code {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) var(--space-3);
    background: rgba(15, 23, 42, 0.06);
    border-radius: var(--radius-sm);
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 12px;
    overflow-x: auto;
    white-space: pre;
  }

  .rcm-bubble--user .rcm-code {
    background: rgba(255, 255, 255, 0.15);
  }

  /* ─── Screen reader only ─── */
  .rcm-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0,0,0,0);
    white-space: nowrap;
    border-width: 0;
  }

  /* ─── Welcome message ─── */
  .rcm-welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--space-3);
    padding: var(--space-7);
    max-width: 480px;
  }

  .rcm-welcome-icon {
    font-size: 40px;
    line-height: 1;
    margin-bottom: var(--space-2);
  }

  .rcm-welcome-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--ink-strong);
    letter-spacing: -0.02em;
  }

  .rcm-welcome-desc {
    margin: 0;
    font-size: 14px;
    color: var(--muted);
    line-height: 1.65;
  }

  .rcm-example-list {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    text-align: left;
  }

  .rcm-example-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .rcm-example-prefix {
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .rcm-example-btn {
    background: none;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 5px var(--space-3);
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
    line-height: 1.5;
    transition: background 0.12s, border-color 0.12s;
    width: 100%;
  }

  .rcm-example-btn:hover {
    background: rgba(30, 64, 175, 0.05);
    border-color: var(--accent);
  }
`;
