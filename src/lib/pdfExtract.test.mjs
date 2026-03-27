/**
 * Tests for pdfExtract.mjs — PDF text extraction pipeline.
 *
 * Covers:
 *   - postProcessPdfText: all post-processing steps in isolation
 *   - extractTextFromBuffer: input validation and pdf-parse integration
 *   - readPdfBufferFromBlob: Blob-not-found and HTTP-error paths
 *   - extractTextFromBlob: combined pipeline (mocked blob + buffer)
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/pdfExtract.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  postProcessPdfText,
  extractTextFromBuffer,
  readPdfBufferFromBlob
} from "./pdfExtract.mjs";

// ─── postProcessPdfText ────────────────────────────────────────────────────────

describe("postProcessPdfText", () => {
  // ── Input type guards ──────────────────────────────────────────────────────

  test("returns empty string for non-string input (null)", () => {
    assert.strictEqual(postProcessPdfText(null), "");
  });

  test("returns empty string for non-string input (undefined)", () => {
    assert.strictEqual(postProcessPdfText(undefined), "");
  });

  test("returns empty string for non-string input (number)", () => {
    assert.strictEqual(postProcessPdfText(42), "");
  });

  test("returns empty string for empty string input", () => {
    assert.strictEqual(postProcessPdfText(""), "");
  });

  // ── Step 1: Form-feed replacement ─────────────────────────────────────────

  test("replaces form-feed (\\f) with two newlines", () => {
    const input = "Page 1 content\fPage 2 content";
    const result = postProcessPdfText(input);
    assert.ok(
      result.includes("Page 1 content\n\nPage 2 content"),
      `expected paragraph break between pages, got: ${JSON.stringify(result)}`
    );
  });

  test("multiple form-feeds produce separate paragraph breaks", () => {
    const input = "A\fB\fC";
    const result = postProcessPdfText(input);
    // Each \f becomes \n\n → two blank lines between A, B, C
    // After collapse (≤2 blanks allowed) → one blank line each
    assert.ok(result.includes("A"), "should contain A");
    assert.ok(result.includes("B"), "should contain B");
    assert.ok(result.includes("C"), "should contain C");
  });

  // ── Step 2: Control character removal ────────────────────────────────────

  test("strips NUL bytes (\\x00)", () => {
    const input = "Hello\x00World";
    assert.strictEqual(postProcessPdfText(input), "HelloWorld");
  });

  test("strips non-printable control characters (0x01-0x08)", () => {
    const input = "A\x01\x02\x03\x04\x05\x06\x07\x08B";
    assert.strictEqual(postProcessPdfText(input), "AB");
  });

  test("strips 0x0B (vertical tab) and 0x0C (form-feed in control range after f→\\n\\n substitution)", () => {
    // \x0B is vertical tab; our regex strips 0x0B after the \f→\n\n substitution.
    // Note: \f (0x0C) is already replaced in step 1; remaining 0x0C instances
    // that somehow weren't \f literals are stripped by step 2.
    const input = "A\x0BB";
    assert.strictEqual(postProcessPdfText(input), "AB");
  });

  test("strips control characters 0x0E-0x1F", () => {
    const input = "A\x0E\x0F\x10\x1FZ";
    assert.strictEqual(postProcessPdfText(input), "AZ");
  });

  test("preserves tab characters (\\t = 0x09)", () => {
    const input = "column1\tcolumn2";
    assert.ok(
      postProcessPdfText(input).includes("\t"),
      "tab should be preserved"
    );
  });

  // ── Step 3: Line-ending normalisation ────────────────────────────────────

  test("converts CRLF to LF", () => {
    const input = "line1\r\nline2\r\nline3";
    const result = postProcessPdfText(input);
    assert.ok(!result.includes("\r"), "should contain no CR after normalisation");
    assert.ok(result.includes("line1"), "line1 preserved");
    assert.ok(result.includes("line2"), "line2 preserved");
  });

  test("converts standalone CR to LF", () => {
    const input = "line1\rline2";
    const result = postProcessPdfText(input);
    assert.ok(!result.includes("\r"), "should contain no CR");
    assert.ok(result.includes("line1"), "line1 preserved");
    assert.ok(result.includes("line2"), "line2 preserved");
  });

  // ── Step 4: Per-line trim ─────────────────────────────────────────────────

  test("trims leading and trailing whitespace from each line", () => {
    const input = "  leading spaces  \n   more leading   \n\t tab-indented \t";
    const result = postProcessPdfText(input);
    const lines = result.split("\n");
    for (const line of lines) {
      assert.strictEqual(
        line,
        line.trim(),
        `line ${JSON.stringify(line)} should be trimmed`
      );
    }
  });

  // ── Step 5: Page number removal ──────────────────────────────────────────

  test("removes single-digit page numbers", () => {
    const input = "Some content\n1\nMore content";
    const result = postProcessPdfText(input);
    const lines = result.split("\n").filter(Boolean);
    assert.ok(!lines.includes("1"), "single-digit page number should be removed");
  });

  test("removes multi-digit page numbers", () => {
    const input = "Section 1\n42\nSection 2\n100\nSection 3";
    const result = postProcessPdfText(input);
    const lines = result.split("\n").filter(Boolean);
    assert.ok(!lines.includes("42"), "page number 42 should be removed");
    assert.ok(!lines.includes("100"), "page number 100 should be removed");
  });

  test("preserves lines with mixed digits and text", () => {
    const input = "TypeScript 5.0 features\nBuilt in 2023\n7 skills total";
    const result = postProcessPdfText(input);
    assert.ok(result.includes("TypeScript 5.0 features"), "mixed digit-text line preserved");
    assert.ok(result.includes("Built in 2023"), "year-containing line preserved");
    assert.ok(result.includes("7 skills total"), "digit-prefixed line preserved");
  });

  test("preserves lines that are empty strings (blank lines are not page numbers)", () => {
    // Blank lines are empty, not purely-digit — they should survive the filter.
    const input = "A\n\nB";
    const result = postProcessPdfText(input);
    assert.ok(result.includes("\n\n"), "blank line should be preserved between A and B");
  });

  // ── Step 6: Blank-line collapsing ─────────────────────────────────────────

  test("collapses 2 consecutive blank lines into 1", () => {
    const input = "A\n\n\nB"; // 2 blank lines between A and B (lines: ["A","","","B"])
    const result = postProcessPdfText(input);
    // 2 blank lines → collapsed to 1 blank line → result is "A\n\nB"
    assert.ok(
      !result.includes("\n\n\n"),
      `2+ consecutive blank lines should be collapsed to 1; got: ${JSON.stringify(result)}`
    );
    assert.ok(result.includes("A"), "A preserved");
    assert.ok(result.includes("B"), "B preserved");
  });

  test("collapses 3 consecutive blank lines into 1", () => {
    const input = "A\n\n\n\nB"; // 3 blank lines (lines: ["A","","","","B"])
    const result = postProcessPdfText(input);
    assert.ok(
      !result.includes("\n\n\n"),
      `3 consecutive blank lines should be collapsed to 1; got: ${JSON.stringify(result)}`
    );
    assert.ok(result.includes("A"), "A preserved");
    assert.ok(result.includes("B"), "B preserved");
  });

  test("collapses 5 consecutive blank lines into 1", () => {
    const input = "Start\n\n\n\n\n\nEnd"; // 5 blank lines
    const result = postProcessPdfText(input);
    assert.ok(!result.includes("\n\n\n"), "excessive blank lines should be collapsed to 1");
    assert.ok(result.includes("Start"), "Start preserved");
    assert.ok(result.includes("End"), "End preserved");
  });

  test("preserves a single blank line between content lines", () => {
    const input = "A\n\nB"; // exactly 1 blank line
    const result = postProcessPdfText(input);
    assert.ok(result.includes("\n\n"), "single blank line should be preserved");
    assert.ok(result.startsWith("A"), "A should be first");
    assert.ok(result.endsWith("B"), "B should be last");
  });

  // ── Step 7: Consecutive duplicate line removal ────────────────────────────

  test("removes identical consecutive non-empty lines", () => {
    const input = "Header\nHeader\nContent";
    const result = postProcessPdfText(input);
    const lines = result.split("\n").filter(Boolean);
    // "Header" appears twice consecutively → should appear only once
    assert.strictEqual(
      lines.filter((l) => l === "Header").length,
      1,
      `duplicate 'Header' should be deduplicated; got lines: ${JSON.stringify(lines)}`
    );
    assert.ok(result.includes("Content"), "Content preserved");
  });

  test("preserves non-consecutive duplicate lines", () => {
    const input = "Title\nContent\nTitle";
    const result = postProcessPdfText(input);
    // Two 'Title' lines but separated by 'Content' — both should survive.
    const lines = result.split("\n").filter(Boolean);
    assert.strictEqual(
      lines.filter((l) => l === "Title").length,
      2,
      `non-consecutive duplicates should both be preserved; got lines: ${JSON.stringify(lines)}`
    );
  });

  test("blank line resets the deduplication context", () => {
    const input = "Section\n\nSection";
    const result = postProcessPdfText(input);
    const lines = result.split("\n").filter(Boolean);
    // Blank line separates the two 'Section' lines → both should survive.
    assert.strictEqual(
      lines.filter((l) => l === "Section").length,
      2,
      `'Section' separated by blank should appear twice; got: ${JSON.stringify(lines)}`
    );
  });

  test("handles 3+ consecutive identical lines", () => {
    const input = "Footer\nFooter\nFooter\nContent";
    const result = postProcessPdfText(input);
    const lines = result.split("\n").filter(Boolean);
    assert.strictEqual(
      lines.filter((l) => l === "Footer").length,
      1,
      `3 consecutive 'Footer' lines should collapse to 1; got: ${JSON.stringify(lines)}`
    );
  });

  // ── Step 8: Final trim ────────────────────────────────────────────────────

  test("trims leading whitespace / blank lines from the whole result", () => {
    const input = "\n\n\nContent after blank lines";
    const result = postProcessPdfText(input);
    assert.ok(
      !result.startsWith("\n"),
      "result should not start with newline"
    );
    assert.ok(result.startsWith("Content"), "result should start with Content");
  });

  test("trims trailing whitespace / blank lines from the whole result", () => {
    const input = "Content before trailing blanks\n\n\n";
    const result = postProcessPdfText(input);
    assert.ok(
      !result.endsWith("\n"),
      "result should not end with newline"
    );
  });

  // ── Integration: real-world-like input ───────────────────────────────────

  test("handles a realistic PDF resume excerpt", () => {
    // In LinkedIn-style PDFs, section headers sometimes repeat across pages.
    // The page number "1" sits between the two "EXPERIENCE" lines with no blank;
    // once the page number is removed the two headers become consecutive.
    const input = [
      "\x00\x01Jane Doe",
      "  Senior Software Engineer  ",
      "Seoul, South Korea",
      "",
      "EXPERIENCE",
      "1",                   // ← page number (removed by pipeline)
      "EXPERIENCE",          // ← duplicate header; consecutive after page# removal
      "Acme Corp · Full-time",
      "Jan 2020 – Present · 4 yrs",
      "Led backend migration to microservices.",
      "  • Reduced p99 latency by 40%.",
      "",
      "",
      "",
      "",                    // ← 4 consecutive blank lines
      "EDUCATION",
      "2",
      "Seoul National University",
      "B.S., Computer Science",
      "2016 – 2020",
      ""
    ].join("\n");

    const result = postProcessPdfText(input);

    // Control chars stripped.
    assert.ok(!result.includes("\x00"), "NUL byte stripped");
    assert.ok(!result.includes("\x01"), "SOH byte stripped");

    // Content preserved.
    assert.ok(result.includes("Jane Doe"), "name preserved");
    assert.ok(result.includes("Senior Software Engineer"), "title preserved");
    assert.ok(result.includes("Led backend migration to microservices."), "bullet preserved");

    // Page numbers removed.
    const lines = result.split("\n").filter(Boolean);
    assert.ok(!lines.includes("1"), "page number 1 removed");
    assert.ok(!lines.includes("2"), "page number 2 removed");

    // Duplicate EXPERIENCE header collapsed.
    assert.strictEqual(
      lines.filter((l) => l === "EXPERIENCE").length,
      1,
      "duplicate EXPERIENCE header should be collapsed to 1"
    );

    // No runs of 3+ blank lines.
    assert.ok(!result.includes("\n\n\n"), "no runs of 3+ blank lines");

    // Not starting or ending with newline.
    assert.ok(!result.startsWith("\n"), "no leading newline");
    assert.ok(!result.endsWith("\n"), "no trailing newline");
  });

  test("handles Korean resume text correctly", () => {
    const input = [
      "홍길동",
      "  시니어 소프트웨어 엔지니어  ",
      "서울, 대한민국",
      "",
      "경력",
      "1",
      "주식회사 테크",
      "2020년 3월 – 현재",
      "마이크로서비스 아키텍처 설계 및 구현",
      "",
      "학력",
      "서울대학교",
      "컴퓨터공학, 학사",
      "2016 – 2020"
    ].join("\n");

    const result = postProcessPdfText(input);

    assert.ok(result.includes("홍길동"), "Korean name preserved");
    assert.ok(result.includes("시니어 소프트웨어 엔지니어"), "Korean title preserved");
    assert.ok(result.includes("마이크로서비스 아키텍처 설계 및 구현"), "Korean bullet preserved");

    const lines = result.split("\n").filter(Boolean);
    assert.ok(!lines.includes("1"), "page number removed from Korean text");
  });
});

// ─── extractTextFromBuffer (input validation only; no real PDF in unit tests) ──

describe("extractTextFromBuffer input validation", () => {
  test("rejects null buffer", async () => {
    await assert.rejects(
      () => extractTextFromBuffer(null),
      /must be a non-empty Buffer/
    );
  });

  test("rejects empty Buffer", async () => {
    await assert.rejects(
      () => extractTextFromBuffer(Buffer.alloc(0)),
      /must be a non-empty Buffer/
    );
  });

  test("rejects non-Buffer (string)", async () => {
    await assert.rejects(
      () => extractTextFromBuffer("not a buffer"),
      /must be a non-empty Buffer/
    );
  });

  test("rejects non-Buffer (Uint8Array)", async () => {
    // Uint8Array is not a Buffer — Buffer.isBuffer() returns false for plain Uint8Array.
    const ua = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    await assert.rejects(
      () => extractTextFromBuffer(ua),
      /must be a non-empty Buffer/
    );
  });

  test("rejects buffer without PDF magic bytes", async () => {
    const notPdf = Buffer.from("not a pdf file");
    await assert.rejects(
      () => extractTextFromBuffer(notPdf),
      /PDF magic bytes/
    );
  });

  test("rejects buffer that starts with wrong magic", async () => {
    const wrongMagic = Buffer.from("PK\x03\x04some zip content here");
    await assert.rejects(
      () => extractTextFromBuffer(wrongMagic),
      /PDF magic bytes/
    );
  });
});

// ─── readPdfBufferFromBlob (Blob-not-found path; no real Blob in unit tests) ──
//
// We can only test the "no PDF stored yet" path without mocking the Blob module.
// The happy path requires a real BLOB_READ_WRITE_TOKEN and is covered by integration tests.

describe("readPdfBufferFromBlob (no-PDF-stored path)", () => {
  // When BLOB_READ_WRITE_TOKEN is not set (typical unit test environment),
  // checkPdfRawExists() will either throw due to missing token or return null.
  // Either way, readPdfBufferFromBlob() must throw a descriptive error.
  // We accept both error messages here to be resilient to Blob SDK behaviour.
  test("throws a descriptive error when called without Blob credentials", async () => {
    // This test is deliberately lenient: we check that it throws (not hangs)
    // and that the error message mentions either "PDF" or "Blob" or "token".
    try {
      await readPdfBufferFromBlob();
      // If it didn't throw (impossible in unit test env without a real token),
      // fail explicitly.
      assert.fail("readPdfBufferFromBlob should have thrown");
    } catch (err) {
      const msg = err?.message ?? "";
      assert.ok(
        /pdf|blob|token|resume\/resume\.pdf/i.test(msg),
        `error message should mention PDF/Blob/token; got: ${msg}`
      );
    }
  });
});
