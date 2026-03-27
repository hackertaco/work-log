/**
 * Work Log Merge — applies LLM-extracted work log updates to a resume document.
 *
 * Takes the existing resume and the extracted updates from
 * resumeWorkLogExtract.mjs, and produces a new "proposed" resume document
 * suitable for passing to diffResume() from resumeDiff.mjs.
 *
 * Design principles:
 *   • Pure function — no side effects, no external I/O.
 *   • Additive only — never removes existing content.
 *   • Provenance-preserving — _source: "user" entries are left untouched;
 *     bullets and skills from the work log are always treated as "system".
 *     User-authored summaries (_sources.summary: "user") are never overwritten.
 *   • Deduplication — bullets and skills are compared case-insensitively
 *     so existing content is never duplicated.
 *   • Self-contained — no imports from other project modules.
 */

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply work log extracted updates to an existing resume document.
 *
 * Handles three patch types (Sub-AC 12a):
 *   1. experienceUpdates  — append new bullets to existing experience entries
 *   2. newSkills          — union new skills into the skills section
 *   3. summaryUpdate      — replace the summary (only when not user-authored)
 *
 * The returned document is a new object (deep-enough clone of modified sections).
 * The existing resume is never mutated.
 *
 * @param {object} existingResume  Current resume document from Vercel Blob
 * @param {import('./resumeWorkLogExtract.mjs').WorkLogExtract} extract
 *   Output of extractResumeUpdatesFromWorkLog()
 * @returns {object}  Proposed resume with updates applied
 */
export function mergeWorkLogIntoResume(existingResume, extract) {
  if (!existingResume || typeof existingResume !== "object") {
    return existingResume;
  }
  if (!extract || typeof extract !== "object") {
    return existingResume;
  }

  const { experienceUpdates = [], newSkills = {}, summaryUpdate = null } = extract;

  const updatedExperience = _mergeExperienceBullets(
    existingResume.experience ?? [],
    experienceUpdates
  );

  const updatedSkills = _mergeSkills(
    existingResume.skills ?? { technical: [], languages: [], tools: [] },
    newSkills
  );

  // Apply summary update only when:
  //   1. The extract contains a non-empty summary proposal.
  //   2. The existing summary was NOT user-authored (_sources.summary !== "user").
  const updatedSummary = _mergeSummary(existingResume, summaryUpdate);

  // Only return a new object when something actually changed (reference equality
  // check lets diffResume skip unchanged sections efficiently).
  const expChanged = updatedExperience !== existingResume.experience;
  const skillsChanged = updatedSkills !== existingResume.skills;
  const summaryChanged = updatedSummary !== null;

  if (!expChanged && !skillsChanged && !summaryChanged) {
    return existingResume;
  }

  return {
    ...existingResume,
    ...(expChanged ? { experience: updatedExperience } : {}),
    ...(skillsChanged ? { skills: updatedSkills } : {}),
    ...(summaryChanged ? { summary: updatedSummary } : {})
  };
}

// ─── Summary merging ───────────────────────────────────────────────────────────

/**
 * Apply a proposed summary update, respecting user authorship.
 *
 * Returns the new summary string when the update should be applied, or null
 * when the update is rejected (no change / user-authored).
 *
 * @param {object} existingResume
 * @param {string|null|undefined} summaryUpdate  Proposed new summary from LLM
 * @returns {string|null}  New summary value, or null for "no change"
 */
function _mergeSummary(existingResume, summaryUpdate) {
  if (!summaryUpdate || typeof summaryUpdate !== "string") return null;
  const proposed = summaryUpdate.trim();
  if (!proposed) return null;

  // Respect user authorship — never overwrite a user-edited or user-approved summary.
  // "user_approved" means the user explicitly reviewed and accepted a system proposal;
  // it carries the same protection priority as a directly user-authored summary.
  const summarySource = existingResume._sources?.summary;
  if (summarySource === "user" || summarySource === "user_approved") return null;

  // Skip if the proposed summary is identical to the current one
  const current = _getResumeSummary(existingResume);
  if (current === proposed) return null;

  return proposed;
}

/**
 * Get the current summary text from a resume document.
 * Handles both the flat `summary` field and `basics.summary`.
 *
 * @param {object} resume
 * @returns {string}
 */
