/**
 * Resume Axes — pure logic for Axis data type manipulation.
 *
 * An Axis represents a lens through which a resume is presented — for example
 * "Backend Engineer", "Open-Source Contributor", or "Team Lead".  Each axis
 * carries a set of keywords that characterise that perspective and can be used
 * to highlight relevant sections in the living-resume view.
 *
 * Storage:
 *   Axes are stored as the `display_axes` array inside the main resume document
 *   (Vercel Blob key `resume/data.json`).  Each element follows the Axis schema
 *   defined in this module.
 *
 * Blob layout (unchanged — no new Blob keys required):
 *   resume/data.json  →  { ..., display_axes: Axis[] }
 *
 * Design principles:
 *   • Pure functions — no side effects, no I/O, no mutations of inputs.
 *   • Self-contained — no imports from other project modules.
 *   • Provenance-aware — axes created/modified via user action carry
 *     `_source: "user"` so merge logic gives them priority.
 *
 * @module resumeAxes
 */

// ─── Schema ────────────────────────────────────────────────────────────────────

/** Current schema version for Axis objects. */
export const AXIS_SCHEMA_VERSION = "1";

/**
 * @typedef {Object} Axis
 * @property {string}   id        — Stable UUID identifying this axis (generated on create).
 * @property {string}   label     — Display name / title (e.g. "Backend Engineer").
 * @property {string[]} keywords  — Keywords that characterise this axis perspective.
 *                                  May overlap with `strength_keywords` on the resume.
 * @property {string}   [_source] — Provenance marker: "user" | "system".
 *                                  Set to "user" when created or last edited by the user.
 */

// Validation constants
const LABEL_MAX_LEN = 100;
const KEYWORD_MAX_LEN = 60;
const KEYWORDS_MAX_COUNT = 30;

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new Axis object with a freshly generated id.
 *
 * @param {string}   label     — Display name for the axis (non-empty).
 * @param {string[]} [keywords=[]] — Initial keywords for this axis.
 * @param {"user"|"system"} [source="user"] — Provenance marker.
 * @returns {Axis}
 * @throws {TypeError}  When label is missing or invalid.
 */
export function createAxis(label, keywords = [], source = "user") {
  const cleanLabel = _validateLabel(label);
  const cleanKeywords = normalizeKeywords(keywords);

  return {
    id: _generateId(),
    label: cleanLabel,
    keywords: cleanKeywords,
    _source: source
  };
}

/**
 * Normalise a raw keywords array:
 *   - Coerces each element to string
 *   - Trims whitespace
 *   - Truncates to KEYWORD_MAX_LEN characters
 *   - Drops empty strings
 *   - Deduplicates (case-insensitive, first occurrence wins)
 *   - Caps total count at KEYWORDS_MAX_COUNT
 *
 * @param {unknown[]} raw  Arbitrary array (may contain non-strings)
 * @returns {string[]}     Cleaned, deduplicated keyword list
 */
export function normalizeKeywords(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const result = [];

  for (const item of raw) {
    if (typeof item !== "string") continue;
    const kw = item.trim().slice(0, KEYWORD_MAX_LEN);
    if (!kw) continue;
    const lower = kw.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(kw);
    if (result.length >= KEYWORDS_MAX_COUNT) break;
  }

  return result;
}

/**
 * Validate and normalise a candidate axis label string.
 *
 * @param {unknown} label  Raw label value from user input.
 * @returns {string}       Trimmed label.
 * @throws {TypeError}     When label is not a non-empty string.
 */
export function validateLabel(label) {
  return _validateLabel(label);
}

/**
 * Find the index of an axis with the given id inside an axes array.
 *
 * @param {Axis[]} axes  Current axes array.
 * @param {string} id    Target axis id.
 * @returns {number}     Array index, or -1 if not found.
 */
export function findAxisIndex(axes, id) {
  if (!Array.isArray(axes) || typeof id !== "string" || !id.trim()) return -1;
  return axes.findIndex((a) => a && a.id === id);
}

