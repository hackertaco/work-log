# Work Log -> Resume Implementation Plan

## Objective

현재의 `키워드/축` 중심 파이프라인을 유지한 채, 그 위에 `핵심 프로젝트 -> 강점 -> 축` 상위 레이어를 점진적으로 추가한다.

목표는 한 번에 갈아엎는 것이 아니라, 현재 코드 흐름을 이용해 가장 부족한 연결 고리부터 보강하는 것이다.

## Current state

현재 코드에서 이미 있는 것:

- 업무로그 요약과 `projectGroups`
- 일일 resume bullet 후보 캐시
- 프로필 요약 (`strengths`, `techSignals`, `projectArcs`, `workStyle`)
- 이력서 구조화 저장
- `display_axes`와 `strength_keywords`

현재 병목:

- [profile.mjs](src/lib/profile.mjs)
  - 패턴 기반 점수화라서 `반복 강점`은 일부 잡지만, 이력서 구조와 직접 연결되지 않는다.
- [resumeRecluster.mjs](src/lib/resumeRecluster.mjs)
  - 미분류 키워드 비율과 재클러스터링 중심이라 `핵심 프로젝트 승격` 개념이 없다.
- [resumeReconstruction.mjs](src/lib/resumeReconstruction.mjs)
  - 업무로그 bullet을 다시 읽어 전체 이력서를 재구성하지만, 중간에 상위 개념 레이어가 없다.
- [WorkLogPage.jsx](frontend/src/pages/WorkLogPage.jsx)
  - 스냅샷 요약은 있지만 "이 로그가 어떤 대표 프로젝트로 연결되는가"가 없다.
- [ResumeBody.jsx](frontend/src/components/resume/ResumeBody.jsx)
  - `display_axes`는 렌더링되지만, 축-강점-프로젝트 계층은 아직 없다.

## Proposed phases

## Phase 1: add a promotion data layer

새 도메인 모델을 추가한다.

- `coreProjects`
- `strengthSignals` 또는 `resumeStrengths`
- `resumeAxesV2`

각 항목의 최소 필드:

- `coreProjects`
  - `id`
  - `title`
  - `summary`
  - `sourceDates`
  - `repos`
  - `evidenceIds`
  - `confidence`
- `resumeStrengths`
  - `id`
  - `label`
  - `summary`
  - `projectIds`
  - `evidenceIds`
  - `confidence`
- `resumeAxesV2`
  - `id`
  - `label`
  - `tagline`
  - `strengthIds`
  - `projectIds`
  - `confidence`

저장 위치는 초기에는 기존 resume document 내부 확장 필드가 가장 현실적이다.

## Phase 2: build evidence extraction from work logs

새 모듈을 추가한다.

- 제안 파일: `src/lib/resumeEvidence.mjs`

역할:

- 일일 업무로그와 `projectGroups`, `resume.candidates`, `aiReview`를 읽는다.
- 각 날짜에서 `문제`, `행동`, `결과`, `기술`, `프로젝트 후보`를 뽑는다.
- 최소 단위 evidence array를 만든다.

초기에는 완전한 LLM 의존보다, 기존 데이터와 규칙 기반 추출을 우선 활용한다.

- `projectGroups`로 repo/repo category 연결
- `resume.candidates`와 `companyCandidates`, `openSourceCandidates`를 증거 텍스트로 사용
- `aiReview`는 보조 신호로만 사용

## Phase 3: promote evidence into core projects

새 모듈을 추가한다.

- 제안 파일: `src/lib/resumeCoreProjects.mjs`

역할:

- evidence를 repo, 주제, 반복 날짜 기준으로 묶는다.
- 하나의 날짜 이벤트가 아니라 장기 흐름을 가진 것만 `coreProjects`로 승격한다.

초기 승격 기준 예시:

- 2일 이상 반복
- 2개 이상 evidence 보유
- 프로젝트 요약을 만들 수 있을 만큼 문맥이 있음
- 결과 또는 사용자 가치 문장이 최소 1개 존재

기존 [profile.mjs](src/lib/profile.mjs)의 `projectArcs`는 이 단계의 입력으로 재사용할 수 있다.

## Phase 4: derive strengths from projects and evidence

새 모듈을 추가한다.

- 제안 파일: `src/lib/resumeStrengths.mjs`

역할:

- 기존 패턴 기반 `strengths`를 버리지 않고 입력 신호로 유지한다.
- 다만 최종 강점은 `coreProjects + evidence + 기존 strength signals`를 함께 사용해 계산한다.

이 단계에서 바뀌는 점:

- 강점은 더 이상 단순 키워드 점수가 아니다.
- 서로 다른 프로젝트에서 반복 검증된 패턴만 상위 강점으로 남긴다.

예:

- `운영 안정성`
  - 여러 로그에서 예외/안정화/복구 관련 작업 반복
  - 두 개 이상의 core project에 연결됨
- `제품 판단력`
  - 흐름 개선, UX, 운영 가시성 관련 evidence 반복

## Phase 5: generate axes from strengths and projects

기존 `display_axes`를 완전히 지우지 말고, v2 레이어를 추가한다.

