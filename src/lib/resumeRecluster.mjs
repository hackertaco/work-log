/**
 * Conditional Re-clustering Pipeline + Core Projects Extraction
 *
 * This module provides two main pipelines:
 *
 * ═══ 1. Keyword Re-clustering (Sub-AC 17-3) ═══
 * Monitors the ratio of unclassified keywords — keywords present in the
 * resume or recent work logs that are NOT assigned to any existing display axis
 * — and automatically triggers a new LLM clustering pass when that ratio
 * exceeds a configurable threshold (default 30 %).
 *
 * The resulting new axes are merged with the existing set, respecting user
 * provenance: axes whose `_source === "user"` are never overwritten.
 *
 * ═══ 2. Core Projects Extraction (Living Resume Pipeline) ═══
 * Analyzes a single repo's work logs and session conversations to identify
 * ~2 representative core projects with titles, descriptions, and supporting
 * evidence episodes.
 *
 * Episode grouping uses semantic topic + functional module unit (LLM-judged).
 * Decision reasoning from session conversations is naturally embedded in
 * bullet text, not stored as separate metadata.
 *
 * Public API:
 *   reclusterPipeline(resume, workLogs, options)  → Promise<ReclusterResult>
 *   computeUnclassifiedRatio(allKeywords, axes)   → number   (0–1)
 *   shouldRecluster(allKeywords, axes, threshold) → boolean
 *   mergeAxes(existingAxes, newAxes)              → Axis[]
 *   extractCoreProjects(repoData, options)        → Promise<CoreProjectExtractionResult>
 *   groupEvidenceEpisodes(repoData)               → Promise<EvidenceEpisode[]>
 *   buildRepoWorkContext(dailyEntries, repo)       → RepoWorkContext
 *
 * Exported for unit-testing:
 *   _adaptWorkLogEntries(entries)  → { resumeBullets }[]
 *   _dedup(keywords)               → string[]
 *
 * @module resumeRecluster
 */

import {
  clusterKeywords,
  collectResumeKeywords,
  collectWorkLogKeywords
} from "./resumeKeywordClustering.mjs";
import {
  migrateAxes,
  normalizeKeywords,
  createAxis
} from "./resumeAxes.mjs";
import {
  buildFullVoiceBlock,
  normalizeBullet,
  normalizeBullets,
  normalizeSection
} from "./resumeVoice.mjs";
import {
  extractDecisionPointsFromSnippets,
  buildDecisionContext
} from "./resumeDecisionExtractor.mjs";
import {
  batchGenerateBullets,
  embedDecisionInBullet,
} from "./resumeBulletTextGenerator.mjs";

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Default unclassified-ratio threshold (30 %).  Trigger when ratio > this value. */
export const DEFAULT_RECLUSTER_THRESHOLD = 0.3;

/** Maximum number of axes that may be stored after merging. */
const MAX_AXES = 6;

/**
 * Minimum Jaccard-like overlap score between an existing system axis and a new
 * axis for the two to be considered "matching" (and thus merged rather than
 * kept as separate entries).
 */
const OVERLAP_THRESHOLD = 0.25;

// ─── Anti-fragmentation constants ────────────────────────────────────────────

/**
 * Minimum number of commits an episode must reference to stand alone.
 * Episodes below this threshold are merged into the nearest related episode.
 */
export const MIN_EPISODE_COMMITS = 2;

/**
 * Minimum number of bullets a project must have after synthesis.
 * Projects below this threshold are merged into the most related sibling project.
 */
export const MIN_PROJECT_BULLETS = 2;

/**
 * Minimum number of episodes a project should reference.
 * A project backed by only 1 thin episode is a candidate for merging.
 */
export const MIN_PROJECT_EPISODES = 1;

/**
 * Maximum number of episodes per repo before triggering consolidation.
 * If the LLM produces too many micro-episodes, we consolidate the thinnest ones.
 */
export const MAX_EPISODES_PER_REPO = 12;

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Axis
 * @property {string}   id        — Stable UUID.
 * @property {string}   label     — Display name.
 * @property {string[]} keywords  — Characteristic keywords.
 * @property {string}   [_source] — "user" | "system".
 */

/**
 * @typedef {Object} KeywordAxis
 * @property {string}   label    — Short thematic label (2–4 words).
 * @property {string[]} keywords — Keywords belonging to this axis.
 */

/**
 * @typedef {Object} ReclusterResult
 * @property {boolean} triggered          — Whether re-clustering was performed.
 * @property {number}  ratio              — Unclassified ratio (0–1) before recluster.
 * @property {Axis[]}  axes               — Final merged (or unchanged) axis array.
 * @property {number}  totalKeywords      — Total keyword count.
 * @property {number}  unclassifiedCount  — Unclassified keyword count before recluster.
 */

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Full conditional re-clustering pipeline.
 *
 * Steps:
 *   1. Collect all keywords from the resume and recent work logs.
 *   2. Compute the unclassified ratio against the current display axes.
 *   3. If ratio > threshold (or force=true), call the LLM to cluster keywords.
 *   4. Merge the new axes with the existing set, respecting user provenance.
 *   5. Return a {@link ReclusterResult} describing what happened.
 *
 * The function does NOT persist the result; the caller is responsible for
 * saving `result.axes` back to the resume document when `result.triggered` is
 * true.
 *
 * Work-log entries may be supplied in either of two formats:
 *   a) `{ resumeBullets: string[] }` — as expected by collectWorkLogKeywords()
 *   b) `{ candidates, companyCandidates, openSourceCandidates }` — as returned
 *      by gatherWorkLogBullets() in resumeReconstruction.mjs
 * Both formats are normalised internally via `_adaptWorkLogEntries()`.
 *
 * @param {object}   resume          - Resume document.
 * @param {object[]} [workLogs=[]]   - Work-log summary objects (either format above).
 * @param {object}   [options={}]
 * @param {boolean}  [options.force=false]   - Skip threshold check; always recluster.
 * @param {number}   [options.threshold]     - Override default 0.3 threshold (0–1).
 * @returns {Promise<ReclusterResult>}
 */
