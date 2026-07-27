# Member Work-Style Profiles → KB People Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate an *applicable* per-member work-style profile from work-log's existing prompt analysis and auto-publish it to the KB repo as a `raw/people/{id}.md` file, fully in the cloud, so the KB graph rebuild turns it into a browsable people node.

**Architecture:** work-log's existing Vercel cron (`/api/collect`) already runs per-user `runWorkStyleAnalysis`. We add one more per-run step: synthesize an "applicable" layer (LLM), render markdown, and commit changed files to the KB repo via the GitHub Contents/Git REST API on a `profiles/auto` branch that auto-merges to `main`. KB's `refresh-kb.yml` (`on: push`, `paths: raw/**`) rebuilds the graph. No local git, no new token.

**Tech Stack:** Node ESM (`.mjs`), Hono, OpenAI Responses API (`gpt-5.4-mini`, json_schema strict), GitHub REST API, Vercel Blob, `node --experimental-test-module-mocks --test`.

## Global Constraints

- Feature is **cloud-automatic**: runs inside `/api/collect` (Vercel cron). No local-only steps in the runtime path.
- **No new env token**: reuse existing `GITHUB_TOKEN` (verified `push:True` on the KB repo, 2026-07-27).
- KB repo: **`driving-teacher-bot/driving-teacher-knowledge-base`**, base branch **`main`**, profile path **`raw/people/{userId}.md`**, work branch **`profiles/auto`**.
- Commit **only when file content changed** (compare against existing file on the branch). No-op runs must produce zero commits.
- LLM calls are **non-fatal**: on missing key / `WORK_LOG_DISABLE_OPENAI=1` / error, return empty/null and skip that member — never throw into the cron.
- LLM payload: `model` from `WORK_LOG_OPENAI_MODEL` (default `gpt-5.4-mini`), `reasoning.effort:"low"`, **`max_output_tokens: 3000`** (lower truncates reasoning → empty output; known 2026-07-07 regression), `text.format` = `json_schema` strict, read output via `data.output_text || extractOutputText(data)`.
- Profile honesty markers (verbatim intent): the doc states principles are **"프롬프트에서 관찰된 패턴(가설)"**, framed as **"학습/참고, 행세 아님"**.
- Test runner: `node --experimental-test-module-mocks --test <glob>`. Check: `npm run check`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Data shapes (from existing code — do not redefine)

- Analysis (saved by `runWorkStyleAnalysis`, read by `readWorkStyleAnalysis(userId)`):
  ```
  { generatedAt, llmGeneratedAt, windowDays,
    principles: [{ title, description }],
    areas: [{ area, promptCount, firstDate, lastDate, did: [string], judgments: [{ text, evidence }] }],
    droppedAreas }
  ```
- `getAuthUsers()` → `[{ id, token, name?, sources? }]` (from `src/lib/authUsers.mjs`).

## File Structure

- Create: `src/lib/handoverSynthesis.mjs` — LLM: analysis → applicable layer. + `handoverSynthesis.test.mjs`
- Create: `src/lib/memberProfile.mjs` — pure: analysis + handover → markdown. + `memberProfile.test.mjs`
- Create: `src/lib/kbCommit.mjs` — GitHub REST: commit changed profile files via branch+PR+merge. + `kbCommit.test.mjs`
- Create: `src/lib/profileExport.mjs` — orchestrator: per-user build + commit + notify. + `profileExport.test.mjs`
- Create: `src/lib/slackNotify.mjs` — best-effort Slack DM. + `slackNotify.test.mjs`
- Modify: `src/server.mjs` — call `runProfileExport` once at the end of `/api/collect`.
- Modify: `package.json` — add new test files to the `test` script globs.

---

## Task 1: Verify KB ingests `raw/people/` (spike — de-risk before building)

**Files:** none (read-only investigation + a written finding).

**Why first:** if the KB's `graph_v2_build.py` does not turn `raw/people/*.md` into people nodes, the payoff half of this feature needs a *separate KB-repo change*. Confirm before building the push pipeline.

- [ ] **Step 1: Read the KB graph builder ingestion**

Read `/Users/seungahjung/Documents/company-code/driving-teacher-knowledge-base/scripts/graph_v2_build.py` (and any `raw`-walking helper it imports). Determine: does it recursively walk `raw/**` (so a new `raw/people/` folder is picked up automatically), and does it create/enrich a person/사람 node from a markdown doc about a person?

