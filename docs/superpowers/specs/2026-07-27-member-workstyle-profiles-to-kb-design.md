# 멤버별 업무방식 프로필 → KB 사람 노드 (v1)

작성일: 2026-07-27
상태: 설계 확정 대기

## 배경 / 문제

work-log은 각 멤버의 Claude/Codex 프롬프트(Zeude ClickHouse)를 분석해 "판단 기준 +
많이 한 일"을 뽑는다(workstyle analysis). 지금은 그 사람 본인만 work-log 홈에서 본다.

이걸 **팀 지식자산**으로 만들고 싶다: 멤버별 업무방식을 회사 KB
(`driving-teacher-knowledge-base`)의 **사람 노드**로 쌓아, 팀이 서로 배우고,
인수인계에 대비하고, 나아가 "그 사람의 판단을 참고/학습"할 수 있게.

핵심 통찰: 지금 분석은 **서술문**("이 사람은 검증 안 된 걸 완료로 안 본다")이라 *읽을* 순
있어도 *적용*이 안 된다. 프로필 콘텐츠를 **적용 가능한 형태**(작동 휴리스틱 + 페르소나
프롬프트)로 설계해야 "암묵지를 꺼내 쓴다"는 목적이 성립한다.

## 목표 (v1)

- 각 멤버의 workstyle 분석 + 인수인계 합성을 **적용 가능한 프로필 markdown**으로 생성.
- 그 md를 KB `raw/people/{member}.md`에 **클라우드에서 완전 자동**으로 커밋 →
  KB의 기존 그래프 재빌드가 흡수 → 사람 노드로 팀이 탐색/열람.
- 동의는 오프라인 사전 합의, 게시 후 슬랙 DM 통지.

## 비목표 (다음 스펙)

- 코칭/제안 레이어("이 사람이 어떻게 생각하면 더 발전적일지").
- 데이터 확장(AI 응답·PR/커밋 결과·Slack 결정까지 수집).
- 능동 질의/에이전트("X라면?" 대화형) — KB의 기존 AI설명 위에 v2에서 얹음.
- 인앱 동의 게이트 UI (오프라인 합의로 대체).

## 아키텍처 — 완전 클라우드 자동 흐름

```
work-log Vercel 크론
  └─ 멤버별: workstyle 분석(Blob) + 인수인계/페르소나 합성(LLM) → markdown
  └─ GitHub Contents API 로 KB 레포에 커밋 (로컬 git 불필요, HTTPS PUT)
       → 브랜치 profiles/auto 에 커밋 → 자동 PR → 자동 머지 (KB main)
KB refresh-kb.yml (on: push)
  └─ graph_v2_build.py 등 그래프+wiki+search 재빌드 → 사람 노드 생성 → 배포
당사자
  └─ 슬랙 DM: "네 업무방식 프로필 올라갔어 <URL>, 이상하면 말해"
```

Vercel 서버리스는 로컬 git 체크아웃이 없으므로 **GitHub Contents API**로 파일을 쓴다
(work-log은 이미 GITHUB_TOKEN 보유). KB는 `refresh-kb.yml`이 `on: push`로 그래프를
재빌드하므로, 커밋만 하면 사람 노드 생성까지 KB 쪽에서 자동으로 이어진다.

## 컴포넌트 (work-log)

`src/lib/` 에 신규, 순수/조합 단위로 분리:

- **`memberProfile.mjs`**
  - `renderMemberProfile({ name, analysis, handover, generatedAt, windowDays }): string`
    — 분석 + 합성 결과를 프로필 markdown으로 렌더. 순수 함수(LLM·I/O 없음).
- **`handoverSynthesis.mjs`**
  - `synthesizeHandover(analysis, fetchImpl): Promise<Handover>` — LLM 1회.
    기존 `workStyleExtract.mjs`의 Responses API + json_schema strict 패턴 재사용.
    반환: `{ oneLiner, personaPrompt, howToWork, whatToAsk, strengths, heuristics: [{principle, whenApplies, example, howToApply}] }`.
- **`kbCommit.mjs`**
  - `putFileToRepo({ owner, repo, branch, path, content, message, token, prevSha? }): Promise<{sha, changed}>`
    — GitHub Contents API `PUT /repos/{owner}/{repo}/contents/{path}`.
    **내용 해시 비교로 바뀐 경우에만 커밋**(노이즈 방지). base64 인코딩, 기존 sha 전달.
  - `ensureBranch` / `openOrUpdatePR` / `autoMerge` — profiles/auto 브랜치에 쌓고
    PR 생성·자동 머지 (GitHub REST). 이미 열린 PR 있으면 재사용.
- **`runProfileExport({ userId })`** (신규, `serverCollect.mjs` 또는 `profileExport.mjs`):
  분석 로드 → 합성 → 렌더 → kbCommit. **기존 `/api/collect` 유저 루프에 단계로 추가**
  (별도 스케줄 안 만듦 — 수집과 같은 크론에 얹음). workstyle LLM처럼 **7일 staleness
  게이트 + 내용 해시 비교**로 안 바뀌면 skip.

## 프로필 md 구성 (적용 가능한 암묵지)

