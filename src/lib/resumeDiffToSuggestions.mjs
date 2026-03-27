/**
 * Resume Diff → Suggestions converter (work_log source).
 *
 * Converts a ResumeDiff object (from resumeDiff.mjs) into pending SuggestionItem
 * objects that are compatible with the suggestions storage format and the
 * applySuggestionPatch helper in src/routes/resume.mjs.
 *
 * This module is the work_log counterpart to resumeSuggestions.mjs (which handles
 * the linkedin source).  It is called by the POST /api/resume/generate-candidates
 * endpoint after diffing the existing resume against the proposed (merged) resume.
 *
 * Proposal granularity guarantee (AC 7-2):
 *   Every emitted suggestion targets EXACTLY ONE bullet.  No proposal may span
 *   multiple bullets or a whole section.  This is enforced by:
 *     • add_experience:  entry skeleton only (bullets: []) — each bullet becomes
 *                        a separate append_bullet proposal
 *     • append_bullet:   one per new/added bullet  (experience or project)
 *     • delete_bullet:   one per removed bullet    (experience or project)
 *     • replace_bullet:  one per similar deleted+added pair (fuzzy matched)
 *     • add_skills:      skills are not bullets; batch is acceptable
 *     • update_summary:  summary is a single text field; one proposal is correct
 *
 * Conversion rules:
 *   summary.added               → update_summary suggestion
 *   experience.added entries    → add_experience (skeleton) + append_bullet × N
 *   experience.modified bullets → replace_bullet (fuzzy pairs), append_bullet (unpaired adds),
 *                                  delete_bullet (unpaired deletes)
 *   projects.modified bullets   → replace_bullet / append_bullet / delete_bullet (same rules)
 *   skills.*.added (any cat)    → add_skills suggestion (all new skills batched)
 *
 * No external dependencies.
 */

import { randomUUID } from "node:crypto";

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert a ResumeDiff (from diffResume) into pending work_log SuggestionItems.
 *
 * Every returned item targets at most one bullet point.  Multi-bullet diffs are
 * decomposed into multiple single-bullet items before being returned.
 *
 * @param {import('./resumeDiff.mjs').ResumeDiff} diff
 *   Output of diffResume(existingResume, proposedResume).
 * @param {string} logDate
 *   ISO date string (YYYY-MM-DD) of the work log used to generate the diff.
 * @returns {object[]}  Array of SuggestionItem objects with status: "pending"
 */
