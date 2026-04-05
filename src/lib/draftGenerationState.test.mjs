/**
 * Unit tests for draftGenerationState.mjs — In-Memory Background Task Tracker.
 *
 * Covers:
 *   - State lifecycle: idle → pending → completed | failed
 *   - Progress updates during pending state
 *   - Task ID validation (no-op on mismatched IDs)
 *   - Stale task auto-fail detection
 *   - Reset to idle
 *   - Superseding a pending task with a new one
 *
 * Run with:
 *   node --test src/lib/draftGenerationState.test.mjs
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  getDraftGenerationState,
  markDraftGenerationPending,
  updateDraftGenerationProgress,
  markDraftGenerationCompleted,
  markDraftGenerationFailed,
  resetDraftGenerationState,
  isDraftGenerationInProgress,
} from "./draftGenerationState.mjs";

// Reset state before each test to ensure isolation
beforeEach(() => {
  resetDraftGenerationState();
});

// ─── Initial state ──────────────────────────────────────────────────────────

test("초기 상태는 idle이어야 한다", () => {
  const state = getDraftGenerationState();
  assert.equal(state.status, "idle");
  assert.equal(state.taskId, null);
  assert.equal(state.startedAt, null);
  assert.equal(state.completedAt, null);
  assert.equal(state.error, null);
  assert.equal(state.progress, null);
  assert.equal(state.triggeredBy, null);
});

test("getDraftGenerationState는 원본이 아닌 복사본을 반환해야 한다", () => {
  const state1 = getDraftGenerationState();
  const state2 = getDraftGenerationState();
  assert.notEqual(state1, state2, "매 호출마다 새 객체여야 한다");
});

// ─── Pending state ──────────────────────────────────────────────────────────

test("markDraftGenerationPending는 status를 pending으로 전환한다", () => {
  const taskId = markDraftGenerationPending("api");

  assert.ok(taskId, "taskId가 반환되어야 한다");
  assert.ok(taskId.startsWith("draft-"), "taskId가 'draft-'로 시작해야 한다");

  const state = getDraftGenerationState();
  assert.equal(state.status, "pending");
  assert.equal(state.taskId, taskId);
  assert.ok(state.startedAt, "startedAt이 설정되어야 한다");
  assert.equal(state.completedAt, null);
  assert.equal(state.error, null);
  assert.equal(state.triggeredBy, "api");
  assert.deepEqual(state.progress, { stage: "initializing" });
});

test("markDraftGenerationPending에 triggeredBy를 전달할 수 있다", () => {
  markDraftGenerationPending("batch");
  assert.equal(getDraftGenerationState().triggeredBy, "batch");

  resetDraftGenerationState();
  markDraftGenerationPending("manual");
  assert.equal(getDraftGenerationState().triggeredBy, "manual");
});

test("markDraftGenerationPending는 기본 triggeredBy가 'api'이다", () => {
  markDraftGenerationPending();
  assert.equal(getDraftGenerationState().triggeredBy, "api");
});

test("새 pending 요청은 이전 pending 작업을 대체한다", () => {
  const taskId1 = markDraftGenerationPending("api");
  const taskId2 = markDraftGenerationPending("batch");

  assert.notEqual(taskId1, taskId2, "taskId가 달라야 한다");
  const state = getDraftGenerationState();
  assert.equal(state.taskId, taskId2, "최신 taskId여야 한다");
  assert.equal(state.triggeredBy, "batch");
});

// ─── Progress updates ───────────────────────────────────────────────────────

test("updateDraftGenerationProgress는 pending 상태에서 progress를 업데이트한다", () => {
  const taskId = markDraftGenerationPending("api");

  updateDraftGenerationProgress(taskId, { stage: "loading_work_logs", datesLoaded: 10 });

  const state = getDraftGenerationState();
  assert.equal(state.progress.stage, "loading_work_logs");
  assert.equal(state.progress.datesLoaded, 10);
});

test("updateDraftGenerationProgress는 기존 progress에 병합한다", () => {
  const taskId = markDraftGenerationPending("api");

  updateDraftGenerationProgress(taskId, { stage: "loading_work_logs", datesLoaded: 5 });
  updateDraftGenerationProgress(taskId, { commitCount: 42 });

  const state = getDraftGenerationState();
  assert.equal(state.progress.stage, "loading_work_logs");
  assert.equal(state.progress.datesLoaded, 5);
  assert.equal(state.progress.commitCount, 42);
});

test("updateDraftGenerationProgress는 taskId가 다르면 무시한다", () => {
  const taskId = markDraftGenerationPending("api");
  updateDraftGenerationProgress(taskId, { stage: "loading" });

  // 다른 taskId로 업데이트 시도
  updateDraftGenerationProgress("wrong-task-id", { stage: "hacked" });

  const state = getDraftGenerationState();
  assert.equal(state.progress.stage, "loading", "taskId가 다르면 업데이트되지 않아야 한다");
});

test("updateDraftGenerationProgress는 pending이 아닌 상태에서 무시한다", () => {
  const taskId = markDraftGenerationPending("api");
  markDraftGenerationCompleted(taskId);

  // completed 상태에서 업데이트 시도
  updateDraftGenerationProgress(taskId, { stage: "should_not_update" });

  const state = getDraftGenerationState();
  assert.equal(state.progress.stage, "done", "completed 상태에서는 progress가 변경되지 않아야 한다");
});

// ─── Completed state ────────────────────────────────────────────────────────

test("markDraftGenerationCompleted는 status를 completed로 전환한다", () => {
  const taskId = markDraftGenerationPending("api");
  updateDraftGenerationProgress(taskId, { stage: "calling_llm", commitCount: 10 });

  markDraftGenerationCompleted(taskId);

  const state = getDraftGenerationState();
  assert.equal(state.status, "completed");
  assert.ok(state.completedAt, "completedAt이 설정되어야 한다");
  assert.equal(state.error, null);
  assert.equal(state.progress.stage, "done");
  // 기존 progress 메타데이터가 유지되어야 한다
  assert.equal(state.progress.commitCount, 10);
});

test("markDraftGenerationCompleted는 taskId가 다르면 무시한다", () => {
  const taskId = markDraftGenerationPending("api");
  markDraftGenerationCompleted("wrong-task-id");

  const state = getDraftGenerationState();
  assert.equal(state.status, "pending", "taskId가 다르면 상태가 변경되지 않아야 한다");
});

// ─── Failed state ───────────────────────────────────────────────────────────

test("markDraftGenerationFailed는 status를 failed로 전환하고 에러 메시지를 저장한다", () => {
  const taskId = markDraftGenerationPending("api");

  markDraftGenerationFailed(taskId, "LLM call timed out");

  const state = getDraftGenerationState();
  assert.equal(state.status, "failed");
  assert.ok(state.completedAt, "completedAt이 설정되어야 한다");
  assert.equal(state.error, "LLM call timed out");
  assert.equal(state.progress.stage, "failed");
});

test("markDraftGenerationFailed는 taskId가 다르면 무시한다", () => {
  const taskId = markDraftGenerationPending("api");
  markDraftGenerationFailed("wrong-task-id", "should not fail");

  const state = getDraftGenerationState();
  assert.equal(state.status, "pending", "taskId가 다르면 상태가 변경되지 않아야 한다");
  assert.equal(state.error, null);
});

// ─── Reset ──────────────────────────────────────────────────────────────────

test("resetDraftGenerationState는 상태를 idle로 초기화한다", () => {
  const taskId = markDraftGenerationPending("api");
  markDraftGenerationCompleted(taskId);

  resetDraftGenerationState();

  const state = getDraftGenerationState();
  assert.equal(state.status, "idle");
  assert.equal(state.taskId, null);
  assert.equal(state.startedAt, null);
  assert.equal(state.completedAt, null);
  assert.equal(state.error, null);
  assert.equal(state.progress, null);
  assert.equal(state.triggeredBy, null);
});

test("resetDraftGenerationState는 failed 상태에서도 idle로 초기화한다", () => {
  const taskId = markDraftGenerationPending("api");
  markDraftGenerationFailed(taskId, "test error");

  resetDraftGenerationState();

  const state = getDraftGenerationState();
  assert.equal(state.status, "idle");
  assert.equal(state.error, null);
});

// ─── isDraftGenerationInProgress ────────────────────────────────────────────

test("isDraftGenerationInProgress는 idle 상태에서 false를 반환한다", () => {
  assert.equal(isDraftGenerationInProgress(), false);
});

test("isDraftGenerationInProgress는 pending 상태에서 true를 반환한다", () => {
  markDraftGenerationPending("api");
  assert.equal(isDraftGenerationInProgress(), true);
});

test("isDraftGenerationInProgress는 completed 상태에서 false를 반환한다", () => {
  const taskId = markDraftGenerationPending("api");
  markDraftGenerationCompleted(taskId);
  assert.equal(isDraftGenerationInProgress(), false);
});

test("isDraftGenerationInProgress는 failed 상태에서 false를 반환한다", () => {
  const taskId = markDraftGenerationPending("api");
  markDraftGenerationFailed(taskId, "error");
  assert.equal(isDraftGenerationInProgress(), false);
});

test("isDraftGenerationInProgress는 5분 이내 pending 작업을 in-progress로 보고한다", () => {
  markDraftGenerationPending("api");
  assert.equal(isDraftGenerationInProgress(), true);
});

test("isDraftGenerationInProgress는 5분 이상 된 pending 작업을 자동으로 실패 처리한다", () => {
  // Date.now를 오버라이드하여 시간 경과를 시뮬레이션한다.
  const originalDateNow = Date.now;

  try {
    // 6분 전(360초)에 시작된 것처럼 보이도록 설정
    const fakeStartTime = originalDateNow.call(Date);
    Date.now = () => fakeStartTime;

    const taskId = markDraftGenerationPending("api");
    assert.equal(isDraftGenerationInProgress(), true, "방금 생성된 작업은 in-progress여야 한다");

    // 6분 후로 시간을 이동
    Date.now = () => fakeStartTime + 6 * 60 * 1000;

    // isDraftGenerationInProgress가 stale 작업을 자동으로 실패 처리해야 한다
    assert.equal(isDraftGenerationInProgress(), false, "5분 초과된 작업은 in-progress가 아니어야 한다");

    const state = getDraftGenerationState();
    assert.equal(state.status, "failed", "stale 작업은 failed 상태로 전환되어야 한다");
    assert.ok(state.error.includes("timed out"), "에러 메시지에 'timed out'이 포함되어야 한다");
    assert.equal(state.taskId, taskId, "taskId가 보존되어야 한다");
  } finally {
    Date.now = originalDateNow;
  }
});

// ─── Full lifecycle ─────────────────────────────────────────────────────────

test("전체 라이프사이클: idle → pending → progress → completed → reset → idle", () => {
  // 1. idle
  assert.equal(getDraftGenerationState().status, "idle");

  // 2. pending
  const taskId = markDraftGenerationPending("api");
  assert.equal(getDraftGenerationState().status, "pending");
  assert.equal(isDraftGenerationInProgress(), true);

  // 3. progress updates
  updateDraftGenerationProgress(taskId, { stage: "loading_work_logs", datesLoaded: 30 });
  updateDraftGenerationProgress(taskId, { stage: "calling_llm", commitCount: 42 });
  assert.equal(getDraftGenerationState().progress.stage, "calling_llm");
  assert.equal(getDraftGenerationState().progress.commitCount, 42);
  assert.equal(getDraftGenerationState().progress.datesLoaded, 30);

  // 4. completed
  markDraftGenerationCompleted(taskId);
  assert.equal(getDraftGenerationState().status, "completed");
  assert.equal(isDraftGenerationInProgress(), false);

  // 5. reset
  resetDraftGenerationState();
  assert.equal(getDraftGenerationState().status, "idle");
});

test("전체 라이프사이클: idle → pending → progress → failed → reset → idle", () => {
  // 1. idle
  assert.equal(getDraftGenerationState().status, "idle");

  // 2. pending
  const taskId = markDraftGenerationPending("batch");
  assert.equal(getDraftGenerationState().status, "pending");

  // 3. progress updates
  updateDraftGenerationProgress(taskId, { stage: "collecting_evidence" });

  // 4. failed
  markDraftGenerationFailed(taskId, "OPENAI_API_KEY is not set");
  assert.equal(getDraftGenerationState().status, "failed");
  assert.equal(getDraftGenerationState().error, "OPENAI_API_KEY is not set");

  // 5. reset
  resetDraftGenerationState();
  assert.equal(getDraftGenerationState().status, "idle");
  assert.equal(getDraftGenerationState().error, null);
});

// ─── Concurrent task handling ────────────────────────────────────────────────

test("pending 중 새 pending을 생성하면 이전 taskId의 completed/failed가 무시된다", () => {
  const taskId1 = markDraftGenerationPending("api");
  const taskId2 = markDraftGenerationPending("batch");

  // 이전 taskId로 complete 시도 → 무시
  markDraftGenerationCompleted(taskId1);
  assert.equal(getDraftGenerationState().status, "pending", "대체된 taskId의 완료는 무시되어야 한다");
  assert.equal(getDraftGenerationState().taskId, taskId2);

  // 이전 taskId로 fail 시도 → 무시
  markDraftGenerationFailed(taskId1, "old error");
  assert.equal(getDraftGenerationState().status, "pending", "대체된 taskId의 실패도 무시되어야 한다");
  assert.equal(getDraftGenerationState().error, null);

  // 현재 taskId로 complete → 정상 반영
  markDraftGenerationCompleted(taskId2);
  assert.equal(getDraftGenerationState().status, "completed");
});

test("stale 자동 실패 후 새 pending을 다시 시작할 수 있다", () => {
  const originalDateNow = Date.now;

  try {
    const baseTime = originalDateNow.call(Date);
    Date.now = () => baseTime;

    markDraftGenerationPending("api");

    // 6분 후 — stale 자동 실패
    // markDraftGenerationPending은 new Date().toISOString()을 사용하므로
    // startedAt은 실제 시간(≈baseTime)이다.
    // Date.now를 6분 후로 설정하면 elapsed > 5분 → stale
    Date.now = () => baseTime + 6 * 60 * 1000;
    assert.equal(isDraftGenerationInProgress(), false);
    assert.equal(getDraftGenerationState().status, "failed");

    // 새 작업 시작 가능 — Date.now를 현재 시간으로 복원하여
    // 새 작업의 startedAt과 Date.now가 일치하도록 한다
    Date.now = originalDateNow;
    const newTaskId = markDraftGenerationPending("manual");
    assert.equal(getDraftGenerationState().status, "pending");
    assert.equal(getDraftGenerationState().taskId, newTaskId);
    assert.equal(isDraftGenerationInProgress(), true);
  } finally {
    Date.now = originalDateNow;
  }
});

// ─── Progress snapshot isolation ────────────────────────────────────────────

test("getDraftGenerationState의 progress 객체를 수정해도 내부 상태에 영향이 없어야 한다", () => {
  const taskId = markDraftGenerationPending("api");
  updateDraftGenerationProgress(taskId, { stage: "loading", datesLoaded: 5 });

  const snapshot = getDraftGenerationState();
  snapshot.progress.stage = "tampered";
  snapshot.progress.datesLoaded = 999;

  const fresh = getDraftGenerationState();
  assert.equal(fresh.progress.stage, "loading", "내부 progress가 변경되면 안 된다");
  assert.equal(fresh.progress.datesLoaded, 5);
});
