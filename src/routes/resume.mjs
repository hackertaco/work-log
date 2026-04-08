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
 *   GET  /api/resume/coverage-analysis             — analyze data source coverage per resume item, detect insufficient items (Sub-AC 9-1)
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
 *   PATCH  /api/resume/section                               — apply chat diff approval to a resume section (Sub-AC 6-2)
 *   PATCH  /api/resume/json-diff-apply                      — apply full resume JSON diff (all sections) approved in chat (Sub-AC 5-3)
 *   PATCH  /api/resume/items                                — unified bullet add/update/delete (op field); source=user, bypasses mergeCandidates
 *   PATCH  /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex — edit a single bullet text (marks _source:'user')
 *   DELETE /api/resume/sections/:section/:itemIndex/bullets/:bulletIndex — delete a single bullet (marks _source:'user')
 *   GET    /api/resume/snapshots                              — list all point-in-time snapshots (most-recent first)
 *   POST   /api/resume/rollback                              — restore resume to a prior snapshot identified by snapshotKey
 *   POST   /api/resume/reconstruct                           — bypass extract cache; re-derive all bullets from raw work-log records and re-hydrate extract cache
 *   POST   /api/resume/profile-delta-trigger               — check profileDelta vs last approved snapshot; trigger candidate generation when delta ≥ 3% (indirect causality)
 *   GET    /api/resume/quality-report                      — aggregate bullet quality tracking report (similarity scores, usability rate)
 *   GET    /api/resume/quality-tracking                    — raw quality tracking history (individual records, paginated)
 *   POST   /api/resume/quality-tracking/rescore            — batch retroactive scoring of approved suggestions for quality bootstrapping
 *   GET    /api/resume/identified-strengths                — list identified behavioral strengths (cross-repo, evidence-backed)
 *   GET    /api/resume/narrative-axes                      — list narrative axes (career themes)
 *   GET    /api/resume/narrative-threading                 — bullet-level threading annotations (strengths↔axes↔episodes)
 *   POST   /api/resume/narrative-threading/run             — run full narrative threading pipeline (episodes→strengths→axes→threading)
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
  readPdfText,
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
  clearReconstructionMarker,
  saveIdentifiedStrengths,
  readIdentifiedStrengths,
  saveNarrativeAxes,
  readNarrativeAxes,
  saveNarrativeThreading,
  readNarrativeThreading,
  saveSectionBridges,
  readSectionBridges,
  saveChatDraft,
  readChatDraft,
  saveChatDraftContext,
  readChatDraftContext
} from "../lib/blob.mjs";
import {
  mergeKeywords,
  removeKeyword,
  replaceKeywords,
  extractKeywordsArray,
  initStrengthKeywordsFromBootstrap
} from "../lib/resumeStrengthKeywords.mjs";
import { loadConfig } from "../lib/config.mjs";
import { searchAllSources, searchWithAnalyzedQuery } from "../lib/resumeEvidenceSearch.mjs";
// AC 3 Sub-AC 2: 쿼리 분석 기반 멀티소스 탐색 (priority·sourceMeta·followUpQuestion 지원)
import { exploreWithQueryAnalysis, exploreWithKeywords } from "../lib/resumeChatExplore.mjs";
import { extractTextFromBuffer } from "../lib/pdfExtract.mjs";
import { generateResumeFromText } from "../lib/resumeBootstrap.mjs";
import {
  gatherWorkLogBullets,
  fullReconstructExtractCache,
  reconstructResumeFromSources,
  mergeWithUserEdits,
  runNarrativeThreadingPipeline,
  generateSectionBridges,
  validateResumeCoherence,
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
import { compressWorkLogSuggestions } from "../lib/resumeSuggestionCompression.mjs";
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
import { getUnclassifiedKeywords } from "../lib/resumeKeywordCoverage.mjs";
import {
  applyBulletProposal,
  isBulletProposal
} from "../lib/resumeBulletProposal.mjs";
import { deltaFromLastApproved } from "../lib/resumeSnapshotDelta.mjs";
import {
  trackBulletEdit,
  trackBulletEditBatch,
  classifyEditDistance,
  computeBulletSimilarity,
  loadQualityHistory,
  computeQualityReportFromHistory,
  scoreGeneratedVsFinalBatch,
  persistTrackingRecords,
  createTrackingRecordOffline,
} from "../lib/resumeBulletSimilarity.mjs";
import { generateResumeDraft, loadWorkLogs } from "../lib/resumeDraftGeneration.mjs";
import {
  getDraftGenerationState,
  markDraftGenerationPending,
  markDraftGenerationCompleted,
  markDraftGenerationFailed,
  updateDraftGenerationProgress,
  isDraftGenerationInProgress,
  resetDraftGenerationState,
} from "../lib/draftGenerationState.mjs";
import {
  buildChatDraftContext,
  refineSectionWithChat,
  searchEvidenceByKeywords,
  extractDraftContentForSection,
} from "../lib/resumeChatDraftService.mjs";
import {
  mergeAndRankEvidence,
  buildEvidenceContext,
  generateAppealPoints,
} from "../lib/resumeAppealPoints.mjs";
import { parseApplyIntent } from "../lib/resumeChatApplyIntent.mjs";
// Sub-AC 3-3: 클러스터 기반 어필 포인트 제안 생성
import { generateSuggestions, formatSuggestionMessage } from "../lib/resumeChatSuggest.mjs";
import { applyChatChangesToResume } from "../lib/resumeChatApplySections.mjs";
// AC 5 Sub-AC 2: 대화 컨텍스트 기반 이력서 섹션 수정 JSON 생성
import { generateModifiedResume } from "../lib/resumeChatSectionModifier.mjs";
// Sub-AC 4-2: 채팅 응답에 출처 정보(citations) 첨부
import {
  buildChatCitations,
  buildCitationFromEvidence,
  buildCitationsFromEvidenceResult,
  buildSourceSummary,
} from "../lib/resumeChatCitations.mjs";
// Sub-AC 8-1: 자기소개·강점 섹션 전용 채팅 diff 생성
import { generateSummaryChatDiff } from "../lib/resumeSummarySectionChat.mjs";
import { generateStrengthsChatDiff, formatStrengthsAsText } from "../lib/resumeStrengthsSectionChat.mjs";
// Sub-AC 9-1: 데이터 소스 커버리지 분석
import {
  buildSignalCorpus,
  analyzeDataSourceCoverage,
} from "../lib/resumeDataSourceCoverage.mjs";
// Sub-AC 9-2: 부족한 항목 보충 질문 생성
import {
  generateFollowUpQuestions,
  buildCoverageNoticeMessage,
} from "../lib/resumeInsufficientItemQuestions.mjs";
// AC 3 Sub-AC 1: 서버 사이드 쿼리 분석 (의도·키워드·기술스택·소스별 파라미터)
import {
  analyzeQuery,
  analyzeQueryWithLLM,
  toSearchQuery,
} from "../lib/resumeQueryAnalyzer.mjs";
// AC 3 Sub-AC 3: 통합 추천 엔진 (탐색 결과 → 어필 포인트 제안)
import {
  generateRecommendations,
  formatRecommendations,
} from "../lib/resumeChatRecommendEngine.mjs";
import { agentRouter } from "./resume.agent.mjs";

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

function describePdfExtractionFailure(err) {
  const detail = err?.message ?? String(err);
  const normalized = String(detail).toLowerCase();

  if (normalized.includes("pdf magic bytes")) {
    return {
      error: "유효한 PDF 파일이 아닙니다.",
      detail
    };
  }

  if (
    normalized.includes("password") ||
    normalized.includes("encrypted") ||
    normalized.includes("encryption")
  ) {
    return {
      error: "비밀번호가 걸렸거나 보호된 PDF는 처리할 수 없습니다.",
      detail
    };
  }

  return {
    error: "PDF 텍스트를 추출하지 못했습니다. PDF 생성 방식이나 파일 구조 때문에 파싱에 실패했을 수 있습니다.",
    detail
  };
}

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
    pdfText = await extractTextFromBuffer(pdfBuffer);
  } catch (err) {
    console.error("[resume/bootstrap] PDF text extraction failed:", err);
    const { error, detail } = describePdfExtractionFailure(err);
    return c.json(
      { error, detail },
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

// ─── GET /api/resume/coverage-analysis ───────────────────────────────────────

/**
 * 데이터 소스(커밋/슬랙/세션) 기반 이력서 항목 정보 충족도 분석 (Sub-AC 9-1).
 *
 * 로직:
 *   1. Vercel Blob에서 현재 이력서 로드
 *   2. data/daily/*.json 업무 로그 로드 (날짜 범위 파라미터 지원)
 *   3. 커밋/세션/슬랙 신호를 합산한 신호 코퍼스 구축
 *   4. 이력서 항목별 키워드 매칭으로 충족도 점수 산출
 *   5. 부족 항목(score < 0.2) 감지 및 반환
 *
 * 쿼리 파라미터 (모두 선택):
 *   from_date  — 업무 로그 시작 날짜 (YYYY-MM-DD); 기본: 90일 전
 *   to_date    — 업무 로그 종료 날짜 (YYYY-MM-DD); 기본: 오늘
 *
 * 응답 (200):
 *   {
 *     ok: true,
 *     experience:             ExperienceCoverageItem[],
 *     skills:                 { technical, languages, tools }[],
 *     summary:                { score, level, isInsufficient },
 *     insufficientItems:      InsufficientItem[],
 *     coverageSummary:        CoverageSummary,
 *     followUpQuestions:      FollowUpQuestion[],     — (Sub-AC 9-2) 부족 항목 보충 질문 목록
 *     coverageNoticeMessage:  string|null,            — (Sub-AC 9-2) 채팅에 표시할 안내 메시지
 *     meta: {
 *       workLogCount:         number,    — 분석에 사용된 업무 로그 날짜 수
 *       fromDate:             string,    — 실제 분석 시작 날짜
 *       toDate:               string,    — 실제 분석 종료 날짜
 *       corpusLength:         number     — 신호 코퍼스 문자 수
 *     }
 *   }
 *
 * 오류 응답:
 *   HTTP 404  { "ok": false, "error": "이력서가 없습니다" }
 *   HTTP 400  { "ok": false, "error": "잘못된 날짜 형식" }
 *   HTTP 502  { "ok": false, "error": "...", "detail": "..." }
 */
resumeRouter.get("/coverage-analysis", async (c) => {
  // ── 1. 날짜 파라미터 파싱 및 검증 ──────────────────────────────────────────
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const rawFrom = c.req.query("from_date");
  const rawTo   = c.req.query("to_date");

  if (rawFrom && !dateRe.test(rawFrom)) {
    return c.json({ ok: false, error: "잘못된 from_date 형식 — YYYY-MM-DD 형식이어야 합니다" }, 400);
  }
  if (rawTo && !dateRe.test(rawTo)) {
    return c.json({ ok: false, error: "잘못된 to_date 형식 — YYYY-MM-DD 형식이어야 합니다" }, 400);
  }

  const today  = new Date().toISOString().slice(0, 10);
  const toDate = rawTo ?? today;

  // 기본 90일 분석 범위
  const defaultFrom = new Date(new Date(toDate).getTime() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const fromDate = rawFrom ?? defaultFrom;

  // ── 2. 이력서 로드 ─────────────────────────────────────────────────────────
  let resumeDoc;
  try {
    resumeDoc = await readResumeData();
  } catch (err) {
    console.error("[resume/coverage-analysis] Failed to read resume:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  if (!resumeDoc) {
    return c.json({ ok: false, error: "이력서가 없습니다. 먼저 이력서를 등록해 주세요." }, 404);
  }

  // ── 3. 업무 로그 로드 ──────────────────────────────────────────────────────
  let workLogs;
  try {
    workLogs = await loadWorkLogs({ fromDate, toDate });
  } catch (err) {
    console.error("[resume/coverage-analysis] Failed to load work logs:", err);
    workLogs = [];
  }

  // ── 4. 신호 코퍼스 구축 ────────────────────────────────────────────────────
  const corpus = buildSignalCorpus(workLogs);

  // ── 5. 충족도 분석 ─────────────────────────────────────────────────────────
  const {
    experience,
    skills,
    summary,
    insufficientItems,
    coverageSummary,
  } = analyzeDataSourceCoverage(resumeDoc, corpus);

  // ── 6. 부족 항목 보충 질문 생성 (Sub-AC 9-2) ─────────────────────────────────
  const followUpQuestions = generateFollowUpQuestions(insufficientItems);
  const coverageNoticeMessage = buildCoverageNoticeMessage(followUpQuestions, {
    coverageRatio: coverageSummary.coverageRatio,
    insufficientCount: coverageSummary.insufficientCount,
  });

  console.info(
    `[resume/coverage-analysis]` +
      ` workLogs=${workLogs.length}` +
      ` totalItems=${coverageSummary.totalItems}` +
      ` insufficientCount=${coverageSummary.insufficientCount}` +
      ` coverageRatio=${(coverageSummary.coverageRatio * 100).toFixed(1)}%` +
      ` avgScore=${(coverageSummary.avgScore * 100).toFixed(1)}%` +
      ` followUpQuestions=${followUpQuestions.length}`
  );

  return c.json({
    ok: true,
    experience,
    skills,
    summary,
    insufficientItems,
    coverageSummary,
    followUpQuestions,
    coverageNoticeMessage,
    meta: {
      workLogCount: workLogs.length,
      fromDate,
      toDate,
      corpusLength: corpus.length,
    },
  });
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
  const compressedSuggestions = compressWorkLogSuggestions(rawSuggestions);

  if (compressedSuggestions.length === 0) {
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
    suggestions: [...supersededSuggestions, ...compressedSuggestions]
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
    `[resume/generate-candidates] Generated ${compressedSuggestions.length} new candidate(s) for date="${date}"` +
      ` (raw=${rawSuggestions.length})` +
      (pendingToDiscard.length > 0
        ? ` (${pendingToDiscard.length} previous pending superseded)`
        : "")
  );

  return c.json({
    ok: true,
    generated: compressedSuggestions.length,
    superseded: pendingToDiscard.length,
    deltaRatio: deltaMetrics.ratio,
    deltaChangedCount: deltaMetrics.changedCount,
    deltaTotalCount: deltaMetrics.totalCount,
    suggestions: compressedSuggestions
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

  // ── Quality tracking (fire-and-forget) ────────────────────────────────────
  // Track bullet quality for suggestions that contain bullet text.
  // Non-blocking: errors are logged but never fail the approval response.
  _trackSuggestionQuality(suggestion, "approved").catch((err) =>
    console.warn("[resume/suggestions/approve] quality tracking failed (non-fatal):", err)
  );

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

  // ── Quality tracking (fire-and-forget) ────────────────────────────────────
  _trackSuggestionQuality(suggestion, "discarded").catch((err) =>
    console.warn("[resume/suggestions/reject] quality tracking failed (non-fatal):", err)
  );

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
    // Preserve the user-edited text for downstream quality tracking.
    // When this suggestion is later approved, _trackSuggestionQuality will use
    // _editedText as the "final" version (vs the original generated text).
    if (typeof payload.text === "string" && payload.text.trim()) {
      updated._editedText = payload.text.trim();
    }
  }

  // Legacy SuggestionItem: capture edited bullet text for quality tracking.
  if (patch !== undefined && typeof patch === "object" && patch !== null) {
    if (typeof patch.bullet === "string" && patch.bullet.trim()) {
      updated._editedText = patch.bullet.trim();
    } else if (typeof patch.text === "string" && patch.text.trim()) {
      updated._editedText = patch.text.trim();
    }
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

    // ── Quality tracking (fire-and-forget) ──────────────────────────────────
    _trackSuggestionQuality(candidate, "approved").catch((err) =>
      console.warn("[resume/candidates/patch] quality tracking failed (non-fatal):", err)
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

  // ── Quality tracking for discarded bullets (fire-and-forget) ──────────────
  _trackSuggestionQuality(candidate, "discarded").catch((err) =>
    console.warn("[resume/candidates/patch] quality tracking (discard) failed (non-fatal):", err)
  );

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

  // ── Quality tracking (fire-and-forget) ────────────────────────────────────
  // Track the similarity between the original daily bullet and the user-edited
  // version.  Daily bullets are system-generated, so any text change is a
  // meaningful quality signal.
  const originalBullet = bulletDoc.bullets.find((b) => b.id === bulletId);
  if (originalBullet && originalBullet.text && originalBullet.text !== newText) {
    trackBulletEdit({
      generatedText: originalBullet.text,
      finalText: newText,
      action: "edited",
      section: originalBullet.suggestedSection ?? "experience",
      logDate: date,
      useEmbeddings: false, // offline scoring in hot path
    }).catch((err) =>
      console.warn(`[resume/daily-bullets/${date}/${bulletId}] quality tracking failed (non-fatal):`, err)
    );
  }

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

// ─── POST /api/resume/axes/manual ────────────────────────────────────────────

resumeRouter.post("/axes/manual", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Request body must be valid JSON" }, 400);
  }

  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const keywords = Array.isArray(body?.keywords) ? body.keywords : [];

  if (!label) {
    return c.json({ ok: false, error: "label 필드가 필요합니다." }, 400);
  }

  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/axes/manual] Failed to read resume:", err);
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

  let axis;
  try {
    axis = createAxis(label, keywords, "user");
  } catch (err) {
    return c.json({ ok: false, error: err.message ?? String(err) }, 400);
  }

  const existingAxes = migrateAxes(resume.display_axes);
  const updatedAxes = [...existingAxes, axis];
  const generatedAt = new Date().toISOString();

  try {
    await saveDisplayAxes({
      schemaVersion: 1,
      generatedAt,
      axes: updatedAxes
    });
  } catch (err) {
    console.error("[resume/axes/manual] Failed to save display axes:", err);
    return c.json(
      { ok: false, error: "축 저장에 실패했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  try {
    await saveResumeData({
      ...resume,
      display_axes: updatedAxes,
      _sources: {
        ...(resume._sources ?? {}),
        display_axes: "user"
      }
    });
  } catch (err) {
    console.error("[resume/axes/manual] Failed to save updated resume:", err);
    return c.json(
      { ok: false, error: "이력서 저장에 실패했습니다.", detail: err.message ?? String(err) },
      502
    );
  }

  return c.json({ ok: true, axis, axes: updatedAxes }, 201);
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
 *     "unclassifiedKeywords": string[],
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
  const unclassifiedKeywords = getUnclassifiedKeywords(allKeywordsCased, existingAxes);

  console.info(
    `[resume/axes/staleness] ratio=${ratio.toFixed(3)} total=${totalKeywords}` +
    ` unclassified=${unclassifiedCount}`
  );

  return c.json({
    ratio,
    totalKeywords,
    unclassifiedCount,
    unclassifiedKeywords,
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
  // Capture the original bullet text before mutation for quality tracking.
  let originalBulletText = null;
  if (op === "add") {
    bullets.push(trimmedText);
  } else if (op === "update") {
    if (bulletIndex >= bullets.length) {
      return c.json(
        { ok: false, error: `bullets[${bulletIndex}]이 없습니다. (총 ${bullets.length}개)` },
        404
      );
    }
    originalBulletText = bullets[bulletIndex];
    bullets[bulletIndex] = trimmedText;
  } else {
    // delete
    if (bulletIndex >= bullets.length) {
      return c.json(
        { ok: false, error: `bullets[${bulletIndex}]이 없습니다. (총 ${bullets.length}개)` },
        404
      );
    }
    originalBulletText = bullets[bulletIndex];
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

  // ── 12. Quality tracking (with inline similarity score) ─────────────────
  // Track similarity between original and edited/deleted bullet text.
  // Compute offline similarity synchronously for immediate response feedback.
  let similarityScore = null;
  if (originalBulletText) {
    const trackAction = op === "delete" ? "discarded" : "edited";
    const trackFinal = op === "delete" ? originalBulletText : trimmedText;
    if (originalBulletText !== trackFinal || trackAction === "discarded") {
      // Compute inline similarity for response
      if (op !== "delete") {
        const scoreResult = computeBulletSimilarity(originalBulletText, trackFinal);
        similarityScore = {
          similarity: scoreResult.similarity,
          modificationDistance: scoreResult.modificationDistance,
          isUsable: scoreResult.isUsable,
          bucket: classifyEditDistance(scoreResult.similarity),
          metrics: scoreResult.metrics,
        };
      }

      // Persist tracking record asynchronously (non-blocking)
      trackBulletEdit({
        generatedText: originalBulletText,
        finalText: trackFinal,
        action: trackAction,
        section,
        logDate: null,
        useEmbeddings: false, // offline scoring in hot path
      }).catch((err) =>
        console.warn("[resume/items PATCH] quality tracking failed (non-fatal):", err)
      );
    }
  }

  return c.json({ ok: true, resume: updatedResume, similarityScore });
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

  // ── 5. Per-bullet quality tracking (fire-and-forget) ────────────────────
  // When a user edits the full resume, compare old vs new bullets for each
  // experience and project item.  This tracks per-bullet similarity so the
  // quality metric captures edits made through the full-document editor.
  _trackFullResumeEditBullets(stored, updated).catch((err) =>
    console.warn("[resume PATCH] bullet quality tracking failed (non-fatal):", err)
  );

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

    const originalText = bullets[bulletIndex];
    const editedText = body.text.trim();
    bullets[bulletIndex] = editedText;

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

    // ── Quality tracking (fire-and-forget with inline score) ─────────────────
    // Track the similarity between old bullet and user-edited version.
    // Compute inline similarity score synchronously (offline — no API call) so
    // it can be included in the response for immediate frontend feedback.
    let similarityScore = null;
    if (originalText && originalText !== editedText) {
      const scoreResult = computeBulletSimilarity(originalText, editedText);
      similarityScore = {
        similarity: scoreResult.similarity,
        modificationDistance: scoreResult.modificationDistance,
        isUsable: scoreResult.isUsable,
        bucket: classifyEditDistance(scoreResult.similarity),
        metrics: scoreResult.metrics,
      };

      // Persist tracking record asynchronously (non-blocking)
      trackBulletEdit({
        generatedText: originalText,
        finalText: editedText,
        action: "edited",
        section,
        logDate: null,
        useEmbeddings: false, // offline scoring in hot path
      }).catch((err) =>
        console.warn("[resume/sections PATCH] quality tracking failed (non-fatal):", err)
      );
    }

    return c.json({ ok: true, resume: updatedResume, similarityScore });
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

    // ── Quality tracking for deleted bullets (fire-and-forget) ──────────────
    // Track that the user removed a bullet — the original text is compared
    // against itself (similarity = 1.0) with action "discarded" so we can
    // measure which system-generated bullets users choose to delete.
    const deletedBulletText = item.bullets[bulletIndex];
    if (deletedBulletText && typeof deletedBulletText === "string") {
      trackBulletEdit({
        generatedText: deletedBulletText,
        finalText: deletedBulletText,
        action: "discarded",
        section,
        logDate: null,
        useEmbeddings: false,
      }).catch((err) =>
        console.warn("[resume/sections DELETE] quality tracking failed (non-fatal):", err)
      );
    }

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
 *   6. If original PDF text exists, reconstruct the live resume document too
 *   7. Clear the reconstruction marker (if set)
 *   8. Return stats: { ok, total, processed, failed, skipped, dates, rebuiltResume }
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

  // ── 6. Rebuild the live resume document when PDF text is available ─────────
  let rebuiltResume = false;
  try {
    const pdfText = await readPdfText();
    if (pdfText && pdfText.trim()) {
      const reconstruction = await reconstructResumeFromSources({
        pdfText,
        workLogEntries,
        currentResume
      });
      const mergedResume = mergeWithUserEdits(currentResume, reconstruction);
      await saveResumeData(mergedResume);
      rebuiltResume = true;
    }
  } catch (err) {
    console.warn(
      "[resume/reconstruct] Resume document rebuild failed (non-fatal):",
      err.message ?? String(err)
    );
  }

  // ── 7. Clear the reconstruction marker ─────────────────────────────────────
  clearReconstructionMarker().catch((err) => {
    console.warn("[resume/reconstruct] clearReconstructionMarker failed (non-fatal):", err.message ?? String(err));
  });

  console.info(
    `[resume/reconstruct] Done: total=${stats.total} processed=${stats.processed}` +
    ` failed=${stats.failed} skipped=${stats.skipped}`
  );

  // ── 8. Return stats ─────────────────────────────────────────────────────────
  return c.json({ ok: true, rebuiltResume, ...stats });
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

// ─── GET /api/resume/quality-report ─────────────────────────────────────────

/**
 * Return the bullet quality tracking report.
 *
 * Aggregates historical bullet edit quality data (similarity scores between
 * system-generated bullets and user-final versions).  Supports optional
 * query filters:
 *   - ?days=30        — restrict to the last 30 days
 *   - ?section=experience — filter by resume section
 *   - ?action=approved   — filter by action (approved/edited/discarded)
 *
 * Response:
 *   HTTP 200  { qualityReport: { ... } }
 */
resumeRouter.get("/quality-report", async (c) => {
  const daysBack = c.req.query("days") ? parseInt(c.req.query("days"), 10) : undefined;
  const section = c.req.query("section") || undefined;
  const action = c.req.query("action") || undefined;

  try {
    const history = await loadQualityHistory();
    const report = computeQualityReportFromHistory(history.records, { daysBack, section, action });
    return c.json({ ok: true, qualityReport: report });
  } catch (err) {
    console.error("[resume/quality-report] failed:", err);
    return c.json({ error: "품질 보고서를 생성하지 못했습니다.", detail: err.message ?? String(err) }, 502);
  }
});

// ─── GET /api/resume/quality-tracking ───────────────────────────────────────

/**
 * Return the raw quality tracking history (individual records).
 *
 * Useful for debugging, dashboarding, and frontend charts that need per-record
 * detail beyond the aggregate quality-report.
 *
 * Query parameters:
 *   - ?limit=50        — max records to return (default: 50, max: 200)
 *   - ?offset=0        — pagination offset (default: 0)
 *   - ?section=experience — filter by section
 *   - ?action=edited      — filter by action
 *
 * Response:
 *   HTTP 200  { ok: true, records: [...], total: number }
 */
resumeRouter.get("/quality-tracking", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const sectionFilter = c.req.query("section") || undefined;
  const actionFilter = c.req.query("action") || undefined;

  try {
    const history = await loadQualityHistory();
    let records = history.records || [];

    if (sectionFilter) {
      records = records.filter((r) => r.section === sectionFilter);
    }
    if (actionFilter) {
      records = records.filter((r) => r.action === actionFilter);
    }

    const total = records.length;
    // Return most recent first
    const page = records.slice(Math.max(0, total - offset - limit), total - offset).reverse();

    return c.json({ ok: true, records: page, total, limit, offset });
  } catch (err) {
    console.error("[resume/quality-tracking] failed:", err);
    return c.json({ error: "품질 추적 이력을 불러오지 못했습니다.", detail: err.message ?? String(err) }, 502);
  }
});

// ─── POST /api/resume/quality-tracking/rescore ──────────────────────────────

/**
 * Batch retroactive scoring: scan the current resume for bullet pairs where
 * the system-generated original is still available (via suggestion history)
 * and compute similarity scores for any that haven't been tracked yet.
 *
 * This is useful for bootstrapping quality data after the tracking system was
 * added, or re-scoring with updated metrics.
 *
 * Response:
 *   HTTP 200  { ok: true, scored: number, skipped: number, report: {...} }
 */
resumeRouter.post("/quality-tracking/rescore", async (c) => {
  try {
    // Load suggestions to find original generated texts
    const suggestionsDoc = await readSuggestionsData();
    const history = await loadQualityHistory();
    const existingIds = new Set((history.records || []).map((r) => r.id));

    // Find approved suggestions that have both generated and final text
    const approvedWithBullets = suggestionsDoc.suggestions.filter((s) => {
      if (s.status !== "approved") return false;
      // Extract generated text
      let generated = null;
      if (s.kind === "bullet" && s.payload?.text) {
        generated = s.payload.text;
      } else if (s.action === "append_bullet" && s.patch?.bullet) {
        generated = s.patch.bullet;
      }
      return generated && typeof generated === "string";
    });

    const newRecords = [];
    let skipped = 0;

    for (const s of approvedWithBullets) {
      // Extract generated text
      let generatedText = null;
      if (s.kind === "bullet" && s.payload?.text) {
        generatedText = s.payload.text;
      } else if (s.action === "append_bullet" && s.patch?.bullet) {
        generatedText = s.patch.bullet;
      }

      const finalText = s._editedText ?? generatedText;
      const section = s.section ?? "experience";

      // Create offline tracking record
      const record = createTrackingRecordOffline({
        generatedText,
        finalText,
        action: s._editedText ? "edited" : "approved",
        section,
        logDate: s.logDate ?? s.context?.logDate ?? null,
      });

      // Skip if we already have a record with the same generated+final text pair
      const isDuplicate = (history.records || []).some(
        (r) => r.generatedText === generatedText && r.finalText === finalText
      );
      if (isDuplicate) {
        skipped++;
        continue;
      }

      newRecords.push(record);
    }

    // Persist new records
    if (newRecords.length > 0) {
      await persistTrackingRecords(newRecords);
    }

    // Compute updated report
    const updatedHistory = await loadQualityHistory();
    const report = computeQualityReportFromHistory(updatedHistory.records);

    return c.json({
      ok: true,
      scored: newRecords.length,
      skipped,
      totalCandidatesScanned: approvedWithBullets.length,
      report,
    });
  } catch (err) {
    console.error("[resume/quality-tracking/rescore] failed:", err);
    return c.json({ error: "일괄 재채점에 실패했습니다.", detail: err.message ?? String(err) }, 502);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Narrative Threading Pipeline Routes
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/resume/identified-strengths ───────────────────────────────────

/**
 * Return the stored identified strengths document.
 *
 * Identified strengths are behavioral patterns backed by evidence episodes,
 * unified cross-repo (not per-repo).  Target: 3-5 strengths.
 *
 * Response:
 *   HTTP 200  { ok: true, strengths: IdentifiedStrength[], totalEpisodes, totalProjects }
 *   HTTP 404  { ok: false, error: "..." }  — no strengths identified yet
 */
resumeRouter.get("/identified-strengths", async (c) => {
  try {
    const doc = await readIdentifiedStrengths();
    if (!doc) {
      return c.json({
        ok: true,
        strengths: [],
        totalEpisodes: 0,
        totalProjects: 0,
        message: "아직 식별된 강점이 없습니다."
      });
    }
    return c.json({
      ok: true,
      strengths: doc.strengths || [],
      totalEpisodes: doc.totalEpisodes || 0,
      totalProjects: doc.totalProjects || 0,
      updatedAt: doc.updatedAt || null
    });
  } catch (err) {
    console.error("[resume/identified-strengths] failed:", err);
    return c.json(
      { ok: false, error: "강점 데이터를 불러오지 못했습니다.", detail: err.message },
      502
    );
  }
});

// ─── GET /api/resume/narrative-axes ─────────────────────────────────────────

/**
 * Return the stored narrative axes (career themes).
 *
 * Narrative axes are higher-level career trajectories synthesized from
 * cross-repo projects and identified strengths.  Target: 2-3 axes.
 *
 * Response:
 *   HTTP 200  { ok: true, axes: NarrativeAxis[], coverage, complementarity }
 */
resumeRouter.get("/narrative-axes", async (c) => {
  try {
    const doc = await readNarrativeAxes();
    if (!doc) {
      return c.json({
        ok: true,
        axes: [],
        coverage: { projectCoverage: 0, strengthCoverage: 0, overallCoverage: 0 },
        message: "아직 서사 축이 생성되지 않았습니다."
      });
    }
    return c.json({
      ok: true,
      axes: doc.axes || [],
      coverage: doc.coverage || {},
      complementarity: doc.complementarity || {},
      generatedAt: doc.generatedAt || null
    });
  } catch (err) {
    console.error("[resume/narrative-axes] failed:", err);
    return c.json(
      { ok: false, error: "서사 축 데이터를 불러오지 못했습니다.", detail: err.message },
      502
    );
  }
});

// ─── GET /api/resume/narrative-threading ────────────────────────────────────

/**
 * Return the stored narrative threading result — bullet-level annotations
 * linking resume content to strengths, axes, and evidence episodes.
 *
 * Threading is the connective tissue that makes narrative coherence visible:
 * each bullet is annotated with which strengths it demonstrates and which
 * axes it contributes to.
 *
 * Response:
 *   HTTP 200  {
 *     ok: true,
 *     bulletAnnotations: BulletThreadAnnotation[],
 *     sectionSummaries: SectionThreadSummary[],
 *     strengthCoverage: {...},
 *     axisCoverage: {...},
 *     groundedRatio: number (0-1),
 *     groundingReport: {...}
 *   }
 */
resumeRouter.get("/narrative-threading", async (c) => {
  try {
    const doc = await readNarrativeThreading();
    if (!doc) {
      return c.json({
        ok: true,
        bulletAnnotations: [],
        sectionSummaries: [],
        strengthCoverage: {},
        axisCoverage: {},
        groundedRatio: 0,
        message: "아직 서사 스레딩이 실행되지 않았습니다."
      });
    }
    return c.json({ ok: true, ...doc });
  } catch (err) {
    console.error("[resume/narrative-threading] failed:", err);
    return c.json(
      { ok: false, error: "스레딩 데이터를 불러오지 못했습니다.", detail: err.message },
      502
    );
  }
});

// ─── POST /api/resume/narrative-threading/run ───────────────────────────────

/**
 * Run the full narrative threading pipeline:
 *   episodes → strengths → axes → threading → grounding
 *
 * This orchestrates the entire pipeline and persists results to Blob storage.
 * It's the single entry point for regenerating all narrative threading data.
 *
 * Request body (JSON, optional):
 *   { "force": boolean }  — force regeneration even if results exist
 *
 * Response:
 *   HTTP 200  {
 *     ok: true,
 *     strengthCount: number,
 *     axisCount: number,
 *     threadedBulletCount: number,
 *     groundedRatio: number,
 *     groundingReport: {...}
 *   }
 */
resumeRouter.post("/narrative-threading/run", async (c) => {
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
    return c.json({ ok: false, error: "잘못된 요청 형식입니다." }, 400);
  }

  // Load resume
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[narrative-threading/run] Failed to read resume:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 PDF를 업로드해 주세요." },
      404
    );
  }

  // Check if results already exist and force=false
  if (!force) {
    try {
      const existing = await readNarrativeThreading();
      if (existing && existing.totalAnnotations > 0) {
        return c.json({
          ok: true,
          cached: true,
          strengthCount: (await readIdentifiedStrengths())?.strengths?.length || 0,
          axisCount: (await readNarrativeAxes())?.axes?.length || 0,
          threadedBulletCount: existing.totalAnnotations,
          groundedRatio: existing.groundedRatio
        });
      }
    } catch {
      // Continue with regeneration
    }
  }

  // Gather work-log entries
  let workLogEntries;
  try {
    const config = await loadConfig();
    workLogEntries = await gatherWorkLogBullets(config.dataDir);
  } catch (err) {
    console.error("[narrative-threading/run] Failed to gather work logs:", err);
    return c.json(
      { ok: false, error: "작업 로그를 불러오지 못했습니다.", detail: err.message },
      502
    );
  }

  if (workLogEntries.length === 0) {
    return c.json({
      ok: false,
      error: "작업 로그가 없습니다. 먼저 작업 로그를 기록해 주세요."
    }, 400);
  }

  // Load existing strengths and axes for merge
  let existingStrengths = [];
  let existingAxes = [];
  let existingBridges = [];
  try {
    const strengthsDoc = await readIdentifiedStrengths();
    if (strengthsDoc?.strengths) existingStrengths = strengthsDoc.strengths;
    const axesDoc = await readNarrativeAxes();
    if (axesDoc?.axes) existingAxes = axesDoc.axes;
    const bridgesDoc = await readSectionBridges();
    if (bridgesDoc?.bridges) existingBridges = bridgesDoc.bridges;
  } catch {
    // Continue without existing data
  }

  // Run the pipeline
  try {
    const result = await runNarrativeThreadingPipeline(
      {
        resume,
        workLogEntries,
        existingStrengths,
        existingAxes
      },
      { existingBridges }
    );

    // Persist results to Blob storage (parallel writes)
    const savePromises = [];

    // Save identified strengths
    savePromises.push(
      saveIdentifiedStrengths({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        source: "system",
        strengths: result.strengths,
        totalEpisodes: result.extractionResults.reduce(
          (sum, r) => sum + (r.episodeCount || 0), 0
        ),
        totalProjects: result.extractionResults.reduce(
          (sum, r) => sum + (r.projects?.length || 0), 0
        )
      })
    );

    // Save narrative axes
    savePromises.push(
      saveNarrativeAxes({
        axes: result.axes,
        totalProjects: result.extractionResults.reduce(
          (sum, r) => sum + (r.projects?.length || 0), 0
        ),
        totalStrengths: result.strengths.length,
        coverage: result.threading.strengthCoverage
          ? { overallCoverage: result.threading.groundedRatio }
          : {},
        generatedAt: new Date().toISOString()
      })
    );

    // Save threading result
    savePromises.push(
      saveNarrativeThreading({
        ...result.threading,
        groundingReport: result.groundingReport
      })
    );

    // Save section bridges (if generated)
    if (Array.isArray(result.sectionBridges) && result.sectionBridges.length > 0) {
      savePromises.push(
        saveSectionBridges({
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          bridges: result.sectionBridges
        })
      );
    }

    await Promise.all(savePromises);

    console.info(
      `[narrative-threading/run] Pipeline complete: ` +
      `${result.strengths.length} strengths, ` +
      `${result.axes.length} axes, ` +
      `${result.threading.totalAnnotations} threaded bullets, ` +
      `grounded ratio: ${result.threading.groundedRatio}`
    );

    return c.json({
      ok: true,
      cached: false,
      strengthCount: result.strengths.length,
      axisCount: result.axes.length,
      threadedBulletCount: result.threading.totalAnnotations,
      groundedRatio: result.threading.groundedRatio,
      groundingReport: result.groundingReport,
      bridgeCount: Array.isArray(result.sectionBridges) ? result.sectionBridges.length : 0,
      coherenceReport: result.coherenceReport ?? null
    });
  } catch (err) {
    console.error("[narrative-threading/run] Pipeline failed:", err);
    return c.json(
      {
        ok: false,
        error: "서사 스레딩 파이프라인 실행에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Coherence Validation (standalone endpoint)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/resume/coherence-validation
 *
 * Run the coherence validation pass on the current resume without triggering
 * a full narrative-threading pipeline.  Returns structural flow, redundancy,
 * and tonal consistency scores with per-issue details and auto-fixes.
 *
 * The auto-fixed version of the resume is returned in `normalized` but is NOT
 * persisted — the caller can inspect the fixes and decide whether to apply.
 *
 * Response:
 *   HTTP 200  { ok, overallScore, grade, structuralFlow, redundancy,
 *               tonalConsistency, issues, autoFixes, normalized }
 *   HTTP 404  { ok: false, error: "..." }  — resume not found
 */
resumeRouter.post("/coherence-validation", async (c) => {
  try {
    const resume = await readResumeData();
    if (!resume) {
      return c.json(
        { ok: false, error: "이력서가 아직 생성되지 않았습니다." },
        404
      );
    }

    // Optionally load context for richer validation
    let strengths = [];
    let axes = [];
    let sectionBridges = [];
    try {
      const strengthsDoc = await readIdentifiedStrengths();
      if (strengthsDoc?.strengths) strengths = strengthsDoc.strengths;
      const axesDoc = await readNarrativeAxes();
      if (axesDoc?.axes) axes = axesDoc.axes;
      const bridgesDoc = await readSectionBridges();
      if (bridgesDoc?.bridges) sectionBridges = bridgesDoc.bridges;
    } catch {
      // Continue without context data
    }

    const result = validateResumeCoherence(resume, {
      strengths,
      axes,
      sectionBridges,
    });

    return c.json({
      ok: true,
      overallScore: result.overallScore,
      grade: result.grade,
      structuralFlow: result.structuralFlow,
      redundancy: result.redundancy,
      tonalConsistency: result.tonalConsistency,
      issueCount: result.issues.length,
      issues: result.issues,
      autoFixCount: result.autoFixes.length,
      autoFixes: result.autoFixes,
      normalized: result.normalized,
      validatedAt: result.validatedAt,
    });
  } catch (err) {
    console.error("[coherence-validation] Failed:", err);
    return c.json(
      {
        ok: false,
        error: "일관성 검증에 실패했습니다.",
        detail: err.message ?? String(err),
      },
      500
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section Bridges (transition text between resume sections)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/resume/section-bridges
 *
 * Returns the stored section bridge text (transition sentences between sections).
 *
 * Response:
 *   HTTP 200  { ok: true, bridges: SectionBridge[] }
 *   or        { ok: true, bridges: [], message: "..." } if not yet generated
 */
resumeRouter.get("/section-bridges", async (c) => {
  try {
    const doc = await readSectionBridges();
    if (!doc) {
      return c.json({
        ok: true,
        bridges: [],
        message: "아직 섹션 간 연결 문구가 생성되지 않았습니다."
      });
    }
    return c.json({ ok: true, bridges: doc.bridges || [] });
  } catch (err) {
    console.error("[resume/section-bridges] failed:", err);
    return c.json(
      { ok: false, error: "연결 문구 데이터를 불러오지 못했습니다.", detail: err.message },
      502
    );
  }
});

/**
 * POST /api/resume/section-bridges/generate
 *
 * Generate section bridge text independently (without full pipeline run).
 * Uses current resume, strengths, axes, and threading data.
 *
 * Request body (JSON, optional):
 *   { "force": boolean }  — force regeneration even if bridges exist
 *
 * Response:
 *   HTTP 200  { ok: true, bridges: SectionBridge[], generatedCount: number }
 */
resumeRouter.post("/section-bridges/generate", async (c) => {
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
    return c.json({ ok: false, error: "잘못된 요청 형식입니다." }, 400);
  }

  // Check for existing bridges
  if (!force) {
    try {
      const existing = await readSectionBridges();
      if (existing?.bridges?.length > 0) {
        return c.json({
          ok: true,
          cached: true,
          bridges: existing.bridges
        });
      }
    } catch {
      // Continue with generation
    }
  }

  // Load required data
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[section-bridges/generate] Failed to read resume:", err);
    return c.json(
      { ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message },
      502
    );
  }

  if (!resume) {
    return c.json(
      { ok: false, error: "이력서가 없습니다. 먼저 PDF를 업로드해 주세요." },
      404
    );
  }

  let strengths = [];
  let axes = [];
  let sectionSummaries = [];
  let existingBridges = [];
  let sessionSummaries = [];
  try {
    const strengthsDoc = await readIdentifiedStrengths();
    if (strengthsDoc?.strengths) strengths = strengthsDoc.strengths;
    const axesDoc = await readNarrativeAxes();
    if (axesDoc?.axes) axes = axesDoc.axes;
    const threadingDoc = await readNarrativeThreading();
    if (threadingDoc?.sectionSummaries) sectionSummaries = threadingDoc.sectionSummaries;
    const bridgesDoc = await readSectionBridges();
    if (bridgesDoc?.bridges) existingBridges = bridgesDoc.bridges;
  } catch {
    // Continue with whatever data we have
  }

  // Gather session summaries for decision reasoning context in bridges
  try {
    const workLogEntries = await gatherWorkLogBullets();
    const entries = Array.isArray(workLogEntries) ? workLogEntries : [];
    for (const entry of entries) {
      if (!entry?.aiSessions) continue;
      const allSessions = [
        ...(Array.isArray(entry.aiSessions.codex) ? entry.aiSessions.codex : []),
        ...(Array.isArray(entry.aiSessions.claude) ? entry.aiSessions.claude : [])
      ];
      for (const session of allSessions) {
        if (!session) continue;
        const summary = session.summary || "";
        const reasoning = session.reasoning || "";
        const keyDecisions = Array.isArray(session.keyDecisions) ? session.keyDecisions : [];
        if (summary || reasoning || keyDecisions.length > 0) {
          sessionSummaries.push({
            date: entry.date,
            repo: session.cwd ? session.cwd.replace(/\/$/, "").split("/").pop() : null,
            summary, reasoning, keyDecisions,
            tradeoffs: session.tradeoffs || null
          });
        }
      }
    }
    sessionSummaries = sessionSummaries.slice(0, 20); // Cap for token budget
  } catch {
    // Non-fatal — continue without session context
  }

  try {
    const result = await generateSectionBridges({
      resume,
      strengths,
      axes,
      sectionSummaries,
      existingBridges,
      sessionSummaries
    });

    // Persist
    if (result.bridges.length > 0) {
      await saveSectionBridges({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        bridges: result.bridges
      });
    }

    return c.json({
      ok: true,
      cached: false,
      bridges: result.bridges,
      generatedCount: result.generatedCount,
      pairCount: result.pairCount,
      coherenceScore: result.coherenceScore ?? null
    });
  } catch (err) {
    console.error("[section-bridges/generate] Pipeline failed:", err);
    return c.json(
      {
        ok: false,
        error: "연결 문구 생성에 실패했습니다.",
        detail: err.message ?? String(err)
      },
      502
    );
  }
});

/**
 * PATCH /api/resume/section-bridges/:from/:to
 *
 * Edit a single section bridge text. Marks the bridge as user-edited
 * so it is never overwritten by subsequent regeneration.
 *
 * Request body (JSON):
 *   { "text": string }
 *
 * Response:
 *   HTTP 200  { ok: true, bridge: SectionBridge }
 */
resumeRouter.patch("/section-bridges/:from/:to", async (c) => {
  const fromSection = c.req.param("from");
  const toSection = c.req.param("to");

  let text;
  try {
    const body = await c.req.json();
    text = typeof body.text === "string" ? body.text.trim() : null;
  } catch {
    return c.json({ ok: false, error: "잘못된 요청 형식입니다." }, 400);
  }

  if (text === null) {
    return c.json({ ok: false, error: "text 필드가 필요합니다." }, 400);
  }

  try {
    const doc = await readSectionBridges();
    const bridges = doc?.bridges || [];

    // Find existing bridge for this pair
    const idx = bridges.findIndex(
      (b) => b.from === fromSection && b.to === toSection
    );

    const updatedBridge = {
      from: fromSection,
      to: toSection,
      text,
      _source: "user"
    };

    if (idx >= 0) {
      bridges[idx] = updatedBridge;
    } else {
      bridges.push(updatedBridge);
    }

    await saveSectionBridges({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      bridges
    });

    return c.json({ ok: true, bridge: updatedBridge });
  } catch (err) {
    console.error("[section-bridges/edit] failed:", err);
    return c.json(
      { ok: false, error: "연결 문구 수정에 실패했습니다.", detail: err.message },
      502
    );
  }
});

/**
 * DELETE /api/resume/section-bridges/:from/:to
 *
 * Remove a section bridge (user can dismiss a transition they don't want).
 *
 * Response:
 *   HTTP 200  { ok: true }
 */
resumeRouter.delete("/section-bridges/:from/:to", async (c) => {
  const fromSection = c.req.param("from");
  const toSection = c.req.param("to");

  try {
    const doc = await readSectionBridges();
    const bridges = (doc?.bridges || []).filter(
      (b) => !(b.from === fromSection && b.to === toSection)
    );

    await saveSectionBridges({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      bridges
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("[section-bridges/delete] failed:", err);
    return c.json(
      { ok: false, error: "연결 문구 삭제에 실패했습니다.", detail: err.message },
      502
    );
  }
});

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Extract bullet text from a suggestion and track the generated-vs-final
 * similarity for quality monitoring.
 *
 * Non-fatal by design — this is a best-effort quality signal that should
 * never block or fail the approval/discard flow.
 *
 * Handles both legacy suggestion format (action/patch) and BulletProposal
 * format (op/target/payload).
 *
 * @param {object} suggestion — the suggestion or candidate object
 * @param {string} action — "approved" | "edited" | "discarded"
 * @returns {Promise<void>}
 */
async function _trackSuggestionQuality(suggestion, action) {
  // Extract the generated bullet text depending on suggestion format
  let generatedText = null;
  let section = suggestion.section ?? "experience";

  if (isBulletProposal(suggestion)) {
    // BulletProposal format: payload.text is the generated bullet
    generatedText = suggestion.payload?.text;
  } else if (suggestion.action === "append_bullet" && suggestion.patch?.bullet) {
    generatedText = suggestion.patch.bullet;
    section = suggestion.patch?.section ?? "experience";
  } else if (
    (suggestion.action === "add_summary" || suggestion.action === "update_summary") &&
    suggestion.patch?.text
  ) {
    generatedText = suggestion.patch.text;
    section = "summary";
  }

  if (!generatedText || typeof generatedText !== "string") return;

  // For "approved" without edit, generated = final (pristine acceptance).
  // For "discarded", we still track to measure what users reject.
  const finalText = suggestion._editedText ?? generatedText;

  await trackBulletEdit({
    generatedText,
    finalText,
    action,
    section,
    logDate: suggestion.logDate ?? suggestion.context?.logDate ?? null,
    useEmbeddings: false, // offline scoring in hot path; batch embedding later
  });
}

/**
 * Compare old vs new bullets across experience and projects when a user
 * edits the full resume via PATCH /api/resume.
 *
 * Pairs up bullets by index position within each item.  Changed bullets
 * are tracked as "edited"; removed bullets are tracked as "discarded".
 * New bullets (added by user) are not tracked (no system-generated original).
 *
 * Non-fatal by design — errors are logged but never surface to the user.
 *
 * @param {object} stored  — the resume before the edit
 * @param {object} updated — the resume after the edit
 * @returns {Promise<void>}
 */
async function _trackFullResumeEditBullets(stored, updated) {
  const pairs = [];

  for (const section of ["experience", "projects"]) {
    const oldItems = Array.isArray(stored[section]) ? stored[section] : [];
    const newItems = Array.isArray(updated[section]) ? updated[section] : [];

    // Match items by index (same as how the PATCH merges them)
    const minLen = Math.min(oldItems.length, newItems.length);
    for (let i = 0; i < minLen; i++) {
      const oldBullets = Array.isArray(oldItems[i].bullets) ? oldItems[i].bullets : [];
      const newBullets = Array.isArray(newItems[i].bullets) ? newItems[i].bullets : [];

      // Compare bullets by position
      const maxBullets = Math.max(oldBullets.length, newBullets.length);
      for (let j = 0; j < maxBullets; j++) {
        const oldText = oldBullets[j];
        const newText = newBullets[j];

        if (typeof oldText === "string" && typeof newText === "string") {
          // Both exist — track as edit only if different
          if (oldText !== newText) {
            pairs.push({
              generatedText: oldText,
              finalText: newText,
              action: "edited",
              section,
              logDate: null,
            });
          }
        } else if (typeof oldText === "string" && newText === undefined) {
          // Bullet removed
          pairs.push({
            generatedText: oldText,
            finalText: oldText,
            action: "discarded",
            section,
            logDate: null,
          });
        }
        // newText exists but oldText doesn't → user-created bullet, skip
      }
    }

    // Items beyond newItems.length are entirely removed
    for (let i = minLen; i < oldItems.length; i++) {
      const oldBullets = Array.isArray(oldItems[i].bullets) ? oldItems[i].bullets : [];
      for (const bullet of oldBullets) {
        if (typeof bullet === "string") {
          pairs.push({
            generatedText: bullet,
            finalText: bullet,
            action: "discarded",
            section,
            logDate: null,
          });
        }
      }
    }
  }

  if (pairs.length > 0) {
    await trackBulletEditBatch(pairs, { useEmbeddings: false });
  }
}

// ─── POST /api/resume/chat/generate-draft ─────────────────────────────────────

/**
 * Generate a resume draft from aggregated work log data (commits / Slack / session memory).
 *
 * This is the bootstrap step for the chat-based resume refinement feature.
 * It aggregates signals from available work log dates, calls the LLM once to
 * identify strength candidates and experience summaries, and saves the result
 * to Vercel Blob for use as chat context.
 *
 * Supports two modes:
 *   - async=true (default): Returns immediately with taskId, runs generation in background.
 *     Poll GET /api/resume/chat/generate-draft/status for progress.
 *   - async=false: Synchronous mode — blocks until generation completes (legacy compat).
 *
 * Request body (all fields optional):
 *   {
 *     "from_date": "YYYY-MM-DD",   // Oldest date to include (default: 90 days ago)
 *     "to_date":   "YYYY-MM-DD",   // Newest date to include (default: today)
 *     "force":     true,           // Re-generate even if a recent draft exists (default: false)
 *     "async":     true            // Background execution (default: true) — Sub-AC 2-3
 *   }
 *
 * Responses (async=true):
 *   202  { "taskId": string, "status": "pending" }   — generation started in background
 *   200  { "draft": ResumeDraft, "cached": true }     — returned from cache (force=false)
 *   409  { "error": "...", "taskId": string }          — generation already in progress
 *   400  { "error": "..." }                            — validation error
 *
 * Responses (async=false — legacy):
 *   201  { "draft": ResumeDraft, "cached": false }    — freshly generated (synchronous)
 *   200  { "draft": ResumeDraft, "cached": true }     — returned from cache (force=false)
 *   400  { "error": "..." }                            — validation error
 *   500  { "error": "...", "detail": "..." }            — generation failure
 *
 * The generated draft includes:
 *   - strengthCandidates  — behavioral patterns backed by work log evidence
 *   - experienceSummaries — per-company highlights with resume-ready bullet candidates
 *   - suggestedSummary    — proposed professional summary
 *   - dataGaps            — areas where more information is needed from the user
 *   - sources             — metadata about the work logs analyzed
 */
resumeRouter.post("/chat/generate-draft", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fromDate = typeof body.from_date === "string" ? body.from_date.trim() : undefined;
  const toDate = typeof body.to_date === "string" ? body.to_date.trim() : undefined;
  const force = body.force === true;
  const asyncMode = body.async !== false; // default true — Sub-AC 2-3

  // Validate date format if provided
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (fromDate && !dateRe.test(fromDate)) {
    return c.json({ error: "Invalid from_date format — expected YYYY-MM-DD" }, 400);
  }
  if (toDate && !dateRe.test(toDate)) {
    return c.json({ error: "Invalid to_date format — expected YYYY-MM-DD" }, 400);
  }
  if (fromDate && toDate && fromDate > toDate) {
    return c.json({ error: "from_date must not be after to_date" }, 400);
  }

  // Return cached draft if it exists and force=false
  if (!force) {
    try {
      const cached = await readChatDraft();
      if (cached) {
        // Check if the cached draft covers the requested range
        const cacheCoversRange =
          (!fromDate || cached.dateRange?.from <= fromDate) &&
          (!toDate || cached.dateRange?.to >= toDate);
        if (cacheCoversRange) {
          return c.json({ draft: cached, cached: true });
        }
      }
    } catch {
      // Cache read failure is non-fatal — proceed with fresh generation
    }
  }

  // ── Async mode (Sub-AC 2-3): fire-and-forget background generation ──────
  if (asyncMode) {
    // Reject if a generation is already in progress
    if (isDraftGenerationInProgress()) {
      const currentState = getDraftGenerationState();
      return c.json({
        error: "Draft generation already in progress",
        taskId: currentState.taskId,
        status: currentState.status,
        startedAt: currentState.startedAt,
        progress: currentState.progress,
      }, 409);
    }

    // Start background generation
    const taskId = markDraftGenerationPending("api");
    console.info(`[resume/chat/generate-draft] Background generation started: taskId=${taskId}`);

    // Fire-and-forget: run generation in background, update state on completion/failure
    _runDraftGenerationBackground(taskId, { fromDate, toDate, force }).catch((err) => {
      console.error(`[resume/chat/generate-draft] Unhandled background error:`, err.message);
    });

    return c.json({ taskId, status: "pending" }, 202);
  }

  // ── Sync mode (legacy): block until generation completes ────────────────
  // Load existing resume for context (optional — generation works without it)
  let existingResume = null;
  try {
    existingResume = await readResumeData();
  } catch {
    // Non-fatal — draft generation works without an existing resume
  }

  // Use buildChatDraftContext for a richer pipeline that also collects
  // evidence pool and source breakdown alongside the LLM draft.
  let draftContext;
  try {
    draftContext = await buildChatDraftContext({ fromDate, toDate, existingResume });
  } catch (err) {
    console.error("[resume/chat/generate-draft] Generation failed:", err.message);
    return c.json(
      { error: "Draft generation failed", detail: err.message },
      500
    );
  }

  if (!draftContext.draft && draftContext.dataGaps.length > 0) {
    return c.json(
      { error: "No work log data found for the specified date range", dataGaps: draftContext.dataGaps },
      400
    );
  }

  // Persist draft + full context to Vercel Blob (best-effort — failure logged but not returned as error)
  if (draftContext.draft) {
    try {
      await Promise.all([
        saveChatDraft(draftContext.draft),
        saveChatDraftContext({
          schemaVersion: 1,
          generatedAt: draftContext.draft.generatedAt || new Date().toISOString(),
          draft: draftContext.draft,
          evidencePool: draftContext.evidencePool || [],
          sourceBreakdown: draftContext.sourceBreakdown || { commits: 0, slack: 0, sessions: 0, totalDates: 0 },
          dataGaps: draftContext.dataGaps || [],
        }),
      ]);
    } catch (err) {
      console.warn("[resume/chat/generate-draft] Failed to save draft to Blob:", err.message);
    }
  }

  return c.json({
    draft: draftContext.draft,
    evidencePool: draftContext.evidencePool,
    sourceBreakdown: draftContext.sourceBreakdown,
    dataGaps: draftContext.dataGaps,
    cached: false,
  }, 201);
});

// ─── GET /api/resume/chat/generate-draft/status ──────────────────────────────

/**
 * Poll the current draft generation background task status (Sub-AC 2-3).
 *
 * Returns the in-memory state of the most recent draft generation task.
 * When status is "completed", the draft is available via GET /api/resume/chat/generate-draft.
 *
 * Responses:
 *   200  {
 *     "status":      "idle" | "pending" | "completed" | "failed",
 *     "taskId":      string | null,
 *     "startedAt":   string | null,
 *     "completedAt": string | null,
 *     "error":       string | null,
 *     "progress":    { stage, datesLoaded, commitCount, ... } | null,
 *     "triggeredBy": "api" | "batch" | "manual" | null
 *   }
 */
resumeRouter.get("/chat/generate-draft/status", async (c) => {
  // isDraftGenerationInProgress() also handles stale-task auto-fail
  isDraftGenerationInProgress();
  const state = getDraftGenerationState();
  return c.json(state);
});

// ─── POST /api/resume/chat/generate-draft/reset ──────────────────────────────

/**
 * Reset the draft generation state to idle (Sub-AC 2-3).
 *
 * Called by the frontend after acknowledging a completed or failed state,
 * so that subsequent requests can trigger a new generation.
 *
 * Responses:
 *   200  { "status": "idle" }
 */
resumeRouter.post("/chat/generate-draft/reset", async (c) => {
  resetDraftGenerationState();
  return c.json({ status: "idle" });
});

/**
 * Background draft generation runner (Sub-AC 2-3).
 *
 * Runs the full buildChatDraftContext pipeline asynchronously, updating the
 * in-memory DraftGenerationState at each stage so the frontend can poll
 * for progress via GET /api/resume/chat/generate-draft/status.
 *
 * This function NEVER throws — all errors are captured and reflected in the
 * state manager. The caller should still wrap in .catch() for safety.
 *
 * @param {string} taskId          Task identifier from markDraftGenerationPending()
 * @param {Object} opts
 * @param {string} [opts.fromDate]
 * @param {string} [opts.toDate]
 * @param {boolean} [opts.force]
 */
async function _runDraftGenerationBackground(taskId, { fromDate, toDate } = {}) {
  const tag = `[generate-draft-bg taskId=${taskId}]`;

  try {
    // Stage 1: Load existing resume for context
    updateDraftGenerationProgress(taskId, { stage: "loading_resume" });
    let existingResume = null;
    try {
      existingResume = await readResumeData();
    } catch {
      // Non-fatal — draft generation works without an existing resume
    }

    // Stage 2: Build draft context (loads work logs, aggregates, calls LLM)
    updateDraftGenerationProgress(taskId, { stage: "building_context" });
    const draftContext = await buildChatDraftContext({
      fromDate,
      toDate,
      existingResume,
      onProgress: (progress) => {
        // Relay progress from the pipeline to the state manager
        updateDraftGenerationProgress(taskId, progress);
      },
    });

    if (!draftContext.draft) {
      const reason = draftContext.dataGaps?.[0] ?? "No work log data available";
      console.info(`${tag} Draft generation produced no draft — ${reason}`);
      markDraftGenerationFailed(taskId, reason);
      return;
    }

    // Stage 3: Save to Vercel Blob
    updateDraftGenerationProgress(taskId, { stage: "saving" });
    try {
      await Promise.all([
        saveChatDraft(draftContext.draft),
        saveChatDraftContext({
          schemaVersion: 1,
          generatedAt: draftContext.draft.generatedAt || new Date().toISOString(),
          draft: draftContext.draft,
          evidencePool: draftContext.evidencePool || [],
          sourceBreakdown: draftContext.sourceBreakdown || { commits: 0, slack: 0, sessions: 0, totalDates: 0 },
          dataGaps: draftContext.dataGaps || [],
        }),
      ]);
    } catch (err) {
      console.warn(`${tag} Blob save failed (non-fatal):`, err.message);
      // Still mark as completed — the draft was generated, just not persisted
    }

    // Update final progress with source stats
    const sb = draftContext.sourceBreakdown || {};
    updateDraftGenerationProgress(taskId, {
      stage: "done",
      datesLoaded: sb.totalDates ?? 0,
      commitCount: sb.commits ?? 0,
      slackCount: sb.slack ?? 0,
      sessionCount: sb.sessions ?? 0,
    });

    markDraftGenerationCompleted(taskId);
    console.info(
      `${tag} Background draft generation completed` +
      ` — commits=${sb.commits ?? 0} sessions=${sb.sessions ?? 0}` +
      ` slack=${sb.slack ?? 0} dates=${sb.totalDates ?? 0}`
    );
  } catch (err) {
    console.error(`${tag} Background draft generation failed:`, err.message);
    markDraftGenerationFailed(taskId, err.message ?? String(err));
  }
}

// ─── POST /api/resume/chat ────────────────────────────────────────────────────

/**
 * 채팅 기반 이력서 구체화 엔드포인트 (Sub-AC 3-3, Sub-AC 5-1).
 *
 * 사용자의 자유 텍스트 질의(query)와 파싱된 쿼리 구조(parsedQuery)를 받아
 * 세 데이터 소스(커밋/슬랙/세션)에서 근거를 검색·병합·랭킹하고,
 * LLM 을 통해 이력서 어필 포인트 목록을 생성하여 채팅 응답으로 출력한다.
 *
 * "반영해줘" 의도(apply_section)가 감지되면, parseApplyIntent 를 통해
 * 대화 컨텍스트에서 수정할 섹션과 변경 내용을 파싱하고
 * applyIntent 필드를 응답에 포함한다.
 *
 * Request body:
 *   sessionId   — string  세션 식별자 (로깅용)
 *   query       — string  원본 사용자 입력
 *   parsedQuery — object  parseResumeQuery() 결과 (intent, keywords, section, dateRange)
 *   history     — { role: string, content: string }[]  이전 대화 기록 (선택)
 *   draftContext — object | null  채팅 초안 컨텍스트 (선택)
 *
 * Response (200):
 *   {
 *     reply:            string,
 *     sessionId:        string,
 *     parsedQuery:      object,
 *     queryAnalysis:    object,                      — 서버 사이드 쿼리 분석 메타데이터
 *     evidence:         ChatEvidenceResult | null,
 *     rankedEvidence:   RankedEvidenceRecord[] | null,
 *     citations:        ChatCitation[] | null,       — Sub-AC 4-2: 정규화된 출처 정보
 *     citationSummary:  CitationSourceSummary | null, — Sub-AC 4-2: 소스별 건수 요약 (레거시 호환)
 *     sourceSummary:    CitationSourceSummary | null, — Sub-AC 4-2: 소스별 건수 요약 (정규화된 필드명)
 *     sourceMeta:       object | null,               — 소스별 탐색 메타데이터
 *     appealPoints:     AppealPointsResult | null,
 *     applyIntent:      ApplyIntentResult | null     — apply_section 의도일 때만 포함
 *   }
 *
 * 오류:
 *   400  { error: string }  — query 누락 또는 잘못된 요청
 *   500  { error: string }  — 서버 오류
 *
 * 파이프라인:
 *   0. apply_section 의도 감지 시 → parseApplyIntent → applyIntent 반환
 *   1. keywords 있으면 세 소스 병렬 검색 (searchAllSources)
 *   2. 결과 병합·랭킹 (mergeAndRankEvidence)
 *   3. LLM 에 근거 주입 → 어필 포인트 생성 (generateAppealPoints)
 *   4. 어필 포인트를 Markdown 채팅 텍스트로 변환하여 reply 반환
 */
resumeRouter.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.query !== "string" || !body.query.trim()) {
    return c.json({ error: "query is required" }, 400);
  }

  const { query, parsedQuery: clientParsedQuery, sessionId, history = [] } = body;

  // ── AC 3 Sub-AC 1: 서버 사이드 쿼리 분석을 primary로 사용 ─────────────────────
  // 규칙 기반 analyzeQuery()로 의도·키워드·기술스택·소스별 파라미터를 즉시 생성.
  // confidence < 0.7이면 analyzeQueryWithLLM()으로 LLM 보강을 시도하되, 실패 시 규칙 기반 결과를 사용.
  let analyzed;
  try {
    analyzed = await analyzeQueryWithLLM(query);
  } catch {
    analyzed = analyzeQuery(query);
  }
  // 클라이언트 parsedQuery 호환을 위해 toSearchQuery로 변환
  const parsedQuery = toSearchQuery(analyzed);

  const intentLabel = {
    apply_section:   "이력서 반영",
    search_evidence: "증거/이력 검색",
    refine_section:  "섹션 수정",
    question:        "질문",
    general:         "일반 질의",
  }[parsedQuery?.intent] ?? "일반 질의";

  // ── 0. "반영해줘" 의도 처리 (Sub-AC 5-1) ──────────────────────────────────────
  const isApplyIntent =
    parsedQuery?.intent === "apply_section" ||
    (!parsedQuery?.intent && _detectApplyPatternFallback(query));

  let applyIntentResult = null;
  if (isApplyIntent) {
    applyIntentResult = parseApplyIntent(query, parsedQuery ?? null, history);
    console.log(
      `[resume/chat] apply_section 의도 감지: section=${applyIntentResult.section}, changes=${applyIntentResult.changes.length}, confidence=${applyIntentResult.confidence.toFixed(2)}`
    );

    // 모호하지 않고 변경 내용이 있으면 apply_section 응답만 반환 (증거 검색 생략)
    if (!applyIntentResult.ambiguous && applyIntentResult.changes.length > 0) {
      const applyReply = _buildApplyIntentReply(applyIntentResult);

      // ── diff 객체 생성 (Sub-AC 5-2): 현재 이력서에 변경 내용을 적용해 before/after diff 를 구성한다
      let currentResume = null;
      try {
        currentResume = await readResumeData();
      } catch {
        // 이력서 없어도 비치명적 — diff 없이 applyIntent 만 반환
      }
      let diff = null;
      if (currentResume) {
        try {
          const applyResult = applyChatChangesToResume(currentResume, applyIntentResult);
          diff = applyResult.diff;
          // skippedChanges 를 로그로 남겨 디버깅에 활용한다
          if (applyResult.skippedChanges.length > 0) {
            console.log(
              `[resume/chat] Sub-AC 5-2 skippedChanges=${applyResult.skippedChanges.length}:`,
              applyResult.skippedChanges.map((s) => `${s.content} (${s.reason})`).join(", ")
            );
          }
        } catch (applyErr) {
          // 비치명적 — diff 없이 applyIntent 만 반환
          console.warn("[resume/chat] applyChatChangesToResume failed (non-fatal):", applyErr.message);
          diff = _buildDiffFromApplyIntent(currentResume, applyIntentResult);
        }
      }

      return c.json({
        reply: applyReply,
        sessionId,
        parsedQuery,
        evidence: null,
        rankedEvidence: null,
        citations: null,  // Sub-AC 4-2: apply_section 응답에는 증거 검색 없음
        appealPoints: null,
        applyIntent: applyIntentResult,
        diff,  // ResumeDiffViewer 에서 사용; null 이면 diff ���어를 표���하지 않는다
      });
    }

    // 모호한 경우: 보충 질문을 reply 로 반환하고 계속 진행하지 않는다
    if (applyIntentResult.ambiguous && applyIntentResult.clarificationNeeded) {
      return c.json({
        reply: applyIntentResult.clarificationNeeded,
        sessionId,
        parsedQuery,
        evidence: null,
        rankedEvidence: null,
        citations: null,  // Sub-AC 4-2: 모호한 apply 응답에는 증거 검색 없음
        appealPoints: null,
        applyIntent: applyIntentResult,
      });
    }
  }

  // ── 1. 데이터 소스별 키워드 병렬 검색 (Sub-AC 3-2) ─────────────────────────
  //
  // exploreWithQueryAnalysis()를 통해 세 소스를 통합 탐색한다:
  //   - AnalyzedQuery / QueryAnalysisResult 두 형식 자동 감지
  //   - sourceParams.{source}.enabled === false 인 소스는 API 호출 없이 건너뜀
  //   - priority별 maxResults 차등 적용 (high 100%, medium 60%, low 30%)
  //   - low priority + confidence < 0.3 이면 소스를 건너뜀
  //   - techStack 키워드 보강으로 기술 이름 검색 정밀도 향상
  //   - 소스별 독립 실패 처리 (한 소스 오류가 다른 소스에 영향 없음)
  //   - 결과 없을 때 보충 질문(followUpQuestion) 자동 생성
  //
  // 폴백: analyzed가 없거나 sourceParams가 비어있으면 기존 searchAllSources 사용
  const hasKeywords =
    Array.isArray(parsedQuery?.keywords) && parsedQuery.keywords.length > 0;

  // sourceParams에 검색 가능한 소스가 있는지 확인
  const hasSourceParams = analyzed?.sourceParams && (
    analyzed.sourceParams.commits?.enabled !== undefined ||
    analyzed.sourceParams.slack?.enabled !== undefined ||
    analyzed.sourceParams.sessions?.enabled !== undefined ||
    analyzed.sourceParams.commits?.priority ||
    analyzed.sourceParams.slack?.priority ||
    analyzed.sourceParams.sessions?.priority
  );

  let evidence = null;
  let sourceMeta = null;
  let exploreFollowUp = null;
  if (hasKeywords) {
    try {
      if (hasSourceParams) {
        // Sub-AC 3-2: exploreWithQueryAnalysis 기반 멀티소스 탐색
        // — priority·enabled 플래그에 따른 차등 검색
        // — sourceMeta로 각 소스의 검색 여부·결과 수·키워드를 추적
        const exploreResult = await exploreWithQueryAnalysis(analyzed);
        evidence = {
          commits: exploreResult.commits,
          slack: exploreResult.slack,
          sessions: exploreResult.sessions,
          totalCount: exploreResult.totalCount,
        };
        sourceMeta = exploreResult.sourceMeta;
        exploreFollowUp = exploreResult.followUpQuestion;
      } else {
        // 폴백: 기존 flat 키워드 검색
        const config = await loadConfig();
        evidence = await searchAllSources(parsedQuery, {
          dataDir: config.dataDir,
          maxResultsPerSource: 10,
        });
      }
    } catch (err) {
      console.warn("[resume/chat] Evidence search failed (non-fatal):", err.message);
      evidence = { commits: [], slack: [], sessions: [], totalCount: 0 };
    }
  }

  // ── 2. 검색 결과 병합·랭킹 (Sub-AC 3-3) ────────────────────────────────────
  let rankedEvidence = null;
  if (evidence) {
    rankedEvidence = mergeAndRankEvidence(evidence, { topN: 15 });
  }

  // ── 3. 섹션별 특화 처리 (Sub-AC 8-1: 자기소개·강점) ─────────────────────────
  //
  // parsedQuery.section 이 'summary' 또는 'strengths' 이고
  // apply_section 이 아닌 모든 의도(refine_section, search_evidence, question, general) 에서
  // 섹션별 전용 diff 생성 모듈을 호출해 구조화된 제안을 반환한다.
  //
  // apply_section 의도는 이미 위에서 처리되므로 여기서는 apply 이외의 의도만 처리한다.
  // "강점을 분석해줘" (general intent) 도 strengths diff 를 반환한다.
  //
  const targetSection = parsedQuery?.section;

  // ── 3a. 자기소개(Summary) 섹션 특화 처리 ──────────────────────────────────────
  // summary 섹션의 경우 refine_section 의도일 때만 diff 를 생성한다.
  // question / general 은 기존 appeal points 파이프라인이 더 적절하다.
  const isSummaryRefinement = parsedQuery?.intent === "refine_section" ||
    (!parsedQuery?.intent && !isApplyIntent);

  if (targetSection === "summary" && isSummaryRefinement && rankedEvidence !== null) {
    let existingResume = null;
    try { existingResume = await readResumeData(); } catch { /* non-fatal */ }

    const lang = existingResume?.meta?.language ?? "ko";
    let summaryResult = null;

    try {
      summaryResult = await generateSummaryChatDiff(query, rankedEvidence, existingResume, { lang });
    } catch (err) {
      console.warn("[resume/chat] Summary section diff generation failed (non-fatal):", err.message);
    }

    if (summaryResult) {
      let replyText;
      if (summaryResult.hasEnoughEvidence && summaryResult.after) {
        replyText = "자기소개 섹션 개선안을 작성했습니다. 아래 변경 내용을 검토 후 승인해 주세요.";
      } else {
        replyText = [
          "자기소개를 작성할 근거 데이터가 충분하지 않습니다.",
          summaryResult.dataGaps.length > 0
            ? "### 부족한 정보\n" + summaryResult.dataGaps.map((g) => `• ${g}`).join("\n")
            : "",
          summaryResult.followUpQuestions.length > 0
            ? "### 보충 질문\n" + summaryResult.followUpQuestions.map((q) => `• ${q}`).join("\n")
            : "",
        ].filter(Boolean).join("\n\n");
      }

      // 근거가 충분하고 after 가 있을 때만 diff 를 포함한다
      const diff = summaryResult.hasEnoughEvidence && summaryResult.after
        ? {
            section: "summary",
            before: summaryResult.before,
            after: summaryResult.after,
            evidence: summaryResult.evidence,
          }
        : null;

      // Sub-AC 4-2: 섹션 특화 응답에도 출처 정보 첨부
      const summaryCitations = rankedEvidence
        ? buildChatCitations(rankedEvidence)
        : null;

      return c.json({
        reply: replyText,
        sessionId,
        parsedQuery,
        evidence,
        rankedEvidence,
        citations: summaryCitations,
        // Sub-AC 4-2: 소스별 건수 요약 (refine-section·search-evidence 와 일관성)
        sourceSummary: summaryCitations ? buildSourceSummary(summaryCitations) : null,
        appealPoints: null,
        applyIntent: null,
        diff,
      });
    }
  }

  // ── 3b. 강점(Strengths) 섹션 특화 처리 ───────────────────────────────────────
  // 강점 섹션은 apply_section 이외의 모든 의도에서 diff 를 생성한다.
  // "강점을 분석해줘" (general/question), "강점 개선해줘" (refine_section) 등 모두 포함.
  if (targetSection === "strengths" && !isApplyIntent) {
    let existingResume = null;
    let existingStrengths = null;

    try { existingResume = await readResumeData(); } catch { /* non-fatal */ }
    try { existingStrengths = await readIdentifiedStrengths(); } catch { /* non-fatal */ }

    const lang = existingResume?.meta?.language ?? "ko";
    let strengthsResult = null;

    try {
      strengthsResult = await generateStrengthsChatDiff(
        query,
        rankedEvidence ?? [],
        existingResume,
        existingStrengths,
        { lang }
      );
    } catch (err) {
      console.warn("[resume/chat] Strengths section diff generation failed (non-fatal):", err.message);
    }

    if (strengthsResult) {
      let replyText;
      if (strengthsResult.hasEnoughEvidence && strengthsResult.strengthsData.length > 0) {
        replyText = `업무 기록에서 ${strengthsResult.strengthsData.length}개의 행동 패턴 기반 강점을 도출했습니다. 아래 강점 목록을 검토 후 승인해 주세요.`;
      } else {
        replyText = [
          "강점을 도출할 근거 데이터가 충분하지 않습니다.",
          strengthsResult.dataGaps.length > 0
            ? "### 부족한 정보\n" + strengthsResult.dataGaps.map((g) => `• ${g}`).join("\n")
            : "",
          strengthsResult.followUpQuestions.length > 0
            ? "### 보충 질문\n" + strengthsResult.followUpQuestions.map((q) => `• ${q}`).join("\n")
            : "",
        ].filter(Boolean).join("\n\n");
      }

      // diff 객체: section='strengths', after=JSON.stringify(strengthsData) (PATCH 요청용)
      // strengthsData 는 프론트엔드 StrengthsSectionViewer 렌더링에 사용된다
      const diff = strengthsResult.hasEnoughEvidence && strengthsResult.strengthsData.length > 0
        ? {
            section: "strengths",
            before: strengthsResult.before,
            after: JSON.stringify(strengthsResult.strengthsData),
            evidence: strengthsResult.evidence,
            strengthsData: strengthsResult.strengthsData,  // 구조화된 UI 렌더링용
          }
        : null;

      // Sub-AC 4-2: 강점 섹션 응답에도 출처 정보 첨부
      const strengthsCitations = rankedEvidence
        ? buildChatCitations(rankedEvidence)
        : null;

      return c.json({
        reply: replyText,
        sessionId,
        parsedQuery,
        evidence,
        rankedEvidence,
        citations: strengthsCitations,
        // Sub-AC 4-2: 소스별 건수 요약 (refine-section·search-evidence 와 일관성)
        sourceSummary: strengthsCitations ? buildSourceSummary(strengthsCitations) : null,
        appealPoints: null,
        applyIntent: null,
        diff,
      });
    }
  }

  // ── 3c. 일반 어필 포인트 생성 (Sub-AC 3-3) ────────────────────────────────────
  let appealPointsResult = null;
  if (rankedEvidence !== null) {
    try {
      let existingResume = null;
      try {
        existingResume = await readResumeData();
      } catch {
        // 이력서가 없어도 어필 포인트 생성 가능
      }

      appealPointsResult = await generateAppealPoints(
        query,
        rankedEvidence,
        { existingResume, lang: existingResume?.meta?.language ?? "ko" }
      );
    } catch (err) {
      console.warn("[resume/chat] Appeal points generation failed (non-fatal):", err.message);
      appealPointsResult = {
        appealPoints: [],
        dataGaps: [],
        followUpQuestions: [],
        evidenceUsed: rankedEvidence ?? [],
      };
    }
  }

  // ── 3d. 클러스터 기반 제안 생성 (Sub-AC 3-3: resumeChatSuggest) ──────────────
  //
  // 기존 flat 랭킹(mergeAndRankEvidence → generateAppealPoints) 외에
  // 클러스터 기반(clusterEvidence → rankClusters → generateAppealPointsWithRules/LLM)
  // 어필 포인트 제안 세트를 생성하여 응답에 첨부한다.
  //
  // suggestions 필드로 반환하여 프론트엔드에서 클러스터 요약, 제안 유형별
  // 필터링, 보충 질문 등 풍부한 UI를 구성할 수 있다.
  let suggestions = null;
  if (evidence && evidence.totalCount > 0) {
    try {
      let existingResume = null;
      try { existingResume = await readResumeData(); } catch { /* non-fatal */ }

      suggestions = await generateSuggestions(evidence, {
        existingResume,
        skipLLM: process.env.WORK_LOG_DISABLE_OPENAI === "1",
        userIntent: query,
      });
    } catch (err) {
      console.warn("[resume/chat] Suggestion generation failed (non-fatal):", err.message);
    }
  }

  // ── 4. 채팅 응답 텍스트 구성 ────────────────────────────────────────────────
  const keywordSummary = hasKeywords
    ? `키워드: ${parsedQuery.keywords.join(", ")}`
    : "";
  const sectionLabel = parsedQuery?.section
    ? `대상 섹션: ${parsedQuery.section}`
    : "";
  const metaParts = [intentLabel, keywordSummary, sectionLabel].filter(Boolean);
  const metaLine  = metaParts.length > 0 ? `[${metaParts.join(" · ")}]` : "";

  let reply = "";

  if (appealPointsResult && appealPointsResult.appealPoints.length > 0) {
    const pointLines = appealPointsResult.appealPoints
      .map((ap, i) => {
        const conf = ap.confidence >= 0.8 ? "★★★" : ap.confidence >= 0.5 ? "★★" : "★";
        return `${i + 1}. **${ap.title}** ${conf}\n   ${ap.description}`;
      })
      .join("\n\n");

    const sourceSummary = _buildSourceSummary(evidence, sourceMeta);
    reply = [metaLine, sourceSummary, "", "## 이력서 어필 포인트", pointLines]
      .filter(Boolean)
      .join("\n");

    if (appealPointsResult.dataGaps.length > 0) {
      reply += "\n\n### 보충이 필요한 부분\n" +
        appealPointsResult.dataGaps.map((g) => `• ${g}`).join("\n");
    }
    if (appealPointsResult.followUpQuestions.length > 0) {
      reply += "\n\n### 추가로 알려주시면 도움이 됩니다\n" +
        appealPointsResult.followUpQuestions.map((q) => `• ${q}`).join("\n");
    }
  } else if (rankedEvidence !== null && rankedEvidence.length === 0) {
    // Sub-AC 3-2: 결과 없을 때 exploreFollowUp (멀티소스 탐색의 보충 질문) 우선 표시
    const noResultMsg = exploreFollowUp
      ? exploreFollowUp
      : "관련 기록을 찾지 못했습니다. 다른 키워드로 시도해보세요.";
    reply = [metaLine, noResultMsg].filter(Boolean).join("\n\n");

    if (appealPointsResult?.followUpQuestions?.length > 0) {
      reply += "\n\n### 도움이 될 질문\n" +
        appealPointsResult.followUpQuestions.map((q) => `• ${q}`).join("\n");
    }
  } else if (evidence === null) {
    reply = [
      metaLine,
      `질의를 받았습니다: "${query}"`,
      "키워드를 입력하시면 커밋/슬랙/세션 메모에서 관련 근거를 찾아 어필 포인트를 제안해드립니다.",
    ].filter(Boolean).join("\n\n");
  } else {
    const sourceSummary = _buildSourceSummary(evidence, sourceMeta);
    reply = [
      metaLine,
      sourceSummary,
      "어필 포인트 생성 중 문제가 발생했습니다. 잠시 후 다시 시도해보세요.",
    ].filter(Boolean).join("\n\n");
  }

  // Sub-AC 4-2: 출처 정보를 정규화하여 citations 필드로 응답에 첨부
  const chatCitations = rankedEvidence
    ? buildChatCitations(rankedEvidence, appealPointsResult)
    : evidence
      ? buildCitationsFromEvidenceResult(evidence)
      : null;

  return c.json({
    reply,
    sessionId,
    parsedQuery,
    // AC 3 Sub-AC 1: 서버 사이드 분석 메타데이터 (기술스택, 신뢰도, 보충 질문 필요 여부)
    queryAnalysis: {
      techStack: analyzed.techStack,
      confidence: analyzed.confidence,
      needsClarification: analyzed.needsClarification,
      clarificationHint: analyzed.clarificationHint,
      sourceParams: analyzed.sourceParams,
    },
    evidence,
    rankedEvidence,
    // Sub-AC 4-2: 정규화된 출처 정보 (ChatCitation[]) — 프론트엔드 렌더링 최적화
    citations: chatCitations,
    // Sub-AC 4-2: 소스별 건수 요약 (refine-section·search-evidence·recommend 와 일관성)
    citationSummary: chatCitations ? buildSourceSummary(chatCitations) : null,
    sourceSummary: chatCitations ? buildSourceSummary(chatCitations) : null,
    // AC 3 Sub-AC 2: 소스별 탐색 메타데이터 (검색 여부, 결과 수, 사용 키워드, 건너뛰기 이유)
    sourceMeta: sourceMeta ?? null,
    appealPoints: appealPointsResult,
    // Sub-AC 3-3: 클러스터 기반 어필 포인트 제안 세트
    // (clusterSummary, followUpQuestions, totalEvidence 포함)
    suggestions: suggestions ?? null,
    applyIntent: applyIntentResult,
  });
});

/**
 * evidence 결과에서 소스별 건수 요약 문자열을 생성한다.
 * sourceMeta가 있으면 건너뛰기 정보도 포함한다.
 *
 * @param {{ commits: any[], slack: any[], sessions: any[], totalCount: number }|null} evidence
 * @param {{ commits?: import('../lib/resumeChatExplore.mjs').SourceMeta, slack?: import('../lib/resumeChatExplore.mjs').SourceMeta, sessions?: import('../lib/resumeChatExplore.mjs').SourceMeta }|null} [meta]
 * @returns {string}
 */
function _buildSourceSummary(evidence, meta) {
  if (!evidence || evidence.totalCount === 0) return "";
  const parts = [];
  if (evidence.commits.length > 0)  parts.push(`커밋 ${evidence.commits.length}건`);
  if (evidence.slack.length > 0)    parts.push(`슬랙 ${evidence.slack.length}건`);
  if (evidence.sessions.length > 0) parts.push(`세션 메모리 ${evidence.sessions.length}건`);

  // sourceMeta에서 건너뛴 소스 정보 추가
  if (meta) {
    const skipped = [];
    if (meta.commits && !meta.commits.searched && meta.commits.skipReason) skipped.push("커밋");
    if (meta.slack && !meta.slack.searched && meta.slack.skipReason) skipped.push("슬랙");
    if (meta.sessions && !meta.sessions.searched && meta.sessions.skipReason) skipped.push("세션");
    if (skipped.length > 0) {
      parts.push(`(${skipped.join("·")} 건너뜀)`);
    }
  }

  return parts.length > 0
    ? `데이터 소스에서 관련 기록을 찾았습니다: ${parts.join(", ")}`
    : "";
}

/**
 * parsedQuery 가 없거나 intent 가 누락된 경우를 위한 "반영해줘" 패턴 폴백 검사.
 * resumeChatApplyIntent.mjs 의 detectApplyIntent 와 동일한 패턴을 사용한다.
 *
 * @param {string} query
 * @returns {boolean}
 */
function _detectApplyPatternFallback(query) {
  if (!query) return false;
  return [
    /반영해\s*줘/, /반영해\s*주세요/, /반영\s*해줘/,
    /적용해\s*줘/, /적용해\s*주세요/, /이대로\s*반영/, /이대로\s*적용/,
  ].some((p) => p.test(query));
}

/**
 * ApplyIntentResult 를 사람이 읽을 수 있는 Markdown 채팅 응답으로 변환한다.
 *
 * 변경 내용이 있고 섹션이 확정된 경우에만 호출된다.
 *
 * @param {import('../lib/resumeChatApplyIntent.mjs').ApplyIntentResult} result
 * @returns {string}
 */
function _buildApplyIntentReply(result) {
  const SECTION_LABELS = {
    experience: "경력/경험",
    skills:     "기술",
    summary:    "자기소개/요약",
    education:  "학력",
    projects:   "프로젝트",
    strengths:  "강점",  // Sub-AC 8-1
  };
  const sectionLabel = result.section
    ? SECTION_LABELS[result.section] ?? result.section
    : "이력서";

  const changeLines = result.changes
    .slice(0, 10) // 최대 10개 표시
    .map((ch, i) => {
      const prefix = ch.type === "bullet" ? `- ` : ``;
      const ctx = ch.context ? ` _(${ch.context})_` : "";
      return `${prefix}${ch.content}${ctx}`;
    })
    .join("\n");

  const confidenceNote =
    result.confidence >= 0.8
      ? ""
      : `\n\n_(신뢰도 ${Math.round(result.confidence * 100)}% — 섹션이나 내용이 불명확하면 직접 지정해주세요)_`;

  return [
    `**[이력서 반영 준비]** 아래 내용을 **${sectionLabel}** 섹션에 반영할까요?`,
    "",
    changeLines,
    "",
    "반영하려면 **승인**, 취소하려면 **거절**을 눌러주세요.",
    confidenceNote,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

// ─── PATCH /api/resume/section ───────────────────────────────────────────────

/**
 * 채팅 diff 승인 시 이력서 섹션을 업데이트한다 (Sub-AC 6-2).
 *
 * 사용자가 ResumeDiffViewer 에서 "승인" 버튼을 클릭하면 프론트엔드가 이 엔드포인트를 호출해
 * diff 의 after 텍스트를 이력서에 반영한다.
 *
 * Request body (JSON):
 *   section    — string   섹션 이름 ('summary' | 'experience' | 'skills' | 'projects' | 'education')
 *   content    — string   diff after 텍스트 (적용할 내용)
 *   messageId  — string   (optional) 채팅 메시지 ID (로깅용)
 *   sessionId  — string   (optional) 채팅 세션 ID (로깅용)
 *
 * Response (200):
 *   { ok: true, resume: ResumeDocument, section: string, appliedAt: string }
 *
 * 오류:
 *   400  { error: string }  — 필수 필드 누락 또는 섹션 이름 오류
 *   404  { error: string }  — 이력서 없음
 *   502  { error: string }  — Blob 오류
 *   500  { error: string }  — 서버 오류
 */
resumeRouter.patch("/section", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "JSON body required" }, 400);

  const { section, content, messageId, sessionId } = body;

  if (!section || typeof section !== "string") {
    return c.json({ error: "section 필드가 필요합니다." }, 400);
  }
  if (content === undefined || content === null) {
    return c.json({ error: "content 필드가 필요합니다." }, 400);
  }

  // Sub-AC 8-1: 강점(strengths) 섹션 추가
  const VALID_SECTIONS = ["summary", "experience", "skills", "projects", "education", "certifications", "strengths"];
  if (!VALID_SECTIONS.includes(section)) {
    return c.json({ error: `지원하지 않는 섹션입니다: ${section}` }, 400);
  }

  // ── 강점 섹션 전용 처리 (Sub-AC 8-1) ──────────────────────────────────────────
  // 강점 섹션은 두 가지 content 형태를 지원한다:
  //   1. JSON.stringify(StrengthItem[])  — generateStrengthsChatDiff 결과 승인 시
  //   2. "- keyword1\n- keyword2\n..."   — apply_section 흐름에서 keyword diff 승인 시
  if (section === "strengths") {
    const contentStr = typeof content === "string" ? content.trim() : "";
    const looksLikeJson = contentStr.startsWith("[");

    // ── 형태 2: 불릿 텍스트 (apply_section → strength_keywords 업데이트) ──────
    if (!looksLikeJson) {
      const keywords = contentStr
        .split("\n")
        .map((l) => l.replace(/^[-•*]\s*/, "").trim())
        .filter(Boolean);

      if (keywords.length === 0) {
        return c.json({ error: "strengths content 가 비어 있습니다." }, 400);
      }

      // 스냅샷 (비치명적)
      try {
        const snap = await readResumeData();
        if (snap) await saveSnapshot(snap, { label: "pre-chat-strengths-kw-approve", triggeredBy: "chat_approve_strengths" });
      } catch (se) {
        console.warn("[resume/section PATCH strengths-kw] snapshot failed:", se);
      }

      // 기존 키워드와 병합
      const kwDoc = await (async () => { try { return await readStrengthKeywords(); } catch { return null; } })();
      const existingKws = Array.isArray(kwDoc?.keywords) ? kwDoc.keywords : [];
      const merged = [...new Set([...existingKws, ...keywords])].slice(0, 50);
      const updatedKwDoc = { schemaVersion: 1, updatedAt: new Date().toISOString(), source: "user", keywords: merged };

      try {
        await saveStrengthKeywords(updatedKwDoc);
      } catch (err) {
        console.error("[resume/section PATCH strengths-kw] saveStrengthKeywords failed:", err);
        return c.json({ error: "강점 키워드 저장 실패" }, 500);
      }

      // resume/data.json 에도 sync
      try {
        const resumeForSync = await readResumeData();
        if (resumeForSync) {
          await saveResumeData({
            ...resumeForSync,
            strength_keywords: merged,
            _sources: { ...(resumeForSync._sources ?? {}), strength_keywords: "user_approved" },
          });
        }
      } catch (syncErr) {
        console.warn("[resume/section PATCH strengths-kw] resume sync failed (non-fatal):", syncErr.message);
      }

      console.info(`[resume/section PATCH strengths-kw] +${keywords.length} keywords (total=${merged.length}). messageId=${messageId ?? "?"}`);
      return c.json({ ok: true, section, keywordsAdded: keywords.length, totalKeywords: merged.length, appliedAt: new Date().toISOString() });
    }

    // ── 형태 1: JSON 배열 (generateStrengthsChatDiff → identified-strengths.json) ──
    let strengthsItems;
    try {
      strengthsItems = JSON.parse(contentStr);
      if (!Array.isArray(strengthsItems)) throw new Error("Not an array");
    } catch (parseErr) {
      return c.json({ error: `strengths JSON content 파싱 실패: ${parseErr.message}` }, 400);
    }

    // 스냅샷 저장 (비치명적)
    try {
      const currentResume = await readResumeData();
      if (currentResume) {
        await saveSnapshot(currentResume, { label: "pre-chat-strengths-approve", triggeredBy: "chat_approve_strengths" });
      }
    } catch (snapshotErr) {
      console.warn("[resume/section PATCH strengths] snapshot failed (non-fatal):", snapshotErr);
    }

    // StrengthItem[] → StrengthsDocument 형태로 저장
    const strengthsDoc = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      source: "user_approved",
      strengths: strengthsItems.map((s, i) => ({
        id: s.id ?? `str-chat-${i + 1}`,
        label: s.label ?? "",
        description: s.description ?? "",
        frequency: s.frequency ?? 1,
        confidence: s.confidence ?? 0.7,
        behaviorCluster: s.behaviorCluster ?? [],
        evidenceExamples: s.evidenceTexts ?? [],
        _source: "user_approved",
      })),
      totalEpisodes: strengthsItems.reduce((sum, s) => sum + (s.frequency ?? 1), 0),
      totalProjects: 0,
    };

    try {
      await saveIdentifiedStrengths(strengthsDoc);
    } catch (err) {
      console.error("[resume/section PATCH strengths] saveIdentifiedStrengths failed:", err);
      return c.json({ error: "강점 저장 실패" }, 500);
    }

    console.info(
      `[resume/section PATCH strengths] ${strengthsItems.length}개 강점 저장 완료. ` +
      `messageId=${messageId ?? "?"}, sessionId=${sessionId ?? "?"}`
    );

    return c.json({
      ok: true,
      section,
      strengthsCount: strengthsItems.length,
      appliedAt: new Date().toISOString(),
    });
  }

  // ── 1. 현재 이력서 로드 ──────────────────────────────────────────────────────
  let resume;
  try {
    resume = await readResumeData();
  } catch (err) {
    console.error("[resume/section PATCH] readResumeData failed:", err);
    return c.json({ error: "이력서를 불러오지 못했습니다.", detail: err.message }, 502);
  }
  if (!resume) {
    return c.json({ error: "이력서가 없습니다. 먼저 이력서를 등록해주세요." }, 404);
  }

  // ── 2. 스냅샷 저장 (롤백 기준점, 비치명적) ──────────────────────────────────
  try {
    await saveSnapshot(resume, { label: "pre-chat-approve", triggeredBy: "chat_approve" });
  } catch (snapshotErr) {
    console.warn("[resume/section PATCH] snapshot failed (non-fatal):", snapshotErr);
  }

  // ── 3. content 파싱 및 섹션 적용 ────────────────────────────────────────────
  let updatedResume;
  try {
    updatedResume = _applyDiffContentToSection(resume, section, content);
  } catch (err) {
    console.error("[resume/section PATCH] applyDiff failed:", err);
    return c.json({ error: `섹션 업데이트 실패: ${err.message}` }, 400);
  }

  // ── 4. 저장 ──────────────────────────────────────────────────────────────────
  try {
    await saveResumeData(updatedResume);
  } catch (err) {
    console.error("[resume/section PATCH] saveResumeData failed:", err);
    return c.json({ error: "이력서 저장 실패" }, 500);
  }

  console.info(
    `[resume/section PATCH] section=${section} applied. messageId=${messageId ?? "?"}, sessionId=${sessionId ?? "?"}`
  );

  return c.json({
    ok: true,
    resume: updatedResume,
    section,
    appliedAt: new Date().toISOString(),
  });
});

/**
 * diff after 텍스트를 이력서 섹션에 적용한다 (Sub-AC 6-2).
 *
 * section 별 적용 규칙:
 *   summary    — content 를 새 요약으로 설정 (전체 교체)
 *   experience — 줄 단위 불릿을 파싱해 가장 최근 경력 항목의 불릿을 교체
 *   projects   — 줄 단위 불릿을 파싱해 가장 최근 프로젝트의 불릿을 교체
 *   skills     — 줄 단위 기술명을 파싱해 technical 목록에 병합 (중복 제거)
 *   education  — 첫 번째 학력 항목의 _source 만 user_approved 로 업데이트
 *
 * @param {object} resume   현재 이력서 문서 (불변)
 * @param {string} section  대상 섹션 이름
 * @param {string} content  diff after 텍스트 (적용할 내용)
 * @returns {object}        업데이트된 이력서 문서 (shallow clone)
 * @throws {Error}          섹션 데이터가 없거나 형식이 잘못된 경우
 */
function _applyDiffContentToSection(resume, section, content) {
  const updated = { ...resume };

  switch (section) {
    case "summary": {
      // 전체 요약을 새 content 로 교체한다
      updated.summary = typeof content === "string" ? content.trim() : String(content).trim();
      if (updated._sources) {
        updated._sources = { ...updated._sources, summary: "user_approved" };
      }
      break;
    }

    case "experience": {
      if (!Array.isArray(resume.experience) || resume.experience.length === 0) {
        throw new Error("이력서에 경력 항목이 없습니다.");
      }
      const bullets = _parseBulletLines(content);
      const entries = resume.experience.map((e, i) => ({ ...e }));
      // 가장 최근(index 0) 경력 항목의 불릿을 교체한다
      entries[0] = { ...entries[0], bullets, _source: "user_approved" };
      updated.experience = entries;
      break;
    }

    case "projects": {
      if (!Array.isArray(resume.projects) || resume.projects.length === 0) {
        throw new Error("이력서에 프로젝트 항목이 없습니다.");
      }
      const bullets = _parseBulletLines(content);
      const entries = resume.projects.map((e) => ({ ...e }));
      // 가장 최근(index 0) 프로젝트의 불릿을 교체한다
      entries[0] = { ...entries[0], bullets, _source: "user_approved" };
      updated.projects = entries;
      break;
    }

    case "skills": {
      const parsedSkills = _parseSkillLines(content);
      const existing = resume.skills ?? { technical: [], languages: [], tools: [] };
      // 이미 다른 카테고리(languages, tools)에 존재하는 기술은 technical 에 중복 추가하지 않는다.
      // content 는 diff.after (all existing + new) 로 전달되므로,
      // 기존 어떤 카테고리에도 없는 순수 신규 기술만 technical 에 추가한다.
      const allExistingSet = new Set([
        ...((existing.technical) ?? []),
        ...((existing.languages) ?? []),
        ...((existing.tools) ?? []),
      ]);
      const brandNewSkills = parsedSkills.filter((s) => !allExistingSet.has(s));
      const deduped = [...new Set([...((existing.technical) ?? []), ...brandNewSkills])];
      updated.skills = { ...existing, technical: deduped };
      if (updated._sources) {
        updated._sources = { ...updated._sources, skills: "user_approved" };
      }
      break;
    }

    case "education": {
      // education 은 채팅에서 직접 편집을 최소화한다
      // _source 만 user_approved 로 업데이트한다
      if (Array.isArray(resume.education) && resume.education.length > 0) {
        const entries = resume.education.map((e) => ({ ...e }));
        entries[0] = { ...entries[0], _source: "user_approved" };
        updated.education = entries;
      }
      break;
    }

    case "certifications": {
      // certifications 도 education 과 동일하게 처리
      if (Array.isArray(resume.certifications) && resume.certifications.length > 0) {
        const entries = resume.certifications.map((e) => ({ ...e }));
        updated.certifications = entries;
      }
      break;
    }

    default:
      throw new Error(`지원하지 않는 섹션: ${section}`);
  }

  return updated;
}

/**
 * 텍스트에서 불릿 줄만 추출해 순수 텍스트 배열로 반환한다.
 *
 * 처리 형식:
 *   "- 텍스트", "• 텍스트", "* 텍스트", "1. 텍스트", "1) 텍스트"
 * 일치하지 않는 줄은 그대로 포함한다 (비어있지 않은 경우).
 *
 * @param {string} text
 * @returns {string[]}
 */
function _parseBulletLines(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // 불릿 접두사 제거: "- ", "• ", "* ", "1. ", "1) " 등
    .map((line) => line.replace(/^(?:[-•*]|\d+[.)]\s*)\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * 텍스트에서 기술 이름 목록을 추출한다.
 * 불릿 줄을 파싱하고, 쉼표로 구분된 기술명도 지원한다.
 *
 * @param {string} text
 * @returns {string[]}
 */
function _parseSkillLines(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^(?:[-•*]|\d+[.)]\s*)\s*/, "").trim());

  const skills = [];
  for (const line of lines) {
    if (line.includes(",")) {
      skills.push(...line.split(",").map((s) => s.trim()).filter(Boolean));
    } else {
      skills.push(line);
    }
  }
  return skills.filter((s) => s.length > 0);
}

/**
 * applyIntent 결과와 현재 이력서에서 ResumeDiffViewer 용 diff 객체를 생성한다 (Sub-AC 6-2).
 *
 * section 별 before/after 포맷:
 *   summary    — 단순 텍스트 (전체 요약)
 *   experience — 가장 최근 경력 항목의 불릿 목록 ("- " 접두사)
 *   projects   — 가장 최근 프로젝트의 불릿 목록 ("- " 접두사)
 *   skills     — 기술 전체 목록 ("- " 접두사)
 *
 * @param {object|null} resume  현재 이력서 (null 이면 null 반환)
 * @param {import('../lib/resumeChatApplyIntent.mjs').ApplyIntentResult} applyIntentResult
 * @returns {{ section: string, before: string, after: string, evidence: string[] } | null}
 */
function _buildDiffFromApplyIntent(resume, applyIntentResult) {
  if (
    !applyIntentResult ||
    !applyIntentResult.section ||
    applyIntentResult.changes.length === 0
  ) {
    return null;
  }

  const { section, changes } = applyIntentResult;
  let before = "";
  let after = "";

  if (section === "summary") {
    before = (resume?.summary ?? "").trim();
    const summaryChange = changes.find((c) => c.type === "summary" || c.type === "text");
    if (summaryChange) {
      after = summaryChange.content.trim();
    } else {
      const added = changes.map((c) => c.content).join("\n");
      after = before ? `${before}\n${added}` : added;
    }
  } else if (section === "experience") {
    const entry = Array.isArray(resume?.experience) ? resume.experience[0] : null;
    const existingBullets = Array.isArray(entry?.bullets) ? entry.bullets : [];
    before = existingBullets.map((b) => `- ${b}`).join("\n");
    const newBullets = changes
      .filter((c) => c.type === "bullet" || c.type === "text")
      .map((c) => c.content);
    after = [...existingBullets, ...newBullets].map((b) => `- ${b}`).join("\n");
  } else if (section === "projects") {
    const entry = Array.isArray(resume?.projects) ? resume.projects[0] : null;
    const existingBullets = Array.isArray(entry?.bullets) ? entry.bullets : [];
    before = existingBullets.map((b) => `- ${b}`).join("\n");
    const newBullets = changes
      .filter((c) => c.type === "bullet" || c.type === "text")
      .map((c) => c.content);
    after = [...existingBullets, ...newBullets].map((b) => `- ${b}`).join("\n");
  } else if (section === "skills") {
    const existing = resume?.skills ?? { technical: [], languages: [], tools: [] };
    const allExisting = [
      ...((existing.technical) ?? []),
      ...((existing.languages) ?? []),
      ...((existing.tools) ?? []),
    ];
    before = allExisting.map((s) => `- ${s}`).join("\n");
    const newSkills = changes.map((c) => c.content);
    const allSkills = [...new Set([...allExisting, ...newSkills])];
    after = allSkills.map((s) => `- ${s}`).join("\n");
  } else if (section === "strengths") {
    // Sub-AC 8-1: 강점 섹션 — strength_keywords 불릿 형식으로 표시
    const existingKw = Array.isArray(resume?.strength_keywords) ? resume.strength_keywords : [];
    before = existingKw.map((k) => `- ${k}`).join("\n");
    const newKws = changes.map((c) => c.content);
    const allKws = [...new Set([...existingKw, ...newKws])];
    after = allKws.map((k) => `- ${k}`).join("\n");
  } else {
    // 기타 섹션: 변경 내용만 after 로 표시
    before = "";
    after = changes
      .map((c) => (c.type === "bullet" ? `- ${c.content}` : c.content))
      .join("\n");
  }

  return { section, before, after, evidence: [] };
}

// ─── GET /api/resume/chat/generate-draft ─────────────────────────────────────

/**
 * Return the most recently generated resume draft without regenerating.
 *
 * Responses:
 *   200  { "draft": ResumeDraft }  — draft exists
 *   404  { "exists": false }       — no draft generated yet
 */
resumeRouter.get("/chat/generate-draft", async (c) => {
  let draft;
  let draftContext = null;
  try {
    // Read draft and full context in parallel for richer chat UI initialization
    const [draftResult, contextResult] = await Promise.all([
      readChatDraft(),
      readChatDraftContext().catch(() => null),
    ]);
    draft = draftResult;
    draftContext = contextResult;
  } catch (err) {
    return c.json({ error: "Failed to read draft", detail: err.message }, 500);
  }

  if (!draft) {
    return c.json({ exists: false }, 404);
  }

  // Return draft with optional context (evidence pool + source breakdown)
  const response = { draft };
  if (draftContext) {
    response.evidencePool = draftContext.evidencePool || [];
    response.sourceBreakdown = draftContext.sourceBreakdown || null;
    response.dataGaps = draftContext.dataGaps || [];
  }

  return c.json(response);
});

// ─── POST /api/resume/chat/refine-section ─────────────────────────────────────

/**
 * 채팅 맥락에서 특정 이력서 섹션의 개선 제안을 근거 기반으로 생성한다.
 *
 * 이 엔드포인트는 resumeChatDraftService.refineSectionWithChat() 를 호출하여
 * 데이터 소스 근거에 기반한 불릿/요약/스킬 제안을 반환한다.
 * 근거 없이 허구를 생성하지 않으며, 데이터 부족 시 보충 질문을 반환한다.
 *
 * Request body:
 *   {
 *     "section":       string,               // "experience"|"skills"|"summary"|"strengths"|"projects"
 *     "user_message":  string,               // 사용자 요청
 *     "draft":         ResumeDraft | null,    // 기존 초안 (선택)
 *     "evidence_pool": EvidenceItem[] | null, // 근거 풀 (선택)
 *     "history":       { role, content }[],   // 대화 히스토리 (선택)
 *   }
 *
 * Response (200):
 *   {
 *     "section":        string,
 *     "suggestions":    RefinedSuggestion[],
 *     "evidenceCited":  EvidenceItem[],
 *     "clarifications": string[],
 *   }
 */
resumeRouter.post("/chat/refine-section", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.section !== "string" || !body.section.trim()) {
    return c.json({ error: "section is required" }, 400);
  }
  if (typeof body.user_message !== "string" || !body.user_message.trim()) {
    return c.json({ error: "user_message is required" }, 400);
  }

  const section = body.section.trim();
  const userMessage = body.user_message.trim();
  const draft = body.draft ?? null;
  const evidencePool = Array.isArray(body.evidence_pool) ? body.evidence_pool : [];
  const history = Array.isArray(body.history) ? body.history : [];

  // Load existing resume for context
  let existingResume = null;
  try {
    existingResume = await readResumeData();
  } catch {
    // Non-fatal — refinement works without existing resume
  }

  try {
    const result = await refineSectionWithChat({
      section,
      userMessage,
      draft,
      evidencePool,
      existingResume,
      history,
    });
    // Sub-AC 4-2: evidenceCited 를 정규화된 citations 으로도 반환
    const citations = Array.isArray(result.evidenceCited)
      ? result.evidenceCited.map((r) => buildCitationFromEvidence(r)).filter(Boolean)
      : [];
    return c.json({
      ...result,
      citations,
      sourceSummary: buildSourceSummary(citations),
    });
  } catch (err) {
    console.error("[resume/chat/refine-section] Failed:", err.message);
    return c.json({ error: "Section refinement failed", detail: err.message }, 500);
  }
});

// ─── POST /api/resume/chat/modify-section ──────────────────────────────────────

/**
 * AC 5 Sub-AC 2: 대화 컨텍스트에서 구체화된 내용을 기반으로
 * 이력서 JSON 의 해당 섹션을 수정한 새 JSON 을 생성한다.
 *
 * refine-section 에서 받은 RefinedSuggestion[] 또는 대화 히스토리를 입력으로 받아
 * 현재 이력서에 변경을 적용한 결과와 diff 를 반환한다.
 * 실제 저장은 하지 않으며, 프론트엔드에서 diff 확인 후 approve 시
 * PATCH /api/resume/json-diff-apply 로 영속한다.
 *
 * Request body:
 *   {
 *     "section":        string,               // "experience"|"skills"|"summary"|"strengths"|"projects"|"education"
 *     "suggestions":    RefinedSuggestion[],   // refineSectionWithChat 결과 (선택)
 *     "history":        { role, content }[],   // 대화 히스토리 (선택 — suggestions 없을 때 사용)
 *     "evidence_cited": string[],             // 인용 근거 (선택)
 *     "user_message":   string,               // 사용자 요청 원문 (선택)
 *   }
 *
 * Response (200):
 *   {
 *     "section":        string,
 *     "updatedDoc":     object,          // 수정된 이력서 JSON 전체
 *     "diff":           SectionDiff|null, // before/after 텍스트 diff
 *     "appliedChanges": AppliedChange[], // 반영된 변경 목록
 *     "skippedChanges": SkippedChange[], // 스킵된 변경 (사유 포함)
 *     "evidence":       string[],        // 통합된 근거
 *     "confidence":     number,          // 변경 신뢰도 (0.0–1.0)
 *   }
 */
resumeRouter.post("/chat/modify-section", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.section !== "string" || !body.section.trim()) {
    return c.json({ error: "section is required" }, 400);
  }

  const section = body.section.trim();
  const suggestions = Array.isArray(body.suggestions) ? body.suggestions : undefined;
  const history = Array.isArray(body.history) ? body.history : undefined;
  const evidenceCited = Array.isArray(body.evidence_cited) ? body.evidence_cited : [];
  const userMessage = typeof body.user_message === "string" ? body.user_message.trim() : undefined;

  // suggestions 도 history 도 없으면 400
  if ((!suggestions || suggestions.length === 0) && (!history || history.length === 0)) {
    return c.json({ error: "suggestions 또는 history 중 하나는 필요합니다." }, 400);
  }

  // 현재 이력서 로드
  let existingResume = null;
  try {
    existingResume = await readResumeData();
  } catch (err) {
    console.error("[resume/chat/modify-section] readResumeData failed:", err);
    return c.json({ error: "이력서를 불러오지 못했습니다.", detail: err.message }, 502);
  }
  if (!existingResume) {
    return c.json({ error: "저장된 이력서가 없습니다. 먼저 온보딩을 완료하세요." }, 404);
  }

  try {
    const result = generateModifiedResume(existingResume, section, {
      suggestions,
      history,
      evidenceCited,
      userMessage,
    });

    return c.json({
      section: result.section,
      updatedDoc: result.updatedDoc,
      diff: result.diff,
      appliedChanges: result.appliedChanges,
      skippedChanges: result.skippedChanges,
      evidence: result.evidence,
      confidence: result.confidence,
    });
  } catch (err) {
    console.error("[resume/chat/modify-section] Failed:", err.message);
    return c.json({ error: "Section modification failed", detail: err.message }, 500);
  }
});

// ─── POST /api/resume/chat/search-evidence ─────────────────────────────────────

/**
 * 키워드 기반으로 모든 데이터 소스에서 이력서 근거를 검색한다.
 *
 * Request body:
 *   {
 *     "keywords":   string[],              // 검색 키워드
 *     "from_date":  string | undefined,     // 시작일 (YYYY-MM-DD)
 *     "to_date":    string | undefined,     // 종료일 (YYYY-MM-DD)
 *     "max_results": number | undefined     // 소스당 최대 결과 수 (기본 15)
 *   }
 *
 * Response (200):
 *   {
 *     "evidence":  EvidenceItem[],
 *     "citations": ChatCitation[],          // Sub-AC 4-2: 정규화된 출처 정보
 *     "sourceSummary": CitationSourceSummary // Sub-AC 4-2: 소스별 건수 요약
 *   }
 */
resumeRouter.post("/chat/search-evidence", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.keywords) || body.keywords.length === 0) {
    return c.json({ error: "keywords (non-empty array) is required" }, 400);
  }

  try {
    const evidence = await searchEvidenceByKeywords(body.keywords, {
      fromDate: body.from_date,
      toDate: body.to_date,
      maxResults: body.max_results,
    });
    // Sub-AC 4-2: 검색 결과에 정규화된 출처 메타데이터 첨부
    const citations = Array.isArray(evidence)
      ? evidence.map((r) => buildCitationFromEvidence(r)).filter(Boolean)
      : [];
    return c.json({
      evidence,
      citations,
      sourceSummary: buildSourceSummary(citations),
    });
  } catch (err) {
    console.error("[resume/chat/search-evidence] Failed:", err.message);
    return c.json({ error: "Evidence search failed", detail: err.message }, 500);
  }
});

// ─── POST /api/resume/chat/recommend ─────────────────────────────────────────

/**
 * 탐색된 데이터를 종합하여 이력서 어필 포인트(성과·기여·역량)를 추천한다.
 * (AC 3 Sub-AC 3: 통합 추천 엔진)
 *
 * 두 가지 호출 방식을 지원한다:
 *   1. query + keywords → 내부에서 탐색(explore) 후 추천 생성
 *   2. query + exploreResult → 이미 탐색된 결과에서 추천 생성
 *
 * Request body:
 *   {
 *     "query":          string,                    // 사용자 질의 (필수)
 *     "keywords":       string[] | undefined,      // 탐색 키워드 (방식 1)
 *     "exploreResult":  ExploreResult | undefined,  // 이미 탐색된 결과 (방식 2)
 *     "existingResume": object | undefined,        // 현재 이력서 (맥락용)
 *     "lang":           "ko" | "en" | undefined,
 *     "maxPoints":      number | undefined,        // 최대 추천 수 (기본 8)
 *     "forceStrategy":  "flat" | "cluster" | undefined,
 *   }
 *
 * Response (200):
 *   {
 *     "recommendations":   Recommendation[],
 *     "citations":         ChatCitation[],
 *     "sourceSummary":     CitationSourceSummary,
 *     "dataGaps":          string[],
 *     "followUpQuestions": string[],
 *     "strategy":          "flat" | "cluster",
 *     "totalEvidence":     number,
 *     "formatted":         string                  // Markdown 포맷 메시지
 *   }
 */
resumeRouter.post("/chat/recommend", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.query !== "string" || !body.query.trim()) {
    return c.json({ error: "query is required" }, 400);
  }

  const {
    query,
    keywords,
    exploreResult: clientExploreResult,
    existingResume,
    lang,
    maxPoints,
    forceStrategy,
  } = body;

  try {
    // 탐색 결과 확보: 클라이언트에서 전달받았으면 그대로, 아니면 키워드로 탐색
    let exploreResult = clientExploreResult;
    if (!exploreResult) {
      if (Array.isArray(keywords) && keywords.length > 0) {
        exploreResult = await exploreWithKeywords({ keywords });
      } else {
        // 쿼리 분석 후 탐색
        let analyzed;
        try {
          analyzed = await analyzeQueryWithLLM(query);
        } catch {
          analyzed = analyzeQuery(query);
        }
        exploreResult = await exploreWithQueryAnalysis(analyzed);
      }
    }

    // 추천 생성
    const result = await generateRecommendations(query, exploreResult, {
      existingResume: existingResume ?? null,
      lang: lang ?? "ko",
      maxPoints: maxPoints ?? undefined,
      forceStrategy: forceStrategy ?? undefined,
    });

    return c.json({
      ...result,
      formatted: formatRecommendations(result),
    });
  } catch (err) {
    console.error("[resume/chat/recommend] Failed:", err.message);
    return c.json({ error: "Recommendation failed", detail: err.message }, 500);
  }
});

// ─── POST /api/resume/chat/draft-section ───────────────────────────────────────

/**
 * 초안에서 특정 섹션에 해당하는 콘텐츠를 추출한다.
 *
 * Request body:
 *   {
 *     "section": string,   // "experience"|"skills"|"summary"|"strengths"|"projects"
 *     "draft":   ResumeDraft | null
 *   }
 *
 * Response (200):
 *   { "strengths": object[], "experiences": object[], "summary": string }
 */
resumeRouter.post("/chat/draft-section", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.section !== "string") {
    return c.json({ error: "section is required" }, 400);
  }

  const result = extractDraftContentForSection(body.draft ?? null, body.section.trim());
  return c.json(result);
});

// ─── PATCH /api/resume/json-diff-apply ────────────────────────────────────────
/**
 * 채팅 기반 이력서 JSON 전체 diff 승인 처리 (Sub-AC 5-3).
 *
 * ResumeJsonDiffViewer 에서 사용자가 "모두 승인"을 클릭하면 프론트엔드가
 * 이 엔드포인트로 수정된 이력서 JSON 전체를 전송한다.
 * 서버는 현재 이력서를 스냅샷으로 저장한 뒤, modified 의 각 섹션을
 * 현재 이력서에 병합하여 저장한다.
 *
 * Body: { modified: object }  — 수정된 이력서 JSON 전체
 *
 * Success: HTTP 200  { ok: true, resume: {...}, appliedAt: string }
 * Errors:  400 (body 없음 | modified 형식 오류) | 404 (저장된 이력서 없음) | 500
 */
resumeRouter.patch("/json-diff-apply", async (c) => {
  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "요청 본문이 유효한 JSON이 아닙니다." }, 400);
  }

  const incoming = body?.modified;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return c.json({ ok: false, error: "modified 객체가 필요합니다." }, 400);
  }

  // ── 2. 현재 이력서 로드 ──────────────────────────────────────────────────────
  let stored;
  try {
    stored = await readResumeData();
  } catch (err) {
    console.error("[resume/json-diff-apply] readResumeData failed:", err);
    return c.json({ ok: false, error: "이력서를 불러오지 못했습니다.", detail: err.message }, 502);
  }
  if (!stored) {
    return c.json({ ok: false, error: "저장된 이력서가 없습니다. 먼저 온보딩을 완료하세요." }, 404);
  }

  // ── 3. 스냅샷 저장 (롤백 기준점, 비치명적) ──────────────────────────────────
  try {
    await saveSnapshot(stored, { label: "pre-json-diff-apply", triggeredBy: "chat_json_diff_approve" });
  } catch (snapshotErr) {
    console.warn("[resume/json-diff-apply] snapshot failed (non-fatal):", snapshotErr);
  }

  // ── 4. 섹션별 병합 (변경된 섹션만 적용) ─────────────────────────────────────
  // modified 에 포함된 섹션만 덮어쓴다.
  // 메타데이터(_sources, _schema 등)는 현재 이력서 것을 유지하되, _sources는 갱신한다.
  const updatedSources = { ...(stored._sources ?? {}) };
  const updated = { ...stored };

  // contact
  if (incoming.contact !== undefined && typeof incoming.contact === "object") {
    updated.contact = { ...(stored.contact ?? {}), ...incoming.contact };
    updatedSources.contact = "chat_approved";
  }

  // summary
  if (typeof incoming.summary === "string") {
    updated.summary = incoming.summary.trim();
    updatedSources.summary = "chat_approved";
  }

  // experience
  if (Array.isArray(incoming.experience)) {
    updated.experience = incoming.experience.map((exp) => ({
      company:    exp.company    ?? "",
      title:      exp.title      ?? "",
      start_date: exp.start_date ?? null,
      end_date:   exp.end_date   ?? null,
      location:   exp.location   ?? null,
      bullets:    Array.isArray(exp.bullets) ? exp.bullets.filter((b) => typeof b === "string") : [],
      _source:    "chat_approved",
    }));
    updatedSources.experience = "chat_approved";
  }

  // education
  if (Array.isArray(incoming.education)) {
    updated.education = incoming.education.map((edu) => ({
      institution: edu.institution ?? "",
      degree:      edu.degree      ?? "",
      field:       edu.field       ?? "",
      start_date:  edu.start_date  ?? null,
      end_date:    edu.end_date    ?? null,
      gpa:         edu.gpa         ?? null,
      _source:     "chat_approved",
    }));
    updatedSources.education = "chat_approved";
  }

  // skills
  if (incoming.skills !== undefined && typeof incoming.skills === "object" && !Array.isArray(incoming.skills)) {
    updated.skills = {
      technical: Array.isArray(incoming.skills.technical) ? incoming.skills.technical.filter((s) => typeof s === "string") : (stored.skills?.technical ?? []),
      languages: Array.isArray(incoming.skills.languages) ? incoming.skills.languages.filter((s) => typeof s === "string") : (stored.skills?.languages ?? []),
      tools:     Array.isArray(incoming.skills.tools)     ? incoming.skills.tools.filter((s) => typeof s === "string")     : (stored.skills?.tools ?? []),
    };
    updatedSources.skills = "chat_approved";
  }

  // projects
  if (Array.isArray(incoming.projects)) {
    updated.projects = incoming.projects.map((proj) => ({
      name:        proj.name        ?? proj.title ?? "",
      title:       proj.title       ?? proj.name  ?? "",
      description: proj.description ?? "",
      url:         proj.url         ?? "",
      tech_stack:  Array.isArray(proj.tech_stack) ? proj.tech_stack.filter((s) => typeof s === "string") : [],
      bullets:     Array.isArray(proj.bullets)    ? proj.bullets.filter((b) => typeof b === "string")    : [],
      _source:     "chat_approved",
    }));
    updatedSources.projects = "chat_approved";
  }

  // certifications
  if (Array.isArray(incoming.certifications)) {
    updated.certifications = incoming.certifications.map((cert) => ({
      name:        cert.name        ?? "",
      issuer:      cert.issuer      ?? "",
      date:        cert.date        ?? null,
      expiry_date: cert.expiry_date ?? null,
      url:         cert.url         ?? null,
      _source:     "chat_approved",
    }));
    updatedSources.certifications = "chat_approved";
  }

  // strength_keywords
  if (Array.isArray(incoming.strength_keywords)) {
    updated.strength_keywords = incoming.strength_keywords.filter((k) => typeof k === "string");
    updatedSources.strength_keywords = "chat_approved";
  }

  updated._sources = updatedSources;
  updated._updatedAt = new Date().toISOString();

  // ── 5. 저장 ────────────────────────────────────────────────────────────────
  try {
    await saveResumeData(updated);
  } catch (err) {
    console.error("[resume/json-diff-apply] saveResumeData failed:", err);
    return c.json({ ok: false, error: "이력서 저장 실패" }, 500);
  }

  console.info("[resume/json-diff-apply] Full JSON diff applied via chat approval.");

  return c.json({
    ok: true,
    resume: updated,
    appliedAt: new Date().toISOString(),
  });
});

// ─── Mount agent sub-router ──────────────────────────────────────────────────
resumeRouter.route("/", agentRouter);
