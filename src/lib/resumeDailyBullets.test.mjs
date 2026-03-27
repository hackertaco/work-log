/**
 * Tests for resumeDailyBullets.mjs
 *
 * Covers:
 *   - buildDailyBulletsDocument: input variants, deduplication, category annotation,
 *     section inference, stable IDs
 *   - mergeDailyBulletsDocuments: null existing doc, status preservation,
 *     new bullet appending, no duplicates
 *   - promoteBullet: happy path, not-found, wrong status
 *   - dismissBullet: happy path, not-found, wrong status
 *   - editBullet: happy path, section re-inference, not-found, wrong status, empty text
 *   - getPendingBullets: filter by status
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DAILY_BULLETS_SCHEMA_VERSION,
  BULLET_CATEGORIES,
  BULLET_SUGGESTED_SECTIONS,
  BULLET_STATUSES,
  buildDailyBulletsDocument,
  mergeDailyBulletsDocuments,
  promoteBullet,
  dismissBullet,
  editBullet,
  getPendingBullets,
  invalidateDailyBulletsDocument
} from "./resumeDailyBullets.mjs";

// ─── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("DAILY_BULLETS_SCHEMA_VERSION is 1", () => {
    assert.equal(DAILY_BULLETS_SCHEMA_VERSION, 1);
  });

  it("BULLET_CATEGORIES contains the three expected values", () => {
    assert.deepEqual([...BULLET_CATEGORIES].sort(), ["company", "opensource", "other"]);
  });

  it("BULLET_SUGGESTED_SECTIONS contains the three expected values", () => {
    assert.deepEqual([...BULLET_SUGGESTED_SECTIONS].sort(), ["experience", "projects", "skills"]);
  });

  it("BULLET_STATUSES contains the three expected values", () => {
    assert.deepEqual([...BULLET_STATUSES].sort(), ["dismissed", "pending", "promoted"]);
  });
});

// ─── buildDailyBulletsDocument ────────────────────────────────────────────────

describe("buildDailyBulletsDocument", () => {
  it("returns a valid DailyBulletsDocument with schemaVersion 1", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", { candidates: [] });
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.date, "2025-03-26");
    assert.equal(doc.sourceType, "work_log_batch");
    assert.ok(typeof doc.generatedAt === "string");
    assert.deepEqual(doc.bullets, []);
  });

  it("converts candidate strings into DailyBulletItems with stable IDs", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Implemented a new feature", "Fixed a bug"]
    });

    assert.equal(doc.bullets.length, 2);
    assert.equal(doc.bullets[0].id, "bullet-2025-03-26-0");
    assert.equal(doc.bullets[1].id, "bullet-2025-03-26-1");
  });

  it("all new bullets start as pending with null promotedSuggestionId", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Did some work"]
    });
    assert.equal(doc.bullets[0].status, "pending");
    assert.equal(doc.bullets[0].promotedSuggestionId, null);
    assert.ok(typeof doc.bullets[0].createdAt === "string");
  });

  it("deduplicates candidates by normalised text (case, whitespace)", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Implemented React hooks", "implemented react hooks", "  Implemented React Hooks  "]
    });
    assert.equal(doc.bullets.length, 1);
    assert.equal(doc.bullets[0].text, "Implemented React hooks");
  });

  it("annotates category=company for bullets in companyCandidates", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Company work item", "Open source contribution"],
      companyCandidates: ["Company work item"],
      openSourceCandidates: ["Open source contribution"]
    });
    assert.equal(doc.bullets[0].category, "company");
    assert.equal(doc.bullets[1].category, "opensource");
  });

  it("annotates category=other for bullets in neither subset", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Personal side project"],
      companyCandidates: [],
      openSourceCandidates: []
    });
    assert.equal(doc.bullets[0].category, "other");
  });

  it("handles null/undefined dailyResume gracefully", () => {
    const docNull = buildDailyBulletsDocument("2025-03-26", null);
    assert.deepEqual(docNull.bullets, []);

    const docUndef = buildDailyBulletsDocument("2025-03-26", undefined);
    assert.deepEqual(docUndef.bullets, []);
  });

  it("skips empty or whitespace-only candidates", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["", "   ", "Valid bullet"]
    });
    assert.equal(doc.bullets.length, 1);
    assert.equal(doc.bullets[0].text, "Valid bullet");
  });

  // Section inference
  it("infers suggestedSection=skills for technology keywords", () => {
    const doc = buildDailyBulletsDocument("2025-01-01", {
      candidates: ["Migrated service to TypeScript"]
    });
    assert.equal(doc.bullets[0].suggestedSection, "skills");
  });

  it("infers suggestedSection=projects for project/library keywords", () => {
    const doc = buildDailyBulletsDocument("2025-01-01", {
      candidates: ["Published open-source library to npm"]
    });
    assert.equal(doc.bullets[0].suggestedSection, "projects");
  });

  it("defaults suggestedSection=experience for general work descriptions", () => {
    const doc = buildDailyBulletsDocument("2025-01-01", {
      candidates: ["Led the quarterly planning session with stakeholders"]
    });
    assert.equal(doc.bullets[0].suggestedSection, "experience");
  });
});

// ─── mergeDailyBulletsDocuments ───────────────────────────────────────────────

describe("mergeDailyBulletsDocuments", () => {
  const freshDoc = buildDailyBulletsDocument("2025-03-26", {
    candidates: ["New bullet A", "New bullet B"]
  });

  it("returns freshDoc when existingDoc is null", () => {
    const result = mergeDailyBulletsDocuments(null, freshDoc);
    assert.deepEqual(result, freshDoc);
  });

  it("returns freshDoc when existingDoc.bullets is not an array", () => {
    const result = mergeDailyBulletsDocuments({ bullets: null }, freshDoc);
    assert.deepEqual(result, freshDoc);
  });

  it("preserves status of existing bullets that appear in fresh doc", () => {
    // Simulate an existing doc where the first bullet was promoted
    const existingDoc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["New bullet A"]
    });
    const promoted = promoteBullet(existingDoc, existingDoc.bullets[0].id, "sug-123");

    const result = mergeDailyBulletsDocuments(promoted, freshDoc);
    const bulletA = result.bullets.find((b) => b.id === promoted.bullets[0].id);

    assert.equal(bulletA.status, "promoted");
    assert.equal(bulletA.promotedSuggestionId, "sug-123");
  });

  it("appends new bullets that are not in the existing cache", () => {
    const existingDoc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["New bullet A"]
    });
    const result = mergeDailyBulletsDocuments(existingDoc, freshDoc);

    // Should contain both A (from existing) and B (new)
    assert.equal(result.bullets.length, 2);
    const texts = result.bullets.map((b) => b.text);
    assert.ok(texts.includes("New bullet A"));
    assert.ok(texts.includes("New bullet B"));
  });

  it("does not duplicate bullets present in both existing and fresh docs", () => {
    const existingDoc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["New bullet A", "New bullet B"]
    });
    const result = mergeDailyBulletsDocuments(existingDoc, freshDoc);
    assert.equal(result.bullets.length, 2);
  });

  it("retains existing bullets absent from fresh doc", () => {
    const existingDoc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Old unique bullet"]
    });
    const result = mergeDailyBulletsDocuments(existingDoc, freshDoc);

    const texts = result.bullets.map((b) => b.text);
    assert.ok(texts.includes("Old unique bullet"));
  });

  it("updates generatedAt from the fresh document", () => {
    const existingDoc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Bullet X"]
    });
    // Ensure freshDoc has a later generatedAt
    const result = mergeDailyBulletsDocuments(existingDoc, freshDoc);
    assert.equal(result.generatedAt, freshDoc.generatedAt);
  });
});

// ─── promoteBullet ────────────────────────────────────────────────────────────

describe("promoteBullet", () => {
  function makeDoc() {
    return buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Bullet to promote", "Another bullet"]
    });
  }

  it("marks the target bullet as promoted with the given suggestionId", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const updated = promoteBullet(doc, id, "sug-abc");

    assert.equal(updated.bullets[0].status, "promoted");
    assert.equal(updated.bullets[0].promotedSuggestionId, "sug-abc");
  });

  it("does not mutate the original document", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    promoteBullet(doc, id, "sug-abc");

    assert.equal(doc.bullets[0].status, "pending");
    assert.equal(doc.bullets[0].promotedSuggestionId, null);
  });

  it("leaves other bullets unchanged", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const updated = promoteBullet(doc, id, "sug-abc");

    assert.equal(updated.bullets[1].status, "pending");
    assert.equal(updated.bullets[1].promotedSuggestionId, null);
  });

  it("updates generatedAt on the returned document", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const before = doc.generatedAt;
    const updated = promoteBullet(doc, id, "sug-xyz");
    // generatedAt may be equal if executed within the same millisecond,
    // but must be a valid ISO string
    assert.ok(typeof updated.generatedAt === "string");
    assert.ok(updated.generatedAt >= before);
  });

  it("throws when bulletId is not found", () => {
    const doc = makeDoc();
    assert.throws(
      () => promoteBullet(doc, "bullet-not-real", "sug-x"),
      /Bullet not found/
    );
  });

  it("throws when bullet is already promoted", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const promoted = promoteBullet(doc, id, "sug-1");

    assert.throws(
      () => promoteBullet(promoted, id, "sug-2"),
      /status is "promoted"/
    );
  });

  it("throws when bullet is already dismissed", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const dismissed = dismissBullet(doc, id);

    assert.throws(
      () => promoteBullet(dismissed, id, "sug-1"),
      /status is "dismissed"/
    );
  });
});

// ─── dismissBullet ────────────────────────────────────────────────────────────

describe("dismissBullet", () => {
  function makeDoc() {
    return buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Bullet to dismiss", "Keep this one"]
    });
  }

  it("marks the target bullet as dismissed", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const updated = dismissBullet(doc, id);

    assert.equal(updated.bullets[0].status, "dismissed");
  });

  it("does not mutate the original document", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    dismissBullet(doc, id);

    assert.equal(doc.bullets[0].status, "pending");
  });

  it("leaves other bullets unchanged", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const updated = dismissBullet(doc, id);

    assert.equal(updated.bullets[1].status, "pending");
  });

  it("throws when bulletId is not found", () => {
    const doc = makeDoc();
    assert.throws(
      () => dismissBullet(doc, "bullet-not-real"),
      /Bullet not found/
    );
  });

  it("throws when bullet is already dismissed", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const dismissed = dismissBullet(doc, id);

    assert.throws(
      () => dismissBullet(dismissed, id),
      /status is "dismissed"/
    );
  });

  it("throws when bullet is already promoted", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const promoted = promoteBullet(doc, id, "sug-1");

    assert.throws(
      () => dismissBullet(promoted, id),
      /status is "promoted"/
    );
  });
});

// ─── editBullet ───────────────────────────────────────────────────────────────

describe("editBullet", () => {
  function makeDoc() {
    return buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Original text about planning", "Another bullet"]
    });
  }

  it("replaces the text of a pending bullet", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const updated = editBullet(doc, id, "Updated text about React");

    assert.equal(updated.bullets[0].text, "Updated text about React");
  });

  it("trims whitespace from the new text", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const updated = editBullet(doc, id, "  Trimmed text  ");

    assert.equal(updated.bullets[0].text, "Trimmed text");
  });

  it("re-infers suggestedSection from the new text", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;

    // Original: "about planning" → experience
    assert.equal(doc.bullets[0].suggestedSection, "experience");

    // After edit to a tech-keyword text → skills
    const updated = editBullet(doc, id, "Refactored API layer using TypeScript");
    assert.equal(updated.bullets[0].suggestedSection, "skills");
  });

  it("does not mutate the original document", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const origText = doc.bullets[0].text;
    editBullet(doc, id, "New text");

    assert.equal(doc.bullets[0].text, origText);
  });

  it("leaves other bullets unchanged", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const updated = editBullet(doc, id, "New text");

    assert.equal(updated.bullets[1].text, doc.bullets[1].text);
  });

  it("updates generatedAt on the returned document", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const before = doc.generatedAt;
    const updated = editBullet(doc, id, "New text");
    assert.ok(typeof updated.generatedAt === "string");
    assert.ok(updated.generatedAt >= before);
  });

  it("throws when newText is empty string", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    assert.throws(
      () => editBullet(doc, id, ""),
      /must not be empty/
    );
  });

  it("throws when newText is whitespace only", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    assert.throws(
      () => editBullet(doc, id, "   "),
      /must not be empty/
    );
  });

  it("throws when bulletId is not found", () => {
    const doc = makeDoc();
    assert.throws(
      () => editBullet(doc, "bullet-not-real", "New text"),
      /Bullet not found/
    );
  });

  it("throws when bullet is already promoted", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const promoted = promoteBullet(doc, id, "sug-1");

    assert.throws(
      () => editBullet(promoted, id, "New text"),
      /status is "promoted"/
    );
  });

  it("throws when bullet is already dismissed", () => {
    const doc = makeDoc();
    const id = doc.bullets[0].id;
    const dismissed = dismissBullet(doc, id);

    assert.throws(
      () => editBullet(dismissed, id, "New text"),
      /status is "dismissed"/
    );
  });
});

// ─── getPendingBullets ────────────────────────────────────────────────────────

describe("getPendingBullets", () => {
  it("returns only bullets with status=pending", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Pending A", "Pending B", "Will be promoted", "Will be dismissed"]
    });

    const promoted = promoteBullet(doc, doc.bullets[2].id, "sug-1");
    const finalDoc = dismissBullet(promoted, promoted.bullets[3].id);

    const pending = getPendingBullets(finalDoc);
    assert.equal(pending.length, 2);
    assert.ok(pending.every((b) => b.status === "pending"));
  });

  it("returns empty array when all bullets are processed", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Only bullet"]
    });
    const dismissed = dismissBullet(doc, doc.bullets[0].id);

    assert.deepEqual(getPendingBullets(dismissed), []);
  });

  it("returns empty array when doc has no bullets", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", { candidates: [] });
    assert.deepEqual(getPendingBullets(doc), []);
  });

  it("handles null doc gracefully", () => {
    assert.deepEqual(getPendingBullets(null), []);
  });

  it("handles undefined doc gracefully", () => {
    assert.deepEqual(getPendingBullets(undefined), []);
  });
});

// ─── Cache invalidation metadata ─────────────────────────────────────────────

describe("buildDailyBulletsDocument — cache invalidation metadata fields", () => {
  it("initialises sourceEntryId to the date when not provided", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", { candidates: [] });
    assert.equal(doc.sourceEntryId, "2025-03-26");
  });

  it("uses the provided sourceEntryId when given", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", { candidates: [] }, "custom-entry-id");
    assert.equal(doc.sourceEntryId, "custom-entry-id");
  });

  it("initialises invalidatedAt to null", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", { candidates: [] });
    assert.equal(doc.invalidatedAt, null);
  });

  it("initialises invalidationReason to null", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", { candidates: [] });
    assert.equal(doc.invalidationReason, null);
  });

  it("each bullet carries sourceEntryId matching the document sourceEntryId", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Did some work", "Deployed to production"]
    });
    for (const bullet of doc.bullets) {
      assert.equal(
        bullet.sourceEntryId,
        doc.sourceEntryId,
        `Bullet ${bullet.id} sourceEntryId must match document sourceEntryId`
      );
    }
  });

  it("each bullet sourceEntryId equals the date by default", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Built new feature"]
    });
    assert.equal(doc.bullets[0].sourceEntryId, "2025-03-26");
  });

  it("each bullet sourceEntryId reflects a custom sourceEntryId", () => {
    const doc = buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Built new feature"]
    }, "batch-run-42");
    assert.equal(doc.bullets[0].sourceEntryId, "batch-run-42");
  });
});

// ─── invalidateDailyBulletsDocument ───────────────────────────────────────────

describe("invalidateDailyBulletsDocument", () => {
  function makeDoc() {
    return buildDailyBulletsDocument("2025-03-26", {
      candidates: ["Bullet A", "Bullet B"]
    });
  }

  it("sets invalidatedAt to a non-null ISO string", () => {
    const doc = makeDoc();
    const invalidated = invalidateDailyBulletsDocument(doc);
    assert.ok(
      typeof invalidated.invalidatedAt === "string" && invalidated.invalidatedAt.length > 0,
      "invalidatedAt must be a non-empty ISO string"
    );
  });

  it("sets invalidationReason to 'explicit' by default", () => {
    const doc = makeDoc();
    const invalidated = invalidateDailyBulletsDocument(doc);
    assert.equal(invalidated.invalidationReason, "explicit");
  });

  it("uses the provided reason when given", () => {
    const doc = makeDoc();
    const invalidated = invalidateDailyBulletsDocument(doc, "work_log_updated");
    assert.equal(invalidated.invalidationReason, "work_log_updated");
  });

  it("does not mutate the original document", () => {
    const doc = makeDoc();
    invalidateDailyBulletsDocument(doc, "test");
    assert.equal(doc.invalidatedAt, null, "Original doc must not be mutated");
    assert.equal(doc.invalidationReason, null, "Original doc must not be mutated");
  });

  it("preserves all other document fields unchanged", () => {
    const doc = makeDoc();
    const invalidated = invalidateDailyBulletsDocument(doc, "test");

    assert.equal(invalidated.schemaVersion, doc.schemaVersion);
    assert.equal(invalidated.date, doc.date);
    assert.equal(invalidated.generatedAt, doc.generatedAt);
    assert.equal(invalidated.sourceType, doc.sourceType);
    assert.equal(invalidated.sourceEntryId, doc.sourceEntryId);
    assert.deepEqual(invalidated.bullets, doc.bullets);
  });

  it("throws when doc is null", () => {
    assert.throws(
      () => invalidateDailyBulletsDocument(null),
      /doc must be a non-null object/
    );
  });

  it("throws when doc is undefined", () => {
    assert.throws(
      () => invalidateDailyBulletsDocument(undefined),
      /doc must be a non-null object/
    );
  });

  it("throws when doc has an unsupported schemaVersion", () => {
    const doc = { ...makeDoc(), schemaVersion: 99 };
    assert.throws(
      () => invalidateDailyBulletsDocument(doc),
      /unsupported schemaVersion/
    );
  });

  it("invalidatedAt is a valid ISO timestamp that is >= generatedAt", () => {
    const doc = makeDoc();
    const invalidated = invalidateDailyBulletsDocument(doc);
    const invalidatedTime = new Date(invalidated.invalidatedAt);
    const generatedTime = new Date(doc.generatedAt);
    assert.ok(
      !isNaN(invalidatedTime.getTime()),
      "invalidatedAt must be a valid date"
    );
    assert.ok(
      invalidatedTime >= generatedTime,
      "invalidatedAt must be >= generatedAt"
    );
  });
});

// ─── Full lifecycle integration ───────────────────────────────────────────────

describe("full bullet lifecycle", () => {
  it("build → merge → promote → dismiss → getPending", () => {
    const date = "2025-03-26";

    // Day 1 batch
    const batch1 = buildDailyBulletsDocument(date, {
      candidates: ["Feature A", "Feature B", "Feature C"],
      companyCandidates: ["Feature A", "Feature B"]
    });

    assert.equal(batch1.bullets.length, 3);
    assert.equal(getPendingBullets(batch1).length, 3);

    // Day 2 re-run adds Feature D; Feature A and B are already in the cache
    const batch2 = buildDailyBulletsDocument(date, {
      candidates: ["Feature A", "Feature B", "Feature D"],
      companyCandidates: ["Feature A", "Feature B"]
    });

    const merged = mergeDailyBulletsDocuments(batch1, batch2);
    // A, B, C from batch1 + D from batch2 (A, B not duplicated)
    assert.equal(merged.bullets.length, 4);

    // Promote Feature A
    const idA = merged.bullets[0].id;
    const afterPromote = promoteBullet(merged, idA, "sug-promote-a");

    // Dismiss Feature B
    const idB = afterPromote.bullets[1].id;
    const afterDismiss = dismissBullet(afterPromote, idB);

    // Pending should be C and D
    const pending = getPendingBullets(afterDismiss);
    assert.equal(pending.length, 2);
    const pendingTexts = pending.map((b) => b.text);
    assert.ok(pendingTexts.includes("Feature C"));
    assert.ok(pendingTexts.includes("Feature D"));

    // Edit Feature C's text
    const idC = afterDismiss.bullets[2].id;
    const afterEdit = editBullet(afterDismiss, idC, "Feature C — enhanced description");
    assert.equal(afterEdit.bullets[2].text, "Feature C — enhanced description");
    assert.equal(getPendingBullets(afterEdit).length, 2);
  });
});
