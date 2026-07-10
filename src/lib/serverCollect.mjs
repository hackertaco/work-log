/**
 * Server-side daily work-log collection.
 *
 * The local batch scans this machine's repos, session logs, and shell
 * history. On Vercel none of those exist, so this module collects the
 * remotely reachable equivalents and writes the same DailySummary shape
 * to Vercel Blob:
 *
 *   git commits   → GitHub Search API (pushed commits by the token owner)
 *   slack         → Slack API (same collector the local batch uses)
 *   sessions      → Zeude ClickHouse ai_prompts (the user's Claude/Codex prompts)
 *   shell history → not available remotely; always empty
 *
 * Conflict policy: the local batch is the richer source of truth. A blob
 * day written by the local batch (no `collector` marker) is never
 * overwritten; server-collected days (marked `collector: "server"`) are.
 *
 * Environment variables:
 *   GITHUB_TOKEN            — commit search across repos the token can see
 *   CLICKHOUSE_URL/USER/PASSWORD — Zeude prompt store (optional)
 *   WORK_LOG_ZEUDE_EMAIL    — user_email to query in ai_prompts (optional)
 */

import { buildSummary } from "./batch.mjs";
import { loadConfig } from "./config.mjs";
import { readWorklogDaily, saveWorklogDaily, saveWorklogProfile, saveWorkStyleAnalysis, readWorkStyleAnalysis } from "./blob.mjs";
import { rebuildProfileFromBlob } from "./profile.mjs";
import { detectPrBranchMentions } from "./resumePrBranchParser.mjs";
import { collectSlackContexts } from "./slack.mjs";
import { groupWorkAreas } from "./workAreaGrouping.mjs";
import { extractWorkStyleForArea, synthesizeWorkStylePrinciples } from "./workStyleExtract.mjs";

/** 오늘 날짜 (KST) — 서버는 UTC 이므로 명시적으로 변환한다. */
export function seoulDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

/**
 * Collect one KST date's work log from remote sources and sync it to Blob.
 * Returns a result descriptor; never throws for per-source failures.
 */
export async function collectServerDay(date, { userId = "default" } = {}) {
  const config = await loadConfig({ userId });

  // 로컬 배치가 이미 올린 날짜는 서버 수집이 덮어쓰지 않는다.
  const existing = await readWorklogDaily(date, userId).catch(() => null);
  if (existing && existing.collector !== "server") {
    return { date, skipped: true, reason: "local batch data present" };
  }

  const sourceErrors = {};
  const [gitCommits, slackContexts, prompts] = await Promise.all([
    collectGithubCommits(date).catch((err) => {
      sourceErrors.github = err.message ?? String(err);
      return [];
    }),
    config.includeSlack
      ? collectSlackContexts(config, date).catch((err) => {
          sourceErrors.slack = err.message ?? String(err);
          return [];
        })
      : Promise.resolve([]),
    collectZeudePrompts(date, config).catch((err) => {
      sourceErrors.zeude = err.message ?? String(err);
      return [];
    })
  ]);

  const claudeSessions = prompts
    .filter((p) => p.source !== "codex")
    .map((p) => ({ summary: p.text }));
  const codexSessions = prompts
    .filter((p) => p.source === "codex")
    .map((p) => ({ summary: p.text }));

  const prBranchSignals = detectPrBranchMentions({
    gitCommits,
    shellHistory: [],
    codexSessions,
    claudeSessions
  });

  const summary = await buildSummary({
    date,
    codexSessions,
    claudeSessions,
    slackContexts,
    gitCommits,
    gitWorkingTree: [],
    shellHistory: [],
    prBranchSignals
  });
  summary.collector = "server";
  // 그날 세션(프롬프트)을 영역별로 집계해 세션 중심 UI(카드·비중 차트)의 근거로 저장한다.
  summary.sessionAreas = sessionAreasFromPrompts(prompts);
  summary.sessionCount = prompts.length;

  await saveWorklogDaily(date, summary, userId);

  return {
    date,
    skipped: false,
    counts: summary.counts,
    sourceErrors: Object.keys(sourceErrors).length ? sourceErrors : undefined
  };
}

/**
 * Collect a date range (default: yesterday + today KST), then rebuild the
 * aggregated profile from the blob-synced days.
 */
export async function runServerCollection({ userId = "default", dates } = {}) {
  const targetDates = dates?.length ? dates : [seoulDate(-1), seoulDate(0)];
  const results = [];
  for (const date of targetDates) {
    results.push(await collectServerDay(date, { userId }));
  }

  let profile = null;
  try {
    profile = await rebuildProfileFromBlob(userId);
    if (profile) await saveWorklogProfile(profile, userId);
  } catch (err) {
    results.push({ profileError: err.message ?? String(err) });
  }

  return { dates: targetDates, results, profileDays: profile?.dayCount ?? null };
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

/**
 * Fetch the token owner's commits for one date via the GitHub Search API.
 * Returns objects in the same shape collectGitCommits produces. Commits are
 * classified as "company" via a synthetic company-code repoPath — matching
 * how the local scan categorizes everything under company-code.
 */
export async function collectGithubCommits(date, fetchImpl = fetch) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "work-log-server-collect",
    Authorization: `Bearer ${token}`
  };

  const userRes = await fetchImpl("https://api.github.com/user", { headers });
  if (!userRes.ok) throw new Error(`GitHub /user ${userRes.status}`);
  const login = (await userRes.json()).login;

  const commits = [];
  let page = 1;
  while (page <= 5) {
    const q = encodeURIComponent(`author:${login} committer-date:${date}`);
    const res = await fetchImpl(
      `https://api.github.com/search/commits?q=${q}&per_page=100&page=${page}`,
      { headers }
    );
    if (!res.ok) throw new Error(`GitHub commit search ${res.status}`);
    const body = await res.json();
    for (const item of body.items ?? []) {
      const repo = item.repository?.name ?? "unknown";
      commits.push({
        repo,
        // classifyRepoCategory 가 company 로 분류하도록 로컬 스캔과 같은 경로 형태를 쓴다
        repoPath: `/Documents/company-code/${repo}`,
        hash: (item.sha ?? "").slice(0, 7),
        authoredAt: item.commit?.author?.date ?? `${date}T00:00:00Z`,
        subject: (item.commit?.message ?? "").split("\n")[0]
      });
    }
    if (!body.items?.length || commits.length >= (body.total_count ?? 0)) break;
    page += 1;
  }

  return commits;
}

