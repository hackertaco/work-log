# 워크스타일 암묵지 추출 — 설계

작성: 2026-07-07

## 목적

work-log 홈에 **"내가 일한 영역과 그 안의 판단"** 섹션을 추가한다. 커밋은
*무엇을 했는지*만 남기지만, *어떤 생각으로 했는지*(암묵지)는 사용자 머릿속과
Claude/Codex 프롬프트에만 있다. 이 프롬프트(Zeude ClickHouse 저장분)를 소재로,
사용자가 **많이 한 일** 별로 **한 일(사실) + 꺼낸 판단(암묵지, 근거 인용)** 을
표면화한다.

명시적으로 **아닌 것**: 성격/워크스타일 초상("질문 많이 함" 류). 사용자가 원한 것은
성격 분석이 아니라 "많이 한 일 + 그 일에 담긴 판단"을 꺼내는 것.

## 사용자 결정 사항 (확정)

- 목적: **자기 이해** — 암묵지 표면화
- 방식: **결정론적 집계 + LLM 분석 둘 다**
- 프라이버시: 별도 장치 불필요. 기존 유저 스코프 인증(토큰)이 곧 프라이버시.
- 산출물 모양: 영역별 카드 = 한 일 + 꺼낸 판단(프롬프트 근거 인용). 성격 지표 칩 없음.
  집중 시간대 같은 성격 지표는 뺀다. (비주얼 목업 A안 승인)
- 갱신: 지표성 계산은 매일(cron), LLM 판단 추출은 주 1회(또는 강제 트리거).

## 데이터 소스

Zeude ClickHouse `ai_prompts` 테이블. `serverCollect.mjs`의 기존 접근 방식 재사용:
- 접속: `CLICKHOUSE_URL/USER/PASSWORD`, 조회 대상 이메일 `WORK_LOG_ZEUDE_EMAIL`
- 필드: `timestamp`, `prompt_text`, `source`, `project_path`, `prompt_type`
- 기존 필터 관례 유지: `prompt_type='natural'`, 길이 ≥ 12, `<`로 시작하는 시스템
  생성 XML(task-notification 등) 제외, `prompt_id` 기준 dedupe

## 컴포넌트 (작은 단위로 분리)

### 1. `src/lib/workAreaGrouping.mjs` (신규, 순수 함수)

프롬프트 배열 → 영역별 그룹. LLM·I/O 없음, 완전 단위테스트 가능.
export 함수명: `groupWorkAreas(prompts, { topN = 5 })`.

- 입력: `[{ timestamp, text, source, projectPath }]`
- `projectPath`의 마지막 세그먼트를 영역 키로 사용(예: `driving-teacher-frontend`)
- 영역별 집계: 프롬프트 수, 최초/최종 날짜, 프롬프트 텍스트 배열
- 프롬프트 수 내림차순 정렬 = "많이 한 일" 순
- 상위 N개 영역만 반환(기본 5), 나머지는 버림 — `log()`로 버린 개수 노출
- 반환: `[{ area, promptCount, firstDate, lastDate, prompts: [...] }]`

### 2. `serverCollect.mjs` 확장: `collectZeudePromptWindow(userId, days)`

기존 `collectZeudePrompts(date)`는 하루치만 가져온다. 롤링 윈도우(기본 30일)를
`projectPath` 포함해 가져오는 함수 추가. 반환 행 shape는 grouping 입력과 일치.
기존 KST 윈도우 계산·필터 관례 그대로.

### 3. `src/lib/workStyleExtract.mjs` (신규)

영역 그룹 → LLM으로 암묵지 추출. 기존 `openai.mjs` 클라이언트 재사용
(`WORK_LOG_OPENAI_MODEL`).

- 입력: 영역 그룹 하나(area, prompts 일부 샘플링 — 토큰 상한 내)
- 프롬프트: "이 프롬프트들만 근거로, 이 사람이 이 영역에서 (a) 무슨 일을 했고
  (b) 어떤 판단·기준·원칙을 가지고 일했는지 추출하라. 각 판단은 실제 프롬프트에서
  인용 가능한 근거가 있어야 한다. 근거 없는 일반론 금지."
- 과대해석 방지 프레이밍 명시: 프롬프트는 주로 *묻는* 기록이므로 확정적 성격 규정
  대신 "이 근거에서 드러나는" 정도로 한정.
