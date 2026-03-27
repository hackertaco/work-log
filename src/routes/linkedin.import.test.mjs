/**
 * Integration tests for POST /api/linkedin/import and GET /api/linkedin/import.
 *
 * These tests exercise the full handler path including the Vercel Blob storage
 * calls (saveLinkedInImport, readLinkedInImport).  Because the linkedin.mjs
 * route imports blob.mjs at the top level, we MUST use Node.js built-in
 * mock.module() (available via --experimental-test-module-mocks) so the mock
 * is in place before the dynamic import of linkedin.mjs runs.
 *
 * Run:
 *   node --experimental-test-module-mocks --test src/routes/linkedin.import.test.mjs
 *
 * Early-exit validation tests (no blob calls) are covered by the sibling file
 * src/routes/linkedin.test.mjs which runs without the experimental flag.
 */

import assert from "node:assert/strict";
import { test, describe, mock } from "node:test";
import { Hono } from "hono";

// ─── Mutable stubs for blob functions ────────────────────────────────────────
//
// Each test reassigns _saveImpl / _readImpl to control the mock behaviour.
// The mock.module() factory delegates to these variables so that reassignment
// inside individual tests takes effect without re-mocking.

let _saveImpl = async () => ({ url: "https://blob.example/linkedin-import.json" });
let _readImpl = async () => null;

// ─── Module-level mock (must be declared before `await import(…)`) ───────────

mock.module("../lib/blob.mjs", {
  namedExports: {
    // LinkedIn import functions — delegated to mutable stubs.
    saveLinkedInImport: async (...args) => _saveImpl(...args),
    readLinkedInImport: async (...args) => _readImpl(...args),
    clearLinkedInImport: async () => {},
    LINKEDIN_IMPORT_PATHNAME: "resume/linkedin-import.json",

    // Resume functions — stubbed to no-ops so linkedin.mjs can import cleanly.
    checkResumeExists: async () => ({ exists: false }),
    saveResumeData: async () => ({ url: "https://blob.example/resume/data.json" }),
    readResumeData: async () => null,
    readSuggestionsData: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), suggestions: [] }),
    saveSuggestionsData: async () => ({ url: "https://blob.example/resume/suggestions.json" }),
    saveDailyBullets: async () => ({ url: "https://blob.example/resume/bullets/test.json" }),
    readDailyBullets: async () => null,
    listBulletDates: async () => [],
    deleteDailyBullets: async () => {},
    savePdfText: async () => ({ url: "https://blob.example/resume/pdf-text.txt" }),
    readPdfText: async () => null,
    savePdfRaw: async () => ({ url: "https://blob.example/resume/resume.pdf" }),
    checkPdfRawExists: async () => null,
    markResumeForReconstruction: async () => {},
    clearReconstructionMarker: async () => {},
    checkReconstructionMarker: async () => ({ needsRebuild: false }),
    saveKeywordClusterAxes: async () => ({ url: "https://blob.example/resume/keyword-cluster-axes.json" }),
    readKeywordClusterAxes: async () => null,
    SNAPSHOTS_PREFIX: "resume/snapshots/",
    snapshotPathnameFor: (ts) => `resume/snapshots/${ts.replace(/:/g, "-")}.json`,
    saveSnapshot: async () => ({ snapshotKey: "resume/snapshots/test.json", url: "https://blob.example/test" }),
    listSnapshots: async () => [],
    readSnapshotByKey: async () => null,
    RESUME_DATA_PATHNAME: "resume/data.json",
    SUGGESTIONS_PATHNAME: "resume/suggestions.json",
    DAILY_BULLETS_PREFIX: "resume/bullets/",
    PDF_TEXT_PATHNAME: "resume/pdf-text.txt",
    PDF_RAW_PATHNAME: "resume/resume.pdf",
    RECONSTRUCTION_MARKER_PATHNAME: "resume/needs-reconstruction.json",
    KEYWORD_CLUSTER_AXES_PATHNAME: "resume/keyword-cluster-axes.json",
    bulletsPathnameForDate: (date) => `resume/bullets/${date}.json`,
  },
});

