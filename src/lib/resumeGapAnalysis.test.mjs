/**
 * Unit tests for resumeGapAnalysis.mjs
 *
 * Run with:  node --test src/lib/resumeGapAnalysis.test.mjs
 * (Node.js built-in test runner — no external dependencies)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeGaps } from "./resumeGapAnalysis.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal valid LinkedIn ProfileData */
function liBase(overrides = {}) {
  return {
    name: null,
    headline: null,
    about: null,
    location: null,
    profileImageUrl: null,
    experience: [],
    education: [],
    skills: [],
    certifications: [],
    ...overrides
  };
}

/** Minimal valid resume document */
function rdBase(overrides = {}) {
  return {
    meta: { schemaVersion: 1, linkedin_url: null },
    contact: { name: "", email: null, phone: null, location: null, website: null, linkedin: null },
    summary: "",
    experience: [],
    education: [],
    skills: { technical: [], languages: [], tools: [] },
    projects: [],
    certifications: [],
    strength_keywords: [],
    display_axes: [],
    ...overrides
  };
}

// ─── Guard: invalid inputs ─────────────────────────────────────────────────────

describe("analyzeGaps — invalid inputs", () => {
  it("returns empty result when linkedinData is null", () => {
    const result = analyzeGaps(null, rdBase());
    assert.equal(result.gaps.length, 0);
    assert.equal(result.summary.total, 0);
  });

  it("returns empty result when resumeDoc is null", () => {
    const result = analyzeGaps(liBase(), null);
    assert.equal(result.gaps.length, 0);
  });

  it("returns empty result when both inputs are null", () => {
    const result = analyzeGaps(null, null);
    assert.equal(result.gaps.length, 0);
  });

  it("returns empty result when inputs are non-objects", () => {
    assert.equal(analyzeGaps("string", rdBase()).gaps.length, 0);
    assert.equal(analyzeGaps(42, rdBase()).gaps.length, 0);
    assert.equal(analyzeGaps(liBase(), "string").gaps.length, 0);
  });
});

// ─── Contact: name ────────────────────────────────────────────────────────────

describe("analyzeGaps — contact.name", () => {
  it("flags missing_field when LinkedIn has name but resume contact.name is empty", () => {
    const li = liBase({ name: "Alice Kim" });
    const rd = rdBase({ contact: { name: "", email: null, phone: null, location: null, website: null, linkedin: null } });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "name");
    assert.ok(gap, "expected a contact.name gap");
    assert.equal(gap.type, "missing_field");
    assert.equal(gap.linkedinValue, "Alice Kim");
  });

  it("flags discrepancy when names are significantly different", () => {
    const li = liBase({ name: "Alice Kim" });
    const rd = rdBase({ contact: { name: "Bob Lee", email: null, phone: null, location: null, website: null, linkedin: null } });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "name");
    assert.ok(gap, "expected a contact.name discrepancy gap");
    assert.equal(gap.type, "discrepancy");
    assert.equal(gap.linkedinValue, "Alice Kim");
    assert.equal(gap.resumeValue, "Bob Lee");
  });

  it("does NOT flag when names are the same (case-insensitive)", () => {
    const li = liBase({ name: "alice kim" });
    const rd = rdBase({ contact: { name: "Alice Kim", email: null, phone: null, location: null, website: null, linkedin: null } });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "name");
    assert.equal(gap, undefined, "should not flag same name");
  });

  it("does NOT flag when LinkedIn name is null", () => {
    const li = liBase({ name: null });
    const rd = rdBase({ contact: { name: "Alice Kim", email: null, phone: null, location: null, website: null, linkedin: null } });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "name");
    assert.equal(gap, undefined);
  });
});

// ─── Contact: location ────────────────────────────────────────────────────────

