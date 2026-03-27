/**
 * Resume × Work-Log Rule-Based Diff
 *
 * Pure function module. Compares an existing resume document against a
 * work-log entry's candidate bullets using rule-based logic only (no LLM).
 *
 * Identifies three categories of candidates:
 *
 *   addCandidates      — bullets not yet in the resume (genuinely new content)
 *   replaceCandidates  — bullets highly similar to an existing bullet
 *                        (word-overlap ≥ SIMILARITY_THRESHOLD) that might
 *                        replace the existing one as an improved version
 *   newSkillKeywords   — individual technical-skill tokens extracted from
 *                        candidate bullets that are absent from the resume
 *                        skills section
 *
 * Relationship to the LLM-based pipeline:
 *   When the LLM is available the preferred pipeline is:
 *     workLog → extractResumeUpdatesFromWorkLog (LLM)
 *             → mergeWorkLogIntoResume
 *             → diffResume
 *             → diffToSuggestions
 *
 *   This module provides a rule-based fast-path that can be used:
 *     • As a lightweight fallback when OPENAI_API_KEY is not set
 *     • As a pre-filter before LLM processing to reduce unnecessary API calls
 *     • For offline / test environments
 *
 * Design principles:
 *   • Pure function — no side effects, no I/O, no mutations.
 *   • Rule-based only — deterministic; no external API calls.
 *   • Self-contained — no imports from other project modules.
 *   • Provenance-aware — user-owned items (_source: "user" | "user_approved")
 *     are flagged so callers can treat them with higher priority.
 *
 * @module resumeWorkLogDiff
 */

// ─── Public constants ─────────────────────────────────────────────────────────

/**
 * Default word-overlap similarity threshold for classifying a candidate bullet
 * as a replace candidate (vs a plain add).  Value is in [0, 1].
 *
 * A candidate bullet scoring strictly above this value against an existing
 * resume bullet is treated as a potential replacement (replace candidate).
 * Candidates at or below the threshold are treated as genuinely new content
 * (add candidates).
 *
 * @type {number}
 */
export const SIMILARITY_THRESHOLD = 0.5;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Diff an existing resume against work-log entry candidates using rule-based logic.
 *
 * Both arguments are treated as read-only; neither is mutated.
 * Passing null / undefined for either argument is safe — the function returns
 * an empty result with `isEmpty: true`.
 *
 * @param {object|null|undefined} resume
 *   Existing resume document.  Any schema version is accepted; missing fields
 *   are treated as empty arrays / objects.
 * @param {WorkLogEntry|null|undefined} workLogEntry
 *   Work-log entry containing raw candidate bullet strings in `candidates`.
 * @param {number} [similarityThreshold]
 *   Override for the default SIMILARITY_THRESHOLD.  Must be in [0, 1].
 * @returns {WorkLogDiffResult}
 */
