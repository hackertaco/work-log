/**
 * Resume data model — canonical type definitions and constants.
 *
 * This is the single authoritative source for:
 *   • ItemSource values (provenance tags on resume items and sections)
 *   • Fixed section type enum (closed set — no custom sections on Day 1)
 *   • Schema version constants (resume, axes)
 *   • All JSDoc typedefs for the living-resume document structure
 *   • Axis / AxesDocument typedefs (display axes + keyword-cluster axes)
 *
 * No I/O — pure type/constant definitions.
 *
 * Design notes:
 *   - Fields that track WHO created/modified an item use `_source` (item-level)
 *     or `_sources.<section>` (document-level scalar sections).
 *   - The underscore prefix signals "internal provenance metadata" — not shown
 *     in the rendered resume output.
 *   - "user" and "user_approved" are both human-confirmed and carry equal
 *     protection against future system overwrites.
 *   - Priority order (highest → lowest): user > user_approved > system
 */

// ─── Schema version ────────────────────────────────────────────────────────────

/**
 * Current schema version for the living-resume document stored in Vercel Blob.
 * Increment when a breaking field change requires a migration.
 * @type {1}
 */
export const RESUME_SCHEMA_VERSION = 1;

// ─── ItemSource enum ───────────────────────────────────────────────────────────

/**
 * Valid per-item provenance values (closed set).
 *
 *   "system"        — generated or merged by LLM / automation
 *   "user"          — created or edited directly by the human user
 *   "user_approved" — system-generated but explicitly approved by the user
 *                     via the suggestions/candidates UI; carries the same
 *                     protection priority as "user" for merge-priority purposes
 *
 * @type {readonly ["user", "system", "user_approved"]}
 */
export const ITEM_SOURCE_VALUES = /** @type {const} */ (["user", "system", "user_approved"]);

/**
 * Per-item source provenance tag.
 *
 * Used on:
 *   - ResumeExperienceItem._source
 *   - ResumeEducationItem._source
 *   - ResumeProjectItem._source
 *   - ResumeCertificationItem._source
 *   - ResumeSources.{summary,contact,skills,...}
 *
 * Priority order (highest → lowest): user > user_approved > system
 *
 * @typedef {"user"|"system"|"user_approved"} ItemSource
 */

// ─── Fixed section type enum ───────────────────────────────────────────────────

/**
 * Closed set of top-level section keys in the living-resume document.
 * No custom sections are supported on Day 1.
 *
 * @type {readonly ["contact","summary","experience","education","skills","projects","certifications"]}
 */
export const SECTION_TYPES = /** @type {const} */ ([
  "contact",
  "summary",
  "experience",
  "education",
  "skills",
  "projects",
  "certifications"
]);

/**
 * Section type discriminator (closed enum).
 * @typedef {"contact"|"summary"|"experience"|"education"|"skills"|"projects"|"certifications"} SectionType
 */

// ─── Resume item typedefs ──────────────────────────────────────────────────────

/**
 * @typedef {Object} ResumeMeta
 * @property {string} language       ISO 639-1 code detected from source text (e.g. "ko", "en")
 * @property {string} source         Bootstrap source tag: "pdf" | "pdf+linkedin" | "linkedin"
 * @property {string} generatedAt    ISO 8601 datetime of initial generation
 * @property {number} schemaVersion  Always RESUME_SCHEMA_VERSION (1)
 */

/**
 * @typedef {Object} ResumeContact
 * @property {string}      name
 * @property {string|null} email
 * @property {string|null} phone
 * @property {string|null} location
 * @property {string|null} website
 * @property {string|null} linkedin
 */

/**
 * A single work-experience entry.
 * The `_source` tag tracks whether this entry was machine-generated or
 * created/approved by the user.
 *
 * @typedef {Object} ResumeExperienceItem
 * @property {ItemSource}  _source    Provenance tag — "user" | "system" | "user_approved"
 * @property {string}      company
 * @property {string}      title
 * @property {string|null} start_date YYYY-MM format or null
 * @property {string|null} end_date   YYYY-MM | "present" | null
 * @property {string|null} location
 * @property {string[]}    bullets    Achievement-oriented bullet strings (plain text)
 */

/**
 * @typedef {Object} ResumeEducationItem
 * @property {ItemSource}  _source
 * @property {string}      institution
 * @property {string|null} degree
 * @property {string|null} field
 * @property {string|null} start_date
 * @property {string|null} end_date
 * @property {string|null} gpa
 */

