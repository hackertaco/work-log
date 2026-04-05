/**
 * Resume Identified Strengths — data model, schema constants, and mutation helpers.
 *
 * Identified strengths are behavioral patterns backed by concrete evidence
 * episodes, distinct from the flat keyword list in resumeStrengthKeywords.mjs.
 *
 * Key distinction from strength keywords:
 *   - Strength keywords = flat string list of marketable skill/trait tags
 *     (e.g. "TypeScript", "System Design", "Error Handling")
 *   - Identified strengths = behavioral patterns with supporting evidence,
 *     frequency metrics, reasoning narrative, and cross-repo aggregation
 *     (e.g. "Reliability-First Engineering" backed by 4 episodes across 2 repos)
 *
 * Storage:
 *   `resume/identified-strengths.json` in Vercel Blob (dedicated file)
 *
 * Schema (StrengthsDocument):
 *   {
 *     schemaVersion: 1,
 *     updatedAt:     ISO 8601 string,
 *     source:        "system" | "user" | "user_approved",
 *     strengths:     IdentifiedStrength[],   // 3-5 items, ordered by frequency desc
 *     totalEpisodes: number,                 // episodes analyzed in last identification
 *     totalProjects: number,                 // projects analyzed in last identification
 *   }
 *
 * Design notes:
 *   - Each strength is a behavioral pattern, NOT a technology or keyword tag.
 *   - Strengths are unified cross-repo: a single strength may draw evidence
 *     from multiple repositories.
 *   - Target count: 3-5 strengths (structural_appropriateness constraint).
 *   - User-edited strengths (_source: "user" or "user_approved") are NEVER
 *     overwritten by system re-identification (edit_respect constraint).
 *   - frequency reflects distinct evidence episodes, not raw mention count.
 *   - reasoningNarrative embeds decision reasoning from session conversations
 *     naturally into the description (reasoning_integration constraint).
 *   - evidenceIds provide reverse traceability to specific episodes.
 *
 * Public API:
 *   STRENGTHS_SCHEMA_VERSION        — number constant (1)
 *   STRENGTHS_BLOB_PATH             — Vercel Blob pathname
 *   MAX_STRENGTHS                   — maximum strength count (5)
 *   MIN_STRENGTHS                   — minimum strength count (3)
 *   MAX_LABEL_LENGTH                — character limit per label (60)
 *   MAX_DESCRIPTION_LENGTH          — character limit per description (500)
 *   MAX_EXAMPLE_BULLETS             — max example bullets per strength (3)
 *   MIN_EVIDENCE_EPISODES           — minimum episodes to qualify (2)
 *
 *   createEmptyStrengthsDoc()                         → StrengthsDocument
 *   createStrengthsDoc(strengths, meta)               → StrengthsDocument
 *   validateStrengthsDoc(doc)                         → boolean
 *   validateStrength(strength)                        → boolean
 *   extractStrengths(doc)                             → IdentifiedStrength[]
 *   getUserStrengths(doc)                             → IdentifiedStrength[]
 *   getSystemStrengths(doc)                           → IdentifiedStrength[]
 *   upsertStrength(doc, strength)                     → StrengthsDocument
 *   removeStrength(doc, strengthId)                   → StrengthsDocument
 *   mergeStrengthsDocs(existing, fresh)               → StrengthsDocument
 *   isHumanConfirmedStrength(strength)                → boolean
 *   sortStrengthsByFrequency(strengths)               → IdentifiedStrength[]
 *   computeStrengthCoverage(strengths)                → StrengthCoverage
 *
 * @module resumeStrengths
 */

// ─── Schema version ────────────────────────────────────────────────────────────

/**
 * Current schema version for the StrengthsDocument stored in Vercel Blob.
 * Increment when a breaking field change requires a migration.
 * @type {1}
 */
export const STRENGTHS_SCHEMA_VERSION = 1;

// ─── Blob path ────────────────────────────────────────────────────────────────

/**
 * Vercel Blob pathname for the identified strengths document.
 * @type {string}
 */
export const STRENGTHS_BLOB_PATH = "resume/identified-strengths.json";

// ─── Limits ───────────────────────────────────────────────────────────────────

/**
 * Maximum number of identified strengths.
 * Matches TARGET_STRENGTHS_MAX in resumeReconstruction.mjs.
 * @type {5}
 */
export const MAX_STRENGTHS = 5;

/**
 * Minimum number of identified strengths for a well-formed result.
 * Matches TARGET_STRENGTHS_MIN in resumeReconstruction.mjs.
 * @type {3}
 */