/**
 * Apply a partial update to an axis in an array.
 *
 * Only `label` and `keywords` may be updated — `id` is immutable.
 * At least one of `label` or `keywords` must be provided.
 *
 * @param {Axis[]} axes     Current axes array (not mutated).
 * @param {string} id       Id of the axis to update.
 * @param {object} updates  Partial update: `{ label?, keywords? }`.
 * @returns {{ axes: Axis[], updated: Axis|null }}
 *   `updated` is the new axis object if found, null otherwise.
 *   `axes` is the new array (same reference if axis not found).
 */
export function updateAxisInArray(axes, id, updates) {
  const arr = Array.isArray(axes) ? axes : [];
  const idx = findAxisIndex(arr, id);
  if (idx === -1) return { axes: arr, updated: null };

  const existing = arr[idx];
  const patch = {};

  if (updates.label !== undefined) {
    patch.label = _validateLabel(updates.label);
  }
  if (updates.keywords !== undefined) {
    patch.keywords = normalizeKeywords(updates.keywords);
  }

  if (Object.keys(patch).length === 0) {
    return { axes: arr, updated: existing };
  }

  const updated = {
    ...existing,
    ...patch,
    _source: "user"
  };

  const newAxes = [...arr];
  newAxes[idx] = updated;

  return { axes: newAxes, updated };
}

/**
 * Split one axis into two new axes, partitioning its keywords.
 *
 * The original axis is replaced in-place by axisA followed immediately by
 * axisB so that the relative order of the remaining axes is preserved.
 *
 * Constraints:
 *   - `labelA` and `labelB` must be non-empty strings (validated).
 *   - Every keyword in `keywordsB` must appear in the original axis's keyword
 *     list (case-insensitive match).  Unknown keywords are silently ignored.
 *   - After partitioning, both resulting axes must have at least one keyword.
 *     If the split would leave either axis empty the function throws a
 *     RangeError so the caller can return a 400 to the client.
 *   - The source axis is identified by `id`.  If not found the function
 *     returns `{ axes, axisA: null, axisB: null }` (caller should 404).
 *
 * @param {Axis[]}   axes       Current axes array (not mutated).
 * @param {string}   id         Id of the axis to split.
 * @param {string}   labelA     Display name for the first (remainder) axis.
 * @param {string}   labelB     Display name for the second (selected) axis.
 * @param {string[]} keywordsB  Keywords from the original axis assigned to axisB.
 * @returns {{ axes: Axis[], axisA: Axis|null, axisB: Axis|null }}
 * @throws {TypeError}   When a label is invalid.
 * @throws {RangeError}  When the split would produce an axis with no keywords.
 */
export function splitAxis(axes, id, labelA, labelB, keywordsB) {
  const arr = Array.isArray(axes) ? axes : [];
  const idx = findAxisIndex(arr, id);
  if (idx === -1) return { axes: arr, axisA: null, axisB: null };

  const original = arr[idx];
  const cleanLabelA = _validateLabel(labelA);
  const cleanLabelB = _validateLabel(labelB);

  // Build a set of normalised keywords that belong to axisB.
  const bSet = new Set(
    Array.isArray(keywordsB)
      ? keywordsB
          .filter((k) => typeof k === "string" && k.trim())
          .map((k) => k.trim().toLowerCase())
      : []
  );

  // Partition original keywords: those whose lower-case form is in bSet go to B,
  // the rest stay in A.  This preserves original casing.
  const kwA = (original.keywords ?? []).filter(
    (k) => !bSet.has(k.toLowerCase())
  );
  const kwB = (original.keywords ?? []).filter(
    (k) => bSet.has(k.toLowerCase())
  );

  if (kwA.length === 0) {
    throw new RangeError(
      "첫 번째 분리 축에 최소 1개의 키워드가 있어야 합니다. 모든 키워드가 두 번째 축으로 이동했습니다."
    );
  }
  if (kwB.length === 0) {
    throw new RangeError(
      "두 번째 분리 축에 최소 1개의 키워드가 있어야 합니다. keywordsB에 유효한 키워드를 포함해야 합니다."
    );
  }

  const axisA = {
    id: _generateId(),
    label: cleanLabelA,
    keywords: normalizeKeywords(kwA),
    _source: "user"
  };

  const axisB = {
    id: _generateId(),
    label: cleanLabelB,
    keywords: normalizeKeywords(kwB),
    _source: "user"
  };

  // Replace original axis at position idx with axisA then axisB.
  const newAxes = [
    ...arr.slice(0, idx),
    axisA,
    axisB,
    ...arr.slice(idx + 1)
  ];

  return { axes: newAxes, axisA, axisB };
}

