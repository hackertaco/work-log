/**
 * Tests for Sub-AC 10-1: last approved snapshot save and retrieval.
 *
 * Covers two complementary pieces:
 *
 *   1. resumeBatchHook.mjs — Step 10 (batch checkpoint snapshot)
 *      • saveSnapshot is called when candidates are generated
 *      • snapshotKey is returned in the result
 *      • saveSnapshot failure is non-fatal (snapshotKey null, no error field)
 *      • snapshot is NOT saved when diff is empty (early return)
 *      • snapshot is NOT saved when delta is below threshold (belowThreshold path)
 *      • snapshot is NOT saved when rawSuggestions is empty (no actionable diff)
 *      • snapshot is NOT saved when the hook is skipped (no token / no resume)
 *      • snapshot is NOT saved when a pipeline step fails (error return)
 *
 *   2. resumeSnapshotDelta.mjs — getLastApprovedSnapshot()
 *      • returns null when Blob is empty
 *      • returns the first approval-triggered snapshot (triggeredBy: "approve")
 *      • returns a batch-triggered snapshot (triggeredBy: "batch", Sub-AC 10-1)
 *      • returns a patch-triggered snapshot (triggeredBy: "patch")
 *      • skips rollback-triggered snapshots
 *      • falls back to most-recent non-rollback when no explicit approval found
 *      • returns null when all probed snapshots are rollback-triggered
 *      • batch-triggered snapshot is found in FIRST pass (APPROVE_TRIGGERS)
 *
 * Run with:
 *   node --experimental-test-module-mocks --test src/routes/resume.batch-hook.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe, mock } from "node:test";

// ─── Mutable stubs shared by both test suites ──────────────────────────────

// resumeBatchHook stubs
let readResumeDataFn          = async () => null;
let readSuggestionsDataFn     = async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] });
let saveSuggestionsDataFn     = async () => ({ url: "https://blob/resume/suggestions.json" });
let saveSnapshotFn            = async () => ({ snapshotKey: "resume/snapshots/2026-03-27T12-00-00.000Z.json", url: "https://blob/snap" });
let saveChatDraftFn           = async () => ({ url: "https://blob/resume/chat-draft.json" });
let saveChatDraftContextFn    = async () => ({ url: "https://blob/resume/chat-draft-context.json" });

// resumeSnapshotDelta stubs (shared blob layer)
let listSnapshotsFn           = async () => [];
let readSnapshotByKeyFn       = async () => null;

let readExtractCacheFn        = async () => null;
let extractResumeUpdatesFn    = async () => ({});
let mergeWorkLogIntoResumeFn  = () => ({});
let diffResumeFn              = () => ({ isEmpty: true });
let diffToSuggestionsFn       = () => [];
let computeDeltaRatioFn       = () => ({ ratio: 0.1, changedCount: 3, totalCount: 30 });
let exceedsDeltaThresholdFn   = () => true;

// ─── Module mocks ──────────────────────────────────────────────────────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    readResumeData:       (...args) => readResumeDataFn(...args),
    readSuggestionsData:  (...args) => readSuggestionsDataFn(...args),
    saveSuggestionsData:  (...args) => saveSuggestionsDataFn(...args),
    saveSnapshot:         (...args) => saveSnapshotFn(...args),
    listSnapshots:        (...args) => listSnapshotsFn(...args),
    readSnapshotByKey:    (...args) => readSnapshotByKeyFn(...args),
    // other blob exports used by resume.mjs (not needed here but kept for completeness)
    checkResumeExists:           async () => ({ exists: false }),
    saveResumeData:              async () => ({ url: "https://blob/resume/data.json" }),
    saveDailyBullets:            async () => ({ url: "https://blob/resume/bullets/test.json" }),
    readDailyBullets:            async () => null,
    listBulletDates:             async () => [],
    deleteDailyBullets:          async () => {},
    savePdfText:                 async () => ({ url: "https://blob/resume/pdf-text.txt" }),
    readPdfText:                 async () => null,
    savePdfRaw:                  async () => ({ url: "https://blob/resume/resume.pdf" }),
    PDF_RAW_PATHNAME:            "resume/resume.pdf",
    markResumeForReconstruction: async () => {},
    clearReconstructionMarker:   async () => {},
    checkReconstructionMarker:   async () => ({ needsRebuild: false }),
    saveKeywordClusterAxes:      async () => ({ url: "https://blob/resume/keyword-cluster-axes.json" }),
    readKeywordClusterAxes:      async () => null,
    SNAPSHOTS_PREFIX:            "resume/snapshots/",
    snapshotPathnameFor:         (ts) => `resume/snapshots/${ts.replace(/:/g, "-")}.json`,
    readStrengthKeywords:        async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), source: "system", keywords: [] }),
    saveStrengthKeywords:        async () => ({ url: "https://blob/resume/strength-keywords.json" }),
    STRENGTH_KEYWORDS_PATHNAME:  "resume/strength-keywords.json",
    saveDisplayAxes:             async () => ({ url: "https://blob/resume/display-axes.json" }),
    readDisplayAxes:             async () => null,
    DISPLAY_AXES_PATHNAME:       "resume/display-axes.json",
    saveChatDraft:               (...args) => saveChatDraftFn(...args),
    readChatDraft:               async () => null,
    saveChatDraftContext:        (...args) => saveChatDraftContextFn(...args),
    readChatDraftContext:        async () => null,
    CHAT_DRAFT_PATHNAME:         "resume/chat-draft.json",
    CHAT_DRAFT_CONTEXT_PATHNAME: "resume/chat-draft-context.json"
  }
});

mock.module("../lib/bulletCache.mjs", {
  namedExports: {
    readBulletCache:   async () => null,
    writeBulletCache:  async () => {},
    readExtractCache:  (...args) => readExtractCacheFn(...args),
    writeExtractCache: async () => {}
  }
});

mock.module("../lib/resumeWorkLogExtract.mjs", {
  namedExports: {
    extractResumeUpdatesFromWorkLog: (...args) => extractResumeUpdatesFn(...args)
  }
});

mock.module("../lib/resumeWorkLogMerge.mjs", {
  namedExports: {
    mergeWorkLogIntoResume: (...args) => mergeWorkLogIntoResumeFn(...args)
  }
});

mock.module("../lib/resumeDiff.mjs", {
  namedExports: {
    diffResume: (...args) => diffResumeFn(...args)
  }
});

mock.module("../lib/resumeDiffToSuggestions.mjs", {
  namedExports: {
    diffToSuggestions:                (...args) => diffToSuggestionsFn(...args),
    deduplicateWorkLogSuggestions:    (s) => s
  }
});

mock.module("../lib/resumeDeltaRatio.mjs", {
  namedExports: {
    computeDeltaRatio:     (...args) => computeDeltaRatioFn(...args),
    exceedsDeltaThreshold: (...args) => exceedsDeltaThresholdFn(...args),
    DELTA_THRESHOLD:       0.03
  }
});

// Mock generateResumeDraft — used as fallback inside _generateDraftInBackground
mock.module("../lib/resumeDraftGeneration.mjs", {
  namedExports: {
    generateResumeDraft: async () => ({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      dateRange: { from: "2026-01-01", to: "2026-03-27" },
      sources: { dates: [], commitCount: 0, sessionCount: 0, slackCount: 0, repos: [] },
      strengthCandidates: [],
      experienceSummaries: [],
      suggestedSummary: "",
      dataGaps: []
    }),
    loadWorkLogs: async () => [],
    aggregateSignals: () => ({ signalText: "", commitCount: 0, sessionCount: 0, slackCount: 0, repos: [] })
  }
});

// Mock buildChatDraftContext — used by _generateDraftInBackground (Sub-AC 2-2)
mock.module("../lib/resumeChatDraftService.mjs", {
  namedExports: {
    buildChatDraftContext: async () => ({
      draft: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        dateRange: { from: "2026-01-01", to: "2026-03-27" },
        sources: { dates: [], commitCount: 0, sessionCount: 0, slackCount: 0, repos: [] },
        strengthCandidates: [],
        experienceSummaries: [],
        suggestedSummary: "",
        dataGaps: []
      },
      evidencePool: [],
      sourceBreakdown: { commits: 0, slack: 0, sessions: 0, totalDates: 0 },
      dataGaps: []
    }),
    refineSectionWithChat: async () => ({ section: "", suggestions: [], evidenceCited: [], clarifications: [] }),
    searchEvidenceByKeywords: async () => [],
    extractDraftContentForSection: () => ({ strengths: [], experiences: [], summary: "" })
  }
});

// ─── Import modules under test AFTER mocks ─────────────────────────────────

const { runResumeCandidateHook } = await import("../lib/resumeBatchHook.mjs");
const { getLastApprovedSnapshot, deltaFromLastApproved } = await import("../lib/resumeSnapshotDelta.mjs");

// ─── Helpers ───────────────────────────────────────────────────────────────

/** A minimal resume document used as the "current" resume in tests. */
const SAMPLE_RESUME = {
  meta: { schemaVersion: 1, language: "en", generatedAt: "2026-01-01T00:00:00Z" },
  contact: { name: "Alice Kim", email: "alice@example.com" },
  summary: "Software engineer.",
  experience: [],
  education: [],
  skills: { technical: [], languages: [], tools: [] },
  projects: [],
  certifications: [],
  strength_keywords: []
};

