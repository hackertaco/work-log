import assert from "node:assert/strict";
import { mock, test } from "node:test";

const savedBlob = {};
let stored = null;

mock.module("./blob.mjs", {
  namedExports: {
    saveWorkStyleAnalysis: async (data) => { stored = data; return { url: "blob://x" }; },
    readWorkStyleAnalysis: async () => null,
    readWorklogDaily: async () => null,
    saveWorklogDaily: async () => ({ url: "" }),
    saveWorklogProfile: async () => ({ url: "" }),
    listWorklogDates: async () => [],
    // batch.mjs (imported transitively via serverCollect.mjs) also pulls from
    // ./blob.mjs; mock.module replaces the whole module namespace for every
    // importer in the process, so its imports must be stubbed here too even
    // though this test never exercises them directly.
    readSuggestionsData: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] }),
    saveBatchSummary: async () => ({ url: "" })
  }
});
mock.module("./workStyleExtract.mjs", {
  namedExports: {
    extractWorkStyleForArea: async (g) => ({ area: g.area, did: ["did-" + g.area], judgments: [{ text: "j", evidence: "e" }] })
  }
});

const { runWorkStyleAnalysis } = await import("./serverCollect.mjs");

test("skips when no prompts", async () => {
  const saved = process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_URL;
  const r = await runWorkStyleAnalysis({ userId: "default" });
  assert.equal(r.skipped, true);
  if (saved !== undefined) process.env.CLICKHOUSE_URL = saved;
});
