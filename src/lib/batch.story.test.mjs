import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStoryProjectInputs,
  buildSummary,
  deriveStoryThreadsFromProjects,
  mergeGeneratedStories
} from "./batch.mjs";

const project = (repo, category, subjects) => ({
  repo,
  category,
  commitCount: subjects.length,
  commits: subjects.map((subject) => ({ subject }))
});

test("커밋이 없고 프롬프트만 있는 레포도 스토리 카드가 된다", () => {
  // 2026-08-03 실측: 커밋 2건 · 프롬프트 91건. 커밋만 세면 그날이 통째로 빈손이 된다.
  const threads = deriveStoryThreadsFromProjects(
    { company: [project("work-log", "company", ["fix: guard topTools"])], opensource: [] },
    [],
    new Map([["driving-teacher-frontend", ["왜 이 화면이 이렇게 나와?", "이거 고쳐줘"]]])
  );

  const repos = threads.map((t) => t.repo);
  assert.ok(repos.includes("work-log"));
  assert.ok(repos.includes("driving-teacher-frontend"), "프롬프트만 있는 레포도 잡혀야 한다");
});

test("작업 경로를 모르는 unknown 묶음은 스토리가 되지 않는다", () => {
  const threads = deriveStoryThreadsFromProjects(
    { company: [], opensource: [] },
    [],
    new Map([["unknown", ["폴더 없는 프롬프트", "또 하나"]]])
  );

  assert.deepEqual(threads, []);
});

test("지어내지 않는다 — 커밋 제목을 그대로 쓰고 모르는 칸은 비운다", () => {
  const threads = deriveStoryThreadsFromProjects(
    { company: [project("work-log", "company", ["fix: stop paraphrasing quotes"])], opensource: [] },
    []
  );

  // 제목으로 쓰이므로 conventional-commit 접두사(fix:)는 떼고 문장만 남긴다
  assert.equal(threads[0].outcome, "stop paraphrasing quotes");
  // 예전에는 여기 "주요 기능 흐름의 오류 가능성을 줄임" 같은 상수가 박혀 있었다.
  assert.equal(threads[0].impact, "");
  assert.equal(threads[0].why, "");
});

test("회사 레포가 오픈소스보다, 커밋 많은 쪽이 먼저 온다", () => {
  const threads = deriveStoryThreadsFromProjects(
    {
      company: [project("small", "company", ["a"]), project("big", "company", ["a", "b", "c"])],
      opensource: [project("oss", "opensource", ["a", "b", "c", "d"])]
    },
    []
  );

  assert.deepEqual(threads.map((t) => t.repo), ["big", "small", "oss"]);
});

test("단일 일일 요약 응답의 스토리를 사실 기반 폴백에 합친다", () => {
  const fallback = [
    { repo: "work-log", outcome: "fallback", keyChange: "", impact: "", why: "", decision: "근거" },
    { repo: "other", outcome: "other fallback", keyChange: "", impact: "", why: "" }
  ];

  const merged = mergeGeneratedStories(fallback, [
    {
      repo: "work-log",
      outcome: "비용 중복 호출 제거",
      keyChange: "요약과 스토리 통합",
      impact: "호출 수 절반",
      why: "예산 상한 보장"
    },
    { repo: "unknown", outcome: "끼어들면 안 됨", keyChange: "", impact: "", why: "" }
  ]);

  assert.equal(merged[0].outcome, "비용 중복 호출 제거");
  assert.equal(merged[0].decision, "근거", "결정 근거는 deterministic 결과에서 보존한다");
  assert.equal(merged[1].outcome, "other fallback");
  assert.equal(merged.length, 2, "입력에 없던 레포를 모델이 추가할 수 없다");
});

test("통합 요약 호출은 프로젝트별 프롬프트를 최대 20개만 전달한다", () => {
  const prompts = Array.from({ length: 25 }, (_, index) => `prompt-${index + 1}`);
  const inputs = buildStoryProjectInputs({
    categorizedProjects: {
      company: [project("work-log", "company", ["fix: cap prompt evidence"])],
      opensource: []
    },
    dayPrompts: prompts.map((text) => ({ text, projectPath: "/company-code/work-log" }))
  });

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].prompts.length, 20);
  assert.deepEqual(inputs[0].prompts, prompts.slice(0, 20));
});

test("allowLlm=false이면 프록시 설정이 있어도 네트워크를 호출하지 않는다", async () => {
  const saved = {
    url: process.env.WORK_LOG_LLM_URL,
    token: process.env.WORK_LOG_LLM_BEARER_TOKEN,
    fetch: global.fetch
  };
  process.env.WORK_LOG_LLM_URL = "https://proxy.example.test/v1";
  process.env.WORK_LOG_LLM_BEARER_TOKEN = "test-token";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };

  try {
    const summary = await buildSummary({
      date: "2026-08-10",
      codexSessions: [],
      claudeSessions: [],
      slackContexts: [],
      gitCommits: [],
      gitWorkingTree: [],
      shellHistory: [],
      prBranchSignals: { projectWeights: {}, mentions: [] },
      dayPrompts: [],
      allowLlm: false
    });
    assert.equal(calls, 0);
    assert.equal(summary.summarization.provider, "heuristic");
  } finally {
    global.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.WORK_LOG_LLM_URL;
    else process.env.WORK_LOG_LLM_URL = saved.url;
    if (saved.token === undefined) delete process.env.WORK_LOG_LLM_BEARER_TOKEN;
    else process.env.WORK_LOG_LLM_BEARER_TOKEN = saved.token;
  }
});