- [ ] **Step 2: Confirm the push-path trigger**

Confirm `refresh-kb.yml` runs on push to `main` with `paths` including `raw/**` (already observed). Note the concurrency group `kb-pipeline`.

- [ ] **Step 3: Write the finding**

Write 5–10 lines to `docs/superpowers/notes/2026-07-27-kb-people-ingestion.md`: does `raw/people/*.md` become a node with **no KB change**, or is a KB-side change required? If a KB change is required, describe it but mark it **out of scope for this plan** (separate cross-repo task) — this plan still delivers the committed markdown; the node rendering becomes a KB follow-up.

- [ ] **Step 4: Commit the note**

```bash
git add docs/superpowers/notes/2026-07-27-kb-people-ingestion.md
git commit -m "Note: verify KB raw/people ingestion path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `handoverSynthesis.mjs` — LLM applicable layer

**Files:**
- Create: `src/lib/handoverSynthesis.mjs`
- Test: `src/lib/handoverSynthesis.test.mjs`

**Interfaces:**
- Consumes: analysis object (shape above); `extractOutputText` from `./openai.mjs`.
- Produces:
  - `buildHandoverPayload(analysis): object` — Responses API body.
  - `synthesizeHandover(analysis, fetchImpl=fetch): Promise<Handover|null>` where
    `Handover = { oneLiner: string, personaPrompt: string, howToWork: string[], whatToAsk: string[], strengths: string[], heuristics: [{ principle, whenApplies, example, howToApply }] }`.
    Returns `null` when disabled/no-key/empty/error (non-fatal).

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/handoverSynthesis.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { buildHandoverPayload, synthesizeHandover } from "./handoverSynthesis.mjs";

const ANALYSIS = {
  windowDays: 30,
  principles: [{ title: "검증되지 않은 것은 완료가 아니다", description: "테스트부터 세운다" }],
  areas: [{ area: "koreans-love-stock", promptCount: 94, judgments: [{ text: "테스트 먼저", evidence: "with-tests 브랜치 만들어줘" }] }]
};

test("buildHandoverPayload targets Responses API with strict json_schema and 3000 tokens", () => {
  const p = buildHandoverPayload(ANALYSIS);
  assert.equal(p.max_output_tokens, 3000);
  assert.equal(p.text.format.type, "json_schema");
  assert.equal(p.text.format.strict, true);
  assert.deepEqual(p.text.format.schema.required, ["oneLiner", "personaPrompt", "howToWork", "whatToAsk", "strengths", "heuristics"]);
});

test("synthesizeHandover parses model output into the Handover shape", async () => {
  const saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "k";
  const body = {
    oneLiner: "검증 우선주의자",
    personaPrompt: "① 검증 경로부터 ② 사용자 문장 기준 ③ 근본원인까지",
    howToWork: ["PR엔 테스트를 붙여라"], whatToAsk: ["이거 어떻게 검증하지?"], strengths: ["집요한 검증"],
    heuristics: [{ principle: "검증 먼저", whenApplies: "기능 넓히기 전", example: "with-tests 브랜치", howToApply: "확장 전 통과부터" }]
  };
  const fetchImpl = async () => new Response(JSON.stringify({ output_text: JSON.stringify(body) }), { status: 200 });
  const out = await synthesizeHandover(ANALYSIS, fetchImpl);
  assert.equal(out.oneLiner, "검증 우선주의자");
  assert.equal(out.heuristics[0].whenApplies, "기능 넓히기 전");
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

test("synthesizeHandover returns null when disabled or key missing", async () => {
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  assert.equal(await synthesizeHandover(ANALYSIS, () => { throw new Error("no fetch"); }), null);
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

Run: `node --experimental-test-module-mocks --test src/lib/handoverSynthesis.test.mjs`

- [ ] **Step 3: Implement**

```javascript
// src/lib/handoverSynthesis.mjs
import { extractOutputText } from "./openai.mjs";

const OPENAI_URL = process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

