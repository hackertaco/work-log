# Editorial 디자인 개편 + 레주메 v1/v2 분리 + "오늘 기록 생성" 버튼

작성일: 2026-07-16
상태: 설계 확정 대기

## 배경 / 문제

Work Log는 동료와 공유하는 배포본(Vercel)과, 레주메 기능까지 포함한 개인 로컬본으로
나뉘어야 한다. 현재는:

1. **디자인이 밋밋하다.** shadcn 값만 흉내 낸 수제 토큰 + glass 카드 + 파란 액센트.
   제품 성격("곱씹어 쓴 업무 일지")과 어울리는 에디토리얼 감성이 없다.
2. **Living Resume 버튼**(`WorkLogPage.jsx:345`)과 `/resume` 라우트가 배포본에도 노출된다.
   동료가 URL을 직접 치면 개인 레주메에 접근할 수 있다. 레주메 기능은 **지우지 않고**
   로컬(v2)에만 두고 싶다.
3. **"Generate Record" 버튼이 배포본에서 죽어 있다.** `/api/run-batch`는 Vercel에서
   `501`만 반환한다(로컬 파일시스템/레포 스캔 전제). 동료 화면에 에러만 뱉는 버튼이 있다.

## 목표

- Work Log 화면(홈=세션 기반 일별 뷰 + 30일 판단 원칙 + 아카이브)과 Login을
  **잉크+세리프 에디토리얼**로 개편.
- 빌드 플래그로 **v1(배포, 레주메 없음)** 과 **v2(로컬, 레주메 포함)** 를 하나의
  브랜치에서 분리. 레주메 코드는 삭제하지 않는다.
- "Generate Record"를 **"오늘 기록 생성"** 으로 바꾸고, 배포본에서도 실제로
  동작하게 한다(크론과 동일한 서버 수집을 본인 계정으로 즉시 실행).

## 비목표 (YAGNI)

- 레주메 화면 자체의 디자인 개편 (v2 전용, 이번 범위 밖).
- 셀프 회원가입/초대 UI (기존 방침대로 env 편집으로 유저 추가).
- worklog.css 전면 재작성 — 토큰 재조정 + 핵심 컴포넌트만 손본다.
- 임의 과거 날짜 재수집 UI — 버튼은 "오늘"만 대상으로 한다.

---

## Part 1 — 에디토리얼 디자인

### 방향 (확정)
- **저널/에디토리얼 감성.** 대시보드가 아니라 "읽는 문서".
- **타이포**: 헤드라인 = Noto Serif KR(500/600/700), 본문·숫자·UI = Pretendard.
- **팔레트**: 잉크(near-black `#1a1815`)가 유일한 액센트. **파란색 제거.**
  따뜻한 페이퍼 배경 유지, 격자 톤다운.
- **레이아웃**: 읽기 영역 단일 컬럼(max-width ~780px), 넉넉한 세로 리듬,
  무거운 카드/그림자 대신 **헤어라인 구분선**.

### 토큰 (`frontend/src/styles/global.css`)
- **폰트 로드 (기존 버그 동반 수정)**: 판단 결과 **Pretendard는 지금도 로드되지 않는다** —
  현재 `frontend/index.html`의 Google Fonts 링크는 "Pretendard" 패밀리를 서빙하지 않아
  본문이 조용히 시스템 폰트로 폴백 중. 이번에 함께 고친다:
  - Pretendard: **jsdelivr CDN** (`cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css`) 로 교체.
  - Noto Serif KR: Google Fonts `<link>`, **weights 500/600/700**, `display=swap`.
    (현재 링크의 500/700/900과 다르므로 요청 weight를 600 포함으로 정정.)
- 신규/변경 토큰:
  - `--font-serif: "Noto Serif KR", serif;`
  - `--ink: #1a1815; --ink-body: #33302b; --muted: #8a8378;`
  - `--rule: rgba(26,24,21,0.12); --rule-soft: rgba(26,24,21,0.07);`
  - 파란 계열(`--accent`, `--accent-subtle`, `--accent-muted`) 사용처를 잉크로 교체.
    shadcn 폼 토큰(`--primary`, `--ring` 등)은 버튼/인풋 포커스에 남기되 잉크로 재매핑.
  - 페이퍼 배경 그라디언트는 현재 값 유지/미세조정, 격자 alpha를 0.018로 낮춤.
