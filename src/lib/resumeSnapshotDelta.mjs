/**
 * resumeSnapshotDelta.mjs — Snapshot retrieval + profile change-rate utility.
 *
 * Provides three public exports:
 *
 *   1. getLastApprovedSnapshot()
 *      Async.  Lists Blob snapshots (most-recent first), skips rollback-safety
 *      entries, and returns the first envelope whose triggeredBy is an approval
 *      action ("approve" | "patch") or whose label contains "approve".
 *      Falls back to the most-recent snapshot of any kind when no explicit
 *      approval snapshot is found.  Returns null when no snapshots exist.
 *
 *   2. computeProfileDelta(prevProfile, currentProfile)
 *      Pure function (no I/O, no mutations).
 *      Accepts two resume-profile plain objects and returns a DeltaReport:
 *        {
 *          rate:         number   0.0–1.0  fraction of atomic units changed
 *          changedUnits: number   count of changed atomic units
 *          totalUnits:   number   denominator used for rate calculation
 *          breakdown:    object   per-section changed/total pairs
 *          isEmpty:      boolean  true when rate === 0
 *        }
 *      Atomic units are defined at bullet / scalar-field granularity — the
 *      minimum edit unit consistent with the project's bullet-first edit model.
 *
 *   3. deltaFromLastApproved(currentProfile)
 *      Async convenience wrapper: fetches the last approved snapshot, extracts
 *      its nested resume, and calls computeProfileDelta.
 *      Returns { snapshot, delta } where snapshot may be null when no snapshots
 *      exist (delta will have rate 0 / isEmpty true in that case).
 *
 * Design principles:
 *   • computeProfileDelta is a pure utility — it can be unit-tested without I/O.
 *   • getLastApprovedSnapshot reads at most MAX_SNAPSHOT_PROBE envelopes from
 *     Blob to find an approval-triggered entry; it does NOT exhaust the full list.
 *   • No external dependencies beyond the project's own blob.mjs and resumeDiff.mjs.
 *
 * @module resumeSnapshotDelta
 */

import { listSnapshots, readSnapshotByKey } from "./blob.mjs";
import { diffResume } from "./resumeDiff.mjs";

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Maximum number of snapshot envelopes to fetch when searching for the last
 * approval-triggered snapshot.  Keeps Blob read cost bounded.
 */
const MAX_SNAPSHOT_PROBE = 10;

/**
 * triggeredBy values that identify an approval event.
 * "approve"  → POST /suggestions/:id/approve
 * "patch"    → PATCH /candidates/:id (status → approved)
 * "batch"    → daily batch checkpoint (resumeBatchHook.mjs Step 10)
 *              Records the "last known good" resume state at batch run time;
 *              treated as an approval checkpoint for delta computation purposes.
 */
const APPROVE_TRIGGERS = new Set(["approve", "patch", "batch"]);

/**
 * triggeredBy values that identify non-approval system events.
 * These are skipped when searching for the last approved snapshot.
 */
const SKIP_TRIGGERS = new Set(["rollback", "rollback-backup"]);

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch the most recent approval-triggered snapshot envelope from Vercel Blob.
 *
 * Search strategy:
 *   1. List all snapshot metadata (most-recent first, no body fetched).
 *   2. Probe up to MAX_SNAPSHOT_PROBE envelopes to find one whose triggeredBy
 *      is an approval action or whose label contains "approve".
 *   3. If none is found within the probe window, fall back to the most-recent
 *      non-rollback snapshot.
 *   4. If the Blob store is empty, return null.
 *
 * @returns {Promise<object|null>} Full snapshot envelope (with nested `resume`
 *   field) or null when no snapshots exist.
 */
export async function getLastApprovedSnapshot() {
  const allMeta = await listSnapshots(); // sorted most-recent first, lightweight metadata
  if (allMeta.length === 0) return null;

  const probe = allMeta.slice(0, MAX_SNAPSHOT_PROBE);

  // First pass: find an explicit approval-triggered snapshot.
  for (const meta of probe) {
    const envelope = await readSnapshotByKey(meta.snapshotKey);
    if (!envelope) continue;

    const trigger = envelope.triggeredBy ?? "";
    const label = String(envelope.label ?? "");

    if (SKIP_TRIGGERS.has(trigger)) continue;

    if (APPROVE_TRIGGERS.has(trigger) || label.toLowerCase().includes("approve")) {
      return envelope;
    }
  }

  // Second pass (fallback): return the most-recent non-rollback snapshot.
  for (const meta of probe) {
    const envelope = await readSnapshotByKey(meta.snapshotKey);
    if (!envelope) continue;
    if (SKIP_TRIGGERS.has(envelope.triggeredBy ?? "")) continue;
    return envelope;
  }

  return null;
}