export function diffResumeWithWorkLog(
  resume,
  workLogEntry,
  similarityThreshold = SIMILARITY_THRESHOLD
) {
  if (!resume || typeof resume !== "object") return _emptyResult();
  if (!workLogEntry || typeof workLogEntry !== "object") return _emptyResult();

  const candidateTexts = _extractCandidates(workLogEntry);
  if (candidateTexts.length === 0) return _emptyResult();

  // ── Build lookup structures from existing resume ──────────────────────────
  const existingBullets = _extractAllBullets(resume);
  const existingBulletNorms = new Set(
    existingBullets.map((b) => _normalizeStr(b.text))
  );
  const existingSkillNorms = _buildSkillNormSet(resume.skills);

  // ── Classify each candidate ───────────────────────────────────────────────
  const addCandidates = [];
  const replaceCandidates = [];
  /** @type {Map<string, string>} norm → original text */
  const newSkillMap = new Map();

  for (const raw of candidateTexts) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;

    // (1) Extract skill keywords from this candidate — regardless of
    //     whether the full bullet is new or covered.
    const skills = _extractSkillKeywords(trimmed);
    for (const skill of skills) {
      const skillNorm = _normalizeStr(skill);
      if (skillNorm && !existingSkillNorms.has(skillNorm) && !newSkillMap.has(skillNorm)) {
        newSkillMap.set(skillNorm, skill);
        // Add to existingSkillNorms immediately to avoid intra-batch duplicates.
        existingSkillNorms.add(skillNorm);
      }
    }

    // (2) Already in resume verbatim (normalised match) → skip; content covered.
    const norm = _normalizeStr(trimmed);
    if (existingBulletNorms.has(norm)) continue;

    // (3) Check similarity against all existing resume bullets.
    const bestMatch = _findBestMatch(trimmed, existingBullets, similarityThreshold);

    if (bestMatch) {
      // Similar enough to an existing bullet → treat as a replace candidate.
      replaceCandidates.push({
        candidate: trimmed,
        existingBullet: bestMatch.text,
        similarity: bestMatch.score,
        section: bestMatch.section,
        sectionIndex: bestMatch.sectionIndex,
        userOwned: bestMatch.userOwned
      });
    } else {
      // Genuinely new content — infer which resume section it belongs to.
      addCandidates.push({
        text: trimmed,
        section: _inferSection(trimmed)
      });
    }
  }

  const newSkillKeywords = [...newSkillMap.values()];

  const isEmpty =
    addCandidates.length === 0 &&
    replaceCandidates.length === 0 &&
    newSkillKeywords.length === 0;

  return {
    addCandidates,
    replaceCandidates,
    newSkillKeywords,
    isEmpty,
    date: typeof workLogEntry.date === "string" ? workLogEntry.date : null
  };
}

// ─── Candidate extraction ─────────────────────────────────────────────────────

/**
 * Extract all candidate bullet strings from a WorkLogEntry.
 * Uses the combined `candidates` array which is the authoritative list.
 *
 * @param {WorkLogEntry} entry
 * @returns {string[]}
 */
function _extractCandidates(entry) {
  const all = Array.isArray(entry.candidates) ? entry.candidates : [];
  return all
    .map((c) => String(c ?? "").trim())
    // Require at least one word character — discard pure-punctuation strings
    // like "---" or "..." that carry no semantic content.
    .filter((c) => c && /\w/.test(c));
}

// ─── Resume bullet extraction ─────────────────────────────────────────────────

/**
 * Flatten all bullets from the experience and projects sections into a
 * uniform list suitable for similarity matching.
 *
 * @param {object} resume
 * @returns {ExistingBullet[]}
 */
function _extractAllBullets(resume) {
  const bullets = [];

  const experience = Array.isArray(resume.experience) ? resume.experience : [];
  for (let i = 0; i < experience.length; i++) {
    const entry = experience[i];
    if (!entry || typeof entry !== "object") continue;
    const userOwned =
      entry._source === "user" || entry._source === "user_approved";
    const entryBullets = Array.isArray(entry.bullets) ? entry.bullets : [];
    for (const bullet of entryBullets) {
      const text = String(bullet ?? "").trim();
      if (text) {
        bullets.push({ text, section: "experience", sectionIndex: i, userOwned });
      }
    }
  }

  const projects = Array.isArray(resume.projects) ? resume.projects : [];
  for (let i = 0; i < projects.length; i++) {
    const proj = projects[i];
    if (!proj || typeof proj !== "object") continue;
    const userOwned =
      proj._source === "user" || proj._source === "user_approved";
    const projBullets = Array.isArray(proj.bullets) ? proj.bullets : [];
    for (const bullet of projBullets) {
      const text = String(bullet ?? "").trim();
      if (text) {
        bullets.push({ text, section: "projects", sectionIndex: i, userOwned });
      }
    }
  }

  return bullets;
}

// ─── Skills normalisation ─────────────────────────────────────────────────────

