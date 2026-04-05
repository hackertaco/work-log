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

// ─── Evidence episodes & core projects ────────────────────────────────────────

/**
 * An evidence episode — a semantically coherent unit of work activity that
 * groups related work-log entries, commits, and session conversations around
 * a single topic + functional module.
 *
 * Episodes are the atomic evidence units that feed into core projects.
 * Each episode captures WHAT was done, WHY it was done (decision reasoning
 * from session conversations), and the concrete artifacts (commits, bullets).
 *
 * Grouping criteria (LLM-judged):
 *   - Semantic topic similarity (e.g. "payment flow refactoring")
 *   - Functional module unit (e.g. same service/component/subsystem)
 *
 * @typedef {Object} EvidenceEpisode
 * @property {string}   id              Stable identifier — "ep-{repo}-{index}"
 * @property {string}   title           Short descriptive title (5-15 words)
 * @property {string}   summary         1-2 sentence summary of the episode
 * @property {string[]} dates           ISO dates (YYYY-MM-DD) this episode spans
 * @property {string[]} commitSubjects  Git commit subjects included in this episode
 * @property {string[]} bullets         Achievement-oriented bullet points derived from this episode
 * @property {string|null} decisionReasoning  Why-reasoning extracted from session conversations
 *                                            (null when no session data available for this episode)
 * @property {string}   topicTag        Short semantic topic tag (e.g. "payment-flow", "auth-system")
 * @property {string}   moduleTag       Functional module identifier (e.g. "api/payments", "lib/auth")
 */

/**
 * A core project — a high-level grouping of evidence episodes that represents
 * a significant stream of work within a single repository.
 *
 * Target: ~2 core projects per repo (not hard limit — LLM judges based on
 * natural clustering of work activity).
 *
 * Core projects become the primary organizational unit for resume content,
 * replacing the old flat bullet list approach.
 *
 * @typedef {Object} CoreProject
 * @property {string}            id          Stable identifier — "proj-{repo}-{index}"
 * @property {string}            repo        Repository name this project belongs to
 * @property {string}            title       Concise project title (3-8 words)
 * @property {string}            description 2-4 sentence project description explaining scope and impact
 * @property {EvidenceEpisode[]} episodes    Supporting evidence episodes (ordered by date)
 * @property {string[]}          bullets     Top-level achievement bullets synthesized from episodes
 *                                           (these are the resume-ready bullets)
 * @property {string[]}          techTags    Technologies/tools prominent in this project
 * @property {string}            dateRange   Human-readable date range (e.g. "Mar 2026")
 * @property {ItemSource}        _source     Provenance — "system" when auto-generated,
 *                                           "user" when edited by user
 */

/**
 * Result of core project extraction for a single repository.
 *
 * @typedef {Object} CoreProjectExtractionResult
 * @property {string}        repo      Repository name
 * @property {CoreProject[]} projects  Extracted core projects (~2 per repo)
 * @property {number}        episodeCount Total evidence episodes identified
 * @property {string}        extractedAt  ISO 8601 datetime of extraction
 */

// ─── Identified strengths ─────────────────────────────────────────────────────

/**
 * A single identified strength — a BEHAVIORAL PATTERN (not a keyword tag)
 * surfaced by analyzing evidence episodes and core projects across all repos.
 *
 * Key distinction from strength keywords (StrengthKeywordsDocument):
 *   - Strength keywords = flat marketable tags (e.g. "TypeScript", "Docker")
 *   - IdentifiedStrength = behavioral patterns with evidence chains and
 *     reasoning narrative (e.g. "Reliability-First Engineering" backed
 *     by 4 episodes across 2 repos, with session decision context embedded)
 *
 * Strengths are the unified, cross-repo set of professional differentiators
 * that emerge from the work evidence.  Target: 3-5 strengths total.
 *
 * Data model operations are in resumeStrengths.mjs (StrengthsDocument).
 * Storage: `resume/identified-strengths.json` in Vercel Blob.
 *
 * @typedef {Object} IdentifiedStrength
 * @property {string}   id              Stable identifier — "str-{index}"
 * @property {string}   label           Short behavioral pattern name (2-6 words,
 *                                      e.g. "Reliability-First Engineering").
 *                                      Must describe a behavior/capability, NOT a technology.
 * @property {string}   description     1-2 sentence explanation of how this strength
 *                                      manifests in work. Embeds decision reasoning from
 *                                      session conversations naturally — not as separate
 *                                      metadata but woven into the narrative.
 * @property {string}   reasoning       2-3 sentence explanation of WHY this behavioral
 *                                      pattern qualifies as a genuine professional strength.
 *                                      Addresses repetition (how often it appears across
 *                                      episodes/repos), intentionality (evidence from session
 *                                      decisions that it's deliberate), impact (outcomes
 *                                      produced), and differentiation (why it's notable).
 *                                      Empty string when not yet generated (legacy data).
 * @property {number}   frequency       Number of DISTINCT evidence episodes that demonstrate
 *                                      this strength. Minimum 2 to qualify as a pattern
 *                                      (not anecdotal). This is the primary repetition metric.
 * @property {string[]} behaviorCluster Short phrases describing the micro-behaviors that
 *                                      were clustered to form this strength (2-5 items,
 *                                      e.g. ["retry logic", "circuit breakers", "error
 *                                      boundaries"]). Provides transparency into how the
 *                                      LLM grouped related behaviors into this strength.
 *                                      Empty array when not yet generated (legacy data).
 * @property {string[]} evidenceIds     IDs of evidence episodes backing this strength
 *                                      (e.g. ["ep-repo-0", "ep-repo-2"]). Provides
 *                                      reverse traceability to concrete work instances.
 * @property {string[]} projectIds      IDs of core projects where this strength appears
 *                                      (e.g. ["proj-repo-0"]). Links to higher-level groupings.
 * @property {string[]} repos           Repository names where this strength appears.
 *                                      Cross-repo aggregation into single unified set.
 * @property {string[]} exampleBullets  1-3 representative bullets that best demonstrate
 *                                      this strength. Copied verbatim from episode/project
 *                                      bullets — these are the evidence "proof points".
 * @property {ItemSource} _source       Provenance — "system" when auto-generated,
 *                                      "user" or "user_approved" when human-confirmed.
 *                                      User-confirmed strengths are NEVER overwritten
 *                                      by system re-identification.
 */

