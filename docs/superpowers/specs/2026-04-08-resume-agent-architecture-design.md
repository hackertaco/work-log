# Resume Agent Architecture Design

> 규칙 기반 intent 분류 → LLM 에이전트 구조 전환

## 배경

현재 이력서 채팅 시스템은 42개+ 정규식으로 intent를 분류하고, 5곳에 분산된 LLM 호출로 응답을 생성한다. Intent 충돌이 반복되고, 멀티턴 대화가 불가능하며, 사용자가 매번 요구해야만 동작한다.

## 핵심 결정사항

| 항목 | 결정 |
|------|------|
| 전환 범위 | 전체 이력서 라이프사이클 (초안 → 수정 → 관리) |
| 아키텍처 | ReAct 루프 (Thought → Action → Observation), 2-pass 설계 |
| 에이전트 역할 | 능동적 어드바이저 — 선제 제안 후 사용자가 선택 |
| 자율성 | 읽기/검색은 자동, 이력서 수정은 diff 승인 필요 |
| LLM | gpt-5.4 (OpenAI Responses API) |
| 세션 저장 | Vercel Blob 기반 (코드베이스 기존 패턴과 일치) |
| API | 단일 엔드포인트 POST /api/resume/agent (SSE 스트리밍), action 필드로 분기 |
| 톤 | 친근한 동료 ("오 이거 많이 하셨네요! 넣으면 좋겠는데요") |

## 아키텍처

```
┌─────────────────────────────────────────────────┐
│  Frontend (Preact)                              │
│  ┌──────────────┬──────────────┬──────────────┐ │
│  │ResumeChatPage│useResumeAgent│  ResumeBody  │ │
│  │  메시지 렌더링 │ sendMessage()│  이력서 표시   │ │
│  │  제안 선택 UI │ approveDiff()│  실시간 반영   │ │
│  │  SSE 수신    │ rejectDiff() │  companyStory │ │
│  └──────────────┴──────────────┴──────────────┘ │
└──────────────────────┬──────────────────────────┘
                       │ POST /api/resume/agent (SSE)
                       ▼
┌─────────────────────────────────────────────────┐
│  Server — Agent Orchestrator                    │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  ReAct Loop (resumeAgent.mjs)           │    │
│  │  MAX_ITERATIONS = 10                    │    │
│  │  1. Thought — LLM이 상황 판단            │    │
│  │  2. Action — 도구 실행                   │    │
│  │  3. Observation — 결과 해석 → 다시 1로    │    │
│  │  종료조건: ask_user/update_section 호출,  │    │
│  │           텍스트 응답 생성, 또는 max 도달   │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  ┌──────────────────────────────────────┐       │
│  │  SessionStore (resumeSessionStore.mjs)│       │
│  │  Vercel Blob: sessions/{sessionId}   │       │
│  │  version counter + optimistic lock   │       │
│  │  대화 기록 + 에이전트 상태 저장/복원     │       │
│  └──────────────────────────────────────┘       │
│                                                 │
│  Tools (resumeAgentTools.mjs):                  │
│  ┌────────────────┬──────────────────────┐      │
│  │search_evidence │update_section        │      │
│  │(parsedQuery    │(JSON patch + 승인)    │      │
│  │ 어댑터 포함)    │                      │      │
│  ├────────────────┼──────────────────────┤      │
│  │read_draft_     │ask_user              │      │
│  │context         │(루프 중단)            │      │
│  └────────────────┴──────────────────────┘      │
└──────────────────────┬──────────────────────────┘
                       │ OpenAI Responses API
                       ▼
┌─────────────────────────────────────────────────┐
│  LLM (gpt-5.4)                                  │
│  시스템 프롬프트 + 이력서 요약(자동 주입)           │
│  + 대화 기록(tool output 요약) + 도구 정의        │
│  → 다음 행동 결정                                │
└─────────────────────────────────────────────────┘
```

## 2-Pass 설계