export async function synthesizeHandover(analysis, fetchImpl = fetch) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") return null;
  const principles = Array.isArray(analysis?.principles) ? analysis.principles : [];
  if (!principles.length) return null;

  try {
    const response = await fetchImpl(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildHandoverPayload(analysis))
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data.output_text || extractOutputText(data) || "";
    if (!text) return null;
    const p = JSON.parse(text);
    const strs = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
    return {
      oneLiner: String(p.oneLiner ?? "").trim(),
      personaPrompt: String(p.personaPrompt ?? "").trim(),
      howToWork: strs(p.howToWork), whatToAsk: strs(p.whatToAsk), strengths: strs(p.strengths),
      heuristics: (Array.isArray(p.heuristics) ? p.heuristics : []).map((h) => ({
        principle: String(h?.principle ?? "").trim(), whenApplies: String(h?.whenApplies ?? "").trim(),
        example: String(h?.example ?? "").trim(), howToApply: String(h?.howToApply ?? "").trim()
      })).filter((h) => h.principle).slice(0, 8)
    };
  } catch { return null; }
}

export function buildHandoverPayload(analysis) {
  const principles = (analysis?.principles ?? []).map((p) => `- ${p.title}: ${p.description}`).join("\n");
  const judgments = (analysis?.areas ?? [])
    .flatMap((a) => (a.judgments ?? []).map((j) => `[${a.area}] ${j.text} (근거: ${j.evidence})`)).slice(0, 40).join("\n");
  const instruction =
    `아래는 한 사람의 판단 기준(원칙)과 영역별 판단(근거 포함)이다. 이것을 "남이 그대로 적용할 수 있는" 형태로 변환하라. 한국어. ` +
    `heuristics: 각 원칙을 principle(원칙)·whenApplies(어떤 상황에서 발동)·example(근거 프롬프트에서 온 실제 사례)·howToApply(남이 적용하는 법)로. ` +
    `personaPrompt: 원칙들을 증류한, 사람 체크리스트로도 AI 시스템 프롬프트로도 재사용 가능한 "이 사람처럼 판단하기" 한 단락. ` +
    `oneLiner: 한 줄 요약. howToWork/whatToAsk/strengths: 인수인계용 짧은 목록. ` +
    `제공된 근거로 뒷받침되는 것만. 근거 없는 성격 규정·일반론·미화 금지.`;
  const item = (name, req) => ({ type: "array", items: { type: "object", additionalProperties: false, required: req, properties: Object.fromEntries(req.map((k) => [k, { type: "string" }])) } });
  return {
    model: OPENAI_MODEL, reasoning: { effort: "low" }, max_output_tokens: 3000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema", name: "handover", strict: true,
        schema: {
          type: "object", additionalProperties: false,
          required: ["oneLiner", "personaPrompt", "howToWork", "whatToAsk", "strengths", "heuristics"],
          properties: {
            oneLiner: { type: "string" }, personaPrompt: { type: "string" },
            howToWork: { type: "array", items: { type: "string" } },
            whatToAsk: { type: "array", items: { type: "string" } },
            strengths: { type: "array", items: { type: "string" } },
            heuristics: item("heuristics", ["principle", "whenApplies", "example", "howToApply"])
          }
        }
      }
    },
    input: [
      { role: "system", content: instruction },
      { role: "user", content: `## 원칙\n${principles}\n\n## 영역별 판단(근거)\n${judgments}` }
    ]
  };
}
```

- [ ] **Step 4: Run — expect PASS** (3 tests). - [ ] **Step 5: Commit** (`git add src/lib/handoverSynthesis.mjs src/lib/handoverSynthesis.test.mjs`).

---

## Task 3: `memberProfile.mjs` — render markdown

**Files:**
- Create: `src/lib/memberProfile.mjs`
- Test: `src/lib/memberProfile.test.mjs`

**Interfaces:**
- Consumes: analysis shape; `Handover` from Task 2 (may be `null`).
- Produces: `renderMemberProfile({ name, analysis, handover, generatedAt, windowDays }): string` — pure, deterministic markdown. Never throws; tolerates `handover === null` (renders analysis-only sections + a note that the applicable layer is unavailable).

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/memberProfile.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { renderMemberProfile } from "./memberProfile.mjs";

const ANALYSIS = {
  windowDays: 30,
  principles: [{ title: "검증되지 않은 것은 완료가 아니다", description: "테스트부터" }],
  areas: [{ area: "koreans-love-stock", promptCount: 94, judgments: [] }, { area: "neo-fetch", promptCount: 12, judgments: [] }]
};
const HANDOVER = {
  oneLiner: "검증 우선주의자", personaPrompt: "① 검증 ② 사용자 ③ 근본원인",
  howToWork: ["PR엔 테스트를"], whatToAsk: ["어떻게 검증?"], strengths: ["집요함"],
  heuristics: [{ principle: "검증 먼저", whenApplies: "확장 전", example: "with-tests 브랜치", howToApply: "통과부터" }]
};

test("renders headline, honesty marker, persona block, 4-layer heuristics, areas", () => {
  const md = renderMemberProfile({ name: "seungah", analysis: ANALYSIS, handover: HANDOVER, generatedAt: "2026-07-27T00:00:00Z", windowDays: 30 });
  assert.match(md, /^# seungah — 업무방식/m);
  assert.match(md, /관찰된 패턴/);            // honesty marker
  assert.match(md, /행세가 아니라|학습|참고/);   // framing
  assert.match(md, /이 사람처럼 판단하기/);       // persona block heading
  assert.match(md, /① 검증 ② 사용자 ③ 근본원인/); // persona content
  assert.match(md, /검증 먼저/);                 // heuristic principle
  assert.match(md, /확장 전/);                   // whenApplies
  assert.match(md, /with-tests 브랜치/);         // example
  assert.match(md, /koreans-love-stock.*94/);    // area + count
});

test("tolerates null handover (analysis-only, no throw)", () => {
  const md = renderMemberProfile({ name: "x", analysis: ANALYSIS, handover: null, generatedAt: "2026-07-27T00:00:00Z", windowDays: 30 });
  assert.match(md, /# x — 업무방식/);
  assert.match(md, /검증되지 않은 것은 완료가 아니다/); // principle still shown
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```javascript
// src/lib/memberProfile.mjs
/** analysis + handover → 적용 가능한 업무방식 프로필 markdown. 순수 함수. */
export function renderMemberProfile({ name, analysis, handover, generatedAt, windowDays }) {
  const L = [];
  L.push(`# ${name} — 업무방식`);
  L.push("");
  L.push("> ⚠️ 아래는 이 사람이 AI에게 남긴 **프롬프트에서 관찰된 패턴(가설)**입니다. 확정된 성격 규정이 아니며, 본인이 정정할 수 있습니다.");
  L.push("> 목적은 이 사람 \"행세\"가 아니라, 접근 방식을 **학습·참고**하는 것입니다.");
  L.push("");
  if (handover?.oneLiner) { L.push(`**한 줄 요약** — ${handover.oneLiner}`); L.push(""); }

  if (handover?.personaPrompt) {
    L.push("## 이 사람처럼 판단하기");
    L.push("_사람 체크리스트로도, AI에 붙이는 프롬프트로도 쓸 수 있습니다._");
    L.push("");
    L.push("> " + handover.personaPrompt.replace(/\n/g, "\n> "));
    L.push("");
  }

  L.push("## 판단 기준");
  const heur = handover?.heuristics ?? [];
  if (heur.length) {
    for (const h of heur) {
      L.push(`### ${h.principle}`);
      if (h.whenApplies) L.push(`- **언제** — ${h.whenApplies}`);
      if (h.example) L.push(`- **사례** — ${h.example}`);
      if (h.howToApply) L.push(`- **적용법** — ${h.howToApply}`);
      L.push("");
    }
  } else {
    for (const p of analysis?.principles ?? []) L.push(`- **${p.title}** — ${p.description}`);
    L.push("");
  }

  L.push("## 많이 한 일");
  for (const a of (analysis?.areas ?? []).slice(0, 8)) L.push(`- ${a.area} · ${a.promptCount}회`);
  L.push("");

  if (handover && (handover.howToWork.length || handover.whatToAsk.length || handover.strengths.length)) {
    L.push("## 인수인계");
    if (handover.howToWork.length) { L.push("**이 사람과 일하는 법**"); handover.howToWork.forEach((s) => L.push(`- ${s}`)); L.push(""); }
    if (handover.whatToAsk.length) { L.push("**물어보면 좋은 것**"); handover.whatToAsk.forEach((s) => L.push(`- ${s}`)); L.push(""); }
    if (handover.strengths.length) { L.push("**강점**"); handover.strengths.forEach((s) => L.push(`- ${s}`)); L.push(""); }
  }

  L.push("---");
  L.push(`_생성: ${generatedAt} · 근거 창: 최근 ${windowDays}일 · 출처: Claude/Codex 프롬프트_`);
  return L.join("\n") + "\n";
}
```

- [ ] **Step 4: Run — expect PASS (2 tests).** - [ ] **Step 5: Commit.**

---

## Task 4: `kbCommit.mjs` — commit changed profiles to KB via GitHub REST

**Files:**
- Create: `src/lib/kbCommit.mjs`
- Test: `src/lib/kbCommit.test.mjs`

**Interfaces:**
- Produces:
  - `contentChanged(existingBase64, newText): boolean` — true if the decoded existing content differs from `newText`.
  - `commitProfilesToKb({ owner, repo, base, branch, files, token, fetchImpl=fetch }): Promise<{ changed: string[], skipped: string[], committed: boolean, pr?: number, merged?: boolean }>` where `files = [{ path, content }]`. Steps (GitHub REST): ensure `branch` exists at `base` head → for each file GET its blob on `branch`, PUT only if `contentChanged` → if any changed, open/reuse PR `branch`→`base`, merge it. If nothing changed: `{ committed:false }`, **no PR, no merge**.

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/kbCommit.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { contentChanged, commitProfilesToKb } from "./kbCommit.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("contentChanged compares decoded base64 to new text", () => {
  assert.equal(contentChanged(b64("hello\n"), "hello\n"), false);
  assert.equal(contentChanged(b64("old"), "new"), true);
  assert.equal(contentChanged(null, "anything"), true); // no existing file
});

test("commitProfilesToKb is a no-op (no PR/merge) when all files unchanged", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/git/ref/")) return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
    if (url.includes("/contents/")) return new Response(JSON.stringify({ sha: "fsha", content: b64("same\n") }), { status: 200 });
    throw new Error("unexpected " + url);
  };
  const out = await commitProfilesToKb({ owner: "o", repo: "r", base: "main", branch: "profiles/auto",
    files: [{ path: "raw/people/x.md", content: "same\n" }], token: "t", fetchImpl });
  assert.equal(out.committed, false);
  assert.deepEqual(out.skipped, ["raw/people/x.md"]);
  assert.equal(calls.some((c) => c.startsWith("PUT")), false, "no PUT when unchanged");
  assert.equal(calls.some((c) => c.includes("/pulls")), false, "no PR when unchanged");
});

test("commitProfilesToKb PUTs changed file with prev sha, then opens+merges PR", async () => {
  const puts = [];
  const fetchImpl = async (url, init) => {
    const m = init?.method ?? "GET";
    if (url.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "basesha" } }), { status: 200 });
    if (url.includes("/git/refs") && m === "POST") return new Response(JSON.stringify({}), { status: 201 });
    if (url.includes("/contents/") && m === "GET") return new Response(JSON.stringify({ sha: "oldsha", content: b64("old\n") }), { status: 200 });
    if (url.includes("/contents/") && m === "PUT") { puts.push(JSON.parse(init.body)); return new Response(JSON.stringify({}), { status: 200 }); }
    if (url.endsWith("/pulls") && m === "POST") return new Response(JSON.stringify({ number: 7 }), { status: 201 });
    if (url.includes("/pulls/7/merge") && m === "PUT") return new Response(JSON.stringify({ merged: true }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const out = await commitProfilesToKb({ owner: "o", repo: "r", base: "main", branch: "profiles/auto",
    files: [{ path: "raw/people/x.md", content: "new\n" }], token: "t", fetchImpl });
  assert.equal(out.committed, true);
  assert.deepEqual(out.changed, ["raw/people/x.md"]);
  assert.equal(out.pr, 7);
  assert.equal(out.merged, true);
  assert.equal(puts[0].sha, "oldsha", "PUT must carry the existing blob sha");
  assert.equal(Buffer.from(puts[0].content, "base64").toString("utf8"), "new\n");
  assert.equal(puts[0].branch, "profiles/auto");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```javascript