/**
 * Result of the strengths identification pipeline.
 *
 * @typedef {Object} StrengthsIdentificationResult
 * @property {IdentifiedStrength[]} strengths   3-5 identified strengths (unified cross-repo)
 * @property {number}               totalEpisodes  Total evidence episodes analyzed
 * @property {number}               totalProjects  Total core projects analyzed
 * @property {string}               identifiedAt   ISO 8601 datetime of identification
 */

// ─── Narrative axes ──────────────────────────────────────────────────────────

/**
 * A narrative axis — a coherent career theme or trajectory synthesized from
 * core projects and identified strengths across all repositories.
 *
 * Unlike display axes (keyword-based lenses for filtering), narrative axes
 * represent higher-level career stories that tie together projects, strengths,
 * and decision patterns into a natural professional narrative.
 *
 * Target: 2-3 narrative axes per resume.
 *
 * Example:
 *   label: "운영 복잡도를 안정된 흐름으로 바꾸는 엔지니어"
 *   description: "결제, 예약, GPS 등 실시간 운영 시스템에서 반복되는 장애를
 *                 체계적으로 제거하고, 에러 핸들링과 재시도 로직을 통해 서비스
 *                 안정성을 꾸준히 개선."
 *   strengthIds: ["str-0", "str-2"]
 *   projectIds: ["proj-work-log-0", "proj-driving-teacher-0"]
 *
 * @typedef {Object} NarrativeAxis
 * @property {string}      id            Stable identifier — "naxis-{index}"
 * @property {string}      label         Short narrative label (1 sentence, max 60 chars)
 *                                       Describes the career theme as a professional identity
 * @property {string}      description   2-4 sentence elaboration explaining how this theme
 *                                       manifests across projects, with embedded decision reasoning
 * @property {string[]}    strengthIds   IDs of IdentifiedStrength objects that contribute to this axis.
 *                                       Each axis MUST compose ≥2 strengths — axes are higher-level
 *                                       narrative positioning built on top of multiple strengths.
 * @property {string[]}    projectIds    IDs of CoreProject objects that exemplify this axis
 * @property {string[]}    repos         Repository names covered by this axis (cross-repo)
 * @property {string[]}    supportingBullets  1-3 representative bullets that best illustrate this axis
 * @property {StrengthCompositionEntry[]} strengthComposition
 *   Denormalized strength metadata for frontend display — populated during
 *   normalization by resolving strengthIds against the full strengths list.
 *   Each entry carries the strength's label, description, and a "role" sentence
 *   explaining how that strength contributes to THIS axis narrative.
 *   This makes the axis→strength composition relationship explicit and
 *   immediately renderable without additional lookups.
 * @property {ItemSource}  _source       Provenance — "system" when auto-generated,
 *                                       "user" when edited by user
 */

/**
 * A single entry in the axis's strength composition — describes how one
 * identified strength contributes to the parent narrative axis.
 *
 * @typedef {Object} StrengthCompositionEntry
 * @property {string} strengthId     Reference to IdentifiedStrength.id
 * @property {string} label          Strength label (denormalized for display)
 * @property {string} description    Strength description (denormalized)
 * @property {string} [role]         1-sentence explanation of how this strength
 *                                   contributes to the parent axis narrative
 *                                   (populated by LLM during axis generation)
 */

