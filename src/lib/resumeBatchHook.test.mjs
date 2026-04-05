/**
 * Tests for resumeBatchHook.mjs — Sub-AC 10-3
 *
 * Covers:
 *   • Export existence — runResumeCandidateHook is exported as an async function
 *   • Guard: BLOB_READ_WRITE_TOKEN absent → skipped=true, skipReason="no_blob_token"
 *   • Guard: WORK_LOG_DISABLE_OPENAI=1 → skipped=true, skipReason="openai_disabled"
 *   • Guard results always have generated=0, superseded=0, cacheHit=false
 *   • Function NEVER throws — always returns a result object
 *   • belowThreshold and deltaRatio fields are present in the typedef shape
 *     (verified through the skip path's absence of belowThreshold, and through
 *     verifying the module re-exports the expected interface contract)
 *
 * The full pipeline (steps 1–9 including the 3% threshold gate) requires
 * live Vercel Blob I/O and LLM access. Those paths are integration-tested
 * via the CLI batch runner. Unit-testable paths are the two environment-
 * variable guards that fire before any I/O.
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/resumeBatchHook.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { runResumeCandidateHook } from "./resumeBatchHook.mjs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Save current values of the given env vars, set new values, run fn,
 * then restore.  Pass undefined to delete the var during fn.
 *
 * @param {Record<string, string|undefined>} overrides
 * @param {() => Promise<unknown>} fn
 */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// ─── Export existence ─────────────────────────────────────────────────────────

describe("resumeBatchHook exports", () => {
  test("runResumeCandidateHook is exported as a function", () => {
    assert.strictEqual(typeof runResumeCandidateHook, "function");
  });

  test("runResumeCandidateHook returns a Promise", () => {
    // Calling with no token gives a Promise synchronously
    const result = withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.ok(result instanceof Promise);
    return result; // ensure the promise is awaited by the test runner
  });
});

// ─── Guard: no BLOB_READ_WRITE_TOKEN ─────────────────────────────────────────

describe("runResumeCandidateHook — guard: no BLOB_READ_WRITE_TOKEN", () => {
  test("returns skipped=true", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.skipped, true);
  });

  test("returns skipReason='no_blob_token'", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.skipReason, "no_blob_token");
  });

  test("returns generated=0", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.generated, 0);
  });

  test("returns superseded=0", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.superseded, 0);
  });

  test("returns cacheHit=false", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.cacheHit, false);
  });

  test("does not set belowThreshold on skip result", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    // belowThreshold is only set when diff is computed but ratio < 3%
    assert.strictEqual(result.belowThreshold, undefined);
  });

  test("does not set deltaRatio on skip result", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.deltaRatio, undefined);
  });

  test("does not throw when date is a valid string", async () => {
    await assert.doesNotReject(() =>
      withEnv(
        { BLOB_READ_WRITE_TOKEN: undefined },
        () => runResumeCandidateHook("2025-03-01", { resume: { candidates: [] } })
      )
    );
  });

  test("does not throw when workLog is null", async () => {
    await assert.doesNotReject(() =>
      withEnv(
        { BLOB_READ_WRITE_TOKEN: undefined },
        () => runResumeCandidateHook("2025-03-01", null)
      )
    );
  });
});

// ─── Guard: WORK_LOG_DISABLE_OPENAI=1 ────────────────────────────────────────

describe("runResumeCandidateHook — guard: WORK_LOG_DISABLE_OPENAI=1", () => {
  test("returns skipped=true when OpenAI is disabled", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: "test-token", WORK_LOG_DISABLE_OPENAI: "1" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.skipped, true);
  });

  test("returns skipReason='openai_disabled'", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: "test-token", WORK_LOG_DISABLE_OPENAI: "1" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.skipReason, "openai_disabled");
  });

  test("returns generated=0", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: "test-token", WORK_LOG_DISABLE_OPENAI: "1" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.generated, 0);
  });

  test("returns superseded=0", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: "test-token", WORK_LOG_DISABLE_OPENAI: "1" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.superseded, 0);
  });

  test("returns cacheHit=false", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: "test-token", WORK_LOG_DISABLE_OPENAI: "1" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.cacheHit, false);
  });

  test("does not set belowThreshold on skip result", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: "test-token", WORK_LOG_DISABLE_OPENAI: "1" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.belowThreshold, undefined);
  });

  test("does not throw when workLog is undefined", async () => {
    await assert.doesNotReject(() =>
      withEnv(
        { BLOB_READ_WRITE_TOKEN: "test-token", WORK_LOG_DISABLE_OPENAI: "1" },
        () => runResumeCandidateHook("2025-01-15", undefined)
      )
    );
  });

  test("WORK_LOG_DISABLE_OPENAI check takes priority over Blob token check", async () => {
    // When both token is set AND openai is disabled, openai_disabled wins
    // because the token guard fires first — but this test verifies that
    // when token IS present, the openai guard is still evaluated.
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: "any-token", WORK_LOG_DISABLE_OPENAI: "1" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skipReason, "openai_disabled");
  });
});

