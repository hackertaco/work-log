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
