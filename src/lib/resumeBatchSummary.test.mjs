import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBatchSummary,
  buildCandidateFollowUp,
  isValidCandidateDiscardReason,
  withLiveDraftState,
} from "./resumeBatchSummary.mjs";

function makeSummary() {
  return {
    counts: {
      gitCommits: 12,
      slackContexts: 5,
      codexSessions: 2,
      claudeSessions: 1,
      shellCommands: 7,
    },
  };
}

test("buildBatchSummary maps source counts and candidate preview", () => {
  const result = buildBatchSummary({
    date: "2026-04-21",
    summary: makeSummary(),
    candidateHook: {
      skipped: false,
      generated: 2,
      superseded: 1,
      deltaRatio: 0.08,
      draftGenerationTriggered: true,
    },
    suggestionsDoc: {
      suggestions: [
        { id: "a", status: "pending", logDate: "2026-04-21", section: "experience", action: "append_bullet", description: "desc-a" },
        { id: "b", status: "pending", logDate: "2026-04-21", section: "summary", action: "update_summary", description: "desc-b" },
        { id: "c", status: "approved", logDate: "2026-04-21", description: "ignored" },
      ],
    },
  });

  assert.equal(result.sourceCounts.gitCommits, 12);
  assert.equal(result.sourceCounts.sessions, 3);
  assert.equal(result.candidateGeneration.status, "generated");
  assert.equal(result.candidatePreview.length, 2);
  assert.equal(result.draft.status, "pending");
  assert.equal(result.emptyState, null);
});

test("buildBatchSummary produces below-threshold empty state", () => {
  const result = buildBatchSummary({
    date: "2026-04-21",
    summary: makeSummary(),
    candidateHook: {
      skipped: false,
      belowThreshold: true,
      generated: 0,
      superseded: 0,
      deltaRatio: 0.018,
      deltaChangedCount: 1,
      deltaTotalCount: 55,
      draftGenerationTriggered: true,
    },
    suggestionsDoc: { suggestions: [] },
  });

  assert.equal(result.candidateGeneration.status, "below_threshold");
  assert.equal(result.emptyState.reasonCode, "below_threshold");
  assert.match(result.emptyState.body, /1\.8%/);
});

test("withLiveDraftState replaces stored draft state", () => {
  const stored = buildBatchSummary({
    date: "2026-04-21",
    summary: makeSummary(),
    candidateHook: { skipped: false, generated: 0, superseded: 0, draftGenerationTriggered: true },
    suggestionsDoc: { suggestions: [] },
  });

  const merged = withLiveDraftState(stored, { status: "completed", triggeredBy: "batch" });
  assert.equal(merged.draft.status, "completed");
  assert.equal(merged.draft.triggeredBy, "batch");
});

test("isValidCandidateDiscardReason accepts only known reason codes", () => {
  assert.equal(isValidCandidateDiscardReason("missing_metric"), true);
  assert.equal(isValidCandidateDiscardReason("something_else"), false);
  assert.equal(isValidCandidateDiscardReason(null), false);
});

test("buildCandidateFollowUp returns missing metric guidance with contextual prompts", () => {
  const followUp = buildCandidateFollowUp({
    reasonCode: "missing_metric",
    note: "성과 수치 확인 필요",
    candidate: {
      section: "experience",
      action: "append_bullet",
      description: "Acme Corp: 장애 대응 자동화 개선",
    },
  });

  assert.equal(followUp.kind, "missing_metric");
  assert.equal(followUp.note, "성과 수치 확인 필요");
  assert.equal(followUp.actions[0].href, "/resume/chat");
  assert.equal(followUp.questions.length, 3);
  assert.match(followUp.questions[0], /Acme Corp/);
});

test("buildCandidateFollowUp returns null for non-missing-metric discards", () => {
  const followUp = buildCandidateFollowUp({
    reasonCode: "duplicate",
    candidate: { section: "experience", description: "ignored" },
  });

  assert.equal(followUp, null);
});