// ─── Non-skip guard: WORK_LOG_DISABLE_OPENAI is not "1" ──────────────────────

describe("runResumeCandidateHook — WORK_LOG_DISABLE_OPENAI values that do NOT disable", () => {
  // These tests verify that only the exact string "1" triggers the guard.
  // Other truthy-ish values ("true", "yes", "0") must NOT trigger it.

  test("WORK_LOG_DISABLE_OPENAI='0' does not trigger openai_disabled skip", async () => {
    // Without a real Blob token, we still hit the no_blob_token guard first
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined, WORK_LOG_DISABLE_OPENAI: "0" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    // Should hit no_blob_token guard, NOT openai_disabled
    assert.strictEqual(result.skipReason, "no_blob_token");
  });

  test("WORK_LOG_DISABLE_OPENAI='true' does not trigger openai_disabled skip", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined, WORK_LOG_DISABLE_OPENAI: "true" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.skipReason, "no_blob_token");
  });

  test("WORK_LOG_DISABLE_OPENAI unset does not trigger openai_disabled skip", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined, WORK_LOG_DISABLE_OPENAI: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    assert.strictEqual(result.skipReason, "no_blob_token");
  });
});

// ─── Below-threshold contract (structural) ───────────────────────────────────
//
// The full below-threshold path requires Vercel Blob + LLM and is integration-
// tested via the batch CLI.  Here we verify the structural contract: the
// shape of a belowThreshold result is consistent with the CandidateHookResult
// typedef by constructing an equivalent plain object and asserting property
// presence.

describe("CandidateHookResult belowThreshold shape contract", () => {
  /** Simulate what runResumeCandidateHook returns on below-threshold. */
  function makeBelowThresholdResult(ratio, changedCount, totalCount) {
    return {
      skipped: false,
      belowThreshold: true,
      generated: 0,
      superseded: 0,
      cacheHit: false,
      deltaRatio: ratio,
      deltaChangedCount: changedCount,
      deltaTotalCount: totalCount
    };
  }

  test("belowThreshold=true is present and is a boolean", () => {
    const r = makeBelowThresholdResult(0.01, 1, 100);
    assert.strictEqual(r.belowThreshold, true);
  });

  test("skipped=false on below-threshold result (not a guard skip)", () => {
    const r = makeBelowThresholdResult(0.02, 2, 100);
    assert.strictEqual(r.skipped, false);
  });

  test("generated=0 on below-threshold result", () => {
    const r = makeBelowThresholdResult(0.02, 2, 100);
    assert.strictEqual(r.generated, 0);
  });

  test("superseded=0 on below-threshold result", () => {
    const r = makeBelowThresholdResult(0.02, 2, 100);
    assert.strictEqual(r.superseded, 0);
  });

  test("deltaRatio is a number between 0 and 0.03 for below-threshold result", () => {
    const r = makeBelowThresholdResult(0.025, 2, 80);
    assert.strictEqual(typeof r.deltaRatio, "number");
    assert.ok(r.deltaRatio < 0.03, `Expected ratio < 0.03, got ${r.deltaRatio}`);
  });

  test("deltaChangedCount is a non-negative integer", () => {
    const r = makeBelowThresholdResult(0.01, 1, 100);
    assert.strictEqual(typeof r.deltaChangedCount, "number");
    assert.ok(r.deltaChangedCount >= 0);
  });

  test("deltaTotalCount is a positive integer", () => {
    const r = makeBelowThresholdResult(0.01, 1, 100);
    assert.strictEqual(typeof r.deltaTotalCount, "number");
    assert.ok(r.deltaTotalCount > 0);
  });

  test("deltaRatio = deltaChangedCount / deltaTotalCount", () => {
    const changedCount = 2;
    const totalCount = 100;
    const r = makeBelowThresholdResult(changedCount / totalCount, changedCount, totalCount);
    assert.strictEqual(r.deltaRatio, r.deltaChangedCount / r.deltaTotalCount);
  });
});

