/**
 * Tests for resumeReconstruction.mjs (Sub-AC 14-3).
 *
 * Coverage:
 *   - gatherWorkLogBullets: empty dir, valid files, malformed files, missing dir
 *   - isResumeStale: non-stale, stale, missing meta
 *   - mergeWithUserEdits: user edits preserved over fresh reconstruction
 *   - fullReconstructExtractCache: processes entries, bypasses cache, re-hydrates
 *
 * Run:
 *   node --test src/lib/resumeReconstruction.test.mjs
 *
 * NOTE: gatherWorkLogBullets uses the real filesystem.  Tests for it create
 * temporary directories via os.tmpdir() and clean up after themselves.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  gatherWorkLogBullets,
  isResumeStale,
  mergeWithUserEdits,
  fullReconstructExtractCache
} from "./resumeReconstruction.mjs";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeResume(overrides = {}) {
  return {
    meta: {
      language: "en",
      source: "pdf",
      generatedAt: "2024-01-01T00:00:00.000Z",
      schemaVersion: 1
    },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: { name: "Test User", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: "A developer.",
    experience: [
      {
        _source: "system",
        company: "Acme Corp",
        title: "Software Engineer",
        start_date: "2022-01",
        end_date: "present",
        location: null,
        bullets: ["Built systems", "Fixed bugs"]
      }
    ],
    education: [],
    skills: { technical: ["JavaScript"], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: ["JavaScript"],
    display_axes: [],
    ...overrides
  };
}

/**
 * A minimal reconstruction result (what reconstructResumeFromSources returns).
 */
function makeReconstructionResult(overrides = {}) {
  return {
    resumeData: {
      meta: {
        language: "en",
        source: "pdf",
        generatedAt: "2024-01-01T00:00:00.000Z",
        schemaVersion: 1
      },
      _sources: { summary: "system", contact: "system", skills: "system" },
      contact: { name: "Reconstructed User", email: null, phone: null, location: null, website: null, linkedin: null },
      summary: "Reconstructed summary.",
      experience: [
        {
          _source: "system",
          company: "Acme Corp",
          title: "Software Engineer",
          start_date: "2022-01",
          end_date: "present",
          location: null,
          bullets: ["Rebuilt microservices", "Improved test coverage"]
        }
      ],
      education: [],
      skills: { technical: ["JavaScript", "TypeScript"], languages: [], tools: ["Docker"] },
      projects: [],
      certifications: []
    },
    strengthKeywords: ["JavaScript", "TypeScript"],
    displayAxes: [],
    ...overrides
  };
}

// ─── Helper: create a temp data directory ────────────────────────────────────