/**
 * Skills section (three flat string arrays — no source per-skill on Day 1).
 * Section-level provenance is tracked in ResumeSources.skills.
 *
 * @typedef {Object} ResumeSkills
 * @property {string[]} technical  Frameworks, libraries, architectural patterns
 * @property {string[]} languages  Programming / scripting languages
 * @property {string[]} tools      Dev tools, platforms, cloud services
 */

/**
 * @typedef {Object} ResumeProjectItem
 * @property {ItemSource}  _source
 * @property {string}      name
 * @property {string|null} description
 * @property {string|null} url
 * @property {string[]}    bullets
 */

/**
 * @typedef {Object} ResumeCertificationItem
 * @property {ItemSource}  _source
 * @property {string}      name
 * @property {string|null} issuer
 * @property {string|null} date  YYYY-MM or null
 */

/**
 * Document-level provenance map for scalar / structured sections.
 * Array sections (experience, education, projects, certifications) carry
 * per-item `_source` instead.
 *
 * Additional keys (display_axes, strength_keywords, etc.) may be present
 * when those sections have been edited by the user.
 *
 * @typedef {Object} ResumeSources
 * @property {ItemSource} summary
 * @property {ItemSource} contact
 * @property {ItemSource} skills
 */

// ─── Display axes schema ──────────────────────────────────────────────────────

/**
 * Current schema version for Axis objects and AxesDocument.
 * Shared constant — mirrors AXIS_SCHEMA_VERSION in resumeAxes.mjs.
 * @type {"1"}
 */
export const AXES_SCHEMA_VERSION = /** @type {const} */ ("1");

/**
 * A single display axis — a thematic lens through which the resume is presented.
 *
 * An axis groups keywords that characterise a particular professional perspective
 * (e.g. "Backend Engineer", "Open-Source Contributor", "Team Lead").  The UI uses
 * axes to highlight relevant resume sections when the user switches between views.
 *
 * Storage layout (two distinct collections share the same Axis shape):
 *
 *   ┌──────────────────────────────────────────┬────────────────────────────────┐
 *   │ Location                                 │ Purpose                        │
 *   ├──────────────────────────────────────────┼────────────────────────────────┤
 *   │ resume/data.json  → display_axes: Axis[] │ User-facing display / filtering│
 *   │ resume/keyword-cluster-axes.json         │ LLM keyword classification      │
 *   └──────────────────────────────────────────┴────────────────────────────────┘
 *
 * Constraints (enforced by resumeAxes.mjs):
 *   - `id`       : non-empty UUID string; immutable after creation.
 *   - `label`    : non-empty string; max 100 characters.
 *   - `keywords` : trimmed, deduplicated (case-insensitive); max 30 items,
 *                  each item max 60 characters.
 *   - `_source`  : "user" when created/last edited by the human user;
 *                  "system" when generated by LLM.
 *
 * @typedef {Object} Axis
 * @property {string}           id        Stable UUID identifying this axis (generated on create).
 * @property {string}           label     Display name / title (e.g. "Backend Engineer").
 * @property {string[]}         keywords  Keywords that characterise this axis perspective.
 *                                        May overlap with `strength_keywords` on the resume.
 * @property {"user"|"system"}  [_source] Provenance marker — "user" | "system".
 *                                        Set to "user" when created or last edited by the user.
 */

/**
 * Container document for the keyword-cluster axes stored in Vercel Blob.
 *
 * Blob pathname: `resume/keyword-cluster-axes.json`
 *
 * This document persists the 5–6 thematic axes generated by LLM keyword
 * clustering so that subsequent classification calls can reuse the same
 * axis set without re-calling the LLM.  It is distinct from the
 * `display_axes` array embedded in the main resume document (see ResumeData).
 *
 * Schema contract:
 *   - `schemaVersion` is always AXES_SCHEMA_VERSION ("1").
 *   - `axes` holds the axes produced by the last successful LLM clustering run.
 *   - `generatedAt` reflects when the document was last overwritten.
 *   - This document is never mutated by user actions — it is always regenerated
 *     by the recluster pipeline.
 *
 * @typedef {Object} AxesDocument
 * @property {"1"}    schemaVersion  Always AXES_SCHEMA_VERSION ("1").
 * @property {string} generatedAt   ISO 8601 datetime of last write.
 * @property {Axis[]} axes          Keyword-cluster axes (5–6 items typical).
 */

// ─── Resume document typedefs ──────────────────────────────────────────────────