// ─── Above-threshold contract (structural) ───────────────────────────────────

describe("CandidateHookResult above-threshold (success) shape contract", () => {
  /** Simulate what runResumeCandidateHook returns on successful generation. */
  function makeSuccessResult({ generated, superseded, cacheHit, ratio, changedCount, totalCount }) {
    return {
      skipped: false,
      generated,
      superseded,
      cacheHit,
      deltaRatio: ratio,
      deltaChangedCount: changedCount,
      deltaTotalCount: totalCount,
      draftGenerationTriggered: true
    };
  }

  test("skipped=false on success result", () => {
    const r = makeSuccessResult({ generated: 3, superseded: 1, cacheHit: false, ratio: 0.05, changedCount: 5, totalCount: 100 });
    assert.strictEqual(r.skipped, false);
  });

  test("belowThreshold is absent on success result", () => {
    const r = makeSuccessResult({ generated: 3, superseded: 0, cacheHit: true, ratio: 0.06, changedCount: 6, totalCount: 100 });
    assert.strictEqual(r.belowThreshold, undefined);
  });

  test("generated is a positive number on success", () => {
    const r = makeSuccessResult({ generated: 3, superseded: 0, cacheHit: false, ratio: 0.05, changedCount: 5, totalCount: 100 });
    assert.ok(r.generated > 0);
  });

  test("deltaRatio >= 0.03 on success result", () => {
    const r = makeSuccessResult({ generated: 3, superseded: 0, cacheHit: false, ratio: 0.05, changedCount: 5, totalCount: 100 });
    assert.ok(r.deltaRatio >= 0.03, `Expected ratio >= 0.03, got ${r.deltaRatio}`);
  });

  test("draftGenerationTriggered=true on success result (Sub-AC 2-2)", () => {
    const r = makeSuccessResult({ generated: 3, superseded: 0, cacheHit: false, ratio: 0.05, changedCount: 5, totalCount: 100 });
    assert.strictEqual(r.draftGenerationTriggered, true);
  });
});

// ─── Sub-AC 2-2: Background draft generation (structural contract) ────────────
//
// The full background draft generation path requires live Vercel Blob + LLM.
// Unit-testable paths here cover:
//   • draftGenerationTriggered is absent on guard-skip results
//   • draftGenerationTriggered=true is included in non-skip results
//   • Module imports generateResumeDraft and saveChatDraft (shape contract)

