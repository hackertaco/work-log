/**
 * 팀 토큰 사용 감사 — "누가 잘못 쓰는가"가 아니라 "어떤 설정·습관이 값을 부르는가"를 찾는다.
 *
 * 2026-08-04 조사에서 손으로 돌린 검사들을 그대로 코드로 옮긴 것이다. 그때 확인된 것:
 *   - 낭비 지표(빈 응답·부가기능·캐시 재사용)는 팀 전원이 고른 범위였다 → 사람 문제가 아니었다
 *   - 값을 부른 것은 (1) 추론 강도·모델 같은 "다이얼" (2) 격리 없는 병렬의 조율 비용
 *   - 실제로 사람을 멈춘 것은 429(0.16%)가 아니라 조직 사용 한도(400) 18건이었다
 * 그래서 이 감사는 다이얼과 하드 스톱을 먼저 보고, 낭비 지표는 "이상 없음"을 확인하는 데 쓴다.
 *
 * 사람 식별은 ResourceAttributes['zeude.user.email'] 을 쓴다. LogAttributes['user.email'] 은
 * Anthropic 계정 이메일이라 공용 계정을 쓰면 여러 사람이 한 이름으로 뭉친다(zeude migration 017).
 *
 * 크리덴셜은 환경변수로만 받는다. 절대 저장소에 쓰지 않는다.
 */

/** 이 강도들은 요청당 출력·비용이 눈에 띄게 커진다. high 로 내리는 것이 첫 후보. */
const HIGH_EFFORTS = ["xhigh", "max"];
/** opus 대비 단가가 2배인 모델. 같은 일이면 opus-5 가 후보. */
const PREMIUM_MODEL = "claude-fable-5";
const BASELINE_MODEL = "claude-opus-5";
/** 캐시를 이만큼 새로 쓰고서 이만큼도 못 읽었으면 "만들어놓고 버린" 것으로 본다. */
const CACHE_WRITE_FLOOR = 200_000;
const CACHE_READ_CEIL = 50_000;
/** 컨텍스트가 이 선을 넘으면 요청 하나가 그만큼을 매번 다시 읽는다. */
const CONTEXT_ALARM = 600_000;

export function emptyAudit() {
  return { people: [], findings: [], plugins: null, meta: { days: 0, error: null } };
}

/**
 * 이 기기의 플러그인 설정과 실측 사용량을 맞대본다.
 *
 * 두 방향을 다 본다 — 어느 한쪽만 보면 사람이 손해를 본다:
 *   (1) 켜져 있는데 안 쓰는 것 → 매 세션 컨텍스트만 먹는다
 *   (2) **꺼둔 것** → 끈 걸 잊고 필요할 때 안 켜는 걸 막는다
 *
 * 플러그인 설정은 기기별이라 팀 전체가 아니라 "이 기기 = 이 사람"에만 유효하다.
 * loadedOnly 는 plugin_loaded 이벤트만 있고 skill_activated/api_request 가 없는 것 —
 * 즉 세션마다 올라오지만 한 번도 불려본 적 없는 플러그인이다.
 */
export function crossCheckPlugins({ enabledPlugins, usage, ownerEmail }) {
  if (!enabledPlugins) return null;

  const usedNames = new Map();
  for (const row of usage ?? []) {
    const name = row.plugin;
    if (!name) continue;
    usedNames.set(name, num(row.actually_used));
  }

  const enabled = [];
  const disabled = [];
  for (const [key, on] of Object.entries(enabledPlugins)) {
    // "ralph-loop@claude-plugins-official" → "ralph-loop"
    const short = String(key).split("@")[0];
    (on ? enabled : disabled).push({ key, name: short, used: usedNames.get(short) ?? 0 });
  }

  return {
    ownerEmail: ownerEmail ?? null,
    // 켜져 있는데 실사용 0. 필요해지면 다시 켜면 되니 끄는 쪽이 이득.
    enabledUnused: enabled.filter((p) => p.used === 0).map((p) => p.name).sort(),
    enabledUsed: enabled.filter((p) => p.used > 0).sort((a, b) => b.used - a.used),
    // 꺼둔 것. 잊지 않도록 매번 그대로 보여준다.
    disabled: disabled.map((p) => p.name).sort()
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** ClickHouse HTTP 조회. behaviorSignals.mjs 와 같은 방식. */
async function queryClickHouse(query, fetchImpl) {
  const url = process.env.CLICKHOUSE_URL;
  const user = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;
  if (!url || !user) throw new Error("CLICKHOUSE_URL/USER 가 없다");

  const res = await fetchImpl(`${url.replace(/\/$/, "")}/?default_format=JSON`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password ?? ""}`).toString("base64")}` },
    body: query
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).data ?? [];
}

