/**
 * PDF text extraction pipeline.
 *
 * This module provides a focused, post-processing-aware PDF extraction
 * pipeline that is separate from the LLM generation logic in resumeLlm.mjs.
 * It handles the full path from Vercel Blob storage → Buffer → cleaned text.
 *
 * Exported functions:
 *   extractTextFromBuffer(buffer)  — run pdf-parse on a Buffer, then post-process
 *   readPdfBufferFromBlob()        — fetch the stored raw PDF from Vercel Blob → Buffer
 *   extractTextFromBlob()          — combined: readPdfBufferFromBlob + extractTextFromBuffer
 *   postProcessPdfText(rawText)    — standalone post-processing step (exported for testing)
 *
 * Post-processing pipeline:
 *   1. Strip NUL and other non-printable control characters (keep tab, LF, CR, FF→\n\n)
 *   2. Replace form-feed characters (\f) with a blank-line separator
 *   3. Trim each line individually
 *   4. Remove lines that are purely numeric (page numbers from PDF renderers)
 *   5. Collapse runs of ≥2 consecutive blank lines into a single blank line
 *   6. Deduplicate identical consecutive non-empty lines (scan/header artefacts)
 *   7. Final trim of the whole string
 *
 * Dependencies:
 *   pdf-parse  — CJS module, loaded via createRequire for ESM compatibility
 *   blob.mjs   — project-local Vercel Blob utilities
 *
 * Environment variable required (delegated to blob.mjs):
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob read/write token
 */

import { createRequire } from "node:module";
import { checkPdfRawExists } from "./blob.mjs";

const _require = createRequire(import.meta.url);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract and clean plain text from a PDF Buffer.
 *
 * Runs pdf-parse (CJS module) on the buffer and passes the raw output
 * through the full post-processing pipeline.
 *
 * @param {Buffer} buffer  Raw PDF binary data.
 * @returns {Promise<string>}  Cleaned plain text.
 * @throws {Error}  If the buffer is not a non-empty Buffer or is not a valid PDF.
 */
export async function extractTextFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("extractTextFromBuffer: buffer must be a non-empty Buffer");
  }

  // Sanity-check PDF magic bytes (%PDF-) before calling the parser.
  // This gives a clearer error than the cryptic pdf-parse internal errors.
  if (buffer.length < 5 || buffer.slice(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("extractTextFromBuffer: buffer does not start with PDF magic bytes (%PDF-)");
  }

  const pdfParse = _require("pdf-parse");
  const result = await pdfParse(buffer);
  const rawText = result.text ?? "";

  return postProcessPdfText(rawText);
}

/**
 * Fetch the raw PDF binary stored in Vercel Blob and return it as a Buffer.
 *
 * Uses `checkPdfRawExists()` from blob.mjs to locate the stored PDF, then
 * performs a plain HTTP fetch of the Blob URL to retrieve the binary content.
 *
 * @returns {Promise<Buffer>}  The raw PDF binary as a Node.js Buffer.
 * @throws {Error}  When no PDF has been stored yet, or the fetch fails.
 */
export async function readPdfBufferFromBlob() {
  const meta = await checkPdfRawExists();
  if (!meta) {
    throw new Error(
      "readPdfBufferFromBlob: no PDF found in Vercel Blob (resume/resume.pdf). " +
      "Upload a PDF via POST /api/resume/bootstrap first."
    );
  }

  const response = await fetch(meta.url);
  if (!response.ok) {
    throw new Error(
      `readPdfBufferFromBlob: failed to fetch PDF from Blob (HTTP ${response.status})`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Read the stored PDF from Vercel Blob and extract cleaned plain text.
 *
 * Convenience function that combines readPdfBufferFromBlob() and
 * extractTextFromBuffer() into a single call.
 *
 * @returns {Promise<string>}  Cleaned plain text extracted from the stored PDF.
 * @throws {Error}  If no PDF is stored, or if extraction fails.
 */
export async function extractTextFromBlob() {
  const buffer = await readPdfBufferFromBlob();
  return extractTextFromBuffer(buffer);
}

// ─── Post-processing pipeline ─────────────────────────────────────────────────

/**
 * Clean raw text produced by pdf-parse.
 *
 * This function is exported so it can be tested independently of the PDF
 * parsing step and reused in other contexts (e.g. LinkedIn PDF parsing).
 *
 * Processing steps (in order):
 *   1. Replace form-feed (\f) with \n\n so page breaks become paragraph breaks.
 *   2. Strip NUL bytes and other non-printable control characters
 *      (C0 range U+0000–U+001F, excluding \t U+0009, \n U+000A, \r U+000D).
 *   3. Normalize line endings: convert \r\n and standalone \r to \n.
 *   4. Split into lines; trim each line's leading/trailing whitespace.
 *   5. Remove lines that consist entirely of digits (PDF page number artefacts).
 *   6. Collapse two or more consecutive blank lines into a single blank line.
 *   7. Deduplicate identical consecutive non-empty lines (header/footer repeats).
 *   8. Re-join lines and perform a final trim.
 *
 * @param {string} rawText  Raw text as returned by pdf-parse's result.text.
 * @returns {string}  Cleaned text.
 */
export function postProcessPdfText(rawText) {
  if (typeof rawText !== "string") return "";

  // Step 1: Replace form-feed (\f) with double newline (page-break separator).
  let text = rawText.replace(/\f/g, "\n\n");

  // Step 2: Strip NUL and other non-printable control characters.
  // Keep: \t (0x09), \n (0x0A), \r (0x0D).
  // Remove: 0x00–0x08, 0x0B–0x0C, 0x0E–0x1F.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  // Step 3: Normalize line endings.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Step 4 & 5: Split into lines, trim each, remove pure-digit lines.
  const lines = text.split("\n").map((line) => line.trim());
  const withoutPageNumbers = lines.filter((line) => !/^\d+$/.test(line));

  // Step 6: Collapse 3+ consecutive blank lines into one blank line.
  const collapsed = collapseBlankLines(withoutPageNumbers);

  // Step 7: Deduplicate identical consecutive non-empty lines.
  const deduped = deduplicateConsecutiveLines(collapsed);

  // Step 8: Re-join and trim.
  return deduped.join("\n").trim();
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Collapse runs of ≥2 consecutive blank lines into exactly one blank line.
 *
 * PDF renderers often insert many blank lines between sections; reducing them
 * to a single blank line keeps the structure readable without producing long
 * stretches of whitespace in the extracted text.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function collapseBlankLines(lines) {
  const result = [];
  let consecutiveBlanks = 0;

  for (const line of lines) {
    if (line === "") {
      consecutiveBlanks++;
      // Allow at most 1 consecutive blank line (2+ collapse to 1).
      if (consecutiveBlanks <= 1) {
        result.push(line);
      }
    } else {
      consecutiveBlanks = 0;
      result.push(line);
    }
  }

  return result;
}

/**
 * Remove consecutive duplicate non-empty lines.
 *
 * This handles a common pdf-parse artefact where headers, footers, or
 * repeated section titles appear twice because they are rendered on every
 * page of the PDF.
 *
 * Blank lines are never considered duplicates (they are structural separators).
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function deduplicateConsecutiveLines(lines) {
  const result = [];
  let prevNonBlank = null;

  for (const line of lines) {
    if (line === "") {
      prevNonBlank = null; // Reset on blank line — allow re-occurrence after gap.
      result.push(line);
    } else if (line === prevNonBlank) {
      // Skip identical consecutive non-empty line.
      continue;
    } else {
      prevNonBlank = line;
      result.push(line);
    }
  }

  return result;
}