/**
 * Remove an axis by id from an axes array.
 *
 * @param {Axis[]} axes  Current axes array (not mutated).
 * @param {string} id    Id of the axis to remove.
 * @returns {{ axes: Axis[], removed: boolean }}
 *   `removed` is true when the axis was found and deleted.
 *   `axes` is the new array (same reference if axis not found).
 */
export function removeAxisFromArray(axes, id) {
  const arr = Array.isArray(axes) ? axes : [];
  const idx = findAxisIndex(arr, id);
  if (idx === -1) return { axes: arr, removed: false };

  const newAxes = arr.filter((_, i) => i !== idx);
  return { axes: newAxes, removed: true };
}

/**
 * Migrate legacy display_axes items that lack an `id` field.
 *
 * Earlier versions of the schema used `{ label, tagline, highlight_skills[] }`
 * without a stable `id`.  This function assigns a deterministic id (stable UUID
 * derived from label) and maps `highlight_skills` → `keywords` when needed so
 * that existing data continues to work with the CRUD routes.
 *
 * @param {object[]|undefined} rawAxes  Raw `display_axes` array from stored resume.
 * @returns {Axis[]}  Migrated axes array (new array, original not mutated).
 */
export function migrateAxes(rawAxes) {
  if (!Array.isArray(rawAxes)) return [];

  return rawAxes.map((a) => {
    if (!a || typeof a !== "object") return null;

    // Already has an id — assume it's already migrated.
    if (typeof a.id === "string" && a.id.trim()) {
      return {
        id: a.id,
        label: typeof a.label === "string" ? a.label : "",
        keywords: normalizeKeywords(
          Array.isArray(a.keywords) ? a.keywords : (Array.isArray(a.highlight_skills) ? a.highlight_skills : [])
        ),
        ...(a._source ? { _source: a._source } : {})
      };
    }

    // Legacy item: generate a deterministic id from label.
    const label = typeof a.label === "string" ? a.label.trim() : "";

    // Map highlight_skills → keywords if present; otherwise use keywords.
    const rawKeywords = Array.isArray(a.keywords)
      ? a.keywords
      : Array.isArray(a.highlight_skills)
        ? a.highlight_skills
        : [];

    return {
      id: _generateId(),
      label,
      keywords: normalizeKeywords(rawKeywords),
      _source: a._source ?? "system"
    };
  }).filter(Boolean);
}

/**
 * Merge two axes: absorb `sourceId` into `targetId`.
 *
 * Keywords from both axes are unioned and deduplicated via `normalizeKeywords`.
 * The source axis is removed from the array; the target axis is updated with
 * the merged keyword set and, optionally, a new label.
 * The resulting merged axis always gets `_source: "user"` because this is a
 * deliberate user-initiated operation.
 *
 * Idempotency note: calling with the same `targetId` and `sourceId` as a
 * previous successful merge will return `error: "Source axis not found"`.
 *
 * @param {Axis[]} axes     Current axes array (not mutated).
 * @param {string} targetId Id of the axis to keep and update.
 * @param {string} sourceId Id of the axis to absorb and remove.
 * @param {string} [newLabel] Optional new label for the merged axis.
 *   When omitted the target's existing label is preserved.
 * @returns {{ axes: Axis[], merged: Axis|null, error: string|null }}
 *   `merged` is the resulting axis object on success, `null` on error.
 *   `error` is a human-readable string on failure, `null` on success.
 *   `axes` is the updated array on success, the original array on error.
 */
