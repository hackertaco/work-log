# Resume Feature PRD

## Goal

`work-log` 안의 `Living Resume`를, 업무로그가 누적될수록 더 자연스럽게 자라나는 이력서 시스템으로 재정의한다.

이 기능의 핵심은 단순 문장 추출이 아니다.

- 업무로그를 원본 증거로 삼는다.
- 여러 날짜의 기록을 묶어 `핵심 프로젝트`, `반복 강점`, `상위 축`을 자동 도출한다.
- 이 구조를 바탕으로 사용자가 큰 수정 없이 수용 가능한 이력서 제안을 만든다.

## Problem Statement

현재 시스템은 업무로그에서 여러 신호를 모으고 있으나, 사용자가 체감하는 `업무로그 -> 이력서` 연결감은 약하다.

주된 이유:

- 키워드와 축은 보이지만, 그것이 대표 프로젝트와 서사로 충분히 승격되지 않는다.
- 업무로그의 개별 기록이 이력서의 상위 개념으로 자연스럽게 합성되지 않는다.
- 사용자는 같은 데이터를 보고 있다는 느낌보다, 별도의 화면 두 개를 보고 있다는 느낌을 받는다.

## Product Thesis

좋은 이력서는 최근 작업의 목록이 아니라, 반복적으로 증명된 가치의 압축본이다.

따라서 `Living Resume`는 다음 구조를 가져야 한다.

1. `업무로그`
2. `증거 단위`
3. `핵심 프로젝트`
4. `반복 강점`
5. `상위 축`
6. `이력서 문장 및 섹션`

즉, 시스템의 본질은 `추출`이 아니라 `승격과 구조화`다.

## Users

- 1차 사용자: 업무로그를 꾸준히 쓰는 개인 개발자 본인
- 사용 맥락:
  - 기존 이력서 정리
  - 새 프로젝트/성과 반영
  - 장기적으로 어떤 프로젝트와 강점이 커지고 있는지 확인
  - 자기소개 문장과 이력서 포지셔닝을 지속적으로 갱신

## Success Criteria

- 사용자가 업무로그를 일정량 쌓은 뒤 이력서를 열면 `핵심 프로젝트`, `강점`, `축`이 자동으로 채워져 있다.
- 사용자는 자동 제안의 대부분을 큰 수정 없이 수용할 수 있다.
- 핵심 프로젝트는 단일 날짜가 아니라 여러 로그의 흐름을 반영한다.
- 강점은 키워드 묶음이 아니라 행동 패턴과 결과로 읽힌다.
- 축은 태그 나열이 아니라 "어떤 문제를 푸는 사람인가"를 설명하는 서사로 읽힌다.
- 각 제안은 어떤 업무로그에서 유래했는지 역추적할 수 있다.

## Non-Goals

- 날짜순 업무 일지를 이력서 본문으로 그대로 노출하지 않는다.
- Slack/세션 로그를 이력서의 1차 근거로 직접 사용하지 않는다.
- 키워드만 많이 보여주는 분석 대시보드를 목표로 하지 않는다.
- 여러 버전의 이력서를 병렬 관리하는 복잡한 CMS를 Day 1 목표로 두지 않는다.

## Inputs

### Required

- 기존 이력서 PDF

### Optional

- LinkedIn URL
  - 온보딩 시 누락 항목 보충/검증용

### Ongoing Signals

- Daily work log summaries
- Project groups and commit history
- AI review / summary lines
- Existing resume document

## Core Product Behavior

### 1. Base Resume Ingestion

- 사용자는 기존 이력서 PDF를 업로드한다.
- 시스템은 PDF에서 텍스트를 추출해 초기 이력서 구조를 만든다.
- 필요 시 LinkedIn 데이터를 보조 입력으로 사용한다.

### 2. Evidence Extraction

업무로그에서 먼저 아래 증거를 뽑는다.

- 문제 맥락
- 내가 한 행동
- 결과 또는 영향
- 사용 기술
- 관련 프로젝트 후보
- 근거가 된 날짜와 로그

핵심은 키워드보다 `문제-행동-결과` 구조다.

### 3. Promotion Layer

증거를 바로 이력서 문장으로 바꾸지 않고, 먼저 상위 개념으로 승격한다.

- `핵심 프로젝트`
  - 여러 로그에 걸쳐 반복 등장
  - 목표/문제 맥락이 있다
  - 결과 또는 사용자 가치가 있다
