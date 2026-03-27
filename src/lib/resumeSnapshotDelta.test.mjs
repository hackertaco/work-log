/**
 * Tests for resumeSnapshotDelta.mjs
 *
 * Covers:
 *   • computeProfileDelta — guard clauses (null inputs)
 *   • computeProfileDelta — identical profiles → rate 0 / isEmpty true
 *   • computeProfileDelta — contact field changes
 *   • computeProfileDelta — summary change
 *   • computeProfileDelta — experience: added / deleted / modified (scalar + bullet)
 *   • computeProfileDelta — education added/deleted/modified
 *   • computeProfileDelta — skills string-set changes
 *   • computeProfileDelta — projects: added / deleted / bullet-level changes
 *   • computeProfileDelta — certifications added/deleted
 *   • computeProfileDelta — strength_keywords added/deleted
 *   • computeProfileDelta — display_axes added/deleted/modified
 *   • computeProfileDelta — breakdown structure correctness
 *   • computeProfileDelta — rate clamp (never exceeds 1.0)
 *   • computeProfileDelta — one-sided null (prev or curr null → _fullDelta)
 *
 * getLastApprovedSnapshot / deltaFromLastApproved are async and depend on Blob
 * I/O — those are integration-tested separately; only the pure computeProfileDelta
 * is unit-tested here.
 *
 * Uses Node.js built-in test runner (node:test) — no external dependencies.
 * Run:
 *   node --test src/lib/resumeSnapshotDelta.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeProfileDelta } from "./resumeSnapshotDelta.mjs";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Minimal valid resume profile for use as a baseline in tests.
 * Mirrors the schema used throughout the project.
 */
function makeProfile(overrides = {}) {
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

// ─── Guard clauses ─────────────────────────────────────────────────────────────

describe("computeProfileDelta — guard clauses", () => {
  test("both null → rate 0, isEmpty true", () => {
    const d = computeProfileDelta(null, null);
    assert.equal(d.rate, 0);
    assert.equal(d.isEmpty, true);
    assert.equal(d.changedUnits, 0);
    assert.equal(d.totalUnits, 0);
  });

  test("both undefined → rate 0, isEmpty true", () => {
    const d = computeProfileDelta(undefined, undefined);
    assert.equal(d.rate, 0);
    assert.equal(d.isEmpty, true);
  });

  test("primitive prev → treated as null (full delta from curr)", () => {
    const d = computeProfileDelta("not-an-object", makeProfile());
    // Everything in curr is "new" → rate 1
    assert.equal(d.rate, 1);
    assert.equal(d.changedUnits, d.totalUnits);
  });

  test("primitive curr → treated as null (full delta from prev)", () => {
    const d = computeProfileDelta(makeProfile(), 42);
    assert.equal(d.rate, 1);
  });

  test("prev null, curr provided → full delta (all curr units changed)", () => {
    const profile = makeProfile();
    const d = computeProfileDelta(null, profile);
    assert.equal(d.rate, 1);
    assert.ok(d.totalUnits > 0);
    assert.equal(d.changedUnits, d.totalUnits);
    assert.equal(d.isEmpty, false);
  });

  test("prev provided, curr null → full delta (all prev units changed)", () => {
    const profile = makeProfile();
    const d = computeProfileDelta(profile, null);
    assert.equal(d.rate, 1);
  });
});

// ─── Identical profiles ───────────────────────────────────────────────────────

describe("computeProfileDelta — identical profiles", () => {
  test("same object reference → rate 0, isEmpty true", () => {
    const profile = makeProfile();
    const d = computeProfileDelta(profile, profile);
    assert.equal(d.rate, 0);
    assert.equal(d.isEmpty, true);
    assert.equal(d.changedUnits, 0);
  });

  test("deep-equal objects → rate 0, isEmpty true", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.equal(d.rate, 0);
    assert.equal(d.isEmpty, true);
  });

  test("empty profile (all arrays empty) → rate 0", () => {
    const empty = {
      contact: {},
      summary: "",
      experience: [],
      education: [],
      skills: { technical: [], languages: [], tools: [] },
      projects: [],
      certifications: [],
      strength_keywords: [],
      display_axes: []
    };
    const d = computeProfileDelta(empty, empty);
    assert.equal(d.rate, 0);
    assert.equal(d.totalUnits, 0);
  });
});