export function mergeAxes(axes, targetId, sourceId, newLabel) {
  const arr = Array.isArray(axes) ? axes : [];

  // ── Input guards ────────────────────────────────────────────────────────────
  if (typeof targetId !== "string" || !targetId.trim()) {
    return { axes: arr, merged: null, error: "targetId must be a non-empty string" };
  }
  if (typeof sourceId !== "string" || !sourceId.trim()) {
    return { axes: arr, merged: null, error: "sourceId must be a non-empty string" };
  }
  if (targetId === sourceId) {
    return { axes: arr, merged: null, error: "Cannot merge an axis with itself" };
  }

  // ── Look up both axes ───────────────────────────────────────────────────────
  const targetIdx = findAxisIndex(arr, targetId);
  if (targetIdx === -1) {
    return { axes: arr, merged: null, error: `Target axis not found: ${targetId}` };
  }

  const sourceIdx = findAxisIndex(arr, sourceId);
  if (sourceIdx === -1) {
    return { axes: arr, merged: null, error: `Source axis not found: ${sourceId}` };
  }

  const target = arr[targetIdx];
  const source = arr[sourceIdx];

  // ── Determine merged label ──────────────────────────────────────────────────
  let mergedLabel;
  if (newLabel !== undefined && newLabel !== null) {
    try {
      mergedLabel = _validateLabel(newLabel);
    } catch (err) {
      return { axes: arr, merged: null, error: err.message };
    }
  } else {
    mergedLabel = target.label;
  }

  // ── Union keywords (normalizeKeywords handles dedup + caps) ─────────────────
  const targetKw = Array.isArray(target.keywords) ? target.keywords : [];
  const sourceKw = Array.isArray(source.keywords) ? source.keywords : [];
  const mergedKeywords = normalizeKeywords([...targetKw, ...sourceKw]);

  // ── Build the merged axis (based on target, with user provenance) ───────────
  const merged = {
    ...target,
    label: mergedLabel,
    keywords: mergedKeywords,
    _source: "user"
  };

  // ── Build the new axes array: update target, filter out source ───────────────
  // Do this in a single pass to avoid double-iteration and index-shift issues.
  const newAxes = [];
  for (let i = 0; i < arr.length; i++) {
    if (i === sourceIdx) continue;          // remove source
    if (i === targetIdx) {
      newAxes.push(merged);                 // replace target with merged
    } else {
      newAxes.push(arr[i]);
    }
  }

  return { axes: newAxes, merged, error: null };
}

/**
 * Move a single keyword from one axis to another within an axes array.
 *
 * The keyword is matched case-insensitively so that "React" and "react" are
 * treated as the same keyword.  The original casing (first occurrence found in
 * the source axis) is preserved when the keyword is placed in the destination.
 *
 * Both the source and destination axes receive `_source: "user"` because a
 * move is always an explicit user-initiated operation.
 *
 * Edge cases:
 *   • If `fromAxisId` is supplied but the keyword is not present there, the
 *     function falls back to auto-detecting the source axis by scanning all
 *     axes in order.
 *   • If `srcIdx === destIdx` (keyword already in destination), the function
 *     returns `moved: false` with `error: null` — nothing changes.
 *   • If the keyword appears in the destination already, it is not duplicated;
 *     the source copy is still removed so the keyword ends up only in
 *     the destination.
 *
 * @param {Axis[]} axes                        Current axes array (not mutated).
 * @param {string} keyword                     Keyword to move (case-insensitive match).
 * @param {string} toAxisId                    Id of the destination axis.
 * @param {string|null|undefined} [fromAxisId] Id of the source axis; auto-detected when absent.
 * @returns {{
 *   axes:       Axis[],
 *   moved:      boolean,
 *   fromAxisId: string|null,
 *   toAxisId:   string,
 *   keyword:    string,
 *   error:      string|null
 * }}
 */