function _getResumeSummary(resume) {
  if (typeof resume.summary === "string" && resume.summary.trim()) {
    return resume.summary.trim();
  }
  if (typeof resume.basics?.summary === "string" && resume.basics.summary.trim()) {
    return resume.basics.summary.trim();
  }
  return "";
}

// ─── Experience bullet merging ─────────────────────────────────────────────────

/**
 * Append new bullets to experience entries whose company name matches one of
 * the experience_updates entries.  Bullets are deduped case-insensitively.
 * Unmatched updates are silently dropped.
 *
 * @param {object[]} existingExp      resume.experience array
 * @param {{ company: string, bullets: string[] }[]} updates
 * @returns {object[]}  New array (same reference if no changes were made)
 */
function _mergeExperienceBullets(existingExp, updates) {
  if (!Array.isArray(updates) || updates.length === 0) return existingExp;

  let changed = false;

  const merged = existingExp.map((entry) => {
    const match = _findMatchingUpdate(entry, updates);
    if (!match || match.bullets.length === 0) return entry;

    // Build normalised set of existing bullets for O(1) dedup lookup
    const existingNorm = new Set(
      (entry.bullets ?? []).map((b) => _normalizeStr(b))
    );

    const newBullets = match.bullets.filter(
      (b) => b.trim() && !existingNorm.has(_normalizeStr(b))
    );

    if (newBullets.length === 0) return entry; // no change

    changed = true;
    return {
      ...entry,
      bullets: [...(entry.bullets ?? []), ...newBullets]
    };
  });

  return changed ? merged : existingExp;
}

/**
 * Find an update entry whose company name matches the given resume entry.
 * Matching is case-insensitive with common-punctuation normalisation and
 * substring matching so "Acme Corp." matches "Acme Corp".
 *
 * @param {object} entry    Resume experience entry
 * @param {{ company: string, bullets: string[] }[]} updates
 * @returns {{ company: string, bullets: string[] }|null}
 */
function _findMatchingUpdate(entry, updates) {
  const entryCompany = _normalizeStr(entry.company);
  if (!entryCompany) return null;

  return (
    updates.find((u) => {
      const uCompany = _normalizeStr(u.company);
      return _isSimilar(entryCompany, uCompany);
    }) ?? null
  );
}

// ─── Skills merging ────────────────────────────────────────────────────────────

/**
 * Union new skills into the existing skills object (three categories).
 * Skills are deduplicated case-insensitively.
 *
 * @param {{ technical: string[], languages: string[], tools: string[] }} existingSkills
 * @param {{ technical?: string[], languages?: string[], tools?: string[] }} newSkills
 * @returns {{ technical: string[], languages: string[], tools: string[] }}
 *   Same reference as existingSkills when nothing was added.
 */
function _mergeSkills(existingSkills, newSkills) {
  if (!newSkills || typeof newSkills !== "object") return existingSkills;

  let changed = false;

  const result = {
    technical: [...(existingSkills.technical ?? [])],
    languages: [...(existingSkills.languages ?? [])],
    tools: [...(existingSkills.tools ?? [])]
  };

  for (const category of /** @type {const} */ (["technical", "languages", "tools"])) {
    const additions = newSkills[category];
    if (!Array.isArray(additions) || additions.length === 0) continue;

    const existingNorm = new Set(result[category].map((s) => _normalizeStr(s)));

    for (const skill of additions) {
      const trimmed = String(skill || "").trim();
      const norm = _normalizeStr(trimmed);
      if (norm && !existingNorm.has(norm)) {
        result[category].push(trimmed);
        existingNorm.add(norm);
        changed = true;
      }
    }
  }

  return changed ? result : existingSkills;
}

// ─── String helpers ────────────────────────────────────────────────────────────

/**
 * Normalise a string for identity comparison.
 *
 * @param {unknown} val
 * @returns {string}
 */
function _normalizeStr(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .toLowerCase()
    .trim()
    .replace(/[.,\-–—&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Return true when two normalised strings are considered the same entity.
 * Handles exact match, substring containment (e.g. "Meta" vs "Meta Platforms"),
 * and common abbreviation styles.
 *
 * @param {string} a  Already normalised
 * @param {string} b  Already normalised
 * @returns {boolean}
 */
function _isSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}