// ─── Contact field changes ────────────────────────────────────────────────────

describe("computeProfileDelta — contact changes", () => {
  test("one contact field modified → changedUnits includes that field", () => {
    const prev = makeProfile();
    const curr = makeProfile({ contact: { ...prev.contact, email: "newemail@example.com" } });
    const d = computeProfileDelta(prev, curr);
    assert.ok(d.changedUnits > 0);
    assert.equal(d.breakdown.contact.changed, 1);
    assert.equal(d.isEmpty, false);
  });

  test("contact field added (was null, now has value)", () => {
    const prev = makeProfile({ contact: { name: "Alice", email: null, phone: null, location: null, website: null, linkedin: null } });
    const curr = makeProfile({ contact: { name: "Alice", email: "alice@example.com", phone: null, location: null, website: null, linkedin: null } });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.contact.changed, 1);
  });

  test("contact field deleted (had value, now null)", () => {
    const prev = makeProfile({ contact: { name: "Alice", email: "alice@example.com", phone: null, location: null, website: null, linkedin: null } });
    const curr = makeProfile({ contact: { name: "Alice", email: null, phone: null, location: null, website: null, linkedin: null } });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.contact.changed, 1);
  });

  test("no contact changes → breakdown.contact.changed === 0", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.equal(d.breakdown.contact.changed, 0);
  });
});

// ─── Summary change ───────────────────────────────────────────────────────────

describe("computeProfileDelta — summary change", () => {
  test("summary text changed → summary.changed === 1", () => {
    const prev = makeProfile({ summary: "Old summary." });
    const curr = makeProfile({ summary: "New summary with more content." });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.summary.changed, 1);
  });

  test("summary unchanged → summary.changed === 0", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.equal(d.breakdown.summary.changed, 0);
  });

  test("summary added (was empty, now present)", () => {
    const prev = makeProfile({ summary: "" });
    const curr = makeProfile({ summary: "New summary." });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.summary.changed, 1);
  });
});

// ─── Experience changes ───────────────────────────────────────────────────────

describe("computeProfileDelta — experience changes", () => {
  test("one experience entry added → changedUnits increases by 1 (entry) + n bullets", () => {
    const prev = makeProfile({ experience: [] });
    const newExp = {
      company: "Beta Inc",
      title: "Engineer",
      start_date: "2023-01",
      end_date: "present",
      location: "Busan",
      bullets: ["Built X.", "Improved Y."]
    };
    const curr = makeProfile({ experience: [newExp] });
    const d = computeProfileDelta(prev, curr);
    // 1 entry + 2 bullets = 3 changed units for experience
    assert.equal(d.breakdown.experience.changed, 3);
  });

  test("one experience entry deleted → changedUnits counts entry + bullets", () => {
    const baseExp = {
      company: "Acme Corp",
      title: "Senior Engineer",
      start_date: "2022-01",
      end_date: "present",
      location: "Seoul",
      bullets: ["Led migration to microservices.", "Reduced deploy time by 40%."]
    };
    const prev = makeProfile({ experience: [baseExp] });
    const curr = makeProfile({ experience: [] });
    const d = computeProfileDelta(prev, curr);
    // 1 entry + 2 bullets = 3 changed units
    assert.equal(d.breakdown.experience.changed, 3);
  });

  test("bullet added to existing experience entry → changedUnits reflects bullet addition", () => {
    const base = makeProfile();
    const curr = makeProfile({
      experience: [
        {
          ...base.experience[0],
          bullets: [...base.experience[0].bullets, "New achievement unlocked."]
        }
      ]
    });
    const d = computeProfileDelta(base, curr);
    assert.equal(d.breakdown.experience.changed, 1); // 1 bullet added
  });

  test("bullet deleted from existing experience entry", () => {
    const base = makeProfile();
    const curr = makeProfile({
      experience: [
        {
          ...base.experience[0],
          bullets: [base.experience[0].bullets[0]] // keep only first bullet
        }
      ]
    });
    const d = computeProfileDelta(base, curr);
    assert.equal(d.breakdown.experience.changed, 1); // 1 bullet deleted
  });

  test("experience scalar field modified (title) → changedUnits reflects that", () => {
    const base = makeProfile();
    const curr = makeProfile({
      experience: [
        {
          ...base.experience[0],
          title: "Principal Engineer"
        }
      ]
    });
    const d = computeProfileDelta(base, curr);
    assert.ok(d.breakdown.experience.changed >= 1);
  });

  test("no experience changes → experience.changed === 0", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.equal(d.breakdown.experience.changed, 0);
  });
});