에이전트 루프는 하나의 연속 루프가 아니라 2-pass로 동작한다:

### Pass 1: 분석 (세션 시작 시)

프론트엔드가 `action: "init"` 요청을 보내면 에이전트가 캐시된 초안 데이터를 읽고 분석하여 제안 목록을 생성한다.

```
Frontend → POST /api/resume/agent { action: "init", sessionId }
Server   → read_draft_context() + 이력서 요약 주입
LLM      → 제안 목록 생성
Response ← SSE: { type: "suggestions", items: [...] }
```

### Pass 2: 실행 (사용자 선택 후)

사용자가 제안을 선택하거나 자유 입력하면, ReAct 루프가 도구를 실행한다.

```
Frontend → POST /api/resume/agent { action: "message", sessionId, text }
Server   → ReAct 루프 (Thought → Action → Observation × N, max 10회)
Response ← SSE: { type: "progress", step: "검색 중..." }
         ← SSE: { type: "progress", step: "수정안 작성 중..." }
         ← SSE: { type: "diff", section, before, after, evidence }
         ← SSE: { type: "message", content: "이렇게 수정했어요..." }
```

## 대화 흐름

### Phase 1: 선제 분석 (에이전트 주도)

초안 생성 완료 또는 새 세션 시작 시, 프론트엔드가 `action: "init"`을 보내고 에이전트가 초안 + 워크로그 데이터를 분석하여 번호 매긴 개선 제안 목록을 제시한다.

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

사용자가 의도를 밝혔으므로 계획 승인 없이 도구를 실행한다. SSE로 진행 상황을 실시간 전송.

### Phase 4: diff 승인

수정안을 before/after diff로 표시. 사용자가 승인/거절/수정 요청.

### Phase 5: 다음 제안 (루프)

승인 후 에이전트가 다음 제안을 이어간다.

## 도구 정의

### search_evidence

기존 `resumeEvidenceSearch.mjs`의 `searchAllSources()`를 래핑한다.

```
입력: { query: string, sources?: string[], dateRange?: { from, to } }
출력: { results: Evidence[], totalCount: number, errors?: string[] }
```

- 내부에서 query string → parsedQuery 변환 어댑터 포함:
  - `analyzeQuery(query)`로 키워드/섹션/날짜 추출
  - sources/dateRange 파라미터로 sourceParams 구성
  - 기존 키워드 확장 맵(tech stack dictionary) 활용
- sources 생략 시 전체 소스(commits, slack, sessions) 검색
- 기존 랭킹 알고리즘 유지
- **에러 구분**: 검색 실패 시 빈 배열이 아닌 `errors` 필드에 실패 원인 포함. 에이전트가 "검색에 문제가 있었어요"라고 알릴 수 있음
- 자동 실행 (승인 불필요)

### read_draft_context

캐시된 초안 데이터를 Vercel Blob에서 읽는다. 초안 생성을 재실행하지 않는다.

```
입력: { }
출력: { draft: ResumeDraft, cachedAt: string } 또는 { draft: null, reason: "no_cache" }
```

- 기존 `readChatDraft()` Blob 패턴 활용
- companyStories, strengthCandidates, dataGaps 등 구조화된 데이터 반환
- 캐시 없으면 `draft: null` 반환 — 에이전트가 사용자에게 "초안 생성이 필요해요" 안내
- 자동 실행

### update_section

이력서 섹션 수정안을 생성한다. 실제 적용은 사용자 승인 후.

```
입력: {
  section: string,
  operation: "add_bullet" | "edit_bullet" | "replace_summary" | "add_skill" | ...,
  payload: { ... },  // operation별 구조화된 데이터
  evidence?: Citation[]
}
출력: { diff: Diff, messageId: string, baseVersion: number }
```