async function makeTempDataDir() {
  const tmpRoot = path.join(os.tmpdir(), `work-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dailyDir = path.join(tmpRoot, "daily");
  await fs.mkdir(dailyDir, { recursive: true });
  return { tmpRoot, dailyDir, cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {}) };
}

// ─── gatherWorkLogBullets ─────────────────────────────────────────────────────

describe("gatherWorkLogBullets", () => {
  test("returns [] when data/daily/ directory does not exist", async () => {
    const result = await gatherWorkLogBullets("/nonexistent/path/that/should/not/exist");
    assert.deepEqual(result, []);
  });

  test("returns [] when data/daily/ is empty", async () => {
    const { tmpRoot, cleanup } = await makeTempDataDir();
    try {
      const result = await gatherWorkLogBullets(tmpRoot);
      assert.deepEqual(result, []);
    } finally {
      await cleanup();
    }
  });

  test("parses a valid daily work-log JSON file", async () => {
    const { tmpRoot, dailyDir, cleanup } = await makeTempDataDir();
    try {
      const entry = {
        date: "2024-06-15",
        resume: {
          candidates: ["Shipped new authentication module"],
          companyCandidates: ["Deployed to Kubernetes"],
          openSourceCandidates: ["Published npm package v2.0"]
        }
      };
      await fs.writeFile(path.join(dailyDir, "2024-06-15.json"), JSON.stringify(entry));

      const result = await gatherWorkLogBullets(tmpRoot);

      assert.equal(result.length, 1);
      assert.equal(result[0].date, "2024-06-15");
      assert.deepEqual(result[0].candidates, ["Shipped new authentication module"]);
      assert.deepEqual(result[0].companyCandidates, ["Deployed to Kubernetes"]);
      assert.deepEqual(result[0].openSourceCandidates, ["Published npm package v2.0"]);
    } finally {
      await cleanup();
    }
  });

  test("parses multiple files and returns them in ascending date order", async () => {
    const { tmpRoot, dailyDir, cleanup } = await makeTempDataDir();
    try {
      const dates = ["2024-08-01", "2024-06-15", "2024-07-20"];
      for (const date of dates) {
        await fs.writeFile(
          path.join(dailyDir, `${date}.json`),
          JSON.stringify({ date, resume: { candidates: [`Bullet for ${date}`], companyCandidates: [], openSourceCandidates: [] } })
        );
      }

      const result = await gatherWorkLogBullets(tmpRoot);

      assert.equal(result.length, 3);
      // Should be sorted ascending
      assert.equal(result[0].date, "2024-06-15");
      assert.equal(result[1].date, "2024-07-20");
      assert.equal(result[2].date, "2024-08-01");
    } finally {
      await cleanup();
    }
  });

  test("skips files with no resume section", async () => {
    const { tmpRoot, dailyDir, cleanup } = await makeTempDataDir();
    try {
      // File with no `resume` section
      await fs.writeFile(
        path.join(dailyDir, "2024-06-15.json"),
        JSON.stringify({ date: "2024-06-15", highlights: { businessOutcomes: ["something"] } })
      );

      const result = await gatherWorkLogBullets(tmpRoot);
      assert.deepEqual(result, []);
    } finally {
      await cleanup();
    }
  });

  test("skips malformed JSON files without crashing", async () => {
    const { tmpRoot, dailyDir, cleanup } = await makeTempDataDir();
    try {
      // Write a valid file and a malformed file
      await fs.writeFile(path.join(dailyDir, "2024-06-15.json"), "{ this is not valid json }}");
      await fs.writeFile(
        path.join(dailyDir, "2024-06-16.json"),
        JSON.stringify({ date: "2024-06-16", resume: { candidates: ["Valid bullet"], companyCandidates: [], openSourceCandidates: [] } })
      );

      const result = await gatherWorkLogBullets(tmpRoot);

      // Only the valid file should be returned
      assert.equal(result.length, 1);
      assert.equal(result[0].date, "2024-06-16");
    } finally {
      await cleanup();
    }
  });

  test("ignores non-date-named files", async () => {
    const { tmpRoot, dailyDir, cleanup } = await makeTempDataDir();
    try {
      await fs.writeFile(
        path.join(dailyDir, "README.md"),
        "# Daily notes"
      );
      await fs.writeFile(
        path.join(dailyDir, "index.json"),
        JSON.stringify({ resume: { candidates: ["Should not be read"] } })
      );
      await fs.writeFile(
        path.join(dailyDir, "2024-06-15.json"),
        JSON.stringify({ date: "2024-06-15", resume: { candidates: ["Valid"], companyCandidates: [], openSourceCandidates: [] } })
      );

      const result = await gatherWorkLogBullets(tmpRoot);
      assert.equal(result.length, 1);
      assert.equal(result[0].date, "2024-06-15");
    } finally {
      await cleanup();
    }
  });

  test("returns empty arrays for missing candidate fields", async () => {
    const { tmpRoot, dailyDir, cleanup } = await makeTempDataDir();
    try {
      // resume section present but missing candidate arrays
      await fs.writeFile(
        path.join(dailyDir, "2024-06-15.json"),
        JSON.stringify({ date: "2024-06-15", resume: {} })
      );

      const result = await gatherWorkLogBullets(tmpRoot);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0].candidates, []);
      assert.deepEqual(result[0].companyCandidates, []);
      assert.deepEqual(result[0].openSourceCandidates, []);
    } finally {
      await cleanup();
    }
  });
});

// ─── isResumeStale ────────────────────────────────────────────────────────────

describe("isResumeStale", () => {
  test("returns { isStale: false } when workLogEntries is empty", () => {
    const resume = makeResume();
    const result = isResumeStale(resume, []);
    assert.equal(result.isStale, false);
    assert.equal(result.latestLogDate, null);
    assert.equal(result.checkpointDate, null);
  });

  test("returns { isStale: false } when workLogEntries is undefined", () => {
    const resume = makeResume();
    const result = isResumeStale(resume, undefined);
    assert.equal(result.isStale, false);
  });

  test("returns { isStale: true } when resume has no meta timestamp and work logs exist", () => {
    const resume = makeResume({ meta: {} });
    const entries = [{ date: "2024-06-15", candidates: [], companyCandidates: [], openSourceCandidates: [] }];
    const result = isResumeStale(resume, entries);
    assert.equal(result.isStale, true);
    assert.equal(result.latestLogDate, "2024-06-15");
    assert.equal(result.checkpointDate, null);
  });

  test("returns { isStale: false } when all log dates are at or before checkpoint date (within threshold)", () => {
    const today = new Date();
    const recentGeneratedAt = new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    const resume = makeResume({ meta: { language: "en", source: "pdf", generatedAt: recentGeneratedAt, schemaVersion: 1 } });
    const checkDate = recentGeneratedAt.slice(0, 10);

    // Log dates at or before checkpoint — within staleness threshold (default 7 days)
    const entries = [
      { date: checkDate, candidates: ["Something happened"], companyCandidates: [], openSourceCandidates: [] }
    ];
    const result = isResumeStale(resume, entries);
    // Since the checkpoint is only 1 day old (< 7-day threshold), should not be stale
    assert.equal(result.isStale, false);
  });

  test("returns { isStale: true } when checkpoint is old AND newer log exists", () => {
    // Set a checkpoint that is 10 days ago (> default 7-day threshold)
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const checkpointIso = tenDaysAgo.toISOString();
    const checkpointDate = checkpointIso.slice(0, 10);
    const resume = makeResume({
      meta: { language: "en", source: "pdf", generatedAt: checkpointIso, schemaVersion: 1 }
    });

    // A work-log entry from after the checkpoint
    const laterDate = new Date(tenDaysAgo.getTime() + 2 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const entries = [
      { date: laterDate, candidates: ["New work done"], companyCandidates: [], openSourceCandidates: [] }
    ];

    const result = isResumeStale(resume, entries);
    assert.equal(result.isStale, true);
    assert.equal(result.latestLogDate, laterDate);
    assert.equal(result.checkpointDate, checkpointDate);
  });

  test("uses meta.rebuiltAt over meta.generatedAt as the checkpoint", () => {
    // generatedAt is very old but rebuiltAt is recent
    const recentRebuiltAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const resume = makeResume({
      meta: {
        language: "en",
        source: "pdf",
        generatedAt: "2020-01-01T00:00:00.000Z",
        rebuiltAt: recentRebuiltAt,
        schemaVersion: 1
      }
    });

    const recentDate = recentRebuiltAt.slice(0, 10);
    const entries = [
      { date: recentDate, candidates: ["Work done today"], companyCandidates: [], openSourceCandidates: [] }
    ];

    // rebuiltAt is only 1 day ago (< 7-day threshold) — should NOT be stale
    const result = isResumeStale(resume, entries);
    assert.equal(result.isStale, false);
  });
});

// ─── mergeWithUserEdits ────────────────────────────────────────────────────────

describe("mergeWithUserEdits", () => {
  test("preserves user-edited summary", () => {
    const current = makeResume({
      _sources: { summary: "user", contact: "system", skills: "system" },
      summary: "My hand-written summary that should be kept."
    });
    const reconstruction = makeReconstructionResult();

    const merged = mergeWithUserEdits(current, reconstruction);

    assert.equal(merged.summary, "My hand-written summary that should be kept.");
    assert.equal(merged._sources.summary, "user");
  });

  test("preserves user_approved summary", () => {
    const current = makeResume({
      _sources: { summary: "user_approved", contact: "system", skills: "system" },
      summary: "Approved summary."
    });
    const reconstruction = makeReconstructionResult();

    const merged = mergeWithUserEdits(current, reconstruction);

    assert.equal(merged.summary, "Approved summary.");
    assert.equal(merged._sources.summary, "user_approved");
  });

  test("uses reconstructed summary when current summary is system-generated", () => {
    const current = makeResume({
      _sources: { summary: "system", contact: "system", skills: "system" },
      summary: "Old system summary."
    });
    const reconstruction = makeReconstructionResult();

    const merged = mergeWithUserEdits(current, reconstruction);

    assert.equal(merged.summary, "Reconstructed summary.");
  });

  test("preserves user-edited contact info", () => {
    const current = makeResume({
      _sources: { summary: "system", contact: "user", skills: "system" },
      contact: { name: "User Edited Name", email: "custom@email.com", phone: "555-1234", location: null, website: null, linkedin: null }
    });
    const reconstruction = makeReconstructionResult();

    const merged = mergeWithUserEdits(current, reconstruction);

    assert.equal(merged.contact.name, "User Edited Name");
    assert.equal(merged.contact.email, "custom@email.com");
    assert.equal(merged._sources.contact, "user");
  });

  test("preserves user-edited skills", () => {
    const current = makeResume({
      _sources: { summary: "system", contact: "system", skills: "user" },
      skills: { technical: ["React", "Vue"], languages: ["TypeScript"], tools: ["Kubernetes"] }
    });
    const reconstruction = makeReconstructionResult();

    const merged = mergeWithUserEdits(current, reconstruction);

    assert.deepEqual(merged.skills.technical, ["React", "Vue"]);
    assert.equal(merged._sources.skills, "user");
  });

  test("uses reconstructed skills when current skills are system-generated", () => {
    const current = makeResume({
      _sources: { summary: "system", contact: "system", skills: "system" },
      skills: { technical: ["JavaScript"], languages: [], tools: [] }
    });
    const reconstruction = makeReconstructionResult();

    const merged = mergeWithUserEdits(current, reconstruction);

    assert.deepEqual(merged.skills.technical, ["JavaScript", "TypeScript"]);
    assert.deepEqual(merged.skills.tools, ["Docker"]);
  });

  test("preserves user-edited experience entries and uses fresh system entries for others", () => {
    const current = makeResume({
      experience: [
        {
          _source: "user",
          company: "User Corp",
          title: "Hand-edited Role",
          start_date: "2023-01",
          end_date: "present",
          location: null,
          bullets: ["User-authored bullet that must survive reconstruction"]
        },
        {
          _source: "system",
          company: "Acme Corp",
          title: "Software Engineer",
          start_date: "2022-01",
          end_date: "2022-12",
          location: null,
          bullets: ["Old system bullet"]
        }
      ]
    });

    const reconstruction = makeReconstructionResult({
      resumeData: {
        ...makeReconstructionResult().resumeData,
        experience: [
          {
            _source: "system",
            company: "Acme Corp",
            title: "Software Engineer",
            start_date: "2022-01",
            end_date: "present",
            location: null,
            bullets: ["Rebuilt microservices", "Improved test coverage"]
          },
          {
            _source: "system",
            company: "New Corp",
            title: "Lead Engineer",
            start_date: "2023-01",
            end_date: "present",
            location: null,
            bullets: ["New fresh bullet from reconstruction"]
          }
        ]
      }
    });

    const merged = mergeWithUserEdits(current, reconstruction);

    // User Corp entry must be preserved exactly
    const userCorpEntry = merged.experience.find((e) => e.company === "User Corp");
    assert.ok(userCorpEntry, "User Corp entry must be present");
    assert.equal(userCorpEntry._source, "user");
    assert.ok(userCorpEntry.bullets.includes("User-authored bullet that must survive reconstruction"));

    // Acme Corp (system-generated in current) should come from fresh reconstruction
    const acmeEntry = merged.experience.find((e) => e.company === "Acme Corp");
    assert.ok(acmeEntry, "Acme Corp entry must be present");
    assert.ok(acmeEntry.bullets.includes("Rebuilt microservices") || acmeEntry.bullets.includes("Improved test coverage"),
      "Acme Corp should have fresh reconstruction bullets");

    // New Corp (only in reconstruction) should appear
    const newCorpEntry = merged.experience.find((e) => e.company === "New Corp");
    assert.ok(newCorpEntry, "New Corp entry from reconstruction should be included");
  });

  test("preserves user_approved experience entries", () => {
    const current = makeResume({
      experience: [
        {
          _source: "user_approved",
          company: "Approved Corp",
          title: "Approved Role",
          start_date: "2022-01",
          end_date: "present",
          location: null,
          bullets: ["Approved bullet — must not be overwritten"]
        }
      ]
    });
    const reconstruction = makeReconstructionResult({
      resumeData: {
        ...makeReconstructionResult().resumeData,
        experience: [
          {
            _source: "system",
            company: "Approved Corp",
            title: "Fresh Role",
            start_date: "2022-01",
            end_date: "present",
            location: null,
            bullets: ["Fresh bullet from reconstruction"]
          }
        ]
      }
    });

    const merged = mergeWithUserEdits(current, reconstruction);

    const entry = merged.experience.find((e) => e.company === "Approved Corp");
    assert.ok(entry);
    assert.equal(entry._source, "user_approved");
    assert.ok(entry.bullets.includes("Approved bullet — must not be overwritten"));
  });

  test("always preserves education from current resume", () => {
    const current = makeResume({
      education: [
        {
          _source: "user",
          institution: "MIT",
          degree: "BSc",
          field: "Computer Science",
          start_date: "2016-09",
          end_date: "2020-06",
          gpa: null
        }
      ]
    });
    const reconstruction = makeReconstructionResult({
      resumeData: {
        ...makeReconstructionResult().resumeData,
        education: [
          {
            _source: "system",
            institution: "Stanford",
            degree: "MSc",
            field: "AI",
            start_date: "2021-09",
            end_date: "2023-06",
            gpa: null
          }
        ]
      }
    });

    const merged = mergeWithUserEdits(current, reconstruction);

    // Current education (MIT) should be preserved — education is always kept from current
    const mitEntry = merged.education.find((e) => e.institution === "MIT");
    assert.ok(mitEntry, "MIT education entry must be preserved");
    // Stanford from reconstruction should NOT replace MIT
    assert.equal(merged.education.length, 1);
  });

  test("stamps rebuiltAt timestamp on merged meta", () => {
    const current = makeResume();
    const before = new Date();
    const merged = mergeWithUserEdits(current, makeReconstructionResult());
    const after = new Date();

    assert.ok(merged.meta.rebuiltAt, "rebuiltAt must be set");
    const rebuiltAt = new Date(merged.meta.rebuiltAt);
    assert.ok(rebuiltAt >= before && rebuiltAt <= after, "rebuiltAt must be a recent timestamp");
  });

  test("preserves original bootstrap metadata (language, source, generatedAt)", () => {
    const current = makeResume({
      meta: {
        language: "ko",
        source: "pdf",
        generatedAt: "2024-01-01T00:00:00.000Z",
        schemaVersion: 1,
        pdf_name: "original.pdf",
        linkedin_url: null
      }
    });
    const reconstruction = makeReconstructionResult();

    const merged = mergeWithUserEdits(current, reconstruction);

    assert.equal(merged.meta.language, "ko", "language must be preserved from original");
    assert.equal(merged.meta.source, "pdf");
    assert.equal(merged.meta.generatedAt, "2024-01-01T00:00:00.000Z");
    assert.equal(merged.meta.pdf_name, "original.pdf");
  });
});

// ─── fullReconstructExtractCache ──────────────────────────────────────────────

describe("fullReconstructExtractCache", () => {
  test("returns zero stats when workLogEntries is empty", async () => {
    const stats = await fullReconstructExtractCache({
      workLogEntries: [],
      currentResume: makeResume(),
      extractFn: async () => { throw new Error("should not be called"); },
      writeCacheFn: async () => {}
    });

    assert.equal(stats.total, 0);
    assert.equal(stats.processed, 0);
    assert.equal(stats.failed, 0);
    assert.equal(stats.skipped, 0);
    assert.deepEqual(stats.dates, []);
  });

  test("returns zero stats when workLogEntries is undefined/null", async () => {
    const stats = await fullReconstructExtractCache({
      workLogEntries: undefined,
      currentResume: null,
      extractFn: async () => ({}),
      writeCacheFn: async () => {}
    });

    assert.equal(stats.total, 0);
    assert.equal(stats.processed, 0);
  });

  test("calls extractFn for each entry — bypasses cache", async () => {
    const entries = [
      { date: "2024-06-15", candidates: ["Bullet A"], companyCandidates: [], openSourceCandidates: [] },
      { date: "2024-06-16", candidates: ["Bullet B"], companyCandidates: [], openSourceCandidates: [] }
    ];

    const extractCalls = [];
    const writeCalls = [];

    const extractFn = async (workLogSummary, resume) => {
      extractCalls.push({ date: workLogSummary.date, candidates: workLogSummary.resume?.candidates });
      return { experienceUpdates: [], newSkills: { technical: [], languages: [], tools: [] }, summaryUpdate: null };
    };

    const writeCacheFn = async (date, extract) => {
      writeCalls.push({ date, extract });
    };

    const stats = await fullReconstructExtractCache({
      workLogEntries: entries,
      currentResume: makeResume(),
      extractFn,
      writeCacheFn
    });

    assert.equal(stats.total, 2);
    assert.equal(stats.processed, 2);
    assert.equal(stats.failed, 0);
    assert.equal(stats.skipped, 0);
    assert.deepEqual(stats.dates, ["2024-06-15", "2024-06-16"]);

    // extractFn must be called for EVERY entry (no cache read)
    assert.equal(extractCalls.length, 2, "extractFn must be called for each entry");
    assert.equal(extractCalls[0].date, "2024-06-15");
    assert.deepEqual(extractCalls[0].candidates, ["Bullet A"]);
    assert.equal(extractCalls[1].date, "2024-06-16");

    // writeCacheFn must be called for EVERY successful entry
    assert.equal(writeCalls.length, 2, "writeCacheFn must be called for each successful entry");
    assert.equal(writeCalls[0].date, "2024-06-15");
    assert.equal(writeCalls[1].date, "2024-06-16");
  });

  test("adapts WorkLogEntry fields to workLogSummary.resume shape", async () => {
    const entries = [
      {
        date: "2024-07-01",
        candidates: ["General bullet"],
        companyCandidates: ["Company bullet"],
        openSourceCandidates: ["OSS bullet"]
      }
    ];

    let capturedSummary = null;
    const extractFn = async (workLogSummary) => {
      capturedSummary = workLogSummary;
      return { experienceUpdates: [], newSkills: { technical: [], languages: [], tools: [] }, summaryUpdate: null };
    };

    await fullReconstructExtractCache({
      workLogEntries: entries,
      currentResume: makeResume(),
      extractFn,
      writeCacheFn: async () => {}
    });

    assert.ok(capturedSummary, "extractFn must have been called");
    assert.equal(capturedSummary.date, "2024-07-01");
    // Must be wrapped under resume.* for buildWorkLogDiff compatibility
    assert.deepEqual(capturedSummary.resume.candidates, ["General bullet"]);
    assert.deepEqual(capturedSummary.resume.companyCandidates, ["Company bullet"]);
    assert.deepEqual(capturedSummary.resume.openSourceCandidates, ["OSS bullet"]);
  });

  test("passes currentResume to extractFn for dedup context", async () => {
    const currentResume = makeResume();
    let capturedResume = null;

    const extractFn = async (_summary, resume) => {
      capturedResume = resume;
      return { experienceUpdates: [], newSkills: { technical: [], languages: [], tools: [] }, summaryUpdate: null };
    };

    await fullReconstructExtractCache({
      workLogEntries: [{ date: "2024-07-01", candidates: ["Bullet"], companyCandidates: [], openSourceCandidates: [] }],
      currentResume,
      extractFn,
      writeCacheFn: async () => {}
    });

    assert.equal(capturedResume, currentResume, "currentResume must be passed to extractFn");
  });

  test("does NOT call readExtractCache (cache bypass guaranteed by design)", async () => {
    // This test verifies the bypass by design: extractFn receives a fresh call
    // every time regardless of prior cache state — there is no readExtractCache
    // call inside fullReconstructExtractCache.
    let extractCallCount = 0;
    const entries = [
      { date: "2024-07-01", candidates: ["A"], companyCandidates: [], openSourceCandidates: [] },
      { date: "2024-07-02", candidates: ["B"], companyCandidates: [], openSourceCandidates: [] }
    ];

    await fullReconstructExtractCache({
      workLogEntries: entries,
      currentResume: makeResume(),
      extractFn: async () => { extractCallCount++; return { experienceUpdates: [], newSkills: { technical: [], languages: [], tools: [] }, summaryUpdate: null }; },
      writeCacheFn: async () => {}
    });

    // If cache were consulted and returned HITs, extractCallCount could be 0.
    // Since we bypass, it must equal the entry count.
    assert.equal(extractCallCount, 2, "extractFn must be called for every entry — cache is bypassed");
  });

  test("counts failed entries when extractFn throws", async () => {
    const entries = [
      { date: "2024-07-01", candidates: ["Good"], companyCandidates: [], openSourceCandidates: [] },
      { date: "2024-07-02", candidates: ["Will fail"], companyCandidates: [], openSourceCandidates: [] },
      { date: "2024-07-03", candidates: ["Good again"], companyCandidates: [], openSourceCandidates: [] }
    ];

    let writeCallCount = 0;
    const extractFn = async (summary) => {
      if (summary.date === "2024-07-02") {
        throw new Error("LLM API error — simulated failure");
      }
      return { experienceUpdates: [], newSkills: { technical: [], languages: [], tools: [] }, summaryUpdate: null };
    };

    const stats = await fullReconstructExtractCache({
      workLogEntries: entries,
      currentResume: makeResume(),
      extractFn,
      writeCacheFn: async () => { writeCallCount++; }
    });

    assert.equal(stats.total, 3);
    assert.equal(stats.processed, 2, "Two entries must succeed");
    assert.equal(stats.failed, 1, "One entry must fail");
    assert.equal(writeCallCount, 2, "writeCacheFn must only be called for successful entries");
    assert.deepEqual(stats.dates, ["2024-07-01", "2024-07-03"]);
  });

  test("never throws even when all entries fail", async () => {
    const entries = [
      { date: "2024-07-01", candidates: ["A"], companyCandidates: [], openSourceCandidates: [] }
    ];

    let stats;
    // Should NOT throw
    stats = await fullReconstructExtractCache({
      workLogEntries: entries,
      currentResume: makeResume(),
      extractFn: async () => { throw new Error("Total failure"); },
      writeCacheFn: async () => {}
    });

    assert.equal(stats.failed, 1);
    assert.equal(stats.processed, 0);
  });

  test("counts entries with missing date as skipped", async () => {
    const entries = [
      { date: "",        candidates: ["No date"], companyCandidates: [], openSourceCandidates: [] },
      { candidates: ["No date field at all"], companyCandidates: [], openSourceCandidates: [] },
      { date: "2024-07-01", candidates: ["Valid"], companyCandidates: [], openSourceCandidates: [] }
    ];

    const stats = await fullReconstructExtractCache({
      workLogEntries: entries,
      currentResume: makeResume(),
      extractFn: async () => ({
        experienceUpdates: [], newSkills: { technical: [], languages: [], tools: [] }, summaryUpdate: null
      }),
      writeCacheFn: async () => {}
    });

    assert.equal(stats.total, 3);
    assert.equal(stats.processed, 1);
    assert.equal(stats.skipped, 2);
    assert.deepEqual(stats.dates, ["2024-07-01"]);
  });

  test("returns dates in ascending order", async () => {
    // Provide entries in non-sorted order (as they might come from gatherWorkLogBullets
    // in a rare edge case after a sort failure)
    const entries = [
      { date: "2024-08-01", candidates: ["C"], companyCandidates: [], openSourceCandidates: [] },
      { date: "2024-06-15", candidates: ["A"], companyCandidates: [], openSourceCandidates: [] },
      { date: "2024-07-20", candidates: ["B"], companyCandidates: [], openSourceCandidates: [] }
    ];

    const stats = await fullReconstructExtractCache({
      workLogEntries: entries,
      currentResume: makeResume(),
      extractFn: async () => ({
        experienceUpdates: [], newSkills: { technical: [], languages: [], tools: [] }, summaryUpdate: null
      }),
      writeCacheFn: async () => {}
    });

    assert.deepEqual(stats.dates, ["2024-06-15", "2024-07-20", "2024-08-01"]);
  });

  test("writeCacheFn receives the exact extract returned by extractFn", async () => {
    const expectedExtract = {
      experienceUpdates: [{ company: "Acme Corp", bullets: ["Shipped feature X"] }],
      newSkills: { technical: ["GraphQL"], languages: [], tools: [] },
      summaryUpdate: null
    };

    let capturedExtract = null;
    await fullReconstructExtractCache({
      workLogEntries: [{ date: "2024-07-01", candidates: ["Shipped feature X"], companyCandidates: [], openSourceCandidates: [] }],
      currentResume: makeResume(),
      extractFn: async () => expectedExtract,
      writeCacheFn: async (date, extract) => { capturedExtract = extract; }
    });

    assert.deepEqual(capturedExtract, expectedExtract, "writeCacheFn must receive the exact extract");
  });
});