export function diffToSuggestions(diff, logDate) {
  if (!diff || diff.isEmpty) return [];

  const now = new Date().toISOString();
  const dateLabel = logDate || now.slice(0, 10);
  const detail = `${dateLabel} 업무 로그 기반`;
  const suggestions = [];

  // ── Summary ─────────────────────────────────────────────────────────────────
  // Only suggest when the existing resume had NO summary and the proposed doc adds one.
  // Work-log data is additive-only: we never propose changes to an existing summary
  // because the summary is high-signal user-owned content.
  if (diff.summary?.added && diff.summary.next) {
    const preview = _truncate(diff.summary.next, 60);

    suggestions.push({
      id: randomUUID(),
      type: "work_log_update",
      section: "summary",
      action: "update_summary",
      description: `개요 업데이트: ${preview}`,
      detail,
      patch: { text: diff.summary.next },
      source: "work_log",
      logDate: dateLabel,
      createdAt: now,
      status: "pending"
    });
  }

  // ── Experience: new entries ─────────────────────────────────────────────────
  //
  // AC 7-2 bullet-granularity rule:
  //   The add_experience proposal carries the SKELETON only (bullets: []).
  //   Each bullet in the new entry is emitted as a SEPARATE append_bullet
  //   proposal so the user can approve/discard each bullet independently.
  for (const entry of diff.experience?.added ?? []) {
    const label = [entry.title, entry.company].filter(Boolean).join(" @ ");
    if (!label) continue;

    // Skeleton proposal — no bullets (bullets must each be their own proposal)
    suggestions.push({
      id: randomUUID(),
      type: "work_log_update",
      section: "experience",
      action: "add_experience",
      description: label,
      detail,
      patch: {
        entry: {
          company: String(entry.company ?? ""),
          title: String(entry.title ?? ""),
          start_date: entry.start_date ?? null,
          end_date: entry.end_date ?? null,
          location: entry.location ?? null,
          bullets: []           // ← intentionally empty; see below
        }
      },
      source: "work_log",
      logDate: dateLabel,
      createdAt: now,
      status: "pending"
    });

    // One append_bullet proposal per bullet in the new entry
    const rawBullets = Array.isArray(entry.bullets) ? entry.bullets : [];
    for (const bullet of rawBullets) {
      const trimmedBullet = String(bullet || "").trim();
      if (!trimmedBullet) continue;

      suggestions.push({
        id: randomUUID(),
        type: "work_log_update",
        section: "experience",
        action: "append_bullet",
        description: `${entry.company}: ${_truncate(trimmedBullet, 80)}`,
        detail,
        patch: {
          company: String(entry.company ?? ""),
          bullet: trimmedBullet
        },
        source: "work_log",
        logDate: dateLabel,
        createdAt: now,
        status: "pending"
      });
    }
  }

  // ── Experience: modified entries — bullet-granularity proposals ──────────────
  //
  // For each modified experience entry, we inspect bullet-level changes:
  //   1. Pair similar deleted+added bullets → replace_bullet (fuzzy similarity ≥ 0.5)
  //   2. Remaining adds → append_bullet  (one per bullet)
  //   3. Remaining deletes → delete_bullet (one per bullet)
  for (const mod of diff.experience?.modified ?? []) {
    const { next: entry, fieldDiffs } = mod;
    const bulletsDiff = fieldDiffs?.bullets;
    if (!bulletsDiff) continue;

    const addedBullets = Array.isArray(bulletsDiff.added) ? bulletsDiff.added : [];
    const deletedBullets = Array.isArray(bulletsDiff.deleted) ? bulletsDiff.deleted : [];

    const { replaced, remainingAdded, remainingDeleted } =
      _pairBullets(deletedBullets, addedBullets);

    // replace_bullet — one per fuzzy pair
    for (const pair of replaced) {
      suggestions.push({
        id: randomUUID(),
        type: "work_log_update",
        section: "experience",
        action: "replace_bullet",
        description: `${entry.company}: 불릿 수정 — ${_truncate(pair.newBullet, 60)}`,
        detail,
        patch: {
          section: "experience",
          company: String(entry.company ?? ""),
          oldBullet: pair.oldBullet,
          newBullet: pair.newBullet
        },
        source: "work_log",
        logDate: dateLabel,
        createdAt: now,
        status: "pending"
      });
    }

    // append_bullet — one per unpaired added bullet
    for (const bullet of remainingAdded) {
      const trimmedBullet = String(bullet || "").trim();
      if (!trimmedBullet) continue;

      suggestions.push({
        id: randomUUID(),
        type: "work_log_update",
        section: "experience",
        action: "append_bullet",
        description: `${entry.company}: ${_truncate(trimmedBullet, 80)}`,
        detail,
        patch: {
          company: String(entry.company ?? ""),
          bullet: trimmedBullet
        },
        source: "work_log",
        logDate: dateLabel,
        createdAt: now,
        status: "pending"
      });
    }

    // delete_bullet — one per unpaired deleted bullet
    for (const bullet of remainingDeleted) {
      const trimmedBullet = String(bullet || "").trim();
      if (!trimmedBullet) continue;

      suggestions.push({
        id: randomUUID(),
        type: "work_log_update",
        section: "experience",
        action: "delete_bullet",
        description: `${entry.company}: 불릿 삭제 — ${_truncate(trimmedBullet, 60)}`,
        detail,
        patch: {
          section: "experience",
          company: String(entry.company ?? ""),
          bullet: trimmedBullet
        },
        source: "work_log",
        logDate: dateLabel,
        createdAt: now,
        status: "pending"
      });
    }
  }

  // ── Projects: modified entries — bullet-granularity proposals ────────────────
  //
  // Same fuzzy-pairing logic as experience:
  //   similar deleted+added pairs → replace_bullet
  //   unpaired adds               → append_bullet  (section: "projects")
  //   unpaired deletes            → delete_bullet  (section: "projects")
  for (const mod of diff.projects?.modified ?? []) {
    const { next: project, fieldDiffs } = mod;
    const bulletsDiff = fieldDiffs?.bullets;
    if (!bulletsDiff) continue;

    const addedBullets = Array.isArray(bulletsDiff.added) ? bulletsDiff.added : [];
    const deletedBullets = Array.isArray(bulletsDiff.deleted) ? bulletsDiff.deleted : [];
    const projectName = String(project.name ?? "");

    const { replaced, remainingAdded, remainingDeleted } =
      _pairBullets(deletedBullets, addedBullets);

    // replace_bullet
    for (const pair of replaced) {
      suggestions.push({
        id: randomUUID(),
        type: "work_log_update",
        section: "projects",
        action: "replace_bullet",
        description: `${projectName}: 불릿 수정 — ${_truncate(pair.newBullet, 60)}`,
        detail,
        patch: {
          section: "projects",
          projectName,
          oldBullet: pair.oldBullet,
          newBullet: pair.newBullet
        },
        source: "work_log",
        logDate: dateLabel,
        createdAt: now,
        status: "pending"
      });
    }

    // append_bullet (section: projects)
    for (const bullet of remainingAdded) {
      const trimmedBullet = String(bullet || "").trim();
      if (!trimmedBullet) continue;

      suggestions.push({
        id: randomUUID(),
        type: "work_log_update",
        section: "projects",
        action: "append_bullet",
        description: `${projectName}: ${_truncate(trimmedBullet, 80)}`,
        detail,
        patch: {
          section: "projects",
          projectName,
          bullet: trimmedBullet
        },
        source: "work_log",
        logDate: dateLabel,
        createdAt: now,
        status: "pending"
      });
    }

    // delete_bullet
    for (const bullet of remainingDeleted) {
      const trimmedBullet = String(bullet || "").trim();
      if (!trimmedBullet) continue;

      suggestions.push({
        id: randomUUID(),
        type: "work_log_update",
        section: "projects",
        action: "delete_bullet",
        description: `${projectName}: 불릿 삭제 — ${_truncate(trimmedBullet, 60)}`,
        detail,
        patch: {
          section: "projects",
          projectName,
          bullet: trimmedBullet
        },
        source: "work_log",
        logDate: dateLabel,
        createdAt: now,
        status: "pending"
      });
    }
  }

  // ── Skills: new skills (all categories) ────────────────────────────────────
  // Batch all newly added skills across technical / languages / tools into a
  // single add_skills suggestion so the user approves the batch at once.
  // Skills are not bullets — batching is intentional and does not violate the
  // bullet-granularity constraint.
  const allNewSkills = [];
  for (const category of /** @type {const} */ (["technical", "languages", "tools"])) {
    for (const skill of diff.skills?.[category]?.added ?? []) {
      const trimmed = String(skill || "").trim();
      if (trimmed) allNewSkills.push(trimmed);
    }
  }

  if (allNewSkills.length > 0) {
    const preview = allNewSkills.slice(0, 3).join(", ");
    const extra =
      allNewSkills.length > 3 ? ` 외 ${allNewSkills.length - 3}개` : "";

    suggestions.push({
      id: randomUUID(),
      type: "work_log_update",
      section: "skills",
      action: "add_skills",
      description: `기술 추가: ${preview}${extra}`,
      detail,
      patch: { skills: allNewSkills },
      source: "work_log",
      logDate: dateLabel,
      createdAt: now,
      status: "pending"
    });
  }

  return suggestions;
}

