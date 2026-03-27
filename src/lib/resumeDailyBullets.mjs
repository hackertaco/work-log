/**
 * resumeDailyBullets.mjs — Intermediate cache for daily resume bullet candidates.
 *
 * PURPOSE
 * -------
 * This module bridges the gap between the raw daily work-log batch output and
 * the polished resume suggestions stored in `resume/suggestions.json`.
 *
 * When the daily batch runs, it produces `resume.candidates` — an array of
 * short bullet strings derived from git commits, AI session summaries, and
 * theme analysis.  These raw strings are stored here as a per-day intermediate
 * cache so that:
 *
 *   1. The /resume UI can present unapproved bullets for a given date.
 *   2. Each bullet's status ("pending" / "promoted" / "dismissed") is tracked
 *      independently of the suggestions system.
 *   3. When the user triggers "Generate suggestions from work logs", this cache
 *      is the authoritative input — not the local data/daily/ files.
 *   4. If a bullet is promoted to a suggestion, its `promotedSuggestionId`
 *      is stored here, enabling deduplication on subsequent runs.
 *
 * SCHEMA (schemaVersion: 1)
 * -------------------------
 * DailyBulletsDocument:
 *   {
 *     schemaVersion:     1,
 *     date:              "YYYY-MM-DD",          // work-log date
 *     generatedAt:       ISO string,            // last write timestamp
 *     sourceType:        "work_log_batch",      // always this value for Day 1
 *     sourceEntryId:     "YYYY-MM-DD",          // work-log entry that triggered generation
 *     invalidatedAt:     ISO string | null,     // set when entry is explicitly invalidated
 *     invalidationReason: string | null,        // human-readable reason for invalidation
 *     bullets:           DailyBulletItem[]
 *   }
 *
 * DailyBulletItem:
 *   {
 *     id:                   string,          // "bullet-{date}-{index}"  (stable, deterministic)
 *     text:                 string,          // raw bullet text
 *     category:             "company" | "opensource" | "other",
 *     suggestedSection:     "experience" | "skills" | "projects",
 *     status:               "pending" | "promoted" | "dismissed",
 *     promotedSuggestionId: string | null,   // populated when status === "promoted"
 *     createdAt:            ISO string,
 *     sourceEntryId:        "YYYY-MM-DD"     // work-log date that generated this bullet
 *   }
 *
 * STATUS LIFECYCLE
 * ----------------
 *   pending   → promoted    (user or auto-promotion creates a suggestion)
 *   pending   → dismissed   (user explicitly discards the bullet)
 *   promoted  → (terminal)  — no further transitions
 *   dismissed → pending     (user un-dismisses — optional future feature)
 *
 * STORAGE
 * -------
 * Each document is stored in Vercel Blob at:
 *   resume/bullets/{YYYY-MM-DD}.json
 *
 * See src/lib/blob.mjs for the low-level put/list/fetch calls.
 */

export const DAILY_BULLETS_SCHEMA_VERSION = 1;

// ─── Schema constants ──────────────────────────────────────────────────────────

/** Valid category values for a DailyBulletItem. */
export const BULLET_CATEGORIES = /** @type {const} */ (["company", "opensource", "other"]);

/** Valid suggested-section values for a DailyBulletItem. */
export const BULLET_SUGGESTED_SECTIONS = /** @type {const} */ (["experience", "skills", "projects"]);

/** Valid status values for a DailyBulletItem. */
export const BULLET_STATUSES = /** @type {const} */ (["pending", "promoted", "dismissed"]);

// ─── Document builder ─────────────────────────────────────────────────────────

/**
 * Build a DailyBulletsDocument from the `resume` section of a daily summary.
 *
 * This is the primary entry point for converting raw work-log batch output
 * into the structured intermediate cache format.
 *
 * @param {string} date  ISO date string YYYY-MM-DD
 * @param {object} dailyResume  The `resume` sub-object from a daily summary:
 *   {
 *     candidates:           string[],   // combined resume bullet candidates
 *     companyCandidates:    string[],   // candidates from company repos
 *     openSourceCandidates: string[]    // candidates from open-source repos
 *   }
 * @param {string} [sourceEntryId]  The work-log entry identifier that triggered
 *   generation.  Defaults to `date` when omitted (the date is the canonical
 *   work-log entry key).
 * @returns {object}  DailyBulletsDocument ready to be passed to saveDailyBullets()
 */
