/**
 * Resume Bullet Proposal — data model, validation, and apply logic.
 *
 * A BulletProposal is a structured change proposal scoped to exactly ONE bullet
 * inside a resume section item.  It extends the existing SuggestionItem concept
 * (used by suggestions/candidates routes) with a formal, index-based target path
 * and three precise operation types:
 *
 *   add     — append (or insert at a specific position) a new bullet
 *   delete  — remove an existing bullet by index
 *   replace — overwrite the text of an existing bullet by index
 *
 * Target path schema
 * ──────────────────
 *   target.section    — resume top-level key that holds an array of items
 *                       ("experience" | "projects")
 *   target.itemIndex  — 0-based index into resume[section]
 *   target.bulletIndex — 0-based index into resume[section][itemIndex].bullets
 *                        Required for "delete" and "replace".
 *                        Optional for "add": when omitted the bullet is appended;
 *                        when provided the bullet is inserted BEFORE that index.
 *
 * Payload schema (op-specific)
 * ────────────────────────────
 *   add     → { text: string }           — text of the new bullet
 *   delete  → {}                         — no payload needed; target identifies the bullet
 *   replace → { text: string }           — replacement text
 *
 * Full BulletProposal shape (stored in suggestions document alongside SuggestionItems)
 * ─────────────────────────────────────────────────────────────────────────────────────
 *   {
 *     id:          string          — stable UUID (crypto.randomUUID)
 *     kind:        "bullet"        — discriminator that separates BulletProposals
 *                                    from older SuggestionItems in the same array
 *     op:          "add" | "delete" | "replace"
 *     target: {
 *       section:     "experience" | "projects"
 *       itemIndex:   number (≥ 0, integer)
 *       bulletIndex?: number (≥ 0, integer)  — required for delete/replace; optional for add
 *     }
 *     payload: {
 *       text?: string   — required for add/replace; absent for delete
 *     }
 *     description: string  — human-readable one-liner (auto-generated when omitted)
 *     source:      "work_log" | "linkedin" | "manual"
 *     logDate?:    string   — ISO date (YYYY-MM-DD); only when source === "work_log"
 *     createdAt:   string   — ISO datetime
 *     status:      "pending" | "approved" | "discarded"
 *   }
 *
 * Design notes
 * ────────────
 * • Pure module — no I/O, no external imports, no side effects.
 * • Compatible with applySuggestionPatch (resume.mjs): the new action "bullet_proposal"
 *   delegates to applyBulletProposal exported here so the existing route handlers
 *   do not need to be rewritten for this type.
 * • Index-based addressing is intentional: the target path uses integer indices rather
 *   than string identifiers (company name, project name) so that proposals survive
 *   section reordering without silent mismatches.  Stale index validation is the
 *   caller's responsibility at apply time.
 * • "user edits always win" — applying a BulletProposal never touches bullets whose
 *   parent item has _source:"user" when the operation would overwrite existing user
 *   content (replace).  Delete and add are always permitted regardless of _source.
 *
 * @module resumeBulletProposal
 */

import { randomUUID } from "node:crypto";

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Sections that contain bullet arrays and are valid proposal targets. */
export const ALLOWED_SECTIONS = /** @type {const} */ (["experience", "projects"]);

/** Valid operation types for a BulletProposal. */
export const ALLOWED_OPS = /** @type {const} */ (["add", "delete", "replace"]);

/** Valid source values. */
export const ALLOWED_SOURCES = /** @type {const} */ (["work_log", "linkedin", "manual"]);

/** Valid status values. */
export const ALLOWED_STATUSES = /** @type {const} */ (["pending", "approved", "discarded"]);

// ─── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create a new BulletProposal object with status "pending".
 *
 * @param {object} opts
 * @param {"add"|"delete"|"replace"} opts.op             — operation type
 * @param {"experience"|"projects"}  opts.section         — resume section
 * @param {number}                   opts.itemIndex       — 0-based index into section array
 * @param {number|undefined}         [opts.bulletIndex]   — 0-based bullet index (required for delete/replace)
 * @param {string|undefined}         [opts.text]          — bullet text (required for add/replace)
 * @param {"work_log"|"linkedin"|"manual"} [opts.source]  — default "manual"
 * @param {string|undefined}         [opts.logDate]       — ISO date, only for work_log source
 * @param {string|undefined}         [opts.description]   — override auto-generated description
 * @returns {object}  A validated BulletProposal with status "pending"
 * @throws {Error}    If required fields are missing or invalid
 */