export async function reclusterPipeline(resume, workLogs = [], options = {}) {
  const threshold =
    typeof options.threshold === "number"
      ? Math.max(0, Math.min(1, options.threshold))
      : DEFAULT_RECLUSTER_THRESHOLD;
  const force = Boolean(options.force);

  // 1. Collect keywords from resume
  const resumeKws = collectResumeKeywords(resume);

  // 2. Adapt + collect keywords from work logs
  const adaptedLogs = _adaptWorkLogEntries(Array.isArray(workLogs) ? workLogs : []);
  const workLogKws = collectWorkLogKeywords(adaptedLogs);

  // Combined, deduplicated keyword pool
  const allKeywords = _dedup([...resumeKws, ...workLogKws]);

  // 3. Migrate and normalise existing axes
  const existingAxes = migrateAxes(
    Array.isArray(resume?.display_axes) ? resume.display_axes : []
  );

  // 4. Compute unclassified ratio
  const ratio = computeUnclassifiedRatio(allKeywords, existingAxes);
  const unclassifiedCount = Math.round(ratio * allKeywords.length);

  // 5. Decide whether to recluster
  if (!force && !shouldRecluster(allKeywords, existingAxes, threshold)) {
    return {
      triggered: false,
      ratio,
      axes: existingAxes,
      totalKeywords: allKeywords.length,
      unclassifiedCount
    };
  }

  // 6. Run LLM clustering on the full keyword pool
  let newClusteredAxes;
  try {
    newClusteredAxes = await clusterKeywords(resumeKws, workLogKws);
  } catch (err) {
    throw new Error(`LLM clustering failed: ${err.message ?? String(err)}`);
  }

  // 7. Merge new axes with existing (user axes preserved)
  const mergedAxes = mergeAxes(existingAxes, newClusteredAxes);

  return {
    triggered: true,
    ratio,
    axes: mergedAxes,
    totalKeywords: allKeywords.length,
    unclassifiedCount
  };
}

/**
 * Compute the fraction of keywords (from `allKeywords`) that are not assigned
 * to any axis in `axes`.
 *
 * A keyword is considered "classified" when it appears (case-insensitively) in
 * the `keywords` array of at least one existing axis.
 *
 * @param {string[]} allKeywords - Flat list of all candidate keywords.
 * @param {Axis[]}   axes        - Current display axes.
 * @returns {number}             - Value in [0, 1].  0 = all classified; 1 = none classified.
 */
export function computeUnclassifiedRatio(allKeywords, axes) {
  if (!Array.isArray(allKeywords) || allKeywords.length === 0) return 0;

  // Build a lower-cased set of all keywords that are assigned to some axis
  const classified = new Set();
  if (Array.isArray(axes)) {
    for (const axis of axes) {
      if (!axis || !Array.isArray(axis.keywords)) continue;
      for (const kw of axis.keywords) {
        if (typeof kw === "string" && kw.trim()) {
          classified.add(kw.trim().toLowerCase());
        }
      }
    }
  }

  let unclassifiedCount = 0;
  for (const kw of allKeywords) {
    if (typeof kw !== "string") {
      unclassifiedCount++;
      continue;
    }
    if (!classified.has(kw.trim().toLowerCase())) {
      unclassifiedCount++;
    }
  }

  return unclassifiedCount / allKeywords.length;
}

/**
 * Returns true when re-clustering should be triggered.
 *
 * Re-clustering is warranted when:
 *   - At least 1 keyword exists in the pool, AND
 *   - The unclassified ratio strictly exceeds `threshold`.
 *
 * @param {string[]} allKeywords
 * @param {Axis[]}   axes
 * @param {number}   [threshold=DEFAULT_RECLUSTER_THRESHOLD]
 * @returns {boolean}
 */
export function shouldRecluster(
  allKeywords,
  axes,
  threshold = DEFAULT_RECLUSTER_THRESHOLD
) {
  if (!Array.isArray(allKeywords) || allKeywords.length === 0) return false;
  const ratio = computeUnclassifiedRatio(allKeywords, axes);
  return ratio > threshold;
}

/**
 * Merge a freshly-clustered set of axes into the existing axis set.
 *
 * Merge rules (applied in priority order):
 *   1. **User-edited axes** (`_source === "user"`) are always preserved unchanged.
 *   2. **Existing system axes** that overlap with a new axis (Jaccard score ≥
 *      OVERLAP_THRESHOLD) are updated: their keywords are replaced with the
 *      union of both axes' keywords (capped at 30); the label is preserved.
 *   3. **New axes** that do not overlap with any existing system axis are
 *      appended as new system-sourced axes.
 *   4. Total axis count is capped at MAX_AXES (6).
 *
 * Each new axis is matched to at most one existing axis (greedy, best-score
 * first), and each existing axis absorbs at most one new axis.
 *
 * @param {Axis[]}        existingAxes  - Current axes (may include migrated items).
 * @param {KeywordAxis[]} newAxes       - Freshly clustered axes from the LLM.
 * @returns {Axis[]}                    - Merged axis array (new instances; no mutations).
 */
export function mergeAxes(existingAxes, newAxes) {
  const existing = Array.isArray(existingAxes) ? existingAxes : [];
  const incoming = Array.isArray(newAxes) ? newAxes : [];

  // Split existing axes by provenance
  const userAxes   = existing.filter((a) => a?._source === "user");
  const systemAxes = existing.filter((a) => a?._source !== "user");

  // Track which incoming axes have already been merged into a system axis
  const mergedNewIndices = new Set();

  // For each system axis, attempt to find the best-matching incoming axis
  const updatedSystemAxes = systemAxes.map((sysAxis) => {
    const matchIdx = _findBestMatchIndex(sysAxis, incoming, mergedNewIndices);
    if (matchIdx === -1) return sysAxis; // No qualifying match — keep unchanged

    mergedNewIndices.add(matchIdx);
    const matchedNew = incoming[matchIdx];

    // Merge keywords: union of both sets (normalizeKeywords handles dedup + cap)
    const mergedKeywords = normalizeKeywords([
      ...sysAxis.keywords,
      ...matchedNew.keywords
    ]);

    return { ...sysAxis, keywords: mergedKeywords, _source: "system" };
  });

  // Incoming axes that didn't match any existing system axis → append as new
  const appendedAxes = incoming
    .filter((_, idx) => !mergedNewIndices.has(idx))
    .map((na) => createAxis(na.label, na.keywords, "system"));

  // Final order: user axes (highest priority) → updated system axes → new axes
  const combined = [...userAxes, ...updatedSystemAxes, ...appendedAxes];

  // Cap total axes at MAX_AXES
  return combined.slice(0, MAX_AXES);
}

// ─── Exported internal helpers (for unit-testing) ──────────────────────────────

/**
 * Adapt work-log entries to the format expected by `collectWorkLogKeywords`.
 *
 * `collectWorkLogKeywords` (from resumeKeywordClustering.mjs) expects each
 * entry to have an optional `keywords` string[] and/or `resumeBullets` string[].
 *
 * `gatherWorkLogBullets` (from resumeReconstruction.mjs) returns entries shaped
 * as `{ date, candidates, companyCandidates, openSourceCandidates }`.
 *
 * This adapter handles both shapes transparently — if an entry already has a
 * `resumeBullets` field it is passed through unchanged; if it has the
 * gatherWorkLogBullets shape, its candidate arrays are flattened into
 * `resumeBullets`.
 *
 * @param {object[]} entries  - Work-log entries in either shape.
 * @returns {{ resumeBullets?: string[], keywords?: string[] }[]}
 */