- 제안 파일: `src/lib/resumeAxesV2.mjs`

역할:

- 기존 키워드 축이 아니라 `강점 + 핵심 프로젝트`를 묶는 상위 축을 만든다.
- 출력은 `label + tagline + linked strengths + linked projects` 형태로 둔다.

이 단계 이후에는 기존 `display_axes`를:

- 진단용/보조 메타데이터로 내리거나
- v2 축이 안정화되면 점진 폐기할 수 있다.

## Phase 6: wire into resume generation

영향 파일:

- [resumeReconstruction.mjs](src/lib/resumeReconstruction.mjs)
- [resume.mjs](src/routes/resume.mjs)

변경 방향:

- 전체 재구성 전에 `evidence -> coreProjects -> strengths -> axesV2`를 먼저 계산한다.
- 이 결과를 LLM 또는 규칙 기반 resume generation에 입력한다.
- 결과 문장에는 가능한 한 `sourceDates`와 `evidenceIds`를 남긴다.

중요 원칙:

- LLM은 없는 사실을 만들지 않는다.
- 원본 업무로그 증거를 묶고 문장을 다듬는 역할만 한다.

## Phase 7: update the UI

### Work Log page

영향 파일:

- [WorkLogPage.jsx](frontend/src/pages/WorkLogPage.jsx)

추가할 것:

- 오늘 작업이 어떤 `핵심 프로젝트 후보`에 붙는지
- 최근 자라는 프로젝트 목록
- 강점과 프로젝트 연결

줄일 것:

- 키워드성 해석이 메인처럼 보이는 UI

### Resume page

영향 파일:

- [ResumeBody.jsx](frontend/src/components/resume/ResumeBody.jsx)
- [DisplayAxesView.jsx](frontend/src/components/resume/DisplayAxesView.jsx)
- [AxesPanel.jsx](frontend/src/components/resume/AxesPanel.jsx)

추가할 것:

- 축 아래 강점
- 강점 아래 대표 프로젝트
- 각 프로젝트의 근거 로그

줄일 것:

- 키워드 재편성 UI의 중심성
- 미분류 키워드 비율을 메인 가치처럼 보이게 하는 요소

## API changes

초기 제안:

- `GET /api/resume/profile-story`
  - `coreProjects`, `strengths`, `axesV2` 반환
- `POST /api/resume/profile-story/rebuild`
  - 강제 재계산

기존 축 API는 그대로 둔다.

- `GET /api/resume/axes`
- `POST /api/resume/axes/recluster`

이렇게 하면 점진 이전 중에도 기존 UI가 깨지지 않는다.

## Migration strategy

### Step 1

새 필드 추가만 한다. 기존 `display_axes`, `strength_keywords`는 유지한다.

### Step 2

Work Log 페이지에 `핵심 프로젝트 후보` 뷰를 먼저 추가한다.

### Step 3

Resume 페이지에 `axesV2 / strengths / coreProjects` 섹션을 추가한다.

### Step 4

기존 `display_axes` UI를 보조 탭 또는 고급 편집 영역으로 내린다.

### Step 5

충분히 안정화되면 `display_axes` 기반 주요 UI를 폐기한다.

## Testing plan

우선 테스트로 잠가야 할 것:

- 여러 날짜 로그가 하나의 core project로 묶이는지
- 서로 다른 프로젝트에서 반복된 신호만 strength로 승격되는지
- axesV2가 strength/project 관계를 잃지 않는지
- 사용자 수정 항목이 자동 재계산에 의해 덮이지 않는지
- Resume 렌더링이 근거 링크를 유지하는지

유력 테스트 파일:

- `src/lib/resumeEvidence.test.mjs`
- `src/lib/resumeCoreProjects.test.mjs`
- `src/lib/resumeStrengths.test.mjs`
- `src/lib/resumeAxesV2.test.mjs`
- `src/routes/resume.profile-story.test.mjs`

## Recommended execution order

1. evidence extractor 추가
2. core project aggregator 추가
3. strengths derivation 추가
4. axesV2 derivation 추가
5. resume route/API 연결
6. Work Log UI 연결
7. Resume UI 연결
8. 기존 axes UI 축소

## Main risks

- 업무로그 품질 편차가 커서 승격 결과가 불안정할 수 있다.
- 기존 키워드 모델과 새 상위 모델이 한동안 중복되어 UI가 복잡해질 수 있다.
- 자동 생성 문장이 과도하게 일반화되면 사용자가 다시 고치게 된다.
- migration 중 기존 테스트가 `display_axes` 중심 가정을 강하게 갖고 있을 수 있다.

## Recommendation

가장 먼저 할 일은 `핵심 프로젝트 후보`를 만드는 백엔드 레이어를 추가하는 것이다.

이게 생기면:

- 업무로그 쪽 연결감이 바로 좋아지고
- 강점과 축도 더 의미 있게 재계산할 수 있고
- 이후 Resume UI 개편도 명확해진다.

즉 첫 구현 우선순위는 `키워드 개선`이 아니라 `프로젝트 승격`이다.