- 기존 `PATCH /api/resume/json-diff-apply` JSON 패치 포맷과 일치
- `baseVersion`: 수정안 생성 시점의 이력서 버전. 승인 시 현재 버전과 비교하여 stale diff 방지
- diff를 SSE로 클라이언트에 전송하여 승인/거절 UI 표시
- 승인 시 기존 PATCH /api/resume/section으로 적용
- **승인 필요** — 이 도구 호출 시 루프 즉시 중단
- 미승인 diff TTL: 30분 후 자동 만료

### ask_user

사용자에게 보충 질문을 전송한다. 에이전트 루프를 즉시 중지하고 질문을 응답에 포함시킨다. 사용자의 다음 메시지가 답변이 되어 루프가 재개된다.

```
입력: { question: string, context?: string }
출력: (루프 즉시 중단 — 질문이 assistant 메시지로 전송됨)
```

- 데이터 부족 시 에이전트가 자발적으로 호출
- 자동 실행
- **이 도구 호출 시 루프 즉시 중단**, 추가 도구 호출 없음

## 이력서 컨텍스트 자동 주입

매 요청마다 현재 이력서 요약을 시스템 프롬프트에 자동 주입한다. 별도의 `read_resume` 도구는 불필요.

```
시스템 프롬프트에 포함:
- 섹션 목록 + 각 섹션 항목 수
- 경력 섹션: 회사명, 직책, 기간, 불릿 수
- 스킬 섹션: 카테고리별 스킬 목록
- 요약 전문
```

상세 섹션 내용이 필요한 경우 에이전트가 `search_evidence`로 관련 데이터를 검색한다.

## 승인 정책

| 도구 | 자동 실행 | 승인 필요 | 루프 중단 | 이유 |
|------|----------|----------|----------|------|
| search_evidence | ✓ | | | 읽기 전용 |
| read_draft_context | ✓ | | | 읽기 전용 |
| update_section | | diff 승인 | ✓ | 이력서 수정 — 반드시 확인 |
| ask_user | ✓ | | ✓ | 사용자 응답 대기 필요 |

## ReAct 루프 제어

### 종료 조건 (하나라도 만족 시 즉시 종료)

1. LLM이 텍스트 응답만 생성 (도구 호출 없음)
2. `ask_user` 호출 — 사용자 응답 대기
3. `update_section` 호출 — diff 승인 대기
4. `MAX_ITERATIONS(10)` 도달 — "한번에 처리하기 어려운 요청이에요. 좀 더 구체적으로 말씀해주시겠어요?" 메시지

### 도구 호출 검증

- 도구 이름 allowlist 검증. 알 수 없는 도구 호출 시 LLM에 1회 재프롬프트 ("해당 도구는 존재하지 않습니다. 사용 가능한 도구: ...")
- 파라미터 스키마 검증 (JSON Schema). 검증 실패 시 LLM에 1회 재프롬프트
- 2회 연속 검증 실패 시 사용자에게 에러 메시지 반환

### 각 iteration에서의 SSE 진행 표시

```
SSE: { type: "progress", iteration: 1, step: "워크로그에서 Redis 관련 활동 검색 중..." }
SSE: { type: "progress", iteration: 2, step: "경력 섹션 수정안 작성 중..." }
SSE: { type: "diff", ... }
```

## API 엔드포인트

### POST /api/resume/agent

단일 엔드포인트, `action` 필드로 분기. SSE 응답.

```
// 세션 초기화 (Pass 1)
{ action: "init", sessionId: string }

// 메시지 전송 (Pass 2)
{ action: "message", sessionId: string, text: string }

// diff 승인
{ action: "approve_diff", sessionId: string, messageId: string }

// diff 거절
{ action: "reject_diff", sessionId: string, messageId: string }

// diff 수정 요청
{ action: "revise_diff", sessionId: string, messageId: string, feedback: string }
```

### 입력 검증

- `action` 필드 필수, 허용 값: `init | message | approve_diff | reject_diff | revise_diff`
- 알 수 없는 action → 400 에러 + 구체적 메시지
- action별 필수 필드 검증 (sessionId 항상 필수, text는 message에서만 필수 등)

