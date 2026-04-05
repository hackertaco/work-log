/**
 * Keyword search adapters for resume chat evidence extraction.
 *
 * Provides three independent adapters that each search a specific data source
 * (commit logs, Slack messages, session memory) for records matching a set of
 * parsed query keywords.  The adapters are intentionally independent — they can
 * be called concurrently with Promise.all() and never share state.
 *
 * ─── Adapters ─────────────────────────────────────────────────────────────────
 *
 *   searchCommits(query)  — Scans daily work log JSON files for commit subjects,
 *                           commit-analysis highlights, and story-thread entries
 *                           that contain any of the query keywords.
 *
 *   searchSlack(query)    — Calls the Slack API search.messages endpoint using
 *                           the keywords as a free-text query.  Returns an empty
 *                           array when the Slack token or channel list is absent.
 *
 *   searchSessions(query) — Scans daily work log JSON files for AI session
 *                           snippets (codex / claude) and aiReview notes that
 *                           contain any of the query keywords.
 *
 *   searchAllSources(query) — Convenience wrapper that calls all three adapters
 *                             in parallel and merges results into a single list,
 *                             each tagged with its source.
 *
 * ─── SearchQuery ──────────────────────────────────────────────────────────────
 *
 *   {
 *     keywords:   string[],                   // parsed keywords to match against
 *     dateRange?: { from: string, to: string },// YYYY-MM-DD, defaults to 90 days
 *     maxResults?: number                     // per-source cap, default 20
 *   }
 *
 * ─── Result shapes ────────────────────────────────────────────────────────────
 *
 *   CommitSearchResult  — { source:"commits",  date, repo, hash, authoredAt,
 *                            text, matchedKeywords, score }
 *
 *   SlackSearchResult   — { source:"slack",    date, channelId, ts, text,
 *                            context, permalink?, matchedKeywords, score }
 *
 *   SessionSearchResult — { source:"sessions", date, sessionSource, text,
 *                            filePath?, cwd?, matchedKeywords, score }
 *
 * ─── Scoring ──────────────────────────────────────────────────────────────────
 *
 *   score = matchedKeywords.length / keywords.length  (range 0.0 – 1.0)
 *
 *   Results with score = 0 are excluded.  Within each adapter results are
 *   sorted by (score DESC, date DESC).
 *
 * ─── Environment variables ────────────────────────────────────────────────────
 *
 *   SLACK_TOKEN / SLACK_USER_TOKEN  — Slack API bearer token
 *   SLACK_CHANNEL_IDS / WORK_LOG_SLACK_CHANNEL_IDS  — CSV of channel IDs
 *   SLACK_USER_ID / WORK_LOG_SLACK_USER_ID           — owner user ID (optional)
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { fileExists } from "./utils.mjs";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_LOOKBACK_DAYS = 90;
const SLACK_API_BASE = "https://slack.com/api";

// ─── Public types (JSDoc) ─────────────────────────────────────────────────────

/**
 * @typedef {Object} SearchQuery
 * @property {string[]}                         keywords   Parsed keywords to search for
 * @property {{ from: string, to: string }}     [dateRange] YYYY-MM-DD date range (defaults 90 days)
 * @property {number}                           [maxResults] Max results per source (default 20)
 */

/**
 * @typedef {Object} CommitSearchResult
 * @property {"commits"}  source
 * @property {string}     date           YYYY-MM-DD work log date
 * @property {string}     repo           Repository name
 * @property {string}     hash           Short commit hash (7 chars)
 * @property {string}     authoredAt     ISO 8601 timestamp
 * @property {string}     text           Commit subject line (primary matching text)
 * @property {string[]}   matchedKeywords Keywords that matched this result
 * @property {number}     score          0.0–1.0 fraction of keywords matched
 */

/**
 * @typedef {Object} SlackSearchResult
 * @property {"slack"}    source
 * @property {string}     date           YYYY-MM-DD derived from message timestamp
 * @property {string}     channelId      Slack channel ID
 * @property {string}     ts             Slack message timestamp string
 * @property {string}     text           Cleaned message text
 * @property {string[]}   context        Surrounding context messages (up to 4)
 * @property {string}     [permalink]    Slack permalink URL if available
 * @property {string[]}   matchedKeywords Keywords that matched this result
 * @property {number}     score          0.0–1.0 fraction of keywords matched
 */