// ─── Zeude prompts (ClickHouse) ──────────────────────────────────────────────

/**
 * Fetch the user's Claude/Codex prompts for one KST date from Zeude's
 * ClickHouse. Timestamps in ai_prompts are UTC, so the KST date window is
 * [date-1 15:00, date 15:00) UTC.
 */
export async function collectZeudePrompts(date, config = {}, fetchImpl = fetch) {
  const url = process.env.CLICKHOUSE_URL;
  const user = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;
  const email = config.zeudeEmail || process.env.WORK_LOG_ZEUDE_EMAIL || "";
  if (!url || !user || !email) return [];

  // ai_prompts 는 MergeTree 라 PATCH 업데이트가 중복 행으로 쌓인다 — prompt_id 로 dedupe
  const query = `
    SELECT source, argMax(prompt_text, timestamp) AS text, argMax(project_path, timestamp) AS project_path
    FROM ai_prompts
    WHERE user_email = {email:String}
      AND timestamp >= toDateTime({date:String}) - INTERVAL 9 HOUR
      AND timestamp <  toDateTime({date:String}) + INTERVAL 15 HOUR
      AND prompt_type = 'natural'
      AND length(prompt_text) >= 12
      AND NOT startsWith(prompt_text, '<')  -- task-notification 등 시스템 생성 XML 제외
    GROUP BY prompt_id, source
    ORDER BY min(timestamp)
    LIMIT 200
    FORMAT JSON`;

  const endpoint = `${url.replace(/\/$/, "")}/?param_email=${encodeURIComponent(email)}&param_date=${encodeURIComponent(`${date} 00:00:00`)}`;
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
    source: row.source === "codex" ? "codex" : "claude",
    text: String(row.text ?? "").slice(0, 300),
    projectPath: String(row.project_path ?? "")
  }));
}

/**
 * 그날 프롬프트를 작업 영역(레포)별로 집계한다. 순수 함수.
 * @param {Array<{projectPath:string}>} prompts
 * @returns {Array<{area:string, count:number}>} count 내림차순
 */
export function sessionAreasFromPrompts(prompts) {
  const map = new Map();
  for (const p of Array.isArray(prompts) ? prompts : []) {
    const area = areaKeyFromPath(p?.projectPath);
    map.set(area, (map.get(area) || 0) + 1);
  }
  return [...map.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count);
}

function areaKeyFromPath(projectPath) {
  const segments = String(projectPath ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "unknown";
}

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
  // 유저별 Zeude 이메일로 조회한다 (WORK_LOG_USERS_JSON 의 sources.zeudeEmail).
  // config.zeudeEmail 은 loadConfig 안에서 WORK_LOG_ZEUDE_EMAIL 로 폴백된다.
  const config = await loadConfig({ userId }).catch(() => null);
  const email = config?.zeudeEmail || process.env.WORK_LOG_ZEUDE_EMAIL || "";
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
    ORDER BY max(timestamp) DESC
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
  // 쿼리는 최신 2000건을 유지하려고 DESC + LIMIT 이라 최신순으로 온다 —
  // groupWorkAreas 는 시간순(오래된→최신) 배열을 기대하므로 여기서 뒤집는다.
  return (body.data ?? [])
    .map((row) => ({
      text: String(row.text ?? "").slice(0, 300),
      projectPath: String(row.project_path ?? ""),
      source: row.source === "codex" ? "codex" : "claude",
      date: String(row.kst_date ?? "")
    }))
    .reverse();
}

// ─── Workstyle tacit-knowledge orchestration ─────────────────────────────────

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
  let principles;
  let llmGeneratedAt = prior?.llmGeneratedAt ?? null;

  if (llmStale) {
    enriched = [];
    for (const area of areas) {
      const r = await extractWorkStyleForArea(area).catch(() => ({ did: [], judgments: [] }));
      enriched.push({ area: area.area, promptCount: area.promptCount, firstDate: area.firstDate, lastDate: area.lastDate, did: r.did ?? [], judgments: r.judgments ?? [] });
    }
    // 영역별 개별 판단을 가로질러 관통 원칙으로 승격 (이게 화면의 주인공)
    principles = await synthesizeWorkStylePrinciples(enriched).catch(() => []);
    llmGeneratedAt = new Date().toISOString();
  } else {
    enriched = areas.map((a) => {
      const p = (prior.areas ?? []).find((x) => x.area === a.area);
      return { area: a.area, promptCount: a.promptCount, firstDate: a.firstDate, lastDate: a.lastDate, did: p?.did ?? [], judgments: p?.judgments ?? [] };
    });
    principles = prior?.principles ?? [];
  }

  await saveWorkStyleAnalysis({
    generatedAt: new Date().toISOString(),
    llmGeneratedAt,
    windowDays,
    principles,
    areas: enriched,
    droppedAreas
  }, userId);

  return { skipped: false, areaCount: enriched.length, principleCount: principles.length, llmRefreshed: llmStale };
}
