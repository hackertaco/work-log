/**
 * Unit tests for resumeMigration.mjs
 *
 * Covers:
 *   - needsMigration()   — detection of documents that require migration
 *   - migrateResumeDocument() — schema migration (adds _source / _sources)
 *
 * Run with: node --test src/lib/resumeMigration.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { migrateResumeDocument, needsMigration } from "./resumeMigration.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build a fully-migrated resume document (no migration needed).
 * @param {object} [overrides]
 * @returns {object}
 */
function makeCanonicalDoc(overrides = {}) {
  return {
    meta: {
      schemaVersion: 1,
      language: "en",
      source: "pdf",
      generatedAt: "2025-01-01T00:00:00.000Z"
    },
    _sources: { summary: "system", contact: "system", skills: "system" },
    contact: {
      name: "Jane Doe",
      email: null,
      phone: null,
      location: null,
      website: null,
      linkedin: null
    },
    summary: "Experienced engineer.",
    experience: [
      {
        _source: "system",
        company: "Acme",
        title: "Engineer",
        start_date: "2020-01",
        end_date: "present",
        location: null,
        bullets: ["Built things", "Shipped features"]
      }
    ],
    education: [
      {
        _source: "system",
        institution: "MIT",
        degree: "BS",
        field: "CS",
        start_date: null,
        end_date: null,
        gpa: null
      }
    ],
    skills: {
      technical: ["React"],
      languages: ["TypeScript"],
      tools: ["Docker"]
    },
    projects: [
      {
        _source: "system",
        name: "MyApp",
        description: null,
        url: null,
        bullets: []
      }
    ],
    certifications: [
      {
        _source: "system",
        name: "AWS Solutions Architect",
        issuer: "Amazon",
        date: "2024-01"
      }
    ],
    ...overrides
  };
}

/**
 * Build a legacy document (pre-_source field).
 * Simulates documents saved before ItemSource was introduced.
 */
function makeLegacyDoc(overrides = {}) {
  const doc = makeCanonicalDoc(overrides);
  // Remove all _source/_sources fields
  delete doc._sources;
  doc.experience = doc.experience.map(({ _source: _s, ...rest }) => rest);
  doc.education  = doc.education.map(({ _source: _s, ...rest }) => rest);
  doc.projects   = doc.projects.map(({ _source: _s, ...rest }) => rest);
  doc.certifications = doc.certifications.map(({ _source: _s, ...rest }) => rest);
  return doc;
}

// ─── needsMigration tests ──────────────────────────────────────────────────────

describe("needsMigration", () => {
  it("returns false for null", () => {
    assert.strictEqual(needsMigration(null), false);
  });

  it("returns false for undefined", () => {
    assert.strictEqual(needsMigration(undefined), false);
  });

  it("returns false for non-object (string)", () => {
    assert.strictEqual(needsMigration("string"), false);
  });

  it("returns false for non-object (array)", () => {
    assert.strictEqual(needsMigration([]), false);
  });

  it("returns false for a fully canonical document", () => {
    assert.strictEqual(needsMigration(makeCanonicalDoc()), false);
  });

  it("returns true when _sources is entirely absent", () => {
    const doc = makeCanonicalDoc();
    delete doc._sources;
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when _sources is null", () => {
    const doc = makeCanonicalDoc({ _sources: null });
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when _sources is an array (invalid)", () => {
    const doc = makeCanonicalDoc({ _sources: [] });
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when _sources.summary is missing", () => {
    const doc = makeCanonicalDoc({
      _sources: { contact: "system", skills: "system" }
    });
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when _sources.summary is an unknown value", () => {
    const doc = makeCanonicalDoc({
      _sources: { summary: "unknown", contact: "system", skills: "system" }
    });
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when _sources.contact is missing", () => {
    const doc = makeCanonicalDoc({
      _sources: { summary: "system", skills: "system" }
    });
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when _sources.skills is missing", () => {
    const doc = makeCanonicalDoc({
      _sources: { summary: "system", contact: "system" }
    });
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when an experience item lacks _source", () => {
    const doc = makeCanonicalDoc();
    doc.experience = [{ company: "Acme", title: "Dev", start_date: null, end_date: null, location: null, bullets: [] }];
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when an education item lacks _source", () => {
    const doc = makeCanonicalDoc();
    doc.education = [{ institution: "MIT", degree: null, field: null, start_date: null, end_date: null, gpa: null }];
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when a project item lacks _source", () => {
    const doc = makeCanonicalDoc();
    doc.projects = [{ name: "Proj", description: null, url: null, bullets: [] }];
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true when a certification item lacks _source", () => {
    const doc = makeCanonicalDoc();
    doc.certifications = [{ name: "AWS", issuer: null, date: null }];
    assert.strictEqual(needsMigration(doc), true);
  });

  it("returns true for a fully legacy document (no _source anywhere)", () => {
    assert.strictEqual(needsMigration(makeLegacyDoc()), true);
  });

  it("returns false for a doc with _source:user on all items", () => {
    const doc = makeCanonicalDoc({
      _sources: { summary: "user", contact: "user", skills: "user" }
    });
    doc.experience = doc.experience.map((e) => ({ ...e, _source: "user" }));
    doc.education  = doc.education.map((e)  => ({ ...e, _source: "user" }));
    doc.projects   = doc.projects.map((p)   => ({ ...p, _source: "user" }));
    doc.certifications = doc.certifications.map((c) => ({ ...c, _source: "user" }));
    assert.strictEqual(needsMigration(doc), false);
  });

  it("returns false for a doc with _source:user_approved on all items", () => {
    const doc = makeCanonicalDoc({
      _sources: { summary: "user_approved", contact: "user_approved", skills: "user_approved" }
    });
    doc.experience = doc.experience.map((e) => ({ ...e, _source: "user_approved" }));
    assert.strictEqual(needsMigration(doc), false);
  });
});

