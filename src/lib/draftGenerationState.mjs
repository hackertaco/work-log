/**
 * Draft Generation State Manager — In-Memory Background Task Tracker (Sub-AC 2-3).
 *
 * Tracks the lifecycle of background resume draft generation tasks with
 * status transitions: idle → pending → completed | failed.
 *
 * This is a simple in-memory singleton suitable for a single-user tool.
 * State is lost on server restart, which is acceptable because:
 *   - The cached draft in Vercel Blob persists across restarts
 *   - A new generation can always be triggered manually
 *   - No concurrent users means no race conditions
 *
 * Key design decisions:
 *   - Single active task at a time (new request supersedes previous pending)
 *   - Timestamps for every state transition (for timeout detection)
 *   - Error details preserved for debugging
 *   - Progress metadata (source counts, stage) for UI feedback
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {'idle' | 'pending' | 'completed' | 'failed'} DraftGenerationStatus
 */

/**
 * @typedef {Object} DraftGenerationProgress
 * @property {string}  [stage]       Current pipeline stage label (e.g. "loading_work_logs", "calling_llm", "saving")
 * @property {number}  [datesLoaded] Number of work log dates loaded so far
 * @property {number}  [commitCount] Commits found in aggregation
 * @property {number}  [slackCount]  Slack messages found
 * @property {number}  [sessionCount] Sessions found
 */

/**
 * @typedef {Object} DraftGenerationState
 * @property {DraftGenerationStatus} status       Current status
 * @property {string|null}           taskId       Unique task identifier (ISO timestamp + random suffix)
 * @property {string|null}           startedAt    ISO timestamp when task started
 * @property {string|null}           completedAt  ISO timestamp when task completed/failed
 * @property {string|null}           error        Error message (only when status === 'failed')
 * @property {DraftGenerationProgress|null} progress  Progress metadata for UI
 * @property {string|null}           triggeredBy  Who initiated: 'api' | 'batch' | 'manual'
 */

// ─── State ───────────────────────────────────────────────────────────────────

/** @type {DraftGenerationState} */
let _state = _initialState();

function _initialState() {
  return {
    status: "idle",
    taskId: null,
    startedAt: null,
    completedAt: null,
    error: null,
    progress: null,
    triggeredBy: null,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the current draft generation state (read-only snapshot).
 *
 * @returns {DraftGenerationState}
 */
export function getDraftGenerationState() {
  return { ..._state, progress: _state.progress ? { ..._state.progress } : null };
}

/**
 * Mark a new draft generation task as started.
 * Supersedes any previously pending task.
 *
 * @param {'api' | 'batch' | 'manual'} triggeredBy  Who initiated the task
 * @returns {string}  The new taskId
 */
export function markDraftGenerationPending(triggeredBy = "api") {
  const taskId = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  _state = {
    status: "pending",
    taskId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    progress: { stage: "initializing" },
    triggeredBy,
  };

  return taskId;
}

/**
 * Update progress metadata for the current pending task.
 * No-op if there's no pending task or if taskId doesn't match.
 *
 * @param {string} taskId
 * @param {Partial<DraftGenerationProgress>} progress
 */
export function updateDraftGenerationProgress(taskId, progress) {
  if (_state.status !== "pending" || _state.taskId !== taskId) return;

  _state.progress = {
    ...(_state.progress || {}),
    ...progress,
  };
}

/**
 * Mark the current task as successfully completed.
 * No-op if taskId doesn't match the current pending task.
 *
 * @param {string} taskId
 */
export function markDraftGenerationCompleted(taskId) {
  if (_state.taskId !== taskId) return;

  _state = {
    ..._state,
    status: "completed",
    completedAt: new Date().toISOString(),
    progress: { ...(_state.progress || {}), stage: "done" },
  };
}

/**
 * Mark the current task as failed.
 * No-op if taskId doesn't match the current pending task.
 *
 * @param {string} taskId
 * @param {string} errorMessage
 */
export function markDraftGenerationFailed(taskId, errorMessage) {
  if (_state.taskId !== taskId) return;

  _state = {
    ..._state,
    status: "failed",
    completedAt: new Date().toISOString(),
    error: errorMessage,
    progress: { ...(_state.progress || {}), stage: "failed" },
  };
}

/**
 * Reset state back to idle.
 * Useful after the frontend has acknowledged a completed/failed state.
 */
export function resetDraftGenerationState() {
  _state = _initialState();
}

/**
 * Check if a generation task is currently in progress.
 *
 * Also detects stale pending tasks (older than 5 minutes) and auto-fails them,
 * since a healthy generation should complete within 30 seconds.
 *
 * @returns {boolean}
 */
export function isDraftGenerationInProgress() {
  if (_state.status !== "pending") return false;

  // Auto-fail stale tasks (> 5 minutes = likely crashed)
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;
  const elapsed = Date.now() - new Date(_state.startedAt).getTime();
  if (elapsed > STALE_THRESHOLD_MS) {
    markDraftGenerationFailed(
      _state.taskId,
      `Task timed out after ${Math.round(elapsed / 1000)}s`
    );
    return false;
  }

  return true;
}
