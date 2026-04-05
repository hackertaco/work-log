/**
 * Embedding generation utility for resume bullet text.
 *
 * Computes vector embeddings via OpenAI's embeddings API using a consistent
 * model across the pipeline.  Used for semantic similarity tracking (e.g.
 * measuring how much a user edited a generated bullet, grouping episodes by
 * topic proximity, and deduplicating near-identical bullets).
 *
 * Follows the same env-var / fetch pattern as openai.mjs:
 *   - OPENAI_API_KEY          — required
 *   - WORK_LOG_DISABLE_OPENAI — set "1" to disable (returns null)
 *   - WORK_LOG_EMBEDDING_MODEL — override model (default: text-embedding-3-small)
 *   - WORK_LOG_EMBEDDING_URL  — override endpoint
 */

const EMBEDDING_URL =
  process.env.WORK_LOG_EMBEDDING_URL ||
  "https://api.openai.com/v1/embeddings";

const EMBEDDING_MODEL =
  process.env.WORK_LOG_EMBEDDING_MODEL || "text-embedding-3-small";

/** Dimension count for the default model (text-embedding-3-small). */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Maximum texts per single API call.
 * OpenAI supports up to 2048; we keep a conservative cap.
 */
const MAX_BATCH_SIZE = 256;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate an embedding vector for a single text string.
 *
 * @param {string} text  — The text to embed (e.g. a resume bullet).
 * @returns {Promise<number[]|null>} Float array of length EMBEDDING_DIMENSIONS,
 *   or null when the API is disabled / key is missing.
 */
export async function generateEmbedding(text) {
  if (!text || typeof text !== "string") return null;

  const result = await generateEmbeddings([text]);
  return result ? result[0] : null;
}

/**
 * Generate embedding vectors for an array of texts in a single API call
 * (or multiple batched calls when the array exceeds MAX_BATCH_SIZE).
 *
 * @param {string[]} texts — Array of strings to embed.
 * @returns {Promise<number[][]|null>} Array of float vectors in the same order
 *   as the input, or null when the API is disabled / key is missing.
 */
export async function generateEmbeddings(texts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return null;
  }

  if (!Array.isArray(texts) || texts.length === 0) return null;

  // Filter and track non-empty entries
  const cleaned = texts.map((t) => (typeof t === "string" ? t.trim() : ""));
  const nonEmptyIndices = [];
  const nonEmptyTexts = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].length > 0) {
      nonEmptyIndices.push(i);
      nonEmptyTexts.push(cleaned[i]);
    }
  }

  if (nonEmptyTexts.length === 0) return null;

  // Batch into chunks of MAX_BATCH_SIZE
  const batches = [];
  for (let i = 0; i < nonEmptyTexts.length; i += MAX_BATCH_SIZE) {
    batches.push(nonEmptyTexts.slice(i, i + MAX_BATCH_SIZE));
  }

  // Execute batches (sequentially to respect rate limits)
  const allVectors = [];
  for (const batch of batches) {
    const vectors = await _fetchEmbeddings(apiKey, batch);
    allVectors.push(...vectors);
  }

  // Re-map into original order, using zero-vectors for empty inputs
  const zeroVec = new Array(EMBEDDING_DIMENSIONS).fill(0);
  const result = new Array(texts.length);
  for (let i = 0; i < texts.length; i++) {
    result[i] = zeroVec;
  }
  for (let j = 0; j < nonEmptyIndices.length; j++) {
    result[nonEmptyIndices[j]] = allVectors[j];
  }

  return result;
}

/**
 * Compute cosine similarity between two embedding vectors.
 *
 * @param {number[]} a — First embedding vector.
 * @param {number[]} b — Second embedding vector.
 * @returns {number} Similarity score in [-1, 1], or 0 if inputs are invalid.
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Determine whether an edited bullet is semantically similar enough to the
 * original to count as "≤50% modification".
 *
 * @param {number[]} originalEmb — Embedding of the auto-generated bullet.
 * @param {number[]} editedEmb   — Embedding of the user-edited bullet.
 * @param {number} [threshold=0.85] — Similarity threshold (higher = stricter).
 * @returns {boolean} True when the edit preserves ≥ threshold semantic meaning.
 */
export function isMinorEdit(originalEmb, editedEmb, threshold = 0.85) {
  return cosineSimilarity(originalEmb, editedEmb) >= threshold;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Call the OpenAI embeddings endpoint for a single batch.
 * @private
 */
async function _fetchEmbeddings(apiKey, texts) {
  const payload = {
    model: EMBEDDING_MODEL,
    input: texts,
  };

  const response = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Embedding API failed: ${response.status} ${errorText.slice(0, 400)}`
    );
  }

  const data = await response.json();

  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("Embedding API returned unexpected format");
  }

  // OpenAI returns objects with { index, embedding } — sort by index to
  // guarantee order matches the input.
  const sorted = data.data
    .slice()
    .sort((a, b) => a.index - b.index);

  return sorted.map((d) => d.embedding);
}

// ─── Exports for testing ─────────────────────────────────────────────────────
export const _testing = {
  MAX_BATCH_SIZE,
  EMBEDDING_URL,
  EMBEDDING_MODEL,
  _fetchEmbeddings,
};
