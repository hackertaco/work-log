/**
 * Tests for the Blob fallback in profile daily-summary loading.
 *
 * When the local daily directory is missing (deployed environment), windowed
 * profile reads must fall back to the work-log documents the local batch
 * synced to Vercel Blob.
 *
 * Run:
 *   node --experimental-test-module-mocks --test src/lib/profile.blob-fallback.test.mjs
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

const blobDays = {
  "2026-07-02": {
    date: "2026-07-02",
    projectGroups: {
      company: [
        {
          repo: "work-log",
          category: "company",
          commitCount: 3,
          commits: [{ subject: "Scope Slack credentials per user" }]
        }
      ]
    },
    projects: [],
    highlights: {}
  },
  "2026-07-01": {
    date: "2026-07-01",
    projectGroups: {
      company: [
        {
          repo: "work-log",
          category: "company",
          commitCount: 2,
          commits: [{ subject: "Repair the test suite" }]
        }
      ]
    },
    projects: [],
    highlights: {}
  }
};

mock.module("./blob.mjs", {
  namedExports: {
    listWorklogDates: async () => ["2026-07-02", "2026-07-01"],
    readWorklogDaily: async (date) => blobDays[date] ?? null
  }
});

const { readProfileSummary } = await import("./profile.mjs");

test("windowed profile falls back to Blob work logs when the daily dir is missing", async () => {
  const config = { dataDir: "/nonexistent/for-blob-fallback-test", userId: "alice" };
  const profile = await readProfileSummary(config, { windowDays: 7 });

  assert.equal(profile.dayCount, 2);
  const workLogArc = profile.projectArcs.find((p) => p.repo === "work-log");
  assert.ok(workLogArc, "work-log project must be aggregated from Blob days");
  assert.equal(workLogArc.totalCommits, 5);
});

test("window slicing applies to Blob dates (most recent first)", async () => {
  const config = { dataDir: "/nonexistent/for-blob-fallback-test", userId: "alice" };
  const profile = await readProfileSummary(config, { windowDays: 1 });

  assert.equal(profile.dayCount, 1);
  const workLogArc = profile.projectArcs.find((p) => p.repo === "work-log");
  assert.equal(workLogArc?.totalCommits, 3, "must keep the most recent day (2026-07-02)");
});
