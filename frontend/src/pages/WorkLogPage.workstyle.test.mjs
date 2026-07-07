import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, "WorkLogPage.jsx"), "utf8");

test("renders workstyle principles as the hero from workStyleAnalysis", () => {
  assert.ok(source.includes("workStyleAnalysis"), "reads workStyleAnalysis from profile");
  assert.ok(source.includes("principles"), "reads synthesized principles");
  assert.ok(source.includes("내가 일할 때 반복하는 판단 기준"), "principle section title present");
  assert.ok(source.includes("worklog-principle-title"), "renders principle titles");
});

test("keeps per-area judgments as collapsible supporting evidence", () => {
  assert.ok(source.includes("영역별 근거 보기"), "area cards demoted behind an evidence toggle");
  assert.ok(source.includes("꺼낸 판단"), "still renders per-area judgments as evidence");
});

test("keeps keyword workStyle as fallback when no analysis", () => {
  assert.ok(source.includes("이력서에 남는 작업 방식"), "fallback keyword section retained");
});