// ─── Education changes ────────────────────────────────────────────────────────

describe("computeProfileDelta — education changes", () => {
  test("new education entry added → education.changed === 1", () => {
    const prev = makeProfile({ education: [] });
    const curr = makeProfile({
      education: [
        { institution: "MIT", degree: "M.S.", field: "CS", start_date: "2019", end_date: "2021", gpa: null }
      ]
    });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.education.changed, 1);
  });

  test("education entry deleted → education.changed === 1", () => {
    const prev = makeProfile();
    const curr = makeProfile({ education: [] });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.education.changed, 1);
  });

  test("education entry modified (degree changed) → education.changed === 1", () => {
    const base = makeProfile();
    const curr = makeProfile({
      education: [{ ...base.education[0], degree: "M.S." }]
    });
    const d = computeProfileDelta(base, curr);
    assert.equal(d.breakdown.education.changed, 1);
  });
});

// ─── Skills changes ───────────────────────────────────────────────────────────

describe("computeProfileDelta — skills changes", () => {
  test("one technical skill added → skillsTechnical.changed === 1", () => {
    const prev = makeProfile();
    const curr = makeProfile({ skills: { ...prev.skills, technical: [...prev.skills.technical, "Python"] } });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.skillsTechnical.changed, 1);
  });

  test("one language removed → skillsLanguages.changed === 1", () => {
    const prev = makeProfile();
    const curr = makeProfile({ skills: { ...prev.skills, languages: ["JavaScript"] } }); // removed TypeScript
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.skillsLanguages.changed, 1);
  });

  test("tool added → skillsTools.changed reflects it", () => {
    const prev = makeProfile();
    const curr = makeProfile({ skills: { ...prev.skills, tools: [...prev.skills.tools, "Kubernetes"] } });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.skillsTools.changed, 1);
  });

  test("no skills changes → all skills breakdown.changed === 0", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.equal(d.breakdown.skillsTechnical.changed, 0);
    assert.equal(d.breakdown.skillsLanguages.changed, 0);
    assert.equal(d.breakdown.skillsTools.changed, 0);
  });
});

// ─── Projects changes ─────────────────────────────────────────────────────────

describe("computeProfileDelta — projects changes", () => {
  test("new project added (with bullet) → projects.changed = 1 + bullet count", () => {
    const prev = makeProfile({ projects: [] });
    const curr = makeProfile({
      projects: [
        { name: "New Project", description: "Desc", url: null, bullets: ["Did X.", "Did Y."] }
      ]
    });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.projects.changed, 3); // 1 entry + 2 bullets
  });

  test("project deleted → projects.changed includes entry and its bullets", () => {
    const prev = makeProfile();
    const curr = makeProfile({ projects: [] });
    const d = computeProfileDelta(prev, curr);
    // OpenSource CLI has 1 bullet → 2 changed units (1 entry + 1 bullet)
    assert.equal(d.breakdown.projects.changed, 2);
  });

  test("project bullet added → projects.changed === 1", () => {
    const base = makeProfile();
    const curr = makeProfile({
      projects: [
        { ...base.projects[0], bullets: [...base.projects[0].bullets, "Second achievement."] }
      ]
    });
    const d = computeProfileDelta(base, curr);
    assert.equal(d.breakdown.projects.changed, 1);
  });
});

// ─── Certifications changes ───────────────────────────────────────────────────