const PERSON = `ResourceAttributes['zeude.user.email']`;
const CTX = `(toFloat64OrZero(LogAttributes['input_tokens'])+toFloat64OrZero(LogAttributes['cache_read_tokens'])+toFloat64OrZero(LogAttributes['cache_creation_tokens']))`;
const USD = `toFloat64OrZero(LogAttributes['cost_usd'])`;

/** 사람별 기본 지표 + 낭비 지표. 한 번에 훑는다. */
function baseQuery(days) {
  return `
SELECT ${PERSON} AS person,
  count() AS reqs,
  sum(${CTX}) AS tokens,
  sum(${USD}) AS usd,
  avg(${CTX}) AS avg_ctx,
  quantile(0.95)(${CTX}) AS p95_ctx,
  sumIf(${USD}, toFloat64OrZero(LogAttributes['cache_creation_tokens']) > ${CACHE_WRITE_FLOOR}
     AND toFloat64OrZero(LogAttributes['cache_read_tokens']) < ${CACHE_READ_CEIL}) AS discarded_cache_usd,
  countIf(toFloat64OrZero(LogAttributes['output_tokens']) < 100 AND ${CTX} > 200000) AS empty_reqs,
  sum(toFloat64OrZero(LogAttributes['cache_read_tokens']))
    / nullIf(sum(toFloat64OrZero(LogAttributes['cache_creation_tokens'])),0) AS cache_reuse,
  countIf(${CTX} > ${CONTEXT_ALARM}) AS huge_ctx_reqs
FROM claude_code_logs
WHERE Timestamp >= now() - INTERVAL ${days} DAY
  AND LogAttributes['event.name'] = 'api_request' AND ${PERSON} != ''
GROUP BY person`;
}

/** 다이얼: 강도별·모델별 요청당 실단가. 내렸을 때 절감을 여기서 계산한다. */
function dialQuery(days) {
  return `
SELECT ${PERSON} AS person,
  LogAttributes['model'] AS model,
  LogAttributes['effort'] AS effort,
  count() AS reqs,
  avg(${USD}) AS avg_usd,
  avg(toFloat64OrZero(LogAttributes['output_tokens'])) AS avg_output
FROM claude_code_logs
WHERE Timestamp >= now() - INTERVAL ${days} DAY
  AND LogAttributes['event.name'] = 'api_request' AND ${PERSON} != ''
GROUP BY person, model, effort`;
}

/** 한도: 재시도로 넘어가는 429 와, 사람을 실제로 멈추는 사용한도(400)를 구분한다. */
function limitQuery(days) {
  return `
SELECT ${PERSON} AS person,
  multiIf(LogAttributes['status_code'] = '429', 'rate_limit',
          position(LogAttributes['error'], 'usage limits') > 0, 'hard_stop',
          LogAttributes['status_code'] = '529', 'overloaded', 'other') AS kind,
  count() AS c
FROM claude_code_logs
WHERE Timestamp >= now() - INTERVAL ${days} DAY AND LogAttributes['event.name'] = 'api_error' AND ${PERSON} != ''
GROUP BY person, kind`;
}