/**
 * Result of the narrative axes generation pipeline.
 *
 * @typedef {Object} NarrativeAxesResult
 * @property {NarrativeAxis[]} axes          2-3 narrative axes (career themes)
 * @property {number}          totalProjects Total core projects analyzed
 * @property {number}          totalStrengths Total identified strengths analyzed
 * @property {string}          generatedAt   ISO 8601 datetime of generation
 */

// ─── Narrative threading ─────────────────────────────────────────────────────

/**
 * A bullet-level thread annotation — links a single resume bullet to the
 * strengths and narrative axes it demonstrates, grounded in specific evidence
 * episodes.
 *
 * Thread annotations are the cross-referencing mechanism that ties resume
 * content back to the underlying evidence and forward to the narrative themes.
 * They enable:
 *   - Reverse traceability: "this bullet is backed by episodes X, Y"
 *   - Theme highlighting: "this bullet demonstrates strength Z under axis A"
 *   - Narrative coherence: connecting bullets across sections under shared themes
 *
 * @typedef {Object} BulletThreadAnnotation
 * @property {string}   bulletText      The bullet text this annotation applies to
 * @property {string}   section         Resume section containing this bullet ("experience" | "projects")
 * @property {number}   itemIndex       Index of the item within the section array
 * @property {number}   bulletIndex     Index of the bullet within the item's bullets array
 * @property {string[]} strengthIds     IDs of IdentifiedStrength objects this bullet demonstrates
 * @property {string[]} axisIds         IDs of NarrativeAxis objects this bullet supports
 * @property {string[]} episodeIds      IDs of EvidenceEpisode objects that ground this bullet
 * @property {number}   confidence      Confidence score (0-1) of the annotation accuracy
 */

/**
 * A section-level narrative thread — aggregates the themes (strengths + axes)
 * that run through a single resume section item (e.g., one experience entry
 * or one project entry).
 *
 * @typedef {Object} SectionThreadSummary
 * @property {string}   section         Resume section ("experience" | "projects")
 * @property {number}   itemIndex       Index within the section array
 * @property {string}   itemLabel       Human-readable label (company name or project name)
 * @property {string[]} dominantStrengthIds  Top strengths demonstrated in this item (by bullet count)
 * @property {string[]} dominantAxisIds      Top axes this item contributes to (by bullet count)
 * @property {number}   threadedBulletCount  Number of bullets with at least one thread annotation
 * @property {number}   totalBulletCount     Total bullets in this item
 */

/**
 * The full narrative threading result — cross-references between resume
 * bullets, strengths, narrative axes, and evidence episodes.
 *
 * This is the "weaving" layer that turns isolated pipeline outputs (strengths,
 * axes, episodes) into a connected narrative fabric across resume sections.
 *
 * @typedef {Object} NarrativeThreadingResult
 * @property {BulletThreadAnnotation[]}  bulletAnnotations    Per-bullet thread annotations
 * @property {SectionThreadSummary[]}    sectionSummaries     Per-section-item thread summaries
 * @property {Object}                    strengthCoverage     Map of strengthId → { bulletCount, sections, axisIds }
 * @property {Object}                    axisCoverage         Map of axisId → { bulletCount, sections, strengthIds }
 * @property {string[]}                  ungroundedStrengthIds  Strengths with no bullet annotations (evidence gap)
 * @property {string[]}                  ungroundedAxisIds      Axes with no bullet annotations (evidence gap)
 * @property {number}                    totalAnnotations     Total bullet annotations created
 * @property {number}                    groundedRatio        Fraction of strengths+axes with ≥1 bullet (0-1)
 * @property {string}                    threadedAt           ISO 8601 datetime of threading
 */

// ─── Chat evidence data model ─────────────────────────────────────────────────

/**
 * Provenance metadata for a commit-sourced evidence record.
 *
 * Provides the minimum identifiers needed to trace an evidence item back
 * to its originating git commit.
 *
 * @typedef {Object} CommitProvenance
 * @property {"commits"}      sourceType   Always "commits"
 * @property {string}         commitHash   Short (7-char) or full git commit hash.
 *                                         Empty string when the record comes from
 *                                         a highlights/analysis line (no single commit).
 * @property {string}         repo         Repository name (e.g. "work-log")
 * @property {string|null}    authoredAt   ISO 8601 datetime of the commit;
 *                                         null when unknown (highlights lines)
 * @property {string|null}    repoPath     Absolute filesystem path to the repo;
 *                                         null when not available
 */

