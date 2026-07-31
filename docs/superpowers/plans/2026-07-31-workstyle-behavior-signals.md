# 업무방식 프로필 v2 — 행동신호로 판단 근거 강화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zeude ClickHouse 에 이미 계산돼 있는 행동신호(좌절·재시도·툴 검증비율·효율)를 작업영역별로 모아, 업무방식 판단 추출 LLM 프롬프트에 "행동 근거"로 주입한다.

**Architecture:** 신규 `src/lib/behaviorSignals.mjs` 가 ClickHouse 를 4~5회 조회한다 — 먼저 `ai_prompts`(이메일·세션id·user_id·project_path 를 모두 가진 유일한 브리지)로 유저의 세션→작업영역 맵과 `user_id` 목록을 만들고, 그 `user_id` 로 신호 테이블을 읽어 `session_id` 로 영역에 귀속시킨다. 세션 조인이 빈약하면 유저 전체 집계(overall)로 폴백한다. `workStyleExtract.mjs` 는 이 요약을 프롬프트 문맥에 문장으로 붙이고, `serverCollect.mjs` 의 `runWorkStyleAnalysis` 가 LLM 재생성 분기에서 한 번 수집해 영역별로 넘긴다. 출력 스키마(profile md, `/api/profile`)는 바뀌지 않는다.

**Tech Stack:** Node ESM (`.mjs`), ClickHouse HTTP 인터페이스(`FORMAT JSON` + `param_*` 쿼리 파라미터), OpenAI Responses API (`gpt-5.4-mini`, json_schema strict), `node --experimental-test-module-mocks --test`.

## Global Constraints

- **신규 env 없음.** 기존 `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` 와 유저별 `zeudeEmail`(`loadConfig({ userId })`, `WORK_LOG_ZEUDE_EMAIL` 폴백)만 쓴다.
- **모든 실패는 비치명적.** env 미설정·ClickHouse 오류·조인 빈약·LLM 실패 시 빈 결과를 반환하고 절대 cron 으로 throw 하지 않는다. v1 동작(행동신호 없이 프롬프트만)으로 그대로 돌아가야 한다.
- **출력 형식 불변.** `saveWorkStyleAnalysis` 가 저장하는 필드 집합, `memberProfile.mjs` 렌더러, `/api/profile` 응답 스키마는 이 작업에서 건드리지 않는다. 행동 근거는 원칙의 `description`·`evidence` 문장 안에 자연어로만 스며든다. **별도 지표 섹션을 만들지 않는다.**
- **하위호환.** `behavior` 인자를 주지 않으면 LLM 페이로드는 v1 과 바이트 단위로 동일해야 한다.
- LLM 페이로드 규약(기존 유지): `model` 은 `WORK_LOG_OPENAI_MODEL`(기본 `gpt-5.4-mini`), `reasoning.effort: "low"`, **`max_output_tokens: 3000`**(더 낮추면 reasoning 이 예산을 먹고 JSON 이 truncate 돼 판단이 통째로 사라진다 — 2026-07-07 프로덕션 회귀), `text.format` 은 `json_schema` strict, 출력은 `data.output_text || extractOutputText(data)` 로 읽는다.
- ClickHouse 숫자는 JSON 으로 오면 문자열일 수 있다(UInt64/Decimal). **모든 수치는 `Number()` 로 감싸고 `Number.isFinite` 로 검증**한다.
- 롤링 윈도우는 KST 기준 `windowDays`(기본 30). 날짜 인터벌은 파라미터가 아니라 검증된 정수로 문자열 보간한다(기존 `collectZeudePromptWindow` 패턴과 동일).
- 테스트: `npm test` (= `node --experimental-test-module-mocks --test ...`), 문법검사: `npm run check`. 두 개 모두 그린이어야 태스크 완료.
- 커밋 트레일러: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## 기존 코드에서 가져오는 데이터 형태 (재정의 금지)

- `loadConfig({ userId })` → `{ zeudeEmail, includeSlack, ... }`
- `areaKey(projectPath)` (`src/lib/workAreaGrouping.mjs`) → `"work-log"` 같은 프로젝트 루트 문자열, 없으면 `"unknown"`
- `groupWorkAreas(prompts, { topN: 5 })` → `{ areas: [{ area, promptCount, firstDate, lastDate, prompts: string[] }], droppedAreas }`
- `runWorkStyleAnalysis` 가 저장하는 분석 객체: `{ generatedAt, llmGeneratedAt, windowDays, principles: [{title, description}], areas: [{area, promptCount, firstDate, lastDate, did: string[], judgments: [{text, evidence}]}], droppedAreas }`
- ClickHouse 호출 관례(`src/lib/serverCollect.mjs:193-231` 참고): POST 로 쿼리 본문, 파라미터는 URL `?param_<name>=<value>`, 헤더는 `Authorization: Basic base64(user:password)`, 쿼리 끝에 `FORMAT JSON`, 응답은 `body.data` 배열.

## 이 플랜에서 확정하는 신호 요약 타입

```
BehaviorSummary = {
  sessionCount: number,            // 이 영역(또는 전체)에 귀속된 세션 수
  avgFrustration: number | null,   // frustration_score 평균
  frustrationDensity: number | null,
  retryRate: number | null,        // Task 6 에서 채움 (그전엔 항상 null)
  efficiency: number | null,       // Task 6 에서 채움 (그전엔 항상 null)
  verificationRatio: number | null,// 검증 목적 툴 사용 비중 (0~1)
  topTools: [{ tool: string, count: number, isVerification: boolean }] // count 내림차순 최대 5개
}

BehaviorSignals = {
  byArea: Map<string, BehaviorSummary>,
  overall: BehaviorSummary,
  meta: { sessions: number, matchedRows: number, totalRows: number, joinRatio: number, fallback: boolean, error?: string }
}
```

## File Structure

- **Create** `src/lib/behaviorSignals.mjs` — ClickHouse 조회 + 세션→영역 브리지 + 영역별 집계 + 폴백 판정 + 영역 선택 헬퍼. 순수 집계 함수와 I/O 를 같은 파일에 두되 집계는 export 해 단독 테스트한다.
- **Create** `src/lib/behaviorSignals.test.mjs` — mock fetch 기반 전체 커버리지.
- **Modify** `src/lib/workStyleExtract.mjs` — `formatBehaviorContext` 추가, `buildExtractPayload(area, prompts, behavior)` / `buildSynthesisPayload(items, behaviorByArea)` / `extractWorkStyleForArea(areaGroup, behavior, fetchImpl)` / `synthesizeWorkStylePrinciples(areas, behaviorByArea, fetchImpl)` 시그니처 확장.
- **Modify** `src/lib/workStyleExtract.test.mjs` — 기존 호출부 시그니처 갱신 + 행동문맥 주입/미주입 테스트 추가.
- **Modify** `src/lib/serverCollect.mjs` — `runWorkStyleAnalysis` 의 LLM 분기에서 신호 1회 수집 후 영역별 전달.
- **Modify** `src/lib/serverCollect.workstyle.test.mjs` — 신호 수집 모듈 mock + 전달 경로 검증.
- **Modify** `package.json` — `check` 스크립트에 `node --check src/lib/behaviorSignals.mjs` 추가.
- **Modify** `docs/superpowers/specs/2026-07-31-workstyle-behavior-signals-design.md` — Task 1 의 스키마 실측 결과 기록.

---

### Task 1: Zeude 스키마 실측 — 미확인 컬럼과 세션 조인율 확인

이 태스크만 코드를 쓰지 않는다. 스펙의 최우선 리스크(“`ai_prompts.session_id` 와 신호 테이블의 `session_id` 가 안 맞으면 조인이 텅 빈다”)를 **먼저 실측**하고, 미확인 테이블 컬럼명을 확정해 문서에 남긴다. 이후 태스크가 이 기록을 참조한다.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-31-workstyle-behavior-signals-design.md` (새 섹션 추가)

**Interfaces:**
- Consumes: 없음
- Produces: 스펙 문서의 `## 스키마 실측 결과 (2026-07-31)` 섹션 — Task 2 는 여기 적힌 `frustration_analysis` / `tool_usage_daily` 컬럼명을, Task 6 은 `retry_analysis` / `efficiency_metrics_daily` 컬럼명과 “쓸 수 있는 지표가 있나” 판단을 그대로 가져다 쓴다.

- [ ] **Step 1: ClickHouse 접속 정보 확보**

크리덴셜은 zeude 대시보드 레포에 있다(2026-07-03 확인, 이번에 재확인 필요):

```bash
grep '^CLICKHOUSE' ~/Documents/company-code/zeude/zeude/dashboard/.env.local
```

세 값(`CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`)이 나오면 다음 단계로. 파일이 없거나 값이 비면 대안: `vercel env pull` (work-log 프로젝트에 같은 키가 있다) 또는 VM SSH `ssh zeude-ops.asia-northeast3-a.drivingteacher-eeb82` 후 `docker exec -it <clickhouse> clickhouse-client`.