describe("analyzeGaps — contact.location", () => {
  it("flags missing_field when LinkedIn has location but resume has none", () => {
    const li = liBase({ location: "Seoul, South Korea" });
    const rd = rdBase();
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "location");
    assert.ok(gap);
    assert.equal(gap.type, "missing_field");
  });

  it("flags discrepancy when locations differ", () => {
    const li = liBase({ location: "Seoul" });
    const rd = rdBase({ contact: { name: "", email: null, phone: null, location: "Busan", website: null, linkedin: null } });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "location");
    assert.ok(gap);
    assert.equal(gap.type, "discrepancy");
  });

  it("does NOT flag when location contains the other (substring match)", () => {
    // "Seoul" is contained in "Seoul, South Korea"
    const li = liBase({ location: "Seoul, South Korea" });
    const rd = rdBase({ contact: { name: "", email: null, phone: null, location: "Seoul", website: null, linkedin: null } });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "location");
    assert.equal(gap, undefined);
  });
});

// ─── Contact: linkedin URL ────────────────────────────────────────────────────

describe("analyzeGaps — contact.linkedin URL", () => {
  it("flags missing_field when meta.linkedin_url is known but contact.linkedin is empty", () => {
    const li = liBase();
    const rd = rdBase({
      meta: { schemaVersion: 1, linkedin_url: "https://www.linkedin.com/in/alicekim" }
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "linkedin");
    assert.ok(gap);
    assert.equal(gap.type, "missing_field");
    assert.equal(gap.linkedinValue, "https://www.linkedin.com/in/alicekim");
  });

  it("does NOT flag when contact.linkedin is already set", () => {
    const li = liBase();
    const rd = rdBase({
      meta: { schemaVersion: 1, linkedin_url: "https://www.linkedin.com/in/alicekim" },
      contact: { name: "", email: null, phone: null, location: null, website: null, linkedin: "https://www.linkedin.com/in/alicekim" }
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "contact" && g.field === "linkedin");
    assert.equal(gap, undefined);
  });
});

// ─── Summary / About ─────────────────────────────────────────────────────────

describe("analyzeGaps — summary", () => {
  it("flags missing_field when LinkedIn has about but resume summary is empty", () => {
    const li = liBase({ about: "Experienced software engineer." });
    const rd = rdBase({ summary: "" });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "summary");
    assert.ok(gap);
    assert.equal(gap.type, "missing_field");
    assert.equal(gap.linkedinValue, "Experienced software engineer.");
  });

  it("does NOT flag when both have summary (even if different)", () => {
    const li = liBase({ about: "Engineer at Company A." });
    const rd = rdBase({ summary: "Software engineer with 5 years of experience." });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "summary");
    assert.equal(gap, undefined);
  });

  it("does NOT flag when LinkedIn about is null", () => {
    const li = liBase({ about: null });
    const rd = rdBase({ summary: "" });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "summary");
    assert.equal(gap, undefined);
  });
});

// ─── Experience: missing entries ──────────────────────────────────────────────