describe("computeProfileDelta — certifications changes", () => {
  test("certification added → certifications.changed === 1", () => {
    const prev = makeProfile({ certifications: [] });
    const curr = makeProfile({
      certifications: [{ name: "GCP Professional", issuer: "Google", date: "2024-01" }]
    });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.certifications.changed, 1);
  });

  test("certification deleted → certifications.changed === 1", () => {
    const prev = makeProfile();
    const curr = makeProfile({ certifications: [] });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.certifications.changed, 1);
  });
});

// ─── Strength keywords changes ────────────────────────────────────────────────

describe("computeProfileDelta — strength_keywords changes", () => {
  test("keyword added → strengthKeywords.changed === 1", () => {
    const prev = makeProfile({ strength_keywords: ["cloud"] });
    const curr = makeProfile({ strength_keywords: ["cloud", "kubernetes"] });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.strengthKeywords.changed, 1);
  });

  test("keyword deleted → strengthKeywords.changed === 1", () => {
    const prev = makeProfile({ strength_keywords: ["cloud", "devops"] });
    const curr = makeProfile({ strength_keywords: ["cloud"] });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.strengthKeywords.changed, 1);
  });

  test("multiple keywords added and deleted simultaneously", () => {
    const prev = makeProfile({ strength_keywords: ["cloud", "devops", "microservices"] });
    const curr = makeProfile({ strength_keywords: ["cloud", "kubernetes", "platform-engineering"] });
    const d = computeProfileDelta(prev, curr);
    // devops+microservices deleted (2) + kubernetes+platform-engineering added (2) = 4
    assert.equal(d.breakdown.strengthKeywords.changed, 4);
  });
});

// ─── Display axes changes ─────────────────────────────────────────────────────

describe("computeProfileDelta — display_axes changes", () => {
  test("axis added → displayAxes.changed === 1", () => {
    const prev = makeProfile({ display_axes: [] });
    const curr = makeProfile({
      display_axes: [{ label: "Backend Specialist", tagline: "APIs at scale.", highlight_skills: ["Node.js"] }]
    });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.displayAxes.changed, 1);
  });

  test("axis deleted → displayAxes.changed === 1", () => {
    const prev = makeProfile();
    const curr = makeProfile({ display_axes: [] });
    const d = computeProfileDelta(prev, curr);
    assert.equal(d.breakdown.displayAxes.changed, 1);
  });

  test("axis modified (tagline) → displayAxes.changed === 1", () => {
    const base = makeProfile();
    const curr = makeProfile({
      display_axes: [{ ...base.display_axes[0], tagline: "Updated tagline." }]
    });
    const d = computeProfileDelta(base, curr);
    assert.equal(d.breakdown.displayAxes.changed, 1);
  });
});

// ─── DeltaReport structure ────────────────────────────────────────────────────

describe("computeProfileDelta — DeltaReport structure", () => {
  test("returned object has required top-level keys", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.ok("rate" in d, "must have rate");
    assert.ok("changedUnits" in d, "must have changedUnits");
    assert.ok("totalUnits" in d, "must have totalUnits");
    assert.ok("isEmpty" in d, "must have isEmpty");
    assert.ok("breakdown" in d, "must have breakdown");
  });

  test("breakdown has all required section keys", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    const expectedKeys = [
      "contact", "summary", "experience", "education",
      "skillsTechnical", "skillsLanguages", "skillsTools",
      "projects", "certifications", "strengthKeywords", "displayAxes"
    ];
    for (const k of expectedKeys) {
      assert.ok(k in d.breakdown, `breakdown must have key: ${k}`);
      assert.ok("changed" in d.breakdown[k], `breakdown.${k} must have 'changed'`);
    }
  });

  test("breakdown does not expose internal _totalChanged key", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.ok(!("_totalChanged" in d.breakdown), "_totalChanged must not appear in public breakdown");
  });

  test("rate is a number in [0, 1]", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile({ summary: "Different summary." }));
    assert.ok(typeof d.rate === "number");
    assert.ok(d.rate >= 0 && d.rate <= 1);
  });

  test("changedUnits and totalUnits are non-negative integers", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.ok(Number.isInteger(d.changedUnits) && d.changedUnits >= 0);
    assert.ok(Number.isInteger(d.totalUnits) && d.totalUnits >= 0);
  });

  test("isEmpty === true iff changedUnits === 0", () => {
    const d1 = computeProfileDelta(makeProfile(), makeProfile());
    assert.equal(d1.isEmpty, d1.changedUnits === 0);

    const d2 = computeProfileDelta(makeProfile(), makeProfile({ summary: "Changed!" }));
    assert.equal(d2.isEmpty, d2.changedUnits === 0);
  });
});