**주의:** 이 값들을 work-log 레포 안 어떤 파일에도 쓰지 말 것. 셸 환경변수로만 쓴다.

- [ ] **Step 2: 미확인 두 테이블 컬럼 확인**

```bash
CH_URL=$(grep '^CLICKHOUSE_URL' ~/Documents/company-code/zeude/zeude/dashboard/.env.local | cut -d= -f2-)
CH_USER=$(grep '^CLICKHOUSE_USER' ~/Documents/company-code/zeude/zeude/dashboard/.env.local | cut -d= -f2-)
CH_PW=$(grep '^CLICKHOUSE_PASSWORD' ~/Documents/company-code/zeude/zeude/dashboard/.env.local | cut -d= -f2-)

for t in retry_analysis efficiency_metrics_daily frustration_analysis tool_usage_daily; do
  echo "=== $t ==="
  curl -sS -u "$CH_USER:$CH_PW" "$CH_URL" --data-binary "DESCRIBE TABLE $t FORMAT TSV"
done
```

기대: 각 테이블의 `이름 타입` 목록. `retry_analysis` / `efficiency_metrics_daily` 에 (a) `session_id` 가 있는지, (b) 재시도율·효율로 쓸 수 있는 수치 컬럼이 무엇인지 적어둔다.

- [ ] **Step 3: 세션 조인율 실측 (최우선 리스크)**

`seungah.jung@tgsociety.co.kr` 기준 30일. `ai_prompts` 의 세션 집합과 신호 테이블의 세션 집합이 실제로 겹치는지 센다.

```bash
curl -sS -u "$CH_USER:$CH_PW" "$CH_URL" --data-binary "
WITH mine AS (
  SELECT DISTINCT session_id
  FROM ai_prompts
  WHERE user_email = 'seungah.jung@tgsociety.co.kr'
    AND timestamp >= now() - INTERVAL 30 DAY
    AND session_id != ''
),
mine_users AS (
  SELECT DISTINCT user_id
  FROM ai_prompts
  WHERE user_email = 'seungah.jung@tgsociety.co.kr'
    AND timestamp >= now() - INTERVAL 30 DAY
)
SELECT
  (SELECT count() FROM mine)                                      AS prompt_sessions,
  (SELECT count() FROM mine_users)                                AS user_ids,
  countDistinct(f.session_id)                                     AS signal_sessions,
  countDistinctIf(f.session_id, f.session_id IN (SELECT session_id FROM mine)) AS matched_sessions
FROM frustration_analysis AS f
WHERE f.user_id IN (SELECT user_id FROM mine_users)
  AND f.date >= today() - 30
FORMAT Vertical"
```

같은 쿼리를 `frustration_analysis` → `tool_usage_daily` 로 바꿔 한 번 더 돌린다.

판단 기준: `matched_sessions / signal_sessions` 가 **0.2 이상이면 영역별 귀속이 유효**, 그 미만이면 Task 2 의 폴백(유저 전체 집계)이 사실상 기본 경로가 된다. 어느 쪽이든 코드는 두 경로를 모두 갖는다 — 이 숫자는 “뭘 기대할지”를 정하는 것.

- [ ] **Step 4: 실측 결과를 스펙에 기록**

`docs/superpowers/specs/2026-07-31-workstyle-behavior-signals-design.md` 의 `## 리스크` 바로 위에 아래 섹션을 추가한다. 괄호 안 값을 실제 측정값으로 채운다.

```markdown
## 스키마 실측 결과 (2026-07-31, Task 1)

- `retry_analysis` 컬럼: <DESCRIBE 결과 그대로>
- `efficiency_metrics_daily` 컬럼: <DESCRIBE 결과 그대로>
- 재시도율로 쓸 컬럼: <컬럼명 또는 "없음 — Task 6 에서 이 테이블 제외">
- 효율로 쓸 컬럼: <컬럼명 또는 "없음 — Task 6 에서 이 테이블 제외">
- 세션 조인율 (seungah.jung, 30일):
  - frustration_analysis: matched <n> / signal <n> = <ratio>
  - tool_usage_daily: matched <n> / signal <n> = <ratio>
- 결론: <"영역별 귀속 유효" 또는 "조인 빈약 — overall 폴백이 기본 경로">
```

- [ ] **Step 5: 커밋**

```bash
git add docs/superpowers/specs/2026-07-31-workstyle-behavior-signals-design.md
git commit -m "$(cat <<'EOF'
docs: record Zeude signal-table schema and session join ratio (v2 Task 1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `behaviorSignals.mjs` — 브리지 조회 + 좌절/툴 집계 + 폴백

**Files:**
- Create: `src/lib/behaviorSignals.mjs`
- Create: `src/lib/behaviorSignals.test.mjs`
- Modify: `package.json` (`check` 스크립트 끝에 항목 추가)

**Interfaces:**
- Consumes: `loadConfig` (`./config.mjs`), `areaKey` (`./workAreaGrouping.mjs`), Task 1 이 기록한 `frustration_analysis` / `tool_usage_daily` 컬럼명.
- Produces:
  - `emptySummary(): BehaviorSummary` — 모든 수치 null, `sessionCount: 0`, `topTools: []`
  - `aggregateSignals({ sessionArea, frustrationRows, toolRows }): BehaviorSignals` — 순수 함수. Task 3·6 이 이 함수를 확장/재사용한다.
  - `collectBehaviorSignals({ userId, days, fetchImpl }): Promise<BehaviorSignals>` — I/O 진입점. Task 5 가 호출한다.

- [ ] **Step 1: 실패 테스트 작성**

`src/lib/behaviorSignals.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { aggregateSignals, collectBehaviorSignals, emptySummary } from "./behaviorSignals.mjs";

const CH_KEYS = ["CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD", "WORK_LOG_ZEUDE_EMAIL"];

function setEnv() {
  process.env.CLICKHOUSE_URL = "https://clickhouse.test";
  process.env.CLICKHOUSE_USER = "u";
  process.env.CLICKHOUSE_PASSWORD = "p";
  process.env.WORK_LOG_ZEUDE_EMAIL = "user@example.com";
}
function clearEnv() {
  for (const k of CH_KEYS) delete process.env[k];
}

test("emptySummary: 수치는 전부 null, 세션 0", () => {
  assert.deepEqual(emptySummary(), {
    sessionCount: 0,
    avgFrustration: null,
    frustrationDensity: null,
    retryRate: null,
    efficiency: null,
    verificationRatio: null,
    topTools: []
  });
});

test("aggregateSignals: 세션을 영역별로 묶고 좌절 평균·검증비율·상위툴을 낸다", () => {
  const sessionArea = new Map([
    ["s1", "work-log"],
    ["s2", "work-log"],
    ["s3", "knowledge-base"]
  ]);
  const frustrationRows = [
    { session_id: "s1", requests: "10", score: "0.2", density: "0.02" },
    { session_id: "s2", requests: "10", score: "0.4", density: "0.04" },
    { session_id: "s3", requests: "5", score: "0.9", density: "0.18" }
  ];
  const toolRows = [
    { session_id: "s1", tool_name: "Read", is_verification: 1, use_count: "30" },
    { session_id: "s1", tool_name: "Edit", is_verification: 0, use_count: "10" },
    { session_id: "s3", tool_name: "Bash", is_verification: 0, use_count: "5" }
  ];

  const r = aggregateSignals({ sessionArea, frustrationRows, toolRows });

  const wl = r.byArea.get("work-log");
  assert.equal(wl.sessionCount, 2);
  assert.equal(wl.avgFrustration, 0.3);
  assert.equal(wl.verificationRatio, 0.75); // Read 30 / (30+10)
  assert.deepEqual(wl.topTools, [
    { tool: "Read", count: 30, isVerification: true },
    { tool: "Edit", count: 10, isVerification: false }
  ]);

  const kb = r.byArea.get("knowledge-base");
  assert.equal(kb.sessionCount, 1);
  assert.equal(kb.avgFrustration, 0.9);
  assert.equal(kb.verificationRatio, 0);

  // overall 은 영역 구분 없이 전체
  assert.equal(r.overall.sessionCount, 3);
  assert.equal(r.overall.topTools[0].tool, "Read");
  assert.equal(r.meta.fallback, false);
  assert.equal(r.meta.joinRatio, 1);

  // 아직 안 붙인 지표는 null 로 남아야 한다 (Task 6)
  assert.equal(wl.retryRate, null);
  assert.equal(wl.efficiency, null);
});

test("aggregateSignals: 세션 조인이 빈약하면 fallback=true, byArea 는 비운다", () => {
  const sessionArea = new Map([["s1", "work-log"]]);
  const frustrationRows = [
    { session_id: "zzz-1", requests: "10", score: "0.5", density: "0.05" },
    { session_id: "zzz-2", requests: "10", score: "0.5", density: "0.05" },
    { session_id: "zzz-3", requests: "10", score: "0.5", density: "0.05" },
    { session_id: "zzz-4", requests: "10", score: "0.5", density: "0.05" },
    { session_id: "zzz-5", requests: "10", score: "0.5", density: "0.05" }
  ];

  const r = aggregateSignals({ sessionArea, frustrationRows, toolRows: [] });

  assert.equal(r.meta.fallback, true);
  assert.equal(r.byArea.size, 0);
  // 조인이 안 붙어도 유저 전체 신호는 살아 있어야 한다
  assert.equal(r.overall.sessionCount, 5);
  assert.equal(r.overall.avgFrustration, 0.5);
});

