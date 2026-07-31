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
import { loadConfig, zeudeEmailsOf } from "./config.mjs";
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
export function aggregateSignals({
  sessionArea,
  frustrationRows = [],
  toolRows = [],
  retryRows = [],
  efficiencyRows = []
} = {}) {
  const areaOf = sessionArea instanceof Map ? sessionArea : new Map();
  // 기본값은 undefined 만 막는다 — 호출자가 명시적 null 을 넘겨도 던지지 않도록 좁힌다.
  const rowsOf = (v) => (Array.isArray(v) ? v : []);

  // 영역 키 → 누산기. null 키는 "전체(overall)".
  const buckets = new Map();
  const bucket = (key) => {
    if (!buckets.has(key)) {
      buckets.set(key, {
        sessions: new Set(),
        scores: [],
        densities: [],
        tools: new Map(),
        retries: [],
        efficiencies: []
      });
    }
    return buckets.get(key);
  };

  let matchedRows = 0;
  let totalRows = 0;

  const addTo = (key, fn) => {
    if (key === undefined) return;
    fn(bucket(key));
  };

  // 조인율은 "세션끼리 실제로 맞는가"를 재는 값이다. 세션이 없는 행은 맞출 대상이
  // 애초에 없으므로 분모에서 뺀다 — 넣으면 폴백 쪽으로 부당하게 끌린다.
  const matchedSessions = new Set();
  const countJoin = (session, area) => {
    if (!session) return;
    totalRows += 1;
    if (!area) return;
    matchedRows += 1;
    matchedSessions.add(session);
  };

  for (const row of rowsOf(frustrationRows)) {
    const session = String(row?.session_id ?? "");
    const area = areaOf.get(session);
    countJoin(session, area);

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

  for (const row of rowsOf(toolRows)) {
    const session = String(row?.session_id ?? "");
    const area = areaOf.get(session);
    countJoin(session, area);

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

  // 세션 단위 단일 수치 신호(재시도율·효율)는 같은 방식으로 누산한다.
  // efficiency 행은 session_id 가 없어(테이블에 컬럼 자체가 없다) 전체 버킷에만 쌓인다.
  const addNumeric = (rows, valueKey, field) => {
    for (const row of rowsOf(rows)) {
      const session = String(row?.session_id ?? "");
      const area = areaOf.get(session);
      countJoin(session, area);

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

  const mean = (list) => (list.length ? round(list.reduce((a, c) => a + c, 0) / list.length) : null);

  const summarize = (b) => {
    if (!b) return emptySummary();
    const toolEntries = [...b.tools.entries()];
    const totalUse = toolEntries.reduce((sum, [, v]) => sum + v.count, 0);
    const verifyUse = toolEntries.reduce((sum, [, v]) => sum + (v.isVerification ? v.count : 0), 0);
    return {
      sessionCount: b.sessions.size,
      avgFrustration: mean(b.scores),
      frustrationDensity: mean(b.densities),
      retryRate: mean(b.retries),
      efficiency: mean(b.efficiencies),
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
    // sessions 는 "이 사람 세션 중 신호가 붙은 수". overall.sessionCount 를 쓰면 브리지에
    // 없는 세션까지 세어 부풀려진다(실측 542 vs 실제 262) — 운영 지표가 거짓말을 하게 된다.
    meta: { sessions: matchedSessions.size, matchedRows, totalRows, joinRatio: round(joinRatio), fallback }
  };
}

/**
 * 이 사람 것이 아닌 이메일까지 달고 있는 user_id 를 걸러낸다.
 * 그런 아이디는 개인 계정이 아니라 여러 사람이 공유하는 서비스 계정이라, 신호를 그대로
 * 쓰면 남의 기록이 섞인다. 판별에 실패하면(조회 오류) 안전하게 후보를 그대로 돌려준다 —
 * 신호가 조금 섞이는 것이 신호를 통째로 잃는 것보다는 낫다.
 *
 * @returns {Promise<string[]>} 이 사람 전용으로 판단되는 user_id 목록
 */
async function excludeSharedIds(candidateIds, emails, windowDays, fetchImpl) {
  const all = [...candidateIds];
  try {
    const rows = await queryClickHouse(
      `
      SELECT user_id, countIf(lower(user_email) NOT IN splitByChar(',', {email:String})) AS foreign_rows
      FROM ai_prompts
      WHERE user_id IN splitByChar(',', {ids:String})
        AND timestamp >= now() - INTERVAL ${windowDays} DAY
      GROUP BY user_id
      FORMAT JSON`,
      { email: emails.join(","), ids: all.join(",") },
      fetchImpl
    );
    const shared = new Set(
      rows.filter((r) => (Number(r?.foreign_rows) || 0) > 0).map((r) => String(r?.user_id ?? ""))
    );
    const owned = all.filter((id) => !shared.has(id));
    // 전부 공용으로 판정되면 판별을 신뢰하지 않고 후보를 그대로 쓴다.
    return owned.length ? owned : all;
  } catch {
    return all;
  }
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
    const emails = zeudeEmailsOf(config ?? {});
    if (!emails.length) return emptySignals();
    const email = emails.join(",");

    const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;

    // 1) 브리지: 이메일 → (세션, user_id, project_path)
    //    user_id 마다 그 아이디가 달고 다니는 이메일도 함께 본다 — 아래 공용 아이디 판별용.
    const bridgeRows = await queryClickHouse(
      `
      SELECT
        session_id,
        any(user_id) AS user_id,
        argMax(project_path, timestamp) AS project_path
      FROM ai_prompts
      WHERE lower(user_email) IN splitByChar(',', {email:String})
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
    const candidateIds = new Set();
    for (const row of bridgeRows) {
      const session = String(row?.session_id ?? "");
      if (session) sessionArea.set(session, areaKey(row?.project_path));
      const uid = String(row?.user_id ?? "").trim();
      if (uid) candidateIds.add(uid);
    }
    if (!candidateIds.size) return emptySignals();

    // 2) 공용 아이디 걸러내기. 한 user_id 가 이 사람 별칭 밖의 이메일까지 달고 있으면
    //    그건 개인이 아니라 여러 사람이 돌려쓰는 서비스 계정이다(실측: Codex 로거가
    //    하나의 아이디로 여러 사람 이메일을 찍는다). 그런 아이디로 신호를 긁으면
    //    남의 좌절·툴 기록이 이 사람 프로필에 섞인다.
    const ownedIds = await excludeSharedIds(candidateIds, emails, windowDays, fetchImpl);
    if (!ownedIds.length) return emptySignals();

    // user_id 목록은 IN splitByChar 로 넘긴다 — Array 파라미터 인용 규칙을 피한다.
    const ids = ownedIds.join(",");

    // 2) 신호: user_id 로 좁힌다 (session_id 조인이 실패해도 overall 은 살아남게)
    const [frustrationRows, toolRows, retryRows, efficiencyRows] = await Promise.all([
      queryClickHouse(
        `
        SELECT
          session_id,
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
      ),
      // 아래 두 테이블은 스키마 확신도가 낮아 개별적으로 비치명적이다 —
      // 쿼리가 깨져도 좌절·툴 신호는 살린다.
      queryClickHouse(
        `
        SELECT
          session_id,
          avg(retry_density) AS rate
        FROM retry_analysis
        WHERE user_id IN splitByChar(',', {ids:String})
          AND date >= today() - ${windowDays}
        GROUP BY session_id
        FORMAT JSON`,
        { ids },
        fetchImpl
      ).catch(() => []),
      // efficiency_metrics_daily 에는 session_id 컬럼이 없다(2026-07-31 실측) —
      // 영역 귀속은 불가능하고 유저 전체 집계로만 반영한다.
      queryClickHouse(
        `
        SELECT avg(cache_hit_rate) AS efficiency
        FROM efficiency_metrics_daily
        WHERE user_id IN splitByChar(',', {ids:String})
          AND date >= today() - ${windowDays}
        FORMAT JSON`,
        { ids },
        fetchImpl
      )
        .then((rows) => rows.map((row) => ({ ...row, session_id: "" })))
        .catch(() => [])
    ]);

    return aggregateSignals({ sessionArea, frustrationRows, toolRows, retryRows, efficiencyRows });
  } catch (err) {
    return emptySignals(err?.message ?? String(err));
  }
}

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
