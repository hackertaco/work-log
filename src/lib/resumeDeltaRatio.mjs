/**
 * Resume Delta Ratio — threshold guard for merge-candidate generation.
 *
 * Computes the ratio of changed items in a ResumeDiff relative to the total
 * number of addressable items in the existing resume document.  The result is
 * used to gate automatic candidate record creation: when the delta ratio is
 * below the threshold (default 3 %) the diff is considered too minor to
 * produce meaningful merge candidates and the generation step is skipped.
 *
 * Counting granularity (bullet-level):
 *   The same resolution used by resumeDiffToSuggestions is applied here so
 *   that "1 change unit ≈ 1 actionable suggestion".
 *
 *   Total items (denominator):
 *     • summary      — 1 when non-empty
 *     • experience   — sum of bullets per entry (or 1 per entry with no bullets)
 *     • education    — 1 per entry
 *     • projects     — sum of bullets per project (or 1 per project with none)
 *     • certifications — 1 per entry
 *     • skills       — count of individual skill strings (technical + languages + tools)
 *     • strength_keywords — count
 *
 *   Changed items (numerator — from ResumeDiff):
 *     • summary.changed — 1
 *     • experience added   — bullets.length (or 1 if none)
 *     • experience modified — bullets.added + bullets.deleted per entry;
 *                             plus 1 per changed scalar field
 *     • experience deleted — bullets.length (or 1 if none)
 *     • education added/modified/deleted — 1 per entry
 *     • projects (same pattern as experience)
 *     • certifications added/modified/deleted — 1 per entry
 *     • skills categories — added + deleted per category
 *     • strength_keywords — added + deleted
 *
 * Design:
 *   • Pure functions — no side effects, no I/O, no LLM calls.
 *   • Safe denominator — clamps to 1 so ratio never throws a division-by-zero
 *     on an empty resume scaffold.
 *   • Self-contained — no imports from other project modules.
 *
 * @module resumeDeltaRatio
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Default delta threshold: 3 %.
 * When the changed-items ratio is below this value the generate-candidates
 * pipeline skips candidate creation and returns 0 suggestions.
 *
 * @type {number}
 */
export const DELTA_THRESHOLD = 0.03;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Count the total number of addressable items in a resume document at
 * bullet-level granularity.  This value is used as the denominator for the
 * delta ratio.
 *
 * @param {object|null|undefined} resumeDoc  Existing resume document.
 * @returns {number}  Non-negative integer; 0 for null / empty documents.
 */
export function countResumeItems(resumeDoc) {
  if (!resumeDoc || typeof resumeDoc !== "object") return 0;

  let count = 0;

  // Summary: 1 when non-empty
  if (typeof resumeDoc.summary === "string" && resumeDoc.summary.trim()) {
    count += 1;
  }

  // Experience: count individual bullets (floor of 1 per entry when no bullets)
  if (Array.isArray(resumeDoc.experience)) {
    for (const entry of resumeDoc.experience) {
      const bulletCount = Array.isArray(entry.bullets) ? entry.bullets.length : 0;
      count += bulletCount > 0 ? bulletCount : 1;
    }
  }

  // Education: 1 per entry
  if (Array.isArray(resumeDoc.education)) {
    count += resumeDoc.education.length;
  }

  // Projects: count individual bullets (floor of 1 per project when no bullets)
  if (Array.isArray(resumeDoc.projects)) {
    for (const proj of resumeDoc.projects) {
      const bulletCount = Array.isArray(proj.bullets) ? proj.bullets.length : 0;
      count += bulletCount > 0 ? bulletCount : 1;
    }
  }

  // Certifications: 1 per entry
  if (Array.isArray(resumeDoc.certifications)) {
    count += resumeDoc.certifications.length;
  }

  // Skills: count individual skill strings across all three categories
  if (resumeDoc.skills && typeof resumeDoc.skills === "object") {
    const { technical, languages, tools } = resumeDoc.skills;
    count += Array.isArray(technical) ? technical.length : 0;
    count += Array.isArray(languages) ? languages.length : 0;
    count += Array.isArray(tools) ? tools.length : 0;
  }

  // Strength keywords
  if (Array.isArray(resumeDoc.strength_keywords)) {
    count += resumeDoc.strength_keywords.length;
  }

  return count;
}

/**
 * Count the number of changed items captured in a ResumeDiff at bullet-level
 * granularity.  This value is used as the numerator for the delta ratio.
 *
 * @param {object|null|undefined} diff  ResumeDiff from diffResume().
 * @returns {number}  Non-negative integer; 0 for null / empty diffs.
 */