export function buildDailyBulletsDocument(date, dailyResume, sourceEntryId = date) {
  const now = new Date().toISOString();
  const resolvedSourceEntryId = String(sourceEntryId ?? date);

  const {
    candidates = [],
    companyCandidates = [],
    openSourceCandidates = []
  } = dailyResume ?? {};

  // Build a deduplicated list of bullets while preserving category provenance.
  // companyCandidates and openSourceCandidates are subsets of candidates; we
  // annotate category first, then fill the remainder as "other".

  const companySet = new Set(companyCandidates.map(normaliseText));
  const osSet = new Set(openSourceCandidates.map(normaliseText));

  /** @type {import('../lib/resumeTypes.mjs').DailyBulletItem[]} */
  const bullets = [];
  const seen = new Set();

  let index = 0;
  for (const text of candidates) {
    const norm = normaliseText(text);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);

    const category = companySet.has(norm)
      ? "company"
      : osSet.has(norm)
        ? "opensource"
        : "other";

    bullets.push({
      id: `bullet-${date}-${index}`,
      text: text.trim(),
      category,
      suggestedSection: inferSuggestedSection(text),
      status: "pending",
      promotedSuggestionId: null,
      createdAt: now,
      sourceEntryId: resolvedSourceEntryId
    });

    index++;
  }

  return {
    schemaVersion: DAILY_BULLETS_SCHEMA_VERSION,
    date,
    generatedAt: now,
    sourceType: "work_log_batch",
    sourceEntryId: resolvedSourceEntryId,
    invalidatedAt: null,
    invalidationReason: null,
    bullets
  };
}

/**
 * Merge a freshly-generated DailyBulletsDocument with an existing cached
 * document for the same date.
 *
 * Rules:
 *   - Bullets already in the existing cache keep their current status and
 *     `promotedSuggestionId` (user edits / promotions are preserved).
 *   - New bullets from the fresh document that do not appear in the cache
 *     are appended with status "pending".
 *   - Bullets in the cache that are absent from the fresh document are
 *     retained as-is (they may represent manually-added bullets in future
 *     extensions, and removing them would be destructive).
 *
 * Deduplication is by normalised text value.
 *
 * @param {object} existingDoc  Previously saved DailyBulletsDocument (or null)
 * @param {object} freshDoc     Newly-built DailyBulletsDocument
 * @returns {object}            Merged DailyBulletsDocument
 */
export function mergeDailyBulletsDocuments(existingDoc, freshDoc) {
  if (!existingDoc || !Array.isArray(existingDoc.bullets)) {
    return freshDoc;
  }

  const existingByNorm = new Map(
    existingDoc.bullets.map((b) => [normaliseText(b.text), b])
  );

  const merged = existingDoc.bullets.map((b) => ({ ...b }));
  const mergedNorms = new Set(merged.map((b) => normaliseText(b.text)));

  for (const newBullet of freshDoc.bullets) {
    const norm = normaliseText(newBullet.text);
    if (!mergedNorms.has(norm)) {
      merged.push({ ...newBullet });
      mergedNorms.add(norm);
    }
  }

  // Suppress unused variable warning — existingByNorm is used for the has() check above.
  void existingByNorm;

  return {
    ...existingDoc,
    generatedAt: freshDoc.generatedAt,
    bullets: merged
  };
}

/**
 * Mark a bullet as promoted and record the resulting suggestion ID.
 *
 * Returns a new document; the original is not mutated.
 *
 * @param {object} doc           DailyBulletsDocument
 * @param {string} bulletId      The `id` of the bullet to promote
 * @param {string} suggestionId  The suggestion ID it was promoted to
 * @returns {object}             Updated DailyBulletsDocument
 * @throws {Error}               When bulletId is not found or bullet is not pending
 */
export function promoteBullet(doc, bulletId, suggestionId) {
  const idx = (doc.bullets ?? []).findIndex((b) => b.id === bulletId);
  if (idx === -1) {
    throw new Error(`Bullet not found: ${bulletId}`);
  }

  const bullet = doc.bullets[idx];
  if (bullet.status !== "pending") {
    throw new Error(
      `Cannot promote bullet "${bulletId}" — current status is "${bullet.status}"`
    );
  }

  const updatedBullets = doc.bullets.map((b, i) =>
    i === idx
      ? { ...b, status: "promoted", promotedSuggestionId: suggestionId }
      : b
  );

  return { ...doc, generatedAt: new Date().toISOString(), bullets: updatedBullets };
}

/**
 * Mark a bullet as dismissed.
 *
 * Returns a new document; the original is not mutated.
 *
 * @param {object} doc       DailyBulletsDocument
 * @param {string} bulletId  The `id` of the bullet to dismiss
 * @returns {object}         Updated DailyBulletsDocument
 * @throws {Error}           When bulletId is not found or bullet is not pending
 */
export function dismissBullet(doc, bulletId) {
  const idx = (doc.bullets ?? []).findIndex((b) => b.id === bulletId);
  if (idx === -1) {
    throw new Error(`Bullet not found: ${bulletId}`);
  }

  const bullet = doc.bullets[idx];
  if (bullet.status !== "pending") {
    throw new Error(
      `Cannot dismiss bullet "${bulletId}" — current status is "${bullet.status}"`
    );
  }

  const updatedBullets = doc.bullets.map((b, i) =>
    i === idx ? { ...b, status: "dismissed" } : b
  );

  return { ...doc, generatedAt: new Date().toISOString(), bullets: updatedBullets };
}