/**
 * Provenance metadata for a Slack-message-sourced evidence record.
 *
 * `messageId` is the Slack message timestamp string (`ts`), which Slack uses
 * as the unique message identifier within a channel.  The combination of
 * (channelId, messageId) uniquely identifies a Slack message globally.
 *
 * @typedef {Object} SlackProvenance
 * @property {"slack"}        sourceType   Always "slack"
 * @property {string}         messageId    Slack message timestamp string (ts),
 *                                         doubles as message unique ID
 * @property {string}         channelId    Slack channel ID (e.g. "C01ABCDEF")
 * @property {string|null}    permalink    Full Slack permalink URL when available;
 *                                         null when the API did not return one
 * @property {string[]}       context      Surrounding message snippets (0–2 items)
 *                                         for display context in the UI
 */

/**
 * Provenance metadata for a session-memory-sourced evidence record.
 *
 * Session memory covers both Codex and Claude AI coding assistant sessions
 * captured in the daily work-log JSON files.
 *
 * @typedef {Object} SessionProvenance
 * @property {"session"}      sourceType    Always "session"
 * @property {"codex"|"claude"|null} sessionType  AI tool that produced the session;
 *                                                null when the session log does not
 *                                                specify the tool
 * @property {string|null}    filePath      Path to the session log file on disk;
 *                                          null when not available
 * @property {string|null}    cwd           Working directory of the session;
 *                                          null when not available
 * @property {string[]}       snippets      Preview snippets from the session
 *                                          (up to 3 items; may be empty)
 */

/**
 * A single evidence record returned by the chat evidence search adapters.
 *
 * Each record represents one matching item from a data source (commits, Slack,
 * or session memory).  The `provenance` field carries source-specific identifiers
 * that allow the UI to link back to the original item and that the LLM uses to
 * cite sources without hallucinating.
 *
 * Data flow:
 *   searchAllSources() → ChatEvidenceRecord[] → chat API response.evidence
 *   → LLM prompt context → chat reply with citations
 *
 * @typedef {Object} ChatEvidenceRecord
 * @property {"commits"|"slack"|"session"}          source          Data source discriminator
 * @property {string}                               date            Work-log date YYYY-MM-DD
 * @property {string}                               text            Primary matching text
 *                                                                  (commit subject, Slack message,
 *                                                                   or session summary)
 * @property {number}                               relevanceScore  Keyword match count
 *                                                                  (0 = no keywords, returned all)
 * @property {string[]}                             matchedKeywords The subset of query keywords
 *                                                                  that were found in this record's
 *                                                                  text.  Empty array when the
 *                                                                  record was returned without
 *                                                                  keyword filtering (relevanceScore=1,
 *                                                                  keywords=[]).
 * @property {CommitProvenance|SlackProvenance|SessionProvenance} provenance
 *   Typed source-specific provenance identifiers.  Discriminated by `source` field
 *   (commits → CommitProvenance, slack → SlackProvenance, session → SessionProvenance).
 */

/**
 * Aggregated evidence result from all three data sources.
 * Returned by searchAllSources() and embedded in the chat API response.
 *
 * @typedef {Object} ChatEvidenceResult
 * @property {ChatEvidenceRecord[]} commits   Commit-sourced evidence records
 * @property {ChatEvidenceRecord[]} slack     Slack-sourced evidence records
 * @property {ChatEvidenceRecord[]} sessions  Session-memory-sourced evidence records
 * @property {number}               totalCount Total record count across all sources
 */

/**
 * A minimal source reference attached to an AppealPoint.
 *
 * Links an appeal point claim back to the specific ranked evidence record
 * (and its full provenance metadata) that backs the claim.  This enables the
 * UI to render inline citations (e.g. "[commit abc1234]", "[slack #C01…]")
 * and the user to verify every claim against its original source.
 *
 * Built by normalizeAppealPointsResult / buildHeuristicAppealPoints during
 * appeal-point generation by resolving evidence_ranks (LLM-specified or
 * heuristic) against the ranked evidence array.
 *
 * @typedef {Object} SourceRef
 * @property {"commits"|"slack"|"session"} source  Data source discriminator
 * @property {string}  date       Work-log date YYYY-MM-DD of the source record
 * @property {string}  text       The evidence text that backs this claim
 *                                (verbatim from the matched ChatEvidenceRecord)
 * @property {number}  rank       1-based rank assigned by mergeAndRankEvidence()
 * @property {CommitProvenance|SlackProvenance|SessionProvenance} provenance
 *   Full source-specific provenance metadata.  Discriminated by `source`:
 *     commits → CommitProvenance  (commitHash, repo, authoredAt, repoPath)
 *     slack   → SlackProvenance   (messageId, channelId, permalink, context)
 *     session → SessionProvenance (sessionType, filePath, cwd, snippets)
 */