/**
 * @typedef {Object} SessionSearchResult
 * @property {"sessions"} source
 * @property {string}     date           YYYY-MM-DD work log date
 * @property {"codex"|"claude"|"aiReview"} sessionSource AI session provider
 * @property {string}     text           Matching snippet or aiReview note
 * @property {string}     [filePath]     Session file path (when from codex/claude)
 * @property {string}     [cwd]          Working directory of the session
 * @property {string[]}   matchedKeywords Keywords that matched this result
 * @property {number}     score          0.0–1.0 fraction of keywords matched
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search commit logs across daily work log files for records matching query keywords.
 *
 * Searches:
 *   - projects[].commits[].subject          (commit message)
 *   - highlights.commitAnalysis[]           (LLM-generated per-repo summaries)
 *   - highlights.storyThreads[].{outcome,keyChange,why,decision}
 *   - highlights.accomplishments[]
 *
 * @param {SearchQuery} query
 * @returns {Promise<CommitSearchResult[]>}
 */
export async function searchCommits(query) {
  const { keywords, dateRange, maxResults = DEFAULT_MAX_RESULTS } = query;
  if (!keywords || keywords.length === 0) return [];

  const workLogs = await loadWorkLogsForSearch(dateRange);
  const results = [];

  for (const wl of workLogs) {
    const date = wl.date ?? "unknown";
    const projects = wl.projects ?? [];

    // Search commit subjects in each project
    for (const project of projects) {
      const repo = project.repo ?? "";
      const commits = project.commits ?? [];

      for (const commit of commits) {
        const subject = commit.subject ?? "";
        const { matched, score } = scoreText(subject, keywords);
        if (score > 0) {
          results.push({
            source: "commits",
            date,
            repo,
            hash: commit.hash ?? "",
            authoredAt: commit.authoredAt ?? "",
            text: subject,
            matchedKeywords: matched,
            score
          });
        }
      }
    }

    // Search commit analysis highlights
    const highlights = wl.highlights ?? {};
    for (const line of highlights.commitAnalysis ?? []) {
      const { matched, score } = scoreText(line, keywords);
      if (score > 0) {
        // Extract repo name from "repo에서 N개의 커밋" pattern if present
        const repoMatch = line.match(/^([^\s]+)에서/);
        const repo = repoMatch ? repoMatch[1] : "";
        results.push({
          source: "commits",
          date,
          repo,
          hash: "",
          authoredAt: "",
          text: line,
          matchedKeywords: matched,
          score
        });
      }
    }

    // Search story threads
    for (const thread of highlights.storyThreads ?? []) {
      const combinedText = [
        thread.outcome,
        thread.keyChange,
        thread.why,
        thread.decision
      ]
        .filter(Boolean)
        .join(" ");

      if (!combinedText) continue;
      const { matched, score } = scoreText(combinedText, keywords);
      if (score > 0) {
        results.push({
          source: "commits",
          date,
          repo: thread.repo ?? "",
          hash: "",
          authoredAt: "",
          text: combinedText,
          matchedKeywords: matched,
          score
        });
      }
    }

    // Search accomplishments (already contains commit highlights)
    for (const line of highlights.accomplishments ?? []) {
      const { matched, score } = scoreText(line, keywords);
      if (score > 0) {
        // Extract repo from "repo: subject" pattern
        const repoMatch = line.match(/^([^:]+):/);
        const repo = repoMatch ? repoMatch[1].trim() : "";
        results.push({
          source: "commits",
          date,
          repo,
          hash: "",
          authoredAt: "",
          text: line,
          matchedKeywords: matched,
          score
        });
      }
    }
  }

  return deduplicateAndSort(results, maxResults);
}

/**
 * Search Slack messages via the Slack API search.messages endpoint.
 *
 * Requires SLACK_TOKEN (or SLACK_USER_TOKEN) to be set.
 * Returns empty array when the token is absent or the API call fails.
 *
 * @param {SearchQuery} query
 * @returns {Promise<SlackSearchResult[]>}
 */
export async function searchSlack(query) {
  const { keywords, dateRange, maxResults = DEFAULT_MAX_RESULTS } = query;
  if (!keywords || keywords.length === 0) return [];

  const token = process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN || "";
  if (!token) return [];

  // Build Slack search query from keywords
  const queryString = buildSlackQuery(keywords, dateRange);

  try {
    const data = await slackGet("search.messages", {
      query: queryString,
      count: String(Math.min(maxResults * 2, 100)), // fetch extra to allow for dedup
      sort: "timestamp",
      sort_dir: "desc"
    }, token);

    const messages = data?.messages?.matches ?? [];
    const results = [];

    for (const msg of messages) {
      const text = cleanSlackText(msg.text ?? "");
      if (!text) continue;

      const { matched, score } = scoreText(text, keywords);
      if (score === 0) continue;

      // Derive YYYY-MM-DD date from Slack timestamp
      const tsNum = parseFloat(msg.ts || "0");
      const msgDate = tsNum > 0
        ? new Date(tsNum * 1000).toISOString().slice(0, 10)
        : "";

      results.push({
        source: "slack",
        date: msgDate,
        channelId: msg.channel?.id ?? "",
        ts: msg.ts ?? "",
        text,
        context: extractSlackContext(msg),
        permalink: msg.permalink ?? undefined,
        matchedKeywords: matched,
        score
      });
    }

    return deduplicateAndSort(results, maxResults);
  } catch {
    // Slack search is optional — never throws
    return [];
  }
}