/** A suggestions document with one pending suggestion. */
function makeSuggestionsDoc(pending = 1) {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: Array.from({ length: pending }, (_, i) => ({
      id: `s-${i}`,
      status: "pending",
      kind: "add",
      sectionType: "experience",
      payload: { bullet: `Bullet ${i}.` }
    }))
  };
}

/** Build a non-empty diff (has content) so the hook proceeds past isEmpty check. */
function makeNonEmptyDiff() {
  return {
    isEmpty: false,
    summary: { changed: true, before: "Old", after: "New" },
    experience: { added: [], deleted: [], modified: [] },
    education:  { added: [], deleted: [], modified: [] },
    skills: {},
    projects: { added: [], deleted: [], modified: [] },
    certifications: { added: [], deleted: [], modified: [] },
    strength_keywords: {},
    display_axes: { added: [], deleted: [], modified: [] },
    contact: {}
  };
}

/** Build a non-empty raw suggestion list. */
function makeRawSuggestions(n = 2) {
  return Array.from({ length: n }, (_, i) => ({
    id: `new-${i}`,
    status: "pending",
    kind: "add",
    sectionType: "experience",
    payload: { bullet: `New bullet ${i}.` },
    sourceDate: "2026-03-27"
  }));
}

/** Standard env setup: BLOB_READ_WRITE_TOKEN present, OpenAI not disabled. */
function setEnv() {
  process.env.BLOB_READ_WRITE_TOKEN = "test-blob-token";
  delete process.env.WORK_LOG_DISABLE_OPENAI;
}

