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
- 폰트 로드: `frontend/index.html`에 Noto Serif KR `<link>` 추가
  (Google Fonts, weights 500/600/700, `display=swap`). Pretendard는 기존 유지.
- 신규/변경 토큰:
  - `--font-serif: "Noto Serif KR", serif;`
  - `--ink: #1a1815; --ink-body: #33302b; --muted: #8a8378;`
  - `--rule: rgba(26,24,21,0.12); --rule-soft: rgba(26,24,21,0.07);`
  - 파란 계열(`--accent`, `--accent-subtle`, `--accent-muted`) 사용처를 잉크로 교체.
    shadcn 폼 토큰(`--primary`, `--ring` 등)은 버튼/인풋 포커스에 남기되 잉크로 재매핑.
  - 페이퍼 배경 그라디언트는 현재 값 유지/미세조정, 격자 alpha를 0.018로 낮춤.

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
활성 조건: `VITE_ENABLE_RESUME === '1'`. (Vite가 `VITE_` prefix를 빌드시 인라인)
- `frontend/src/App.jsx`: `/resume`, `/resume/chat` 라우트를 플래그 뒤로.
  off면 "경로 없음" 폴백으로.
- `ResumePage`/`ResumeChatPage`를 **동적 `import()`(lazy)** 로 변경 → 플래그가
  빌드 상수 `false`면 Rollup이 해당 청크를 번들에서 제외.
- `WorkLogPage.jsx:345`: Living Resume `<a>`를 플래그 on일 때만 렌더.

### 백엔드 플래그: `WORK_LOG_ENABLE_RESUME`
활성 조건: `process.env.WORK_LOG_ENABLE_RESUME === '1'`.
- `src/server.mjs`에서 off면 다음을 **등록하지 않음/차단**:
  - `/api/resume/*` → **404**
  - `/resume`, `/resume/*` GET(SPA 페이지 라우트) → **`/`로 redirect(302)**
  - LinkedIn 라우트(`/api/resume/linkedin` 등) → 등록 스킵(404)
  - `registerResumeBatchHook()` 스킵
- 목적: 동료가 URL을 직접 쳐도 레주메 데이터/페이지에 접근 불가.

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

### 주의
- 서버 수집은 Blob에 user-scoped로 쓰며 `collector:"server"` 마커를 유지(로컬 배치
  데이터를 덮지 않음). Vercel엔 로컬 배치가 없어 충돌 없음.
- 연타/비용 방지: 프런트 throttle 유지. (서버측 가드는 필요 시 후속.)

---

## 영향 파일 (예상)
- `frontend/index.html` — Noto Serif KR 폰트 링크
- `frontend/src/styles/global.css`, `design-system.css`, `pages/worklog.css` — 토큰·컴포넌트
- `frontend/src/App.jsx` — 레주메 라우트 게이팅 + lazy import
- `frontend/src/pages/WorkLogPage.jsx` — 레주메 버튼 게이팅, 에디토리얼 마크업, 버튼명/동작
- `frontend/src/pages/Login.jsx` / `Login.module.css` — 토큰 정리
- `src/server.mjs` — 레주메 백엔드 게이팅 + run-batch Vercel 분기 교체
- `frontend/.env.local`, `.env.local`(로컬 전용, 커밋 안 함)

## 테스트
- `src/server.mjs` run-batch 분기: Vercel 환경에서 서버 수집 호출 + 요약 반환(mock),
  로컬에서 runDailyBatch 호출 경로 확인.
- 레주메 게이팅: `WORK_LOG_ENABLE_RESUME` off일 때 `/api/resume/*` 404, on일 때 통과.
- 프런트 빌드: 플래그 off 빌드에 레주메 청크 미포함 확인(번들 산출물 grep).
- 기존 lib 스위트 회귀 없음(`npm test`, `npm run check`, `npm run build`).

## 배포
- Vercel: 플래그 미설정 유지(레주메 off), `NODEJS_HELPERS=0` 등 기존 env 유지.
- 로컬: `.env.local` 두 파일에 플래그 `=1`.