/**
 * Compute a numeric change-rate report between two resume profile objects.
 *
 * Uses diffResume for structural diffing, then counts atomic units at bullet /
 * scalar-field granularity.  The denominator is the union of units present in
 * either the previous or the current profile (max of the two independent counts),
 * so additions and deletions are treated symmetrically.
 *
 * @param {object|null|undefined} prevProfile  Previous profile (e.g. from snapshot).
 * @param {object|null|undefined} currentProfile  Current live profile.
 * @returns {DeltaReport}
 */
export function computeProfileDelta(prevProfile, currentProfile) {
  // Guard: both must be non-null objects.
  const prev = prevProfile && typeof prevProfile === "object" ? prevProfile : null;
  const curr = currentProfile && typeof currentProfile === "object" ? currentProfile : null;

  if (!prev && !curr) return _emptyDelta();
  if (!prev) return _fullDelta(curr); // everything in curr is "new"
  if (!curr) return _fullDelta(prev); // everything in prev is "deleted"

  const diff = diffResume(prev, curr);

  // ── Count atomic units in each profile ──────────────────────────────────────
  const prevUnits = _countUnits(prev);
  const currUnits = _countUnits(curr);

  // ── Count changed atomic units from the diff ─────────────────────────────────
  const breakdown = _computeBreakdown(diff, prev, curr);

  const totalUnits = Math.max(prevUnits.total, currUnits.total);
  const changedUnits = breakdown._totalChanged;

  const rate = totalUnits > 0 ? Math.min(1, changedUnits / totalUnits) : 0;

  return {
    rate: _round(rate),
    changedUnits,
    totalUnits,
    isEmpty: changedUnits === 0,
    breakdown: _omitInternal(breakdown)
  };
}

/**
 * Async convenience: fetch the last approved snapshot and compute the delta
 * against the supplied current profile.
 *
 * @param {object|null|undefined} currentProfile  The live resume profile object.
 * @returns {Promise<{ snapshot: object|null, delta: DeltaReport }>}
 */
export async function deltaFromLastApproved(currentProfile) {
  const snapshot = await getLastApprovedSnapshot();
  const prevProfile = snapshot?.resume ?? null;
  const delta = computeProfileDelta(prevProfile, currentProfile);
  return { snapshot, delta };
}

// ─── Unit counting ────────────────────────────────────────────────────────────

/**
 * Count the number of atomic units in a profile.
 * Returns an object with per-section counts plus a `total` summary.
 *
 * Atomic units by section:
 *   contact          → 1 per non-empty string field (6 possible)
 *   summary          → 1 if non-empty
 *   experience       → 1 per entry + 1 per non-empty bullet
 *   education        → 1 per entry
 *   skills.technical → 1 per non-empty skill string
 *   skills.languages → 1 per non-empty language string
 *   skills.tools     → 1 per non-empty tool string
 *   projects         → 1 per entry + 1 per non-empty bullet
 *   certifications   → 1 per entry
 *   strength_keywords→ 1 per non-empty keyword
 *   display_axes     → 1 per axis
 *
 * @param {object} profile
 * @returns {{ contact: number, summary: number, experience: number, education: number,
 *             skillsTechnical: number, skillsLanguages: number, skillsTools: number,
 *             projects: number, certifications: number, strengthKeywords: number,
 *             displayAxes: number, total: number }}
 */
function _countUnits(profile) {
  const p = profile ?? {};

  const contact = _countContactUnits(p.contact);
  const summary = _isNonEmptyStr(p.summary) ? 1 : 0;
  const experience = _countBulletSectionUnits(p.experience);
  const education = Array.isArray(p.education) ? p.education.length : 0;
  const skills = p.skills && typeof p.skills === "object" ? p.skills : {};
  const skillsTechnical = _countStringArrayUnits(skills.technical);
  const skillsLanguages = _countStringArrayUnits(skills.languages);
  const skillsTools = _countStringArrayUnits(skills.tools);
  const projects = _countBulletSectionUnits(p.projects);
  const certifications = Array.isArray(p.certifications) ? p.certifications.length : 0;
  const strengthKeywords = _countStringArrayUnits(p.strength_keywords);
  const displayAxes = Array.isArray(p.display_axes) ? p.display_axes.length : 0;

  const total =
    contact +
    summary +
    experience +
    education +
    skillsTechnical +
    skillsLanguages +
    skillsTools +
    projects +
    certifications +
    strengthKeywords +
    displayAxes;

  return {
    contact,
    summary,
    experience,
    education,
    skillsTechnical,
    skillsLanguages,
    skillsTools,
    projects,
    certifications,
    strengthKeywords,
    displayAxes,
    total
  };
}

/**
 * Count non-empty contact string fields.
 * @param {object|undefined} contact
 * @returns {number}
 */