// src/lib/kbCommit.mjs
// KB 레포에 프로필 파일을 GitHub REST로 커밋한다. 로컬 git 불필요(Vercel에서 HTTPS).
const API = "https://api.github.com";

export function contentChanged(existingBase64, newText) {
  if (!existingBase64) return true;
  const decoded = Buffer.from(String(existingBase64).replace(/\n/g, ""), "base64").toString("utf8");
  return decoded !== newText;
}

async function gh(fetchImpl, token, url, init = {}) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", ...(init.headers || {}) }
  });
  return res;
}

export async function commitProfilesToKb({ owner, repo, base, branch, files, token, fetchImpl = fetch }) {
  const changed = [], skipped = [];
  // 1) base head + ensure work branch
  const refRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/ref/heads/${base}`);
  const baseSha = (await refRes.json())?.object?.sha;
  if (baseSha) {
    // reset/create work branch at base head (best-effort: create; if exists, update)
    const created = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }) });
    if (created.status === 422) {
      await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: baseSha, force: true }) });
    }
  }
  // 2) per file: get existing on branch, PUT if changed
  for (const f of files) {
    const getRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/contents/${f.path}?ref=${branch}`);
    const existing = getRes.status === 200 ? await getRes.json() : null;
    if (!contentChanged(existing?.content ?? null, f.content)) { skipped.push(f.path); continue; }
    await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/contents/${f.path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `chore(profiles): update ${f.path}`,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        branch, ...(existing?.sha ? { sha: existing.sha } : {})
      })
    });
    changed.push(f.path);
  }
  if (!changed.length) return { changed, skipped, committed: false };
  // 3) open (or reuse) PR and merge
  const prRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: "chore: member work-style profiles", head: branch, base }) });
  let pr = prRes.status === 201 ? (await prRes.json())?.number : undefined;
  if (!pr) {
    const listRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&base=${base}&state=open`);
    pr = (await listRes.json())?.[0]?.number;
  }
  let merged = false;
  if (pr) {
    const mergeRes = await gh(fetchImpl, token, `${API}/repos/${owner}/${repo}/pulls/${pr}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) });
    merged = mergeRes.status === 200;
  }
  return { changed, skipped, committed: true, pr, merged };
}
```

- [ ] **Step 4: Run — expect PASS (3 tests).** - [ ] **Step 5: Commit.**

---

## Task 5: `slackNotify.mjs` — best-effort DM (non-fatal)

**Files:**
- Create: `src/lib/slackNotify.mjs`
- Test: `src/lib/slackNotify.test.mjs`

**Interfaces:**
- Produces: `notifyMemberProfile({ slackUserId, url, token, fetchImpl=fetch }): Promise<boolean>` — opens a DM (`conversations.open`) and posts (`chat.postMessage`). Returns `false` (no throw) when token/slackUserId missing or API fails.

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/slackNotify.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { notifyMemberProfile } from "./slackNotify.mjs";

test("returns false without token or slackUserId (no fetch)", async () => {
  assert.equal(await notifyMemberProfile({ slackUserId: "", url: "u", token: "", fetchImpl: () => { throw new Error("x"); } }), false);
  assert.equal(await notifyMemberProfile({ slackUserId: "U1", url: "u", token: "", fetchImpl: () => { throw new Error("x"); } }), false);
});

test("opens DM channel then posts message", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes("conversations.open")) return new Response(JSON.stringify({ ok: true, channel: { id: "D1" } }), { status: 200 });
    if (url.includes("chat.postMessage")) { const b = JSON.parse(init.body); assert.equal(b.channel, "D1"); assert.match(b.text, /업무방식/); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
    throw new Error("unexpected");
  };
  assert.equal(await notifyMemberProfile({ slackUserId: "U1", url: "https://kb/x", token: "t", fetchImpl }), true);
  assert.ok(calls.some((c) => c.includes("conversations.open")) && calls.some((c) => c.includes("chat.postMessage")));
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```javascript
// src/lib/slackNotify.mjs
export async function notifyMemberProfile({ slackUserId, url, token, fetchImpl = fetch }) {
  if (!token || !slackUserId) return false;
  try {
    const open = await fetchImpl("https://slack.com/api/conversations.open", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ users: slackUserId })
    });
    const channel = (await open.json())?.channel?.id;
    if (!channel) return false;
    const post = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, text: `당신의 업무방식 프로필이 KB에 올라갔어요 → ${url}\n관찰된 패턴이라 이상하면 알려주세요.` })
    });
    return (await post.json())?.ok === true;
  } catch { return false; }
}
```

- [ ] **Step 4: Run — expect PASS (2 tests).** - [ ] **Step 5: Commit.**

---

## Task 6: `profileExport.mjs` — orchestrator

**Files:**
- Create: `src/lib/profileExport.mjs`
- Test: `src/lib/profileExport.test.mjs`

**Interfaces:**
- Consumes: `readWorkStyleAnalysis` (blob), `synthesizeHandover` (T2), `renderMemberProfile` (T3), `commitProfilesToKb` (T4), `notifyMemberProfile` (T5), `getAuthUsers` (authUsers), `loadConfig` (config, for `slackUserId`).
- Produces: `runProfileExport({ userIds, now, fetchImpl=fetch }): Promise<{ built: string[], commit: object }>` — for each userId: read analysis (skip if none), synthesize handover, render md → `{ path: 'raw/people/{id}.md', content }`; then one `commitProfilesToKb` for all; then best-effort notify per changed member. Reads KB coords + token from env: `KB_REPO_OWNER`/`KB_REPO_NAME` (default `driving-teacher-bot`/`driving-teacher-knowledge-base`), `KB_BASE_BRANCH` (default `main`), `GITHUB_TOKEN`. If `GITHUB_TOKEN` missing → build files but skip commit (return `commit:{committed:false, reason:'no token'}`).

- [ ] **Step 1: Write the failing test** (mock the sibling modules via `mock.module`, following `src/routes/resume.rollback.test.mjs` / `src/server.run-batch.test.mjs` patterns)

```javascript
// src/lib/profileExport.test.mjs
import assert from "node:assert/strict";
import test, { mock } from "node:test";