/**
 * The full payload returned by POST /api/resume/chat.
 *
 * The `evidence` and `rankedEvidence` fields carry the raw search results
 * (with full provenance inside each record's `.provenance` field).
 * The `appealPoints.appealPoints[].sourceRefs` field carries the resolved
 * per-claim provenance references, making it easy for the UI to render
 * inline citations without re-joining on rank or index.
 *
 * @typedef {Object} ChatResponsePayload
 * @property {string}                   reply          Markdown-formatted chat reply text
 * @property {string|undefined}         sessionId      Client-supplied session identifier (echo)
 * @property {object|null}              parsedQuery    parseResumeQuery() output — intent, keywords,
 *                                                     section, dateRange
 * @property {ChatEvidenceResult|null}  evidence       Raw per-source search results; null when
 *                                                     no keywords were present in the query
 * @property {import('./resumeAppealPoints.mjs').RankedEvidenceRecord[]|null} rankedEvidence
 *   Merged & ranked evidence records (each carries `rank` + `rankScore` +
 *   full `provenance` metadata); null when evidence search was skipped
 * @property {import('./resumeAppealPoints.mjs').AppealPointsResult|null} appealPoints
 *   Generated appeal points with per-claim `sourceRefs`; null when evidence
 *   search was skipped
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

// ─── Chat-based resume refinement data model ─────────────────────────────────
//
// These types support the conversational resume refinement feature where a user
// chats with the system to iteratively improve their resume.  The core principle
// is that every proposed change MUST be grounded in concrete evidence from data
// sources (commits, Slack, session memory).  When evidence is insufficient, the
// system asks follow-up questions rather than fabricating content.
//
// Data flow:
//   User message
//     → parseResumeQuery → evidence search (searchAllSources)
//     → LLM generates section diff with citations
//     → UI shows diff + approve/reject per section
//     → approved diffs applied to resume/data.json
//
// Session model: ephemeral (no persistence across page reloads on MVP).
// Only approved resume edits are persisted to Vercel Blob.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated union tag for evidence data sources.
 *
 * Used throughout the chat refinement pipeline to identify which data source
 * an evidence record originates from.
 *
 * @typedef {"commits"|"slack"|"session"} EvidenceSourceType
 */

/**
 * A single evidence citation that links a proposed resume change back to its
 * originating data source.  This is the minimal, serializable reference that
 * travels with every claim in a section edit proposal.
 *
 * Design decisions:
 *   - `sourceType` discriminates the union; downstream code can switch on it
 *     to render source-appropriate UI (commit hash link, Slack permalink, etc.)
 *   - `snippet` is the verbatim text fragment from the source, capped at ~200
 *     chars — enough for inline citation display without bloating payloads.
 *   - `provenance` carries the full source-specific metadata for deep linking.
 *     It reuses the existing CommitProvenance / SlackProvenance / SessionProvenance
 *     types to avoid duplication.
 *
 * @typedef {Object} EvidenceCitation
 * @property {EvidenceSourceType}  sourceType  Data source discriminator
 * @property {string}              date        Work-log date YYYY-MM-DD of the source record
 * @property {string}              snippet     Verbatim text fragment from the source
 *                                             (truncated to ~200 chars for display)
 * @property {number}              relevance   0.0–1.0 relevance score to the current query
 * @property {CommitProvenance|SlackProvenance|SessionProvenance} provenance
 *   Full source-specific metadata for deep linking.
 *   Discriminated by `sourceType`:
 *     "commits" → CommitProvenance  (commitHash, repo, authoredAt, repoPath)
 *     "slack"   → SlackProvenance   (messageId, channelId, permalink, context)
 *     "session" → SessionProvenance (sessionType, filePath, cwd, snippets)
 */

/**
 * A proposed edit to a single resume section, generated by the chat refinement
 * LLM pipeline.  Each proposal targets exactly one section and carries the full
 * evidence chain that justifies the change.
 *
 * The user reviews one proposal at a time via the diff viewer and can
 * approve or reject it.  Approved proposals are applied to resume/data.json;
 * rejected ones are discarded (no undo on MVP).
 *
 * Section-specific `patch` shapes:
 *   - summary      : { text: string }
 *   - experience   : { itemIndex: number, bullets?: string[], title?: string, ... }
 *   - education    : { itemIndex: number, degree?: string, field?: string, ... }
 *   - skills       : { technical?: string[], languages?: string[], tools?: string[] }
 *   - projects     : { itemIndex: number, bullets?: string[], description?: string, ... }
 *   - certifications: { itemIndex: number, name?: string, issuer?: string, ... }
 *   - contact      : { email?: string, phone?: string, ... }
 *
 * @typedef {Object} SectionEditProposal
 * @property {string}              id           Stable UUID for this proposal
 * @property {SectionType}         section      Target resume section
 * @property {"add"|"update"|"delete"} action   Edit action type
 * @property {string}              description  Human-readable summary of the change (1-2 sentences)
 * @property {string}              before       Serialized current state of the affected content
 *                                              (empty string for "add" actions)
 * @property {string}              after        Serialized proposed state of the content
 *                                              (empty string for "delete" actions)
 * @property {object}              patch        Structured patch data (shape varies by section;
 *                                              see section-specific shapes above)
 * @property {EvidenceCitation[]}  citations    Evidence citations grounding this proposal;
 *                                              MUST have ≥1 citation — proposals with zero
 *                                              citations are rejected by validation
 * @property {number}              confidence   0.0–1.0 LLM confidence in this proposal
 * @property {"pending"|"approved"|"rejected"} status  Lifecycle status set by user action
 * @property {string}              createdAt    ISO 8601 datetime of proposal creation
 */