- **파란색 리터럴 정리 (판단 지적)**: `worklog.css`에는 토큰이 아니라 **하드코딩된 파란
  리터럴이 ~116곳**(`#3d56d7`, `#4462e6`, `rgba(37,99,235,..)`, `rgba(72,92,198,..)` 등)
  있어 토큰 교체만으로는 안 지워진다. 이번 개편이 건드리는 **핵심 컴포넌트 범위(마스트헤드·
  통계·스토리·판단원칙 히어로·버튼·영역 막대)에 걸린 리터럴은 잉크/토큰으로 직접 치환**한다.
  그 외 화면(레주메 관련 등 이번 범위 밖)의 리터럴은 남겨둔다. 구현 시 `grep`으로 대상
  라인을 뽑아 목록화 후 치환.

### 컴포넌트 (`frontend/src/pages/WorkLogPage.jsx` + `worklog.css`)
목업(`.superpowers/brainstorm/.../editorial-home-v2.html`) 기준.
- **마스트헤드**: "Work Log" 세리프 브랜드 + 굵은 잉크 밑줄(1.5px), 우측 `유저 · 날짜`.
- **날짜 헤드라인**: "7월 12일 · 금요일" 큰 세리프(≈46px), 요일은 muted.
- **리드 문장**: 그날의 내러티브(shareableSentence/스토리)를 세리프 문단으로.
- **통계**: 카드 제거 → 세리프 숫자 + 상하 헤어라인. 세션/작업 영역/커밋.
- **무엇에 시간을 썼나**: 홈에선 도넛(`TodayBreakdownCard`) 대신 **잉크 막대** 분포를
  렌더한다(확정). 도넛 컴포넌트는 삭제하지 않고 남겨두되 홈에서 렌더하지 않는다.
- **오늘의 작업과 판단**: 세리프 제목 스토리 항목, 헤어라인 구분.
- **나는 어떤 기준으로 일하는가**: 판단 원칙을 **세리프 풀쿼트**(≈25px)로,
  번호·설명·근거는 작게. 히어로 위치 유지.
- **버튼**: 잉크 솔리드(주) + 아웃라인(보조), radius 3px.
- Login 화면도 같은 토큰으로 정리.

---

## Part 2 — 레주메 v1/v2 분리 (빌드 플래그)

레주메 코드는 **삭제하지 않는다.** 노출만 게이팅한다.

### 프런트 플래그: `import.meta.env.VITE_ENABLE_RESUME`
활성 조건: `VITE_ENABLE_RESUME === '1'`. (Vite가 `VITE_` prefix를 빌드시 리터럴로 인라인)
- `frontend/src/App.jsx`: `RESUME_ENABLED = import.meta.env.VITE_ENABLE_RESUME === '1'`
  상수로 `/resume`, `/resume/chat` 라우트 분기를 감싼다. off면 "경로 없음" 폴백.
- **트리셰이킹 (실측 정정)**: **정적 import를 그대로 둔 채 라우트 분기만 리터럴 플래그로
  감싸면 이미 번들에서 제외된다** — 실측 확인(플래그 off 빌드 `index-*.js` 420KB→37KB,
  ResumePage canary 문자열 grep 0건). Vite가 플래그를 리터럴로 치환→Rollup이 죽은 분기의
  유일한 참조(`<ResumePage/>`)를 제거→참조 없는 모듈을 트리셰이킹. **동적 import는
  불필요하다**(이전 스펙의 "lazy 필수" 서술은 오류). 굳이 lazy로 바꾸면 `lazy(() => import())`
  호출부 자체를 플래그로 감싸지 않는 한 청크 파일이 `dist/`에 남아 URL로 접근 가능하니
  오히려 주의. → **정적 import 유지 + 리터럴 분기** 방식으로 확정.
