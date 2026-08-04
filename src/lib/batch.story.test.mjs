import assert from "node:assert/strict";
import test from "node:test";

import { deriveStoryThreadsFromProjects } from "./batch.mjs";

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
