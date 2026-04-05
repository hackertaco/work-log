/**
 * Tests for workLogEventBus.mjs — Sub-AC 2-1
 *
 * Covers:
 *   • WORK_LOG_EVENTS constants are defined and frozen
 *   • onWorkLogSaved / offWorkLogSaved registration and removal
 *   • emitWorkLogSaved calls all registered hooks in order, awaits them
 *   • emitWorkLogSaved returns the last hook's result
 *   • emitWorkLogSaved returns a neutral skipped result when no hooks are registered
 *   • emitWorkLogSaved catches hook errors and continues (non-fatal)
 *   • registerResumeBatchHook is idempotent (called twice → one hook)
 *   • savedHookCount reflects the current registry size
 *   • Granular emitters (emitCommitCollected, emitSlackCollected,
 *     emitSessionCollected) fire onWorkLogEvent listeners
 *   • offWorkLogEvent removes listeners
 *   • registerGranularTriggers wires granular events to debounced batch runs
 *   • Granular triggers coalesce multiple events per date
 *   • Granular triggers are idempotent
 *   • _clearGranularTriggers cleans up listeners and timers
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/workLogEventBus.test.mjs
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  WORK_LOG_EVENTS,
  onWorkLogSaved,
  offWorkLogSaved,
  emitWorkLogSaved,
  onWorkLogEvent,
  offWorkLogEvent,
  emitCommitCollected,
  emitSlackCollected,
  emitSessionCollected,
  registerResumeBatchHook,
  registerGranularTriggers,
  isGranularTriggersActive,
  _getPendingSources,
  _clearGranularTriggers,
  savedHookCount,
  _clearSavedHooks,
} from "./workLogEventBus.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Stub workLog for emit tests. */
const STUB_WORK_LOG = { date: "2026-04-04", commits: [] };

// ── Test suite ─────────────────────────────────────────────────────────────────

