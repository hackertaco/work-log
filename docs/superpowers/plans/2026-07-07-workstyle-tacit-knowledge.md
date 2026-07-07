# 워크스타일 암묵지 추출 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** work-log 홈에 "많이 한 일 + 그 안의 판단(암묵지)"을 사용자 프롬프트 근거와 함께 보여주는 섹션을 추가한다.

**Architecture:** Zeude ClickHouse의 사용자 프롬프트를 30일 윈도우로 가져와, 순수 함수로 영역별 그룹핑(매일, 무료)하고 LLM으로 판단을 추출(주 1회)한다. 결과는 유저 스코프 Blob에 저장되고 `/api/profile`을 통해 홈 UI가 읽는다.

**Tech Stack:** Node.js ESM, Hono, Vercel Blob, OpenAI Responses API, Preact, `node --test`.

## Global Constraints

- 모든 원격 소스 실패는 비치명적 — 빈 배열/이전 값으로 degrade, throw로 cron 500 금지 (spec 에러 처리)
- Blob/ClickHouse/OpenAI 미설정 시 조용히 스킵하고 기존 동작 유지
- Blob 경로는 유저 스코프 — 반드시 `pathForUser` 경유
- ClickHouse 조회 관례 유지: `prompt_type='natural'`, 길이 ≥ 12, `<` 시작 XML 제외, `prompt_id` dedupe
- 성격 지표(질문비율·집중시간대 등) 생성 금지 — 산출물은 영역별 "한 일 + 판단"만
- 테스트는 `node --experimental-test-module-mocks --test <file>` 로 실행
- 커밋 메시지 말미: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: 영역 그룹핑 순수 함수 (`workAreaGrouping.mjs`)

**Files:**
- Create: `src/lib/workAreaGrouping.mjs`
- Test: `src/lib/workAreaGrouping.test.mjs`

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces: `groupWorkAreas(prompts, { topN = 5 } = {}) => { areas: Array<{ area, promptCount, firstDate, lastDate, prompts: string[] }>, droppedAreas: number }`
  - 입력 prompt shape: `{ text: string, projectPath: string, source: string, date: string }`
  - `area` = `projectPath`의 마지막 비어있지 않은 경로 세그먼트 (없으면 `"unknown"`)
  - `areas`는 `promptCount` 내림차순, 상위 `topN`만; `droppedAreas` = 잘려나간 영역 수

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// src/lib/workAreaGrouping.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { groupWorkAreas } from "./workAreaGrouping.mjs";

const P = (projectPath, text, date) => ({ projectPath, text, date, source: "claude" });

test("groups by last path segment, sorted by volume, keeps prompts", () => {
  const { areas, droppedAreas } = groupWorkAreas([
    P("/Users/x/Documents/company-code/dt-frontend", "카피 번역체 고쳐", "2026-06-26"),
    P("/Users/x/Documents/company-code/dt-frontend", "엣지케이스 e2e 맞아?", "2026-06-27"),
    P("/Users/x/Documents/company-code/neo-fetch", "검정 데이터 저장 확인", "2026-06-26"),
  ]);

  assert.equal(droppedAreas, 0);
  assert.equal(areas.length, 2);
  assert.equal(areas[0].area, "dt-frontend");
  assert.equal(areas[0].promptCount, 2);
  assert.equal(areas[0].firstDate, "2026-06-26");
  assert.equal(areas[0].lastDate, "2026-06-27");
  assert.deepEqual(areas[0].prompts, ["카피 번역체 고쳐", "엣지케이스 e2e 맞아?"]);
  assert.equal(areas[1].area, "neo-fetch");
});

test("caps at topN and reports dropped count", () => {
  const prompts = [];
  for (let i = 0; i < 8; i++) {
    // i가 클수록 프롬프트가 많아 앞쪽으로 정렬됨
    for (let j = 0; j <= i; j++) prompts.push(P(`/repo-${i}`, `p${i}-${j}`, "2026-07-01"));
  }
  const { areas, droppedAreas } = groupWorkAreas(prompts, { topN: 5 });
  assert.equal(areas.length, 5);
  assert.equal(droppedAreas, 3);
  assert.equal(areas[0].area, "repo-7");
});

