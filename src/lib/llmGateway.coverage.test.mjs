import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const libDir = path.dirname(new URL(import.meta.url).pathname);

test("production Responses call sites cannot bypass the LLM gateway", async () => {
  const filenames = (await fs.readdir(libDir)).filter(
    (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs")
  );
  const violations = [];

  for (const filename of filenames) {
    if (["llmGateway.mjs", "embeddings.mjs"].includes(filename)) continue;
    const source = await fs.readFile(path.join(libDir, filename), "utf8");
    if (source.includes("https://api.openai.com/v1/responses")) {
      violations.push(`${filename}: hard-coded official Responses endpoint`);
    }
    if (/process\.env\.OPENAI_API_KEY/.test(source)) {
      violations.push(`${filename}: direct OPENAI_API_KEY access`);
    }
    if (/fetch(?:Impl)?\s*\(\s*OPENAI_(?:URL|RESPONSES_URL)/.test(source)) {
      violations.push(`${filename}: direct Responses fetch`);
    }
  }

  assert.deepStrictEqual(violations, []);
});