export function _adaptWorkLogEntries(entries) {
  if (!Array.isArray(entries)) return [];

  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") return {};

    // Already in the collectWorkLogKeywords format — pass through
    if (Array.isArray(entry.resumeBullets)) return entry;

    // gatherWorkLogBullets format → flatten all candidate arrays into resumeBullets
    const bullets = [
      ...(Array.isArray(entry.candidates)          ? entry.candidates          : []),
      ...(Array.isArray(entry.companyCandidates)   ? entry.companyCandidates   : []),
      ...(Array.isArray(entry.openSourceCandidates)? entry.openSourceCandidates: [])
    ].filter((s) => typeof s === "string" && s.trim());

    const result = { resumeBullets: bullets };
    if (Array.isArray(entry.keywords)) result.keywords = entry.keywords;
    return result;
  });
}

/**
 * Case-insensitive deduplication, preserving first-occurrence casing.
 *
 * @param {string[]} keywords
 * @returns {string[]}
 */
export function _dedup(keywords) {
  if (!Array.isArray(keywords)) return [];
  const seen = new Set();
  const result = [];
  for (const k of keywords) {
    if (typeof k !== "string") continue;
    const t = k.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(t);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core Projects Extraction Pipeline (Living Resume)
// ═══════════════════════════════════════════════════════════════════════════════

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/** Target number of core projects per repo. LLM is instructed to aim for this. */
export const TARGET_PROJECTS_PER_REPO = 2;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Aggregated work context for a single repository, built from daily entries.
 * This is the input to the LLM-based episode grouping and project extraction.
 *
 * @typedef {Object} RepoWorkContext
 * @property {string}   repo            Repository name
 * @property {string[]} dates           Sorted ISO dates with activity in this repo
 * @property {{ date: string, subject: string, hash: string }[]} commits
 *                                      Git commits for this repo (chronological)
 * @property {{ date: string, text: string }[]} bullets
 *                                      Work-log bullet candidates mentioning this repo
 * @property {{ date: string, text: string }[]} sessionSnippets
 *                                      Session conversation snippets (Codex/Claude)
 *                                      linked to this repo by date+repo heuristic
 * @property {{ date: string, text: string }[]} highlights
 *                                      Daily highlights (storyThreads, aiReview, etc.)
 */

/**
 * Build aggregated work context for a single repository from daily work-log
 * entries.  This collects all commits, bullets, session snippets, and
 * highlights that relate to the given repo.
 *
 * Session-to-commit linking uses the date+repo heuristic: a session snippet
 * is linked to a repo when they share the same date and the repo name appears
 * in the session's cwd or content.  When no 1:1 mapping is available, the
 * function degrades gracefully — session data is simply omitted for that date.
 *
 * @param {object[]} dailyEntries  Raw daily JSON entries (from data/daily/*.json)
 * @param {string}   repo          Repository name to filter for
 * @returns {RepoWorkContext}
 */
export function buildRepoWorkContext(dailyEntries, repo) {
  if (!Array.isArray(dailyEntries) || !repo) {
    return { repo: repo || "", dates: [], commits: [], bullets: [], sessionSnippets: [], highlights: [] };
  }

  const repoLower = repo.toLowerCase();
  const dates = new Set();
  const commits = [];
  const bullets = [];
  const sessionSnippets = [];
  const highlights = [];

  for (const entry of dailyEntries) {
    if (!entry || typeof entry !== "object") continue;
    const date = entry.date;
    if (!date) continue;

    // ── Collect commits for this repo ──────────────────────────────────────
    const projects = Array.isArray(entry.projects) ? entry.projects : [];
    for (const proj of projects) {
      if (!proj || (proj.repo || "").toLowerCase() !== repoLower) continue;
      const projCommits = Array.isArray(proj.commits) ? proj.commits : [];
      for (const c of projCommits) {
        if (!c || !c.subject) continue;
        commits.push({
          date,
          subject: c.subject,
          hash: c.hash || ""
        });
        dates.add(date);
      }
    }

    // ── Collect bullet candidates mentioning this repo ─────────────────────
    // Primary: bullets that explicitly mention the repo name
    // Fallback: on single-repo days, attribute all bullets to that repo
    const resume = entry.resume;
    if (resume) {
      const allCandidates = [
        ...(Array.isArray(resume.candidates) ? resume.candidates : []),
        ...(Array.isArray(resume.companyCandidates) ? resume.companyCandidates : []),
        ...(Array.isArray(resume.openSourceCandidates) ? resume.openSourceCandidates : [])
      ].filter((s) => typeof s === "string" && s.trim());

      // Check if this is a single-repo day (only one repo has commits)
      const activeRepos = new Set(
        projects
          .filter((p) => p && Array.isArray(p.commits) && p.commits.length > 0)
          .map((p) => (p.repo || "").toLowerCase())
      );
      const isSingleRepoDay = activeRepos.size === 1 && activeRepos.has(repoLower);

      for (const bullet of allCandidates) {
        const mentionsRepo = bullet.toLowerCase().includes(repoLower);
        if (mentionsRepo || isSingleRepoDay) {
          bullets.push({ date, text: bullet });
          dates.add(date);
        }
      }
    }

    // ── Collect session snippets (date+repo heuristic) ─────────────────────
    const aiSessions = entry.aiSessions;
    if (aiSessions) {
      const allSessions = [
        ...(Array.isArray(aiSessions.codex) ? aiSessions.codex : []),
        ...(Array.isArray(aiSessions.claude) ? aiSessions.claude : [])
      ];
      for (const session of allSessions) {
        if (!session) continue;
        // Heuristic: link session to repo if cwd contains repo name or
        // session summary/snippets mention the repo
        const sessionText = [
          session.summary || "",
          ...(Array.isArray(session.snippets) ? session.snippets : [])
        ].join(" ");
        const cwdMatch = (session.cwd || "").toLowerCase().includes(repoLower);
        const contentMatch = sessionText.toLowerCase().includes(repoLower);

        if (cwdMatch || contentMatch) {
          // Collect summary and all relevant snippets for richer decision context
          const parts = [];
          if (session.summary) parts.push(session.summary);
          if (Array.isArray(session.snippets)) {
            for (const s of session.snippets) {
              if (typeof s === "string" && s.trim() && s !== session.summary) {
                parts.push(s);
              }
            }
          }
          const combined = parts.join(" | ");
          if (combined) {
            sessionSnippets.push({ date, text: combined });
            dates.add(date);
          }
        }
      }
    }

    // ── Collect highlights (storyThreads) for this repo ────────────────────
    const hl = entry.highlights;
    if (hl) {
      const storyThreads = Array.isArray(hl.storyThreads) ? hl.storyThreads : [];
      for (const thread of storyThreads) {
        if (!thread || (thread.repo || "").toLowerCase() !== repoLower) continue;
        const parts = [
          thread.outcome,
          thread.keyChange,
          thread.impact,
          thread.why,
          thread.decision
        ].filter(Boolean);
        if (parts.length > 0) {
          highlights.push({ date, text: parts.join(" — ") });
          dates.add(date);
        }
      }

      // Also collect aiReview items (not repo-specific but useful context)
      if (dates.has(date) && Array.isArray(hl.aiReview)) {
        for (const review of hl.aiReview) {
          if (typeof review === "string" && review.trim()) {
            highlights.push({ date, text: review });
          }
        }
      }
    }
  }

  const sortedDates = [...dates].sort();

  return {
    repo,
    dates: sortedDates,
    commits: commits.sort((a, b) => a.date.localeCompare(b.date)),
    bullets,
    sessionSnippets,
    highlights
  };
}

/**
 * Extract evidence episodes from a repo's work context using LLM-based
 * semantic grouping.
 *
 * Episodes are grouped by:
 *   - Semantic topic similarity (what the work is about)
 *   - Functional module unit (what part of the codebase is affected)
 *
 * The LLM receives the full work context (commits, bullets, sessions,
 * highlights) and returns a set of coherent episodes.
 *
 * @param {RepoWorkContext} repoContext  Aggregated work context for one repo
 * @param {object} [options={}]
 * @param {Function} [options.llmFn]  Override LLM call for testing
 * @returns {Promise<EvidenceEpisode[]>}
 */
export async function groupEvidenceEpisodes(repoContext, options = {}) {
  if (!repoContext || repoContext.commits.length === 0) {
    return [];
  }

  // Extract structured decision points from session snippets (Day 1 requirement)
  let extractedDecisions = null;
  if (repoContext.sessionSnippets && repoContext.sessionSnippets.length > 0) {
    try {
      const decisionLlmFn = options.decisionLlmFn || undefined;
      extractedDecisions = await extractDecisionPointsFromSnippets(
        repoContext.sessionSnippets,
        { repo: repoContext.repo, ...(decisionLlmFn ? { llmFn: decisionLlmFn } : {}) }
      );
    } catch (err) {
      // Graceful degradation: if decision extraction fails, continue with raw snippets
      console.error(`[groupEvidenceEpisodes] Decision extraction failed, falling back to raw snippets: ${err.message}`);
      extractedDecisions = null;
    }
  }

  const llmFn = options.llmFn || _callLlmForEpisodes;
  const rawEpisodes = await llmFn(repoContext, extractedDecisions);

  // Normalize and validate episodes
  const normalized = _normalizeEpisodes(rawEpisodes, repoContext.repo);

  // Anti-fragmentation: consolidate thin episodes to prevent over-fragmentation
  return _consolidateEpisodes(normalized, repoContext.repo);
}

/**
 * Extract ~2 core projects from a single repo's work logs and session
 * conversations.
 *
 * This is the main entry point for the core projects extraction pipeline.
 * It:
 *   1. Builds the repo work context from daily entries
 *   2. Groups work into evidence episodes (LLM-judged)
 *   3. Clusters episodes into ~2 core projects (LLM-judged)
 *   4. Returns structured CoreProject objects with embedded episodes
 *
 * @param {Object}   repoData
 * @param {string}   repoData.repo           Repository name
 * @param {object[]} repoData.dailyEntries   Raw daily JSON entries (data/daily/*.json)
 * @param {object}   [options={}]
 * @param {Function} [options.llmFn]         Override LLM call for testing (episodes)
 * @param {Function} [options.projectLlmFn]  Override LLM call for testing (project synthesis)
 * @returns {Promise<CoreProjectExtractionResult>}
 */
export async function extractCoreProjects(repoData, options = {}) {
  const { repo, dailyEntries } = repoData;

  // Step 1: Build aggregated work context for this repo
  const repoContext = buildRepoWorkContext(dailyEntries, repo);

  if (repoContext.commits.length === 0) {
    return {
      repo,
      projects: [],
      episodeCount: 0,
      extractedAt: new Date().toISOString()
    };
  }

  // Step 2: Group work into evidence episodes
  const episodes = await groupEvidenceEpisodes(repoContext, {
    llmFn: options.llmFn
  });

  if (episodes.length === 0) {
    return {
      repo,
      projects: [],
      episodeCount: 0,
      extractedAt: new Date().toISOString()
    };
  }

  // Step 2.5: Enrich episode bullets with decision reasoning via
  // the bullet-text generator.  This re-generates bullets using contextual
  // language patterns that naturally embed WHY decisions were made, producing
  // higher-quality text for downstream project synthesis.
  let enrichedEpisodes = episodes;
  if (repoContext.sessionSnippets.length > 0) {
    try {
      const decisionLlmFn = options.decisionLlmFn || undefined;
      const decisions = await extractDecisionPointsFromSnippets(
        repoContext.sessionSnippets,
        { repo, ...(decisionLlmFn ? { llmFn: decisionLlmFn } : {}) }
      );

      if (decisions.length > 0) {
        const bulletResults = await batchGenerateBullets(
          episodes,
          decisions,
          {
            repo,
            maxBulletsPerEpisode: 3,
            llmFn: options.bulletLlmFn,
          }
        );

        // Merge generated bullets back into episodes: replace episode
        // bullets with the enriched versions when the generator produced
        // results, but keep originals as fallback.
        enrichedEpisodes = episodes.map((ep, idx) => {
          const generated = bulletResults.find(r => r.episodeId === ep.id);
          if (generated && generated.bullets.length > 0) {
            return {
              ...ep,
              bullets: generated.bullets.map(b => b.text),
            };
          }
          return ep;
        });
      }
    } catch (err) {
      // Graceful degradation: if bullet enrichment fails, continue with
      // the original episode bullets.  Decision-embedded bullets are a
      // quality improvement, not a hard requirement.
      console.error(`[extractCoreProjects] Bullet enrichment failed (non-fatal): ${err.message}`);
    }
  }

  // Step 3: Synthesize episodes into core projects
  const projectLlmFn = options.projectLlmFn || _callLlmForProjects;
  const rawProjects = await projectLlmFn(repo, enrichedEpisodes, repoContext);
  const normalizedProjects = _normalizeProjects(rawProjects, repo, enrichedEpisodes);

  // Step 4: Anti-fragmentation — consolidate thin projects
  const projects = _consolidateProjects(normalizedProjects, repo);

  return {
    repo,
    projects,
    episodeCount: episodes.length,
    extractedAt: new Date().toISOString()
  };
}

// ─── LLM calls for episode grouping ──────────────────────────────────────────

const EPISODE_GROUPING_SYSTEM_PROMPT = `\
You are an expert at analyzing developer work logs to identify coherent episodes of work.

An "evidence episode" is a semantically coherent unit of work activity that groups
related commits, work-log entries, and session conversations around a single topic
and functional module.

GROUPING CRITERIA:
- Group by semantic topic similarity (e.g., "payment flow refactoring", "auth system hardening")
- Group by functional module unit (e.g., same service, component, or subsystem)
- A single day's work may span multiple episodes
- Multiple days may contribute to the same episode
- Each episode should be specific enough to tell a clear story

ANTI-FRAGMENTATION (CRITICAL):
- Do NOT create micro-episodes for trivial standalone commits (e.g., a single typo fix,
  one README update, or a small config change).  Group these with the nearest related episode.
- Every episode must have at least 2 commits OR represent genuinely substantial standalone work.
- Prefer fewer, richer episodes over many thin ones.  A user should never look at an
  episode and think "this is too small to matter."
- If total evidence (commits + bullets) for a repo is small (< 5 items), aim for just
  1-2 episodes rather than fragmenting into many.
- It is better to have 3 well-supported episodes than 8 fragmented ones.

DECISION REASONING:
When session conversation data is available, extract the WHY behind decisions.
Embed this reasoning naturally into the episode summary and bullets — do NOT
keep it as separate metadata.  Good: "Centralized policy rules into a single
config to eliminate scattered rule conflicts across 5 files."
Bad: "Refactored policy rules. Decision: wanted to centralize."

OUTPUT REQUIREMENTS:
- title: 5-15 word descriptive title
- summary: 1-2 sentences explaining what happened and why
- dates: array of YYYY-MM-DD dates this episode spans
- commitSubjects: git commit subjects that belong to this episode
- bullets: 1-3 achievement-oriented resume bullets
- topicTag: short kebab-case topic tag (e.g., "policy-centralization")
- moduleTag: functional module identifier (e.g., "pipeline/generation")

${buildFullVoiceBlock(["bullet", "episodeTitle"], null, { includeDecisionReasoning: true })}`;


const EPISODE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["episodes"],
  properties: {
    episodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "dates", "commitSubjects", "bullets", "topicTag", "moduleTag"],
        properties: {
          title:          { type: "string" },
          summary:        { type: "string" },
          dates:          { type: "array", items: { type: "string" } },
          commitSubjects: { type: "array", items: { type: "string" } },
          bullets:        { type: "array", items: { type: "string" } },
          topicTag:       { type: "string" },
          moduleTag:      { type: "string" }
        }
      }
    }
  }
};