test("skips users with no analysis; builds md for those with; commits once", async () => {
  const analyses = { seungah: { windowDays: 30, principles: [{ title: "P", description: "d" }], areas: [{ area: "a", promptCount: 5, judgments: [] }] }, empty: null };
  mock.module("./blob.mjs", { namedExports: { readWorkStyleAnalysis: async (id) => analyses[id] } });
  mock.module("./handoverSynthesis.mjs", { namedExports: { synthesizeHandover: async () => ({ oneLiner: "o", personaPrompt: "pp", howToWork: [], whatToAsk: [], strengths: [], heuristics: [] }) } });
  let committedFiles = null;
  mock.module("./kbCommit.mjs", { namedExports: { commitProfilesToKb: async ({ files }) => { committedFiles = files; return { committed: true, changed: files.map((f) => f.path), skipped: [], pr: 1, merged: true }; } } });
  mock.module("./slackNotify.mjs", { namedExports: { notifyMemberProfile: async () => true } });
  mock.module("./config.mjs", { namedExports: { loadConfig: () => ({ slackUserId: "" }) } });

  const saved = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = "t";
  const { runProfileExport } = await import("./profileExport.mjs?" + Math.random());
  const out = await runProfileExport({ userIds: ["seungah", "empty"], now: "2026-07-27T00:00:00Z" });
  assert.deepEqual(out.built, ["seungah"]);
  assert.equal(committedFiles.length, 1);
  assert.equal(committedFiles[0].path, "raw/people/seungah.md");
  assert.match(committedFiles[0].content, /seungah — 업무방식/);
  if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

```javascript
// src/lib/profileExport.mjs
import { readWorkStyleAnalysis } from "./blob.mjs";
import { synthesizeHandover } from "./handoverSynthesis.mjs";
import { renderMemberProfile } from "./memberProfile.mjs";
import { commitProfilesToKb } from "./kbCommit.mjs";
import { notifyMemberProfile } from "./slackNotify.mjs";
import { loadConfig } from "./config.mjs";
import { getAuthUsers } from "./authUsers.mjs";

const OWNER = process.env.KB_REPO_OWNER || "driving-teacher-bot";
const REPO = process.env.KB_REPO_NAME || "driving-teacher-knowledge-base";
const BASE = process.env.KB_BASE_BRANCH || "main";
const BRANCH = "profiles/auto";

export async function runProfileExport({ userIds, now = new Date().toISOString(), fetchImpl = fetch } = {}) {
  const users = getAuthUsers();
  const nameOf = (id) => users.find((u) => u.id === id)?.name || id;
  const ids = userIds ?? users.map((u) => u.id);

  const built = [], files = [];
  for (const id of ids) {
    const analysis = await readWorkStyleAnalysis(id).catch(() => null);
    if (!analysis?.principles?.length) continue;
    const handover = await synthesizeHandover(analysis, fetchImpl).catch(() => null);
    const content = renderMemberProfile({ name: nameOf(id), analysis, handover, generatedAt: now, windowDays: analysis.windowDays ?? 30 });
    files.push({ path: `raw/people/${id}.md`, content });
    built.push(id);
  }
  if (!files.length) return { built, commit: { committed: false, reason: "nothing to build" } };

  const token = process.env.GITHUB_TOKEN;
  if (!token) return { built, commit: { committed: false, reason: "no token" } };

  const commit = await commitProfilesToKb({ owner: OWNER, repo: REPO, base: BASE, branch: BRANCH, files, token, fetchImpl });

  // best-effort notify for changed members
  const slackToken = process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN || "";
  for (const path of commit.changed ?? []) {
    const id = path.replace(/^raw\/people\//, "").replace(/\.md$/, "");
    const slackUserId = loadConfig({ userId: id })?.slackUserId || "";
    const url = `https://github.com/${OWNER}/${REPO}/blob/${BASE}/${path}`;
    await notifyMemberProfile({ slackUserId, url, token: slackToken, fetchImpl }).catch(() => false);
  }
  return { built, commit };
}
```

- [ ] **Step 4: Run — expect PASS.** - [ ] **Step 5: Commit.**

---

## Task 7: Wire into `/api/collect` + register tests

**Files:**
- Modify: `src/server.mjs` (`/api/collect`, after the per-user loop)
- Modify: `package.json` (test globs)

**Interfaces:** Consumes `runProfileExport` (T6).

- [ ] **Step 1: Import + call at end of `/api/collect`**

In `src/server.mjs`, add import near the other `./lib` imports:
```javascript
import { runProfileExport } from "./lib/profileExport.mjs";
```
Then in the `/api/collect` handler, after the `for (const userId of userIds)` loop and before `return c.json(...)`, add (non-fatal):
```javascript
    const profiles = await runProfileExport({ userIds }).catch((err) => ({ error: err.message ?? String(err) }));
    return c.json({ users: userIds, results: perUser, profiles });
