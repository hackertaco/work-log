/**
 * Resume API routes.
 *
 * All routes in this module are mounted under /api/resume.
 * Cookie authentication (cookieAuth middleware) is applied to the
 * /api/resume/* prefix in server.mjs before this router is registered.
 *
 * Routes:
 *   GET   /api/resume                               — return stored resume document (or 404 when none)
 *   PATCH /api/resume                               — user-edit full resume document (marks edited sections as 'user' source)
 *   GET   /api/resume/status                        — lightweight existence check (no document download)
 *   POST  /api/resume/upload                        — store raw PDF binary in Vercel Blob (storage-only; no LLM)
 *   POST  /api/resume/bootstrap                     — upload PDF → LLM parse → save to Blob → return
 *   POST /api/resume/gap-analysis                  — compare LinkedIn data against stored resume, return gaps
 *   POST /api/resume/generate-candidates           — work log → LLM extract → merge → diff → save suggestions
 *   GET    /api/resume/axes                          — list all display axes (id/label/keywords)
 *   POST   /api/resume/axes                          — (re)generate display axes via LLM clustering; returns cached axes when force=false
 *   GET    /api/resume/axes/staleness                — unclassified keyword ratio + shouldRecluster flag (diagnostic)
 *   POST   /api/resume/axes/recluster                — conditional re-cluster when unclassified ratio > 30 %; merges new axes with existing
 *   POST   /api/resume/axes/merge                    — merge two axes: absorb sourceId into targetId, union keywords, optional new label
 *   PATCH  /api/resume/axes/:id                      — update label/keywords of an existing axis (partial)
 *   DELETE /api/resume/axes/:id                      — remove a display axis by id
 *   POST   /api/resume/axes/:id/split                — split one axis into two by partitioning its keywords
 *   GET    /api/resume/keyword-axes                  — return persisted keyword cluster axes (null when none yet)
 *   POST   /api/resume/keyword-axes                  — generate (or return cached) 5–6 thematic keyword cluster axes; persists on first generation
 *   POST   /api/resume/cluster-keywords              — stateless: accept explicit keyword list, call LLM, return Axis[] (no blob I/O)
 *   PATCH  /api/resume/keywords/:id/move             — move a keyword (URL-encoded) from one axis to another; axisType selects display|keyword axes
 *   GET  /api/resume/suggestions                   — list pending update suggestions
 *   POST /api/resume/suggestions/:id/approve       — approve a suggestion and apply its patch
 *   POST /api/resume/suggestions/:id/reject        — reject a suggestion
 *   GET   /api/resume/candidates                   — list pending candidates (alias for GET /suggestions filtered to pending)
 *   PATCH /api/resume/candidates/:id               — transition candidate status (pending→approved|discarded)
 *   GET    /api/resume/strength-keywords              — list current strength keywords
 *   POST   /api/resume/strength-keywords              — add keyword(s) to the list (additive)
 *   DELETE /api/resume/strength-keywords/:keyword     — remove a single keyword (case-insensitive)
 *   PATCH  /api/resume/strength-keywords              — replace the full keyword list (atomic)
 *   GET    /api/resume/daily-bullets                       — list all dates with a bullet cache
 *   GET    /api/resume/daily-bullets/:date                 — get bullet cache for a specific date
 *   PUT    /api/resume/daily-bullets/:date                 — create/overwrite bullet cache for a date
 *   DELETE /api/resume/daily-bullets/:date                 — delete entire date's bullet cache
 *   PATCH  /api/resume/daily-bullets/:date/:bulletId       — edit a pending bullet's text
 *   POST   /api/resume/daily-bullets/:date/promote/:bulletId — promote a bullet to a suggestion
 *   POST   /api/resume/daily-bullets/:date/dismiss/:bulletId — dismiss a bullet
 *   POST   /api/resume/section-bullet                        — directly append a bullet to an experience or project item (user edit)
 *   PATCH  /api/resume/items                                — unified bullet add/update/delete (op field); source=user, bypasses mergeCandidates
 *   PATCH  /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex — edit a single bullet text (marks _source:'user')
 *   DELETE /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex — delete a single bullet (marks _source:'user')
 *   GET    /api/resume/snapshots                              — list all point-in-time snapshots (most-recent first)
 *   POST   /api/resume/rollback                              — restore resume to a prior snapshot identified by snapshotKey
 *   POST   /api/resume/reconstruct                           — bypass extract cache; re-derive all bullets from raw work-log records and re-hydrate extract cache
 *   POST   /api/resume/profile-delta-trigger               — check profileDelta vs last approved snapshot; trigger candidate generation when delta ≥ 3% (indirect causality)
 *
 * Bootstrap pipeline:
 *   1. Validate & buffer the PDF upload                       (this file)
 *   2. Extract plain text via pdf-parse                       (resumeLlm.mjs)
 *   3. Store raw PDF binary in Vercel Blob (resume/resume.pdf) (blob.mjs)
 *   4. Call LLM → structured JSON + keywords + axes           (resumeBootstrap.mjs)
 *   5. Save the combined document to Vercel Blob              (blob.mjs)
 *   6. Save extracted PDF text to Vercel Blob                 (blob.mjs)
 *   7. Return document to client                              (this file)
 *
 * Candidate generation pipeline (generate-candidates — Sub-AC 12c):
 *   1. Load current resume JSON from Vercel Blob               (blob.mjs)
 *   2. Rule-based pre-diff: filter work-log bullets already in resume  (resumeWorkLogExtract.mjs/buildWorkLogDiff)
 *   3. Short-circuit: skip LLM when diff is empty (no new content)    (resumeWorkLogExtract.mjs)
 *   4. LLM partial generation with diff context (not full resume)      (resumeWorkLogExtract.mjs)
 *   5. Merge LLM extract into existing resume → proposed document      (resumeWorkLogMerge.mjs)
 *   6. Rule-based diff existing vs proposed                    (resumeDiff.mjs)
 *   6.5 Delta ratio check (≥ 3% threshold) — skips if below   (resumeDeltaRatio.mjs)  ← AC 10-2
 *   7. Diff converted to actionable SuggestionItems            (resumeDiffToSuggestions.mjs)
 *   8. All existing pending candidates batch-discarded (superseded) — AC 13  (this file)
 *   9. New candidates saved to Vercel Blob and returned to client             (this file)
 */

import { Hono } from "hono";

import {
  checkResumeExists,
  saveResumeData,
  readResumeData,
  readSuggestionsData,
  saveSuggestionsData,
  saveDailyBullets,
  readDailyBullets,
  listBulletDates,
  deleteDailyBullets,
  savePdfText,
  savePdfRaw,
  PDF_RAW_PATHNAME,
  saveKeywordClusterAxes,
  readKeywordClusterAxes,
  saveDisplayAxes,
  readDisplayAxes,
  SNAPSHOTS_PREFIX,
  saveSnapshot,
  listSnapshots,
  readSnapshotByKey,
  readStrengthKeywords,
  saveStrengthKeywords,
  clearReconstructionMarker
} from "../lib/blob.mjs";
import {
  mergeKeywords,
  removeKeyword,
  replaceKeywords,
  extractKeywordsArray,
  initStrengthKeywordsFromBootstrap
} from "../lib/resumeStrengthKeywords.mjs";
import { loadConfig } from "../lib/config.mjs";
import { extractPdfText } from "../lib/resumeLlm.mjs";
import { generateResumeFromText } from "../lib/resumeBootstrap.mjs";
import {
  gatherWorkLogBullets,
  fullReconstructExtractCache
} from "../lib/resumeReconstruction.mjs";
import { analyzeGaps } from "../lib/resumeGapAnalysis.mjs";
import { gapItemsToSuggestions } from "../lib/resumeSuggestions.mjs";
import {
  buildDailyBulletsDocument,
  mergeDailyBulletsDocuments,
  promoteBullet,
  dismissBullet,
  editBullet
} from "../lib/resumeDailyBullets.mjs";
import { extractResumeUpdatesFromWorkLog } from "../lib/resumeWorkLogExtract.mjs";
import { mergeWorkLogIntoResume } from "../lib/resumeWorkLogMerge.mjs";
import { diffResume } from "../lib/resumeDiff.mjs";
import { diffToSuggestions } from "../lib/resumeDiffToSuggestions.mjs";
import {
  computeDeltaRatio,
  exceedsDeltaThreshold,
  DELTA_THRESHOLD
} from "../lib/resumeDeltaRatio.mjs";
import { generateDisplayAxes } from "../lib/resumeAxisClustering.mjs";
import {
  reclusterPipeline,
  computeUnclassifiedRatio,
  _adaptWorkLogEntries,
  DEFAULT_RECLUSTER_THRESHOLD,
  mergeAxes as mergeKeywordClusterAxes
} from "../lib/resumeRecluster.mjs";
import { readExtractCache, writeExtractCache } from "../lib/bulletCache.mjs";
import {
  getOrReconstructDailyBullets,
  BULLET_CACHE_MISS,
  BULLET_CACHE_RECONSTRUCTED
} from "../lib/resumeDailyBulletsService.mjs";
import {
  createAxis,
  updateAxisInArray,
  removeAxisFromArray,
  splitAxis,
  mergeAxes,
  migrateAxes,
  moveKeywordBetweenAxes
} from "../lib/resumeAxes.mjs";
import {
  clusterKeywords,
  collectResumeKeywords,
  collectWorkLogKeywords
} from "../lib/resumeKeywordClustering.mjs";
import {
  applyBulletProposal,
  isBulletProposal
} from "../lib/resumeBulletProposal.mjs";
import { deltaFromLastApproved } from "../lib/resumeSnapshotDelta.mjs";

export const resumeRouter = new Hono();

// ─── GET /api/resume ──────────────────────────────────────────────────────────

/**
 * Return the stored living-resume document.
 *
 * Response when resume EXISTS:
 *   HTTP 200  { "exists": true, "resume": { ...document } }
 *
 * Response when resume does NOT exist (onboarding needed):
 *   HTTP 404  { "exists": false }
 *
 * Error response (Blob unavailable):
 *   HTTP 502  { "error": "...", "detail": "..." }
 */
resumeRouter.get("/", async (c) => {
  try {
    const data = await readResumeData();

    if (!data) {
      // No resume yet — user needs to go through bootstrap onboarding.
      return c.json({ exists: false }, 404);
    }

    return c.json({ exists: true, resume: data });
  } catch (err) {
    console.error("[resume/] read failed:", err);
    return c.json(
      { error: "Failed to read resume", detail: err.message ?? String(err) },
      502
    );
  }
});

// ─── GET /api/resume/status ───────────────────────────────────────────────────

/**
 * Lightweight existence check — does not download the resume document body.
 *
 * Response shape when resume does NOT exist:
 *   { "exists": false }
 *
 * Response shape when resume DOES exist:
 *   {
 *     "exists": true,
 *     "url": "https://...",
 *     "uploadedAt": "2024-01-01T00:00:00.000Z",
 *     "size": 1234
 *   }
 *
 * Error response (Blob unavailable / misconfigured):
 *   HTTP 502  { "error": "Failed to check resume status", "detail": "..." }
 */
resumeRouter.get("/status", async (c) => {
  try {
    const result = await checkResumeExists();
    return c.json(result);
  } catch (err) {
    console.error("[resume/status] Blob check failed:", err);
    return c.json(
      {
        error: "Failed to check resume status",
        detail: err.message ?? String(err)
      },
      502
    );
  }
});

// ─── POST /api/resume/upload ──────────────────────────────────────────────────

/**
 * Store the raw PDF binary in Vercel Blob.
 *
 * Pure storage step: receives the PDF file via multipart/form-data and saves
 * it to Vercel Blob at `resume/resume.pdf`.  No text extraction or LLM
 * processing is performed here.  Use POST /api/resume/bootstrap for the full
 * bootstrap pipeline (upload → extract text → LLM → save resume JSON).
 *
 * Accepts multipart/form-data with:
 *   pdf  — PDF file (required, max 20 MB)
 *
 * Success response:
 *   HTTP 200  { "ok": true, "pathname": "resume/resume.pdf", "url": "...", "size": N }
 *
 * Error responses:
 *   HTTP 400  — missing pdf field, not a file, wrong MIME type, invalid PDF magic bytes,
 *               empty file, or file exceeds 20 MB size limit
 *   HTTP 500  — failed to buffer the uploaded file
 *   HTTP 502  — Vercel Blob save failed
 */