// ─── Dynamic import of the module under test ─────────────────────────────────
// Must happen AFTER mock.module() to ensure the mock is applied.

const { registerLinkedInRoutes } = await import("./linkedin.mjs");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  registerLinkedInRoutes(app);
  return app;
}

// ─── POST /api/linkedin/import — JSON export full path ───────────────────────

describe("POST /api/linkedin/import — JSON export (with blob mock)", () => {
  test("201 when a valid JSON ProfileData is uploaded", async () => {
    _saveImpl = async () => ({ url: "https://blob.example/linkedin-import.json" });

    const profileJson = JSON.stringify({
      name: "Jane Developer",
      headline: "Senior Software Engineer",
      about: "I build distributed systems.",
      experience: [
        { title: "Senior Engineer", company: "Acme", duration: "2022–present", description: null },
      ],
      education: [{ school: "Seoul National Univ", degree: "BS", field: "CS", years: "2012–2016" }],
      skills: ["TypeScript", "Node.js", "PostgreSQL"],
      certifications: [],
    });

    const app = buildApp();
    const formData = new FormData();
    formData.append("file", new File([profileJson], "profile.json", { type: "application/json" }));
    const res = await app.request("/api/linkedin/import", { method: "POST", body: formData });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.source, "linkedin_json");
    assert.ok(body.importedAt, "importedAt should be present");
    assert.equal(body.blobUrl, "https://blob.example/linkedin-import.json");
    assert.equal(body.data.name, "Jane Developer");
    assert.equal(body.data.experience.length, 1);
    assert.equal(body.data.skills.length, 3);
  });

  test("calls saveLinkedInImport with correct data and source=linkedin_json", async () => {
    let capturedData = null;
    let capturedSource = null;
    _saveImpl = async (data, source) => {
      capturedData = data;
      capturedSource = source;
      return { url: "https://blob.example/linkedin-import.json" };
    };

    const profileJson = JSON.stringify({
      name: "Bob Tester",
      headline: "Engineer",
      experience: [{ title: "Engineer", company: "TestCo", duration: null, description: null }],
      education: [],
      skills: ["Go"],
    });

    const app = buildApp();
    const formData = new FormData();
    formData.append("file", new File([profileJson], "profile.json", { type: "application/json" }));
    await app.request("/api/linkedin/import", { method: "POST", body: formData });

    assert.equal(capturedSource, "linkedin_json");
    assert.equal(capturedData?.name, "Bob Tester");
    assert.ok(Array.isArray(capturedData?.experience));
    assert.ok(Array.isArray(capturedData?.skills));
  });

  test("500 when saveLinkedInImport throws a storage error", async () => {
    _saveImpl = async () => {
      throw new Error("Vercel Blob quota exceeded");
    };

    const profileJson = JSON.stringify({
      name: "Error User",
      headline: "Engineer",
    });

    const app = buildApp();
    const formData = new FormData();
    formData.append("file", new File([profileJson], "profile.json", { type: "application/json" }));
    const res = await app.request("/api/linkedin/import", { method: "POST", body: formData });
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.ok, false);
    assert.equal(body.error, "storage_error");
    assert.ok(body.message?.includes("quota exceeded"), `message="${body.message}"`);
  });

  test("response data sections are always arrays even when absent in JSON", async () => {
    _saveImpl = async () => ({ url: "https://blob.example/linkedin-import.json" });

    const profileJson = JSON.stringify({
      name: "Minimal User",
      headline: "Engineer",
      // No experience / education / skills / certifications keys
    });

    const app = buildApp();
    const formData = new FormData();
    formData.append("file", new File([profileJson], "minimal.json", { type: "application/json" }));
    const res = await app.request("/api/linkedin/import", { method: "POST", body: formData });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.data.experience), "experience must be array");
    assert.ok(Array.isArray(body.data.education), "education must be array");
    assert.ok(Array.isArray(body.data.skills), "skills must be array");
    assert.ok(Array.isArray(body.data.certifications), "certifications must be array");
  });

  test("response includes all standard ProfileData section keys", async () => {
    _saveImpl = async () => ({ url: "https://blob.example/linkedin-import.json" });

    const profileJson = JSON.stringify({
      name: "Section Checker",
      headline: "QA Engineer",
      about: "Testing all sections.",
      location: "Seoul",
      experience: [{ title: "QA", company: "TestCo", duration: "2020–2023", description: "Tested things." }],
      education: [{ school: "Test Univ", degree: "BS", field: "QA", years: "2016–2020" }],
      skills: ["Selenium", "Cypress"],
      certifications: [{ name: "ISTQB", issuer: "ISTQB", date: "2021" }],
    });

    const app = buildApp();
    const formData = new FormData();
    formData.append("file", new File([profileJson], "full.json", { type: "application/json" }));
    const res = await app.request("/api/linkedin/import", { method: "POST", body: formData });
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.data.name, "Section Checker");
    assert.equal(body.data.headline, "QA Engineer");
    assert.equal(body.data.about, "Testing all sections.");
    assert.equal(body.data.location, "Seoul");
    assert.equal(body.data.experience.length, 1);
    assert.equal(body.data.education.length, 1);
    assert.equal(body.data.skills.length, 2);
    assert.equal(body.data.certifications.length, 1);
  });
});