/**
 * A single message in the chat refinement conversation.
 *
 * Messages form a linear sequence within an ephemeral session.  The session
 * is not persisted — only approved SectionEditProposals survive across reloads.
 *
 * `role` follows the standard chat convention:
 *   - "user"      : human input (query, follow-up, approval command)
 *   - "assistant"  : system response (analysis, proposal, follow-up question)
 *
 * When the assistant generates section edit proposals, they are attached in
 * `proposals[]`.  The `evidenceSummary` field provides a quick overview of
 * which data sources contributed to the response.
 *
 * @typedef {Object} ChatRefinementMessage
 * @property {string}                       id               Stable UUID
 * @property {"user"|"assistant"}           role             Message author role
 * @property {string}                       content          Markdown-formatted message text
 * @property {string}                       createdAt        ISO 8601 datetime
 * @property {SectionEditProposal[]}        [proposals]      Section edit proposals (assistant only);
 *                                                           absent or empty for user messages and
 *                                                           non-proposal assistant responses
 * @property {ChatRefinementEvidenceSummary} [evidenceSummary]  Overview of evidence used
 *                                                             (assistant messages only)
 * @property {string[]}                     [followUpQuestions] Questions to ask the user when
 *                                                             evidence is insufficient (assistant only)
 * @property {string[]}                     [dataGaps]       Areas where evidence is lacking
 *                                                           (assistant only; signals to user what
 *                                                            information would improve proposals)
 */

/**
 * Summary of evidence sources consulted for a chat refinement response.
 *
 * Provides a quick glance at data coverage without requiring the user to
 * inspect individual citations.  Displayed as a collapsible panel in the
 * chat UI (e.g. "Based on 12 commits, 3 Slack messages, 2 sessions").
 *
 * @typedef {Object} ChatRefinementEvidenceSummary
 * @property {number} commitCount   Number of commit-sourced evidence records used
 * @property {number} slackCount    Number of Slack-sourced evidence records used
 * @property {number} sessionCount  Number of session-memory-sourced evidence records used
 * @property {number} totalCount    Total evidence records across all sources
 * @property {string[]} repos       Unique repository names referenced in commit evidence
 * @property {string[]} dateRange   [startDate, endDate] — YYYY-MM-DD bounds of evidence
 *                                  (2-element array; single-element when all evidence is
 *                                   from the same date)
 */

/**
 * Ephemeral chat refinement session state.
 *
 * Held in frontend memory only — NOT persisted to Vercel Blob on MVP.
 * The session tracks the conversation history and any pending proposals
 * that the user has not yet approved or rejected.
 *
 * Resume modifications flow:
 *   1. LLM generates SectionEditProposal[] in an assistant message
 *   2. User approves/rejects each proposal via the diff viewer
 *   3. Approved proposals trigger PATCH to resume/data.json
 *   4. Session continues with the updated resume as context
 *
 * @typedef {Object} ChatRefinementSession
 * @property {string}                    sessionId       Stable UUID for this session (client-generated)
 * @property {string}                    startedAt       ISO 8601 datetime of session creation
 * @property {ChatRefinementMessage[]}   messages        Ordered message history
 * @property {SectionEditProposal[]}     pendingProposals Proposals awaiting user decision
 *                                                        (subset of all proposals across messages
 *                                                         where status === "pending")
 * @property {string|null}               focusSection    Currently focused resume section (user hint);
 *                                                       null when the conversation is open-ended
 * @property {string}                    resumeSnapshotId  ID of the resume snapshot at session start,
 *                                                         used to detect concurrent edits
 */

/**
 * Request payload for the chat refinement API endpoint.
 *
 * POST /api/resume/chat/refine
 *
 * @typedef {Object} ChatRefinementRequest
 * @property {string}          message       User's chat message text
 * @property {string}          sessionId     Client-generated session UUID
 * @property {SectionType|null} [focusSection] Optional section focus hint;
 *                                            when provided, evidence search and LLM
 *                                            generation are scoped to this section
 * @property {ChatRefinementMessage[]} [history] Previous messages in the session
 *                                               (for LLM context; capped at last 10)
 */

