/**
 * Tests for resumeDiff.mjs and resumeDiffToSuggestions.mjs
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/resumeDiff.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { diffResume } from "./resumeDiff.mjs";
import {
  diffToSuggestions,
  deduplicateWorkLogSuggestions
} from "./resumeDiffToSuggestions.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal valid resume document used as the "prev" baseline. */
function makeResume(overrides = {}) {
  return {
    meta: { language: "en", schemaVersion: 1, generatedAt: "2024-01-01T00:00:00Z" },
    contact: {
      name: "Alice Kim",
      email: "alice@example.com",
      phone: null,
      location: "Seoul",
      website: null,
      linkedin: null
    },
    summary: "Experienced software engineer.",
    experience: [
      {
        _source: "user",
        company: "Acme Corp",
        title: "Senior Engineer",
        start_date: "2022-01",
        end_date: "present",
        location: "Seoul",
        bullets: ["Led migration to microservices.", "Reduced deploy time by 40%."]
      }
    ],
    education: [
      {
        _source: "system",
        institution: "Seoul National University",
        degree: "B.S.",
        field: "Computer Science",
        start_date: "2014-03",
        end_date: "2018-02",
        gpa: null
      }
    ],
    skills: {
      technical: ["React", "Node.js"],
      languages: ["JavaScript", "TypeScript"],
      tools: ["Docker", "GitHub Actions"]
    },
    projects: [
      {
        _source: "system",
        name: "OpenSource CLI",
        description: "A CLI tool for productivity.",
        url: "https://github.com/alice/cli",
        bullets: ["Built plugin architecture."]
      }
    ],
    certifications: [
      {
        _source: "system",
        name: "AWS Solutions Architect",
        issuer: "Amazon",
        date: "2023-06"
      }
    ],
    strength_keywords: ["cloud", "devops", "microservices"],
    display_axes: [
      {
        label: "Full-Stack Engineer",
        tagline: "Building scalable web systems.",
        highlight_skills: ["React", "Node.js", "Docker"]
      }
    ],
    ...overrides
  };
}

// ─── diffResume — guard clauses ───────────────────────────────────────────────

describe("diffResume — guard clauses", () => {
  test("returns empty diff when prev is null", () => {
    const diff = diffResume(null, makeResume());
    assert.equal(diff.isEmpty, true);
  });

  test("returns empty diff when next is null", () => {
    const diff = diffResume(makeResume(), null);
    assert.equal(diff.isEmpty, true);
  });

  test("returns empty diff when both args are null", () => {
    const diff = diffResume(null, null);
    assert.equal(diff.isEmpty, true);
  });

  test("returns empty diff when prev is a primitive", () => {
    const diff = diffResume("not-an-object", makeResume());
    assert.equal(diff.isEmpty, true);
  });

  test("returns empty diff for identical documents", () => {
    const resume = makeResume();
    const diff = diffResume(resume, resume);
    assert.equal(diff.isEmpty, true);
  });

  test("returns empty diff for deep-equal but different object references", () => {
    const diff = diffResume(makeResume(), makeResume());
    assert.equal(diff.isEmpty, true);
  });
});

// ─── diffResume — contact ─────────────────────────────────────────────────────

describe("diffResume — contact", () => {
  test("detects added field (phone: null → value)", () => {
    const prev = makeResume({ contact: { ...makeResume().contact, phone: null } });
    const next = makeResume({ contact: { ...makeResume().contact, phone: "+82-10-1234-5678" } });
    const diff = diffResume(prev, next);
    assert.equal(diff.contact.added.phone, "+82-10-1234-5678");
    assert.equal(diff.contact.isEmpty, false);
  });

  test("detects deleted field (email: value → null)", () => {
    const prev = makeResume({ contact: { ...makeResume().contact, email: "alice@example.com" } });
    const next = makeResume({ contact: { ...makeResume().contact, email: null } });
    const diff = diffResume(prev, next);
    assert.equal(diff.contact.deleted.email, "alice@example.com");
  });

  test("detects modified field (location changed)", () => {
    const prev = makeResume({ contact: { ...makeResume().contact, location: "Seoul" } });
    const next = makeResume({ contact: { ...makeResume().contact, location: "Busan" } });
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.contact.modified.location, { prev: "Seoul", next: "Busan" });
  });

  test("no contact change → isEmpty: true", () => {
    const resume = makeResume();
    const diff = diffResume(resume, resume);
    assert.equal(diff.contact.isEmpty, true);
  });

  test("treats empty string same as null for contact fields", () => {
    const prev = makeResume({ contact: { ...makeResume().contact, website: "" } });
    const next = makeResume({ contact: { ...makeResume().contact, website: null } });
    const diff = diffResume(prev, next);
    assert.equal(diff.contact.isEmpty, true);
  });
});

// ─── diffResume — summary ─────────────────────────────────────────────────────

describe("diffResume — summary", () => {
  test("no change → changed: false", () => {
    const resume = makeResume();
    const diff = diffResume(resume, resume);
    assert.equal(diff.summary.changed, false);
  });

  test("changed summary → changed: true, prev and next populated", () => {
    const prev = makeResume({ summary: "Old summary text." });
    const next = makeResume({ summary: "New summary text." });
    const diff = diffResume(prev, next);
    assert.equal(diff.summary.changed, true);
    assert.equal(diff.summary.prev, "Old summary text.");
    assert.equal(diff.summary.next, "New summary text.");
    assert.equal(diff.summary.added, undefined);
    assert.equal(diff.summary.deleted, undefined);
  });

  test("added summary (prev empty) → added: true", () => {
    const prev = makeResume({ summary: "" });
    const next = makeResume({ summary: "Brand new summary." });
    const diff = diffResume(prev, next);
    assert.equal(diff.summary.changed, true);
    assert.equal(diff.summary.added, true);
    assert.equal(diff.summary.next, "Brand new summary.");
  });

  test("deleted summary (next empty) → deleted: true", () => {
    const prev = makeResume({ summary: "Existing summary." });
    const next = makeResume({ summary: "" });
    const diff = diffResume(prev, next);
    assert.equal(diff.summary.changed, true);
    assert.equal(diff.summary.deleted, true);
  });

  test("whitespace-only counts as empty", () => {
    const prev = makeResume({ summary: "   " });
    const next = makeResume({ summary: "" });
    const diff = diffResume(prev, next);
    assert.equal(diff.summary.changed, false);
  });
});