/** Remove env vars set by setEnv(). */
function clearEnv() {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.WORK_LOG_DISABLE_OPENAI;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: runResumeCandidateHook — Step 10 snapshot saving
// ═══════════════════════════════════════════════════════════════════════════════

describe("runResumeCandidateHook — Step 10 batch checkpoint snapshot", () => {

  // ── Happy path: snapshot is saved and key is returned ──────────────────────

  test("saves snapshot when candidates are generated and returns snapshotKey", async () => {
    setEnv();

    const expectedKey = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    let saveSnapshotCallCount = 0;
    let saveSnapshotCallArgs  = null;

    readResumeDataFn      = async () => SAMPLE_RESUME;
    readExtractCacheFn    = async () => ({ experience: [] });
    mergeWorkLogIntoResumeFn = () => ({ ...SAMPLE_RESUME, summary: "Updated." });
    diffResumeFn          = () => makeNonEmptyDiff();
    computeDeltaRatioFn   = () => ({ ratio: 0.1, changedCount: 3, totalCount: 30 });
    exceedsDeltaThresholdFn = () => true;
    diffToSuggestionsFn   = () => makeRawSuggestions(2);
    readSuggestionsDataFn = async () => makeSuggestionsDoc(0);
    saveSuggestionsDataFn = async () => ({});
    saveSnapshotFn        = async (doc, meta) => {
      saveSnapshotCallCount++;
      saveSnapshotCallArgs = { doc, meta };
      return { snapshotKey: expectedKey, url: "https://blob/snap" };
    };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.equal(result.skipped, false, "must not be skipped");
    assert.equal(result.generated, 2, "must report 2 generated candidates");
    assert.equal(result.snapshotKey, expectedKey, "snapshotKey must match returned value");
    assert.equal(saveSnapshotCallCount, 1, "saveSnapshot must be called exactly once");
    assert.ok(saveSnapshotCallArgs, "saveSnapshot args must be recorded");
    assert.deepEqual(saveSnapshotCallArgs.doc, SAMPLE_RESUME,
      "snapshot must capture existingResume (pre-candidate state)");
    assert.equal(saveSnapshotCallArgs.meta.triggeredBy, "batch",
      "triggeredBy must be 'batch'");
    assert.equal(saveSnapshotCallArgs.meta.trigger, "batch",
      "trigger must be 'batch'");
    assert.equal(saveSnapshotCallArgs.meta.label, "batch",
      "label must be 'batch'");

    clearEnv();
  });

  test("snapshot is saved even when there are pending suggestions to supersede", async () => {
    setEnv();

    let saveSnapshotCallCount = 0;

    readResumeDataFn      = async () => SAMPLE_RESUME;
    readExtractCacheFn    = async () => ({ experience: [] });
    mergeWorkLogIntoResumeFn = () => SAMPLE_RESUME;
    diffResumeFn          = () => makeNonEmptyDiff();
    computeDeltaRatioFn   = () => ({ ratio: 0.1, changedCount: 3, totalCount: 30 });
    exceedsDeltaThresholdFn = () => true;
    diffToSuggestionsFn   = () => makeRawSuggestions(1);
    readSuggestionsDataFn = async () => makeSuggestionsDoc(3); // 3 pending to supersede
    saveSuggestionsDataFn = async () => ({});
    saveSnapshotFn        = async () => {
      saveSnapshotCallCount++;
      return { snapshotKey: "resume/snapshots/2026-03-27T12-00-00.000Z.json", url: "" };
    };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.equal(result.superseded, 3, "must report 3 superseded");
    assert.equal(saveSnapshotCallCount, 1, "saveSnapshot must be called once");
    assert.ok(result.snapshotKey, "snapshotKey must be in result");

    clearEnv();
  });

  // ── Failure is non-fatal ───────────────────────────────────────────────────

  test("snapshot save failure is non-fatal — result still reports success with snapshotKey null", async () => {
    setEnv();

    readResumeDataFn      = async () => SAMPLE_RESUME;
    readExtractCacheFn    = async () => ({ experience: [] });
    mergeWorkLogIntoResumeFn = () => SAMPLE_RESUME;
    diffResumeFn          = () => makeNonEmptyDiff();
    computeDeltaRatioFn   = () => ({ ratio: 0.1, changedCount: 3, totalCount: 30 });
    exceedsDeltaThresholdFn = () => true;
    diffToSuggestionsFn   = () => makeRawSuggestions(1);
    readSuggestionsDataFn = async () => makeSuggestionsDoc(0);
    saveSuggestionsDataFn = async () => ({});
    saveSnapshotFn        = async () => { throw new Error("Blob storage unavailable"); };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.equal(result.skipped, false, "must not be skipped");
    assert.equal(result.generated, 1, "candidates still generated");
    assert.equal(result.snapshotKey, null, "snapshotKey must be null on failure");
    assert.equal(result.error, undefined, "error must not be set (hook succeeded)");

    clearEnv();
  });

  // ── Early-return paths must NOT save snapshot ─────────────────────────────

  test("snapshot is NOT saved when BLOB_READ_WRITE_TOKEN is absent (skip)", async () => {
    clearEnv(); // no BLOB_READ_WRITE_TOKEN

    let saveSnapshotCallCount = 0;
    saveSnapshotFn = async () => { saveSnapshotCallCount++; return { snapshotKey: "x", url: "" }; };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.equal(result.skipped, true, "must be skipped");
    assert.equal(saveSnapshotCallCount, 0, "saveSnapshot must NOT be called");
    assert.equal(result.snapshotKey, undefined, "snapshotKey must not be in result");
  });

  test("snapshot is NOT saved when no resume is bootstrapped (skip)", async () => {
    setEnv();

    let saveSnapshotCallCount = 0;
    readResumeDataFn   = async () => null;
    saveSnapshotFn     = async () => { saveSnapshotCallCount++; return { snapshotKey: "x", url: "" }; };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.equal(result.skipped, true, "must be skipped");
    assert.equal(saveSnapshotCallCount, 0, "saveSnapshot must NOT be called");

    clearEnv();
  });

  test("snapshot is NOT saved when diff is empty (no resume changes)", async () => {
    setEnv();

    let saveSnapshotCallCount = 0;
    readResumeDataFn      = async () => SAMPLE_RESUME;
    readExtractCacheFn    = async () => ({});
    mergeWorkLogIntoResumeFn = () => SAMPLE_RESUME;
    diffResumeFn          = () => ({ isEmpty: true });
    saveSnapshotFn        = async () => { saveSnapshotCallCount++; return { snapshotKey: "x", url: "" }; };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.equal(result.generated, 0);
    assert.equal(saveSnapshotCallCount, 0, "saveSnapshot must NOT be called on empty diff");

    clearEnv();
  });

  test("snapshot is NOT saved when delta ratio is below threshold (belowThreshold path)", async () => {
    setEnv();

    let saveSnapshotCallCount = 0;
    readResumeDataFn        = async () => SAMPLE_RESUME;
    readExtractCacheFn      = async () => ({});
    mergeWorkLogIntoResumeFn = () => SAMPLE_RESUME;
    diffResumeFn            = () => makeNonEmptyDiff();
    computeDeltaRatioFn     = () => ({ ratio: 0.01, changedCount: 1, totalCount: 100 });
    exceedsDeltaThresholdFn = () => false;
    saveSnapshotFn          = async () => { saveSnapshotCallCount++; return { snapshotKey: "x", url: "" }; };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.equal(result.belowThreshold, true);
    assert.equal(saveSnapshotCallCount, 0, "saveSnapshot must NOT be called below threshold");

    clearEnv();
  });

  test("snapshot is NOT saved when diff produces no actionable suggestions", async () => {
    setEnv();

    let saveSnapshotCallCount = 0;
    readResumeDataFn        = async () => SAMPLE_RESUME;
    readExtractCacheFn      = async () => ({});
    mergeWorkLogIntoResumeFn = () => SAMPLE_RESUME;
    diffResumeFn            = () => makeNonEmptyDiff();
    computeDeltaRatioFn     = () => ({ ratio: 0.1, changedCount: 3, totalCount: 30 });
    exceedsDeltaThresholdFn = () => true;
    diffToSuggestionsFn     = () => []; // empty — no actionable suggestions
    saveSnapshotFn          = async () => { saveSnapshotCallCount++; return { snapshotKey: "x", url: "" }; };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.equal(result.generated, 0);
    assert.equal(saveSnapshotCallCount, 0, "saveSnapshot must NOT be called with no suggestions");

    clearEnv();
  });

  test("snapshot is NOT saved when suggestions read fails (error return)", async () => {
    setEnv();

    let saveSnapshotCallCount = 0;
    readResumeDataFn        = async () => SAMPLE_RESUME;
    readExtractCacheFn      = async () => ({});
    mergeWorkLogIntoResumeFn = () => SAMPLE_RESUME;
    diffResumeFn            = () => makeNonEmptyDiff();
    computeDeltaRatioFn     = () => ({ ratio: 0.1, changedCount: 3, totalCount: 30 });
    exceedsDeltaThresholdFn = () => true;
    diffToSuggestionsFn     = () => makeRawSuggestions(1);
    readSuggestionsDataFn   = async () => { throw new Error("read error"); };
    saveSnapshotFn          = async () => { saveSnapshotCallCount++; return { snapshotKey: "x", url: "" }; };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.ok(result.error, "error must be set when suggestions read fails");
    assert.equal(saveSnapshotCallCount, 0, "saveSnapshot must NOT be called when pipeline errors");

    clearEnv();
  });

  test("background draft save runs inside the provided user context", async () => {
    setEnv();

    const { getCurrentUserId } = await import("../lib/requestContext.mjs");
    let observedDraftUser = null;
    let observedContextUser = null;

    readResumeDataFn         = async () => SAMPLE_RESUME;
    readExtractCacheFn       = async () => ({});
    mergeWorkLogIntoResumeFn = () => SAMPLE_RESUME;
    diffResumeFn             = () => ({ isEmpty: true });
    saveChatDraftFn = async () => {
      observedDraftUser = getCurrentUserId();
      return { url: "https://blob/resume/chat-draft.json" };
    };
    saveChatDraftContextFn = async () => {
      observedContextUser = getCurrentUserId();
      return { url: "https://blob/resume/chat-draft-context.json" };
    };

    await runResumeCandidateHook("2026-03-27", {}, { userId: "alice" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(observedDraftUser, "alice");
    assert.equal(observedContextUser, "alice");

    clearEnv();
    saveChatDraftFn = async () => ({ url: "https://blob/resume/chat-draft.json" });
    saveChatDraftContextFn = async () => ({ url: "https://blob/resume/chat-draft-context.json" });
  });

  test("snapshot is NOT saved when suggestions write fails (error return)", async () => {
    setEnv();

    let saveSnapshotCallCount = 0;
    readResumeDataFn        = async () => SAMPLE_RESUME;
    readExtractCacheFn      = async () => ({});
    mergeWorkLogIntoResumeFn = () => SAMPLE_RESUME;
    diffResumeFn            = () => makeNonEmptyDiff();
    computeDeltaRatioFn     = () => ({ ratio: 0.1, changedCount: 3, totalCount: 30 });
    exceedsDeltaThresholdFn = () => true;
    diffToSuggestionsFn     = () => makeRawSuggestions(1);
    readSuggestionsDataFn   = async () => makeSuggestionsDoc(0);
    saveSuggestionsDataFn   = async () => { throw new Error("write error"); };
    saveSnapshotFn          = async () => { saveSnapshotCallCount++; return { snapshotKey: "x", url: "" }; };

    const result = await runResumeCandidateHook("2026-03-27", {});

    assert.ok(result.error, "error must be set when suggestions write fails");
    assert.equal(saveSnapshotCallCount, 0, "saveSnapshot must NOT be called when pipeline errors");

    clearEnv();
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: getLastApprovedSnapshot — retrieval utility
// ═══════════════════════════════════════════════════════════════════════════════

describe("getLastApprovedSnapshot — retrieval utility", () => {

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Build a Blob metadata entry (lightweight, no body). */
  function makeBlobMeta(snapshotKey, uploadedAt = "2026-03-27T12:00:00.000Z") {
    return { snapshotKey, url: `https://blob/${snapshotKey}`, uploadedAt, size: 1024 };
  }

  /** Build a full snapshot envelope. */
  function makeEnvelope(snapshotKey, triggeredBy = "approve", label = "approve") {
    return {
      schemaVersion: 1,
      snapshotKey,
      snapshotAt: "2026-03-27T12:00:00.000Z",
      label,
      trigger: triggeredBy,
      triggeredBy,
      resume: SAMPLE_RESUME
    };
  }

  // ── Empty store ───────────────────────────────────────────────────────────

  test("returns null when Blob has no snapshots", async () => {
    listSnapshotsFn    = async () => [];
    readSnapshotByKeyFn = async () => null;

    const result = await getLastApprovedSnapshot();
    assert.equal(result, null);
  });

  // ── Approval-triggered snapshots ──────────────────────────────────────────

  test("returns snapshot with triggeredBy 'approve' (user explicit approval)", async () => {
    const KEY = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    listSnapshotsFn     = async () => [makeBlobMeta(KEY)];
    readSnapshotByKeyFn = async () => makeEnvelope(KEY, "approve", "approve");

    const result = await getLastApprovedSnapshot();
    assert.ok(result, "must return an envelope");
    assert.equal(result.snapshotKey, KEY);
    assert.equal(result.triggeredBy, "approve");
  });

  test("returns snapshot with triggeredBy 'patch' (PATCH /candidates approval)", async () => {
    const KEY = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    listSnapshotsFn     = async () => [makeBlobMeta(KEY)];
    readSnapshotByKeyFn = async () => makeEnvelope(KEY, "patch", "approve");

    const result = await getLastApprovedSnapshot();
    assert.ok(result);
    assert.equal(result.triggeredBy, "patch");
  });

  test("returns snapshot with triggeredBy 'batch' (daily batch checkpoint, Sub-AC 10-1)", async () => {
    const KEY = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    listSnapshotsFn     = async () => [makeBlobMeta(KEY)];
    readSnapshotByKeyFn = async () => makeEnvelope(KEY, "batch", "batch");

    const result = await getLastApprovedSnapshot();
    assert.ok(result, "batch-triggered snapshot must be found");
    assert.equal(result.triggeredBy, "batch",
      "triggeredBy must be 'batch' (batch is in APPROVE_TRIGGERS as of Sub-AC 10-1)");
  });

  test("returns snapshot when label contains 'approve' regardless of triggeredBy", async () => {
    const KEY = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    listSnapshotsFn     = async () => [makeBlobMeta(KEY)];
    readSnapshotByKeyFn = async () => makeEnvelope(KEY, "unknown", "pre-approve");

    const result = await getLastApprovedSnapshot();
    assert.ok(result, "label-based match must work");
    assert.equal(result.label, "pre-approve");
  });

  // ── Rollback snapshots are skipped ────────────────────────────────────────

  test("skips rollback-triggered snapshots in first pass and returns null when all are rollback", async () => {
    const KEY1 = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    const KEY2 = "resume/snapshots/2026-03-26T12-00-00.000Z.json";

    listSnapshotsFn = async () => [
      makeBlobMeta(KEY1, "2026-03-27T12:00:00.000Z"),
      makeBlobMeta(KEY2, "2026-03-26T12:00:00.000Z")
    ];
    readSnapshotByKeyFn = async (key) => makeEnvelope(key, "rollback", "rollback");

    // Both are rollback — both passes should skip them → null
    const result = await getLastApprovedSnapshot();
    assert.equal(result, null, "must return null when all snapshots are rollback-triggered");
  });

  test("skips rollback-backup snapshots (triggeredBy 'rollback-backup')", async () => {
    const KEY = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    listSnapshotsFn     = async () => [makeBlobMeta(KEY)];
    readSnapshotByKeyFn = async () => makeEnvelope(KEY, "rollback-backup", "rollback-backup");

    const result = await getLastApprovedSnapshot();
    assert.equal(result, null, "rollback-backup must be skipped");
  });

  // ── Fallback: most recent non-rollback when no explicit approval found ──────

  test("falls back to most-recent non-rollback snapshot when none are explicitly approved", async () => {
    const KEY_OLD = "resume/snapshots/2026-03-26T12-00-00.000Z.json";
    const KEY_NEW = "resume/snapshots/2026-03-27T12-00-00.000Z.json";

    listSnapshotsFn = async () => [
      makeBlobMeta(KEY_NEW, "2026-03-27T12:00:00.000Z"),
      makeBlobMeta(KEY_OLD, "2026-03-26T12:00:00.000Z")
    ];
    // Neither is in APPROVE_TRIGGERS or has "approve" label
    readSnapshotByKeyFn = async (key) => makeEnvelope(key, "manual", "checkpoint");

    const result = await getLastApprovedSnapshot();
    assert.ok(result, "must return fallback snapshot");
    assert.equal(result.snapshotKey, KEY_NEW, "must return most-recent snapshot as fallback");
  });

  test("fallback skips rollback snapshots — returns first non-rollback", async () => {
    const KEY_ROLLBACK = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    const KEY_NORMAL   = "resume/snapshots/2026-03-26T12-00-00.000Z.json";

    listSnapshotsFn = async () => [
      makeBlobMeta(KEY_ROLLBACK, "2026-03-27T12:00:00.000Z"),
      makeBlobMeta(KEY_NORMAL,   "2026-03-26T12:00:00.000Z")
    ];
    readSnapshotByKeyFn = async (key) => {
      if (key === KEY_ROLLBACK) return makeEnvelope(key, "rollback", "rollback");
      return makeEnvelope(key, "manual", "manual");
    };

    const result = await getLastApprovedSnapshot();
    assert.ok(result, "must return non-rollback fallback");
    assert.equal(result.snapshotKey, KEY_NORMAL, "must skip rollback and return next");
  });

  // ── Batch snapshot takes first-pass precedence over older approval ─────────

  test("batch snapshot (most recent) found before older approval snapshot in first pass", async () => {
    const KEY_BATCH  = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    const KEY_APPROVE = "resume/snapshots/2026-03-26T12-00-00.000Z.json";

    listSnapshotsFn = async () => [
      makeBlobMeta(KEY_BATCH,  "2026-03-27T12:00:00.000Z"),
      makeBlobMeta(KEY_APPROVE,"2026-03-26T12:00:00.000Z")
    ];
    readSnapshotByKeyFn = async (key) => {
      if (key === KEY_BATCH)   return makeEnvelope(key, "batch",   "batch");
      if (key === KEY_APPROVE) return makeEnvelope(key, "approve", "approve");
      return null;
    };

    const result = await getLastApprovedSnapshot();
    assert.ok(result, "must return a snapshot");
    assert.equal(result.snapshotKey, KEY_BATCH,
      "most-recent batch snapshot must be returned first (batch is in APPROVE_TRIGGERS)");
  });

  // ── null envelope skipping ────────────────────────────────────────────────

  test("skips null envelopes and continues to next snapshot", async () => {
    const KEY_NULL = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    const KEY_GOOD = "resume/snapshots/2026-03-26T12-00-00.000Z.json";

    listSnapshotsFn = async () => [
      makeBlobMeta(KEY_NULL, "2026-03-27T12:00:00.000Z"),
      makeBlobMeta(KEY_GOOD, "2026-03-26T12:00:00.000Z")
    ];
    readSnapshotByKeyFn = async (key) => {
      if (key === KEY_NULL) return null; // not found / deleted
      return makeEnvelope(key, "approve", "approve");
    };

    const result = await getLastApprovedSnapshot();
    assert.ok(result, "must skip null and return next good snapshot");
    assert.equal(result.snapshotKey, KEY_GOOD);
  });

  // ── deltaFromLastApproved convenience wrapper ─────────────────────────────

  test("deltaFromLastApproved returns { snapshot: null, delta.isEmpty: true } when no snapshots", async () => {
    listSnapshotsFn     = async () => [];
    readSnapshotByKeyFn = async () => null;

    const { snapshot, delta } = await deltaFromLastApproved(SAMPLE_RESUME);
    assert.equal(snapshot, null);
    assert.equal(delta.isEmpty, false, "delta from null vs full profile is not empty");
    assert.equal(delta.rate, 1, "delta rate should be 1 when prev is null");
  });

  test("deltaFromLastApproved returns delta comparing snapshot resume to current", async () => {
    const KEY = "resume/snapshots/2026-03-27T12-00-00.000Z.json";
    const snapshotResume = { ...SAMPLE_RESUME, summary: "Old summary." };

    listSnapshotsFn     = async () => [makeBlobMeta(KEY)];
    readSnapshotByKeyFn = async () => makeEnvelope(KEY, "batch", "batch");

    // Override snapshot resume to differ from SAMPLE_RESUME
    const envelopeWithDiff = {
      ...makeEnvelope(KEY, "batch", "batch"),
      resume: snapshotResume
    };
    readSnapshotByKeyFn = async () => envelopeWithDiff;

    const currentProfile = { ...SAMPLE_RESUME, summary: "New summary." };
    const { snapshot, delta } = await deltaFromLastApproved(currentProfile);

    assert.ok(snapshot, "snapshot must be found");
    assert.equal(snapshot.triggeredBy, "batch");
    assert.equal(delta.isEmpty, false, "delta must detect summary change");
    assert.ok(delta.rate > 0, "rate must be > 0 for changed profile");
    assert.equal(delta.breakdown.summary.changed, 1, "summary change must be in breakdown");
  });

  test("deltaFromLastApproved returns isEmpty:true for identical profiles", async () => {
    const KEY = "resume/snapshots/2026-03-27T12-00-00.000Z.json";

    // Reset diffResumeFn to return an empty diff for identical profiles.
    // The mock is shared across suites; previous Suite 1 tests may have left
    // it set to makeNonEmptyDiff(). We explicitly set an empty diff here.
    diffResumeFn = () => ({
      isEmpty: true,
      contact: { added: {}, modified: {}, deleted: {} },
      summary: { changed: false },
      experience: { added: [], deleted: [], modified: [] },
      education: { added: [], deleted: [], modified: [] },
      skills: {
        technical: { added: [], deleted: [] },
        languages: { added: [], deleted: [] },
        tools: { added: [], deleted: [] }
      },
      projects: { added: [], deleted: [], modified: [] },
      certifications: { added: [], deleted: [], modified: [] },
      strength_keywords: { added: [], deleted: [] },
      display_axes: { added: [], deleted: [], modified: [] }
    });

    listSnapshotsFn     = async () => [makeBlobMeta(KEY)];
    readSnapshotByKeyFn = async () => ({
      ...makeEnvelope(KEY, "approve", "approve"),
      resume: SAMPLE_RESUME
    });

    const { snapshot, delta } = await deltaFromLastApproved(SAMPLE_RESUME);
    assert.ok(snapshot);
    assert.equal(delta.isEmpty, true, "identical profiles → isEmpty true");
    assert.equal(delta.rate, 0);
  });

});
