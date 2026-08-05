/**
 * 개인용 사용 코칭 — "내가 어제 어떻게 썼는지"와 "무엇을 바꾸면 덜 막히는지".
 *
 * usageAudit.mjs 는 팀 리포트(리드용)다. 이 모듈은 그 반대편이다:
 *   - **본인 것만** 본다. 다른 사람 숫자·순위는 절대 넣지 않는다. 비교가 들어가면 코칭이
 *     아니라 감시로 읽힌다.
 *   - 문구는 "아껴라"가 아니라 "이렇게 하면 덜 막힌다"로 쓴다. Max 구독에서 달러는
 *     환산값이고 실제 제약은 한도와 재작업이다.
 *   - 근거 수치가 없는 조언은 만들지 않는다. 임계값을 못 넘으면 그 항목은 침묵한다.
 *
 * 실패는 비치명적. 조회가 안 되면 null 을 돌려주고 페이지는 이 절을 그냥 안 그린다.
 */
import { loadConfig, zeudeEmailsOf } from "./config.mjs";

/** 이 값을 넘으면 "큰 창"으로 본다 — 재개할 때 통째로 다시 처리되는 크기. */
const BIG_CONTEXT = 150_000;
/** 캐시 수명이 구독 기준 1시간이라, 이보다 오래 비우면 캐시가 죽는다. */
const CACHE_DEAD_MIN = 60;
/** 한 번 읽어 세션 끝까지 따라다니는 크기. */
const BIG_READ = 30_000;
/** 한도는 분당으로 걸린다. 이 선을 넘긴 시간이 길면 몰림이 있다. */
const BURST_TOKENS_PER_MIN = 5_000_000;
/** 조언은 최대 이만큼만 — 다 나열하면 아무것도 안 읽힌다. */
const MAX_TIPS = 3;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const k = (n) => Math.round(num(n) / 1000);

async function queryClickHouse(query, fetchImpl) {
  const url = process.env.CLICKHOUSE_URL;
  const user = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;
  if (!url || !user) throw new Error("no clickhouse config");

  const res = await fetchImpl(`${url.replace(/\/$/, "")}/?default_format=JSON`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password ?? ""}`).toString("base64")}` },
    body: query
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}`);
  return (await res.json()).data ?? [];
}

const CTX = `(toFloat64OrZero(LogAttributes['input_tokens'])+toFloat64OrZero(LogAttributes['cache_read_tokens'])+toFloat64OrZero(LogAttributes['cache_creation_tokens']))`;

/**
 * 한 사람의 최근 사용 실측. 이메일이 여러 개인 사람이 있어서(회사/개인 계정)
 * zeude.user.email 을 목록으로 받아 IN 으로 좁힌다.
 */
function factsQuery(days, emails) {
  const list = emails.map((e) => `'${String(e).replace(/'/g, "")}'`).join(",");
  const person = `ResourceAttributes['zeude.user.email']`;
  return `
WITH ev AS (
  SELECT ${CTX} AS ctx,
    toFloat64OrZero(LogAttributes['cache_creation_tokens']) AS cw,
    LogAttributes['effort'] AS effort,
    LogAttributes['model'] AS model,
    LogAttributes['session.id'] AS sid,
    Timestamp AS ts,
    dateDiff('minute', lagInFrame(Timestamp) OVER (PARTITION BY LogAttributes['session.id'] ORDER BY Timestamp), Timestamp) AS gap_min
  FROM claude_code_logs
  WHERE Timestamp >= now() - INTERVAL ${days} DAY
    AND LogAttributes['event.name'] = 'api_request' AND ${person} IN (${list})
),
mins AS (
  SELECT toStartOfMinute(Timestamp) AS mn, uniqExact(LogAttributes['session.id']) AS conc, sum(${CTX}) AS tok
  FROM claude_code_logs
  WHERE Timestamp >= now() - INTERVAL ${days} DAY
    AND LogAttributes['event.name'] = 'api_request' AND ${person} IN (${list})
  GROUP BY mn
),
reads AS (
  SELECT countIf(toFloat64OrZero(LogAttributes['tool_result_size_bytes'])/4 > ${BIG_READ}) AS big_reads,
    count() AS total_reads
  FROM claude_code_logs
  WHERE Timestamp >= now() - INTERVAL ${days} DAY
    AND LogAttributes['event.name'] = 'tool_result' AND LogAttributes['tool_name'] = 'Read'
    AND ${person} IN (${list})
),
stops AS (
  SELECT countIf(position(LogAttributes['error'], 'usage limits') > 0) AS hard_stops
  FROM claude_code_logs
  WHERE Timestamp >= now() - INTERVAL ${days} DAY
    AND LogAttributes['event.name'] = 'api_error' AND ${person} IN (${list})
)
SELECT
  (SELECT count() FROM ev) AS reqs,
  (SELECT round(avg(ctx)) FROM ev) AS avg_ctx,
  (SELECT round(max(ctx)) FROM ev) AS max_ctx,
  (SELECT uniqExact(sid) FROM ev) AS sessions,
  (SELECT countIf(gap_min > ${CACHE_DEAD_MIN} AND cw > ${BIG_CONTEXT}) FROM ev) AS cold_resumes,
  (SELECT round(avgIf(cw, gap_min > ${CACHE_DEAD_MIN} AND cw > ${BIG_CONTEXT})) FROM ev) AS cold_resume_ktok,
  (SELECT countIf(effort IN ('xhigh','max')) FROM ev) AS high_effort_reqs,
  (SELECT countIf(model = 'claude-fable-5') FROM ev) AS premium_reqs,
  (SELECT max(conc) FROM mins) AS max_concurrent,
  (SELECT countIf(tok > ${BURST_TOKENS_PER_MIN}) FROM mins) AS burst_mins,
  (SELECT big_reads FROM reads) AS big_reads,
  (SELECT total_reads FROM reads) AS total_reads,
  (SELECT hard_stops FROM stops) AS hard_stops`;
}

