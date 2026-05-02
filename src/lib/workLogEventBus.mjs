/**
 * Work-Log Event Bus — Sub-AC 2-1
 *
 * Lightweight in-process event bus that connects work-log update events
 * (commit collected, slack collected, session collected, work log saved) to
 * registered hook functions, most notably resumeBatchHook.
 *
 * Architecture:
 *   • Granular emit functions for each data-collection stage so that listeners
 *     can react to individual signals even before the full summary is built.
 *   • A hook registry for WORK_LOG_SAVED that runs awaitable async handlers in
 *     registration order and returns the last handler's result to the caller.
 *   • `registerResumeBatchHook()` is the canonical way to wire the daily resume
 *     candidate pipeline into the event flow.  It is idempotent and safe to
 *     call from both server startup and the CLI batch runner.
 *
 * Usage (server / CLI startup):
 *   import { registerResumeBatchHook } from "./workLogEventBus.mjs";
 *   await registerResumeBatchHook();
 *
 * Usage (batch runner — replacing the direct hook call):
 *   import { emitWorkLogSaved } from "./workLogEventBus.mjs";
 *   const hookResult = await emitWorkLogSaved(date, summary);
 *
 * Usage (granular events — informational, emitted from batch.mjs after each
 * collection stage):
 *   emitCommitCollected(date, commits);
 *   emitSlackCollected(date, contexts);
 *   emitSessionCollected(date, sessions);
 */

import { EventEmitter } from "node:events";

// ── Event type constants ─────────────────────────────────────────────────────────

/**
 * Named work-log event types.
 *
 * COMMIT_COLLECTED  — emitted after git commits are fetched for a date
 * SLACK_COLLECTED   — emitted after Slack contexts are fetched for a date
 * SESSION_COLLECTED — emitted after AI session files (Codex / Claude) are read
 * WORK_LOG_SAVED    — emitted after the full daily summary is persisted to disk
 *                     and Blob; all registered hooks are awaited at this point
 */
export const WORK_LOG_EVENTS = Object.freeze({
  COMMIT_COLLECTED: "commit_collected",
  SLACK_COLLECTED: "slack_collected",
  SESSION_COLLECTED: "session_collected",
  WORK_LOG_SAVED: "work_log_saved",
});

// ── Internal state ───────────────────────────────────────────────────────────────

/** General-purpose EventEmitter for fire-and-forget listeners. */
const _bus = new EventEmitter();
_bus.setMaxListeners(20);

/**
 * Ordered list of async hooks for the WORK_LOG_SAVED event.
 *
 * Each entry is an async function with signature:
 *   (date: string, workLog: object) => Promise<CandidateHookResult>
 *
 * Hooks are awaited sequentially so that later hooks can observe side effects
 * produced by earlier ones (e.g. suggestions already written to Blob).
 *
 * @type {Array<Function>}
 */
const _savedHooks = [];

// ── Granular event emitters ──────────────────────────────────────────────────────

/**
 * Emit "commit_collected" — fired by batch.mjs after `collectGitCommits`.
 *
 * @param {string} date     YYYY-MM-DD batch date
 * @param {Array}  commits  Raw commit objects returned by collectGitCommits
 */
export function emitCommitCollected(date, commits, userId = "default") {
  _bus.emit(WORK_LOG_EVENTS.COMMIT_COLLECTED, { date, commits, userId });
}

/**
 * Emit "slack_collected" — fired by batch.mjs after `collectSlackContexts`.
 *
 * @param {string} date      YYYY-MM-DD batch date
 * @param {Array}  contexts  Slack context objects returned by collectSlackContexts
 */
export function emitSlackCollected(date, contexts, userId = "default") {
  _bus.emit(WORK_LOG_EVENTS.SLACK_COLLECTED, { date, contexts, userId });
}

/**
 * Emit "session_collected" — fired by batch.mjs after Codex/Claude sessions
 * are read.
 *
 * @param {string} date      YYYY-MM-DD batch date
 * @param {Array}  sessions  Combined codex + claude session objects
 */
export function emitSessionCollected(date, sessions, userId = "default") {
  _bus.emit(WORK_LOG_EVENTS.SESSION_COLLECTED, { date, sessions, userId });
}

// ── Hook registry: WORK_LOG_SAVED ────────────────────────────────────────────────

/**
 * Register a listener for any of the granular events.
 * Use this for observability / logging — not the resume pipeline.
 *
 * @param {string}   eventName  One of WORK_LOG_EVENTS.*
 * @param {Function} listener   Synchronous or async callback ({ date, ... })
 */
export function onWorkLogEvent(eventName, listener) {
  _bus.on(eventName, listener);
}

/**
 * Remove a previously registered general listener.
 *
 * @param {string}   eventName
 * @param {Function} listener
 */
export function offWorkLogEvent(eventName, listener) {
  _bus.off(eventName, listener);
}

