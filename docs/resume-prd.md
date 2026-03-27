# Resume Feature PRD Draft

## Goal

`work-log` 안에 `living resume` 기능을 추가한다.

이 기능은 날짜별 업무로그와 별도로, 기존 이력서와 새로 쌓이는 작업 기록을 지속적으로 병합해 하나의 최신 이력서를 유지하는 것을 목표로 한다.

핵심은 다음 세 가지다.

- 기존 이력서를 읽어 현재 기준 문서로 삼는다.
- 이후 커밋, 업무로그, AI 평가, 프로젝트 기록을 바탕으로 이력서 후보를 지속적으로 갱신한다.
- 사용자는 HTML 화면에서 최신 이력서를 보고, PDF로 다운로드하고, 가능하면 Markdown으로도 내보낼 수 있다.

## Non-Goals

- 날짜순 업무 일지 자체를 이력서 본문으로 직접 노출하지 않는다.
- Slack/세션 로그를 이력서의 1차 근거로 사용하지 않는다.
- 여러 버전의 이력서를 병렬 관리하는 복잡한 CMS를 만들지 않는다.

## Users

- 1차 사용자: 개인 개발자 본인
- 사용 맥락:
  - 기존 이력서 정리
  - 새 프로젝트/성과 반영
  - 장기적으로 강점/기술 스택/프로젝트 arc 파악

## Inputs

### Required

- 기존 이력서 PDF 업로드

### Optional

- LinkedIn URL
  - URL을 넣으면 링크 내용을 분석해 기존 이력서 보강 입력으로 사용

### Ongoing Signals

- Git commits
  - 1차 근거
- Daily work-log summaries
  - 보조 근거
- AI review
  - 강점, 리스크, 작업 스타일 해석용
- Long-term profile
  - strengths, tech signals, project arcs

## Core Product Behavior

### 1. Base Resume Ingestion

- 사용자는 기존 이력서 PDF를 업로드한다.
- 시스템은 PDF에서 텍스트를 추출해 현재 이력서의 초안 상태를 만든다.
- 필요 시 LinkedIn URL을 추가 입력으로 받아 보조 분석을 수행한다.

### 2. Living Resume Merge

- 이후 새 커밋/업무로그/프로젝트 기록이 쌓이면 시스템은 최신 이력서에 반영 가능한 후보를 생성한다.
- 기본 원칙:
  - commit-first
  - 날짜별 로그는 직접 본문이 아니라 증거/보조 신호
  - 세션/Slack은 “왜 이 일을 했는가”, “어떤 스타일인가” 해석용

### 3. Review Step

- 자동 분류를 기본으로 한다.
- 하지만 최종 반영 전에는 사용자가 확인/편집할 수 있어야 한다.
- 즉:
  - 시스템이 먼저 카테고리와 문장 후보를 제안
  - 사용자가 승인/수정
  - 승인된 내용만 최신 이력서 문서에 merge

## Resume Output

### Primary

- HTML
  - `work-log` 화면 안에서 바로 읽을 수 있어야 함

### Secondary

- PDF 다운로드

### Optional

- Markdown export

## Resume Structure

날짜순 구조가 아니라 `역량 / 스킬 카테고리` 중심으로 간다.

권장 구조:

- Summary / Profile
- Strengths
- Core Skills / Tech Signals
- Experience Themes
- Project Evidence
- Selected Impact

각 카테고리 안에는 아래가 같이 들어갈 수 있다.

- 능력/강점 설명
- 대표 프로젝트 사례
- 실제 영향/성과
- 기술 스택 근거

## Category Strategy

초기 제안 카테고리:

- Reliability / Stability
- Product Judgment
- Frontend Engineering
- Systems / Architecture
- AI Tooling / Agent Systems
- Operations / Workflow Design

이 카테고리는 고정값이 아니라, 실제 데이터가 쌓이면 조정 가능해야 한다.

## AI Interpretation Layer

이력서 기능은 단순히 “무슨 기술을 썼는지”만 나열하지 않고, 아래를 같이 해석해야 한다.

- 어떤 문제를 자주 해결하는 사람인지
- 어떤 기술에 강점이 있는지
- 어떤 방식으로 일하는지
- 이력서에서 가장 강조해야 하는 축이 무엇인지

이 해석은 `AI Review`와 `Long-term Profile`로 표현한다.

## Long-Term Profile

여러 날짜의 기록을 누적해서 아래를 생성한다.

- Strength Signals
- Tech Signals
- Work Style
- Project Arcs

예:

- 운영 안정화에 강함
- React / Next.js, AI pipeline, Maps / Location에 강함
- 예외 상황을 먼저 줄이는 스타일
- 특정 프로젝트에서 장기적으로 어떤 흐름을 개선해 왔는지

## Data Model Direction

### Daily Layer

- daily work log
- project groups
- AI review

### Living Resume Layer

- current resume document
- pending merge candidates
- approved resume facts
- category mapping
- project evidence mapping
- long-term profile summary

## Merge Rules

- 기존 이력서를 source of truth 초안으로 사용
- 새 후보는 overwrite보다 merge 우선
- 같은 의미의 문장은 중복 제거 필요
- 더 강한 문장/더 최근 증거가 있으면 갱신 가능
- 사용자가 승인하지 않은 항목은 draft 상태 유지

## Risks

- 기존 PDF 파싱 품질이 낮을 수 있음
- LinkedIn URL 분석은 접근성/콘텐츠 구조에 영향 받을 수 있음
- 자동 분류가 잘못되면 이력서 톤이 흐려질 수 있음
- 날짜별 로그를 그대로 이력서화하면 산만해질 수 있음

## Open Questions

- PDF 파싱 결과를 사용자가 직접 정정하는 화면이 필요한가?
- LinkedIn은 요약 텍스트만 참고할지, 구조화 데이터까지 만들지?
- 승인/편집 단계에서 문장 단위 diff UI가 필요한가?
- 카테고리 체계를 사용자가 직접 편집할 수 있어야 하는가?

## Acceptance Criteria Draft

- 사용자는 기존 이력서 PDF를 업로드할 수 있다.
- 시스템은 HTML 기준의 최신 이력서 화면을 유지한다.
- 사용자는 PDF로 다운로드할 수 있다.
- 가능하면 Markdown으로도 export할 수 있다.
- 시스템은 commit/work-log/profile을 바탕으로 새 이력서 후보를 생성한다.
- 후보는 역량/스킬 카테고리에 자동 분류된다.
- 사용자는 최종 merge 전에 확인/편집할 수 있다.
- 최신 이력서는 날짜순이 아니라 카테고리 중심 구조를 따른다.
- 프로젝트 사례와 영향이 카테고리 안에서 연결되어 보인다.
- 장기적으로 strengths / tech signals / project arcs를 확인할 수 있다.
