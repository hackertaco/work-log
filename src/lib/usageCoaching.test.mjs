import assert from "node:assert/strict";
import test from "node:test";

import { buildCoaching } from "./usageCoaching.mjs";

const facts = (over = {}) => ({
  reqs: 1000,
  avg_ctx: 200000,
  max_ctx: 400000,
  sessions: 20,
  cold_resumes: 0,
  cold_resume_ktok: 0,
  high_effort_reqs: 0,
  premium_reqs: 0,
  max_concurrent: 2,
  burst_mins: 0,
  big_reads: 0,
  total_reads: 50,
  hard_stops: 0,
  ...over
});

test("문제가 없으면 조언을 만들지 않는다 — 없는 문제를 지어내지 않는다", () => {
  const c = buildCoaching(facts());
  assert.deepEqual(c.tips, []);
  assert.equal(c.clean, true);
});

test("요청이 아예 없으면 null — 페이지가 절을 안 그린다", () => {
  assert.equal(buildCoaching(facts({ reqs: 0 })), null);
  assert.equal(buildCoaching(null), null);
});

test("임계값 바로 아래면 침묵한다", () => {
  const c = buildCoaching(facts({ cold_resumes: 2, big_reads: 9, burst_mins: 59 }));
  assert.deepEqual(c.tips, []);
});

test("사용 한도로 멈춘 건 본인 탓이 아니라고 말한다", () => {
  const c = buildCoaching(facts({ hard_stops: 3 }));
  const tip = c.tips.find((t) => t.id === "hard-stop");
  assert.ok(tip);
  assert.match(tip.action, /관리자/);
  assert.match(tip.action, /습관 문제가 아닙니다/);
});

test("찬 창 재개는 횟수와 다시 읽은 양을 함께 보여준다", () => {
  const c = buildCoaching(facts({ cold_resumes: 5, cold_resume_ktok: 354000 }), { days: 7 });
  const tip = c.tips.find((t) => t.id === "cold-resume");
  assert.match(tip.evidence, /5번/);
  assert.match(tip.evidence, /354천/);
  assert.match(tip.action, /\/compact/);
});

test("강도·모델은 비중으로 판단한다 — 절대 건수가 아니라", () => {
  const low = buildCoaching(facts({ reqs: 1000, high_effort_reqs: 300, premium_reqs: 150 }));
  assert.deepEqual(low.tips, []); // 30%, 15% — 둘 다 임계 아래

  const high = buildCoaching(facts({ reqs: 1000, high_effort_reqs: 760, premium_reqs: 200 }));
  const ids = high.tips.map((t) => t.id);
  assert.ok(ids.includes("effort"));
  assert.ok(ids.includes("premium-model"));
  assert.match(high.tips.find((t) => t.id === "effort").evidence, /76%/);
});

test("조언은 최대 3개까지만 — 다 나열하면 안 읽힌다", () => {
  const c = buildCoaching(facts({
    hard_stops: 1, cold_resumes: 10, big_reads: 50,
    high_effort_reqs: 900, premium_reqs: 500, burst_mins: 200
  }));
  assert.equal(c.tips.length, 3);
  // 본인이 못 고치는 것(하드 스톱)을 먼저 알려준다
  assert.equal(c.tips[0].id, "hard-stop");
});

test("다른 사람 숫자나 순위는 절대 넣지 않는다", () => {
  // 코칭이 감시로 읽히는 순간 사람들이 화면을 닫는다. 비교를 뜻하는 표현만 정확히 막는다
  // ("최대"처럼 다이얼 위치를 가리키는 말은 비교가 아니라서 허용한다).
  const c = buildCoaching(facts({ cold_resumes: 5, high_effort_reqs: 800, burst_mins: 100 }));
  const text = JSON.stringify(c);
  for (const banned of ["팀 ", "팀에서", "평균", "다른 사람", "비교", "1위", "2위", "순위", "가장 많"]) {
    assert.ok(!text.includes(banned), `"${banned}" 가 코칭에 들어가면 감시로 읽힌다`);
  }
});