```
(Replace the existing `return c.json({ users: userIds, results: perUser });`.)

- [ ] **Step 2: Add the new test files to `package.json`**

Append these to the appropriate `node --test` glob group in the `test` script:
`'src/lib/handoverSynthesis.test.mjs' 'src/lib/memberProfile.test.mjs' 'src/lib/kbCommit.test.mjs' 'src/lib/slackNotify.test.mjs' 'src/lib/profileExport.test.mjs'`
(They also match an existing `src/lib/*.test.mjs` glob if present — confirm they run; add explicitly only if the globs don't already cover them.)

- [ ] **Step 3: Verify**

Run: `npm run check` → clean.
Run: `npm test` → all pass (new + existing).

- [ ] **Step 4: Commit.**

---

## Task 8: First-run verification (guarded, real API)

**Files:** none (operational).

- [ ] **Step 1: Local dry check (no commit)**

With `.env.local` loaded, run a node one-liner that imports `runProfileExport` with `GITHUB_TOKEN` **unset** for the process, over the real `readWorkStyleAnalysis` (needs Blob token) — assert it returns `built:[...]` and `commit.reason:"no token"` (builds md, does not push). Confirm the rendered md for `seungah` looks right (print length + headings).

- [ ] **Step 2: One real push to a test branch**

Temporarily set `KB_BASE_BRANCH` to a throwaway branch (e.g. `profiles-test`) created off main, run `runProfileExport` for one user with the real `GITHUB_TOKEN`, and confirm: `profiles/auto` branch created, file committed, PR opened+merged into `profiles-test`. Inspect the committed md on GitHub. Delete `profiles-test` after.

- [ ] **Step 3: Report readiness**

Report to the user: md quality, that the push chain works, and whether Task 1's finding means the KB people-node rendering is automatic or needs a KB follow-up. **Do not enable on production main** without the user's go-ahead.

---

## Self-Review Notes

- Spec "완전 클라우드 자동" → Tasks 6–7 (runs inside `/api/collect`, GitHub REST, no local git). ✓
- Spec "내용 바뀔 때만 커밋" → Task 4 `contentChanged` + no-op test. ✓
- Spec "적용 가능한 4겹 + 페르소나 블록" → Task 2 (synthesis) + Task 3 (render), tests assert both. ✓
- Spec "정직 단서(관찰된 가설/학습 아닌 행세)" → Task 3 honesty-marker test. ✓
- Spec "토큰 재사용, 새 env 없음" → Task 6 uses `GITHUB_TOKEN`; defaults for KB coords. ✓
- Spec "슬랙 DM 통지(best-effort)" → Task 5 + Task 6 wiring, non-fatal. ✓
- Spec "profiles/auto 브랜치 + 자동머지" → Task 4 branch→PR→squash-merge. ✓
- Spec risk "graph_v2가 raw/people 흡수?" → Task 1 spike (de-risk, separates KB follow-up). ✓
- Non-fatal LLM/commit/notify everywhere so the cron never breaks collection. ✓
