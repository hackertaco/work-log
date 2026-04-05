/**
 * Decision-Reasoning Extractor
 *
 * Parses session conversations (Codex/Claude) to identify and extract
 * decision points, alternatives considered, and rationale chosen.
 *
 * This module sits between raw session collection (sources.mjs) and the
 * episode/project synthesis pipeline (resumeRecluster.mjs).  Instead of
 * dumping raw conversation snippets into the LLM prompt, we pre-extract
 * structured decision points so downstream prompts receive focused,
 * high-signal decision reasoning.
 *
 * Pipeline position:
 *   sources.mjs → collectCodex/ClaudeSessions()
 *     → THIS MODULE → extractDecisionPoints()
 *       → resumeRecluster.mjs → buildRepoWorkContext() (enriched with decisions)
 *         → groupEvidenceEpisodes() / extractCoreProjects()
 *
 * Public API:
 *   extractDecisionPoints(sessions, options)   → Promise<DecisionPoint[]>
 *   extractDecisionPointsFromSnippets(snippets, options) → Promise<DecisionPoint[]>
 *   hasDecisionSignals(text)                   → boolean  (heuristic pre-filter)
 *   buildDecisionContext(decisions)             → string   (for LLM prompt injection)
 *   enrichSessionSnippetsWithDecisions(sessionSnippets, options) → Promise<EnrichedSnippet[]>
 *
 * Exported for testing:
 *   _DECISION_SIGNAL_PATTERNS                  → RegExp[]
 *   _segmentConversation(snippets)             → ConversationSegment[]
 *   _buildExtractionPrompt(segments)           → string
 *
 * @module resumeDecisionExtractor
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/**
 * Minimum snippet character length to consider for decision extraction.
 * Very short snippets rarely contain meaningful decision reasoning.
 */
const MIN_SNIPPET_LENGTH = 40;

/**
 * Maximum number of conversation segments to send to the LLM in a single call.
 * Prevents excessively large prompts.
 */
const MAX_SEGMENTS_PER_CALL = 30;

/**
 * Maximum total character length of conversation text sent to the LLM.
 */
const MAX_CONTEXT_CHARS = 15000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DecisionPoint
 * @property {string}   topic           Short description of what was decided (5-20 words)
 * @property {string[]} alternatives    Alternatives that were considered (1-4 items)
 * @property {string}   chosen          The alternative that was selected
 * @property {string}   rationale       Why this alternative was chosen (1-2 sentences)
 * @property {string}   [impact]        Expected or observed impact of the decision
 * @property {string}   date            YYYY-MM-DD date of the session
 * @property {string}   source          "codex" | "claude"
 * @property {number}   confidence      0-1 confidence that this is a real decision (not noise)
 */

/**
 * @typedef {Object} ConversationSegment
 * @property {string} role     "user" | "assistant"
 * @property {string} text     The message text
 * @property {number} index    Position in conversation
 */

/**
 * @typedef {Object} EnrichedSnippet
 * @property {string}          date       YYYY-MM-DD
 * @property {string}          text       Original snippet text
 * @property {DecisionPoint[]} decisions  Extracted decisions (may be empty)
 */

// ─── Decision Signal Patterns ─────────────────────────────────────────────────

/**
 * Regex patterns that indicate a conversation segment likely contains
 * decision reasoning.  Used as a cheap heuristic pre-filter to avoid
 * sending every mundane conversation to the LLM.
 *
 * Patterns cover both English and Korean decision language.
 */
export const _DECISION_SIGNAL_PATTERNS = [
  // English decision language
  /\b(?:instead of|rather than|opted for|chose|decided|decision|trade-?off)\b/i,
  /\b(?:alternative|option|approach|strategy|consider(?:ed|ing)?)\b/i,
  /\b(?:because|since|reason|rationale|why|motivation)\b/i,
  /\b(?:pros? and cons?|advantages?|disadvantages?|drawback|benefit)\b/i,
  /\b(?:compared? to|versus|vs\.?|over)\b/i,
  /\b(?:better|worse|prefer|recommend|suggest)\b/i,
  /\b(?:migrat|refactor|redesign|restructur|replac|switch)\b/i,
  /\b(?:performance|scalab|maintainab|reliab|security)\b/i,

  // Korean decision language
  /(?:대신|대안|선택|결정|이유|장단점|비교|고려)/,
  /(?:방식으로|접근법|전략|판단|근거)/,
  /(?:리팩토링|마이그레이션|전환|개선|최적화)/,
  /(?:때문|이므로|왜냐하면|고려해서)/,
];