function _countContactUnits(contact) {
  const c = contact && typeof contact === "object" ? contact : {};
  const fields = ["name", "email", "phone", "location", "website", "linkedin"];
  return fields.filter((f) => _isNonEmptyStr(c[f])).length;
}

/**
 * Count units in a bullet-bearing section (experience or projects).
 * Each entry = 1 unit; each non-empty bullet within it = 1 additional unit.
 *
 * @param {Array|undefined} arr
 * @returns {number}
 */
function _countBulletSectionUnits(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((sum, item) => {
    const bulletCount = Array.isArray(item.bullets)
      ? item.bullets.filter((b) => _isNonEmptyStr(b)).length
      : 0;
    return sum + 1 + bulletCount; // 1 for the entry itself + bullets
  }, 0);
}

/**
 * Count non-empty strings in a flat string array.
 * @param {Array|undefined} arr
 * @returns {number}
 */
function _countStringArrayUnits(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.filter((s) => _isNonEmptyStr(s)).length;
}

// ─── Change counting ──────────────────────────────────────────────────────────

/**
 * Convert a ResumeDiff into per-section changed-unit counts.
 *
 * For item-level sections (experience, projects):
 *   - added items:    counted at bullet granularity (1 per entry + 1 per bullet)
 *   - deleted items:  same
 *   - modified items: each changed scalar field = 1; each added/deleted bullet = 1
 *
 * For simple array sections (education, certifications, display_axes):
 *   - added/deleted items: 1 per item
 *   - modified items: 1 per item (field-level detail is single-unit)
 *
 * For string-set sections (skills.*, strength_keywords):
 *   - 1 per added or deleted string
 *
 * @param {object} diff   ResumeDiff from diffResume().
 * @param {object} prev   Previous profile (used for additional context if needed).
 * @param {object} curr   Current profile.
 * @returns {object} Breakdown with per-section { changed, total } and _totalChanged.
 */
function _computeBreakdown(diff, prev, curr) {
  const contact = _contactChanged(diff.contact);
  const summary = diff.summary.changed ? 1 : 0;
  const experience = _bulletSectionChanged(diff.experience);
  const education = _simpleArrayChanged(diff.education);
  const skillsTechnical = _stringSetChanged(diff.skills?.technical);
  const skillsLanguages = _stringSetChanged(diff.skills?.languages);
  const skillsTools = _stringSetChanged(diff.skills?.tools);
  const projects = _bulletSectionChanged(diff.projects);
  const certifications = _simpleArrayChanged(diff.certifications);
  const strengthKeywords = _stringSetChanged(diff.strength_keywords);
  const displayAxes = _simpleArrayChanged(diff.display_axes);

  const _totalChanged =
    contact +
    summary +
    experience +
    education +
    skillsTechnical +
    skillsLanguages +
    skillsTools +
    projects +
    certifications +
    strengthKeywords +
    displayAxes;

  return {
    contact: { changed: contact },
    summary: { changed: summary },
    experience: { changed: experience },
    education: { changed: education },
    skillsTechnical: { changed: skillsTechnical },
    skillsLanguages: { changed: skillsLanguages },
    skillsTools: { changed: skillsTools },
    projects: { changed: projects },
    certifications: { changed: certifications },
    strengthKeywords: { changed: strengthKeywords },
    displayAxes: { changed: displayAxes },
    _totalChanged
  };
}

/**
 * Count changed contact field units.
 * @param {object} contactDiff
 * @returns {number}
 */
function _contactChanged(contactDiff) {
  if (!contactDiff) return 0;
  return (
    Object.keys(contactDiff.added ?? {}).length +
    Object.keys(contactDiff.modified ?? {}).length +
    Object.keys(contactDiff.deleted ?? {}).length
  );
}

/**
 * Count changed units for a bullet-bearing section (experience / projects).
 *
 * Added/deleted items: 1 (entry) + count(bullets).
 * Modified items: 1 per changed scalar field + 1 per added/deleted bullet.
 *
 * @param {object} sectionDiff  ArraySectionDiff
 * @returns {number}
 */
function _bulletSectionChanged(sectionDiff) {
  if (!sectionDiff) return 0;
  let count = 0;

  // Fully added items
  for (const item of sectionDiff.added ?? []) {
    count += 1 + (Array.isArray(item.bullets) ? item.bullets.filter(_isNonEmptyStr).length : 0);
  }

  // Fully deleted items
  for (const item of sectionDiff.deleted ?? []) {
    count += 1 + (Array.isArray(item.bullets) ? item.bullets.filter(_isNonEmptyStr).length : 0);
  }

  // Modified items — count changed fields inside fieldDiffs
  for (const modEntry of sectionDiff.modified ?? []) {
    const fd = modEntry.fieldDiffs ?? {};

    // Scalar fields that may change
    const scalarFields = ["company", "title", "start_date", "end_date", "location", "name", "description", "url", "institution", "degree", "field", "gpa", "issuer", "date"];
    for (const f of scalarFields) {
      if (fd[f]) count++;
    }

    // Bullet-level changes
    if (fd.bullets) {
      count += (fd.bullets.added?.length ?? 0) + (fd.bullets.deleted?.length ?? 0);
    }
  }

  return count;
}

