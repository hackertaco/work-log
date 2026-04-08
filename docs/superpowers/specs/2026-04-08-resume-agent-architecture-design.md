# Resume Agent Architecture Design

> 규칙 기반 intent 분류 → LLM 에이전트 구조 전환

## 배경

현재 이력서 채팅 시스템은 42개+ 정규식으로 intent를 분류하고, 5곳에 분산된 LLM 호출로 응답을 생성한다. Intent 충돌이 반복되고, 멀티턴 대화가 불가능하며, 사용자가 매번 요구해야만 동작한다.

## 핵심 결정사항

| 항목 | 결정 |
|------|------|
| 전환 범위 | 전체 이력서 라이프사이클 (초안 → 수정 → 관리) |
| 아키텍처 | ReAct 루프 (Reason → Plan → Act → Observe) |
| 에이전트 역할 | 능동적 어드바이저 — 선제 제안 후 사용자가 선택 |
| 자율성 | 읽기/검색은 자동, 이력서 수정은 diff 승인 필요 |
| LLM | gpt-5.4 (OpenAI Responses API) |
| 세션 저장 | 서버 파일 기반 (data/sessions/{sessionId}.json), 나중에 DB 전환 가능 |
| API | 단일 엔드포인트 POST /api/resume/agent, action 필드로 분기 |
| 톤 | 친근한 동료 ("오 이거 많이 하셨네요! 넣으면 좋겠는데요") |

## 아키텍처

```
┌─────────────────────────────────────────────────┐
│  Frontend (Preact)                              │
│  ┌──────────────┬──────────────┬──────────────┐ │
│  │ResumeChatPage│useResumeAgent│  ResumeBody  │ │
│  │  메시지 렌더링 │ sendMessage()│  이력서 표시   │ │
│  │  제안 선택 UI │ approveDiff()│  실시간 반영   │ │
│  └──────────────┴──────────────┴──────────────┘ │
└──────────────────────┬──────────────────────────┘
                       │ POST /api/resume/agent
                       ▼
┌─────────────────────────────────────────────────┐
│  Server — Agent Orchestrator                    │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  ReAct Loop (resumeAgent.mjs)           │    │
│  │  1. Reason — LLM이 상황 판단             │    │
│  │  2. Plan — 제안 생성 → 클라이언트 전송     │    │
│  │  3. Act — 도구 실행                      │    │
│  │  4. Observe — 결과 해석 → 다시 1로        │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  ┌──────────────────────────────────────┐       │
│  │  SessionStore (resumeSessionStore.mjs)│       │
│  │  data/sessions/{sessionId}.json      │       │
│  │  대화 기록 + 에이전트 상태 저장/복원     │       │
│  └──────────────────────────────────────┘       │
│                                                 │
│  Tools (resumeAgentTools.mjs):                  │
│  ┌────────────┬────────────┬──────────────┐     │
│  │search_     │read_resume │update_section│     │
│  │evidence    │            │(diff→승인)    │     │
│  ├────────────┼────────────┘              │     │
│  │generate_   │ask_user                   │     │
│  │draft       │                           │     │
│  └────────────┴───────────────────────────┘     │
└──────────────────────┬──────────────────────────┘
                       │ OpenAI Responses API
                       ▼
┌─────────────────────────────────────────────────┐
│  LLM (gpt-5.4)                                  │
│  시스템 프롬프트 + 대화 기록 + 도구 정의           │
│  → 다음 행동 결정                                │
└─────────────────────────────────────────────────┘
```

## 대화 흐름

### Phase 1: 선제 분석 (에이전트 주도)

초안 생성 완료 또는 새 세션 시작 시, 에이전트가 초안 + 워크로그 데이터를 분석하여 번호 매긴 개선 제안 목록을 제시한다.

