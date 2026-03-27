/**
 * Resume Candidate Generation Hook — Daily Batch Pipeline Integration.
 *
 * Integrates Sub-AC 10-1 (delta check via resumeDiff.mjs),
 * Sub-AC 10-2 (merge candidate generation via resumeWorkLogExtract.mjs +
 * resumeWorkLogMerge.mjs + resumeDiffToSuggestions.mjs), and
 * Sub-AC 10-3 (3% delta threshold gate) as the final stage of the daily
 * batch orchestrator.
 *
 * This module intentionally mirrors the pipeline of
 * POST /api/resume/generate-candidates in src/routes/resume.mjs, but is
 * decoupled from HTTP context so it can be invoked directly by the CLI
 * batch runner without an HTTP round-trip.
 *
 * Pipeline steps (mirrors the HTTP route):
 *   1. Load current resume from Vercel Blob
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
 *
 * Return value (CandidateHookResult):
 *   { skipped, skipReason?, belowThreshold?, generated, superseded, cacheHit,
 *     deltaRatio?, deltaChangedCount?, deltaTotalCount?, error? }
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
  saveSnapshot
} from "./blob.mjs";
import { readExtractCache, writeExtractCache } from "./bulletCache.mjs";
import { extractResumeUpdatesFromWorkLog } from "./resumeWorkLogExtract.mjs";
import { mergeWorkLogIntoResume } from "./resumeWorkLogMerge.mjs";
import { diffResume } from "./resumeDiff.mjs";
import { diffToSuggestions } from "./resumeDiffToSuggestions.mjs";
import {
  computeDeltaRatio,
  exceedsDeltaThreshold
} from "./resumeDeltaRatio.mjs";

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
    return _error(`LLM extraction failed: ${err.message ?? String(err)}`);
  }

  // ── Step 5: Merge — apply extract into existing resume ─────────────────────
  const proposedResume = mergeWorkLogIntoResume(existingResume, extract);

  // ── Step 6: Diff — rule-based comparison, no LLM ───────────────────────────
  const diff = diffResume(existingResume, proposedResume);

  if (diff.isEmpty) {
    console.info(`${tag} Diff is empty — today's work log produced no resume changes`);
    return { skipped: false, generated: 0, superseded: 0, cacheHit };
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
      deltaTotalCount: deltaMetrics.totalCount
    };
  }

  // ── Step 7: Convert diff to pending SuggestionItems ────────────────────────
  const rawSuggestions = diffToSuggestions(diff, date);

  if (rawSuggestions.length === 0) {
    console.info(`${tag} Diff produced no actionable suggestions`);
    return { skipped: false, generated: 0, superseded: 0, cacheHit };
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
    return _error(`Could not read suggestions: ${err.message ?? String(err)}`);
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
    return _error(`Could not save suggestions: ${err.message ?? String(err)}`);
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
    snapshotKey
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

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