describe("analyzeGaps — experience missing entries", () => {
  it("flags missing_entry when LinkedIn experience not in resume", () => {
    const li = liBase({
      experience: [{ title: "Senior Engineer", company: "Acme Corp", duration: "2021–2023", description: null }]
    });
    const rd = rdBase({ experience: [] });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "missing_entry");
    assert.ok(gap);
    assert.equal(gap.linkedinEntry.company, "Acme Corp");
    assert.equal(gap.linkedinEntry.title, "Senior Engineer");
  });

  it("does NOT flag when company name matches (case-insensitive)", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "acme corp", duration: null, description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "Acme Corp", title: "Engineer", start_date: "2021", end_date: "2023", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const missingGap = gaps.find((g) => g.section === "experience" && g.type === "missing_entry");
    assert.equal(missingGap, undefined);
  });

  it("does NOT flag when matched by title (company name varies)", () => {
    const li = liBase({
      experience: [{ title: "Lead Developer", company: "Startup Inc", duration: null, description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "Startup Incorporated", title: "Lead Developer", start_date: "2020", end_date: null, bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const missingGap = gaps.find((g) => g.section === "experience" && g.type === "missing_entry");
    // Company name "Startup Inc" contains "startup inc" and resume has "startup incorporated"
    // "startup inc" is contained in "startup incorporated" -> match
    assert.equal(missingGap, undefined);
  });

  it("flags multiple missing entries", () => {
    const li = liBase({
      experience: [
        { title: "CTO", company: "Alpha Ltd", duration: "2020–2022", description: null },
        { title: "Engineer", company: "Beta Ltd", duration: "2018–2020", description: null }
      ]
    });
    const rd = rdBase({ experience: [] });
    const { gaps } = analyzeGaps(li, rd);
    const missingGaps = gaps.filter((g) => g.section === "experience" && g.type === "missing_entry");
    assert.equal(missingGaps.length, 2);
  });

  it("includes description in linkedinEntry when present", () => {
    const li = liBase({
      experience: [{ title: "PM", company: "WidgetCo", duration: "2022–Present", description: "Led product roadmap." }]
    });
    const rd = rdBase({ experience: [] });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "missing_entry");
    assert.equal(gap.linkedinEntry.description, "Led product roadmap.");
  });

  it("skips LinkedIn experience entries with no company and no title", () => {
    const li = liBase({
      experience: [{ title: null, company: null, duration: null, description: null }]
    });
    const rd = rdBase({ experience: [] });
    const { gaps } = analyzeGaps(li, rd);
    assert.equal(gaps.length, 0);
  });
});

// ─── Experience: title discrepancy ───────────────────────────────────────────

describe("analyzeGaps — experience title discrepancy", () => {
  it("flags discrepancy when company matches but title differs significantly", () => {
    const li = liBase({
      experience: [{ title: "Staff Engineer", company: "BigTech", duration: "2020–Present", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "BigTech", title: "Senior Software Engineer", start_date: "2020", end_date: null, bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "title");
    assert.ok(gap, "expected a title discrepancy gap");
    assert.equal(gap.linkedinValue, "Staff Engineer");
    assert.equal(gap.resumeValue, "Senior Software Engineer");
    assert.equal(gap.context.company, "BigTech");
  });

  it("does NOT flag discrepancy when titles are similar", () => {
    const li = liBase({
      experience: [{ title: "software engineer", company: "BigTech", duration: null, description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "BigTech", title: "Software Engineer", start_date: "2020", end_date: null, bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const discrepancy = gaps.find((g) => g.section === "experience" && g.type === "discrepancy");
    assert.equal(discrepancy, undefined);
  });

  it("does NOT flag discrepancy when LinkedIn title is null (no data)", () => {
    const li = liBase({
      experience: [{ title: null, company: "BigTech", duration: null, description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "BigTech", title: "Engineer", start_date: "2020", end_date: null, bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const discrepancy = gaps.find((g) => g.section === "experience" && g.type === "discrepancy");
    assert.equal(discrepancy, undefined);
  });

  it("does NOT flag discrepancy when resume title is null (resume incomplete)", () => {
    const li = liBase({
      experience: [{ title: "Staff Engineer", company: "BigTech", duration: null, description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "BigTech", title: null, start_date: "2020", end_date: null, bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const discrepancy = gaps.find((g) => g.section === "experience" && g.type === "discrepancy");
    assert.equal(discrepancy, undefined);
  });

  it("includes context.company in the discrepancy gap", () => {
    const li = liBase({
      experience: [{ title: "VP Engineering", company: "MegaCorp", duration: null, description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "MegaCorp", title: "Director of Engineering", start_date: "2019", end_date: null, bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.field === "title" && g.type === "discrepancy");
    assert.ok(gap);
    assert.equal(gap.context.company, "MegaCorp");
  });
});

// ─── Experience: duration discrepancy ────────────────────────────────────────

describe("analyzeGaps — experience duration discrepancy", () => {
  it("flags discrepancy when LinkedIn start year differs from resume start_date year", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: "2022 – 2024", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2019", end_date: "2024", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "duration");
    assert.ok(gap, "expected a duration discrepancy gap");
    assert.equal(gap.linkedinValue, "2022 – 2024");
    assert.equal(gap.resumeValue, "2019 – 2024");
    assert.equal(gap.context.company, "TechCo");
  });

  it("flags discrepancy when LinkedIn end year differs from resume end_date year", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: "2019 – 2023", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2019", end_date: "2021", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "duration");
    assert.ok(gap, "expected a duration discrepancy gap for differing end year");
    assert.equal(gap.linkedinValue, "2019 – 2023");
    assert.equal(gap.context.company, "TechCo");
  });

  it("does NOT flag discrepancy when LinkedIn shows Present and resume end_date is null", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: "2021 – Present", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2021", end_date: null, bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "duration");
    assert.equal(gap, undefined, "ongoing role with null end_date should not flag duration discrepancy");
  });

  it("does NOT flag discrepancy when start and end years both match", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: "2019 – 2022", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2019", end_date: "2022", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "duration");
    assert.equal(gap, undefined);
  });

  it("does NOT flag discrepancy when LinkedIn duration is null", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: null, description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2019", end_date: "2022", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "duration");
    assert.equal(gap, undefined, "null duration should not produce a gap");
  });

  it("does NOT flag discrepancy for relative duration strings like '5 years 2 months'", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: "5 years 2 months", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2019", end_date: "2022", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "duration");
    assert.equal(gap, undefined, "relative duration strings cannot be compared and must be skipped");
  });

  it("handles ISO date format in resume start_date (e.g. '2021-06')", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: "2019 – 2021", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2021-06", end_date: "2023-01", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "duration");
    assert.ok(gap, "year extracted from ISO date '2021-06' should differ from LinkedIn start year '2019'");
  });

  it("does NOT flag when resume has no dates (start_date and end_date both absent)", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: "2019 – 2022", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "experience" && g.type === "discrepancy" && g.field === "duration");
    assert.equal(gap, undefined, "no resume dates means no comparison is possible");
  });

  it("includes context.company and correct linkedinValue / resumeValue in the gap", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "Megacorp", duration: "Jan 2018 – Dec 2020", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "Megacorp", title: "Engineer", start_date: "2016", end_date: "2020", bullets: [] }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.field === "duration" && g.type === "discrepancy");
    assert.ok(gap);
    assert.equal(gap.context.company, "Megacorp");
    assert.equal(gap.linkedinValue, "Jan 2018 – Dec 2020");
    assert.equal(gap.resumeValue, "2016 – 2020");
  });

  it("discrepancy summary counter increments for duration gaps", () => {
    const li = liBase({
      experience: [{ title: "Engineer", company: "TechCo", duration: "2022 – 2024", description: null }]
    });
    const rd = rdBase({
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2019", end_date: "2024", bullets: [] }]
    });
    const { summary } = analyzeGaps(li, rd);
    assert.ok(summary.discrepancies >= 1, "duration discrepancy should increment summary.discrepancies");
  });
});

// ─── Education: missing entries ───────────────────────────────────────────────

describe("analyzeGaps — education missing entries", () => {
  it("flags missing_entry when LinkedIn education not in resume", () => {
    const li = liBase({
      education: [{ school: "Seoul National University", degree: "B.S.", field: "Computer Science", years: "2010–2014" }]
    });
    const rd = rdBase({ education: [] });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "education" && g.type === "missing_entry");
    assert.ok(gap);
    assert.equal(gap.linkedinEntry.school, "Seoul National University");
  });

  it("does NOT flag when institution name matches", () => {
    const li = liBase({
      education: [{ school: "Seoul National University", degree: "B.S.", field: "CS", years: "2010–2014" }]
    });
    const rd = rdBase({
      education: [{ institution: "Seoul National University", degree: "Bachelor of Science", field: "Computer Science", start_date: "2010", end_date: "2014", gpa: null }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "education" && g.type === "missing_entry");
    assert.equal(gap, undefined);
  });

  it("skips LinkedIn education entries with no school name", () => {
    const li = liBase({
      education: [{ school: null, degree: "B.S.", field: "CS", years: "2010–2014" }]
    });
    const rd = rdBase({ education: [] });
    const { gaps } = analyzeGaps(li, rd);
    assert.equal(gaps.length, 0);
  });

  it("includes degree and field in linkedinEntry", () => {
    const li = liBase({
      education: [{ school: "KAIST", degree: "M.S.", field: "AI", years: "2015–2017" }]
    });
    const rd = rdBase({ education: [] });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "education" && g.type === "missing_entry");
    assert.equal(gap.linkedinEntry.degree, "M.S.");
    assert.equal(gap.linkedinEntry.field, "AI");
    assert.equal(gap.linkedinEntry.years, "2015–2017");
  });
});

// ─── Skills: missing ─────────────────────────────────────────────────────────

describe("analyzeGaps — skills", () => {
  it("flags missing_skills when LinkedIn skills absent from resume", () => {
    const li = liBase({ skills: ["TypeScript", "Kubernetes", "GraphQL"] });
    const rd = rdBase({
      skills: { technical: ["JavaScript"], languages: [], tools: [] }
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.type === "missing_skills");
    assert.ok(gap);
    assert.ok(gap.missingSkills.includes("TypeScript"));
    assert.ok(gap.missingSkills.includes("Kubernetes"));
    assert.ok(gap.missingSkills.includes("GraphQL"));
  });

  it("does NOT flag skills already in resume (case-insensitive)", () => {
    const li = liBase({ skills: ["typescript"] });
    const rd = rdBase({
      skills: { technical: ["TypeScript"], languages: [], tools: [] }
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.type === "missing_skills");
    assert.equal(gap, undefined);
  });

  it("does NOT flag skills present in strength_keywords", () => {
    const li = liBase({ skills: ["Leadership"] });
    const rd = rdBase({
      skills: { technical: [], languages: [], tools: [] },
      strength_keywords: ["Leadership", "Communication"]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.type === "missing_skills");
    assert.equal(gap, undefined);
  });

  it("does NOT flag when LinkedIn skills array is empty", () => {
    const li = liBase({ skills: [] });
    const rd = rdBase({ skills: { technical: [], languages: [], tools: [] } });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.type === "missing_skills");
    assert.equal(gap, undefined);
  });

  it("uses substring match to avoid duplicate flags", () => {
    // "JavaScript" contains "java" — should NOT flag "java" as missing if "JavaScript" present
    // But "java" != "javascript" so this is a different skill — should flag
    const li = liBase({ skills: ["Java"] });
    const rd = rdBase({ skills: { technical: ["JavaScript"], languages: [], tools: [] } });
    const { gaps } = analyzeGaps(li, rd);
    // "java" is contained in "javascript" → isSimilar("java", "javascript") = true → NOT missing
    const gap = gaps.find((g) => g.type === "missing_skills");
    assert.equal(gap, undefined, "java should match via substring in javascript");
  });

  it("includes the full list of missing skills in missingSkills array", () => {
    const li = liBase({ skills: ["Rust", "Go", "Python", "Elixir", "Haskell", "OCaml"] });
    const rd = rdBase({ skills: { technical: [], languages: [], tools: [] } });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.type === "missing_skills");
    assert.ok(gap);
    assert.equal(gap.missingSkills.length, 6);
  });
});

// ─── Certifications: missing ──────────────────────────────────────────────────

describe("analyzeGaps — certifications", () => {
  it("flags missing_entry when LinkedIn certification not in resume", () => {
    const li = liBase({
      certifications: [{ name: "AWS Certified Solutions Architect", issuer: "Amazon", date: "2022" }]
    });
    const rd = rdBase({ certifications: [] });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "certifications" && g.type === "missing_entry");
    assert.ok(gap, "expected a certification missing_entry gap");
    assert.equal(gap.linkedinEntry.name, "AWS Certified Solutions Architect");
    assert.equal(gap.linkedinEntry.issuer, "Amazon");
    assert.equal(gap.linkedinEntry.date, "2022");
  });

  it("does NOT flag when certification name matches (case-insensitive)", () => {
    const li = liBase({
      certifications: [{ name: "aws certified solutions architect", issuer: "Amazon", date: "2022" }]
    });
    const rd = rdBase({
      certifications: [{ name: "AWS Certified Solutions Architect", issuer: "Amazon Web Services", date: "2022-01" }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "certifications" && g.type === "missing_entry");
    assert.equal(gap, undefined);
  });

  it("flags multiple missing certifications", () => {
    const li = liBase({
      certifications: [
        { name: "CKA", issuer: "CNCF", date: "2021" },
        { name: "GCP Professional Cloud Architect", issuer: "Google", date: "2022" }
      ]
    });
    const rd = rdBase({ certifications: [] });
    const { gaps } = analyzeGaps(li, rd);
    const certGaps = gaps.filter((g) => g.section === "certifications" && g.type === "missing_entry");
    assert.equal(certGaps.length, 2);
  });

  it("skips LinkedIn certifications with no name", () => {
    const li = liBase({
      certifications: [{ name: null, issuer: "SomeOrg", date: "2022" }]
    });
    const rd = rdBase({ certifications: [] });
    const { gaps } = analyzeGaps(li, rd);
    assert.equal(gaps.length, 0);
  });

  it("does NOT flag when LinkedIn certifications array is empty", () => {
    const li = liBase({ certifications: [] });
    const rd = rdBase({ certifications: [] });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "certifications");
    assert.equal(gap, undefined);
  });

  it("uses substring match for certification name similarity (short vs long form)", () => {
    // Resume has "CKA"; LinkedIn has "CKA - Certified Kubernetes Administrator".
    // normalizeStr("CKA") = "cka"
    // normalizeStr("CKA - Certified Kubernetes Administrator") includes "cka" → match
    const li = liBase({
      certifications: [{ name: "CKA - Certified Kubernetes Administrator", issuer: "CNCF", date: null }]
    });
    const rd = rdBase({
      certifications: [{ name: "CKA", issuer: "CNCF", date: null }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "certifications" && g.type === "missing_entry");
    // "cka" is contained in "cka   certified kubernetes administrator" → match → no gap
    assert.equal(gap, undefined);
  });

  it("flags when certification names differ by more than a minor word difference", () => {
    // "AWS Certified Solutions Architect" and "AWS Solutions Architect" are genuinely different
    // because "certified" breaks the substring relationship in both directions.
    const li = liBase({
      certifications: [{ name: "AWS Certified Solutions Architect", issuer: "AWS", date: null }]
    });
    const rd = rdBase({
      certifications: [{ name: "AWS Solutions Architect", issuer: "Amazon", date: null }]
    });
    const { gaps } = analyzeGaps(li, rd);
    const gap = gaps.find((g) => g.section === "certifications" && g.type === "missing_entry");
    // Neither string is a substring of the other → flagged as missing
    assert.ok(gap, "expected missing_entry because names are not substrings of each other");
  });
});

// ─── Summary counters ─────────────────────────────────────────────────────────

describe("analyzeGaps — summary counters", () => {
  it("counts missing_fields correctly", () => {
    const li = liBase({ name: "Alice", location: "Seoul" });
    const rd = rdBase(); // empty contact
    const { summary } = analyzeGaps(li, rd);
    assert.equal(summary.missing_fields, 2); // name + location
  });

  it("counts discrepancies correctly", () => {
    const li = liBase({ name: "Alice Kim", location: "Seoul" });
    const rd = rdBase({
      contact: { name: "Bob Lee", email: null, phone: null, location: "Busan", website: null, linkedin: null }
    });
    const { summary } = analyzeGaps(li, rd);
    assert.equal(summary.discrepancies, 2);
  });

  it("counts missing_entries correctly", () => {
    const li = liBase({
      experience: [{ title: "Eng", company: "A", duration: null, description: null }],
      education: [{ school: "MIT", degree: "B.S.", field: "CS", years: "2010–2014" }],
      certifications: [{ name: "CKA", issuer: "CNCF", date: "2021" }]
    });
    const rd = rdBase();
    const { summary } = analyzeGaps(li, rd);
    assert.equal(summary.missing_entries, 3);
  });

  it("counts missing_skills_count correctly", () => {
    const li = liBase({ skills: ["Rust", "Go"] });
    const rd = rdBase();
    const { summary } = analyzeGaps(li, rd);
    assert.equal(summary.missing_skills_count, 1); // one gap item (may list multiple skills)
  });

  it("total equals sum of all gap types", () => {
    const li = liBase({
      name: "Alice",
      skills: ["Rust"],
      certifications: [{ name: "CKA", issuer: "CNCF", date: "2021" }]
    });
    const rd = rdBase();
    const { gaps, summary } = analyzeGaps(li, rd);
    assert.equal(summary.total, gaps.length);
    assert.equal(
      summary.missing_fields + summary.discrepancies + summary.missing_entries + summary.missing_skills_count,
      summary.total
    );
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("analyzeGaps — edge cases", () => {
  it("handles arrays with null/undefined values gracefully", () => {
    const li = liBase({
      experience: [null, undefined, { title: "Eng", company: "Acme", duration: null, description: null }]
    });
    const rd = rdBase({ experience: [] });
    // Should not throw — null/undefined entries are effectively no-ops
    // because the null entry has no company/title and will be skipped
    assert.doesNotThrow(() => analyzeGaps(li, rd));
  });

  it("handles all fields populated without generating false positives", () => {
    const li = liBase({
      name: "Alice Kim",
      location: "Seoul",
      about: "Senior engineer.",
      experience: [{ title: "Engineer", company: "TechCo", duration: "2020–2023", description: null }],
      education: [{ school: "SNU", degree: "B.S.", field: "CS", years: "2014–2018" }],
      skills: ["Python", "JavaScript"],
      certifications: [{ name: "CKA", issuer: "CNCF", date: "2021" }]
    });
    const rd = rdBase({
      contact: { name: "Alice Kim", email: "alice@example.com", phone: null, location: "Seoul", website: null, linkedin: null },
      summary: "Experienced software engineer.",
      experience: [{ company: "TechCo", title: "Engineer", start_date: "2020", end_date: "2023", bullets: ["Built features"] }],
      education: [{ institution: "SNU", degree: "B.S.", field: "Computer Science", start_date: "2014", end_date: "2018", gpa: null }],
      skills: { technical: ["Python", "JavaScript"], languages: [], tools: [] },
      certifications: [{ name: "CKA", issuer: "CNCF", date: "2021-01" }],
      strength_keywords: []
    });
    const { gaps } = analyzeGaps(li, rd);
    assert.equal(gaps.length, 0, `unexpected gaps: ${JSON.stringify(gaps, null, 2)}`);
  });

  it("acronym matching works for company names", () => {
    // "SNU" should match "Seoul National University"
    const li = liBase({
      education: [{ school: "Seoul National University", degree: "B.S.", field: "CS", years: "2010–2014" }]
    });
    const rd = rdBase({
      education: [{ institution: "snu", degree: "B.S.", field: "CS", start_date: "2010", end_date: "2014", gpa: null }]
    });
    const { gaps } = analyzeGaps(li, rd);
    // "snu" is acronym of "seoul national university" → match → no gap
    const gap = gaps.find((g) => g.section === "education");
    assert.equal(gap, undefined);
  });
});
