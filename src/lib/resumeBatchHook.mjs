/**
 * Resume Candidate Generation Hook — Daily Batch Pipeline Integration.
 *
 * Integrates Sub-AC 10-1 (delta check via resumeDiff.mjs),
 * Sub-AC 10-2 (merge candidate generation via resumeWorkLogExtract.mjs +
 * resumeWorkLogMerge.mjs + resumeDiffToSuggestions.mjs), and
 * Sub-AC 10-3 (3% delta threshold gate) as the final stage of the daily
 * batch orchestrator.
 *
 * Also implements Sub-AC 2-2: background resume draft generation.
 * After the existing resume is loaded (step 1), a background task is kicked
 * off to aggregate data sources (commits, Slack, session memory) from the
 * past 90 days and call the LLM to generate a ResumeDraft document.
 * The draft is saved to Vercel Blob (resume/chat-draft.json) and used as
 * the starting context for the chat-based resume refinement UI.
 *
 * This module intentionally mirrors the pipeline of
 * POST /api/resume/generate-candidates in src/routes/resume.mjs, but is
 * decoupled from HTTP context so it can be invoked directly by the CLI
 * batch runner without an HTTP round-trip.
 *
 * Pipeline steps (mirrors the HTTP route):
 *   1. Load current resume from Vercel Blob
 *   1b. [Background] Kick off draft generation from all data sources via
 *       buildChatDraftContext — collects per-source evidence (commits/slack/sessions),
 *       calls LLM, saves draft + evidence pool to Blob — Sub-AC 2-2
 *   2. Read extract cache for this date (skip LLM on cache HIT)
 *   3. LLM: extract partial resume updates from work log (resumeWorkLogExtract.mjs)
 *   4. Persist extract to cache (fire-and-forget)
 *   5. Merge LLM extract into existing resume → proposed document (resumeWorkLogMerge.mjs)
 *   6. Rule-based diff: proposed vs existing (resumeDiff.mjs — no LLM)
 *   6b. Delta threshold gate (Sub-AC 10-3): skip candidate creation when
 *       the changed-items ratio is below DELTA_THRESHOLD (3%)
 *   7. Convert diff to pending SuggestionItems (resumeDiffToSuggestions.mjs)
 *   8. Supersede all existing pending candidates — AC 13 semantics
 *   9. Save updated suggestions document to Vercel Blob
 *  10. Save batch checkpoint snapshot
 *
 * Return value (CandidateHookResult):
 *   { skipped, skipReason?, belowThreshold?, generated, superseded, cacheHit,
 *     deltaRatio?, deltaChangedCount?, deltaTotalCount?,
 *     draftGenerationTriggered?, error? }
 *
 * The function NEVER throws.  All errors are captured in the returned
 * result object so the batch pipeline always completes successfully.
 *
 * Skip conditions (graceful no-op, not an error):
 *   - BLOB_READ_WRITE_TOKEN is not set (local-only dev run without Blob access)
 *   - WORK_LOG_DISABLE_OPENAI=1 (LLM integration explicitly disabled)
 *   - No resume has been bootstrapped yet (readResumeData() returns null)
 *
 * Below-threshold condition (not an error, not a skip):
 *   - Delta ratio < DELTA_THRESHOLD (3%): diff exists but changes are too
 *     minor to warrant creating merge candidates.  belowThreshold: true is
 *     set in the result so callers can log the reason.
 *
 * Error conditions (non-fatal, captured in result.error):
 *   - Blob read/write I/O failure
 *   - LLM API call failure (network error, invalid API key, etc.)
 */

