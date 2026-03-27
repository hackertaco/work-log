/**
 * Tests for resumeBulletProposal.mjs
 *
 * Run with: node --test src/lib/resumeBulletProposal.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createBulletProposal,
  validateBulletProposal,
  applyBulletProposal,
  isBulletProposal,
  ALLOWED_OPS,
  ALLOWED_SECTIONS,
  ALLOWED_SOURCES,
  ALLOWED_STATUSES
} from "./resumeBulletProposal.mjs";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeResume(overrides = {}) {
  return {
    contact: { name: "Jane Doe", email: "jane@example.com" },
    summary: "A seasoned engineer.",
    experience: [
      {
        company: "Acme Corp",
        title: "Software Engineer",
        bullets: ["Built widget A", "Shipped feature B", "Improved pipeline C"]
      },
      {
        company: "Beta LLC",
        title: "Lead Engineer",
        bullets: ["Led team of 5"],
        _source: "user"
      }
    ],
    projects: [
      {
        name: "Super App",
        bullets: ["Launched MVP", "Scaled to 10k users"]
      }
    ],
    skills: { technical: ["TypeScript", "Node.js"], languages: [], tools: [] },
    ...overrides
  };
}

function makeProposal(overrides = {}) {
  return createBulletProposal({
    op: "add",
    section: "experience",
    itemIndex: 0,
    text: "Reduced latency by 40%",
    source: "work_log",
    logDate: "2026-03-27",
    ...overrides
  });
}

// ─── Constants ─────────────────────────────────────────────────────────────────

describe("Constants", () => {
  it("ALLOWED_OPS contains add, delete, replace", () => {
    assert.deepEqual([...ALLOWED_OPS].sort(), ["add", "delete", "replace"]);
  });

  it("ALLOWED_SECTIONS contains experience and projects", () => {
    assert.deepEqual([...ALLOWED_SECTIONS].sort(), ["experience", "projects"]);
  });

  it("ALLOWED_SOURCES contains expected values", () => {
    assert.deepEqual([...ALLOWED_SOURCES].sort(), ["linkedin", "manual", "work_log"]);
  });

  it("ALLOWED_STATUSES contains expected values", () => {
    assert.deepEqual([...ALLOWED_STATUSES].sort(), ["approved", "discarded", "pending"]);
  });
});

// ─── createBulletProposal ──────────────────────────────────────────────────────

describe("createBulletProposal", () => {
  it("creates a valid add proposal with all required fields", () => {
    const p = makeProposal();

    assert.equal(p.kind, "bullet");
    assert.equal(p.op, "add");
    assert.equal(p.target.section, "experience");
    assert.equal(p.target.itemIndex, 0);
    assert.equal(typeof p.target.bulletIndex, "undefined");
    assert.equal(p.payload.text, "Reduced latency by 40%");
    assert.equal(p.source, "work_log");
    assert.equal(p.logDate, "2026-03-27");
    assert.equal(p.status, "pending");
    assert.ok(typeof p.id === "string" && p.id.length > 0);
    assert.ok(typeof p.createdAt === "string" && p.createdAt.length > 0);
    assert.ok(typeof p.description === "string" && p.description.length > 0);
  });

  it("creates a delete proposal with bulletIndex in target", () => {
    const p = createBulletProposal({
      op: "delete",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 1,
      source: "manual"
    });

    assert.equal(p.op, "delete");
    assert.equal(p.target.bulletIndex, 1);
    assert.deepEqual(p.payload, {});
  });

  it("creates a replace proposal with text in payload", () => {
    const p = createBulletProposal({
      op: "replace",
      section: "projects",
      itemIndex: 0,
      bulletIndex: 0,
      text: "Launched MVP in 6 weeks",
      source: "manual"
    });

    assert.equal(p.op, "replace");
    assert.equal(p.target.section, "projects");
    assert.equal(p.target.bulletIndex, 0);
    assert.equal(p.payload.text, "Launched MVP in 6 weeks");
  });

  it("omits logDate when source is not work_log", () => {
    const p = createBulletProposal({
      op: "add",
      section: "experience",
      itemIndex: 0,
      text: "Some bullet",
      source: "linkedin",
      logDate: "2026-03-27" // should be ignored
    });

    assert.equal(typeof p.logDate, "undefined");
  });

  it("includes logDate when source is work_log", () => {
    const p = createBulletProposal({
      op: "add",
      section: "experience",
      itemIndex: 0,
      text: "Some bullet",
      source: "work_log",
      logDate: "2026-03-27"
    });

    assert.equal(p.logDate, "2026-03-27");
  });

  it("respects custom description override", () => {
    const p = createBulletProposal({
      op: "add",
      section: "experience",
      itemIndex: 0,
      text: "Some bullet",
      description: "My custom label"
    });

    assert.equal(p.description, "My custom label");
  });

  it("throws for invalid op", () => {
    assert.throws(
      () => createBulletProposal({ op: "upsert", section: "experience", itemIndex: 0, text: "x" }),
      /op must be one of/
    );
  });

  it("throws for invalid section", () => {
    assert.throws(
      () => createBulletProposal({ op: "add", section: "skills", itemIndex: 0, text: "x" }),
      /section must be one of/
    );
  });

  it("throws for negative itemIndex", () => {
    assert.throws(
      () => createBulletProposal({ op: "add", section: "experience", itemIndex: -1, text: "x" }),
      /itemIndex must be a non-negative integer/
    );
  });

  it("throws when bulletIndex missing for delete", () => {
    assert.throws(
      () => createBulletProposal({ op: "delete", section: "experience", itemIndex: 0 }),
      /bulletIndex is required for op "delete"/
    );
  });

  it("throws when bulletIndex missing for replace", () => {
    assert.throws(
      () => createBulletProposal({ op: "replace", section: "experience", itemIndex: 0, text: "x" }),
      /bulletIndex is required for op "replace"/
    );
  });

  it("throws when text missing for add", () => {
    assert.throws(
      () => createBulletProposal({ op: "add", section: "experience", itemIndex: 0 }),
      /payload.text must be a non-empty string for op "add"/
    );
  });

  it("throws when text missing for replace", () => {
    assert.throws(
      () =>
        createBulletProposal({
          op: "replace",
          section: "experience",
          itemIndex: 0,
          bulletIndex: 0
        }),
      /payload.text must be a non-empty string for op "replace"/
    );
  });

  it("throws for invalid source", () => {
    assert.throws(
      () =>
        createBulletProposal({
          op: "add",
          section: "experience",
          itemIndex: 0,
          text: "x",
          source: "git"
        }),
      /source must be one of/
    );
  });

  it("add proposal with optional bulletIndex stores it in target", () => {
    const p = createBulletProposal({
      op: "add",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 1,
      text: "Insert before index 1"
    });

    assert.equal(p.target.bulletIndex, 1);
  });
});

// ─── validateBulletProposal ────────────────────────────────────────────────────

describe("validateBulletProposal", () => {
  it("accepts a valid add proposal", () => {
    const p = makeProposal();
    assert.doesNotThrow(() => validateBulletProposal(p));
  });

  it("accepts a valid delete proposal", () => {
    const p = createBulletProposal({
      op: "delete",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 0,
      source: "manual"
    });
    assert.doesNotThrow(() => validateBulletProposal(p));
  });

  it("accepts a valid replace proposal", () => {
    const p = createBulletProposal({
      op: "replace",
      section: "projects",
      itemIndex: 0,
      bulletIndex: 0,
      text: "New text",
      source: "manual"
    });
    assert.doesNotThrow(() => validateBulletProposal(p));
  });

  it("rejects non-objects", () => {
    assert.throws(() => validateBulletProposal(null), /must be a non-null object/);
    assert.throws(() => validateBulletProposal("string"), /must be a non-null object/);
    assert.throws(() => validateBulletProposal(42), /must be a non-null object/);
  });

  it('rejects objects without kind:"bullet"', () => {
    const p = { ...makeProposal(), kind: "suggestion" };
    assert.throws(() => validateBulletProposal(p), /kind must be "bullet"/);
  });

  it("rejects missing id", () => {
    const p = { ...makeProposal(), id: "" };
    assert.throws(() => validateBulletProposal(p), /id must be a non-empty string/);
  });

  it("rejects invalid status", () => {
    const p = { ...makeProposal(), status: "rejected" };
    assert.throws(() => validateBulletProposal(p), /status must be one of/);
  });

  it("rejects missing target", () => {
    const p = { ...makeProposal() };
    delete p.target;
    assert.throws(() => validateBulletProposal(p), /target must be a non-null object/);
  });

  it("rejects missing payload", () => {
    const p = { ...makeProposal() };
    delete p.payload;
    assert.throws(() => validateBulletProposal(p), /payload must be a non-null object/);
  });
});

// ─── applyBulletProposal — add ─────────────────────────────────────────────────

describe("applyBulletProposal — add", () => {
  it("appends a bullet when bulletIndex is absent", () => {
    const resume = makeResume();
    const p = makeProposal(); // op:add, no bulletIndex
    const updated = applyBulletProposal(resume, p);

    assert.deepEqual(updated.experience[0].bullets, [
      "Built widget A",
      "Shipped feature B",
      "Improved pipeline C",
      "Reduced latency by 40%"
    ]);
    // Original not mutated
    assert.equal(resume.experience[0].bullets.length, 3);
  });

  it("inserts a bullet before bulletIndex when provided", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "add",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 1,
      text: "New first-ish bullet"
    });
    const updated = applyBulletProposal(resume, p);

    assert.equal(updated.experience[0].bullets[1], "New first-ish bullet");
    assert.equal(updated.experience[0].bullets.length, 4);
  });

  it("clamps out-of-range bulletIndex to end of array", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "add",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 999,
      text: "Clamped bullet"
    });
    const updated = applyBulletProposal(resume, p);

    assert.equal(updated.experience[0].bullets.at(-1), "Clamped bullet");
  });

  it("adds to projects section", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "add",
      section: "projects",
      itemIndex: 0,
      text: "Reached 100k downloads"
    });
    const updated = applyBulletProposal(resume, p);

    assert.equal(updated.projects[0].bullets.length, 3);
    assert.equal(updated.projects[0].bullets[2], "Reached 100k downloads");
  });

  it("throws when itemIndex is out of range", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "add",
      section: "experience",
      itemIndex: 99,
      text: "x"
    });
    assert.throws(() => applyBulletProposal(resume, p), /does not exist/);
  });

  it("does not mutate the original resume", () => {
    const resume = makeResume();
    const original = JSON.stringify(resume);
    const p = makeProposal();
    applyBulletProposal(resume, p);
    assert.equal(JSON.stringify(resume), original);
  });
});

// ─── applyBulletProposal — delete ─────────────────────────────────────────────

describe("applyBulletProposal — delete", () => {
  it("removes the targeted bullet by index", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "delete",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 1,
      source: "manual"
    });
    const updated = applyBulletProposal(resume, p);

    assert.deepEqual(updated.experience[0].bullets, [
      "Built widget A",
      "Improved pipeline C"
    ]);
  });

  it("removes the first bullet (index 0)", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "delete",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 0,
      source: "manual"
    });
    const updated = applyBulletProposal(resume, p);

    assert.equal(updated.experience[0].bullets[0], "Shipped feature B");
    assert.equal(updated.experience[0].bullets.length, 2);
  });

  it("throws when bulletIndex is out of range", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "delete",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 99,
      source: "manual"
    });
    assert.throws(() => applyBulletProposal(resume, p), /does not exist/);
  });

  it("deletes from a user-sourced item (delete always permitted)", () => {
    const resume = makeResume();
    // experience[1] has _source:'user'
    const p = createBulletProposal({
      op: "delete",
      section: "experience",
      itemIndex: 1,
      bulletIndex: 0,
      source: "work_log"
    });
    const updated = applyBulletProposal(resume, p);
    assert.equal(updated.experience[1].bullets.length, 0);
  });
});

// ─── applyBulletProposal — replace ────────────────────────────────────────────

describe("applyBulletProposal — replace", () => {
  it("replaces the targeted bullet text", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "replace",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 2,
      text: "Improved pipeline C by 50%",
      source: "manual"
    });
    const updated = applyBulletProposal(resume, p);

    assert.equal(updated.experience[0].bullets[2], "Improved pipeline C by 50%");
    assert.equal(updated.experience[0].bullets.length, 3);
  });

  it("returns original resume unchanged when parent item has _source:user and source is work_log", () => {
    const resume = makeResume();
    // experience[1] has _source:'user'
    const p = createBulletProposal({
      op: "replace",
      section: "experience",
      itemIndex: 1,
      bulletIndex: 0,
      text: "Overwritten by system",
      source: "work_log"
    });
    const result = applyBulletProposal(resume, p);

    // Should return the exact same reference (no change)
    assert.equal(result, resume);
    assert.equal(resume.experience[1].bullets[0], "Led team of 5");
  });

  it("allows replace on user-sourced item when source is manual", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "replace",
      section: "experience",
      itemIndex: 1,
      bulletIndex: 0,
      text: "User corrected this manually",
      source: "manual"
    });
    const updated = applyBulletProposal(resume, p);

    assert.equal(updated.experience[1].bullets[0], "User corrected this manually");
  });

  it("throws when bulletIndex is out of range", () => {
    const resume = makeResume();
    const p = createBulletProposal({
      op: "replace",
      section: "experience",
      itemIndex: 0,
      bulletIndex: 99,
      text: "x",
      source: "manual"
    });
    assert.throws(() => applyBulletProposal(resume, p), /does not exist/);
  });
});

// ─── isBulletProposal ──────────────────────────────────────────────────────────

describe("isBulletProposal", () => {
  it('returns true for objects with kind:"bullet"', () => {
    assert.ok(isBulletProposal(makeProposal()));
  });

  it("returns false for legacy SuggestionItem (no kind field)", () => {
    const legacySuggestion = {
      id: "abc",
      type: "work_log_update",
      section: "experience",
      action: "append_bullet",
      status: "pending"
    };
    assert.ok(!isBulletProposal(legacySuggestion));
  });

  it("returns false for null / undefined / primitive", () => {
    assert.ok(!isBulletProposal(null));
    assert.ok(!isBulletProposal(undefined));
    assert.ok(!isBulletProposal("string"));
    assert.ok(!isBulletProposal(42));
  });
});