// ─── GET /api/linkedin/import ──────────────────────────────────────────────────

describe("GET /api/linkedin/import (with blob mock)", () => {
  test("404 when no LinkedIn import exists in blob", async () => {
    _readImpl = async () => null;

    const app = buildApp();
    const res = await app.request("/api/linkedin/import", { method: "GET" });
    const body = await res.json();

    assert.equal(res.status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.error, "not_found");
    assert.ok(body.message, "should include a message");
  });

  test("200 with stored import data when an import exists", async () => {
    const stored = {
      schemaVersion: 1,
      importedAt: "2026-03-27T00:00:00.000Z",
      source: "linkedin_json",
      data: {
        name: "Jane Developer",
        headline: "Senior Engineer",
        about: null,
        location: null,
        profileImageUrl: null,
        experience: [{ title: "Engineer", company: "Acme", duration: null, description: null }],
        education: [],
        skills: ["TypeScript"],
        certifications: [],
      },
    };
    _readImpl = async () => stored;

    const app = buildApp();
    const res = await app.request("/api/linkedin/import", { method: "GET" });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.importedAt, "2026-03-27T00:00:00.000Z");
    assert.equal(body.source, "linkedin_json");
    assert.equal(body.data.name, "Jane Developer");
    assert.ok(Array.isArray(body.data.experience));
    assert.ok(Array.isArray(body.data.skills));
  });

  test("response exposes importedAt, source, and data — not schemaVersion", async () => {
    _readImpl = async () => ({
      schemaVersion: 1,
      importedAt: "2026-01-01T00:00:00.000Z",
      source: "linkedin_pdf",
      data: { name: "Alice", headline: "CTO", about: null, location: null, profileImageUrl: null,
              experience: [], education: [], skills: [], certifications: [] },
    });

    const app = buildApp();
    const res = await app.request("/api/linkedin/import", { method: "GET" });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.ok("importedAt" in body, "importedAt must be in response");
    assert.ok("source" in body, "source must be in response");
    assert.ok("data" in body, "data must be in response");
    // schemaVersion is an internal blob envelope field — not exposed to clients.
    assert.ok(!("schemaVersion" in body), "schemaVersion must NOT be exposed to clients");
  });

  test("500 when readLinkedInImport throws a storage error", async () => {
    _readImpl = async () => {
      throw new Error("Blob connection refused");
    };

    const app = buildApp();
    const res = await app.request("/api/linkedin/import", { method: "GET" });
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.ok, false);
    assert.equal(body.error, "storage_error");
    assert.ok(body.message?.includes("Blob connection refused"), `message="${body.message}"`);
  });
});