test("aggregateSignals: 입력이 비면 빈 요약", () => {
  const r = aggregateSignals({ sessionArea: new Map(), frustrationRows: [], toolRows: [] });
  assert.deepEqual(r.overall, emptySummary());
  assert.equal(r.byArea.size, 0);
  assert.equal(r.meta.fallback, true);
});

test("collectBehaviorSignals: env 미설정이면 조회 없이 빈 결과", async () => {
  clearEnv();
  const r = await collectBehaviorSignals({
    userId: "default",
    fetchImpl: () => { throw new Error("should not fetch"); }
  });
  assert.equal(r.byArea.size, 0);
  assert.deepEqual(r.overall, emptySummary());
  assert.equal(r.meta.fallback, true);
});

test("collectBehaviorSignals: 브리지 → 신호 조회를 이어 붙여 영역별 요약을 만든다", async () => {
  setEnv();
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(String(init.body));
    const q = String(init.body);
    if (q.includes("FROM ai_prompts")) {
      return new Response(JSON.stringify({ data: [
        { session_id: "s1", user_id: "uid-1", project_path: "/Users/x/company-code/work-log" },
        { session_id: "s2", user_id: "uid-1", project_path: "/Users/x/company-code/work-log/src" }
      ] }), { status: 200 });
    }
    if (q.includes("FROM frustration_analysis")) {
      return new Response(JSON.stringify({ data: [
        { session_id: "s1", requests: "8", score: "0.1", density: "0.01" },
        { session_id: "s2", requests: "8", score: "0.3", density: "0.03" }
      ] }), { status: 200 });
    }
    if (q.includes("FROM tool_usage_daily")) {
      return new Response(JSON.stringify({ data: [
        { session_id: "s1", tool_name: "Read", is_verification: 1, use_count: "20" }
      ] }), { status: 200 });
    }
    throw new Error(`unexpected query: ${q.slice(0, 60)}`);
  };

  try {
    const r = await collectBehaviorSignals({ userId: "default", days: 30, fetchImpl });

    // 브리지가 먼저 불려야 한다 (user_id 를 얻어야 신호를 조회할 수 있음)
    assert.ok(bodies[0].includes("FROM ai_prompts"));
    // 신호 조회는 브리지에서 얻은 user_id 로 좁힌다
    assert.ok(bodies.slice(1).every((b) => b.includes("user_id IN")));

    // project_path 의 하위 폴더도 같은 영역으로 접힌다 (areaKey)
    const wl = r.byArea.get("work-log");
    assert.equal(wl.sessionCount, 2);
    assert.equal(wl.avgFrustration, 0.2);
    assert.equal(wl.verificationRatio, 1);
    assert.equal(r.meta.fallback, false);
  } finally {
    clearEnv();
  }
});

test("collectBehaviorSignals: ClickHouse 오류는 비치명적 — 빈 결과 + meta.error", async () => {
  setEnv();
  try {
    const r = await collectBehaviorSignals({
      userId: "default",
      fetchImpl: async () => new Response("boom", { status: 500 })
    });
    assert.equal(r.byArea.size, 0);
    assert.deepEqual(r.overall, emptySummary());
    assert.equal(r.meta.fallback, true);
    assert.ok(r.meta.error);
  } finally {
    clearEnv();
  }
});