// ─── diffResume — experience ──────────────────────────────────────────────────

describe("diffResume — experience", () => {
  const baseExp = {
    _source: "user",
    company: "Acme Corp",
    title: "Senior Engineer",
    start_date: "2022-01",
    end_date: "present",
    location: "Seoul",
    bullets: ["Led migration to microservices.", "Reduced deploy time by 40%."]
  };

  test("added entry appears in experience.added", () => {
    const prev = makeResume({ experience: [] });
    const next = makeResume({ experience: [baseExp] });
    const diff = diffResume(prev, next);
    assert.equal(diff.experience.added.length, 1);
    assert.equal(diff.experience.added[0].company, "Acme Corp");
    assert.equal(diff.experience.modified.length, 0);
    assert.equal(diff.experience.deleted.length, 0);
  });

  test("deleted entry appears in experience.deleted", () => {
    const prev = makeResume({ experience: [baseExp] });
    const next = makeResume({ experience: [] });
    const diff = diffResume(prev, next);
    assert.equal(diff.experience.deleted.length, 1);
    assert.equal(diff.experience.deleted[0].company, "Acme Corp");
  });

  test("new bullet in existing entry → modified with bullets diff", () => {
    const prev = makeResume({ experience: [baseExp] });
    const next = makeResume({
      experience: [{ ...baseExp, bullets: [...baseExp.bullets, "New achievement added."] }]
    });
    const diff = diffResume(prev, next);
    assert.equal(diff.experience.modified.length, 1);
    const mod = diff.experience.modified[0];
    assert.ok(mod.fieldDiffs.bullets);
    assert.deepEqual(mod.fieldDiffs.bullets.added, ["New achievement added."]);
    assert.deepEqual(mod.fieldDiffs.bullets.deleted, []);
  });

  test("bullet removed → shows in bullets.deleted", () => {
    const prev = makeResume({ experience: [baseExp] });
    const next = makeResume({
      experience: [{ ...baseExp, bullets: ["Led migration to microservices."] }]
    });
    const diff = diffResume(prev, next);
    assert.equal(diff.experience.modified.length, 1);
    const mod = diff.experience.modified[0];
    assert.deepEqual(mod.fieldDiffs.bullets.deleted, ["Reduced deploy time by 40%."]);
  });

  test("_source: 'user' entry is flagged as userOwned in modified", () => {
    const prev = makeResume({ experience: [{ ...baseExp, _source: "user" }] });
    const next = makeResume({
      experience: [{ ...baseExp, _source: "user", bullets: [...baseExp.bullets, "Extra."] }]
    });
    const diff = diffResume(prev, next);
    assert.equal(diff.experience.modified[0].userOwned, true);
  });

  test("_source: 'system' entry is NOT flagged as userOwned", () => {
    const sysExp = { ...baseExp, _source: "system" };
    const prev = makeResume({ experience: [sysExp] });
    const next = makeResume({
      experience: [{ ...sysExp, bullets: [...sysExp.bullets, "Extra."] }]
    });
    const diff = diffResume(prev, next);
    assert.equal(diff.experience.modified[0].userOwned, false);
  });

  test("same company + different title → different identity key → treated as add+delete", () => {
    const prev = makeResume({
      experience: [{ ...baseExp, company: "Acme Corp", title: "Engineer" }]
    });
    const next = makeResume({
      experience: [{ ...baseExp, company: "Acme Corp", title: "Senior Engineer" }]
    });
    const diff = diffResume(prev, next);
    // Different key (company::title), so treated as add/delete
    assert.equal(diff.experience.added.length, 1);
    assert.equal(diff.experience.deleted.length, 1);
  });

  test("scalar field change (title) appears in fieldDiffs", () => {
    const prev = makeResume({
      experience: [{ ...baseExp, title: "Engineer" }]
    });
    const next = makeResume({
      experience: [{ ...baseExp, title: "Lead Engineer" }]
    });
    // Same identity key? No - title is part of the key. So it's add+delete.
    // Let's verify: experienceKey = company::title
    const diff = diffResume(prev, next);
    assert.equal(diff.experience.added.length, 1);
    assert.equal(diff.experience.deleted.length, 1);
  });

  test("location change within same company+title → appears in fieldDiffs.location", () => {
    const prev = makeResume({
      experience: [{ ...baseExp, location: "Seoul" }]
    });
    const next = makeResume({
      experience: [{ ...baseExp, location: "Busan" }]
    });
    const diff = diffResume(prev, next);
    // Same key (company::title), location changed
    assert.equal(diff.experience.modified.length, 1);
    assert.deepEqual(diff.experience.modified[0].fieldDiffs.location, {
      prev: "Seoul",
      next: "Busan"
    });
  });
});

// ─── diffResume — education ───────────────────────────────────────────────────

describe("diffResume — education", () => {
  const baseEdu = {
    _source: "system",
    institution: "Seoul National University",
    degree: "B.S.",
    field: "Computer Science",
    start_date: "2014-03",
    end_date: "2018-02",
    gpa: null
  };

  test("added education appears in education.added", () => {
    const prev = makeResume({ education: [] });
    const next = makeResume({ education: [baseEdu] });
    const diff = diffResume(prev, next);
    assert.equal(diff.education.added.length, 1);
    assert.equal(diff.education.added[0].institution, "Seoul National University");
  });

  test("gpa field added → shows in fieldDiffs.gpa", () => {
    const prev = makeResume({ education: [{ ...baseEdu, gpa: null }] });
    const next = makeResume({ education: [{ ...baseEdu, gpa: "4.0/4.5" }] });
    const diff = diffResume(prev, next);
    assert.equal(diff.education.modified.length, 1);
    assert.deepEqual(diff.education.modified[0].fieldDiffs.gpa, {
      prev: null,
      next: "4.0/4.5"
    });
  });
});

// ─── diffResume — skills ──────────────────────────────────────────────────────