// ─── Deduplication ─────────────────────────────────────────────────────────────

/**
 * Filter out new suggestions that are semantically equivalent to an existing
 * pending suggestion.
 *
 * Deduplication key per action type:
 *   update_summary  → action (one summary suggestion at a time)
 *   add_experience  → action + company
 *   append_bullet   → action + section(experience default) + company/projectName + normalised bullet text
 *   delete_bullet   → action + section + company/projectName + normalised bullet text
 *   replace_bullet  → action + section + company/projectName + normalised oldBullet text
 *   add_skills      → action (skills are merged by set inclusion below)
 *
 * For add_skills: new skills that are already covered by an existing pending
 * add_skills suggestion are removed from the batch.
 *
 * @param {object[]} existingSuggestions   Already-stored suggestions (any status)
 * @param {object[]} newSuggestions        Candidates to be filtered
 * @returns {object[]}                     De-duplicated new suggestions to append
 */
export function deduplicateWorkLogSuggestions(existingSuggestions, newSuggestions) {
  if (!Array.isArray(newSuggestions) || newSuggestions.length === 0) return [];

  const existing = Array.isArray(existingSuggestions) ? existingSuggestions : [];

  // Build lookup structures for each deduplicated action type
  const pendingOnly = existing.filter((s) => s.status === "pending");

  const hasSummary = pendingOnly.some(
    (s) => s.action === "update_summary" || s.action === "add_summary"
  );

  const existingExperienceKeys = new Set(
    pendingOnly
      .filter((s) => s.action === "add_experience")
      .map((s) => _normalizeStr(s.patch?.entry?.company ?? ""))
      .filter(Boolean)
  );

  // Unified bullet dedup key: `action::section::entity_id::bullet_text`
  // For append_bullet: section defaults to "experience" when not specified (backwards compat)
  const existingBulletKeys = new Set(
    pendingOnly
      .filter((s) => s.action === "append_bullet")
      .map((s) => {
        const section = _normalizeStr(s.patch?.section ?? "experience");
        const entityId = _normalizeStr(s.patch?.company ?? s.patch?.projectName ?? "");
        const bullet = _normalizeStr(s.patch?.bullet ?? "");
        return `append_bullet::${section}::${entityId}::${bullet}`;
      })
      .filter((k) => !k.endsWith("::::"))
  );

  const existingDeleteKeys = new Set(
    pendingOnly
      .filter((s) => s.action === "delete_bullet")
      .map((s) => {
        const section = _normalizeStr(s.patch?.section ?? "experience");
        const entityId = _normalizeStr(s.patch?.company ?? s.patch?.projectName ?? "");
        const bullet = _normalizeStr(s.patch?.bullet ?? "");
        return `delete_bullet::${section}::${entityId}::${bullet}`;
      })
      .filter((k) => !k.endsWith("::::"))
  );

  const existingReplaceKeys = new Set(
    pendingOnly
      .filter((s) => s.action === "replace_bullet")
      .map((s) => {
        const section = _normalizeStr(s.patch?.section ?? "experience");
        const entityId = _normalizeStr(s.patch?.company ?? s.patch?.projectName ?? "");
        const oldBullet = _normalizeStr(s.patch?.oldBullet ?? "");
        return `replace_bullet::${section}::${entityId}::${oldBullet}`;
      })
      .filter((k) => !k.endsWith("::::"))
  );

  // Collect all skills already covered by pending add_skills suggestions
  const existingSkillsNorm = new Set();
  for (const s of pendingOnly) {
    if (s.action === "add_skills" && Array.isArray(s.patch?.skills)) {
      for (const skill of s.patch.skills) {
        existingSkillsNorm.add(_normalizeStr(skill));
      }
    }
  }

  const filtered = [];

  for (const s of newSuggestions) {
    switch (s.action) {
      case "update_summary":
      case "add_summary":
        if (!hasSummary) filtered.push(s);
        break;

      case "add_experience": {
        const key = _normalizeStr(s.patch?.entry?.company ?? "");
        if (key && !existingExperienceKeys.has(key)) {
          existingExperienceKeys.add(key); // prevent duplicates within newSuggestions too
          filtered.push(s);
        }
        break;
      }

      case "append_bullet": {
        const section = _normalizeStr(s.patch?.section ?? "experience");
        const entityId = _normalizeStr(s.patch?.company ?? s.patch?.projectName ?? "");
        const bullet = _normalizeStr(s.patch?.bullet ?? "");
        const key = `append_bullet::${section}::${entityId}::${bullet}`;
        if (entityId && bullet && !existingBulletKeys.has(key)) {
          existingBulletKeys.add(key);
          filtered.push(s);
        }
        break;
      }

      case "delete_bullet": {
        const section = _normalizeStr(s.patch?.section ?? "experience");
        const entityId = _normalizeStr(s.patch?.company ?? s.patch?.projectName ?? "");
        const bullet = _normalizeStr(s.patch?.bullet ?? "");
        const key = `delete_bullet::${section}::${entityId}::${bullet}`;
        if (entityId && bullet && !existingDeleteKeys.has(key)) {
          existingDeleteKeys.add(key);
          filtered.push(s);
        }
        break;
      }

      case "replace_bullet": {
        const section = _normalizeStr(s.patch?.section ?? "experience");
        const entityId = _normalizeStr(s.patch?.company ?? s.patch?.projectName ?? "");
        const oldBullet = _normalizeStr(s.patch?.oldBullet ?? "");
        const key = `replace_bullet::${section}::${entityId}::${oldBullet}`;
        if (entityId && oldBullet && !existingReplaceKeys.has(key)) {
          existingReplaceKeys.add(key);
          filtered.push(s);
        }
        break;
      }

      case "add_skills": {
        // Remove skills already covered; keep suggestion only if any are new
        const uncovered = (s.patch?.skills ?? []).filter(
          (sk) => !existingSkillsNorm.has(_normalizeStr(sk))
        );
        if (uncovered.length > 0) {
          const preview = uncovered.slice(0, 3).join(", ");
          const extra =
            uncovered.length > 3 ? ` 외 ${uncovered.length - 3}개` : "";

          for (const sk of uncovered) existingSkillsNorm.add(_normalizeStr(sk));

          filtered.push({
            ...s,
            description: `기술 추가: ${preview}${extra}`,
            patch: { skills: uncovered }
          });
        }
        break;
      }

      default:
        filtered.push(s);
    }
  }

  return filtered;
}