```
🤖: "이력서를 분석해봤어요. 이런 개선을 제안합니다:
     1. 경력 섹션 — Redis 캐시 최적화 프로젝트 추가 (커밋 12건)
     2. 스킬 섹션 — Kafka, gRPC 추가 (슬랙 5건)
     3. 요약 — '분산 시스템' 경험 강조
     ⚠️ 교육 섹션 — 데이터 부족, 보충 질문 필요
     어떤 거 먼저 해볼까요?"
```

### Phase 2: 사용자 선택

사용자가 번호를 선택하거나 자유 입력한다. 에이전트 제안과 무관한 새로운 요청도 가능.

### Phase 3: 실행

사용자가 의도를 밝혔으므로 계획 승인 없이 도구를 실행한다. 검색 → 이력서 읽기 → 수정안 생성.

### Phase 4: diff 승인

수정안을 before/after diff로 표시. 사용자가 승인/거절/수정 요청.

### Phase 5: 다음 제안 (루프)

승인 후 에이전트가 다음 제안을 이어간다.

## 도구 정의

### search_evidence

기존 `resumeEvidenceSearch.mjs`의 `searchAllSources()`를 래핑한다.

```
입력: { query: string, sources?: string[], dateRange?: { from, to } }
출력: { results: Evidence[], totalCount: number }
```

- sources 생략 시 전체 소스(commits, slack, sessions) 검색
- 기존 랭킹 알고리즘(relevanceScore × SOURCE_WEIGHT + recencyScore + diversityBonus) 유지
- 자동 실행 (승인 불필요)

### read_resume

현재 이력서 데이터를 읽는다.

```
입력: { section?: string }
출력: { resume: Resume } 또는 { section: SectionData }
```

- section 생략 시 전체 이력서 반환
- 자동 실행

### update_section

이력서 섹션 수정안을 생성한다. 실제 적용은 사용자 승인 후.

```
입력: { section: string, changes: { before: string, after: string, evidence?: Citation[] } }
출력: { diff: Diff, messageId: string }
```

- diff를 클라이언트에 전송하여 승인/거절 UI 표시
- 승인 시 기존 PATCH /api/resume/section으로 적용
- **승인 필요**

### generate_draft

기존 `resumeDraftGeneration.mjs`의 `generateResumeDraft()`를 래핑한다.

```
입력: { fromDate?: string, toDate?: string }
출력: { draft: ResumeDraft }
```

- 초안 데이터(companyStories, strengthCandidates 등) 반환
- 에이전트가 이 데이터를 분석하여 선제 제안 생성에 활용
- 자동 실행

### ask_user

사용자에게 보충 질문을 전송한다. 에이전트 루프를 일시 중지하고 질문을 응답에 포함시킨다. 사용자의 다음 메시지가 답변이 되어 루프가 재개된다.

```
입력: { question: string, context?: string }
출력: (루프 중단 — 질문이 assistant 메시지로 전송됨)
```

- 데이터 부족 시 에이전트가 자발적으로 호출
- 자동 실행
- 구현: update_section의 diff 승인 대기와 동일한 메커니즘 — 응답을 반환하고 다음 요청에서 루프 재개

## 승인 정책

| 도구 | 자동 실행 | 승인 필요 | 이유 |
|------|----------|----------|------|
| search_evidence | ✓ | | 읽기 전용 |
| read_resume | ✓ | | 읽기 전용 |
| generate_draft | ✓ | | 초안일 뿐, 적용 아님 |
| update_section | | diff 승인 | 이력서 수정 — 반드시 확인 |
| ask_user | ✓ | | 질문일 뿐 |

## 파일 구조 (신규/변경)

### 신규 파일

- `src/lib/resumeAgent.mjs` — ReAct 루프 핵심 로직. LLM 호출, 도구 디스패치, 상태 전이.
- `src/lib/resumeAgentTools.mjs` — 5개 도구 정의. 기존 코드를 tool 인터페이스로 래핑.
- `src/lib/resumeSessionStore.mjs` — 세션 저장/복원. `data/sessions/{sessionId}.json` 기반.
- `frontend/src/hooks/useResumeAgent.js` — 에이전트 API 호출 훅. sendMessage, approveDiff, rejectDiff.