/**
 * Count changed units for simple array sections (education, certifications,
 * display_axes) where each item is treated as a single atomic unit.
 *
 * @param {object} sectionDiff  ArraySectionDiff
 * @returns {number}
 */
function _simpleArrayChanged(sectionDiff) {
  if (!sectionDiff) return 0;
  return (
    (sectionDiff.added?.length ?? 0) +
    (sectionDiff.deleted?.length ?? 0) +
    (sectionDiff.modified?.length ?? 0)
  );
}

/**
 * Count changed units for string-set sections (skills.*, strength_keywords).
 *
 * @param {object} stringArrayDiff  StringArrayDiff { added, deleted }
 * @returns {number}
 */
function _stringSetChanged(stringArrayDiff) {
  if (!stringArrayDiff) return 0;
  return (stringArrayDiff.added?.length ?? 0) + (stringArrayDiff.deleted?.length ?? 0);
}

// ─── Edge-case delta builders ─────────────────────────────────────────────────

/**
 * Return an empty DeltaReport (rate 0, no changes).
 * @returns {DeltaReport}
 */
function _emptyDelta() {
  return {
    rate: 0,
    changedUnits: 0,
    totalUnits: 0,
    isEmpty: true,
    breakdown: {
      contact: { changed: 0 },
      summary: { changed: 0 },
      experience: { changed: 0 },
      education: { changed: 0 },
      skillsTechnical: { changed: 0 },
      skillsLanguages: { changed: 0 },
      skillsTools: { changed: 0 },
      projects: { changed: 0 },
      certifications: { changed: 0 },
      strengthKeywords: { changed: 0 },
      displayAxes: { changed: 0 }
    }
  };
}

/**
 * Return a DeltaReport treating all units in a single profile as "changed"
 * (used when the other profile is null — everything is new or everything is gone).
 *
 * @param {object} profile
 * @returns {DeltaReport}
 */
function _fullDelta(profile) {
  const units = _countUnits(profile);
  const total = units.total;

  return {
    rate: total > 0 ? 1 : 0,
    changedUnits: total,
    totalUnits: total,
    isEmpty: total === 0,
    breakdown: {
      contact: { changed: units.contact },
      summary: { changed: units.summary },
      experience: { changed: units.experience },
      education: { changed: units.education },
      skillsTechnical: { changed: units.skillsTechnical },
      skillsLanguages: { changed: units.skillsLanguages },
      skillsTools: { changed: units.skillsTools },
      projects: { changed: units.projects },
      certifications: { changed: units.certifications },
      strengthKeywords: { changed: units.strengthKeywords },
      displayAxes: { changed: units.displayAxes }
    }
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Return true when a value is a non-empty string (after trim).
 * @param {unknown} v
 * @returns {boolean}
 */
function _isNonEmptyStr(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Round a floating-point rate to 4 decimal places.
 * @param {number} n
 * @returns {number}
 */
function _round(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Strip the internal `_totalChanged` key from the breakdown object before
 * including it in the public DeltaReport.
 *
 * @param {object} breakdown
 * @returns {object}
 */
function _omitInternal(breakdown) {
  const { _totalChanged: _, ...rest } = breakdown;
  return rest;
}

// ─── JSDoc type definitions ───────────────────────────────────────────────────

/**
 * @typedef {Object} SectionBreakdownEntry
 * @property {number} changed  Number of atomic units changed in this section.
 */

/**
 * @typedef {Object} DeltaBreakdown
 * @property {SectionBreakdownEntry} contact
 * @property {SectionBreakdownEntry} summary
 * @property {SectionBreakdownEntry} experience
 * @property {SectionBreakdownEntry} education
 * @property {SectionBreakdownEntry} skillsTechnical
 * @property {SectionBreakdownEntry} skillsLanguages
 * @property {SectionBreakdownEntry} skillsTools
 * @property {SectionBreakdownEntry} projects
 * @property {SectionBreakdownEntry} certifications
 * @property {SectionBreakdownEntry} strengthKeywords
 * @property {SectionBreakdownEntry} displayAxes
 */

/**
 * @typedef {Object} DeltaReport
 * @property {number}        rate          Change rate in [0.0, 1.0].
 * @property {number}        changedUnits  Total count of changed atomic units.
 * @property {number}        totalUnits    Denominator used for rate calculation.
 * @property {boolean}       isEmpty       true when changedUnits === 0.
 * @property {DeltaBreakdown} breakdown    Per-section changed unit counts.
 */