// ─── Bullet pairing (replace_bullet detection) ─────────────────────────────────

/**
 * Pair deleted and added bullets from the same entry into (old, new) pairs
 * when their textual similarity exceeds the given threshold.
 *
 * Algorithm:
 *   For each deleted bullet, find the best-matching added bullet (highest
 *   word-overlap similarity that exceeds the threshold and is not already
 *   claimed by another pair).  Unmatched items are returned as remainders.
 *
 * @param {string[]} deleted     Bullets removed from the entry.
 * @param {string[]} added       Bullets added to the entry.
 * @param {number}  [threshold]  Minimum similarity score [0,1] to form a pair.
 *                               Defaults to 0.5 (50% word overlap).
 * @returns {{ replaced: Array<{oldBullet:string, newBullet:string}>,
 *             remainingDeleted: string[],
 *             remainingAdded: string[] }}
 */
function _pairBullets(deleted, added, threshold = 0.5) {
  const usedDeletedIdx = new Set();
  const usedAddedIdx = new Set();
  const replaced = [];

  for (let di = 0; di < deleted.length; di++) {
    let bestScore = threshold; // strictly greater-than threshold to form a pair
    let bestAi = -1;

    for (let ai = 0; ai < added.length; ai++) {
      if (usedAddedIdx.has(ai)) continue;
      const score = _bulletSimilarity(deleted[di], added[ai]);
      if (score > bestScore) {
        bestScore = score;
        bestAi = ai;
      }
    }

    if (bestAi >= 0) {
      replaced.push({ oldBullet: deleted[di], newBullet: added[bestAi] });
      usedDeletedIdx.add(di);
      usedAddedIdx.add(bestAi);
    }
  }

  return {
    replaced,
    remainingDeleted: deleted.filter((_, i) => !usedDeletedIdx.has(i)),
    remainingAdded: added.filter((_, i) => !usedAddedIdx.has(i))
  };
}

/**
 * Compute word-overlap similarity between two bullet strings.
 *
 * Uses a Jaccard-like score over lowercased words longer than 3 characters
 * (ignoring stopword-length tokens).  Score is in [0, 1].
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _bulletSimilarity(a, b) {
  const wordsA = _significantWords(a);
  const wordsB = _significantWords(b);
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let common = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) common++;
  }
  return common / Math.max(wordsA.size, wordsB.size);
}

/**
 * Extract a Set of "significant" lowercase word tokens (length > 3) from a string.
 *
 * @param {string} str
 * @returns {Set<string>}
 */
function _significantWords(str) {
  return new Set(
    String(str || "")
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((w) => w.length > 3)
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function _truncate(str, max) {
  if (!str) return "";
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function _normalizeStr(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .toLowerCase()
    .trim()
    .replace(/[.,\-–—&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