/**
 * Call the LLM to group a repo's work context into evidence episodes.
 * @param {RepoWorkContext} ctx
 * @returns {Promise<object[]>} Raw episode objects from LLM
 */
async function _callLlmForEpisodes(ctx, extractedDecisions = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set — cannot extract evidence episodes");
  }
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    throw new Error("OpenAI integration is disabled (WORK_LOG_DISABLE_OPENAI=1)");
  }

  const userMessage = _buildEpisodeUserMessage(ctx, extractedDecisions);

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "medium" },
    text: {
      format: {
        type: "json_schema",
        name: "episode_grouping",
        strict: true,
        schema: EPISODE_OUTPUT_SCHEMA
      }
    },
    max_output_tokens: 3000,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: EPISODE_GROUPING_SYSTEM_PROMPT }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }]
      }
    ]
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Episode grouping LLM call failed: ${response.status} ${errorText.slice(0, 400)}`);
  }

  const data = await response.json();
  const rawText = data.output_text || _extractOutputText(data);
  if (!rawText) {
    throw new Error("Episode grouping LLM call returned empty output");
  }

  const parsed = JSON.parse(rawText);
  return Array.isArray(parsed.episodes) ? parsed.episodes : [];
}

function _buildEpisodeUserMessage(ctx, extractedDecisions = null) {
  const parts = [];

  parts.push(`=== REPOSITORY: ${ctx.repo} ===`);
  parts.push(`Activity dates: ${ctx.dates.join(", ")}`);

  // Commits
  if (ctx.commits.length > 0) {
    parts.push("");
    parts.push(`=== GIT COMMITS (${ctx.commits.length}) ===`);
    for (const c of ctx.commits.slice(0, 100)) {
      parts.push(`[${c.date}] ${c.subject}`);
    }
  }

  // Work-log bullets
  if (ctx.bullets.length > 0) {
    parts.push("");
    parts.push(`=== WORK-LOG BULLETS (${ctx.bullets.length}) ===`);
    for (const b of ctx.bullets.slice(0, 60)) {
      parts.push(`[${b.date}] ${b.text}`);
    }
  }

  // Extracted decision points (structured, high-signal) — preferred over raw snippets
  const decisionBlock = extractedDecisions
    ? buildDecisionContext(extractedDecisions)
    : "";

  if (decisionBlock) {
    parts.push("");
    parts.push(decisionBlock);
  }

  // Session snippets — raw conversation context (fallback when no decisions extracted)
  if (ctx.sessionSnippets.length > 0) {
    parts.push("");
    if (decisionBlock) {
      // When we have structured decisions, include fewer raw snippets as supplementary context
      parts.push(`=== SESSION CONVERSATIONS — SUPPLEMENTARY (${ctx.sessionSnippets.length}) ===`);
      parts.push("(Structured decisions above are the primary reasoning source; use these for additional context)");
      for (const s of ctx.sessionSnippets.slice(0, 15)) {
        parts.push(`[${s.date}] ${s.text}`);
      }
    } else {
      parts.push(`=== SESSION CONVERSATIONS (${ctx.sessionSnippets.length}) ===`);
      parts.push("(Use these to understand WHY decisions were made — embed reasoning into episode bullets)");
      for (const s of ctx.sessionSnippets.slice(0, 40)) {
        parts.push(`[${s.date}] ${s.text}`);
      }
    }
  }

  // Highlights
  if (ctx.highlights.length > 0) {
    parts.push("");
    parts.push(`=== DAILY HIGHLIGHTS (${ctx.highlights.length}) ===`);
    for (const h of ctx.highlights.slice(0, 30)) {
      parts.push(`[${h.date}] ${h.text}`);
    }
  }

  return parts.join("\n");
}

// ─── LLM calls for project synthesis ─────────────────────────────────────────

const PROJECT_SYNTHESIS_SYSTEM_PROMPT = `\
You are an expert resume writer who synthesizes evidence episodes into core projects.