/**
 * Build a normalised Set of every skill string listed in the resume's skills
 * section (technical + languages + tools).
 *
 * @param {object|undefined} skills
 * @returns {Set<string>}
 */
function _buildSkillNormSet(skills) {
  const s =
    skills && typeof skills === "object" && !Array.isArray(skills) ? skills : {};
  const all = [
    ...(Array.isArray(s.technical) ? s.technical : []),
    ...(Array.isArray(s.languages) ? s.languages : []),
    ...(Array.isArray(s.tools) ? s.tools : [])
  ];
  return new Set(all.map((sk) => _normalizeStr(sk)).filter(Boolean));
}

// ─── Skill keyword extraction ─────────────────────────────────────────────────

/**
 * Recognised technical skill patterns.
 *
 * Each entry is a regex that matches one or more skill tokens.  Patterns use
 * the `gi` flag so they work case-insensitively and return the matched casing
 * from the original text.
 *
 * The list mirrors the patterns used by inferSuggestedSection() in
 * resumeDailyBullets.mjs for consistency across the system.
 */
const _SKILL_PATTERNS = /** @type {RegExp[]} */ ([
  /\b(typescript|javascript|python|rust|go|golang|java|kotlin|swift|c\+\+|c#)\b/gi,
  /\b(react|vue|angular|svelte|preact|next\.?js|nuxt|remix)\b/gi,
  /\b(node\.?js|deno|bun|fastapi|django|flask|spring|rails)\b/gi,
  /\b(docker|kubernetes|k8s|terraform|ansible|helm)\b/gi,
  /\b(aws|gcp|azure|vercel|netlify|cloudflare)\b/gi,
  /\b(postgresql|mysql|sqlite|mongodb|redis|elasticsearch)\b/gi,
  /\b(graphql|grpc|websocket)\b/gi,
  /\b(llm|gpt|claude|openai|anthropic|langchain|rag)\b/gi,
  /\b(webpack|vite|rollup|esbuild|babel)\b/gi,
  /\b(jest|vitest|playwright|cypress|storybook)\b/gi
]);

/**
 * Extract individual technical skill token strings from a bullet.
 * Returns an array of original-casing matched tokens (deduplicated within the call).
 *
 * @param {string} text
 * @returns {string[]}
 */
function _extractSkillKeywords(text) {
  /** @type {Map<string, string>} lowercase → original */
  const found = new Map();
  for (const pattern of _SKILL_PATTERNS) {
    // Reset lastIndex before each use (gi flags maintain state across calls)
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const token = m[0].trim();
      const lower = token.toLowerCase();
      if (!found.has(lower)) found.set(lower, token);
    }
  }
  return [...found.values()];
}

// ─── Section inference ────────────────────────────────────────────────────────

/**
 * Patterns that suggest a bullet belongs in the "projects" section.
 * @type {RegExp[]}
 */
const _PROJECT_PATTERNS = [
  /\bopen[\s-]?source\b/i,
  /\bproject\b/i,
  /\blibrary\b/i,
  /\bpackage\b/i,
  /\bplugin\b/i,
  /\bcontrib(ut(ion|ed))?\b/i
];

/**
 * Infer the most appropriate resume section for a candidate bullet string.
 *
 * Heuristic rules (first match wins):
 *   1. "projects" — contains project / open-source / library / contrib keywords
 *   2. "experience" — default (work activity)
 *
 * Note: full sentence candidates are never classified as "skills" — individual
 * skill tokens are extracted separately into `newSkillKeywords`.
 *
 * @param {string} text
 * @returns {"experience"|"projects"}
 */
function _inferSection(text) {
  if (_PROJECT_PATTERNS.some((re) => re.test(text))) return "projects";
  return "experience";
}

// ─── Similarity matching ──────────────────────────────────────────────────────

/**
 * Find the existing resume bullet that best matches the candidate text.
 * Returns null when no match exceeds the threshold.
 *
 * @param {string} candidate
 * @param {ExistingBullet[]} existing
 * @param {number} threshold  Minimum score to form a match (strictly greater).
 * @returns {(ExistingBullet & { score: number })|null}
 */