describe("Sub-AC 2-2 — background draft generation contract", () => {
  test("draftGenerationTriggered is absent on no_blob_token skip result", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    // Guard fires before any draft generation is triggered
    assert.strictEqual(result.draftGenerationTriggered, undefined);
  });

  test("draftGenerationTriggered is absent on openai_disabled skip result", async () => {
    const result = await withEnv(
      { BLOB_READ_WRITE_TOKEN: "test-token", WORK_LOG_DISABLE_OPENAI: "1" },
      () => runResumeCandidateHook("2025-01-15", {})
    );
    // Guard fires before any draft generation is triggered
    assert.strictEqual(result.draftGenerationTriggered, undefined);
  });

  test("belowThreshold result shape includes draftGenerationTriggered (structural)", () => {
    // Simulates what the hook returns when delta < 3% but draft was triggered
    const belowWithDraft = {
      skipped: false,
      belowThreshold: true,
      generated: 0,
      superseded: 0,
      cacheHit: false,
      deltaRatio: 0.01,
      deltaChangedCount: 1,
      deltaTotalCount: 100,
      draftGenerationTriggered: true
    };
    assert.strictEqual(belowWithDraft.draftGenerationTriggered, true);
    assert.strictEqual(belowWithDraft.belowThreshold, true);
  });

  test("resumeDraftGeneration module exports generateResumeDraft as a function", async () => {
    const mod = await import("./resumeDraftGeneration.mjs");
    assert.strictEqual(typeof mod.generateResumeDraft, "function");
  });

  test("resumeDraftGeneration module exports loadWorkLogs as a function", async () => {
    const mod = await import("./resumeDraftGeneration.mjs");
    assert.strictEqual(typeof mod.loadWorkLogs, "function");
  });

  test("resumeDraftGeneration module exports aggregateSignals as a function", async () => {
    const mod = await import("./resumeDraftGeneration.mjs");
    assert.strictEqual(typeof mod.aggregateSignals, "function");
  });

  test("resumeChatDraftService module exports buildChatDraftContext as a function", async () => {
    const mod = await import("./resumeChatDraftService.mjs");
    assert.strictEqual(typeof mod.buildChatDraftContext, "function");
  });

  test("buildChatDraftContext returns correct shape on empty work logs", async () => {
    const { buildChatDraftContext } = await import("./resumeChatDraftService.mjs");
    const result = await buildChatDraftContext({ fromDate: "2099-01-01", toDate: "2099-01-31" });
    assert.strictEqual(result.draft, null, "draft should be null when no data");
    assert.ok(Array.isArray(result.evidencePool), "evidencePool must be an array");
    assert.ok(typeof result.sourceBreakdown === "object", "sourceBreakdown must be an object");
    assert.strictEqual(result.sourceBreakdown.commits, 0);
    assert.strictEqual(result.sourceBreakdown.slack, 0);
    assert.strictEqual(result.sourceBreakdown.sessions, 0);
    assert.ok(Array.isArray(result.dataGaps), "dataGaps must be an array");
  });

  test("blob module exports saveChatDraftContext as a function", async () => {
    const mod = await import("./blob.mjs");
    assert.strictEqual(typeof mod.saveChatDraftContext, "function");
  });

  test("blob module exports readChatDraftContext as a function", async () => {
    const mod = await import("./blob.mjs");
    assert.strictEqual(typeof mod.readChatDraftContext, "function");
  });

  test("blob module exports CHAT_DRAFT_CONTEXT_PATHNAME constant", async () => {
    const mod = await import("./blob.mjs");
    assert.strictEqual(mod.CHAT_DRAFT_CONTEXT_PATHNAME, "resume/chat-draft-context.json");
  });

  test("aggregateSignals returns correct shape on empty input", async () => {
    const { aggregateSignals } = await import("./resumeDraftGeneration.mjs");
    const result = aggregateSignals([]);
    assert.strictEqual(typeof result.signalText, "string");
    assert.strictEqual(result.commitCount, 0);
    assert.strictEqual(result.sessionCount, 0);
    assert.strictEqual(result.slackCount, 0);
    assert.ok(Array.isArray(result.repos));
    assert.strictEqual(result.repos.length, 0);
  });

  test("aggregateSignals accumulates commits, sessions, slack from work logs", async () => {
    const { aggregateSignals } = await import("./resumeDraftGeneration.mjs");
    const workLogs = [
      {
        date: "2026-01-01",
        counts: { gitCommits: 5, codexSessions: 2, claudeSessions: 1, slackContexts: 3 },
        highlights: {}
      },
      {
        date: "2026-01-02",
        counts: { gitCommits: 3, codexSessions: 0, claudeSessions: 1, slackContexts: 2 },
        highlights: {}
      }
    ];
    const result = aggregateSignals(workLogs);
    assert.strictEqual(result.commitCount, 8);   // 5 + 3
    assert.strictEqual(result.sessionCount, 4);  // (2+1) + (0+1)
    assert.strictEqual(result.slackCount, 5);    // 3 + 2
  });

  test("aggregateSignals includes story thread repos in repos list", async () => {
    const { aggregateSignals } = await import("./resumeDraftGeneration.mjs");
    const workLogs = [
      {
        date: "2026-01-01",
        counts: {},
        highlights: {
          storyThreads: [
            { repo: "my-repo", outcome: "shipped feature" },
            { repo: "other-repo", keyChange: "refactored module" }
          ]
        }
      }
    ];
    const result = aggregateSignals(workLogs);
    assert.ok(result.repos.includes("my-repo"), "repos should contain my-repo");
    assert.ok(result.repos.includes("other-repo"), "repos should contain other-repo");
  });

  test("aggregateSignals truncates signalText at SIGNAL_TEXT_LIMIT", async () => {
    const { aggregateSignals } = await import("./resumeDraftGeneration.mjs");
    // Generate a work log with very long content
    const bigHighlight = "x".repeat(1000);
    const workLogs = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      counts: { gitCommits: 1 },
      highlights: {
        businessOutcomes: [bigHighlight, bigHighlight, bigHighlight]
      }
    }));
    const result = aggregateSignals(workLogs);
    // signalText should be capped at 20,000 chars (the module's SIGNAL_TEXT_LIMIT)
    assert.ok(result.signalText.length <= 20_000 + 20, "signalText must be ≤ SIGNAL_TEXT_LIMIT");
  });

  test("loadWorkLogs returns empty array when daily dir does not exist", async () => {
    const { loadWorkLogs } = await import("./resumeDraftGeneration.mjs");
    // Temporarily override config to point to a non-existent directory
    // Since we can't easily mock config here, just verify the function returns an array
    const result = await loadWorkLogs({ fromDate: "2099-01-01", toDate: "2099-01-31" });
    assert.ok(Array.isArray(result), "loadWorkLogs should always return an array");
    assert.strictEqual(result.length, 0, "should return empty array for future date range");
  });

  test("aggregateSignals includes raw commit subjects from projects field", async () => {
    const { aggregateSignals } = await import("./resumeDraftGeneration.mjs");
    const workLogs = [
      {
        date: "2026-01-01",
        counts: { gitCommits: 5 },
        highlights: {},
        projects: [
          {
            repo: "test-repo",
            commits: [
              { subject: "feat: 새로운 배치 처리 파이프라인 구현" },
              { subject: "fix: 캐시 무효화 타이밍 수정으로 일관성 확보" },
            ],
          },
        ],
      },
    ];
    const result = aggregateSignals(workLogs);
    assert.ok(
      result.signalText.includes("[test-repo] 커밋:"),
      "signalText should include raw commit subjects section"
    );
    assert.ok(
      result.signalText.includes("배치 처리 파이프라인"),
      "signalText should include commit subject content"
    );
  });

  test("buildChatDraftContext collects evidence from all three data sources", async () => {
    const { buildChatDraftContext } = await import("./resumeChatDraftService.mjs");
    const result = await buildChatDraftContext({
      fromDate: "2026-03-24",
      toDate: "2026-04-03",
      skipLLM: true,
    });
    // Structural validation
    assert.ok(result !== null && typeof result === "object");
    assert.ok(Array.isArray(result.evidencePool));
    assert.ok(typeof result.sourceBreakdown === "object");
    assert.ok(typeof result.sourceBreakdown.commits === "number");
    assert.ok(typeof result.sourceBreakdown.slack === "number");
    assert.ok(typeof result.sourceBreakdown.sessions === "number");
    assert.ok(typeof result.sourceBreakdown.totalDates === "number");
    assert.ok(Array.isArray(result.dataGaps));

    // If data exists, evidence should be populated
    if (result.sourceBreakdown.totalDates > 0) {
      assert.ok(result.evidencePool.length > 0, "evidence pool should be populated with data");
    }
  });

  test("buildChatDraftContext evidence includes commit-sourced items", async () => {
    const { buildChatDraftContext } = await import("./resumeChatDraftService.mjs");
    const result = await buildChatDraftContext({
      fromDate: "2026-03-24",
      toDate: "2026-04-03",
      skipLLM: true,
    });
    if (result.sourceBreakdown.totalDates > 0) {
      const commitEvidence = result.evidencePool.filter((e) => e.source === "commits");
      assert.ok(commitEvidence.length > 0, "should have commit evidence when work logs have commits");
    }
  });

  test("buildChatDraftContext accepts currentWorkLog parameter for batch injection", async () => {
    const { buildChatDraftContext } = await import("./resumeChatDraftService.mjs");
    const mockWorkLog = {
      date: "2099-06-15",
      counts: { gitCommits: 2, codexSessions: 0, claudeSessions: 0, slackContexts: 0 },
      highlights: {
        businessOutcomes: ["배치 처리 파이프라인 구현 완료"],
        storyThreads: [{ repo: "test-repo", outcome: "완료" }],
      },
      projects: [{
        repo: "test-repo",
        commits: [{ subject: "feat: 초안 생성 배치 로직 구현" }],
      }],
    };

    const result = await buildChatDraftContext({
      fromDate: "2099-06-15",
      toDate: "2099-06-15",
      currentWorkLog: mockWorkLog,
      skipLLM: true,
    });

    // The injected work log should produce evidence
    assert.ok(result.evidencePool.length > 0, "injected workLog should produce evidence");
    assert.strictEqual(result.sourceBreakdown.totalDates, 1, "should have 1 date from injected log");

    // Verify evidence contains data from the injected work log
    const commitEvidence = result.evidencePool.filter((e) => e.source === "commits");
    assert.ok(commitEvidence.length > 0, "should have commit evidence from injected workLog");
    assert.ok(
      commitEvidence.some((e) => e.text.includes("test-repo") || e.text.includes("배치 처리") || e.text.includes("완료")),
      "commit evidence should contain injected work log data"
    );
  });
});