각 판단 기준을 서술문 하나가 아니라 **4겹**으로:
1. **원칙** — 무엇을 중시하는가
2. **언제 발동** — 어떤 상황/트리거에서
3. **실제 사례** — 근거 프롬프트 인용 (관찰된 것)
4. **적용법** — 남이 그대로 쓰려면

문서 구조:
```
# {이름} — 업무방식
> ⚠️ 프롬프트에서 관찰된 패턴(가설)입니다. 본인이 정정할 수 있어요.
> 목적: 이 사람 "행세"가 아니라 접근을 학습/참고.

## 한 줄 요약
## 이 사람처럼 판단하기 (페르소나 블록)
   — 원칙들을 증류한 재사용 체크리스트/프롬프트. 사람에게도, AI에 붙여도 쓰임.
## 판단 기준 (4겹 휴리스틱 × N)
## 많이 한 일 (작업 영역 · 횟수)
## 인수인계 — 이 사람과 일하는 법 / 물어볼 것 / 강점
## 메타 — 생성일, 근거 창(30일), 데이터 출처(프롬프트)
```

`## 이 사람처럼 판단하기` 블록이 **second-brain 씨앗**: KB가 그래프 노드로 흡수하면
KB의 기존 AI설명이 "X라면?" 질의에 이 블록을 근거로 답할 수 있다(공짜 질의 표면).

## KB 통합

- 배치: `raw/people/{member}.md` (원천 계층 — graphify가 사람 노드 + 문서 노드로 흡수,
  팀·프로젝트·주제와 자동 연결).
- 커밋: **profiles/auto 브랜치 + 자동 PR + 자동 머지** (main 히스토리 정리).
- 재빌드: KB `refresh-kb.yml`(on: push)이 담당 — work-log은 관여 안 함.

## 동의 / 통지

- **동의**: 오프라인 사전 합의(팀 대화). 인앱 게이트 없음.
- **통지**: 게시 후 **슬랙 DM 한 줄**(work-log SLACK_TOKEN) — 프로필 URL + "이상하면 말해".
  옵트아웃 유도 겸.

## 확인된 사실 (KB 쪽)

- **KB 레포**: `driving-teacher-bot/driving-teacher-knowledge-base`, 기본 브랜치 `main`.
- **재빌드 트리거**: `refresh-kb.yml`은 `on: push` (branches: main, `paths: raw/**` 포함)
  → `raw/people/`는 `raw/**`에 커버됨 ✅. **profiles/auto → main 자동머지가 곧 트리거.**
  동시성 그룹 `kb-pipeline`으로 sync-notion과 race 방지(우리 머지도 안전하게 큐잉).

## 검증 필요한 전제 (플랜에서 먼저 확인)

1. **⚠️ 토큰(가장 큰 리스크)**: KB 레포 owner가 `driving-teacher-bot`(봇 계정)이라,
   work-log의 현재 GITHUB_TOKEN(hackertaco, 커밋 *검색*용)은 **write 권한이 없을 가능성
   높음**. → KB write 가능한 토큰(= KB Actions가 쓰는 봇 토큰 계열)을 **별도 env
   `KB_GITHUB_TOKEN`**으로 분리해서 커밋에 사용. 플랜에서 먼저 이 토큰 확보/검증.
2. `graph_v2_build.py`가 **신규 `raw/people/` 하위 폴더를 사람 노드로 잡는지** 확인
   (안 잡으면 KB 쪽 소폭 수정 필요 — 별도 크로스레포 작업일 수 있어 플랜에서 분리 판단).

## 리스크 / 한계 (설계에 명시)

- **데이터가 얇음**: 사람 프롬프트만 봄(AI 응답·결과·성패·오프라인 결정 제외).
  휴리스틱은 확정이 아니라 **가설** → md에 표기, 정정 경로(오프라인) 안내.
- **사람 민감성**: 동료의 페르소나 프롬프트는 강력·다소 섬뜩 → "학습/참고" 프레이밍 고정.
- **커밋 노이즈**: 내용 해시 비교로 변경 시에만 커밋 + staleness 게이트.
- GitHub cron/Actions는 best-effort(지연 가능) — 즉시성 보장 아님(KB 다른 워크플로도 동일).

## 테스트

- `renderMemberProfile` 순수 렌더: 분석+합성 입력 → 기대 md 섹션/마커 포함(유닛).
- `synthesizeHandover`: 스키마 강제 + mock fetch로 파싱/필드 검증.
- `kbCommit.putFileToRepo`: mock GitHub API — 내용 동일 시 skip(changed=false),
  변경 시 PUT 호출·기존 sha 전달 확인. PR/자동머지 경로 mock.
- `runProfileExport`: staleness 게이트(안 바뀌면 skip) + 유저 루프.
- 회귀: 기존 `/api/collect` 스위트 그린.

## 배포

- work-log Vercel env: `KB_GITHUB_TOKEN`(필요 시), KB 레포 좌표. 기존 env 유지.
- KB: `refresh-kb.yml` path 필터에 `raw/people/**` 확인/추가.
- 첫 실행은 수동 트리거(`/api/collect?…` 또는 export 엔드포인트)로 검증 후 크론 상시화.