## 파일 구조 (신규/변경)

### 신규 파일

- `src/lib/resumeAgent.mjs` — ReAct 루프 핵심 로직. LLM 호출, 도구 디스패치, 상태 전이, iteration 제어.
- `src/lib/resumeAgentTools.mjs` — 4개 도구 정의. 기존 코드를 tool 인터페이스로 래핑. search_evidence의 parsedQuery 어댑터 포함.
- `src/lib/resumeSessionStore.mjs` — Vercel Blob 기반 세션 저장/복원. version counter + optimistic locking.
- `frontend/src/hooks/useResumeAgent.js` — 에이전트 API 호출 훅. SSE 수신, sendMessage, approveDiff, rejectDiff.

### 변경 파일

- `src/routes/resume.mjs` — `POST /api/resume/agent` SSE 엔드포인트 추가. 기존 chat 엔드포인트는 에이전트 안정화 후 삭제.
- `src/lib/resumeEvidenceSearch.mjs` — 기존 `.catch(() => [])` 패턴을 `{ results: [], error: reason }` 패턴으로 수정. 에러 로깅 추가.

### 삭제 대상 (에이전트 안정화 후)

- `frontend/src/lib/resumeQueryParser.js` — 프론트엔드 intent 파싱
- `src/lib/resumeQueryAnalyzer.mjs` — 서버 intent 분석
- `src/lib/resumeAppealPoints.mjs` — 어필포인트 생성
- `src/lib/resumeSummarySectionChat.mjs` — 요약 섹션 diff
- `src/lib/resumeChatDraftService.mjs` — 채팅 초안 서비스
- `src/lib/resumeChatExplore.mjs` — 채팅 탐색
- `src/lib/resumeChatSuggest.mjs` — 채팅 제안
- `src/lib/resumeStrengthsSectionChat.mjs` — 강점 섹션 채팅

### 유지

- `src/lib/resumeEvidenceSearch.mjs` — search_evidence 도구가 래핑 (에러 전파 수정 후)
- `src/lib/resumeDraftGeneration.mjs` — 배치 초안 생성 (에이전트 외부에서 실행)
- 이력서 CRUD API (`/api/resume/*`)
- 워크로그 데이터 수집 파이프라인
- 프론트엔드 UI 컴포넌트 (ResumeBody, DraftInsightMessages 등)

## 세션 저장 구조

Vercel Blob: `sessions/{userId}/{sessionId}.json`

```json
{
  "sessionId": "agent-1712567890-abc123",
  "userId": "user-abc",
  "version": 5,
  "createdAt": "2026-04-08T10:00:00Z",
  "updatedAt": "2026-04-08T10:15:00Z",
  "messages": [
    { "role": "assistant", "content": "이력서를 분석해봤어요...", "timestamp": 1712567890 },
    { "role": "user", "content": "1번 해줘", "timestamp": 1712567920 },
    { "role": "tool_summary", "name": "search_evidence", "summary": "Redis 관련 커밋 5건 발견", "timestamp": 1712567925 },
    { "role": "assistant", "content": "이렇게 수정했어요...", "diff": {...}, "timestamp": 1712567930 }
  ],
  "agentState": {
    "pendingDiffs": [
      { "messageId": "msg-123", "section": "experience", "baseVersion": 4, "expiresAt": "2026-04-08T10:45:00Z" }
    ],
    "pendingSuggestions": [...],
    "completedSuggestions": [...],
    "resumeVersion": 4
  }
}
```

### 세션 동시성 제어

- 모든 세션 읽기/쓰기에 `version` 필드 사용 (optimistic locking)
- 쓰기 시 현재 version과 비교, 불일치 시 재읽기 후 재시도 (최대 3회)
- 3회 실패 시 사용자에게 "다른 탭에서 변경이 있었어요. 새로고침해주세요" 메시지

### 토큰 예산 관리