### 변경 파일

- `src/routes/resume.mjs` — `POST /api/resume/agent` 엔드포인트 추가. 기존 chat 엔드포인트는 에이전트 안정화 후 삭제.

### 삭제 대상 (에이전트 안정화 후)

- `frontend/src/lib/resumeQueryParser.js` — 프론트엔드 intent 파싱 (에이전트가 대체)
- `src/lib/resumeQueryAnalyzer.mjs` — 서버 intent 분석 (에이전트가 대체)
- `src/lib/resumeAppealPoints.mjs` — 어필포인트 생성 (에이전트가 직접 생성)
- `src/lib/resumeSummarySectionChat.mjs` — 요약 섹션 diff (에이전트가 직접 생성)

### 유지

- `src/lib/resumeEvidenceSearch.mjs` — search_evidence 도구가 래핑
- `src/lib/resumeDraftGeneration.mjs` — generate_draft 도구가 래핑
- 이력서 CRUD API (`/api/resume/*`)
- 워크로그 데이터 수집 파이프라인
- 프론트엔드 UI 컴포넌트 (ResumeBody, DraftInsightMessages 등)

## 세션 저장 구조

```json
{
  "sessionId": "agent-1712567890-abc123",
  "createdAt": "2026-04-08T10:00:00Z",
  "updatedAt": "2026-04-08T10:15:00Z",
  "messages": [
    { "role": "assistant", "content": "이력서를 분석해봤어요...", "timestamp": 1712567890 },
    { "role": "user", "content": "1번 해줘", "timestamp": 1712567920 },
    { "role": "tool", "name": "search_evidence", "content": "{...}", "timestamp": 1712567925 },
    { "role": "assistant", "content": "이렇게 수정했어요...", "diff": {...}, "timestamp": 1712567930 }
  ],
  "agentState": {
    "pendingSuggestions": [...],
    "completedSuggestions": [...],
    "draftContext": {...}
  }
}
```

- 새로고침 시 sessionId로 복원
- TTL: 24시간 (마지막 활동 기준)
- 나중에 DB 전환 시 SessionStore 인터페이스만 교체

## 시스템 프롬프트 (핵심 요소)

```
너는 이력서 개선을 도와주는 친근한 동료야.
워크로그 데이터(커밋, 슬랙, AI 세션)를 기반으로 이력서를 분석하고 개선안을 제안해.

행동 원칙:
1. 먼저 분석하고 제안해 — 사용자가 요청하기 전에 개선점을 찾아
2. 모든 제안에 근거를 달아 — "커밋 3건에서 확인" 식으로
3. 이력서 수정은 반드시 diff로 보여주고 승인받아
4. 데이터가 부족하면 솔직히 말하고 보충 질문해
5. 친근하게, 하지만 전문적으로 — "오 이거 좋네요!" + 구체적 이유

사용 가능한 도구:
- search_evidence: 워크로그에서 근거 검색
- read_resume: 현재 이력서 읽기
- update_section: 이력서 섹션 수정 (승인 필요)
- generate_draft: 초안 생성
- ask_user: 보충 질문
```

## 에러 처리

- LLM 호출 실패 → 재시도 1회 후 사용자에게 "잠시 문제가 생겼어요. 다시 시도할까요?" 메시지
- 도구 실행 실패 → 에이전트에게 에러를 observe로 전달, 에이전트가 대안 판단
- 세션 복원 실패 → 새 세션 시작, 사용자에게 알림
- 기존 heuristic fallback은 search_evidence 도구 내부에서 유지

## 마이그레이션 전략

기존 chat 엔드포인트와 병행 운영 후 전환한다:

1. **Phase A**: 에이전트 엔드포인트 추가 (`/api/resume/agent`), 기존 `/api/resume/chat` 유지
2. **Phase B**: 프론트엔드에서 에이전트 모드 토글 추가 (기본값: 기존)
3. **Phase C**: 에이전트 안정화 확인 후 기본값 전환
4. **Phase D**: 기존 코드 삭제
