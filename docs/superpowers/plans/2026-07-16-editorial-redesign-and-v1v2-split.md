# Editorial Redesign + Resume v1/v2 Split + Today-Record Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a colleague-facing v1 (no resume) with an editorial ink+serif design, keep resume-inclusive v2 locally via build flags, and make the daily-record button actually work on the deployed site.

**Architecture:** One branch, two build profiles via `VITE_ENABLE_RESUME` (frontend) and `WORK_LOG_ENABLE_RESUME` (backend). Resume code is never deleted — routes/pages/API are gated and resume-derived response fields are stripped at the API boundary when disabled. The "오늘 기록 생성" button reuses the cron's `runServerCollection` path on Vercel. The editorial look is layered onto existing tokens + components using the approved mockup as the canonical style source.

**Tech Stack:** Preact + Vite (frontend), Hono + `@hono/node-server/vercel` (backend), Vercel Blob (storage), `node --experimental-test-module-mocks --test` (tests).

## Global Constraints

- Frontend flag: resume enabled **iff** `import.meta.env.VITE_ENABLE_RESUME === '1'` (literal compare, build-time inlined).
- Backend flag: resume enabled **iff** `process.env.WORK_LOG_ENABLE_RESUME === '1'`.
- Vercel (v1) sets **neither** flag → resume fully off. Local (v2) sets both `=1` via untracked `.env.local`.
- **Never delete resume code.** Gate and strip only.
- Design: **no blue.** Ink `#1a1815` is the only accent. Serif = Noto Serif KR (weights 500/600/700) for headlines only; body = Pretendard via jsdelivr CDN.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Test runner: `node --experimental-test-module-mocks --test <glob>`. Syntax check: `npm run check`. Build: `npm run build`.
- Button label copy: `오늘 기록 생성` (idle) / `생성 중...` (running).

---

## File Structure

- Create: `src/lib/resumeVisibility.mjs` — pure flag + strip helpers (backend). One responsibility: decide resume visibility and sanitize response objects.
- Create: `src/lib/resumeVisibility.test.mjs` — unit tests for the above.
- Create: `scripts/verify-no-resume.mjs` — build with flag off + grep dist for a resume canary (regression guard).
- Modify: `src/server.mjs` — apply sanitizer, gate resume routes/pages/hook, replace run-batch Vercel branch, add rate limit.
- Modify: `frontend/src/App.jsx` — gate `/resume`, `/resume/chat` behind `RESUME_ENABLED` literal.
- Modify: `frontend/src/pages/WorkLogPage.jsx` — gate Living Resume link, button rename + today-targeting, editorial markup.
- Modify: `frontend/index.html` — Pretendard (jsdelivr) + Noto Serif KR font links.
- Modify: `frontend/src/styles/global.css` — editorial tokens.
- Modify: `frontend/src/pages/worklog.css` — editorial component styles, blue-literal removal in touched components.
- Modify: `frontend/src/pages/Login.module.css` — token alignment.
- Create (untracked, local only): `frontend/.env.local`, `.env.local`.

---

## Task 1: Backend resume-visibility helper (flag + response sanitizers)

**Files:**
- Create: `src/lib/resumeVisibility.mjs`
- Test: `src/lib/resumeVisibility.test.mjs`

**Interfaces:**
- Produces:
  - `resumeEnabled(): boolean` — `process.env.WORK_LOG_ENABLE_RESUME === '1'`
  - `stripResumeFields(summary: object): object` — returns summary without `resume` when disabled; unchanged when enabled or non-object.
  - `stripResumeDraft(profile: object): object` — returns profile without `resumeDraft` when disabled; unchanged when enabled or non-object.

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/resumeVisibility.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { resumeEnabled, stripResumeFields, stripResumeDraft } from "./resumeVisibility.mjs";

function withFlag(value, fn) {
  const saved = process.env.WORK_LOG_ENABLE_RESUME;
  if (value === undefined) delete process.env.WORK_LOG_ENABLE_RESUME;
  else process.env.WORK_LOG_ENABLE_RESUME = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.WORK_LOG_ENABLE_RESUME;
    else process.env.WORK_LOG_ENABLE_RESUME = saved;
  }
}