/**
 * Edit the text of a pending bullet.
 *
 * Only pending bullets may be edited — promoted and dismissed bullets are
 * considered finalised.  The `suggestedSection` is re-inferred from the new
 * text so that section routing remains accurate after an edit.
 *
 * Returns a new document; the original is not mutated.
 *
 * @param {object} doc       DailyBulletsDocument
 * @param {string} bulletId  The `id` of the bullet to edit
 * @param {string} newText   Replacement bullet text (trimmed; must be non-empty)
 * @returns {object}         Updated DailyBulletsDocument
 * @throws {Error}           When bulletId not found, bullet is not pending, or newText is empty
 */
export function editBullet(doc, bulletId, newText) {
  const trimmed = String(newText ?? "").trim();
  if (!trimmed) {
    throw new Error("Bullet text must not be empty");
  }

  const idx = (doc.bullets ?? []).findIndex((b) => b.id === bulletId);
  if (idx === -1) {
    throw new Error(`Bullet not found: ${bulletId}`);
  }

  const bullet = doc.bullets[idx];
  if (bullet.status !== "pending") {
    throw new Error(
      `Cannot edit bullet "${bulletId}" — current status is "${bullet.status}"`
    );
  }

  const updatedBullets = doc.bullets.map((b, i) =>
    i === idx
      ? { ...b, text: trimmed, suggestedSection: inferSuggestedSection(trimmed) }
      : b
  );

  return { ...doc, generatedAt: new Date().toISOString(), bullets: updatedBullets };
}

/**
 * Return only the pending bullets from a DailyBulletsDocument.
 *
 * @param {object} doc  DailyBulletsDocument
 * @returns {object[]}  Array of DailyBulletItem with status === "pending"
 */
export function getPendingBullets(doc) {
  return (doc?.bullets ?? []).filter((b) => b.status === "pending");
}

/**
 * Mark a DailyBulletsDocument as explicitly invalidated.
 *
 * Sets `invalidatedAt` to the current timestamp and records the
 * `invalidationReason`.  Future consumers that check `invalidatedAt`
 * should treat the document as stale and regenerate.
 *
 * Returns a new document; the original is not mutated.
 *
 * @param {object} doc               DailyBulletsDocument to invalidate
 * @param {string} [reason="explicit"] Human-readable reason for invalidation
 * @returns {object}                 Updated DailyBulletsDocument with invalidation fields set
 * @throws {Error}                   When doc is null or not a valid DailyBulletsDocument
 */
export function invalidateDailyBulletsDocument(doc, reason = "explicit") {
  if (!doc || typeof doc !== "object") {
    throw new Error("invalidateDailyBulletsDocument: doc must be a non-null object");
  }
  if (doc.schemaVersion !== DAILY_BULLETS_SCHEMA_VERSION) {
    throw new Error(
      `invalidateDailyBulletsDocument: unsupported schemaVersion ${doc.schemaVersion}`
    );
  }

  return {
    ...doc,
    invalidatedAt: new Date().toISOString(),
    invalidationReason: String(reason)
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Normalise a bullet text for deduplication comparisons.
 * Lower-cases, trims, and collapses whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
function normaliseText(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Infer the most appropriate resume section for a raw bullet string.
 *
 * Heuristic rules (order matters — first match wins):
 *   "skills" section  → contains skill-like keywords
 *   "projects" section → mentions project, open-source, or standalone work
 *   "experience" section → default (work activity)
 *
 * @param {string} text
 * @returns {"experience"|"skills"|"projects"}
 */
function inferSuggestedSection(text) {
  const lower = String(text).toLowerCase();

  const skillPatterns = [
    /\b(typescript|javascript|python|rust|go|java|kotlin|swift|c\+\+|c#)\b/,
    /\b(react|vue|angular|svelte|preact|next\.?js|nuxt|remix)\b/,
    /\b(node\.?js|deno|bun|fastapi|django|flask|spring|rails)\b/,
    /\b(docker|kubernetes|k8s|terraform|ansible|helm)\b/,
    /\b(aws|gcp|azure|vercel|netlify|cloudflare)\b/,
    /\b(postgresql|mysql|sqlite|mongodb|redis|elasticsearch)\b/,
    /\b(git|github|gitlab|ci\/cd|github actions)\b/,
    /\b(sql|graphql|rest\s*api|grpc|websocket)\b/
  ];

  const projectPatterns = [
    /\bopen[\s-]?source\b/,
    /\bproject\b/,
    /\blibrary\b/,
    /\bpackage\b/,
    /\bplugin\b/,
    /\bcontrib(ut(ion|ed))?\b/
  ];

  if (skillPatterns.some((re) => re.test(lower))) return "skills";
  if (projectPatterns.some((re) => re.test(lower))) return "projects";
  return "experience";
}