// ─── migrateResumeDocument tests ──────────────────────────────────────────────

describe("migrateResumeDocument", () => {
  // ── Edge / null cases ─────────────────────────────────────────────────────

  it("returns null for null input", () => {
    assert.strictEqual(migrateResumeDocument(null), null);
  });

  it("returns undefined for undefined input", () => {
    assert.strictEqual(migrateResumeDocument(undefined), undefined);
  });

  it("returns strings unchanged", () => {
    assert.strictEqual(migrateResumeDocument("str"), "str");
  });

  it("returns arrays unchanged", () => {
    const arr = [1, 2, 3];
    assert.strictEqual(migrateResumeDocument(arr), arr);
  });

  // ── Fast-path (no migration needed) ──────────────────────────────────────

  it("returns the same object reference when no migration is needed (fast-path)", () => {
    const doc = makeCanonicalDoc();
    const result = migrateResumeDocument(doc);
    // Same reference — no allocation performed
    assert.strictEqual(result, doc);
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  it("is idempotent — calling twice produces the same result", () => {
    const doc = makeLegacyDoc();
    const once  = migrateResumeDocument(doc);
    const twice = migrateResumeDocument(once);
    assert.deepStrictEqual(once, twice);
  });

  it("is idempotent on a canonical document", () => {
    const doc  = makeCanonicalDoc();
    const once = migrateResumeDocument(doc);
    assert.deepStrictEqual(once, doc);
  });

  // ── Non-mutation ──────────────────────────────────────────────────────────

  it("does NOT mutate the original document", () => {
    const doc    = makeLegacyDoc();
    const before = JSON.parse(JSON.stringify(doc));
    migrateResumeDocument(doc);
    assert.deepStrictEqual(doc, before);
  });

  // ── _sources defaults ─────────────────────────────────────────────────────

  it("adds _sources with system defaults when _sources is missing", () => {
    const doc = makeLegacyDoc();
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated._sources.summary, "system");
    assert.strictEqual(migrated._sources.contact, "system");
    assert.strictEqual(migrated._sources.skills,  "system");
  });

  it("fills only missing core keys when _sources is partially present", () => {
    const doc = makeCanonicalDoc({
      _sources: { summary: "user", contact: "system" }
      // skills is missing
    });
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated._sources.summary, "user");
    assert.strictEqual(migrated._sources.contact, "system");
    assert.strictEqual(migrated._sources.skills,  "system");
  });

  it("preserves extra _sources keys (display_axes, strength_keywords)", () => {
    const doc = makeCanonicalDoc({
      _sources: {
        summary: "user",
        contact: "system",
        skills:  "system",
        display_axes:      "user",
        strength_keywords: "user_approved"
      }
    });
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated._sources.display_axes,      "user");
    assert.strictEqual(migrated._sources.strength_keywords, "user_approved");
  });

  it("replaces invalid _sources.summary with 'system'", () => {
    const doc = makeCanonicalDoc({
      _sources: { summary: "invalid_value", contact: "system", skills: "system" }
    });
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated._sources.summary, "system");
  });

  // ── User-value preservation in _sources ───────────────────────────────────

  it("preserves _sources.summary = 'user'", () => {
    const doc = makeLegacyDoc();
    doc._sources = { summary: "user", contact: "system", skills: "system" };
    // Add back missing _source on items to isolate this test
    doc.experience = makeCanonicalDoc().experience;
    doc.education  = makeCanonicalDoc().education;
    doc.projects   = makeCanonicalDoc().projects;
    doc.certifications = makeCanonicalDoc().certifications;
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated._sources.summary, "user");
  });

  it("preserves _sources.contact = 'user_approved'", () => {
    const doc = makeCanonicalDoc({
      _sources: { summary: "system", contact: "user_approved", skills: "system" }
    });
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated._sources.contact, "user_approved");
  });

  // ── experience item _source ───────────────────────────────────────────────

  it("adds _source:'system' to experience items without _source", () => {
    const doc = makeCanonicalDoc();
    doc.experience = [
      { company: "Acme", title: "Dev", start_date: null, end_date: null, location: null, bullets: [] }
    ];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.experience[0]._source, "system");
  });

  it("preserves _source:'user' on experience items", () => {
    const doc = makeCanonicalDoc();
    doc.experience = [{ ...doc.experience[0], _source: "user" }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.experience[0]._source, "user");
  });

  it("preserves _source:'user_approved' on experience items", () => {
    const doc = makeCanonicalDoc();
    doc.experience = [{ ...doc.experience[0], _source: "user_approved" }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.experience[0]._source, "user_approved");
  });

  it("replaces unknown _source string with 'system' on experience items", () => {
    const doc = makeCanonicalDoc();
    doc.experience = [{ ...doc.experience[0], _source: "legacy_value" }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.experience[0]._source, "system");
  });

  it("handles multiple experience items with mixed _source values", () => {
    const doc = makeCanonicalDoc();
    doc.experience = [
      { company: "A", title: "Dev", start_date: null, end_date: null, location: null, bullets: [] },
      { _source: "user",          company: "B", title: "Dev", start_date: null, end_date: null, location: null, bullets: [] },
      { _source: "user_approved", company: "C", title: "Dev", start_date: null, end_date: null, location: null, bullets: [] },
      { _source: "system",        company: "D", title: "Dev", start_date: null, end_date: null, location: null, bullets: [] }
    ];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.experience[0]._source, "system");       // missing → system
    assert.strictEqual(migrated.experience[1]._source, "user");          // user preserved
    assert.strictEqual(migrated.experience[2]._source, "user_approved"); // user_approved preserved
    assert.strictEqual(migrated.experience[3]._source, "system");        // system unchanged
  });

  // ── education item _source ────────────────────────────────────────────────

  it("adds _source:'system' to education items without _source", () => {
    const doc = makeCanonicalDoc();
    doc.education = [{ institution: "MIT", degree: null, field: null, start_date: null, end_date: null, gpa: null }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.education[0]._source, "system");
  });

  it("preserves _source:'user' on education items", () => {
    const doc = makeCanonicalDoc();
    doc.education = [{ ...doc.education[0], _source: "user" }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.education[0]._source, "user");
  });

  // ── projects item _source ─────────────────────────────────────────────────

  it("adds _source:'system' to project items without _source", () => {
    const doc = makeCanonicalDoc();
    doc.projects = [{ name: "Proj", description: null, url: null, bullets: [] }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.projects[0]._source, "system");
  });

  it("preserves _source:'user' on project items", () => {
    const doc = makeCanonicalDoc();
    doc.projects = [{ ...doc.projects[0], _source: "user" }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.projects[0]._source, "user");
  });

  // ── certifications item _source ───────────────────────────────────────────

  it("adds _source:'system' to certification items without _source", () => {
    const doc = makeCanonicalDoc();
    doc.certifications = [{ name: "AWS", issuer: null, date: null }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.certifications[0]._source, "system");
  });

  it("preserves _source:'user' on certification items", () => {
    const doc = makeCanonicalDoc();
    doc.certifications = [{ ...doc.certifications[0], _source: "user" }];
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.certifications[0]._source, "user");
  });

  // ── Graceful handling of malformed sections ───────────────────────────────

  it("handles missing experience array gracefully (no field added)", () => {
    const doc = makeCanonicalDoc();
    delete doc.experience;
    const migrated = migrateResumeDocument(doc);
    assert.strictEqual(migrated.experience, undefined);
  });

  it("handles null items inside an array without throwing", () => {
    const doc = makeCanonicalDoc();
    doc.experience = [null, { company: "Acme", title: "Dev", bullets: [] }];
    let migrated;
    assert.doesNotThrow(() => {
      migrated = migrateResumeDocument(doc);
    });
    assert.strictEqual(migrated.experience[0], null);           // null passes through
    assert.strictEqual(migrated.experience[1]._source, "system"); // object gets _source
  });

  it("handles string items inside an array without throwing", () => {
    const doc = makeCanonicalDoc();
    doc.projects = ["string_item", { name: "Proj", description: null, url: null, bullets: [] }];
    let migrated;
    assert.doesNotThrow(() => {
      migrated = migrateResumeDocument(doc);
    });
    assert.strictEqual(migrated.projects[0], "string_item"); // non-object passes through
    assert.strictEqual(migrated.projects[1]._source, "system");
  });

  // ── Full legacy document migration ───────────────────────────────────────

  it("fully migrates a legacy document (no _source anywhere)", () => {
    const legacy   = makeLegacyDoc();
    const migrated = migrateResumeDocument(legacy);

    // _sources populated
    assert.strictEqual(migrated._sources.summary, "system");
    assert.strictEqual(migrated._sources.contact, "system");
    assert.strictEqual(migrated._sources.skills,  "system");

    // All array items have _source
    for (const item of migrated.experience)     assert.strictEqual(item._source, "system");
    for (const item of migrated.education)      assert.strictEqual(item._source, "system");
    for (const item of migrated.projects)       assert.strictEqual(item._source, "system");
    for (const item of migrated.certifications) assert.strictEqual(item._source, "system");
  });

  it("migrated legacy doc passes needsMigration=false", () => {
    const legacy   = makeLegacyDoc();
    const migrated = migrateResumeDocument(legacy);
    assert.strictEqual(needsMigration(migrated), false);
  });
});