/** 순간 몰림: 한도는 분당으로 걸린다. 총량보다 이 값이 중요하다. */
function burstQuery(days) {
  return `
SELECT person, max(conc) AS max_concurrent, max(tok) AS peak_tokens_per_min,
  countIf(tok > 5000000) AS mins_over_5m
FROM (
  SELECT ${PERSON} AS person, toStartOfMinute(Timestamp) AS mn,
    uniqExact(LogAttributes['session.id']) AS conc, sum(${CTX}) AS tok
  FROM claude_code_logs
  WHERE Timestamp >= now() - INTERVAL ${days} DAY
    AND LogAttributes['event.name'] = 'api_request' AND ${PERSON} != ''
  GROUP BY person, mn
) GROUP BY person`;
}

/** 세션에 모델을 섞으면 모델마다 캐시를 새로 만들어야 한다. */
function modelMixQuery(days) {
  return `
SELECT person, avg(n) AS avg_models_per_session, countIf(n >= 3) AS sessions_3plus
FROM (
  SELECT ${PERSON} AS person, LogAttributes['session.id'] AS sid, uniqExact(LogAttributes['model']) AS n
  FROM claude_code_logs
  WHERE Timestamp >= now() - INTERVAL ${days} DAY
    AND LogAttributes['event.name'] = 'api_request' AND ${PERSON} != ''
  GROUP BY person, sid
) GROUP BY person`;
}

/** zeude 키가 없는 기기는 계정 이메일로만 잡힌다(user_id 가 64자 hex). 추적 구멍. */
function unkeyedQuery(days) {
  return `
SELECT LogAttributes['user.email'] AS account, count() AS reqs, sum(${CTX}) AS tokens
FROM claude_code_logs
WHERE Timestamp >= now() - INTERVAL ${days} DAY AND LogAttributes['event.name'] = 'api_request'
  AND ${PERSON} = '' AND LogAttributes['zeude.user.email'] = ''
GROUP BY account`;
}

/**
 * 조율 비용. **건수가 아니라 글자 양으로 재야 한다.**
 *
 * 2026-08-04 에 한 번 틀렸다: 건수로 보면 기계가 넣은 알림·쪽지가 43%로 보여서
 * "워크트리로 폴더를 격리하라"고 권했는데, 양으로 재니 기계 잡음은 7.5%였고
 * 값의 90%는 **사람이 쓴 인계 문서**(494건 × 평균 3만 3천 토큰)였다.
 * 워크트리는 파일 충돌을 막는 도구라 인계 문서를 줄이지 못한다 — 오히려 폴더가
 * 갈리면 서로를 더 몰라 인계가 늘 수도 있다. 실제 지렛대는 세션 수다(인계할 짝이
 * 세션 수의 제곱으로 늘어난다: 5개=10쌍, 2개=1쌍).
 */
function coordinationQuery(days) {
  return `
SELECT lower(user_email) AS email,
  count() AS prompts,
  sum(length(prompt_text)) AS total_chars,
  sumIf(length(prompt_text), prompt_text LIKE '%핸드오프%' OR prompt_text LIKE '%handoff-%') AS handoff_chars,
  countIf(prompt_text LIKE '%핸드오프%' OR prompt_text LIKE '%handoff-%') AS handoff_prompts,
  sumIf(length(prompt_text), prompt_text LIKE '%<task-notification>%' OR prompt_text LIKE '%<agent-message%'
      OR prompt_text LIKE '%Monitor event%' OR prompt_text LIKE 'The following is the Codex%'
      OR prompt_text LIKE 'Automation:%') AS machine_chars
FROM ai_prompts
WHERE timestamp >= now() - INTERVAL ${days} DAY
GROUP BY email HAVING prompts > 50`;
}

/**
 * 다이얼을 내렸을 때의 절감을 추정한다. 같은 사람·같은 모델 안에서만 비교한다 —
 * 모델이 다르면 단가가 달라 비교가 무의미하다.
 */
