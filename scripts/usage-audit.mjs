#!/usr/bin/env node
/**
 * 팀 토큰 사용 감사 리포트.
 *
 *   CLICKHOUSE_URL=... CLICKHOUSE_USER=... CLICKHOUSE_PASSWORD=... node scripts/usage-audit.mjs [--days 30] [--json]
 *
 * 크리덴셜은 환경변수로만 받는다. 저장소에 쓰지 않는다.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runUsageAudit } from "../src/lib/usageAudit.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const days = Number(flag("days", 30));
const asJson = argv.includes("--json");

// --me 로 내 이메일을 주면 이 기기의 플러그인 설정도 함께 맞대본다.
// 설정이 없거나 못 읽으면 그 절만 생략한다 — 감사 자체는 계속 돈다.
const ownerEmail = flag("me", process.env.WORK_LOG_ZEUDE_EMAIL ?? null);
let settings = null;
if (ownerEmail) {
  const settingsPath = flag("settings", join(homedir(), ".claude", "settings.json"));
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    console.error(`(설정을 못 읽어 플러그인 점검은 건너뜁니다: ${settingsPath})`);
  }
}

const audit = await runUsageAudit({ days, settings, ownerEmail });

if (asJson) {
  console.log(JSON.stringify(audit, null, 2));
  process.exit(audit.meta.error ? 1 : 0);
}

if (audit.meta.error) {
  console.error(`감사 실패: ${audit.meta.error}`);
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

console.log(`\n=== 사용 감사 (최근 ${days}일) ===\n`);
console.log(
  pad("사람", 30) + rpad("요청", 8) + rpad("B토큰", 8) + rpad("USD", 8) +
  rpad("평균ctx", 9) + rpad("강도↑%", 8) + rpad("동시", 6) + rpad("피크M/분", 10) +
  rpad("인계%", 7) + rpad("429", 6) + rpad("정지", 6)
);
for (const p of audit.people) {
  console.log(
    pad(p.person, 30) + rpad(p.reqs, 8) + rpad(p.tokensB, 8) + rpad(p.usd, 8) +
    rpad(p.avgContextK + "k", 9) + rpad(p.highEffortPct, 8) + rpad(p.maxConcurrent, 6) +
    rpad(p.peakMtokPerMin, 10) + rpad(p.handoffPct, 7) + rpad(p.rateLimits, 6) + rpad(p.hardStops, 6)
  );
}
// 인계% = 프롬프트 글자 양 중 세션 간 인계 문서가 차지하는 비중. 건수 기준이 아니다.

console.log(`\n=== 조치 후보 (${audit.findings.length}건) ===\n`);
if (!audit.findings.length) {
  console.log("없음 — 모든 지표가 정상 범위다.\n");
} else {
  const mark = { high: "[높음]", medium: "[중간]", low: "[낮음]" };
  for (const f of audit.findings) {
    const money = f.savingsUsd != null ? ` (절감 추정 $${f.savingsUsd})` : "";
    console.log(`${mark[f.severity]} ${f.person} — ${f.kind}${money}`);
    console.log(`        ${f.detail}\n`);
  }
}

// 플러그인은 기기별 설정이라 --me 를 준 사람에게만 해당한다.
// 꺼둔 목록을 매번 보여주는 게 핵심 — 끈 걸 잊고 필요할 때 안 켜는 걸 막는다.
if (audit.plugins) {
  const p = audit.plugins;
  console.log(`=== 이 기기 플러그인 (${p.ownerEmail}) ===\n`);
  if (p.disabled.length) {
    console.log(`꺼둔 것 ${p.disabled.length}개 — 필요해지면 ~/.claude/settings.json 에서 true 로:`);
    console.log(`  ${p.disabled.join(", ")}\n`);
  }
  if (p.enabledUnused.length) {
    console.log(`켜져 있는데 ${days}일간 실사용 0 — 끄면 세션 시작 컨텍스트가 줄어듭니다:`);
    console.log(`  ${p.enabledUnused.join(", ")}\n`);
  }
  if (p.enabledUsed.length) {
    console.log(`실제로 쓰는 것: ${p.enabledUsed.map((x) => `${x.name}(${x.used})`).join(", ")}\n`);
  }
}

// 낭비 지표는 "이상 없음" 확인용. 튀는 사람이 있을 때만 보여준다.
const oddities = audit.people.filter((p) => p.emptyReqPct > 8 || (p.cacheReuse && p.cacheReuse < 10));
if (oddities.length) {
  console.log("=== 낭비 지표 이상 ===\n");
  for (const p of oddities) {
    console.log(`${p.person}: 빈 응답 ${p.emptyReqPct}% · 캐시 재사용 ${p.cacheReuse}배`);
  }
  console.log("");
} else {
  console.log("낭비 지표(빈 응답·캐시 재사용): 전원 정상 범위.\n");
}