resumeRouter.post("/upload", async (c) => {
  // ── 1. Parse multipart body ────────────────────────────────────────────────
  let body;
  try {
    body = await c.req.parseBody();
  } catch (err) {
    console.error("[resume/upload] Failed to parse multipart body:", err);
    return c.json(
      { ok: false, error: "요청 본문을 파싱할 수 없습니다. multipart/form-data 형식으로 보내주세요." },
      400
    );
  }

  // ── 2. Validate the pdf field ──────────────────────────────────────────────
  const pdfField = body["pdf"];

  if (!pdfField) {
    return c.json({ ok: false, error: "pdf 필드가 없습니다." }, 400);
  }

  // Hono's parseBody returns File objects for file fields in multipart.
  if (
    typeof pdfField === "string" ||
    !(
      pdfField instanceof File ||
      (typeof pdfField === "object" && typeof pdfField.arrayBuffer === "function")
    )
  ) {
    return c.json({ ok: false, error: "pdf 필드는 파일이어야 합니다." }, 400);
  }

  const pdfFile = /** @type {File} */ (pdfField);

  // ── 3. Size guard (20 MB) ────────────────────────────────────────────────
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
  if (pdfFile.size && pdfFile.size > MAX_UPLOAD_BYTES) {
    return c.json(
      { ok: false, error: "파일 크기가 20 MB를 초과합니다." },
      400
    );
  }

  // ── 4. MIME type guard ────────────────────────────────────────────────────
  // Browsers send application/pdf; some tools send application/octet-stream.
  if (
    pdfFile.type &&
    pdfFile.type !== "application/pdf" &&
    pdfFile.type !== "application/octet-stream"
  ) {
    return c.json({ ok: false, error: "PDF 파일만 업로드할 수 있습니다." }, 400);
  }

  // ── 5. Buffer the file ───────────────────────────────────────────────────
  let pdfBuffer;
  try {
    pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
  } catch (err) {
    console.error("[resume/upload] Failed to read PDF file buffer:", err);
    return c.json(
      { ok: false, error: "PDF 파일을 읽을 수 없습니다." },
      500
    );
  }

  if (pdfBuffer.length === 0) {
    return c.json({ ok: false, error: "빈 파일입니다." }, 400);
  }

  // ── 6. Magic-bytes check: PDF files must start with %PDF- ────────────────
  if (
    pdfBuffer.length < 5 ||
    pdfBuffer.slice(0, 5).toString("ascii") !== "%PDF-"
  ) {
    return c.json({ ok: false, error: "유효한 PDF 파일이 아닙니다." }, 400);
  }

  // ── 7. Save raw PDF binary to Vercel Blob ─────────────────────────────────
  let saveResult;
  try {
    saveResult = await savePdfRaw(pdfBuffer);
    console.info(
      `[resume/upload] PDF stored in Vercel Blob` +
      ` name="${pdfFile.name ?? "resume.pdf"}"` +
      ` size=${pdfBuffer.length}`
    );
  } catch (err) {
    console.error("[resume/upload] Blob save failed:", err);
    return c.json(
      { ok: false, error: "PDF 저장에 실패했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  return c.json({
    ok: true,
    pathname: PDF_RAW_PATHNAME,
    url: saveResult.url,
    size: pdfBuffer.length
  });
});

// ─── POST /api/resume/bootstrap ───────────────────────────────────────────────

/**
 * Bootstrap a new living-resume from an uploaded PDF.
 *
 * Accepts multipart/form-data with:
 *   pdf           — PDF file (required, max 20 MB)
 *   linkedinUrl   — LinkedIn profile URL (optional string)
 *   linkedinData  — JSON-stringified LinkedIn profile object (optional)
 *   linkedinText  — Raw LinkedIn page text pasted by user (optional)
 *
 * Processing pipeline:
 *   1. Validate & buffer the PDF upload
 *   2. Sanity-check the %PDF- magic bytes
 *   3. Extract plain text with pdf-parse (resumeLlm.mjs)
 *   4. Store raw PDF binary in Vercel Blob (resume/resume.pdf) — non-critical
 *   5. Collect optional LinkedIn metadata from request body
 *   6. Call OpenAI Responses API → { resumeData, strengthKeywords, displayAxes }
 *      (resumeBootstrap.mjs — falls back to empty scaffold on LLM failure)
 *   7. Assemble the complete blob document
 *   8. Save the resume JSON to Vercel Blob (resume/data.json)
 *   9. Save extracted PDF text to Vercel Blob (resume/pdf-text.txt) — non-critical
 *  10. Generate LinkedIn gap suggestions if linkedinData provided
 *  11. Return the document to the client
 *
 * Success response:
 *   HTTP 201  { "ok": true, "resume": { ...document } }
 *
 * Error responses:
 *   HTTP 400  — missing PDF, wrong MIME type, invalid file, body parse failure
 *   HTTP 422  — PDF text extraction failed (corrupted / password-protected)
 *   HTTP 500  — resume generation failed unexpectedly
 *   HTTP 502  — Vercel Blob save failed
 */
resumeRouter.post("/bootstrap", async (c) => {
  // ── 1. Parse multipart body ────────────────────────────────────────────────
  let body;
  try {
    body = await c.req.parseBody();
  } catch (err) {
    console.error("[resume/bootstrap] Failed to parse multipart body:", err);
    return c.json(
      { error: "요청 본문을 파싱할 수 없습니다. multipart/form-data 형식으로 보내주세요." },
      400
    );
  }

  // ── 2. Validate the pdf field ──────────────────────────────────────────────
  const pdfField = body["pdf"];

  if (!pdfField) {
    return c.json({ error: "pdf 필드가 없습니다." }, 400);
  }

  // Hono's parseBody returns File objects for file fields in multipart.
  if (
    typeof pdfField === "string" ||
    !(
      pdfField instanceof File ||
      (typeof pdfField === "object" &&
        typeof pdfField.arrayBuffer === "function")
    )
  ) {
    return c.json({ error: "pdf 필드는 파일이어야 합니다." }, 400);
  }

  const pdfFile = /** @type {File} */ (pdfField);

  // Validate MIME type — browsers send application/pdf for PDF files.
  if (
    pdfFile.type &&
    pdfFile.type !== "application/pdf" &&
    pdfFile.type !== "application/octet-stream"
  ) {
    return c.json({ error: "PDF 파일만 업로드할 수 있습니다." }, 400);
  }

  // ── 3. Convert to Buffer ───────────────────────────────────────────────────
  let pdfBuffer;
  try {
    pdfBuffer = Buffer.from(await pdfFile.arrayBuffer());
  } catch (err) {
    console.error("[resume/bootstrap] Failed to read PDF file buffer:", err);
    return c.json({ error: "PDF 파일을 읽을 수 없습니다." }, 500);
  }

  // Sanity-check: PDF files start with the %PDF- magic bytes.
  if (
    pdfBuffer.length < 5 ||
    pdfBuffer.slice(0, 5).toString("ascii") !== "%PDF-"
  ) {
    return c.json({ error: "유효한 PDF 파일이 아닙니다." }, 400);
  }

  // ── 4. Extract plain text from PDF ────────────────────────────────────────
  let pdfText;
  try {
    pdfText = await extractPdfText(pdfBuffer);
  } catch (err) {
    console.error("[resume/bootstrap] PDF text extraction failed:", err);
    return c.json(
      {
        error:
          "PDF 텍스트를 추출할 수 없습니다. 암호화되지 않은 PDF를 업로드해 주세요.",
        detail: err.message ?? String(err)
      },
      422
    );
  }

  // ── 5. Store raw PDF binary in Vercel Blob (1:1 file mapping) ────────────
  // Non-critical: if it fails, bootstrap continues without the raw binary.
  // The extracted text is still saved later for reconstruction fallback.
  try {
    await savePdfRaw(pdfBuffer);
    console.info("[resume/bootstrap] Raw PDF binary stored in Vercel Blob");
  } catch (err) {
    console.warn("[resume/bootstrap] Failed to store raw PDF binary (non-fatal):", err.message ?? String(err));
  }

  // ── 6. Collect optional LinkedIn metadata ─────────────────────────────────
  const linkedinUrl =
    typeof body["linkedinUrl"] === "string" && body["linkedinUrl"].trim()
      ? body["linkedinUrl"].trim()
      : null;

  const linkedinDataRaw =
    typeof body["linkedinData"] === "string" ? body["linkedinData"].trim() : "";
  let linkedinData = null;
  if (linkedinDataRaw) {
    try {
      linkedinData = JSON.parse(linkedinDataRaw);
    } catch {
      // Malformed JSON — proceed without structured LinkedIn data.
    }
  }

  const linkedinText =
    typeof body["linkedinText"] === "string" && body["linkedinText"].trim()
      ? body["linkedinText"].trim()
      : null;

  // Derive source tag for meta
  const hasLinkedin = Boolean(linkedinData || linkedinText);
  const source = pdfText && hasLinkedin ? "pdf+linkedin" : hasLinkedin ? "linkedin" : "pdf";

  // ── 7. Generate structured resume via LLM (with empty-scaffold fallback) ──
  let bootstrapResult;
  try {
    bootstrapResult = await generateResumeFromText({
      pdfText,
      linkedinData,
      linkedinText,
      source
    });
  } catch (err) {
    // LLM unavailable (no API key, API error, etc.) — build a minimal scaffold
    // from LinkedIn data so the user gets something to edit rather than a hard error.
    console.warn(
      "[resume/bootstrap] LLM generation failed, using empty scaffold:",
      err.message
    );
    bootstrapResult = buildEmptyScaffold({ linkedinData, source });
  }

  // ── 8. Assemble the complete Blob document ─────────────────────────────────
  // The stored document merges the LLM-generated resumeData with strength keywords
  // and display axes into a single flat envelope with application-level metadata.
  const pdfName =
    typeof pdfFile.name === "string" && pdfFile.name
      ? pdfFile.name
      : "resume.pdf";

  const blobDocument = assembleBlobDocument(bootstrapResult, {
    pdfName,
    linkedinUrl
  });

  // ── 9. Save resume JSON to Vercel Blob ────────────────────────────────────
  try {
    await saveResumeData(blobDocument);
  } catch (err) {
    console.error("[resume/bootstrap] Blob save failed:", err);
    return c.json(
      { error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  // ── 9b. Save extracted PDF text to Vercel Blob ────────────────────────────
  // Stored non-critically: if it fails, bootstrap still succeeds.
  if (pdfText) {
    try {
      await savePdfText(pdfText);
      console.info("[resume/bootstrap] PDF text saved to Vercel Blob");
    } catch (err) {
      console.warn("[resume/bootstrap] Failed to save PDF text (non-fatal):", err.message);
    }
  }

  // ── 9c. Save strength keywords to dedicated Vercel Blob ───────────────────
  // Stored at resume/strength-keywords.json separately from the main resume
  // document so keyword reads/writes don't require fetching the full resume.
  // Non-critical: if it fails, bootstrap still succeeds (keywords are also in
  // the main resume document as strength_keywords[]).
  try {
    const kwDoc = initStrengthKeywordsFromBootstrap(bootstrapResult.strengthKeywords);
    await saveStrengthKeywords(kwDoc);
    console.info(
      `[resume/bootstrap] Strength keywords saved (${kwDoc.keywords.length} keyword(s))`
    );
  } catch (err) {
    console.warn(
      "[resume/bootstrap] Failed to save strength keywords (non-fatal):", err.message
    );
  }

  console.info(
    `[resume/bootstrap] Bootstrapped resume` +
      ` name="${blobDocument.contact?.name || "(unknown)"}"` +
      ` source="${blobDocument.meta?.source}"` +
      ` pdf="${pdfName}"` +
      ` exp=${blobDocument.experience?.length ?? 0}` +
      ` skills.tech=${blobDocument.skills?.technical?.length ?? 0}` +
      ` keywords=${blobDocument.strength_keywords?.length ?? 0}` +
      ` axes=${blobDocument.display_axes?.length ?? 0}`
  );

  // ── 10. Generate LinkedIn gap suggestions (when structured LinkedIn data exists)
  // Run rule-based diff between the fetched LinkedIn ProfileData and the final
  // assembled resume document.  Any items present in LinkedIn but absent from
  // the resume are stored as pending suggestions for the user to review.
  // Failure here is non-fatal — bootstrap still succeeds.
  if (linkedinData && typeof linkedinData === "object") {
    try {
      const { gaps } = analyzeGaps(linkedinData, blobDocument);
      const newSuggestions = gapItemsToSuggestions(gaps);
      if (newSuggestions.length > 0) {
        const suggestionsDoc = {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          suggestions: newSuggestions
        };
        await saveSuggestionsData(suggestionsDoc);
        console.info(
          `[resume/bootstrap] Generated ${newSuggestions.length} LinkedIn gap suggestion(s)`
        );
      }
    } catch (err) {
      console.warn("[resume/bootstrap] Failed to generate suggestions:", err.message);
    }
  }

  // ── 11. Return result to client ───────────────────────────────────────────
  return c.json({ ok: true, resume: blobDocument }, 201);
});

// ─── POST /api/resume/gap-analysis ───────────────────────────────────────────

/**
 * Compare LinkedIn profile data against the stored resume document and return
 * a structured list of gaps (missing fields and discrepancies).
 *
 * This endpoint is called during the onboarding flow after the user provides
 * LinkedIn data, so the system can surface enrichment suggestions before (or
 * after) bootstrapping.  No LLM calls are made — the comparison is fully
 * rule-based (see src/lib/resumeGapAnalysis.mjs).
 *
 * Request body (JSON):
 *   {
 *     "linkedinData": {            // Required — ProfileData from /api/resume/linkedin
 *       "name":     string|null,
 *       "headline": string|null,
 *       "about":    string|null,
 *       "location": string|null,
 *       "profileImageUrl": string|null,
 *       "experience": [{ title, company, duration, description }],
 *       "education":  [{ school, degree, field, years }],
 *       "skills":     string[]
 *     }
 *   }
 *
 * Success responses:
 *   HTTP 200  {
 *     "ok": true,
 *     "gaps": GapItem[],
 *     "summary": {
 *       "total": number,
 *       "missing_fields": number,
 *       "discrepancies": number,
 *       "missing_entries": number,
 *       "missing_skills_count": number
 *     }
 *   }
 *
 *   When no resume exists yet (onboarding not complete):
 *   HTTP 200  { "ok": true, "gaps": [], "summary": { "total": 0, ... }, "no_resume": true }
 *
 * Error responses:
 *   HTTP 400  { "ok": false, "error": "linkedinData is required" }
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }
 */
resumeRouter.post("/gap-analysis", async (c) => {
  // ── 1. Parse and validate request body ────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON" }, 400);
  }

  const linkedinData = body?.linkedinData;
  if (!linkedinData || typeof linkedinData !== "object") {
    return c.json(
      { ok: false, error: "linkedinData is required and must be an object" },
      400
    );
  }

  // ── 2. Load the stored resume (may not exist yet during onboarding) ────────
  let resumeDoc;
  try {
    resumeDoc = await readResumeData();
  } catch (err) {
    console.error("[resume/gap-analysis] Failed to read resume:", err);
    return c.json(
      {
        ok: false,
        error: "Failed to read resume",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  // ── 3. When no resume exists, return empty gap list with a flag ────────────
  if (!resumeDoc) {
    return c.json({
      ok: true,
      no_resume: true,
      gaps: [],
      summary: {
        total: 0,
        missing_fields: 0,
        discrepancies: 0,
        missing_entries: 0,
        missing_skills_count: 0
      }
    });
  }

  // ── 4. Run rule-based gap analysis ────────────────────────────────────────
  const { gaps, summary } = analyzeGaps(linkedinData, resumeDoc);

  console.info(
    `[resume/gap-analysis] total=${summary.total}` +
      ` missing_fields=${summary.missing_fields}` +
      ` discrepancies=${summary.discrepancies}` +
      ` missing_entries=${summary.missing_entries}` +
      ` missing_skills=${summary.missing_skills_count}`
  );

  return c.json({ ok: true, gaps, summary });
});

// ─── POST /api/resume/generate-candidates ────────────────────────────────────────────

/**
 * Generate resume update candidates from a daily work log summary.
 *
 * Diff-based candidate generation pipeline (Sub-AC 12c):
 *   1. Load current resume JSON from Vercel Blob               (blob.mjs)
 *   2. Receive work log data in request body
 *   3. Rule-based pre-diff + LLM partial generation            (resumeWorkLogExtract.mjs)
 *        a. buildWorkLogDiff: filter work-log candidates already in the resume
 *        b. Short-circuit: skip LLM when nothing genuinely new exists
 *        c. LLM partial generation: refine only the diff context (not full resume)
 *   4. Merge LLM extract into existing resume → proposed doc   (resumeWorkLogMerge.mjs)
 *   5. Rule-based diff existing vs proposed                    (resumeDiff.mjs)
 *   5.5. Delta ratio check (≥ 3% threshold)                    (resumeDeltaRatio.mjs)
 *   6. Convert diff to SuggestionItems                         (resumeDiffToSuggestions.mjs)
 *   7. Batch-discard all existing pending candidates (superseded, AC 13)
 *   8. Append new candidates and save to Vercel Blob; return new suggestions
 *
 * AC 13 — supersede semantics:
 *   Every call to generate-candidates replaces the previous pending batch.
 *   All suggestions currently in "pending" status are transitioned to
 *   "discarded" with discardReason: "superseded" before the new batch is
 *   written.  This guarantees only one active (pending) generation at a time.
 *
 * Request body: { "date": "YYYY-MM-DD", "workLog": { ...GET /api/day/:date response } }
 * Response:     { "ok": true, "generated": number, "superseded": number, "suggestions": SuggestionItem[] }
 */
resumeRouter.post("/generate-candidates", async (c) => {
  // ── 1. Parse and validate request body ─────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON" }, 400);
  }

  const { date, workLog } = body ?? {};

  if (!date || typeof date !== "string") {
    return c.json(
      { ok: false, error: "date 필드가 필요합니다. (YYYY-MM-DD 형식)" },
      400
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json(
      {
        ok: false,
        error: "날짜 형식이 잘못되었습니다. YYYY-MM-DD 형식을 사용해 주세요."
      },
      400
    );
  }
  if (!workLog || typeof workLog !== "object") {
    return c.json(
      {
        ok: false,
        error:
          "workLog 필드가 필요합니다. GET /api/day/:date 응답을 그대로 전달해 주세요."
      },
      400
    );
  }

  // ── 2. Load the current resume from Blob ─────────────────────────────────────────
  let existingResume;
  try {
    existingResume = await readResumeData();
  } catch (err) {
    console.error("[resume/generate-candidates] Failed to read resume:", err);
    return c.json(
      {
        ok: false,
        error: "이력서를 불러오지 못했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  if (!existingResume) {
    return c.json(
      {
        ok: false,
        error: "이력서가 없습니다. 먼저 PDF 업로드로 이력서를 생성해 주세요."
      },
      404
    );
  }

  // ── 3. LLM: extract partial resume updates from work log (cache-first) ─────
  //
  // Before calling the LLM, check whether a WorkLogExtract for this date was
  // already computed and cached (Vercel Blob at cache/extract/{date}.json).
  // A cache HIT skips the LLM call entirely; a cache MISS calls the LLM and
  // then persists the result so subsequent calls for the same date are served
  // from cache.
  //
  // Cache hit/miss determination:
  //   HIT  — readExtractCache(date) returns a non-null WorkLogExtract object
  //           (schemaVersion matches and the Blob entry is readable).
  //   MISS — readExtractCache(date) returns null (absent, fetch error, or
  //           schema mismatch).
  let extract;
  const cachedExtract = await readExtractCache(date);

  if (cachedExtract !== null) {
    // ── Cache HIT: use the cached WorkLogExtract, skip LLM ─────────────────
    console.info(
      `[resume/generate-candidates] Cache HIT for date="${date}" — using cached extract, LLM call skipped`
    );
    extract = cachedExtract;
  } else {
    // ── Cache MISS: call LLM, then persist the result for future requests ──
    console.info(
      `[resume/generate-candidates] Cache MISS for date="${date}" — calling LLM`
    );
    try {
      extract = await extractResumeUpdatesFromWorkLog(workLog, existingResume);
    } catch (err) {
      console.error(
        "[resume/generate-candidates] LLM extraction failed:",
        err.message
      );
      return c.json(
        {
          ok: false,
          error: "업무 로그에서 이력서 업데이트를 추출하지 못했습니다.",
          detail: err.message ?? String(err)
        },
        502
      );
    }

    // Persist the extract to cache (fire-and-forget — failure must not block
    // the response; a write error is logged inside writeExtractCache).
    writeExtractCache(date, extract).catch(() => {});
  }

  // ── 4. Merge: apply LLM extract into existing resume → proposed document ────
  const proposedResume = mergeWorkLogIntoResume(existingResume, extract);

  // ── 5. Diff: find what changed (rule-based, no LLM) ──────────────────────────────
  const diff = diffResume(existingResume, proposedResume);

  if (diff.isEmpty) {
    console.info(
      `[resume/generate-candidates] No diff for date="${date}" — no new candidates`
    );
    return c.json({
      ok: true,
      generated: 0,
      suggestions: [],
      message: "오늘 업무 로그에서 새로운 이력서 업데이트 후보를 찾지 못했습니다."
    });
  }

  // ── 5.5. Delta ratio threshold check (AC 10-2) ───────────────────────────────
  // Compute the ratio of changed items relative to the total addressable items
  // in the existing resume.  Candidate records are only created when the delta
  // ratio reaches the minimum threshold (DELTA_THRESHOLD = 3 %).  Sub-threshold
  // diffs are too minor to produce meaningful merge candidates.
  const deltaMetrics = computeDeltaRatio(diff, existingResume);
  if (!exceedsDeltaThreshold(diff, existingResume)) {
    const pct = (deltaMetrics.ratio * 100).toFixed(2);
    console.info(
      `[resume/generate-candidates] Delta ratio ${pct}% < ${(DELTA_THRESHOLD * 100).toFixed(0)}% threshold for date="${date}" — skipping candidate creation` +
        ` (changed=${deltaMetrics.changedCount}, total=${deltaMetrics.totalCount})`
    );
    return c.json({
      ok: true,
      generated: 0,
      suggestions: [],
      deltaRatio: deltaMetrics.ratio,
      deltaChangedCount: deltaMetrics.changedCount,
      deltaTotalCount: deltaMetrics.totalCount,
      message: `변경 비율(${pct}%)이 최소 임계값(${(DELTA_THRESHOLD * 100).toFixed(0)}%) 미만으로 merge 후보를 생성하지 않습니다.`
    });
  }

  console.info(
    `[resume/generate-candidates] Delta ratio ${(deltaMetrics.ratio * 100).toFixed(2)}% ≥ ${(DELTA_THRESHOLD * 100).toFixed(0)}% threshold for date="${date}"` +
      ` (changed=${deltaMetrics.changedCount}, total=${deltaMetrics.totalCount}) — proceeding with candidate creation`
  );

  // ── 6. Convert diff to pending SuggestionItems ───────────────────────────────────────────
  const rawSuggestions = diffToSuggestions(diff, date);

  if (rawSuggestions.length === 0) {
    return c.json({
      ok: true,
      generated: 0,
      suggestions: [],
      message: "변경 사항을 제안으로 변환할 수 없습니다."
    });
  }

  // ── 7. Load existing suggestions ────────────────────────────────────────────
  let suggestionsDoc;
  try {
    suggestionsDoc = await readSuggestionsData();
  } catch (err) {
    console.error(
      "[resume/generate-candidates] Failed to read suggestions:",
      err
    );
    return c.json(
      {
        ok: false,
        error: "기존 제안 목록을 불러오지 못했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  // ── 8. Supersede all existing pending candidates (AC 13) ─────────────────────
  // New candidates always represent the latest generation run.  Stale pending
  // items from previous runs are batch-discarded so the user never sees an
  // accumulating backlog — only the current run's candidates remain pending.
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
      `[resume/generate-candidates] Superseding ${pendingToDiscard.length} existing pending candidate(s) — batch discard`
    );
  }

  // ── 9. Save updated suggestions document to Blob ─────────────────────────────
  const updatedDoc = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [...supersededSuggestions, ...rawSuggestions]
  };

  try {
    await saveSuggestionsData(updatedDoc);
  } catch (err) {
    console.error(
      "[resume/generate-candidates] Failed to save suggestions:",
      err
    );
    return c.json(
      {
        ok: false,
        error: "제안 저장에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  console.info(
    `[resume/generate-candidates] Generated ${rawSuggestions.length} new candidate(s) for date="${date}"` +
      (pendingToDiscard.length > 0
        ? ` (${pendingToDiscard.length} previous pending superseded)`
        : "")
  );

  return c.json({
    ok: true,
    generated: rawSuggestions.length,
    superseded: pendingToDiscard.length,
    deltaRatio: deltaMetrics.ratio,
    deltaChangedCount: deltaMetrics.changedCount,
    deltaTotalCount: deltaMetrics.totalCount,
    suggestions: rawSuggestions
  });
});

// ─── GET /api/resume/suggestions ─────────────────────────────────────────────

/**
 * Return the list of pending (unapproved) resume update suggestions.
 *
 * Response:
 *   HTTP 200  { "suggestions": SuggestionItem[] }
 *
 * A SuggestionItem has the shape:
 *   {
 *     id:          string,
 *     createdAt:   ISO datetime,
 *     status:      "pending" | "approved" | "rejected",
 *     section:     "summary" | "experience" | "skills" | "projects" | "education" | "certifications",
 *     action:      "update_summary" | "append_bullet" | "add_skill" | "add_experience" | "update_field",
 *     description: string,           // human-readable, in resume language
 *     patch:       object,           // action-specific payload (see applySuggestionPatch)
 *     source:      "work_log" | "manual",
 *     logDate?:    string            // ISO date, only when source === "work_log"
 *   }
 *
 * Only "pending" items are returned by default.
 * Pass ?all=1 to include approved and rejected items.
 */
resumeRouter.get("/suggestions", async (c) => {
  try {
    const doc = await readSuggestionsData();
    const all = c.req.query("all") === "1";
    const items = all
      ? doc.suggestions
      : doc.suggestions.filter((s) => s.status === "pending");
    return c.json({ suggestions: items });
  } catch (err) {
    console.error("[resume/suggestions] read failed:", err);
    return c.json(
      { error: "제안 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }
});

// ─── POST /api/resume/suggestions/from-linkedin ──────────────────────────────

/**
 * Convert LinkedIn gap analysis results into storable pending suggestions.
 *
 * This endpoint bridges the gap between the read-only POST /gap-analysis (which
 * only returns gaps without persisting them) and the suggestions workflow.
 *
 * Pipeline:
 *   1. Accept LinkedIn profile data in request body
 *   2. Load current resume from Blob
 *   3. Run rule-based gap analysis (resumeGapAnalysis.analyzeGaps)
 *   4. Convert gap items to SuggestionItem objects (resumeSuggestions.gapItemsToSuggestions)
 *   5. Deduplicate against existing pending linkedin suggestions
 *   6. Save to Blob and return new suggestions
 *
 * Request body:
 *   { "linkedinData": ProfileData }
 *
 * Success response:
 *   HTTP 200  { "ok": true, "added": number, "suggestions": SuggestionItem[], "summary": GapSummary }
 *
 * Error responses:
 *   HTTP 400  — missing or invalid linkedinData
 *   HTTP 404  — no resume found (bootstrap first)
 *   HTTP 502  — Blob I/O failure
 */
resumeRouter.post("/suggestions/from-linkedin", async (c) => {
  // ── 1. Parse and validate request body ────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be valid JSON" }, 400);
  }

  const linkedinData = body?.linkedinData;
  if (!linkedinData || typeof linkedinData !== "object") {
    return c.json(
      { ok: false, error: "linkedinData is required and must be an object" },
      400
    );
  }

  // ── 2. Load current resume ─────────────────────────────────────────────────
  let resumeDoc;
  try {
    resumeDoc = await readResumeData();
  } catch (err) {
    console.error("[resume/suggestions/from-linkedin] read resume failed:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resumeDoc) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 PDF를 업로드해 이력서를 생성해 주세요." },
      404
    );
  }

  // ── 3. Run rule-based gap analysis ─────────────────────────────────────────
  const { gaps, summary } = analyzeGaps(linkedinData, resumeDoc);

  console.info(
    `[resume/suggestions/from-linkedin] gap-analysis total=${summary.total}` +
      ` missing_fields=${summary.missing_fields}` +
      ` discrepancies=${summary.discrepancies}` +
      ` missing_entries=${summary.missing_entries}` +
      ` missing_skills=${summary.missing_skills_count}`
  );

  if (gaps.length === 0) {
    return c.json({ ok: true, added: 0, suggestions: [], summary });
  }

  // ── 4. Convert gap items to SuggestionItem objects ─────────────────────────
  const newSuggestions = gapItemsToSuggestions(gaps);

  if (newSuggestions.length === 0) {
    return c.json({ ok: true, added: 0, suggestions: [], summary });
  }

  // ── 5. Load existing suggestions and deduplicate ───────────────────────────
  let suggestionsDoc;
  try {
    suggestionsDoc = await readSuggestionsData();
  } catch (err) {
    console.error(
      "[resume/suggestions/from-linkedin] read suggestions failed:",
      err
    );
    return c.json(
      { ok: false, error: "제안 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  const existingPendingLinkedin = suggestionsDoc.suggestions.filter(
    (s) => s.status === "pending" && s.source === "linkedin"
  );

  const uniqueNew = newSuggestions.filter(
    (ns) => !existingPendingLinkedin.some((es) => _linkedinSuggestionIsDuplicate(ns, es))
  );

  if (uniqueNew.length === 0) {
    return c.json({
      ok: true,
      added: 0,
      suggestions: [],
      summary,
      message: "새로운 LinkedIn 갭 제안이 없습니다. 이미 동일한 제안이 대기 중입니다."
    });
  }

  // ── 6. Merge and save ──────────────────────────────────────────────────────
  const updatedDoc = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [...suggestionsDoc.suggestions, ...uniqueNew]
  };

  try {
    await saveSuggestionsData(updatedDoc);
  } catch (err) {
    console.error(
      "[resume/suggestions/from-linkedin] save suggestions failed:",
      err
    );
    return c.json(
      { ok: false, error: "제안 저장에 실패했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  console.info(
    `[resume/suggestions/from-linkedin] added=${uniqueNew.length}` +
      ` (${newSuggestions.length - uniqueNew.length} duplicate(s) skipped)`
  );

  return c.json({ ok: true, added: uniqueNew.length, suggestions: uniqueNew, summary });
});

// ─── POST /api/resume/suggestions/:id/approve ────────────────────────────────

/**
 * Approve a pending suggestion and apply its patch to the live resume.
 *
 * Processing:
 *   1. Load suggestions document
 *   2. Find the suggestion by id — 404 if not found
 *   3. Verify status === "pending" — 409 if already processed
 *   4. Load the current resume — 404 if none
 *   5. Apply the suggestion's patch to the resume (user edits win over future merges)
 *   6. Save the updated resume to Blob
 *   7. Mark suggestion as "approved", save suggestions to Blob
 *   8. Return updated resume
 *
 * Response:
 *   HTTP 200  { "ok": true, "resume": { ...updatedDocument } }
 */
resumeRouter.post("/suggestions/:id/approve", async (c) => {
  const suggestionId = c.req.param("id");

  // 1. Load suggestions
  let doc;
  try {
    doc = await readSuggestionsData();
  } catch (err) {
    console.error("[resume/suggestions/approve] read suggestions failed:", err);
    return c.json({ error: "제안 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) }, 502);
  }

  // 2. Find suggestion
  const idx = doc.suggestions.findIndex((s) => s.id === suggestionId);
  if (idx === -1) {
    return c.json({ error: "제안을 찾을 수 없습니다." }, 404);
  }
  const suggestion = doc.suggestions[idx];

  // 3. Verify it is still pending
  if (suggestion.status !== "pending") {
    return c.json(
      { error: `이미 처리된 제안입니다. (status: ${suggestion.status})` },
      409
    );
  }

  // 4. Load current resume
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/suggestions/approve] read resume failed:", err);
    return c.json({ error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) }, 502);
  }
  if (!resume) {
    return c.json({ error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." }, 404);
  }

  // 5. Apply patch — user edits always win; patch is applied non-destructively.
  //    Items created/modified via approval are tagged _source:"user_approved" to
  //    distinguish them from bootstrap system items (_source:"system") and
  //    direct user edits (_source:"user").
  let updatedResume;
  try {
    updatedResume = applySuggestionPatch(resume, suggestion, { itemSource: "user_approved" });
  } catch (err) {
    console.error("[resume/suggestions/approve] patch failed:", err);
    return c.json(
      { error: "제안 적용에 실패했습니다.", detail: err.message ?? String(err) },
      422
    );
  }

  // 6. Snapshot the current resume state before overwriting (non-fatal).
  //    Stored at resume/snapshots/{timestamp}.json as a rollback baseline.
  try {
    await saveSnapshot(resume, { label: "pre-approve", triggeredBy: "approve" });
  } catch (snapshotErr) {
    console.warn(
      "[resume/suggestions/approve] snapshot failed (non-fatal):",
      snapshotErr
    );
  }

  // 7. Save updated resume
  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/suggestions/approve] save resume failed:", err);
    return c.json({ error: "이력서 저장에 실패했습니다.", detail: err.message ?? String(err) }, 502);
  }

  // 8. Mark suggestion as approved and save
  doc.suggestions[idx] = { ...suggestion, status: "approved", approvedAt: new Date().toISOString() };
  doc.updatedAt = new Date().toISOString();
  try {
    await saveSuggestionsData(doc);
  } catch (err) {
    // Non-fatal: resume already updated; log but don't fail the request
    console.error("[resume/suggestions/approve] save suggestions failed:", err);
  }

  console.info(`[resume/suggestions/approve] approved id="${suggestionId}" action="${suggestion.action}" section="${suggestion.section}"`);

  return c.json({ ok: true, resume: updatedResume });
});

// ─── POST /api/resume/suggestions/:id/reject ─────────────────────────────────

/**
 * Reject a pending suggestion (no changes to the resume).
 *
 * Response:
 *   HTTP 200  { "ok": true }
 */
resumeRouter.post("/suggestions/:id/reject", async (c) => {
  const suggestionId = c.req.param("id");

  let doc;
  try {
    doc = await readSuggestionsData();
  } catch (err) {
    console.error("[resume/suggestions/reject] read suggestions failed:", err);
    return c.json({ error: "제안 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) }, 502);
  }

  const idx = doc.suggestions.findIndex((s) => s.id === suggestionId);
  if (idx === -1) {
    return c.json({ error: "제안을 찾을 수 없습니다." }, 404);
  }
  const suggestion = doc.suggestions[idx];

  if (suggestion.status !== "pending") {
    return c.json(
      { error: `이미 처리된 제안입니다. (status: ${suggestion.status})` },
      409
    );
  }

  doc.suggestions[idx] = { ...suggestion, status: "rejected", rejectedAt: new Date().toISOString() };
  doc.updatedAt = new Date().toISOString();

  try {
    await saveSuggestionsData(doc);
  } catch (err) {
    console.error("[resume/suggestions/reject] save failed:", err);
    return c.json({ error: "저장에 실패했습니다.", detail: err.message ?? String(err) }, 502);
  }

  console.info(`[resume/suggestions/reject] rejected id="${suggestionId}" action="${suggestion.action}" section="${suggestion.section}"`);

  return c.json({ ok: true });
});

// ─── PATCH /api/resume/suggestions/:id ───────────────────────────────────────

/**
 * Edit the patch payload of a pending suggestion before it is approved.
 *
 * Only pending suggestions can be edited. The update is non-destructive: only
 * the fields provided in the request body are updated; the rest of the
 * suggestion (action, section, source, etc.) is preserved unchanged.
 *
 * Allowed update fields:
 *   patch       — new action-specific payload object (replaces existing patch)
 *   description — updated human-readable description string
 *
 * Request body (JSON) — at least one field required:
 *   { "patch": object, "description": string }
 *
 * Response:
 *   HTTP 200  { "ok": true, "suggestion": SuggestionItem }
 *
 * Error responses:
 *   HTTP 400  — missing body fields
 *   HTTP 404  — suggestion not found
 *   HTTP 409  — suggestion already processed (not pending)
 *   HTTP 502  — Blob I/O failure
 */
resumeRouter.patch("/suggestions/:id", async (c) => {
  const suggestionId = c.req.param("id");

  // 1. Parse body
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be valid JSON" }, 400);
  }

  // payload is accepted for BulletProposal (kind: 'bullet') inline edits.
  // Legacy SuggestionItems use patch; BulletProposals use payload.
  const { patch, description, payload } = body ?? {};

  if (patch === undefined && description === undefined && payload === undefined) {
    return c.json(
      { ok: false, error: "patch, payload 또는 description 필드 중 하나가 필요합니다." },
      400
    );
  }

  // 2. Load suggestions
  let doc;
  try {
    doc = await readSuggestionsData();
  } catch (err) {
    console.error("[resume/suggestions/edit] read suggestions failed:", err);
    return c.json(
      { error: "제안 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  // 3. Find suggestion by id
  const idx = doc.suggestions.findIndex((s) => s.id === suggestionId);
  if (idx === -1) {
    return c.json({ error: "제안을 찾을 수 없습니다." }, 404);
  }

  const suggestion = doc.suggestions[idx];

  // 4. Must be pending
  if (suggestion.status !== "pending") {
    return c.json(
      { error: `이미 처리된 제안입니다. (status: ${suggestion.status})` },
      409
    );
  }

  // 5. Apply allowed updates
  const updated = { ...suggestion };

  // Legacy SuggestionItem: update patch object
  if (patch !== undefined && typeof patch === "object" && patch !== null) {
    updated.patch = patch;
  }

  // BulletProposal (kind: 'bullet'): update payload object (inline text editing).
  // Merges into existing payload to preserve op-irrelevant fields.
  // Only text-bearing ops (add/replace) are meaningful to edit; delete proposals
  // have no text, but we accept the update anyway and let the client guard it.
  if (payload !== undefined && typeof payload === "object" && payload !== null) {
    updated.payload = { ...(updated.payload ?? {}), ...payload };
  }

  if (typeof description === "string" && description.trim()) {
    updated.description = description.trim();
  }

  updated.editedAt = new Date().toISOString();

  doc.suggestions[idx] = updated;
  doc.updatedAt = new Date().toISOString();

  // 6. Save
  try {
    await saveSuggestionsData(doc);
  } catch (err) {
    console.error("[resume/suggestions/edit] save failed:", err);
    return c.json(
      { error: "저장에 실패했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  console.info(
    `[resume/suggestions/edit] edited id="${suggestionId}" action="${suggestion.action}"`
  );

  return c.json({ ok: true, suggestion: updated });
});

// ─── GET /api/resume/candidates ──────────────────────────────────────────────

/**
 * List resume update candidates available for review.
 *
 * This is the primary list endpoint for the /resume suggestion panel (type B).
 * Candidates are stored in the same suggestions document as other SuggestionItems;
 * "candidates" is the UI-facing term for items awaiting user decision.
 *
 * By default returns only "pending" candidates.
 * Pass ?all=1 to include approved, discarded, and rejected items as well.
 * Pass ?status=approved|discarded|rejected to filter to a specific status.
 *
 * Response:
 *   HTTP 200  { "ok": true, "candidates": SuggestionItem[], "total": number }
 *
 * Error response (Blob unavailable):
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }
 */
resumeRouter.get("/candidates", async (c) => {
  try {
    const doc = await readSuggestionsData();
    const all = c.req.query("all") === "1";
    const statusFilter = c.req.query("status"); // optional single-status filter

    let items;
    if (statusFilter && ["pending", "approved", "discarded", "rejected"].includes(statusFilter)) {
      items = doc.suggestions.filter((s) => s.status === statusFilter);
    } else if (all) {
      items = doc.suggestions;
    } else {
      items = doc.suggestions.filter((s) => s.status === "pending");
    }

    return c.json({ ok: true, candidates: items, total: items.length });
  } catch (err) {
    console.error("[resume/candidates] read failed:", err);
    return c.json(
      { ok: false, error: "후보 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }
});

// ─── PATCH /api/resume/candidates/:id ────────────────────────────────────────

/**
 * Transition a resume update candidate's status.
 *
 * This is a unified state-machine endpoint that replaces the separate
 * POST .../approve and POST .../reject endpoints for the candidates UI.
 * The underlying storage is the same suggestions document; "candidates"
 * is the UI-facing terminology for items that are still pending review.
 *
 * Allowed transitions:
 *   pending → approved   — apply the patch to the live resume and save
 *   pending → discarded  — mark the candidate as discarded (no resume change)
 *
 * Request body (JSON):
 *   { "status": "approved" | "discarded" }
 *
 * Processing when status === "approved":
 *   1. Load suggestions document — find candidate by id (404 if missing)
 *   2. Verify current status === "pending" (409 if already processed)
 *   3. Load the live resume (404 if none exists)
 *   4. Apply the candidate's patch via applySuggestionPatch (user edits win)
 *   5. Save updated resume to Blob
 *   6. Mark candidate as "approved" with approvedAt timestamp, save suggestions
 *   7. Return { ok: true, status: "approved", resume: updatedDocument }
 *
 * Processing when status === "discarded":
 *   1. Load suggestions document — find candidate by id (404 if missing)
 *   2. Verify current status === "pending" (409 if already processed)
 *   3. Mark candidate as "discarded" with discardedAt timestamp, save suggestions
 *   4. Return { ok: true, status: "discarded" }
 *
 * Response (approved):
 *   HTTP 200  { "ok": true, "status": "approved", "resume": { ...updatedDocument } }
 *
 * Response (discarded):
 *   HTTP 200  { "ok": true, "status": "discarded" }
 *
 * Error responses:
 *   HTTP 400  — missing or invalid status value
 *   HTTP 404  — candidate not found, or resume missing (on approve)
 *   HTTP 409  — candidate already processed (not pending)
 *   HTTP 422  — patch could not be applied (on approve)
 *   HTTP 502  — Blob I/O failure
 */
resumeRouter.patch("/candidates/:id", async (c) => {
  const candidateId = c.req.param("id");

  // ── 1. Parse and validate request body ──────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be valid JSON" }, 400);
  }

  const { status } = body ?? {};

  if (status !== "approved" && status !== "discarded") {
    return c.json(
      {
        ok: false,
        error: 'status 필드는 "approved" 또는 "discarded" 이어야 합니다.',
        received: status ?? null
      },
      400
    );
  }

  // ── 2. Load suggestions document ────────────────────────────────────────────
  let doc;
  try {
    doc = await readSuggestionsData();
  } catch (err) {
    console.error("[resume/candidates/patch] read suggestions failed:", err);
    return c.json(
      { ok: false, error: "후보 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  // ── 3. Locate the candidate by id ───────────────────────────────────────────
  const idx = doc.suggestions.findIndex((s) => s.id === candidateId);
  if (idx === -1) {
    return c.json({ ok: false, error: "후보를 찾을 수 없습니다." }, 404);
  }

  const candidate = doc.suggestions[idx];

  // ── 4. Enforce pending-only transition ──────────────────────────────────────
  if (candidate.status !== "pending") {
    return c.json(
      {
        ok: false,
        error: `이미 처리된 후보입니다. (현재 status: ${candidate.status})`
      },
      409
    );
  }

  // ── 5. Branch: approved ─────────────────────────────────────────────────────
  if (status === "approved") {
    // 5a. Load the live resume
    let resume;
    try {
      resume = await readResumeData();
    } catch (err) {
      console.error("[resume/candidates/patch] read resume failed:", err);
      return c.json(
        { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
        502
      );
    }
    if (!resume) {
      return c.json(
        { ok: false, error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." },
        404
      );
    }

    // 5b. For delete_item candidates: save a pre-deletion snapshot BEFORE
    //     applying the patch so the deleted item is preserved for rollback (AC 23).
    //     This snapshot has label:"pre-delete" to distinguish it from the
    //     post-approval snapshot saved below.  Failure is non-fatal.
    if (candidate.action === "delete_item") {
      try {
        await saveSnapshot(resume, {
          label: "pre-delete",
          trigger: "delete_item_approve",
          triggeredBy: "approve"
        });
      } catch (snapshotErr) {
        console.warn(
          "[resume/candidates/patch] pre-delete snapshot failed (non-fatal):",
          snapshotErr
        );
      }
    }

    // 5c. Apply the candidate's patch (user edits always win over future merges).
    //     Items created/modified via approval are tagged _source:"user_approved" to
    //     distinguish them from bootstrap system items (_source:"system") and
    //     direct user edits (_source:"user").
    let updatedResume;
    try {
      updatedResume = applySuggestionPatch(resume, candidate, { itemSource: "user_approved" });
    } catch (err) {
      console.error("[resume/candidates/patch] patch application failed:", err);
      return c.json(
        { ok: false, error: "후보 적용에 실패했습니다.", detail: err.message ?? String(err) },
        422
      );
    }

    // 5d. Persist updated resume
    try {
      await saveResumeData(updatedResume);
    } catch (err) {
      console.error("[resume/candidates/patch] save resume failed:", err);
      return c.json(
        { ok: false, error: "이력서 저장에 실패했습니다.", detail: err.message ?? String(err) },
        502
      );
    }

    // 5e. Snapshot the approved resume state (non-fatal).
    //     Stored at resume/snapshots/{timestamp}.json with trigger:'approve'
    //     so that getLastApprovedSnapshot() can locate this entry for delta computation.
    //     Contains the post-approval resume (updatedResume), not the pre-approval state.
    try {
      await saveSnapshot(updatedResume, { label: "approve", trigger: "approve", triggeredBy: "approve" });
    } catch (snapshotErr) {
      console.warn(
        "[resume/candidates/patch] snapshot failed (non-fatal):",
        snapshotErr
      );
    }

    // 5f. Mark candidate as approved and persist suggestions
    const now = new Date().toISOString();
    doc.suggestions[idx] = { ...candidate, status: "approved", approvedAt: now };
    doc.updatedAt = now;
    try {
      await saveSuggestionsData(doc);
    } catch (err) {
      // Non-fatal: resume already updated; log but don't fail the request
      console.error(
        "[resume/candidates/patch] save suggestions (after approve) failed:",
        err
      );
    }

    console.info(
      `[resume/candidates/patch] approved id="${candidateId}" action="${candidate.action}" section="${candidate.section}"`
    );

    return c.json({ ok: true, status: "approved", resume: updatedResume });
  }

  // ── 6. Branch: discarded ────────────────────────────────────────────────────
  const now = new Date().toISOString();
  doc.suggestions[idx] = { ...candidate, status: "discarded", discardedAt: now };
  doc.updatedAt = now;

  try {
    await saveSuggestionsData(doc);
  } catch (err) {
    console.error("[resume/candidates/patch] save suggestions (after discard) failed:", err);
    return c.json(
      { ok: false, error: "저장에 실패했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  console.info(
    `[resume/candidates/patch] discarded id="${candidateId}" action="${candidate.action}" section="${candidate.section}"`
  );

  return c.json({ ok: true, status: "discarded" });
});

// ─── GET /api/resume/strength-keywords ───────────────────────────────────────

/**
 * Return the current strength-keyword list.
 *
 * Keywords are read from the dedicated `resume/strength-keywords.json` blob
 * document (written at bootstrap time and kept in sync by POST/DELETE/PATCH).
 * When no dedicated document has been saved yet (pre-bootstrap state), an empty
 * list is returned rather than a 404 — callers should treat an empty list as
 * "not yet bootstrapped".
 *
 * Response:
 *   HTTP 200  { "keywords": string[] }
 *
 * Error response (Blob unavailable):
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }
 */
resumeRouter.get("/strength-keywords", async (c) => {
  let doc;
  try {
    doc = await readStrengthKeywords();
  } catch (err) {
    console.error("[resume/strength-keywords GET] read failed:", err);
    return c.json(
      { ok: false, error: "키워드를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  const keywords = extractKeywordsArray(doc);
  return c.json({ keywords });
});

// ─── POST /api/resume/strength-keywords ──────────────────────────────────────

/**
 * Append one or more keywords to the strength-keyword list.
 *
 * Duplicates are silently dropped (case-insensitive comparison).  Unlike the
 * PATCH endpoint (which replaces the full list), POST is additive — only the
 * supplied keywords are merged into the existing list.
 *
 * Primary storage: `resume/strength-keywords.json` via saveStrengthKeywords().
 * Secondary sync:  `strength_keywords[]` field in `resume/data.json`
 *                  (non-fatal if resume does not exist yet).
 *
 * Request body (JSON):
 *   { "keywords": string[] }   — one or more keywords to add
 *   OR
 *   { "keyword": string }      — convenience form for a single keyword
 *
 * Validation:
 *   - Each element must be a non-empty string after trimming
 *   - Max 80 characters per keyword; entries exceeding this are silently dropped
 *   - Non-string elements are silently dropped
 *   - Duplicates (case-insensitive) relative to the existing list are dropped
 *   - Overall list is capped at 50 keywords
 *
 * Success response:
 *   HTTP 200  { "ok": true, "keywords": string[], "added": string[] }
 *     keywords — full updated list
 *     added    — only the keywords that were actually appended (new ones)
 *
 * Error responses:
 *   HTTP 400  — missing or invalid body (neither `keywords` array nor `keyword` string)
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.post("/strength-keywords", async (c) => {
  // ── 1. Parse and validate body ─────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON" }, 400);
  }

  // Accept either { keywords: string[] } or { keyword: string }
  let rawKeywords;
  if (Array.isArray(body?.keywords)) {
    rawKeywords = body.keywords;
  } else if (typeof body?.keyword === "string") {
    rawKeywords = [body.keyword];
  } else {
    return c.json(
      { ok: false, error: "keywords 배열 또는 keyword 문자열 필드가 필요합니다." },
      400
    );
  }

  if (rawKeywords.length === 0) {
    return c.json({ ok: false, error: "유효한 키워드가 없습니다." }, 400);
  }

  // ── 2. Load current keyword document ──────────────────────────────────────
  let doc;
  try {
    doc = await readStrengthKeywords();
  } catch (err) {
    console.error("[resume/strength-keywords POST] read failed:", err);
    return c.json(
      { ok: false, error: "키워드를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  // ── 3. Merge: case-insensitive dedup via library ───────────────────────────
  const existingKeywords = extractKeywordsArray(doc);
  const merged = mergeKeywords(existingKeywords, rawKeywords);
  const added = merged.slice(existingKeywords.length); // newly appended entries

  if (added.length === 0) {
    // Nothing new — return current list without a Blob write.
    return c.json({ ok: true, keywords: existingKeywords, added: [] });
  }

  // ── 4. Save to dedicated strength-keywords blob ────────────────────────────
  const updatedDoc = replaceKeywords(merged, "user");
  try {
    await saveStrengthKeywords(updatedDoc);
  } catch (err) {
    console.error("[resume/strength-keywords POST] save failed:", err);
    return c.json(
      { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  // ── 5. Sync strength_keywords field in resume data.json (secondary) ────────
  // Non-fatal: resume may not exist yet when keywords are added before bootstrap.
  try {
    const resume = await readResumeData();
    if (resume) {
      await saveResumeData({
        ...resume,
        strength_keywords: merged,
        _sources: { ...(resume._sources ?? {}), strength_keywords: "user" }
      });
    }
  } catch (err) {
    console.warn(
      "[resume/strength-keywords POST] resume data.json sync failed (non-fatal):",
      err.message
    );
  }

  console.info(
    `[resume/strength-keywords POST] Added ${added.length} keyword(s): ${added.join(", ")}`
  );
  return c.json({ ok: true, keywords: merged, added });
});

// ─── DELETE /api/resume/strength-keywords/:keyword ────────────────────────────

/**
 * Remove a single keyword from the strength-keyword list.
 *
 * The keyword is matched case-insensitively so "React" and "react" refer to
 * the same entry.  If the keyword is not present, the response is still 200
 * with `removed: false` — no Blob write occurs.
 *
 * Primary storage: `resume/strength-keywords.json` via saveStrengthKeywords().
 * Secondary sync:  `strength_keywords[]` field in `resume/data.json`
 *                  (non-fatal if resume does not exist yet).
 *
 * Route parameter:
 *   :keyword  — URL-encoded keyword to remove (e.g. "React%20Native")
 *
 * Success response:
 *   HTTP 200  { "ok": true, "keywords": string[], "removed": boolean }
 *     keywords — full updated list (after removal if it occurred)
 *     removed  — true if the keyword was found and removed; false if absent
 *
 * Error responses:
 *   HTTP 400  — empty or missing keyword parameter
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.delete("/strength-keywords/:keyword", async (c) => {
  // ── 1. Validate route parameter ────────────────────────────────────────────
  const rawParam = c.req.param("keyword");
  const target = (rawParam ? decodeURIComponent(rawParam) : "").trim();

  if (!target) {
    return c.json({ ok: false, error: "keyword 파라미터가 필요합니다." }, 400);
  }

  // ── 2. Load current keyword document ──────────────────────────────────────
  let doc;
  try {
    doc = await readStrengthKeywords();
  } catch (err) {
    console.error("[resume/strength-keywords DELETE] read failed:", err);
    return c.json(
      { ok: false, error: "키워드를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  // ── 3. Remove keyword via library (case-insensitive) ──────────────────────
  const existing = extractKeywordsArray(doc);
  const filtered = removeKeyword(existing, target);
  const removed = filtered.length < existing.length;

  if (!removed) {
    // Keyword not present — no Blob write needed.
    return c.json({ ok: true, keywords: existing, removed: false });
  }

  // ── 4. Save updated doc to dedicated strength-keywords blob ───────────────
  const updatedDoc = replaceKeywords(filtered, "user");
  try {
    await saveStrengthKeywords(updatedDoc);
  } catch (err) {
    console.error("[resume/strength-keywords DELETE] save failed:", err);
    return c.json(
      { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  // ── 5. Sync strength_keywords field in resume data.json (secondary) ────────
  // Non-fatal: resume may not exist yet.
  try {
    const resume = await readResumeData();
    if (resume) {
      await saveResumeData({
        ...resume,
        strength_keywords: filtered,
        _sources: { ...(resume._sources ?? {}), strength_keywords: "user" }
      });
    }
  } catch (err) {
    console.warn(
      "[resume/strength-keywords DELETE] resume data.json sync failed (non-fatal):",
      err.message
    );
  }

  console.info(`[resume/strength-keywords DELETE] Removed keyword: "${target}"`);
  return c.json({ ok: true, keywords: filtered, removed: true });
});

// ─── PATCH /api/resume/strength-keywords ─────────────────────────────────────

/**
 * Atomically replace the strength-keyword list with a new set.
 *
 * The entire list is replaced in a single write so the client always sends the
 * complete desired set.  Deduplication (case-insensitive) and normalization are
 * applied by the library before saving.
 *
 * Primary storage: `resume/strength-keywords.json` via saveStrengthKeywords().
 * Secondary sync:  `strength_keywords[]` field in `resume/data.json`
 *                  (non-fatal if resume does not exist yet).
 *
 * Request body (JSON):
 *   { "keywords": string[] }   — complete desired list (may be empty [])
 *
 * Validation:
 *   - Each element must be a non-empty string after trimming
 *   - Max 80 characters per keyword; entries exceeding this are silently dropped
 *   - Non-string elements are silently dropped
 *   - Duplicates (case-insensitive) are reduced to the first occurrence
 *   - Overall list is capped at 50 keywords
 *
 * Success response:
 *   HTTP 200  { "ok": true, "keywords": string[] }
 *
 * Error responses:
 *   HTTP 400  — missing or non-array `keywords` field
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.patch("/strength-keywords", async (c) => {
  // ── 1. Parse and validate body ─────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON" }, 400);
  }

  if (!Array.isArray(body?.keywords)) {
    return c.json(
      { ok: false, error: "keywords 필드는 배열이어야 합니다." },
      400
    );
  }

  // ── 2. Normalize and deduplicate via library ───────────────────────────────
  // replaceKeywords trims, drops empties, drops over-length, deduplicates.
  const updatedDoc = replaceKeywords(body.keywords, "user");

  // ── 3. Save to dedicated strength-keywords blob ────────────────────────────
  try {
    await saveStrengthKeywords(updatedDoc);
  } catch (err) {
    console.error("[resume/strength-keywords PATCH] save failed:", err);
    return c.json(
      { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  // ── 4. Sync strength_keywords field in resume data.json (secondary) ────────
  // Non-fatal: resume may not exist yet.
  try {
    const resume = await readResumeData();
    if (resume) {
      await saveResumeData({
        ...resume,
        strength_keywords: updatedDoc.keywords,
        _sources: { ...(resume._sources ?? {}), strength_keywords: "user" }
      });
    }
  } catch (err) {
    console.warn(
      "[resume/strength-keywords PATCH] resume data.json sync failed (non-fatal):",
      err.message
    );
  }

  console.info(
    `[resume/strength-keywords PATCH] Replaced list with ${updatedDoc.keywords.length} keyword(s)`
  );
  return c.json({ ok: true, keywords: updatedDoc.keywords });
});

// ─── GET /api/resume/daily-bullets ───────────────────────────────────────────

/**
 * Return a list of all work-log dates that have a bullet cache in Vercel Blob.
 *
 * Response:
 *   HTTP 200  { "dates": ["2025-03-26", "2025-03-25", ...] }  (descending)
 *
 * Error response:
 *   HTTP 502  { "error": "...", "detail": "..." }
 */
resumeRouter.get("/daily-bullets", async (c) => {
  try {
    const dates = await listBulletDates();
    return c.json({ dates });
  } catch (err) {
    console.error("[resume/daily-bullets] list failed:", err);
    return c.json(
      { error: "일별 불릿 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }
});

// ─── GET /api/resume/daily-bullets/:date ─────────────────────────────────────

/**
 * Return the bullet cache document for a specific work-log date.
 *
 * Uses the cache read/write service (resumeDailyBulletsService) which
 * implements Sub-AC 14-2 cache semantics:
 *   1. Serve from the existing DailyBulletsDocument if valid (schema match).
 *   2. On miss or stale schema: reconstruct from raw batch summarization
 *      cache and repopulate the primary cache.
 *   3. Return 404 only when no data is available for the date at all.
 *
 * Path parameter:
 *   :date  — ISO date string YYYY-MM-DD
 *
 * Response when cache EXISTS or reconstruction succeeds:
 *   HTTP 200  { "exists": true, "doc": DailyBulletsDocument, "reconstructed"?: true }
 *   The `reconstructed` field is present (and true) only when the response was
 *   rebuilt from the raw batch cache rather than served from the primary store.
 *
 * Response when no data is available for the date:
 *   HTTP 404  { "exists": false }
 *
 * Error response:
 *   HTTP 400  { "error": "..." }  — invalid date format
 *   HTTP 502  { "error": "...", "detail": "..." }
 */
resumeRouter.get("/daily-bullets/:date", async (c) => {
  const date = c.req.param("date");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "날짜 형식이 잘못되었습니다. YYYY-MM-DD 형식을 사용해 주세요." }, 400);
  }

  try {
    const result = await getOrReconstructDailyBullets(date);

    if (result.source === BULLET_CACHE_MISS) {
      return c.json({ exists: false }, 404);
    }

    const response = { exists: true, doc: result.doc };
    if (result.source === BULLET_CACHE_RECONSTRUCTED) {
      response.reconstructed = true;
    }
    return c.json(response);
  } catch (err) {
    console.error(`[resume/daily-bullets/${date}] read failed:`, err);
    return c.json(
      { error: "불릿 캐시를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }
});

// ─── PUT /api/resume/daily-bullets/:date ─────────────────────────────────────

/**
 * Create or overwrite the bullet cache for a specific work-log date.
 *
 * This endpoint is called by the batch pipeline after processing a day's
 * work logs.  The request body must be the raw `resume` section of a daily
 * summary (as produced by runDailyBatch), from which a DailyBulletsDocument
 * is built and stored.
 *
 * When a cache already exists for the date, the new bullets are merged with
 * the existing ones so that promoted/dismissed statuses are preserved.
 *
 * Path parameter:
 *   :date  — ISO date string YYYY-MM-DD
 *
 * Request body (JSON):
 *   {
 *     "candidates":           string[],   // required — combined resume bullet candidates
 *     "companyCandidates":    string[],   // optional
 *     "openSourceCandidates": string[]    // optional
 *   }
 *
 * Success response:
 *   HTTP 200  { "ok": true, "doc": DailyBulletsDocument }
 *
 * Error responses:
 *   HTTP 400  — missing/invalid body or date format
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.put("/daily-bullets/:date", async (c) => {
  const date = c.req.param("date");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "날짜 형식이 잘못되었습니다. YYYY-MM-DD 형식을 사용해 주세요." }, 400);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON" }, 400);
  }

  if (!body || typeof body !== "object" || !Array.isArray(body.candidates)) {
    return c.json(
      { error: "요청 본문에 candidates 배열이 필요합니다." },
      400
    );
  }

  // Build fresh document from the work-log resume section
  const freshDoc = buildDailyBulletsDocument(date, body);

  // Load existing cache (if any) so we can merge without clobbering statuses
  let existingDoc = null;
  try {
    existingDoc = await readDailyBullets(date);
  } catch (err) {
    // Non-fatal: if Blob read fails, proceed with the fresh document only.
    console.warn(`[resume/daily-bullets/${date}] could not load existing cache:`, err.message);
  }

  const mergedDoc = mergeDailyBulletsDocuments(existingDoc, freshDoc);

  try {
    await saveDailyBullets(date, mergedDoc);
  } catch (err) {
    console.error(`[resume/daily-bullets/${date}] save failed:`, err);
    return c.json(
      { error: "불릿 캐시를 저장하지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  console.info(
    `[resume/daily-bullets/${date}] saved` +
      ` total=${mergedDoc.bullets.length}` +
      ` pending=${mergedDoc.bullets.filter((b) => b.status === "pending").length}`
  );

  return c.json({ ok: true, doc: mergedDoc });
});

// ─── POST /api/resume/daily-bullets/:date/promote/:bulletId ──────────────────

/**
 * Promote a pending bullet to a resume suggestion.
 *
 * This endpoint:
 *   1. Loads the bullet cache for the given date
 *   2. Creates a new "append_bullet" suggestion from the bullet text
 *   3. Adds it to the suggestions document (resume/suggestions.json)
 *   4. Marks the bullet as "promoted" in the cache
 *   5. Returns the newly-created suggestion
 *
 * Path parameters:
 *   :date      — ISO date YYYY-MM-DD
 *   :bulletId  — bullet id, e.g. "bullet-2025-03-26-0"
 *
 * Request body (JSON, optional):
 *   {
 *     "targetCompany": string   // which experience entry to append the bullet to
 *                               // defaults to the first experience entry if omitted
 *   }
 *
 * Success response:
 *   HTTP 200  { "ok": true, "suggestion": SuggestionItem }
 *
 * Error responses:
 *   HTTP 400  — invalid date / missing bulletId
 *   HTTP 404  — no bullet cache, or bulletId not found, or bullet not pending
 *   HTTP 409  — bullet already promoted/dismissed
 *   HTTP 502  — Blob failure
 */
resumeRouter.post("/daily-bullets/:date/promote/:bulletId", async (c) => {
  const date = c.req.param("date");
  const bulletId = c.req.param("bulletId");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "날짜 형식이 잘못되었습니다. YYYY-MM-DD 형식을 사용해 주세요." }, 400);
  }

  // Optional request body
  let body = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    // body is optional — proceed with defaults
  }

  // 1. Load the bullet cache
  let bulletDoc;
  try {
    bulletDoc = await readDailyBullets(date);
  } catch (err) {
    return c.json(
      { error: "불릿 캐시를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }
  if (!bulletDoc) {
    return c.json({ error: `${date} 날짜의 불릿 캐시가 없습니다.` }, 404);
  }

  // 2. Find the bullet
  const bullet = (bulletDoc.bullets ?? []).find((b) => b.id === bulletId);
  if (!bullet) {
    return c.json({ error: `불릿을 찾을 수 없습니다: ${bulletId}` }, 404);
  }
  if (bullet.status !== "pending") {
    return c.json(
      { error: `이미 처리된 불릿입니다. (status: ${bullet.status})` },
      409
    );
  }

  // 3. Load current suggestions and resume (to find a default target company)
  let suggestionsDoc;
  try {
    suggestionsDoc = await readSuggestionsData();
  } catch (err) {
    return c.json(
      { error: "제안 목록을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  let resumeDoc = null;
  try {
    resumeDoc = await readResumeData();
  } catch {
    // Non-fatal — target company lookup will fall back
  }

  // Determine target company for append_bullet
  const targetCompany =
    typeof body.targetCompany === "string" && body.targetCompany.trim()
      ? body.targetCompany.trim()
      : (resumeDoc?.experience?.[0]?.company ?? null);

  // 4. Build the suggestion item
  const suggestionId = `sug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  /** @type {object} */
  const suggestion = {
    id: suggestionId,
    createdAt: new Date().toISOString(),
    status: "pending",
    section: bullet.suggestedSection === "experience" ? "experience" : bullet.suggestedSection,
    action: bullet.suggestedSection === "experience" && targetCompany ? "append_bullet" : "add_skills",
    description: bullet.text,
    patch:
      bullet.suggestedSection === "experience" && targetCompany
        ? { company: targetCompany, bullet: bullet.text }
        : { skills: [bullet.text] },
    source: "work_log",
    logDate: date,
    bulletId
  };

  // 5. Append suggestion to the suggestions document
  suggestionsDoc.suggestions = [...(suggestionsDoc.suggestions ?? []), suggestion];
  suggestionsDoc.updatedAt = new Date().toISOString();

  try {
    await saveSuggestionsData(suggestionsDoc);
  } catch (err) {
    return c.json(
      { error: "제안을 저장하지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  // 6. Mark the bullet as promoted
  let updatedBulletDoc;
  try {
    updatedBulletDoc = promoteBullet(bulletDoc, bulletId, suggestionId);
    await saveDailyBullets(date, updatedBulletDoc);
  } catch (err) {
    // Non-fatal — suggestion was already saved; log and continue.
    console.warn(`[resume/daily-bullets/${date}/promote/${bulletId}] bullet status update failed:`, err.message);
    updatedBulletDoc = bulletDoc;
  }

  console.info(
    `[resume/daily-bullets/${date}/promote/${bulletId}] promoted → suggestion id="${suggestionId}"`
  );

  return c.json({ ok: true, suggestion });
});

// ─── POST /api/resume/daily-bullets/:date/dismiss/:bulletId ──────────────────

/**
 * Dismiss a pending bullet (marks it as dismissed; no suggestion is created).
 *
 * Path parameters:
 *   :date      — ISO date YYYY-MM-DD
 *   :bulletId  — bullet id
 *
 * Success response:
 *   HTTP 200  { "ok": true }
 *
 * Error responses:
 *   HTTP 400  — invalid date
 *   HTTP 404  — no cache, or bulletId not found
 *   HTTP 409  — bullet already promoted/dismissed
 *   HTTP 502  — Blob failure
 */
resumeRouter.post("/daily-bullets/:date/dismiss/:bulletId", async (c) => {
  const date = c.req.param("date");
  const bulletId = c.req.param("bulletId");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "날짜 형식이 잘못되었습니다. YYYY-MM-DD 형식을 사용해 주세요." }, 400);
  }

  let bulletDoc;
  try {
    bulletDoc = await readDailyBullets(date);
  } catch (err) {
    return c.json(
      { error: "불릿 캐시를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }
  if (!bulletDoc) {
    return c.json({ error: `${date} 날짜의 불릿 캐시가 없습니다.` }, 404);
  }

  let updatedDoc;
  try {
    updatedDoc = dismissBullet(bulletDoc, bulletId);
  } catch (err) {
    // dismissBullet throws for not-found or already-processed
    const isConflict = err.message.includes("status is");
    return c.json(
      { error: err.message },
      isConflict ? 409 : 404
    );
  }

  try {
    await saveDailyBullets(date, updatedDoc);
  } catch (err) {
    return c.json(
      { error: "불릿 캐시를 저장하지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  console.info(`[resume/daily-bullets/${date}/dismiss/${bulletId}] dismissed`);

  return c.json({ ok: true });
});

// ─── DELETE /api/resume/daily-bullets/:date ───────────────────────────────────

/**
 * Delete the entire bullet cache for a specific work-log date.
 *
 * This is an administrative cleanup endpoint.  It permanently removes the
 * Vercel Blob document at `resume/bullets/{date}.json`.  Any bullets that
 * have already been promoted to suggestions are not affected — only the
 * intermediate cache is deleted.
 *
 * Path parameter:
 *   :date  — ISO date string YYYY-MM-DD
 *
 * Success response:
 *   HTTP 200  { "ok": true }
 *
 * Error responses:
 *   HTTP 400  — invalid date format
 *   HTTP 404  — no cache found for the given date
 *   HTTP 502  — Blob deletion failure
 */
resumeRouter.delete("/daily-bullets/:date", async (c) => {
  const date = c.req.param("date");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "날짜 형식이 잘못되었습니다. YYYY-MM-DD 형식을 사용해 주세요." }, 400);
  }

  // Verify the cache exists before attempting deletion
  let existingDoc;
  try {
    existingDoc = await readDailyBullets(date);
  } catch (err) {
    return c.json(
      { error: "불릿 캐시를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!existingDoc) {
    return c.json({ error: `${date} 날짜의 불릿 캐시가 없습니다.` }, 404);
  }

  try {
    await deleteDailyBullets(date);
  } catch (err) {
    console.error(`[resume/daily-bullets/${date}] delete failed:`, err);
    return c.json(
      { error: "불릿 캐시를 삭제하지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  console.info(`[resume/daily-bullets/${date}] deleted`);
  return c.json({ ok: true });
});

// ─── PATCH /api/resume/daily-bullets/:date/:bulletId ─────────────────────────

/**
 * Edit the text of a pending bullet in the cache for a specific date.
 *
 * Only `pending` bullets may be edited.  Promoted or dismissed bullets are
 * considered finalised and cannot be modified through this endpoint.
 *
 * The `suggestedSection` is automatically re-inferred from the new text so
 * that section routing remains accurate after the edit.
 *
 * Path parameters:
 *   :date      — ISO date YYYY-MM-DD
 *   :bulletId  — bullet id (e.g. "bullet-2025-03-26-0")
 *
 * Request body (JSON):
 *   { "text": string }   — replacement bullet text (non-empty, will be trimmed)
 *
 * Success response:
 *   HTTP 200  { "ok": true, "bullet": DailyBulletItem }
 *
 * Error responses:
 *   HTTP 400  — invalid date, missing/empty text, or malformed JSON
 *   HTTP 404  — no cache for the date, or bulletId not found
 *   HTTP 409  — bullet is not pending (already promoted or dismissed)
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.patch("/daily-bullets/:date/:bulletId", async (c) => {
  const date = c.req.param("date");
  const bulletId = c.req.param("bulletId");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "날짜 형식이 잘못되었습니다. YYYY-MM-DD 형식을 사용해 주세요." }, 400);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON" }, 400);
  }

  const newText = typeof body?.text === "string" ? body.text.trim() : "";
  if (!newText) {
    return c.json({ error: "text 필드가 필요합니다 (비어있지 않은 문자열)." }, 400);
  }

  // Load the bullet cache
  let bulletDoc;
  try {
    bulletDoc = await readDailyBullets(date);
  } catch (err) {
    return c.json(
      { error: "불릿 캐시를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }
  if (!bulletDoc) {
    return c.json({ error: `${date} 날짜의 불릿 캐시가 없습니다.` }, 404);
  }

  // Apply the edit (throws on not-found or wrong status)
  let updatedDoc;
  try {
    updatedDoc = editBullet(bulletDoc, bulletId, newText);
  } catch (err) {
    const isConflict = err.message.includes("status is");
    return c.json(
      { error: err.message },
      isConflict ? 409 : 404
    );
  }

  // Persist the updated document
  try {
    await saveDailyBullets(date, updatedDoc);
  } catch (err) {
    console.error(`[resume/daily-bullets/${date}/${bulletId}] save failed:`, err);
    return c.json(
      { error: "불릿 캐시를 저장하지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  const updatedBullet = updatedDoc.bullets.find((b) => b.id === bulletId);
  console.info(`[resume/daily-bullets/${date}/${bulletId}] text edited`);
  return c.json({ ok: true, bullet: updatedBullet });
});

// ─── POST /api/resume/axes ────────────────────────────────────────────────────

/**
 * (Re)generate the career-narrative display axes for the stored resume by
 * calling the LLM-based axis clustering service.
 *
 * The axes are stored directly inside the main resume document
 * (resume.display_axes) so they remain co-located with the content they
 * describe.  Calling this endpoint with force: true replaces any previously
 * stored axes; without it, cached axes are returned immediately.
 *
 * Request body (JSON, optional):
 *   {
 *     "force": boolean   // default false -- skip LLM call when axes already exist
 *   }
 *
 * Success responses:
 *   HTTP 200  {
 *     "ok": true,
 *     "axes": DisplayAxis[],   // 2-4 display-axis objects
 *     "regenerated": boolean   // true when LLM was called; false when cached
 *   }
 *
 * Error responses:
 *   HTTP 400  { "ok": false, "error": "..." }    -- invalid request body
 *   HTTP 404  { "ok": false, "error": "..." }    -- no resume exists (bootstrap first)
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }  -- Blob or LLM failure
 */
resumeRouter.post("/axes", async (c) => {
  // 1. Parse optional body
  let force = false;
  try {
    const text = await c.req.text();
    if (text.trim()) {
      const body = JSON.parse(text);
      if (body && typeof body.force === "boolean") {
        force = body.force;
      }
    }
  } catch {
    return c.json({ ok: false, error: "Request body must be valid JSON" }, 400);
  }

  // 2. Load existing resume
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes] Failed to read resume:", err);
    return c.json(
      {
        ok: false,
        error: "이력서를 불러오지 못했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  if (!resume) {
    return c.json(
      {
        ok: false,
        error: "이력서가 없습니다. 먼저 PDF를 업로드해 이력서를 생성해 주세요."
      },
      404
    );
  }

  // 3. Return cached axes when they exist and force is false
  const existingAxes = Array.isArray(resume.display_axes) ? resume.display_axes : [];
  if (!force && existingAxes.length > 0) {
    console.info(
      `[resume/axes] Returning ${existingAxes.length} cached axes (force=false)`
    );
    return c.json({ ok: true, axes: existingAxes, regenerated: false });
  }

  // 4. Call the LLM clustering service
  let newAxes;
  try {
    newAxes = await generateDisplayAxes(resume);
  } catch (err) {
    console.error("[resume/axes] Axis clustering failed:", err);
    return c.json(
      {
        ok: false,
        error: "축 생성에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  // 5. Persist the updated axes:
  //    a) Save as independent entity in resume/display-axes.json (Sub-AC 16-3)
  //    b) Also embed in the main resume document for backward compatibility
  const generatedAt = new Date().toISOString();
  const displayAxesDoc = {
    schemaVersion: 1,
    generatedAt,
    axes: newAxes
  };

  try {
    await saveDisplayAxes(displayAxesDoc);
  } catch (err) {
    console.error("[resume/axes] Failed to save display axes document:", err);
    return c.json(
      {
        ok: false,
        error: "축 저장에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  const updatedResume = { ...resume, display_axes: newAxes };
  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/axes] Failed to save updated resume:", err);
    return c.json(
      {
        ok: false,
        error: "이력서 저장에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  console.info(
    `[resume/axes] Generated and saved ${newAxes.length} axes (force=${force})`
  );

  // 6. Return the new axes
  return c.json({ ok: true, axes: newAxes, regenerated: true, generatedAt });
});

// ─── GET /api/resume/axes/staleness ───────────────────────────────────────────

/**
 * Return the current unclassified-keyword ratio for the stored resume.
 *
 * This is a lightweight diagnostic endpoint.  The frontend can poll it to
 * decide whether to surface a "Refresh axes" prompt to the user without
 * committing to an expensive LLM call.
 *
 * Keyword sources:
 *   - resume.strength_keywords
 *   - resume.skills.technical / .languages / .tools
 *   - Bullet candidates from recent work-log entries (on disk)
 *
 * Success response:
 *   HTTP 200  {
 *     "ratio": number,             // unclassified fraction in [0, 1]
 *     "totalKeywords": number,
 *     "unclassifiedCount": number,
 *     "threshold": number,         // current trigger threshold (default 0.3)
 *     "shouldRecluster": boolean   // true when ratio > threshold
 *   }
 *
 * Error responses:
 *   HTTP 404  { "ok": false, "error": "..." }  — no resume exists
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }  — Blob failure
 */
resumeRouter.get("/axes/staleness", async (c) => {
  // 1. Load resume
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes/staleness] Failed to read resume:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 PDF를 업로드해 이력서를 생성해 주세요." },
      404
    );
  }

  // 2. Collect keywords from resume
  const resumeKws = collectResumeKeywords(resume);

  // 3. Attempt to collect keywords from on-disk work logs (non-fatal)
  let workLogKws = [];
  try {
    const config = await loadConfig();
    if (config?.dataDir) {
      const entries = await gatherWorkLogBullets(config.dataDir).catch(() => []);
      const adapted = _adaptWorkLogEntries(entries);
      workLogKws = collectWorkLogKeywords(adapted);
    }
  } catch (err) {
    console.warn("[resume/axes/staleness] Work-log gather failed (non-fatal):", err.message);
  }

  // 4. Build combined keyword pool (deduplicated, first-occurrence casing)
  const seenLower = new Set();
  const allKeywordsCased = [];
  for (const k of [...resumeKws, ...workLogKws]) {
    const lower = k.toLowerCase();
    if (!seenLower.has(lower)) {
      seenLower.add(lower);
      allKeywordsCased.push(k);
    }
  }

  // 5. Migrate existing axes and compute ratio
  const existingAxes = migrateAxes(
    Array.isArray(resume.display_axes) ? resume.display_axes : []
  );

  const ratio = computeUnclassifiedRatio(allKeywordsCased, existingAxes);
  const threshold = DEFAULT_RECLUSTER_THRESHOLD;
  const totalKeywords = allKeywordsCased.length;
  const unclassifiedCount = Math.round(ratio * totalKeywords);

  console.info(
    `[resume/axes/staleness] ratio=${ratio.toFixed(3)} total=${totalKeywords}` +
    ` unclassified=${unclassifiedCount}`
  );

  return c.json({
    ratio,
    totalKeywords,
    unclassifiedCount,
    threshold,
    shouldRecluster: ratio > threshold
  });
});

// ─── POST /api/resume/axes/recluster ──────────────────────────────────────────

/**
 * Conditional re-clustering pipeline for display axes (Sub-AC 17-3).
 *
 * Checks whether the fraction of unclassified keywords exceeds 30 % (or a
 * caller-supplied threshold) and, if so, calls the LLM to cluster all
 * keywords into a fresh set of thematic axes.  The new axes are then merged
 * with the existing ones — user-edited axes (._source === "user") are always
 * preserved unchanged.
 *
 * Request body (JSON, optional):
 *   {
 *     "force":     boolean,  // default false — skip threshold check; always recluster
 *     "threshold": number    // override default 0.3 (0–1 inclusive)
 *   }
 *
 * Keyword sources evaluated:
 *   - resume.strength_keywords
 *   - resume.skills.technical / .languages / .tools
 *   - Bullet candidates from on-disk work-log entries
 *
 * Success responses:
 *   HTTP 200  {
 *     "ok": true,
 *     "triggered": boolean,       // true when LLM was called and axes were updated
 *     "ratio": number,            // unclassified ratio before recluster (0–1)
 *     "totalKeywords": number,
 *     "unclassifiedCount": number,
 *     "axes": Axis[]              // final axis set (merged or unchanged)
 *   }
 *
 * Error responses:
 *   HTTP 400  { "ok": false, "error": "..." }  — invalid request body
 *   HTTP 404  { "ok": false, "error": "..." }  — no resume exists
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }  — Blob or LLM failure
 */
resumeRouter.post("/axes/recluster", async (c) => {
  // 1. Parse optional body
  let force = false;
  let threshold = DEFAULT_RECLUSTER_THRESHOLD;
  try {
    const text = await c.req.text();
    if (text.trim()) {
      const body = JSON.parse(text);
      if (body && typeof body.force === "boolean") force = body.force;
      if (body && typeof body.threshold === "number") {
        threshold = Math.max(0, Math.min(1, body.threshold));
      }
    }
  } catch {
    return c.json({ ok: false, error: "Request body must be valid JSON" }, 400);
  }

  // 2. Load existing resume
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes/recluster] Failed to read resume:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 PDF를 업로드해 이력서를 생성해 주세요." },
      404
    );
  }

  // 3. Gather on-disk work-log entries (non-fatal — missing logs won't block recluster)
  let workLogEntries = [];
  try {
    const config = await loadConfig();
    if (config?.dataDir) {
      workLogEntries = await gatherWorkLogBullets(config.dataDir).catch(() => []);
    }
  } catch (err) {
    console.warn("[resume/axes/recluster] Work-log gather failed (non-fatal):", err.message);
  }

  // 4. Run the conditional re-clustering pipeline
  let result;
  try {
    result = await reclusterPipeline(resume, workLogEntries, { force, threshold });
  } catch (err) {
    console.error("[resume/axes/recluster] Pipeline failed:", err);
    return c.json(
      { ok: false, error: "재클러스터링에 실패했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  // 5. Persist updated axes only when the pipeline actually ran
  if (result.triggered) {
    try {
      await saveResumeData({ ...resume, display_axes: result.axes });
    } catch (err) {
      console.error("[resume/axes/recluster] Failed to save updated axes:", err);
      return c.json(
        { ok: false, error: "이력서 저장에 실패했습니다.", detail: err.message ?? String(err) },
        502
      );
    }
    console.info(
      `[resume/axes/recluster] Re-clustered: ratio=${result.ratio.toFixed(3)} ` +
      `total=${result.totalKeywords} unclassified=${result.unclassifiedCount} ` +
      `axes=${result.axes.length}`
    );
  } else {
    console.info(
      `[resume/axes/recluster] Skipped: ratio=${result.ratio.toFixed(3)} ≤ threshold=${threshold}`
    );
  }

  // 6. Return result
  return c.json({
    ok: true,
    triggered: result.triggered,
    ratio: result.ratio,
    totalKeywords: result.totalKeywords,
    unclassifiedCount: result.unclassifiedCount,
    axes: result.axes
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return true when a new LinkedIn suggestion is semantically equivalent to an
 * existing pending LinkedIn suggestion, so we avoid duplicates.
 *
 * Deduplication key per action:
 *   update_summary  → always deduplicated (only one at a time)
 *   update_field    → same section + field
 *   add_experience  → same normalised company name
 *   add_education   → same normalised institution name
 *   add_skills      → never deduplicated (skill sets may differ; merging is
 *                     left to the approval step)
 *
 * @param {object} newSugg
 * @param {object} existSugg
 * @returns {boolean}
 */
function _linkedinSuggestionIsDuplicate(newSugg, existSugg) {
  if (newSugg.action !== existSugg.action) return false;

  switch (newSugg.action) {
    case "update_summary":
      return true;

    case "update_field":
      return (
        newSugg.patch?.section === existSugg.patch?.section &&
        newSugg.patch?.field === existSugg.patch?.field
      );

    case "add_experience": {
      const normNew = _normStr(newSugg.patch?.entry?.company);
      const normExist = _normStr(existSugg.patch?.entry?.company);
      return normNew !== "" && normNew === normExist;
    }

    case "add_education": {
      const normNew = _normStr(newSugg.patch?.entry?.institution);
      const normExist = _normStr(existSugg.patch?.entry?.institution);
      return normNew !== "" && normNew === normExist;
    }

    case "add_skills":
    default:
      return false;
  }
}

/**
 * Minimal string normaliser for deduplication comparisons.
 * @param {unknown} val
 * @returns {string}
 */
function _normStr(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .toLowerCase()
    .trim()
    .replace(/[.,\-–—&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Assemble the complete Vercel Blob document from a `BootstrapResult`.
 *
 * The document is intentionally flat at the top level so that the `GET /api/resume`
 * response and the blob file have an identical shape — no unwrapping needed.
 *
 * Shape:
 *   {
 *     meta: { language, source, generatedAt, schemaVersion, pdf_name, linkedin_url },
 *     contact: { name, email, phone, location, website, linkedin },
 *     summary: string,
 *     experience: [...],
 *     education: [...],
 *     skills: { technical, languages, tools },
 *     projects: [...],
 *     certifications: [...],
 *     strength_keywords: [...],
 *     display_axes: [...],
 *   }
 *
 * @param {{ resumeData: object, strengthKeywords: string[], displayAxes: object[] }} result
 * @param {{ pdfName: string, linkedinUrl: string|null }} meta
 * @returns {object}
 */
function assembleBlobDocument({ resumeData, strengthKeywords, displayAxes }, { pdfName, linkedinUrl }) {
  const rd = resumeData ?? {};

  // Merge _sources: preserve any existing "user" overrides set by prior user edits.
  // Any key not yet present defaults to "system".
  // User edits always take priority over subsequent system merges.
  const existingSources = rd._sources ?? {};
  const mergedSources = {
    summary: existingSources.summary ?? "system",
    contact: existingSources.contact ?? "system",
    skills: existingSources.skills ?? "system"
  };

  // Defensive source stamping: array items must carry a _source tag.
  // normalizeBootstrapResult already sets _source via _preserveItemSource, but
  // assembleBlobDocument is also called with buildEmptyScaffold output and with
  // any future callers that may not pre-stamp items.  Items without an explicit
  // _source receive "system" as the default — the correct value for LLM-generated
  // content that has not yet been reviewed or modified by the user.
  const stampSystem = (items) =>
    (Array.isArray(items) ? items : []).map((item) =>
      item && typeof item === "object"
        ? { ...item, _source: item._source ?? "system" }
        : item
    );

  return {
    meta: {
      ...(rd.meta ?? {}),
      schemaVersion: (rd.meta?.schemaVersion) ?? 1,
      pdf_name: pdfName,
      linkedin_url: linkedinUrl ?? null
    },
    _sources: mergedSources,
    contact: rd.contact ?? { name: "", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: rd.summary ?? "",
    experience:     stampSystem(rd.experience),
    education:      stampSystem(rd.education),
    skills: rd.skills ?? { technical: [], languages: [], tools: [] },
    projects:       stampSystem(rd.projects),
    certifications: stampSystem(rd.certifications),
    strength_keywords: Array.isArray(strengthKeywords) ? strengthKeywords : [],
    display_axes: Array.isArray(displayAxes) ? displayAxes : []
  };
}

/**
 * Build a minimal empty scaffold when the LLM is unavailable.
 * Populated from structured LinkedIn data when provided.
 *
 * @param {{ linkedinData: object|null, source: string }} opts
 * @returns {{ resumeData: object, strengthKeywords: string[], displayAxes: object[] }}
 */
function buildEmptyScaffold({ linkedinData, source }) {
  const ld = linkedinData ?? {};

  const resumeData = {
    meta: {
      language: "en",
      source: source ?? "pdf",
      generatedAt: new Date().toISOString(),
      schemaVersion: 1
    },
    _sources: {
      summary: "system",
      contact: "system",
      skills: "system"
    },
    contact: {
      name: String(ld.name ?? ""),
      email: null,
      phone: null,
      location: ld.location ? String(ld.location) : null,
      website: null,
      linkedin: null
    },
    summary: String(ld.about ?? ""),
    experience: (ld.experience ?? []).map((e) => ({
      _source: "system",
      company: String(e.company ?? ""),
      title: String(e.title ?? ""),
      start_date: null,
      end_date: null,
      location: null,
      bullets: e.description ? [String(e.description)] : []
    })),
    education: (ld.education ?? []).map((e) => ({
      _source: "system",
      institution: String(e.school ?? ""),
      degree: e.degree ? String(e.degree) : null,
      field: e.field ? String(e.field) : null,
      start_date: null,
      end_date: null,
      gpa: null
    })),
    skills: {
      technical: [],
      languages: [],
      tools: Array.isArray(ld.skills) ? ld.skills.map(String) : []
    },
    projects: [],
    certifications: []
  };

  const strengthKeywords = Array.isArray(ld.skills)
    ? ld.skills.slice(0, 10).map(String)
    : [];

  return { resumeData, strengthKeywords, displayAxes: [] };
}

/**
 * Apply a suggestion's patch to a resume document.
 *
 * Supported actions:
 *   update_summary   — patch.text                     → resume.summary = text (existing summary replaced)
 *   add_summary      — patch.text                     → resume.summary = text (alias; summary was empty)
 *   append_bullet    — patch.company | patch.projectName,
 *                      patch.bullet,
 *                      patch.section?                 → append bullet to matching experience or project entry
 *   delete_bullet    — patch.section,
 *                      patch.company? | patch.projectName?,
 *                      patch.bullet                   → remove exact bullet from matching entry (AC 7-2)
 *   replace_bullet   — patch.section,
 *                      patch.company? | patch.projectName?,
 *                      patch.oldBullet, patch.newBullet → replace oldBullet with newBullet (AC 7-2)
 *   add_skill        — patch.category,
 *                      patch.skill                    → append to skills[category] (deduped)
 *   add_experience   — patch.entry                    → push to resume.experience
 *   update_field     — patch.section,
 *                      patch.field,
 *                      patch.value                    → set resume[section][field] = value
 *
 * The returned document is a new object (shallow clone at the top level).
 * User edits already present in the resume are preserved — this function
 * only adds or replaces content at the specific patch target.
 *
 * Source tagging (itemSource option):
 *   Every resume item created or modified by this function receives a _source
 *   marker (for per-item fields like experience entries) or a _sources.<section>
 *   marker (for section-level fields like summary/skills) set to itemSource.
 *   Default: "user_approved" — used when the user explicitly approves a system
 *   suggestion.  Pass { itemSource: "system" } only for automated non-user applies.
 *
 * @param {object} resume      Current resume document (not mutated)
 * @param {object} suggestion  SuggestionItem with action + patch fields
 * @param {object} [opts]                       Options
 * @param {string} [opts.itemSource="user_approved"]
 *   Source label applied to all items created/modified by this call.
 *   Values: "user_approved" | "system" | "user"
 * @returns {object}           Updated resume document
 * @throws {Error}             For unknown action types or malformed patches
 */
function applySuggestionPatch(resume, suggestion, { itemSource = "user_approved" } = {}) {
  // AC 7: Fast-path for BulletProposal (kind: 'bullet').
  // BulletProposals use op/target/payload instead of action/patch.
  // applyBulletProposal handles add, delete, replace at bullet granularity,
  // and enforces the "user edits win" contract for replace ops.
  if (isBulletProposal(suggestion)) {
    return applyBulletProposal(resume, suggestion);
  }

  const { action, patch } = suggestion;
  if (!action || !patch) {
    throw new Error(`Suggestion is missing action or patch fields`);
  }

  // Shallow clone so we don't mutate the original
  const updated = { ...resume };

  switch (action) {
    case "add_summary":     // fall-through: same patch shape as update_summary
    case "update_summary": {
      if (typeof patch.text !== "string") {
        throw new Error(`${action} patch requires a "text" string`);
      }
      updated.summary = patch.text;
      // Mark summary as user-approved (distinct from system-generated).
      // "user_approved" signals that a system-generated text was explicitly
      // reviewed and accepted by the user — it is protected from future
      // system merges just like a directly user-authored summary.
      updated._sources = { ...(updated._sources ?? {}), summary: itemSource };
      break;
    }

    case "append_bullet": {
      // patch.section (optional): "experience" (default) | "projects"
      // For experience: identify entry by patch.company
      // For projects:   identify entry by patch.projectName
      //
      // AC 7-2 guarantee: one proposal targets exactly one bullet.
      const appendSection = patch.section ?? "experience";

      if (appendSection === "projects") {
        // ── Projects variant ────────────────────────────────────────────────
        if (!patch.projectName || typeof patch.bullet !== "string") {
          throw new Error(
            `append_bullet (projects) patch requires "projectName" and "bullet" fields`
          );
        }
        const projects = Array.isArray(updated.projects)
          ? updated.projects.map((p) => ({ ...p, bullets: [...(p.bullets ?? [])] }))
          : [];
        const projTarget = projects.find(
          (p) => p.name?.toLowerCase().trim() === patch.projectName.toLowerCase().trim()
        );
        if (!projTarget) {
          throw new Error(
            `append_bullet: no project entry found for name "${patch.projectName}"`
          );
        }
        projTarget.bullets.push(patch.bullet);
        projTarget._source = itemSource;
        updated.projects = projects;
      } else {
        // ── Experience variant (default, backwards-compatible) ──────────────
        if (!patch.company || typeof patch.bullet !== "string") {
          throw new Error(
            `append_bullet patch requires "company" and "bullet" fields`
          );
        }
        const exp = Array.isArray(updated.experience)
          ? updated.experience.map((e) => ({ ...e, bullets: [...(e.bullets ?? [])] }))
          : [];
        const target = exp.find(
          (e) => e.company?.toLowerCase().trim() === patch.company.toLowerCase().trim()
        );
        if (!target) {
          throw new Error(
            `append_bullet: no experience entry found for company "${patch.company}"`
          );
        }
        target.bullets.push(patch.bullet);
        // Mark the parent entry with itemSource — user approved this bullet addition.
        // This always updates _source so 'user_approved' entries are properly tracked.
        target._source = itemSource;
        updated.experience = exp;
      }
      break;
    }

    case "delete_bullet": {
      // Remove a single bullet from an experience or project entry.
      // patch shape: { section: "experience"|"projects",
      //                company?: string,     (for experience)
      //                projectName?: string, (for projects)
      //                bullet: string }      exact text to remove
      //
      // AC 7-2 guarantee: one proposal targets exactly one bullet.
      const delSection = patch.section;
      if (!delSection || !["experience", "projects"].includes(delSection)) {
        throw new Error(
          `delete_bullet patch requires "section" ("experience" or "projects")`
        );
      }
      if (typeof patch.bullet !== "string" || !patch.bullet.trim()) {
        throw new Error(`delete_bullet patch requires a non-empty "bullet" string`);
      }

      if (delSection === "experience") {
        if (!patch.company) {
          throw new Error(`delete_bullet (experience) patch requires "company"`);
        }
        const expArr = Array.isArray(updated.experience)
          ? updated.experience.map((e) => ({ ...e, bullets: [...(e.bullets ?? [])] }))
          : [];
        const delExpTarget = expArr.find(
          (e) => e.company?.toLowerCase().trim() === patch.company.toLowerCase().trim()
        );
        if (!delExpTarget) {
          throw new Error(
            `delete_bullet: no experience entry found for company "${patch.company}"`
          );
        }
        const bulletNorm = patch.bullet.trim().toLowerCase();
        const beforeLen = delExpTarget.bullets.length;
        delExpTarget.bullets = delExpTarget.bullets.filter(
          (b) => String(b).trim().toLowerCase() !== bulletNorm
        );
        if (delExpTarget.bullets.length === beforeLen) {
          throw new Error(
            `delete_bullet: bullet not found in experience entry "${patch.company}": "${patch.bullet}"`
          );
        }
        updated.experience = expArr;
      } else {
        // projects
        if (!patch.projectName) {
          throw new Error(`delete_bullet (projects) patch requires "projectName"`);
        }
        const projArr = Array.isArray(updated.projects)
          ? updated.projects.map((p) => ({ ...p, bullets: [...(p.bullets ?? [])] }))
          : [];
        const delProjTarget = projArr.find(
          (p) => p.name?.toLowerCase().trim() === patch.projectName.toLowerCase().trim()
        );
        if (!delProjTarget) {
          throw new Error(
            `delete_bullet: no project entry found for name "${patch.projectName}"`
          );
        }
        const bulletNorm = patch.bullet.trim().toLowerCase();
        const beforeLen = delProjTarget.bullets.length;
        delProjTarget.bullets = delProjTarget.bullets.filter(
          (b) => String(b).trim().toLowerCase() !== bulletNorm
        );
        if (delProjTarget.bullets.length === beforeLen) {
          throw new Error(
            `delete_bullet: bullet not found in project entry "${patch.projectName}": "${patch.bullet}"`
          );
        }
        updated.projects = projArr;
      }
      break;
    }

    case "delete_item": {
      // Physically remove an entire item from a section array.
      // patch shape: { section: "experience"|"education"|"projects"|"certifications",
      //                itemIndex: number }
      //
      // AC 23: No soft-delete flag is left on any item. The deleted item is
      // preserved in the pre-deletion snapshot saved by the approval handler
      // before this patch is applied, enabling rollback via POST /rollback.
      const { section: delItemSection, itemIndex: delItemIndex } = patch;

      const ITEM_ARRAY_SECTIONS = ["experience", "education", "projects", "certifications"];
      if (!delItemSection || !ITEM_ARRAY_SECTIONS.includes(delItemSection)) {
        throw new Error(
          `delete_item patch requires "section" (one of ${ITEM_ARRAY_SECTIONS.join("|")})`
        );
      }
      if (!Number.isInteger(delItemIndex) || delItemIndex < 0) {
        throw new Error(
          `delete_item patch requires a non-negative integer "itemIndex"`
        );
      }
      const delItemArr = Array.isArray(updated[delItemSection])
        ? [...updated[delItemSection]]
        : [];
      if (delItemIndex >= delItemArr.length) {
        throw new Error(
          `delete_item: ${delItemSection}[${delItemIndex}] does not exist ` +
          `(section has ${delItemArr.length} items)`
        );
      }
      // Physical removal — no soft-delete flag
      delItemArr.splice(delItemIndex, 1);
      updated[delItemSection] = delItemArr;
      break;
    }

    case "replace_bullet": {
      // Replace one bullet with another in an experience or project entry.
      // patch shape: { section: "experience"|"projects",
      //                company?: string,     (for experience)
      //                projectName?: string, (for projects)
      //                oldBullet: string,
      //                newBullet: string }
      //
      // AC 7-2 guarantee: one proposal targets exactly one bullet.
      const repSection = patch.section;
      if (!repSection || !["experience", "projects"].includes(repSection)) {
        throw new Error(
          `replace_bullet patch requires "section" ("experience" or "projects")`
        );
      }
      if (typeof patch.oldBullet !== "string" || !patch.oldBullet.trim()) {
        throw new Error(`replace_bullet patch requires a non-empty "oldBullet" string`);
      }
      if (typeof patch.newBullet !== "string" || !patch.newBullet.trim()) {
        throw new Error(`replace_bullet patch requires a non-empty "newBullet" string`);
      }

      const oldBulletNorm = patch.oldBullet.trim().toLowerCase();

      if (repSection === "experience") {
        if (!patch.company) {
          throw new Error(`replace_bullet (experience) patch requires "company"`);
        }
        const repExpArr = Array.isArray(updated.experience)
          ? updated.experience.map((e) => ({ ...e, bullets: [...(e.bullets ?? [])] }))
          : [];
        const repExpTarget = repExpArr.find(
          (e) => e.company?.toLowerCase().trim() === patch.company.toLowerCase().trim()
        );
        if (!repExpTarget) {
          throw new Error(
            `replace_bullet: no experience entry found for company "${patch.company}"`
          );
        }
        const repIdx = repExpTarget.bullets.findIndex(
          (b) => String(b).trim().toLowerCase() === oldBulletNorm
        );
        if (repIdx === -1) {
          throw new Error(
            `replace_bullet: oldBullet not found in experience entry "${patch.company}": "${patch.oldBullet}"`
          );
        }
        repExpTarget.bullets[repIdx] = patch.newBullet.trim();
        repExpTarget._source = itemSource;
        updated.experience = repExpArr;
      } else {
        // projects
        if (!patch.projectName) {
          throw new Error(`replace_bullet (projects) patch requires "projectName"`);
        }
        const repProjArr = Array.isArray(updated.projects)
          ? updated.projects.map((p) => ({ ...p, bullets: [...(p.bullets ?? [])] }))
          : [];
        const repProjTarget = repProjArr.find(
          (p) => p.name?.toLowerCase().trim() === patch.projectName.toLowerCase().trim()
        );
        if (!repProjTarget) {
          throw new Error(
            `replace_bullet: no project entry found for name "${patch.projectName}"`
          );
        }
        const repProjIdx = repProjTarget.bullets.findIndex(
          (b) => String(b).trim().toLowerCase() === oldBulletNorm
        );
        if (repProjIdx === -1) {
          throw new Error(
            `replace_bullet: oldBullet not found in project entry "${patch.projectName}": "${patch.oldBullet}"`
          );
        }
        repProjTarget.bullets[repProjIdx] = patch.newBullet.trim();
        repProjTarget._source = itemSource;
        updated.projects = repProjArr;
      }
      break;
    }

    case "add_skill": {
      const validCategories = ["technical", "languages", "tools"];
      if (!validCategories.includes(patch.category) || typeof patch.skill !== "string") {
        throw new Error(
          `add_skill patch requires "category" (one of ${validCategories.join("|")}) and "skill" string`
        );
      }
      const skills = {
        technical: [...(updated.skills?.technical ?? [])],
        languages: [...(updated.skills?.languages ?? [])],
        tools: [...(updated.skills?.tools ?? [])]
      };
      const normalised = patch.skill.trim();
      if (normalised && !skills[patch.category].includes(normalised)) {
        skills[patch.category].push(normalised);
      }
      updated.skills = skills;
      // Track itemSource on the skills section
      updated._sources = { ...(updated._sources ?? {}), skills: itemSource };
      break;
    }

    case "add_experience": {
      if (!patch.entry || typeof patch.entry !== "object") {
        throw new Error(`add_experience patch requires an "entry" object`);
      }
      const newEntry = {
        _source: itemSource,
        company: String(patch.entry.company ?? ""),
        title: String(patch.entry.title ?? ""),
        start_date: patch.entry.start_date ?? null,
        end_date: patch.entry.end_date ?? null,
        location: patch.entry.location ?? null,
        bullets: Array.isArray(patch.entry.bullets) ? patch.entry.bullets.map(String) : []
      };
      updated.experience = [...(updated.experience ?? []), newEntry];
      break;
    }

    case "add_education": {
      if (!patch.entry || typeof patch.entry !== "object") {
        throw new Error(`add_education patch requires an "entry" object`);
      }
      const newEduEntry = {
        _source: itemSource,
        institution: String(patch.entry.institution ?? ""),
        degree: patch.entry.degree ?? null,
        field: patch.entry.field ?? null,
        start_date: patch.entry.start_date ?? null,
        end_date: patch.entry.end_date ?? null,
        gpa: patch.entry.gpa ?? null
      };
      updated.education = [...(updated.education ?? []), newEduEntry];
      break;
    }

    case "add_skills": {
      // Bulk-add multiple skills to skills.technical (deduped, case-insensitive)
      if (!Array.isArray(patch.skills) || patch.skills.length === 0) {
        throw new Error(`add_skills patch requires a non-empty "skills" array`);
      }
      const skills = {
        technical: [...(updated.skills?.technical ?? [])],
        languages: [...(updated.skills?.languages ?? [])],
        tools: [...(updated.skills?.tools ?? [])]
      };
      const existingLower = new Set(
        [...skills.technical, ...skills.languages, ...skills.tools].map((s) =>
          String(s).toLowerCase().trim()
        )
      );
      const toAdd = patch.skills
        .map((s) => String(s).trim())
        .filter((s) => s && !existingLower.has(s.toLowerCase()));
      skills.technical = [...skills.technical, ...toAdd];
      updated.skills = skills;
      // Track itemSource on the skills section
      updated._sources = { ...(updated._sources ?? {}), skills: itemSource };
      break;
    }

    case "update_field": {
      if (!patch.section || patch.field === undefined || patch.value === undefined) {
        throw new Error(
          `update_field patch requires "section", "field", and "value" fields`
        );
      }
      const section = updated[patch.section];
      if (section === null || section === undefined || typeof section !== "object") {
        throw new Error(
          `update_field: section "${patch.section}" is not an object in the resume`
        );
      }
      updated[patch.section] = { ...section, [patch.field]: patch.value };
      // Track itemSource on the modified section
      updated._sources = { ...(updated._sources ?? {}), [patch.section]: itemSource };
      break;
    }

    case "add_strength_keyword": {
      // Append a single keyword to strength_keywords (deduped, case-insensitive).
      // Used by the work-log batch pipeline to accumulate keywords from daily logs.
      if (typeof patch.keyword !== "string" || !patch.keyword.trim()) {
        throw new Error(
          `add_strength_keyword patch requires a non-empty "keyword" string`
        );
      }
      const kw = patch.keyword.trim().slice(0, 40);
      const existing = Array.isArray(updated.strength_keywords)
        ? [...updated.strength_keywords]
        : [];
      const existingLower = new Set(existing.map((k) => String(k).toLowerCase()));
      if (!existingLower.has(kw.toLowerCase())) {
        existing.push(kw);
      }
      updated.strength_keywords = existing;
      // Track itemSource on the strength_keywords section
      updated._sources = { ...(updated._sources ?? {}), strength_keywords: itemSource };
      break;
    }

    case "update_experience_title": {
      // Update the title of a specific experience entry identified by company name.
      // patch shape: { company: string, field: "title", value: string, previousValue?: string }
      if (!patch.company || typeof patch.value !== "string") {
        throw new Error(
          `update_experience_title patch requires "company" and "value" fields`
        );
      }
      const expEntries = Array.isArray(updated.experience)
        ? updated.experience.map((e) => ({ ...e }))
        : [];
      const titleTarget = expEntries.find(
        (e) => e.company?.toLowerCase().trim() === patch.company.toLowerCase().trim()
      );
      if (!titleTarget) {
        throw new Error(
          `update_experience_title: no experience entry found for company "${patch.company}"`
        );
      }
      titleTarget.title = patch.value;
      // Mark the modified entry with itemSource
      titleTarget._source = itemSource;
      updated.experience = expEntries;
      break;
    }

    case "add_certification": {
      // Append a new certification entry to the certifications array.
      // patch shape: { entry: { name: string, issuer?: string|null, date?: string|null } }
      if (!patch.entry || typeof patch.entry !== "object") {
        throw new Error(`add_certification patch requires an "entry" object`);
      }
      const newCert = {
        _source: itemSource,
        name: String(patch.entry.name ?? ""),
        issuer: patch.entry.issuer ?? null,
        date: patch.entry.date ?? null
      };
      updated.certifications = [...(updated.certifications ?? []), newCert];
      break;
    }

    default:
      throw new Error(`Unknown suggestion action: "${action}"`);
  }

  return updated;
}

// ─── GET /api/resume/daily-bullets/staleness ─────────────────────────────────

/**
 * Check for uncached work-log dates (source change detection).
 *
 * Compares the list of daily work-log files on disk with the list of
 * DailyBulletsDocument entries currently cached in Vercel Blob.  Returns
 * the dates that exist in the work logs but have no corresponding cached
 * bullet document.
 *
 * This endpoint is polled by the UI to show a "stale cache" indicator and
 * to decide whether to prompt the user to trigger a rebuild.
 *
 * Note: Hono's radix-tree router gives static path segments (/staleness)
 * priority over parameterised segments (/:date), so this route matches
 * correctly even though it is registered after the /:date routes.
 *
 * Response:
 *   HTTP 200  {
 *     "ok": true,
 *     "totalWorkLogDates": number,
 *     "cachedDates":       number,
 *     "uncachedDates":     string[],
 *     "isStale":           boolean
 *   }
 *
 * Error response:
 *   HTTP 502  { "ok": false, "error": "..." }
 */
resumeRouter.get("/daily-bullets/staleness", async (c) => {
  try {
    const config = await loadConfig().catch(() => null);

    if (!config?.dataDir) {
      return c.json({
        ok: true,
        totalWorkLogDates: 0,
        cachedDates: 0,
        uncachedDates: [],
        isStale: false
      });
    }

    const [workLogEntries, cachedDateList] = await Promise.all([
      gatherWorkLogBullets(config.dataDir).catch(() => []),
      listBulletDates().catch(() => [])
    ]);

    const workLogDates = workLogEntries.map((e) => e.date);
    const cachedSet = new Set(cachedDateList);
    const uncachedDates = workLogDates.filter((d) => !cachedSet.has(d));

    return c.json({
      ok: true,
      totalWorkLogDates: workLogDates.length,
      cachedDates: cachedDateList.length,
      uncachedDates,
      isStale: uncachedDates.length > 0
    });
  } catch (err) {
    console.error("[resume/daily-bullets/staleness] Error:", err);
    return c.json(
      { ok: false, error: err.message ?? String(err) },
      502
    );
  }
});

// ─── POST /api/resume/daily-bullets/rebuild-all ──────────────────────────────

/**
 * Rebuild all (or only uncached) daily bullet documents from the original
 * work-log files stored on disk — the primary cache-invalidation endpoint.
 *
 * Triggers:
 *   - Manual: user clicks the "불릿 재구성" button in the UI
 *   - Source change: UI detects uncached dates via GET /staleness and calls
 *                    this endpoint with force=false
 *
 * Cache invalidation pipeline:
 *   1. Load config to locate the data directory (data/daily/)
 *   2. Scan disk for all daily work-log JSON files via gatherWorkLogBullets()
 *   3. List existing cached dates in Vercel Blob via listBulletDates()
 *   4. Determine which dates to rebuild:
 *        force=false: only dates with no existing bullet cache (source-change)
 *        force=true:  all dates found in the work logs (full invalidation)
 *   5. For each selected date:
 *      a. Build a fresh DailyBulletsDocument from the work-log resume section
 *      b. Read any existing cached document from Vercel Blob
 *      c. Merge: preserve existing bullet statuses (promoted/dismissed);
 *         append new bullets as "pending"
 *      d. Save the merged document back to Vercel Blob
 *   6. Return rebuild stats
 *
 * User edits (promoted/dismissed bullet statuses) are ALWAYS preserved
 * during the merge step — the rebuild only fills in missing entries or
 * appends newly discovered bullets from the source work logs.
 *
 * Request body (optional JSON):
 *   { "force": true }  — rebuild all dates, not just uncached ones
 *
 * Success response:
 *   HTTP 200  {
 *     "ok":            true,
 *     "rebuilt":       number,
 *     "failed":        number,
 *     "skipped":       number,
 *     "dates":         string[],
 *     "uncachedDates": string[]
 *   }
 *
 * Error responses:
 *   HTTP 404  { "ok": false, "error": "..." }
 *   HTTP 502  { "ok": false, "error": "..." }
 */
resumeRouter.post("/daily-bullets/rebuild-all", async (c) => {
  // ── 1. Parse optional request body ────────────────────────────────────────
  let force = false;
  try {
    const body = await c.req.json().catch(() => ({}));
    force = Boolean(body?.force);
  } catch { /* default: force = false */ }

  // ── 2. Load config for data directory ─────────────────────────────────────
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error("[resume/daily-bullets/rebuild-all] Config load failed:", err);
    return c.json(
      { ok: false, error: "설정을 로드할 수 없습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!config?.dataDir) {
    return c.json(
      { ok: false, error: "데이터 디렉토리가 설정되지 않았습니다." },
      404
    );
  }

  // ── 3. Gather all work-log entries ────────────────────────────────────────
  let workLogEntries;
  try {
    workLogEntries = await gatherWorkLogBullets(config.dataDir);
  } catch (err) {
    console.error("[resume/daily-bullets/rebuild-all] gatherWorkLogBullets failed:", err);
    return c.json(
      { ok: false, error: "업무 로그를 읽을 수 없습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (workLogEntries.length === 0) {
    return c.json({
      ok: true,
      rebuilt: 0,
      failed: 0,
      skipped: 0,
      dates: [],
      uncachedDates: [],
      message: "업무 로그 파일이 없습니다."
    });
  }

  // ── 4. Identify uncached dates (source change detection) ──────────────────
  let cachedDateList = [];
  try {
    cachedDateList = await listBulletDates();
  } catch {
    // Non-fatal: treat all dates as uncached if the Blob list call fails.
    cachedDateList = [];
  }

  const cachedSet = new Set(cachedDateList);
  const uncachedDates = workLogEntries
    .map((e) => e.date)
    .filter((d) => !cachedSet.has(d));

  // ── 5. Determine entries to rebuild ───────────────────────────────────────
  const uncachedSet = new Set(uncachedDates);
  const entriesToRebuild = force
    ? workLogEntries
    : workLogEntries.filter((e) => uncachedSet.has(e.date));

  if (entriesToRebuild.length === 0) {
    console.info(
      `[resume/daily-bullets/rebuild-all] All ${workLogEntries.length} date(s) already cached; use force=true to rebuild all`
    );
    return c.json({
      ok: true,
      rebuilt: 0,
      failed: 0,
      skipped: workLogEntries.length,
      dates: [],
      uncachedDates,
      message: "모든 날짜가 이미 캐시되어 있습니다. force=true 로 강제 재구성할 수 있습니다."
    });
  }

  // ── 6. Rebuild each selected date ─────────────────────────────────────────
  let rebuilt = 0;
  let failed = 0;
  const rebuiltDates = [];

  for (const entry of entriesToRebuild) {
    try {
      // a. Build fresh DailyBulletsDocument from work-log resume section.
      //    entry = { date, candidates, companyCandidates, openSourceCandidates }
      const freshDoc = buildDailyBulletsDocument(entry.date, entry);

      // b. Read existing cached document to preserve user-edited statuses.
      let existingDoc = null;
      try {
        existingDoc = await readDailyBullets(entry.date);
      } catch (err) {
        console.warn(
          `[resume/daily-bullets/rebuild-all] Could not load existing cache for ${entry.date}:`,
          err.message ?? String(err)
        );
      }

      // c. Merge: preserves existing statuses; new bullets become "pending".
      const mergedDoc = mergeDailyBulletsDocuments(existingDoc, freshDoc);

      // d. Save merged document to Vercel Blob.
      await saveDailyBullets(entry.date, mergedDoc);

      rebuiltDates.push(entry.date);
      rebuilt++;
    } catch (err) {
      console.warn(
        `[resume/daily-bullets/rebuild-all] Failed for date=${entry.date}:`,
        err.message ?? String(err)
      );
      failed++;
    }
  }

  const skipped = workLogEntries.length - entriesToRebuild.length;

  console.info(
    `[resume/daily-bullets/rebuild-all] Done:` +
      ` rebuilt=${rebuilt} failed=${failed} skipped=${skipped} force=${force}`
  );

  return c.json({
    ok: true,
    rebuilt,
    failed,
    skipped,
    dates: rebuiltDates,
    uncachedDates
  });
});

// ─── GET /api/resume/axes ─────────────────────────────────────────────────────

/**
 * Return the current list of display axes.
 *
 * Read order (fastest-first):
 *   1. Try `resume/display-axes.json` (the independent entity store written by
 *      POST /api/resume/axes).  When this document exists, return its axes
 *      directly without loading the full resume.
 *   2. Fall back to `resume.display_axes` inside `resume/data.json`.  This
 *      handles legacy data created before the dedicated blob existed.
 *
 * Legacy items that lack an `id` field are automatically migrated in-memory
 * (the migration is NOT persisted — a subsequent write will canonicalise the
 * format).
 *
 * Axis schema (each item):
 *   {
 *     id:       string    — stable UUID
 *     label:    string    — display name for this axis (e.g. "Backend Engineer")
 *     keywords: string[]  — keywords characterising this axis perspective
 *     _source?: string    — "user" | "system"
 *   }
 *
 * Response when axes (or resume) exist:
 *   HTTP 200  { "axes": Axis[], "generatedAt": string | null }
 *
 * Response when neither axes doc nor resume exist:
 *   HTTP 404  { "ok": false, "error": "이력서가 없습니다." }
 *
 * Error response (Blob unavailable):
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }
 */
resumeRouter.get("/axes", async (c) => {
  // ── 1. Try independent entity store first (resume/display-axes.json) ──────
  let axesDoc = null;
  try {
    axesDoc = await readDisplayAxes();
  } catch (err) {
    // Non-fatal: fall through to full resume fallback.
    console.warn("[resume/axes GET] readDisplayAxes failed, falling back to resume:", err.message ?? String(err));
  }

  if (axesDoc && Array.isArray(axesDoc.axes)) {
    const axes = migrateAxes(axesDoc.axes);
    return c.json({ axes, generatedAt: axesDoc.generatedAt ?? null });
  }

  // ── 2. Fallback: load full resume document ────────────────────────────────
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes GET] readResumeData failed:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." },
      404
    );
  }

  // Migrate legacy axes (assigns id when missing) — view-only, not persisted.
  const axes = migrateAxes(resume.display_axes);
  return c.json({ axes, generatedAt: null });
});

// ─── POST /api/resume/axes/merge ──────────────────────────────────────────────

/**
 * Merge two display axes into one.
 *
 * The "source" axis is absorbed into the "target" axis: their keyword sets
 * are unioned (deduplicated, capped at 30), the source axis is removed, and
 * the target axis is updated in-place.  The resulting merged axis always
 * receives `_source: "user"` because this is a deliberate user action.
 *
 * An optional `label` field lets the caller rename the merged axis in the
 * same request; when omitted the target's existing label is preserved.
 *
 * Request body (JSON):
 *   {
 *     "targetId": string   — UUID of the axis to keep and update  (required)
 *     "sourceId": string   — UUID of the axis to absorb & remove  (required)
 *     "label":    string   — optional new label for the merged axis (1–100 chars)
 *   }
 *
 * Success response:
 *   HTTP 200  { "ok": true, "merged": Axis, "axes": Axis[] }
 *     merged — the updated target axis (with unioned keywords)
 *     axes   — the full display_axes array after the merge
 *
 * Error responses:
 *   HTTP 400  — missing / invalid body fields, or targetId === sourceId
 *   HTTP 404  — resume not found, or one of the axis ids not found
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.post("/axes/merge", async (c) => {
  // ── 1. Parse and validate body ─────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be valid JSON" }, 400);
  }

  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";

  if (!targetId) {
    return c.json({ ok: false, error: "targetId 필드가 필요합니다." }, 400);
  }
  if (!sourceId) {
    return c.json({ ok: false, error: "sourceId 필드가 필요합니다." }, 400);
  }
  if (targetId === sourceId) {
    return c.json(
      { ok: false, error: "targetId와 sourceId가 동일합니다. 같은 축을 합칠 수 없습니다." },
      400
    );
  }

  // newLabel is optional; undefined means "keep target's label"
  const newLabel = body.label !== undefined ? body.label : undefined;

  // ── 2. Load current resume ─────────────────────────────────────────────
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes/merge] read failed:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." },
      404
    );
  }

  // ── 3. Migrate axes and apply merge ────────────────────────────────────────────
  const existingAxes = migrateAxes(resume.display_axes);

  const { axes: updatedAxes, merged, error: mergeError } = mergeAxes(
    existingAxes,
    targetId,
    sourceId,
    newLabel
  );

  if (mergeError) {
    // Distinguish "not found" from other validation errors
    const isNotFound = mergeError.includes("not found");
    return c.json(
      { ok: false, error: mergeError },
      isNotFound ? 404 : 400
    );
  }

  // ── 4. Persist updated axes (dual-write: independent blob + main resume) ─────
  const mergeTimestamp = new Date().toISOString();
  const displayAxesDoc = {
    schemaVersion: 1,
    generatedAt: mergeTimestamp,
    axes: updatedAxes
  };

  try {
    await saveDisplayAxes(displayAxesDoc);
  } catch (err) {
    console.error("[resume/axes/merge] saveDisplayAxes failed:", err);
    return c.json(
      { ok: false, error: "축 저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  const updatedResume = {
    ...resume,
    display_axes: updatedAxes,
    _sources: {
      ...(resume._sources ?? {}),
      display_axes: "user"
    }
  };

  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/axes/merge] saveResumeData failed (non-fatal, display-axes already saved):", err);
    // Non-fatal: the dedicated blob is already updated; main doc sync can be retried later.
  }

  console.info(
    `[resume/axes/merge] Merged axis id="${sourceId}" into id="${targetId}" ` +
    `label="${merged.label}" keywords=${merged.keywords.length}`
  );

  return c.json({ ok: true, merged, axes: updatedAxes });
});


// ─── PATCH /api/resume/axes/:id ───────────────────────────────────────────────

/**
 * Update the label and/or keywords of an existing display axis.
 *
 * This is a partial update — only fields provided in the request body are
 * applied.  At least one of `label` or `keywords` must be present.
 * The axis `id` is immutable and cannot be changed via this endpoint.
 *
 * Route parameter:
 *   :id  — UUID of the axis to update (URL-encoded)
 *
 * Request body (JSON):
 *   {
 *     "label":    string    — optional; new display name (1–100 chars after trim)
 *     "keywords": string[]  — optional; replacement keywords list
 *   }
 *
 * Validation:
 *   - At least one of label / keywords must be present
 *   - label must be a non-empty string after trimming
 *   - keywords elements are trimmed, capped at 60 chars, deduplicated case-insensitively
 *   - Non-string keyword elements are silently dropped
 *
 * Success response:
 *   HTTP 200  { "ok": true, "axis": Axis }
 *     axis — the updated axis object
 *
 * Error responses:
 *   HTTP 400  — missing id, empty body, or invalid field values
 *   HTTP 404  — no resume, or axis id not found
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.patch("/axes/:id", async (c) => {
  // ── 1. Parse route parameter ────────────────────────────────────────────────
  const rawId = c.req.param("id");
  const axisId = (rawId ? decodeURIComponent(rawId) : "").trim();

  if (!axisId) {
    return c.json({ ok: false, error: "id 파라미터가 필요합니다." }, 400);
  }

  // ── 2. Parse and validate body ─────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON" }, 400);
  }

  const hasLabel = body?.label !== undefined;
  const hasKeywords = body?.keywords !== undefined;

  if (!hasLabel && !hasKeywords) {
    return c.json(
      { ok: false, error: "label 또는 keywords 중 하나 이상 제공해야 합니다." },
      400
    );
  }

  if (hasLabel && (typeof body.label !== "string" || !body.label.trim())) {
    return c.json(
      { ok: false, error: "label은 비어 있지 않은 문자열이어야 합니다." },
      400
    );
  }

  if (hasKeywords && !Array.isArray(body.keywords)) {
    return c.json(
      { ok: false, error: "keywords는 배열이어야 합니다." },
      400
    );
  }

  // ── 3. Load axes (dedicated blob first, main resume as fallback) ──────────
  // Mirrors the read order used by GET /api/resume/axes so that edits are
  // immediately visible on the next GET without a stale dedicated-blob hit.
  let axesDoc = null;
  try {
    axesDoc = await readDisplayAxes();
  } catch (err) {
    // Non-fatal: fall through to full resume fallback.
    console.warn(
      "[resume/axes PATCH] readDisplayAxes failed, falling back to resume:",
      err.message ?? String(err)
    );
  }

  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes PATCH] read failed:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." },
      404
    );
  }

  // ── 4. Determine source axes and apply partial update ─────────────────────
  // Prefer axes from dedicated blob (mirrors GET read priority).
  const sourceAxes = (axesDoc && Array.isArray(axesDoc.axes))
    ? migrateAxes(axesDoc.axes)
    : migrateAxes(resume.display_axes);

  const updates = {};
  if (hasLabel) updates.label = body.label;
  if (hasKeywords) updates.keywords = body.keywords;

  const { axes: updatedAxes, updated: updatedAxis } = updateAxisInArray(
    sourceAxes,
    axisId,
    updates
  );

  if (!updatedAxis) {
    return c.json(
      { ok: false, error: `id="${axisId}" 인 표시 축을 찾을 수 없습니다.` },
      404
    );
  }

  // ── 5. Dual-write: update display-axes.json blob when it exists ───────────
  // This keeps GET /api/resume/axes consistent after a rename — GET reads
  // the dedicated blob first, so without this write the old label would be
  // returned until the next full regeneration.
  if (axesDoc) {
    try {
      await saveDisplayAxes({ ...axesDoc, axes: updatedAxes });
    } catch (err) {
      console.error("[resume/axes PATCH] saveDisplayAxes failed:", err);
      return c.json(
        { ok: false, error: "축 블롭 저장 실패: " + (err.message ?? String(err)) },
        502
      );
    }
  }

  // ── 6. Save updated resume to Blob ─────────────────────────────────────────
  const updatedResume = {
    ...resume,
    display_axes: updatedAxes,
    _sources: {
      ...(resume._sources ?? {}),
      display_axes: "user"
    }
  };

  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/axes PATCH] save failed:", err);
    return c.json(
      { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  console.info(
    `[resume/axes PATCH] Updated axis id="${axisId}" label="${updatedAxis.label}"`
  );

  return c.json({ ok: true, axis: updatedAxis });
});

// ─── DELETE /api/resume/axes/:id ──────────────────────────────────────────────

/**
 * Remove a display axis by its id.
 *
 * Idempotent — if the axis is not found, response is 200 with `removed: false`.
 *
 * Route parameter:
 *   :id  — UUID of the axis to remove (URL-encoded)
 *
 * Success response:
 *   HTTP 200  { "ok": true, "removed": boolean, "axes": Axis[] }
 *     removed — true when the axis was found and deleted; false when absent
 *     axes    — full updated axis list (after removal if it occurred)
 *
 * Error responses:
 *   HTTP 400  — empty or missing id parameter
 *   HTTP 404  — no resume exists yet (bootstrap first)
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.delete("/axes/:id", async (c) => {
  // ── 1. Validate route parameter ────────────────────────────────────────────
  const rawId = c.req.param("id");
  const axisId = (rawId ? decodeURIComponent(rawId) : "").trim();

  if (!axisId) {
    return c.json({ ok: false, error: "id 파라미터가 필요합니다." }, 400);
  }

  // ── 2. Load current resume ─────────────────────────────────────────────────
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes DELETE] read failed:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." },
      404
    );
  }

  // ── 3. Migrate axes and remove target ────────────────────────────────────
  const existingAxes = migrateAxes(resume.display_axes);
  const { axes: updatedAxes, removed } = removeAxisFromArray(existingAxes, axisId);

  if (!removed) {
    // Axis not found — no Blob write needed.
    return c.json({ ok: true, removed: false, axes: existingAxes });
  }

  // ── 4. Save updated resume to Blob ─────────────────────────────────────────
  const updatedResume = {
    ...resume,
    display_axes: updatedAxes,
    _sources: {
      ...(resume._sources ?? {}),
      display_axes: "user"
    }
  };

  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/axes DELETE] save failed:", err);
    return c.json(
      { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  console.info(`[resume/axes DELETE] Removed axis id="${axisId}"`);

  return c.json({ ok: true, removed: true, axes: updatedAxes });
});

// ─── POST /api/resume/section-bullet ──────────────────────────────────────────

/**
 * Directly append a bullet to an experience or project item (user edit).
 *
 * This is a first-class user edit: the bullet is appended immediately to the
 * live resume document without going through the suggestion approval flow.
 * The target item's `_source` is set to "user" to reflect the direct edit.
 *
 * Request body (JSON):
 *   {
 *     "section":   "experience" | "projects"   — required; which section array to target
 *     "itemIndex": number                       — required; 0-based index within the array
 *     "bullet":    string                       — required; new bullet text (max 500 chars)
 *   }
 *
 * Validation:
 *   - section must be exactly "experience" or "projects"
 *   - itemIndex must be a non-negative integer within bounds
 *   - bullet must be a non-empty string (after trimming)
 *   - bullet is capped at 500 characters
 *
 * Success response:
 *   HTTP 200  { "ok": true, "resume": ResumeDocument }
 *     resume — the full updated resume document after saving
 *
 * Error responses:
 *   HTTP 400  — missing / invalid body fields
 *   HTTP 404  — no resume exists yet (bootstrap first)
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.post("/section-bullet", async (c) => {
  // ── 1. Parse and validate request body ────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "요청 본문이 올바른 JSON 형식이 아닙니다." }, 400);
  }

  const { section, itemIndex, bullet } = body ?? {};

  if (section !== "experience" && section !== "projects") {
    return c.json(
      { ok: false, error: "section은 \"experience\" 또는 \"projects\" 중 하나여야 합니다." },
      400
    );
  }

  if (
    typeof itemIndex !== "number" ||
    !Number.isInteger(itemIndex) ||
    itemIndex < 0
  ) {
    return c.json(
      { ok: false, error: "itemIndex는 0 이상의 정수여야 합니다." },
      400
    );
  }

  if (!bullet || typeof bullet !== "string" || !bullet.trim()) {
    return c.json(
      { ok: false, error: "bullet은 비어 있지 않은 문자열이어야 합니다." },
      400
    );
  }

  const trimmedBullet = bullet.trim().slice(0, 500);

  // ── 2. Load current resume ─────────────────────────────────────────────────
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/section-bullet POST] read failed:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." },
      404
    );
  }

  // ── 3. Locate the target item and append the bullet ───────────────────────
  const sectionArr = Array.isArray(resume[section]) ? resume[section] : [];

  if (itemIndex >= sectionArr.length) {
    return c.json(
      {
        ok: false,
        error: `${section}[${itemIndex}] 항목이 존재하지 않습니다. 현재 항목 수: ${sectionArr.length}`
      },
      400
    );
  }

  const updatedSection = sectionArr.map((item, idx) => {
    if (idx !== itemIndex) return item;
    return {
      ...item,
      bullets: [...(Array.isArray(item.bullets) ? item.bullets : []), trimmedBullet],
      _source: "user",
    };
  });

  // ── 4. Save updated resume ─────────────────────────────────────────────────
  const updatedResume = {
    ...resume,
    [section]: updatedSection,
  };

  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/section-bullet POST] save failed:", err);
    return c.json(
      { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  console.info(
    `[resume/section-bullet POST] Appended bullet to ${section}[${itemIndex}]: "${trimmedBullet.slice(0, 60)}…"`
  );

  return c.json({ ok: true, resume: updatedResume });
});

// ─── PATCH /api/resume/items ──────────────────────────────────────────────────

/**
 * Unified bullet-level direct-edit endpoint (user edit, source=user).
 *
 * This is the primary single-call API for all bullet mutations on experience
 * and projects items.  It intentionally bypasses the mergeCandidates /
 * suggestion-approval flow — changes are applied immediately to the live
 * resume document in Vercel Blob.  The affected item's `_source` is always
 * set to "user" regardless of its prior value.
 *
 * Request body (JSON):
 *   {
 *     "op":          "add" | "update" | "delete"   — required
 *     "section":     "experience" | "projects"      — required
 *     "itemIndex":   number                         — required; 0-based index in resume[section]
 *     "bulletIndex": number                         — required for "update" / "delete"
 *     "text":        string                         — required for "add" / "update"; max 500 chars
 *   }
 *
 * Operations:
 *   add    — Appends `text` to item.bullets.  `bulletIndex` is ignored.
 *   update — Replaces bullets[bulletIndex] with `text`.
 *   delete — Removes bullets[bulletIndex] (splice).  `text` is ignored.
 *
 * Validation rules:
 *   - op must be exactly "add", "update", or "delete"
 *   - section must be exactly "experience" or "projects"
 *   - itemIndex must be a non-negative integer and within bounds
 *   - bulletIndex required (non-negative integer, within bounds) for update/delete
 *   - text required (non-empty after trim) for add/update; capped at 500 chars
 *
 * Side-effects:
 *   • Sets _source: "user" on the mutated item (user priority constraint)
 *   • Does NOT create or modify any mergeCandidates / suggestions document
 *   • Does NOT snapshot the resume (Day 1: no automatic snapshot on direct edit)
 *
 * Success response:
 *   HTTP 200  { "ok": true, "resume": ResumeDocument }
 *
 * Error responses:
 *   HTTP 400  { "ok": false, "error": string }  — missing / invalid fields
 *   HTTP 404  { "ok": false, "error": string }  — no resume / item / bullet not found
 *   HTTP 500  { "ok": false, "error": string }  — Blob read/write failure
 */
resumeRouter.patch("/items", async (c) => {
  // ── 1. Parse body ────────────────────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "요청 본문이 올바른 JSON 형식이 아닙니다." }, 400);
  }

  const { op, section, itemIndex, bulletIndex, text } = body ?? {};

  // ── 2. Validate op ───────────────────────────────────────────────────────────
  const ALLOWED_OPS = ["add", "update", "delete"];
  if (!ALLOWED_OPS.includes(op)) {
    return c.json(
      { ok: false, error: `op은 "add", "update", "delete" 중 하나여야 합니다. 받은 값: ${JSON.stringify(op)}` },
      400
    );
  }

  // ── 3. Validate section ──────────────────────────────────────────────────────
  const ALLOWED_SECTIONS = ["experience", "projects"];
  if (!ALLOWED_SECTIONS.includes(section)) {
    return c.json(
      { ok: false, error: `section은 "experience" 또는 "projects" 중 하나여야 합니다. 받은 값: ${JSON.stringify(section)}` },
      400
    );
  }

  // ── 4. Validate itemIndex ────────────────────────────────────────────────────
  if (typeof itemIndex !== "number" || !Number.isInteger(itemIndex) || itemIndex < 0) {
    return c.json(
      { ok: false, error: "itemIndex는 0 이상의 정수여야 합니다." },
      400
    );
  }

  // ── 5. Validate bulletIndex (required for update/delete) ────────────────────
  if (op === "update" || op === "delete") {
    if (typeof bulletIndex !== "number" || !Number.isInteger(bulletIndex) || bulletIndex < 0) {
      return c.json(
        { ok: false, error: `op="${op}"일 때 bulletIndex는 0 이상의 정수여야 합니다.` },
        400
      );
    }
  }

  // ── 6. Validate text (required for add/update) ───────────────────────────────
  let trimmedText;
  if (op === "add" || op === "update") {
    if (!text || typeof text !== "string" || !text.trim()) {
      return c.json(
        { ok: false, error: `op="${op}"일 때 text는 비어 있지 않은 문자열이어야 합니다.` },
        400
      );
    }
    trimmedText = text.trim().slice(0, 500);
  }

  // ── 7. Load current resume ───────────────────────────────────────────────────
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/items PATCH] readResumeData failed:", err);
    return c.json({ ok: false, error: "이력서를 불러오지 못했습니다." }, 500);
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 온보딩을 완료해 주세요." },
      404
    );
  }

  // ── 8. Locate target item ────────────────────────────────────────────────────
  const sectionArr = Array.isArray(resume[section]) ? resume[section] : [];

  if (itemIndex >= sectionArr.length) {
    return c.json(
      {
        ok: false,
        error: `${section}[${itemIndex}] 항목이 없습니다. (총 ${sectionArr.length}개)`
      },
      404
    );
  }

  const targetItem = sectionArr[itemIndex];
  const bullets    = Array.isArray(targetItem.bullets) ? [...targetItem.bullets] : [];

  // ── 9. Apply operation ───────────────────────────────────────────────────────
  if (op === "add") {
    bullets.push(trimmedText);
  } else if (op === "update") {
    if (bulletIndex >= bullets.length) {
      return c.json(
        { ok: false, error: `bullets[${bulletIndex}]이 없습니다. (총 ${bullets.length}개)` },
        404
      );
    }
    bullets[bulletIndex] = trimmedText;
  } else {
    // delete
    if (bulletIndex >= bullets.length) {
      return c.json(
        { ok: false, error: `bullets[${bulletIndex}]이 없습니다. (총 ${bullets.length}개)` },
        404
      );
    }
    bullets.splice(bulletIndex, 1);
  }

  // ── 10. Rebuild section with _source: "user" on mutated item ────────────────
  const updatedSection = sectionArr.map((item, idx) =>
    idx === itemIndex ? { ...item, bullets, _source: "user" } : item
  );

  const updatedResume = { ...resume, [section]: updatedSection };

  // ── 11. Save ─────────────────────────────────────────────────────────────────
  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/items PATCH] saveResumeData failed:", err);
    return c.json({ ok: false, error: "이력서 저장 실패" }, 500);
  }

  console.info(
    `[resume/items PATCH] op=${op} ${section}[${itemIndex}]` +
    (op !== "add" ? `.bullets[${bulletIndex}]` : " (appended)") +
    (trimmedText ? ` → "${trimmedText.slice(0, 60)}"` : "")
  );

  return c.json({ ok: true, resume: updatedResume });
});

// ─── PATCH /api/resume ────────────────────────────────────────────────────────

/**
 * User-edit the full resume document.
 *
 * Merges incoming fields into the stored document.
 * User-edited sections are marked with _sources.<section> = 'user', overriding
 * any prior system-generated value (constraint: user edits always take priority).
 *
 * Request body:
 *   { resume: { contact?, summary?, experience?, projects?, education?,
 *               skills?, certifications? } }
 *
 * Only the fixed minimum schema sections are accepted; unknown fields are
 * silently ignored to avoid schema drift.
 *
 * Response:
 *   HTTP 200  { ok: true, resume: { ...updatedDocument } }
 *   HTTP 400  { error: "..." }        — invalid body
 *   HTTP 404  { error: "..." }        — no resume to update (bootstrap first)
 *   HTTP 500  { error: "..." }        — blob read/write failure
 */
resumeRouter.patch("/", async (c) => {
  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "요청 본문이 유효한 JSON이 아닙니다." }, 400);
  }

  const incoming = body?.resume;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return c.json({ ok: false, error: "resume 객체가 필요합니다." }, 400);
  }

  // ── 2. Load current resume ─────────────────────────────────────────────────
  let stored;
  try {
    stored = await readResumeData();
  } catch (err) {
    console.error("[resume PATCH] blob read failed:", err);
    return c.json({ ok: false, error: "이력서 데이터를 읽는 중 오류가 발생했습니다." }, 500);
  }

  if (!stored) {
    return c.json({ ok: false, error: "저장된 이력서가 없습니다. 먼저 온보딩을 완료하세요." }, 404);
  }

  // ── 3. Merge: only fixed minimum schema sections ───────────────────────────
  // User edits always take priority over system values (constraint).
  const updatedSources = { ...(stored._sources ?? {}) };

  const updated = { ...stored };

  // contact — mark as 'user' if provided
  if (incoming.contact !== undefined && typeof incoming.contact === "object") {
    updated.contact = { ...(stored.contact ?? {}), ...incoming.contact };
    updatedSources.contact = "user";
  }

  // summary — mark as 'user' if provided and non-empty
  if (typeof incoming.summary === "string") {
    updated.summary = incoming.summary;
    updatedSources.summary = "user";
  }

  // experience — replace array; mark as 'user'
  if (Array.isArray(incoming.experience)) {
    // Strip any accidental extra properties while preserving _source per-item
    updated.experience = incoming.experience.map((exp) => ({
      company:    exp.company    ?? "",
      title:      exp.title      ?? "",
      start_date: exp.start_date ?? null,
      end_date:   exp.end_date   ?? null,
      location:   exp.location   ?? null,
      bullets:    Array.isArray(exp.bullets) ? exp.bullets.filter((b) => typeof b === "string") : [],
      _source:    "user",
    }));
    updatedSources.experience = "user";
  }

  // projects — replace array; mark as 'user'
  if (Array.isArray(incoming.projects)) {
    updated.projects = incoming.projects.map((proj) => ({
      title:       proj.title       ?? proj.name ?? "",
      name:        proj.name        ?? proj.title ?? "",
      description: proj.description ?? "",
      url:         proj.url         ?? "",
      tech_stack:  Array.isArray(proj.tech_stack) ? proj.tech_stack : [],
      bullets:     Array.isArray(proj.bullets) ? proj.bullets.filter((b) => typeof b === "string") : [],
      _source:     "user",
    }));
    updatedSources.projects = "user";
  }

  // education — replace array; mark as 'user'
  if (Array.isArray(incoming.education)) {
    updated.education = incoming.education.map((edu) => ({
      institution: edu.institution ?? "",
      degree:      edu.degree      ?? "",
      field:       edu.field       ?? "",
      start_date:  edu.start_date  ?? null,
      end_date:    edu.end_date    ?? null,
      gpa:         edu.gpa         ?? null,
      _source:     "user",
    }));
    updatedSources.education = "user";
  }

  // skills — merge sub-fields; mark as 'user'
  if (incoming.skills !== undefined && typeof incoming.skills === "object") {
    const s = incoming.skills;
    updated.skills = {
      technical: Array.isArray(s.technical) ? s.technical : (stored.skills?.technical ?? []),
      languages: Array.isArray(s.languages) ? s.languages : (stored.skills?.languages ?? []),
      tools:     Array.isArray(s.tools)     ? s.tools     : (stored.skills?.tools     ?? []),
    };
    updatedSources.skills = "user";
  }

  // certifications — replace array; mark as 'user'
  if (Array.isArray(incoming.certifications)) {
    updated.certifications = incoming.certifications.map((cert) => ({
      name:         cert.name         ?? cert.title ?? "",
      title:        cert.title        ?? cert.name  ?? "",
      issuer:       cert.issuer       ?? "",
      date:         cert.date         ?? cert.issued_date ?? "",
      issued_date:  cert.issued_date  ?? cert.date ?? "",
      expiry_date:  cert.expiry_date  ?? null,
      url:          cert.url          ?? "",
      _source:      "user",
    }));
    updatedSources.certifications = "user";
  }

  updated._sources = updatedSources;

  // ── 4. Save ───────────────────────────────────────────────────────────────
  try {
    await saveResumeData(updated);
  } catch (err) {
    console.error("[resume PATCH] blob save failed:", err);
    return c.json({ ok: false, error: "이력서 저장 중 오류가 발생했습니다." }, 500);
  }

  console.info("[resume PATCH] User edited resume document.");
  return c.json({ ok: true, resume: updated });
});

// ─── PATCH /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex ──────
/**
 * Edit the text of a single bullet in experience or projects (direct user edit).
 *
 * :section     — "experience" | "projects"
 * :itemIndex   — 0-based index in resume[section]
 * :bulletIndex — 0-based index in resume[section][itemIndex].bullets
 *
 * Body: { "text": string }   (must be non-empty)
 *
 * Success: HTTP 200  { ok: true, resume: {...} }
 * Errors:  400 (bad params/body) | 404 (resume/item/bullet not found) | 500
 *
 * Side-effect: marks the parent item's _source as "user" (user edit takes priority).
 */
resumeRouter.patch(
  "/sections/:section/:itemIndex/bullets/:bulletIndex",
  async (c) => {
    const section     = c.req.param("section");
    const itemIndex   = parseInt(c.req.param("itemIndex"),   10);
    const bulletIndex = parseInt(c.req.param("bulletIndex"), 10);

    const ALLOWED = ["experience", "projects"];
    if (!ALLOWED.includes(section)) {
      return c.json(
        { error: `허용되지 않은 섹션: ${section}. 허용: experience, projects` },
        400
      );
    }
    if (!Number.isFinite(itemIndex) || itemIndex < 0) {
      return c.json({ error: "itemIndex는 0 이상의 정수여야 합니다." }, 400);
    }
    if (!Number.isFinite(bulletIndex) || bulletIndex < 0) {
      return c.json({ error: "bulletIndex는 0 이상의 정수여야 합니다." }, 400);
    }

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "요청 본문이 유효한 JSON이 아닙니다." }, 400);
    }

    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json(
        { error: "빈 bullet 텍스트는 허용되지 않습니다. 삭제하려면 DELETE를 사용하세요." },
        400
      );
    }

    let resume;
    try {
      resume = await readResumeData();
    } catch (err) {
      console.error(`[resume/sections/${section} PATCH] readResumeData failed:`, err);
      return c.json({ error: "이력서 조회 실패" }, 500);
    }
    if (!resume) return c.json({ error: "이력서를 찾을 수 없습니다." }, 404);

    const items = Array.isArray(resume[section]) ? resume[section] : [];
    if (itemIndex >= items.length) {
      return c.json(
        { error: `${section}[${itemIndex}] 항목을 찾을 수 없습니다. (총 ${items.length}개)` },
        404
      );
    }

    const item    = items[itemIndex];
    const bullets = Array.isArray(item.bullets) ? [...item.bullets] : [];
    if (bulletIndex >= bullets.length) {
      return c.json(
        { error: `bullet[${bulletIndex}]을 찾을 수 없습니다. (총 ${bullets.length}개)` },
        404
      );
    }

    bullets[bulletIndex] = body.text.trim();

    const updatedItems  = items.map((it, i) =>
      i === itemIndex ? { ...it, bullets, _source: "user" } : it
    );
    const updatedResume = { ...resume, [section]: updatedItems };

    try {
      await saveResumeData(updatedResume);
    } catch (err) {
      console.error(`[resume/sections/${section} PATCH] saveResumeData failed:`, err);
      return c.json({ error: "이력서 저장 실패" }, 500);
    }

    console.info(
      `[resume/sections PATCH] ${section}[${itemIndex}].bullets[${bulletIndex}] 수정 완료`
    );
    return c.json({ ok: true, resume: updatedResume });
  }
);

// ─── DELETE /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex ─────
/**
 * Delete a single bullet from experience or projects (direct user edit).
 *
 * :section     — "experience" | "projects"
 * :itemIndex   — 0-based index in resume[section]
 * :bulletIndex — 0-based index in resume[section][itemIndex].bullets
 *
 * Success: HTTP 200  { ok: true, resume: {...} }
 * Errors:  400 (bad params) | 404 (resume/item/bullet not found) | 500
 *
 * Side-effect: marks the parent item's _source as "user" (user edit takes priority).
 */
resumeRouter.delete(
  "/sections/:section/:itemIndex/bullets/:bulletIndex",
  async (c) => {
    const section     = c.req.param("section");
    const itemIndex   = parseInt(c.req.param("itemIndex"),   10);
    const bulletIndex = parseInt(c.req.param("bulletIndex"), 10);

    const ALLOWED = ["experience", "projects"];
    if (!ALLOWED.includes(section)) {
      return c.json(
        { error: `허용되지 않은 섹션: ${section}. 허용: experience, projects` },
        400
      );
    }
    if (!Number.isFinite(itemIndex) || itemIndex < 0) {
      return c.json({ error: "itemIndex는 0 이상의 정수여야 합니다." }, 400);
    }
    if (!Number.isFinite(bulletIndex) || bulletIndex < 0) {
      return c.json({ error: "bulletIndex는 0 이상의 정수여야 합니다." }, 400);
    }

    let resume;
    try {
      resume = await readResumeData();
    } catch (err) {
      console.error(`[resume/sections/${section} DELETE] readResumeData failed:`, err);
      return c.json({ error: "이력서 조회 실패" }, 500);
    }
    if (!resume) return c.json({ error: "이력서를 찾을 수 없습니다." }, 404);

    const items = Array.isArray(resume[section]) ? resume[section] : [];
    if (itemIndex >= items.length) {
      return c.json(
        { error: `${section}[${itemIndex}] 항목을 찾을 수 없습니다. (총 ${items.length}개)` },
        404
      );
    }

    const item    = items[itemIndex];
    const bullets = Array.isArray(item.bullets) ? [...item.bullets] : [];
    if (bulletIndex >= bullets.length) {
      return c.json(
        { error: `bullet[${bulletIndex}]을 찾을 수 없습니다. (총 ${bullets.length}개)` },
        404
      );
    }

    bullets.splice(bulletIndex, 1);

    const updatedItems  = items.map((it, i) =>
      i === itemIndex ? { ...it, bullets, _source: "user" } : it
    );
    const updatedResume = { ...resume, [section]: updatedItems };

    try {
      await saveResumeData(updatedResume);
    } catch (err) {
      console.error(`[resume/sections/${section} DELETE] saveResumeData failed:`, err);
      return c.json({ error: "이력서 저장 실패" }, 500);
    }

    console.info(
      `[resume/sections DELETE] ${section}[${itemIndex}].bullets[${bulletIndex}] 삭제 완료`
    );
    return c.json({ ok: true, resume: updatedResume });
  }
);

// ─── GET /api/resume/keyword-axes ────────────────────────────────────────────

/**
 * Return the persisted keyword cluster axes from Vercel Blob.
 *
 * Keyword cluster axes are 5–6 thematic groupings generated by
 * `clusterKeywords` (resumeKeywordClustering.mjs).  They are persisted at
 * `resume/keyword-cluster-axes.json` so that subsequent classification calls
 * reuse the same axis set without re-running the LLM.
 *
 * Response when axes EXIST:
 *   HTTP 200  { "exists": true, "axes": Axis[], "generatedAt": ISO string }
 *
 * Response when axes do NOT exist yet:
 *   HTTP 200  { "exists": false, "axes": null }
 *
 * Error response (Blob unavailable):
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }
 */
resumeRouter.get("/keyword-axes", async (c) => {
  let axesDoc;
  try {
    axesDoc = await readKeywordClusterAxes();
  } catch (err) {
    console.error("[resume/keyword-axes GET] read failed:", err);
    return c.json(
      { ok: false, error: "클러스터 축을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!axesDoc) {
    return c.json({ exists: false, axes: null });
  }

  return c.json({
    exists: true,
    axes: Array.isArray(axesDoc.axes) ? axesDoc.axes : [],
    generatedAt: axesDoc.generatedAt ?? null
  });
});

// ─── POST /api/resume/keyword-axes ───────────────────────────────────────────

/**
 * Generate (or return cached) keyword cluster axes.
 *
 * On first call (or when `force: true`):
 *   1. Load the stored resume and collect its keywords (strength_keywords +
 *      skills.technical / languages / tools).
 *   2. Load the most recent daily bullet caches and extract technology tokens
 *      as work-log keywords.
 *   3. Call `clusterKeywords()` (LLM) to produce 5-6 thematic axes.
 *   4. Stamp each axis with a stable UUID via `createAxis`.
 *   5. Persist the resulting document to Vercel Blob at
 *      `resume/keyword-cluster-axes.json`.
 *   6. Return the axes with `regenerated: true`.
 *
 * On subsequent calls (`force: false`, the default):
 *   - Return the cached axes immediately without calling the LLM.
 *   - `regenerated` is `false` in the response.
 *
 * Request body (JSON, optional):
 *   { "force": boolean }   // default false
 *
 * Response:
 *   HTTP 200  {
 *     "ok": true,
 *     "axes": Axis[],          // each Axis has { id, label, keywords[], _source }
 *     "regenerated": boolean,  // true when LLM was called
 *     "generatedAt": ISO string
 *   }
 *
 * Error responses:
 *   HTTP 400  { "ok": false, "error": "..." }  -- invalid JSON body
 *   HTTP 404  { "ok": false, "error": "..." }  -- no resume exists
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }  -- Blob or LLM failure
 */
resumeRouter.post("/keyword-axes", async (c) => {
  // ── 1. Parse optional body ────────────────────────────────────────────────
  let force = false;
  try {
    const body = await c.req.json().catch(() => ({}));
    if (body !== null && typeof body === "object" && typeof body.force === "boolean") {
      force = body.force;
    }
  } catch {
    return c.json({ ok: false, error: "잘못된 요청 본문입니다." }, 400);
  }

  // ── 2. Return cached axes when they exist and force is false ──────────────
  if (!force) {
    let cachedDoc = null;
    try {
      cachedDoc = await readKeywordClusterAxes();
    } catch (err) {
      // Cache read failure is non-fatal -- fall through to regeneration.
      console.warn(
        "[resume/keyword-axes] Cache read failed, regenerating:",
        err.message ?? String(err)
      );
    }

    if (cachedDoc && Array.isArray(cachedDoc.axes) && cachedDoc.axes.length > 0) {
      console.info(
        `[resume/keyword-axes] Returning ${cachedDoc.axes.length} cached axes (force=false)`
      );
      return c.json({
        ok: true,
        axes: cachedDoc.axes,
        regenerated: false,
        generatedAt: cachedDoc.generatedAt ?? null
      });
    }
  }

  // ── 3. Load resume document ───────────────────────────────────────────────
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/keyword-axes] Failed to read resume:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json({ ok: false, error: "이력서가 없습니다. 먼저 이력서를 업로드하세요." }, 404);
  }

  // ── 4. Collect keywords from resume ──────────────────────────────────────
  const resumeKeywords = collectResumeKeywords(resume);

  // ── 5. Collect work-log keywords from recent daily bullet caches ──────────
  // Work-log keywords are best-effort; failure here does not abort the request.
  let workLogKeywords = [];
  try {
    const recentDates = await listBulletDates();
    // Load up to the 90 most recent days to keep the keyword pool relevant.
    const datesToLoad = recentDates.slice(0, 90);
    const bulletDocs = await Promise.all(
      datesToLoad.map((date) => readDailyBullets(date).catch(() => null))
    );
    const workLogs = bulletDocs
      .filter(Boolean)
      .map((doc) => ({
        // Map DailyBulletsDocument to the shape expected by collectWorkLogKeywords:
        //   { keywords: string[], resumeBullets: string[] }
        keywords: [],
        resumeBullets: (Array.isArray(doc.bullets) ? doc.bullets : [])
          .map((b) => (typeof b.text === "string" ? b.text : ""))
          .filter(Boolean)
      }));
    workLogKeywords = collectWorkLogKeywords(workLogs);
  } catch (err) {
    console.warn(
      "[resume/keyword-axes] Failed to load work-log keywords (proceeding with resume keywords only):",
      err.message ?? String(err)
    );
  }

  // ── 5.5. Load existing keyword cluster axes for merging (force=true only) ──
  // When regenerating with force=true, we load the currently-persisted axes so
  // that:
  //   - User-edited axes (_source === "user") are preserved unchanged.
  //   - System axes whose keyword sets overlap significantly with a new LLM
  //     axis keep their stable UUID, avoiding unnecessary ID churn.
  // On a cache-miss path (force=false, no cached doc), there are no existing
  // axes to merge with, so we skip this step.
  let existingAxesForMerge = [];
  if (force) {
    try {
      const existingDoc = await readKeywordClusterAxes();
      if (existingDoc && Array.isArray(existingDoc.axes)) {
        existingAxesForMerge = existingDoc.axes;
      }
    } catch (err) {
      // Non-fatal: if we cannot read the existing axes, proceed with a fresh
      // generation. The user can always re-run force=true to recover.
      console.warn(
        "[resume/keyword-axes] Could not load existing axes for merge (proceeding fresh):",
        err.message ?? String(err)
      );
    }
  }

  // ── 6. Cluster keywords via LLM ───────────────────────────────────────────
  let rawAxes;
  try {
    rawAxes = await clusterKeywords(resumeKeywords, workLogKeywords);
  } catch (err) {
    console.error("[resume/keyword-axes] Keyword clustering failed:", err);
    return c.json(
      { ok: false, error: "키워드 클러스터링에 실패했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  // ── 7. Merge new KeywordAxis[] with existing Axis[] ───────────────────────
  // mergeKeywordClusterAxes (from resumeRecluster.mjs):
  //   - Preserves user-edited axes (_source === "user") unchanged.
  //   - Updates existing system axes that overlap with a new axis (Jaccard ≥ 0.25).
  //   - Appends brand-new axes (no overlap with existing) as fresh system axes.
  // When existingAxesForMerge is empty (first generation or force=false cache-miss),
  // this is equivalent to rawAxes.map((ka) => createAxis(ka.label, ka.keywords, "system")).
  const axes = mergeKeywordClusterAxes(existingAxesForMerge, rawAxes);

  // ── 8. Persist to Vercel Blob ─────────────────────────────────────────────
  const generatedAt = new Date().toISOString();
  const axesDoc = {
    schemaVersion: 1,
    generatedAt,
    axes
  };

  try {
    await saveKeywordClusterAxes(axesDoc);
  } catch (err) {
    console.error("[resume/keyword-axes] Failed to save axes document:", err);
    return c.json(
      { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  console.info(
    `[resume/keyword-axes] Generated and saved ${axes.length} keyword cluster axes (force=${force})`
  );

  return c.json({ ok: true, axes, regenerated: true, generatedAt });
});

// ─── POST /api/resume/cluster-keywords ───────────────────────────────────────

/**
 * Stateless keyword clustering endpoint.
 *
 * Accepts an explicit keyword list in the request body, calls the LLM to
 * cluster the keywords into 5–6 thematic axes, and returns the Axis array.
 * Unlike POST /api/resume/keyword-axes, this endpoint does NOT load keywords
 * from Vercel Blob and does NOT persist any result — it is a pure
 * request/response utility for preview and exploratory clustering.
 *
 * Two input formats are accepted:
 *   a) Flat:  { "keywords": string[] }
 *      The entire list is treated as a single combined pool.
 *
 *   b) Split: { "resumeKeywords": string[], "workLogKeywords": string[] }
 *      The two arrays are combined before being sent to the LLM (matching
 *      the internal contract of clusterKeywords()).
 *
 * Both formats may be present simultaneously; when both `keywords` and
 * `resumeKeywords`/`workLogKeywords` are provided, `keywords` takes
 * precedence (the split fields are ignored).
 *
 * When OPENAI_API_KEY is absent or WORK_LOG_DISABLE_OPENAI=1, the LLM call
 * is skipped and the endpoint returns an empty Axis array with HTTP 200 (not
 * an error — callers should treat this as "feature unavailable").
 *
 * Request body (JSON):
 *   { "keywords": string[] }
 *   OR
 *   { "resumeKeywords": string[], "workLogKeywords"?: string[] }
 *
 * Response (success):
 *   HTTP 200  { "ok": true, "axes": Axis[] }
 *
 * Error responses:
 *   HTTP 400  { "ok": false, "error": "..." }  — non-JSON body or missing keyword arrays
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }  — LLM call failed
 */
resumeRouter.post("/cluster-keywords", async (c) => {
  // ── 1. Parse request body ─────────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "요청 본문이 올바른 JSON 형식이 아닙니다." }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ ok: false, error: "요청 본문이 올바른 JSON 형식이 아닙니다." }, 400);
  }

  // ── 2. Extract keyword arrays ─────────────────────────────────────────────
  let resumeKws;
  let workLogKws;

  if (Array.isArray(body.keywords)) {
    // Flat format: entire list treated as resume keywords; worklog is empty.
    resumeKws = body.keywords;
    workLogKws = [];
  } else if (
    Array.isArray(body.resumeKeywords) ||
    Array.isArray(body.workLogKeywords)
  ) {
    // Split format: caller separates resume and work-log keyword sources.
    resumeKws  = Array.isArray(body.resumeKeywords)  ? body.resumeKeywords  : [];
    workLogKws = Array.isArray(body.workLogKeywords) ? body.workLogKeywords : [];
  } else {
    return c.json(
      {
        ok: false,
        error:
          "키워드 목록이 필요합니다. keywords 배열 또는 resumeKeywords/workLogKeywords 배열을 제공하세요."
      },
      400
    );
  }

  // ── 3. Short-circuit when the combined keyword pool is empty ──────────────
  const allKws = [
    ...(Array.isArray(resumeKws)  ? resumeKws  : []),
    ...(Array.isArray(workLogKws) ? workLogKws : [])
  ].filter((k) => typeof k === "string" && k.trim().length > 0);

  if (allKws.length === 0) {
    return c.json({ ok: true, axes: [] });
  }

  // ── 4. Call LLM clustering ─────────────────────────────────────────────────
  let rawAxes;
  try {
    rawAxes = await clusterKeywords(resumeKws, workLogKws);
  } catch (err) {
    console.error("[resume/cluster-keywords] LLM clustering failed:", err);
    return c.json(
      {
        ok: false,
        error: "키워드 클러스터링에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  // ── 5. Stamp each KeywordAxis with a stable UUID → Axis[] ─────────────────
  // clusterKeywords() returns { label, keywords }[] without stable ids.
  // createAxis stamps a UUID and marks _source: "system".
  const axes = rawAxes.map((ka) => createAxis(ka.label, ka.keywords, "system"));

  console.info(
    `[resume/cluster-keywords] Clustered ${allKws.length} keywords → ${axes.length} axes`
  );

  return c.json({ ok: true, axes });
});

// ─── POST /api/resume/axes/:id/split ──────────────────────────────────────────

/**
 * Split a display axis into two new axes by partitioning its keywords.
 *
 * The original axis is removed and replaced in its position by two new axes
 * (axisA at the original slot, axisB immediately after) so that overall axis
 * ordering is preserved.
 *
 * Route parameter:
 *   :id  — UUID of the axis to split (URL-encoded)
 *
 * Request body (JSON):
 *   {
 *     "labelA":    string    — required; display name for the first new axis (keywords NOT in keywordsB)
 *     "labelB":    string    — required; display name for the second new axis
 *     "keywordsB": string[]  — required; subset of the original axis's keywords assigned to the second axis
 *   }
 *
 * Split semantics:
 *   - keywordsB specifies which keywords move to axisB (matched case-insensitively).
 *   - keywordsA receives all remaining keywords from the original axis.
 *   - Both resulting axes must contain at least one keyword; a split that
 *     leaves either side empty returns HTTP 400.
 *   - Unknown keywords in keywordsB (not present in the original axis) are
 *     silently ignored.
 *
 * Success response:
 *   HTTP 200  { "ok": true, "axisA": Axis, "axisB": Axis, "axes": Axis[] }
 *     axisA — newly created first axis (the remainder)
 *     axisB — newly created second axis (the selection)
 *     axes  — full updated display axis list after the split
 *
 * Error responses:
 *   HTTP 400  — missing / invalid body fields; or split produces an empty axis
 *   HTTP 404  — no resume exists, or axis id not found
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.post("/axes/:id/split", async (c) => {
  // ── 1. Parse route parameter ────────────────────────────────────────────────
  const rawId = c.req.param("id");
  const axisId = (rawId ? decodeURIComponent(rawId) : "").trim();

  if (!axisId) {
    return c.json({ ok: false, error: "id 파라미터가 필요합니다." }, 400);
  }

  // ── 2. Parse and validate request body ────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "요청 본문이 올바른 JSON 형식이 아닙니다." }, 400);
  }

  const { labelA, labelB, keywordsB } = body ?? {};

  if (typeof labelA !== "string" || !labelA.trim()) {
    return c.json(
      { ok: false, error: "labelA는 비어 있지 않은 문자열이어야 합니다." },
      400
    );
  }

  if (typeof labelB !== "string" || !labelB.trim()) {
    return c.json(
      { ok: false, error: "labelB는 비어 있지 않은 문자열이어야 합니다." },
      400
    );
  }

  if (!Array.isArray(keywordsB)) {
    return c.json(
      { ok: false, error: "keywordsB는 배열이어야 합니다." },
      400
    );
  }

  // ── 3. Load current resume ─────────────────────────────────────────────────
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes/:id/split POST] read failed:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." },
      404
    );
  }

  // ── 4. Migrate axes and apply split ──────────────────────────────────────
  const existingAxes = migrateAxes(resume.display_axes);

  let splitResult;
  try {
    splitResult = splitAxis(existingAxes, axisId, labelA, labelB, keywordsB);
  } catch (err) {
    // TypeError (invalid label) or RangeError (empty partition) → 400
    return c.json(
      { ok: false, error: err.message ?? String(err) },
      400
    );
  }

  const { axes: updatedAxes, axisA, axisB } = splitResult;

  if (!axisA || !axisB) {
    return c.json(
      { ok: false, error: `id="${axisId}" 인 표시 축을 찾을 수 없습니다.` },
      404
    );
  }

  // ── 5. Persist updated axes (dual-write: independent blob + main resume) ─────
  const splitTimestamp = new Date().toISOString();
  const splitDisplayAxesDoc = {
    schemaVersion: 1,
    generatedAt: splitTimestamp,
    axes: updatedAxes
  };

  try {
    await saveDisplayAxes(splitDisplayAxesDoc);
  } catch (err) {
    console.error("[resume/axes/:id/split POST] saveDisplayAxes failed:", err);
    return c.json(
      { ok: false, error: "축 저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  const updatedResume = {
    ...resume,
    display_axes: updatedAxes,
    _sources: {
      ...(resume._sources ?? {}),
      display_axes: "user"
    }
  };

  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/axes/:id/split POST] saveResumeData failed (non-fatal, display-axes already saved):", err);
    // Non-fatal: the dedicated blob is already updated; main doc sync can be retried later.
  }

  console.info(
    `[resume/axes/:id/split POST] Split axis id="${axisId}" → axisA="${axisA.label}" (${axisA.keywords.length}kw), axisB="${axisB.label}" (${axisB.keywords.length}kw)`
  );

  return c.json({ ok: true, axisA, axisB, axes: updatedAxes });
});
// ─── PATCH /api/resume/keywords/:id/move ─────────────────────────────────────

/**
 * Move a single keyword from one axis to another.
 *
 * The keyword to move is identified by the `:id` route parameter (URL-encoded
 * keyword text, e.g. "React%20Native").  The system supports two independent
 * axis stores — "display" axes (inside `resume/data.json`) and "keyword"
 * cluster axes (`resume/keyword-cluster-axes.json`) — selected via the
 * `axisType` body field.
 *
 * Route parameter:
 *   :id  — URL-encoded keyword text (e.g. "React%20Native" → "React Native")
 *
 * Request body (JSON):
 *   {
 *     "toAxisId":   string           — required; UUID of the destination axis
 *     "fromAxisId": string           — optional; UUID of the source axis (auto-detected when absent)
 *     "axisType":   "display"|"keyword" — optional; which axis store to operate on (default: "display")
 *   }
 *
 * Validation:
 *   - keyword (:id) must be a non-empty string after URL-decoding
 *   - toAxisId must be provided and non-empty
 *   - axisType must be "display" or "keyword" when provided
 *
 * Success response:
 *   HTTP 200  {
 *     "ok": true,
 *     "moved": boolean,           — false when keyword already in destination
 *     "keyword": string,          — actual keyword text (original casing)
 *     "fromAxisId": string|null,  — id of the source axis (null when keyword not found)
 *     "toAxisId": string,         — id of the destination axis
 *     "axes": Axis[]              — updated full axis list after the move
 *   }
 *
 * Error responses:
 *   HTTP 400  — missing/invalid parameters
 *   HTTP 404  — no resume or target axis not found
 *   HTTP 422  — keyword not found in any axis
 *   HTTP 502  — Blob read/write failure
 */
resumeRouter.patch("/keywords/:id/move", async (c) => {
  // ── 1. Parse route parameter ─────────────────────────────────────────────────
  const rawId = c.req.param("id");
  const keyword = rawId ? decodeURIComponent(rawId).trim() : "";

  if (!keyword) {
    return c.json({ ok: false, error: "keyword 파라미터가 필요합니다." }, 400);
  }

  // ── 2. Parse and validate request body ──────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON" }, 400);
  }

  const toAxisId = typeof body?.toAxisId === "string" ? body.toAxisId.trim() : "";
  if (!toAxisId) {
    return c.json({ ok: false, error: "toAxisId는 필수 필드입니다." }, 400);
  }

  const fromAxisId = typeof body?.fromAxisId === "string" ? body.fromAxisId.trim() : null;

  const axisType = body?.axisType ?? "display";
  if (axisType !== "display" && axisType !== "keyword") {
    return c.json(
      { ok: false, error: "axisType은 'display' 또는 'keyword' 이어야 합니다." },
      400
    );
  }

  // ── 3. Load appropriate axis store ───────────────────────────────────────────
  if (axisType === "display") {
    // ─── Display axes (stored inside resume/data.json) ──────────────────────
    let resume;
    try {
      resume = await readResumeData();
    } catch (err) {
      console.error("[resume/keywords/:id/move] Failed to read resume:", err);
      return c.json(
        { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
        502
      );
    }

    if (!resume) {
      return c.json({ ok: false, error: "이력서가 없습니다. 먼저 이력서를 업로드하세요." }, 404);
    }

    const existingAxes = migrateAxes(resume.display_axes);

    // ── 4a. Apply the move ─────────────────────────────────────────────────────
    const result = moveKeywordBetweenAxes(existingAxes, keyword, toAxisId, fromAxisId);

    if (result.error) {
      // Distinguish between "axis not found" (404) and "keyword not found" (422).
      const isNotFound = result.error.includes("not found");
      const status = isNotFound ? (result.error.includes("Keyword") ? 422 : 404) : 400;
      return c.json({ ok: false, error: result.error }, status);
    }

    if (!result.moved) {
      // Keyword already in destination — success but idempotent.
      console.info(
        `[resume/keywords/:id/move] Keyword "${keyword}" already in axis id="${toAxisId}" (display) — no-op`
      );
      return c.json({
        ok: true,
        moved: false,
        keyword: result.keyword,
        fromAxisId: result.fromAxisId,
        toAxisId: result.toAxisId,
        axes: existingAxes
      });
    }

    // ── 5a. Save updated resume ────────────────────────────────────────────────
    const updatedResume = {
      ...resume,
      display_axes: result.axes,
      _sources: {
        ...(resume._sources ?? {}),
        display_axes: "user"
      }
    };

    try {
      await saveResumeData(updatedResume);
    } catch (err) {
      console.error("[resume/keywords/:id/move] Failed to save resume:", err);
      return c.json(
        { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
        502
      );
    }

    console.info(
      `[resume/keywords/:id/move] Moved keyword "${result.keyword}" from axis "${result.fromAxisId}" to "${result.toAxisId}" (display)`
    );

    return c.json({
      ok: true,
      moved: true,
      keyword: result.keyword,
      fromAxisId: result.fromAxisId,
      toAxisId: result.toAxisId,
      axes: result.axes
    });
  }

  // ─── Keyword cluster axes (stored in resume/keyword-cluster-axes.json) ──────
  let axesDoc;
  try {
    axesDoc = await readKeywordClusterAxes();
  } catch (err) {
    console.error("[resume/keywords/:id/move] Failed to read keyword-cluster-axes:", err);
    return c.json(
      { ok: false, error: "키워드 클러스터 축을 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!axesDoc || !Array.isArray(axesDoc.axes) || axesDoc.axes.length === 0) {
    return c.json(
      { ok: false, error: "키워드 클러스터 축이 없습니다. 먼저 /keyword-axes 를 생성해 주세요." },
      404
    );
  }

  // ── 4b. Apply the move ───────────────────────────────────────────────────────
  const result = moveKeywordBetweenAxes(axesDoc.axes, keyword, toAxisId, fromAxisId);

  if (result.error) {
    const isNotFound = result.error.includes("not found");
    const status = isNotFound ? (result.error.includes("Keyword") ? 422 : 404) : 400;
    return c.json({ ok: false, error: result.error }, status);
  }

  if (!result.moved) {
    console.info(
      `[resume/keywords/:id/move] Keyword "${keyword}" already in axis id="${toAxisId}" (keyword) — no-op`
    );
    return c.json({
      ok: true,
      moved: false,
      keyword: result.keyword,
      fromAxisId: result.fromAxisId,
      toAxisId: result.toAxisId,
      axes: axesDoc.axes
    });
  }

  // ── 5b. Save updated keyword-cluster-axes ────────────────────────────────────
  const updatedAxesDoc = {
    ...axesDoc,
    axes: result.axes,
    updatedAt: new Date().toISOString()
  };

  try {
    await saveKeywordClusterAxes(updatedAxesDoc);
  } catch (err) {
    console.error("[resume/keywords/:id/move] Failed to save keyword-cluster-axes:", err);
    return c.json(
      { ok: false, error: "저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  console.info(
    `[resume/keywords/:id/move] Moved keyword "${result.keyword}" from axis "${result.fromAxisId}" to "${result.toAxisId}" (keyword)`
  );

  return c.json({
    ok: true,
    moved: true,
    keyword: result.keyword,
    fromAxisId: result.fromAxisId,
    toAxisId: result.toAxisId,
    axes: result.axes
  });
});

// ─── POST /api/resume/reconstruct ────────────────────────────────────────────

/**
 * Full reconstruction pipeline: bypass the extract cache and re-derive all
 * resume bullet candidates from raw work-log records stored on disk.
 *
 * Unlike the normal `POST /api/resume/generate-candidates` route — which
 * reads `readExtractCache` first and short-circuits on a cache HIT — this
 * endpoint always calls the LLM for every work-log entry found on disk.
 * Each fresh WorkLogExtract is then written back to the extract cache,
 * effectively re-hydrating it from scratch.
 *
 * Use this when:
 *   • The extract cache is known to be stale (schema change, corrupt entries)
 *   • A `resume/needs-reconstruction.json` marker has been set
 *   • The user explicitly requests a full rebuild via the UI
 *
 * Pipeline (Sub-AC 14-3):
 *   1. Load config → locate data directory
 *   2. Load current resume (for deduplication context passed to the LLM)
 *   3. Scan disk for all daily work-log JSON files (gatherWorkLogBullets)
 *   4. For EACH work-log entry, bypass readExtractCache and call
 *      extractResumeUpdatesFromWorkLog directly → WorkLogExtract
 *   5. Write each WorkLogExtract to writeExtractCache (re-hydration)
 *   6. Clear the reconstruction marker (if set)
 *   7. Return stats: { ok, total, processed, failed, skipped, dates }
 *
 * Short-circuits when:
 *   - No data directory is configured (404)
 *   - No resume has been bootstrapped yet (404)
 *   - Zero work-log entries found on disk (200 with total:0)
 *   - OpenAI is disabled via WORK_LOG_DISABLE_OPENAI=1 (200 total:0 skipped)
 *
 * Success response (200):
 *   {
 *     "ok": true,
 *     "total":     <number of work-log entries found>,
 *     "processed": <entries successfully re-extracted and cached>,
 *     "failed":    <entries where the LLM call threw>,
 *     "skipped":   <entries with invalid/missing date>,
 *     "dates":     <string[] — successfully processed dates, ascending>
 *   }
 *
 * Error responses:
 *   404 — resume not bootstrapped, or data directory not configured
 *   502 — config load failed, or work-log scan failed
 */
resumeRouter.post("/reconstruct", async (c) => {
  // ── 1. Load config → data directory ────────────────────────────────────────
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error("[resume/reconstruct] Config load failed:", err);
    return c.json(
      { ok: false, error: "설정을 로드할 수 없습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!config?.dataDir) {
    return c.json(
      { ok: false, error: "데이터 디렉토리가 설정되지 않았습니다." },
      404
    );
  }

  // ── 2. Load current resume (for LLM deduplication context) ─────────────────
  let currentResume = null;
  try {
    currentResume = await readResumeData();
  } catch (err) {
    console.warn("[resume/reconstruct] Could not read resume (non-fatal):", err.message ?? String(err));
    // Continue with null — fullReconstructExtractCache handles null gracefully.
  }

  if (!currentResume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 PDF를 업로드해 주세요." },
      404
    );
  }

  // ── 3. Gather all work-log entries from disk ────────────────────────────────
  let workLogEntries;
  try {
    workLogEntries = await gatherWorkLogBullets(config.dataDir);
  } catch (err) {
    console.error("[resume/reconstruct] gatherWorkLogBullets failed:", err);
    return c.json(
      { ok: false, error: "업무 로그를 읽을 수 없습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (workLogEntries.length === 0) {
    console.info("[resume/reconstruct] No work-log entries found on disk — nothing to reconstruct");
    // Clear marker even when there's nothing to process (marker may be stale).
    clearReconstructionMarker().catch(() => {});
    return c.json({ ok: true, total: 0, processed: 0, failed: 0, skipped: 0, dates: [] });
  }

  // ── 4 & 5. Full reconstruction: bypass cache, re-derive, re-hydrate ─────────
  //
  // fullReconstructExtractCache never throws — per-entry failures are captured
  // in stats.failed and logged as warnings internally.
  const stats = await fullReconstructExtractCache({
    workLogEntries,
    currentResume
  });

  // ── 6. Clear the reconstruction marker ─────────────────────────────────────
  clearReconstructionMarker().catch((err) => {
    console.warn("[resume/reconstruct] clearReconstructionMarker failed (non-fatal):", err.message ?? String(err));
  });

  console.info(
    `[resume/reconstruct] Done: total=${stats.total} processed=${stats.processed}` +
    ` failed=${stats.failed} skipped=${stats.skipped}`
  );

  // ── 7. Return stats ─────────────────────────────────────────────────────────
  return c.json({ ok: true, ...stats });
});

// ─── GET /api/resume/snapshots ────────────────────────────────────────────────

/**
 * List all resume snapshots stored in Vercel Blob, enriched with trigger
 * metadata from each snapshot's stored envelope.
 *
 * Pipeline:
 *   1. Call listSnapshots() to obtain the Blob-level index (snapshotKey, url,
 *      uploadedAt, size).
 *   2. Parallel-fetch each snapshot envelope via readSnapshotByKey() to extract
 *      snapshotAt, label, and triggeredBy fields.
 *   3. A per-item fetch failure yields null for the three metadata fields rather
 *      than aborting the entire response — the entry is still included.
 *
 * Results are sorted descending by uploadedAt (most-recent first, preserved
 * from listSnapshots()).
 *
 * Response:
 *   HTTP 200  {
 *     "ok": true,
 *     "snapshots": [
 *       {
 *         "snapshotKey":  "resume/snapshots/2026-03-27T12-00-00.000Z.json",
 *         "url":          "https://...",
 *         "uploadedAt":   "2026-03-27T12:00:00.000Z",
 *         "size":         12345,
 *         "snapshotAt":   "2026-03-27T12:00:00.000Z",
 *         "label":        "pre-approve",
 *         "triggeredBy":  "approve"
 *       },
 *       ...
 *     ]
 *   }
 *
 * Response when Blob list call fails:
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }
 */
resumeRouter.get("/snapshots", async (c) => {
  try {
    const basic = await listSnapshots();

    // Enrich each entry with trigger metadata from its stored envelope.
    // Fetches are parallelised; a per-item fetch failure yields null metadata
    // fields rather than failing the whole request.
    const snapshots = await Promise.all(
      basic.map(async (entry) => {
        try {
          const envelope = await readSnapshotByKey(entry.snapshotKey);
          return {
            snapshotKey:  entry.snapshotKey,
            url:          entry.url,
            uploadedAt:   entry.uploadedAt,
            size:         entry.size,
            snapshotAt:   envelope?.snapshotAt  ?? null,
            label:        envelope?.label       ?? null,
            triggeredBy:  envelope?.triggeredBy ?? null
          };
        } catch {
          // Non-fatal: preserve the Blob-level entry even if the envelope is
          // unreadable (e.g. temporary network error).
          return {
            snapshotKey:  entry.snapshotKey,
            url:          entry.url,
            uploadedAt:   entry.uploadedAt,
            size:         entry.size,
            snapshotAt:   null,
            label:        null,
            triggeredBy:  null
          };
        }
      })
    );

    return c.json({ ok: true, snapshots });
  } catch (err) {
    console.error("[resume/snapshots] listSnapshots failed:", err);
    return c.json(
      {
        ok: false,
        error: "스냅샷 목록을 불러오지 못했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }
});

// ─── POST /api/resume/rollback ────────────────────────────────────────────────

/**
 * Restore the living-resume document to a prior point-in-time snapshot.
 *
 * Request body (JSON):
 *   { "snapshotKey": "resume/snapshots/2025-03-27T12-00-00.000Z.json" }
 *
 * Pipeline:
 *   1. Validate snapshotKey is non-empty and scoped to the SNAPSHOTS_PREFIX
 *      namespace (prevents path traversal / restoring arbitrary Blob keys).
 *   2. Fetch the snapshot envelope from Vercel Blob via readSnapshotByKey().
 *   3. Extract the nested `resume` document from the envelope.
 *   4. Save a "pre-rollback" safety snapshot of the *current* resume state so
 *      the rollback itself is reversible (best-effort, non-blocking).
 *   5. Overwrite resume/data.json with the restored document via saveResumeData().
 *   6. Return the restored resume and both snapshot keys.
 *
 * Response (success):
 *   HTTP 200 {
 *     "ok": true,
 *     "restoredFrom": "resume/snapshots/...",
 *     "preRollbackSnapshotKey": "resume/snapshots/..." | null,
 *     "rollbackSnapshotKey":    "resume/snapshots/..." | null,
 *     "resume": { ...restoredDocument }
 *   }
 *
 * Error responses:
 *   HTTP 400  { "ok": false, "error": "snapshotKey 누락 또는 빈 값" }
 *   HTTP 400  { "ok": false, "error": "유효하지 않은 snapshotKey 형식. ..." }
 *   HTTP 404  { "ok": false, "error": "스냅샷을 찾을 수 없습니다: ..." }
 *   HTTP 422  { "ok": false, "error": "스냅샷 형식 오류: resume 필드가 없거나 유효하지 않습니다" }
 *   HTTP 502  { "ok": false, "error": "스냅샷 읽기 실패: ..." }
 *   HTTP 502  { "ok": false, "error": "이력서 복원 저장 실패: ..." }
 */
resumeRouter.post("/rollback", async (c) => {
  // ── 1. Parse and validate request body ────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "요청 본문이 유효한 JSON이 아닙니다" }, 400);
  }

  const { snapshotKey } = body ?? {};

  if (!snapshotKey || typeof snapshotKey !== "string" || !snapshotKey.trim()) {
    return c.json({ ok: false, error: "snapshotKey 누락 또는 빈 값" }, 400);
  }

  // ── 2. Security: scope check — key must be under the snapshots prefix ─────
  // Prevents callers from pointing the rollback at arbitrary Blob pathnames
  // (e.g. "resume/data.json" or a traversal attempt).
  if (!snapshotKey.startsWith(SNAPSHOTS_PREFIX) || !snapshotKey.endsWith(".json")) {
    return c.json(
      {
        ok: false,
        error:
          `유효하지 않은 snapshotKey 형식. ` +
          `snapshotKey는 '${SNAPSHOTS_PREFIX}'로 시작하고 '.json'으로 끝나야 합니다.`
      },
      400
    );
  }

  // ── 3. Fetch the target snapshot from Vercel Blob ─────────────────────────
  let snapshotEnvelope;
  try {
    snapshotEnvelope = await readSnapshotByKey(snapshotKey);
  } catch (err) {
    console.error("[resume/rollback] readSnapshotByKey failed:", err);
    return c.json(
      { ok: false, error: "스냅샷 읽기 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  if (!snapshotEnvelope) {
    return c.json({ ok: false, error: `스냅샷을 찾을 수 없습니다: ${snapshotKey}` }, 404);
  }

  // ── 4. Extract the resume document from the snapshot envelope ─────────────
  const restoredResume = snapshotEnvelope.resume;
  if (!restoredResume || typeof restoredResume !== "object") {
    return c.json(
      { ok: false, error: "스냅샷 형식 오류: resume 필드가 없거나 유효하지 않습니다" },
      422
    );
  }

  // ── 5. Save a pre-rollback safety snapshot of the current state ───────────
  //   Best-effort: a failure here must NOT block the rollback from proceeding.
  let preRollbackSnapshotKey = null;
  try {
    const currentResume = await readResumeData();
    if (currentResume) {
      const backup = await saveSnapshot(currentResume, {
        label: "pre-rollback",
        triggeredBy: "rollback"
      });
      preRollbackSnapshotKey = backup.snapshotKey;
      console.info(
        `[resume/rollback] Pre-rollback safety snapshot saved: ${preRollbackSnapshotKey}`
      );
    }
  } catch (backupErr) {
    console.warn(
      "[resume/rollback] Pre-rollback snapshot failed (non-fatal):",
      backupErr.message ?? String(backupErr)
    );
  }

  // ── 6. Overwrite current resume with the restored document ────────────────
  try {
    await saveResumeData(restoredResume);
  } catch (err) {
    console.error("[resume/rollback] saveResumeData failed:", err);
    return c.json(
      { ok: false, error: "이력서 복원 저장 실패: " + (err.message ?? String(err)) },
      502
    );
  }

  // ── 7. Save the restored result as a new snapshot (trigger='rollback') ────
  //   Best-effort: a failure here must NOT block the response.
  let rollbackSnapshotKey = null;
  try {
    const snap = await saveSnapshot(restoredResume, {
      label: "rollback",
      triggeredBy: "rollback"
    });
    rollbackSnapshotKey = snap.snapshotKey;
    console.info(
      `[resume/rollback] Post-rollback snapshot saved: ${rollbackSnapshotKey}`
    );
  } catch (snapErr) {
    console.warn(
      "[resume/rollback] Post-rollback snapshot failed (non-fatal):",
      snapErr.message ?? String(snapErr)
    );
  }

  console.info(
    `[resume/rollback] Resume restored from snapshot "${snapshotKey}"` +
      (preRollbackSnapshotKey
        ? `; pre-rollback backup at "${preRollbackSnapshotKey}"`
        : " (no pre-rollback backup — resume was empty)") +
      (rollbackSnapshotKey
        ? `; rollback result snapshot at "${rollbackSnapshotKey}"`
        : " (post-rollback snapshot skipped)")
  );

  return c.json({
    ok: true,
    restoredFrom: snapshotKey,
    preRollbackSnapshotKey,
    rollbackSnapshotKey,
    resume: restoredResume
  });
});

// ─── POST /api/resume/profile-delta-trigger ──────────────────────────────────

/**
 * Trigger mergeCandidates generation based on profileDelta — the accumulated
 * drift between the current resume and the last approved snapshot.
 *
 * Indirect causality contract (Sub-AC 24b):
 *   displayAxes changes update the `display_axes` metadata field and
 *   contribute to the profileDelta without directly modifying resume content
 *   sections (experience, skills, projects, education, summary, certifications).
 *   The generate-candidates pipeline fires ONLY when the accumulated
 *   profileDelta rate reaches or exceeds DELTA_THRESHOLD (3 %), and only via
 *   this explicit trigger endpoint — never as a side-effect of axis operations.
 *
 *   The path "displayAxes → resume content" intentionally does NOT exist:
 *     • PATCH  /api/resume/axes/:id   — only updates display_axes metadata
 *     • DELETE /api/resume/axes/:id   — only removes from display_axes
 *     • POST   /api/resume/axes/merge — only unions keywords in display_axes
 *     • POST   /api/resume/axes/:id/split — only partitions display_axes
 *
 * Pipeline:
 *   1. Read current resume from Blob.
 *   2. Compute profileDelta via deltaFromLastApproved(currentResume).
 *      If no snapshot exists yet, delta cannot be established → triggered=false.
 *   3. If delta.rate < DELTA_THRESHOLD → return triggered=false, generated=0.
 *   4. If no workLog in body → return triggered=true, generated=0
 *      (threshold exceeded but no source data to generate from).
 *   5. Run standard extract → merge → diff → suggestions pipeline.
 *   6. Supersede existing pending candidates (AC 13 semantics).
 *   7. Save suggestions document, return result.
 *
 * Request body:
 *   { "date": "YYYY-MM-DD", "workLog"?: object }
 *
 * Response (triggered=false — delta below threshold or no baseline):
 *   HTTP 200  { "ok": true, "triggered": false, "delta": DeltaReport,
 *               "snapshotKey": string|null, "generated": 0, "message": string }
 *
 * Response (triggered=true — threshold exceeded, workLog present):
 *   HTTP 200  { "ok": true, "triggered": true, "delta": DeltaReport,
 *               "snapshotKey": string|null, "generated": number,
 *               "superseded": number, "suggestions": SuggestionItem[] }
 *
 * Error responses:
 *   HTTP 400  — missing or malformed date field
 *   HTTP 404  — no resume bootstrapped yet
 *   HTTP 502  — Blob read/write failure or delta computation failure
 */
resumeRouter.post("/profile-delta-trigger", async (c) => {
  // ── 1. Parse and validate request body ─────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be JSON" }, 400);
  }

  const { date, workLog } = body ?? {};

  if (!date || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json(
      { ok: false, error: "date 필드가 필요합니다 (YYYY-MM-DD 형식)" },
      400
    );
  }

  // ── 2. Load current resume ──────────────────────────────────────────────────
  let currentResume;
  try {
    currentResume = await readResumeData();
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: "이력서를 불러오지 못했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  if (!currentResume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 이력서를 생성해 주세요." },
      404
    );
  }

  // ── 3. Compute profileDelta (indirect causality gate) ───────────────────────
  //
  // profileDelta measures accumulated drift since the last approved snapshot.
  // Unlike the work-log diff gate in /generate-candidates (which checks how
  // much today's work log would change the resume), profileDelta captures the
  // total change since the last human-approved state — including displayAxes
  // reorganisations, keyword list updates, and any other edits.
  //
  // This is the "indirect" half: displayAxes operations accumulate in the delta
  // but do not fire candidate generation themselves.  Only this explicit trigger
  // endpoint converts the accumulated delta into merge candidates.
  let snapshotEnvelope = null;
  let delta;
  try {
    const result = await deltaFromLastApproved(currentResume);
    snapshotEnvelope = result.snapshot;
    delta = result.delta;
  } catch (err) {
    console.warn(
      "[resume/profile-delta-trigger] deltaFromLastApproved failed:",
      err.message ?? String(err)
    );
    return c.json(
      {
        ok: false,
        error: "프로필 델타 계산에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  const snapshotKey = snapshotEnvelope?.snapshotKey ?? null;
  const pct = (delta.rate * 100).toFixed(2);

  // ── 3a. No baseline snapshot → cannot establish profileDelta ────────────────
  if (!snapshotEnvelope) {
    console.info(
      "[resume/profile-delta-trigger] No baseline snapshot exists — cannot compute profileDelta, skipping"
    );
    return c.json({
      ok: true,
      triggered: false,
      delta,
      snapshotKey: null,
      generated: 0,
      message:
        "비교 기준이 되는 승인된 스냅샷이 없습니다. 한 번 이상 제안을 승인하면 profileDelta가 활성화됩니다."
    });
  }

  // ── 3b. Below threshold → skip candidate generation ─────────────────────────
  if (delta.rate < DELTA_THRESHOLD) {
    console.info(
      `[resume/profile-delta-trigger] profileDelta ${pct}% < ` +
        `${(DELTA_THRESHOLD * 100).toFixed(0)}% threshold — skipping`
    );
    return c.json({
      ok: true,
      triggered: false,
      delta,
      snapshotKey,
      generated: 0,
      message: `profileDelta(${pct}%)가 임계치(${(DELTA_THRESHOLD * 100).toFixed(0)}%) 미만으로 후보를 생성하지 않습니다.`
    });
  }

  console.info(
    `[resume/profile-delta-trigger] profileDelta ${pct}% ≥ ` +
      `${(DELTA_THRESHOLD * 100).toFixed(0)}% — candidate generation triggered` +
      ` (changedUnits=${delta.changedUnits}, totalUnits=${delta.totalUnits})`
  );

  // ── 4. No workLog in body → threshold exceeded but no generation source ─────
  if (!workLog || typeof workLog !== "object") {
    return c.json({
      ok: true,
      triggered: true,
      delta,
      snapshotKey,
      generated: 0,
      message: `profileDelta(${pct}%) 임계치 초과 — workLog 데이터를 제공하면 후보를 생성합니다.`
    });
  }

  // ── 5. Run the standard candidate generation pipeline ──────────────────────
  //   Mirrors POST /api/resume/generate-candidates but the TRIGGER is the
  //   profileDelta rate, not the work-log diff delta.
  let extract;
  try {
    const cached = await readExtractCache(date);
    if (cached !== null) {
      extract = cached;
    } else {
      extract = await extractResumeUpdatesFromWorkLog(workLog, currentResume);
      writeExtractCache(date, extract).catch(() => {});
    }
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: "LLM 추출 중 오류가 발생했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  const proposedResume = mergeWorkLogIntoResume(currentResume, extract);
  const diff = diffResume(currentResume, proposedResume);

  if (diff.isEmpty) {
    return c.json({
      ok: true,
      triggered: true,
      delta,
      snapshotKey,
      generated: 0,
      message:
        "profileDelta 임계치를 초과했지만 오늘 업무 로그에서 새로운 변경사항을 찾지 못했습니다."
    });
  }

  const rawSuggestions = diffToSuggestions(diff, date);

  if (rawSuggestions.length === 0) {
    return c.json({
      ok: true,
      triggered: true,
      delta,
      snapshotKey,
      generated: 0,
      message: "변경 사항을 제안으로 변환할 수 없습니다."
    });
  }

  // ── 6. Supersede existing pending candidates (AC 13 semantics) ─────────────
  let suggestionsDoc;
  try {
    suggestionsDoc = await readSuggestionsData();
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: "기존 제안 목록을 불러오지 못했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
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

  // ── 7. Save updated suggestions document ────────────────────────────────────
  const updatedDoc = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    suggestions: [...supersededSuggestions, ...rawSuggestions]
  };

  try {
    await saveSuggestionsData(updatedDoc);
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: "제안 저장에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }

  console.info(
    `[resume/profile-delta-trigger] Generated ${rawSuggestions.length} candidate(s)` +
      (pendingToDiscard.length > 0
        ? ` (${pendingToDiscard.length} previous pending superseded)`
        : "") +
      ` via profileDelta trigger [rate=${pct}%]`
  );

  return c.json({
    ok: true,
    triggered: true,
    delta,
    snapshotKey,
    generated: rawSuggestions.length,
    superseded: pendingToDiscard.length,
    suggestions: rawSuggestions
  });
});