export const MIN_STRENGTHS = 3;

/**
 * Maximum character length for a strength label.
 * Labels should be concise behavioral pattern names (2-6 words).
 * @type {60}
 */
export const MAX_LABEL_LENGTH = 60;

/**
 * Maximum character length for a strength description.
 * Descriptions should embed decision reasoning naturally (1-2 sentences).
 * @type {500}
 */
export const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Maximum example bullets per strength.
 * @type {3}
 */
export const MAX_EXAMPLE_BULLETS = 3;

/**
 * Maximum character length for a strength's qualifying reasoning.
 * Reasoning explains WHY the pattern qualifies as a strength:
 * repetition, intentionality, impact, and differentiation.
 * @type {600}
 */
export const MAX_REASONING_LENGTH = 600;

/**
 * Maximum number of micro-behavior phrases in a behaviorCluster.
 * These describe the individual behaviors that were grouped to form the strength.
 * @type {5}
 */
export const MAX_BEHAVIOR_CLUSTER_SIZE = 5;

/**
 * Minimum distinct evidence episodes required for a strength to qualify.
 * A strength appearing in only 1 episode is anecdotal, not a pattern.
 * @type {2}
 */
export const MIN_EVIDENCE_EPISODES = 2;

// ─── Provenance helpers ───────────────────────────────────────────────────────

/**
 * Check whether a strength's _source indicates human confirmation.
 * Human-confirmed strengths are protected from system overwrite.
 *
 * @param {import("./resumeTypes.mjs").IdentifiedStrength} strength
 * @returns {boolean}
 */
export function isHumanConfirmedStrength(strength) {
  if (!strength || typeof strength !== "object") return false;
  return strength._source === "user" || strength._source === "user_approved";
}

// ─── Initialization ────────────────────────────────────────────────────────────

/**
 * Create an empty StrengthsDocument.
 *
 * Used when initializing storage for the first time (before any
 * identification pipeline has run).
 *
 * @returns {StrengthsDocument}
 */
export function createEmptyStrengthsDoc() {
  return {
    schemaVersion: STRENGTHS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    source: "system",
    strengths: [],
    totalEpisodes: 0,
    totalProjects: 0,
  };
}

/**
 * Create a StrengthsDocument from identification pipeline output.
 *
 * Normalizes, validates, and wraps strengths in the document envelope.
 * Invalid strengths are silently filtered. The result is sorted by
 * frequency descending (most-evidenced strengths first).
 *
 * @param {import("./resumeTypes.mjs").IdentifiedStrength[]} strengths
 *   Strengths from the identification pipeline (already normalized by
 *   _normalizeStrengths in resumeReconstruction.mjs)
 * @param {Object} meta
 * @param {number} meta.totalEpisodes  Total episodes analyzed
 * @param {number} meta.totalProjects  Total projects analyzed
 * @param {string} [meta.source="system"]  Provenance for the document-level source
 * @returns {StrengthsDocument}
 */
export function createStrengthsDoc(strengths, meta = {}) {
  const normalized = _normalizeStrengthArray(strengths);
  return {
    schemaVersion: STRENGTHS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    source: typeof meta.source === "string" && meta.source ? meta.source : "system",
    strengths: normalized,
    totalEpisodes: typeof meta.totalEpisodes === "number" ? meta.totalEpisodes : 0,
    totalProjects: typeof meta.totalProjects === "number" ? meta.totalProjects : 0,
  };
}

// ─── Validation ────────────────────────────────────────────────────────────────

/**
 * Type guard: returns `true` when `doc` is a valid StrengthsDocument.
 *
 * Checks structural validity of the document envelope and each strength.
 * Does NOT enforce MIN_STRENGTHS — an empty doc is valid (pre-identification).
 *
 * @param {unknown} doc
 * @returns {boolean}
 */
export function validateStrengthsDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  if (typeof doc.schemaVersion !== "number" || doc.schemaVersion <= 0) return false;
  if (typeof doc.updatedAt !== "string" || !doc.updatedAt) return false;
  if (!Array.isArray(doc.strengths)) return false;
  for (const s of doc.strengths) {
    if (!validateStrength(s)) return false;
  }
  return true;
}

/**
 * Validate a single IdentifiedStrength object.
 *
 * Checks that all required fields are present and well-typed.
 * Does NOT enforce limits (MAX_LABEL_LENGTH, etc.) — those are enforced
 * at write time during normalization.
 *
 * @param {unknown} strength
 * @returns {boolean}
 */