/**
 * Register an async hook to run when the full work-log is saved.
 *
 * The hook receives the YYYY-MM-DD date and the complete daily summary
 * document (the same `workLog` object produced by `buildSummary` in batch.mjs).
 *
 * Hooks run in the order they were registered and are awaited sequentially.
 * The result of the LAST registered hook is returned from `emitWorkLogSaved`.
 *
 * @param {Function} handler  async (date: string, workLog: object) => Promise<CandidateHookResult>
 */
export function onWorkLogSaved(handler) {
  _savedHooks.push(handler);
}

/**
 * Remove a previously registered WORK_LOG_SAVED hook.
 *
 * @param {Function} handler  The exact function reference passed to onWorkLogSaved
 */
export function offWorkLogSaved(handler) {
  const idx = _savedHooks.indexOf(handler);
  if (idx !== -1) _savedHooks.splice(idx, 1);
}

/**
 * Emit the "work_log_saved" event and sequentially await all registered hooks.
 *
 * Called by batch.mjs after the daily summary has been written to disk and
 * Blob — this replaces the previous direct call to `runResumeCandidateHook`.
 *
 * If no hooks are registered the function returns a neutral skipped result so
 * that callers can always treat the return value as a CandidateHookResult.
 *
 * Errors thrown by individual hooks are caught, logged, and recorded in the
 * returned result's `error` field.  The loop continues even after a failing
 * hook so all registered hooks get a chance to run.
 *
 * @param {string} date     YYYY-MM-DD batch date
 * @param {object} workLog  Daily summary document (output of buildSummary)
 * @returns {Promise<import("./resumeBatchHook.mjs").CandidateHookResult>}
 */
export async function emitWorkLogSaved(date, workLog, userId = "default") {
  _bus.emit(WORK_LOG_EVENTS.WORK_LOG_SAVED, { date, userId });

  if (_savedHooks.length === 0) {
    return { skipped: true, skipReason: "no_hooks_registered", generated: 0, superseded: 0, cacheHit: false };
  }

  /** @type {import("./resumeBatchHook.mjs").CandidateHookResult} */
  let lastResult = { skipped: false, generated: 0, superseded: 0, cacheHit: false };

  for (const hook of _savedHooks) {
    try {
      lastResult = await hook(date, workLog, userId);
    } catch (err) {
      const msg = err?.message ?? String(err);
      console.warn(`[workLogEventBus] Hook threw unexpectedly (non-fatal): ${msg}`);
      lastResult = { skipped: false, generated: 0, superseded: 0, cacheHit: false, error: msg };
    }
  }

  return lastResult;
}

/**
 * Register `runResumeCandidateHook` from resumeBatchHook.mjs as the default
 * WORK_LOG_SAVED handler.
 *
 * Idempotent — subsequent calls are no-ops.  Safe to call from both
 * server startup (server.mjs) and the CLI batch runner (cli.mjs).
 *
 * @returns {Promise<void>}
 */
export async function registerResumeBatchHook() {
  // Guard: already registered — do not add a second copy.
  if (_savedHooks.some((h) => h._isResumeBatchHook === true)) return;

  const { runResumeCandidateHook } = await import("./resumeBatchHook.mjs");

  const hook = async (date, workLog, userId = "default") => runResumeCandidateHook(date, workLog, { userId });
  hook._isResumeBatchHook = true;
  _savedHooks.push(hook);
}

/**
 * Return the number of currently registered WORK_LOG_SAVED hooks.
 * Exposed for testability.
 *
 * @returns {number}
 */
export function savedHookCount() {
  return _savedHooks.length;
}

/**
 * Remove all registered WORK_LOG_SAVED hooks.
 * Exposed for test teardown — do not call in production code.
 */
export function _clearSavedHooks() {
  _savedHooks.length = 0;
}

// ── Granular event → background batch trigger ──────────────────────────────────
//
// When an external event source (e.g. git post-commit hook, CI webhook, Slack
// event subscription) fires a granular event, the system should eventually
// produce resume candidates by running the full batch pipeline.  Granular
// events alone don't carry enough context for resumeBatchHook (which requires
// a complete workLog summary), so the trigger debounces events by date and
// schedules a background batch run that builds the full summary.
//
// The debounce window prevents redundant batch runs when multiple data sources
// update within a short period (e.g. a burst of commits + Slack messages).

/**
 * Default debounce window in milliseconds.
 *
 * Events for the same date within this window are coalesced into a single
 * background batch run.  5 seconds balances responsiveness with efficiency
 * for the typical pattern of rapid-fire collection events.
 */
const DEBOUNCE_MS = 5_000;

/**
 * Per-date debounce timers.
 * Key: YYYY-MM-DD string, Value: setTimeout timer ID.
 *
 * @type {Map<string, ReturnType<typeof setTimeout>>}
 */
const _debouncedTimers = new Map();