- `role: "tool_summary"`: 도구 실행 결과의 요약만 세션에 저장 (전체 결과는 현재 턴에서만 사용)
- 세션 메시지가 50개 초과 시 오래된 tool_summary 메시지부터 삭제
- LLM 컨텍스트에 전송할 메시지는 최근 20개 + 시스템 프롬프트 + 이력서 요약

### 세션 복원 실패 처리

- 세션 JSON 스키마 검증 (`sessionId`, `messages`, `agentState` 필수 필드)
- 검증 실패 시 corrupt 세션을 `sessions/{userId}/{sessionId}.corrupt.json`으로 백업
- 새 세션 시작 + **지속적 배너**: "이전 대화를 불러올 수 없어 새 대화를 시작합니다"
- 새로고침 시 `pendingDiffs`가 있으면 승인 UI 자동 복원

### TTL

- 세션 TTL: 24시간 (마지막 활동 기준)
- 미승인 diff TTL: 30분 후 자동 만료, 만료 시 에이전트가 "수정안이 만료되었어요. 다시 만들까요?" 안내

## 시스템 프롬프트 (핵심 요소)

```
너는 이력서 개선을 도와주는 친근한 동료야.
워크로그 데이터(커밋, 슬랙, AI 세션)를 기반으로 이력서를 분석하고 개선안을 제안해.

행동 원칙:
1. 먼저 분석하고 제안해 — 사용자가 요청하기 전에 개선점을 찾아
2. 모든 제안에 근거를 달아 — "커밋 3건에서 확인" 식으로
3. 이력서 수정은 반드시 diff로 보여주고 승인받아
4. 데이터가 부족하면 솔직히 말하고 보충 질문해
5. 검색에 실패하면 솔직히 알려줘 — 빈 결과와 에러를 구분해
6. 친근하게, 하지만 전문적으로 — "오 이거 좋네요!" + 구체적 이유

사용 가능한 도구:
- search_evidence: 워크로그에서 근거 검색
- read_draft_context: 캐시된 초안 데이터 읽기
- update_section: 이력서 섹션 수정 (승인 필요)
- ask_user: 보충 질문

현재 이력서 요약:
{resume_summary}  ← 매 요청마다 동적 주입
```

## 에러 처리

### LLM 호출 실패
- 재시도 1회 후 사용자에게 "잠시 문제가 생겼어요. 다시 시도할까요?" 메시지

### 도구 실행 실패
- 오케스트레이터가 에러를 구조화하여 LLM에 observation으로 전달
- LLM이 대안 판단 (다른 소스 검색, 사용자에게 안내 등)
- 같은 도구 같은 파라미터로 2회 연속 실패 시 오케스트레이터가 개입하여 사용자 에러 메시지 강제 반환

### 검색 에러 전파 (기존 코드 수정)
- `resumeEvidenceSearch.mjs`의 `.catch(() => [])` → `.catch(err => { log(err); return { results: [], error: err.message }; })`
- 도구 래퍼가 `error` 필드를 LLM에 전달하여 "커밋 검색에 문제가 있었어요, 슬랙에서는 3건 찾았어요" 식 안내 가능

### 세션 복원 실패
- 새 세션 시작, 지속적 배너로 사용자에게 알림
- corrupt 세션 백업 저장

## 마이그레이션 전략

기존 chat 엔드포인트와 병행 운영 후 전환한다:

1. **Phase A**: 에이전트 엔드포인트 추가 (`/api/resume/agent`), 기존 `/api/resume/chat` 유지
2. **Phase B**: 서버 환경변수 `RESUME_AGENT_ENABLED=1`로 전환 제어 (UI 토글 없음)
3. **Phase C**: 에이전트 안정화 확인 후 환경변수 제거, 에이전트가 기본값
4. **Phase D**: 기존 코드 삭제

### Phase C 안정화 기준

- 에이전트 응답 에러율 < 5%
- 도구 호출 성공률 > 95%
- diff 승인 플로우 정상 동작 확인 (승인/거절/수정/만료)
- 세션 복원 정상 동작 확인
