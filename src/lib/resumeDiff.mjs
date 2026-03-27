/**
 * Resume Diff — rule-based JSON comparison utility.
 *
 * Compares a previous resume document with a new candidate document and
 * returns a structured diff object describing field-level changes across
 * every section of the fixed minimal-section schema.
 *
 * Design principles:
 *   • Pure function — no side effects, no external I/O, no mutations.
 *   • Rule-based — deterministic; no LLM calls.
 *   • Provenance-aware — items with _source:"user" are flagged so callers
 *     can treat them with higher priority (user edits always win).
 *   • Self-contained — no imports from other project modules.
 *
 * Matching keys per array section:
 *   experience      → company name (primary) + title (secondary)
 *   education       → institution name
 *   projects        → project name
 *   certifications  → certification name
 *   display_axes    → axis label
 *   skills / strength_keywords → set-based (no identity key, just add/delete)
 *
 * @module resumeDiff
 */

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute a field-level diff between two resume documents.
 *
 * Both arguments must be valid resume document objects (non-null plain
 * objects).  Passing null / undefined for either argument is safe — the
 * function returns an empty diff with `isEmpty: true`.
 *
 * @param {object|null|undefined} prevDoc  Currently stored resume document.
 * @param {object|null|undefined} nextDoc  Newly generated / candidate document.
 * @returns {ResumeDiff}
 */
export function diffResume(prevDoc, nextDoc) {
  if (!prevDoc || typeof prevDoc !== "object") {
    return _emptyDiff();
  }
  if (!nextDoc || typeof nextDoc !== "object") {
    return _emptyDiff();
  }

  const diff = {
    contact: diffContact(prevDoc.contact, nextDoc.contact),
    summary: diffSummary(prevDoc.summary, nextDoc.summary),
    experience: diffArraySection(
      prevDoc.experience,
      nextDoc.experience,
      experienceKey,
      diffExperienceItem
    ),
    education: diffArraySection(
      prevDoc.education,
      nextDoc.education,
      educationKey,
      diffEducationItem
    ),
    skills: diffSkills(prevDoc.skills, nextDoc.skills),
    projects: diffArraySection(
      prevDoc.projects,
      nextDoc.projects,
      projectKey,
      diffProjectItem
    ),
    certifications: diffArraySection(
      prevDoc.certifications,
      nextDoc.certifications,
      certificationKey,
      diffCertificationItem
    ),
    strength_keywords: diffStringArray(
      prevDoc.strength_keywords,
      nextDoc.strength_keywords
    ),
    display_axes: diffArraySection(
      prevDoc.display_axes,
      nextDoc.display_axes,
      axisKey,
      diffAxisItem
    )
  };

  diff.isEmpty = _isEmptyDiff(diff);
  return diff;
}

// ─── Section diffing ───────────────────────────────────────────────────────────

/**
 * Diff the contact block field by field.
 *
 * @param {object|undefined} prev
 * @param {object|undefined} next
 * @returns {ContactDiff}
 */
function diffContact(prev, next) {
  const p = prev && typeof prev === "object" ? prev : {};
  const n = next && typeof next === "object" ? next : {};

  /** @type {ContactDiff} */
  const result = { added: {}, modified: {}, deleted: {} };

  const fields = ["name", "email", "phone", "location", "website", "linkedin"];

  for (const field of fields) {
    const pVal = _nullableStr(p[field]);
    const nVal = _nullableStr(n[field]);

    if (pVal === nVal) continue; // unchanged

    if (!pVal && nVal !== null) {
      result.added[field] = nVal;
    } else if (pVal !== null && !nVal) {
      result.deleted[field] = pVal;
    } else if (pVal !== null && nVal !== null && pVal !== nVal) {
      result.modified[field] = { prev: pVal, next: nVal };
    }
  }

  result.isEmpty =
    _isEmptyObj(result.added) &&
    _isEmptyObj(result.modified) &&
    _isEmptyObj(result.deleted);

  return result;
}

/**
 * Diff the summary string.
 *
 * @param {string|undefined} prev
 * @param {string|undefined} next
 * @returns {SummaryDiff}
 */