/**
 * Response payload for the chat refinement API endpoint.
 *
 * POST /api/resume/chat/refine → ChatRefinementResponse
 *
 * @typedef {Object} ChatRefinementResponse
 * @property {ChatRefinementMessage}    message          The assistant's response message
 *                                                       (includes proposals, evidence summary, etc.)
 * @property {ChatEvidenceResult|null}  rawEvidence      Raw per-source search results; null when
 *                                                       no evidence search was performed
 * @property {string}                   sessionId        Echo of the client-supplied session ID
 */

// ─── Evidence source constants ───────────────────────────────────────────────

/**
 * Valid evidence data source type values (closed set).
 *
 * Used to discriminate provenance metadata and validate incoming evidence
 * records.  Mirrors the `EvidenceSourceType` typedef above as a runtime value.
 *
 * @type {readonly ["commits", "slack", "session"]}
 */
export const EVIDENCE_SOURCE_TYPES = /** @type {const} */ (["commits", "slack", "session"]);

/**
 * Maximum length (in characters) for an evidence citation snippet.
 * Snippets exceeding this limit are truncated with "…" by createEvidenceCitation().
 * @type {200}
 */
export const CITATION_SNIPPET_MAX_LENGTH = 200;

// ─── Normalized EvidenceItem (cross-source) ──────────────────────────────────

/**
 * A normalized evidence item from any data source.
 *
 * This is the canonical cross-source evidence type used in the chat refinement
 * pipeline (resumeChatDraftService, section chat modules).  It collapses the
 * per-source search result shapes into a flat, uniform structure suitable for
 * ranking, filtering, and LLM prompt injection.
 *
 * Compared to ChatEvidenceRecord (which preserves full provenance metadata),
 * EvidenceItem is intentionally minimal — just enough for the LLM to cite
 * sources and for the UI to show inline source tags.
 *
 * Created by normalizeToEvidenceItem() from any ChatEvidenceRecord.
 *
 * @typedef {Object} EvidenceItem
 * @property {EvidenceSourceType}  source    Data source discriminator
 * @property {string}              date      Work-log date YYYY-MM-DD
 * @property {string}              text      Primary matching text (commit subject,
 *                                           Slack message, session snippet)
 * @property {number}              score     Keyword match score 0.0–1.0
 * @property {string}              [repo]    Repository name (commits source only)
 * @property {string}              [hash]    Short commit hash (commits source only)
 * @property {string}              [permalink]  Slack permalink (slack source only)
 * @property {string}              [channelId]  Slack channel ID (slack source only)
 * @property {"codex"|"claude"|"aiReview"|null} [sessionType]  Session type (session source only)
 */

// ─── Factory / validation helpers ────────────────────────────────────────────

/**
 * Check whether a string is a valid EvidenceSourceType.
 *
 * @param {string} value
 * @returns {value is EvidenceSourceType}
 */
export function isValidEvidenceSourceType(value) {
  return EVIDENCE_SOURCE_TYPES.includes(/** @type {any} */ (value));
}

/**
 * Create a CommitProvenance object with defaults for optional fields.
 *
 * @param {Object} input
 * @param {string}      input.commitHash  Short or full git commit hash
 * @param {string}      input.repo        Repository name
 * @param {string|null} [input.authoredAt]  ISO 8601 datetime; defaults to null
 * @param {string|null} [input.repoPath]    Filesystem path to repo; defaults to null
 * @returns {CommitProvenance}
 */
export function createCommitProvenance({ commitHash, repo, authoredAt = null, repoPath = null }) {
  return {
    sourceType: "commits",
    commitHash: typeof commitHash === "string" ? commitHash : "",
    repo: typeof repo === "string" ? repo : "",
    authoredAt: authoredAt ?? null,
    repoPath: repoPath ?? null,
  };
}

/**
 * Create a SlackProvenance object with defaults for optional fields.
 *
 * @param {Object} input
 * @param {string}      input.messageId   Slack message timestamp string (ts)
 * @param {string}      input.channelId   Slack channel ID
 * @param {string|null} [input.permalink]  Slack permalink URL; defaults to null
 * @param {string[]}    [input.context]    Surrounding messages; defaults to []
 * @returns {SlackProvenance}
 */
export function createSlackProvenance({ messageId, channelId, permalink = null, context = [] }) {
  return {
    sourceType: "slack",
    messageId: typeof messageId === "string" ? messageId : "",
    channelId: typeof channelId === "string" ? channelId : "",
    permalink: permalink ?? null,
    context: Array.isArray(context) ? context : [],
  };
}