export function createBulletProposal({
  op,
  section,
  itemIndex,
  bulletIndex,
  text,
  source = "manual",
  logDate,
  description
}) {
  // Validate then assemble; _validateFields throws on any violation
  _validateOp(op);
  _validateSection(section);
  _validateItemIndex(itemIndex);
  _validateBulletIndexForOp(op, bulletIndex);
  _validateTextForOp(op, text);
  _validateSource(source);

  const target = {
    section,
    itemIndex,
    ...(bulletIndex !== undefined && bulletIndex !== null
      ? { bulletIndex }
      : {})
  };

  const payload = {};
  if (op === "add" || op === "replace") {
    payload.text = String(text).trim();
  }

  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    kind: "bullet",
    op,
    target,
    payload,
    description: description ?? _autoDescription(op, section, itemIndex, bulletIndex, text),
    source,
    ...(source === "work_log" && logDate ? { logDate } : {}),
    createdAt: now,
    status: "pending"
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────────

/**
 * Validate a BulletProposal object and throw a descriptive Error if invalid.
 *
 * Useful for validating proposals arriving from external sources (e.g. API
 * request bodies, Blob storage reads) before operating on them.
 *
 * @param {unknown} proposal  — value to validate
 * @throws {Error}            — first validation failure encountered
 */
export function validateBulletProposal(proposal) {
  if (!proposal || typeof proposal !== "object") {
    throw new Error("BulletProposal must be a non-null object");
  }

  const p = /** @type {Record<string,unknown>} */ (proposal);

  if (p.kind !== "bullet") {
    throw new Error(`BulletProposal.kind must be "bullet"; got ${JSON.stringify(p.kind)}`);
  }

  _validateOp(p.op);
  _validateStatus(p.status);

  if (typeof p.id !== "string" || !p.id) {
    throw new Error("BulletProposal.id must be a non-empty string");
  }

  if (!p.target || typeof p.target !== "object") {
    throw new Error("BulletProposal.target must be a non-null object");
  }

  const t = /** @type {Record<string,unknown>} */ (p.target);
  _validateSection(t.section);
  _validateItemIndex(t.itemIndex);
  _validateBulletIndexForOp(p.op, t.bulletIndex);

  if (!p.payload || typeof p.payload !== "object") {
    throw new Error("BulletProposal.payload must be a non-null object");
  }

  const pl = /** @type {Record<string,unknown>} */ (p.payload);
  _validateTextForOp(p.op, pl.text);
  _validateSource(p.source);
}

// ─── Apply ──────────────────────────────────────────────────────────────────────

/**
 * Apply a BulletProposal to a resume document and return the updated document.
 *
 * The original resume is NOT mutated.  A new document with the minimal necessary
 * structural copies is returned.
 *
 * Behaviour per operation:
 *   add     — append (or insert before bulletIndex) a new bullet string
 *   delete  — remove the bullet at bulletIndex; remaining bullets shift left
 *   replace — overwrite the bullet at bulletIndex with payload.text
 *             Skipped (returns original) when the parent item has _source:"user"
 *             and the proposal source is not "manual" (user edits win).
 *
 * @param {object} resume    — current resume document (not mutated)
 * @param {object} proposal  — a validated BulletProposal object
 * @returns {object}         — updated resume document
 * @throws {Error}           — for invalid proposals or out-of-range indices
 */
export function applyBulletProposal(resume, proposal) {
  validateBulletProposal(proposal);

  const { op, target, payload } = proposal;
  const { section, itemIndex, bulletIndex } = target;

  // Deep-enough clone to avoid mutating the caller's reference
  const updated = { ...resume };
  const sectionArr = Array.isArray(resume[section]) ? resume[section] : [];

  if (itemIndex >= sectionArr.length) {
    throw new Error(
      `applyBulletProposal: ${section}[${itemIndex}] does not exist ` +
      `(section has ${sectionArr.length} items)`
    );
  }

  const item    = sectionArr[itemIndex];
  const bullets = Array.isArray(item.bullets) ? [...item.bullets] : [];

  switch (op) {
    case "add": {
      const text = String(payload.text ?? "").trim();
      if (!text) {
        throw new Error("applyBulletProposal: add requires non-empty payload.text");
      }
      if (bulletIndex !== undefined && Number.isFinite(bulletIndex)) {
        // Insert before bulletIndex (clamp to valid range)
        const insertAt = Math.min(Math.max(0, bulletIndex), bullets.length);
        bullets.splice(insertAt, 0, text);
      } else {
        bullets.push(text);
      }
      break;
    }

    case "delete": {
      if (bulletIndex === undefined || !Number.isFinite(bulletIndex)) {
        throw new Error(
          "applyBulletProposal: delete requires a numeric bulletIndex in target"
        );
      }
      if (bulletIndex >= bullets.length) {
        throw new Error(
          `applyBulletProposal: delete target bullet[${bulletIndex}] does not exist ` +
          `(item has ${bullets.length} bullets)`
        );
      }
      bullets.splice(bulletIndex, 1);
      break;
    }

    case "replace": {
      if (bulletIndex === undefined || !Number.isFinite(bulletIndex)) {
        throw new Error(
          "applyBulletProposal: replace requires a numeric bulletIndex in target"
        );
      }
      if (bulletIndex >= bullets.length) {
        throw new Error(
          `applyBulletProposal: replace target bullet[${bulletIndex}] does not exist ` +
          `(item has ${bullets.length} bullets)`
        );
      }

      // User-edit protection: if the parent item was directly edited by the user
      // and this proposal comes from an automated source, refuse to overwrite.
      if (item._source === "user" && proposal.source !== "manual") {
        // Return unchanged — user edits always win over system merges.
        return resume;
      }

      const text = String(payload.text ?? "").trim();
      if (!text) {
        throw new Error("applyBulletProposal: replace requires non-empty payload.text");
      }
      bullets[bulletIndex] = text;
      break;
    }

    default:
      throw new Error(`applyBulletProposal: unknown op "${op}"`);
  }

  const updatedItem = { ...item, bullets };
  const updatedSection = sectionArr.map((it, i) =>
    i === itemIndex ? updatedItem : it
  );

  updated[section] = updatedSection;
  return updated;
}

// ─── Type guards ────────────────────────────────────────────────────────────────

/**
 * Returns true when the given object is a BulletProposal (not a legacy SuggestionItem).
 *
 * @param {unknown} item
 * @returns {boolean}
 */
export function isBulletProposal(item) {
  return (
    item !== null &&
    typeof item === "object" &&
    /** @type {Record<string,unknown>} */ (item).kind === "bullet"
  );
}

// ─── Private helpers ────────────────────────────────────────────────────────────

function _validateOp(op) {
  if (!ALLOWED_OPS.includes(op)) {
    throw new Error(
      `BulletProposal.op must be one of ${ALLOWED_OPS.join(" | ")}; got ${JSON.stringify(op)}`
    );
  }
}

function _validateSection(section) {
  if (!ALLOWED_SECTIONS.includes(section)) {
    throw new Error(
      `BulletProposal.target.section must be one of ${ALLOWED_SECTIONS.join(" | ")}; ` +
      `got ${JSON.stringify(section)}`
    );
  }
}

function _validateItemIndex(itemIndex) {
  if (!Number.isFinite(itemIndex) || itemIndex < 0 || !Number.isInteger(itemIndex)) {
    throw new Error(
      `BulletProposal.target.itemIndex must be a non-negative integer; got ${JSON.stringify(itemIndex)}`
    );
  }
}

function _validateBulletIndexForOp(op, bulletIndex) {
  if (op === "delete" || op === "replace") {
    // bulletIndex is required
    if (bulletIndex === undefined || bulletIndex === null) {
      throw new Error(
        `BulletProposal.target.bulletIndex is required for op "${op}"`
      );
    }
    if (!Number.isFinite(bulletIndex) || bulletIndex < 0 || !Number.isInteger(bulletIndex)) {
      throw new Error(
        `BulletProposal.target.bulletIndex must be a non-negative integer for op "${op}"; ` +
        `got ${JSON.stringify(bulletIndex)}`
      );
    }
  } else if (op === "add") {
    // bulletIndex is optional for add; if provided must be a valid non-negative integer
    if (bulletIndex !== undefined && bulletIndex !== null) {
      if (!Number.isFinite(bulletIndex) || bulletIndex < 0 || !Number.isInteger(bulletIndex)) {
        throw new Error(
          `BulletProposal.target.bulletIndex must be a non-negative integer when provided for op "add"; ` +
          `got ${JSON.stringify(bulletIndex)}`
        );
      }
    }
  }
}

function _validateTextForOp(op, text) {
  if (op === "add" || op === "replace") {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(
        `BulletProposal.payload.text must be a non-empty string for op "${op}"; ` +
        `got ${JSON.stringify(text)}`
      );
    }
  }
  // delete: text not required; no validation needed
}