Given a set of evidence episodes from a single repository, group them into approximately
${TARGET_PROJECTS_PER_REPO} core projects. Each core project should represent a significant,
coherent stream of work.

GROUPING GUIDANCE:
- Target ~${TARGET_PROJECTS_PER_REPO} projects per repo (not a hard limit — use judgment)
- 1 project is fine if all work is tightly related
- 3 projects is acceptable if work is genuinely distinct
- Never create more than 4 projects per repo
- Each project should be substantial enough to warrant 2-4 resume bullets

ANTI-FRAGMENTATION (CRITICAL):
- NEVER create a project with only 1 bullet — that's a sign of over-fragmentation.
  Merge it into the most related project or expand it with more detail.
- Each project must reference at least 1 episode.  A project with no supporting
  episodes is an empty shell that users will delete.
- If there are only 2-3 episodes total, prefer 1 project that tells a complete story
  over 2 projects that each feel half-baked.
- Ask yourself: "Would a recruiter find this project section substantial enough
  to be worth reading?"  If not, merge it.

FOR EACH PROJECT:
- title: Concise project title
- description: Explaining scope, approach, and impact
- episodeIndices: which episodes (by 0-based index) belong to this project
- bullets: 2-4 top-level achievement bullets synthesized from the episodes.
  Bullets should embed decision reasoning naturally (WHY, not just WHAT).
