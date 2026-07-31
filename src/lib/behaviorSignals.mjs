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