describe("diffResume — skills", () => {
  test("new technical skill → skills.technical.added", () => {
    const prev = makeResume({ skills: { technical: ["React"], languages: [], tools: [] } });
    const next = makeResume({
      skills: { technical: ["React", "Vue.js"], languages: [], tools: [] }
    });
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.skills.technical.added, ["Vue.js"]);
    assert.deepEqual(diff.skills.technical.deleted, []);
  });

  test("removed skill → skills.technical.deleted", () => {
    const prev = makeResume({
      skills: { technical: ["React", "Angular"], languages: [], tools: [] }
    });
    const next = makeResume({
      skills: { technical: ["React"], languages: [], tools: [] }
    });
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.skills.technical.deleted, ["Angular"]);
  });

  test("skill comparison is case-insensitive (normalised)", () => {
    const prev = makeResume({
      skills: { technical: ["react"], languages: [], tools: [] }
    });
    const next = makeResume({
      skills: { technical: ["React"], languages: [], tools: [] }
    });
    // Normalised: both become "react" — no change
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.skills.technical.added, []);
    assert.deepEqual(diff.skills.technical.deleted, []);
  });

  test("new language skill detected", () => {
    const prev = makeResume({
      skills: { technical: [], languages: ["JavaScript"], tools: [] }
    });
    const next = makeResume({
      skills: { technical: [], languages: ["JavaScript", "Rust"], tools: [] }
    });
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.skills.languages.added, ["Rust"]);
  });

  test("new tool skill detected", () => {
    const prev = makeResume({ skills: { technical: [], languages: [], tools: ["Docker"] } });
    const next = makeResume({
      skills: { technical: [], languages: [], tools: ["Docker", "Kubernetes"] }
    });
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.skills.tools.added, ["Kubernetes"]);
  });

  test("no skill changes → isEmpty stays true", () => {
    const resume = makeResume();
    const diff = diffResume(resume, resume);
    assert.deepEqual(diff.skills.technical.added, []);
    assert.deepEqual(diff.skills.technical.deleted, []);
    assert.equal(diff.isEmpty, true);
  });
});

// ─── diffResume — projects ────────────────────────────────────────────────────

describe("diffResume — projects", () => {
  const baseProject = {
    _source: "system",
    name: "OpenSource CLI",
    description: "A CLI tool.",
    url: null,
    bullets: ["Built plugin architecture."]
  };

  test("added project appears in projects.added", () => {
    const prev = makeResume({ projects: [] });
    const next = makeResume({ projects: [baseProject] });
    const diff = diffResume(prev, next);
    assert.equal(diff.projects.added.length, 1);
    assert.equal(diff.projects.added[0].name, "OpenSource CLI");
  });

  test("new bullet in project → modified.fieldDiffs.bullets.added", () => {
    const prev = makeResume({ projects: [baseProject] });
    const next = makeResume({
      projects: [{ ...baseProject, bullets: [...baseProject.bullets, "Added tests."] }]
    });
    const diff = diffResume(prev, next);
    assert.equal(diff.projects.modified.length, 1);
    assert.deepEqual(diff.projects.modified[0].fieldDiffs.bullets.added, ["Added tests."]);
  });

  test("url field added to project → fieldDiffs.url", () => {
    const prev = makeResume({ projects: [{ ...baseProject, url: null }] });
    const next = makeResume({ projects: [{ ...baseProject, url: "https://github.com/foo" }] });
    const diff = diffResume(prev, next);
    assert.equal(diff.projects.modified.length, 1);
    assert.deepEqual(diff.projects.modified[0].fieldDiffs.url, {
      prev: null,
      next: "https://github.com/foo"
    });
  });
});

// ─── diffResume — certifications ──────────────────────────────────────────────

describe("diffResume — certifications", () => {
  const baseCert = {
    _source: "system",
    name: "AWS Solutions Architect",
    issuer: "Amazon",
    date: "2023-06"
  };

  test("new certification appears in certifications.added", () => {
    const prev = makeResume({ certifications: [] });
    const next = makeResume({ certifications: [baseCert] });
    const diff = diffResume(prev, next);
    assert.equal(diff.certifications.added.length, 1);
  });

  test("changed issuer appears in fieldDiffs", () => {
    const prev = makeResume({ certifications: [{ ...baseCert, issuer: "Amazon Web Services" }] });
    const next = makeResume({ certifications: [{ ...baseCert, issuer: "AWS" }] });
    const diff = diffResume(prev, next);
    assert.equal(diff.certifications.modified.length, 1);
    assert.ok(diff.certifications.modified[0].fieldDiffs.issuer);
  });
});

// ─── diffResume — strength_keywords ──────────────────────────────────────────

describe("diffResume — strength_keywords", () => {
  test("new keyword appears in added", () => {
    const prev = makeResume({ strength_keywords: ["cloud", "devops"] });
    const next = makeResume({ strength_keywords: ["cloud", "devops", "kubernetes"] });
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.strength_keywords.added, ["kubernetes"]);
    assert.deepEqual(diff.strength_keywords.deleted, []);
  });

  test("removed keyword appears in deleted", () => {
    const prev = makeResume({ strength_keywords: ["cloud", "devops", "microservices"] });
    const next = makeResume({ strength_keywords: ["cloud", "devops"] });
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.strength_keywords.deleted, ["microservices"]);
  });

  test("keyword comparison is order-insensitive", () => {
    const prev = makeResume({ strength_keywords: ["a", "b", "c"] });
    const next = makeResume({ strength_keywords: ["c", "a", "b"] });
    const diff = diffResume(prev, next);
    assert.deepEqual(diff.strength_keywords.added, []);
    assert.deepEqual(diff.strength_keywords.deleted, []);
  });
});

// ─── diffResume — display_axes ────────────────────────────────────────────────

describe("diffResume — display_axes", () => {
  const baseAxis = {
    label: "Full-Stack Engineer",
    tagline: "Building scalable web systems.",
    highlight_skills: ["React", "Node.js", "Docker"]
  };

  test("new axis appears in display_axes.added", () => {
    const prev = makeResume({ display_axes: [] });
    const next = makeResume({ display_axes: [baseAxis] });
    const diff = diffResume(prev, next);
    assert.equal(diff.display_axes.added.length, 1);
    assert.equal(diff.display_axes.added[0].label, "Full-Stack Engineer");
  });

  test("tagline change → modified.fieldDiffs.tagline", () => {
    const prev = makeResume({ display_axes: [{ ...baseAxis, tagline: "Old tagline." }] });
    const next = makeResume({ display_axes: [{ ...baseAxis, tagline: "New tagline." }] });
    const diff = diffResume(prev, next);
    assert.equal(diff.display_axes.modified.length, 1);
    assert.deepEqual(diff.display_axes.modified[0].fieldDiffs.tagline, {
      prev: "Old tagline.",
      next: "New tagline."
    });
  });

  test("new highlight_skill → fieldDiffs.highlight_skills.added", () => {
    const prev = makeResume({
      display_axes: [{ ...baseAxis, highlight_skills: ["React"] }]
    });
    const next = makeResume({
      display_axes: [{ ...baseAxis, highlight_skills: ["React", "GraphQL"] }]
    });
    const diff = diffResume(prev, next);
    assert.equal(diff.display_axes.modified.length, 1);
    assert.deepEqual(
      diff.display_axes.modified[0].fieldDiffs.highlight_skills.added,
      ["GraphQL"]
    );
  });
});