- techTags: 3-8 prominent technologies/tools/concepts

${buildFullVoiceBlock(["bullet", "projectTitle", "projectDescription"], null, { includeDecisionReasoning: true })}`;


const PROJECT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["projects"],
  properties: {
    projects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "episodeIndices", "bullets", "techTags"],
        properties: {
          title:          { type: "string" },
          description:    { type: "string" },
          episodeIndices: { type: "array", items: { type: "integer" } },
          bullets:        { type: "array", items: { type: "string" } },
          techTags:       { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

/**
 * Call the LLM to synthesize episodes into core projects.
 * @param {string} repo
 * @param {EvidenceEpisode[]} episodes
 * @param {RepoWorkContext} ctx
 * @returns {Promise<object[]>} Raw project objects from LLM
 */
async function _callLlmForProjects(repo, episodes, ctx) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set — cannot synthesize core projects");
  }
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    throw new Error("OpenAI integration is disabled (WORK_LOG_DISABLE_OPENAI=1)");
  }

  const userMessage = _buildProjectUserMessage(repo, episodes);

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "medium" },
    text: {
      format: {
        type: "json_schema",
        name: "project_synthesis",
        strict: true,
        schema: PROJECT_OUTPUT_SCHEMA
      }
    },
    max_output_tokens: 2000,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: PROJECT_SYNTHESIS_SYSTEM_PROMPT }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userMessage }]
      }
    ]
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Project synthesis LLM call failed: ${response.status} ${errorText.slice(0, 400)}`);
  }

  const data = await response.json();
  const rawText = data.output_text || _extractOutputText(data);
  if (!rawText) {
    throw new Error("Project synthesis LLM call returned empty output");
  }

  const parsed = JSON.parse(rawText);
  return Array.isArray(parsed.projects) ? parsed.projects : [];
}