function _findBestMatch(candidate, existing, threshold) {
  let bestScore = threshold; // strictly greater-than threshold required
  let bestItem = null;

  for (const item of existing) {
    const score = _bulletSimilarity(candidate, item.text);
    if (score > bestScore) {
      bestScore = score;
      bestItem = { ...item, score };
    }
  }

  return bestItem;
}

// ─── String helpers ────────────────────────────────────────────────────────────

/**
 * Compute word-overlap (Jaccard-like) similarity between two bullet strings.
 * Considers only "significant" words (length > 3) to reduce noise from
 * common short tokens (prepositions, articles, etc.).  Score is in [0, 1].
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _bulletSimilarity(a, b) {
  const setA = _significantWords(a);
  const setB = _significantWords(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const w of setA) {
    if (setB.has(w)) common++;
  }
  return common / Math.max(setA.size, setB.size);
}

/**
 * Extract a Set of lowercase "significant" word tokens (length > 3).
 *
 * @param {string} str
 * @returns {Set<string>}
 */
function _significantWords(str) {
  return new Set(
    String(str ?? "")
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((w) => w.length > 3)
  );
}

/**
 * Normalise a string for identity comparison.
 * Lower-cases, trims, collapses whitespace, strips common punctuation.
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

// ─── Empty result factory ─────────────────────────────────────────────────────

/**
 * @returns {WorkLogDiffResult}
 */
function _emptyResult() {
  return {
    addCandidates: [],
    replaceCandidates: [],
    newSkillKeywords: [],
    isEmpty: true,
    date: null
  };
}

// ─── JSDoc type definitions ───────────────────────────────────────────────────

/**
 * Work-log entry interface at the system boundary.
 * Treated as external / read-only input — never mutated by this module.
 *
 * @typedef {Object} WorkLogEntry
 * @property {string}   date                 ISO date YYYY-MM-DD
 * @property {string[]} candidates           Combined raw bullet candidate strings
 * @property {string[]} [companyCandidates]  Subset from company-owned repos
 * @property {string[]} [openSourceCandidates]  Subset from open-source repos
 */

/**
 * A candidate bullet to add to the resume (not yet present).
 *
 * @typedef {Object} AddCandidate
 * @property {string}                   text     Raw bullet text
 * @property {"experience"|"projects"}  section  Inferred resume section
 */

/**
 * An existing bullet in the resume, used as a match target.
 *
 * @typedef {Object} ExistingBullet
 * @property {string}                   text          Bullet text
 * @property {"experience"|"projects"}  section       Section containing the bullet
 * @property {number}                   sectionIndex  Index in the section array
 * @property {boolean}                  userOwned     true when _source is "user"|"user_approved"
 */

/**
 * A candidate bullet that is similar to an existing resume bullet and might
 * replace it with an improved version.
 *
 * @typedef {Object} ReplaceCandidate
 * @property {string}                   candidate      Incoming bullet text (from work log)
 * @property {string}                   existingBullet Most similar existing resume bullet
 * @property {number}                   similarity     Word-overlap score in (threshold, 1]
 * @property {"experience"|"projects"}  section        Section of the matched existing bullet
 * @property {number}                   sectionIndex   Index in the section array
 * @property {boolean}                  userOwned      true when existing item is user-owned
 */

/**
 * Output of diffResumeWithWorkLog.
 *
 * @typedef {Object} WorkLogDiffResult
 * @property {AddCandidate[]}     addCandidates     Bullets not yet in the resume
 * @property {ReplaceCandidate[]} replaceCandidates Bullets similar to existing ones
 * @property {string[]}           newSkillKeywords  Skill tokens absent from resume skills
 * @property {boolean}            isEmpty           true when no candidates were found
 * @property {string|null}        date              Source work-log date (YYYY-MM-DD)
 */