// ─── Heuristic Pre-filter ─────────────────────────────────────────────────────

/**
 * Check whether a text snippet contains signals suggesting decision reasoning.
 *
 * This is a cheap heuristic (no LLM call) that determines whether a
 * conversation is worth sending to the LLM for full decision extraction.
 * It errs on the side of inclusion — false positives are acceptable,
 * false negatives are costly (missed decisions).
 *
 * @param {string} text  Raw conversation text
 * @returns {boolean}  True if the text likely contains decision reasoning
 */
export function hasDecisionSignals(text) {
  if (!text || typeof text !== "string") return false;
  if (text.length < MIN_SNIPPET_LENGTH) return false;

  // Count how many distinct signal patterns match
  let matchCount = 0;
  for (const pattern of _DECISION_SIGNAL_PATTERNS) {
    if (pattern.test(text)) {
      matchCount++;
      // Two distinct signal patterns is strong evidence
      if (matchCount >= 2) return true;
    }
  }

  return false;
}

// ─── Conversation Segmentation ────────────────────────────────────────────────

/**
 * Segment raw session snippets into conversation turns.
 *
 * Session snippets from sources.mjs are typically concatenated text blocks.
 * This function attempts to split them into meaningful conversation segments
 * that preserve the user/assistant dialogue structure.
 *
 * @param {string[]} snippets  Raw snippet strings from a session
 * @returns {ConversationSegment[]}
 */
export function _segmentConversation(snippets) {
  if (!Array.isArray(snippets)) return [];

  const segments = [];
  let index = 0;

  for (const snippet of snippets) {
    if (!snippet || typeof snippet !== "string") continue;
    const trimmed = snippet.trim();
    if (trimmed.length < MIN_SNIPPET_LENGTH) continue;

    // Heuristic: user messages tend to be questions/requests, assistant
    // messages tend to be longer explanations.  When we can't tell, default
    // to "assistant" since those contain the reasoning.
    const looksLikeUser =
      trimmed.length < 500 &&
      (/\?$/.test(trimmed) || /^(please|can you|how|what|why|should|let's|could)/i.test(trimmed) ||
       /^(해줘|해주세요|어떻게|왜|뭐가|확인|분석)/i.test(trimmed));

    segments.push({
      role: looksLikeUser ? "user" : "assistant",
      text: trimmed,
      index: index++
    });
  }

  return segments;
}

// ─── LLM-based Decision Extraction ───────────────────────────────────────────

const DECISION_EXTRACTION_SYSTEM_PROMPT = `\
You are an expert at analyzing developer conversations with AI coding assistants
to identify engineering decision points.

A "decision point" is a moment where the developer (or AI assistant) explicitly or
implicitly chose one approach over alternatives.  Decisions can be about:
- Architecture/design patterns
- Technology/library choices
- Implementation strategies
- Performance vs simplicity trade-offs
- Error handling approaches
- Data modeling choices
- API design decisions
- Refactoring strategies

EXTRACTION RULES:
1. Only extract REAL decisions — where alternatives existed and a choice was made.
   Do NOT manufacture decisions from simple implementation steps.
2. Each decision must have at least one alternative that was considered (even if
   implicitly — e.g., "could have used polling" when event-driven was chosen).
3. The rationale must explain WHY the chosen approach won — not just restate the choice.
4. Set confidence to 0.9+ for explicit decisions ("I chose X because Y"),
   0.6-0.8 for implicit decisions (choice is clear but reasoning is inferred),
   0.3-0.5 for weak signals (might be a decision, might be routine implementation).
5. Skip decisions below 0.3 confidence — they're likely noise.
6. Extract at most 5 decisions per conversation — focus on the most significant ones.
7. Keep topic, chosen, and rationale concise — these will feed into resume bullets.

IMPORTANT: Extract decisions in the same language as the conversation.  If the
conversation is in Korean, write the decision fields in Korean.  If in English,
write in English.`;

const DECISION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "alternatives", "chosen", "rationale", "confidence"],
        properties: {
          topic:        { type: "string" },
          alternatives: { type: "array", items: { type: "string" } },
          chosen:       { type: "string" },
          rationale:    { type: "string" },
          impact:       { type: "string" },
          confidence:   { type: "number" }
        }
      }
    }
  }
};