/**
 * 순수 함수. 실측치를 사람이 읽을 조언으로 바꾼다.
 *
 * 각 항목은 근거(evidence)와 행동(action)을 함께 들고 있어야 한다. 임계값을 못 넘으면
 * 아무 말도 하지 않는다 — 없는 문제를 만들지 않는 게 이 함수의 계약이다.
 */
export function buildCoaching(facts, { days = 7, maxTips = MAX_TIPS } = {}) {
  if (!facts) return null;

  const reqs = num(facts.reqs);
  if (!reqs) return null;

  const tips = [];

  // 하드 스톱은 본인이 고칠 수 없다 — 관리자 몫이라는 걸 알려주는 게 도움이다.
  if (num(facts.hard_stops) > 0) {
    tips.push({
      id: "hard-stop",
      headline: "사용 한도에 걸려 멈춘 적이 있습니다",
      evidence: `${days}일간 ${num(facts.hard_stops)}번. 이건 재시도가 안 되는 종류입니다.`,
      action: "본인 습관 문제가 아닙니다. 조직 사용 한도를 올려야 하니 관리자에게 알려주세요."
    });
  }

  // 큰 창을 오래 비운 뒤 깨우면 컨텍스트가 통째로 다시 처리된다(캐시 수명 1시간).
  if (num(facts.cold_resumes) >= 3) {
    tips.push({
      id: "cold-resume",
      headline: "오래 비운 큰 창을 다시 깨우고 있습니다",
      evidence: `${days}일간 ${num(facts.cold_resumes)}번. 그때마다 약 ${k(facts.cold_resume_ktok)}천 토큰을 처음부터 다시 읽었습니다.`,
      action: "한 시간 넘게 비웠으면 첫 마디 전에 /compact 하세요. 그 창의 일이 끝났으면 /clear 가 더 쌉니다(공짜입니다)."
    });
  }

  // 한 번 들어온 파일은 그 세션 끝까지 매 요청에 따라다닌다.
  if (num(facts.big_reads) >= 10) {
    tips.push({
      id: "big-reads",
      headline: "큰 파일을 통째로 읽고 있습니다",
      evidence: `${days}일간 3만 토큰이 넘는 파일 읽기 ${num(facts.big_reads)}번(전체 읽기 ${num(facts.total_reads)}번 중).`,
      action: "한 번 읽으면 그 세션이 끝날 때까지 매번 다시 읽힙니다. 필요한 줄만 읽거나, 서브에이전트에 맡겨 결론만 받으세요."
    });
  }

  // 강도는 매번 고르는 게 아니라 기본값으로 굳는 경우가 많다.
  const highPct = Math.round((100 * num(facts.high_effort_reqs)) / reqs);
  if (highPct >= 40) {
    tips.push({
      id: "effort",
      headline: "추론 강도가 거의 항상 최대로 올라가 있습니다",
      evidence: `요청의 ${highPct}%가 xhigh 또는 max입니다.`,
      action: "기본을 high 로 두고 어려운 판단에만 /effort 로 올리면 답도 빨라집니다. 쉬운 일에는 연습장을 다 채울 필요가 없습니다."
    });
  }

  // fable 은 opus 대비 단가가 2배다. 골라 쓰는 건 정당하지만 기본값이면 아니다.
  const premiumPct = Math.round((100 * num(facts.premium_reqs)) / reqs);
  if (premiumPct >= 20) {
    tips.push({
      id: "premium-model",
      headline: "가장 비싼 모델이 기본값처럼 쓰이고 있습니다",
      evidence: `요청의 ${premiumPct}%가 fable-5 입니다.`,
      action: "어려운 설계 판단에는 그대로 쓰시고, 자동 실행이나 일상 작업은 opus-5 로 내려보세요."
    });
  }

  // 한도는 총량이 아니라 분당으로 걸린다.
  if (num(facts.burst_mins) >= 60) {
    tips.push({
      id: "burst",
      headline: "한꺼번에 몰아서 쓰는 구간이 있습니다",
      evidence: `분당 500만 토큰을 넘긴 시간이 ${days}일간 ${num(facts.burst_mins)}분, 동시에 최대 ${num(facts.max_concurrent)}개 창이 돌았습니다.`,
      action: "한도는 분당으로 걸립니다. 총량보다 동시에 몇 개를 돌리는지가 더 크게 작용합니다."
    });
  }

  return {
    window: { days },
    facts: {
      reqs,
      sessions: num(facts.sessions),
      avgContextK: k(facts.avg_ctx),
      maxContextK: k(facts.max_ctx),
      maxConcurrent: num(facts.max_concurrent)
    },
    tips: tips.slice(0, maxTips),
    // 조언이 하나도 없으면 그 사실 자체가 결과다. 페이지가 "이상 없음"을 보여줄 수 있게.
    clean: tips.length === 0
  };
}

/**
 * 한 유저의 코칭을 만든다. 실패하면 null — 호출자는 이 절을 그리지 않는다.
 * emails 를 직접 주면 config 조회를 건너뛴다(테스트용).
 */
export async function buildUsageCoaching({ userId, days = 7, emails = null, fetchImpl = fetch } = {}) {
  try {
    const list = emails ?? zeudeEmailsOf(await loadConfig({ userId }));
    if (!list?.length) return null;
    const rows = await queryClickHouse(factsQuery(days, list), fetchImpl);
    return buildCoaching(rows[0], { days });
  } catch {
    return null;
  }
}
