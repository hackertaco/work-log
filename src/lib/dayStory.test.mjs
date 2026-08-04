import assert from "node:assert/strict";
import test from "node:test";

import { buildDayStoryPayload, groupPromptsByRepo, summarizeDayStories } from "./dayStory.mjs";
import { areaKey } from "./workAreaGrouping.mjs";

const PROJECTS = [
  { repo: "work-log", commits: ["fix: guard null topTools"], prompts: ["이거 왜 안 붙어?"] }
];

test("groupPromptsByRepo: 경로로 레포를 갈라 담는다", () => {
  const map = groupPromptsByRepo(
    [
      { text: "work-log 관련 질문입니다", projectPath: "/Users/x/company-code/work-log" },
      { text: "하위 폴더에서 물어본 것", projectPath: "/Users/x/company-code/work-log/src" },
      { text: "kb 질문", projectPath: "/Users/x/company-code/knowledge-base" },
      { text: "", projectPath: "/Users/x/company-code/work-log" }
    ],
    areaKey
  );

  assert.deepEqual(map.get("work-log"), ["work-log 관련 질문입니다", "하위 폴더에서 물어본 것"]);
  assert.deepEqual(map.get("knowledge-base"), ["kb 질문"]);
});

test("groupPromptsByRepo: 입력이 이상해도 던지지 않는다", () => {
  assert.equal(groupPromptsByRepo(null, areaKey).size, 0);
  assert.equal(groupPromptsByRepo([{}], areaKey).size, 0);
});

test("buildDayStoryPayload: 그날에만 참인 문장을 요구하고 무난한 표현을 금지한다", () => {
  const payload = buildDayStoryPayload("2026-08-04", PROJECTS);
  const instruction = payload.input[0].content;

  // 이 판정 기준이 빠지면 모델이 일반론으로 도망간다 — 이 프롬프트의 핵심이다
  assert.ok(instruction.includes("그날 그 프로젝트에만 참인 문장"));
  // 실제로 프로필을 망쳤던 문구를 이름 대고 막는다
  assert.ok(instruction.includes("핵심 흐름을 정리하고 개선함"));
  assert.ok(instruction.includes("오류 가능성을 줄임"));
  // 근거 없으면 지어내지 말고 비우라는 지시
  assert.ok(instruction.includes("빈 문자열"));

  // 커밋과 프롬프트가 둘 다 모델에 전달돼야 "무엇을"과 "왜"가 이어진다
  const body = payload.input[1].content;
  assert.ok(body.includes("fix: guard null topTools"));
  assert.ok(body.includes("이거 왜 안 붙어?"));

  assert.equal(payload.max_output_tokens, 3000);
  assert.equal(payload.text.format.name, "day_stories");
});

test("summarizeDayStories: 키가 없으면 조회 없이 빈 배열", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await summarizeDayStories({
    date: "2026-08-04",
    projects: PROJECTS,
    fetchImpl: () => { throw new Error("should not fetch"); }
  });
  assert.deepEqual(r, []);
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});

test("summarizeDayStories: 커밋도 프롬프트도 없는 프로젝트는 아예 안 보낸다", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const r = await summarizeDayStories({
    date: "2026-08-04",
    projects: [{ repo: "empty", commits: [], prompts: [] }],
    fetchImpl: () => { throw new Error("should not fetch"); }
  });
  assert.deepEqual(r, []);
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

test("summarizeDayStories: 응답을 파싱하고 제목 없는 항목은 버린다", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";

  const fetchImpl = async () => new Response(JSON.stringify({
    output_text: JSON.stringify({
      stories: [
        { repo: "work-log", outcome: "중복 클러스터로 막힌 KB CI를 우회해 머지함", keyChange: "검증 스킵", impact: "", why: "" },
        { repo: "nope", outcome: "  ", keyChange: "x", impact: "", why: "" }
      ]
    })
  }), { status: 200 });

  const r = await summarizeDayStories({ date: "2026-08-04", projects: PROJECTS, fetchImpl });

  assert.equal(r.length, 1, "제목 없는 항목은 카드로 못 쓴다");
  assert.equal(r[0].repo, "work-log");
  assert.equal(r[0].outcome, "중복 클러스터로 막힌 KB CI를 우회해 머지함");
  // 근거 없는 칸은 비어서 온다 — 화면이 감춘다
  assert.equal(r[0].impact, "");

  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

test("summarizeDayStories: LLM 오류는 비치명적", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const r = await summarizeDayStories({
    date: "2026-08-04",
    projects: PROJECTS,
    fetchImpl: async () => new Response("boom", { status: 500 })
  });
  assert.deepEqual(r, []);
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});
