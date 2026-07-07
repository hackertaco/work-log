import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, "WorkLogPage.jsx"), "utf8");

test("renders workstyle area cards from workStyleAnalysis", () => {
  assert.ok(source.includes("workStyleAnalysis"), "reads workStyleAnalysis from profile");
  assert.ok(source.includes("내가 일한 영역과 그 안의 판단"), "section title present");
  assert.ok(source.includes("꺼낸 판단"), "renders judgments label");
});

test("keeps keyword workStyle as fallback when no analysis", () => {
  assert.ok(source.includes("이력서에 남는 작업 방식"), "fallback keyword section retained");
});