test("collectBehaviorSignals: 브리지가 비면 신호 조회를 하지 않는다", async () => {
  setEnv();
  let calls = 0;
  try {
    const r = await collectBehaviorSignals({
      userId: "default",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
    });
    assert.equal(calls, 1);
    assert.deepEqual(r.overall, emptySummary());
  } finally {
    clearEnv();
  }
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

```bash
node --experimental-test-module-mocks --test src/lib/behaviorSignals.test.mjs
```

기대: FAIL — `Cannot find module '.../behaviorSignals.mjs'`

- [ ] **Step 3: 구현**

`src/lib/behaviorSignals.mjs`:

```js
/**
 * Zeude ClickHouse 의 "이미 계산된 행동신호"를 유저·작업영역별로 모은다.
 *
 * 신호 테이블(frustration_analysis, tool_usage_daily, …)엔 user_email 이 없고
 * user_id / session_id 만 있다. work-log 은 유저를 이메일로 식별하므로
 * ai_prompts(이메일·user_id·session_id·project_path 를 모두 가진 유일한 테이블)를
 * 브리지로 써서 (1) 조회할 user_id 를 얻고 (2) 세션을 작업영역에 귀속시킨다.
 *
 * 세션 조인이 빈약할 때(신호 테이블의 session_id 형식이 ai_prompts 와 다를 수 있다)
 * 영역별 귀속을 포기하고 유저 전체 집계(overall)만 남긴다 — 신호를 아예 잃지 않도록
 * 신호 조회 자체는 session_id 가 아니라 user_id 로 좁힌다.
 *
 * 모든 실패는 비치명적. 호출자는 빈 결과를 받으면 v1(프롬프트만) 동작을 한다.
 */
import { loadConfig } from "./config.mjs";
import { areaKey } from "./workAreaGrouping.mjs";

/** 이 비율 미만이면 영역별 귀속을 신뢰하지 않고 overall 로 폴백한다. */
const MIN_JOIN_RATIO = 0.2;
const MAX_BRIDGE_SESSIONS = 2000;
const TOP_TOOLS = 5;

export function emptySummary() {
  return {
    sessionCount: 0,
    avgFrustration: null,
    frustrationDensity: null,
    retryRate: null,
    efficiency: null,
    verificationRatio: null,
    topTools: []
  };
}

function emptySignals(error) {
  return {
    byArea: new Map(),
    overall: emptySummary(),
    meta: { sessions: 0, matchedRows: 0, totalRows: 0, joinRatio: 0, fallback: true, ...(error ? { error } : {}) }
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, digits = 3) {
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** ClickHouse HTTP 조회. 쿼리 파라미터는 URL 의 param_* 으로 넘긴다. */
async function queryClickHouse(query, params, fetchImpl) {
  const url = process.env.CLICKHOUSE_URL;
  const user = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) search.set(`param_${k}`, String(v));

  const res = await fetchImpl(`${url.replace(/\/$/, "")}/?${search.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${password ?? ""}`).toString("base64")}`
    },
    body: query
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const body = await res.json();
  return body.data ?? [];
}

/**
 * 순수 집계. 세션→영역 맵과 신호 행들을 영역별/전체 요약으로 접는다.
 * 조인율이 MIN_JOIN_RATIO 미만이면 byArea 를 비우고 fallback 을 세운다.
 */
export function aggregateSignals({ sessionArea, frustrationRows = [], toolRows = [] }) {
  const areaOf = sessionArea instanceof Map ? sessionArea : new Map();

  // 영역 키 → 누산기. null 키는 "전체(overall)".
  const buckets = new Map();
  const bucket = (key) => {
    if (!buckets.has(key)) {
      buckets.set(key, { sessions: new Set(), scores: [], densities: [], tools: new Map() });
    }
    return buckets.get(key);
  };

  let matchedRows = 0;
  let totalRows = 0;

  const addTo = (key, fn) => {
    if (key === undefined) return;
    fn(bucket(key));
  };

  for (const row of frustrationRows) {
    const session = String(row?.session_id ?? "");
    const area = areaOf.get(session);
    totalRows += 1;
    if (area) matchedRows += 1;

    const score = num(row?.score);
    const density = num(row?.density);
    for (const key of [null, ...(area ? [area] : [])]) {
      addTo(key, (b) => {
        if (session) b.sessions.add(session);
        if (score != null) b.scores.push(score);
        if (density != null) b.densities.push(density);
      });
    }
  }

  for (const row of toolRows) {
    const session = String(row?.session_id ?? "");
    const area = areaOf.get(session);
    totalRows += 1;
    if (area) matchedRows += 1;

    const tool = String(row?.tool_name ?? "").trim();
    const count = num(row?.use_count) ?? 0;
    const isVerification = Boolean(num(row?.is_verification));
    for (const key of [null, ...(area ? [area] : [])]) {
      addTo(key, (b) => {
        if (session) b.sessions.add(session);
        if (!tool || count <= 0) return;
        const prev = b.tools.get(tool) ?? { count: 0, isVerification: false };
        b.tools.set(tool, { count: prev.count + count, isVerification: prev.isVerification || isVerification });
      });
    }
  }

  const summarize = (b) => {
    if (!b) return emptySummary();
    const toolEntries = [...b.tools.entries()];
    const totalUse = toolEntries.reduce((sum, [, v]) => sum + v.count, 0);
    const verifyUse = toolEntries.reduce((sum, [, v]) => sum + (v.isVerification ? v.count : 0), 0);
    return {
      sessionCount: b.sessions.size,
      avgFrustration: b.scores.length ? round(b.scores.reduce((a, c) => a + c, 0) / b.scores.length) : null,
      frustrationDensity: b.densities.length ? round(b.densities.reduce((a, c) => a + c, 0) / b.densities.length) : null,
      retryRate: null,
      efficiency: null,
      verificationRatio: totalUse > 0 ? round(verifyUse / totalUse) : null,
      topTools: toolEntries
        .sort((a, b2) => b2[1].count - a[1].count)
        .slice(0, TOP_TOOLS)
        .map(([tool, v]) => ({ tool, count: v.count, isVerification: v.isVerification }))
    };
  };

  const overall = summarize(buckets.get(null));
  const joinRatio = totalRows > 0 ? matchedRows / totalRows : 0;
  const fallback = joinRatio < MIN_JOIN_RATIO;

  const byArea = new Map();
  if (!fallback) {
    for (const [key, b] of buckets) {
      if (key === null) continue;
      byArea.set(key, summarize(b));
    }
  }

  return {
    byArea,
    overall,
    meta: { sessions: overall.sessionCount, matchedRows, totalRows, joinRatio: round(joinRatio), fallback }
  };
}

/**
 * 유저의 롤링 윈도우 행동신호를 모은다. 미설정·오류·신호없음은 빈 결과.
 *
 * @param {{ userId?: string, days?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ byArea: Map<string, object>, overall: object, meta: object }>}
 */
export async function collectBehaviorSignals({ userId = "default", days = 30, fetchImpl = fetch } = {}) {
  try {
    if (!process.env.CLICKHOUSE_URL || !process.env.CLICKHOUSE_USER) return emptySignals();

    const config = await loadConfig({ userId }).catch(() => null);
    const email = config?.zeudeEmail || process.env.WORK_LOG_ZEUDE_EMAIL || "";
    if (!email) return emptySignals();

    const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;

    // 1) 브리지: 이메일 → (세션, user_id, project_path)
    const bridgeRows = await queryClickHouse(
      `
      SELECT
        session_id,
        any(user_id) AS user_id,
        argMax(project_path, timestamp) AS project_path
      FROM ai_prompts
      WHERE user_email = {email:String}
        AND timestamp >= now() - INTERVAL ${windowDays} DAY
        AND session_id != ''
      GROUP BY session_id
      LIMIT ${MAX_BRIDGE_SESSIONS}
      FORMAT JSON`,
      { email },
      fetchImpl
    );
    if (!bridgeRows.length) return emptySignals();

    const sessionArea = new Map();
    const userIds = new Set();
    for (const row of bridgeRows) {
      const session = String(row?.session_id ?? "");
      if (session) sessionArea.set(session, areaKey(row?.project_path));
      const uid = String(row?.user_id ?? "").trim();
      if (uid) userIds.add(uid);
    }
    if (!userIds.size) return emptySignals();

    // user_id 목록은 IN splitByChar 로 넘긴다 — Array 파라미터 인용 규칙을 피한다.
    const ids = [...userIds].join(",");

    // 2) 신호: user_id 로 좁힌다 (session_id 조인이 실패해도 overall 은 살아남게)
    const [frustrationRows, toolRows] = await Promise.all([
      queryClickHouse(
        `
        SELECT
          session_id,
          sum(total_requests) AS requests,
          avg(frustration_score) AS score,
          avg(frustration_density) AS density
        FROM frustration_analysis
        WHERE user_id IN splitByChar(',', {ids:String})
          AND date >= today() - ${windowDays}
        GROUP BY session_id
        FORMAT JSON`,
        { ids },
        fetchImpl
      ),
      queryClickHouse(
        `
        SELECT
          session_id,
          tool_name,
          max(is_verification) AS is_verification,
          sum(use_count) AS use_count
        FROM tool_usage_daily
        WHERE user_id IN splitByChar(',', {ids:String})
          AND date >= today() - ${windowDays}
        GROUP BY session_id, tool_name
        FORMAT JSON`,
        { ids },
        fetchImpl
      )
    ]);

    return aggregateSignals({ sessionArea, frustrationRows, toolRows });
  } catch (err) {
    return emptySignals(err?.message ?? String(err));
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
node --experimental-test-module-mocks --test src/lib/behaviorSignals.test.mjs
```

기대: PASS (8개 테스트)

- [ ] **Step 5: `check` 스크립트에 문법검사 추가**

`package.json` 의 `check` 값 맨 끝(`&& node --check src/lib/workStyleExtract.mjs` 뒤)에 이어 붙인다:

```
 && node --check src/lib/behaviorSignals.mjs
```

- [ ] **Step 6: 전체 스위트 확인**

```bash
npm run check && npm test
```

기대: 둘 다 PASS.

- [ ] **Step 7: 커밋**

```bash
git add src/lib/behaviorSignals.mjs src/lib/behaviorSignals.test.mjs package.json
git commit -m "$(cat <<'EOF'
feat: collect Zeude behavior signals per work area

frustration_analysis + tool_usage_daily, bridged to areas via ai_prompts
sessions. Signal queries are scoped by user_id, not session_id, so the
user-wide overall survives a weak session join.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 영역별 신호 선택 헬퍼

영역 하나에 대해 "이 영역에 쓸 신호"를 고르는 규칙을 한 곳에 둔다. 폴백일 땐 모든 영역이 유저 전체 신호를 공유하고, 신호가 없으면 `null` 을 줘서 호출자가 v1 동작을 하게 한다.

**Files:**
- Modify: `src/lib/behaviorSignals.mjs`
- Modify: `src/lib/behaviorSignals.test.mjs`

**Interfaces:**
- Consumes: Task 2 의 `BehaviorSignals`, `emptySummary`
- Produces:
  - `behaviorForArea(signals, area): BehaviorSummary | null`
  - `behaviorByArea(signals, areaNames: string[]): Record<string, BehaviorSummary>` — 값이 있는 영역만 담는다. Task 4 의 `buildSynthesisPayload` 와 Task 5 가 쓴다.

- [ ] **Step 1: 실패 테스트 추가**

`src/lib/behaviorSignals.test.mjs` 맨 아래에 붙인다. import 줄도 갱신한다:

```js
// 파일 상단 import 를 아래로 교체
import { aggregateSignals, behaviorByArea, behaviorForArea, collectBehaviorSignals, emptySummary } from "./behaviorSignals.mjs";
```

```js
// ─── behaviorForArea / behaviorByArea ────────────────────────────────────────

const SUMMARY_A = { ...emptySummary(), sessionCount: 3, avgFrustration: 0.2 };
const SUMMARY_ALL = { ...emptySummary(), sessionCount: 9, avgFrustration: 0.5 };

test("behaviorForArea: 영역 신호가 있으면 그걸 쓴다", () => {
  const signals = {
    byArea: new Map([["work-log", SUMMARY_A]]),
    overall: SUMMARY_ALL,
    meta: { fallback: false }
  };
  assert.deepEqual(behaviorForArea(signals, "work-log"), SUMMARY_A);
});

test("behaviorForArea: 폴백이면 모든 영역이 유저 전체 신호를 쓴다", () => {
  const signals = { byArea: new Map(), overall: SUMMARY_ALL, meta: { fallback: true } };
  assert.deepEqual(behaviorForArea(signals, "work-log"), SUMMARY_ALL);
  assert.deepEqual(behaviorForArea(signals, "knowledge-base"), SUMMARY_ALL);
});

test("behaviorForArea: 신호가 아예 없으면 null (v1 동작)", () => {
  assert.equal(behaviorForArea(null, "work-log"), null);
  assert.equal(
    behaviorForArea({ byArea: new Map(), overall: emptySummary(), meta: { fallback: true } }, "work-log"),
    null
  );
});

test("behaviorForArea: 폴백 아닌데 그 영역 신호가 없으면 null", () => {
  const signals = { byArea: new Map([["work-log", SUMMARY_A]]), overall: SUMMARY_ALL, meta: { fallback: false } };
  assert.equal(behaviorForArea(signals, "neo-fetch"), null);
});

test("behaviorByArea: 값 있는 영역만 객체로 모은다", () => {
  const signals = { byArea: new Map([["work-log", SUMMARY_A]]), overall: SUMMARY_ALL, meta: { fallback: false } };
  assert.deepEqual(behaviorByArea(signals, ["work-log", "neo-fetch"]), { "work-log": SUMMARY_A });
  assert.deepEqual(behaviorByArea(null, ["work-log"]), {});
});
```

- [ ] **Step 2: 실패 확인**

```bash
node --experimental-test-module-mocks --test src/lib/behaviorSignals.test.mjs
```

기대: FAIL — `behaviorForArea is not a function`

- [ ] **Step 3: 구현**

`src/lib/behaviorSignals.mjs` 끝에 추가한다:

```js
/**
 * 이 영역의 판단 추출에 쓸 신호를 고른다.
 * 영역 귀속이 유효하면 영역 신호, 폴백이면 유저 전체 신호, 아무것도 없으면 null.
 */
export function behaviorForArea(signals, area) {
  if (!signals) return null;
  const byArea = signals.byArea instanceof Map ? signals.byArea : new Map();
  const hit = byArea.get(area);
  if (hit?.sessionCount) return hit;
  if (signals.meta?.fallback && signals.overall?.sessionCount) return signals.overall;
  return null;
}

/** 여러 영역에 대해 behaviorForArea 를 한 번에 — 값 있는 영역만 담는다. */
export function behaviorByArea(signals, areaNames = []) {
  const out = {};
  for (const area of Array.isArray(areaNames) ? areaNames : []) {
    const b = behaviorForArea(signals, area);
    if (b) out[area] = b;
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인**

```bash
node --experimental-test-module-mocks --test src/lib/behaviorSignals.test.mjs && npm run check
```

기대: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/behaviorSignals.mjs src/lib/behaviorSignals.test.mjs
git commit -m "$(cat <<'EOF'
feat: add per-area behavior signal selectors with overall fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 행동신호를 LLM 프롬프트에 근거로 주입

**Files:**
- Modify: `src/lib/workStyleExtract.mjs`
- Modify: `src/lib/workStyleExtract.test.mjs`

**Interfaces:**
- Consumes: Task 2·3 의 `BehaviorSummary` 형태 (`{ sessionCount, avgFrustration, frustrationDensity, retryRate, efficiency, verificationRatio, topTools }`), Task 3 의 `behaviorByArea` 반환 객체.
- Produces:
  - `formatBehaviorContext(behavior): string` — 신호 없으면 `""`
  - `buildExtractPayload(area, prompts, behavior = null)`
  - `buildSynthesisPayload(items, behaviorByArea = null)`
  - `extractWorkStyleForArea(areaGroup, behavior = null, fetchImpl = fetch)` — **인자 순서 변경**
  - `synthesizeWorkStylePrinciples(areas, behaviorByArea = null, fetchImpl = fetch)` — **인자 순서 변경**

- [ ] **Step 1: 실패 테스트 작성**

먼저 기존 테스트의 호출부를 새 시그니처로 고친다 — `src/lib/workStyleExtract.test.mjs` 에서 `fetchImpl` 을 두 번째 인자로 넘기던 4곳과 synthesis 3곳:

```js
// line 9
  const r = await extractWorkStyleForArea({ area: "dt-frontend", prompts: ["a", "b"] }, null, () => { throw new Error("no fetch"); });
// line 33-36
  const r = await extractWorkStyleForArea(
    { area: "dt-frontend", prompts: ["표현이 너무 번역체야 우리나라 표현으로", "엣지케이스 e2e 맞아?"] },
    null,
    fetchImpl
  );
// line 70
  const r = await extractWorkStyleForArea({ area: "dt-backend", prompts: ["에러 나면 로그 남겨야지"] }, null, fetchImpl);
// line 84
  const r = await extractWorkStyleForArea({ area: "x", prompts: ["a"] }, null, fetchImpl);
// line 94-97
  const r = await synthesizeWorkStylePrinciples(
    [{ area: "a", judgments: [{ text: "t", evidence: "e" }] }],
    null,
    () => { throw new Error("no fetch"); }
  );
// line 105-108
  const r = await synthesizeWorkStylePrinciples(
    [{ area: "a", judgments: [] }, { area: "b", judgments: [] }],
    null,
    () => { throw new Error("no fetch"); }
  );
// line 131-134
  const r = await synthesizeWorkStylePrinciples([
    { area: "dt-frontend", judgments: [{ text: "성장팀과 합의 가능한 세그먼트 기준이 필요", evidence: "성장팀이랑 얼라인" }] },
    { area: "neo-fetch", judgments: [{ text: "상태값 먼저 명확히", evidence: "지금 꼬여있어" }] }
  ], null, fetchImpl);
// line 144-147
  const r = await synthesizeWorkStylePrinciples(
    [{ area: "a", judgments: [{ text: "t", evidence: "e" }] }],
    null,
    async () => new Response("boom", { status: 500 })
  );
```

그리고 파일 끝에 새 테스트를 추가한다. import 줄도 갱신:

```js
// 파일 상단 import 를 아래로 교체
import {
  buildExtractPayload,
  buildSynthesisPayload,
  extractWorkStyleForArea,
  formatBehaviorContext,
  synthesizeWorkStylePrinciples
} from "./workStyleExtract.mjs";
```

```js
// ─── 행동신호 주입 ────────────────────────────────────────────────────────────

const BEHAVIOR = {
  sessionCount: 12,
  avgFrustration: 0.34,
  frustrationDensity: 0.08,
  retryRate: 0.12,
  efficiency: 0.71,
  verificationRatio: 0.41,
  topTools: [
    { tool: "Read", count: 120, isVerification: true },
    { tool: "Bash", count: 88, isVerification: false }
  ]
};

test("formatBehaviorContext: 신호를 사람이 읽는 줄로 만든다", () => {
  const text = formatBehaviorContext(BEHAVIOR);
  assert.ok(text.includes("세션 12"));
  assert.ok(text.includes("0.34"));
  assert.ok(text.includes("41%"));
  assert.ok(text.includes("12%"));
  assert.ok(text.includes("Read"));
  assert.ok(text.includes("검증"));
});

test("formatBehaviorContext: 신호 없으면 빈 문자열", () => {
  assert.equal(formatBehaviorContext(null), "");
  assert.equal(formatBehaviorContext({ sessionCount: 0 }), "");
});

test("formatBehaviorContext: null 지표는 줄을 만들지 않는다", () => {
  const text = formatBehaviorContext({ ...BEHAVIOR, retryRate: null, efficiency: null });
  assert.ok(!text.includes("재시도"));
  assert.ok(!text.includes("효율"));
  assert.ok(text.includes("검증"));
});

test("buildExtractPayload: behavior 없으면 v1 페이로드와 완전히 동일", () => {
  const a = buildExtractPayload("work-log", ["p1", "p2"]);
  const b = buildExtractPayload("work-log", ["p1", "p2"], null);
  assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes("행동신호"));
});

test("buildExtractPayload: behavior 있으면 행동 근거와 사용 지침이 들어간다", () => {
  const payload = buildExtractPayload("work-log", ["p1"], BEHAVIOR);
  const serialized = JSON.stringify(payload);
  assert.ok(serialized.includes("행동신호"));
  assert.ok(serialized.includes("0.34"));
  // 수치 나열 금지 지침이 반드시 함께 가야 한다 (프로필에 지표 섹션이 생기면 안 됨)
  assert.ok(payload.input[0].content.includes("수치를 그대로 나열하지 말"));
  // 스키마·예산은 그대로
  assert.equal(payload.max_output_tokens, 3000);
  assert.equal(payload.text.format.name, "workstyle_area");
});

test("buildSynthesisPayload: behaviorByArea 없으면 v1 과 동일", () => {
  const items = [{ area: "a", text: "t" }];
  assert.deepEqual(buildSynthesisPayload(items), buildSynthesisPayload(items, null));
});

test("buildSynthesisPayload: 영역별 행동 요약이 붙는다", () => {
  const payload = buildSynthesisPayload([{ area: "work-log", text: "판단1" }], { "work-log": BEHAVIOR });
  const serialized = JSON.stringify(payload);
  assert.ok(serialized.includes("work-log"));
  assert.ok(serialized.includes("행동신호"));
  assert.equal(payload.text.format.name, "workstyle_principles");
});

test("extractWorkStyleForArea: behavior 를 페이로드까지 실어 보낸다", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  let seen = "";
  const fetchImpl = async (_url, init) => {
    seen = String(init.body);
    return new Response(JSON.stringify({
      output_text: JSON.stringify({ did: ["d"], judgments: [{ text: "t", evidence: "e" }] })
    }), { status: 200 });
  };

  const r = await extractWorkStyleForArea({ area: "work-log", prompts: ["p"] }, BEHAVIOR, fetchImpl);
  assert.equal(r.judgments.length, 1);
  assert.ok(seen.includes("행동신호"));

  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});
```

- [ ] **Step 2: 실패 확인**

```bash
node --experimental-test-module-mocks --test src/lib/workStyleExtract.test.mjs
```

기대: FAIL — `formatBehaviorContext is not a function` (그리고 행동신호 관련 assert 실패)

- [ ] **Step 3: 구현**

`src/lib/workStyleExtract.mjs` 를 아래대로 고친다.

3-a. `formatBehaviorContext` 를 `buildExtractPayload` 위에 추가:

```js
function pct(v) {
  return v == null ? null : `${Math.round(v * 100)}%`;
}

/**
 * 행동신호 요약을 LLM 이 읽을 한국어 근거 블록으로 만든다. 순수 함수.
 * 신호가 없거나 세션이 0이면 빈 문자열 — 호출자는 v1 페이로드를 그대로 쓴다.
 */
export function formatBehaviorContext(behavior) {
  if (!behavior || !behavior.sessionCount) return "";

  const lines = [`- 세션 ${behavior.sessionCount}개`];
  if (behavior.avgFrustration != null) {
    const density = behavior.frustrationDensity != null ? ` (요청당 밀도 ${behavior.frustrationDensity})` : "";
    lines.push(`- 평균 좌절 점수 ${behavior.avgFrustration}${density}`);
  }
  if (behavior.retryRate != null) lines.push(`- 재시도 비율 ${pct(behavior.retryRate)}`);
  if (behavior.efficiency != null) lines.push(`- 효율 지표 ${behavior.efficiency}`);
  if (behavior.verificationRatio != null) lines.push(`- 검증 목적 툴 사용 비중 ${pct(behavior.verificationRatio)}`);
  const tools = (behavior.topTools ?? []).filter((t) => t?.tool);
  if (tools.length) {
    lines.push(
      `- 많이 쓴 툴: ${tools.map((t) => `${t.tool} ${t.count}회${t.isVerification ? "(검증)" : ""}`).join(", ")}`
    );
  }

  return `행동신호(같은 기간 실제 관찰된 것):\n${lines.join("\n")}`;
}

const BEHAVIOR_INSTRUCTION =
  ` 함께 주는 "행동신호"는 같은 기간 실제로 관찰된 도구 사용·재시도·좌절 수치다. ` +
  `이건 판단을 뒷받침하거나 정정하는 근거로만 쓰라. 수치를 그대로 나열하지 말고 ` +
  `판단의 근거 설명 안에 자연스럽게 녹여라(예: "검증을 먼저 돌린다" — 실제로 검증 툴 비중이 높음). ` +
  `프롬프트에서 읽은 판단이 행동신호와 어긋나면 단정하지 말고 약하게 서술하라. ` +
  `행동신호만으로 새 판단을 만들어내지 말 것.`;
```

3-b. `buildExtractPayload` 시그니처와 instruction·input 을 고친다:

```js
export function buildExtractPayload(area, prompts, behavior = null) {
  const behaviorContext = formatBehaviorContext(behavior);
  const instruction =
    `아래는 사용자가 "${area}" 작업을 하며 AI에게 입력한 프롬프트들이다. ` +
    `이 프롬프트만 근거로, (1) 이 영역에서 무슨 일을 했는지(did), ` +
    `(2) 어떤 판단·기준·원칙을 가지고 일했는지(judgments)를 한국어로 추출하라. ` +
    `각 judgment는 실제 프롬프트에서 인용 가능한 근거(evidence)가 있어야 한다. ` +
    `근거 없는 일반론이나 성격 규정은 금지. 프롬프트는 주로 '묻는' 기록이므로 단정하지 말고 근거에서 드러나는 것만.` +
    (behaviorContext ? BEHAVIOR_INSTRUCTION : "");

  const userContent = prompts.map((p, i) => `${i + 1}. ${p}`).join("\n");

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    // reasoning 토큰이 이 예산에서 먼저 차감되므로 넉넉히 잡는다. 너무 낮으면
    // (예: 600) 추론이 예산을 먹고 JSON 출력이 truncate → status:incomplete →
    // output_text 빈 문자열이 되어 판단이 통째로 사라진다. (2026-07-07 프로덕션 회귀)
    max_output_tokens: 3000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "workstyle_area",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["did", "judgments"],
          properties: {
            did: { type: "array", items: { type: "string" } },
            judgments: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "evidence"],
                properties: { text: { type: "string" }, evidence: { type: "string" } }
              }
            }
          }
        }
      }
    },
    input: [
      { role: "system", content: instruction },
      { role: "user", content: behaviorContext ? `${userContent}\n\n${behaviorContext}` : userContent }
    ]
  };
}
```

3-c. `buildSynthesisPayload` 도 같은 방식으로:

```js
export function buildSynthesisPayload(items, behaviorByArea = null) {
  const behaviorBlocks = Object.entries(behaviorByArea ?? {})
    .map(([area, b]) => {
      const text = formatBehaviorContext(b);
      return text ? `[${area}] ${text}` : "";
    })
    .filter(Boolean);

  const instruction =
    `아래는 한 사람이 여러 작업 영역에서 내린 개별 판단들이다(각 줄: [영역] 판단). ` +
    `이 판단들을 가로질러 반복적으로 드러나는, 이 사람이 일할 때 가진 ` +
    `"판단 기준·사고방식·원칙"을 3~5개로 합성하라. 개별 결정을 그대로 나열하지 말고, ` +
    `여러 영역에 걸쳐 반복되는 상위 패턴으로 승격할 것. ` +
    `각 원칙은 title(한 문장 원칙 — 예: "공유·합의 가능성을 품질 기준으로 둔다")과 ` +
    `description(그 원칙이 어떻게 드러나는지 1~2문장)으로. 한국어로. ` +
    `제공된 판단에서 실제로 뒷받침되는 것만. 근거 없는 성격 규정·일반론 금지.` +
    (behaviorBlocks.length ? BEHAVIOR_INSTRUCTION : "");

  const judgmentText = items.map((j) => `[${j.area}] ${j.text}`).join("\n");
  const userContent = behaviorBlocks.length
    ? `${judgmentText}\n\n${behaviorBlocks.join("\n\n")}`
    : judgmentText;

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    max_output_tokens: 3000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "workstyle_principles",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["principles"],
          properties: {
            principles: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "description"],
                properties: { title: { type: "string" }, description: { type: "string" } }
              }
            }
          }
        }
      }
    },
    input: [
      { role: "system", content: instruction },
      { role: "user", content: userContent }
    ]
  };
}
```

3-d. 두 진입 함수의 시그니처와 페이로드 호출을 고친다:

```js
export async function extractWorkStyleForArea(areaGroup, behavior = null, fetchImpl = fetch) {
```
안의 `body: JSON.stringify(buildExtractPayload(area, prompts))` 를
```js
      body: JSON.stringify(buildExtractPayload(area, prompts, behavior))
```
로.

```js
export async function synthesizeWorkStylePrinciples(areas, behaviorByArea = null, fetchImpl = fetch) {
```
안의 `body: JSON.stringify(buildSynthesisPayload(items))` 를
```js
      body: JSON.stringify(buildSynthesisPayload(items, behaviorByArea))
```
로.

- [ ] **Step 4: 통과 확인**

```bash
node --experimental-test-module-mocks --test src/lib/workStyleExtract.test.mjs && npm run check
```

기대: PASS (기존 8개 + 신규 8개).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/workStyleExtract.mjs src/lib/workStyleExtract.test.mjs
git commit -m "$(cat <<'EOF'
feat: inject behavior signals as grounding context into workstyle prompts

Signals go in as prose evidence with an explicit "don't list the numbers"
instruction, so the profile output schema stays unchanged. Without a
behavior argument the payload is byte-identical to v1.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `runWorkStyleAnalysis` 배선

**Files:**
- Modify: `src/lib/serverCollect.mjs` (import 추가, `runWorkStyleAnalysis` 의 LLM 분기)
- Modify: `src/lib/serverCollect.workstyle.test.mjs`

**Interfaces:**
- Consumes: `collectBehaviorSignals`, `behaviorForArea`, `behaviorByArea` (Task 2·3), `extractWorkStyleForArea(areaGroup, behavior, fetchImpl)` / `synthesizeWorkStylePrinciples(areas, behaviorByArea, fetchImpl)` (Task 4)
- Produces: 없음(최종 배선). `runWorkStyleAnalysis` 반환값에 `behaviorSessions: number` 를 더한다 — 운영에서 신호가 붙었는지 로그로 보기 위한 것.

- [ ] **Step 1: 실패 테스트 작성**

`src/lib/serverCollect.workstyle.test.mjs` 를 고친다. mock 이 2번째 인자를 기록하게 만들고, 신호 모듈을 mock 한다.

파일 상단 상태 변수와 mock 을 아래로 교체한다(`mock.module("./blob.mjs", …)` 블록은 그대로 둔다):

```js
let stored = null;
let priorAnalysis = null;
let extractCalls = [];
let extractBehaviors = [];
let synthesizeCalls = [];
let synthesizeBehavior = null;

mock.module("./workStyleExtract.mjs", {
  namedExports: {
    extractWorkStyleForArea: async (g, behavior) => {
      extractCalls.push(g.area);
      extractBehaviors.push(behavior);
      return { area: g.area, did: ["did-" + g.area], judgments: [{ text: "j", evidence: "e" }] };
    },
    synthesizeWorkStylePrinciples: async (areas, behaviorByArea) => {
      synthesizeCalls.push(areas.map((a) => a.area));
      synthesizeBehavior = behaviorByArea;
      return [{ title: "원칙-A", description: "설명-A" }];
    }
  }
});
mock.module("./behaviorSignals.mjs", {
  namedExports: {
    collectBehaviorSignals: async () => ({
      byArea: new Map([["work-log", { sessionCount: 4, avgFrustration: 0.2, topTools: [] }]]),
      overall: { sessionCount: 6, avgFrustration: 0.3, topTools: [] },
      meta: { fallback: false, sessions: 6 }
    }),
    behaviorForArea: (signals, area) => signals?.byArea?.get(area) ?? null,
    behaviorByArea: (signals, names) => {
      const out = {};
      for (const n of names ?? []) {
        const b = signals?.byArea?.get(n);
        if (b) out[n] = b;
      }
      return out;
    }
  }
});
```

기존 STALE 테스트의 `finally` 직전에 아래 assert 를 추가한다:

```js
    // 행동신호가 영역별로 추출기에 전달돼야 한다
    const wlIndex = extractCalls.indexOf("work-log");
    assert.ok(wlIndex >= 0, "work-log area should have been extracted");
    assert.equal(extractBehaviors[wlIndex]?.sessionCount, 4);
    // 신호 없는 영역은 null 로 넘어간다 (v1 동작)
    const kbIndex = extractCalls.indexOf("knowledge-base");
    assert.equal(extractBehaviors[kbIndex], null);
    // 합성에도 영역별 신호가 전달된다
    assert.equal(synthesizeBehavior?.["work-log"]?.sessionCount, 4);
    // 운영 관측용 카운트
    assert.equal(r.behaviorSessions, 6);
```

기존 STALE 테스트의 상태 초기화 줄(`extractCalls = [];` 뒤)에 추가:

```js
  extractBehaviors = [];
  synthesizeBehavior = null;
```

FRESH 테스트에도 같은 초기화 두 줄을 추가하고, `finally` 직전에 아래를 추가한다:

```js
    // FRESH 경로는 신호를 아예 수집하지 않는다 (불필요한 ClickHouse 조회 금지)
    assert.equal(r.behaviorSessions, null);
```

- [ ] **Step 2: 실패 확인**

```bash
node --experimental-test-module-mocks --test src/lib/serverCollect.workstyle.test.mjs
```

기대: FAIL — `extractBehaviors[wlIndex]` 가 `undefined` (아직 신호를 넘기지 않음), `r.behaviorSessions` 가 `undefined`.

- [ ] **Step 3: 구현**

`src/lib/serverCollect.mjs` 의 import 블록(line 31 아래)에 추가:

```js
import { behaviorByArea, behaviorForArea, collectBehaviorSignals } from "./behaviorSignals.mjs";
```

`runWorkStyleAnalysis` 의 LLM 분기를 아래로 교체한다(line 331-339 의 `if (llmStale) { … }` 블록):

```js
  let behaviorSessions = null;

  if (llmStale) {
    // 행동신호는 LLM 재생성 때만 필요하다 — FRESH 경로에서 ClickHouse 를 두드리지 않는다.
    const signals = await collectBehaviorSignals({ userId, days: windowDays }).catch(() => null);
    behaviorSessions = signals?.meta?.sessions ?? null;

    enriched = [];
    for (const area of areas) {
      const behavior = behaviorForArea(signals, area.area);
      const r = await extractWorkStyleForArea(area, behavior).catch(() => ({ did: [], judgments: [] }));
      enriched.push({ area: area.area, promptCount: area.promptCount, firstDate: area.firstDate, lastDate: area.lastDate, did: r.did ?? [], judgments: r.judgments ?? [] });
    }
    // 영역별 개별 판단을 가로질러 관통 원칙으로 승격 (이게 화면의 주인공)
    principles = await synthesizeWorkStylePrinciples(
      enriched,
      behaviorByArea(signals, enriched.map((a) => a.area))
    ).catch(() => []);
    llmGeneratedAt = new Date().toISOString();
  } else {
```

그리고 반환값에 카운트를 더한다:

```js
  return { skipped: false, areaCount: enriched.length, principleCount: principles.length, llmRefreshed: llmStale, behaviorSessions };
```

- [ ] **Step 4: 통과 확인**

```bash
node --experimental-test-module-mocks --test src/lib/serverCollect.workstyle.test.mjs
```

기대: PASS (3개 테스트).

- [ ] **Step 5: 전체 스위트 확인**

```bash
npm run check && npm test
```

기대: 둘 다 PASS. 실패하면 회귀 — 다음 단계로 넘어가지 말 것.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/serverCollect.mjs src/lib/serverCollect.workstyle.test.mjs
git commit -m "$(cat <<'EOF'
feat: wire behavior signals into runWorkStyleAnalysis LLM path

Signals are collected once per stale run and passed per area; the fresh
path never touches ClickHouse.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `retry_analysis` + `efficiency_metrics_daily` 추가

Task 1 Step 4 가 스펙에 기록한 컬럼명을 그대로 쓴다. **Task 1 기록이 "없음 — 이 테이블 제외"라면 이 태스크는 그 판단을 스펙에 확인만 하고 건너뛴다** (`retryRate`/`efficiency` 는 영구히 `null`, `formatBehaviorContext` 가 이미 null 을 걸러내므로 코드 변경 불필요).

**Files:**
- Modify: `src/lib/behaviorSignals.mjs`
- Modify: `src/lib/behaviorSignals.test.mjs`

**Interfaces:**
- Consumes: 스펙 `## 스키마 실측 결과` 의 컬럼명, Task 2 의 `aggregateSignals` / `queryClickHouse`
- Produces: `aggregateSignals({ sessionArea, frustrationRows, toolRows, retryRows, efficiencyRows })` — 인자 두 개 추가(둘 다 기본 `[]`), 결과 요약의 `retryRate` / `efficiency` 가 채워진다.

- [ ] **Step 1: 실패 테스트 추가**

`src/lib/behaviorSignals.test.mjs` 끝에 추가한다. `<RETRY_RATE_COL>` / `<EFFICIENCY_COL>` 는 Task 1 기록의 실제 컬럼명으로 치환하고, 쿼리에서 이미 `rate` / `efficiency` 별칭을 붙이므로 아래 테스트의 행 키는 별칭 그대로 쓴다:

```js
// ─── retry / efficiency ──────────────────────────────────────────────────────

test("aggregateSignals: 재시도율·효율을 영역별로 평균한다", () => {
  const sessionArea = new Map([["s1", "work-log"], ["s2", "work-log"]]);
  const r = aggregateSignals({
    sessionArea,
    frustrationRows: [{ session_id: "s1", requests: "5", score: "0.1", density: "0.01" }],
    toolRows: [],
    retryRows: [
      { session_id: "s1", rate: "0.1" },
      { session_id: "s2", rate: "0.3" }
    ],
    efficiencyRows: [
      { session_id: "s1", efficiency: "0.8" },
      { session_id: "s2", efficiency: "0.6" }
    ]
  });

  const wl = r.byArea.get("work-log");
  assert.equal(wl.retryRate, 0.2);
  assert.equal(wl.efficiency, 0.7);
  assert.equal(r.overall.retryRate, 0.2);
});

test("aggregateSignals: 재시도·효율 행이 없으면 두 지표는 null", () => {
  const r = aggregateSignals({
    sessionArea: new Map([["s1", "work-log"]]),
    frustrationRows: [{ session_id: "s1", requests: "5", score: "0.1", density: "0.01" }],
    toolRows: []
  });
  assert.equal(r.byArea.get("work-log").retryRate, null);
  assert.equal(r.byArea.get("work-log").efficiency, null);
});
```

그리고 `collectBehaviorSignals` 통합 테스트의 `fetchImpl` 에 두 분기를 추가한다(“브리지 → 신호 조회” 테스트):

```js
    if (q.includes("FROM retry_analysis")) {
      return new Response(JSON.stringify({ data: [{ session_id: "s1", rate: "0.2" }] }), { status: 200 });
    }
    if (q.includes("FROM efficiency_metrics_daily")) {
      return new Response(JSON.stringify({ data: [{ session_id: "s1", efficiency: "0.9" }] }), { status: 200 });
    }
```

같은 테스트의 assert 에 추가:

```js
    assert.equal(wl.retryRate, 0.2);
    assert.equal(wl.efficiency, 0.9);
```

- [ ] **Step 2: 실패 확인**

```bash
node --experimental-test-module-mocks --test src/lib/behaviorSignals.test.mjs
```

기대: FAIL — `retryRate` 가 `null` (기대 `0.2`), 그리고 통합 테스트에서 `unexpected query: … retry_analysis`.

- [ ] **Step 3: 구현**

3-a. `aggregateSignals` 의 누산기에 두 배열을 더한다. 시그니처를 고치고:

```js
export function aggregateSignals({ sessionArea, frustrationRows = [], toolRows = [], retryRows = [], efficiencyRows = [] }) {
```

`bucket()` 초기값에 두 배열을 추가:

```js
      buckets.set(key, { sessions: new Set(), scores: [], densities: [], tools: new Map(), retries: [], efficiencies: [] });
```

`toolRows` 루프 뒤에 공통 수치 루프를 추가:

```js
  // 세션 단위 단일 수치 신호(재시도율·효율)는 같은 방식으로 누산한다.
  const addNumeric = (rows, valueKey, field) => {
    for (const row of rows) {
      const session = String(row?.session_id ?? "");
      const area = areaOf.get(session);
      totalRows += 1;
      if (area) matchedRows += 1;

      const value = num(row?.[valueKey]);
      if (value == null) continue;
      for (const key of [null, ...(area ? [area] : [])]) {
        addTo(key, (b) => {
          if (session) b.sessions.add(session);
          b[field].push(value);
        });
      }
    }
  };
  addNumeric(retryRows, "rate", "retries");
  addNumeric(efficiencyRows, "efficiency", "efficiencies");
```

`summarize` 의 `retryRate` / `efficiency` 를 실제 평균으로:

```js
    const mean = (list) => (list.length ? round(list.reduce((a, c) => a + c, 0) / list.length) : null);
```
를 `summarize` 안 맨 위에 넣고,
```js
      retryRate: mean(b.retries),
      efficiency: mean(b.efficiencies),
```
로 교체한다. (기존 `avgFrustration` / `frustrationDensity` 도 `mean(b.scores)` / `mean(b.densities)` 로 정리한다.)

3-b. `collectBehaviorSignals` 의 `Promise.all` 에 두 조회를 추가한다. **`<RETRY_RATE_COL>` 과 `<EFFICIENCY_COL>` 은 Task 1 기록의 실제 컬럼명으로 치환**하고, 별칭은 `rate` / `efficiency` 로 고정한다(집계가 그 키를 읽는다):

```js
    const [frustrationRows, toolRows, retryRows, efficiencyRows] = await Promise.all([
      // … 기존 두 조회 그대로 …
      queryClickHouse(
        `
        SELECT session_id, avg(<RETRY_RATE_COL>) AS rate
        FROM retry_analysis
        WHERE user_id IN splitByChar(',', {ids:String})
          AND date >= today() - ${windowDays}
        GROUP BY session_id
        FORMAT JSON`,
        { ids },
        fetchImpl
      ).catch(() => []),
      queryClickHouse(
        `
        SELECT session_id, avg(<EFFICIENCY_COL>) AS efficiency
        FROM efficiency_metrics_daily
        WHERE user_id IN splitByChar(',', {ids:String})
          AND date >= today() - ${windowDays}
        GROUP BY session_id
        FORMAT JSON`,
        { ids },
        fetchImpl
      ).catch(() => [])
    ]);

    return aggregateSignals({ sessionArea, frustrationRows, toolRows, retryRows, efficiencyRows });
```

두 조회에만 `.catch(() => [])` 를 붙인 이유: 이 두 테이블은 스키마 확신도가 낮아, 쿼리가 깨져도 좌절·툴 신호는 살려야 한다.

**주의:** `efficiency_metrics_daily` 에 `session_id` 가 없다면(Task 1 확인) 이 조회는 `SELECT avg(<EFFICIENCY_COL>) AS efficiency` 로 세션 없이 하고, 결과 행에 `session_id: ""` 를 채워 overall 에만 반영시킨다:

```js
      ).then((rows) => rows.map((row) => ({ ...row, session_id: "" })))
```

- [ ] **Step 4: 통과 확인**

```bash
node --experimental-test-module-mocks --test src/lib/behaviorSignals.test.mjs && npm run check && npm test
```

기대: 모두 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/behaviorSignals.mjs src/lib/behaviorSignals.test.mjs
git commit -m "$(cat <<'EOF'
feat: add retry and efficiency signals to behavior summaries

Both queries are individually non-fatal — a broken schema guess must not
cost us the frustration and tool signals.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 프로덕션 검증

로컬 `.env.local` 엔 ClickHouse 크리덴셜이 없다. 실제 신호가 붙는지는 프로덕션에서 확인한다.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-31-workstyle-behavior-signals-design.md` (검증 결과 한 줄 추가)

**Interfaces:**
- Consumes: Task 5 가 반환에 추가한 `behaviorSessions`
- Produces: 스펙 문서의 검증 기록

- [ ] **Step 1: 배포**

프로덕션은 CLI 수동 배포이고 `NODEJS_HELPERS=0` 가 필요하다(기존 운영 방식):

```bash
git push origin main
npx vercel --prod
```

- [ ] **Step 2: 강제 재생성 실행**

7일 staleness 게이트를 우회해 LLM 경로를 강제로 태운다:

```bash
curl -sS "https://work-log-nu-beige.vercel.app/api/collect?forceLlm=1" | head -c 2000
```

기대: 응답 JSON 안 workstyle 결과에 `"behaviorSessions"` 가 **0보다 큰 수**. `null` 이나 `0` 이면 신호가 안 붙은 것 — Task 1 의 조인율 기록과 대조해 원인을 좁힌다(브리지 0건 / user_id 0건 / 조인율 미달 중 하나).

`forceLlm` 파라미터가 라우트에 없으면 먼저 확인한다:

```bash
grep -n "forceLlm\|runWorkStyleAnalysis" src/routes/*.mjs src/server.mjs
```

- [ ] **Step 3: 프로필에 근거가 스며들었는지 확인**

```bash
curl -sS "https://work-log-nu-beige.vercel.app/api/profile" | python3 -m json.tool | head -60
```

확인할 것:
- 원칙의 `description` 에 행동 근거가 **문장으로** 녹아 있는지 (예: "검증을 먼저 돌리는 편 — 실제로 읽기·확인 툴 사용이 많다")
- **수치 나열이나 별도 지표 섹션이 생기지 않았는지** (생겼으면 `BEHAVIOR_INSTRUCTION` 의 금지 문구를 강화해야 한다)
- 기존 필드 집합이 그대로인지 (`principles`, `areas`, `droppedAreas`)

- [ ] **Step 4: 결과 기록 + 커밋**

스펙의 `## 스키마 실측 결과` 섹션 끝에 한 줄 추가:

```markdown
- 프로덕션 검증 (<날짜>): behaviorSessions=<n>, 원칙 description 에 행동 근거 <스며듦 / 안 스며듦>, 지표 섹션 생성 <없음 / 있음(조치: …)>
```

```bash
git add docs/superpowers/specs/2026-07-31-workstyle-behavior-signals-design.md
git commit -m "$(cat <<'EOF'
docs: record v2 behavior-signal production verification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Self-Review

**스펙 커버리지:**
- 목표(행동신호를 근거 컨텍스트로 주입) → Task 4 (`BEHAVIOR_INSTRUCTION` + `formatBehaviorContext`)
- 유저 식별 브리지(`ai_prompts`) → Task 2 Step 3 의 브리지 쿼리
- 세션→영역 매핑(`areaKey`) → Task 2
- 영역별 집계(avgFrustration/retryRate/topTools/verificationRatio/efficiency/sessionCount) → Task 2(좌절·툴) + Task 6(재시도·효율)
- 조인 빈약 시 유저 전체 폴백 → Task 2 `MIN_JOIN_RATIO` + Task 3 `behaviorForArea`
- `extractWorkStyleForArea` / `synthesizeWorkStylePrinciples` 확장 → Task 4
- `runWorkStyleAnalysis` 배선, 7일 게이트 유지 → Task 5
- 미확인 컬럼 DESCRIBE, 조인율 실측 → Task 1
- 렌더러(`memberProfile.mjs`) 불변 → Global Constraints + Task 7 Step 3 확인
- 테스트 항목 4개(집계·폴백·하위호환·회귀) → Task 2·3·4·5 의 테스트
- 신규 env 없음, 기존 CLICKHOUSE_* 재사용 → Task 2 구현
- 배포·검증 경로 → Task 7

**스펙과 의도적으로 다르게 간 곳(1건):** 스펙은 신호 조회를 `WHERE session_id IN (...)` 로 적었지만, 플랜은 `WHERE user_id IN (...)` 로 좁히고 세션 귀속은 메모리에서 한다. 이유는 스펙이 최우선 리스크로 지목한 바로 그 지점 — 세션 id 형식이 다르면 `session_id IN` 은 **결과가 0행**이 되어 폴백할 재료조차 없어진다. `user_id` 로 좁히면 조인이 실패해도 유저 전체 집계는 살아남는다. 쿼리 비용도 큰 IN 목록을 안 만들어 더 낫다.

**플레이스홀더 점검:** Task 6 의 `<RETRY_RATE_COL>` / `<EFFICIENCY_COL>` 은 남겨둔 미지수다 — Task 1 이 DESCRIBE 로 확정해 스펙에 적고 Task 6 이 그걸 읽는 구조라, 지금 임의로 채우면 오히려 틀린 컬럼명을 박게 된다. 나머지 태스크에는 실행 가능한 코드·명령·기대값이 모두 들어 있다.

**타입 일관성:** `BehaviorSummary` 필드명이 Task 2(생성) → Task 3(선택) → Task 4(포맷) → Task 5(전달)에서 동일(`sessionCount`, `avgFrustration`, `frustrationDensity`, `retryRate`, `efficiency`, `verificationRatio`, `topTools[{tool,count,isVerification}]`). ClickHouse 행 별칭도 집계가 읽는 키와 일치(`score`/`density`/`requests`, `tool_name`/`is_verification`/`use_count`, `rate`, `efficiency`). `aggregateSignals` 는 Task 6 에서 인자가 늘지만 기본값이 `[]` 라 Task 2 의 테스트가 그대로 통과한다.