import {
  readResumeData,
  readSuggestionsData,
  saveSuggestionsData,
  saveSnapshot,
  saveChatDraft,
  saveChatDraftContext
} from "./blob.mjs";
import { readExtractCache, writeExtractCache } from "./bulletCache.mjs";
import { extractResumeUpdatesFromWorkLog } from "./resumeWorkLogExtract.mjs";
import { mergeWorkLogIntoResume } from "./resumeWorkLogMerge.mjs";
import { diffResume } from "./resumeDiff.mjs";
import { diffToSuggestions } from "./resumeDiffToSuggestions.mjs";
import { filterSuggestionsWithLayeringRules } from "./resumeLayeredSignals.mjs";
import {
  computeDeltaRatio,
  exceedsDeltaThreshold
} from "./resumeDeltaRatio.mjs";
import { generateResumeDraft } from "./resumeDraftGeneration.mjs";
import { buildChatDraftContext } from "./resumeChatDraftService.mjs";
import {
  markDraftGenerationPending,
  markDraftGenerationCompleted,
  markDraftGenerationFailed,
  updateDraftGenerationProgress,
} from "./draftGenerationState.mjs";

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CandidateHookResult
 * @property {boolean} skipped            - true when the hook ran but was a no-op (guard condition)
 * @property {string}  [skipReason]       - machine-readable skip reason (present when skipped=true)
 *   Possible values:
 *     "no_blob_token"   — BLOB_READ_WRITE_TOKEN env var absent
 *     "openai_disabled" — WORK_LOG_DISABLE_OPENAI=1
 *     "no_resume"       — resume not yet bootstrapped (readResumeData returned null)
 * @property {boolean} [belowThreshold]   - true when diff exists but delta ratio < DELTA_THRESHOLD (3%)
 *   When true: generated=0, superseded=0, deltaRatio/deltaChangedCount/deltaTotalCount are set.
 * @property {number}  generated          - number of new pending SuggestionItems created (0 on skip/error/belowThreshold)
 * @property {number}  superseded         - number of previous pending items batch-discarded (0 on skip/error/belowThreshold)
 * @property {boolean} cacheHit           - true when cached WorkLogExtract was used (no LLM call)
 * @property {number}  [deltaRatio]       - computed delta ratio (changedCount / totalCount); present after diff step
 * @property {number}  [deltaChangedCount] - number of changed addressable items in the diff
 * @property {number}  [deltaTotalCount]  - total number of addressable items in the existing resume
 * @property {string}  [error]            - non-fatal error message when the hook failed
 * @property {string|null} [snapshotKey] - Blob pathname of the batch checkpoint snapshot saved after
 *   candidate generation; null when snapshot save was skipped or failed.
 * @property {boolean} [draftGenerationTriggered] - true when background draft generation was kicked off
 *   (Sub-AC 2-2).  The draft is saved to Vercel Blob asynchronously; this field indicates the task
 *   was started, not that it completed.  Only set when the resume exists and OpenAI is enabled.
 */

/**
 * Run the resume delta-check and merge-candidate-generation pipeline as the
 * final step of the daily batch run.
 *
 * Called by runDailyBatch() in batch.mjs after all work-log data has been
 * collected and the daily summary has been written to disk / Blob.
 *
 * @param {string} date      YYYY-MM-DD string matching the batch date
 * @param {object} workLog   Daily summary document (output of buildSummary)
 * @returns {Promise<CandidateHookResult>}
 */