test("missing projectPath falls back to 'unknown'", () => {
  const { areas } = groupWorkAreas([P("", "뭔가", "2026-07-01"), P(null, "또", "2026-07-01")]);
  assert.equal(areas[0].area, "unknown");
  assert.equal(areas[0].promptCount, 2);
});

test("empty input returns empty areas", () => {
  assert.deepEqual(groupWorkAreas([]), { areas: [], droppedAreas: 0 });
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test src/lib/workAreaGrouping.test.mjs`
Expected: FAIL — `Cannot find module './workAreaGrouping.mjs'`

- [ ] **Step 3: 최소 구현**

```javascript
// src/lib/workAreaGrouping.mjs
/**
 * 프롬프트를 작업 영역(레포/프로젝트)별로 묶는다. 순수 함수 — LLM·I/O 없음.
 *
 * @param {Array<{text:string, projectPath:string, source:string, date:string}>} prompts
 * @param {{ topN?: number }} [opts]
 * @returns {{ areas: Array<{area:string, promptCount:number, firstDate:string, lastDate:string, prompts:string[]}>, droppedAreas:number }}
 */
export function groupWorkAreas(prompts, { topN = 5 } = {}) {
  const map = new Map();

  for (const p of Array.isArray(prompts) ? prompts : []) {
    const area = areaKey(p.projectPath);
    const entry = map.get(area) || { area, promptCount: 0, firstDate: null, lastDate: null, prompts: [] };
    entry.promptCount += 1;
    entry.prompts.push(String(p.text ?? ""));
    const date = String(p.date ?? "");
    if (date) {
      if (!entry.firstDate || date < entry.firstDate) entry.firstDate = date;
      if (!entry.lastDate || date > entry.lastDate) entry.lastDate = date;
    }
    map.set(area, entry);
  }

  const sorted = [...map.values()].sort((a, b) => b.promptCount - a.promptCount);
  return {
    areas: sorted.slice(0, topN),
    droppedAreas: Math.max(0, sorted.length - topN)
  };
}

function areaKey(projectPath) {
  const segments = String(projectPath ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "unknown";
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --experimental-test-module-mocks --test src/lib/workAreaGrouping.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/workAreaGrouping.mjs src/lib/workAreaGrouping.test.mjs
git commit -m "$(printf 'Add work-area grouping for prompt-based workstyle\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: 30일 프롬프트 윈도우 수집 (`collectZeudePromptWindow`)

**Files:**
- Modify: `src/lib/serverCollect.mjs` (기존 `collectZeudePrompts` 아래에 함수 추가)
- Test: `src/lib/serverCollect.window.test.mjs`

**Interfaces:**
- Consumes: 없음 (ClickHouse fetch)
- Produces: `collectZeudePromptWindow(userId = "default", days = 30, fetchImpl = fetch) => Promise<Array<{ text, projectPath, source, date }>>`
  - `date`는 KST 기준 `YYYY-MM-DD`
  - ClickHouse 미설정(`CLICKHOUSE_URL`/`USER`/`WORK_LOG_ZEUDE_EMAIL` 없음)이면 `[]`
  - 반환 shape는 Task 1 `groupWorkAreas` 입력과 일치

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// src/lib/serverCollect.window.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { collectZeudePromptWindow } from "./serverCollect.mjs";

test("maps window rows and passes days param; returns local commit-window shape", async () => {
  const saved = {
    url: process.env.CLICKHOUSE_URL, user: process.env.CLICKHOUSE_USER,
    pw: process.env.CLICKHOUSE_PASSWORD, email: process.env.WORK_LOG_ZEUDE_EMAIL
  };
  process.env.CLICKHOUSE_URL = "http://ch.example:8123";
  process.env.CLICKHOUSE_USER = "default";
  process.env.CLICKHOUSE_PASSWORD = "pw";
  process.env.WORK_LOG_ZEUDE_EMAIL = "seungah.jung@tgsociety.co.kr";

  let capturedBody = "";
  let capturedUrl = "";
  const fetchImpl = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = init.body;
    return new Response(JSON.stringify({
      data: [
        { text: "카피 번역체 고쳐", project_path: "/x/dt-frontend", source: "claude", kst_date: "2026-06-26" },
        { text: "검정 데이터 저장", project_path: "/x/neo-fetch", source: "codex", kst_date: "2026-06-27" }
      ]
    }), { status: 200 });
  };

  const rows = await collectZeudePromptWindow("default", 30, fetchImpl);

  assert.deepEqual(rows, [
    { text: "카피 번역체 고쳐", projectPath: "/x/dt-frontend", source: "claude", date: "2026-06-26" },
    { text: "검정 데이터 저장", projectPath: "/x/neo-fetch", source: "codex", date: "2026-06-27" }
  ]);
  assert.ok(capturedBody.includes("INTERVAL 30 DAY"));
  assert.ok(capturedUrl.includes("param_email=seungah.jung%40tgsociety.co.kr"));

  for (const [k, v] of [["CLICKHOUSE_URL", saved.url], ["CLICKHOUSE_USER", saved.user], ["CLICKHOUSE_PASSWORD", saved.pw], ["WORK_LOG_ZEUDE_EMAIL", saved.email]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("no-op without ClickHouse config", async () => {
  const saved = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  assert.deepEqual(await collectZeudePromptWindow("default", 30, () => { throw new Error("must not fetch"); }), []);
  if (saved !== undefined) process.env.CLICKHOUSE_URL = saved;
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test src/lib/serverCollect.window.test.mjs`
Expected: FAIL — `collectZeudePromptWindow is not a function`

- [ ] **Step 3: 최소 구현** — `src/lib/serverCollect.mjs`의 `collectZeudePrompts` 함수 정의가 끝나는 `}` 바로 다음에 아래를 추가:

```javascript
/**
 * 롤링 윈도우(기본 30일)의 사용자 프롬프트를 project_path 포함해 가져온다.
 * groupWorkAreas 입력 shape로 반환한다. 미설정이면 [].
 *
 * @param {string} userId
 * @param {number} days
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Array<{text:string, projectPath:string, source:string, date:string}>>}
 */
export async function collectZeudePromptWindow(userId = "default", days = 30, fetchImpl = fetch) {
  const url = process.env.CLICKHOUSE_URL;
  const user = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;
  const email = process.env.WORK_LOG_ZEUDE_EMAIL || "";
  if (!url || !user || !email) return [];

  const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  const query = `
    SELECT
      argMax(prompt_text, timestamp) AS text,
      argMax(project_path, timestamp) AS project_path,
      argMax(source, timestamp) AS source,
      toString(toDate(max(timestamp) + INTERVAL 9 HOUR)) AS kst_date
    FROM ai_prompts
    WHERE user_email = {email:String}
      AND timestamp >= now() - INTERVAL ${windowDays} DAY
      AND prompt_type = 'natural'
      AND length(prompt_text) >= 12
      AND NOT startsWith(prompt_text, '<')
    GROUP BY prompt_id
    ORDER BY max(timestamp)
    LIMIT 2000
    FORMAT JSON`;

  const endpoint = `${url.replace(/\/$/, "")}/?param_email=${encodeURIComponent(email)}`;
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${password ?? ""}`).toString("base64")}`
    },
    body: query
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 120)}`);

  const body = await res.json();
  return (body.data ?? []).map((row) => ({
    text: String(row.text ?? "").slice(0, 300),
    projectPath: String(row.project_path ?? ""),
    source: row.source === "codex" ? "codex" : "claude",
    date: String(row.kst_date ?? "")
  }));
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --experimental-test-module-mocks --test src/lib/serverCollect.window.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/serverCollect.mjs src/lib/serverCollect.window.test.mjs
git commit -m "$(printf 'Add 30-day Zeude prompt window collector\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: LLM 판단 추출 (`workStyleExtract.mjs`)

**Files:**
- Create: `src/lib/workStyleExtract.mjs`
- Test: `src/lib/workStyleExtract.test.mjs`

**Interfaces:**
- Consumes: 영역 그룹 하나 `{ area, prompts: string[] }` (Task 1 `areas[i]`)
- Produces: `extractWorkStyleForArea(areaGroup, fetchImpl = fetch) => Promise<{ area, did: string[], judgments: Array<{text:string, evidence:string}> }>`
  - OpenAI 미설정(`OPENAI_API_KEY` 없거나 `WORK_LOG_DISABLE_OPENAI==="1"`) → `{ area, did: [], judgments: [] }`
  - LLM은 Responses API + json_schema 강제

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// src/lib/workStyleExtract.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { extractWorkStyleForArea } from "./workStyleExtract.mjs";

test("no-op without OpenAI key", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await extractWorkStyleForArea({ area: "dt-frontend", prompts: ["a", "b"] }, () => { throw new Error("no fetch"); });
  assert.deepEqual(r, { area: "dt-frontend", did: [], judgments: [] });
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});

test("parses did + judgments from OpenAI json output", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  const fetchImpl = async (url, init) => {
    assert.ok(String(url).includes("/responses") || String(url).length > 0);
    const payload = JSON.parse(init.body);
    // 프롬프트 근거가 실제로 모델에 전달되는지 확인
    assert.ok(JSON.stringify(payload).includes("번역체"));
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        did: ["예약 변경 플로우", "UI 다듬기"],
        judgments: [
          { text: "번역체 카피를 실제 표현으로 바꾸는 걸 품질 기준으로 삼음", evidence: "표현이 너무 번역체야" }
        ]
      })
    }), { status: 200 });
  };

  const r = await extractWorkStyleForArea(
    { area: "dt-frontend", prompts: ["표현이 너무 번역체야 우리나라 표현으로", "엣지케이스 e2e 맞아?"] },
    fetchImpl
  );

  assert.equal(r.area, "dt-frontend");
  assert.deepEqual(r.did, ["예약 변경 플로우", "UI 다듬기"]);
  assert.equal(r.judgments.length, 1);
  assert.equal(r.judgments[0].evidence, "표현이 너무 번역체야");

  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

test("returns empty on OpenAI error (non-fatal)", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const fetchImpl = async () => new Response("boom", { status: 500 });
  const r = await extractWorkStyleForArea({ area: "x", prompts: ["a"] }, fetchImpl);
  assert.deepEqual(r, { area: "x", did: [], judgments: [] });
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test src/lib/workStyleExtract.test.mjs`
Expected: FAIL — `Cannot find module './workStyleExtract.mjs'`

- [ ] **Step 3: 최소 구현**

```javascript
// src/lib/workStyleExtract.mjs
/**
 * 한 작업 영역의 프롬프트에서 "한 일 + 꺼낸 판단(암묵지)"을 LLM으로 추출한다.
 * 프롬프트는 주로 "묻는" 기록이라 확정적 성격 규정 대신 근거에서 드러나는 판단만 뽑는다.
 * 실패·미설정은 비치명적 — 빈 결과를 반환한다.
 */
const OPENAI_URL = process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";
const MAX_PROMPTS = 60;

export async function extractWorkStyleForArea(areaGroup, fetchImpl = fetch) {
  const area = areaGroup?.area ?? "unknown";
  const empty = { area, did: [], judgments: [] };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") return empty;

  const prompts = (areaGroup?.prompts ?? []).slice(0, MAX_PROMPTS).map((p) => String(p).slice(0, 300));
  if (!prompts.length) return empty;

  try {
    const response = await fetchImpl(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildExtractPayload(area, prompts))
    });
    if (!response.ok) return empty;

    const data = await response.json();
    const text = data.output_text || "";
    if (!text) return empty;

    const parsed = JSON.parse(text);
    return {
      area,
      did: sanitizeList(parsed.did),
      judgments: (Array.isArray(parsed.judgments) ? parsed.judgments : [])
        .map((j) => ({ text: String(j?.text ?? "").trim(), evidence: String(j?.evidence ?? "").trim() }))
        .filter((j) => j.text)
        .slice(0, 5)
    };
  } catch {
    return empty;
  }
}

function sanitizeList(v) {
  return (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
}

export function buildExtractPayload(area, prompts) {
  const instruction =
    `아래는 사용자가 "${area}" 작업을 하며 AI에게 입력한 프롬프트들이다. ` +
    `이 프롬프트만 근거로, (1) 이 영역에서 무슨 일을 했는지(did), ` +
    `(2) 어떤 판단·기준·원칙을 가지고 일했는지(judgments)를 한국어로 추출하라. ` +
    `각 judgment는 실제 프롬프트에서 인용 가능한 근거(evidence)가 있어야 한다. ` +
    `근거 없는 일반론이나 성격 규정은 금지. 프롬프트는 주로 '묻는' 기록이므로 단정하지 말고 근거에서 드러나는 것만.`;

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
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
      { role: "user", content: prompts.map((p, i) => `${i + 1}. ${p}`).join("\n") }
    ]
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --experimental-test-module-mocks --test src/lib/workStyleExtract.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/workStyleExtract.mjs src/lib/workStyleExtract.test.mjs
git commit -m "$(printf 'Add LLM judgment extraction per work area\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Blob 저장/읽기 헬퍼

**Files:**
- Modify: `src/lib/blob.mjs` (WORKLOG_PROFILE_PATHNAME 정의 근처에 상수 추가, worklog 헬퍼 근처에 함수 추가)
- Test: `src/lib/blob.user-scope.test.mjs` (기존 파일에 케이스 추가)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `WORKSTYLE_ANALYSIS_PATHNAME = "worklog/workstyle/analysis.json"`
  - `saveWorkStyleAnalysis(data, userId = DEFAULT_USER_ID) => Promise<{url}>`
  - `readWorkStyleAnalysis(userId = DEFAULT_USER_ID) => Promise<object|null>`

- [ ] **Step 1: 실패 테스트 작성** — `src/lib/blob.user-scope.test.mjs` import 블록에 `WORKSTYLE_ANALYSIS_PATHNAME` 추가하고 파일 끝에 케이스 추가:

```javascript
test("workstyle analysis pathname scopes per user", () => {
  assert.equal(pathForUser(WORKSTYLE_ANALYSIS_PATHNAME), "worklog/workstyle/analysis.json");
  assert.equal(pathForUser(WORKSTYLE_ANALYSIS_PATHNAME, "alice"), "users/alice/worklog/workstyle/analysis.json");
});
```

import 라인 수정 (기존 import에 추가):
```javascript
import {
  RESUME_DATA_PATHNAME,
  CHAT_DRAFT_CONTEXT_PATHNAME,
  WORKLOG_PROFILE_PATHNAME,
  WORKSTYLE_ANALYSIS_PATHNAME,
  bulletsPathnameForDate,
  pathForUser,
  snapshotPathnameFor,
  worklogDailyPathnameForDate,
} from './blob.mjs';
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test src/lib/blob.user-scope.test.mjs`
Expected: FAIL — `WORKSTYLE_ANALYSIS_PATHNAME` is undefined

- [ ] **Step 3: 최소 구현** — `src/lib/blob.mjs`에서 `WORKLOG_PROFILE_PATHNAME` 정의 다음 줄에 상수 추가:

```javascript
/**
 * Blob pathname for the prompt-based workstyle analysis (per-user).
 * Written by the server collector; read by /api/profile.
 */
export const WORKSTYLE_ANALYSIS_PATHNAME = "worklog/workstyle/analysis.json";
```

그리고 `readWorklogProfile` 함수 정의 다음에 헬퍼 추가:

```javascript
export async function saveWorkStyleAnalysis(data, userId = DEFAULT_USER_ID) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const pathname = pathForUser(WORKSTYLE_ANALYSIS_PATHNAME, userId);
  const json = JSON.stringify(data, null, 2);
  const result = await put(pathname, json, {
    access: "private",
    contentType: "application/json; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: true,
    ...(token ? { token } : {})
  });
  return { url: result.url };
}

export async function readWorkStyleAnalysis(userId = DEFAULT_USER_ID) {
  return readPrivateJsonBlob(pathForUser(WORKSTYLE_ANALYSIS_PATHNAME, userId), userId);
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --experimental-test-module-mocks --test src/lib/blob.user-scope.test.mjs`
Expected: PASS (기존 + 신규 케이스)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/blob.mjs src/lib/blob.user-scope.test.mjs
git commit -m "$(printf 'Add Blob helpers for workstyle analysis storage\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: 오케스트레이션 + 프로필 노출

**Files:**
- Modify: `src/lib/serverCollect.mjs` (import 추가, `runWorkStyleAnalysis` 추가)
- Modify: `src/server.mjs` (`/api/collect`에서 워크스타일 갱신 호출, `/api/profile`에 분석 첨부)
- Test: `src/lib/serverCollect.workstyle.test.mjs`

**Interfaces:**
- Consumes: `collectZeudePromptWindow` (Task 2), `groupWorkAreas` (Task 1), `extractWorkStyleForArea` (Task 3), `saveWorkStyleAnalysis`/`readWorkStyleAnalysis` (Task 4)
- Produces: `runWorkStyleAnalysis({ userId = "default", force = false, windowDays = 30 } = {}) => Promise<{ skipped:boolean, reason?:string, areaCount?:number, llmRefreshed?:boolean }>`
  - LLM은 이전 `llmGeneratedAt`이 7일 초과이거나 `force`일 때만 재추출; 아니면 이전 판단 재사용하고 카운트만 갱신

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// src/lib/serverCollect.workstyle.test.mjs
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const savedBlob = {};
let stored = null;

mock.module("./blob.mjs", {
  namedExports: {
    saveWorkStyleAnalysis: async (data) => { stored = data; return { url: "blob://x" }; },
    readWorkStyleAnalysis: async () => null,
    readWorklogDaily: async () => null,
    saveWorklogDaily: async () => ({ url: "" }),
    saveWorklogProfile: async () => ({ url: "" }),
    listWorklogDates: async () => []
  }
});
mock.module("./workStyleExtract.mjs", {
  namedExports: {
    extractWorkStyleForArea: async (g) => ({ area: g.area, did: ["did-" + g.area], judgments: [{ text: "j", evidence: "e" }] })
  }
});

const { runWorkStyleAnalysis } = await import("./serverCollect.mjs");

test("skips when no prompts", async () => {
  const saved = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  const r = await runWorkStyleAnalysis({ userId: "default" });
  assert.equal(r.skipped, true);
  if (saved !== undefined) process.env.CLICKHOUSE_URL = saved;
});
```

(참고: `collectZeudePromptWindow`는 미설정 시 `[]`를 반환하므로 CLICKHOUSE_URL을 지우면 스킵 경로를 탄다. LLM 경로는 Task 3에서 이미 단위 검증됨.)

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test src/lib/serverCollect.workstyle.test.mjs`
Expected: FAIL — `runWorkStyleAnalysis is not a function`

- [ ] **Step 3: 최소 구현**

`src/lib/serverCollect.mjs` import 블록 수정:
```javascript
import { readWorklogDaily, saveWorklogDaily, saveWorklogProfile, saveWorkStyleAnalysis, readWorkStyleAnalysis } from "./blob.mjs";
import { groupWorkAreas } from "./workAreaGrouping.mjs";
import { extractWorkStyleForArea } from "./workStyleExtract.mjs";
```
(기존 `import { readWorklogDaily, saveWorklogDaily, saveWorklogProfile } from "./blob.mjs";` 라인을 위 첫 줄로 교체하고 나머지 두 import를 추가)

파일 끝에 함수 추가:
```javascript
const WORKSTYLE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 사용자 프롬프트 → 영역 그룹핑(매번) + 판단 추출(stale일 때만) → Blob 저장.
 * 모든 실패는 비치명적.
 */
export async function runWorkStyleAnalysis({ userId = "default", force = false, windowDays = 30 } = {}) {
  const prompts = await collectZeudePromptWindow(userId, windowDays).catch(() => []);
  if (!prompts.length) return { skipped: true, reason: "no prompts" };

  const { areas, droppedAreas } = groupWorkAreas(prompts, { topN: 5 });
  const prior = await readWorkStyleAnalysis(userId).catch(() => null);

  const llmStale = force || !prior?.llmGeneratedAt ||
    (Date.now() - Date.parse(prior.llmGeneratedAt)) > WORKSTYLE_STALE_MS;

  let enriched;
  let llmGeneratedAt = prior?.llmGeneratedAt ?? null;

  if (llmStale) {
    enriched = [];
    for (const area of areas) {
      const r = await extractWorkStyleForArea(area).catch(() => ({ did: [], judgments: [] }));
      enriched.push({ area: area.area, promptCount: area.promptCount, firstDate: area.firstDate, lastDate: area.lastDate, did: r.did ?? [], judgments: r.judgments ?? [] });
    }
    llmGeneratedAt = new Date().toISOString();
  } else {
    enriched = areas.map((a) => {
      const p = (prior.areas ?? []).find((x) => x.area === a.area);
      return { area: a.area, promptCount: a.promptCount, firstDate: a.firstDate, lastDate: a.lastDate, did: p?.did ?? [], judgments: p?.judgments ?? [] };
    });
  }

  await saveWorkStyleAnalysis({
    generatedAt: new Date().toISOString(),
    llmGeneratedAt,
    windowDays,
    areas: enriched,
    droppedAreas
  }, userId);

  return { skipped: false, areaCount: enriched.length, llmRefreshed: llmStale };
}
```

`src/server.mjs`의 `/api/collect` 핸들러에서 `runServerCollection` 호출 다음, `return c.json(result)` 앞에 추가:
```javascript
    const workStyle = await runWorkStyleAnalysis({
      userId: "default",
      force: c.req.query("forceLlm") === "1"
    }).catch((err) => ({ skipped: true, reason: err.message ?? String(err) }));
    result.workStyle = workStyle;
```

`src/server.mjs` import에 추가 (기존 serverCollect import 라인 수정):
```javascript
import { runServerCollection, runWorkStyleAnalysis } from "./lib/serverCollect.mjs";
```
그리고 blob import 라인에 `readWorkStyleAnalysis` 추가:
```javascript
import { listWorklogDates, readWorklogDaily, readWorklogProfile, readWorkStyleAnalysis } from "./lib/blob.mjs";
```

`/api/profile` 핸들러 교체:
```javascript
  app.get("/api/profile", async (c) => {
    const user = resolveRequestUser(c);
    const rawWindow = c.req.query("window");
    const windowDays = rawWindow === "all" || !rawWindow ? null : Number(rawWindow);
    const profile = await readOrBuildProfile(windowDays, user.id);
    let workStyleAnalysis = null;
    try {
      workStyleAnalysis = await readWorkStyleAnalysis(user.id);
    } catch (err) {
      console.warn("[worklog] workstyle analysis read failed:", err.message ?? String(err));
    }
    return c.json({ ...profile, workStyleAnalysis });
  });
```

- [ ] **Step 4: 통과 확인 + 전체 스위트**

Run: `node --experimental-test-module-mocks --test src/lib/serverCollect.workstyle.test.mjs`
Expected: PASS
Run: `node --check src/server.mjs && npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: 문법 OK, fail 0

- [ ] **Step 5: 커밋**

```bash
git add src/lib/serverCollect.mjs src/server.mjs src/lib/serverCollect.workstyle.test.mjs
git commit -m "$(printf 'Wire workstyle analysis into cron collect and profile read\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: UI — 영역 카드 섹션

**Files:**
- Modify: `frontend/src/pages/WorkLogPage.jsx` (`SnapshotCard` 내 workStyle 섹션 교체)
- Modify: `frontend/src/pages/worklog.css` (카드 스타일 추가)
- Test: `frontend/src/pages/WorkLogPage.workstyle.test.mjs` (소스 문자열 검사 — 기존 auth-ui 테스트와 동일 방식)

**Interfaces:**
- Consumes: `profile.workStyleAnalysis` = `{ generatedAt, llmGeneratedAt, windowDays, areas: [{ area, promptCount, firstDate, lastDate, did:[], judgments:[{text,evidence}] }], droppedAreas }`
- Produces: 없음 (최종 UI)

- [ ] **Step 1: 실패 테스트 작성**

```javascript
// frontend/src/pages/WorkLogPage.workstyle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, "WorkLogPage.jsx"), "utf8");

test("renders workstyle area cards from workStyleAnalysis", () => {
  assert.ok(source.includes("workStyleAnalysis"), "reads workStyleAnalysis from profile");
  assert.ok(source.includes("내가 일한 영역과 그 안의 판단"), "section title present");
  assert.ok(source.includes("꺼낸 판단"), "renders judgments label");
});

test("keeps keyword workStyle as fallback when no analysis", () => {
  assert.ok(source.includes("이력서에 남는 작업 방식"), "fallback keyword section retained");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-test-module-mocks --test frontend/src/pages/WorkLogPage.workstyle.test.mjs`
Expected: FAIL — "section title present"

- [ ] **Step 3: 최소 구현**

`SnapshotCard`의 `const workStyle = ...` 다음 줄에 추가:
```javascript
  const workStyleAnalysis = profile?.workStyleAnalysis || null;
  const areas = (workStyleAnalysis?.areas || []).filter((a) => (a.judgments?.length || a.did?.length));
```

`SnapshotCard`의 `return (...)` 안, `이력서에 남는 작업 방식` SnapshotSection 다음(닫는 `</div>` 앞)에 영역 카드 블록 추가:
```javascript
        {areas.length ? (
          <section class="worklog-workstyle">
            <h3 class="worklog-card-title">내가 일한 영역과 그 안의 판단</h3>
            {workStyleAnalysis?.llmGeneratedAt ? (
              <p class="worklog-workstyle-fresh">
                {freshnessLabel(workStyleAnalysis.llmGeneratedAt)}
              </p>
            ) : null}
            <div class="worklog-workstyle-list">
              {areas.map((a, i) => (
                <article key={a.area} class="worklog-workstyle-card">
                  <header class="worklog-workstyle-head">
                    <strong class="worklog-workstyle-area">{a.area}</strong>
                    <span class="worklog-workstyle-meta">
                      {i === 0 ? '가장 많이 · ' : ''}프롬프트 {a.promptCount}건
                    </span>
                  </header>
                  {a.did?.length ? (
                    <p class="worklog-workstyle-did">{a.did.join(' · ')}</p>
                  ) : null}
                  {a.judgments?.length ? (
                    <ul class="worklog-workstyle-judgments">
                      {a.judgments.map((j, k) => (
                        <li key={k}>
                          <span class="worklog-workstyle-judgment">{j.text}</span>
                          {j.evidence ? (
                            <span class="worklog-workstyle-evidence">근거: "{j.evidence}"</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}
```

`WorkLogPage.jsx` 파일 하단(다른 헬퍼 함수 근처, 컴포넌트 밖)에 추가:
```javascript
function freshnessLabel(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
  if (days <= 0) return '오늘 분석';
  return `${days}일 전 분석`;
}
```

- [ ] **Step 4: 통과 확인 + 빌드**

Run: `node --experimental-test-module-mocks --test frontend/src/pages/WorkLogPage.workstyle.test.mjs`
Expected: PASS (2 tests)
Run: `npm run build 2>&1 | tail -1`
Expected: `✓ built`

- [ ] **Step 5: CSS 추가** — `frontend/src/pages/worklog.css` 끝에 shadcn 토큰 기반 스타일 추가:

```css
.worklog-workstyle {
  margin-top: 20px;
  display: grid;
  gap: 12px;
}
.worklog-workstyle-fresh {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.worklog-workstyle-list {
  display: grid;
  gap: 12px;
}
.worklog-workstyle-card {
  border: 1px solid var(--border-input);
  border-radius: var(--radius-card);
  padding: 16px;
  background: #fff;
  box-shadow: var(--shadow-xs);
}
.worklog-workstyle-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
}
.worklog-workstyle-area { font-size: 15px; color: var(--ink-strong); }
.worklog-workstyle-meta { color: var(--muted); font-size: 12px; }
.worklog-workstyle-did { margin: 0 0 8px; color: var(--ink); font-size: 14px; }
.worklog-workstyle-judgments { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.worklog-workstyle-judgment { display: block; color: var(--ink); font-size: 14px; line-height: 1.5; }
.worklog-workstyle-evidence { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
```

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/pages/WorkLogPage.jsx frontend/src/pages/worklog.css frontend/src/pages/WorkLogPage.workstyle.test.mjs
git commit -m "$(printf 'Render work-area judgment cards on the Work Log home\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## 배포 (플랜 완료 후 별도 확인)

전체 테스트 + 빌드 통과 후:
```bash
npm test 2>&1 | grep -E "^ℹ (pass|fail)"
npm run build 2>&1 | tail -1
git push origin main
vercel --prod
# 프로덕션 강제 트리거로 첫 분석 생성:
# curl -H "Authorization: Bearer $CRON_SECRET" ".../api/collect?forceLlm=1"
```
프로덕션 배포·트리거는 회사 환경이므로 사용자 확인 후 진행.

## Self-Review

- **Spec 커버리지:** workAreaGrouping(§컴포넌트1→Task1), collectZeudePromptWindow(§2→Task2), workStyleExtract(§3→Task3), blob 헬퍼(§4→Task4), 오케스트레이션+프로필(§5→Task5), UI(§6→Task6). 에러 처리·YAGNI 각 태스크에 반영. 누락 없음.
- **플레이스홀더:** 없음 — 모든 코드 블록 완결.
- **타입 일관성:** `groupWorkAreas`→`{areas,droppedAreas}`, area shape `{area,promptCount,firstDate,lastDate,prompts}`가 Task1 정의와 Task5 소비에서 일치. `extractWorkStyleForArea`→`{area,did,judgments:[{text,evidence}]}`가 Task3 정의와 Task5/UI 소비에서 일치. 저장 문서 shape가 Task5 저장과 Task6 UI 소비에서 일치.