function diffSummary(prev, next) {
  const p = typeof prev === "string" ? prev.trim() : "";
  const n = typeof next === "string" ? next.trim() : "";

  if (p === n) return { changed: false, prev: p, next: n };

  if (!p && n) return { changed: true, added: true, prev: "", next: n };
  if (p && !n) return { changed: true, deleted: true, prev: p, next: "" };
  return { changed: true, prev: p, next: n };
}

/**
 * Generic array section diff — matches items by identity key, then runs a
 * per-item field diff for matched pairs.
 *
 * @template T
 * @param {T[]|undefined} prevArr
 * @param {T[]|undefined} nextArr
 * @param {function(T): string} keyFn  Stable identity key extractor.
 * @param {function(T, T): object} itemDiffFn  Per-item field-level differ.
 * @returns {ArraySectionDiff<T>}
 */
function diffArraySection(prevArr, nextArr, keyFn, itemDiffFn) {
  const prev = Array.isArray(prevArr) ? prevArr : [];
  const next = Array.isArray(nextArr) ? nextArr : [];

  /** @type {Map<string, object>} */
  const prevMap = new Map();
  for (const item of prev) {
    const key = keyFn(item);
    if (key) prevMap.set(key, item);
  }

  /** @type {Map<string, object>} */
  const nextMap = new Map();
  for (const item of next) {
    const key = keyFn(item);
    if (key) nextMap.set(key, item);
  }

  const added = [];
  const modified = [];
  const deleted = [];

  // Items in next but not in prev → added
  for (const [key, nItem] of nextMap) {
    if (!prevMap.has(key)) {
      added.push(nItem);
    }
  }

  // Items in both → run field diff; track as modified only when there are changes
  for (const [key, pItem] of prevMap) {
    if (nextMap.has(key)) {
      const nItem = nextMap.get(key);
      const fieldDiffs = itemDiffFn(pItem, nItem);
      if (!_isEmptyObj(fieldDiffs)) {
        modified.push({
          key,
          prev: pItem,
          next: nItem,
          fieldDiffs,
          userOwned: pItem._source === "user"
        });
      }
    }
  }

  // Items in prev but not in next → deleted
  for (const [key, pItem] of prevMap) {
    if (!nextMap.has(key)) {
      deleted.push(pItem);
    }
  }

  return { added, modified, deleted };
}

/**
 * Diff the skills object (three string-array sub-categories).
 *
 * @param {object|undefined} prev
 * @param {object|undefined} next
 * @returns {SkillsDiff}
 */
function diffSkills(prev, next) {
  const p = prev && typeof prev === "object" ? prev : {};
  const n = next && typeof next === "object" ? next : {};

  return {
    technical: diffStringArray(p.technical, n.technical),
    languages: diffStringArray(p.languages, n.languages),
    tools: diffStringArray(p.tools, n.tools)
  };
}

/**
 * Set-based diff for a flat string array (order-insensitive).
 *
 * @param {string[]|undefined} prev
 * @param {string[]|undefined} next
 * @returns {StringArrayDiff}
 */