export function validateStrength(strength) {
  if (!strength || typeof strength !== "object" || Array.isArray(strength)) return false;

  const s = /** @type {Record<string, unknown>} */ (strength);

  // Required string fields
  if (typeof s.id !== "string" || !s.id) return false;
  if (typeof s.label !== "string" || !s.label) return false;
  if (typeof s.description !== "string") return false;

  // reasoning is optional for backward-compat (empty string or absent is valid)
  if (s.reasoning !== undefined && typeof s.reasoning !== "string") return false;

  // Frequency must be a non-negative number
  if (typeof s.frequency !== "number" || s.frequency < 0) return false;

  // behaviorCluster is optional for backward-compat (absent or string[] is valid)
  if (s.behaviorCluster !== undefined) {
    if (!Array.isArray(s.behaviorCluster)) return false;
    for (const item of s.behaviorCluster) {
      if (typeof item !== "string") return false;
    }
  }

  // Evidence arrays must be string arrays
  if (!Array.isArray(s.evidenceIds)) return false;
  for (const id of s.evidenceIds) {
    if (typeof id !== "string") return false;
  }

  if (!Array.isArray(s.projectIds)) return false;
  for (const id of s.projectIds) {
    if (typeof id !== "string") return false;
  }

  if (!Array.isArray(s.repos)) return false;
  for (const r of s.repos) {
    if (typeof r !== "string") return false;
  }

  if (!Array.isArray(s.exampleBullets)) return false;
  for (const b of s.exampleBullets) {
    if (typeof b !== "string") return false;
  }

  // _source must be a valid ItemSource
  if (!["user", "system", "user_approved"].includes(s._source)) return false;

  return true;
}

// ─── Extraction ────────────────────────────────────────────────────────────────

/**
 * Extract the strengths array from a StrengthsDocument.
 *
 * Returns an empty array when `doc` is null/undefined or invalid.
 * Safe to call with any value — never throws.
 *
 * @param {unknown} doc
 * @returns {import("./resumeTypes.mjs").IdentifiedStrength[]}
 */
export function extractStrengths(doc) {
  if (!doc || typeof doc !== "object") return [];
  if (!Array.isArray(doc.strengths)) return [];
  return doc.strengths.filter((s) => validateStrength(s));
}

/**
 * Extract only user-confirmed strengths (protected from overwrite).
 *
 * @param {unknown} doc
 * @returns {import("./resumeTypes.mjs").IdentifiedStrength[]}
 */
export function getUserStrengths(doc) {
  return extractStrengths(doc).filter(isHumanConfirmedStrength);
}

/**
 * Extract only system-generated strengths (eligible for replacement).
 *
 * @param {unknown} doc
 * @returns {import("./resumeTypes.mjs").IdentifiedStrength[]}
 */
export function getSystemStrengths(doc) {
  return extractStrengths(doc).filter((s) => !isHumanConfirmedStrength(s));
}

// ─── Mutation helpers ──────────────────────────────────────────────────────────

/**
 * Upsert a single strength into the document.
 *
 * If a strength with the same `id` already exists:
 *   - If existing is human-confirmed and incoming is system → existing preserved
 *   - Otherwise → replaced with incoming
 *
 * If no match → appended (up to MAX_STRENGTHS, user strengths first).
 *
 * @param {StrengthsDocument} doc  Existing document (must be valid)
 * @param {import("./resumeTypes.mjs").IdentifiedStrength} strength  Strength to upsert
 * @returns {StrengthsDocument}  New document with the strength upserted
 */
export function upsertStrength(doc, strength) {
  const existing = extractStrengths(doc);
  if (!validateStrength(strength)) return { ...doc };

  const idx = existing.findIndex((s) => s.id === strength.id);

  let updated;
  if (idx >= 0) {
    const current = existing[idx];
    // User edits are never overwritten by system
    if (isHumanConfirmedStrength(current) && strength._source === "system") {
      return { ...doc };
    }
    updated = [...existing];
    updated[idx] = strength;
  } else {
    updated = [...existing, strength];
  }

  // Enforce MAX_STRENGTHS: user strengths have priority
  const sorted = _prioritizeAndCap(updated);

  return {
    ...doc,
    updatedAt: new Date().toISOString(),
    strengths: sorted,
  };
}

/**
 * Remove a strength by ID.
 *
 * @param {StrengthsDocument} doc  Existing document
 * @param {string} strengthId  ID of the strength to remove
 * @returns {StrengthsDocument}  New document without the removed strength
 */