- 반환(JSON): `{ area, did: [string], judgments: [{ text, evidence, date }] }`
- 영역별로 개별 호출(영역이 서로 독립이라 병렬 가능)

### 4. `blob.mjs` 확장

- 경로: `worklog/workstyle/analysis.json` (유저 스코프, `pathForUser`)
- `saveWorkStyleAnalysis(data, userId)` / `readWorkStyleAnalysis(userId)` — 기존
  worklog 헬퍼와 동일 패턴(private, allowOverwrite)
- 저장 문서 shape:
  ```
  {
    generatedAt: ISO,        // 지표성(그룹핑) 갱신 시각
    llmGeneratedAt: ISO,     // LLM 판단 추출 갱신 시각 (신선도 표시용)
    windowDays: 30,
    areas: [
      { area, promptCount, firstDate, lastDate,
        did: [string],
        judgments: [{ text, evidence, date }] }
    ],
    droppedAreas: number     // 상위 N 밖으로 버린 영역 수
  }
  ```

### 5. 오케스트레이션: `/api/collect` cron 확장

기존 서버 수집기에 워크스타일 갱신 단계 추가. 순서:

1. `collectZeudePromptWindow` (30일)
2. `groupWorkAreas` (매 실행 — 싸다)
3. LLM 판단 추출은 **stale일 때만**: 이전 `llmGeneratedAt`이 7일 초과거나
   `?forceLlm=1`. 상위 N개 영역 병렬 호출.
4. `saveWorkStyleAnalysis`

각 단계 실패는 비치명적. ClickHouse/OpenAI 미설정 → 스킵, 이전 분석 유지, cron
결과 JSON에 사유 표기. cron은 절대 throw로 500 내지 않는다.

### 6. 읽기 + UI

- 읽기: `/api/profile` 응답에 `workStyleAnalysis` 필드 추가(유저 스코프, 기존
  cookieAuth 안). 별도 엔드포인트 대신 홈이 이미 읽는 profile에 얹는다.
- UI: `WorkLogPage.jsx`의 기존 `workStyle` 키워드 템플릿 섹션을 영역 카드로 교체.
  - 영역 카드: 헤더(영역명 + "가장 많이"/프롬프트 수 + 기간), "한 일"(사실),
    "꺼낸 판단"(문장 + 근거 인용 + 날짜)
  - 하단 신선도: "N일 전 분석"
  - 분석 없음(미설정/데이터 없음) → 기존 키워드 템플릿을 폴백으로 유지 + 안내

## 데이터 흐름

```
Zeude ClickHouse (30일 프롬프트)
  → collectZeudePromptWindow
  → groupWorkAreas (순수, 매일)
  → workStyleExtract (LLM, 주1회) ─┐
                                    ├→ Blob worklog/workstyle/analysis.json
                                    ┘
  → /api/profile (workStyleAnalysis)
  → WorkLogPage 영역 카드
```

## 에러 처리

| 상황 | 동작 |
|------|------|
| ClickHouse 미설정/프롬프트 0건 | 분석 null, UI는 키워드 폴백 + 안내. 비치명적 |
| LLM 실패 | 그룹핑 결과·이전 판단 유지, 경고 로그. cron 성공 유지 |
| 상위 N 초과 영역 | 버리고 `droppedAreas`로 개수 노출(무음 절단 금지) |
| 신선도 | `llmGeneratedAt`을 UI에 "N일 전"으로 노출 |

## 테스트

- `workAreaGrouping`: 픽스처 프롬프트 → 영역 분류/정렬/상위 N 절단/날짜 범위
- `workStyleExtract`: OpenAI mock → 프롬프트 구조·JSON 파싱·실패 시 우아 처리
- `blob` workstyle 경로 유저 스코핑
- `collectZeudePromptWindow`: fetch mock → 윈도우 쿼리 파라미터·projectPath 매핑

## 범위 밖 (YAGNI)

- 팀/관리자 뷰 (기존 인증으로 본인만)
- 시계열 추세 차트
- 이력서 연동 (V1 제외)
- LLM 주기/윈도우 UI 설정 (상수)
- 성격 지표 칩(질문비율·집중시간대 등) — 사용자가 명시적으로 제외