/**
 * Build the user message for the decision extraction LLM call.
 *
 * @param {ConversationSegment[]} segments  Conversation segments to analyze
 * @param {object} [meta]                    Optional metadata (repo, date)
 * @returns {string}
 */
export function _buildExtractionPrompt(segments, meta = {}) {
  const parts = [];

  if (meta.repo) {
    parts.push(`Repository: ${meta.repo}`);
  }
  if (meta.date) {
    parts.push(`Date: ${meta.date}`);
  }

  parts.push("");
  parts.push("=== CONVERSATION ===");

  let totalChars = 0;
  for (const seg of segments) {
    if (totalChars >= MAX_CONTEXT_CHARS) {
      parts.push("\n[... conversation truncated for length ...]");
      break;
    }
    const prefix = seg.role === "user" ? "USER" : "ASSISTANT";
    const text = seg.text.slice(0, 2000); // cap individual messages
    parts.push(`\n[${prefix}] ${text}`);
    totalChars += text.length;
  }

  parts.push("");
  parts.push("Extract all engineering decision points from this conversation.");
  parts.push("Focus on decisions where alternatives were weighed and a choice was made.");

  return parts.join("\n");
}

/**
 * Call the LLM to extract decision points from conversation segments.
 *
 * @param {ConversationSegment[]} segments  Conversation segments
 * @param {object} [meta]                    Optional metadata
 * @returns {Promise<object[]>}  Raw decision objects from LLM
 */
async function _callLlmForDecisions(segments, meta = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return [];
  }
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return [];
  }

  const userMessage = _buildExtractionPrompt(segments, meta);

  const payload = {
    model: OPENAI_MODEL,
    reasoning: { effort: "medium" },
    text: {
      format: {
        type: "json_schema",
        name: "decision_extraction",
        strict: true,
        schema: DECISION_OUTPUT_SCHEMA
      }
    },
    max_output_tokens: 2000,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: DECISION_EXTRACTION_SYSTEM_PROMPT }]
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
    console.error(`[decisionExtractor] LLM call failed: ${response.status} ${errorText.slice(0, 200)}`);
    return [];
  }

  const data = await response.json();
  const rawText = data.output_text || _extractOutputText(data);
  if (!rawText) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed.decisions) ? parsed.decisions : [];
  } catch (err) {
    console.error(`[decisionExtractor] Failed to parse LLM output: ${err.message}`);
    return [];
  }
}