// ─── diffResume — isEmpty flag ────────────────────────────────────────────────

describe("diffResume — isEmpty flag", () => {
  test("isEmpty: false when contact differs", () => {
    const prev = makeResume({ contact: { ...makeResume().contact, phone: null } });
    const next = makeResume({ contact: { ...makeResume().contact, phone: "+82-10-0000" } });
    const diff = diffResume(prev, next);
    assert.equal(diff.isEmpty, false);
  });

  test("isEmpty: false when summary differs", () => {
    const prev = makeResume({ summary: "Old" });
    const next = makeResume({ summary: "New" });
    const diff = diffResume(prev, next);
    assert.equal(diff.isEmpty, false);
  });

  test("isEmpty: false when experience.added is non-empty", () => {
    const prev = makeResume({ experience: [] });
    const next = makeResume();
    const diff = diffResume(prev, next);
    assert.equal(diff.isEmpty, false);
  });

  test("isEmpty: false when skills differ", () => {
    const prev = makeResume({ skills: { technical: [], languages: [], tools: [] } });
    const next = makeResume({ skills: { technical: ["React"], languages: [], tools: [] } });
    const diff = diffResume(prev, next);
    assert.equal(diff.isEmpty, false);
  });

  test("isEmpty: false when strength_keywords differ", () => {
    const prev = makeResume({ strength_keywords: [] });
    const next = makeResume({ strength_keywords: ["cloud"] });
    const diff = diffResume(prev, next);
    assert.equal(diff.isEmpty, false);
  });
});

// ─── diffToSuggestions ────────────────────────────────────────────────────────