/**
 * The living-resume document stored in Vercel Blob at `resume/data.json`.
 *
 * Schema contract:
 *   - meta.schemaVersion is always RESUME_SCHEMA_VERSION
 *   - All array items carry a valid _source tag (enforced by migrateResumeDocument)
 *   - _sources map always contains at minimum: summary, contact, skills
 *   - bullets within items are plain strings (bullet is the minimum edit unit)
 *   - display_axes is optional; absent before first axis creation; treated as []
 *
 * @typedef {Object} ResumeData
 * @property {ResumeMeta}                meta
 * @property {ResumeSources}             _sources       Per-section scalar provenance map
 * @property {ResumeContact}             contact
 * @property {string}                    summary
 * @property {ResumeExperienceItem[]}    experience
 * @property {ResumeEducationItem[]}     education
 * @property {ResumeSkills}              skills
 * @property {ResumeProjectItem[]}       projects
 * @property {ResumeCertificationItem[]} certifications
 * @property {Axis[]}                    [display_axes] User-facing display axes embedded in the
 *                                                      resume document.  Absent before the first
 *                                                      axis is created; callers should default to [].
 *                                                      Each axis carries id / label / keywords /
 *                                                      _source fields (see Axis typedef).
 */

// ─── Strength keywords document ───────────────────────────────────────────────

/**
 * The strength-keywords document stored in Vercel Blob at
 * `resume/strength-keywords.json`.
 *
 * This document holds the flat, unstructured list of marketable skill/trait
 * keywords for the user's resume.  It is intentionally separate from the main
 * `ResumeData` document so that keyword reads do not require fetching the
 * full resume.
 *
 * Schema contract:
 *   - `keywords` is a plain string array (unstructured list — no per-keyword
 *     metadata on Day 1).
 *   - Keywords are trimmed, non-empty, and deduplicated case-insensitively.
 *   - Maximum 50 keywords; maximum 80 characters per keyword.
 *   - `source` reflects the most recent bulk write operation:
 *       "bootstrap" — populated by the initial LLM bootstrap call
 *       "user"      — user added/removed keywords directly
 *       "system"    — system-generated update (e.g. work-log extraction)
 *
 * Lifecycle:
 *   1. Created (empty or from bootstrap) when POST /api/resume/bootstrap runs.
 *   2. Updated additively via POST /api/resume/strength-keywords.
 *   3. Updated destructively via PATCH /api/resume/strength-keywords.
 *   4. Single keyword removed via DELETE /api/resume/strength-keywords/:keyword.
 *
 * @typedef {Object} StrengthKeywordsDocument
 * @property {number}   schemaVersion  Always STRENGTH_KEYWORDS_SCHEMA_VERSION (1)
 * @property {string}   updatedAt      ISO 8601 datetime of last write
 * @property {string}   source         "bootstrap" | "user" | "system"
 * @property {string[]} keywords       Flat keyword array (ordered, deduplicated)
 */

// ─── Work-log entry interface (system boundary) ───────────────────────────────

/**
 * Interface for work-log entries at the system boundary.
 * Work-log data is treated as external input — it feeds candidate generation
 * but never directly mutates user-owned resume content.
 *
 * @typedef {Object} WorkLogEntry
 * @property {string}   date        ISO date YYYY-MM-DD
 * @property {string[]} candidates  Raw bullet candidate strings from LLM extraction
 * @property {string[]} [companyCandidates]
 * @property {string[]} [openSourceCandidates]
 */

// ─── Daily bullet cache schema ────────────────────────────────────────────────

/**
 * Cache invalidation metadata.
 *
 * Attached to all daily bullet cache entries (BulletCacheEntry, ExtractCacheEntry,
 * and DailyBulletsDocument) to support:
 *   - Auditing: knowing WHEN an entry was written and WHAT work-log entry triggered it.
 *   - Soft invalidation: marking an entry as stale without hard-deleting it, so that
 *     the data is retained for debugging while future reads treat the entry as a miss.
 *
 * When `invalidatedAt` is null the entry is considered valid (cache hit eligible).
 * When `invalidatedAt` is set the entry is considered invalidated (cache miss).
 *
 * @typedef {Object} BulletCacheInvalidationMeta
 * @property {string}      cachedAt            ISO 8601 datetime when this entry was last written
 * @property {string}      sourceEntryId       Identifier of the work-log entry that triggered
 *                                             generation — the date string (YYYY-MM-DD) of the
 *                                             work-log batch that produced this cache entry
 * @property {string|null} invalidatedAt       ISO 8601 datetime of explicit invalidation;
 *                                             null when the entry is still valid
 * @property {string|null} invalidationReason  Human-readable description of why the entry was
 *                                             invalidated (e.g. "work_log_updated", "manual");
 *                                             null when the entry is still valid
 */