- `WorkLogPage.jsx:345`: Living Resume `<a>`를 플래그 on일 때만 렌더.

### 백엔드 플래그: `WORK_LOG_ENABLE_RESUME`
활성 조건: `process.env.WORK_LOG_ENABLE_RESUME === '1'`.
- `src/server.mjs`에서 off면 다음을 **등록하지 않음/차단**:
  - `/api/resume/*` → **404**
  - `/resume`, `/resume/*` GET(SPA 페이지 라우트) → **`/`로 redirect(302)**.
    **이 redirect는 반드시 `cookieAuth()` 미들웨어(현 server.mjs:46-48)보다 앞에 등록**한다
    (뒤에 두면 미로그인 사용자가 `/login`으로 갔다가 복귀하는 순서 문제 발생 — 판단 지적).
  - LinkedIn 라우트(`/api/resume/linkedin` 등) → 등록 스킵(404)
  - `registerResumeBatchHook()` 스킵
- 목적: 동료가 URL을 직접 쳐도 레주메 데이터/페이지에 접근 불가.

### 🔴 응답 필드 누수 차단 (판단이 찾은 치명적 구멍 — 반드시 수정)
게이팅을 다 해도, 레주메성 데이터가 **일반 홈 로드 경로**로 새고 있음(실측 확인):
- `buildSummary`/`buildBatchSummary`가 `summary.resume`(candidates/companyCandidates/
  openSourceCandidates/notes)를 **플래그와 무관하게 항상 생성** → Blob 저장 →
  `GET /api/day/:date`(server.mjs:104-108)가 **필터 없이 그대로 반환**.
- `buildProfileSummary`가 `profile.resumeDraft`(headline/summary/strengthLabels)를 항상
  생성 → `GET /api/profile`(server.mjs:110-122)이 **`{...profile}`로 그대로 스프레드 반환**.
- 둘 다 홈 화면(`WorkLogPage.jsx`)이 정상 로드 시 fetch → 동료 브라우저 Network 탭에 노출.

**수정 방침**: `WORK_LOG_ENABLE_RESUME` off일 때 **응답 경계에서 strip**한다(생성 파이프라인은
그대로 두어 로컬 v2와 코드 공유). 대상 3개 엔드포인트에 공통 sanitizer 적용:
  - `GET /api/day/:date` → 응답에서 `resume` 필드 제거
  - `GET /api/profile` → 응답에서 `resumeDraft` 필드 제거
  - `POST /api/run-batch` → 반환 요약에서 `resume` 필드 제거 (Part 3와 연결)
플래그 on(로컬 v2)이면 그대로 통과. 테스트로 off/on 양쪽 검증(아래 테스트 섹션).

### 환경별 기본값
- **Vercel(v1)**: 두 플래그 미설정 → 레주메 완전 비활성(버튼·라우트·API·번들 제외).
- **로컬(v2)**: `frontend/.env.local`에 `VITE_ENABLE_RESUME=1`,
  루트 `.env.local`에 `WORK_LOG_ENABLE_RESUME=1`. (`.env.local`은 gitignore 확인)
- README/문서에 로컬 v2 실행법 한 줄 기록.

---

## Part 3 — "오늘 기록 생성" 버튼

### 프런트 (`WorkLogPage.jsx`)
- 라벨 `Generate Record` → **`오늘 기록 생성`** (`Generating...` → `생성 중...`).
- 동작: 대상 날짜를 **항상 오늘(KST)** 로 세팅 → `/api/run-batch`에 `{ date: 오늘 }`
  POST → 성공 시 오늘 요약 로드/표시. 기존 throttle(`BATCH_THROTTLE_MS`) 유지.

### 백엔드 (`src/server.mjs`, `POST /api/run-batch`)
현재 `if (process.env.VERCEL) return 501` 분기를 교체:
- **Vercel**: `runServerCollection({ userId: user.id, dates: [date] })` 실행 후
  `readDailySummary(date, user.id)` 반환. (크론과 동일 경로, cookieAuth로 본인만,
  전체 유저 루프 아님)