export async function runResumeCandidateHook(date, workLog) {
  const tag = `[resumeBatchHook date="${date}"]`;

  // ── Guard: BLOB_READ_WRITE_TOKEN absent ─────────────────────────────────────
  // The hook requires Vercel Blob for both reading the resume and persisting
  // generated suggestions.  Without the token the batch still completes but
  // resume candidate generation is silently skipped (e.g. local dev runs).
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.info(`${tag} Skipping — BLOB_READ_WRITE_TOKEN not set`);
    return _skip("no_blob_token");
  }

  // ── Guard: OpenAI integration disabled ─────────────────────────────────────
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    console.info(`${tag} Skipping — OpenAI integration disabled (WORK_LOG_DISABLE_OPENAI=1)`);
    return _skip("openai_disabled");
  }

  // ── Step 1: Load current resume from Vercel Blob ────────────────────────────
  let existingResume;
  try {
    existingResume = await readResumeData();
  } catch (err) {
    console.warn(`${tag} Could not read resume from Blob (non-fatal):`, err.message);
    return _error(`Could not read resume: ${err.message ?? String(err)}`);
  }

  if (!existingResume) {
    // Resume hasn't been bootstrapped yet — this is the normal state before
    // the user first uploads a PDF.  The hook is a no-op in this case.
    console.info(`${tag} Skipping — no resume bootstrapped yet`);
    return _skip("no_resume");
  }

  // ── Step 1b: Background resume draft generation (Sub-AC 2-2) ───────────────
  //
  // Kick off background aggregation of all data sources (commits, Slack,
  // session memory) from the past 90 days and LLM draft generation.
  // The draft is saved to Vercel Blob (resume/chat-draft.json) and serves as
  // the starting context for the chat-based resume refinement UI.
  //
  // Also passes the current work log so the draft generation pipeline can
  // incorporate today's data even before the next daily file is written.
  //
  // This is fire-and-forget: the main pipeline does not await it, so the
  // batch completes within its normal time budget regardless of LLM latency.
  // Errors inside the background task are logged but never propagate.
  _generateDraftInBackground(date, existingResume, workLog, tag);

  // ── Steps 2–3: Extract — cache-first, then LLM ─────────────────────────────
  //
  // Cache key: date string → blob path `cache/extract/{date}.json`.
  // A cache HIT avoids a redundant LLM call when the same date is re-batched
  // (e.g. CI re-runs, manual re-triggers, or a crash-recovery re-run).
  let extract;
  let cacheHit = false;

  try {
    const cached = await readExtractCache(date);
    if (cached !== null) {
      console.info(`${tag} Extract cache HIT — reusing cached WorkLogExtract, LLM call skipped`);
      extract = cached;
      cacheHit = true;
    } else {
      console.info(`${tag} Extract cache MISS — calling LLM for WorkLogExtract`);
      extract = await extractResumeUpdatesFromWorkLog(workLog, existingResume);

      // ── Step 4: Persist extract to cache (fire-and-forget) ──────────────────
      // Write failures are non-fatal — the pipeline continues without caching.
      writeExtractCache(date, extract).catch((err) => {
        console.warn(
          `${tag} Extract cache write failed (non-fatal):`,
          err.message ?? String(err)
        );
      });
    }
  } catch (err) {
    console.warn(`${tag} LLM extraction failed (non-fatal):`, err.message ?? String(err));
    return { ..._error(`LLM extraction failed: ${err.message ?? String(err)}`), draftGenerationTriggered: true };
  }

  // ── Step 5: Merge — apply extract into existing resume ─────────────────────
  const proposedResume = mergeWorkLogIntoResume(existingResume, extract);

  // ── Step 6: Diff — rule-based comparison, no LLM ───────────────────────────
  const diff = diffResume(existingResume, proposedResume);

  if (diff.isEmpty) {
    console.info(`${tag} Diff is empty — today's work log produced no resume changes`);
    return { skipped: false, generated: 0, superseded: 0, cacheHit, draftGenerationTriggered: true };
  }

  // ── Step 6b: Delta threshold gate (Sub-AC 10-3) ────────────────────────────
  //
  // Only create merge candidates when the changed-items ratio reaches at least
  // DELTA_THRESHOLD (3 %).  Minor diffs — e.g. a single skill addition in a
  // large resume — produce noise rather than actionable suggestions, so they
  // are suppressed here.
  //
  // The delta metrics are always computed and returned so the batch runner can
  // log the ratio regardless of whether candidates were generated.
  const deltaMetrics = computeDeltaRatio(diff, existingResume);

  if (!exceedsDeltaThreshold(diff, existingResume)) {
    console.info(
      `${tag} Delta ratio ${(deltaMetrics.ratio * 100).toFixed(1)}% is below ` +
        `the ${(0.03 * 100).toFixed(0)}% threshold — skipping candidate generation`
    );
    return {
      skipped: false,
      belowThreshold: true,
      generated: 0,
      superseded: 0,
      cacheHit,
      deltaRatio: deltaMetrics.ratio,
      deltaChangedCount: deltaMetrics.changedCount,
      deltaTotalCount: deltaMetrics.totalCount,
      draftGenerationTriggered: true
    };
  }

  // ── Step 7: Convert diff to pending SuggestionItems ────────────────────────
  const rawSuggestions = filterSuggestionsWithLayeringRules(
    diffToSuggestions(diff, date),
    workLog
  );

  if (rawSuggestions.length === 0) {
    console.info(`${tag} Diff produced no actionable suggestions`);
    return { skipped: false, generated: 0, superseded: 0, cacheHit, draftGenerationTriggered: true };
  }

  // ── Step 8: Load existing suggestions + supersede pending items (AC 13) ────
  //
  // Every call to this hook replaces the previous pending batch.  All items
  // currently in "pending" status are transitioned to "discarded" with
  // discardReason: "superseded" before the new batch is appended.  This
  // ensures only one active (pending) generation at a time and mirrors the
  // behaviour of the HTTP generate-candidates route exactly.
  let suggestionsDoc;
  try {
    suggestionsDoc = await readSuggestionsData();
  } catch (err) {
    console.warn(
      `${tag} Could not read suggestions from Blob (non-fatal):`,
      err.message ?? String(err)
    );
    return { ..._error(`Could not read suggestions: ${err.message ?? String(err)}`), draftGenerationTriggered: true };
  }

  const supersededAt = new Date().toISOString();
  const pendingToDiscard = suggestionsDoc.suggestions.filter(
    (s) => s.status === "pending"
  );
  const supersededSuggestions = suggestionsDoc.suggestions.map((s) =>
    s.status === "pending"
      ? {
          ...s,
          status: "discarded",
          discardedAt: supersededAt,
          discardReason: "superseded"
        }
      : s
  );

  if (pendingToDiscard.length > 0) {
    console.info(
      `${tag} Superseding ${pendingToDiscard.length} existing pending candidate(s) — batch discard`
    );
  }

  // ── Step 9: Save updated suggestions document to Vercel Blob ───────────────
  const updatedDoc = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [...supersededSuggestions, ...rawSuggestions]
  };

  try {
    await saveSuggestionsData(updatedDoc);
  } catch (err) {
    console.warn(
      `${tag} Could not save suggestions to Blob (non-fatal):`,
      err.message ?? String(err)
    );
    return { ..._error(`Could not save suggestions: ${err.message ?? String(err)}`), draftGenerationTriggered: true };
  }

  console.info(
    `${tag} Generated ${rawSuggestions.length} new candidate(s)` +
      (pendingToDiscard.length > 0
        ? ` (${pendingToDiscard.length} previous pending superseded)`
        : "") +
      ` [delta ${(deltaMetrics.ratio * 100).toFixed(1)}%` +
      ` — ${deltaMetrics.changedCount}/${deltaMetrics.totalCount} items]`
  );

  // ── Step 10: Save batch checkpoint snapshot ─────────────────────────────────
  //
  // Persist a snapshot of existingResume (the state BEFORE new candidates are
  // applied) so that getLastApprovedSnapshot() / deltaFromLastApproved() have
  // a reference point for computing change rate and detecting profile staleness.
  //
  // The snapshot is saved only when at least one candidate was generated —
  // empty-diff and below-threshold runs do not produce a batch checkpoint.
  //
  // This is a best-effort operation: failures are logged and the batch result
  // still reports success; snapshotKey will be null if the save fails.
  let snapshotKey = null;
  try {
    const snapResult = await saveSnapshot(existingResume, {
      label: "batch",
      trigger: "batch",
      triggeredBy: "batch"
    });
    snapshotKey = snapResult.snapshotKey;
    console.info(`${tag} Batch checkpoint snapshot saved: ${snapshotKey}`);
  } catch (err) {
    console.warn(
      `${tag} Batch checkpoint snapshot save failed (non-fatal):`,
      err.message ?? String(err)
    );
  }

  return {
    skipped: false,
    generated: rawSuggestions.length,
    superseded: pendingToDiscard.length,
    cacheHit,
    deltaRatio: deltaMetrics.ratio,
    deltaChangedCount: deltaMetrics.changedCount,
    deltaTotalCount: deltaMetrics.totalCount,
    snapshotKey,
    draftGenerationTriggered: true
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Trigger background resume draft generation — fire-and-forget (Sub-AC 2-2).
 *
 * Aggregates all data sources (commits, Slack, session memory) for the past
 * 90 days up to `date` via buildChatDraftContext(), then saves the full draft
 * context (draft + evidence pool + source breakdown) to Vercel Blob.
 *
 * Uses the richer buildChatDraftContext pipeline instead of bare generateResumeDraft
 * so the persisted output includes:
 *   - ResumeDraft: strength candidates, experience summaries, suggested summary
 *   - Evidence pool: individual evidence items from commits, slack, sessions
 *   - Source breakdown: per-source counts (commits, slack, sessions, totalDates)
 *   - Data gaps: areas where more user information is needed
 *
 * The complete draft context is saved to resume/chat-draft.json and serves as
 * the starting context for the chat-based resume refinement UI.
 *
 * Also receives the current workLog so the pipeline can incorporate today's
 * signals (commits, Slack contexts, session memory) even before the daily
 * file is finalized to disk.
 *
 * Falls back to generateResumeDraft() if buildChatDraftContext is unavailable,
 * ensuring backward compatibility with existing deployments.
 *
 * Errors inside this background task are logged but never propagate to
 * the caller — the main batch pipeline is not affected.
 *
 * @param {string}      date            YYYY-MM-DD (upper bound of the date range)
 * @param {object|null} existingResume  Current resume document (optional context for the LLM)
 * @param {object}      workLog         Current day's work log (for supplementary signal injection)
 * @param {string}      tag             Log prefix tag for consistent formatting
 */
function _generateDraftInBackground(date, existingResume, workLog, tag) {
  // Sub-AC 2-3: Track background generation state
  const taskId = markDraftGenerationPending("batch");

  _buildAndSaveDraftContext(date, existingResume, workLog, tag, taskId)
    .then(() => {
      markDraftGenerationCompleted(taskId);
    })
    .catch((err) => {
      markDraftGenerationFailed(taskId, err.message ?? String(err));
      console.warn(
        `${tag} Background draft generation failed (non-fatal):`,
        err.message ?? String(err)
      );
    });
}

/**
 * Build the full draft context from all data sources and save to Blob.
 *
 * Pipeline:
 *   1. buildChatDraftContext — loads work logs, aggregates signals, collects
 *      per-source evidence (commits/slack/sessions), calls LLM for draft
 *      Also directly queries Slack API for recent messages to augment the
 *      evidence pool beyond what's captured in work log highlights.
 *   2. saveChatDraft — persists the ResumeDraft to resume/chat-draft.json
 *   3. saveChatDraftContext — persists the full context (draft + evidence pool
 *      + source breakdown) to resume/chat-draft-context.json
 *
 * @param {string}      date
 * @param {object|null} existingResume
 * @param {object}      workLog         Current day's work log (supplementary signals)
 * @param {string}      tag
 * @param {string}      [taskId]        State tracker task id (Sub-AC 2-3)
 */
async function _buildAndSaveDraftContext(date, existingResume, workLog, tag, taskId) {
  if (taskId) updateDraftGenerationProgress(taskId, { stage: "building_context" });

  const draftContext = await buildChatDraftContext({
    toDate: date,
    existingResume,
    currentWorkLog: workLog,
  });

  if (!draftContext.draft) {
    const reason = draftContext.dataGaps?.[0] ?? "unknown";
    console.info(`${tag} Background draft generation skipped — ${reason}`);
    if (taskId) markDraftGenerationFailed(taskId, reason);
    return;
  }

  const draft = draftContext.draft;

  if (taskId) updateDraftGenerationProgress(taskId, { stage: "saving" });

  // Save the ResumeDraft for backward compatibility (chat-draft.json)
  await saveChatDraft(draft);

  // Save the full DraftContext with evidence pool for the chat UI (chat-draft-context.json)
  await saveChatDraftContext({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    draft,
    evidencePool: draftContext.evidencePool,
    sourceBreakdown: draftContext.sourceBreakdown,
    dataGaps: draftContext.dataGaps,
  });

  const sb = draftContext.sourceBreakdown;

  // Update final progress with source stats (Sub-AC 2-3)
  if (taskId) {
    updateDraftGenerationProgress(taskId, {
      stage: "done",
      datesLoaded: sb.totalDates ?? 0,
      commitCount: sb.commits ?? 0,
      slackCount: sb.slack ?? 0,
      sessionCount: sb.sessions ?? 0,
    });
  }

  console.info(
    `${tag} Background draft generation complete` +
      ` — commits=${sb.commits}` +
      ` sessions=${sb.sessions}` +
      ` slack=${sb.slack}` +
      ` dates=${sb.totalDates}` +
      ` evidence=${draftContext.evidencePool.length}` +
      ` dataGaps=${draftContext.dataGaps.length}` +
      ` → resume/chat-draft.json + resume/chat-draft-context.json`
  );
}

/**
 * Build a "skipped" result (graceful no-op).
 *
 * @param {string} reason  Machine-readable skip reason
 * @returns {CandidateHookResult}
 */
function _skip(reason) {
  return {
    skipped: true,
    skipReason: reason,
    generated: 0,
    superseded: 0,
    cacheHit: false
  };
}

/**
 * Build a non-fatal error result.
 *
 * @param {string} message  Human-readable error description
 * @returns {CandidateHookResult}
 */
function _error(message) {
  return {
    skipped: false,
    generated: 0,
    superseded: 0,
    cacheHit: false,
    error: message
  };
}