function _buildProjectUserMessage(repo, episodes) {
  const parts = [];

  parts.push(`=== REPOSITORY: ${repo} ===`);
  parts.push(`Total episodes: ${episodes.length}`);
  parts.push("");

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    parts.push(`--- Episode ${i}: "${ep.title}" ---`);
    parts.push(`Topic: ${ep.topicTag} | Module: ${ep.moduleTag}`);
    parts.push(`Dates: ${ep.dates.join(", ")}`);
    parts.push(`Summary: ${ep.summary}`);
    if (ep.decisionReasoning) {
      parts.push(`Decision reasoning: ${ep.decisionReasoning}`);
    }
    parts.push(`Commits: ${ep.commitSubjects.join("; ")}`);
    parts.push(`Bullets:`);
    for (const b of ep.bullets) {
      parts.push(`  - ${b}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ─── Normalization helpers ───────────────────────────────────────────────────

/**
 * Normalize raw LLM episode output into typed EvidenceEpisode objects.
 * @param {object[]} rawEpisodes
 * @param {string}   repo
 * @returns {EvidenceEpisode[]}
 */
function _normalizeEpisodes(rawEpisodes, repo) {
  if (!Array.isArray(rawEpisodes)) return [];

  return rawEpisodes
    .filter((ep) => ep && typeof ep === "object" && ep.title)
    .map((ep, idx) => ({
      id: `ep-${_slugify(repo)}-${idx}`,
      title: String(ep.title || "").trim().slice(0, 120),
      summary: String(ep.summary || "").trim().slice(0, 500),
      dates: _normalizeStringArray(ep.dates, 10, 30),
      commitSubjects: _normalizeStringArray(ep.commitSubjects, 200, 20),
      bullets: normalizeBullets(_normalizeStringArray(ep.bullets, 160, 5)),
      decisionReasoning: null, // Reasoning is embedded in bullets/summary by design
      topicTag: _toKebabCase(String(ep.topicTag || "general").trim()),
      moduleTag: String(ep.moduleTag || "").trim().slice(0, 80) || "general"
    }));
}

/**
 * Anti-fragmentation: consolidate episodes that are too thin to stand alone.
 *
 * Thin episodes (fewer than MIN_EPISODE_COMMITS commit subjects AND only 1 bullet)
 * are merged into the most topically-related sibling episode.  If no suitable
 * sibling exists, the thin episode is kept as-is (better a thin section than
 * lost evidence).
 *
 * Also enforces MAX_EPISODES_PER_REPO — when the LLM produces too many
 * micro-episodes, the thinnest ones are merged until within the cap.
 *
 * After consolidation, episode IDs are re-indexed to maintain consistency.
 *
 * @param {EvidenceEpisode[]} episodes  Normalized episodes from _normalizeEpisodes
 * @param {string}            repo      Repository name (for re-indexed IDs)
 * @returns {EvidenceEpisode[]}
 */
export function _consolidateEpisodes(episodes, repo) {
  if (!Array.isArray(episodes) || episodes.length <= 1) return episodes;

  // Phase 1: identify thin episodes
  const thin = [];
  const substantial = [];

  for (const ep of episodes) {
    const commitCount = (ep.commitSubjects || []).length;
    const bulletCount = (ep.bullets || []).length;

    // An episode is "thin" if it has very few commits AND very few bullets
    if (commitCount < MIN_EPISODE_COMMITS && bulletCount < MIN_PROJECT_BULLETS) {
      thin.push(ep);
    } else {
      substantial.push(ep);
    }
  }

  // If there are no substantial episodes to merge into, return as-is
  if (substantial.length === 0) return episodes;

  // If nothing is thin, skip to MAX cap enforcement
  let consolidated = [...substantial];

  // Phase 2: merge each thin episode into its best match among substantial ones
  for (const thinEp of thin) {
    const bestIdx = _findBestEpisodeMatch(thinEp, consolidated);
    if (bestIdx >= 0) {
      consolidated[bestIdx] = _mergeEpisodePair(consolidated[bestIdx], thinEp);
    } else {
      // No match — keep the thin episode rather than losing evidence
      consolidated.push(thinEp);
    }
  }

  // Phase 3: enforce MAX_EPISODES_PER_REPO by merging the thinnest remaining
  while (consolidated.length > MAX_EPISODES_PER_REPO) {
    let thinnestIdx = 0;
    let thinnestScore = Infinity;
    for (let i = 0; i < consolidated.length; i++) {
      const score = (consolidated[i].commitSubjects || []).length +
                    (consolidated[i].bullets || []).length;
      if (score < thinnestScore) {
        thinnestScore = score;
        thinnestIdx = i;
      }
    }

    const [removed] = consolidated.splice(thinnestIdx, 1);
    if (consolidated.length === 0) {
      consolidated.push(removed);
      break;
    }
    const bestIdx = _findBestEpisodeMatch(removed, consolidated);
    const targetIdx = bestIdx >= 0 ? bestIdx : 0;
    consolidated[targetIdx] = _mergeEpisodePair(consolidated[targetIdx], removed);
  }

  // Phase 4: re-index episode IDs for consistency
  return consolidated.map((ep, idx) => ({
    ...ep,
    id: `ep-${_slugify(repo)}-${idx}`
  }));
}

/**
 * Find the best matching episode for merging, based on topicTag/moduleTag
 * similarity and overlapping dates/commits.
 *
 * @param {EvidenceEpisode}   episode
 * @param {EvidenceEpisode[]} candidates
 * @returns {number}  Index into candidates, or -1 if none found
 */
function _findBestEpisodeMatch(episode, candidates) {
  if (candidates.length === 0) return -1;

  let bestIdx = -1;
  let bestScore = -1;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let score = 0;

    // Same topicTag = strong signal
    if (episode.topicTag && c.topicTag && episode.topicTag === c.topicTag) {
      score += 3;
    }
    // Same moduleTag = strong signal
    if (episode.moduleTag && c.moduleTag && episode.moduleTag === c.moduleTag) {
      score += 3;
    }
    // Overlapping dates
    const candidateDates = new Set(c.dates || []);
    for (const d of episode.dates || []) {
      if (candidateDates.has(d)) score += 1;
    }
    // Overlapping commit subjects
    const candidateCommits = new Set(
      (c.commitSubjects || []).map((s) => s.toLowerCase())
    );
    for (const cs of episode.commitSubjects || []) {
      if (candidateCommits.has(cs.toLowerCase())) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestScore > 0 ? bestIdx : (candidates.length > 0 ? 0 : -1);
}

/**
 * Merge two episodes into one, combining their evidence.
 * The primary episode keeps its title/summary; secondary's evidence is absorbed.
 *
 * @param {EvidenceEpisode} primary
 * @param {EvidenceEpisode} secondary
 * @returns {EvidenceEpisode}
 */
function _mergeEpisodePair(primary, secondary) {
  // Merge dates (dedup + sort)
  const allDates = [...new Set([
    ...(primary.dates || []),
    ...(secondary.dates || [])
  ])].sort();

  // Merge commit subjects (dedup by lowercase)
  const seenCommits = new Set();
  const mergedCommits = [];
  for (const cs of [...(primary.commitSubjects || []), ...(secondary.commitSubjects || [])]) {
    const lower = cs.toLowerCase();
    if (!seenCommits.has(lower)) {
      seenCommits.add(lower);
      mergedCommits.push(cs);
    }
  }

  // Merge bullets (dedup, primary first, cap at 5)
  const seenBullets = new Set();
  const mergedBullets = [];
  for (const b of [...(primary.bullets || []), ...(secondary.bullets || [])]) {
    const normalized = b.toLowerCase().trim();
    if (!seenBullets.has(normalized) && mergedBullets.length < 5) {
      seenBullets.add(normalized);
      mergedBullets.push(b);
    }
  }

  // Combine summary: append secondary context if it adds value
  let mergedSummary = primary.summary || "";
  if (secondary.summary && !mergedSummary.toLowerCase().includes(
    secondary.summary.toLowerCase().slice(0, 40)
  )) {
    mergedSummary = `${mergedSummary} Additionally, ${secondary.summary.charAt(0).toLowerCase()}${secondary.summary.slice(1)}`;
    mergedSummary = mergedSummary.slice(0, 500);
  }

  return {
    ...primary,
    summary: mergedSummary,
    dates: allDates,
    commitSubjects: mergedCommits,
    bullets: mergedBullets
  };
}

/**
 * Normalize raw LLM project output into typed CoreProject objects,
 * linking back to the episode array.
 * @param {object[]} rawProjects
 * @param {string}   repo
 * @param {EvidenceEpisode[]} episodes
 * @returns {CoreProject[]}
 */
function _normalizeProjects(rawProjects, repo, episodes) {
  if (!Array.isArray(rawProjects)) return [];

  return rawProjects
    .filter((proj) => proj && typeof proj === "object" && proj.title)
    .slice(0, 4) // Hard cap at 4 projects per repo
    .map((proj, idx) => {
      // Resolve episode indices to actual episode objects
      const indices = Array.isArray(proj.episodeIndices) ? proj.episodeIndices : [];
      const linkedEpisodes = indices
        .filter((i) => typeof i === "number" && i >= 0 && i < episodes.length)
        .map((i) => episodes[i]);

      // Compute date range from linked episodes
      const allDates = linkedEpisodes.flatMap((ep) => ep.dates).sort();
      const dateRange = _computeDateRange(allDates);

      return {
        id: `proj-${_slugify(repo)}-${idx}`,
        repo,
        title: String(proj.title || "").trim().slice(0, 100),
        description: String(proj.description || "").trim().slice(0, 600),
        episodes: linkedEpisodes,
        bullets: normalizeBullets(_normalizeStringArray(proj.bullets, 160, 6)),
        techTags: _normalizeStringArray(proj.techTags, 60, 10),
        dateRange,
        _source: "system"
      };
    });
}

/**
 * Anti-fragmentation: consolidate projects that are too thin to justify
 * a standalone section (which users would wholesale-delete).
 *
 * A project is considered "thin" when it has fewer than MIN_PROJECT_BULLETS
 * bullets.  Thin projects are merged into the most related sibling project
 * within the same repo.
 *
 * When only one project exists and it's thin, it's kept as-is (a single
 * thin project is better than an empty projects section).
 *
 * After consolidation, project IDs are re-indexed.
 *
 * @param {CoreProject[]} projects  Normalized projects from _normalizeProjects
 * @param {string}        repo      Repository name (for re-indexed IDs)
 * @returns {CoreProject[]}
 */
export function _consolidateProjects(projects, repo) {
  if (!Array.isArray(projects) || projects.length <= 1) return projects;

  const thin = [];
  const substantial = [];

  for (const proj of projects) {
    const bulletCount = (proj.bullets || []).length;
    if (bulletCount < MIN_PROJECT_BULLETS) {
      thin.push(proj);
    } else {
      substantial.push(proj);
    }
  }

  // If all projects are thin, keep the one with the most evidence
  if (substantial.length === 0) {
    const sorted = [...projects].sort((a, b) => {
      const aScore = (a.bullets || []).length + (a.episodes || []).length;
      const bScore = (b.bullets || []).length + (b.episodes || []).length;
      return bScore - aScore;
    });
    // Merge all into the strongest candidate
    let merged = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      merged = _mergeProjectPair(merged, sorted[i]);
    }
    return [{ ...merged, id: `proj-${_slugify(repo)}-0` }];
  }

  let consolidated = [...substantial];

  // Merge each thin project into its best match
  for (const thinProj of thin) {
    const bestIdx = _findBestProjectMatch(thinProj, consolidated);
    const targetIdx = bestIdx >= 0 ? bestIdx : 0;
    consolidated[targetIdx] = _mergeProjectPair(consolidated[targetIdx], thinProj);
  }

  // Re-index project IDs
  return consolidated.map((proj, idx) => ({
    ...proj,
    id: `proj-${_slugify(repo)}-${idx}`
  }));
}

/**
 * Find the best matching project to merge a thin project into.
 * Uses tech tag overlap and episode overlap as signals.
 *
 * @param {CoreProject}   project
 * @param {CoreProject[]} candidates
 * @returns {number}  Index into candidates, or -1 if none found
 */
function _findBestProjectMatch(project, candidates) {
  if (candidates.length === 0) return -1;

  let bestIdx = 0;
  let bestScore = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let score = 0;

    // Tech tag overlap
    const cTags = new Set((c.techTags || []).map((t) => t.toLowerCase()));
    for (const tag of project.techTags || []) {
      if (cTags.has(tag.toLowerCase())) score += 2;
    }

    // Episode overlap (same topic/module tags in linked episodes)
    const cTopics = new Set(
      (c.episodes || []).map((ep) => ep.topicTag).filter(Boolean)
    );
    for (const ep of project.episodes || []) {
      if (ep.topicTag && cTopics.has(ep.topicTag)) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Merge two projects into one, combining their evidence.
 * The primary project keeps its title/description; secondary's data is absorbed.
 *
 * @param {CoreProject} primary
 * @param {CoreProject} secondary
 * @returns {CoreProject}
 */
function _mergeProjectPair(primary, secondary) {
  // Merge episodes (dedup by ID)
  const seenEpIds = new Set((primary.episodes || []).map((ep) => ep.id));
  const mergedEpisodes = [...(primary.episodes || [])];
  for (const ep of secondary.episodes || []) {
    if (!seenEpIds.has(ep.id)) {
      seenEpIds.add(ep.id);
      mergedEpisodes.push(ep);
    }
  }

  // Merge bullets (dedup, cap at 6)
  const seenBullets = new Set();
  const mergedBullets = [];
  for (const b of [...(primary.bullets || []), ...(secondary.bullets || [])]) {
    const normalized = b.toLowerCase().trim();
    if (!seenBullets.has(normalized) && mergedBullets.length < 6) {
      seenBullets.add(normalized);
      mergedBullets.push(b);
    }
  }

  // Merge tech tags (dedup, cap at 10)
  const seenTags = new Set();
  const mergedTags = [];
  for (const t of [...(primary.techTags || []), ...(secondary.techTags || [])]) {
    const lower = t.toLowerCase();
    if (!seenTags.has(lower) && mergedTags.length < 10) {
      seenTags.add(lower);
      mergedTags.push(t);
    }
  }

  // Extend description if secondary adds context
  let mergedDescription = primary.description || "";
  if (secondary.description && !mergedDescription.toLowerCase().includes(
    secondary.description.toLowerCase().slice(0, 30)
  )) {
    mergedDescription = `${mergedDescription} ${secondary.description}`.trim().slice(0, 600);
  }

  // Recompute date range from merged episodes
  const allDates = mergedEpisodes.flatMap((ep) => ep.dates || []).sort();
  const dateRange = _computeDateRange(allDates);

  return {
    ...primary,
    description: mergedDescription,
    episodes: mergedEpisodes,
    bullets: mergedBullets,
    techTags: mergedTags,
    dateRange
  };
}

/**
 * Compute a human-readable date range string from sorted dates.
 * @param {string[]} sortedDates - YYYY-MM-DD strings, sorted ascending
 * @returns {string}
 */
function _computeDateRange(sortedDates) {
  if (!sortedDates || sortedDates.length === 0) return "";
  const first = sortedDates[0];
  const last = sortedDates[sortedDates.length - 1];

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fDate = new Date(first + "T00:00:00");
  const lDate = new Date(last + "T00:00:00");

  const fMonth = months[fDate.getMonth()];
  const fYear = fDate.getFullYear();
  const lMonth = months[lDate.getMonth()];
  const lYear = lDate.getFullYear();

  if (first === last) return `${fMonth} ${fYear}`;
  if (fYear === lYear && fMonth === lMonth) return `${fMonth} ${fYear}`;
  if (fYear === lYear) return `${fMonth}–${lMonth} ${fYear}`;
  return `${fMonth} ${fYear} – ${lMonth} ${lYear}`;
}

function _slugify(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function _toKebabCase(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function _normalizeStringArray(value, maxItemLength = 200, maxItems = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => item.slice(0, maxItemLength))
    .slice(0, maxItems);
}

function _extractOutputText(data) {
  const outputs = data.output || [];
  const texts = [];
  for (const item of outputs) {
    const content = item?.content || [];
    for (const part of content) {
      if (part?.type === "output_text" && part?.text) {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Find the index in `newAxes` whose keyword set has the highest Jaccard-like
 * overlap with `existingAxis.keywords`, requiring the score to exceed
 * OVERLAP_THRESHOLD.
 *
 * Already-merged indices (in `usedIndices`) are skipped.
 *
 * Jaccard score = |intersection| / |union|
 *
 * @param {Axis}          existingAxis
 * @param {KeywordAxis[]} newAxes
 * @param {Set<number>}   usedIndices
 * @returns {number}  Index into newAxes, or -1 if no qualifying match found.
 */
function _findBestMatchIndex(existingAxis, newAxes, usedIndices) {
  const existLower = new Set(
    (Array.isArray(existingAxis.keywords) ? existingAxis.keywords : [])
      .map((k) => k.toLowerCase())
  );
  if (existLower.size === 0) return -1;

  let bestIdx   = -1;
  let bestScore = OVERLAP_THRESHOLD; // Must strictly exceed threshold to qualify

  for (let i = 0; i < newAxes.length; i++) {
    if (usedIndices.has(i)) continue;
    const na = newAxes[i];
    if (!na || !Array.isArray(na.keywords) || na.keywords.length === 0) continue;

    const naLower     = na.keywords.map((k) => String(k).toLowerCase());
    const intersection = naLower.filter((k) => existLower.has(k)).length;

    // |union| = |A| + |B| - |intersection|
    const union = existLower.size + naLower.length - intersection;
    if (union <= 0) continue;

    const score = intersection / union;
    if (score > bestScore) {
      bestScore = score;
      bestIdx   = i;
    }
  }

  return bestIdx;
}