describe("diffToSuggestions — basic", () => {
  test("returns [] for empty diff", () => {
    const diff = diffResume(makeResume(), makeResume());
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    assert.deepEqual(suggestions, []);
  });

  test("returns [] when diff is null", () => {
    const suggestions = diffToSuggestions(null, "2026-03-27");
    assert.deepEqual(suggestions, []);
  });

  test("summary.added → update_summary suggestion", () => {
    const prev = makeResume({ summary: "" });
    const next = makeResume({ summary: "New professional summary." });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    assert.equal(suggestions.length, 1);
    const s = suggestions[0];
    assert.equal(s.action, "update_summary");
    assert.equal(s.section, "summary");
    assert.equal(s.source, "work_log");
    assert.equal(s.status, "pending");
    assert.equal(s.logDate, "2026-03-27");
    assert.equal(s.patch.text, "New professional summary.");
    assert.ok(s.id, "Should have an id");
    assert.ok(s.createdAt, "Should have createdAt");
  });

  test("summary changed (not added) → NO update_summary suggestion", () => {
    const prev = makeResume({ summary: "Old summary." });
    const next = makeResume({ summary: "New summary." });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    // Only additive: changed summary (not added from empty) is skipped
    const summarySuggestions = suggestions.filter((s) => s.action === "update_summary");
    assert.equal(summarySuggestions.length, 0);
  });

  test("experience.added → add_experience skeleton + separate append_bullet per bullet (AC 7-2)", () => {
    // AC 7-2: no proposal may span multiple bullets.
    // add_experience carries entry skeleton (bullets: []).
    // Each bullet of the new entry is emitted as a separate append_bullet.
    const newExp = {
      _source: "system",
      company: "Beta Co",
      title: "Engineer",
      start_date: "2024-01",
      end_date: "present",
      location: null,
      bullets: ["Built feature X.", "Reduced latency by 20%."]
    };
    const prev = makeResume({ experience: [] });
    const next = makeResume({ experience: [newExp] });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");

    // 1 add_experience (skeleton) + 2 append_bullet (one per bullet)
    assert.equal(suggestions.length, 3);

    const addExp = suggestions.find((s) => s.action === "add_experience");
    assert.ok(addExp, "Must have an add_experience suggestion");
    assert.equal(addExp.section, "experience");
    assert.equal(addExp.patch.entry.company, "Beta Co");
    // Skeleton must have empty bullets array (AC 7-2)
    assert.deepEqual(addExp.patch.entry.bullets, []);

    const bulletSuggs = suggestions.filter((s) => s.action === "append_bullet");
    assert.equal(bulletSuggs.length, 2, "One append_bullet per bullet in the new entry");
    const bulletTexts = bulletSuggs.map((s) => s.patch.bullet);
    assert.ok(bulletTexts.includes("Built feature X."), "First bullet must be proposed");
    assert.ok(bulletTexts.includes("Reduced latency by 20%."), "Second bullet must be proposed");
    // Each append_bullet patch must reference the parent company
    for (const bs of bulletSuggs) {
      assert.equal(bs.patch.company, "Beta Co");
    }
  });

  test("experience.added with no bullets → only add_experience (no bullet proposals)", () => {
    const newExp = {
      _source: "system",
      company: "Beta Co",
      title: "Engineer",
      start_date: "2024-01",
      end_date: "present",
      location: null,
      bullets: []
    };
    const prev = makeResume({ experience: [] });
    const next = makeResume({ experience: [newExp] });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].action, "add_experience");
    assert.deepEqual(suggestions[0].patch.entry.bullets, []);
  });

  test("experience.modified with new bullets → append_bullet suggestion per bullet", () => {
    const baseExp = makeResume().experience[0]; // Acme Corp
    const prev = makeResume();
    const next = makeResume({
      experience: [
        { ...baseExp, bullets: [...baseExp.bullets, "New achievement bullet."] }
      ]
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    assert.equal(suggestions.length, 1);
    const s = suggestions[0];
    assert.equal(s.action, "append_bullet");
    assert.equal(s.patch.company, "Acme Corp");
    assert.equal(s.patch.bullet, "New achievement bullet.");
  });

  test("new skills → add_skills suggestion with all new skills batched", () => {
    const prev = makeResume({
      skills: { technical: ["React"], languages: ["JavaScript"], tools: [] }
    });
    const next = makeResume({
      skills: {
        technical: ["React", "Vue.js"],
        languages: ["JavaScript", "TypeScript"],
        tools: ["Kubernetes"]
      }
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    assert.equal(suggestions.length, 1);
    const s = suggestions[0];
    assert.equal(s.action, "add_skills");
    assert.equal(s.section, "skills");
    assert.ok(s.patch.skills.includes("Vue.js"));
    assert.ok(s.patch.skills.includes("TypeScript"));
    assert.ok(s.patch.skills.includes("Kubernetes"));
    assert.equal(s.patch.skills.length, 3);
  });

  test("skill deletions do NOT generate suggestions", () => {
    const prev = makeResume({
      skills: { technical: ["React", "Angular"], languages: [], tools: [] }
    });
    const next = makeResume({
      skills: { technical: ["React"], languages: [], tools: [] }
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    // Angular deleted → should NOT produce suggestion
    assert.equal(suggestions.length, 0);
  });

  test("experience.deleted does NOT generate suggestions", () => {
    const prev = makeResume();
    const next = makeResume({ experience: [] });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    assert.equal(suggestions.length, 0);
  });

  test("all suggestion items have required fields", () => {
    const prev = makeResume({ experience: [] });
    const next = makeResume();
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");
    assert.ok(suggestions.length > 0);
    for (const s of suggestions) {
      assert.ok(s.id, "Missing id");
      assert.ok(s.type, "Missing type");
      assert.ok(s.section, "Missing section");
      assert.ok(s.action, "Missing action");
      assert.ok(s.description, "Missing description");
      assert.ok(s.detail, "Missing detail");
      assert.ok(s.patch, "Missing patch");
      assert.equal(s.source, "work_log");
      assert.equal(s.status, "pending");
      assert.ok(s.createdAt, "Missing createdAt");
    }
  });

  test("logDate defaults to today when not provided", () => {
    const prev = makeResume({ summary: "" });
    const next = makeResume({ summary: "New summary." });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff); // no logDate
    assert.equal(suggestions.length, 1);
    assert.ok(suggestions[0].logDate, "Should have logDate");
  });
});

// ─── deduplicateWorkLogSuggestions ───────────────────────────────────────────

describe("deduplicateWorkLogSuggestions", () => {
  function makeSuggestion(overrides = {}) {
    return {
      id: "test-id",
      type: "work_log_update",
      section: "experience",
      action: "append_bullet",
      description: "Acme Corp: Built feature.",
      detail: "2026-03-27 업무 로그 기반",
      patch: { company: "Acme Corp", bullet: "Built feature X." },
      source: "work_log",
      logDate: "2026-03-27",
      createdAt: new Date().toISOString(),
      status: "pending",
      ...overrides
    };
  }

  test("no existing suggestions → all new suggestions pass through", () => {
    const newSugg = [makeSuggestion()];
    const result = deduplicateWorkLogSuggestions([], newSugg);
    assert.equal(result.length, 1);
  });

  test("empty new suggestions → returns []", () => {
    const existing = [makeSuggestion()];
    const result = deduplicateWorkLogSuggestions(existing, []);
    assert.deepEqual(result, []);
  });

  test("duplicate append_bullet (same company + bullet) → filtered out", () => {
    const existing = [
      makeSuggestion({
        action: "append_bullet",
        status: "pending",
        patch: { company: "Acme Corp", bullet: "Built feature X." }
      })
    ];
    const newSugg = [
      makeSuggestion({
        action: "append_bullet",
        patch: { company: "Acme Corp", bullet: "Built feature X." }
      })
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 0);
  });

  test("different bullet for same company → passes through", () => {
    const existing = [
      makeSuggestion({
        action: "append_bullet",
        status: "pending",
        patch: { company: "Acme Corp", bullet: "Built feature X." }
      })
    ];
    const newSugg = [
      makeSuggestion({
        action: "append_bullet",
        patch: { company: "Acme Corp", bullet: "Improved performance by 30%." }
      })
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 1);
  });

  test("duplicate update_summary → filtered out", () => {
    const existing = [
      makeSuggestion({ action: "update_summary", section: "summary", status: "pending" })
    ];
    const newSugg = [
      makeSuggestion({ action: "update_summary", section: "summary" })
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 0);
  });

  test("update_summary with rejected existing → new passes through", () => {
    const existing = [
      makeSuggestion({
        action: "update_summary",
        section: "summary",
        status: "rejected" // not pending
      })
    ];
    const newSugg = [
      makeSuggestion({ action: "update_summary", section: "summary" })
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 1);
  });

  test("duplicate add_experience (same company) → filtered out", () => {
    const existing = [
      makeSuggestion({
        action: "add_experience",
        section: "experience",
        status: "pending",
        patch: { entry: { company: "Beta Co", title: "Engineer", bullets: [] } }
      })
    ];
    const newSugg = [
      makeSuggestion({
        action: "add_experience",
        patch: { entry: { company: "Beta Co", title: "Senior Engineer", bullets: [] } }
      })
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 0);
  });

  test("add_skills with already-covered skills → removed from batch", () => {
    const existing = [
      makeSuggestion({
        action: "add_skills",
        section: "skills",
        status: "pending",
        patch: { skills: ["Vue.js", "TypeScript"] }
      })
    ];
    const newSugg = [
      makeSuggestion({
        action: "add_skills",
        section: "skills",
        patch: { skills: ["Vue.js", "TypeScript", "Kubernetes"] }
      })
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    // Only Kubernetes is new
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].patch.skills, ["Kubernetes"]);
  });

  test("add_skills all already covered → returns []", () => {
    const existing = [
      makeSuggestion({
        action: "add_skills",
        section: "skills",
        status: "pending",
        patch: { skills: ["Vue.js"] }
      })
    ];
    const newSugg = [
      makeSuggestion({
        action: "add_skills",
        section: "skills",
        patch: { skills: ["Vue.js"] }
      })
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 0);
  });

  test("skill dedup is case-insensitive", () => {
    const existing = [
      makeSuggestion({
        action: "add_skills",
        section: "skills",
        status: "pending",
        patch: { skills: ["vue.js"] }
      })
    ];
    const newSugg = [
      makeSuggestion({
        action: "add_skills",
        section: "skills",
        patch: { skills: ["Vue.js"] }
      })
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 0);
  });

  test("duplicate bullets within newSuggestions themselves → deduplicated", () => {
    const s1 = makeSuggestion({
      id: "s1",
      action: "append_bullet",
      patch: { company: "Acme Corp", bullet: "Same bullet." }
    });
    const s2 = makeSuggestion({
      id: "s2",
      action: "append_bullet",
      patch: { company: "Acme Corp", bullet: "Same bullet." }
    });
    const result = deduplicateWorkLogSuggestions([], [s1, s2]);
    assert.equal(result.length, 1);
  });

  test("non-null existing is required to be an array", () => {
    // If existingSuggestions is not an array, treat as empty
    const newSugg = [makeSuggestion()];
    const result = deduplicateWorkLogSuggestions(null, newSugg);
    assert.equal(result.length, 1);
  });
});

// ─── Integration: diffResume → diffToSuggestions pipeline ─────────────────────

describe("integration — full pipeline", () => {
  test("work log added a bullet → one append_bullet suggestion", () => {
    const baseExp = {
      _source: "system",
      company: "Acme Corp",
      title: "Senior Engineer",
      start_date: "2022-01",
      end_date: "present",
      location: "Seoul",
      bullets: ["Led migration to microservices."]
    };

    const existing = makeResume({ experience: [baseExp] });
    const proposed = makeResume({
      experience: [{ ...baseExp, bullets: [...baseExp.bullets, "Shipped new dashboard."] }]
    });

    const diff = diffResume(existing, proposed);
    assert.equal(diff.isEmpty, false);

    const suggestions = diffToSuggestions(diff, "2026-03-27");
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].action, "append_bullet");
    assert.equal(suggestions[0].patch.bullet, "Shipped new dashboard.");
    assert.equal(suggestions[0].patch.company, "Acme Corp");
  });

  test("work log added new company experience + new skills (AC 7-2 bullet split)", () => {
    // AC 7-2: add_experience is skeleton (bullets:[]) + separate append_bullet per bullet
    const existing = makeResume({ experience: [], skills: { technical: [], languages: [], tools: [] } });
    const proposed = makeResume({
      experience: [
        {
          _source: "system",
          company: "Gamma Inc",
          title: "Developer",
          start_date: "2025-01",
          end_date: "present",
          location: null,
          bullets: ["Built REST API."]
        }
      ],
      skills: { technical: ["Hono"], languages: ["TypeScript"], tools: [] }
    });

    const diff = diffResume(existing, proposed);
    assert.equal(diff.isEmpty, false);

    const suggestions = diffToSuggestions(diff, "2026-03-27");
    // Expect: 1 add_experience (skeleton) + 1 append_bullet + 1 add_skills
    const addExp = suggestions.filter((s) => s.action === "add_experience");
    const addBullets = suggestions.filter((s) => s.action === "append_bullet");
    const addSkills = suggestions.filter((s) => s.action === "add_skills");
    assert.equal(addExp.length, 1);
    assert.equal(addBullets.length, 1, "One append_bullet for the single bullet of the new entry");
    assert.equal(addSkills.length, 1);
    assert.equal(addExp[0].patch.entry.company, "Gamma Inc");
    // Skeleton must have empty bullets (AC 7-2)
    assert.deepEqual(addExp[0].patch.entry.bullets, []);
    // Bullet proposed separately
    assert.equal(addBullets[0].patch.bullet, "Built REST API.");
    assert.equal(addBullets[0].patch.company, "Gamma Inc");
    assert.ok(addSkills[0].patch.skills.includes("Hono"));
    assert.ok(addSkills[0].patch.skills.includes("TypeScript"));
  });

  test("deduplication: second run on same data generates no suggestions", () => {
    const baseExp = {
      _source: "system",
      company: "Acme Corp",
      title: "Senior Engineer",
      start_date: "2022-01",
      end_date: "present",
      location: null,
      bullets: ["Led migration."]
    };
    const existing = makeResume({ experience: [baseExp] });
    const proposed = makeResume({
      experience: [{ ...baseExp, bullets: [...baseExp.bullets, "New bullet."] }]
    });

    const diff = diffResume(existing, proposed);
    const firstBatch = diffToSuggestions(diff, "2026-03-27");
    assert.equal(firstBatch.length, 1);

    // Simulate second run with same data — deduplicate
    const secondBatch = diffToSuggestions(diff, "2026-03-27");
    const deduped = deduplicateWorkLogSuggestions(
      firstBatch, // already-stored from first run
      secondBatch
    );
    assert.equal(deduped.length, 0, "Second run should produce no new suggestions");
  });
});