/**
 * Create a SessionProvenance object with defaults for optional fields.
 *
 * @param {Object} input
 * @param {"codex"|"claude"|null} [input.sessionType]  AI tool type; defaults to null
 * @param {string|null}           [input.filePath]      Session log path; defaults to null
 * @param {string|null}           [input.cwd]           Working directory; defaults to null
 * @param {string[]}              [input.snippets]      Preview snippets; defaults to []
 * @returns {SessionProvenance}
 */
export function createSessionProvenance({ sessionType = null, filePath = null, cwd = null, snippets = [] } = {}) {
  return {
    sourceType: "session",
    sessionType: sessionType ?? null,
    filePath: filePath ?? null,
    cwd: cwd ?? null,
    snippets: Array.isArray(snippets) ? snippets.slice(0, 3) : [],
  };
}

/**
 * Create an EvidenceCitation from a ChatEvidenceRecord or similar source data.
 *
 * Truncates the snippet to CITATION_SNIPPET_MAX_LENGTH characters.
 * Validates that sourceType is a known EvidenceSourceType.
 *
 * @param {Object} input
 * @param {EvidenceSourceType} input.sourceType  Data source discriminator
 * @param {string}             input.date        YYYY-MM-DD
 * @param {string}             input.snippet     Source text fragment
 * @param {number}             input.relevance   0.0–1.0 relevance score
 * @param {CommitProvenance|SlackProvenance|SessionProvenance} input.provenance
 * @returns {EvidenceCitation}
 * @throws {Error} If sourceType is invalid
 */
export function createEvidenceCitation({ sourceType, date, snippet, relevance, provenance }) {
  if (!isValidEvidenceSourceType(sourceType)) {
    throw new Error(`Invalid evidence source type: "${sourceType}". Must be one of: ${EVIDENCE_SOURCE_TYPES.join(", ")}`);
  }
  const trimmedSnippet = typeof snippet === "string" ? snippet : "";
  return {
    sourceType,
    date: typeof date === "string" ? date : "",
    snippet: trimmedSnippet.length > CITATION_SNIPPET_MAX_LENGTH
      ? trimmedSnippet.slice(0, CITATION_SNIPPET_MAX_LENGTH - 1) + "…"
      : trimmedSnippet,
    relevance: typeof relevance === "number" ? Math.max(0, Math.min(1, relevance)) : 0,
    provenance,
  };
}

/**
 * Normalize a ChatEvidenceRecord into the flat EvidenceItem shape.
 *
 * Extracts source-specific fields (repo, hash, permalink, channelId, sessionType)
 * from the record's provenance and promotes them to top-level optional fields.
 *
 * @param {ChatEvidenceRecord} record  A single evidence record from search results
 * @returns {EvidenceItem}
 */
export function normalizeToEvidenceItem(record) {
  if (!record || typeof record !== "object") {
    return { source: "commits", date: "", text: "", score: 0 };
  }

  const base = {
    source: record.source ?? "commits",
    date: record.date ?? "",
    text: record.text ?? "",
    score: record.relevanceScore ?? 0,
  };

  const prov = record.provenance;
  if (!prov) return base;

  if (prov.sourceType === "commits") {
    return {
      ...base,
      repo: prov.repo || undefined,
      hash: prov.commitHash || undefined,
    };
  }

  if (prov.sourceType === "slack") {
    return {
      ...base,
      permalink: prov.permalink || undefined,
      channelId: prov.channelId || undefined,
    };
  }

  if (prov.sourceType === "session") {
    return {
      ...base,
      sessionType: prov.sessionType || undefined,
    };
  }

  return base;
}

/**
 * Build a ChatRefinementEvidenceSummary from a ChatEvidenceResult.
 *
 * Counts records per source, collects unique repo names, and computes
 * the date range across all evidence records.
 *
 * @param {ChatEvidenceResult|null} evidence  Raw evidence result from searchAllSources
 * @returns {ChatRefinementEvidenceSummary}
 */
export function buildEvidenceSummary(evidence) {
  if (!evidence) {
    return {
      commitCount: 0,
      slackCount: 0,
      sessionCount: 0,
      totalCount: 0,
      repos: [],
      dateRange: [],
    };
  }

  const commits = evidence.commits ?? [];
  const slack = evidence.slack ?? [];
  const sessions = evidence.sessions ?? [];

  const repos = [...new Set(
    commits
      .map((r) => r.provenance?.repo)
      .filter(Boolean)
  )];

  const allDates = [...commits, ...slack, ...sessions]
    .map((r) => r.date)
    .filter(Boolean)
    .sort();

  const dateRange = allDates.length === 0
    ? []
    : allDates.length === 1 || allDates[0] === allDates[allDates.length - 1]
      ? [allDates[0]]
      : [allDates[0], allDates[allDates.length - 1]];

  return {
    commitCount: commits.length,
    slackCount: slack.length,
    sessionCount: sessions.length,
    totalCount: commits.length + slack.length + sessions.length,
    repos,
    dateRange,
  };
}