/**
 * Search session memory (AI coding assistant sessions and aiReview notes) across
 * daily work log files for records matching query keywords.
 *
 * Searches:
 *   - aiSessions.codex[].snippets[]    (Codex session text snippets)
 *   - aiSessions.codex[].summary       (Codex session summary)
 *   - aiSessions.claude[].snippets[]   (Claude session text snippets)
 *   - aiSessions.claude[].summary      (Claude session summary)
 *   - highlights.aiReview[]            (LLM-generated AI review notes)
 *
 * @param {SearchQuery} query
 * @returns {Promise<SessionSearchResult[]>}
 */
export async function searchSessions(query) {
  const { keywords, dateRange, maxResults = DEFAULT_MAX_RESULTS } = query;
  if (!keywords || keywords.length === 0) return [];

  const workLogs = await loadWorkLogsForSearch(dateRange);
  const results = [];

  for (const wl of workLogs) {
    const date = wl.date ?? "unknown";
    const aiSessions = wl.aiSessions ?? {};
    const highlights = wl.highlights ?? {};

    // Search codex sessions
    for (const session of aiSessions.codex ?? []) {
      const sessionResults = extractSessionResults(session, "codex", date, keywords);
      results.push(...sessionResults);
    }

    // Search claude sessions
    for (const session of aiSessions.claude ?? []) {
      const sessionResults = extractSessionResults(session, "claude", date, keywords);
      results.push(...sessionResults);
    }

    // Search aiReview highlights (LLM-synthesized session notes)
    for (const line of highlights.aiReview ?? []) {
      const { matched, score } = scoreText(line, keywords);
      if (score > 0) {
        results.push({
          source: "sessions",
          date,
          sessionSource: "aiReview",
          text: line,
          matchedKeywords: matched,
          score
        });
      }
    }

    // Also search workingStyleSignals as behavioral session memory
    for (const signal of highlights.workingStyleSignals ?? []) {
      const { matched, score } = scoreText(signal, keywords);
      if (score > 0) {
        results.push({
          source: "sessions",
          date,
          sessionSource: "aiReview",
          text: signal,
          matchedKeywords: matched,
          score
        });
      }
    }
  }

  return deduplicateAndSort(results, maxResults);
}

/**
 * Search all three data sources in parallel and return a merged, scored result list.
 *
 * Results from all sources are interleaved in score-descending order.
 * Each result retains its source-specific fields.
 *
 * @param {SearchQuery} query
 * @returns {Promise<Array<CommitSearchResult | SlackSearchResult | SessionSearchResult>>}
 */
export async function searchAllSources(query) {
  const [commits, slack, sessions] = await Promise.all([
    searchCommits(query),
    searchSlack(query),
    searchSessions(query)
  ]);

  const merged = [...commits, ...slack, ...sessions];
  merged.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  return merged;
}

// ─── Work log loading ─────────────────────────────────────────────────────────

/**
 * Load daily work log JSON files within the given date range.
 * Mirrors the loading logic from resumeDraftGeneration.mjs.
 *
 * @param {{ from?: string, to?: string }} [dateRange]
 * @returns {Promise<object[]>}
 */