// ─── AC 7-2: bullet-granularity proposals ─────────────────────────────────────

describe("AC 7-2 — delete_bullet proposals", () => {
  test("experience.modified with deleted bullets → delete_bullet suggestion per bullet", () => {
    const baseExp = makeResume().experience[0]; // Acme Corp
    const prev = makeResume({
      experience: [{ ...baseExp, bullets: ["Led migration.", "Reduced deploy time."] }]
    });
    const next = makeResume({
      experience: [{ ...baseExp, bullets: ["Led migration."] }] // "Reduced deploy time." removed
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");

    const delBullets = suggestions.filter((s) => s.action === "delete_bullet");
    assert.equal(delBullets.length, 1, "One delete_bullet per deleted bullet");
    assert.equal(delBullets[0].section, "experience");
    assert.equal(delBullets[0].patch.section, "experience");
    assert.equal(delBullets[0].patch.company, "Acme Corp");
    assert.equal(delBullets[0].patch.bullet, "Reduced deploy time.");
  });

  test("multiple bullets deleted → one delete_bullet proposal per bullet", () => {
    const baseExp = makeResume().experience[0];
    const prev = makeResume({
      experience: [{ ...baseExp, bullets: ["Bullet A.", "Bullet B.", "Bullet C."] }]
    });
    const next = makeResume({
      experience: [{ ...baseExp, bullets: ["Bullet C."] }]
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");

    const delBullets = suggestions.filter((s) => s.action === "delete_bullet");
    assert.equal(delBullets.length, 2, "One delete_bullet per deleted bullet (A and B)");
    const deletedTexts = delBullets.map((s) => s.patch.bullet);
    assert.ok(deletedTexts.includes("Bullet A."), "Bullet A must be proposed for deletion");
    assert.ok(deletedTexts.includes("Bullet B."), "Bullet B must be proposed for deletion");
  });

  test("delete_bullet deduplication: same bullet already pending → filtered out", () => {
    const existing = [
      {
        id: "x1",
        action: "delete_bullet",
        status: "pending",
        section: "experience",
        patch: { section: "experience", company: "Acme Corp", bullet: "Reduce deploy time." }
      }
    ];
    const newSugg = [
      {
        id: "x2",
        action: "delete_bullet",
        status: "pending",
        section: "experience",
        patch: { section: "experience", company: "Acme Corp", bullet: "Reduce deploy time." }
      }
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 0, "Duplicate delete_bullet must be filtered out");
  });

  test("delete_bullet deduplication: different company → passes through", () => {
    const existing = [
      {
        id: "x1",
        action: "delete_bullet",
        status: "pending",
        section: "experience",
        patch: { section: "experience", company: "Acme Corp", bullet: "Same bullet." }
      }
    ];
    const newSugg = [
      {
        id: "x2",
        action: "delete_bullet",
        status: "pending",
        section: "experience",
        patch: { section: "experience", company: "Other Corp", bullet: "Same bullet." }
      }
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 1, "Different company = different entity; should pass through");
  });
});

describe("AC 7-2 — replace_bullet proposals (fuzzy pairing)", () => {
  test("similar deleted+added bullet → replace_bullet (not separate delete+add)", () => {
    const baseExp = makeResume().experience[0]; // Acme Corp
    // Old: "Led migration to microservices architecture."
    // New: "Led successful migration to microservices architecture." (very similar)
    const prev = makeResume({
      experience: [{ ...baseExp, bullets: ["Led migration to microservices architecture."] }]
    });
    const next = makeResume({
      experience: [{ ...baseExp, bullets: ["Led successful migration to microservices architecture."] }]
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");

    const replaceSuggs = suggestions.filter((s) => s.action === "replace_bullet");
    const deleteSuggs = suggestions.filter((s) => s.action === "delete_bullet");
    const appendSuggs = suggestions.filter((s) => s.action === "append_bullet");

    assert.equal(replaceSuggs.length, 1, "Should produce one replace_bullet for the similar pair");
    assert.equal(deleteSuggs.length, 0, "Should NOT produce a delete_bullet (paired as replace)");
    assert.equal(appendSuggs.length, 0, "Should NOT produce an append_bullet (paired as replace)");

    const rep = replaceSuggs[0];
    assert.equal(rep.section, "experience");
    assert.equal(rep.patch.section, "experience");
    assert.equal(rep.patch.company, "Acme Corp");
    assert.equal(rep.patch.oldBullet, "Led migration to microservices architecture.");
    assert.equal(rep.patch.newBullet, "Led successful migration to microservices architecture.");
  });

  test("dissimilar deleted+added bullets → separate delete_bullet + append_bullet", () => {
    const baseExp = makeResume().experience[0];
    const prev = makeResume({
      experience: [{ ...baseExp, bullets: ["Managed database operations."] }]
    });
    const next = makeResume({
      experience: [{ ...baseExp, bullets: ["Built real-time streaming pipeline with Kafka."] }]
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");

    const replaceSuggs = suggestions.filter((s) => s.action === "replace_bullet");
    const deleteSuggs = suggestions.filter((s) => s.action === "delete_bullet");
    const appendSuggs = suggestions.filter((s) => s.action === "append_bullet");

    // The two bullets share almost no words → no pairing → separate proposals
    assert.equal(replaceSuggs.length, 0, "Dissimilar bullets must NOT be paired as replace");
    assert.equal(deleteSuggs.length, 1, "Dissimilar deleted bullet → delete_bullet");
    assert.equal(appendSuggs.length, 1, "Dissimilar added bullet → append_bullet");
  });

  test("replace_bullet deduplication: same oldBullet already pending → filtered out", () => {
    const existing = [
      {
        id: "r1",
        action: "replace_bullet",
        status: "pending",
        section: "experience",
        patch: {
          section: "experience",
          company: "Acme Corp",
          oldBullet: "Old text.",
          newBullet: "New text."
        }
      }
    ];
    const newSugg = [
      {
        id: "r2",
        action: "replace_bullet",
        status: "pending",
        section: "experience",
        patch: {
          section: "experience",
          company: "Acme Corp",
          oldBullet: "Old text.",
          newBullet: "Updated text."
        }
      }
    ];
    const result = deduplicateWorkLogSuggestions(existing, newSugg);
    assert.equal(result.length, 0, "Duplicate replace on same oldBullet must be filtered");
  });
});

describe("AC 7-2 — project bullet proposals", () => {
  test("projects.modified with new bullet → append_bullet with section:'projects'", () => {
    const baseProject = makeResume().projects[0]; // "Plugin System" project
    const prev = makeResume();
    const next = makeResume({
      projects: [{ ...baseProject, bullets: [...(baseProject.bullets ?? []), "Added integration tests."] }]
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");

    const projBullets = suggestions.filter(
      (s) => s.action === "append_bullet" && s.section === "projects"
    );
    assert.equal(projBullets.length, 1, "One append_bullet for project bullet");
    assert.equal(projBullets[0].patch.section, "projects");
    assert.equal(projBullets[0].patch.projectName, baseProject.name);
    assert.equal(projBullets[0].patch.bullet, "Added integration tests.");
  });

  test("projects.modified with deleted bullet → delete_bullet with section:'projects'", () => {
    const baseProject = makeResume().projects[0];
    const prev = makeResume({
      projects: [{ ...baseProject, bullets: ["Built plugin architecture.", "Removed feature."] }]
    });
    const next = makeResume({
      projects: [{ ...baseProject, bullets: ["Built plugin architecture."] }]
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");

    const delBullets = suggestions.filter(
      (s) => s.action === "delete_bullet" && s.section === "projects"
    );
    assert.equal(delBullets.length, 1, "One delete_bullet for removed project bullet");
    assert.equal(delBullets[0].patch.section, "projects");
    assert.equal(delBullets[0].patch.projectName, baseProject.name);
    assert.equal(delBullets[0].patch.bullet, "Removed feature.");
  });

  test("every bullet proposal targets exactly one bullet (AC 7-2 invariant)", () => {
    // Verify that no single suggestion contains references to multiple bullets.
    // This is the core AC 7-2 guarantee.
    const baseExp = makeResume().experience[0];
    const prev = makeResume({
      experience: [
        { ...baseExp, bullets: ["Old A.", "Old B.", "Shared bullet."] }
      ]
    });
    const next = makeResume({
      experience: [
        { ...baseExp, bullets: ["New A.", "New B.", "Shared bullet.", "Extra bullet."] }
      ]
    });
    const diff = diffResume(prev, next);
    const suggestions = diffToSuggestions(diff, "2026-03-27");

    for (const s of suggestions) {
      if (s.action === "append_bullet" || s.action === "delete_bullet") {
        assert.equal(typeof s.patch.bullet, "string",
          `${s.action} must have exactly one bullet string`);
        // bullet is a primitive string — by definition spans only one bullet
      }
      if (s.action === "replace_bullet") {
        assert.equal(typeof s.patch.oldBullet, "string",
          "replace_bullet must have exactly one oldBullet string");
        assert.equal(typeof s.patch.newBullet, "string",
          "replace_bullet must have exactly one newBullet string");
      }
      if (s.action === "add_experience") {
        assert.deepEqual(s.patch.entry.bullets, [],
          "add_experience skeleton must have no bullets (AC 7-2)");
      }
    }
  });
});

// ─── AC 13: supersede pending candidates on new generation ────────────────────

/**
 * Simulate the supersede-pending logic from POST /api/resume/generate-candidates.
 *
 * This helper mirrors the in-route transformation exactly so that the unit
 * test exercises the same logic path without spinning up a full HTTP server.
 *
 * @param {object[]} existingSuggestions  Stored suggestions array (any statuses)
 * @param {object[]} newCandidates        Freshly generated candidates (all pending)
 * @returns {{ superseded: number, updatedSuggestions: object[] }}
 */
function simulateSupersede(existingSuggestions, newCandidates) {
  const supersededAt = new Date().toISOString();
  const pendingToDiscard = existingSuggestions.filter((s) => s.status === "pending");
  const supersededSuggestions = existingSuggestions.map((s) =>
    s.status === "pending"
      ? { ...s, status: "discarded", discardedAt: supersededAt, discardReason: "superseded" }
      : s
  );
  return {
    superseded: pendingToDiscard.length,
    updatedSuggestions: [...supersededSuggestions, ...newCandidates]
  };
}

describe("AC 13 — supersede pending candidates on generate-candidates", () => {
  test("all pending suggestions are batch-discarded when new candidates arrive", () => {
    const existing = [
      { id: "a1", action: "append_bullet", status: "pending", patch: { bullet: "Old bullet 1" } },
      { id: "a2", action: "append_bullet", status: "pending", patch: { bullet: "Old bullet 2" } },
      { id: "a3", action: "add_skills",    status: "pending", patch: { skills: ["OldSkill"] } }
    ];
    const newCandidates = [
      { id: "b1", action: "append_bullet", status: "pending", patch: { bullet: "New bullet" } }
    ];

    const { superseded, updatedSuggestions } = simulateSupersede(existing, newCandidates);

    assert.equal(superseded, 3, "All three pending items must be counted as superseded");

    const nowDiscarded = updatedSuggestions.filter((s) => s.status === "discarded");
    assert.equal(nowDiscarded.length, 3, "Three items must end up as discarded");
    for (const d of nowDiscarded) {
      assert.equal(d.discardReason, "superseded", "discardReason must be 'superseded'");
      assert.ok(typeof d.discardedAt === "string", "discardedAt must be set");
    }

    const stillPending = updatedSuggestions.filter((s) => s.status === "pending");
    assert.equal(stillPending.length, 1, "Only the new candidate must remain pending");
    assert.equal(stillPending[0].id, "b1");
  });

  test("non-pending suggestions are preserved unchanged", () => {
    const existing = [
      { id: "c1", action: "append_bullet", status: "approved",  patch: { bullet: "Approved" } },
      { id: "c2", action: "append_bullet", status: "rejected",  patch: { bullet: "Rejected" } },
      { id: "c3", action: "append_bullet", status: "discarded", patch: { bullet: "Already discarded" } },
      { id: "c4", action: "append_bullet", status: "pending",   patch: { bullet: "Pending" } }
    ];
    const newCandidates = [
      { id: "d1", action: "add_skills", status: "pending", patch: { skills: ["NewSkill"] } }
    ];

    const { superseded, updatedSuggestions } = simulateSupersede(existing, newCandidates);

    assert.equal(superseded, 1, "Only 1 pending item should be superseded");

    const approvedItem = updatedSuggestions.find((s) => s.id === "c1");
    assert.equal(approvedItem.status, "approved", "Approved item must not be modified");
    assert.ok(!approvedItem.discardReason, "Approved item must not gain discardReason");

    const rejectedItem = updatedSuggestions.find((s) => s.id === "c2");
    assert.equal(rejectedItem.status, "rejected", "Rejected item must not be modified");

    const alreadyDiscarded = updatedSuggestions.find((s) => s.id === "c3");
    assert.equal(alreadyDiscarded.status, "discarded", "Already-discarded item must not be modified");
    assert.ok(!alreadyDiscarded.discardReason, "Already-discarded item must not gain superseded reason");
  });

  test("new candidates are appended after superseded items", () => {
    const existing = [
      { id: "e1", action: "append_bullet", status: "pending", patch: { bullet: "Old" } }
    ];
    const newCandidates = [
      { id: "f1", action: "append_bullet", status: "pending", patch: { bullet: "New 1" } },
      { id: "f2", action: "append_bullet", status: "pending", patch: { bullet: "New 2" } }
    ];

    const { updatedSuggestions } = simulateSupersede(existing, newCandidates);

    assert.equal(updatedSuggestions.length, 3, "Result must contain 1 superseded + 2 new");
    assert.equal(updatedSuggestions[0].id, "e1", "Superseded item comes first");
    assert.equal(updatedSuggestions[0].status, "discarded");
    assert.equal(updatedSuggestions[1].id, "f1", "New item 1 follows");
    assert.equal(updatedSuggestions[2].id, "f2", "New item 2 follows");
  });

  test("empty existing list produces no superseded items", () => {
    const newCandidates = [
      { id: "g1", action: "add_skills", status: "pending", patch: { skills: ["TypeScript"] } }
    ];

    const { superseded, updatedSuggestions } = simulateSupersede([], newCandidates);

    assert.equal(superseded, 0, "No items to supersede");
    assert.equal(updatedSuggestions.length, 1);
    assert.equal(updatedSuggestions[0].id, "g1");
    assert.equal(updatedSuggestions[0].status, "pending");
  });
});