export function countDiffChanges(diff) {
  if (!diff || typeof diff !== "object") return 0;
  if (diff.isEmpty) return 0;

  let count = 0;

  // Summary
  if (diff.summary?.changed) count += 1;

  // Experience
  const exp = diff.experience;
  if (exp) {
    for (const added of (exp.added ?? [])) {
      const bc = Array.isArray(added.bullets) ? added.bullets.length : 0;
      count += bc > 0 ? bc : 1;
    }
    for (const mod of (exp.modified ?? [])) {
      const bDiff = mod.fieldDiffs?.bullets;
      if (bDiff) {
        count += (bDiff.added?.length ?? 0) + (bDiff.deleted?.length ?? 0);
      }
      // Scalar field changes (company, title, dates, location)
      const scalarKeys = Object.keys(mod.fieldDiffs ?? {}).filter(
        (k) => k !== "bullets"
      );
      count += scalarKeys.length;
    }
    for (const deleted of (exp.deleted ?? [])) {
      const bc = Array.isArray(deleted.bullets) ? deleted.bullets.length : 0;
      count += bc > 0 ? bc : 1;
    }
  }

  // Education: 1 per added / modified / deleted entry
  const edu = diff.education;
  if (edu) {
    count +=
      (edu.added?.length ?? 0) +
      (edu.modified?.length ?? 0) +
      (edu.deleted?.length ?? 0);
  }

  // Projects (same bullet-level pattern as experience)
  const proj = diff.projects;
  if (proj) {
    for (const added of (proj.added ?? [])) {
      const bc = Array.isArray(added.bullets) ? added.bullets.length : 0;
      count += bc > 0 ? bc : 1;
    }
    for (const mod of (proj.modified ?? [])) {
      const bDiff = mod.fieldDiffs?.bullets;
      if (bDiff) {
        count += (bDiff.added?.length ?? 0) + (bDiff.deleted?.length ?? 0);
      }
      const scalarKeys = Object.keys(mod.fieldDiffs ?? {}).filter(
        (k) => k !== "bullets"
      );
      count += scalarKeys.length;
    }
    for (const deleted of (proj.deleted ?? [])) {
      const bc = Array.isArray(deleted.bullets) ? deleted.bullets.length : 0;
      count += bc > 0 ? bc : 1;
    }
  }

  // Certifications: 1 per added / modified / deleted entry
  const cert = diff.certifications;
  if (cert) {
    count +=
      (cert.added?.length ?? 0) +
      (cert.modified?.length ?? 0) +
      (cert.deleted?.length ?? 0);
  }

  // Skills: count individual skill string additions and deletions
  const sk = diff.skills;
  if (sk) {
    for (const cat of ["technical", "languages", "tools"]) {
      count +=
        (sk[cat]?.added?.length ?? 0) + (sk[cat]?.deleted?.length ?? 0);
    }
  }

  // Strength keywords
  const kw = diff.strength_keywords;
  if (kw) {
    count += (kw.added?.length ?? 0) + (kw.deleted?.length ?? 0);
  }

  return count;
}

/**
 * Compute the delta ratio for a ResumeDiff relative to an existing resume.
 *
 * @param {object|null|undefined} diff       ResumeDiff from diffResume().
 * @param {object|null|undefined} resumeDoc  Existing resume document.
 * @returns {{ ratio: number, changedCount: number, totalCount: number }}
 *   ratio        — changedCount / max(totalCount, 1), in [0, ∞)
 *   changedCount — number of changed addressable items
 *   totalCount   — number of total addressable items in resumeDoc
 */
export function computeDeltaRatio(diff, resumeDoc) {
  const changedCount = countDiffChanges(diff);
  const totalCount = countResumeItems(resumeDoc);
  const ratio = changedCount / Math.max(totalCount, 1);
  return { ratio, changedCount, totalCount };
}

/**
 * Return true when the diff represents enough change to warrant creating
 * merge candidate records (delta ratio ≥ threshold).
 *
 * @param {object|null|undefined} diff       ResumeDiff from diffResume().
 * @param {object|null|undefined} resumeDoc  Existing resume document.
 * @param {number} [threshold=DELTA_THRESHOLD]  Override the default 3 %.
 * @returns {boolean}
 */
export function exceedsDeltaThreshold(
  diff,
  resumeDoc,
  threshold = DELTA_THRESHOLD
) {
  const { ratio } = computeDeltaRatio(diff, resumeDoc);
  return ratio >= threshold;
}