// ─── Rate calculation properties ─────────────────────────────────────────────

describe("computeProfileDelta — rate properties", () => {
  test("rate is 0 when profiles are identical", () => {
    const d = computeProfileDelta(makeProfile(), makeProfile());
    assert.equal(d.rate, 0);
  });

  test("rate is 1 when one profile is null", () => {
    const d = computeProfileDelta(null, makeProfile());
    assert.equal(d.rate, 1);
  });

  test("rate increases as more units change", () => {
    const base = makeProfile();

    // 1 change: summary only
    const d1 = computeProfileDelta(base, makeProfile({ summary: "Modified." }));

    // 2+ changes: summary + one skill added
    const curr2 = makeProfile({
      summary: "Modified.",
      skills: { ...base.skills, technical: [...base.skills.technical, "Python"] }
    });
    const d2 = computeProfileDelta(base, curr2);

    assert.ok(d2.rate >= d1.rate, "more changes should yield equal or higher rate");
  });

  test("rate never exceeds 1.0 even when changedUnits > totalUnits", () => {
    // Edge case: many changes to a very small profile
    const tiny = {
      contact: { name: "X", email: null, phone: null, location: null, website: null, linkedin: null },
      summary: "S",
      experience: [],
      education: [],
      skills: { technical: [], languages: [], tools: [] },
      projects: [],
      certifications: [],
      strength_keywords: [],
      display_axes: []
    };
    const changed = {
      ...tiny,
      contact: { name: "Y", email: "a@b.com", phone: "010-0000-0000", location: "Seoul", website: "https://x.com", linkedin: "linkedin.com/in/x" },
      summary: "Completely different summary now.",
      strength_keywords: ["new1", "new2", "new3", "new4", "new5"]
    };
    const d = computeProfileDelta(tiny, changed);
    assert.ok(d.rate <= 1.0, `rate must be ≤ 1.0, got ${d.rate}`);
  });

  test("totalUnits matches the larger profile when one is smaller", () => {
    const small = {
      contact: { name: "X", email: null, phone: null, location: null, website: null, linkedin: null },
      summary: "",
      experience: [],
      education: [],
      skills: { technical: [], languages: [], tools: [] },
      projects: [],
      certifications: [],
      strength_keywords: [],
      display_axes: []
    };
    const large = makeProfile(); // has many units
    const d = computeProfileDelta(small, large);
    // totalUnits should be the count from the larger profile
    assert.ok(d.totalUnits > 1, "totalUnits should reflect the larger profile");
  });
});

// ─── Multi-section simultaneous changes ───────────────────────────────────────

describe("computeProfileDelta — multi-section changes", () => {
  test("changes in multiple sections are summed correctly", () => {
    const base = makeProfile();
    const curr = makeProfile({
      summary: "Updated summary.",           // +1 summary change
      strength_keywords: ["cloud", "k8s"],   // devops+microservices deleted (2), k8s added (1) = 3
      education: []                          // education item deleted = 1
    });

    const d = computeProfileDelta(base, curr);

    assert.equal(d.breakdown.summary.changed, 1);
    assert.equal(d.breakdown.strengthKeywords.changed, 3);
    assert.equal(d.breakdown.education.changed, 1);

    const expectedTotal = 1 + 3 + 1; // 5 changed units from these sections
    assert.ok(d.changedUnits >= expectedTotal, `changedUnits (${d.changedUnits}) should be ≥ ${expectedTotal}`);
  });
});