test("resumeEnabled is true only for exactly '1'", () => {
  withFlag("1", () => assert.equal(resumeEnabled(), true));
  withFlag("0", () => assert.equal(resumeEnabled(), false));
  withFlag(undefined, () => assert.equal(resumeEnabled(), false));
  withFlag("true", () => assert.equal(resumeEnabled(), false));
});

test("stripResumeFields removes resume when disabled, keeps it when enabled", () => {
  const summary = { date: "2026-07-16", sessionCount: 3, resume: { candidates: ["x"] } };
  withFlag(undefined, () => {
    const out = stripResumeFields(summary);
    assert.equal("resume" in out, false);
    assert.equal(out.sessionCount, 3);
    assert.equal("resume" in summary, true, "must not mutate input");
  });
  withFlag("1", () => assert.deepEqual(stripResumeFields(summary), summary));
});

test("stripResumeDraft removes resumeDraft when disabled, keeps it when enabled", () => {
  const profile = { dayCount: 5, resumeDraft: { headline: "h" }, workStyleAnalysis: null };
  withFlag(undefined, () => {
    const out = stripResumeDraft(profile);
    assert.equal("resumeDraft" in out, false);
    assert.equal(out.dayCount, 5);
  });
  withFlag("1", () => assert.deepEqual(stripResumeDraft(profile), profile));
});