async function loadWorkLogsForSearch(dateRange) {
  const config = await loadConfig();
  const dailyDir = path.join(config.dataDir, "daily");

  if (!(await fileExists(dailyDir))) return [];

  const entries = await fs.readdir(dailyDir);
  const allDates = entries
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .reverse(); // newest first

  const effectiveTo = dateRange?.to || todayISO();
  const effectiveFrom = dateRange?.from || daysAgoISO(DEFAULT_LOOKBACK_DAYS);

  const filtered = allDates
    .filter((d) => d >= effectiveFrom && d <= effectiveTo)
    .slice(0, DEFAULT_LOOKBACK_DAYS);

  const workLogs = [];
  for (const date of filtered) {
    const filePath = path.join(dailyDir, `${date}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      workLogs.push(JSON.parse(raw));
    } catch {
      // Skip corrupt or missing files silently
    }
  }

  return workLogs;
}

// ─── Session record extraction ────────────────────────────────────────────────

/**
 * Extract matching SessionSearchResult records from a single session object.
 *
 * @param {object} session
 * @param {"codex"|"claude"} sessionSource
 * @param {string} date
 * @param {string[]} keywords
 * @returns {SessionSearchResult[]}
 */
function extractSessionResults(session, sessionSource, date, keywords) {
  const results = [];
  const filePath = session.filePath;
  const cwd = session.cwd;

  // Match against the session summary
  if (session.summary) {
    const { matched, score } = scoreText(session.summary, keywords);
    if (score > 0) {
      results.push({
        source: "sessions",
        date,
        sessionSource,
        text: session.summary,
        filePath,
        cwd,
        matchedKeywords: matched,
        score
      });
    }
  }

  // Match against each snippet
  for (const snippet of session.snippets ?? []) {
    if (typeof snippet !== "string" || !snippet.trim()) continue;
    const { matched, score } = scoreText(snippet, keywords);
    if (score > 0) {
      results.push({
        source: "sessions",
        date,
        sessionSource,
        text: snippet,
        filePath,
        cwd,
        matchedKeywords: matched,
        score
      });
    }
  }

  return results;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Compute keyword match score for a text string.
 *
 * Matching is case-insensitive substring search.
 * score = matched_keyword_count / total_keyword_count
 *
 * @param {string} text
 * @param {string[]} keywords
 * @returns {{ matched: string[], score: number }}
 */
export function scoreText(text, keywords) {
  if (!text || !keywords || keywords.length === 0) {
    return { matched: [], score: 0 };
  }

  const lowerText = text.toLowerCase();
  const matched = keywords.filter(
    (kw) => kw && lowerText.includes(kw.toLowerCase())
  );

  return {
    matched,
    score: matched.length / keywords.length
  };
}

// ─── Deduplication and sorting ────────────────────────────────────────────────

/**
 * Sort results by (score DESC, date DESC) and cap at maxResults.
 * Deduplicates on exact (source, text) pairs.
 *
 * @template T
 * @param {T[]} results
 * @param {number} maxResults
 * @returns {T[]}
 */
function deduplicateAndSort(results, maxResults) {
  const seen = new Set();
  const deduped = [];

  for (const r of results) {
    const key = `${r.source}::${r.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  deduped.sort(
    (a, b) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? "")
  );

  return deduped.slice(0, maxResults);
}

// ─── Slack helpers ────────────────────────────────────────────────────────────

/**
 * Build a Slack search query string from keywords and an optional date range.
 *
 * @param {string[]} keywords
 * @param {{ from?: string, to?: string }} [dateRange]
 * @returns {string}
 */
export function buildSlackQuery(keywords, dateRange) {
  // Quote multi-word keywords; single words are left bare
  const terms = keywords.map((kw) =>
    kw.includes(" ") ? `"${kw}"` : kw
  );

  let query = terms.join(" OR ");

  // Slack supports after:/before: modifiers (YYYY-MM-DD)
  if (dateRange?.from) query += ` after:${dateRange.from}`;
  if (dateRange?.to) query += ` before:${dateRange.to}`;

  return query;
}

/**
 * Extract surrounding context lines from a Slack search match object.
 *
 * @param {object} msg  Slack search match object
 * @returns {string[]}
 */
function extractSlackContext(msg) {
  const previous = msg.previous_2 ?? msg.previous ?? null;
  const next = msg.next_2 ?? msg.next ?? null;

  const lines = [];
  if (previous?.text) lines.push(cleanSlackText(previous.text));
  if (next?.text) lines.push(cleanSlackText(next.text));
  return lines.filter(Boolean);
}

/**
 * Clean Slack text by removing user/channel/URL markup (mirrors slack.mjs).
 *
 * @param {string} text
 * @returns {string}
 */
function cleanSlackText(text) {
  return String(text || "")
    .replace(/<@[^>]+>/g, "@user")
    .replace(/<#[^|>]+\|?([^>]+)?>/g, "#channel")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Call a Slack API GET method with query params.
 *
 * @param {string} method
 * @param {Record<string, string>} params
 * @param {string} token
 * @returns {Promise<object>}
 */
async function slackGet(method, params, token) {
  const url = new URL(`${SLACK_API_BASE}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error(`Slack ${method} HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack ${method} error: ${data.error ?? "unknown_error"}`);
  }

  return data;
}

// ─── Date utilities ───────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