function _validateSource(source) {
  if (!ALLOWED_SOURCES.includes(source)) {
    throw new Error(
      `BulletProposal.source must be one of ${ALLOWED_SOURCES.join(" | ")}; got ${JSON.stringify(source)}`
    );
  }
}

function _validateStatus(status) {
  if (!ALLOWED_STATUSES.includes(status)) {
    throw new Error(
      `BulletProposal.status must be one of ${ALLOWED_STATUSES.join(" | ")}; got ${JSON.stringify(status)}`
    );
  }
}

/**
 * Generate a human-readable description for a BulletProposal when none is supplied.
 *
 * @param {string} op
 * @param {string} section
 * @param {number} itemIndex
 * @param {number|undefined} bulletIndex
 * @param {string|undefined} text
 * @returns {string}
 */
function _autoDescription(op, section, itemIndex, bulletIndex, text) {
  const loc = bulletIndex !== undefined
    ? `${section}[${itemIndex}].bullets[${bulletIndex}]`
    : `${section}[${itemIndex}]`;

  switch (op) {
    case "add": {
      const preview = text ? _truncate(String(text).trim(), 60) : "(no text)";
      return `bullet 추가 (${loc}): ${preview}`;
    }
    case "delete":
      return `bullet 삭제 (${loc})`;
    case "replace": {
      const preview = text ? _truncate(String(text).trim(), 60) : "(no text)";
      return `bullet 수정 (${loc}): ${preview}`;
    }
    default:
      return `bullet 변경 (${loc})`;
  }
}

function _truncate(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}