test("strip helpers pass through null / non-object", () => {
  withFlag(undefined, () => {
    assert.equal(stripResumeFields(null), null);
    assert.equal(stripResumeDraft(undefined), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-test-module-mocks --test src/lib/resumeVisibility.test.mjs`
Expected: FAIL — cannot find module `./resumeVisibility.mjs`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/lib/resumeVisibility.mjs
/**
 * 레주메 노출 가시성. WORK_LOG_ENABLE_RESUME === "1" 일 때만 레주메성 데이터를
 * 응답에 포함한다. off(Vercel v1 기본)면 응답 경계에서 제거한다. 생성 파이프라인은
 * 건드리지 않는다(로컬 v2와 코드 공유).
 */
export function resumeEnabled() {
  return process.env.WORK_LOG_ENABLE_RESUME === "1";
}

export function stripResumeFields(summary) {
  if (resumeEnabled() || !summary || typeof summary !== "object") return summary;
  const { resume, ...rest } = summary;
  return rest;
}

export function stripResumeDraft(profile) {
  if (resumeEnabled() || !profile || typeof profile !== "object") return profile;
  const { resumeDraft, ...rest } = profile;
  return rest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-test-module-mocks --test src/lib/resumeVisibility.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/resumeVisibility.mjs src/lib/resumeVisibility.test.mjs
git commit -m "Add resume-visibility flag and response sanitizers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Apply sanitizers to /api/day and /api/profile

**Files:**
- Modify: `src/server.mjs` (`GET /api/day/:date` at ~104-108, `GET /api/profile` at ~110-122)

**Interfaces:**
- Consumes: `stripResumeFields`, `stripResumeDraft` from Task 1.

- [ ] **Step 1: Import the helpers**

At the top of `src/server.mjs` with the other `./lib/*` imports, add:

```javascript
import { resumeEnabled, stripResumeFields, stripResumeDraft } from "./lib/resumeVisibility.mjs";
```

- [ ] **Step 2: Sanitize the day response**

Replace the `/api/day/:date` handler body:

```javascript
  app.get("/api/day/:date", async (c) => {
    const user = resolveRequestUser(c);
    const date = c.req.param("date");
    return c.json(stripResumeFields(await readDailySummary(date, user.id)));
  });
```

- [ ] **Step 3: Sanitize the profile response**

In `GET /api/profile`, change the final return so `resumeDraft` is stripped before spreading:

```javascript
    const safeProfile = stripResumeDraft(profile);
    return c.json({ ...safeProfile, workStyleAnalysis });
```

- [ ] **Step 4: Verify syntax + full lib suite**

Run: `npm run check`
Expected: no errors.
Run: `node --experimental-test-module-mocks --test 'src/lib/*.test.mjs'`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/server.mjs
git commit -m "Strip resume/resumeDraft from day and profile responses when disabled

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Gate resume routes, pages, LinkedIn, and batch hook (backend)

**Files:**
- Modify: `src/server.mjs` (cookieAuth uses ~46-50, resume route ~92-95, LinkedIn ~95, `GET /resume` ~214, `registerResumeBatchHook()` ~236)
- Create (untracked): `.env.local`

**Interfaces:**
- Consumes: `resumeEnabled()` from Task 1.

- [ ] **Step 1: Add the disabled-branch redirect/404 BEFORE cookieAuth**

Immediately before the existing `app.use("/resume", cookieAuth());` block (~line 46), insert an early guard so unauthenticated visitors never hit `/login` first:

```javascript
  // Resume disabled (v1): redirect pages to home, 404 the API — must sit BEFORE cookieAuth.
  if (!resumeEnabled()) {
    app.get("/resume", (c) => c.redirect("/", 302));
    app.get("/resume/*", (c) => c.redirect("/", 302));
    app.all("/api/resume/*", (c) => c.json({ error: "not found" }, 404));
  }
```

- [ ] **Step 2: Wrap the enabled-only registrations**

Wrap the existing resume/LinkedIn middleware and routes so they register ONLY when enabled. Specifically guard these existing statements with `if (resumeEnabled()) { ... }`:
- `app.use("/resume", cookieAuth());` + `app.use("/resume/*", cookieAuth());` + `app.use("/api/resume/*", cookieAuth());` (the cookieAuth guards, ~46-50)
- `app.route("/api/resume", resumeRouter);` (~93)
- the LinkedIn route registration (~95)
- the `GET /resume` SPA page handler (~214-216)
- `await registerResumeBatchHook();` (~236)

Example for the batch hook:

```javascript
  if (resumeEnabled()) {
    await registerResumeBatchHook();
  }
```

Leave the imports (`resumeRouter`, `registerResumeBatchHook`) in place — they are harmless when unused and must stay for v2.

- [ ] **Step 3: Create the local backend env file (v2)**

```bash
printf 'WORK_LOG_ENABLE_RESUME=1\n' >> .env.local
```

Confirm `.env.local` is gitignored:

Run: `git check-ignore .env.local`
Expected: prints `.env.local` (ignored).

- [ ] **Step 4: Manual smoke test both modes**

Run (disabled): `WORK_LOG_ENABLE_RESUME= node -e "import('./src/server.mjs').then(m=>console.log(typeof m.createApp))"` — expect it loads without throwing (prints `function` if `createApp` is exported; if the export name differs, just confirm no throw).
Then verify with the running server locally if convenient: `GET /api/resume/anything` → 404, `GET /resume` → 302 to `/`. With `WORK_LOG_ENABLE_RESUME=1` → resume API reachable (401 without cookie, not 404).

- [ ] **Step 5: Syntax check + commit**

Run: `npm run check`
Expected: no errors.

```bash
git add src/server.mjs
git commit -m "Gate resume routes, pages, LinkedIn, and batch hook behind WORK_LOG_ENABLE_RESUME

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Frontend resume flag — routes + Living Resume link + local env

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/pages/WorkLogPage.jsx:345`
- Create (untracked): `frontend/.env.local`

**Interfaces:**
- Produces: `RESUME_ENABLED` literal gate (frontend build-time constant).

- [ ] **Step 1: Add the flag constant and gate the routes in App.jsx**

In `frontend/src/App.jsx`, add near the top (after imports):

```javascript
const RESUME_ENABLED = import.meta.env.VITE_ENABLE_RESUME === '1';
```

Wrap the two resume route checks so they only match when enabled:

```javascript
  if (RESUME_ENABLED && pathname === '/resume') {
    return <ResumePage />;
  }

  if (RESUME_ENABLED && pathname === '/resume/chat') {
    return <ResumeChatPage />;
  }
```

Keep the `import` statements for `ResumePage`/`ResumeChatPage` as-is (static). The literal `RESUME_ENABLED` makes Rollup dead-code-eliminate the branch and tree-shake the modules out of the disabled build (verified: 420KB→37KB). Do **not** convert to dynamic import.

- [ ] **Step 2: Gate the Living Resume link in WorkLogPage**

At `frontend/src/pages/WorkLogPage.jsx:345`, wrap the link. First add the same constant near the top of that file (after imports):

```javascript
const RESUME_ENABLED = import.meta.env.VITE_ENABLE_RESUME === '1';
```

Then replace line 345:

```javascript
              {RESUME_ENABLED ? (
                <a class="worklog-back-link worklog-back-link--secondary" href="/resume">Living Resume</a>
              ) : null}
```

- [ ] **Step 3: Create the local frontend env file (v2)**

```bash
printf 'VITE_ENABLE_RESUME=1\n' >> frontend/.env.local
```

Run: `git check-ignore frontend/.env.local`
Expected: prints the path (ignored).

- [ ] **Step 4: Build both ways and eyeball**

Run: `npm run build`
Expected: build succeeds (this is the DISABLED build — no `frontend/.env.local`? It exists now with =1, so this build is ENABLED). To test the disabled build, temporarily build without the env:

Run: `VITE_ENABLE_RESUME= npx vite build`
Expected: succeeds.

(Real regression check is automated in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.jsx frontend/src/pages/WorkLogPage.jsx
git commit -m "Gate resume routes and Living Resume link behind VITE_ENABLE_RESUME

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Bundle regression guard — resume excluded from disabled build

**Files:**
- Create: `scripts/verify-no-resume.mjs`
- Modify: `package.json` (add `verify:no-resume` script)

**Interfaces:**
- Consumes: the disabled build output in `dist/`.

- [ ] **Step 1: Pick a stable canary string**

Open `frontend/src/pages/ResumePage.jsx` and choose a distinctive Korean UI **string literal** that appears only in resume pages (string literals survive minification). Record it as the canary — e.g. a heading or button label unique to the resume UI. Use that exact substring in Step 2 (replace `CANARY_PLACEHOLDER`).

- [ ] **Step 2: Write the verification script**

```javascript
// scripts/verify-no-resume.mjs
// Builds the frontend with resume DISABLED and asserts the resume bundle is gone.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const CANARY = "CANARY_PLACEHOLDER"; // ← exact resume-only string literal from ResumePage.jsx

execFileSync("npx", ["vite", "build"], {
  stdio: "inherit",
  env: { ...process.env, VITE_ENABLE_RESUME: "" },
});

const assetsDir = path.join(process.cwd(), "dist", "assets");
const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
const hits = jsFiles.filter((f) => readFileSync(path.join(assetsDir, f), "utf8").includes(CANARY));

if (hits.length) {
  console.error(`FAIL: resume canary found in disabled build: ${hits.join(", ")}`);
  process.exit(1);
}
console.log(`OK: resume canary absent from ${jsFiles.length} JS asset(s) in disabled build.`);
```

- [ ] **Step 3: Add the npm script**

In `package.json` `scripts`, add:

```json
    "verify:no-resume": "node scripts/verify-no-resume.mjs",
```

- [ ] **Step 4: Run it**

Run: `npm run verify:no-resume`
Expected: `OK: resume canary absent ...`. If it FAILs, a static reference to resume code leaked into the always-loaded path — fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-no-resume.mjs package.json
git commit -m "Add regression guard: resume excluded from disabled build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: run-batch — Vercel server-collection branch + rate limit + sanitize

**Files:**
- Modify: `src/server.mjs` (`POST /api/run-batch` at ~124-138)

**Interfaces:**
- Consumes: `runServerCollection` (already imported from `./lib/serverCollect.mjs`), `readDailySummary`, `stripResumeFields`, `resolveRequestUser`.

- [ ] **Step 1: Add a module-level debounce map**

Near the top of `src/server.mjs` module scope (outside `createApp`), add:

```javascript
// (userId:date) → last run epoch ms. Guards /api/run-batch from rapid re-runs
// (client throttle is bypassable). Warm serverless instances retain this.
const RUN_BATCH_MIN_INTERVAL_MS = 30_000;
const lastRunBatchAt = new Map();
```

- [ ] **Step 2: Replace the run-batch handler**

Replace the whole `app.post("/api/run-batch", ...)` handler (currently 124-138) with:

```javascript
  app.post("/api/run-batch", async (c) => {
    const user = resolveRequestUser(c);
    const body = await c.req.json().catch(() => ({}));
    const date = body?.date;

    const key = `${user.id}:${date ?? "today"}`;
    const now = Date.now();
    const prev = lastRunBatchAt.get(key) ?? 0;
    if (now - prev < RUN_BATCH_MIN_INTERVAL_MS) {
      return c.json({ error: "너무 잦은 요청입니다. 잠시 후 다시 시도하세요." }, 429);
    }
    lastRunBatchAt.set(key, now);

    if (process.env.VERCEL) {
      // Deployed (v1): no local repos/fs. Reuse the cron's server collection for THIS user.
      await runServerCollection({ userId: user.id, dates: date ? [date] : undefined });
      const summary = await readDailySummary(date, user.id);
      return c.json(stripResumeFields(summary));
    }

    // Local (v2): rich local batch (scans repos, shell history, sessions).
    const result = await runDailyBatch(date, { userId: user.id });
    return c.json(stripResumeFields(result));
  });
```

Note: `runServerCollection` with `dates: undefined` collects `[yesterday, today]`; the frontend always sends today's date (Task 7), so `[date]` is used in practice.

- [ ] **Step 3: Syntax check**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 4: Regression suite**

Run: `node --experimental-test-module-mocks --test 'src/lib/*.test.mjs' 'src/routes/auth.test.mjs'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.mjs
git commit -m "Make run-batch work on Vercel via server collection, with rate limit and sanitize

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Button rename + today-targeting (frontend)

**Files:**
- Modify: `frontend/src/pages/WorkLogPage.jsx` (`handleRunBatch` ~198-244, button ~342-343)

**Interfaces:**
- Consumes: existing `handleRunBatch`, `dateInput` state, `BATCH_THROTTLE_MS`.

- [ ] **Step 1: Target today (KST) in handleRunBatch**

In `handleRunBatch` (line ~198), compute today in KST and use it as the batch date instead of `dateInput`. Replace the `body: JSON.stringify({ date: dateInput })` and the surrounding status strings so the button always generates TODAY:

```javascript
  async function handleRunBatch() {
    const now = Date.now();
    const remaining = BATCH_THROTTLE_MS - (now - lastBatchRunAtRef.current);
    if (isRunningBatch || remaining > 0) {
      setStatus(remaining > 0 ? `재실행은 ${Math.ceil(remaining / 1000)}초 후 가능합니다.` : '생성 중...');
      return;
    }

    const kstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    lastBatchRunAtRef.current = now;
    setIsRunningBatch(true);
    setError('');
    setStatus(`${kstToday} 오늘 기록 생성 중...`);

    try {
      const response = await fetch('/api/run-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: kstToday }),
      });

      if (handleAuthFailure(response)) return;
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `기록을 생성하지 못했습니다. HTTP ${response.status}`);
      }

      const payload = await response.json();
      setDayPayload(payload);
      setSelectedDate(payload.date);
      setDateInput(payload.date);
      selectedDateRef.current = payload.date;
      setStatus(`${payload.date} 기록 완료`);

      const daysRes = await fetch('/api/days');
      const nextDays = daysRes.ok ? await daysRes.json() : days;
      setDays(Array.isArray(nextDays) ? nextDays : days);

      if (payload.date) {
        syncDateInUrl(payload.date, false);
      }
    } catch (err) {
      setError(err.message || '기록을 생성하지 못했습니다.');
      setStatus('생성 실패');
    } finally {
      setIsRunningBatch(false);
    }
  }
```

- [ ] **Step 2: Rename the button label**

At ~342-343 replace the button text:

```javascript
              <button class="worklog-primary-action" type="button" onClick={handleRunBatch} disabled={isRunningBatch}>
                {isRunningBatch ? '생성 중...' : '오늘 기록 생성'}
              </button>
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/WorkLogPage.jsx
git commit -m "Rename daily button to 오늘 기록 생성 and always target today (KST)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Editorial fonts + global tokens

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/src/styles/global.css`

**Interfaces:**
- Produces: `--font-serif`, ink/rule tokens consumed by Tasks 9-10.

- [ ] **Step 1: Fix font loading in index.html**

In `frontend/index.html` `<head>`, replace the existing Google Fonts `<link>`(s) with Pretendard via jsdelivr + Noto Serif KR (weights 500/600/700):

```html
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@500;600;700&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Add editorial tokens to global.css**

In `frontend/src/styles/global.css` `:root`, add the serif + ink/rule tokens:

```css
  --font-serif: "Noto Serif KR", serif;
  --ink: #1a1815;
  --ink-body: #33302b;
  --muted: #8a8378;
  --rule: rgba(26, 24, 21, 0.12);
  --rule-soft: rgba(26, 24, 21, 0.07);
```

- [ ] **Step 3: Retarget the blue accent tokens to ink**

Change the existing accent token values (do not rename them — many rules reference `--accent`/`--primary`) so blue becomes ink:

```css
  --accent: #1a1815;
  --accent-subtle: #33302b;
  --accent-muted: rgba(26, 24, 21, 0.08);
  --primary: #1a1815;
  --ring: #1a1815;
  --focus-ring: 0 0 0 3px rgba(26, 24, 21, 0.18);
```

- [ ] **Step 4: Soften the grid background**

In `global.css` `body`, lower the grid line alpha to `0.018` (from `0.025`) in the two grid `linear-gradient`s so the paper reads calmer. Leave the paper color gradient as-is.

- [ ] **Step 5: Build + eyeball**

Run: `npm run build`
Expected: succeeds. Open the built site (or `npm run dev`) — headings still render (serif not yet applied to elements until Task 9), no blue in default tokens, body text now uses real Pretendard.

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/src/styles/global.css
git commit -m "Load Pretendard via jsdelivr, add Noto Serif KR + ink editorial tokens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Editorial day view — masthead, dateline, lede, stats, area bars, stories

**Files:**
- Modify: `frontend/src/pages/WorkLogPage.jsx` (hero ~277-348, stat bar ~370, story layout ~395-438, breakdown ~455-462)
- Modify: `frontend/src/pages/worklog.css` (corresponding classes)

**Canonical style source:** `.superpowers/brainstorm/19302-1784169236/content/editorial-home-v2.html` — port its CSS for `.masthead`, `.dateline`, `.lede`, `.stats/.stat`, `.sec-head`, `.area-row`, `.story`, `.btn-ink/.btn-ghost` into `worklog.css`, mapping to the existing `worklog-*` class names below.

**Interfaces:**
- Consumes: tokens from Task 8; existing `dayPayload`, `stories`, `leadStory`, `sessionAreas`, `sessionCount`.

- [ ] **Step 1: Restyle the hero/masthead in worklog.css**

Apply serif + ink to the header. Set `.worklog-hero` heading and the brand to `font-family: var(--font-serif)`, add the 1.5px ink bottom rule to the masthead row. Port `.masthead`, `.dateline`, `.lede` rules from the mockup, mapping `.dateline`→ the hero title element and `.lede`→ `.worklog-lede`. Concretely, add to `worklog.css`:

```css
.worklog-hero-copy h1,
.worklog-story-title,
.worklog-compact-title,
.worklog-stat-value { font-family: var(--font-serif); color: var(--ink); }

.worklog-lede { font-family: var(--font-serif); font-weight: 500; font-size: 21px; line-height: 1.62; color: var(--ink); }
```

- [ ] **Step 2: Convert the stat bar to figures + hairlines**

Replace the card styling of `.worklog-stat-bar` / `.worklog-stat-card` with the mockup's `.stats/.stat` treatment (no card background/shadow; serif numerals; top+bottom hairline; left hairline between items). Port from the mockup:

```css
.worklog-stat-bar { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); background: none; box-shadow: none; }
.worklog-stat-card { padding: 20px 4px; background: none; box-shadow: none; border: none; }
.worklog-stat-card + .worklog-stat-card { border-left: 1px solid var(--rule-soft); padding-left: 22px; }
.worklog-stat-value { font-size: 40px; line-height: 1; letter-spacing: -0.02em; }
.worklog-stat-label { font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
```

Keep the existing session-first stat set (세션 / 작업 영역 / 커밋).

- [ ] **Step 3: Replace the donut with ink area bars**

In `WorkLogPage.jsx`, in the insight layout (~455-462), remove the `<TodayBreakdownCard ... />` render call (leave the `TodayBreakdownCard` function defined in the file — do not delete it). In its place render an ink-bar area list from `sessionAreas`:

```javascript
              <section class="worklog-areas">
                <div class="worklog-sec-head"><h2>무엇에 시간을 썼나</h2><span class="worklog-sec-count">세션 기준</span></div>
                {(dayPayload?.summary?.sessionAreas || []).map((a) => {
                  const max = (dayPayload.summary.sessionAreas[0]?.count) || 1;
                  return (
                    <div class="worklog-area-row" key={a.area}>
                      <span class="worklog-area-name">{a.area}</span>
                      <span class="worklog-area-bar"><i style={{ width: `${Math.round((a.count / max) * 100)}%` }} /></span>
                      <span class="worklog-area-count">{a.count}</span>
                    </div>
                  );
                })}
              </section>
```

(Confirm the exact path to the areas array by reading how `sessionAreas` is currently consumed near the stat bar; adjust `dayPayload?.summary?.sessionAreas` to match the real shape.)

- [ ] **Step 4: Add the area-bar + section-head CSS**

Port from the mockup into `worklog.css`:

```css
.worklog-sec-head { display: flex; align-items: baseline; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--ink); margin-top: 40px; }
.worklog-sec-head h2 { font-family: var(--font-serif); font-weight: 700; font-size: 22px; color: var(--ink); margin: 0; }
.worklog-sec-count { font-size: 13px; color: var(--muted); font-weight: 600; }
.worklog-area-row { display: grid; grid-template-columns: minmax(160px, 240px) 1fr 44px; align-items: center; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--rule-soft); }
.worklog-area-name { font-weight: 600; color: var(--ink); font-size: 15px; }
.worklog-area-bar { height: 6px; background: rgba(26,24,21,0.08); position: relative; }
.worklog-area-bar > i { position: absolute; inset: 0 auto 0 0; background: var(--ink); }
.worklog-area-count { text-align: right; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 5: Restyle the primary button to ink**

Replace `.worklog-primary-action` styling with the mockup's `.btn-ink`:

```css
.worklog-primary-action { font-family: var(--font-sans, "Pretendard", sans-serif); font-weight: 600; font-size: 14px; background: var(--ink); color: #f7f3ee; border: 1.5px solid var(--ink); padding: 11px 22px; border-radius: 3px; }
.worklog-primary-action:disabled { opacity: 0.55; }
```

- [ ] **Step 6: Remove blue literals in the touched components**

Run: `grep -nE "#3d56d7|#4462e6|rgba\(37, ?99, ?235|rgba\(72, ?92, ?198|#2563eb" frontend/src/pages/worklog.css`
For each hit that falls inside a rule for the components touched in this task (hero, stat bar, stories, buttons, area rows, dividers), replace the blue literal with `var(--ink)` (solid), `var(--rule)` (borders), or `var(--rule-soft)` (faint lines) as appropriate. Leave hits belonging to out-of-scope screens.

- [ ] **Step 7: Build + eyeball against the mockup**

Run: `npm run build` then open the site. Compare the day view to `editorial-home-v2.html`: serif dateline, hairline stat bar, ink area bars, serif story titles, ink button, zero blue.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/WorkLogPage.jsx frontend/src/pages/worklog.css
git commit -m "Editorial day view: serif dateline, hairline stats, ink area bars, ink button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Editorial judgment principles (hero) + Login alignment

**Files:**
- Modify: `frontend/src/pages/WorkLogPage.jsx` (`SnapshotCard` — the principles section)
- Modify: `frontend/src/pages/worklog.css` (principles classes)
- Modify: `frontend/src/pages/Login.module.css`

**Canonical style source:** the `.principle` block in `editorial-home-v2.html`.

**Interfaces:**
- Consumes: `profile.workStyleAnalysis.principles` (existing shape `[{title, description}]`) and per-area judgments.

- [ ] **Step 1: Restyle the principles as serif pull-quotes**

In `SnapshotCard`, the principles list (currently `<ol class="worklog-principles">`) should render each principle title as a serif blockquote with a small number and description. Update the markup to match the mockup structure (number column + blockquote + desc + evidence). Keep the existing per-area `<details>` "영역별 근거 보기" drilldown untouched below.

```javascript
          <ol class="worklog-principles">
            {principles.map((p, i) => (
              <li class="worklog-principle" key={p.title}>
                <span class="worklog-principle-num">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <blockquote class="worklog-principle-quote">{p.title}</blockquote>
                  <p class="worklog-principle-desc">{p.description}</p>
                </div>
              </li>
            ))}
          </ol>
```

- [ ] **Step 2: Add the principle CSS (ported from mockup)**

```css
.worklog-principles { list-style: none; margin: 22px 0 0; padding: 0; }
.worklog-principle { padding: 30px 0; border-bottom: 1px solid var(--rule-soft); display: grid; grid-template-columns: 40px 1fr; gap: 20px; }
.worklog-principle-num { font-family: var(--font-serif); font-size: 15px; color: var(--muted); font-weight: 600; padding-top: 8px; }
.worklog-principle-quote { margin: 0; font-family: var(--font-serif); font-weight: 600; font-size: 25px; line-height: 1.5; color: var(--ink); letter-spacing: -0.01em; }
.worklog-principle-desc { margin-top: 12px; font-size: 15px; line-height: 1.7; color: var(--ink-body); }
```

- [ ] **Step 3: Align Login to the ink tokens**

In `frontend/src/pages/Login.module.css`, replace any blue literals with `var(--ink)`/`var(--rule)` (run the same grep as Task 9 Step 6 on this file), and set the login title to `font-family: var(--font-serif)`. Keep layout intact.

- [ ] **Step 4: Build + eyeball**

Run: `npm run build` then open `/` and `/login`. Principles render as serif pull-quotes (hero), evidence drilldown still works, login title is serif, no blue anywhere.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/WorkLogPage.jsx frontend/src/pages/worklog.css frontend/src/pages/Login.module.css
git commit -m "Editorial judgment principles as serif pull-quotes; align Login to ink tokens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Full verification + deploy prep

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (existing + new resumeVisibility tests).

- [ ] **Step 2: Syntax check**

Run: `npm run check`
Expected: no errors.

- [ ] **Step 3: Disabled-build regression**

Run: `npm run verify:no-resume`
Expected: `OK: resume canary absent ...`.

- [ ] **Step 4: Enabled build (v2 sanity)**

Run: `npm run build` (with `frontend/.env.local` present → enabled)
Expected: succeeds; locally `/resume` reachable.

- [ ] **Step 5: Deploy note (do not deploy without user go-ahead)**

Confirm Vercel has **neither** `VITE_ENABLE_RESUME` nor `WORK_LOG_ENABLE_RESUME` set, and existing env (`NODEJS_HELPERS=0`, `CLICKHOUSE_*`, `GITHUB_TOKEN`, blob token) intact. Report readiness to the user and await the go-ahead to `vercel --prod`.

---

## Self-Review Notes

- Spec Part 2 (leak) → Tasks 1, 2, 3, 6 (sanitize day/profile/run-batch + gate routes). ✓
- Spec Part 2 (tree-shaking, static import) → Task 4 + regression guard Task 5. ✓
- Spec Part 3 (button + Vercel branch + rate limit) → Tasks 6, 7. ✓
- Spec Part 1 (fonts fix, tokens, day view, principles, Login) → Tasks 8, 9, 10. ✓
- `/resume` redirect before cookieAuth → Task 3 Step 1. ✓
- Local `.env.local` (both) → Task 3 Step 3, Task 4 Step 3. ✓
- Font weights 500/600/700, Pretendard jsdelivr → Task 8 Step 1. ✓
- Blue-literal removal scoped to touched components → Task 9 Step 6, Task 10 Step 3. ✓