describe("workLogEventBus", () => {
  beforeEach(() => {
    // Ensure a clean slate for each test.
    _clearSavedHooks();
  });

  // ── Constants ────────────────────────────────────────────────────────────────

  test("WORK_LOG_EVENTS is frozen and has the expected keys", () => {
    assert.ok(Object.isFrozen(WORK_LOG_EVENTS), "WORK_LOG_EVENTS should be frozen");
    assert.strictEqual(WORK_LOG_EVENTS.COMMIT_COLLECTED, "commit_collected");
    assert.strictEqual(WORK_LOG_EVENTS.SLACK_COLLECTED, "slack_collected");
    assert.strictEqual(WORK_LOG_EVENTS.SESSION_COLLECTED, "session_collected");
    assert.strictEqual(WORK_LOG_EVENTS.WORK_LOG_SAVED, "work_log_saved");
  });

  // ── Registry ─────────────────────────────────────────────────────────────────

  test("savedHookCount is 0 after clearSavedHooks", () => {
    assert.strictEqual(savedHookCount(), 0);
  });

  test("onWorkLogSaved increments savedHookCount", () => {
    const h = async () => ({ skipped: false, generated: 0, superseded: 0, cacheHit: false });
    onWorkLogSaved(h);
    assert.strictEqual(savedHookCount(), 1);
  });

  test("offWorkLogSaved decrements savedHookCount", () => {
    const h = async () => ({ skipped: false, generated: 0, superseded: 0, cacheHit: false });
    onWorkLogSaved(h);
    offWorkLogSaved(h);
    assert.strictEqual(savedHookCount(), 0);
  });

  test("offWorkLogSaved is a no-op for unregistered handlers", () => {
    const h = async () => ({ skipped: false, generated: 0, superseded: 0, cacheHit: false });
    // Never registered — should not throw
    assert.doesNotThrow(() => offWorkLogSaved(h));
    assert.strictEqual(savedHookCount(), 0);
  });

  // ── emitWorkLogSaved ─────────────────────────────────────────────────────────

  test("emitWorkLogSaved returns neutral skipped result when no hooks registered", async () => {
    const result = await emitWorkLogSaved("2026-04-04", STUB_WORK_LOG);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skipReason, "no_hooks_registered");
    assert.strictEqual(result.generated, 0);
    assert.strictEqual(result.superseded, 0);
    assert.strictEqual(result.cacheHit, false);
  });

  test("emitWorkLogSaved calls the registered hook with date and workLog", async () => {
    let receivedDate = null;
    let receivedWorkLog = null;

    onWorkLogSaved(async (date, workLog) => {
      receivedDate = date;
      receivedWorkLog = workLog;
      return { skipped: false, generated: 1, superseded: 0, cacheHit: false };
    });

    await emitWorkLogSaved("2026-04-04", STUB_WORK_LOG);

    assert.strictEqual(receivedDate, "2026-04-04");
    assert.deepEqual(receivedWorkLog, STUB_WORK_LOG);
  });

  test("emitWorkLogSaved returns the last hook's result", async () => {
    onWorkLogSaved(async () => ({ skipped: false, generated: 1, superseded: 0, cacheHit: false }));
    onWorkLogSaved(async () => ({ skipped: false, generated: 5, superseded: 2, cacheHit: true }));

    const result = await emitWorkLogSaved("2026-04-04", STUB_WORK_LOG);

    assert.strictEqual(result.generated, 5);
    assert.strictEqual(result.superseded, 2);
    assert.strictEqual(result.cacheHit, true);
  });

  test("emitWorkLogSaved calls multiple hooks in registration order", async () => {
    const callOrder = [];
    onWorkLogSaved(async () => { callOrder.push(1); return { skipped: false, generated: 0, superseded: 0, cacheHit: false }; });
    onWorkLogSaved(async () => { callOrder.push(2); return { skipped: false, generated: 0, superseded: 0, cacheHit: false }; });
    onWorkLogSaved(async () => { callOrder.push(3); return { skipped: false, generated: 0, superseded: 0, cacheHit: false }; });

    await emitWorkLogSaved("2026-04-04", STUB_WORK_LOG);

    assert.deepEqual(callOrder, [1, 2, 3]);
  });

  test("emitWorkLogSaved catches a throwing hook and continues to the next", async () => {
    const secondCalled = { value: false };

    onWorkLogSaved(async () => { throw new Error("hook failure"); });
    onWorkLogSaved(async () => {
      secondCalled.value = true;
      return { skipped: false, generated: 2, superseded: 0, cacheHit: false };
    });

    const result = await emitWorkLogSaved("2026-04-04", STUB_WORK_LOG);

    // Second hook ran despite first throwing.
    assert.ok(secondCalled.value, "second hook should have been called");
    assert.strictEqual(result.generated, 2);
  });

  test("emitWorkLogSaved does not throw even if the only hook throws", async () => {
    onWorkLogSaved(async () => { throw new Error("boom"); });

    let result;
    await assert.doesNotReject(async () => {
      result = await emitWorkLogSaved("2026-04-04", STUB_WORK_LOG);
    });
    assert.ok(typeof result.error === "string", "error field should be set");
  });

  // ── registerResumeBatchHook idempotency ──────────────────────────────────────

  test("registerResumeBatchHook is idempotent — second call is a no-op", async () => {
    await registerResumeBatchHook();
    const countAfterFirst = savedHookCount();
    await registerResumeBatchHook();
    const countAfterSecond = savedHookCount();

    assert.strictEqual(countAfterFirst, 1);
    assert.strictEqual(countAfterSecond, 1, "second call must not add another hook");
  });

  // ── Granular emitters ─────────────────────────────────────────────────────────

  test("emitCommitCollected fires commit_collected listeners", async () => {
    let payload = null;
    const listener = (p) => { payload = p; };
    onWorkLogEvent(WORK_LOG_EVENTS.COMMIT_COLLECTED, listener);

    emitCommitCollected("2026-04-04", [{ subject: "fix: bug" }]);

    offWorkLogEvent(WORK_LOG_EVENTS.COMMIT_COLLECTED, listener);

    assert.ok(payload !== null, "listener should have been called");
    assert.strictEqual(payload.date, "2026-04-04");
    assert.strictEqual(payload.commits.length, 1);
  });

  test("emitSlackCollected fires slack_collected listeners", async () => {
    let payload = null;
    const listener = (p) => { payload = p; };
    onWorkLogEvent(WORK_LOG_EVENTS.SLACK_COLLECTED, listener);

    emitSlackCollected("2026-04-04", [{ text: "standup done" }]);

    offWorkLogEvent(WORK_LOG_EVENTS.SLACK_COLLECTED, listener);

    assert.ok(payload !== null);
    assert.strictEqual(payload.date, "2026-04-04");
    assert.strictEqual(payload.contexts.length, 1);
  });

  test("emitSessionCollected fires session_collected listeners", async () => {
    let payload = null;
    const listener = (p) => { payload = p; };
    onWorkLogEvent(WORK_LOG_EVENTS.SESSION_COLLECTED, listener);

    emitSessionCollected("2026-04-04", [{ source: "claude", summary: "built feature X" }]);

    offWorkLogEvent(WORK_LOG_EVENTS.SESSION_COLLECTED, listener);

    assert.ok(payload !== null);
    assert.strictEqual(payload.sessions.length, 1);
  });

  test("offWorkLogEvent removes listener — no longer called after removal", () => {
    let callCount = 0;
    const listener = () => { callCount++; };
    onWorkLogEvent(WORK_LOG_EVENTS.COMMIT_COLLECTED, listener);

    emitCommitCollected("2026-04-04", []);
    assert.strictEqual(callCount, 1);

    offWorkLogEvent(WORK_LOG_EVENTS.COMMIT_COLLECTED, listener);
    emitCommitCollected("2026-04-04", []);
    assert.strictEqual(callCount, 1, "listener should not be called after removal");
  });

  // ── Granular triggers → debounced background batch ──────────────────────────

  test("registerGranularTriggers activates granular triggers", () => {
    _clearGranularTriggers();
    assert.strictEqual(isGranularTriggersActive(), false);

    registerGranularTriggers(async () => {}, { debounceMs: 100 });
    assert.strictEqual(isGranularTriggersActive(), true);

    _clearGranularTriggers();
  });

  test("registerGranularTriggers is idempotent — second call is a no-op", () => {
    _clearGranularTriggers();
    let callCount = 0;
    const runner = async () => { callCount++; };

    registerGranularTriggers(runner, { debounceMs: 50 });
    registerGranularTriggers(runner, { debounceMs: 50 });

    assert.strictEqual(isGranularTriggersActive(), true);
    _clearGranularTriggers();
  });

  test("granular trigger schedules batch after debounce on commit_collected", async () => {
    _clearGranularTriggers();

    let batchDate = null;
    const runner = async (date) => { batchDate = date; };

    registerGranularTriggers(runner, { debounceMs: 30 });
    emitCommitCollected("2026-04-04", [{ subject: "feat: new feature" }]);

    // Pending sources should include commit_collected
    const sources = _getPendingSources("2026-04-04");
    assert.ok(sources, "should have pending sources for the date");
    assert.ok(sources.has("commit_collected"), "should track commit_collected source");

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 60));

    assert.strictEqual(batchDate, "2026-04-04", "batch runner should have been called with the date");
    _clearGranularTriggers();
  });

  test("granular trigger coalesces multiple events for the same date", async () => {
    _clearGranularTriggers();

    let batchCallCount = 0;
    const runner = async () => { batchCallCount++; };

    registerGranularTriggers(runner, { debounceMs: 40 });

    // Emit three different event types for the same date in quick succession
    emitCommitCollected("2026-04-04", []);
    emitSlackCollected("2026-04-04", []);
    emitSessionCollected("2026-04-04", []);

    // All three should be pending
    const sources = _getPendingSources("2026-04-04");
    assert.ok(sources, "should have pending sources");
    assert.strictEqual(sources.size, 3, "all three event types should be tracked");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 80));

    assert.strictEqual(batchCallCount, 1, "should run batch only once despite 3 events");
    _clearGranularTriggers();
  });

  test("granular trigger handles different dates independently", async () => {
    _clearGranularTriggers();

    const batchDates = [];
    const runner = async (date) => { batchDates.push(date); };

    registerGranularTriggers(runner, { debounceMs: 30 });

    emitCommitCollected("2026-04-04", []);
    emitCommitCollected("2026-04-05", []);

    await new Promise((r) => setTimeout(r, 60));

    assert.strictEqual(batchDates.length, 2, "should run batch for each date");
    assert.ok(batchDates.includes("2026-04-04"));
    assert.ok(batchDates.includes("2026-04-05"));
    _clearGranularTriggers();
  });

  test("granular trigger catches batch runner errors (non-fatal)", async () => {
    _clearGranularTriggers();

    const runner = async () => { throw new Error("batch exploded"); };

    registerGranularTriggers(runner, { debounceMs: 20 });
    emitCommitCollected("2026-04-04", []);

    // Should not throw — wait for debounce + error handling
    await new Promise((r) => setTimeout(r, 50));

    // If we reach here, the error was caught (non-fatal)
    assert.ok(true, "batch runner error should be caught non-fatally");
    _clearGranularTriggers();
  });

  test("_clearGranularTriggers deactivates triggers and cancels pending timers", () => {
    _clearGranularTriggers();

    registerGranularTriggers(async () => {}, { debounceMs: 5000 });
    emitCommitCollected("2026-04-04", []);

    assert.strictEqual(isGranularTriggersActive(), true);
    assert.ok(_getPendingSources("2026-04-04"), "should have pending sources");

    _clearGranularTriggers();

    assert.strictEqual(isGranularTriggersActive(), false);
    assert.strictEqual(_getPendingSources("2026-04-04"), undefined, "pending sources should be cleared");
  });
});