export function removeStrength(doc, strengthId) {
  if (typeof strengthId !== "string" || !strengthId) return { ...doc };
  const existing = extractStrengths(doc);
  const filtered = existing.filter((s) => s.id !== strengthId);
  if (filtered.length === existing.length) return { ...doc }; // not found

  return {
    ...doc,
    updatedAt: new Date().toISOString(),
    source: "user",
    strengths: filtered,
  };
}

/**
 * Merge a freshly-identified StrengthsDocument with an existing one,
 * preserving all user edits and updating system strengths.
 *
 * Merge rules (mirrors _mergeStrengths in resumeReconstruction.mjs):
 *   1. User-confirmed strengths are always preserved unchanged.
 *   2. System strengths with the same label (case-insensitive) are replaced
 *      with the fresh version (updated evidence/frequency).
 *   3. Fresh strengths with no label match are appended.
 *   4. Total capped at MAX_STRENGTHS with user strengths prioritized.
 *
 * @param {StrengthsDocument} existing  Current stored document
 * @param {StrengthsDocument} fresh     Newly identified document
 * @returns {StrengthsDocument}  Merged document
 */
export function mergeStrengthsDocs(existing, fresh) {
  const existingStrengths = extractStrengths(existing);
  const freshStrengths = extractStrengths(fresh);

  const userStrengths = existingStrengths.filter(isHumanConfirmedStrength);
  const systemStrengths = existingStrengths.filter((s) => !isHumanConfirmedStrength(s));

  // If user already has MAX_STRENGTHS, just return them
  if (userStrengths.length >= MAX_STRENGTHS) {
    return {
      ...existing,
      updatedAt: new Date().toISOString(),
      strengths: userStrengths.slice(0, MAX_STRENGTHS),
    };
  }

  // Build lookup for existing system strengths by label
  const systemByLabel = new Map();
  for (const s of systemStrengths) {
    systemByLabel.set(_labelKey(s.label), s);
  }

  // Build label set for user strengths (avoid duplicating)
  const userLabels = new Set(userStrengths.map((s) => _labelKey(s.label)));

  // Process fresh strengths
  const updatedSystem = new Map(systemByLabel);
  const freshAppend = [];

  for (const s of freshStrengths) {
    const key = _labelKey(s.label);
    if (!key) continue;
    if (userLabels.has(key)) continue; // user already has this

    if (updatedSystem.has(key)) {
      updatedSystem.set(key, s); // replace with fresh evidence
    } else {
      freshAppend.push(s);
    }
  }

  const combined = [
    ...userStrengths,
    ...[...updatedSystem.values()],
    ...freshAppend,
  ];

  return {
    schemaVersion: STRENGTHS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    source: "system",
    strengths: combined.slice(0, MAX_STRENGTHS),
    totalEpisodes: typeof fresh.totalEpisodes === "number" ? fresh.totalEpisodes : 0,
    totalProjects: typeof fresh.totalProjects === "number" ? fresh.totalProjects : 0,
  };
}

// ─── Sorting ──────────────────────────────────────────────────────────────────

/**
 * Sort strengths by frequency descending (most-evidenced first).
 * Ties are broken by label alphabetically.
 *
 * @param {import("./resumeTypes.mjs").IdentifiedStrength[]} strengths
 * @returns {import("./resumeTypes.mjs").IdentifiedStrength[]}
 */
export function sortStrengthsByFrequency(strengths) {
  if (!Array.isArray(strengths)) return [];
  return [...strengths].sort((a, b) => {
    const freqDiff = (b.frequency || 0) - (a.frequency || 0);
    if (freqDiff !== 0) return freqDiff;
    return (a.label || "").localeCompare(b.label || "");
  });
}

// ─── Coverage analytics ───────────────────────────────────────────────────────

/**
 * Coverage metrics for the identified strengths set.
 *
 * @typedef {Object} StrengthCoverage
 * @property {number} totalStrengths     Number of identified strengths
 * @property {number} totalEvidenceIds   Total unique evidence episode IDs across all strengths
 * @property {number} totalProjectIds    Total unique project IDs across all strengths
 * @property {number} totalRepos         Number of unique repos represented
 * @property {number} avgFrequency       Average episode frequency across strengths
 * @property {number} minFrequency       Minimum episode frequency (weakest evidence)
 * @property {number} maxFrequency       Maximum episode frequency (strongest evidence)
 * @property {boolean} meetsMinimum      True if totalStrengths >= MIN_STRENGTHS
 * @property {boolean} withinBounds      True if MIN_STRENGTHS <= totalStrengths <= MAX_STRENGTHS
 * @property {string[]} weakStrengthIds  IDs of strengths below MIN_EVIDENCE_EPISODES
 */