- `반복 강점`
  - 서로 다른 프로젝트나 로그에서 반복 검증된다
  - 예: 운영 안정성, 제품 판단력, 도구화
- `상위 축`
  - 강점과 프로젝트를 묶는 상위 포지셔닝이다
  - 예: 운영 복잡도를 제품 흐름으로 바꾸는 엔지니어

### 4. Resume Generation

이력서 화면은 아래 질문에 답해야 한다.

- 지금 이 사람을 가장 잘 설명하는 프로젝트는 무엇인가
- 어떤 강점이 반복적으로 증명되었는가
- 그래서 어떤 역할에 적합한가

이때 각 항목은 원본 업무로그 근거를 따라 내려갈 수 있어야 한다.

### 5. Review Step

- 시스템이 먼저 프로젝트, 강점, 축, 문장 후보를 제안한다.
- 사용자는 `승인`, `수정`, `제외`, `대표 프로젝트로 고정` 정도의 최소 조작만 한다.
- 사용자가 승인/수정한 내용은 자동 갱신보다 우선한다.

## Output Structure

### Primary

- HTML resume view inside `work-log`

### Secondary

- PDF download

### Optional

- Markdown export

## Resume Information Architecture

권장 구조:

- Summary / Positioning
- Profile Axes
- Repeated Strengths
- Core Projects
- Experience
- Skills
- Evidence-backed impact bullets

핵심 관계:

- 축 아래에 강점이 있다.
- 강점 아래에 대표 프로젝트가 있다.
- 프로젝트에는 근거 업무로그가 연결된다.

## UX Direction

### Work Log side

- 오늘의 작업 요약
- 누적되는 프로젝트 후보
- 최근 강점 신호
- "이 작업이 어떤 대표 프로젝트로 자라고 있는지"를 보여준다

### Resume side

- 대표 축 2~3개
- 각 축 아래 반복 강점
- 각 강점 아래 대표 프로젝트
- 각 프로젝트에 연결된 근거 로그

직접 키워드를 이리저리 옮기는 경험은 중심 UI가 아니다.

## Data Model Direction

### Evidence Layer

- work log entry
- project group
- extracted evidence items
- source references

### Promotion Layer

- core projects
- strengths
- axes
- confidence / support counts

### Resume Layer

- current resume document
- pending candidates
- approved facts
- rendered resume sections

## Merge Rules

- 기존 이력서를 초기 source of truth 초안으로 사용한다.
- 새 제안은 overwrite보다 merge를 우선한다.
- 같은 의미의 항목은 중복 제거한다.
- 더 강한 근거와 더 최근 근거가 있으면 갱신한다.
- 사용자가 수정한 항목은 시스템 갱신보다 항상 우선한다.
- 축/강점/프로젝트 제안은 원본 근거를 잃지 않아야 한다.

## Risks

- PDF 파싱 품질이 낮으면 초기 구조가 흔들릴 수 있다.
- 업무로그 품질 편차가 크면 자동 승격 결과가 불안정할 수 있다.
- 키워드 중심 로직을 계속 중심에 두면 연결감 문제를 해소하지 못한다.
- 상위 개념 합성이 과도하면 실제 근거보다 과장된 이력서가 될 수 있다.

## Open Questions

- 핵심 프로젝트 승격 기준을 어떤 점수 모델로 둘 것인가
- 자동 승격 시작 조건을 로그 개수 기준으로 둘지, 증거 품질 기준으로 둘지
- 축을 완전 자동 생성할지, 사용자가 수정 가능한 추천 초안으로 둘지
- 기존 `display_axes`와 새 `core projects / strengths / axes` 모델을 어떻게 점진 이전할지

## Acceptance Criteria

- 사용자는 기존 이력서 PDF를 업로드할 수 있다.
- 시스템은 HTML 기준의 최신 이력서 화면을 유지한다.
- 사용자는 PDF로 다운로드할 수 있다.
- 시스템은 업무로그를 바탕으로 `핵심 프로젝트`, `강점`, `축` 후보를 자동 생성한다.
- 후보는 원본 업무로그 근거와 연결되어 있다.
- 사용자는 후보를 승인/수정/제외할 수 있다.
- 사용자 수정 내용은 이후 자동 갱신보다 우선한다.
- 이력서는 날짜순 나열이 아니라 `축 -> 강점 -> 프로젝트 -> 근거` 흐름으로 읽힌다.
- 자동 제안은 사용자가 대부분 큰 수정 없이 수용 가능한 품질을 목표로 한다.
