# 업무방식 프로필 v2 — 행동신호로 판단 근거 강화

작성일: 2026-07-31
상태: 설계 확정 대기

## 배경 / 문제

현재 업무방식 프로필(v1)은 **사용자 프롬프트만** 근거로 판단 기준을 뽑는다 — "네가 AI에게
뭘 물어봤나"의 한쪽 면. AI 응답·결과·실제 행동은 안 본다. 그래서 원칙이 "관찰된 가설"에
머물고 얇다.

Zeude ClickHouse엔 **이미 계산된 행동신호**가 있다(스키마 실측, 2026-07-31): 세션별
좌절 점수·재시도·툴 사용·검증 여부·효율. 이걸 판단 추출에 **근거로 녹이면**, "검증 우선"
같은 원칙을 말이 아니라 **실제 행동(툴 검증 사용률·재시도)** 으로 뒷받침할 수 있다.

## 목표 (v2)

- 프롬프트 기반 판단 분석에 **행동신호를 근거 컨텍스트로 주입**해 원칙을 행동으로
  뒷받침·정정한다. (별도 지표 섹션 없음 — 원칙의 근거·설명에 스며듦)

## 비목표 (v3)

- `claude_code_logs`(1200만 행 OTel) 원본 마이닝 — AI 응답·툴 내용 파싱.
- 성패/결과(그 접근이 먹혔나) 반영.
- 별도 "행동 지표" 대시보드 섹션.

## 확인된 사실 (Zeude 스키마)

- `frustration_analysis`: `user_id, source, session_id, date, total_requests, frustration_score, frustration_density`
- `tool_usage_daily`: `date, user_id, source, session_id, tool_name, is_verification, use_count`
- `ai_prompts`(기존 수집원): `session_id, user_id, user_email, project_path, timestamp, source, prompt_text, …`
  — **user_email 과 session_id/user_id/project_path 를 모두 갖는 유일한 브리지 테이블.**
- ⚠️ 미확인(플랜 1단계에서 DESCRIBE): `retry_analysis`, `efficiency_metrics_daily` 컬럼.
  존재는 확인, 정확한 컬럼명은 미확인. 추측: user_id/session_id/date + 재시도/효율 지표.

## 핵심 설계 결정 — 유저 식별 브리지

work-log은 유저를 **`zeudeEmail`** 로 식별하지만, 행동신호 테이블엔 `user_email` 이 없고
`user_id` 만 있다. → **`ai_prompts` 를 브리지로 쓴다**: 이메일로 그 유저의
`(session_id, project_path)` 집합을 먼저 뽑고, 그 `session_id` 들로 신호 테이블을 조인한다.
이렇게 하면 신호를 **작업영역(project→areaKey)에 귀속**시킬 수 있다.

## 아키텍처 / 흐름

work-log 수집(`runWorkStyleAnalysis`) 안에서 판단 추출 **직전에** 행동 컨텍스트를 만든다.

```
1. collectBehaviorSignals(userId, days):
   a. ai_prompts 에서 유저(zeudeEmail) 30일 세션 목록 + 각 세션의 project_path → areaKey
   b. 그 session_id 들로 frustration_analysis / retry_analysis / tool_usage_daily /
      efficiency_metrics_daily 조회 (WHERE session_id IN (...) )
   c. 세션 신호를 areaKey 로 묶어 집계 → 영역별 요약:
      { area, avgFrustration, retryRate, topTools:[{tool,count,isVerification}],
        verificationRatio, efficiency, sessionCount }
   → 조인이 빈약(세션id 매칭 적음)하면 유저 전체 집계로 폴백.
2. extractWorkStyleForArea(areaGroup, behaviorForArea): 기존 프롬프트에 그 영역의
   행동 요약을 "행동 근거"로 추가. 예: "이 영역에서 검증 툴 사용률 X%, 재시도율 Y%,
   좌절 Z" → LLM이 판단을 행동으로 뒷받침/정정하게.
3. synthesizeWorkStylePrinciples: 영역별 행동 요약도 함께 넘겨, 원칙 승격 시 반영.
```

출력물(profile md, /api/profile)의 **형식은 안 바뀐다.** 원칙의 description·evidence 안에
행동 근거가 자연스럽게 들어갈 뿐. 프로필 렌더러(memberProfile.mjs)는 손 안 댐.

## 컴포넌트 (work-log)

- **`src/lib/behaviorSignals.mjs`** (신규)
  - `collectBehaviorSignals({ userId, days = 30, fetchImpl = fetch }): Promise<{ byArea: Map<area, Summary>, overall: Summary }>`
    — ClickHouse 조회(기존 `serverCollect` 의 ClickHouse 호출 패턴·KST 윈도우 재사용) +
    세션→영역 브리지 + 집계. 미설정/조인빈약/실패 시 빈 결과(비치명적).
- **`src/lib/workStyleExtract.mjs`** (수정)
  - `extractWorkStyleForArea(areaGroup, behavior, fetchImpl)` — 선택적 `behavior` 인자.
    `buildExtractPayload(area, prompts, behavior)` 가 행동 요약을 system/user 컨텍스트에 추가.
  - `synthesizeWorkStylePrinciples(areas, behaviorByArea, fetchImpl)` — 동일하게 행동 반영.