/**
 * Compute coverage analytics for a set of identified strengths.
 *
 * Useful for pipeline quality checks and UI indicators.
 *
 * @param {import("./resumeTypes.mjs").IdentifiedStrength[]} strengths
 * @returns {StrengthCoverage}
 */
export function computeStrengthCoverage(strengths) {
  const safe = Array.isArray(strengths) ? strengths.filter(validateStrength) : [];

  const allEvidenceIds = new Set();
  const allProjectIds = new Set();
  const allRepos = new Set();
  const weakStrengthIds = [];

  let totalFreq = 0;
  let minFreq = Infinity;
  let maxFreq = 0;

  for (const s of safe) {
    for (const id of s.evidenceIds) allEvidenceIds.add(id);
    for (const id of s.projectIds) allProjectIds.add(id);
    for (const r of s.repos) allRepos.add(r);

    const freq = s.frequency || 0;
    totalFreq += freq;
    if (freq < minFreq) minFreq = freq;
    if (freq > maxFreq) maxFreq = freq;

    if (freq < MIN_EVIDENCE_EPISODES) {
      weakStrengthIds.push(s.id);
    }
  }

  return {
    totalStrengths: safe.length,
    totalEvidenceIds: allEvidenceIds.size,
    totalProjectIds: allProjectIds.size,
    totalRepos: allRepos.size,
    avgFrequency: safe.length > 0 ? totalFreq / safe.length : 0,
    minFrequency: safe.length > 0 ? minFreq : 0,
    maxFrequency: maxFreq,
    meetsMinimum: safe.length >= MIN_STRENGTHS,
    withinBounds: safe.length >= MIN_STRENGTHS && safe.length <= MAX_STRENGTHS,
    weakStrengthIds,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a label to a lowercase key for dedup comparison.
 * @param {unknown} label
 * @returns {string}
 */
function _labelKey(label) {
  return typeof label === "string" ? label.toLowerCase().trim() : "";
}

/**
 * Normalize an array of strengths: validate, sort, cap.
 *
 * @param {unknown} strengths
 * @returns {import("./resumeTypes.mjs").IdentifiedStrength[]}
 */
function _normalizeStrengthArray(strengths) {
  if (!Array.isArray(strengths)) return [];
  return sortStrengthsByFrequency(
    strengths.filter(validateStrength)
  ).slice(0, MAX_STRENGTHS);
}

/**
 * Prioritize user strengths over system strengths and cap at MAX_STRENGTHS.
 *
 * @param {import("./resumeTypes.mjs").IdentifiedStrength[]} strengths
 * @returns {import("./resumeTypes.mjs").IdentifiedStrength[]}
 */
function _prioritizeAndCap(strengths) {
  const user = strengths.filter(isHumanConfirmedStrength);
  const system = strengths.filter((s) => !isHumanConfirmedStrength(s));
  return [...user, ...sortStrengthsByFrequency(system)].slice(0, MAX_STRENGTHS);
}

// ─── JSDoc for document shape ─────────────────────────────────────────────────

/**
 * The identified strengths document stored in Vercel Blob at
 * `resume/identified-strengths.json`.
 *
 * This document holds the behavioral patterns identified by analyzing
 * evidence episodes and core projects across all repositories. Each
 * strength captures:
 *   - A behavioral pattern name (label), NOT a keyword/technology tag
 *   - Supporting evidence episodes with specific references
 *   - Frequency/repetition metrics (how many episodes demonstrate this)
 *   - A reasoning narrative that embeds decision context from sessions
 *   - Cross-repo aggregation of where this strength manifests
 *
 * The key distinction from StrengthKeywordsDocument:
 *   StrengthKeywordsDocument = flat list of marketable tags
 *   StrengthsDocument = rich behavioral patterns with evidence chains
 *
 * @typedef {Object} StrengthsDocument
 * @property {number}   schemaVersion  Always STRENGTHS_SCHEMA_VERSION (1)
 * @property {string}   updatedAt      ISO 8601 datetime of last write
 * @property {string}   source         Document-level provenance: "system" | "user" | "user_approved"
 * @property {import("./resumeTypes.mjs").IdentifiedStrength[]} strengths
 *   3-5 identified strengths, ordered by frequency descending.
 *   Each carries its own _source for per-item provenance.
 * @property {number}   totalEpisodes  Total evidence episodes analyzed in last identification
 * @property {number}   totalProjects  Total core projects analyzed in last identification
 */