/**
 * A single intermediate bullet candidate item.
 * Stored inside DailyBulletsDocument.bullets[].
 *
 * The `sourceEntryId` field links each bullet back to the work-log entry that
 * generated it, enabling targeted cache invalidation when a specific work-log date
 * is re-processed.
 *
 * @typedef {Object} DailyBulletItem
 * @property {string}                                   id                   Stable, deterministic ID — "bullet-{date}-{index}"
 * @property {string}                                   text                 Raw bullet text (trimmed, non-empty)
 * @property {"company"|"opensource"|"other"}           category             Provenance category
 * @property {"experience"|"skills"|"projects"}         suggestedSection     Heuristically inferred target resume section
 * @property {"pending"|"promoted"|"dismissed"}         status               Lifecycle status
 * @property {string|null}                              promotedSuggestionId Populated when status === "promoted"
 * @property {string}                                   createdAt            ISO 8601 datetime of item creation
 * @property {string}                                   sourceEntryId        Work-log date (YYYY-MM-DD) that generated this bullet
 */

/**
 * Per-day intermediate cache document.
 * Stored at resume/bullets/{YYYY-MM-DD}.json in Vercel Blob.
 *
 * Bridges raw daily work-log batch output and the polished resume/suggestions.json.
 * Each bullet tracks its own lifecycle (pending → promoted/dismissed) independently.
 *
 * Cache invalidation semantics:
 *   - `invalidatedAt === null`  → entry is valid; reads return bullets normally.
 *   - `invalidatedAt !== null`  → entry is invalidated; the document is retained
 *     for auditing but callers should treat it as stale and regenerate.
 *
 * @typedef {Object} DailyBulletsDocument
 * @property {1}                     schemaVersion       Always DAILY_BULLETS_SCHEMA_VERSION (1)
 * @property {string}                date                Work-log date YYYY-MM-DD (matches Blob filename)
 * @property {string}                generatedAt         ISO 8601 datetime of last mutation
 * @property {"work_log_batch"}      sourceType          Always "work_log_batch" on Day 1
 * @property {string}                sourceEntryId       Work-log entry identifier (YYYY-MM-DD) that
 *                                                       triggered generation of this document
 * @property {string|null}           invalidatedAt       ISO 8601 datetime of explicit invalidation;
 *                                                       null when the document is valid
 * @property {string|null}           invalidationReason  Human-readable invalidation reason; null when valid
 * @property {DailyBulletItem[]}     bullets             Bullet candidate items
 */

/**
 * Cache envelope for a single date's batch summarization result.
 * Stored at cache/bullets/{date}.json in Vercel Blob.
 *
 * Used by bulletCache.mjs to avoid redundant summarizeWithOpenAI calls when the
 * same date is reprocessed (batch run twice, server restart mid-flight, etc.).
 *
 * Cache invalidation semantics:
 *   - `invalidatedAt === null`  → entry is a valid cache hit.
 *   - `invalidatedAt !== null`  → entry is invalidated; read returns null (cache miss).
 *
 * @typedef {Object} BulletCacheEntry
 * @property {1}           schemaVersion       Always 1
 * @property {string}      date                Work-log date YYYY-MM-DD
 * @property {string}      cachedAt            ISO 8601 datetime of cache write
 * @property {string}      sourceEntryId       Work-log entry identifier (YYYY-MM-DD) that triggered generation
 * @property {string|null} invalidatedAt       ISO 8601 datetime of explicit invalidation; null when valid
 * @property {string|null} invalidationReason  Human-readable invalidation reason; null when valid
 * @property {object}      result              The raw summarization result from summarizeWithOpenAI
 */

/**
 * Cache envelope for a single date's WorkLogExtract result.
 * Stored at cache/extract/{date}.json in Vercel Blob.
 *
 * Used by bulletCache.mjs to avoid redundant extractResumeUpdatesFromWorkLog LLM
 * calls when the same date is processed multiple times by the generate-candidates
 * pipeline.
 *
 * Cache invalidation semantics:
 *   - `invalidatedAt === null`  → entry is a valid cache hit.
 *   - `invalidatedAt !== null`  → entry is invalidated; read returns null (cache miss).
 *
 * @typedef {Object} ExtractCacheEntry
 * @property {1}           schemaVersion       Always 1
 * @property {string}      date                Work-log date YYYY-MM-DD
 * @property {string}      cachedAt            ISO 8601 datetime of cache write
 * @property {string}      sourceEntryId       Work-log entry identifier (YYYY-MM-DD) that triggered generation
 * @property {string|null} invalidatedAt       ISO 8601 datetime of explicit invalidation; null when valid
 * @property {string|null} invalidationReason  Human-readable invalidation reason; null when valid
 * @property {object}      extract             The WorkLogExtract from extractResumeUpdatesFromWorkLog
 */