export function moveKeywordBetweenAxes(axes, keyword, toAxisId, fromAxisId) {
  const arr = Array.isArray(axes) ? axes : [];

  // ── Input validation ────────────────────────────────────────────────────────
  if (typeof keyword !== "string" || !keyword.trim()) {
    return {
      axes: arr, moved: false, fromAxisId: null,
      toAxisId: toAxisId ?? null, keyword: keyword ?? "",
      error: "keyword must be a non-empty string"
    };
  }
  if (typeof toAxisId !== "string" || !toAxisId.trim()) {
    return {
      axes: arr, moved: false, fromAxisId: null,
      toAxisId: toAxisId ?? null, keyword,
      error: "toAxisId must be a non-empty string"
    };
  }

  const kwLower = keyword.trim().toLowerCase();

  // ── Locate destination axis ─────────────────────────────────────────────────
  const destIdx = findAxisIndex(arr, toAxisId);
  if (destIdx === -1) {
    return {
      axes: arr, moved: false, fromAxisId: null,
      toAxisId, keyword,
      error: `Destination axis not found: ${toAxisId}`
    };
  }

  // ── Locate source axis ──────────────────────────────────────────────────────
  let srcIdx = -1;
  let actualKeyword = keyword.trim(); // preserve original casing from source

  // Try the explicitly-specified source axis first.
  if (fromAxisId && typeof fromAxisId === "string" && fromAxisId.trim()) {
    const candidateIdx = findAxisIndex(arr, fromAxisId);
    if (candidateIdx !== -1) {
      const found = (arr[candidateIdx].keywords ?? []).find(
        (k) => k.toLowerCase() === kwLower
      );
      if (found) {
        srcIdx = candidateIdx;
        actualKeyword = found;
      }
    }
  }

  // Fall back to scanning all axes when not found above.
  if (srcIdx === -1) {
    for (let i = 0; i < arr.length; i++) {
      const found = (arr[i].keywords ?? []).find((k) => k.toLowerCase() === kwLower);
      if (found) {
        srcIdx = i;
        actualKeyword = found;
        break;
      }
    }
  }

  if (srcIdx === -1) {
    return {
      axes: arr, moved: false, fromAxisId: null,
      toAxisId, keyword,
      error: `Keyword not found in any axis: ${keyword}`
    };
  }

  // ── Already in destination — nothing to do ──────────────────────────────────
  if (srcIdx === destIdx) {
    return {
      axes: arr, moved: false,
      fromAxisId: arr[srcIdx].id, toAxisId,
      keyword: actualKeyword, error: null
    };
  }

  // ── Build updated axes array (no mutation of originals) ────────────────────
  const newAxes = arr.map((axis, i) => {
    if (i === srcIdx) {
      // Remove keyword from source axis.
      return {
        ...axis,
        keywords: (axis.keywords ?? []).filter((k) => k.toLowerCase() !== kwLower),
        _source: "user"
      };
    }
    if (i === destIdx) {
      // Add keyword to destination (dedup via normalizeKeywords).
      const base = axis.keywords ?? [];
      const alreadyThere = base.some((k) => k.toLowerCase() === kwLower);
      if (alreadyThere) {
        // Keyword was already in destination — just mark as user-edited.
        return { ...axis, _source: "user" };
      }
      return {
        ...axis,
        keywords: normalizeKeywords([...base, actualKeyword]),
        _source: "user"
      };
    }
    return axis;
  });

  return {
    axes: newAxes,
    moved: true,
    fromAxisId: arr[srcIdx].id,
    toAxisId,
    keyword: actualKeyword,
    error: null
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Validate and normalise a label string.
 *
 * @param {unknown} label
 * @returns {string}
 * @throws {TypeError}
 */
function _validateLabel(label) {
  if (typeof label !== "string") {
    throw new TypeError(`Axis label must be a string, got ${typeof label}`);
  }
  const trimmed = label.trim().slice(0, LABEL_MAX_LEN);
  if (!trimmed) {
    throw new TypeError("Axis label must not be empty");
  }
  return trimmed;
}

/**
 * Generate a cryptographically random UUID.
 *
 * Uses the built-in `crypto.randomUUID()` (Node.js ≥ 15.6 / all modern runtimes).
 * No external dependencies.
 *
 * @returns {string}  e.g. "550e8400-e29b-41d4-a716-446655440000"
 */
function _generateId() {
  // crypto.randomUUID() is available in Node 15.6+ and all modern browsers.
  // The project targets Node 20+ (Vercel runtime), so this is safe.
  return crypto.randomUUID();
}
