import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cliSource = readFileSync(new URL("./cli.mjs", import.meta.url), "utf8");
const batchSource = readFileSync(new URL("./lib/batch.mjs", import.meta.url), "utf8");
const dailyScript = readFileSync(new URL("../scripts/daily-batch.sh", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("manual batch is zero-LLM by default and never wires automatic resume hooks", () => {
  assert.match(cliSource, /--allow-llm/);
  assert.doesNotMatch(cliSource, /--with-resume/);
  assert.doesNotMatch(cliSource, /registerResumeBatchHook/);
  assert.match(cliSource, /runDailyBatch\(date, \{ allowLlm \}\)/);
});

test("the scheduled local worker explicitly opts into the bounded summary call", () => {
  assert.match(dailyScript, /batch --allow-llm --date/);
  assert.match(dailyScript, /batch --allow-llm(?:\s|$)/m);
  assert.doesNotMatch(dailyScript, /--with-resume/);
  assert.match(dailyScript, /refresh-profiles/);
});

test("cost-safety regression tests run under npm test", () => {
  assert.match(packageJson.scripts.test, /src\/cli\.cost-safety\.test\.mjs/);
  assert.match(packageJson.scripts.test, /DraftInsightMessages\.test\.mjs/);
  assert.match(packageJson.scripts.test, /useDraftContext\.test\.mjs/);
  assert.match(packageJson.scripts.test, /useResumeChat\.test\.mjs/);
  assert.match(packageJson.scripts.test, /ResumeChatPage\.test\.mjs/);
});

test("ordinary batches do not emit events that schedule a five-second echo batch", () => {
  assert.match(batchSource, /options\.emitGranularEvents === true/);
  assert.doesNotMatch(batchSource, /options\.emitGranularEvents !== false/);
});