- **`src/lib/serverCollect.mjs`** (수정)
  - `runWorkStyleAnalysis` 가 LLM 재생성 분기에서 `collectBehaviorSignals` 를 한 번 호출,
    영역별로 `extractWorkStyleForArea` 에 전달. 7일 staleness 게이트 그대로.

## 스키마 실측 결과 (2026-07-31, Task 1)

- `retry_analysis` 컬럼: `source LowCardinality(String), user_id String, session_id String, date Date, total_requests UInt64, likely_retries UInt64, retry_density Float64`
- `efficiency_metrics_daily` 컬럼: `user_id String, source String, date Date, total_input Int64, total_output Int64, total_requests UInt64, total_cache_read Int64, total_cache_creation Int64, cache_hit_rate Float64, avg_input_per_request Float64, avg_output_per_request Float64, avg_duration_ms Float64`
- 재시도율로 쓸 컬럼: `likely_retries` / `retry_density` (session_id 있음, 세션 단위 귀속 가능)
- 효율로 쓸 컬럼: `cache_hit_rate`, `avg_duration_ms` (단, **session_id 없음** — user_id + date 단위로만 조인 가능, 영역별 귀속은 안 되고 유저 전체 집계만 가능)
- 세션 조인율 (seungah.jung@tgsociety.co.kr, 30일, prompt_sessions=261, user_ids=2 — `diag` 소스 1건 섞여있음, 실질 유저는 1명):
  - frustration_analysis: matched 65 / signal 101 = 0.644
  - tool_usage_daily: matched 92 / signal 93 = 0.989
- 결론: **영역별 귀속 유효** — 두 신호 테이블 모두 조인율이 0.2 임계값을 크게 상회(0.644, 0.989). Task 2 는 폴백 경로를 유지하되 기본 경로로 영역별 귀속을 기대해도 됨. `efficiency_metrics_daily` 는 session_id 부재로 애초에 영역별 귀속 대상이 아니며, Task 6 에서 유저 전체 집계 경로로만 다룬다.

## 프로덕션 검증 결과 (2026-07-31, Task 7)

1차 실행(`/api/collect?forceLlm=1`): `behaviorSessions=542`, 영역 5, 원칙 5, 지표 섹션 없음.
**하지만 판단·원칙 어디에도 행동 근거가 반영되지 않았다** — 신호는 전달됐는데 모델이 통째로 무시.

원인: 추출 프롬프트의 기본 지시가 `이 프롬프트만 근거로` 였다. 뒤에 행동신호 지시를 덧붙여도
앞의 배타적 제약이 이겨서, 모델이 신호를 근거로 쓰면 안 되는 것으로 해석했다. 두 지시가 모순.

수정: 신호가 있을 때만 `이 프롬프트와 함께 주는 행동신호를 근거로` 로 바꾸고(신호가 없으면 기존
문구 그대로), 합성 프롬프트도 `제공된 판단과 행동신호에서` 로 넓혔다. judgment 의 evidence 는
여전히 프롬프트 인용만 허용 — 신호는 서술을 다듬고, 인용은 프롬프트가 맡는다.

2차 실행: `behaviorSessions=542`, 행동 근거가 원칙에 실제로 반영됨. 예 —
> "다만 실제 행동신호는 검증 전용 도구보다 읽기·수정·실행 쪽 비중이 높아, '항상 검증 도구를
> 우선한다'기보다 근거 확인을 중요하게 두는 편으로 보인다."

프롬프트만으로는 과장됐을 판단을 신호가 **정정한** 사례로, v2 의 목표가 그대로 달성된 형태.
수치 나열·별도 지표 섹션은 생기지 않았고(KB 프로필 헤딩 확인), 기존 필드 집합도 그대로.

## 리스크

- **세션id 조인 불일치(추측·최우선 검증):** ai_prompts 의 session_id 와 신호 테이블의
  session_id 형식/값이 다르면 조인이 비어 신호가 안 붙는다. → **플랜 1단계에서 실측**
  (샘플 조인 카운트). 빈약하면 유저 전체 집계 폴백으로 설계 유지.
- `retry_analysis`/`efficiency_metrics_daily` 컬럼 미확인 → 플랜 1단계 DESCRIBE 후 확정.
- ClickHouse 쿼리 비용: `session_id IN (...)` 큰 목록. 30일·유저 1명이면 수백 세션 수준,
  경미(추측). 필요시 날짜+user_id 범위로 좁힘.
- LLM 프롬프트가 길어짐(행동 컨텍스트 추가) → `max_output_tokens: 3000` 유지, 입력만 늘어남.

## 테스트

- `collectBehaviorSignals`: mock fetch(ClickHouse) — 세션→영역 매핑, 영역별 집계,
  조인빈약 시 폴백. 미설정 시 빈 결과.
- `buildExtractPayload`/`buildSynthesisPayload`: behavior 인자 있으면 프롬프트에 행동
  컨텍스트 포함, 없으면 기존과 동일(하위호환).
- `runWorkStyleAnalysis`: behavior 수집 호출 + 영역별 전달 경로(비치명적) 회귀 없음.
- 기존 스위트 그린(`npm test`, `npm run check`).

## 배포

- 신규 env 없음 — 기존 CLICKHOUSE_* 재사용. 첫 검증은 로컬(`.env.local` 엔 CLICKHOUSE
  없음 → Vercel env pull 또는 프로덕션 `/api/collect?forceLlm=1`)로.