function _extractOutputText(data) {
  const outputs = data.output ?? [];
  const texts = [];
  for (const item of outputs) {
    for (const part of item?.content ?? []) {
      if (part?.type === "output_text" && part?.text) texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract decision points from a set of session objects (as returned by
 * collectCodexSessions / collectClaudeSessions in sources.mjs).
 *
 * This is the main entry point.  It:
 *   1. Filters sessions to those with decision signals (heuristic pre-filter)
 *   2. Segments conversations into turns
 *   3. Calls the LLM to extract structured decision points
 *   4. Normalizes and deduplicates results
 *
 * @param {object[]} sessions  Session objects from sources.mjs
 *   Each has: { source, filePath, cwd, summary, snippets, snippetCount }
 * @param {object}   [options={}]
 * @param {string}   [options.date]     YYYY-MM-DD date for attribution
 * @param {string}   [options.repo]     Repository name for filtering
 * @param {Function} [options.llmFn]    Override LLM call for testing
 * @returns {Promise<DecisionPoint[]>}
 */
export async function extractDecisionPoints(sessions, options = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return [];
  }

  const llmFn = options.llmFn || _callLlmForDecisions;
  const allDecisions = [];

  for (const session of sessions) {
    if (!session || !Array.isArray(session.snippets)) continue;

    // Combine all snippets for the heuristic check
    const combinedText = [
      session.summary || "",
      ...session.snippets
    ].join(" ");

    // Pre-filter: skip sessions with no decision signals
    if (!hasDecisionSignals(combinedText)) continue;

    // Segment the conversation
    const segments = _segmentConversation(session.snippets);
    if (segments.length === 0) continue;

    // Limit segments to prevent excessive LLM costs
    const limitedSegments = segments.slice(0, MAX_SEGMENTS_PER_CALL);

    // Extract decisions via LLM
    const meta = {
      date: options.date || "",
      repo: options.repo || _repoFromCwd(session.cwd)
    };

    const rawDecisions = await llmFn(limitedSegments, meta);

    // Normalize and attach metadata
    for (const raw of rawDecisions) {
      const decision = _normalizeDecision(raw, {
        date: options.date || "",
        source: session.source || "unknown"
      });
      if (decision) {
        allDecisions.push(decision);
      }
    }
  }

  // Deduplicate decisions with similar topics
  return _deduplicateDecisions(allDecisions);
}

/**
 * Extract decision points directly from session snippet strings.
 *
 * Convenience wrapper when you have raw snippet strings rather than
 * full session objects.  Used by enrichSessionSnippetsWithDecisions().
 *
 * @param {Array<{date: string, text: string}>} snippets  Snippets with dates
 * @param {object}   [options={}]
 * @param {string}   [options.repo]     Repository name
 * @param {Function} [options.llmFn]    Override LLM call for testing
 * @returns {Promise<DecisionPoint[]>}
 */
export async function extractDecisionPointsFromSnippets(snippets, options = {}) {
  if (!Array.isArray(snippets) || snippets.length === 0) {
    return [];
  }

  // Group snippets by date for batched processing
  const byDate = new Map();
  for (const s of snippets) {
    if (!s || !s.text) continue;
    const date = s.date || "unknown";
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(s.text);
  }

  const allDecisions = [];
  const llmFn = options.llmFn || _callLlmForDecisions;

  for (const [date, texts] of byDate) {
    const combinedText = texts.join(" ");
    if (!hasDecisionSignals(combinedText)) continue;

    const segments = _segmentConversation(texts);
    if (segments.length === 0) continue;

    const meta = { date, repo: options.repo || "" };
    const rawDecisions = await llmFn(segments.slice(0, MAX_SEGMENTS_PER_CALL), meta);

    for (const raw of rawDecisions) {
      const decision = _normalizeDecision(raw, { date, source: "session" });
      if (decision) allDecisions.push(decision);
    }
  }

  return _deduplicateDecisions(allDecisions);
}

/**
 * Build a formatted decision context string suitable for injection into
 * downstream LLM prompts (episode grouping, project synthesis).
 *
 * This replaces raw session snippets with structured, high-signal decision
 * summaries when decisions have been extracted.
 *
 * @param {DecisionPoint[]} decisions  Extracted decision points
 * @returns {string}  Formatted text block for LLM prompt injection
 */
export function buildDecisionContext(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return "";
  }

  // Sort by confidence descending, then by date
  const sorted = [...decisions]
    .filter(d => d.confidence >= 0.5) // only include moderate+ confidence
    .sort((a, b) => b.confidence - a.confidence || a.date.localeCompare(b.date));

  if (sorted.length === 0) return "";

  const lines = [
    `=== EXTRACTED DECISION POINTS (${sorted.length}) ===`,
    "(These are structured decisions extracted from AI session conversations.",
    " Use them to embed WHY into episode bullets and project descriptions.)",
    ""
  ];

  for (const d of sorted) {
    lines.push(`[${d.date}] DECISION: ${d.topic}`);
    if (d.alternatives.length > 0) {
      lines.push(`  Alternatives: ${d.alternatives.join(" | ")}`);
    }
    lines.push(`  Chosen: ${d.chosen}`);
    lines.push(`  Rationale: ${d.rationale}`);
    if (d.impact) {
      lines.push(`  Impact: ${d.impact}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Enrich session snippets with extracted decision points.
 *
 * Takes the sessionSnippets array from buildRepoWorkContext() and returns
 * an enriched version where each snippet is annotated with any decisions
 * found in its text.  The original text is preserved.
 *
 * This is the integration point for resumeRecluster.mjs — call this on
 * the repo context's sessionSnippets before building the episode prompt.
 *
 * @param {Array<{date: string, text: string}>} sessionSnippets
 * @param {object}   [options={}]
 * @param {string}   [options.repo]     Repository name
 * @param {Function} [options.llmFn]    Override LLM call for testing
 * @returns {Promise<EnrichedSnippet[]>}
 */
export async function enrichSessionSnippetsWithDecisions(sessionSnippets, options = {}) {
  if (!Array.isArray(sessionSnippets) || sessionSnippets.length === 0) {
    return [];
  }

  // Extract decisions from all snippets
  const decisions = await extractDecisionPointsFromSnippets(sessionSnippets, options);

  // Build a date→decisions index for efficient lookup
  const decisionsByDate = new Map();
  for (const d of decisions) {
    if (!decisionsByDate.has(d.date)) decisionsByDate.set(d.date, []);
    decisionsByDate.get(d.date).push(d);
  }

  // Enrich each snippet
  return sessionSnippets.map(snippet => ({
    date: snippet.date,
    text: snippet.text,
    decisions: decisionsByDate.get(snippet.date) || []
  }));
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Extract repo name from a cwd path.
 * @param {string} cwd
 * @returns {string}
 */
function _repoFromCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return "";
  const parts = cwd.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || "";
}

/**
 * Normalize a raw decision object from the LLM into a DecisionPoint.
 *
 * @param {object} raw       Raw LLM output
 * @param {object} meta      Metadata to attach
 * @param {string} meta.date
 * @param {string} meta.source
 * @returns {DecisionPoint|null}  Null if the decision is invalid or too low confidence
 */
function _normalizeDecision(raw, meta) {
  if (!raw || typeof raw !== "object") return null;

  const confidence = typeof raw.confidence === "number"
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;

  // Filter out low-confidence noise
  if (confidence < 0.3) return null;

  const topic = String(raw.topic || "").trim();
  if (!topic) return null;

  const chosen = String(raw.chosen || "").trim();
  if (!chosen) return null;

  const rationale = String(raw.rationale || "").trim();
  if (!rationale) return null;

  const alternatives = Array.isArray(raw.alternatives)
    ? raw.alternatives.map(a => String(a || "").trim()).filter(Boolean)
    : [];

  const impact = raw.impact ? String(raw.impact).trim() : undefined;

  return {
    topic,
    alternatives,
    chosen,
    rationale,
    ...(impact ? { impact } : {}),
    date: meta.date || "",
    source: meta.source || "unknown",
    confidence
  };
}

/**
 * Deduplicate decisions with very similar topics.
 *
 * Uses simple word-overlap similarity to avoid near-duplicate decisions
 * from the same conversation being counted multiple times.
 *
 * @param {DecisionPoint[]} decisions
 * @returns {DecisionPoint[]}
 */
function _deduplicateDecisions(decisions) {
  if (decisions.length <= 1) return decisions;

  const kept = [];

  for (const d of decisions) {
    const isDuplicate = kept.some(existing =>
      _topicSimilarity(existing.topic, d.topic) > 0.6
    );

    if (!isDuplicate) {
      kept.push(d);
    } else {
      // Keep the higher-confidence version
      const existingIdx = kept.findIndex(existing =>
        _topicSimilarity(existing.topic, d.topic) > 0.6
      );
      if (existingIdx >= 0 && d.confidence > kept[existingIdx].confidence) {
        kept[existingIdx] = d;
      }
    }
  }

  return kept;
}

/**
 * Compute word-overlap similarity between two topic strings.
 * Returns 0-1 where 1 means identical word sets.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _topicSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  // Jaccard similarity
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? overlap / union : 0;
}