export function estimateDialSavings(dialRows) {
  const byPerson = new Map();
  const key = (p, m) => `${p} ${m}`;
  const cell = new Map();

  for (const r of dialRows) {
    cell.set(key(r.person, r.model) + " " + (r.effort || ""), {
      reqs: num(r.reqs),
      avgUsd: num(r.avg_usd),
      avgOutput: num(r.avg_output)
    });
  }

  for (const r of dialRows) {
    const person = r.person;
    if (!byPerson.has(person)) {
      byPerson.set(person, { effortSavings: 0, effortReqs: 0, premiumSavings: 0, premiumReqs: 0, highEffortReqs: 0, totalReqs: 0 });
    }
    const acc = byPerson.get(person);
    acc.totalReqs += num(r.reqs);

    // 강도 내리기: 같은 모델의 high 단가와 비교
    if (HIGH_EFFORTS.includes(r.effort)) {
      acc.highEffortReqs += num(r.reqs);
      const high = cell.get(key(person, r.model) + " high");
      if (high && high.avgUsd > 0) {
        const delta = num(r.avg_usd) - high.avgUsd;
        if (delta > 0) {
          acc.effortSavings += delta * num(r.reqs);
          acc.effortReqs += num(r.reqs);
        }
      }
    }
  }

  // 프리미엄 모델 → 기준 모델: 같은 사람의 두 모델 요청당 단가 차이
  for (const person of byPerson.keys()) {
    let premReqs = 0, premUsd = 0, baseReqs = 0, baseUsd = 0;
    for (const r of dialRows) {
      if (r.person !== person) continue;
      if (r.model === PREMIUM_MODEL) { premReqs += num(r.reqs); premUsd += num(r.avg_usd) * num(r.reqs); }
      if (r.model === BASELINE_MODEL) { baseReqs += num(r.reqs); baseUsd += num(r.avg_usd) * num(r.reqs); }
    }
    if (premReqs > 0 && baseReqs > 0) {
      const delta = premUsd / premReqs - baseUsd / baseReqs;
      if (delta > 0) {
        const acc = byPerson.get(person);
        acc.premiumSavings = delta * premReqs;
        acc.premiumReqs = premReqs;
      }
    }
  }
  return byPerson;
}

/**
 * 순수 채점. 사람별 지표를 받아 조치 후보 목록을 만든다.
 * 각 항목은 근거 수치를 그대로 들고 있어야 한다 — 숫자 없는 권고는 넣지 않는다.
 */