function diffStringArray(prev, next) {
  const prevSet = new Map(
    (Array.isArray(prev) ? prev : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .map((s) => [_normalizeStr(s), s])
  );
  const nextSet = new Map(
    (Array.isArray(next) ? next : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .map((s) => [_normalizeStr(s), s])
  );

  const added = [];
  const deleted = [];

  for (const [norm, original] of nextSet) {
    if (!prevSet.has(norm)) added.push(original);
  }
  for (const [norm, original] of prevSet) {
    if (!nextSet.has(norm)) deleted.push(original);
  }

  return { added, deleted };
}

// ─── Per-item field diffing ───────────────────────────────────────────────────

/**
 * Field diff for a single experience entry.
 * Returns an object whose keys are changed field names.
 *
 * @param {object} prev
 * @param {object} next
 * @returns {object}
 */
function diffExperienceItem(prev, next) {
  const diffs = {};
  const scalarFields = ["company", "title", "start_date", "end_date", "location"];

  for (const field of scalarFields) {
    const pVal = _nullableStr(prev[field]);
    const nVal = _nullableStr(next[field]);
    if (pVal !== nVal) {
      diffs[field] = { prev: pVal, next: nVal };
    }
  }

  const bulletsDiff = diffStringArray(prev.bullets, next.bullets);
  if (bulletsDiff.added.length > 0 || bulletsDiff.deleted.length > 0) {
    diffs.bullets = bulletsDiff;
  }

  return diffs;
}

/**
 * Field diff for a single education entry.
 *
 * @param {object} prev
 * @param {object} next
 * @returns {object}
 */
function diffEducationItem(prev, next) {
  const diffs = {};
  const fields = [
    "institution",
    "degree",
    "field",
    "start_date",
    "end_date",
    "gpa"
  ];
  for (const f of fields) {
    const pVal = _nullableStr(prev[f]);
    const nVal = _nullableStr(next[f]);
    if (pVal !== nVal) diffs[f] = { prev: pVal, next: nVal };
  }
  return diffs;
}

/**
 * Field diff for a single project entry.
 *
 * @param {object} prev
 * @param {object} next
 * @returns {object}
 */
function diffProjectItem(prev, next) {
  const diffs = {};
  const scalarFields = ["name", "description", "url"];

  for (const f of scalarFields) {
    const pVal = _nullableStr(prev[f]);
    const nVal = _nullableStr(next[f]);
    if (pVal !== nVal) diffs[f] = { prev: pVal, next: nVal };
  }

  const bulletsDiff = diffStringArray(prev.bullets, next.bullets);
  if (bulletsDiff.added.length > 0 || bulletsDiff.deleted.length > 0) {
    diffs.bullets = bulletsDiff;
  }

  return diffs;
}

/**
 * Field diff for a single certification entry.
 *
 * @param {object} prev
 * @param {object} next
 * @returns {object}
 */
function diffCertificationItem(prev, next) {
  const diffs = {};
  const fields = ["name", "issuer", "date"];
  for (const f of fields) {
    const pVal = _nullableStr(prev[f]);
    const nVal = _nullableStr(next[f]);
    if (pVal !== nVal) diffs[f] = { prev: pVal, next: nVal };
  }
  return diffs;
}

/**
 * Field diff for a single display axis.
 *
 * @param {object} prev
 * @param {object} next
 * @returns {object}
 */
function diffAxisItem(prev, next) {
  const diffs = {};

  for (const f of ["label", "tagline"]) {
    const pVal = _nullableStr(prev[f]);
    const nVal = _nullableStr(next[f]);
    if (pVal !== nVal) diffs[f] = { prev: pVal, next: nVal };
  }

  const skillsDiff = diffStringArray(
    prev.highlight_skills,
    next.highlight_skills
  );
  if (skillsDiff.added.length > 0 || skillsDiff.deleted.length > 0) {
    diffs.highlight_skills = skillsDiff;
  }

  return diffs;
}

// ─── Identity key extractors ──────────────────────────────────────────────────

/**
 * Stable identity key for an experience entry.
 * Primary: normalised company name.  Secondary: + title when company clashes.
 *
 * @param {object} item
 * @returns {string}
 */
function experienceKey(item) {
  const company = _normalizeStr(item.company);
  const title = _normalizeStr(item.title);
  if (!company && !title) return "";
  // Include title to handle same company with multiple roles.
  return company ? `${company}::${title}` : title;
}

/**
 * @param {object} item
 * @returns {string}
 */
function educationKey(item) {
  return _normalizeStr(item.institution);
}

/**
 * @param {object} item
 * @returns {string}
 */
function projectKey(item) {
  return _normalizeStr(item.name);
}

/**
 * @param {object} item
 * @returns {string}
 */
function certificationKey(item) {
  return _normalizeStr(item.name);
}

/**
 * @param {object} item
 * @returns {string}
 */
function axisKey(item) {
  return _normalizeStr(item.label);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Normalise a string for identity comparison:
 * lower-case, trim, collapse whitespace, strip common punctuation variants.
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
 * Return trimmed string value or null for empty / null / undefined.
 *
 * @param {unknown} val
 * @returns {string|null}
 */
function _nullableStr(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s || null;
}

/**
 * Return true when an object has no own enumerable keys.
 *
 * @param {object} obj
 * @returns {boolean}
 */
function _isEmptyObj(obj) {
  return Object.keys(obj).length === 0;
}

/**
 * Return an empty diff result with isEmpty: true.
 *
 * @returns {ResumeDiff}
 */
function _emptyDiff() {
  return {
    contact: { added: {}, modified: {}, deleted: {}, isEmpty: true },
    summary: { changed: false, prev: "", next: "" },
    experience: { added: [], modified: [], deleted: [] },
    education: { added: [], modified: [], deleted: [] },
    skills: {
      technical: { added: [], deleted: [] },
      languages: { added: [], deleted: [] },
      tools: { added: [], deleted: [] }
    },
    projects: { added: [], modified: [], deleted: [] },
    certifications: { added: [], modified: [], deleted: [] },
    strength_keywords: { added: [], deleted: [] },
    display_axes: { added: [], modified: [], deleted: [] },
    isEmpty: true
  };
}

/**
 * Return true when a fully-populated diff object represents no changes.
 *
 * @param {ResumeDiff} diff
 * @returns {boolean}
 */
function _isEmptyDiff(diff) {
  if (!diff.contact.isEmpty) return false;
  if (diff.summary.changed) return false;

  for (const section of [
    "experience",
    "education",
    "projects",
    "certifications",
    "display_axes"
  ]) {
    const s = diff[section];
    if (s.added.length || s.modified.length || s.deleted.length) return false;
  }

  const sk = diff.skills;
  for (const cat of ["technical", "languages", "tools"]) {
    if (sk[cat].added.length || sk[cat].deleted.length) return false;
  }

  const kw = diff.strength_keywords;
  if (kw.added.length || kw.deleted.length) return false;

  return true;
}

// ─── JSDoc type definitions ───────────────────────────────────────────────────

/**
 * @typedef {Object} ContactDiff
 * @property {Object.<string, string>}       added     — fields absent in prev, present in next
 * @property {Object.<string, {prev: string|null, next: string|null}>} modified — fields changed
 * @property {Object.<string, string>}       deleted   — fields present in prev, absent in next
 * @property {boolean}                        isEmpty   — true when no contact changes
 */

/**
 * @typedef {Object} SummaryDiff
 * @property {boolean}      changed    — false when identical
 * @property {boolean}      [added]    — true when prev was empty and next has content
 * @property {boolean}      [deleted]  — true when prev had content and next is empty
 * @property {string}       prev
 * @property {string}       next
 */

/**
 * @typedef {Object} StringArrayDiff
 * @property {string[]} added    — strings present in next but not prev
 * @property {string[]} deleted  — strings present in prev but not next
 */

/**
 * @typedef {Object} SkillsDiff
 * @property {StringArrayDiff} technical
 * @property {StringArrayDiff} languages
 * @property {StringArrayDiff} tools
 */

/**
 * @template T
 * @typedef {Object} ArraySectionDiff
 * @property {T[]}    added     — items in next not matched in prev
 * @property {{key: string, prev: T, next: T, fieldDiffs: object, userOwned: boolean}[]} modified — matched items with changes
 * @property {T[]}    deleted   — items in prev not matched in next
 */

/**
 * @typedef {Object} ResumeDiff
 * @property {ContactDiff}                        contact
 * @property {SummaryDiff}                        summary
 * @property {ArraySectionDiff<object>}           experience
 * @property {ArraySectionDiff<object>}           education
 * @property {SkillsDiff}                         skills
 * @property {ArraySectionDiff<object>}           projects
 * @property {ArraySectionDiff<object>}           certifications
 * @property {StringArrayDiff}                    strength_keywords
 * @property {ArraySectionDiff<object>}           display_axes
 * @property {boolean}                            isEmpty
 */