/**
 * Track which data sources have been seen for each pending debounce window.
 * Key: YYYY-MM-DD, Value: Set of event type strings.
 *
 * @type {Map<string, Set<string>>}
 */
const _pendingSources = new Map();

/**
 * Reference to the batch runner function injected via registerGranularTriggers.
 * Defaults to null (triggers are not active).
 *
 * @type {((date: string) => Promise<any>) | null}
 */
let _batchRunner = null;

/**
 * Whether granular triggers are currently active.
 *
 * @type {boolean}
 */
let _granularTriggersActive = false;

/**
 * Listener references for cleanup.
 * @type {Array<{ event: string, listener: Function }>}
 */
const _granularListeners = [];

/**
 * Register event listeners on all granular event types that trigger a
 * debounced background batch run.
 *
 * When a granular event (commit_collected, slack_collected, session_collected)
 * fires, the listener records the event source and (re)starts a debounce
 * timer for that date.  When the timer expires, the provided `batchRunner`
 * function is called with the date to build a full workLog summary and
 * trigger the WORK_LOG_SAVED hook chain (which includes resumeBatchHook).
 *
 * Idempotent — subsequent calls with the same batchRunner are no-ops.
 *
 * @param {(date: string) => Promise<any>} batchRunner
 *   Async function that runs the daily batch for a given date.
 *   Typically `runDailyBatch` from batch.mjs.
 * @param {object} [options]
 * @param {number} [options.debounceMs=5000]  Debounce window in ms
 */
export function registerGranularTriggers(batchRunner, options = {}) {
  if (_granularTriggersActive) return;

  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  _batchRunner = batchRunner;
  _granularTriggersActive = true;

  const granularEvents = [
    WORK_LOG_EVENTS.COMMIT_COLLECTED,
    WORK_LOG_EVENTS.SLACK_COLLECTED,
    WORK_LOG_EVENTS.SESSION_COLLECTED,
  ];

  for (const eventName of granularEvents) {
    const listener = ({ date, userId = "default" }) => {
      if (!date) return;
      _scheduleBackgroundBatch(date, eventName, debounceMs, userId);
    };
    _bus.on(eventName, listener);
    _granularListeners.push({ event: eventName, listener });
  }
}

/**
 * Schedule (or reschedule) a debounced background batch for a given date.
 *
 * Multiple events for the same date within the debounce window are coalesced
 * into a single batch run.  The batch runs after the debounce window expires
 * with no new events for that date.
 *
 * @param {string} date        YYYY-MM-DD
 * @param {string} eventName   The event type that triggered this schedule
 * @param {number} debounceMs  Debounce window in ms
 * @private
 */
function _scheduleBackgroundBatch(date, eventName, debounceMs, userId = "default") {
  // Track which sources triggered for this date
  const pendingKey = `${userId}:${date}`;
  if (!_pendingSources.has(pendingKey)) {
    _pendingSources.set(`${userId}:${date}`, new Set());
  }
  _pendingSources.get(pendingKey).add(eventName);

  // Clear existing timer for this date (debounce reset)
  if (_debouncedTimers.has(pendingKey)) {
    clearTimeout(_debouncedTimers.get(pendingKey));
  }

  const timer = setTimeout(() => {
    _debouncedTimers.delete(pendingKey);
    const sources = _pendingSources.get(pendingKey);
    _pendingSources.delete(pendingKey);

    if (!_batchRunner) return;

    const sourceList = sources ? [...sources].join(", ") : "unknown";
    console.info(
      `[workLogEventBus] Granular trigger firing background batch for ${date}` +
        ` (sources: ${sourceList})`
    );

    _batchRunner(date, { userId }).catch((err) => {
      console.warn(
        `[workLogEventBus] Background batch for ${date} failed (non-fatal):`,
        err?.message ?? String(err)
      );
    });
  }, debounceMs);

  _debouncedTimers.set(pendingKey, timer);
}

/**
 * Deregister all granular event triggers and cancel pending timers.
 * Exposed for test teardown.
 */
export function _clearGranularTriggers() {
  for (const { event, listener } of _granularListeners) {
    _bus.off(event, listener);
  }
  _granularListeners.length = 0;

  for (const timer of _debouncedTimers.values()) {
    clearTimeout(timer);
  }
  _debouncedTimers.clear();
  _pendingSources.clear();

  _batchRunner = null;
  _granularTriggersActive = false;
}

/**
 * Return whether granular triggers are currently active.
 * Exposed for testability.
 *
 * @returns {boolean}
 */
export function isGranularTriggersActive() {
  return _granularTriggersActive;
}

/**
 * Return the set of pending source event types for a given date.
 * Exposed for testability.
 *
 * @param {string} date  YYYY-MM-DD
 * @returns {Set<string>|undefined}
 */
export function _getPendingSources(date, userId = "default") {
  return _pendingSources.get(`${userId}:${date}`);
}