export function scoreUsage({ base, dials, limits, bursts, mixes, coordination, unkeyed }) {
  const savings = estimateDialSavings(dials ?? []);
  const people = [];
  const findings = [];

  const limitOf = (person, kind) =>
    num((limits ?? []).find((r) => r.person === person && r.kind === kind)?.c);
  const burstOf = (person) => (bursts ?? []).find((r) => r.person === person) ?? {};
  const mixOf = (person) => (mixes ?? []).find((r) => r.person === person) ?? {};
  const coordOf = (person) => {
    // 이메일이 갈릴 수 있다(gmail/회사). 앞부분이 같으면 같은 사람으로 본다.
    const local = String(person).split("@")[0].toLowerCase();
    const rows = (coordination ?? []).filter((r) => String(r.email).split("@")[0].toLowerCase() === local);
    const prompts = rows.reduce((s, r) => s + num(r.prompts), 0);
    const totalChars = rows.reduce((s, r) => s + num(r.total_chars), 0);
    const handoffChars = rows.reduce((s, r) => s + num(r.handoff_chars), 0);
    const handoffPrompts = rows.reduce((s, r) => s + num(r.handoff_prompts), 0);
    const machineChars = rows.reduce((s, r) => s + num(r.machine_chars), 0);
    return {
      prompts,
      handoffPrompts,
      // 양 기준 비중. 건수 기준으로 보면 결론이 뒤집힌다 — 위 coordinationQuery 주석 참고.
      handoffPct: totalChars ? (100 * handoffChars) / totalChars : 0,
      machinePct: totalChars ? (100 * machineChars) / totalChars : 0,
      handoffAvgKtok: handoffPrompts ? handoffChars / 4 / 1000 / handoffPrompts : 0
    };
  };

  for (const b of base ?? []) {
    const person = b.person;
    const s = savings.get(person) ?? { effortSavings: 0, premiumSavings: 0, highEffortReqs: 0, totalReqs: 0, premiumReqs: 0 };
    const burst = burstOf(person);
    const mix = mixOf(person);
    const coord = coordOf(person);
    const usd = num(b.usd);

    people.push({
      person,
      reqs: num(b.reqs),
      tokensB: round(num(b.tokens) / 1e9, 1),
      usd: Math.round(usd),
      avgContextK: Math.round(num(b.avg_ctx) / 1000),
      p95ContextK: Math.round(num(b.p95_ctx) / 1000),
      cacheReuse: round(num(b.cache_reuse), 1),
      discardedCacheUsd: Math.round(num(b.discarded_cache_usd)),
      emptyReqPct: b.reqs ? round((100 * num(b.empty_reqs)) / num(b.reqs), 1) : 0,
      hugeContextReqs: num(b.huge_ctx_reqs),
      highEffortPct: s.totalReqs ? Math.round((100 * s.highEffortReqs) / s.totalReqs) : 0,
      maxConcurrent: num(burst.max_concurrent),
      peakMtokPerMin: round(num(burst.peak_tokens_per_min) / 1e6, 1),
      minsOver5M: num(burst.mins_over_5m),
      modelsPerSession: round(num(mix.avg_models_per_session), 2),
      handoffPct: round(coord.handoffPct, 1),
      machinePct: round(coord.machinePct, 1),
      rateLimits: limitOf(person, "rate_limit"),
      hardStops: limitOf(person, "hard_stop")
    });

    // --- 조치 후보 ---
    if (s.effortSavings > usd * 0.03 && s.highEffortReqs > 100) {
      findings.push({
        person, kind: "effort-dial", severity: "high",
        savingsUsd: Math.round(s.effortSavings),
        detail: `요청 ${s.highEffortReqs}건이 ${HIGH_EFFORTS.join("/")} 강도. 같은 모델 high 대비 $${Math.round(s.effortSavings)} 더 씀. 설정만 바꾸면 되고 작업 방식은 안 바뀐다.`
      });
    }
    if (s.premiumSavings > usd * 0.03 && s.premiumReqs > 50) {
      findings.push({
        person, kind: "premium-model", severity: "high",
        savingsUsd: Math.round(s.premiumSavings),
        detail: `${PREMIUM_MODEL} ${s.premiumReqs}건. ${BASELINE_MODEL} 대비 $${Math.round(s.premiumSavings)} 더 씀.`
      });
    }
    if (num(b.discarded_cache_usd) > usd * 0.15) {
      findings.push({
        person, kind: "discarded-cache", severity: "medium",
        savingsUsd: Math.round(num(b.discarded_cache_usd)),
        detail: `캐시를 크게 만들고 거의 안 읽은 요청이 $${Math.round(num(b.discarded_cache_usd))}. 한 시간 넘게 비운 세션을 이어가면 컨텍스트가 통째로 다시 써진다.`
      });
    }
    if (coord.handoffPct > 40 && coord.handoffPrompts > 50) {
      const pairs = Math.max(1, num(burst.max_concurrent));
      findings.push({
        person, kind: "handoff-volume", severity: "medium",
        savingsUsd: null,
        detail: `프롬프트 글자 양의 ${round(coord.handoffPct, 0)}%가 세션 간 인계 문서다 — ${coord.handoffPrompts}건, 하나당 평균 ${Math.round(coord.handoffAvgKtok)}k 토큰. `
          + `인계할 짝은 동시 세션 수의 제곱으로 는다(동시 ${pairs}개 = ${(pairs * (pairs - 1)) / 2}쌍). `
          + `세션 수를 줄이는 것이 직접적이다. 워크트리는 파일 충돌을 막는 도구라 인계 문서는 줄이지 못한다.`
      });
    }
    if (num(mix.avg_models_per_session) >= 2.2) {
      findings.push({
        person, kind: "model-mixing", severity: "low",
        savingsUsd: null,
        detail: `세션당 모델 ${round(num(mix.avg_models_per_session), 1)}개. 모델을 바꿀 때마다 캐시를 새로 만든다.`
      });
    }
    if (num(burst.mins_over_5m) > 300) {
      findings.push({
        person, kind: "burst", severity: "medium",
        savingsUsd: null,
        detail: `분당 500만 토큰을 넘긴 시간이 ${num(burst.mins_over_5m)}분, 최고 ${round(num(burst.peak_tokens_per_min) / 1e6, 1)}M/분. 한도는 분당으로 걸린다 — 동시 실행 수를 줄이는 게 직접적이다.`
      });
    }
    if (limitOf(person, "hard_stop") > 0) {
      findings.push({
        person, kind: "hard-stop", severity: "high",
        savingsUsd: null,
        detail: `조직 사용 한도에 걸려 완전히 멈춘 것 ${limitOf(person, "hard_stop")}건. 재시도가 안 된다 — 관리 콘솔에서 한도를 올려야 한다.`
      });
    }
  }

  for (const u of unkeyed ?? []) {
    findings.push({
      person: `(zeude 키 없음) ${u.account}`, kind: "untracked-machine", severity: "medium", savingsUsd: null,
      detail: `요청 ${num(u.reqs)}건 / ${round(num(u.tokens) / 1e9, 2)}B 토큰이 사람에 귀속되지 않는다. 그 기기에 zeude 키를 깔면 잡힌다.`
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => (order[a.severity] - order[b.severity]) || ((b.savingsUsd ?? 0) - (a.savingsUsd ?? 0)));
  people.sort((a, b) => b.usd - a.usd);
  return { people, findings };
}

/** 이 기기가 실제로 쓴 플러그인. plugin_loaded 는 "올라오기만 한 것"이라 따로 센다. */
function pluginUsageQuery(days, email) {
  return `
SELECT LogAttributes['plugin.name'] AS plugin,
  countIf(LogAttributes['event.name'] != 'plugin_loaded') AS actually_used
FROM claude_code_logs
WHERE Timestamp >= now() - INTERVAL ${days} DAY
  AND ${PERSON} = '${email.replace(/'/g, "")}' AND plugin != ''
GROUP BY plugin`;
}

/**
 * 감사 실행. 실패는 비치명적 — 빈 결과에 error 를 담아 돌려준다.
 *
 * settingsPath / ownerEmail 을 주면 이 기기의 플러그인 설정도 함께 맞대본다.
 * 안 주면 플러그인 절은 생략된다(팀 전체 리포트로만 쓸 때).
 */
export async function runUsageAudit({ days = 30, fetchImpl = fetch, settings = null, ownerEmail = null } = {}) {
  try {
    const jobs = [
      queryClickHouse(baseQuery(days), fetchImpl),
      queryClickHouse(dialQuery(days), fetchImpl),
      queryClickHouse(limitQuery(days), fetchImpl),
      queryClickHouse(burstQuery(days), fetchImpl),
      queryClickHouse(modelMixQuery(days), fetchImpl),
      queryClickHouse(coordinationQuery(days), fetchImpl),
      queryClickHouse(unkeyedQuery(days), fetchImpl)
    ];
    if (settings?.enabledPlugins && ownerEmail) {
      jobs.push(queryClickHouse(pluginUsageQuery(days, ownerEmail), fetchImpl));
    }

    const [base, dials, limits, bursts, mixes, coordination, unkeyed, pluginUsage] = await Promise.all(jobs);
    const scored = scoreUsage({ base, dials, limits, bursts, mixes, coordination, unkeyed });
    const plugins = settings?.enabledPlugins
      ? crossCheckPlugins({ enabledPlugins: settings.enabledPlugins, usage: pluginUsage, ownerEmail })
      : null;

    return { ...scored, plugins, meta: { days, error: null } };
  } catch (err) {
    return { ...emptyAudit(), meta: { days, error: String(err?.message ?? err) } };
  }
}
