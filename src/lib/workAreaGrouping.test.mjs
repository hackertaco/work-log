import assert from "node:assert/strict";
import test from "node:test";

import { groupWorkAreas, areaKey } from "./workAreaGrouping.mjs";

test("areaKey resolves the project root, not the working subdir", () => {
  // company-code/opensource 마커 다음 세그먼트 = 진짜 레포
  assert.equal(areaKey("/Users/x/Documents/company-code/driving-teacher-knowledge-base/graph-v2"), "driving-teacher-knowledge-base");
  assert.equal(areaKey("/Users/x/Documents/company-code/driving-teacher-knowledge-base/raw/notion_sync"), "driving-teacher-knowledge-base");
  assert.equal(areaKey("/Users/x/Documents/opensource/kakao-novel-generator/web/output/emotion-arc-15u-llm"), "kakao-novel-generator");
  // Codex/<날짜>/<프로젝트>
  assert.equal(areaKey("/Users/x/Documents/Codex/2026-07-12/koreans-love-stock-with-tests-md/work"), "koreans-love-stock-with-tests-md");
  assert.equal(areaKey("/Users/x/Documents/Codex/2026-07-07/pdf-plugin/outputs/deck"), "pdf-plugin");
  // 마커 없으면 마지막 세그먼트, 파일이면 상위 폴더
  assert.equal(areaKey("/Users/x/Documents/study"), "study");
  assert.equal(areaKey("/Users/x/proj/README.md"), "proj");
  assert.equal(areaKey(""), "unknown");
});

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