- **로컬**: 기존 `runDailyBatch(date, { userId })` 그대로.
- 30일 판단 원칙 LLM은 `runWorkStyleAnalysis`의 7일 staleness gate에 의존 —
  버튼 클릭 시 매번 LLM 재생성하지 않음(오늘 하루 수집만 수행).

### 서버측 레이트리밋 (판단 지적 — 배포 전 필수)
프런트 throttle(`BATCH_THROTTLE_MS`)은 React ref 기반이라 새로고침·다중 탭·curl/devtools로
쉽게 우회됨. `/api/run-batch`는 `buildSummary`→`summarizeWithOpenAI`로 **실제 OpenAI 비용**이
발생하므로 서버측 가드를 둔다:
- **유저+날짜 단위 인메모리 디바운스**: 같은 `(userId, date)`에 대해 마지막 실행 후 N초
  (예: 30초) 이내 재요청은 최근 결과를 반환하거나 429. 서버리스 인스턴스 재사용 특성상
  완벽하진 않지만 연타·단순 우회를 막는 1차 방어로 충분.

### 주의
- 서버 수집은 Blob에 user-scoped로 쓰며 `collector:"server"` 마커를 유지(로컬 배치
  데이터를 덮지 않음). Vercel엔 로컬 배치가 없어 충돌 없음.
- 반환 요약은 위 응답 sanitizer를 거쳐 `resume` 필드가 제거된 상태로 프런트에 전달.

---

## 영향 파일 (예상)
- `frontend/index.html` — Noto Serif KR 폰트 링크
- `frontend/src/styles/global.css`, `design-system.css`, `pages/worklog.css` — 토큰·컴포넌트
- `frontend/src/App.jsx` — 레주메 라우트 게이팅(정적 import 유지 + 리터럴 분기)
- `frontend/src/pages/WorkLogPage.jsx` — 레주메 버튼 게이팅, 에디토리얼 마크업, 버튼명/동작
- `frontend/src/pages/Login.jsx` / `Login.module.css` — 토큰 정리
- `src/server.mjs` — 레주메 백엔드 게이팅 + **응답 sanitizer**(resume/resumeDraft strip) +
  run-batch Vercel 분기 교체 + 서버측 레이트리밋
- `frontend/.env.local`, `.env.local`(로컬 전용, 커밋 안 함)

## 테스트
- **응답 누수 차단(최우선)**: `WORK_LOG_ENABLE_RESUME` off일 때 `/api/day/:date` 응답에
  `resume` 없음, `/api/profile` 응답에 `resumeDraft` 없음, `/api/run-batch` 반환에 `resume`
  없음. on일 때 모두 존재.
- run-batch 분기: Vercel 환경(`process.env.VERCEL`)에서 `runServerCollection` 호출 +
  sanitize된 요약 반환(mock), 로컬에서 `runDailyBatch` 경로 확인.
- 레주메 게이팅: off일 때 `/api/resume/*` 404, `/resume` 302→`/`, on일 때 통과.
- run-batch 레이트리밋: 같은 유저+날짜 연속 호출 시 2번째가 디바운스됨.
- **프런트 빌드 회귀(번들 grep)**: 플래그 off 빌드 산출물(`dist/assets/*.js`)에 레주메
  canary 문자열 0건. 향후 참조 추가로 트리셰이킹이 조용히 깨지는 걸 잡기 위해 이 grep을
  스크립트화(가능하면 CI/`npm` 스크립트로).
- 기존 lib 스위트 회귀 없음(`npm test`, `npm run check`, `npm run build`).
- 참고: `vite dev`(로컬 v2)는 번들링을 안 해 트리셰이킹이 적용되지 않음 — dev에선
  ResumePage가 네트워크로 로드되나 로컬 개인 환경이라 무방(보안 이슈 아님).

## 배포
- Vercel: 플래그 미설정 유지(레주메 off), `NODEJS_HELPERS=0` 등 기존 env 유지.
- 로컬: `.env.local` 두 파일에 플래그 `=1`.
